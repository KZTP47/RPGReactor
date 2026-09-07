const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../../runtime/reactor_mv_compat.js'),'utf8');
function fixture(){
 let loaded=false,requests=0;const listeners=[];
 const bitmap={isReady:()=>loaded,addLoadListener:f=>listeners.push(f)};
 function Window_ChoiceList(){this.contents={};this.names=['\\i[2032] English'];this.refreshes=0;this.painted=[];}
 Window_ChoiceList.prototype.refresh=function(){this.refreshes++;this._list=this.names.map(name=>({name}));this.painted=loaded?this.names.slice():[];};
 const context={Window_ChoiceList,ImageManager:{loadSystem(){requests++;return bitmap;}}};
 const at=source.indexOf('    function installFinalChoiceIconCompatibility()'),end=source.indexOf('    function installFinalPictureChoicesCompatibility()',at);
 const install=vm.runInNewContext(`(()=>{const global=globalThis;${source.slice(at,end)};return installFinalChoiceIconCompatibility;})()`,context);install();
 return {w:new Window_ChoiceList(),install,listeners,requests:()=>requests,load(){loaded=true;for(const f of listeners.splice(0))f();}};
}
test('language icons redraw when the evicted IconSet finishes reloading',()=>{const f=fixture();f.w.refresh();assert.deepEqual(f.w.painted,[]);f.load();assert.equal(f.w.refreshes,2);assert.deepEqual(f.w.painted,['\\i[2032] English']);});
test('a pending icon load refreshes current choices and coalesces listeners',()=>{const f=fixture();f.install();f.w.refresh();f.w.names=['\\I[2033] Español'];f.w.refresh();assert.equal(f.listeners.length,1);f.load();assert.deepEqual(f.w.painted,['\\I[2033] Español']);});
test('late icon loads do not refresh destroyed windows',()=>{const f=fixture();f.w.refresh();f.w.destroyed=true;Object.defineProperty(f.w,'contents',{get(){throw Error('destroyed contents accessed');}});assert.doesNotThrow(f.load);assert.equal(f.w.refreshes,1);});
test('plain choices do not request icons and preloaded icons refresh synchronously',()=>{const f=fixture();f.w.names=['Yes','No'];f.w.refresh();assert.equal(f.requests(),0);f.w.names=['\x1bI[4] Item'];f.load();f.w.refresh();assert.deepEqual(f.w.painted,['\x1bI[4] Item']);assert.equal(f.listeners.length,0);});
