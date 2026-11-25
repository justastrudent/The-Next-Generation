import test from 'node:test';
import assert from 'node:assert/strict';
import ResearchWorkspace from '../research-workspace.js';

function workspace(){
  const w=Object.create(ResearchWorkspace.prototype),calls=[],updates=[];
  w.environment={setServicePlacements:(p,v)=>calls.push({p,v}),update:(s,o)=>updates.push({s,o})};
  w.refreshPanel=()=>{};
  return{w,calls,updates};
}

test('facility priority follows actual placement map and layer visibility across playback updates',()=>{
  const {w,calls,updates}=workspace(),placements=new Map([['DEPOT',{id:'DEPOT',lon:127.36,lat:36.62}]]);
  w.scene={servicePlacements:placements,layers:{hubs:true,stops:true}};
  const states=[{id:1,lon:127.36,lat:36.62}],context={states,selected:1,camera:'decision',time:30};
  w.update(context);
  assert.equal(calls.length,1);assert.equal(calls[0].p,placements);
  assert.deepEqual(calls[0].v,{hubs:true,stops:true});
  w.update({...context,time:31});
  assert.equal(calls.length,1,'ordinary playback must not rebuild facility masks or GIS tiles');
  assert.equal(updates.at(-1).s,states,'canonical coordinates pass through without display mutation');
  w.scene.layers.hubs=false;w.update({...context,time:32});
  assert.equal(calls.length,2);assert.deepEqual(calls[1].v,{hubs:false,stops:true});
  w.scene.layers.stops=false;w.update({...context,time:33});
  assert.equal(calls.length,3);assert.deepEqual(calls[2].v,{hubs:false,stops:false});
  w.scene.layers.hubs=true;w.update({...context,time:34});
  assert.equal(calls.length,4);assert.deepEqual(calls[3].v,{hubs:true,stops:false});
});

test('late network and rebuilt placements are propagated without changing service coordinates',()=>{
  const {w,calls}=workspace();w.scene={layers:{hubs:true,stops:true}};
  w.syncServicePlacements();assert.equal(calls.length,0);
  const first=new Map([['STOP_1',{lon:127.35,lat:36.6}]]),snapshot=JSON.stringify([...first]);
  w.scene.servicePlacements=first;w.syncServicePlacements();
  const second=new Map(first);w.scene.servicePlacements=second;w.syncServicePlacements();
  assert.equal(calls.length,2);assert.equal(calls[0].p,first);assert.equal(calls[1].p,second);
  assert.equal(JSON.stringify([...first]),snapshot);
});
