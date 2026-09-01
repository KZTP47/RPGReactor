/**
 * EffekseerStateGuard - restore Effekseer's GL state only when it can have
 * been lost.
 *
 * `setRestorationOfStatesFlag(true)` makes Effekseer read the context's
 * state back before every draw (blend, depth, cull, program, bindings) so it
 * can put it back afterwards. Each of those reads is a `gl.getParameter`,
 * and the first one in a frame is a synchronous round trip to the GPU
 * process: the CPU stops until every command queued so far — the whole
 * three.js frame on the map view's other context — has been consumed.
 * Measured on the Demo's Reactor Room, one `DEPTH_WRITEMASK` read cost
 * 15 ms a frame, two thirds of the editor's frame time, for a preview that
 * owns its context outright and shares it with nothing.
 *
 * The flag was on for one reason: the browser can reset GL state behind a
 * context on window blur/focus, and Effekseer, trusting its cache, then
 * drew with stale depth/cull state. So the flag is kept *pending*: on at
 * attach, and again after any event that can reset state, until the next
 * draw has run with it — that draw re-asserts everything — and off from
 * then on. A context that other code also draws into (the Animations page's
 * scene blit) keeps the flag on itself and does not use this guard.
 */
(function(root) {
    'use strict';

    const entries = new Set();
    let listening = false;

    function rearm(entry) {
        entry.pending = true;
        try { entry.ctx.setRestorationOfStatesFlag(true); } catch (_) {}
    }

    function rearmAll() {
        for (const entry of entries) rearm(entry);
    }

    function listen() {
        if (listening || typeof window === 'undefined' || typeof document === 'undefined') return;
        listening = true;
        window.addEventListener('focus', rearmAll);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) rearmAll(); });
    }

    const EffekseerStateGuard = {
        /** Start guarding `ctx`; `canvas` (optional) re-arms on context restore. */
        attach(ctx, canvas) {
            if (!ctx || typeof ctx.setRestorationOfStatesFlag !== 'function') return null;
            let entry = ctx.__rrStateGuard;
            if (!entry) {
                entry = { ctx, pending: true };
                ctx.__rrStateGuard = entry;
                entries.add(entry);
                if (canvas && typeof canvas.addEventListener === 'function') {
                    canvas.addEventListener('webglcontextrestored', () => rearm(entry));
                }
            }
            rearm(entry);
            listen();
            return entry;
        },
        /** Call after `endDraw()`: the restoring draw has happened, stop paying for it. */
        settle(ctx) {
            const entry = ctx && ctx.__rrStateGuard;
            if (!entry || !entry.pending) return;
            entry.pending = false;
            try { ctx.setRestorationOfStatesFlag(false); } catch (_) {}
        },
        /** Ask for one more restoring draw (something else touched the context). */
        rearm(ctx) {
            const entry = ctx && ctx.__rrStateGuard;
            if (entry) rearm(entry);
        },
        /** Forget a context that is being released. */
        release(ctx) {
            const entry = ctx && ctx.__rrStateGuard;
            if (!entry) return;
            entries.delete(entry);
            delete ctx.__rrStateGuard;
        },
        _entries: entries
    };

    root.RREffekseerStateGuard = EffekseerStateGuard;
    if (typeof module !== 'undefined' && module.exports) module.exports = EffekseerStateGuard;
})(typeof globalThis !== 'undefined' ? globalThis : window);
