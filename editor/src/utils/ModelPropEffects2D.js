/** Media attached to a flat model. Video planes share its depth buffer;
 * database animations use the existing editor playback layer at the projected anchor. */
class ModelPropEffects2D {
    constructor(preview, entry, effects) {
        this.preview = preview;
        this.entry = entry;
        this.plays = [];
        const project = preview.manager.project();
        const records = window.reactor?.databaseManager?.data?.animations || [];
        for (const effect of effects) {
            if (effect.type === 'light') continue;
            if (effect.type === 'video' && effect.video?.file) {
                const plane = MapEditor3D.prototype._videoEffectPlane(effect, project, entry.object.userData.glbSize);
                if (!plane) continue;
                plane.userData.__reactorOverlay = true;
                entry.object.add(plane);
                plane.geometry.computeBoundingBox();
                entry.bounds.push({ mesh: plane, box: plane.geometry.boundingBox });
                const play = { effect, plane, video: plane.userData.video, dirty: true };
                this.plays.push(play);
            } else if (records[effect.animation] && typeof RRAnimationPreviewLayer !== 'undefined') {
                const parent = preview.app.canvas.parentElement;
                const layer = new RRAnimationPreviewLayer(parent);
                // The map canvas clips at the viewport edges, as do its effects.
                const clip = document.createElement('div');
                clip.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:4;';
                parent.appendChild(clip); clip.appendChild(layer.wrap);
                this.plays.push({ effect, layer, clip, record: records[effect.animation], project: project.path });
            }
        }
    }

    suspend() {
        for (const play of this.plays) {
            play.video?.pause();
            if (play.layer?.active) play.layer.stop();
            if (play.clip) play.clip.style.display = 'none';
            play.visible = false;
        }
    }

    update(visible) {
        const entry = this.entry, preview = this.preview;
        const point = this.point || (this.point = new THREE.Vector3());
        let dirty = false;
        for (const play of this.plays) {
            const effect = play.effect;
            if (play.plane) {
                const world = Reactor3D.effectAnchorWorld(entry.object, effect, point);
                play.plane.position.copy(entry.object.worldToLocal(world.clone()));
                const rotate = effect.rotate || [0, 0, 0];
                play.plane.rotation.set(...rotate.map(value => value * Math.PI / 180), 'YXZ');
                const pose = Reactor3D.effectAnchorQuaternion(entry.object, effect, new THREE.Quaternion());
                const root = entry.object.getWorldQuaternion(new THREE.Quaternion());
                play.plane.quaternion.premultiply(root.clone().invert().multiply(pose).multiply(root));
                const video = play.video;
                if (video) {
                    if (visible && !play.visible && !video.ended) video.play().catch(() => {});
                    if (!visible && !video.paused) video.pause();
                    const frame = video.getVideoPlaybackQuality?.().totalVideoFrames ?? Math.floor(video.currentTime * 30);
                    if (visible && video.readyState >= 2 && frame !== play.frame) {
                        play.frame = frame; dirty = true;
                    }
                }
            } else if (play.layer) {
                if (!visible) {
                    if (play.layer.active) play.layer.stop();
                    play.clip.style.display = 'none';
                } else {
                    if (!play.visible) play.layer.play(play.record, play.project, {
                        loop: effect.loop !== false, transform: { rotate: effect.rotate, scale: effect.scale }
                    });
                    play.clip.style.display = '';
                    Reactor3D.effectAnchorWorld(entry.object, effect, point).project(entry.camera);
                    const at = preview.manager.container.toGlobal(new PIXI.Point(
                        entry.sprite.x + point.x * entry.radius * entry.tw,
                        entry.sprite.y - point.y * entry.radius * entry.tw));
                    const canvas = preview.app.canvas.getBoundingClientRect();
                    const parent = play.clip.getBoundingClientRect();
                    const scale = canvas.width / preview.app.screen.width;
                    play.layer.setSpan(Reactor3D.modelSpanTiles(entry.object));
                    play.layer.moveTo(at.x * scale + canvas.left - parent.left,
                        at.y * scale + canvas.top - parent.top,
                        entry.tw * 8 * Math.abs(preview.manager.container.worldTransform.a) * scale);
                    play.clip.style.display = '';
                }
            }
            play.visible = visible;
        }
        return dirty;
    }

    dispose() {
        for (const play of this.plays) {
            play.layer?.dispose(); play.clip?.remove();
            if (play.plane) {
                play.plane.removeFromParent();
                play.video?.pause();
                if (play.video) { play.video.removeAttribute('src'); play.video.load(); }
                play.plane.geometry.dispose(); play.plane.material.dispose();
                play.plane.userData.texture.dispose();
            }
        }
        this.plays = [];
    }
}
if (typeof module !== 'undefined' && module.exports) module.exports = ModelPropEffects2D;
