const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const B=require('../../runtime/reactor_battle_data.js');
function editor(clipboard){const C=vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/database/DatabaseActionSequenceEditor.js'),'utf8')+'\nDatabaseActionSequenceEditor',{ReactorBattleData:B,ReactorClipboard:clipboard,window:{},console});const e=Object.create(C.prototype);e.sequence=B.template();e.selected=0;e.host={isConnected:true};e.parent={updateStatus(){}};e.ui={text:s=>s};return e;}
test('cut never deletes a step when the clipboard write fails or the step changed while writing',async()=>{
 let done;const e=editor({write:()=>new Promise(r=>done=r)});let deleted=0;e.deleteStep=()=>deleted++;
 let pending=e.copyStep(true);await Promise.resolve();await Promise.resolve();done(false);assert.equal(await pending,false);assert.equal(deleted,0);
 pending=e.copyStep(true);await Promise.resolve();await Promise.resolve();e.sequence.steps[0].duration++;done(true);assert.equal(await pending,true);assert.equal(deleted,0);
});
test('an asynchronous paste cannot write into a different sequence panel',async()=>{
 let done;const e=editor({read:()=>new Promise(r=>done=r)});let inserts=0;e.insertSteps=()=>inserts++;
 const pending=e.pasteStep();await Promise.resolve();await Promise.resolve();e.host={isConnected:true};e.sequence=B.template('Heal');done({payload:{version:1,steps:[B.step('wait')]}});assert.equal(await pending,false);assert.equal(inserts,0);
});
test('paste uses the captured insertion anchor and rejects unrelated or malformed data',async()=>{
 let payload={version:1,steps:[B.step('wait')]};const e=editor({read:async()=>({payload})});let at=-1;e.insertSteps=(rows,index)=>{at=index;return true;};
 e.selected=2;const pending=e.pasteStep();e.selected=5;assert.equal(await pending,true);assert.equal(at,3);
 payload={version:1,steps:[B.step('move',{x:Infinity})]};assert.equal(await e.pasteStep(),false);
});

test('editing a motion transform previews its final pose before any following instantaneous motion',()=>{
 const e=editor({});e.sequence={id:1,name:'Pose boundary',steps:[B.step('motion',{duration:10,transform:{x:2,rotateY:45}}),B.step('motion',{duration:0}),B.step('impact')]};
 e.selected=0;e.frame=10;e.controls={transformPose:e.sequence.steps[0]};e.playing=false;
 const context={homes:{user:{x:0,y:0,z:0}},direction:1};
 assert.equal(B.evaluate(e.previewSequence(),10,context).user.transform.x,2);
 assert.equal(B.evaluate(e.previewSequence(),10,context).user.transform.rotateY,45);
 e.playing=true;assert.equal(B.evaluate(e.previewSequence(),10,context).user.transform.x,0,'Full playback still advances to the next motion');
 e.playing=false;e.controls.transformPose=null;assert.equal(e.previewSequence(),e.sequence,'Ordinary scrubbing retains the full sequence');
});
