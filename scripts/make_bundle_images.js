#!/usr/bin/env node
// Bundle product "profile picture" generator.
//
// A bundle product is a real store_products row whose `bundle_items` JSON lists
// its component products ([{id,qty}], see routes/retail.js parseBundleItems).
// The home "bundle" block renders fine because it auto-composes each COMPONENT's
// own photo — but the bundle product ROW itself often has no image_data, so it
// shows up blank everywhere it appears as a single card (shop grid, cart line,
// its own PDP, admin product lists).
//
// This composites a bundle's component photos into ONE square thumbnail on the
// brand cream, and (with --fix) stores it as the bundle row's image_data. No AI:
// it reuses the real, on-brand component photos the customer already recognises.
//
// Layout: component photos are center-cropped (cover) and tiled with a thin
// cream gutter — 1 item fills the square, 2 sit side-by-side, 3 in a row, 4 in a
// 2x2, more than 4 are capped at the first 4 (logged). Output is JPEG q88, ≤1200
// longest side — matching the store_products image policy in shrink_store_images.
//
// SAFE: report-first. By default it writes a LOCAL preview file per bundle
// (./bundle-<id>-preview.jpg) and changes nothing in the DB. Re-run with --fix
// to write image_data (and bump updated_at so the /image cache key refreshes).
// Roots = shared data/roots.db (tenant #1). BACK UP THE DB BEFORE --fix.
//
//   node scripts/make_bundle_images.js                 # preview every imageless bundle
//   node scripts/make_bundle_images.js --id=123        # one bundle (even if it has an image)
//   node scripts/make_bundle_images.js --all           # every bundle, even ones with an image
//   node scripts/make_bundle_images.js --fix           # write the previewed images to the DB

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const sharp = require('sharp');

const FIX = process.argv.includes('--fix');
const ALL = process.argv.includes('--all');
const idArg = parseInt((process.argv.find(a => a.startsWith('--id=')) || '').slice(5), 10);
const DB_PATH = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');
const db = new Database(DB_PATH);

const SIZE = 1200;                 // square canvas, longest side (matches cap)
const MARGIN = 64;                 // cream border around the tile grid
const GUTTER = 26;                 // cream gap between tiles
const CREAM = { r: 0xee, g: 0xe8, b: 0xd8 };   // #eee8d8 — most common brand cream
const fmt = b => b >= 1048576 ? (b / 1048576).toFixed(2) + ' MB' : Math.round(b / 1024) + ' KB';

// [{id,qty}] from a bundle row's JSON (mirrors routes/retail.js parseBundleItems).
function parseBundleItems(v) {
  if (!v) return [];
  let arr = v;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { return []; } }
  if (!Array.isArray(arr)) return [];
  const seen = new Set(), out = [];
  for (const it of arr) {
    const id = parseInt(it && (it.id != null ? it.id : it.product_id), 10);
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push({ id });
  }
  return out;
}

// Grid shape for n photos: a centred row (1–3) or a 2x2 (4). Square tiles keep
// each (typically square) product photo uncropped — a tall strip would zoom in
// and clip the jar's lid/base.
function gridShape(n) {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n === 3) return { cols: 3, rows: 1 };
  return { cols: 2, rows: 2 };
}

function decodeImage(dataUri) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUri || '');
  if (!m) return null;
  if (/svg/.test(m[1])) return null;            // can't cover-crop vector reliably
  return Buffer.from(m[2], 'base64');
}

