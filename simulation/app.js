import MetroScene from './vworld-scene.js?v=20261125-v7';
import {prepareRun,stateAt,aggregateAt,clock,VEHICLE_COLORS,KIND_LABELS,STATUS_LABELS,SCENARIOS} from './replay-core.js?v=20261125-v7';
import {parseBoundaryGeoJSON} from './boundary-data.js';
import KakaoRoadview from './roadview.js';
import ResearchWorkspace from './research-workspace.js?v=20261125-v7';
import {buildPassengerFeedbackIndex} from './passenger-feedback.js';
import {SeekCoordinator,PassengerCallCursor,playbackSpeed,readPresentationPreferences,savePresentationPreferences} from './presentation-controls.js';

const $=id=>document.getElementById(id), qa=s=>[...document.querySelectorAll(s)];
const fmt=(v,d=1)=>Number.isFinite(Number(v))?Number(v).toLocaleString('ko-KR',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const modeName=m=>m==='integrated'?'여객 + 물류':'여객 전용';
const isService=e=>['PU','DO','LOAD','RESTOCK','DELIVER','PARCEL'].includes(e.kind);
const weekdays=['일','월','화','수','목','금','토'];
const dateLabel=d=>`${d.replaceAll('-','.')} (${weekdays[new Date(d+'T12:00:00+09:00').getUTCDay()]})`;
let manifest,network,costs,run,prepared,scene,sceneReady=false;
let date='2023-11-06',mode='integrated',scenario='S1',time=30,selected=1,playing=false,speed=120,camera='overview',runLoading=false;
let panel='replay',eventVehicle='all',eventKind='all',eventSearch='',loadSerial=0,autoStop=null,lastUI=0,lastFrame=performance.now(),lastWaiting=0;
const cache=new Map();
const preparedCache=new Map();
let boundaryModel=null,boundarySerial=0,roadview,research;
let seeking=false,feedback=null,feedbackRun=null,feedbackDecisions=null,callAlertTimer=null,renderFrame=null;
let preferenceStorage;try{preferenceStorage=window.localStorage;}catch{}
const presentation=readPresentationPreferences(preferenceStorage),callCursor=new PassengerCallCursor();
speed=presentation.speed;
const seekCoordinator=new SeekCoordinator({
  onPreview:value=>{time=value;callCursor.reset(time,run?.id);render(true);},
  onCommit:value=>{time=value;seeking=false;research?.setScrubbing(false);callCursor.reset(time,run?.id);render(true);}
});
let roadviewStatus={ready:false,phase:'disconnected',message:'카카오 JavaScript 키를 연결하면 실제 촬영된 로드뷰를 볼 수 있습니다.'};
const BOUNDARY_URL='./data/gangnae_boundary.geojson';
let status={message:'지도 엔진 선택 대기',imagery:'지도 엔진 선택 대기',terrain:'고도 미확인',buildings:'미연결',engine:'waiting',ready:false};
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,5000);}
function dismissCallAlert(){clearTimeout(callAlertTimer);callAlertTimer=null;const el=$('passenger-call-alert');if(el)el.hidden=true;}
function syncPassengerFeedback(){
  const decisions=research?.data;
  if(run===feedbackRun&&decisions===feedbackDecisions)return;
  feedbackRun=run;feedbackDecisions=decisions;
  feedback=run?buildPassengerFeedbackIndex(run,decisions):null;
}
function announceCalls(calls){
  if(!presentation.callAlerts||!calls.length)return;
  const call=calls.at(-1),origin=network?.nodes?.[call.pickupNode],destination=network?.nodes?.[call.dropoffNode];
  $('call-alert-origin').textContent=origin?.label||String(call.pickupNode||'출발 정류장');
  $('call-alert-destination').textContent=destination?.label||String(call.dropoffNode||'도착 정류장');
  $('call-alert-time').textContent=clock(call.time,true);
  $('call-alert-detail').textContent=`${call.people}명 · 호출 기록 재생${calls.length>1?` · 이번 구간 ${calls.length}건 중 최근 호출`:''}`;
  dismissCallAlert();$('passenger-call-alert').hidden=false;
  callAlertTimer=setTimeout(dismissCallAlert,5000);
}
function savePresentation(){presentation.speed=speed;savePresentationPreferences(preferenceStorage,presentation);}
function setPlaybackSpeed(value,{clearSceneStop=true,preserveInput=false}={}){
  speed=playbackSpeed(value,speed);if(clearSceneStop)autoStop=null;
  const range=$('speed-range'),number=$('speed-number');
  if(range){range.value=String(speed);range.setAttribute('aria-valuetext',`${speed}배`);}
  if(number&&!preserveInput)number.value=String(speed);
  const select=$('speed-select');
  if(select){
    let option=[...select.options].find(o=>Number(o.value)===speed);
    if(!option){select.querySelector('[data-custom-speed]')?.remove();option=new Option(`${speed}×`,String(speed));option.dataset.customSpeed='1';select.add(option);}
    select.value=String(speed);
  }
  savePresentation();
}
function scheduleRender(){if(renderFrame!==null)return;renderFrame=requestAnimationFrame(()=>{renderFrame=null;render(true);});}
async function getJSON(url){const response=await fetch(url);if(!response.ok)throw new Error(`${url} (${response.status})`);return response.json();}
function syncBoundaryControls(message){
  const exists=!!boundaryModel&&!boundaryModel.empty;
  $('boundary-toggle').disabled=!exists;
  $('boundary-fit').disabled=!exists||!sceneReady;
  if(message!==undefined)$('boundary-status').textContent=message;
}
function setBoundaryModel(model){
  if(model.empty)return;
  scene.setBoundary(model,{visible:true,fill:false});
  boundaryModel=model;$('boundary-toggle').checked=true;
  syncBoundaryControls(`강내면 QGIS 경계 · 테두리만 기본 표시${sceneReady?'':' · 지도를 연결하면 표시됩니다.'}`);
}
async function loadDefaultBoundary(){
  const serial=++boundarySerial;
  try{
    const response=await fetch(BOUNDARY_URL,{cache:'no-store'});
    if(serial!==boundarySerial)return;
    if(!response.ok)throw new Error(`경계 파일을 읽지 못했습니다 (${response.status}).`);
    const data=await response.json();if(serial!==boundarySerial)return;
    setBoundaryModel(parseBoundaryGeoJSON(data));
  }catch(error){if(serial===boundarySerial)syncBoundaryControls(`기본 경계를 불러오지 못했습니다. ZIP 전체를 풀었는지 확인해 주세요. ${error.message}`);}
}
function canReplay(){return sceneReady||(camera==='roadview'&&roadview?.isReady===true);}
function syncViewMode(){
  const active=camera==='roadview';
  const decision=camera==='decision';
  document.querySelector('.map-stage').classList.toggle('is-decision',decision);
  $('dispatch-panel').hidden=!decision;
  $('dispatch-panel').setAttribute('aria-hidden',String(!decision));
  research?.setActive(camera);
  $('roadview-panel').hidden=!active;
  $('roadview-panel').setAttribute('aria-hidden',String(!active));
  $('map').setAttribute('aria-hidden',String(active));
  document.querySelector('.map-stage').classList.toggle('is-roadview',active);
  $('map-start').hidden=sceneReady||active;
  $('map-status').textContent=active?'카카오 로드뷰 · 촬영 시점은 시뮬레이션 날짜와 다를 수 있습니다.':`${status.imagery} · ${status.terrain}`;
  roadview?.setActive(active);
  syncPlaybackControls();
}
function onRoadviewStatus(value){
  roadviewStatus={...roadviewStatus,...value};
  const message=roadviewStatus.message||'로드뷰 연결 대기';
  $('roadview-status').textContent=message;
  $('roadview-settings-status').textContent=message;
  const empty=['disconnected','loading','unavailable','error'].includes(roadviewStatus.phase);
  $('roadview-empty').hidden=!empty;
  $('roadview-empty-message').textContent=message;
  $('roadview-vehicle').textContent=`DRT ${String(selected).padStart(2,'0')} 주변 실제 촬영 지점`;
  if(roadviewStatus.followHeading!==undefined)$('roadview-heading').checked=roadviewStatus.followHeading;
  if(!canReplay())setPlaying(false);
  syncPlaybackControls();
}
function openRoadviewSettings(){
  if(!$('settings-dialog').open)$('settings-dialog').showModal();
  $('kakao-key').focus();
  $('roadview-settings').scrollIntoView({block:'nearest'});
}
async function connectRoadview(){
  const button=$('connect-roadview');button.disabled=true;
  try{
    // Roadview needs a visible, measurable container while it initializes.
    setCamera('roadview');
    const connected=await roadview.connect($('kakao-key').value.trim());
    if(!connected)throw new Error(roadviewStatus.message||'로드뷰를 연결하지 못했습니다.');
    $('kakao-key').value='';
    $('settings-dialog').close();
    render(true);
  }catch(error){
    $('roadview-settings-status').textContent=error.message;
    toast(error.message);
  }finally{button.disabled=false;syncPlaybackControls();}
}
function syncPlaybackControls(){
  $('play-button').disabled=!prepared||!canReplay()||runLoading;
  $('scene-button').disabled=!prepared||!sceneReady||runLoading;
}
function setPlaying(value){if(value)seekCoordinator.flush();playing=!!value&&!!prepared&&canReplay()&&!runLoading;$('play-button').setAttribute('aria-label',playing?'일시정지':'재생');$('play-icon').innerHTML=playing?'<path d="M6 5h4v14H6zm8 0h4v14h-4Z"/>':'<path d="m9 5 11 7-11 7Z"/>';}
function seek(value,{pause=true}={}){
  const target=Number(value);if(!Number.isFinite(target))return;
  seekCoordinator.cancel();seeking=false;research?.setScrubbing(false);
  if(pause)setPlaying(false);autoStop=null;time=Math.max(30,Math.min(990,target));
  callCursor.reset(time,run?.id);dismissCallAlert();roadview?.reset();render(true);
}
function previewSeek(value){
  if(!prepared||runLoading)return;
  if(!seeking){setPlaying(false);autoStop=null;dismissCallAlert();roadview?.reset();seeking=true;research?.setScrubbing(true);}
  seekCoordinator.request(value);
}
function setCamera(value){
  camera=value;
  qa('[data-camera]').forEach(b=>{const active=b.dataset.camera===camera;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
  if(value!=='roadview')scene?.setCamera(value==='decision'?'follow':value,selected);
  if(value==='decision'&&panel!=='replay')openPanel('replay');
  syncViewMode();
  requestAnimationFrame(()=>{scene?.resize();drawEvents();});
  if(!canReplay())setPlaying(false);
  render(true);
}
function selectVehicle(id,focus=false){
  selected=Number(id)||1;roadview?.reset();
  if(camera==='roadview'){render(true);return;}
  if(camera==='decision'){scene?.setCamera('follow',selected);render(true);return;}
  if(focus)setCamera('follow');else if(camera!=='overview')scene?.setCamera(camera,selected);
  render(true);
}
function serviceEvents(){return (run?.events||[]).filter(e=>isService(e)&&Number(e.vehicle)===selected).sort((a,b)=>a.time-b.time);}
function jumpEvent(direction){const items=serviceEvents();const e=direction>0?items.find(e=>e.time>time+.001):[...items].reverse().find(e=>e.time<time-.001);if(!e){toast(direction>0?'선택 차량의 다음 서비스 이벤트가 없습니다.':'선택 차량의 이전 서비스 이벤트가 없습니다.');return;}seek(e.time);if(camera!=='roadview'&&camera!=='decision')setCamera('follow');}
function playService(){
  if(!sceneReady||runLoading||!prepared){toast('지도와 실행자료 준비가 끝나면 장면을 재생할 수 있습니다.');return;}
  const items=serviceEvents();const e=items.find(e=>e.time>=time-.02)||items[0];if(!e){toast('이 실행에 해당 차량의 서비스 이벤트가 없습니다.');return;}
  seek(Math.max(30,e.time-.04));autoStop=e.completed+.03;
  setPlaybackSpeed(Math.max(1,Math.min(60,Math.round((e.completed-e.time)*60/12*10)/10)),{clearSceneStop:false});
  if(camera!=='decision')setCamera('follow');setPlaying(true);render(true);toast(`${KIND_LABELS[e.kind]} 장면 · 로그 시각은 유지하고 재생 속도만 조절합니다.`);
}
async function loadRun(){
  const serial=++loadSerial;seekCoordinator.cancel();seeking=false;research?.setScrubbing(false);setPlaying(false);roadview?.reset();dismissCallAlert();callCursor.reset(time,null);autoStop=null;runLoading=true;syncPlaybackControls();
  research?.setRun(null);
  research?.update({run,prepared,network,time,selected,states:[],camera,runLoading:true,seeking:false});
  scene?.update([],time);scene?.setWaitingPassengers?.([]);scene?.updatePassengerBubbles?.();
  const descriptor=manifest.runs.find(r=>r.date===date&&r.scenario===scenario&&r.mode===mode);
  if(!descriptor){prepared=null;runLoading=false;syncPlaybackControls();toast('선택한 실행자료가 없습니다.');return;}
  $('loading').hidden=false;$('load-detail').textContent=`${dateLabel(date)} · ${scenario} · ${modeName(mode)} 실행 로그를 연결합니다.`;
  try{
    let data=cache.get(descriptor.id);if(!data){data=await getJSON(descriptor.url);cache.set(descriptor.id,data);if(cache.size>8)cache.delete(cache.keys().next().value);}
    if(serial!==loadSerial)return;run=data;
    prepared=preparedCache.get(run.id);if(!prepared){prepared=prepareRun(run,network);preparedCache.set(run.id,prepared);while(preparedCache.size>8)preparedCache.delete(preparedCache.keys().next().value);}
    callCursor.reset(time,run.id);feedbackRun=null;runLoading=false;syncPlaybackControls();
    void research?.setRun(run);
    qa('[data-mode]').forEach(b=>{const a=b.dataset.mode===mode;b.classList.toggle('active',a);b.setAttribute('aria-pressed',a);});
    qa('[data-scenario]').forEach(b=>{const a=b.dataset.scenario===scenario;b.classList.toggle('active',a);b.setAttribute('aria-pressed',a);});
    $('scenario-description').textContent=SCENARIOS[scenario]+(scenario==='S2'?' · 비용계수 참고용':'');
    updateDailyStats();drawEvents();render(true);if(panel!=='replay')renderPanel();
    const params=new URLSearchParams({date,mode,scenario});history.replaceState(null,'',`${location.pathname}?${params}`);
    $('loading').hidden=true;
  }catch(error){if(serial!==loadSerial)return;prepared=null;runLoading=false;syncPlaybackControls();$('load-detail').textContent='실행자료를 불러오지 못했습니다. 날짜·운영방식·시나리오를 다시 선택해 주세요.';toast(error.message);}
}
function updateDailyStats(){
  const s=run.summary;
  $('daily-stats').innerHTML=[['주행거리',s.total_km,'km',1],['평균 대기',s.avg_wait_min,'분',2],['여객 수송',s.served,'건',0],['물류 배송',s.parcels_delivered,'개',0]].map(([a,b,c,d])=>`<div><span>${a}</span><strong>${fmt(b,d)}<small>${c}</small></strong></div>`).join('');
  $('wait-note').textContent=`15분 초과 대기 ${fmt(s.wait_over_15_count??s.wait_over_15_ratio*s.calls,0)}건 (${fmt(s.wait_over_15_ratio*100,1)}%). 대기시간 15분은 강제 제약이 아닙니다.`;
}
function render(force=false){
  if(!prepared||runLoading)return;syncPassengerFeedback();const states=stateAt(prepared,time,selected);scene?.update(states,time);research?.updateScene();scene?.updatePassengerBubbles?.();
  if(!seeking)roadview?.update({...states.find(s=>s.id===selected),time},{contextKey:`${run.id}/${selected}`});
  if(force||Math.abs(time-lastWaiting)>.2){
    const waiting=run.passengers.filter(p=>p.call<=time&&(p.pickup==null||p.pickup>time)).map(p=>{const n=network.nodes[p.pickupNode];return n?{id:p.id,nodeId:p.pickupNode,lon:n.lon,lat:n.lat,label:n.label}:null;}).filter(Boolean);
    scene?.setWaitingPassengers?.(waiting);lastWaiting=time;
  }
  const now=performance.now();if(!force&&now-lastUI<100)return;lastUI=now;
  research?.update({run,prepared,network,time,selected,states,camera,runLoading,seeking});
  const text=clock(time,true);$('clock').innerHTML=`${text.slice(0,5)}<span>${text.slice(5)}</span>`;
  $('date-caption').textContent=`${date.replaceAll('-','.')} · ${scenario} · ${modeName(mode)}`;$('time-slider').value=String(time);$('time-slider').setAttribute('aria-valuetext',text);
  const aggregate=aggregateAt(run,time);$('live-totals').innerHTML=[['현재 대기',aggregate.waiting,'명'],['수송 완료',aggregate.served,'건'],['배송 완료',aggregate.delivered,'개']].map(([l,n,u])=>`<div><span>${l}</span><b>${fmt(n,0)}<small>${u}</small></b></div>`).join('');
  if(!$('vehicle-list').children.length)$('vehicle-list').innerHTML=[1,2,3].map(id=>`<button class="vehicle-card" data-vehicle="${id}" style="--vcolor:${VEHICLE_COLORS[id-1]}" aria-label="차량 ${id} 선택"><div class="vehicle-card-top"><i class="vehicle-dot"></i><span class="vehicle-name">DRT ${String(id).padStart(2,'0')}</span><span class="vehicle-card-status" id="vehicle-status-${id}"></span></div><div class="vehicle-load"><span>승객 <b id="vehicle-people-${id}">0</b>/11</span><span>물류 <b id="vehicle-cargo-${id}">0</b>/8</span></div><div class="vehicle-track"><span id="vehicle-track-${id}"></span></div></button>`).join('');
  for(const s of states){const card=$('vehicle-list').querySelector(`[data-vehicle="${s.id}"]`);card.classList.toggle('selected',s.id===selected);card.setAttribute('aria-pressed',s.id===selected);$(`vehicle-status-${s.id}`).textContent=STATUS_LABELS[s.status]||s.status;$(`vehicle-people-${s.id}`).textContent=s.passengers;$(`vehicle-cargo-${s.id}`).textContent=s.cargo;$(`vehicle-track-${s.id}`).style.width=`${Math.max(s.passengers/11,s.cargo/8)*100}%`;}
  const focus=states.find(s=>s.id===selected);$('current-scene').querySelector('.vehicle-color').style.background=VEHICLE_COLORS[selected-1];
  $('focus-caption').textContent=`DRT ${String(selected).padStart(2,'0')} · ${fmt(focus.distanceKm,1)} km 누적`;
  $('focus-status').textContent=STATUS_LABELS[focus.status]||focus.status;
  const e=focus.event,to=network.nodes[e?.to],from=network.nodes[e?.from];
  $('focus-location').textContent=focus.status==='parking'?'위치 고정 · 가상 거리·시간만 반영':e?`${to?.label||from?.label||'강내우체국'}${time<e.time?' 도착 예정 '+clock(e.time):''}`:'강내우체국 · 출발 대기';
  $('evidence-button').textContent=focus.geometryQuality==='virtual_stationary'?'가상 주차 탐색 · 지도 위치 고정':focus.geometryQuality==='network_interpolation'?'이동 위치: 도로망 기반 시간 보간':focus.geometryQuality==='unresolved'?'경로 미확인 · 출발 노드에서 위치 표시 보류':'서비스 위치: 로그 노드의 도로 투영점';
  if(panel==='events'){qa('.event-row').forEach(row=>row.classList.toggle('event-current',Number(row.dataset.event)===focus.event?.id));}
}
function frame(now){const delta=Math.min((now-lastFrame)/1000,.2);lastFrame=now;if(playing&&prepared&&canReplay()&&!runLoading){time=Math.min(990,time+delta*speed/60);if(autoStop!==null&&time>=autoStop){time=autoStop;autoStop=null;setPlaying(false);}if(time>=990)setPlaying(false);syncPassengerFeedback();announceCalls(callCursor.advance(time,feedback,{enabled:presentation.callAlerts}));render();}requestAnimationFrame(frame);}
function drawEvents(){
  if(!run)return;const canvas=$('event-strip'),width=canvas.clientWidth,height=19,dpr=window.devicePixelRatio||1;canvas.width=width*dpr;canvas.height=height*dpr;const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);ctx.clearRect(0,0,width,height);
  for(let i=0;i<3;i++){ctx.strokeStyle='#294057';ctx.beginPath();ctx.moveTo(0,i*5+2);ctx.lineTo(width,i*5+2);ctx.stroke();}
  for(const e of run.events){if(!isService(e))continue;const x=(e.time-30)/960*width;ctx.fillStyle=VEHICLE_COLORS[e.vehicle-1]||'#aaa';ctx.globalAlpha=(e.kind==='PU'||e.kind==='DO') ? .8 : .55;ctx.fillRect(x,(e.vehicle-1)*5,Math.max(1.7,(e.completed-e.time)/960*width),4);}
  ctx.globalAlpha=1;
}
function openPanel(value){panel=value;qa('.nav-btn').forEach(b=>b.classList.toggle('active',value==='events'?b.dataset.panel==='replay':b.dataset.panel===value));$('detail-panel').hidden=value==='replay';if(value!=='replay')renderPanel();}
function statsRows(rows){return rows.map(([l,v])=>`<div class="stat-row"><span>${l}</span><b>${v}</b></div>`).join('');}
function renderPanel(){
  if(!manifest||!run)return;
  $('panel-title').textContent=({compare:'운영 방식 비교',validation:'데이터와 재현 근거',events:'차량 서비스 이벤트'})[panel]||'재현 방법';
  $('panel-eyebrow').textContent=panel==='compare'?dateLabel(date):panel==='events'?`${date} · ${scenario} · ${modeName(mode)}`:'LOGS · NETWORK · INTERPOLATION';
  if(panel==='compare')renderComparison();else if(panel==='events')renderEventList();else renderValidation();
}
function renderComparison(){
  const rs=manifest.runs.filter(r=>r.date===date),maxWait=Math.max(...rs.map(r=>r.summary.avg_wait_min));const s=run.summary;
  $('panel-content').innerHTML=`<p>같은 날짜의 운영 방식 2개 × 목적함수 3개를 비교합니다. 모든 수치는 각 실행의 최종 집계입니다.</p><div style="overflow:auto"><table class="comparison-table"><thead><tr><th>실행</th><th>거리 km</th><th>평균 대기 분</th><th>15분 초과</th></tr></thead><tbody>${rs.map(r=>`<tr class="${r.id===run.id?'selected':''}"><td><strong>${r.scenario}</strong> <span class="metric-label">${r.mode==='integrated'?'통합':'여객'}</span></td><td>${fmt(r.summary.total_km,1)}</td><td>${fmt(r.summary.avg_wait_min,2)}</td><td>${fmt(r.summary.wait_over_15_ratio*100,1)}%</td></tr>`).join('')}</tbody></table></div><h3>승객 평균 대기시간</h3><div class="panel-chart">${rs.map(r=>`<div class="bar-row"><span>${r.scenario}<small> ${r.mode==='integrated'?'통':'여'}</small></span><div class="bar-track"><div class="bar-fill" style="width:${r.summary.avg_wait_min/maxWait*100}%;background:${r.mode==='integrated'?'#52e0c4':'#668ba7'}"></div></div><span class="bar-value">${fmt(r.summary.avg_wait_min,1)}분</span></div>`).join('')}</div><h3>현재 선택 실행 · 에너지 추정</h3>${statsRows([['총주행거리',`${fmt(s.total_km,2)} km`],['가상 주차 탐색거리',`${fmt(s.parking_virtual_km,2)} km`],['공차거리',`${fmt(s.empty_km,2)} km`],['추정 전력량',`${fmt(s.total_km*costs.kwhPerKm,2)} kWh`],['추정 전력비',`${fmt(s.total_km*costs.electricityKrwPerKm,0)} 원`]])}<p class="muted">총주행거리 × 0.256 kWh/km × 295원/kWh. 가상 주차 탐색거리를 포함한 모형 원가이며 실제 계측 전력량이 아닙니다.</p><h3>통합운영 · 연간 차량 3대 원가</h3><div style="overflow:auto"><table class="comparison-table"><thead><tr><th>시나리오</th><th>연간 운영비</th><th>원/km</th></tr></thead><tbody>${Object.entries(costs.annualIntegrated).map(([key,value])=>`<tr><td>${key}</td><td>${fmt(value.operatingKrw,0)}원</td><td>${fmt(value.krwPerKm,2)}</td></tr>`).join('')}</tbody></table></div><p class="muted">연간 거리 S0 209,877 · S1 260,806 · S2 240,322 km. 365일, 차량 3대 전체의 추정치입니다. 여객 전용 결과에 이 연간 단가를 적용하지 않습니다.</p><div class="panel-note warning"><strong>S2는 참고용 비용 시나리오입니다.</strong><br>이 운영원가표는 S2 배차 목적함수의 미확정 비용계수와 별개입니다. 기존 최적화 로그의 비용 대리값을 실제 운영비로 표시하지 않습니다.</div><p class="muted">충전손실·충전시설·관제·통신·소프트웨어 비용 제외. 일부 2020년 보험·유지보수 단가는 물가 미보정. 출처: 사용자 제공 「자율주행DRT_원가_정리.pdf」 산정표.</p><h3>선택 실행의 서비스 결과</h3>${statsRows([['승객 수송',`${s.served} / ${s.calls}건`],['물류 배송',`${s.parcels_delivered} / ${s.parcels_total}개`],['최대 대기시간',`${fmt(s.max_wait_min,2)}분`],['15분 초과 호출',`${s.wait_over_15_count}건 (${fmt(s.wait_over_15_ratio*100,2)}%)`],['복귀 기한',s.returned_by_deadline?'22:30 이내 복귀':'초과 기록 있음']])}`;
}
function renderValidation(){
  const v=manifest.validation,rv=run.validation;
  $('panel-content').innerHTML=`<span class="badge">42개 실행 · 원본 로그와 경로 검증</span><h3>기록과 재현의 경계</h3><div class="panel-note"><strong>원본 로그</strong><br>차량 배정, 서비스 도착·완료 시각, 승객·물류 처리와 이동시간·거리.</div><div class="panel-note"><strong>도로망으로 복원한 위치</strong><br>원본 코드로 분할 도로망과 ID를 재생성하고, 방향성과 통행시간을 반영한 최단경로를 연결했습니다. 이동 중 위치는 링크별 시간으로 보간합니다.</div><div class="panel-note"><strong>시각적 애니메이션</strong><br>차량·인물 모델, 문 개폐, 걷기, 상자 이동은 기록된 서비스 구간 안에서 연출합니다. 실제 영상이나 GPS 측정 궤적은 아닙니다.</div><div class="panel-note"><strong>로드뷰와 시설 모형</strong><br>카카오 로드뷰는 차량 좌표 주변에서 촬영된 사진이며 실시간 영상이나 2023년 운행 당시의 영상이 아닙니다. 우체국·마을회관·정류장 외형과 도로 옆 배치, 쉘터·팻말 구분은 시설 실측자료가 없는 부분을 설명하기 위한 시각화용 가정입니다. 상자 이동 동작만 빠르게 연출하며 물류 수량은 원본 서비스 완료 시각에 갱신됩니다.</div><h3>전체 자료 검증</h3>${statsRows([['일자 × 운영방식 × 시나리오','7 × 2 × 3 = 42'],['전체 이벤트',`${fmt(v.events,0)}건`],['도로 이동 경로',`${fmt(v.reconstructedMovements,0)}건`],['미해결 이동',`${v.unmatchedMovements}건`],['가상 주차 탐색',`${fmt(v.virtualParkingEvents,0)}건`],['원본 도로 링크',`${fmt(v.sourceRoadLinks,0)}개`],['분할 도로 링크',`${fmt(v.splitRoadLinks,0)}개`],['서비스 지점',`${v.serviceNodes}개 (정류장 80 · 물류 39 · 우체국 1)`],['최대 도로 투영거리',`${fmt(v.maxSnapM,3)} m`],['거리·시간 허용오차','각각 0.00001 km / min']])}<p class="muted">정류장·거점의 원래 좌표를 도로선 위 서비스 지점으로 투영했습니다. 강내우체국은 약 14m 이동한 도로 투영점을 사용합니다. 실제 건물 출입구까지 이동한 것으로 표현하지 않습니다.</p><h3>현재 실행 확인</h3>${statsRows([['실행 ID',`<span class="code-label">${esc(run.id)}</span>`],['경로 불일치',`${rv.unmatchedMovements}건`],['최대 시간 차',`${Number(rv.maximumTimeDifferenceMin).toExponential(2)}분`],['최대 거리 차',`${Number(rv.maximumDistanceDifferenceKm).toExponential(2)}km`]])}<h3>연구조건</h3><ul class="check-list"><li>물류 Depot은 <strong>강내우체국</strong>입니다. 서청주 가상 접근 링크를 사용하지 않습니다.</li><li>차량 3대, 승객 11명/대, 물류 8개/대. 운행 06:30–22:00, 복귀 기한 22:30.</li><li>시간은 06:00 이후 경과 분입니다. 물류는 08:30부터 발생합니다.</li><li>주차 탐색 3분·1.5km는 가상 비용 이동입니다. 마지막 위치에 차량을 둡니다.</li><li>승객·물류 수량은 서비스 완료 시각에 변경됩니다. 대기시간 지표는 원본의 승차 도착 시각 기준입니다.</li><li>위치와 거리의 일치는 이번 실행의 복원 검증입니다. 실제 GPS·도로 통행 허용·유일한 과거 경로·전역 최적해를 보장하지 않습니다.</li></ul><h3>지도 연결 상태</h3><p>${esc(status.imagery)}<br>${esc(status.terrain)}<br>${esc(status.buildings)}</p><p class="muted">V-World를 선택하면 해당 서비스의 지도·지형을 사용합니다. Cesium 기본 지형은 공개 Mapzen DEM이며 고도 연결 실패 시 타원체로 전환하고 상태를 표시합니다. 건물 표시 범위는 선택한 공급원에 따라 다릅니다.</p><h3>자료 내려받기</h3><div class="download-links"><a href="./data/split_links_4326.geojson" download>분할 도로 GeoJSON</a><a href="./data/snap_QA.csv" download>노드 매칭 QA</a><a href="./data/validation.json" download>경로 검증 JSON</a><a href="./data/manifest.json" download>원본·변환 명세</a><a href="./README.md" download>실행·수정 안내</a><a href="./scripts/convert.py" download>데이터 변환기</a></div><p><a href="https://github.com/km-minsang/MetroRookies" target="_blank" rel="noopener">MetroRookies 원본 저장소</a></p>`;
}
function renderEventList(){
  const all=run.events.filter(e=>e.vehicle&&e.to&&(eventVehicle==='all'||Number(e.vehicle)===Number(eventVehicle))&&(eventKind==='all'?isService(e):eventKind==='passenger'?['PU','DO'].includes(e.kind):eventKind==='parcel'?['LOAD','RESTOCK','DELIVER','PARCEL'].includes(e.kind):e.kind==='PARK_SEARCH')).filter(e=>!eventSearch||`${KIND_LABELS[e.kind]} ${network.nodes[e.to]?.label} ${e.requestId||''} ${e.to}`.toLowerCase().includes(eventSearch.toLowerCase())).sort((a,b)=>a.time-b.time);
  $('panel-content').innerHTML=`<p>이벤트를 선택하면 기록된 도착 시각으로 이동합니다. 왼쪽의 ‘서비스 장면 보기’로 해당 차량의 다음 작업을 느리게 재생할 수 있습니다.</p><div class="event-filter">${['all','1','2','3'].map(x=>`<button data-filter-vehicle="${x}" class="${eventVehicle===x?'active':''}">${x==='all'?'전체 차량':'차량 '+x}</button>`).join('')}</div><div class="event-filter">${[['all','전체 서비스'],['passenger','승하차'],['parcel','물류'],['parking','가상 주차']].map(([x,n])=>`<button data-filter-kind="${x}" class="${eventKind===x?'active':''}">${n}</button>`).join('')}</div><p class="muted">${all.length}개 이벤트 · 도착 시각 기준 · 서비스 완료 시점에 수량 갱신</p><div class="events-scroll">${all.length?all.map(e=>`<button class="event-row" data-event="${e.id}"><time>${clock(e.time)}</time><div class="event-main"><strong>${esc(KIND_LABELS[e.kind]||e.kind)}${e.quantity?' · '+e.quantity+'개':''}</strong><small>${esc(network.nodes[e.to]?.label||e.to)}${e.requestId?' · 요청 '+esc(e.requestId):''}</small><small>${clock(e.time,true)}–${clock(e.completed,true)}${e.kind==='PARK_SEARCH'?' · 위치 고정':''}</small></div><span class="event-vehicle" style="color:${VEHICLE_COLORS[e.vehicle-1]}">DRT ${e.vehicle}</span></button>`).join(''):'<p>해당 조건의 이벤트가 없습니다.</p>'}</div>`;
}
async function connectMap(engine){
  setPlaying(false);
  const buttons=['connect-vworld','start-cesium','start-cesium-map'];
  for(const id of buttons)$(id).disabled=true;
  $('settings-message').textContent=engine==='vworld'?'V-World 지도와 3D 객체를 준비하고 있습니다.':'Cesium 지도를 준비하고 있습니다.';
  try{
    const ok=engine==='vworld'?await scene.setProviderSettings({vworldKey:$('vworld-key').value.trim()}):await scene.useCesium();
    if(ok===false||!scene.isReady)throw new Error(status.message||'지도 준비가 완료되지 않았습니다. 연결 상태를 확인해 주세요.');
    sceneReady=true;syncPlaybackControls();render(true);setCamera(camera);void research?.attachScene(scene);
    $('settings-message').textContent='지도를 연결했습니다. 재생 버튼으로 운행을 시작하세요.';
    $('vworld-key').value='';$('settings-dialog').close();
  }catch(error){$('settings-message').textContent=error.message;toast(error.message);}
  finally{for(const id of buttons)$(id).disabled=sceneReady;syncPlaybackControls();}
}
function onMapStatus(s){
  status={...status,...s};sceneReady=s.ready===true;
  if(sceneReady)void research?.attachScene(scene);
  if(!canReplay())setPlaying(false);
  syncBoundaryControls();syncViewMode();
  $('map-start-message').textContent=s.message||'V-World 또는 Cesium 지도를 선택해 주세요.';
  if(s.level==='error'||s.fallback)toast(s.message);
}
function bind(){
  $('date-select').addEventListener('change',e=>{date=e.target.value;loadRun();});
  $('mode-control').addEventListener('click',e=>{const b=e.target.closest('[data-mode]');if(b&&b.dataset.mode!==mode){mode=b.dataset.mode;loadRun();}});
  $('scenario-control').addEventListener('click',e=>{const b=e.target.closest('[data-scenario]');if(b&&b.dataset.scenario!==scenario){scenario=b.dataset.scenario;loadRun();}});
  $('vehicle-list').addEventListener('click',e=>{const b=e.target.closest('[data-vehicle]');if(b)selectVehicle(b.dataset.vehicle);});
  qa('[data-camera]').forEach(b=>b.addEventListener('click',()=>setCamera(b.dataset.camera)));
  $('play-button').addEventListener('click',()=>{autoStop=null;setPlaying(!playing);});$('rewind-button').addEventListener('click',()=>seek(time-5));$('forward-button').addEventListener('click',()=>seek(time+5));
  $('time-slider').addEventListener('input',e=>previewSeek(e.target.value));
  $('time-slider').addEventListener('change',()=>seekCoordinator.flush());
  $('time-slider').addEventListener('blur',()=>seekCoordinator.flush());
  $('speed-select').addEventListener('change',e=>setPlaybackSpeed(e.target.value));
  $('speed-range')?.addEventListener('input',e=>setPlaybackSpeed(e.target.value));
  $('speed-number')?.addEventListener('input',e=>{if(e.target.value.trim()&&Number(e.target.value)>0)setPlaybackSpeed(e.target.value,{preserveInput:true});});
  $('speed-number')?.addEventListener('change',e=>setPlaybackSpeed(e.target.value));
  $('dismiss-call-alert')?.addEventListener('click',dismissCallAlert);
  $('call-alerts-enabled').checked=presentation.callAlerts;$('bubble-enabled').checked=presentation.bubbles;
  $('call-alerts-enabled').addEventListener('change',e=>{presentation.callAlerts=e.target.checked;dismissCallAlert();callCursor.reset(time,run?.id);savePresentation();});
  $('bubble-enabled').addEventListener('change',e=>{presentation.bubbles=e.target.checked;scene?.setPassengerBubblesEnabled?.(presentation.bubbles);savePresentation();render(true);});
  $('map-zoom-in')?.addEventListener('click',()=>scene?.zoomStep?.(1));
  $('map-zoom-out')?.addEventListener('click',()=>scene?.zoomStep?.(-1));
  $('previous-event').addEventListener('click',()=>jumpEvent(-1));$('next-event').addEventListener('click',()=>jumpEvent(1));$('scene-button').addEventListener('click',playService);$('focus-button').addEventListener('click',()=>camera==='decision'?scene?.setCamera('follow',selected):setCamera('follow'));
  qa('.nav-btn').forEach(b=>b.addEventListener('click',()=>openPanel(b.dataset.panel)));$('close-panel').addEventListener('click',()=>openPanel('replay'));$('events-button').addEventListener('click',()=>openPanel(panel==='events'?'replay':'events'));$('about-button').addEventListener('click',()=>openPanel('validation'));$('evidence-button').addEventListener('click',()=>openPanel('validation'));
  $('panel-content').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.filterVehicle!==undefined){eventVehicle=b.dataset.filterVehicle;renderEventList();}else if(b.dataset.filterKind!==undefined){eventKind=b.dataset.filterKind;renderEventList();}else if(b.dataset.event!==undefined){const ev=run.events.find(x=>x.id===Number(b.dataset.event));if(ev){selected=Number(ev.vehicle);seek(ev.time);if(camera==='decision'){scene?.setCamera('follow',selected);openPanel('replay');}else if(camera!=='roadview')setCamera('follow');}}});
  for(const [id,kind]of [['roads-toggle','roads'],['stops-toggle','stops'],['hubs-toggle','hubs']])$(id).addEventListener('change',e=>{scene?.setLayers({[kind]:e.target.checked});render(true);});
  $('boundary-toggle').addEventListener('change',e=>scene?.setBoundaryOptions({visible:e.target.checked,fill:false}));
  for(const kind of ['buildings','roads','bridges','terrain'])$(`environment-${kind}`).addEventListener('change',e=>{research?.setEnvironmentVisible(kind,e.target.checked);render(true);});
  $('boundary-fit').addEventListener('click',()=>{if(!boundaryModel||!sceneReady)return;setCamera('overview');scene.zoomBoundary();$('settings-dialog').close();});
  $('connect-roadview').addEventListener('click',connectRoadview);
  $('roadview-settings-button').addEventListener('click',openRoadviewSettings);
  $('roadview-empty-settings').addEventListener('click',openRoadviewSettings);
  $('roadview-refresh').addEventListener('click',()=>roadview?.refresh());
  $('roadview-heading').addEventListener('change',e=>roadview?.setFollowHeading(e.target.checked));
  $('settings-button').addEventListener('click',()=>$('settings-dialog').showModal());
  $('open-map-settings').addEventListener('click',()=>$('settings-dialog').showModal());
  $('connect-vworld').addEventListener('click',()=>connectMap('vworld'));
  for(const id of ['start-cesium','start-cesium-map'])$(id).addEventListener('click',()=>connectMap('cesium'));
  $('apply-settings').addEventListener('click',async()=>{if(status.engine!=='cesium'){$('settings-message').textContent='이 옵션은 Cesium으로 지도를 연 뒤 사용할 수 있습니다.';return;}const btn=$('apply-settings');btn.disabled=true;$('settings-message').textContent='지형·건물 공급원을 연결하고 있습니다.';try{const ok=await scene.setProviderSettings({ionToken:$('ion-token').value,buildings:true});$('settings-message').textContent=ok?'지도 설정을 적용했습니다.':'연결하지 못했습니다. 기존 지도에서 계속 재생할 수 있습니다.';if(ok){$('ion-token').value='';$('settings-dialog').close();}}catch(e){$('settings-message').textContent=e.message;}finally{btn.disabled=false;}});
  $('network-upload').addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;try{if(!network)throw new Error('기본 도로망이 준비된 뒤 업로드해 주세요.');if(file.size>30e6)throw new Error('30MB 이하의 GeoJSON을 선택해 주세요.');const geo=JSON.parse(await file.text());if(geo.type!=='FeatureCollection'||!Array.isArray(geo.features))throw new Error('GeoJSON FeatureCollection이 필요합니다.');const roads=[];for(const f of geo.features){const type=f?.geometry?.type;const paths=type==='LineString'?[f.geometry.coordinates]:type==='MultiLineString'?f.geometry.coordinates:[];if(!Array.isArray(paths))throw new Error('도로 좌표 배열이 올바르지 않습니다.');for(const cs of paths){if(!Array.isArray(cs)||cs.length<2||cs.some(c=>!Array.isArray(c)||c.length<2||!Number.isFinite(c[0])||!Number.isFinite(c[1])||c[0]<126||c[0]>129||c[1]<34||c[1]>39))throw new Error('강내면 주변 EPSG:4326 경위도 선형인지 확인해 주세요.');roads.push({id:'upload-'+roads.length,coordinates:cs.map(c=>[c[0],c[1]])});}}if(!roads.length)throw new Error('LineString 또는 MultiLineString 도로가 없습니다.');scene.setNetwork({...network,roads:[...network.roads,...roads]});$('settings-message').textContent=`${roads.length}개 선을 추가 표시했습니다. 차량은 기존 검증 경로를 유지합니다.`;}catch(err){$('settings-message').textContent=err.message;}});
  let resizeFrame=null;const resize=()=>{if(resizeFrame!==null)return;resizeFrame=requestAnimationFrame(()=>{resizeFrame=null;drawEvents();scene?.resize();});};
  window.addEventListener('resize',resize);window.visualViewport?.addEventListener('resize',resize);
  window.addEventListener('keydown',e=>{if(camera==='roadview'&&e.target?.closest?.('#roadview-canvas'))return;if(e.target?.closest?.('#passenger-call-alert'))return;if(/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)||$('settings-dialog').open)return;if(e.code==='Space'){e.preventDefault();setPlaying(!playing);}if(e.code==='ArrowLeft'){e.preventDefault();seek(time-5);}if(e.code==='ArrowRight'){e.preventDefault();seek(time+5);}});
  document.addEventListener('visibilitychange',()=>{lastFrame=performance.now();});
}
async function init(){
  research=new ResearchWorkspace({onSeek:value=>seek(value),onVehicle:id=>selectVehicle(id),onDataChange:scheduleRender});
  bind();syncPlaybackControls();syncBoundaryControls();roadview=new KakaoRoadview($('roadview-canvas'),{onStatus:onRoadviewStatus});onRoadviewStatus(roadviewStatus);scene=new MetroScene($('map'),{onSelect:id=>selectVehicle(id,true),onStatus:onMapStatus});
  setPlaybackSpeed(speed);scene.setPassengerBubblesEnabled?.(presentation.bubbles);
  scene.setPassengerFeedbackProvider?.((state,t)=>state.animation?.kind==='boarding'?feedback?.getBoardingFeedback(state.animation.requestId,t):state.animation?.kind==='alighting'?feedback?.getAlightingFeedback(state.animation.requestId,t):null);
  const scenePromise=scene.init().then(()=>{sceneReady=scene.isReady===true;syncPlaybackControls();if(network)scene.setNetwork(network);render(true);});
  void loadDefaultBoundary();
  try{
    [manifest,costs]=await Promise.all([getJSON('./data/manifest.json'),getJSON('./data/costs.json')]);
    const params=new URLSearchParams(location.search);if(manifest.dates.includes(params.get('date')))date=params.get('date');if(manifest.scenarios.includes(params.get('scenario')))scenario=params.get('scenario');if(manifest.modes.includes(params.get('mode')))mode=params.get('mode');
    $('date-select').innerHTML=manifest.dates.map(d=>`<option value="${d}">${dateLabel(d)}</option>`).join('');$('date-select').value=date;$('date-select').disabled=false;
    $('dataset-tag').textContent=`발표 화면 v7 · ${manifest.runs.length}개 실행`;
    network=await getJSON(manifest.networkUrl);scene.setNetwork(network);await loadRun();await scenePromise;setCamera('overview');render(true);requestAnimationFrame(frame);
  }catch(error){$('loading').hidden=false;$('load-detail').textContent='자료 연결에 실패했습니다: '+error.message;console.error('Replay initialization failed',error);}
}
init();
