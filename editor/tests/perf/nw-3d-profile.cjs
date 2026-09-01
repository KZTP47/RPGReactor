#!/usr/bin/env node
'use strict';
// Drives the real NW.js editor over chromedriver, opens the Demo, enables the
// 3D map view, records rAF frame deltas + a CDP CPU profile. Never saves.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebDriverClient } = require("../smoke/webdriver-client.cjs");

const option = (name, fallback) => { const p = `--${name}=`; const a = process.argv.slice(2).find(v => v.startsWith(p)); return a ? a.slice(p.length) : fallback; };
const editorRoot = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(editorRoot, "..");
const demoRoot = path.resolve(option("project", path.join(repoRoot, "template", "Demo")));
const platformRoot = { win32: "nwjs-win", darwin: "nwjs-mac" }[process.platform] || "nwjs-linux";
const nwRoot = path.resolve(option("nw-root", process.env.NWJS_SDK_ROOT || path.join(repoRoot, platformRoot)));
const outDir = path.resolve(option("out", os.tmpdir()));
const SECONDS = Number(option("seconds", process.env.PERF_SECONDS || 6));
const MODE = option("mode", process.env.PERF_MODE || "3d");
const exe = process.platform === "win32" ? ".exe" : "";

async function cdp(driver, cmd, params = {}) {
    return driver.sessionRequest('POST', '/goog/cdp/execute', { cmd, params });
}

