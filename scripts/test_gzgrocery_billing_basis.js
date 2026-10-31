#!/usr/bin/env node
/**
 * §429 — THE GZGROCERY BILL IS READ FROM THE ORDERS, AT THE ORDER'S PRICE,
 * ON THE SHOP'S DAY.
 *
 *   node scripts/test_gzgrocery_billing_basis.js
 *
 * lib/gzgrocery-billing.js against a throwaway in-memory database, plus the
 * Billing route's week numbering against SQLite's own. What is pinned is what
 * §429 decides and what a later edit could quietly undo:
 *   • a price change after an order does not move that order's bill;
 *   • an order at 07:30 Guangzhou on the 28th is billed on the 28th, not the
 *     27th (UTC);
 *   • a cancelled gzgrocery order, and any other channel's order, bill nothing;
 *   • the dormant drift log still counts, on the shop's day, at today's price;
 *   • a tenant with neither the pricing table nor the drift log still reads.
 * No browser, no network — fast shard.
 */
'use strict';

process.exitCode = 1;

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('@libsql/client');

const ROOT = path.join(__dirname, '..');
const { billingRows } = require(path.join(ROOT, 'lib', 'gzgrocery-billing.js'));
const ROUTE = fs.readFileSync(path.join(ROOT, 'routes', 'guanyi-admin.js'), 'utf8');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
const SHIFT = '+480 minutes';

