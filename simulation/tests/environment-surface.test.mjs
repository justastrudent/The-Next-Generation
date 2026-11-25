import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import EnvironmentVehicleSurface from '../environment-vehicle-surface.js';
const require=createRequire(import.meta.url),C=require('../vendor/cesium/index.cjs');
const close=(a,b)=>assert(Math.abs(a-b)<1e-5,`${a} != ${b}`);
const at=C.JulianDate.fromIso8601('2023-11-06T02:00:00Z');
const height=e=>C.Cartographic.fromCartesian(e.position.getValue(at)).height;
const ref=(e,k='model')=>e[k].heightReference.getValue(at);

function fixture(){
 let bridge=true;const queries=[];
 const environment={surfaceHeightAt(lon,lat,heading){queries.push([lon,lat,heading]);return bridge&&lon<127.3605?90:undefined;}};
 const canonical=Object.freeze({id:1,lon:127.36,lat:36.6,heading:90,passengers:4,cargo:7,time:210});
 const model=(id,local)=>new C.Entity({id,position:C.Cartesian3.fromDegrees(canonical.lon,canonical.lat,local),model:{heightReference:C.HeightReference.RELATIVE_TO_GROUND}});
 const rec={state:canonical,displayState:canonical,entity:model('bus',.035),person:model('person',.06),parcel:model('parcel',1.13),
  serviceLabel:new C.Entity({id:'badge',position:C.Cartesian3.fromDegrees(canonical.lon,canonical.lat,3.05),billboard:{heightReference:C.HeightReference.RELATIVE_TO_GROUND}})};
 const entities=new C.EntityCollection();for(const name of ['entity','person','parcel','serviceLabel'])entities.add(rec[name]);
 const nativeHeight=function(){return 50;};
 const scene={C,states:[canonical],selected:1,vehicles:new Map([['1',rec]]),_height:nativeHeight,
  viewer:{clock:{currentTime:at},entities,scene:{verticalExaggeration:.9}}};
 const surface=new EnvironmentVehicleSurface(environment);surface.attach(scene);
 function normalFrame(lon=canonical.lon){
  // The app calls the unchanged scene/vehicle update before the display extension.
  for(const[name,local]of [['entity',.035],['person',.06],['parcel',1.13],['serviceLabel',3.05]])
   rec[name].position=C.Cartesian3.fromDegrees(lon,canonical.lat,local);
 }
 return {surface,scene,rec,canonical,normalFrame,queries,nativeHeight,setBridge:v=>{bridge=v;}};
}

test('actual Cesium entities receive one absolute deck height plus local model/badge offsets',()=>{
 const f=fixture(),snapshot=JSON.stringify(f.canonical);f.surface.update();
 close(height(f.rec.entity),90.035);close(height(f.rec.person),90.06);close(height(f.rec.parcel),91.13);close(height(f.rec.serviceLabel),93.05);
 assert.equal(ref(f.rec.entity),C.HeightReference.NONE);assert.equal(ref(f.rec.person),C.HeightReference.NONE);
 assert.equal(ref(f.rec.parcel),C.HeightReference.NONE);assert.equal(ref(f.rec.serviceLabel,'billboard'),C.HeightReference.NONE);
 // 90m is already the displayed deck altitude. Applying .9 again would give 81m and fail above.
 assert.equal(JSON.stringify(f.canonical),snapshot);assert.equal(f.rec.state.passengers,4);assert.equal(f.rec.state.cargo,7);
 assert(f.queries.every(q=>q[2]===90));f.surface.destroy();
});

test('consecutive normal frames do not accumulate deck height; leaving bridge restores relative references',()=>{
 const f=fixture();for(let i=0;i<5;i++){f.normalFrame();f.surface.update();close(height(f.rec.entity),90.035);close(height(f.rec.serviceLabel),93.05);}
 f.normalFrame(127.361);f.surface.update();close(height(f.rec.entity),.035);close(height(f.rec.serviceLabel),3.05);
 assert.equal(ref(f.rec.entity),C.HeightReference.RELATIVE_TO_GROUND);
 assert.equal(ref(f.rec.serviceLabel,'billboard'),C.HeightReference.RELATIVE_TO_GROUND);
 f.surface.destroy();
});

test('bridge layer off and hidden actors restore their original height references on next canonical frame',()=>{
 const f=fixture();f.surface.update();f.rec.person.show=false;f.setBridge(false);f.normalFrame();f.surface.update();
 for(const name of ['entity','person','parcel'])assert.equal(ref(f.rec[name]),C.HeightReference.RELATIVE_TO_GROUND);
 assert.equal(ref(f.rec.serviceLabel,'billboard'),C.HeightReference.RELATIVE_TO_GROUND);close(height(f.rec.entity),.035);
 f.surface.destroy();
});

test('replaced badge graphics keep their new relative reference and camera height uses selected heading without double scale',()=>{
 const f=fixture();f.surface.update();f.rec.serviceLabel.billboard=new C.BillboardGraphics({heightReference:C.HeightReference.RELATIVE_TO_GROUND});
 f.normalFrame();f.surface.update();close(height(f.rec.serviceLabel),93.05);
 close(f.scene._height(127.36,36.6),90);assert.equal(f.queries.at(-1)[2],90);
 close(f.scene._height(127.361,36.6),50);
 f.setBridge(false);f.normalFrame();f.surface.update();assert.equal(ref(f.rec.serviceLabel,'billboard'),C.HeightReference.RELATIVE_TO_GROUND);
 f.surface.detach();assert.equal(f.scene._height,f.nativeHeight);close(f.scene._height(127.36,36.6),50);
});
