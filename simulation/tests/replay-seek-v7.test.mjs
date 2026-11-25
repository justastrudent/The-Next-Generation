import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import * as replay from '../replay-core.js';

// Independent reference copied verbatim (exports removed) from the supplied V6
// ZIP replay-core.js, SHA256:
// feacc236fa61ec58fd9af774e93f0533c3c42fcf7808e97997c0e231d392c592
// Keep this reference unchanged when editing the optimized implementation.
// Deterministic replay. No animation frame mutates research data or accumulates state.
const VEHICLE_COLORS = ['#52e0c4', '#ffb65b', '#a79bff'];
const KIND_LABELS = { ACTIVATE:'운행 시작', TRANSIT:'도로 이동', PU:'승객 승차', DO:'승객 하차', LOAD:'최초 물류 적재', RESTOCK:'물류 재적재', DELIVER:'물류 배송', PARCEL:'물류 배송', RETURN:'우체국 복귀', PARK_SEARCH:'가상 주차 탐색' };
const STATUS_LABELS = { mixed:'여객·물류 운송', passenger:'여객 운송', parcel:'물류 운송', empty:'공차 이동', boarding:'승객 승차', alighting:'승객 하차', loading:'물류 적재', delivery:'물류 배송', parking:'가상 주차 탐색', idle:'대기', return:'우체국 복귀', unknown:'경로 확인 필요', inactive:'미배차 대기' };
const SCENARIOS = { S0:'거리 최소화', S1:'승객 대기 최소화', S2:'통합비용 최소화' };
const finite = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const clamp = (n,a,b)=>Math.max(a,Math.min(b,n));
function clock(min, seconds=false) {
  if (!finite(min)) return '—';
  const total = Math.round((360+Number(min))*60), h=Math.floor(total/3600), m=Math.floor(total/60)%60, s=total%60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}${seconds?':'+String(s).padStart(2,'0'):''}`;
}
function bearing(a,b) {
  if (!a || !b) return 0;
  const rad=Math.PI/180, la=a[1]*rad, lb=b[1]*rad, dl=(b[0]-a[0])*rad;
  return (Math.atan2(Math.sin(dl)*Math.cos(lb),Math.cos(la)*Math.sin(lb)-Math.sin(la)*Math.cos(lb)*Math.cos(dl))/rad+360)%360;
}
function sampleRoute(route, fraction) {
  const cs=route?.coordinates;
  if (!cs?.length) return null;
  if (cs.length===1) return {lon:cs[0][0],lat:cs[0][1],heading:0};
  const f=clamp(fraction,0,1), fs=route.fractions;
  if(!Array.isArray(fs)||fs.length!==cs.length||fs[0]!==0||fs.at(-1)!==1||fs.some((x,i)=>!Number.isFinite(x)||x<0||x>1||(i>0&&x<fs[i-1])))return null;
  let lo=0,hi=cs.length-1;
  while (lo+1<hi) {const mid=(lo+hi)>>1;if(fs[mid]<=f)lo=mid;else hi=mid;}
  const start=fs[lo],end=fs[hi];
  const p=end>start?clamp((f-start)/(end-start),0,1):0;
  let head=bearing(cs[lo],cs[hi]);
  if(cs[lo][0]===cs[hi][0]&&cs[lo][1]===cs[hi][1]&&hi+1<cs.length)head=bearing(cs[hi],cs[hi+1]);
  const ds=route.distanceFractions;
  const distanceFraction=ds?.length===cs.length?ds[lo]+(ds[hi]-ds[lo])*p:f;
  return {lon:cs[lo][0]+(cs[hi][0]-cs[lo][0])*p,lat:cs[lo][1]+(cs[hi][1]-cs[lo][1])*p,heading:head,distanceFraction};
}
function prepareRun(run,network) {
  const byVehicle={};
  for (const id of [1,2,3]) {
    const events=run.events.filter(e=>Number(e.vehicle)===id).map(e=>({...e,departure:finite(e.departure)?+e.departure:+e.time,completed:finite(e.completed)?+e.completed:+e.time}));
    events.sort((a,b)=>a.departure-b.departure||a.time-b.time||a.completed-b.completed);
    let p=0,c=0;
    const completed=[...events].sort((a,b)=>a.completed-b.completed||a.time-b.time).map(e=>{
      if(finite(e.passengers))p=+e.passengers;
      if(finite(e.cargo))c=+e.cargo;
      return {...e,afterPassengers:p,afterCargo:c};
    });
    byVehicle[id]={events,completed};
  }
  return {run,network,byVehicle};
}
function stateAt(prepared,time,selected=1) {
  const {run,network,byVehicle}=prepared;
  return [1,2,3].map(id=>{
    const {events,completed}=byVehicle[id];
    let last=null,p=0,c=0;
    for(const e of completed){if(e.completed>time+1e-7)break;last=e;p=e.afterPassengers;c=e.afterCargo;}
    let current=null;
    for(const e of events){if(e.departure>time+1e-7)break;if(e.completed>time+1e-7)current=e;}
    const lastLocation=[...completed].reverse().find(e=>e.completed<=time+1e-7&&network.nodes[e.to]);
    const depot=network.nodes[network.depot||'DEPOT'];
    let pos=lastLocation?network.nodes[lastLocation.to]:depot;
    let route=current?.pathId?run.routes[current.pathId]:null;
    let status=last?'idle':'inactive',progress=0,animation=null,quality='mapped_service_node',heading=0;
    const previousPath=lastLocation?.pathId?run.routes[lastLocation.pathId]:null;
    if(previousPath) heading=sampleRoute(previousPath,1)?.heading||0;
    if(current){
      if(current.kind==='PARK_SEARCH') {
        pos=network.nodes[current.from]||network.nodes[current.to]||pos;status='parking';quality='virtual_stationary';
        progress=clamp((time-current.departure)/Math.max(.0001,current.completed-current.departure),0,1);
      } else if(time<current.time-1e-7) {
        progress=clamp((time-current.departure)/Math.max(.0001,current.time-current.departure),0,1);
        const sample=sampleRoute(route,progress);
        if(sample){pos=sample;heading=sample.heading;status=current.kind==='RETURN'?'return':p>0&&c>0?'mixed':p>0?'passenger':c>0?'parcel':'empty';quality='network_interpolation';}
        else{pos=network.nodes[current.from]||pos;status='unknown';quality='unresolved';}
      } else {
        pos=network.nodes[current.to]||pos;
        if(route)heading=sampleRoute(route,1)?.heading||heading;
        progress=clamp((time-current.time)/Math.max(.0001,current.completed-current.time),0,1);
        const kind={PU:'boarding',DO:'alighting',LOAD:'loading',RESTOCK:'loading',DELIVER:'delivery',PARCEL:'delivery'}[current.kind];
        status=kind||'idle';
        if(kind)animation={kind,progress,quantity:current.quantity||1,requestId:current.requestId};
      }
    }
    let distanceKm=0,parkingKm=0;
    for(const e of events){if(!finite(e.distanceKm))continue;let fraction=0;if(time>=e.completed)fraction=1;else if(e.kind==='PARK_SEARCH'&&time>e.departure)fraction=clamp((time-e.departure)/Math.max(.0001,e.completed-e.departure),0,1);else if(time>=e.time)fraction=1;else if(time>e.departure){const temporal=clamp((time-e.departure)/Math.max(.0001,e.time-e.departure),0,1);fraction=sampleRoute(run.routes[e.pathId],temporal)?.distanceFraction??temporal;}distanceKm+=e.distanceKm*fraction;if(e.kind==='PARK_SEARCH')parkingKm+=e.distanceKm*fraction;}
    return {id,lon:pos?.lon,lat:pos?.lat,heading,status,passengers:p,cargo:c,event:current||last,progress,selected:id===selected,route:route?.coordinates||[],animation,geometryQuality:quality,distanceKm,parkingKm};
  });
}
function aggregateAt(run,time){
  const people=run.passengers||[],parcels=run.parcels||[];
  return {waiting:people.filter(p=>finite(p.call)&&p.call<=time&&(!finite(p.pickup)||p.pickup>time)).length,served:(run.events||[]).filter(e=>e.kind==='DO'&&finite(e.completed)&&e.completed<=time).length,delivered:parcels.filter(p=>finite(p.delivered)&&p.delivered<=time).length};
}


const report={reference:'MetroRookies_Visual_Decision_v6/replay-core.js',referenceSha256:'feacc236fa61ec58fd9af774e93f0533c3c42fcf7808e97997c0e231d392c592',runs:0,boundarySeeks:0,randomSeeks:0,vehicleStates:0,maxNumericDifference:0,canonicalInputsUnchanged:true,syntheticCases:0};
const root=new URL('../',import.meta.url),read=name=>JSON.parse(readFileSync(new URL(name,root),'utf8'));
const network=read('data/network.json');
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
let seed=0x526f6f6b;function random(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;}
function compareStates(oldPrepared,newPrepared,time,selected,label){
  const expected=stateAt(oldPrepared,time,selected),actual=replay.stateAt(newPrepared,time,selected);
  for(let v=0;v<3;v++){
    const a=actual[v],e=expected[v];
    for(const key of ['id','lon','lat','heading','passengers','cargo','progress','distanceKm','parkingKm']){
      if(typeof e[key]==='number'&&typeof a[key]==='number'){
        const delta=Math.abs(a[key]-e[key]);
        if(Number.isNaN(e[key]))assert.ok(Number.isNaN(a[key]),`${label} ${time} ${key}`);
        else {assert.ok(delta<=1e-10,`${label} ${time} vehicle ${v+1} ${key}: ${a[key]} != ${e[key]}`);report.maxNumericDifference=Math.max(report.maxNumericDifference,delta);}
      }else assert.equal(a[key],e[key],`${label} ${time} ${key}`);
    }
    for(const key of ['status','selected','geometryQuality'])assert.equal(a[key],e[key],`${label} ${time} ${key}`);
    if(e.route.length)assert.equal(a.route,e.route,`${label} ${time}: same canonical route coordinates`);
    else assert.equal(a.route.length,0,`${label} ${time}: no active route`);
    assert.equal(a.event?.id,e.event?.id,`${label} ${time}: same event`);
    assert.equal(a.event?.afterPassengers,e.event?.afterPassengers,`${label} ${time}: current vs completed event semantics`);
    assert.equal(a.event?.afterCargo,e.event?.afterCargo,`${label} ${time}: completed cargo semantics`);
    assert.deepEqual(a.animation,e.animation,`${label} ${time}: same service animation interval`);
  }
  report.vehicleStates+=3;
}

test('all 42 V6 runs: every event boundary, rounding tolerance and random backwards/forwards seeks preserve exact replay outputs',()=>{
  const files=readdirSync(new URL('data/runs/',root)).filter(name=>name.endsWith('.json')).sort();
  for(const file of files){
    const run=read('data/runs/'+file),before=digest(run),oldPrepared=prepareRun(run,network),newPrepared=replay.prepareRun(run,network);
    assert.deepEqual(newPrepared.byVehicle,oldPrepared.byVehicle,`${file}: canonical prepared event records unchanged`);
    const times=new Set([30,990]);
    for(const event of run.events)for(const time of [event.departure,event.time,event.completed])if(Number.isFinite(time)){
      for(const delta of [-2e-7,-1e-7,-1e-8,0,1e-8,1e-7,2e-7])times.add(time+delta);
    }
    // Alternate end/start to exercise discontinuous seeks instead of a forward
    // accumulator; include precision boundaries around the original 1e-7 epsilon.
    const ordered=[...times].sort((a,b)=>a-b);let lo=0,hi=ordered.length-1;
    while(lo<=hi){const i=lo+hi,t=(lo+hi)%2?ordered[hi--]:ordered[lo++];compareStates(oldPrepared,newPrepared,t,1+i%3,file);report.boundarySeeks++;}
    for(let i=0;i<300;i++){compareStates(oldPrepared,newPrepared,30+random()*960,1+i%3,file);report.randomSeeks++;}
    assert.equal(digest(run),before,`${file}: source records untouched`);report.runs++;
  }
  assert.equal(report.runs,42);assert.ok(report.boundarySeeks>300000);
});

test('overlapping, tied, interrupted parking, missing paths and zero-duration synthetic events retain V6 ordering semantics',()=>{
  const syntheticNetwork={depot:'D',nodes:{D:{lon:127,lat:36},A:{lon:127.001,lat:36.001},B:{lon:127.002,lat:36.002}}};
  const route={coordinates:[[127,36],[127.001,36.001],[127.002,36.002]],fractions:[0,.25,1],distanceFractions:[0,.7,1]};
  const ev=(id,kind,departure,time,completed,distanceKm,more={})=>({id,vehicle:1,kind,departure,time,completed,distanceKm,from:'D',to:'A',pathId:'r',passengers:1,cargo:0,...more});
  const variants=[
    [ev(0,'PU',0,20,21,2),ev(1,'DO',5,9,10,1,{to:'B'}),ev(2,'PARK_SEARCH',6,7,7,.5,{pathId:null,parkingInterrupted:true})],
    [ev(0,'PU',0,0,0,0),ev(1,'DO',0,5,5,1),ev(2,'PU',0,5,7,2),ev(3,'DO',6,8,9,1,{to:'missing'})],
    [ev(0,'TRANSIT',2,3,3,1,{pathId:'missing'}),ev(1,'PU',3,3,4,0),ev(2,'PARK_SEARCH',4,7,7,1.5,{pathId:null})],
    [ev(0,'DO',0,5,7,1),ev(1,'PU',4,9,10,2)],
  ];
  for(const events of variants){
    const run={events,routes:{r:route}},oldPrepared=prepareRun(run,syntheticNetwork),newPrepared=replay.prepareRun(run,syntheticNetwork);
    assert.deepEqual(newPrepared.byVehicle,oldPrepared.byVehicle);
    for(const t of [30,0,-1,5,5-1e-7,7,4,3,8,2,20,6,9,5+1e-8,5-1e-8,10,21,7-2e-7])compareStates(oldPrepared,newPrepared,t,2,'synthetic');
    report.syntheticCases++;
  }
});

test('standalone sampleRoute revalidates mutated caller input',()=>{
  const route={coordinates:[[127,36],[127.01,36.01],[127.02,36.02]],fractions:[0,.5,1],distanceFractions:[0,.5,1]};
  assert.deepEqual(replay.sampleRoute(route,.75),sampleRoute(route,.75));
  route.fractions[1]=2;assert.equal(replay.sampleRoute(route,.75),null);
  route.fractions[1]=.25;route.coordinates[1][0]=127.015;
  assert.deepEqual(replay.sampleRoute(route,.5),sampleRoute(route,.5));
  route.fractions=null;assert.equal(replay.sampleRoute(route,.5),null);
});

test('prepared objects from separate module instances or V6 remain correct through the uncached fallback',async()=>{
  const other=await import('../replay-core.js?v7-cross-module-test');
  const run=read('data/runs/2023-11-06_integrated_S0.json');
  const original=prepareRun(run,network),foreign=other.prepareRun(run,network);
  for(const time of [30,900,42.51372441,150,989,30.3,250.876,78.2]){
    compareStates(original,foreign,time,2,'foreign prepared instance');
    compareStates(original,original,time,3,'V6 prepared instance');
  }
});

test('representative seek benchmark records elapsed CPU time without imposing a machine-specific pass threshold',()=>{
  const run=read('data/runs/2023-11-06_integrated_S0.json');
  const oldPrepared=prepareRun(run,network),newPrepared=replay.prepareRun(run,network),times=Array.from({length:12000},()=>30+random()*960);
  for(let i=0;i<500;i++){stateAt(oldPrepared,times[i]);replay.stateAt(newPrepared,times[i]);}
  const elapsed=(fn,prepared)=>{const begin=performance.now();let checksum=0;for(const t of times)checksum+=fn(prepared,t)[0].distanceKm;return {milliseconds:performance.now()-begin,checksum};};
  const original=elapsed(stateAt,oldPrepared),optimized=elapsed(replay.stateAt,newPrepared);
  assert.ok(Math.abs(original.checksum-optimized.checksum)<=1e-8);
  report.benchmark={runId:run.id,seeks:times.length,originalMilliseconds:original.milliseconds,optimizedMilliseconds:optimized.milliseconds,speedup:original.milliseconds/optimized.milliseconds,scope:'pure CPU replay computation; excludes WebGL, tile fetching and browser layout'};
});

after(()=>{
  console.log('V7 replay validation:',JSON.stringify(report));
  if(process.env.METROROOKIES_V7_REPORT)writeFileSync(process.env.METROROOKIES_V7_REPORT,JSON.stringify(report,null,2)+'\n');
});
