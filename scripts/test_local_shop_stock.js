#!/usr/bin/env node
/**
 * test_local_shop_stock.js — a same-day Guangzhou shopper is shown their
 * nearest shop's shelf, not every shop added together (decisions §481).
 *
 *   node scripts/test_local_shop_stock.js
 *
 * WHAT RAISED IT. TC001259 parked at 越秀 for Mix Berries Kombucha ×5 and
 * Passion Fruit Kombucha ×1. 越秀 held 4 and 0, 天河 2 and 1. The menu showed the
 * sum (6 and 1) and never limited quantity, checkout asked the nearest shop
 * only, and the order went to "awaiting restock". Section 4 replays it.
 *
 * WHAT IT PINS.
 *   1. The per-shop column: open shops only, safety buffer off, floored at 0,
 *      NULL for a product never stocked per-shop — run on the real tables.
 *   2. The nearest shop: one copy of checkout's store order, used by both
 *      analyzeShortage and the address book; only a local-run address is
 *      stamped, and a failed lookup leaves the field off.
 *   3. The app: utils/local-stock reads the shopper's own shop on the run and
 *      the sum everywhere else; the cart's + stops at that shop's count.
 *   4. TC001259, from database rows to the cart.
 *
 * No network, no WeChat runtime: the app modules load under a stubbed wx /
 * getApp, and the server SQL runs on an in-memory copy of the real tables.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openMemoryDb, addTables, addForkedStoreProducts } = require('./test-support/memory-db');
const { retailSource } = require('./test-support/retail-source');

const ROOT = path.join(__dirname, '..');
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const SCHEMA_SRC = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
const INV_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'inventory.js'), 'utf8');
const SRC = retailSource();

let pass = 0, fail = 0;
const pending = [];
const section = (t) => pending.push(() => console.log('\n' + t));
const it = (name, fn) => pending.push(async () => {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
});

function fnSrc(src, name) {
  const at = src.search(new RegExp(`^(async )?function ${name}\\(`, 'm'));
  assert.ok(at >= 0, `function ${name} not found`);
  return src.slice(at, src.indexOf('\n}', at) + 2);
}

// ── the real tables, and the real SQL ──────────────────────────────────────
const db = openMemoryDb();
addTables(db, DB_SRC, DB_SRC, ['retail_stores', 'retail_store_stock', 'channel_status', 'store_business_status']);
addForkedStoreProducts(db, SCHEMA_SRC, DB_SRC);
const inventory = require(path.join(ROOT, 'lib', 'inventory'));
const { parseStockByStore } = require(path.join(ROOT, 'lib', 'product-rows'));

const YX = 1, TH = 2, OLD = 3;
db.prepare("INSERT INTO retail_stores (id, code, name_en, is_active) VALUES (?, ?, ?, ?)").run(YX, 'yuexiu', 'Yuexiu', 1);
db.prepare("INSERT INTO retail_stores (id, code, name_en, is_active) VALUES (?, ?, ?, ?)").run(TH, 'tianhe', 'Tianhe', 1);
db.prepare("INSERT INTO retail_stores (id, code, name_en, is_active) VALUES (?, ?, ?, ?)").run(OLD, 'retired', 'Old shop', 0);
const prod = db.prepare("INSERT INTO store_products (id, sku, name_en, sell_price, stock_qty, is_active) VALUES (?, ?, ?, 10, ?, 1)");
const shelf = db.prepare("INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer) VALUES (?, ?, ?, ?)");
const MB = 285, PF = 283, LEGACY = 7, BUF = 8, NOWHERE = 9;
prod.run(MB, '2-100', 'Mix Berries Kombucha', 0);
prod.run(PF, '2-80', 'Passion Fruit Kombucha', 0);
prod.run(LEGACY, 'L', 'Never stocked per shop', 12);
prod.run(BUF, 'B', 'Buffered', 0);
prod.run(NOWHERE, 'N', 'Only at 天河', 0);
shelf.run(YX, MB, 4, 0); shelf.run(TH, MB, 2, 0);          // TC001259's numbers
shelf.run(YX, PF, 0, 0); shelf.run(TH, PF, 1, 0);
shelf.run(YX, BUF, 3, 1); shelf.run(TH, BUF, 1, 5);         // buffer off; never below 0
shelf.run(TH, NOWHERE, 9, 0);                                // tracked at one shop only
shelf.run(OLD, LEGACY, 9, 0);                                // a retired shop counts as no shop

const row = (id) => parseStockByStore(db.prepare(
  `SELECT p.id, ${inventory.sellableStockSql('p.id', 'p.stock_qty')} AS stock,
          ${inventory.stockByStoreSql('p.id')} AS stock_by_store
     FROM store_products p WHERE p.id = ?`).get(id));

// ══ 1 ══════════════════════════════════════════════════════════════════════
section('1. the per-shop column: the same open shelves as the sum, one shop at a time');

it('each open shop by its code; the sum beside it is unchanged', () => {
  assert.deepStrictEqual(row(MB).stock_by_store, { yuexiu: 4, tianhe: 2 });
  assert.strictEqual(row(MB).stock, 6);
});
it('the safety buffer comes off, and a shop never reads below zero', () => {
  assert.deepStrictEqual(row(BUF).stock_by_store, { yuexiu: 2, tianhe: 0 });
});
it('never stocked per shop → null, so the app falls back to the legacy number', () => {
  assert.strictEqual(row(LEGACY).stock_by_store, null);
  assert.strictEqual(row(LEGACY).stock, 12);
});
it('tracked, but its only shop is closed → an empty map: a real zero, as the sum reads it', () => {
  db.prepare("INSERT INTO store_business_status (store_code, fulfillment_open) VALUES ('tianhe', 0)").run();
  try {
    assert.deepStrictEqual(row(NOWHERE).stock_by_store, {});
    assert.strictEqual(row(NOWHERE).stock, 0);
  } finally {
    db.prepare("DELETE FROM store_business_status WHERE store_code = 'tianhe'").run();
  }
});
it('a shelf at a retired shop is no shelf: still null and the legacy number, as the sum treats it', () => {
  assert.strictEqual(row(LEGACY).stock_by_store, null);
  assert.strictEqual(row(LEGACY).stock, 12);
});
it('a shop closed for the storefront drops out, exactly as it drops out of the sum', () => {
  db.prepare("INSERT INTO store_business_status (store_code, fulfillment_open) VALUES ('tianhe', 0)").run();
  try {
    assert.deepStrictEqual(row(MB).stock_by_store, { yuexiu: 4 });
    assert.strictEqual(row(MB).stock, 4);
  } finally {
    db.prepare("DELETE FROM store_business_status WHERE store_code = 'tianhe'").run();
  }
});

// ══ 2 ══════════════════════════════════════════════════════════════════════
section('2. the nearest shop: checkout\'s answer, given to the address book');

it('analyzeShortage orders its stores through the shared helper — one copy of the tiers', () => {
  const body = fnSrc(INV_SRC, 'analyzeShortage');
  assert.ok(/await orderStoresForAddress\(stores, address\)/.test(body), 'analyzeShortage no longer uses orderStoresForAddress');
  assert.ok(!/rankStoresByProximity/.test(body), 'analyzeShortage carries its own copy of the store order again');
});
it('with a pin, the closer shop comes first (straight line when no road-distance key is set)', async () => {
  const stores = [
    { id: TH, code: 'tianhe', district: '天河区', lat: 23.135, lng: 113.330 },
    { id: YX, code: 'yuexiu', district: '越秀区', lat: 23.129, lng: 113.266 },
  ];
  const order = await inventory.orderStoresForAddress(stores, { lat: 23.130, lng: 113.270, district: '越秀区' });
  assert.deepStrictEqual(order.map(s => s.code), ['yuexiu', 'tianhe']);
});

const stampSrc = fnSrc(SRC, 'stampNearestStore');
const makeStamp = (inv) => new Function('inventory', `${stampSrc}\nreturn stampNearestStore;`)(inv);
it('only a local-run address is stamped; out-of-city keeps the sum by leaving the field off', async () => {
  const stamp = makeStamp({ nearestStoreForAddress: async () => ({ code: 'yuexiu' }) });
  const rows = await stamp([{ id: 1, local_run: true }, { id: 2, local_run: false }]);
  assert.strictEqual(rows[0].nearest_store, 'yuexiu');
  assert.ok(!('nearest_store' in rows[1]));
});
it('a failed lookup leaves the field off rather than failing the address book', async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const stamp = makeStamp({ nearestStoreForAddress: async () => { throw new Error('boom'); } });
    const rows = await stamp([{ id: 1, local_run: true }]);
    assert.ok(!('nearest_store' in rows[0]));
  } finally { console.warn = warn; }
});
it('the address book route stamps it, after same_city / local_run are known', () => {
  const at = SRC.indexOf("router.get('/api/retail/addresses'");
  assert.ok(at >= 0, 'addresses route not found');
  const route = SRC.slice(at, SRC.indexOf('\n});', at));
  assert.ok(/stampSameCity\([\s\S]*await stampNearestStore\(data\)/.test(route), 'nearest_store is no longer stamped after local_run');
});

// ══ 3 ══════════════════════════════════════════════════════════════════════
section('3. the app: their shop on the run, the sum everywhere else; the + stops there');

// A minimal WeChat: storage for the cart, a toast we can read back.
const toasts = [];
const storage = {};
let appData = { lang: 'en', activeAddressId: null };
global.getApp = () => ({ globalData: appData, authReady: Promise.resolve() });
global.wx = new Proxy({
  getStorageSync: (k) => storage[k],
  setStorageSync: (k, v) => { storage[k] = JSON.parse(JSON.stringify(v)); },
  showToast: (o) => toasts.push(o.title),
}, { get: (t, k) => (k in t ? t[k] : () => {}) });
const APP = path.join(ROOT, 'miniapp', 'utils');
const delivery = require(path.join(APP, 'delivery.js'));
const localStock = require(path.join(APP, 'local-stock.js'));
const cart = require(path.join(APP, 'cart.js'));

const NEAR_YUEXIU = [{ id: 11, local_run: true, nearest_store: 'yuexiu', is_default: true }];
const SHANGHAI    = [{ id: 12, local_run: false, is_default: true }];
const NEAR_TIANHE = [{ id: 13, local_run: true, nearest_store: 'tianhe', is_default: true }];
const at = (list) => { delivery.prime(list); };
const resetCart = () => { cart.clear(); toasts.length = 0; };
const mb = () => ({ ...row(MB) });
const pf = () => ({ ...row(PF) });

it('near 越秀: their shop\'s count; near 天河: theirs; Shanghai: both shops added together', () => {
  at(NEAR_YUEXIU); assert.strictEqual(localStock.of(mb()), 4); assert.strictEqual(localStock.of(pf()), 0);
  at(NEAR_TIANHE); assert.strictEqual(localStock.of(mb()), 2); assert.strictEqual(localStock.of(pf()), 1);
  at(SHANGHAI);    assert.strictEqual(localStock.of(mb()), 6); assert.strictEqual(localStock.of(pf()), 1);
});
it('no saved address, or an address the server stamped no shop on → the sum, as before', () => {
  at([]); assert.strictEqual(localStock.of(mb()), 6);
  at([{ id: 14, local_run: true, is_default: true }]); assert.strictEqual(localStock.of(mb()), 6);
  assert.strictEqual(localStock.cap(mb()), null);
});
it('a row with no per-shop map reads its own stock; untracked stays untracked', () => {
  at(NEAR_YUEXIU);
  assert.strictEqual(localStock.of({ stock: 12, stock_by_store: null }), 12);
  assert.strictEqual(localStock.of({ stock: null }), null);
  assert.strictEqual(localStock.of({ stock: 3, stock_by_store: '{"yuexiu":1}' }), 1, 'JSON text is read too');
});
it('the cap: only on the run, and never for a row the shopper may reserve or a supplier row', () => {
  at(NEAR_YUEXIU);
  assert.strictEqual(localStock.cap(mb()), 4);
  assert.strictEqual(localStock.cap({ ...mb(), oos_preorder: true, oos_preorder_local: true }), null);
  assert.strictEqual(localStock.cap({ ...mb(), oos_preorder: true, local_fresh_date: '2026-10-17' }), null);
  assert.strictEqual(localStock.cap({ ...mb(), oos_preorder: true }), 4, "a 'backorder_gz' row is shelf-bound on the run");
  assert.strictEqual(localStock.cap({ ...mb(), ship_from_supplier: 1 }), null);
  at(SHANGHAI);
  assert.strictEqual(localStock.cap(mb()), null);
});
it('the + stops at their shop: 5 asked, 4 in the cart, and the shopper is told', () => {
  at(NEAR_YUEXIU); resetCart();
  cart.add(mb(), 5, []);
  assert.strictEqual(cart.count(), 4);
  assert.deepStrictEqual(cart.lastAdd(), { added: 4, cap: 4 });
  assert.deepStrictEqual(toasts, ['Only 4 left']);
});
it('a further add at the limit adds nothing and says so again; an add under it is quiet', () => {
  at(NEAR_YUEXIU); resetCart();
  cart.add(mb(), 3, []);
  assert.deepStrictEqual(cart.lastAdd(), { added: 3, cap: null });
  assert.deepStrictEqual(toasts, []);
  cart.add(mb(), 1, []); cart.add(mb(), 1, []);
  assert.strictEqual(cart.count(), 4);
  assert.deepStrictEqual(cart.lastAdd(), { added: 0, cap: 4 });
  assert.deepStrictEqual(toasts, ['Only 4 left']);
});
it('the limit counts every line of the product, whatever its options', () => {
  at(NEAR_YUEXIU); resetCart();
  cart.add(mb(), 3, [{ choice_id: 1 }]);
  cart.add(mb(), 3, [{ choice_id: 2 }]);
  assert.strictEqual(cart.count(), 4);
});
it('the cart page\'s + keeps to it too; − is never refused', () => {
  at(NEAR_YUEXIU); resetCart();
  const key = cart.add(mb(), 4, []);
  cart.setQty(key, 5);
  assert.strictEqual(cart.count(), 4);
  assert.deepStrictEqual(toasts, ['Only 4 left']);
  cart.setQty(key, 2);
  assert.strictEqual(cart.count(), 2);
});
it('switching to an out-of-city address lifts a limit the cart line picked up on the run', () => {
  at(NEAR_YUEXIU); resetCart();
  const key = cart.add(mb(), 4, []);
  at(SHANGHAI);
  cart.setQty(key, 6);
  assert.strictEqual(cart.count(), 6);
});
it('a screen that builds its own line passes the cap as stock_cap, and it is honoured', () => {
  at(NEAR_YUEXIU); resetCart();
  cart.add({ id: MB, name_en: 'x', price: 10, stock_cap: localStock.cap(mb()) }, 9, []);
  assert.strictEqual(cart.count(), 4);
});
it('a re-pick from checkout does not count the line it replaces (§433)', () => {
  at(NEAR_YUEXIU); resetCart();
  const oldKey = cart.add(mb(), 4, []);                       // the unanswered line
  cart.add(mb(), 4, [{ choice_id: 7 }], { replacing: oldKey }); // the answered one
  assert.deepStrictEqual(cart.lastAdd(), { added: 4, cap: null });
  cart.remove(oldKey);                                         // the page then drops it
  assert.strictEqual(cart.count(), 4);
});
it('out of the city nothing is limited — the old rule, by Ash\'s choice', () => {
  at(SHANGHAI); resetCart();
  cart.add(mb(), 9, []);
  assert.strictEqual(cart.count(), 9);
  assert.deepStrictEqual(toasts, []);
});
it('in Chinese the existing pair is used: 仅剩 N 件', () => {
  at(NEAR_YUEXIU); resetCart();
  appData = { ...appData, lang: 'cn' };
  try { cart.add(mb(), 5, []); } finally { appData = { ...appData, lang: 'en' }; }
  assert.deepStrictEqual(toasts, ['仅剩 4 件']);
});

// ══ 4 ══════════════════════════════════════════════════════════════════════
section('4. TC001259, replayed for a shopper near 越秀');

it('Passion Fruit reads sold out at their shop, Mix Berries stops at 4 — nothing reaches checkout short', () => {
  at(NEAR_YUEXIU); resetCart();
  assert.strictEqual(localStock.of(pf()), 0, 'Passion Fruit should read sold out near 越秀');
  cart.add(mb(), 5, []);
  cart.add(pf(), 1, []);
  const lines = cart.get().items.map(i => [i.product_id, i.qty]);
  assert.deepStrictEqual(lines, [[MB, 4]], 'the cart holds more than 越秀 can pack');
});
it('the same basket from Shanghai is unchanged: 5 and 1, the sum still covers it', () => {
  at(SHANGHAI); resetCart();
  cart.add(mb(), 5, []);
  cart.add(pf(), 1, []);
  assert.deepStrictEqual(cart.get().items.map(i => [i.product_id, i.qty]), [[MB, 5], [PF, 1]]);
});

(async () => {
  for (const step of pending) await step();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
