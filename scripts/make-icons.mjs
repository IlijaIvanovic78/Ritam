// Pravi logo i ikonice iz fonta Pinyon Script (SIL OFL 1.1): slova se pretvaraju u SVG
// putanje, pa aplikacija ne učitava font i logo je oštar u svakoj veličini.
//
// Alati nisu zavisnosti projekta; instaliraj ih privremeno bilo gde i pokaži putanju:
//   npm i --prefix <folder> opentype.js @resvg/resvg-js @fontsource/pinyon-script
//   ICON_DEPS=<folder> node scripts/make-icons.mjs
//
// Izlaz: web/src/ui/wordmarkPath.ts, web/public/favicon.svg, web/public/icons/*.png

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const depsDir = process.env.ICON_DEPS ? path.resolve(process.env.ICON_DEPS) : ROOT;
const req = createRequire(path.join(depsDir, 'node_modules', 'noop.js'));

async function load(name) {
  try {
    return await import(pathToFileURL(req.resolve(name)).href);
  } catch {
    console.error(`Nedostaje "${name}". Pogledaj uputstvo na vrhu scripts/make-icons.mjs.`);
    process.exit(1);
  }
}

const opentype = (await load('opentype.js')).default;
const { Resvg } = await load('@resvg/resvg-js');
const fontFile = req.resolve('@fontsource/pinyon-script/files/pinyon-script-latin-400-normal.woff');
const buf = readFileSync(fontFile);
const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

/** Putanja teksta pomerena u (pad, pad), sa tesnim okvirom. */
function glyphs(text, size = 100, pad = 1) {
  const b = font.getPath(text, 0, 0, size, { kerning: true }).getBoundingBox();
  const p = font.getPath(text, pad - b.x1, pad - b.y1, size, { kerning: true });
  return { d: p.toPathData(1), w: Math.ceil(b.x2 - b.x1 + pad * 2), h: Math.ceil(b.y2 - b.y1 + pad * 2) };
}

const BG = '#0a0a0a';
const FG = '#ededeb';
const mono = glyphs('R');
const word = glyphs('Ritam');

/** Crna podloga + "R", centrirano. radius i scale su udeo veličine ikonice. */
function iconSvg(size, { radius = 0, scale = 0.5 } = {}) {
  const h = size * scale;
  const k = h / mono.h;
  const x = (size - mono.w * k) / 2;
  const y = (size - h) / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" rx="${(radius * size).toFixed(2)}" fill="${BG}"/>` +
    `<path transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${k.toFixed(4)})" fill="${FG}" d="${mono.d}"/>` +
    `</svg>`
  );
}

const iconsDir = path.join(ROOT, 'web/public/icons');
mkdirSync(iconsDir, { recursive: true });
const png = (svg, file) => writeFileSync(path.join(iconsDir, file), new Resvg(svg).render().asPng());

png(iconSvg(192, { radius: 0.22 }), 'icon-192.png');
png(iconSvg(512, { radius: 0.22 }), 'icon-512.png');
png(iconSvg(512, { scale: 0.4 }), 'maskable-512.png'); // sadržaj u sigurnoj zoni (centralnih 60%)
png(iconSvg(180, { scale: 0.52 }), 'apple-touch-icon.png'); // iOS sam zaobljava uglove
writeFileSync(
  path.join(ROOT, 'web/public/favicon.svg'),
  iconSvg(64, { radius: 0.22, scale: 0.62 }).replace(' width="64" height="64"', '') + '\n',
);

writeFileSync(
  path.join(ROOT, 'web/src/ui/wordmarkPath.ts'),
  `// Generisano: scripts/make-icons.mjs (Pinyon Script, SIL OFL 1.1). Ne menjaj ručno.\n` +
    `export const WORDMARK = { width: ${word.w}, height: ${word.h}, d: '${word.d}' };\n`,
);

console.log('Ikonice, favicon i logo su generisani.');
