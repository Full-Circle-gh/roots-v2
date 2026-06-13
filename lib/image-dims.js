// Tiny, dependency-free image-dimension reader.
//
// Reads only the header bytes of an encoded image to get its pixel width/height
// — no full decode, no `sharp` — so it's cheap enough to call inside a request
// handler (used by the product save path) and from a one-off backfill script.
// Supports the formats actually stored in store_products (JPEG, PNG) plus GIF
// and WebP for safety. Returns { width, height } or null when it can't tell.
//
// Input may be a `data:` URI, a bare base64 string, or a raw Buffer.

'use strict';

// Pull an image Buffer out of whatever the column holds. External http(s) URLs
// can't be measured synchronously here, so they return null (the mini-app
// self-corrects from the image's bindload event in that case).
function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (typeof input !== 'string' || !input) return null;
  const m = /^data:[^;,]*;base64,(.*)$/is.exec(input.trim());
  if (m) { try { return Buffer.from(m[1], 'base64'); } catch { return null; } }
  // A bare base64 blob (no data: prefix) — only treat as such when it isn't a URL.
  if (/^https?:\/\//i.test(input) || input.startsWith('/')) return null;
  try { return Buffer.from(input, 'base64'); } catch { return null; }
}

function pngSize(b) {
  // 8-byte signature, then IHDR chunk: length(4) "IHDR"(4) width(4) height(4)
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function gifSize(b) {
  if (b.length < 10 || b.toString('ascii', 0, 3) !== 'GIF') return null;
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function webpSize(b) {
  if (b.length < 30 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const fmt = b.toString('ascii', 12, 16);
  if (fmt === 'VP8 ') {                 // lossy
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (fmt === 'VP8L') {                 // lossless
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (fmt === 'VP8X') {                 // extended
    return { width: (b.readUIntLE(24, 3) & 0xffffff) + 1, height: (b.readUIntLE(27, 3) & 0xffffff) + 1 };
  }
  return null;
}

function jpegSize(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) { i++; continue; }           // skip fill bytes
    const marker = b[i + 1];
    // SOF0..SOF15 carry the frame size (skip the non-dimension DHT/DAC/RST/SOS).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > b.length) return null;
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (i + 4 > b.length) return null;
    i += 2 + b.readUInt16BE(i + 2);                  // jump past this segment
  }
  return null;
}

// → { width, height } | null
function imageDimensions(input) {
  const b = toBuffer(input);
  if (!b) return null;
  return pngSize(b) || jpegSize(b) || gifSize(b) || webpSize(b) || null;
}

// → aspect ratio (width / height) rounded to 4dp, or null when unknown / degenerate.
function imageAspect(input) {
  const d = imageDimensions(input);
  if (!d || !d.width || !d.height) return null;
  return Math.round((d.width / d.height) * 1e4) / 1e4;
}

module.exports = { imageDimensions, imageAspect };
