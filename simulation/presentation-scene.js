/** V7 presentation-only additions. Canonical vehicle coordinates/counts stay untouched. */
import {getPostalTruckPlacement} from './postal-truck-placement.js';

const installed = new WeakSet();
const bubbleCache = new Map();
const xml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const widthOf = text => [...String(text)].reduce((n,c) => n + (/[\u1100-\uFFFF]/.test(c) ? 13.5 : 7.4), 0);
export function passengerBubbleSvg(feedback) {
  const text = String(feedback?.text || ''), detail = feedback?.source?.includes('validated') ? '최초 계획 대비 · 재계산' : String(feedback?.detail || '');
  const late = feedback?.status === 'late', key = JSON.stringify([text,detail,late]);
  if (bubbleCache.has(key)) return bubbleCache.get(key);
  const w = Math.ceil(Math.max(154, widthOf(text)+28, widthOf(detail)*.75+24)), h = 58;
  const accent = late ? '#c36827' : '#14836f';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w*2}" height="${h*2}" viewBox="0 0 ${w} ${h}"><path d="M${w/2-7} 47L${w/2} 57L${w/2+7} 47" fill="#fcfff9" stroke="${accent}" stroke-width="1.5"/><rect x="1" y="1" width="${w-2}" height="48" rx="9" fill="#fcfff9" stroke="${accent}" stroke-width="1.5"/><path d="M${w/2-6} 47H${w/2+6}" stroke="#fcfff9" stroke-width="3"/><g font-family="Malgun Gothic,Noto Sans KR,Arial,sans-serif" text-anchor="middle"><text x="${w/2}" y="22" fill="#102a32" font-size="14" font-weight="700">${xml(text)}</text><text x="${w/2}" y="39" fill="${accent}" font-size="10.5">${xml(detail)}</text></g></svg>`;
  const result = {image:'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg), width:w, height:h};
  bubbleCache.set(key,result); if(bubbleCache.size>256)bubbleCache.delete(bubbleCache.keys().next().value);
  return result;
}

/** Uses Cesium public input APIs; applies equally to the V-World-owned viewer. */
export function configureMapTouch(scene) {
  const C=scene.C,v=scene.viewer,canvas=v?.scene?.canvas,controller=v?.scene?.screenSpaceCameraController;
  if(canvas?.style){canvas.style.touchAction='none';canvas.style.userSelect='none';}
  if(controller){
    controller.enableInputs=true;controller.enableZoom=true;controller.enableTranslate=true;controller.enableRotate=true;
    const current=controller.zoomEventTypes,types=current===undefined?[]:Array.isArray(current)?[...current]:[current];
    for(const event of [C?.CameraEventType?.WHEEL,C?.CameraEventType?.PINCH])if(event!==undefined&&!types.includes(event))types.push(event);
    if(types.length)controller.zoomEventTypes=types;
    controller.inertiaZoom=.65;
  }
  const release=()=>scene.releaseFollowCamera();
  for(const type of [C?.ScreenSpaceEventType?.PINCH_START,C?.ScreenSpaceEventType?.WHEEL]){
    if(type!==undefined)scene.handler?.setInputAction(release,type);
  }
}

