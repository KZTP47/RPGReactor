// NW.js WebDriver async probe, after opening the editor in 2D. Compares actual
// PIXI ground-light pixels to the runtime's 3D GLSL on the same ground plane.
const done = arguments[arguments.length - 1];
(async () => {
    const preview = reactor.modelPropsManager.preview2D, viewport = preview.ensureViewport();
    const uniforms = Reactor3D.lightUniforms();
    const savedUniforms = Object.fromEntries(['rrLightCount', 'rrAmbient', 'rrLightPos', 'rrLightColor', 'rrLightAim', 'rrLightShadow']
        .map(key => [key, typeof uniforms[key].value === 'number' ? uniforms[key].value : Array.from(uniforms[key].value)]));
    const width = 192, map = { width: 40, height: 40 };
    const target = viewport.createTarget(width, width, 1, { samples: 0 });
    const scene = new THREE.Scene(), camera = new THREE.Camera();
    const material = new THREE.ShaderMaterial({
        uniforms: Reactor3D.lightUniforms(),
        vertexShader: 'varying vec2 ground; void main(){ground=uv*40.0;gl_Position=vec4(uv.x*2.0-1.0,1.0-uv.y*2.0,0.0,1.0);}',
        fragmentShader: Reactor3D.LIGHT_GLSL + '\nvarying vec2 ground; void main(){float f=rrLight(vec3(ground.x,0.0,ground.y)).r;gl_FragColor=vec4(f);}',
        side: THREE.DoubleSide, depthTest: false, depthWrite: false
    });
    const geometry = new THREE.PlaneGeometry(1, 1); scene.add(new THREE.Mesh(geometry, material));
    const container = new PIXI.Container();
    // Fix extraction dimensions even if the spotlight is entirely transparent.
    const base = new PIXI.Sprite(PIXI.Texture.WHITE); base.width = base.height = width; base.alpha = 0; container.addChild(base);
    const lightMesh = new FlatShadowLight2D(PIXI.Texture.WHITE); container.addChild(lightMesh);
    const staticEntry = [...preview.entries.values()].find(e => e.object && !e.driver && !e.media?.plays.some(play => play.plane));
    const modelPixels = () => {
        preview.paint(staticEntry);
        const pixels = new Uint8Array(staticEntry.size * staticEntry.size * 4);
        viewport.renderer().readRenderTargetPixels(staticEntry.target, 0, 0, staticEntry.size, staticEntry.size, pixels);
        return pixels;
    };
    const beforeModel = staticEntry ? modelPixels() : null;
    let max = 0, total = 0, channels = 0; const cases = [];
    try {
        for (const type of ['point', 'spot', 'beam']) for (const pitch of [-90, -65, -15, 40]) for (const yaw of [0, 73]) {
            const light = { type, shadowSource: { x: 20, y: 5, z: 20 }, radius: 18, angle: 70, width: 2, pitch, yaw };
            lightMesh.syncLight(light, { x: 0, y: 0, width: 40, height: 40 }, null, width / 40);
            const flat = preview.app.renderer.extract.pixels({ target: container, resolution: 1 });
            Reactor3D.packLightUniforms([{ ...light, x: 19.5, y: 19, height: 5, yaw: -yaw,
                intensity: 1 / (Reactor3D.LIGHT_GAIN * Reactor3D.VOLUME_LIGHT_GAIN), colour: 0xffffff }], { intensity: 0 });
            viewport.renderInto(target, scene, camera);
            const reference = new Uint8Array(width * width * 4);
            viewport.renderer().readRenderTargetPixels(target, 0, 0, width, width, reference);
            let peak = 0, sum = 0;
            for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
                const a = flat.pixels[(y * width + x) * 4 + 3], b = reference[((width - 1 - y) * width + x) * 4 + 3];
                const delta = Math.abs(a - b); peak = Math.max(peak, delta); sum += delta;
            }
            max = Math.max(max, peak); total += sum; channels += width * width;
            cases.push({ type, pitch, yaw, max: peak, mean: sum / (width * width) });
        }
        if (max > 2 || total / channels > 0.1) throw new Error('2D/3D ground light mismatch: ' + JSON.stringify(cases));
        if (beforeModel) {
            const afterModel = modelPixels();
            if (afterModel.some((v, i) => v !== beforeModel[i])) throw new Error('Other previews changed the flat model lighting');
        }
        const casterGeometry = new THREE.BoxGeometry(0.4, 0.4, 0.4);
        const casterMaterial = new THREE.MeshBasicMaterial();
        const object = new THREE.Mesh(casterGeometry, casterMaterial), home = new THREE.Scene();
        home.add(object);
        const prop = { x: 19.5, y: 24.5, z: 5 };
        const light = { type: 'spot', shadowSource: { x: 20, y: 10, z: 20 }, radius: 30, angle: 30, yaw: 0, pitch: -45 };
        const bounds = FlatLightField2D.bounds(light, map), state = {};
        let shadowPixels = 0;
        try {
            preview.shadows.paint(state, light, light.shadowSource, [{ object, prop }], map, bounds);
            const pixels = new Uint8Array(state.target.width * state.target.height * 4);
            viewport.renderer().readRenderTargetPixels(state.target, 0, 0, state.target.width, state.target.height, pixels);
            shadowPixels = pixels.filter((v, i) => i % 4 === 3 && v > 0).length;
            if (!shadowPixels) throw new Error('Caster outside the light footprint lost its projected shadow');
            if (object.parent !== home || !object.frustumCulled || object.position.length() !== 0)
                throw new Error('Shadow pass did not restore caster state');
        } finally { preview.shadows.release(state); casterGeometry.dispose(); casterMaterial.dispose(); }
        return { passed: true, cases: cases.length, maxChannelDifference: max, meanChannelDifference: total / channels, projectedShadowPixels: shadowPixels, modelLightingIsolated: !!beforeModel };
    } finally {
        for (const [key, value] of Object.entries(savedUniforms)) {
            if (typeof value === 'number') uniforms[key].value = value;
            else if (uniforms[key].value.set) uniforms[key].value.set(value);
            else value.forEach((v, i) => { uniforms[key].value[i] = v; });
        }
        container.destroy({ children: true }); geometry.dispose(); material.dispose(); target.dispose();
    }
})().then(done, error => done({ error: String(error.stack) }));
