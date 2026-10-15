// The playback sync protocol.
//
// One member, the host, owns the room state: what is loaded, whether it plays,
// where, how fast, the queue and the lock. Everyone else sends intents ("play",
// "seek to 42 s") to the host. The host applies them in arrival order with
// applyIntent() and broadcasts the new state. Each state carries an epoch (it
// grows when a new host takes over) and a sequence number, so a peer keeps
// only the newest state it has seen, whatever order messages arrive in.
//
// A state does not say "the video is at 42 s", it says "the video was at
// 42 s at host time T and plays at rate R". With a clock offset to the host
// (ClockSync), every peer computes the same expected position at any moment,
// and correction() turns the difference between that and its own player into
// an action: nothing, a small playback rate nudge, or a seek.

/** Tunable numbers. All positions are in seconds, times in milliseconds. */
export const SYNC = Object.freeze({
  /** Drift (s) that makes a local file player seek instead of nudging its rate. */
  HARD_SEEK: 0.75,
  /** The same for the YouTube player, which seeks slower and only has fixed rates. */
  HARD_SEEK_YT: 1.2,
  /** Drift (s) small enough to ignore: play at the base rate. */
  SOFT: 0.08,
  /** A rate nudge removes the drift over this many seconds of playback. */
  NUDGE_HORIZON: 2.5,
  /** The largest rate nudge, as a fraction of the base rate (8 percent). */
  MAX_NUDGE: 0.08,
  /** Drift (s) a paused player may have before it is moved to the right frame. */
  PAUSED_TOL: 0.15,
  /** Two changes from different people closer than this (ms) count as pressed at once. */
  CONFLICT_WINDOW_MS: 700,
  /** How far back (ms) a pause may reach to stop on the frame the person saw. */
  MAX_PAUSE_REWIND_MS: 2000,
  /** The longest queue. */
  MAX_QUEUE: 50,
});

export const MIN_RATE = 0.25;
export const MAX_RATE = 2;

/** Actions that change playback and are refused when the host locks the room. */
export const CONTROL_ACTIONS = new Set(['play', 'pause', 'seek', 'rate', 'load', 'unload', 'next', 'queue-remove', 'queue-move']);
/** Actions that take part in the "pressed at the same time" rule. */
const PLAYBACK_ACTIONS = new Set(['play', 'pause', 'seek', 'rate']);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const finite = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

/** A fresh room state. */
export function initialState({ host = null, now = 0 } = {}) {
  return { epoch: 0, seq: 0, host, src: null, playing: false, pos: 0, rate: 1, at: now, by: null, changedAt: now, lock: false, queue: [] };
}

/** True when state a is newer than state b (epoch first, then sequence). */
export function isNewer(a, b) {
  if (!b) return !!a;
  if (!a) return false;
  return a.epoch > b.epoch || (a.epoch === b.epoch && a.seq > b.seq);
}

/** Where the video should be at host time hostNow (seconds, never negative, never past the end). */
export function positionAt(state, hostNow) {
  if (!state?.src) return 0;
  let p = state.pos;
  if (state.playing) p += (Math.max(0, hostNow - state.at) / 1000) * state.rate;
  const end = state.src.duration;
  return Number.isFinite(end) && end > 0 ? clamp(p, 0, end) : Math.max(0, p);
}

/** True when the state says the video has reached its end. */
export function hasEnded(state, hostNow) {
  const end = state?.src?.duration;
  return !!state?.src && Number.isFinite(end) && end > 0 && positionAt(state, hostNow) >= end - 0.05;
}

/**
 * What a player should do to follow the room.
 *   expected  where the room is (positionAt)
 *   actual    where this player is
 *   playing   whether the room plays
 *   rate      the room's rate
 *   playerRate the rate this player runs at right now
 *   kind      'file' (any rate works) or 'yt' (fixed rates, slower seeks)
 *   buffering this player is waiting for data
 * Returns { action: 'none' | 'seek' | 'rate', to, rate, drift } where drift is
 * actual minus expected: positive means this player is ahead.
 */
