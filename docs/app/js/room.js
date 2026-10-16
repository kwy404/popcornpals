// One watch party on this device: the mesh of links to the others, the room
// state (owned by the host, see core/sync.js), the clock offset to the host,
// chat, reactions, statuses and the pairing confirmation for new guests.

import { Emitter } from '../core/emitter.js';
import { Mesh } from '../core/mesh.js';
import { RtcLink } from '../core/rtc.js';
import { ClockSync, applyIntent, initialState, isNewer, positionAt, takeOver } from '../core/sync.js';
import { randomId, sdpFingerprints } from '../core/crypto.js';
import { confirmWords } from '../core/words.js';
import { REACTIONS, RateLimit, addMessage, cleanMessage, toggleReaction } from '../core/chat.js';
import { cleanName } from '../core/people.js';
import { cleanCues } from '../core/subtitles.js';

const STATUSES = new Set(['idle', 'watching', 'paused', 'buffering', 'loading', 'needs-file', 'mismatch', 'blocked', 'sharing', 'screen', 'streaming', 'ext-missing']);
const SUB_CHUNK = 250;
const HISTORY_SENT = 60;

export class Room extends Emitter {
  /**
   * @param {object} o
   * @param {{id: string, name: string}} o.self
   * @param {string} o.roomId
   * @param {boolean} o.host true for the person who starts the room
   * @param {() => RTCIceServer[]} o.iceServers
   */
  constructor({ self, roomId, host, iceServers }) {
    super();
    this.self = { id: self.id, name: cleanName(self.name) };
    this.mesh = new Mesh({
      self: this.self,
      room: { id: roomId, name: '' },
      transport: { createLink: () => new RtcLink({ iceServers: iceServers() }) },
      host,
    });
    this.state = host ? initialState({ host: this.self.id, now: Date.now() }) : null;
    this.clock = new ClockSync();
    this.statuses = new Map();
    this.chat = [];
    this.pairing = new Map();
    this.introducer = null;
    this.limits = new RateLimit({ max: 10, windowMs: 5000 });
    this.bursts = new RateLimit({ max: 8, windowMs: 3000 });
    this.timers = [];
    this.closed = false;

    const m = this.mesh;
    m.on('members', () => this.emit('members'));
    m.on('message', ({ from, body }) => this._receive(from, body));
    m.on('link-open', ({ peerId, link }) => this._onLinkOpen(peerId, link));
    m.on('link-close', ({ peerId }) => {
      this.statuses.delete(peerId);
      this.emit('link-close', peerId);
      this.emit('members');
    });
    m.on('link-failed', (info) => {
      if (info.reason !== 'closed') this.emit('link-failed', { ...info, diagnosis: info.link?.diagnose?.(navigator.onLine) || 'strict-nat' });
    });
    m.on('relay', (id) => this._onHostChange(id));
    m.on('welcome', () => this.emit('welcome'));
    m.on('held', ({ peerId }) => this.emit('held', peerId));
    m.on('held-close', ({ peerId }) => this.emit('held-close', peerId));
    m.on('full', (f) => this.emit('full', f));
    m.on('refused', (r) => this.emit('refused-pairing', r));
    m.on('rejected', (r) => this.emit('rejected', r));
    m.on('error', (err) => console.warn('popcornpals mesh:', err));

    this._every(1000, () => this._ping());
  }

  get hostId() {
    return this.mesh.relay;
  }

  get isHost() {
    return !!this.hostId && this.hostId === this.self.id;
  }

  get hostName() {
    const m = this.mesh.members.get(this.hostId);
    return m?.name || '';
  }

  /** The host clock now (ms). */
  hostNow() {
    return this.isHost ? Date.now() : this.clock.hostNow(Date.now());
  }

  /** Where the room is right now, in seconds. */
  expected() {
    return this.state ? positionAt(this.state, this.hostNow()) : 0;
  }

  /** May I press play, pause or seek right now? */
  get canControl() {
    return !this.state?.lock || this.isHost;
  }

  members() {
    return this.mesh.memberList();
  }

  onlineCount() {
    return this.mesh.onlineCount();
  }

  // Intents

  /** Ask the host for a change. The host applies its own intents at once. */
  intent(action, fields = {}) {
    const intent = { id: randomId(6), by: this.self.id, action, base: this.state?.seq ?? 0, t: this.hostNow(), ...fields };
    if (this.isHost) return this._apply(intent);
    if (!this.hostId) return 'offline';
    this.mesh.sendTo(this.hostId, { type: 'intent', intent });
    return 'sent';
  }

