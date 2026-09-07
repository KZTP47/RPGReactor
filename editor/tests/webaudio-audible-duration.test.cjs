const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..', '..');
const core = fs.readFileSync(path.join(repoRoot, 'runtime', 'reactor_core.js'), 'utf8');

/** WebAudio.prototype.audibleDuration alone, over buffers the test shapes. */
function loadAudibleDuration() {
    const from = 'WebAudio.prototype.audibleDuration = function';
    const to = 'WebAudio.prototype.seek = function';
    const start = core.indexOf(from);
    const end = core.indexOf(to, start);
    assert.ok(start >= 0 && end > start);
    const context = { console, Math };
    vm.createContext(context);
    vm.runInContext('function WebAudio() {}', context);
    vm.runInContext(core.slice(start, end) + '\n;this.WebAudio = WebAudio;', context);
    return context.WebAudio;
}

/** One chunk: `music` seconds of tone followed by `silence` seconds of nothing. */
function chunk(music, silence, sampleRate = 44100, channels = 2) {
    const length = Math.round((music + silence) * sampleRate);
    const loud = Math.round(music * sampleRate);
    const data = [];
    for (let c = 0; c < channels; c++) {
        const samples = new Float32Array(length);
        for (let i = 0; i < loud; i++) samples[i] = Math.sin(i / 20) * 0.4;
        data.push(samples);
    }
    return {
        length, sampleRate, numberOfChannels: channels,
        duration: length / sampleRate,
        getChannelData: c => data[c]
    };
}

const measure = (WebAudio, buffers) => {
    const track = { _buffers: buffers, _audibleDuration: null,
        _totalTime: buffers.reduce((sum, b) => sum + b.duration, 0),
        audibleDuration: WebAudio.prototype.audibleDuration };
    return track;
};

test('a silent tail is not counted as part of the sound', () => {
    const WebAudio = loadAudibleDuration();
    const track = measure(WebAudio, [chunk(6.9, 5.3)]);
    assert.equal(Number(track._totalTime.toFixed(2)), 12.2, 'the file runs the full length');
    assert.ok(Math.abs(track.audibleDuration() - 6.9) < 0.02,
        'but the sound stops at 6.9s, got ' + track.audibleDuration());
});

test('a track that runs to its last sample is unchanged', () => {
    const WebAudio = loadAudibleDuration();
    const track = measure(WebAudio, [chunk(8, 0)]);
    assert.ok(Math.abs(track.audibleDuration() - track._totalTime) < 0.02);
});

test('the answer is cached, because it cannot change', () => {
    const WebAudio = loadAudibleDuration();
    const track = measure(WebAudio, [chunk(3, 2)]);
    const first = track.audibleDuration();
    track._buffers = null;                       // a second scan would now throw
    assert.equal(track.audibleDuration(), first);
});

test('a tail spanning more than one chunk is measured across them', () => {
    const WebAudio = loadAudibleDuration();
    // Music in the first chunk, then two chunks of nothing.
    const track = measure(WebAudio, [chunk(4, 1), chunk(0, 3), chunk(0, 3)]);
    assert.equal(Number(track._totalTime.toFixed(2)), 11);
    assert.ok(Math.abs(track.audibleDuration() - 4) < 0.02, 'got ' + track.audibleDuration());
});

test('a silent file falls back to its length rather than reading as zero', () => {
    const WebAudio = loadAudibleDuration();
    const track = measure(WebAudio, [chunk(0, 5)]);
    assert.equal(track.audibleDuration(), track._totalTime);
});
