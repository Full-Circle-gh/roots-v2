#!/usr/bin/env node
/**
 * Repair the column-swap bug introduced by an earlier version of
 * import_products.js. Affected rows have:
 *   - status        = a numeric upstream Zoho ID (e.g. 1231939)
 *   - external_id   = literal text 'active'
 * The fix swaps them back so status='active' and external_id is the int.
 *
 * Idempotent — safe to re-run. Identifies victims by:
 *   external_id = 'active' (TEXT in an INTEGER-affinity column → stored as text)
 *   AND status  GLOB '[0-9]*'
 *
 * Run modes:
 *   node scripts/fix_products_swap.js --dry-run
 *   node scripts/fix_products_swap.js
 */
const path = require('path');
const Database = require('better-sqlite3');

const DRY = process.argv.includes('--dry-run');
const db = new Database(path.join(__dirname, '..', 'data', 'roots.db'));
db.pragma('journal_mode = WAL');

// First, see what'll be touched.
const candidates = db.prepare(`
  SELECT id, sku, name_en, status, external_id
    FROM products
   WHERE external_id = 'active'
     AND status GLOB '[0-9]*'
`).all();

console.log(`Found ${candidates.length} rows to repair.`);
if (candidates.length) {
  console.log(`Sample (first 3):`);
  for (const r of candidates.slice(0, 3)) {
    console.log(`  id=${r.id}  sku=${r.sku}  status="${r.status}" → status="active", external_id=${r.status}`);
  }
}

if (DRY) { console.log('DRY-RUN — no writes.'); process.exit(0); }

const tx = db.transaction(() => {
  const upd = db.prepare(`
    UPDATE products
       SET external_id = CAST(status AS INTEGER),
           status      = 'active',
           updated_at  = CURRENT_TIMESTAMP
     WHERE external_id = 'active'
       AND status GLOB '[0-9]*'
  `);
  return upd.run();
});

const r = tx();
console.log(`✅ Updated ${r.changes} rows.`);
