/**
 * VertexCacheOrder - reorder a triangle list for the GPU's post-transform
 * vertex cache.
 *
 * A GPU shades each vertex once per cache miss, and a mesh exported in the
 * order a modelling tool happened to keep its faces (Meshy, photogrammetry,
 * most AI exporters) misses two to three times per triangle. Tipsify
 * (Sander, Nehab, Barczak 2007) walks the mesh in cache-friendly fans and
 * gets the same mesh to well under one miss per triangle, which shaves the
 * vertex work of a heavy model by half or better and changes no pixel.
 *
 * Lossless: the same triangles, the same winding, a different order. Runs
 * on plain arrays so the import optimizer and node tests share it.
 */
(function(root) {
    'use strict';

    /**
     * Average cache miss ratio (misses per triangle) for a FIFO cache of
     * `cacheSize` entries. 3.0 is the worst possible; ~0.6-0.7 is excellent.
     */
    function acmr(indices, cacheSize = 32) {
        const count = indices.length / 3;
        if (!count) return 0;
        const cache = new Int32Array(cacheSize).fill(-1);
        let head = 0;
        let misses = 0;
        for (let i = 0; i < indices.length; i++) {
            const v = indices[i];
            let hit = false;
            for (let c = 0; c < cacheSize; c++) {
                if (cache[c] === v) { hit = true; break; }
            }
            if (hit) continue;
            misses++;
            cache[head] = v;
            head = (head + 1) % cacheSize;
        }
        return misses / count;
    }

    /**
     * Tipsify. `indices` is a triangle list; returns a new typed array of the
     * same kind and length. `vertexCount` bounds the index values;
     * `cacheSize` is the target cache (the paper's default of ~24-32 suits
     * modern GPUs; the score is the same shape either way).
     */
    function tipsify(indices, vertexCount, cacheSize = 32) {
        const triangleCount = (indices.length / 3) | 0;
        if (!triangleCount || !(vertexCount > 0)) return indices.slice();

        // Adjacency: for every vertex, the triangles that use it.
        const valence = new Uint32Array(vertexCount + 1);
        for (let i = 0; i < triangleCount * 3; i++) valence[indices[i] + 1]++;
        for (let v = 0; v < vertexCount; v++) valence[v + 1] += valence[v];
        const offsets = valence;                       // prefix sums: offsets[v]..offsets[v+1]
        const adjacency = new Uint32Array(triangleCount * 3);
        const fill = new Uint32Array(vertexCount);
        for (let t = 0; t < triangleCount; t++) {
            for (let k = 0; k < 3; k++) {
                const v = indices[t * 3 + k];
                adjacency[offsets[v] + fill[v]++] = t;
            }
        }

        const liveTriangles = new Uint32Array(vertexCount);
        for (let v = 0; v < vertexCount; v++) liveTriangles[v] = offsets[v + 1] - offsets[v];
        const cacheTime = new Int32Array(vertexCount).fill(0);   // 0 = not in cache
        const emitted = new Uint8Array(triangleCount);
        const output = new (indices.constructor)(indices.length);
        let outputAt = 0;

        const deadEndStack = [];
        let time = cacheSize + 1;
        let cursor = 0;      // next never-visited vertex to try
        let fanning = 0;     // the vertex whose fan is being emitted
        const candidates = [];

        const nextVertex = () => {
            // Best candidate from the last fan: the one whose still-live
            // triangles fit in the cache while it stays warm.
            let best = -1;
            let bestPriority = -1;
            for (let i = 0; i < candidates.length; i++) {
                const v = candidates[i];
                if (liveTriangles[v] === 0) continue;
                let priority = 0;
                if (cacheTime[v] > 0 && time - cacheTime[v] + 2 * liveTriangles[v] <= cacheSize) {
                    priority = time - cacheTime[v];
                }
                if (priority > bestPriority) { bestPriority = priority; best = v; }
            }
            if (best >= 0) return best;
            // Skip back through recently finished vertices for one with
            // live triangles, before starting a new fan from scratch.
            while (deadEndStack.length) {
                const v = deadEndStack.pop();
                if (liveTriangles[v] > 0) return v;
            }
            while (cursor < vertexCount) {
                if (liveTriangles[cursor] > 0) return cursor;
                cursor++;
            }
            return -1;
        };

        fanning = nextVertex();
        while (fanning >= 0) {
            candidates.length = 0;
            for (let a = offsets[fanning]; a < offsets[fanning + 1]; a++) {
                const t = adjacency[a];
                if (emitted[t]) continue;
                emitted[t] = 1;
                for (let k = 0; k < 3; k++) {
                    const v = indices[t * 3 + k];
                    output[outputAt++] = v;
                    deadEndStack.push(v);
                    candidates.push(v);
                    liveTriangles[v]--;
                    if (time - cacheTime[v] > cacheSize || cacheTime[v] === 0) {
                        cacheTime[v] = time;
                        time++;
                    }
                }
            }
            fanning = nextVertex();
        }
        return output;
    }

    const VertexCacheOrder = { tipsify, acmr };
    root.RRVertexCacheOrder = VertexCacheOrder;
    if (typeof module !== 'undefined' && module.exports) module.exports = VertexCacheOrder;
})(typeof globalThis !== 'undefined' ? globalThis : window);
