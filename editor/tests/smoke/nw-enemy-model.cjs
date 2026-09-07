// Actual mascot preview and battle rendering in a disposable Demo copy.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { WebDriverClient } = require('./webdriver-client.cjs');
const root = path.resolve(__dirname, '../../..'), source = path.join(root, 'template/Demo');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-enemy-model-')), project = path.join(temp, 'Demo');
let driver;
async function launch(app) {
    driver = new WebDriverClient(path.join(root, 'nwjs-linux/chromedriver'));
    await driver.start();
    await driver.createSession({browserName:'chrome','goog:chromeOptions':{args:[`nwapp=${app}`,`user-data-dir=${path.join(temp, 'profile-'+path.basename(app))}`,'no-first-run']}});
    await driver.setScriptTimeout(90000);
}
(async () => { try {
    fs.mkdirSync(project);
    for (const name of ['index.html','package.json','project.rpgreactor']) fs.copyFileSync(path.join(source,name),path.join(project,name));
    for (const name of ['data','js','icon']) fs.cpSync(path.join(source,name),path.join(project,name),{recursive:true});
    for (const name of ['img','audio','fonts','3d','effects','css']) if(fs.existsSync(path.join(source,name))) fs.symlinkSync(path.join(source,name),path.join(project,name));
    const bindings = JSON.parse(fs.readFileSync(path.join(project,'data/Database.r3d.json')));
    const bound = Object.entries(bindings.enemies || {}).find(([,v])=>/psychronic/i.test(v.name));
    assert.ok(bound, 'Demo has an authored Psychronic enemy');
    const enemyId = Number(bound[0]);
    await launch(path.join(root,'editor'));
    await driver.waitForScript('return !!window.reactor?.projectController;', [], {timeout:90000});
    await driver.waitForScript("return getComputedStyle(document.getElementById('splash-screen')).display==='none';",[],{timeout:15000});
    const loaded = await driver.executeAsync(`
        const done=arguments[arguments.length-1], projectPath=arguments[0], id=arguments[1];
        (async()=>{
            const app=reactor,pc=app.projectController;
            pc.currentProject=await app.projectManager.loadProject(projectPath);pc.projectLoaded=true;
            nw.Window.get().resizeTo(1280,900);await app.uiManager.showEditorUI();await pc.populateProjectUI();
            window.__enemyErrors=[];addEventListener('error',e=>__enemyErrors.push(String(e.error||e.message)));
            app.openDatabase('enemies');
            app.databaseEditorUI.showDatabaseDetail(app.databaseManager.getEnemies().find(e=>e.id===id),'enemies');
            return true;
        })().then(done,e=>done({error:String(e.stack)}));
    `, [project, enemyId]); assert.equal(loaded,true,JSON.stringify(loaded));
    await driver.waitForScript('const img=document.querySelector(`#enemy-battler-preview-${arguments[0]} img`);return !!img?.complete && img.naturalWidth>0;', [enemyId], {timeout:60000});
    const layout = await driver.execute(`
        const inputs=[...document.querySelectorAll('.enemy-param-input')];
        const measure=()=>inputs.map(input=>{const r=(input.closest('.rr-number-stepper')||input).getBoundingClientRect();return {x:r.x,width:r.width};});
        const before=measure();inputs[0].value='123456789012345';inputs[0].dispatchEvent(new Event('input',{bubbles:true}));
        return {exclusive:[...document.querySelectorAll('.enemy-image-controls')].every(e=>getComputedStyle(e).display==='none'&&[...e.querySelectorAll('input,button[id]')].every(i=>i.disabled)),before,after:measure(),model:document.querySelector('[id^=enemy-battler-preview-]').dataset.model,errors:__enemyErrors};
    `);
    assert.equal(layout.before.length,9);assert.equal(new Set(layout.before.map(r=>r.width)).size,1);
    assert.equal(new Set(layout.before.map(r=>r.x)).size,1);assert.deepEqual(layout.after,layout.before);
    assert.equal(layout.exclusive,true);assert.equal(layout.model,'true'); assert.deepEqual(layout.errors,[]);
    fs.writeFileSync('/tmp/rr-enemy-preview.png', Buffer.from(await driver.sessionRequest('GET','/screenshot'),'base64'));
    // Clearing the binding restores the existing image without rewriting it.
    await driver.execute(`
        window.__enemySpec=RRDatabase3DBindings.get(arguments[0],'enemies',arguments[1]);
        document.querySelector('.rr-3d-binding-check').click();
    `,[project,enemyId]);
    assert.equal(await driver.execute("return document.querySelector('[id^=enemy-battler-preview-]').dataset.model;"),'');
    assert.equal(await driver.execute("return [...document.querySelectorAll('.enemy-image-controls')].every(e=>getComputedStyle(e).display!=='none'&&[...e.querySelectorAll('input,button[id]')].every(i=>!i.disabled));"),true);
    await driver.execute(`
        RRDatabase3DBindings.set(arguments[0],'enemies',arguments[1],__enemySpec);
        const db=reactor.databaseManager;const troop=db.getTroops().find(t=>t?.members?.some(m=>m.enemyId===arguments[1]));
        window.__testTroop=troop||{id:1,name:'Preview fixture',members:[{enemyId:arguments[1],x:300,y:400,hidden:false}],pages:[]};
        reactor.databaseEditorUI.openDatabase('troops');reactor.databaseEditorUI.showDatabaseDetail(__testTroop,'troops');
    `,[project,enemyId]);
    await driver.waitForScript('return !!reactor.databaseEditorUI.troopEditor.enemyModelImages[arguments[0]]?.image?.naturalWidth;',[enemyId],{timeout:60000});
    const troop = await driver.execute(`const e=reactor.databaseEditorUI.troopEditor;e.renderCanvas();return {bounds:e.enemySpriteBounds.length,errors:__enemyErrors};`);
    assert.ok(troop.bounds>0);assert.deepEqual(troop.errors,[]);
    fs.writeFileSync('/tmp/rr-troop-model-preview.png',Buffer.from(await driver.sessionRequest('GET','/screenshot'),'base64'));
    console.log('Editor passed: authored Psychronic thumbnail, nine equal parameter fields, stable typing, 2D fallback, troop placement.');
    await driver.close();
    // Keep the fixture's battle independent of map autoruns and enemy skills.
    const enemies=JSON.parse(fs.readFileSync(path.join(project,'data/Enemies.json')));
    enemies[enemyId].actions=[];enemies[enemyId].battlerName='';
    fs.writeFileSync(path.join(project,'data/Enemies.json'),JSON.stringify(enemies));
    const troops=JSON.parse(fs.readFileSync(path.join(project,'data/Troops.json')));
    troops[1]={id:1,name:'3D enemy fixture',members:[{enemyId,x:400,y:500,hidden:false}],pages:[]};
    fs.writeFileSync(path.join(project,'data/Troops.json'),JSON.stringify(troops));
    await launch(project);
    await driver.waitForScript('return !!window.$dataSystem && !!window.SceneManager?._scene && !SceneManager.isSceneChanging() && (SceneManager._scene instanceof Scene_Title || SceneManager._scene._role==="title");',[],{timeout:90000});
    await driver.execute(`window.__battleErrors=[];addEventListener('error',e=>__battleErrors.push(String(e.error||e.message)));DataManager.setupNewGame();BattleManager.setup(1,true,true);SceneManager.goto(Scene_Battle);`);
    await driver.waitForScript('return !!SceneManager._scene?._spriteset?._enemySprites?.[0]?._reactorBattler?.target;',[],{timeout:60000});
    await driver.waitForScript('return SceneManager._scene._spriteset._enemySprites[0]._reactorBattler.frame>100 && SceneManager._scene._fadeDuration===0;',[],{timeout:30000});
    const pixels=await driver.execute(`
        const sprite=SceneManager._scene._spriteset._enemySprites[0],state=sprite._reactorBattler;
        const p=new Uint8Array(state.target.width*state.target.height*4);
        Reactor3D.acquireViewport().renderer().readRenderTargetPixels(state.target,0,0,state.target.width,state.target.height,p);
        let visible=0;for(let i=3;i<p.length;i+=4)if(p[i]>0)visible++;
        return {visible,frame:state.frame,errors:__battleErrors,box:new THREE.Box3().setFromObject(state.object),camera:state.camera.position.toArray(),bitmapSize:state.size,spriteFrame:sprite._frame};
    `);
    assert.ok(pixels.visible>100,JSON.stringify(pixels));assert.ok(pixels.frame>0);assert.deepEqual(pixels.errors,[]);
    assert.equal(pixels.spriteFrame.width,pixels.bitmapSize);assert.equal(pixels.spriteFrame.height,pixels.bitmapSize);
    assert.equal(pixels.spriteFrame.x,0);assert.equal(pixels.spriteFrame.y,0);
    fs.writeFileSync('/tmp/rr-enemy-battle.png',Buffer.from(await driver.sessionRequest('GET','/screenshot'),'base64'));
    console.log('Runtime passed:',JSON.stringify(pixels));
} catch (error) {
    try { console.log('Diagnostic:', await driver.execute("return {body:document.body.innerText.slice(-7000), errors:window.__enemyErrors||window.__battleErrors, enemy:window.reactor?.databaseEditorUI?.enemyEditor?.currentEnemy?.id};")); } catch {}
    throw error;
} finally { await driver?.close();fs.rmSync(temp,{recursive:true,force:true}); }
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
