'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const repo = path.resolve(__dirname, '..', '..');
const R = require(path.join(repo, 'runtime/reactor_3d.js'));
require(path.join(repo, 'runtime/libs/three.js'));
const THREE = global.THREE;

test('beam bounds are shared within one light update and rebuilt for every new update', () => {
    const saved = { lightBlockHeightAt: R.lightBlockHeightAt, facadeAt: R.facadeAt,
        surfaceHeightAt: R.surfaceHeightAt, sphereInView: R.sphereInView, viewEye: R.viewEye };
    const setFromObject = THREE.Box3.prototype.setFromObject;
    let scans = 0;
    THREE.Box3.prototype.setFromObject = function(object) { scans++; return setFromObject.call(this, object); };
    R.lightBlockHeightAt = () => -100;
    R.facadeAt = () => null;
    R.surfaceHeightAt = () => 0;
    R.sphereInView = () => true;
    R.viewEye = () => null;
    const scene = Object.create(R.MapScene.prototype);
    const crate = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1));
    crate.position.set(4.5, 1, 2);
    scene._modelInstances = new Map([['crate', { object: crate }]]);
    const reaches = [];
    scene.lightBodies = () => ({ place(i, l) { reaches.push(l.radius); }, trim() {} });
    const lights = Array.from({ length: 3 }, (_, i) => ({ id: 'beam' + i, type: 'beam',
        x: 1, y: 1, height: 1, radius: 10, width: .1, yaw: 90, pitch: 0, shadow: false }));
    const sync = () => { scans = 0; reaches.length = 0; scene.syncVolumeLights(lights, null); };
    try {
        sync();
        assert.equal(scans, 1, 'three beams scan the same model once');
        assert.deepEqual(reaches, [2.5, 2.5, 2.5]);
        crate.position.x += 2;
        sync();
        assert.equal(scans, 1);
        assert.deepEqual(reaches, [4.5, 4.5, 4.5], 'fresh position is used without a manual matrix update');
        crate.geometry = new THREE.BoxGeometry(3, 2, 1);
        sync();
        assert.deepEqual(reaches, [3.5, 3.5, 3.5], 'replacement geometry is seen');
        crate.visible = false;
        sync();
        assert.equal(scans, 0);
        assert.deepEqual(reaches, [10, 10, 10]);
        scene._modelInstances.clear();
        sync();
        assert.equal(scans, 0);
        const carrier = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
        carrier.position.set(1.5, 1, 2);
        scene._modelInstances.set('carrier', { object: carrier });
        sync();
        assert.deepEqual(reaches, [10, 10, 10], 'the carrier does not stop its own beam');
        carrier.position.set(5.5, 1, 2);
        assert.equal(R.beamHit(1, 1, 1, 1, 0, 0, 10, scene), 3, 'standalone calls still get fresh bounds');
        carrier.position.x++;
        assert.equal(R.beamHit(1, 1, 1, 1, 0, 0, 10, scene), 4);
    } finally {
        THREE.Box3.prototype.setFromObject = setFromObject;
        Object.assign(R, saved);
        scene.syncVolumeLights([], null);
    }
});

test('attachment rotation matches Three under moving, rotated and scaled parents with one ancestor walk', () => {
    const root = new THREE.Group(), parent = new THREE.Group(), part = new THREE.Group();
    root.add(parent); parent.add(part); part.name = 'screen';
    part.userData.__restQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(.1, .3, -.2));
    const effect = { anchor: { part: 'screen' } };
    const original = THREE.Object3D.prototype.updateWorldMatrix;
    const out = new THREE.Quaternion();
    try {
        for (let i = 0; i < 20; i++) {
            root.position.set(i, -i, i / 2);
            root.rotation.set(i * .03, i * .05, -i * .02);
            root.scale.set(1 + i / 20, .8 + i / 50, 1.5);
            parent.rotation.set(i * .05, -.2, .1);
            part.rotation.set(.4, i * .1, .2);
            let visits = new Map();
            THREE.Object3D.prototype.updateWorldMatrix = function(...args) {
                visits.set(this, (visits.get(this) || 0) + 1);
                return original.apply(this, args);
            };
            assert.equal(R.effectAnchorQuaternion(root, effect, out), out);
            assert.equal(visits.get(root), 1);
            assert.equal(visits.get(parent), 1);
            assert.equal(visits.get(part), 1);
            THREE.Object3D.prototype.updateWorldMatrix = original;
            const expected = part.getWorldQuaternion(new THREE.Quaternion()).multiply(
                parent.getWorldQuaternion(new THREE.Quaternion()).multiply(part.userData.__restQuaternion).invert());
            assert.ok(out.toArray().every((x, j) => Math.abs(x - expected.toArray()[j]) < 1e-12));
        }
        delete part.userData.__restQuaternion;
        assert.deepEqual(R.effectAnchorQuaternion(root, effect, out).toArray(), [0, 0, 0, 1]);
    } finally { THREE.Object3D.prototype.updateWorldMatrix = original; }
});

test('the light cube rejection only excludes points where the original radial term is zero', () => {
    for (const radius of [0, .00001, .001, .25, 1, 10, 1000]) {
        const reach = Math.max(radius, .001);
        for (let x = -5; x <= 5; x++) for (let y = -5; y <= 5; y++) for (let z = -5; z <= 5; z++) {
            const d = [x, y, z].map(v => v * reach / 4);
            if (Math.max(...d.map(Math.abs)) >= reach)
                assert.ok(1 - Math.hypot(...d) / reach <= 1e-15);
        }
    }
    for (const shadows of [false, true]) for (const taps of [1, 5]) {
        const glsl = R.lightGlsl(shadows, taps);
        const reject = glsl.indexOf('if (max(max(abs(d.x), abs(d.y)), abs(d.z)) >= max(lp.w, 0.001)) continue;');
        assert.ok(reject >= 0 && reject < glsl.indexOf('float dist = length(d);'));
        assert.ok(glsl.includes('fall *= smoothstep(aim.w, mix(aim.w, 1.0, 0.35), c);'));
    }
});
