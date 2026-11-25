import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,readdirSync} from 'node:fs';
import {buildPassengerFeedbackIndex} from '../passenger-feedback.js';

function fixture() {
  const run = {id:'test-run',passengers:[{id:'P1',vehicle:1,call:10,pickup:18.4,dropoff:32,people:1,pickupNode:'A',dropoffNode:'B'}]};
  const stops = [{kind:'PU',nodeId:'A',requestId:'P1',time:18.4},{kind:'DO',nodeId:'B',requestId:'P1',time:30}];
  const decisions = {runId:run.id,source:'original_committed_plan_log',validation:{passed:true,etaSource:'validated_plan_recalculation'},
    calls:[{requestId:'P1',time:10,vehicle:1,accepted:true,promisedPickup:18.4}],
    snapshots:[{id:1,time:10,trigger:'CALL',revealedIds:['P1'],vehicles:{'1':{stops}}},
      {id:2,time:20,trigger:'STATE_CHANGE',revealedIds:['P1'],vehicles:{'1':{stops:[{...stops[1],time:31.8}]}}}]};
  return {run,decisions};
}

test('actual boarding wait and initial-plan arrival baseline are immutable and time-gated',()=>{
  const {run,decisions}=fixture(), original=JSON.stringify({run,decisions});
  const index=buildPassengerFeedbackIndex(run,decisions);
  assert.equal(index.getBoardingFeedback('P1').text,'8.4분 대기 후 탑승');
  assert.equal(index.getBoardingFeedback('P1',18),null);
  assert.equal(index.getAlightingFeedback('P1',31.9),null);
  const feedback=index.getAlightingFeedback('P1',32);
  assert.equal(feedback.delayMin,2);assert.equal(feedback.expectedArrival,30);
  assert.equal(feedback.text,'+2.0분 지연');assert.equal(feedback.baseline.snapshotId,1);
  assert.equal(feedback.baseline.etaSource,'validated_plan_recalculation');
  assert.equal(JSON.stringify({run,decisions}),original);
});

test('a later snapshot never substitutes for a missing initial assignment snapshot',()=>{
  const {run,decisions}=fixture();decisions.snapshots.shift();
  const feedback=buildPassengerFeedbackIndex(run,decisions).getAlightingFeedback('P1');
  assert.equal(feedback.available,false);assert.equal(feedback.valueMinutes,null);
  assert.equal(feedback.text,'예상 도착시각 없음');
});

test('invalid provenance, mismatched run/vehicle/node, missing disclosure, rejected calls and promise mismatches have no delay value',()=>{
  for(const poison of [
    d=>{d.validation.passed=false;},d=>{d.validation.etaSource='guessed';},d=>{d.runId='other';},
    d=>{d.source='demo';},d=>{d.calls[0].vehicle=2;},d=>{d.calls[0].accepted=false;},
    d=>{d.calls[0].promisedPickup=19.5;},d=>{d.snapshots[0].revealedIds=[];},
    d=>{d.snapshots[0].vehicles['1'].stops[1].nodeId='OTHER';}
  ]){
    const {run,decisions}=fixture();poison(decisions);
    const index=buildPassengerFeedbackIndex(run,decisions);
    assert.equal(index.getAlightingFeedback('P1').valueMinutes,null);
    assert.equal(index.getBoardingFeedback('P1').available,true);
  }
});

test('early and exact on-time arrivals retain the signed original comparison',()=>{
  const {run,decisions}=fixture();run.passengers[0].dropoff=28.5;
  let feedback=buildPassengerFeedbackIndex(run,decisions).getAlightingFeedback('P1');
  assert.equal(feedback.delayMin,-1.5);assert.equal(feedback.text,'1.5분 일찍 도착');
  run.passengers[0].dropoff=30;feedback=buildPassengerFeedbackIndex(run,decisions).getAlightingFeedback('P1');
  assert.equal(feedback.delayMin,0);assert.equal(feedback.text,'예정대로 도착');
});

test('missing actual outcome never becomes a zero-minute wait/delay',()=>{
  const {run,decisions}=fixture();run.passengers[0].pickup=null;run.passengers[0].dropoff=null;
  const index=buildPassengerFeedbackIndex(run,decisions);
  assert.equal(index.getBoardingFeedback('P1').available,false);
  assert.equal(index.getAlightingFeedback('P1').available,false);
  assert.equal(index.getAlightingFeedback('P1',100),null);
});

test('call notifications expose only calls crossed forward, exclude future outcome/assignment, and never mutate source',()=>{
  const {run,decisions}=fixture();run.passengers.push({...run.passengers[0],id:'P2',call:12});
  const index=buildPassengerFeedbackIndex(run,decisions);
  assert.deepEqual(index.callsBetween(0,9),[]);
  assert.deepEqual(index.callsBetween(9,10).map(c=>c.requestId),['P1']);
  assert.deepEqual(index.callsBetween(10,12).map(c=>c.requestId),['P2']);
  assert.deepEqual(index.callsBetween(12,9),[]);assert.deepEqual(index.callsBetween(12,12),[]);
  const call=index.callsBetween(9,10)[0];
  for(const key of ['vehicle','pickup','dropoff','wait','promisedPickup'])assert.equal(key in call,false);
});

test('all 42 supplied runs have original assignment-time baselines and recorded waits for every passenger',()=>{
  const root=new URL('../data/',import.meta.url), files=readdirSync(new URL('decisions/',root)).filter(x=>x.endsWith('.json'));
  let count=0;
  for(const name of files){
    const run=JSON.parse(readFileSync(new URL('runs/'+name,root),'utf8'));
    const decisions=JSON.parse(readFileSync(new URL('decisions/'+name,root),'utf8'));
    const index=buildPassengerFeedbackIndex(run,decisions);
    assert.equal(index.stats.validatedDecisionRun,true,name);
    assert.equal(index.stats.waitCount,run.passengers.length,name);
    assert.equal(index.stats.baselineCount,run.passengers.length,name);
    assert.equal(index.stats.arrivalCount,run.passengers.length,name);
    for(const passenger of run.passengers){
      const boarding=index.getBoardingFeedback(passenger.id,passenger.pickup);
      const alighting=index.getAlightingFeedback(passenger.id,passenger.dropoff);
      assert.ok(Math.abs(boarding.waitMin-passenger.wait)<1e-6,name);
      assert.ok(Number.isFinite(alighting.delayMin),name);
      assert.equal(alighting.baseline.assignedAt,passenger.call,name);
      assert.equal(index.getAlightingFeedback(passenger.id,passenger.dropoff-.01),null,name);
      count++;
    }
  }
  assert.equal(files.length,42);assert.equal(count,3186);
});
