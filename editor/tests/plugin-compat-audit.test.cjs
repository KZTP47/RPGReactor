const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const editorRoot = path.resolve(__dirname, '..');
const tool = path.join(editorRoot, 'build-scripts', 'plugin-compat-audit.cjs');

/** A project with three plugins: one enabled and reaching for missing things, one disabled that defines one of them. */
function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-audit-'));
    fs.mkdirSync(path.join(dir, 'js', 'plugins'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'mv'));
    fs.writeFileSync(path.join(dir, 'js', 'plugins.js'), 'var $plugins =\n[\n{"name":"Reaching","status":true,"parameters":{}},\n{"name":"Sleeping","status":false,"parameters":{}}\n];\n');
    fs.writeFileSync(path.join(dir, 'js', 'plugins', 'Reaching.js'), [
        '// Window_Base.prototype.inAComment is not a reference',
        'var _alias = Window_Base.prototype.drawGaugeMv;',
        'var _sleep = Game_Actor.prototype.fromSleeping;',
        'var _bad = Bitmap.prototype.reallyMissing;',
        'Graphics.printFullError("x");',
        'Graphics._createRenderer = function() {};',
        'function Own() { PIXI.Sprite.call(this); }',
        'Tilemap.prototype._paintTiles = function() { this._drawTile(); };',
        'Game_BattlerBase.prototype.tickle = function() { this.actor(); this.nowhere(); };'
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'js', 'plugins', 'Sleeping.js'), 'Game_Actor.prototype.fromSleeping = function() {};\n');
    fs.writeFileSync(path.join(dir, 'mv', 'rpg_windows.js'), 'Window_Base.prototype.drawGaugeMv = function() {};\n');
    fs.writeFileSync(path.join(dir, 'mv', 'rpg_core.js'), 'Graphics.printFullError = function() {};\nTilemap.prototype._drawTile = function() {};\n');
    return dir;
}

test('the audit names MV gaps, disabled-plugin definitions, hooks, PIXI supers and dead tilemap overrides, and ignores comments', () => {
    const dir = fixture();
    try {
        const out = path.join(dir, 'audit.json');
        const text = execFileSync('node', [tool, dir, '--mv', path.join(dir, 'mv'), '--json', out, '--all'], { encoding: 'utf8' });
        const report = JSON.parse(fs.readFileSync(out, 'utf8'));
        const by = subject => report.findings.find(f => f.subject === subject);
        assert.equal(by('Window_Base.prototype.drawGaugeMv').kind, 'mv-gap', 'MV defined it, Reactor does not');
        assert.equal(by('Graphics.printFullError').kind, 'mv-gap');
        assert.match(by('Game_Actor.prototype.fromSleeping').note, /defined by Sleeping\.js, which is not enabled/);
        assert.equal(by('Bitmap.prototype.reallyMissing').kind, 'alias');
        assert.equal(by('Graphics._createRenderer').kind, 'hook');
        assert.equal(by('PIXI.Sprite.call(this)').kind, 'pixi-super');
        assert.equal(by('Tilemap#_drawTile').kind, 'unreachable');
        assert.equal(by('Game_BattlerBase#nowhere').kind, 'this-call');
        assert.equal(by('Game_BattlerBase#actor'), undefined, 'a base-class call satisfied by a subclass is not reported');
        assert.equal(by('Window_Base.prototype.inAComment'), undefined, 'comments reference nothing');
        assert.match(text, /mv-gap 2/);
        assert.match(text, /Window_Base\.prototype\.drawGaugeMv/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
