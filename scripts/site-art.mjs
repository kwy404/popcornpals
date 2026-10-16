// Draws the SVG pieces of the landing page into docs/assets/site/: the seat row
// with Rocco and Pip seen from behind, the valance, the sprocket mask of the
// film strips, the install guide mockups and the privacy diagram. Each piece
// that sits on a themed surface comes in a dark and a light version.
// Usage: node scripts/site-art.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'assets', 'site');
mkdirSync(out, { recursive: true });
const save = (name, svg) => {
  writeFileSync(join(out, name), `${svg.trim()}\n`);
  console.log(`wrote docs/assets/site/${name}`);
};

const FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const SERIF = "ui-serif, 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif";

const themes = {
  dark: {
    suffix: '-dark',
    bg: '#0A0A0B', s1: '#111113', s2: '#17171A', s3: '#1E1E22', s4: '#26262B',
    hair: 'rgba(255,255,255,0.10)', hair2: 'rgba(255,255,255,0.16)',
    ink: '#EDEDED', muted: '#8A8A8F', faint: '#3A3A40',
    accent: '#7A2633', accentInk: '#F3E9EA', ring: '#C9A1A6', butter: '#CDBB8E',
    rac: '#2A282F', racInner: '#1B1A1F', rim: '#FFF3E0', rimOp: 0.3,
    seatA: '#3E1119', seatB: '#140508', seam: 0.24, seatRim: 0.4, arm: '#1C080C', stripe: '#141317',
    glow: '#FFF3E0', glowOp: 0.08,
  },
  light: {
    suffix: '',
    bg: '#F5F3EF', s1: '#FFFFFF', s2: '#FAF8F5', s3: '#EFECE7', s4: '#E4E0DA',
    hair: 'rgba(0,0,0,0.10)', hair2: 'rgba(0,0,0,0.18)',
    ink: '#141416', muted: '#6B6B70', faint: '#C9C5BF',
    accent: '#7A2633', accentInk: '#FFFFFF', ring: '#9C4A55', butter: '#A8935E',
    rac: '#5A5862', racInner: '#7C7984', rim: '#FFFFFF', rimOp: 0.65,
    seatA: '#5E1A26', seatB: '#3E1119', seam: 0.14, seatRim: 0.8, arm: '#2A0B11', stripe: '#24232A',
    glow: '#FFF3E0', glowOp: 0.08,
  },
};

// One popcorn kernel, as drawn in the mascot art.
const kernel = (x, y, r = 0, s = 1) =>
  `<g transform="translate(${x} ${y}) rotate(${r}) scale(${s})"><circle cx="-4.5" cy="1" r="6.2" fill="#E9E1CF"/><circle cx="4.5" cy="1.5" r="5.8" fill="#E9E1CF"/><circle cx="0" cy="-3.8" r="6.2" fill="#E9E1CF"/><circle cx="1" cy="4.2" r="4.2" fill="#CDBB8E"/></g>`;

// ---------------------------------------------------------------------------
// The seat row: five cinema seats seen from behind, Rocco in the middle seat
// and Pip next to him, a shared bucket on the armrest, Pip's tail hanging down.
// ---------------------------------------------------------------------------
function seats(t) {
  const centers = [148, 324, 500, 676, 852];
  const back = (c) => {
    const l = c - 70;
    const r = c + 70;
    return `<path d="M${l} 660V204C${l} 186 ${l + 14} 176 ${l + 34} 175H${r - 34}C${r - 14} 176 ${r} 186 ${r} 204V660Z" fill="url(#seat)"/>
<path d="M${l + 4} 200C${l + 6} 186 ${l + 18} 178 ${l + 34} 178H${r - 34}C${r - 18} 178 ${r - 6} 186 ${r - 4} 200" fill="none" stroke="#C9A1A6" stroke-opacity="${t.seatRim}" stroke-width="1.6" stroke-linecap="round"/>
<path d="M${c - 23} 198V640M${c + 23} 198V640" stroke="#000" stroke-opacity="${t.seam}" stroke-width="1.6" stroke-linecap="round"/>
<rect x="${c - 11}" y="186" width="22" height="7" rx="2" fill="${t.butter}" opacity="0.5"/>`;
  };
  const arm = (g) => `<rect x="${g - 15}" y="234" width="30" height="430" rx="10" fill="${t.arm}"/><ellipse cx="${g}" cy="237" rx="11" ry="3.5" fill="#000" opacity="0.45"/>`;
  const head = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s})">
