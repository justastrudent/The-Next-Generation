import test from 'node:test';
import assert from 'node:assert/strict';
import {configureMapTouch, installPresentationScene, passengerBubbleSvg} from '../presentation-scene.js';

test('pinch and wheel release follow-lock while retaining native camera zoom gestures', () => {
  const actions=new Map(),canvas={style:{}},controller={zoomEventTypes:[2]};let released=0;
  const scene={C:{CameraEventType:{WHEEL:3,PINCH:4},ScreenSpaceEventType:{WHEEL:5,PINCH_START:6}},
    viewer:{scene:{canvas,screenSpaceCameraController:controller}},handler:{setInputAction:(fn,type)=>actions.set(type,fn)},releaseFollowCamera:()=>released++};
  configureMapTouch(scene);
  assert.equal(canvas.style.touchAction,'none');assert.deepEqual(controller.zoomEventTypes,[2,3,4]);
  assert.equal(controller.enableZoom,true);actions.get(6)();actions.get(5)();assert.equal(released,2);
  configureMapTouch(scene);assert.deepEqual(controller.zoomEventTypes,[2,3,4],'reconnection does not duplicate events');
});

test('zoom buttons escape follow-lock and use the current camera height', () => {
  class Scene{_bindViewer(){} _drawFacilities(){} destroy(){}}
  installPresentationScene(Scene);const scene=new Scene(),moves=[];
  scene.C={Matrix4:{IDENTITY:'world'},Math:{toDegrees:x=>x},Cartesian3:{}};
  scene.states=[];scene.mode='follow';scene._height=()=>80;
  scene.viewer={camera:{positionCartographic:{height:180,latitude:36,longitude:127},lookAtTransform:t=>moves.push(['transform',t]),zoomIn:m=>moves.push(['in',m]),zoomOut:m=>moves.push(['out',m])},scene:{requestRender(){}}};
  scene.zoomStep(1);scene.zoomStep(-1);
  assert.equal(scene.mode,'manual');assert.deepEqual(moves,[['transform','world'],['in',30],['transform','world'],['out',30]]);
});

test('feedback follows the walking person after bridge alignment and stays out of fleet data', () => {
  class Scene{_bindViewer(){} _drawFacilities(){} destroy(){}}
  installPresentationScene(Scene);const scene=new Scene(),entities=[];
  scene.C={Cartographic:{fromCartesian:p=>p},Cartesian3:{fromRadians:(longitude,latitude,height)=>({longitude,latitude,height})},
    Cartesian2:class{constructor(x,y){Object.assign(this,{x,y});}},VerticalOrigin:{BOTTOM:1},HorizontalOrigin:{CENTER:1},DistanceDisplayCondition:class{constructor(a,b){this.near=a;this.far=b;}}};
  const personPosition={longitude:2.2,latitude:.64,height:104},state={id:1,animation:{kind:'alighting',requestId:'a'}};
  const rec={id:1,state,person:{show:true,position:{getValue:()=>personPosition},model:{heightReference:{getValue:()=>0}}}};
  scene.vehicles=new Map([['1',rec]]);scene.time=200;scene.viewer={clock:{},entities:{add:e=>{entities.push(e);return e;}},scene:{canvas:{clientWidth:390},requestRender(){}}};
  scene.setPassengerFeedbackProvider((s,t)=>{assert.equal(s,state);assert.equal(t,200);return{text:'+2.0분 지연',detail:'최초 계획 대비',status:'late',source:'recorded_arrival_vs_validated_initial_plan'};});
  scene.updatePassengerBubbles();
  assert.equal(entities.length,1);assert.equal(scene.vehicles.size,1);assert.equal(rec.passengerBubble.position.height,106.12);
  assert.equal(rec.passengerBubble.billboard.heightReference,0);assert.equal(rec.passengerBubble.show,true);
  assert.deepEqual(personPosition,{longitude:2.2,latitude:.64,height:104});
  scene.setPassengerBubblesEnabled(false);assert.equal(rec.passengerBubble.show,false);
  scene.updatePassengerBubbles();assert.equal(rec.passengerBubble.show,false);
  scene.setPassengerBubblesEnabled(true);rec.person.show=false;scene.updatePassengerBubbles();assert.equal(rec.passengerBubble.show,false);
});

test('bubble content is escaped and initial ETA source is visible', () => {
  const result=passengerBubbleSvg({text:'<script>alert(1)</script>',detail:'처음',source:'validated_plan_recalculation'});
  const svg=decodeURIComponent(result.image.split(',')[1]);
  assert.ok(!svg.includes('<script>'));assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('최초 계획 대비 · 재계산'));assert.ok(result.height<70);
});
