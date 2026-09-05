/**
 * LightingManager - the visual Lighting tool.
 *
 * A toolbar mode with its own side panel: click the map to place point and
 * spot lights, drag them, pull their reach and aim handles, and tune ambient
 * darkness live. The 2D view uses the runtime's ambient tint and additive
 * ground-plane light falloff, with all floor illumination below the props.
 * The 3D view runs the real pooled light compositor.
 *
 * Data lives in the map sidecar through RRMapLights; placing a light is the
 * whole opt-in. Undo is whole-state snapshots, Ctrl+Z / Ctrl+Y while the
 * tool is active.
 */
class LightingManager {
    /** Bumped with every Lighting change; shown at the panel's foot. */
    static BUILD = 'r14 · 2026-09-04';

    constructor(projectController) {
        this.projectController = projectController;
        this.active = false;
        this.selectedId = null;
        this.placing = null;          // 'point' | 'spot' while placement is armed
        this.drag = null;             // { id, mode: 'move'|'reach'|'aim', ... }
        this._listeners = [];
        this._overlay = null;
        this._glowSprites = [];
        this._propGlowGroups = new Map();
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
        // And a session older than the map's file says so, with the fix.
        this._syncDiskNotice();
    }

    /** The map's sidecar as it exists on disk right now, or null. */
    _diskLights() {
        try {
            const project = this.projectController?.getCurrentProject?.()
                || this.projectController?.currentProject;
            const map = this.map();
            if (!project?.path || !map?.id || typeof require !== 'function') return null;
            const path = require('path');
            const fs = require('fs');
            const file = path.join(project.path, 'data',
                'Map' + String(map.id).padStart(3, '0') + '.r3d.json');
            if (!fs.existsSync(file)) return null;
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
            return {
                lights: Array.isArray(parsed.lights) ? parsed.lights : [],
                lighting: parsed.lighting && typeof parsed.lighting === 'object'
                    ? parsed.lighting : null
            };
        } catch (error) {
            return null;
        }
    }

    /**
     * The cure for the stale-session saga: when the file on disk carries
     * lights this session's map has never loaded, the panel says so and
     * loads them on one click — no restart ritual, no silent zero.
     */
    _syncDiskNotice() {
        if (!this._noticeHost) return;
        this._noticeHost.replaceChildren();
        this._noticeHost.style.display = 'none';
        const disk = this._diskLights();
        if (!disk || disk.lights.length <= this.lights().length) return;
        const note = this._el('div', '', this._k('lit.diskNewer'));
        note.style.cssText = 'color:var(--color-text);font-size:11px;line-height:1.45;';
        const button = this._el('button', 'rr-button-primary', this._k('lit.reload'));
        button.type = 'button';
        button.style.cssText = 'padding:5px 8px;font-size:11px;';
        button.addEventListener('click', () => {
            const map = this.map();
            const fresh = this._diskLights();
            if (!map || !fresh) return;
            this.pushUndo();
            const sidecar = map.reactor3d || (map.reactor3d = { version: 1 });
            sidecar.lights = fresh.lights;
            if (fresh.lighting) sidecar.lighting = fresh.lighting;
            this.selectedId = null;
            this._changed();
            this._syncDiskNotice();
        });
        this._noticeHost.append(note, button);
        this._noticeHost.style.display = 'flex';
    }