<ellipse cx="-38" cy="-40" rx="16" ry="20" transform="rotate(-22 -38 -40)" fill="${t.rac}" stroke="${t.rim}" stroke-opacity="${t.rimOp}" stroke-width="1.6"/>
<ellipse cx="38" cy="-40" rx="16" ry="20" transform="rotate(22 38 -40)" fill="${t.rac}" stroke="${t.rim}" stroke-opacity="${t.rimOp}" stroke-width="1.6"/>
<ellipse cx="-37" cy="-38" rx="8" ry="11" transform="rotate(-22 -37 -38)" fill="${t.racInner}" opacity="0.5"/>
<ellipse cx="37" cy="-38" rx="8" ry="11" transform="rotate(22 37 -38)" fill="${t.racInner}" opacity="0.5"/>
<path d="M-56 0C-58-30-32-48 0-48S58-30 56 0C57 8 63 14 70 18 56 26 44 42 0 46-44 42-56 26-70 18-63 14-57 8-56 0Z" fill="${t.rac}"/>
<path d="M-68 17C-62 13-57 7-56 0-58-30-32-48 0-48S58-30 56 0C57 7 62 13 68 17" fill="none" stroke="${t.rim}" stroke-opacity="${t.rimOp}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
</g>`;
  const body = (x, y, s) => `<path transform="translate(${x} ${y}) scale(${s * 0.88} ${s})" d="M-70 220C-74 110-58 56-30 40H30C58 56 74 110 70 220Z" fill="${t.rac}"/>`;
  const bucket = `<g transform="translate(588 236) scale(1.25) translate(0 -236)">
${kernel(-12, 190, 10, 0.9)}${kernel(4, 184, -20, 1)}${kernel(14, 192, 30, 0.85)}${kernel(-2, 196, 0, 0.8)}
<path d="M-21 198H21L16 238H-16Z" fill="#E9E1CF"/>
<path d="M-15 198H-8L-7 238H-12.5ZM-1.5 198H5L4.5 238H-1.5ZM11 198H17.5L13 238H9Z" fill="#7A2633"/>
<rect x="-22" y="196" width="44" height="5" rx="2.5" fill="#E9E1CF"/>
</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 640" width="1000" height="640" role="img">
<title>Rocco and Pip, seen from behind, in a row of five cinema seats, sharing a bucket of popcorn</title>
<defs>
<linearGradient id="seat" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.seatA}"/><stop offset="1" stop-color="${t.seatB}"/></linearGradient>
<radialGradient id="spot" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${t.glow}" stop-opacity="${t.glowOp}"/><stop offset="1" stop-color="${t.glow}" stop-opacity="0"/></radialGradient>
</defs>
<ellipse cx="588" cy="130" rx="300" ry="130" fill="url(#spot)"/>
${body(500, 116, 1.06)}${body(676, 128, 0.9)}
${centers.map(back).join('\n')}
${[60, 236, 412, 588, 764, 940].map(arm).join('')}
${bucket}
${head(500, 116, 1.06)}
${head(676, 128, 0.9)}
<path d="M540 174C554 178 566 184 576 190" fill="none" stroke="${t.rac}" stroke-width="13" stroke-linecap="round"/>
<ellipse cx="578" cy="191" rx="7.5" ry="6.5" fill="${t.racInner === '#1B1A1F' ? '#141317' : '#24232A'}"/>
<g>
<path d="M750 226C770 236 776 262 768 288 764 300 762 310 764 322" fill="none" stroke="${t.rac}" stroke-width="16" stroke-linecap="round"/>
<path d="M750 226C770 236 776 262 768 288 764 300 762 310 764 322" fill="none" stroke="${t.stripe}" stroke-width="16" stroke-dasharray="8 8" stroke-dashoffset="4" opacity="0.85"/>
</g>
</svg>`;
}

// ---------------------------------------------------------------------------
// The valance: one scallop of velvet with a muted butter trim, tiled sideways.
// ---------------------------------------------------------------------------
const valance = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 72" width="200" height="72" preserveAspectRatio="none">
<defs>
<linearGradient id="fold" x1="0" y1="0" x2="25" y2="0" gradientUnits="userSpaceOnUse" spreadMethod="reflect"><stop offset="0" stop-color="#1A070B"/><stop offset="0.55" stop-color="#3A1018"/><stop offset="1" stop-color="#561824"/></linearGradient>
<linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0.45"/><stop offset="1" stop-color="#000" stop-opacity="0.1"/></linearGradient>
</defs>
<path d="M0 0H200V40C180 74 120 74 100 40C80 74 20 74 0 40Z" fill="url(#fold)"/>
<path d="M0 0H200V40C180 74 120 74 100 40C80 74 20 74 0 40Z" fill="url(#shade)"/>
<path d="M0 40C20 74 80 74 100 40C120 74 180 74 200 40" fill="none" stroke="#CDBB8E" stroke-opacity="0.35" stroke-width="1.5"/>
</svg>`;

