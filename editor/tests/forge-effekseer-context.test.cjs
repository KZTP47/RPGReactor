const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function fixture() {
    const calls = [];
    let active = 'map';
    const owned = name => { assert.equal(active, 'forge', `${name} must use the Forge context`); calls.push(name); };
    const context = {
        nativeptr: 1,
        _makeContextCurrent() { active = 'forge'; },
        update() { owned('update'); },
        play() { owned('play'); return { exists: true, setLocation() {}, stop() {} }; },
        setProjectionMatrix() {}, setCameraMatrix() {},
        beginDraw() { owned('beginDraw'); }, drawHandle() { owned('draw'); }, endDraw() {},
        releaseEffect() { owned('releaseEffect'); }
    };
    const sandbox = { console, clearTimeout() {}, setTimeout() { return 1; }, cancelAnimationFrame() {},
        RREffekseerStateGuard: { settle() {}, release(ctx) { assert.equal(ctx, context); calls.push('unguard'); } },
        effekseer: { releaseContext(ctx) { owned('releaseContext'); ctx.nativeptr = null; } } };
    const source = fs.readFileSync(path.join(__dirname, '../src/forge/EffekseerGenerator/EffekseerGenerator.js'), 'utf8');
    const Generator = vm.runInNewContext(source + '\nEffekseerGenerator', sandbox);
    const gen = Object.create(Generator.prototype);
    Object.assign(gen, {
        _efkContext: context, _generation: 0, _updateTick: 0, _retiredEffects: [],
        _frame: 0, _playing: false, _efkHandle: { exists: true, stop() {} }, _efkEffect: { isLoaded: true },
        _gl: { viewport() {}, clearColor() {}, clear() {},
            getExtension() { return { loseContext() { calls.push('loseGL'); } }; } },
        _cameraMatrix: () => [], _applyOrientation() {}, _updatePlayButton() {}, _overlay() {}, _status() {},
        _t: x => x, _tx: x => x, _stack: [], _recipe: () => ({}), _params: () => ({}),
        _buildBytes: () => new Uint8Array([1]), _stackMeta: () => ({}), _userTextMap: () => new Map()
    });
    return { gen, context, calls, otherContext: () => { active = 'map'; } };
}

test('Forge selects its own context for updates, playback and paused draws', () => {
    const { gen, calls, otherContext } = fixture();
    gen._ctxUpdate();
    otherContext();
    gen._play();
    gen._playing = false;
    for (let i = 0; i < 3; i++) {
        otherContext();
        gen._renderFrame({ width: 64, height: 64 }, null, () => 0);
    }
    assert.deepEqual(calls, ['update', 'play', 'beginDraw', 'draw', 'beginDraw', 'draw', 'beginDraw', 'draw']);
});

test('Forge teardown retires effects and releases the actual Effekseer context and guard', () => {
    const { gen, context, calls } = fixture();
    gen._teardownPreview();
    assert.deepEqual(calls, ['update', 'update', 'releaseEffect', 'unguard', 'releaseContext', 'loseGL']);
    assert.equal(context.nativeptr, null);
    assert.equal(gen._efkContext, null);
    assert.equal(gen._gl, null);
});

test('a superseded load is released through its original context', () => {
    const { gen, context } = fixture();
    let loaded, released;
    const effect = { nativeptr: 2, isLoaded: true, _update() {} };
    context.loadEffect = (bytes, scale, onLoad) => { loaded = onLoad; return effect; };
    context.releaseEffect = value => { released = value; };
    gen._loadCurrentEffect();
    gen._generation++;
    gen._efkContext = { releaseEffect() { assert.fail('released through the replacement context'); } };
    loaded();
    assert.equal(released, effect);
});

test('a late texture decode cannot update a released preview', () => {
    const { gen, context } = fixture();
    let updates = 0;
    const effect = { nativeptr: 2, _update() { updates++; } };
    context.loadEffect = () => effect;
    gen._loadCurrentEffect();
    effect._update();
    assert.equal(updates, 1);
    context.nativeptr = null;
    effect._update();
    assert.equal(updates, 1);
    context.nativeptr = 1;
    effect.nativeptr = null;
    effect._update();
    assert.equal(updates, 1);
});

test('loop playback repeats at the chosen frame even when a burst ends early', () => {
    const { gen, calls } = fixture();
    Object.assign(gen, { _loopPreview: true, _loopFrames: 3, _playing: true });
    gen._efkHandle.exists = false;
    gen._renderFrame({ width: 64, height: 64 }, null, () => 8);
    assert.equal(gen._frame, 2);
    assert.equal(gen._playing, true);
    assert.equal(calls.filter(c => c === 'play').length, 2);
    assert.equal(calls.filter(c => c === 'update').length, 8);
});

test('single playback stops at its duration and Play starts a fresh cycle', () => {
    const { gen, calls } = fixture();
    Object.assign(gen, { _loopPreview: false, _loopFrames: 3, _playing: true });
    const label = {};
    gen._renderFrame({ width: 64, height: 64 }, label, () => 8);
    assert.equal(gen._frame, 3);
    assert.equal(gen._playing, false);
    assert.match(label.textContent, /3 \/ 3$/);
    assert.equal(calls.filter(c => c === 'update').length, 3);
    gen._togglePause();
    assert.equal(gen._frame, 0);
    assert.equal(gen._playing, true);
    assert.equal(calls.filter(c => c === 'play').length, 1);
});

test('disabling loop at the boundary does not start another cycle', () => {
    const { gen, calls } = fixture();
    Object.assign(gen, { _loopPreview: false, _loopFrames: 3, _frame: 3, _playing: true });
    gen._renderFrame({ width: 64, height: 64 }, null, () => 1);
    assert.equal(gen._playing, false);
    assert.equal(calls.includes('play'), false);
    assert.equal(calls.includes('update'), false);
});

test('invalid or unbounded durations become finite frame counts', () => {
    const { gen } = fixture();
    for (const value of [0, '', -1, Infinity, NaN, undefined]) assert.equal(gen._durationFrames(value), 120);
    assert.equal(gen._durationFrames(1.7), 2);
    assert.equal(gen._durationFrames(0.1), 1);
    assert.equal(gen._durationFrames(9000), 3600);
    assert.equal(gen._durationFrames('240'), 240);
});
