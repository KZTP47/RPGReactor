// The lighting event commands: Switch Light, Transform Light, Change Ambient
// Light. Each is a stock plugin command (357, "RPGReactor") whose argument
// names are a contract with the runtime; the dialogs, the picker and every
// locale must agree on them.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const editorRoot = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(editorRoot, relative), 'utf8');
const LightCommandEditor = require(path.join(editorRoot, 'src', 'event', 'commands', 'LightCommandEditor.js'));

/** The locale tables, loaded the way the editor loads them. */
function loadTables() {
    const sandbox = { window: {}, document: { readyState: 'complete', documentElement: {}, addEventListener() {}, querySelectorAll() { return []; } }, localStorage: { getItem() { return null; }, setItem() {} }, navigator: { language: 'en' }, CustomEvent: class {} };
    sandbox.window.document = sandbox.document;
    sandbox.window.localStorage = sandbox.localStorage;
    return vm.runInNewContext(read('src/I18nReviewedTranslations.js') + '\n' + read('src/I18nManager.js')
        + '\n({ keyed: RR_I18N_STRINGS, commands: RR_EVENT_COMMAND_NAMES, sections: RR_EVENT_SECTION_NAMES, languages: RR_LANGUAGES });', sandbox);
}

test('supports exactly the three lighting commands', () => {
    assert.equal(LightCommandEditor.supports('LightSwitch'), true);
    assert.equal(LightCommandEditor.supports('TransformLight'), true);
    assert.equal(LightCommandEditor.supports('AmbientLight'), true);
    assert.equal(LightCommandEditor.supports('TransformModel3D'), false);
    assert.equal(LightCommandEditor.supports(undefined), false);
    assert.equal(LightCommandEditor.build('Nope', {}), null);
});

test('Switch Light saves a target and one of three states', () => {
    const command = LightCommandEditor.build('LightSwitch', { target: ' #alarm ', state: 'off' }, 2);
    assert.deepEqual(command, {
        code: 357, indent: 2,
        parameters: ['RPGReactor', 'LightSwitch', 'Switch Light', { target: '#alarm', state: 'off' }]
    });
    assert.equal(LightCommandEditor.build('LightSwitch', { target: 'light3', state: 'sideways' }).parameters[3].state, 'on', 'an unknown state falls back to on');
    assert.equal(LightCommandEditor.build('LightSwitch', { target: 'light3', state: 'toggle' }).parameters[3].state, 'toggle');
});

test('Transform Light keeps every field optional and empty means "leave as authored"', () => {
    const args = LightCommandEditor.build('TransformLight', {
        target: 'light3', yaw: '90', intensity: 2, radius: '999', color: '#FF8800', duration: '45.6', wait: true
    }).parameters[3];
    assert.deepEqual(Object.keys(args), ['target', 'x', 'y', 'height', 'yaw', 'pitch', 'radius', 'angle', 'width', 'intensity', 'color', 'duration', 'wait', 'reset']);
    assert.equal(args.target, 'light3');
    assert.equal(args.yaw, '90');
    assert.equal(args.intensity, '2');
    assert.equal(args.radius, '60', 'clamped to the slider range');
    assert.equal(args.color, '#ff8800', 'colour normalizes to lowercase hex');
    for (const key of ['x', 'y', 'height', 'pitch', 'angle', 'width']) assert.equal(args[key], '', key + ' is unchanged');
    assert.equal(args.duration, '46');
    assert.equal(args.wait, 'true');
    assert.equal(args.reset, 'false');
    const junk = LightCommandEditor.build('TransformLight', { target: 'a', x: 'abc', color: 'red', duration: -5 }).parameters[3];
    assert.equal(junk.x, '', 'a non-number is unchanged, not zero');
    assert.equal(junk.color, '', 'a non-hex colour is unchanged');
    assert.equal(junk.duration, '0');
    assert.equal(junk.wait, 'false');
});

test('Transform Light with reset saves no values at all', () => {
    const args = LightCommandEditor.build('TransformLight', { target: '#lamps', yaw: 45, color: '#123456', reset: true, duration: 30 }).parameters[3];
    assert.equal(args.reset, 'true');
    assert.equal(args.yaw, '');
    assert.equal(args.color, '');
    assert.equal(args.duration, '30');
});

