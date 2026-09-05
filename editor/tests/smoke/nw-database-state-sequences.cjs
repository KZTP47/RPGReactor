// Opens only a disposable project copy. Run from the repository root with a desktop display.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebDriverClient } = require('./webdriver-client.cjs');
const root = path.resolve(__dirname, '../../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-database-sequences-'));
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
    window.__sequenceErrors=[];window.addEventListener('error',e=>__sequenceErrors.push(e.error?.stack||e.message));window.addEventListener('unhandledrejection',e=>__sequenceErrors.push(String(e.reason?.stack||e.reason)));
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
  const setup=fs.readFileSync(path.join(__dirname,'database-state-sequences-setup.js'),'utf8');
  const results=[];
  for(const phase of ['races','workflows',...['actors','classes','skills','items','weapons','armors','enemies','troops','states','animations','tilesets','commonEvents','userInterfaces','quests','system1','system2','types','terms','reactor3d']]) {
   const result=await driver.executeAsync(setup,[phase]);results.push({phase,...result});
   fs.writeFileSync(path.join(temp,'sequences.json'),JSON.stringify(results,null,2));
   console.log(phase,JSON.stringify(result));
  }
  const errors=await driver.execute('return window.__sequenceErrors');
  fs.writeFileSync(path.join(temp,'uncaught-errors.json'),JSON.stringify(errors,null,2));
  if(errors.length){console.log('uncaught errors',JSON.stringify(errors));process.exitCode=1;}
  console.log('artifacts',temp);
  if(results.some(r=>r.error||r.failures?.length))process.exitCode=1;
 }finally{await driver.close();fs.rmSync(project,{recursive:true,force:true});fs.rmSync(path.join(temp,'profile'),{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
