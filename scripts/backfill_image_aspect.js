#!/usr/bin/env node
// Backfill store_products.image_aspect — the mini-app PDP hero aspect ratio
// (width / height). When present, the product page sizes its hero box to the
// photo's true shape so nothing crops on first paint; when NULL the mini-app
// self-corrects from the image's bindload event, but only AFTER the box has
// already rendered (and briefly cropped) at the fixed-height + aspectFill
// fallback. This fills the column for every existing product so first paint is
// correct without waiting on the image to load.
//
// Reads the primary `image_data` blob and measures it with sharp (robust;
// honours EXIF orientation so a rotated photo records its DISPLAYED shape, which
// is what WeChat's <image bindload> reports). External http(s) image_url rows
// can't be measured offline and are left NULL (client self-corrects).
//
// Going forward, retail.js keeps the column fresh on every product create / image
// save, so this one-shot only needs to run once after deploy (and is safe to
// re-run — it's idempotent and only writes when the value actually changes).
//
// Roots = shared data/roots.db (tenant #1). Recommend a DB backup before --fix.
//
//   node scripts/backfill_image_aspect.js          # report what would change
//   node scripts/backfill_image_aspect.js --fix    # write image_aspect

const path = require('path');
const Database = require('better-sqlite3');
const sharp = require('sharp');

const FIX = process.argv.includes('--fix');
const DB_PATH = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');
const db = new Database(DB_PATH);

// EXIF orientation values 5–8 are the 90°/270° rotations — width and height swap
// when displayed, so the on-screen aspect is the inverse of the stored pixels.
function aspectFromBuffer(buf) {
  return sharp(buf).metadata().then(m => {
    if (!m || !m.width || !m.height) return null;
    const rotated = m.orientation >= 5 && m.orientation <= 8;
    const w = rotated ? m.height : m.width;
    const h = rotated ? m.width : m.height;
    return Math.round((w / h) * 1e4) / 1e4;
  }).catch(() => null);
}

function bufferFromColumn(val) {
  if (typeof val !== 'string' || !val) return null;
  const m = /^data:[^;,]*;base64,(.*)$/is.exec(val.trim());
  if (m) { try { return Buffer.from(m[1], 'base64'); } catch { return null; } }
  return null; // external URL or unrecognised — can't measure offline
}

(async () => {
  const rows = db.prepare(
    `SELECT id, name_en, image_data, image_aspect
       FROM store_products
      WHERE image_data IS NOT NULL AND image_data != ''`
  ).all();

  const upd = db.prepare('UPDATE store_products SET image_aspect = ? WHERE id = ?');
  let measured = 0, changed = 0, skipped = 0;

  for (const r of rows) {
    const buf = bufferFromColumn(r.image_data);
    if (!buf) { skipped++; continue; }
    const aspect = await aspectFromBuffer(buf);
    if (aspect == null) { skipped++; continue; }
    measured++;
    const cur = r.image_aspect == null ? null : Math.round(r.image_aspect * 1e4) / 1e4;
    if (cur === aspect) continue;
    changed++;
    console.log(`  #${r.id} ${String(r.name_en || '').slice(0, 40).padEnd(40)} ${cur ?? '—'} → ${aspect}`);
    if (FIX) upd.run(aspect, r.id);
  }

  console.log(`\n${rows.length} products with a photo · ${measured} measured · ${skipped} skipped (no decodable blob)`);
  console.log(FIX ? `WROTE ${changed} image_aspect values.` : `${changed} would change. Re-run with --fix to write.`);
  db.close();
})();
