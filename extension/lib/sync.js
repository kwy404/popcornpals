// Built by scripts/build-extension.mjs from src/sync.js and src/extsync.js. Edit those instead.
(() => {
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
const SYNC = Object.freeze({
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
  /** A press this soon (ms) after someone else flipped play or pause was aimed at the screen before the flip. */
  REACTION_MS: 500,
});

const MIN_RATE = 0.25;
const MAX_RATE = 2;

/** Actions that change playback and are refused when the host locks the room. */
const CONTROL_ACTIONS = new Set(['play', 'pause', 'seek', 'rate', 'load', 'unload', 'next', 'queue-remove', 'queue-move']);
/** Actions that take part in the "pressed at the same time" rule. */
const PLAYBACK_ACTIONS = new Set(['play', 'pause', 'seek', 'rate']);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const finite = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

/** A fresh room state. */
function initialState({ host = null, now = 0 } = {}) {
  return { epoch: 0, seq: 0, host, src: null, playing: false, pos: 0, rate: 1, at: now, by: null, changedAt: now, lock: false, queue: [] };
}

/** True when state a is newer than state b (epoch first, then sequence). */
function isNewer(a, b) {
  if (!b) return !!a;
  if (!a) return false;
  return a.epoch > b.epoch || (a.epoch === b.epoch && a.seq > b.seq);
}

/** Where the video should be at host time hostNow (seconds, never negative, never past the end). */
function positionAt(state, hostNow) {
  if (!state?.src) return 0;
  let p = state.pos;
  if (state.playing) p += (Math.max(0, hostNow - state.at) / 1000) * state.rate;
  const end = state.src.duration;
  return Number.isFinite(end) && end > 0 ? clamp(p, 0, end) : Math.max(0, p);
}

/** True when the state says the video has reached its end. */
function hasEnded(state, hostNow) {
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
function correction({ expected, actual, playing, rate = 1, playerRate = rate, kind = 'file', buffering = false }, opts = SYNC) {
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
function snapRate(rate, rates) {
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
class ClockSync {
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
function cleanSource(src) {
  if (!src || typeof src !== 'object') return null;
  const title = String(src.title || '').slice(0, 200);
  const duration = Number.isFinite(src.duration) && src.duration > 0 ? src.duration : null;
  if (src.kind === 'yt' && /^[A-Za-z0-9_-]{11}$/.test(src.id || '')) return { kind: 'yt', id: src.id, title, duration };
  if (src.kind === 'file' && /^[0-9a-f]{32}$/.test(src.hash || '') && Number.isFinite(src.size) && src.size > 0) {
    // 'stream': one person (id) has the file and streams it to everyone.
    // 'local': everyone opens the same file on their own device; only sync messages travel.
    const mode = src.mode === 'local' ? 'local' : 'stream';
    if (mode === 'stream' && !(typeof src.id === 'string' && src.id.length > 0 && src.id.length <= 64)) return null;
    const name = String(src.name || 'video').slice(0, 200);
    const out = { kind: 'file', mode, hash: src.hash, size: src.size, name, title: title || name, duration };
    if (mode === 'stream') out.id = src.id;
    return out;
  }
  if (src.kind === 'screen' && typeof src.id === 'string' && src.id.length <= 64) return { kind: 'screen', id: src.id, title, duration: null };
  // Everyone plays the video on a streaming site with their own account, through the extension.
  if (src.kind === 'ext' && typeof src.id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(src.id)) return { kind: 'ext', id: src.id, title, duration };
  return null;
}

/** Clean a queue item: a source plus who added it. */
function cleanItem(item, by) {
  const src = cleanSource(item?.src);
  if (!src || src.kind === 'screen' || src.kind === 'ext') return null;
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
function applyIntent(state, intent, { now, host = state.host, opts = SYNC } = {}) {
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

/**
 * What a press on the play/pause button means. Normally it toggles the state
 * on screen. But people cannot react within half a second: when someone else
 * flipped play or pause just before the press, the person was pressing at
 * what they saw before the flip. The intent then carries that older state's
 * sequence number, so the host treats the two presses as simultaneous (a
 * duplicate when both wanted the same thing) instead of flipping back.
 *   flip: { at, playing, seq } the state shown before the last flip by someone else
 */
function pressIntent(state, flip, now, opts = SYNC) {
  if (flip && now - flip.at < opts.REACTION_MS) return { action: flip.playing ? 'pause' : 'play', base: flip.seq };
  return { action: state.playing ? 'pause' : 'play', base: state.seq };
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
function takeOver(state, { host, now, oldHostNow }) {
  const pos = positionAt(state, oldHostNow);
  return { ...state, queue: state.queue.slice(), epoch: state.epoch + 1, seq: state.seq + 1, host, pos, at: now, changedAt: now, by: host, lastAction: 'takeover', lock: false };
}

/**
 * What a member who just joined (or who just got a newer state) should show.
 * Returns { state, position, playing, needs } where state is the newest of
 * the two and needs says what this member must do before it can follow:
 * 'nothing', 'youtube' (load the player), 'file' (pick the same file, in
 * the best quality mode), 'stream' (receive the file someone streams) or
 * 'screen' (wait for the shared screen).
 */
function joinView(local, incoming, hostNow, { fileHash = null } = {}) {
  const state = isNewer(incoming, local) ? incoming : local;
  const src = state?.src;
  let needs = 'nothing';
  if (src?.kind === 'yt') needs = 'youtube';
  else if (src?.kind === 'file' && src.mode === 'local') needs = fileHash === src.hash ? 'nothing' : 'file';
  else if (src?.kind === 'file') needs = 'stream';
  else if (src?.kind === 'screen') needs = 'screen';
  else if (src?.kind === 'ext') needs = 'extension';
  return { state, position: positionAt(state, hostNow), playing: !!state?.playing, needs };
}

/**
 * Tells the room's own player events apart from the ones a person caused.
 * Before the app plays, pauses, seeks or changes the rate itself, it calls
 * expect(); the event that follows is then an echo and is not sent as an
 * intent. Anything else came from a person using the player controls.
 */
class EchoGuard {
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

// The protocol between the popcornpals app and the optional browser extension
// that keeps the video player of a streaming site in step with the room.
//
// The app tab owns the room (peer to peer, voice and chat). Through the
// extension it tells the player tab where the room is, in the clock both tabs
// share; the player tab moves its own video there and reports what the person
// did with the site's own controls. The extension only presses play, pause and
// seek and changes the speed of a player the person is already signed in to.
// It never captures, records, downloads or re-streams anything.
//
// Messages are plain objects: { pp: 1, type, ...fields }.
//   app -> player  'state'  { playing, pos, rate, at, seq, epoch } and 'room' { count, people, host }
//   player -> app  'status' { found, playing, pos, duration, seekable, site, title }
//                  'event'  { action: 'play' | 'pause' | 'seek' | 'rate', pos, rate }


const PROTOCOL = 1;
const TYPES = Object.freeze(['state', 'room', 'status', 'event', 'hello']);
const ACTIONS = new Set(['play', 'pause', 'seek', 'rate']);

const num = (v, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
const text = (v, max) => String(v ?? '').slice(0, max);

/** A message ready to send. */
function message(type, fields = {}) {
  return { pp: PROTOCOL, type, ...fields };
}

/** Validate a message that came from the other side. Returns a clean copy or null. */
function readMessage(m) {
  if (!m || typeof m !== 'object' || m.pp !== PROTOCOL || !TYPES.includes(m.type)) return null;
  switch (m.type) {
    case 'state': {
      const pos = num(m.pos, 0, 1e7);
      const rate = num(m.rate, 0.25, 2);
      const at = num(m.at, 0, 1e15);
      if (pos == null || rate == null || at == null) return null;
      return { pp: PROTOCOL, type: 'state', playing: !!m.playing, pos, rate, at, seq: Number.isInteger(m.seq) ? m.seq : 0, epoch: Number.isInteger(m.epoch) ? m.epoch : 0 };
    }
    case 'room':
      return {
        pp: PROTOCOL,
        type: 'room',
        count: Number.isInteger(m.count) ? Math.max(0, Math.min(5, m.count)) : 0,
        people: Array.isArray(m.people) ? m.people.slice(0, 5).map((p) => ({ name: text(p?.name, 24), synced: !!p?.synced })) : [],
        host: text(m.host, 24),
      };
    case 'status':
      return {
        pp: PROTOCOL,
        type: 'status',
        found: !!m.found,
        playing: !!m.playing,
        pos: num(m.pos, 0, 1e7) ?? 0,
        duration: num(m.duration, 0, 1e7),
        seekable: m.seekable !== false,
        site: text(m.site, 100),
        title: text(m.title, 200),
      };
    case 'event':
      if (!ACTIONS.has(m.action)) return null;
      return { pp: PROTOCOL, type: 'event', action: m.action, pos: num(m.pos, 0, 1e7), rate: num(m.rate, 0.25, 2) };
    case 'hello':
      return { pp: PROTOCOL, type: 'hello', version: text(m.version, 20) };
    default:
      return null;
  }
}

/**
 * The room state restated on the local clock for the player tab: where the
 * video is at local time localNow. Both tabs run in the same browser, so they
 * share Date.now() and no clock sync is needed between them.
 */
function stateForPlayer(roomState, hostNow, localNow) {
  return message('state', {
    playing: !!roomState?.playing,
    pos: positionAt(roomState, hostNow),
    rate: roomState?.rate || 1,
    at: localNow,
    seq: roomState?.seq || 0,
    epoch: roomState?.epoch || 0,
  });
}

/** Where the player should be at local time now. */
function expectedPosition(s, now) {
  if (!s) return 0;
  return s.playing ? s.pos + (Math.max(0, now - s.at) / 1000) * s.rate : s.pos;
}

/**
 * Pick the main video of a page: the largest visible one, a playing one first.
 * candidates: [{ width, height, visible, paused, duration }]. Returns an index or -1.
 */
function pickMainVideo(candidates) {
  let best = -1;
  let score = 0;
  candidates.forEach((v, i) => {
    if (!v || !v.visible) return;
    const area = Math.max(0, v.width) * Math.max(0, v.height);
    if (area < 120 * 70) return;
    const s = area * (v.paused ? 1 : 4) * (Number.isFinite(v.duration) && v.duration > 0 ? 2 : 1);
    if (s > score) {
      score = s;
      best = i;
    }
  });
  return best;
}

/** How far (s) a seek may land from where it was asked before it counts as refused. */
const SEEK_REFUSED = 2.5;

/**
 * Drives one page's video from the room. The video is anything with
 * currentTime, playbackRate, paused, duration, play() and pause().
 * send(msg) reports events and status to the app.
 */
class PlayerSync {
  constructor({ video, send, now = () => Date.now(), site = '', seekCheckMs = 1500 }) {
    this.video = video;
    this.send = send;
    this.now = now;
    this.site = site;
    this.state = null;
    this.seekable = true;
    // Presses this script made itself, waiting for their events: each one
    // produces exactly one 'play', 'pause', 'seeking' or 'ratechange' event.
    this.ours = { play: [], pause: [], seek: [], rate: [] };
    this.pendingSeek = null;
    this.refusals = 0;
    this.seekCheckMs = seekCheckMs;
  }

  /** A new room state arrived from the app. Older states (by epoch, then sequence) are ignored. */
  onState(s) {
    if (!s) return;
    const old = this.state;
    if (old && ((s.epoch ?? 0) < (old.epoch ?? 0) || ((s.epoch ?? 0) === (old.epoch ?? 0) && s.seq < old.seq))) return;
    // A new decision from the room replaces any seek still being checked.
    if (!old || s.seq !== old.seq || s.epoch !== old.epoch) this.pendingSeek = null;
    this.state = s;
    this.tick();
  }

  _mine(kind, to = null) {
    this.ours[kind].push({ at: this.now(), to, from: this.video?.currentTime });
  }

  /**
   * True (and consumed) when an event of this kind was caused by this script.
   * A seek is recognized by where it landed, so a late event on a busy page
   * is still matched. A press whose event never came (the player ignored it)
   * is forgotten after ten seconds.
   */
  _wasMine(kind, value) {
    const now = this.now();
    this.ours[kind] = this.ours[kind].filter((p) => now - p.at < 10000);
    // The player jumped back to where it was right before one of our seeks: it undid the seek.
    if (kind === 'seek' && this.ours.seek.some((p) => now - p.at < 3000 && Math.abs(p.from - value) < 0.75 && Math.abs(p.to - value) >= 1.5)) {
      this.ours.seek = [];
      this.pendingSeek = null;
      this._refuseSeek();
      return true;
    }
    const i = kind === 'seek' ? this.ours.seek.findIndex((p) => Math.abs(p.to - value) < 1.5) : this.ours[kind].length ? 0 : -1;
    if (i < 0) return false;
    this.ours[kind].splice(0, i + 1);
    return true;
  }

  /** Bring the video to the room. Returns what it did: 'none', 'play', 'pause', 'seek' or 'rate'. */
  tick() {
    const v = this.video;
    const s = this.state;
    if (!v || !s) return 'none';
    const now = this.now();
    this._checkSeek(now);
    const expected = expectedPosition(s, now);
    if (s.playing && v.paused) {
      if (this.seekable && Math.abs(v.currentTime - expected) > SYNC.PAUSED_TOL) this._seek(expected, now);
      this._mine('play');
      Promise.resolve(v.play?.()).catch(() => {});
      return 'play';
    }
    if (!s.playing && !v.paused) {
      this._mine('pause');
      v.pause();
      if (this.seekable && Math.abs(v.currentTime - expected) > SYNC.PAUSED_TOL) this._seek(expected, now);
      return 'pause';
    }
    if (Math.abs(v.playbackRate - s.rate) > 0.01) {
      this._mine('rate');
      v.playbackRate = s.rate;
      return 'rate';
    }
    if (!this.seekable || this.pendingSeek || v.seeking) return 'none';
    // Streaming players buffer from far away: correct by seeking only, with the wider margin.
    const c = correction({ expected, actual: v.currentTime, playing: s.playing, rate: s.rate, playerRate: v.playbackRate, kind: 'yt', buffering: v.readyState != null && v.readyState < 3 && !v.paused });
    if (c.action === 'seek') {
      this._seek(c.to, now);
      return 'seek';
    }
    return 'none';
  }

  _seek(to, now) {
    if (!Number.isFinite(to)) return;
    // Never past the end: the player would clamp it and the seek would look like someone else's.
    const end = this.video.duration;
    if (Number.isFinite(end) && end > 0) to = Math.min(to, Math.max(0, end - 0.25));
    this._mine('seek', to);
    this.pendingSeek = { to, at: now };
    try {
      this.video.currentTime = to;
    } catch {
      this._refuseSeek();
    }
  }

  /**
   * Some players ignore or undo a seek made from outside. A seek counts as
   * refused when, a moment later, the video is neither near the target nor
   * near where the room is. Two refusals in a row and the sync falls back to
   * play and pause only.
   */
  _checkSeek(now) {
    const p = this.pendingSeek;
    const v = this.video;
    if (!p || now - p.at < this.seekCheckMs || v.seeking) return;
    this.pendingSeek = null;
    const room = this.state ? expectedPosition(this.state, now) : p.to;
    const landed = Math.abs(v.currentTime - p.to) < SEEK_REFUSED || Math.abs(v.currentTime - room) < SEEK_REFUSED;
    if (landed) this.refusals = 0;
    else if (++this.refusals >= 2) this._refuseSeek();
  }

  _refuseSeek() {
    if (!this.seekable) return;
    this.seekable = false;
    this.send(this.status());
  }

  /** A video element event: 'play', 'pause', 'seeking' or 'ratechange'. Reports what a person did. */
  onVideoEvent(kind) {
    const v = this.video;
    const map = { play: 'play', pause: 'pause', seeking: 'seek', ratechange: 'rate' };
    const action = map[kind];
    if (!action || this._wasMine(action, v.currentTime) || !this.state) return null;
    if (action === 'play' && this.state.playing) return null;
    if (action === 'pause' && !this.state.playing) return null;
    if (action === 'seek') {
      if (!this.seekable) return null;
      if (Math.abs(v.currentTime - expectedPosition(this.state, this.now())) < 1.5) return null;
    }
    if (action === 'rate' && Math.abs(v.playbackRate - this.state.rate) < 0.01) return null;
    const msg = message('event', { action, pos: v.currentTime, rate: v.playbackRate });
    this.send(msg);
    return msg;
  }

  status() {
    const v = this.video;
    return message('status', {
      found: !!v,
      playing: v ? !v.paused : false,
      pos: v ? v.currentTime : 0,
      duration: v && Number.isFinite(v.duration) ? v.duration : null,
      seekable: this.seekable,
      site: this.site,
      title: '',
    });
  }
}

globalThis.PPSync = { PROTOCOL, PlayerSync, readMessage, message, pickMainVideo, expectedPosition };
})();