export function installPresentationScene(Scene) {
  const p=Scene.prototype;if(installed.has(p))return;installed.add(p);
  const bind=p._bindViewer,drawFacilities=p._drawFacilities,destroy=p.destroy;
  p._bindViewer=function(...args){const result=bind.apply(this,args);configureMapTouch(this);return result;};
  p.releaseFollowCamera=function(){
    if(!this.viewer)return;this.mode='manual';
    this.viewer.camera.lookAtTransform(this.C.Matrix4.IDENTITY);
  };
  p.zoomStep=function(direction){
    if(this.viewer){
      const C=this.C,v=this.viewer,camera=v.camera;
      const state=this.states?.find(s=>String(s.id)===String(this.selected));
      let range;
      if(state&&['follow','interior','eye'].includes(this.mode)){
        const height=this._height?.(state.lon,state.lat);
        if(Number.isFinite(height)&&C.Cartesian3.distance)range=C.Cartesian3.distance(camera.positionWC,C.Cartesian3.fromDegrees(state.lon,state.lat,height));
      }
      this.releaseFollowCamera();
      if(!Number.isFinite(range)){
        const c=camera.positionCartographic,ground=c&&this._height?.(C.Math.toDegrees(c.longitude),C.Math.toDegrees(c.latitude));
        range=c?Math.max(5,c.height-(Number.isFinite(ground)?ground:0)):100;
      }
      const step=Math.max(2,Math.min(30000,range*.3));
      if(direction>0)camera.zoomIn(step);else camera.zoomOut(step);
      v.scene.requestRender?.();return;
    }
    if(this.fallback&&this._bounds){
      const b=this._fallbackViewBounds||this._bounds,factor=direction>0?.75:1/.75;
      if(Array.isArray(b)&&b.length===4){const x=(b[0]+b[2])/2,y=(b[1]+b[3])/2,dx=(b[2]-b[0])*factor/2,dy=(b[3]-b[1])*factor/2;this._fallbackViewBounds=[x-dx,y-dy,x+dx,y+dy];this._drawFallback();}
    }
  };
  p._drawFacilities=function(...args){const result=drawFacilities.apply(this,args);this._drawPostalTruck();return result;};
  p._drawPostalTruck=function(){
    const C=this.C,v=this.viewer;if(!v)return;
    if(this.postalTruck)v.entities.remove(this.postalTruck);this.postalTruck=null;
    const pose=getPostalTruckPlacement(this.servicePlacements,this.network);if(!pose)return;
    const position=C.Cartesian3.fromDegrees(pose.lon,pose.lat,.02);
    this.postalTruck=v.entities.add({id:'gangnae-postal-truck',name:'강내우체국 우편 차량 · 정차 모형',position,
      orientation:C.Transforms.headingPitchRollQuaternion(position,new C.HeadingPitchRoll(C.Math.toRadians(pose.heading+90),0,0)),
      properties:{role:'static_scenery',countsAsDRT:false,illustrative:true,positionKind:'illustrative_post_office_forecourt'},
      model:{uri:new URL('./assets/postal-truck.glb',import.meta.url).href,scale:1,minimumPixelSize:0,maximumScale:1,runAnimations:false,enableVerticalExaggeration:false,
        heightReference:C.HeightReference.RELATIVE_TO_TERRAIN??C.HeightReference.RELATIVE_TO_GROUND,distanceDisplayCondition:new C.DistanceDisplayCondition(0,1800)}});
  };
  p.setPassengerFeedbackProvider=function(provider){this._passengerFeedbackProvider=typeof provider==='function'?provider:null;};
  p.setPassengerBubblesEnabled=function(enabled){
    this._passengerBubblesEnabled=!!enabled;
    if(!enabled)for(const record of this.vehicles.values())if(record.passengerBubble)record.passengerBubble.show=false;
    this.viewer?.scene?.requestRender?.();
  };
  // Called after the existing vehicle/person staging and bridge-height alignment.
  p.updatePassengerBubbles=function(){
    const C=this.C,v=this.viewer;if(!v)return;
    for(const rec of this.vehicles.values()){
      if(rec.passengerBubble)rec.passengerBubble.show=false;
      if(this._passengerBubblesEnabled===false||!rec.person?.show||!['boarding','alighting'].includes(rec.state?.animation?.kind))continue;
      const feedback=this._passengerFeedbackProvider?.(rec.state,this.time);if(!feedback?.text)continue;
      const raw=rec.person.position?.getValue?rec.person.position.getValue(v.clock?.currentTime):rec.person.position;
      if(!raw)continue;
      const coordinate=C.Cartographic.fromCartesian(raw);
      const reference=rec.person.model.heightReference?.getValue?rec.person.model.heightReference.getValue(v.clock?.currentTime):rec.person.model.heightReference;
      if(!rec.passengerBubble)rec.passengerBubble=v.entities.add({id:'passenger-feedback-'+rec.id,show:false});
      const entity=rec.passengerBubble,key=[feedback.text,feedback.detail,feedback.source,feedback.status].join('|');
      if(key!==rec._feedbackKey){
        entity.billboard={...passengerBubbleSvg(feedback),verticalOrigin:C.VerticalOrigin.BOTTOM,horizontalOrigin:C.HorizontalOrigin.CENTER,
          pixelOffset:new C.Cartesian2(0,-5),heightReference:reference,disableDepthTestDistance:Infinity,
          distanceDisplayCondition:new C.DistanceDisplayCondition(0,650)};
        rec._feedbackKey=key;
      }
      entity.billboard.heightReference=reference;
      entity.billboard.scale=(v.scene.canvas?.clientWidth||800)<430?.86:1;
      entity.position=C.Cartesian3.fromRadians(coordinate.longitude,coordinate.latitude,coordinate.height+2.12);
      entity.show=true;
    }
    v.scene.requestRender?.();
  };
  p.destroy=function(...args){
    if(this.viewer&&!this.viewer.isDestroyed?.()){
      if(this.postalTruck)this.viewer.entities.remove(this.postalTruck);
      for(const rec of this.vehicles.values())if(rec.passengerBubble)this.viewer.entities.remove(rec.passengerBubble);
    }
    return destroy.apply(this,args);
  };
}
