const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {WebDriverClient}=require('./webdriver-client.cjs');
const root=path.resolve(__dirname,'../../..'),source=path.join(root,'template/Demo'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'rr-json-encodings-')),project=path.join(temp,'Demo');let driver;
(async()=>{try{
 fs.mkdirSync(project);for(const n of ['data','js','icon'])fs.cpSync(path.join(source,n),path.join(project,n),{recursive:true});for(const n of ['img','3d','effects','audio','fonts','movies','css'])if(fs.existsSync(path.join(source,n)))fs.symlinkSync(path.join(source,n),path.join(project,n));for(const n of ['index.html','package.json','project.rpgreactor'])fs.copyFileSync(path.join(source,n),path.join(project,n));
 const encode=(text,encoding)=>encoding==='utf8'?Buffer.from(text):encoding==='utf8-bom'?Buffer.concat([Buffer.from([239,187,191]),Buffer.from(text)]):encoding==='utf16be'?Buffer.from('\ufeff'+text,'utf16le').swap16():Buffer.from('\ufeff'+text,'utf16le');
 const mapFile=path.join(project,'data/Map001.json'),sidecarFile=path.join(project,'data/Map001.r3d.json');
 const authored=JSON.parse(fs.readFileSync(mapFile,'utf8')),sidecar=JSON.parse(fs.readFileSync(sidecarFile,'utf8'));
 authored.displayName='Réacteur 日本語 🚀';sidecar.encodingTest='日本語 🧪';
 fs.writeFileSync(mapFile,encode(JSON.stringify(authored),'utf8-bom'));
 for(const [file,encoding] of [['System.json','utf16be'],['MapInfos.json','utf16le']]){const name=path.join(project,'data',file);fs.writeFileSync(name,encode(fs.readFileSync(name,'utf8'),encoding));}
 driver=new WebDriverClient(path.join(root,'nwjs-linux/chromedriver'));await driver.start();await driver.createSession({browserName:'chrome','goog:chromeOptions':{args:[`nwapp=${path.join(root,'editor')}`,`user-data-dir=${temp}/profile`,'no-first-run']}});await driver.setScriptTimeout(90000);
 await driver.waitForScript('return !!window.reactor?.projectController && getComputedStyle(document.getElementById("splash-screen")).display==="none";',[],{timeout:90000});
 assert.equal(await driver.executeAsync(`const done=arguments[arguments.length-1];(async()=>{const pc=reactor.projectController;pc.currentProject=await reactor.projectManager.loadProject(arguments[0]);pc.projectLoaded=true;nw.Window.get().resizeTo(1920,1080);await reactor.uiManager.showEditorUI();await pc.populateProjectUI();await reactor.applyMap3DViewPreference(true);return true;})().then(done,e=>done(String(e.stack)));`,[project]),true);
 await driver.waitForScript('return !!reactor.projectController.mapEditor3D?.mapScene;',[],{timeout:90000});


 const results=[];
 for(const encoding of ['utf8','utf8-bom','utf16le','utf16be']){
  fs.writeFileSync(mapFile,encode(JSON.stringify(authored),encoding));fs.writeFileSync(sidecarFile,encode(JSON.stringify(sidecar),encoding));
  const loaded=await driver.executeAsync(`const done=arguments[arguments.length-1];(async()=>{const pc=reactor.projectController,ok=await pc.loadMap(1,{forceReload:true});return {ok,name:pc.tilemapManager.currentMap.displayName,sidecar:pc.tilemapManager.currentMap.reactor3d.encodingTest};})().then(done,e=>done(String(e.stack)));`);
  assert.deepEqual(loaded,{ok:true,name:authored.displayName,sidecar:sidecar.encodingTest},encoding);
  // Use the runtime's actual onXhrLoad hook with native Chromium responseText.
  const xhr=await driver.executeAsync(`const done=arguments[arguments.length-1],file=arguments[0],fs=require('fs'),path=require('path');const source=fs.readFileSync(path.join(reactor.projectManager.getRuntimePath(),'reactor_managers.js'),'utf8'),start=source.indexOf('DataManager.onXhrLoad ='),end=source.indexOf('DataManager.onXhrError =',start),manager={onLoad(){},onXhrError(){throw Error('XHR error');}},target={};new Function('DataManager','RRJson','window',source.slice(start,end))(manager,RRJson,target);const xhr=new XMLHttpRequest();xhr.open('GET',RRAssetFiles.toUrl(file));xhr.overrideMimeType('application/json');xhr.onload=()=>{try{manager.onXhrLoad(xhr,'map','','');done({name:target.map.displayName});}catch(e){done(String(e.stack));}};xhr.onerror=()=>done('XHR failed');xhr.send();`,[mapFile]);
  assert.deepEqual(xhr,{name:authored.displayName},encoding+' runtime XHR');
  assert.equal(await driver.execute('return reactor.projectController.tilemapManager.saveMap();'),true);
  const bytes=fs.readFileSync(mapFile),saved=JSON.parse(bytes.toString('utf8'));assert.equal(saved.displayName,authored.displayName);assert.equal(bytes[0],123,'saves canonical UTF-8 without a BOM');
  results.push({encoding,loaded,xhr,savedUtf8:true});
 }
 console.log('Native editor maps, sidecars, database and runtime XHR encoding checks passed:',results);
}finally{await driver?.close();fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
