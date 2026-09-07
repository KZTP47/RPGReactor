const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const editorRoot = path.resolve(__dirname, '..');

function loadEventCommandList() {
    const source = fs.readFileSync(path.join(editorRoot, 'src', 'event', 'EventCommandList.js'), 'utf8');
    return vm.runInNewContext(`${source}\nEventCommandList;`, {
        console, process, require, nw: {}, window: {}, document: { createElement: () => ({ style: {}, dataset: {} }) }
    });
}

const EventCommandList = loadEventCommandList();

function lister() {
    const instance = Object.create(EventCommandList.prototype);
    instance.collapsedBlocks = new WeakSet();
    return instance;
}

// if A                     0  111
//   showText               1  101
//   if B                   2  111   <- nested
//     showText             3  101
//   end                    4  412
// else                     5  411
//   showText               6  101
// end                      7  412
// showText (after)         8  101
function nestedBranches() {
    return [
        { code: 111, indent: 0, parameters: ['A'] },
        { code: 101, indent: 1, parameters: [] },
        { code: 111, indent: 1, parameters: ['B'] },
        { code: 101, indent: 2, parameters: [] },
        { code: 412, indent: 1, parameters: [] },
        { code: 411, indent: 0, parameters: [] },
        { code: 101, indent: 1, parameters: [] },
        { code: 412, indent: 0, parameters: [] },
        { code: 101, indent: 0, parameters: [] }
    ];
}

test('a block end is matched by indent, not by the first candidate code', () => {
    const list = nestedBranches();
    // The outer branch must close at index 7, not at the nested end on index 4.
    assert.equal(EventCommandList.findBlockEndIndex(list, 0), 7);
    assert.equal(EventCommandList.findBlockEndIndex(list, 2), 4, 'the nested branch closes at its own end');

    // Else is part of the outer structure, not an opener of its own.
    assert.equal(EventCommandList.findBlockEndIndex(list, 5), -1);
    assert.equal(EventCommandList.findBlockEndIndex(list, 8), -1, 'a plain command opens nothing');
});

test('Show Choices and Loop collapse too, each to their own terminator', () => {
    const list = [
        { code: 102, indent: 0, parameters: [['Yes', 'No']] },
        { code: 402, indent: 0, parameters: [0, 'Yes'] },
        { code: 101, indent: 1, parameters: [] },
        { code: 404, indent: 0, parameters: [] },
        { code: 112, indent: 0, parameters: [] },
        { code: 101, indent: 1, parameters: [] },
        { code: 413, indent: 0, parameters: [] }
    ];
    assert.equal(EventCommandList.findBlockEndIndex(list, 0), 3, 'Show Choices closes at 404');
    assert.equal(EventCommandList.findBlockEndIndex(list, 4), 6, 'Loop closes at 413');
});

test('collapsing hides the body through the terminator, and nothing after it', () => {
    const instance = lister();
    const list = nestedBranches();

    assert.equal(instance.collapsedHiddenIndices(list).size, 0, 'nothing hidden by default');

    instance.toggleBlockCollapsed(list[0]);
    const hidden = instance.collapsedHiddenIndices(list);
    assert.deepEqual([...hidden].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(hidden.has(0), false, 'the opener stays visible');
    assert.equal(hidden.has(8), false, 'commands after the block stay visible');
    assert.equal(instance.collapsedBlockSize(list, 0), 7, 'the badge counts the folded rows');
});

test('a nested collapse survives the outer block being folded and reopened', () => {
    const instance = lister();
    const list = nestedBranches();

    instance.toggleBlockCollapsed(list[2]);   // fold the inner branch
    assert.deepEqual([...instance.collapsedHiddenIndices(list)], [3, 4]);

    instance.toggleBlockCollapsed(list[0]);   // fold the outer one too
    assert.deepEqual([...instance.collapsedHiddenIndices(list)].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);

    instance.toggleBlockCollapsed(list[0]);   // reopen the outer
    assert.deepEqual([...instance.collapsedHiddenIndices(list)], [3, 4],
        'the inner branch is still folded');
});

test('collapse follows the command through edits that shift its index', () => {
    const instance = lister();
    const list = nestedBranches();
    const outer = list[0];
    instance.toggleBlockCollapsed(outer);

    // Insert two commands above the branch, as an edit earlier in the page would.
    list.unshift({ code: 101, indent: 0, parameters: [] }, { code: 101, indent: 0, parameters: [] });

    assert.equal(instance.isBlockCollapsed(list[2]), true, 'the same branch is still collapsed');
    assert.deepEqual([...instance.collapsedHiddenIndices(list)].sort((a, b) => a - b), [3, 4, 5, 6, 7, 8, 9],
        'the hidden range moved with it');
    assert.equal(instance.isBlockCollapsed(list[0]), false, 'the inserted command did not inherit the state');
});

test('an unterminated block is left expanded rather than swallowing the rest', () => {
    const instance = lister();
    // A malformed list with no 412 at all: collapsing must not hide to the end.
    const list = [
        { code: 111, indent: 0, parameters: ['A'] },
        { code: 101, indent: 1, parameters: [] }
    ];
    instance.toggleBlockCollapsed(list[0]);
    assert.equal(EventCommandList.findBlockEndIndex(list, 0), -1);
    assert.equal(instance.collapsedHiddenIndices(list).size, 0);
    assert.equal(instance.collapsedBlockSize(list, 0), 0);
});

// 357 Plugin Command                    0
//   657 "Round Count = 1"               1
//   657 "Round Duration = 90"           2
// 357 Plugin Command, no arg rows       3
// 356 legacy plugin command             4
function pluginCommands() {
    return [
        { code: 357, indent: 0, parameters: ['P', 'cmd', 'Do Thing', { a: '1', b: '2' }] },
        { code: 657, indent: 0, parameters: ['Round Count = 1'] },
        { code: 657, indent: 0, parameters: ['Round Duration = 90'] },
        { code: 357, indent: 0, parameters: ['P', 'bare', 'Bare', { c: '3' }] },
        { code: 356, indent: 0, parameters: ['LegacyPlugin doThing 5'] }
    ];
}

test('a plugin command owns exactly its own trailing argument rows', () => {
    const list = pluginCommands();
    assert.equal(EventCommandList.pluginArgsRowCount(list, 0), 2);
    assert.equal(EventCommandList.pluginArgsRowCount(list, 3), 0, 'no 657 rows follow');
    assert.equal(EventCommandList.pluginArgsRowCount(list, 4), 0, 'a 356 never has them');
    assert.equal(EventCommandList.pluginArgsRowCount(list, 1), 0, 'a 657 is not itself an owner');
});

test('argument rows are hidden until their own plugin command is expanded', () => {
    const list = pluginCommands();
    const instance = lister();
    instance.expandedPluginCommands = new Set();

    assert.equal(instance.isPluginArgsExpanded(list, 1), false);
    assert.equal(instance.isPluginArgsExpanded(list, 2), false);

    instance.expandedPluginCommands.add(0);
    assert.equal(instance.isPluginArgsExpanded(list, 1), true);
    assert.equal(instance.isPluginArgsExpanded(list, 2), true);

    // Expanding a different command must not reveal this one's rows.
    instance.expandedPluginCommands = new Set([3]);
    assert.equal(instance.isPluginArgsExpanded(list, 1), false);
});
