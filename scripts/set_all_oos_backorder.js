#!/usr/bin/env node
/**
 * Bulk-set EVERY store product's out-of-stock policy to "backorder outside
 * Guangzhou" (store_products.oos_policy = 'backorder_gz').
 *
 * After this runs, any sold-out product stays orderable for out-of-city
 * shoppers (badge 现订现发 / SHIPS SOON, or 下批现做 / NEXT BATCH for batch
 * meals); only same-day Guangzhou keeps the hard SOLD OUT. See
 * effectiveOosPolicy() in routes/retail.js + the per-product editor control.
 *
 * Operator requested 2026-06-20: "make all products preorder outside guangzhou".
 *
 * Scope: ALL rows in store_products (every product AND every variant). This
 * sets an EXPLICIT policy, so it does not depend on the is_batch_made fallback.
 * NEW products created later still default to 'strict' (the editor default) —
 * re-run this any time to sweep them in, or change them per-product.
 *
 * Idempotent: rows already 'backorder_gz' are left untouched.
 *
 * Usage (on the PROD server, against the live DB):
 *   node scripts/set_all_oos_backorder.js            # dry-run (no writes)
 *   node scripts/set_all_oos_backorder.js --apply    # write
 *
 * Run on /root/roots-v2/data/roots.db (the live retail DB), NOT a stale local
 * copy. Override the path with ROOTS_DB=... if needed.
 */
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='store_products'").get()) {
  console.error('Table store_products missing — run this on the prod server\'s data/roots.db.');
  process.exit(1);
}
const cols = db.prepare('PRAGMA table_info(store_products)').all().map(c => c.name);
if (!cols.includes('oos_policy')) {
  console.error('Column oos_policy missing — deploy the per-product OOS policy migration first (boot the server once).');
  process.exit(1);
}

const before = {
  total:        db.prepare('SELECT COUNT(*) n FROM store_products').get().n,
  backorder_gz: db.prepare("SELECT COUNT(*) n FROM store_products WHERE oos_policy='backorder_gz'").get().n,
  strict:       db.prepare("SELECT COUNT(*) n FROM store_products WHERE oos_policy='strict'").get().n,
  blank:        db.prepare("SELECT COUNT(*) n FROM store_products WHERE oos_policy IS NULL OR oos_policy=''").get().n,
};
const willChange = before.total - before.backorder_gz;

console.log('DB:', DB_PATH);
console.log('Before:', JSON.stringify(before));
console.log(`Rows to set -> 'backorder_gz': ${willChange}` + (willChange === 0 ? ' (already all backorder)' : ''));

if (!APPLY) {
  console.log('\nDRY RUN — no changes written. Re-run with --apply to write.');
  process.exit(0);
}

const res = db.prepare(
  "UPDATE store_products SET oos_policy='backorder_gz' WHERE oos_policy IS NOT 'backorder_gz' OR oos_policy IS NULL"
).run();

const after = db.prepare("SELECT COUNT(*) n FROM store_products WHERE oos_policy='backorder_gz'").get().n;
console.log(`\nAPPLIED. Rows updated: ${res.changes}. Now backorder_gz: ${after}/${before.total}.`);
