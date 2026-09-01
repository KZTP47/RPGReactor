/**
 * LightingManager - the visual Lighting tool.
 *
 * A toolbar mode with its own side panel: click the map to place point and
 * spot lights, drag them, pull their reach and aim handles, and tune ambient
 * darkness live - the 2D overlay composites exactly the way the runtime's
 * flat compositor does (one multiply sprite of ambient, additive falloff
 * sprites above it, the 3D pass's own pictures), and the 3D view runs the
 * real pooled light compositor, so what you place is what the game draws.
 *
 * Data lives in the map sidecar through RRMapLights; placing a light is the
 * whole opt-in. Undo is whole-state snapshots, Ctrl+Z / Ctrl+Y while the
 * tool is active.
 */
class LightingManager {
    constructor(projectController) {
        this.projectController = projectController;
        this.active = false;
        this.selectedId = null;
        this.placing = null;          // 'point' | 'spot' while placement is armed
        this.drag = null;             // { id, mode: 'move'|'reach'|'aim', ... }
        this._listeners = [];
        this._overlay = null;
        this._glowSprites = [];
        this._markers = null;
        this._panel = null;
        this._raf = null;
        this._frame = 0;
        this._undo = [];
        this._redo = [];
        this._boundMap = null;
        this._onKeyDown = event => this._keyDown(event);
    }

    _k(key) {
        return (typeof window !== 'undefined' && window.I18n) ? window.I18n.t(key) : key;
    }

    get tilemapManager() {
        return this.projectController?.tilemapManager || window.reactor?.tilemapManager || null;
    }

    map() {
        return this.tilemapManager?.currentMap || null;
    }

    mapEditor3D() {
        return window.reactor?.mapEditor3D || this.projectController?.mapEditor3D || null;
    }

    tileSize() {
        return this.tilemapManager?.TILE_WIDTH || this.tilemapManager?.TILE_SIZE || 48;
    }

    //-------------------------------------------------------------------------
    // Mode

    setActive(enabled) {
        if (this.active === !!enabled) return;
        this.active = !!enabled;
        const button = document.querySelector('[data-action="lighting-tool"]');
        if (button) button.classList.toggle('active', this.active);
        if (this.active) this._activate();
        else this._deactivate();
    }

    toggle() {
        this.setActive(!this.active);
    }

    _activate() {
        const mapEditor = window.reactor?.mapEditor;
        this._resumeMapEditor = !!mapEditor?.enabled;
        mapEditor?.setEnabled?.(false);
        this._boundMap = this.map();
        this._buildPanel();
        this._buildOverlay();
        this._bindPointer();
        this._bind3DPointer();
        document.addEventListener('keydown', this._onKeyDown);
        this.render();
        this._startTicking();
        this._sync3D();
        // An unlit map arms placement by itself: open the tool, click the
        // map, there is light — no reading required.
        if (!this.lights().length) this.armPlacement('point');
    }

    _deactivate() {
        this.placing = null;
        this.drag = null;
        this._stopTicking();
        this._unbindPointer();
        this._unbind3DPointer();
        document.removeEventListener('keydown', this._onKeyDown);
        this._destroyOverlay();
        this._destroyPanel();
        this._clear3D();
        const mapEditor = window.reactor?.mapEditor;
        if (mapEditor && this._resumeMapEditor) {
            mapEditor.setEnabled(true);
            mapEditor.setupMapInteraction?.();
        }
    }

    //-------------------------------------------------------------------------
    // Undo

    pushUndo() {
        const map = this.map();
        if (!map || typeof RRMapLights === 'undefined') return;
        this._undo.push(RRMapLights.snapshot(map));
        if (this._undo.length > 100) this._undo.shift();
        this._redo = [];
    }

    undo() {
        this._timeTravel(this._undo, this._redo);
    }

    redo() {
        this._timeTravel(this._redo, this._undo);
    }

    _timeTravel(from, to) {
        const map = this.map();
        if (!map || !from.length || typeof RRMapLights === 'undefined') return;
        to.push(RRMapLights.snapshot(map));
        RRMapLights.restore(map, from.pop());
        if (this.selectedId && !RRMapLights.get(map, this.selectedId)) this.selectedId = null;
        this._changed();
    }

    //-------------------------------------------------------------------------
    // Editing

    lights() {
        const map = this.map();
        return map && typeof RRMapLights !== 'undefined' ? RRMapLights.list(map) : [];
    }

    selected() {
        const map = this.map();
        return map && this.selectedId && typeof RRMapLights !== 'undefined'
            ? RRMapLights.get(map, this.selectedId) : null;
    }

    /**
     * The tray's light flavours. A preset is a whole personality — colour,
     * reach, flicker, pulse — so a dropped Candle already flickers.
     */
    _presets() {
        return [
            { key: 'point', label: this._k('lit.point'),
              template: { key: 'point', type: 'point', color: '#ffcf7d', radius: 3, intensity: 1 } },
            { key: 'spot', label: this._k('lit.spot'),
              template: { key: 'spot', type: 'spot', color: '#fff2cc', radius: 6, intensity: 1 } },
            { key: 'candle', label: this._k('lit.preset.candle'),
              template: { key: 'candle', type: 'point', color: '#ffb45e', radius: 2.5, intensity: 1.1, flicker: 0.6 } },
            { key: 'lamp', label: this._k('lit.preset.lamp'),
              template: { key: 'lamp', type: 'point', color: '#ffd9a0', radius: 4, intensity: 1.2 } },
            { key: 'neon', label: this._k('lit.preset.neon'),
              template: { key: 'neon', type: 'point', color: '#ff2d95', radius: 5, intensity: 1.4, tag: 'neon' } },
            { key: 'alarm', label: this._k('lit.preset.alarm'),
              template: { key: 'alarm', type: 'point', color: '#ff1720', radius: 6, intensity: 1.4,
                  pulse: { min: 0.3, max: 1, period: 150 }, tag: 'alarm' } },
            { key: 'screen', label: this._k('lit.preset.screen'),
              template: { key: 'screen', type: 'point', color: '#7f9bff', radius: 3, intensity: 1, flicker: 0.4 } },
            { key: 'torch', label: this._k('lit.preset.torch'),
              template: { key: 'torch', type: 'spot', color: '#eaf6ff', radius: 7, angle: 30, intensity: 0.9, flicker: 0.08 } },
            // A compound: one drop places the whole fixture, tagged together.
            { key: 'streetlamp', label: this._k('lit.preset.streetlamp'),
              template: { key: 'streetlamp', color: '#ffd9a0', type: 'point', compound: [
                  { type: 'point', color: '#ffd9a0', radius: 5.5, intensity: 1.2 },
                  { type: 'point', color: '#fff3d6', radius: 1.2, intensity: 1.6, height: 2, flicker: 0.06 }
              ] } }
        ];
    }

    armPlacement(preset) {
        if (!preset) {
            this.placing = null;
            this._placingTemplate = null;
            this._armedKey = null;
        } else if (typeof preset === 'string') {
            this.placing = preset === 'spot' ? 'spot' : 'point';
            this._placingTemplate = null;
            this._armedKey = this.placing;
        } else {
            this.placing = preset.type === 'spot' ? 'spot' : 'point';
            this._placingTemplate = preset;
            this._armedKey = preset.key || this.placing;
        }
        this._syncAddButtons();
    }

