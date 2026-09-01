/**
 * RRGlbOptimizer - shrink a GLB at import time without changing how it looks.
 *
 * AI-generated and photogrammetry models routinely ship data the runtime never
 * reads or reads at far more precision than a screen can show:
 *
 *   - TANGENT streams (VEC4 float32, ~25MB on a 3M-triangle export). The
 *     runtime's GLB reader never binds them; three.js shades normal maps from
 *     screen-space derivatives instead. Dropping them is free.
 *   - float32 skin weights. 16-bit normalized weights give 65,535 steps per
 *     bone influence - far below any visible threshold - at half the bytes.
 *     The runtime reader already normalizes integer weights.
 *   - Oversized textures. An 8K color map on a prop that covers 300px of
 *     screen decodes to the same pixels as a 2K one.
 *   - Duplicate vertices. Exports split vertices per-face for flat shading or
 *     UV islands; welding the coincident ones (position, UV and normal all
 *     agreeing) reindexes the same triangles over far fewer vertices.
 *
 * Everything runs on plain DataView/Uint8Array so the module works in the
 * editor page and under node tests alike. Texture re-encoding needs a canvas,
 * so it is injected: pass `encodeImage` (see `canvasEncoder`) or textures are
 * left alone.
 *
 * Structural invariant: bufferView and accessor INDICES are preserved - data
 * and definitions are substituted in place - except in the tangent-drop pass,
 * which garbage-collects and remaps every reference (primitives, morph
 * targets, animation samplers, skin bind matrices, images). Animations and
 * skins therefore survive untouched by construction everywhere else.
 */
