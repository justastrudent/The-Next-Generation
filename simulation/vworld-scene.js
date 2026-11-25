/**
 * VWorld WebGL 3.0 adapter. No API key is stored in source, localStorage, or URLs of this app.
 * The key is sent only to the official SDK endpoint, as required by that endpoint.
 *
 * Primary API references (VWorld's own samples):
 * https://github.com/V-world/V-world_API_sample/tree/master/브이월드_교육/2026년_브이월드_교육
 * https://github.com/V-world/V-world_API_sample/blob/master/%5BWebGL%5D%20glb%20움직이기.html
 * https://www.vworld.kr/dev/v4dv_opnws3dmap3guide_s001.do
 *
 * The SDK keeps its own Cesium globals in a same-origin iframe. Its parser-time script
 * loading can run there without replacing the app document or colliding with bundled Cesium.
 * Credential/domain-specific VWorld rendering must be verified in the intended browser.
 */
import CesiumScene, {readTerrainHeight} from './scene3d.js?v=20261125-v7';
export {readTerrainHeight};

function failure(code,message){const error=new Error(message);error.code=code;return error;}
function currentViewer(scope){
 const viewer=scope?.ws3d?.viewer;
 return viewer?.scene?.globe&&typeof viewer?.entities?.add==='function'&&viewer.camera&&scope.Cesium?.Cartesian3?{viewer,Cesium:scope.Cesium}:null;
}

/**
 * Install the callback BEFORE start; also handle already-ready and delayed global viewers.
 * start may synchronously call vw.ws3dInitCallBack. All timers/listeners are cleaned on settle.
 * Exposed for deterministic unit tests without a WebGL/browser session.
 */
export function waitForVWorldViewer(scope,{start,timeoutMs=30000,pollMs=125,signal}={}){
 return new Promise((resolve,reject)=>{
  const vw=scope?.vw;
  if(!vw){reject(failure('VWORLD_API_MISSING','VWorld 지도 API가 아직 준비되지 않았습니다.'));return;}
  let settled=false,timer,interval;
  const previous=vw.ws3dInitCallBack;
  function cleanup(){clearTimeout(timer);clearInterval(interval);signal?.removeEventListener('abort',abort);if(vw.ws3dInitCallBack===callback)vw.ws3dInitCallBack=previous;}
  function finish(error,result){if(settled)return;settled=true;cleanup();error?reject(error):resolve(result);}
  function check(){if(settled)return;try{const result=currentViewer(scope);if(result)finish(null,result);}catch{finish(failure('VWORLD_VIEWER_ACCESS','VWorld 지도 프레임에 접근할 수 없습니다.'));}}
  function callback(...args){try{if(typeof previous==='function')previous.apply(vw,args);}catch{}finally{check();}}
  function abort(){finish(failure('VWORLD_CANCELLED','VWorld 지도 초기화가 취소되었습니다.'));}
  vw.ws3dInitCallBack=callback;
  timer=setTimeout(()=>finish(failure('VWORLD_VIEWER_TIMEOUT','VWorld SDK는 준비되었지만 지도 viewer가 제한 시간 안에 생성되지 않았습니다. 인증키의 도메인 등록, 지도 서비스 및 브라우저 콘솔을 확인해주세요.')),timeoutMs);
  interval=setInterval(check,pollMs);
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted){abort();return;}
  check();
  if(!settled){try{const started=start?.();if(started&&typeof started.then==='function')started.then(check,()=>finish(failure('VWORLD_START_FAILED','VWorld 지도 생성 중 오류가 발생했습니다. 인증키·등록 도메인 및 브라우저 콘솔을 확인해주세요.')));check();}catch{finish(failure('VWORLD_START_FAILED','VWorld 지도 생성 중 오류가 발생했습니다. 인증키·등록 도메인 및 브라우저 콘솔을 확인해주세요.'));}}
 });
}

