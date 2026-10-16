// Copied from src/ by scripts/sync-core.mjs. Edit the file in src/ instead.
// WebRTC links for the mesh. One RTCPeerConnection per pair of peers, with
// two pre-negotiated data channels (room messages and media negotiation) and
// optional audio and video tracks (voice and screen share).
//
// The first offer and answer wait for ICE gathering to finish (no trickle),
// so each fits in a single code. Later renegotiation for voice and video uses
// the "perfect negotiation" pattern over the ctl data channel.

import { connectionFingerprint } from './crypto.js';

/** Public STUN servers, in the order they are tried. */
export const STUN_SERVERS = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

// No public TURN server is built in: people who need a relay (strict NAT on
// both ends) add their own in settings.

/** Check one TURN server entered in settings. Returns a normalized entry or throws. */
const turnError = (reason, message) => Object.assign(new TypeError(message), { reason });

export function parseTurn({ urls, username = '', credential = '' }) {
  const list = (Array.isArray(urls) ? urls : String(urls || '').split(/[\s,]+/)).map((u) => u.trim()).filter(Boolean);
  if (!list.length) throw turnError('empty', 'Add at least one TURN address, like turn:turn.example.com:3478');
  for (const u of list) {
    if (!/^(turns?|stun):[^\s/?#]+(:\d{1,5})?(\?transport=(udp|tcp))?$/i.test(u)) throw turnError('format', `"${u}" is not a TURN address. It should look like turn:host:3478`);
  }
  if (list.some((u) => /^turns?:/i.test(u)) && (!username || !credential)) throw turnError('auth', 'TURN servers need a username and a password.');
  return { urls: list, username: String(username), credential: String(credential) };
}

/** ICE servers: the public STUN servers, then the TURN servers the user added in settings. */
export function buildIceServers({ custom = [], stun = STUN_SERVERS } = {}) {
  const out = stun.map((urls) => ({ urls }));
  for (const s of custom) out.push({ urls: s.urls, username: s.username, credential: s.credential });
  return out;
}

/** Count candidate types in an SDP. */
export function candidateTypes(sdp) {
  const out = { host: 0, srflx: 0, relay: 0, prflx: 0 };
  for (const m of String(sdp || '').matchAll(/^a=candidate:.* typ (host|srflx|relay|prflx)/gm)) out[m[1]]++;
  return out;
}

/**
 * Explain why a connection did not open, in words people understand.
 * Returns a reason key the UI translates: 'offline', 'blocked', 'no-stun', 'strict-nat' or 'timeout'.
 */
export function diagnose({ localSdp, remoteSdp, online = true }) {
  if (!online) return 'offline';
  const local = candidateTypes(localSdp);
  const remote = candidateTypes(remoteSdp);
  if (!local.srflx && !local.relay) return local.host ? 'no-stun' : 'blocked';
  if (local.relay && remote.relay) return 'timeout';
  return 'strict-nat';
}

const DC_MESH = 0;
const DC_CTL = 2;

export class RtcLink {
  constructor({ iceServers = buildIceServers(), gatherTimeout = 6000, RTCPeerConnection: PC = globalThis.RTCPeerConnection } = {}) {
    this.pc = new PC({ iceServers, bundlePolicy: 'max-bundle' });
    this.gatherTimeout = gatherTimeout;
    this.open = false;
    this.closed = false;
    this.polite = false;
    this.ready = false;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.senders = {};
    this.localMedia = {};
    this.remoteMedia = {};
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onfail = null;
    this.ontrack = null;
    this.onmedia = null;
    this.onstate = null;

    this.dc = this.pc.createDataChannel('room', { negotiated: true, id: DC_MESH });
    this.ctl = this.pc.createDataChannel('ctl', { negotiated: true, id: DC_CTL });

    this.dc.onopen = () => {
      if (this.open || this.closed) return;
      this.open = true;
      this.ready = true;
      clearTimeout(this.lostTimer);
      this.onopen?.();
    };
    this.dc.onmessage = (e) => this.onmessage?.(e.data);
    this.dc.onclose = () => this._end('closed');
    this.ctl.onmessage = (e) => this._onCtl(e.data);

    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      this.onstate?.(s);
      if (s === 'failed') this._end('failed');
      else if (s === 'disconnected') {
        clearTimeout(this.lostTimer);
        this.lostTimer = setTimeout(() => {
          if (this.pc.connectionState !== 'connected') this._end('failed');
        }, 12000);
      } else if (s === 'connected') clearTimeout(this.lostTimer);
    };
    this.pc.onnegotiationneeded = () => this._negotiate();
    this.pc.onicecandidate = (e) => {
      if (e.candidate && this.ready && this.ctl.readyState === 'open') this._ctl({ candidate: e.candidate.toJSON() });
    };
    this.pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      this.ontrack?.({ track: e.track, stream, slot: this.slotOf(stream.id) });
    };
  }

  /** The media slot ('mic', 'camera', 'screen', 'screen-audio', 'movie' or 'movie-audio') a remote stream id belongs to. */
  slotOf(streamId) {
    for (const [slot, id] of Object.entries(this.remoteMedia)) if (id === streamId) return slot;
    return null;
  }

  async _gather() {
    const pc = this.pc;
    if (pc.iceGatheringState === 'complete') return;
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => pc.iceGatheringState === 'complete' && done();
      const timer = setTimeout(done, this.gatherTimeout);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  /** Create the first offer and wait for every ICE candidate. */
  offer() {
    this._offering ??= (async () => {
      await this.pc.setLocalDescription(await this.pc.createOffer());
      await this._gather();
      return this.pc.localDescription.sdp;
    })();
    return this._offering;
  }

  /** Answer a first offer and wait for every ICE candidate. */
  answer(sdp) {
    // Answering is idempotent: a repeated offer (a double click, a relay that
    // delivers twice) gets the same answer instead of a state error.
    this._answering ??= this._answer(sdp);
    return this._answering;
  }

  async _answer(sdp) {
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await this._gather();
    this._watchOpen();
    return this.pc.localDescription.sdp;
  }

  /** Apply the answer to the first offer. */
  /**
   * Apply the answer to the first offer. Idempotent: a second answer (the
   * same reply pasted twice, or delivered by two tabs or two relays) is
   * ignored and resolves false instead of throwing a state error.
   */
  async complete(sdp) {
    if (this.answered || this.closed || this.pc.signalingState !== 'have-local-offer') return false;
    this.answered = true;
    try {
      await this.pc.setRemoteDescription({ type: 'answer', sdp });
    } catch (err) {
      this.answered = false;
      throw err;
    }
    this._watchOpen();
    return true;
  }

  _watchOpen(ms = 25000) {
    clearTimeout(this.openTimer);
    this.openTimer = setTimeout(() => {
      if (!this.open && !this.closed) {
        this.onfail?.('timeout');
      }
    }, ms);
  }

  send(text) {
    if (this.dc.readyState !== 'open') throw new Error('link is not open');
    this.dc.send(text);
  }

  _ctl(msg) {
    if (this.ctl.readyState === 'open') this.ctl.send(JSON.stringify(msg));
  }

  async _negotiate() {
    if (!this.ready || this.closed) return;
    try {
      this.makingOffer = true;
      await this.pc.setLocalDescription();
      this._ctl({ description: this.pc.localDescription.toJSON(), media: this.localMedia });
    } catch (err) {
      this.onstate?.(`negotiation error: ${err.message}`);
    } finally {
      this.makingOffer = false;
    }
  }

  async _onCtl(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    try {
      if (msg.media && typeof msg.media === 'object') {
        this.remoteMedia = { ...msg.media };
        this.onmedia?.(this.remoteMedia);
      }
      if (msg.description) {
        const d = msg.description;
        // A stale or repeated answer (renegotiation for camera or screen) is ignored.
        if (d.type === 'answer' && this.pc.signalingState !== 'have-local-offer') return;
        const collision = d.type === 'offer' && (this.makingOffer || this.pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;
        await this.pc.setRemoteDescription(d);
        if (d.type === 'offer') {
          await this.pc.setLocalDescription();
          this._ctl({ description: this.pc.localDescription.toJSON(), media: this.localMedia });
        }
      } else if (msg.candidate) {
        try {
          await this.pc.addIceCandidate(msg.candidate);
        } catch (err) {
          if (!this.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      this.onstate?.(`negotiation error: ${err.message}`);
    }
  }

  /**
   * Put a local track in a slot ('mic', 'screen' or 'screen-audio'), replace it, or
   * remove it with a null track. Renegotiates when the set of tracks changes.
   */
  setTrack(slot, track, stream) {
    const sender = this.senders[slot];
    if (track && sender) {
      sender.replaceTrack(track);
    } else if (track) {
      this.senders[slot] = this.pc.addTrack(track, stream);
    } else if (sender) {
      try {
        this.pc.removeTrack(sender);
      } catch {
        // already gone with the connection
      }
      delete this.senders[slot];
    }
    if (track) this.localMedia[slot] = stream.id;
    else delete this.localMedia[slot];
    this._ctl({ media: this.localMedia });
  }

  /** The short fingerprint both ends can compare. */
  fingerprint() {
    return connectionFingerprint(this.pc.localDescription?.sdp, this.pc.remoteDescription?.sdp);
  }

  /** Connection facts for the UI: route type and media byte counters. */
  async stats() {
    const out = { route: 'unknown', audioIn: 0, audioOut: 0, videoIn: 0, videoOut: 0, rtt: null };
    if (this.closed) return out;
    const report = await this.pc.getStats();
    let pairId = null;
    report.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
    });
    report.forEach((s) => {
      if (s.type === 'candidate-pair' && (s.id === pairId || (!pairId && s.nominated && s.state === 'succeeded'))) {
        const local = report.get(s.localCandidateId);
        const remote = report.get(s.remoteCandidateId);
        out.route = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct';
        if (s.currentRoundTripTime != null) out.rtt = Math.round(s.currentRoundTripTime * 1000);
      }
      if (s.type === 'inbound-rtp') out[s.kind === 'audio' ? 'audioIn' : 'videoIn'] += s.bytesReceived || 0;
      if (s.type === 'outbound-rtp') out[s.kind === 'audio' ? 'audioOut' : 'videoOut'] += s.bytesSent || 0;
    });
    return out;
  }

  /** The upload the connection estimates it can use right now, in bits per second, or null. */
  async uploadEstimate() {
    if (this.closed) return null;
    const report = await this.pc.getStats();
    let best = null;
    report.forEach((s) => {
      if (s.type === 'candidate-pair' && s.nominated && Number.isFinite(s.availableOutgoingBitrate)) best = Math.max(best ?? 0, s.availableOutgoingBitrate);
    });
    return best;
  }

  diagnose(online) {
    return diagnose({ localSdp: this.pc.localDescription?.sdp, remoteSdp: this.pc.remoteDescription?.sdp, online });
  }

  _end(reason) {
    if (this.closed) return;
    const wasOpen = this.open;
    this.closed = true;
    this.open = false;
    clearTimeout(this.openTimer);
    clearTimeout(this.lostTimer);
    try {
      this.pc.close();
    } catch {
      // ignore
    }
    if (wasOpen) this.onclose?.(reason);
    else this.onfail?.(reason);
  }

  close() {
    this._end('closed');
  }
}
