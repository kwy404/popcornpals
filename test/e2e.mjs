// The watch party in a real browser. Four people, each in their own browser
// with a fresh profile and fake microphones:
//   Ana starts a room and invites Bia with six words (Bia reads back the six
//   confirmation words). Caio joins by the QR code and Dani by the copied
//   invite link: all three carry the same words to the same room.
//   Only Ana has the generated test video: she streams it, and Bia receives
//   its frames and its sound. Bia pauses, seeks and resumes, and Ana's player
//   follows. Ana adds subtitles and Bia sees them.
//   Both turn on voice and audio must flow both ways.
//   Best quality mode: Ana plays the file and Bia opens her own copy (a
//   different file is refused by the quick hash first). Caio joins late
//   through the QR link and catches up. Playback positions must stay within
//   0.5 s across play, pause, seek, resume and two people pressing at once.
//   Then the lock, chat with reactions, the queue and a shared screen.
// Pairing runs through a local MQTT over WebSocket broker (test/ws-broker.mjs);
// E2E_LIVE=1 uses the public relays instead. The site is served under
// /popcornpals/ the way GitHub Pages serves it.
//
// Usage: node test/e2e.mjs [browser path]

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import jsQR from 'jsqr';
import { serve } from '../scripts/serve.mjs';
import { ensureTestVideo } from '../scripts/make-test-video.mjs';
import { findBrowser, launchPerson } from './browser.mjs';
import { startBroker } from './ws-broker.mjs';

const TOLERANCE = 0.5;
const executablePath = findBrowser(process.argv[2]);
const live = process.env.E2E_LIVE === '1';
const shots = process.env.E2E_SHOTS || '';
if (shots) mkdirSync(shots, { recursive: true });

const port = 8700 + Math.floor(Math.random() * 200);
const server = await serve(port, 'docs', { base: '/popcornpals/' });
const broker = live ? null : await startBroker();
const base = `http://127.0.0.1:${port}/popcornpals/app/`;

let step = 0;
const log = (msg) => console.log(`${String(++step).padStart(2, '0')} ${msg}`);
const errors = [];
const ok = (cond, msg) => {
  if (!cond) throw new Error(`check failed: ${msg}`);
};

// The CDN files come from node_modules, so the test does not depend on the network.
const CDN = {
  'https://cdn.jsdelivr.net/npm/monsooncss@0.2.0/dist/monsoon.min.css': ['node_modules/monsooncss/dist/monsoon.min.css', 'text/css'],
  'https://cdn.jsdelivr.net/npm/voodoojs@1.0.0/dist/voodoo.full.min.js': ['node_modules/voodoojs/dist/voodoo.full.min.js', 'text/javascript'],
};

async function person(name) {
  const context = await launchPerson(chromium, { executablePath });
  for (const [url, [file, type]] of Object.entries(CDN)) {
    if (existsSync(file)) await context.route(url, (route) => route.fulfill({ status: 200, contentType: type, body: readFileSync(file), headers: { 'access-control-allow-origin': '*' } }));
  }
  // Settings for the app's origin; about:blank has no storage, so skip it there.
  await context.addInitScript((url) => {
    if (location.protocol !== 'http:') return;
    if (url) localStorage.setItem('pp:brokers', JSON.stringify(url));
    localStorage.setItem('pp:lang', '"en"');
  }, broker?.url || '');
  const page = context.pages()[0] || (await context.newPage());
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${name}: ${m.text()}`);
    if (process.env.E2E_VERBOSE) console.log(`[${name}] ${m.text()}`);
  });
  // Many programs share this machine, so loads get a generous timeout.
  page.setDefaultNavigationTimeout(120000);
  await page.goto(base);
  await page.waitForSelector('#start-room', { timeout: 60000 });
  return { name, page, context };
}

const evalApp = (p, fn, arg) => p.page.evaluate(fn, arg);
const shot = async (p, file) => shots && p.page.screenshot({ path: join(shots, file) });
const idOf = (p) => evalApp(p, () => window.popcornpals.app.room.self.id);

async function waitFor(p, fn, arg, timeout = 30000) {
  try {
    await p.page.waitForFunction(fn, arg, { timeout, polling: 200 });
  } catch (err) {
    throw new Error(`${p.name} waited in vain for: ${String(fn).replace(/\s+/g, ' ').slice(0, 220)} (${err.message.split('\n')[0]})`);
  }
}

async function wordsOf(p, selector) {
  const el = p.page.locator(selector);
  await el.waitFor({ timeout: 45000 });
  await p.page.waitForFunction((sel) => (document.querySelector(sel)?.dataset.words || '').split(' ').filter(Boolean).length === 6, selector, { timeout: 45000 });
  return (await el.getAttribute('data-words')).split(' ');
}

async function typeWords(page, prefix, words) {
  for (let i = 0; i < words.length; i++) await page.fill(`#${prefix}-${i}`, words[i]);
}

