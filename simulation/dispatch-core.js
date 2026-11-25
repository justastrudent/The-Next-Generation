/** Deterministic, time-gated view of the original team's committed plan logs.
 * No optimisation is performed by this display module. Future calls never enter
 * the received-call list; future plan stops are those actually committed then.
 */
const EPS = 1e-7;
const DISPLAY_LEGS = 12;
const KIND_NAMES = {PU:'승차',DO:'하차',LOAD:'우체국 적재',RESTOCK:'우체국 재적재',DELIVER:'물류 하차',TRANSIT:'다음 도로 노드',RETURN:'복귀'};

export function nodeLabel(network,id){
  return network?.nodes?.[id]?.label || id || '위치 미기록';
}

function lowerAfter(rows,time){
  let lo=0,hi=rows.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(rows[mid].time<=time+EPS)lo=mid+1;else hi=mid;}
  return lo;
}

function signature(stops,time){
  return JSON.stringify((stops||[]).filter(s=>s.kind!=='TRANSIT'&&s.completed>time+EPS)
    .map(s=>[s.kind,s.nodeId,s.requestId||'',s.hubId||'',s.quantity||0,s.manifest||[]]));
}

/** Raw JSON is immutable. Cached geometry contains only network reconstruction. */
export function prepareDispatch(data,run,network){
  const available=!!(data&&data.runId===run?.id&&Array.isArray(data.snapshots)&&data.validation?.passed);
  const snapshots=available?data.snapshots:[];
  const passengers=new Map((run?.passengers||[]).map(p=>[String(p.id),p]));
  const calls=available?data.calls||[]:[];
  const callMap=new Map(calls.map(c=>[String(c.requestId),c]));
  const changes=snapshots.map((s,i)=>{
    const previous=snapshots[i-1];
    const changed={};
    for(const id of Object.keys(s.vehicles||{})){
      changed[id]=signature(previous?.vehicles?.[id]?.stops,s.time)!==signature(s.vehicles[id].stops,s.time);
    }
    return changed;
  });
  return {available,data,run,network,snapshots,passengers,calls,callMap,changes,pathCache:new Map(),viewCache:new Map()};
}

function routeGeometry(prepared,key){
  if(prepared.pathCache.has(key))return prepared.pathCache.get(key);
  const path=prepared.data.paths?.[key];
  if(!path)return null;
  const coordinates=[],fractions=[];let elapsed=0;
  for(const ref of path.edges||[]){
    const road=prepared.network?.roads?.[Math.abs(ref)-1];
    if(!road?.coordinates)return null;
    const points=ref>0?road.coordinates:[...road.coordinates].reverse();
    if(!points.length)continue;
    const lengths=[0];let length=0;
    for(let i=1;i<points.length;i++){
      const lat=(points[i][1]+points[i-1][1])*Math.PI/360;
      length+=Math.hypot((points[i][0]-points[i-1][0])*Math.cos(lat),points[i][1]-points[i-1][1]);
      lengths.push(length);
    }
    const times=lengths.map((distance,i)=>(elapsed+road.minutes*(length?distance/length:i/Math.max(1,points.length-1)))/(path.minutes||1));
    if(coordinates.length){
      const last=coordinates.at(-1),first=points[0];
      // A broken path is shown as missing; never add a straight shortcut.
      if(Math.abs(last[0]-first[0])>3e-6||Math.abs(last[1]-first[1])>3e-6)return null;
      coordinates.push(...points.slice(1));
      fractions.push(...times.slice(1));
    }else {coordinates.push(...points);fractions.push(...times);}
    elapsed+=road.minutes;
  }
  if(!coordinates.length){
    const point=prepared.network?.nodes?.[path.from];
    if(point){coordinates.push([point.lon,point.lat]);fractions.push(0);}
  }
  const result={from:path.from,to:path.to,coordinates,fractions,minutes:path.minutes,km:path.km,source:'network_reconstruction'};
  prepared.pathCache.set(key,result);
  return result;
}