  _apply(intent) {
    if (!this.state) return 'invalid';
    const { state, result } = applyIntent(this.state, intent, { now: Date.now(), host: this.self.id });
    if (result === 'applied') {
      this.state = state;
      this.mesh.broadcast({ type: 'state', state });
      this.emit('state', { by: intent.by, action: intent.action });
    } else if (intent.by !== this.self.id && (result === 'locked' || result === 'conflict')) {
      this.mesh.sendTo(intent.by, { type: 'refused', action: intent.action, result });
    } else if (intent.by === this.self.id && result === 'locked') {
      this.emit('refused', { action: intent.action, result });
    }
    return result;
  }

  _onHostChange(id) {
    // The old host's clock, read with the offset learned so far, before it is forgotten.
    const oldHostNow = this.clock.hostNow(Date.now());
    this.clock.reset();
    if (id === this.self.id && this.state && this.state.host !== this.self.id) {
      // The host left and this device joined first among the rest: carry on from where the room was.
      this.state = takeOver(this.state, { host: this.self.id, now: Date.now(), oldHostNow });
      this.mesh.broadcast({ type: 'state', state: this.state });
      this.emit('state', { by: this.self.id, action: 'takeover' });
    }
    this.emit('host', id);
    this.emit('members');
  }

  // Clock

  _ping() {
    if (this.closed || this.isHost || !this.hostId || !this.mesh.links.has(this.hostId)) return;
    this._pings = (this._pings || 0) + 1;
    // Fast at first to learn the offset, then every few seconds to follow it.
    if (this.clock.samples.length >= 6 && this._pings % 3) return;
    this.mesh.sendTo(this.hostId, { type: 'ping', t0: Date.now() });
  }

  // Chat and reactions

  /** Send a message. re: the id of the message it replies to; vt: the video time now. */
  sendChat(text, { re = null, vt = null } = {}) {
    const msg = { id: randomId(6), text, ts: Date.now() };
    if (re) msg.re = re;
    if (Number.isFinite(vt)) msg.vt = vt;
    const rec = cleanMessage(msg, this.self.id);
    if (!rec) return null;
    addMessage(this.chat, rec);
    this.mesh.broadcast({ type: 'chat', msg });
    this.emit('chat', rec);
    return rec;
  }

  react(messageId, reaction) {
    const m = this.chat.find((x) => x.id === messageId);
    if (!m || !REACTIONS.includes(reaction)) return;
    const on = !(m.reactions[reaction] || []).includes(this.self.id);
    toggleReaction(m, reaction, this.self.id, on);
    this.mesh.broadcast({ type: 'react', id: messageId, r: reaction, on });
    this.emit('chat', m);
  }

  burst(reaction) {
    if (!REACTIONS.includes(reaction) || !this.bursts.allow(this.self.id)) return false;
    this.mesh.broadcast({ type: 'burst', r: reaction });
    this.emit('burst', { from: this.self.id, r: reaction });
    return true;
  }

  /** Send subtitles to everyone, or to one person who just joined. */
  sendSubs(subs, to = null) {
    const total = Math.max(1, Math.ceil(subs.cues.length / SUB_CHUNK));
    for (let part = 0; part < total; part++) {
      const body = { type: 'subs', key: subs.key, name: subs.name, part, total, cues: subs.cues.slice(part * SUB_CHUNK, (part + 1) * SUB_CHUNK) };
      if (to) this.mesh.sendTo(to, body);
      else this.mesh.broadcast(body);
    }
  }

  sendStatus(status) {
    this.mesh.broadcast({ type: 'status', ...status });
  }

  // Pairing confirmation (the inviter's side keeps a new guest held until the words match)

  expectPairing(peerId, nonce) {
    this.pairing.set(peerId, { nonce, attempts: 0 });
  }

  _linkOf(peerId) {
    return this.mesh.links.get(peerId) || this.mesh.held.get(peerId) || null;
  }

  /** The six confirmation words of the connection with a peer: the same on both screens. */
  confirmationWords(peerId, nonce) {
    const link = this._linkOf(peerId);
    const local = sdpFingerprints(link?.pc?.localDescription?.sdp).join(',');
    const remote = sdpFingerprints(link?.pc?.remoteDescription?.sdp).join(',');
    if (!local || !remote || !nonce) return null;
    return confirmWords(local, remote, nonce);
  }

  /** The inviter typed the words the guest sees. Returns 'ok', 'refused' or { left }. */
  confirmHeld(peerId, typed) {
    const p = this.pairing.get(peerId);
    if (!p) return 'refused';
    const expected = this.confirmationWords(peerId, p.nonce);
    if (expected && expected.join(' ') === typed.join(' ')) {
      this.pairing.delete(peerId);
      this.mesh.sendTo(peerId, { type: 'pair', ok: true });
      setTimeout(() => this.mesh.release(peerId), 50);
      return 'ok';
    }
    p.attempts++;
    if (p.attempts >= 3) {
      this.pairing.delete(peerId);
      this.mesh.sendTo(peerId, { type: 'pair', ok: false });
      setTimeout(() => this.mesh.refuse(peerId, 'words'), 50);
      return 'refused';
    }
    return { left: 3 - p.attempts };
  }

