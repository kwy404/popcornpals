// YouTube sync in two real browsers. It needs the network: both players load
// the official embedded player from YouTube. Ana starts a room, Bia joins with
// the six words, Ana loads a video, and play, pause, seek and speed must stay
// in step both ways. Pairing runs through the local relay (test/ws-broker.mjs).
// Console messages from the YouTube frames are listed but do not fail the test.
//
// Usage: node test/e2e-youtube.mjs [browser path]

import { existsSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { serve } from '../scripts/serve.mjs';
import { findBrowser, launchPerson } from './browser.mjs';
import { startBroker } from './ws-broker.mjs';

// An embeddable, freely licensed short film.
const VIDEO = process.env.E2E_YT_ID || 'aqz-KE-bpKQ';
const TOLERANCE = 1.0;
const executablePath = findBrowser(process.argv[2]);
const port = 8900 + Math.floor(Math.random() * 90);
const server = await serve(port, 'docs', { base: '/popcornpals/' });
const broker = await startBroker();
const base = `http://127.0.0.1:${port}/popcornpals/app/`;
const CDN = {
  'https://cdn.jsdelivr.net/npm/monsooncss@0.2.0/dist/monsoon.min.css': ['node_modules/monsooncss/dist/monsoon.min.css', 'text/css'],
  'https://cdn.jsdelivr.net/npm/voodoojs@1.0.0/dist/voodoo.full.min.js': ['node_modules/voodoojs/dist/voodoo.full.min.js', 'text/javascript'],
};

let step = 0;
const log = (msg) => console.log(`${String(++step).padStart(2, '0')} ${msg}`);
const errors = [];
const outside = new Set();
const ok = (cond, msg) => {
  if (!cond) throw new Error(`check failed: ${msg}`);
};

async function person(name) {
  const context = await launchPerson(chromium, { executablePath });
  for (const [url, [file, type]] of Object.entries(CDN)) {
    if (existsSync(file)) await context.route(url, (route) => route.fulfill({ status: 200, contentType: type, body: readFileSync(file), headers: { 'access-control-allow-origin': '*' } }));
  }
  await context.addInitScript((url) => {
    if (location.protocol !== 'http:') return;
    localStorage.setItem('pp:brokers', JSON.stringify(url));
    localStorage.setItem('pp:lang', '"en"');
  }, broker.url);
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultNavigationTimeout(120000);
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const from = m.location()?.url || '';
    if (from && !from.startsWith(`http://127.0.0.1:${port}/`)) outside.add(`${name}: ${m.text().slice(0, 120)}`);
    else errors.push(`${name}: ${m.text()}`);
  });
  await page.goto(base);
  await page.waitForSelector('#start-room', { timeout: 60000 });
  return { name, page, context };
}

async function waitFor(p, fn, arg, label, timeout = 45000) {
  try {
    await p.page.waitForFunction(fn, arg, { timeout, polling: 250 });
  } catch (err) {
    throw new Error(`${p.name}: ${label} (${err.message.split('\n')[0]})`);
  }
}

const ytState = (p) =>
  p.page.evaluate(() => {
    const pl = window.popcornpals.app.player;
    return { time: pl?.time ?? -1, playing: !!pl?.playing, rate: pl?.rate ?? 0, kind: pl?.kind };
  });

async function inStep(people, label, { playing, near, rate } = {}) {
  const deadline = Date.now() + 40000;
  let last = null;
  let good = 0;
  while (Date.now() < deadline) {
    const s = await Promise.all(people.map(ytState));
    const spread = Math.max(...s.map((x) => x.time)) - Math.min(...s.map((x) => x.time));
    const fine =
      spread <= TOLERANCE &&
      s.every((x) => x.kind === 'yt') &&
      (playing === undefined || s.every((x) => x.playing === playing)) &&
      (near === undefined || s.every((x) => Math.abs(x.time - near) < 3)) &&
      (rate === undefined || s.every((x) => x.rate === rate));
    last = s;
    good = fine ? good + 1 : 0;
    if (good >= 3) {
      log(`${label}: ${s.map((x) => `${x.time.toFixed(2)} s${x.playing ? ' playing' : ' paused'} at ${x.rate}x`).join(', ')}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`check failed: ${label}: ${JSON.stringify(last)}`);
}

const people = [];
try {
  const ana = await person('Ana');
  const bia = await person('Bia');
  people.push(ana, bia);
  log('two browsers with fresh profiles');

  await ana.page.fill('#name', 'Ana');
  await ana.page.click('#start-room');
  await ana.page.waitForSelector('.room');
  await ana.page.click('#invite');
  await ana.page.waitForFunction(() => (document.querySelector('.invite-words')?.dataset.words || '').split(' ').filter(Boolean).length === 6, null, { timeout: 45000 });
  const words = (await ana.page.getAttribute('.invite-words', 'data-words')).split(' ');
  await bia.page.fill('#name', 'Bia');
  await bia.page.click('#open-join');
  await bia.page.fill('#join-word-0', words.join(' '));
  await bia.page.waitForFunction(() => (document.querySelector('.confirm-words')?.dataset.words || '').split(' ').filter(Boolean).length === 6, null, { timeout: 45000 });
  const confirm = (await bia.page.getAttribute('.confirm-words', 'data-words')).split(' ');
  for (let i = 0; i < 6; i++) await ana.page.fill(`#confirm-word-${i}`, confirm[i]);
  await ana.page.click('#confirm-go');
  await bia.page.waitForSelector('.room', { timeout: 30000 });
  await ana.page.click('#invite-modal .modal-x').catch(() => {});
  log('Bia joined the room');

  await ana.page.fill('#yt-url', `https://www.youtube.com/watch?v=${VIDEO}`);
  await ana.page.click('.pick-card button[type="submit"]');
  for (const p of [ana, bia]) await waitFor(p, () => window.popcornpals.app.player?.kind === 'yt' && window.popcornpals.app.player.ready, null, 'the YouTube player is ready', 60000);
  log('both load the official embedded player');

  await ana.page.click('#play');
  await new Promise((r) => setTimeout(r, 4000));
  await inStep([ana, bia], 'Ana pressed play', { playing: true });

  await bia.page.click('#play');
  await inStep([ana, bia], 'Bia paused', { playing: false });

  await bia.page.locator('#scrub').fill('60');
  await inStep([ana, bia], 'Bia seeked to 60 s', { playing: false, near: 60 });

  await ana.page.selectOption('#rate', '1.5').catch(async () => ana.page.evaluate(() => window.popcornpals.actions.setRate(1.5)));
  await ana.page.click('#play');
  await new Promise((r) => setTimeout(r, 4000));
  await inStep([ana, bia], 'Ana resumed at 1.5x', { playing: true, rate: 1.5 });

  ok(errors.length === 0, `no console errors from the app:\n${errors.join('\n')}`);
  log(`no console errors from the app${outside.size ? ` (${outside.size} messages from the YouTube frames ignored)` : ''}`);
  console.log('youtube e2e passed');
} catch (err) {
  console.error(err.message);
  for (const p of people) await p.page.screenshot({ path: `.e2e/failure-yt-${p.name}.png` }).catch(() => {});
  if (errors.length) console.error(`console errors:\n${errors.join('\n')}`);
  process.exitCode = 1;
} finally {
  await Promise.all(people.map((p) => p.context.close().catch(() => {})));
  broker.close();
  server.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 200);
}