function remainingSegment(segment,stop,time){
  if(!segment||time<=stop.departure+EPS)return segment;
  const points=segment.coordinates;
  if(time>=stop.time-EPS)return {...segment,coordinates:points.length?[points.at(-1)]:[],remaining:true};
  const fraction=Math.max(0,Math.min(1,(time-stop.departure)/(stop.time-stop.departure)));
  const fractions=segment.fractions;
  let i=1;while(i<fractions.length&&fractions[i]<fraction)i++;
  if(i>=points.length)return {...segment,coordinates:points.length?[points.at(-1)]:[],remaining:true};
  const amount=(fraction-fractions[i-1])/(fractions[i]-fractions[i-1]||1);
  const a=points[i-1],b=points[i],position=[a[0]+(b[0]-a[0])*amount,a[1]+(b[1]-a[1])*amount];
  return {...segment,coordinates:[position,...points.slice(i)],remaining:true};
}

function expandPlan(prepared,snapshot,vehicle,time){
  const raw=snapshot?.vehicles?.[String(vehicle)];
  if(!raw)return {stops:[],route:[],segments:[],issuedAt:null,source:'unavailable'};
  const stops=raw.stops.filter(s=>s.completed>time+EPS).map(s=>{
    const node=prepared.network?.nodes?.[s.nodeId];
    return {...s,name:nodeLabel(prepared.network,s.nodeId),lon:node?.lon,lat:node?.lat,
      label:KIND_NAMES[s.kind]||s.kind,etaSource:s.locked?'recorded_active_leg':'validated_plan_recalculation'};
  });
  const displayed=stops.slice(0,DISPLAY_LEGS);
  const segments=displayed.map(s=>remainingSegment(routeGeometry(prepared,s.path),s,time)).filter(s=>s?.coordinates?.length>1);
  // `route` is deliberately omitted across disconnected segments. Consumers can
  // draw each segment individually; no GeoJSON storage-order concatenation.
  const route=[];
  for(const segment of segments){
    if(route.length){
      const p=route.at(-1),q=segment.coordinates[0];
      if(Math.abs(p[0]-q[0])>3e-6||Math.abs(p[1]-q[1])>3e-6)break;
      route.push(...segment.coordinates.slice(1));
    }else route.push(...segment.coordinates);
  }
  return {stops,route,segments,issuedAt:snapshot.time,nodeId:raw.nodeId,onboard:raw.onboard,cargo:raw.cargo,
    source:'recorded_plan',geometrySource:'network_reconstruction',displayedStopLimit:DISPLAY_LEGS,
    routeTruncated:stops.length>DISPLAY_LEGS,scope:'계획된 앞쪽 12개 작업의 도로 경로'};
}

function impacts(prepared,before,after,now,selected){
  const prior=new Map(),current=new Map(),oldHubs=new Map(),newHubs=new Map();
  function collect(snapshot,pickups,hubs){
    for(const [vid,v] of Object.entries(snapshot?.vehicles||{})){
      for(const s of v.stops){
        if(s.completed<=now+EPS)continue;
        if(s.kind==='PU'&&s.requestId)pickups.set(s.requestId,{...s,vehicle:Number(vid)});
        if(s.kind==='DELIVER'){
          const previous=hubs.get(s.hubId);
          if(!previous||s.time<previous.time)hubs.set(s.hubId,{...s,vehicle:Number(vid)});
        }
      }
    }
  }
  collect(before,prior,oldHubs);collect(after,current,newHubs);
  const waitImpacts=[];
  for(const [rid,b] of prior){
    const a=current.get(rid),p=prepared.passengers.get(rid);
    if(!a||!p||(a.vehicle!==Number(selected)&&b.vehicle!==Number(selected)))continue;
    if(Math.abs(a.time-b.time)<=EPS)continue;
    waitImpacts.push({requestId:rid,beforeWaitMin:b.time-p.call,afterWaitMin:a.time-p.call,
      beforeTime:b.time,afterTime:a.time,deltaMin:a.time-b.time,vehicle:a.vehicle,
      source:'validated_plan_recalculation',attribution:'계획 변경 전후의 예상 차이; 물류의 인과효과는 아님'});
  }
  const logisticsImpacts=[];
  for(const [hub,b] of oldHubs){
    const a=newHubs.get(hub);
    if(!a||(a.vehicle!==Number(selected)&&b.vehicle!==Number(selected)))continue;
    if(Math.abs(a.time-b.time)<=EPS&&a.vehicle===b.vehicle)continue;
    logisticsImpacts.push({hubId:hub,name:nodeLabel(prepared.network,hub),beforeTime:b.time,afterTime:a.time,
      deltaMin:a.time-b.time,beforeVehicle:b.vehicle,afterVehicle:a.vehicle,quantity:a.quantity,
      source:'validated_plan_recalculation',metric:'해당 하차지의 다음 계획 방문 ETA'});
  }
  waitImpacts.sort((a,b)=>Math.abs(b.deltaMin)-Math.abs(a.deltaMin));
  logisticsImpacts.sort((a,b)=>Math.abs(b.deltaMin)-Math.abs(a.deltaMin));
  return {waitImpacts,logisticsImpacts};
}

