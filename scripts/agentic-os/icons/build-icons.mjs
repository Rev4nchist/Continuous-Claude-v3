// Draws the two Fleet shortcut icons and packs each into a Windows .ico file.
//   fleet.ico       the "Fleet" shortcut: a paper-boat fleet at sea, in daylight.
//   fleet-stop.ico  the "Fleet - stop" shortcut: the same boat asleep at night, with a red stop badge.
// The drawing is code, so this file is the source of both icons. Run it again after a change:
//   node scripts/agentic-os/icons/build-icons.mjs [--preview <folder>]
// It needs `sharp`, which is installed with the app (apps/agentic-os/node_modules). No network.
// Sizes 16 to 32 use a simple drawing (one boat, no face): the full drawing is mud at that size.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..', '..', '..', 'apps', 'agentic-os');
const sharp = createRequire(path.join(appDir, 'package.json'))('sharp');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SIMPLE_UP_TO = 32;

const THEME = {
  go: { skyTop: '#312e81', skyBottom: '#0e7490', waveBack: '#14b8a6', waveFront: '#10b981', ink: '#1e1b4b' },
  stop: { skyTop: '#0f172a', skyBottom: '#334155', waveBack: '#475569', waveFront: '#64748b', ink: '#0f172a' },
};

// A row of wave crests from x=0 to x=256 at height y, closed down to the bottom edge.
function wave(y, step, lift, fill) {
  let d = `M-${step} ${y}`;
  for (let x = -step; x < 256 + step; x += step) d += ` q${step / 2} -${lift * 2} ${step} 0`;
  return `<path d="${d} V256 H-${step} Z" fill="${fill}"/>`;
}

// The origami boat: a two-tone sail, a two-tone hull and a flag. Drawn around x=128.
function boat({ face, asleep, ink }) {
  const awake = `<circle cx="108" cy="176" r="5.5" fill="${ink}"/><circle cx="148" cy="176" r="5.5" fill="${ink}"/>`;
  const sleeping =
    `<path d="M101 176 q7 6 14 0 M141 176 q7 6 14 0" fill="none" stroke="${ink}" stroke-width="4" stroke-linecap="round"/>`;
  const smile = `<path d="M116 186 q12 10 24 0" fill="none" stroke="${ink}" stroke-width="4" stroke-linecap="round"/>`;
  const cheeks = `<circle cx="96" cy="186" r="6" fill="#fb7185" opacity=".7"/><circle cx="160" cy="186" r="6" fill="#fb7185" opacity=".7"/>`;
  return [
    '<path d="M128 66 V40" stroke="#f8fafc" stroke-width="5" stroke-linecap="round"/>',
    '<path d="M128 38 L100 47 L128 58 Z" fill="#fb7185"/>',
    '<path d="M128 62 L82 150 H128 Z" fill="#ffffff"/>',
    '<path d="M128 62 L174 150 H128 Z" fill="#cbd5e1"/>',
    '<path d="M48 154 H208 L174 210 H82 Z" fill="#f8fafc"/>',
    '<path d="M128 154 H208 L174 210 H128 Z" fill="#e2e8f0"/>',
    face ? (asleep ? sleeping : awake) + smile + cheeks : '',
  ].join('');
}

// A small plain boat for the two followers.
const follower =
  '<path d="M0 -62 L-30 0 H0 Z" fill="#ffffff"/><path d="M0 -62 L30 0 H0 Z" fill="#cbd5e1"/>' +
  '<path d="M-46 4 H46 L28 36 H-28 Z" fill="#f1f5f9"/>';

function drawing(variant, simple) {
  const t = THEME[variant];
  const stop = variant === 'stop';
  const sun = stop
    ? '<mask id="m"><rect width="256" height="256" fill="#fff"/><circle cx="204" cy="62" r="26" fill="#000"/></mask>' +
      '<circle cx="190" cy="72" r="30" fill="#e2e8f0" mask="url(#m)"/>'
    : '<circle cx="192" cy="72" r="44" fill="#fbbf24" opacity=".22"/><circle cx="192" cy="72" r="30" fill="#fbbf24"/>';
  const stars = stop
    ? '<g fill="#f8fafc"><circle cx="52" cy="54" r="3"/><circle cx="92" cy="34" r="2.5"/><circle cx="150" cy="40" r="2"/><circle cx="34" cy="104" r="2"/></g>'
    : '<g fill="#f8fafc" opacity=".75"><circle cx="52" cy="54" r="3"/><circle cx="92" cy="34" r="2.5"/></g>';
  const zzz = stop && !simple
    ? `<g fill="none" stroke="#f8fafc" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity=".9">` +
      '<path d="M40 126 h18 l-18 20 h18"/><path d="M70 96 h12 l-12 14 h12"/></g>'
    : '';
  const fleet = simple || stop
    ? ''
    : `<g transform="translate(222 160) scale(.5)">${follower}</g><g transform="translate(34 162) scale(.42)">${follower}</g>`;
  const badge = stop
    ? (simple
        ? '<circle cx="186" cy="186" r="58" fill="#ef4444" stroke="#ffffff" stroke-width="12"/><rect x="162" y="162" width="48" height="48" rx="8" fill="#ffffff"/>'
        : '<circle cx="196" cy="196" r="44" fill="#ef4444" stroke="#ffffff" stroke-width="9"/><rect x="178" y="178" width="36" height="36" rx="7" fill="#ffffff"/>')
    : '';
  const mainBoat = simple
    ? `<g transform="translate(128 132) scale(1.16) translate(-128 -132)">${boat({ face: false, ink: t.ink })}</g>`
    : boat({ face: true, asleep: stop, ink: t.ink });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.skyTop}"/><stop offset="1" stop-color="${t.skyBottom}"/></linearGradient>
<clipPath id="tile"><rect x="6" y="6" width="244" height="244" rx="56"/></clipPath>
</defs>
<g clip-path="url(#tile)">
<rect width="256" height="256" fill="url(#sky)"/>
${sun}${stars}${zzz}
${simple ? '' : wave(182, 32, 7, t.waveBack)}
${fleet}
${mainBoat}
${wave(simple ? 214 : 210, simple ? 64 : 40, simple ? 10 : 8, t.waveFront)}
</g>
${badge}
</svg>`;
}

// An .ico file: a 6-byte header, one 16-byte entry per image, then the PNG data of each image.
function packIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size === 256 ? 0 : size, 0);
    e.writeUInt8(size === 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

const previewAt = process.argv.indexOf('--preview');
const previewDir = previewAt > 0 ? process.argv[previewAt + 1] : '';
if (previewDir) fs.mkdirSync(previewDir, { recursive: true });

for (const [variant, name] of [['go', 'fleet'], ['stop', 'fleet-stop']]) {
  const images = [];
  for (const size of SIZES) {
    const svg = Buffer.from(drawing(variant, size <= SIMPLE_UP_TO));
    const png = await sharp(svg, { density: 72 * (size / 256) * 4 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
    images.push({ size, png });
    if (previewDir) fs.writeFileSync(path.join(previewDir, `${name}-${size}.png`), png);
  }
  const out = path.join(here, `${name}.ico`);
  fs.writeFileSync(out, packIco(images));
  console.log(`${out}  ${fs.statSync(out).size} bytes  sizes ${SIZES.join(', ')}`);
}
