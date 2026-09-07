const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {WebDriverClient}=require('./webdriver-client.cjs');
const root=path.resolve(__dirname,'../../..'),source=path.join(root,'template/Demo'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'rr-ux-locale-')),project=path.join(temp,'Demo');let driver;
(async()=>{try{
 fs.mkdirSync(project);for(const n of ['data','js','icon'])fs.cpSync(path.join(source,n),path.join(project,n),{recursive:true});for(const n of ['3d','effects','audio','fonts','movies','css'])if(fs.existsSync(path.join(source,n)))fs.symlinkSync(path.join(source,n),path.join(project,n));for(const n of ['index.html','package.json','project.rpgreactor'])fs.copyFileSync(path.join(source,n),path.join(project,n));
 fs.mkdirSync(path.join(project,'img'));for(const n of fs.readdirSync(path.join(source,'img')))if(n!=='pictures')fs.symlinkSync(path.join(source,'img',n),path.join(project,'img',n));fs.mkdirSync(path.join(project,'img/pictures'));for(const n of fs.readdirSync(path.join(source,'img/pictures')))fs.symlinkSync(path.join(source,'img/pictures',n),path.join(project,'img/pictures',n));
 driver=new WebDriverClient(path.join(root,'nwjs-linux/chromedriver'));await driver.start();await driver.createSession({browserName:'chrome','goog:chromeOptions':{args:[`nwapp=${path.join(root,'editor')}`,`user-data-dir=${temp}/profile`,'no-first-run']}});await driver.setScriptTimeout(90000);
 await driver.waitForScript('return !!window.reactor?.projectController && getComputedStyle(document.getElementById("splash-screen")).display==="none";',[],{timeout:90000});
 assert.equal(await driver.executeAsync(`const done=arguments[arguments.length-1];(async()=>{const pc=reactor.projectController;pc.currentProject=await reactor.projectManager.loadProject(arguments[0]);pc.projectLoaded=true;nw.Window.get().resizeTo(1920,1080);await reactor.uiManager.showEditorUI();await pc.populateProjectUI();await reactor.applyMap3DViewPreference(true);return true;})().then(done,e=>done(String(e.stack)));`,[project]),true);
 await driver.waitForScript('return !!reactor.projectController.mapEditor3D?.mapScene;',[],{timeout:90000});






 await driver.execute(`window.__ratioErrors=[];addEventListener('error',e=>__ratioErrors.push(String(e.error?.stack||e.message)));for(const [name,w,h] of [['poster',300,900],['square',400,400],['wide',900,300]]){const c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d');ctx.fillStyle='#dca72a';ctx.fillRect(0,0,w,h);ctx.fillStyle='#253447';ctx.fillRect(10,10,w-20,h-20);require('fs').writeFileSync(require('path').join(reactor.projectController.currentProject.path,'img/pictures','__ratio-'+name+'.png'),Buffer.from(c.toDataURL().split(',')[1],'base64'));}`);
 const results=[];
 for(const mode of [false,true]) {
  await driver.executeAsync(`const done=arguments[arguments.length-1];reactor.applyMap3DViewPreference(arguments[0]).then(done);`,[mode]);
  for(const [name,ratio] of [['poster',1/3],['square',1],['wide',3]]) {
   const row=await driver.executeAsync(`const done=arguments[arguments.length-1];reactor.mediaSurfaceManager.edit(null);const e=reactor.mediaSurfaceManager.editor;e._browseMedia=(_kind,cb)=>cb('__ratio-'+arguments[0]+'.png');[...e.modal.querySelectorAll('button')].find(b=>b.textContent==='Browse…').click();e.mediaDimensionsReady.then(ok=>done({ok,width:e.data.width,height:e.data.height,live:e.liveMapAuthoring,corners:e.data.corners}));`,[name]);
   assert.equal(row.ok,true);assert.equal(row.live,true);assert.ok(Math.abs(row.width/row.height-ratio)<1e-8,JSON.stringify(row));
   const resized=await driver.execute(`const e=reactor.mediaSurfaceManager.editor;e.fields.width.value=e.data.width*1.5;e.fields.width.dispatchEvent(new Event('input'));const size=[e.data.width,e.data.height];[...e.modal.querySelectorAll('button')].find(b=>b.textContent==='OK').click();const saved=reactor.mediaSurfaceManager.rows().at(-1);reactor.mediaSurfaceManager.edit(saved.id);return {size,id:saved.id,saved:[Number(saved.width),Number(saved.height)]};`);
   assert.ok(Math.abs(resized.size[0]/resized.size[1]-ratio)<1e-8);assert.deepEqual(resized.saved,resized.size);
   const reopened=await driver.executeAsync(`const done=arguments[arguments.length-1],e=reactor.mediaSurfaceManager.editor;e.mediaDimensionsReady.then(()=>{const result=[e.data.width,e.data.height];e.close(true);done(result);});`);
   assert.deepEqual(reopened,resized.size);results.push({mode,name,...row,resized});
  }
 }
 // Common-event workspace uses the same metadata path with local previews.
 const workspace=await driver.executeAsync(`const done=arguments[arguments.length-1];reactor.mediaSurfaceManager.close();window.ratioEditor=new MediaSurfaceEditor(reactor.databaseManager,reactor.projectController);ratioEditor.show(null,()=>{},'ShowVideoSurface',{type:'common'});ratioEditor._browseMedia=(_kind,cb)=>cb('__ratio-poster.png');[...ratioEditor.modal.querySelectorAll('button')].find(b=>b.textContent==='Browse…').click();ratioEditor.mediaDimensionsReady.then(()=>{const result={width:ratioEditor.data.width,height:ratioEditor.data.height,workspace:!!ratioEditor.workspace};ratioEditor.close();done(result);});`);
 assert.equal(workspace.workspace,true);assert.ok(Math.abs(workspace.width/workspace.height-1/3)<1e-8);
 assert.deepEqual(await driver.execute('return __ratioErrors;'),[]);
 console.log('PASS six portrait/square/landscape live map resize-save-reopen cases in 2D/3D and common-event preview',JSON.stringify(results));
}finally{await driver?.close();fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
