/** MetroRookies 3D replay. Scene geometry/people/doors are illustrations; map/routes are data. */
const CESIUM_BASE = new URL('./vendor/cesium/', import.meta.url).href;
const COLORS = ['#52e0c4', '#ffb65b', '#a79bff'];
const BOUNDARY_STYLE={outline:'#f6c65b',fill:'#ffe49a',fillAlpha:.09,width:3};
// Cesium converts glTF +Z forward to local +X; our assets face -Z, so entity yaw adds 90° for north.
const MODEL_URLS = ['drt-teal.glb', 'drt-amber.glb', 'drt-purple.glb'];
const clamp = (v,a=0,b=1) => Math.max(a,Math.min(b,Number(v)||0));
const smooth = v => {const x=clamp(v);return x*x*(3-2*x);};
const ASSET = name => new URL(`./assets/${name}`, import.meta.url).href;
const finite = v => v!==null && v!==undefined && v!=='' && Number.isFinite(Number(v));
const round = (v,p=5) => Number(v).toFixed(p);
function timeout(p,ms,msg) {let timer;return Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(msg)),ms);})]).finally(()=>clearTimeout(timer));}
/** Accept Cesium's number or a provider's explicit {height} result, never a made-up elevation. */
export function readTerrainHeight(value){const height=typeof value==='number'?value:value?.height;return typeof height==='number'&&Number.isFinite(height)?height:undefined;}
let cesiumPromise;
function loadCesium() {
 if(window.Cesium)return Promise.resolve(window.Cesium);
 if(cesiumPromise)return cesiumPromise;
 window.CESIUM_BASE_URL=CESIUM_BASE;
 cesiumPromise=new Promise((resolve,reject)=>{
  if(!document.querySelector('link[data-cesium-style]')) {const css=document.createElement('link');css.rel='stylesheet';css.href=CESIUM_BASE+'Widgets/widgets.css';css.dataset.cesiumStyle='true';document.head.append(css);}
  let script=document.querySelector('script[data-metro-cesium]');
  if(!script){script=document.createElement('script');script.src=CESIUM_BASE+'Cesium.js';script.async=true;script.dataset.metroCesium='true';document.head.append(script);}
  script.addEventListener('load',()=>window.Cesium?resolve(window.Cesium):reject(new Error('Cesium 초기화 실패')),{once:true});
  script.addEventListener('error',()=>reject(new Error('Cesium 라이브러리를 불러올 수 없습니다')),{once:true});
 });
 return timeout(cesiumPromise,18000,'3D 라이브러리 응답 지연');
}
function stateCoord(state){return finite(state?.lon)&&finite(state?.lat)?[Number(state.lon),Number(state.lat)]:null;}
function offsetLonLat(lon,lat,east,north){return [lon+east/(111320*Math.cos(lat*Math.PI/180)),lat+north/111320];}
function rotateOffset(state,right,forward){
 const a=(Number(state.heading)||0)*Math.PI/180;
 return offsetLonLat(Number(state.lon),Number(state.lat),right*Math.cos(a)+forward*Math.sin(a),-right*Math.sin(a)+forward*Math.cos(a));
}

const STOP_SPACING_M = 9;
const STOP_NEAR_M = 4;

// 주행 중인 차량은 위치를 변경하지 않음
const MOVING_STATUSES = new Set([
  'mixed', 'passenger', 'parcel',
  'empty', 'return'
]);

function getStoppedDisplayPositions(states) {
  const positions = new Map();
  const groups = [];

  // 모든 차량의 원본 위치 보존
  for (const s of states) {
    positions.set(String(s.id), {
      lon: Number(s.lon),
      lat: Number(s.lat)
    });

    if (MOVING_STATUSES.has(String(s.status||'').toLowerCase())) continue;
    if (!Number.isFinite(Number(s.lon)) ||
        !Number.isFinite(Number(s.lat))) continue;

    // 가까운 정차 차량끼리 묶기
    const group = groups.find(g => {
      const a = g[0];

      const east = (s.lon - a.lon) *
        111320 * Math.cos(a.lat * Math.PI / 180);
      const north = (s.lat - a.lat) * 111320;

      return Math.hypot(east, north) < STOP_NEAR_M;
    });

    if (group) group.push(s);
    else groups.push([s]);
  }

  for (const group of groups) {
    if (group.length < 2) continue;

    group.sort((a, b) => Number(a.id) - Number(b.id));

    // 차량들이 반대 방향을 보고 있어도
    // 동일한 기준 방향으로 정차 간격 계산
    const heading = Number(group[0].heading) || 0;
    const rad = heading * Math.PI / 180;

    group.forEach((s, index) => {
      const distance =
        (index - (group.length - 1) / 2) * STOP_SPACING_M;

      const east = Math.sin(rad) * distance;
      const north = Math.cos(rad) * distance;

      positions.set(String(s.id), {
        lon: Number(s.lon) +
          east / (111320 * Math.cos(s.lat * Math.PI / 180)),
        lat: Number(s.lat) + north / 111320
      });
    });
  }

  return positions;
}
function normalizeNetwork(net){
 if(!net)return {nodes:{},roads:[],services:[]};
 if(net.type==='FeatureCollection') {
  const roads=[];for(const f of net.features||[]){const g=f.geometry;if(g?.type==='LineString')roads.push({id:f.id??f.properties?.link_id??roads.length,coordinates:g.coordinates,properties:{...(f.properties||{})}});if(g?.type==='MultiLineString')for(const c of g.coordinates)roads.push({id:f.id??f.properties?.link_id??roads.length,coordinates:c,properties:{...(f.properties||{})}});}
  return {nodes:{},roads,services:[]};
 }
 return {...net,nodes:net.nodes||{},roads:net.roads||net.links||[],services:net.services||[]};
}
/** A separate display model made only from an uploaded EPSG:4326 boundary. No network edits. */
function boundaryDisplayModel(input){
 const geojson=input?.geojson||input;
 if(geojson?.type!=='FeatureCollection'||!Array.isArray(geojson.features))throw new Error('경계는 GeoJSON FeatureCollection 형식이어야 합니다.');
 const polygons=[],lines=[];let west=Infinity,south=Infinity,east=-Infinity,north=-Infinity;
 const positions=(value,min,closed=false)=>{
  if(!Array.isArray(value)||value.length<min)throw new Error('경계의 좌표 수가 부족합니다.');
  const result=value.map(point=>{
   if(!Array.isArray(point)||typeof point[0]!=='number'||typeof point[1]!=='number'||!Number.isFinite(point[0])||!Number.isFinite(point[1])||Math.abs(point[0])>180||Math.abs(point[1])>90)throw new Error('경계 좌표는 EPSG:4326 경도·위도여야 합니다.');
   west=Math.min(west,point[0]);south=Math.min(south,point[1]);east=Math.max(east,point[0]);north=Math.max(north,point[1]);return [point[0],point[1]];
  });
  if(closed&&(result[0][0]!==result.at(-1)[0]||result[0][1]!==result.at(-1)[1]))throw new Error('경계 Polygon의 시작점과 끝점이 일치해야 합니다.');
  return result;
 };
 for(const [featureIndex,feature]of geojson.features.entries()){
  const geometry=feature?.geometry,properties=feature?.properties||{},featureId=String(feature?.id??featureIndex),name=String(properties.name||properties.NAME||properties.EMD_KOR_NM||'업로드한 행정경계');
  const polygon=rings=>{
   if(!Array.isArray(rings)||!rings.length)throw new Error('경계 Polygon의 외곽 링이 없습니다.');
   polygons.push({featureId,featureIndex,name,rings:rings.map(ring=>positions(ring,4,true))});
  };
  const line=coordinates=>lines.push({featureId,featureIndex,name,coordinates:positions(coordinates,2)});
  if(geometry?.type==='Polygon')polygon(geometry.coordinates);
  else if(geometry?.type==='MultiPolygon'){if(!Array.isArray(geometry.coordinates)||!geometry.coordinates.length)throw new Error('경계 MultiPolygon이 비어 있습니다.');geometry.coordinates.forEach(polygon);}
  else if(geometry?.type==='LineString')line(geometry.coordinates);
  else if(geometry?.type==='MultiLineString'){if(!Array.isArray(geometry.coordinates)||!geometry.coordinates.length)throw new Error('경계 MultiLineString이 비어 있습니다.');geometry.coordinates.forEach(line);}
  else throw new Error('경계에는 Polygon, MultiPolygon, LineString, MultiLineString만 사용할 수 있습니다.');
 }
 if(!polygons.length&&!lines.length)throw new Error('표시할 경계 형상이 없습니다.');
 return {geojson,polygons,lines,bounds:[west,south,east,north]};
}

