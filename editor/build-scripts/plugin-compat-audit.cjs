#!/usr/bin/env node
/**
 * plugin-compat-audit - what a project's plugins expect that nothing defines.
 *
 *   node editor/build-scripts/plugin-compat-audit.cjs <project dir> [--mv <dir with rpg_*.js>] [--json out.json] [--all]
 *
 * With --mv pointing at a stock RPG Maker MV corescript (an MV project's js
 * folder), every finding whose name MV itself defined is marked `mv-gap`:
 * an MV API the compatibility layer does not supply yet. Those are the
 * findings worth acting on first; the rest are plugin-to-plugin, and a
 * definition found in a plugin that is not enabled is named as such.
 *
 * Reads the runtime (corescript + compatibility layers) and the project's
 * enabled plugins in load order, indexes every method, static and class
 * they define, and reports what the plugins reach for that no source
 * defines. Static, so it finds the crash before anyone walks into it:
 *
 *   alias      `X.prototype.y` or `Static.y` read by a plugin (usually to
 *              alias-and-wrap it) where nothing defines y. The wrapper then
 *              calls undefined the first time it runs.
 *   this-call  `this.y(` inside a method defined on X where no class on
 *              X's chain defines y. Attribution is by the enclosing
 *              `X.prototype.fn = function` header, so mixins and helpers
 *              copied at runtime show up here as noise; read it as
 *              "probable".
 *   pixi-super `PIXI.X.call(this` for a class the compat layer does not
 *              make callable.
 *   hook       an MV engine hook a plugin wraps that Reactor never calls.
 *
 * Plugins that are not in the load list are ignored, as the game ignores
 * them. Exit code is 0; this is a report, not a gate.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const projectDir = args.find(a => !a.startsWith('--'));
if (!projectDir) {
    console.error('usage: plugin-compat-audit.cjs <project dir> [--json out.json] [--all]');
    process.exit(2);
}
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const mvDir = args.includes('--mv') ? args[args.indexOf('--mv') + 1] : null;
const showAll = args.includes('--all');
const repoRoot = path.resolve(__dirname, '..', '..');
const runtimeDir = path.join(repoRoot, 'runtime');

// ---- sources ---------------------------------------------------------------

const runtimeFiles = fs.readdirSync(runtimeDir).filter(f => f.endsWith('.js')).map(f => path.join(runtimeDir, f))
    .concat([path.join(runtimeDir, 'libs', 'pixi_compat.js')].filter(f => fs.existsSync(f)));
const manifestPath = ['reactor_plugins.js', 'plugins.js'].map(f => path.join(projectDir, 'js', f)).find(f => fs.existsSync(f));
if (!manifestPath) { console.error('no plugin manifest under', projectDir); process.exit(2); }
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').match(/\$plugins\s*=\s*(\[[\s\S]*\]);?\s*$/)[1]);
const plugins = manifest.filter(p => p && p.status).map(p => p.name);
const pluginFiles = plugins.map(name => path.join(projectDir, 'js', 'plugins', name + '.js'));
const missingFiles = pluginFiles.filter(f => !fs.existsSync(f));
const sources = [];
for (const file of runtimeFiles) sources.push({ name: path.relative(repoRoot, file), text: fs.readFileSync(file, 'utf8'), plugin: false });
for (const file of pluginFiles) if (fs.existsSync(file)) sources.push({ name: path.basename(file), text: fs.readFileSync(file, 'utf8'), plugin: true });
// Plugins present but not enabled: indexed separately, so a missing name
// can be traced to the plugin that would have supplied it.
const disabledSources = [];
const pluginDir = path.join(projectDir, 'js', 'plugins');
if (fs.existsSync(pluginDir)) {
    const enabledSet = new Set(plugins.map(n => n + '.js'));
    for (const f of fs.readdirSync(pluginDir)) if (f.endsWith('.js') && !enabledSet.has(f)) disabledSources.push({ name: f, text: fs.readFileSync(path.join(pluginDir, f), 'utf8') });
}
// MV's own corescript, when given: what MV defined that we might not.
const mvSources = [];
if (mvDir) for (const f of ['rpg_core.js', 'rpg_managers.js', 'rpg_objects.js', 'rpg_scenes.js', 'rpg_sprites.js', 'rpg_windows.js']) {
    const file = path.join(mvDir, f);
    if (fs.existsSync(file)) mvSources.push({ name: 'MV/' + f, text: fs.readFileSync(file, 'utf8') });
}

// PIXI's own surface, as an allowlist: every method/property name pixi.js
// defines anywhere. A superset is fine; it only suppresses reports.
const pixiNames = new Set();
const pixiFile = path.join(runtimeDir, 'libs', 'pixi.js');
if (fs.existsSync(pixiFile)) {
    const pixi = fs.readFileSync(pixiFile, 'utf8');
    for (const m of pixi.matchAll(/^\s+(?:get |set |static |async )?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) pixiNames.add(m[1]);
    for (const m of pixi.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\s*=/g)) pixiNames.add(m[1]);
    for (const m of pixi.matchAll(/\.prototype\.([A-Za-z_$][\w$]*)\s*=/g)) pixiNames.add(m[1]);
}
const builtinNames = new Set(['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'call', 'apply', 'bind', 'length', 'name', 'prototype', 'push', 'pop', 'slice', 'splice', 'map', 'filter', 'forEach', 'indexOf', 'contains', 'concat', 'join', 'sort', 'reduce', 'some', 'every', 'find', 'includes', 'keys', 'values', 'entries', 'then', 'catch', 'clamp', 'mod', 'padZero', 'format', 'equals', 'clone', 'remove', 'isNwjs', 'toUpperCase', 'toLowerCase', 'trim', 'split', 'replace', 'match', 'test', 'exec', 'charAt', 'substring', 'substr', 'floor', 'ceil', 'round', 'max', 'min', 'random', 'randomInt', 'emit', 'on', 'off', 'once', 'addListener', 'removeListener', 'destroy']);

// ---- definitions -----------------------------------------------------------

const methods = new Map();      // class -> Set(method)
const statics = new Map();      // object -> Set(name)
const parents = new Map();      // class -> parent class
const classes = new Set();
const definedBy = new Map();    // "Class.method" -> first source name

const engineStatics = new Set(['Graphics', 'SceneManager', 'DataManager', 'AudioManager', 'ImageManager', 'StorageManager', 'BattleManager', 'TextManager', 'ColorManager', 'FontManager', 'EffectManager', 'PluginManager', 'ConfigManager', 'SoundManager', 'Utils', 'Input', 'TouchInput', 'JsonEx', 'Video', 'WebAudio', 'Bitmap', 'Window', 'Sprite', 'Tilemap', 'Decrypter', 'ResourceHandler', 'ImageCache', 'RequestQueue', 'CacheMap', 'Weather', 'ShaderTilemap', 'ScreenSprite', 'ToneFilter', 'ToneSprite', 'Stage', 'WindowLayer', 'Rectangle', 'Point']);

function indexDefinitions(src, methods, statics, parents, classes, definedBy) {
    const add = (map, key, name, source) => {
        if (!map.has(key)) map.set(key, new Set());
        map.get(key).add(name);
        const full = key + (map === methods ? '#' : '.') + name;
        if (definedBy && !definedBy.has(full)) definedBy.set(full, source);
    };
    const t = src.text;
    for (const m of t.matchAll(/^\s*(?:function|class)\s+([A-Z][\w$]*)/gm)) classes.add(m[1]);
    for (const m of t.matchAll(/\b([A-Z][\w$]*)\.prototype\s*=\s*Object\.create\(\s*([A-Z][\w$.]*)\.prototype\s*\)/g)) { parents.set(m[1], m[2]); classes.add(m[1]); }
    for (const m of t.matchAll(/\bclass\s+([A-Z][\w$]*)\s+extends\s+([A-Z][\w$.]*)/g)) { parents.set(m[1], m[2]); classes.add(m[1]); }
    // Class.prototype.name = ...
    for (const m of t.matchAll(/\b([A-Z][\w$]*)\.prototype\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) add(methods, m[1], m[2], src.name);
    // def(Class.prototype, "name") / def(Static, "name")   (compat layers)
    for (const m of t.matchAll(/\bdef\(\s*([A-Z][\w$]*)\.prototype\s*,\s*["']([\w$]+)["']/g)) add(methods, m[1], m[2], src.name);
    for (const m of t.matchAll(/\bdef\(\s*([A-Z][\w$]*)\s*,\s*["']([\w$]+)["']/g)) add(statics, m[1], m[2], src.name);
    // Object.defineProperty(Class.prototype, "name") / defineProperties({ name: })
    for (const m of t.matchAll(/Object\.defineProperty\(\s*([A-Z][\w$]*)\.prototype\s*,\s*["']([\w$]+)["']/g)) add(methods, m[1], m[2], src.name);
    for (const m of t.matchAll(/Object\.defineProperty\(\s*([A-Z][\w$]*)\s*,\s*["']([\w$]+)["']/g)) add(statics, m[1], m[2], src.name);
    for (const m of t.matchAll(/Object\.defineProperties\(\s*([A-Z][\w$]*)\.prototype\s*,\s*\{([\s\S]*?)\n\}\)/g)) {
        for (const k of m[2].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)) add(methods, m[1], k[1], src.name);
    }
    // var P = Class.prototype; P.name = ... / def(P, "name")
    const aliases = new Map();
    for (const m of t.matchAll(/\b(?:var|const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Z][\w$]*)\.prototype\s*;/g)) aliases.set(m[1], m[2]);
    for (const [alias, cls] of aliases) {
        const a = alias.replace(/\$/g, '\\$');
        for (const m of t.matchAll(new RegExp('\\b' + a + '\\.([A-Za-z_$][\\w$]*)\\s*=(?!=)', 'g'))) add(methods, cls, m[1], src.name);
        for (const m of t.matchAll(new RegExp('\\bdef\\(\\s*' + a + '\\s*,\\s*["\']([\\w$]+)["\']', 'g'))) add(methods, cls, m[1], src.name);
    }
    // Object.defineProperties(Static, { name: ... })
    for (const m of t.matchAll(/Object\.defineProperties\(\s*([A-Z][\w$]*)\s*,\s*\{([\s\S]*?)\n\}\)/g)) {
        for (const k of m[2].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)) add(statics, m[1], k[1], src.name);
    }
    // Static.name = ...
    for (const m of t.matchAll(/^\s*([A-Z][\w$]*)\.([A-Za-z_$][\w$]*)\s*=(?!=)/gm)) if (m[2] !== 'prototype') add(statics, m[1], m[2], src.name);
    // this.name = ... inside anything: instance fields, counted as defined names for this-calls
    for (const m of t.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) add(methods, '*fields', m[1], src.name);
}
for (const src of sources) indexDefinitions(src, methods, statics, parents, classes, definedBy);
// The compat layer fills many MV names from arrays at runtime
// (["setupRate", "setupDuration", ...].forEach(name => P[name] = MV[name])),
// which no assignment regex sees. Every quoted name inside an array literal
// in a compat source counts as supplied, on any class.
const dynamicNames = new Set();
for (const src of sources.filter(s => !s.plugin && /compat/.test(s.name))) {
    for (const m of src.text.matchAll(/\[\s*((?:"[A-Za-z_$][\w$]*"\s*,?\s*){2,})\]/g)) {
        for (const k of m[1].matchAll(/"([A-Za-z_$][\w$]*)"/g)) dynamicNames.add(k[1]);
    }
}
const disabledMethods = new Map(), disabledStatics = new Map(), disabledBy = new Map();
for (const src of disabledSources) indexDefinitions(src, disabledMethods, disabledStatics, new Map(), new Set(), disabledBy);
const mvMethods = new Map(), mvStatics = new Map(), mvParents = new Map();
for (const src of mvSources) indexDefinitions(src, mvMethods, mvStatics, mvParents, new Set(), null);

// Inheritance defaults the sources do not spell out.
const impliedParents = {
    Sprite: 'PIXI.Sprite', TilingSprite: 'PIXI.TilingSprite', Window: 'PIXI.Container', WindowLayer: 'PIXI.Container', Stage: 'PIXI.Container', Tilemap: 'PIXI.Container', ScreenSprite: 'PIXI.Container', Weather: 'PIXI.Container', Rectangle: 'PIXI.Rectangle', Point: 'PIXI.Point'
};
for (const [c, p] of Object.entries(impliedParents)) if (!parents.has(c)) parents.set(c, p);

const chain = cls => { const out = []; let c = cls; let guard = 0; while (c && guard++ < 20) { out.push(c); c = parents.get(c); } return out; };
const reachesPixi = cls => chain(cls).some(c => c.startsWith('PIXI'));
const children = new Map();
for (const [c, p] of parents) { if (!children.has(p)) children.set(p, new Set()); children.get(p).add(c); }
const descendants = cls => { const out = []; const stack = [cls]; while (stack.length) { const c = stack.pop(); for (const d of children.get(c) || []) { out.push(d); stack.push(d); } } return out; };
const hasMethod = (cls, name) => chain(cls).some(c => methods.get(c) && methods.get(c).has(name)) || (methods.get('*fields') && methods.get('*fields').has(name)) || dynamicNames.has(name);
// A method on a base class is routinely written for the subclasses that
// will actually run it (Game_BattlerBase code calling this.actor()).
const hasMethodBelow = (cls, name) => descendants(cls).some(c => methods.get(c) && methods.get(c).has(name));
const hasStatic = (obj, name) => (statics.get(obj) && statics.get(obj).has(name)) || (methods.get('*fields') && methods.get('*fields').has(name)) || dynamicNames.has(name);

// ---- references ------------------------------------------------------------

const findings = [];
const seen = new Set();
const mvChain = cls => { const out = []; let c = cls; let guard = 0; while (c && guard++ < 20) { out.push(c); c = mvParents.get(c) || parents.get(c); } return out; };
const mvHasMethod = (cls, name) => mvChain(cls).some(c => mvMethods.get(c) && mvMethods.get(c).has(name));
const mvHasStatic = (obj, name) => mvStatics.get(obj) && mvStatics.get(obj).has(name);
const disabledDefiner = (cls, name, isStatic) => {
    const map = isStatic ? disabledStatics : disabledMethods;
    const chainOf = isStatic ? [cls] : chain(cls);
    for (const c of chainOf) if (map.get(c) && map.get(c).has(name)) return disabledBy.get(c + (isStatic ? '.' : '#') + name);
    return null;
};
const report = (kind, plugin, line, subject, note, cls, name, isStatic) => {
    const key = kind + '|' + plugin + '|' + subject;
    if (seen.has(key)) return;
    seen.add(key);
    let mv = false;
    if (cls && name) mv = isStatic ? !!mvHasStatic(cls, name) : mvHasMethod(cls, name);
    const disabled = cls && name ? disabledDefiner(cls, name, isStatic) : null;
    if (mv && mvCanvasTilemap.has(cls + '#' + name)) { kind = 'unreachable'; note = "MV's canvas tilemap internals; MZ's WebGL tilemap never calls them, so the override is dead code"; }
    else if (mv) { kind = 'mv-gap'; note = 'MV defined this; Reactor and the compat layer do not (' + note + ')'; }
    else if (disabled) note = 'defined by ' + disabled + ', which is not enabled';
    findings.push({ kind, plugin, line, subject, note, mv, disabled });
};
const lineOf = (text, index) => text.slice(0, index).split('\n').length;
// Comments and string literals reference nothing; blank them (same length,
// newlines kept) so line numbers still hold.
const stripComments = text => text
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, lead) => lead + m.slice(lead.length).replace(/[^\n]/g, ' '))
    .replace(/(["'])(?:\\.|(?!\1)[^\\\n])*\1/g, m => m[0] + m.slice(1, -1).replace(/[^\n]/g, ' ') + m[0]);

// MV's canvas tilemap drew tiles itself; MZ's Tilemap is WebGL-only and
// never calls these, so a plugin's override of them is dead code, not a gap.
const mvCanvasTilemap = new Set(['Tilemap#_paintAllTiles', 'Tilemap#_paintTiles', 'Tilemap#_readLastTiles', 'Tilemap#_writeLastTiles', 'Tilemap#_drawTile', 'Tilemap#_drawNormalTile', 'Tilemap#_drawAutotile', 'Tilemap#_drawTableEdge', 'Tilemap#_drawShadow', 'Tilemap#_createLayers', 'Tilemap#_updateLayerPositions', 'Tilemap#_sortChildren', 'ShaderTilemap#_paintTiles', 'ShaderTilemap#_drawTile']);
const mvHooksNeverCalled = new Set(['Graphics._createRenderer', 'Graphics._createAllElements', 'Graphics._setupCssFontLoading', 'Graphics._createFPSMeter', 'Graphics._createModeBox', 'Graphics._createGameFontLoader', 'Graphics._updateModeBox', 'Graphics._createUpperCanvas', 'Graphics._updateUpperCanvas', 'Graphics._paintUpperCanvas', 'Graphics._createVideo', 'Graphics._onVideoLoad', 'SceneManager._getTimeInMs', 'SceneManager.setupErrorHandlers', 'Scene_Boot.loadSystemImages', 'Scene_Boot.loadSystemWindowImage']);

for (const src of sources.filter(s => s.plugin)) {
    const t = stripComments(src.text);
    // alias reads: X.prototype.y not followed by '=' (call/alias/compare)
    for (const m of t.matchAll(/(?<![\w$.])([A-Z][\w$]*)\.prototype\.([A-Za-z_$][\w$]*)\b(?![\w$])(?!\s*=[^=])/g)) {
        const [, cls, name] = m;
        if (name === 'constructor') continue;
        if (!classes.has(cls) && !methods.has(cls)) continue;
        if (hasMethod(cls, name)) continue;
        if (reachesPixi(cls) && pixiNames.has(name)) continue;
        if (builtinNames.has(name)) continue;
        report('alias', src.name, lineOf(t, m.index), `${cls}.prototype.${name}`, 'read but never defined by the runtime, the compat layer or any loaded plugin', cls, name, false);
    }
    // static reads: Engine.y where Engine is an engine static and y undefined
    for (const m of t.matchAll(/(?<![\w$.])([A-Z][\w$]*)\.([A-Za-z_$][\w$]*)\b(?![\w$])(?!\s*=[^=])/g)) {
        const [, obj, name] = m;
        if (!engineStatics.has(obj) || name === 'prototype') continue;
        if (hasStatic(obj, name)) continue;
        if (builtinNames.has(name)) continue;
        if (reachesPixi(obj) && pixiNames.has(name)) continue;
        if (mvHooksNeverCalled.has(obj + '.' + name)) continue;
        report('static', src.name, lineOf(t, m.index), `${obj}.${name}`, 'static read but never defined', obj, name, true);
    }
    // MV hooks wrapped that Reactor never invokes
    for (const m of t.matchAll(/\b([A-Z][\w$]*)\.([A-Za-z_$][\w$]*)\s*=\s*function/g)) {
        const full = m[1] + '.' + m[2];
        if (mvHooksNeverCalled.has(full)) report('hook', src.name, lineOf(t, m.index), full, 'an MV engine hook Reactor never calls; whatever the wrapper sets up never happens');
    }
    // PIXI ES5 super calls
    for (const m of t.matchAll(/\bPIXI\.([A-Z][\w$]*)\.call\(\s*this/g)) {
        report('pixi-super', src.name, lineOf(t, m.index), `PIXI.${m[1]}.call(this)`, 'ES5 super call into a PIXI class');
    }
    // this-calls inside prototype method bodies
    const headers = [...t.matchAll(/\b([A-Z][\w$]*)\.prototype\.([A-Za-z_$][\w$]*)\s*=\s*function/g)].map(h => ({ cls: h[1], name: h[2], index: h.index }));
    for (let i = 0; i < headers.length; i++) {
        const h = headers[i];
        const body = t.slice(h.index, i + 1 < headers.length ? headers[i + 1].index : t.length);
        if (!classes.has(h.cls) && !methods.has(h.cls)) continue;
        for (const m of body.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\s*\(/g)) {
            const name = m[1];
            if (hasMethod(h.cls, name) || hasMethodBelow(h.cls, name) || builtinNames.has(name)) continue;
            if (reachesPixi(h.cls) && pixiNames.has(name)) continue;
            report('this-call', src.name, lineOf(t, h.index + m.index), `${h.cls}#${name}`, `called from ${h.cls}.prototype.${h.name}, no definition on the chain`, h.cls, name, false);
        }
    }
}

// ---- output ----------------------------------------------------------------

const order = { 'mv-gap': 0, alias: 1, static: 2, hook: 3, 'pixi-super': 4, unreachable: 5, 'this-call': 6 };
findings.sort((a, b) => order[a.kind] - order[b.kind] || a.plugin.localeCompare(b.plugin) || a.line - b.line);
const counts = {};
for (const f of findings) counts[f.kind] = (counts[f.kind] || 0) + 1;
console.log(`plugin-compat-audit: ${path.basename(path.resolve(projectDir))} - ${plugins.length} enabled plugins, ${missingFiles.length} missing files`);
if (missingFiles.length) console.log('  missing:', missingFiles.map(f => path.basename(f)).join(', '));
console.log('  findings:', Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none');
console.log('');
const shown = showAll ? findings : findings.filter(f => f.kind !== 'this-call' || f.mv);
for (const f of shown) console.log(`${f.kind.padEnd(10)} ${f.plugin}:${f.line}  ${f.subject}  - ${f.note}`);
if (!showAll && counts['this-call']) console.log(`\n(${counts['this-call']} this-call findings hidden; --all shows them)`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ project: projectDir, plugins, missingFiles, findings }, null, 2));
