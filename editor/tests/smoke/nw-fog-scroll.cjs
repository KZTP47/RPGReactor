const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { WebDriverClient } = require('./webdriver-client.cjs');
const root = path.resolve(__dirname, '../../..');
const source = path.join(root, 'template/Star Shift Rebellion');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-fog-scroll-'));
const project = path.join(temp, 'Rebellion');
let driver;
(async () => {
 try {
  fs.mkdirSync(project);
  for (const name of ['data', 'js', 'icon']) fs.cpSync(path.join(source, name), path.join(project, name), {recursive:true});
  for (const name of ['img', 'audio', 'movies', 'fonts', 'effects', 'css', '3d']) if (fs.existsSync(path.join(source, name))) fs.symlinkSync(path.join(source, name), path.join(project, name));
  for (const name of ['index.html', 'package.json']) fs.copyFileSync(path.join(source, name), path.join(project, name));
  fs.copyFileSync(path.join(root, 'runtime/reactor_mv_compat.js'), path.join(project, 'js/reactor_mv_compat.js'));
  driver = new WebDriverClient(path.join(root, 'nwjs-linux/chromedriver'));
  await driver.start();
  await driver.createSession({browserName:'chrome', 'goog:chromeOptions':{args:[`nwapp=${project}`, `user-data-dir=${temp}/profile`, 'no-first-run']}});
  await driver.setScriptTimeout(90000);
  await driver.waitForScript('return !!window.SceneManager?._scene?._spriteset && SceneManager._scene.isActive() && !SceneManager.isSceneChanging();', [], {timeout:90000});
  await driver.execute('nw.Window.get().focus();');
  await driver.waitForScript('return $gameMap.mapId()===207 && !$gamePlayer.isTransferring() && !!SceneManager._scene._spriteset?._fogEffects?.[1]?.bitmap?.isReady();', [], {timeout:90000});
  await driver.waitForScript('return [2,3,4].every(id=>SceneManager._scene._spriteset._characterSprites.some(s=>s._character===$gameMap.event(id)&&s.bitmap?.isReady()&&s.bitmap.width>0));', [], {timeout:15000});
  await driver.execute('window.__fogSprites=[1,2].map(id=>SceneManager._scene._spriteset._fogEffects[id]);');
  const sample = () => driver.execute(`
   const ss=SceneManager._scene._spriteset;
   const fogs=[1,2].map((id,i)=>{
    const s=ss._fogEffects[id];
    const canvas=Graphics.app.renderer.extract.canvas({target:s});
    const bytes=canvas.getContext('2d',{willReadFrequently:true}).getImageData(0,0,canvas.width,canvas.height).data;
    let hash=0,visible=0;for(let j=0;j<bytes.length;j++){hash=(hash*31+bytes[j])|0;if(j%4===3&&bytes[j])visible++;}
    return {id,origin:[s.origin.x,s.origin.y],tile:[s.tilePosition.x,s.tilePosition.y],same:s===__fogSprites[i],hash,visible};
   });
   const ships=[2,3,4].map(id=>{const s=ss._characterSprites.find(s=>s._character===$gameMap.event(id)),b=s.getBounds().rectangle;return {id,bounds:{x:b.x,y:b.y,w:b.width,h:b.height},alpha:s.worldAlpha??s.alpha,visible:s.visible&&s.worldVisible!==false&&(s.worldAlpha??s.alpha)>0&&b.x+b.width>0&&b.y+b.height>0&&b.x<Graphics.width&&b.y<Graphics.height,frameWidth:s.texture.frame.width};});
   return {map:$gameMap.mapId(),threeD:!!ss._reactor3d,stopped:!!SceneManager._stopped,fogs,ships};
  `);
  const before=await sample();
  await driver.executeAsync('const done=arguments[arguments.length-1];setTimeout(()=>done(true),1500);');
  const after=await sample();
  console.log(JSON.stringify({before,after},null,2));
  assert.equal(after.map,207);assert.equal(after.threeD,false);assert.equal(after.stopped,false);
  for(let i=0;i<2;i++){
   const a=before.fogs[i],b=after.fogs[i];
   assert.equal(b.same,true,'fog sprite survives normal updates');
   assert.notDeepEqual(a.origin,b.origin,'plugin scroll advances');
   assert.deepEqual(b.tile,b.origin.map(v=>Math.round(-v)),'render scroll matches plugin origin');
   assert.notEqual(a.hash,b.hash,'rendered sand pixels move');assert.ok(b.visible>0);
  }
  for(const ship of after.ships){assert.equal(ship.visible,true,'ship '+ship.id+' is on screen');assert.ok(ship.frameWidth>0);}
  if (process.env.RR_FOG_OPACITY === '1') {
   const comparison=await driver.executeAsync(`
    const done=arguments[arguments.length-1],legacyPath=arguments[0],fs=require('fs'),path=require('path');
    (async()=>{
     const iframe=document.createElement('iframe');document.body.appendChild(iframe);const w=iframe.contentWindow;
     for(const name of ['libs/pixi.js','libs/pixi-tilemap.js','libs/pixi-picture.js','rpg_core.js']){const code=fs.readFileSync(path.join(legacyPath,name),'utf8');if(name==='libs/pixi.js')w.Function('module','exports','require',code)();else w.eval(code);}
     const ss=SceneManager._scene._spriteset,source=ss._fogEffects[1].bitmap._image;
     const pixels=(bytes)=>{let sum=0,peak=0;for(let i=3;i<bytes.length;i+=4){sum+=bytes[i];peak=Math.max(peak,bytes[i]);}return {sum,peak};};
     const renderer=new w.PIXI.WebGLRenderer(256,256,{transparent:true,preserveDrawingBuffer:true});
     const oldBitmap=w.Bitmap.load(source.src);await new Promise(resolve=>oldBitmap.addLoadListener(resolve));
     const oldSprite=new w.TilingSprite(oldBitmap);oldSprite.move(0,0,256,256);oldSprite.origin.x=100;oldSprite.origin.y=200;
     const current=new TilingSprite(ss._fogEffects[1].bitmap);current.move(0,0,256,256);current.origin.x=100;current.origin.y=200;
     const results=[];
     for(const opacity of [0,100,192,255]){
      oldSprite.opacity=opacity;current.opacity=opacity;
      const stage=new w.PIXI.Container();stage.addChild(oldSprite);renderer.render(stage);
      const legacy=pixels(renderer.extract.pixels());
      const canvas=Graphics.app.renderer.extract.canvas({target:current});const modern=pixels(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data);
      results.push({opacity,legacy,modern,alpha:current.alpha});stage.removeChild(oldSprite);
     }
     current.destroy();oldSprite.destroy();renderer.destroy();iframe.remove();return results;
    })().then(done,e=>done(String(e.stack)));
   `,[path.join(source,'js/MV Corescript')]);
   console.log('Original MV / Reactor fog opacity comparison',JSON.stringify(comparison));
   assert.ok(Array.isArray(comparison),String(comparison));
   for(const row of comparison){assert.ok(Math.abs(row.legacy.peak-row.modern.peak)<=1,JSON.stringify(row));assert.ok(Math.abs(row.legacy.sum-row.modern.sum)<=Math.max(100,row.legacy.sum*.02),JSON.stringify(row));}
  }
  fs.writeFileSync('/tmp/rr-fog-scroll.png', Buffer.from(await driver.sessionRequest('GET','/screenshot'), 'base64'));
  const errors=(await driver.sessionRequest('POST','/log',{type:'browser'})).filter(e=>/TypeError|ReferenceError|ERR_FILE_NOT_FOUND|GL_INVALID|does not belong/.test(e.message));assert.deepEqual(errors,[],JSON.stringify(errors));
  console.log('Rebellion native fog scroll and all three title ships passed.');
 } catch (error) { console.log(await driver.execute('return {text:document.body.innerText,scene:window.SceneManager?._scene?.constructor.name};')); console.log((await driver.sessionRequest('POST','/log',{type:'browser'})).slice(-20)); throw error; } finally { await driver?.close(); fs.rmSync(temp,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1;});
