#!/usr/bin/env node
/**
 * Import gzgrocery pricing (a FIXED discount % off retail, per product) from the
 * partner price sheet into guanyi_product_pricing, matching by SKU.
 *
 * The sheet was converted to scripts/_guanyi_pricing.json (rows: sku, raw_sku,
 * name_en, name_cn, excel_retail, discount, excel_gz_price). We match the SKU to
 * our store_products and store the discount %. gzgrocery's price is always
 * computed as retail_price × (1 − discount_pct) at report time.
 *
 * Read-only by default (dry run). Run ON THE SERVER:
 *   node scripts/import_guanyi_pricing.js            # preview matches + gaps
 *   node scripts/import_guanyi_pricing.js --commit   # write the pricing rows
 */
'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, '..', 'data', 'roots.db'));
const COMMIT = process.argv.includes('--commit');
const SOURCE = '1gzgrocery new template.xlsx';

db.exec(`CREATE TABLE IF NOT EXISTS guanyi_product_pricing (
  product_id INTEGER PRIMARY KEY, sku TEXT, discount_pct REAL,
  excel_retail REAL, excel_gz_price REAL, source TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);

const rows = JSON.parse(fs.readFileSync(path.join(__dirname, '_guanyi_pricing.json'), 'utf8'));
console.log(`\nLoaded ${rows.length} pricing rows from the sheet.`);

// SKU → our active product (retail price for reconcile).
const prodBySku = new Map();
for (const p of db.prepare(`
  SELECT id, TRIM(sku) AS sku, name_cn, name_en, COALESCE(sell_price,0) AS retail, is_active
    FROM store_products WHERE sku IS NOT NULL AND TRIM(sku) <> ''`).all()) {
  if (!prodBySku.has(p.sku)) prodBySku.set(p.sku, p);
}

const matched = [], unmatched = [], retailMismatch = [], noRetail = [];
for (const r of rows) {
  const p = prodBySku.get(r.sku);
  if (!p) { unmatched.push(r); continue; }
  matched.push({ r, p });
  if (!p.retail) noRetail.push({ r, p });
  else if (r.excel_retail != null && Math.abs(p.retail - r.excel_retail) > 0.01) retailMismatch.push({ r, p });
}

console.log(`\nMATCHED to a product: ${matched.length} / ${rows.length}`);
console.log(`UNMATCHED (sheet SKU not in our catalogue): ${unmatched.length}`);
if (unmatched.length) for (const r of unmatched.slice(0, 30)) console.log(`   ${r.sku.padEnd(8)} ${r.name_en || r.name_cn}`);

console.log(`\n⚠ RETAIL MISMATCH (our retail_price ≠ sheet retail) — reconcile: ${retailMismatch.length}`);
for (const { r, p } of retailMismatch.slice(0, 40)) {
  console.log(`   ${r.sku.padEnd(8)} ours ¥${p.retail}  vs sheet ¥${r.excel_retail}   ${p.name_cn || p.name_en}`);
}

if (noRetail.length) {
  console.log(`\n⚠ MATCHED but our retail_price is 0/unset (can't price): ${noRetail.length}`);
  for (const { r, p } of noRetail.slice(0, 20)) console.log(`   ${r.sku.padEnd(8)} ${p.name_cn || p.name_en}`);
}

// Coverage: of the products gzgrocery actually syncs (mapped + enabled), how
// many now have a price?
const mapped = db.prepare(`SELECT product_id FROM guanyi_product_map WHERE sync_enabled=1`).all().map(x => x.product_id);
const pricedIds = new Set(matched.map(m => m.p.id));
const mappedNoPrice = mapped.filter(id => !pricedIds.has(id));
console.log(`\nCOVERAGE: ${mapped.length} sync-enabled gzgrocery products; ${mapped.length - mappedNoPrice.length} have a price, ${mappedNoPrice.length} do NOT.`);
if (mappedNoPrice.length) {
  for (const id of mappedNoPrice.slice(0, 25)) {
    const p = db.prepare('SELECT sku, name_cn, name_en FROM store_products WHERE id=?').get(id);
    console.log(`   #${id} ${p ? (p.sku + ' ' + (p.name_cn || p.name_en)) : ''}`);
  }
}

const discTally = {};
for (const { r } of matched) discTally[r.discount] = (discTally[r.discount] || 0) + 1;
console.log(`\nDiscount spread (matched): ${Object.entries(discTally).map(([d, n]) => `${Math.round(d * 100)}%×${n}`).join('  ')}`);

if (!COMMIT) {
  console.log('\nDRY RUN — nothing written. Re-run with --commit to import the prices.');
  db.close(); process.exit(0);
}

const up = db.prepare(`
  INSERT INTO guanyi_product_pricing (product_id, sku, discount_pct, excel_retail, excel_gz_price, source, updated_at)
  VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)
  ON CONFLICT(product_id) DO UPDATE SET
    sku=excluded.sku, discount_pct=excluded.discount_pct, excel_retail=excluded.excel_retail,
    excel_gz_price=excluded.excel_gz_price, source=excluded.source, updated_at=CURRENT_TIMESTAMP`);
const tx = db.transaction(() => { for (const { r, p } of matched) up.run(p.id, r.sku, r.discount, r.excel_retail, r.excel_gz_price, SOURCE); });
tx();
console.log(`\n✅ Imported ${matched.length} pricing row(s) into guanyi_product_pricing.`);
db.close();
