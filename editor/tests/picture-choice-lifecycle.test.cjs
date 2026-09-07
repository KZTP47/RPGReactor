const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../../runtime/reactor_mv_compat.js'),'utf8');
function fixture(){
 const data={name:'ExistingImage',sprite:null};
 const scene={children:[],addChild(s){s.parent=this;this.children.push(s);},removeChild(s){this.children=this.children.filter(x=>x!==s);s.parent=null;}};
 class Sprite{constructor(){this.scale={x:1,y:1};this.destroyed=false;this.destroyCalls=0;}destroy(options){this.destroyed=true;this.scale=null;this.destroyCalls++;this.options=options;}}
 function Window_ChoiceList(){this._choiceSprites=[];}
 const p=Window_ChoiceList.prototype;
 p.clearChoiceSprites=function(){this._choiceSprites=[];};
 p.createChoiceSprites=function(){this.clearChoiceSprites();data.sprite=new Sprite();scene.addChild(data.sprite);};
 p.update=function(){if(data.sprite)data.sprite.scale.x+=.1;};
 p.destroy=function(){this.destroyed=true;};
 const global={Imported:{PSYCHRONIC_PictureChoices:true},PSYCHRONIC_PictureChoices:{choiceImages:[data]},Window_ChoiceList};
 const at=source.indexOf('    function installFinalPictureChoicesCompatibility()'),end=source.indexOf('    function installFinalFogCompatibility()',at);
 const install=vm.runInNewContext(`(()=>{const global=globalThis;${source.slice(at,end)};return installFinalPictureChoicesCompatibility;})()`,global);
 install();return {data,scene,Window_ChoiceList,install,global};
}
test('picture choice windows release scene sprites before the next window updates',()=>{
 const {data,scene,Window_ChoiceList}=fixture(),w=new Window_ChoiceList();w.createChoiceSprites();const s=data.sprite;
 w.update();assert.equal(s.scale.x,1.1);w.destroy();assert.equal(scene.children.length,0);assert.equal(data.sprite,null);assert.equal(s.destroyed,true);
 assert.equal(s.options.texture,false);assert.equal(s.options.textureSource,false);assert.equal(s.options.baseTexture,false);
 const next=new Window_ChoiceList();assert.doesNotThrow(()=>next.update());next.createChoiceSprites();assert.notEqual(data.sprite,s);assert.equal(scene.children.length,1);
});
test('recreating choices removes earlier sprites and preserves image definitions',()=>{
 const {data,scene,Window_ChoiceList,install}=fixture(),w=new Window_ChoiceList();install();w.createChoiceSprites();const old=data.sprite;w.createChoiceSprites();assert.equal(old.destroyCalls,1);assert.equal(scene.children.length,1);assert.equal(data.name,'ExistingImage');w.clearChoiceSprites();w.destroy();assert.equal(scene.children.length,0);
});
test('destroying an old window cannot clear a newer window’s sprite reference',()=>{
 const {data,scene,Window_ChoiceList}=fixture(),old=new Window_ChoiceList(),current=new Window_ChoiceList();old.createChoiceSprites();current.createChoiceSprites();const next=data.sprite;old.destroy();assert.equal(data.sprite,next);assert.equal(next.destroyed,false);assert.equal(scene.children.length,1);current.update();
});
test('stale references from an already destroyed scene are pruned before plugin update',()=>{
 const {data,Window_ChoiceList}=fixture(),w=new Window_ChoiceList();w.createChoiceSprites();data.sprite.destroy();assert.doesNotThrow(()=>w.update());assert.equal(data.sprite,null);assert.equal(data.name,'ExistingImage');
});
