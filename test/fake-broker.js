// An in-memory MQTT broker reachable through a fake WebSocket class, for relay and pairing tests.
import { PacketReader, TYPES, encodeLength, parsePublish } from '../src/mqtt.js';

/** An in-memory broker reachable through a fake WebSocket class. */
export function fakeBroker({ refuse = false, silent = false } = {}) {
  const subs = new Map();
  class FakeSocket {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = 0;
      this.reader = new PacketReader();
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.();
      }, 1);
    }
    deliver(bytes) {
      setTimeout(() => this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }), 1);
    }
    send(bytes) {
      if (silent) return;
      for (const p of this.reader.push(bytes)) {
        if (p.type === TYPES.CONNECT) this.deliver(Uint8Array.of(0x20, 2, 0, refuse ? 5 : 0));
        if (p.type === TYPES.SUBSCRIBE) {
          const n = (p.body[2] << 8) | p.body[3];
          const topic = new TextDecoder().decode(p.body.subarray(4, 4 + n));
          if (!subs.has(topic)) subs.set(topic, new Set());
          subs.get(topic).add(this);
          this.deliver(Uint8Array.of(0x90, 3, p.body[0], p.body[1], 0));
        }
        if (p.type === TYPES.PUBLISH) {
          const { topic } = parsePublish(p);
          const raw = Uint8Array.from([0x30, ...encodeLength(p.body.length), ...p.body]);
          for (const s of subs.get(topic) ?? []) s.deliver(raw);
        }
      }
    }
    close() {
      this.readyState = 3;
      for (const set of subs.values()) set.delete(this);
      setTimeout(() => this.onclose?.(), 1);
    }
  }
  return FakeSocket;
}