function waitForSDK(scope,{timeoutMs=25000,pollMs=125,signal}={}){
 return new Promise((resolve,reject)=>{
  let settled=false,timer,interval;
  const cleanup=()=>{clearTimeout(timer);clearInterval(interval);signal?.removeEventListener('abort',abort);};
  function finish(error){if(settled)return;settled=true;cleanup();error?reject(error):resolve(scope);}
  function abort(){finish(failure('VWORLD_CANCELLED','VWorld SDK 연결이 취소되었습니다.'));}
  function check(){
   if(settled)return;
   try{
    if(scope.__metroVWorldSdk?.failed){finish(failure('VWORLD_SDK_NETWORK','VWorld SDK 파일을 불러오지 못했습니다. 네트워크·서비스 응답·콘텐츠 보안 정책을 확인해주세요.'));return;}
    if(typeof scope.vw?.Map==='function'&&typeof scope.vw?.CameraPosition==='function'&&typeof scope.vw?.CoordZ==='function'&&typeof scope.vw?.Direction==='function'&&scope.document?.getElementById('vmap'))finish();
   }catch{finish(failure('VWORLD_SDK_ACCESS','VWorld SDK 프레임에 접근할 수 없습니다.'));}
  }
  timer=setTimeout(()=>finish(failure('VWORLD_SDK_TIMEOUT','VWorld SDK의 준비 시간이 초과되었습니다. 네트워크, 인증키의 등록 도메인, 브라우저 콘텐츠 보안 정책을 확인해주세요.')),timeoutMs);
  interval=setInterval(check,pollMs);signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();else check();
 });
}

