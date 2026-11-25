import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DESIGN,displayStates,distanceMeters,badgeContent,badgeSvg,installCheongjuDesign} from '../cheongju-design.js';

// This fixture executes the lifecycle of the prior scene renderer: it performs
// its old spacing, model and actor updates first, then invokes the patched camera.
// It deliberately retains the old faults so the adapter must supersede them.
const anchor={lon:127.3616,lat:36.6238};
const metres=(east,north)=>({lon:anchor.lon+east/(111320*Math.cos(anchor.lat*Math.PI/180)),lat:anchor.lat+north/111320});
const net={depot:'DEPOT',nodes:{DEPOT:anchor,STOP_A:anchor,STOP_B:{...anchor},HUB_A:metres(100,0)}};
const make=(id,extra={})=>({id,...anchor,heading:0,status:'idle',passengers:2,cargo:4,event:{id:10+id,to:'STOP_A',from:'HUB_A',time:65,completed:66},route:[[127.36,36.62],[anchor.lon,anchor.lat]],...extra});
const clone=v=>JSON.parse(JSON.stringify(v));
const near=(a,b,epsilon=1e-8)=>assert.ok(Math.abs(a-b)<epsilon,`${a} ≠ ${b}`);
const deepFreeze=o=>{if(o&&typeof o==='object'){Object.freeze(o);Object.values(o).forEach(deepFreeze);}return o;};
const finite=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));
const coord=s=>finite(s?.lon)&&finite(s?.lat)?[Number(s.lon),Number(s.lat)]:null;
const offset=(s,right,forward)=>{const a=(Number(s.heading)||0)*Math.PI/180,east=right*Math.cos(a)+forward*Math.sin(a),north=-right*Math.sin(a)+forward*Math.cos(a);return {lon:Number(s.lon)+east/(111320*Math.cos(s.lat*Math.PI/180)),lat:Number(s.lat)+north/111320};};
const smooth=v=>{const p=Math.max(0,Math.min(1,v));return p*p*(3-2*p);};

class CallbackProperty {constructor(fn,isConstant){this.fn=fn;this.isConstant=isConstant;}getValue(){return this.fn();}}
class PropertyBag {
  constructor(entries={}){this.propertyNames=[];this.addCount=new Map();for(const [k,v] of Object.entries(entries))this.addProperty(k,v);}
  hasProperty(name){return this.propertyNames.includes(name);}
  addProperty(name,value){if(this.hasProperty(name))throw new Error('duplicate PropertyBag property '+name);this.propertyNames.push(name);this.addCount.set(name,1);let property=value;Object.defineProperty(this,name,{enumerable:true,configurable:true,get:()=>property,set:v=>{property=v;}});}
  getValue(){return Object.fromEntries(this.propertyNames.map(k=>[k,this[k]?.getValue?.()??this[k]]));}
}
class Cartesian3 {
  constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}
  static fromDegrees(lon,lat,height=0){if(!Number.isFinite(lon)||!Number.isFinite(lat)||Math.abs(lon)>180||Math.abs(lat)>90)throw new Error('invalid degrees');return {lon,lat,height};}
  static fromDegreesArray(values){return values.slice();}
}
Cartesian3.ZERO=new Cartesian3();Cartesian3.UNIT_Y=new Cartesian3(0,1,0);Cartesian3.UNIT_X=new Cartesian3(1,0,0);
class Cartesian2 {constructor(x,y){Object.assign(this,{x,y});}}
class TranslationRotationScale {constructor(translation,rotation,scale){Object.assign(this,{translation,rotation,scale});}}
class HeadingPitchRoll {constructor(heading,pitch,roll){Object.assign(this,{heading,pitch,roll});}}
class Color {constructor(css,alpha=1){Object.assign(this,{css,alpha});}withAlpha(a){return new Color(this.css,a);}static fromCssColorString(css){return new Color(css);}}
Color.WHITE=new Color('#ffffff');
const C={Cartesian3,Cartesian2,CallbackProperty,PropertyBag,TranslationRotationScale,HeadingPitchRoll,Color,
  Quaternion:{IDENTITY:{identity:true},fromAxisAngle:(axis,angle)=>({axis,angle})},
  Transforms:{headingPitchRollQuaternion:(position,hpr)=>({position,hpr})},
  HeightReference:{RELATIVE_TO_GROUND:'relative'},VerticalOrigin:{BOTTOM:'bottom'},HorizontalOrigin:{CENTER:'center'},
  NearFarScalar:class{constructor(...args){this.args=args;}},DistanceDisplayCondition:class{constructor(...args){this.args=args;}}
};

