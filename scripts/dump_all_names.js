#!/usr/bin/env node
/**
 * READ-ONLY. Dumps id, sku, external_id, name_en, name_cn, is_active, is_published
 * for every store_products row, so we can re-key the unmatched/ambiguous renames
 * by live id. Touches nothing.
 *
 * Run ON PROD from /root/roots-v2:  node scripts/dump_all_names.js
 * Then copy scripts/all_names_dump.json back.
 */
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');
const OUT = path.join(__dirname, 'all_names_dump.json');

const db = new Database(DB_PATH, { readonly: true });
const cols = db.prepare('PRAGMA table_info(store_products)').all().map(c => c.name);
const has = c => cols.includes(c);
const sel = [
  'id',
  has('sku') ? 'sku' : `'' AS sku`,
  has('external_id') ? 'external_id' : `NULL AS external_id`,
  'name_en', 'name_cn',
  has('is_active') ? 'is_active' : `1 AS is_active`,
  has('is_published') ? 'is_published' : `1 AS is_published`,
  has('parent_id') ? 'parent_id' : `NULL AS parent_id`,
].join(', ');

const rows = db.prepare(`SELECT ${sel} FROM store_products ORDER BY id`).all();
fs.writeFileSync(OUT, JSON.stringify(rows, null, 1));
console.log(`Wrote ${rows.length} rows to ${OUT}`);
