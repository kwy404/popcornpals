// The shared modules live in src/ and are tested there. GitHub Pages only
// serves docs/, so this copies them to docs/app/core/. With --check it fails
// when the copies are stale (used in CI).
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const from = 'src';
const to = 'docs/app/core';
const check = process.argv.includes('--check');
const banner = '// Copied from src/ by scripts/sync-core.mjs. Edit the file in src/ instead.\n';
const names = readdirSync(from).filter((f) => f.endsWith('.js'));
const stale = [];

if (!check) mkdirSync(to, { recursive: true });
for (const name of names) {
  const want = banner + readFileSync(join(from, name), 'utf8');
  const target = join(to, name);
  const have = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (have === want) continue;
  if (check) stale.push(target);
  else writeFileSync(target, want);
}
if (existsSync(to)) {
  for (const name of readdirSync(to)) {
    if (names.includes(name)) continue;
    if (check) stale.push(`${join(to, name)} (no source)`);
    else rmSync(join(to, name));
  }
}
if (stale.length) {
  console.error(`core copies are stale, run npm run core:\n${stale.join('\n')}`);
  process.exit(1);
}
console.log(check ? `core: ${names.length} modules in sync` : `core: ${names.length} modules copied to ${to}`);
