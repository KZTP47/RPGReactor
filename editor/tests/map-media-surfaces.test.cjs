const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Elevation=require('../src/utils/MapElevation.js');
const Media=require('../src/MediaSurfaceManager.js');
const Editor=require('../src/event/commands/MediaSurfaceEditor.js');
const Preview=require('../src/MediaSurfacePreviewManager.js');

test('flat maps retain media-only sidecars and remove the field when the final surface is undone',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rr-map-media-'));fs.mkdirSync(path.join(temp,'data'));
 try {
  const map={id:2,width:3,height:3},pc={tilemapManager:{currentMap:map},mediaSurfacePreviewManager:{rescan(){}}};
  const manager=new Media(pc,null);manager.boundMap=map;manager.render=()=>{};
  manager.change([{id:2,movie:'panel.png',target:'map'}]);assert.equal(Elevation.save(fs,path,temp,map),true);
  const saved=JSON.parse(fs.readFileSync(path.join(temp,'data/Map002.r3d.json'),'utf8'));
  assert.equal(saved.mediaSurfaces[0].movie,'panel.png');
  manager.history(manager.undo,manager.redo);assert.equal(map.reactor3d.mediaSurfaces,undefined);
  manager.history(manager.redo,manager.undo);assert.equal(map.reactor3d.mediaSurfaces[0].id,2);
  const other={id:3};pc.tilemapManager.currentMap=other;manager.write([{id:9}]);assert.equal(other.reactor3d,undefined);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});

test('automatic surface IDs avoid both permanent and event-owned surface IDs',()=>{
 const previous=global.MediaSurfacePreviewManager;global.MediaSurfacePreviewManager=Preview;
 try {
  const map={id:1,reactor3d:{mediaSurfaces:[{id:1,movie:'a.png'}]},events:[{id:1,pages:[{list:[Editor.buildCommand('ShowVideoSurface',{...Editor.defaults(),id:2,movie:'b.png'})]}]}]};
  const manager=new Media({tilemapManager:{currentMap:map}},null);assert.equal(manager.nextId(),3);
 }finally{global.MediaSurfacePreviewManager=previous;}
});

test('duplicating a surface preserves its settings, assigns a free ID and supports independent edits and history',()=>{
 const previous=global.MediaSurfacePreviewManager;global.MediaSurfacePreviewManager=Preview;
 try {
  const original={id:1,movie:'ceiling.png',target:'map',x:8,y:9,z:12,rotationX:90,rotationY:25,scaleX:2,scaleY:3,opacity:175,scanlines:.3,loop:true,muted:false,volume:65,corners:[{x:-160,y:-90}],extension:{keep:'metadata'}};
  const map={id:1,reactor3d:{mediaSurfaces:[original,{id:5,movie:'other.png'}]},events:[{id:1,pages:[{list:[Editor.buildCommand('ShowVideoSurface',{...Editor.defaults(),id:2,movie:'event.png'})]}]}]};
  const manager=new Media({tilemapManager:{currentMap:map},mediaSurfacePreviewManager:{rescan(){}}},null);
  manager.boundMap=map;manager.open=()=>true;manager.render=()=>{};
  let editedId;manager.edit=id=>{editedId=id;return true;};
  const copyId=manager.duplicate(1);assert.equal(copyId,3);assert.equal(editedId,copyId);
  assert.deepEqual(manager.rows().map(row=>row.id),[1,3,5]);
  const copy=manager.rows()[1];assert.deepEqual(copy,{...original,id:3});
  assert.notEqual(copy.corners,manager.rows()[0].corners);assert.notEqual(copy.extension,manager.rows()[0].extension);
  copy.corners[0].x=42;copy.extension.keep='changed';assert.equal(manager.rows()[0].corners[0].x,-160);assert.equal(manager.rows()[0].extension.keep,'metadata');
  manager.history(manager.undo,manager.redo);assert.deepEqual(manager.rows().map(row=>row.id),[1,5]);
  manager.history(manager.redo,manager.undo);assert.deepEqual(manager.rows().map(row=>row.id),[1,3,5]);
  assert.equal(manager.duplicate(999),false);assert.equal(manager.rows().length,3);
 }finally{global.MediaSurfacePreviewManager=previous;}
});

test('surface previews yield pointer ownership to Event mode while remaining visible',()=>{
 const pc={eventManager:{eventMode:false},mediaSurfaceManager:{panel:{}}},preview=new Preview(pc,null);
 const record={source:{mapId:1,surfaceId:2}},mesh={},surface={style:{}};
 preview.map={id:1};preview.pixiOwners.set('test',{mesh});preview.domOwners.set('test',{surface});
 preview.syncToolInteraction();assert.equal(preview.canEdit(record),true);assert.equal(mesh.eventMode,'static');assert.equal(surface.style.pointerEvents,'auto');
 pc.eventManager.eventMode=true;preview.syncToolInteraction();
 assert.equal(preview.canEdit(record),false);assert.equal(mesh.eventMode,'none');assert.equal(surface.style.pointerEvents,'none');
 assert.equal(preview.pixiOwners.size,1);assert.equal(preview.domOwners.size,1);
 pc.eventManager.eventMode=false;preview.syncToolInteraction();assert.equal(preview.canEdit(record),true);assert.equal(mesh.eventMode,'static');
 pc.mediaSurfaceManager.panel=null;preview.syncToolInteraction();assert.equal(preview.canEdit(record),false);assert.equal(mesh.eventMode,'none');assert.equal(surface.style.pointerEvents,'none');
});
