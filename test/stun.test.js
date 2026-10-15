import { describe, expect, it } from 'vitest';
import { probeAll, probeStun } from '../src/stun.js';
import { STUN_SERVERS, buildIceServers, parseTurn } from '../src/rtc.js';

/** A fake peer connection that answers like a STUN server would, or stays silent. */
const fakePC = (answers) =>
  class {
    constructor({ iceServers }) {
      this.url = iceServers[0].urls;
    }
    createDataChannel() {}
    async createOffer() {
      return {};
    }
    async setLocalDescription() {
      setTimeout(() => {
        this.onicecandidate?.({ candidate: { candidate: 'candidate:1 1 udp 1 192.168.0.2 5000 typ host' } });
        if (answers.includes(this.url)) this.onicecandidate?.({ candidate: { candidate: 'candidate:2 1 udp 1 203.0.113.5 5000 typ srflx raddr 0.0.0.0' } });
        else this.onicecandidate?.({ candidate: null });
      }, 1);
    }
    close() {}
  };

describe('STUN servers', () => {
  it('tries the first public server first and adds the TURN servers people set', () => {
    expect(STUN_SERVERS).toEqual(['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']);
    const turn = parseTurn({ urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' });
    expect(buildIceServers({ custom: [turn] })).toEqual([...STUN_SERVERS.map((urls) => ({ urls })), { urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'p' }]);
    expect(() => parseTurn({ urls: 'turn:x.example:3478' })).toThrow(/username/);
    expect(() => parseTurn({ urls: 'http://x' })).toThrow();
  });

  it('reports which servers answered', async () => {
    const PC = fakePC([STUN_SERVERS[1]]);
    expect(await probeStun(STUN_SERVERS[1], { RTCPeerConnection: PC })).toBe(true);
    expect(await probeAll(STUN_SERVERS, { RTCPeerConnection: PC })).toEqual(STUN_SERVERS.map((url, i) => ({ url, ok: i === 1 })));
    expect(await probeStun('stun:x', { RTCPeerConnection: undefined })).toBe(false);
  });
});
