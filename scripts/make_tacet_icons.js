#!/usr/bin/env node
/**
 * Draws the installed-app icons for Tacet Mobile (public/m.html).
 *
 *   node scripts/make_tacet_icons.js
 *
 * The mark is the one in public/tacet-favicon.svg — the waveform settling into
 * the Dusk dot — at three crests, because more smears at launcher size. Kept as
 * a script rather than four checked-in binaries nobody can edit: when the mark
 * moves, this moves with it and the PNGs are regenerated, not redrawn by hand.
 *
 * Two purposes, and they are NOT the same drawing:
 *   • any      — a rounded tile, the way iOS and desktop show it.
 *   • maskable — full bleed, mark inside the middle 60%. Android crops an icon
 *                to whatever shape the launcher uses (circle, squircle, teardrop),
 *                so anything outside that safe zone can be cut off. A rounded
 *                tile shipped as maskable gets its corners clipped and reads as
 *                a smaller square floating in a circle.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const PAPER = '#F6F3EC';   // --raised: the mark's own ground in the design system
const INK   = '#111A2B';   // --ink
const DUSK  = '#6E67AF';   // --dusk

// The favicon path, in its own 64-unit box. Everything below scales it.
const WAVE = 'M10 32 C14 16, 18 48, 22 32 C26 19, 30 45, 34 32 C37 24, 40 40, 43 32 L50 32';

// `inset` is how much of the 64-unit box the mark is pulled in by on each side:
// 0 for the rounded tile (the mark already has its own margin), and enough on
// the maskable one to land the whole thing inside the middle 60%.
function svg({ size, radius, scale }) {
  const off = (64 - 64 * scale) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="${radius}" fill="${PAPER}"/>
  <g transform="translate(${off} ${off}) scale(${scale})">
    <path d="${WAVE}" stroke="${INK}" stroke-width="3.8" stroke-linecap="round" fill="none"/>
    <circle cx="51" cy="32" r="6" fill="${DUSK}"/>
  </g>
</svg>`;
}

const OUT = path.join(__dirname, '..', 'public');
const JOBS = [
  { file: 'tacet-icon-192.png',          size: 192, radius: 14, scale: 1 },
  { file: 'tacet-icon-512.png',          size: 512, radius: 14, scale: 1 },
  { file: 'tacet-icon-192-maskable.png', size: 192, radius: 0,  scale: 0.62 },
  { file: 'tacet-icon-512-maskable.png', size: 512, radius: 0,  scale: 0.62 },
  // iOS never rounds a corner it was given — it rounds the icon itself — so the
  // home-screen artwork is the square, not the tile.
  { file: 'tacet-apple-touch-icon.png',  size: 180, radius: 0,  scale: 0.78 },
];

(async () => {
  for (const j of JOBS) {
    const buf = Buffer.from(svg(j));
    // density renders the SVG large so curves come out clean, and resize() puts
    // it back to the size the manifest DECLARES. Without the resize, sharp
    // multiplies the SVG's own width by the density and a "192x192" icon ships
    // at 1024px — a manifest that lies about its icons, and a megabyte of it.
    await sharp(buf, { density: 384 })
      .resize(j.size, j.size)
      .png({ compressionLevel: 9, palette: true })
      .toFile(path.join(OUT, j.file));
    const kb = (fs.statSync(path.join(OUT, j.file)).size / 1024).toFixed(1);
    console.log(`  ${j.file.padEnd(30)} ${j.size}px  ${kb} kB`);
  }
  // The SVG the manifest offers alongside the PNGs, for anything that prefers it.
  fs.writeFileSync(path.join(OUT, 'tacet-icon.svg'), svg({ size: 512, radius: 14, scale: 1 }) + '\n');
  console.log('  tacet-icon.svg');
})().catch(e => { console.error(e); process.exit(1); });
