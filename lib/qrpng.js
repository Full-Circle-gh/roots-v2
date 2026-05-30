// lib/qrpng.js — zero-dependency QR Code → PNG generator.
//
// Scope: model-2 QR, byte (8-bit) mode, error-correction level M, versions
// 1–6 (up to 41×41 modules, ~106 bytes of payload). That's far more than any
// Alipay precreate `qr_code` string needs, and staying ≤ V6 sidesteps the
// version-information modules that V≥7 require. Galois-field / Reed–Solomon
// math, the format-info BCH, and data masking are all derived in code; only a
// tiny per-version EC/block table is hard-coded.
//
// Used by the Alipay payment flow: the mini-app renders this PNG and the
// customer scans it from their Alipay app.
//
// The Reed–Solomon core is unit-checked against a published QR test vector in
// scripts/test_retail_local.js (and inline below via selfTest()).
'use strict';
const zlib = require('zlib');

// ── Galois field GF(256), primitive polynomial 0x11d ───────────────────────
const GF_EXP = new Array(512);
const GF_LOG = new Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();
function gfMul(a, b) { return (a === 0 || b === 0) ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]; }

// Generator polynomial for `deg` EC codewords, highest-degree coefficient first.
function rsGenerator(deg) {
  let poly = [1];                       // constant 1 (index 0 = constant term)
  for (let i = 0; i < deg; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j]     ^= gfMul(poly[j], GF_EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly.reverse();                // → highest-degree first, leading coeff 1
}

// Reed–Solomon EC codewords for one data block.
function rsEncode(data, deg) {
  const gen = rsGenerator(deg);         // length deg+1, gen[0] = 1
  const rem = new Array(deg).fill(0);
  for (const d of data) {
    const factor = d ^ rem[0];
    rem.shift();
    rem.push(0);
    if (factor !== 0) {
      for (let j = 0; j < deg; j++) rem[j] ^= gfMul(gen[j + 1], factor);
    }
  }
  return rem;
}

// ── EC level M block table, versions 1–6 ──────────────────────────────────
// tot = total codewords for the version; ec = EC codewords per block; blocks =
// number of (equal-sized) blocks. dataCw = tot − ec*blocks (always divisible).
const TABLE = {
  1: { tot: 26,  ec: 10, blocks: 1 },
  2: { tot: 44,  ec: 16, blocks: 1 },
  3: { tot: 70,  ec: 26, blocks: 1 },
  4: { tot: 100, ec: 18, blocks: 2 },
  5: { tot: 134, ec: 24, blocks: 2 },
  6: { tot: 172, ec: 16, blocks: 4 },
};
const dataCapacity = (v) => TABLE[v].tot - TABLE[v].ec * TABLE[v].blocks;

// ── Bit + codeword encoding (byte mode, char-count is 8 bits for V1–9) ─────
function encodeCodewords(bytes, version) {
  const cap = dataCapacity(version);
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);                      // byte mode
  push(bytes.length, 8);               // character count
  for (const b of bytes) push(b, 8);
  const capBits = cap * 8;
  push(0, Math.min(4, capBits - bits.length));   // terminator
  while (bits.length % 8 !== 0) bits.push(0);     // pad to byte
  const cw = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    cw.push(v);
  }
  for (let t = 0; cw.length < cap; t++) cw.push(t % 2 === 0 ? 0xec : 0x11);  // pad codewords
  return cw;
}

// Split data codewords into equal blocks, append EC, interleave per spec.
function buildFinalStream(dataCw, version) {
  const { ec, blocks } = TABLE[version];
  const per = dataCw.length / blocks;
  const dBlocks = [];
  const eBlocks = [];
  for (let b = 0; b < blocks; b++) {
    const blk = dataCw.slice(b * per, (b + 1) * per);
    dBlocks.push(blk);
    eBlocks.push(rsEncode(blk, ec));
  }
  const out = [];
  for (let i = 0; i < per; i++) for (let b = 0; b < blocks; b++) out.push(dBlocks[b][i]);
  for (let i = 0; i < ec;  i++) for (let b = 0; b < blocks; b++) out.push(eBlocks[b][i]);
  return out;
}