/** Public Mapzen/Tilezen Terrarium DEM. RGB stores elevation metres, not rendered colors.
 * Provider docs: https://registry.opendata.aws/terrain-tiles/
 * Format: https://github.com/tilezen/joerd/blob/master/docs/formats.md
 * Display height is resampled DEM; no surveyed road deck/bridge altitude is implied.
 */
class TerrariumSource {
 constructor(){this.cache=new Map();this.pending=new Map();this.controllers=new Set();this.disposed=false;this.maxLevel=14;this.grid=65;}
 tile(x,y,z){
  const key=`${z}/${x}/${y}`;
  if(this.disposed)return undefined;
  if(this.cache.has(key)){const value=this.cache.get(key);this.cache.delete(key);this.cache.set(key,value);return Promise.resolve(value);}
  if(this.pending.has(key))return this.pending.get(key);
  if(this.pending.size>=4)return undefined;
  const ctrl=new AbortController();this.controllers.add(ctrl);const timer=setTimeout(()=>ctrl.abort(),9000);
  const promise=(async()=>{
   const response=await fetch(`https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${key}.png`,{mode:'cors',credentials:'omit',cache:'force-cache',signal:ctrl.signal});
   if(!response.ok)throw new Error(`DEM HTTP ${response.status}`);
   const blob=await response.blob();let bitmap;
   if(typeof createImageBitmap==='function')bitmap=await createImageBitmap(blob,{colorSpaceConversion:'none',premultiplyAlpha:'none'});
   else bitmap=await new Promise((resolve,reject)=>{const url=URL.createObjectURL(blob),img=new Image();img.onload=()=>{URL.revokeObjectURL(url);resolve(img);};img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('DEM PNG decode failed'));};img.src=url;});
   const width=bitmap.width||bitmap.naturalWidth,height=bitmap.height||bitmap.naturalHeight;
   if(width!==256||height!==256){bitmap.close?.();throw new Error('Unexpected DEM tile size');}
   const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(bitmap,0,0);bitmap.close?.();
   const rgba=context.getImageData(0,0,width,height).data,heights=new Float32Array(width*height);
   for(let i=0,j=0;i<heights.length;i++,j+=4){const value=rgba[j]*256+rgba[j+1]+rgba[j+2]/256-32768;if(!rgba[j+3]||value< -12000||value>9000)throw new Error('DEM contains missing/invalid elevation');heights[i]=value;}
   if(!this.disposed){this.cache.set(key,heights);while(this.cache.size>64)this.cache.delete(this.cache.keys().next().value);}
   return heights;
  })().finally(()=>{clearTimeout(timer);this.controllers.delete(ctrl);this.pending.delete(key);});
  this.pending.set(key,promise);return promise;
 }
 resample(heights,x,y,level){
  const sourceLevel=Math.min(level,this.maxLevel),factor=2**(level-sourceLevel),ox=(x%factor)*256/factor,oy=(y%factor)*256/factor,span=256/factor,n=this.grid,result=new Float32Array(n*n);
  // Pixel-center sampling with edge clamping; Cesium terrain skirts conceal tile-edge gaps.
  for(let row=0;row<n;row++)for(let col=0;col<n;col++){
   const px=clamp(ox+col/(n-1)*span-.5,0,255),py=clamp(oy+row/(n-1)*span-.5,0,255),x0=Math.floor(px),y0=Math.floor(py),x1=Math.min(255,x0+1),y1=Math.min(255,y0+1),fx=px-x0,fy=py-y0;
   result[row*n+col]=(heights[y0*256+x0]*(1-fx)+heights[y0*256+x1]*fx)*(1-fy)+(heights[y1*256+x0]*(1-fx)+heights[y1*256+x1]*fx)*fy;
  }
  return result;
 }
 geometry(x,y,level){const z=Math.min(level,this.maxLevel),factor=2**(level-z),promise=this.tile(Math.floor(x/factor),Math.floor(y/factor),z);return promise?.then(heights=>this.resample(heights,x,y,level));}
 probe(lon,lat){const z=12,n=2**z,x=Math.floor((lon+180)/360*n),y=Math.floor((1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*n);return this.tile(x,y,z);}
 dispose(){this.disposed=true;for(const ctrl of this.controllers)ctrl.abort();this.cache.clear();}
}

