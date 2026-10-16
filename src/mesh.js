// The mesh introduction protocol.
//
// A room is a full mesh of up to MAX_MEMBERS peers (5), built without a signaling server:
// 1. A member makes an invite (a WebRTC offer). The guest answers it. The
//    offer and the answer travel through the six word handshake
//    (pairing.js), and that single round trip opens a link inviter <-> guest.
// 2. The introducer (whoever made the invite) welcomes the newcomer with the
//    member list and tells the others who joined.
// 3. The newcomer offers a link to every online member. Offers and answers
//    travel over the data channels that already exist, through the
//    introducer or the relay, so nobody pastes more codes.
// 4. The relay is the online member who joined first. It forwards broadcasts
//    to members who could not open a direct link to the sender. When the
//    relay leaves, every peer elects the next one with the same rule.
//
// The protocol only needs links with offer(), answer(), complete(), send()
// and close(), so tests run it over an in-memory transport.

import { randomId } from './crypto.js';
import { Emitter } from './emitter.js';

export { Emitter };

/** The most people online in one room, the host included. Change it here only. */
export const MAX_MEMBERS = 5;
/** App message types a held link may exchange before it is let in (the pairing confirmation). */
export const HELD_TYPES = new Set(['pair']);
export const INTRO_TIMEOUT = 30000;

/** The online member who joined first, by joinedAt then id. */
export function electRelay(members) {
  let best = null;
  for (const m of members) {
    if (!m.online || m.joinedAt == null) continue;
    if (!best || m.joinedAt < best.joinedAt || (m.joinedAt === best.joinedAt && m.id < best.id)) best = m;
  }
  return best ? best.id : null;
}

/** Peers the relay should forward a broadcast to: linked to the relay but not to the origin. */
export function forwardTargets({ origin, via, linked, originLinks }) {
  const out = [];
  for (const id of linked) {
    if (id === origin || id === via) continue;
    if (originLinks && originLinks.has(id)) continue;
    out.push(id);
  }
  return out;
}

export class MeshError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'MeshError';
    this.reason = reason;
  }
}

const publicMember = (m) => ({ id: m.id, name: m.name, avatar: m.avatar, status: m.status || '', accent: m.accent || '', joinedAt: m.joinedAt, online: !!m.online });

/** Avatars are a seed or a small data:image URL; anything else is dropped. */
export function cleanAvatar(v) {
  const s = String(v || '');
  if (s.startsWith('data:')) return /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s) && s.length <= 40000 ? s : '';
  return s.slice(0, 64);
}

