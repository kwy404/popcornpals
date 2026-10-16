// Builds the browser extension for loading unpacked:
// 1. extension/lib/sync.js: src/sync.js and src/extsync.js as one classic
//    script (content scripts cannot be modules), exposed as globalThis.PPSync.
// 2. docs/extension/popcornpals-extension-<version>.zip: the extension folder,
//    for the download button on the site, and docs/extension/latest.json with
//    its version, size and SHA-256.
// 3. The version, size and checksum shown on the landing page (docs/index.html).
// With --check it fails when any of these is out of date (used in CI). The
// zip is deterministic (fixed dates, sorted names), so the check compares bytes.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';

function moduleBody(file) {
  return readFileSync(file, 'utf8')
    .replace(/^import [^;]+;\n/gm, '')
    .replace(/^export (const|function|class) /gm, '$1 ');
}

export function bundle() {
  return `// Built by scripts/build-extension.mjs from src/sync.js and src/extsync.js. Edit those instead.
(() => {
${moduleBody('src/sync.js')}
${moduleBody('src/extsync.js')}
globalThis.PPSync = { PROTOCOL, PlayerSync, readMessage, message, pickMainVideo, expectedPosition };
})();
`;
}

// A small zip writer: deflate, CRC-32, local headers, central directory.
const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

function files(dir) {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? files(p) : [p];
    });
}

/** The zip of the extension folder, with lib/sync.js as it should be built. */
export function zip(dir = 'extension', prefix = 'popcornpals-extension') {
  const locals = [];
  const central = [];
  let offset = 0;
  const DATE = ((2026 - 1980) << 9) | (10 << 5) | 15; // 2026-10-15
  const built = join(dir, 'lib', 'sync.js');
  const list = files(dir);
  if (!list.includes(built)) list.push(built);
  list.sort();
  for (const file of list) {
    const name = Buffer.from(`${prefix}/${relative(dir, file).split('\\').join('/')}`);
    const data = file === built ? Buffer.from(bundle()) : readFileSync(file);
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(8, 8);
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(DATE, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    locals.push(head, name, packed);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(0, 12);
    c.writeUInt16LE(DATE, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(packed.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += head.length + name.length + packed.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Everything the build produces, as { path: content }. */
export function outputs() {
  const version = JSON.parse(readFileSync('extension/manifest.json', 'utf8')).version;
  const bytes = zip();
  const file = `popcornpals-extension-${version}.zip`;
  const meta = { version, file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const out = {
    'extension/lib/sync.js': Buffer.from(bundle()),
    [`docs/extension/${file}`]: bytes,
    'docs/extension/latest.json': Buffer.from(`${JSON.stringify(meta, null, 2)}\n`),
  };
  if (existsSync('docs/index.html')) {
    const kb = `${Math.round(meta.bytes / 1024)} KB`;
    const html = readFileSync('docs/index.html', 'utf8')
      .replace(/(data-ext="version">)[^<]*</g, `$1${version}<`)
      .replace(/(data-ext="size">)[^<]*</g, `$1${kb}<`)
      .replace(/(data-ext="sha256">)[^<]*</g, `$1${meta.sha256}<`)
      .replace(/(data-ext="href" href=")[^"]*"/g, `$1extension/${file}"`);
    out['docs/index.html'] = Buffer.from(html);
  }
  return { meta, out };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check');
  const { meta, out } = outputs();
  const stale = [];
  for (const [path, want] of Object.entries(out)) {
    const have = existsSync(path) ? readFileSync(path) : null;
    if (have && have.equals(want)) continue;
    if (check) stale.push(path);
    else {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, want);
    }
  }
  // Older versions of the zip are removed, so the site serves one download.
  if (existsSync('docs/extension')) {
    for (const name of readdirSync('docs/extension')) {
      if (name.endsWith('.zip') && name !== meta.file) {
        if (check) stale.push(`docs/extension/${name} (old version)`);
        else rmSync(join('docs/extension', name));
      }
    }
  }
  if (stale.length) {
    console.error(`extension build is stale, run npm run extension:\n${stale.join('\n')}`);
    process.exit(1);
  }
  console.log(check ? `extension: ${meta.file} up to date` : `extension: ${meta.file} (${meta.bytes} bytes, sha256 ${meta.sha256})`);
}
