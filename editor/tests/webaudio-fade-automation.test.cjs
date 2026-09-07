const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..', '..');
const core = fs.readFileSync(path.join(repoRoot, 'runtime', 'reactor_core.js'), 'utf8');

/** The gain helpers and both pairs of fades, over a clock the test drives. */
function loadFades() {
    const slice = (from, to) => {
        const start = core.indexOf(from);
        const end = core.indexOf(to, start);
        assert.ok(start >= 0 && end > start, 'expected ' + from + ' before ' + to);
        return core.slice(start, end);
    };
    const clock = { now: 100 };
    const context = { console, Math, Object };
    vm.createContext(context);
    vm.runInContext('function WebAudio() {}', context);
    vm.runInContext(slice('WebAudio._holdGain = function', 'WebAudio.prototype.clear = function'), context);
    vm.runInContext(slice('WebAudio.prototype.fadeIn = function', 'WebAudio.prototype.seek = function'), context);
    vm.runInContext('this.WebAudio = WebAudio;', context);
    const WebAudio = context.WebAudio;
    WebAudio._currentTime = () => clock.now;
    return { WebAudio, clock };
}

/** An AudioParam that records automation instead of performing it. */
function recordingParam({ value = 1, canHold = true } = {}) {
    const calls = [];
    const param = {
        value,
        setValueAtTime: (v, t) => calls.push(['setValueAtTime', v, t]),
        linearRampToValueAtTime: (v, t) => calls.push(['linearRamp', v, t]),
        cancelScheduledValues: t => calls.push(['cancelScheduledValues', t])
    };
    if (canHold) param.cancelAndHoldAtTime = t => calls.push(['cancelAndHold', t]);
    return { param, calls };
}

const buffer = (WebAudio, param, volume) => ({
    _gainNode: { gain: param },
    _volume: volume,
    _loadListeners: [],
    isReady: () => true,
    fadeIn: WebAudio.prototype.fadeIn,
    fadeOut: WebAudio.prototype.fadeOut
});

test('a fade-out clears the timeline before ramping, and never re-raises the level', () => {
    const { WebAudio, clock } = loadFades();
    // Mid fade-in: the param is audibly at 0.25 while _volume still reads 1.
    const { param, calls } = recordingParam({ value: 0.25 });
    buffer(WebAudio, param, 1).fadeOut(2);

    assert.deepEqual(calls, [
        ['cancelAndHold', clock.now],
        ['linearRamp', 0, clock.now + 2]
    ]);
    // The old body pinned to _volume here, which is what made the gain jump
    // from 0.25 to 1 before falling. Nothing may schedule a value above the
    // level the param is already at.
    assert.equal(calls.some(([kind, value]) => kind === 'setValueAtTime' && value > 0.25), false);
});

test('a fade-out holds the live value where cancelAndHoldAtTime is unavailable', () => {
    const { WebAudio, clock } = loadFades();
    const { param, calls } = recordingParam({ value: 0.25, canHold: false });
    buffer(WebAudio, param, 1).fadeOut(2);

    // Read the value first, then cancel, then pin: cancelling drops a running
    // ramp back to its previous event, so the order is what preserves 0.25.
    assert.deepEqual(calls, [
        ['cancelScheduledValues', clock.now],
        ['setValueAtTime', 0.25, clock.now],
        ['linearRamp', 0, clock.now + 2]
    ]);
});

test('a fade-in clears the timeline and forces zero, because a gain node starts at full volume', () => {
    const { WebAudio, clock } = loadFades();
    const { param, calls } = recordingParam({ value: 0.8 });
    buffer(WebAudio, param, 0.8).fadeIn(3);

    assert.deepEqual(calls, [
        ['cancelScheduledValues', clock.now],
        ['setValueAtTime', 0, clock.now],
        ['linearRamp', 0.8, clock.now + 3]
    ]);
});

test('a fade-out interrupting a fade-in leaves exactly one ramp pending', () => {
    const { WebAudio, clock } = loadFades();
    const { param, calls } = recordingParam({ value: 1 });
    const track = buffer(WebAudio, param, 1);

    track.fadeIn(2);
    clock.now += 0.5;
    param.value = 0.25;
    track.fadeOut(2);

    const ramps = calls.filter(([kind]) => kind === 'linearRamp');
    const clears = calls.filter(([kind]) => kind === 'cancelAndHold' || kind === 'cancelScheduledValues');
    assert.equal(ramps.length, 2);
    assert.equal(clears.length, 2);
    // Each ramp is preceded by a clear; that is what stops the first ramp's end
    // time from governing the second.
    assert.ok(calls.indexOf(clears[1]) < calls.indexOf(ramps[1]));
    assert.deepEqual(ramps[1], ['linearRamp', 0, clock.now + 2]);
});

test('the master fades clear the timeline the same way', () => {
    const { WebAudio, clock } = loadFades();

    const fadeOut = recordingParam({ value: 0.4 });
    WebAudio._masterGainNode = { gain: fadeOut.param };
    WebAudio._masterVolume = 1;
    WebAudio._fadeOut(1.5);
    assert.deepEqual(fadeOut.calls, [
        ['cancelAndHold', clock.now],
        ['linearRamp', 0, clock.now + 1.5]
    ]);

    const fadeIn = recordingParam({ value: 1 });
    WebAudio._masterGainNode = { gain: fadeIn.param };
    WebAudio._fadeIn(1.5);
    assert.deepEqual(fadeIn.calls, [
        ['cancelScheduledValues', clock.now],
        ['setValueAtTime', 0, clock.now],
        ['linearRamp', 1, clock.now + 1.5]
    ]);
});
