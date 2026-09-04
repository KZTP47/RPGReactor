#!/usr/bin/env node
/**
 * plugin-compat-probe - which of the audit's findings are really missing.
 *
 *   node editor/build-scripts/plugin-compat-audit.cjs <project> --mv <mv js dir> --json audit.json
 *   node editor/build-scripts/plugin-compat-probe.cjs <project> audit.json [--port 9399] [--kinds mv-gap,alias,static]
 *
 * The audit is static and cannot see a method the compatibility layer
 * installs from a loop or a plugin defines through a helper. This boots the
 * project under the bundled NW.js with remote debugging, waits until the
 * database and every plugin have loaded, evaluates `typeof` for each
 * finding on the live prototypes, and prints the ones that are undefined
 * there. Those are the gaps to fill. A game window appears for a few
 * seconds; the run uses its own throwaway profile and never saves.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const project = positional[0] && path.resolve(positional[0]);
const auditFile = positional[1] && path.resolve(positional[1]);
if (!project || !auditFile) {
    console.error('usage: plugin-compat-probe.cjs <project dir> <audit.json> [--port N] [--kinds a,b]');
    process.exit(2);
}
const port = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 9399);
const kinds = new Set((args.includes('--kinds') ? args[args.indexOf('--kinds') + 1] : 'mv-gap,alias,static').split(','));
const repoRoot = path.resolve(__dirname, '..', '..');
const nw = [['nwjs-linux', 'nw'], ['nwjs-win', 'nw.exe'], ['nwjs-mac', 'nwjs.app', 'Contents', 'MacOS', 'nwjs']]
    .map(parts => path.join(repoRoot, ...parts)).find(p => fs.existsSync(p));
if (!nw) { console.error('no bundled NW.js runtime found beside the repo'); process.exit(2); }

const audit = JSON.parse(fs.readFileSync(auditFile, 'utf8'));
const subjects = [...new Set(audit.findings.filter(f => kinds.has(f.kind)).map(f => f.subject))];
const expression = 'JSON.stringify([' + subjects.map(s => {
    const [cls, name] = s.includes('#') ? s.split('#') : s.split('.');
    const target = s.includes('#') ? `${cls}.prototype` : cls;
    return `[${JSON.stringify(s)}, (function(){ try { return typeof ${target}[${JSON.stringify(name)}]; } catch (e) { return "no class"; } })()]`;
}).join(',') + '])';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-probe-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const child = spawn(nw, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '.', 'test'], { cwd: project, stdio: 'ignore' });
let ws; let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise(resolve => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
const finish = code => { try { child.kill(); } catch (e) {} try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} process.exit(code); };

(async () => {
    for (let i = 0; i < 60 && !ws; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
            const page = list.find(t => t.type === 'page' && /index\.html/.test(t.url));
            if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
        } catch (e) { /* not up yet */ }
        if (!ws) await sleep(500);
    }
    if (!ws) { console.error('the game never exposed a debugging target'); finish(2); }
    await new Promise(r => { ws.onopen = r; });
    ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
        ready = await evaluate('(function(){ try { return typeof DataManager !== "undefined" && DataManager.isDatabaseLoaded() && !!SceneManager._scene; } catch (e) { return false; } })()') === true;
        if (!ready) await sleep(500);
    }
    if (!ready) { console.error('the game did not finish loading its database'); finish(2); }
    const raw = await evaluate(expression);
    const results = raw ? JSON.parse(raw) : [];
    const missing = results.filter(r => r[1] === 'undefined' || r[1] === 'no class');
    console.log(`plugin-compat-probe: ${path.basename(project)} - ${results.length} findings checked live, ${missing.length} really missing`);
    for (const m of missing) {
        const finding = audit.findings.find(f => f.subject === m[0]);
        console.log(`  ${m[0]}  (${m[1]})  ${finding ? `${finding.plugin}:${finding.line}` : ''}`);
    }
    finish(0);
})().catch(e => { console.error('probe failed:', e.message); finish(1); });
