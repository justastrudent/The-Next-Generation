import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildServicePlacements,offsetPoint,distanceM} from '../service-visuals.js';
import {buildFacilityPriority,facilityConflictForPolygon} from '../facility-priority.js';
import {sampleRoute} from '../replay-core.js';
import {getPostalTruckPlacement,postalTruckFootprint,POSTAL_TRUCK_FOOTPRINT} from '../postal-truck-placement.js';

const root=new URL('../',import.meta.url);
const read=file=>JSON.parse(fs.readFileSync(new URL(file,root)));
const network=read('data/network.json'),placements=buildServicePlacements(network);
const truck=getPostalTruckPlacement(placements,network);
const buffered=postalTruckFootprint(truck,{clearanceM:.4});

function rectangle(p,halfWidth,halfLength){
  return [[-halfWidth,-halfLength],[halfWidth,-halfLength],[halfWidth,halfLength],
          [-halfWidth,halfLength],[-halfWidth,-halfLength]].map(([r,f])=>{
    const pos=offsetPoint(p,r,f);return[pos.lon,pos.lat];
  });
}

test('postal scenery preserves all canonical nodes and service placements',()=>{
  const originalNetwork=JSON.stringify(network),originalPlacements=JSON.stringify([...placements]);
  const result=getPostalTruckPlacement(placements,network);
  assert.equal(JSON.stringify(network),originalNetwork);
  assert.equal(JSON.stringify([...placements]),originalPlacements);
  assert.equal(result.countsAsDrt,false);assert.equal(result.staticScenery,true);
  assert.equal(result.depotId,network.depot);assert.equal(result.asset,'postal-truck.glb');
  assert.ok(Math.abs(result.lon-127.3616875840971)<1e-10);
  assert.ok(Math.abs(result.lat-36.62369983859388)<1e-10);
  assert.ok(distanceM(result,network.nodes[network.depot])>14);
  assert.equal(getPostalTruckPlacement(new Map(),network),null);
  assert.equal(getPostalTruckPlacement(placements,{nodes:{}}),null);
  const invalid=new Map(placements);invalid.set(network.depot,{...placements.get(network.depot),heading:NaN});
  assert.equal(getPostalTruckPlacement(invalid,network),null);
});

test('parked truck clears actual GIS buildings and special facilities without suppressing any polygon',()=>{
  const priority=buildFacilityPriority(placements,{clearanceM:.25});
  assert.equal(facilityConflictForPolygon([buffered.ring],priority),null);
  let checked=0;
  for(const tile of read('data/environment/manifest.json').tiles){
    for(const building of read('data/environment/'+tile.url).buildings){
      for(const polygon of building.polygons){
        checked++;assert.equal(facilityConflictForPolygon(polygon,[buffered]),null,
          `Truck footprint intersects GIS building ${building.id}`);
      }
    }
  }
  assert.ok(checked>=8666);
});

test('all recorded depot arrival headings keep the parked truck clear of 1/2/3-DRT waiting slots',()=>{
  const headings=new Set([0]);let paths=0;
  for(const file of fs.readdirSync(new URL('data/runs/',root)).filter(f=>f.endsWith('.json'))){
    const run=read('data/runs/'+file);
    for(const event of run.events){
      if(event.to!==network.depot||!run.routes[event.pathId])continue;
      const arrival=sampleRoute(run.routes[event.pathId],1);
      if(arrival){headings.add(arrival.heading);paths++;}
    }
  }
  assert.ok(paths>500);
  // Include the full ±9 m three-vehicle envelope plus ±4.5 m two-vehicle slots.
  // The 2.6 × 7.0 m rectangle conservatively encloses the delivered DRT body.
  for(const heading of headings){for(const slot of[-9,-4.5,0,4.5,9]){
    const vehicle={...offsetPoint({...network.nodes[network.depot],heading},0,slot),heading};
    assert.equal(facilityConflictForPolygon([rectangle(vehicle,1.3,3.5)],[buffered]),null,
      `Postal truck conflicts with depot DRT heading ${heading}, slot ${slot}`);
  }}
});

test('placement footprint encloses delivered GLB vertices and the asset stays non-operational',()=>{
  const data=fs.readFileSync(new URL('assets/postal-truck.glb',root));
  assert.equal(data.readUInt32LE(0),0x46546c67);assert.equal(data.readUInt32LE(8),data.length);
  const jsonLength=data.readUInt32LE(12),gltf=JSON.parse(data.subarray(20,20+jsonLength));
  const binary=data.subarray(28+jsonLength);
  assert.equal(gltf.animations?.length||0,0);
  assert.equal(gltf.meshes.length,1);assert.ok(gltf.meshes[0].primitives.length<=14);
  assert.equal(gltf.nodes.find(n=>n.name==='PARKED_POSTAL_TRUCK').extras.counts_as_drt,false);
  let bounds=[Infinity,Infinity,-Infinity,-Infinity],ground=Infinity;
  for(const node of gltf.nodes){if(node.mesh===undefined)continue;
    // The asset is baked into glTF coordinates, with no residual node transform.
    assert.equal(node.matrix,undefined);assert.equal(node.rotation,undefined);assert.equal(node.scale,undefined);
    for(const primitive of gltf.meshes[node.mesh].primitives){
      const a=gltf.accessors[primitive.attributes.POSITION],v=gltf.bufferViews[a.bufferView];
      assert.equal(a.componentType,5126);assert.equal(a.type,'VEC3');
      for(let i=0;i<a.count;i++){
        const offset=(v.byteOffset||0)+(a.byteOffset||0)+i*(v.byteStride||12);
        const right=binary.readFloatLE(offset),up=binary.readFloatLE(offset+4),forward=-binary.readFloatLE(offset+8);
        bounds=[Math.min(bounds[0],right),Math.min(bounds[1],forward),Math.max(bounds[2],right),Math.max(bounds[3],forward)];
        ground=Math.min(ground,up);
      }
    }
  }
  bounds.forEach((value,i)=>assert.ok(Math.abs(value-POSTAL_TRUCK_FOOTPRINT[i])<1e-5));
  assert.ok(ground>=0&&ground<.02);
});
