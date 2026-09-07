/* Shared database controls for opt-in battle presentation. All edits stay in the database working copy. */
class BattlePresentationEditor {
    constructor(parent) { this.parent=parent;this.db=parent.databaseManager;this.views=new Set(); }
    message(source, params) { return {source, params}; }
    text(value) { const {source,params}=typeof value==='object'?value:{source:String(value)};return window.I18n?I18n.formatText(source,params):source.replace(/\{(\w+)\}/g,(token,key)=>params?.[key]??token); }
    setText(element,value,raw=false) {
        if(raw){element.setAttribute('data-rr-i18n-skip','');element.textContent=String(value);return;}
        const {source,params}=typeof value==='object'?value:{source:String(value)};
        element.setAttribute('data-i18n-text-source',source);
        if(params)element.setAttribute('data-i18n-text-params',JSON.stringify(params));else element.removeAttribute('data-i18n-text-params');
        element.textContent=this.text(value);
    }
    cameraLabel(mode) { return {fixed:'Free Camera',isometric:'Isometric',thirdPerson:'Third Person',firstPerson:'First Person',topDown:'Top Down',cinematic:'Cinematic Cuts'}[mode]||mode; }
    changed() { this.db.mutationGeneration++;this.parent.updateStatus(this.text('Modified')); }
    settings() { return this.db.data.battlePresentation ||= ReactorBattleData.empty(); }
    element(tag,classes,text,raw=false) { const e=document.createElement(tag);e.className=classes||'';if(text!==undefined)this.setText(e,text,raw);return e; }
    select(options,value,onChange) {const s=this.element('select','database-field-value');for(const [id,name,raw] of options){const o=this.element('option','',name,raw);o.value=id;s.append(o);}s.value=String(value);s.onchange=()=>onChange(s.value);return s;}
    field(host,label,input) {const row=this.element('label','rr-battle-field');row.append(this.element('span','',label),input);host.append(row);return input;}
    number(host,label,value,change,step=.1) {const input=this.element('input','database-field-value');input.type='number';input.step=step;input.value=value;input.onchange=()=>{if(Number.isFinite(input.valueAsNumber))change(input.valueAsNumber);};return this.field(host,label,input);}
    button(label,fn,raw=false) {const b=this.element('button','rr-btn-secondary',label,raw);b.type='button';b.onclick=fn;return b;}
    section(title) {const panel=this.element('div','database-section');panel.append(this.element('div','database-section-header',title));const body=this.element('div','database-section-content');panel.append(body);return {panel,body};}
    assignment(container,kind,record) {
        if(!['skills','items','weapons','actors','enemies'].includes(kind))return;
        const title=kind==='weapons'?'Weapon Attack Sequence':['actors','enemies'].includes(kind)?'Default Action Sequence':'Action Sequence';
        const {panel,body}=this.section(title),settings=this.settings();panel.dataset.sequenceAssignment=kind;
        const value=settings[kind]?.[record.id]||{mode:'inherit'};
        const options=[['inherit','Inherit'],['existing','Use Existing Behavior'],...(this.db.data.actionSequences||[]).filter(Boolean).map(s=>['sequence:'+s.id,s.name||'#'+s.id,true])];
        if(value.mode==='sequence'&&!this.db.data.actionSequences?.[value.sequenceId])options.push(['sequence:'+value.sequenceId,this.message('Missing Sequence #{id}',{id:value.sequenceId})]);
        let open;const control=this.select(options,value.mode==='sequence'?'sequence:'+value.sequenceId:value.mode,selected=>{
            settings[kind]||={};settings[kind][record.id]={...settings[kind][record.id],...(selected.startsWith('sequence:')?{mode:'sequence',sequenceId:Number(selected.split(':')[1])}:{mode:selected,sequenceId:undefined})};this.changed();if(open)open.disabled=!selected.startsWith('sequence:')||!this.db.data.actionSequences?.[Number(selected.split(':')[1])];
        });const controls=this.element('div','rr-battle-assignment-controls');body.append(controls);controls.append(control);
        open=this.button('Open Sequence',()=>{const id=Number(control.value.split(':')[1]);const sequence=this.db.data.actionSequences?.[id];if(sequence){this.parent.openDatabase('actionSequences');this.parent.showDatabaseDetail(sequence,'actionSequences');}});open.disabled=!control.value.startsWith('sequence:')||!this.db.data.actionSequences?.[Number(control.value.split(':')[1])];controls.append(open);
        if(kind==='actors') {
            const unarmed=value.unarmed||{mode:'inherit'};
            const row=this.element('div','rr-battle-assignment-controls');row.style.marginTop='10px';
            let unarmedOpen;const unarmedOptions=options.slice();if(unarmed.mode==='sequence'&&!this.db.data.actionSequences?.[unarmed.sequenceId]&&!unarmedOptions.some(o=>o[0]==='sequence:'+unarmed.sequenceId))unarmedOptions.push(['sequence:'+unarmed.sequenceId,this.message('Missing Sequence #{id}',{id:unarmed.sequenceId})]);
            const select=this.select(unarmedOptions,unarmed.mode==='sequence'?'sequence:'+unarmed.sequenceId:unarmed.mode,selected=>{
                settings.actors[record.id]||={mode:'inherit'};
                settings.actors[record.id].unarmed=selected.startsWith('sequence:')?{mode:'sequence',sequenceId:Number(selected.split(':')[1])}:{mode:selected};this.changed();if(unarmedOpen)unarmedOpen.disabled=!selected.startsWith('sequence:')||!this.db.data.actionSequences?.[Number(selected.split(':')[1])];
            });
            this.field(body,'Unarmed Attack Sequence',row);row.append(select);
            unarmedOpen=this.button('Open Sequence',()=>{const sequence=this.db.data.actionSequences?.[Number(select.value.split(':')[1])];if(sequence){this.parent.openDatabase('actionSequences');this.parent.showDatabaseDetail(sequence,'actionSequences');}});unarmedOpen.disabled=!select.value.startsWith('sequence:')||!this.db.data.actionSequences?.[Number(select.value.split(':')[1])];row.append(unarmedOpen);
            body.append(this.element('p','rr-battle-help','Used only for a normal attack with no weapon equipped. Skills and weapon assignments keep their own behavior.'));
        }
        const help=kind==='weapons'?'Used for attacks with this weapon. A skill or item assignment takes priority.':kind==='actors'?'Used for unarmed attacks and actions without a skill, item or weapon override. Equip a weapon with its own sequence to change its attack.':kind==='enemies'?'Used when this enemy’s skill or item has no sequence override.':'This skill or item takes priority over equipped weapons and the actor/enemy default. Inherit uses those defaults.';
        const hint=this.element('p','rr-battle-help',help);body.append(hint);
        // Keep the card in the record's layout, so tall traits/notes cannot overlap it.
        const layout=container.firstElementChild||container;
        if(layout!==container){layout.style.height='auto';layout.style.minHeight='100%';}
        panel.style.flexShrink='0';layout.append(panel);
    }
    roomPanel(troopEditor) {
        const {panel,body}=this.section('Battle Scene'),id=troopEditor.currentTroopId;
        const settings=this.settings();let config=settings.troops[id]||{type:'battleback'};
        const details=this.element('div','rr-battle-room-settings');
        const type=this.select([['battleback','Battleback'],['room','Battle Room']],config.type||'battleback',value=>{
            config={...config,type:value};settings.troops[id]=config;this.changed();draw();troopEditor.loadAndRenderCanvas?.();
        });body.append(type,details);
        const draw=()=>{
            details.replaceChildren();if(config.type!=='room')return;
            const maps=(this.parent.currentProject.maps||this.db.data.mapInfos||[]).filter(Boolean);
            details.append(this.select([['0','Choose Map…'],...maps.map(m=>[m.id,m.name,true])],config.mapId||0,async value=>{
                const project=this.parent.currentProject,map=await this.readMap(Number(value));if(!map||this.parent.currentProject!==project||!panel.isConnected)return;
                config=ReactorBattleData.room(map);settings.troops[id]=config;this.changed();draw();troopEditor.loadAndRenderCanvas?.();
            }));
            const setup=this.button('Set Up Room',()=>this.roomDialog(config,troopEditor));setup.disabled=!config.mapId;details.append(setup);
            if(config.mapId)this.readMap(config.mapId).then(map=>{if(!details.isConnected||config.type!=='room')return;for(const event of map.events.filter(Boolean)){
                this.field(details,this.message('Room Event: {name}',{name:event.name}),this.select([['called','Called Only'],['enter','On Room Enter'],['parallel','Parallel During Battle']],config.eventModes?.[event.id]||'called',mode=>{config.eventModes||={};config.eventModes[event.id]=mode;this.changed();}));
                details.append(this.button(this.message('Add Call to Troop Page: {name}',{name:event.name}),()=>{const page=troopEditor.currentTroop.pages[troopEditor.currentBattlePageIndex];if(!page)return;page.list.splice(Math.max(0,page.list.length-1),0,{code:357,indent:0,parameters:['RPGReactor','BattleRoomEvent','Call Battle Room Event',{eventId:String(event.id)}]});troopEditor.persistTroop();const list=document.getElementById('battle-command-list');if(list)troopEditor.renderCommandList(list,page);}));
            }}).catch(error=>details.append(this.element('p','rr-battle-help',error.message)));
            details.append(this.element('p','rr-battle-help','Troop events and the battle HUD remain part of this battle. Room positions are separate from battleback positions.'));
        };draw();return panel;
    }
    async readMap(id) {
        if(!id)return null;const fs=require('fs'),path=require('path'),dir=path.join(this.parent.currentProject.path,'data');
        const map=RRJson.parse(fs.readFileSync(path.join(dir,'Map'+String(id).padStart(3,'0')+'.json')));map.id=id;
        const file=path.join(dir,'Map'+String(id).padStart(3,'0')+'.r3d.json');map.reactor3d=fs.existsSync(file)?RRJson.parse(fs.readFileSync(file)):{};return map;
    }
    async assets() {
        const pc=window.reactor.projectController;await pc.mapEditor3D.ensureLibraries();
        if (!window.ReactorBattleRoomView) {
            const host=window.RPGReactorWebHost;
            if(host?.mode==='web')await pc.mapEditor3D.injectScriptUrl(host.assetUrl(host.projectRoot+'/js/reactor_battle_room.js'),'reactor_battle_room.js');
            else {const file=require('path').join(window.reactor.projectManager.getRuntimePath(),'reactor_battle_room.js');await pc.mapEditor3D.injectScript(require('fs').readFileSync(file,'utf8'),file);}
        }
        const project=this.parent.currentProject,editor=this.parent.reactor3dEditor,fs=require('fs'),path=require('path');
        editor.projectController={getCurrentProject:()=>project,mapEditor3D:pc.mapEditor3D};
        return {
            tileSize:this.db.getSystem()?.tileSize||48,screenHeight:this.db.getSystem()?.advanced?.screenHeight||624,
            muteMedia:true,mediaUrl:file=>{const image=/\.(png|jpe?g|webp)$/i.test(file),absolute=path.join(project.path,image?'img/pictures':'movies',file);return fs.existsSync(absolute)?RRAssetFiles.toUrl(absolute):'';},
            animation:id=>this.db.data.animations[id],effectUrl:name=>'file://'+path.join(project.path,'effects',name+'.efkefc'),
            image:(kind,name)=>new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve({image:img,width:img.naturalWidth,height:img.naturalHeight,isReady:()=>true,addLoadListener:fn=>fn()});img.onerror=()=>reject(Error('Missing '+kind+'/'+name));img.src=RRAssetFiles.imageUrlFor(path.join(project.path,'img',kind),name);}),
            model:async spec=>{
                const template=await editor._loadTemplate({name:spec.name,ext:spec.ext,file:spec.file,texture:spec.texture});
                const file=path.join(project.path,'3d',spec.name,'model.json');
                return {template,sidecar:fs.existsSync(file)?RRJson.parse(fs.readFileSync(file)):{}};
            },warn:console.warn
        };
    }
    async loadRoomCast(view,draft,troopEditor,assets) {
        const project=this.parent.currentProject;
        const cast=[];
        for(const side of ['actors','enemies'])for(let i=0;i<(side==='actors'?this.db.getMaxBattleMembers():troopEditor.currentTroop.members.length);i++){
            if(view.disposed||this.parent.currentProject!==project)return cast;
            const id=side==='actors'?this.db.getSystem()?.partyMembers?.[i]:troopEditor.currentTroop.members[i]?.enemyId;
            const item=side==='actors'?this.db.getActor(id):this.db.getEnemy(id);if(!item)continue;
            const spec=RRDatabase3DBindings.get(project.path,side,id,side==='actors'?'battler':undefined),key='cast:'+side+':'+i;
            if(spec){await view.addModel(key,spec,ReactorBattleData.position(draft,side,i));cast.push({key,side,index:i});}
            else if(item.battlerName){try{const bitmap=await assets.image(side==='actors'?'sv_actors':'enemies',item.battlerName),frame={x:0,y:0,width:bitmap.width/(side==='actors'?9:1),height:bitmap.height/(side==='actors'?6:1)};cast.push({key,side,index:i,bitmap,frame});}catch(error){console.warn(error);}}
        }
        return cast;
    }
    drawRoomCast(view,settings,cast) {
        for(const item of cast){
            const p=ReactorBattleData.position(settings,item.side,item.index);
            if(item.bitmap)view.billboard(item.key,item.bitmap.image,item.frame,{...p,flipX:item.side==='actors'?p.facing>0:p.facing<0},Math.max(.5,item.frame.height/48));
            else view.place(item.key,p);
        }
    }
    async previewTroop(troopEditor) {
        troopEditor._roomPreviewCleanup?.();
        const canvas=troopEditor.canvas,ctx=troopEditor.ctx,project=this.parent.currentProject;
        const config=this.settings().troops[troopEditor.currentTroopId];
        let signature=JSON.stringify([config,troopEditor.currentTroop.members]);
        let view,raf=0,disposed=false,stopPlacement=()=>{};
        const cleanup=()=>{disposed=true;stopPlacement();cancelAnimationFrame(raf);view?.dispose();this.views.delete(cleanup);
            if(troopEditor._roomPreviewCleanup===cleanup){troopEditor._roomPreviewCleanup=null;troopEditor._roomPreviewActive=false;troopEditor._renderRoomPreview=null;troopEditor._roomPreviewView=null;}};
        troopEditor._roomPreviewCleanup=cleanup;troopEditor._roomPreviewActive=true;this.views.add(cleanup);
        troopEditor.enemySpriteBounds=[];
        const current=()=>!disposed&&canvas.isConnected&&this.parent.currentProject===project;
        const message=text=>{ctx.fillStyle='#171a21';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#ddd';ctx.font='18px sans-serif';ctx.fillText(this.text(text),20,32);};
        message('Loading…');
        troopEditor._renderRoomPreview=()=>{
            if(current()&&signature!==JSON.stringify([this.settings().troops[troopEditor.currentTroopId],troopEditor.currentTroop.members]))troopEditor.loadAndRenderCanvas();
        };
        try{
            if(!config?.mapId){message('Choose a Battle Room map.');return;}
            const map=await this.readMap(config.mapId),assets=await this.assets();if(!current())return;
            const settings=JSON.parse(JSON.stringify(config));
            view=new ReactorBattleRoomView(map,this.db.getTileset(map.tilesetId),settings,assets);await view.build();if(!current()){view.dispose();return;}
            const cast=await this.loadRoomCast(view,settings,troopEditor,assets);if(!current()){view.dispose();return;}
            troopEditor._roomPreviewView=view;view.resize(canvas.width,canvas.height);
            let drag=null;
            const pointer=e=>{const r=canvas.getBoundingClientRect();return {x:(e.clientX-r.left)*view.width/r.width,y:(e.clientY-r.top)*view.height/r.height};};
            const down=e=>{
                if(e.button!==0||!current())return;
                const at=pointer(e);let selected=null,distance=Infinity;
                for(let i=0;i<troopEditor.currentTroop.members.length;i++){
                    const p=view.project(ReactorBattleData.position(settings,'enemies',i)),bounds=view.bounds('cast:enemies:'+i),d=Math.hypot(at.x-p.x,at.y-p.y);
                    if((d<18*view.width/canvas.clientWidth||bounds&&at.x>=bounds.x&&at.x<=bounds.x+bounds.width&&at.y>=bounds.y&&at.y<=bounds.y+bounds.height)&&d<distance){selected=i;distance=d;}
                }
                if(selected===null)return;e.preventDefault();canvas.focus({preventScroll:true});
                const start=ReactorBattleData.position(settings,'enemies',selected),hit=view.pick(at.x,at.y,start.z||0);if(!hit)return;
                drag={index:selected,start,hit,changed:false};view.cameraFollowFrozen=true;canvas.setPointerCapture(e.pointerId);canvas.style.cursor='grabbing';troopEditor.selectedMemberIndex=selected;troopEditor.highlightMemberRow(selected);
            };
            const move=e=>{
                if(!drag)return;const at=pointer(e),hit=view.pick(at.x,at.y,drag.start.z||0);if(!hit)return;
                const p={...drag.start,x:Math.round((drag.start.x+hit.x-drag.hit.x)*100)/100,y:Math.round((drag.start.y+hit.y-drag.hit.y)*100)/100};
                settings.enemies[drag.index]=p;drag.changed=true;
            };
            const up=e=>{if(!drag)return;const held=drag;drag=null;view.cameraFollowFrozen=false;view.cameraFollowResume=true;canvas.style.cursor='';
                if(e.type==='pointercancel')settings.enemies[held.index]=held.start;
                else if(held.changed){config.enemies||=[];config.enemies[held.index]={...settings.enemies[held.index]};signature=JSON.stringify([config,troopEditor.currentTroop.members]);this.changed();}
                if(e.pointerId!==undefined&&canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);
            };
            for(const [type,fn] of [['pointerdown',down],['pointermove',move],['pointerup',up],['pointercancel',up],['lostpointercapture',up]])canvas.addEventListener(type,fn);
            stopPlacement=()=>{for(const [type,fn] of [['pointerdown',down],['pointermove',move],['pointerup',up],['pointercancel',up],['lostpointercapture',up]])canvas.removeEventListener(type,fn);canvas.style.cursor='';};
            const draw=()=>{if(!current()){cleanup();return;}
                // The setup dialog owns the visible renderer while open.
                if(!document.querySelector('.rr-battle-room-modal')){
                    this.drawRoomCast(view,settings,cast);
                    for(const item of cast)if(item.side==='enemies'){const record=view.models.get(item.key)||view.billboards.get(item.key);if(record?.object)record.object.visible=!troopEditor.currentTroop.members[item.index]?.hidden;}
                    view.render();ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(view.renderer.domElement,0,0,canvas.width,canvas.height);
                    for(let i=0;i<troopEditor.currentTroop.members.length;i++){
                        const p=view.project(ReactorBattleData.position(settings,'enemies',i));if(!p.visible)continue;
                        const scale=canvas.width/Math.max(1,canvas.clientWidth);ctx.fillStyle=i===troopEditor.selectedMemberIndex?'#ffcc33':'#ff6680';ctx.beginPath();ctx.arc(p.x,p.y,5*scale,0,Math.PI*2);ctx.fill();ctx.font=(12*scale)+'px sans-serif';ctx.fillText('E'+(i+1),p.x+9*scale,p.y+4*scale);
                    }
                    if(troopEditor.showBattleUI){const setup=troopEditor.battleUISetup||troopEditor.refreshBattleUISetup();if(setup)troopEditor.drawBattleUIOverlay(ctx,setup);}
                }
                raf=requestAnimationFrame(draw);
            };draw();
        }catch(error){view?.dispose();if(current())message('Room preview: '+error.message);}
    }
    cameraNavigation(view,changed) {
        // Reuse the map editor's orbit, pan, zoom and timed flight conventions.
        const navigation={camera:view.camera,flyKeys:new Set(),flyFast:false,flying(){return this.flyKeys.size>0;}};
        navigation.begin=()=>{
            if(view.settings.cameraSource!=='custom')return false;
            const camera=view.camera,forward=camera.getWorldDirection(new THREE.Vector3());
            const distance=view.effectiveCamera?.distance||8;
            const focus=camera.position.clone().addScaledVector(forward,distance);
            navigation.view={target:{x:focus.x-.5,y:focus.y,z:focus.z-.5},distance,
                yaw:Math.atan2(forward.x,-forward.z)*180/Math.PI,pitch:Math.asin(-forward.y)*180/Math.PI};
            view.cameraFollowFrozen=false;view.cameraFollowResume=false;
            return true;
        };
        navigation.applyCamera=()=>{
            const c=navigation.view;
            Object.assign(view.settings.camera,{mode:view.settings.camera.mode==='cinematic'?'cinematic':'fixed',x:c.target.x,y:c.target.z,z:c.target.y,yaw:c.yaw,pitch:c.pitch,distance:c.distance,fov:view.camera.fov||view.effectiveCamera.fov});
            view.aim();changed();
        };
        for(const name of ['orbit','pan','zoom','stepFly'])navigation[name]=(...args)=>MapEditor3D.prototype[name].apply(navigation,args);
        return navigation;
    }
    async roomDialog(config,troopEditor) {
        const draft=JSON.parse(JSON.stringify(config)),{panel,body}=this.section('Battle Room Setup');
        const modal=this.element('div','rr-battle-room-modal');panel.classList.add('rr-battle-room-dialog');modal.append(panel);document.body.append(modal);
        const workspace=this.element('div','rr-battle-workspace'),stage=this.element('div','rr-battle-stage'),inspector=this.element('div','rr-battle-inspector');workspace.append(stage,inspector);body.append(workspace);
        const message=this.element('p','','Loading…');stage.append(message);
        let view,raf=0,stopNavigation=()=>{},refreshLanguage=()=>{},selected={side:'actors',index:0},dragging=false;
        const cleanup=()=>{cancelAnimationFrame(raf);stopNavigation();window.removeEventListener('rr-language-changed',refreshLanguage);view?.dispose();modal.remove();this.views.delete(cleanup);};this.views.add(cleanup);
        const footer=this.element('div','rr-battle-toolbar');footer.append(this.button('Cancel',cleanup),this.button('Apply',()=>{Object.assign(config,draft);this.changed();cleanup();troopEditor.loadAndRenderCanvas?.();}));body.append(footer);
        try{
            const map=await this.readMap(config.mapId),assets=await this.assets();if(!modal.isConnected)return;
            view=new ReactorBattleRoomView(map,this.db.getTileset(map.tilesetId),draft,assets);await view.build();if(!modal.isConnected){view.dispose();return;}
            stage.replaceChildren(view.renderer.domElement);const overlay=this.element('canvas','rr-battle-markers');stage.append(overlay);overlay.tabIndex=0;
            const navigationHint=this.element('div','rr-battle-navigation-hint');stage.append(navigationHint);
            const actorCount=this.db.getMaxBattleMembers();
            const count=side=>side==='actors'?actorCount:troopEditor.currentTroop.members.length;
            // Camera navigation changes framing, never the implied formation.
            const materializeFormation=()=>{for(const side of ['actors','enemies'])for(let i=0;i<count(side);i++){
                draft[side]||=[];draft[side][i]||=ReactorBattleData.position(draft,side,i);
            }};
            materializeFormation();
            const position=()=>{draft[selected.side]||=[];return draft[selected.side][selected.index]||=ReactorBattleData.position(draft,selected.side,selected.index);};
            const cast=await this.loadRoomCast(view,draft,troopEditor,assets);
            if(!modal.isConnected){view.dispose();return;}
            const drawInspector=()=>{
                this.setText(navigationHint,draft.cameraSource==='custom'?'Drag empty space to orbit · Ctrl-drag to orbit over markers · Shift or right-drag to pan · Scroll to zoom · WASD move · Q/E height':'Use Map Camera · Choose Override for This Troop to navigate the camera');
                inspector.replaceChildren();this.field(inspector,'Selection',this.select([...Array(count('actors'))].map((_,i)=>['actors:'+i,this.message('Party Slot {n}',{n:i+1})]).concat([...Array(count('enemies'))].map((_,i)=>['enemies:'+i,this.message('Enemy {n}',{n:i+1})])),selected.side+':'+selected.index,value=>{const [side,index]=value.split(':');selected={side,index:Number(index)};drawInspector();}));
                for(const key of ['x','y','z','facing'])this.number(inspector,key==='facing'?'Facing':key.toUpperCase(),position()[key],value=>position()[key]=value,key==='facing'?1:.1);
                inspector.append(this.element('h4','','Camera'));
                this.field(inspector,'Camera Settings',this.select([['map','Use Map Camera'],['custom','Override for This Troop']],draft.cameraSource||'custom',value=>{if(value==='custom')Object.assign(draft.camera,view.effectiveCamera||view.cameraState(),{mode:'fixed'});draft.cameraSource=value;drawInspector();}));
                const effective=view.cameraState();
                if(draft.cameraSource==='map')inspector.append(this.element('p','rr-battle-help',this.message('Map camera: {mode}. Third/first person follows party slot 1.',{mode:this.text(this.cameraLabel(effective.mode))})));
                else this.field(inspector,'Mode',this.select([...Object.keys(Reactor3D.Camera.MODES).map(m=>[m,this.cameraLabel(m)]),['cinematic','Cinematic Cuts']],draft.camera.mode||'fixed',mode=>{const defaults=Reactor3D.Camera.MODES[mode]||{yaw:45,pitch:35,fov:40,distance:24};Object.assign(draft.camera,{mode,yaw:defaults.yaw,pitch:defaults.pitch,fov:defaults.fov,distance:defaults.distance||24});drawInspector();}));
                if(draft.cameraSource==='custom'&&draft.camera.mode==='cinematic')inspector.append(this.element('p','rr-battle-help','Sweeps toward the acting battler, then the target at impact. Eases back to this overview after the action.'));
                for(const key of ['x','y','z','yaw','pitch','distance','fov']){
                    const input=this.number(inspector,({yaw:'Yaw',pitch:'Pitch',distance:'Distance',fov:'Field of View'})[key]||key.toUpperCase(),draft.cameraSource==='map'?effective[key]:draft.camera[key]??effective[key],value=>draft.camera[key]=key==='distance'?Math.max(.5,value):key==='fov'?Math.max(5,Math.min(150,value)):key==='pitch'?Math.max(-89,Math.min(89,value)):value);
                    input.dataset.cameraField=key;input.disabled=draft.cameraSource==='map'&&['yaw','pitch','distance','fov'].includes(key);
                }
                inspector.append(this.button('Reset Formation',()=>{draft.actors=[];draft.enemies=[];materializeFormation();drawInspector();}));
                inspector.append(this.element('p','rr-battle-help','Drag a marker to place it. Z sets height; camera controls change the view.'));
            };drawInspector();refreshLanguage=drawInspector;window.addEventListener('rr-language-changed',refreshLanguage);
            const syncCameraFields=()=>{
                const mode=[...inspector.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.value==='fixed'));
                if(mode)mode.value=draft.camera.mode;
                for(const input of inspector.querySelectorAll('[data-camera-field]'))if(document.activeElement!==input)input.value=Math.round(draft.camera[input.dataset.cameraField]*1000)/1000;
            };
            const navigation=this.cameraNavigation(view,syncCameraFields);
            let cameraDrag=null;
            const stopFly=()=>{navigation.flyKeys.clear();navigation._flewAt=null;};
            window.addEventListener('blur',stopFly);overlay.onblur=stopFly;
            stopNavigation=()=>{stopFly();window.removeEventListener('blur',stopFly);};
            overlay.onkeydown=e=>{
                const key=MapEditor3D.FLY_KEYS()[e.key.toLowerCase()];
                if(!key||e.ctrlKey||e.altKey||e.metaKey||draft.cameraSource!=='custom'||dragging)return;
                e.preventDefault();e.stopPropagation();
                if(!navigation.flying()){if(!navigation.begin())return;navigation._flewAt=null;}
                navigation.flyKeys.add(key);navigation.flyFast=e.shiftKey;
            };
            overlay.onkeyup=e=>{const key=MapEditor3D.FLY_KEYS()[e.key.toLowerCase()];if(key){e.preventDefault();e.stopPropagation();navigation.flyKeys.delete(key);}navigation.flyFast=e.shiftKey;};
            overlay.oncontextmenu=e=>e.preventDefault();
            overlay.onwheel=e=>{e.preventDefault();e.stopPropagation();if(!dragging&&navigation.begin())navigation.zoom(e.deltaY);};
            overlay.onpointerdown=e=>{
                if(![0,1,2].includes(e.button))return;
                overlay.focus({preventScroll:true});stopFly();
                const rect=overlay.getBoundingClientRect(),x=(e.clientX-rect.left)*view.width/rect.width,y=(e.clientY-rect.top)*view.height/rect.height;
                let nearest=null,dist=20;
                if(e.button===0&&!e.ctrlKey&&!e.shiftKey)for(const side of ['actors','enemies'])for(let i=0;i<count(side);i++){
                    const p=view.project(ReactorBattleData.position(draft,side,i)),d=Math.hypot(p.x-x,p.y-y);if(d<dist){dist=d;nearest={side,index:i};}
                }
                if(nearest){selected=nearest;dragging=true;view.cameraFollowFrozen=true;drawInspector();}
                else if(navigation.begin())cameraDrag={x:e.clientX,y:e.clientY,pan:e.button!==0||e.shiftKey};
                else return;
                e.preventDefault();e.stopPropagation();overlay.setPointerCapture(e.pointerId);
            };
            overlay.onpointermove=e=>{
                if(cameraDrag){const dx=e.clientX-cameraDrag.x,dy=e.clientY-cameraDrag.y;cameraDrag.x=e.clientX;cameraDrag.y=e.clientY;navigation[cameraDrag.pan?'pan':'orbit'](dx,dy);return;}
                if(navigation.flying()){navigation.orbit(e.movementX,e.movementY);return;}
                if(!dragging)return;
                const r=overlay.getBoundingClientRect(),p=view.pick((e.clientX-r.left)*view.width/r.width,(e.clientY-r.top)*view.height/r.height);
                if(p)Object.assign(position(),{x:Math.round(p.x*10)/10,y:Math.round(p.y*10)/10});
            };
            const endDrag=()=>{cameraDrag=null;if(!dragging)return;dragging=false;view.cameraFollowFrozen=false;view.cameraFollowResume=true;drawInspector();};
            overlay.onpointerup=endDrag;overlay.onpointercancel=endDrag;overlay.onlostpointercapture=endDrag;
            const draw=(now=performance.now())=>{if(!modal.isConnected){cleanup();return;}
                const width=Math.max(1,stage.clientWidth),height=Math.max(1,stage.clientHeight);
                if(view.width!==width||view.height!==height){view.resize(width,height);overlay.width=width;overlay.height=height;}
                navigation.stepFly(now);this.drawRoomCast(view,draft,cast);view.render();const ctx=overlay.getContext('2d');ctx.clearRect(0,0,width,height);
                for(const side of ['actors','enemies'])for(let i=0;i<count(side);i++){const p=view.project(ReactorBattleData.position(draft,side,i));ctx.fillStyle=side==='actors'?'#55aaff':'#ff6677';ctx.beginPath();ctx.arc(p.x,p.y,selected.side===side&&selected.index===i?10:7,0,Math.PI*2);ctx.fill();ctx.fillStyle='#fff';ctx.font='12px sans-serif';ctx.fillText((side==='actors'?'A':'E')+(i+1),p.x+12,p.y+4);}raf=requestAnimationFrame(draw);};draw();
        }catch(error){message.textContent=String(error.message||error);stage.replaceChildren(message);}
    }
    dispose() { for(const cleanup of [...this.views])cleanup(); }
}