// The sprocket mask: opaque film with one rounded hole; tiled down each edge.
const sprocket = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 32" width="40" height="32">
<path fill-rule="evenodd" fill="#000" d="M0 0H40V32H0ZM14 9H26A3 3 0 0 1 29 12V20A3 3 0 0 1 26 23H14A3 3 0 0 1 11 20V12A3 3 0 0 1 14 9Z"/>
</svg>`;

// ---------------------------------------------------------------------------
// Install guide mockups, drawn like quiet screenshots.
// ---------------------------------------------------------------------------
const text = (t, x, y, str, { size = 13, weight = 400, color, anchor = 'start', serif = false } = {}) =>
  `<text x="${x}" y="${y}" font-family="${serif ? SERIF : FONT}" font-size="${size}" font-weight="${weight}" fill="${color || t.ink}" text-anchor="${anchor}">${str}</text>`;

const pointer = (x, y, t) =>
  `<path transform="translate(${x} ${y})" d="M0 0L0 17L4.5 13L7.5 20L10.5 18.7L7.6 12H13.5Z" fill="${t.ink}" stroke="${t.bg}" stroke-width="1.4" stroke-linejoin="round"/>`;

// A browser window with a tab and an address bar, with no names on it.
function browser(t, inner, { tab = 'Extensions', icon = '' } = {}) {
  return `<rect x="8" y="8" width="544" height="324" rx="14" fill="${t.s1}" stroke="${t.hair2}"/>
<path d="M8 22A14 14 0 0 1 22 8H538A14 14 0 0 1 552 22V44H8Z" fill="${t.s3}"/>
<circle cx="28" cy="27" r="4.5" fill="${t.faint}"/><circle cx="43" cy="27" r="4.5" fill="${t.faint}"/><circle cx="58" cy="27" r="4.5" fill="${t.faint}"/>
<path d="M80 44V24A6 6 0 0 1 86 18H206A6 6 0 0 1 212 24V44Z" fill="${t.s1}"/>
${text(t, 94, 35, tab, { size: 11.5, color: t.muted })}
<rect x="20" y="54" width="${icon ? 470 : 520}" height="24" rx="12" fill="${t.s3}"/>
<rect x="36" y="63" width="120" height="6" rx="3" fill="${t.faint}"/>
${icon}
<path d="M8 88H552" stroke="${t.hair}"/>
${inner}`;
}

const toggle = (t, x, y, on = true) =>
  `<rect x="${x}" y="${y}" width="38" height="22" rx="11" fill="${on ? t.accent : t.faint}"/><circle cx="${on ? x + 27 : x + 11}" cy="${y + 11}" r="8" fill="${on ? t.accentInk : t.s1}"/>`;

const folderIcon = (t, x, y, color) =>
  `<path transform="translate(${x} ${y})" d="M0 4A3 3 0 0 1 3 1H10L13 4H25A3 3 0 0 1 28 7V20A3 3 0 0 1 25 23H3A3 3 0 0 1 0 20Z" fill="${color || t.butter}" opacity="0.85"/>`;

const zipIcon = (t, x, y) => `<g transform="translate(${x} ${y})">
<path d="M2 0H17L24 7V28A2 2 0 0 1 22 30H2A2 2 0 0 1 0 28V2A2 2 0 0 1 2 0Z" fill="${t.s4}" stroke="${t.hair2}"/>
<path d="M10 2V4M12 5V7M10 8V10M12 11V13M10 14V16" stroke="${t.muted}" stroke-width="2"/>
<rect x="8" y="17" width="6" height="7" rx="1.5" fill="none" stroke="${t.muted}" stroke-width="1.5"/>
</g>`;

function install1(t) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 340" width="560" height="340" role="img">
<title>A downloads folder: the zip file is unzipped into a folder named popcornpals-extension</title>
<rect x="8" y="8" width="544" height="324" rx="14" fill="${t.s1}" stroke="${t.hair2}"/>
<path d="M8 22A14 14 0 0 1 22 8H538A14 14 0 0 1 552 22V48H8Z" fill="${t.s3}"/>
<circle cx="28" cy="28" r="4.5" fill="${t.faint}"/><circle cx="43" cy="28" r="4.5" fill="${t.faint}"/><circle cx="58" cy="28" r="4.5" fill="${t.faint}"/>
${folderIcon(t, 80, 17, t.faint)}${text(t, 116, 33, 'Downloads', { size: 13, weight: 600 })}
<path d="M8 48H552" stroke="${t.hair}"/>
<rect x="36" y="74" width="488" height="58" rx="10" fill="${t.s2}" stroke="${t.hair}"/>
${zipIcon(t, 56, 88)}
${text(t, 96, 102, 'popcornpals-extension-0.1.0.zip', { size: 14, weight: 500 })}
${text(t, 96, 120, 'Compressed file', { size: 11.5, color: t.muted })}
${text(t, 500, 108, '38 KB', { size: 12, color: t.muted, anchor: 'end' })}
<path d="M280 146V188" stroke="${t.ring}" stroke-width="1.6" stroke-dasharray="3 5" stroke-linecap="round"/>
<path d="M272 182L280 192L288 182" fill="none" stroke="${t.ring}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
<rect x="302" y="154" width="62" height="24" rx="12" fill="${t.s3}"/>
${text(t, 333, 170, 'unzip', { size: 12, color: t.muted, anchor: 'middle' })}
<rect x="36" y="204" width="488" height="58" rx="10" fill="${t.s2}" stroke="${t.ring}" stroke-width="1.6"/>
<rect x="31" y="199" width="498" height="68" rx="14" fill="none" stroke="${t.ring}" stroke-opacity="0.25" stroke-width="4"/>
${folderIcon(t, 54, 220)}
${text(t, 96, 232, 'popcornpals-extension', { size: 14, weight: 600 })}
${text(t, 96, 250, 'Folder', { size: 11.5, color: t.muted })}
${pointer(470, 236, t)}
<rect x="36" y="282" width="210" height="8" rx="4" fill="${t.s3}"/><rect x="36" y="298" width="140" height="8" rx="4" fill="${t.s3}"/>
</svg>`;
}