function oldSpacing(states){
  const result=new Map(),groups=[];
  for(const s of states){result.set(String(s.id),s);if(['mixed','passenger','parcel','empty','return'].includes(s.status))continue;let g=groups.find(g=>distanceMeters(g[0],s)<4);if(!g){g=[];groups.push(g);}g.push(s);}
  for(const g of groups){if(g.length<2)continue;g.sort((a,b)=>a.id-b.id);const axis=g[0].heading;g.forEach((s,i)=>result.set(String(s.id),{...s,...offset({...s,heading:axis},0,(i-(g.length-1)/2)*9)}));}
  return result;
}

function fixtureClass(){
  return class OriginalScene {
    constructor(){this.C=C;this.network=net;this.states=[];this.vehicles=new Map();this.selected=1;this.time=0;this.cameraCalls=[];this.fallbackCalls=[];this.heightCalls=[];this.newCalls=0;this.updateCalls=0;this.renderCalls=0;this.hasTerrain=true;this.viewer={scene:{requestRender:()=>this.renderCalls++}};}
    _newVehicle(id,index){
      this.newCalls++;const rec={id,index,door:0,hatch:0,pax:0,cargo:0};
      const originalDoor=new CallbackProperty(()=>({translation:{x:rec.door*.18,y:0,z:rec.door*1.08}}),false);
      const originalHatch=new CallbackProperty(()=>({rotation:{axis:'X',angle:-rec.hatch*1.28}}),false);
      const nodes=new PropertyBag({DOOR:originalDoor,HATCH:originalHatch,ROOF:new CallbackProperty(()=>({scale:1}),false),PAX_0:new CallbackProperty(()=>rec.pax,false),CARGO_0:new CallbackProperty(()=>rec.cargo,false)});
      rec.originalDoor=originalDoor;rec.entity={position:null,orientation:null,show:true,label:{show:true,text:''},model:{uri:'old.glb',minimumPixelSize:34,maximumScale:36,scale:1,lightColor:new Cartesian3(1.4,1.4,1.4),nodeTransformations:nodes}};
      rec.route={show:false,polyline:{positions:[],width:4,material:'oldGlow'}};
      rec.person={show:false};rec.parcel={show:false};rec.serviceLabel={show:false,label:{show:true}};
      this.vehicles.set(String(id),rec);return rec;
    }
    update(states,time){
      this.updateCalls++;this.states=states||[];this.time=Number(time)||0;
      if(this.fallback){this._drawFallback();return 'fallback';}if(!this.viewer)return 'waiting';
      const old=oldSpacing(this.states),present=new Set();
      this.states.forEach((s,index)=>{
        const display=old.get(String(s.id)),xy=coord(display);if(!xy)return;present.add(String(s.id));
        const rec=this.vehicles.get(String(s.id))||this._newVehicle(s.id,index);rec.state=s;
        rec.entity.position=Cartesian3.fromDegrees(...xy,.08);rec.entity.show=true;rec.entity.model.silhouetteSize=s.selected?2.3:.9;rec.entity.label.text=`DRT ${s.id} · ${s.passengers} / ${s.cargo}`;
        rec.pax=s.passengers;rec.cargo=s.cargo;rec.door=0;rec.hatch=0;rec.person.show=false;rec.parcel.show=false;rec.serviceLabel.show=false;
        const a=s.animation;if(a&&['boarding','alighting','loading','delivery'].includes(a.kind)){
          const ap=a.progress,act=smooth((ap-.15)/.7),out=['alighting','delivery'].includes(a.kind),fraction=out?act:1-act;
          const open=Math.min(smooth(ap/.15),smooth((1-ap)/.15));
          if(['boarding','alighting'].includes(a.kind)){rec.door=open;const p=offset(s,1.35+fraction*3.8,.77+Math.sin(fraction*Math.PI)*.45);rec.person.position=Cartesian3.fromDegrees(p.lon,p.lat,.06);rec.person.show=ap>.1&&ap<.91;}
          else{rec.hatch=open;const p=offset(s,-.25,-(2.2+fraction*2.6));rec.parcel.position=Cartesian3.fromDegrees(p.lon,p.lat,1.1+Math.sin(act*Math.PI)*.25);rec.parcel.show=ap>.1&&ap<.92;}
          rec.serviceLabel.position=Cartesian3.fromDegrees(...xy,3.6);rec.serviceLabel.show=s.id===this.selected;
        }
        rec.route.polyline.positions=Cartesian3.fromDegreesArray(s.route.flat());rec.route.show=s.id===this.selected;
      });
      for(const [key,r] of this.vehicles)if(!present.has(key)){for(const k of ['entity','route','person','parcel','serviceLabel'])r[k].show=false;}
      this._updateCamera();this.viewer.scene.requestRender();return 'original-result';
    }
    _updateCamera(force=false){
      const s=this.states.find(s=>String(s.id)===String(this.selected))||this.states[0];
      this.cameraCalls.push({states:this.states.slice(),force});
      if(this.throwCamera)throw new Error('camera fault');
      const xy=coord(s);this.cameraPosition=xy?Cartesian3.fromDegrees(...xy,1):null;return 'camera-result';
    }
    _drawFallback(){this.fallbackCalls.push(this.states.slice());if(this.throwFallback)throw new Error('fallback fault');return 'fallback-result';}
    _requestHeight(lon,lat){this.heightCalls.push([lon,lat]);}
  };
}
function scene(){const Scene=fixtureClass();installCheongjuDesign(Scene);return new Scene();}

