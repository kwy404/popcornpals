// House rules for every tracked or new text file: no emoji, no en or em dash
// characters, no names of other products, and no mention of who or what wrote
// the code. Names are assembled from parts so this file passes its own check.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const binary = /\.(png|jpe?g|gif|ico|webp|avif|pdf|ttf|otf|woff2?|wasm|mp3|ogg|webm|mp4|y4m|wav|zip)$/i;
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((f) => !binary.test(f) && f !== 'package-lock.json');

const w = (...parts) => parts.join('');
const brands = [
  w('net', 'flix'), w('dis', 'ney'), w('hu', 'lu'), w('h', 'bo'), w('twi', 'tch'), w('dis', 'cord'), w('tele', 'party'), w('watch', '2gether'),
  w('sync', 'play'), w('sce', 'ner'), w('vi', 'meo'), w('spo', 'tify'), w('crunchy', 'roll'), w('para', 'mount'), w('sky', 'pe'), w('whats', 'app'),
  w('tele', 'gram'), w('face', 'book'), w('insta', 'gram'), w('tik', 'tok'), w('air', 'drop'), w('tail', 'wind'), w('boot', 'strap'), w('bul', 'ma'),
  w('prime', ' video'), w('apple', ' tv'), w('zo', 'om meeting'),
];
const rules = [
  [new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`), 'an en or em dash'],
  [/\p{Extended_Pictographic}/u, 'an emoji'],
  [new RegExp(String.raw`\b(${brands.join('|')})\b`, 'i'), 'the name of another product'],
  [new RegExp(String.raw`\b(${w('Clau', 'de')}|${w('Anthro', 'pic')}|${w('Chat', 'GPT')}|${w('Co', 'pilot')}|${w('Open', 'A', 'I')}|${w('Gem', 'ini')})\b`, 'i'), 'a mention of an assistant'],
  [new RegExp(String.raw`\b${w('A', 'I')}\b`), 'a mention of generated code'],
];

const problems = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  text.split('\n').forEach((line, i) => {
    for (const [re, what] of rules) if (re.test(line)) problems.push(`${file}:${i + 1}: contains ${what}`);
  });
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`house rules: ${files.length} files clean`);
