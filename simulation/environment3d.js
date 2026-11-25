import {ENVIRONMENT_VERSION,ROAD_STYLES,boundsDistanceM,boundsIntersect,
 createTerrainHeightmap,displayHeight,polygonHeightSourceLabel,bridgeHeightAt,pointInPolygon} from './environment-core.js';
import {buildingVisualSpec,buildingRoofMesh,buildingFacadeMesh,meshInstances} from './building-visuals.js?v=20261125-v6';
import {materialPrimitives} from './building-materials.js?v=20261125-v6';
import {buildFacilityPriority,prioritizeBuilding} from './facility-priority.js';

const DEFAULT_BASE='./data/environment/';
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const pause=()=>new Promise(resolve=>setTimeout(resolve,0));
const timeout=(promise,ms)=>new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>reject(new Error('지형 표본 응답 시간 초과')),ms);
 Promise.resolve(promise).then(v=>{clearTimeout(timer);resolve(v);},e=>{clearTimeout(timer);reject(e);});
});
function nativeProvider(viewer){return viewer?.terrainProvider||viewer?.scene?.globe?.terrainProvider;}

/** Public TerrainProvider interface. The original provider owns networking and availability. */
export class GentleTerrainProvider {
 constructor(base,C,field,{bridgeBounds=[],onModified=()=>{}}={}){
  this.base=base;this.C=C;this.field=field;this.bridgeBounds=bridgeBounds;this.onModified=onModified;
  this.metroEnvironmentTerrain=true;this.modifiedTiles=0;this.maxCorrectionM=1.2;
 }
 get errorEvent(){return this.base.errorEvent;}
 get credit(){return this.base.credit;}
 get tilingScheme(){return this.base.tilingScheme;}
 get ready(){return this.base.ready===undefined?true:this.base.ready;}
 get readyPromise(){return this.base.readyPromise||Promise.resolve(true);}
 get availability(){return this.base.availability;}
 get hasWaterMask(){return this.base.hasWaterMask||false;}
 // Converted heightmap tiles do not contain encoded vertex normals.
 get hasVertexNormals(){return false;}
 getLevelMaximumGeometricError(level){return this.base.getLevelMaximumGeometricError(level);}
 getTileDataAvailable(x,y,l){return this.base.getTileDataAvailable?.(x,y,l);}
 loadTileDataAvailability(x,y,l){return this.base.loadTileDataAvailability?.(x,y,l);}
 requestTileGeometry(x,y,level,request){
  const result=this.base.requestTileGeometry(x,y,level,request);
  // Undefined means throttled, and must remain undefined for Cesium's retry semantics.
  if(result===undefined||level<14)return result;
  const C=this.C,rectangle=this.tilingScheme.tileXYToRectangle(x,y,level),deg=180/Math.PI;
  const bounds=[rectangle.west*deg,rectangle.south*deg,rectangle.east*deg,rectangle.north*deg];
  const f=this.field,fb=[f.west,f.south,f.west+f.stepLon*(f.width-1),f.south+f.stepLat*(f.height-1)];
  if(!boundsIntersect(bounds,fb))return result;
  return Promise.resolve(result).then(data=>{
   if(typeof data?.interpolateHeight!=='function'||typeof C.HeightmapTerrainData!=='function')return data;
   // Water masks and bridge footprints are preserved; water-only tiles are left untouched.
   if(data.waterMask?.length===1&&data.waterMask[0]===255)return data;
   if(data.waterMask&&!Number.isInteger(data.waterMask.length))return data;
   const maskSize=Math.sqrt(data.waterMask?.length||0);
   const isWater=(u,v)=>maskSize>1&&Number.isInteger(maskSize)&&data.waterMask[Math.min(maskSize-1,Math.floor(v*maskSize))*maskSize+Math.min(maskSize-1,Math.floor(u*maskSize))]>128;
   let patch;
   try{patch=createTerrainHeightmap({rectangle,field:f,sampleNative:(a,b)=>data.interpolateHeight(rectangle,a,b),size:65,
                                     bridgeBounds:this.bridgeBounds,maxCorrectionM:this.maxCorrectionM,isWater});}catch{return data;}
   if(!patch?.changed)return data;
   let mask=15;
   if(typeof data.isChildAvailable==='function'){
    mask=0;if(data.isChildAvailable(x,y,x*2,y*2+1))mask|=1;
    if(data.isChildAvailable(x,y,x*2+1,y*2+1))mask|=2;
    if(data.isChildAvailable(x,y,x*2,y*2))mask|=4;
    if(data.isChildAvailable(x,y,x*2+1,y*2))mask|=8;
   }
   let revised;
   try{revised=new C.HeightmapTerrainData({buffer:patch.buffer,width:65,height:65,childTileMask:mask,
                                         waterMask:data.waterMask,credits:data.credits});}catch{return data;}
   this.modifiedTiles++;this.onModified({modifiedTiles:this.modifiedTiles,maxCorrectionM:this.maxCorrectionM});
   return revised;
  });
 }
}

