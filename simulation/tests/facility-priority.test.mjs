import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {buildServicePlacements} from '../service-visuals.js';
import {FACILITY_MODEL_FOOTPRINTS,buildFacilityPriority,facilityConflictForPolygon,prioritizeBuilding} from '../facility-priority.js';
const root=new URL('../',import.meta.url),read=p=>JSON.parse(fs.readFileSync(new URL(p,root)));
const require=createRequire(import.meta.url),C=require('../vendor/cesium/index.cjs');
const lon=127.36,lat=36.62,cos=Math.cos(lat*Math.PI/180);
const xy=(x,y)=>[lon+x/(111320*cos),lat+y/111320];
const ring=(x0,y0,x1,y1)=>[[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]].map(p=>xy(...p));
const priority=(variant='shelter',heading=0)=>buildFacilityPriority(new Map([['a',{id:'a',lon,lat,heading,variant,kind:variant==='depot'?'depot':variant==='hub'?'hub':'stop'}]]),{clearanceM:0});

// Read the delivered mesh vertices and node hierarchy, rather than trusting a model-name size.
function glbVertices(file){
 const b=fs.readFileSync(new URL('assets/'+file,root)),length=b.readUInt32LE(12),g=JSON.parse(b.subarray(20,20+length).toString()),binary=b.subarray(28+length),points=[];
 const walk=(id,parent)=>{const n=g.nodes[id];let matrix;
  if(n.matrix)matrix=C.Matrix4.fromArray(n.matrix);else matrix=C.Matrix4.fromTranslationQuaternionRotationScale(C.Cartesian3.fromArray(n.translation||[0,0,0]),new C.Quaternion(...(n.rotation||[0,0,0,1])),C.Cartesian3.fromArray(n.scale||[1,1,1]));
  matrix=C.Matrix4.multiply(parent,matrix,new C.Matrix4());
  if(n.mesh!==undefined)for(const primitive of g.meshes[n.mesh].primitives){const a=g.accessors[primitive.attributes.POSITION],view=g.bufferViews[a.bufferView];assert.equal(a.componentType,5126);assert.equal(a.type,'VEC3');
   for(let i=0;i<a.count;i++){const offset=(view.byteOffset||0)+(a.byteOffset||0)+i*(view.byteStride||12),p=new C.Cartesian3(binary.readFloatLE(offset),binary.readFloatLE(offset+4),binary.readFloatLE(offset+8));points.push(C.Matrix4.multiplyByPoint(matrix,p,new C.Cartesian3()));}
  }for(const child of n.children||[])walk(child,matrix);
 };
 for(const id of g.scenes[g.scene||0].nodes)walk(id,C.Matrix4.IDENTITY);return points;
}

test('priority rotation matches actual GLB node transforms, Cesium axis correction, and scene heading +90 degrees',()=>{
 const assets={depot:'service-post-office.glb',hub:'service-village-hall.glb',shelter:'service-stop-shelter.glb',sign:'service-stop-sign.glb'};
 const origin=C.Cartesian3.fromDegrees(lon,lat,.025),inverseENU=C.Matrix4.inverseTransformation(C.Transforms.eastNorthUpToFixedFrame(origin),new C.Matrix4()),axis=C.ModelUtility.getAxisCorrectionMatrix(C.Axis.Y,C.Axis.Z,new C.Matrix4());
 for(const[variant,file]of Object.entries(assets)){const vertices=glbVertices(file),expected=FACILITY_MODEL_FOOTPRINTS[variant];
  for(const heading of [0,90,180,270,227.94675065558772]){
   const h=heading*Math.PI/180,world=C.Transforms.headingPitchRollToFixedFrame(origin,new C.HeadingPitchRoll(h+Math.PI/2,0,0)),transform=C.Matrix4.multiply(inverseENU,C.Matrix4.multiply(world,axis,new C.Matrix4()),new C.Matrix4());
   let bb=[Infinity,Infinity,-Infinity,-Infinity];
   for(const vertex of vertices){const p=C.Matrix4.multiplyByPoint(transform,vertex,new C.Cartesian3()),right=p.x*Math.cos(h)-p.y*Math.sin(h),forward=p.x*Math.sin(h)+p.y*Math.cos(h);bb=[Math.min(bb[0],right),Math.min(bb[1],forward),Math.max(bb[2],right),Math.max(bb[3],forward)];}
   expected.forEach((n,i)=>assert.ok(Math.abs(n-bb[i])<1e-5,`${variant} heading ${heading}: ${n} != ${bb[i]}`));
  }
 }
});