export function correction({ expected, actual, playing, rate = 1, playerRate = rate, kind = 'file', buffering = false }, opts = SYNC) {
  const drift = actual - expected;
  const base = clamp(finite(rate, 1), MIN_RATE, MAX_RATE);
  const none = { action: 'none', drift };
  if (!Number.isFinite(drift)) return { action: 'seek', to: expected, drift: 0 };
  if (!playing) {
    if (Math.abs(drift) > opts.PAUSED_TOL) return { action: 'seek', to: expected, drift };
    return none;
  }
  if (buffering) return none;
  const hard = kind === 'yt' ? opts.HARD_SEEK_YT : opts.HARD_SEEK;
  if (Math.abs(drift) >= hard) return { action: 'seek', to: expected, drift };
  let want = base;
  // The YouTube player only plays at a few fixed rates, so it is corrected by seeking alone.
  if (kind !== 'yt' && Math.abs(drift) > opts.SOFT) {
    const nudge = clamp(-drift / opts.NUDGE_HORIZON, -opts.MAX_NUDGE, opts.MAX_NUDGE);
    want = base * (1 + nudge);
  }
  want = Math.round(want * 1000) / 1000;
  if (Math.abs(want - playerRate) > 0.0005) return { action: 'rate', rate: want, drift };
  return none;
}

/** The nearest rate a player supports. */
export function snapRate(rate, rates) {
  if (!rates?.length) return rate;
  return rates.reduce((best, r) => (Math.abs(r - rate) < Math.abs(best - rate) ? r : best), rates[0]);
}

/**
 * Clock offset to the host from ping and pong round trips, the way network
 * time works: a ping leaves at local t0, the host stamps its clock h, the
 * pong arrives at local t1. If both legs take as long, the host clock read h
 * at local (t0 + t1) / 2. The sample with the shortest round trip has the
 * least room for an uneven split, so it wins.
 */
export class ClockSync {
  constructor({ keep = 10 } = {}) {
    this.keep = keep;
    this.samples = [];
  }

  /** Add one round trip. Returns the sample, or null when it makes no sense. */
  add({ t0, t1, h }) {
    if (![t0, t1, h].every(Number.isFinite) || t1 < t0) return null;
    const sample = { rtt: t1 - t0, offset: h - (t0 + t1) / 2 };
    this.samples.push(sample);
    if (this.samples.length > this.keep) this.samples.shift();
    return sample;
  }

  get ready() {
    return this.samples.length > 0;
  }

  best() {
    let best = null;
    for (const s of this.samples) if (!best || s.rtt < best.rtt) best = s;
    return best;
  }

  /** Host clock minus local clock, in ms (0 before the first sample). */
  get offset() {
    return this.best()?.offset ?? 0;
  }

  /** The shortest round trip seen, in ms. */
  get rtt() {
    return this.best()?.rtt ?? null;
  }

  /** The host clock now, from the local clock. */
  hostNow(localNow) {
    return localNow + this.offset;
  }

  reset() {
    this.samples = [];
  }
}

/** Clean a video source description. Returns null when it is not usable. */
export function cleanSource(src) {
  if (!src || typeof src !== 'object') return null;
  const title = String(src.title || '').slice(0, 200);
  const duration = Number.isFinite(src.duration) && src.duration > 0 ? src.duration : null;
  if (src.kind === 'yt' && /^[A-Za-z0-9_-]{11}$/.test(src.id || '')) return { kind: 'yt', id: src.id, title, duration };
  if (src.kind === 'file' && /^[0-9a-f]{32}$/.test(src.hash || '') && Number.isFinite(src.size) && src.size > 0) {
    return { kind: 'file', hash: src.hash, size: src.size, name: String(src.name || 'video').slice(0, 200), title: title || String(src.name || 'video').slice(0, 200), duration };
  }
  if (src.kind === 'screen' && typeof src.id === 'string' && src.id.length <= 64) return { kind: 'screen', id: src.id, title, duration: null };
  return null;
}

/** Clean a queue item: a source plus who added it. */
export function cleanItem(item, by) {
  const src = cleanSource(item?.src);
  if (!src || src.kind === 'screen') return null;
  const id = typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(item.id) ? item.id : null;
  if (!id) return null;
  return { id, src, by: String(by || item.by || '').slice(0, 64) };
}

const sameKind = (a, b) => a === b;