function explain(snapshot,changed,calls,scenario){
  if(snapshot.trigger==='INTEGRATION_START')return '08:30 사전 확정 물류 수요를 공개하고 차량별 적재·배송 작업을 기존 여객 계획에 구성했습니다.';
  if(snapshot.trigger==='CALL'){
    if(changed)return `새로운 여객 호출을 수신해 승차·하차 삽입 위치를 평가하고 ${scenario} 목적함수에 따라 기록된 계획을 갱신했습니다.`;
    return '새로운 여객 호출을 수신했습니다. 선택한 차량의 남은 서비스 순서는 유지됐습니다. 배정 결과는 차량별로 확인할 수 있습니다.';
  }
  if(snapshot.trigger==='STATE_CHANGE')return changed?'승하차·적재·하차 후 남은 여객·물류 계획을 재평가했습니다.':'서비스 완료 후 계획을 재평가했습니다. 선택 차량의 남은 서비스 순서는 유지됐습니다.';
  return '운영 경계 시각의 차량 상태와 확정 계획입니다.';
}

function decisionView(prepared,index,vehicle){
  const key=`${index}/${vehicle}`;
  if(prepared.viewCache.has(key))return prepared.viewCache.get(key);
  const snapshot=prepared.snapshots[index],previous=prepared.snapshots[index-1];
  const calls=prepared.calls.filter(c=>Math.abs(c.time-snapshot.time)<EPS);
  const assignment=calls.find(c=>c.vehicle===Number(vehicle))||calls.at(-1)||null;
  const changed=prepared.changes[index]?.[String(vehicle)]||false;
  const before=expandPlan(prepared,previous,vehicle,snapshot.time);
  const after=expandPlan(prepared,snapshot,vehicle,snapshot.time);
  const effects=impacts(prepared,previous,snapshot,snapshot.time,vehicle);
  const result={id:`${snapshot.id}/${vehicle}`,snapshotId:snapshot.id,time:snapshot.time,vehicle:Number(vehicle),
    trigger:snapshot.trigger,requestIds:calls.map(c=>c.requestId),before,after,changed,
    assignment,candidatesTested:assignment?.candidatesTested??null,promisedWaitMin:assignment?.promisedWaitMin??null,
    score:assignment?.score||snapshot.search?.finalScore||null,search:snapshot.search||null,
    candidates:[],candidateDetailsAvailable:false,optimizerSeconds:snapshot.optimizerSeconds,
    reason:explain(snapshot,changed,calls,prepared.run.scenario),source:'recorded_plan',
    provenance:prepared.data.provenance,...effects};
  prepared.viewCache.set(key,result);
  if(prepared.viewCache.size>60)prepared.viewCache.delete(prepared.viewCache.keys().next().value);
  return result;
}

