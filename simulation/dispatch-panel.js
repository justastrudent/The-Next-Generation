/**
 * Read-only view of dispatch replay. The UI never plans a trip and never mutates
 * canonical run events. Decisions and source-dependent ETAs come from dispatch-core.
 */
import { clock, stateAt, STATUS_LABELS, KIND_LABELS, SCENARIOS, VEHICLE_COLORS } from './replay-core.js?v=20261125-v7';
import { prepareDispatch, dispatchAt, nextDispatchTime, nodeLabel } from './dispatch-core.js';

const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const numeric = value => finite(value) ? Number(value) : null;
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const text = escapeHTML;
const format = (value, digits = 1) => finite(value) ? Number(value).toLocaleString('ko-KR', {maximumFractionDigits:digits, minimumFractionDigits:digits}) : '—';
const number = value => finite(value) ? Number(value).toLocaleString('ko-KR', {maximumFractionDigits:0}) : '—';
const signed = value => finite(value) ? `${Number(value)>0?'+':''}${format(value)}` : '—';
const logistics = kind => ['LOAD','RESTOCK','DELIVER','PARCEL','RETURN'].includes(String(kind).toUpperCase());
const sourceTag = (label, source = 'recorded') => `<span class="dp-tag" data-source="${source}">${text(label)}</span>`;
const stopLabel = stop => KIND_LABELS[stop?.kind] || ({pickup:'승객 승차',dropoff:'승객 하차',deliver:'물류 배송',load:'물류 적재'}[stop?.kind]) || stop?.kind || '경유';
const sources = {recorded_plan:'원본 계획 로그',recorded_event:'원본 운행 기록',observed_event:'원본 운행 기록',validated_plan_recalculation:'검증된 재계산',network_reconstruction:'도로망 경로 복원'};
const triggerLabels = {INTEGRATION_START:'물류 수요 공개 · 통합계획 시작',STATE_CHANGE:'서비스 후 재계획',BOUNDARY:'운영 경계 시각',passenger_call:'신규 여객 호출',new_call:'신규 여객 호출',request:'신규 여객 호출',CALL:'신규 여객 호출',replan:'운행계획 갱신',service_complete:'서비스 완료 후 재계획',service_completion:'서비스 완료 후 재계획',parcel_arrival:'물류 수요 공개',PARCEL_ARRIVAL:'물류 수요 공개',optimization:'경로 개선',initial:'초기 운행계획',periodic:'운영계획 점검'};
const roadCache = new WeakMap();
let panelSerial = 0;

export function safeDisplayNumber(value, digits = 1) { return format(value, digits); }

function coordinates(value) {
  return Array.isArray(value) ? value.filter(p => Array.isArray(p) && p.length >= 2 && finite(p[0]) && finite(p[1]) && Math.abs(+p[0]) <= 180 && Math.abs(+p[1]) <= 90).map(p => [+p[0], +p[1]]) : [];
}

/** Preserve gaps. Never join service nodes or separate road segments with a straight line. */
export function planPaths(plan) {
  if (!plan || ['unresolved','unavailable'].includes(plan.geometrySource)) return [];
  const safePath=value=>Array.isArray(value)&&value.length>=2&&coordinates(value).length===value.length?coordinates(value):[];
  if (Array.isArray(plan.segments) && plan.segments.length) {
    return plan.segments.filter(s => !['unresolved','missing','straight_line'].includes(s?.source)).map(s => safePath(s?.coordinates ?? s)).filter(path => path.length > 1);
  }
  const route = plan.route?.coordinates ?? plan.route;
  if (Array.isArray(route) && Array.isArray(route[0]) && typeof route[0][0] === 'number') {
    const path = safePath(route);
    return path.length > 1 ? [path] : [];
  }
  if (Array.isArray(route)) return route.map(part => safePath(part?.coordinates ?? part)).filter(path => path.length > 1);
  return [];
}

function pointFor(stop, network) {
  if (finite(stop?.lon) && finite(stop?.lat)) return [+stop.lon,+stop.lat];
  const node = network?.nodes?.[stop?.nodeId];
  return finite(node?.lon) && finite(node?.lat) ? [+node.lon,+node.lat] : null;
}

function roadsFor(network) {
  if (!network || typeof network !== 'object') return [];
  if (roadCache.has(network)) return roadCache.get(network);
  const roads=(network.roads || []).map(r => {
    const path=coordinates(r.coordinates);
    if(path.length<2)return null;
    const xs=path.map(p=>p[0]),ys=path.map(p=>p[1]);
    return {path,bounds:[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)]};
  }).filter(Boolean);
  roadCache.set(network,roads);return roads;
}

