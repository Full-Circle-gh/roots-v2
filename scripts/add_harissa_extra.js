#!/usr/bin/env node
/**
 * Append one paid extra — Wild harrisa (spicy) / 哈里萨辣酱 (辛辣) +¥4 — to the
 * existing "Add extras?" option group on the 5 soups/curry that share options
 * (see scripts/copy_soup_options.js). Additive: it does NOT touch the other
 * choices or the "heat up?" group.
 *
 * Idempotent: skips any product that already has a choice with this label, so
 * re-running is safe.
 *
 * Usage:
 *   node scripts/add_harissa_extra.js --dry-run
 *   node scripts/add_harissa_extra.js
 */
const path = require('path');
const Database = require('better-sqlite3');

const DRY = process.argv.includes('--dry-run');
const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');

const SKUS = ['1-400', '1-460', '1-360', '1-370', '1-380'];
const GROUP_EN = 'Add extras?';
const NEW = { label_en: 'Wild harrisa (spicy)', label_cn: '哈里萨辣酱 (辛辣)', price_delta: 4 };

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const getProduct = db.prepare('SELECT id, name_en FROM store_products WHERE sku = ?');
const getGroup = db.prepare(
  "SELECT id FROM retail_product_options WHERE product_id = ? AND question_en = ? ORDER BY sort_order, id LIMIT 1"
);
const hasChoice = db.prepare(
  'SELECT 1 FROM retail_product_option_choices WHERE option_id = ? AND lower(trim(label_en)) = lower(trim(?))'
);
const nextSort = db.prepare(
  'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM retail_product_option_choices WHERE option_id = ?'
);
// Discover choice columns dynamically so we set only what exists (stock_product_id etc. stay NULL).
const choiceCols = db.prepare('PRAGMA table_info(retail_product_option_choices)').all()
  .map(c => c.name).filter(c => c !== 'id' && c !== 'option_id');
const insChoice = db.prepare(
  `INSERT INTO retail_product_option_choices (option_id, ${choiceCols.join(', ')})
   VALUES (?, ${choiceCols.map(() => '?').join(', ')})`
);

const run = db.transaction(() => {
  let added = 0, skipped = 0, missing = [];
  for (const sku of SKUS) {
    const p = getProduct.get(sku);
    if (!p) { missing.push(`${sku} (no product)`); continue; }
    const g = getGroup.get(p.id, GROUP_EN);
    if (!g) { missing.push(`${sku} (no "${GROUP_EN}" group)`); continue; }
    if (hasChoice.get(g.id, NEW.label_en)) {
      console.log(`= skip ${sku} "${p.name_en}" — already has "${NEW.label_en}"`);
      skipped++; continue;
    }
    const sort = nextSort.get(g.id).n;
    const vals = choiceCols.map(col => {
      if (col === 'label_en') return NEW.label_en;
      if (col === 'label_cn') return NEW.label_cn;
      if (col === 'price_delta') return NEW.price_delta;
      if (col === 'is_default') return 0;
      if (col === 'sort_order') return sort;
      return null; // stock_product_id and anything else → NULL (unlinked)
    });
    if (!DRY) insChoice.run(g.id, ...vals);
    console.log(`${DRY ? 'would add' : '✅ added'} → ${sku} "${p.name_en}"  (+¥${NEW.price_delta})`);
    added++;
  }
  if (missing.length) console.log(`\n⚠️  ${missing.join(', ')}`);
  console.log(DRY
    ? `\n🔍 DRY-RUN — no rows written. would add ${added}, skip ${skipped}.`
    : `\n✅ Done. added ${added}, skipped ${skipped}.`);
  if (DRY) throw new Error('__dry_rollback__');
});

try { run(); } catch (e) { if (e.message !== '__dry_rollback__') throw e; }
