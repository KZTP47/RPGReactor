#!/usr/bin/env node
'use strict';
/**
 * Generate distance levels for models already in a project.
 *
 *   node editor/build-scripts/model-lods.cjs <project-dir> [<model-folder> ...]
 *   node editor/build-scripts/model-lods.cjs template/Demo Map-Objects/RPGReactor-Computer-01
 *
 * With no model folders given, every GLB model under <project>/3d is done.
 * Writes `<name>.lod1.glb` / `<name>.lod2.glb` beside the source (geometry
 * only, at coarser weld grids — see GlbOptimizer.lods) and lists them in the
 * model's model.json under `lods`, keeping every other key. Skinned or
 * animated models and models under the triangle floor get no levels; an
 * existing level set is replaced. Pass --dry-run to only report.
 */
const fs = require('node:fs');
const path = require('node:path');
const Optimizer = require(path.join(__dirname, '..', 'src', 'utils', 'GlbOptimizer.js'));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const positional = args.filter(a => !a.startsWith('--'));
if (!positional.length) {
    console.error('usage: model-lods.cjs <project-dir> [<model-folder> ...] [--dry-run]');
    process.exit(2);
}
const projectRoot = path.resolve(positional[0]);
const modelsRoot = path.join(projectRoot, '3d');

function findModelFolders(dir, out) {
    if (!fs.existsSync(dir)) return out;
    const source = path.join(dir, 'source');
    if (fs.existsSync(source) && fs.statSync(source).isDirectory()) {
        out.push(dir);
        return out;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== 'textures') findModelFolders(path.join(dir, entry.name), out);
    }
    return out;
}

async function main() {
    const folders = positional.length > 1
        ? positional.slice(1).map(name => path.join(modelsRoot, name))
        : findModelFolders(modelsRoot, []);
    for (const folder of folders) {
        const source = path.join(folder, 'source');
        if (!fs.existsSync(source)) { console.log(`skip ${path.relative(projectRoot, folder)}: no source/`); continue; }
        const glb = fs.readdirSync(source).find(f => /\.glb$/i.test(f) && !/\.lod\d+\.glb$/i.test(f));
        if (!glb) { console.log(`skip ${path.relative(projectRoot, folder)}: no GLB`); continue; }
        const bytes = new Uint8Array(fs.readFileSync(path.join(source, glb)));
        const started = Date.now();
        const levels = await Optimizer.lods(bytes);
        const stem = glb.replace(/\.glb$/i, '');
        const names = levels.map(level => `${stem}.${level.suffix}.glb`);
        const sidecarPath = path.join(folder, 'model.json');
        let sidecar = {};
        if (fs.existsSync(sidecarPath)) {
            try { sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) || {}; } catch (error) {
                console.log(`skip ${path.relative(projectRoot, folder)}: model.json unreadable (${error.message})`);
                continue;
            }
        }
        const report = levels.map(level => `${level.suffix} ${level.triangles} tris ${(level.bytes.length / 1048576).toFixed(1)}MB`).join(', ');
        console.log(`${path.relative(projectRoot, folder)}: ${glb} -> ${levels.length ? report : 'no levels'} (${Date.now() - started} ms)`);
        if (dryRun) continue;
        // Old levels go, whatever they were called.
        for (const f of fs.readdirSync(source)) {
            if (/\.lod\d+\.glb$/i.test(f) && !names.includes(f)) fs.unlinkSync(path.join(source, f));
        }
        levels.forEach((level, i) => fs.writeFileSync(path.join(source, names[i]), level.bytes));
        if (names.length) sidecar.lods = names; else delete sidecar.lods;
        fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2) + '\n');
    }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
