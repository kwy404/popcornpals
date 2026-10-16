// Tiny static server for local QA and the browser tests.
//   node scripts/serve.mjs [port] [root] [base]
// With a base such as /popcornpals/, files are only served under that path,
// the way GitHub Pages serves a project site, so relative paths get tested.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml', '.woff2': 'font/woff2', '.webm': 'video/webm', '.mp4': 'video/mp4',
};

export function serve(port = 8080, root = 'docs', { base = '/', host = '127.0.0.1', mounts = {} } = {}) {
  const dir = resolve(root);
  const prefix = base.endsWith('/') ? base : `${base}/`;
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (path === prefix.slice(0, -1)) {
        res.writeHead(301, { location: prefix });
        return res.end();
      }
      // Extra folders for tests, such as a fake streaming site page: { '/fixtures/': 'test/fixtures' }.
      const mount = Object.keys(mounts).find((m) => path.startsWith(m));
      const top = mount ? resolve(mounts[mount]) : dir;
      if (!mount && !path.startsWith(prefix)) throw new Error('outside base');
      let file = normalize(join(top, path.slice((mount || prefix).length)));
      if (!file.startsWith(top)) throw new Error('outside');
      const info = await stat(file).catch(() => null);
      if (info?.isDirectory()) {
        if (!path.endsWith('/')) {
          res.writeHead(301, { location: `${path}/` });
          return res.end();
        }
        file = join(file, 'index.html');
      }
      const body = await readFile(file);
      const type = types[extname(file)] || 'application/octet-stream';
      // Byte ranges, so media players can seek the way they do on a real host.
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, body.length - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
        if (start >= body.length || start > end) {
          res.writeHead(416, { 'content-range': `bytes */${body.length}` });
          return res.end();
        }
        res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${body.length}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1, 'cache-control': 'no-store' });
        return res.end(body.subarray(start, end + 1));
      }
      res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': body.length, 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      const body = await readFile(join(dir, '404.html')).catch(() => 'not found');
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    }
  });
  return new Promise((ok) => server.listen(port, host, () => ok(server)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] || 8080);
  const base = process.argv[4] || '/popcornpals/';
  serve(port, process.argv[3] || 'docs', { base }).then(() => console.log(`serving http://127.0.0.1:${port}${base}`));
}
