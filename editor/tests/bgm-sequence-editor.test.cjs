const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const editorRoot = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(editorRoot, file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function loadEditorClass() {
    const context = { console, module: undefined, globalThis: undefined };
    context.globalThis = context;
    vm.runInNewContext(read('src/utils/BgmSequenceEditor.js') + '\n;globalThis.__E = RRBgmSequenceEditor;', context);
    return context.__E;
}

test('a sequence normalizes to its three entry shapes with clamped levels, and absent reads as nothing', () => {
    const E = loadEditorClass();
    assert.deepEqual(plain(E.normalize(null)), { enabled: false, entries: [] });
    assert.equal(E.isBlank(E.normalize(undefined)), true);
    const raw = { enabled: true, entries: [
        { type: 'track', name: 'Forest', volume: '120', pitch: 30, pan: 'x' },
        { type: 'silence', duration: '2.55' },
        { type: 'palette', duration: 30, fadeOut: 4, layers: [{ volume: 70, pool: [{ type: 'track', name: 'A' }, { type: 'silence', duration: -3 }, null] }] },
        null, 'junk'
    ] };
    const sequence = plain(E.normalize(raw));
    assert.deepEqual(sequence.entries[0], { type: 'track', name: 'Forest', fadeIn: 0, volume: 100, pitch: 50, pan: 0 });
    assert.deepEqual(sequence.entries[1], { type: 'silence', duration: 2.6 });
    assert.deepEqual(sequence.entries[2], { type: 'palette', duration: 30, fadeIn: 0, fadeOut: 4, layers: [{ volume: 70, pitch: 100, pan: 0, pool: [{ type: 'track', name: 'A' }, { type: 'silence', duration: 0 }] }] });
    assert.deepEqual(plain(E.levels(null)), { volume: 100, pitch: 100, pan: 0 }, 'a new row starts at full volume and pitch, not at the slider minimums');
    assert.deepEqual(plain(E.layer(null)).volume, 100);
    assert.equal(sequence.entries.length, 3);
    assert.equal(E.isBlank({ enabled: false, entries: sequence.entries }), false, 'a disabled sequence with entries is kept');
});

test('validation names the first fault by entry and layer, and a disabled sequence is never at fault', () => {
    const E = loadEditorClass();
    const tt = text => text;
    const check = entries => E.validate(E.normalize({ enabled: true, entries }), tt);
    assert.equal(E.validate(E.normalize({ enabled: false, entries: [] }), tt), null);
    assert.equal(check([]), 'The sequence needs at least one entry.');
    assert.equal(check([{ type: 'track', name: '' }]), 'Entry 1: choose a track.');
    assert.equal(check([{ type: 'track', name: 'A' }, { type: 'silence', duration: 0 }]), 'Entry 2: a silence needs a duration above zero.');
    assert.equal(check([{ type: 'palette', layers: [] }]), 'Entry 1: a palette needs at least one layer.');
    assert.equal(check([{ type: 'palette', duration: 5, fadeOut: 6, layers: [{ pool: [{ type: 'track', name: 'A' }] }] }]), 'Entry 1: the fade-out cannot be longer than the duration.');
    assert.equal(check([{ type: 'palette', duration: 0, fadeOut: 6, layers: [{ pool: [{ type: 'track', name: 'A' }] }] }]), null, 'an endless palette may fade for any length');
    assert.equal(check([{ type: 'palette', layers: [{ pool: [] }] }]), 'Entry 1, layer 1: the pool needs at least one entry.');
    assert.equal(check([{ type: 'palette', layers: [{ pool: [{ type: 'track', name: 'A' }] }, { pool: [{ type: 'track', name: '' }] }] }]), 'Entry 1, layer 2: choose a track for every pool entry.');
    assert.equal(check([{ type: 'palette', layers: [{ pool: [{ type: 'silence', duration: 0 }] }] }]), 'Entry 1, layer 1: a silence needs a duration above zero.');
    assert.equal(check([{ type: 'track', name: 'A' }, { type: 'silence', duration: 3 }, { type: 'palette', duration: 10, fadeOut: 2, layers: [{ pool: [{ type: 'track', name: 'B' }, { type: 'silence', duration: 1 }] }] }]), null);
});

test('the list edits its copy in place: add, move, remove, retype a number, and pick a track', async () => {
    const E = loadEditorClass();
    const handlers = {};
    const container = {
        innerHTML: '', addEventListener: (type, fn) => { handlers[type] = fn; }, contains: () => true
    };
    const picks = [];
    const editor = new E({ container, tt: t => t, t: () => 'levels', pickTrack: options => { picks.push(plain(options)); return Promise.resolve({ name: 'Chosen', volume: 55, pitch: 100, pan: 10 }); } });
    editor.load({ enabled: true, entries: [{ type: 'track', name: 'A' }, { type: 'silence', duration: 5 }] });
    const click = (action, path) => handlers.click({ preventDefault() {}, target: { closest: () => ({ dataset: { action, path } }) } });
    click('add-palette', '');
    assert.deepEqual(plain(editor.value().entries.map(e => e.type)), ['track', 'silence', 'palette']);
    click('add-layer', 'entries.2');
    assert.equal(editor.value().entries[2].layers.length, 2);
    click('add-pool-silence', 'entries.2.layers.0');
    click('add-pool-track', 'entries.2.layers.0');
    assert.deepEqual(plain(editor.value().entries[2].layers[0].pool.map(p => p.type)), ['silence', 'track']);
    click('up', 'entries.1');
    assert.deepEqual(plain(editor.value().entries.map(e => e.type)), ['silence', 'track', 'palette']);
    click('down', 'entries.0');
    assert.deepEqual(plain(editor.value().entries.map(e => e.type)), ['track', 'silence', 'palette']);
    click('remove', 'entries.2.layers.1');
    assert.equal(editor.value().entries[2].layers.length, 1);
    const input = { dataset: { path: 'entries.1.duration' }, value: '7.25' };
    handlers.change({ target: input });
    assert.equal(editor.value().entries[1].duration, 7.3);
    assert.equal(input.value, 7.3, 'the field shows what was kept');
    await editor.pick('entries.2.layers.0.pool.1', editor.sequence.entries[2].layers[0].pool[1], null);
    assert.equal(editor.value().entries[2].layers[0].pool[1].name, 'Chosen');
    assert.equal(picks[0].levels, null, 'a pool entry has no levels of its own');
    assert.deepEqual(picks[0].previewLevels, { volume: 100, pitch: 100, pan: 0 }, 'it previews with its layer');
    await editor.pick('entries.0', editor.sequence.entries[0], null);
    assert.deepEqual(plain(editor.value().entries[0]), { type: 'track', name: 'Chosen', fadeIn: 0, volume: 55, pitch: 100, pan: 10 }, 'a track row takes the picker levels');
    assert.match(container.innerHTML, /bgm-seq-row/);
    editor.setEnabled(false);
    assert.equal(editor.value().enabled, false);
});

/** Map Properties with every field the save reads, over a map that carries a field the form does not know. */
function controllerFor(mapData, sequence) {
    const values = {
        'map-width-input': { value: String(mapData.width) }, 'map-height-input': { value: String(mapData.height) },
        'map-note-textarea': { value: mapData.note || '' }, 'map-name-input': { value: mapData.name },
        'map-display-name-input': { value: '' }, 'map-tileset-select': { value: '1' }, 'map-scroll-type-select': { value: '0' },
        'map-encounter-steps-input': { value: '30' }, 'map-disable-dashing-checkbox': { checked: false },
        'map-autoplay-bgm-checkbox': { checked: true }, 'map-autoplay-bgs-checkbox': { checked: false },
        'map-specify-battleback-checkbox': { checked: false }, 'map-battleback1-select': { value: '' }, 'map-battleback2-select': { value: '' },
        'map-parallax-image-select': { value: '' }, 'map-parallax-loop-x-checkbox': { checked: false }, 'map-parallax-loop-y-checkbox': { checked: false },
        'map-parallax-show-checkbox': { checked: false }, 'map-parallax-sx-input': { value: '0' }, 'map-parallax-sy-input': { value: '0' },
        'map-bgm-sequence-checkbox': { focus() { this.focused = true; } }
    };
    const alerts = [];
    const context = {
        console, process, require, nw: {}, alert: m => alerts.push(m),
        document: { getElementById: id => values[id] || null },
        RR_LIMITS: { MAP_WIDTH: 512, MAP_HEIGHT: 512 },
        rrIsMapSizeSupported: (w, h) => w >= 1 && w <= 512 && h >= 1 && h <= 512,
        RRBgmSequenceEditor: loadEditorClass()
    };
    const ProjectController = vm.runInNewContext(read('src/ProjectController.js') + '\nProjectController;', context);
    const controller = Object.create(ProjectController.prototype);
    Object.assign(controller, {
        currentEditingMap: mapData, isCreatingNewMap: false, _tt: t => t, _t: k => k,
        _mapAudio: { bgm: { name: 'Fallback', volume: 90, pitch: 100, pan: 0 }, bgs: { name: '', volume: 80, pitch: 100, pan: 0 } },
        _bgmSequenceEditor: null, _mapBgmSequence: sequence,
        mapElevation: () => null, readMap3DForm: () => null, getEncounterListFromForm: () => [],
        writeMapDataFile(data) { controller.written = JSON.parse(JSON.stringify(data)); return true; },
        saveMap3DSettings: () => false, renderMapsList() {}, tilemapManager: null,
        projectManager: { saveMapInfos: () => true }, currentProject: { maps: [] }, uiManager: { updateStatus() {} }
    });
    controller.alerts = alerts;
    controller.values = values;
    return controller;
}

test('every numeric field round-trips, because an unhandled key silently reverts', () => {
    const E = loadEditorClass();
    const handlers = {};
    const container = { innerHTML: '', addEventListener: (type, fn) => { handlers[type] = fn; }, contains: () => true };
    const editor = new E({ container, tt: t => t, t: () => 'levels', pickTrack: () => Promise.resolve(null) });
    editor.load({ enabled: true, entries: [
        { type: 'track', name: 'A', fadeIn: 1 },
        { type: 'silence', duration: 5 },
        { type: 'palette', duration: 60, fadeIn: 2, fadeOut: 4, layers: [
            { volume: 90, pitch: 100, pan: 0, pool: [{ type: 'track', name: 'B' }, { type: 'silence', duration: 3 }] }
        ] }
    ] });

    // onChange writes the model back into the control, so a key it does not
    // handle presents as a field that refuses to be typed in -- which is how a
    // missing fadeIn branch reached a running editor.
    const inRange = { duration: 3, fadeIn: 3, fadeOut: 3, volume: 70, pitch: 120, pan: -20 };
    const paths = [];
    editor.container.innerHTML.replace(/<input[^>]*>/g, tag => {
        if (/type="number"/.test(tag)) {
            const m = tag.match(/data-path="([^"]+)"/);
            if (m) paths.push(m[1]);
        }
        return tag;
    });
    assert.ok(paths.some(p => p.endsWith('.fadeIn')), 'the sweep reaches a fade-in field');
    assert.ok(paths.length >= 8, 'the sweep reaches every row type: ' + paths.length);
    for (const path of paths) {
        const key = path.split('.').pop();
        assert.ok(key in inRange, path + ' has no known-good value; add one');
        const field = { dataset: { path }, value: String(inRange[key]) };
        handlers.change({ target: field });
        assert.equal(Number(field.value), inRange[key], path + ' kept the typed value');
        assert.equal(editor.resolve(path).node, inRange[key], path + ' reached the model');
    }
});

