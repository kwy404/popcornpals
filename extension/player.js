// Runs in a streaming site tab the person chose to sync (and in its frames).
// It finds the page's main video element and keeps it on the room's moment:
// it only presses play and pause, seeks and sets the speed on the person's
// own player, the way the site's own buttons would. It never captures,
// records, downloads or re-streams the video, and it does not touch copy
// protection. A small overlay shows the room and whether this tab is in sync.
(() => {
  if (window.__ppPlayer) return;
  window.__ppPlayer = true;
  const S = globalThis.PPSync;
  if (!S) return;

  const pt = /^pt\b/i.test(navigator.language || '');
  const T = pt
    ? { watching: (n) => `${n} assistindo`, synced: 'Em sincronia', waiting: 'Esperando a sala', paused: 'Pausado', noSeek: 'Este player não aceita avanço de fora: o popcornpals só dá play e pausa aqui. Avance na mão até o mesmo momento.', hide: 'Esconder', room: 'Sala do popcornpals' }
    : { watching: (n) => `${n} watching`, synced: 'In sync', waiting: 'Waiting for the room', paused: 'Paused', noSeek: 'This player does not accept seeking from outside: popcornpals only plays and pauses here. Move to the same moment by hand.', hide: 'Hide', room: 'popcornpals room' };

  let video = null;
  let sync = null;
  let port = null;
  let room = null;
  let lastStatus = 0;
  const events = ['play', 'pause', 'seeking', 'ratechange'];

  function post(m) {
    if (!port) return;
    try {
      port.postMessage(m);
    } catch {
      port = null;
    }
  }

  function connect() {
    if (port) return;
    try {
      port = chrome.runtime.connect({ name: 'pp-player' });
    } catch {
      port = null;
      return;
    }
    port.onMessage.addListener((raw) => {
      const m = S.readMessage(raw);
      if (!m) return;
      if (m.type === 'state') {
        sync?.onState(m);
        // The last state, readable by the page for support and tests (no personal data).
        host.dataset.ppState = `${m.seq} ${m.playing ? 'playing' : 'paused'} ${m.pos.toFixed(2)}`;
      }
      if (m.type === 'room') room = m;
      render();
    });
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(() => video && connect(), 1000);
    });
  }

  function findVideo() {
    const all = [...document.querySelectorAll('video')];
    const info = all.map((v) => {
      const r = v.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0 && getComputedStyle(v).visibility !== 'hidden';
      return { width: r.width, height: r.height, visible, paused: v.paused, duration: v.duration };
    });
    const i = S.pickMainVideo(info);
    return i >= 0 ? all[i] : null;
  }

  const onEvent = (e) => sync?.onVideoEvent(e.type);

  function attach(v) {
    if (video) for (const t of events) video.removeEventListener(t, onEvent);
    video = v;
    sync = v ? new S.PlayerSync({ video: v, send: post, site: location.hostname }) : null;
    if (!v) return;
    for (const t of events) v.addEventListener(t, onEvent);
    connect();
    post(sync.status());
  }

  // The overlay lives in a closed shadow root so the page's styles cannot touch it.
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>
    :host { all: initial; }
    .pill { font: 13px/1.35 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; color: #ededed; background: rgba(10,10,11,.88); border: 1px solid rgba(255,255,255,.14); border-radius: 14px; padding: 10px 12px; min-width: 190px; max-width: 280px; box-shadow: 0 18px 40px -18px rgba(0,0,0,.7); backdrop-filter: blur(10px); }
    .top { display: flex; align-items: center; gap: 8px; font-weight: 600; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #8a8a8f; flex: none; }
    .dot.ok { background: #8fb39d; } .dot.wait { background: #cdbb8e; }
    .muted { color: #8a8a8f; font-weight: 400; }
    .people { margin: 6px 0 0; padding: 0; list-style: none; display: flex; flex-wrap: wrap; gap: 4px; }
    .people li { padding: 1px 8px; border: 1px solid rgba(255,255,255,.12); border-radius: 999px; font-size: 12px; }
    .note { margin: 8px 0 0; font-size: 12px; color: #c9a1a6; }
    button { all: unset; cursor: pointer; margin-left: auto; color: #8a8a8f; font-size: 12px; }
    button:focus-visible { outline: 2px solid #c9a1a6; outline-offset: 2px; border-radius: 4px; }
    .min .people, .min .note { display: none; }
  </style><div class="pill" role="status" aria-live="polite"><div class="top"><span class="dot"></span><span class="title"></span><button type="button"></button></div><ul class="people"></ul><p class="note" hidden></p></div>`;
  const $ = (s) => shadow.querySelector(s);
  $('button').textContent = T.hide;
  $('button').addEventListener('click', () => $('.pill').classList.toggle('min'));

  function render() {
    if (!video) return host.remove();
    if (!host.isConnected) document.documentElement.append(host);
    const s = sync?.state;
    const drift = s ? Math.abs(video.currentTime - S.expectedPosition(s, Date.now())) : Infinity;
    const ok = s && (drift < 1.5 || !sync.seekable) && video.paused === !s.playing;
    $('.dot').className = `dot ${ok ? 'ok' : 'wait'}`;
    const count = room?.count ? ` <span class="muted">${T.watching(room.count)}</span>` : '';
    $('.title').innerHTML = `${ok ? (s.playing ? T.synced : T.paused) : T.waiting}${count}`;
    const ul = $('.people');
    ul.replaceChildren(...(room?.people || []).map((p) => Object.assign(document.createElement('li'), { textContent: p.name })));
    const note = $('.note');
    note.hidden = !!sync?.seekable;
    note.textContent = T.noSeek;
  }

  setInterval(() => {
    const v = findVideo();
    if (v && v !== video) attach(v);
    if (!v && video && !video.isConnected) attach(null);
    sync?.tick();
    const now = Date.now();
    if (sync && now - lastStatus > 2000) {
      lastStatus = now;
      post(sync.status());
    }
    render();
  }, 400);
})();