// ── Matrix construction ────────────────────────────────────────────────────
function chooseVersion(len) {
  for (let v = 1; v <= 6; v++) if (dataCapacity(v) >= 4 + 1 + len) return v; // +mode/count slack
  throw new Error('qrpng: payload too long for versions 1–6 (' + len + ' bytes)');
}

function buildMatrix(text) {
  const bytes = Array.from(Buffer.from(text, 'utf8'));
  const version = chooseVersion(bytes.length);
  const size = version * 4 + 17;
  const mod = Array.from({ length: size }, () => new Array(size).fill(0));   // 0/1 colour
  const fn  = Array.from({ length: size }, () => new Array(size).fill(false)); // function module?

  const set = (r, c, dark) => { mod[r][c] = dark ? 1 : 0; fn[r][c] = true; };

  // Finder patterns + separators (8×8 reserved block per corner).
  const finder = (R, C) => {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
      const r = R + dr, c = C + dc;
      if (r < 0 || r >= size || c < 0 || c >= size) continue;
      const inRing = (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
                     (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6));
      const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
      set(r, c, inRing || inCore);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }

  // Single alignment pattern (V2–6) centred at (P,P), P = 4*version + 10.
  if (version >= 2) {
    const P = version * 4 + 10;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      const ring = Math.max(Math.abs(dr), Math.abs(dc));
      set(P + dr, P + dc, ring !== 1);
    }
  }

  // Dark module + reserve the format-info strips (filled after masking).
  set(size - 8, 8, true);
  for (let i = 0; i <= 8; i++) { if (!fn[8][i]) fn[8][i] = true; if (!fn[i][8]) fn[i][8] = true; }
  for (let i = 0; i < 8; i++)  { fn[8][size - 1 - i] = true; fn[size - 1 - i][8] = true; }

  // Data placement (zigzag, right→left, skipping the col-6 timing line).
  const stream = buildFinalStream(encodeCodewords(bytes, version), version);
  const totalBits = stream.length * 8;
  const getBit = (b) => (b < totalBits ? (stream[b >> 3] >> (7 - (b & 7))) & 1 : 0);
  let bi = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x]) { mod[y][x] = getBit(bi); bi++; }
      }
    }
  }

  // Pick the mask with the lowest penalty.
  let best = null, bestPen = Infinity;
  for (let m = 0; m < 8; m++) {
    const cand = applyMask(mod, fn, m, size);
    drawFormat(cand, size, m);
    const pen = penalty(cand, size);
    if (pen < bestPen) { bestPen = pen; best = cand; }
  }
  return { matrix: best, size };
}

function maskFn(m, y, x) {
  switch (m) {
    case 0: return (y + x) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (y + x) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((y * x) % 2) + ((y * x) % 3) === 0;
    case 6: return (((y * x) % 2) + ((y * x) % 3)) % 2 === 0;
    case 7: return (((y + x) % 2) + ((y * x) % 3)) % 2 === 0;
  }
}

function applyMask(mod, fn, m, size) {
  const out = mod.map(row => row.slice());
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (!fn[y][x] && maskFn(m, y, x)) out[y][x] ^= 1;
  }
  return out;
}

// Format info (EC level M = 0b00) → 15-bit BCH, placed in both copies.
function drawFormat(mat, size, mask) {
  const data = (0 << 3) | mask;          // M level bits are 00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const g = (i) => (bits >>> i) & 1;
  // Place the 15 format bits in their two copies per ISO/IEC 18004 §8.9.
  // (The bit→cell mapping below is the canonical one; an earlier version
  // mis-ordered the indices, which left the value correct but unreadable —
  // scanners couldn't recover the mask, so the QR wouldn't decode.)
  for (let i = 0; i < 15; i++) {
    const b = g(i);
    // Vertical strip (col 8): bits 0-5 → rows 0-5, bits 6-7 → rows 7-8,
    // bits 8-14 → rows size-7…size-1.
    if (i < 6) mat[i][8] = b;
    else if (i < 8) mat[i + 1][8] = b;
    else mat[size - 15 + i][8] = b;
    // Horizontal strip (row 8): bits 0-7 → cols size-1…size-8, bit 8 → col 7,
    // bits 9-14 → cols 5…0.
    if (i < 8) mat[8][size - 1 - i] = b;
    else if (i < 9) mat[8][7] = b;
    else mat[8][14 - i] = b;
  }
  mat[size - 8][8] = 1;                   // dark module
}

