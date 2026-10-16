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

import { SYNC, correction, positionAt } from './sync.js';

export const PROTOCOL = 1;
export const TYPES = Object.freeze(['state', 'room', 'status', 'event', 'hello']);
const ACTIONS = new Set(['play', 'pause', 'seek', 'rate']);

const num = (v, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
const text = (v, max) => String(v ?? '').slice(0, max);

/** A message ready to send. */
export function message(type, fields = {}) {
  return { pp: PROTOCOL, type, ...fields };
}

/** Validate a message that came from the other side. Returns a clean copy or null. */
export function readMessage(m) {
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
export function stateForPlayer(roomState, hostNow, localNow) {
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
export function expectedPosition(s, now) {
  if (!s) return 0;
  return s.playing ? s.pos + (Math.max(0, now - s.at) / 1000) * s.rate : s.pos;
}

/**
 * Pick the main video of a page: the largest visible one, a playing one first.
 * candidates: [{ width, height, visible, paused, duration }]. Returns an index or -1.
 */
export function pickMainVideo(candidates) {
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
export const SEEK_REFUSED = 2.5;

/**
 * Drives one page's video from the room. The video is anything with
 * currentTime, playbackRate, paused, duration, play() and pause().
 * send(msg) reports events and status to the app.
 */
export class PlayerSync {
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
