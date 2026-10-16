// The streaming site extension in a real browser. Two people, each with the
// unpacked extension loaded in their own browser profile:
//   Ana starts a room and Bia joins with six words.
//   Each opens a test "streaming site" page with a video player (built for
//   this test, test/fixtures/player.html) and connects it to the room.
//   Play from the app reaches both players; a pause pressed on Bia's site
//   player and a seek on Ana's site player reach the other one; both stay
//   within a second of each other. A player that undoes outside seeks makes
//   the extension fall back to play and pause only, and the app says so.
// The shipped manifest only asks for the popcornpals site; the test copy also
// matches this local server, the way a developer would load it.
//
// Usage: node test/e2e-extension.mjs [browser path]

import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { serve } from '../scripts/serve.mjs';
import { ensureTestVideo } from '../scripts/make-test-video.mjs';
import { FAKE_MEDIA, findBrowser } from './browser.mjs';
import { startBroker } from './ws-broker.mjs';

const executablePath = process.env.EXT_BROWSER === 'playwright' ? chromium.executablePath() : findBrowser(process.argv[2]);
const port = 8900 + Math.floor(Math.random() * 90);
const server = await serve(port, 'docs', { base: '/popcornpals/', mounts: { '/fixtures/': 'test/fixtures', '/media/': '.e2e' } });
const broker = await startBroker();
const base = `http://127.0.0.1:${port}/popcornpals/app/`;
const site = `http://localhost:${port}`;

let step = 0;
const log = (msg) => console.log(`${String(++step).padStart(2, '0')} ${msg}`);
const errors = [];
const ok = (cond, msg) => {
  if (!cond) throw new Error(`check failed: ${msg}`);
};

// A copy of the extension that also runs on this local server.
const ext = mkdtempSync(join(tmpdir(), 'popcornpals-ext-'));
cpSync('extension', ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
manifest.content_scripts[0].matches.push('http://127.0.0.1/*');
manifest.host_permissions = ['http://localhost/*'];
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));

const CDN = {
  'https://cdn.jsdelivr.net/npm/monsooncss@0.2.0/dist/monsoon.min.css': ['node_modules/monsooncss/dist/monsoon.min.css', 'text/css'],
  'https://cdn.jsdelivr.net/npm/voodoojs@1.0.0/dist/voodoo.full.min.js': ['node_modules/voodoojs/dist/voodoo.full.min.js', 'text/javascript'],
};

async function person(name) {
  const dir = mkdtempSync(join(tmpdir(), 'popcornpals-e2e-ext-'));
  const context = await chromium.launchPersistentContext(dir, {
    executablePath,
    headless: true,
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [...FAKE_MEDIA, `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  for (const [url, [file, type]] of Object.entries(CDN)) {
    if (existsSync(file)) await context.route(url, (route) => route.fulfill({ status: 200, contentType: type, body: readFileSync(file), headers: { 'access-control-allow-origin': '*' } }));
  }
  await context.addInitScript((url) => {
    if (location.pathname.includes('/popcornpals/')) {
      localStorage.setItem('pp:brokers', JSON.stringify(url));
      localStorage.setItem('pp:lang', '"en"');
    }
  }, broker.url);
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker', { timeout: 30000 }));
  const app = context.pages()[0] || (await context.newPage());
  const watch = (page, label) => {
    page.on('pageerror', (e) => errors.push(`${name} ${label}: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`${name} ${label}: ${m.text()}`));
  };
  watch(app, 'app');
  await app.goto(base);
  await app.waitForSelector('#start-room');
  return { name, context, worker, app, player: null, watch };
}

/** The person's streaming site tab. */
async function openSite(p) {
  p.player = await p.context.newPage();
  p.watch(p.player, 'site');
  await p.player.goto(`${site}/fixtures/player.html`);
  await p.player.waitForFunction(() => document.getElementById('movie').readyState >= 1, null, { timeout: 60000 });
}

async function waitFor(page, fn, arg, label, timeout = 60000) {
  try {
    await page.waitForFunction(fn, arg, { timeout, polling: 200 });
  } catch {
    throw new Error(`timed out: ${label}`);
  }
}

async function words(page, selector) {
  await page.waitForFunction((sel) => (document.querySelector(sel)?.dataset.words || '').split(' ').filter(Boolean).length === 6, selector, { timeout: 45000 });
  return (await page.getAttribute(selector, 'data-words')).split(' ');
}

/** Connect the person's site tab the way the popup's button does. */
async function connectSite(p) {
  await p.app.bringToFront();
  const result = await p.worker.evaluate(async (origin) => {
    const tabs = await globalThis.chrome.tabs.query({ url: 'http://localhost/*' });
    return self.ppConnectTab(tabs[0].id, origin, false);
  }, site);
  ok(result.ok, `${p.name}: the extension connects the site tab`);
  await waitFor(p.app, () => window.popcornpals.S.ext.found, null, `${p.name}: the app sees the site player`);
}

const sitePos = (p) => p.player.evaluate(() => ({ pos: document.getElementById('movie').currentTime, paused: document.getElementById('movie').paused, at: Date.now() }));

async function spread(a, b) {
  const [x, y] = await Promise.all([sitePos(a), sitePos(b)]);
  const t = Math.max(x.at, y.at);
  const now = (s) => s.pos + (s.paused ? 0 : (t - s.at) / 1000);
  return { spread: Math.abs(now(x) - now(y)), x, y };
}

