#!/usr/bin/env node
/**
 * READ-ONLY. Dumps catalog rows whose CN title or CN description contains 有机,
 * so we can craft China-compliant edits (USDA-cert phrasing) precisely.
 *
 * Writes scripts/catalog_text_dump.json. Touches nothing.
 *
 * Run ON THE PROD SERVER, from /root/roots-v2:
 *   node scripts/dump_catalog_text.js
 * Then copy scripts/catalog_text_dump.json back for review.
 */
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');
const OUT = path.join(__dirname, 'catalog_text_dump.json');

const db = new Database(DB_PATH, { readonly: true });
const cols = db.prepare('PRAGMA table_info(store_products)').all().map(c => c.name);
const has = c => cols.includes(c);

const sel = [
  'id', has('sku') ? 'sku' : `'' AS sku`, has('category') ? 'category' : `'' AS category`,
  'name_en', 'name_cn',
  has('description_en') ? 'description_en' : `'' AS description_en`,
  has('description_cn') ? 'description_cn' : `'' AS description_cn`,
].join(', ');

const rows = db.prepare(
  `SELECT ${sel} FROM store_products
   WHERE COALESCE(name_cn,'') LIKE '%有机%'
      OR COALESCE(description_cn,'') LIKE '%有机%'
      OR COALESCE(name_en,'') LIKE '%USDA%'
   ORDER BY category, name_en`
).all();

fs.writeFileSync(OUT, JSON.stringify(rows, null, 1));
console.log(`Wrote ${rows.length} rows to ${OUT}`);
console.log(`  titles with 有机     : ${rows.filter(r => (r.name_cn||'').includes('有机')).length}`);
console.log(`  descriptions with 有机: ${rows.filter(r => (r.description_cn||'').includes('有机')).length}`);
