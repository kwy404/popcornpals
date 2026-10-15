import { describe, expect, it } from 'vitest';
import { fakeBroker } from './fake-broker.js';
import { utf8 } from '../src/bytes.js';
import {
  MqttClient,
  PacketReader,
  TYPES,
  connectPacket,
  decodeLength,
  disconnectPacket,
  encodeLength,
  encodeString,
  parseConnack,
  parsePublish,
  parseSuback,
  pingPacket,
  publishPacket,
  subscribePacket,
} from '../src/mqtt.js';
import { RelayHub } from '../src/relay.js';

describe('MQTT 3.1.1 packet encoding', () => {
  it('encodes remaining lengths at every size boundary', () => {
    const cases = [
      [0, [0x00]],
      [127, [0x7f]],
      [128, [0x80, 0x01]],
      [16383, [0xff, 0x7f]],
      [16384, [0x80, 0x80, 0x01]],
      [2097151, [0xff, 0xff, 0x7f]],
      [2097152, [0x80, 0x80, 0x80, 0x01]],
      [268435455, [0xff, 0xff, 0xff, 0x7f]],
    ];
    for (const [n, bytes] of cases) {
      expect(Array.from(encodeLength(n))).toEqual(bytes);
      expect(decodeLength(Uint8Array.from([0, ...bytes]), 1)).toEqual({ value: n, size: bytes.length });
    }
    expect(() => encodeLength(268435456)).toThrow();
    expect(decodeLength(Uint8Array.of(0, 0x80), 1)).toBeNull();
    expect(() => decodeLength(Uint8Array.of(0, 0x80, 0x80, 0x80, 0x80, 0x01), 1)).toThrow();
  });

  it('builds CONNECT exactly as the specification lays it out', () => {
    expect(Array.from(connectPacket({ clientId: 'ab', keepAlive: 30 }))).toEqual([
      0x10, 14, 0, 4, 0x4d, 0x51, 0x54, 0x54, 4, 0x02, 0, 30, 0, 2, 0x61, 0x62,
    ]);
  });

  it('builds SUBSCRIBE, PUBLISH, PINGREQ and DISCONNECT', () => {
    expect(Array.from(subscribePacket(10, ['a/b']))).toEqual([0x82, 8, 0, 10, 0, 3, 0x61, 0x2f, 0x62, 0]);
    expect(Array.from(publishPacket('t', 'hi'))).toEqual([0x30, 5, 0, 1, 0x74, 0x68, 0x69]);
    expect(publishPacket('t', 'x', { retain: true })[0]).toBe(0x31);
    expect(Array.from(pingPacket())).toEqual([0xc0, 0]);
    expect(Array.from(disconnectPacket())).toEqual([0xe0, 0]);
    expect(Array.from(encodeString('\u00e9'))).toEqual([0, 2, 0xc3, 0xa9]);
  });

  it('reads packets split across frames and joined in one frame', () => {
    const big = publishPacket('topic/x', new Uint8Array(300).fill(7));
    const joined = new Uint8Array([...Uint8Array.of(0x20, 2, 0, 0), ...big, ...Uint8Array.of(0x90, 3, 0, 1, 0)]);
    const r = new PacketReader();
    const got = [];
    for (let i = 0; i < joined.length; i += 7) got.push(...r.push(joined.slice(i, i + 7)));
    expect(got.map((p) => p.type)).toEqual([TYPES.CONNACK, TYPES.PUBLISH, TYPES.SUBACK]);
    expect(parseConnack(got[0])).toEqual({ sessionPresent: false, code: 0 });
    const pub = parsePublish(got[1]);
    expect(pub.topic).toBe('topic/x');
    expect(pub.payload.length).toBe(300);
    expect(pub.qos).toBe(0);
    expect(parseSuback(got[2])).toEqual({ id: 1, codes: [0] });
  });

  it('reads a QoS 1 publish with its packet id', () => {
    const body = [0, 1, 0x74, 0, 9, 0x41];
    const [p] = new PacketReader().push(Uint8Array.from([0x32, body.length, ...body]));
    expect(parsePublish(p)).toMatchObject({ topic: 't', qos: 1, id: 9 });
  });
});

describe('MqttClient', () => {
  it('connects with the mqtt subprotocol, subscribes and receives what it publishes', async () => {
    const WS = fakeBroker();
    const a = new MqttClient('wss://x', { WebSocket: WS });
    const b = new MqttClient('wss://x', { WebSocket: WS });
    await a.connect();
    await b.connect();
    expect(a.ws.protocols).toEqual(['mqtt']);
    expect(a.clientId).toMatch(/^pp[A-Za-z0-9]+$/);
    await b.subscribe('room');
    const got = new Promise((r) => b.on('message', (m) => r(new TextDecoder().decode(m.payload))));
    a.publish('room', utf8('hello'));
    expect(await got).toBe('hello');
    a.close();
    b.close();
  });

  it('reports a refused connection and a broker that never answers', async () => {
    await expect(new MqttClient('wss://r', { WebSocket: fakeBroker({ refuse: true }) }).connect()).rejects.toThrow(/not authorized/);
    await expect(new MqttClient('wss://s', { WebSocket: fakeBroker({ silent: true }), timeout: 50 }).connect()).rejects.toThrow(/no answer/);
  });
});

describe('RelayHub', () => {
  it('uses every broker that works and ignores the ones that do not', async () => {
    const servers = { 'wss://good1': fakeBroker(), 'wss://good2': fakeBroker(), 'wss://bad': fakeBroker({ silent: true }) };
    const WS = class {
      constructor(url, p) {
        return new servers[url](url, p);
      }
    };
    const brokers = ['wss://good1', 'wss://bad', 'wss://good2'];
    const a = new RelayHub('t/1', { brokers, WebSocket: WS, timeout: 80 });
    const b = new RelayHub('t/1', { brokers, WebSocket: WS, timeout: 80 });
    await a.start();
    await b.start();
    await new Promise((r) => setTimeout(r, 120));
    expect(a.status().connected.sort()).toEqual(['wss://good1', 'wss://good2']);
    expect(a.failed.map((f) => f.url)).toEqual(['wss://bad']);
    const got = [];
    b.on('message', (m) => got.push(m.broker));
    expect(a.publish(utf8('x'))).toBe(2);
    await new Promise((r) => setTimeout(r, 30));
    expect(got.sort()).toEqual(['wss://good1', 'wss://good2']); // duplicates are dropped later by the replay guard
    a.close();
    b.close();
  });

  it('fails clearly when no broker answers', async () => {
    const hub = new RelayHub('t/2', { brokers: ['wss://a', 'wss://b'], WebSocket: fakeBroker({ silent: true }), timeout: 40 });
    await expect(hub.start()).rejects.toThrow(/No public relay answered/);
  });
});
