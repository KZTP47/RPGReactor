const test = require('node:test');
const assert = require('node:assert/strict');
require('../../runtime/libs/three.js');
const THREE = global.THREE;
const R = require('../../runtime/reactor_3d.js');
const Effects = require('../src/utils/ModelPropEffects2D.js');

function fixture(t, gpu = true) {
    const keys = ['THREE', 'Reactor3D', 'MapEditor3D'];
    const old = keys.map(k => global[k]);
    Object.assign(global, { THREE, Reactor3D: R, MapEditor3D: { EFFECT_PIXELS: 1920 * 1080 } });
    t.after(() => keys.forEach((k, i) => { if (old[i] === undefined) delete global[k]; else global[k] = old[i]; }));
    const calls = [], renderer = {};
    const layer = { active: false, fx: { gpu: gpu ? {} : null }, fxCanvas: { width: 512, height: 512 },
        setWorld(world) { this.world = world; calls.push('world'); },
        play() { assert.ok(this.world.renderer); this.active = true; calls.push('play'); },
        stop() { this.active = false; calls.push('stop'); },
        drawGpuQuad() { calls.push('gpu'); return this.active; },
        drawNow() { calls.push('canvas'); return this.active; } };
    const object = new THREE.Group(); object.userData.glbSize = { x: 1, y: 4, z: 1 };
    const camera = new THREE.OrthographicCamera(-4, 4, 4, -4, .01, 100);
    camera.position.set(0, 8, 8); camera.lookAt(0, 0, 0);
    const quad = R.EffekseerScene.quadFor(layer.fxCanvas);
    t.after(() => { quad.mesh.geometry.dispose(); quad.material.dispose(); quad.texture.dispose(); });
    const entry = { object, camera, size: 2000 };
    const play = { quad, layer, clip: { style: {} }, record: { effectName: 'Core', scale: 100 },
        effect: { anchor: { offset: [0, 2, 0] }, rotate: [0, 0, 0], scale: [1, 1, 1] }, project: '/fixture' };
    const media = Object.create(Effects.prototype);
    Object.assign(media, { entry, preview: { ensureViewport: () => ({ renderer: () => renderer }) }, plays: [play] });
    return { media, play, entry, calls };
}

test('flat Effekseer enters world mode before playback and follows the final target size', t => {
    const { media, play, entry, calls } = fixture(t);
    assert.equal(media.update(true), true);
    assert.deepEqual(calls, ['world', 'play']);
    assert.equal(play.clip.style.display, 'none');
    assert.deepEqual(play.layer.world.position, [0, 2, 0]);
    assert.ok(play.layer.world.rect.scale < 1, 'uses the existing effect pixel budget');
    entry.size = 700; media.paint();
    assert.equal(play.layer.world.viewWidth, 700);
    assert.equal(play.quad.material.uniforms.resolution.value.x, 700);
    assert.equal(play.quad.mesh.visible, true);
    assert.equal(play.quad.material.depthTest, true);
    assert.equal(play.quad.material.depthWrite, false);
    assert.equal(calls.at(-1), 'gpu');
    media.update(false);
    assert.equal(play.quad.mesh.visible, false); assert.equal(play.layer.active, false);
    media.update(true);
    assert.equal(calls.filter(c => c === 'play').length, 2, 'returning onscreen restarts playback');
    media.suspend();
    assert.equal(play.visible, false); assert.equal(entry.dirty, true);
});

test('the fallback canvas is sampled on the depth-tested quad rather than a map overlay', t => {
    const { media, play, calls } = fixture(t, false);
    media.update(true); media.paint();
    assert.equal(calls.at(-1), 'canvas');
    assert.equal(play.clip.style.display, 'none');
    assert.equal(play.quad.mesh.visible, true);
    assert.equal(play.quad.material.depthTest, true);
    assert.ok(play.quad.texture.version > 0);
    play.layer.active = false; media.paint();
    assert.equal(play.quad.mesh.visible, false, 'finished playback clears the last visible frame');
});
