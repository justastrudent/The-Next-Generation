import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {buildingVisualSpec,buildingRoofMesh,buildingFacadeMesh,meshInstances} from '../building-visuals.js';
import {Environment3D} from '../environment3d.js';
const require=createRequire(import.meta.url),C=require('../vendor/cesium/index.cjs');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),read=p=>JSON.parse(readFileSync(path.join(root,p),'utf8'));
const manifest=read('data/environment/manifest.json');
const records=manifest.tiles.flatMap(t=>read('data/environment/'+t.url).buildings);
const origin=[127.35,36.6],ring=[[0,0],[12,0],[12,8],[0,8],[0,0]].map(([x,y])=>[origin[0]+x/(111320*Math.cos(origin[1]*Math.PI/180)),origin[1]+y/111320]);
const example={id:'test',center:origin,polygons:[[ring]],bounds:[ring[0][0],ring[0][1],ring[2][0],ring[2][1]],height:6.4,floors:2,style:'house',use:'단독주택',heightSource:'recorded'};
test('supplied footprint/height records remain byte-identical while known types receive visible façade features',()=>{
 const original=JSON.stringify(records);let roofCount=0,detailTriangles=0;
 for(const b of records)for(const rings of b.polygons){
  const s=buildingVisualSpec(b,rings),roof=buildingRoofMesh(b,rings,s),facade=buildingFacadeMesh(b,rings,{near:true,spec:s});
  assert.equal(s.height,b.height);assert(s.wallHeight>0);assert(s.wallHeight<=b.height);
  if(b.attributeMismatch)assert.equal(s.style,'unknown');
  if(s.roofRise){roofCount++;assert.equal(rings.length,1);assert(['house','industrial'].includes(s.style));}
  for(const g of roof.groups.values())for(let i=2;i<g.positions.length;i+=3)assert(g.positions[i]<=b.height+1e-8&&g.positions[i]>=0);
  for(const mesh of[roof,facade])for(const g of mesh.groups.values()){
   assert(g.positions.every(Number.isFinite));assert(g.normals.every(Number.isFinite));assert(g.indices.every(i=>i>=0&&i<g.positions.length/3));
   for(let i=0;i<g.normals.length;i+=3)assert(Math.abs(Math.hypot(...g.normals.slice(i,i+3))-1)<1e-7);
  }
  detailTriangles+=facade.triangles;
 }
 assert.equal(JSON.stringify(records),original);assert(roofCount>100);assert(detailTriangles>100000);
 console.log({buildings:records.length,pitchedFootprints:roofCount,fullDetailTriangles:detailTriangles});
});
test('holes/concave footprints do not receive a roof that fills courtyards or leaves the source footprint',()=>{
 const hole=ring.map(p=>[origin[0]+(p[0]-origin[0])*.3+2/89000,origin[1]+(p[1]-origin[1])*.3+2/111320]);
 const s=buildingVisualSpec(example,[ring,hole]);assert.equal(s.roofKind,'flat');assert.equal(buildingRoofMesh(example,[ring,hole],s).triangles,0);
 const concave=[[0,0],[12,0],[12,4],[4,4],[4,8],[0,8],[0,0]].map(([x,y])=>[origin[0]+x/89000,origin[1]+y/111320]);
 assert.equal(buildingVisualSpec(example,[concave]).roofKind,'flat');
});
test('clockwise and counterclockwise façades face outwards and compile with real Cesium',()=>{
 for(const r of[ring,[...ring].reverse()]){
  const s=buildingVisualSpec(example,[r]),mesh=buildingFacadeMesh(example,[r],{spec:s});
  const instances=meshInstances(C,[{record:example,base:60,mesh}]);assert(instances.length>=4); // intentionally fewer material batches after removing window grids
  for(const instance of instances){const g=instance.geometry;assert(g.boundingSphere.radius>0);assert(g.attributes.position.values.every(Number.isFinite));
   assert(g.indices.length>0);assert(g.attributes.normal.values.every(Number.isFinite));
   const encoded=C.GeometryPipeline.encodeAttribute(g,'position','position3DHigh','position3DLow');assert(encoded.attributes.position3DHigh);
  }
  // Every front façade triangle in the south wall points outward (south).
  const groups=[...mesh.groups.values()];const normals=groups.flatMap(g=>g.positions.reduce((a,_,i)=>{if(i%9===0&&Math.abs(g.positions[i+1])<.2&&Math.abs(g.positions[i+4])<.2&&Math.abs(g.positions[i+7])<.2)a.push(g.normals.slice(i,i+3));return a;},[]));
  assert(normals.some(n=>n[1]<-.9));assert(!normals.some(n=>n[1]>.9));
 }
});
test('detail geometry disappears at regional view and restores without altering basic building layers',()=>{
 const collection={items:new Set(),add(o){this.items.add(o);return o;},remove(o){return this.items.delete(o);}},viewer={scene:{primitives:collection,requestRender(){}}};
 const E=new Environment3D();E.C={...C,Primitive:class{constructor(o){Object.assign(this,o)}}};E.viewer=viewer;E._detailTarget=origin;E._detailEnabled=true;
 const spec=buildingVisualSpec(example,[ring]),tile={viewer,objects:[],buildingVisuals:[{record:example,base:60,parts:[{rings:[ring],spec}]}]};
 E._refreshBuildingDetails(tile);assert.equal(collection.items.size,1);const first=tile.objects[0].primitive;
 E._refreshBuildingDetails(tile);assert.equal(tile.objects[0].primitive,first);
 E._detailEnabled=false;E._refreshBuildingDetails(tile);assert.equal(collection.items.size,0);
 E._detailEnabled=true;E._refreshBuildingDetails(tile);assert.equal(collection.items.size,1);
 E.layers.buildings=false;E._refreshBuildingDetails(tile);assert.equal(collection.items.size,0);
});
test('facility priority is scoped to visible facilities and survives the attach/detach lifecycle',()=>{
 const E=new Environment3D(),placements=new Map([['d',{id:'d',kind:'depot',variant:'depot',lon:127.35,lat:36.6,heading:0}],['h',{id:'h',kind:'hub',variant:'hub',lon:127.36,lat:36.6,heading:0}],['s',{id:'s',kind:'stop',variant:'shelter',lon:127.37,lat:36.6,heading:0}]]);
 E.setServicePlacements(placements);assert.equal(E.facilityPriority.length,3);
 E.setServicePlacements(placements,{hubs:false,stops:false});assert.deepEqual(E.facilityPriority.map(p=>p.id),['d']);
 E.detach();assert.equal(E.servicePlacements,placements);assert.equal(E.facilityPriority.length,1);
 E.setServicePlacements(placements,{depot:false,hubs:false,stops:false});assert.equal(E.facilityPriority.length,0);
});
test('a failed optional façade batch keeps the valid building shell and does not mark its detail as loaded',()=>{
 const shell={id:'shell'},collection={items:new Set([shell]),add(o){this.items.add(o);return o;},remove(o){return this.items.delete(o);}},viewer={scene:{primitives:collection,requestRender(){}}};
 const E=new Environment3D();E.C={...C,Geometry:class{constructor(){throw new Error('optional detail geometry unavailable');}}};E.viewer=viewer;E._detailTarget=origin;E._detailEnabled=true;
 const tile={viewer,objects:[{layer:'buildings',primitive:shell}],buildingVisuals:[{record:example,base:60,parts:[{rings:[ring],spec:buildingVisualSpec(example,[ring])}]}]};
 assert.doesNotThrow(()=>E._refreshBuildingDetails(tile));assert(collection.items.has(shell));assert.equal(tile.objects.length,1);assert.equal(tile.detailKey,undefined);assert(tile.detailRetryAt>Date.now());
 E.layers.buildings=false;E._refreshBuildingDetails(tile);assert.equal(tile.detailKey,'');assert(collection.items.has(shell));
});
test('facility visibility changes during initial terrain-assets loading cannot cancel environment attach',async()=>{
 let finish;const pending=new Promise(resolve=>{finish=resolve;});
 const collection={add:x=>x,remove:()=>true},viewer={scene:{primitives:collection,groundPrimitives:collection,globe:{},requestRender(){}},camera:{positionCartographic:{height:1000}},terrainProvider:new C.EllipsoidTerrainProvider()};
 const E=new Environment3D();E.manifest={schemaVersion:1,tiles:[],warnings:[],bridgeBounds:[]};E.field={};
 const loaded=E.attach(viewer,{...C,GroundPrimitive:class{static initializeTerrainHeights(){return pending;}}});
 const epoch=E.epoch;
 E.setServicePlacements(new Map([['d',{id:'d',kind:'depot',variant:'depot',lon:127.35,lat:36.6,heading:0}]]),{hubs:false});
 assert.equal(E.epoch,epoch);finish();assert.equal(await loaded,true);assert.equal(E.status.ready,true);assert.equal(E.facilityPriority.length,1);E.destroy();
});
