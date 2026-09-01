/**
 * The quadric decimator and the mesh BVH: both pure typed-array code, both
 * checked against brute force.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const editorRoot = path.resolve(__dirname, '..');
const Decimator = require(path.join(editorRoot, 'src', 'utils', 'QuadricDecimator.js'));
const Bvh = require(path.join(editorRoot, 'src', 'utils', 'MeshBvh.js'));

/** A bumpy grid: a height field with a soft hill, so collapses have something to judge. */
function hillGrid(size) {
    const positions = [], normals = [], uvs = [], indices = [];
    for (let y = 0; y <= size; y++) {
        for (let x = 0; x <= size; x++) {
            const u = x / size, v = y / size;
            const h = Math.exp(-((u - 0.5) ** 2 + (v - 0.5) ** 2) * 12) * 0.3;
            positions.push(u, h, v);
            normals.push(0, 1, 0);
            uvs.push(u, v);
        }
    }
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const a = y * (size + 1) + x, b = a + 1, c = a + size + 1, d = c + 1;
            indices.push(a, b, c, b, d, c);
        }
    }
    return {
        positions: Float32Array.from(positions), normals: Float32Array.from(normals),
        uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices)
    };
}

function bbox(positions) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
        for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], positions[i + k]); max[k] = Math.max(max[k], positions[i + k]); }
    }
    return { min, max };
}

test('the decimator reaches its target, keeps the bounds, and keeps the border', () => {
    const mesh = hillGrid(60);
    const triangles = mesh.indices.length / 3;
    const result = Decimator.decimate(mesh, Math.round(triangles * 0.2));
    assert.equal(result.stopped, 'target');
    assert.ok(result.triangles <= Math.round(triangles * 0.2), `${result.triangles} triangles`);
    assert.ok(result.triangles > triangles * 0.1, 'and not wildly under it');
    assert.equal(result.indices.length, result.triangles * 3);
    for (let i = 0; i < result.indices.length; i++) assert.ok(result.indices[i] < result.vertices, 'indices in range');
    for (let t = 0; t < result.triangles; t++) {
        const a = result.indices[t * 3], b = result.indices[t * 3 + 1], c = result.indices[t * 3 + 2];
        assert.ok(a !== b && b !== c && a !== c, 'no degenerate triangle survives');
    }
    const before = bbox(mesh.positions), after = bbox(result.positions);
    for (let k = 0; k < 3; k++) {
        assert.ok(Math.abs(before.min[k] - after.min[k]) < 0.02 && Math.abs(before.max[k] - after.max[k]) < 0.02, 'bounds within 2%');
    }
    // The border is a boundary: its corners survive in place.
    const corners = [[0, 0], [1, 0], [0, 1], [1, 1]];
    for (const [cx, cz] of corners) {
        let found = false;
        for (let i = 0; i < result.positions.length; i += 3) {
            if (Math.abs(result.positions[i] - cx) < 1e-4 && Math.abs(result.positions[i + 2] - cz) < 1e-4) { found = true; break; }
        }
        assert.ok(found, `corner ${cx},${cz} kept`);
    }
    // UVs stay inside the atlas; normals stay unit.
    for (let i = 0; i < result.uvs.length; i++) assert.ok(result.uvs[i] >= -1e-6 && result.uvs[i] <= 1 + 1e-6);
    for (let i = 0; i < result.normals.length; i += 3) {
        const len = Math.hypot(result.normals[i], result.normals[i + 1], result.normals[i + 2]);
        assert.ok(Math.abs(len - 1) < 1e-3, 'unit normal');
    }
    assert.ok(result.indices instanceof Uint16Array, 'small enough for 16-bit indices');
});

test('the decimator leaves a small mesh alone and copies rather than aliases', () => {
    const mesh = hillGrid(4);
    const result = Decimator.decimate(mesh, 1000);
    assert.equal(result.triangles, mesh.indices.length / 3);
    assert.notEqual(result.positions, mesh.positions);
    assert.deepEqual(Array.from(result.indices), Array.from(mesh.indices));
});