/** Uploaded GIS footprints, independently switchable from canonical simulation routes. */
export class Environment3D {
 constructor({onStatus=()=>{},baseUrl=DEFAULT_BASE,fetcher=globalThis.fetch?.bind(globalThis)}={}){
  this.onStatus=onStatus;this.baseUrl=baseUrl;this.fetcher=fetcher;this.version=ENVIRONMENT_VERSION;
  this.layers={buildings:true,roads:true,bridges:true,terrain:true};this.viewer=null;this.C=null;
  this.tiles=new Map();this.pendingRecords=new Set();this.dataCache=new Map();this.inFlight=new Set();this.queue=[];this.epoch=0;
  this.focus=[127.365,36.604];this.mode='overview';this.states=[];this.disposed=false;this.nativeBuildings=null;
  this.servicePlacements=null;this.facilityPriority=[];this._detailTarget=this.focus;
  this._status={ready:false,version:this.version,counts:{},loaded:{tiles:0,buildings:0,roads:0,bridges:0},
                terrain:{state:'waiting',modifiedTiles:0,maxCorrectionM:1.2},warnings:[],message:'실제 공간정보 준비 중'};
 }
 get status(){return {...this._status,layers:{...this.layers},loaded:{...this._status.loaded},terrain:{...this._status.terrain}};}
 _report(message,extra={}){
  Object.assign(this._status,extra);if(message)this._status.message=message;
  const loaded={tiles:this.tiles.size,buildings:0,roads:0,bridges:0};
  for(const tile of this.tiles.values())for(const key of ['buildings','roads','bridges'])loaded[key]+=tile.counts[key]||0;
  this._status.loaded=loaded;this.onStatus(this.status);this._status.terrainChanged=false;
 }
 async _json(relative){
  const response=await this.fetcher(this.baseUrl+relative);if(!response.ok)throw new Error(`${relative} (${response.status})`);
  return response.json();
 }
 async attach(viewer,C,{nativeBuildings=null}={}){
  if(this.disposed)return false;
  if(viewer===this.viewer&&C===this.C){this._refresh();return this._status.ready;}
  this.detach();const epoch=++this.epoch;this.viewer=viewer;this.C=C;this.nativeBuildings=nativeBuildings;
  if(!viewer?.scene?.primitives||!C?.PolygonGeometry){this._report('현재 지도 엔진에서 실제 공간정보 레이어를 지원하지 않습니다.',{ready:false});return false;}
  try{
   if(!this.manifest){this.manifest=await this._json('manifest.json');this.field=await this._json(this.manifest.elevation);}
   if(epoch!==this.epoch||this.disposed)return false;
   if(this.manifest.schemaVersion!==1||!Array.isArray(this.manifest.tiles))throw new Error('공간정보 데이터 형식 오류');
   this._groundSupported=!!(C.GroundPrimitive&&viewer.scene.groundPrimitives);let groundWarning;
   if(this._groundSupported&&C.GroundPrimitive.isSupported){
    try{this._groundSupported=C.GroundPrimitive.isSupported(viewer.scene)!==false;}catch{}
   }
   if(!this._groundSupported)groundWarning='현재 지도 SDK 또는 GPU에서 지면 도로 표면을 지원하지 않습니다. 건물·교량과 기존 도로망은 유지합니다.';
   if(this._groundSupported&&C.GroundPrimitive.initializeTerrainHeights){
    try{await timeout(C.GroundPrimitive.initializeTerrainHeights(),12000);}
    catch{this._groundSupported=false;groundWarning='현재 지도 SDK가 도로 표면의 지면 렌더링 자료를 읽지 못했습니다. 건물·교량과 기존 도로망 표시는 계속합니다.';}
   }
   if(epoch!==this.epoch||this.disposed)return false;
   const counts={buildings:0,roads:0,bridges:0};for(const tile of this.manifest.tiles)for(const k of Object.keys(counts))counts[k]+=tile.counts[k]||0;
   this._status.counts=counts;this._status.warnings=[...(this.manifest.warnings||[])];
   if(groundWarning)this._status.warnings.push(groundWarning);
   this._removeTerrainChanged=viewer.scene.globe?.terrainProviderChanged?.addEventListener(()=>{
    if(this._changingTerrain||!this.viewer)return;
    this._installTerrain();this._invalidateGeometry();this._report(null,{terrainChanged:true});
    this._status.terrainChanged=false;
   });
   this._installTerrain();
   this._removeCameraChanged=viewer.camera?.moveEnd?.addEventListener(()=>this._refresh(true));
   this._report('실제 건물·도로·교량 데이터를 불러오는 중입니다.',{ready:true});this._refresh(true);
   return true;
  }catch(error){
   if(epoch!==this.epoch)return false;
   this._report(`실제 공간정보 연결 실패: ${error.message}. 기본 지도는 유지됩니다.`,{ready:false,error:error.message});
   return false;
  }
 }
 _installTerrain(){
  const v=this.viewer,C=this.C;if(!v||!this.field)return;
  let provider=nativeProvider(v);if(!provider)return;
  if(provider.metroEnvironmentTerrain){if(this.layers.terrain)return;provider=provider.base;}
  if(!this.layers.terrain){
   if(nativeProvider(v).metroEnvironmentTerrain){this._changingTerrain=true;v.terrainProvider=provider;this._changingTerrain=false;}
   this._status.terrain={state:'original',modifiedTiles:0,maxCorrectionM:1.2};return;
  }
  if(C.EllipsoidTerrainProvider&&provider instanceof C.EllipsoidTerrainProvider){this._status.terrain.state='no-native-terrain';return;}
  if(typeof provider.requestTileGeometry!=='function'||!provider.tilingScheme||!C.HeightmapTerrainData){this._status.terrain.state='unsupported';return;}
  const wrapped=new GentleTerrainProvider(provider,C,this.field,{bridgeBounds:this.manifest.bridgeBounds,onModified:stats=>{
   if(this.disposed||!this.viewer||!this.layers.terrain||nativeProvider(this.viewer)!==wrapped)return;
   this._status.terrain={state:'active',...stats};if(stats.modifiedTiles===1||stats.modifiedTiles%30===0)this._report();
  }});
  this._terrainWrapper=wrapped;this._changingTerrain=true;
  try{v.terrainProvider=wrapped;this._status.terrain={state:'ready',modifiedTiles:0,maxCorrectionM:1.2};}
  catch{this._status.terrain.state='unsupported';}
  finally{this._changingTerrain=false;}
  this._status.terrainChanged=true;v.scene.requestRender?.();
 }
 setVisible(next={}){
  const terrainChanged='terrain'in next&&!!next.terrain!==this.layers.terrain;
  for(const k of Object.keys(this.layers))if(k in next)this.layers[k]=!!next[k];
  if(terrainChanged){this._installTerrain();this._invalidateGeometry();}
  for(const tile of this.tiles.values())for(const entry of tile.objects)entry.primitive.show=this.layers[entry.layer];
  this._syncNativeBuildings();this._report();this._refresh();this.viewer?.scene?.requestRender?.();
 }
 /** Dedicated post-office / village-hall / bus-stop models own their small footprint.
  * This is a render-only mask: source polygons and simulation positions remain untouched. */
 setServicePlacements(placements,{depot=true,hubs=true,stops=true}={}){
  const visible=`${!!depot}:${!!hubs}:${!!stops}`;
  if(placements===this.servicePlacements&&visible===this._facilityVisible)return;
  this.servicePlacements=placements;this._facilityVisible=visible;
  const values=placements?.values?[...placements.values()]:Array.isArray(placements)?placements:[];
  this.facilityPriority=buildFacilityPriority(values.filter(p=>p.kind==='depot'?depot:p.kind==='hub'?hubs:stops));
  // During attach(), the pending terrain/ground initialization already owns the epoch.
  // Its first tile load will read the latest masks; invalidating now would cancel attach.
  if(this.viewer&&this._status.ready)this._invalidateGeometry();
 }
 setFocus(lon,lat){if(finite(lon)&&finite(lat)){this.focus=[lon,lat];this._refresh();}}
 /** Render-only deck height; an optional heading rejects roads crossing underneath the bridge. */
 surfaceHeightAt(lon,lat,heading){
  if(!this.layers.bridges||!finite(lon)||!finite(lat))return undefined;
  let surface;
  for(const tile of this.tiles.values())for(const {bridge,heights} of tile.bridgeSurfaces||[]){
   if(boundsDistanceM(lon,lat,bridge.bounds)>0||!bridge.polygons.some(rings=>pointInPolygon([lon,lat],rings)))continue;
   if(finite(heading)){
    const[a,b]=bridge.anchors,dx=(b[0]-a[0])*Math.cos(lat*Math.PI/180),dy=b[1]-a[1];
    const bearing=Math.atan2(dx,dy)*180/Math.PI,delta=Math.abs((((heading-bearing)%180)+270)%180-90);
    if(delta>40)continue;
   }
   const h=bridgeHeightAt([lon,lat],bridge.anchors,heights);if(finite(h))surface=surface===undefined?h:Math.max(surface,h);
  }
  return surface;
 }
 update(states=[],{selectedId,mode='overview'}={}){
  this.states=states;this.mode=mode;
  const s=states.find(s=>String(s.id)===String(selectedId))||states.find(s=>s.selected)||states[0];
  if(s&&finite(s.lon)&&finite(s.lat))this.focus=[s.lon,s.lat];
  const now=Date.now();if(!this._lastRefresh||now-this._lastRefresh>650){this._lastRefresh=now;this._refresh();}
 }
 _cameraTarget(){
  const v=this.viewer,C=this.C;if(!v)return this.focus;
  try{
   const canvas=v.scene.canvas,ray=v.camera.getPickRay(new C.Cartesian2(canvas.clientWidth/2,canvas.clientHeight/2));
   const point=v.scene.globe.pick(ray,v.scene);if(point){const c=C.Cartographic.fromCartesian(point);return[C.Math.toDegrees(c.longitude),C.Math.toDegrees(c.latitude)];}
  }catch{}
  return this.focus;
 }
 _refresh(force=false){
  // Slider previews update the canonical vehicle state immediately; expensive
  // GPU/terrain work resumes once the latest target is committed.
  if(this.suspendRefresh)return;
  if(!this.viewer||!this.manifest||!this._status.ready)return;
  if(!this.layers.buildings&&!this.layers.roads&&!this.layers.bridges)return;
  let target=this.focus,radius=1800;
  const altitude=this.viewer.camera?.positionCartographic?.height||1000;
  if(this.mode==='overview'||this.mode==='manual'){
   target=this._cameraTarget();radius=Math.max(1600,Math.min(14000,altitude*1.2));
  }
  this._detailTarget=target;this._detailEnabled=altitude<2800;
  const sorted=this.manifest.tiles.map(tile=>({tile,d:boundsDistanceM(...target,tile.bounds)})).filter(x=>x.d<radius)
   .sort((a,b)=>a.d-b.d).map(x=>x.tile);
  this._wanted=new Set(sorted.map(x=>x.id));
  // Unload distant GPU batches. JSON stays in a bounded cache for deterministic rewind.
  let removed=false;
  for(const[id,tile]of this.tiles)if(!this._wanted.has(id)||(tile.retryAt&&Date.now()>=tile.retryAt)){this._removeTile(id,tile);removed=true;}
  for(const tile of this.tiles.values())this._refreshBuildingDetails(tile);
  if(removed){this._syncNativeBuildings();this._report();}
  this.queue=sorted.filter(t=>!this.tiles.has(t.id)&&!this.inFlight.has(t.id));this._pump();
 }
 _pump(){
  if(!this.viewer||this.disposed||this.suspendRefresh)return;
  while(this.inFlight.size<3&&this.queue.length){
   const descriptor=this.queue.shift(),epoch=this.epoch;this.inFlight.add(descriptor.id);
   this._loadTile(descriptor,epoch).catch(error=>{
    if(epoch===this.epoch){this._status.lastTileError=error.message;this._report('일부 공간정보 타일을 불러오지 못했습니다. 기본 지도와 운행 재생은 유지됩니다.');}
   }).finally(()=>{if(epoch===this.epoch){this.inFlight.delete(descriptor.id);this._pump();}});
  }
 }
 async _loadTile(descriptor,epoch){
  let data=this.dataCache.get(descriptor.id);
  if(!data){data=await this._json(descriptor.url);this.dataCache.set(descriptor.id,data);}
  if(this.suspendRefresh||epoch!==this.epoch||!this._wanted.has(descriptor.id))return;
  const v=this.viewer,C=this.C,record={viewer:v,objects:[],bridgeSurfaces:[],buildingVisuals:[],counts:{buildings:0,roads:0,bridges:0}};
  this.pendingRecords.add(record);
  try{
  // Ground road geometry does not wait for elevated building anchors.
  const groups=new Map();
  for(const road of this._groundSupported===false?[]:data.roads){
   const key=road.surface||'unknown';if(!groups.has(key))groups.set(key,[]);
   for(const rings of road.polygons)groups.get(key).push(this._instance(road,rings,'road',ROAD_STYLES[key],null));
  }
  for(const instances of groups.values())if(instances.length){
   const primitive=this._ground(instances);record.objects.push({layer:'roads',primitive});record.counts.roads+=instances.length;
  }
  const buildings=(data.buildings||[]).map(b=>prioritizeBuilding(b,this.facilityPriority)).filter(Boolean),bridges=data.bridges||[];
  const locations=buildings.map(b=>b.center).concat(bridges.flatMap(b=>b.anchors));
  const heights=await this._sampleHeights(locations);
  if(this.suspendRefresh||epoch!==this.epoch||!this._wanted.has(descriptor.id)){this._clearObjects(record);return;}
  const walls=[],roofs=[],decks=[],roofMeshes=[];
  for(let i=0;i<buildings.length;i++){
   const b=buildings[i],base=heights[i];if(!finite(base))continue;
   const parts=[];
   for(const rings of b.polygons){
    const spec=buildingVisualSpec(b,rings);parts.push({rings,spec});
    walls.push(this._instance(b,rings,'building',spec.wall,{base,height:spec.wallHeight,walls:true}));
    if(spec.roofRise)roofMeshes.push({record:b,base,mesh:buildingRoofMesh(b,rings,spec)});
    else roofs.push(this._instance(b,rings,'roof',spec.roof,{base:base+b.height+.015,height:0}));
   }
   record.buildingVisuals.push({record:b,base,parts});
   record.counts.buildings++;
  }
  for(let i=0;i<bridges.length;i++){
   const b=bridges[i],h=heights.slice(buildings.length+i*2,buildings.length+i*2+2);
   if(h.length!==2||!h.every(finite))continue;
   // Excessively inconsistent approach heights are not turned into a fictional sloping bridge.
   if(Math.abs(h[1]-h[0])>Math.max(8,(b.lengthM||20)*.12))continue;
   for(const rings of b.polygons){decks.push(this._bridgeInstance(b,rings,h));
    if(C.WallGeometry)for(const ring of rings)decks.push(this._bridgeEdge(b,ring,h));
   }
   record.bridgeSurfaces.push({bridge:b,heights:h});
   record.counts.bridges++;
  }
  if(walls.length)record.objects.push({layer:'buildings',primitive:this._primitive(walls)});
  if(roofs.length)record.objects.push({layer:'buildings',primitive:this._primitive(roofs)});
  if(roofMeshes.length)record.objects.push({layer:'buildings',primitive:this._primitive(meshInstances(C,roofMeshes,{kind:'building-roof'}),false)});
  if(decks.length)record.objects.push({layer:'bridges',primitive:this._primitive(decks)});
  record.counts.roads=this._groundSupported===false?0:data.roads.length;
  if(heights.some(h=>!finite(h)))record.retryAt=Date.now()+12000;
  for(const entry of record.objects)entry.primitive.show=this.layers[entry.layer];
  this.tiles.set(descriptor.id,record);this.pendingRecords.delete(record);this._syncNativeBuildings();
  this._refreshBuildingDetails(record);
  this._report('실제 공간정보 표시 중 · 높이·외관·교량 고도 추정은 자료 설명에서 구분합니다.');
  v.scene.requestRender?.();await pause();
  }catch(error){this._clearObjects(record);throw error;}
  finally{this.pendingRecords.delete(record);}
 }
 _refreshBuildingDetails(tile){
  if(!tile.buildingVisuals?.length||!this.viewer||!this.C)return;
  const target=this._detailTarget||this.focus;
  const active=this.layers.buildings&&this._detailEnabled!==false;
  const entries=active?tile.buildingVisuals.map(b=>({b,d:boundsDistanceM(...target,b.record.bounds)})).filter(x=>x.d<650).sort((a,b)=>a.d-b.d).slice(0,140):[];
  const key=entries.map(x=>`${x.b.record.id}:${x.d<260?'near':'mid'}`).sort().join('|');
  if(tile.detailKey===key)return;
  if(key&&tile.detailFailedKey===key&&Date.now()<tile.detailRetryAt)return;
  // Keep detailed windows local. At regional overview the original footprints still form
  // buildings, while unnecessary façade triangles are released from the GPU.
  let replacement=null,materialLayers=[];
  if(entries.length)try{
   const meshes=[];
   for(const{b,d}of entries)for(const{rings,spec}of b.parts)meshes.push({record:b.record,base:b.base,mesh:buildingFacadeMesh(b.record,rings,{near:d<260,spec})});
   const instances=meshInstances(this.C,meshes);
   if(instances.length){replacement=this._primitive(instances,false);replacement.show=this.layers.buildings;}
   // Fine neutral material swatches are only used close to the camera; no window grid.
   const surfaces=entries.filter(({d})=>d<260).flatMap(({b})=>b.parts.map(({rings,spec})=>({record:b.record,base:b.base,rings,spec})));
   for(const primitive of materialPrimitives(this.C,surfaces)){
    try{primitive.show=this.layers.buildings;this.viewer.scene.primitives.add(primitive);materialLayers.push(primitive);}catch{try{primitive.destroy?.();}catch{}}
   }
  }catch(error){
   // Optional window/door details cannot remove the already valid walls, roofs and roads.
   tile.detailFailedKey=key;tile.detailRetryAt=Date.now()+12000;this._status.lastDetailError=error.message;return;
  }
  for(const entry of tile.objects.filter(x=>x.detail)){try{tile.viewer.scene.primitives.remove(entry.primitive);}catch{}}
  tile.objects=tile.objects.filter(x=>!x.detail);
  if(replacement)tile.objects.push({layer:'buildings',detail:true,primitive:replacement});
  for(const primitive of materialLayers)tile.objects.push({layer:'buildings',detail:true,primitive});
  tile.detailKey=key;tile.detailFailedKey=null;
  this.viewer.scene.requestRender?.();
 }
 _hierarchy(rings,height){
  const C=this.C,positions=ring=>height?ring.slice(0,-1).map(p=>C.Cartesian3.fromDegrees(p[0],p[1],height(p))):C.Cartesian3.fromDegreesArray(ring.slice(0,-1).flatMap(p=>p.slice(0,2)));
  return new C.PolygonHierarchy(positions(rings[0]),rings.slice(1).map(r=>new C.PolygonHierarchy(positions(r))));
 }
 _instance(record,rings,kind,color,elevation){
  const C=this.C,options={polygonHierarchy:this._hierarchy(rings),vertexFormat:C.PerInstanceColorAppearance.VERTEX_FORMAT};
  if(elevation){options.height=elevation.base;
   if(elevation.height>0){options.extrudedHeight=elevation.base+elevation.height;options.closeBottom=false;options.closeTop=!elevation.walls;}
  }
  const id={metroEnvironment:true,kind,sourceId:record.id,name:record.name||record.use||({road:'도로',roof:'지붕',building:'건물'}[kind]),
            provenance:kind==='building'||kind==='roof'?polygonHeightSourceLabel(record):'실제 도로경계 면 · 중심선 속성 공간 대응',
            height:record.height,heightSource:record.heightSource,attributeMismatch:record.attributeMismatch||false};
  return new C.GeometryInstance({id,geometry:new C.PolygonGeometry(options),attributes:{color:C.ColorGeometryInstanceAttribute.fromColor(C.Color.fromCssColorString(color).withAlpha(kind==='road'?.8:1))}});
 }
 _bridgeInstance(record,rings,heights){
  const C=this.C;
  return new C.GeometryInstance({id:{metroEnvironment:true,kind:'bridge',sourceId:record.id,name:record.name,
     provenance:'실제 교량 외곽선 · 바닥 고도는 접근부 지형 기반 추정'},
   geometry:new C.PolygonGeometry({polygonHierarchy:this._hierarchy(rings,p=>bridgeHeightAt(p,record.anchors,heights)),
     perPositionHeight:true,vertexFormat:C.PerInstanceColorAppearance.VERTEX_FORMAT}),
   attributes:{color:C.ColorGeometryInstanceAttribute.fromColor(C.Color.fromCssColorString('#929998'))}});
 }
 _bridgeEdge(record,ring,heights){
  const C=this.C,hs=ring.map(p=>bridgeHeightAt(p,record.anchors,heights));
  return new C.GeometryInstance({id:{metroEnvironment:true,kind:'bridge',sourceId:record.id,name:record.name,
   provenance:'실제 외곽선 · 접근부 추정 고도 · 바닥 두께 0.35m 시각 표현'},
   geometry:new C.WallGeometry({positions:C.Cartesian3.fromDegreesArray(ring.flatMap(p=>p.slice(0,2))),
    minimumHeights:hs.map(h=>h-.35),maximumHeights:hs,vertexFormat:C.PerInstanceColorAppearance.VERTEX_FORMAT}),
   attributes:{color:C.ColorGeometryInstanceAttribute.fromColor(C.Color.fromCssColorString('#707c7a'))}});
 }
 _ground(instances){
  const C=this.C,v=this.viewer;
  if(!C.GroundPrimitive||!v.scene.groundPrimitives)throw new Error('현재 지도 SDK에 GroundPrimitive가 없습니다.');
  const primitive=new C.GroundPrimitive({geometryInstances:instances,appearance:new C.PerInstanceColorAppearance({translucent:true,flat:true}),
   classificationType:C.ClassificationType?.TERRAIN,asynchronous:true,show:this.layers.roads});
  v.scene.groundPrimitives.add(primitive);return primitive;
 }
 _primitive(instances,asynchronous=true){
  const C=this.C,primitive=new C.Primitive({geometryInstances:instances,
   appearance:new C.PerInstanceColorAppearance({translucent:false,closed:false,flat:false}),asynchronous});
  this.viewer.scene.primitives.add(primitive);return primitive;
 }
 async _sampleHeights(points){
  if(!points.length)return[];
  const v=this.viewer,C=this.C,provider=nativeProvider(v),epoch=this.epoch;
  const ellipsoid=C.EllipsoidTerrainProvider&&provider instanceof C.EllipsoidTerrainProvider;
  if(ellipsoid)return points.map(()=>0);
  if(!provider)return points.map(()=>undefined);
  const cartographics=points.map(p=>C.Cartographic.fromDegrees(p[0],p[1]));
  try{
   if(provider.readyPromise)await timeout(provider.readyPromise,12000);
   const result=await timeout(C.sampleTerrain(provider,14,cartographics),20000);
   if(epoch!==this.epoch)return[];
   return result.map(c=>displayHeight(c.height,v.scene));
  }catch{
   if(epoch!==this.epoch)return[];
   // Unknown ground is not substituted with an unconverted NUME elevation.
   return cartographics.map(c=>{try{const h=v.scene.globe.getHeight(c);return finite(h)?h:finite(h?.height)?h.height:undefined;}catch{return undefined;}});
  }
 }
 _syncNativeBuildings(){
  if(!this.nativeBuildings)return;
  const hasLocal=this.layers.buildings&&[...this.tiles.values()].some(t=>t.counts.buildings>0),desired=!hasLocal;
  if(this._nativeShow===desired)return;this._nativeShow=desired;
  try{this.nativeBuildings(desired);}catch{}
 }
 _clearObjects(tile){
  const viewer=tile.viewer||this.viewer;if(!viewer)return;
  for(const entry of tile.objects){
   try{const collection=entry.layer==='roads'?viewer.scene.groundPrimitives:viewer.scene.primitives;
    collection?.remove(entry.primitive);}catch{}
  }
 }
 _removeTile(id,tile){this._clearObjects(tile);this.tiles.delete(id);}
 _invalidateGeometry(){
  this.epoch++;this.inFlight.clear();this.queue=[];
  for(const tile of this.pendingRecords)this._clearObjects(tile);this.pendingRecords.clear();
  for(const[id,tile]of this.tiles)this._removeTile(id,tile);
  this._syncNativeBuildings();
  this._refresh(true);
 }
 detach(){
  this.epoch++;this._removeTerrainChanged?.();this._removeTerrainChanged=null;
  this._removeCameraChanged?.();this._removeCameraChanged=null;
  for(const[id,tile]of this.tiles)this._removeTile(id,tile);
  for(const tile of this.pendingRecords)this._clearObjects(tile);this.pendingRecords.clear();
  if(this.viewer){
   try{const p=nativeProvider(this.viewer);if(p?.metroEnvironmentTerrain)this.viewer.terrainProvider=p.base;}catch{}
   try{this.nativeBuildings?.(true);}catch{}
  }
  this.inFlight.clear();this.queue=[];this.viewer=null;this.C=null;this._nativeShow=undefined;
  this._status.ready=false;this._status.loaded={tiles:0,buildings:0,roads:0,bridges:0};
 }
 destroy(){this.detach();this.disposed=true;this.dataCache.clear();}
}
export default Environment3D;
