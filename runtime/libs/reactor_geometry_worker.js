// Runtime-only index levels. Original assets and vertex attributes stay intact.
import { MeshoptSimplifier } from './meshopt_simplifier.js';

self.onmessage = async ({ data: job }) => {
    try {
        await MeshoptSimplifier.ready;
        if (!MeshoptSimplifier.supported) throw new Error('Geometry simplifier unavailable');
        const scale = MeshoptSimplifier.getScale(job.positions, 3);
        const levels = [];
        for (const error of [0.00025, 0.0005, 0.001, 0.002, 0.004, 0.008]) {
            const [indices, achieved] = MeshoptSimplifier.simplifyWithAttributes(
                job.indices, job.positions, 3, job.attributes, job.stride, job.weights,
                null, Math.floor(job.indices.length * 0.02 / 3) * 3, error, ['LockBorder']);
            if (indices.length < job.indices.length * 0.9) levels.push({ indices, error: achieved * scale });
        }
        self.postMessage({ id: job.id, levels }, levels.map(level => level.indices.buffer));
    } catch (error) {
        self.postMessage({ id: job.id, error: String(error?.message || error) });
    }
};
