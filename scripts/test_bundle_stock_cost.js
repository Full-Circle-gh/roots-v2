#!/usr/bin/env node
/**
 * test_bundle_stock_cost.js — a bundle is read, priced and stocked from its
 * parts honestly, and a sale's cost lookup can never lose the sale.
 *
 *   node scripts/test_bundle_stock_cost.js
 *
 * WHAT IT GUARDS. A mutation sweep of routes/retail.js (2026-10-14) broke the
 * bundle helpers and the cost-of-sale wrappers 18 ways, and no suite noticed:
 *
 *   • parseBundleItems let duplicate, zero and junk product ids through, and
 *     left a quantity of 0 as 0 — a part needed 0 times, which makes the
 *     bundle's stock floor(stock / 0) = Infinity.
 *   • sanitizeBundleItems could keep a bundle as its own part.
 *   • resolveBundleComponents could call an unpublished or switched-off part
 *     available.
 *   • decorateBundleRow could show a bundle in stock with a part missing, and
 *     show the "save ¥X" badge when nothing is saved.
 *   • optionsCostAtSale could throw on a line with no options list. It runs
 *     inside the transaction that writes the order, so a throw there rolls
 *     back a real sale.
 *
 * HOW. The real functions are lifted from the source (retailSource(), so they
 * are found in routes/retail.js or in lib/ after decisions §477 moves them) and
 * run over the real table definitions, with the real stock and image SQL from
 * lib/inventory.js and lib/product-image-sql.js. The cost wrappers run against
 * stand-in cost readers so the "never throws" promise can be tested by making
 * the reader throw.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openMemoryDb, addTables, addForkedStoreProducts } = require('./test-support/memory-db');
const { retailSource } = require('./test-support/retail-source');

const ROOT = path.join(__dirname, '..');
const SRC = retailSource();
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const SCHEMA_SRC = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');

function fnSrc(name) {
  const at = SRC.search(new RegExp(`^function ${name}\\(`, 'm'));
  assert.ok(at >= 0, `function ${name} not found`);
  return SRC.slice(at, SRC.indexOf('\n}', at) + 2);
}

// ── the real tables, the real SQL helpers ─────────────────────────────────
const db = openMemoryDb();
addTables(db, DB_SRC, DB_SRC, ['retail_stores', 'retail_store_stock', 'channel_status', 'store_business_status']);
addForkedStoreProducts(db, SCHEMA_SRC, DB_SRC);
const inventory = require(path.join(ROOT, 'lib', 'inventory'));
const { hasImageFallbackSql } = require(path.join(ROOT, 'lib', 'product-image-sql'));

const quiet = { error() {} };
const lift = (names, params, args) =>
  new Function(...params, `${names.map(fnSrc).join('\n')}\nreturn { ${names.join(', ')} };`)(...args);
const B = lift(['parseBundleItems', 'sanitizeBundleItems', 'resolveBundleComponents', 'decorateBundleRow'],
  ['tdb', 'inventory', 'hasImageFallbackSql'], [() => db, inventory, hasImageFallbackSql]);

db.prepare("INSERT INTO retail_stores (id, code, name_en, is_active) VALUES (1, 'tianhe', 'Tianhe', 1)").run();
const product = db.prepare(`INSERT INTO store_products (id, sku, name_en, sell_price, is_published, is_active, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?, '2040-01-04 10:00:00')`);
const shelf = db.prepare('INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (1, ?, ?)');
product.run(1, 'W1', 'Wrap', 30, 1, 1);    shelf.run(1, 9);
product.run(2, 'S1', 'Salad', 25, 1, 1);   shelf.run(2, 4);
product.run(3, 'J1', 'Juice', 10, 0, 1);   shelf.run(3, 50);   // not published
product.run(4, 'K1', 'Kombucha', 12, 1, 0); shelf.run(4, 50);  // switched off
product.run(5, 'T1', 'Tea', 8, 1, null);   shelf.run(5, 6);    // is_active unset: on
db.prepare("UPDATE store_products SET image_url = 'https://img.test/tea.jpg' WHERE id = 5").run();

const pending = [];
const section = (t) => pending.push(() => console.log('\n' + t));
const it = (name, fn) => pending.push(() => {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
});
let pass = 0, fail = 0;
const same = (a, b, m) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), b, m);

// ══ 1. reading a bundle's recipe ═══════════════════════════════════════════
section('1. a bundle recipe is read as clean [{ id, qty }]');

it('JSON text or an array; product_id is accepted for id', () => {
  same(B.parseBundleItems('[{"id":1,"qty":2},{"product_id":2,"qty":1}]'), [{ id: 1, qty: 2 }, { id: 2, qty: 1 }]);
  same(B.parseBundleItems([{ id: '3', qty: '4' }]), [{ id: 3, qty: 4 }]);
});
it('not a bundle, broken JSON or not a list → empty', () => {
  for (const v of [null, '', 'not json', '{"id":1}', 7]) same(B.parseBundleItems(v), [], JSON.stringify(v));
});
it('a part listed twice is counted once, as first listed', () => {
  same(B.parseBundleItems([{ id: 1, qty: 2 }, { id: 1, qty: 5 }]), [{ id: 1, qty: 2 }]);
});
it('a zero, negative or junk product id is skipped', () => {
  same(B.parseBundleItems([{ id: 0 }, { id: -2 }, { id: 'x' }, {}, null, { id: 2, qty: 1 }]), [{ id: 2, qty: 1 }]);
});
it('a missing, zero, negative or junk quantity means one, never zero', () => {
  same(B.parseBundleItems([{ id: 1 }, { id: 2, qty: 0 }, { id: 3, qty: -1 }, { id: 4, qty: 'x' }]),
    [{ id: 1, qty: 1 }, { id: 2, qty: 1 }, { id: 3, qty: 1 }, { id: 4, qty: 1 }]);
});

it('stored form: a bundle cannot contain itself, even when its id comes in as text', () => {
  assert.strictEqual(B.sanitizeBundleItems([{ id: 7 }, { id: 1, qty: 2 }], '7'), '[{"id":1,"qty":2}]');
});
it('stored form: at most 20 parts; nothing left → null, which clears it', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }));
  assert.strictEqual(JSON.parse(B.sanitizeBundleItems(many)).length, 20);
  assert.strictEqual(B.sanitizeBundleItems([{ id: 7 }], 7), null);
  assert.strictEqual(B.sanitizeBundleItems(null), null);
});

// ══ 2. the parts, as the shop shows them ═══════════════════════════════════
section('2. each part is shown with its own shelf, and only a live part is available');

it('parts come back in recipe order with their quantity, price and shelf stock', () => {
  const c = B.resolveBundleComponents([{ id: 2, qty: 1 }, { id: 1, qty: 2 }]);
  same(c.map((x) => [x.id, x.qty, x.price, x.stock]), [[2, 1, 25, 4], [1, 2, 30, 9]]);
});
it('available: published AND switched on (or never set); not either one alone', () => {
  const c = B.resolveBundleComponents([{ id: 1 }, { id: 3 }, { id: 4 }, { id: 5 }]);
  same(c.map((x) => [x.id, x.available]), [[1, true], [3, false], [4, false], [5, true]]);
});
it('a part with a photo links it with its updated time, so a new photo is not served stale', () => {
  const [tea, wrap] = B.resolveBundleComponents([{ id: 5 }, { id: 1 }]);
  assert.strictEqual(tea.image_data, '/api/retail/products/5/image?v=2040-01-04%2010%3A00%3A00');
  assert.strictEqual(wrap.image_data, null, 'no photo, no link');
});
it('a part that no longer exists is left out, not invented', () => {
  same(B.resolveBundleComponents([{ id: 1 }, { id: 99 }]).map((x) => x.id), [1]);
});

// ══ 3. a bundle row on the shop ════════════════════════════════════════════
section('3. a bundle\'s stock is what its parts can make; the save badge only when it saves');

const row = (recipe, price) => ({ id: 50, sell_price: price, stock: 999, bundle_items: JSON.stringify(recipe) });

it('stock is the fewest bundles any one part can make: min(9 / 2, 4 / 1) = 4', () => {
  const r = B.decorateBundleRow(row([{ id: 1, qty: 2 }, { id: 2, qty: 1 }], 70));
  assert.strictEqual(r.is_bundle, true);
  assert.strictEqual(r.stock, 4);
});
it('a part that is not available makes the bundle sold out', () => {
  assert.strictEqual(B.decorateBundleRow(row([{ id: 1 }, { id: 3 }], 30)).stock, 0);
});
it('a part that no longer exists makes the bundle sold out, not in stock', () => {
  assert.strictEqual(B.decorateBundleRow(row([{ id: 1 }, { id: 99 }], 30)).stock, 0);
});
it('save badge: parts worth ¥85 against ¥70 → bundle_worth 85', () => {
  assert.strictEqual(B.decorateBundleRow(row([{ id: 1, qty: 2 }, { id: 2, qty: 1 }], 70)).bundle_worth, 85);
});
it('save badge: parts worth exactly the price, or less, → no badge', () => {
  assert.ok(!('bundle_worth' in B.decorateBundleRow(row([{ id: 1, qty: 2 }, { id: 2, qty: 1 }], 85))));
  assert.ok(!('bundle_worth' in B.decorateBundleRow(row([{ id: 1 }], 40))));
});
it('save badge: a bundle priced through `price` rather than `sell_price` is compared the same way', () => {
  const r = { id: 51, price: 70, bundle_items: JSON.stringify([{ id: 1, qty: 2 }, { id: 2, qty: 1 }]) };
  assert.strictEqual(B.decorateBundleRow(r).bundle_worth, 85);
});
it('the raw recipe never reaches the customer; the parts only when asked for', () => {
  const plain = B.decorateBundleRow(row([{ id: 1 }], 20));
  assert.ok(!('bundle_items' in plain) && !('bundle_components' in plain));
  const pdp = B.decorateBundleRow(row([{ id: 1 }], 20), { withComponents: true });
  same(pdp.bundle_components.map((c) => c.id), [1]);
});
it('an ordinary product is left alone and marked not a bundle', () => {
  const r = B.decorateBundleRow({ id: 1, stock: 9, bundle_items: null });
  assert.strictEqual(r.is_bundle, false);
  assert.strictEqual(r.stock, 9);
});

// ══ 4. a sale's cost lookup cannot lose the sale ═══════════════════════════
section('4. the cost stamped on an order line: the reader\'s answer, or null — never a throw');

let calls = 0, mode = 'ok';
const reader = () => { calls++; if (mode === 'throw') throw new Error('cost table locked'); return 12.5; };
const C = lift(['costAtSale', 'optionsCostAtSale'], ['productUnitCostYuan', 'chosenOptionCostYuan', 'console'],
  [reader, (h, opts) => { calls++; if (mode === 'throw') throw new Error('options broken'); return { yuan: opts.length * 2 }; }, quiet]);

it('a product\'s unit cost is the one reader\'s answer', () => {
  mode = 'ok';
  assert.strictEqual(C.costAtSale(db, 1), 12.5);
});
it('no product (an unmatched channel line) → null, without a lookup', () => {
  calls = 0;
  assert.strictEqual(C.costAtSale(db, null), null);
  assert.strictEqual(calls, 0);
});
it('a reader that throws → null, and the sale goes on', () => {
  mode = 'throw';
  assert.strictEqual(C.costAtSale(db, 1), null);
  mode = 'ok';
});
it('options: the chosen extras\' cost, or null for a line with none', () => {
  assert.strictEqual(C.optionsCostAtSale(db, [{ a: 1 }, { b: 2 }]), 4);
  calls = 0;
  for (const v of [[], null, undefined, 'x', { length: 2 }]) assert.strictEqual(C.optionsCostAtSale(db, v), null, JSON.stringify(v));
  assert.strictEqual(calls, 0, 'nothing to look up, so nothing is looked up');
});
it('options: a reader that throws → null, and the sale goes on', () => {
  mode = 'throw';
  assert.strictEqual(C.optionsCostAtSale(db, [{ a: 1 }]), null);
  mode = 'ok';
});

for (const step of pending) step();
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