/**
 * The host applies one intent to the state. Returns { state, result } where
 * result is 'applied' (state is a new object with seq + 1) or the reason it
 * was not: 'locked', 'duplicate', 'conflict', 'invalid' or 'noop'.
 *
 * Conflict rules, for two people who press at nearly the same time:
 * - An intent is judged against the state its sender had seen (intent.base).
 * - If the state changed since then, the change came from someone else and it
 *   is less than CONFLICT_WINDOW_MS old, the two presses were simultaneous.
 *   The first one the host received wins. The later one is dropped: as a
 *   'duplicate' when it asked for the same thing (two plays, two pauses, two
 *   seeks to about the same spot), as a 'conflict' when it asked for
 *   something else (a play against a pause). Both senders then follow the
 *   winning state, so nobody ends up out of step.
 * - Outside that window, an intent is a new decision and is applied.
 * - When the host locked the room, control intents from anyone but the host
 *   are refused. Adding to the queue still works.
 */
export function applyIntent(state, intent, { now, host = state.host, opts = SYNC } = {}) {
  const action = intent?.action;
  const by = intent?.by;
  if (typeof action !== 'string' || !by) return { state, result: 'invalid' };
  if (state.lock && by !== host && CONTROL_ACTIONS.has(action)) return { state, result: 'locked' };

  const base = Number.isFinite(intent.base) ? intent.base : state.seq;
  const stale = base < state.seq && state.by && state.by !== by && now - state.changedAt < opts.CONFLICT_WINDOW_MS;
  if (stale && PLAYBACK_ACTIONS.has(action) && PLAYBACK_ACTIONS.has(state.lastAction)) {
    const same = sameKind(action, state.lastAction) && (action !== 'seek' || Math.abs(finite(intent.pos, -99) - state.pos) < 1);
    return { state, result: same ? 'duplicate' : 'conflict' };
  }

  const next = { ...state, queue: state.queue.slice() };
  const pos = positionAt(state, now);
  switch (action) {
    case 'play':
      if (!state.src) return { state, result: 'invalid' };
      if (state.playing) return { state, result: 'noop' };
      next.playing = true;
      next.pos = Number.isFinite(intent.pos) ? clampPos(intent.pos, state) : pos;
      next.at = now;
      break;
    case 'pause': {
      if (!state.src) return { state, result: 'invalid' };
      if (!state.playing) return { state, result: 'noop' };
      // Stop on the frame the person saw when they pressed, not a few network hops later.
      const pressed = Number.isFinite(intent.t) ? clamp(intent.t, now - opts.MAX_PAUSE_REWIND_MS, now) : now;
      next.playing = false;
      next.pos = positionAt(state, pressed);
      next.at = now;
      break;
    }
    case 'seek':
      if (!state.src || !Number.isFinite(intent.pos)) return { state, result: 'invalid' };
      next.pos = clampPos(intent.pos, state);
      next.at = now;
      break;
    case 'rate': {
      if (!state.src || !Number.isFinite(intent.rate)) return { state, result: 'invalid' };
      const rate = clamp(intent.rate, MIN_RATE, MAX_RATE);
      if (rate === state.rate) return { state, result: 'noop' };
      next.pos = pos;
      next.at = now;
      next.rate = rate;
      break;
    }
    case 'load': {
      const src = cleanSource(intent.src);
      if (!src) return { state, result: 'invalid' };
      next.src = src;
      next.playing = false;
      next.pos = Number.isFinite(intent.pos) && intent.pos > 0 ? intent.pos : 0;
      next.at = now;
      next.rate = 1;
      if (intent.itemId) next.queue = next.queue.filter((q) => q.id !== intent.itemId);
      break;
    }
    case 'unload':
      if (!state.src) return { state, result: 'noop' };
      next.src = null;
      next.playing = false;
      next.pos = 0;
      next.at = now;
      break;
    case 'duration': {
      // The host's player learned the length of what is loaded.
      if (by !== host || !state.src || !Number.isFinite(intent.duration) || intent.duration <= 0) return { state, result: 'invalid' };
      if (state.src.duration === intent.duration) return { state, result: 'noop' };
      next.src = { ...state.src, duration: intent.duration };
      next.pos = pos;
      next.at = now;
      break;
    }
    case 'next': {
      const [first, ...rest] = state.queue;
      if (!first) return { state, result: 'noop' };
      next.src = first.src;
      next.queue = rest;
      next.playing = !!intent.autoplay;
      next.pos = 0;
      next.at = now;
      next.rate = 1;
      break;
    }
    case 'queue-add': {
      const item = cleanItem(intent.item, by);
      if (!item || state.queue.length >= opts.MAX_QUEUE || state.queue.some((q) => q.id === item.id)) return { state, result: 'invalid' };
      next.queue.push(item);
      break;
    }
    case 'queue-remove': {
      const i = state.queue.findIndex((q) => q.id === intent.itemId);
      if (i < 0) return { state, result: 'noop' };
      next.queue.splice(i, 1);
      break;
    }
    case 'queue-move': {
      const i = state.queue.findIndex((q) => q.id === intent.itemId);
      if (i < 0 || !Number.isInteger(intent.to)) return { state, result: 'invalid' };
      const to = clamp(intent.to, 0, state.queue.length - 1);
      if (to === i) return { state, result: 'noop' };
      const [item] = next.queue.splice(i, 1);
      next.queue.splice(to, 0, item);
      break;
    }
    case 'lock':
      if (by !== host) return { state, result: 'invalid' };
      if (!!intent.lock === state.lock) return { state, result: 'noop' };
      next.lock = !!intent.lock;
      break;
    default:
      return { state, result: 'invalid' };
  }
  next.seq = state.seq + 1;
  next.by = by;
  next.changedAt = now;
  next.lastAction = action;
  return { state: next, result: 'applied' };
}

