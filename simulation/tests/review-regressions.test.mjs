#!/usr/bin/env node
/** Regression cases for the reviewed HTML defects. No real network or API key. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import * as core from '../replay-core.js';
import * as boundary from '../boundary-data.js';

if (!vm.SourceTextModule) {
  const child=spawnSync(process.execPath,['--experimental-vm-modules',fileURLToPath(import.meta.url),...process.argv.slice(2)],{stdio:'inherit'});
  process.exit(child.status??1);
}

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const errors=[];let checks=0;
const check=(ok,message)=>{checks++;if(!ok)errors.push(message);};
const equal=(a,b,message)=>check(JSON.stringify(a)===JSON.stringify(b),`${message}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
const readJSON=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function flush(){for(let i=0;i<5;i++)await tick();}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

const unverifiedCoordinates=[[127.36,36.62],[127.37,36.63],[127.38,36.64]];
for(const fractions of [undefined,[0,1],[.1,.5,1],[0,.5,.9],[0,.8,.7,1],[0,NaN,1]]){
  check(core.sampleRoute({coordinates:unverifiedCoordinates,fractions},.5)===null,'Missing or malformed timing fractions must not invent a vertex-index route');
}
check(core.sampleRoute({coordinates:[...unverifiedCoordinates,[127.39,36.65]],fractions:[0,.8,.7,1]},.5)===null,'Backward timing fractions are rejected');
const unresolvedNetwork={depot:'DEPOT',nodes:{DEPOT:{lon:127.36,lat:36.62},DEST:{lon:127.38,lat:36.64}}};
const unresolvedRun={events:[{id:0,vehicle:1,kind:'TRANSIT',departure:30,time:34,completed:34,from:'DEPOT',to:'DEST',distanceKm:2,travelMin:4,passengers:0,cargo:0,pathId:'missingTime'}],routes:{missingTime:{coordinates:unverifiedCoordinates}},passengers:[],parcels:[]};
const unresolvedState=core.stateAt(core.prepareRun(unresolvedRun,unresolvedNetwork),32)[0];
equal(unresolvedState.status,'unknown','An unverified moving route is explicitly unresolved');
equal([unresolvedState.lon,unresolvedState.lat],[127.36,36.62],'An unverified route never fabricates an intermediate vehicle position');

class Element {
  constructor(id=''){
    this.id=id;this.dataset={};this.style={};this.children=[];this.listeners=new Map();this.attributes={};this.value='';this.hidden=false;this.disabled=false;this.open=false;this.textContent='';this.clientWidth=800;this.tagName='DIV';this._queries=new Map();
    const names=new Set();this.classList={add:x=>names.add(x),remove:x=>names.delete(x),contains:x=>names.has(x),toggle:(x,on)=>{const use=on===undefined?!names.has(x):!!on;use?names.add(x):names.delete(x);return use;}};
  }
  set innerHTML(value){this._html=String(value);this.children=value?[new Element()]:[];}
  get innerHTML(){return this._html||'';}
  get options(){return this.children;}
  setAttribute(key,value){this.attributes[key]=String(value);}
  getAttribute(key){return this.attributes[key]??null;}
  addEventListener(type,fn){const list=this.listeners.get(type)||[];list.push(fn);this.listeners.set(type,list);}
  async fire(type,event={}){for(const fn of this.listeners.get(type)||[])await fn({target:this,preventDefault(){},...event});}
  querySelector(selector){if(selector==='[data-scene-speed]')return null;if(selector==='[data-custom-speed]')return this.children.find(node=>node.dataset.customSpeed!==undefined)||null;if(!this._queries.has(selector))this._queries.set(selector,new Element(selector));return this._queries.get(selector);}
  append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
  add(node){this.append(node);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);}
  focus(){}
  scrollIntoView(){}
  showModal(){this.open=true;}
  close(){this.open=false;}
  getContext(){return new Proxy({},{get:(target,key)=>key in target?target[key]:()=>{},set:(target,key,value)=>{target[key]=value;return true;}});}
}

async function appHarness({boundaryStatus=200,boundaryJSON,delayBoundary}={}){
  const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,new Element(id));return elements.get(id);};
  const scenes=[],roadviews=[],researches=[],preparedCalls=[],requests=[],fetchWait=new Map(),raf=[],caught=[],downloads=[],blobs=new Map(),fetchOptions=[];
  get('boundary-fill').checked=true;
  let now=0,frameId=0;
  const cameras=['overview','follow','eye','interior','roadview','decision'].map(mode=>{const element=new Element('camera-'+mode);element.dataset.camera=mode;return element;});
  const document={getElementById:get,querySelectorAll:selector=>selector==='[data-camera]'?cameras:[],querySelector:selector=>get(selector),activeElement:null,body:new Element('body'),addEventListener(){},createElement:tag=>{const e=new Element(tag);e.click=()=>downloads.push({href:e.href,name:e.download});return e;}};
  const window={devicePixelRatio:1,addEventListener(){}};
  class DownloadURL extends URL{static createObjectURL(blob){const id=`blob:synthetic-${blobs.size}`;blobs.set(id,blob);return id;}static revokeObjectURL(id){blobs.delete(id);}}
  class Scene {
    constructor(container,options={}){this.container=container;this.options=options;this.isReady=false;this.networks=[];this.updates=[];this.cameras=[];this.engine='waiting';this.boundaries=[];this.boundaryOptions={};this.boundaryZooms=0;scenes.push(this);}
    async init(){this.options.onStatus?.({engine:'waiting',ready:false,level:'waiting',message:'키 입력 대기',imagery:'대기',terrain:'대기',buildings:'대기'});return this;}
    async useCesium(){this.isReady=true;this.engine='cesium';this.options.onStatus?.({engine:'cesium',ready:true,level:'ready',imagery:'시험 지도',terrain:'시험 지형',buildings:'미연결'});return true;}
    async setProviderSettings(){return this.useCesium();}
    setNetwork(network){this.networks.push(network);}
    update(states,time){this.updates.push({states,time});}
    setCamera(...args){this.cameras.push(args);}
    setWaitingPassengers(){}
    setLayers(){}
    setPassengerBubblesEnabled(value){this.bubblesEnabled=value;}
    setPassengerFeedbackProvider(provider){this.feedbackProvider=provider;}
    updatePassengerBubbles(){}
    setBoundary(model,options={}){if(this.failBoundary)throw new Error('Synthetic renderer failure');this.boundaries.push(model);this.boundary=model;this.boundaryOptions={...options};}
    clearBoundary(){this.boundary=null;}
    setBoundaryOptions(options){Object.assign(this.boundaryOptions,options);}
    zoomBoundary(){this.boundaryZooms++;return !!this.boundary;}
    resize(){}
  }
  class Roadview {
    constructor(container,options){this.options=options;this.isReady=false;this.active=false;this.updates=[];this.resets=0;roadviews.push(this);}
    setActive(active){this.active=active;}
    async connect(){this.isReady=true;this.options.onStatus({ready:true,phase:'ready',message:'시험 로드뷰'});return true;}
    update(state,options){this.updates.push({state,options});}
    reset(){this.resets++;}
    setFollowHeading(value){this.follow=value;}
    refresh(){this.refreshes=(this.refreshes||0)+1;}
  }
  class ResearchWorkspace {
    constructor(){this.contexts=[];this.runs=[];this.visibility={};researches.push(this);}
    setActive(camera){this.camera=camera;} setRun(run){this.runs.push(run);this.data=run?readJSON(path.join(root,'data/decisions',run.id+'.json')):null;} setScrubbing(value){this.scrubbing=value;} update(context){this.contexts.push(context);} updateScene(){} attachScene(scene){this.scene=scene;} setEnvironmentVisible(kind,visible){this.visibility[kind]=visible;} destroy(){}
  }
  const context=vm.createContext({console:{log(){},error(...items){caught.push(items.map(String).join(' '));},warn(){}},document,window,
    performance:{now:()=>now},URLSearchParams,URL:DownloadURL,Blob,Intl,Map,Set,Date,Math,Number,JSON,Promise,
    history:{replaceState(){}},location:{search:'?date=2023-11-06&scenario=S1&mode=integrated',pathname:'/index.html'},
    Option:class extends Element{constructor(text,value){super();this.textContent=text;this.value=value;}},
    requestAnimationFrame:fn=>{fn.frameId=++frameId;raf.push(fn);return fn.frameId;},cancelAnimationFrame:id=>{const i=raf.findIndex(fn=>fn.frameId===id);if(i>=0)raf.splice(i,1);},setTimeout(){return 1;},clearTimeout(){},
    fetch:async (url,options)=>{
      const relative=String(url).replace(/^\.\//,'');requests.push(relative);
      fetchOptions.push({url:relative,options});
      if(relative==='data/gangnae_boundary.geojson'){
        if(delayBoundary)await delayBoundary.promise;
        return {ok:boundaryStatus>=200&&boundaryStatus<300,status:boundaryStatus,json:async()=>boundaryJSON??readJSON(path.join(root,relative))};
      }
      if(fetchWait.has(relative))await fetchWait.get(relative).promise;
      const local=path.resolve(root,relative);if(!local.startsWith(root+path.sep))throw new Error('Unexpected data URL');
      return {ok:true,status:200,json:async()=>readJSON(local)};
    }});
  const coreModule=new vm.SyntheticModule(Object.keys(core),function(){for(const [name,value]of Object.entries(core))this.setExport(name,name==='prepareRun'?(run,network)=>{preparedCalls.push(run.id);return value(run,network);}:value);},{context});
  const sceneModule=new vm.SyntheticModule(['default','MetroScene'],function(){this.setExport('default',Scene);this.setExport('MetroScene',Scene);},{context});
  const boundaryModule=new vm.SyntheticModule(Object.keys(boundary),function(){for(const [name,value]of Object.entries(boundary))this.setExport(name,value);},{context});
  const roadviewModule=new vm.SyntheticModule(['default'],function(){this.setExport('default',Roadview);},{context});
  const researchModule=new vm.SyntheticModule(['default'],function(){this.setExport('default',ResearchWorkspace);},{context});
  const feedbackModule=new vm.SourceTextModule(fs.readFileSync(path.join(root,'passenger-feedback.js'),'utf8'),{context,identifier:'passenger-feedback.js'});
  const presentationModule=new vm.SourceTextModule(fs.readFileSync(path.join(root,'presentation-controls.js'),'utf8'),{context,identifier:'presentation-controls.js'});
  const module=new vm.SourceTextModule(fs.readFileSync(path.join(root,'app.js'),'utf8'),{context,identifier:'app.js'});
  await module.link(input=>{const specifier=input.split('?')[0];return specifier.endsWith('passenger-feedback.js')?feedbackModule:specifier.endsWith('presentation-controls.js')?presentationModule:specifier.endsWith('research-workspace.js')?researchModule:specifier.endsWith('roadview.js')?roadviewModule:specifier.endsWith('replay-core.js')?coreModule:specifier.endsWith('boundary-data.js')?boundaryModule:specifier.endsWith('scene3d.js')||specifier.endsWith('vworld-scene.js')?sceneModule:Promise.reject(new Error(`Unexpected module ${specifier}`));});
  await module.evaluate();await flush();
  return {context,elements,get,scenes,roadviews,researches,preparedCalls,requests,fetchWait,raf,caught,downloads,blobs,fetchOptions,
    async camera(mode){await cameras.find(x=>x.dataset.camera===mode).fire('click');await flush();},
    async frame(ms=200){now+=ms;const callbacks=raf.splice(0);for(const next of callbacks)next(now);await tick();},
    async seek(t){get('time-slider').value=String(t);await get('time-slider').fire('input');await get('time-slider').fire('change');await flush();},
    async scenario(id){await get('scenario-control').fire('click',{target:{closest:()=>({dataset:{scenario:id}})}});await flush();},
    async upload(geo){await get('network-upload').fire('change',{target:{files:[{size:200,name:'test.geojson',text:async()=>JSON.stringify(geo)}]}});await flush();},
    async uploadBoundary(geo,{size=200,name='SYNTHETIC-test-boundary.geojson',text}={}){await get('boundary-upload').fire('change',{target:{files:[{size,name,text:text??(async()=>JSON.stringify(geo))}]}});await flush();}
  };
}

const h=await appHarness(),scene=h.scenes[0];
check(scene!==undefined,'Application constructs the map adapter');
check(h.context.Cesium===undefined,'No implicit Cesium global was supplied');
check(h.preparedCalls.length===1,'Research data loads while the map is awaiting a key');
check(h.get('play-button').disabled,'Playback is disabled until a map is ready');
check(h.get('scene-button').disabled,'Service animation is disabled until a map is ready');
check(h.get('map-start').hidden===false,'Map choice remains visible before readiness');
const waitingTime=scene.updates.at(-1)?.time;
await h.get('play-button').fire('click');
for(let i=0;i<10;i++)await h.frame(1000);
equal(scene.updates.at(-1)?.time,waitingTime,'Clicking play while the SDK is absent does not advance research time');
check(h.caught.length===0,'Startup without Cesium does not raise an error');
await h.get('start-cesium-map').fire('click');await flush();
check(scene.isReady,'Explicit fallback map action completes');
check(!h.get('play-button').disabled,'Playback enables after both data and map readiness');
equal(scene.updates.at(-1)?.states.map(s=>s.id),[1,2,3],'All three vehicles are present');

await h.seek(360);
const originalNetwork=scene.networks.at(-1),originalNetworkJSON=JSON.stringify(originalNetwork),beforeStates=JSON.stringify(scene.updates.at(-1).states),beforePrepared=h.preparedCalls.length;
const lines=[[[127.35,36.61],[127.351,36.61]],[[127.40,36.67],[127.401,36.67]]];
await h.upload({type:'FeatureCollection',features:lines.map(coordinates=>({type:'Feature',properties:{},geometry:{type:'LineString',coordinates}}))});
const overlay=scene.networks.at(-1);
equal(overlay.roads.slice(-2).map(r=>r.coordinates),lines,'Disconnected GeoJSON lines stay separate without invented joining/closing chords');
equal(overlay.roads.length,originalNetwork.roads.length+2,'Only two background line features are added');
equal(JSON.stringify(originalNetwork),originalNetworkJSON,'GeoJSON import does not mutate the validated network');
equal(h.preparedCalls.length,beforePrepared,'GeoJSON import does not replace the execution route');
await h.seek(360);
equal(JSON.stringify(scene.updates.at(-1).states),beforeStates,'GeoJSON import preserves all recorded vehicle positions and counts');
const lastNetworkCount=scene.networks.length;
await h.upload({type:'FeatureCollection',features:[{type:'Feature',geometry:{type:'LineString',coordinates:[[127.36,36.62]]}}]});
equal(scene.networks.length,lastNetworkCount,'Single-position LineString is rejected');
await h.upload({type:'FeatureCollection',features:[{type:'Feature',geometry:{type:'LineString',coordinates:[[127.36,36.62],[960000,1840000]]}}]});
equal(scene.networks.length,lastNetworkCount,'Every coordinate is validated, including later projected-coordinate positions');
await h.upload({type:'FeatureCollection',features:null});
equal(scene.networks.length,lastNetworkCount,'Malformed feature collection is rejected without changing the scene');

const manifest=readJSON(path.join(root,'data/manifest.json'));
const s0=manifest.runs.find(r=>r.date==='2023-11-06'&&r.mode==='integrated'&&r.scenario==='S0');
const s2=manifest.runs.find(r=>r.date==='2023-11-06'&&r.mode==='integrated'&&r.scenario==='S2');
const slow0=deferred(),slow2=deferred();h.fetchWait.set(s0.url.replace(/^\.\//,''),slow0);h.fetchWait.set(s2.url.replace(/^\.\//,''),slow2);
await h.scenario('S0');await h.scenario('S2');
check(h.get('play-button').disabled,'Playback pauses while changing an execution dataset');
const loadTime=scene.updates.at(-1)?.time;
await h.get('play-button').fire('click');for(let i=0;i<3;i++)await h.frame(1000);
equal(scene.updates.at(-1)?.time,loadTime,'Unresolved run fetch cannot advance old-run time');
slow2.resolve();await flush();
equal(h.preparedCalls.at(-1),s2.id,'Newer scenario result becomes active first');
slow0.resolve();await flush();
equal(h.preparedCalls.at(-1),s2.id,'A late previous scenario response cannot overwrite the current run');

await h.seek(989.9);await h.get('play-button').fire('click');
for(let i=0;i<5;i++)await h.frame(200);
equal(scene.updates.at(-1)?.time,990,'Playback stops at the recorded day end instead of an 80-second loop');
equal(h.get('play-button').getAttribute('aria-label'),'재생','Day-end playback is paused');
equal(scene.updates.at(-1)?.states.map(s=>[s.passengers,s.cargo]),[[0,0],[0,0],[0,0]],'All vehicles finish with no unserved load');
await h.seek(540);const once=JSON.stringify(scene.updates.at(-1).states);await h.seek(60);await h.seek(900);await h.seek(540);
equal(JSON.stringify(scene.updates.at(-1).states),once,'UI timeline seeking is deterministic in both directions');
check(h.caught.length===0,'Application regression cases have no caught initialization errors');

// Default boundary is the exact supplied QGIS export, not a screenshot trace.
const suppliedBoundary=readJSON(path.join(root,'gangnae_boundary.geojson'));
equal(scene.boundary.geojson.features,suppliedBoundary.features,'Default boundary uses the supplied QGIS features');
equal(scene.boundaryOptions,{visible:true,fill:false},'Default boundary has no fill');
check(!h.get('boundary-toggle').disabled&&!h.get('boundary-fit').disabled,'Installed boundary supports visibility and fit');
check(h.fetchOptions.some(item=>item.url==='data/gangnae_boundary.geojson'&&item.options?.cache==='no-store'),'Default boundary is fetched without stale browser cache');
const beforeBoundary=JSON.stringify(scene.updates.at(-1)),preparedBeforeBoundary=h.preparedCalls.length;
await h.get('boundary-toggle').fire('change',{target:{checked:false}});
equal(scene.boundaryOptions,{visible:false,fill:false},'Hide keeps boundary unfilled');
await h.get('boundary-toggle').fire('change',{target:{checked:true}});
equal(scene.boundaryOptions,{visible:true,fill:false},'Restoring the boundary cannot enable fill');
await h.get('boundary-fit').fire('click');equal(scene.boundaryZooms,1,'Fit uses the existing boundary camera');
equal(h.preparedCalls.length,preparedBeforeBoundary,'Boundary controls do not recompute research routes');
equal(JSON.stringify(scene.updates.at(-1)),beforeBoundary,'Boundary controls preserve canonical vehicle states');
const preMap=await appHarness();
check(preMap.scenes[0].boundary&&!preMap.scenes[0].isReady,'Default boundary is cached before the map connects');
check(preMap.get('boundary-fit').disabled&&!preMap.get('boundary-toggle').disabled,'Only camera fit needs a ready map');
const absent=await appHarness({boundaryStatus:404});
check(absent.preparedCalls.length===1&&absent.caught.length===0,'Missing boundary does not block research data');
check(absent.get('boundary-status').textContent.includes('불러오지 못했습니다'),'Missing packaged boundary reports a file error');
check(!absent.scenes[0].boundary,'No substitute boundary is fabricated');
const malformed=await appHarness({boundaryJSON:{type:'FeatureCollection',features:[]}});
check(!malformed.scenes[0].boundary&&malformed.get('boundary-toggle').disabled,'An empty default is not accepted as a real boundary');
const pendingDefault=deferred(),lateDefault=await appHarness({delayBoundary:pendingDefault});
check(!lateDefault.scenes[0].boundary,'No boundary is drawn before the source is read');
pendingDefault.resolve();await flush();check(!!lateDefault.scenes[0].boundary,'Delayed default loads automatically');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
check(!html.includes('id="boundary-upload"')&&!html.includes('id="boundary-fill"'),'Default boundary needs no chooser or fill control');

// Roadview shares the same replay state and does not replace the VWorld adapter.
const rvHarness=await appHarness(),rv=rvHarness.roadviews[0],rvScene=rvHarness.scenes[0];
check(!rv.active&&!rv.isReady,'Roadview does not load a remote SDK at startup');
await rvHarness.get('connect-roadview').fire('click');await flush();
check(rv.active&&rv.isReady,'Explicit Roadview connection activates the extra mode');
check(!rvScene.isReady,'Roadview does not silently start or replace the 3D engine');
check(!rvHarness.get('play-button').disabled&&rvHarness.get('scene-button').disabled,'Roadview permits replay; 3D service preview still requires 3D');
await rvHarness.seek(360);
equal(rv.updates.at(-1).state,{...rvScene.updates.at(-1).states[0],time:360},'Roadview receives the canonical selected state, without display spacing');
const resets=rv.resets;
await rvHarness.get('vehicle-list').fire('click',{target:{closest:()=>({dataset:{vehicle:'2'}})}});
check(rv.active&&rv.resets>resets,'Changing vehicle keeps Roadview mode and resets stale responses');
equal(rv.updates.at(-1).state.id,2,'Roadview follows the selected vehicle');
await rvHarness.seek(40);const early=JSON.stringify(rv.updates.at(-1).state);
await rvHarness.seek(500);await rvHarness.seek(40);
equal(JSON.stringify(rv.updates.at(-1).state),early,'Roadview canonical positions rewind deterministically');
await rvHarness.get('roadview-heading').fire('change',{target:{checked:false}});check(rv.follow===false,'Heading lock can be disabled for manual viewing');
await rvHarness.get('focus-button').fire('click');check(!rv.active,'Existing 3D camera buttons leave Roadview');
check(rvHarness.get('play-button').disabled,'Returning to unconnected 3D preserves the map readiness gate');
check(rvHarness.caught.length===0,'Roadview app integration has no startup errors');

// The new split mode follows the same canonical clock, selection and run.
const split=await appHarness();await split.get('start-cesium-map').fire('click');await flush();
await split.camera('decision');
check(split.get('.map-stage').classList.contains('is-decision'),'Decision mode activates the optional split container');
check(!split.get('dispatch-panel').hidden,'Decision panel is visible in split mode');
equal(split.scenes[0].cameras.at(-1),['follow',1],'Left map follows the selected vehicle in decision mode');
await split.get('vehicle-list').fire('click',{target:{closest:()=>({dataset:{vehicle:'2'}})}});await flush();
equal(split.scenes[0].cameras.at(-1),['follow',2],'Vehicle selection preserves split mode and updates the left camera');
await split.seek(152.5166667);
equal(split.researches[0].contexts.at(-1).time,152.5166667,'Decision panel and left map share the exact replay clock');
equal(split.researches[0].contexts.at(-1).selected,2,'Decision panel receives the selected canonical vehicle ID');
const splitRun=split.researches[0].contexts.at(-1).run,splitHash=JSON.stringify(splitRun);
const jump=splitRun.events.find(e=>e.vehicle===1&&e.to&&e.kind==='PU');
await split.get('panel-content').fire('click',{target:{closest:()=>({dataset:{event:String(jump.id)}})}});await flush();
check(split.get('.map-stage').classList.contains('is-decision'),'Selecting a service event retains decision split mode');
equal(split.scenes[0].cameras.at(-1),['follow',1],'Service-event jump follows that event vehicle without leaving split mode');
await split.get('environment-bridges').fire('change',{target:{checked:false}});await flush();
equal(split.researches[0].visibility.bridges,false,'Environment checkbox reaches the independent display layer');
const priorFacilityRefreshes=split.researches[0].contexts.length,pausedFacilityTime=split.researches[0].contexts.at(-1).time;
await split.get('stops-toggle').fire('change',{target:{checked:false}});await flush();
check(split.researches[0].contexts.length>priorFacilityRefreshes,'Facility visibility refreshes the display workspace even while replay is paused');
equal(split.researches[0].contexts.at(-1).time,pausedFacilityTime,'Changing facility priority does not advance simulation time');
equal(JSON.stringify(splitRun),splitHash,'Camera, selection, seeking and environment controls leave original run data unchanged');
await split.camera('overview');check(split.get('dispatch-panel').hidden,'Leaving decision mode hides its panel');
check(!split.get('.map-stage').classList.contains('is-decision'),'Normal camera mode restores the full map container');
check(split.caught.length===0,'Decision integration introduces no initialization or interaction error');

// V7 presentation wiring uses real calls and the actual app event handlers.
// The mock scene isolates the clock/UI contract from browser GPU availability.
const presentationHarness=await appHarness(),presentationScene=presentationHarness.scenes[0],presentationRoadview=presentationHarness.roadviews[0];
await presentationHarness.get('start-cesium-map').fire('click');await flush();
const presentationRun=readJSON(path.join(root,'data/runs/2023-11-06_integrated_S1.json'));
const callSequence=[...presentationRun.passengers].sort((a,b)=>a.call-b.call),firstPassenger=callSequence[0],secondPassenger=callSequence[1],thirdPassenger=callSequence[2];
const presentationNetwork=presentationScene.networks.at(-1);
equal(presentationScene.bubblesEnabled,true,'V7 passenger bubbles default to enabled');
check(typeof presentationScene.feedbackProvider==='function','App installs the passenger feedback provider on the actual scene adapter');

presentationHarness.get('speed-number').value='72.5';await presentationHarness.get('speed-number').fire('input');
equal(presentationHarness.get('speed-range').value,'72.5','Fractional numeric speed reaches the range control without a preset snap');
equal(presentationHarness.get('speed-select').value,'72.5','Fractional numeric speed reaches the legacy hidden speed select');
check(presentationHarness.get('speed-select').options.some(option=>option.value==='72.5'),'Hidden select contains the chosen intermediate speed');
presentationHarness.get('speed-number').value='45.5';await presentationHarness.get('speed-number').fire('change');
equal(presentationHarness.get('speed-select').options.filter(option=>option.dataset.customSpeed).length,1,'Changing a custom speed replaces its prior select option');
presentationHarness.get('speed-number').value='72.5';await presentationHarness.get('speed-number').fire('change');

const beforeCall=firstPassenger.call-.1;await presentationHarness.seek(beforeCall);
check(presentationHarness.get('passenger-call-alert').hidden,'Seeking just before a call does not announce a future passenger');
await presentationHarness.get('play-button').fire('click');await presentationHarness.frame(200);
const afterCall=presentationScene.updates.at(-1).time;
check(Math.abs(afterCall-(beforeCall+.2*72.5/60))<1e-10,'Fractional speed advances the canonical clock by the requested rate');
check(!presentationHarness.get('passenger-call-alert').hidden,'Normal playback crossing a recorded call shows the large call notification');
equal(presentationHarness.get('call-alert-origin').textContent,presentationNetwork.nodes[firstPassenger.pickupNode].label,'Call notification origin comes from the recorded passenger node');
equal(presentationHarness.get('call-alert-destination').textContent,presentationNetwork.nodes[firstPassenger.dropoffNode].label,'Call notification destination comes from the recorded passenger node');
equal(presentationHarness.get('call-alert-time').textContent,core.clock(firstPassenger.call,true),'Call notification time is the original call time');
equal(presentationHarness.get('play-button').getAttribute('aria-label'),'일시정지','Showing a call alert does not pause playback');
const shownClock=core.clock(afterCall,true);
equal(presentationHarness.get('clock').innerHTML,`${shownClock.slice(0,5)}<span>${shownClock.slice(5)}</span>`,'The visible clock matches fractional-speed simulation time');
await presentationHarness.get('dismiss-call-alert').fire('click');
check(presentationHarness.get('passenger-call-alert').hidden,'The individual dismiss button closes a call notification');
equal(presentationHarness.get('play-button').getAttribute('aria-label'),'일시정지','Dismissing a call notification preserves running playback');
await presentationHarness.frame(200);check(presentationScene.updates.at(-1).time>afterCall,'Simulation continues after dismissing a call alert');

presentationHarness.get('call-alerts-enabled').checked=false;await presentationHarness.get('call-alerts-enabled').fire('change');
await presentationHarness.seek(secondPassenger.call-.1);await presentationHarness.get('play-button').fire('click');await presentationHarness.frame(200);
check(presentationHarness.get('passenger-call-alert').hidden,'Disabling call notifications suppresses the next actual call');
equal(presentationHarness.get('play-button').getAttribute('aria-label'),'일시정지','Disabled notifications do not disable playback');
presentationHarness.get('call-alerts-enabled').checked=true;await presentationHarness.get('call-alerts-enabled').fire('change');
await presentationHarness.frame(200);check(presentationHarness.get('passenger-call-alert').hidden,'Re-enabling alerts does not replay calls received while notifications were disabled');
await presentationHarness.seek(thirdPassenger.call-.1);await presentationHarness.get('play-button').fire('click');await presentationHarness.frame(200);
check(!presentationHarness.get('passenger-call-alert').hidden,'Re-enabled alerts announce the next newly crossed call');
presentationHarness.get('call-alerts-enabled').checked=false;await presentationHarness.get('call-alerts-enabled').fire('change');
check(presentationHarness.get('passenger-call-alert').hidden,'Turning alerts off dismisses an alert that is already visible');
equal(presentationHarness.get('play-button').getAttribute('aria-label'),'일시정지','Turning off a visible alert does not pause the simulation');
presentationHarness.get('call-alerts-enabled').checked=true;await presentationHarness.get('call-alerts-enabled').fire('change');
await presentationHarness.seek(989);
check(presentationHarness.get('passenger-call-alert').hidden,'A forward timeline jump over many calls does not show a historical-call storm');
await presentationHarness.get('play-button').fire('click');await presentationHarness.frame(200);
check(presentationHarness.get('passenger-call-alert').hidden,'Resuming after a forward jump does not announce previously skipped calls');

const previewUpdates=presentationScene.updates.length,previewResets=presentationRoadview.resets,previewRoadviewUpdates=presentationRoadview.updates.length;
for(const time of [70,80,90]){presentationHarness.get('time-slider').value=String(time);await presentationHarness.get('time-slider').fire('input');}
equal(presentationScene.updates.length,previewUpdates,'A burst of slider inputs does not synchronously render each intermediate time');
equal(presentationRoadview.resets,previewResets+1,'One scrub session resets stale Roadview work only once');
equal(presentationHarness.researches[0].scrubbing,true,'Slider preview suspends expensive environment refresh');
await presentationHarness.frame(200);
equal(presentationScene.updates.length,previewUpdates+1,'Slider inputs coalesce into one preview render per frame');
equal(presentationScene.updates.at(-1).time,90,'The coalesced preview uses the latest requested time');
equal(presentationRoadview.updates.length,previewRoadviewUpdates,'Intermediate scrub previews do not request new Roadview views');
await presentationHarness.get('time-slider').fire('change');await flush();
equal(presentationHarness.researches[0].scrubbing,false,'Finishing a scrub resumes environment updates');
equal(presentationRoadview.updates.at(-1).state.time,90,'The final committed seek updates Roadview at the latest target');
equal(presentationHarness.researches[0].contexts.at(-1).time,90,'The decision workspace receives the same final seek time');
check(presentationHarness.get('passenger-call-alert').hidden,'Backward scrub completion leaves historical call notifications hidden');

await presentationHarness.seek(firstPassenger.pickup);
const boardingFeedback=presentationScene.feedbackProvider({animation:{kind:'boarding',requestId:firstPassenger.id}},firstPassenger.pickup);
check(boardingFeedback.available&&Math.abs(boardingFeedback.waitMin-firstPassenger.wait)<1e-7,'The scene feedback provider receives the original passenger wait');
equal(presentationScene.feedbackProvider({animation:{kind:'boarding',requestId:firstPassenger.id}},firstPassenger.pickup-.01),null,'The scene provider cannot reveal boarding results before pickup');
const alightingFeedback=presentationScene.feedbackProvider({animation:{kind:'alighting',requestId:firstPassenger.id}},firstPassenger.dropoff);
check(alightingFeedback.available&&alightingFeedback.baseline.reference==='first_committed_plan_at_assignment','App wiring supplies validated original decision data to the alighting feedback');
presentationHarness.get('bubble-enabled').checked=false;await presentationHarness.get('bubble-enabled').fire('change');
equal(presentationScene.bubblesEnabled,false,'The bubble setting reaches the scene adapter');
presentationHarness.get('bubble-enabled').checked=true;await presentationHarness.get('bubble-enabled').fire('change');
equal(presentationScene.bubblesEnabled,true,'The bubble setting can restore passenger feedback');
check(presentationHarness.caught.length===0,'V7 call alerts, flexible speed, scrub and speech-bubble wiring raise no application errors');

// Exercise the real adapter's callback helper without any browser/SDK request.
const {default:VWorldScene,waitForVWorldViewer,readTerrainHeight}=await import('../vworld-scene.js');
// Patch the adapter's actual superclass, including its cache-versioned module URL.
const CesiumScene=Object.getPrototypeOf(VWorldScene);

const hostHTML=fs.readFileSync(path.join(root,'vworld-host.html'),'utf8');
const hostScript=hostHTML.match(/<script>([\s\S]*?)<\/script>/)?.[1];
check(!!hostScript,'A real same-origin VWorld host page is packaged');
function hostBootstrap(key){
  const frame=key===null?null:{__metroVWorldBootstrap:{apiKey:key}},writes=[],window={frameElement:frame};
  vm.runInNewContext(hostScript,{window,document:{write:value=>writes.push(value)},encodeURIComponent,String});
  return {frame,writes,window};
}
const testKey='example key+"&<value>',host=hostBootstrap(testKey);
check(!Object.hasOwn(host.frame,'__metroVWorldBootstrap'),'Host removes the transient bootstrap key after reading it');
equal(host.writes.length,1,'Host writes one SDK script during its own initial parse');
const injected=host.writes[0].match(/src="([^"]+)"/)?.[1]?.replaceAll('&amp;','&').replaceAll('&quot;','"');
const sdkURL=new URL(injected);
equal(sdkURL.origin+sdkURL.pathname,'https://map.vworld.kr/js/webglMapInit.js.do','SDK key is routed only to the official SDK endpoint');
equal(sdkURL.searchParams.get('apiKey'),testKey,'SDK key is correctly URL encoded');
check(host.window.__metroVWorldSdk.failed===false,'Nonempty key bootstrap enters loading state');
for(const missing of ['',null]){const absent=hostBootstrap(missing);equal(absent.writes.length,0,'Missing key never creates a script request');check(absent.window.__metroVWorldSdk.failed===true,'Missing key is reported as a host startup failure');}

// SDK constructors can precede Cesium: Map.start may initialise the renderer.
// This end-to-end adapter probe mocks only DOM and GPU binding, not its startup gates.
const savedDocument=globalThis.document,savedTimeout=globalThis.setTimeout,savedExternalInit=CesiumScene.prototype.initExternalViewer;
let createdFrame,externalBindings=0,mapStarts=0;
const scope={vw:{},ws3d:{},document:{getElementById:id=>id==='vmap'?{}:null},__metroVWorldSdk:{loaded:true,failed:false}};
scope.vw.CameraPosition=scope.vw.CoordZ=scope.vw.Direction=class{};
scope.vw.Map=class{setOption(){}start(){mapStarts++;scope.Cesium={Cartesian3:{}};scope.ws3d.viewer=fakeViewerForStartup();scope.vw.ws3dInitCallBack?.();}};
function fakeViewerForStartup(){return {scene:{globe:{}},entities:{add(){}},camera:{},isDestroyed:()=>false,destroy(){}};}
const makeAdapter=()=>{const adapter=Object.create(VWorldScene.prototype);Object.assign(adapter,{destroyed:false,_ready:false,_selectedEngine:'vworld',engine:'vworld',_activeKey:testKey,provider:{},network:{depot:'DEPOT',nodes:{DEPOT:{lon:127.3616417,lat:36.6237876}}},host:{replaceChildren(){}},vehicles:new Map(),terrainHeights:new Map(),heightRequests:new Set(),_status(){},_watchVWorldProviders(){},_setVWorldBuildings(){}});return adapter;};
try{
  globalThis.setTimeout=(fn,ms,...args)=>savedTimeout(fn,Math.min(ms,120),...args);
  globalThis.document={createElement:tag=>{check(tag==='iframe','VWorld renderer gets an isolated iframe');createdFrame={style:{},contentWindow:scope,setAttribute(){},remove(){this.removed=true;}};return createdFrame;}};
  CesiumScene.prototype.initExternalViewer=async function(viewer,C){externalBindings++;this.viewer=viewer;this.C=C;return this;};
  const adapter=makeAdapter(),started=await adapter._startVWorld(testKey,{});
  check(started&&adapter.isReady,'VWorld starts when constructors exist before Cesium');
  equal(mapStarts,1,'Map.start is invoked exactly once');equal(externalBindings,1,'External renderer binds once after viewer readiness');
  const childURL=new URL(createdFrame.src);
  check(childURL.pathname.endsWith('/vworld-host.html'),'Iframe navigates to the packaged real host page');
  equal(childURL.search,'','The frame URL contains no API-key query');equal(childURL.hash,'','The frame URL contains no API-key fragment');check(!('srcdoc' in createdFrame),'About:srcdoc is not used as the registered map document');
  adapter._clearVWorldFrame();
  delete scope.Cesium;scope.ws3d={};
  CesiumScene.prototype.initExternalViewer=async()=>{throw new Error('GPU binding failed');};
  const failed=makeAdapter(),ok=await failed._startVWorld(testKey,{});
  check(ok===false&&!failed.isReady,'Renderer binding failure cannot become a ready map');
  check(createdFrame.removed===true,'A failed VWorld frame is removed before another engine may be selected');
  equal(failed._selectedEngine,null,'Failure releases the selected-engine lock');
}finally{
  if(savedDocument===undefined)delete globalThis.document;else globalThis.document=savedDocument;
  globalThis.setTimeout=savedTimeout;CesiumScene.prototype.initExternalViewer=savedExternalInit;
}

for(const value of [0,-12.5,71.25]){
  equal(readTerrainHeight(value),value,'Numeric terrain height remains numeric, including zero and negative heights');
  equal(readTerrainHeight({height:value}),value,'VWorld-style object terrain height is extracted');
}
for(const value of [undefined,null,NaN,Infinity,{}, {height:NaN},{height:Infinity},{height:'45'},'45'])check(readTerrainHeight(value)===undefined,'Missing/invalid terrain height must remain unknown, never a fabricated 45 m');

const native={setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout,setInterval:globalThis.setInterval,clearInterval:globalThis.clearInterval};
const pendingTimeouts=new Set(),pendingIntervals=new Set();
globalThis.setTimeout=(fn,ms,...args)=>{let id;id=native.setTimeout(()=>{pendingTimeouts.delete(id);fn(...args);},ms);pendingTimeouts.add(id);return id;};
globalThis.clearTimeout=id=>{pendingTimeouts.delete(id);return native.clearTimeout(id);};
globalThis.setInterval=(fn,ms,...args)=>{const id=native.setInterval(fn,ms,...args);pendingIntervals.add(id);return id;};
globalThis.clearInterval=id=>{pendingIntervals.delete(id);return native.clearInterval(id);};
const timersCleared=label=>{equal(pendingTimeouts.size,0,`${label}: timeout cleaned`);equal(pendingIntervals.size,0,`${label}: polling cleaned`);};
const fakeViewer=()=>({scene:{globe:{}},entities:{add(){}},camera:{}});
const makeScope=()=>({vw:{},Cesium:{Cartesian3:{}},ws3d:{}});
try{
  {
    const scope=makeScope(),viewer=fakeViewer();scope.ws3d.viewer=viewer;let started=0;
    const previous=()=>{};scope.vw.ws3dInitCallBack=previous;
    const result=await waitForVWorldViewer(scope,{start:()=>started++,timeoutMs:50,pollMs:2});
    check(result.viewer===viewer,'Already available VWorld viewer resolves immediately');
    equal(started,0,'Already available viewer is not started twice');check(scope.vw.ws3dInitCallBack===previous,'Existing callback restored after immediate readiness');timersCleared('Already-ready viewer');
  }
  {
    const scope=makeScope(),viewer=fakeViewer();let chained=0,installedBeforeStart=false,callback,resolutions=0;
    const previous=()=>chained++;scope.vw.ws3dInitCallBack=previous;
    await waitForVWorldViewer(scope,{timeoutMs:50,pollMs:2,start:()=>{callback=scope.vw.ws3dInitCallBack;installedBeforeStart=callback!==previous&&typeof callback==='function';scope.ws3d.viewer=viewer;callback('ready');callback('duplicate');}}).then(()=>resolutions++);
    check(installedBeforeStart,'VWorld callback is installed before a synchronous map.start notification');
    equal(resolutions,1,'Duplicate SDK callbacks settle readiness once');check(chained>=1,'Pre-existing SDK callback remains chained');check(scope.vw.ws3dInitCallBack===previous,'Previous callback is restored after synchronous readiness');timersCleared('Synchronous callback');
  }
  {
    const scope=makeScope(),viewer=fakeViewer();
    const result=await waitForVWorldViewer(scope,{timeoutMs:100,pollMs:2,start:()=>native.setTimeout(()=>scope.ws3d.viewer=viewer,8)});
    check(result.viewer===viewer,'Delayed global viewer is found even when the SDK does not call the callback');timersCleared('Delayed viewer');
  }
  {
    const scope=makeScope();const previous=()=>{};scope.vw.ws3dInitCallBack=previous;let error;
    try{await waitForVWorldViewer(scope,{timeoutMs:12,pollMs:2,start(){}});}catch(e){error=e;}
    equal(error?.code,'VWORLD_VIEWER_TIMEOUT','No-viewer initialization fails with a bounded timeout');check(scope.vw.ws3dInitCallBack===previous,'Previous callback is restored after timeout');timersCleared('Viewer timeout');
  }
  {
    const scope=makeScope(),controller=new AbortController();let error;
    const operation=waitForVWorldViewer(scope,{timeoutMs:100,pollMs:2,signal:controller.signal,start(){}});controller.abort();
    try{await operation;}catch(e){error=e;}
    equal(error?.code,'VWORLD_CANCELLED','Cancelling startup rejects instead of leaving perpetual polling');timersCleared('Aborted initialization');
  }
  {
    const scope=makeScope();let error;
    try{await waitForVWorldViewer(scope,{timeoutMs:100,pollMs:2,start(){throw new Error('startup failed');}});}catch(e){error=e;}
    equal(error?.code,'VWORLD_START_FAILED','A synchronous SDK start failure is handled');timersCleared('Start failure');
  }
}finally{
  for(const id of pendingTimeouts)native.clearTimeout(id);for(const id of pendingIntervals)native.clearInterval(id);
  Object.assign(globalThis,native);
}

// Probe the actual scene height/camera logic with minimal provider data.
const elevation=Object.create(CesiumScene.prototype);let rawHeight={height:72.75};
Object.assign(elevation,{hasTerrain:true,viewer:{scene:{globe:{getHeight:()=>rawHeight}}},C:{Cartographic:{fromDegrees:(lon,lat)=>({lon,lat})}},terrainHeights:new Map()});
equal(elevation._height(127.36,36.62),72.75,'The camera height path accepts object-valued API heights');
rawHeight=undefined;equal(elevation._height(127.36,36.62),72.75,'An already sampled height is preserved while its tile is unavailable');
check(elevation._height(127.37,36.63)===undefined,'A never-sampled terrain location is unknown');
elevation.hasTerrain=false;equal(elevation._height(127.37,36.63),0,'An explicitly ellipsoid-only scene uses zero terrain height');

const delayedHeight=deferred(),sampler=Object.create(CesiumScene.prototype);let sampled=0;
Object.assign(sampler,{destroyed:false,_terrainRevision:1,terrainHeights:new Map(),heightRequests:new Set(),viewer:{terrainProvider:{availability:{}},scene:{globe:{}}},C:{Cartographic:{fromDegrees:(lon,lat)=>({lon,lat})},sampleTerrainMostDetailed:()=>{sampled++;return delayedHeight.promise;}}});
sampler._requestHeight(127.36,36.62);await flush();sampler._terrainRevision++;sampler.terrainHeights.clear();delayedHeight.resolve([{height:900}]);await flush();
equal(sampled,1,'Terrain sampler is called once for a pending location');equal(sampler.terrainHeights.size,0,'An old terrain-provider response cannot contaminate the new provider cache');equal(sampler.heightRequests.size,0,'Completed terrain request is removed');

const camera=Object.create(CesiumScene.prototype);let groundRequests=0,cameraMoves=0;
Object.assign(camera,{mode:'follow',selected:1,states:[{id:1,lon:127.36,lat:36.62,heading:0}],viewer:{camera:{lookAt:()=>cameraMoves++}},C:{Math:{toRadians:x=>x*Math.PI/180}},_height:()=>undefined,_requestHeight:()=>groundRequests++});
camera._updateCamera();equal(groundRequests,1,'Following camera requests missing terrain');equal(cameraMoves,0,'Following camera holds position until terrain height is known');

const result={status:errors.length?'failed':'passed',checks,errorCount:errors.length,errors,
  scope:'Application with source data and DOM/map doubles; supplied QGIS default boundary, missing/empty handling; Roadview mode, canonical coordinates and rewind; V7 actual-call alerts, fractional speed, coalesced seeks and time-gated passenger feedback; actual VWorld callback/terrain helpers with synthetic responses. No browser GPU or live API key validation.',
  sourceSha256:Object.fromEntries(['app.js','boundary-data.js','replay-core.js','vworld-scene.js','vworld-host.html','scene3d.js','passenger-feedback.js','presentation-controls.js'].map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex')]))};
fs.mkdirSync(path.join(root,'docs'),{recursive:true});fs.writeFileSync(path.join(root,'docs/review-regression-results.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
process.exitCode=errors.length?1:0;
