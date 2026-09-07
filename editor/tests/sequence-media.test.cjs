const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const B=require('../../runtime/reactor_battle_data.js');
const read=name=>fs.readFileSync(path.join(__dirname,'../../runtime',name),'utf8');
test('room animations apply tile offsets and scale, fire authored sound cues once, pause and complete',()=>{
 const sounds=[],positions=[],scales=[];let life=0;
 const handle={get exists(){return life>0;},setLocation(...p){positions.push(p);},setScale(...s){scales.push(s);},setRotation(){},stop(){life=0;}};
 const context={_makeContextCurrent(){},update(){life=Math.max(0,life-1);},play(){life=4;return handle;}};
 const R={GpuEffects:{restoreDefault(){},draw(){return null;}},effectAnchorWorld(o,e,w){Object.assign(w,{x:10,y:20,z:30});return w;},scaleAxes:s=>[s,s,s],modelSpanTiles:()=>26};
 const scope={Reactor3D:R,effekseer:{},THREE:{},Date};vm.runInNewContext(read('reactor_battle_room.js'),scope);
 const view=Object.create(scope.ReactorBattleRoomView.prototype);Object.assign(view,{models:new Map(),effectPlays:new Map(),effectContext:{context},assets:{animation(){},effectUrl(){},playSe:se=>sounds.push(se.name)},renderer:{resetState(){}},camera:{projectionMatrix:{elements:[]},matrixWorldInverse:{elements:[]}}});
 const play={id:'cue',owner:{object:{rotation:{y:0}}},world:{},animation:{scale:50,soundTimings:[{frame:0,se:{name:'hit'}},{frame:2,se:{name:'echo'}}]},effect:{scale:2,loop:false},offset:{x:1,y:2,z:3},transient:true,age:0,quad:{mesh:{}},native:{}};
 view.effectPlays.set('cue',play);let stopped=0;view.stopEffect=()=>stopped++;
 view.updateEffects();assert.deepEqual(positions[0],[11,23,32]);assert.deepEqual(scales[0],[1,1,1]);assert.deepEqual(sounds,['hit']);
 view.effectsPaused=true;view.updateEffects();assert.equal(play.age,1);assert.deepEqual(sounds,['hit']);
 view.effectsPaused=false;view.updateEffects();view.updateEffects();assert.deepEqual(sounds,['hit','echo']);
 view.updateEffects();view.updateEffects();assert.equal(view.effectPlays.size,0);assert.equal(stopped,1);
});
test('flat animation instances own transforms and waits without mutating database records or blocking other steps',()=>{
 function Sprites() {this._animationSprites=[];}const record={scale:100};
 Sprites.prototype.createAnimation=function(request){this._animationSprites.push({_animation:record,targetObjects:request.targets,targetPosition:()=>({x:50,y:80}),isPlaying:()=>true});};
 Sprites.prototype.isAnimationPlaying=function(){return this._animationSprites.length>0;};
 const scope={ReactorBattleData:B,DataManager:{isDatabaseLoaded(){}},Spriteset_Base:Sprites};vm.runInNewContext(read('reactor_battle_presentation.js'),scope);scope.ReactorBattlePresentation.installSequenceAnimations();
 const ss=new Sprites(),ticket={pending:true,sprites:[],transform:{x:2,y:1,z:3,scale:1.5}};ss.findTargetSprite=()=>null;
 ss.createAnimation({targets:[],_reactorSequenceMedia:ticket});assert.equal(ticket.pending,false);assert.equal(ticket.sprites.length,1);assert.equal(ss.isAnimationPlaying(),false);assert.equal(record.scale,100);assert.equal(ticket.sprites[0]._animation.scale,150);assert.deepEqual({...ticket.sprites[0].targetPosition()},{x:146,y:-16});
 ss.createAnimation({targets:[]});assert.equal(ss.isAnimationPlaying(),true);assert.equal(ss._animationSprites[1]._animation,record);
});

test('room-selected prop motion queues advance at their authored speed and can repeat',()=>{
 const scope={Reactor3D:{modelRuleDuration:()=>10}};vm.runInNewContext(read('reactor_battle_room.js'),scope);
 const view=Object.create(scope.ReactorBattleRoomView.prototype),r={sequence:['Open','Close'],sequenceIndex:0,animationStart:0,animationFrame:0,animationRealFrame:0,spec:{animationSpeed:200,repeat:true},rules:[{trigger:'action',name:'Open'},{trigger:'action',name:'Close'}]};
 view.frame=0;assert.equal(view.propAction(r).name,'Open');view.frame=5;assert.equal(view.propAction(r).name,'Close');view.frame=10;assert.equal(view.propAction(r).name,'Open');r.spec.repeat=false;view.frame=15;view.propAction(r);view.frame=20;assert.equal(view.propAction(r),null);
});
test('MOG cursor uses projected room bounds and its own parent coordinates; ordinary battles retain plugin positioning',()=>{
 function Cursor(){}Cursor.prototype.posX=()=>999;Cursor.prototype.posY=()=>888;
 const ss={_reactorRoom:{},_reactorRoomSprite:{toGlobal:p=>({x:p.x+40,y:p.y+60})}};
 const scope={ReactorBattleData:B,DataManager:{isDatabaseLoaded(){}},BattleManager:{_spriteset:ss},BattleCursorSprite:Cursor,PIXI:{Point:class {constructor(x,y){this.x=x;this.y=y;}}}};vm.runInNewContext(read('reactor_battle_presentation.js'),scope);scope.ReactorBattlePresentation.installRoomAnchors();
 const c=new Cursor();Object.assign(c,{_battlerSprite:{_reactorRoomBounds:{x:100,y:120,width:80,height:200}},_align:2,parent:{toLocal:p=>({x:p.x-10,y:p.y-20})},_position:{xOffset:3,yOffset:4},_effect:{waveX:0,waveY:0},_battler:{_battleCursor:{X_Offset:1,Y_Offset:2}}});
 assert.equal(c.posX(),174);assert.equal(c.posY(),166);c._align=4;assert.equal(c.posX(),214);assert.equal(c.posY(),266);ss._reactorRoom=null;assert.equal(c.posX(),999);assert.equal(c.posY(),888);
});