function install2(t) {
  const inner = `${text(t, 36, 126, 'Extensions', { size: 22, weight: 600, serif: true })}
${text(t, 400, 124, 'Developer mode', { size: 13, weight: 500, anchor: 'end' })}
<rect x="408" y="104" width="56" height="34" rx="17" fill="none" stroke="${t.ring}" stroke-opacity="0.35" stroke-width="4"/>
${toggle(t, 417, 110, true)}
${pointer(446, 124, t)}
<path d="M8 152H552" stroke="${t.hair}"/>
<rect x="36" y="172" width="236" height="132" rx="12" fill="${t.s2}" stroke="${t.hair}"/>
<rect x="288" y="172" width="236" height="132" rx="12" fill="${t.s2}" stroke="${t.hair}"/>
<rect x="54" y="192" width="30" height="30" rx="8" fill="${t.s4}"/><rect x="96" y="196" width="110" height="8" rx="4" fill="${t.faint}"/><rect x="96" y="212" width="70" height="6" rx="3" fill="${t.s4}"/>
<rect x="54" y="238" width="190" height="6" rx="3" fill="${t.s4}"/><rect x="54" y="252" width="150" height="6" rx="3" fill="${t.s4}"/>
${toggle(t, 218, 272, false)}
<rect x="306" y="192" width="30" height="30" rx="8" fill="${t.s4}"/><rect x="348" y="196" width="96" height="8" rx="4" fill="${t.faint}"/><rect x="348" y="212" width="60" height="6" rx="3" fill="${t.s4}"/>
<rect x="306" y="238" width="190" height="6" rx="3" fill="${t.s4}"/><rect x="306" y="252" width="120" height="6" rx="3" fill="${t.s4}"/>
${toggle(t, 470, 272, false)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 340" width="560" height="340" role="img">
<title>The extensions page of the browser, with the developer mode switch turned on</title>
${browser(t, inner)}
</svg>`;
}

