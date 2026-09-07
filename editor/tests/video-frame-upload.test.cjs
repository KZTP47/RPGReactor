const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const compat=fs.readFileSync(path.resolve(__dirname,'../../runtime/libs/pixi_compat.js'),'utf8');
function fixture(v8=true){
 const calls=[];const PIXI={glUploadVideoResource:{upload(...args){calls.push({kind:'frame',args});return 12;}}};
 const original=PIXI.glUploadVideoResource.upload;
 const at=compat.indexOf('    if (_isV8Pixi && PIXI.glUploadVideoResource'),end=compat.indexOf('    // -------------------------------------------------------------------------',at);
 vm.runInNewContext(compat.slice(at,end),{_isV8Pixi:v8,PIXI});
 const source={pixelWidth:1,pixelHeight:1,resource:{videoWidth:0,videoHeight:0,readyState:0}};
 const texture={width:-1,height:-1,target:3553,internalFormat:6408,format:6408,type:5121};
 const gl={texImage2D(...args){calls.push({kind:'allocate',args});}};
 const upload=(...rest)=>{const result=PIXI.glUploadVideoResource.upload(source,texture,gl,2,...rest);texture.width=source.pixelWidth;texture.height=source.pixelHeight;return result;};
 return {calls,source,texture,gl,PIXI,original,upload};
}
test('video metadata allocates its true size before decoded-frame uploads',()=>{
 const f=fixture();f.upload();assert.deepEqual(f.calls[0].args.slice(3,5),[1,1]);
 Object.assign(f.source,{pixelWidth:1280,pixelHeight:720});Object.assign(f.source.resource,{videoWidth:1280,videoHeight:720,readyState:1});f.upload();
 assert.equal(f.calls[1].kind,'allocate');assert.deepEqual(f.calls[1].args.slice(3,5),[1280,720]);assert.equal(f.calls[1].args[8],null);
 f.upload();assert.equal(f.calls.length,2,'no repeated allocation while waiting for decoded data');
 f.source.resource.readyState=2;assert.equal(f.upload(),12);assert.equal(f.calls[2].kind,'frame');assert.equal(f.texture.width,1280);
});
test('emptying a playing video never shrinks the GPU to a hidden 1x1 texture',()=>{
 const f=fixture();Object.assign(f.source,{pixelWidth:1280,pixelHeight:720});Object.assign(f.texture,{width:1280,height:720});
 f.upload();assert.equal(f.calls.length,0);assert.equal(f.texture.width,1280);
 f.source.resource=null;f.upload();assert.equal(f.calls.length,0);
});
test('target overrides and normal video uploader arguments are preserved',()=>{
 const f=fixture();f.upload(34069);assert.equal(f.calls[0].args[0],34069);
 Object.assign(f.source.resource,{videoWidth:1,videoHeight:1,readyState:4});f.upload(34069,true);assert.equal(f.calls[1].args[4],34069);assert.equal(f.calls[1].args[5],true);
});
test('legacy PIXI retains its original uploader',()=>{const f=fixture(false);assert.equal(f.PIXI.glUploadVideoResource.upload,f.original);});
