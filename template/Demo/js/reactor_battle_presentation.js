/* Opt-in battle rooms and sequence playback, installed after project plugins. */
(function(root) {
    'use strict';
    const B=root.ReactorBattleData, P={settings:B.empty(),sequences:[null],state:'idle',warnings:new Set()};
    const modelBitmapUpdates={actors:root.Sprite_Actor?.prototype.updateBitmap,enemies:root.Sprite_Enemy?.prototype.updateBitmap};
    root.ReactorBattlePresentation=P;
    P.warn=message=>{if(!P.warnings.has(String(message))){P.warnings.add(String(message));console.warn('Battle presentation:',message);}};
    P.json=async function(file,optional=false){
        if(Utils.isNwjs()){
            const fs=require('fs'),path=require('path');const name=path.join(path.dirname(process.mainModule.filename),file);
            if(optional&&!fs.existsSync(name))return null;
            return RRJson.read(fs,name);
        }
        const response=await fetch(file);if(optional&&response.status===404)return null;
        if(!response.ok)throw Error('Could not load '+file);return RRJson.parse(await response.arrayBuffer());
    };
    P.load=function(){
        if(P.state!=='idle')return;P.state='loading';
        Promise.all([P.json('data/ActionSequences.json',true),P.json('data/BattlePresentation.json',true),P.json('data/.BattlePresentation.pending.json',true)]).then(([sequences,settings,journal])=>{
            if(journal){if(journal.version!==1||!Array.isArray(journal.files))throw Error('Battle data recovery is required.');for(const entry of journal.files){if(entry.file==='ActionSequences.json')sequences=entry.previous?JSON.parse(entry.previous):null;if(entry.file==='BattlePresentation.json')settings=entry.previous?JSON.parse(entry.previous):null;}}
            B.validateStore(sequences||[null],settings||B.empty());P.sequences=sequences||[null];P.settings=settings||B.empty();
        }).catch(P.warn).finally(()=>P.state='ready');
    };
    const dataReady=DataManager.isDatabaseLoaded;
    DataManager.isDatabaseLoaded=function(){P.load();return dataReady.call(this)&&P.state==='ready';};
    P.assets={
        image(kind,name){return new Promise((resolve,reject)=>{
            const bitmap=kind==='tilesets'?ImageManager.loadTileset(name):ImageManager.loadParallax(name);
            const start=Date.now();const check=()=>{if(bitmap.isError())reject(Error('Missing '+kind+'/'+name));else if(bitmap.isReady())resolve(bitmap);else if(Date.now()-start>15000)reject(Error('Timed out loading '+name));else setTimeout(check,30);};check();
        });},
        async model(spec){return {template:await Reactor3D.loadModel(spec.name,spec.ext,spec.file,spec.texture),sidecar:await Reactor3D.loadModelSidecar(spec.name)};},
        get screenHeight(){return Graphics.height;},get tileSize(){return $dataSystem.tileSize||48;},
        animation:id=>$dataAnimations[id],effectUrl:name=>EffectManager.makeUrl(name),playSe:se=>AudioManager.playSe(se),
        lightIsOn:light=>Reactor3D.lightIsOn(light),
        mediaUrl(file){const media=root.RPGReactorMediaSurfaces,isImage=media?.isImageFile(file),folder=isImage?'img/pictures':'movies';
            if(Utils.isNwjs()){const fs=require('fs'),path=require('path');if(!fs.existsSync(path.join(path.dirname(process.mainModule.filename),folder,file)))return '';}
            return media?(isImage?media.pictureUrl(file):media.movieUrl(file)):folder+'/'+file.split('/').map(encodeURIComponent).join('/');},
        warn:P.warn
    };
    P.sequence=function(subject,action){
        const sequence=B.resolve(P.settings,P.sequences,{kind:DataManager.isSkill(action.item())?'skills':'items',itemId:action.item().id,
            isAttack:action.isAttack(),weaponIds:subject.weapons?.().map(w=>w.id)||[],
            battlerKind:subject.isActor()?'actors':'enemies',battlerId:subject.isActor()?subject.actorId():subject.enemyId()});
        if(sequence?.steps.some(s=>s.type==='animation'&&s.animationId>0&&!$dataAnimations[s.animationId])){P.warn('A sequence animation is missing; existing action behavior is retained.');return null;}return sequence;
    };
    P.compatibility=function(){
        const names=(PluginManager._scripts||[]).join(' ');
        const unsupported=names.match(/VE_BattleMotions|YEP_BattleEngineCore|VisuMZ_1_BattleCore|LeTBS/i);
        return unsupported ? 'The active '+unsupported[0]+' battle engine needs a presentation adapter. Existing behavior is retained.' : '';
    };
    P.adapter=function(manager,subject,targets){
        const ss=manager._spriteset,room=ss?._reactorRoom;
        const visibleTargets=[...new Set(targets)],roles={user:ss?.findTargetSprite(subject)};
        visibleTargets.forEach((target,i)=>roles['target'+i]=ss?.findTargetSprite(target));
        roles.target=roles.target0;
        const homes={},saved=new Map();
        for(const [key,sprite] of Object.entries(roles))if(sprite){
            if(!saved.has(sprite))saved.set(sprite,{x:sprite.x,y:sprite.y,offsetX:sprite._offsetX,offsetY:sprite._offsetY,rotation:sprite.rotation,scaleX:sprite.scale?.x??1,scaleY:sprite.scale?.y??1,model:sprite._reactorBattler?.object,modelRotation:sprite._reactorBattler?.object?.rotation.clone(),modelScale:sprite._reactorBattler?.object?.scale.clone()});
            homes[key]=Object.assign({rotateX:0,rotateY:0,rotateZ:0,scale:1},room?{...sprite._reactorRoomPosition}:{x:sprite.x/48,y:sprite.y/48,z:0});
        }
        const camera=room?{...room.settings.camera}:null,cameraSource=room?.settings.cameraSource;
        homes.camera=room?{x:camera.x,y:camera.y,z:camera.z}: {x:0,y:0,z:0};
        const media=[];
        const adapter={context:{homes,target:homes.target,direction:homes.target&&homes.user&&homes.target.x<homes.user.x?-1:1},
            cue(step,start){
                const chosen=step.role==='allTargets'?visibleTargets:step.role==='target'?[visibleTargets[step.targetIndex??0]]:[subject];
                if(step.type==='impact'){
                    // Drain the original occurrence list exactly once, preserving repeats.
                    adapter.pendingImpact=true;adapter.resolveNext();
                }else if(step.type==='camera'&&room){Object.assign(room.settings.camera,room.cameraState());room.settings.cameraSource='custom';}
                else if(step.type==='sound'&&step.audio?.name){
                    const before=new Set(AudioManager._seBuffers||[]);AudioManager.playSe(step.audio);
                    const buffers=(AudioManager._seBuffers||[]).filter(b=>!before.has(b)),created=Date.now();
                    const ticket={isPlaying:()=>buffers.some(b=>!b.isError?.()&&(b.isReady?.()===false?Date.now()-created<15000:b.isPlaying())),cancel:()=>buffers.forEach(b=>b.stop())};
                    media.push(ticket);return ticket;
                }
                else if(step.type==='animation'&&step.animationId>0){
                    const tickets=[],flat=[];
                    for(const battler of chosen.filter(Boolean)){const ticket=room?.playAnimation(ss.findTargetSprite(battler)?._reactorRoomKey,step.animationId,step.animationTransform);if(ticket)tickets.push(ticket);else flat.push(battler);}
                    if(flat.length){
                        const before=new Set($gameTemp._animationQueue||[]);$gameTemp.requestAnimation(flat,step.animationId);
                        for(const request of ($gameTemp._animationQueue||[]).filter(r=>!before.has(r))){
                            const created=Date.now(),ticket={pending:true,sprites:[],transform:{...step.animationTransform},room,
                                isPlaying(){return this.pending?Date.now()-created<15000:this.sprites.some(s=>s.isPlaying());},
                                cancel(){this.pending=false;const i=$gameTemp._animationQueue.indexOf(request);if(i>=0){$gameTemp._animationQueue.splice(i,1);for(const b of request.targets)b.endAnimation?.();}for(const sprite of this.sprites)if(ss._animationSprites?.includes(sprite))ss.removeAnimation(sprite);}};
                            request._reactorSequenceMedia=ticket;tickets.push(ticket);
                        }
                    }
                    const ticket={isPlaying:()=>tickets.some(t=>t.isPlaying()),cancel:()=>tickets.forEach(t=>t.cancel?.())};media.push(ticket);return ticket;
                }
                else if(step.type==='motion')for(const battler of chosen.filter(Boolean)){
                    const sprite=ss.findTargetSprite(battler);sprite?.startMotion?.(step.motion==='idle'?'wait':['attack','punch'].includes(step.motion)?'thrust':step.motion==='run'?'walk':step.motion==='cast'?'spell':step.motion);
                    const state=sprite?._reactorBattler;if(state){root.ReactorBattleRoomView.prepareMotions(state);const rule=state.rules?.find(r=>r.trigger==='action'&&r.name.toLowerCase()===step.motion?.toLowerCase());state.action=step.motion==='idle'?null:{name:rule?.name||step.motion,frame:state.frame};if(step.motion==='idle'&&state.binding)state.binding.movingAt=undefined;}
                    const model=room?.models.get(sprite?._reactorRoomKey);if(model){model.action=step.motion==='idle'?null:{name:step.motion,start:room.frame};if(step.motion==='idle'&&model.binding)model.binding.movingAt=undefined;}
                }else if(step.type==='weapon'){
                    adapter.clearWeapon();if(step.visible===false)return;
                    const item=step.iconSource==='action'?manager._action.item():subject.weapons?.()[0];const icon=step.iconSource==='icon'?step.iconIndex||0:item?.iconIndex||0;
                    const graphic=new Sprite(ImageManager.loadSystem('IconSet')),size=ImageManager.iconWidth||32;graphic.setFrame(icon%16*size,Math.floor(icon/16)*size,size,size);graphic.anchor.set(.5,.5);ss._battleField.addChild(graphic);adapter.weapon={graphic,step};
                }else if(step.type==='projectile'){
                    adapter.clearProjectile();
                    const graphic=new Sprite(new Bitmap(step.size||8,step.size||8));graphic.bitmap.fillAll(step.color||'#ffcc55');graphic.anchor.set(.5,.5);
                    ss._battleField.addChild(graphic);adapter.projectile={graphic,start,duration:step.duration};
                }
            },
            pose(positions,frame){
                for(const [key,logical] of Object.entries(positions)){
                    const p=B.visualPose(logical);
                    if(key==='camera'){if(room)Object.assign(room.settings.camera,p);continue;}
                    const sprite=roles[key];if(!sprite)continue;
                    if(room)sprite._reactorRoomPosition={...sprite._reactorRoomPosition,...p};
                    else{sprite._offsetX=p.x*48-sprite._homeX;sprite._offsetY=(p.y-p.z)*48-sprite._homeY;sprite.x=p.x*48;sprite.y=(p.y-p.z)*48;const old=saved.get(sprite);sprite.rotation=(old.rotation||0)+(old.model?0:(p.rotateZ||0)*Math.PI/180);if(old.model){old.model.rotation.set(old.modelRotation.x+(p.rotateX||0)*Math.PI/180,old.modelRotation.y+(p.rotateY||0)*Math.PI/180,old.modelRotation.z+(p.rotateZ||0)*Math.PI/180);old.model.scale.set(old.modelScale.x*(p.scaleX??1),old.modelScale.y*(p.scaleY??1),old.modelScale.z*(p.scaleZ??1));}const initialFacing=B.facingToward(homes[key],(key==='user'?homes.target:homes.user)||homes[key]),turn=p.facing!==undefined&&Math.sign(p.facing)!==Math.sign(initialFacing)?-1:1;sprite.scale?.set(old.scaleX*turn*(p.scale??1)*(old.model?1:(p.scaleX??1)),old.scaleY*(p.scale??1)*(old.model?1:(p.scaleY??1)));}
                }
                const projectile=adapter.projectile;
                if(projectile){const a=roles.user,b=roles.target;if(a&&b){const t=Math.min(1,Math.max(0,(frame-projectile.start)/Math.max(1,projectile.duration)));projectile.graphic.x=a.x+(b.x-a.x)*t;projectile.graphic.y=a.y+(b.y-a.y)*t-48;projectile.graphic.visible=t<1;
                    if(room){const pa=a._reactorRoomPosition,pb=b._reactorRoomPosition;room.billboard('extra:projectile',projectile.graphic.bitmap.canvas,{x:0,y:0,width:projectile.graphic.bitmap.width,height:projectile.graphic.bitmap.height},{x:pa.x+(pb.x-pa.x)*t,y:pa.y+(pb.y-pa.y)*t,z:1},projectile.graphic.bitmap.height/48);const record=room.billboards.get('extra:projectile');if(record)record.object.visible=t<1;projectile.graphic.visible=false;}
                }}
                const weapon=adapter.weapon;if(weapon){const s=weapon.step,p=roles.user;weapon.graphic.x=p.x+(s.x??.5)*48;weapon.graphic.y=p.y-(s.z??1)*48+(s.y||0)*48;weapon.graphic.rotation=(s.rotation||0)*Math.PI/180;weapon.graphic.scale.set(s.scale||1);
                    if(room&&weapon.graphic.bitmap.isReady()){const home=p._reactorRoomPosition;room.billboard('extra:weapon',weapon.graphic.bitmap.canvas,weapon.graphic._frame,{x:home.x+(s.x??.5),y:home.y+(s.y||0),z:(home.z||0)+(s.z??1),rotateZ:s.rotation||0,scale:s.scale||1},.7);weapon.graphic.visible=false;}
                }
            },
            resolveNext(){if(manager._targets.length)manager.invokeAction(subject,manager._targets.shift());adapter.pendingImpact=manager._targets.length>0;},
            clearWeapon(){room?.remove('extra:weapon');const g=adapter.weapon?.graphic;if(g){g.removeFromParent();g.destroy();}adapter.weapon=null;},
            clearProjectile(){room?.remove('extra:projectile');const g=adapter.projectile?.graphic;if(g){g.removeFromParent();g.bitmap.destroy();g.destroy();}adapter.projectile=null;},
            cleanup(cancelled){
                if(cancelled)for(const ticket of media)ticket.cancel?.();
                room?.endCinematicAction?.();
                for(const [sprite,old] of saved){if(old.model){old.model.rotation.copy(old.modelRotation);old.model.scale.copy(old.modelScale);}sprite.rotation=old.rotation;sprite.scale?.set(old.scaleX,old.scaleY);Object.assign(sprite,{x:old.x,y:old.y,_offsetX:old.offsetX,_offsetY:old.offsetY});if(room){const role=Object.keys(roles).find(k=>roles[k]===sprite);sprite._reactorRoomPosition={...homes[role]};}}
                if(room&&camera){Object.assign(room.settings.camera,camera);room.settings.cameraSource=cameraSource;}
                adapter.clearProjectile();adapter.clearWeapon();
                for(const sprite of saved.keys()){sprite.refreshMotion?.();if(sprite._reactorBattler){sprite._reactorBattler.action=null;const binding=sprite._reactorBattler.binding;if(binding){binding.latch={};binding.angles={};}}const model=room?.models.get(sprite._reactorRoomKey);if(model){model.action=null;if(model.binding){model.binding.latch={};model.binding.angles={};}}}
            }
        };return adapter;
    };
    P.installPsychronicHud=function(){
        if(!(PluginManager._scripts||[]).some(name=>/PSYCHRONIC_ATB-MZ/i.test(name))||typeof Window_Base==='undefined')return;
        const initialize=Window_Base.prototype.initialize;
        const present=(folder,name)=>{
            if(!name)return false;if(!Utils.isNwjs())return true;
            const fs=require('fs'),path=require('path'),dir=path.join(path.dirname(process.mainModule.filename),'img',folder);
            const extensions=ImageManager._imageExtensions||['.png'];
            const names=extensions.some(ext=>name.toLowerCase().endsWith(ext))?[name,name+'.png']:extensions.map(ext=>name+ext);
            return names.some(file=>[file,file+'_',file.replace(/\.png$/i,'.rpgmvp')].some(candidate=>fs.existsSync(path.join(dir,candidate))));
        };
        Window_Base.prototype.initialize=function(...args){
            // The plugin keeps Window_ATBBar private. Its base initialization
            // is the point before it asks for icon assets; adapt this instance.
            if(this.loadBattlerIcon&&this.loadBackgroundIcon&&this.setEnemySpriteFrame&&!this._reactorHudAssets){
                this._reactorHudAssets=true;const icon=this.loadBattlerIcon,background=this.loadBackgroundIcon;
                this.loadBattlerIcon=function(battler,sprite){
                    const enemy=!battler.isActor(),data=enemy?$dataEnemies[battler.enemyId()]:$dataActors[battler.actorId()];
                    if(!enemy||/<atb icon:\s*\d+>/i.test(data.note||''))return icon.call(this,battler,sprite);
                    const spec=Reactor3D.databaseModelSpec('enemies',battler.enemyId());
                    if(spec){
                        const update=sprite.update;sprite.update=function(){update.call(this);const source=SceneManager._scene?._spriteset?.findTargetSprite(battler),bitmap=source?._reactorBattler?.bitmap;
                            if(bitmap?.isReady()&&bitmap.width>1){
                                this.bitmap=bitmap;this.setFrame(0,0,bitmap.width,bitmap.height);this.scale.set(32/bitmap.width,32/bitmap.height);
                                // Shared render targets have bottom-up rows. Frame changes
                                // rebuild each sprite texture, so derive its UV pose from
                                // the bitmap source rather than another sprite's frame.
                                const rotate=bitmap.baseTexture?.source?.__reactorExternal?PIXI.groupD8.MIRROR_VERTICAL:0;
                                if(this.texture&&this.texture.rotate!==rotate){
                                    this.texture.rotate=rotate;this.texture.updateUvs?.();
                                }
                            }
                        };return;
                    }
                    const folders=['sv_enemies','enemies','characters'],folder=folders.find(folder=>present(folder,data.battlerName));
                    if(folder){const bitmap=ImageManager.loadBitmap('img/'+folder+'/',data.battlerName);bitmap.addLoadListener(()=>this.setEnemySpriteFrame(sprite,bitmap,data.battlerName));}
                    else this.loadFallbackIcon(sprite,1);
                };
                this.loadBackgroundIcon=function(battler,sprite){const params=PluginManager.parameters('PSYCHRONIC_ATB-MZ'),name=params[battler.isActor()?'actorIconBackground':'enemyIconBackground'];if(!present('system',name)){sprite.visible=false;return;}return background.call(this,battler,sprite);};
            }
            return initialize.apply(this,args);
        };
    };
    P.installPartyLimit=function(){
        if (!root.Game_Party || P.partyLimitInstalled) return;
        P.partyLimitInstalled=true;
        const proto=Game_Party.prototype,previous=proto.maxBattleMembers,set=proto.setMaxBattleMembers;
        proto.maxBattleMembers=function(){
            const configured=B.configuredBattleMembers(root.$dataSystem);
            if (configured===null) return previous.call(this);
            return B.configuredBattleMembers({maxBattleMembers:this._reactorBattleMemberLimit}) ?? configured;
        };
        // Preserve scripted party-size changes and their save-game lifetime.
        proto.setMaxBattleMembers=function(max){
            const value=B.configuredBattleMembers({maxBattleMembers:Number(max)});
            if (B.configuredBattleMembers(root.$dataSystem)!==null && value!==null) this._reactorBattleMemberLimit=value;
            if (set) return set.call(this,max);
        };
    };
    P.installBattlebackLoading=function(){
        if(!root.ImageManager||P.battlebacksInstalled)return;P.battlebacksInstalled=true;
        for(const name of ['loadBattleback1','loadBattleback2']){
            const load=ImageManager[name];if(!load)continue;
            ImageManager[name]=function(...args){
                if(P._creatingBattleRoom||root.SceneManager?._scene?._reactorUsesBattleRoom){
                    // Keep the sprites plugins expect, without requesting an unused file.
                    if(!P._emptyBattleback?.width)P._emptyBattleback=new Bitmap(1,1);
                    return P._emptyBattleback;
                }
                return load.apply(this,args);
            };
        }
    };
    P.roomScreenPosition=function(sprite) {
        const ss=BattleManager._spriteset,room=ss?._reactorRoom;if(!room||!sprite._reactorRoomPosition)return null;
        const p=room.project(sprite._reactorRoomPosition);
        if(ss._reactorRoomSprite?.toGlobal&&sprite.parent?.toLocal)return sprite.parent.toLocal(ss._reactorRoomSprite.toGlobal(new PIXI.Point(p.x,p.y)));
        return {x:p.x-(ss._battleField?.x||0),y:p.y-(ss._battleField?.y||0)};
    };
    P.installRoomAnchors=function(){
        for(const Class of [root.Sprite_Actor,root.Sprite_Enemy])if(Class){
            const position=Class.prototype.updatePosition;
            Class.prototype.updatePosition=function(...args){position?.apply(this,args);const p=P.roomScreenPosition(this);if(p){this.x=p.x;this.y=p.y;}};
        }
        if(root.Game_Enemy)for(const [method,axis] of [['screenX','x'],['screenY','y']]){
            const original=Game_Enemy.prototype[method];if(!original)continue;
            Game_Enemy.prototype[method]=function(){const sprite=BattleManager._spriteset?.findTargetSprite?.(this),p=sprite&&P.roomScreenPosition(sprite);return p?p[axis]:original.call(this);};
        }
        if(root.BattleCursorSprite){
            const proto=BattleCursorSprite.prototype,x=proto.posX,y=proto.posY;
            const anchor=cursor=>{
                const sprite=cursor._battlerSprite,bounds=sprite?._reactorRoomBounds,ss=BattleManager._spriteset;if(!bounds||!ss?._reactorRoom||!cursor.parent)return null;
                const px=cursor._align===3?bounds.x:cursor._align===4?bounds.x+bounds.width:bounds.x+bounds.width/2;
                const py=cursor._align===0?bounds.y+bounds.height:cursor._align===2?bounds.y:bounds.y+bounds.height/2;
                return cursor.parent.toLocal(ss._reactorRoomSprite.toGlobal(new PIXI.Point(px,py)));
            };
            proto.posX=function(){const p=anchor(this);return p?p.x+this._position.xOffset+this._effect.waveX+this._battler._battleCursor.X_Offset:x.call(this);};
            proto.posY=function(){const p=anchor(this);return p?p.y+this._position.yOffset+this._effect.waveY+this._battler._battleCursor.Y_Offset:y.call(this);};
        }
    };
    P.publishRoomBounds=function(sprite,room,key){
        const bounds=room.bounds(key);if(!bounds)return;sprite._reactorRoomBounds=bounds;
        const p=P.roomScreenPosition(sprite);if(p){sprite.x=p.x;sprite.y=p.y;sprite._homeX=p.x;sprite._homeY=p.y;}
        // Publish projected dimensions without changing the source frame used
        // to draw a sprite sheet into the room's billboard texture.
        for(const node of new Set([sprite,sprite._mainSprite].filter(Boolean))){
            node._reactorRoomBounds=bounds;if(node._reactorRoomDimensions)continue;node._reactorRoomDimensions=true;
            for(const key of ['width','height']){let proto=node,descriptor;while(proto&&!descriptor){descriptor=Object.getOwnPropertyDescriptor(proto,key);proto=Object.getPrototypeOf(proto);}if(!descriptor?.get)continue;
                Object.defineProperty(node,key,{configurable:true,get(){return this._reactorRoomBounds?.[key]??descriptor.get.call(this);},set(value){descriptor.set?.call(this,value);}});
            }
        }
        if(sprite._stateIconSprite)sprite._stateIconSprite.y=bounds.y-room.project(sprite._reactorRoomPosition).y-20;
    };
    P.installSequenceAnimations=function(){
        if(!root.Spriteset_Base)return;
        const proto=Spriteset_Base.prototype,create=proto.createAnimation,busy=proto.isAnimationPlaying;
        proto.createAnimation=function(request){
            const ticket=request._reactorSequenceMedia;if(!ticket)return create.call(this,request);
            const before=new Set(this._animationSprites);
            try{return create.call(this,request);}finally{
                ticket.pending=false;ticket.sprites=this._animationSprites.filter(s=>!before.has(s));
                for(const sprite of ticket.sprites){
                    sprite._reactorSequenceMedia=ticket;
                    const t=ticket.transform,scale=t.scale??1;
                    sprite._animation={...sprite._animation,scale:(sprite._animation.scale??100)*scale};
                    const offset=()=>{
                        const points=(sprite.targetObjects||[]).map(b=>this.findTargetSprite(b)?._reactorRoomPosition).filter(Boolean);
                        if(ticket.room&&points.length){let x=0,y=0;for(const p of points){const a=ticket.room.project(p),b=ticket.room.project({x:p.x+(t.x||0),y:p.y+(t.y||0),z:(p.z||0)+(t.z||0)});x+=b.x-a.x;y+=b.y-a.y;}return {x:x/points.length,y:y/points.length};}
                        return {x:(t.x||0)*48,y:((t.y||0)-(t.z||0))*48};
                    };
                    if(sprite.targetPosition){const original=sprite.targetPosition;sprite.targetPosition=function(...args){const p=original.apply(this,args),d=offset();return {x:p.x+d.x,y:p.y+d.y};};}
                    else if(sprite.updatePosition){const original=sprite.updatePosition;sprite.updatePosition=function(...args){original.apply(this,args);const d=offset();this.x+=d.x;this.y+=d.y;};}
                    if(sprite.updateCellSprite){const original=sprite.updateCellSprite;sprite.updateCellSprite=function(cell,...args){original.call(this,cell,...args);cell.x*=scale;cell.y*=scale;cell.scale.x*=scale;cell.scale.y*=scale;};}
                }
            }
        };
        proto.isAnimationPlaying=function(){
            // The sequence player owns its waits. Ordinary/plugin animations
            // retain the original spriteset busy behavior.
            if(this._animationSprites?.some(s=>s._reactorSequenceMedia))return this._animationSprites.some(s=>!s._reactorSequenceMedia);
            return busy.call(this);
        };
    };
    P.install=function(){
        if(P.installed)return;P.installed=true;P.installRoomAnchors();P.installSequenceAnimations();P.installBattlebackLoading();P.installPartyLimit();P.installRoomEvents?.();P.installPsychronicHud();
        for(const [Class,kind] of [[root.Sprite_Actor,'actors'],[root.Sprite_Enemy,'enemies']])if(Class){
            const updateBitmap=Class.prototype.updateBitmap;
            Class.prototype.updateBitmap=function(...args){
                const battler=this._actor||this._enemy;if(battler){
                    if(Reactor3D.isDatabaseSidecarReady&&!Reactor3D.isDatabaseSidecarReady()){const main=this._mainSprite||this;if(!main.bitmap)main.bitmap=new Bitmap(1,1);return;}
                    const spec=kind==='actors'?Reactor3D.actorSlotSpec(battler.actorId(),'battler'):Reactor3D.databaseModelSpec('enemies',battler.enemyId());
                    if(spec){const result=modelBitmapUpdates[kind].apply(this,args);if(this._reactorBattler?.ready)root.ReactorBattleRoomView.prepareMotions(this._reactorBattler);return result;}
                }
                return updateBitmap.apply(this,args);
            };
        }
        const start=BattleManager.startAction,update=BattleManager.updateAction,end=BattleManager.endBattle;
        const beginCamera=manager=>{const ss=manager._spriteset;ss?._reactorRoom?.beginCinematicAction?.(ss.findTargetSprite(manager._subject)?._reactorRoomKey,(manager._targets||[]).map(b=>ss.findTargetSprite(b)?._reactorRoomKey).filter(Boolean));};
        const invoke=BattleManager.invokeAction,endAction=BattleManager.endAction;
        BattleManager.invokeAction=function(...args){this._spriteset?._reactorRoom?.cinematicImpact?.();return invoke.apply(this,args);};
        BattleManager.endAction=function(...args){try{return endAction.apply(this,args);}finally{this._spriteset?._reactorRoom?.endCinematicAction?.();}};
        const logStart=Window_BattleLog.prototype.startAction;
        Window_BattleLog.prototype.startAction=function(subject,action,targets){
            if(BattleManager._reactorStarting){this.displayAction(subject,action.item());return;}
            return logStart.call(this,subject,action,targets);
        };
        // PSYCHRONIC's action choice is the extension point; its remaining
        // battle rules and result resolver remain active.
        const choose=BattleManager.shouldUseActionSequence;
        if(choose)BattleManager.shouldUseActionSequence=function(action){return this._reactorStarting?false:choose.call(this,action);};
        BattleManager.startAction=function(){
            const subject=this._subject,action=subject?.currentAction();
            const sequence=action&&P.sequence(subject,action),problem=sequence&&P.compatibility();
            if(problem)P.warn(problem);
            if(!sequence||problem){const result=start.call(this);beginCamera(this);return result;}
            this._reactorSequence?.cancel();this._reactorStarting=true;
            try{start.call(this);}finally{this._reactorStarting=false;}
            this._reactorSequence=new B.Player(sequence,P.adapter(this,subject,this._targets.slice()));beginCamera(this);
        };
        BattleManager.updateAction=function(){
            const player=this._reactorSequence;
            if(!player)return update.call(this);
            try{if(player.adapter.pendingImpact){player.adapter.resolveNext();return;}player.update(1);}catch(error){P.warn(error);player.cancel();}
            if(player.done&&!player.adapter.pendingImpact){this._reactorSequence=null;this.endAction();}
        };
        BattleManager.endBattle=function(...args){this._spriteset?._reactorRoom?.endCinematicAction?.();this._reactorSequence?.cancel();this._reactorSequence=null;return end.apply(this,args);};
        const force=BattleManager.forceAction;
        BattleManager.forceAction=function(...args){this._spriteset?._reactorRoom?.endCinematicAction?.();if(this._reactorSequence){this._reactorSequence.cancel();this._targets=[];}this._reactorSequence=null;return force.apply(this,args);};
        const create=Scene_Battle.prototype.create,ready=Scene_Battle.prototype.isReady,terminate=Scene_Battle.prototype.terminate;
        Scene_Battle.prototype.create=function(){
            const config=P.settings.troops?.[$gameTroop._troopId];
            this._reactorUsesBattleRoom=config?.type==='room';
            const previous=P._creatingBattleRoom;P._creatingBattleRoom=this._reactorUsesBattleRoom;
            try{create.call(this);}finally{P._creatingBattleRoom=previous;}
            this._reactorRoomLoading=false;
            if(config?.type==='room'&&config.mapId>0){this._reactorRoomLoading=true;this._reactorRoomToken={};const token=this._reactorRoomToken;
                P.createRoom(this,config,token).catch(P.warn).finally(()=>{if(this._reactorRoomToken===token)this._reactorRoomLoading=false;});}
        };
        Scene_Battle.prototype.isReady=function(){return !this._reactorRoomLoading&&ready.call(this);};
        Scene_Battle.prototype.terminate=function(){this._reactorRoomToken=null;this._spriteset?._reactorRoom?.dispose();BattleManager._reactorSequence?.cancel();BattleManager._reactorSequence=null;return terminate.call(this);};
        const updateSprites=Spriteset_Battle.prototype.update;
        Spriteset_Battle.prototype.update=function(){updateSprites.call(this);if(this._reactorRoom)P.updateRoom(this);};
        PluginManager.registerCommand('RPGReactor','BattleSequenceSkip',()=>{const player=BattleManager._reactorSequence;if(player){player.skip();while(player.adapter.pendingImpact)player.adapter.resolveNext();}});
        PluginManager.registerCommand('RPGReactor','BattleRoomCamera',function(args){const room=SceneManager._scene?._spriteset?._reactorRoom;if(room){Object.assign(room.settings.camera,room.cameraState());room.settings.cameraSource='custom';for(const key of ['x','y','z','yaw','pitch','distance'])if(args[key]!==undefined&&Number.isFinite(Number(args[key])))room.settings.camera[key]=Number(args[key]);}});
    };
    P.createRoom=async function(scene,config,token){
        const map=await P.json('data/Map'+String(config.mapId).padStart(3,'0')+'.json');
        map.reactor3d=await P.json('data/Map'+String(config.mapId).padStart(3,'0')+'.r3d.json',true)||{};
        Reactor3D.ensureLoaded();const until=Date.now()+20000;while(!Reactor3D.isLoaded()){if(Date.now()>until)throw Error('3D libraries did not load');await new Promise(r=>setTimeout(r,30));}
        if(scene._reactorRoomToken!==token)return;
        const room=new ReactorBattleRoomView(map,$dataTilesets[map.tilesetId],JSON.parse(JSON.stringify(config)),P.assets);
        try{await room.build();if(scene._reactorRoomToken!==token){room.dispose();return;}
            const ss=scene._spriteset;room.resize(Graphics.width,Graphics.height);
            const sprite=new Sprite(new Bitmap(Graphics.width,Graphics.height));ss._baseSprite.addChildAt(sprite,Math.max(0,ss._baseSprite.children.indexOf(ss._battleField)));
            ss._reactorRoom=room;ss._reactorRoomSprite=sprite;P.setupRoomEvents?.(room,ss);
            for(const bg of [ss._backgroundSprite,ss._back1Sprite,ss._back2Sprite])if(bg)bg.visible=false;
        }catch(error){room.dispose();const ss=scene._spriteset;if(ss?._reactorRoom===room){ss._reactorRoom=null;const sprite=ss._reactorRoomSprite;sprite?.removeFromParent();sprite?.bitmap?.destroy();sprite?.destroy();ss._reactorRoomSprite=null;}throw error;}
    };
    P.updateRoom=function(ss){
        const room=ss._reactorRoom;if(room.disposed)return;
        room.aim();const live=new Set();
        for(const sprite of ss.battlerSprites()){
            const battler=sprite._battler;if(!battler)continue;
            const actor=battler.isActor(),index=actor?$gameParty.battleMembers().indexOf(battler):battler.index();
            const key=(actor?'actor:':'enemy:')+index;live.add(key);
            sprite._reactorRoomKey=key;
            if(!sprite._reactorRoomPosition)sprite._reactorRoomPosition=B.position(room.settings,actor?'actors':'enemies',index);
            const p=sprite._reactorRoomPosition;
            const spec=actor?Reactor3D.actorSlotSpec(battler.actorId(),'battler'):Reactor3D.databaseModelSpec('enemies',battler.enemyId());
            const main=sprite._mainSprite||sprite;
            if(spec){if(room.billboards.has(key))room.remove(key);room.addModel(key,spec,p);room.place(key,p);}
            else {if(room.models.has(key))room.remove(key);}
            if(!spec&&main.bitmap?.isReady())room.billboard(key,main.bitmap.canvas,main._frame,{...p,flipX:actor?p.facing>0:p.facing<0},Math.max(.5,main._frame.height/48));
            const record=room.models.get(key)||room.billboards.get(key);
            if(record?.object)record.object.visible=battler.isAppeared()&&sprite.opacity>0;
            const projected=P.roomScreenPosition(sprite);if(projected){sprite.x=projected.x;sprite.y=projected.y;}
            if(main.texture)main.texture=PIXI.Texture.EMPTY;
        }
        for(const key of [...room.models.keys(),...room.billboards.keys()])if(!key.startsWith('prop:')&&!key.startsWith('event:')&&!key.startsWith('extra:')&&!live.has(key))room.remove(key);
        P.updateRoomEvents?.(room);room.render();for(const sprite of ss.battlerSprites())if(sprite._reactorRoomKey)P.publishRoomBounds(sprite,room,sprite._reactorRoomKey);const bitmap=ss._reactorRoomSprite.bitmap;bitmap.context.drawImage(room.renderer.domElement,0,0);bitmap.baseTexture.update();
    };
})(globalThis);
