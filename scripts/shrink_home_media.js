#!/usr/bin/env node
// One-off: shrink the oversized home-layout images that load slowly on the
// mini-app — the review-card avatar and the WeCom "Stay in the loop" QR. Both
// are retail_media base64 blobs uploaded BEFORE cms.html's downscale-on-upload
// routine existed, so they ship multi-hundred-KB originals to every phone.
//
// What it does:
//   1. Walk storefront_config for media ids referenced as avatar_url / qr_*.
//   2. Also flag ANY retail_media image row over THRESHOLD bytes (catch-all).
//   3. --fix  → recompress in place with sharp (QR → lossless-ish PNG, photos →
//      JPEG q82, longest side capped at MAX_DIM), only writing back when smaller.
//
// Roots runs on the shared data/roots.db (tenant #1), so we open it directly.
//
//   node scripts/shrink_home_media.js          # report only
//   node scripts/shrink_home_media.js --fix     # recompress in place

const path = require('path');
const Database = require('better-sqlite3');
const sharp = require('sharp');

const FIX = process.argv.includes('--fix');
// --ids=58,59,61 restricts the run to specific media rows (the home-page set),
// instead of every oversized image in the store.
const idsArg = (process.argv.find(a => a.startsWith('--ids=')) || '').slice(6);
const ONLY_IDS = idsArg ? new Set(idsArg.split(',').map(n => parseInt(n, 10))) : null;
const DB_PATH = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');
const THRESHOLD = 120 * 1024;   // flag image rows bigger than this
const MAX_DIM = 1200;           // longest side for generic home photos
const AVATAR_MAX_DIM = 480;     // avatars render in a ~100px circle — 480 covers retina
const QR_MAX_DIM = 900;         // QR needs enough modules but not 1600px

const db = new Database(DB_PATH);

function fmt(b) {
  return b >= 1024 * 1024 ? (b / 1048576).toFixed(2) + ' MB' : Math.round(b / 1024) + ' KB';
}

// --- 1. Collect media ids referenced by the home layout, tagged by role ----
const roleById = new Map();   // mediaId -> 'avatar' | 'qr' | 'other-home'
function noteUrl(url, role) {
  if (typeof url !== 'string') return;
  const m = /\/api\/retail\/media\/(\d+)/.exec(url);
  if (m) roleById.set(parseInt(m[1], 10), role);
}
function walk(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach(walk);
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string') {
      if (/avatar/i.test(k)) noteUrl(v, 'avatar');
      else if (/qr/i.test(k)) noteUrl(v, 'qr');
      else if (/(image|img|url|cover|photo|mascot|poster)/i.test(k)) noteUrl(v, 'other-home');
    } else walk(v);
  }
}
for (const row of db.prepare('SELECT key, value_json FROM storefront_config').all()) {
  try { walk(JSON.parse(row.value_json)); } catch { /* skip non-JSON */ }
}

// --- 2. Pull candidate media rows: referenced-in-home OR simply oversized ---
const ids = new Set(roleById.keys());
for (const r of db.prepare(
  `SELECT id FROM retail_media WHERE mime_type LIKE 'image/%' AND size_bytes > ?`).all(THRESHOLD)) {
  ids.add(r.id);
}

// When targeting specific ids, those win outright (even if under THRESHOLD).
if (ONLY_IDS) { ids.clear(); for (const id of ONLY_IDS) ids.add(id); }

if (!ids.size) { console.log('No oversized / referenced home media found.'); process.exit(0); }

const rows = db.prepare(
  `SELECT id, filename, mime_type, size_bytes FROM retail_media WHERE id IN (${[...ids].join(',')})`
).all();

console.log(`DB: ${DB_PATH}`);
console.log(`Mode: ${FIX ? 'FIX (recompress in place)' : 'REPORT only'}\n`);
console.log('id      role         mime          size      filename');
console.log('─'.repeat(70));
for (const r of rows.sort((a, b) => b.size_bytes - a.size_bytes)) {
  const role = roleById.get(r.id) || (r.size_bytes > THRESHOLD ? 'big' : '');
  console.log(
    `${String(r.id).padEnd(7)} ${(role || '').padEnd(12)} ${(r.mime_type || '').padEnd(13)} ` +
    `${fmt(r.size_bytes).padStart(8)}  ${r.filename || ''}`);
}

if (!FIX) {
  console.log('\nRun again with --fix to recompress these in place.');
  process.exit(0);
}

// --- 3. Recompress in place ------------------------------------------------
const getData = db.prepare('SELECT data FROM retail_media WHERE id = ?');
const update = db.prepare(
  'UPDATE retail_media SET data = ?, mime_type = ?, size_bytes = ?, filename = ? WHERE id = ?');

async function run() {
  let saved = 0;
  for (const r of rows) {
    const role = roleById.get(r.id) || 'big';
    const raw = getData.get(r.id).data;
    const m = /^data:([^;]+);base64,(.+)$/.exec(raw || '');
    if (!m) { console.log(`#${r.id} skip — not a base64 data URI`); continue; }
    if (/gif|svg/.test(m[1])) { console.log(`#${r.id} skip — ${m[1]} (animation/vector)`); continue; }
    const inBuf = Buffer.from(m[2], 'base64');

    let pipe = sharp(inBuf).rotate();
    const meta = await pipe.metadata();
    const isQr = role === 'qr';
    const cap = isQr ? QR_MAX_DIM : role === 'avatar' ? AVATAR_MAX_DIM : MAX_DIM;
    if (Math.max(meta.width || 0, meta.height || 0) > cap) {
      pipe = pipe.resize({ width: cap, height: cap, fit: 'inside', withoutEnlargement: true });
    }
    let outBuf, outMime, ext;
    if (isQr) {
      outBuf = await pipe.png({ compressionLevel: 9, palette: true }).toBuffer();
      outMime = 'image/png'; ext = 'png';
    } else {
      outBuf = await pipe.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
      outMime = 'image/jpeg'; ext = 'jpg';
    }
    if (outBuf.length >= inBuf.length) {
      console.log(`#${r.id} (${role}) ${fmt(inBuf.length)} → ${fmt(outBuf.length)} — no gain, kept original`);
      continue;
    }
    const newData = `data:${outMime};base64,${outBuf.toString('base64')}`;
    const base = (r.filename || `media-${r.id}`).replace(/\.[^.]+$/, '');
    update.run(newData, outMime, outBuf.length, `${base}.${ext}`, r.id);
    saved += inBuf.length - outBuf.length;
    console.log(`#${r.id} (${role}) ${fmt(inBuf.length)} → ${fmt(outBuf.length)}  ✓`);
  }
  console.log(`\nDone. Freed ${fmt(saved)} across ${rows.length} candidate(s).`);
}
run().catch(e => { console.error(e); process.exit(1); });
