/**
 * RRColourPopover - a colour picker drawn by the editor, in the editor's theme.
 *
 * `<input type="color">` opens Chromium's own dialog: it ignores the palette,
 * and when the app fills the window it lands wherever the OS puts it, often
 * half off screen. This popover is a saturation/value square, a hue bar, a
 * hex field and recent swatches, anchored to the swatch that opened it and
 * kept inside the viewport. One popover is open at a time; a click anywhere
 * else or Escape closes it.
 *
 *   RRColourPopover.open({ anchor, value, onInput, onChange })
 *   RRColourPopover.swatch(value, onInput, onChange) -> a button that opens it
 *
 * `onInput` fires on every change while the picker is open; `onChange` fires
 * once when it closes, with the final colour, if the colour changed.
 */
(function(root) {
    'use strict';

    const RECENT_MAX = 8;
    const SV_WIDTH = 188;
    const SV_HEIGHT = 124;
    const recent = [];
    let current = null;

    const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
    const hex2 = n => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');

    function normalizeHex(value) {
        const hex = String(value || '').replace('#', '').trim();
        if (/^[0-9a-f]{6}$/i.test(hex)) return '#' + hex.toLowerCase();
        if (/^[0-9a-f]{3}$/i.test(hex)) return '#' + hex.split('').map(c => c + c).join('').toLowerCase();
        return null;
    }

    function hexToHsv(value) {
        const hex = normalizeHex(value) || '#ffffff';
        const r = parseInt(hex.slice(1, 3), 16) / 255;
        const g = parseInt(hex.slice(3, 5), 16) / 255;
        const b = parseInt(hex.slice(5, 7), 16) / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const d = max - min;
        let h = 0;
        if (d > 0) {
            if (max === r) h = ((g - b) / d) % 6;
            else if (max === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h *= 60;
            if (h < 0) h += 360;
        }
        return { h, s: max > 0 ? d / max : 0, v: max };
    }

    function hsvToHex(h, s, v) {
        const c = v * s;
        const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
        const m = v - c;
        let r = 0, g = 0, b = 0;
        if (h < 60) [r, g, b] = [c, x, 0];
        else if (h < 120) [r, g, b] = [x, c, 0];
        else if (h < 180) [r, g, b] = [0, c, x];
        else if (h < 240) [r, g, b] = [0, x, c];
        else if (h < 300) [r, g, b] = [x, 0, c];
        else [r, g, b] = [c, 0, x];
        return '#' + hex2((r + m) * 255) + hex2((g + m) * 255) + hex2((b + m) * 255);
    }

    function remember(hex) {
        const at = recent.indexOf(hex);
        if (at >= 0) recent.splice(at, 1);
        recent.unshift(hex);
        if (recent.length > RECENT_MAX) recent.length = RECENT_MAX;
    }

    function close(commit = true) {
        const popover = current;
        if (!popover) return;
        current = null;
        document.removeEventListener('pointerdown', popover.onOutside, true);
        document.removeEventListener('keydown', popover.onKey, true);
        window.removeEventListener('resize', popover.onReposition);
        window.removeEventListener('scroll', popover.onReposition, true);
        if (popover.el.parentNode) popover.el.parentNode.removeChild(popover.el);
        if (commit && popover.value !== popover.start) {
            remember(popover.value);
            if (typeof popover.onChange === 'function') popover.onChange(popover.value);
        } else if (!commit && popover.value !== popover.start && typeof popover.onInput === 'function') {
            // Escape puts the colour back before the popover goes.
            popover.onInput(popover.start);
        }
    }

    /** Keep the popover inside the viewport, preferring below the anchor. */
    function place(popover) {
        const el = popover.el;
        const rect = popover.anchor && popover.anchor.getBoundingClientRect
            ? popover.anchor.getBoundingClientRect() : { left: 12, right: 12, top: 12, bottom: 12 };
        const width = el.offsetWidth || 220;
        const height = el.offsetHeight || 260;
        const margin = 8;
        let left = rect.left;
        let top = rect.bottom + 6;
        if (top + height > window.innerHeight - margin) top = rect.top - height - 6;
        if (top < margin) top = clamp(window.innerHeight - height - margin, margin, window.innerHeight);
        if (left + width > window.innerWidth - margin) left = rect.right - width;
        if (left < margin) left = margin;
        el.style.left = Math.round(left) + 'px';
        el.style.top = Math.round(top) + 'px';
    }

    function open(options) {
        close();
        const settings = options || {};
        const start = normalizeHex(settings.value) || '#ffffff';
        const hsv = hexToHsv(start);
        const el = document.createElement('div');
        el.className = 'rr-colour-popover';
        el.setAttribute('role', 'dialog');
        el.innerHTML = ''
            + '<canvas class="rr-colour-popover-sv" width="' + SV_WIDTH + '" height="' + SV_HEIGHT + '"></canvas>'
            + '<input type="range" class="rr-colour-popover-hue" min="0" max="360" step="1">'
            + '<div class="rr-colour-popover-row">'
            + '  <span class="rr-colour-popover-preview"></span>'
            + '  <input type="text" class="rr-colour-popover-hex" maxlength="7" spellcheck="false">'
            + '</div>'
            + '<div class="rr-colour-popover-swatches"></div>';
        document.body.appendChild(el);

        const sv = el.querySelector('.rr-colour-popover-sv');
        const hue = el.querySelector('.rr-colour-popover-hue');
        const preview = el.querySelector('.rr-colour-popover-preview');
        const hexField = el.querySelector('.rr-colour-popover-hex');
        const swatches = el.querySelector('.rr-colour-popover-swatches');
        const context = sv.getContext('2d');

        const popover = {
            el, anchor: settings.anchor || null, start, value: start,
            onInput: settings.onInput, onChange: settings.onChange, hsv
        };

        const drawSv = () => {
            context.fillStyle = hsvToHex(popover.hsv.h, 1, 1);
            context.fillRect(0, 0, SV_WIDTH, SV_HEIGHT);
            const white = context.createLinearGradient(0, 0, SV_WIDTH, 0);
            white.addColorStop(0, 'rgba(255,255,255,1)');
            white.addColorStop(1, 'rgba(255,255,255,0)');
            context.fillStyle = white;
            context.fillRect(0, 0, SV_WIDTH, SV_HEIGHT);
            const black = context.createLinearGradient(0, 0, 0, SV_HEIGHT);
            black.addColorStop(0, 'rgba(0,0,0,0)');
            black.addColorStop(1, 'rgba(0,0,0,1)');
            context.fillStyle = black;
            context.fillRect(0, 0, SV_WIDTH, SV_HEIGHT);
            const x = popover.hsv.s * SV_WIDTH;
            const y = (1 - popover.hsv.v) * SV_HEIGHT;
            context.beginPath();
            context.arc(x, y, 5, 0, Math.PI * 2);
            context.strokeStyle = popover.hsv.v > 0.55 && popover.hsv.s < 0.6 ? '#000' : '#fff';
            context.lineWidth = 2;
            context.stroke();
        };
        const apply = (fromField) => {
            popover.value = hsvToHex(popover.hsv.h, popover.hsv.s, popover.hsv.v);
            preview.style.background = popover.value;
            if (!fromField) hexField.value = popover.value;
            hue.value = String(Math.round(popover.hsv.h));
            hue.style.setProperty('--rr-hue-thumb', hsvToHex(popover.hsv.h, 1, 1));
            drawSv();
            if (typeof popover.onInput === 'function') popover.onInput(popover.value);
        };
        const setFromHex = hex => {
            const normalized = normalizeHex(hex);
            if (!normalized) return false;
            popover.hsv = hexToHsv(normalized);
            apply(true);
            hexField.value = normalized;
            return true;
        };

        const svPoint = event => {
            const rect = sv.getBoundingClientRect();
            popover.hsv.s = clamp((event.clientX - rect.left) / rect.width, 0, 1);
            popover.hsv.v = 1 - clamp((event.clientY - rect.top) / rect.height, 0, 1);
            apply(false);
        };
        sv.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            event.preventDefault();
            sv.setPointerCapture?.(event.pointerId);
            svPoint(event);
            const move = e => svPoint(e);
            const up = () => {
                sv.removeEventListener('pointermove', move);
                sv.removeEventListener('pointerup', up);
                sv.removeEventListener('pointercancel', up);
            };
            sv.addEventListener('pointermove', move);
            sv.addEventListener('pointerup', up);
            sv.addEventListener('pointercancel', up);
        });
        hue.addEventListener('input', () => {
            popover.hsv.h = Number(hue.value) || 0;
            apply(false);
        });
        hexField.addEventListener('input', () => {
            if (setFromHex(hexField.value)) hexField.classList.remove('rr-colour-popover-bad');
            else hexField.classList.add('rr-colour-popover-bad');
        });
        hexField.addEventListener('keydown', event => {
            if (event.key === 'Enter') { event.preventDefault(); close(true); }
            event.stopPropagation();
        });

        const presets = ['#ffffff', '#ffd9a0', '#ffb45e', '#ff2d95', '#ff1720', '#7f9bff', '#9db4ff', '#3ddc84'];
        const shown = recent.concat(presets.filter(hex => recent.indexOf(hex) < 0)).slice(0, RECENT_MAX + 4);
        for (const hex of shown) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'rr-colour-popover-swatch';
            chip.style.background = hex;
            chip.title = hex;
            chip.addEventListener('click', () => setFromHex(hex));
            swatches.appendChild(chip);
        }

        popover.onOutside = event => {
            if (el.contains(event.target)) return;
            if (popover.anchor && popover.anchor.contains && popover.anchor.contains(event.target)) return;
            close(true);
        };
        popover.onKey = event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(false); }
        };
        popover.onReposition = () => place(popover);
        document.addEventListener('pointerdown', popover.onOutside, true);
        document.addEventListener('keydown', popover.onKey, true);
        window.addEventListener('resize', popover.onReposition);
        window.addEventListener('scroll', popover.onReposition, true);

        current = popover;
        hexField.value = start;
        preview.style.background = start;
        apply(true);
        // The first apply reported the unchanged colour; that is fine.
        place(popover);
        hexField.focus();
        hexField.select();
        return popover;
    }

    /**
     * A swatch button that opens the popover: a coloured face with the hex
     * beside it, so a value can be read without opening anything.
     */
    function swatch(value, onInput, onChange) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'rr-colour-swatch';
        const face = document.createElement('span');
        face.className = 'rr-colour-swatch-face';
        const label = document.createElement('span');
        label.className = 'rr-colour-swatch-label';
        button.append(face, label);
        const set = hex => {
            const normalized = normalizeHex(hex) || '#ffffff';
            button.dataset.value = normalized;
            face.style.background = normalized;
            label.textContent = normalized;
        };
        set(value);
        button.addEventListener('click', event => {
            event.preventDefault();
            if (current && current.anchor === button) { close(true); return; }
            open({
                anchor: button,
                value: button.dataset.value,
                onInput: hex => { set(hex); if (typeof onInput === 'function') onInput(hex); },
                onChange: hex => { set(hex); if (typeof onChange === 'function') onChange(hex); }
            });
        });
        button.setValue = set;
        return button;
    }

    const api = { open, close, swatch, hexToHsv, hsvToHex, normalizeHex, recent };
    root.RRColourPopover = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