test('Change Ambient Light saves a 0..1 intensity, a colour, and the same timing', () => {
    const args = LightCommandEditor.build('AmbientLight', { intensity: 0.4, color: '#ffe9c4', duration: 120, wait: 'true' }).parameters[3];
    assert.deepEqual(args, { intensity: '0.4', color: '#ffe9c4', duration: '120', wait: 'true', reset: 'false' });
    const off = LightCommandEditor.build('AmbientLight', { intensity: '', color: '' }).parameters[3];
    assert.equal(off.intensity, '');
    assert.equal(off.color, '');
    const reset = LightCommandEditor.build('AmbientLight', { intensity: 1, reset: 'true' }).parameters[3];
    assert.equal(reset.intensity, '', 'reset drops the values');
    assert.equal(reset.reset, 'true');
    assert.equal(LightCommandEditor.build('AmbientLight', { intensity: 7 }).parameters[3].intensity, '1', 'clamped to 0..1');
});

test('the list summaries read as one line each', () => {
    // The summary speaks the editor's language through window.I18n.
    const english = loadTables().keyed.en;
    global.window = { I18n: { t: key => english[key] || key } };
    assert.equal(LightCommandEditor.summary('LightSwitch', { target: '#alarm', state: 'off' }), '#alarm → Off');
    assert.equal(LightCommandEditor.summary('TransformLight', { target: 'light3', yaw: '90', intensity: '2', duration: '60' }), 'light3: Direction 90°, Intensity 2 · 60f');
    assert.equal(LightCommandEditor.summary('TransformLight', { target: 'light3', reset: 'true', duration: '0' }), 'light3: Reset to authored values');
    assert.equal(LightCommandEditor.summary('TransformLight', { target: 'light3' }), 'light3: (unchanged)');
    assert.equal(LightCommandEditor.summary('AmbientLight', { intensity: '0.25', color: '#9db4ff', duration: '30' }), 'Brightness 25%, #9db4ff · 30f');
    delete global.window;
});

test('the commands are wired into the picker, the list and the page', () => {
    const picker = read('src/event/EventCommandPicker.js');
    assert.match(picker, /title: 'Lighting',\n\s*commands: \[\n\s*\{ name: 'Switch Light', code: 357, reactor: 'LightSwitch' \},\n\s*\{ name: 'Transform Light', code: 357, reactor: 'TransformLight' \},\n\s*\{ name: 'Change Ambient Light', code: 357, reactor: 'AmbientLight' \}/);
    const list = read('src/event/EventCommandList.js');
    assert.match(list, /this\.lightCommandEditor = typeof LightCommandEditor !== 'undefined' \? new LightCommandEditor\(\) : null;/);
    assert.match(list, /LightCommandEditor\.supports\(name\)\) return this\.lightCommandEditor;/);
    assert.match(list, /description = LightCommandEditor\.summary\(params\[1\], params\[3\]\);/);
    assert.match(read('index.html'), /src\/event\/commands\/LightCommandEditor\.js/);
});

test('every dialog string and command name is keyed in every locale', () => {
    const source = read('src/event/commands/LightCommandEditor.js');
    const used = new Set([...source.matchAll(/'(lightcmd\.[A-Za-z]+)'/g)].map(match => match[1]));
    assert.ok(used.size >= 20, 'the dialog is fully keyed (' + used.size + ')');
    const tables = loadTables();
    const locales = tables.languages.map(language => language.id);
    assert.equal(locales.length, 18);
    for (const key of used) {
        for (const locale of locales) {
            assert.ok(tables.keyed[locale] && tables.keyed[locale][key], `${key} exists in ${locale}`);
        }
        // The state words carry the field's own 'lightcmd.on/off/toggle' keys.
    }
    for (const locale of locales) {
        if (locale === 'en') continue;
        for (const name of ['Switch Light', 'Transform Light', 'Change Ambient Light']) {
            assert.ok(tables.commands[locale][name], `${name} is named in ${locale}`);
            assert.notEqual(tables.commands[locale][name], name, `${name} is translated in ${locale}`);
        }
        assert.ok(tables.sections[locale].Lighting, `the Lighting section is named in ${locale}`);
    }
});

test('a new command opens from the picker, which passes the name beside a null command', () => {
    // The picker inserts with show(null, callback, name); a dialog that only
    // read the name off command.parameters returned silently on every insert.
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'event', 'commands', 'LightCommandEditor.js'), 'utf8');
    assert.match(source, /show\(command, callback, nameHint\) \{/);
    assert.match(source, /const name = LightCommandEditor\.supports\(params\[1\]\) \? params\[1\] : nameHint;/);
    const list = fs.readFileSync(path.join(__dirname, '..', 'src', 'event', 'EventCommandList.js'), 'utf8');
    assert.match(list, /reactorEditor\.show\(null, \(built\) => \{[\s\S]*?\}, command\.reactor,/, 'the picker hands the name as the third argument');
});
