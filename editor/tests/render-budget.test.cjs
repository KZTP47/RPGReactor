const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const repo = path.resolve(__dirname, '..', '..');
require(path.join(repo, 'runtime/libs/three.js'));
const R = require(path.join(repo, 'runtime/reactor_3d.js'));
const T = global.THREE;

function field() {
    return { rrLightCount: { value: 32 }, rrLightPos: { value: new Float32Array(128) },
        rrLightColor: { value: new Float32Array(128) }, rrLightAim: { value: new Float32Array(128) } };
}
function contributes(p, position, color, aim) {
    const d = p.map((v, i) => v - position[i]), distance = Math.hypot(...d);
    if (distance >= Math.max(position[3], .001)) return false;
    if (color[3] < .5) return true;
    const along = d.reduce((n, v, i) => n + v * aim[i], 0);
    if (color[3] < 1.5) return along / Math.max(distance, .0001) > aim[3];
    return along >= 0 && along <= position[3]
        && Math.hypot(...d.map((v, i) => v - aim[i] * along)) < aim[3];
}
test('cell culling retains every contributing point, spot and beam, including bit 31 and boundaries', () => {
    let seed = 872346;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    const u = field(), origin = new Float32Array([-32, -8, -32]);
    const [nx, ny, nz] = R.LightGrid.size, step = R.LightGrid.step;
    const data = new Uint32Array(nx * ny * nz);
    for (let round = 0; round < 8; round++) {
        for (let i = 0; i < 32; i++) {
            const at = i * 4, axis = new T.Vector3(random() - .5, random() - .5, random() - .5).normalize();
            u.rrLightPos.value.set([random() * 60 - 30, random() * 26 - 6, random() * 60 - 30, .001 + random() * 60], at);
            u.rrLightColor.value.set([1, 1, 1, i % 3], at);
            u.rrLightAim.value.set([...axis.toArray(), i % 3 === 2 ? .005 + random() * 5 : .01 + random() * .989], at);
        }
        R.LightGrid.fill(data, origin, 32, u.rrLightPos.value, u.rrLightColor.value, u.rrLightAim.value);
        for (let sample = 0; sample < 6000; sample++) {
            const cell = [Math.floor(random() * nx), Math.floor(random() * ny), Math.floor(random() * nz)];
            const point = cell.map((v, k) => origin[k] + (v + (sample % 3 ? random() : .0000001)) * step);
            const mask = data[(cell[2] * ny + cell[1]) * nx + cell[0]];
            for (let i = 0; i < 32; i++) if (contributes(point, u.rrLightPos.value.subarray(i * 4, i * 4 + 4),
                u.rrLightColor.value.subarray(i * 4, i * 4 + 4), u.rrLightAim.value.subarray(i * 4, i * 4 + 4))) {
                assert.notEqual((mask & (1 << i)) >>> 0, 0, `Missing light ${i}, sample ${sample}, round ${round}`);
            }
        }
    }
});
test('moving lights, grid shifts and removals replace masks immediately; independent previews disable them', () => {
    const u = field(); u.rrLightCount.value = 8;
    for (let i = 0; i < 8; i++) u.rrLightPos.value.set([1, 1, 1, 2], i * 4);
    R.LightGrid.update(u, { x: 0, y: 0 });
    const first = u.rrLightGrid.value.image.data.slice();
    for (let i = 0; i < 8; i++) u.rrLightPos.value.set([24, 20, 24, 2], i * 4);
    R.LightGrid.update(u, { x: 0, y: 0 });
    assert.notDeepEqual(u.rrLightGrid.value.image.data, first);
    const second = u.rrLightGrid.value.image.data.slice();
    R.LightGrid.update(u, { x: 60, y: 60 });
    assert.notDeepEqual(u.rrLightGrid.value.image.data, second);
    u.rrLightCount.value = 0; R.LightGrid.update(u, null); assert.equal(u.rrLightGridEnabled.value, 0);
    const old = R._lightUniforms;
    try { R._lightUniforms = null; const own = R.lightUniforms(); R.LightGrid.ensure(own); own.rrLightGridEnabled.value = 1;
        R.packLightUniforms([], null); assert.equal(own.rrLightGridEnabled.value, 0);
        assert.notEqual(own.rrLightGrid.value, u.rrLightGrid.value); own.rrLightGrid.value.dispose();
    } finally { R._lightUniforms = old; u.rrLightGrid.value.dispose(); }
});

