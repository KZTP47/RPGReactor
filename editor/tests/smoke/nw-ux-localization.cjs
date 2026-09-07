const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {WebDriverClient}=require('./webdriver-client.cjs');
const root=path.resolve(__dirname,'../../..'),source=path.join(root,'template/Demo'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'rr-ux-locale-')),project=path.join(temp,'Demo');let driver;
(async()=>{try{
 fs.mkdirSync(project);for(const n of ['data','js','icon'])fs.cpSync(path.join(source,n),path.join(project,n),{recursive:true});for(const n of ['img','3d','effects','audio','fonts','movies','css'])if(fs.existsSync(path.join(source,n)))fs.symlinkSync(path.join(source,n),path.join(project,n));for(const n of ['index.html','package.json','project.rpgreactor'])fs.copyFileSync(path.join(source,n),path.join(project,n));
 driver=new WebDriverClient(path.join(root,'nwjs-linux/chromedriver'));await driver.start();await driver.createSession({browserName:'chrome','goog:chromeOptions':{args:[`nwapp=${path.join(root,'editor')}`,`user-data-dir=${temp}/profile`,'no-first-run']}});await driver.setScriptTimeout(90000);
 await driver.waitForScript('return !!window.reactor?.projectController && getComputedStyle(document.getElementById("splash-screen")).display==="none";',[],{timeout:90000});
 assert.equal(await driver.executeAsync(`const done=arguments[arguments.length-1];(async()=>{const pc=reactor.projectController;pc.currentProject=await reactor.projectManager.loadProject(arguments[0]);pc.projectLoaded=true;nw.Window.get().resizeTo(1920,1080);await reactor.uiManager.showEditorUI();await pc.populateProjectUI();await reactor.applyMap3DViewPreference(true);return true;})().then(done,e=>done(String(e.stack)));`,[project]),true);
 await driver.waitForScript('return !!reactor.projectController.mapEditor3D?.mapScene;',[],{timeout:90000});





 const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'rr-ux-localization-report-'));
 const languages=['en','ja','es','zh-Hant','zh-Hans','ru','pt','de','fr','el','ko','ar','it','pl','id','vi','th','tr'];
 await driver.execute(`window.__uxTexts=new Set();const original=BattlePresentationEditor.prototype.text;BattlePresentationEditor.prototype.text=function(v){__uxTexts.add(typeof v==='object'?v.source:String(v));return original.call(this,v);};window.__uxErrors=[];addEventListener('error',e=>__uxErrors.push(String(e.error?.stack||e.message)));
 window.__checkLabels=root=>[...root.querySelectorAll('[data-i18n-text-source]')].filter(el=>!el.closest('[data-rr-i18n-skip]')&&!el.children.length).map(el=>({source:el.dataset.i18nTextSource,actual:el.textContent,expected:I18n.formatText(el.dataset.i18nTextSource,JSON.parse(el.dataset.i18nTextParams||'{}'))})).filter(row=>row.actual!==row.expected);`);
 const results=[];
 for(const language of languages)for(const size of [[1280,720],[1920,1080]]){
  await driver.execute(`nw.Window.get().resizeTo(arguments[1],arguments[2]);I18n.setLanguage(arguments[0],{persist:false});reactor.openDatabase('actionSequences');const db=reactor.databaseEditorUI;db.showDatabaseDetail(reactor.databaseManager.data.actionSequences.find(Boolean),'actionSequences');window.ed=db.actionSequenceEditor;`,[language,...size]);
  await driver.executeAsync('const done=arguments[arguments.length-1];setTimeout(done,400);');
  const row=await driver.execute(`const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};const detail=document.querySelector('#database-detail'),host=ed.host;return {language:I18n.language,size:[innerWidth,innerHeight],overflow:[detail.scrollWidth-detail.clientWidth,detail.scrollHeight-detail.clientHeight],host:rect(host),preview:rect(ed.canvas),labels:__checkLabels(host)};`);
  assert.deepEqual(row.overflow,[0,0],language+' database overflow');assert.ok(row.preview.height>=120,language+' preview remains usable');assert.deepEqual(row.labels,[],language+' label routing');results.push(row);
  if(['en','de','ja','ar'].includes(language))fs.writeFileSync(path.join(artifacts,language+'-'+size[0]+'.png'),Buffer.from(await driver.sessionRequest('GET','/screenshot'),'base64'));
  if(size[0]===1280){const checks=await driver.execute(`const saved=ed.sequence.steps,checks=[];for(const type of ReactorBattleData.types){ed.sequence.steps=[ReactorBattleData.step(type,{transform:type==='motion'?ReactorBattleData.transform():undefined})];ed.selected=0;ed.drawInspector();checks.push(...__checkLabels(ed.inspector));}ed.controls.mode='formation';ed.drawInspector();checks.push(...__checkLabels(ed.inspector));ed.controls.mode='step';ed.sequence.steps=saved;ed.drawInspector();return checks;`);assert.deepEqual(checks,[],language+' step and transform forms');}
 }
 // Changing language must preserve the edited record, selection, and enum IDs.
 await driver.execute(`ed.selected=2;window.__sequenceBefore=JSON.stringify(ed.sequence);window.__sameHost=ed.host;window.__optionsBefore=[...ed.host.querySelectorAll('select')].map(s=>s.value);`);
 for(const language of ['de','ar','en']){
  const switched=await driver.execute(`I18n.setLanguage(arguments[0],{persist:false});return {sameHost:ed.host===__sameHost,sameData:JSON.stringify(ed.sequence)===__sequenceBefore,selected:ed.selected,labels:__checkLabels(ed.host),castNames:[...ed.host.querySelector('.rr-sequence-cast select').options].map(o=>o.textContent)};`,[language]);
  assert.equal(switched.sameHost,true);assert.equal(switched.sameData,true);assert.equal(switched.selected,2);assert.deepEqual(switched.labels,[]);assert.ok(switched.castNames.some(name=>name.includes('Psychronic')));
 }
 const raw=await driver.execute(`const U=ed.ui,node=U.select([['test','Attack',true]],'test',()=>{});document.body.append(node);I18n.setLanguage('ja',{persist:false});const value=node.options[0].textContent;node.remove();return value;`);assert.equal(raw,'Attack');
 await driver.execute(`reactor.openDatabase('troops');const db=reactor.databaseEditorUI;db.showDatabaseDetail(reactor.databaseManager.getTroop(1),'troops');window.__troop=db.troopEditor;`);
 const room=await driver.executeAsync(`const done=arguments[arguments.length-1];const U=reactor.databaseEditorUI.battlePresentationEditor;U.roomDialog(U.settings().troops[1],__troop).then(()=>done(true),e=>done(String(e.stack)));`);assert.equal(room,true);
 const rooms=[];
 for(const language of languages){const row=await driver.execute(`I18n.setLanguage(arguments[0],{persist:false});const panel=document.querySelector('.rr-battle-room-dialog');return {language:I18n.language,labels:__checkLabels(panel),fields:panel.querySelectorAll('input').length,overflow:panel.scrollWidth-panel.clientWidth};`,[language]);assert.deepEqual(row.labels,[]);assert.ok(row.fields>=4);assert.equal(row.overflow,0);rooms.push(row);}
 await driver.execute(`reactor.databaseEditorUI.battlePresentationEditor.dispose();reactor.mediaSurfaceManager.open();`);
 const surfaces=[];
 for(const language of languages){const row=await driver.execute(`I18n.setLanguage(arguments[0],{persist:false});const panel=reactor.mediaSurfaceManager.panel;return {language:I18n.language,labels:__checkLabels(panel),title:panel.querySelector('.rr-modal-title').textContent,overflow:panel.scrollWidth-panel.clientWidth};`,[language]);assert.deepEqual(row.labels,[]);assert.equal(row.overflow,0);surfaces.push(row);}
 const coverage=await driver.execute(`return [...__uxTexts].filter(source=>/[A-Za-z]/.test(source)&&!['X','Y','Z','S'].includes(source)).map(source=>({source,translations:Object.fromEntries(['ja','es','zh-Hant','zh-Hans','ru','pt','de','fr','el','ko','ar','it','pl','id','vi','th','tr'].map(locale=>[locale,RR_TEXT_TRANSLATIONS[locale]?.[source]||RR_EVENT_COMMAND_NAMES[locale]?.[source]||RR_EVENT_SECTION_NAMES[locale]?.[source]||null]))}));`);
 fs.writeFileSync(path.join(artifacts,'coverage.json'),JSON.stringify(coverage,null,2));
 for(const {source,translations}of coverage)for(const [locale,value]of Object.entries(translations))assert.ok(value,locale+' missing '+source);
 const errors=await driver.execute('return __uxErrors;');assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(artifacts,'audit.json'),JSON.stringify({results,rooms,surfaces,coverage,errors},null,2));console.log('PASS: 36 sequence layouts, all step forms, 18 room and media panels; live switches preserve edits.');console.log('artifacts',artifacts);
}finally{await driver?.close();fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