  // Links

  _onLinkOpen(peerId, link) {
    link.polite = this.self.id > peerId;
    link.ontrack = (t) => this.emit('track', { peerId, ...t });
    link.onmedia = (media) => this.emit('media', { peerId, media });
    link.onstate = (state) => String(state).startsWith('negotiation error') && console.warn('popcornpals link:', state);
    if (this.isHost && this.state) {
      this.mesh.sendTo(peerId, { type: 'state', state: this.state });
      this.mesh.sendTo(peerId, { type: 'history', msgs: this.chat.slice(-HISTORY_SENT).map((m) => ({ id: m.id, from: m.from, text: m.text, ts: m.ts, re: m.re, vt: m.vt, reactions: m.reactions })) });
    }
    this.emit('link-open', { peerId, link });
  }

  // Receiving

  _receive(from, body) {
    if (!body || typeof body.type !== 'string') return;
    switch (body.type) {
      case 'state': {
        const s = body.state;
        if (!s || s.host !== from || !Array.isArray(s.queue)) return;
        if (!isNewer(s, this.state) && this.state?.host === s.host) return;
        if (this.state && s.epoch < this.state.epoch) return;
        this.state = s;
        this.emit('state', { by: s.by, action: s.lastAction });
        return;
      }
      case 'intent':
        if (this.isHost && body.intent && typeof body.intent === 'object') this._apply({ ...body.intent, by: from });
        return;
      case 'ping':
        if (this.isHost && Number.isFinite(body.t0)) this.mesh.sendTo(from, { type: 'pong', t0: body.t0, h: Date.now() });
        return;
      case 'pong':
        if (from === this.hostId) {
          this.clock.add({ t0: body.t0, t1: Date.now(), h: body.h });
        }
        return;
      case 'refused':
        this.emit('refused', { action: String(body.action || ''), result: String(body.result || '') });
        return;
      case 'status': {
        const st = {
          status: STATUSES.has(body.status) ? body.status : 'idle',
          drift: Number.isFinite(body.drift) ? Math.max(-99, Math.min(99, body.drift)) : null,
          mic: !!body.mic,
          muted: !!body.muted,
          level: Number.isFinite(body.level) ? Math.max(0, Math.min(1, body.level)) : 0,
          quality: typeof body.quality === 'string' ? body.quality.slice(0, 60) : '',
        };
        this.statuses.set(from, st);
        this.emit('members');
        return;
      }
      case 'chat': {
        if (!this.limits.allow(from)) return;
        const rec = cleanMessage(body.msg, from);
        if (rec && addMessage(this.chat, rec)) this.emit('chat', rec);
        return;
      }
      case 'history': {
        let changed = false;
        for (const m of Array.isArray(body.msgs) ? body.msgs.slice(-HISTORY_SENT) : []) {
          const rec = cleanMessage(m, typeof m?.from === 'string' ? m.from.slice(0, 64) : from);
          if (!rec) continue;
          for (const r of REACTIONS) for (const who of Array.isArray(m.reactions?.[r]) ? m.reactions[r].slice(0, 5) : []) toggleReaction(rec, r, String(who), true);
          changed = addMessage(this.chat, rec) || changed;
        }
        if (changed) this.emit('chat', null);
        return;
      }
      case 'react': {
        const m = this.chat.find((x) => x.id === body.id);
        if (m && toggleReaction(m, body.r, from, !!body.on)) this.emit('chat', m);
        return;
      }
      case 'burst':
        if (REACTIONS.includes(body.r) && this.bursts.allow(from)) this.emit('burst', { from, r: body.r });
        return;
      case 'pair':
        this.emit('pair', { from, ok: !!body.ok });
        return;
      case 'subs': {
        // Subtitles arrive in parts; keep them until the last part is in.
        if (typeof body.key !== 'string' || !Number.isInteger(body.part) || !Number.isInteger(body.total) || body.total < 1 || body.total > 40) return;
        const id = `${from}|${body.key}|${body.name}`;
        this._subParts ??= new Map();
        const got = this._subParts.get(id) || { parts: [], n: 0 };
        if (!got.parts[body.part]) got.n++;
        got.parts[body.part] = cleanCues(body.cues);
        this._subParts.set(id, got);
        if (got.n === body.total) {
          this._subParts.delete(id);
          this.emit('subs', { key: body.key, name: String(body.name || '').slice(0, 120), cues: got.parts.flat(), owner: from });
        }
        return;
      }
      default:
    }
  }

  _every(ms, fn) {
    const t = setInterval(fn, ms);
    this.timers.push(t);
  }

  leave() {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    this.mesh.leave();
    this.emit('closed');
  }
}