export class MetroScene {
 constructor(container,{onSelect=()=>{},onStatus=()=>{}}={}) {
  this.container=typeof container==='string'?document.querySelector(container):container;
  if(!this.container)throw new Error('지도 컨테이너가 없습니다');
  this.onSelect=onSelect;this.onStatus=onStatus;this.viewer=null;this.C=null;this._ownsViewer=true;this._terrainRevision=0;this.terrainKind='ellipsoid';this.mode='overview';this.selected=1;this.states=[];this.network=null;
  this.waiting=[];this.waitingGroups=[];this.waitingEntities=[];this._waitingSig='';this.layers={roads:true,stops:true,hubs:true,routes:true};this.vehicles=new Map();this.serviceEntities=[];this.roadEntities=[];this.terrainHeights=new Map();this.heightRequests=new Set();this.provider={imagery:'위성영상 연결 중',terrain:'타원체 기준 높이',buildings:'건물 공급원 미연결'};this.destroyed=false;this.statusMessage='';this._statusAt=0;this.boundary=null;this.boundaryEntities=[];this.boundaryOptions={visible:true,fill:true};this._boundaryGeneration=0;this._boundaryZoomPending=false;this._fallbackViewBounds=null;
  if(getComputedStyle(this.container).position==='static')this.container.style.position='relative';this.container.style.minHeight='200px';this.container.style.background='#102c34';
  this.host=document.createElement('div');Object.assign(this.host.style,{position:'absolute',inset:'0'});this.host.className='metro-cesium-host';this.container.append(this.host);
  this.caption=document.createElement('div');this.caption.className='metro-map-caption';Object.assign(this.caption.style,{position:'absolute',bottom:'30px',left:'12px',zIndex:'3',maxWidth:'calc(100% - 24px)',background:'rgba(9,25,35,.84)',color:'#d5e3e9',padding:'7px 10px',border:'1px solid rgba(153,195,209,.2)',borderRadius:'8px',font:'12px/1.5 system-ui,sans-serif',pointerEvents:'none'});this.container.append(this.caption);
  this._resizeObserver=new ResizeObserver(()=>this.resize());this._resizeObserver.observe(this.container);
 }
 _status(level,message,extra={}){this.statusMessage=message;this.caption.textContent=`${this.provider.imagery} · ${this.provider.terrain}${this.buildings?' · 실제 OSM 건물':''}`;this.onStatus({level,message,...this.provider,...extra});}
 async init(){
  try {
   this.C=await loadCesium();if(this.destroyed)return this;const C=this.C;
   C.Ion.defaultAccessToken='';
   this.viewer=new C.Viewer(this.host,{animation:false,timeline:false,baseLayerPicker:false,geocoder:false,homeButton:false,sceneModePicker:false,navigationHelpButton:false,fullscreenButton:false,vrButton:false,infoBox:false,selectionIndicator:false,baseLayer:false,terrainProvider:new C.EllipsoidTerrainProvider(),shouldAnimate:false,requestRenderMode:true,maximumRenderTimeChange:Infinity,contextOptions:{webgl:{alpha:false,antialias:true,preserveDrawingBuffer:false}},shadows:false});
   this._bindViewer({preserveEnvironment:false});
   this._createImagery();
   this.setCamera('overview');if(this.network)this._drawNetwork();if(this.states.length)this.update(this.states,this.time);this._drawWaiting();this._drawBoundary();
   this._status('ready','3D 지도가 준비되었습니다. 차량과 인물 모델은 시각적 재현입니다.');this._enablePublicTerrain();
  } catch(error){
   this.viewer?.destroy();this.viewer=null;this._initFallback();this.provider={imagery:'도로 벡터 대체 화면',terrain:'2D · 높이 미표현',buildings:'미표현'};this._status('warning',`${error.message}. 실제 도로망의 2D 대체 화면을 표시합니다.`,{fallback:true});
  }
  return this;
 }
 /** Attach rendering to the Cesium viewer made by VWorld. Its imagery/terrain stay intact. */
 async initExternalViewer(viewer,Cesium,{ownsViewer=false,provider={}}={}){
  if(this.destroyed)throw new Error('이미 종료된 지도입니다');
  if(this.viewer&&this.viewer!==viewer)throw new Error('지도 엔진을 바꾸려면 페이지를 새로고침해주세요');
  if(!viewer?.scene?.globe||!viewer?.entities?.add||!viewer?.camera||!Cesium?.Cartesian3||!Cesium?.CallbackProperty)throw new Error('VWorld의 Cesium viewer 인터페이스를 확인할 수 없습니다');
  this.C=Cesium;this.viewer=viewer;this._ownsViewer=ownsViewer;this._terrainRevision++;this.publicTerrainSource?.dispose();this.terrainHeights.clear();this.heightRequests.clear();
  this.terrainKind='external';const terrain=viewer.terrainProvider||viewer.scene.globe.terrainProvider;
  this.hasTerrain=!!terrain&&!(Cesium.EllipsoidTerrainProvider&&terrain instanceof Cesium.EllipsoidTerrainProvider);
  this.provider={imagery:'VWorld 기본 지도 · 타일 연결 상태 확인 중',terrain:this.hasTerrain?'VWorld 제공 지형 · 높이 로딩 중':'타원체 기준 높이 · 지형 공급원 미확인',buildings:'VWorld 제공 건물 · 지역별 제공 범위',...provider};
  this._bindViewer({preserveEnvironment:true});
  this.setCamera('overview');if(this.network)this._drawNetwork();if(this.states.length)this.update(this.states,this.time);this._drawWaiting();this._drawBoundary();
  this._status('ready','VWorld viewer를 연결했습니다. 타일·지형·건물 제공 범위와 실제 고도는 공급원 로딩 상태에 따릅니다.');
  return this;
 }
 _bindViewer({preserveEnvironment=false}={}){
  const C=this.C,v=this.viewer;
  if(!preserveEnvironment){v.scene.globe.baseColor=C.Color.fromCssColorString('#163f45');v.scene.backgroundColor=C.Color.fromCssColorString('#081321');v.scene.globe.enableLighting=false;v.scene.fog.enabled=false;v.scene.highDynamicRange=false;v.scene.light=new C.DirectionalLight({direction:new C.Cartesian3(-.3,.3,-.8),intensity:2});}
  v.scene.globe.depthTestAgainstTerrain=false;v.resolutionScale=Math.min(window.devicePixelRatio||1,1.5);
  if(v.scene.screenSpaceCameraController){v.scene.screenSpaceCameraController.minimumZoomDistance=2;v.scene.screenSpaceCameraController.maximumZoomDistance=120000;}
  if(v.clock){v.clock.shouldAnimate=false;v.clock.currentTime=C.JulianDate.fromIso8601('2023-11-06T03:00:00Z');}
  this.handler?.destroy();this.handler=new C.ScreenSpaceEventHandler(v.scene.canvas);
  this.handler.setInputAction(click=>{const pick=v.scene.pick(click.position);const id=pick?.id?.properties?.metroVehicle?.getValue?.()??pick?.id?.metroVehicle;if(id!=null){this.selected=String(id);this.onSelect(id);}},C.ScreenSpaceEventType.LEFT_CLICK);
  this.handler.setInputAction(()=>{if(this.mode==='overview')return;this.mode='manual';v.camera.lookAtTransform(C.Matrix4.IDENTITY);},C.ScreenSpaceEventType.LEFT_DOWN);
  this._removeRenderError?.();this._removeRenderError=v.scene.renderError?.addEventListener((scene,error)=>{this._status('error','3D 렌더링 오류: '+(error?.message||'WebGL 상태를 확인해주세요'));});
 }
 _createImagery(){
  const C=this.C,v=this.viewer;
  try{
   const provider=new C.UrlTemplateImageryProvider({url:'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',maximumLevel:19,credit:'Esri, Maxar, Earthstar Geographics, and the GIS User Community'});
   this.imageryLayer=v.imageryLayers.addImageryProvider(provider);this.imageryLayer.brightness=.76;this.imageryLayer.contrast=1.12;this.imageryLayer.saturation=.7;
   this.provider.imagery='Esri 실제 위성영상';let errors=0;provider.errorEvent.addEventListener(()=>{errors++;if(errors===4){this.provider.imagery='위성영상 연결 불안정';this._status('warning','위성영상 타일을 불러오지 못했습니다. 도로와 차량 재생은 계속됩니다.');}});
  }catch(e){this.provider.imagery='위성영상 연결 실패';this._status('warning','영상 공급원 연결 실패. 실제 도로 벡터를 표시합니다.');}
 }
 /** Accept a GeoJSON collection or validator result {geojson,bounds,...}; geometry stays independent. */
 setBoundary(input,{visible=true,fill=true,zoom=false}={}){
  // The validator's explicit empty startup model means no supplied boundary, not a demo shape.
  if(input?.empty===true&&input.geojson?.type==='FeatureCollection'&&input.geojson.features?.length===0){this.clearBoundary();return null;}
  const next=boundaryDisplayModel(input),previous=this.boundary,previousOptions=this.boundaryOptions;
  this.boundary=next;this.boundaryOptions={visible:!!visible,fill:!!fill};
  try{if(this.viewer)this._drawBoundary();if(this.fallback)this._drawFallback();}
  catch(error){this.boundary=previous;this.boundaryOptions=previousOptions;throw error;}
  if(zoom)this.zoomBoundary();return this.boundary;
 }
 clearBoundary(){
  this.boundary=null;this._boundaryZoomPending=false;this._fallbackViewBounds=null;
  this._removeBoundaryEntities();if(this.viewer)this.viewer.scene.requestRender();if(this.fallback)this._drawFallback();
 }
 setBoundaryOptions(options={}){
  if('visible'in options)this.boundaryOptions.visible=!!options.visible;if('fill'in options)this.boundaryOptions.fill=!!options.fill;
  for(const entity of this.boundaryEntities)entity.show=this.boundaryOptions.visible&&(entity.metroBoundaryKind!=='fill'||this.boundaryOptions.fill);
  if(this.viewer)this.viewer.scene.requestRender();if(this.fallback)this._drawFallback();return {...this.boundaryOptions};
 }
 _removeBoundaryEntities(){
  if(this.viewer&&!this.viewer.isDestroyed?.())for(const entity of this.boundaryEntities)this.viewer.entities.remove(entity);
  this.boundaryEntities=[];
 }
 _drawBoundary(){
  const C=this.C,v=this.viewer;if(!v)return;
  if(!this.boundary){this._removeBoundaryEntities();return;}
  const added=[],prefix=`metro-boundary-${++this._boundaryGeneration}-`,color=C.Color.fromCssColorString(BOUNDARY_STYLE.outline),classificationType=C.ClassificationType?.TERRAIN;
  const positions=coordinates=>C.Cartesian3.fromDegreesArray(coordinates.flatMap(point=>[point[0],point[1]]));
  const add=(options,kind)=>{const entity=v.entities.add({...options,show:this.boundaryOptions.visible&&(kind!=='fill'||this.boundaryOptions.fill)});entity.metroBoundaryKind=kind;added.push(entity);};
  const outline=(coordinates,id,part)=>add({id:prefix+id,name:part.name,properties:{metroBoundary:true,boundaryFeatureId:part.featureId},polyline:{positions:positions(coordinates),width:BOUNDARY_STYLE.width,material:color,clampToGround:true,classificationType,zIndex:2}},'outline');
  try{
   for(const [index,part]of this.boundary.polygons.entries()){
    if(typeof C.PolygonHierarchy!=='function')throw new Error('현재 지도 SDK가 Polygon 경계의 구멍 구조를 지원하지 않습니다.');
    const hierarchy=new C.PolygonHierarchy(positions(part.rings[0]),part.rings.slice(1).map(ring=>new C.PolygonHierarchy(positions(ring))));
    add({id:prefix+'polygon-'+index,name:part.name,properties:{metroBoundary:true,boundaryFeatureId:part.featureId},polygon:{hierarchy,material:C.Color.fromCssColorString(BOUNDARY_STYLE.fill).withAlpha(BOUNDARY_STYLE.fillAlpha),heightReference:C.HeightReference.CLAMP_TO_GROUND,perPositionHeight:false,outline:false,classificationType,zIndex:-10}},'fill');
    part.rings.forEach((ring,ringIndex)=>outline(ring,`polygon-${index}-ring-${ringIndex}`,part));
   }
   this.boundary.lines.forEach((part,index)=>outline(part.coordinates,'line-'+index,part));
  }catch(error){for(const entity of added)v.entities.remove(entity);throw error;}
  this._removeBoundaryEntities();this.boundaryEntities=added;v.scene.requestRender();
  if(this._boundaryZoomPending)this.zoomBoundary();
 }
 zoomBoundary({duration=.8}={}){
  if(!this.boundary)return false;
  const bounds=this.boundary.bounds,padX=Math.max((bounds[2]-bounds[0])*.08,.0005),padY=Math.max((bounds[3]-bounds[1])*.08,.0005),viewBounds=[Math.max(-180,bounds[0]-padX),Math.max(-90,bounds[1]-padY),Math.min(180,bounds[2]+padX),Math.min(90,bounds[3]+padY)];
  if(!this.viewer&&!this.fallback){this._boundaryZoomPending=true;return true;}
  this._boundaryZoomPending=false;this.mode='manual';
  if(this.fallback){this._fallbackViewBounds=viewBounds;this._drawFallback();return true;}
  const C=this.C,v=this.viewer;v.trackedEntity=undefined;v.camera.lookAtTransform(C.Matrix4.IDENTITY);
  v.camera.flyTo({destination:C.Rectangle.fromDegrees(...viewBounds),orientation:{heading:0,pitch:-Math.PI/2,roll:0},duration:Math.max(0,Number(duration)||0)});v.scene.requestRender();return true;
 }
 _drawBoundaryFallback(ctx,project,phase){
  if(!this.boundary||!this.boundaryOptions.visible)return;
  const path=coordinates=>{coordinates.forEach((point,index)=>{const p=project(point);index?ctx.lineTo(...p):ctx.moveTo(...p);});};
  ctx.save();
  if(phase==='fill'&&this.boundaryOptions.fill){ctx.fillStyle='rgba(255,228,154,0.09)';for(const part of this.boundary.polygons){ctx.beginPath();for(const ring of part.rings){path(ring);ctx.closePath();}ctx.fill('evenodd');}}
  if(phase==='outline'){
   ctx.strokeStyle=BOUNDARY_STYLE.outline;ctx.lineWidth=BOUNDARY_STYLE.width;ctx.lineJoin='round';ctx.lineCap='round';
   for(const part of this.boundary.polygons)for(const ring of part.rings){ctx.beginPath();path(ring);ctx.closePath();ctx.stroke();}
   for(const part of this.boundary.lines){ctx.beginPath();path(part.coordinates);ctx.stroke();}
  }
  ctx.restore();
 }
 setNetwork(network){this.network=normalizeNetwork(network);this._bounds=this._networkBounds();if(this.viewer)this._drawNetwork();if(this.fallback)this._drawFallback();}
 _networkBounds(){
  let west=Infinity,south=Infinity,east=-Infinity,north=-Infinity;
  for(const r of this.network?.roads||[])for(const p of r.coordinates||[]){if(!finite(p[0])||!finite(p[1]))continue;west=Math.min(west,p[0]);east=Math.max(east,p[0]);south=Math.min(south,p[1]);north=Math.max(north,p[1]);}
  if(!finite(west)||east-west>.6||north-south>.6)return [127.315,36.575,127.435,36.685];
  return [west,south,east,north];
 }
 _drawNetwork(){
  const C=this.C,v=this.viewer;if(!v)return;
  if(this.roadPrimitive){v.scene.groundPrimitives.remove(this.roadPrimitive);this.roadPrimitive=null;}
  for(const entity of this.serviceEntities)v.entities.remove(entity);this.serviceEntities=[];
  for(const entity of this.roadEntities)v.entities.remove(entity);this.roadEntities=[];
  const batch=!!(C.GroundPolylineGeometry&&C.GroundPolylinePrimitive&&v.scene.groundPrimitives),instances=[];
  for(const [index,road] of this.network.roads.entries()){
   const coords=road.coordinates;if(!Array.isArray(coords)||coords.length<2||coords.some(c=>!finite(c?.[0])||!finite(c?.[1])))continue;
   const positions=C.Cartesian3.fromDegreesArray(coords.flatMap(c=>[Number(c[0]),Number(c[1])]));
   if(batch){try{instances.push(new C.GeometryInstance({geometry:new C.GroundPolylineGeometry({positions,width:1.5}),id:`road-${road.id}-${index}`}));}catch{}}
   else this.roadEntities.push(v.entities.add({id:`road-${road.id}-${index}`,properties:{linkId:String(road.id)},polyline:{positions,width:1.5,clampToGround:true,material:C.Color.fromCssColorString('#58b9c4').withAlpha(.48)},show:!!this.layers.roads}));
  }
  if(instances.length)this.roadPrimitive=v.scene.groundPrimitives.add(new C.GroundPolylinePrimitive({geometryInstances:instances,appearance:new C.PolylineMaterialAppearance({material:C.Material.fromType('Color',{color:C.Color.fromCssColorString('#58b9c4').withAlpha(.48)})}),asynchronous:true,show:!!this.layers.roads}));
  const serviceIds=this.network.services.length?this.network.services:Object.keys(this.network.nodes).filter(id=>!/^ROAD_/i.test(id));
  for(const id of serviceIds){const n=this.network.nodes[id];if(!n||!finite(n.lon)||!finite(n.lat))continue;const kind=String(n.kind||id).toLowerCase();const depot=id===this.network.depot||kind==='depot';const hub=!depot&&(kind.includes('hub')||/^HUB_/.test(id));const stop=!depot&&!hub;const color=depot?'#ffcd79':hub?'#eaa66f':'#84cfdd';const entity=v.entities.add({id:'service-'+id,name:n.label||id,position:C.Cartesian3.fromDegrees(n.lon,n.lat,0),point:{pixelSize:depot?11:hub?5:4,color:C.Color.fromCssColorString(color),outlineColor:C.Color.fromCssColorString('#122431'),outlineWidth:1,heightReference:C.HeightReference.CLAMP_TO_GROUND,disableDepthTestDistance:Infinity},label:depot?{text:'강내우체국 · DEPOT',font:'bold 14px sans-serif',fillColor:C.Color.fromCssColorString('#ffe0a6'),style:C.LabelStyle.FILL_AND_OUTLINE,outlineColor:C.Color.BLACK,outlineWidth:3,pixelOffset:new C.Cartesian2(0,-23),heightReference:C.HeightReference.CLAMP_TO_GROUND,disableDepthTestDistance:Infinity}:undefined,show:depot||hub&&this.layers.hubs||stop&&this.layers.stops});entity.metroKind=depot?'depot':hub?'hub':'stop';this.serviceEntities.push(entity);}
  if(this.mode==='overview')this.setCamera('overview');v.scene.requestRender();
 }
 _newVehicle(id,index){
  const C=this.C,v=this.viewer;const color=C.Color.fromCssColorString(COLORS[index%3]);
  const rec={id,index,state:null,door:0,hatch:0,pax:0,cargo:0,walk:0,animVisible:false,parcelVisible:false,routeSig:null,bodyHeight:0};
  const trs=(translation,rotation,scale)=>new C.TranslationRotationScale(translation||C.Cartesian3.ZERO,rotation||C.Quaternion.IDENTITY,scale||new C.Cartesian3(1,1,1));
  const nodes={DOOR:new C.CallbackProperty(()=>trs(new C.Cartesian3(rec.door*.18,0,rec.door*1.08)),false),HATCH:new C.CallbackProperty(()=>trs(null,C.Quaternion.fromAxisAngle(C.Cartesian3.UNIT_X,-rec.hatch*1.28)),false),ROOF:new C.CallbackProperty(()=>{const size=this.mode==='interior'&&String(this.selected)===String(id)?0:1;return trs(null,null,new C.Cartesian3(size,size,size));},false)};
  for(let i=0;i<11;i++)nodes[`PAX_${i}`]=new C.CallbackProperty(()=>trs(null,null,new C.Cartesian3(i<rec.pax?1:0,i<rec.pax?1:0,i<rec.pax?1:0)),false);
  for(let i=0;i<8;i++)nodes[`CARGO_${i}`]=new C.CallbackProperty(()=>trs(null,null,new C.Cartesian3(i<rec.cargo?1:0,i<rec.cargo?1:0,i<rec.cargo?1:0)),false);
  rec.entity=v.entities.add({id:'vehicle-'+id,name:'DRT '+id,properties:{metroVehicle:id},position:C.Cartesian3.fromDegrees(127.36,36.62,0),model:{uri:ASSET(MODEL_URLS[index%3]),minimumPixelSize:34,maximumScale:36,scale:1,runAnimations:false,heightReference:C.HeightReference.RELATIVE_TO_GROUND,nodeTransformations:nodes,silhouetteColor:color,silhouetteSize:1.3,imageBasedLightingFactor:new C.Cartesian2(.8,.5),lightColor:new C.Cartesian3(1.4,1.4,1.4)},label:{text:'DRT '+id,font:'bold 13px sans-serif',fillColor:color,showBackground:true,backgroundColor:C.Color.fromCssColorString('#081d29').withAlpha(.88),backgroundPadding:new C.Cartesian2(7,5),pixelOffset:new C.Cartesian2(0,-33),verticalOrigin:C.VerticalOrigin.BOTTOM,heightReference:C.HeightReference.RELATIVE_TO_GROUND,disableDepthTestDistance:Infinity},viewFrom:new C.Cartesian3(0,-40,25)});
  rec.route=v.entities.add({id:'route-'+id,polyline:{positions:[],width:4,clampToGround:true,material:new C.PolylineGlowMaterialProperty({glowPower:.12,taperPower:1,color:color.withAlpha(.92)})},show:false});
  const walkNodes={};for(const [node,phase] of [['ARM_L',0],['ARM_R',Math.PI],['LEG_L',Math.PI],['LEG_R',0]])walkNodes[node]=new C.CallbackProperty(()=>trs(null,C.Quaternion.fromAxisAngle(C.Cartesian3.UNIT_X,Math.sin(rec.walk+phase)*.5)),false);
  rec.person=v.entities.add({id:'person-'+id,position:C.Cartesian3.fromDegrees(127.36,36.62,0),show:false,model:{uri:ASSET('passenger.glb'),scale:1,minimumPixelSize:0,heightReference:C.HeightReference.RELATIVE_TO_GROUND,nodeTransformations:walkNodes,runAnimations:false}});
  rec.parcel=v.entities.add({id:'parcel-'+id,position:C.Cartesian3.fromDegrees(127.36,36.62,0),show:false,model:{uri:ASSET('parcel.glb'),scale:1.1,minimumPixelSize:0,heightReference:C.HeightReference.RELATIVE_TO_GROUND}});
  rec.serviceLabel=v.entities.add({id:'operation-'+id,position:C.Cartesian3.fromDegrees(127.36,36.62,3.4),show:false,label:{text:'',font:'bold 14px sans-serif',fillColor:C.Color.WHITE,showBackground:true,backgroundColor:color.withAlpha(.8),backgroundPadding:new C.Cartesian2(9,6),pixelOffset:new C.Cartesian2(0,-55),heightReference:C.HeightReference.RELATIVE_TO_GROUND,disableDepthTestDistance:Infinity}});
  this.vehicles.set(String(id),rec);return rec;
 }
 update(states,time){
  this.states=states||[];this.time=Number(time)||0;if(this.fallback){this._drawFallback();return;}if(!this.viewer)return;
  const C=this.C,v=this.viewer;const present=new Set();
  const displayPositions=getStoppedDisplayPositions(this.states);
  this.states.forEach((s,index)=>{
   const display=displayPositions.get(String(s.id));
   const xy=display?[display.lon,display.lat]:stateCoord(s);
   if(!xy)return;const key=String(s.id);present.add(key);const rec=this.vehicles.get(key)||this._newVehicle(s.id,index);rec.state=s;
   const p=C.Cartesian3.fromDegrees(xy[0],xy[1],.08);const orientation=C.Transforms.headingPitchRollQuaternion(p,new C.HeadingPitchRoll(C.Math.toRadians((Number(s.heading)||0)+90),0,0));rec.entity.position=p;rec.entity.orientation=orientation;rec.entity.show=true;rec.entity.model.silhouetteSize=s.selected?2.3:.9;rec.entity.label.text=`DRT ${s.id} · ${Math.max(0,s.passengers||0)}명 / ${Math.max(0,s.cargo||0)}개`;rec.entity.label.scale=s.selected?1.05:.9;
   rec.pax=clamp(s.passengers,0,11);rec.cargo=clamp(s.cargo,0,8);rec.door=0;rec.hatch=0;rec.person.show=false;rec.parcel.show=false;rec.serviceLabel.show=false;
   const anim=s.animation;const kind=anim?.kind;const ap=clamp(anim?.progress);const isPassenger=kind==='boarding'||kind==='alighting';const isCargo=kind==='loading'||kind==='delivery';
   if((isPassenger||isCargo)&&s.status!=='PARK_SEARCH'){
    const open=Math.min(smooth(ap/.15),smooth((1-ap)/.15));if(isPassenger)rec.door=open;else rec.hatch=open;
    const action=smooth((ap-.15)/.7);const outbound=kind==='alighting'||kind==='delivery';const fraction=outbound?action:1-action;
    if(isPassenger){
     const right=1.35+fraction*3.8,forward=.77+Math.sin(fraction*Math.PI)*.45;const pos=rotateOffset({...s,lon:xy[0],lat:xy[1]},right,forward);rec.person.position=C.Cartesian3.fromDegrees(...pos,.06);const personHeading=(Number(s.heading)||0)+(outbound?90:270);rec.person.orientation=C.Transforms.headingPitchRollQuaternion(C.Cartesian3.fromDegrees(...pos),new C.HeadingPitchRoll(C.Math.toRadians(personHeading+90),0,0));rec.person.show=ap>.1&&ap<.91;rec.walk=action*Math.PI*10;
    }else{
     const pos=rotateOffset({...s,lon:xy[0],lat:xy[1]},-.25,-(2.2+fraction*2.6));rec.parcel.position=C.Cartesian3.fromDegrees(...pos,1.1+Math.sin(action*Math.PI)*.25);rec.parcel.orientation=orientation;rec.parcel.show=ap>.1&&ap<.92;
    }
    rec.serviceLabel.position=C.Cartesian3.fromDegrees(xy[0],xy[1],3.6);rec.serviceLabel.label.text=({boarding:'승객 탑승',alighting:'승객 하차',loading:'물류 적재',delivery:'물류 배송'})[kind]+(anim.quantity?` · ${anim.quantity}`:'');rec.serviceLabel.show=String(s.id)===String(this.selected)||s.selected;
   }
   const route=s.route;const sig=Array.isArray(route)&&route.length>1?`${s.event?.id||s.event?.index||''}|${route.length}|${round(route[0][0])},${round(route[0][1])}|${round(route.at(-1)[0])},${round(route.at(-1)[1])}`:'';
   if(sig!==rec.routeSig){rec.routeSig=sig;rec.route.polyline.positions=sig?C.Cartesian3.fromDegreesArray(route.flatMap(p=>[p[0],p[1]])):[];}
   rec.route.show=!!sig&&this.layers.routes&&(s.selected||String(s.id)===String(this.selected));
   if(this.hasTerrain)this._requestHeight(xy[0],xy[1]);
  });
  for(const [key,rec]of this.vehicles)if(!present.has(key)){rec.entity.show=false;rec.route.show=false;rec.person.show=false;rec.parcel.show=false;rec.serviceLabel.show=false;}
  this._updateCamera();v.scene.requestRender();
 }
 setWaitingPassengers(passengers=[]){
  // Coordinates remain the canonical service point; model offsets below are visual staging only.
  const rows=passengers.filter(p=>p&&p.id!=null&&finite(p.lon)&&finite(p.lat)).map(p=>({...p,lon:Number(p.lon),lat:Number(p.lat)})).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  const signature=rows.map(p=>`${p.id}@${round(p.lon,6)},${round(p.lat,6)}`).join('|');
  if(signature===this._waitingSig)return;
  this._waitingSig=signature;this.waiting=rows;
  const grouped=new Map();for(const p of rows){const key=round(p.lon,6)+','+round(p.lat,6);if(!grouped.has(key))grouped.set(key,{key,lon:p.lon,lat:p.lat,people:[]});grouped.get(key).people.push(p);}
  this.waitingGroups=[...grouped.values()];this._drawWaiting();if(this.fallback)this._drawFallback();
 }
 _drawWaiting(){
  const C=this.C,v=this.viewer;if(!v)return;
  for(const e of this.waitingEntities)v.entities.remove(e);this.waitingEntities=[];
  for(const group of this.waitingGroups){
   const people=group.people.slice(0,6); // Six visible representatives per point; label reports the full logged count.
   people.forEach((person,i)=>{
    const east=1.6+(i%3)*.62,north=1.4+Math.floor(i/3)*.7,xy=offsetLonLat(group.lon,group.lat,east,north);
    const position=C.Cartesian3.fromDegrees(...xy,.04),orientation=C.Transforms.headingPitchRollQuaternion(position,new C.HeadingPitchRoll(C.Math.toRadians(295+(i%3)*8),0,0));
    const entity=v.entities.add({id:'waiting-person-'+person.id,name:person.label||`대기 승객 ${person.id}`,position,orientation,properties:{requestId:String(person.id),serviceLon:group.lon,serviceLat:group.lat,positionKind:'visual_offset_from_logged_service_point'},model:{uri:ASSET('passenger.glb'),scale:1,minimumPixelSize:0,heightReference:C.HeightReference.RELATIVE_TO_GROUND,runAnimations:false,distanceDisplayCondition:new C.DistanceDisplayCondition(0,850)}});
    this.waitingEntities.push(entity);
   });
   const label=v.entities.add({id:'waiting-label-'+group.key,position:C.Cartesian3.fromDegrees(group.lon,group.lat,2.1),label:{text:`대기 ${group.people.length}명`,font:'bold 13px sans-serif',fillColor:C.Color.fromCssColorString('#ffd994'),showBackground:true,backgroundColor:C.Color.fromCssColorString('#1a2933').withAlpha(.86),backgroundPadding:new C.Cartesian2(6,4),pixelOffset:new C.Cartesian2(18,-18),heightReference:C.HeightReference.RELATIVE_TO_GROUND,distanceDisplayCondition:new C.DistanceDisplayCondition(0,1800),disableDepthTestDistance:Infinity}});
   this.waitingEntities.push(label);
  }
  v.scene.requestRender();
 }
 async _enablePublicTerrain(){
  if(!this.viewer)return false;const C=this.C,v=this.viewer,revision=++this._terrainRevision;this.publicTerrainSource?.dispose();const source=new TerrariumSource();this.publicTerrainSource=source;
  this.provider.terrain='공개 DEM 지형 연결 중';this._status('info','강내면 공개 고도 타일을 확인하는 중입니다.');
  try{
   const depot=this.network?.nodes?.[this.network?.depot];await source.probe(Number(depot?.lon)||127.3616417,Number(depot?.lat)||36.6237876);
   if(this.destroyed||revision!==this._terrainRevision){source.dispose();return false;}
   const provider=new C.CustomHeightmapTerrainProvider({width:source.grid,height:source.grid,tilingScheme:new C.WebMercatorTilingScheme(),credit:new C.Credit('Terrain: <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">Mapzen / Tilezen</a> · USGS SRTM, GMTED2010 · NOAA ETOPO1 · <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">Attribution</a>'),callback:(x,y,level)=>{
    const result=source.geometry(x,y,level);return result?.catch(error=>{if(revision===this._terrainRevision&&!this.destroyed)this._publicTerrainFailed(source,error);throw error;});
   }});
   this.terrainHeights.clear();v.terrainProvider=provider;this.hasTerrain=true;this.terrainKind='terrarium';this.provider.terrain='Mapzen 공개 DEM 지형';this._status('ready','공개 DEM 지형을 연결했습니다. 도로·교량의 측량 높이는 아니며, 고도는 재표본화한 DEM 표시값입니다.');v.scene.requestRender();return true;
  }catch(error){if(revision!==this._terrainRevision||this.destroyed)return false;this._publicTerrainFailed(source,error);return false;}
 }
 _publicTerrainFailed(source,error){
  if(source!==this.publicTerrainSource||source.disposed)return;source.dispose();if(!this.viewer||this.destroyed)return;this._terrainRevision++;this.viewer.terrainProvider=new this.C.EllipsoidTerrainProvider();this.hasTerrain=false;this.terrainKind='ellipsoid';this.terrainHeights.clear();this.provider.terrain='타원체 기준 · DEM 연결 실패';this._status('warning','공개 고도 타일을 읽지 못해 타원체 높이로 전환했습니다. 차량의 수평 경로 재생은 유지됩니다.');this.viewer.scene.requestRender();
 }
 _requestHeight(lon,lat){
  const key=round(lon,4)+','+round(lat,4);if(!this.viewer||this.heightRequests.has(key)||this.terrainHeights.has(key)||this.heightRequests.size>=4)return;
  const C=this.C,provider=this.viewer.terrainProvider||this.viewer.scene.globe.terrainProvider,revision=this._terrainRevision;
  // VWorld/custom providers need not expose tile availability; MostDetailed requires it.
  if(!provider||(!C.sampleTerrain&&!C.sampleTerrainMostDetailed))return;
  const points=[C.Cartographic.fromDegrees(lon,lat)];this.heightRequests.add(key);
  Promise.resolve().then(()=>provider.availability&&C.sampleTerrainMostDetailed?C.sampleTerrainMostDetailed(provider,points):C.sampleTerrain?.(provider,14,points)).then(p=>{
   if(this.destroyed||revision!==this._terrainRevision)return;const height=readTerrainHeight(p?.[0]);if(height!==undefined)this.terrainHeights.set(key,height);if(this.terrainHeights.size>10000)this.terrainHeights.clear();
  }).catch(()=>{}).finally(()=>this.heightRequests.delete(key));
 }
 _height(lon,lat){
  if(!this.hasTerrain||!this.viewer)return 0;
  const c=this.C.Cartographic.fromDegrees(lon,lat);let height;
  try{height=readTerrainHeight(this.viewer.scene.globe.getHeight(c));}catch{}
  const key=round(lon,4)+','+round(lat,4);if(height!==undefined){this.terrainHeights.set(key,height);return height;}
  return this.terrainHeights.get(key); // undefined means not sampled yet; cameras wait instead of inventing a ground height.
 }
 setCamera(mode,vehicleId){
  const choices={overview:'overview',follow:'follow',eye:'eye',street:'eye',interior:'interior'};this.mode=choices[mode]||'overview';if(this.mode==='overview')this._fallbackViewBounds=null;if(vehicleId!=null)this.selected=vehicleId;
  if(this.fallback){this._drawFallback();return;}if(!this.viewer)return;const C=this.C,v=this.viewer;v.trackedEntity=undefined;v.camera.lookAtTransform(C.Matrix4.IDENTITY);
  if(this.mode==='overview'){
   const b=this._bounds||[127.315,36.575,127.435,36.685],lon=(b[0]+b[2])/2,lat=(b[1]+b[3])/2;const span=Math.max((b[2]-b[0])*.8,b[3]-b[1])*111320;v.camera.flyTo({destination:C.Cartesian3.fromDegrees(lon,lat-.045,span*.95),orientation:{heading:0,pitch:C.Math.toRadians(-47),roll:0},duration:.8});
  }else this._updateCamera(true);
  v.scene.requestRender();
 }
 _updateCamera(force=false){
  if(!this.viewer||this.mode==='overview'||this.mode==='manual')return;const C=this.C,v=this.viewer;const s=this.states.find(s=>String(s.id)===String(this.selected))||this.states[0];const xy=stateCoord(s);if(!xy)return;
  const height=this._height(...xy),heading=C.Math.toRadians(Number(s.heading)||0);
  if(height===undefined){this._requestHeight(...xy);if(force&&!this._heightPendingAnnounced){this._heightPendingAnnounced=true;this._status('info','현재 위치의 지형 높이를 불러오는 중입니다. 추적·눈높이 카메라는 높이가 확인되면 이동합니다.',{heightPending:true});}return;}
  if(this._heightPendingAnnounced){this._heightPendingAnnounced=false;this._status('info','현재 위치의 지형 높이를 확인해 카메라 추적을 시작했습니다.',{heightPending:false});}
  if(this.mode==='follow')v.camera.lookAt(C.Cartesian3.fromDegrees(...xy,height+1),new C.HeadingPitchRange(heading-C.Math.toRadians(18),C.Math.toRadians(-23),34));
  else if(this.mode==='eye'){
   const coord=rotateOffset(s,3.4,-8);v.camera.lookAtTransform(C.Matrix4.IDENTITY);v.camera.setView({destination:C.Cartesian3.fromDegrees(...coord,height+1.75),orientation:{heading:heading-C.Math.toRadians(17),pitch:C.Math.toRadians(-1.5),roll:0}});
  }else if(this.mode==='interior')v.camera.lookAt(C.Cartesian3.fromDegrees(...xy,height+1.4),new C.HeadingPitchRange(heading+C.Math.toRadians(15),C.Math.toRadians(-68),9));
 }
 setLayers(options={}){
  Object.assign(this.layers,options);if(this.roadPrimitive)this.roadPrimitive.show=!!this.layers.roads;for(const entity of this.roadEntities)entity.show=!!this.layers.roads;
  for(const e of this.serviceEntities)e.show=e.metroKind==='depot'||e.metroKind==='stop'&&this.layers.stops||e.metroKind==='hub'&&this.layers.hubs;
  if(this.viewer){for(const rec of this.vehicles.values())rec.route.show=!!rec.routeSig&&this.layers.routes&&String(rec.id)===String(this.selected);this.viewer.scene.requestRender();}if(this.fallback)this._drawFallback();
 }
 async setProviderSettings(settings={}){
  if(!this.viewer)return false;const C=this.C,v=this.viewer;const token=String(settings.ionToken||'').trim();
  if(!token){if(this.buildings){v.scene.primitives.remove(this.buildings);this.buildings=null;}this.provider.buildings='건물 공급원 미연결';return this._enablePublicTerrain();}
  const revision=++this._terrainRevision;this._status('info','실제 지형과 건물 공급원을 연결하는 중입니다.');C.Ion.defaultAccessToken=token;
  try{
   const terrain=await timeout(C.createWorldTerrainAsync({requestVertexNormals:true}),20000,'지형 공급원 응답 지연');if(this.destroyed||revision!==this._terrainRevision)return false;this.publicTerrainSource?.dispose();this.terrainHeights.clear();v.terrainProvider=terrain;this.hasTerrain=true;this.terrainKind='ion';this.provider.terrain='Cesium World Terrain 실제 지형';
   if(settings.buildings!==false){try{const buildings=await timeout(C.createOsmBuildingsAsync(),20000,'건물 공급원 응답 지연');if(this.buildings)v.scene.primitives.remove(this.buildings);this.buildings=v.scene.primitives.add(buildings);this.provider.buildings='OSM 기반 실제 건물';}catch{this.provider.buildings='건물 공급원 연결 실패';}}
   this._status('ready','실제 지형을 연결했습니다. OSM 건물의 지역별 제공 범위는 다를 수 있습니다.');v.scene.requestRender();return true;
  }catch(error){if(revision!==this._terrainRevision||this.destroyed)return false;this._status('warning','Ion 연결에 실패해 공개 DEM 지형을 다시 연결합니다. 키의 권한을 확인해주세요.');await this._enablePublicTerrain();return false;}
 }
 resize(){if(this.viewer&&!this.viewer.isDestroyed())this.viewer.resize();if(this.fallback)this._drawFallback();}
 _initFallback(){
  this.host.replaceChildren();this.fallback=document.createElement('canvas');this.fallback.setAttribute('aria-label','3D 로딩 실패 시 실제 도로망을 표시하는 2D 대체 지도');Object.assign(this.fallback.style,{width:'100%',height:'100%',display:'block'});this.host.append(this.fallback);this.fallback.addEventListener('click',e=>{const r=this.fallback.getBoundingClientRect();const xy=[e.clientX-r.left,e.clientY-r.top];let best=null,dist=30;for(const item of this._fallbackPositions||[]){const d=Math.hypot(item.p[0]-xy[0],item.p[1]-xy[1]);if(d<dist){dist=d;best=item;}}if(best){this.selected=best.id;this.onSelect(best.id);this._drawFallback();}});if(this._boundaryZoomPending)this.zoomBoundary();else this._drawFallback();
 }
 _drawFallback(){
  const canvas=this.fallback;if(!canvas)return;const w=this.host.clientWidth||800,h=this.host.clientHeight||500,dpr=Math.min(window.devicePixelRatio||1,2);canvas.width=w*dpr;canvas.height=h*dpr;const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);ctx.fillStyle='#0e2531';ctx.fillRect(0,0,w,h);
  const b=this._fallbackViewBounds||this._bounds||[127.315,36.575,127.435,36.685];const dx=Math.max((b[2]-b[0])*.8,.000001),dy=Math.max(b[3]-b[1],.000001),scale=Math.min((w-60)/dx,(h-80)/dy);const ox=(w-dx*scale)/2,oy=(h-dy*scale)/2;const project=p=>[ox+(p[0]-b[0])*.8*scale,h-oy-(p[1]-b[1])*scale];
  ctx.strokeStyle='#24414e';ctx.lineWidth=1;for(let x=0;x<w;x+=70){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();}for(let y=0;y<h;y+=70){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
  this._drawBoundaryFallback(ctx,project,'fill');
  if(this.layers.roads){ctx.strokeStyle='#45929a';ctx.lineWidth=1;ctx.beginPath();for(const road of this.network?.roads||[]){let first=true;for(const c of road.coordinates||[]){const p=project(c);if(first){ctx.moveTo(...p);first=false;}else ctx.lineTo(...p);}}ctx.stroke();}
  this._drawBoundaryFallback(ctx,project,'outline');
  for(const id of this.network?.services||[]){const n=this.network.nodes[id];if(!n)continue;const hub=/hub/i.test(n.kind||id),depot=id===this.network.depot;if(!depot&&!(hub?this.layers.hubs:this.layers.stops))continue;const p=project([n.lon,n.lat]);ctx.fillStyle=depot?'#ffd285':hub?'#e6b387':'#a5dce2';ctx.beginPath();ctx.arc(...p,depot?5:2,0,Math.PI*2);ctx.fill();if(depot){ctx.font='bold 13px sans-serif';ctx.fillText('강내우체국',p[0]+9,p[1]-7);}}
  for(const group of this.waitingGroups){const p=project([group.lon,group.lat]);ctx.fillStyle='#ffd994';ctx.beginPath();ctx.arc(p[0]+5,p[1]-5,3,0,Math.PI*2);ctx.fill();ctx.font='12px sans-serif';ctx.fillText(`대기 ${group.people.length}`,p[0]+11,p[1]-5);}
  this._fallbackPositions=[];this.states.forEach((s,i)=>{const coord=stateCoord(s);if(!coord)return;const p=project(coord),color=COLORS[i%3];if(this.layers.routes&&String(s.id)===String(this.selected)&&s.route?.length){ctx.strokeStyle=color;ctx.lineWidth=3;ctx.beginPath();s.route.forEach((c,j)=>{const q=project(c);j?ctx.lineTo(...q):ctx.moveTo(...q);});ctx.stroke();}ctx.save();ctx.translate(...p);ctx.rotate((Number(s.heading)||0)*Math.PI/180);ctx.fillStyle=color;ctx.strokeStyle='#fff';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(0,-10);ctx.lineTo(7,8);ctx.lineTo(0,5);ctx.lineTo(-7,8);ctx.closePath();ctx.fill();ctx.stroke();ctx.restore();ctx.font='bold 13px sans-serif';ctx.fillStyle=color;ctx.fillText(`DRT ${s.id}`,p[0]+12,p[1]-8);this._fallbackPositions.push({id:s.id,p});});
  ctx.fillStyle='#d1e0e8';ctx.font='14px sans-serif';ctx.fillText('2D 대체 지도 · 실제 도로망 / 높이·건물 미표현',16,25);
 }
 destroy(){this.destroyed=true;this._terrainRevision++;this.publicTerrainSource?.dispose();this._resizeObserver?.disconnect();this.handler?.destroy();this._removeRenderError?.();if(this.viewer&&!this.viewer.isDestroyed()){if(this._ownsViewer)this.viewer.destroy();else{for(const e of [...this.serviceEntities,...this.roadEntities,...this.waitingEntities,...this.boundaryEntities])this.viewer.entities.remove(e);for(const record of this.vehicles.values())for(const key of ['entity','route','person','parcel','serviceLabel'])this.viewer.entities.remove(record[key]);if(this.roadPrimitive)this.viewer.scene.groundPrimitives.remove(this.roadPrimitive);}}this.host.remove();this.caption.remove();this.vehicles.clear();}
}
export default MetroScene;
