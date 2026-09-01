const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const editorRoot = path.resolve(__dirname, '..');
const VCO = require(path.join(editorRoot, 'src', 'utils', 'VertexCacheOrder.js'));

/** A grid of quads, emitted in the worst order: every triangle far from the last. */
function scatteredGrid(size) {
    const tris = [];
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const a = y * (size + 1) + x, b = a + 1, c = a + size + 1, d = c + 1;
            tris.push([a, b, c], [b, d, c]);
        }
    }
    // Shuffled deterministically, so neighbouring triangles are nowhere
    // near each other in the buffer — the shape of an AI or scan export.
    let seed = 12345;
    const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = tris.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        const t = tris[i]; tris[i] = tris[j]; tris[j] = t;
    }
    const out = [];
    for (const tri of tris) out.push(...tri);
    return { indices: Uint32Array.from(out), vertexCount: (size + 1) * (size + 1) };
}

function triangleKeys(indices) {
    const keys = new Map();
    for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i], b = indices[i + 1], c = indices[i + 2];
        const m = Math.min(a, b, c);
        const key = m === a ? `${a},${b},${c}` : m === b ? `${b},${c},${a}` : `${c},${a},${b}`;
        keys.set(key, (keys.get(key) || 0) + 1);
    }
    return keys;
}

test('tipsify keeps every triangle and its winding, and cuts the cache miss ratio', () => {
    const { indices, vertexCount } = scatteredGrid(60);
    const before = VCO.acmr(indices);
    const out = VCO.tipsify(indices, vertexCount);
    assert.equal(out.length, indices.length);
    assert.ok(out instanceof Uint32Array, 'same index type as the input');
    assert.deepEqual(triangleKeys(out), triangleKeys(indices), 'same triangles, same winding');
    const after = VCO.acmr(out);
    assert.ok(before > 1.5, 'the scattered order really was bad (' + before.toFixed(2) + ')');
    assert.ok(after < 0.9, 'the reordered mesh shades under one vertex per triangle (' + after.toFixed(2) + ')');
});

test('degenerate inputs come back unchanged', () => {
    assert.deepEqual(Array.from(VCO.tipsify(new Uint16Array(0), 10)), []);
    const single = Uint16Array.from([0, 1, 2]);
    assert.deepEqual(Array.from(VCO.tipsify(single, 3)), [0, 1, 2]);
    assert.equal(VCO.acmr(new Uint16Array(0)), 0);
    assert.equal(VCO.acmr(single), 3, 'one triangle of three cold vertices is three misses');
});

test('a 16-bit index buffer stays 16-bit', () => {
    const { indices, vertexCount } = scatteredGrid(20);
    const out = VCO.tipsify(Uint16Array.from(indices), vertexCount);
    assert.ok(out instanceof Uint16Array);
    assert.deepEqual(triangleKeys(out), triangleKeys(indices));
});