function install3(t) {
  const btn = (x, w, label, hot) =>
    `<rect x="${x}" y="104" width="${w}" height="30" rx="8" fill="${hot ? t.accent : 'none'}" stroke="${hot ? t.accent : t.hair2}"/>${text(t, x + w / 2, 123, label, { size: 12.5, weight: 500, anchor: 'middle', color: hot ? t.accentInk : t.muted })}`;
  const inner = `${btn(36, 124, 'Load unpacked', true)}<rect x="31" y="99" width="134" height="40" rx="12" fill="none" stroke="${t.ring}" stroke-opacity="0.35" stroke-width="4"/>
${btn(172, 124, 'Pack extension', false)}${btn(308, 80, 'Update', false)}
<path d="M8 150H552" stroke="${t.hair}"/>
<rect x="60" y="160" width="440" height="164" rx="12" fill="${t.s2}" stroke="${t.hair2}"/>
${text(t, 80, 186, 'Select a folder', { size: 13.5, weight: 600 })}
${text(t, 480, 186, 'Downloads', { size: 11.5, color: t.muted, anchor: 'end' })}
<rect x="76" y="198" width="408" height="34" rx="8" fill="${t.accent}" fill-opacity="0.22" stroke="${t.ring}" stroke-width="1.4"/>
${folderIcon(t, 88, 203)}${text(t, 126, 220, 'popcornpals-extension', { size: 13, weight: 600 })}
${zipIcon(t, 92, 240)}${text(t, 126, 260, 'popcornpals-extension-0.1.0.zip', { size: 13, color: t.muted })}
<rect x="380" y="284" width="104" height="28" rx="8" fill="${t.accent}"/>${text(t, 432, 302, 'Select folder', { size: 12, weight: 500, anchor: 'middle', color: t.accentInk })}
${pointer(478, 306, t)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 340" width="560" height="340" role="img">
<title>Load unpacked opens a folder picker, where the popcornpals-extension folder is selected</title>
${browser(t, inner)}
</svg>`;
}

function install4(t) {
  const tool = `<rect x="502" y="52" width="32" height="28" rx="8" fill="${t.accent}" fill-opacity="0.25" stroke="${t.ring}" stroke-width="1.4"/>
<g transform="translate(506 54) scale(1)" fill="none" stroke="${t.ink}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10.5l1.4 9.9a1 1 0 0 0 1 .6h7.2a1 1 0 0 0 1-.6l1.4-9.9"/><path d="M5.6 10.5a2.25 2.25 0 0 1 1.7-3.9A2.6 2.6 0 0 1 12 5a2.6 2.6 0 0 1 4.7 1.6 2.25 2.25 0 0 1 1.7 3.9z"/></g>`;
  const inner = `<rect x="24" y="102" width="320" height="190" rx="10" fill="#0A0A0B" stroke="${t.hair}"/>
<circle cx="230" cy="160" r="20" fill="#E9E1CF" opacity="0.75"/>
<path d="M24 236C90 206 150 214 206 238S300 230 344 214V282A10 10 0 0 1 334 292H34A10 10 0 0 1 24 282Z" fill="#5E1A26" opacity="0.9"/>
<path d="M44 274H324" stroke="rgba(255,255,255,0.25)" stroke-width="3" stroke-linecap="round"/><path d="M44 274H170" stroke="#C9A1A6" stroke-width="3" stroke-linecap="round"/><circle cx="170" cy="274" r="5" fill="#EDEDED"/>
${text(t, 24, 314, 'The video on the streaming site, in your own account', { size: 11.5, color: t.muted })}
<path d="M512 86L518 92H506Z" fill="${t.s2}"/>
<rect x="320" y="90" width="222" height="214" rx="12" fill="${t.s2}" stroke="${t.hair2}"/>
<g transform="translate(334 102)" fill="none" stroke="${t.ink}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10.5l1.4 9.9a1 1 0 0 0 1 .6h7.2a1 1 0 0 0 1-.6l1.4-9.9"/><path d="M5.6 10.5a2.25 2.25 0 0 1 1.7-3.9A2.6 2.6 0 0 1 12 5a2.6 2.6 0 0 1 4.7 1.6 2.25 2.25 0 0 1 1.7 3.9z"/></g>
${text(t, 364, 120, 'popcornpals sync', { size: 13, weight: 600 })}
<path d="M320 134H542" stroke="${t.hair}"/>
<circle cx="340" cy="153" r="4" fill="${t.butter}"/>${text(t, 352, 157, 'popcornpals tab connected', { size: 11.5 })}
<circle cx="340" cy="177" r="4" fill="${t.faint}"/>${text(t, 352, 181, 'This tab: video.example', { size: 11.5 })}
<rect x="334" y="196" width="194" height="34" rx="9" fill="${t.accent}"/>
<rect x="329" y="191" width="204" height="44" rx="13" fill="none" stroke="${t.ring}" stroke-opacity="0.35" stroke-width="4"/>
${text(t, 431, 218, 'Sync this tab with my room', { size: 12, weight: 600, anchor: 'middle', color: t.accentInk })}
${pointer(516, 222, t)}
<rect x="334" y="250" width="190" height="6" rx="3" fill="${t.s4}"/><rect x="334" y="264" width="160" height="6" rx="3" fill="${t.s4}"/><rect x="334" y="278" width="120" height="6" rx="3" fill="${t.s4}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 340" width="560" height="340" role="img">
<title>On the streaming site tab, the popcornpals button in the toolbar opens a small panel with the button Sync this tab with my room</title>
${browser(t, inner, { tab: 'Your video', icon: tool })}
</svg>`;
}