/** The same replay state feeds the 3D bus and this marker. No position is inferred here. */
export function selectedVehicleState(context) {
  if(context?.runLoading)return null;
  if(Array.isArray(context?.states))return context.states.find(s=>String(s.id)===String(context.selected))||null;
  if(context?.prepared)try{return stateAt(context.prepared,context.time,context.selected).find(s=>String(s.id)===String(context.selected))||null;}catch{}
  return null;
}
function vehiclePoint(state) {
  return finite(state?.lon)&&finite(state?.lat)&&Math.abs(+state.lon)<=180&&Math.abs(+state.lat)<=90?[+state.lon,+state.lat]:null;
}
function positionLabel(state) {
  return ({network_interpolation:'도로망 보간',mapped_service_node:'서비스 노드',virtual_stationary:'대기 위치',unresolved:'마지막 확인 위치'})[state?.geometryQuality]||'재생 위치';
}
function vehicleMarker(state,project) {
  const point=vehiclePoint(state);if(!point)return '';
  const [x,y]=project(point),heading=finite(state.heading)?((+state.heading%360)+360)%360:null;
  const color=VEHICLE_COLORS[Number(state.id)-1]||'#62e4c7',unresolved=state.geometryQuality==='unresolved';
  const label=`DRT ${state.id} · ${unresolved?'기준 위치':'현재 위치'}`,left=x>340?-12:12;
  return `<g class="dp-vehicle-marker" data-vehicle-id="${text(state.id)}" data-lon="${point[0]}" data-lat="${point[1]}" data-heading="${heading===null?'':heading}" data-position-source="${text(state.geometryQuality||'replay_state')}" transform="translate(${x.toFixed(2)} ${y.toFixed(2)})"><title>${text(label)} · ${text(positionLabel(state))}${heading===null?'':` · 진행 방향 ${format(heading,0)}°`}</title><circle r="10.5" fill="${color}" opacity=".17"/><circle r="6.5" fill="#0a1b28" stroke="#ffffff" stroke-width="1.3" ${unresolved?'stroke-dasharray="3 3"':''}/>${heading!==null&&!unresolved?`<g class="dp-vehicle-heading" transform="rotate(${heading.toFixed(2)})"><path d="M0 -5L3.75 4L0 2L-3.75 4Z" fill="${color}" stroke="#0b1d2b" stroke-width="1"/></g>`:`<circle r="2.25" fill="${color}"/>`}<text class="dp-vehicle-caption" x="${left}" y="3" text-anchor="${left<0?'end':'start'}">DRT ${text(state.id)}</text></g>`;
}

/** SVG is a metric local projection of supplied road geometry, never a fictional route. */
function routeMapModel(before, after, network, visibility, vehicle, height=260) {
  const bottom=height-29,centerY=height/2-2;
  const beforePaths=planPaths(before),afterPaths=planPaths(after);
  const paths=[...beforePaths,...afterPaths];
  const position=vehiclePoint(vehicle);
  if(!paths.length&&!position)return null;
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  for(const path of paths)for(const p of path){minX=Math.min(minX,p[0]);maxX=Math.max(maxX,p[0]);minY=Math.min(minY,p[1]);maxY=Math.max(maxY,p[1]);}
  // Include the current bus even when its latest plan snapshot lies elsewhere.
  if(position){minX=Math.min(minX,position[0]);maxX=Math.max(maxX,position[0]);minY=Math.min(minY,position[1]);maxY=Math.max(maxY,position[1]);}
  if(!Number.isFinite(minX))return null;
  const latitude=(minY+maxY)/2,cos=Math.max(.2,Math.cos(latitude*Math.PI/180));
  const minimumSpan=paths.length ? .00065 : .005;
  const spanX=Math.max(minimumSpan,(maxX-minX)*cos),spanY=Math.max(minimumSpan,maxY-minY);
  const scale=Math.min(352/(spanX*1.16),(height-104)/(spanY*1.16));
  const cx=(minX+maxX)/2,cy=(minY+maxY)/2;
  const project=p=>[240+(p[0]-cx)*cos*scale,centerY-(p[1]-cy)*scale];
  const pathString=path=>{
    let last=null,result='';
    for(let i=0;i<path.length;i++){
      const p=project(path[i]);
      if(last&&i<path.length-1&&Math.hypot(p[0]-last[0],p[1]-last[1])<1.1)continue;
      result+=`${result?'L':'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`;last=p;
    }
    return result;
  };
  const padX=238/(cos*scale),padY=(height/2-22)/scale;
  const viewBounds=[cx-padX,cy-padY,cx+padX,cy+padY];
  const roads=roadsFor(network).filter(r => r.bounds[2]>=viewBounds[0]&&r.bounds[0]<=viewBounds[2]&&r.bounds[3]>=viewBounds[1]&&r.bounds[1]<=viewBounds[3]);
  const basePath=roads.slice(0,3600).map(r=>pathString(r.path)).join('');
  const previous=beforePaths.map(pathString).join(''),current=afterPaths.map(pathString).join('');
  const seen=new Set();
  const stops=(after?.stops||[]).filter(stop=>stop.kind!=='TRANSIT').slice(0,6).map((stop,index)=>{
    const p=pointFor(stop,network);if(!p)return '';
    const key=p.map(x=>x.toFixed(6)).join(',');if(seen.has(key))return '';seen.add(key);
    const [x,y]=project(p);if(x<10||x>470||y<25||y>bottom-9)return '';
    const color=logistics(stop.kind)?'#ffba67':'#69e6ca';
    const shape=logistics(stop.kind)?`<rect x="${(x-7).toFixed(1)}" y="${(y-7).toFixed(1)}" width="14" height="14" rx="2" fill="${color}" stroke="#0b1a27" stroke-width="2"/>`:`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7.5" fill="${color}" stroke="#0b1a27" stroke-width="2"/>`;
    return `<g><title>${text(index+1)}. ${text(stopLabel(stop))} · ${text(stop.name||stop.nodeId||'')}</title>${shape}<text x="${x.toFixed(1)}" y="${(y+3.3).toFixed(1)}" text-anchor="middle" style="fill:#10262a;font-weight:700;font-size:10px">${index+1}</text></g>`;
  }).join('');
  const targetMeters=85/scale*111320,base=10**Math.floor(Math.log10(targetMeters));
  const meters=[1,2,5,10].map(x=>x*base).filter(x=>x<=targetMeters).at(-1)||base;
  const pixels=meters/111320*scale,scaleLabel=meters>=1000?`${format(meters/1000,meters%1000?1:0)} km`:`${number(meters)} m`;
  const prefix=`<svg class="dp-route" viewBox="0 0 480 ${height}" role="img" aria-label="현재 DRT 위치·진행 방향과 계획 변경 전후 경로"><defs><clipPath id="dp-route-clip"><rect x="0" y="27" width="480" height="${height-56}"/></clipPath></defs><path d="${Array.from({length:Math.floor((bottom-27)/60)},(_,i)=>`M0 ${60*(i+1)}H480`).join('')}${[80,160,240,320,400].map(x=>`M${x} 27V${bottom}`).join('')}" stroke="#19313e" stroke-width=".5"/><text class="dp-map-title" x="12" y="18">강내면 · 현재 위치와 경로</text><g clip-path="url(#dp-route-clip)"><path d="${basePath}" stroke="#52788d" stroke-width=".8" opacity=".66"/>${visibility.before&&previous?`<path class="dp-map-before" d="${previous}" stroke="#d2dce6" stroke-width="2.6" stroke-dasharray="6 5" opacity=".9"/>`:''}${visibility.after&&current?`<path d="${current}" stroke="#092f2a" stroke-width="7" opacity=".9"/><path class="dp-map-after" d="${current}" stroke="#62e4c7" stroke-width="3.3"/>${stops}`:''}</g><path d="M454 44V29M450 34L454 28L458 34" stroke="#c4d9e6" stroke-width="1.5"/><text x="454" y="19" text-anchor="middle">N</text><path d="M16 ${height-16}v-4m0 3h${pixels.toFixed(1)}m0 1v-4" stroke="#a5c0d0" stroke-width="1"/><text class="dp-map-legend" x="16" y="${height-4}">${text(scaleLabel)}</text><text class="dp-map-legend" x="468" y="${height-4}" text-anchor="end">경로 · 도로망 복원</text><g data-dp-live-position="">`;
  const suffix='</g></svg>';
  const contains=state=>{const p=vehiclePoint(state);if(!p)return false;const[x,y]=project(p);return x>=42&&x<=438&&y>=49&&y<=height-49;};
  return {project,contains,prefix,suffix,render:state=>prefix+vehicleMarker(state,project)+suffix};
}

