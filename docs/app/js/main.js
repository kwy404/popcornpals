// The popcornpals app. The page markup is plain HTML with Voodoo.js
// directives that read one reactive store, S. This module owns the store,
// the room, the players, voice and screen share, and the sync loop that keeps
// this screen on the room's clock.

import { translate, pickLang } from './i18n.js';
import { Room } from './room.js';
import { FilePlayer, ScreenView, YouTubePlayer } from './players.js';
import { Media } from './media.js';
import { wireWordInputs } from './words-ui.js';
import { CodeCreator, CodeJoiner } from '../core/pairing.js';
import { DEFAULT_BROKERS } from '../core/relay.js';
import { MAX_MEMBERS } from '../core/mesh.js';
import { STUN_SERVERS, buildIceServers, parseTurn } from '../core/rtc.js';
import { probeAll } from '../core/stun.js';
import { correction, hasEnded, positionAt, joinView, pressIntent } from '../core/sync.js';
import { message as extMessage, readMessage as readExtMessage, stateForPlayer } from '../core/extsync.js';
import { cueText, parseSubtitles } from '../core/subtitles.js';
import { qualityText, streamQuality } from '../core/quality.js';
import { parseYouTube } from '../core/youtube.js';
import { quickHash, formatSize } from '../core/filehash.js';
import { REACTIONS, formatTime, splitTimes } from '../core/chat.js';
import { NOISE_MODES, duckStep } from '../core/voice.js';
import { cleanName, colorFor, initials } from '../core/people.js';
import { randomId } from '../core/crypto.js';
import { WORDLIST } from '../core/wordlist.js';
import { WORD_COUNT, resolvePhrase, wordsFromLink, wordsLink } from '../core/words.js';
import { encodeQR, qrSvg } from '../core/qr.js';
import { VERSION } from '../core/version.js';

// Storage

