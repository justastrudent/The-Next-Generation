/** UI timing only. Research timestamps and event records are never modified. */
export function playbackSpeed(value, fallback = 120) {
  const n = typeof value === 'string' && !value.trim() ? NaN : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(Math.max(.1, Math.min(600, n)) * 10) / 10 : fallback;
}

/** Coalesce a burst of slider input into one preview per frame and one final commit. */
export class SeekCoordinator {
  constructor({onPreview, onCommit, requestFrame = callback => requestAnimationFrame(callback),
    cancelFrame = id => cancelAnimationFrame(id), setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = id => clearTimeout(id), delayMs = 160}) {
    Object.assign(this, {onPreview, onCommit, requestFrame, cancelFrame, setTimer, clearTimer, delayMs});
    this.pending = null; this.frame = null; this.timer = null;
  }
  request(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return false;
    this.pending = Math.max(30, Math.min(990, n));
    if (this.frame === null) this.frame = this.requestFrame(() => {
      this.frame = null;
      if (this.pending !== null) this.onPreview(this.pending);
    });
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => this.flush(), this.delayMs);
    return true;
  }
  flush() {
    const value = this.pending;
    this.cancel();
    if (value !== null) this.onCommit(value);
  }
  cancel() {
    if (this.frame !== null) this.cancelFrame(this.frame);
    if (this.timer !== null) this.clearTimer(this.timer);
    this.frame = null; this.timer = null; this.pending = null;
  }
}

/** Only forward playback may announce calls. A seek explicitly resets this cursor. */
export class PassengerCallCursor {
  constructor() { this.time = null; this.runId = null; }
  reset(time, runId) { this.time = Number.isFinite(time) ? time : null; this.runId = runId ?? null; }
  advance(time, feedback, {enabled = true, playing = true, scrubbing = false} = {}) {
    const previous = this.time, sameRun = this.runId === feedback?.runId;
    this.reset(time, feedback?.runId);
    if (!sameRun || previous === null || !Number.isFinite(time) || time <= previous || !enabled || !playing || scrubbing) return [];
    return feedback?.callsBetween(previous, time) || [];
  }
}

export function readPresentationPreferences(storage) {
  const defaults = {callAlerts: true, bubbles: true, speed: 120};
  try {
    const saved = JSON.parse(storage?.getItem('metrorookies.presentation.v7') || 'null');
    return {callAlerts: typeof saved?.callAlerts === 'boolean' ? saved.callAlerts : true,
      bubbles: typeof saved?.bubbles === 'boolean' ? saved.bubbles : true,
      speed: playbackSpeed(saved?.speed, 120)};
  } catch { return defaults; }
}

export function savePresentationPreferences(storage, preferences) {
  try { storage?.setItem('metrorookies.presentation.v7', JSON.stringify({
    callAlerts: preferences.callAlerts !== false, bubbles: preferences.bubbles !== false,
    speed: playbackSpeed(preferences.speed)
  })); } catch { /* Private browsing/storage limits must not interrupt playback. */ }
}