export class MetroScene extends CesiumScene {
 constructor(container,options={}){
  super(container,options);
  this.engine='waiting';this._ready=false;this._selectedEngine=null;this._activeKey='';this._starting=null;this._frame=null;this._abort=null;this._map=null;
  this.provider={imagery:'지도 엔진 선택 대기',terrain:'지형 미연결',buildings:'건물 미연결'};
 }
 get isReady(){return !this.destroyed&&this._ready;}
 get canUseCesium(){return !this.destroyed&&this._selectedEngine!=='vworld'&&!(this._starting&&this.engine!=='waiting');}
 _status(level,message,extra={}){
  // Provider errors may contain an SDK URL; never copy the entered key into visible status.
  let safe=String(message||'');if(this._activeKey)safe=safe.split(this._activeKey).join('[인증키]');safe=safe.replace(/([?&](?:apiKey|key|token)=)[^&\s]+/gi,'$1[인증키]');
  if(level==='error')this._ready=false;
  super._status(level,safe,{...extra,engine:this.engine||'waiting',ready:this.isReady,canUseCesium:this.canUseCesium});
 }
 async init(){
  if(this.destroyed)return this;
  this._status('info','VWorld 인증키를 입력하거나 「Cesium으로 열기」를 선택해주세요. 지도 준비 후 실제 로그 재생이 활성화됩니다.');
  return this;
 }
 async setProviderSettings(settings={}){
  const key=String(settings.vworldKey||'').trim();
  if(this.destroyed)return false;
  if(this._selectedEngine==='cesium'){
   if(key){this._status('warning','Cesium이 활성화되어 있습니다. VWorld로 바꾸려면 페이지를 새로고침한 뒤 VWorld를 선택해주세요.');return false;}
   return super.setProviderSettings(settings);
  }
  if(this._selectedEngine==='vworld'&&this.viewer){
   if(!this.isReady){this._status('warning','VWorld 렌더링이 중단되었습니다. 페이지를 새로고침한 뒤 지도 엔진을 다시 선택해주세요.');return false;}
   if(key&&key!==this._activeKey){this._status('warning','활성화된 VWorld 인증키를 바꾸려면 페이지를 새로고침해주세요.');return false;}
   this._setVWorldBuildings(settings.buildings);return true;
  }
  if(this._starting)return this._starting;
  if(!key){this._status('info','VWorld 인증키를 입력해주세요. 키 없이 실행하려면 「Cesium으로 열기」를 선택할 수 있습니다.');return false;}
  if(!/^https?:$/.test(location.protocol)){this._status('error','VWorld는 HTTP(S) 주소로 실행해주세요. 제공된 로컬 서버로 열고, 해당 주소를 인증키의 허용 도메인에 등록해야 합니다.');return false;}
  this._selectedEngine='vworld';this.engine='vworld';this._ready=false;this._activeKey=key;
  const operation=this._startVWorld(key,settings);
  this._starting=operation;
  try{return await operation;}finally{this._starting=null;}
 }
 async _startVWorld(key,settings){
  this._abort=new AbortController();
  this.provider={imagery:'VWorld SDK 연결 중',terrain:'지형 준비 대기',buildings:'건물 준비 대기'};
  this._status('info','VWorld SDK를 연결하는 중입니다. 지도 준비 전에는 차량을 재생하지 않습니다.');
  try{
   const frame=document.createElement('iframe');frame.title='VWorld 3D 강내면 지도';frame.className='metro-vworld-frame';frame.setAttribute('allow','fullscreen');
   Object.assign(frame.style,{position:'absolute',inset:'0',width:'100%',height:'100%',border:'0',display:'block',background:'#102c34'});
   // A real same-origin document preserves the registered hostname and the SDK's parser loading.
   // The key travels through a transient frame-element object, never the app/helper URL.
   frame.__metroVWorldBootstrap={apiKey:key};
   frame.src=new URL('./vworld-host.html',import.meta.url).href;
   this._frame=frame;this.host.replaceChildren(frame);
   const scope=frame.contentWindow;
   if(!scope)throw failure('VWORLD_FRAME','VWorld 지도 프레임을 만들 수 없습니다.');
   await waitForSDK(scope,{signal:this._abort.signal});
   if(this.destroyed)throw failure('VWORLD_CANCELLED','지도가 종료되었습니다.');
   this.provider.imagery='VWorld 지도 생성 중';this._status('info','SDK가 준비되었습니다. VWorld 지도 viewer를 기다리는 중입니다.');
   const depot=this.network?.nodes?.[this.network?.depot];
   const lon=Number.isFinite(Number(depot?.lon))?Number(depot.lon):127.3616417,lat=Number.isFinite(Number(depot?.lat))?Number(depot.lat):36.6237876;
   const vw=scope.vw;
   const result=await waitForVWorldViewer(scope,{signal:this._abort.signal,start:()=>{
    this._map=new vw.Map();
    this._map.setOption({mapId:'vmap',initPosition:new vw.CameraPosition(new vw.CoordZ(lon,lat,2400),new vw.Direction(0,-55,0)),logo:true,navigation:false});
    return this._map.start();
   }});
   if(this.destroyed)throw failure('VWORLD_CANCELLED','지도가 종료되었습니다.');
   await super.initExternalViewer(result.viewer,result.Cesium,{ownsViewer:true});
   this._watchVWorldProviders();this._setVWorldBuildings(settings.buildings);this._ready=true;
   this.provider.imagery='VWorld 제공 지도 · 타일별 로딩 상태';
   this._status('ready','VWorld viewer가 준비되었습니다. 차량·승객·물류는 실행 로그를 재생하며, 실제 지도 타일과 건물 범위는 VWorld 응답에 따릅니다.');
   return true;
  }catch(error){
   this._ready=false;this._clearVWorldFrame();this._selectedEngine=null;this.engine='waiting';
   this.provider={imagery:'VWorld 연결 실패',terrain:'지형 미연결',buildings:'건물 미연결'};
   if(!this.destroyed)this._status('error',`${error.code?error.message:'VWorld 장면 연결 중 오류가 발생했습니다. 브라우저 콘솔과 SDK 호환성을 확인해주세요.'} 다시 연결하거나 「Cesium으로 열기」를 선택할 수 있습니다.`,{code:error.code||'VWORLD_BIND_FAILED',canUseCesium:true});
   this._activeKey='';return false;
  }
 }
 _watchVWorldProviders(){
  const v=this.viewer,C=this.C;
  const updateTerrain=()=>{
   if(this.destroyed||!this.viewer)return;
   const provider=v.terrainProvider||v.scene.globe.terrainProvider;
   if(provider!==this._externalTerrainProvider){this._externalTerrainProvider=provider;this._terrainRevision++;this.terrainHeights.clear();this.heightRequests.clear();}
   this.hasTerrain=!!provider&&!(C.EllipsoidTerrainProvider&&provider instanceof C.EllipsoidTerrainProvider);
   this.provider.terrain=this.hasTerrain?(this.terrainPresentation?.reliefApplied?'VWorld 지형 · 높낮이 90% 시각 보정':'VWorld 지형 · 상세 표현 / 원고도 유지'):'타원체 기준 높이 · 지형 공급원 미확인';
   if(this.isReady)this._status('info','VWorld 지형 공급원 상태가 갱신되었습니다.');
  };
  updateTerrain();
  this._removeVWorldTerrainChanged=v.scene.globe.terrainProviderChanged?.addEventListener(updateTerrain);
  let reported=false;
  const imageryLayers=v.imageryLayers;
  const listenLayer=layer=>{
   const provider=layer?.imageryProvider;
   const remove=provider?.errorEvent?.addEventListener(()=>{if(reported||this.destroyed)return;reported=true;this.provider.imagery='VWorld 지도 타일 연결 오류';this._status('warning','VWorld 지도 타일을 읽지 못했습니다. SDK 초기화 성공과 타일·건물 제공 여부는 별도이며, 네트워크와 인증키 도메인 설정을 확인해주세요.');});
   if(typeof remove==='function')(this._providerRemovers??=[]).push(remove);
  };
  for(let i=0;i<(imageryLayers?.length||0);i++)listenLayer(imageryLayers.get(i));
  const removeLayerAdded=imageryLayers?.layerAdded?.addEventListener(listenLayer);
  if(typeof removeLayerAdded==='function')(this._providerRemovers??=[]).push(removeLayerAdded);
 }
 _setVWorldBuildings(show){
  if(!this._map)return;
  try{
   const layer=this._map.getLayerElement?.('facility_build');
   if(layer&&show===false){layer.hide?.();this.provider.buildings='VWorld 건물 숨김';}
   else if(layer&&typeof layer.show==='function'){layer.show();this.provider.buildings='VWorld 제공 건물 · 지역별 제공 범위';}
   else this.provider.buildings='VWorld 기본 건물 · 레이어 제공 범위 미확인';
  }catch{this.provider.buildings='VWorld 건물 레이어 연결 미확인';}
  if(this.isReady)this._status('info','VWorld 건물 표시 설정을 적용했습니다.');
 }
 async useCesium(){
  if(this.destroyed)return false;
  if(this._starting){this._status('warning','지금 지도 엔진을 연결하고 있습니다. 연결 완료 또는 실패 후 다시 선택해주세요.');return false;}
  if(this._selectedEngine==='vworld'){this._status('warning','VWorld가 활성화되어 있습니다. Cesium으로 바꾸려면 페이지를 새로고침한 뒤 선택해주세요.');return false;}
  if(this._selectedEngine==='cesium')return this.isReady;
  this._selectedEngine='cesium';this.engine='cesium';this._ready=false;this.provider={imagery:'Cesium 위성지도 연결 중',terrain:'지형 준비 대기',buildings:'건물 공급원 미연결'};
  this._status('info','별도 Cesium 지도 엔진을 연결하는 중입니다.');
  const operation=super.init();this._starting=operation;
  try{
   await operation;this._ready=!!(this.viewer||this.fallback)&&!this.destroyed;
   if(this.isReady)this._status(this.fallback?'warning':'ready',this.fallback?'3D 연결 실패로 실제 도로망의 2D 대체 지도를 표시합니다.':'Cesium 지도가 준비되었습니다. VWorld와 별도 공급원의 영상·지형을 사용합니다.',{fallback:!!this.fallback});
   return this.isReady;
  }finally{this._starting=null;}
 }
 _clearVWorldFrame(){
  this._abort?.abort();this._abort=null;this._removeVWorldTerrainChanged?.();this._removeVWorldTerrainChanged=null;
  for(const remove of this._providerRemovers||[])remove();this._providerRemovers=[];
  if(this.handler&&!this.handler.isDestroyed?.())this.handler.destroy();this.handler=null;this._removeRenderError?.();this._removeRenderError=null;
  try{const owned=this.viewer||this._frame?.contentWindow?.ws3d?.viewer;if(owned?.destroy&&!owned.isDestroyed?.())owned.destroy();}catch{}
  this.viewer=null;this.C=null;this._frame?.remove();this._frame=null;this._map=null;
  this.vehicles.clear();this.serviceEntities=[];this.facilityEntities=[];this.waitingEntities=[];this.roadEntities=[];this.roadPrimitive=null;this.boundaryEntities=[];this.terrainHeights.clear();this.heightRequests.clear();
 }
 destroy(){
  this._abort?.abort();this._removeVWorldTerrainChanged?.();for(const remove of this._providerRemovers||[])remove();this._ready=false;
  super.destroy();this._frame?.remove();this._frame=null;this._activeKey='';
 }
}
export default MetroScene;
