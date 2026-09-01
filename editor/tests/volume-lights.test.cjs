/**
 * Lights in volume.
 *
 * The flat quads lit the floor and nothing else: a light's height was
 * discarded, a wall beside a lamp stayed dark, a spot could only sweep
 * sideways. In volume mode every map material takes the map's lights as
 * shader uniforms and lights each pixel by its distance from every source in
 * three dimensions, and each source stands in the world as a glowing body a
 * wall can hide.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const Reactor3D = require(path.join(repoRoot, 'runtime', 'reactor_3d.js'));

test('volume is the default, and a map or the engine can ask for the flat quads', () => {
    assert.equal(Reactor3D.LIGHT_MODE, 'volume');
    assert.equal(Reactor3D.lightModeFor({ reactor3d: {} }), 'volume');
    assert.equal(Reactor3D.lightModeFor({ reactor3d: { lighting: { mode: 'flat' } } }), 'flat');
    assert.equal(Reactor3D.lightModeFor(null), 'volume');
    const was = Reactor3D.LIGHT_MODE;
    try {
        Reactor3D.LIGHT_MODE = 'flat';
        assert.equal(Reactor3D.lightModeFor({ reactor3d: {} }), 'flat');
    } finally {
        Reactor3D.LIGHT_MODE = was;
    }
});

test('a spot carries a pitch: read from the sidecar, bounded, resolved per frame, mirrored by the editor', () => {
    Reactor3D._nativeNorm = null;
    const map = { reactor3d: { lights: [
        { id: 'a', type: 'spot', x: 1, y: 2, yaw: 45, pitch: -60, height: 3 },
        { id: 'b', type: 'spot', pitch: 500 },
        { id: 'c', type: 'point' }
    ] } };
    const lights = Reactor3D.readMapLights(map);
    assert.equal(lights[0].pitch, -60);
    assert.equal(lights[1].pitch, 90, 'bounded to straight up');
    assert.equal(lights[2].pitch, 0, 'level by default');
    const resolved = Reactor3D.nativeLights(map);
    assert.equal(resolved[0].pitch, -60, 'pitch is not flipped the way yaw is');
    assert.equal(resolved[0].yaw, -45);
    assert.equal(resolved[0].height, 3);

    const editor = read('editor/src/utils/MapLights.js');
    assert.match(editor, /pitch: number\(raw\.pitch, 0, -90, 90\),/);
    const manager = read('editor/src/LightingManager.js');
    assert.match(manager, /yaw: light\.yaw, pitch: light\.pitch,/, 'resolvedLights carries it');
    assert.match(manager, /yaw: -light\.yaw, pitch: light\.pitch, occlude: light\.occlude/, 'feed3D hands it to the compositor');
    assert.match(manager, /numberInput\('pitch', light\.pitch, -90, 90, 1\)/, 'the panel edits it for spots');
    const i18n = read('editor/src/I18nManager.js');
    assert.equal((i18n.match(/"lit\.pitch": "/g) || []).length, 18, 'named in every locale');
});

test('a lit material composes with earlier injections and keys its program apart', () => {
    const calls = [];
    const material = {
        onBeforeCompile(shader) { calls.push('earlier'); shader.vertexShader = '/*E*/' + shader.vertexShader; },
        customProgramCacheKey() { return 'earlier-key'; }
    };
    assert.equal(Reactor3D.litMaterial(material), material);
    assert.equal(material.__reactorLit, true);
    assert.equal(Reactor3D.litMaterial(material), material, 'idempotent');
    assert.equal(material.customProgramCacheKey(), 'earlier-key|reactor3d-lit');

    const shader = {
        uniforms: {},
        vertexShader: 'void main() {\n#include <begin_vertex>\n#include <project_vertex>\n}',
        fragmentShader: 'void main() {\n\tvec4 diffuseColor = vec4( diffuse, opacity );\n#include <map_fragment>\n}'
    };
    material.onBeforeCompile(shader, null);
    assert.deepEqual(calls, ['earlier'], 'the earlier hook ran first');
    assert.ok(shader.vertexShader.startsWith('varying vec3 vRRWorldPos;\n/*E*/'));
    assert.match(shader.vertexShader, /#include <project_vertex>\n\tvRRWorldPos = \(modelMatrix \* vec4\(transformed, 1\.0\)\)\.xyz;/);
    assert.match(shader.fragmentShader, /vec4 diffuseColor = vec4\( diffuse \* rrLight\(vRRWorldPos\), opacity \);/);
    assert.match(shader.fragmentShader, /uniform vec4 rrLightPos\[32\];/);
    assert.match(shader.fragmentShader, /smoothstep\(aim\.w, mix\(aim\.w, 1\.0, 0\.35\), c\)/, 'a cone is soft at its rim');
    const uniforms = Reactor3D.lightUniforms();
    for (const key of ['rrLightCount', 'rrLightPos', 'rrLightColor', 'rrLightAim', 'rrAmbient']) {
        assert.equal(shader.uniforms[key], uniforms[key], key + ' is the shared value object, not a copy');
    }
    assert.equal(uniforms.rrLightPos.value.length, Reactor3D.SHADER_LIGHTS * 4);

    const bare = {};
    Reactor3D.litMaterial(bare);
    assert.equal(bare.customProgramCacheKey(), '|reactor3d-lit');
    assert.equal(Reactor3D.litMaterial(null), null);
});

