// Checks every local link and image in the site, the app and the READMEs:
// each relative href or src must point to a file that exists, and each
// in-page #anchor must name an id on that page. External links are listed,
// not fetched.
//   node scripts/check-links.mjs
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const svgs = walk('assets').filter((f) => f.endsWith('.svg'));
const pages = [...walk('docs').filter((f) => f.endsWith('.html')), 'README.md', 'i18n/README.pt-BR.md', 'CONTRIBUTING.md', 'SECURITY.md'].filter((f) => existsSync(f));
const broken = [];
let local = 0;
const external = new Set();
for (const page of [...pages, ...svgs]) {
  const text = readFileSync(page, 'utf8');
  const ids = new Set([...text.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const refs = [...text.matchAll(/(?<![:\w-])(?:href|src|srcset)="([^"]+)"/g), ...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  for (const raw of refs) {
    if (/^(https?:|mailto:)/.test(raw)) {
      external.add(raw);
      continue;
    }
    if (raw.startsWith('data:') || raw.includes('{') || raw.includes('+')) continue;
    if (raw.startsWith('#')) {
      if (page.endsWith('.html') && raw.length > 1 && !ids.has(raw.slice(1))) broken.push(`${page}: ${raw} (no such id on the page)`);
      continue;
    }
    const path = raw.split('#')[0].split('?')[0];
    if (!path) continue;
    let file;
    if (path.startsWith('/popcornpals/')) file = join('docs', path.slice('/popcornpals/'.length));
    else if (path.startsWith('/')) {
      broken.push(`${page}: ${raw} (absolute path outside /popcornpals/)`);
      continue;
    } else file = normalize(join(dirname(page), path));
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    local++;
    if (!existsSync(file)) broken.push(`${page}: ${raw}`);
  }
}
if (broken.length) {
  console.error(`broken links:\n${broken.join('\n')}`);
  process.exit(1);
}
console.log(`links: ${local} local links in ${pages.length + svgs.length} files resolve; ${external.size} external links not fetched`);
