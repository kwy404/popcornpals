// Animated copies of the approved art for the README, in assets/readme/.
// The drawings stay exactly as they are: this only tags existing groups with
// classes and adds CSS motion inside each SVG (translate and opacity, so the
// shapes never change). On the banner, a pair of curtains opens once and
// leaves the original picture. Reduced motion shows the still picture.
//   node scripts/readme-art.mjs [--check]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const out = 'assets/readme';
const check = process.argv.includes('--check');
const sources = [
  'assets/banner.svg', 'assets/banner-dark.svg', 'assets/mascot.svg', 'assets/mascot-dark.svg',
  ...['six-words', 'in-sync', 'screening-room', 'black-screen'].flatMap((n) => [`assets/illustrations/${n}.svg`, `assets/illustrations/${n}-dark.svg`]),
];

const css = `
.pp-beam { animation: pp-flicker 3.4s steps(1, end) infinite; }
.pp-head { animation: pp-nod 4.2s ease-in-out infinite; }
.pp-head.pp-2 { animation-delay: -1.6s; }
.pp-head.pp-3 { animation-delay: -2.8s; }
.pp-kernel { animation: pp-hop 3.6s ease-in-out infinite; }
.pp-curtain { animation: pp-open 2.2s cubic-bezier(.6, 0, .2, 1) .9s both; }
.pp-curtain.pp-r { animation-name: pp-open-r; }
@keyframes pp-flicker { 0%, 100% { opacity: 1; } 31% { opacity: .78; } 34% { opacity: 1; } 62% { opacity: .9; } 64% { opacity: 1; } }
@keyframes pp-nod { 0%, 100% { translate: 0 0; } 50% { translate: 0 -2.5px; } }
@keyframes pp-hop { 0%, 78%, 100% { translate: 0 0; } 86% { translate: 0 -7px; } 92% { translate: 0 0; } }
@keyframes pp-open { from { translate: 0 0; } to { translate: -105% 0; } }
@keyframes pp-open-r { from { translate: 0 0; } to { translate: 105% 0; } }
@media (prefers-reduced-motion: reduce) {
  .pp-beam, .pp-head, .pp-kernel { animation: none; }
  .pp-curtain { display: none; }
}`;

/** Two velvet curtains across the whole picture, drawn last so they cover it at first. */
function curtains(w, h) {
  const half = w / 2 + 2;
  const fold = Math.round(half / 7);
  const side = (cls, x0, edge) =>
    `<g class="pp-curtain ${cls}"><rect x="${x0}" y="0" width="${half}" height="${h}" fill="url(#pp-fold)"/>` +
    `<rect x="${x0}" y="0" width="${half}" height="${h}" fill="url(#pp-shade)"/>` +
    `<rect x="${edge}" y="0" width="3" height="${h}" fill="#CDBB8E" opacity=".55"/></g>`;
  return (
    `<defs><linearGradient id="pp-fold" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${fold}" y2="0" spreadMethod="repeat">` +
    '<stop offset="0" stop-color="#3D0F18"/><stop offset=".45" stop-color="#7A2E3E"/><stop offset=".62" stop-color="#5E1A26"/><stop offset="1" stop-color="#3D0F18"/></linearGradient>' +
    '<linearGradient id="pp-shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity=".35"/><stop offset=".25" stop-color="#000" stop-opacity="0"/><stop offset=".85" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".4"/></linearGradient></defs>' +
    `<clipPath id="pp-clip"><rect width="${w}" height="${h}" rx="20"/></clipPath><g clip-path="url(#pp-clip)">` +
    side('pp-l', -2, w / 2 - 1) +
    side('pp-r', w / 2, w / 2) +
    '</g>'
  );
}

function animate(svg, name) {
  let s = svg;
  // The projector beam: a path filled with a gradient whose id ends in "beam".
  s = s.replace(/<path ([^>]*fill="url\(#[\w-]*beam\)")/g, '<path class="pp-beam" $1');
  // Heads: a group whose first child mirrors the ears.
  let heads = 0;
  s = s.replace(/<g transform="([^"]+)">(?=<g transform="scale\(1 1\)"><ellipse)/g, (_, t) => `<g class="pp-head pp-${(heads++ % 3) + 1}" transform="${t}">`);
  // Popcorn: small rotated groups made of circles, each hopping on its own beat.
  let kernels = 0;
  s = s.replace(/<g transform="(translate\([^)]*\) rotate\([^)]*\))">(?=<circle)/g, (_, t) => {
    const delay = (-(kernels++ * 0.47) % 3.6).toFixed(2);
    return `<g class="pp-kernel" style="animation-delay:${delay}s" transform="${t}">`;
  });
  const [, w, h] = /viewBox="0 0 (\d+) (\d+)"/.exec(s).map(Number);
  // The style goes right after the title, so the title stays the first child.
  s = s.replace(/(<title>[^<]*<\/title>)/, `$1<style>${css}</style>`);
  if (name.startsWith('banner')) s = s.replace(/<\/svg>\s*$/, `${curtains(w, h)}</svg>\n`);
  return { s, heads, kernels };
}

if (!check) mkdirSync(out, { recursive: true });
const stale = [];
for (const src of sources) {
  const name = basename(src);
  const { s, heads, kernels } = animate(readFileSync(src, 'utf8'), name);
  const target = join(out, name);
  if (check) {
    if (!existsSync(target) || readFileSync(target, 'utf8') !== s) stale.push(target);
    continue;
  }
  writeFileSync(target, s);
  console.log(`${target}: ${heads} heads, ${kernels} kernels${name.startsWith('banner') ? ', curtains' : ''}`);
}
if (stale.length) {
  console.error(`stale README art, run node scripts/readme-art.mjs:\n${stale.join('\n')}`);
  process.exit(1);
}
if (check) console.log(`readme art: ${sources.length} animated files up to date`);