// Penalty scoring (ISO/IEC 18004 §8.8.2, the four rules).
function penalty(m, size) {
  let p = 0;
  // Rule 1 — runs of ≥5 same-colour modules (rows + cols).
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      let run = 1, prev = -1;
      for (let b = 0; b < size; b++) {
        const v = pass === 0 ? m[a][b] : m[b][a];
        if (v === prev) { run++; if (run === 5) p += 3; else if (run > 5) p += 1; }
        else { run = 1; prev = v; }
      }
    }
  }
  // Rule 2 — 2×2 blocks of the same colour.
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const v = m[y][x];
    if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) p += 3;
  }
  // Rule 3 — finder-like 1:1:3:1:1 patterns with 4 light modules either side.
  const a1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const a2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const match = (get, i, pat) => { for (let k = 0; k < 11; k++) if (get(i + k) !== pat[k]) return false; return true; };
  for (let y = 0; y < size; y++) for (let x = 0; x <= size - 11; x++) {
    const get = (i) => m[y][i];
    if (match(get, x, a1) || match(get, x, a2)) p += 40;
  }
  for (let x = 0; x < size; x++) for (let y = 0; y <= size - 11; y++) {
    const get = (i) => m[i][x];
    if (match(get, y, a1) || match(get, y, a2)) p += 40;
  }
  // Rule 4 — overall dark/light balance.
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) dark += m[y][x];
  const pct = (dark * 100) / (size * size);
  p += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return p;
}

// ── PNG output (8-bit grayscale, zlib via Node's built-in) ─────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function matrixToPng(matrix, size, { scale = 8, quiet = 4 } = {}) {
  const dim = (size + quiet * 2) * scale;
  const raw = Buffer.alloc((dim + 1) * dim);            // +1 filter byte per row
  for (let y = 0; y < dim; y++) {
    raw[y * (dim + 1)] = 0;                             // filter: none
    const my = Math.floor(y / scale) - quiet;
    for (let x = 0; x < dim; x++) {
      const mx = Math.floor(x / scale) - quiet;
      const dark = my >= 0 && my < size && mx >= 0 && mx < size && matrix[my][mx];
      raw[y * (dim + 1) + 1 + x] = dark ? 0x00 : 0xff;  // black / white
    }
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(dim, 0); ihdr.writeUInt32BE(dim, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 0;   // colour type: grayscale
  // 10,11,12 = compression / filter / interlace = 0
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// ── Public API ─────────────────────────────────────────────────────────────
function qrPng(text, opts) {
  const { matrix, size } = buildMatrix(String(text));
  return matrixToPng(matrix, size, opts || {});
}
function qrPngDataUrl(text, opts) {
  return 'data:image/png;base64,' + qrPng(text, opts).toString('base64');
}
function qrMatrix(text) { return buildMatrix(String(text)); }

// Reed–Solomon self-check against a published QR vector (Thonky "HELLO WORLD",
// V1-M): the 16 data codewords must yield these 10 EC codewords. Throws on
// mismatch so a broken GF/RS implementation can never ship silently.
function selfTest() {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  const want = [196, 35, 39, 119, 235, 215, 231, 226, 93, 23];
  const got = rsEncode(data, 10);
  const ok = got.length === want.length && got.every((v, i) => v === want[i]);
  if (!ok) throw new Error('qrpng selfTest FAILED: ' + got.join(',') + ' != ' + want.join(','));
  return true;
}

module.exports = { qrPng, qrPngDataUrl, qrMatrix, dataCapacity, rsEncode, selfTest };
