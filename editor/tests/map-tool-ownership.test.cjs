const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Preview = require('../src/MediaSurfacePreviewManager.js');

function fixture() {
    const window = {};
    const document = { querySelector: () => null, querySelectorAll: () => [] };
    const source = fs.readFileSync(require.resolve('../src/main.js'), 'utf8').split('// Initialize the application')[0];
    const Reactor = vm.runInNewContext(source + '\nRPGReactor', { window, document });
    const app = window.reactor = Object.create(Reactor.prototype);
    app.mapEditor = { enabled: true, currentTool: 'pencil', setEnabled(value) { this.enabled = value; }, setTool(value) { this.currentTool = value; } };
    app.projectController = {};
    app.mediaSurfaceManager = { panel: null, close() { this.panel = null; app.releaseMapTool('media'); } };
    app.lightingManager = { active: false, setActive(value) { this.active = value; if (!value) { app.mapEditor.enabled = true; app.releaseMapTool('lighting'); } } };
    app.modelPropsManager = { active: false, deactivate() { this.active = false; app.mapEditor.enabled = true; } };
    app.eventManager = { eventMode: false, setEventMode(value) { if (value) app.claimMapTool('events'); this.eventMode = value; } };
    app.tilesetPaletteViewer = { currentLayer: 'A', lastPaintLayer: 'A', selectLayer(layer) {
        this.currentLayer = layer;
        app.claimMapTool(layer === 'M' ? 'models' : 'paint');
        if (layer === 'M') app.modelPropsManager.active = true;
    } };
    return app;
}

test('tool handoff overrides old painting-resume flags and does not recursively reopen tools', () => {
    const app = fixture();
    app.tilesetPaletteViewer.selectLayer('M');
    app.eventManager.setEventMode(true);
    assert.equal(app.mapTool, 'events');
    assert.equal(app.modelPropsManager.active, false);
    assert.equal(app.mapEditor.enabled, false);
    app.eventManager.setEventMode(false);
    app.releaseMapTool('events');
    assert.equal(app.mapTool, 'models');
    assert.equal(app.modelPropsManager.active, true);
    assert.equal(app.mapEditor.enabled, false);
    app.claimMapTool('media');
    app.mediaSurfaceManager.panel = {};
    app.claimMapTool('lighting');
    app.lightingManager.active = true;
    assert.equal(app.mediaSurfaceManager.panel, null);
    assert.equal(app.mapEditor.enabled, false);
    app.claimMapTool('none');
    assert.equal(app.mapTool, 'none');
    assert.equal(app.lightingManager.active, false);
    assert.equal(app.modelPropsManager.active, false);
    assert.equal(app.mapEditor.enabled, false);
    app.claimMapTool('paint');
    assert.equal(app.tilesetPaletteViewer.currentLayer, 'A');
    assert.equal(app.mapEditor.enabled, true);
});

test('media draft controls retain input while saved surfaces yield to other tools', () => {
    const pc = { eventManager: { eventMode: true }, mediaSurfaceManager: { panel: null } };
    const preview = new Preview(pc, null);
    const saved = { record: {}, mesh: {}, surface: { style: {} } };
    const draft = { record: { authoring: true }, mesh: {}, surface: { style: {} } };
    preview.pixiOwners.set('saved', saved); preview.pixiOwners.set('draft', draft);
    preview.domOwners.set('saved', saved); preview.domOwners.set('draft', draft);
    preview.authoring = {};
    preview.syncToolInteraction();
    assert.equal(saved.mesh.eventMode, 'none');
    assert.equal(saved.surface.style.pointerEvents, 'none');
    assert.equal(draft.mesh.eventMode, 'static');
    assert.equal(draft.surface.style.pointerEvents, 'auto');
    pc.eventManager.eventMode = false; pc.mediaSurfaceManager.panel = {};
    preview.syncToolInteraction();
    assert.equal(saved.mesh.eventMode, 'none', 'saved surfaces cannot steal a draft drag');
    preview.authoring = null;
    preview.syncToolInteraction();
    assert.equal(saved.mesh.eventMode, 'static');
    assert.equal(saved.surface.style.pointerEvents, 'auto');
});