/** Optional profile extras: a short status line and an accent color. */
export function cleanExtras(p) {
  return { status: String(p?.status || '').slice(0, 128), accent: /^#[0-9a-f]{6}$/i.test(p?.accent || '') ? p.accent : '' };
}

export class Mesh extends Emitter {
  /**
   * @param {object} options
   * @param {{id: string, name: string, avatar?: string}} options.self
   * @param {{id: string, name: string, locked?: boolean}} options.room
   * @param {{createLink: () => object}} options.transport
   * @param {boolean} [options.host] true when this peer starts the room (or restarts it alone)
   * @param {number} [options.max]
   * @param {() => number} [options.now]
   */
  constructor({ self, room, transport, host = false, max = MAX_MEMBERS, now = () => Date.now(), introTimeout = INTRO_TIMEOUT }) {
    super();
    this.now = now;
    this.max = max;
    this.introTimeout = introTimeout;
    this.transport = transport;
    this.room = { ...room };
    this.self = { id: self.id, name: self.name, avatar: cleanAvatar(self.avatar), ...cleanExtras(self), joinedAt: host ? now() : null, online: true };
    this.members = new Map([[this.self.id, this.self]]);
    this.links = new Map();
    this.peerLinks = new Map();
    this.pending = new Map();
    this.answeredInvites = new Map();
    this.answeredSids = new Set();
    this.held = new Map();
    this.outgoing = new Map();
    this.timers = new Set();
    this.relay = host ? this.self.id : null;
    this.introducer = null;
    this.seen = new Map();
    this.closed = false;
  }

  get isRelay() {
    return this.relay === this.self.id;
  }

  /**
   * The relay hands its role to another online member it is linked to. The
   * member moves first in the joining order on every device, so the same
   * election rule keeps choosing it, also after someone leaves. Returns false
   * when this device is not the relay or the member is not reachable.
   */
  handover(id) {
    if (this.closed || !this.isRelay || id === this.self.id || !this.links.has(id) || !this.members.get(id)?.online) return false;
    const first = Math.min(...[...this.members.values()].map((m) => m.joinedAt).filter(Number.isFinite));
    const joinedAt = first - 1;
    for (const link of this.links.values()) this._send(link, { t: 'handover', id, joinedAt });
    this._applyHandover(id, joinedAt);
    return true;
  }

  _applyHandover(id, joinedAt) {
    const m = this.members.get(id);
    if (!m || !Number.isFinite(joinedAt)) return;
    m.joinedAt = joinedAt;
    this._elect();
    this.emit('members', this.memberList());
  }

  /** Members as plain objects, sorted by join time. */
  memberList() {
    return [...this.members.values()].map(publicMember).sort((a, b) => (a.joinedAt ?? Infinity) - (b.joinedAt ?? Infinity) || (a.id < b.id ? -1 : 1));
  }

  onlineCount() {
    let n = 0;
    for (const m of this.members.values()) if (m.online) n++;
    return n;
  }

  /** Merge known members, for example from local history. Never marks anyone online. */
  addKnownMembers(list) {
    for (const m of list || []) {
      if (!m?.id || m.id === this.self.id) continue;
      const have = this.members.get(m.id);
      if (have) {
        have.name ||= m.name;
        have.avatar ||= m.avatar;
      } else {
        this.members.set(m.id, { id: m.id, name: String(m.name || 'member'), avatar: m.avatar || '', joinedAt: m.joinedAt ?? null, online: false });
      }
    }
    this.emit('members', this.memberList());
  }

  // Invites (manual signaling)

  /** Whether the room has no room for one more person right now. */
  get full() {
    return this.onlineCount() >= this.max;
  }

  /**
   * Create a link for a new invite. Returns { inviteId, sdp, full } to pack
   * into the invite code. An invite made while the room is full still works if
   * someone leaves before the guest connects; full tells the UI to say so.
   */
  async createInvite() {
    if (this.closed) throw new MeshError('closed', 'This room was closed.');
    const inviteId = randomId(6);
    const link = this._newLink();
    link.introduce = true;
    this.pending.set(inviteId, { link, createdAt: this.now() });
    const sdp = await link.offer();
    return { inviteId, sdp, full: this.full };
  }

  /** Cancel a pending invite. */
  cancelInvite(inviteId) {
    const p = this.pending.get(inviteId);
    if (!p) return;
    this.pending.delete(inviteId);
    p.link.close();
  }

  /** Host side: apply a reply code. */
  async acceptReply(reply, { hold = false } = {}) {
    const p = this.pending.get(reply.inviteId);
    // The same reply twice (pasted again, or delivered by another tab or relay) is not an error.
    if (!p && this.answeredInvites.has(reply.inviteId)) throw new MeshError('answered', 'This reply was already used.');
    if (!p) throw new MeshError('expired', 'This reply belongs to an invite that is no longer open. Make a new invite.');
    if (reply.roomId && reply.roomId !== this.room.id) throw new MeshError('room', 'This reply is for a different room.');
    if (reply.peer.id === this.self.id) throw new MeshError('self', 'This is your own reply code.');
    if (this.links.has(reply.peer.id)) throw new MeshError('already', `${reply.peer.name} is already connected.`);
    // When the room is full the link still opens, only to tell the guest why
    // they cannot join (see _onOpen); then it closes.
    this.pending.delete(reply.inviteId);
    this.answeredInvites.set(reply.inviteId, reply.peer.id);
    p.link.peerId = reply.peer.id;
    p.link.peer = reply.peer;
    p.link.hold = hold;
    await p.link.complete(reply.sdp);
    return p.link;
  }

  /** Guest side: answer an invite. Returns the reply fields to pack into the reply code. */
  async acceptInvite(invite) {
    if (invite.host.id === this.self.id) throw new MeshError('self', 'This is your own invite. Send it to someone else.');
    const link = this._newLink();
    link.peerId = invite.host.id;
    link.peer = invite.host;
    this.introducer = invite.host.id;
    const sdp = await link.answer(invite.sdp);
    return { inviteId: invite.inviteId, roomId: this.room.id, peer: { id: this.self.id, name: this.self.name, avatar: this.self.avatar }, sdp };
  }

  // Messaging

  /** Send an app payload to everyone. Returns the envelope id. */
  broadcast(body) {
    const env = { t: 'm', id: randomId(8), from: this.self.id, body };
    this._remember(env.id);
    for (const link of this.links.values()) this._send(link, env);
    return env.id;
  }

  /** Send an app payload to one peer, through the relay when there is no direct link. */
  sendTo(peerId, body) {
    const env = { t: 'm', id: randomId(8), from: this.self.id, to: peerId, body };
    this._remember(env.id);
    const direct = this.links.get(peerId) || this.held.get(peerId);
    if (direct) return this._send(direct, env);
    const relay = this.links.get(this.relay);
    if (relay) return this._send(relay, env);
    let sent = false;
    for (const link of this.links.values()) sent = this._send(link, env) || sent;
    return sent;
  }

  /** Update my name, avatar, status or accent and tell everyone. */
  setProfile({ name, avatar, status, accent }) {
    if (name) this.self.name = name;
    if (avatar) this.self.avatar = cleanAvatar(avatar);
    Object.assign(this.self, cleanExtras({ status: status ?? this.self.status, accent: accent ?? this.self.accent }));
    for (const link of this.links.values()) this._send(link, { t: 'profile', peer: publicMember(this.self) });
    this.emit('members', this.memberList());
  }

  /** Take over a link that was opened outside this mesh. This peer acts as the introducer of the other side. */
  adopt(link, peer, { hold = false } = {}) {
    link.peerId = peer.id;
    link.peer = peer;
    link.introduce = true;
    link.hold = hold;
    link.onopen = () => this._onOpen(link);
    link.onmessage = (data) => this._onRaw(link, data);
    link.onclose = () => this._onClose(link);
    link.onfail = (reason) => this.emit('link-failed', { peerId: link.peerId, reason, link });
    if (link.open) this._onOpen(link);
  }

  /**
   * Let a held link in: a guest who joined with six words waits here until the
   * inviter confirms the six confirmation words.
   */
  release(peerId) {
    const link = this.held.get(peerId);
    if (!link) return false;
    this.held.delete(peerId);
    link.hold = false;
    const queue = link.queue || [];
    link.queue = [];
    this._onOpen(link);
    for (const data of queue) this._onRaw(link, data);
    return true;
  }

  /** Turn a held link away with a reason the guest's app can show. */
  refuse(peerId, reason = 'refused') {
    const link = this.held.get(peerId);
    if (!link) return false;
    this.held.delete(peerId);
    this._send(link, { t: 'refused', reason });
    setTimeout(() => link.close(), 200);
    return true;
  }

  /** Leave the room: say goodbye and close every link. */
  leave() {
    if (this.closed) return;
    for (const link of this.links.values()) this._send(link, { t: 'bye' });
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const { link } of this.pending.values()) link.close();
    for (const link of this.held.values()) link.close();
    this.held.clear();
    for (const link of this.outgoing.values()) link.close();
    for (const link of [...this.links.values()]) link.close();
    this.pending.clear();
    this.outgoing.clear();
    this.links.clear();
  }

  // Internals

  _newLink() {
    const link = this.transport.createLink();
    link.onopen = () => this._onOpen(link);
    link.onmessage = (data) => this._onRaw(link, data);
    link.onclose = () => this._onClose(link);
    link.onfail = (reason) => this.emit('link-failed', { peerId: link.peerId, reason, link });
    return link;
  }

  _send(link, msg) {
    try {
      link.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  _remember(id) {
    this.seen.set(id, true);
    if (this.seen.size > 5000) this.seen.delete(this.seen.keys().next().value);
  }

  _announceLinks() {
    const ids = [...this.links.keys()];
    for (const link of this.links.values()) this._send(link, { t: 'links', ids });
  }

  _onOpen(link) {
    if (this.closed) return link.close();
    const id = link.peerId;
    if (!id) return;
    const prior = this.links.get(id);
    if (prior && prior !== link) prior.close();
    this.links.set(id, link);
    if (link.introduce) {
      if (this.onlineCount() >= this.max && !this.members.get(id)?.online) {
        const count = this.onlineCount();
        this._send(link, { t: 'full', max: this.max, count });
        this.links.delete(id);
        this.emit('rejected', { peer: { id, name: link.peer?.name || 'guest' }, max: this.max, count });
        setTimeout(() => link.close(), 200);
        return;
      }
      if (link.hold) {
        this.links.delete(id);
        link.queue = [];
        this.held.set(id, link);
        this.emit('held', { peerId: id, link, peer: link.peer });
        return;
      }
      const have = this.members.get(id);
      const member = { id, name: link.peer?.name || have?.name || 'member', avatar: link.peer?.avatar || have?.avatar || '', joinedAt: this.now(), online: true };
      this.members.set(id, member);
      this._send(link, { t: 'welcome', room: this.room, relay: this.relay, members: this.memberList(), you: { joinedAt: member.joinedAt } });
      for (const [other, l] of this.links) if (other !== id) this._send(l, { t: 'joined', peer: publicMember(member) });
    } else {
      const m = this.members.get(id);
      if (m) m.online = true;
      else if (link.peer) this.members.set(id, { ...link.peer, joinedAt: null, online: true });
    }
    this._send(link, { t: 'hello', peer: publicMember(this.self), relay: this.relay, links: [...this.links.keys()] });
    this._announceLinks();
    this.emit('link-open', { peerId: id, link });
    this.emit('members', this.memberList());
  }

  _onClose(link) {
    const id = link.peerId;
    if (id && this.held.get(id) === link) {
      this.held.delete(id);
      this.emit('held-close', { peerId: id });
      return;
    }
    for (const [sid, l] of this.outgoing) if (l === link) this.outgoing.delete(sid);
    if (!id || this.links.get(id) !== link) return;
    this.links.delete(id);
    this.peerLinks.delete(id);
    if (this.closed) return;
    const m = this.members.get(id);
    if (m) m.online = false;
    this.emit('link-close', { peerId: id });
    this._announceLinks();
    if (id === this.relay || !this.members.get(this.relay)?.online) this._elect();
    this.emit('members', this.memberList());
  }

  _elect() {
    const next = electRelay(this.members.values());
    if (next === this.relay) return;
    this.relay = next;
    if (next === this.self.id) for (const link of this.links.values()) this._send(link, { t: 'relay', id: next });
    this.emit('relay', next);
  }

  async _onRaw(link, data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;
    const from = link.peerId;
    if (from && link.hold && this.held.get(from) === link) {
      if (msg.t === 'm' && msg.to === this.self.id && msg.from === from && HELD_TYPES.has(msg.body?.type)) {
        this.emit('message', { from, body: msg.body, id: msg.id, via: from, direct: true, held: true });
      } else if (link.queue.length < 200) {
        link.queue.push(data);
      }
      return;
    }
    // Only links that made it into the mesh may talk (a refused guest may not).
    if (!from || this.links.get(from) !== link) return;
    try {
      await this._handle(link, from, msg);
    } catch (err) {
      this.emit('error', err);
    }
  }

  async _handle(link, from, msg) {
    switch (msg.t) {
      case 'hello': {
        const p = msg.peer || {};
        if (p.id !== from) return;
        const m = this.members.get(from) || { id: from, joinedAt: null };
        m.name = String(p.name || m.name || 'member').slice(0, 32);
        m.avatar = cleanAvatar(p.avatar || m.avatar);
        Object.assign(m, cleanExtras(p));
        if (m.joinedAt == null && typeof p.joinedAt === 'number') m.joinedAt = p.joinedAt;
        m.online = true;
        this.members.set(from, m);
        this.peerLinks.set(from, new Set(msg.links || []));
        if (!this.relay && msg.relay) this.relay = msg.relay;
        this.emit('members', this.memberList());
        return;
      }
      case 'welcome': {
        if (from !== this.introducer) return;
        this.room = { ...this.room, ...msg.room, id: this.room.id };
        this.self.joinedAt = msg.you?.joinedAt ?? this.now();
        const expected = [];
        for (const m of msg.members || []) {
          if (!m?.id || m.id === this.self.id) continue;
          const linked = this.links.has(m.id);
          const have = this.members.get(m.id);
          this.members.set(m.id, { ...have, id: m.id, name: String(m.name || 'member').slice(0, 32), avatar: cleanAvatar(m.avatar), ...cleanExtras(m), joinedAt: m.joinedAt ?? null, online: linked });
          if (m.online && !linked) expected.push(m.id);
        }
        this.relay = msg.relay || from;
        this.emit('welcome', { room: this.room, members: this.memberList(), expected });
        this.emit('members', this.memberList());
        await Promise.all(expected.map((id) => this._introduce(id)));
        return;
      }
      case 'joined': {
        const p = msg.peer;
        if (!p?.id || p.id === this.self.id) return;
        const have = this.members.get(p.id);
        this.members.set(p.id, { ...have, id: p.id, name: String(p.name || 'member').slice(0, 32), avatar: cleanAvatar(p.avatar), ...cleanExtras(p), joinedAt: p.joinedAt ?? null, online: this.links.has(p.id) });
        this.emit('joined', publicMember(this.members.get(p.id)));
        this.emit('members', this.memberList());
        return;
      }
      case 'links':
        this.peerLinks.set(from, new Set(msg.ids || []));
        return;
      case 'handover':
        // Only the relay may hand its role over.
        if (from === this.relay && typeof msg.id === 'string' && this.members.has(msg.id)) this._applyHandover(msg.id, Number(msg.joinedAt));
        return;
      case 'relay':
        if ((this.members.get(msg.id)?.online || msg.id === from) && this.relay !== msg.id) {
          this.relay = msg.id;
          this.emit('relay', msg.id);
        }
        return;
      case 'profile': {
        const p = msg.peer;
        const m = this.members.get(from);
        if (!m || p?.id !== from) return;
        m.name = String(p.name || m.name).slice(0, 32);
        m.avatar = cleanAvatar(p.avatar || m.avatar);
        Object.assign(m, cleanExtras(p));
        this.emit('members', this.memberList());
        return;
      }
      case 'bye': {
        this.emit('bye', { peerId: from });
        const m = this.members.get(from);
        if (m) m.online = false;
        link.close();
        return;
      }
      case 'refused':
        if (from !== this.introducer) return;
        this.emit('refused', { reason: String(msg.reason || 'refused').slice(0, 40) });
        return;
      case 'full':
        if (from !== this.introducer) return;
        this.emit('full', { max: Number(msg.max) || this.max, count: Number(msg.count) || Number(msg.max) || this.max });
        return;
      case 'signal':
        return this._onSignal(link, msg);
      case 'm':
        return this._onEnvelope(msg, from);
      default:
    }
  }

  async _introduce(targetId) {
    const sid = randomId(6);
    const link = this._newLink();
    link.peerId = targetId;
    link.peer = this.members.get(targetId);
    this.outgoing.set(sid, link);
    const sdp = await link.offer();
    if (this.closed) return link.close();
    this._routeSignal({ t: 'signal', to: targetId, from: this.self.id, sid, kind: 'offer', sdp });
    this._watch(link, targetId);
  }

  _watch(link, targetId) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.links.get(targetId) === link || this.closed) return;
      this.emit('link-failed', { peerId: targetId, reason: 'timeout', link });
    }, this.introTimeout);
    this.timers.add(timer);
  }

  _routeSignal(msg, prefer) {
    const route = [this.links.get(msg.to), prefer, this.links.get(this.relay), this.links.get(this.introducer), ...this.links.values()].find(Boolean);
    if (route) this._send(route, msg);
    return !!route;
  }

  async _onSignal(arrival, msg) {
    if (msg.to !== this.self.id) {
      const target = this.links.get(msg.to);
      if (target) this._send(target, msg);
      return;
    }
    if (msg.kind === 'offer') {
      if (this.links.has(msg.from) || this.answeredSids.has(msg.sid)) return;
      this.answeredSids.add(msg.sid);
      if (!this.members.has(msg.from)) this.members.set(msg.from, { id: msg.from, name: 'member', avatar: '', joinedAt: null, online: false });
      const link = this._newLink();
      link.peerId = msg.from;
      link.peer = this.members.get(msg.from);
      const sdp = await link.answer(msg.sdp);
      if (this.closed) return link.close();
      this._routeSignal({ t: 'signal', to: msg.from, from: this.self.id, sid: msg.sid, kind: 'answer', sdp }, arrival);
      this._watch(link, msg.from);
    } else if (msg.kind === 'answer') {
      const link = this.outgoing.get(msg.sid);
      if (!link || link.peerId !== msg.from) return;
      this.outgoing.delete(msg.sid);
      await link.complete(msg.sdp);
    }
  }

  _onEnvelope(env, via) {
    if (!env.id || this.seen.has(env.id)) return;
    this._remember(env.id);
    if (env.to && env.to !== this.self.id) {
      const target = this.links.get(env.to);
      if (target) this._send(target, env);
      return;
    }
    if (!env.to && this.isRelay) {
      const targets = forwardTargets({ origin: env.from, via, linked: this.links.keys(), originLinks: this.peerLinks.get(env.from) });
      for (const id of targets) this._send(this.links.get(id), env);
    }
    this.emit('message', { from: env.from, body: env.body, id: env.id, via, direct: via === env.from });
  }
}