(function(root) {
    'use strict';

    const COMPONENT_ARRAYS = {
        5120: Int8Array, 5121: Uint8Array, 5122: Int16Array,
        5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array
    };
    const TYPE_COMPONENTS = {
        SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16
    };

    /** Import-dialog presets. `meshCells` is the cluster grid across the model's largest axis (0 = leave geometry alone). */
    const PRESETS = {
        optimize: { textureSize: 2048, textureQuality: 0.85, dropTangents: true, quantizeWeights: true, meshCells: 1600, cacheOrder: true },
        aggressive: { textureSize: 2048, textureQuality: 0.85, dropTangents: true, quantizeWeights: true, meshCells: 700, cacheOrder: true }
    };

    /**
     * Distance levels generated beside an imported model: geometry-only GLBs
     * at coarser weld grids, swapped in by the runtime as a model recedes.
     * Measured on a 1.9M-triangle prop: 300 cells keeps a quarter of the
     * triangles, 120 about a twentieth. Skipped below `minTriangles`, where
     * the full mesh is already cheap.
     */
    const LOD_LEVELS = [
        { suffix: 'lod1', ratio: 0.25, meshCells: 300 },
        { suffix: 'lod2', ratio: 0.05, meshCells: 120 }
    ];
    const LOD_MIN_TRIANGLES = 20000;

    function vertexCacheOrder() {
        if (root.RRVertexCacheOrder) return root.RRVertexCacheOrder;
        if (typeof require === 'function') {
            try { return require('./VertexCacheOrder.js'); } catch (error) { return null; }
        }
        return null;
    }

    function quadricDecimator() {
        if (root.RRQuadricDecimator) return root.RRQuadricDecimator;
        if (typeof require === 'function') {
            try { return require('./QuadricDecimator.js'); } catch (error) { return null; }
        }
        return null;
    }

    function parseGlb(bytes) {
        const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        if (data.length < 20) return null;
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        if (view.getUint32(0, true) !== 0x46546C67) return null;
        const jsonLength = view.getUint32(12, true);
        if (view.getUint32(16, true) !== 0x4E4F534A) return null;
        let json;
        try {
            json = JSON.parse(new TextDecoder().decode(data.subarray(20, 20 + jsonLength)));
        } catch (error) {
            return null;
        }
        let bin = new Uint8Array(0);
        const binHeader = 20 + jsonLength;
        if (data.length >= binHeader + 8 && view.getUint32(binHeader + 4, true) === 0x004E4942) {
            const binLength = view.getUint32(binHeader, true);
            bin = data.subarray(binHeader + 8, binHeader + 8 + binLength);
        }
        return { json, bin };
    }

    function accessorByteLength(accessor) {
        const comps = TYPE_COMPONENTS[accessor.type] || 0;
        const Ctor = COMPONENT_ARRAYS[accessor.componentType];
        return Ctor ? accessor.count * comps * Ctor.BYTES_PER_ELEMENT : 0;
    }

    function imageDimensions(data, mimeType) {
        try {
            const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
            if (mimeType === 'image/png' && data.length > 26) {
                return { width: view.getUint32(16), height: view.getUint32(20), hasAlpha: data[25] === 4 || data[25] === 6 };
            }
            if (mimeType === 'image/jpeg') {
                let at = 2;
                while (at < data.length - 9) {
                    if (data[at] !== 0xFF) { at++; continue; }
                    const marker = data[at + 1];
                    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
                        return { width: view.getUint16(at + 7), height: view.getUint16(at + 5), hasAlpha: false };
                    }
                    at += 2 + view.getUint16(at + 2);
                }
            }
        } catch (error) {
            // Unreadable header: report no dimensions rather than fail the import.
        }
        return { width: 0, height: 0, hasAlpha: false };
    }

    function imageData(json, bin, image) {
        if (image.bufferView == null) return null;
        const view = json.bufferViews[image.bufferView];
        return bin.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
    }

    /** What is on the table, for the import dialog. Null when the bytes are not a GLB this module can read. */
    function analyze(bytes) {
        const parsed = parseGlb(bytes);
        if (!parsed) return null;
        const { json, bin } = parsed;
        if (Array.isArray(json.extensionsRequired) && json.extensionsRequired.length) return null;
        if ((json.accessors || []).some(a => a.sparse)) return null;
        const result = {
            bytes: bytes.length,
            images: [],
            tangentBytes: 0,
            floatWeightBytes: 0,
            triangles: 0,
            vertices: 0,
            animated: (json.animations || []).length > 0
        };
        for (const image of json.images || []) {
            const data = imageData(json, bin, image);
            if (!data) continue;
            const dims = imageDimensions(data, image.mimeType);
            result.images.push({ mimeType: image.mimeType, bytes: data.length, width: dims.width, height: dims.height, hasAlpha: dims.hasAlpha });
        }
        const counted = new Set();
        const tally = index => {
            if (index == null || counted.has(index)) return 0;
            counted.add(index);
            return accessorByteLength(json.accessors[index]);
        };
        for (const mesh of json.meshes || []) {
            for (const prim of mesh.primitives || []) {
                const attrs = prim.attributes || {};
                result.tangentBytes += tally(attrs.TANGENT);
                const weights = attrs.WEIGHTS_0 != null ? json.accessors[attrs.WEIGHTS_0] : null;
                if (weights && weights.componentType === 5126) result.floatWeightBytes += tally(attrs.WEIGHTS_0);
                if (attrs.POSITION != null) result.vertices += json.accessors[attrs.POSITION].count;
                result.triangles += Math.floor((prim.indices != null
                    ? json.accessors[prim.indices].count
                    : (attrs.POSITION != null ? json.accessors[attrs.POSITION].count : 0)) / 3);
                for (const target of prim.targets || []) {
                    result.tangentBytes += tally(target.TANGENT);
                }
            }
        }
        return result;
    }

    /** Typed-array view over an accessor's current data (replacement buffer if one is staged, the original bin otherwise). */
    function accessorArray(json, bin, replacements, index) {
        const accessor = json.accessors[index];
        const Ctor = COMPONENT_ARRAYS[accessor.componentType];
        const comps = TYPE_COMPONENTS[accessor.type];
        const staged = replacements.get(accessor.bufferView);
        if (staged) {
            return new Ctor(staged.buffer, staged.byteOffset + (accessor.byteOffset || 0), accessor.count * comps);
        }
        const view = json.bufferViews[accessor.bufferView];
        return new Ctor(bin.buffer, bin.byteOffset + (view.byteOffset || 0) + (accessor.byteOffset || 0), accessor.count * comps);
    }

    /** True when the accessor is the sole tenant of an unstrided bufferView, so its data can be swapped wholesale. */
    function ownsView(json, index) {
        const accessor = json.accessors[index];
        if ((accessor.byteOffset || 0) !== 0) return false;
        if (json.bufferViews[accessor.bufferView].byteStride) return false;
        return !json.accessors.some((other, at) => at !== index && other.bufferView === accessor.bufferView);
    }

    function substitute(json, replacements, index, array, type, componentType, extra) {
        const accessor = json.accessors[index];
        replacements.set(accessor.bufferView, new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
        accessor.count = array.length / TYPE_COMPONENTS[type];
        accessor.componentType = componentType;
        accessor.type = type;
        accessor.byteOffset = 0;
        delete accessor.min;
        delete accessor.max;
        Object.assign(accessor, extra || {});
    }

    /**
     * Weld a primitive's vertices by position cell. Verts merge only when their
     * UVs sit within about a cell of each other on the atlas AND their normals
     * agree, so texture seams keep their border and hair cards / thin shells
     * keep both faces. Skin joints and weights ride along verbatim from each
     * cluster's first vertex - never blended across different bone sets.
     */
    function clusterPrimitive(json, bin, replacements, prim, cells, notes) {
        const attrs = prim.attributes || {};
        const needed = ['POSITION', 'NORMAL', 'TEXCOORD_0'];
        if (prim.indices == null || needed.some(name => attrs[name] == null)) return;
        if (prim.mode != null && prim.mode !== 4) return;
        if (prim.targets && prim.targets.length) return;
        // Any attribute this pass does not rewrite (COLOR_0, TEXCOORD_1, a kept
        // TANGENT...) would keep the old vertex count and corrupt the mesh.
        const handled = ['POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0'];
        if (Object.keys(attrs).some(name => handled.indexOf(name) < 0)) {
            notes.push('extra vertex attributes present; geometry left alone');
            return;
        }
        const owned = Object.values(attrs).concat([prim.indices]);
        if (owned.some(index => !ownsView(json, index))) { notes.push('mesh attributes share buffer views; geometry left alone'); return; }

        const pos = accessorArray(json, bin, replacements, attrs.POSITION);
        const nor = accessorArray(json, bin, replacements, attrs.NORMAL);
        const uv = accessorArray(json, bin, replacements, attrs.TEXCOORD_0);
        const idx = accessorArray(json, bin, replacements, prim.indices);
        const joints = attrs.JOINTS_0 != null ? accessorArray(json, bin, replacements, attrs.JOINTS_0) : null;
        const weights = attrs.WEIGHTS_0 != null ? accessorArray(json, bin, replacements, attrs.WEIGHTS_0) : null;
        const count = json.accessors[attrs.POSITION].count;

        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < count; i++) {
            for (let k = 0; k < 3; k++) {
                const value = pos[i * 3 + k];
                if (value < min[k]) min[k] = value;
                if (value > max[k]) max[k] = value;
            }
        }
        const span = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-9);
        const cell = span / cells;
        const uvTolerance = 1.2 / cells;

        const buckets = new Map();
        const remap = new Uint32Array(count);
        let next = 0;
        const oPos = [], oNor = [], oUv = [], oJoints = [], oWeights = [], merged = [];
        for (let i = 0; i < count; i++) {
            const key = Math.round((pos[i * 3] - min[0]) / cell) + ':'
                + Math.round((pos[i * 3 + 1] - min[1]) / cell) + ':'
                + Math.round((pos[i * 3 + 2] - min[2]) / cell);
            let bucket = buckets.get(key);
            if (!bucket) { bucket = []; buckets.set(key, bucket); }
            let at = -1;
            for (const candidate of bucket) {
                if (Math.abs(uv[i * 2] - oUv[candidate * 2]) >= uvTolerance
                    || Math.abs(uv[i * 2 + 1] - oUv[candidate * 2 + 1]) >= uvTolerance) continue;
                const length = Math.hypot(oNor[candidate * 3], oNor[candidate * 3 + 1], oNor[candidate * 3 + 2]) || 1;
                const dot = (nor[i * 3] * oNor[candidate * 3]
                    + nor[i * 3 + 1] * oNor[candidate * 3 + 1]
                    + nor[i * 3 + 2] * oNor[candidate * 3 + 2]) / length;
                if (dot > 0.35) { at = candidate; break; }
            }
            if (at < 0) {
                at = next++;
                bucket.push(at);
                oPos.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
                oNor.push(nor[i * 3], nor[i * 3 + 1], nor[i * 3 + 2]);
                oUv.push(uv[i * 2], uv[i * 2 + 1]);
                if (joints) {
                    for (let k = 0; k < 4; k++) { oJoints.push(joints[i * 4 + k]); oWeights.push(weights[i * 4 + k]); }
                }
                merged.push(1);
            } else {
                const seen = merged[at]++;
                for (let k = 0; k < 3; k++) {
                    oPos[at * 3 + k] += (pos[i * 3 + k] - oPos[at * 3 + k]) / (seen + 1);
                    oNor[at * 3 + k] += (nor[i * 3 + k] - oNor[at * 3 + k]) / (seen + 1);
                }
            }
            remap[i] = at;
        }
        if (next >= count) return;
        for (let i = 0; i < next; i++) {
            const x = oNor[i * 3], y = oNor[i * 3 + 1], z = oNor[i * 3 + 2];
            const length = Math.hypot(x, y, z) || 1;
            oNor[i * 3] = x / length; oNor[i * 3 + 1] = y / length; oNor[i * 3 + 2] = z / length;
        }
        const oIdx = [];
        for (let at = 0; at < idx.length; at += 3) {
            const a = remap[idx[at]], b = remap[idx[at + 1]], c = remap[idx[at + 2]];
            if (a !== b && b !== c && a !== c) oIdx.push(a, b, c);
        }

        const posArray = new Float32Array(oPos);
        const newMin = [Infinity, Infinity, Infinity], newMax = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < next; i++) {
            for (let k = 0; k < 3; k++) {
                const value = posArray[i * 3 + k];
                if (value < newMin[k]) newMin[k] = value;
                if (value > newMax[k]) newMax[k] = value;
            }
        }
        substitute(json, replacements, attrs.POSITION, posArray, 'VEC3', 5126, { min: newMin, max: newMax });
        substitute(json, replacements, attrs.NORMAL, new Float32Array(oNor), 'VEC3', 5126);
        substitute(json, replacements, attrs.TEXCOORD_0, new Float32Array(oUv), 'VEC2', 5126);
        if (joints) {
            const JointsCtor = joints.constructor;
            const jointsType = json.accessors[attrs.JOINTS_0].componentType;
            substitute(json, replacements, attrs.JOINTS_0, JointsCtor.from(oJoints), 'VEC4', jointsType);
            const WeightsCtor = weights.constructor;
            const weightsAccessor = json.accessors[attrs.WEIGHTS_0];
            substitute(json, replacements, attrs.WEIGHTS_0, WeightsCtor.from(oWeights), 'VEC4',
                weightsAccessor.componentType, weightsAccessor.normalized ? { normalized: true } : {});
        }
        const IndexCtor = next < 65536 ? Uint16Array : Uint32Array;
        substitute(json, replacements, prim.indices, IndexCtor.from(oIdx), 'SCALAR', next < 65536 ? 5123 : 5125);
        notes.push(`mesh ${count} -> ${next} vertices, ${Math.floor(idx.length / 3)} -> ${Math.floor(oIdx.length / 3)} triangles`);
    }

    /** float32 skin weights -> 16-bit normalized, each vertex's four weights pinned to sum exactly 1. */
    function quantizeWeights(json, bin, replacements, notes) {
        const handled = new Set();
        for (const mesh of json.meshes || []) {
            for (const prim of mesh.primitives || []) {
                const index = prim.attributes && prim.attributes.WEIGHTS_0;
                if (index == null || handled.has(index)) continue;
                handled.add(index);
                const accessor = json.accessors[index];
                if (accessor.componentType !== 5126 || accessor.type !== 'VEC4') continue;
                if (!ownsView(json, index)) { notes.push('skin weights share a buffer view; left as float'); continue; }
                const floats = accessorArray(json, bin, replacements, index);
                const packed = new Uint16Array(accessor.count * 4);
                for (let i = 0; i < accessor.count; i++) {
                    let sum = 0, top = 0;
                    for (let k = 0; k < 4; k++) {
                        const value = Math.min(65535, Math.max(0, Math.round(floats[i * 4 + k] * 65535)));
                        packed[i * 4 + k] = value;
                        sum += value;
                        if (value > packed[i * 4 + top]) top = k;
                    }
                    if (sum > 0) packed[i * 4 + top] += 65535 - sum;
                }
                substitute(json, replacements, index, packed, 'VEC4', 5123, { normalized: true });
                notes.push(`skin weights float32 -> uint16 (${(accessor.count * 8 / 1048576).toFixed(1)}MB saved)`);
            }
        }
    }

    /**
     * Remove TANGENT attributes, then garbage-collect: accessors nothing
     * references any more are dropped and every accessor index in the document
     * (primitives, morph targets, animation samplers, skin bind matrices) is
     * remapped, as are bufferView indices (accessors and images).
     */
    function dropTangents(json, replacements, notes) {
        let removed = 0;
        for (const mesh of json.meshes || []) {
            for (const prim of mesh.primitives || []) {
                if (prim.attributes && prim.attributes.TANGENT != null) { delete prim.attributes.TANGENT; removed++; }
                for (const target of prim.targets || []) {
                    if (target.TANGENT != null) { delete target.TANGENT; removed++; }
                }
            }
        }
        if (!removed) return;
        collectGarbage(json, replacements);
        notes.push('dropped unused tangent data');
    }

    /**
     * Drop every accessor nothing references and every bufferView nothing
     * uses, remapping all references (primitives, morph targets, animation
     * samplers, skin bind matrices, images) and any staged replacements.
     */
    function collectGarbage(json, replacements) {
        const usedAccessors = new Set();
        const eachAccessorRef = visit => {
            for (const mesh of json.meshes || []) {
                for (const prim of mesh.primitives || []) {
                    for (const name of Object.keys(prim.attributes || {})) prim.attributes[name] = visit(prim.attributes[name]);
                    if (prim.indices != null) prim.indices = visit(prim.indices);
                    for (const target of prim.targets || []) {
                        for (const name of Object.keys(target)) target[name] = visit(target[name]);
                    }
                }
            }
            for (const animation of json.animations || []) {
                for (const sampler of animation.samplers || []) {
                    sampler.input = visit(sampler.input);
                    sampler.output = visit(sampler.output);
                }
            }
            for (const skin of json.skins || []) {
                if (skin.inverseBindMatrices != null) skin.inverseBindMatrices = visit(skin.inverseBindMatrices);
            }
        };
        eachAccessorRef(index => { usedAccessors.add(index); return index; });
        const accessorRemap = new Map();
        json.accessors = (json.accessors || []).filter((accessor, index) => {
            if (!usedAccessors.has(index)) return false;
            accessorRemap.set(index, accessorRemap.size);
            return true;
        });
        eachAccessorRef(index => accessorRemap.get(index));

        const usedViews = new Set();
        for (const accessor of json.accessors) if (accessor.bufferView != null) usedViews.add(accessor.bufferView);
        for (const image of json.images || []) if (image.bufferView != null) usedViews.add(image.bufferView);
        const viewRemap = new Map();
        json.bufferViews = (json.bufferViews || []).filter((view, index) => {
            if (!usedViews.has(index)) return false;
            viewRemap.set(index, viewRemap.size);
            return true;
        });
        for (const [oldIndex, staged] of Array.from(replacements)) {
            replacements.delete(oldIndex);
            if (viewRemap.has(oldIndex)) replacements.set(viewRemap.get(oldIndex), staged);
        }
        for (const accessor of json.accessors) if (accessor.bufferView != null) accessor.bufferView = viewRemap.get(accessor.bufferView);
        for (const image of json.images || []) if (image.bufferView != null) image.bufferView = viewRemap.get(image.bufferView);
    }

    /**
     * Reorder every triangle list for the GPU's vertex cache (Tipsify, see
     * VertexCacheOrder.js). Lossless: the same triangles in a friendlier
     * order. An AI or scan export shades each vertex two to three times;
     * reordered it shades it well under once per triangle.
     */
    function reorderForCache(json, bin, replacements, notes) {
        const order = vertexCacheOrder();
        if (!order) return;
        let reordered = 0;
        const handled = new Set();
        for (const mesh of json.meshes || []) {
            for (const prim of mesh.primitives || []) {
                if (prim.indices == null || handled.has(prim.indices)) continue;
                if (prim.mode != null && prim.mode !== 4) continue;
                if (!prim.attributes || prim.attributes.POSITION == null) continue;
                if (!ownsView(json, prim.indices)) continue;
                handled.add(prim.indices);
                const indices = accessorArray(json, bin, replacements, prim.indices);
                if (indices.length < 3 * 64) continue;
                const vertexCount = json.accessors[prim.attributes.POSITION].count;
                const before = order.acmr(indices);
                if (before < 0.75) continue;   // already well ordered
                const sorted = order.tipsify(indices, vertexCount);
                const accessor = json.accessors[prim.indices];
                substitute(json, replacements, prim.indices, sorted, 'SCALAR', accessor.componentType);
                reordered++;
            }
        }
        if (reordered) notes.push(`reordered ${reordered} triangle list${reordered === 1 ? '' : 's'} for the vertex cache`);
    }

    /**
     * Collapse a primitive's edges under the quadric error metric down to
     * `target` triangles (see QuadricDecimator.js). Same guards as the weld.
     * Returns true when the geometry was rewritten.
     */
    function decimatePrimitive(json, bin, replacements, prim, target, notes) {
        const decimator = quadricDecimator();
        if (!decimator) return false;
        const attrs = prim.attributes || {};
        if (prim.indices == null || attrs.POSITION == null) return false;
        if (prim.mode != null && prim.mode !== 4) return false;
        if (prim.targets && prim.targets.length) return false;
        const handled = ['POSITION', 'NORMAL', 'TEXCOORD_0'];
        if (Object.keys(attrs).some(name => handled.indexOf(name) < 0)) {
            notes.push('extra vertex attributes present; geometry left alone');
            return false;
        }
        const owned = Object.values(attrs).concat([prim.indices]);
        if (owned.some(index => !ownsView(json, index))) { notes.push('mesh attributes share buffer views; geometry left alone'); return false; }
        const positions = accessorArray(json, bin, replacements, attrs.POSITION);
        const normals = attrs.NORMAL != null ? accessorArray(json, bin, replacements, attrs.NORMAL) : null;
        const uvs = attrs.TEXCOORD_0 != null ? accessorArray(json, bin, replacements, attrs.TEXCOORD_0) : null;
        const indices = accessorArray(json, bin, replacements, prim.indices);
        const before = Math.floor(indices.length / 3);
        if (before <= target) return false;
        const result = decimator.decimate({ positions, normals, uvs, indices }, target);
        if (!result || !result.triangles || result.triangles >= before) return false;
        substitute(json, replacements, attrs.POSITION, result.positions, 'VEC3', 5126);
        if (normals && result.normals) substitute(json, replacements, attrs.NORMAL, result.normals, 'VEC3', 5126);
        if (uvs && result.uvs) substitute(json, replacements, attrs.TEXCOORD_0, result.uvs, 'VEC2', 5126);
        substitute(json, replacements, prim.indices, result.indices, 'SCALAR', result.indices instanceof Uint16Array ? 5123 : 5125);
        // Bounds are required on POSITION; the compacted set has new ones.
        const accessor = json.accessors[attrs.POSITION];
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < result.positions.length; i += 3) {
            for (let k = 0; k < 3; k++) {
                if (result.positions[i + k] < min[k]) min[k] = result.positions[i + k];
                if (result.positions[i + k] > max[k]) max[k] = result.positions[i + k];
            }
        }
        accessor.min = min;
        accessor.max = max;
        notes.push(`mesh ${before} -> ${result.triangles} triangles (quadric collapse)`);
        return true;
    }

    /**
     * Geometry-only copies at reduced detail, for distance swapping. Each
     * level keeps the node hierarchy, mesh order and primitive count of the
     * source, so the runtime can pair meshes by position and swap only
     * their geometry — textures, materials and recentring stay the base
     * model's. Detail is reduced by quadric edge collapse to a `ratio` of
     * the source's triangles (each level built from the one above it, which
     * is far quicker than from the source), falling back to the weld grid
     * (`meshCells`) for a primitive the collapse cannot take. Skinned or
     * animated models get no levels (their skeleton is the cost, not their
     * triangles), nor do models already under `LOD_MIN_TRIANGLES`. Returns
     * [{ suffix, ratio, meshCells, triangles, bytes }].
     */
    async function lods(bytes, options) {
        const settings = options || {};
        const levels = settings.levels || LOD_LEVELS;
        const probe = parseGlb(bytes);
        if (!probe) return [];
        if (Array.isArray(probe.json.extensionsRequired) && probe.json.extensionsRequired.length) return [];
        if ((probe.json.accessors || []).some(a => a.sparse)) return [];
        if ((probe.json.animations || []).length || (probe.json.skins || []).length) return [];
        const minTriangles = settings.minTriangles === undefined ? LOD_MIN_TRIANGLES : settings.minTriangles;
        const triangleCount = json => {
            let total = 0;
            for (const mesh of json.meshes || []) {
                for (const prim of mesh.primitives || []) {
                    if (prim.indices != null) total += json.accessors[prim.indices].count / 3;
                    else if (prim.attributes && prim.attributes.POSITION != null) total += json.accessors[prim.attributes.POSITION].count / 3;
                }
            }
            return Math.floor(total);
        };
        const baseTriangles = triangleCount(probe.json);
        if (baseTriangles < minTriangles) return [];
        const out = [];
        let previous = baseTriangles;
        let current = bytes;
        for (const level of levels) {
            const { json, bin } = parseGlb(current);
            const replacements = new Map();
            const notes = [];
            dropTangents(json, replacements, notes);
            // Each primitive's share of the level's triangle budget.
            const currentTriangles = triangleCount(json);
            const budget = level.ratio > 0 ? Math.max(4, Math.round(baseTriangles * level.ratio)) : 0;
            for (const mesh of json.meshes || []) {
                for (const prim of mesh.primitives || []) {
                    let done = false;
                    if (budget > 0 && prim.indices != null) {
                        const share = json.accessors[prim.indices].count / 3 / Math.max(1, currentTriangles);
                        done = decimatePrimitive(json, bin, replacements, prim, Math.max(4, Math.round(budget * share)), notes);
                    }
                    if (!done && level.meshCells > 0) clusterPrimitive(json, bin, replacements, prim, level.meshCells, notes);
                    delete prim.material;
                }
            }
            // Geometry only: the base model's textures and materials serve.
            delete json.images;
            delete json.textures;
            delete json.materials;
            delete json.samplers;
            delete json.animations;
            delete json.skins;
            collectGarbage(json, replacements);
            reorderForCache(json, bin, replacements, notes);
            const triangles = triangleCount(json);
            const built = rebuildGlb(json, bin, replacements);
            // A level that barely reduces the one above it is not worth a file.
            if (triangles > previous * 0.7) continue;
            previous = triangles;
            current = built;
            out.push({ suffix: level.suffix, ratio: level.ratio, meshCells: level.meshCells, triangles, bytes: built });
        }
        return out;
    }

    function rebuildGlb(json, bin, replacements) {
        const views = json.bufferViews || [];
        const parts = [];
        let offset = 0;
        for (let i = 0; i < views.length; i++) {
            const data = replacements.get(i)
                || bin.subarray(views[i].byteOffset || 0, (views[i].byteOffset || 0) + views[i].byteLength);
            const pad = (4 - (offset % 4)) % 4;
            if (pad) { parts.push(new Uint8Array(pad)); offset += pad; }
            const kept = { buffer: 0, byteOffset: offset, byteLength: data.length };
            if (views[i].byteStride && !replacements.has(i)) kept.byteStride = views[i].byteStride;
            if (views[i].target) kept.target = views[i].target;
            views[i] = kept;
            parts.push(data);
            offset += data.length;
        }
        json.buffers = [{ byteLength: offset }];
        let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
        const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
        if (jsonPad) {
            const padded = new Uint8Array(jsonBytes.length + jsonPad).fill(0x20);
            padded.set(jsonBytes);
            jsonBytes = padded;
        }
        const binPad = (4 - (offset % 4)) % 4;
        if (binPad) { parts.push(new Uint8Array(binPad)); offset += binPad; }
        const total = 12 + 8 + jsonBytes.length + 8 + offset;
        const out = new Uint8Array(total);
        const header = new DataView(out.buffer);
        header.setUint32(0, 0x46546C67, true);
        header.setUint32(4, 2, true);
        header.setUint32(8, total, true);
        header.setUint32(12, jsonBytes.length, true);
        header.setUint32(16, 0x4E4F534A, true);
        out.set(jsonBytes, 20);
        header.setUint32(20 + jsonBytes.length, offset, true);
        header.setUint32(24 + jsonBytes.length, 0x004E4942, true);
        let cursor = 28 + jsonBytes.length;
        for (const part of parts) { out.set(part, cursor); cursor += part.length; }
        return out;
    }

    /**
     * Apply the requested reductions and return new GLB bytes. Options match a
     * PRESETS entry plus an optional async `encodeImage(data, mimeType, maxSize,
     * quality, hasAlpha) -> {data, mimeType} | null` hook (null keeps the
     * original image). Returns { bytes, notes }; input bytes come back
     * unchanged when the file is not a GLB this module can safely rewrite.
     */
    async function optimize(bytes, options) {
        const settings = options || {};
        const parsed = parseGlb(bytes);
        if (!parsed) return { bytes, notes: ['not a readable GLB; imported unchanged'] };
        const { json, bin } = parsed;
        if (Array.isArray(json.extensionsRequired) && json.extensionsRequired.length) {
            return { bytes, notes: ['uses required glTF extensions; imported unchanged'] };
        }
        if ((json.accessors || []).some(a => a.sparse)) {
            return { bytes, notes: ['uses sparse accessors; imported unchanged'] };
        }
        const notes = [];
        const replacements = new Map();
        // Tangents go first so the vertex-weld pass sees a clean attribute set.
        if (settings.dropTangents) dropTangents(json, replacements, notes);
        if (settings.meshCells > 0) {
            for (const mesh of json.meshes || []) {
                for (const prim of mesh.primitives || []) {
                    clusterPrimitive(json, bin, replacements, prim, settings.meshCells, notes);
                }
            }
        }
        if (settings.quantizeWeights) quantizeWeights(json, bin, replacements, notes);
        if (settings.cacheOrder) reorderForCache(json, bin, replacements, notes);
        if (settings.textureSize > 0 && typeof settings.encodeImage === 'function') {
            for (const image of json.images || []) {
                const data = imageData(json, bin, image);
                if (!data || !ownsImageView(json, image)) continue;
                const dims = imageDimensions(data, image.mimeType);
                let encoded = null;
                try {
                    encoded = await settings.encodeImage(data, image.mimeType, settings.textureSize,
                        settings.textureQuality || 0.85, dims.hasAlpha);
                } catch (error) {
                    notes.push('texture re-encode failed; original kept');
                }
                if (encoded && encoded.data && encoded.data.length < data.length) {
                    replacements.set(image.bufferView, encoded.data instanceof Uint8Array
                        ? encoded.data : new Uint8Array(encoded.data));
                    image.mimeType = encoded.mimeType;
                    notes.push(`texture ${(data.length / 1048576).toFixed(1)}MB -> ${(encoded.data.length / 1048576).toFixed(1)}MB`);
                }
            }
        }
        if (!notes.length) return { bytes, notes: ['nothing to reduce'] };
        return { bytes: rebuildGlb(json, bin, replacements), notes };
    }

    /** True when no accessor also reads the image's bufferView (never the case in practice, but never corrupt one). */
    function ownsImageView(json, image) {
        if (image.bufferView == null) return false;
        return !(json.accessors || []).some(accessor => accessor.bufferView === image.bufferView);
    }

    /**
     * Browser-side encodeImage hook: decode, cap the long edge at maxSize, and
     * re-encode - JPEG for opaque images, PNG when the source carries alpha.
     * Returns null (keep the original) when nothing would shrink.
     */
    function canvasEncoder() {
        return async (data, mimeType, maxSize, quality, hasAlpha) => {
            const copy = new Uint8Array(data.length);
            copy.set(data);
            const blob = new Blob([copy.buffer], { type: mimeType });
            const url = URL.createObjectURL(blob);
            let element;
            try {
                element = await new Promise((accept, reject) => {
                    const img = new Image();
                    img.onload = () => accept(img);
                    img.onerror = () => reject(new Error('image decode failed'));
                    img.src = url;
                });
            } finally {
                URL.revokeObjectURL(url);
            }
            const scale = Math.min(1, maxSize / Math.max(element.width, element.height, 1));
            if (scale === 1 && mimeType === 'image/jpeg') return null;
            const width = Math.max(1, Math.round(element.width * scale));
            const height = Math.max(1, Math.round(element.height * scale));
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            canvas.getContext('2d').drawImage(element, 0, 0, width, height);
            const out = await new Promise(accept => canvas.toBlob(accept,
                hasAlpha ? 'image/png' : 'image/jpeg', quality));
            if (!out || out.size >= data.length) return null;
            return { data: new Uint8Array(await out.arrayBuffer()), mimeType: hasAlpha ? 'image/png' : 'image/jpeg' };
        };
    }

    /**
     * `lods` off the main thread when the page can spawn a worker: the
     * quadric collapse takes ten seconds and more on a million-triangle
     * model, which is not a freeze an import dialog should own. The worker
     * is assembled from the same three script files this page loaded
     * (found by their tags), so it runs exactly this code. Falls back to
     * the main thread when a worker cannot be built, and rejects only when
     * the work itself fails.
     */
    function lodsAsync(bytes, options) {
        const canWorker = typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined'
            && typeof document !== 'undefined' && typeof fetch === 'function';
        if (!canWorker) return lods(bytes, options);
        const names = ['VertexCacheOrder.js', 'QuadricDecimator.js', 'GlbOptimizer.js'];
        const urls = names.map(name => {
            const tag = Array.from(document.scripts).find(script => script.src && script.src.endsWith('/' + name));
            return tag ? tag.src : null;
        });
        if (urls.some(url => !url)) return lods(bytes, options);
        return Promise.all(urls.map(url => fetch(url).then(response => (response.ok ? response.text() : Promise.reject(new Error(url))))))
            .then(sources => new Promise((resolve, reject) => {
                const body = sources.join('\n;\n') + '\nself.onmessage = function(event) {\n'
                    + '\tRRGlbOptimizer.lods(event.data.bytes, event.data.options).then(function(levels) {\n'
                    + '\t\tself.postMessage({ levels: levels }, levels.map(function(level) { return level.bytes.buffer; }));\n'
                    + '\t}, function(error) { self.postMessage({ error: String(error && error.message || error) }); });\n'
                    + '};\n';
                const blobUrl = URL.createObjectURL(new Blob([body], { type: 'text/javascript' }));
                let worker;
                try { worker = new Worker(blobUrl); } catch (error) { URL.revokeObjectURL(blobUrl); reject(error); return; }
                const finish = () => { worker.terminate(); URL.revokeObjectURL(blobUrl); };
                worker.onmessage = event => {
                    finish();
                    if (event.data && event.data.error) reject(new Error(event.data.error));
                    else resolve((event.data && event.data.levels) || []);
                };
                worker.onerror = event => { finish(); reject(new Error(event.message || 'LOD worker failed')); };
                const copy = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes).slice();
                worker.postMessage({ bytes: copy, options: options || null }, [copy.buffer]);
            }))
            .catch(() => lods(bytes, options));
    }

    const api = { PRESETS, LOD_LEVELS, LOD_MIN_TRIANGLES, analyze, optimize, lods, lodsAsync, canvasEncoder, parseGlb };

    root.RRGlbOptimizer = api;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
