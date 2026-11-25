import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {elevationAt,terrainBlend,createTerrainHeightmap,pointInPolygon,bridgeHeightAt,displayHeight} from '../environment-core.js';
import {Environment3D,GentleTerrainProvider} from '../environment3d.js';
const require=createRequire(import.meta.url),C=require('../vendor/cesium/index.cjs');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>JSON.parse(readFileSync(path.join(root,p),'utf8'));

test('environment counts retain supplied footprints and quarantine conflicting building attributes',()=>{
 const manifest=read('data/environment/manifest.json'),stats=manifest.stats;
 assert.equal(stats.sourceCounts.gangnae_buildings,8666);assert.equal(stats.attributeMismatch,42);
 assert.deepEqual({...stats.buildingHeights},{fallback_estimate:5672,recorded:1752,floors_estimate:1242});
 const seen=new Set();let n=0,roads=0,bridges=0;
 for(const tile of manifest.tiles){const d=read('data/environment/'+tile.url);
  for(const b of d.buildings){assert(!seen.has(b.id));seen.add(b.id);n++;
   assert(b.height>0);if(b.attributeMismatch){assert.equal(b.heightSource,'fallback_estimate');assert.equal(b.style,'unknown');}
   if(b.heightSource==='recorded')assert.equal(b.height,b.rawHeight);
  }roads+=d.roads.length;bridges+=d.bridges.length;
 }
 assert.equal(n,8666);assert.equal(roads,5174);assert.equal(bridges,92);
});

test('polygon hole membership and display/native height units stay distinct',()=>{
 const outer=[[0,0],[10,0],[10,10],[0,10],[0,0]],hole=[[2,2],[8,2],[8,8],[2,8],[2,2]];
 assert(pointInPolygon([1,1],[outer,hole]));assert(!pointInPolygon([5,5],[outer,hole]));
 assert.equal(displayHeight(100,{verticalExaggeration:.9}),90);
 assert.equal(displayHeight(100,{verticalExaggeration:.9,verticalExaggerationRelativeHeight:50}),95);
 assert.equal(displayHeight(undefined,{}),undefined);
});

const field={width:9,height:9,west:127.3,south:36.5,stepLon:.02,stepLat:.02,values:Array(81).fill(60)};
const rectangle={west:127.32*Math.PI/180,east:127.44*Math.PI/180,south:36.52*Math.PI/180,north:36.64*Math.PI/180};
test('terrain is datum anchored, bounded and unchanged at tile seams, water and bridges',()=>{
 assert.equal(elevationAt(field,127.34,36.54),60);assert.equal(elevationAt(field,0,0),undefined);
 assert.equal(terrainBlend(100,60,40,.5,.5),100);
 assert.equal(terrainBlend(140,60,40,.5,.5),138.8);
 assert.equal(terrainBlend(140,60,40,0,.5),140);
 assert.equal(terrainBlend(140,60,40,.5,.5,{bridgeDistanceM:5}),140);
 const patch=createTerrainHeightmap({rectangle,field,size:9,sampleNative:(lon,lat)=>{
  const cx=(rectangle.west+rectangle.east)/2,cy=(rectangle.north+rectangle.south)/2;
  return Math.abs(lon-cx)<.00001&&Math.abs(lat-cy)<.00001?140:100;
 },isWater:(u,v)=>u>.8});
 assert(patch);assert.equal(patch.offset,40);assert(patch.maxDelta<=1.2000000001);
 assert(Math.abs(patch.buffer[40]-138.8)<1e-4);
 for(let i=0;i<9;i++){assert.equal(patch.buffer[i],100);assert.equal(patch.buffer[72+i],100);assert.equal(patch.buffer[i*9],100);assert.equal(patch.buffer[i*9+8],100);}
});

test('TerrainProvider delegates throttling, original regions and child masks correctly',async()=>{
 let result;const native=new C.HeightmapTerrainData({width:3,height:3,buffer:new Float32Array([100,100,100,100,140,100,100,100,100]),childTileMask:5});
 const base={errorEvent:new C.Event(),tilingScheme:{tileXYToRectangle:()=>rectangle},getLevelMaximumGeometricError:l=>l,
  requestTileGeometry:()=>result,getTileDataAvailable:()=>true};
 const wrapper=new GentleTerrainProvider(base,C,field);
 assert.equal(wrapper.requestTileGeometry(0,0,14),undefined);
 result=Promise.resolve(native);assert.equal(wrapper.requestTileGeometry(0,0,13),result);
 const revised=await wrapper.requestTileGeometry(0,0,14);assert(revised instanceof C.HeightmapTerrainData);
 assert.equal(revised.isChildAvailable(0,0,0,1),true);assert.equal(revised.isChildAvailable(0,0,1,1),false);
 assert.equal(revised.isChildAvailable(0,0,0,0),true);assert.equal(revised.isChildAvailable(0,0,1,0),false);
 assert.equal(wrapper.modifiedTiles,1);
});

test('bridge plane uses source footprint approach anchors, no invented high pier',()=>{
 const anchors=[[127.35,36.6],[127.351,36.6]];
 assert(Math.abs(bridgeHeightAt([127.3505,36.6],anchors,[50,52])-51.12)<1e-8);
 assert.equal(bridgeHeightAt([127.35,36.6],anchors,[undefined,52]),undefined);
});

