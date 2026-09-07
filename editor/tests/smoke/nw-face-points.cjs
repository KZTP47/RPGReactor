// Face landmark card, precision controls, live arrows and sidecar roundtrip.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { WebDriverClient } = require('./webdriver-client.cjs');
const root = path.resolve(__dirname, '../../..'), source = path.join(root, 'template/Demo');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-face-points-')), project = path.join(temp, 'Demo');
const model = '3d/Actors/Fleagus';
const original = fs.readFileSync(path.join(source, model, 'model.json'));
const driver = new WebDriverClient(path.join(process.env.NWJS_SDK_ROOT || path.join(root, 'nwjs-linux'), 'chromedriver'));
(async () => {
    try {
        fs.mkdirSync(project);
        for (const name of ['project.rpgreactor', 'package.json', 'index.html']) fs.copyFileSync(path.join(source, name), path.join(project, name));
        fs.cpSync(path.join(source, 'data'), path.join(project, 'data'), { recursive: true });
        for (const name of ['js', 'img', 'effects', 'audio', 'fonts', 'css', 'icon']) {
            if (fs.existsSync(path.join(source, name))) fs.symlinkSync(path.join(source, name), path.join(project, name), 'junction');
        }
        fs.mkdirSync(path.join(project, model), { recursive: true });
        for (const name of fs.readdirSync(path.join(source, model))) {
            const from = path.join(source, model, name), to = path.join(project, model, name);
            if (fs.statSync(from).isDirectory()) fs.symlinkSync(from, to, 'junction');
            else fs.copyFileSync(from, to);
        }
        await driver.start();
        await driver.createSession({ browserName: 'chrome', 'goog:chromeOptions': { args: [
            `nwapp=${path.join(root, 'editor')}`, `user-data-dir=${path.join(temp, 'profile')}`, 'no-first-run'
        ] } });
        await driver.setScriptTimeout(60000);
        await driver.waitForScript('return !!window.reactor?.databaseEditorUI;', [], { timeout: 90000 });
        assert.equal(await driver.executeAsync(`
            const done = arguments[arguments.length - 1], project = arguments[0];
            window.__faceErrors = [];
            window.addEventListener('error', event => __faceErrors.push(String(event.error || event.message)));
            window.addEventListener('unhandledrejection', event => __faceErrors.push(String(event.reason)));
            (async () => {
                const p = await reactor.projectManager.loadProject(project);
                await reactor.databaseManager.loadAllData(project);
                reactor.projectController.currentProject = p;
                reactor.projectController.projectLoaded = true;
                reactor.openDatabase('reactor3d');
                nw.Window.get().resizeTo(1280, 720);
                window.__faceEditor = reactor.databaseEditorUI.reactor3dEditor;
                return true;
            })().then(done, e => done(String(e.stack)));
        `, [project]), true);
        await driver.waitForScript('return __faceEditor._object && !__faceEditor._loadingPreview;', [], { timeout: 60000 });
        await driver.waitForScript("return getComputedStyle(document.getElementById('splash-screen')).display === 'none';", [], { timeout: 15000 });
        const initial = await driver.execute(`
            const e = __faceEditor; e.setTool('face');
            window.__faceOriginalMarkers = structuredClone(e._rigMarkers);
            return { mode: e._rigFaceMode, card: !!e._detail.querySelector('.r3d-face-card'),
                banner: getComputedStyle(e._detail.querySelector('.r3d-rig-bar')).display,
                arrows: !!e._faceArrows?.root.parent };
        `);
        assert.deepEqual(initial, { mode: true, card: true, banner: 'none', arrows: true });
        await driver.waitForScript("return __faceEditor._detail.querySelectorAll('.r3d-face-coordinates .rr-number-stepper').length === 3 && Math.abs(__faceEditor._camera.aspect - __faceEditor._detail.querySelector('.r3d-db-canvas').getBoundingClientRect().width / __faceEditor._detail.querySelector('.r3d-db-canvas').getBoundingClientRect().height) < 0.01;");
        const precision = await driver.execute(`
            const e = __faceEditor, card = e._detail.querySelector('.r3d-face-card');
            const number = card.querySelector('.r3d-face-number[data-i="0"]');
            const marker = e._rigMarkerMeshes.eyes, arrows = e._faceArrows;
            number.focus(); number.value = '0.123'; number.dispatchEvent(new Event('input', { bubbles: true }));
            const typed = e._rigMarkers.eyes[0];
            number.parentElement.querySelector('button').click();
            const stepped = e._rigMarkers.eyes[0];
            const slider = card.querySelector('.r3d-face-slider[data-i="0"]');
            slider.focus(); slider.value = '0.234'; slider.dispatchEvent(new Event('input', { bubbles: true }));
            const slid = e._rigMarkers.eyes[0], numberAfterSlider = Number(number.value);
            slider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            const reset = e._rigMarkers.eyes[0] === __faceOriginalMarkers.eyes[0];
            const result = { typed, stepped, slid, numberAfterSlider, reset,
                sameMarker: marker === e._rigMarkerMeshes.eyes, sameArrows: arrows === e._faceArrows,
                sameInput: number === card.querySelector('.r3d-face-number[data-i="0"]') };
            number.blur(); slider.blur();
            return result;
        `);
        assert.equal(precision.typed, 0.123); assert.equal(precision.stepped, 0.124);
        assert.equal(precision.slid, 0.234); assert.equal(precision.numberAfterSlider, 0.234);
        for (const key of ['reset', 'sameMarker', 'sameArrows', 'sameInput']) assert.equal(precision[key], true, key);
        const placement = await driver.execute(`
            const e = __faceEditor, canvas = e._detail.querySelector('.r3d-db-canvas');
            const rect = canvas.getBoundingClientRect(), arrows = e._faceArrows;
            const start = arrows.root.getWorldPosition(new THREE.Vector3());
            let picked = null, pointer = null;
            for (const axis of ['x', 'y', 'z']) {
                const at = start.clone(); at[axis] += arrows.length * 0.8;
                const p = at.project(e._camera);
                const x = rect.left + (p.x + 1) * rect.width / 2, y = rect.top + (1 - p.y) * rect.height / 2;
                const hold = e._pickFacePointArrow(x, y);
                if (hold && !e._rigMarkerUnderPointer(x, y)) { picked = hold; pointer = { x, y }; break; }
            }
            if (!picked) return { error: 'No pickable arrow' };
            e._detail.querySelector('.r3d-face-number').focus();
            canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: pointer.x, clientY: pointer.y }));
            const captured = !!e._faceArrowHold;
            window.dispatchEvent(new PointerEvent('pointermove', { clientX: pointer.x + 12, clientY: pointer.y - 8 }));
            window.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: pointer.x + 12, clientY: pointer.y - 8 }));
            const end = arrows.root.getWorldPosition(new THREE.Vector3());
            return { captured, moved: end.distanceTo(start) > 0.00001,
                otherAxesStill: ['x','y','z'].filter(a => a !== picked.grab.axis).every(a => Math.abs(end[a] - start[a]) < 1e-8),
                released: e._faceArrowHold === null,
                numbersSynced: [...e._detail.querySelectorAll('.r3d-face-number')].every(n => Math.abs(Number(n.value) - e._rigMarkers.eyes[Number(n.dataset.i)]) < 0.000051) };
        `);
        assert.deepEqual(placement, { captured: true, moved: true, otherAxesStill: true, released: true, numbersSynced: true });
        const saved = await driver.execute(`
            const e = __faceEditor;
            for (const [i, key] of ['eyes', 'mouth', 'upperLip', 'lowerLip'].entries()) {
                const pick = e._detail.querySelector('.r3d-face-point');
                pick.value = key; pick.dispatchEvent(new Event('change', { bubbles: true }));
                const field = e._detail.querySelector('.r3d-face-number[data-i="2"]');
                field.value = String(0.05 + i * 0.01); field.dispatchEvent(new Event('input', { bubbles: true }));
            }
            const retired = e._detail.querySelector('.r3d-face-number[data-i="0"]');
            for (const key of ['eyes', 'lowerLip']) {
                const pick = e._detail.querySelector('.r3d-face-point');
                pick.value = key; pick.dispatchEvent(new Event('change', { bubbles: true }));
            }
            const beforeStale = e._rigMarkers.lowerLip[0];
            retired.value = '999'; retired.dispatchEvent(new Event('input', { bubbles: true }));
            if (e._rigMarkers.lowerLip[0] !== beforeStale) return { error: 'Retired field changed the marker' };
            const expected = structuredClone(e._rigMarkers);
            const arrows = e._faceArrows;
            e._detail.querySelector('.r3d-face-save').click();
            e._detail.querySelector('.r3d-face-close').click();
            const cleaned = !arrows.root.parent && e._faceArrows === null;
            e.setTool('face');
            const reopened = Object.keys(expected).every(key => expected[key].every((v,i) => Math.abs(v - e._rigMarkers[key][i]) < 1e-8));
            return { cleaned, reopened };
        `);
        assert.deepEqual(saved, { cleaned: true, reopened: true });
        const originalData = JSON.parse(original), savedData = JSON.parse(fs.readFileSync(path.join(project, model, 'model.json')));
        delete originalData.landmarks; delete savedData.landmarks;
        assert.deepEqual(savedData, originalData, 'face save preserves the rest of model.json');
        for (const [width, height] of [[1280, 720], [1920, 1080]]) {
            await driver.execute('nw.Window.get().resizeTo(arguments[0], arguments[1]);', [width, height]);
            await driver.waitForScript('return window.innerWidth >= arguments[0] - 40;', [width]);
            const layout = await driver.execute(`
                const e = __faceEditor, card = e._detail.querySelector('.r3d-face-card');
                const r = card.getBoundingClientRect(), v = e._detail.querySelector('.r3d-canvas-wrap').getBoundingClientRect();
                return { contained: r.left >= v.left + 40 && r.right <= v.right && r.top >= v.top && r.bottom <= v.bottom,
                    overflow: card.scrollWidth > card.clientWidth + 1,
                    clearPreview: e._detail.querySelector('.r3d-db-canvas').getBoundingClientRect().right <= r.left,
                    fields: [...card.querySelectorAll('select,input')].every(n => n.getBoundingClientRect().width > 20) };
            `);
            assert.deepEqual(layout, { contained: true, overflow: false, clearPreview: true, fields: true });
            fs.writeFileSync(path.join(os.tmpdir(), `rr-face-points-${width}.png`), Buffer.from(await driver.sessionRequest('GET', '/screenshot'), 'base64'));
        }
        const clean = await driver.execute(`
            const e = __faceEditor, arrows = e._faceArrows;
            e._disposePreview();
            return { removed: !arrows.root.parent && e._faceArrows === null, errors: __faceErrors };
        `);
        assert.deepEqual(clean, { removed: true, errors: [] });
        console.log('Face points passed: card layout at 720p/1080p, sliders and steppers, axis pointer drag, all four points, save/reopen, rig preservation and cleanup.');
    } finally {
        await driver.close();
        assert.deepEqual(fs.readFileSync(path.join(source, model, 'model.json')), original, 'authored Demo remains untouched');
        fs.rmSync(temp, { recursive: true, force: true });
    }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
