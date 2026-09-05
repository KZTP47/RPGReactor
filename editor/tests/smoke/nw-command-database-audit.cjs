// Opens only a disposable project copy. Run from the repository root with a desktop display.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebDriverClient } = require('./webdriver-client.cjs');
const root = path.resolve(__dirname, '../../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-command-database-audit-'));
const project = path.join(temp, 'Demo');
fs.cpSync(path.join(root, 'template/Demo'), project, { recursive: true, dereference: true });
fs.rmSync(path.join(project,'.rpgreactor.lock'),{force:true});
const driver = new WebDriverClient(path.join(root, 'nwjs-linux/chromedriver'), { env: {...process.env} });
(async () => {
 try {
  await driver.start();
  await driver.createSession({browserName:'chrome', 'goog:chromeOptions':{args:[`nwapp=${path.join(root,'editor')}`,`user-data-dir=${path.join(temp,'profile')}`,'no-first-run','disable-backgrounding-occluded-windows']}});
  await driver.setScriptTimeout(120000);
  await driver.waitForScript('return !!window.reactor?.projectController?.projectManager', [], {timeout:90000});
  const opened = await driver.executeAsync(String.raw`const done = arguments[arguments.length-1]; (async()=>{
    window.__previewErrors=[];for(const key of ['warn','error']){const original=console[key];console[key]=(...args)=>{__previewErrors.push(args.map(a=>a?.stack||String(a)).join(' '));original.apply(console,args);};}window.addEventListener('error',e=>__previewErrors.push(e.error?.stack||e.message));
    const pc=reactor.projectController; const loaded=await pc.projectManager.loadProject(arguments[0]);
    if(!loaded) throw new Error('Project load failed');
    if(!pc.acquireProjectLock(loaded.path)) throw new Error('Project locked');
    pc.currentProject=loaded; pc.lastLoadedProjectPath=null;
    pc.rememberMap3DView(1,false);
    await pc.uiManager.showEditorUI(); await pc.populateProjectUI();

    return loaded.name;
  })().then(done,e=>done({error:String(e.stack)}));`,[project]);
  console.log('opened',JSON.stringify(opened));

  await driver.execute('reactor.modelPropsManager.preview2D.suspend();reactor.modelPropsManager.preview2D.app.ticker.stop();');
  const result=await driver.executeAsync(fs.readFileSync(path.join(__dirname,'command-database-audit-setup.js'),'utf8'));
  fs.writeFileSync(path.join(temp,'audit.json'),JSON.stringify(result,null,2));
  console.log('commands', result.commands?.length, 'database sections',result.database?.length);
  const subdialogs=await driver.executeAsync(fs.readFileSync(path.join(__dirname,'database-subdialog-audit-setup.js'),'utf8'));
  fs.writeFileSync(path.join(temp,'subdialogs.json'),JSON.stringify(subdialogs,null,2));
  if(result.error||subdialogs.error||!result.commands?.length||!result.database?.length||!subdialogs.dialogs?.length)throw new Error(`Incomplete audit; see ${temp}`);
  await driver.execute(fs.readFileSync(path.join(__dirname,'modal-theme-audit-setup.js'),'utf8'));
  const themes=[];
  for(const palette of (process.env.RR_AUDIT_SKIP_THEMES ? [] : ['gold','bubblegum','ocean','cascadia','underworld','creamsicle','royalty']))for(const mode of ['dark','light']){
   const theme=palette==='gold'?mode:`${palette}-${mode}`;
   const themed=await driver.executeAsync(fs.readFileSync(path.join(__dirname,'command-database-audit-setup.js'),'utf8'),[{theme,themeOnly:true}]);
   const nested=await driver.executeAsync(fs.readFileSync(path.join(__dirname,'database-subdialog-audit-setup.js'),'utf8'));
   themes.push({theme,commands:themed.commands,subdialogs:nested});
   fs.writeFileSync(path.join(temp,'themes.json'),JSON.stringify(themes,null,2));
   console.log('theme',theme,'commands',themed.commands?.length,'subdialogs',nested.dialogs?.length);
  }
  const menuResult=await driver.executeAsync(fs.readFileSync(path.join(__dirname,'menu-locale-audit-setup.js'),'utf8'));
  fs.writeFileSync(path.join(temp,'menus.json'),JSON.stringify(menuResult,null,2));
  for(const [theme,language] of [['dark','en'],['light','en'],['royalty-light','ar']]) {
   await driver.execute(`document.querySelectorAll('.rr-audio-picker-modal').forEach(e=>e.querySelector('button[aria-label]')?.click());document.documentElement.setAttribute('data-theme',arguments[0]);I18n.setLanguage(arguments[1],{persist:false});const db=reactor.databaseEditorUI;db.openDatabase('classes');const entry=reactor.databaseManager.data.classes.find(e=>e&&e.id>0);db.showDatabaseDetail(entry,'classes');db.classEditor.showParameterCurveModal(entry,0,I18n.tText('Max HP'),'#FF3366');`,[theme,language]);
   const shot=await driver.sessionRequest('GET','/screenshot');fs.writeFileSync(path.join(temp,`${theme}-${language}.png`),Buffer.from(shot,'base64'));
   await driver.execute(`document.querySelectorAll('.rr-modal-overlay').forEach(e=>{if(e.getClientRects().length)e.remove();});`);
  }
  console.log('artifacts',temp);
  const problems=[...(result.commands||[]),...(result.database||[]),...(subdialogs.dialogs||[])].filter(r=>r.error||r.roundTrip===false||r.cancelPreserved===false||r.saved===false);
  problems.push(...result.commands.filter(r=>!r.roundTrip&&!r.inserted));
  for(const theme of themes) problems.push(...(theme.commands||[]).filter(r=>r.error),...(theme.subdialogs.dialogs||[]).filter(r=>r.error||r.cancelPreserved===false||r.saved===false));
  problems.push(...(menuResult.menus||[]).filter(r=>!r.inViewport||!r.localized||!r.actionInvoked||!r.dismissed));
  if(menuResult.error)problems.push(menuResult);
  if(problems.length)throw new Error(`${problems.length} audit failures; see JSON artifacts in ${temp}`);
 }finally{await driver.close();fs.rmSync(project,{recursive:true,force:true});fs.rmSync(path.join(temp,'profile'),{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
