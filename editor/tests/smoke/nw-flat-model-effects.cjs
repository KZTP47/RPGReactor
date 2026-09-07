const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {WebDriverClient}=require('./webdriver-client.cjs');
const root=path.resolve(__dirname,'../../..'),source=path.join(root,'template/Demo');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rr-flat-model-lighting-')),project=path.join(temp,'Demo');
const driver=new WebDriverClient(path.join(root,'nwjs-linux/chromedriver'));
(async()=>{try {
    fs.mkdirSync(project);
    for(const name of ['index.html','package.json','project.rpgreactor'])fs.copyFileSync(path.join(source,name),path.join(project,name));
    for(const name of ['data','js','icon'])fs.cpSync(path.join(source,name),path.join(project,name),{recursive:true});
    for(const name of ['img','audio','fonts','3d','effects','css'])if(fs.existsSync(path.join(source,name)))fs.symlinkSync(path.join(source,name),path.join(project,name));
    await driver.start();await driver.createSession({browserName:'chrome','goog:chromeOptions':{args:[`nwapp=${path.join(root,'editor')}`,`user-data-dir=${path.join(temp,'profile')}`,'no-first-run']}});
    await driver.setScriptTimeout(90000);
    await driver.waitForScript('return !!window.reactor?.projectController;',[],{timeout:90000});
    const result=await driver.executeAsync(`
        const projectPath=arguments[0],done=arguments[arguments.length-1];
        (async()=>{
            const app=reactor,pc=app.projectController;pc.currentProject=await app.projectManager.loadProject(projectPath);pc.projectLoaded=true;
            nw.Window.get().resizeTo(1600,1000);nw.Window.get().focus();await app.uiManager.showEditorUI();await pc.populateProjectUI();
            app.tilesetPaletteViewer.selectLayer('M');
            const manager=app.modelPropsManager;
            const prop=manager.props().find(p=>p.name.includes('RPGReactor'));
            if(!prop)throw Error('No Reactor prop on Demo map');manager.select(prop.id);
            window.__props=manager;
            return {id:prop.id,name:prop.name};
        })().then(done,e=>done({error:String(e.stack)}));
    `,[project]);assert.ok(result.id,JSON.stringify(result));
    await driver.waitForScript("return getComputedStyle(document.getElementById('splash-screen')).display==='none';",[],{timeout:15000});
    await driver.waitForScript('const img=__props.panel.querySelector("#model-props-preview img");return img?.complete && img.naturalWidth>0;',[],{timeout:30000});
    await driver.execute('reactor.mapEditor3D.setEnabled(false); __props.select(null);');
    await driver.waitForScript('return !!__props.preview2D.entries.get(arguments[0])?.lighting;', [result.id], {timeout:60000});
    const framed=await driver.execute(`
        const entry=__props.preview2D.entries.get(arguments[0]), c=__props.tilemapManager.container;
        window.__reactorEntry=entry;
        c.scale.set(.65);c.position.set(__props.preview2D.app.screen.width/2-(entry.prop.x+.5)*48*.65,
            __props.preview2D.app.screen.height/2-(entry.prop.y-5)*48*.65);
        return {effects:entry.effects.map(e=>({name:e.name,animation:e.animation})),plays:entry.media.plays.map(p=>({name:p.record?.name,effect:p.record?.effectName}))};
    `,[result.id]);console.log(framed);
    await driver.waitForScript('return __reactorEntry.media.plays.some(p=>p.layer?.fx.handle?.exists);',[],{timeout:60000});
    await driver.executeAsync('setTimeout(arguments[arguments.length-1],900);');
    fs.writeFileSync('/tmp/rr-reactor-effect-after.png',Buffer.from(await driver.sessionRequest('GET','/screenshot'),'base64'));
    const check=await driver.execute(`
        const entry=__reactorEntry, preview=__props.preview2D;
        preview.app.ticker.remove(preview._tick,preview);
        const plays=entry.media.plays.filter(p=>p.quad);
        for(const play of plays){if(play.layer.fx.raf)cancelAnimationFrame(play.layer.fx.raf);play.layer.fx.raf=null;}
        const viewport=preview.ensureViewport(),renderer=viewport.renderer();
        const read=()=>{viewport.renderInto(entry.target,entry.scene,entry.camera);const p=new Uint8Array(entry.size*entry.size*4);renderer.readRenderTargetPixels(entry.target,0,0,entry.size,entry.size,p);return p;};
        for(const play of plays)play.quad.mesh.visible=false;
        const base=read();
        for(const play of plays)play.quad.mesh.visible=true;
        const occluded=read();
        for(const play of plays)play.quad.material.depthTest=false;
        const through=read();
        for(const play of plays)play.quad.material.depthTest=true;
        let blocked=0,visible=0;
        for(let i=0;i<base.length;i+=4){
            const difference=(a,b)=>Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2]);
            if(difference(through,base)>12&&difference(occluded,base)<3)blocked++;
            if(difference(occluded,base)>12)visible++;
        }
        const details=plays.map(p=>({world:!!p.layer.world,gpu:!!p.layer.fx.gpu,overlay:p.layer.wrap.style.display,depth:p.quad.material.depthTest}));
        const gpu=plays.map(p=>p.layer.fx.gpu),clips=plays.map(p=>p.clip),meshes=plays.map(p=>p.quad.mesh);
        entry.media.suspend();const hidden=meshes.every(m=>!m.visible)&&plays.every(p=>!p.layer.active);
        entry.media.dispose();
        return {blocked,visible,details,hidden,cleaned:meshes.every(m=>!m.parent)&&clips.every(c=>!c.isConnected)&&gpu.every(g=>g.disposed&&g.targets.size===0)};
    `);
    console.log(JSON.stringify(check,null,2));
    assert.ok(check.blocked>100,'reactor geometry blocks effect pixels');
    assert.ok(check.visible>100,'the exposed core effect remains visible');
    assert.ok(check.details.length>0&&check.details.every(p=>p.world&&p.gpu&&p.overlay==='none'&&p.depth));
    assert.equal(check.hidden,true);assert.equal(check.cleaned,true);
    console.log('Flat model effects passed: actual reactor depth occlusion, visible core, hidden DOM overlays and playback/target cleanup.');
}finally{await driver.close();fs.rmSync(temp,{recursive:true,force:true});}})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
