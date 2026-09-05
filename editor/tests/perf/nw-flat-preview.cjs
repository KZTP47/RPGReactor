// Manual NW.js visual/performance regression. Always copies Demo and isolates
// the editor profile; never opens the author's project. Run from repo root:
// node editor/tests/perf/nw-flat-preview.cjs
// Optional RR_RENDER_NODE=/dev/dri/renderD129 selects integrated graphics.
// Reports a 20-second animated preview sample, compares 24 GPU light fields,
// checks zoom resolution, and saves 2D/3D screenshots in its printed temp dir.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebDriverClient } = require('../smoke/webdriver-client.cjs');
const root = path.resolve(__dirname, '../../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-db-switch-'));
const project = path.join(temp, 'Demo');
fs.cpSync(path.join(root, 'template/Demo'), project, { recursive: true, dereference: true });
fs.rmSync(path.join(project,'.rpgreactor.lock'),{force:true});
const driver = new WebDriverClient(path.join(root, 'nwjs-linux/chromedriver'), { env: {...process.env} });
(async () => {
 try {
  await driver.start();
  await driver.createSession({browserName:'chrome', 'goog:chromeOptions':{args:[`nwapp=${path.join(root,'editor')}`,`user-data-dir=${path.join(temp,'profile')}`,'no-first-run','disable-backgrounding-occluded-windows',...(process.env.RR_RENDER_NODE ? ['render-node-override='+process.env.RR_RENDER_NODE] : [])]}});
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
  await driver.waitForScript('return [...reactor.modelPropsManager.preview2D.entries.values()].some(e=>e.draws>2)', [], {timeout:20000});

  await driver.execute("reactor.modelPropsManager.tilemapManager.container.scale.set(0.3);window.__times={};for(const [obj,key,label] of [[reactor.modelPropsManager.preview2D,'tick','tick'],[reactor.modelPropsManager.preview2D,'paint','model'],[reactor.modelPropsManager.preview2D.shadows,'update','shadows'],[reactor.modelPropsManager.preview2D.shadows,'paint','shadowPaint'],[reactor.lightingManager,'render','lights']]){const old=obj[key];obj[key]=function(...args){const t=performance.now();try{return old.apply(this,args);}finally{(__times[label]||(__times[label]=[])).push(performance.now()-t);}}}");
  console.log('fieldComparison',JSON.stringify(await driver.executeAsync(fs.readFileSync(path.join(root,'editor/tests/perf/flat-light-field-setup.js'),'utf8'))));
  const profile=await driver.executeAsync(String.raw`const done=arguments[arguments.length-1];(async()=>{
    const wait=ms=>new Promise(r=>setTimeout(r,ms));await wait(2500);window.__times={};
    const app=reactor.modelPropsManager.preview2D.app,gl=app.renderer.gl,ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const gpu=[];let pending=[],query=null;
    const begin=()=>{if(!ext)return;pending=pending.filter(q=>{if(!gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE))return true;if(!gl.getParameter(ext.GPU_DISJOINT_EXT))gpu.push(gl.getQueryParameter(q,gl.QUERY_RESULT)/1e6);gl.deleteQuery(q);return false;});if(pending.length<20){query=gl.createQuery();gl.beginQuery(ext.TIME_ELAPSED_EXT,query);}};
    const end=()=>{if(query){gl.endQuery(ext.TIME_ELAPSED_EXT);pending.push(query);query=null;}};
    app.ticker.add(begin,null,100);app.ticker.add(end,null,-100);
    const gaps=[];let last=performance.now(),running=true;function frame(t){gaps.push(t-last);last=t;if(running)requestAnimationFrame(frame);}requestAnimationFrame(frame);
    await wait(20000);running=false;app.ticker.remove(begin);app.ticker.remove(end);pending.forEach(q=>gl.deleteQuery(q));
    const stats=a=>{a.sort((a,b)=>a-b);return {n:a.length,mean:a.reduce((s,x)=>s+x,0)/a.length,p95:a[Math.floor(a.length*.95)],max:a.at(-1)};};
    const p=reactor.modelPropsManager.preview2D;
    const debug=gl.getExtension('WEBGL_debug_renderer_info');
    return {gpuMs:stats(gpu),gpu:debug&&gl.getParameter(debug.UNMASKED_RENDERER_WEBGL),gaps:stats(gaps.slice(1)),timings:Object.fromEntries(Object.entries(__times).map(([k,v])=>[k,stats(v)])),entries:[...p.entries.values()].map(e=>({id:e.prop.id,size:e.size,draws:e.draws,meshes:(()=>{let n=0;e.object?.traverse(o=>{if(o.isMesh)n++;});return n;})()})),lights:p.lights,shadowDraws:[...p.shadows.states.values()].map(s=>({draws:s.draws,size:[s.target?.width,s.target?.height]})),errors:__previewErrors};
  })().then(v=>{v.lights=v.lights.map(({carrier,...l})=>l);done(v);},e=>done({error:String(e.stack)}));`);
  console.log('profile',JSON.stringify(profile));
  if(profile.error || profile.errors.length) throw new Error(JSON.stringify(profile));
  await driver.waitForScript("return getComputedStyle(document.getElementById('splash-screen')).display === 'none'",[],{timeout:15000});
  let shot=await driver.sessionRequest('GET','/screenshot');fs.writeFileSync(path.join(temp,'flat.png'),Buffer.from(shot,'base64'));
  console.log('zoom',JSON.stringify(await driver.executeAsync(String.raw`const done=arguments[arguments.length-1];(async()=>{
    const m=reactor.modelPropsManager,p=m.preview2D,wait=ms=>new Promise(r=>setTimeout(r,ms));
    m.tilemapManager.container.scale.set(1);m.tilemapManager.container.position.set(-750,-650);
    await wait(8000);const entries=[...p.entries.values()].filter(e=>e.media?.plays.some(play=>play.visible));
    if(!entries.length)throw new Error('No visible models after zoom/pan');
    for(const e of entries)if(e.size+1<Math.min(4096,e.radius*2*e.tw*p.app.renderer.resolution))throw new Error('Zoom left a low-resolution texture');
    return {passed:true,visible:entries.length,sizes:entries.map(e=>e.size)};
  })().then(done,e=>done({error:String(e.stack)}));`)));
  shot=await driver.sessionRequest('GET','/screenshot');fs.writeFileSync(path.join(temp,'zoom.png'),Buffer.from(shot,'base64'));
  await driver.executeAsync(String.raw`const done=arguments[arguments.length-1];reactor.applyMap3DViewPreference(true).then(()=>{const m=reactor.mapEditor3D;m.view={yaw:0,pitch:55,distance:70,target:{x:25,y:0,z:25}};m.applyCamera();setTimeout(done,2500);}).catch(e=>done(String(e.stack)));`);
  shot=await driver.sessionRequest('GET','/screenshot');fs.writeFileSync(path.join(temp,'three.png'),Buffer.from(shot,'base64'));
  console.log('artifacts',temp);
 } finally { await driver.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
