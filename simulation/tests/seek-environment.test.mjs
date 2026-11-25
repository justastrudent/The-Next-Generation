import test from 'node:test';
import assert from 'node:assert/strict';
import Environment3D from '../environment3d.js';
import ResearchWorkspace from '../research-workspace.js';

test('scrubbing pauses the old tile queue until the final target can replace it',()=>{
  const env=Object.create(Environment3D.prototype);let loads=0;
  Object.assign(env,{viewer:{},suspendRefresh:true,disposed:false,inFlight:new Set(),queue:[{id:'old'}],_loadTile:()=>{loads++;return Promise.resolve();}});
  env._pump();assert.equal(loads,0);assert.equal(env.queue.length,1);
  const workspace=Object.create(ResearchWorkspace.prototype);workspace.environment=env;env._lastRefresh=99;
  workspace.setScrubbing(false);assert.equal(env.suspendRefresh,false);assert.equal(env._lastRefresh,0);
});

test('a tile response arriving during a seek is cached without making old-location GPU objects',async()=>{
  const env=Object.create(Environment3D.prototype);let resolve,created=0;
  Object.assign(env,{epoch:1,_wanted:new Set(['tile']),dataCache:new Map(),_json:()=>new Promise(r=>resolve=r),
    _instance:()=>{created++;},_ground:()=>{created++;}});
  const task=env._loadTile({id:'tile',url:'unused'},1);env.suspendRefresh=true;
  const data={roads:[],buildings:[],bridges:[]};resolve(data);await task;
  assert.equal(created,0);assert.equal(env.dataCache.get('tile'),data);
});

test('in-flight height work removes partial old-location primitives if seeking starts',async()=>{
  const env=Object.create(Environment3D.prototype);let resolve,cleared=0;
  const data={roads:[{surface:'unknown',polygons:[[]]}],buildings:[],bridges:[]};
  Object.assign(env,{viewer:{},C:{},epoch:1,_wanted:new Set(['tile']),dataCache:new Map([['tile',data]]),pendingRecords:new Set(),tiles:new Map(),
    _instance:()=>({}),_ground:()=>({}),_sampleHeights:()=>new Promise(r=>resolve=r),_clearObjects:r=>{cleared+=r.objects.length;}});
  const task=env._loadTile({id:'tile'},1);assert.equal(env.pendingRecords.size,1);
  env.suspendRefresh=true;resolve([]);await task;
  assert.equal(cleared,1);assert.equal(env.pendingRecords.size,0);assert.equal(env.tiles.size,0);
});
