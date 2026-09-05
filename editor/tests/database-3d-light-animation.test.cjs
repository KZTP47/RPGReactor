const assert = require('node:assert/strict');
const test = require('node:test');
require('../../runtime/libs/three.js');
const THREE = global.THREE;
const Reactor3D = require('../../runtime/reactor_3d.js');
const Editor = require('../src/database/Database3DEditor.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const type of ['point', 'spot', 'beam']) {
    test(`database ${type} preview animates flicker and pulse in the body, core and surface light`, t => {
        const previous = global.Reactor3D;
        global.Reactor3D = Reactor3D;
        t.after(() => { if (previous === undefined) delete global.Reactor3D; else global.Reactor3D = previous; });
        const e = new Editor({}, {});
        e._object = new THREE.Group();
        e._effectDef = raw => raw;
        e._beamLanding = () => null;
        let gizmoRadius;
        e._syncLightGizmo = light => { gizmoRadius = light.radius; };
        const material = () => ({ uniforms: { colour: { value: new THREE.Color() }, strength: { value: 0 } } });
        e._fxLight = { group: new THREE.Group(), bodies: Object.fromEntries(['point', 'spot', 'beam'].map(kind => [kind, new THREE.Object3D()])),
            core: new THREE.Sprite(new THREE.SpriteMaterial()), material: material(), beamMaterial: material() };
        t.after(() => e._fxLight.core.material.dispose());

        for (const settings of [{ flicker: 1 }, { flicker: 0, pulse: { period: 60, min: 0.5, max: 1 } }, { flicker: 0 }]) {
            const def = Reactor3D.readModelEffects({ effects: [{ name: 'Lamp', type: 'light',
                light: { type, radius: 3, intensity: 0.5, colour: '#ffffff', ...settings } }] })[0];
            e._fxLight.raw = def;
            const authored = JSON.stringify(def);
            const base = Reactor3D.effectLight(e._object, def, 'preview');
            const samples = [];
            for (const frame of [0, 7, 16, 54, 54]) {
                const expected = { ...Reactor3D.animateLight(def.light, frame, 0, base.radius, base.intensity) };
                e._simFrame = frame;
                e._updateLightPreview();
                const body = e._fxLight.bodies[type];
                assert.equal(body.visible, true);
                assert.equal(body.scale.y, expected.radius * (type === 'point' ? 0.45 : 1));
                assert.equal(e._fxLight.material.uniforms.strength.value, 0.6 * expected.intensity);
                assert.equal(e._fxLight.beamMaterial.uniforms.strength.value, 0.6 * expected.intensity);
                assert.equal(e._fxLight.core.material.opacity, Math.min(1, Reactor3D.VOLUME_GLOW * expected.intensity));
                assert.equal(gizmoRadius, base.radius, 'editing handles do not flicker');
                const actual = Array.from(Reactor3D.lightUniforms().rrLightColor.value.slice(0, 4));
                const reach = Array.from(Reactor3D.lightUniforms().rrLightPos.value.slice(0, 4));
                Reactor3D.packLightUniforms([{ ...base, radius: expected.radius, intensity: expected.intensity }],
                    { intensity: e.LIGHT_PREVIEW_AMBIENT, colour: 0xffffff });
                assert.deepEqual(actual, Array.from(Reactor3D.lightUniforms().rrLightColor.value.slice(0, 4)));
                assert.deepEqual(reach, Array.from(Reactor3D.lightUniforms().rrLightPos.value.slice(0, 4)));
                samples.push([...actual, ...reach]);
            }
            assert.deepEqual(samples[3], samples[4], 'repeating a frame does not accumulate animation');
            if (settings.flicker || settings.pulse) assert.notDeepEqual(samples[0], samples[1]);
            else assert.deepEqual(samples[0], samples[1], 'an unanimated light stays steady');
            assert.equal(JSON.stringify(def), authored, 'preview does not change authored settings');
        }
    });
}

test('map preview animates carried lights even without animated models and preserves shadow priorities', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/MapEditor3D.js'), 'utf8');
    const context = vm.createContext({ THREE, Reactor3D });
    const MapEditor3D = vm.runInContext(source + '\nMapEditor3D;', context);
    const e = Object.create(MapEditor3D.prototype), scene = new THREE.Group();
    e.camera = {};
    e.canvas = { getBoundingClientRect: () => ({ width: 100, height: 100 }) };
    e.effectPlays = ['point', 'spot', 'beam'].map(type => {
        const object = new THREE.Group();
        scene.add(object);
        const effect = Reactor3D.readModelEffects({ effects: [{ name: type, type: 'light',
            light: { type, radius: 3, intensity: 1, flicker: 1 } }] })[0];
        return { object, light: true, effect, key: type };
    });
    const first = [];
    for (const frame of [0, 7, 16]) {
        e.animateModels(frame * 1000 / 60);
        const lights = Reactor3D._editorEffectLights;
        assert.equal(lights.length, 3);
        lights.forEach((light, index) => {
            const play = e.effectPlays[index];
            const base = Reactor3D.effectLight(play.object, play.effect, play.key);
            const expected = Reactor3D.animateLight(play.effect.light, frame, 1001 + index, base.radius, base.intensity);
            assert.equal(light.radius, expected.radius);
            assert.equal(light.intensity, expected.intensity);
            assert.equal(light.priorityRadius, base.radius);
            assert.equal(light.priorityIntensity, base.intensity);
            if (frame === 0) first.push(light.intensity);
            else assert.notEqual(light.intensity, first[index]);
        });
    }
});
