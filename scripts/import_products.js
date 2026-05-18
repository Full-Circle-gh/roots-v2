#!/usr/bin/env node
/**
 * One-shot product import from Products.xlsx (pre-converted to JSON).
 *
 * Run modes:
 *   node scripts/import_products.js --dry-run    # parse + validate, no writes
 *   node scripts/import_products.js              # write to data/roots.db
 *
 * Upsert key: external_id (Zoho upstream ID, always unique). SKU is a
 * display/lookup string only — duplicates in the source were resolved
 * with -d2 suffixes in the JSON snapshot. Re-running this script is
 * idempotent: existing rows (matched by external_id) get updated,
 * new ones inserted, soft-deleted rows reactivated.
 */
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const DRY = process.argv.includes('--dry-run');
const DB_PATH   = path.join(__dirname, '..', 'data', 'roots.db');
const SRC_PATH  = path.join(__dirname, 'products_import.json');

if (!fs.existsSync(SRC_PATH)) {
  console.error(`Source missing: ${SRC_PATH}\nRun the python xlsx→json converter first.`);
  process.exit(1);
}
const { products } = JSON.parse(fs.readFileSync(SRC_PATH, 'utf8'));
if (!Array.isArray(products)) { console.error('JSON has no products[] array'); process.exit(1); }

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Trigger lazy migration in database.js if loaded as module — but we read
// directly here, so confirm columns exist by querying schema.
const cols = db.prepare("PRAGMA table_info(products)").all().map(c => c.name);
const required = ['external_id', 'sort_order', 'stock_qty', 'tags'];
const missing  = required.filter(c => !cols.includes(c));
if (missing.length) {
  console.error(`Schema is missing columns: ${missing.join(', ')}`);
  console.error(`Restart the app once (it auto-migrates) before running the import.`);
  process.exit(1);
}

const findByExt = db.prepare('SELECT id, sku, is_active FROM products WHERE external_id = ?');
const findBySku = db.prepare('SELECT id, external_id FROM products WHERE LOWER(sku) = LOWER(?)');
const insertRow = db.prepare(`INSERT INTO products
  (name_en,name_cn,sku,category,sell_price,stock_qty,sort_order,tags,free_of,external_id,status,is_active)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`);
const updateRow = db.prepare(`UPDATE products SET
  name_en=?,name_cn=?,sku=?,category=?,sell_price=?,stock_qty=?,sort_order=?,tags=?,free_of=?,status=?,is_active=1,
  updated_at=CURRENT_TIMESTAMP WHERE id=?`);

const stats = { inserted: 0, updated: 0, skipped: 0, conflicts: [] };
const tx = db.transaction(() => {
  for (const p of products) {
    if (!p.external_id) { stats.skipped++; continue; }
    const existing = findByExt.get(p.external_id);
    if (existing) {
      updateRow.run(p.name_en, p.name_cn, p.sku, p.category, p.sell_price,
        p.stock_qty || 0, p.sort_order || 0, p.tags, p.free_of, p.status || 'active', existing.id);
      stats.updated++;
    } else {
      // Watch out: someone may have manually entered a SKU that now collides
      // with the imported SKU. If so, skip and log — don't silently merge.
      const skuClash = findBySku.get(p.sku);
      if (skuClash && skuClash.external_id !== p.external_id) {
        stats.conflicts.push({ sku: p.sku, name: p.name_en, existing_id: skuClash.id });
        stats.skipped++;
        continue;
      }
      // Column order in the INSERT: ..., external_id, status, is_active.
      // External_id goes first, status second. Earlier version of this
      // script had them swapped — the data repair script in /scripts
      // un-swaps any rows still in that broken state.
      insertRow.run(p.name_en, p.name_cn, p.sku, p.category, p.sell_price,
        p.stock_qty || 0, p.sort_order || 0, p.tags, p.free_of, p.external_id, p.status || 'Active');
      stats.inserted++;
    }
  }
});

if (DRY) {
  console.log(`DRY-RUN ─ would process ${products.length} products against ${DB_PATH}`);
  // Read-only preview
  let wouldInsert = 0, wouldUpdate = 0;
  for (const p of products) {
    if (!p.external_id) continue;
    if (findByExt.get(p.external_id)) wouldUpdate++;
    else wouldInsert++;
  }
  console.log(`Would INSERT: ${wouldInsert}`);
  console.log(`Would UPDATE: ${wouldUpdate}`);
  console.log(`Skipped (no external_id): ${products.filter(p => !p.external_id).length}`);
  process.exit(0);
}

tx();
console.log(`✅ Done`);
console.log(`  Inserted:  ${stats.inserted}`);
console.log(`  Updated:   ${stats.updated}`);
console.log(`  Skipped:   ${stats.skipped}`);
if (stats.conflicts.length) {
  console.log(`  SKU conflicts (with manually-entered rows):`);
  for (const c of stats.conflicts) console.log(`    ${c.sku}  →  ${c.name}  (existing id ${c.existing_id})`);
}
