// Real game command/audio clock against the mascot's authored landmarks.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { WebDriverClient } = require('./webdriver-client.cjs');
const root = path.resolve(__dirname, '../../..'), source = path.join(root, 'template/Demo');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-speech-game-')), project = path.join(temp, 'Demo');
const driver = new WebDriverClient(path.join(process.env.NWJS_SDK_ROOT || path.join(root, 'nwjs-linux'), 'chromedriver'));
function waveform() {
    const rate = 12000, length = rate * 3, data = Buffer.alloc(44 + length * 2);
    data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
    data.writeUInt32LE(16,16); data.writeUInt16LE(1,20); data.writeUInt16LE(1,22);
    data.writeUInt32LE(rate,24); data.writeUInt32LE(rate*2,28); data.writeUInt16LE(2,32); data.writeUInt16LE(16,34);
    data.write('data',36); data.writeUInt32LE(length*2,40);
    for(let i=0;i<length;i++) { const t=i/rate, voiced=(t>.4 && t<1.2)||(t>1.6 && t<2.4); data.writeInt16LE(voiced ? Math.round(Math.sin(t*440*Math.PI*2)*11000) : 0,44+i*2); }
    return data;
}
(async()=>{try {
    fs.mkdirSync(project);
    for(const name of ['index.html','package.json','project.rpgreactor']) fs.copyFileSync(path.join(source,name),path.join(project,name));
    for(const name of ['data','js','icon']) fs.cpSync(path.join(source,name),path.join(project,name),{recursive:true});
    for(const name of ['img','fonts','3d','effects','css']) if(fs.existsSync(path.join(source,name))) fs.symlinkSync(path.join(source,name),path.join(project,name),'junction');
    fs.mkdirSync(path.join(project,'audio/se'),{recursive:true});
    for(const name of fs.readdirSync(path.join(source,'audio'))) if(name!=='se') fs.symlinkSync(path.join(source,'audio',name),path.join(project,'audio',name),'junction');
    for(const name of fs.readdirSync(path.join(source,'audio/se'))) fs.symlinkSync(path.join(source,'audio/se',name),path.join(project,'audio/se',name));
    fs.writeFileSync(path.join(project,'audio/se/__speech_fixture.wav'),waveform());
    const map=JSON.parse(fs.readFileSync(path.join(project,'data/Map001.json')));
    map.events=map.events.map(e=>e?.id===3?e:null);
    map.events[3].x=24;map.events[3].y=47;map.events[3].pages[0].moveType=0;map.events[3].pages[0].trigger=0;map.events[3].pages[0].list=[{code:0,indent:0,parameters:[]}];
    fs.writeFileSync(path.join(project,'data/Map001.json'),JSON.stringify(map));
    await driver.start(); await driver.createSession({browserName:'chrome','goog:chromeOptions':{args:[`nwapp=${project}`,`user-data-dir=${path.join(temp,'profile')}`,'no-first-run']}});
    await driver.setScriptTimeout(30000);
    await driver.waitForScript('return window.SceneManager?._scene && window.$dataSystem && !SceneManager.isSceneChanging() && (SceneManager._scene instanceof Scene_Title || SceneManager._scene._role === "title");',[],{timeout:90000});
    await driver.execute(`window.__speechErrors=[];window.addEventListener('error',e=>__speechErrors.push(String(e.error||e.message)));nw.Window.get().focus();DataManager.setupNewGame();SceneManager.goto(Scene_Map);`);
    await driver.waitForScript('return SceneManager._scene instanceof Scene_Map && !!Reactor3D.modelHolderFor($gameMap.event(3))?.object;',[],{timeout:60000});
    const result=await driver.executeAsync(`
        const done=arguments[arguments.length-1], character=$gameMap.event(3), S=Reactor3D.Speech;
        const interpreter=new Game_Interpreter();interpreter.setup([],3);
        const object=Reactor3D.modelHolderFor(character).object;
        const driver=S.prepare(object);
        PluginManager.callCommand(interpreter,'RPGReactor','SpeakModel3D',{target:'3',audio:'__speech_fixture',volume:'0',pitch:'125',wait:'true'});
        const state=S.active.get(character), samples=[];
        let peak=0,silence=0,changed=0;
        const geometry=object.children;
        const start=performance.now();
        const sample=()=>{
            const t=state.buffer.seek(), value=S.levelAt(state.buffer,t);
            let influence=0;object.traverse(m=>{if(m.isMesh&&m.morphTargetInfluences)influence=Math.max(influence,...m.morphTargetInfluences);});
            peak=Math.max(peak,influence);
            if(t>.1&&t<.3&&influence<.001)silence++;
            if(t>1.3&&t<1.5&&influence<.001)silence++;
            samples.push({t,value,influence});
            if(!S.active.has(character)||performance.now()-start>6000){
                const waiting=interpreter.updateWaitMode();
                return done({kind:driver.kind,peak,silence,ended:!S.active.has(character),waiting,
                    finalInfluence:influence,ready:state.buffer._isLoaded,samples:samples.filter((_,i)=>i%10===0),errors:__speechErrors});
            }
            setTimeout(sample,16);
        };sample();
    `);
    console.log(JSON.stringify(result,null,2));
    assert.equal(result.kind,'lipMorph');assert.ok(result.peak>.5);assert.ok(result.silence>0);
    assert.equal(result.ended,true);assert.equal(result.waiting,false);assert.equal(result.finalInfluence,0);assert.deepEqual(result.errors,[]);
    console.log('Game speech passed: actual mascot, real decoded audio, pitched waveform, silent intervals, stop/reset and interpreter wait.');
} catch(error) {try { console.log(await driver.execute('return {scene:SceneManager?._scene?.constructor.name,event:!!$gameMap?.event(3),holder:!!Reactor3D.modelHolderFor($gameMap.event(3)),text:document.body.innerText};')); } catch {} throw error;
} finally {await driver.close();fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