function clampPos(p, state) {
  const end = state.src?.duration;
  return Number.isFinite(end) && end > 0 ? clamp(p, 0, end) : Math.max(0, p);
}

/**
 * A new host takes over after the old one left. The position is frozen at
 * where the room was by the old host's clock (estimated with the offset this
 * peer had), then restated on the new host's clock. The epoch grows, so every
 * peer prefers this state to anything the old host sent.
 */
export function takeOver(state, { host, now, oldHostNow }) {
  const pos = positionAt(state, oldHostNow);
  return { ...state, queue: state.queue.slice(), epoch: state.epoch + 1, seq: state.seq + 1, host, pos, at: now, changedAt: now, by: host, lastAction: 'takeover', lock: false };
}

/**
 * What a member who just joined (or who just got a newer state) should show.
 * Returns { state, position, playing, needs } where state is the newest of
 * the two and needs says what this member must do before it can follow:
 * 'nothing', 'youtube' (load the player), 'file' (pick the same file) or
 * 'screen' (wait for the shared screen).
 */
export function joinView(local, incoming, hostNow, { fileHash = null } = {}) {
  const state = isNewer(incoming, local) ? incoming : local;
  const src = state?.src;
  let needs = 'nothing';
  if (src?.kind === 'yt') needs = 'youtube';
  else if (src?.kind === 'file') needs = fileHash === src.hash ? 'nothing' : 'file';
  else if (src?.kind === 'screen') needs = 'screen';
  return { state, position: positionAt(state, hostNow), playing: !!state?.playing, needs };
}

/**
 * Tells the room's own player events apart from the ones a person caused.
 * Before the app plays, pauses, seeks or changes the rate itself, it calls
 * expect(); the event that follows is then an echo and is not sent as an
 * intent. Anything else came from a person using the player controls.
 */
export class EchoGuard {
  constructor({ windowMs = 1500, seekTolerance = 0.6 } = {}) {
    this.windowMs = windowMs;
    this.seekTolerance = seekTolerance;
    this.pending = [];
  }

  expect(kind, value, now) {
    this.pending.push({ kind, value, until: now + this.windowMs });
  }

  /** True (and consumed) when this event was caused by the app itself. */
  isEcho(kind, value, now) {
    this.pending = this.pending.filter((p) => p.until >= now);
    const i = this.pending.findIndex((p) => p.kind === kind && (kind !== 'seek' || !Number.isFinite(value) || Math.abs(p.value - value) <= this.seekTolerance) && (kind !== 'rate' || Math.abs(p.value - value) < 0.01));
    if (i < 0) return false;
    this.pending.splice(i, 1);
    return true;
  }

  clear() {
    this.pending = [];
  }
}
