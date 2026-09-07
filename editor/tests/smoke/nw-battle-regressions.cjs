const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {WebDriverClient}=require('./webdriver-client.cjs');
const root=path.resolve(__dirname,'../../..'),source=path.join(root,'template/Demo'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'rr-battle-regressions-')),project=path.join(temp,'Demo');
let driver;
async function launch(app){driver=new WebDriverClient(path.join(root,'nwjs-linux/chromedriver'));await driver.start();await driver.createSession({browserName:'chrome','goog:chromeOptions':{args:[`nwapp=${app}`,`user-data-dir=${path.join(temp,'profile-'+path.basename(app))}`,'no-first-run']}});await driver.setScriptTimeout(90000);}
async function pause(ms=200){await driver.executeAsync('const done=arguments[arguments.length-1];setTimeout(()=>done(true),arguments[0]);',[ms]);}
async function logs(){const entries=await driver.sessionRequest('POST','/log',{type:'browser'});const bad=entries.filter(e=>/ERR_FILE_NOT_FOUND|does not belong|associated program|GL_INVALID|TypeError|Insufficient buffer/.test(e.message));assert.deepEqual(bad,[],JSON.stringify(bad));}
(async()=>{try{
 fs.mkdirSync(project);for(const n of ['data','js','icon'])fs.cpSync(path.join(source,n),path.join(project,n),{recursive:true});
 for(const n of ['img','3d','effects','audio','fonts','movies','css'])if(fs.existsSync(path.join(source,n)))fs.symlinkSync(path.join(source,n),path.join(project,n));
 for(const n of ['index.html','package.json','project.rpgreactor'])fs.copyFileSync(path.join(source,n),path.join(project,n));
 for(const n of ['reactor_managers.js','reactor_battle_presentation.js'])fs.copyFileSync(path.join(root,'runtime',n),path.join(project,'js',n));
 await launch(path.join(root,'editor'));await driver.waitForScript('return !!window.reactor?.projectController && getComputedStyle(document.getElementById("splash-screen")).display==="none";',[],{timeout:90000});
 assert.equal(await driver.executeAsync(`const done=arguments[arguments.length-1];(async()=>{const pc=reactor.projectController;pc.currentProject=await reactor.projectManager.loadProject(arguments[0]);pc.projectLoaded=true;nw.Window.get().resizeTo(1600,1000);await reactor.uiManager.showEditorUI();await pc.populateProjectUI();return true;})().then(done,e=>done(String(e.stack)));`,[project]),true);
 // Actor previews must consult the active model before issuing old image requests.
 await driver.execute('reactor.openDatabase("actors");reactor.databaseEditorUI.showDatabaseDetail(reactor.databaseManager.getActor(2),"actors");');await pause(1300);
 await driver.execute(`window.__actorCharacterBinding=RRDatabase3DBindings.get(arguments[0],'actors',1,'character');reactor.databaseEditorUI.showDatabaseDetail(reactor.databaseManager.getActor(1),'actors');const check=document.querySelector('.graphic-preview-box input[type=checkbox]');check.checked=false;check.dispatchEvent(new Event('change'));`,[project]);
 await driver.waitForScript(`const canvas=document.querySelector('.graphic-preview-box .graphic-canvas-container canvas');return canvas&&canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data.some((v,i)=>i%4===3&&v>0);`,[],{timeout:10000});
 await driver.execute(`RRDatabase3DBindings.set(arguments[0],'actors',1,__actorCharacterBinding,'character');reactor.databaseEditorUI.showDatabaseDetail(reactor.databaseManager.getActor(1),'actors');`,[project]);console.log('Actor model toggle restores the configured 2D image on demand');
 const missing=await driver.execute(`const modal=new BattleTestConfigModal(reactor.databaseManager,{path:arguments[0]},1,'','',{battleTest(){}});return {invalid:modal.missingBattlerGraphics([{actorId:4}]),valid:modal.missingBattlerGraphics([{actorId:1},{actorId:2}])};`,[project]);assert.equal(missing.invalid.length,1);assert.match(missing.invalid[0],/Karen.*Actor1/);assert.deepEqual(missing.valid,[]);console.log('Battle Test identifies unconfigured Karen, accepts configured models',missing);
 const layouts=[];
 for(const width of [1600,1280]){
  await driver.execute('nw.Window.get().resizeTo(arguments[0],900);',[width]);await pause();
  for(const kind of ['actors','classes','enemies','weapons','armors','states','items']){
   await driver.execute('const kind=arguments[0];reactor.openDatabase(kind);reactor.databaseEditorUI.showDatabaseDetail(reactor.databaseManager.data[kind].find(e=>e&&(kind==="items"?e.name==="Potion":e.id>0)),kind);',[kind]);await pause();
   const layout=await driver.execute(`const table=[...document.querySelectorAll('.traits-table')].find(t=>t.querySelector('.trait-row')),row=table?.querySelector('.trait-row'),heads=table?[...table.querySelectorAll('thead th')]:[],cells=row?[...row.cells]:[];const input=document.querySelector('[data-field="price"]'),field=input?.closest('.rr-number-stepper'),col=input?.closest('.db-col'),box=e=>e?.getBoundingClientRect();const a=box(field),b=box(col);return {columns:cells.slice(1).map((c,i)=>Math.abs(box(c).left-box(heads[i+1]).left)),priceFits:!input||(a.left>=b.left-1&&a.right<=b.right+1),headerAccent:getComputedStyle(document.querySelector('.database-section-header')).borderLeftWidth};`);
   assert.ok(layout.columns.every(x=>x<1),JSON.stringify({kind,layout}));assert.equal(layout.priceFits,true,kind);assert.equal(layout.headerAccent,'3px',kind);layouts.push({kind,width,...layout});
   if(kind==='items') {
    const cards=await driver.execute(`const columns=[...document.querySelectorAll('.database-item-column')];return columns.map(col=>{const cards=[...col.children].map(e=>e.getBoundingClientRect());return cards.slice(1).map((r,i)=>r.top-cards[i].bottom);});`);assert.ok(cards.flat().every(gap=>Math.abs(gap-16)<1),JSON.stringify(cards));
    fs.writeFileSync('/tmp/rr-items-layout-'+width+'.png',Buffer.from(await driver.sessionRequest('GET','/screenshot'),'base64'));
   }

  }
 }
 console.log('Trait headings, price containment and accent headers',layouts);
 // Switch through room effects, then draw animation effects with a competing context.
 await driver.execute('reactor.openDatabase("troops");reactor.databaseEditorUI.showDatabaseDetail(reactor.databaseManager.getTroop(1),"troops");');await pause(1500);
 for(const id of [1,3]){
  await driver.execute('reactor.openDatabase("animations");reactor.databaseEditorUI.showDatabaseDetail(reactor.databaseManager.data.animations[arguments[0]],"animations");',[id]);
  await driver.waitForScript('return !!document.querySelector("#effekseer-preview-canvas") && !document.querySelector("#animation-play-btn").disabled;',[],{timeout:90000});
  await pause(1500);
  const frames=await driver.executeAsync(`const done=arguments[arguments.length-1];const canvas=document.querySelector('#effekseer-preview-canvas'),other=document.createElement('canvas'),gl=other.getContext('webgl'),alien=effekseer.createContext();alien.init(gl);let raf,count=0;const compete=()=>{alien._makeContextCurrent();raf=requestAnimationFrame(compete);};compete();document.querySelector('#animation-repeat-checkbox').checked=true;document.querySelector('#animation-play-btn').click();const mini=document.createElement('canvas');mini.width=96;mini.height=54;const ctx=mini.getContext('2d',{willReadFrequently:true}),hashes=new Set();const sample=()=>{ctx.drawImage(canvas,0,0,96,54);let hash=0;for(const n of ctx.getImageData(0,0,96,54).data)hash=(hash*31+n)|0;hashes.add(hash);if(++count<90)requestAnimationFrame(sample);else {cancelAnimationFrame(raf);document.querySelector('#animation-stop-btn').click();alien._makeContextCurrent();effekseer.releaseContext(alien);gl.getExtension('WEBGL_lose_context')?.loseContext();done({frames:hashes.size,counter:document.querySelector("#animation-frame-counter").textContent});}};requestAnimationFrame(sample);`);if(frames.frames<=2)console.log(await driver.sessionRequest('POST','/log',{type:'browser'}));assert.ok(frames.frames>2,JSON.stringify(frames));console.log('Animations play with competing WebGL context',id,frames);
 }
 await logs();await driver.close();
 // Boot the true btest path, with selected test party distinct from startup flow.
 for(const n of fs.readdirSync(path.join(project,'data')))if(/\.json$/.test(n)&&!n.startsWith('Test_')&&!n.includes('.r3d.'))fs.copyFileSync(path.join(project,'data',n),path.join(project,'data','Test_'+n));
 const systemPath=path.join(project,'data/Test_System.json'),system=JSON.parse(fs.readFileSync(systemPath));system.testBattlers=[1,2].map(actorId=>({actorId,level:1,equips:[0,0,0,0,0]}));system.testTroopId=1;fs.writeFileSync(systemPath,JSON.stringify(system));
 const pkg=JSON.parse(fs.readFileSync(path.join(project,'package.json')));pkg.main='index.html?test&btest';fs.writeFileSync(path.join(project,'package.json'),JSON.stringify(pkg));
 await launch(project);await driver.waitForScript('return !!window.SceneManager?._scene?._spriteset && window.DataManager?.isBattleTest() && SceneManager._scene._spriteset._enemySprites?.[0]?._reactorBattler?.bitmap?.width>1;',[],{timeout:90000});
 const atb=await driver.execute(`const source=SceneManager._scene._spriteset._enemySprites[0],walk=n=>n._sprites?.enemy_0||n.children?.map(walk).find(Boolean),icon=walk(SceneManager._scene);icon.update();return {expected:PIXI.groupD8.MIRROR_VERTICAL,icon:icon.texture.rotate,shared:!!source._reactorBattler.bitmap.baseTexture.source.__reactorExternal};`);assert.equal(atb.shared,true);assert.equal(atb.icon,atb.expected);assert.notEqual(atb.icon,0);console.log('ATB icon matches upright shared texture',atb);
 fs.writeFileSync('/tmp/rr-atb-upright.png',Buffer.from(await driver.sessionRequest('GET','/screenshot'),'base64'));
 await driver.execute(`window.__missingSeRequests=0;const create=AudioManager.createBuffer;AudioManager.createBuffer=function(folder,name){if(name==='Blow1')__missingSeRequests++;return create.call(this,folder,name);};for(let i=0;i<40;i++){Graphics.frameCount++;AudioManager.playSe({name:'Blow1',volume:90,pitch:100,pan:0});}AudioManager.checkErrors();`);await pause(600);
 const sound=await driver.execute('return {requests:__missingSeRequests,warnings:AudioManager._missingSeWarnings?.size,stopped:!!SceneManager._stopped};');assert.equal(sound.requests,0);assert.equal(sound.stopped,false);console.log('Missing attack sound skips without requests or battle halt',sound);await logs();
 console.log('Battle and database regressions passed.');
}finally{await driver?.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