test('same service node shares one deterministic anchor, including opposite headings',()=>{
  const states=[make(2,{...metres(0,2),heading:180}),make(1,{...metres(0,-2),heading:0}),make(3,{heading:90})];
  const before=clone(states),actual=displayStates(states,net),reversed=displayStates([...states].reverse(),net);
  for(const id of ['1','2','3'])assert.deepEqual(actual.get(id),reversed.get(id));
  near(distanceMeters(actual.get('1'),actual.get('2')),9,1e-6);near(distanceMeters(actual.get('2'),actual.get('3')),9,1e-6);
  near(actual.get('2').lat,anchor.lat);near(actual.get('2').lon,anchor.lon);
  assert.equal(actual.get('1').displayPositionKind,'illustrative_stop_spacing');
  assert.equal(actual.get('2').heading,180);assert.deepEqual(states,before);
});

test('moving, unknown, lone stopped and separate node states retain their original objects',()=>{
  for(const status of ['mixed','passenger','parcel','empty','return','unknown']){
    const states=[make(1,{status}),make(2,{status})],actual=displayStates(states,net);
    assert.strictEqual(actual.get('1'),states[0]);assert.strictEqual(actual.get('2'),states[1]);
  }
  const states=[make(1),make(2,{event:{to:'STOP_B'}}),make(3,{status:'empty'})],actual=displayStates(states,net);
  states.forEach(s=>assert.strictEqual(actual.get(String(s.id)),s));
});

test('stationary classification resolves depot, parking from-node and explicit service node',()=>{
  const inputs=[
    [make(1,{status:'inactive',event:undefined}),make(2,{status:'INACTIVE',event:undefined})],
    [make(1,{status:'parking',event:{from:'STOP_A',to:'HUB_A'}}),make(2,{status:'parking',event:{from:'STOP_A',to:'HUB_A'}})],
    [make(1,{serviceNodeId:'STOP_A',event:{to:'HUB_A'}}),make(2,{nodeId:'STOP_A',event:{to:'HUB_A'}})],
    [make(1,{event:undefined}),make(2,{event:undefined})]
  ];
  for(const states of inputs){const actual=displayStates(states,net);near(distanceMeters(actual.get('1'),actual.get('2')),DESIGN.stopSpacingM,1e-6);}
  const distant=[make(1),make(2,{...metres(100,0)})],actual=displayStates(distant,net);
  assert.strictEqual(actual.get('1'),distant[0]);assert.strictEqual(actual.get('2'),distant[1]);
});