// ---------------------------------------------------------------------------
// Privacy diagram: three devices joined directly, a relay used only to pair.
// ---------------------------------------------------------------------------
function privacy(t) {
  const screen = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="#1A1519"/>
<circle cx="${x + w * 0.66}" cy="${y + h * 0.34}" r="${h * 0.14}" fill="#E9E1CF" opacity="0.8"/>
<path d="M${x} ${y + h * 0.72}C${x + w * 0.3} ${y + h * 0.55} ${x + w * 0.6} ${y + h * 0.66} ${x + w} ${y + h * 0.6}V${y + h}H${x}Z" fill="#5E1A26"/>`;
  const lock = (x, y) => `<g transform="translate(${x - 12} ${y - 12})"><circle cx="12" cy="12" r="14" fill="${t.s1}" stroke="${t.hair2}"/><g fill="none" stroke="${t.ring}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="11" width="10" height="8" rx="2"/><path d="M9 11V8.8a3 3 0 0 1 6 0V11"/></g></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 430" width="720" height="430" role="img">
<title>Three devices connected straight to each other with encrypted links; a public relay above them only passes the encrypted pairing handshake</title>
<rect x="250" y="20" width="220" height="62" rx="14" fill="${t.s2}" stroke="${t.hair2}" stroke-dasharray="5 5"/>
${text(t, 360, 47, 'Public pairing relay', { size: 14, weight: 600, anchor: 'middle' })}
${text(t, 360, 67, 'sees only encrypted handshake data', { size: 11.5, color: t.muted, anchor: 'middle' })}
<path d="M300 82L150 204M360 82V192M420 82L570 200" stroke="${t.muted}" stroke-opacity="0.6" stroke-width="1.4" stroke-dasharray="2 7" stroke-linecap="round"/>
<path d="M228 258H318M402 258H490M150 330C150 380 570 380 570 322" fill="none" stroke="${t.ring}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
<g>
<rect x="72" y="208" width="156" height="98" rx="8" fill="${t.s3}" stroke="${t.hair2}"/>${screen(80, 216, 140, 82)}
<path d="M56 312H244L236 322H64Z" fill="${t.s4}" stroke="${t.hair2}"/>
</g>
<g>
<rect x="318" y="196" width="84" height="150" rx="14" fill="${t.s3}" stroke="${t.hair2}"/>${screen(326, 214, 68, 110)}
</g>
<g>
<rect x="490" y="204" width="160" height="104" rx="8" fill="${t.s3}" stroke="${t.hair2}"/>${screen(498, 212, 144, 88)}
<path d="M560 308V320M536 322H584" stroke="${t.s4}" stroke-width="5" stroke-linecap="round"/>
</g>
${lock(273, 258)}${lock(446, 258)}${lock(360, 367)}
${text(t, 360, 418, 'Video, voice and chat go device to device, encrypted with DTLS', { size: 13, weight: 500, anchor: 'middle' })}
</svg>`;
}

for (const t of Object.values(themes)) {
  save(`seats${t.suffix}.svg`, seats(t));
  save(`install-1${t.suffix}.svg`, install1(t));
  save(`install-2${t.suffix}.svg`, install2(t));
  save(`install-3${t.suffix}.svg`, install3(t));
  save(`install-4${t.suffix}.svg`, install4(t));
  save(`private${t.suffix}.svg`, privacy(t));
}
save('valance.svg', valance);
save('sprocket.svg', sprocket);