test('colour levels preserve source geometry for shadows/collision and restore state after a failed draw', t => {
    const scene = new T.Scene(), camera = new T.PerspectiveCamera(45, 1, .1, 100);
    camera.position.z = 10;
    const original = new T.BoxGeometry(), reduced = new T.BoxGeometry(), mesh = new T.Mesh(original, new T.MeshBasicMaterial());
    scene.add(mesh);
    t.mock.method(R, 'tier', () => 'weak');
    t.mock.method(R.GeometryDetail, 'begin', () => { mesh.geometry = reduced; return [[mesh, original]]; });
    const renderer = { domElement: { height: 1080 }, render() {
        assert.equal(mesh.geometry, reduced);
        R.GeometryDetail.withOriginal(() => assert.equal(mesh.geometry, original));
        assert.equal(mesh.geometry, reduced);
        throw Error('draw failed');
    } };
    assert.throws(() => R.renderScene(renderer, scene, camera), /draw failed/);
    assert.equal(mesh.geometry, original);
    assert.equal(scene.matrixWorldAutoUpdate, true);
    assert.equal(camera.matrixWorldAutoUpdate, true);
    assert.equal(R.GeometryDetail._active, undefined);
});
test('projected error tightens with camera approach and respects shear; mutable and skinned geometry falls back', t => {
    const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute([0,0,0,1,0,0,0,1,0], 3));
    g.setIndex(new T.BufferAttribute(new Uint32Array(100002), 1));
    const m = new T.MeshBasicMaterial(); m.__reactorModel = true;
    const mesh = new T.Mesh(g, m), c = new T.PerspectiveCamera(50, 1, .1, 1000); mesh.updateMatrixWorld();
    assert.equal(R.GeometryDetail.eligible(mesh), true);
    g.setDrawRange(3, 100000); assert.equal(R.GeometryDetail.eligible(mesh), false);
    g.setDrawRange(0, 100000); assert.equal(R.GeometryDetail.eligible(mesh), false);
    g.setDrawRange(0, Infinity);
    const uv = new T.InterleavedBuffer(new Float32Array(6), 2);
    g.setAttribute('uv', new T.InterleavedBufferAttribute(uv, 2, 0));
    const uvState = { source: g, signature: R.GeometryDetail.signature(g), dead: false };
    uv.needsUpdate = true; assert.equal(R.GeometryDetail.fresh(uvState), false);
    const state = { source: g, signature: R.GeometryDetail.signature(g), dead: false };
    g.attributes.position.needsUpdate = true; assert.equal(R.GeometryDetail.fresh(state), false);
    mesh.isSkinnedMesh = true; assert.equal(R.GeometryDetail.eligible(mesh), false); mesh.isSkinnedMesh = false;
    c.position.z = 100; c.updateMatrixWorld(); const distant = R.GeometryDetail.pixelsPerUnit(mesh, c, 1080);
    c.position.z = 10; c.updateMatrixWorld(); assert.ok(R.GeometryDetail.pixelsPerUnit(mesh, c, 1080) > distant * 9);
    const matrix = new T.Matrix4().makeShear(2, 3, -1, .5, -.2, 1.3);
    const bound = R.GeometryDetail.scaleBound(matrix.elements);
    for (let i = 0; i < 200; i++) {
        const v = new T.Vector3(Math.sin(i), Math.cos(i * 1.7), Math.sin(i * 3.1)).normalize().applyMatrix4(matrix);
        assert.ok(v.length() <= bound + 1e-10);
    }
    const scene = new T.Scene(); scene.add(mesh); scene.overrideMaterial = new T.MeshDepthMaterial();
    assert.deepEqual(R.GeometryDetail.begin(scene, c, 1080), []);
});
test('disposed geometry ignores late worker replies; a worker failure drops its queue', t => {
    const D = R.GeometryDetail, g = new T.BoxGeometry(); g.setIndex(new T.BufferAttribute(new Uint32Array(100002), 1));
    const worker = { postMessage() {}, terminate() { this.terminated = true; } };
    t.mock.method(D, 'dispatch', () => {});
    const old = { states: D._states, queue: D._queue, busy: D._busy, worker: D._worker, failed: D._failed };
    try {
        D._states = new WeakMap(); D._queue = []; D._failed = false; D._worker = worker;
        const state = D.state(g); D._busy = state; g.dispose();
        D.receive({ id: state.id, levels: [{ indices: new Uint32Array([0,1,2]), error: .0001 }] });
        assert.equal(state.levels.length, 0);
        D._queue.push({}); D.fail(); assert.equal(D._queue.length, 0); assert.equal(worker.terminated, true);
    } finally { Object.assign(D, { _states: old.states, _queue: old.queue, _busy: old.busy, _worker: old.worker, _failed: old.failed }); }
});

