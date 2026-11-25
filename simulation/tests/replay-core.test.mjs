#!/usr/bin/env node
/** Independent source-log checks of the browser's deterministic replay core. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {clock, sampleRoute, prepareRun, stateAt, aggregateAt} from '../replay-core.js';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const rawOption=args.indexOf('--raw');
const rawBase=rawOption>=0?path.resolve(args[rawOption+1]):path.resolve(project,'../research_data/results/gangnae_online/results');
const dist=project;
const readJSON=p=>JSON.parse(fs.readFileSync(p,'utf8'));
let checks=0;const errors=[];
function check(ok,msg){checks++;if(!ok&&errors.length<1000)errors.push(msg);}
function close(a,b,msg,tol=1e-6){check(Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=tol,`${msg}: ${a} != ${b}`);}
function csv(p){
  const text=fs.readFileSync(p,'utf8').replace(/^\uFEFF/,'');
  const rows=[];let row=[],field='',quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(c==='"'&&text[i+1]==='"'){field+='"';i++;}else if(c==='"')quoted=false;else field+=c;}
    else if(c==='"')quoted=true;
    else if(c===','){row.push(field);field='';}
    else if(c==='\n'){row.push(field.replace(/\r$/,''));rows.push(row);row=[];field='';}
    else field+=c;
  }
  if(field||row.length){row.push(field.replace(/\r$/,''));rows.push(row);}
  const header=rows.shift()||[];
  return rows.filter(r=>r.some(Boolean)).map(r=>Object.fromEntries(header.map((h,i)=>[h,r[i]??''])));
}
const number=(v,otherwise=null)=>v===null||v===undefined||v===''?otherwise:Number(v);
function pointClose(actual,expected,msg){close(actual.lon,expected.lon,`${msg} longitude`,1e-8);close(actual.lat,expected.lat,`${msg} latitude`,1e-8);}

// Time-origin and variable-speed regression cases are independent of the data converter.
for(const [t,expected] of [[30,'06:30'],[150,'08:30'],[960,'22:00'],[990,'22:30']])check(clock(t)===expected,`Clock ${t} must be ${expected}`);
const testRoute={coordinates:[[127,36],[127.001,36],[127.002,36]],fractions:[0,.25,1],distanceFractions:[0,.5,1],minutes:4,distanceKm:2,quality:'reconstructed_network'};
close(sampleRoute(testRoute,.125).lon,127.0005,'Time fraction interpolates first road segment',1e-10);
close(sampleRoute(testRoute,.625).lon,127.0015,'Time fraction interpolates second road segment',1e-10);
const syntheticNetwork={nodes:{DEPOT:{lon:127,lat:36},END:{lon:127.002,lat:36}},depot:'DEPOT'};
const syntheticRun={events:[{id:0,vehicle:1,kind:'TRANSIT',departure:30,time:34,completed:34,from:'DEPOT',to:'END',distanceKm:2,travelMin:4,passengers:0,cargo:0,pathId:'a'}],routes:{a:testRoute},passengers:[],parcels:[]};
const synthetic=prepareRun(syntheticRun,syntheticNetwork);
close(stateAt(synthetic,30.5)[0].distanceKm,.5,'Variable-speed distance follows road progress');
close(stateAt(synthetic,32.5)[0].distanceKm,1.5,'Variable-speed second-segment distance');

const manifest=readJSON(path.join(dist,'data/manifest.json'));
const network=readJSON(path.join(dist,manifest.networkUrl));
let movementCount=0,parkingCount=0,serviceCount=0,runCount=0;
for(const entry of manifest.runs){
  const run=readJSON(path.join(dist,entry.url));
  const fingerprint=JSON.stringify(run);
  const prepared=prepareRun(run,network);
  const suffix=run.mode==='passenger_only'?'_passenger_only':'';
  const sourceFolder=path.join(rawBase,run.date,run.scenario+suffix);
  const source=csv(path.join(sourceFolder,'events.csv'));
  const sourcePassengers=csv(path.join(sourceFolder,'passengers.csv'));
  const sourceParcels=csv(path.join(sourceFolder,'parcels.csv'));
  const summary=readJSON(path.join(sourceFolder,'summary.json'));
  const sourceVehicles=csv(path.join(sourceFolder,'vehicles.csv'));
  const runEvents=new Map(run.events.map(e=>[Number(e.id),e]));
  const people=new Map(sourcePassengers.map(p=>[p.request_id,number(p.people,1)]));
  for(const vid of [1,2,3]){
    const rows=source.map((r,i)=>({...r,index:i})).filter(r=>number(r.vehicle)===vid&&r.distance_km!=='');
    const onboard=new Set();let cargo=0;
    for(const raw of rows){
      movementCount++;
      const beforePeople=[...onboard].reduce((a,id)=>a+(people.get(id)||1),0);
      const dep=number(raw.departure_min),arrival=number(raw.time_min),done=number(raw.completed_min);
      const e=runEvents.get(raw.index),tag=`${run.id}/vehicle ${vid}/event ${raw.index}`;
      if(!e){check(false,`${tag}: missing transformed event`);continue;}
      if(arrival-dep>1e-6){
        const t=(dep+arrival)/2,actual=stateAt(prepared,t)[vid-1];
        close(actual.passengers,beforePeople,`${tag}: in-motion passenger count`);
        close(actual.cargo,cargo,`${tag}: in-motion cargo count`);
        check(actual.event?.id===e.id,`${tag}: active movement is wrong`);
        if(raw.kind==='PARK_SEARCH'){
          parkingCount++;
          check(actual.status==='parking',`${tag}: parking status`);
          check(actual.geometryQuality==='virtual_stationary',`${tag}: virtual parking quality`);
          pointClose(actual,network.nodes[raw.from_node],`${tag}: virtual parking stays at last service node`);
          check(actual.animation===null,`${tag}: virtual parking must not invent a service animation`);
        } else if(e.pathId){
          const route=run.routes[e.pathId];
          const expected=sampleRoute(route,.5);
          pointClose(actual,expected,`${tag}: road-following interpolation`);
          check(['empty','passenger','parcel','mixed','return'].includes(actual.status),`${tag}: unexpected movement status ${actual.status}`);
        }
      }
      if(done-arrival>1e-6){
        serviceCount++;
        const actual=stateAt(prepared,(arrival+done)/2)[vid-1];
        close(actual.passengers,beforePeople,`${tag}: service retains pre-completion passengers`);
        close(actual.cargo,cargo,`${tag}: service retains pre-completion cargo`);
        pointClose(actual,network.nodes[raw.node],`${tag}: stationary service position`);
        const status={PU:'boarding',DO:'alighting',LOAD:'loading',RESTOCK:'loading',DELIVER:'delivery'}[raw.kind];
        check(actual.status===status,`${tag}: service animation status ${actual.status} != ${status}`);
        check(actual.animation?.kind===status,`${tag}: missing boarding/loading animation state`);
        close(actual.animation?.progress,.5,`${tag}: service animation progress`,1e-6);
      }
      if(raw.kind==='PU')onboard.add(raw.request_id);
      if(raw.kind==='DO')onboard.delete(raw.request_id);
      if(raw.kind==='LOAD'||raw.kind==='RESTOCK')cargo+=number(raw.quantity,0);
      if(raw.kind==='DELIVER')cargo-=number(raw.quantity,0);
      const afterPeople=[...onboard].reduce((a,id)=>a+(people.get(id)||1),0);
      const after=stateAt(prepared,done+1e-6)[vid-1];
      close(after.passengers,afterPeople,`${tag}: completion passenger count`);
      close(after.cargo,cargo,`${tag}: completion cargo count`);
    }
  }
  // Waiting ends at recorded pickup ARRIVAL. The UI's completed-transport
  // counter ends at the dropoff SERVICE COMPLETION, matching its animation.
  for(const t of [30,150,360,600,960,990]){
    const metric=aggregateAt(run,t);
    const waiting=sourcePassengers.filter(p=>number(p.call_min)<=t&&number(p.pickup_min,Infinity)>t).length;
    const served=source.filter(e=>e.kind==='DO'&&number(e.completed_min,Infinity)<=t).length;
    const delivered=sourceParcels.filter(p=>number(p.delivered_min,Infinity)<=t).length;
    check(metric.waiting===waiting,`${run.id}/${t}: waiting source metric`);
    check(metric.served===served,`${run.id}/${t}: completed passenger service metric`);
    check(metric.delivered===delivered,`${run.id}/${t}: parcel completion metric`);
  }
  const final=stateAt(prepared,990);
  close(final.reduce((a,v)=>a+v.distanceKm,0),summary.total_km,`${run.id}: final fleet mileage`);
  close(final.reduce((a,v)=>a+v.parkingKm,0),summary.parking_virtual_km,`${run.id}: final virtual mileage`);
  for(const v of final){
    pointClose(v,network.nodes.DEPOT,`${run.id}/${v.id}: final depot location`);
    close(v.passengers,0,`${run.id}/${v.id}: final empty passenger state`);
    close(v.cargo,0,`${run.id}/${v.id}: final empty cargo state`);
    const original=sourceVehicles.find(x=>number(x.vehicle)===v.id);
    if(original)close(v.distanceKm,number(original.total_km),`${run.id}/${v.id}: final vehicle mileage`);
  }
  // Backward seeking and repeated arbitrary seeking must not accumulate state.
  const snapshot=JSON.stringify(stateAt(prepared,543.21));
  for(const t of [990,30,730.9,61,900,543.21])stateAt(prepared,t);
  check(JSON.stringify(stateAt(prepared,543.21))===snapshot,`${run.id}: seek/restart determinism`);
  check(JSON.stringify(run)===fingerprint,`${run.id}: replay mutates source data`);
  runCount++;
}
check(runCount===42,'All 42 replays tested');
check(movementCount===18384,'All 18,384 execution events tested');
check(parkingCount===1479,'All 1,479 virtual parking events tested');
const result={status:errors.length?'failed':'passed',checks,runCount,movementCount,parkingCount,serviceCount,errorCount:errors.length,errors};
fs.mkdirSync(path.join(project,'docs'),{recursive:true});
fs.writeFileSync(path.join(project,'docs/replay-core-test-results.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({...result,errors:errors.slice(0,20)},null,2));
process.exitCode=errors.length?1:0;
