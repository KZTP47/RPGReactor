// Inspector editing and actual title-menu focus on a disposable project.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebDriverClient } = require('./webdriver-client.cjs');
const root = path.resolve(__dirname, '../../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ui-quality-'));
const project = path.join(temp, 'Demo');
const source = path.join(root, 'template/Demo');
const driver = new WebDriverClient(path.join(process.env.NWJS_SDK_ROOT || path.join(root, 'nwjs-linux'), 'chromedriver'));

async function launch(app, profile) {
    await driver.start();
    await driver.createSession({ browserName: 'chrome', 'goog:chromeOptions': { args: [
        `nwapp=${app}`, `user-data-dir=${path.join(temp, profile)}`, 'no-first-run'
    ] } });
    await driver.setScriptTimeout(60000);
}

(async () => {
    try {
        fs.mkdirSync(project);
        for (const file of ['index.html', 'package.json', 'project.rpgreactor']) fs.copyFileSync(path.join(source, file), path.join(project, file));
        for (const folder of ['data', 'js']) fs.cpSync(path.join(source, folder), path.join(project, folder), { recursive: true });
        for (const folder of ['img', 'audio', 'fonts', 'icon', 'effects', '3d', 'css']) {
            if (fs.existsSync(path.join(source, folder))) fs.symlinkSync(path.join(source, folder), path.join(project, folder));
        }
        const records = JSON.parse(fs.readFileSync(path.join(project, 'data/UserInterfaces.json')));
        const title = records.find(r => r?.stock === 'title');
        assert.ok(title);
        const systemPath = path.join(project, 'data/System.json');
        const system = JSON.parse(fs.readFileSync(systemPath));
        system.reactorTitleInterfaceId = title.id;
        fs.writeFileSync(systemPath, JSON.stringify(system));
        await launch(path.join(root, 'editor'), 'editor-profile');
        await driver.waitForScript('return !!window.reactor?.databaseEditorUI;', [], { timeout: 90000 });
        const result = await driver.executeAsync(`
            const projectPath = arguments[0], done = arguments[arguments.length - 1];
            (async () => {
                const app = reactor, project = await app.projectManager.loadProject(projectPath);
                await app.databaseManager.loadAllData(projectPath);
                app.projectController.currentProject = project;
                app.projectController.projectLoaded = true;
                app.openDatabase('userInterfaces');
                const record = app.databaseManager.getUserInterfaces().find(r => r?.stock === 'title');
                app.databaseEditorUI.showDatabaseDetail(record, 'userInterfaces');
                const ui = app.databaseEditorUI.userInterfaceEditor;
                const button = ui.current.nodes.find(n => n.type === 'button');
                ui.select(button.id);
                const panel = ui.wrapper.querySelector('.rr-ui-props');
                const before = JSON.stringify(ui.current.nodes);
                for (const section of panel.querySelectorAll('details')) section.open = true;
                if (JSON.stringify(ui.current.nodes) !== before) throw Error('Expanding settings changed data');
                if (panel.textContent.includes('Inherit')) throw Error('Old inheritance language remains');
                const color = panel.querySelector('.p-focusedTextColor').closest('.rr-ui-color-option');
                const mode = color.querySelector('select'), swatch = color.querySelector('input[type=color]');
                mode.value = 'custom'; mode.dispatchEvent(new Event('change', { bubbles: true }));
                swatch.value = '#123456'; swatch.dispatchEvent(new Event('input', { bubbles: true }));
                if (button.focusedTextColor !== '#123456') throw Error('Color picker did not update the selected button');
                mode.value = 'default'; mode.dispatchEvent(new Event('change', { bubbles: true }));
                if (button.focusedTextColor !== '') throw Error('Default did not clear the override');
                for (const type of ['box', 'image', 'text', 'button', 'list', 'gauge']) {
                    const node = DatabaseUserInterfaceEditor.defaultNode(type, 1000);
                    ui.current.nodes.push(node); ui.select(1000);
                    ui.applyProperties();
                    ui.current.nodes.pop();
                }
                // Exercise the normal dialog commit and native project save.
                ui.select(button.id);
                document.getElementById('database-ok-btn').click();
                return await app.projectController.saveProject();
            })().then(done, error => done({ error: String(error.stack) }));
        `, [project]);
        assert.equal(result, true);
        await driver.close();
        await launch(project, 'game-profile');
        await driver.waitForScript('return window.SceneManager?._scene?._nodeWindows?.some(w => w._uiFocused);', [], { timeout: 90000 });
        await driver.waitForScript('return SceneManager._scene._fadeDuration === 0;', [], { timeout: 10000 });
        const focus = await driver.execute(`
            const scene = SceneManager._scene;
            const before = scene.focusedWindow();
            const result = { fill: before.node().fill, cursorWidth: before._cursorRect.width,
                cursorHeight: before._cursorRect.height, visible: before._cursorSprite.visible, alpha: before._cursorSprite.alpha };
            scene.moveFocus('down');
            result.moved = scene.focusedWindow() !== before;
            result.oldCursorWidth = before._cursorRect.width;
            result.newCursorWidth = scene.focusedWindow()._cursorRect.width;
            return result;
        `);
        assert.equal(focus.fill, 'none');
        assert.ok(focus.cursorWidth > 0 && focus.cursorHeight > 0 && focus.visible && focus.alpha > 0);
        assert.equal(focus.moved, true);
        assert.equal(focus.oldCursorWidth, 0);
        assert.ok(focus.newCursorWidth > 0);
        if (process.env.RR_UI_SCREENSHOT) fs.writeFileSync(process.env.RR_UI_SCREENSHOT, Buffer.from(await driver.sessionRequest('GET', '/screenshot'), 'base64'));
        console.log('User Interface quality smoke passed: inspector fields, default/custom color, native save and title cursor navigation.');
    } finally {
        await driver.close();
        fs.rmSync(temp, { recursive: true, force: true });
    }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
