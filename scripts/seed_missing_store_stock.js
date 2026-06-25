#!/usr/bin/env node
/**
 * Seed missing per-store stock rows.
 *
 * Why: checkout treats a product with NO `retail_store_stock` row at a store
 * as out-of-stock (getAvailable → exists:false). Yuexiu was only partially
 * seeded, so any cart containing a product Yuexiu never got a row for bounces
 * into the out-of-stock fallback even though the item is on the shelf. (This
 * is what made a Haizhu customer see "Yuexiu is short of stock" because of
 * Kara Coconut Cream #131, which had no Yuexiu row.)
 *
 * This lists every published + active NON-bundle product that has no stock row
 * at the target store (default: yuexiu) and, on --apply, creates a row with a
 * starting physical_qty you choose, writing a retail_stock_ledger audit entry.
 *
 * Bundle products are skipped (they have no stock of their own — checkout
 * deducts their COMPONENTS' stock); any missing component rows show up on
 * their own as normal products.
 *
 * READ-ONLY by default (prints a plan, writes nothing). On --apply it backs up
 * data/roots.db first. Run ON THE SERVER:
 *
 *   node scripts/seed_missing_store_stock.js                      # scan yuexiu (dry-run)
 *   node scripts/seed_missing_store_stock.js --store tianhe       # scan a different store
 *   node scripts/seed_missing_store_stock.js --product 131 --qty 12 --apply   # one product
 *   node scripts/seed_missing_store_stock.js --qty 10 --apply      # ALL missing at qty 10
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
function flag(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const STORE_CODE = flag('--store', 'yuexiu');
const ONLY_PRODUCT = flag('--product', null);          // seed a single product id
const QTY = flag('--qty', null) != null ? parseInt(flag('--qty', null), 10) : null;

const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');
const db = new Database(DB_PATH);

const store = db.prepare('SELECT id, code, name_en FROM retail_stores WHERE code = ?').get(STORE_CODE);
if (!store) { console.error(`No store with code "${STORE_CODE}". Known:`, db.prepare('SELECT code FROM retail_stores').all().map(r => r.code).join(', ')); process.exit(1); }

const refStore = db.prepare("SELECT id, name_en FROM retail_stores WHERE code != ? AND is_active = 1 ORDER BY sort_order LIMIT 1").get(STORE_CODE);

function parseBundle(json) { try { const a = JSON.parse(json); return Array.isArray(a) ? a.filter(x => x && x.id) : []; } catch { return []; } }

// Published + active products with NO stock row at the target store.
let products = db.prepare(`
  SELECT p.id, p.name_en, p.name_cn, p.sku, p.bundle_items
    FROM store_products p
   WHERE p.is_published = 1 AND COALESCE(p.is_active, 1) = 1
     AND NOT EXISTS (SELECT 1 FROM retail_store_stock s WHERE s.store_id = ? AND s.product_id = p.id)
   ORDER BY p.sku, p.id
`).all(store.id);

if (ONLY_PRODUCT) products = products.filter(p => p.id === parseInt(ONLY_PRODUCT, 10));

const bundles = products.filter(p => parseBundle(p.bundle_items).length > 0);
const seedable = products.filter(p => parseBundle(p.bundle_items).length === 0);

const refQty = (pid) => {
  if (!refStore) return '-';
  const r = db.prepare('SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?').get(refStore.id, pid);
  return r ? r.physical_qty : 'none';
};

console.log(`\nTarget store: #${store.id} ${store.code} (${store.name_en})`);
console.log(`Published+active products with NO ${store.code} stock row: ${products.length}  (seedable: ${seedable.length}, bundles skipped: ${bundles.length})`);
console.log(`Reference store for current counts: ${refStore ? refStore.name_en : '(none)'}\n`);

console.log('  product                                          sku        ' + (refStore ? refStore.name_en + ' qty' : ''));
for (const p of seedable) {
  console.log(`  #${String(p.id).padEnd(5)} ${String(p.name_en || p.name_cn || '').slice(0, 40).padEnd(42)} ${String(p.sku || '-').padEnd(10)} ${refQty(p.id)}`);
}
if (bundles.length) {
  console.log(`\n  Bundles skipped (stock is component-based, no own row needed): ${bundles.map(b => '#' + b.id).join(', ')}`);
}

if (!APPLY) {
  console.log(`\nDRY RUN — nothing written. To create rows, re-run with --qty <N> --apply.`);
  console.log(`  • One product:  node scripts/seed_missing_store_stock.js --product <id> --qty <N> --apply`);
  console.log(`  • All ${seedable.length} above at the same starting count:  node scripts/seed_missing_store_stock.js --qty <N> --apply\n`);
  db.close();
  process.exit(0);
}

if (QTY == null || !(QTY >= 0)) { console.error('\n--apply needs a valid --qty <N> (the starting physical count to seed). Aborting.'); process.exit(1); }
if (!seedable.length) { console.log('\nNothing to seed.'); db.close(); process.exit(0); }

// Back up before writing.
const backup = DB_PATH.replace(/\.db$/, `.backup-seedstock-${store.code}.db`);
fs.copyFileSync(DB_PATH, backup);
console.log(`\nBacked up DB → ${path.basename(backup)}`);

const insStock = db.prepare(`
  INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer, wechat_quota, meituan_quota)
  VALUES (?, ?, ?, 0, NULL, NULL)
`);
const insLedger = db.prepare(`
  INSERT INTO retail_stock_ledger (store_id, product_id, delta, reason, balance_after, note)
  VALUES (?, ?, ?, 'restock', ?, ?)
`);
const tx = db.transaction((rows, qty) => {
  for (const p of rows) {
    insStock.run(store.id, p.id, qty);
    insLedger.run(store.id, p.id, qty, qty, `seed missing ${store.code} row (backfill)`);
  }
});
tx(seedable, QTY);

console.log(`Seeded ${seedable.length} product(s) at ${store.code} with physical_qty=${QTY}, safety_buffer=0, no channel caps.`);
console.log(`Adjust exact counts anytime in the admin (Products → per-store Stock). Available immediately — server reads live, no restart needed.\n`);
db.close();
