const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),test=require('node:test');
const dom=require('./helpers/mini-dom.cjs');
test('dropdown observer skips discarded controls and wraps them after reattachment',()=>{
 const observers=[];const context=dom.createContext({MutationObserver:class{constructor(callback){this.callback=callback;}observe(target){observers.push({target,callback:this.callback});}disconnect(){}}});
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/utils/SelectThemingShim.js'),'utf8'),context);
 const notify=observers.find(o=>o.target===context.document.documentElement).callback;
 const select=dom.createSelect([{value:'home',text:'Home'}],'home');select.nodeType=1;
 context.document.body.appendChild(select);select.remove();
 assert.doesNotThrow(()=>notify([{addedNodes:[select]}]));
 assert.equal(select.parentNode,null);
 const detached=dom.createElement('div');detached.nodeType=1;detached.appendChild(select);
 notify([{addedNodes:[detached]}]);assert.equal(detached.querySelector('.rr-shim-trigger'),null);
 context.document.body.appendChild(detached);notify([{addedNodes:[detached]}]);
 assert.ok(detached.querySelector('.rr-shim-trigger'));assert.equal(select.value,'home');
});
