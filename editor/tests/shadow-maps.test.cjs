/**
 * Shadows from the map's lights.
 *
 * A light with a slot renders a cube of depth from where it stands (three's
 * own shadow pass, driven from off-scene point lights) and every lit material
 * samples it with hardware depth comparison inside the light loop. Props and
 * placed models sit in a static map rendered only when one of them moves;
 * the characters go in a dynamic map rendered each frame one stands in reach.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const Reactor3D = require(path.join(repoRoot, 'runtime', 'reactor_3d.js'));

test('a light casts by default; the sidecar, the editor and the frame all carry the flag', () => {
    Reactor3D._nativeNorm = null;
    const map = { reactor3d: { lights: [
        { id: 'a', type: 'point', x: 1, y: 2 },
        { id: 'b', type: 'spot', shadow: false }
    ] } };
    const lights = Reactor3D.readMapLights(map);
    assert.equal(lights[0].shadow, true, 'casts unless told not to');
    assert.equal(lights[1].shadow, false);
    const resolved = Reactor3D.nativeLights(map);
    assert.equal(resolved[0].id, 'a', 'the id rides along so a slot can follow its light');
    assert.equal(resolved[0].shadow, true);
    assert.equal(resolved[1].shadow, false);

    const editor = read('editor/src/utils/MapLights.js');
    assert.match(editor, /shadow: raw\.shadow !== false,/);
    const manager = read('editor/src/LightingManager.js');
    assert.match(manager, /shadow: light\.shadow,\n\s*animated:/, 'resolvedLights carries it');
    assert.match(manager, /id: light\.id, type: light\.type,[\s\S]*?shadow: light\.shadow\n\s*\}\)\)\);/, 'feed3D hands id and flag to the compositor');
    assert.match(manager, /\['shadow', 'lit\.shadow'\]/, 'the panel offers the flag beside On and Blocked by walls');
    const i18n = read('editor/src/I18nManager.js');
    assert.equal((i18n.match(/"lit\.shadow": "/g) || []).length, 18, 'named in every locale');
});

test('the engine switch, the flat mode and the sidecar can each turn shadows off', () => {
    assert.equal(Reactor3D.SHADOWS, 'auto');
    assert.equal(Reactor3D.shadowsWanted({}), true);
    assert.equal(Reactor3D.shadowsWanted({ reactor3d: { lighting: { shadows: false } } }), false);
    assert.equal(Reactor3D.shadowsWanted({ reactor3d: { lighting: { mode: 'flat' } } }), false, 'the quads carry no depth');
    const was = Reactor3D.SHADOWS;
    try {
        Reactor3D.SHADOWS = 'off';
        assert.equal(Reactor3D.shadowsWanted({}), false);
    } finally {
        Reactor3D.SHADOWS = was;
    }
});

test('the quality follows the GPU tier: fewer slots, a smaller map and one tap on a weak one', () => {
    const shadows = Reactor3D.Shadows;
    shadows._quality = null;
    assert.deepEqual({ ...shadows.quality() }, Reactor3D.SHADOW_QUALITY.full, 'no Graphics at all reads as capable');
    shadows._quality = null;
    global.Graphics = { gpuTier: 'weak' };
    try {
        assert.deepEqual({ ...shadows.quality() }, Reactor3D.SHADOW_QUALITY.weak);
        assert.ok(Reactor3D.SHADOW_QUALITY.weak.slots < Reactor3D.SHADOW_QUALITY.full.slots);
        assert.ok(Reactor3D.SHADOW_QUALITY.weak.size < Reactor3D.SHADOW_QUALITY.full.size);
        assert.equal(Reactor3D.SHADOW_QUALITY.weak.taps, 1);
    } finally {
        delete global.Graphics;
        shadows._quality = null;
    }
    assert.ok(Reactor3D.SHADOW_QUALITY.full.slots <= Reactor3D.SHADOW_SLOTS, 'never more than the shader declares');
});

test('the shadow variant of the light shader declares a static and a dynamic cube per slot', () => {
    const plain = Reactor3D.lightGlsl(false);
    assert.equal(plain, Reactor3D.LIGHT_GLSL);
    assert.doesNotMatch(plain, /rrShadowAt|samplerCubeShadow/);

    const soft = Reactor3D.lightGlsl(true, 5);
    const slots = Reactor3D.SHADOW_SLOTS;
    for (let k = 0; k < slots; k++) {
        assert.match(soft, new RegExp('uniform samplerCubeShadow rrShadowMap' + k + ';'));
        assert.match(soft, new RegExp('uniform samplerCubeShadow rrShadowDyn' + k + ';'));
        assert.match(soft, new RegExp('if \\(slot == ' + k + '\\) \\{'));
    }
    assert.match(soft, /#define RR_SHADOW_TAPS 5/);
    assert.match(soft, /uniform float rrLightShadow\[32\];/);
    assert.match(soft, /uniform vec4 rrShadowInfo\[4\];/);
    // The compare depth is the face camera's projected depth, from the major axis.
    assert.match(soft, /float z = max\(max\(a\.x, a\.y\), a\.z\);/);
    assert.match(soft, /float dp = \(info\.y \* \(z - info\.x\)\) \/ \(z \* \(info\.y - info\.x\)\) \+ rrShadowBias;/);
    // The darker of the static and the dynamic map wins.
    assert.match(soft, /s = min\(s, rrCubeShadow\(rrShadowDyn0, d, rrShadowInfo\[0\]\)\);/);
    // Sampled inside the light loop, before the light adds in.
    assert.match(soft, /float sh = rrLightShadow\[i\];\n\t\tif \(sh >= 0\.0\) fall \*= rrShadowAt\(int\(sh \+ 0\.5\), p\);\n\t\tsum \+= lc\.rgb \* fall;/);
    // Each slot measures from where its map was rendered, not from the light.
    assert.match(soft, /uniform vec4 rrShadowPos\[4\];/);
    assert.match(soft, /vec3 d = p - rrShadowPos\[0\]\.xyz;/);

    const hard = Reactor3D.lightGlsl(true, 1);
    assert.match(hard, /#define RR_SHADOW_TAPS 1/);
});

test('a lit material takes the shadow variant only while shadows are active, and keys its program apart', () => {
    const shadows = Reactor3D.Shadows;
    const material = {};
    Reactor3D.litMaterial(material);
    const compile = () => {
        const shader = {
            uniforms: {},
            vertexShader: 'void main() {\n#include <project_vertex>\n}',
            fragmentShader: 'void main() {\n\tvec4 diffuseColor = vec4( diffuse, opacity );\n}'
        };
        material.onBeforeCompile(shader, null);
        return shader;
    };
    assert.equal(material.customProgramCacheKey(), '|reactor3d-lit');
    assert.doesNotMatch(compile().fragmentShader, /samplerCubeShadow/);
    const uniforms = Reactor3D.lightUniforms();
    assert.equal(uniforms.rrLightShadow.value.length, Reactor3D.SHADER_LIGHTS);
    assert.ok(Array.from(uniforms.rrLightShadow.value).every(v => v === -1), 'no light samples a slot until one is assigned');
    assert.equal(uniforms.rrShadowInfo.value.length, Reactor3D.SHADOW_SLOTS * 4);
    assert.equal(uniforms.rrShadowBias.value, Reactor3D.SHADOW_BIAS);
    for (let k = 0; k < Reactor3D.SHADOW_SLOTS; k++) {
        assert.ok('rrShadowMap' + k in uniforms);
        assert.ok('rrShadowDyn' + k in uniforms);
    }
    shadows._active = true;
    shadows._quality = null;
    try {
        assert.equal(material.customProgramCacheKey(), '|reactor3d-lit|shadows5');
        const shader = compile();
        assert.match(shader.fragmentShader, /samplerCubeShadow rrShadowMap0/);
        assert.equal(shader.uniforms.rrShadowMap0, uniforms.rrShadowMap0, 'the shared value object, not a copy');
        assert.equal(shader.uniforms.rrLightShadow, uniforms.rrLightShadow);
        // Only the renderer whose context holds the maps declares the
        // samplers. The editor draws the same materials from the 3D
        // database preview and the model pickers, each with its own
        // renderer; a depth cube from another context would be re-uploaded
        // there as an empty colour cube and every draw refused.
        const owner = {};
        const other = {};
        shadows._renderer = owner;
        const compileFor = renderer => {
            const shader = {
                uniforms: {},
                vertexShader: 'void main() {\n#include <project_vertex>\n}',
                fragmentShader: 'void main() {\n\tvec4 diffuseColor = vec4( diffuse, opacity );\n}'
            };
            material.onBeforeCompile(shader, renderer);
            return shader.fragmentShader;
        };
        assert.match(compileFor(owner), /samplerCubeShadow rrShadowMap0/);
        assert.doesNotMatch(compileFor(other), /samplerCubeShadow/, 'a second renderer compiles the plain light term');
        assert.match(compileFor(other), /rrLight\(vRRWorldPos\)/, 'and still takes the lights');
        assert.equal(shadows.appliesTo(other), false);
        assert.equal(shadows.appliesTo(owner), true);
    } finally {
        shadows._active = false;
        shadows._renderer = null;
        shadows._quality = null;
    }
});

test('slots go to the nearest casters and stay put while their light stays chosen', () => {
    const shadows = Reactor3D.Shadows;
    const a = { id: 'a', gap: 3 };
    const b = { id: 'b', gap: 1 };
    const c = { id: 'c', gap: 2 };
    const d = { id: 'd', gap: 9 };
    const first = shadows.assign([a, b, c, d], 2, null);
    assert.deepEqual(first.map(s => s.id), ['b', 'c']);
    // c walks off; a moves in. b keeps slot 0, a takes the freed slot 1.
    const second = shadows.assign([a, b, d], 2, first);
    assert.deepEqual(second.map(s => s.id), ['b', 'a']);
    // Order of arrival never shuffles a kept slot.
    const third = shadows.assign([b, a], 2, [{ id: 'a' }, { id: 'b' }]);
    assert.deepEqual(third.map(s => s.id), ['a', 'b']);
    assert.deepEqual(shadows.assign([], 2, first), [null, null]);
    assert.deepEqual(shadows.assign([a], 3, null).map(s => s && s.id), ['a', null, null]);
});

test('syncVolumeLights hands the shadow module every light that may cast, ranked by its gap to the focus', () => {
    const saved = { facadeAt: Reactor3D.facadeAt, surfaceHeightAt: Reactor3D.surfaceHeightAt, set: Reactor3D.Shadows.setCandidates };
    Reactor3D.facadeAt = () => null;
    Reactor3D.surfaceHeightAt = () => 0;
    let handed = null;
    Reactor3D.Shadows.setCandidates = list => { handed = list; };
    const scene = Object.create(Reactor3D.MapScene.prototype);
    scene.lightBodies = () => ({ place() {}, trim() {} });
    try {
        scene.syncVolumeLights([
            { id: 'near', type: 'point', x: 1, y: 1, height: 1, radius: 3 },
            { id: 'dark', type: 'point', x: 2, y: 1, height: 1, radius: 3, shadow: false },
            { type: 'spot', x: 9, y: 9, height: 2, radius: 4, yaw: 0, pitch: -45 }
        ], { x: 1, y: 1 });
        assert.equal(handed.length, 2, 'the light that opted out is not a candidate');
        assert.equal(handed[0].id, 'near');
        assert.equal(handed[0].index, 0, 'the slot is written back at the light\'s loop index');
        assert.equal(handed[0].gap, -3, 'distance to the focus minus reach');
        assert.equal(handed[0].x, 1.5);
        assert.equal(handed[0].y, 1, 'a light a tile up is its own shadow source');
        assert.equal(handed[0].z, 2);
        assert.equal(handed[1].id, '#2', 'a plugin light without an id is named by its index');
        assert.equal(handed[1].index, 2);
        scene.syncVolumeLights([{ id: 'floor', type: 'point', x: 1, y: 1, height: 0, radius: 3 }], { x: 1, y: 1 });
        assert.equal(handed[0].y, Reactor3D.SHADOW_LIFT, 'a light on the floor casts from a little above it');
        assert.equal(Reactor3D.lightUniforms().rrLightPos.value[1], 0, 'while the light itself stays on the floor');
    } finally {
        Reactor3D.facadeAt = saved.facadeAt;
        Reactor3D.surfaceHeightAt = saved.surfaceHeightAt;
        Reactor3D.Shadows.setCandidates = saved.set;
    }
});

test('marking a caster puts its meshes on the static or the dynamic layer, and either set forgets a detached root', () => {
    const shadows = Reactor3D.Shadows;
    const mesh = layers => ({ isMesh: true, castShadow: false, layers });
    const layersOf = () => {
        const on = new Set([0]);
        return { enable: l => on.add(l), disable: l => on.delete(l), has: l => on.has(l) };
    };
    const root = { userData: {}, parent: {}, children: [], _meshes: [mesh(layersOf()), mesh(layersOf())] };
    const savedCaster = shadows.casterMaterialFor;
    shadows.casterMaterialFor = () => 'caster';
    root.traverse = fn => { fn(root); root._meshes.forEach(fn); };
    const savedThree = global.THREE;
    global.THREE = {};
    try {
        shadows.markCaster(root, false);
        assert.equal(root.userData.reactorShadowCaster, 'static');
        assert.ok(root._meshes.every(m => m.castShadow && m.layers.has(Reactor3D.SHADOW_LAYER_STATIC) && !m.layers.has(Reactor3D.SHADOW_LAYER_DYNAMIC)));
        assert.ok(root._meshes.every(m => m.layers.has(0)), 'still drawn by the main camera');
        assert.ok(root._meshes.every(m => m.customDistanceMaterial === 'caster'), 'drawn into the maps with the slope offset');
        assert.ok(shadows._static.has(root));
        shadows.markCaster(root, true);
        assert.equal(root.userData.reactorShadowCaster, 'dynamic');
        assert.ok(root._meshes.every(m => m.layers.has(Reactor3D.SHADOW_LAYER_DYNAMIC) && !m.layers.has(Reactor3D.SHADOW_LAYER_STATIC)));
        assert.ok(shadows._dynamic.has(root) && !shadows._static.has(root));
        // A root removed from the scene drops out on the next look.
        root.parent = null;
        root.matrixWorld = { elements: new Array(16).fill(0) };
        assert.equal(shadows._dynamicWithin({ x: 0, y: 0, z: 0, radius: 100 }), false);
        assert.ok(!shadows._dynamic.has(root));
    } finally {
        if (savedThree === undefined) delete global.THREE; else global.THREE = savedThree;
        shadows.casterMaterialFor = savedCaster;
        shadows._static.clear();
        shadows._dynamic.clear();
    }
});

test('the static maps re-render when a prop moves, hides, arrives, or swaps its level, and not otherwise', () => {
    const shadows = Reactor3D.Shadows;
    const prop = at => ({ parent: {}, visible: true, userData: {}, matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, at, 0, 0, 1] } });
    const a = prop(1);
    shadows._static.clear();
    shadows._static.add(a);
    shadows._staticHash = NaN;
    assert.equal(shadows._staticChanged(), true, 'the first look is a change');
    assert.equal(shadows._staticChanged(), false, 'nothing moved');
    a.matrixWorld.elements[12] = 2;
    assert.equal(shadows._staticChanged(), true, 'moved');
    assert.equal(shadows._staticChanged(), false);
    a.visible = false;
    assert.equal(shadows._staticChanged(), true, 'hidden');
    shadows._static.add(prop(5));
    assert.equal(shadows._staticChanged(), true, 'arrived');
    assert.equal(shadows._staticChanged(), false);
    Reactor3D._lodSwaps++;
    assert.equal(shadows._staticChanged(), true, 'a level swap changes the silhouette');
    shadows.invalidate();
    assert.equal(shadows._staticChanged(), true, 'asked outright');
    shadows._static.clear();
    shadows._staticHash = NaN;
});

test('a slot keeps its far plane while the reach breathes inside the band', () => {
    const shadows = Reactor3D.Shadows;
    const far = shadows.farFor(6, 0);
    assert.equal(far, 7, 'a little past the reach, on a half-tile step');
    assert.equal(shadows.farFor(5.7, far), far, 'flicker leaves it');
    assert.equal(shadows.farFor(6.9, far), far, 'a pulse up to the plane leaves it');
    assert.equal(shadows.farFor(7.2, far), 8.5, 'past it, a new plane');
    assert.equal(shadows.farFor(3, far), 3.5, 'well under it, a tighter one');
});

test('a character in reach of a light is what makes its dynamic map render', () => {
    const shadows = Reactor3D.Shadows;
    const walker = (x, z) => ({ parent: {}, visible: true, userData: { glbSize: { x: 1, y: 2, z: 1 } }, scale: { x: 1, y: 1, z: 1 },
        matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, z, 1] } });
    shadows._dynamic.clear();
    shadows._dynamic.add(walker(10, 10));
    const lamp = { x: 0, y: 1, z: 0, radius: 3 };
    assert.equal(shadows._dynamicWithin(lamp), false, 'ten tiles off, out of a three-tile reach');
    shadows._dynamic.add(walker(4, 0));
    assert.equal(shadows._dynamicWithin(lamp), true, 'four tiles off, but two tall: its span counts');
    shadows._dynamic.clear();
});

test('every slot gets a real depth cube the moment the slots exist, so no shadow sampler is ever bound to an RGBA cube', () => {
    // A lit program declares a samplerCubeShadow per slot. three's fallback
    // for a null one is its empty RGBA cube, which the driver rejects at
    // draw time as a texture/sampler mismatch and drops the draw: on a map
    // with fewer casting lights than slots, every lit surface vanished.
    const three = read('runtime/reactor_3d.js');
    assert.match(three, /this\._slots = slots;\n\s*this\._primeMaps\(renderer, slots\);\n\s*return slots;/, 'primed before the slots are handed out');
    const at = three.indexOf('_primeMaps(renderer, slots) {');
    const body = three.slice(at, three.indexOf('\n    },', at));
    assert.match(body, /for \(const slot of slots\) lights\.push\(slot\.light, slot\.dyn\);/, 'the static and the dynamic map of every slot');
    assert.match(body, /renderer\.shadowMap\.render\(lights, empty, this\._cameras\.static\);/, "through three's own shadow pass, so the maps match the real ones");
    assert.match(body, /renderer\.shadowMap\.enabled = wasEnabled;/);
    assert.match(body, /for \(const light of lights\) light\.shadow\.needsUpdate = true;/, 'a primed map is still owed its first real render');
});

test('the dynamic budget is measured from the player, and a party of two reduced characters both cast on the full tier', () => {
    const shadows = Reactor3D.Shadows;
    const layersOf = () => {
        const on = new Set([0]);
        return { enable: l => on.add(l), disable: l => on.delete(l), has: l => on.has(l) };
    };
    const walker = (x, z, triangles, extra) => {
        const mesh = { isMesh: true, layers: layersOf(), geometry: { index: { count: triangles * 3 } } };
        return Object.assign({ parent: {}, visible: true, userData: {}, mesh,
            matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, z, 1] },
            traverse(fn) { fn(this); fn(mesh); } }, extra || {});
    };
    // The camera stands behind the party, so the follower is nearer to it.
    const player = walker(10, 10, 149000, { userData: { reactorPlayer: true } });
    const follower = walker(10, 12, 149000);
    shadows._dynamic.clear();
    shadows._casting = new Set();
    shadows._dynamic.add(follower);
    shadows._dynamic.add(player);
    try {
        const focus = shadows._focusPoint(null);
        assert.deepEqual(focus, { x: 10, y: 0, z: 10 }, 'the focus is the player model, not the eye');

        const saved = shadows._quality;
        shadows._quality = { dynamicTriangles: 120000 };
        let result = shadows._budgetDynamic(focus);
        assert.equal(result.casters, 1, 'one character fits a 120k budget');
        assert.ok(shadows._casting.has(player), 'and it is the player, however near the follower stands to the camera');
        assert.ok(!shadows._casting.has(follower));

        shadows._quality = null;
        delete global.Graphics;
        result = shadows._budgetDynamic(focus);
        assert.equal(result.casters, 2, 'the full tier fits both reduced characters');
        assert.ok(shadows._casting.has(follower) && shadows._casting.has(player));
        shadows._quality = saved;
    } finally {
        shadows._dynamic.clear();
        shadows._casting = new Set();
        shadows._quality = null;
    }
});

test('both viewports render the maps once a frame before the first pass, and the game marks its casters', () => {
    const three = read('runtime/reactor_3d.js');
    assert.match(three, /scene\.updateMatrixWorld\(\);\n\s*\/\/ The shadow maps, while every group is still visible\.\n\s*if \(mapScene\.renderShadows\) mapScene\.renderShadows\(this\._renderer, null\);/);
    assert.match(three, /group\.add\(object\);\n\s*\/\/ A prop never moves; its map is cached\. An event walks\.\n\s*Reactor3D\.Shadows\.markCaster\(object, !\(typeof character\.eventId === "function"\n\s*&& character\.eventId\(\) >= Reactor3D\.PROP_EVENT_BASE\)\);/);
    // The depth passes run from the sentinel's hook, inside the pass.
    assert.match(three, /mesh\.onBeforeRender = \(\) => this\._flush\(\);/);
    assert.match(three, /this\._pending = \{ renderer, scene, statics, dynamics, activate: !this\._active \};/);
    assert.match(three, /const object = new THREE\.Mesh\(geometry, material\);\n\s*group\.add\(object\);\n[\s\S]{0,300}?Reactor3D\.Shadows\.markCaster\(object, true\);/);
    assert.match(three, /if \(level !== current\) this\._lodSwaps\+\+;/);
    assert.match(three, /Reactor3D\.Shadows\._renderer === this\._renderer\) Reactor3D\.Shadows\.dispose\(\);/);
    // The picture a map stands on (a pinned parallax as ground) is lit like
    // the tiles over it: it is the whole floor of a parallax room.
    assert.match(three, /geometry\.translate\(width \/ 2, lift, height \/ 2\);[\s\S]{0,2600}?material\.__reactorShaded = true;\n\s*Reactor3D\.litMaterial\(material\);\n\s*this\._materials\.push\(material\);\n\n\s*const mesh = new THREE\.Mesh\(geometry, material\);\n\s*\/\/ Beneath the tile geometry/);
    // The static pass draws models at their coarsest level.
    assert.match(three, /this\._atCoarsestLod\(\(\) => shadowMap\.render\(statics, scene, this\._cameras\.static\)\);/);

    const editor = read('editor/src/MapEditor3D.js');
    assert.match(editor, /lightingManager\?\.feed3D\?\.\(\);\n[\s\S]{0,400}?this\.mapScene\.renderShadows\?\.\(this\.renderer, this\.currentMap\(\)\);\n\s*const scene = this\.mapScene\.scene\(\);/);
    assert.match(editor, /if \(sprite && Reactor3D\.Shadows\) Reactor3D\.Shadows\.markCaster\(mesh, false\);/);
    assert.equal((editor.match(/Reactor3D\.Shadows\.markCaster\(object, !!template\.userData\.animated\);/g) || []).length, 2, 'event models and props');

    assert.match(read('runtime/reactor_main.js'), /runtime revision: 20260902\.10/);
});
