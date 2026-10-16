// Renders the PNG app icons and social images from the SVG art with headless Edge.
// Usage: node scripts/render-art.mjs   (set EDGE_PATH to use another Chromium build)
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findBrowser } from '../test/browser.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const executablePath = process.env.EDGE_PATH || findBrowser();
const font = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

const page = (inner, extraCss = '') => `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; background: transparent; }
.fill > svg { display: block; width: 100vw; height: 100vh; }
${extraCss}
</style></head><body>${inner}</body></html>`;

const svgPage = (rel) => page(`<div class="fill">${read(rel)}</div>`);

// The social card: the dark screening room on the right, the name and line on the left.
const card = (w, h) => {
  const sceneW = Math.round(h * (800 / 560));
  return page(`<div class="card"><div class="scene">${read('assets/illustrations/screening-room-dark.svg')}</div>
<div class="fade"></div>
<div class="copy"><div class="rule"></div><h1>popcornpals</h1><p>Watch together, in sync, peer to peer.</p></div></div>`, `
.card { position: relative; width: ${w}px; height: ${h}px; overflow: hidden; background: #0A0A0B; font-family: ${font}; }
.scene { position: absolute; top: 0; right: 0; width: ${sceneW}px; height: ${h}px; }
.scene > svg { display: block; width: 100%; height: 100%; }
.fade { position: absolute; inset: 0; background: linear-gradient(90deg, #0A0A0B 0%, #0A0A0B ${Math.round(w * 0.3)}px, rgba(10, 10, 11, 0.7) ${Math.round(w * 0.44)}px, rgba(10, 10, 11, 0) ${Math.round(w * 0.6)}px); }
.copy { position: absolute; left: ${Math.round(w * 0.066)}px; top: 50%; transform: translateY(-50%); }
.rule { width: 44px; height: 2px; border-radius: 1px; background: #C9A1A6; opacity: 0.8; margin-bottom: 30px; }
h1 { margin: 0; color: #EDEDED; font-size: ${Math.round(h * 0.135)}px; font-weight: 600; letter-spacing: -0.03em; line-height: 1; }
p { margin: 22px 0 0; color: #8A8A8F; font-size: ${Math.round(h * 0.047)}px; line-height: 1.3; }
`);
};

const jobs = [
  { out: 'docs/app/icons/icon-192.png', size: [192, 192], html: () => svgPage('docs/app/icons/icon.svg') },
  { out: 'docs/app/icons/icon-512.png', size: [512, 512], html: () => svgPage('docs/app/icons/icon.svg') },
  { out: 'docs/app/icons/maskable-512.png', size: [512, 512], html: () => svgPage('docs/app/icons/maskable.svg') },
  { out: 'docs/app/icons/apple-touch-icon.png', size: [180, 180], html: () => svgPage('docs/app/icons/maskable.svg') },
  ...[16, 32, 48, 128].map((n) => ({ out: `extension/icons/icon-${n}.png`, size: [n, n], html: () => svgPage('docs/app/icons/icon.svg') })),
  { out: 'docs/og.png', size: [1200, 630], html: () => card(1200, 630) },
  { out: 'assets/social-preview.png', size: [1280, 640], html: () => card(1280, 640) },
];

const profile = mkdtempSync(join(tmpdir(), 'popcornpals-art-'));
const context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, timeout: 180000 });
try {
  const tab = await context.newPage();
  for (const job of jobs) {
    const [width, height] = job.size;
    await tab.setViewportSize({ width, height });
    await tab.setContent(job.html(), { waitUntil: 'load', timeout: 120000 });
    await tab.screenshot({ path: join(root, job.out), omitBackground: true, timeout: 120000 });
    console.log(`rendered ${job.out} (${width}x${height})`);
  }
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
