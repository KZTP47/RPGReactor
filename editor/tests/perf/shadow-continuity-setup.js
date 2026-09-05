// Async WebDriver setup for nw-game-profile.cjs; observes real moving-scene
// row continuity without freezing actors, lights or the camera.
const done = arguments[arguments.length - 1];
const sh = Reactor3D.Shadows;
const original = sh._flush;
let frames = 0, swaps = 0, missing = 0, overBudget = 0, previous = null;
const examples = [], missingExamples = [];
sh._flush = function() {
    const pending = !!this._pending;
    const result = original.apply(this, arguments);
    if (!pending) return result;
    const rows = this._dynTiles.map(r => r.id);
    if (previous && rows.some((id,i) => id !== previous[i])) {
        swaps++;
        if (examples.length < 8) examples.push({frame:frames, before:previous, after:rows,
            ranks:this._tiles.map(t => ({id:t.id,rank:t.candidate?.rank}))});
    }
    for (const r of this._dynTiles) {
        const t = this._tiles[r.tile];
        if (r.valid && t?.valid && r.id === t.id && r.key !== t.key) {
            missing++;
            if (missingExamples.length < 5) missingExamples.push({frame:frames,id:r.id,staticKey:t.key,dynamicKey:r.key});
        }
    }
    const q = this.quality();
    if (this.lastFrame.statics > q.staticPerFrame || this.lastFrame.dynamics > q.dynamicPerFrame) overBudget++;
    previous = rows; frames++;
    if (frames >= 240) finish();
    return result;
};
const timer = setTimeout(finish, 16000);
function finish() {
    sh._flush = original; clearTimeout(timer);
    const glError = Graphics._app.renderer.gl.getError();
    done({frames, swaps, missing, overBudget, glError, examples, missingExamples,
        quality:sh.quality(), revision:RPG_REACTOR_RUNTIME_REVISION,
        passed:frames >= 120 && missing === 0 && overBudget === 0 && glError === 0});
}