export function buildRouteSVG(before,after,network,visibility={before:true,after:true},vehicle=null) {
  return routeMapModel(before,after,network,visibility,vehicle)?.render(vehicle)||'';
}

function fallbackView(context) {
  const {run,time,selected}=context;
  const received=(context.runLoading?[]:run?.passengers||[]).filter(p=>finite(p.call)&&+p.call<=time+1e-8).map(p=>({
    id:p.id,call:+p.call,people:p.people,pickupNode:p.pickupNode,dropoffNode:p.dropoffNode,
    assignedVehicle:finite(p.pickup)&&p.pickup<=time?p.vehicle:null,
    pickup:finite(p.pickup)&&p.pickup<=time?p.pickup:null,
    wait:finite(p.pickup)&&p.pickup<=time?p.wait:null,
    status:finite(p.dropoff)&&p.dropoff<=time?'completed':finite(p.pickup)&&p.pickup<=time?'onboard':'waiting'
  }));
  return {available:false,time,vehicle:selected,latestDecision:null,currentPlan:null,receivedCalls:received,recentCalls:[...received].sort((a,b)=>b.call-a.call).slice(0,3),waitingCalls:received.filter(p=>p.pickup===null),waitImpacts:[],logisticsImpacts:[],decisionHistory:[],objective:run?.scenario,provenance:'recorded_event'};
}

function findLabel(network,id) {
  if(!id)return '위치 기록 없음';
  return nodeLabel(network,id)||network?.nodes?.[id]?.label||String(id);
}
function planFirst(plan,network) {
  const stop=plan?.stops?.find(stop=>stop.kind!=='TRANSIT')??plan?.stops?.[0];
  return stop ? `${stopLabel(stop)} · ${stop.name||findLabel(network,stop.nodeId)}` : '예정 작업 없음';
}
function requestId(call) { return call?.id ?? call?.requestId ?? ''; }
function callTime(call) { return numeric(call?.call ?? call?.time); }
function renderStop(stop,index,network) {
  const stamp=stop.time??stop.eta??stop.arrival;
  const source=stop.etaSource??stop.source;
  const canShow=finite(stamp)&&source!=='unavailable'&&source!=='unvalidated';
  const timeLabel=source==='recorded_plan'?'계획 시각':source==='recorded_event'||source==='recorded_active_leg'?'운행기록 ETA':'재계산 ETA';
  const name=stop.name||findLabel(network,stop.nodeId);
  const details=[stopLabel(stop),stop.requestId?`호출 ${stop.requestId}`:stop.hubId?String(stop.hubId):'',finite(stop.quantity)&&+stop.quantity>0?`${number(stop.quantity)}${logistics(stop.kind)?'개':'명'}`:''].filter(Boolean).join(' · ');
  return `<li class="dp-stop" data-kind="${logistics(stop.kind)?'logistics':'passenger'}"><span class="dp-stop-number">${index+1}</span><span class="dp-stop-text"><b>${text(name)}</b><small>${text(details)}</small></span><time>${canShow?text(clock(stamp)):'—'}<small>${canShow?timeLabel:'ETA 미확인'}</small></time></li>`;
}

