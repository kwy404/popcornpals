// Finds a Chromium based browser for the browser tests and starts it with a
// fresh profile folder and fake camera and microphone devices.
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function findBrowser(explicit) {
  const candidates = [
    explicit,
    process.env.BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('No Chromium based browser found: pass its path or set BROWSER');
  return found;
}

export const FAKE_MEDIA = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--auto-select-desktop-capture-source=Entire screen',
];

/** One person: a browser with its own fresh profile folder. */
export async function launchPerson(chromium, { executablePath, viewport = { width: 1280, height: 800 }, locale = 'en-US', extraArgs = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'popcornpals-e2e-'));
  return chromium.launchPersistentContext(dir, {
    executablePath,
    headless: true,
    viewport,
    locale,
    permissions: ['microphone', 'camera', 'clipboard-read', 'clipboard-write'],
    args: [...FAKE_MEDIA, ...extraArgs],
  });
}
