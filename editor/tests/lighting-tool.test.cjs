/**
 * The Lighting tool: the sidecar light store, and the visual editor built on
 * it. The store is exercised for real; the manager and its wiring are pinned
 * where they must agree with the runtime's compositors.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const editorRoot = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(editorRoot, relative), 'utf8');
const MapLights = require(path.join(editorRoot, 'src', 'utils', 'MapLights.js'));

test('lights normalize, bound and round-trip through the sidecar', () => {
    const map = { width: 20, height: 15 };
    const lamp = MapLights.add(map, { type: 'point', x: 3.5, y: 4.5, radius: 5, color: '#FF8800' });
    assert.equal(lamp.id, 'light1');
    assert.equal(lamp.color, '#ff8800', 'colour normalizes to lowercase hex');
    const torch = MapLights.add(map, { type: 'spot', x: 1, y: 1, yaw: 999999, intensity: 99 });
    assert.equal(torch.id, 'light2');
    assert.equal(torch.radius, MapLights.DEFAULT_CONE_LENGTH, 'a spot defaults to the cone reach');
    assert.equal(torch.intensity, 4, 'intensity clamps to the runtime bound');

    assert.equal(MapLights.list(map).length, 2);
    assert.equal(MapLights.get(map, 'light1').x, 3.5);
    MapLights.update(map, 'light1', { radius: 7, tag: 'street' });
    assert.equal(MapLights.get(map, 'light1').radius, 7);
    assert.equal(MapLights.get(map, 'light1').tag, 'street');

    const copy = MapLights.duplicate(map, 'light1');
    assert.equal(copy.id, 'light3', 'a duplicate gets a fresh id');
    assert.equal(copy.x, 4.5, 'and steps aside');
    assert.equal(copy.tag, 'street');

    assert.equal(MapLights.remove(map, 'light2'), true);
    assert.equal(MapLights.get(map, 'light2'), null);
});

test('a lights-only sidecar never stamps a 3D mode', () => {
    // The 3D checkbox is the only thing that flips a map's mode; a lamp on a
    // 2D map must leave it a 2D map.
    const map = { width: 10, height: 10 };
    MapLights.add(map, { x: 1, y: 1 });
    MapLights.setAmbient(map, { ambient: 0.3, ambientColour: '#9db4ff' });
    assert.equal('mode' in map.reactor3d, false);
    assert.deepEqual(MapLights.ambient(map),
        { ambient: 0.3, ambientColour: '#9db4ff', enabled: undefined });
});

test('removing the last light removes the array, and snapshots restore', () => {
    const map = { width: 10, height: 10 };
    const light = MapLights.add(map, { x: 2, y: 2, radius: 4 });
    const lit = MapLights.snapshot(map);
    MapLights.remove(map, light.id);
    assert.equal('lights' in map.reactor3d, false,
        'an empty array would keep the sidecar file alive for nothing');
    const empty = MapLights.snapshot(map);
    assert.equal(MapLights.restore(map, lit), true);
    assert.equal(MapLights.list(map).length, 1);
    MapLights.restore(map, empty);
    assert.equal(MapLights.list(map).length, 0);
});

test('the editor store bounds match the runtime reader bounds', () => {
    // One schema, two normalizers - they must agree or the editor can write
    // what the game re-clamps.
    const Reactor3D = require(path.join(editorRoot, '..', 'runtime', 'reactor_3d.js'));
    const wild = {
        id: 'x', type: 'spot', x: 99999, y: -99999, height: 9999, yaw: 500,
        radius: 9999, angle: 999, intensity: 99, flicker: 5,
        pulse: { min: -1, max: 99, period: 0 }
    };
    const editorSide = MapLights.normalize(wild, 'x');
    const runtimeSide = Reactor3D.readMapLights({ reactor3d: { lights: [wild] } })[0];
    for (const key of ['x', 'y', 'height', 'radius', 'angle', 'intensity', 'flicker']) {
        assert.equal(editorSide[key], runtimeSide[key], key + ' clamps identically');
    }
    assert.deepEqual(editorSide.pulse, runtimeSide.pulse, 'pulse clamps identically');
});

test('the lighting manager composites the way the runtime does', () => {
    const manager = read('src/LightingManager.js');
    // Ambient is one multiply sprite; lights are additive falloff sprites
    // sharing the 3D pass's own pictures - never punched holes.
    assert.match(manager, /blendMode = 'multiply'/);
    assert.match(manager, /blendMode = 'add'/);
    assert.match(manager, /coneLightCanvas\(\) : Reactor3D\.roundLightCanvas\(\)/);
    assert.doesNotMatch(manager, /destination-out/);
    // The 3D preview feeds the real compositor, with the schema yaw flipped
    // into the scene convention exactly as the runtime flips it.
    assert.match(manager, /yaw: -light\.yaw/);
    assert.match(manager, /scene\.syncLights\?\.\(focus\)/);
    assert.match(manager, /lightGroup\(\)\.visible = true/);
    // Deterministic animation, identical constants to the runtime.
    assert.match(manager, /Math\.sin\(frame \* 0\.31 \+ seed\) \* Math\.sin\(frame \* 0\.127 \+ seed \* 1\.7\)/);
    // Undo is whole-state snapshots through the store.
    assert.match(manager, /RRMapLights\.snapshot\(map\)/);
    assert.match(manager, /RRMapLights\.restore\(map, from\.pop\(\)\)/);
});

test('the tool is wired: toolbar button, scripts, dispatcher, instance', () => {
    const html = read('index.html');
    assert.match(html, /data-action="lighting-tool"[^>]*data-i18n-title="toolbar\.title\.lighting"/);
    assert.match(html, /icon-lighting\.svg/);
    const lights = html.indexOf('src/utils/MapLights.js');
    const manager = html.indexOf('src/LightingManager.js');
    const main = html.indexOf('src/main.js');
    assert.ok(lights >= 0 && lights < manager, 'the store loads before the manager');
    assert.ok(manager < main || main < 0, 'and the manager before main');

    assert.match(read('src/UIManager.js'), /case 'lighting-tool':/);
    assert.match(read('src/main.js'), /new LightingManager\(this\.projectController\)/);
    assert.ok(fs.existsSync(path.join(editorRoot, 'images', 'icon-lighting.svg')));
});

test('every panel string is a lit.* key present in the locale tables', () => {
    const manager = read('src/LightingManager.js');
    const used = new Set([...manager.matchAll(/'(lit\.[A-Za-z]+)'/g)].map(match => match[1]));
    assert.ok(used.size >= 25, 'the panel is fully keyed (' + used.size + ' keys)');
    const i18n = read('src/I18nManager.js');
    for (const key of used) {
        assert.ok(i18n.includes(JSON.stringify(key)), key + ' exists in the tables');
    }
    assert.ok(i18n.includes('"toolbar.title.lighting"'), 'the toolbar title is keyed too');
});
