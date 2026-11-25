#!/usr/bin/env node
/** SDK doubles exercise async ordering; no Kakao credentials or network are used. */
import assert from 'node:assert/strict';
import KakaoRoadview, {distanceMeters} from '../roadview.js';

class Clock {
  time = 0; next = 1; tasks = new Map();
  setTimeout(fn, ms) { const id = this.next++; this.tasks.set(id, {at: this.time + ms, fn}); return id; }
  clearTimeout(id) { this.tasks.delete(id); }
  advance(ms) {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.tasks].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.time = due[1].at; this.tasks.delete(due[0]); due[1].fn();
    }
    this.time = end;
  }
}

function harness() {
  const clock = new Clock(), requests = [], views = [], statuses = [], domEvents = new Map();
  const container = {
    style: {}, dataset: {},
    addEventListener(type, fn) { domEvents.set(type, fn); },
    removeEventListener(type) { domEvents.delete(type); },
    replaceChildren() { this.cleared = true; }
  };
  class LatLng {
    constructor(lat, lon) { this.lat = lat; this.lon = lon; }
    getLat() { return this.lat; } getLng() { return this.lon; }
  }
  class Roadview {
    constructor() { this.listeners = new Map(); this.calls = []; this.viewpoints = []; this.id = null; this.position = null; views.push(this); }
    setPanoId(id, point) { this.calls.push({id, point}); }
    getPanoId() { return this.id; }
    getPosition() { return this.position; }
    setViewpoint(viewpoint) { this.viewpoints.push(viewpoint); }
    relayout() { this.layoutCount = (this.layoutCount || 0) + 1; }
    finish(id, position, eventName = 'panoid_changed') {
      this.id = id; this.position = position;
      for (const fn of this.listeners.get(eventName) || []) fn();
    }
  }
  class RoadviewClient { getNearestPanoId(point, radius, callback) { requests.push({point, radius, callback}); } }
  const sdk = {LatLng, Roadview, RoadviewClient, event: {
    addListener(view, event, fn) { const list = view.listeners.get(event) || []; list.push(fn); view.listeners.set(event, list); },
    removeListener(view, event, fn) { view.listeners.set(event, (view.listeners.get(event) || []).filter(x => x !== fn)); }
  }};
  const rv = new KakaoRoadview(container, {sdk, now: () => clock.time, timers: clock, onStatus: s => statuses.push(s)});
  return {rv, sdk, clock, requests, views, statuses, container, domEvents,
    last: () => statuses.at(-1), point: (lon = 127.36, lat = 36.62, heading = 90, time = 30) => ({id: 1, lon, lat, heading, time})};
}

let checks = 0;
async function check(name, run) {
  await run(); ++checks; console.log(`PASS ${name}`);
}

await check('SDK connects without a query until active; source coordinates are unchanged', async () => {
  const h = harness(), state = Object.freeze(h.point());
  h.rv.update(state, {contextKey: 'run-a'});
  assert.equal(await h.rv.connect(''), true);
  assert.equal(h.requests.length, 0);
  h.rv.setActive(true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].point.getLng(), state.lon);
  assert.equal(h.requests[0].point.getLat(), state.lat);
  assert.deepEqual(Object.keys(state), ['id', 'lon', 'lat', 'heading', 'time']);
  h.rv.destroy();
});

await check('50 m misses expand only to 100 m; missing coverage hides previous image', async () => {
  const h = harness(); await h.rv.connect(''); h.rv.setActive(true); h.rv.update(h.point());
  h.requests[0].callback(null);
  assert.equal(h.requests[1].radius, 100);
  h.requests[1].callback(null);
  assert.equal(h.last().phase, 'unavailable');
  assert.equal(h.container.style.visibility, 'hidden');
  h.clock.advance(10000); h.rv.update(h.point());
  assert.equal(h.requests.length, 2, 'stationary uncovered points do not spam API');
  h.rv.refresh(); assert.equal(h.requests.length, 3);
  h.rv.destroy();
});

