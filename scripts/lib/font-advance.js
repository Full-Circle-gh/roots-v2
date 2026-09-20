// HOW WIDE IS THAT LABEL, ACTUALLY — read off the shipped font file.
//
// THIS EXISTS BECAUSE THE BUTTON WAS SIZED TWICE FROM A GUESS AND WAS WRONG
// BOTH TIMES. §170's dated band overflowed the PDP's buy button; the first fix
// sized the label against `¥44`, which is what the SHOP LIST draws. The button
// draws `¥44.00` — 164rpx where `¥44` is 89 — so the label was still 25rpx too
// wide and WeChat quietly ellipsised it to `NEXT BATCH · TOMORRO…`. Reported by
// Ash from the PDP, 2026-09-20, against the fix for the same bug.
//
// A layout that only fits if someone guessed a string right is not fixed, it is
// lucky. So the suite measures: it reads the real advance widths out of
// public/fonts/*.otf and adds up the real strings the page can produce. A label
// that no longer fits fails a test instead of reaching a customer clipped.
//
// ENOUGH OF THE sfnt FORMAT TO GET ADVANCE WIDTHS, and nothing else — no
// shaping, no kerning, no ligatures. Toni Grotesk and Lilita One apply none of
// those to the strings this app draws (caps, digits, ¥, ·), so the sum of the
// advances IS the width. If a font with real kerning is ever added here, this
// will read slightly wide, which is the safe direction: it reports less room
// than there is.
'use strict';

const fs = require('fs');

// unitsPerEm lives at head+18; numberOfHMetrics at hhea+34. Both u16.
const HEAD_UPM = 18;
const HHEA_NUM_H_METRICS = 34;

function tableDirectory(buf) {
  // 'OTTO' (CFF outlines) and 0x00010000 (TrueType) share this header.
  const numTables = buf.readUInt16BE(4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    tables[buf.toString('ascii', rec, rec + 4)] = {
      offset: buf.readUInt32BE(rec + 8),
      length: buf.readUInt32BE(rec + 12),
    };
  }
  return tables;
}

// The subtable that maps a unicode codepoint to a glyph id. Prefer (3,10) —
// full Unicode, which is what carries the CJK the Chinese labels need — then
// (3,1), then (0,x). A font offering none of those is not one we draw with.
function pickCmapSubtable(buf, cmapOffset) {
  const n = buf.readUInt16BE(cmapOffset + 2);
  let best = null, bestScore = -1;
  for (let i = 0; i < n; i++) {
    const rec = cmapOffset + 4 + i * 8;
    const platform = buf.readUInt16BE(rec);
    const encoding = buf.readUInt16BE(rec + 2);
    const offset = buf.readUInt32BE(rec + 4);
    let score = -1;
    if (platform === 3 && encoding === 10) score = 3;
    else if (platform === 3 && encoding === 1) score = 2;
    else if (platform === 0) score = 1;
    if (score > bestScore) { bestScore = score; best = cmapOffset + offset; }
  }
  if (best == null) throw new Error('no usable cmap subtable');
  return best;
}

function readCmap(buf, sub) {
  const format = buf.readUInt16BE(sub);
  const map = new Map();
  if (format === 4) {
    const segCountX2 = buf.readUInt16BE(sub + 6);
    const segCount = segCountX2 / 2;
    const endBase = sub + 14;
    const startBase = endBase + segCountX2 + 2;
    const deltaBase = startBase + segCountX2;
    const rangeBase = deltaBase + segCountX2;
    for (let s = 0; s < segCount; s++) {
      const end = buf.readUInt16BE(endBase + s * 2);
      const start = buf.readUInt16BE(startBase + s * 2);
      const delta = buf.readInt16BE(deltaBase + s * 2);
      const rangeOffset = buf.readUInt16BE(rangeBase + s * 2);
      if (start === 0xFFFF) continue;
      for (let c = start; c <= end && c !== 0x10000; c++) {
        let g;
        if (rangeOffset === 0) {
          g = (c + delta) & 0xFFFF;
        } else {
          const gi = rangeBase + s * 2 + rangeOffset + (c - start) * 2;
          if (gi + 1 >= buf.length) continue;
          g = buf.readUInt16BE(gi);
          if (g !== 0) g = (g + delta) & 0xFFFF;
        }
        if (g !== 0) map.set(c, g);
      }
    }
  } else if (format === 12) {
    const nGroups = buf.readUInt32BE(sub + 12);
    for (let i = 0; i < nGroups; i++) {
      const g = sub + 16 + i * 12;
      const start = buf.readUInt32BE(g);
      const end = buf.readUInt32BE(g + 4);
      const startGlyph = buf.readUInt32BE(g + 8);
      for (let c = start; c <= end; c++) map.set(c, startGlyph + (c - start));
    }
  } else {
    throw new Error(`unsupported cmap format ${format}`);
  }
  return map;
}

const cache = new Map();

function loadFont(file) {
  if (cache.has(file)) return cache.get(file);
  const buf = fs.readFileSync(file);
  const t = tableDirectory(buf);
  for (const need of ['head', 'hhea', 'hmtx', 'cmap']) {
    if (!t[need]) throw new Error(`${file}: no ${need} table`);
  }
  const unitsPerEm = buf.readUInt16BE(t.head.offset + HEAD_UPM);
  const numHMetrics = buf.readUInt16BE(t.hhea.offset + HHEA_NUM_H_METRICS);
  const cmap = readCmap(buf, pickCmapSubtable(buf, t.cmap.offset));
  // hmtx is numHMetrics {advance, lsb} pairs; every glyph after the last one
  // repeats that final advance (the monospaced tail of the table).
  const advance = (glyph) => {
    const i = Math.min(glyph, numHMetrics - 1);
    return buf.readUInt16BE(t.hmtx.offset + i * 4);
  };
  const font = { unitsPerEm, cmap, advance };
  cache.set(file, font);
  return font;
}

// A codepoint the font has no glyph for falls through to the CN stack the app
// names after every Latin face (`DF Yuan`, `PingFang SC` — app.wxss). We do not
// ship those to measure, and the one character it matters for is the band's
// `·` separator, so charge a half em: wider than PingFang's middot, which keeps
// the estimate on the safe side of the real thing.
const FALLBACK_EM = 0.5;

/**
 * Width of `text` in rpx.
 *
 * @param {string} file       path to the .otf/.ttf actually shipped
 * @param {string} text       the string as the page draws it
 * @param {number} sizeRpx    the `Nrpx` in the WXSS rule, BEFORE --font-scale
 * @param {number} trackingEm letter-spacing in em, as the rule states it
 * @param {number} fontScale  --font-scale (app.wxss ships 1.15)
 */
function textWidthRpx(file, text, sizeRpx, trackingEm, fontScale) {
  const { unitsPerEm, cmap, advance } = loadFont(file);
  let units = 0;
  for (const ch of text) {
    const g = cmap.get(ch.codePointAt(0));
    units += g === undefined ? FALLBACK_EM * unitsPerEm : advance(g);
  }
  // letter-spacing is added after EVERY character, the last one included —
  // which is how WeChat lays it out, and why a heavily-tracked label costs
  // more than its glyphs suggest.
  const glyphs = Array.from(text).length;
  return (units / unitsPerEm * sizeRpx + glyphs * sizeRpx * trackingEm) * fontScale;
}

module.exports = { textWidthRpx };
