/**
 * Optional Kakao Roadview. Source vehicle coordinates stay unchanged.
 * Official API: https://apis.map.kakao.com/web/documentation/#Roadview
 * Roadview photographs are recorded imagery, not live/2023 simulation imagery.
 */
const SDK_URL = 'https://dapi.kakao.com/v2/maps/sdk.js';
const SDK_ERROR = '카카오 로드뷰를 연결하지 못했습니다. JavaScript 키, 등록 도메인과 카카오맵 사용 설정을 확인해 주세요.';
let sdkLoad = null;

const normalizedHeading = value => ((Number(value) || 0) % 360 + 360) % 360;
const hasSDK = maps => !!(maps?.Roadview && maps?.RoadviewClient && maps?.LatLng && maps?.event);
const finite = value => value !== null && value !== '' && value !== undefined && Number.isFinite(Number(value));

export function distanceMeters(a, b) {
  if (!a || !b) return Infinity;
  const r = Math.PI / 180;
  const p1 = a.lat * r, p2 = b.lat * r;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function vehiclePosition(state) {
  if (!state || !finite(state.lon) || !finite(state.lat)) return null;
  // Replay keeps the departure node as a placeholder for unresolved movement.
  // It must not become a purported current vehicle location in the photo view.
  if (state.status === 'unknown' || state.geometryQuality === 'unresolved') return null;
  const lon = Number(state.lon), lat = Number(state.lat);
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
  return {lon, lat, heading: normalizedHeading(state.heading), id: state.id, time: finite(state.time) ? Number(state.time) : null};
}

/** Key remains in memory/the SDK request only; never saved to project or storage. */
function loadKakaoSDK(key) {
  if (sdkLoad && sdkLoad.key !== key) return Promise.reject(new Error('키를 변경하려면 페이지를 새로고침한 뒤 다시 연결해 주세요.'));
  if (hasSDK(globalThis.kakao?.maps)) return Promise.resolve(globalThis.kakao.maps);
  if (sdkLoad) return sdkLoad.promise;
  if (!globalThis.document?.createElement) return Promise.reject(new Error(SDK_ERROR));
  const script = document.createElement('script');
  script.async = true;
  script.src = `${SDK_URL}?appkey=${encodeURIComponent(key)}&autoload=false`;
  const record = {key, script};
  sdkLoad = record;
  record.promise = new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => finish(null), 18000);
    const finish = maps => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      script.onload = script.onerror = null;
      if (hasSDK(maps)) resolve(maps);
      else {
        script.remove();
        if (sdkLoad === record) sdkLoad = null;
        reject(new Error(SDK_ERROR));
      }
    };
    script.onerror = () => finish(null);
    script.onload = () => {
      try {
        const maps = globalThis.kakao?.maps;
        if (!maps?.load) { finish(null); return; }
        maps.load(() => finish(globalThis.kakao?.maps));
      } catch { finish(null); }
    };
    document.head.append(script);
  });
  return record.promise;
}

export default class KakaoRoadview {
  constructor(container, {onStatus = () => {}, sdk = null, now = () => performance.now(), timers = globalThis,
    intervalMs = 1200, searchDistanceM = 8, timeoutMs = 8000} = {}) {
    this.container = container;
    this.onStatus = onStatus;
    this._injectedSDK = sdk?.maps || sdk;
    this._now = now;
    this._setTimeout = timers.setTimeout.bind(timers);
    this._clearTimeout = timers.clearTimeout.bind(timers);
    this.intervalMs = Math.max(0, intervalMs);
    this.searchDistanceM = searchDistanceM;
    this.timeoutMs = timeoutMs;
    this._ready = false;
    this._active = false;
    this._destroyed = false;
    this._epoch = 0;
    this._connectEpoch = 0;
    this._latest = null;
    this._context = undefined;
    this._lastAttempt = null;
    this._lastSearchAt = -Infinity;
    this._lastHeadingAt = -Infinity;
    this._lastHeading = null;
    this._pending = null;
    this._expectedPano = null;
    this._photoPosition = null;
    this._photoReady = false;
    this._scheduled = null;
    this._loadTimer = null;
    this._searchTimer = null;
    this._layoutTimer = null;
    this._forceRequested = false;
    this._listeners = [];
    this.followHeading = true;
    this._state = {ready: false, phase: 'disconnected', message: '카카오 JavaScript 키를 연결하면 실제 로드뷰를 볼 수 있습니다.'};
    this._statusSignature = '';
    this._pointerDown = () => this.setFollowHeading(false);
    container?.addEventListener?.('pointerdown', this._pointerDown, {passive: true});
    this._show(false);
  }

