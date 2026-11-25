#!/usr/bin/env node
/** Boundary-only regressions. All boundary geometries below are SYNTHETIC test fixtures,
 * not an administrative boundary or a substitute for the user's QGIS export. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {parseBoundaryGeoJSON,BOUNDARY_MAX_BYTES} from '../boundary-data.js';
import MetroScene from '../scene3d.js';
import VWorldScene from '../vworld-scene.js';
import {prepareRun,stateAt} from '../replay-core.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const errors=[];let checks=0;
const check=(ok,message)=>{checks++;if(!ok)errors.push(message);};
const equal=(a,b,message)=>check(isDeepStrictEqual(a,b),`${message}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
function rejects(fn,message){let rejected=false;try{fn();}catch{rejected=true;}check(rejected,message);}
const clone=value=>JSON.parse(JSON.stringify(value));
const readJSON=name=>JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const ring=(w,s,e,n)=>[[w,s],[e,s],[e,n],[w,n],[w,s]];
const feature=(id,type,coordinates)=>({type:'Feature',id,properties:{name:`SYNTHETIC ${id}`},geometry:{type,coordinates}});
const fixture={type:'FeatureCollection',features:[
  feature('polygon-with-hole','Polygon',[ring(127.34,36.60,127.36,36.62),ring(127.345,36.605,127.355,36.615)]),
  feature('two-islands','MultiPolygon',[[ring(127.37,36.63,127.39,36.65),ring(127.375,36.635,127.385,36.645)],[ring(127.40,36.66,127.41,36.67)]]),
  feature('open-line','LineString',[[127.34,36.63],[127.35,36.64],[127.36,36.65]]),
  feature('separate-lines','MultiLineString',[[[127.37,36.60],[127.38,36.61]],[[127.39,36.62],[127.40,36.63]]])
]};
const original=JSON.stringify(fixture),model=parseBoundaryGeoJSON(fixture);
equal(model.geojson,fixture,'Synthetic holes, islands, independent lines, feature IDs and names are preserved');
equal([model.featureCount,model.polygonCount,model.lineCount,model.vertexCount],[4,3,3,32],'Counts describe actual polygon/line parts and vertices');
equal(model.bounds,[127.34,36.60,127.41,36.67],'Bounds include every part without inventing geometry');
equal(JSON.stringify(fixture),original,'Validation does not mutate uploaded data');
equal(parseBoundaryGeoJSON(original),model,'JSON text and object imports give the same model');
equal(parseBoundaryGeoJSON(fixture.features[0]).geojson.features,[fixture.features[0]],'A raw Feature is accepted');
equal(parseBoundaryGeoJSON(fixture.features[2].geometry).geojson.features[0].geometry,fixture.features[2].geometry,'A raw supported Geometry is accepted');
const withHeight=clone(fixture.features[2]);withHeight.geometry.coordinates.forEach(p=>p.push(123));
equal(parseBoundaryGeoJSON(withHeight).geojson.features[0].geometry.coordinates,fixture.features[2].geometry.coordinates,'Uploaded Z does not override terrain elevation');
check(model.geojson!==fixture&&model.geojson.features[0].geometry.coordinates!==fixture.features[0].geometry.coordinates,'Accepted geometry is independently cloned');
equal(BOUNDARY_MAX_BYTES,15*1024*1024,'The explicit upload limit is 15 MiB');
for(const name of ['EPSG:4326','urn:ogc:def:crs:OGC:1.3:CRS84']){
  equal(parseBoundaryGeoJSON({...fixture,crs:{properties:{name}}}).bounds,model.bounds,'Declared WGS84 CRS is accepted');
}
const empty={type:'FeatureCollection',features:[]},emptyModel=parseBoundaryGeoJSON(empty,{allowEmpty:true});
equal([emptyModel.empty,emptyModel.bounds,emptyModel.featureCount,emptyModel.vertexCount],[true,null,0,0],'Empty startup model means no supplied geometry');
equal(readJSON('data/gangnae_boundary.geojson').features,readJSON('gangnae_boundary.geojson').features,'Packaged default contains the supplied real QGIS boundary unchanged');
rejects(()=>parseBoundaryGeoJSON(empty),'An empty user upload is rejected');
const malformed=[
  null,'not JSON',{type:'FeatureCollection',features:null},{type:'Point',coordinates:[127,36]},
  {type:'GeometryCollection',geometries:[]},{type:'Feature',geometry:null},
  {type:'LineString',coordinates:[[127.36,36.62]]},
  {type:'LineString',coordinates:[[127.36,36.62],[960000,1840000]]},
  {type:'LineString',coordinates:[[127.36,36.62],['127.37',36.63]]},
  {type:'LineString',coordinates:[[127.36,36.62],[NaN,36.63]]},
  {type:'LineString',coordinates:[[127.36,36.62],[127.36,36.62]]},
  {type:'MultiLineString',coordinates:[]},{type:'MultiPolygon',coordinates:[]},
  {type:'Polygon',coordinates:[]},
  {type:'Polygon',coordinates:[[[127,36],[128,36],[128,37],[127,37]]]},
  {type:'Polygon',coordinates:[[[127,36],[128,36],[127,36],[127,36]]]},
  {type:'Polygon',coordinates:[[[127,36],[128,37],[129,38],[127,36]]]},
  {...fixture,crs:{properties:{name:'EPSG:5179'}}},
  {type:'LineString',coordinates:[[-170,36],[170,37]]}
];
malformed.forEach((input,index)=>rejects(()=>parseBoundaryGeoJSON(input),`Invalid boundary case ${index+1} is rejected`));

// Read the existing research material once; boundary operations must leave it unchanged.
const network=readJSON('data/network.json'),manifest=readJSON('data/manifest.json');
const run=readJSON(manifest.runs.find(r=>r.date==='2023-11-06'&&r.mode==='integrated'&&r.scenario==='S1').url);
const prepared=prepareRun(run,network),states=stateAt(prepared,360),beforeResearch=hash(JSON.stringify({network,run,states}));
const savedGlobals={document:globalThis.document,getComputedStyle:globalThis.getComputedStyle,ResizeObserver:globalThis.ResizeObserver};
const element=()=>({style:{},children:[],append(...nodes){this.children.push(...nodes);},replaceChildren(...nodes){this.children=[...nodes];},remove(){},setAttribute(){}});
globalThis.document={createElement:()=>element()};globalThis.getComputedStyle=()=>({position:'static'});
globalThis.ResizeObserver=class{observe(){}disconnect(){}};
const C={
  Cartesian3:{fromDegreesArray:flat=>Array.from({length:flat.length/2},(_,i)=>flat.slice(i*2,i*2+2))},
  CallbackProperty:class{},PolygonHierarchy:class{constructor(positions,holes=[]){this.positions=positions;this.holes=holes;}},
  Color:{fromCssColorString:value=>({value,withAlpha(alpha){return {value,alpha};}})},
  HeightReference:{CLAMP_TO_GROUND:1},ClassificationType:{TERRAIN:1},EllipsoidTerrainProvider:class{},
  Matrix4:{IDENTITY:{}},Rectangle:{fromDegrees:(...bounds)=>bounds}
};
function fakeViewer(){
  const entities=new Set(),cameraCalls=[];let destroyed=false,renderCount=0;
  const viewer={entities:{add(options){const e={...options};entities.add(e);return e;},remove(e){return entities.delete(e);}},
    scene:{globe:{},requestRender(){renderCount++;}},camera:{lookAtTransform(){},flyTo(options){cameraCalls.push(options);}},
    isDestroyed:()=>destroyed,destroy(){destroyed=true;entities.clear();}};
  return {viewer,entities,cameraCalls,get renderCount(){return renderCount;}};
}
function drawingContext(){
  const fills=[],strokes=[];let paths=[];
  return {fills,strokes,save(){},restore(){},beginPath(){paths=[];},moveTo(...p){paths.push({points:[p],closed:false});},lineTo(...p){paths.at(-1).points.push(p);},closePath(){paths.at(-1).closed=true;},fill(rule){fills.push({rule,paths:clone(paths)});},stroke(){strokes.push(clone(paths));}};
}
try{
  const scene=new MetroScene(element());scene.network=network;scene.states=states;scene.time=360;
  // Only unrelated GPU/network drawing is replaced; real boundary/init/cleanup methods run.
  for(const method of ['_bindViewer','setCamera','_drawNetwork','update','_drawWaiting'])scene[method]=()=>{};
  check(scene.zoomBoundary()===false,'Zoom without a supplied boundary is a no-op');
  const cached=scene.setBoundary(model,{zoom:true,fill:true});
  check(cached===scene.boundary&&scene.viewer===null,'An upload before map initialization is cached');
  equal(scene.boundaryEntities.length,0,'Before initialization there are no phantom map entities');
  check(scene._boundaryZoomPending,'Boundary zoom can be queued before map initialization');
  const first=fakeViewer(),road=first.viewer.entities.add({id:'existing-road'}),vehicle=first.viewer.entities.add({id:'existing-vehicle'});
  await scene.initExternalViewer(first.viewer,C);
  const fills=scene.boundaryEntities.filter(e=>e.polygon),outlines=scene.boundaryEntities.filter(e=>e.polyline);
  equal(fills.length,3,'Three polygon parts are separately rendered');
  equal(fills.map(e=>e.polygon.hierarchy.holes.length),[1,1,0],'Both uploaded holes are represented by Cesium PolygonHierarchy');
  equal(fills[0].polygon.hierarchy.holes[0].positions,fixture.features[0].geometry.coordinates[1],'The hole keeps its own original coordinates');
  equal(outlines.length,8,'Five ring outlines and three separate line outlines are rendered');
  equal(outlines.slice(-3).map(e=>e.polyline.positions),[fixture.features[2].geometry.coordinates,...fixture.features[3].geometry.coordinates],'Open/disconnected lines are neither joined nor closed');
  check(outlines.every(e=>e.polyline.clampToGround===true)&&fills.every(e=>e.polygon.heightReference===C.HeightReference.CLAMP_TO_GROUND),'Boundary uses terrain clamping');
  check(scene.boundaryEntities.every(e=>e.show===true),'Initial boundary visibility is enabled');
  check(first.entities.has(road)&&first.entities.has(vehicle),'Boundary creation preserves unrelated road and vehicle entities');
  check(!scene._boundaryZoomPending&&first.cameraCalls.length===1,'Queued zoom runs once after renderer initialization');
  const view=first.cameraCalls[0].destination;
  check(view[0]<model.bounds[0]&&view[1]<model.bounds[1]&&view[2]>model.bounds[2]&&view[3]>model.bounds[3],'Boundary camera covers all parts with padding');
  scene.setBoundaryOptions({fill:false});
  check(fills.every(e=>e.show===false)&&outlines.every(e=>e.show===true),'Hiding fill preserves all boundary outlines');
  scene.setBoundaryOptions({visible:false});check(scene.boundaryEntities.every(e=>e.show===false),'Boundary visibility hides only boundary entities');
  scene.setBoundaryOptions({visible:true});check(fills.every(e=>!e.show)&&outlines.every(e=>e.show),'Restoring visibility respects the separate fill setting');

  const priorModel=scene.boundary,priorOptions=scene.boundaryOptions,priorEntities=[...scene.boundaryEntities],priorSet=[...first.entities];
  rejects(()=>scene.setBoundary({type:'FeatureCollection',features:[feature('invalid','LineString',[[127,36],[999999,36]])]}),'Invalid replacement is rejected');
  check(scene.boundary===priorModel&&scene.boundaryOptions===priorOptions,'Invalid replacement retains the previous boundary model/options');
  const add=first.viewer.entities.add;let calls=0;
  first.viewer.entities.add=function(options){if(++calls===2)throw new Error('Synthetic GPU entity failure');return add.call(this,options);};
  rejects(()=>scene.setBoundary(model,{fill:true}),'A simulated mid-render failure is surfaced');
  first.viewer.entities.add=add;
  check(scene.boundary===priorModel&&scene.boundaryOptions===priorOptions,'Render failure restores previous boundary data/options');
  check(scene.boundaryEntities.length===priorEntities.length&&scene.boundaryEntities.every((e,i)=>e===priorEntities[i]),'Render failure retains every previous entity');
  check(first.entities.size===priorSet.length&&priorSet.every(e=>first.entities.has(e)),'Failed replacement leaves no orphan newly created entities');

  scene.setBoundaryOptions({fill:true});
  const fillContext=drawingContext();scene._drawBoundaryFallback(fillContext,p=>p,'fill');
  equal(fillContext.fills.map(item=>item.rule),['evenodd','evenodd','evenodd'],'2D fallback uses even-odd fill for every polygon part');
  equal(fillContext.fills.map(item=>item.paths.length),[2,2,1],'2D fallback preserves holes as independent subpaths');
  const lineContext=drawingContext();scene._drawBoundaryFallback(lineContext,p=>p,'outline');
  equal(lineContext.strokes.length,8,'2D fallback keeps all rings and separate line parts');
  equal(lineContext.strokes.map(item=>item[0].closed),[true,true,true,true,true,false,false,false],'Only polygon rings are closed in 2D');
  equal(lineContext.strokes.slice(-3).map(item=>item[0].points),[fixture.features[2].geometry.coordinates,...fixture.features[3].geometry.coordinates],'2D fallback creates no joining chords');
  scene.setBoundaryOptions({fill:false});const noFill=drawingContext();scene._drawBoundaryFallback(noFill,p=>p,'fill');equal(noFill.fills.length,0,'2D fill toggle is respected');
  scene.setBoundaryOptions({visible:false});const hidden=drawingContext();scene._drawBoundaryFallback(hidden,p=>p,'outline');equal(hidden.strokes.length,0,'2D visibility toggle is respected');

  // A failed/retried VWorld frame must discard GPU references, but preserve the upload.
  VWorldScene.prototype._clearVWorldFrame.call(scene);
  check(scene.viewer===null&&scene.boundary===priorModel,'VWorld frame cleanup retains cached boundary data');
  equal(scene.boundaryEntities.length,0,'VWorld cleanup discards stale boundary entity references');
  const second=fakeViewer();await scene.initExternalViewer(second.viewer,C);
  equal(scene.boundaryEntities.length,11,'A retried viewer redraws the cached boundary');
  check(scene.boundaryEntities.every(e=>e.show===false),'Retry retains boundary visibility options');
  const independent=second.viewer.entities.add({id:'other-road'});scene.clearBoundary();
  check(scene.boundary===null&&scene.boundaryEntities.length===0,'Clear removes boundary data and all of its entities');
  check(second.entities.size===1&&second.entities.has(independent),'Clear preserves unrelated map entities');
  check(!scene._boundaryZoomPending&&scene._fallbackViewBounds===null,'Clear resets boundary-only camera state');
  scene.setBoundary(model);equal(scene.setBoundary(emptyModel),null,'An explicit empty startup model safely clears an existing boundary');
  rejects(()=>scene.setBoundary(empty),'Unmarked empty GeoJSON is still rejected by the renderer');
  check(scene.network===network&&scene.states===states,'Boundary actions retain exact simulation network and state references');
  equal(hash(JSON.stringify({network,run,states})),beforeResearch,'Boundary operations do not alter roads, recorded events, positions, counts, or costs');
  equal(stateAt(prepared,360),states,'Road-based replay remains deterministic after boundary operations');
}finally{
  for(const [name,value]of Object.entries(savedGlobals)){if(value===undefined)delete globalThis[name];else globalThis[name]=value;}
}

// Cheap full-file invariance check against the independently packaged prior dataset.
// This is a hash comparison, not a redundant rerun of 1.48M raw-data assertions.
const sourceData=path.resolve(root,'../metrorookies-replay/dist/data');
let unchangedFiles=0;const changedFiles=[];
function visit(directory,prefix=''){
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    const relative=path.join(prefix,entry.name),file=path.join(directory,entry.name);
    if(entry.isDirectory())visit(file,relative);
    else {const target=path.join(root,'data',relative),matches=fs.existsSync(target)&&hash(fs.readFileSync(file))===hash(fs.readFileSync(target));check(matches,`Original research data remains byte-identical: ${relative}`);matches?unchangedFiles++:changedFiles.push(relative);}
  }
}
if(fs.existsSync(sourceData))visit(sourceData);
const result={status:errors.length?'failed':'passed',checks,errorCount:errors.length,errors,
  unchangedOriginalDataFiles:unchangedFiles,changedOriginalDataFiles:changedFiles,
  scope:'Synthetic boundary fixtures only. Real validator and renderer methods with DOM/GPU doubles; original packaged research data hash comparison. The installed QGIS geometry matches the supplied source. Live map tiles and GPU pixels were not asserted.',
  sourceSha256:Object.fromEntries(['boundary-data.js','scene3d.js','vworld-scene.js','replay-core.js','data/gangnae_boundary.geojson'].map(name=>[name,hash(fs.readFileSync(path.join(root,name)))]))};
fs.mkdirSync(path.join(root,'docs'),{recursive:true});fs.writeFileSync(path.join(root,'docs/boundary-overlay-results.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));process.exitCode=errors.length?1:0;
