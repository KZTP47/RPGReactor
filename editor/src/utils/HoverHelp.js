/**
 * HoverHelp - a themed hover explanation for anything carrying `data-rr-help`.
 *
 * Why not `title`
 * ---------------
 * The OS tooltip is unstyled, cannot be themed, cannot hold a second dimmer
 * line, and cannot be screenshotted - it is drawn outside the page, so no test
 * and no CDP capture can ever see it. This draws in the page instead, from the
 * same theme variables as everything else, and can therefore be verified.
 *
 * How it behaves
 * --------------
 * Rest on an element for DELAY_MS and a box appears near the pointer; move off
 * and it goes. Anything that means the pointer has moved on - pressing a
 * button, scrolling, typing, the element leaving the DOM - hides it at once, so
 * it can never be left stranded over the UI.
 *
 * A help string may carry a second line after a newline. That line is drawn
 * dimmer, which is where the "Changed by plugins:" note goes.
 *
 * Delegated from `document`, so rows rendered later - every database dialog
 * rebuilds its contents - are covered without re-attaching anything.
 */
(function(root) {
    'use strict';

    if (typeof document === 'undefined') return;
    if (root.__rrHoverHelpInstalled) return;
    root.__rrHoverHelpInstalled = true;

    const ATTRIBUTE = 'data-rr-help';
    const DELAY_MS = 550;
    const GAP = 14;
    const MARGIN = 8;

    let box = null;
    let timer = null;
    let target = null;
    let pointer = { x: 0, y: 0 };

    function ensureBox() {
        if (box && box.isConnected) return box;
        box = document.createElement('div');
        box.className = 'rr-hover-help';
        box.setAttribute('role', 'tooltip');
        box.hidden = true;
        document.body.appendChild(box);
        return box;
    }

    function hide() {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        target = null;
        if (box) box.hidden = true;
    }

    /** Place the box near the pointer, kept whole inside the viewport. */
    function position(el) {
        const width = el.offsetWidth;
        const height = el.offsetHeight;
        let x = pointer.x + GAP;
        let y = pointer.y + GAP;
        if (x + width > window.innerWidth - MARGIN) x = Math.max(MARGIN, pointer.x - GAP - width);
        if (y + height > window.innerHeight - MARGIN) y = Math.max(MARGIN, pointer.y - GAP - height);
        el.style.left = `${Math.round(x)}px`;
        el.style.top = `${Math.round(y)}px`;
    }

    function show(text) {
        const el = ensureBox();
        el.textContent = '';
        const [first, ...rest] = String(text).split('\n');
        const main = document.createElement('div');
        main.className = 'rr-hover-help-text';
        main.textContent = first;
        el.appendChild(main);
        for (const line of rest) {
            if (!line) continue;
            const note = document.createElement('div');
            note.className = 'rr-hover-help-note';
            note.textContent = line;
            el.appendChild(note);
        }
        // Measured only once it is laid out, so it is shown before being placed.
        el.hidden = false;
        el.style.left = '-9999px';
        el.style.top = '-9999px';
        position(el);
    }

    document.addEventListener('mouseover', event => {
        const found = event.target && event.target.closest
            ? event.target.closest(`[${ATTRIBUTE}]`)
            : null;
        if (found === target) return;
        hide();
        if (!found) return;
        const text = found.getAttribute(ATTRIBUTE);
        if (!text) return;
        target = found;
        timer = setTimeout(() => {
            timer = null;
            // The row can be re-rendered, or the pointer can leave, during the wait.
            if (target !== found || !found.isConnected) return hide();
            show(text);
        }, DELAY_MS);
    }, true);

    document.addEventListener('mousemove', event => {
        pointer = { x: event.clientX, y: event.clientY };
        if (target && !target.isConnected) hide();
    }, true);

    document.addEventListener('mouseout', event => {
        if (!target) return;
        // Only the pointer leaving THIS element counts. The listener is on
        // document, so it also hears every unrelated mouseout in the editor -
        // acting on those hides help the pointer is still resting on.
        if (!target.contains(event.target)) return;
        const to = event.relatedTarget;
        if (to && target.contains(to)) return;
        hide();
    }, true);

    for (const name of ['mousedown', 'wheel', 'keydown', 'scroll']) {
        document.addEventListener(name, hide, true);
    }
    root.addEventListener('blur', hide);

    root.RRHoverHelp = { hide, ATTRIBUTE, DELAY_MS };
})(typeof window !== 'undefined' ? window : globalThis);
