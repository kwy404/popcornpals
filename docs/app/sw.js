// popcornpals service worker: keeps the app shell available offline so the
// app opens like an installed one. Every path is relative to this file, so it
// works under any folder (GitHub Pages serves it from /popcornpals/app/).
// Pages are fetched from the network first and fall back to the cache.

const CACHE = 'popcornpals-app-v1';
const SHELL = [
  './',
  'index.html',
  'app.css',
  'manifest.webmanifest',
  'favicon.svg',
  'icons.svg',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'js/main.js',
  'js/i18n.js',
  'js/room.js',
  'js/players.js',
  'js/media.js',
  'js/words-ui.js',
  'js/denoise-worklet.js',
  'core/bytes.js',
  'core/chat.js',
  'core/crypto.js',
  'core/dsp.js',
  'core/emitter.js',
  'core/extsync.js',
  'core/filehash.js',
  'core/mesh.js',
  'core/mqtt.js',
  'core/pairing.js',
  'core/people.js',
  'core/qr.js',
  'core/quality.js',
  'core/relay.js',
  'core/rendezvous.js',
  'core/rtc.js',
  'core/sha256.js',
  'core/stun.js',
  'core/subtitles.js',
  'core/sync.js',
  'core/version.js',
  'core/voice.js',
  'core/wordlist.js',
  'core/words.js',
  'core/youtube.js',
  '../assets/illustrations/screening-room-dark.svg',
  '../assets/illustrations/screening-room.svg',
  '../assets/illustrations/black-screen-dark.svg',
  '../assets/illustrations/black-screen.svg',
];
const CDN = ['https://cdn.jsdelivr.net/npm/monsooncss@0.2.0/dist/monsoon.min.css', 'https://cdn.jsdelivr.net/npm/voodoojs@1.0.0/dist/voodoo.full.min.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(SHELL);
      await Promise.all(CDN.map((url) => cache.add(new Request(url, { mode: 'cors' })).catch(() => {})));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE && key.startsWith('popcornpals-')) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const mine = url.origin === self.location.origin;
  if (!mine && !CDN.includes(req.url)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(req);
        if (res.ok && (mine || res.type === 'cors')) cache.put(req, res.clone());
        return res;
      } catch {
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
        if (req.mode === 'navigate') return (await cache.match('index.html')) || Response.error();
        return Response.error();
      }
    })(),
  );
});
