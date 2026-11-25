/**
 * MetroRookies · photo-referenced Cheongju call-bus presentation.
 * This module changes rendering only. Recorded events, routes, timestamps,
 * passenger/cargo counts and the V-World viewer remain owned by the existing app.
 */
export const DESIGN_VERSION = '2026-11-24.1';
export const DESIGN = Object.freeze({
  stopSpacingM: 9,
  sameCoordinateM: 0.35,
  stopNodeToleranceM: 3,
  modelScale: 1,
  badgeHeightM: 3.05,
  rearDoorAngle: 1.35,
  labelDistanceM: 25000,
});

const installed = new WeakSet();
const STATIONARY = new Set(['inactive','idle','parking','boarding','alighting','loading','delivery']);
const FLEET_COLORS = ['#4bc8b4','#e6a44e','#aa92df'];
const STATUS = {inactive:'운행 준비',idle:'대기',parking:'가상 주차 탐색',boarding:'승차',alighting:'하차',loading:'물류 적재',delivery:'배송',mixed:'통합 운행',passenger:'여객 운행',parcel:'물류 운행',empty:'이동',return:'복귀',unknown:'위치 미확인'};
const finite = n => (typeof n==='number'||(typeof n==='string'&&n.trim()!=='')) && Number.isFinite(Number(n));
const valid = s => s && finite(s.lon) && finite(s.lat) && Math.abs(Number(s.lon))<=180 && Math.abs(Number(s.lat))<85;
const radians = n => Number(n)*Math.PI/180;
const clamp = n => Math.max(0,Math.min(1,Number(n)||0));
const smooth = n => {const a=clamp(n);return a*a*(3-2*a);};
const statusOf = s => String(s?.status||'').toLowerCase();
const colorFor = id => FLEET_COLORS[(Math.max(1,Number(id)||1)-1)%3];
const xml = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));

export function distanceMeters(a,b){
  if(!valid(a)||!valid(b))return Infinity;
  return Math.hypot((Number(a.lon)-Number(b.lon))*111320*Math.cos(radians((Number(a.lat)+Number(b.lat))/2)),(Number(a.lat)-Number(b.lat))*111320);
}

function offset(s,right,forward){
  const h=radians(Number(s.heading)||0),east=right*Math.cos(h)+forward*Math.sin(h),north=-right*Math.sin(h)+forward*Math.cos(h);
  return {lon:Number(s.lon)+east/(111320*Math.cos(radians(s.lat))),lat:Number(s.lat)+north/111320};
}

function serviceKey(s,network,config){
  const kind=statusOf(s);
  let id=s.serviceNodeId??s.nodeId;
  if(id==null){
    if(kind==='inactive')id=network?.depot;
    else if(kind==='parking')id=s.event?.from??s.event?.to;
    else id=s.event?.to;
  }
  if(id==null||id==='')return null;
  const node=network?.nodes?.[id];
  // A mismatched event ID must not group vehicles that are actually elsewhere.
  if(node&&distanceMeters(s,node)>config.stopNodeToleranceM)return null;
  return String(id);
}

/** Deterministic display-only slots. Invalid/moving/unknown states never move. */
export function displayStates(states,network={},config=DESIGN){
  const out=new Map(),groups=[];
  const ordered=[...(states||[])].filter(valid).sort((a,b)=>String(a.id).localeCompare(String(b.id),undefined,{numeric:true}));
  for(const s of ordered){
    out.set(String(s.id),s);
    if(!STATIONARY.has(statusOf(s)))continue;
    const key=serviceKey(s,network,config);
    const group=groups.find(g=>{
      if(g.key!==null&&key!==null){
        const tolerance=valid(network?.nodes?.[key])?config.stopNodeToleranceM*2:config.stopNodeToleranceM;
        return g.key===key && distanceMeters(g.states[0],s)<=tolerance;
      }
      if(g.key!==key)return false;
      return distanceMeters(g.states[0],s)<=config.sameCoordinateM;
    });
    if(group)group.states.push(s);else groups.push({key,states:[s]});
  }
  for(const group of groups){
    if(group.states.length<2)continue;
    const first=group.states[0];
    const node=group.key!==null?network?.nodes?.[group.key]:null;
    const anchor=valid(node)&&distanceMeters(first,node)<=config.stopNodeToleranceM?node:first;
    const axis={lon:Number(anchor.lon),lat:Number(anchor.lat),heading:Number(first.heading)||0};
    group.states.forEach((s,i)=>{
      const slot=(i-(group.states.length-1)/2)*config.stopSpacingM;
      const position=offset(axis,0,slot);
      out.set(String(s.id),{...s,...position,displayOffsetM:slot,displayPositionKind:'illustrative_stop_spacing',sourceLon:Number(s.lon),sourceLat:Number(s.lat)});
    });
  }
  return out;
}