/** A BufferGeometry stand-in: what MeshBvh reads. */
function geometryOf(mesh) {
    return {
        attributes: { position: { array: mesh.positions, count: mesh.positions.length / 3 } },
        index: { array: mesh.indices },
        drawRange: { start: 0, count: Infinity }
    };
}

function bruteForce(mesh, ox, oy, oz, dx, dy, dz) {
    const pos = mesh.positions, idx = mesh.indices;
    let best = Infinity, tri = -1;
    for (let t = 0; t < idx.length / 3; t++) {
        const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
        const e1 = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]];
        const e2 = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
        const p = [dy * e2[2] - dz * e2[1], dz * e2[0] - dx * e2[2], dx * e2[1] - dy * e2[0]];
        const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det;
        const tv = [ox - pos[a], oy - pos[a + 1], oz - pos[a + 2]];
        const u = (tv[0] * p[0] + tv[1] * p[1] + tv[2] * p[2]) * inv;
        if (u < 0 || u > 1) continue;
        const q = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]];
        const v = (dx * q[0] + dy * q[1] + dz * q[2]) * inv;
        if (v < 0 || u + v > 1) continue;
        const dist = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
        if (dist > 1e-9 && dist < best) { best = dist; tri = t; }
    }
    return tri < 0 ? null : { distance: best, triangle: tri };
}

test('the BVH finds the same nearest triangle as testing every triangle', () => {
    const mesh = hillGrid(40);
    const geometry = geometryOf(mesh);
    const tree = Bvh.forGeometry(geometry);
    assert.ok(tree && tree.triangleCount === mesh.indices.length / 3);
    assert.equal(Bvh.forGeometry(geometry), tree, 'cached per geometry');
    let seed = 99;
    const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    let hits = 0, misses = 0;
    for (let i = 0; i < 300; i++) {
        const ox = random() * 1.4 - 0.2, oz = random() * 1.4 - 0.2, oy = 2;
        // Mostly downward rays, some slanted.
        let dx = (random() - 0.5) * 0.6, dy = -1, dz = (random() - 0.5) * 0.6;
        const len = Math.hypot(dx, dy, dz); dx /= len; dy /= len; dz /= len;
        const expected = bruteForce(mesh, ox, oy, oz, dx, dy, dz);
        const actual = Bvh.raycastLocal(tree, geometry, ox, oy, oz, dx, dy, dz);
        if (!expected) { assert.equal(actual, null); misses++; continue; }
        assert.ok(actual, 'a hit is found');
        assert.ok(Math.abs(actual.distance - expected.distance) < 1e-6, `same distance (${actual.distance} vs ${expected.distance})`);
        hits++;
    }
    assert.ok(hits > 80 && misses > 5, `a real mix of hits and misses (${hits}/${misses})`);
    assert.equal(Bvh.build({ attributes: {} }), null);
});

test('the BVH honours a draw range and non-indexed geometry', () => {
    const mesh = hillGrid(6);
    const geometry = geometryOf(mesh);
    geometry.drawRange = { start: 0, count: 6 };   // two triangles only
    const tree = Bvh.build(geometry);
    assert.equal(tree.triangleCount, 2);
    // Non-indexed: expand.
    const expanded = new Float32Array(mesh.indices.length * 3);
    for (let i = 0; i < mesh.indices.length; i++) for (let k = 0; k < 3; k++) expanded[i * 3 + k] = mesh.positions[mesh.indices[i] * 3 + k];
    const flat = { attributes: { position: { array: expanded, count: mesh.indices.length } }, index: null, drawRange: { start: 0, count: Infinity } };
    const flatTree = Bvh.build(flat);
    assert.equal(flatTree.triangleCount, mesh.indices.length / 3);
    const hit = Bvh.raycastLocal(flatTree, flat, 0.5, 2, 0.5, 0, -1, 0);
    assert.ok(hit && hit.y > 0.2 && hit.y < 0.35, 'lands on top of the hill');
});
