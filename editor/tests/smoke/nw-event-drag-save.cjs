const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {WebDriverClient}=require('./webdriver-client.cjs');
const root=path.resolve(__dirname,'../../..'),source=path.join(root,'template/Demo'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'rr-event-commit-')),project=path.join(temp,'Demo');let driver;
(async()=>{try{
 fs.mkdirSync(project);for(const n of ['data','js','icon'])fs.cpSync(path.join(source,n),path.join(project,n),{recursive:true});for(const n of ['img','3d','effects','audio','fonts','movies','css'])if(fs.existsSync(path.join(source,n)))fs.symlinkSync(path.join(source,n),path.join(project,n));for(const n of ['index.html','package.json','project.rpgreactor'])fs.copyFileSync(path.join(source,n),path.join(project,n));
 driver=new WebDriverClient(path.join(root,'nwjs-linux/chromedriver'));await driver.start();await driver.createSession({browserName:'chrome','goog:chromeOptions':{args:[`nwapp=${path.join(root,'editor')}`,`user-data-dir=${temp}/profile`,'no-first-run']}});await driver.setScriptTimeout(90000);
 await driver.waitForScript('return !!window.reactor?.projectController && getComputedStyle(document.getElementById("splash-screen")).display==="none";',[],{timeout:90000});
 assert.equal(await driver.executeAsync(`const done=arguments[arguments.length-1];(async()=>{const pc=reactor.projectController;pc.currentProject=await reactor.projectManager.loadProject(arguments[0]);pc.projectLoaded=true;nw.Window.get().resizeTo(1920,1080);await reactor.uiManager.showEditorUI();await pc.populateProjectUI();await reactor.applyMap3DViewPreference(true);return true;})().then(done,e=>done(String(e.stack)));`,[project]),true);
 await driver.waitForScript('return !!reactor.projectController.mapEditor3D?.mapScene;',[],{timeout:90000});



 // Leave a closed inspector holding the old height, then drag and use the
 // application's Save command (not TilemapManager.saveMap directly).
 await driver.execute(`const m=reactor.eventManager;m.setEventMode(true);m.setEventPreview(m.currentMap.events[2],0);m.editEvent(m.currentMap.events[2]);document.getElementById('event-position-z').value='20';document.getElementById('event-editor-ok-btn').click();`);
 await driver.waitForScript(`return !!reactor.mapEditor3D.eventGroup?.children.find(c=>c.userData?.event?.id===2&&c.userData.modelPreview);`,[],{timeout:30000});
 const lowered=await driver.execute(`const v=reactor.mapEditor3D,mesh=v.eventGroup.children.find(c=>c.userData?.event?.id===2);v.beginEventDrag();v.dragEventAlongAxis({mesh,grab:{axis:'y',travel:()=>-20},startZ:20},0,0);v.finishEventDrag();return {z:Reactor3D.eventZAt(v.currentMap(),2),stale:reactor.eventManager.eventEditor.pendingZ};`);
 assert.equal(lowered.z,0);assert.equal(lowered.stale,20);
 assert.equal(await driver.executeAsync(`const done=arguments[arguments.length-1];reactor.projectController.saveProject().then(done,e=>done(String(e.stack)));`),true);
 const saved=JSON.parse(fs.readFileSync(path.join(project,'data/Map001.r3d.json'),'utf8'));
 assert.equal(saved.eventZ?.[2]||0,0,'Save must not restore the closed inspector height');
 console.log('Save Project preserves arrow-dragged ground placement despite stale inspector.');
 await driver.close();driver=null;
 driver=new WebDriverClient(path.join(root,'nwjs-linux/chromedriver'));await driver.start();await driver.createSession({browserName:'chrome','goog:chromeOptions':{args:[`nwapp=${path.join(root,'editor')}`,`user-data-dir=${temp}/reopened-profile`,'no-first-run']}});await driver.setScriptTimeout(90000);
 await driver.waitForScript('return !!window.reactor?.projectController && getComputedStyle(document.getElementById("splash-screen")).display==="none";',[],{timeout:90000});
 assert.equal(await driver.executeAsync(`const done=arguments[arguments.length-1];(async()=>{const pc=reactor.projectController;pc.currentProject=await reactor.projectManager.loadProject(arguments[0]);pc.projectLoaded=true;await reactor.uiManager.showEditorUI();await pc.populateProjectUI();await reactor.applyMap3DViewPreference(true);return Reactor3D.eventZAt(pc.tilemapManager.currentMap,2);})().then(done,e=>done(String(e.stack)));`,[project]),0);
 await driver.waitForScript(`const v=reactor.mapEditor3D,o=v.eventGroup?.children.find(c=>c.userData?.event?.id===2&&c.userData.modelPreview);return o&&Math.abs(o.position.y-Reactor3D.elevationAt(v.currentMap(),24,0))<0.001;`,[],{timeout:30000});
 console.log('Fresh editor process reopens the door on the ground.');
 await driver.close();driver=null;
 driver=new WebDriverClient(path.join(root,'nwjs-linux/chromedriver'));await driver.start();await driver.createSession({browserName:'chrome','goog:chromeOptions':{args:[`nwapp=${project}`,`user-data-dir=${temp}/game-profile`,'no-first-run']}});await driver.setScriptTimeout(90000);
 await driver.waitForScript('return !!window.DataManager&&DataManager.isDatabaseLoaded()&&["Scene_Title","Scene_ReactorUI"].includes(SceneManager._scene?.constructor?.name);',[],{timeout:90000});
 await driver.execute(`window.__eventErrors=[];addEventListener('error',e=>__eventErrors.push(String(e.error||e.message)));DataManager.setupNewGame();$gamePlayer.reserveTransfer(1,24,3,2,0);SceneManager.goto(Scene_Map);`);
 await driver.waitForScript(`const scene=SceneManager._scene?._spriteset?._reactor3d?.scene;return !!scene?._modelInstances&&[...scene._modelInstances.values()].some(h=>h.character?.eventId?.()===2&&h.object&&Math.abs(h.object.position.y-(Reactor3D.elevationAt($dataMap,24,0)+0))<0.001);`,[],{timeout:90000});
 const runtime=await driver.execute(`const scene=SceneManager._scene._spriteset._reactor3d.scene,holder=[...scene._modelInstances.values()].find(h=>h.character?.eventId?.()===2);return {map:$gameMap.mapId(),lift:$gameMap.event(2)._reactorLift ?? 0,position:holder.object.position.toArray(),errors:__eventErrors};`);
 assert.equal(runtime.lift,0);assert.deepEqual(runtime.errors,[]);console.log('Runtime door at saved elevation:',runtime);
}finally{await driver?.close();fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