/** The QR code of the open invite, drawn on a canvas in the page and read back with jsQR here. */
async function readQr(p) {
  const side = 360;
  const px = await p.page.evaluate(async (n) => {
    const svg = document.querySelector('.invite-modal .qr-box svg');
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.outerHTML)}`;
    await img.decode();
    const canvas = Object.assign(document.createElement('canvas'), { width: n, height: n });
    const g = canvas.getContext('2d');
    g.drawImage(img, 0, 0, n, n);
    return Array.from(g.getImageData(0, 0, n, n).data);
  }, side);
  return jsQR(Uint8ClampedArray.from(px), side, side)?.data || null;
}

/**
 * The host invites and the guest joins in one of the three ways the invite
 * shows: typing the six words, scanning the QR code, or opening the copied
 * invite link. Then the host types the confirmation words.
 */
async function invite(host, guest, { via = 'words' } = {}) {
  await host.page.click('#invite');
  const words = await wordsOf(host, '.invite-words');
  ok((await host.page.locator('.invite-modal .qr-box svg').count()) === 1, 'the invite shows a QR code');
  await shot(host, `invite-${via}.png`);
  const link = await host.page.inputValue('#invite-link');
  ok(link === `${base}#join=${words.join('-')}`, `the invite link carries the six words in the hash (${link})`);
  const scanned = await readQr(host);
  ok(scanned === link, `the QR code holds the same invite link (${scanned})`);
  if (via === 'words') {
    await guest.page.fill('#name', guest.name);
    await guest.page.click('#open-join');
    // The whole phrase lands in the first box through an input event with no
    // paste event, the way phone keyboards insert the clipboard. It must
    // spread one word per box and join at once: the boxes are read the moment
    // the join starts, since the form then gives way to the waiting screen.
    await guest.page.evaluate(() => {
      const { actions } = window.popcornpals;
      const join = actions.joinRoom;
      actions.joinRoom = () => {
        window.__boxes = [...document.querySelectorAll('.join-card .word-field')].map((x) => x.value);
        actions.joinRoom = join;
        join();
      };
    });
    await guest.page.fill('#join-word-0', words.join(' '));
    const boxes = await guest.page.evaluate(() => window.__boxes);
    ok(JSON.stringify(boxes) === JSON.stringify(words), `the phrase spreads one word per box and joins (${JSON.stringify(boxes)})`);
    await waitFor(guest, () => window.popcornpals.S.join.stage !== 'type');
  } else {
    let url = scanned;
    if (via === 'link') {
      await host.page.click('#copy-link');
      await host.page.waitForSelector('#copy-link.is-copied');
      url = await host.page.evaluate(() => navigator.clipboard.readText());
      ok(url === link, 'Copy puts the invite link on the clipboard');
    }
    // A guest who opens the link joins at once, nothing to type or press.
    // The scanned QR opens in the app already on screen (a hash change); the
    // copied link opens in a fresh page load.
    if (via === 'qr') {
      await guest.page.fill('#name', guest.name);
    } else {
      await guest.page.evaluate((name) => localStorage.setItem('pp:name', JSON.stringify(name)), guest.name);
      await guest.page.goto('about:blank');
    }
    await guest.page.goto(url);
    await waitFor(guest, () => ['connecting', 'confirm'].includes(window.popcornpals.S.join.stage) || window.popcornpals.S.view === 'room');
    ok(!(await guest.page.evaluate(() => location.hash)), 'the words are cleared from the address bar');
  }
  const confirm = await wordsOf(guest, '.confirm-words');
  await host.page.waitForSelector('#confirm-word-0', { timeout: 30000 });
  await typeWords(host.page, 'confirm-word', confirm);
  await host.page.click('#confirm-go');
  await guest.page.waitForSelector('.room', { timeout: 30000 });
  await host.page.waitForSelector('.invite-modal .invite-wait .ok', { timeout: 15000 });
  if (await host.page.locator('#invite-modal[open] .modal-x').isVisible()) await host.page.click('#invite-modal .modal-x');
  await host.page.waitForFunction(() => !document.querySelector('#invite-modal[open]'));
  return words;
}