  get isReady() { return this._ready; }

  /** Resolves false on a recoverable connection error; reports a safe Korean message. */
  async connect(jsKey) {
    if (this._destroyed) return false;
    if (this._ready) return true;
    if (this._connecting) return this._connecting;
    const key = String(jsKey || '').trim();
    if (!key && !this._injectedSDK) {
      this._emit('error', '카카오 개발자 사이트의 JavaScript 키를 입력해 주세요.');
      return false;
    }
    const epoch = ++this._connectEpoch;
    this._emit('loading', '카카오 로드뷰 연결 중…');
    this._connecting = (async () => {
      try {
        const maps = this._injectedSDK || await loadKakaoSDK(key);
        if (this._destroyed || epoch !== this._connectEpoch) return false;
        if (!hasSDK(maps)) throw new Error(SDK_ERROR);
        this._maps = maps;
        this._view = new maps.Roadview(this.container, {pan: this._latest?.heading || 0, tilt: 0, zoom: 0});
        this._client = new maps.RoadviewClient();
        for (const name of ['init', 'panoid_changed', 'position_changed']) {
          const listener = () => this._onPhotoChanged();
          maps.event.addListener(this._view, name, listener);
          this._listeners.push([name, listener]);
        }
        this._ready = true;
        this._emit(this._active ? 'searching' : 'inactive', this._active ? '선택 차량 주변의 촬영 지점을 찾습니다.' : '로드뷰 연결 완료 · 로드뷰 모드에서 볼 수 있습니다.');
        this._relayout();
        this._queue(true);
        return true;
      } catch (error) {
        if (this._destroyed || epoch !== this._connectEpoch) return false;
        this._ready = false;
        this._show(false);
        const message = error?.message === '키를 변경하려면 페이지를 새로고침한 뒤 다시 연결해 주세요.' ? error.message : SDK_ERROR;
        this._emit('error', message);
        return false;
      } finally {
        this._connecting = null;
      }
    })();
    return this._connecting;
  }

  setActive(active) {
    const next = !!active;
    if (this._destroyed || next === this._active) return;
    this._active = next;
    this._invalidate();
    if (!next) {
      this._emit('inactive', 'V-World 모드 · 로드뷰 조회 일시 중지');
      return;
    }
    this._relayout();
    if (!this._ready) this._emit('disconnected', '카카오 JavaScript 키를 연결하면 실제 로드뷰를 볼 수 있습니다.');
    else if (this._latest) this._queue(true);
    else this._emit('searching', '차량 위치를 기다리는 중…');
  }

  /** Feed canonical stateAt() coordinates, never the illustrative stopped-vehicle spacing. */
  update(state, {contextKey, force = false} = {}) {
    if (this._destroyed) return;
    const next = vehiclePosition(state);
    const changed = (contextKey !== undefined && contextKey !== this._context)
      || (next && this._latest && next.id !== this._latest.id)
      || (next?.time !== null && this._latest?.time !== null && next && this._latest && next.time < this._latest.time - 0.0001);
    if (changed) this._invalidate();
    if (contextKey !== undefined) this._context = contextKey;
    this._latest = next;
    if (!next) {
      this._invalidate();
      if (this._active && this._ready) this._emit('unavailable', '현재 차량 위치가 확인되지 않아 로드뷰를 표시할 수 없습니다.');
      return;
    }
    if (!this._active || !this._ready) return;
    this._applyHeading();
    if (this._photoReady && !this._pending) this._reportPhoto();
    this._queue(force || changed);
  }

  /** Invalidates in-flight results when seeking or loading another run. */
  reset() {
    if (this._destroyed) return;
    this._invalidate();
    this._latest = null;
    this._context = undefined;
    if (this._active && this._ready) this._emit('searching', '변경된 차량 위치를 확인하는 중…');
  }

  refresh() {
    if (this._destroyed) return;
    this._invalidate();
    this._relayout();
    this._queue(true);
  }