export function badgeContent(s,selected){
  const number=String(s.id).padStart(2,'0');
  const status=STATUS[statusOf(s)]||'운행';
  return {
    title:`청주콜 ${number}${selected?' · '+status:''}`,
    detail:selected?`${Math.max(0,Number(s.passengers)||0)}명  ·  물류 ${Math.max(0,Number(s.cargo)||0)}개`:'',
    color:colorFor(s.id),selected:!!selected,
  };
}

function textWidth(text){return [...text].reduce((w,c)=>w+(/[\u1100-\uFFFF]/.test(c)?12:6.8),0);}
const badgeCache=new Map();
export function badgeSvg(content){
  const key=JSON.stringify(content);if(badgeCache.has(key))return badgeCache.get(key);
  const color=/^#[0-9a-f]{6}$/i.test(String(content.color))?content.color:'#4bc8b4';
  const w=Math.ceil(Math.max(textWidth(content.title)+32,textWidth(content.detail)+24,88)),h=content.detail?46:29;
  const fill=content.selected?'#102431':'#132935';
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${w*2}" height="${(h+5)*2}" viewBox="0 0 ${w} ${h+5}"><path d="M${w/2-4} ${h-1}L${w/2} ${h+4}L${w/2+4} ${h-1}" fill="${fill}"/><rect x=".5" y=".5" width="${w-1}" height="${h-1}" rx="8" fill="${fill}" fill-opacity=".93" stroke="${content.selected?color:'#566776'}" stroke-opacity="${content.selected?'.8':'.4'}"/><circle cx="12" cy="14" r="3" fill="${color}"/><g font-family="Malgun Gothic,Noto Sans KR,Arial,sans-serif"><text x="21" y="18" fill="#f2f5f7" font-size="12" font-weight="600">${xml(content.title)}</text>${content.detail?`<text x="12" y="35" fill="#bac8d2" font-size="11">${xml(content.detail)}</text>`:''}</g></svg>`;
  const result={image:'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg),width:w,height:h+5};
  badgeCache.set(key,result);if(badgeCache.size>128)badgeCache.delete(badgeCache.keys().next().value);return result;
}

function putNode(bag,name,property){
  if(typeof bag?.addProperty==='function'){
    if(bag.hasProperty?.(name)||bag.propertyNames?.includes(name))bag[name]=property;
    else bag.addProperty(name,property);
  }else if(bag)bag[name]=property;
}

function setupRecord(scene,rec,config){
  if(rec._cheongjuDesignReady)return;
  const C=scene.C,model=rec.entity.model;
  const number=(Math.max(1,Number(rec.id)||1)-1)%3+1;
  model.uri=new URL(`./assets/drt-cheongju-${String(number).padStart(2,'0')}.glb`,import.meta.url).href;
  model.minimumPixelSize=0;model.maximumScale=config.modelScale;model.scale=config.modelScale;
  model.silhouetteSize=0;model.lightColor=undefined;
  model.imageBasedLightingFactor=new C.Cartesian2(1,1);
  if(C.Color?.WHITE)model.color=C.Color.WHITE;
  const bag=model.nodeTransformations;
  if(C.CallbackProperty&&C.TranslationRotationScale&&C.Quaternion?.fromAxisAngle&&bag){
    // The reference van has two rear doors, not an upward opening hatch.
    for(const [name,sign] of [['HATCH',-1],['HATCH_R',1]]){
      putNode(bag,name,new C.CallbackProperty(()=>new C.TranslationRotationScale(C.Cartesian3.ZERO,C.Quaternion.fromAxisAngle(C.Cartesian3.UNIT_Y,sign*clamp(rec.hatch)*config.rearDoorAngle),new C.Cartesian3(1,1,1)),false));
    }
  }
  rec._cheongjuDesignReady=true;
}

function showBadge(scene,rec,s,selected,config){
  const C=scene.C,entity=rec.serviceLabel;if(!entity)return;
  rec.entity.label.show=false;
  entity.label.show=false;
  const display=rec.displayState||s;
  entity.position=C.Cartesian3.fromDegrees(Number(display.lon),Number(display.lat),config.badgeHeightM);
  const content=badgeContent(s,selected),key=JSON.stringify(content);
  if(key!==rec._cheongjuBadgeKey){
    const badge=badgeSvg(content);
    entity.billboard={...badge,show:true,verticalOrigin:C.VerticalOrigin.BOTTOM,horizontalOrigin:C.HorizontalOrigin?.CENTER,pixelOffset:new C.Cartesian2(0,-7),heightReference:C.HeightReference.RELATIVE_TO_GROUND,disableDepthTestDistance:0,
      ...(C.NearFarScalar?{scaleByDistance:new C.NearFarScalar(30,1,2500,.78)}:{}),
      ...(C.DistanceDisplayCondition?{distanceDisplayCondition:new C.DistanceDisplayCondition(0,config.labelDistanceM)}:{})};
    rec._cheongjuBadgeKey=key;
  }
  if(!rec._cheongjuBadgePick){entity.properties={metroVehicle:s.id,visualPresentation:true};rec._cheongjuBadgePick=true;}
  entity.show=true;
}

function alignActors(scene,rec,s){
  const C=scene.C,a=s.animation,kind=a?.kind;
  if(!['boarding','alighting','loading','delivery'].includes(kind))return;
  const progress=clamp(a.progress),action=smooth((progress-.15)/.7);
  const outbound=kind==='alighting'||kind==='delivery',fraction=outbound?action:1-action;
  if(kind==='boarding'||kind==='alighting'){
    const pos=offset(s,1.35+fraction*3.8,.15+Math.sin(fraction*Math.PI)*.2);
    rec.person.position=C.Cartesian3.fromDegrees(pos.lon,pos.lat,.06);
  }else{
    // The van is longer than the old box model; unload behind its rear doors.
    const pos=offset(s,-.1,-(3.15+fraction*2.5));
    rec.parcel.position=C.Cartesian3.fromDegrees(pos.lon,pos.lat,1.05+Math.sin(action*Math.PI)*.2);
  }
}

function withDisplayStates(scene,method,args){
  const original=scene.states;
  if(!Array.isArray(original))return method.apply(scene,args);
  scene.states=original.filter(valid).map(s=>scene._cheongjuDisplay?.get(String(s.id))||s);
  try{return method.apply(scene,args);}finally{scene.states=original;}
}

/** Called by apply_design.py after the existing MetroScene class definition. */
export function installCheongjuDesign(MetroScene,options={}){
  if(typeof MetroScene!=='function'||!MetroScene.prototype)throw new Error('MetroScene class required.');
  const proto=MetroScene.prototype;
  if(installed.has(proto))return MetroScene;
  for(const name of ['_newVehicle','update','_updateCamera'])if(typeof proto[name]!=='function')throw new Error(`Incompatible MetroScene: ${name} missing.`);
  const config=Object.freeze({...DESIGN,...options}),originalNew=proto._newVehicle,originalUpdate=proto.update;
  for(const name of ['_updateCamera','_drawFallback']){
    const original=proto[name];if(typeof original!=='function')continue;
    proto[name]=function(...args){return withDisplayStates(this,original,args);};
  }
  proto._newVehicle=function(...args){const record=originalNew.apply(this,args);setupRecord(this,record,config);return record;};
  proto.update=function(states,time){
    const canonical=Array.isArray(states)?states:[];
    this._cheongjuDisplay=displayStates(canonical,this.network||{},config);
    const renderable=canonical.filter(valid);
    // Old stop-spacing helpers may still exist; override their display result,
    // never the logged state or event geometry passed to the original renderer.
    const result=originalUpdate.call(this,renderable,time);
    this.states=canonical;
    if(!this.viewer||!this.C)return result;
    const C=this.C;
    for(const s of renderable){
      const rec=this.vehicles?.get(String(s.id));if(!rec)continue;
      setupRecord(this,rec,config);
      const display=this._cheongjuDisplay.get(String(s.id))||s;
      rec.state=s;rec.displayState=display;
      const p=C.Cartesian3.fromDegrees(Number(display.lon),Number(display.lat),.035);
      rec.entity.position=p;
      rec.entity.orientation=C.Transforms.headingPitchRollQuaternion(p,new C.HeadingPitchRoll(radians((Number(s.heading)||0)+90),0,0));
      rec.entity.model.silhouetteSize=0;
      const selected=String(s.id)===String(this.selected);
      showBadge(this,rec,s,selected,config);
      alignActors(this,rec,display);
      if(rec.route?.polyline){rec.route.polyline.width=2;rec.route.polyline.material=C.Color.fromCssColorString(colorFor(s.id)).withAlpha(.58);}
      if(this.hasTerrain)this._requestHeight?.(Number(display.lon),Number(display.lat));
    }
    this.viewer.scene.requestRender?.();return result;
  };
  installed.add(proto);return MetroScene;
}