    place(preset, x, y) {
        const map = this.map();
        if (!map || typeof RRMapLights === 'undefined') return null;
        const template = typeof preset === 'string'
            ? { type: preset, color: preset === 'spot' ? '#fff2cc' : '#ffcf7d' }
            : Object.assign({}, preset);
        this.pushUndo();
        const at = {
            x: Math.round(x * 100) / 100,
            y: Math.round(y * 100) / 100
        };
        // A compound drops its whole fixture at once, every part sharing a
        // fresh group tag so they can be spoken to together.
        if (Array.isArray(template.compound)) {
            let n = 1;
            const taken = new Set(RRMapLights.list(map).map(entry => entry && entry.tag));
            while (taken.has((template.key || 'group') + n)) n++;
            const tag = (template.key || 'group') + n;
            let first = null;
            for (const part of template.compound) {
                const light = RRMapLights.add(map,
                    Object.assign({}, part, at, { tag }));
                if (!first) first = light;
            }
            this.selectedId = first ? first.id : null;
            this._changed();
            return first;
        }
        const light = RRMapLights.add(map, Object.assign(template, at));
        this.selectedId = light ? light.id : null;
        this._changed();
        return light;
    }

    /** Client coordinates to fractional map tiles, whichever view is on top. */
    _tileFromClient(clientX, clientY) {
        const m3d = this.mapEditor3D();
        if (m3d?.isEnabled?.() && m3d.groundPointAt) {
            return m3d.groundPointAt(clientX, clientY);
        }
        const app = this.tilemapManager?.app;
        const canvas = app && (app.canvas || app.view);
        const container = this.tilemapManager?.container;
        if (!canvas || !container) return null;
        const rect = canvas.getBoundingClientRect();
        if (clientX < rect.left || clientX > rect.right
            || clientY < rect.top || clientY > rect.bottom) return null;
        const global = new PIXI.Point(
            (clientX - rect.left) * (canvas.width / rect.width),
            (clientY - rect.top) * (canvas.height / rect.height));
        const local = container.worldTransform.applyInverse(global);
        return { x: local.x / this.tileSize(), y: local.y / this.tileSize() };
    }

    /** The mid-drag preview, on whichever view is on top. */
    _ghostFromClient(clientX, clientY) {
        const m3d = this.mapEditor3D();
        if (m3d?.isEnabled?.() && m3d.groundPointAt && m3d.mapScene) {
            const at = m3d.groundPointAt(clientX, clientY);
            if (at) this._showRingAt(m3d.mapScene, at);
            return;
        }
        const at = this._tileFromClient(clientX, clientY);
        if (at) this._moveGhost(at);
    }

    updateSelected(patch) {
        const map = this.map();
        if (!map || !this.selectedId || typeof RRMapLights === 'undefined') return;
        RRMapLights.update(map, this.selectedId, patch);
        this._changed();
    }

    removeSelected() {
        const map = this.map();
        if (!map || !this.selectedId || typeof RRMapLights === 'undefined') return;
        this.pushUndo();
        RRMapLights.remove(map, this.selectedId);
        this.selectedId = null;
        this._changed();
    }

    duplicateSelected() {
        const map = this.map();
        if (!map || !this.selectedId || typeof RRMapLights === 'undefined') return;
        this.pushUndo();
        const copy = RRMapLights.duplicate(map, this.selectedId);
        if (copy) this.selectedId = copy.id;
        this._changed();
    }

    select(id) {
        this.selectedId = id || null;
        this.render();
        this._syncPanel();
        this._sync3D();
    }

    _changed() {
        this.render();
        this._syncPanel();
        this._sync3D();
    }

    //-------------------------------------------------------------------------
    // Frame resolution (mirrors the runtime's nativeLights, with the editor's
    // own event lookup so attached lights preview on their carriers)

    resolvedLights(frame) {
        const map = this.map();
        if (!map || typeof RRMapLights === 'undefined') return [];
        const out = [];
        const authored = RRMapLights.list(map);
        for (let i = 0; i < authored.length; i++) {
            const light = RRMapLights.normalize(authored[i], 'light' + (i + 1));
            if (!light.on) continue;
            let x = light.x;
            let y = light.y;
            if (light.attach) {
                // Event carriers preview on their event; a player-attached
                // light has no carrier in the editor and must not land on
                // tile 0,0 - it stays listed in the panel instead.
                if (!light.attach.event) continue;
                const event = (map.events || [])[light.attach.event];
                if (!event) continue;
                x += event.x + 0.5;
                y += event.y + 0.5;
            }
            let radius = light.radius;
            let intensity = light.intensity;
            if (light.pulse) {
                const t = (frame % light.pulse.period) / light.pulse.period;
                radius *= light.pulse.min
                    + (light.pulse.max - light.pulse.min) * (0.5 - 0.5 * Math.cos(t * Math.PI * 2));
            }
            if (light.flicker) {
                const seed = i * 13.7;
                const jitter = Math.sin(frame * 0.31 + seed) * Math.sin(frame * 0.127 + seed * 1.7);
                intensity *= 1 - light.flicker * (0.25 + 0.25 * jitter);
                radius *= 1 - light.flicker * 0.06 * jitter;
            }
            out.push({
                id: light.id, type: light.type, x, y, height: light.height,
                radius, intensity, angle: light.angle, yaw: light.yaw,
                colour: this._colourNumber(light.color), occlude: light.occlude,
                animated: !!(light.pulse || light.flicker),
                attached: !!light.attach
            });
        }
        return out;
    }

    _colourNumber(color) {
        return typeof Reactor3D !== 'undefined' && Reactor3D.parseColour
            ? Reactor3D.parseColour(color)
            : parseInt(String(color || '#ffffff').replace('#', ''), 16) || 0xffffff;
    }

    ambient() {
        const map = this.map();
        return map && typeof RRMapLights !== 'undefined'
            ? RRMapLights.ambient(map)
            : { ambient: 0.25, ambientColour: '#ffffff' };
    }

    //-------------------------------------------------------------------------
    // 2D overlay

    _lightTexture(kind) {
        if (typeof Reactor3D === 'undefined' || typeof PIXI === 'undefined') return null;
        const key = kind === 'cone' ? '_editorConeLightPixi' : '_editorRoundLightPixi';
        if (!Reactor3D[key]) {
            const canvas = kind === 'cone'
                ? Reactor3D.coneLightCanvas() : Reactor3D.roundLightCanvas();
            Reactor3D[key] = PIXI.Texture.from(canvas);
        }
        return Reactor3D[key];
    }

    _buildOverlay() {
        const container = this.tilemapManager?.container;
        const map = this.map();
        if (!container || !map || typeof PIXI === 'undefined') return;
        const overlay = new PIXI.Container();
        overlay.label = 'lighting-overlay';
        const darkness = new PIXI.Sprite(PIXI.Texture.WHITE);
        darkness.blendMode = 'multiply';
        const glow = new PIXI.Container();
        const markers = new PIXI.Graphics();
        overlay.addChild(darkness);
        overlay.addChild(glow);
        overlay.addChild(markers);
        container.addChild(overlay);
        this._overlay = { root: overlay, darkness, glow, markers };
        this._glowSprites = [];
    }

    _destroyOverlay() {
        if (!this._overlay) return;
        const root = this._overlay.root;
        if (root.parent) root.parent.removeChild(root);
        root.destroy({ children: true, texture: false, textureSource: false });
        this._overlay = null;
        this._glowSprites = [];
        this._ghost = null;
    }

