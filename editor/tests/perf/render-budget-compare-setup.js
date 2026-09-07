// WebDriver async setup for nw-game-profile.cjs (not a standalone Node script).
// Compares cell light culling and worker-generated colour geometry with both
// disabled, holding scene state, clocks, media and quality settings constant.
// Lighting must be pixel-identical. Geometry differences are reported for visual
// review, not treated as proof of imperceptibility. See docs/PERFORMANCE.md.
const done = arguments[arguments.length - 1];
(async () => {
    const R = Reactor3D;
    const app = Graphics._app;
    const gl = app.renderer.gl;
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const spriteset = SceneManager._scene._spriteset;
    const state = spriteset && spriteset._reactor3d;
    const sleepFrame = () => new Promise(resolve => setTimeout(resolve, 25));
    if (!ext || !state || !state.viewport.isShared()) throw new Error('Requires shared WebGL2 and GPU timer queries');
    const scene = state.scene._scene;
    const appStarted = app.ticker.started, sharedStarted = PIXI.Ticker.shared.started;
    const videos = new Set(Array.from(globalThis.RPGReactorVideoSurfaces?.manager?._owners?.values() || [])
        .map(owner => owner.video).filter(video => video && !video.paused));
    const gridEnabled = R.LightGrid.enabled, detailEnabled = R.GeometryDetail.enabled;
    const gridUniform = R.lightUniforms().rrLightGridEnabled.value;
    const original = R.lightGlsl;
    const originalPlain = R.LIGHT_GLSL;
    const tick = Graphics._tickHandler;
    const realNow = performance.now.bind(performance);
    const realDate = Date.now;
    const frozenNow = realNow(), frozenDate = realDate();
    const lights = R.lightUniforms();
    const materials = new Set();
    scene.traverse(object => {
        for (const m of [].concat(object.material || [])) if (m.__reactorLit) materials.add(m);
    });
    // Model media may own detached video elements outside the surface registry.
    // Freeze texture sources too, including the final decoded frame after pause.
    scene.traverse(object => {
        for (const material of [].concat(object.material || [])) {
            const textures = [material.map, ...Object.values(material.uniforms || {}).map(u => u.value)];
            for (const texture of textures) {
                const video = texture && (texture.image || texture.source?.data);
                if (video instanceof HTMLVideoElement && !video.paused) videos.add(video);
            }
        }
    });
    let variant = 'baseline';
    const keys = new Map();
    for (const m of materials) {
        keys.set(m, m.customProgramCacheKey);
        const previous = m.customProgramCacheKey;
        m.customProgramCacheKey = function() { return previous.call(this) + '|perf-' + variant; };
    }
    function draw() {
        state.viewport.renderPass(state.scene, state.scene.modelsInWorld ? 'world' : 'below', 'below');
        if (spriteset._reactor3dAbove) state.viewport.renderPass(state.scene, state.scene.modelsInWorld ? 'overlay' : 'above', 'above');
        app.render();
    }
    function pixels() {
        draw();
        const result = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
        const was = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, result);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, was);
        return result;
    }
    function diff(a, b) {
        let channels = 0, max = 0, sum = 0;
        for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d) channels++; max = Math.max(max, d); sum += d; }
        return { changedChannels: channels, maxDelta: max, meanDelta: sum / a.length };
    }
    const summary = values => {
        values.sort((a, b) => a - b);
        return { n: values.length, median: values[values.length >> 1], p95: values[Math.floor(values.length * .95)] };
    };
    async function measure(name, samples) {
        variant = name;
        R.GeometryDetail.enabled = name === 'optimized';
        lights.rrLightGridEnabled.value = name === 'baseline' ? 0 : gridUniform;
        for (const m of materials) m.needsUpdate = true;
        for (let i = 0; i < 12; i++) { draw(); await sleepFrame(); }
        const image = pixels();
        const cpu = [], gpu = [], pending = [];
        function collect() {
            while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
                const q = pending.shift();
                if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
                gl.deleteQuery(q);
            }
        }
        for (let i = 0; i < samples; i++) {
            const q = gl.createQuery();
            gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
            try {
                const t = realNow(); draw(); cpu.push(realNow() - t);
            } finally {
                gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(q);
            }
            await sleepFrame();
            if (ext) collect();
        }
        for (let i = 0; pending.length && i < 60; i++) { await sleepFrame(); collect(); }
        pending.forEach(q => gl.deleteQuery(q));
        return { image, stats: { name, cpu: summary(cpu), gpu: summary(gpu), glError: gl.getError() } };
    }
    const results = [];
    try {
        app.ticker.stop();
        performance.now = () => frozenNow; Date.now = () => frozenDate;
        PIXI.Ticker.shared.stop();
        for (const video of videos) video.pause();
        await new Promise(resolve => setTimeout(resolve, 100));
        Graphics._tickHandler = null;

        const base = await measure('baseline', 40);
        results.push(base.stats);
        for (const name of ['lighting', 'optimized', 'baseline', 'optimized']) {
            const measured = await measure(name, 40);
            results.push({ ...measured.stats, pixels: diff(base.image, measured.image) });
        }
        const report = {
            gpu: Graphics.gpuDescription, tier: R.tier(), viewport: [gl.drawingBufferWidth, gl.drawingBufferHeight],
            revision: RPG_REACTOR_RUNTIME_REVISION, lights: lights.rrLightCount.value,
            shadowLights: Array.from(lights.rrLightShadow.value).filter(x => x >= 0).length,
            materials: materials.size, nonzeroRgb: base.image.filter((x, i) => i % 4 !== 3 && x > 0).length,
            failedPrograms: R.viewport()._renderer.info.programs.filter(p => p.diagnostics && !p.diagnostics.runnable).length,
            detailReady: !R.GeometryDetail._busy && !R.GeometryDetail._failed,
            results,
            passed: materials.size > 0 && base.image.some((x, i) => i % 4 !== 3 && x !== base.image[i % 4]) &&
                results.every(r => r.glError === 0 && r.gpu.n === 40 && (!r.pixels || r.name === 'optimized' || r.pixels.changedChannels === 0))
        };
        report.passed = report.passed && report.failedPrograms === 0;
        return report;
    } finally {
        R.LightGrid.enabled = gridEnabled; R.GeometryDetail.enabled = detailEnabled;
        lights.rrLightGridEnabled.value = gridUniform;
        R.lightGlsl = original; R.LIGHT_GLSL = originalPlain;
        performance.now = realNow; Date.now = realDate;
        if (sharedStarted) PIXI.Ticker.shared.start();
        for (const video of videos) video.play().catch(() => {});
        for (const [m, key] of keys) { m.customProgramCacheKey = key; m.needsUpdate = true; }
        Graphics._tickHandler = tick;
        if (appStarted) app.ticker.start();
    }
})().then(done, error => done({ error: String(error.stack || error) }));
