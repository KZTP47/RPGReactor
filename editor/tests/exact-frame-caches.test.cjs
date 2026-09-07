const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.resolve(__dirname,'../..');const R=require(path.join(root,'runtime/reactor_3d.js'));require(path.join(root,'runtime/libs/three.js'));
const V=require(path.join(root,'runtime/reactor_media_surfaces.js'));
test('video cache accepts only unchanged canonical descriptors and valid playback-clock changes',()=>{
 const m=new V.VideoSurfaceManager(),raw={id:2,file:'panel.webm',target:'player',anchor:{part:'Screen',offset:[0,1,0],size:[2,3]}};
 const a=m.storedDescriptor(raw);assert.ok(a);assert.equal(m.storedDescriptor(a),a);a.currentTime=4.25;assert.equal(m.storedDescriptor(a),a);
 for(const change of [x=>x.anchor.offset[1]=3,x=>x.corners[0].x=17,x=>x.rotationZ=45,x=>x.opacity=.25,x=>x.anchor.size[1]=7,x=>x.playbackRate=2]){
  const value=m.storedDescriptor(JSON.parse(JSON.stringify(a)));change(value);const expected=V.normalizeShowArgs(value,null);const result=m.storedDescriptor(value);assert.deepEqual(result,expected);assert.notEqual(result,value);assert.equal(m.storedDescriptor(result),result);
 }
 const bad=m.storedDescriptor(a);bad.currentTime=NaN;assert.equal(m.storedDescriptor(bad),null);
 const other=m.storedDescriptor(raw);other.file='../escape.mp4';assert.equal(m.storedDescriptor(other),null);
 const removed=m.storedDescriptor(raw);delete removed.width;assert.deepEqual(m.storedDescriptor(removed),V.normalizeShowArgs(removed,null));
});
test('sparse light updates match a fresh grid through bit 31, removals, shape changes and moving origins',()=>{
 const U=R.lightUniforms(),G=R.LightGrid;let seed=247;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 for(let frame=0;frame<170;frame++){
  const count=frame<60?32:frame<100?8:24;U.rrLightCount.value=count;
  const slots=frame%17===0?count:5;
  for(let n=0;n<slots;n++){const i=frame%17===0?n:Math.floor(random()*count),a=i*4;U.rrLightPos.value.set([random()*60,random()*20,random()*60,random()*20],a);U.rrLightColor.value[a+3]=i%3;
   const angle=random()*6.28;U.rrLightAim.value.set([Math.cos(angle),0,Math.sin(angle),i%3===2?random()*3:.7],a);}
  G.updateCached(U,{x:Math.floor(frame/30)*8,y:24,groundY:0});const ref=new Uint32Array(G.size[0]*G.size[1]*G.size[2]);G.fill(ref,U.rrLightGridOrigin.value,count,U.rrLightPos.value,U.rrLightColor.value,U.rrLightAim.value);assert.deepEqual(U.rrLightGrid.value.image.data,ref,'frame '+frame);
  const v=U.rrLightGrid.value.version;U.rrLightColor.value[0]=random();G.updateCached(U,{x:Math.floor(frame/30)*8,y:24,groundY:0});assert.equal(U.rrLightGrid.value.version,v,'colour alone never changes cell masks');
 }
});

test('effect scissors round outward and restore the caller target state',()=>{
 const T=global.THREE,q=R.EffekseerScene.quadFor({}),u=q.material.uniforms;
 u.resolution.value.set(100,80);u.rectMin.value.set(.123,.208);u.rectSize.value.set(.321,.413);
 const target={width:100,height:80,scissorTest:false,scissor:new T.Vector4(0,0,100,80)},rects=[],flags=[];
 const renderer={getRenderTarget:()=>target,getScissorTest:()=>false,state:{scissor:r=>rects.push(r.toArray()),setScissorTest:f=>flags.push(f)}};
 q.mesh.onBeforeRender(renderer);assert.deepEqual(rects[0],[12,16,33,34]);q.mesh.onAfterRender(renderer);
 assert.deepEqual(rects[1],[0,0,100,80]);assert.deepEqual(flags,[true,false]);assert.equal(target.scissorTest,false);
 target.scissorTest=true;q.mesh.onBeforeRender(renderer);q.mesh.onAfterRender(renderer);assert.equal(rects.length,2);
 target.scissorTest=false;target.width=50;q.mesh.onBeforeRender(renderer);q.mesh.onAfterRender(renderer);assert.equal(rects.length,2,'a different pass keeps its own state');
});