async function closeTo(a, b, label, { paused, limit = 1 } = {}) {
  const deadline = Date.now() + 40000;
  let last;
  while (Date.now() < deadline) {
    last = await spread(a, b);
    if (last.spread < limit && (paused === undefined || (last.x.paused === paused && last.y.paused === paused))) {
      log(`${label}: site players at ${last.x.pos.toFixed(2)} and ${last.y.pos.toFixed(2)} (spread ${last.spread.toFixed(3)} s)`);
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`check failed: ${label}: ${JSON.stringify(last)}`);
}

const people = [];
try {
  const ana = await person('Ana');
  const bia = await person('Bia');
  people.push(ana, bia);
  // A long video, so a slow machine never reaches the end in the middle of a check.
  await ensureTestVideo(ana.context, base, '.e2e/long.webm', { width: 320, height: 180, fps: 5, seconds: 300 });
  for (const p of [ana, bia]) await openSite(p);
  log('two browsers with the unpacked extension and a test streaming site');

  for (const p of [ana, bia]) await waitFor(p.app, () => window.popcornpals.S.ext.installed, null, `${p.name}: the app sees the extension`);
  log('the app detects the installed extension');

  await ana.app.bringToFront();
  await bia.app.bringToFront();
  await ana.app.fill('#name', 'Ana');
  await ana.app.click('#start-room');
  await ana.app.click('#invite');
  const w = await words(ana.app, '.invite-words');
  await bia.app.fill('#name', 'Bia');
  await bia.app.click('#open-join');
  for (let i = 0; i < 6; i++) await bia.app.fill(`#join-word-${i}`, w[i]);
  await bia.app.click('#join-go');
  const confirm = await words(bia.app, '.confirm-words');
  await ana.app.waitForSelector('#confirm-word-0');
  for (let i = 0; i < 6; i++) await ana.app.fill(`#confirm-word-${i}`, confirm[i]);
  await ana.app.click('#confirm-go');
  await bia.app.waitForSelector('.room', { timeout: 30000 });
  await ana.app.click('#invite-modal .modal-x');
  log('Bia joined Ana\'s room');

  await connectSite(ana);
  await connectSite(bia);
  log('both site tabs are connected through the extension');
  ok(await ana.player.evaluate(() => [...document.documentElement.children].some((el) => el.shadowRoot === null && /2147483647/.test(el.getAttribute('style') || ''))), 'the overlay shows on the site page');

  for (const p of [ana, bia]) {
    await p.app.evaluate(() => {
      window.__states = [];
      addEventListener('message', (e) => e.data?.ppExt === 'in' && e.data.m.type === 'event' && window.__states.push(`ext ${JSON.stringify(e.data.m)}`));
      window.popcornpals.app.room.on('state', () => {
        const st = window.popcornpals.app.room.state;
        window.__states.push(`${st.seq} ${st.lastAction} by ${st.by.slice(0, 4)} pos ${st.pos.toFixed(2)} ${st.playing ? 'playing' : 'paused'}`);
      });
    });
  }
  await ana.app.click('#pick-ext');
  await ana.app.click('#ext-go');
  await waitFor(bia.app, () => window.popcornpals.S.media.kind === 'ext', null, 'Bia sees the streaming site source');
  await ana.app.click('#play');
  await ana.player.waitForFunction(() => document.getElementById('movie').currentTime > 1.5, null, { timeout: 60000 });
  await closeTo(ana, bia, 'play from the app', { paused: false });

  await bia.player.bringToFront();
  await bia.player.click('#site-pause');
  await closeTo(ana, bia, 'pause pressed on Bia\'s site player', { paused: true, limit: 0.5 });

  await ana.player.bringToFront();
  await ana.player.click('#site-jump');
  const target = await ana.player.evaluate(() => window.__jumpedTo);
  await waitFor(bia.player, (to) => Math.abs(document.getElementById('movie').currentTime - to) < 1, target, 'Bia follows Ana\'s seek on the site');
  await closeTo(ana, bia, 'seek on Ana\'s site player', { paused: true, limit: 0.5 });

  await bia.player.click('#site-play');
  await new Promise((r) => setTimeout(r, 2000));
  await closeTo(ana, bia, 'play pressed on Bia\'s site player', { paused: false });

  // A player that refuses outside seeks: only play and pause stay in sync.
  await bia.player.goto(`${site}/fixtures/player.html?noseek=1`);
  await bia.player.waitForFunction(() => document.getElementById('movie').readyState >= 1);
  await connectSite(bia);
  await ana.player.click('#site-pause');
  await ana.player.click('#site-jump');
  await waitFor(bia.app, () => window.popcornpals.S.ext.found && window.popcornpals.S.ext.seekable === false, null, 'Bia\'s app learns seeking is refused');
  await bia.app.waitForSelector('text=does not accept seeking from outside');
  await ana.player.click('#site-play');
  await waitFor(bia.player, () => !document.getElementById('movie').paused, null, 'play still reaches the no-seek player');
  log('a player that refuses outside seeks falls back to play and pause, and the app says so');

  ok(errors.length === 0, `no console errors:\n${errors.join('\n')}`);
  log('no console errors');
  console.log('extension e2e passed');
} catch (err) {
  console.error(err.message);
  if (errors.length) console.error(`console errors:\n${errors.join('\n')}`);
  for (const p of people) {
    await p.app.screenshot({ path: resolve(`.e2e/failure-ext-${p.name}-app.png`) }).catch(() => {});
    await p.player?.screenshot({ path: resolve(`.e2e/failure-ext-${p.name}-site.png`) }).catch(() => {});
  }
  for (const p of people) console.error(p.name, await p.app.evaluate(() => window.__states).catch(() => null), await p.player?.evaluate(() => window.__events.slice(-60)).catch(() => null));
  process.exitCode = 1;
} finally {
  await Promise.all(people.map((p) => p.context.close().catch(() => {})));
  broker.close();
  server.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 200);
}