test('priority follows measured model footprints and heading, without moving anchors',()=>{
 const placements=buildServicePlacements(read('data/network.json')),original=JSON.stringify([...placements]),masks=buildFacilityPriority(placements);
 assert.equal(masks.length,120);assert.equal(JSON.stringify([...placements]),original);
 for(const p of masks){assert.ok(p.clearanceM<=.25);assert.ok(p.ring.flat().every(Number.isFinite));assert.deepEqual(p.ring[0],p.ring.at(-1));}
 assert.ok(facilityConflictForPolygon([ring(1.5,-.1,1.7,.1)],priority()));
 assert.equal(facilityConflictForPolygon([ring(1.5,-.1,1.7,.1)],priority('shelter',90)),null);
 assert.ok(facilityConflictForPolygon([ring(-.1,1.5,.1,1.7)],priority('shelter',90)));
 for(const row of read('docs/service-model-validation.json')){
  const kind={'service-post-office.glb':'depot','service-village-hall.glb':'hub','service-stop-shelter.glb':'shelter','service-stop-sign.glb':'sign'}[row.asset];if(!kind)continue;
  const b=FACILITY_MODEL_FOOTPRINTS[kind],actual=row.bounds_blender_z_up;assert.ok(Math.abs(b[0]-actual[0][0])<1e-5&&Math.abs(b[1]-actual[0][1])<1e-5&&Math.abs(b[2]-actual[1][0])<1e-5&&Math.abs(b[3]-actual[1][1])<1e-5);
 }
});
test('distant neighbours and a model inside a courtyard hole are retained',()=>{
 assert.equal(facilityConflictForPolygon([ring(3,3,20,20)],priority()),null);
 const courtyard=[ring(-10,-10,10,10),ring(-3,-3,3,3)];assert.equal(facilityConflictForPolygon(courtyard,priority()),null);
 // Its corner crosses the courtyard wall, so actual overlap now exists.
 assert.ok(facilityConflictForPolygon([ring(-10,-10,10,10),ring(-1,-1,1,1)],priority()));
 // Crossing strips have no vertices inside each other: segment intersections must be checked.
 assert.ok(facilityConflictForPolygon([ring(-10,-.1,10,.1)],priority()));
});
test('only the conflicting MultiPolygon component is excluded; source object and unaffected object identity stay intact',()=>{
 const near=[ring(-2,-2,2,2)],far=[ring(20,20,30,30)],b={id:'mixed',height:12,polygons:[near,far]},copy=JSON.stringify(b);
 const next=prioritizeBuilding(b,priority());assert.equal(next.polygons.length,1);assert.equal(next.polygons[0],far);assert.equal(JSON.stringify(b),copy);assert.equal(next.height,12);
 const isolated={polygons:[far]};assert.equal(prioritizeBuilding(isolated,priority()),isolated);assert.equal(prioritizeBuilding({polygons:[near]},priority()),null);
 assert.equal(prioritizeBuilding(b,[]),b);
});
test('actual post office collision is resolved with bounded changes across all 8666 buildings',()=>{
 const net=read('data/network.json'),masks=buildFacilityPriority(buildServicePlacements(net)),manifest=read('data/environment/manifest.json');let total=0,excluded=0,depot=0;
 for(const t of manifest.tiles){for(const b of read('data/environment/'+t.url).buildings){total++;const prior=JSON.stringify(b),next=prioritizeBuilding(b,masks);assert.equal(JSON.stringify(b),prior);
  if(!next)excluded++;else for(const polygon of next.polygons)assert.equal(facilityConflictForPolygon(polygon,masks),null);
  if(b.id==='196849'){depot++;assert.equal(b.height,7.3);assert.equal(next,null);assert.equal(facilityConflictForPolygon(b.polygons[0],masks).id,'DEPOT');}
 }}assert.equal(total,8666);assert.equal(excluded,37);assert.equal(depot,1);assert.ok(excluded/total<.005);
});