async function audioIn(p, peerId) {
  return evalApp(
    p,
    async (id) => {
      const link = window.popcornpals.app.room.mesh.links.get(id);
      return link ? (await link.stats()).audioIn : -1;
    },
    peerId,
  );
}

async function audioFlows(p, peerId, label) {
  // A new track needs a renegotiation first, so give it a few seconds to start.
  const deadline = Date.now() + 15000;
  let a = await audioIn(p, peerId);
  let b = a;
  while (Date.now() < deadline) {
    await p.page.waitForTimeout(1000);
    b = await audioIn(p, peerId);
    if (a > 0 && b > a) break;
    a = b;
  }
  ok(a > 0 && b > a, `${label}: voice bytes arrive (${a} then ${b})`);
}

async function pick(p, buttonSelector, file) {
  const [chooser] = await Promise.all([p.page.waitForEvent('filechooser'), p.page.click(buttonSelector)]);
  await chooser.setFiles(file);
}

/** Frames decoded and audio bytes received for the stream someone sends to this page. */
async function streamStats(p) {
  return evalApp(p, async () => {
    const { app } = window.popcornpals;
    const src = app.room.state.src;
    const link = app.room.mesh.links.get(src.id);
    const v = document.getElementById('screen-video');
    const tracks = v.srcObject ? v.srcObject.getTracks() : [];
    const out = { frames: 0, audio: 0, tracks: tracks.map((x) => x.kind).sort().join(',') };
    for (const r of link.pc.getReceivers()) {
      if (!tracks.includes(r.track)) continue;
      (await r.getStats()).forEach((x) => {
        if (x.type !== 'inbound-rtp') return;
        if (x.kind === 'video') out.frames += x.framesDecoded || 0;
        else out.audio += x.bytesReceived || 0;
      });
    }
    return out;
  });
}

const hostVideo = (p) => evalApp(p, () => {
  const v = document.getElementById('file-video');
  return { pos: v.currentTime, paused: v.paused };
});

/** Where every video is, brought to the same instant (all pages share this machine's clock). */
async function positions(people) {
  const samples = await Promise.all(
    people.map((p) =>
      evalApp(p, () => {
        const v = document.getElementById('file-video');
        return { pos: v.currentTime, at: Date.now(), playing: !v.paused, rate: v.playbackRate };
      }),
    ),
  );
  const t = Math.max(...samples.map((s) => s.at));
  return samples.map((s) => ({ ...s, now: s.pos + (s.playing ? ((t - s.at) / 1000) * s.rate : 0) }));
}