export default class DispatchPanel {
  constructor(container,{onSeek,onVehicle,onRouteComparison}={}) {
    if(!container)throw new TypeError('DispatchPanel container is required.');
    this.container=container;this.callbacks={onSeek,onVehicle,onRouteComparison};this.active=false;this.context=null;this.dispatchPrepared=null;this.dataIdentity=null;this.runIdentity=null;this.networkIdentity=null;this.rendered=new Map();this.visibility={before:true,after:true};this.routeSignature='';this.lastRenderedTime=-Infinity;this.lastWallRender=-Infinity;this.view=null;this.serial=++panelSerial;
    this._click=event=>this._handleClick(event);
    this._keydown=event=>{if((event.code==='Space'||event.key==='Enter')&&event.target.closest?.('button,summary,input,select,a,[role=button]'))event.stopPropagation();else if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))event.stopPropagation();};
    this._build();
    if(typeof ResizeObserver!=='undefined'){this.routeObserver=new ResizeObserver(()=>this._resizeRoute());this.routeObserver.observe(this.nodes.route);}
    container.addEventListener('click',this._click);container.addEventListener('keydown',this._keydown);
  }
  _build(){
    this.container.classList.add('dispatch-panel');
    this.container.innerHTML=`<div class="dp-shell">
      <header class="dp-header">
        <div class="dp-heading-line"><h2>DRT 경로 및 의사결정</h2><div class="dp-clock"><time data-dp="clock">06:30:00</time><small>시뮬레이션 시각</small></div></div>
        <p class="dp-run-caption" data-dp="run-caption"></p>
        <div class="dp-vehicle-tabs" role="group" aria-label="분석 차량 선택">${[1,2,3].map(id=>`<button type="button" data-dp-vehicle="${id}" aria-pressed="${id===1}" style="--vehicle-color:${VEHICLE_COLORS[id-1]}"><span class="dp-dot"></span>DRT ${id}</button>`).join('')}</div>
      </header>
      <div class="dp-scroll">
        <div class="dp-status-strip"><div data-dp="state"></div><div data-dp="alert" hidden></div></div>
        <section class="dp-card dp-plan-card" aria-labelledby="dp-plan-${this.serial}">
          <div class="dp-card-heading"><h3 id="dp-plan-${this.serial}">현재 위치 · 경로</h3><span data-dp="plan-source"></span></div>
          <div class="dp-map-content" data-dp="route"></div>
          <div class="dp-plan-caption" data-dp="plan-caption"></div>
        </section>
        <div class="dp-analysis-grid">
          <section class="dp-card dp-calls-card" aria-labelledby="dp-calls-${this.serial}">
            <div class="dp-card-heading"><h3 id="dp-calls-${this.serial}">신규 호출</h3><span class="dp-scope">전체 차량</span></div>
            <div class="dp-card-body" data-dp="calls"></div>
          </section>
          <section class="dp-card dp-impact-card" aria-labelledby="dp-impact-${this.serial}">
            <div class="dp-card-heading"><h3 id="dp-impact-${this.serial}">대기 · 배송 영향</h3><span data-dp="impact-source"></span></div>
            <div class="dp-card-body" data-dp="impact-summary"></div>
          </section>
        </div>
        <details class="dp-details">
          <summary>다음 작업 · 판단 근거 <span>상세 보기</span></summary>
          <div class="dp-detail-content"><h3>변경 전후 목적지 · 다음 작업</h3><div data-dp="stops"></div><h3>대기 · 배송 변화의 근거</h3><div data-dp="impacts"></div><details class="dp-algorithm"><summary>알고리즘 · 수치 출처</summary><div data-dp="algorithm"></div></details></div>
        </details>
      </div>
    </div><dialog class="dp-route-dialog" aria-label="현재 위치 · 경로 확대"><div class="dp-route-dialog-header"><strong>현재 위치 · 경로</strong><button type="button" data-dp-action="close-map" autofocus>닫기 ×</button></div><div class="dp-route-dialog-body"></div></dialog>`;
    this.nodes=Object.fromEntries([...this.container.querySelectorAll('[data-dp]')].map(node=>[node.dataset.dp,node]));
    this.routeDialog=this.container.querySelector('.dp-route-dialog');
    this.routeDialog.addEventListener('close',()=>this._restoreRoute());
  }
  _mapHeight(){
    const node=this.nodes.route,svg=node.querySelector?.('svg.dp-route');
    const rect=svg?.getBoundingClientRect?.();
    const w=rect?.width||node.clientWidth,h=rect?.height||Math.max(0,(node.clientHeight||0)-30);
    if(!w||!h)return 260;
    return Math.max(180,Math.min(900,Math.round(480*h/w/8)*8));
  }
  _resizeRoute(){
    if(!this.active||!this.context?.run||this.context.runLoading)return;
    const height=this._mapHeight();
    if(height===this.mapHeight)return;
    this._renderRoute(this.context,this.view?.latestDecision||null);
  }
  _expandRoute(){
    const dialog=this.routeDialog,node=this.nodes.route;
    if(!dialog||dialog.open||!node.querySelector('svg.dp-route'))return;
    const slot=document.createElement('div');slot.className='dp-map-content';slot.setAttribute('aria-hidden','true');
    node.before(slot);this.routeSlot=slot;
    dialog.querySelector('.dp-route-dialog-body').append(node);
    try{dialog.showModal();}catch{this._restoreRoute();return;}
    this._resizeRoute();
  }
  _restoreRoute(){
    if(!this.routeSlot)return;
    this.routeSlot.replaceWith(this.nodes.route);this.routeSlot=null;
    this._resizeRoute();
    if(this.active)this.nodes.route.querySelector('[data-dp-action="expand-map"]')?.focus();
  }
  _closeRoute(){
    if(this.routeDialog?.open)this.routeDialog.close();
    this._restoreRoute();
  }
  setActive(active){
    const changed=this.active!==Boolean(active);this.active=Boolean(active);this.container.hidden=!this.active;
    if(this.active&&changed&&this.context)this.update(this.context,true);
    if(!this.active){this._closeRoute();this.routeSignature='';this.callbacks.onRouteComparison?.(null);}
  }
  update(context,force=false){
    this.context=context;if(!this.active||!context?.run)return;
    this.currentVehicle=selectedVehicleState(context);
    const now=typeof performance!=='undefined'?performance.now():Date.now();
    const contextChanged=this.runIdentity!==context.run||this.dataIdentity!==context.decisionData||this.networkIdentity!==context.network;
    const selectedChanged=this.lastSelected!==context.selected,loadChanged=this.lastLoading!==context.loading||this.lastRunLoading!==context.runLoading||this.lastError!==context.error,backwards=context.time<this.lastRenderedTime-1e-7;
    if(!force&&!contextChanged&&!selectedChanged&&!loadChanged&&!backwards&&now-this.lastWallRender<180){
      this.nodes.clock.textContent=clock(context.time,true);this._renderRoute(context,this.view?.latestDecision||null);return;
    }
    if(contextChanged){
      this.runIdentity=context.run;this.dataIdentity=context.decisionData;this.networkIdentity=context.network;this.routeSignature='';this.mapSignature='';
      try{this.dispatchPrepared=context.decisionData?prepareDispatch(context.decisionData,context.run,context.network):null;this.prepareError=null;}catch(error){this.dispatchPrepared=null;this.prepareError=error?.message||String(error);}
    }
    let view;
    try{view=this.dispatchPrepared?.available&&!context.loading&&!context.runLoading&&!context.error?dispatchAt(this.dispatchPrepared,context.time,context.selected):fallbackView(context);}catch(error){view=fallbackView(context);this.prepareError=error?.message||String(error);}
    this.view=view;this.lastWallRender=now;this.lastRenderedTime=context.time;this.lastSelected=context.selected;this.lastLoading=context.loading;this.lastRunLoading=context.runLoading;this.lastError=context.error;
    this.nodes.clock.textContent=clock(context.time,true);
    this.nodes['run-caption'].textContent=`${context.run.date} · ${context.run.mode==='integrated'?'여객 + 물류 통합':'여객 전용'} · ${context.run.scenario} ${SCENARIOS[context.run.scenario]||''}`;
    for(const button of this.container.querySelectorAll('[data-dp-vehicle]'))button.setAttribute('aria-pressed',String(+button.dataset.dpVehicle===+context.selected));
    this._renderAlert(context,view);
    this._renderState(context);
    this._renderCalls(context,view);
    this._renderPlan(context,view);
    this._renderImpacts(context,view);
    this._renderAlgorithm(context,view);
  }
  _html(name,html){if(this.rendered.get(name)===html)return;this.nodes[name].innerHTML=html;this.rendered.set(name,html);}
  _renderAlert(context,view){
    let message='',tone='info';
    if(context.runLoading)message='운영자료를 불러오고 있습니다.';
    else if(context.loading)message='계획 로그를 불러오고 있습니다.';
    else if(context.error||this.prepareError){message=`의사결정 자료를 읽지 못했습니다. ${context.error||this.prepareError}`;tone='warning';}
    else if(!view.available)message='계획 로그 없음 · 확인되는 호출과 차량 위치만 표시합니다.';
    const node=this.nodes.alert;node.hidden=!message;
    if(message){node.className='dp-alert';node.dataset.tone=tone;node.textContent=message;}
  }
  _renderState(context){
    const state=this.currentVehicle;
    if(context.runLoading){this._html('state','<div class="dp-state"><div class="dp-state-main"><strong>운영자료 전환 중</strong><small>새 운행 기록을 기다리고 있습니다.</small></div></div>');return;}
    const status=STATUS_LABELS[state?.status]||'상태 미확인';
    const nextService=this.view?.currentPlan?.stops?.find(stop=>stop.kind!=='TRANSIT');
    const destination=state?.event?.kind==='TRANSIT'&&nextService?nextService.name||findLabel(context.network,nextService.nodeId):state?.event?.to?findLabel(context.network,state.event.to):context.network?.depot?findLabel(context.network,context.network.depot):'위치 기록 없음';
    const moving=['mixed','passenger','parcel','empty','return'].includes(state?.status);
    this._html('state',`<div class="dp-state"><div class="dp-state-main"><strong><span class="dp-state-dot" style="--vehicle-color:${VEHICLE_COLORS[Number(context.selected)-1]||'#62e4c7'}"></span>DRT ${text(context.selected)} <span>${text(status)}</span></strong><small>${moving?'이동 중 → ':''}${text(destination)}</small></div><div class="dp-load"><span>승객 <b>${number(state?.passengers)}</b><small>/ 11명</small></span><span>물류 <b>${number(state?.cargo)}</b><small>/ 8개</small></span></div></div>`);
  }
  _renderCalls(context,view){
    const received=(view.receivedCalls||[]).filter(call=>callTime(call)!==null&&callTime(call)<=context.time+1e-8);
    const recent=(view.recentCalls||[...received].sort((a,b)=>callTime(b)-callTime(a))).filter(call=>callTime(call)!==null&&callTime(call)<=context.time+1e-8).slice(0,1);
    const waiting=(view.waitingCalls||[]).filter(call=>callTime(call)!==null&&callTime(call)<=context.time+1e-8);
    const rows=recent.map(call=>{
      const id=requestId(call),when=callTime(call),isNew=context.time-when<=1.5;
      const assigned=call.assignedVehicle??call.vehicleId;
      const realisedPickup=call.pickup??call.actualPickup,realisedWait=call.wait??call.actualWait;
      const pickupDone=finite(realisedPickup)&&+realisedPickup<=context.time+1e-8;
      const complete=finite(call.dropoff)&&+call.dropoff<=context.time+1e-8;
      const phase=pickupDone?`${complete?'운송 완료':'승차 완료'} · 실제 대기 ${format(realisedWait)}분`:finite(assigned)?`DRT ${assigned} 배정 · 현재 ${format(Math.max(0,context.time-when))}분 대기`:`접수 · 현재 ${format(Math.max(0,context.time-when))}분 대기`;
      const knownPromise=finite(call.promisedWaitMin)?`<span class="dp-call-promise">약속 대기 <b>${format(call.promisedWaitMin)}분</b></span>`:'';
      return `<li class="dp-call${isNew?' is-new':''}" data-request-id="${text(id)}"><div class="dp-call-top"><time>${text(clock(when,true))}</time><span>${isNew?'<span class="dp-new">수신</span>':''}<span class="dp-call-meta">호출 ${text(id)} · ${number(call.people||1)}명</span></span></div><strong>${text(findLabel(context.network,call.pickupNode))}<span class="dp-call-arrow">→</span>${text(findLabel(context.network,call.dropoffNode))}</strong><div class="dp-call-bottom"><span>${text(phase)}</span>${knownPromise}</div></li>`;
    }).join('');
    let cargo='';
    if(context.run.mode==='integrated')cargo=`<span class="dp-count">물류 <b>${context.time>=150?'08:30 공개':'08:30 예정'}</b></span>`;
    this._html('calls',`<div class="dp-received"><span class="dp-count">접수 <b>${number(received.length)}건</b></span><span class="dp-count">승차 대기 <b>${number(waiting.length)}건</b></span>${cargo}</div>${rows?`<ol class="dp-call-list">${rows}</ol>`:'<div class="dp-empty">접수된 여객 호출이 없습니다.</div>'}`);
  }
  _renderPlan(context,view){
    const decision=view.latestDecision;
    this._html('plan-source',sourceTag(decision?'계획 로그':'재생 위치',decision?'recorded':'event'));
    const prev=this.dispatchPrepared?nextDispatchTime(this.dispatchPrepared,context.time,context.selected,-1):null;
    const next=this.dispatchPrepared?nextDispatchTime(this.dispatchPrepared,context.time,context.selected,1):null;
    this.navigation={prev:finite(prev)?+prev:null,next:finite(next)?+next:null};
    const nav=`<div class="dp-plan-nav"><button type="button" data-dp-action="previous" ${finite(prev)?'':'disabled'} aria-label="이전 기록 계획 시각으로 이동">이전</button><button type="button" data-dp-action="next" ${finite(next)?'':'disabled'} aria-label="다음 기록 계획 시각으로 이동">다음</button></div>`;
    if(!decision){
      this._html('plan-caption',`<div class="dp-plan-head"><strong>${context.loading?'계획 로그 확인 중':'기록된 계획 없음'}</strong>${nav}</div>`);
      this._renderRoute(context,null);this._html('stops','');this._emitRoutes(null,context);return;
    }
    const issued=decision.time,changed=decision.changed;
    const trigger=typeof decision.trigger==='object'?(decision.trigger.label||decision.trigger.kind||'운행계획 갱신'):(triggerLabels[decision.trigger]||decision.trigger||'운행계획 갱신');
    const assigned=decision.assignment?.vehicle;
    const assignment=finite(assigned)?` · DRT ${assigned} 배정`:'';
    const changedLabel=changed===false?'순서 유지':'계획 갱신';
    this._html('plan-caption',`<div class="dp-plan-head"><div><strong>${text(clock(issued,true))} <span class="dp-plan-status">${changedLabel}</span></strong><small>${text(trigger)}${text(assignment)}</small></div>${nav}</div>`);
    this._renderRoute(context,decision);
    const current=view.currentPlan||decision.after,stops=(current?.stops||[]).filter(stop=>stop.kind!=='TRANSIT');
    const numberedStops=(decision.after?.stops||[]).filter(stop=>stop.kind!=='TRANSIT');
    const numberFor=(stop,index)=>{const at=numberedStops.findIndex(s=>s.nodeId===stop.nodeId&&s.kind===stop.kind&&s.time===stop.time&&s.requestId===stop.requestId);return at<0?index:at;};
    const oldFirst=decision.before?planFirst(decision.before,context.network):'이전 기록 없음';
    const newFirst=planFirst(decision.after,context.network);
    const compare=`<div class="dp-plan-compare"><div><label>변경 전 목적지</label><b>${text(oldFirst)}</b></div><span class="dp-arrow" aria-hidden="true">→</span><div class="dp-after"><label>변경 후 목적지</label><b>${text(newFirst)}</b></div></div>`;
    this._html('stops',`${compare}${stops.length?`<div class="dp-subheading"><strong>다음 작업</strong><span>남은 ${number(stops.length)}건</span></div><ol class="dp-plan-stops">${stops.slice(0,3).map((stop,index)=>renderStop(stop,numberFor(stop,index),context.network)).join('')}</ol>${stops.length>3?`<p class="dp-more-stops">이후 ${number(stops.length-3)}개 작업</p>`:''}`:'<p class="dp-small">남은 작업 없음 · 호출 대기</p>'}`);
    this._emitRoutes(decision,context);
  }
  _renderRoute(context,decision){
    if(context.runLoading){this.mapSignature='';this.mapModel=null;this.markerSignature='';this._html('route','<div class="dp-route-placeholder">운영자료 전환 중</div>');return;}
    const state=this.currentVehicle,point=vehiclePoint(state);
    const height=this._mapHeight();this.mapHeight=height;
    const signature=`${context.run.id}:${context.selected}:${decision?.id??decision?.time??'position'}:${this.visibility.before}:${this.visibility.after}:${height}`;
    const rebuild=signature!==this.mapSignature||!this.mapModel||(point&&!this.mapModel.contains(state));
    if(rebuild){
      this.mapSignature=signature;
      this.mapModel=routeMapModel(decision?.before,decision?.after,context.network,this.visibility,state,height);
      this.markerSignature='';
    }
    const model=this.mapModel;
    if(!model){this._html('route','<div class="dp-route-placeholder">현재 위치와 도로 형상 미확인</div>');return;}
    const markerSignature=JSON.stringify([state?.id,state?.lon,state?.lat,state?.heading,state?.geometryQuality]);
    if(!rebuild&&markerSignature===this.markerSignature)return;
    this.markerSignature=markerSignature;
    const marker=this.nodes.route.querySelector?.('[data-dp-live-position]');
    if(!rebuild&&marker){
      // Only this tiny group changes between plan updates; the road SVG stays mounted.
      marker.innerHTML=vehicleMarker(state,model.project);
      const label=this.nodes.route.querySelector?.('[data-dp-position-source]');
      if(label)label.textContent=point?`차량 위치 · ${positionLabel(state)}`:'차량 위치 미확인';
      this.rendered.delete('route');return;
    }
    const controls=decision?`<button type="button" data-dp-action="toggle-before" aria-pressed="${this.visibility.before}"><span class="dp-swatch is-before"></span>변경 전</button><button type="button" data-dp-action="toggle-after" aria-pressed="${this.visibility.after}"><span class="dp-swatch"></span>변경 후</button>`:'<span>위치 표시 · 계획 기록 대기</span>';
    const scope=decision?.before?.routeTruncated||decision?.after?.routeTruncated?'앞 12개 작업 경로':'';
    this._html('route',`<div class="dp-route-box">${model.render(state)}<div class="dp-route-key"><div class="dp-route-controls">${controls}</div><span data-dp-position-source>${point?`차량 위치 · ${text(positionLabel(state))}`:'차량 위치 미확인'}</span><button type="button" class="dp-map-expand" data-dp-action="expand-map" aria-label="경로 지도 확대" title="경로 지도 확대">⛶ 확대</button></div>${scope?`<div class="dp-route-scope">${scope}</div>`:''}</div>`);
  }
  _emitRoutes(decision,context){
    const id=decision?`${context.run.id}:${context.selected}:${decision.id??decision.time}:${this.visibility.before}:${this.visibility.after}`:'empty';
    if(this.routeSignature===id)return;this.routeSignature=id;
    this.callbacks.onRouteComparison?.(decision?{id,previousPaths:this.visibility.before?planPaths(decision.before):[],currentPaths:this.visibility.after?planPaths(decision.after):[],vehicleId:+context.selected,provenance:'recorded_plan_network_reconstruction',time:decision.time}:null);
  }
  _renderImpacts(context,view){
    const decision=view.latestDecision,assignment=decision?.assignment;
    const promised=decision?.promisedWaitMin??assignment?.promisedWaitMin;
    const tested=decision?.candidatesTested??assignment?.candidatesTested??assignment?.candidates_tested;
    const waitImpacts=(view.waitImpacts||[]).filter(x=>finite(x.deltaMin)&&x.source!=='unvalidated'&&x.source!=='unavailable');
    const parcelImpacts=(view.logisticsImpacts||[]).filter(x=>finite(x.deltaMin)&&x.source!=='unvalidated'&&x.source!=='unavailable');
    const positive=waitImpacts.filter(x=>+x.deltaMin>1e-6);
    const maxAdded=positive.length?Math.max(...positive.map(x=>+x.deltaMin)):waitImpacts.length?0:null;
    this._html('impact-source',waitImpacts.length||parcelImpacts.length?sourceTag('검증 재계산','derived'):sourceTag('기록값','recorded'));
    const metrics=`<div class="dp-metrics"><div class="dp-metric"><label>신규 호출 약속 대기</label><strong>${format(promised)}<small>분</small></strong><small>${finite(assignment?.vehicle)?`배정 DRT ${number(assignment.vehicle)}`:'배차 기록 없음'}</small></div><div class="dp-metric"><label title="제약을 통과해 점수 평가한 삽입 후보 수">평가한 삽입 후보</label><strong>${number(tested)}<small>개</small></strong><small>제약 통과 후보</small></div><div class="dp-metric" data-tone="${finite(maxAdded)&&+maxAdded>0?'warning':'normal'}"><label>기존 승객 추가 대기</label><strong>${format(maxAdded)}<small>분</small></strong><small>변경 전후 최대값</small></div></div>`;
    const impacts=waitImpacts.slice(0,3).map(item=>{
      const id=item.requestId??item.id??'';
      return `<li class="dp-impact"><div><b>호출 ${text(id)} · 예정 대기</b><small>${format(item.beforeWaitMin)} → ${format(item.afterWaitMin)}분</small></div><div class="dp-delta" data-sign="${+item.deltaMin>0?'positive':'negative'}">${signed(item.deltaMin)}분</div></li>`;
    }).join('');
    const parcels=parcelImpacts.slice(0,2).map(item=>{
      const hub=item.hubId??item.hub??item.nodeId;
      const before=item.beforeTime??item.beforeEta??item.beforeEtaMin,after=item.afterTime??item.afterEta??item.afterEtaMin;
      const vehicleChange=finite(item.beforeVehicle)&&finite(item.afterVehicle)&&+item.beforeVehicle!==+item.afterVehicle?` · DRT ${number(item.beforeVehicle)} → ${number(item.afterVehicle)}`:'';
      return `<li class="dp-impact"><div><b>${text(item.name||findLabel(context.network,hub))} · 다음 배송</b><small>${finite(before)?text(clock(before)):'—'} → ${finite(after)?text(clock(after)):'—'}${vehicleChange}</small></div><div class="dp-delta" data-sign="${+item.deltaMin>0?'positive':'negative'}">${signed(item.deltaMin)}분</div></li>`;
    }).join('');
    const impactNote=waitImpacts.length||parcelImpacts.length?'계획 전후 차이 · 물류 단독 영향 아님':'비교 가능한 이전·이후 ETA 없음';
    const search=decision?.search;
    const acceptedMoves=finite(search?.acceptedMoves)?+search.acceptedMoves:search?.acceptedMoves&&typeof search.acceptedMoves==='object'?Object.values(search.acceptedMoves).reduce((sum,v)=>sum+(finite(v)?+v:0),0):null;
    const searchCopy=search&&finite(acceptedMoves)?`<p class="dp-search-result">전체 차량 국소탐색 <b>${number(search.tested)}개 평가 · ${number(acceptedMoves)}개 개선</b></p>`:'';
    if(this.nodes['impact-summary']){
      const nextParcel=[...parcelImpacts].filter(item=>finite(item.afterTime??item.afterEta??item.afterEtaMin)).sort((a,b)=>(a.afterTime??a.afterEta??a.afterEtaMin)-(b.afterTime??b.afterEta??b.afterEtaMin))[0];
      const compact=`<div class="dp-metrics dp-core-metrics"><div class="dp-metric"><label>신규 승객 대기 <span class="dp-metric-unit">(분)</span></label><strong>${format(promised)}<small>분</small></strong><small>배차 시 약속</small></div><div class="dp-metric" data-tone="${finite(maxAdded)&&+maxAdded>0?'warning':'normal'}"><label>기존 승객 추가 <span class="dp-metric-unit">(분)</span></label><strong>${format(maxAdded)}<small>분</small></strong><small>계획 전후 최대</small></div><div class="dp-metric" data-tone="${nextParcel&&+nextParcel.deltaMin>0?'warning':'normal'}"><label>다음 배송 변경 <span class="dp-metric-unit">(분)</span></label><strong>${nextParcel?signed(nextParcel.deltaMin):'—'}<small>분</small></strong><small>계획 ETA 차이</small></div></div><p class="dp-core-note">${waitImpacts.length||parcelImpacts.length?'계획 비교 · 물류 단독 영향 아님':'비교할 이전·이후 ETA 없음'}</p>`;
      this._html('impact-summary',compact);
    }
    this._html('impacts',`${metrics}${impacts||parcels?`<ul class="dp-impact-list">${impacts}${parcels}</ul>`:''}<p class="dp-evidence-note">${impactNote}</p>${searchCopy}`);
  }
  _renderAlgorithm(context,view){
    const scenario=context.run.scenario;
    const objective=typeof view.objective==='object'?(view.objective.description||view.objective.label||view.objective.name||SCENARIOS[scenario]):SCENARIOS[scenario];
    const methodology=view.methodology||{};
    const constraints=Array.isArray(methodology.constraints)?methodology.constraints.map(value=>`<li>${text(value)}</li>`).join(''):'';
    const provisional=scenario==='S2'?'<p class="dp-method-copy">S2 비용계수: 참고값 · 연간 운영원가 추정과 별개</p>':'';
    this._html('algorithm',`<div class="dp-method"><span>호출 수신</span><i>→</i><span>삽입 평가</span><i>→</i><span>경로 개선</span><i>→</i><span>계획 갱신</span></div><div class="dp-method-objective"><strong>${text(scenario)} · ${text(objective||SCENARIOS[scenario]||'목적함수 확인')}</strong></div><dl class="dp-method-facts"><div><dt>여객</dt><dd>호출 시각에 수신</dd></div><div><dt>물류</dt><dd>배송지·수량 고정 / 차량·방문 순서 재계획</dd></div><div><dt>경로·위치</dt><dd>계획 로그 + 도로망 복원·보간</dd></div><div><dt>ETA</dt><dd>도로 통행시간·서비스 시간으로 검증 재계산</dd></div><div><dt>미기록 항목</dt><dd>후보별 기각 사유·대안별 대기시간</dd></div></dl>${constraints?`<h4>코드의 운영 제약</h4><ul class="dp-method-constraints">${constraints}</ul>`:''}<p class="dp-method-copy">15분 대기: 분석 기준, 강제 제약 아님<br>가상 주차 탐색: 마지막 서비스 위치 유지<br>국소탐색 결과: 전역 최적해 보장 없음</p>${provisional}`);
  }
  _handleClick(event){
    const vehicle=event.target.closest?.('[data-dp-vehicle]');
    if(vehicle&&this.container.contains(vehicle)){this.callbacks.onVehicle?.(+vehicle.dataset.dpVehicle);return;}
    const button=event.target.closest?.('[data-dp-action]');if(!button||!this.container.contains(button)||button.disabled)return;
    const action=button.dataset.dpAction;
    if(action==='expand-map'){this._expandRoute();return;}
    if(action==='close-map'){this._closeRoute();return;}
    if(action==='previous'||action==='next'){
      const value=this.navigation?.[action==='previous'?'prev':'next'];if(finite(value))this.callbacks.onSeek?.(+value);return;
    }
    if(action==='toggle-before'||action==='toggle-after'){
      const key=action==='toggle-before'?'before':'after';this.visibility[key]=!this.visibility[key];this.mapSignature='';this.update(this.context,true);
    }
  }
  destroy(){
    this.routeObserver?.disconnect();this._closeRoute();
    this.container.removeEventListener('click',this._click);this.container.removeEventListener('keydown',this._keydown);this.callbacks.onRouteComparison?.(null);this.container.replaceChildren();this.context=null;this.dispatchPrepared=null;this.view=null;this.rendered.clear();this.active=false;
  }
}