await check('pano init aligns normalized heading and reports true photo distance', async () => {
  const h = harness(); await h.rv.connect(''); h.rv.setActive(true); h.rv.update(h.point(127.36, 36.62, -90));
  h.requests[0].callback(123);
  assert.equal(h.container.style.visibility, 'hidden');
  const shot = new h.sdk.LatLng(36.62, 127.3601);
  h.views[0].finish(123, shot, 'init');
  assert.deepEqual(h.views[0].viewpoints.at(-1), {pan: 270, tilt: 0, zoom: 0});
  assert.equal(h.last().phase, 'ready');
  assert.equal(h.last().distanceM, Math.round(distanceMeters(h.point(), {lat: 36.62, lon: 127.3601})));
  assert.equal(h.container.style.visibility, 'visible');
  h.rv.destroy();
});

await check('manual drag suspends heading following until explicitly re-enabled', async () => {
  const h = harness(); await h.rv.connect(''); h.rv.setActive(true); h.rv.update(h.point());
  h.requests[0].callback(1); h.views[0].finish(1, h.requests[0].point);
  h.domEvents.get('pointerdown')();
  assert.equal(h.last().followHeading, false);
  const count = h.views[0].viewpoints.length;
  h.clock.advance(200); h.rv.update(h.point(127.36, 36.62, 180));
  assert.equal(h.views[0].viewpoints.length, count);
  h.rv.setFollowHeading(true);
  assert.equal(h.views[0].viewpoints.at(-1).pan, 180);
  h.rv.destroy();
});

await check('repeated frame updates are throttled and queued query uses latest coordinate', async () => {
  const h = harness(); await h.rv.connect(''); h.rv.setActive(true); h.rv.update(h.point());
  h.requests[0].callback(1); h.views[0].finish(1, h.requests[0].point);
  for (let i = 0; i < 120; i++) h.rv.update(h.point(127.361 + i * 0.00001));
  assert.equal(h.requests.length, 1);
  h.clock.advance(1199); assert.equal(h.requests.length, 1);
  h.clock.advance(1); assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].point.getLng(), 127.361 + 119 * 0.00001);
  h.requests[1].callback(1);
  assert.equal(h.views[0].calls.length, 1, 'unchanged pano does not reload image');
  h.rv.destroy();
});

await check('context switch rejects earlier search callbacks', async () => {
  const h = harness(); await h.rv.connect(''); h.rv.setActive(true);
  h.rv.update(h.point(), {contextKey: 'run-a'}); const old = h.requests[0];
  h.rv.update(h.point(127.37), {contextKey: 'run-b'});
  h.clock.advance(1200);
  assert.equal(h.requests.length, 2);
  old.callback(999);
  assert.equal(h.views[0].calls.length, 0);
  h.requests[1].callback(2); h.views[0].finish(2, h.requests[1].point);
  assert.equal(h.last().panoId, 2);
  h.rv.destroy();
});

await check('seek reset and implicit time rewind invalidate stale results', async () => {
  const h = harness(); await h.rv.connect(''); h.rv.setActive(true);
  h.rv.update(h.point(127.36, 36.62, 90, 100)); const old = h.requests[0];
  h.rv.update(h.point(127.35, 36.62, 90, 50));
  old.callback(1); assert.equal(h.views[0].calls.length, 0);
  h.clock.advance(1200);
  const second = h.requests[1]; h.rv.reset(); second.callback(2);
  assert.equal(h.views[0].calls.length, 0);
  assert.equal(h.container.style.visibility, 'hidden');
  h.rv.destroy();
});

await check('late old SDK pano event cannot expose the previous run image', async () => {
  const h = harness(); await h.rv.connect(''); h.rv.setActive(true);
  h.rv.update(h.point(), {contextKey: 'a'}); h.requests[0].callback(1);
  h.rv.update(h.point(127.37), {contextKey: 'b'}); h.clock.advance(1200); h.requests[1].callback(2);
  h.views[0].finish(1, h.requests[0].point);
  assert.equal(h.container.style.visibility, 'hidden');
  assert.equal(h.views[0].calls.at(-1).id, 2);
  h.views[0].finish(2, h.requests[1].point);
  assert.equal(h.last().panoId, 2);
  assert.equal(h.container.style.visibility, 'visible');
  h.rv.destroy();
});