    /** Draw the darkness, the lights and the markers for this frame. */
    render(frame = this._frame) {
        const state = this._overlay;
        const map = this.map();
        if (!state || !map) return;
        const tw = this.tileSize();

        const ambient = this.ambient();
        const level = Math.max(0, Math.min(1, ambient.ambient));
        const colour = this._colourNumber(ambient.ambientColour);
        const channel = shift =>
            Math.round(Math.max(0, Math.min(255, ((colour >> shift) & 0xff) * level)));
        state.darkness.tint = (channel(16) << 16) | (channel(8) << 8) | channel(0);
        state.darkness.width = map.width * tw;
        state.darkness.height = map.height * tw;

        const lights = this.resolvedLights(frame);
        let used = 0;
        for (const light of lights) {
            let sprite = this._glowSprites[used];
            if (!sprite) {
                sprite = new PIXI.Sprite();
                sprite.blendMode = 'add';
                state.glow.addChild(sprite);
                this._glowSprites.push(sprite);
            }
            const spot = light.type === 'spot';
            sprite.texture = this._lightTexture(spot ? 'cone' : 'round');
            sprite.visible = true;
            const reach = Math.max(1, light.radius * tw);
            if (spot) {
                sprite.anchor.set(0.5, 1);
                const spread = (light.angle * Math.PI) / 360;
                sprite.width = Math.max(2, 2 * Math.tan(spread) * reach);
                sprite.height = Math.max(2, reach);
                // Schema yaw is clockwise from south on screen; the texture
                // points up, so south is a half turn.
                sprite.rotation = Math.PI + (light.yaw * Math.PI) / 180;
            } else {
                sprite.anchor.set(0.5, 0.5);
                sprite.rotation = 0;
                sprite.width = sprite.height = Math.max(2, reach * 2);
            }
            sprite.position.set(light.x * tw, (light.y - light.height) * tw);
            sprite.tint = light.colour;
            sprite.alpha = Math.max(0, Math.min(1, light.intensity));
            used++;
        }
        for (let i = used; i < this._glowSprites.length; i++) this._glowSprites[i].visible = false;

        this._renderMarkers(state.markers, tw);
    }

    /** Handles: a dot per light, reach and aim handles on the selection. */
    _renderMarkers(g, tw) {
        g.clear();
        const map = this.map();
        if (!map || typeof RRMapLights === 'undefined') return;
        // Markers hold their screen size whatever the zoom: shrunk with the
        // map they became four-pixel dots nobody could see or hit.
        const zoom = Math.max(0.05, this._viewScale());
        for (const raw of RRMapLights.list(map)) {
            const light = RRMapLights.normalize(raw, raw.id || 'light');
            const at = this._lightAnchor(light);
            if (!at) continue;
            const selected = light.id === this.selectedId;
            const colour = this._colourNumber(light.color);
            const x = at.x * tw, y = at.y * tw;
            g.circle(x, y, (selected ? 9 : 7) / zoom)
                .fill({ color: light.on ? colour : 0x555555, alpha: 0.95 })
                .stroke({ width: 2, color: selected ? 0xffffff : 0x000000, alpha: 0.9 });
            if (!selected) continue;
            if (light.type === 'spot') {
                const aim = this._aimPoint(light, at);
                const spread = (light.angle * Math.PI) / 360;
                const yaw = (light.yaw * Math.PI) / 180;
                const dir = side => ({
                    x: x + Math.sin(yaw + side * spread) * light.radius * tw,
                    y: y + Math.cos(yaw + side * spread) * light.radius * tw
                });
                const left = dir(-1), right = dir(1);
                g.moveTo(x, y).lineTo(left.x, left.y)
                    .moveTo(x, y).lineTo(right.x, right.y)
                    .stroke({ width: 1.5 / zoom, color: 0xffffff, alpha: 0.55 });
                g.circle(aim.x * tw, aim.y * tw, 8 / zoom)
                    .fill({ color: 0xffffff, alpha: 0.9 })
                    .stroke({ width: 2 / zoom, color: 0x000000, alpha: 0.9 });
            } else {
                g.circle(x, y, light.radius * tw)
                    .stroke({ width: 1.5 / zoom, color: 0xffffff, alpha: 0.5 });
                const reach = this._reachPoint(light, at);
                g.circle(reach.x * tw, reach.y * tw, 8 / zoom)
                    .fill({ color: 0xffffff, alpha: 0.9 })
                    .stroke({ width: 2 / zoom, color: 0x000000, alpha: 0.9 });
            }
        }
    }

    /** Where a light's handle sits, in tiles - its carrier plus offset. */
    _lightAnchor(light) {
        if (light.attach && light.attach.event) {
            const event = (this.map()?.events || [])[light.attach.event];
            if (!event) return null;
            return { x: light.x + event.x + 0.5, y: light.y + event.y + 0.5 };
        }
        return { x: light.x, y: light.y };
    }

    _reachPoint(light, at) {
        return { x: at.x + light.radius, y: at.y };
    }

    _aimPoint(light, at) {
        const yaw = (light.yaw * Math.PI) / 180;
        return { x: at.x + Math.sin(yaw) * light.radius, y: at.y + Math.cos(yaw) * light.radius };
    }

    //-------------------------------------------------------------------------
    // 2D pointer

    _bindPointer() {
        const container = this.tilemapManager?.container;
        if (!container || this._listeners.length) return;
        const on = (type, handler) => {
            container.on(type, handler);
            this._listeners.push([container, type, handler]);
        };
        on('pointerdown', event => this._pointerDown(event, container));
        on('pointermove', event => this._pointerMove(event, container));
        on('pointerup', () => this._pointerUp());
        on('pointerupoutside', () => this._pointerUp());
    }

    _unbindPointer() {
        for (const [container, type, handler] of this._listeners) container.off(type, handler);
        this._listeners = [];
    }

    //-------------------------------------------------------------------------
    // 3D-view pointer: a 3D-authored map opens in the 3D view, so placement
    // has to land there too. Capture phase on the 3D input surface, consuming
    // only what belongs to the tool — orbiting, painting and prop picking
    // keep working underneath.

    _surface3D() {
        const m3d = this.mapEditor3D();
        if (!m3d || !m3d.isEnabled || !m3d.isEnabled()) return null;
        return m3d.inputSurface || m3d.canvas || null;
    }

    _bind3DPointer() {
        const surface = this._surface3D();
        this._bound3D = surface;
        if (!surface) return;
        this._on3DDown = event => this._pointer3DDown(event);
        surface.addEventListener('pointerdown', this._on3DDown, true);
        // While placing, the ring rides the cursor across the 3D ground —
        // the "you are here" the flat ghost provides in 2D.
        this._on3DHover = event => {
            if (!this.placing) return;
            const m3d = this.mapEditor3D();
            const at = m3d && m3d.groundPointAt
                ? m3d.groundPointAt(event.clientX, event.clientY) : null;
            const scene = m3d && m3d.mapScene;
            if (at && scene) this._showRingAt(scene, at);
        };
        surface.addEventListener('pointermove', this._on3DHover, true);
    }

    _unbind3DPointer() {
        if (this._bound3D && this._on3DDown) {
            this._bound3D.removeEventListener('pointerdown', this._on3DDown, true);
            this._bound3D.removeEventListener('pointermove', this._on3DHover, true);
        }
        this._bound3D = null;
        this._on3DDown = null;
        this._on3DHover = null;
        this._end3DDrag();
    }

