#!/usr/bin/env node
/** Current-position and replay-transition regressions, independent of the map SDK. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import DispatchPanel,{buildRouteSVG,selectedVehicleState} from '../dispatch-panel.js';
import {prepareRun,stateAt} from '../replay-core.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
const network=read('data/network.json'),run=read('data/runs/2023-11-06_integrated_S1.json'),decisionData=read('data/decisions/2023-11-06_integrated_S1.json');
const prepared=prepareRun(run,network),context={run,prepared,network,selected:1,decisionData,loading:false,error:null,runLoading:false};
let checks=0;const check=(condition,message)=>{checks++;assert.ok(condition,message);};
const names=['clock','run-caption','state','alert','calls','plan-source','plan-caption','route','stops','impact-source','impacts','algorithm'];
function harness(){
  const panel=Object.create(DispatchPanel.prototype),routes=[];
  Object.assign(panel,{nodes:Object.fromEntries(names.map(name=>[name,{innerHTML:'',textContent:'',hidden:false,dataset:{}}])),container:{querySelectorAll:()=>[]},callbacks:{onRouteComparison:value=>routes.push(value)},active:true,context:null,dispatchPrepared:null,dataIdentity:null,runIdentity:null,networkIdentity:null,rendered:new Map(),visibility:{before:true,after:true},routeSignature:'',lastRenderedTime:-Infinity,lastWallRender:-Infinity,view:null,serial:1});
  return {panel,routes};
}
const marker=html=>{
  const tag=html.match(/<g class="dp-vehicle-marker"[^>]*>/)?.[0];
  if(!tag)return null;
  const field=name=>tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];
  return {id:Number(field('data-vehicle-id')),lon:Number(field('data-lon')),lat:Number(field('data-lat')),heading:Number(field('data-heading')),source:field('data-position-source'),xy:field('transform').match(/[-.\d]+/g).map(Number)};
};
const route={segments:[{source:'network_reconstruction',coordinates:[[127.35,36.60],[127.351,36.601]]}],stops:[{lon:127.351,lat:36.601,kind:'PU',name:'시험 정류장'}]};
const testState={id:2,lon:127.3505,lat:36.6005,heading:90,status:'passenger',geometryQuality:'network_interpolation'};
const svg=buildRouteSVG(null,route,network,{before:true,after:true},testState),shown=marker(svg);
check(shown?.id===2&&shown.lon===testState.lon&&shown.lat===testState.lat,'map marker uses exact supplied current coordinates, not the first planned stop');
check(svg.includes('rotate(90.00)'),'heading 90 points east in a north-up SVG');
check(svg.includes('DRT 2 · 현재 위치'),'current vehicle has an explicit high-contrast label');
check(shown.source==='network_interpolation'&&svg.includes('도로망 보간'),'reconstructed location is identified without claiming GPS observation');
check(shown.xy[0]>=42&&shown.xy[0]<=438&&shown.xy[1]>=49&&shown.xy[1]<=211,'marker stays inside padded map extent');
const distant={...testState,lon:127.43,lat:36.65,heading:270};
const distantSVG=buildRouteSVG(null,route,network,{before:true,after:true},distant),distantMarker=marker(distantSVG);
check(distantMarker.lon===distant.lon&&distantMarker.lat===distant.lat,'out-of-plan position is not snapped or relocated to the route');
check(distantMarker.xy[0]>=42&&distantMarker.xy[0]<=438&&distantMarker.xy[1]>=49&&distantMarker.xy[1]<=211,'map expands when the current bus lies outside the plan');
check(distantSVG.includes('rotate(270.00)'),'west heading is preserved');
const onlyPosition=buildRouteSVG(null,null,network,{before:true,after:true},testState);
check(!!marker(onlyPosition)&&!onlyPosition.includes('class="dp-map-after"'),'idle / pre-plan state shows current position without inventing a path');
check(buildRouteSVG(null,null,network,{before:true,after:true},{...testState,lon:null})==='','missing coordinates do not become zero or a fictional marker');
const unresolved=buildRouteSVG(null,route,network,{before:true,after:true},{...testState,geometryQuality:'unresolved'});
check(unresolved.includes('기준 위치')&&unresolved.includes('마지막 확인 위치')&&!unresolved.includes('class="dp-vehicle-heading"'),'unresolved travel shows its last anchor without a claimed movement direction');
const stateInput={...testState,heading:-90};
check(buildRouteSVG(null,route,network,{before:true,after:true},stateInput).includes('rotate(270.00)'),'negative heading is normalized without changing state');
check(stateInput.heading===-90,'rendering does not mutate canonical vehicle state');
check(selectedVehicleState({...context,states:[testState],selected:2})===testState,'shared 3D state is preferred over independent recomputation');
check(selectedVehicleState({...context,states:[],selected:2})===null,'an explicitly empty shared state never falls back to stale geometry');
check(selectedVehicleState({...context,states:[testState],selected:2,runLoading:true})===null,'old run states cannot leak during a date or scenario switch');

const {panel,routes}=harness();
const event=run.events.find(e=>+e.vehicle===1&&e.pathId&&e.time-e.departure>.1);
const time=(event.departure+event.time)/2;
const statesA=stateAt(prepared,time,1),statesB=stateAt(prepared,time+.0001,1);
panel.update({...context,time,states:statesA},true);
const initialMarker=marker(panel.nodes.route.innerHTML),expectedA=statesA.find(s=>s.id===1);
check(initialMarker?.lon===expectedA.lon&&initialMarker?.lat===expectedA.lat,'actual run marker matches replay-core at the chosen time');
const mountedRoadSVG=panel.nodes.route.innerHTML,model=panel.mapModel,live={innerHTML:''},source={textContent:''};
panel.nodes.route.querySelector=selector=>selector==='[data-dp-live-position]'?live:selector==='[data-dp-position-source]'?source:null;
panel.lastWallRender=performance.now();
panel.update({...context,time:time+.0001,states:statesB});
const moved=marker(live.innerHTML),expectedB=statesB.find(s=>s.id===1);
check(moved?.lon===expectedB.lon&&moved?.lat===expectedB.lat,'current marker moves even while text / decision rendering is throttled');
check(moved?.lon!==initialMarker.lon||moved?.lat!==initialMarker.lat,'movement is not frozen by the unchanged plan signature');
check(panel.nodes.route.innerHTML===mountedRoadSVG&&panel.mapModel===model,'position-only updates preserve mounted road SVG and its cached projection');
check(source.textContent==='차량 위치 · 도로망 보간','position provenance updates alongside the marker');

// No old marker, route or calls while the canonical run is changing.
panel.update({...context,time:time+.001,states:statesB,runLoading:true,loading:true});
check(!marker(panel.nodes.route.innerHTML)&&!panel.nodes.route.innerHTML.includes('class="dp-map-after"'),'canonical run switch clears both marker and route immediately');
check(panel.nodes.state.innerHTML.includes('운영자료 전환 중'),'run switch does not display old vehicle occupancy as current');
check(!panel.nodes.calls.innerHTML.includes('data-request-id'),'run switch hides old calls');
check(routes.at(-1)===null,'canonical run switch clears the left-side comparison overlay');

// Once the new run is ready, decision-file loading must not suppress the bus.
const newRun=read('data/runs/2023-11-07_integrated_S1.json'),newPrepared=prepareRun(newRun,network),newStates=stateAt(newPrepared,200,2);
panel.nodes.route.querySelector=undefined;
panel.update({run:newRun,prepared:newPrepared,network,selected:2,time:200,states:newStates,decisionData:null,runLoading:false,loading:true,error:null},true);
const newMarker=marker(panel.nodes.route.innerHTML),expectedNew=newStates.find(s=>s.id===2);
check(newMarker?.id===2&&newMarker.lon===expectedNew.lon&&newMarker.lat===expectedNew.lat,'new canonical run restores its own vehicle position before decision JSON arrives');
check(!panel.nodes.route.innerHTML.includes('class="dp-map-after"'),'decision-only loading never retains an old route');

// Forward, rewind, and vehicle selection all stay deterministic.
for(const t of [time,29,time,152.5166667,75.3,200]){
 for(const selected of [1,2,3]){
  const states=stateAt(prepared,t,selected),expected=states.find(s=>s.id===selected);
  panel.update({...context,time:t,selected,states},true);
  const actual=marker(panel.nodes.route.innerHTML);
  check(actual?.id===selected&&actual.lon===expected.lon&&actual.lat===expected.lat,`canonical position retained at t=${t} / DRT ${selected}`);
  check(!/NaN|undefined/.test(panel.nodes.route.innerHTML),`valid marker markup at t=${t} / DRT ${selected}`);
 }
}
const rawBefore=JSON.stringify([run.events,run.routes,decisionData.snapshots,network.nodes]);
panel.update({...context,time:152.5166667,states:stateAt(prepared,152.5166667,1)},true);
check(JSON.stringify([run.events,run.routes,decisionData.snapshots,network.nodes])===rawBefore,'panel changes never alter original events, routes, plans, or node coordinates');
console.log(`dispatch-position-v4: ${checks} position, heading, no-stale-run and rewind checks passed.`);