test('Map Properties carries every field the map already has and writes the sequence beside them', async () => {
    const map = { id: 3, name: 'Woods', width: 20, height: 15, data: [1, 2], events: [null], pluginField: { kept: true }, _transient: 1, bgm: { name: 'Old' } };
    const sequence = { enabled: true, entries: [{ type: 'track', name: 'A', fadeIn: 0, volume: 80, pitch: 100, pan: 0 }, { type: 'silence', duration: 2 }] };
    const controller = controllerFor(map, sequence);
    assert.equal(await controller.saveMapProperties(), true);
    const written = controller.written;
    assert.deepEqual(written.pluginField, { kept: true }, 'a field the form does not know survives OK');
    assert.equal('_transient' in written, false, 'editor-only fields do not reach the file');
    assert.deepEqual(written.bgm, { name: 'Fallback', volume: 90, pitch: 100, pan: 0 }, 'the form still owns its own fields');
    assert.deepEqual(written.bgmSequence, sequence);
    assert.equal(written.width, 20);
    assert.deepEqual(written.data, [1, 2]);
});

test('a blank sequence leaves the key off, a disabled one with entries stays, and a bad one blocks the save', async () => {
    const map = { id: 3, name: 'Woods', width: 20, height: 15, data: [], events: [], bgmSequence: { enabled: true, entries: [{ type: 'track', name: 'A' }] } };
    let controller = controllerFor(map, { enabled: false, entries: [] });
    assert.equal(await controller.saveMapProperties(), true);
    assert.equal('bgmSequence' in controller.written, false);

    controller = controllerFor(map, { enabled: false, entries: [{ type: 'silence', duration: 0 }] });
    assert.equal(await controller.saveMapProperties(), true, 'disabled is not validated');
    assert.deepEqual(controller.written.bgmSequence, { enabled: false, entries: [{ type: 'silence', duration: 0 }] });

    controller = controllerFor(map, { enabled: true, entries: [{ type: 'silence', duration: 0 }] });
    assert.equal(await controller.saveMapProperties(), false);
    assert.deepEqual(controller.alerts, ['Entry 1: a silence needs a duration above zero.']);
    assert.equal(controller.values['map-bgm-sequence-checkbox'].focused, true);
    assert.equal(controller.written, undefined, 'nothing was written');
});

test('the form, the script and the strings are wired', () => {
    const html = read('index.html');
    assert.match(html, /id="map-bgm-sequence-checkbox"/);
    assert.match(html, /id="map-bgm-sequence-editor"/);
    assert.match(html, /<script src="src\/utils\/BgmSequenceEditor\.js"><\/script>/);
    const controller = read('src/ProjectController.js');
    assert.match(controller, /this\._bindMapPropertiesListener\('map-bgm-sequence-checkbox', 'change'/);
    assert.match(controller, /this\.populateBgmSequenceForm\(mapData\);/);
    const i18n = read('src/I18nManager.js');
    assert.equal((i18n.match(/'mapProps\.bgmSequence': /g) || []).length, 18, 'English and the 17 locales');
});
