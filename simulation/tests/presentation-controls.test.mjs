import test from 'node:test';
import assert from 'node:assert/strict';
import {SeekCoordinator, PassengerCallCursor, playbackSpeed, readPresentationPreferences} from '../presentation-controls.js';

test('rapid seeks render only the latest frame and commit only the final target', () => {
  const frames = new Map(), timers = new Map(), previews = [], commits = []; let id = 0;
  const seeks = new SeekCoordinator({onPreview: value => previews.push(value), onCommit: value => commits.push(value),
    requestFrame: fn => {frames.set(++id, fn); return id;}, cancelFrame: id => frames.delete(id),
    setTimer: fn => {timers.set(++id, fn); return id;}, clearTimer: id => timers.delete(id)});
  for (const value of [300, 400, 100, 750, 43]) seeks.request(value);
  assert.equal(frames.size, 1); assert.equal(timers.size, 1);
  const [fid, fn] = [...frames][0]; frames.delete(fid); fn();
  assert.deepEqual(previews, [43]); assert.deepEqual(commits, []);
  seeks.request(88); seeks.flush();
  assert.deepEqual(commits, [88]); assert.equal(frames.size, 0); assert.equal(timers.size, 0);
  seeks.flush(); assert.equal(commits.length, 1);
});

test('cancelling a seek on run change prevents stale updates', () => {
  let frame, timer; const values = [];
  const seeks = new SeekCoordinator({onPreview: n => values.push(n), onCommit: n => values.push(n),
    requestFrame: fn => {frame = fn; return 1;}, cancelFrame: () => {},
    setTimer: fn => {timer = fn; return 2;}, clearTimer: () => {}});
  seeks.request(500); seeks.cancel(); frame(); timer();
  assert.deepEqual(values, []);
});

test('calls are only announced on playback, with no history storm after seek or toggling', () => {
  const rows = [{time: 35}, {time: 40}, {time: 80}];
  const data = {runId: 'a', callsBetween: (a,b) => rows.filter(x => x.time > a && x.time <= b)};
  const cursor = new PassengerCallCursor(); cursor.reset(30, 'a');
  assert.deepEqual(cursor.advance(35, data), [{time:35}]);
  cursor.reset(75, 'a'); assert.deepEqual(cursor.advance(76, data), []);
  assert.deepEqual(cursor.advance(80, data, {enabled:false}), []);
  assert.deepEqual(cursor.advance(81, data), []);
  cursor.reset(30, 'a'); assert.deepEqual(cursor.advance(40, data, {scrubbing:true}), []);
  assert.deepEqual(cursor.advance(80, {...data,runId:'b'}), []);
  assert.deepEqual(cursor.advance(30, data), []);
  assert.deepEqual(cursor.advance(40, data, {playing:false}), []);
});

test('arbitrary speeds and unavailable browser storage are safe', () => {
  assert.equal(playbackSpeed(45), 45); assert.equal(playbackSpeed('70.3'), 70.3);
  assert.equal(playbackSpeed('.5'), .5); assert.equal(playbackSpeed(5000), 600);
  assert.equal(playbackSpeed('', 45), 45); assert.equal(playbackSpeed(-1, 45), 45);
  assert.equal(playbackSpeed(Infinity, 45), 45);
  assert.deepEqual(readPresentationPreferences({getItem(){throw new Error('disabled');}}), {callAlerts:true,bubbles:true,speed:120});
});
