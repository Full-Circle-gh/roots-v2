#!/usr/bin/env node
/**
 * The configured warehouse is read FIRST, and it stops the fall-through.
 *
 *   node scripts/test_warehouse_store_pin.js
 *
 * routes/restock.js:_resolveWarehouseStoreId picks the location goods ship out
 * of, in three tiers: the configured id, then a warehouse-role user's bound
 * store, then whichever active store holds the most stock. Tier 1 used to read
 * `SELECT value FROM settings` — a table that exists in no schema and in no
 * live database — so it threw on every call, the bare catch swallowed it, and
 * every resolution landed on tier 3's guess. At Roots the guess was right by
 * coincidence (Tianhe IS the warehouse), which is exactly why nobody saw it.
 *
 * These assertions run against a REAL sqlite database and the REAL exported
 * resolver, so what is printed is observed behaviour rather than a reading of
 * the code. The fixture store deliberately holds ZERO stock: tier 3 can never
 * return it, so a run that answers with it can only have come from tier 1.
 */
'use strict';

const assert = require('assert');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const restock = require(path.join(ROOT, 'routes', 'restock.js'));
const resolve = restock._resolveWarehouseStoreId;
const db = tdb();

const KEY = 'stock.warehouseStoreId';
// High id, clear of the fixture blocks other tests use, and carrying no stock.
const STORE_PINNED = 9601;

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}
const setKey  = v => db.prepare(
  `INSERT INTO storefront_config (key, value_json) VALUES ('${KEY}', ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`).run(v);
const clearKey = () => db.prepare(`DELETE FROM storefront_config WHERE key = '${KEY}'`).run();

// ── Fixtures ───────────────────────────────────────────────────────────────
const saved = db.prepare(`SELECT value_json FROM storefront_config WHERE key = '${KEY}'`).get();
db.prepare(`INSERT OR IGNORE INTO retail_stores (id, code, name_en, is_active, sort_order)
            VALUES (?, '__test_pin', 'Pin fixture store', 1, 99)`).run(STORE_PINNED);

try {
  console.log('\nConfigured warehouse — tier 1');

  // The fixture store has no stock rows at all, so tiers 2 and 3 cannot reach it.
  const unpinned = (clearKey(), resolve());
  check('tier 3 alone never returns the stockless fixture store', () => {
    assert.notStrictEqual(unpinned, STORE_PINNED,
      `unpinned resolution already returned ${unpinned}; the fixture is not isolated`);
  });

  check('a configured id wins over every later tier', () => {
    setKey(JSON.stringify(STORE_PINNED));
    assert.strictEqual(resolve(), STORE_PINNED);
  });

  check('clearing it falls back to where it resolved before', () => {
    clearKey();
    assert.strictEqual(resolve(), unpinned);
  });

  console.log('\nvalue_json is JSON, and not every value is an id');

  check('a quoted string id is accepted', () => {
    setKey(JSON.stringify(String(STORE_PINNED)));
    assert.strictEqual(resolve(), STORE_PINNED);
  });

  check('a non-numeric value falls through instead of resolving to NaN', () => {
    setKey(JSON.stringify('warehouse'));
    assert.strictEqual(resolve(), unpinned);
  });

  check('zero falls through instead of resolving to store 0', () => {
    setKey(JSON.stringify(0));
    assert.strictEqual(resolve(), unpinned);
  });

  check('malformed JSON falls through instead of throwing', () => {
    db.prepare(`INSERT INTO storefront_config (key, value_json) VALUES ('${KEY}', '{not json')
                  ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`).run();
    assert.strictEqual(resolve(), unpinned);
  });

  console.log('\nThe migration wrote a value, and it is a real store');

  check('pin_warehouse_store_id_v1 has run', () => {
    const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = 'pin_warehouse_store_id_v1'").get();
    const resolvable = db.prepare(`
      SELECT 1 FROM retail_store_stock rss
        JOIN retail_stores s ON s.id = rss.store_id AND COALESCE(s.is_active,1) = 1 LIMIT 1`).get();
    // On a database with nothing to pin the migration deliberately does not
    // stamp itself, so it can pin on a later boot. Only assert when it could.
    if (resolvable) assert.ok(ran, 'migration resolvable but never stamped');
  });

  check('the pinned value names an existing store', () => {
    if (!saved) return;                       // nothing was pinned on this database
    const id = parseInt(JSON.parse(saved.value_json), 10);
    const store = db.prepare('SELECT id FROM retail_stores WHERE id = ?').get(id);
    assert.ok(store, `stock.warehouseStoreId = ${id} but no such store row exists`);
  });
} finally {
  // Put the database back exactly as it was found.
  clearKey();
  if (saved) setKey(saved.value_json);
  db.prepare('DELETE FROM retail_stores WHERE id = ?').run(STORE_PINNED);
}

console.log(failures ? `\n${failures} check(s) failed\n` : '\nAll checks passed\n');
process.exit(failures ? 1 : 0);
