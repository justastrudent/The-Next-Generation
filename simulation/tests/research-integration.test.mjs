#!/usr/bin/env node
/** Provider-operation lifetime must be independent of display-height cache lifetime.
 * Runs the actual scene methods and workspace status handler with no network or API key.
 */
import assert from 'node:assert/strict';
import {MetroScene} from '../scene3d.js';
import ResearchWorkspace from '../research-workspace.js';
import Environment3D from '../environment3d.js';

const original={document:globalThis.document,fetch:globalThis.fetch,createImageBitmap:globalThis.createImageBitmap};
const rgba=new Uint8ClampedArray(256*256*4);
for(let i=0;i<rgba.length;i+=4){rgba[i]=128;rgba[i+1]=50;rgba[i+2]=0;rgba[i+3]=255;}
globalThis.document={getElementById:()=>null,createElement:kind=>{
  assert.equal(kind,'canvas');
  return {getContext:()=>({drawImage(){},getImageData:()=>({data:rgba})})};
}};
globalThis.createImageBitmap=async()=>({width:256,height:256,close(){}});
const response={ok:true,status:200,blob:async()=>new Blob(['test-heightmap'])};
const defer=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
let checks=0;
const check=(value,message)=>{assert.ok(value,message);checks++;};
class EllipsoidTerrainProvider {}
class CustomHeightmapTerrainProvider {constructor(options){this.options=options;}}
class WebMercatorTilingScheme {}
class Credit {constructor(value){this.value=value;}}
const baseC={EllipsoidTerrainProvider,CustomHeightmapTerrainProvider,WebMercatorTilingScheme,Credit,
  Cartographic:{fromDegrees:(lon,lat)=>({longitude:lon,latitude:lat})}};

function makeScene({emitProviderChange=true}={}){
  const scene=Object.create(MetroScene.prototype);
  Object.assign(scene,{C:{...baseC},destroyed:false,_terrainRevision:0,terrainHeights:new Map(),heightRequests:new Set(),
    provider:{terrain:''},_status(){},network:null});
  const workspace={scene,context:null,destroyed:false,onDataChange(){}};
  workspace.notify=value=>ResearchWorkspace.prototype.environmentStatus.call(workspace,value);
  let provider=new EllipsoidTerrainProvider();
  const viewer={scene:{requestRender(){},globe:{getHeight(){return undefined;}}}};
  Object.defineProperty(viewer,'terrainProvider',{get:()=>provider,set:value=>{
    provider=value;
    if(emitProviderChange)workspace.notify({terrainChanged:true,message:'wrapper changed'});
  }});
  scene.viewer=viewer;
  return {scene,workspace,viewer};
}

