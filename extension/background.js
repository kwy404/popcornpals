// The extension's service worker. It relays messages between the popcornpals
// app tab ('pp-app' ports) and the video players it was asked to sync
// ('pp-player' ports), and connects a tab when the person asks in the popup.
// It never reads, records or sends any video: only the small sync messages.

const apps = new Set();
const players = new Map(); // port -> last status

function toApps(m) {
  for (const p of apps) {
    try {
      p.postMessage(m);
    } catch {
      apps.delete(p);
    }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'pp-app') {
    apps.add(port);
    port.onMessage.addListener((m) => {
      for (const p of players.keys()) {
        try {
          p.postMessage(m);
        } catch {
          players.delete(p);
        }
      }
    });
    port.onDisconnect.addListener(() => apps.delete(port));
    // Tell the new app tab about players that are already connected.
    for (const status of players.values()) if (status) port.postMessage(status);
  } else if (port.name === 'pp-player') {
    players.set(port, null);
    port.onMessage.addListener((m) => {
      if (m && m.type === 'status') players.set(port, m);
      toApps(m);
    });
    port.onDisconnect.addListener(() => {
      players.delete(port);
      toApps({ pp: 1, type: 'status', found: false, playing: false, pos: 0, seekable: true, site: '', title: '' });
    });
  }
});

const FILES = ['lib/sync.js', 'player.js'];
const scriptId = (origin) => `pp-${origin.replace(/[^a-z0-9]/gi, '-')}`;

/** Start syncing a tab now, and on later visits too when the site permission was granted. */
async function connectTab(tabId, origin, remember) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: FILES });
  if (!remember) return { ok: true, remembered: false };
  const id = scriptId(origin);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (!existing.length) {
    await chrome.scripting.registerContentScripts([{ id, matches: [`${origin}/*`], js: FILES, runAt: 'document_idle', allFrames: true, persistAcrossSessions: true }]);
  }
  return { ok: true, remembered: true };
}

async function forget(origin) {
  const id = scriptId(origin);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [id] });
  await chrome.permissions.remove({ origins: [`${origin}/*`] }).catch(() => false);
  return { ok: true };
}

async function sites() {
  const list = await chrome.scripting.getRegisteredContentScripts();
  return list.filter((s) => s.id.startsWith('pp-')).map((s) => s.matches[0].replace(/\/\*$/, ''));
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    if (msg?.cmd === 'connect') return connectTab(msg.tabId, msg.origin, !!msg.remember);
    if (msg?.cmd === 'forget') return forget(msg.origin);
    if (msg?.cmd === 'status') return { apps: apps.size, players: [...players.values()].filter(Boolean), sites: await sites() };
    return { ok: false };
  })()
    .then(reply)
    .catch((e) => reply({ ok: false, error: String(e?.message || e) }));
  return true;
});

// Exposed for the browser test, which drives the worker directly.
self.ppConnectTab = connectTab;