async function main() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-perf-'));
    const driver = new WebDriverClient(path.join(nwRoot, "chromedriver" + exe), { env: { ...process.env } });
    try {
        await driver.start();
        await driver.createSession({
            browserName: 'chrome',
            'goog:chromeOptions': {
                args: [`nwapp=${editorRoot}`, `user-data-dir=${path.join(tempRoot, 'profile')}`, 'no-first-run', 'no-default-browser-check',
                    // An occluded window stops getting animation frames, and the owner's editor is usually in front of this one.
                    'disable-backgrounding-occluded-windows', 'disable-renderer-backgrounding', 'disable-background-timer-throttling'],
            },
        });
        await driver.setScriptTimeout(120000);
        await driver.waitForScript('return Boolean(window.reactor?.projectController && window.reactor?.databaseManager);', [], { timeout: 90000, description: 'editor init' });

        const opened = await driver.executeAsync(`
            const projectPath = arguments[0]; const mode = arguments[1]; const done = arguments[arguments.length - 1];
            (async () => {
                const app = window.reactor; const c = app.projectController;
                const project = await app.projectManager.loadProject(projectPath);
                if (!project) throw new Error('loadProject failed');
                if (!c.acquireProjectLock(project.path)) throw new Error('lock failed');
                c.currentProject = project;
                await app.uiManager.showEditorUI();
                await c.populateProjectUI();
                await new Promise(r => setTimeout(r, 1500));
                const mapId = c.currentMapId ?? c.currentMap?.id ?? null;
                let enabled = null;
                if (mode === '3d') enabled = await app.mapEditor3D.setEnabled(true);
                await new Promise(r => setTimeout(r, 6000));
                const m3 = app.mapEditor3D;
                done({ name: project.name, mapId, enabled, m3enabled: m3?.enabled, lights: app.lightingManager?.lights?.length ?? null,
                       dpr: window.devicePixelRatio, size: [innerWidth, innerHeight], gl: (() => { try { const r = m3?.renderer; return r ? { w: r.domElement?.width, h: r.domElement?.height, pr: r.getPixelRatio?.() } : null; } catch (e) { return String(e); } })() });
            })().catch(e => done({ error: String(e?.stack || e) }));
        `, [demoRoot, MODE]);
        console.log('opened', JSON.stringify(opened));
        if (opened.error) throw new Error(opened.error);
        const setupPath = option("setup", process.env.PERF_SETUP);
        if (setupPath) {
            const setup = await driver.executeAsync(fs.readFileSync(setupPath, 'utf8'), []);
            console.log('setup', JSON.stringify(setup));
        }
        const shotPath = option("shot", process.env.PERF_SHOT);
        if (shotPath) {
            const shot = await driver.sessionRequest('GET', '/screenshot');
            fs.writeFileSync(shotPath, Buffer.from(shot, 'base64'));
            console.log('screenshot', shotPath);
        }

        const measure = () => driver.executeAsync(`
            const seconds = arguments[0]; const done = arguments[arguments.length - 1];
            const deltas = []; let last = performance.now(); const start = last; let longTasks = 0, longMs = 0;
            let po = null; try { po = new PerformanceObserver(l => { for (const e of l.getEntries()) { longTasks++; longMs += e.duration; } }); po.observe({ entryTypes: ['longtask'] }); } catch {}
            const m3 = window.reactor.mapEditor3D; let renderMs = 0, renders = 0; const orig = m3 && m3.render;
            if (orig) m3.render = function (now) { const t = performance.now(); const r = orig.apply(this, arguments); renderMs += performance.now() - t; renders++; return r; };
            const app2d = window.reactor.projectController?.app; let pixiMs = 0, pixiN = 0; const origR = app2d?.renderer?.render;
            if (origR) app2d.renderer.render = function () { const t = performance.now(); const r = origR.apply(this, arguments); pixiMs += performance.now() - t; pixiN++; return r; };
            const tick = now => { deltas.push(now - last); last = now; if (now - start < seconds * 1000) requestAnimationFrame(tick); else finish(); };
            const finish = () => {
                if (orig) m3.render = orig; if (origR) app2d.renderer.render = origR; if (po) po.disconnect();
                const sorted = [...deltas].sort((a, b) => a - b); const p = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
                const mem = performance.memory ? { usedMB: Math.round(performance.memory.usedJSHeapSize / 1048576) } : null;
                done({ frames: deltas.length, meanMs: +(deltas.reduce((a, b) => a + b, 0) / deltas.length).toFixed(2), p50: +p(.5).toFixed(1), p95: +p(.95).toFixed(1), p99: +p(.99).toFixed(1), max: +sorted[sorted.length - 1].toFixed(1),
                       over33: deltas.filter(d => d > 33).length, over50: deltas.filter(d => d > 50).length, longTasks, longMs: Math.round(longMs),
                       renders, renderAvgMs: renders ? +(renderMs / renders).toFixed(2) : null, pixiRenders: pixiN, pixiAvgMs: pixiN ? +(pixiMs / pixiN).toFixed(2) : null, mem });
            };
            requestAnimationFrame(tick);
        `, [SECONDS]);
        const expPath = option("experiment", process.env.PERF_EXPERIMENT);
        const EXP = expPath ? fs.readFileSync(expPath, 'utf8') : null;
        if (EXP) { console.log('baseline', JSON.stringify(await measure())); const r = await driver.executeAsync(EXP, []); console.log('experiment', JSON.stringify(r)); }
        await cdp(driver, 'Profiler.enable');
        await cdp(driver, 'Profiler.setSamplingInterval', { interval: 200 });
        await cdp(driver, 'Profiler.start');
        const frames = await measure();
        console.log('frames', JSON.stringify(frames));
        const { profile } = await cdp(driver, 'Profiler.stop');
        fs.writeFileSync(path.join(outDir, `profile-${MODE}.cpuprofile`), JSON.stringify(profile));

        // Aggregate self time per node
        const byId = new Map(profile.nodes.map(n => [n.id, n]));
        const self = new Map();
        const total = profile.timeDeltas.reduce((a, b) => a + b, 0);
        for (let i = 0; i < profile.samples.length; i++) {
            const n = byId.get(profile.samples[i]); const dt = profile.timeDeltas[i] || 0;
            const cf = n.callFrame; const key = `${cf.functionName || '(anon)'} ${path.basename(cf.url || '') || '(native)'}:${cf.lineNumber + 1}`;
            self.set(key, (self.get(key) || 0) + dt);
        }
        const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 45);
        console.log(`\nTop self-time (of ${(total / 1000).toFixed(0)} ms sampled):`);
        for (const [k, v] of rows) console.log(`${(100 * v / total).toFixed(1).padStart(5)}%  ${(v / 1000).toFixed(0).padStart(6)} ms  ${k}`);

        // Inclusive time per source file
        const parent = new Map(); for (const n of profile.nodes) for (const c of (n.children || [])) parent.set(c, n.id);
        const incl = new Map();
        for (let i = 0; i < profile.samples.length; i++) {
            const dt = profile.timeDeltas[i] || 0; const seen = new Set(); let id = profile.samples[i];
            while (id !== undefined) { const f = path.basename(byId.get(id).callFrame.url || '') || '(native)'; if (!seen.has(f)) { seen.add(f); incl.set(f, (incl.get(f) || 0) + dt); } id = parent.get(id); }
        }
        console.log('\nInclusive time per file:');
        for (const [k, v] of [...incl.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`${(100 * v / total).toFixed(1).padStart(5)}%  ${k}`);
    } finally {
        await driver.close();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}
main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