test('invalid coordinates are excluded instead of becoming the zero coordinate',()=>{
  const bad=[null,undefined,'','   ',false,[],NaN,Infinity,181];
  for(const value of bad){const actual=displayStates([make(1,{lon:value}),make(2)],net);assert.equal(actual.has('1'),false,`accepted invalid lon ${String(value)}`);}
  for(const lat of [85,90,-91,Infinity])assert.equal(displayStates([make(1,{lat})],net).size,0);
  const numeric=make(1,{lon:String(anchor.lon),lat:String(anchor.lat)});assert.strictEqual(displayStates([numeric],net).get('1'),numeric);
});

test('adapter supersedes old offset, keeps canonical log state, route and time, and aligns camera',()=>{
  const s=scene(),states=deepFreeze([make(1,{status:'boarding',animation:{kind:'boarding',progress:.5},selected:true}),make(2,{status:'loading',animation:{kind:'loading',progress:.5}}),make(3,{status:'empty'})]),before=clone(states);
  assert.equal(s.update(states,65.5),'original-result');assert.strictEqual(s.states,states);assert.equal(s.time,65.5);
  states.forEach(state=>{const rec=s.vehicles.get(String(state.id));assert.strictEqual(rec.state,state);assert.strictEqual(rec.state.route,state.route);assert.strictEqual(rec.state.event,state.event);assert.deepEqual(rec.route.polyline.positions,state.route.flat());assert.equal(rec.pax,state.passengers);assert.equal(rec.cargo,state.cargo);});
  const r1=s.vehicles.get('1'),r2=s.vehicles.get('2'),r3=s.vehicles.get('3');
  near(distanceMeters(r1.entity.position,r2.entity.position),9,1e-6);near(r3.entity.position.lon,states[2].lon);near(r3.entity.position.lat,states[2].lat);
  near(s.cameraPosition.lon,r1.displayState.lon);near(s.cameraPosition.lat,r1.displayState.lat);
  // Compare with the same animation when each vehicle is alone. This verifies
  // that its actors move by exactly the vehicle's display offset, independently
  // of the chosen walking path or door position in the new model.
  const soloPerson=scene(),soloParcel=scene();soloPerson.update([states[0]],65.5);soloParcel.update([states[1]],65.5);
  const person=soloPerson.vehicles.get('1').person.position,parcel=soloParcel.vehicles.get('2').parcel.position;
  near(r1.person.position.lon-person.lon,r1.displayState.lon-states[0].lon);near(r1.person.position.lat-person.lat,r1.displayState.lat-states[0].lat);
  near(r2.parcel.position.lon-parcel.lon,r2.displayState.lon-states[1].lon);near(r2.parcel.position.lat-parcel.lat,r2.displayState.lat-states[1].lat);
  assert.ok((states[1].lat-parcel.lat)*111320>3.15,'parcel staging remains behind the longer rear doors');
  near(r1.serviceLabel.position.lon,r1.displayState.lon);near(r1.serviceLabel.position.lat,r1.displayState.lat);
  assert.equal(r1.entity.label.show,false);assert.equal(r1.serviceLabel.label.show,false);assert.equal(r1.serviceLabel.show,true);
  assert.equal(r1.route.polyline.width,2);assert.deepEqual(states,before);
});

test('realistic model parameters and dynamic PropertyBag rear-door transforms preserve original DOOR/PAX/CARGO',()=>{
  const s=scene();s.update([make(1,{status:'loading',animation:{kind:'loading',progress:.5}})],66);
  const rec=s.vehicles.get('1'),m=rec.entity.model,bag=m.nodeTransformations;
  assert.match(m.uri,/assets\/drt-cheongju-01\.glb$/);assert.equal(m.minimumPixelSize,0);assert.equal(m.maximumScale,1);assert.equal(m.scale,1);assert.equal(m.silhouetteSize,0);assert.equal(m.lightColor,undefined);assert.strictEqual(m.color,C.Color.WHITE);
  assert.strictEqual(bag.DOOR,rec.originalDoor);assert.equal(bag.PAX_0.getValue(),2);assert.equal(bag.CARGO_0.getValue(),4);assert.equal(bag.addCount.get('HATCH'),1);assert.equal(bag.addCount.get('HATCH_R'),1);
  const open=bag.getValue();assert.strictEqual(open.HATCH.rotation.axis,C.Cartesian3.UNIT_Y);near(open.HATCH.rotation.angle,-DESIGN.rearDoorAngle);near(open.HATCH_R.rotation.angle,DESIGN.rearDoorAngle);
  rec.hatch=0;assert.equal(bag.HATCH.getValue().rotation.angle,-0);assert.equal(bag.HATCH_R.getValue().rotation.angle,0);
  s.update([make(1)],67);assert.equal(bag.addCount.get('HATCH_R'),1);assert.equal(s.newCalls,1);
});