test('every surface of the map is lit: tiles, cut-outs, rooms, models, characters', () => {
    const three = read('runtime/reactor_3d.js');
    const sites = [
        /"reactor3d-billboard-clamped" : "reactor3d-tile-clamped"\);\n\s*Reactor3D\.litMaterial\(material\);/,
        /"reactor3d-billboard-clamped" : "reactor3d-tile-clamped"\);\n\s*Reactor3D\.litMaterial\(opaqueCore\);/,
        /material\.__reactorShaded = true;\n\s*Reactor3D\.litMaterial\(material\);\n\s*this\._materials\.push\(material\);/,
        /mat\.userData\.baseColor = mat\.color\.clone\(\);\n\s*Reactor3D\.litMaterial\(mat\);/,
        /defaultMat\.__reactorModel = true;\n\s*Reactor3D\.litMaterial\(defaultMat\);/,
        /fog: false \}\);\n\s*Reactor3D\.litMaterial\(material\);/,
        /Reactor3D\.straightenBillboardDepth\(material\);\n\s*Reactor3D\.litMaterial\(material\);/
    ];
    for (const site of sites) assert.match(three, site);
    // Lit materials keep their base colour; the ambient reaches them as a uniform.
    assert.match(three, /const shared = Reactor3D\.lightUniforms\(\)\.rrAmbient\.value;/);
    assert.match(three, /for \(const material of this\._materials\) \{\n\s*if \(material\.__reactorLit\) continue;/);
});

