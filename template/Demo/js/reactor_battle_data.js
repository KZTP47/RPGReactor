/* Shared, side-effect-free battle presentation data and timeline evaluation. */
(function(root) {
    'use strict';
    const B = {};
    const copy = value => JSON.parse(JSON.stringify(value));
    const number = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
    B.VERSION = 1;
    B.configuredBattleMembers = system => {
        const n = system?.maxBattleMembers;
        return Number.isInteger(n) && n >= 1 && n <= 99 ? n : null;
    };
    B.maxBattleMembers = (system, plugins = []) => {
        const configured = B.configuredBattleMembers(system);
        if (configured !== null) return configured;
        let limit = 4;
        // Match the last enabled known party-size override, without executing plugins.
        const keys = { PSYCHRONIC_PartySystemMZ: 'maxBattleMembers', MOG_BattleHud: 'Max Battle Members', YEP_PartySystem: 'Max Battle Members' };
        for (const plugin of plugins) if (plugin?.status === true && keys[plugin.name]) {
            const n = Number(plugin.parameters?.[keys[plugin.name]]);
            if (Number.isInteger(n) && n >= 1 && n <= 99) limit = n;
        }
        return limit;
    };
    B.empty = () => ({ version: 1, troops: {}, skills: {}, items: {}, weapons: {}, actors: {}, enemies: {} });
    B.types = ['move', 'motion', 'sound', 'animation', 'projectile', 'weapon', 'impact', 'wait', 'camera'];
    B.roles = ['user', 'target', 'allTargets'];
    B.templates = ['Unarmed Punch', 'Melee Strike', 'Projectile Shot', 'Cast on Target', 'Heal', 'Self Buff'];
    B.step = (type, extra = {}) => Object.assign({ id: 'step-' + Math.random().toString(36).slice(2), type,
        duration: ['impact','sound','animation'].includes(type) ? 0 : 20, role: 'user', anchor: 'home', x: 0, y: 0, z: 0, easing: 'smooth' }, extra);
    B.basicSteps = ['Run to Target', 'Punch', 'Return Home'];
    B.basic = name => name === 'Run to Target' ? [
        B.step('motion', {motion:'run',duration:0}),
        B.step('move', {anchor:'approach',x:-1.2,duration:30,easing:'linear',face:'movement'})
    ] : name === 'Return Home' ? [
        B.step('motion', {motion:'run',duration:0}),
        B.step('move', {duration:30,easing:'linear',face:'movement'}),
        B.step('motion', {motion:'idle',duration:0}),
        B.step('move', {duration:0,face:'home'})
    ] : [B.step('motion', {motion:'punch',duration:16}),
        B.step('impact', {role:'allTargets'}), B.step('wait', {duration:20})];
    B.template = (name = 'Melee Strike', id = 1) => {
        if (name === 'Unarmed Punch') return {id,version:1,name,note:'Run into range, punch on frame 46, then return home.',steps:[...B.basic('Run to Target'),...B.basic('Punch'),...B.basic('Return Home')]};
        const steps = [];
        if (name === 'Melee Strike') steps.push(B.step('move', { anchor: 'target', x: -1.5, duration: 24 }));
        if(['Melee Strike','Projectile Shot'].includes(name))steps.push(B.step('weapon',{duration:0,x:.5,z:1,iconSource:'weapon'}));
        steps.push(B.step('motion', { motion: name === 'Melee Strike' || name === 'Projectile Shot' ? 'attack' : 'cast', duration: 18 }));
        if (name === 'Projectile Shot') steps.push(B.step('projectile', { duration: 24, color: '#ffcc55', size: 8 }));
        steps.push(B.step('animation', { role: name === 'Self Buff' ? 'user' : 'allTargets', animationId: 0, duration: 12 }));
        steps.push(B.step('impact', { role: 'allTargets' }));
        steps.push(B.step('wait', { duration: 18 }));
        if (name === 'Melee Strike') steps.push(B.step('move', { duration: 24 }));
        if(['Melee Strike','Projectile Shot'].includes(name))steps.push(B.step('weapon',{duration:0,visible:false}));
        steps.push(B.step('motion', { motion: 'idle', duration: 8 }));
        return { id, version: 1, name, note: '', steps };
    };
    B.validateSequence = sequence => {
        const errors = [];
        if (!sequence || sequence.version !== 1 || !Array.isArray(sequence.steps)) return ['Unsupported action sequence format.'];
        if (sequence.steps.length > 256) errors.push('A sequence can contain at most 256 steps.');
        let impacts = 0, duration = 0;
        const ids = new Set();
        for (const step of sequence.steps) {
            if (!step || !B.types.includes(step.type)) { errors.push('Unknown step type.'); continue; }
            if (!step.id || ids.has(step.id)) errors.push('Every step needs a unique ID.');
            ids.add(step.id);
            if (!Number.isInteger(step.duration) || step.duration < 0 || step.duration > 3600) errors.push('Step duration must be 0–3600 frames.');
            duration += step.duration || 0;
            if (step.type === 'impact') impacts++;
            if(step.type==='animation'&&(!Number.isInteger(step.animationId??0)||(step.animationId??0)<0))errors.push('Choose a valid animation.');
            if(step.waitForCompletion!==undefined&&typeof step.waitForCompletion!=='boolean')errors.push('Wait for completion must be enabled or disabled.');
            if(step.animationTransform!==undefined){const t=step.animationTransform;if(!t||typeof t!=='object'||Array.isArray(t)||Object.entries(t).some(([k,v])=>!['x','y','z','scale'].includes(k)||!Number.isFinite(v)||(k==='scale'?(v<.01||v>100):Math.abs(v)>1000)))errors.push('Choose finite animation offsets and a scale between 0.01 and 100.');}
            if(step.type==='sound'&&step.audio){const a=step.audio;if(typeof a.name!=='string'||[['volume',0,100],['pitch',50,150],['pan',-100,100]].some(([k,min,max])=>!Number.isFinite(a[k])||a[k]<min||a[k]>max))errors.push('Sound requires volume 0–100, pitch 50–150 and pan −100–100.');}
            if(step.type==='projectile'&&(!/^#[0-9a-f]{6}$/i.test(step.color||'#ffcc55')||!Number.isFinite(step.size??8)||(step.size??8)<1||(step.size??8)>512))errors.push('Choose a projectile color and size between 1 and 512.');
            if (!B.roles.includes(step.role)) errors.push('Unknown battler role.');
            if(step.targetIndex!==undefined&&(!Number.isInteger(step.targetIndex)||step.targetIndex<0||step.targetIndex>98))errors.push('Choose a valid target number.');
            if(step.transform!==undefined){
                const t=step.transform;
                if(!t||typeof t!=='object'||Array.isArray(t)||Object.entries(t).some(([key,value])=>!B.transformKeys.includes(key)||!Number.isFinite(value)||(key.startsWith('scale')?(value<.01||value>100):Math.abs(value)>(key.startsWith('rotate')?3600:1000))))errors.push('Choose finite transform values and scales between 0.01 and 100.');
            }
            if (['move','camera'].includes(step.type)) {
                if (!['home','target','approach'].includes(step.anchor)) errors.push('Unknown position anchor.');
                if (step.face !== undefined && !['home','movement','target'].includes(step.face)) errors.push('Unknown facing mode.');
                if (!['linear','smooth'].includes(step.easing)) errors.push('Unknown easing.');
                if(['rotateX','rotateY','rotateZ'].some(k=>step[k]!==undefined&&(!Number.isFinite(step[k])||Math.abs(step[k])>3600))||step.scale!==undefined&&(!Number.isFinite(step.scale)||step.scale<.01||step.scale>100))errors.push('Choose finite rotations and a scale between 0.01 and 100.');
                if (['x','y','z'].some(key => !Number.isFinite(step[key]) || Math.abs(step[key]) > 1000)) errors.push('Positions must be finite and within 1000 units.');
            }
        }
        if (impacts !== 1) errors.push('Include exactly one Apply Action Effect step; skill repeats determine the number of hits.');
        if (duration > 18000) errors.push('A sequence can last at most five minutes.');
        return [...new Set(errors)];
    };
    B.validateStore = (sequences, settings) => {
        if (!Array.isArray(sequences) || (sequences.length && sequences[0] !== null)) throw Error('ActionSequences.json must be a database array starting with null.');
        for (let i = 1; i < sequences.length; i++) {
            const s = sequences[i];
            if (s && (s.id !== i || s.version !== 1 || !Array.isArray(s.steps))) throw Error('Unsupported ActionSequences.json entry #' + i);
        }
        if (!settings || settings.version !== 1 || Array.isArray(settings)) throw Error('Unsupported BattlePresentation.json format.');
        for (const key of ['troops','skills','items','weapons','actors','enemies']) {
            if (settings[key] && (typeof settings[key] !== 'object' || Array.isArray(settings[key]))) throw Error('Invalid battle presentation section: ' + key);
        }
        return true;
    };
    B.timeline = sequence => {
        let frame = 0;
        return (sequence.steps || []).map(step => { const start = frame; frame += Math.max(0, number(step.duration)); return { step, start, end: frame }; });
    };
    B.duration = sequence => B.timeline(sequence).at(-1)?.end || 0;
    B.resolve = (settings, sequences, { kind, itemId, isAttack, weaponIds = [], battlerKind, battlerId }) => {
        const choices = [settings?.[kind]?.[itemId]];
        if (isAttack) for (const id of weaponIds) choices.push(settings?.weapons?.[id]);
        if (isAttack && !weaponIds.length && battlerKind === 'actors') choices.push(settings?.actors?.[battlerId]?.unarmed);
        choices.push(settings?.[battlerKind]?.[battlerId]);
        for (const binding of choices) {
            if (!binding || binding.mode === 'inherit') continue;
            if (binding.mode === 'existing') return null;
            if (binding.mode === 'sequence') {
                const sequence = sequences?.[binding.sequenceId];
                return sequence && !B.validateSequence(sequence).length ? sequence : null;
            }
        }
        return null;
    };
    B.references = (settings, id) => {
        const result = [];
        for (const kind of ['skills','items','weapons','actors','enemies']) for (const [recordId, value] of Object.entries(settings?.[kind] || {})) {
            if (value.mode === 'sequence' && value.sequenceId === id || kind==='actors' && value.unarmed?.mode==='sequence' && value.unarmed.sequenceId===id) result.push({ kind, id: Number(recordId) });
        }
        return result;
    };
    B.room = (map, previous = {}) => Object.assign({ type: 'room', mapId: map.id, cameraSource: 'map',
        projection: map.reactor3d?.mode === '3d' || /<3d>/i.test(map.note||'') ? '3d' : '2d',
        camera: { x: map.width / 2 - .5, y: map.height / 2 - .5, z: 0, yaw: 0, pitch: 45, distance: 24 },
        actors: [], enemies: [], eventModes: {} }, copy(previous), { type: 'room', mapId: map.id });
    B.facingToward = (from,to) => Math.atan2(to.x-from.x,to.y-from.y)*180/Math.PI;
    B.position = (room, side, index) => {
        const saved = room[side]?.[index];
        const c = room.camera;
        return Object.assign({ x: c.x + (side === 'actors' ? 4 : -4), y: c.y + (index - 1.5) * 2,
            z: 0, facing: side === 'actors' ? -90 : 90 }, saved || {});
    };
    B.transformKeys = ['x','y','z','rotateX','rotateY','rotateZ','scale','scaleX','scaleY','scaleZ'];
    B.transform = value => Object.fromEntries(B.transformKeys.map(k=>[k,value?.[k]??(k.startsWith('scale')?1:0)]));
    B.roleKey = step => step.role==='target'&&step.targetIndex!==undefined?'target'+step.targetIndex:step.role;
    // Model offsets are layered over travel; a motion without an override
    // restores this layer, leaving the battler's movement keys untouched.
    B.visualPose = pose => {
        if(!pose?.transform)return pose;
        const t=B.transform(pose.transform),p={...pose};delete p.transform;
        for(const k of ['x','y','z','rotateX','rotateY','rotateZ'])p[k]=(pose[k]||0)+t[k];
        for(const k of ['scale','scaleX','scaleY','scaleZ'])p[k]=(pose[k]??1)*t[k];
        return p;
    };
    B.evaluate = (sequence, frame, context) => {
        const homes = context.homes, target = context.target || homes.target || { x: 0, y: 0, z: 0 };
        const result = copy(homes);
        for (const { step, start, end } of B.timeline(sequence)) {
            if (start > frame) break;
            if (!['move','camera','motion'].includes(step.type)) continue;
            const role = step.type === 'camera' ? 'camera' : B.roleKey(step);
            const roles = role === 'allTargets' ? Object.keys(homes).filter(k => k.startsWith('target') && (k!=='target'||!homes.target0)) : [role];
            for (const key of roles) {
                const home = homes[key]; if (!home) continue;
                const from = result[key];
                if(step.type==='motion') {
                    if(step.transform||from.transform){
                        const a=B.transform(from.transform),b=B.transform(step.transform),t=end===start?1:Math.max(0,Math.min(1,(frame-start)/(end-start)));
                        result[key].transform=Object.fromEntries(B.transformKeys.map(k=>[k,a[k]+(b[k]-a[k])*t]));
                    }
                    if(key==='target'&&result.target0)result.target0=copy(result.target);
                    if(key==='target0'&&result.target)result.target=copy(result.target0);
                    continue;
                }
                const anchor = ['target','approach'].includes(step.anchor) ? target : home;
                let t = end === start ? 1 : Math.max(0, Math.min(1, (frame - start) / (end - start)));
                if (step.easing === 'smooth') t = t * t * (3 - 2 * t);
                const direction = context.direction || 1;
                let dx=step.x*direction,dy=step.y;
                if(step.anchor==='approach') {
                    const start=homes.user||home,vx=target.x-start.x,vy=target.y-start.y,length=Math.hypot(vx,vy);
                    const ux=length>1e-6?vx/length:direction,uy=length>1e-6?vy/length:0;
                    dx=step.x*ux-step.y*uy;dy=step.x*uy+step.y*ux;
                }
                const goal={x:anchor.x+dx,y:anchor.y+dy,z:anchor.z+step.z};
                result[key] = { ...from, x: from.x + (goal.x - from.x) * t,
                    y: from.y + (goal.y - from.y) * t, z: from.z + (goal.z - from.z) * t };
                for(const property of ['rotateX','rotateY','rotateZ','scale']){const baseline=home[property]??(property==='scale'?1:0),previous=from[property]??baseline,goal=step[property]??baseline;result[key][property]=previous+(goal-previous)*t;}
                if(from.facing!==undefined||home.facing!==undefined)result[key].facing=from.facing??home.facing;
                if(step.face==='home')result[key].facing=home.facing??B.facingToward(home,target);
                else if(step.face==='target')result[key].facing=B.facingToward(result[key],target);
                else if(step.face==='movement'&&Math.hypot(goal.x-from.x,goal.y-from.y)>1e-6)result[key].facing=B.facingToward(from,goal);
                if(key==='target'&&result.target0)result.target0={...result.target};
                if(key==='target0'&&result.target)result.target={...result.target0};
            }
        }
        return result;
    };
    B.Player = class {
        constructor(sequence, adapter) {
            const errors = B.validateSequence(sequence); if (errors.length) throw Error(errors.join(' '));
            this.sequence = copy(sequence); this.adapter = adapter; this.frame = -1; this.done = false;
            this.timeline = B.timeline(sequence); this.duration = B.duration(sequence); this.cursor = 0; this.waiting = null;
        }
        update(delta = 1) {
            if (this.done) return;
            if (this.waiting?.isPlaying()) return;
            this.waiting = null;
            const frame = Math.min(this.duration, Math.max(0, this.frame) + Math.max(0, delta));
            while (this.cursor < this.timeline.length && this.timeline[this.cursor].start <= frame) {
                const cue = this.timeline[this.cursor++];
                const media = this.adapter.cue?.(cue.step, cue.start);
                if (!this.skipping && cue.step.waitForCompletion && media?.isPlaying()) {
                    this.waiting = media; this.frame = cue.start;
                    this.pose(this.frame); return;
                }
            }
            this.frame = frame; this.pose(frame);
            if (frame >= this.duration) this.finish();
        }
        pose(frame) {
            // A blocking cue can share a timestamp with later moves or motions.
            // Evaluate only dispatched cues until the media has completed.
            const sequence = {...this.sequence, steps:this.sequence.steps.slice(0,this.cursor)};
            this.adapter.pose?.(B.evaluate(sequence, frame, this.adapter.context), frame);
        }
        finish(cancelled = false) { if (!this.done) { this.done = true; this.adapter.cleanup?.(cancelled); } }
        skip() { this.waiting = null; this.skipping = true; this.update(this.duration + 1); }
        cancel() { this.waiting = null; this.finish(true); }

    };
    root.ReactorBattleData = B;
    if (typeof module !== 'undefined' && module.exports) module.exports = B;
})(globalThis);