test('installer wraps once, validates compatibility and maintains original return values',()=>{
  const Scene=fixtureClass();assert.strictEqual(installCheongjuDesign(Scene),Scene);const wrapped=Scene.prototype.update;
  assert.strictEqual(installCheongjuDesign(Scene),Scene);assert.strictEqual(Scene.prototype.update,wrapped);
  const s=new Scene();s.update([make(1)],30);assert.equal(s.updateCalls,1);assert.equal(s.newCalls,1);assert.equal(s.cameraCalls.length,1);
  assert.throws(()=>installCheongjuDesign(null),/MetroScene/);assert.throws(()=>installCheongjuDesign(class{}),/missing/);
});

test('manual camera and fallback use display coordinates, filter invalid records and restore state on errors',()=>{
  const s=scene(),states=[make(1),make(2),make(3,{lon:181})];s.update(states,30);
  assert.equal(s._updateCamera(true),'camera-result');assert.strictEqual(s.states,states);assert.equal(s.cameraCalls.at(-1).states.length,2);near(s.cameraPosition.lat,s.vehicles.get('1').displayState.lat);
  s.selected=3;s._updateCamera();assert.equal(s.cameraCalls.at(-1).states.length,2);near(s.cameraPosition.lat,s.vehicles.get('1').displayState.lat);
  assert.equal(s._drawFallback(),'fallback-result');assert.strictEqual(s.states,states);assert.equal(s.fallbackCalls.at(-1).length,2);near(s.fallbackCalls.at(-1)[0].lat,s.vehicles.get('1').displayState.lat);
  s.throwCamera=true;assert.throws(()=>s._updateCamera(),/camera fault/);assert.strictEqual(s.states,states);
  s.throwFallback=true;assert.throws(()=>s._drawFallback(),/fallback fault/);assert.strictEqual(s.states,states);
});

test('waiting for viewer and 2D fallback do not create 3D entities or overwrite canonical state',()=>{
  const s=scene(),states=[make(1),make(2)];s.viewer=null;assert.equal(s.update(states,31),'waiting');assert.strictEqual(s.states,states);assert.equal(s.newCalls,0);
  s.fallback={};assert.equal(s.update(states,32),'fallback');assert.equal(s.newCalls,0);assert.strictEqual(s.states,states);near(distanceMeters(...s.fallbackCalls.at(-1)),9,1e-6);
});

test('vehicles removed or made invalid remain hidden, then can reappear',()=>{
  const s=scene();s.update([make(1),make(2)],40);s.update([make(1),make(2,{lon:null})],41);
  const hidden=s.vehicles.get('2');for(const key of ['entity','route','person','parcel','serviceLabel'])assert.equal(hidden[key].show,false,key);
  s.update([make(1),make(2)],42);assert.equal(hidden.entity.show,true);assert.equal(hidden.serviceLabel.show,true);assert.equal(s.newCalls,2);
});

test('consolidated badge escapes text and rejects injected attribute colors',()=>{
  const text='<script>&"\' 청주',content={title:text,detail:text,color:'"/><image href="bad" onload="evil()',selected:true};
  const badge=badgeSvg(content),svg=decodeURIComponent(badge.image.split(',').slice(1).join(','));
  assert.ok(svg.includes('&lt;script&gt;&amp;&quot;&apos;'));assert.ok(!svg.includes('<script>'));assert.ok(!svg.includes('<image'));assert.ok(!svg.includes('onload='));
  assert.ok(badge.width>0&&badge.height>0);assert.strictEqual(badgeSvg(content),badge);
  const focused=badgeContent(make(2,{status:'delivery'}),true),other=badgeContent(make(3),false);
  assert.equal(focused.title,'청주콜 02 · 배송');assert.equal(focused.detail,'2명  ·  물류 4개');assert.equal(other.title,'청주콜 03');assert.equal(other.detail,'');
});