test('in volume mode syncLights writes uniforms and bodies, never quads or a pass', () => {
    const three = read('runtime/reactor_3d.js');
    const at = three.indexOf('Reactor3D.MapScene.prototype.syncLights = function');
    const body = three.slice(at, three.indexOf('\n};', at));
    assert.match(body, /if \(Reactor3D\.lightModeFor\(\) === "volume"\) \{\n\s*this\.syncVolumeLights\(declared, focus\);\n\s*return;\n\s*\}/);
    assert.match(body, /Reactor3D\.lightUniforms\(\)\.rrLightCount\.value = 0;/, 'the flat path clears the field');

    const volume = three.slice(three.indexOf('Reactor3D.MapScene.prototype.syncVolumeLights = function'));
    assert.match(volume, /const y = standsOn \+ lift \+ height;/, 'height is a coordinate now');
    assert.match(volume, /ay = Math\.sin\(pitch\);/, 'a spot aims up or down');
    assert.match(volume, /cosHalf = Math\.cos\(\(Math\.min\(angle, 178\) \* Math\.PI\) \/ 360\);/);
    assert.match(volume, /gain = intensity \* Reactor3D\.VOLUME_LIGHT_GAIN/);
    assert.match(volume, /new THREE\.SphereGeometry\(1, 24, 16\)/, 'a point light has a sphere');
    assert.match(volume, /new THREE\.ConeGeometry\(1, 1, 32, 1, true\)/, 'a spot has a cone');
    assert.match(volume, /cone\.quaternion\.setFromUnitVectors\(down, aimVector\)/);
    assert.match(volume, /depthWrite: false,\n\s*depthTest: true,/, 'bodies are hidden by walls and never hide each other');
    assert.match(volume, /blending: THREE\.AdditiveBlending/);

    // The bodies live in the world's passes, with the models.
    const pass = three.slice(three.indexOf('Reactor3D.MapScene.prototype.setPass = function'));
    assert.match(pass, /this\._lightBodyGroup\.visible = all \|\| world \|\| which === "below";/);
    // And a cleared map lets go of them.
    assert.match(three, /this\._lightBodies\.dispose\(\);\n\s*this\._lightBodies = null;/);

    // The game builds no additive pass, and the flat 2D composite stands down on a 3D map.
    const sprites = read('runtime/reactor_sprites.js');
    assert.match(sprites, /this\._reactor3dLights = Reactor3D\.wantsLights3D\(\$dataMap\)\n\s*&& Reactor3D\.lightModeFor\(\$dataMap\) === "flat"/);
    assert.match(sprites, /&& !\(this\._reactor3dBelow && Reactor3D\.lightModeFor\(\$dataMap\) === "volume"\)/);
});

test('the field selects the nearest lights to the focus when there are more than the shader holds', () => {
    // A minimal scene: no THREE, so bodies are stubbed; the uniforms are real.
    const scene = Object.create(Reactor3D.MapScene.prototype);
    const placed = [];
    scene.lightBodies = () => ({ place: (i, l) => placed.push(l), trim: () => {} });
    const saved = { facadeAt: Reactor3D.facadeAt, surfaceHeightAt: Reactor3D.surfaceHeightAt };
    Reactor3D.facadeAt = () => null;
    Reactor3D.surfaceHeightAt = () => 0;
    try {
        const lights = [];
        for (let i = 0; i < 40; i++) {
            lights.push({ type: 'point', x: i * 2, y: 0, height: 1, radius: 3, colour: 0xff8000, intensity: 1 });
        }
        lights.push({ type: 'spot', x: 5, y: 5, height: 4, radius: 6, angle: 60, yaw: 90, pitch: -90, colour: 0xffffff, intensity: 2 });
        scene.syncVolumeLights(lights, { x: 5, y: 5 });
        const u = Reactor3D.lightUniforms();
        assert.equal(u.rrLightCount.value, Reactor3D.SHADER_LIGHTS);
        assert.equal(placed.length, Reactor3D.SHADER_LIGHTS);
        const spot = placed.find(l => l.spot);
        assert.ok(spot, 'the spot right at the focus made the cut');
        assert.ok(placed.every(l => l.x <= 61), 'the far end of the street did not');
        assert.equal(spot.y, 4, 'stood at its height');
        assert.equal(spot.x, 5.5);
        assert.equal(spot.z, 6, 'the southern edge of its cell, like the flat pool');
        const at = placed.indexOf(spot) * 4;
        assert.ok(Math.abs(u.rrLightAim.value[at + 1] + 1) < 1e-6, 'pitched -90 aims straight down');
        assert.ok(Math.abs(u.rrLightAim.value[at + 3] - Math.cos(Math.PI / 6)) < 1e-6, 'cos of half the spread');
        assert.equal(u.rrLightColor.value[at + 3], 1, 'flagged as a spot');
        assert.equal(u.rrLightColor.value[at], 2 * Reactor3D.VOLUME_LIGHT_GAIN, 'colour carries intensity and gain');
        assert.equal(u.rrLightPos.value[at + 3], 6, 'and its reach');

        scene.syncVolumeLights([], null);
        assert.equal(u.rrLightCount.value, 0);
    } finally {
        Reactor3D.facadeAt = saved.facadeAt;
        Reactor3D.surfaceHeightAt = saved.surfaceHeightAt;
    }
});
