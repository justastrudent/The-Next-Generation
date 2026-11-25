#!/usr/bin/env node
/** Data-facing view regressions; deliberately no SDK, API key or browser dependency. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import DispatchPanel,{safeDisplayNumber,planPaths,buildRouteSVG} from '../dispatch-panel.js';
import {prepareRun} from '../replay-core.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
let checks=0;const check=(condition,message)=>{checks++;assert.ok(condition,message);};
const names=['clock','run-caption','state','alert','calls','plan-source','plan-caption','route','stops','impact-source','impacts','algorithm'];
function harness(){
  const panel=Object.create(DispatchPanel.prototype),routes=[];
  Object.assign(panel,{nodes:Object.fromEntries(names.map(name=>[name,{innerHTML:'',textContent:'',hidden:false,dataset:{}}])),container:{querySelectorAll:()=>[]},callbacks:{onRouteComparison:value=>routes.push(value)},active:true,context:null,dispatchPrepared:null,dataIdentity:null,runIdentity:null,networkIdentity:null,rendered:new Map(),visibility:{before:true,after:true},routeSignature:'',lastRenderedTime:-Infinity,lastWallRender:-Infinity,view:null,serial:1});
  return {panel,routes};
}
check(safeDisplayNumber(null)==='—','null is not displayed as a measured zero');
check(safeDisplayNumber('')==='—','empty value is not displayed as zero');
check(safeDisplayNumber(0)==='0.0','measured zero remains visible');
check(planPaths({stops:[{lon:127.3,lat:36.6},{lon:127.4,lat:36.7}]}).length===0,'stop-only plans never create a straight route');
check(planPaths({segments:[{source:'unresolved',coordinates:[[127.3,36.6],[127.4,36.7]]}]}).length===0,'unresolved routes are never drawn');
check(planPaths({segments:[{coordinates:[[127.3,36.6],null,[127.4,36.7]]}]}).length===0,'invalid coordinate gaps are not silently joined');
const split=planPaths({segments:[{coordinates:[[127.3,36.6],[127.31,36.61]]},{coordinates:[[127.4,36.7],[127.41,36.71]]}]});
check(split.length===2,'separate network segments remain separate');
check(buildRouteSVG({stops:[]},{stops:[]},{roads:[]})==='','geometry absence has an explicit empty map');
const hostile={segments:[{coordinates:[[127.3,36.6],[127.31,36.61]]}],stops:[{lon:127.3,lat:36.6,name:'<img src=x onerror=alert(1)>',kind:'PU'}]};
const safeSVG=buildRouteSVG(null,hostile,{roads:[]});
check(!safeSVG.includes('<img'),'GIS labels cannot create HTML elements');
check(safeSVG.includes('&lt;img'),'GIS label content is escaped');

const network=read('data/network.json'),run=read('data/runs/2023-11-06_integrated_S1.json'),data=read('data/decisions/2023-11-06_integrated_S1.json');
const prepared=prepareRun(run,network),context={run,prepared,network,selected:1,decisionData:data,loading:false,error:null};
const firstCall=data.calls[0].time;
const {panel,routes}=harness();
panel.update({...context,time:firstCall-0.001},true);
check(!panel.nodes.calls.innerHTML.includes(`호출 ${data.calls[0].requestId}`),'future first call stays hidden');
panel.update({...context,time:firstCall+0.001},true);
check(panel.nodes.calls.innerHTML.includes(`호출 ${data.calls[0].requestId}`),'call is shown on receipt');
check(panel.nodes.calls.innerHTML.includes('약속'),'promised wait is identified as a dispatch-time promise');
check(!panel.nodes.calls.innerHTML.includes('실제 대기'),'future realized waiting result is withheld');
check(panel.nodes.route.innerHTML.includes('dp-route'),'recorded plan has a geometry-based comparison map');
check(routes.at(-1)?.currentPaths.length>0,'left map receives actual reconstructed paths');
const routeAtCall=panel.nodes.route.innerHTML;
panel.update({...context,time:29},true);
check(!panel.nodes.route.innerHTML.includes('class="dp-map-after"')&&panel.nodes.route.innerHTML.includes('dp-vehicle-marker'),'rewind before plan clears old route but retains the current bus');
check(routes.at(-1)===null,'rewind before plan clears left-map comparison');
panel.update({...context,time:firstCall+0.001},true);
check(panel.nodes.route.innerHTML===routeAtCall,'returning after rewind restores the same deterministic map');
panel.update({...context,time:150},true);
check(!panel.nodes['plan-caption'].innerHTML.includes('INTEGRATION_START'),'internal trigger enum has a Korean label');
check(panel.nodes.impacts.innerHTML.includes('전체 차량 국소탐색'),'system-wide optimization is not misattributed to one vehicle');
check(panel.nodes.algorithm.innerHTML.includes('기존 승차 약속 변경 허용 1분'),'original algorithm constraints are available to researchers');
panel.update({...context,time:152.5166667,selected:1},true);
check(panel.nodes.impacts.innerHTML.includes('+19.4분'),'documented real replan shows the 19.44-minute next-delivery ETA change');
check(panel.nodes.impacts.innerHTML.includes('제약 통과 후보'),'candidate count clearly means feasible scored insertions');
check(panel.nodes.impacts.innerHTML.includes('물류 단독 영향 아님'),'plan delta is not presented as a causal freight penalty');
panel.update({...context,time:150,selected:2},true);
check(panel.nodes.route.innerHTML.includes('앞 12개 작업 경로'),'truncated route is visibly scoped in the legend');
panel.update({...context,time:150,loading:true},true);
check(!panel.nodes.route.innerHTML.includes('class="dp-map-after"')&&panel.nodes.route.innerHTML.includes('dp-vehicle-marker'),'loading a context shows its current position without a stale plan');
check(routes.at(-1)===null,'loading clears stale left-map polylines');
check(panel.nodes.alert.textContent.includes('불러오고'),'loading status is visible');
const otherRun=read('data/runs/2023-11-07_integrated_S1.json');
panel.update({...context,run:otherRun,prepared:prepareRun(otherRun,network),time:200},true);
check(!panel.nodes.route.innerHTML.includes('class="dp-map-after"'),'mismatched run and decision file never render a foreign route');

// Every run can render a representative actual decision, and nullable data never leaks NaN.
for(const filename of fs.readdirSync(path.join(root,'data/decisions')).filter(n=>n.endsWith('.json')&&!n.includes('manifest'))){
  const decisions=read(`data/decisions/${filename}`);
  if(!decisions.runId)continue;
  const scenarioRun=read(`data/runs/${decisions.runId}.json`);
  const relevant=decisions.snapshots.find(s=>s.trigger==='INTEGRATION_START')||decisions.snapshots.find(s=>s.trigger==='CALL')||decisions.snapshots[0];
  const {panel:p}=harness();p.update({run:scenarioRun,prepared:prepareRun(scenarioRun,network),network,selected:2,decisionData:decisions,time:relevant.time,loading:false},true);
  check(!Object.values(p.nodes).some(n=>/NaN|undefined/.test(n.innerHTML)) ,`${decisions.runId} has no invalid display values`);
  check(p.nodes['plan-caption'].innerHTML.length>0,`${decisions.runId} renders its recorded plan`);
}
console.log(`dispatch-panel: ${checks} data-facing UI checks passed (browser layout/SDK calls are separate).`);