const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(`pp:${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      if (value == null) localStorage.removeItem(`pp:${key}`);
      else localStorage.setItem(`pp:${key}`, JSON.stringify(value));
    } catch {
      // private mode: settings last for this visit only
    }
  },
};

const myId = store.get('id') || randomId(8);
store.set('id', myId);

// App state that is not for the page

const app = {
  room: null,
  player: null,
  playerKey: null,
  screen: null,
  media: null,
  file: null, // { file, hash } this device picked for the current source
  files: new Map(), // hash -> File picked on this device (queue items too)
  creator: null,
  joiner: null,
  invite: null,
  heldPeer: null,
  fileMode: 'play',
  lastStatus: 0,
  blocked: false,
  loadingYt: null,
  ytLast: null,
  streaming: false,
  quality: null,
  subs: null,
  pendingSubs: null,
  pendingMovies: new Map(),
  pendingScreens: new Map(),
  cameras: new Map(), // peerId -> camera stream
  duck: { gain: 1, lastTalk: -Infinity },
};

const $ = (id) => document.getElementById(id);
const fmtTime = (s) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};

function brokers() {
  const list = String(store.get('brokers', '') || '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => /^wss?:\/\//.test(s));
  return list.length ? list : DEFAULT_BROKERS;
}

function iceServers() {
  const turn = store.get('turn', null);
  let custom = [];
  try {
    if (turn) custom = [parseTurn(turn)];
  } catch {
    custom = [];
  }
  return buildIceServers({ custom });
}

function appUrl() {
  return location.href.split('#')[0].split('?')[0];
}

// The store

function blankWords() {
  return Array.from({ length: WORD_COUNT }, () => '');
}

const initial = {
  version: VERSION,
  view: 'lobby',
  lang: pickLang(store.get('lang'), navigator.languages || [navigator.language]),
  name: store.get('name', ''),
  busy: false,
  reactions: [...REACTIONS],
  join: { stage: 'type', words: blankWords(), error: '', relays: '', confirm: [], hostName: '', invited: false },
  room: { count: 1, max: MAX_MEMBERS, isHost: false, hostName: '', lock: false, canControl: true },
  people: [],
  media: blankMedia(),
  queue: [],
  chat: [],
  unread: 0,
  draft: '',
  tab: 'chat',
  voice: { on: false, muted: false, error: '', camera: false, noise: NOISE_MODES.includes(store.get('noise')) ? store.get('noise') : 'strong', duck: store.get('duck', true) !== false, processing: '' },
  replyTo: null,
  invite: { open: false, stage: 'making', words: [], qr: '', link: '', copied: false, name: '', error: '', relays: '', typed: blankWords(), wrong: false },
  devices: { mic: [], cam: [], out: [], micId: store.get('micId', ''), camId: store.get('camId', ''), outId: store.get('outId', ''), canOutput: typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype, unnamed: false },
  share: { open: false },
  settings: { open: false, stun: STUN_SERVERS.map((url) => ({ url, ok: null })), turnUrls: '', turnUser: '', turnPass: '', turnError: '', turnSaved: false, brokers: '' },
  add: { yt: '', queue: '', error: '', queueError: '' },
  ext: { open: false, installed: false, version: '', found: false, site: '', seekable: true, playing: false, pos: 0, at: 0 },
  toasts: [],
};

function blankMedia() {
  return { mode: '', streamer: '', mineStream: false, subs: false, showSubs: true, caption: '', quality: '', qualityLevel: '', kind: null, title: '', playing: false, duration: 0, rate: 1, scrub: 0, dragging: false, posText: '0:00', durText: '0:00', needs: 'nothing', fileName: '', fileSize: '', byName: '', mine: false, error: '', syncLevel: 'ok', syncText: '' };
}

let S;
const t = (key, vars) => translate(S ? S.lang : 'en', key, vars);

function toast(text, kind = 'info', ms = 3800) {
  const id = randomId(4);
  S.toasts.push({ id, text, kind });
  setTimeout(() => {
    const i = S.toasts.findIndex((x) => x.id === id);
    if (i >= 0) S.toasts.splice(i, 1);
  }, ms);
}

const actions = {
  setLang(lang) {
    S.lang = lang === 'pt' ? 'pt' : 'en';
    store.set('lang', S.lang);
    document.documentElement.lang = S.lang === 'pt' ? 'pt-BR' : 'en';
    renderAll();
  },

  // Lobby
  startRoom() {
    S.name = cleanName(S.name, S.lang === 'pt' ? 'Anfitrião' : 'Host');
    store.set('name', S.name);
    enterRoom(new Room({ self: { id: myId, name: S.name }, roomId: randomId(8), host: true, iceServers }));
  },
  openJoin(words) {
    S.view = 'join';
    Object.assign(S.join, { stage: 'type', error: '', relays: '', confirm: [], invited: !!words });
    S.join.words.splice(0, WORD_COUNT, ...(words || blankWords()).slice(0, WORD_COUNT));
    setTimeout(() => (words ? $('join-go') : $('join-word-0'))?.focus(), 60);
  },
  cancelJoin() {
    stopJoiner();
    if (app.room && S.view !== 'room') {
      app.room.leave();
      app.room = null;
    }
    S.view = 'lobby';
  },
  joinRoom() {
    const res = resolvePhrase(S.join.words.map((w) => w || ''));
    if (!res.ok) {
      S.join.error = t('join.incomplete');
      return;
    }
    S.join.words.splice(0, WORD_COUNT, ...res.words);
    S.name = cleanName(S.name);
    store.set('name', S.name);
    startJoin(res.words);
  },

  // Invites
  openInvite: () => openInvite(),
  closeInvite: () => closeInvite(),
  async copyInviteLink() {
    const link = S.invite.link;
    if (!link) return;
    let done = false;
    try {
      await navigator.clipboard.writeText(link);
      done = true;
    } catch {
      // No clipboard permission: fall back to selecting the field.
      const field = $('invite-link');
      field?.focus();
      field?.select();
      try {
        done = document.execCommand('copy');
      } catch {
        done = false;
      }
    }
    if (!done) return toast(t('invite.copyFail'), 'warn');
    S.invite.copied = true;
    clearTimeout(app.copiedTimer);
    app.copiedTimer = setTimeout(() => (S.invite.copied = false), 2200);
  },
  confirmInvite() {
    const res = resolvePhrase(S.invite.typed.map((w) => w || ''));
    if (!res.ok) {
      S.invite.error = t('join.incomplete');
      return;
    }
    const r = app.room?.confirmHeld(app.heldPeer, res.words);
    if (r === 'ok') {
      S.invite.stage = 'joined';
      S.invite.error = '';
    } else if (r === 'refused') {
      S.invite.stage = 'refused';
      S.invite.error = t('invite.refused', { name: S.invite.name });
    } else {
      S.invite.wrong = true;
      S.invite.error = t('invite.wrong', { name: S.invite.name, left: r?.left ?? 0 });
      setTimeout(() => (S.invite.wrong = false), 600);
    }
  },

  leave() {
    leaveRoom();
    toast(t('room.left'));
  },

  // Sources
  addYouTube(where) {
    const field = where === 'queue' ? 'queue' : 'yt';
    const errKey = where === 'queue' ? 'queueError' : 'error';
    const yt = parseYouTube(S.add[field]);
    if (!yt) {
      S.add[errKey] = t('pick.badLink');
      return;
    }
    S.add[errKey] = '';
    S.add[field] = '';
    const src = { kind: 'yt', id: yt.id, title: `YouTube ${yt.id}` };
    if (where === 'queue') {
      app.room.intent('queue-add', { item: { id: randomId(6), src } });
      toast(t('queue.added'));
    } else app.room.intent('load', { src, pos: yt.start });
  },
  pickFile(mode) {
    app.fileMode = mode;
    const input = $(mode === 'subs' ? 'subs-input' : 'file-input');
    input.value = '';
    input.click();
  },
  subsButton() {
    if (S.media.subs) S.media.showSubs = !S.media.showSubs;
    else actions.pickFile('subs');
  },
  openExt() {
    S.ext.open = true;
    window.postMessage({ ppExt: 'ping' }, location.origin);
  },
  startExt() {
    S.ext.open = false;
    app.room.intent('load', { src: { kind: 'ext', id: randomId(6), title: t('ext.title') } });
  },
  shareScreen: () => shareScreen(),
  stopShare() {
    app.media?.stopScreen();
  },
  unload() {
    app.room.intent('unload');
  },
  unblock() {
    app.blocked = false;
    app.media?.resume();
    app.player?.play?.()?.catch?.(() => (app.blocked = true));
    app.screen?.video.play().catch(() => {});
    S.media.needs = 'nothing';
  },

  // Controls
  togglePlay() {
    const st = app.room?.state;
    if (!st?.src) return;
    const { action, base } = pressIntent(st, app.flip, Date.now());
    app.room.intent(action, { base });
  },
  seekTo(v) {
    S.media.dragging = false;
    const pos = Number(v);
    if (Number.isFinite(pos)) app.room.intent('seek', { pos });
  },
  seekBy(d) {
    app.room.intent('seek', { pos: Math.max(0, app.room.expected() + d) });
  },
  scrubbing(v) {
    S.media.dragging = true;
    S.media.posText = fmtTime(Number(v));
  },
  setRate(v) {
    app.room.intent('rate', { rate: Number(v) });
  },
  toggleLock() {
    app.room.intent('lock', { lock: !app.room.state.lock });
  },
  next() {
    app.room.intent('next', { autoplay: true });
  },
  playItem(id) {
    const item = app.room.state.queue.find((q) => q.id === id);
    if (item) app.room.intent('load', { src: item.src, itemId: id });
  },
  moveItem(id, to) {
    app.room.intent('queue-move', { itemId: id, to });
  },
  removeItem(id) {
    app.room.intent('queue-remove', { itemId: id });
  },
  fullscreen() {
    const el = document.querySelector('.screen-frame');
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el?.requestFullscreen?.().catch(() => {});
  },

  // Social
  setTab(tab) {
    S.tab = tab;
    if (tab === 'chat') {
      S.unread = 0;
      scrollChat();
    }
  },
  sendChat() {
    const room = app.room;
    const src = room?.state?.src;
    // The message remembers where the video was, so everyone can jump there.
    const vt = src && src.kind !== 'screen' ? positionAt(room.state, room.hostNow()) : null;
    if (room?.sendChat(S.draft, { re: S.replyTo?.id || null, vt })) {
      S.draft = '';
      S.replyTo = null;
    }
  },
  startReply(id) {
    const m = app.room?.chat.find((x) => x.id === id);
    if (!m) return;
    S.replyTo = { id, name: nameOf(m.from), text: m.text.slice(0, 80) };
    setTimeout(() => $('chat-input')?.focus(), 30);
  },
  cancelReply() {
    S.replyTo = null;
  },
  seekToTime(sec) {
    const room = app.room;
    const src = room?.state?.src;
    if (!src || src.kind === 'screen') return toast(t('chat.noVideo'), 'warn');
    if (!room.canControl) return toast(t('lock.locked'), 'warn');
    room.intent('seek', { pos: Number(sec) });
  },
  async toggleCamera() {
    const m = app.media;
    if (!m) return;
    try {
      if (m.cameraOn) m.stopCamera();
      else await m.startCamera();
    } catch {
      toast(t('camera.denied'), 'warn');
    }
    renderSeats();
    renderVoice();
  },
  async setNoise(mode) {
    if (!NOISE_MODES.includes(mode)) return;
    S.voice.noise = mode;
    store.set('noise', mode);
    if (app.media) await app.media.setNoiseMode(mode).catch(() => toast(t('voice.denied'), 'warn'));
    renderVoice();
  },
  setDuck(on) {
    S.voice.duck = !!on;
    store.set('duck', S.voice.duck);
  },
  react(id, r) {
    app.room?.react(id, r);
  },
  burst(r) {
    app.room?.burst(r);
  },
  async toggleMic() {
    const m = app.media;
    if (!m) return;
    S.voice.error = '';
    try {
      if (!m.micOn) await m.startMic();
      else m.setMuted(!m.muted);
    } catch {
      S.voice.error = t('voice.denied');
      toast(t('voice.denied'), 'warn');
    }
    renderVoice();
  },

  // Settings
  openSettings() {
    S.settings.open = true;
    const turn = store.get('turn', null);
    Object.assign(S.settings, { turnUrls: turn ? [].concat(turn.urls).join(' ') : '', turnUser: turn?.username || '', turnPass: turn?.credential || '', turnError: '', turnSaved: false, brokers: String(store.get('brokers', '') || '') });
    checkStun();
    refreshDevices();
  },
  async setDevice(kind, id) {
    const key = { mic: 'micId', cam: 'camId', out: 'outId' }[kind];
    if (!key) return;
    S.devices[key] = String(id || '');
    store.set(key, S.devices[key]);
    const m = app.media;
    if (!m) return;
    try {
      if (kind === 'mic') await m.setMicDevice(S.devices.micId);
      else if (kind === 'cam') await m.setCameraDevice(S.devices.camId);
      else await m.setOutput(S.devices.outId, stageMedia());
    } catch {
      toast(t(kind === 'cam' ? 'camera.denied' : 'voice.denied'), 'warn');
    }
    renderVoice();
    renderSeats();
  },
  saveTurn() {
    S.settings.turnSaved = false;
    try {
      const turn = parseTurn({ urls: S.settings.turnUrls, username: S.settings.turnUser, credential: S.settings.turnPass });
      store.set('turn', turn);
      S.settings.turnError = '';
      S.settings.turnSaved = true;
    } catch (e) {
      S.settings.turnError = e.message;
    }
  },
  clearTurn() {
    store.set('turn', null);
    Object.assign(S.settings, { turnUrls: '', turnUser: '', turnPass: '', turnError: '', turnSaved: false });
  },
  saveBrokers() {
    store.set('brokers', S.settings.brokers.trim() || null);
    toast(t('settings.saved'));
  },
};

/** The video elements on the stage, so their sound follows the chosen speakers. */
function stageMedia() {
  return [$('file-video'), $('screen-video')].filter(Boolean);
}

/** List the microphones, cameras and speakers for the pickers in the settings. */
async function refreshDevices() {
  const list = await Media.devices();
  const named = (kind, prefix) =>
    list[kind]
      .filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `${prefix} ${i + 1}` }));
  S.devices.mic.splice(0, S.devices.mic.length, ...named('audioinput', t('settings.mic')));
  S.devices.cam.splice(0, S.devices.cam.length, ...named('videoinput', t('settings.cam')));
  S.devices.out.splice(0, S.devices.out.length, ...named('audiooutput', t('settings.speaker')));
  S.devices.unnamed = [...list.audioinput, ...list.videoinput].some((d) => !d.label);
}

async function checkStun() {
  S.settings.stun.splice(0, S.settings.stun.length, ...STUN_SERVERS.map((url) => ({ url, ok: null })));
  const results = await probeAll(STUN_SERVERS, { timeout: 6000 });
  results.forEach((r, i) => (S.settings.stun[i].ok = r.ok));
}

// Joining with six words

function stopJoiner() {
  app.joiner?.stop();
  app.joiner = null;
}

async function startJoin(words) {
  stopJoiner();
  S.join.stage = 'connecting';
  S.join.error = '';
  const joiner = new CodeJoiner({ brokers: brokers() });
  app.joiner = joiner;
  joiner.on('status', (st) => (S.join.relays = t('invite.relays', { n: st.connected.length, total: st.total })));
  joiner.on('timeout', () => {
    if (app.joiner !== joiner || S.join.stage !== 'connecting') return;
    stopJoiner();
    S.join.stage = 'timeout';
    S.join.error = t('join.timeout');
  });
  joiner.on('offer', async (msg) => {
    if (app.joiner !== joiner || app.room) return;
    const invite = msg.invite;
    if (!invite?.room?.id || !invite?.host?.id || typeof invite.sdp !== 'string') return;
    const room = new Room({ self: { id: myId, name: S.name }, roomId: String(invite.room.id), host: false, iceServers });
    app.room = room;
    S.join.hostName = cleanName(invite.host.name, 'Host');
    room.on('link-open', ({ peerId }) => {
      if (peerId !== invite.host.id || S.view === 'room') return;
      const words = room.confirmationWords(peerId, msg.nonce);
      if (words) {
        S.join.confirm.splice(0, S.join.confirm.length, ...words);
        S.join.stage = 'confirm';
      }
    });
    room.on('pair', ({ ok }) => {
      if (!ok) {
        S.join.stage = 'refused';
        room.leave();
        app.room = null;
      }
    });
    room.on('welcome', () => {
      stopJoiner();
      enterRoom(room);
    });
    room.on('full', () => {
      S.join.stage = 'full';
      stopJoiner();
      setTimeout(() => {
        room.leave();
        if (app.room === room) app.room = null;
      }, 300);
    });
    room.on('link-failed', ({ peerId, diagnosis }) => {
      if (peerId !== invite.host.id || S.view === 'room') return;
      S.join.stage = 'error';
      S.join.error = t('join.failed', { reason: t(`fail.${diagnosis}`) });
      stopJoiner();
      room.leave();
      app.room = null;
    });
    try {
      const reply = await room.mesh.acceptInvite({ inviteId: String(invite.inviteId), room: { id: String(invite.room.id) }, host: { id: String(invite.host.id), name: S.join.hostName }, sdp: invite.sdp });
      joiner.sendAnswer({ reply });
    } catch (e) {
      S.join.stage = 'error';
      S.join.error = e.message;
    }
  });
  try {
    await joiner.start(words);
  } catch {
    if (app.joiner !== joiner) return;
    stopJoiner();
    S.join.stage = 'error';
    S.join.error = t('join.relaysDown');
  }
}

// Inviting

function closeInvite() {
  app.creator?.stop();
  app.creator = null;
  if (app.invite && !app.invite.answered) app.room?.mesh.cancelInvite(app.invite.inviteId);
  app.invite = null;
  S.invite.open = false;
}

async function openInvite() {
  const room = app.room;
  if (!room) return;
  app.creator?.stop();
  if (app.invite && !app.invite.answered) room.mesh.cancelInvite(app.invite.inviteId);
  Object.assign(S.invite, { open: true, stage: 'making', words: [], qr: '', link: '', copied: false, name: '', error: '', relays: '', wrong: false });
  S.invite.typed.splice(0, WORD_COUNT, ...blankWords());
  if (room.mesh.full) {
    S.invite.stage = 'full';
    S.invite.error = t('invite.full');
    return;
  }
  try {
    const { inviteId, sdp } = await room.mesh.createInvite();
    const nonce = randomId(12);
    const invite = { inviteId, nonce, answered: false };
    app.invite = invite;
    const creator = new CodeCreator(Promise.resolve({ invite: { inviteId, room: { id: room.mesh.room.id }, host: { id: room.self.id, name: room.self.name }, sdp }, nonce }), { brokers: brokers() });
    app.creator = creator;
    creator.on('status', (st) => (S.invite.relays = t('invite.relays', { n: st.connected.length, total: st.total })));
    creator.on('expired', () => {
      if (app.creator !== creator || S.invite.stage !== 'waiting') return;
      S.invite.stage = 'expired';
      S.invite.error = t('invite.expired');
    });
    creator.on('answer', async (msg) => {
      if (app.creator !== creator) return;
      const reply = msg.reply;
      if (!reply?.peer?.id || typeof reply.sdp !== 'string') return;
      invite.answered = true;
      S.invite.name = cleanName(reply.peer.name);
      S.invite.stage = 'connecting';
      const peerId = String(reply.peer.id);
      // Ready for the confirmation before the link can open.
      app.heldPeer = peerId;
      room.expectPairing(peerId, nonce);
      try {
        await room.mesh.acceptReply({ inviteId: String(reply.inviteId), roomId: String(reply.roomId || ''), peer: { id: peerId, name: S.invite.name }, sdp: reply.sdp }, { hold: true });
        if (room.mesh.held.has(peerId) && S.invite.stage === 'connecting') S.invite.stage = 'confirm';
      } catch (e) {
        S.invite.stage = 'error';
        S.invite.error = e.message;
      }
      setTimeout(() => creator.stop(), 4000);
    });
    const words = await creator.start();
    if (app.creator !== creator) return;
    S.invite.words.splice(0, S.invite.words.length, ...words);
    // The words, the QR code and the link all carry the same six words.
    S.invite.link = wordsLink(appUrl(), words);
    S.invite.qr = qrSvg(encodeQR(S.invite.link, { ecl: 'M' }), { margin: 2, dark: '#0A0A0B', light: '#F4F1EC', title: t('invite.qrAlt') });
    S.invite.stage = 'waiting';
  } catch (e) {
    S.invite.stage = 'error';
    S.invite.error = t('invite.error', { reason: /relay/i.test(e.message) ? t('join.relaysDown') : e.message });
  }
}

// The room

function enterRoom(room) {
  app.room = room;
  app.media = new Media($('audio-sink'));
  app.media.noiseMode = S.voice.noise;
  app.media.micId = S.devices.micId;
  app.media.camId = S.devices.camId;
  app.media.outId = S.devices.canOutput ? S.devices.outId : '';
  // The stage elements exist once the room view renders.
  if (app.media.outId) setTimeout(() => app.media?.setOutput(app.media.outId, stageMedia()), 200);
  S.view = 'room';
  S.chat.splice(0, S.chat.length);
  S.unread = 0;
  S.tab = 'chat';
  const known = new Set(room.members().filter((m) => m.online).map((m) => m.id));

  let shown = room.state;
  room.on('state', (info) => {
    // Remember what was on screen before someone else flipped play or pause (see pressIntent).
    if (shown && room.state && shown.playing !== room.state.playing && room.state.by !== myId) app.flip = { at: Date.now(), playing: shown.playing, seq: shown.seq };
    shown = room.state;
    onState(info);
  });
  room.on('members', () => {
    renderPeople();
    const now = room.members().filter((m) => m.online);
    for (const m of now) if (!known.has(m.id) && m.id !== myId) toast(t('room.joined', { name: m.name }));
    for (const id of known) if (!now.some((m) => m.id === id) && id !== myId) toast(t('room.gone', { name: room.mesh.members.get(id)?.name || '' }));
    known.clear();
    for (const m of now) known.add(m.id);
  });
  room.on('host', (id) => {
    if (S.view !== 'room') return;
    if (id === myId && room.onlineCount() > 1) toast(t('room.youHost'));
    else if (id && id !== myId) toast(t('room.newHost', { name: room.hostName }));
    renderRoom();
  });
  room.on('link-open', ({ peerId, link }) => {
    app.media.attach(peerId, link);
    if (app.subs && app.subs.owner === myId) room.sendSubs(app.subs, peerId);
    if (app.streaming) setTimeout(measureQuality, 1500);
  });
  room.on('link-close', (peerId) => {
    app.media.detach(peerId);
    app.pendingMovies.delete(peerId);
    app.pendingScreens.delete(peerId);
    app.cameras.delete(peerId);
    renderSeats();
    // The person streaming the file left: nothing more can arrive.
    const src = room.state?.src;
    if (room.isHost && src && src.id === peerId && (src.kind === 'screen' || (src.kind === 'file' && src.mode !== 'local'))) room.intent('unload');
    if (app.streaming) setTimeout(measureQuality, 500);
    if (room.onlineCount() <= 1) toast(t('room.alone'));
  });
  room.on('subs', (subs) => applySubs(subs));
  // A peer stopped sending its camera: its seat goes away (the track is only muted, not ended).
  room.on('media', ({ peerId, media }) => {
    if (!media.camera && app.cameras.delete(peerId)) renderSeats();
  });
  room.on('track', (tr) => onTrack(tr));
  room.on('chat', () => renderChat(true));
  room.on('burst', ({ from, r }) => showBurst(from, r));
  room.on('refused', ({ result }) => toast(result === 'conflict' ? t('conflict') : t('lock.locked'), 'warn'));
  room.on('held', (peerId) => {
    if (peerId !== app.heldPeer) return;
    S.invite.stage = 'confirm';
    setTimeout(() => $('confirm-word-0')?.focus(), 60);
  });
  room.on('held-close', (peerId) => {
    if (peerId === app.heldPeer && S.invite.stage === 'confirm') {
      S.invite.stage = 'error';
      S.invite.error = t('fail.timeout');
    }
  });
  room.on('rejected', () => {
    S.invite.stage = 'full';
    S.invite.error = t('invite.full');
  });
  app.media.on('change', () => renderVoice());
  app.media.on('blocked', () => (S.media.needs = 'blocked'));
  app.media.on('screen-ended', () => {
    if (room.state?.src?.kind === 'screen' && room.state.src.id === myId) room.intent('unload');
  });
  // Links that opened before the room screen did (the inviter's link) get media now.
  for (const [peerId, link] of room.mesh.links) app.media.attach(peerId, link);

  renderAll();
  onState({});
  history.replaceState(null, '', appUrl());
}

function leaveRoom() {
  closeInvite();
  stopJoiner();
  app.media?.stopAll();
  app.media = null;
  destroyPlayer();
  app.room?.leave();
  app.room = null;
  app.file = null;
  app.cameras.clear();
  renderSeats();
  S.replyTo = null;
  S.view = 'lobby';
  Object.assign(S.media, blankMedia());
  S.queue.splice(0, S.queue.length);
  S.people.splice(0, S.people.length);
  renderVoice();
}

// Players

function destroyPlayer() {
  if (app.streaming) {
    app.media?.stopMovie();
    app.streaming = false;
  }
  app.player?.destroy();
  app.player = null;
  app.playerKey = null;
  app.screen?.destroy();
  app.screen = null;
  app.subs = null;
  S.media.subs = false;
  S.media.caption = '';
  S.media.quality = '';
  for (const id of ['file-video', 'yt-mount', 'screen-video']) $(id).hidden = true;
}

function sourceKey(src) {
  if (!src) return null;
  if (src.kind === 'yt') return `yt:${src.id}`;
  if (src.kind === 'file') return src.mode === 'local' ? `file:${src.hash}` : `stream:${src.id}:${src.hash}`;
  return `${src.kind}:${src.id}`;
}

/** Does this device run a player that follows the room clock? */
function followsClock(src) {
  if (!src) return false;
  if (src.kind === 'yt') return true;
  if (src.kind === 'file') return src.mode === 'local' || src.id === myId;
  return false;
}

/** The room state changed: load what it says and show it. */
function onState(info) {
  const room = app.room;
  if (!room || S.view !== 'room') return;
  const state = room.state;
  const src = state?.src || null;
  const key = sourceKey(src);
  if (key !== app.playerKey) {
    destroyPlayer();
    app.playerKey = key;
    S.media.error = '';
    app.blocked = false;
    if (src?.kind === 'yt') loadYouTube(src, state);
    else if (src?.kind === 'file' && src.mode === 'local') {
      const f = app.files.get(src.hash);
      if (f) loadFile(f, src, { stream: false });
    } else if (src?.kind === 'file') {
      // One person streams the file to everyone.
      const f = src.id === myId ? app.files.get(src.hash) : null;
      if (f) loadFile(f, src, { stream: true });
      else if (src.id === myId) room.intent('unload');
      else showStream(src);
    } else if (src?.kind === 'screen') showScreen(src);
    if (app.pendingSubs?.key === key) applySubs(app.pendingSubs);
  }
  if (info.action === 'lock' && room.isHost) toast(state.lock ? t('lock.lockedToast') : t('lock.unlockedToast'));
  renderRoom();
  renderMedia();
  sendToExtension(true);
  tick();
}

function loadFile(file, src, { stream }) {
  const video = $('file-video');
  video.hidden = false;
  video.muted = false;
  const p = new FilePlayer(video);
  p.on('duration', (d) => app.room?.isHost && app.room.intent('duration', { duration: d }));
  p.on('ended', () => onEnded());
  p.on('error', (msg) => (S.media.error = msg));
  p.load(file);
  app.player = p;
  app.file = { file, hash: src.hash };
  if (stream) {
    // Send what this video element shows to everyone: picture and sound, as WebRTC tracks.
    const capture = video.captureStream?.bind(video) || video.mozCaptureStream?.bind(video);
    if (!capture) {
      S.media.error = t('stream.unsupported');
      return;
    }
    app.streaming = true;
    app.media.startMovie(capture());
    measureQuality();
  }
}

async function loadYouTube(src, state) {
  const mount = $('yt-mount');
  mount.hidden = false;
  const p = new YouTubePlayer(mount);
  app.player = p;
  S.media.needs = 'loading';
  p.on('duration', (d) => {
    if (app.room?.isHost && app.player === p) app.room.intent('duration', { duration: d });
  });
  p.on('ended', () => onEnded());
  p.on('error', (msg) => (S.media.error = msg));
  p.on('user', ({ action }) => {
    if (app.player !== p || !app.room?.state) return;
    const st = app.room.state;
    if (action === 'play' && !st.playing) app.room.intent('play');
    if (action === 'pause' && st.playing) app.room.intent('pause');
  });
  try {
    await p.load(src.id, positionAt(state, app.room.hostNow()));
    if (app.player === p) S.media.needs = 'nothing';
  } catch (e) {
    if (app.player === p) S.media.error = e.message;
  }
}

function showScreen(src) {
  const video = $('screen-video');
  video.hidden = false;
  app.screen = new ScreenView(video);
  app.screen.on('blocked', () => (S.media.needs = 'blocked'));
  if (src.id === myId && app.media?.screen) {
    app.screen.show(app.media.screen.stream, { muted: true });
    S.media.needs = 'nothing';
  } else {
    S.media.needs = 'screen';
    const pending = app.pendingScreens.get(src.id);
    if (pending) {
      app.screen.show(pending);
      S.media.needs = 'nothing';
    }
  }
}

/** A guest watches the file someone streams: a live video, already in step. */
function showStream(src) {
  const video = $('screen-video');
  video.hidden = false;
  app.screen = new ScreenView(video);
  app.screen.on('blocked', () => (S.media.needs = 'blocked'));
  S.media.needs = 'stream';
  const pending = app.pendingMovies.get(src.id);
  if (pending) {
    app.screen.show(pending);
    S.media.needs = 'nothing';
  }
}

function onTrack(tr) {
  const kind = app.media.addTrack(tr);
  const src = app.room?.state?.src;
  if (kind === 'camera') {
    app.cameras.set(tr.peerId, tr.stream);
    tr.track.addEventListener('ended', () => {
      if (app.cameras.get(tr.peerId) === tr.stream) app.cameras.delete(tr.peerId);
      renderSeats();
    });
    renderSeats();
    return;
  }
  if (kind === 'screen') {
    app.pendingScreens.set(tr.peerId, tr.stream);
    tr.track.addEventListener('ended', () => app.pendingScreens.delete(tr.peerId));
    if (src?.kind === 'screen' && src.id === tr.peerId && app.screen) {
      app.screen.show(tr.stream);
      S.media.needs = 'nothing';
    }
  } else if (kind === 'movie') {
    app.pendingMovies.set(tr.peerId, tr.stream);
    tr.track.addEventListener('ended', () => {
      if (app.pendingMovies.get(tr.peerId) === tr.stream && !tr.stream.getTracks().some((x) => x.readyState === 'live')) app.pendingMovies.delete(tr.peerId);
    });
    if (src?.kind === 'file' && src.mode !== 'local' && src.id === tr.peerId && app.screen) {
      if (app.screen.video.srcObject !== tr.stream) app.screen.show(tr.stream);
      S.media.needs = 'nothing';
    }
  }
}

async function shareScreen() {
  S.share.open = false;
  try {
    await app.media.startScreen();
    app.room.intent('load', { src: { kind: 'screen', id: myId, title: t('screen.title', { name: S.name }) } });
  } catch {
    toast(t('screen.denied'), 'warn');
  }
}

function onEnded() {
  const room = app.room;
  if (!room?.isHost || !room.state?.src) return;
  if (room.state.queue.length) room.intent('next', { autoplay: true });
  else if (room.state.playing) room.intent('pause');
}

/** A file was picked: hash it, then stream it, match it, or queue it. */
async function onFilePicked(file) {
  if (!file || !app.room) return;
  const mode = app.fileMode;
  if (mode === 'subs') return loadSubsFile(file);
  const before = S.media.needs;
  S.media.needs = 'hashing';
  let hash;
  try {
    hash = await quickHash(file);
  } finally {
    if (S.media.needs === 'hashing') S.media.needs = before;
  }
  app.files.set(hash, file);
  const local = mode === 'local' || mode === 'match';
  const src = { kind: 'file', mode: local ? 'local' : 'stream', id: local ? undefined : myId, hash, size: file.size, name: file.name, title: file.name };
  const cur = app.room.state?.src;
  if (mode === 'match') {
    if (cur?.kind === 'file' && cur.mode === 'local' && cur.hash === hash) {
      app.playerKey = null;
      onState({});
    } else S.media.needs = 'mismatch';
    return;
  }
  if (mode === 'queue') {
    app.room.intent('queue-add', { item: { id: randomId(6), src } });
    toast(t('queue.added'));
    return;
  }
  if (sourceKey(cur) === sourceKey(cleanSourceLike(src))) {
    app.playerKey = null;
    onState({});
    return;
  }
  app.room.intent('load', { src });
}

const cleanSourceLike = (src) => ({ ...src, mode: src.mode === 'local' ? 'local' : 'stream' });

// Subtitles: whoever loads a .srt or .vtt file sends the cues to everyone.

async function loadSubsFile(file) {
  const key = app.playerKey;
  if (!key) return;
  let cues = [];
  try {
    cues = parseSubtitles(await file.text());
  } catch {
    cues = [];
  }
  if (!cues.length) {
    toast(t('subs.bad'), 'warn');
    return;
  }
  const subs = { key, name: file.name, cues, owner: myId };
  applySubs(subs);
  app.room.sendSubs(subs);
  toast(t('subs.loaded', { n: cues.length }));
}

function applySubs(subs) {
  if (subs.key !== app.playerKey) {
    app.pendingSubs = subs;
    return;
  }
  app.subs = subs;
  S.media.subs = true;
  S.media.showSubs = true;
}

// Streaming quality: the person streaming shares one upload between every guest.

async function measureQuality() {
  const m = app.media;
  if (!app.streaming || !m?.movie) return;
  let upload = null;
  for (const link of m.links.values()) {
    const bps = await link.uploadEstimate?.().catch(() => null);
    if (Number.isFinite(bps) && bps > 0) upload = Math.max(upload ?? 0, bps);
  }
  const video = $('file-video');
  if (!video.videoHeight) return;
  const q = streamQuality({ guests: m.links.size, uploadBps: upload, height: video.videoHeight });
  await m.applyMovieQuality(q);
  app.quality = q;
  S.media.qualityLevel = q.label;
  S.media.quality = m.links.size ? `${t(`quality.${q.label}`)} · ${qualityText(q)}` : t('quality.alone');
}

// The streaming site extension: the room tells each person's own player where to be.

function extPost(m) {
  window.postMessage({ ppExt: 'out', m }, location.origin);
}

let lastExtSend = 0;
function sendToExtension(force) {
  const room = app.room;
  if (!S.ext.installed || !room) return;
  const now = Date.now();
  if (!force && now - lastExtSend < 500) return;
  lastExtSend = now;
  const st = room.state;
  if (st?.src?.kind === 'ext') extPost(stateForPlayer(st, room.hostNow(), now));
  extPost(extMessage('room', { count: room.onlineCount(), host: room.hostName, people: S.people.map((p) => ({ name: p.name, synced: p.statusText === t('status.watching') })) }));
}

function onExtMessage(raw) {
  const m = readExtMessage(raw);
  if (!m) return;
  if (m.type === 'hello') {
    S.ext.installed = true;
    S.ext.version = m.version;
    return;
  }
  if (m.type === 'status') {
    Object.assign(S.ext, { found: m.found, site: m.site, seekable: m.seekable, playing: m.playing, pos: m.pos, at: Date.now() });
    return;
  }
  const room = app.room;
  if (m.type === 'event' && room?.state?.src?.kind === 'ext') {
    if (!room.canControl) {
      toast(t('lock.locked'), 'warn');
      return;
    }
    if (m.action === 'play' || m.action === 'pause') {
      const { action, base } = pressIntent(room.state, app.flip, Date.now());
      if (action === m.action) room.intent(action, { base });
    } else if (m.action === 'seek' && Number.isFinite(m.pos)) room.intent('seek', { pos: m.pos });
    else if (m.action === 'rate' && Number.isFinite(m.rate)) room.intent('rate', { rate: m.rate });
  }
}

// The sync loop: four times a second, compare this player with the room and correct it.

function tick() {
  const room = app.room;
  if (!room || S.view !== 'room') return;
  const state = room.state;
  sendToExtension(false);
  updateCaption();
  duck();
  if (state?.src?.kind === 'ext') return renderClock(extDrift());
  const p = app.player;
  if (!state?.src || !followsClock(state.src) || !p || !p.ready) return renderClock(state?.src && !followsClock(state.src) && S.media.needs === 'nothing' ? 0 : null);
  const expected = positionAt(state, room.hostNow());
  if (!room.isHost && !room.clock.ready) return renderClock(null);
  if (state.playing && !p.playing && !hasEnded(state, room.hostNow()) && !app.blocked) {
    p.seek(expected);
    const r = p.play();
    r?.catch?.((e) => {
      if (e?.name === 'NotAllowedError') {
        app.blocked = true;
        S.media.needs = 'blocked';
      }
    });
  } else if (!state.playing && p.playing) {
    p.pause();
  }
  const c = correction({ expected, actual: p.time, playing: state.playing, rate: state.rate, playerRate: p.rate, kind: p.kind, buffering: p.buffering });
  if (c.action === 'seek') p.seek(p.kind === 'yt' && state.playing ? c.to + 0.25 : c.to);
  else if (c.action === 'rate') p.setRate(c.rate);
  // A seek made in the YouTube player's own controls shows up as a jump.
  if (p.kind === 'yt' && c.action !== 'seek' && room.canControl) {
    const last = app.ytLast;
    const now = Date.now();
    if (last && Math.abs(p.time - (last.time + (state.playing ? ((now - last.at) / 1000) * state.rate : 0))) > 2.5 && Math.abs(c.drift) > 2.5 && !p.buffering) {
      room.intent('seek', { pos: p.time });
    }
    app.ytLast = { time: p.time, at: now };
  }
  renderClock(c.drift);
}

function extDrift() {
  const room = app.room;
  if (!S.ext.found || !S.ext.at) return null;
  const st = room.state;
  const expected = positionAt(st, room.hostNow());
  const reported = S.ext.pos + (S.ext.playing ? ((Date.now() - S.ext.at) / 1000) * st.rate : 0);
  return S.ext.seekable ? reported - expected : 0;
}

function updateCaption() {
  const room = app.room;
  if (!app.subs || !room?.state?.src) {
    if (S.media.caption) S.media.caption = '';
    return;
  }
  const text = cueText(app.subs.cues, positionAt(room.state, room.hostNow()));
  if (text !== S.media.caption) S.media.caption = text;
}

function renderClock(drift) {
  const room = app.room;
  const state = room?.state;
  if (state?.src) {
    const pos = positionAt(state, room.hostNow());
    if (!S.media.dragging) {
      S.media.scrub = Math.round(pos * 10) / 10;
      S.media.posText = fmtTime(pos);
    }
    S.media.duration = state.src.duration || 0;
    S.media.durText = state.src.duration ? fmtTime(state.src.duration) : '--:--';
    if (drift == null || !Number.isFinite(drift)) {
      S.media.syncLevel = 'wait';
      S.media.syncText = t('sync.waiting');
    } else {
      const a = Math.abs(drift);
      S.media.syncLevel = a < 0.25 ? 'ok' : a < 1 ? 'catching' : 'off';
      S.media.syncText = a < 0.25 ? t('sync.ok') : t(a < 1 ? 'sync.catching' : 'sync.off');
    }
  }
  app.drift = drift;
  // Tell everyone how this screen is doing, once a second.
  const now = Date.now();
  if (now - app.lastStatus > 1000) {
    app.lastStatus = now;
    sendStatus();
  }
}

function myStatus() {
  const room = app.room;
  const src = room?.state?.src;
  if (!src) return 'idle';
  if (src.kind === 'screen') return src.id === myId ? 'sharing' : 'screen';
  if (src.kind === 'ext') return S.ext.found ? (room.state.playing ? 'watching' : 'paused') : 'ext-missing';
  if (src.kind === 'file' && src.mode !== 'local') {
    if (src.id === myId) return 'streaming';
    if (S.media.needs === 'stream') return 'loading';
    if (S.media.needs === 'blocked') return 'blocked';
    return room.state.playing ? 'watching' : 'paused';
  }
  if (S.media.needs === 'mismatch') return 'mismatch';
  if (S.media.needs === 'file') return 'needs-file';
  if (S.media.needs === 'blocked') return 'blocked';
  if (!app.player?.ready) return 'loading';
  if (app.player.buffering) return 'buffering';
  return room.state.playing ? 'watching' : 'paused';
}

function sendStatus() {
  const m = app.media;
  app.room?.sendStatus({ status: myStatus(), drift: Number.isFinite(app.drift) ? Math.round(app.drift * 100) / 100 : null, mic: !!m?.micOn, muted: !!m?.muted, level: m ? Math.round(m.level('self') * 100) / 100 : 0, quality: app.streaming ? S.media.quality : '' });
}

// Lower the movie while someone talks (an option, on by default).
function duck() {
  const m = app.media;
  if (!m) return;
  const levels = [...m.remote.keys()].map((id) => m.level(id));
  const prev = app.duck.gain;
  app.duck = duckStep({ ...app.duck, levels, now: Date.now(), enabled: S.voice.duck });
  if (app.duck.gain === prev) return;
  const g = app.duck.gain;
  for (const id of ['file-video', 'screen-video']) $(id).volume = g;
  if (app.player?.kind === 'yt') app.player.player?.setVolume?.(Math.round(g * 100));
  for (const el of m.screenAudio.values()) el.volume = g;
}

// Camera seats under the screen: small tiles, one per person with a camera on.
function renderSeats() {
  const box = $('seats');
  if (!box) return;
  const want = new Map();
  if (app.media?.camera) want.set(myId, app.media.camera.stream);
  for (const [id, stream] of app.cameras) if (app.room?.mesh.links.has(id)) want.set(id, stream);
  for (const el of [...box.children]) if (!want.has(el.dataset.peer)) el.remove();
  for (const [id, stream] of want) {
    let seat = box.querySelector(`[data-peer="${CSS.escape(id)}"]`);
    if (!seat) {
      seat = document.createElement('figure');
      seat.className = 'seat';
      seat.dataset.peer = id;
      seat.style.setProperty('--c', colorFor(id));
      const v = document.createElement('video');
      v.autoplay = true;
      v.muted = true;
      v.playsInline = true;
      if (id === myId) v.classList.add('mirror');
      const cap = document.createElement('figcaption');
      seat.append(v, cap);
      box.append(seat);
    }
    const v = seat.querySelector('video');
    if (v.srcObject !== stream) {
      v.srcObject = stream;
      v.play().catch(() => {});
    }
    seat.querySelector('figcaption').textContent = id === myId ? `${S.name} ${t('people.you')}` : nameOf(id);
  }
  S.voice.camera = !!app.media?.cameraOn;
  box.hidden = !want.size;
}

// Rendering the store from the room

function renderAll() {
  renderRoom();
  renderMedia();
  renderPeople();
  renderChat(false);
  renderVoice();
}

function renderRoom() {
  const room = app.room;
  if (!room) return;
  const st = room.state;
  Object.assign(S.room, { count: room.onlineCount(), isHost: room.isHost, hostName: room.hostName, lock: !!st?.lock, canControl: room.canControl });
  const names = new Map(room.members().map((m) => [m.id, m.name]));
  const queue = (st?.queue || []).map((q) => ({ id: q.id, title: q.src.title || q.src.name || q.src.id, kind: q.src.kind, byName: names.get(q.by) || '' }));
  S.queue.splice(0, S.queue.length, ...queue);
}

function renderMedia() {
  const room = app.room;
  const st = room?.state;
  const src = st?.src;
  const m = S.media;
  if (!src) {
    Object.assign(m, { kind: null, title: '', playing: false, needs: 'nothing', mine: false });
    return;
  }
  const names = new Map(room.members().map((x) => [x.id, x.name]));
  m.kind = src.kind;
  m.title = src.title || src.name || '';
  m.playing = !!st.playing;
  m.rate = st.rate;
  m.mine = src.kind === 'screen' && src.id === myId;
  m.byName = src.kind === 'screen' || src.kind === 'file' ? names.get(src.id) || '' : '';
  m.mode = src.kind === 'file' ? src.mode : '';
  m.mineStream = src.kind === 'file' && src.mode !== 'local' && src.id === myId;
  m.streamer = src.kind === 'file' && src.mode !== 'local' ? names.get(src.id) || '' : '';
  if (src.kind === 'file' && src.mode === 'local') {
    m.fileName = src.name;
    m.fileSize = formatSize(src.size);
    const view = joinView(null, st, room.hostNow(), { fileHash: app.file?.hash });
    if (view.needs === 'file' && m.needs !== 'mismatch' && m.needs !== 'hashing') m.needs = 'file';
    else if (view.needs === 'nothing' && (m.needs === 'file' || m.needs === 'mismatch')) m.needs = 'nothing';
  } else if (m.needs === 'file' || m.needs === 'mismatch') m.needs = 'nothing';
  if (src.kind === 'file' && src.mode !== 'local' && src.id !== myId) {
    const q = room.statuses.get(src.id)?.quality;
    m.quality = q || '';
  }
}

function statusText(st, online) {
  if (!online) return t('status.connecting');
  if (!st) return t('status.idle');
  let s = t(`status.${st.status}`);
  if (st.status === 'watching' && Number.isFinite(st.drift) && Math.abs(st.drift) >= 0.25) s += ` · ${t('status.drift', { s: Math.abs(st.drift).toFixed(1) })}`;
  return s;
}

function renderPeople() {
  const room = app.room;
  if (!room) return;
  const host = room.hostId;
  const media = app.media;
  const list = room
    .members()
    .filter((m) => m.online)
    .map((m) => {
      const me = m.id === myId;
      const st = me ? { status: myStatus(), drift: app.drift, mic: !!media?.micOn, muted: !!media?.muted } : room.statuses.get(m.id);
      const level = me ? media?.level('self') || 0 : media?.level(m.id) || 0;
      const mic = !!st?.mic;
      const muted = !!st?.muted;
      return { id: m.id, name: m.name, initials: initials(m.name), color: colorFor(m.id), host: m.id === host, me, online: m.online, mic, muted, speaking: mic && !muted && level > 0.08, statusText: statusText(st, true), micText: !mic ? t('mic.off') : muted ? t('mic.muted') : t('mic.on') };
    });
  S.people.splice(0, S.people.length, ...list);
  S.room.count = room.onlineCount();
}

function nameOf(id) {
  if (id === myId) return S.name;
  return app.room?.mesh.members.get(id)?.name || '?';
}

function renderChat(fromEvent) {
  const room = app.room;
  if (!room) return;
  const byId = new Map(room.chat.map((m) => [m.id, m]));
  const items = room.chat.map((m) => ({
    id: m.id,
    name: nameOf(m.from),
    color: colorFor(m.from),
    text: m.text,
    parts: splitTimes(m.text).map((p, i) => ({ ...p, i })),
    reply: m.re && byId.get(m.re) ? { name: nameOf(byId.get(m.re).from), text: byId.get(m.re).text.slice(0, 90) } : null,
    vt: Number.isFinite(m.vt) ? m.vt : null,
    vtLabel: Number.isFinite(m.vt) ? formatTime(m.vt) : '',
    time: new Date(m.ts).toLocaleTimeString(S.lang === 'pt' ? 'pt-BR' : 'en', { hour: '2-digit', minute: '2-digit' }),
    mine: m.from === myId,
    reactions: REACTIONS.filter((r) => m.reactions[r]?.length).map((r) => ({ r, n: m.reactions[r].length, mine: m.reactions[r].includes(myId) })),
  }));
  const grew = items.length > S.chat.length;
  S.chat.splice(0, S.chat.length, ...items);
  if (fromEvent && grew && S.tab !== 'chat') S.unread += 1;
  if (grew) scrollChat();
}

function scrollChat() {
  requestAnimationFrame(() => {
    const el = $('chat-list');
    if (el) el.scrollTop = el.scrollHeight;
  });
}

function renderVoice() {
  S.voice.on = !!app.media?.micOn;
  S.voice.muted = !!app.media?.muted;
  S.voice.camera = !!app.media?.cameraOn;
  S.voice.processing = app.media?.processing || '';
  renderPeople();
  if (app.room) sendStatus();
}

function showBurst(from, r) {
  const box = $('bursts');
  if (!box || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const el = document.createElement('span');
  el.className = 'burst';
  el.style.setProperty('--x', `${10 + Math.random() * 80}%`);
  el.style.setProperty('--c', colorFor(from));
  el.innerHTML = `<svg class="ic-react" aria-hidden="true"><use href="icons.svg#i-react-${r}"/></svg>`;
  box.append(el);
  setTimeout(() => el.remove(), 2600);
}

// Boot

function boot() {
  const V = window.V;
  S = V.store('pp', { ...initial, ...actions });
  V.config.globals.t = (key, vars) => translate(S.lang, key, vars);
  V.data({ S });
  document.documentElement.lang = S.lang === 'pt' ? 'pt-BR' : 'en';
  V.start();

  const dl = $('bip39');
  dl.append(...WORDLIST.map((w) => Object.assign(document.createElement('option'), { value: w })));
  wireWordInputs(document, {
    onComplete(prefix, how) {
      // A pasted phrase or link joins at once; typed words wait for the button.
      if (prefix === 'join-word' && how === 'spread' && S.join.stage !== 'connecting') actions.joinRoom();
      else if (prefix === 'join-word') $('join-go')?.focus();
      if (prefix === 'confirm-word') $('confirm-go')?.focus();
    },
  });
  $('file-input').addEventListener('change', (e) => onFilePicked(e.target.files?.[0]));
  $('subs-input').addEventListener('change', (e) => onFilePicked(e.target.files?.[0]));

  // The optional streaming site extension talks to this page through its bridge script.
  addEventListener('message', (e) => {
    if (e.source === window && e.origin === location.origin && e.data?.ppExt === 'in') onExtMessage(e.data.m);
  });
  window.postMessage({ ppExt: 'ping' }, location.origin);
  setInterval(() => {
    if (app.streaming) measureQuality();
  }, 4000);

  setInterval(tick, 250);
  setInterval(() => {
    if (app.room && S.view === 'room') {
      renderPeople();
      renderMedia();
    }
  }, 700);

  // An invite link (#join=word-word-...) joins the room right away. The words
  // never leave the hash, and the hash is cleared from the address bar at once.
  const joinFromLink = () => {
    const w = wordsFromLink(location.hash);
    if (!w) return;
    history.replaceState(null, '', appUrl());
    if (S.view === 'room' || app.joiner) return;
    actions.openJoin(resolvePhrase(w).words.map((x) => x || ''));
    actions.joinRoom();
  };
  joinFromLink();
  addEventListener('hashchange', joinFromLink);
  navigator.mediaDevices?.addEventListener?.('devicechange', () => S.settings.open && refreshDevices());
  addEventListener('beforeunload', () => app.room?.leave());
  addEventListener('pointerdown', () => app.media?.resume(), { once: true });

  if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});

  window.popcornpals = { app, get S() { return S; }, actions };
}

if (window.V) boot();
else addEventListener('load', boot, { once: true });