try{
  // A geometry wrapper may invalidate samples while the base DEM probe is still
  // awaiting a response. It must not cancel the original provider connection.
  const pendingProbe=defer();globalThis.fetch=()=>pendingProbe.promise;
  const first=makeScene();
  const connecting=first.scene._enablePublicTerrain();
  const generation=first.scene._terrainRevision;
  first.workspace.notify({terrainChanged:true,message:'temporary display toggle'});
  check(first.scene._terrainRevision===generation,'display invalidation preserves provider-operation generation');
  check(first.scene._environmentHeightRevision>0,'display invalidation has an independent height generation');
  pendingProbe.resolve(response);
  check(await connecting,'DEM probe survives a concurrent environment-height invalidation');
  check(first.viewer.terrainProvider instanceof CustomHeightmapTerrainProvider,'successful probe installs the public DEM provider');
  check(first.scene.hasTerrain&&first.scene.terrainKind==='terrarium','base scene retains its successful public-terrain state');

  // A later failed tile must still call the scene's original fallback, even
  // though installing/wrapping the provider emitted terrain-change reports.
  const connectedProvider=first.viewer.terrainProvider;
  first.workspace.notify({terrainChanged:true,message:'wrapper installed'});
  globalThis.fetch=async()=>{throw new Error('simulated tile outage');};
  await assert.rejects(connectedProvider.options.callback(1,1,14),/simulated tile outage/);
  checks++;
  check(first.viewer.terrainProvider instanceof EllipsoidTerrainProvider,'a failed public DEM tile still activates the original ellipsoid fallback');
  check(first.scene.terrainKind==='ellipsoid'&&!first.scene.hasTerrain,'fallback state and terrain availability remain consistent');
  check(first.scene.publicTerrainSource.disposed,'the failed public source is disposed');

  // Samples requested before the visual terrain change may not populate the new
  // cache. Their finally callbacks must not remove a newer same-location request.
  const second=makeScene({emitProviderChange:false}),samples=[];
  const providerA={name:'A'},providerB={name:'B'};
  second.viewer.terrainProvider=providerA;
  second.scene.C.sampleTerrain=(provider,level,points)=>{const d=defer();samples.push({...d,provider,points});return d.promise;};
  second.scene._requestHeight(127.36,36.62);await settle();
  second.workspace.notify({terrainChanged:true,message:'height field changed'});
  second.scene._requestHeight(127.36,36.62);await settle();
  check(samples.length===2,'a new height request can start after cache invalidation');
  samples[0].resolve([{height:50}]);await settle();
  check(second.scene.terrainHeights.size===0,'an old display-height sample is rejected');
  check(second.scene.heightRequests.has('127.3600,36.6200'),'an old finally callback does not erase the new same-point request');
  samples[1].resolve([{height:53}]);await settle();
  check(second.scene.terrainHeights.get('127.3600,36.6200')===53,'the current display-height sample reaches the cache');
  check(!second.scene.heightRequests.has('127.3600,36.6200'),'the current completed request is released');

  // Provider identity itself is also checked: a provider can be changed before
  // an event/status callback reaches the display extension.
  second.scene._requestHeight(127.37,36.63);await settle();
  second.viewer.terrainProvider=providerB;
  samples[2].resolve([{height:999}]);await settle();
  check(!second.scene.terrainHeights.has('127.3700,36.6300'),'a stale sample from another provider is rejected even without an environment status event');

  // The provider can finish an in-flight tile after the user turns smoothing
  // off. Its reporting callback must not revive an obsolete terrain status.
  const reports=[],environment=new Environment3D({onStatus:value=>reports.push(value)});
  const native={tilingScheme:{},requestTileGeometry(){}};
  environment.viewer={terrainProvider:native,scene:{requestRender(){}}};
  environment.C={...baseC,HeightmapTerrainData:class{}};
  environment.field={};environment.manifest={bridgeBounds:[]};
  environment._installTerrain();
  const oldWrapper=environment.viewer.terrainProvider;
  oldWrapper.onModified({modifiedTiles:1,maxCorrectionM:1.2});
  check(environment.status.terrain.state==='active','current wrapper can report modified tiles');
  environment.layers.terrain=false;environment._installTerrain();
  const reportCount=reports.length;
  oldWrapper.onModified({modifiedTiles:30,maxCorrectionM:1.2});
  check(environment.status.terrain.state==='original','a stale wrapper cannot reactivate the terrain-off status');
  check(reports.length===reportCount,'an obsolete wrapper does not emit an active terrain report');
  environment.layers.terrain=true;environment._installTerrain();
  const removedWrapper=environment.viewer.terrainProvider;
  environment.viewer=null;
  removedWrapper.onModified({modifiedTiles:1,maxCorrectionM:1.2});
  check(reports.length===reportCount,'detached viewer discards late modified-tile status callbacks');

  console.log(JSON.stringify({passed:true,checks,scope:'DEM probe lifetime, original failure fallback, stale-height, same-point request races, obsolete wrapper status'},null,2));
}finally{
  for(const[k,value]of Object.entries(original)){if(value===undefined)delete globalThis[k];else globalThis[k]=value;}
}