test('the real worker reduces dense geometry without changing source vertex data', async () => {
    const moduleCode = fs.readFileSync(path.join(repo, 'runtime/libs/meshopt_simplifier.js'), 'utf8');
    const { MeshoptSimplifier } = await import('data:text/javascript;base64,' + Buffer.from(moduleCode).toString('base64'));
    const geometry = new T.PlaneGeometry(2, 2, 32, 32);
    const positions = geometry.attributes.position.array.slice(), attributes = geometry.attributes.uv.array.slice();
    const beforeP = positions.slice(), beforeUV = attributes.slice();
    let result;
    const self = { postMessage(value) { result = value; } };
    const code = fs.readFileSync(path.join(repo, 'runtime/libs/reactor_geometry_worker.js'), 'utf8').replace(/^import .*;$/m, '');
    vm.runInNewContext(code, { self, MeshoptSimplifier, Float32Array, Uint32Array, Error });
    await self.onmessage({ data: { id: 7, positions, indices: new Uint32Array(geometry.index.array), attributes, stride: 2, weights: [1, 1] } });
    assert.equal(result.id, 7); assert.equal(result.error, undefined); assert.ok(result.levels.length);
    assert.ok(result.levels[0].indices.length < geometry.index.count / 2);
    for (const level of result.levels) for (const index of level.indices) assert.ok(index < positions.length / 3);
    assert.deepEqual(positions, beforeP); assert.deepEqual(attributes, beforeUV);
});
test('asynchronous coverage uses its captured pose, ignores ended effects and releases failure state', t => {
    const M = R.EffectMeasure, old = { pending: M._pending, failed: M._failed, worker: M._worker };
    const pixels = new Uint8ClampedArray(4 * 4 * 4); pixels[(1 * 4 + 1) * 4 + 3] = 255;
    const args = [{ x: 0, y: 0, w: 40, h: 40 }, 40, 40, { x: 20, y: 20 }, 10, 20, 1];
    const track = { history: [], _measurePending: 1 }, expected = { history: [] }, play = { track, frames: 90 };
    R.EffekseerScene.measurePixels(expected, pixels, 4, 4, ...args);
    try {
        M._pending = new Map([[1, { play, track, frame: 3, mw: 4, mh: 4, args }]]);
        M.receive({ id: 1, pixels }); assert.equal(play.lastLit, 3);
        assert.deepEqual(track, expected); assert.equal(M._pending.size, 0);
        const ended = { track: { history: [], _measurePending: 2 }, done: true };
        M._pending.set(2, { play: ended, track: ended.track }); M.receive({ id: 2, pixels });
        assert.equal(ended.track.history.length, 0); assert.equal(ended.track._measurePending, undefined);
        const failure = { _measurePending: 3 }; M._pending.set(3, { track: failure });
        M._worker = { terminate() {} }; M.fail(); assert.equal(failure._measurePending, undefined); assert.equal(M._pending.size, 0);
    } finally { M._pending = old.pending; M._failed = old.failed; M._worker = old.worker; }
});

test('all shadow passes, including rigid dynamic casters, see original geometry', t => {
    const D = R.GeometryDetail, original = new T.BoxGeometry(), reduced = new T.BoxGeometry();
    const mesh = new T.Mesh(reduced, new T.MeshBasicMaterial()), active = D._active;
    try {
        D._active = [[mesh, original]];
        t.mock.method(R.Shadows, '_flushOriginal', () => { assert.equal(mesh.geometry, original); throw Error('shadow interrupted'); });
        assert.throws(() => R.Shadows._flush(), /shadow interrupted/);
        assert.equal(mesh.geometry, reduced);
    } finally { D._active = active; }
});