export function dispatchAt(prepared,time,selectedVehicle=1){
  const vehicle=Number(selectedVehicle);
  const base={available:prepared?.available||false,time,vehicle,latestDecision:null,currentPlan:{stops:[],route:[],segments:[]},
    receivedCalls:[],recentCalls:[],waitingCalls:[],waitImpacts:[],logisticsImpacts:[],decisionHistory:[],
    objective:prepared?.data?.objective||null,methodology:prepared?.data?.methodology||null,
    provenance:prepared?.data?.provenance||null};
  if(!base.available)return base;
  const index=lowerAfter(prepared.snapshots,time)-1;
  if(index<0)return base;
  const snapshot=prepared.snapshots[index];
  const latestDecision=decisionView(prepared,index,vehicle);
  const pickupPlans=new Map();
  for(const [vid,v] of Object.entries(snapshot.vehicles))for(const s of v.stops){
    if(s.kind==='PU'&&s.completed>time+EPS)pickupPlans.set(s.requestId,{time:s.time,vehicle:Number(vid)});
  }
  const receivedCalls=prepared.calls.filter(c=>c.time<=time+EPS).map(c=>{
    const p=prepared.passengers.get(c.requestId),plan=pickupPlans.get(c.requestId);
    const picked=Number.isFinite(p?.pickup)&&p.pickup<=time+EPS;
    const dropped=Number.isFinite(p?.dropoff)&&p.dropoff<=time+EPS;
    const row={id:c.requestId,requestId:c.requestId,call:c.time,people:p?.people||1,
      pickupNode:p?.pickupNode,dropoffNode:p?.dropoffNode,assignedVehicle:c.vehicle,vehicle:c.vehicle,
      accepted:c.accepted,promisedWaitMin:c.promisedWaitMin,promisedPickup:c.promisedPickup,
      plannedPickup:plan?.time??null,plannedWaitMin:plan?plan.time-c.time:null,
      elapsedWaitMin:picked?p.pickup-c.time:Math.max(0,time-c.time),
      status:!c.accepted?'rejected':dropped?'completed':picked?'onboard':'waiting',source:'recorded_call_and_assignment'};
    // Outcome data becomes available only after the relevant service arrival.
    if(picked){row.pickup=p.pickup;row.wait=p.pickup-c.time;row.actualWaitMin=row.wait;}
    if(dropped)row.dropoff=p.dropoff;
    return row;
  });
  const decisionHistory=[];
  for(let i=index;i>=0&&decisionHistory.length<12;i--){
    const s=prepared.snapshots[i];
    const changed=prepared.changes[i]?.[String(vehicle)]||false;
    if(changed||s.trigger==='CALL'||s.trigger==='INTEGRATION_START'){
      decisionHistory.push({id:`${s.id}/${vehicle}`,time:s.time,vehicle,trigger:s.trigger,changed,
        requestIds:prepared.calls.filter(c=>Math.abs(c.time-s.time)<EPS).map(c=>c.requestId)});
    }
  }
  return {...base,latestDecision,currentPlan:expandPlan(prepared,snapshot,vehicle,time),receivedCalls,
    recentCalls:[...receivedCalls].reverse().slice(0,12),waitingCalls:receivedCalls.filter(c=>c.status==='waiting'),
    waitImpacts:latestDecision.waitImpacts,logisticsImpacts:latestDecision.logisticsImpacts,decisionHistory,
    receivedCount:receivedCalls.length,planIssuedAt:snapshot.time,
    knownFreight:prepared.run.mode==='integrated'?{released:time>=150,releaseTime:150,total:prepared.run.parcels?.length||0}:null};
}

/** Timeline navigation is replay navigation, not advance knowledge for planning. */
export function nextDispatchTime(prepared,time,selectedVehicle=1,direction=1){
  if(!prepared?.available)return null;
  const relevant=prepared.snapshots.filter((s,i)=>s.trigger==='CALL'||s.trigger==='INTEGRATION_START'||prepared.changes[i]?.[String(selectedVehicle)]);
  if(direction<0){for(let i=relevant.length-1;i>=0;i--)if(relevant[i].time<time-EPS)return relevant[i].time;}
  else for(const s of relevant)if(s.time>time+EPS)return s.time;
  return null;
}
