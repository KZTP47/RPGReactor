/**
 * The map editor paints through surfaces it does not own.
 *
 * The region overlay and the 3D object overlay are each built around a
 * TilemapManager, and that is rebuilt per project — so a reference kept across
 * a project switch points at the map before last. The editor holds one of each.
 *
 * Reported as "I cannot paint object designations on map 242". The object
 * manager was handed to the editor only when the Objects tab was *clicked*, and
 * a tab that is already open is never clicked: open a project with that tab
 * selected, which is where the last session left it, and the editor was holding
 * the manager built for the previous project, or none at all. `paintTile`
 * checks for one and returns quietly when it is missing — no mark, no error, no
 * clue that a click had been received.
 *
 * Checked as source: the wiring lives across a controller, a palette and a DOM
 * that none of these tests stand up.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const editorRoot = path.resolve(__dirname, '..');
const controller = fs.readFileSync(
    path.join(editorRoot, 'src', 'ProjectController.js'), 'utf8');
const main = fs.readFileSync(path.join(editorRoot, 'src', 'main.js'), 'utf8');
const mapEditor = fs.readFileSync(path.join(editorRoot, 'src', 'MapEditor.js'), 'utf8');

function body(source, signature, end) {
    const start = source.indexOf(signature);
    assert.ok(start >= 0, `${signature} is where the test expects it`);
    return source.slice(start, end ? source.indexOf(end, start) : source.indexOf('\n    }', start));
}

test('one place binds every surface the editor paints through', () => {
    const bind = body(controller, 'bindMapEditorSurfaces() {');
    assert.match(bind, /this\.mapEditor\.tilemapManager = this\.tilemapManager/);
    assert.match(bind, /this\.mapEditor\.regionManager = this\.regionManager/);
    assert.match(bind, /this\.mapEditor\.object3DManager = this\.object3DManager/,
        'the one that was missing');
    // The manager reaches back for undo and for the palette's brush.
    assert.match(bind, /this\.object3DManager\.mapEditor = this\.mapEditor/);
    // Doing nothing before the editor exists is what lets it be called from
    // both ends without either having to know the order.
    assert.match(bind, /if \(!this\.mapEditor\) return;/);
});

test('it is called from both ends, so neither has to remember the other', () => {
    // When the surfaces are rebuilt...
    const populate = controller.slice(controller.indexOf('this.regionManager = new RegionManager'));
    assert.match(populate.slice(0, 1200), /this\.bindMapEditorSurfaces\(\);/,
        'after the managers are constructed');
    // ...and when the editor itself arrives.
    assert.match(body(controller, 'setMapEditor(mapEditor) {'),
        /this\.bindMapEditorSurfaces\(\);/);
    // And on a map load, which is where a project switch lands.
    assert.match(main, /this\.projectController\.bindMapEditorSurfaces\(\);/);
});

test('a palette tab that is already open is opened again', () => {
    /*
     * The Regions and Objects tabs do their setting up when they are
     * *selected* — build their panel, make their overlay layer, show it.
     * Nothing selects a tab on a project switch, because it is already the
     * selected one, so the surfaces rebuilt for the new project arrived with no
     * panel and no layer to draw on.
     */
    assert.match(main, /this\.tilesetPaletteViewer\.selectLayer\(this\.tilesetPaletteViewer\.currentLayer \|\| 'A'\);/);
});

test('painting an object still declines quietly when there is genuinely no manager', () => {
    // The guard is not the bug and stays: a project with no 3D surfaces at all
    // must not throw on a stray click. What was wrong was arriving here without
    // a manager in the ordinary case.
    assert.match(mapEditor,
        /if \(this\.object3DManager && this\.object3DManager\.paintCell\(x, y\)\) \{/);
});
