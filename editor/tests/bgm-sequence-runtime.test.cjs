const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..', '..');
const managers = fs.readFileSync(path.join(repoRoot, 'runtime', 'reactor_managers.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

/** AudioManager alone, over a WebAudio whose clock and endings the test drives. */
function loadAudioManager({ mapId = 1, map = null } = {}) {
    const start = managers.indexOf('function AudioManager() {');
    const end = managers.indexOf('function SoundManager() {');
    assert.ok(start >= 0 && end > start);
    const clock = { now: 100 };
    const created = [];
    class WebAudio {
        constructor(url) {
            this.url = url;
            this.name = url.replace(/^audio\/bgm\/|\.ogg$/g, '');
            this._stopListeners = [];
            this.playing = false;
            this.destroyed = false;
            this.fadedOut = null;
            this.fadedIn = null;
            this.volume = 1;
            created.push(this);
        }
        play(loop) { this.loop = loop; this.playing = true; }
        stop() { this.playing = false; while (this._stopListeners.length) this._stopListeners.shift()(); }
        destroy() { this.destroyed = true; this.stop(); }
        fadeOut(duration) { this.fadedOut = duration; this.playing = false; }
        fadeIn(duration) { this.fadedIn = duration; }
        addStopListener(fn) { this._stopListeners.push(fn); }
        seek() { return 0; }
        isError() { return !!this.error; }
        isPlaying() { return this.playing; }
        /** What the end timer does when the track plays out. */
        end() { this.stop(); }
    }
    WebAudio._currentTime = () => clock.now;
    const context = {
        WebAudio, Graphics: { frameCount: 0 }, Utils: { encodeURI: s => s }, console, Math, Number, Object, Array,
        $gameMap: { mapId: () => mapId }, $dataMap: map
    };
    vm.createContext(context);
    vm.runInContext(managers.slice(start, end) + '\n;this.AudioManager = AudioManager;', context);
    const AudioManager = context.AudioManager;
    AudioManager.throwLoadError = function(buffer) { this.loadErrors = (this.loadErrors || []).concat(buffer.name); };
    const live = () => created.filter(b => !b.destroyed).map(b => b.name);
    const tick = seconds => { clock.now += seconds; AudioManager.updateBgmSequence(); };
    return { AudioManager, clock, created, live, tick, context };
}

const SEQUENCE = {
    enabled: true,
    entries: [
        { type: 'track', name: 'Intro', volume: 80, pitch: 100, pan: 0 },
        { type: 'silence', duration: 10 },
        { type: 'track', name: 'Outro', volume: 60, pitch: 100, pan: 0 }
    ]
};
const MAP = { bgm: { name: 'Fallback', volume: 90, pitch: 100, pan: 0 }, bgmSequence: SEQUENCE };

test('a map with a sequence hands playBgm its fallback track marked with the map', () => {
    const { AudioManager } = loadAudioManager();
    assert.deepEqual(plain(AudioManager.mapBgmObject(MAP, 1)), { name: 'Fallback', volume: 90, pitch: 100, pan: 0, sequence: 1 });
    assert.deepEqual(plain(AudioManager.mapBgmObject({ bgm: { name: 'Plain', volume: 90, pitch: 100, pan: 0 } }, 1)), { name: 'Plain', volume: 90, pitch: 100, pan: 0 });
    assert.equal(AudioManager.mapHasBgmSequence({ bgmSequence: { enabled: false, entries: SEQUENCE.entries } }), false, 'disabled is off');
    assert.equal(AudioManager.mapHasBgmSequence({ bgmSequence: { enabled: true, entries: [] } }), false, 'empty is off');
    assert.equal(AudioManager.mapHasBgmSequence({}), false);
});

test('entries play in order, a track to its true end, a silence by the clock, and the sequence loops', () => {
    const { AudioManager, created, live, tick } = loadAudioManager({ map: MAP });
    AudioManager.playBgm(AudioManager.mapBgmObject(MAP, 1));
    assert.equal(AudioManager._bgmBuffer, null, 'the BGM slot stays empty');
    assert.equal(AudioManager._currentBgm, null);
    assert.deepEqual(live(), ['Intro']);
    assert.equal(created[0].loop, false, 'loop tags are inert inside a sequence');
    assert.equal(created[0].volume, 0.8, 'volume from the entry times the BGM option');
    tick(1000);
    assert.deepEqual(live(), ['Intro'], 'a track is not timed; it ends when it plays out');
    created[0].end();
    assert.equal(created[0].destroyed, true, 'a finished track is released');
    assert.deepEqual(live(), [], 'silence');
    tick(9);
    assert.deepEqual(live(), [], 'still silent');
    tick(1);
    assert.deepEqual(live(), ['Outro']);
    created[1].end();
    assert.deepEqual(live(), ['Intro'], 'back to the start');
});

test('a sequence that is one plain track is the ordinary looping BGM', () => {
    const map = { bgm: { name: 'Fallback', volume: 90, pitch: 100, pan: 0 }, bgmSequence: { enabled: true, entries: [{ type: 'track', name: 'Only', volume: 70, pitch: 100, pan: 0 }] } };
    const { AudioManager, created } = loadAudioManager({ map });
    AudioManager.playBgm(AudioManager.mapBgmObject(map, 1));
    assert.equal(AudioManager._bgmSequence, null);
    assert.ok(AudioManager._bgmBuffer);
    assert.equal(created[0].name, 'Only');
    assert.equal(created[0].loop, true, 'loop tags honoured');
    assert.equal(AudioManager._currentBgm.name, 'Only');
});

test('a palette sounds every layer at once, redraws each on its own, never repeats a pick, fades and moves on', () => {
    const palette = {
        type: 'palette', duration: 60, fadeOut: 5,
        layers: [
            { volume: 90, pitch: 100, pan: 0, pool: [{ type: 'track', name: 'DroneA' }, { type: 'track', name: 'DroneB' }] },
            { volume: 50, pitch: 100, pan: -30, pool: [{ type: 'track', name: 'Perc' }, { type: 'silence', duration: 7 }] }
        ]
    };
    const map = { bgm: { name: 'Fallback', volume: 90, pitch: 100, pan: 0 }, bgmSequence: { enabled: true, entries: [palette, { type: 'silence', duration: 3 }] } };
    const { AudioManager, created, live, tick } = loadAudioManager({ map });
    AudioManager.playBgm(AudioManager.mapBgmObject(map, 1));
    const layerOne = () => AudioManager._bgmSequence.palette.layers[0];
    const layerTwo = () => AudioManager._bgmSequence.palette.layers[1];
    assert.ok(layerOne().buffer, 'layer one started');
    assert.ok(/^Drone[AB]$/.test(layerOne().buffer.name));
    // Ending layer one's track thirty times never plays the same pick twice running.
    let previous = layerOne().buffer.name;
    for (let i = 0; i < 30; i++) {
        layerOne().buffer.end();
        const next = layerOne().buffer.name;
        assert.notEqual(next, previous, 'no immediate repeat');
        previous = next;
    }
    // Layer two: drive it until it draws the silence, then check it comes back on time.
    let guard = 0;
    while (layerTwo().buffer && guard++ < 20) layerTwo().buffer.end();
    assert.equal(layerTwo().buffer, null, 'the silence was drawn');
    assert.ok(layerTwo().silentUntil > 0);
    assert.ok(layerOne().buffer, 'layer one is untouched by layer two going quiet');
    tick(7);
    assert.ok(layerTwo().buffer, 'the silence ended and the layer redrew');
    assert.equal(layerTwo().buffer.name, 'Perc', 'the only other pick');
    // Duration: the palette started at 100 and fades at 160.
    const beforeFade = live().slice();
    tick(60 - 7);
    const state = AudioManager._bgmSequence;
    assert.equal(state.palette.fading, true);
    const fading = created.filter(b => b.fadedOut === 5 && !b.destroyed);
    assert.equal(fading.length, beforeFade.length, 'every live layer fades over the fade-out');
    const count = created.length;
    fading[0].end();
    assert.equal(created.length, count, 'a track ending mid-fade does not start another');
    tick(5);
    assert.equal(state.palette, null, 'the palette is over');
    assert.deepEqual(live(), [], 'its layers are released, and the 3 s silence follows');
    assert.equal(state.index, 1);
    tick(3);
    assert.equal(state.index, 0, 'the sequence loops back to the palette');
    assert.ok(state.palette && state.palette.layers[0].buffer, 'a fresh draw');
});

test('a palette with no duration runs until something else stops it', () => {
    const map = { bgm: { name: '', volume: 90, pitch: 100, pan: 0 }, bgmSequence: { enabled: true, entries: [{ type: 'palette', duration: 0, fadeOut: 2, layers: [{ volume: 90, pitch: 100, pan: 0, pool: [{ type: 'track', name: 'Bed' }] }] }] } };
    const { AudioManager, live, tick } = loadAudioManager({ map });
    AudioManager.playBgm(AudioManager.mapBgmObject(map, 1));
    tick(100000);
    assert.deepEqual(live(), ['Bed']);
    assert.equal(AudioManager._bgmSequence.palette.fading, false);
});

test('the saved BGM names the sequence, and replaying it waits for the map when the map is not loaded yet', () => {
    const { AudioManager, live, context } = loadAudioManager({ map: MAP });
    AudioManager.playBgm(AudioManager.mapBgmObject(MAP, 1));
    const saved = plain(AudioManager.saveBgm());
    assert.deepEqual(saved, { name: 'Fallback', volume: 90, pitch: 100, pan: 0, pos: 0, sequence: 1 });
    // A save being loaded: the title screen stopped everything, and the
    // title's map is still current.
    AudioManager.stopBgm();
    context.$gameMap = { mapId: () => 7 };
    context.$dataMap = null;
    AudioManager.playBgm(saved);
    assert.equal(AudioManager._bgmSequence, null);
    assert.equal(AudioManager._pendingBgmSequence.mapId, 1, 'and the request waits');
    assert.deepEqual(plain(AudioManager.saveBgm()), saved, 'saving again while waiting keeps the sequence');
    // The map's autoplay repeats the request once the map is up.
    context.$gameMap = { mapId: () => 1 };
    context.$dataMap = MAP;
    AudioManager.playBgm(AudioManager.mapBgmObject(MAP, 1));
    assert.equal(AudioManager._pendingBgmSequence, null);
    assert.deepEqual(live(), ['Intro']);
    // Repeating the request while it runs does not restart it.
    const before = AudioManager._bgmSequence;
    AudioManager.playBgm(AudioManager.mapBgmObject(MAP, 1));
    assert.equal(AudioManager._bgmSequence, before);
});

test('a plain Play BGM, Stop BGM or Fadeout BGM ends the sequence, and nothing restarts from a torn-down track', () => {
    const { AudioManager, created, live, tick } = loadAudioManager({ map: MAP });
    AudioManager.playBgm(AudioManager.mapBgmObject(MAP, 1));
    AudioManager.playBgm({ name: 'Event', volume: 90, pitch: 100, pan: 0 });
    assert.equal(AudioManager._bgmSequence, null);
    assert.deepEqual(live(), ['Event']);
    assert.equal(created[0].destroyed, true);
    assert.equal(AudioManager._currentBgm.name, 'Event');

    AudioManager.playBgm(AudioManager.mapBgmObject(MAP, 1));
    assert.deepEqual(live(), ['Intro']);
    AudioManager.fadeOutBgm(4);
    const intro = created.find(b => b.name === 'Intro' && !b.destroyed);
    assert.equal(intro.fadedOut, 4);
    assert.equal(AudioManager._bgmSequence.stopping, true);
    intro.end();
    assert.deepEqual(live(), ['Intro'], 'a track ending mid-fade starts nothing');
    tick(4);
    assert.equal(AudioManager._bgmSequence, null, 'released once the fade is done');
    assert.deepEqual(live(), []);
    assert.deepEqual(plain(AudioManager.saveBgm()), { name: '', volume: 0, pitch: 0 }, 'nothing to save');

    AudioManager.playBgm(AudioManager.mapBgmObject(MAP, 1));
    AudioManager.stopBgm();
    assert.equal(AudioManager._bgmSequence, null);
    assert.deepEqual(live(), []);
});

test('an ME ducks the whole bed and lets it back up, including a layer that starts during the ME', () => {
    const palette = { type: 'palette', duration: 0, fadeOut: 0, layers: [
        { volume: 100, pitch: 100, pan: 0, pool: [{ type: 'track', name: 'A' }] },
        { volume: 50, pitch: 100, pan: 0, pool: [{ type: 'track', name: 'B' }, { type: 'silence', duration: 1 }] }
    ] };
    const map = { bgm: { name: '', volume: 90, pitch: 100, pan: 0 }, bgmSequence: { enabled: true, entries: [palette] } };
    const { AudioManager, created, tick } = loadAudioManager({ map });
    AudioManager.playBgm(AudioManager.mapBgmObject(map, 1));
    const a = created.find(b => b.name === 'A');
    assert.equal(a.volume, 1);
    AudioManager.playMe({ name: 'Victory', volume: 90, pitch: 100, pan: 0 });
    assert.equal(a.volume, 0.25, 'ducked');
    // Layer two redraws while the ME plays: it starts ducked.
    const layerTwo = () => AudioManager._bgmSequence.palette.layers[1];
    let guard = 0;
    while (layerTwo().buffer && guard++ < 20) layerTwo().buffer.end();
    tick(1);
    assert.equal(layerTwo().buffer.name, 'B');
    assert.equal(layerTwo().buffer.volume, 0.5 * 0.25);
    AudioManager.stopMe();
    assert.equal(a.volume, 1, 'restored');
    assert.equal(layerTwo().buffer.volume, 0.5);
    AudioManager.bgmVolume = 50;
    assert.equal(a.volume, 0.5, 'the BGM option reaches every layer');
    assert.equal(layerTwo().buffer.volume, 0.25);
});

test('the error sweep sees sequence tracks, and a missing file is reported', () => {
    const { AudioManager, created } = loadAudioManager({ map: MAP });
    AudioManager.playBgm(AudioManager.mapBgmObject(MAP, 1));
    created[0].error = true;
    AudioManager.checkErrors();
    assert.deepEqual(AudioManager.loadErrors, ['Intro']);
});

test('the runtime hooks are in place: the scene tick, map autoplay and the vehicle path', () => {
    const scenes = fs.readFileSync(path.join(repoRoot, 'runtime', 'reactor_scenes.js'), 'utf8');
    assert.match(scenes, /AudioManager\.checkErrors\(\);\n\s*AudioManager\.updateBgmSequence\(\);/);
    const objects = fs.readFileSync(path.join(repoRoot, 'runtime', 'reactor_objects.js'), 'utf8');
    assert.match(objects, /AudioManager\.playBgm\(AudioManager\.mapBgmObject\(\$dataMap, this\.mapId\(\)\)\)/);
    assert.match(objects, /this\._walkingBgm = AudioManager\.mapBgmObject\(\$dataMap, \$gameMap\.mapId\(\)\)/);
});

test('an entry fades in over its own field, and one without a fade still starts at full volume', () => {
    const map = { bgm: { name: 'Fallback', volume: 90, pitch: 100, pan: 0 }, bgmSequence: { enabled: true, entries: [
        { type: 'track', name: 'Swell', volume: 80, pitch: 100, pan: 0, fadeIn: 3 },
        { type: 'track', name: 'Blunt', volume: 80, pitch: 100, pan: 0 }
    ] } };
    const { AudioManager, created } = loadAudioManager({ map });
    AudioManager.playBgm(AudioManager.mapBgmObject(map, 1));

    assert.equal(created[0].name, 'Swell');
    assert.equal(created[0].fadedIn, 3, 'the entry fades in over its own field');
    assert.equal(created[0].playing, true, 'the fade is asked for after play, when the fade stage exists');

    created[0].end();
    assert.equal(created[1].name, 'Blunt');
    assert.equal(created[1].fadedIn, null, 'an entry with no fade-in is untouched');
});

test('a palette fades in every layer it starts, including one it redraws later', () => {
    const palette = {
        type: 'palette', duration: 60, fadeIn: 4, fadeOut: 5,
        layers: [
            { volume: 90, pitch: 100, pan: 0, pool: [{ type: 'track', name: 'DroneA' }, { type: 'track', name: 'DroneB' }] },
            { volume: 50, pitch: 100, pan: -30, pool: [{ type: 'track', name: 'Perc' }] }
        ]
    };
    const map = { bgm: { name: 'Fallback', volume: 90, pitch: 100, pan: 0 }, bgmSequence: { enabled: true, entries: [palette] } };
    const { AudioManager, created } = loadAudioManager({ map });
    AudioManager.playBgm(AudioManager.mapBgmObject(map, 1));

    assert.equal(created.length, 2);
    assert.deepEqual(created.map(b => b.fadedIn), [4, 4], 'both layers swell in rather than snapping on');

    // A re-draw is a new voice arriving, so it fades in the same way.
    const layerOne = AudioManager._bgmSequence.palette.layers[0];
    layerOne.buffer.end();
    const redrawn = created[created.length - 1];
    assert.notEqual(redrawn, created[0]);
    assert.equal(redrawn.fadedIn, 4, 'a pool re-draw fades in too');
});

test('a palette with no fade-in keeps the abrupt start it has always had', () => {
    const palette = { type: 'palette', duration: 60, fadeOut: 5, layers: [{ volume: 90, pitch: 100, pan: 0, pool: [{ type: 'track', name: 'Bed' }] }] };
    const map = { bgm: { name: '', volume: 90, pitch: 100, pan: 0 }, bgmSequence: { enabled: true, entries: [palette] } };
    const { AudioManager, created } = loadAudioManager({ map });
    AudioManager.playBgm(AudioManager.mapBgmObject(map, 1));
    assert.equal(created[0].fadedIn, null, 'an absent fade-in changes nothing for sequences authored before it existed');
});

/** A palette that runs `duration`, followed by an entry that may name a fade-in. */
function crossfadeMap(nextFadeIn) {
    const next = { type: 'track', name: 'Next', volume: 80, pitch: 100, pan: 0 };
    if (nextFadeIn) next.fadeIn = nextFadeIn;
    return {
        bgm: { name: 'Fallback', volume: 90, pitch: 100, pan: 0 },
        bgmSequence: { enabled: true, entries: [
            { type: 'palette', duration: 60, fadeOut: 5, layers: [{ volume: 90, pitch: 100, pan: 0, pool: [{ type: 'track', name: 'Bed' }] }] },
            next
        ] }
    };
}

test('a palette hands over while it is still sounding when the next entry fades in', () => {
    const map = crossfadeMap(4);
    const { AudioManager, created, live, tick } = loadAudioManager({ map });
    AudioManager.playBgm(AudioManager.mapBgmObject(map, 1));
    const bed = created[0];
    assert.equal(bed.name, 'Bed');

    tick(60);
    // The advance happens as the tail starts, not after it: both are audible.
    assert.equal(AudioManager._bgmSequence.index, 1, 'the next entry has already begun');
    assert.deepEqual(live(), ['Bed', 'Next'], 'the outgoing bed is still sounding under the incoming track');
    assert.equal(bed.fadedOut, 5, 'the bed rides its own fade-out down');
    assert.equal(created[1].fadedIn, 4, 'the incoming entry swells in over its own field');
    assert.equal(AudioManager._bgmSequence.palette, null, 'the palette itself is over');

    // The bed is released once its tail is done, not before.
    tick(4);
    assert.deepEqual(live(), ['Bed', 'Next'], 'still fading, so still held');
    tick(1);
    assert.deepEqual(live(), ['Next'], 'the tail finished and the bed was released');
});

test('a next entry with no fade-in keeps the sequential timing it has always had', () => {
    const map = crossfadeMap(0);
    const { AudioManager, live, tick } = loadAudioManager({ map });
    AudioManager.playBgm(AudioManager.mapBgmObject(map, 1));

    tick(60);
    assert.equal(AudioManager._bgmSequence.palette.fading, true, 'the old path: fade first');
    assert.deepEqual(live(), ['Bed'], 'nothing has started over the top of it');
    assert.equal(AudioManager._bgmSequence.index, 0, 'the advance waits for the fade to finish');

    tick(5);
    assert.deepEqual(live(), ['Next'], 'and only then does the next entry begin');
});

test('stopping the sequence releases a bed that is still fading out under the next entry', () => {
    const map = crossfadeMap(4);
    const { AudioManager, live, tick } = loadAudioManager({ map });
    AudioManager.playBgm(AudioManager.mapBgmObject(map, 1));
    tick(60);
    assert.equal(live().length, 2);

    AudioManager.stopBgm();
    assert.deepEqual(live(), [], 'both the retiring bed and the live entry are released');
    assert.equal(AudioManager._bgmSequence, null);
});

test('a palette handing over to a fresh draw never crossfades a track into itself', () => {
    // One palette, so the entry that follows it is itself: every cycle is a
    // re-draw of the same pool, overlapping the draw it is replacing.
    const map = { bgm: { name: '', volume: 90, pitch: 100, pan: 0 }, bgmSequence: { enabled: true, entries: [
        { type: 'palette', duration: 30, fadeIn: 3, fadeOut: 4, layers: [
            { volume: 100, pitch: 100, pan: 0, pool: [{ type: 'track', name: 'A' }, { type: 'track', name: 'B' }] }
        ] }
    ] } };

    for (let run = 0; run < 40; run++) {
        const { AudioManager, tick } = loadAudioManager({ map });
        AudioManager.playBgm(AudioManager.mapBgmObject(map, 1));
        const before = AudioManager._bgmSequence.palette.layers[0].buffer.name;
        tick(30);
        const after = AudioManager._bgmSequence.palette.layers[0].buffer.name;
        // The guard has to survive the cycle: rebuilding the layer with last=-1
        // let a layer hand over to the track it was already playing, which an
        // overlap turns into a track phasing against a copy of itself.
        assert.notEqual(after, before, 'run ' + run + ': handed over to its own track');
    }
});
