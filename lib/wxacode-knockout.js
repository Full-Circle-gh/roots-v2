// lib/wxacode-knockout.js — make a WeChat 小程序码 sit on a coloured surface.
//
// WeChat's `is_hyaline: true` clears only the OUTER background. Two opaque
// white areas survive it, both measured on a real 430×430 code:
//
//   1. a solid disc behind the centre mini-program logo (radius ≈ 96/215 of
//      the half-width, i.e. ~0.45 of the radius), and
//   2. a white surround ring around the green WeChat badge.
//
// Dropped onto the affiliate card's lime slab, both read as white patches.
// This knocks them out while keeping the code scannable:
//
//   • Only those two regions are touched. The scan marks themselves are left
//     byte-for-byte alone — reducing their alpha would hurt scan reliability.
//   • Inside the regions, alpha is taken from luminance (white → clear,
//     black → solid) and RGB is replaced with the brand ink. That keeps the
//     logo's anti-aliased edges smooth against whatever colour is behind it,
//     instead of leaving grey fringes.
//   • The green badge's own disc is skipped, because the WeChat mark inside
//     it is white — knocking that out would punch a hole through the badge.
//
// Pure zlib, no image dependency, same as lib/qrpng.js.
'use strict';
const zlib = require('zlib');

// ── PNG (RGBA, 8-bit, non-interlaced) ──────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let x = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) x = CRC_TABLE[(x ^ buf[i]) & 255] ^ (x >>> 8);
  return (x ^ 0xFFFFFFFF) >>> 0;
}

function decodeRgba(buf) {
  if (buf.length < 8 || buf[0] !== 0x89 || buf.toString('latin1', 1, 4) !== 'PNG') {
    throw new Error('not a PNG');
  }
  let off = 8, w = 0, h = 0, colorType = -1, bitDepth = 0, interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  // Only the shape WeChat actually sends. Anything else is left alone by the
  // caller rather than guessed at.
  if (colorType !== 6 || bitDepth !== 8 || interlace !== 0) {
    throw new Error(`unsupported PNG (colorType ${colorType}, depth ${bitDepth}, interlace ${interlace})`);
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const px = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const row = px.slice(y * stride, (y + 1) * stride);
    raw.copy(row, 0, p, p + stride);
    p += stride;
    const prev = y ? px.slice((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? row[i - 4] : 0;
      const b = prev ? prev[i] : 0;
      const c = (prev && i >= 4) ? prev[i - 4] : 0;
      let v = row[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      row[i] = v & 255;
    }
  }
  return { w, h, px };
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 8 + data.length);
  return out;
}

function encodeRgba({ w, h, px }) {
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;                       // filter 0 (None)
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Knockout ───────────────────────────────────────────────────────────────
// Fraction of the image radius covered by the centre logo plate. Measured at
// 96/215 = 0.446 on a real code; 0.47 leaves a little margin without reaching
// the innermost scan marks, which start around 0.49.
const PLATE_R  = 0.47;
// The badge's own disc (keep) and the white ring around it (knock out), as a
// fraction of image width. A radial profile of a real code puts the last green
// pixel at r=40 of 430 (0.093) — the naive πr² estimate from the filled-pixel
// count says 34.8, which is too small and shaves the badge's anti-aliased rim.
// 0.100 keeps the whole disc; the ring beyond it is where the white surround
// sits.
const BADGE_R  = 0.090;
const BADGE_PAD = 0.055;

function findGreenBadge(w, h, px) {
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (px[i + 3] > 200 && px[i + 1] > 120 && px[i] < 100 && px[i + 2] < 120) {
        sx += x; sy += y; n++;
      }
    }
  }
  // No green found (a code drawn in another colour scheme) — skip badge work.
  if (n < (w * h) / 400) return null;
  return { x: sx / n, y: sy / n };
}

/**
 * Clear the white plate behind the centre logo, and the white ring around the
 * WeChat badge, from an is_hyaline 小程序码.
 *
 * @param {Buffer} buf  PNG bytes from getwxacodeunlimit (is_hyaline: true)
 * @param {{r:number,g:number,b:number}} ink  colour to redraw the logo in
 * @returns {Buffer} PNG bytes. Returns the input untouched if it isn't a
 *                   shape we can safely edit — a slightly-wrong background is
 *                   far better than a corrupted or unscannable code.
 */
function clearLogoPlate(buf, ink = { r: 26, g: 26, b: 23 }) {
  let img;
  try { img = decodeRgba(buf); }
  catch (e) { return buf; }

  const { w, h, px } = img;
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const plateR = Math.min(w, h) / 2 * PLATE_R;
  const badge = findGreenBadge(w, h, px);
  const badgeR = w * BADGE_R;
  const badgeOuter = badgeR + w * BADGE_PAD;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (px[i + 3] === 0) continue;                 // already clear

      const inPlate = Math.hypot(x - cx, y - cy) <= plateR;
      let inBadgeRing = false;
      if (badge) {
        const d = Math.hypot(x - badge.x, y - badge.y);
        if (d <= badgeR) continue;                   // the badge itself — keep
        inBadgeRing = d <= badgeOuter;
      }
      if (!inPlate && !inBadgeRing) continue;        // scan marks — never touch

      const lum = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;

      // The badge ring holds two things: WeChat's white keyline, which has to
      // go, and the green disc's anti-aliased rim, which must not. Radius
      // alone can't separate them to the pixel, so only near-neutral, light
      // pixels are cleared here — anything still carrying colour is the badge.
      if (inBadgeRing && !inPlate) {
        const max = Math.max(px[i], px[i + 1], px[i + 2]);
        const min = Math.min(px[i], px[i + 1], px[i + 2]);
        if (lum < 190 || max - min > 24) continue;   // coloured → part of the badge
        px[i + 3] = 0;
        continue;
      }

      // Inside the plate, luminance drives alpha: the white disc disappears,
      // the logo's strokes stay solid, and its anti-aliased edges keep a
      // smooth ramp onto whatever colour sits behind the code.
      px[i]     = ink.r;
      px[i + 1] = ink.g;
      px[i + 2] = ink.b;
      px[i + 3] = Math.max(0, Math.min(255, Math.round(255 - lum)));
    }
  }
  return encodeRgba(img);
}

module.exports = { clearLogoPlate, decodeRgba, encodeRgba };
