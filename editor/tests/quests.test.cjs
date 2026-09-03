/**
 * Quests (GitHub #9): a Reactor database tab, the runtime's saved progress
 * and rules, the quest log, and the import from VisuStella's Quest System.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..', '..');
const read = relative => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

/** The runtime module over stubs of everything it aliases. */
function loadRuntime(dataQuests, world = {}) {
    const registered = {};
    const stub = () => function() {};
    const proto = { prototype: {} };
    const context = {
        console,
        window: null,
        $dataQuests: undefined,
        $dataSystem: world.system || { reactorQuests: {} },
        $gameSwitches: { value: id => !!(world.switches || {})[id] },
        $gameVariables: { value: id => (world.variables || {})[id] || 0 },
        Utils: { isNwjs: () => false },
        XMLHttpRequest: function() { this.open = () => {}; this.overrideMimeType = () => {}; this.send = () => this.onload && this.onload(); this.status = 404; },
        PluginManager: { registerCommand: (plugin, name, fn) => { registered[name] = fn; } },
        Game_System: { prototype: {} },
        Game_Map: { prototype: { update: stub() } },
        Window_MenuCommand: { prototype: { addOriginalCommands: stub() } },
        Scene_Menu: { prototype: { createCommandWindow: stub() } },
        Scene_MenuBase: { prototype: { create: stub(), update: stub() } },
        Scene_Boot: { prototype: { create: stub(), isReady: () => true } },
        Window_HorzCommand: { prototype: { initialize: stub(), update: stub() } },
        Window_Selectable: { prototype: { initialize: stub(), refresh: stub(), select: stub() } },
        Rectangle: stub(),
        SceneManager: { push: scene => { context.__pushed = scene; } },
        Input: { isRepeated: () => false },
        Graphics: { boxWidth: 816 },
        Bitmap: stub()
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(read('runtime/reactor_quests.js'), context);
    context.$dataQuests = dataQuests;
    context.ReactorQuests._state = 'done';
    const system = Object.create(context.Game_System.prototype);
    context.$gameSystem = system;
    return { context, system, quests: system.quests(), registered, run: (name, args) => registered[name].call({}, args) };
}

const DATA = [null,
    { id: 1, key: 'welcome', name: 'Welcome', category: 'Main', objectives: [{ text: 'Talk', hidden: false, switchId: 0 }, { text: 'Secret', hidden: true, switchId: 0 }, { text: 'Flip', hidden: false, switchId: 7 }], rewards: [{ text: 'Potion', hidden: false }, { text: 'Ether', hidden: true }], activation: { type: 'command' }, completion: { type: 'objectives' } },
    { id: 2, key: 'auto', name: 'At start', category: 'Side', objectives: [], rewards: [], activation: { type: 'start' }, completion: { type: 'command' } },
    { id: 3, key: 'flag', name: 'By switch', category: 'Side', objectives: [{ text: 'x', hidden: false, switchId: 0 }], rewards: [], activation: { type: 'switch', switchId: 5 }, completion: { type: 'switch', switchId: 6 } },
    { id: 4, key: 'count', name: 'By variable', category: 'Main', objectives: [], rewards: [], activation: { type: 'variable', variableId: 2, operator: '>=', value: 3 }, completion: { type: 'command' } }
];

test('progress lives on Game_System, a quest is hidden until discovered, and objectives keep their authored visibility', () => {
    const { quests, context } = loadRuntime(DATA);
    assert.equal(quests.status(1), 'hidden');
    assert.equal(quests.isKnown(1), false);
    assert.equal(quests.discover('welcome'), true, 'by key as well as by id');
    assert.equal(quests.discover(1), false, 'a second discovery changes nothing');
    assert.equal(quests.status(1), 'known');
    assert.deepEqual([...quests.objectiveStates(1)], ['open', 'hidden', 'open']);
    assert.deepEqual([...quests.rewardsShown(1)], [true, false]);
    assert.deepEqual([...quests.known().map(q => q.id)], [1]);
    assert.equal(context.$gameSystem.quests(), quests, 'the same record every time');
    assert.equal(quests instanceof context.Game_Quests, true, 'a named class, so JsonEx restores it from a save');
});

test('objectives and rewards change one at a time or all at once, and "every shown objective" completes the quest', () => {
    const { quests } = loadRuntime(DATA);
    quests.setObjective(1, 0, 'complete');
    assert.deepEqual([...quests.objectiveStates(1)], ['done', 'hidden', 'open']);
    assert.equal(quests.status(1), 'known', 'the third objective is still open');
    quests.setObjective(1, 2, 'complete');
    assert.equal(quests.status(1), 'completed', 'the hidden one does not count');
    quests.reset(1);
    assert.equal(quests.status(1), 'hidden');
    quests.setObjective(1, 'all', 'show');
    assert.deepEqual([...quests.objectiveStates(1)], ['open', 'open', 'open'], 'showing every objective discovers the quest first');
    quests.setObjective(1, 1, 'fail');
    assert.deepEqual([...quests.objectiveStates(1)], ['open', 'failed', 'open']);
    quests.setReward(1, 1, true);
    assert.deepEqual([...quests.rewardsShown(1)], [true, true]);
    quests.setReward(1, 'all', false);
    assert.deepEqual([...quests.rewardsShown(1)], [false, false]);
    assert.equal(quests.setObjective(1, 9, 'complete'), false, 'an index past the list is refused');
});

test('the rules run on the map: start, switch and variable activation; switch-driven objectives and completion', () => {
    const world = { switches: {}, variables: {} };
    const { quests } = loadRuntime(DATA, world);
    quests.update();
    assert.deepEqual([...quests.known().map(q => q.id)], [2], 'only the start-of-game quest appears');
    world.switches[5] = true;
    quests.update();
    assert.deepEqual([...quests.known().map(q => q.id)], [2, 3], 'the switch quest appears when its switch is on');
    world.variables[2] = 2;
    quests.update();
    assert.equal(quests.isKnown(4), false);
    world.variables[2] = 3;
    quests.update();
    assert.equal(quests.isKnown(4), true, 'at or past the value');
    quests.discover(1);
    world.switches[7] = true;
    quests.update();
    assert.deepEqual([...quests.objectiveStates(1)], ['open', 'hidden', 'done'], 'an objective bound to a switch completes on its own');
    assert.equal(quests.status(1), 'known', 'but the first objective is still open');
    world.switches[6] = true;
    quests.update();
    assert.equal(quests.status(3), 'completed', 'a quest completing by switch');
});

test('tracking follows one active quest and lets go when it ends', () => {
    const { quests } = loadRuntime(DATA);
    quests.setTracked(1);
    assert.equal(quests.tracked(), 0, 'a hidden quest cannot be tracked');
    quests.discover(1);
    quests.setTracked(1);
    assert.equal(quests.tracked(), 1);
    quests.complete(1);
    assert.equal(quests.tracked(), 0);
    assert.deepEqual([...quests.completed().map(q => q.id)], [1]);
    quests.fail(3);
    assert.deepEqual([...quests.failed().map(q => q.id)], [3]);
});

test('the plugin commands drive the record and open the log', () => {
    const { quests, run, context } = loadRuntime(DATA);
    run('QuestSet', { questId: '1', action: 'discover' });
    assert.equal(quests.status(1), 'known');
    run('QuestObjective', { questId: 'welcome', objective: '1', state: 'complete' });
    assert.equal(quests.objectiveStates(1)[0], 'done');
    run('QuestObjective', { questId: '1', objective: 'all', state: 'show' });
    assert.equal(quests.objectiveStates(1)[1], 'open');
    run('QuestReward', { questId: '1', reward: '2', state: 'show' });
    assert.equal(quests.rewardsShown(1)[1], true);
    run('QuestSet', { questId: '1', action: 'track' });
    assert.equal(quests.tracked(), 1);
    run('QuestSet', { questId: '1', action: 'untrack' });
    assert.equal(quests.tracked(), 0);
    run('OpenQuestLog', { questId: '1' });
    assert.equal(context.__pushed, context.Scene_Quest);
    assert.equal(context.Scene_Quest.openOn, 1);
    run('QuestSet', { questId: '99', action: 'discover' });
    assert.equal(quests.known().length, 1, 'an unknown quest is ignored');
});

test('the main menu offers the log only when the project has quests and has not turned it off', () => {
    const { context } = loadRuntime(DATA, { system: { reactorQuests: { menuCommand: true, commandName: 'Journal' } } });
    assert.equal(context.ReactorQuests.menuEnabled(), true);
    assert.equal(context.ReactorQuests.settings().commandName, 'Journal');
    context.$dataSystem.reactorQuests.menuCommand = false;
    assert.equal(context.ReactorQuests.menuEnabled(), false);
    const { context: empty } = loadRuntime([null]);
    assert.equal(empty.ReactorQuests.menuEnabled(), false, 'nothing to show');
    assert.deepEqual([...context.ReactorQuests.categoriesOf(DATA.filter(Boolean))], ['Main', 'Side']);
});

test('the runtime file is in the manifest between the interfaces and compatibility, and the boot waits for its data', () => {
    const main = read('runtime/reactor_main.js');
    const scripts = main.match(/const\s+scriptUrls\s*=\s*(\[[\s\S]*?\]);/)[1];
    const at = name => scripts.indexOf(`"js/${name}"`);
    assert.ok(at('reactor_ui.js') < at('reactor_quests.js') && at('reactor_quests.js') < at('reactor_mv_compat.js'));
    for (const file of ['editor/build-scripts/build.js', 'editor/build-scripts/build-worker.js', 'editor/build-scripts/dist-editor-worker.js']) {
        assert.match(read(file), /'reactor_quests\.js'/, `${file} ships it`);
    }
    const runtime = read('runtime/reactor_quests.js');
    assert.match(runtime, /Scene_Boot\.prototype\.isReady = function\(\) \{\n\s*return _Scene_Boot_isReady\.apply\(this, arguments\) && ReactorQuests\.isReady\(\);/);
    assert.match(runtime, /Game_Map\.prototype\.update = function\(sceneActive\)/);
});

// --- the importer --------------------------------------------------------

function loadImporter() {
    const context = { console, module: undefined, globalThis: undefined, require };
    context.globalThis = context;
    vm.runInNewContext(read('editor/src/database/QuestImporter.js') + '\n;globalThis.__Q = QuestImporter;', context);
    return context.__Q;
}

/** A Categories parameter built the way the plugin stores it: JSON in JSON in JSON. */
function visustellaParameter(categories) {
    const note = text => JSON.stringify(text);
    return JSON.stringify(categories.map(category => JSON.stringify({
        'CategoryName:str': category.name,
        'Quests:arraystruct': JSON.stringify(category.quests.map(quest => JSON.stringify({
            'Key:str': quest.key, 'Header': '', 'Title:str': quest.title, 'Difficulty:str': quest.difficulty || '',
            'From:str': quest.from || '', 'Location:str': quest.location || '',
            'Description:arrayjson': JSON.stringify((quest.descriptions || []).map(note)),
            'Lists': '', 'Objectives:arrayjson': JSON.stringify((quest.objectives || []).map(note)),
            'VisibleObjectives:arraynum': JSON.stringify((quest.visibleObjectives || []).map(String)),
            'Rewards:arrayjson': JSON.stringify((quest.rewards || []).map(note)),
            'VisibleRewards:arraynum': JSON.stringify((quest.visibleRewards || []).map(String)),
            'Footer': '', 'Subtext:arrayjson': JSON.stringify((quest.subtexts || ['']).map(note)),
            'Quotes:arrayjson': JSON.stringify((quest.quotes || ['']).map(note)),
            'JavaScript': '', 'OnLoadQuestJS:func': JSON.stringify(quest.onLoad || '// Insert JavaScript code here.')
        })))
    })));
}

test('VisuStella quests come out layer by layer: keys, categories, hidden objectives and rewards, the spare texts kept in the note', () => {
    const QuestImporter = loadImporter();
    const raw = visustellaParameter([
        { name: '\\\\C[5]Main Quests', quests: [
            { key: 'Welcome', title: '\\\\i[87]Welcome Quest', difficulty: 'Easy', from: 'VisuStella', location: 'RPG Maker MZ',
              descriptions: ['Thank you for using the \\\\c[4]Quest System\\\\c[0].', 'A second description.'],
              objectives: ['First objective', 'Second, hidden', 'Third'], visibleObjectives: [1, 3],
              rewards: ['\\\\i[176]Potion x5', 'Secret'], visibleRewards: [1],
              subtexts: ['', 'Subtext here'], quotes: ['', 'Quote'], onLoad: 'console.log(1);' }
        ] },
        { name: 'Side', quests: [{ key: 'Errand', title: 'Errand', objectives: ['Go'], visibleObjectives: [1] }] }
    ]);
    const quests = QuestImporter.fromVisustellaCategories(raw);
    assert.equal(quests.length, 2);
    const [welcome, errand] = quests;
    assert.equal(welcome.key, 'Welcome');
    assert.equal(welcome.name, '\\i[87]Welcome Quest', 'one backslash, as the game reads it');
    assert.equal(welcome.category, '\\C[5]Main Quests');
    assert.equal(welcome.difficulty, 'Easy');
    assert.equal(welcome.description, 'Thank you for using the \\c[4]Quest System\\c[0].');
    assert.deepEqual([...welcome.objectives.map(o => [...[o.text, o.hidden]])], [['First objective', false], ['Second, hidden', true], ['Third', false]]);
    assert.deepEqual([...welcome.rewards.map(r => [...[r.text, r.hidden]])], [['\\i[176]Potion x5', false], ['Secret', true]]);
    assert.equal(welcome.subtext, 'Subtext here', 'the first non-empty subtext');
    assert.equal(welcome.quotes, 'Quote');
    assert.match(welcome.note, /<Import: other descriptions>\nA second description\.\n<\/Import>/);
    assert.match(welcome.note, /<Import: on-load script>\nconsole\.log\(1\);\n<\/Import>/);
    assert.equal(welcome.activation.type, 'command', 'VisuStella quests appear by command; nothing else is known about them');
    assert.equal(errand.category, 'Side');
    assert.equal(errand.note, '', 'nothing spare, nothing noted');
    assert.equal(errand.objectives[0].switchId, 0);
});

test('a manifest is read the way the runtime resolves it, and a project without the plugin reads as none', () => {
    const QuestImporter = loadImporter();
    const manifest = `// Generated by RPG Maker.\nvar $plugins =\n[\n{"name":"VisuMZ_2_QuestSystem","status":true,"description":"","parameters":{"Categories:arraystruct":${JSON.stringify(visustellaParameter([{ name: 'A', quests: [{ key: 'k', title: 'T', objectives: ['o'], visibleObjectives: [1] }] }]))}}}\n];\n`;
    const plugins = QuestImporter.parseManifest(manifest);
    assert.equal(plugins.length, 1);
    const entry = QuestImporter.visustellaEntry(plugins);
    assert.ok(entry);
    assert.equal(QuestImporter.fromVisustellaCategories(entry.parameters['Categories:arraystruct']).length, 1);
    assert.equal(QuestImporter.visustellaEntry(QuestImporter.parseManifest('var $plugins = [{"name":"Other"}];')), null);
    assert.equal(QuestImporter.uniqueKey('k', new Set(['k', 'k2'])), 'k3');
    assert.equal(QuestImporter.uniqueKey('', new Set()), 'quest');
});

// --- the editor ------------------------------------------------------------

test('the Quests tab is wired like every other Reactor tab, with its own file that a project only gains once it authors one', () => {
    const manager = read('editor/src/DatabaseManager.js');
    assert.match(manager, /\['quests', 'Quests\.json'\],\n\s*\['system', 'System\.json'\]/);
    assert.match(manager, /if \(!Array\.isArray\(loaded\.quests\) \|\| loaded\.quests\.length === 0\) loaded\.quests = \[null\];/);
    assert.match(manager, /if \(key === 'quests' && !this\.hasQuests\(\)\n\s*&& !this\.fs\.existsSync/);
    for (const method of ['getQuests()', 'getQuest(id)', 'hasQuests()', 'addQuest(record)', 'updateQuest(id, data)']) assert.ok(manager.includes(`    ${method} {`), method);
    const ui = read('editor/src/DatabaseEditorUI.js');
    assert.match(ui, /\{ name: 'Quests', type: 'quests' \},/);
    assert.match(ui, /case 'quests':\n\s*data = this\.databaseManager\.getQuests\(\);/);
    assert.match(ui, /else if \(type === 'quests' && this\.questEditor\) \{\n\s*this\.questEditor\.showQuestDetail\(detailEl, entry\);/);
    assert.match(ui, /quests: \{ name: 'New Quest', key: '', category: ''/);
    assert.match(ui, /'actors', 'enemies', 'quests'\]/, 'the list shows quest icons');
    assert.match(read('editor/src/I18nManager.js'), /quests: 'menu\.quests',/);
    assert.match(read('editor/src/ProjectManager.js'), /'Quests\.json': \[null\],/);
    const index = read('editor/index.html');
    for (const script of ['src/database/QuestImporter.js', 'src/database/DatabaseQuestEditor.js', 'src/event/commands/QuestCommandEditor.js']) assert.ok(index.includes(script), script);
});

test('the quest event commands are offered under Reactor > Game Flow and build the stored shape', () => {
    const picker = read('editor/src/event/EventCommandPicker.js');
    for (const name of ['QuestSet', 'QuestObjective', 'QuestReward', 'OpenQuestLog']) assert.match(picker, new RegExp(`code: 357, reactor: '${name}'`));
    const list = read('editor/src/event/EventCommandList.js');
    assert.match(list, /QuestCommandEditor\.supports\(name\)\) return this\.questCommandEditor;/);
    const context = { console, module: undefined, globalThis: undefined, window: {} };
    context.globalThis = context;
    vm.runInNewContext(read('editor/src/event/commands/QuestCommandEditor.js') + '\n;globalThis.__E = QuestCommandEditor;', context);
    const Editor = context.__E;
    assert.equal(Editor.supports('QuestSet'), true);
    assert.equal(Editor.supports('ShowVideoSurface'), false);
    const built = Editor.build('QuestObjective', { questId: '3', objective: '2', state: 'complete' }, 1);
    assert.equal(built.code, 357);
    assert.equal(built.indent, 1);
    assert.deepEqual([...built.parameters.slice(0, 2)], ['RPGReactor', 'QuestObjective']);
    assert.match(built.parameters[2], /^Quest Objective: #3 #2 → complete$/);
    assert.deepEqual({ ...built.parameters[3] }, { questId: '3', objective: '2', state: 'complete' });
    const log = Editor.build('OpenQuestLog', {}, 0);
    assert.equal(log.parameters[2], 'Open Quest Log');
});

test('the quest form normalizes an old record and writes nested fields and lists', () => {
    const context = { console, module: undefined, globalThis: undefined, window: {}, rrEscapeHtml: v => String(v) };
    context.globalThis = context;
    vm.runInNewContext(read('editor/src/database/DatabaseQuestEditor.js') + '\n;globalThis.__D = DatabaseQuestEditor;', context);
    const Editor = context.__D;
    const quest = Editor.normalize({ id: 4, name: 'Old' });
    assert.deepEqual({ ...quest.activation }, { type: 'command', switchId: 0, variableId: 0, operator: '>=', value: 0 });
    assert.deepEqual({ ...quest.completion }, { type: 'command', switchId: 0 });
    assert.deepEqual([...quest.objectives], []);
    const store = { 4: quest };
    const editor = new Editor({ getQuest: id => store[id], updateQuest: (id, data) => { store[id] = data; }, getSystem: () => ({ switches: [], variables: [] }) }, {}, null, null);
    editor.updateQuestField(4, 'activation.type', 'switch');
    editor.updateQuestField(4, 'activation.value', '12');
    editor.updateQuestField(4, 'key', '  hero-1 ');
    assert.equal(store[4].activation.type, 'switch');
    assert.equal(store[4].activation.value, 12);
    assert.equal(store[4].key, 'hero-1');
    editor.writePath(store[4], 'objectives.0.switchId', 9);
    assert.equal(store[4].objectives[0].switchId, 9, 'a list entry is created on the way');
});