await check('missing callback and photo load both time out with retry available', async () => {
  const h = harness(); await h.rv.connect(''); h.rv.setActive(true); h.rv.update(h.point());
  h.clock.advance(8000); assert.equal(h.last().phase, 'error');
  h.requests[0].callback(99); assert.equal(h.views[0].calls.length, 0);
  h.rv.refresh(); h.requests[1].callback(2);
  h.clock.advance(8000); assert.equal(h.last().phase, 'error');
  assert.equal(h.container.style.visibility, 'hidden');
  h.views[0].finish(2, h.requests[1].point);
  assert.equal(h.container.style.visibility, 'hidden', 'late image after timeout is not resurrected');
  h.rv.refresh(); assert.equal(h.requests.length, 3);
  h.rv.destroy();
});

await check('V-World mode stops requests and discards pending callback', async () => {
  const h = harness(); await h.rv.connect(''); h.rv.setActive(true); h.rv.update(h.point());
  h.rv.setActive(false); h.requests[0].callback(7);
  h.rv.update(h.point(127.37)); h.clock.advance(5000);
  assert.equal(h.requests.length, 1);
  assert.equal(h.views[0].calls.length, 0);
  h.rv.setActive(true); assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].point.getLng(), 127.37);
  h.rv.destroy();
});

await check('destroy removes handlers, pending timers, and owned DOM', async () => {
  const h = harness(); await h.rv.connect(''); h.rv.setActive(true); h.rv.update(h.point());
  h.rv.destroy(); h.requests[0].callback(9);
  assert.equal(h.views[0].calls.length, 0);
  assert.equal(h.clock.tasks.size, 0);
  assert.equal(h.domEvents.size, 0);
  assert.equal([...h.views[0].listeners.values()].flat().length, 0);
  assert.equal(h.container.cleared, true);
  assert.equal(h.rv.isReady, false);
});

await check('invalid/null coordinates never create a nearest-pano request', async () => {
  const h = harness(); await h.rv.connect(''); h.rv.setActive(true);
  for (const p of [null, {lon: null, lat: 36}, {lon: 127, lat: ''}, {lon: NaN, lat: 36}, {lon: 999, lat: 36},
    {...h.point(), status: 'unknown'}, {...h.point(), geometryQuality: 'unresolved'}]) h.rv.update(p);
  assert.equal(h.requests.length, 0); assert.equal(h.last().phase, 'unavailable');
  h.rv.destroy();
});

await check('continuous timeline seeks keep the API rate limit and use final coordinates', async () => {
  const h = harness(); await h.rv.connect(''); h.rv.setActive(true); h.rv.update(h.point());
  const old = h.requests[0];
  for (let i = 0; i < 60; i++) {
    h.rv.reset(); h.rv.update(h.point(127.37 + i * 0.00001)); h.clock.advance(10);
  }
  assert.equal(h.requests.length, 1, 'seek reset must not bypass lookup throttle');
  old.callback(1); assert.equal(h.views[0].calls.length, 0);
  h.clock.advance(600); assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].point.getLng(), 127.37 + 59 * 0.00001);
  h.rv.destroy();
});

await check('old SDK image arriving after the new image is ready hides and times out safely', async () => {
  const h = harness(); await h.rv.connect(''); h.rv.setActive(true);
  h.rv.update(h.point(), {contextKey: 'old'}); h.requests[0].callback(1);
  h.rv.update(h.point(127.37), {contextKey: 'new'}); h.clock.advance(1200); h.requests[1].callback(2);
  h.views[0].finish(2, h.requests[1].point); assert.equal(h.last().phase, 'ready');
  h.views[0].finish(1, h.requests[0].point);
  assert.equal(h.container.style.visibility, 'hidden'); assert.equal(h.last().phase, 'loading');
  const corrections = h.views[0].calls.length;
  h.views[0].finish(1, h.requests[0].point, 'position_changed');
  assert.equal(h.views[0].calls.length, corrections, 'paired SDK events share one corrective request');
  h.rv.update(h.point(127.37));
  assert.notEqual(h.last().phase, 'ready', 'frame updates cannot advertise a stale image as ready');
  h.clock.advance(8000); assert.equal(h.last().phase, 'error');
  h.rv.destroy();
});

console.log(`${checks} Roadview asynchronous checks passed (mock SDK; live authentication/imagery not tested).`);
