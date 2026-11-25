// Deterministic replay. No animation frame mutates research data or accumulates state.
export const VEHICLE_COLORS = ['#52e0c4', '#ffb65b', '#a79bff'];
export const KIND_LABELS = { ACTIVATE:'운행 시작', TRANSIT:'도로 이동', PU:'승객 승차', DO:'승객 하차', LOAD:'최초 물류 적재', RESTOCK:'물류 재적재', DELIVER:'물류 배송', PARCEL:'물류 배송', RETURN:'우체국 복귀', PARK_SEARCH:'가상 주차 탐색' };
export const STATUS_LABELS = { mixed:'여객·물류 운송', passenger:'여객 운송', parcel:'물류 운송', empty:'공차 이동', boarding:'승객 승차', alighting:'승객 하차', loading:'물류 적재', delivery:'물류 배송', parking:'가상 주차 탐색', idle:'대기', return:'우체국 복귀', unknown:'경로 확인 필요', inactive:'미배차 대기' };
export const SCENARIOS = { S0:'거리 최소화', S1:'승객 대기 최소화', S2:'통합비용 최소화' };
const finite = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const clamp = (n,a,b)=>Math.max(a,Math.min(b,n));
// Indices belong to a prepared immutable run. They never accumulate playback
// state, so rewinding and random seeking produce the same research values.
const preparedIndices = new WeakMap();
export function clock(min, seconds=false) {
  if (!finite(min)) return '—';
  const total = Math.round((360+Number(min))*60), h=Math.floor(total/3600), m=Math.floor(total/60)%60, s=total%60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}${seconds?':'+String(s).padStart(2,'0'):''}`;
}
export function bearing(a,b) {
  if (!a || !b) return 0;
  const rad=Math.PI/180, la=a[1]*rad, lb=b[1]*rad, dl=(b[0]-a[0])*rad;
  return (Math.atan2(Math.sin(dl)*Math.cos(lb),Math.cos(la)*Math.sin(lb)-Math.sin(la)*Math.cos(lb)*Math.cos(dl))/rad+360)%360;
}
export function sampleRoute(route, fraction) {
  const cs=route?.coordinates;
  if (!cs?.length) return null;
  if (cs.length===1) return {lon:cs[0][0],lat:cs[0][1],heading:0};
  const fs=route.fractions;
  if(!Array.isArray(fs)||fs.length!==cs.length||fs[0]!==0||fs.at(-1)!==1||fs.some((x,i)=>!Number.isFinite(x)||x<0||x>1||(i>0&&x<fs[i-1])))return null;
  return sampleValidatedRoute(route,fraction);
}
function sampleValidatedRoute(route,fraction) {
  const cs=route.coordinates;
  if(cs.length===1)return {lon:cs[0][0],lat:cs[0][1],heading:0};
  const f=clamp(fraction,0,1),fs=route.fractions;
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
function upperBound(rows,key,value) {
  let lo=0,hi=rows.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(rows[mid][key]<=value)lo=mid+1;else hi=mid;}
  return lo;
}
function lowerBound(rows,key,value) {
  let lo=0,hi=rows.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(rows[mid][key]<value)lo=mid+1;else hi=mid;}
  return lo;
}
function compileRoutes(routes) {
  const result=new Map();
  for(const [id,route] of Object.entries(routes||{})){
    if(!sampleRoute(route,1)){result.set(id,null);continue;}
    // Private copies make the cached validation independent of caller mutation.
    // A changed input run must be prepared again. Public sampleRoute deliberately
    // validates every call and therefore remains safe for mutable standalone data.
    const copy={coordinates:route.coordinates.map(point=>[...point]),
      fractions:route.fractions?.slice(),distanceFractions:route.distanceFractions?.slice()};
    result.set(id,{route:copy,end:sampleValidatedRoute(copy,1)});
  }
  return result;
}
function samplePrepared(index,run,pathId,fraction) {
  if(!index)return sampleRoute(run.routes[pathId],fraction);
  const compiled=index.routes.get(String(pathId));
  return compiled?(fraction===1?compiled.end:sampleValidatedRoute(compiled.route,fraction)):null;
}
function buildVehicleIndex(events,completed,network,routes) {
  const usable=events.every(e=>Number.isFinite(e.departure)&&Number.isFinite(e.completed));
  let last=null;
  const locations=completed.map(e=>{if(network.nodes[e.to])last=e;return last;});
  let size=1;while(size<events.length)size*=2;
  const maxCompleted=new Float64Array(size*2);maxCompleted.fill(-Infinity);
  for(let i=0;i<events.length;i++)maxCompleted[size+i]=Number.isFinite(events[i].completed)?events[i].completed:-Infinity;
  for(let i=size-1;i>0;i--)maxCompleted[i]=Math.max(maxCompleted[i*2],maxCompleted[i*2+1]);
  // Nonzero distance events retain their original addition order. Canonical
  // schedules mostly have ordered completion points; exceptional overlaps use
  // the original summation below instead of changing distance semantics.
  const distances=events.filter(e=>finite(e.distanceKm)&&Number(e.distanceKm)!==0);
  const ends=distances.map(e=>({end:e.kind==='PARK_SEARCH'?e.completed:Math.min(e.completed,e.time)}));
  const distanceInputsSafe=events.filter(e=>finite(e.distanceKm)).every(e=>{
    if(!Number.isFinite(e.time)||!Number.isFinite(e.departure)||!Number.isFinite(e.completed))return false;
    const route=routes.get(String(e.pathId))?.route,ds=route?.distanceFractions;
    return !ds||ds.length!==route.coordinates.length||(Array.isArray(ds)&&ds.every(Number.isFinite));
  });
  const monotonic=distanceInputsSafe&&distances.every((e,i)=>Number.isFinite(e.time)&&Number.isFinite(e.departure)&&Number.isFinite(e.completed)&&
    ends[i].end>=e.departure&&(e.kind!=='PARK_SEARCH'||e.time>=e.completed)&&(!i||ends[i].end>=ends[i-1].end));
  const prefixDistance=[0],prefixParking=[0];
  for(const e of distances){prefixDistance.push(prefixDistance.at(-1)+Number(e.distanceKm));prefixParking.push(prefixParking.at(-1)+(e.kind==='PARK_SEARCH'?Number(e.distanceKm):0));}
  return {usable,locations,size,maxCompleted,distances,ends,monotonic,prefixDistance,prefixParking};
}
function currentEvent(events,index,limit) {
  const end=upperBound(events,'departure',limit);
  // The last sorted active interval is exactly the original scan's winner,
  // including overlapping events and ties at a departure/completion boundary.
  function rightmost(node,left,right){
    if(left>=end||index.maxCompleted[node]<=limit)return -1;
    if(right-left===1)return left;
    const mid=(left+right)>>>1;
    const found=rightmost(node*2+1,mid,right);
    return found>=0?found:rightmost(node*2,left,mid);
  }
  const found=rightmost(1,0,index.size);
  return found>=0?events[found]:null;
}
function distanceFraction(e,time,run,index) {
  if(time>=e.completed)return 1;
  if(e.kind==='PARK_SEARCH'&&time>e.departure)return clamp((time-e.departure)/Math.max(.0001,e.completed-e.departure),0,1);
  if(time>=e.time)return 1;
  if(time>e.departure){const temporal=clamp((time-e.departure)/Math.max(.0001,e.time-e.departure),0,1);return samplePrepared(index,run,e.pathId,temporal)?.distanceFraction??temporal;}
  return 0;
}
function distancesAt(events,vehicleIndex,time,run,index) {
  let distanceKm=0,parkingKm=0;
  if(vehicleIndex?.monotonic&&Number.isFinite(time)){
    const from=upperBound(vehicleIndex.ends,'end',time),to=lowerBound(vehicleIndex.distances,'departure',time);
    distanceKm=vehicleIndex.prefixDistance[from];parkingKm=vehicleIndex.prefixParking[from];
    for(let i=from;i<to;i++){const e=vehicleIndex.distances[i],fraction=distanceFraction(e,time,run,index);distanceKm+=e.distanceKm*fraction;if(e.kind==='PARK_SEARCH')parkingKm+=e.distanceKm*fraction;}
  }else{
    for(const e of events){if(!finite(e.distanceKm))continue;const fraction=distanceFraction(e,time,run,index);distanceKm+=e.distanceKm*fraction;if(e.kind==='PARK_SEARCH')parkingKm+=e.distanceKm*fraction;}
  }
  return {distanceKm,parkingKm};
}
export function prepareRun(run,network) {
  const byVehicle={},indices={routes:compileRoutes(run.routes),byVehicle:{}};
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
    indices.byVehicle[id]=buildVehicleIndex(events,completed,network,indices.routes);
  }
  const prepared={run,network,byVehicle};
  preparedIndices.set(prepared,indices);
  return prepared;
}
export function stateAt(prepared,time,selected=1) {
  const {run,network,byVehicle}=prepared;
  const index=preparedIndices.get(prepared);
  return [1,2,3].map(id=>{
    const {events,completed}=byVehicle[id];
    const vehicleIndex=index?.byVehicle[id],limit=time+1e-7;
    let last=null,p=0,c=0,current=null,lastLocation=null;
    if(vehicleIndex?.usable&&Number.isFinite(time)){
      const completedIndex=upperBound(completed,'completed',limit)-1;
      last=completed[completedIndex]||null;p=last?.afterPassengers??0;c=last?.afterCargo??0;
      lastLocation=vehicleIndex.locations[completedIndex]||null;
      current=currentEvent(events,vehicleIndex,limit);
    }else{
      for(const e of completed){if(e.completed>limit)break;last=e;p=e.afterPassengers;c=e.afterCargo;}
      for(const e of events){if(e.departure>limit)break;if(e.completed>limit)current=e;}
      lastLocation=[...completed].reverse().find(e=>e.completed<=limit&&network.nodes[e.to]);
    }
    const depot=network.nodes[network.depot||'DEPOT'];
    let pos=lastLocation?network.nodes[lastLocation.to]:depot;
    let route=current?.pathId?run.routes[current.pathId]:null;
    let status=last?'idle':'inactive',progress=0,animation=null,quality='mapped_service_node',heading=0;
    const previousPath=lastLocation?.pathId?run.routes[lastLocation.pathId]:null;
    if(previousPath) heading=samplePrepared(index,run,lastLocation.pathId,1)?.heading||0;
    if(current){
      if(current.kind==='PARK_SEARCH') {
        pos=network.nodes[current.from]||network.nodes[current.to]||pos;status='parking';quality='virtual_stationary';
        progress=clamp((time-current.departure)/Math.max(.0001,current.completed-current.departure),0,1);
      } else if(time<current.time-1e-7) {
        progress=clamp((time-current.departure)/Math.max(.0001,current.time-current.departure),0,1);
        const sample=route?samplePrepared(index,run,current.pathId,progress):null;
        if(sample){pos=sample;heading=sample.heading;status=current.kind==='RETURN'?'return':p>0&&c>0?'mixed':p>0?'passenger':c>0?'parcel':'empty';quality='network_interpolation';}
        else{pos=network.nodes[current.from]||pos;status='unknown';quality='unresolved';}
      } else {
        pos=network.nodes[current.to]||pos;
        if(route)heading=samplePrepared(index,run,current.pathId,1)?.heading||heading;
        progress=clamp((time-current.time)/Math.max(.0001,current.completed-current.time),0,1);
        const kind={PU:'boarding',DO:'alighting',LOAD:'loading',RESTOCK:'loading',DELIVER:'delivery',PARCEL:'delivery'}[current.kind];
        status=kind||'idle';
        if(kind)animation={kind,progress,quantity:current.quantity||1,requestId:current.requestId};
      }
    }
    const {distanceKm,parkingKm}=distancesAt(events,vehicleIndex,time,run,index);
    return {id,lon:pos?.lon,lat:pos?.lat,heading,status,passengers:p,cargo:c,event:current||last,progress,selected:id===selected,route:route?.coordinates||[],animation,geometryQuality:quality,distanceKm,parkingKm};
  });
}
export function aggregateAt(run,time){
  const people=run.passengers||[],parcels=run.parcels||[];
  return {waiting:people.filter(p=>finite(p.call)&&p.call<=time&&(!finite(p.pickup)||p.pickup>time)).length,served:(run.events||[]).filter(e=>e.kind==='DO'&&finite(e.completed)&&e.completed<=time).length,delivered:parcels.filter(p=>finite(p.delivered)&&p.delivered<=time).length};
}
