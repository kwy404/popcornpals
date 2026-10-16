// The toolbar popup: shows whether the popcornpals tab and this tab are
// connected, and connects this tab when the person asks. Access to the site
// is requested only then, for that one site, and can be removed here.
const pt = /^pt\b/i.test(navigator.language || '');
const T = pt
  ? {
      appOk: 'Aba do popcornpals conectada',
      appNo: 'Abra sua sala no popcornpals em outra aba',
      tabOk: (s) => `Sincronizando ${s}`,
      tabReady: (s) => `Esta aba: ${s}`,
      tabNone: 'Abra o vídeo no site de streaming e clique aqui de novo',
      tabApp: 'Esta é a aba do popcornpals',
      connect: 'Sincronizar esta aba com a sala',
      connected: 'Conectado',
      hint: 'O navegador pode pedir acesso a este site, para a sincronização voltar sozinha quando a página recarregar. Sem esse acesso, ela vale até você sair da página.',
      sites: 'Sites lembrados',
      forget: 'Esquecer',
      footer: 'Cada pessoa usa a própria conta e a própria assinatura. A extensão só dá play, pausa e avança no seu player; ela nunca grava nem compartilha o vídeo.',
    }
  : {
      appOk: 'popcornpals tab connected',
      appNo: 'Open your popcornpals room in another tab',
      tabOk: (s) => `Syncing ${s}`,
      tabReady: (s) => `This tab: ${s}`,
      tabNone: 'Open the video on the streaming site, then click here again',
      tabApp: 'This is the popcornpals tab',
      connect: 'Sync this tab with my room',
      connected: 'Connected',
      hint: 'The browser may ask for access to this site, so syncing comes back by itself when the page reloads. Without it, syncing lasts until you leave the page.',
      sites: 'Remembered sites',
      forget: 'Forget',
      footer: 'Everyone uses their own account and their own subscription. The extension only plays, pauses and seeks your player; it never records or shares the video.',
    };

const $ = (id) => document.getElementById(id);
$('connect').textContent = T.connect;
$('hint').textContent = T.hint;
$('sites-h').textContent = T.sites;
$('footer').textContent = T.footer;

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const status = await chrome.runtime.sendMessage({ cmd: 'status' });
  $('app-dot').className = `dot ${status.apps ? 'ok' : 'bad'}`;
  $('app-status').textContent = status.apps ? T.appOk : T.appNo;
  let origin = '';
  try {
    origin = new URL(tab?.url || '').origin;
  } catch {
    origin = '';
  }
  const isWeb = /^https:\/\//.test(origin);
  const isApp = /^https:\/\/kwy404\.github\.io$/.test(origin) && /\/popcornpals\/app\//.test(tab?.url || '');
  const host = isWeb ? new URL(origin).hostname : '';
  const playing = status.players.find((p) => p.found && p.site === host);
  $('tab-dot').className = `dot ${playing ? 'ok' : ''}`;
  $('tab-status').textContent = isApp ? T.tabApp : playing ? T.tabOk(host) : isWeb ? T.tabReady(host) : T.tabNone;
  $('connect').disabled = !isWeb || isApp;
  $('connect').textContent = playing ? T.connected : T.connect;
  $('connect').onclick = async () => {
    // Must run inside the click: the browser only shows the access request for a user action.
    const remember = await chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
    await chrome.runtime.sendMessage({ cmd: 'connect', tabId: tab.id, origin, remember });
    setTimeout(refresh, 800);
  };
  $('sites-box').hidden = !status.sites.length;
  $('sites').replaceChildren(
    ...status.sites.map((site) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = site.replace(/^https:\/\//, '');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = T.forget;
      b.onclick = async () => {
        await chrome.runtime.sendMessage({ cmd: 'forget', origin: site });
        refresh();
      };
      li.append(name, b);
      return li;
    }),
  );
}

refresh();
