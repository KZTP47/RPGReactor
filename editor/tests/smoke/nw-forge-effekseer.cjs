// Real GPU regression: another preview changes Effekseer's shared GL context.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebDriverClient } = require('./webdriver-client.cjs');

const root = path.resolve(__dirname, '../../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-forge-effekseer-smoke-'));
const driver = new WebDriverClient(path.join(process.env.NWJS_SDK_ROOT || path.join(root, 'nwjs-linux'), 'chromedriver'));

(async () => {
    try {
        await driver.start();
        await driver.createSession({ browserName: 'chrome', 'goog:chromeOptions': { args: [
            `nwapp=${path.join(root, 'editor')}`, `user-data-dir=${path.join(temp, 'profile')}`, 'no-first-run'
        ] } });
        await driver.setScriptTimeout(60000);
        await driver.waitForScript('return !!window.reactor?.forgeManager && window._effekseerReady;', [], { timeout: 90000 });
        await driver.execute(`
            window.__efkErrors = [];
            addEventListener('error', e => __efkErrors.push(String(e.error?.stack || e.message)));
            const report = console.error;
            console.error = (...args) => { __efkErrors.push(args.map(String).join(' ')); report(...args); };
            window.__otherGL = document.createElement('canvas').getContext('webgl');
            window.__otherContext = effekseer.createContext();
            __otherContext.init(__otherGL);
            reactor.forgeManager.openTool('effekseer-generator');
        `);
        for (const recipe of ['geo-cube', 'geo-dodecahedron', 'geo-helix', 'geo-hypercube', 'fire-burst', 'energy-field']) {
            await driver.execute(`
                const g = reactor.forgeManager.effekseerGenerator;
                window.__previousEffect = g._efkEffect;
                g._stack = [{ recipeId: arguments[0], values: {}, start: 0, end: 0 }];
                g._loadCurrentEffect();
            `, [recipe]);
            await driver.waitForScript(`const g = reactor.forgeManager.effekseerGenerator;
                return g._efkEffect !== __previousEffect && g._efkEffect?.isLoaded;
            `, [], { timeout: 30000 });
            const result = await driver.executeAsync(`
                const done = arguments[arguments.length - 1], g = reactor.forgeManager.effekseerGenerator;
                const render = g._renderFrame, samples = [];
                let ticks = 0;
                g._renderFrame = function(canvas, label) {
                    __otherContext._makeContextCurrent();
                    render.call(this, canvas, label, () => 1);
                    if (++ticks % 10 === 0) {
                        const gl = this._gl, pixels = new Uint8Array(canvas.width * canvas.height * 4);
                        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                        let lit = 0;
                        for (let i = 0; i < pixels.length; i += 4) if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 15) lit++;
                        samples.push({ tick: ticks, lit, error: gl.getError() });
                    }
                    if (ticks >= 300) { this._renderFrame = render; done(samples); }
                };
                g._play();
            `);
            assert.ok(result.some(s => s.tick <= 100 && s.lit > 100), `${recipe}: first playback black`);
            assert.ok(result.some(s => s.tick >= 200 && s.lit > 100), `${recipe}: later playback black`);
            assert.ok(result.every(s => s.error === 0), `${recipe}: GL error`);
            if (recipe === 'geo-cube') assert.ok(result.every(s => s.lit > 100), 'Continuous cube flickered black');
            console.log(`${recipe}: visible during initial and later playback with a competing context`);
            if (recipe.startsWith('geo-')) {
                const boundary = await driver.execute(`
                    const g = reactor.forgeManager.effekseerGenerator, canvas = g._gl.canvas;
                    const width = canvas.width, height = canvas.height;
                    canvas.width = canvas.height = 180;
                    g._play();
                    let previous = null, previousFrame = 0, ordinary = [], seams = [];
                    for (let i = 0; i < 245; i++) {
                        __otherContext._makeContextCurrent();
                        g._renderFrame(canvas, null, () => 1);
                        const gl = g._gl, pixels = new Uint8Array(180 * 180 * 4);
                        gl.readPixels(0, 0, 180, 180, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                        if (previous) {
                            let difference = 0;
                            for (let j = 0; j < pixels.length; j++) difference += Math.abs(pixels[j] - previous[j]);
                            (g._frame < previousFrame ? seams : ordinary).push(difference);
                        }
                        previous = pixels; previousFrame = g._frame;
                    }
                    canvas.width = width; canvas.height = height;
                    return { seams, maxOrdinary: Math.max(...ordinary) };
                `);
                assert.equal(boundary.seams.length, 2);
                assert.ok(boundary.maxOrdinary > 0, `${recipe}: motion was frozen`);
                assert.ok(boundary.seams.every(delta => delta < boundary.maxOrdinary * 1.5), `${recipe}: loop boundary jumps`);
            }
        }
        await driver.execute(`
            const g = reactor.forgeManager.effekseerGenerator;
            window.__previousEffect = g._efkEffect;
            const duration = g.contentEl.querySelector('.rr-efk-duration');
            duration.value = '24';
            duration.dispatchEvent(new Event('input'));
            duration.dispatchEvent(new Event('change'));
        `);
        await driver.waitForScript(`const g = reactor.forgeManager.effekseerGenerator;
            return g._efkEffect !== __previousEffect && g._efkEffect?.isLoaded;
        `, [], { timeout: 30000 });
        for (const loop of [true, false]) {
            await driver.execute(`
                const g = reactor.forgeManager.effekseerGenerator;
                window.__previousEffect = g._efkEffect;
                const checkbox = g.contentEl.querySelector('.rr-efk-loop');
                checkbox.checked = arguments[0];
                checkbox.dispatchEvent(new Event('change'));
            `, [loop]);
            await driver.waitForScript(`const g = reactor.forgeManager.effekseerGenerator;
                return g._efkEffect !== __previousEffect && g._efkEffect?.isLoaded;
            `, [], { timeout: 30000 });
            const result = await driver.executeAsync(`
                const loop = arguments[0], done = arguments[arguments.length - 1];
                const g = reactor.forgeManager.effekseerGenerator, render = g._renderFrame;
                g._play();
                let ticks = 0, restarts = 0, previous = g._efkHandle;
                g._renderFrame = function(canvas, label) {
                    __otherContext._makeContextCurrent();
                    render.call(this, canvas, label, () => 1);
                    if (previous !== this._efkHandle) restarts++;
                    previous = this._efkHandle;
                    if (++ticks === 72) {
                        this._renderFrame = render;
                        done({ restarts, frame: this._frame, playing: this._playing });
                    }
                };
            `, [loop]);
            assert.deepEqual(result, { restarts: loop ? 2 : 0, frame: 24, playing: loop });
        }
        await driver.execute(`
            const g = reactor.forgeManager.effekseerGenerator;
            window.__previousEffect = g._efkEffect;
            const checkbox = g.contentEl.querySelector('.rr-efk-loop');
            checkbox.checked = true; checkbox.dispatchEvent(new Event('change'));
        `);
        await driver.waitForScript(`const g = reactor.forgeManager.effekseerGenerator;
            return g._efkEffect !== __previousEffect && g._efkEffect?.isLoaded;
        `, [], { timeout: 30000 });
        const exported = await driver.executeAsync(`
            const folder = arguments[0], done = arguments[arguments.length - 1];
            (async () => {
                const g = reactor.forgeManager.effekseerGenerator;
                g.projectController = { getCurrentProject: () => ({ path: folder }) };
                g.contentEl.querySelector('.rr-efk-name').value = 'finite-loop';
                g._loopPreview = true;
                await g._export();
                const fs = require('fs'), path = require('path');
                const bytes = fs.readFileSync(path.join(folder, 'effects/finite-loop.efkefc'));
                const same = bytes.equals(Buffer.from(g._buildBytes()));
                // Play the exported definition once without Forge restarting
                // it: the loaded effect uses these same serialized bytes.
                g._play(); g._playing = false;
                for (let i = 0; i < 40; i++) g._ctxUpdate();
                return { same, ended: !g._efkHandle.exists, bytes: bytes.length };
            })().then(done, error => done({ error: String(error.stack) }));
        `, [temp]);
        assert.equal(exported.same, true, 'Export differs from the compiled loop');
        assert.equal(exported.ended, true, 'Finite exported effect did not terminate');
        assert.ok(exported.bytes > 0);
        console.log('Loop checkbox, custom duration, single playback and finite export passed.');
        for (let i = 0; i < 3; i++) {
            assert.equal(await driver.execute(`
                const g = reactor.forgeManager.effekseerGenerator, old = g._efkContext;
                reactor.forgeManager.close();
                const released = old.nativeptr === null && ![...RREffekseerStateGuard._entries].some(e => e.ctx === old);
                reactor.forgeManager.openTool('effekseer-generator');
                return released;
            `), true, 'Closed preview leaked its context');
            await driver.waitForScript('return reactor.forgeManager.effekseerGenerator._efkEffect?.isLoaded;', [], { timeout: 30000 });
        }
        assert.deepEqual(await driver.execute('return __efkErrors;'), []);
        console.log('NW.js Forge Effekseer smoke passed: competing contexts, playback and repeated close/reopen.');
    } finally {
        await driver.close();
        fs.rmSync(temp, { recursive: true, force: true });
    }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