  setFollowHeading(value) {
    if (this._destroyed) return;
    this.followHeading = !!value;
    if (this.followHeading) this._applyHeading(true);
    this._emit(this._state.phase, this._state.message, {panoId: this._state.panoId, distanceM: this._state.distanceM});
  }

  _emit(phase, message, extra = {}) {
    if (this._destroyed) return;
    this._state = {ready: this._ready, phase, message, followHeading: this.followHeading, ...extra};
    if (this.container?.dataset) this.container.dataset.roadviewPhase = phase;
    const signature = JSON.stringify(this._state);
    if (signature === this._statusSignature) return;
    this._statusSignature = signature;
    this.onStatus({...this._state});
  }

  _show(show) {
    if (this.container?.style) this.container.style.visibility = show ? 'visible' : 'hidden';
  }

  _clearTimer(name) {
    if (this[name] !== null) this._clearTimeout(this[name]);
    this[name] = null;
  }

  _invalidate() {
    ++this._epoch;
    this._pending = null;
    this._expectedPano = null;
    this._lastAttempt = null;
    this._photoPosition = null;
    this._photoReady = false;
    this._forceRequested = false;
    // Keep the wall-clock rate limit across seeks; the slider may emit dozens
    // of resets per second. The next query still uses only the latest target.
    this._lastHeading = null;
    for (const name of ['_scheduled', '_searchTimer', '_loadTimer']) this._clearTimer(name);
    this._show(false);
  }

  _relayout() {
    this._clearTimer('_layoutTimer');
    this._layoutTimer = this._setTimeout(() => {
      this._layoutTimer = null;
      if (!this._destroyed && this._active) this._view?.relayout();
    }, 0);
  }

  _queue(force = false) {
    if (this._destroyed || !this._ready || !this._active || !this._latest) return;
    this._forceRequested ||= force;
    if (this._pending) return;
    if (!this._forceRequested && this._lastAttempt && distanceMeters(this._lastAttempt, this._latest) < this.searchDistanceM) return;
    const wait = Math.max(0, this.intervalMs - (this._now() - this._lastSearchAt));
    if (wait > 0) {
      if (this._scheduled === null) {
        this._scheduled = this._setTimeout(() => { this._scheduled = null; this._queue(); }, wait);
      }
      return;
    }
    this._clearTimer('_scheduled');
    this._forceRequested = false;
    this._search({...this._latest});
  }

  _search(point) {
    const epoch = this._epoch;
    const request = {epoch, point, radius: 50};
    this._pending = request;
    this._lastAttempt = point;
    this._lastSearchAt = this._now();
    this._emit('searching', this._photoReady ? '현재 차량 주변 검색 중 · 이전 촬영 지점 표시' : '현재 차량 주변의 실제 촬영 지점을 검색 중…');
    const valid = () => !this._destroyed && this._active && this._pending === request && this._epoch === epoch;
    const fail = message => {
      if (!valid()) return;
      this._pending = null;
      this._clearTimer('_searchTimer');
      this._clearTimer('_loadTimer');
      this._expectedPano = null;
      this._photoReady = false;
      this._show(false);
      this._emit('error', message);
      this._queue();
    };
    const lookup = radius => {
      request.radius = radius;
      this._clearTimer('_searchTimer');
      this._searchTimer = this._setTimeout(() => fail('로드뷰 조회 응답이 없습니다. 네트워크를 확인한 뒤 다시 조회해 주세요.'), this.timeoutMs);
      try {
        this._client.getNearestPanoId(new this._maps.LatLng(point.lat, point.lon), radius, panoId => {
          if (!valid() || request.radius !== radius) return;
          this._clearTimer('_searchTimer');
          if (panoId === null || panoId === undefined || panoId === 0) {
            if (radius === 50) { lookup(100); return; }
            this._pending = null;
            this._expectedPano = null;
            this._photoReady = false;
            this._show(false);
            this._emit('unavailable', '차량 주변 100 m 안에 제공되는 로드뷰가 없습니다. V-World에서 계속 확인할 수 있습니다.');
            this._queue();
            return;
          }
          this._pending = null;
          this._clearTimer('_loadTimer');
          const same = this._photoReady && String(this._view.getPanoId()) === String(panoId);
          this._expectedPano = {id: panoId, point, epoch, corrections: 0, lastCorrectionAt: -Infinity};
          if (same) {
            this._onPhotoChanged();
            this._queue();
            return;
          }
          this._photoReady = false;
          this._show(false);
          this._emit('loading', '실제 촬영 사진을 불러오는 중…');
          this._waitForPhoto(this._expectedPano);
          try { this._view.setPanoId(panoId, new this._maps.LatLng(point.lat, point.lon)); }
          catch {
            this._clearTimer('_loadTimer');
            this._expectedPano = null;
            this._emit('error', '로드뷰 사진을 표시하지 못했습니다. 다시 조회해 주세요.');
          }
          this._queue();
        });
      } catch { fail('로드뷰 조회에 실패했습니다. JavaScript 키와 등록 도메인을 확인해 주세요.'); }
    };
    lookup(50);
  }