    _pointer3DDown(event) {
        if (!this.active || event.button !== 0) return;
        const m3d = this.mapEditor3D();
        if (!m3d || !m3d.groundPointAt) return;
        const at = m3d.groundPointAt(event.clientX, event.clientY);
        if (!at) return;
        if (this.placing) {
            const preset = this._placingTemplate || this.placing;
            if (!event.shiftKey) this.armPlacement(null);
            this.place(preset, at.x, at.y);
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        const hit = this._lightNear(at, 0.9);
        if (!hit) return; // not ours: the orbit and the props keep the click
        if (hit.id !== this.selectedId) this.select(hit.id);
        this.pushUndo();
        const anchor = this._lightAnchor(hit) || at;
        this._drag3d = { id: hit.id, offsetX: at.x - anchor.x, offsetY: at.y - anchor.y };
        this._on3DMove = e => this._pointer3DMove(e);
        this._on3DUp = () => this._end3DDrag();
        window.addEventListener('pointermove', this._on3DMove, true);
        window.addEventListener('pointerup', this._on3DUp, true);
        event.preventDefault();
        event.stopImmediatePropagation();
    }

    _pointer3DMove(event) {
        const drag = this._drag3d;
        const map = this.map();
        const m3d = this.mapEditor3D();
        if (!drag || !map || !m3d || typeof RRMapLights === 'undefined') return;
        const at = m3d.groundPointAt(event.clientX, event.clientY);
        if (!at) return;
        const light = RRMapLights.get(map, drag.id);
        if (!light) return;
        const base = light.attach && light.attach.event
            ? this._carrierBase(light) : { x: 0, y: 0 };
        RRMapLights.update(map, drag.id, {
            x: Math.round((at.x - drag.offsetX - base.x) * 100) / 100,
            y: Math.round((at.y - drag.offsetY - base.y) * 100) / 100
        });
        this._changed();
    }

    _end3DDrag() {
        if (this._on3DMove) window.removeEventListener('pointermove', this._on3DMove, true);
        if (this._on3DUp) window.removeEventListener('pointerup', this._on3DUp, true);
        this._on3DMove = null;
        this._on3DUp = null;
        if (this._drag3d) {
            this._drag3d = null;
            this._syncPanel();
        }
    }

    /**
     * The light a press at a tile point means. A light LOOKS like its whole
     * glow, so the whole glow is clickable — not a pinpoint at its centre —
     * and among overlapping glows the one whose centre is proportionally
     * closest wins, so a small lamp inside a big wash is still selectable.
     */
    _lightNear(at, grip) {
        const map = this.map();
        if (!map || typeof RRMapLights === 'undefined') return null;
        let best = null;
        let bestScore = Infinity;
        for (const raw of RRMapLights.list(map)) {
            const light = RRMapLights.normalize(raw, raw.id || 'light');
            const anchor = this._lightAnchor(light);
            if (!anchor) continue;
            const distance = Math.hypot(at.x - anchor.x, at.y - anchor.y);
            const reach = Math.max(grip, Math.min(light.radius, 7));
            if (distance > reach) continue;
            const score = distance / reach;
            if (score < bestScore) {
                best = light;
                bestScore = score;
            }
        }
        return best;
    }

    /** The map view's zoom, so screen-sized grips stay screen-sized. */
    _viewScale() {
        const container = this.tilemapManager?.container;
        return (container && container.scale && container.scale.x) || 1;
    }

    _tilePoint(event, container) {
        const pos = event.data.getLocalPosition(container);
        const tw = this.tileSize();
        return { x: pos.x / tw, y: pos.y / tw };
    }

    _pointerDown(event, container) {
        if (!this.active || !this.map() || event.data.button !== 0) return;
        const at = this._tilePoint(event, container);

        if (this.placing) {
            const preset = this._placingTemplate || this.placing;
            if (!event.data.originalEvent?.shiftKey) this.armPlacement(null);
            this.place(preset, at.x, at.y);
            return;
        }

        const grab = this._grabAt(at);
        if (!grab) {
            this.select(null);
            return;
        }
        if (grab.id !== this.selectedId) this.select(grab.id);
        this.pushUndo();
        this.drag = grab;
        container.cursor = 'grabbing';
    }

    /** What a press at a tile point takes hold of: a handle, then a light. */
    _grabAt(at) {
        const map = this.map();
        if (!map || typeof RRMapLights === 'undefined') return null;
        const tw = this.tileSize();
        // Handles are drawn at a screen size, so their grip is a screen size
        // too — 12 map-pixels at 53% zoom was a six-pixel target.
        const grip = Math.max(16 / (tw * this._viewScale()), 0.3);
        const selected = this.selected();
        if (selected) {
            const light = RRMapLights.normalize(selected, selected.id);
            const anchor = this._lightAnchor(light);
            if (anchor) {
                const handle = light.type === 'spot'
                    ? { point: this._aimPoint(light, anchor), mode: 'aim' }
                    : { point: this._reachPoint(light, anchor), mode: 'reach' };
                if (Math.hypot(at.x - handle.point.x, at.y - handle.point.y) <= grip) {
                    return { id: light.id, mode: handle.mode, anchor };
                }
            }
        }
        // The light whose glow the press lands in — the glow IS the light,
        // as far as an eye and a cursor are concerned.
        const light = this._lightNear(at, grip);
        if (light) {
            const anchor = this._lightAnchor(light);
            return {
                id: light.id, mode: 'move',
                offsetX: at.x - anchor.x, offsetY: at.y - anchor.y, anchor
            };
        }
        return null;
    }

    _pointerMove(event, container) {
        if (!this.active) return;
        const at = this._tilePoint(event, container);
        if (this.placing) {
            // Show the light you are about to make, where you are about to
            // make it — before the click commits anything.
            this._moveGhost(at);
            return;
        }
        if (!this.drag) return;
        const map = this.map();
        if (!map || typeof RRMapLights === 'undefined') return;
        const drag = this.drag;
        const light = RRMapLights.get(map, drag.id);
        if (!light) return;
        if (drag.mode === 'move') {
            const base = light.attach && light.attach.event
                ? this._carrierBase(light) : { x: 0, y: 0 };
            RRMapLights.update(map, drag.id, {
                x: Math.round((at.x - drag.offsetX - base.x) * 100) / 100,
                y: Math.round((at.y - drag.offsetY - base.y) * 100) / 100
            });
        } else if (drag.mode === 'reach') {
            RRMapLights.update(map, drag.id, {
                radius: Math.round(Math.hypot(at.x - drag.anchor.x, at.y - drag.anchor.y) * 100) / 100
            });
        } else if (drag.mode === 'aim') {
            const dx = at.x - drag.anchor.x;
            const dy = at.y - drag.anchor.y;
            RRMapLights.update(map, drag.id, {
                yaw: Math.round(Math.atan2(dx, dy) * 180 / Math.PI),
                radius: Math.round(Math.hypot(dx, dy) * 100) / 100
            });
        }
        this._changed();
    }

    _carrierBase(light) {
        const event = (this.map()?.events || [])[light.attach.event];
        return event ? { x: event.x + 0.5, y: event.y + 0.5 } : { x: 0, y: 0 };
    }

    /** The glow that follows the cursor while placement is armed. */
    _moveGhost(at) {
        const state = this._overlay;
        if (!state || typeof RRMapLights === 'undefined') return;
        const tw = this.tileSize();
        if (!this._ghost) {
            this._ghost = new PIXI.Sprite();
            this._ghost.blendMode = 'add';
            state.glow.addChild(this._ghost);
        }
        const template = this._placingTemplate || {};
        const spot = this.placing === 'spot';
        this._ghost.texture = this._lightTexture(spot ? 'cone' : 'round');
        const reach = (template.radius
            || (spot ? RRMapLights.DEFAULT_CONE_LENGTH : 3)) * tw;
        if (spot) {
            this._ghost.anchor.set(0.5, 1);
            const spread = ((template.angle || RRMapLights.DEFAULT_CONE_ANGLE) * Math.PI) / 360;
            this._ghost.width = Math.max(2, 2 * Math.tan(spread) * reach);
            this._ghost.height = Math.max(2, reach);
            this._ghost.rotation = Math.PI;
        } else {
            this._ghost.anchor.set(0.5, 0.5);
            this._ghost.rotation = 0;
            this._ghost.width = this._ghost.height = Math.max(2, reach * 2);
        }
        this._ghost.tint = this._colourNumber(template.color || (spot ? '#fff2cc' : '#ffcf7d'));
        this._ghost.alpha = 0.55;
        this._ghost.position.set(at.x * tw, at.y * tw);
        this._ghost.visible = true;
    }

    _pointerUp() {
        if (!this.drag) return;
        this.drag = null;
        const container = this.tilemapManager?.container;
        if (container) container.cursor = 'default';
        this._syncPanel();
    }

    _keyDown(event) {
        if (!this.active) return;
        const editing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
        if (event.key === 'Escape') {
            if (this.placing) {
                this.placing = null;
                this._syncAddButtons();
            } else this.select(null);
            return;
        }
        if (editing) return;
        if (event.key === 'Delete' || event.key === 'Backspace') {
            if (this.selectedId) {
                event.preventDefault();
                event.stopPropagation();
                this.removeSelected();
            }
        } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
            event.preventDefault();
            event.stopPropagation();
            event.shiftKey ? this.redo() : this.undo();
        } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
            event.preventDefault();
            event.stopPropagation();
            this.redo();
        }
    }

    //-------------------------------------------------------------------------
    // Animation tick: animated lights breathe, the 3D preview stays live,
    // and a map switch under the open panel rebuilds cleanly.

    _startTicking() {
        if (this._raf) return;
        const tick = () => {
            if (!this.active) return;
            this._raf = requestAnimationFrame(tick);
            this._frame++;
            if (this.map() !== this._boundMap) {
                this._boundMap = this.map();
                this.selectedId = null;
                this._undo = [];
                this._redo = [];
                this._destroyOverlay();
                this._buildOverlay();
                this._syncPanel();
            }
            // The 3D view toggles and rebuilds its canvas underneath the
            // open panel; follow it so placement clicks always land.
            if (this._surface3D() !== this._bound3D) {
                this._unbind3DPointer();
                this._bind3DPointer();
                this._sync3D();
            }
            const animated = this.resolvedLights(this._frame).some(light => light.animated);
            if (animated || this.drag) this.render(this._frame);
            if (animated) this._sync3D(this._frame);
        };
        this._raf = requestAnimationFrame(tick);
    }

    _stopTicking() {
        if (this._raf) cancelAnimationFrame(this._raf);
        this._raf = null;
    }

    //-------------------------------------------------------------------------
    // 3D preview: the real compositor, fed the same resolved lights.

    _sync3D(frame = this._frame) {
        const map3d = this.mapEditor3D();
        const scene = map3d?.mapScene;
        if (!map3d?.isEnabled?.() || !scene || typeof Reactor3D === 'undefined') return;
        const ambient = this.ambient();
        Reactor3D.setAmbient({
            intensity: ambient.ambient,
            colour: this._colourNumber(ambient.ambientColour)
        });
        Reactor3D.setLights(this.resolvedLights(frame).map(light => ({
            type: light.type, x: light.x, y: light.y, height: light.height,
            radius: light.radius, colour: light.colour, intensity: light.intensity,
            angle: light.angle, yaw: -light.yaw, occlude: light.occlude
        })));
        const map = this.map();
        const focus = map ? { x: map.width / 2, y: map.height / 2 } : null;
        scene.syncLights?.(focus);
        // The editor renders one pass, so the light group joins it instead of
        // waiting for a "lights" pass that never comes.
        if (scene.lightGroup) scene.lightGroup().visible = true;
        this._update3DRing(scene);
    }

    /**
     * A visible answer to "did my click do anything?" in the 3D view: a
     * bright ring on the ground under the selected light.
     */
    _update3DRing(scene) {
        const selected = this.selected();
        if (!selected || typeof THREE === 'undefined' || !scene || !scene.scene) {
            this._hide3DRing();
            return;
        }
        const light = typeof RRMapLights !== 'undefined'
            ? RRMapLights.normalize(selected, selected.id) : selected;
        const anchor = this._lightAnchor(light);
        if (!anchor) {
            this._hide3DRing();
            return;
        }
        this._showRingAt(scene, anchor);
    }

    _showRingAt(scene, anchor) {
        if (!this._ring3d) {
            const geometry = new THREE.RingGeometry(0.42, 0.55, 40);
            const material = new THREE.MeshBasicMaterial({
                color: 0xffd34d, transparent: true, opacity: 0.95,
                side: THREE.DoubleSide, depthTest: false
            });
            this._ring3d = new THREE.Mesh(geometry, material);
            this._ring3d.rotation.x = -Math.PI / 2;
            this._ring3d.renderOrder = 30;
        }
        if (this._ring3d.parent !== scene.scene()) scene.scene().add(this._ring3d);
        const m3d = this.mapEditor3D();
        const ground = typeof Reactor3D !== 'undefined' && Reactor3D.elevationAt && m3d?.currentMap
            ? Reactor3D.elevationAt(m3d.currentMap(), Math.round(anchor.x), Math.round(anchor.y))
            : 0;
        this._ring3d.position.set(anchor.x + 0.5, ground + 0.06, anchor.y + 1);
        this._ring3d.visible = true;
    }

    _hide3DRing() {
        if (this._ring3d) this._ring3d.visible = false;
    }

    _dispose3DRing() {
        if (!this._ring3d) return;
        if (this._ring3d.parent) this._ring3d.parent.remove(this._ring3d);
        this._ring3d.geometry.dispose();
        this._ring3d.material.dispose();
        this._ring3d = null;
    }

    _clear3D() {
        this._dispose3DRing();
        if (typeof Reactor3D === 'undefined') return;
        Reactor3D.setLights([]);
        Reactor3D.setAmbient(null);
        const scene = this.mapEditor3D()?.mapScene;
        scene?.syncLights?.(null);
        if (scene?.lightGroup) scene.lightGroup().visible = false;
    }

    //-------------------------------------------------------------------------
    // Panel

    _el(tag, className, text) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text !== undefined) el.textContent = text;
        return el;
    }

    _buildPanel() {
        this._destroyPanel();
        const panel = this._el('div', 'lighting-panel');
        panel.id = 'lighting-panel';
        // Docked inside the workspace, below the map info bar — floating
        // fixed at the window's top right it sat on the map checkboxes.
        const workspace = document.getElementById('workspace');
        const infoBar = document.getElementById('map-info-content');
        let top = 44;
        if (workspace && infoBar) {
            const workspaceTop = workspace.getBoundingClientRect().top;
            top = Math.max(0, Math.round(infoBar.getBoundingClientRect().bottom - workspaceTop)) + 6;
        }
        panel.style.cssText = (workspace
            ? 'position:absolute;top:' + top + 'px;right:8px;bottom:8px;z-index:900;'
            : 'position:fixed;top:84px;right:12px;bottom:12px;z-index:9000;')
            + 'width:288px;display:flex;flex-direction:column;gap:10px;padding:12px;overflow-y:auto;'
            + 'background:var(--color-bg-panel);border:1px solid var(--color-border);'
            + 'border-radius:6px;box-shadow:0 6px 24px rgba(0,0,0,.45);font-size:12px;color:var(--color-text);';
        if (workspace && !workspace.style.position) workspace.style.position = 'relative';

        const header = this._el('div');
        header.style.cssText = 'display:flex;align-items:center;gap:8px;';
        const title = this._el('div', '', this._k('lit.title'));
        title.style.cssText = 'font-weight:700;font-size:13px;flex:1;';
        header.appendChild(title);
        this._titleHost = title;
        const close = this._el('button', 'rr-btn-secondary', '×');
        close.type = 'button';
        close.style.cssText = 'width:24px;height:24px;padding:0;line-height:1;';
        close.addEventListener('click', () => this.setActive(false));
        header.appendChild(close);
        panel.appendChild(header);

        panel.appendChild(this._buildAmbientSection());
        panel.appendChild(this._buildAddRow());
        this._statusHost = this._el('div');
        this._statusHost.style.cssText = 'display:none;padding:6px 8px;border-radius:4px;'
            + 'background:var(--color-accent);color:var(--color-bg-deep);'
            + 'font-size:11px;font-weight:700;text-align:center;';
        panel.appendChild(this._statusHost);
        this._listHost = this._el('div');
        this._listHost.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
        panel.appendChild(this._listHost);
        this._propsHost = this._el('div');
        panel.appendChild(this._propsHost);

        (workspace || document.body).appendChild(panel);
        this._panel = panel;
        this._syncPanel();
    }

    _destroyPanel() {
        if (this._panel?.parentElement) this._panel.parentElement.removeChild(this._panel);
        this._panel = null;
        this._listHost = null;
        this._propsHost = null;
    }

    _section(title) {
        const box = this._el('div');
        box.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:8px;'
            + 'border:1px solid var(--color-border);border-radius:4px;';
        const heading = this._el('div', '', title);
        heading.style.cssText = 'font-weight:700;font-size:11px;letter-spacing:.03em;color:var(--color-text-muted);';
        box.appendChild(heading);
        return box;
    }

    _row(label, control) {
        const row = this._el('label');
        row.style.cssText = 'display:grid;grid-template-columns:88px 1fr;gap:6px;align-items:center;color:var(--color-text-muted);font-size:11px;';
        row.appendChild(this._el('span', '', label));
        row.appendChild(control);
        return row;
    }

    _input(type, value, onCommit) {
        const input = this._el('input');
        input.type = type;
        input.value = value;
        input.style.cssText = 'width:100%;box-sizing:border-box;padding:3px 5px;'
            + 'background:var(--color-bg-input);color:var(--color-text);'
            + 'border:1px solid var(--color-border-input);border-radius:3px;';
        if (type === 'color') input.style.padding = '0';
        if (type === 'checkbox') input.style.width = 'auto';
        input.addEventListener('change', () => onCommit(input));
        return input;
    }

    _buildAmbientSection() {
        const box = this._section(this._k('lit.ambient'));
        const ambient = this.ambient();

        const level = this._input('range', String(Math.round(ambient.ambient * 100)), () => {});
        level.min = '0';
        level.max = '100';
        level.step = '1';
        const readout = this._el('span', '', Math.round(ambient.ambient * 100) + '%');
        const levelWrap = this._el('div');
        levelWrap.style.cssText = 'display:flex;gap:6px;align-items:center;';
        levelWrap.append(level, readout);
        const applyLevel = () => {
            readout.textContent = level.value + '%';
            this._setAmbient({ ambient: Number(level.value) / 100 });
        };
        level.addEventListener('input', applyLevel);
        box.appendChild(this._row(this._k('lit.brightness'), levelWrap));

        const colour = this._input('color', ambient.ambientColour, input => {
            this._setAmbient({ ambientColour: input.value });
        });
        box.appendChild(this._row(this._k('lit.color'), colour));

        const presets = this._el('div');
        presets.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';
        for (const [key, values] of [
            ['lit.day', { ambient: 1, ambientColour: '#ffffff' }],
            ['lit.dusk', { ambient: 0.55, ambientColour: '#ffc9a0' }],
            ['lit.night', { ambient: 0.22, ambientColour: '#9db4ff' }],
            ['lit.indoor', { ambient: 0.45, ambientColour: '#ffe9c4' }]
        ]) {
            const button = this._el('button', 'rr-btn-secondary', this._k(key));
            button.type = 'button';
            button.style.cssText = 'padding:3px 8px;font-size:11px;';
            button.addEventListener('click', () => {
                level.value = String(Math.round(values.ambient * 100));
                readout.textContent = level.value + '%';
                colour.value = values.ambientColour;
                this._setAmbient(values);
            });
            presets.appendChild(button);
        }
        box.appendChild(presets);
        this._ambientControls = { level, readout, colour };
        return box;
    }

    _setAmbient(values) {
        const map = this.map();
        if (!map || typeof RRMapLights === 'undefined') return;
        RRMapLights.setAmbient(map, values);
        this.render();
        this._sync3D();
    }

    /**
     * The light tray: a grid of glowing chips. Drag one onto the map and the
     * glow follows the cursor until you drop it; click one to arm sticky
     * placement instead. Each chip is drawn from the light's own texture in
     * its own colour, so the tray reads like a box of lights, not buttons.
     */
    _buildAddRow() {
        const tray = this._el('div');
        tray.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:6px;';
        this._addButtons = {};
        for (const preset of this._presets()) {
            const chip = this._el('button');
            chip.type = 'button';
            chip.title = this._k('lit.empty');
            chip.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:3px;'
                + 'padding:5px 2px;border:1px solid var(--color-border);border-radius:5px;'
                + 'background:var(--color-bg-input);color:var(--color-text);cursor:grab;'
                + 'font-size:10px;touch-action:none;';
            chip.appendChild(this._presetIcon(preset));
            chip.appendChild(this._el('span', '', preset.label));
            chip.addEventListener('pointerdown', event => this._chipDown(event, preset));
            this._addButtons[preset.key] = chip;
            tray.appendChild(chip);
        }
        return tray;
    }

    /** A chip's face: a bold SVG mark in the preset's own colour. */
    _presetIcon(preset) {
        const holder = this._el('span');
        holder.style.cssText = 'width:30px;height:30px;display:block;pointer-events:none;';
        holder.innerHTML = '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">'
            + this._presetSvg(preset.key, preset.template.color) + '</svg>';
        return holder;
    }

    _presetSvg(key, c) {
        switch (key) {
            case 'spot': return '<path d="M8 2.6 h8 l2.2 4.4 h-12.4 Z" fill="#cfd6e2"/>'
                + `<path d="M6.6 7 h10.8 L15.2 21.4 h-6.4 Z" fill="${c}" opacity="0.92"/>`;
            case 'candle': return '<rect x="9.4" y="10" width="5.2" height="11.4" rx="1.4" fill="#e8e3d5"/>'
                + `<path d="M12 2.4 C14.7 5.3 14.3 7.5 12 9.2 C9.7 7.5 9.3 5.3 12 2.4 Z" fill="${c}"/>`
                + '<path d="M12 4.8 C13.2 6.2 13 7.2 12 8 C11 7.2 10.8 6.2 12 4.8 Z" fill="#ffffff" opacity="0.85"/>';
            case 'lamp': return `<circle cx="12" cy="9.4" r="6.6" fill="${c}"/>`
                + '<circle cx="10" cy="7.4" r="2" fill="#ffffff" opacity="0.55"/>'
                + '<rect x="9.4" y="15.4" width="5.2" height="3" fill="#cfd6e2"/>'
                + '<rect x="10.3" y="18.8" width="3.4" height="2.6" rx="1.1" fill="#9aa0ad"/>';
            case 'neon': return `<rect x="2.6" y="8.2" width="18.8" height="7.6" rx="3.8" fill="none" stroke="${c}" stroke-width="3.4"/>`
                + '<rect x="2.6" y="8.2" width="18.8" height="7.6" rx="3.8" fill="none" stroke="#ffffff" stroke-width="1.1" opacity="0.75"/>';
            case 'alarm': return `<path d="M4.8 14.4 a7.2 7.2 0 0 1 14.4 0 v2 h-14.4 Z" fill="${c}"/>`
                + '<rect x="3.2" y="16.8" width="17.6" height="3.2" rx="1.3" fill="#9aa0ad"/>'
                + `<g stroke="${c}" stroke-width="2.3" stroke-linecap="round">`
                + '<line x1="12" y1="1.4" x2="12" y2="4.2"/>'
                + '<line x1="4.2" y1="4.6" x2="6.3" y2="6.7"/>'
                + '<line x1="19.8" y1="4.6" x2="17.7" y2="6.7"/></g>';
            case 'screen': return '<rect x="2.8" y="4.4" width="18.4" height="12.8" rx="1.8" fill="#141a24" stroke="#cfd6e2" stroke-width="1.7"/>'
                + `<rect x="5.2" y="6.8" width="13.6" height="8" fill="${c}" opacity="0.9"/>`
                + '<rect x="8.6" y="19" width="6.8" height="2.3" rx="1.1" fill="#9aa0ad"/>';
            case 'torch': return '<rect x="10.5" y="9.6" width="3" height="12.2" rx="1.3" fill="#8a6a4a" transform="rotate(16 12 16)"/>'
                + `<path d="M12 1.8 C15.6 5.3 15.2 8.5 12 10.8 C8.8 8.5 8.4 5.3 12 1.8 Z" fill="${c}"/>`
                + '<path d="M12 4.6 C13.7 6.5 13.5 8 12 9.2 C10.5 8 10.3 6.5 12 4.6 Z" fill="#ffffff" opacity="0.8"/>';
            case 'streetlamp': return '<rect x="6.2" y="6.4" width="2" height="15" fill="#9aa0ad"/>'
                + '<rect x="3.6" y="20.4" width="7.2" height="1.9" rx="0.9" fill="#9aa0ad"/>'
                + '<path d="M7.2 6.8 Q12 3.4 16.6 6.4" fill="none" stroke="#9aa0ad" stroke-width="2"/>'
                + `<circle cx="17.2" cy="8.6" r="3.6" fill="${c}"/>`
                + `<g stroke="${c}" stroke-width="1.7" stroke-linecap="round" opacity="0.75">`
                + '<line x1="17.2" y1="13.4" x2="17.2" y2="15.8"/>'
                + '<line x1="13.7" y1="11.7" x2="12" y2="13.4"/>'
                + '<line x1="20.7" y1="11.7" x2="22.4" y2="13.4"/></g>';
            default: return `<circle cx="12" cy="12" r="5.2" fill="${c}"/>`
                + '<circle cx="10.2" cy="10.2" r="1.7" fill="#ffffff" opacity="0.6"/>'
                + `<g stroke="${c}" stroke-width="2.4" stroke-linecap="round">`
                + '<line x1="12" y1="1.6" x2="12" y2="4.8"/>'
                + '<line x1="12" y1="19.2" x2="12" y2="22.4"/>'
                + '<line x1="1.6" y1="12" x2="4.8" y2="12"/>'
                + '<line x1="19.2" y1="12" x2="22.4" y2="12"/>'
                + '<line x1="4.7" y1="4.7" x2="6.9" y2="6.9"/>'
                + '<line x1="17.1" y1="17.1" x2="19.3" y2="19.3"/>'
                + '<line x1="19.3" y1="4.7" x2="17.1" y2="6.9"/>'
                + '<line x1="6.9" y1="17.1" x2="4.7" y2="19.3"/></g>';
        }
    }

    /** Drag a chip onto the map, or click it to arm sticky placement. */
    _chipDown(event, preset) {
        if (event.button !== 0) return;
        event.preventDefault();
        const start = { x: event.clientX, y: event.clientY };
        let dragging = false;
        const move = e => {
            if (!dragging && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5) return;
            if (!dragging) {
                dragging = true;
                this.armPlacement(preset.template);
            }
            this._ghostFromClient(e.clientX, e.clientY);
        };
        const up = e => {
            window.removeEventListener('pointermove', move, true);
            window.removeEventListener('pointerup', up, true);
            if (dragging) {
                const at = this._tileFromClient(e.clientX, e.clientY);
                this.armPlacement(null);
                if (at) this.place(preset.template, at.x, at.y);
            } else {
                this.armPlacement(this._armedKey === preset.key ? null : preset.template);
            }
        };
        window.addEventListener('pointermove', move, true);
        window.addEventListener('pointerup', up, true);
    }

    _syncAddButtons() {
        for (const [key, button] of Object.entries(this._addButtons || {})) {
            const armed = this._armedKey === key;
            button.classList.toggle('active', armed);
            button.style.outline = armed ? '2px solid var(--color-accent)' : '';
        }
        // The cursor says what a click will do, on both canvases.
        const cursor = this.placing ? 'crosshair' : 'default';
        const container = this.tilemapManager?.container;
        if (container) container.cursor = cursor;
        const surface = this._bound3D;
        if (surface && surface.style) surface.style.cursor = cursor;
        if (this._statusHost) {
            this._statusHost.textContent = this.placing ? this._k('lit.placing') : '';
            this._statusHost.style.display = this.placing ? '' : 'none';
        }
        if (!this.placing && this._ghost) this._ghost.visible = false;
    }

    _syncPanel() {
        if (!this._panel) return;
        // The count doubles as a truth meter: a map that should have ten
        // lights showing "· 0" says the session is looking at stale data.
        if (this._titleHost) {
            this._titleHost.textContent = this._k('lit.title') + ' · ' + this.lights().length;
        }
        this._syncList();
        this._syncProps();
        const ambient = this.ambient();
        if (this._ambientControls && document.activeElement !== this._ambientControls.level) {
            this._ambientControls.level.value = String(Math.round(ambient.ambient * 100));
            this._ambientControls.readout.textContent = Math.round(ambient.ambient * 100) + '%';
            this._ambientControls.colour.value = ambient.ambientColour;
        }
    }

    _syncList() {
        const host = this._listHost;
        if (!host) return;
        host.replaceChildren();
        const lights = this.lights();
        if (!lights.length) {
            // The empty state is the manual: make it read like one.
            const empty = this._el('div', '', this._k('lit.empty'));
            empty.style.cssText = 'color:var(--color-text);font-size:12px;line-height:1.5;'
                + 'padding:10px;border:1px dashed var(--color-accent);border-radius:4px;';
            host.appendChild(empty);
            return;
        }
        for (const raw of lights) {
            const light = typeof RRMapLights !== 'undefined'
                ? RRMapLights.normalize(raw, raw.id || 'light') : raw;
            const row = this._el('button');
            row.type = 'button';
            const selected = light.id === this.selectedId;
            row.style.cssText = 'display:flex;gap:8px;align-items:center;padding:4px 6px;'
                + 'border:1px solid ' + (selected ? 'var(--color-accent)' : 'var(--color-border)') + ';'
                + 'border-radius:3px;background:' + (selected ? 'var(--color-bg-selected)' : 'var(--color-bg-input)') + ';'
                + 'color:var(--color-text);cursor:pointer;font-size:11px;text-align:left;';
            const swatch = this._el('span');
            swatch.style.cssText = 'width:12px;height:12px;border-radius:50%;flex:0 0 auto;'
                + 'background:' + light.color + ';opacity:' + (light.on ? 1 : 0.3) + ';'
                + 'border:1px solid rgba(0,0,0,.5);';
            row.appendChild(swatch);
            const name = this._el('span', '', light.id
                + (light.tag ? ' #' + light.tag : '')
                + ' · ' + this._k(light.type === 'spot' ? 'lit.spot' : 'lit.point'));
            name.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            row.appendChild(name);
            row.addEventListener('click', () => this.select(light.id));
            host.appendChild(row);
        }
    }

    _syncProps() {
        const host = this._propsHost;
        if (!host) return;
        host.replaceChildren();
        const selected = this.selected();
        if (!selected || typeof RRMapLights === 'undefined') return;
        const light = RRMapLights.normalize(selected, selected.id);
        const box = this._section(light.id);
        const commit = patch => {
            this.pushUndo();
            this.updateSelected(patch);
        };
        const numberInput = (key, value, min, max, step) => {
            const input = this._input('number', String(value), field => {
                const patch = {};
                patch[key] = Number(field.value);
                commit(patch);
            });
            input.min = String(min);
            input.max = String(max);
            input.step = String(step);
            return input;
        };

        const type = this._el('select');
        type.style.cssText = 'width:100%;padding:3px 5px;background:var(--color-bg-input);'
            + 'color:var(--color-text);border:1px solid var(--color-border-input);border-radius:3px;';
        for (const [value, key] of [['point', 'lit.point'], ['spot', 'lit.spot']]) {
            const option = this._el('option', '', this._k(key));
            option.value = value;
            type.appendChild(option);
        }
        type.value = light.type;
        type.addEventListener('change', () => commit({ type: type.value }));
        box.appendChild(this._row(this._k('lit.type'), type));

        box.appendChild(this._row(this._k('lit.color'),
            this._input('color', light.color, input => commit({ color: input.value }))));
        box.appendChild(this._row(this._k('lit.intensity'), numberInput('intensity', light.intensity, 0, 4, 0.05)));
        box.appendChild(this._row(this._k('lit.radius'), numberInput('radius', light.radius, 0.1, 200, 0.1)));
        box.appendChild(this._row(this._k('lit.height'), numberInput('height', light.height, 0, 512, 0.1)));
        if (light.type === 'spot') {
            box.appendChild(this._row(this._k('lit.yaw'), numberInput('yaw', light.yaw, -180, 180, 1)));
            box.appendChild(this._row(this._k('lit.angle'), numberInput('angle', light.angle, 1, 179, 1)));
        }
        box.appendChild(this._row(this._k('lit.flicker'), numberInput('flicker', light.flicker, 0, 1, 0.05)));

        const pulse = this._input('checkbox', '', input => {
            commit({ pulse: input.checked ? { min: 0.6, max: 1, period: 90 } : null });
        });
        pulse.checked = !!light.pulse;
        box.appendChild(this._row(this._k('lit.pulse'), pulse));
        if (light.pulse) {
            const pulseField = (key, labelKey, min, max, step) => {
                const input = this._input('number', String(light.pulse[key]), field => {
                    const next = Object.assign({}, light.pulse);
                    next[key] = Number(field.value);
                    commit({ pulse: next });
                });
                input.min = String(min);
                input.max = String(max);
                input.step = String(step);
                box.appendChild(this._row(this._k(labelKey), input));
            };
            pulseField('min', 'lit.pulseMin', 0, 10, 0.05);
            pulseField('max', 'lit.pulseMax', 0, 10, 0.05);
            pulseField('period', 'lit.pulsePeriod', 2, 100000, 1);
        }

        const tag = this._input('text', light.tag, input => commit({ tag: input.value.trim() }));
        box.appendChild(this._row(this._k('lit.tag'), tag));

        const attach = this._el('select');
        attach.style.cssText = type.style.cssText;
        const none = this._el('option', '', this._k('lit.attachNone'));
        none.value = '';
        attach.appendChild(none);
        const player = this._el('option', '', this._k('lit.attachPlayer'));
        player.value = 'player';
        attach.appendChild(player);
        for (const event of this.map()?.events || []) {
            if (!event) continue;
            const option = this._el('option', '',
                'EV' + String(event.id).padStart(3, '0') + (event.name ? ' ' + event.name : ''));
            option.value = String(event.id);
            attach.appendChild(option);
        }
        attach.value = light.attach
            ? (light.attach.player ? 'player' : String(light.attach.event)) : '';
        attach.addEventListener('change', () => {
            commit({
                attach: !attach.value ? null
                    : attach.value === 'player' ? { player: true }
                        : { event: Number(attach.value) }
            });
        });
        box.appendChild(this._row(this._k('lit.attach'), attach));

        const flags = this._el('div');
        flags.style.cssText = 'display:flex;gap:14px;';
        for (const [key, label] of [['on', 'lit.on'], ['occlude', 'lit.occlude']]) {
            const wrap = this._el('label');
            wrap.style.cssText = 'display:flex;gap:5px;align-items:center;font-size:11px;';
            const input = this._input('checkbox', '', field => {
                const patch = {};
                patch[key] = field.checked;
                commit(patch);
            });
            input.checked = !!light[key];
            wrap.append(input, this._el('span', '', this._k(label)));
            flags.appendChild(wrap);
        }
        box.appendChild(flags);

        const actions = this._el('div');
        actions.style.cssText = 'display:flex;gap:6px;';
        const duplicate = this._el('button', 'rr-btn-secondary', this._k('lit.duplicate'));
        duplicate.type = 'button';
        duplicate.addEventListener('click', () => this.duplicateSelected());
        const remove = this._el('button', 'rr-btn-secondary', this._k('lit.delete'));
        remove.type = 'button';
        remove.addEventListener('click', () => this.removeSelected());
        for (const button of [duplicate, remove]) button.style.cssText = 'flex:1;padding:4px;font-size:11px;';
        actions.append(duplicate, remove);
        box.appendChild(actions);

        host.appendChild(box);
    }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
    module.exports = LightingManager;
}