function mkDb({ pricing = true, drift = true } = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE store_products (id INTEGER PRIMARY KEY, sku TEXT, name_cn TEXT, name_en TEXT, sell_price REAL);
    CREATE TABLE retail_orders (id INTEGER PRIMARY KEY, order_no TEXT, status TEXT, channel TEXT,
      placed_at TEXT, paid_at TEXT, replacement_for_order_id INTEGER);
    CREATE TABLE retail_order_items (id INTEGER PRIMARY KEY, order_id INTEGER, product_id INTEGER, sku TEXT,
      qty INTEGER, pack_units INTEGER NOT NULL DEFAULT 1, unit_price REAL, line_total REAL);
    INSERT INTO store_products VALUES (1, '1-10', '鹰嘴豆泥', 'Hummus', 38), (2, '4-210', '芒果干', 'Mango', 27);
  `);
  if (pricing) db.exec(`
    CREATE TABLE guanyi_product_pricing (product_id INTEGER PRIMARY KEY, sku TEXT, discount_pct REAL,
      excel_retail REAL, excel_gz_price REAL, source TEXT);
    INSERT INTO guanyi_product_pricing VALUES (1, '1-10', 0.2, 38, 30.4, 'x'), (2, '4-210', 0.2, 27, 21.6, 'x');
  `);
  if (drift) db.exec(`
    CREATE TABLE guanyi_pickup_log (id INTEGER PRIMARY KEY, product_id INTEGER, action TEXT, resolution TEXT,
      inferred_pickup INTEGER, drift INTEGER, created_at TEXT);
  `);
  return db;
}
function order(db, { no, status = 'delivered', channel = 'gzgrocery', at, lines }) {
  const id = db.prepare(`INSERT INTO retail_orders (order_no, status, channel, placed_at, paid_at) VALUES (?,?,?,?,?)`)
    .run(no, status, channel, at, at).lastInsertRowid;
  for (const [pid, sku, qty, price] of lines) {
    db.prepare(`INSERT INTO retail_order_items (order_id, product_id, sku, qty, unit_price, line_total) VALUES (?,?,?,?,?,?)`)
      .run(id, pid, sku, qty, price, +(qty * price).toFixed(2));
  }
}
const byKey = (rows) => Object.fromEntries(rows.map((r) => [`${r.day}|${r.product_id}`, r]));

console.log('\n§429 · the gzgrocery bill');

it('a price change after the order does not move its bill', () => {
  const db = mkDb();
  order(db, { no: 'GZ-1', at: '2026-09-28 04:00:00', lines: [[1, '1-10', 4, 30.4]] });
  db.prepare(`UPDATE guanyi_product_pricing SET excel_gz_price = 99 WHERE product_id = 1`).run();
  const [r] = billingRows(db, { from: '2026-09-27', to: '2026-09-30', shift: SHIFT });
  assert.strictEqual(r.units, 4);
  assert.strictEqual(r.owed, 121.6);
});

it('an order at 07:30 Guangzhou on the 28th is billed on the 28th, not UTC\'s 27th', () => {
  const db = mkDb();
  order(db, { no: 'GZ-2', at: '2026-09-27 23:30:00', lines: [[2, '4-210', 2, 21.6]] });
  assert.deepStrictEqual(billingRows(db, { from: '2026-09-27', to: '2026-09-27', shift: SHIFT }), []);
  const [r] = billingRows(db, { from: '2026-09-28', to: '2026-09-28', shift: SHIFT });
  assert.strictEqual(r.day, '2026-09-28');
  assert.strictEqual(r.units, 2);
});

it('a cancelled gzgrocery order and another channel\'s order bill nothing', () => {
  const db = mkDb();
  order(db, { no: 'GZ-3', status: 'cancelled', at: '2026-09-28 04:00:00', lines: [[1, '1-10', 5, 30.4]] });
  order(db, { no: 'R1', channel: 'wechat', status: 'paid', at: '2026-09-28 04:00:00', lines: [[1, '1-10', 7, 38]] });
  assert.deepStrictEqual(billingRows(db, { from: '2026-09-01', to: '2026-09-30', shift: SHIFT }), []);
});

it('units and orders add up per day and product, with the order numbers they came from', () => {
  const db = mkDb();
  order(db, { no: 'GZ-4', at: '2026-09-28 02:00:00', lines: [[1, '1-10', 1, 30.4], [2, '4-210', 1, 21.6]] });
  order(db, { no: 'GZ-5', at: '2026-09-28 09:00:00', lines: [[1, '1-10', 3, 30.4]] });
  const k = byKey(billingRows(db, { from: '2026-09-28', to: '2026-09-28', shift: SHIFT }));
  assert.strictEqual(k['2026-09-28|1'].units, 4);
  assert.strictEqual(+k['2026-09-28|1'].owed.toFixed(2), 121.6);
  assert.deepStrictEqual(k['2026-09-28|1'].orders.split(',').sort(), ['GZ-4', 'GZ-5']);
  assert.strictEqual(k['2026-09-28|1'].sku, '1-10');
  assert.strictEqual(k['2026-09-28|2'].units, 1);
});

it('the dormant drift log still counts, on the shop\'s day, at today\'s gzgrocery price', () => {
  const db = mkDb();
  db.prepare(`INSERT INTO guanyi_pickup_log (product_id, action, inferred_pickup, created_at) VALUES (1, 'decremented', 2, '2026-06-30 20:00:00')`).run();
  db.prepare(`INSERT INTO guanyi_pickup_log (product_id, action, drift, created_at) VALUES (1, 'drift_up', 1, '2026-07-01 03:00:00')`).run();
  db.prepare(`INSERT INTO guanyi_pickup_log (product_id, action, inferred_pickup, created_at) VALUES (1, 'skipped', 9, '2026-07-01 03:00:00')`).run();
  const rows = billingRows(db, { from: '2026-07-01', to: '2026-07-01', shift: SHIFT });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].units, 1);           // 2 taken, 1 back; 'skipped' is not a sale
  assert.strictEqual(+rows[0].owed.toFixed(2), 30.4);
  assert.strictEqual(rows[0].orders, null);
});

it('a tenant with no pricing table and no drift log still reads', () => {
  const db = mkDb({ pricing: false, drift: false });
  order(db, { no: 'GZ-6', at: '2026-09-28 04:00:00', lines: [[1, '1-10', 1, 38]] });
  const [r] = billingRows(db, { from: '2026-09-28', to: '2026-09-28', shift: SHIFT });
  assert.strictEqual(r.owed, 38);
  assert.strictEqual(r.disc, null);
});

console.log('\n§429 · the Billing route');

/* Strip comments so "no longer reads the ledger" tests the code, not the prose
   explaining why. */
const code = ROUTE.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
const handler = code.slice(code.indexOf("'/api/retail-admin/guanyi/analytics'"));

it('the Billing panel reads through billingRows, not the stock ledger', () => {
  assert.ok(/billingRows\(db,/.test(handler), 'analytics handler does not call billingRows');
  assert.ok(!/retail_stock_ledger/.test(handler), 'analytics handler still reads retail_stock_ledger');
});

it('week buckets keep the numbering the panel has always shown (SQLite %Y-W%W)', () => {
  const src = ROUTE.slice(ROUTE.indexOf('function isoWeekBucket'));
  const fnSrc = src.slice(0, src.indexOf('\n}\n') + 2);
  const isoWeekBucket = new Function(fnSrc + '\nreturn isoWeekBucket;')();
  const db = new Database(':memory:');
  const q = db.prepare(`SELECT strftime('%Y-W%W', ?) AS w`);
  for (let t = Date.UTC(2025, 0, 1); t <= Date.UTC(2027, 0, 10); t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    assert.strictEqual(isoWeekBucket(d), q.get(d).w, d);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
