// Runs in the popcornpals app tab. It passes messages between the page and
// the extension, nothing else: the page posts { ppExt: 'out', m } and
// receives { ppExt: 'in', m }. The room, voice and chat stay in the page.
(() => {
  if (window.__ppBridge) return;
  window.__ppBridge = true;
  const VERSION = chrome.runtime.getManifest().version;
  const toPage = (m) => window.postMessage({ ppExt: 'in', m }, location.origin);
  let port = null;

  function connect() {
    try {
      port = chrome.runtime.connect({ name: 'pp-app' });
    } catch {
      port = null;
      return;
    }
    port.onMessage.addListener(toPage);
    port.onDisconnect.addListener(() => {
      port = null;
      // The service worker went to sleep or was updated: connect again.
      setTimeout(connect, 500);
    });
  }

  connect();
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin || !e.data || typeof e.data !== 'object') return;
    if (e.data.ppExt === 'ping') return toPage({ pp: 1, type: 'hello', version: VERSION });
    if (e.data.ppExt !== 'out') return;
    if (!port) connect();
    try {
      port?.postMessage(e.data.m);
    } catch {
      port = null;
    }
  });
  toPage({ pp: 1, type: 'hello', version: VERSION });
})();
