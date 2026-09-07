const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {WebDriverClient}=require('./webdriver-client.cjs');
const root=path.resolve(__dirname,'../../..'),source=path.join(root,'template/Demo');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rr-props-quality-')),project=path.join(temp,'Demo');
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
    for(const [width,height] of [[1280,720],[1600,1000]]) {
        const layout=await driver.executeAsync(`
            const done=arguments[arguments.length-1];nw.Window.get().resizeTo(arguments[0],arguments[1]);
            setTimeout(()=>{
                const panel=__props.panel,settings=panel.querySelector('.mp-settings'),preview=panel.querySelector('#model-props-preview');
                const sections=[...settings.querySelectorAll('[data-props-section]')];
                const measurements=[];
                for(const section of sections){section.open=true;const r=preview.getBoundingClientRect(),p=panel.getBoundingClientRect();measurements.push({open:sections.filter(s=>s.open).length,previewHeight:r.height,inside:r.top>=p.top&&r.bottom<=p.bottom,contentHeight:settings.scrollHeight});}
                settings.scrollTop=settings.scrollHeight;
                const r=preview.getBoundingClientRect(),p=panel.getBoundingClientRect();
                const canvas=document.createElement('canvas');canvas.width=canvas.height=64;const ctx=canvas.getContext('2d');ctx.drawImage(preview.querySelector('img'),0,0,64,64);
                const pixels=ctx.getImageData(0,0,64,64).data;let visiblePixels=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i]>0)visiblePixels++;
                const content=panel.querySelector('.mp-panel').getBoundingClientRect();
                done({contentWidth:content.width,panelWidth:p.width,measurements,pinned:r.top>=p.top&&r.bottom<=p.bottom,visiblePixels,preview:r.toJSON(),panel:p.toJSON(),scroll:settings.getBoundingClientRect().toJSON()});
            },250);
        `,[width,height]);
        fs.writeFileSync('/tmp/rr-compact-layout.png',Buffer.from(await driver.sessionRequest('GET','/screenshot'),'base64'));
        assert.ok(Math.abs(layout.contentWidth-layout.panelWidth)<2,'inspector fills sidebar width');
        assert.ok(layout.pinned,'preview stays visible when settings scroll: '+JSON.stringify(layout));assert.ok(layout.visiblePixels>20,'preview contains rendered model pixels');
        assert.ok(layout.measurements.every(m=>m.open===1&&m.previewHeight===64&&m.inside&&m.contentHeight<280),JSON.stringify(layout));
        console.log('Compact sidebar and visible model preview passed:',width,height,layout);
    }
    await driver.executeAsync(`const done=arguments[arguments.length-1];__props.panel.querySelector('[data-props-section=playback]').open=true;__props.panel.querySelector('.mp-settings').scrollTop=0;setTimeout(done,100);`);
    const checked=await driver.execute(`
        const manager=__props,panel=manager.panel,host=panel.querySelector('#model-props-effects'),drop=host.closest('details');
        drop.querySelector('summary').scrollIntoView({block:'center'});drop.querySelector('summary').click();
        const boxes=[...host.querySelectorAll('input')].filter(i=>i.value==='Core'||i.value==='Core (2)');
        if(boxes.length!==2)throw Error('Reactor effect choices missing');
        for(const box of boxes){box.checked=true;box.dispatchEvent(new Event('change',{bubbles:true}));}
        if(!drop.open)throw Error('Selecting a checkbox closed the dropdown');
        const search=drop.querySelector('input[type=search]');search.value='(2)';search.dispatchEvent(new Event('input',{bubbles:true}));
        if([...host.querySelectorAll('label')].filter(l=>!l.hidden).length!==1)throw Error('Effect search did not filter');
        if(manager._checkedNames('model-props-effects').length<2)throw Error('Search lost hidden selection');
        search.value='no match';search.dispatchEvent(new Event('input',{bubbles:true}));if(drop.querySelector('.mp-choice-no-results').hidden)throw Error('No-results state missing');
        search.value='';search.dispatchEvent(new Event('input',{bubbles:true}));
        const popup=drop.querySelector('.mp-choice-popup').getBoundingClientRect();
        if(popup.bottom>innerHeight || popup.top<0)throw Error('Dropdown outside viewport');
        return {effects:manager.prop(manager.selectedId).effects,headers:[...panel.querySelectorAll('.mp-section-title')].map(h=>({text:h.textContent,border:getComputedStyle(h).borderLeftWidth})),popup:popup.toJSON()};
    `);assert.ok(checked.effects.includes('Core')&&checked.effects.includes('Core (2)'));assert.ok(checked.headers.every(h=>h.border==='3px'));
    assert.equal(await driver.executeAsync(`const done=arguments[arguments.length-1];setTimeout(()=>{const d=__props.panel.querySelector('#model-props-effects').closest('details');if(!d.open)d.querySelector('summary').click();requestAnimationFrame(()=>done(d.open));},100);`),true);
    fs.writeFileSync('/tmp/rr-model-props-dropdown.png',Buffer.from(await driver.sessionRequest('GET','/screenshot'),'base64'));
    const actor=await driver.execute(`
        const manager=__props,drop=manager.panel.querySelector('#model-props-effects').closest('details');
        drop.querySelector('input[type=search]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));if(drop.open)throw Error('Escape did not close');
        manager.chooseModel({name:'Actors/Fleagus',ext:'.glb',file:'Fleagus'});manager.fields.size=2;const id=manager.place(10,10);manager.select(id);
        const host=manager.panel.querySelector('#model-props-animations'),animationDrop=host.closest('details');animationDrop.querySelector('summary').click();
        for(const box of host.querySelectorAll('input')){box.checked=true;box.dispatchEvent(new Event('change',{bubbles:true}));}
        const animations=manager.prop(id).animations;
        document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));if(animationDrop.open)throw Error('Outside click did not close');
        const before=manager.prop(id).size;manager.panel.querySelector('[data-props-section=transform]').open=true;manager._cardTab='scale';manager._renderCard();
        const num=manager.panel.querySelector('.mp-card-num[data-key=size]');num.value='3.5';num.dispatchEvent(new Event('change',{bubbles:true}));
        if(manager.prop(id).size!==3.5 || Number(manager.panel.querySelector('#model-props-size').value)!==3.5)throw Error('Transform edit failed');
        manager.panel.querySelector('[data-props-section=playback]').open=true;
        const repeat=manager.panel.querySelector('#model-props-repeat');repeat.checked=true;repeat.dispatchEvent(new Event('change',{bubbles:true}));
        if(manager.prop(id).size!==3.5)throw Error('Playback edit reverted the transform');
        return {id,animations,before};
    `);assert.deepEqual(actor.animations,['Running','Walking']);
    assert.equal(await driver.executeAsync('const done=arguments[arguments.length-1];reactor.projectController.saveProject().then(done,e=>done({error:String(e)}));'),true);
    const saved=JSON.parse(fs.readFileSync(path.join(project,'data/Map001.r3d.json')));
    assert.deepEqual(saved.props.find(p=>p.id===actor.id).animations,['Running','Walking']);
    assert.ok(saved.props.find(p=>p.id===result.id).effects.includes('Core (2)'));
    console.log('3D-M native checks passed: themed cards, live transforms, searchable multi-select, retained hidden selections, Escape/outside close, and map save.');
} catch(error) {
    try { console.log(await driver.execute('return {preview:!!__props?.panel?.querySelector("#model-props-preview img"),token:__props?._previewToken,model:__props?.model,panel:__props?.panel?.getBoundingClientRect().toJSON()};'));fs.writeFileSync('/tmp/rr-compact-layout.png',Buffer.from(await driver.sessionRequest('GET','/screenshot'),'base64'));}catch(_){}
    throw error;
} finally {await driver.close();fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
