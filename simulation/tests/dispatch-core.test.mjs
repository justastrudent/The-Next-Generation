#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {prepareDispatch,dispatchAt,nextDispatchTime} from '../dispatch-core.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const network=read('data/network.json');
const validation=read('docs/dispatch-validation.json');
let checks=0,runCount=0,callChecks=0,pathChecks=0,rewindChecks=0;const errors=[];
function check(value,label){checks++;if(!value&&errors.length<100)errors.push(label);}
function near(a,b,label,eps=1e-6){check(Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=eps,`${label}: ${a} != ${b}`);}

for(const file of fs.readdirSync(path.join(root,'data/decisions')).filter(x=>x.endsWith('.json')).sort()){
  const data=read('data/decisions/'+file),run=read('data/runs/'+file);
  const canonicalBytes=fs.readFileSync(path.join(root,'data/runs',file));
  check(data.provenance.canonicalRunSha256===crypto.createHash('sha256').update(canonicalBytes).digest('hex'),`${file}: immutable canonical input`);
  check(data.runId===run.id,`${file}: exact run identity`);
  const prepared=prepareDispatch(data,run,network);
  check(prepared.available,`${file}: verified data available`);
  const initial=dispatchAt(prepared,30,1);
  check(initial.receivedCalls.length===run.passengers.filter(p=>p.call<=30+1e-7).length,`${file}: only actually revealed calls at start`);
  for(const [key,route] of Object.entries(data.paths)){
    let current=network.nodes[route.from]?.graphIndex,time=0;
    for(const ref of route.edges){
      const road=network.roads[Math.abs(ref)-1];
      check(!!road,`${file} ${key}: actual road segment`);
      if(!road)break;
      check(ref>0||road.oneway===0,`${file} ${key}: respects one-way direction`);
      check(current===(ref>0?road.fromIndex:road.toIndex),`${file} ${key}: topologically consecutive directed segments`);
      current=ref>0?road.toIndex:road.fromIndex;time+=road.minutes;
    }
    check(current===network.nodes[route.to]?.graphIndex,`${file} ${key}: reaches actual destination`);
    near(time,route.minutes,`${file} ${key}: travel time weights`);
    pathChecks++;
  }
  for(const call of data.calls){
    const p=run.passengers.find(p=>String(p.id)===call.requestId);
    near(call.time,p.call,`${file} ${call.requestId}: actual call time`);
    check(call.vehicle===Number(p.vehicle),`${file} ${call.requestId}: recorded assigned vehicle`);
    const s=data.snapshots.find(s=>Math.abs(s.time-call.time)<1e-7);
    const planned=s.vehicles[String(call.vehicle)].stops.find(st=>st.kind==='PU'&&st.requestId===call.requestId);
    near(planned.time,call.promisedPickup,`${file} ${call.requestId}: original acceptance promise`);
    callChecks++;
  }
  // Check an irregular sequence (including rewinds and a vehicle change), not a
  // forward-only accumulator; future observed outcomes must stay inaccessible.
  for(const time of [149.9,600,30.1,150,300.123,990,45,500,150]){
    const vehicle=1+(Math.floor(time)%3),view=dispatchAt(prepared,time,vehicle);
    const expected=run.passengers.filter(p=>p.call<=time+1e-7);
    check(view.receivedCalls.length===expected.length,`${file} at ${time}: revealed call count`);
    for(const c of view.receivedCalls){
      check(c.call<=time+1e-7,`${file}: no future call`);
      const passenger=run.passengers.find(p=>String(p.id)===c.id);
      if(passenger.pickup>time+1e-7)check(!('pickup' in c)&&!('wait' in c)&&!('actualWaitMin' in c),`${file}: no future observed wait`);
    }
    for(const stop of view.currentPlan.stops){
      check(stop.completed>time+1e-7,`${file}: completed planned work removed`);
      if(stop.requestId)check(view.receivedCalls.some(c=>c.id===stop.requestId),`${file}: committed stops reference revealed demand`);
    }
    const snapshot=JSON.stringify(view);
    dispatchAt(prepared,Math.max(30,time-25),vehicle===3?1:vehicle+1);
    check(JSON.stringify(dispatchAt(prepared,time,vehicle))===snapshot,`${file}: deterministic rewind and vehicle switch`);
    rewindChecks++;
  }
  const firstCall=data.calls[0];
  if(firstCall){
    const before=dispatchAt(prepared,firstCall.time-1e-5,firstCall.vehicle);
    check(!before.receivedCalls.some(p=>p.id===firstCall.requestId),`${file}: exact call reveal boundary`);
    near(nextDispatchTime(prepared,firstCall.time-1e-5,firstCall.vehicle),firstCall.time,`${file}: next decision navigation`);
  }
  // Mismatched scenario data must not silently display another run's plans.
  check(!prepareDispatch({...data,runId:'another-run'},run,network).available,`${file}: reject mismatched run`);
  runCount++;
}

check(runCount===42,'All seven dates, three scenarios and two independent modes are covered');
check(callChecks===531*6,'531 weekly passenger requests represented in each of six operating combinations');
check(validation.snapshotCount===11368,'All original plan snapshots retained');
check(validation.maxPromiseDifferenceMin===0,'All original pickup promises reproduced without time alteration');
check(validation.fullFleetScoreChecks>callChecks,'Entire remaining-fleet scores cross-checked, not only new calls');

// Poison future data; present-time state must remain identical.
const run=read('data/runs/2023-11-06_integrated_S1.json'),data=read('data/decisions/'+run.id+'.json');
const now=100;const original=dispatchAt(prepareDispatch(data,run,network),now,1);
const poison=structuredClone(data),poisonRun=structuredClone(run);
for(const c of poison.calls)if(c.time>now){c.promisedPickup=987654;c.promisedWaitMin=987654;c.vehicle=3;}
for(const s of poison.snapshots)if(s.time>now){s.vehicles={};s.revealedIds=['NOT_YET_RECEIVED'];}
for(const p of poisonRun.passengers)if(p.pickup>now){p.pickup+=10000;p.dropoff+=10000;p.wait=99999;}
const poisoned=dispatchAt(prepareDispatch(poison,poisonRun,network),now,1);
check(JSON.stringify(original)===JSON.stringify(poisoned),'Changing future plans/observed waits cannot change current decisions');

const report={passed:errors.length===0,checks,runCount,callChecks,pathChecks,rewindChecks,errors};
fs.writeFileSync(path.join(root,'docs/dispatch-core-test-results.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(errors.length)process.exitCode=1;
