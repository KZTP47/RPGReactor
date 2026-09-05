/* Waveform-driven 3D speech. PCM is reduced once per decoded chunk; each tick
 * reads an envelope sample and changes a jaw or morph weight. No vertex loops
 * or audio sample scans run in the frame loop. */
(function(root) {
    "use strict";
    const R = root.Reactor3D;
    if (!R) return;
    const active = new Map(), drivers = new WeakMap(), envelopes = new WeakMap();
    const trackedBuffers = new WeakMap();
    let serial = 0;
    const RATE = 60;

    function envelope(chunk) {
        let cached = envelopes.get(chunk);
        if (cached) return cached;
        const channels = [];
        for (let c = 0; c < chunk.numberOfChannels; c++) channels.push(chunk.getChannelData(c));
        const samples = new Float32Array(Math.max(1, Math.ceil(chunk.duration * RATE)));
        let previous = 0;
        for (let b = 0; b < samples.length; b++) {
            const start = Math.floor(b * chunk.sampleRate / RATE);
            const end = Math.min(chunk.length, Math.floor((b + 1) * chunk.sampleRate / RATE));
            let energy = 0, count = 0;
            for (const channel of channels) for (let i = start; i < end; i++) { energy += channel[i] * channel[i]; count++; }
            const rms = count ? Math.sqrt(energy / count) : 0;
            previous = rms < 0.004 ? 0 : Math.min(1, rms * 6) * 0.7 + previous * 0.3;
            samples[b] = previous;
        }
        envelopes.set(chunk, samples);
        return samples;
    }

    function levelAt(buffer, seconds) {
        if (!(seconds >= 0)) return 0;
        for (const chunk of buffer._buffers || []) {
            if (seconds >= chunk.duration) { seconds -= chunk.duration; continue; }
            const values = envelopes.get(chunk);
            if (!values) return 0;
            const at = seconds * RATE, index = Math.floor(at);
            const a = values[index] || 0, b = values[Math.min(index + 1, values.length - 1)] || 0;
            return a + (b - a) * (at - index);
        }
        return 0;
    }

    function prepare(object) {
        if (!object || typeof THREE === "undefined") return null;
        if (drivers.has(object)) return drivers.get(object);
        const morphs = [], owned = [];
        let jaw = null;
        object.traverse(node => {
            const dictionary = node.morphTargetDictionary;
            const name = dictionary && Object.keys(dictionary).find(key => /^(jaw[_ -]?open|mouth[_ -]?open|viseme[_ -]?(aa|a))$/i.test(key));
            if (name && node.morphTargetInfluences) morphs.push({ mesh: node, index: dictionary[name], base: 0 });
            const bones = node.skeleton && node.skeleton.bones;
            if (!jaw && bones) jaw = bones.find(bone => /^(.*[:_])?(jaw|lowerjaw)$/i.test(bone.name)) || null;
        });
        // A rig's authored jaw/open-mouth shape wins. Otherwise use a small,
        // smooth lip morph around the designated mouth and lip points.
        const rest = object.__reactorLandmarkRest;
        if (!morphs.length && !jaw && rest && rest.points.mouth) {
            const center = rest.points.mouth;
            const height = Math.max(0.0001, object.userData.glbSize?.y || 1);
            const up = rest.points.upperLip && rest.points.lowerLip
                ? rest.points.upperLip.clone().sub(rest.points.lowerLip).normalize() : new THREE.Vector3(0, 1, 0);
            if (!up.lengthSq()) up.set(0, 1, 0);
            for (const entry of rest.meshes) {
                const mesh = entry.mesh, original = mesh.geometry, position = original.getAttribute("position");
                if (!position) continue;
                const values = new Float32Array(position.count * 3);
                const local = new THREE.Vector3(), model = new THREE.Vector3(), delta = new THREE.Vector3();
                const inverse = new THREE.Matrix3().setFromMatrix4(entry.matrix.clone().invert());
                const indices = original.getAttribute("skinIndex"), weights = original.getAttribute("skinWeight");
                const skin = entry.skin && indices && weights ? entry.skin : null;
                const blended = new THREE.Matrix4(), vertexToModel = new THREE.Matrix4(), directionInverse = new THREE.Matrix3();
                let affected = 0;
                for (let i = 0; i < position.count; i++) {
                    local.fromBufferAttribute(position, i);
                    if (skin) {
                        blended.elements.fill(0);
                        for (let j = 0; j < 4; j++) {
                            const weight = weights.getComponent(i, j);
                            const matrix = skin.matrices[indices.getComponent(i, j)];
                            if (matrix && weight) for (let k = 0; k < 16; k++) blended.elements[k] += matrix.elements[k] * weight;
                        }
                        vertexToModel.copy(entry.matrix).multiply(skin.inverse).multiply(blended).multiply(skin.bind);
                    } else vertexToModel.copy(entry.matrix);
                    model.copy(local).applyMatrix4(vertexToModel).sub(center);
                    const distance = Math.pow(model.x / (height * 0.06), 2)
                        + Math.pow(model.y / (height * 0.045), 2) + Math.pow(model.z / (height * 0.065), 2);
                    const weight = Math.pow(Math.max(0, 1 - distance), 2);
                    const side = model.dot(up) >= 0 ? 0.25 : -1;
                    delta.copy(up).multiplyScalar(height * 0.035 * side * weight);
                    if (skin && weight) delta.applyMatrix3(directionInverse.setFromMatrix4(vertexToModel.invert()));
                    else delta.applyMatrix3(inverse);
                    if (weight > 0.001) affected++;
                    if (!original.morphTargetsRelative) delta.add(local);
                    delta.toArray(values, i * 3);
                }
                if (!affected) continue;
                const geometry = original.clone();
                geometry.morphAttributes.position = (geometry.morphAttributes.position || []).slice();
                const index = geometry.morphAttributes.position.length;
                geometry.morphAttributes.position.push(new THREE.BufferAttribute(values, 3));
                for (const kind of Object.keys(geometry.morphAttributes)) {
                    if (kind === "position" || !geometry.morphAttributes[kind].length) continue;
                    const base = original.getAttribute(kind);
                    if (base) geometry.morphAttributes[kind].push(original.morphTargetsRelative
                        ? new THREE.BufferAttribute(new Float32Array(base.count * base.itemSize), base.itemSize) : base.clone());
                }
                const oldWeights = mesh.morphTargetInfluences, oldNames = mesh.morphTargetDictionary;
                mesh.geometry = geometry; mesh.updateMorphTargets();
                if (oldWeights) oldWeights.forEach((value, i) => { mesh.morphTargetInfluences[i] = value; });
                owned.push({ mesh, original, geometry, oldWeights, oldNames });
                morphs.push({ mesh, index, base: 0 });
            }
        }
        const rotation = jaw ? new THREE.Quaternion() : null;
        let applied = false;
        const driver = {
            kind: morphs.length ? (owned.length ? "lipMorph" : "morph") : jaw ? "jaw" : "none",
            restore() {
                if (!applied) return;
                if (morphs.length) for (const entry of morphs) entry.mesh.morphTargetInfluences[entry.index] = entry.base;
                else if (jaw) jaw.quaternion.copy(rotation);
                applied = false;
            },
            apply(value) {
                this.restore();
                if (morphs.length) for (const entry of morphs) {
                    entry.base = entry.mesh.morphTargetInfluences[entry.index] || 0;
                    entry.mesh.morphTargetInfluences[entry.index] = Math.min(1, entry.base + value);
                } else if (jaw) { rotation.copy(jaw.quaternion); jaw.rotation.x += value * 0.28; }
                applied = true;
            },
            dispose() {
                this.restore();
                for (const entry of owned) {
                    entry.mesh.geometry = entry.original;
                    entry.mesh.morphTargetInfluences = entry.oldWeights;
                    entry.mesh.morphTargetDictionary = entry.oldNames;
                    entry.geometry.dispose();
                }
                drivers.delete(object);
            }
        };
        drivers.set(object, driver);
        return driver;
    }

    function stop(character) {
        const state = active.get(character);
        if (!state) return;
        active.delete(character);
        trackedBuffers.set(state.buffer, Math.max(0, (trackedBuffers.get(state.buffer) || 1) - 1));
        state.driver?.restore();
        if (state.owned) { state.buffer.stop(); state.buffer.destroy(); }
    }

    /** Attach a voice system's existing WebAudio buffer without taking ownership. */
    function attach(character, buffer, owned = false) {
        stop(character);
        if (!character || !buffer) return 0;
        const state = { token: ++serial, buffer, owned, object: null, driver: null };
        active.set(character, state);
        trackedBuffers.set(buffer, (trackedBuffers.get(buffer) || 0) + 1);
        // Loading already-ready clips must also populate the cache immediately.
        const cache = () => { for (const chunk of buffer._buffers || []) envelope(chunk); };
        cache(); buffer.addLoadListener?.(cache);
        buffer.addStopListener?.(() => { if (active.get(character) === state) stop(character); });
        return state.token;
    }

    function play(character, audio) {
        if (!character || !audio?.name || typeof AudioManager === "undefined") { stop(character); return 0; }
        const buffer = AudioManager.createBuffer("se/", audio.name);
        AudioManager.updateSeParameters(buffer, { volume: 90, pitch: 100, pan: 0, ...audio });
        const token = attach(character, buffer, true);
        const holder = R.modelHolderFor(character);
        if (holder?.object) prepare(holder.object);
        buffer.play(false);
        return token;
    }

    function tick(scene) {
        for (const [character, state] of active) {
            const buffer = state.buffer;
            if (buffer.isError?.() || !buffer.isPlaying()) { stop(character); continue; }
            const holder = scene._modelInstances?.get(R.modelInstanceKey(character));
            if (!holder?.object) { state.driver?.restore(); continue; }
            if (state.object !== holder.object) {
                state.driver?.restore(); state.object = holder.object; state.driver = prepare(holder.object);
            }
            // AudioContext time includes suspension and playback pitch; display
            // FPS and the text window's typewriter speed cannot desynchronize it.
            const seconds = typeof WebAudio !== "undefined" && Number.isFinite(buffer._startTime)
                ? (WebAudio._currentTime() - buffer._startTime) * buffer._pitch : buffer.seek();
            state.driver?.apply(levelAt(buffer, seconds));
        }
    }

    function target(interpreter, value) {
        const id = Number(value) || 0;
        return id < -1 && typeof $gamePlayer !== "undefined"
            ? $gamePlayer.followers().follower(-id - 2) : interpreter.character(id);
    }

    function startCommand(interpreter, args) {
        const character = target(interpreter, args.target);
        if (args.operation === "stop") { stop(character); return; }
        const token = play(character, { name: String(args.audio || ""), volume: Number(args.volume ?? 90),
            pitch: Number(args.pitch ?? 100), pan: Number(args.pan || 0) });
        const text = String(args.text || "");
        if (text && typeof $gameMessage !== "undefined") {
            $gameMessage.setFaceImage("", 0); $gameMessage.setBackground(0); $gameMessage.setPositionType(2);
            $gameMessage.setSpeakerName(String(args.speaker || ""));
            for (const line of text.split("\n")) $gameMessage.add(line);
        }
        interpreter._reactorSpeechWait = { target: args.target, token,
            audio: String(args.wait) !== "false", text: !!text };
        if (text || String(args.wait) !== "false") interpreter.setWaitMode("reactorSpeech3D");
    }

    function install() {
        if (typeof WebAudio !== "undefined" && WebAudio.prototype._onDecode
            && !WebAudio.prototype._onDecode.__reactorSpeech3D) {
            const decode = WebAudio.prototype._onDecode;
            WebAudio.prototype._onDecode = function(chunk) {
                if (trackedBuffers.get(this)) envelope(chunk);
                return decode.apply(this, arguments);
            };
            WebAudio.prototype._onDecode.__reactorSpeech3D = true;
        }
        if (typeof Game_Interpreter !== "undefined" && !Game_Interpreter.prototype.updateWaitMode.__reactorSpeech3D) {
            const previous = Game_Interpreter.prototype.updateWaitMode;
            Game_Interpreter.prototype.updateWaitMode = function() {
                if (this._waitMode !== "reactorSpeech3D") return previous.apply(this, arguments);
                if (this._reactorSpeechPending) {
                    if ($gameMessage.isBusy()) return true;
                    const args = this._reactorSpeechPending; this._reactorSpeechPending = null;
                    startCommand(this, args);
                }
                const wait = this._reactorSpeechWait;
                const character = wait && target(this, wait.target);
                let state = character && active.get(character);
                if (state && (state.buffer.isError?.() || !state.buffer.isPlaying())) { stop(character); state = null; }
                if (wait && ((wait.text && $gameMessage.isBusy()) || (wait.audio && state?.token === wait.token))) return true;
                this._reactorSpeechWait = null; this._waitMode = ""; return false;
            };
            Game_Interpreter.prototype.updateWaitMode.__reactorSpeech3D = true;
        }
        if (typeof PluginManager !== "undefined") PluginManager.registerCommand("RPGReactor", "SpeakModel3D", function(args) {
            if (args.operation !== "stop" && args.text && $gameMessage.isBusy()) {
                this._reactorSpeechPending = { ...args }; this.setWaitMode("reactorSpeech3D");
            } else startCommand(this, args);
        });
    }

    const sync = R.MapScene.prototype.syncCharacterModels;
    R.MapScene.prototype.syncCharacterModels = function() {
        for (const state of active.values()) state.driver?.restore();
        const result = sync.apply(this, arguments); tick(this); return result;
    };
    const clear = R.MapScene.prototype.clear;
    R.MapScene.prototype.clear = function() {
        for (const character of Array.from(active.keys())) stop(character);
        for (const holder of this._modelInstances?.values() || []) drivers.get(holder.object)?.dispose();
        return clear.apply(this, arguments);
    };
    if (typeof Scene_Map !== "undefined") {
        const update = Scene_Map.prototype.update;
        Scene_Map.prototype.update = function() {
            for (const [character, state] of active) {
                if (state.buffer.isError?.() || !state.buffer.isPlaying()) stop(character);
            }
            return update.apply(this, arguments);
        };
        const terminate = Scene_Map.prototype.terminate;
        Scene_Map.prototype.terminate = function() {
            for (const character of Array.from(active.keys())) stop(character);
            return terminate.apply(this, arguments);
        };
    }
    R.Speech = { RATE, envelope, levelAt, prepare, attach, play, stop, tick, active, install };
    install();
    if (typeof module !== "undefined" && module.exports) module.exports = R.Speech;
})(typeof globalThis !== "undefined" ? globalThis : this);
