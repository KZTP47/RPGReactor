const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'runtime/reactor_mv_compat.js'), 'utf8');
const start = source.indexOf('    function installFinalFogCompatibility()');
const end = source.indexOf('    function installFinalTreasurePopupCompatibility()', start);
const variants = [
 // The bundled MZ port retains VE's same updateFog contract; test both plugin IDs.
 ['VE - Fog And Overlay', 'Demo/js/plugins/PSYCHRONIC_MZRX-FogAndOverlay.js'],
 ['PSYCHRONIC_MZRX-FogAndOverlay', 'Demo/js/plugins/PSYCHRONIC_MZRX-FogAndOverlay.js']
];
function fixture(flag, file, v8 = true) {
 const plugin = fs.readFileSync(path.join(root, 'template', file), 'utf8');
 const at = plugin.indexOf('    Spriteset_Base.prototype.updateFog = function(');
 const tail = plugin.indexOf('    Spriteset_Base.prototype.setFogSpriteBitmap', at);
 const fog = {name:'Dust', hue:0, blend:0, z:4, x:12.8, y:-4.2, zoom:1.5, opacity:100};
 function Spriteset_Base() { this._fogEffects = []; this.created = 0; this.deleted = 0; }
 const blend = v => typeof v === 'number' ? ({0:'normal',1:'add',2:'multiply',3:'screen',31:'add'}[v] || 'normal') : v;
 Spriteset_Base.prototype.createFog = function(id) {
  this.created++;
  this._fogEffects[id] = {fogName:fog.name, fogHue:fog.hue, blendMode:blend(fog.blend), z:fog.z, origin:{x:0,y:0}, scale:{x:1,y:1}, opacity:255};
 };
 Spriteset_Base.prototype.deleteFog = function(id) { this.deleted++; delete this._fogEffects[id]; };
 const context = { Imported:{[flag]:true}, PIXI:{TextureSource:v8 ? function() {} : undefined,__reactorBlendModeName:blend}, Spriteset_Base, $gameScreen:{fog:()=>fog} };
 vm.runInNewContext(plugin.slice(at, tail), context);
 const original = Spriteset_Base.prototype.updateFog;
 const install = vm.runInNewContext(`(function(){const global=globalThis;${source.slice(start,end)};return installFinalFogCompatibility;})()`, context);
 return {fog, context, original, install, ss:new Spriteset_Base()};
}
for (const [flag, file] of variants) {
 test(`${flag}: moving fog keeps its sprite, with numeric game data and PIXI string blends`, () => {
  const {fog, ss, install} = fixture(flag, file);
  ss.createFog(1);
  ss.updateFog(1); // Reproduce the shipped plugin failure before installing the bridge.
  assert.equal(ss.created, 2);
  assert.equal(ss._fogEffects[1].origin.x, 0, 'old method updates the discarded sprite');
  install(); install();
  const sprite = ss._fogEffects[1];
  for (let frame = 0; frame < 60; frame++) {
   fog.x += 4.5; fog.y += .75; ss.updateFog(1);
   assert.equal(ss._fogEffects[1], sprite);
   assert.equal(sprite.origin.x, Math.floor(fog.x));
   assert.equal(sprite.origin.y, Math.floor(fog.y));
  }
  assert.equal(ss.created, 2); assert.equal(ss.deleted, 1);
  assert.equal(fog.blend, 0); assert.equal(sprite.opacity, 100);
  assert.equal(sprite.scale.x, 1.5); assert.equal(sprite.scale.y, 1.5);
 });
 test(`${flag}: real fog changes replace and immediately position the new sprite`, () => {
  const {fog, ss, install, context} = fixture(flag, file);
  install(); ss.createFog(1);
  for (const [key,value] of [['blend',1],['name','OtherDust'],['hue',90],['z',2]]) {
   const old = ss._fogEffects[1], count = ss.created;
   fog[key] = value; ss.updateFog(1);
   assert.notEqual(ss._fogEffects[1], old); assert.equal(ss.created, count+1);
   assert.equal(ss._fogEffects[1].origin.x, 12); assert.equal(ss._fogEffects[1].origin.y, -5);
   assert.equal(ss._fogEffects[1].opacity, 100);
   ss.updateFog(1); assert.equal(ss.created,count+1);
  }
  fog.blend=31; ss.updateFog(1);
  assert.equal(ss.created,5,'equivalent custom additive blend does not recreate');
  context.$gameScreen.fog=()=>null; assert.doesNotThrow(()=>ss.updateFog(1));
  assert.doesNotThrow(()=>ss.updateFog(9));
 });
 test(`${flag}: legacy PIXI keeps its original plugin method`, () => {
  const {context, original, install} = fixture(flag,file,false);
  install(); assert.equal(context.Spriteset_Base.prototype.updateFog,original);
 });
}
test('unrelated fog plugins are left intact', () => {
 const {context,original,install}=fixture(...variants[0]); context.Imported={};
 install(); assert.equal(context.Spriteset_Base.prototype.updateFog,original);
});
