import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildServicePlacements,distanceM,waitingPoint,passengerPose,cargoAnimation,applyNaturalTerrain,sampledDisplayHeight,HUB_SQUARE_IMAGE} from '../service-visuals.js';
import {prepareRun,stateAt} from '../replay-core.js';
import MetroScene from '../scene3d.js';
const root=new URL('../',import.meta.url),read=p=>JSON.parse(fs.readFileSync(new URL(p,root)));
const network=read('data/network.json');
const before=JSON.stringify(network),placements=buildServicePlacements(network);
const near=(a,b,epsilon=1e-7)=>assert.ok(Math.abs(a-b)<=epsilon,`${a} != ${b}`);

test('all supplied service nodes receive separate illustrative facilities without changing the research network',()=>{
 assert.equal(placements.size,120);assert.equal(JSON.stringify(network),before);
 const values=[...placements.values()];assert.equal(values.filter(p=>p.kind==='depot').length,1);assert.equal(values.filter(p=>p.kind==='hub').length,39);
 assert.equal(values.filter(p=>p.kind==='stop').length,80);assert.ok(values.some(p=>p.variant==='sign')&&values.some(p=>p.variant==='shelter'));
 assert.deepEqual([...buildServicePlacements(network)], [...placements]);
 for(const p of values){const source=network.nodes[p.id];assert.equal(p.sourceLon,source.lon);assert.equal(p.sourceLat,source.lat);assert.ok(distanceM(p,source)>2);assert.ok(distanceM(p,source)<20);assert.ok(p.facilityTypeBasis.startsWith('illustrative'));}
 const depot=placements.get(network.depot);assert.equal(depot.lon,network.nodes.DEPOT.originalLon);assert.equal(depot.lat,network.nodes.DEPOT.originalLat);
});
test('standing figures and the walking actor start at the same shelter anchor and arrive at the door',()=>{
 const f=[...placements.values()].find(p=>p.variant==='shelter'),s={lon:f.sourceLon,lat:f.sourceLat,heading:f.roadHeading,animation:{kind:'boarding',progress:0}};
 const pose=passengerPose(s,f),stand=waitingPoint(f,0);assert.ok(distanceM(pose,stand)<.001);assert.equal(pose.visible,true);
 const end=passengerPose({...s,animation:{kind:'boarding',progress:.85}},f);assert.ok(distanceM(end,s)<1);assert.equal(end.visible,true);
 const out=passengerPose({...s,animation:{kind:'alighting',progress:.85}},f);assert.ok(distanceM(out,stand)<.001);
});
test('opposite-side boarding walks around a van rather than through its body',()=>{
 const s={lon:127.36,lat:36.62,heading:0},p={heading:90,waiting:{lon:s.lon-5/(111320*Math.cos(s.lat*Math.PI/180)),lat:s.lat}};
 for(let i=0;i<100;i++){
  const pose=passengerPose({...s,animation:{kind:'boarding',progress:.15+.7*i/100}},p);const east=(pose.lon-s.lon)*111320*Math.cos(s.lat*Math.PI/180),north=(pose.lat-s.lat)*111320;
  // Entering the open side door is intended only at the very end of the walk.
  if(east<.82||east>1.65||north<-.2||north>.4)assert.ok(!(Math.abs(east)<1.15&&Math.abs(north)<3.25));
 }
});
test('eight loading boxes transfer in36 simulated seconds, without changing logged completion/counts',()=>{
 const run=read('data/runs/2023-11-06_integrated_S0.json'),prepared=prepareRun(run,network),event=run.events.find(e=>e.kind==='LOAD'&&e.quantity===8);
 const t=event.time+.8,states=stateAt(prepared,t),state=states.find(s=>s.id===event.vehicle),prior=JSON.stringify(state),pose=cargoAnimation(state);
 assert.equal(pose.quantity,8);assert.equal(pose.visualDurationSeconds,36);assert.equal(pose.visualComplete,true);assert.equal(pose.visible,false);assert.equal(pose.open,0);
 assert.equal(state.cargo,0);assert.equal(JSON.stringify(state),prior);assert.equal(state.event.completed,event.completed);
 const after=stateAt(prepared,event.completed).find(s=>s.id===event.vehicle);assert.equal(after.cargo,8);
 // Rewind deterministically reconstructs the same box, with no accumulated actor state.
 const sample={...state,animation:{...state.animation,progress:10/180}};assert.deepEqual(cargoAnimation(sample),cargoAnimation(sample));assert.equal(cargoAnimation(sample).cycle,2);assert.equal(cargoAnimation(sample).visible,true);
});
test('a single delivery uses one short transfer and a short logged event still contains its whole illustration',()=>{
 const one={event:{time:10,completed:12},animation:{kind:'delivery',quantity:1,progress:4/120}},pose=cargoAnimation(one);assert.equal(pose.visualDurationSeconds,8);assert.ok(pose.fraction>0&&pose.fraction<1);
 const short={event:{time:10,completed:10.01},animation:{kind:'delivery',quantity:8,progress:.5}};assert.ok(cargoAnimation(short).visualDurationSeconds<=.600001);
});
test('modern terrain receives gentle supported relief reduction; legacy terrain stays native',()=>{
 const modern={verticalExaggeration:1,verticalExaggerationRelativeHeight:60,globe:{maximumScreenSpaceError:3}},result=applyNaturalTerrain(modern);assert.equal(modern.verticalExaggeration,.9);assert.equal(modern.verticalExaggerationRelativeHeight,60);assert.equal(modern.globe.maximumScreenSpaceError,1.5);assert.equal(result.reliefApplied,true);assert.equal(sampledDisplayHeight(160,modern),150);
 const legacy={globe:{maximumScreenSpaceError:2}},other=applyNaturalTerrain(legacy);assert.equal(other.reliefApplied,false);assert.ok(!('verticalExaggeration'in legacy));assert.equal(sampledDisplayHeight(160,legacy),160);
});
test('rendered height cache and native sampled height are each adjusted only once',()=>{
 const scene=Object.create(MetroScene.prototype);let height=150;Object.assign(scene,{hasTerrain:true,viewer:{scene:{verticalExaggeration:.9,verticalExaggerationRelativeHeight:60,globe:{getHeight:()=>height}}},C:{Cartographic:{fromDegrees:(lon,lat)=>({lon,lat})}},terrainHeights:new Map()});
 assert.equal(scene._height(127.36,36.62),150);height=undefined;assert.equal(scene._height(127.36,36.62),150);assert.equal([...scene.terrainHeights.values()][0],160);
 scene.terrainHeights.set('127.3700,36.6300',160);assert.equal(scene._height(127.37,36.63),150);assert.equal(scene._height(127.39,36.65),undefined);
});
test('hub billboard is an orange square and scenery uses finite metric assets',()=>{
 const svg=decodeURIComponent(HUB_SQUARE_IMAGE.split(',')[1]);assert.ok(svg.includes('<rect')&&!svg.includes('<circle'));assert.ok(svg.includes('#eaa66f'));
 for(const p of placements.values()){assert.ok(Number.isFinite(p.heading));assert.ok(fs.existsSync(new URL('assets/'+p.asset,root)));}
});
test('facility entities obey service layer switches and network redraw removes old models',()=>{
 const rows=new Map(),scene=Object.create(MetroScene.prototype);let next=0;
 const Cartesian3={fromDegrees:(lon,lat,height=0)=>({lon,lat,height})};
 Object.assign(scene,{servicePlacements:placements,facilityEntities:[],serviceEntities:[],roadEntities:[],waitingEntities:[],states:[],vehicles:new Map(),layers:{stops:true,hubs:true,routes:true},C:{Cartesian3,Transforms:{headingPitchRollQuaternion:(position,hpr)=>({position,hpr})},HeadingPitchRoll:class{constructor(heading,pitch,roll){Object.assign(this,{heading,pitch,roll});}},Math:{toRadians:n=>n*Math.PI/180},HeightReference:{RELATIVE_TO_GROUND:1,RELATIVE_TO_TERRAIN:2},DistanceDisplayCondition:class{constructor(near,far){Object.assign(this,{near,far});}}},viewer:{entities:{add:o=>{const e={...o,_key:next++};rows.set(e._key,e);return e;},remove:e=>rows.delete(e._key)},scene:{requestRender(){}}}});
 scene._drawFacilities();assert.equal(rows.size,120);const old=[...rows.values()];
 scene.setLayers({hubs:false,stops:false});assert.equal([...rows.values()].filter(e=>e.show).length,1);assert.equal([...rows.values()].find(e=>e.show).metroKind,'depot');
 scene._drawFacilities();assert.equal(rows.size,120);assert.ok(old.every(e=>!rows.has(e._key)));
 scene.setLayers({hubs:true,stops:true});assert.ok([...rows.values()].every(e=>e.show));
 for(const e of rows.values()){assert.equal(e.model.scale,1);assert.equal(e.model.minimumPixelSize,0);assert.equal(e.model.enableVerticalExaggeration,false);assert.equal(e.properties.illustrative,true);}
});
