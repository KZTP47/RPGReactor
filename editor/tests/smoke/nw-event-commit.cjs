const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {WebDriverClient}=require('./webdriver-client.cjs');
const root=path.resolve(__dirname,'../../..'),source=path.join(root,'template/Demo'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'rr-event-commit-')),project=path.join(temp,'Demo');let driver;
(async()=>{try{
 fs.mkdirSync(project);for(const n of ['data','js','icon'])fs.cpSync(path.join(source,n),path.join(project,n),{recursive:true});for(const n of ['img','3d','effects','audio','fonts','movies','css'])if(fs.existsSync(path.join(source,n)))fs.symlinkSync(path.join(source,n),path.join(project,n));for(const n of ['index.html','package.json','project.rpgreactor'])fs.copyFileSync(path.join(source,n),path.join(project,n));
 driver=new WebDriverClient(path.join(root,'nwjs-linux/chromedriver'));await driver.start();await driver.createSession({browserName:'chrome','goog:chromeOptions':{args:[`nwapp=${path.join(root,'editor')}`,`user-data-dir=${temp}/profile`,'no-first-run']}});await driver.setScriptTimeout(90000);
 await driver.waitForScript('return !!window.reactor?.projectController && getComputedStyle(document.getElementById("splash-screen")).display==="none";',[],{timeout:90000});
 assert.equal(await driver.executeAsync(`const done=arguments[arguments.length-1];(async()=>{const pc=reactor.projectController;pc.currentProject=await reactor.projectManager.loadProject(arguments[0]);pc.projectLoaded=true;nw.Window.get().resizeTo(1920,1080);await reactor.uiManager.showEditorUI();await pc.populateProjectUI();await reactor.applyMap3DViewPreference(true);return true;})().then(done,e=>done(String(e.stack)));`,[project]),true);
 await driver.waitForScript('return !!reactor.projectController.mapEditor3D?.mapScene;',[],{timeout:90000});



 const loadMap=async id=>{assert.equal(await driver.executeAsync(`const done=arguments[arguments.length-1];reactor.projectController.loadMap(arguments[0]).then(done,e=>done(String(e)));`,[id]),true);await driver.waitForScript('return reactor.mapEditor3D.currentMap()?.id===arguments[0]&&!!reactor.mapEditor3D.eventGroup;', [id], {timeout:30000});};
 await loadMap(2);
 const originalCount=await driver.execute('return reactor.eventManager.currentMap.events.filter(Boolean).length;');
 const plain=await driver.execute(`const m=reactor.eventManager;m.setEventMode(true);const e=m.createNewEvent(4,4);document.getElementById('event-editor-ok-btn').click();return {id:e.id,exists:!!m.currentMap.events[e.id],visible:document.getElementById('event-editor-modal').style.display};`);
 assert.equal(plain.exists,true);assert.equal(plain.visible,'none');
 const apply=await driver.execute(`const m=reactor.eventManager,e=m.createNewEvent(5,4);document.getElementById('event-editor-apply-btn').click();const visible=document.getElementById('event-editor-modal').style.display;document.getElementById('event-editor-ok-btn').click();return {visible,count:m.currentMap.events.filter(Boolean).length,save:reactor.tilemapManager.saveMap()};`);
 assert.equal(apply.visible,'flex');assert.equal(apply.count,originalCount+2);assert.equal(apply.save,true);
 console.log('Static Room: untouched OK and Apply then OK each insert once and save.');
 await loadMap(1);
 const model=await driver.execute(`const m=reactor.eventManager,e=m.createNewEvent(25,2);m.eventEditor.pendingModels[0]={name:'Map-Objects/Door-01',file:'Door-01',ext:'.glb',size:3,scale:1,yaw:0,pitch:0,roll:0};document.getElementById('event-editor-ok-btn').click();return {id:e.id,exists:!!m.currentMap.events[e.id],spec:Reactor3D.eventModelSpec(m.currentMap,e.id,0)};`);
 assert.equal(model.exists,true);assert.equal(model.spec.name,'Map-Objects/Door-01');
 // First store 20 in the editor, then lower with the map arrow, reopen and cancel.
 await driver.execute(`const m=reactor.eventManager;m.setEventPreview(m.currentMap.events[2],0);m.editEvent(m.currentMap.events[2]);document.getElementById('event-position-z').value='20';document.getElementById('event-editor-ok-btn').click();`);
 await driver.waitForScript(`return !!reactor.mapEditor3D.eventGroup?.children.find(c=>c.userData?.event?.id===2&&c.userData.modelPreview);`,[],{timeout:30000});
 assert.equal(await driver.execute(`const v=reactor.mapEditor3D,mesh=v.eventGroup.children.find(c=>c.userData?.event?.id===2);v.beginEventDrag();v.dragEventAlongAxis({mesh,grab:{axis:'y',travel:()=>-19.5},startZ:20},0,0);v.finishEventDrag();return Reactor3D.eventZAt(v.currentMap(),2);`),0.5);
 await driver.execute(`const m=reactor.eventManager;m.editEvent(m.currentMap.events[2]);document.getElementById('event-editor-cancel-btn').click();`);
 assert.equal(await driver.execute('return Reactor3D.eventZAt(reactor.eventManager.currentMap,2);'),0.5);
 // Z-only OK refreshes the live preview, without relying on another map edit.
 await driver.execute(`const m=reactor.eventManager;m.editEvent(m.currentMap.events[2]);document.getElementById('event-position-z').value='0.75';document.getElementById('event-editor-ok-btn').click();`);
 const previewY=()=>`const v=reactor.mapEditor3D,o=v.eventGroup?.children.find(c=>c.userData?.event?.id===2&&c.userData.modelPreview);return o&&Math.abs(o.position.y-(Reactor3D.elevationAt(v.currentMap(),24,0)+0.75))<0.001;`;
 await driver.waitForScript(previewY(),[],{timeout:30000});
 assert.equal(await driver.execute('return reactor.tilemapManager.saveMap();'),true);
 assert.equal(JSON.parse(fs.readFileSync(path.join(project,'data/Map001.r3d.json'),'utf8')).eventZ[2],0.75);
 await loadMap(2);await loadMap(1);await driver.waitForScript(previewY(),[],{timeout:30000});
 assert.equal(await driver.execute('return Reactor3D.eventZAt(reactor.eventManager.currentMap,2);'),0.75);
 const logs=await driver.sessionRequest('POST','/log',{type:'browser'});assert.deepEqual(logs.filter(e=>/does not belong|GL_INVALID|TypeError/.test(e.message)),[]);
 console.log('Door: arrow move survives Cancel; Z-only OK refreshes, saves and reloads at 0.75.');
 await driver.close();driver=null;
 driver=new WebDriverClient(path.join(root,'nwjs-linux/chromedriver'));await driver.start();await driver.createSession({browserName:'chrome','goog:chromeOptions':{args:[`nwapp=${project}`,`user-data-dir=${temp}/game-profile`,'no-first-run']}});await driver.setScriptTimeout(90000);
 await driver.waitForScript('return !!window.DataManager&&DataManager.isDatabaseLoaded()&&["Scene_Title","Scene_ReactorUI"].includes(SceneManager._scene?.constructor?.name);',[],{timeout:90000});
 await driver.execute(`window.__eventErrors=[];addEventListener('error',e=>__eventErrors.push(String(e.error||e.message)));DataManager.setupNewGame();$gamePlayer.reserveTransfer(1,24,3,2,0);SceneManager.goto(Scene_Map);`);
 await driver.waitForScript(`const scene=SceneManager._scene?._spriteset?._reactor3d?.scene;return !!scene?._modelInstances&&[...scene._modelInstances.values()].some(h=>h.character?.eventId?.()===2&&h.object&&Math.abs(h.object.position.y-(Reactor3D.elevationAt($dataMap,24,0)+0.75))<0.001);`,[],{timeout:90000});
 const runtime=await driver.execute(`const scene=SceneManager._scene._spriteset._reactor3d.scene,holder=[...scene._modelInstances.values()].find(h=>h.character?.eventId?.()===2);return {map:$gameMap.mapId(),lift:$gameMap.event(2)._reactorLift,position:holder.object.position.toArray(),errors:__eventErrors};`);
 assert.equal(runtime.lift,0.75);assert.deepEqual(runtime.errors,[]);console.log('Runtime door at saved elevation:',runtime);
}finally{await driver?.close();fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