test('bridge display heights respect polygon holes, visibility, and a crossing vehicle direction',()=>{
 const E=new Environment3D(),outer=[[127.35,36.6],[127.351,36.6],[127.351,36.6002],[127.35,36.6002],[127.35,36.6]],
  hole=[[127.3503,36.60005],[127.3507,36.60005],[127.3507,36.60015],[127.3503,36.60015],[127.3503,36.60005]];
 const bridge={bounds:[127.35,36.6,127.351,36.6002],polygons:[[outer,hole]],anchors:[[127.35,36.6001],[127.351,36.6001]]};
 E.tiles.set('bridge',{bridgeSurfaces:[{bridge,heights:[50,52]}]});
 assert(Number.isFinite(E.surfaceHeightAt(127.3501,36.6001,90)));
 assert(Number.isFinite(E.surfaceHeightAt(127.3501,36.6001,270)));
 assert.equal(E.surfaceHeightAt(127.3501,36.6001,0),undefined);
 assert.equal(E.surfaceHeightAt(127.3505,36.6001,90),undefined);
 E.layers.bridges=false;assert.equal(E.surfaceHeightAt(127.3501,36.6001,90),undefined);
});

test('pending GPU batches are removed on detach and cannot reappear after a late terrain response',async()=>{
 const collection=()=>({items:new Set(),add(x){this.items.add(x);return x;},remove(x){return this.items.delete(x);}});
 const viewer={scene:{primitives:collection(),groundPrimitives:collection(),requestRender(){}},camera:{},terrainProvider:new C.EllipsoidTerrainProvider()};
 const E=new Environment3D({fetcher:async()=>({ok:true,json:async()=>({roads:[],buildings:[],bridges:[]})})});
 E.viewer=viewer;E.C={...C,Primitive:class{constructor(o){Object.assign(this,o)}},GroundPrimitive:class{constructor(o){Object.assign(this,o)}}};
 let resolveHeights;E._sampleHeights=()=>new Promise(r=>{resolveHeights=r;});
 const ring=[[127.35,36.6],[127.3501,36.6],[127.3501,36.6001],[127.35,36.6001],[127.35,36.6]];
 E.dataCache.set('test',{roads:[{id:'road',surface:'paved',polygons:[[ring]]}],buildings:[],bridges:[]});E._wanted=new Set(['test']);
 const loading=E._loadTile({id:'test'},E.epoch);assert.equal(viewer.scene.groundPrimitives.items.size,1);
 E.detach();assert.equal(viewer.scene.groundPrimitives.items.size,0);resolveHeights([]);await loading;
 assert.equal(E.tiles.size,0);assert.equal(viewer.scene.primitives.items.size,0);
});

test('optional ground assets cannot prevent buildings from attaching; terrain provider changes rewrap once',async()=>{
 const event=new C.Event(),native=()=>({tilingScheme:new C.GeographicTilingScheme(),errorEvent:new C.Event(),
  getLevelMaximumGeometricError:()=>100,requestTileGeometry:()=>undefined});
 let provider=native(),terrainSignals=0;
 const collection=()=>({add:x=>x,remove:()=>true});
 const viewer={scene:{primitives:collection(),groundPrimitives:collection(),globe:{terrainProviderChanged:event},requestRender(){}},
  camera:{moveEnd:new C.Event(),positionCartographic:{height:1000}},get terrainProvider(){return provider;},
  set terrainProvider(p){provider=p;event.raiseEvent(p);}};
 const manifest={schemaVersion:1,tiles:[],bridgeBounds:[],warnings:[],elevation:'grid.json'};
 const E=new Environment3D({onStatus:s=>{if(s.terrainChanged)terrainSignals++;},
  fetcher:async(url)=>({ok:true,json:async()=>url.endsWith('manifest.json')?manifest:field})});
 const TestCesium={...C,GroundPrimitive:class{static initializeTerrainHeights(){return Promise.reject(new Error('optional asset failed'));}}};
 assert.equal(await E.attach(viewer,TestCesium),true);assert(provider.metroEnvironmentTerrain);
 const firstWrapper=provider;
 assert(E.status.warnings.some(x=>x.includes('도로 표면')));assert.equal(terrainSignals,1);
 E._report();assert.equal(terrainSignals,1);
 const replacement=native();viewer.terrainProvider=replacement;
 assert(provider.metroEnvironmentTerrain);assert.equal(provider.base,replacement);assert.equal(terrainSignals,2);
 firstWrapper.onModified({modifiedTiles:99,maxCorrectionM:1.2});assert.equal(E.status.terrain.modifiedTiles,0);
 const currentWrapper=provider;E.detach();assert.equal(provider,replacement);
 currentWrapper.onModified({modifiedTiles:100,maxCorrectionM:1.2});assert.equal(E.status.terrain.modifiedTiles,0);
});

test('every supplied building, road and bridge polygon compiles with the bundled Cesium geometry engine',()=>{
 const E=new Environment3D();E.C=C;E.viewer={scene:{}};const manifest=read('data/environment/manifest.json');
 let buildings=0,roads=0,bridges=0;
 for(const tile of manifest.tiles){const d=read('data/environment/'+tile.url);
  for(const r of d.buildings)for(const rings of r.polygons){
   const g=C.PolygonGeometry.createGeometry(E._instance(r,rings,'building','#cccccc',{base:50,height:r.height,walls:true}).geometry);
   assert(g,`building ${r.id}`);buildings++;
  }
  for(const r of d.roads)for(const rings of r.polygons){
   const g=C.PolygonGeometry.createGeometry(E._instance(r,rings,'road','#888888',null).geometry);assert(g,`road ${r.id}`);roads++;
  }
  for(const r of d.bridges)for(const rings of r.polygons){
   const g=C.PolygonGeometry.createGeometry(E._bridgeInstance(r,rings,[50,50]).geometry);assert(g,`bridge ${r.id}`);
   for(const ring of rings)assert(C.WallGeometry.createGeometry(E._bridgeEdge(r,ring,[50,50]).geometry));bridges++;
  }
 }
 assert(buildings>=8666);assert(roads>=5174);assert(bridges>=92);
 console.log('Compiled polygon parts:',{buildings,roads,bridges});
});