async function inSync(people, label, { playing, near } = {}) {
  // Give the sync loop a moment, then demand the tolerance on several samples in a row.
  const deadline = Date.now() + 12000;
  let last = null;
  let good = 0;
  while (Date.now() < deadline) {
    const s = await positions(people);
    const spread = Math.max(...s.map((x) => x.now)) - Math.min(...s.map((x) => x.now));
    const stateOk = playing === undefined || s.every((x) => x.playing === playing);
    const nearOk = near === undefined || s.every((x) => Math.abs(x.now - near) < 1.5);
    last = { spread, s };
    good = spread <= TOLERANCE && stateOk && nearOk ? good + 1 : 0;
    if (good >= 4) {
      log(`${label}: positions ${s.map((x) => x.now.toFixed(2)).join(', ')} (spread ${spread.toFixed(3)} s)`);
      return spread;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`check failed: ${label}: not in sync: ${JSON.stringify(last)}`);
}

const people = [];
try {
  const ana = await person('Ana');
  const bia = await person('Bia');
  const caio = await person('Caio');
  people.push(ana, bia, caio);
  log(`three browsers with fresh profiles, pairing through ${broker ? 'a local relay' : 'the public relays'}`);

  // Two minutes, so a slow machine never reaches the end in the middle of a check.
  const video = resolve(await ensureTestVideo(ana.context, base, '.e2e/countdown-120.webm', { width: 320, height: 180, fps: 15, seconds: 120 }));
  const other = resolve('.e2e/other.webm');
  if (!existsSync(other)) writeFileSync(other, randomBytes(64 * 1024));
  log('test video ready (120 s, VP8 and Opus in WebM)');
  const subtitles = resolve('.e2e/lines.vtt');
  const cues = Array.from({ length: 20 }, (_, i) => `${String(Math.floor((i * 2) / 60)).padStart(2, '0')}:${String((i * 2) % 60).padStart(2, '0')}.000 --> ${String(Math.floor((i * 2 + 2) / 60)).padStart(2, '0')}:${String((i * 2 + 2) % 60).padStart(2, '0')}.000\nLine ${i + 1}`);
  writeFileSync(subtitles, `WEBVTT\n\n${cues.join('\n\n')}\n`);

  // A room and the first guest
  await ana.page.fill('#name', 'Ana');
  await ana.page.click('#start-room');
  await ana.page.waitForSelector('.room');
  await shot(ana, 'room-empty.png');
  await invite(ana, bia);
  await waitFor(ana, () => document.querySelector('#room-count')?.dataset.count === '2');
  await waitFor(bia, () => document.querySelector('#room-count')?.dataset.count === '2');
  log('Bia pasted the six words into one box, they spread one per box and joined; Ana typed the six confirmation words');

  const ids = { ana: await idOf(ana), bia: await idOf(bia) };

  // One person picks the file, everyone watches
  await pick(ana, '#pick-file', video);
  await waitFor(ana, () => window.popcornpals.S.media.mineStream && document.getElementById('file-video').readyState >= 1);
  await ana.page.click('#play');
  await waitFor(bia, () => {
    const v = document.getElementById('screen-video');
    return window.popcornpals.S.media.kind === 'file' && v.srcObject && v.videoWidth > 0 && !v.paused;
  });
  ok(!(await bia.page.locator('#need-pick').count()), 'Bia is not asked for the file');
  const s1 = await streamStats(bia);
  await bia.page.waitForTimeout(1500);
  const s2 = await streamStats(bia);
  ok(s1.tracks === 'audio,video', `the stream carries picture and sound (${s1.tracks})`);
  ok(s2.frames > s1.frames, `Bia decodes the streamed frames (${s1.frames} then ${s2.frames})`);
  ok(s2.audio > s1.audio, `Bia receives the film's sound (${s1.audio} then ${s2.audio} bytes)`);
  log(`only Ana has the file: Bia decodes its frames (${s2.frames - s1.frames} in 1.5 s) and its sound`);
  await waitFor(ana, () => !!window.popcornpals.S.media.quality);
  await waitFor(bia, () => !!window.popcornpals.S.media.quality);
  log(`quality shown to both: ${await evalApp(bia, () => window.popcornpals.S.media.quality)}`);

  await bia.page.click('#play');
  await waitFor(ana, () => document.getElementById('file-video').paused);
  log('Bia paused the stream and Ana\'s player paused');
  await bia.page.locator('#scrub').fill('15');
  await waitFor(ana, () => Math.abs(document.getElementById('file-video').currentTime - 15) < 0.5);
  log(`Bia seeked to 15 s and Ana's player is at ${(await hostVideo(ana)).pos.toFixed(2)} s`);
  await bia.page.click('#play');
  await waitFor(ana, () => !document.getElementById('file-video').paused);
  log('Bia resumed and Ana\'s player plays again');

  const [chooser] = await Promise.all([ana.page.waitForEvent('filechooser'), ana.page.click('#subs')]);
  await chooser.setFiles(subtitles);
  await waitFor(bia, () => /Line \d+/.test(document.getElementById('captions')?.textContent || '') && getComputedStyle(document.getElementById('captions')).display !== 'none');
  log(`subtitles from Ana show for Bia: "${(await bia.page.textContent('#captions')).trim()}"`);
  await shot(bia, 'stream-guest.png');
  await ana.page.click('.ctl-btn[aria-label="Stop and choose something else"]');
  await waitFor(bia, () => !window.popcornpals.S.media.kind);

  // Voice
  await ana.page.click('#mic');
  await bia.page.click('#mic');
  await waitFor(ana, () => window.popcornpals.S.voice.on);
  await waitFor(bia, () => window.popcornpals.S.voice.on);
  await audioFlows(ana, ids.bia, 'Ana hears Bia');
  await audioFlows(bia, ids.ana, 'Bia hears Ana');
  log('voice tracks flow both ways');
  ok(await evalApp(ana, () => window.popcornpals.app.media.processing === 'strong'), 'the microphone runs through the strong noise suppression by default');
  log('noise suppression: browser constraints plus the DSP worklet, on by default');

  // Camera seats under the screen
  await bia.page.click('#camera');
  await waitFor(ana, (id) => {
    const v = document.querySelector(`#seats .seat[data-peer="${id}"] video`);
    return v && v.videoWidth > 0 && !v.paused;
  }, ids.bia);
  ok((await ana.page.textContent(`#seats .seat[data-peer="${ids.bia}"] figcaption`)).includes('Bia'), 'the seat shows the name');
  await bia.page.click('#camera');
  await waitFor(ana, (id) => !document.querySelector(`#seats .seat[data-peer="${id}"]`), ids.bia);
  log('a camera shows as a seat under the screen for the others, and goes away when turned off');

  // Best quality mode: everyone opens the same file
  await pick(ana, '#pick-local', video);
  await waitFor(ana, () => window.popcornpals.S.media.kind === 'file' && document.getElementById('file-video').readyState >= 1);
  await bia.page.waitForSelector('#need-pick');
  ok((await bia.page.textContent('#need-name')).includes('countdown-120.webm'), 'Bia is asked for the same file by name');
  await pick(bia, '#need-pick', other);
  await waitFor(bia, () => window.popcornpals.S.media.needs === 'mismatch');
  log('a different file is refused by the quick hash');
  await pick(bia, '#need-pick', video);
  await waitFor(bia, () => window.popcornpals.S.media.needs === 'nothing' && document.getElementById('file-video').readyState >= 1);
  log('Bia picked the same file and it matched');

  // Play
  await ana.page.click('#play');
  await ana.page.waitForTimeout(2500);
  await inSync([ana, bia], 'playing', { playing: true });

  // The movie gets quieter while someone talks (Bia's fake microphone beeps)
  await evalApp(bia, () => window.popcornpals.actions.setNoise('off'));
  await waitFor(ana, () => document.getElementById('file-video').volume < 0.9, null, 45000);
  log(`the movie is lowered while Bia talks (volume ${(await evalApp(ana, () => document.getElementById('file-video').volume)).toFixed(2)})`);

  // A late joiner through the QR link
  await invite(ana, caio, { via: 'qr' });
  await waitFor(ana, () => document.querySelector('#room-count')?.dataset.count === '3');
  ids.caio = await idOf(caio);
  await caio.page.waitForSelector('#need-pick');
  await pick(caio, '#need-pick', video);
  await waitFor(caio, () => !document.getElementById('file-video').paused);
  await inSync([ana, bia, caio], 'late joiner caught up', { playing: true });
  await shot(caio, 'late-joiner.png');

  // Pause from a guest
  await bia.page.click('#play');
  await inSync([ana, bia, caio], 'paused by Bia', { playing: false });

  // Seek from another guest
  await caio.page.locator('#scrub').fill('20');
  await inSync([ana, bia, caio], 'seeked by Caio to 20 s', { playing: false, near: 20 });

  // Resume
  await ana.page.click('#play');
  await ana.page.waitForTimeout(2000);
  await inSync([ana, bia, caio], 'resumed by Ana', { playing: true });

  // Two people press pause at the same moment
  await Promise.all([ana.page.click('#play'), bia.page.click('#play')]);
  await ana.page.waitForTimeout(800);
  await inSync([ana, bia, caio], 'two pauses at once', { playing: false });
  // ... and two plays at the same moment
  await Promise.all([bia.page.click('#play'), caio.page.click('#play')]);
  await ana.page.waitForTimeout(2000);
  await inSync([ana, bia, caio], 'two plays at once', { playing: true });
  await shot(ana, 'playing.png');

  // The lock
  await ana.page.click('#lock');
  await waitFor(bia, () => document.getElementById('play').disabled);
  const seqBefore = await evalApp(ana, () => window.popcornpals.app.room.state.seq);
  await evalApp(bia, () => window.popcornpals.actions.togglePlay());
  await bia.page.waitForTimeout(800);
  ok((await evalApp(ana, () => window.popcornpals.app.room.state.seq)) === seqBefore, 'a locked room ignores a guest pause');
  await inSync([ana, bia, caio], 'still playing while locked', { playing: true });
  await ana.page.click('#lock');
  await waitFor(bia, () => !document.getElementById('play').disabled);
  log('the host lock refuses control from guests and unlocks again');

  // Chat and reactions
  await bia.page.fill('#chat-input', 'Popcorn is ready');
  await bia.page.press('#chat-input', 'Enter');
  for (const p of [ana, caio]) await p.page.waitForSelector('.chat-msg >> text=Popcorn is ready');
  await caio.page.locator('.chat-msg').first().hover();
  await caio.page.click('.chat-msg .react-add button[aria-label="React with Love it"]');
  await ana.page.waitForSelector('.chat-msg .chip-react[aria-label="Love it 1"]');
  log('chat message delivered to everyone, a reaction counted');

  // A reply with a video time in it
  await ana.page.locator('.chat-msg').first().hover();
  await ana.page.click('.chat-msg .reply-btn');
  await ana.page.fill('#chat-input', 'agreed, see 0:10');
  await ana.page.press('#chat-input', 'Enter');
  await bia.page.waitForSelector('.chat-msg .chat-quote >> text=Popcorn is ready');
  await bia.page.waitForSelector('.chat-msg .vt-chip');
  await bia.page.click('.chat-msg .time-link >> text=0:10');
  await waitFor(ana, () => {
    const at = document.getElementById('file-video').currentTime;
    return at > 9.5 && at < 13;
  });
  await inSync([ana, bia, caio], 'jumped to a time written in the chat', { playing: true });
  log('a reply quotes the message, and a time in a message moves everyone there');

  // The shared queue
  await caio.page.click('#tab-queue');
  await caio.page.fill('#queue-url', 'https://youtu.be/dQw4w9WgXcQ');
  await caio.page.click('#queue-add');
  for (const p of [ana, bia, caio]) await waitFor(p, () => window.popcornpals.S.queue.length === 1);
  log('a YouTube link added to the shared queue shows for everyone');

  // Who is watching
  await ana.page.click('#tab-people');
  await waitFor(ana, () => document.querySelectorAll('#people-list .person').length === 3);
  const names = await ana.page.$$eval('#people-list .p-name', (els) => els.map((e) => e.textContent));
  ok(names.some((n) => n.includes('Caio')) && names.some((n) => n.includes('Host')), 'the people list shows everyone and the host');
  log('who is watching: three people, Ana marked as host');

  // Caio's voice reaches the others too
  await caio.page.click('#mic');
  await waitFor(caio, () => window.popcornpals.S.voice.on);
  await audioFlows(ana, ids.caio, 'Ana hears Caio');
  await audioFlows(caio, ids.bia, 'Caio hears Bia');
  log('a late joiner talks and hears');

  // Mute: the track goes silent and the others see it
  await bia.page.click('#mic');
  await waitFor(bia, () => window.popcornpals.S.voice.muted && !window.popcornpals.app.media.mic.track.enabled);
  await waitFor(ana, (id) => window.popcornpals.S.people.find((x) => x.id === id)?.muted === true, ids.bia);
  await bia.page.click('#mic');
  await waitFor(ana, (id) => window.popcornpals.S.people.find((x) => x.id === id)?.muted === false, ids.bia);
  log('mute silences the microphone and shows as muted for the others, then unmutes');

  // Device pickers: switch Ana's microphone while she is talking
  await evalApp(ana, () => window.popcornpals.actions.openSettings());
  await waitFor(ana, () => document.querySelectorAll('#dev-mic option').length > 1 && document.querySelectorAll('#dev-cam option').length > 1);
  const mics = await ana.page.$$eval('#dev-mic option', (els) => els.map((e) => e.value).filter(Boolean));
  const pickMic = mics[mics.length - 1];
  await ana.page.selectOption('#dev-mic', pickMic);
  await waitFor(ana, (id) => window.popcornpals.app.media.mic?.raw.getAudioTracks()[0].getSettings().deviceId === id, pickMic);
  await audioFlows(bia, ids.ana, 'Bia still hears Ana on the other microphone');
  await shot(ana, 'settings-devices.png');
  await ana.page.click('#settings-modal .modal-x');
  log(`the microphone picker lists ${mics.length} inputs and switches a live microphone without dropping the call`);

  // Screen share
  await ana.page.click('.ctl-btn[aria-label="Stop and choose something else"]');
  await waitFor(bia, () => !window.popcornpals.S.media.kind);
  await ana.page.click('.pick-card button:has-text("Share my screen")');
  await ana.page.click('#share-go');
  await waitFor(bia, () => {
    const v = document.getElementById('screen-video');
    return window.popcornpals.S.media.kind === 'screen' && v.srcObject && v.videoWidth > 0;
  });
  log('a shared screen reaches the others');

  await shot(bia, 'screen.png');

  // A fourth friend opens the copied invite link and lands in the same room
  const dani = await person('Dani');
  people.push(dani);
  await invite(ana, dani, { via: 'link' });
  for (const p of [ana, bia, caio, dani]) await waitFor(p, () => document.querySelector('#room-count')?.dataset.count === '4');
  ok((await evalApp(dani, () => window.popcornpals.app.room.mesh.room.id)) === (await evalApp(ana, () => window.popcornpals.app.room.mesh.room.id)), 'the link leads to the same room');
  log('the words (Bia), the QR code (Caio) and the copied link (Dani) all reach the same room');
  ok(errors.length === 0, `no console errors:\n${errors.join('\n')}`);
  log('no console errors');
  console.log('e2e passed');
} catch (err) {
  console.error(err.message);
  mkdirSync('.e2e/failure', { recursive: true });
  for (const p of people) await p.page.screenshot({ path: `.e2e/failure/${p.name}.png` }).catch(() => {});
  console.error('screenshots in .e2e/failure/');
  for (const p of people) {
    const links = await p.page
      .evaluate(() =>
        [...(window.popcornpals.app.room?.mesh.links || [])].map(([id, l]) => ({
          id,
          state: l.pc.signalingState,
          conn: l.pc.connectionState,
          polite: l.polite,
          local: l.localMedia,
          remote: l.remoteMedia,
          tx: l.pc.getTransceivers().map((x) => `${x.mid}:${x.direction}/${x.currentDirection}:${x.sender.track?.kind || '-'}:${x.receiver.track?.kind}`),
        })),
      )
      .catch((e) => e.message);
    console.error(p.name, JSON.stringify(links, null, 1));
  }
  if (errors.length) console.error(`console errors:\n${errors.join('\n')}`);
  process.exitCode = 1;
} finally {
  await Promise.all(people.map((p) => p.context.close().catch(() => {})));
  broker?.close();
  server.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 200);
}
