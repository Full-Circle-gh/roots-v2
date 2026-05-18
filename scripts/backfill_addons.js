#!/usr/bin/env node
/**
 * Backfill the sale_addons table from existing miniapp_order_lines.
 *
 * Why: until we shipped the add-on tracking, "Hummus + Pack of Crackers"
 * sales went into sales_entries with product_id=Hummus and the cracker
 * info as a string in `combine_with` only. The cracker SKU never got
 * credited in inventory or any per-product report. This script reads the
 * mapping in scripts/addon_mapping.json and creates sale_addons rows
 * pointing back to each parent sales_entry, so:
 *   - Add-on Usage card on the dashboard can show real numbers
 *   - Inventory consumption / cost can be computed against the addon SKU
 *   - Top Products ranking stays clean (revenue isn't double-counted)
 *
 * Idempotent: deletes existing sale_addons rows with source='miniapp'
 * first, then re-inserts. Safe to re-run after editing the mapping or
 * after a fresh `import_miniapp.js`.
 *
 * Usage:
 *   node scripts/backfill_addons.js --dry-run
 *   node scripts/backfill_addons.js
 */
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const DRY = process.argv.includes('--dry-run');
const DB_PATH      = path.join(__dirname, '..', 'data', 'roots.db');
const MAPPING_PATH = path.join(__dirname, 'addon_mapping.json');

const cfg = JSON.parse(fs.readFileSync(MAPPING_PATH, 'utf8'));
const mapping = cfg.mapping || {};
const ignoreSet = new Set(cfg.ignore || []);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Confirm sale_addons exists — schema may not have been re-applied.
const ok = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sale_addons'").get();
if (!ok) {
  console.error('sale_addons table missing — restart the app once to apply schema, then retry.');
  process.exit(1);
}

// Resolve mapping: SKU → products.id. Bail if any mapped SKU is missing.
const skuToId = new Map();
const missingSkus = [];
for (const [combineStr, sku] of Object.entries(mapping)) {
  const row = db.prepare('SELECT id FROM products WHERE sku = ?').get(sku);
  if (!row) missingSkus.push({ combineStr, sku });
  else      skuToId.set(combineStr, row.id);
}
if (missingSkus.length) {
  console.error('Mapped SKUs not found in products table:');
  for (const m of missingSkus) console.error(`  "${m.combineStr}" → ${m.sku}`);
  console.error('Add the products first or fix scripts/addon_mapping.json, then retry.');
  process.exit(1);
}

// Walk every miniapp order; for each order, its lines in id-ascending order
// represent the same indices that import_miniapp.js used when stamping
// sales_entries.notes. Match each line to its sales_entry via the
// `[miniapp:<source_order_id>:<idx>]` tag.
const orders = db.prepare(`SELECT id, source_order_id FROM miniapp_orders ORDER BY id`).all();
const findLines = db.prepare(`SELECT id, combine_with FROM miniapp_order_lines WHERE order_id = ? ORDER BY id`);
const findSale  = db.prepare(`SELECT id FROM sales_entries WHERE channel='miniapp' AND notes LIKE ? LIMIT 1`);
const insertAddon = db.prepare(`INSERT INTO sale_addons
  (sale_id, addon_product_id, qty, source, source_combine_with)
  VALUES (?,?,?,?,?)`);

const stats = {
  linesScanned: 0,
  linesWithCombine: 0,
  linesIgnored: 0,
  linesUnmapped: 0,
  linesMissingSale: 0,
  addonsInserted: 0,
};
const unmappedSamples = new Map();

const tx = db.transaction(() => {
  if (!DRY) db.prepare(`DELETE FROM sale_addons WHERE source='miniapp'`).run();
  for (const o of orders) {
    const lines = findLines.all(o.id);
    lines.forEach((line, idx) => {
      stats.linesScanned++;
      const cw = line.combine_with;
      if (!cw) return;
      stats.linesWithCombine++;
      if (ignoreSet.has(cw)) { stats.linesIgnored++; return; }
      const productId = skuToId.get(cw);
      if (!productId) {
        stats.linesUnmapped++;
        unmappedSamples.set(cw, (unmappedSamples.get(cw) || 0) + 1);
        return;
      }
      // Find the parent sales_entry. The notes tag includes the source
      // order id and the line's position within the order, separated by colons.
      const tagPrefix = `[miniapp:${o.source_order_id}:${idx}]%`;
      const sale = findSale.get(tagPrefix);
      if (!sale) { stats.linesMissingSale++; return; }
      if (!DRY) {
        insertAddon.run(sale.id, productId, 1, 'miniapp', cw);
      }
      stats.addonsInserted++;
    });
  }
});

tx();

console.log(DRY ? '🔍 DRY-RUN — no rows written' : '✅ Backfill complete');
console.log(`  miniapp lines scanned:       ${stats.linesScanned}`);
console.log(`  lines with combine_with:     ${stats.linesWithCombine}`);
console.log(`    ignored (no-thanks/promo): ${stats.linesIgnored}`);
console.log(`    unmapped (need entry):     ${stats.linesUnmapped}`);
console.log(`    parent sale not found:     ${stats.linesMissingSale}`);
console.log(`  sale_addons ${DRY ? 'would insert' : 'inserted'}: ${stats.addonsInserted}`);
if (unmappedSamples.size) {
  console.log('\nUnmapped combine_with values (add to scripts/addon_mapping.json):');
  for (const [cw, n] of [...unmappedSamples.entries()].sort((a,b) => b[1]-a[1])) {
    console.log(`  ${String(n).padStart(4)} × ${cw}`);
  }
}
