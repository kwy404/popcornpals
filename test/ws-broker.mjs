// A tiny MQTT 3.1.1 broker over WebSocket for the browser test, so pairing
// with six words runs without the public relays. It speaks just enough of
// both protocols for the app's client: CONNECT, SUBSCRIBE, PUBLISH (QoS 0),
// PINGREQ and DISCONNECT, in binary WebSocket frames.

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { PacketReader, TYPES, encodeLength, parsePublish } from '../src/mqtt.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(payload, opcode = 2) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, Buffer.from(payload)]);
}

/** Read complete client frames from a buffer. Returns { frames, rest }. */
function readFrames(buf) {
  const frames = [];
  let o = 0;
  while (buf.length - o >= 2) {
    const opcode = buf[o] & 0x0f;
    const masked = buf[o + 1] & 0x80;
    let len = buf[o + 1] & 0x7f;
    let p = o + 2;
    if (len === 126) {
      if (buf.length < p + 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length < p + 8) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length < p + maskLen + len) break;
    const mask = masked ? buf.subarray(p, p + 4) : null;
    p += maskLen;
    const data = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    frames.push({ opcode, data });
    o = p + len;
  }
  return { frames, rest: buf.subarray(o) };
}

export function startBroker(port = 0) {
  const subs = new Map(); // topic -> Set(client)
  const clients = new Set();
  let published = 0;
  const server = createServer((req, res) => {
    res.writeHead(426);
    res.end('WebSocket only');
  });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    const proto = String(req.headers['sec-websocket-protocol'] || '').includes('mqtt') ? 'Sec-WebSocket-Protocol: mqtt\r\n' : '';
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${proto}\r\n`);
    const client = { socket, reader: new PacketReader(), topics: new Set() };
    clients.add(client);
    let pending = Buffer.alloc(0);
    const send = (bytes) => {
      if (!socket.destroyed) socket.write(frame(bytes));
    };
    const drop = () => {
      clients.delete(client);
      for (const t of client.topics) subs.get(t)?.delete(client);
      socket.destroy();
    };
    socket.on('data', (chunk) => {
      const { frames, rest } = readFrames(Buffer.concat([pending, chunk]));
      pending = Buffer.from(rest);
      for (const f of frames) {
        if (f.opcode === 8) return drop();
        if (f.opcode === 9) {
          socket.write(frame(f.data, 10));
          continue;
        }
        if (f.opcode !== 2 && f.opcode !== 0) continue;
        for (const p of client.reader.push(new Uint8Array(f.data))) {
          if (p.type === TYPES.CONNECT) send(Uint8Array.of(0x20, 2, 0, 0));
          else if (p.type === TYPES.SUBSCRIBE) {
            const n = (p.body[2] << 8) | p.body[3];
            const topic = new TextDecoder().decode(p.body.subarray(4, 4 + n));
            if (!subs.has(topic)) subs.set(topic, new Set());
            subs.get(topic).add(client);
            client.topics.add(topic);
            send(Uint8Array.of(0x90, 3, p.body[0], p.body[1], 0));
          } else if (p.type === TYPES.PUBLISH) {
            const { topic } = parsePublish(p);
            const raw = Uint8Array.from([0x30, ...encodeLength(p.body.length), ...p.body]);
            published++;
            for (const c of subs.get(topic) ?? []) if (!c.socket.destroyed) c.socket.write(frame(raw));
          } else if (p.type === TYPES.PINGREQ) send(Uint8Array.of(0xd0, 0));
          else if (p.type === TYPES.DISCONNECT) drop();
        }
      }
    });
    socket.on('error', drop);
    socket.on('close', drop);
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address();
      resolve({
        url: `ws://127.0.0.1:${actual}/mqtt`,
        get published() {
          return published;
        },
        close: () => {
          for (const c of clients) c.socket.destroy();
          server.close();
        },
      });
    }),
  );
}