  _waitForPhoto(expected) {
    this._clearTimer('_loadTimer');
    this._loadTimer = this._setTimeout(() => {
      this._loadTimer = null;
      if (this._destroyed || expected.epoch !== this._epoch || this._expectedPano !== expected) return;
      this._expectedPano = null;
      this._photoReady = false;
      this._show(false);
      this._emit('error', '로드뷰 사진을 불러오지 못했습니다. 다시 조회해 주세요.');
    }, this.timeoutMs);
  }

  _onPhotoChanged() {
    const expected = this._expectedPano;
    if (this._destroyed || !this._active || !expected || expected.epoch !== this._epoch) return;
    let id;
    try { id = this._view.getPanoId(); } catch { return; }
    if (String(id) !== String(expected.id)) {
      this._photoReady = false;
      this._photoPosition = null;
      this._show(false);
      this._emit('loading', '선택 위치의 촬영 사진을 다시 확인하는 중…');
      if (this._loadTimer === null) this._waitForPhoto(expected);
      // An earlier SDK image request can finish after a seek. Never display it as current.
      // Several SDK events can describe one stale image; coalesce those retries.
      if (expected.corrections < 2 && this._now() - expected.lastCorrectionAt >= 250) {
        expected.corrections++;
        expected.lastCorrectionAt = this._now();
        try { this._view.setPanoId(expected.id, new this._maps.LatLng(expected.point.lat, expected.point.lon)); } catch { /* timeout reports failure */ }
      }
      return;
    }
    this._clearTimer('_loadTimer');
    let point;
    try {
      const position = this._view.getPosition();
      point = vehiclePosition({lon: position?.getLng(), lat: position?.getLat()});
    } catch { point = null; }
    this._photoPosition = point;
    this._photoReady = true;
    this._show(true);
    this._applyHeading(true);
    this._reportPhoto();
  }

  _reportPhoto() {
    if (!this._photoReady || !this._active) return;
    const metres = Math.round(distanceMeters(this._photoPosition, this._latest));
    const distanceM = Number.isFinite(metres) ? metres : null;
    const proximity = distanceM === null ? '주변 촬영 지점' : `차량에서 약 ${distanceM.toLocaleString('ko-KR')} m`;
    this._emit('ready', `실제 촬영 사진 · ${proximity}`, {panoId: this._expectedPano?.id, distanceM});
  }

  _applyHeading(force = false) {
    if (!this._active || !this._photoReady || !this.followHeading || !this._latest) return;
    const pan = this._latest.heading;
    const delta = this._lastHeading === null ? 360 : Math.abs(((pan - this._lastHeading + 540) % 360) - 180);
    if (!force && (delta < 1.5 || this._now() - this._lastHeadingAt < 180)) return;
    try {
      this._view.setViewpoint({pan, tilt: 0, zoom: 0});
      this._lastHeading = pan;
      this._lastHeadingAt = this._now();
    } catch { /* init/panoid_changed will apply the latest heading again. */ }
  }

  destroy() {
    if (this._destroyed) return;
    this._invalidate();
    this._clearTimer('_layoutTimer');
    ++this._connectEpoch;
    this._destroyed = true;
    this._ready = false;
    this.container?.removeEventListener?.('pointerdown', this._pointerDown);
    for (const [name, listener] of this._listeners) {
      try { this._maps.event.removeListener(this._view, name, listener); } catch { /* already removed */ }
    }
    this._listeners = [];
    // Kakao Roadview has no documented destroy method; remove only its owned DOM.
    this.container?.replaceChildren?.();
    this._view = this._client = null;
  }
}
