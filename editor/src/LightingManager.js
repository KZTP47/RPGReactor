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
        document.addEventListener('keydown', this._onKeyDown);
        this.render();
        this._startTicking();
        this._sync3D();
    }

    _deactivate() {
        this.placing = null;
        this.drag = null;
        this._stopTicking();
        this._unbindPointer();
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

    armPlacement(type) {
        this.placing = type === 'spot' ? 'spot' : 'point';
        this._syncAddButtons();
    }

    place(type, x, y) {
        const map = this.map();
        if (!map || typeof RRMapLights === 'undefined') return null;
        this.pushUndo();
        const light = RRMapLights.add(map, {
            type,
            x: Math.round(x * 100) / 100,
            y: Math.round(y * 100) / 100,
            color: type === 'spot' ? '#fff2cc' : '#ffcf7d'
        });
        this.selectedId = light ? light.id : null;
        this._changed();
        return light;
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
        for (const raw of RRMapLights.list(map)) {
            const light = RRMapLights.normalize(raw, raw.id || 'light');
            const at = this._lightAnchor(light);
            if (!at) continue;
            const selected = light.id === this.selectedId;
            const colour = this._colourNumber(light.color);
            const x = at.x * tw, y = at.y * tw;
            g.circle(x, y, selected ? 9 : 7)
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
                    .stroke({ width: 1.5, color: 0xffffff, alpha: 0.55 });
                g.circle(aim.x * tw, aim.y * tw, 7)
                    .fill({ color: 0xffffff, alpha: 0.9 })
                    .stroke({ width: 2, color: 0x000000, alpha: 0.9 });
            } else {
                g.circle(x, y, light.radius * tw)
                    .stroke({ width: 1.5, color: 0xffffff, alpha: 0.5 });
                const reach = this._reachPoint(light, at);
                g.circle(reach.x * tw, reach.y * tw, 7)
                    .fill({ color: 0xffffff, alpha: 0.9 })
                    .stroke({ width: 2, color: 0x000000, alpha: 0.9 });
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

    _tilePoint(event, container) {
        const pos = event.data.getLocalPosition(container);
        const tw = this.tileSize();
        return { x: pos.x / tw, y: pos.y / tw };
    }

    _pointerDown(event, container) {
        if (!this.active || !this.map() || event.data.button !== 0) return;
        const at = this._tilePoint(event, container);

        if (this.placing) {
            const type = this.placing;
            if (!event.data.originalEvent?.shiftKey) this.placing = null;
            this._syncAddButtons();
            this.place(type, at.x, at.y);
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
        const grip = 12 / tw; // handle radius in tiles
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
        // Topmost light whose marker covers the press.
        const lights = RRMapLights.list(map);
        for (let i = lights.length - 1; i >= 0; i--) {
            const light = RRMapLights.normalize(lights[i], lights[i].id || 'light');
            const anchor = this._lightAnchor(light);
            if (!anchor) continue;
            if (Math.hypot(at.x - anchor.x, at.y - anchor.y) <= grip) {
                return {
                    id: light.id, mode: 'move',
                    offsetX: at.x - anchor.x, offsetY: at.y - anchor.y, anchor
                };
            }
        }
        return null;
    }

    _pointerMove(event, container) {
        if (!this.active || !this.drag) return;
        const map = this.map();
        if (!map || typeof RRMapLights === 'undefined') return;
        const at = this._tilePoint(event, container);
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
    }

    _clear3D() {
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
        header.appendChild(this._el('div', '', this._k('lit.title')))
            .style.cssText = 'font-weight:700;font-size:13px;flex:1;';
        const close = this._el('button', 'rr-btn-secondary', '×');
        close.type = 'button';
        close.style.cssText = 'width:24px;height:24px;padding:0;line-height:1;';
        close.addEventListener('click', () => this.setActive(false));
        header.appendChild(close);
        panel.appendChild(header);

        panel.appendChild(this._buildAmbientSection());
        panel.appendChild(this._buildAddRow());
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

    _buildAddRow() {
        const row = this._el('div');
        row.style.cssText = 'display:flex;gap:6px;';
        this._addButtons = {};
        for (const [type, key] of [['point', 'lit.addPoint'], ['spot', 'lit.addSpot']]) {
            const button = this._el('button', 'rr-button-primary', this._k(key));
            button.type = 'button';
            button.style.cssText = 'flex:1;padding:5px 8px;font-size:11px;';
            button.addEventListener('click', () => {
                this.armPlacement(this.placing === type ? null : type);
                if (!this.placing) this._syncAddButtons();
            });
            this._addButtons[type] = button;
            row.appendChild(button);
        }
        return row;
    }

    _syncAddButtons() {
        for (const [type, button] of Object.entries(this._addButtons || {})) {
            button.classList.toggle('active', this.placing === type);
            button.style.outline = this.placing === type ? '2px solid var(--color-accent)' : '';
        }
    }

    _syncPanel() {
        if (!this._panel) return;
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
            const empty = this._el('div', '', this._k('lit.empty'));
            empty.style.cssText = 'color:var(--color-text-muted);font-size:11px;padding:4px 2px;';
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