// One rounded-corner square tile (cover-cropped, centred).
async function makeTile(buf, s) {
  const r = Math.round(s * 0.07);
  const mask = Buffer.from(`<svg width="${s}" height="${s}"><rect width="${s}" height="${s}" rx="${r}" ry="${r}"/></svg>`);
  const img = await sharp(buf).rotate()
    .resize({ width: s, height: s, fit: 'cover', position: 'centre' })
    .toBuffer();
  return sharp(img).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

async function buildComposite(photos) {
  const used = photos.slice(0, 4);              // cap at 4 tiles
  const { cols, rows } = gridShape(used.length);
  const s = Math.floor((SIZE - 2 * MARGIN - (cols - 1) * GUTTER) / cols);
  const gridW = cols * s + (cols - 1) * GUTTER;
  const gridH = rows * s + (rows - 1) * GUTTER;
  const startX = Math.round((SIZE - gridW) / 2);
  const startY = Math.round((SIZE - gridH) / 2);
  const layers = [];
  for (let i = 0; i < used.length; i++) {
    const c = i % cols, rw = Math.floor(i / cols);
    layers.push({ input: await makeTile(used[i], s), left: startX + c * (s + GUTTER), top: startY + rw * (s + GUTTER) });
  }
  return sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: CREAM } })
    .composite(layers)
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}

(async () => {
  console.log(`DB: ${DB_PATH}\nMode: ${FIX ? 'FIX (writes image_data)' : 'PREVIEW only (writes ./bundle-*-preview.jpg)'}`);

  let where = "bundle_items IS NOT NULL AND TRIM(bundle_items) NOT IN ('', '[]')";
  const params = [];
  if (Number.isFinite(idArg)) { where = 'id = ?'; params.push(idArg); }
  const rows = db.prepare(
    `SELECT id, name_en, name_cn, bundle_items, image_data, image_url, updated_at
       FROM store_products WHERE ${where} ORDER BY id`).all(...params);

  if (!rows.length) { console.log('No bundle products found.'); return; }

  let made = 0, skipped = 0;
  for (const row of rows) {
    const label = `#${row.id} ${row.name_en || row.name_cn || '(unnamed)'}`;
    const hasImg = (row.image_data && /^data:image\//.test(row.image_data)) || !!row.image_url;
    if (hasImg && !ALL && !Number.isFinite(idArg)) { console.log(`  ${label} — already has an image, skip (use --all to override)`); skipped++; continue; }

    const comps = parseBundleItems(row.bundle_items);
    if (!comps.length) { console.log(`  ${label} — no components, skip`); skipped++; continue; }

    const ph = comps.map(() => '?').join(',');
    const compRows = db.prepare(
      `SELECT id, image_data FROM store_products WHERE id IN (${ph})`).all(...comps.map(c => c.id));
    const byId = new Map(compRows.map(r => [r.id, r]));

    const photos = [];
    const missing = [];
    for (const c of comps) {
      const buf = byId.has(c.id) ? decodeImage(byId.get(c.id).image_data) : null;
      if (buf) photos.push(buf); else missing.push(c.id);
    }
    if (!photos.length) { console.log(`  ${label} — no component photos available (ids ${comps.map(c => c.id).join(',')}), skip`); skipped++; continue; }
    if (missing.length) console.log(`  ${label} — note: ${missing.length} component(s) had no photo (ids ${missing.join(',')}); using ${photos.length}`);
    if (comps.length > 4) console.log(`  ${label} — ${comps.length} components, showing first 4`);

    const out = await buildComposite(photos);
    const previewPath = path.join(process.cwd(), `bundle-${row.id}-preview.jpg`);
    fs.writeFileSync(previewPath, out);
    made++;

    if (FIX) {
      const dataUri = `data:image/jpeg;base64,${out.toString('base64')}`;
      const now = new Date().toISOString();
      db.prepare('UPDATE store_products SET image_data = ?, updated_at = ? WHERE id = ?').run(dataUri, now, row.id);
      console.log(`  ${label} — ${photos.length} jar(s) → ${fmt(out.length)}  ✓ written (preview: ${previewPath})`);
    } else {
      console.log(`  ${label} — ${photos.length} jar(s) → ${fmt(out.length)}  preview: ${previewPath}`);
    }
  }

  console.log(`\n${made} composite(s) ${FIX ? 'written' : 'previewed'}, ${skipped} skipped.`);
  if (!FIX && made) console.log('Eyeball the bundle-*-preview.jpg files, then re-run with --fix to store them.');
})().catch(e => { console.error(e); process.exit(1); });
