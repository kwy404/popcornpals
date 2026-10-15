// Node 18 lacks a global Web Crypto object and deflate-raw in CompressionStream.
// Browsers have both, so the tests polyfill them from node: built-ins.
import { webcrypto } from 'node:crypto';
import { Duplex } from 'node:stream';
import zlib from 'node:zlib';

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

function supportsRaw() {
  try {
    new CompressionStream('deflate-raw');
    return true;
  } catch {
    return false;
  }
}

if (!supportsRaw()) {
  const wrap = (make) =>
    class {
      constructor() {
        const node = Duplex.toWeb(make());
        this.readable = node.readable;
        this.writable = node.writable;
      }
    };
  globalThis.CompressionStream = wrap(() => zlib.createDeflateRaw());
  globalThis.DecompressionStream = wrap(() => zlib.createInflateRaw());
}
