// Visual QA: screenshots of the landing page, the app and the 404 page at
// 1860x930, 1440x900 and 375x812, in dark and light, into out/qa/. Fails on
// any console error or failed local request. The CDN files come from
// node_modules, so it runs offline.
//   node scripts/qa.mjs [browser path]
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { serve } from './serve.mjs';
import { findBrowser, launchPerson } from '../test/browser.mjs';

const out = 'out/qa';
mkdirSync(out, { recursive: true });
const server = await serve(0, 'docs', { base: '/popcornpals/' });
const { port } = server.address();
const base = `http://127.0.0.1:${port}/popcornpals/`;
const CDN = {
  'https://cdn.jsdelivr.net/npm/monsooncss@0.2.0/dist/monsoon.min.css': ['node_modules/monsooncss/dist/monsoon.min.css', 'text/css'],
  'https://cdn.jsdelivr.net/npm/voodoojs@1.0.0/dist/voodoo.full.min.js': ['node_modules/voodoojs/dist/voodoo.full.min.js', 'text/javascript'],
};
const sizes = [
  ['1860', { width: 1860, height: 930 }],
  ['1440', { width: 1440, height: 900 }],
  ['375', { width: 375, height: 812 }],
];
const pages = [
  ['landing', ''],
  ['app', 'app/'],
  ['404', 'no-such-page/'],
];

const problems = [];
const context = await launchPerson(chromium, { executablePath: findBrowser(process.argv[2]) });
for (const [url, [file, type]] of Object.entries(CDN)) {
  if (existsSync(file)) await context.route(url, (route) => route.fulfill({ status: 200, contentType: type, body: readFileSync(file), headers: { 'access-control-allow-origin': '*' } }));
}
const page = context.pages()[0] || (await context.newPage());
page.setDefaultNavigationTimeout(120000);
// The 404 page itself answers with status 404, which the console reports.
let current = '';
page.on('console', (m) => m.type() === 'error' && !(current === '404' && /status of 404/.test(m.text())) && problems.push(`console (${current}): ${m.text()}`));
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
page.on('response', (r) => r.url().startsWith(base) && r.status() >= 400 && !r.url().includes('no-such-page') && problems.push(`${r.status()} ${r.url()}`));

try {
  for (const theme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: theme });
    for (const [size, viewport] of sizes) {
      await page.setViewportSize(viewport);
      for (const [name, path] of pages) {
        current = name;
        await page.goto(base + path);
        // The landing and 404 pages read the theme Voodoo saved.
        await page.evaluate((t) => {
          localStorage.setItem('voodoo:theme', JSON.stringify(t));
          document.documentElement.setAttribute('data-theme', t);
        }, theme);
        await page.waitForTimeout(700);
        const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        if (wide > 1) problems.push(`${name} ${size} ${theme}: the page scrolls sideways by ${wide}px`);
        await page.screenshot({ path: join(out, `${name}-${size}-${theme}.png`) });
        if (name === 'landing') {
          // Scroll through the hero so the curtains open, then shoot the full page.
          await page.evaluate(() => scrollTo(0, innerHeight * 1.2));
          await page.waitForTimeout(600);
          await page.screenshot({ path: join(out, `${name}-${size}-${theme}-open.png`) });
          await page.evaluate(async () => {
            for (let y = 0; y < document.body.scrollHeight; y += innerHeight / 2) {
              scrollTo(0, y);
              await new Promise((r) => setTimeout(r, 60));
            }
          });
          await page.waitForTimeout(500);
          await page.screenshot({ path: join(out, `${name}-${size}-${theme}-full.png`), fullPage: true });
        }
      }
    }
  }
  // The landing page shows every section with reduced motion too, and after
  // the opening the curtains are open with motion on.
  for (const motion of ['reduce', 'no-preference']) {
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: motion });
    await page.setViewportSize({ width: 1440, height: 900 });
    current = 'landing';
    await page.goto(base);
    await page.waitForTimeout(motion === 'reduce' ? 500 : 3800);
    const r = await page.evaluate(() => {
      const stage = document.querySelector('.cinema .stage');
      const frames = [...document.querySelectorAll('.strip .frame')];
      const hero = document.querySelector('.cinema').getBoundingClientRect().height;
      return {
        p: Number(getComputedStyle(stage).getPropertyValue('--p')),
        hidden: frames.filter((f) => Number(getComputedStyle(f).opacity) < 1).length,
        moved: frames.filter((f) => getComputedStyle(f).transform !== 'none').length,
        heroRatio: hero / innerHeight,
      };
    });
    if (Math.abs(r.p - 1) > 0.01) problems.push(`landing (${motion}): the curtains are not open (--p ${r.p})`);
    if (r.hidden) problems.push(`landing (${motion}): ${r.hidden} reel frames are hidden`);
    if (motion === 'reduce' && r.moved) problems.push(`landing (reduce): ${r.moved} reel frames move`);
    if (r.heroRatio > 1.05) problems.push(`landing (${motion}): the hero is ${r.heroRatio.toFixed(2)} viewports tall`);
    await page.screenshot({ path: join(out, `landing-1440-${motion}-full.png`), fullPage: true });
  }
} finally {
  // A busy machine can make the browser slow to close; do not wait forever.
  await Promise.race([context.close().catch(() => {}), new Promise((r) => setTimeout(r, 20000))]);
  server.close();
}
if (problems.length) {
  console.error([...new Set(problems)].join('\n'));
  process.exit(1);
}
console.log(`qa: ${pages.length * sizes.length * 2} views in ${out}/, no console errors, no failed requests, no sideways scroll`);
process.exit(0);