    _deactivate() {
        this.placing = null;
        this.drag = null;
        this._unbindPointer();
        this._unbind3DPointer();
        document.removeEventListener('keydown', this._onKeyDown);
        this._overlay?.markers.clear();
        if (this._ghost) this._ghost.visible = false;
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
    /**
     * The tray. Every preset hangs at a height: a light in the floor plane
     * pools brightest right under itself and can only shade the floor with a
     * streak along it, while a lamp a tile or two up lights a room the way
     * a lamp does and throws what stands in it onto the floor.
     */
    /** The shared preset table, each chip named in the current locale. */
    _presets() {
        const table = typeof RRMapLights !== 'undefined' && RRMapLights.PRESETS ? RRMapLights.PRESETS : [];
        return table.map(preset => ({
            key: preset.key,
            label: this._k(preset.labelKey),
            template: RRMapLights.presetTemplate(preset.key)
        }));
    }

    armPlacement(preset) {
        if (!preset) {
            this.placing = null;
            this._placingTemplate = null;
            this._armedKey = null;
        } else if (typeof preset === 'string') {
            this.placing = preset === 'spot' ? 'spot' : preset === 'beam' ? 'beam' : 'point';
            this._placingTemplate = null;
            this._armedKey = this.placing;
        } else {
            this.placing = preset.type === 'spot' ? 'spot' : preset.type === 'beam' ? 'beam' : 'point';
            this._placingTemplate = preset;
            this._armedKey = preset.key || this.placing;
        }
        this._syncAddButtons();
    }

    place(preset, x, y) {
        const map = this.map();
        if (!map || typeof RRMapLights === 'undefined') return null;
        const template = typeof preset === 'string'
            ? { type: preset, color: preset === 'spot' ? '#fff2cc' : preset === 'beam' ? '#ff2a2a' : '#ffcf7d' }
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
            const priorityRadius = radius;
            const priorityIntensity = intensity;
            if (light.flicker) {
                const seed = i * 13.7;
                const jitter = Math.sin(frame * 0.31 + seed) * Math.sin(frame * 0.127 + seed * 1.7);
                intensity *= 1 - light.flicker * (0.25 + 0.25 * jitter);
                radius *= 1 - light.flicker * 0.06 * jitter;
            }
            out.push({
                id: light.id, type: light.type, x, y, height: light.height,
                radius, intensity, angle: light.angle, width: light.width, yaw: light.yaw, pitch: light.pitch,
                priorityRadius, priorityIntensity,
                colour: this._colourNumber(light.color), occlude: light.occlude,
                shadow: light.shadow,
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
        const textures = this._lightTextures || (this._lightTextures = new Map());
        if (textures.has(kind)) return textures.get(kind);
        const size = 1024, canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const context = canvas.getContext('2d'), image = context.createImageData(size, size);
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
            const u = (x + 0.5) / size, v = (y + 0.5) / size;
            const along = 1 - v;
            let alpha;
            if (kind === 'round') {
                alpha = Math.pow(Math.max(0, 1 - Math.hypot(u * 2 - 1, v * 2 - 1)), 2);
            } else {
                const across = Math.abs(u * 2 - 1) / (kind === 'cone' ? Math.max(along, 1 / size) : 1);
                const rim = across >= 1 ? 0 : Math.pow(0.5 * (1 + Math.cos(across * Math.PI)), 2);
                // A continuous beam core avoids the old hard shoulder at 35%.
                const core = kind === 'beam' ? Math.min(1, rim + 0.35 * Math.exp(-Math.pow(across / 0.3, 4))) : rim;
                alpha = core * (kind === 'beam' ? Math.sqrt(v) : v * v);
            }
            // Stable sub-level dithering breaks quantization rings. This runs
            // once per shape, never per light or animation frame.
            let hash = Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263);
            hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
            const noise = ((hash ^ (hash >>> 16)) >>> 0) / 4294967296 - 0.5;
            const at = (y * size + x) * 4;
            image.data[at] = image.data[at + 1] = image.data[at + 2] = 255;
            image.data[at + 3] = alpha > 0 ? Math.max(0, Math.min(255, Math.round(alpha * 255 + noise))) : 0;
        }
        context.putImageData(image, 0, 0);
        const texture = PIXI.Texture.from(canvas);
        // The editor's pixel-art default is nearest; light gradients need
        // interpolation even while tiles and model art keep their own filter.
        texture.source.scaleMode = 'linear';
        textures.set(kind, texture);
        return texture;
    }

    _buildOverlay() {
        const container = this.tilemapManager?.container;
        const map = this.map();
        if (!container || !map || typeof PIXI === 'undefined') return;
        if (this._overlay?.root.parent === container) return;
        this._destroyOverlay();
        const overlay = new PIXI.Container();
        overlay.label = 'lighting-overlay';
        overlay.eventMode = 'none';
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
        for (const sprite of this._glowSprites) {
            if (!sprite.destroyed) sprite.destroy({ texture: false, textureSource: false });
        }
        for (const group of this._propGlowGroups.values()) {
            if (!group.destroyed) group.destroy({ children: true, texture: false, textureSource: false });
        }
        this._propGlowGroups.clear();
        const darkness = this._overlay.darkness;
        if (!darkness.destroyed && darkness.parent !== this._overlay.root) darkness.destroy();
        const root = this._overlay.root;
        if (root.parent) root.parent.removeChild(root);
        if (!root.destroyed) root.destroy({ children: true, texture: false, textureSource: false });
        this._overlay = null;
        this._glowSprites = [];
        this._ghost = null;
    }

    /** Carried glows sit immediately behind their emitter in the flat depth
     * order. A foreground prop then covers both, using ordinary alpha drawing. */
    _glowParent(light, state, props) {
        const source = props?._sprites.get(light.sourcePropId) || (light.shadow ? props?.container : null);
        const groupId = light.sourcePropId ?? '$floor';
        if (!source?.parent) return state.glow;
        let group = this._propGlowGroups.get(groupId);
        if (!group || group.destroyed) {
            group = new PIXI.Container();
            group.__livePropLight = true;
            group.eventMode = 'none';
            this._propGlowGroups.set(groupId, group);
        }
        const parent = source.parent;
        const index = parent.getChildIndex(source);
        if (group.parent !== parent) parent.addChildAt(group, index);
        else if (parent.getChildIndex(group) !== index - 1) {
            parent.setChildIndex(group, index - (parent.getChildIndex(group) < index ? 1 : 0));
        }
        return group;
    }

    /** Draw the darkness, the lights and the markers for this frame. */
    render(frame = this._frame) {
        const state = this._overlay;
        const map = this.map();
        if (!state || !map || typeof Reactor3D === 'undefined') return;
        const tw = this.tileSize();

        const ambient = this.ambient();
        state.darkness.tint = Reactor3D.flatAmbientTint({
            intensity: ambient.ambient, colour: this._colourNumber(ambient.ambientColour)
        });
        state.darkness.width = map.width * tw;
        state.darkness.height = map.height * tw;
        const props = this.projectController?.modelPropsManager;
        const lights = this.resolvedLights(frame).concat(props?.preview2D?.lights || []);
        const enabled = ambient.enabled !== false && (this.active || lights.length > 0 || !!map.reactor3d?.lighting);
        state.darkness.visible = state.glow.visible = !!enabled;
        // Ambient must stay below the glows. Tint the retained model sprites
        // by the same factor, so moving the darkness below props neither
        // brightens the models nor dims a light a second time.
        const propLayer = props?.container;
        const mapLayer = propLayer?.parent;
        if (mapLayer) {
            const floor = this._propGlowGroups.get('$floor');
            const index = mapLayer.getChildIndex(floor?.parent === mapLayer ? floor : propLayer);
            if (state.darkness.parent !== mapLayer) mapLayer.addChildAt(state.darkness, index);
            else if (mapLayer.getChildIndex(state.darkness) !== index - 1) {
                mapLayer.setChildIndex(state.darkness, index - (mapLayer.getChildIndex(state.darkness) < index ? 1 : 0));
            }
            props.setAmbientTint(enabled ? state.darkness.tint : 0xffffff);
        }
        for (const [id, group] of this._propGlowGroups) {
            if (id !== '$floor' && !props?._sprites.has(id)) {
                if (!group.destroyed) group.destroy({ children: false });
                this._propGlowGroups.delete(id);
            }
        }
        // Props/event layers may finish loading after the overlay was built.
        const parent = state.root.parent;
        if (parent && parent.children[parent.children.length - 1] !== state.root) parent.setChildIndex(state.root, parent.children.length - 1);
        let used = 0;
        for (const light of lights) {
            const bounds = FlatLightField2D.bounds(light, map);
            if (!bounds) continue;
            const shadow = light.shadow && props?.preview2D?.shadows?.states.get(light.id);
            let sprite = this._glowSprites[used];
            if (!sprite || sprite.destroyed) {
                sprite = new FlatShadowLight2D(PIXI.Texture.WHITE);
                sprite.blendMode = 'add';
                this._glowSprites[used] = sprite;
            }
            // All floor illumination shares one depth plane. Interleaving
            // whole light fans between props made overlaps depend on sort order.
            const glowParent = this._glowParent({ shadow: true }, state, props);
            if (sprite.parent !== glowParent) glowParent.addChild(sprite);
            sprite.visible = !!enabled;
            sprite.tint = light.colour;
            sprite.alpha = Reactor3D.flatLightOpacity(light);
            sprite.syncLight(light, bounds, shadow, tw);
            used++;
        }
        for (let i = used; i < this._glowSprites.length; i++) this._glowSprites[i].visible = false;

        state.markers.clear();
        if (this.active) this._renderMarkers(state.markers, tw);
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
            if (light.type === 'spot' || light.type === 'beam') {
                const aim = this._aimPoint(light, at);
                const spread = (light.angle * Math.PI) / 360;
                const yaw = (light.yaw * Math.PI) / 180;
                const dir = side => ({
                    x: x + Math.sin(yaw + side * spread) * light.radius * tw,
                    y: y + Math.cos(yaw + side * spread) * light.radius * tw
                });
                if (light.type === 'beam') {
                    g.moveTo(x, y).lineTo(aim.x * tw, aim.y * tw)
                        .stroke({ width: 3 / zoom, color: colour, alpha: 0.85 });
                } else {
                    const left = dir(-1), right = dir(1);
                    g.moveTo(x, y).lineTo(left.x, left.y)
                        .moveTo(x, y).lineTo(right.x, right.y)
                        .stroke({ width: 1.5 / zoom, color: 0xffffff, alpha: 0.55 });
                }
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
        if (light.attach) {
            // No carrier in the editor (the player, a missing event): the
            // light draws nowhere, so it must not be clickable anywhere.
            // Its row in the panel list stays the way to select it.
            if (!light.attach.event) return null;
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
        // A ring or an arrow on the selected light outranks whatever is
        // under it: the gizmo is what the cursor is on.
        if (!this.placing) {
            const hold = this._pickGizmo3D(event.clientX, event.clientY);
            if (hold) {
                this.pushUndo();
                this._start3DDrag({ gizmo: hold });
                event.preventDefault();
                event.stopImmediatePropagation();
                return;
            }
        }
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
        if (!hit) {
            // Not ours: the orbit and the props keep the click — but the
            // panel still explains what a placing click would have needed.
            this._flashStatus(this._k('lit.pickFirst'));
            return;
        }
        if (hit.id !== this.selectedId) this.select(hit.id);
        this.pushUndo();
        const anchor = this._lightAnchor(hit) || at;
        this._start3DDrag({ id: hit.id, offsetX: at.x - anchor.x, offsetY: at.y - anchor.y });
        event.preventDefault();
        event.stopImmediatePropagation();
    }

    _start3DDrag(state) {
        this._drag3d = state;
        this._on3DMove = e => this._pointer3DMove(e);
        this._on3DUp = () => this._end3DDrag();
        window.addEventListener('pointermove', this._on3DMove, true);
        window.addEventListener('pointerup', this._on3DUp, true);
    }

    _pointer3DMove(event) {
        const drag = this._drag3d;
        const map = this.map();
        const m3d = this.mapEditor3D();
        if (!drag || !map || !m3d || typeof RRMapLights === 'undefined') return;
        if (drag.gizmo) {
            this._dragGizmo3D(drag.gizmo, event.clientX, event.clientY);
            return;
        }
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
        if (this._rings3d && typeof RRPoseRings3D !== 'undefined') RRPoseRings3D.emphasize(this._rings3d, null, false);
        if (this._arrows3d && typeof RRAxisArrows3D !== 'undefined') RRAxisArrows3D.emphasize(this._arrows3d, null, false);
        if (this._drag3d) {
            this._drag3d = null;
            this._syncPanel();
        }
    }

    /**
     * The world position of a light's source: its anchor tile's centre, the
     * ground there, and its height — the runtime's own placing rule.
     */
    _lightWorld(anchor, height) {
        const m3d = this.mapEditor3D();
        const ground = typeof Reactor3D !== 'undefined' && Reactor3D.elevationAt && m3d?.currentMap
            ? Reactor3D.elevationAt(m3d.currentMap(), Math.round(anchor.x), Math.round(anchor.y))
            : 0;
        return { x: anchor.x + 0.5, y: ground + (Number(height) || 0), z: anchor.y + 1 };
    }

    /**
     * The gizmo the props wear, on the selected light: axis arrows slide the
     * source along X, Z and up; the green ring turns the aim and the red ring
     * tilts it. Nothing has a roll, and a point light has nothing to aim, so
     * it wears the arrows alone. Yaw and pitch flip sign into the scene's
     * frame the way the compositor feed does.
     */
    _syncGizmo3D(scene, light, anchor) {
        if (typeof RRPoseRings3D === 'undefined' || typeof RRAxisArrows3D === 'undefined') return;
        const root = scene.scene();
        if (!root) return;
        if (!this._rings3d) {
            this._rings3d = RRPoseRings3D.create(THREE, 0.75, 'light-rings');
            this._rings3d.roll.group.visible = false;
        }
        if (!this._arrows3d) this._arrows3d = RRAxisArrows3D.create(THREE, 0.9, 'light-arrows');
        if (this._rings3d.root.parent !== root) root.add(this._rings3d.root);
        if (this._arrows3d.root.parent !== root) root.add(this._arrows3d.root);
        const world = this._lightWorld(anchor, light.height);
        RRPoseRings3D.sync(this._rings3d, world, -light.yaw, -light.pitch, light.type !== 'point');
        RRAxisArrows3D.sync(this._arrows3d, world, true);
    }

    _hideGizmo3D() {
        if (this._rings3d) this._rings3d.root.visible = false;
        if (this._arrows3d) this._arrows3d.root.visible = false;
    }

    _disposeGizmo3D() {
        if (this._rings3d && typeof RRPoseRings3D !== 'undefined') RRPoseRings3D.dispose(this._rings3d);
        if (this._arrows3d && typeof RRAxisArrows3D !== 'undefined') RRAxisArrows3D.dispose(this._arrows3d);
        this._rings3d = null;
        this._arrows3d = null;
    }

    _gizmoRect() {
        const m3d = this.mapEditor3D();
        if (!m3d) return null;
        const surface = m3d.inputSurface || m3d.canvas;
        const rect = surface?.getBoundingClientRect?.();
        return rect?.width && rect?.height ? rect : null;
    }

    /** An arrow or ring of the selected light under the pointer, as a hold, or null. */
    _pickGizmo3D(clientX, clientY) {
        const m3d = this.mapEditor3D();
        const selected = this.selected();
        const rect = this._gizmoRect();
        if (!selected || !m3d?.camera || !rect || typeof RRMapLights === 'undefined' || typeof THREE === 'undefined') return null;
        const light = RRMapLights.normalize(selected, selected.id);
        if (this._arrows3d && this._arrows3d.root.visible && typeof RRAxisArrows3D !== 'undefined') {
            const arrow = RRAxisArrows3D.pick(THREE, this._arrows3d, m3d.camera, rect, clientX, clientY);
            if (arrow) {
                RRAxisArrows3D.emphasize(this._arrows3d, arrow.axis, true);
                return { kind: 'arrow', grab: arrow, id: light.id, startX: light.x, startY: light.y, startZ: light.height };
            }
        }
        if (this._rings3d && this._rings3d.root.visible && typeof RRPoseRings3D !== 'undefined') {
            const ring = RRPoseRings3D.pick(THREE, this._rings3d, m3d.camera, rect, clientX, clientY,
                { yaw: -light.yaw, pitch: -light.pitch, roll: 0 });
            if (ring) {
                RRPoseRings3D.emphasize(this._rings3d, ring.axis, true);
                return { kind: 'ring', grab: ring, id: light.id };
            }
        }
        return null;
    }

    _dragGizmo3D(hold, clientX, clientY) {
        const m3d = this.mapEditor3D();
        const map = this.map();
        const rect = this._gizmoRect();
        if (!m3d?.camera || !map || !rect || typeof RRMapLights === 'undefined') return;
        const round = n => Math.round(n * 100) / 100;
        let patch = null;
        if (hold.kind === 'arrow') {
            const travel = hold.grab.travel(clientX, clientY);
            patch = hold.grab.axis === 'x' ? { x: round(hold.startX + travel) }
                : hold.grab.axis === 'z' ? { y: round(hold.startY + travel) }
                    : { height: Math.max(0, round(hold.startZ + travel)) };
        } else {
            const value = RRPoseRings3D.drag(THREE, hold.grab, m3d.camera, rect, clientX, clientY);
            if (value === null) return;
            patch = hold.grab.axis === 'yaw'
                ? { yaw: Math.round(-value) }
                : { pitch: Math.max(-90, Math.min(90, Math.round(-value))) };
        }
        RRMapLights.update(map, hold.id, patch);
        this._changed();
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
            // A click that routed nowhere says so, instead of doing nothing.
            this._flashStatus(this._k('lit.pickFirst'));
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
                const handle = light.type === 'spot' || light.type === 'beam'
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
        const beam = this.placing === 'beam';
        this._ghost.texture = this._lightTexture(beam ? 'beam' : spot ? 'cone' : 'round');
        const reach = (template.radius
            || (spot ? RRMapLights.DEFAULT_CONE_LENGTH : beam ? RRMapLights.DEFAULT_BEAM_LENGTH : 3)) * tw;
        if (spot || beam) {
            this._ghost.anchor.set(0.5, 1);
            const spread = ((template.angle || RRMapLights.DEFAULT_CONE_ANGLE) * Math.PI) / 360;
            this._ghost.width = beam
                ? Math.max(2, (template.width || RRMapLights.DEFAULT_BEAM_WIDTH) * tw)
                : Math.max(2, 2 * Math.tan(spread) * reach);
            this._ghost.height = Math.max(2, reach);
            this._ghost.rotation = Math.PI;
        } else {
            this._ghost.anchor.set(0.5, 0.5);
            this._ghost.rotation = 0;
            this._ghost.width = this._ghost.height = Math.max(2, reach * 2);
        }
        this._ghost.tint = this._colourNumber(template.color || (spot ? '#fff2cc' : beam ? '#ff2a2a' : '#ffcf7d'));
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
            this._raf = requestAnimationFrame(tick);
            if (document.hidden || this.mapEditor3D()?.suspended) return;
            if (this.active && this._surface3D() !== this._bound3D) {
                this._unbind3DPointer();
                this._bind3DPointer();
                this._sync3D();
            }
            if (this.mapEditor3D()?.isEnabled?.()) {
                if (this._overlay) this._overlay.root.visible = false;
                return;
            }
            this._frame++;
            if (typeof Reactor3D === 'undefined') {
                const sidecar = this.map()?.reactor3d;
                if (!this.active && !sidecar?.lighting && !sidecar?.lights?.length && !sidecar?.props?.length) return;
                if (!this._previewLibraries) this._previewLibraries = this.mapEditor3D()?.ensureLibraries?.()
                    .catch(error => console.warn('Could not load lighting preview:', error));
                return;
            }
            if (this.map() !== this._boundMap || this._overlay?.root.parent !== this.tilemapManager?.container) {
                this._boundMap = this.map();
                this.selectedId = null;
                this._undo = [];
                this._redo = [];
                this._destroyOverlay();
                this._buildOverlay();
                this._syncPanel();
                this._syncDiskNotice();
            }
            if (this._overlay) this._overlay.root.visible = true;
            const modelLights = this.projectController?.modelPropsManager?.preview2D?.lights || [];
            const animated = modelLights.length > 0 || this.resolvedLights(this._frame).some(light => light.animated);
            // Static maps need only a cheap periodic refresh for sidecar edits.
            if (animated || this.drag || this._frame % 6 === 1) this.render(this._frame);
        };
        this._raf = requestAnimationFrame(tick);
    }

    _stopTicking() {
        if (this._raf) cancelAnimationFrame(this._raf);
        this._raf = null;
    }

    //-------------------------------------------------------------------------
    // 3D preview: the real compositor, fed the same resolved lights.

    /**
     * Feed the map's lights into the shared 3D compositor. The 3D view calls
     * this on every frame it draws and then composites the light group as its
     * own additive pass — the same shape as the game's render. A lit map
     * looks lit whenever the 3D view is open, whether or not this panel is:
     * the lights are authored map content, like the props.
     */
    feed3D() {
        const map3d = this.mapEditor3D();
        const scene = map3d?.mapScene;
        if (!map3d?.isEnabled?.() || !scene || typeof Reactor3D === 'undefined') return;
        const ambient = this.ambient();
        // Lights that placed models carry (a light-type model effect), resolved by the 3D view each frame.
        const modelLights = Array.isArray(Reactor3D._editorEffectLights) ? Reactor3D._editorEffectLights : [];
        if (!this.lights().length && !modelLights.length && ambient.ambient === undefined) {
            // Nothing placed and no ambient block: leave the compositor
            // untouched so an unlit map never even builds the light pools.
            Reactor3D.setLights([]);
            Reactor3D.setAmbient(null);
            return;
        }
        this._frame++;
        Reactor3D.setAmbient({
            intensity: ambient.ambient,
            colour: this._colourNumber(ambient.ambientColour)
        });
        Reactor3D.setLights(this.resolvedLights(this._frame).map(light => ({
            id: light.id, type: light.type, x: light.x, y: light.y, height: light.height,
            radius: light.radius, colour: light.colour, intensity: light.intensity,
            priorityRadius: light.priorityRadius, priorityIntensity: light.priorityIntensity,
            angle: light.angle, width: light.width, yaw: -light.yaw, pitch: light.pitch, occlude: light.occlude,
            shadow: light.shadow
        })).concat(modelLights));
        const map = this.map();
        const focus = map ? { x: map.width / 2, y: map.height / 2 } : null;
        scene.syncLights?.(focus);
        this._update3DRing(scene);
    }

    /**
     * Whether the 3D view should keep drawing frames for lighting's sake:
     * always while the panel works, and while any placed light animates.
     */
    wants3DFrames() {
        if (this.active) return true;
        if (typeof Reactor3D !== 'undefined' && Array.isArray(Reactor3D._editorEffectLights) && Reactor3D._editorEffectLights.length) return true;
        if (!this.map()?.reactor3d?.lights?.length) return false;
        return this.resolvedLights(this._frame).some(light => light.animated);
    }

    _sync3D() {
        this.feed3D();
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
        this._syncGizmo3D(scene, light, anchor);
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
        this._hideGizmo3D();
    }

    _dispose3DRing() {
        this._disposeGizmo3D();
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
            + 'width:300px;';
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
        this._statusHost = this._el('div', 'lit-status');
        this._statusHost.style.display = 'none';
        panel.appendChild(this._statusHost);
        this._noticeHost = this._el('div', 'lit-notice');
        this._noticeHost.style.display = 'none';
        panel.appendChild(this._noticeHost);

        const list = this._section(this._k('lit.list'));
        this._listMeta = list.meta;
        this._listHost = this._el('div', 'lit-list');
        list.body.appendChild(this._listHost);
        panel.appendChild(list.section);

        this._propsHost = this._el('div');
        this._propsHost.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
        panel.appendChild(this._propsHost);

        // The build stamp turns "is my editor running this code?" from a
        // guessing game into a glance.
        const stamp = this._el('div', '', 'Lighting ' + LightingManager.BUILD);
        stamp.style.cssText = 'margin-top:auto;padding-top:6px;color:var(--color-text-muted);'
            + 'font-size:10px;text-align:right;opacity:0.8;';
        panel.appendChild(stamp);

        (workspace || document.body).appendChild(panel);
        this._panel = panel;
        this._syncPanel();
    }

    _destroyPanel() {
        if (typeof RRColourPopover !== 'undefined') RRColourPopover.close();
        if (this._panel?.parentElement) this._panel.parentElement.removeChild(this._panel);
        this._panel = null;
        this._listHost = null;
        this._listMeta = null;
        this._propsHost = null;
        this._gesture = false;
    }

    /**
     * A card: the accent-strip header every section in the app wears, a
     * body, and (on request) a toolbar-tone footer for the card's actions.
     */
    _section(title, meta) {
        const section = this._el('div', 'lit-section');
        const header = this._el('div', 'lit-section-header');
        header.appendChild(this._el('span', '', title));
        const metaHost = this._el('span', 'lit-section-meta', meta || '');
        header.appendChild(metaHost);
        const body = this._el('div', 'lit-section-body');
        section.append(header, body);
        return { section, header, meta: metaHost, body };
    }

    _footer(section) {
        const footer = this._el('div', 'lit-section-footer');
        section.appendChild(footer);
        return footer;
    }

    /** A titled group inside a card body. */
    _group(parent, title) {
        const group = this._el('div', 'lit-group');
        group.appendChild(this._el('div', 'lit-group-title', title));
        parent.appendChild(group);
        return group;
    }

    _row(label, control) {
        const row = this._el('label', 'lit-row');
        row.appendChild(this._el('span', '', label));
        row.appendChild(control);
        return row;
    }

    _input(type, value, onCommit) {
        const input = this._el('input', 'lit-input');
        input.type = type;
        input.value = value;
        input.addEventListener('change', () => onCommit(input));
        return input;
    }

    _select(options, value, onChange) {
        const select = this._el('select', 'lit-select');
        for (const [optionValue, label] of options) {
            const option = this._el('option', '', label);
            option.value = optionValue;
            select.appendChild(option);
        }
        select.value = value;
        select.addEventListener('change', () => onChange(select.value, select));
        return select;
    }

    /**
     * A slider with its number beside it. Dragging edits live without
     * rebuilding the panel; letting go commits and rebuilds, so the number
     * shows what the store actually kept.
     */
    /**
     * The rail's accent fill ends under the thumb: a CSS variable the track
     * gradient reads, kept current from the value. (Chromium has no
     * built-in progress fill for a styled range.)
     */
    _trackFill(range) {
        const paint = () => {
            const min = Number(range.min) || 0;
            const max = Number(range.max);
            const span = Number.isFinite(max) && max > min ? max - min : 1;
            const pct = Math.max(0, Math.min(100, ((Number(range.value) - min) / span) * 100));
            range.style.setProperty('--rr-fill', pct.toFixed(1) + '%');
        };
        paint();
        range.addEventListener('input', paint);
        range.__rrPaint = paint;
        return range;
    }

    _slider(key, value, min, max, step, options) {
        const settings = options || {};
        const wrap = this._el('div', 'lit-slider');
        const range = this._el('input');
        range.type = 'range';
        range.min = String(min);
        range.max = String(max);
        range.step = String(step);
        range.value = String(value);
        this._trackFill(range);
        const number = this._el('input', 'lit-input');
        number.type = 'number';
        number.setAttribute('data-no-stepper', '');
        number.min = String(settings.numberMin !== undefined ? settings.numberMin : min);
        number.max = String(settings.numberMax !== undefined ? settings.numberMax : max);
        number.step = String(step);
        number.value = String(value);
        const read = field => {
            const n = Number(field.value);
            return Number.isFinite(n) ? n : Number(value) || 0;
        };
        range.addEventListener('input', () => {
            number.value = range.value;
            this._liveUpdate({ [key]: read(range) });
        });
        range.addEventListener('change', () => this._endGesture({ [key]: read(range) }));
        number.addEventListener('change', () => this._endGesture({ [key]: read(number) }));
        wrap.append(range, number);
        return wrap;
    }

    /** A colour swatch that opens the editor's own picker, editing live. */
    _colour(value, onLive, onDone) {
        if (typeof RRColourPopover !== 'undefined') {
            return RRColourPopover.swatch(value, onLive, onDone);
        }
        return this._input('color', value, input => onDone(input.value));
    }

    /**
     * Mid-gesture edit of the selected light: one undo entry for the whole
     * drag, the views follow, the panel is left alone so the control being
     * dragged keeps its focus.
     */
    _liveUpdate(patch) {
        const map = this.map();
        if (!map || !this.selectedId || typeof RRMapLights === 'undefined') return;
        if (!this._gesture) {
            this.pushUndo();
            this._gesture = true;
        }
        RRMapLights.update(map, this.selectedId, patch);
        this.render();
        this._sync3D();
    }

    /** The end of a gesture, or a one-shot edit: the store's value wins and the panel rebuilds. */
    _endGesture(patch) {
        if (!this._gesture) this.pushUndo();
        this._gesture = false;
        this.updateSelected(patch);
    }

    /** Give the selected light the id typed for it, if the map can take it. */
    _renameSelected(field) {
        const map = this.map();
        const next = String(field.value || '').trim();
        if (!map || !this.selectedId || typeof RRMapLights === 'undefined') return;
        if (next === this.selectedId) return;
        const ok = RRMapLights.ID_PATTERN.test(next) && !RRMapLights.get(map, next);
        if (!ok) {
            field.classList.add('lit-bad');
            field.value = this.selectedId;
            this._flashStatus(this._k('lit.idBad'));
            return;
        }
        this.pushUndo();
        if (RRMapLights.rename(map, this.selectedId, next)) this.selectedId = next;
        this._changed();
    }

    _buildAmbientSection() {
        const card = this._section(this._k('lit.ambient'));
        const box = card.body;
        const ambient = this.ambient();

        const level = this._input('range', String(Math.round(ambient.ambient * 100)), () => {});
        level.min = '0';
        level.max = '100';
        level.step = '1';
        this._trackFill(level);
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

        const colour = this._colour(ambient.ambientColour,
            hex => this._setAmbient({ ambientColour: hex }),
            hex => this._setAmbient({ ambientColour: hex }));
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
                if (colour.setValue) colour.setValue(values.ambientColour); else colour.value = values.ambientColour;
                this._setAmbient(values);
            });
            presets.appendChild(button);
        }
        box.appendChild(presets);
        this._ambientControls = { level, readout, colour };
        return card.section;
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
        const card = this._section(this._k('lit.tray'));
        const tray = this._el('div', 'lit-tray');
        card.body.appendChild(tray);
        this._addButtons = {};
        for (const preset of this._presets()) {
            const chip = this._el('button', 'lit-chip');
            chip.type = 'button';
            chip.title = this._k('lit.empty');
            chip.appendChild(this._presetIcon(preset));
            chip.appendChild(this._el('span', '', preset.label));
            chip.addEventListener('pointerdown', event => this._chipDown(event, preset));
            this._addButtons[preset.key] = chip;
            tray.appendChild(chip);
        }
        return card.section;
    }

    /** A hex colour pushed toward white (positive) or black (negative). */
    _shade(hex, amount) {
        const n = this._colourNumber(hex);
        const channel = shift => {
            const value = (n >> shift) & 0xff;
            const moved = amount >= 0
                ? value + (255 - value) * amount
                : value * (1 + amount);
            return Math.round(Math.max(0, Math.min(255, moved)));
        };
        return '#' + ((channel(16) << 16) | (channel(8) << 8) | channel(0))
            .toString(16).padStart(6, '0');
    }

    /**
     * A chip's face, in the app's own icon language: near-black ink drawn
     * fat under every shape, a saturated three-stop gradient in the preset's
     * colour on top, and a bright rim — the toolbar's sticker look.
     */
    _presetIcon(preset) {
        const holder = this._el('span');
        holder.style.cssText = 'width:30px;height:30px;display:block;pointer-events:none;';
        const colour = preset.template.color;
        const id = 'lit-' + preset.key;
        holder.innerHTML = '<svg viewBox="0 0 64 64" width="30" height="30" aria-hidden="true">'
            + '<defs><linearGradient id="' + id + '" x1="14" y1="8" x2="50" y2="58" gradientUnits="userSpaceOnUse">'
            + '<stop stop-color="' + this._shade(colour, 0.6) + '"/>'
            + '<stop offset=".5" stop-color="' + colour + '"/>'
            + '<stop offset="1" stop-color="' + this._shade(colour, -0.55) + '"/>'
            + '</linearGradient></defs>'
            + this._presetSvg(preset.key, 'url(#' + id + ')', colour)
            + '</svg>';
        return holder;
    }

    _presetSvg(key, fill, colour) {
        const INK = '#01030a';
        const rim = this._shade(colour, 0.45);
        const rays = pairs => variant =>
            `<g stroke="${variant.stroke}" stroke-width="${variant.width}" stroke-linecap="round">`
            + pairs.map(([x1, y1, x2, y2]) =>
                `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`).join('')
            + '</g>';
        switch (key) {
            case 'spot': return `<path d="M18 4 h28 l7 14 h-42 Z" fill="${INK}"/>`
                + `<path d="M21 6.5 h22 l4.8 9.5 h-31.6 Z" fill="#cfd6e2" stroke="#24bdf3" stroke-width="2"/>`
                + `<path d="M13 18 h38 L40.5 60 h-17 Z" fill="${INK}"/>`
                + `<path d="M16.5 20.5 h31 L38.5 56.5 h-13 Z" fill="${fill}" stroke="${rim}" stroke-width="2.5"/>`;
            case 'candle': return `<rect x="22.5" y="26.5" width="19" height="33" rx="4.5" fill="${INK}"/>`
                + '<rect x="25.5" y="29.5" width="13" height="27" rx="2.5" fill="#e8e3d5" stroke="#c9b98f" stroke-width="2"/>'
                + `<path d="M32 3.5 C41.5 12.5 40.5 20.5 32 26.5 C23.5 20.5 22.5 12.5 32 3.5 Z" fill="${INK}"/>`
                + `<path d="M32 7 C38.8 13.8 38 19.4 32 23.6 C26 19.4 25.2 13.8 32 7 Z" fill="${fill}"/>`
                + '<path d="M32 12.5 C35.6 16.2 35.3 18.8 32 21.2 C28.7 18.8 28.4 16.2 32 12.5 Z" fill="#fff2a0"/>';
            case 'lamp': return `<circle cx="32" cy="24.5" r="19.5" fill="${INK}"/>`
                + `<circle cx="32" cy="24.5" r="16.5" fill="${fill}" stroke="${rim}" stroke-width="2.5"/>`
                + '<circle cx="25.5" cy="18" r="4.5" fill="#ffffff" opacity="0.65"/>'
                + `<rect x="23" y="42" width="18" height="9" fill="${INK}"/>`
                + '<rect x="25.5" y="44" width="13" height="5" fill="#cfd6e2"/>'
                + `<rect x="25.5" y="50.5" width="13" height="9" rx="3.5" fill="${INK}"/>`
                + '<rect x="27.5" y="52.5" width="9" height="5" rx="2" fill="#9aa0ad"/>';
            case 'neon': return `<rect x="6" y="20" width="52" height="24" rx="12" fill="none" stroke="${INK}" stroke-width="13"/>`
                + `<rect x="6" y="20" width="52" height="24" rx="12" fill="none" stroke="${fill}" stroke-width="7"/>`
                + '<rect x="6" y="20" width="52" height="24" rx="12" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.8"/>';
            case 'alarm': return rays([[32, 3, 32, 11], [10, 9, 15.5, 15], [54, 9, 48.5, 15]])({ stroke: INK, width: 9 })
                + rays([[32, 3, 32, 11], [10, 9, 15.5, 15], [54, 9, 48.5, 15]])({ stroke: colour, width: 4.5 })
                + `<path d="M12 40 a20 20 0 0 1 40 0 v5.5 h-40 Z" fill="${INK}"/>`
                + `<path d="M15 40 a17 17 0 0 1 34 0 v2.5 h-34 Z" fill="${fill}" stroke="${rim}" stroke-width="2"/>`
                + '<path d="M20.5 36.5 a12.5 12.5 0 0 1 8 -10.5" stroke="#ffffff" stroke-width="3.2" fill="none" opacity="0.65" stroke-linecap="round"/>'
                + `<rect x="8" y="46.5" width="48" height="9.5" rx="3.5" fill="${INK}"/>`
                + '<rect x="10.5" y="48.7" width="43" height="5" rx="2" fill="#9aa0ad"/>';
            case 'screen': return `<rect x="6" y="9.5" width="52" height="37" rx="5.5" fill="${INK}"/>`
                + '<rect x="9" y="12.5" width="46" height="31" rx="3" fill="#0b1220" stroke="#24bdf3" stroke-width="2"/>'
                + `<rect x="13" y="16.5" width="38" height="23" fill="${fill}"/>`
                + `<path d="M13 23 h38 M13 29.5 h38 M13 36 h38" stroke="${INK}" stroke-width="1.8" opacity="0.5"/>`
                + `<rect x="24" y="48" width="16" height="4.5" fill="${INK}"/>`
                + `<rect x="17" y="53" width="30" height="7" rx="3" fill="${INK}"/>`
                + '<rect x="19.5" y="54.8" width="25" height="3.4" rx="1.7" fill="#9aa0ad"/>';
            case 'torch': return `<rect x="26.5" y="25" width="11" height="36" rx="4.5" fill="${INK}" transform="rotate(14 32 43)"/>`
                + '<rect x="29" y="27.5" width="6" height="31" rx="3" fill="#8a6a4a" transform="rotate(14 32 43)"/>'
                + '<rect x="27.6" y="28" width="8.8" height="6.5" rx="2" fill="#d7318f" transform="rotate(14 32 43)"/>'
                + `<path d="M32 2 C43.5 11 42.5 21 32 28 C21.5 21 20.5 11 32 2 Z" fill="${INK}"/>`
                + `<path d="M32 5.5 C41 13 40.2 20 32 25 C23.8 20 23 13 32 5.5 Z" fill="${fill}"/>`
                + '<path d="M32 11.5 C36.8 15.6 36.4 19 32 22 C27.6 19 27.2 15.6 32 11.5 Z" fill="#fff2a0"/>';
            case 'laser': return `<path d="M8 50 L50 12" stroke="${INK}" stroke-width="12" stroke-linecap="round"/>`
                + `<path d="M8 50 L50 12" stroke="${colour}" stroke-width="6" stroke-linecap="round"/>`
                + '<path d="M8 50 L50 12" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" opacity="0.85"/>'
                + `<rect x="4" y="43" width="16" height="16" rx="4" fill="${INK}"/>`
                + '<rect x="6.5" y="45.5" width="11" height="11" rx="2.5" fill="#9aa0ad"/>'
                + `<circle cx="52" cy="10" r="7" fill="${INK}"/>`
                + `<circle cx="52" cy="10" r="4.5" fill="${fill}"/>`;
            case 'streetlamp': return `<rect x="14.5" y="13" width="10" height="47" rx="4" fill="${INK}"/>`
                + '<rect x="17.5" y="16" width="4" height="42" fill="#9aa0ad"/>'
                + `<rect x="7" y="54.5" width="25" height="7" rx="3" fill="${INK}"/>`
                + '<rect x="9.5" y="56.2" width="20" height="3.6" rx="1.8" fill="#9aa0ad"/>'
                + `<path d="M19 15 Q34 4.5 47 11.5" fill="none" stroke="${INK}" stroke-width="9.5" stroke-linecap="round"/>`
                + '<path d="M19 15 Q34 4.5 47 11.5" fill="none" stroke="#9aa0ad" stroke-width="4" stroke-linecap="round"/>'
                + `<circle cx="48" cy="17.5" r="11" fill="${INK}"/>`
                + `<circle cx="48" cy="17.5" r="8" fill="${fill}" stroke="${rim}" stroke-width="2"/>`
                + '<circle cx="45" cy="14.5" r="2.6" fill="#ffffff" opacity="0.7"/>'
                + rays([[48, 31.5, 48, 38], [37.5, 27, 33, 31.5], [58.5, 27, 63, 31.5]])({ stroke: INK, width: 8 })
                + rays([[48, 31.5, 48, 38], [37.5, 27, 33, 31.5], [58.5, 27, 63, 31.5]])({ stroke: colour, width: 3.6 });
            default: {
                const eight = [[32, 4, 32, 13], [32, 51, 32, 60], [4, 32, 13, 32], [51, 32, 60, 32],
                    [12.2, 12.2, 18.6, 18.6], [45.4, 45.4, 51.8, 51.8],
                    [51.8, 12.2, 45.4, 18.6], [18.6, 45.4, 12.2, 51.8]];
                return rays(eight)({ stroke: INK, width: 9.5 })
                    + rays(eight)({ stroke: colour, width: 5 })
                    + `<circle cx="32" cy="32" r="16.5" fill="${INK}"/>`
                    + `<circle cx="32" cy="32" r="13.5" fill="${fill}" stroke="${rim}" stroke-width="2.5"/>`
                    + '<circle cx="27" cy="27" r="4" fill="#ffffff" opacity="0.75"/>';
            }
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

    /** A transient hint in the status slot; placement narration outranks it. */
    _flashStatus(text) {
        if (!this._statusHost || this.placing) return;
        this._statusHost.textContent = text;
        this._statusHost.style.display = '';
        this._statusHost.style.background = 'var(--color-bg-input)';
        this._statusHost.style.color = 'var(--color-text)';
        clearTimeout(this._flashTimer);
        this._flashTimer = setTimeout(() => {
            if (!this._statusHost || this.placing) return;
            this._statusHost.style.display = 'none';
            this._statusHost.style.background = 'var(--color-accent)';
            this._statusHost.style.color = 'var(--color-bg-deep)';
        }, 2600);
    }

    _syncPanel() {
        if (!this._panel) return;
        // The count doubles as a truth meter: a map that should have ten
        // lights showing "· 0" says the session is looking at stale data.
        if (this._titleHost) {
            this._titleHost.textContent = this._k('lit.title') + ' · ' + this.lights().length;
        }
        if (this._listMeta) this._listMeta.textContent = String(this.lights().length);
        this._syncList();
        this._syncProps();
        const ambient = this.ambient();
        if (this._ambientControls && document.activeElement !== this._ambientControls.level) {
            this._ambientControls.level.value = String(Math.round(ambient.ambient * 100));
            this._ambientControls.readout.textContent = Math.round(ambient.ambient * 100) + '%';
            const colour = this._ambientControls.colour;
            if (colour.setValue) colour.setValue(ambient.ambientColour); else colour.value = ambient.ambientColour;
        }
    }

    _typeLabel(type) {
        return this._k(type === 'spot' ? 'lit.spot' : type === 'beam' ? 'lit.beam' : 'lit.point');
    }

    _syncList() {
        const host = this._listHost;
        if (!host) return;
        host.replaceChildren();
        const lights = this.lights();
        if (!lights.length) {
            // The empty state is the manual: make it read like one.
            host.appendChild(this._el('div', 'lit-empty', this._k('lit.empty')));
            return;
        }
        for (const raw of lights) {
            const light = typeof RRMapLights !== 'undefined'
                ? RRMapLights.normalize(raw, raw.id || 'light') : raw;
            const row = this._el('button', 'lit-list-row' + (light.id === this.selectedId ? ' selected' : ''));
            row.type = 'button';
            const swatch = this._el('span', 'lit-swatch-dot');
            swatch.style.background = light.color;
            swatch.style.opacity = light.on ? '1' : '0.3';
            row.appendChild(swatch);
            row.appendChild(this._el('span', 'lit-list-name', light.id + (light.tag ? ' #' + light.tag : '')));
            row.appendChild(this._el('span', 'lit-list-kind', this._typeLabel(light.type)));
            row.addEventListener('click', () => this.select(light.id));
            host.appendChild(row);
        }
    }

    /**
     * The tag control: a dropdown of every tag on the map, the presets'
     * tags, none, and "new", which turns into a field for the name.
     */
    _tagControl(light, commit) {
        const NEW = '*new*';
        const known = new Set(typeof RRMapLights !== 'undefined' ? RRMapLights.tags(this.map()) : []);
        for (const preset of this._presets()) if (preset.template.tag) known.add(preset.template.tag);
        if (light.tag) known.add(light.tag);
        const options = [['', this._k('lit.tagNone')]]
            .concat(Array.from(known).sort().map(tag => [tag, '#' + tag]))
            .concat([[NEW, this._k('lit.tagNew')]]);
        const host = this._el('div');
        const select = this._select(options, light.tag || '', value => {
            if (value !== NEW) {
                commit({ tag: value });
                return;
            }
            const field = this._el('input', 'lit-input');
            field.type = 'text';
            field.placeholder = this._k('lit.tagPlaceholder');
            field.maxLength = 40;
            field.spellcheck = false;
            let done = false;
            const finish = keep => {
                if (done) return;
                done = true;
                const tag = keep ? field.value.trim().replace(/^#+/, '') : '';
                if (tag) commit({ tag });
                else this._syncProps();
            };
            field.addEventListener('keydown', event => {
                if (event.key === 'Enter') { event.preventDefault(); finish(true); }
                if (event.key === 'Escape') { event.preventDefault(); finish(false); }
                event.stopPropagation();
            });
            field.addEventListener('blur', () => finish(true));
            host.replaceChildren(field);
            field.focus();
        });
        host.appendChild(select);
        return host;
    }

    _syncProps() {
        const host = this._propsHost;
        if (!host) return;
        host.replaceChildren();
        const selected = this.selected();
        const map = this.map();
        if (!selected || !map || typeof RRMapLights === 'undefined') return;
        const light = RRMapLights.normalize(selected, selected.id);
        const commit = patch => this._endGesture(patch);
        const numberInput = (key, value, min, max, step) => {
            const input = this._input('number', String(value), field => {
                const n = Number(field.value);
                commit({ [key]: Number.isFinite(n) ? n : value });
            });
            input.setAttribute('data-no-stepper', '');
            input.min = String(min);
            input.max = String(max);
            input.step = String(step);
            return input;
        };
        const aimed = light.type !== 'point';

        const card = this._section(this._k('lit.selected'), this._typeLabel(light.type));
        const body = card.body;

        // Identity: the id events address the light by, and what kind it is.
        const id = this._input('text', light.id, field => this._renameSelected(field));
        id.classList.add('lit-id-input');
        id.maxLength = 40;
        id.spellcheck = false;
        id.addEventListener('keydown', event => {
            if (event.key === 'Enter') { event.preventDefault(); id.blur(); }
            event.stopPropagation();
        });
        body.appendChild(this._row(this._k('lit.id'), id));
        body.appendChild(this._row(this._k('lit.type'), this._select(
            [['point', this._k('lit.point')], ['spot', this._k('lit.spot')], ['beam', this._k('lit.beam')]],
            light.type, value => commit({ type: value }))));

        // The light itself.
        const look = this._group(body, this._k('lit.section.light'));
        look.appendChild(this._row(this._k('lit.color'), this._colour(light.color,
            hex => this._liveUpdate({ color: hex }), hex => commit({ color: hex }))));
        look.appendChild(this._row(this._k('lit.intensity'), this._slider('intensity', light.intensity, 0, 4, 0.05)));
        look.appendChild(this._row(this._k('lit.radius'), this._slider('radius', light.radius, 0.1, 30, 0.1, { numberMax: 200 })));
        if (light.type === 'spot') {
            look.appendChild(this._row(this._k('lit.angle'), this._slider('angle', light.angle, 1, 179, 1)));
        }
        if (light.type === 'beam') {
            look.appendChild(this._row(this._k('lit.width'), this._slider('width', light.width, 0.005, 1, 0.005, { numberMax: 5 })));
        }

        // Where it stands: X and Y in tiles (offsets from the carrier when
        // attached), Z the height off the ground.
        const position = this._group(body, this._k('lit.position'));
        const attached = !!light.attach;
        const spanX = attached ? [-10, 10] : [0, Math.max(1, map.width || 1)];
        const spanY = attached ? [-10, 10] : [0, Math.max(1, map.height || 1)];
        position.appendChild(this._row(this._k('lit.x'), this._slider('x', light.x, spanX[0], spanX[1], 0.05, { numberMin: -10000, numberMax: 10000 })));
        position.appendChild(this._row(this._k('lit.y'), this._slider('y', light.y, spanY[0], spanY[1], 0.05, { numberMin: -10000, numberMax: 10000 })));
        position.appendChild(this._row(this._k('lit.height'), this._slider('height', light.height, 0, 12, 0.05, { numberMax: 512 })));

        // Which way it aims — nothing to aim on a point light.
        if (aimed) {
            const rotation = this._group(body, this._k('lit.rotation'));
            rotation.appendChild(this._row(this._k('lit.yaw'), this._slider('yaw', light.yaw, -180, 180, 1, { numberMin: -100000, numberMax: 100000 })));
            rotation.appendChild(this._row(this._k('lit.pitch'), this._slider('pitch', light.pitch, -90, 90, 1)));
        }

        // Motion in the light.
        const animation = this._group(body, this._k('lit.animation'));
        animation.appendChild(this._row(this._k('lit.flicker'), this._slider('flicker', light.flicker, 0, 1, 0.05)));
        const pulse = this._input('checkbox', '', input => {
            commit({ pulse: input.checked ? { min: 0.6, max: 1, period: 90 } : null });
        });
        pulse.checked = !!light.pulse;
        animation.appendChild(this._row(this._k('lit.pulse'), pulse));
        if (light.pulse) {
            const pulseField = (key, labelKey, min, max, step) => {
                const input = numberInput(key, light.pulse[key], min, max, step);
                input.addEventListener('change', () => {}, { once: true });
                // The number's own commit writes a top-level key; pulse keys
                // live one level down, so this field commits the object.
                input.onchange = () => {
                    const next = Object.assign({}, light.pulse);
                    const n = Number(input.value);
                    next[key] = Number.isFinite(n) ? n : light.pulse[key];
                    commit({ pulse: next });
                };
                animation.appendChild(this._row(this._k(labelKey), input));
            };
            pulseField('min', 'lit.pulseMin', 0, 10, 0.05);
            pulseField('max', 'lit.pulseMax', 0, 10, 0.05);
            pulseField('period', 'lit.pulsePeriod', 2, 100000, 1);
        }

        // Who it belongs with, what it rides, and its switches.
        const group = this._group(body, this._k('lit.group'));
        group.appendChild(this._row(this._k('lit.tag'), this._tagControl(light, commit)));
        const attachOptions = [['', this._k('lit.attachNone')], ['player', this._k('lit.attachPlayer')]];
        for (const event of map.events || []) {
            if (!event) continue;
            attachOptions.push([String(event.id),
                'EV' + String(event.id).padStart(3, '0') + (event.name ? ' ' + event.name : '')]);
        }
        const attachValue = light.attach ? (light.attach.player ? 'player' : String(light.attach.event)) : '';
        group.appendChild(this._row(this._k('lit.attach'), this._select(attachOptions, attachValue, value => {
            commit({
                attach: !value ? null
                    : value === 'player' ? { player: true }
                        : { event: Number(value) }
            });
        })));
        const flags = this._el('div', 'lit-flags');
        for (const [key, label] of [['on', 'lit.on'], ['occlude', 'lit.occlude'], ['shadow', 'lit.shadow']]) {
            const wrap = this._el('label');
            const input = this._input('checkbox', '', field => commit({ [key]: field.checked }));
            input.checked = !!light[key];
            wrap.append(input, this._el('span', '', this._k(label)));
            flags.appendChild(wrap);
        }
        group.appendChild(flags);

        const footer = this._footer(card.section);
        const duplicate = this._el('button', 'rr-btn-secondary', this._k('lit.duplicate'));
        duplicate.type = 'button';
        duplicate.addEventListener('click', () => this.duplicateSelected());
        const remove = this._el('button', 'rr-btn-secondary', this._k('lit.delete'));
        remove.type = 'button';
        remove.addEventListener('click', () => this.removeSelected());
        footer.append(duplicate, remove);

        host.appendChild(card.section);
    }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
    module.exports = LightingManager;
}
