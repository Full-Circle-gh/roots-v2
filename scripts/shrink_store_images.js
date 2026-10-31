#!/usr/bin/env node
// Store-wide image shrink: normalise the two base64-image stores so phones stop
// pulling multi-MB originals. Complements cms.html's upload-time downscale
// (which only covers NEW uploads) by fixing everything already in the DB.
//
//   store_products.image_data — product catalog photos. PDP detail pages ship
//     this blob inline at FULL res (list/grid already lazy-resize via the image
//     endpoint), so an uncapped original = a multi-MB PDP. All verified opaque
//     → JPEG q88, longest side ≤ 1200 (plenty for a retina PDP hero).
//   retail_media.data — CMS/banner/review uploads, served full-size always by
//     GET /api/retail/media/:id (no on-the-fly resize). Cap ≤ 1600. JPEG sources
//     → JPEG q85; PNG sources stay PNG (palette-quantised) so QR posters /
//     screenshots / line-art keep crisp edges and stay scannable.
//
// SAFE: never enlarges; only writes when the result is smaller; GIF/SVG pass
// through; updated_at is left untouched (recompression is visually transparent,
// so client thumbnail caches stay valid and nothing re-downloads needlessly).
// Roots = shared data/roots.db (tenant #1). BACK UP THE DB BEFORE --fix.
//
//   node scripts/shrink_store_images.js                 # report both tables
//   node scripts/shrink_store_images.js --table=store_products --fix
//   node scripts/shrink_store_images.js --fix            # fix both

const path = require('path');
const Database = require('better-sqlite3');
const sharp = require('sharp');

const FIX = process.argv.includes('--fix');
const tableArg = (process.argv.find(a => a.startsWith('--table=')) || '').slice(8);
const DB_PATH = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');
const db = new Database(DB_PATH);

const fmt = b => b >= 1048576 ? (b / 1048576).toFixed(2) + ' MB' : Math.round(b / 1024) + ' KB';

// Per-table policy. `col` is the data-URI column; `min` the byte floor to bother
// with; `cap` the longest-side limit; `jpegQ` the quality for photographic
// re-encodes; `pngKeepsPng` keeps PNG sources lossless-ish (palette) vs forcing
// JPEG. retail_media also carries mime_type/size_bytes/filename to keep in sync.
const POLICY = {
  store_products: { col: 'image_data', min: 150 * 1024, cap: 1200, jpegQ: 88, pngKeepsPng: false, meta: false },
  retail_media:   { col: 'data',       min: 200 * 1024, cap: 1600, jpegQ: 85, pngKeepsPng: true,  meta: true },
};

async function processRow(p, row, fix) {
  const raw = row[p.col];
  const m = /^data:([^;]+);base64,(.+)$/.exec(raw || '');
  if (!m) return { id: row.id, skip: 'not-base64' };
  const srcMime = m[1];
  if (/gif|svg/.test(srcMime)) return { id: row.id, skip: srcMime.replace('image/', '') };
  const inBuf = Buffer.from(m[2], 'base64');

  let pipe = sharp(inBuf).rotate();
  const md = await pipe.metadata();
  if (Math.max(md.width || 0, md.height || 0) > p.cap) {
    pipe = pipe.resize({ width: p.cap, height: p.cap, fit: 'inside', withoutEnlargement: true });
  }

  const keepPng = p.pngKeepsPng && /png/.test(srcMime);
  let outBuf, outMime, ext;
  if (keepPng) {
    outBuf = await pipe.png({ compressionLevel: 9, palette: true, quality: 90 }).toBuffer();
    outMime = 'image/png'; ext = 'png';
  } else {
    outBuf = await pipe.jpeg({ quality: p.jpegQ, mozjpeg: true }).toBuffer();
    outMime = 'image/jpeg'; ext = 'jpg';
  }
  if (outBuf.length >= inBuf.length) return { id: row.id, in: inBuf.length, out: outBuf.length, kept: true };

  if (fix) {
    const newData = `data:${outMime};base64,${outBuf.toString('base64')}`;
    if (p.meta) {
      const base = (row.filename || `media-${row.id}`).replace(/\.[^.]+$/, '');
      db.prepare(`UPDATE ${p._table} SET ${p.col} = ?, mime_type = ?, size_bytes = ?, filename = ? WHERE id = ?`)
        .run(newData, outMime, outBuf.length, `${base}.${ext}`, row.id);
    } else {
      db.prepare(`UPDATE ${p._table} SET ${p.col} = ? WHERE id = ?`).run(newData, row.id);
    }
  }
  return { id: row.id, in: inBuf.length, out: outBuf.length };
}

async function runTable(table) {
  const p = { ...POLICY[table], _table: table };
  const extra = p.meta ? ', filename, mime_type, size_bytes' : '';
  const rows = db.prepare(
    `SELECT id, ${p.col}${extra} FROM ${table}
      WHERE ${p.col} LIKE 'data:image/%' AND LENGTH(${p.col}) > ?`).all(p.min);
  console.log(`\n=== ${table} — ${rows.length} candidate(s) over ${fmt(p.min)} ===`);
  let inTot = 0, outTot = 0, changed = 0;
  for (const row of rows) {
    const r = await processRow(p, row, FIX);
    if (r.skip) { console.log(`  #${r.id} skip (${r.skip})`); continue; }
    if (r.kept) { console.log(`  #${r.id} ${fmt(r.in)} → ${fmt(r.out)}  (no gain, kept)`); continue; }
    inTot += r.in; outTot += r.out; changed++;
    console.log(`  #${r.id} ${fmt(r.in)} → ${fmt(r.out)}${FIX ? '  ✓' : ''}`);
  }
  console.log(`  ── ${changed} ${FIX ? 'shrunk' : 'would shrink'}: ${fmt(inTot)} → ${fmt(outTot)} (saves ${fmt(inTot - outTot)})`);
  return { inTot, outTot };
}

(async () => {
  console.log(`DB: ${DB_PATH}\nMode: ${FIX ? 'FIX (in place)' : 'REPORT only'}`);
  const tables = tableArg ? [tableArg] : ['store_products', 'retail_media'];
  let inAll = 0, outAll = 0;
  for (const t of tables) { const { inTot, outTot } = await runTable(t); inAll += inTot; outAll += outTot; }
  console.log(`\nTOTAL ${FIX ? 'freed' : 'recoverable'}: ${fmt(inAll - outAll)} (${fmt(inAll)} → ${fmt(outAll)})`);
  if (!FIX) console.log('Re-run with --fix to apply.');
})().catch(e => { console.error(e); process.exit(1); });
