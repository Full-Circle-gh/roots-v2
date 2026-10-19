#!/usr/bin/env node
'use strict';

// §487 — a gzgrocery order line is a fact: it takes what it sold, gives back
// what it took, and a pending refund is not a cancel.
//
//   node scripts/test_gzgrocery_order_stock.js
//
// THE THREE BUGS THIS PINS, from the stock-deduction audit of 2026-10-19
// (docs/surveys/stock-deduction-audit-2026-10-19.md, finding 3):
//
//   1. THE CLAMP. Shelf 2, order of 5: the daemon wrote Math.max(0, 2 − 5) and
//      three units vanished from the record; the cancel then added back 5, and
//      the shelf said 5 for a product it had held 2 of. Now a delta, like
//      Meituan and Eleme since §84: the shelf goes to −3, the cancel brings it
//      back to 2.
//   2. 退款中 AS A VOID. A refund merely REQUESTED put the stock back and set
//      reversed=1; when the refund was refused and the order went back to
//      active, the flags said "already counted" and the units were never taken
//      again. A pending refund now does nothing; a final label reverses.
//   3. SILENT UNMATCHED LINES. An SKU-shaped line the catalogue did not know
//      was dropped without a word. It is now written to the order's log.
//
// RUN AGAINST THE REAL processOrder, required from the daemon (which no longer
// starts its poll when required), in live mode with the retail_orders mirror
// off, on throwaway rows it removes afterwards. The real adjustStock runs, so
// the ledger rows asserted here are the ones production writes.

process.env.GZGROCERY_ORDER_MODE = 'live';
process.env.GZGROCERY_MIRROR_ORDERS = 'off';
process.env.GZGROCERY_ORDER_WEBHOOK = '';

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const daemon = require(path.join(ROOT, 'scripts', 'gzgrocery-order-daemon.js'));
const db = tdb();

let failures = 0, passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}
function section(t) { console.log(`\n${t}`); }

const STORE = 9261;
const PROD  = 9262;
const SKU   = '9-9262';
const ORDERS = [926201, 926202, 926203, 926204];

function cleanup() {
  db.prepare('DELETE FROM retail_stock_ledger WHERE store_id = ?').run(STORE);
  db.prepare('DELETE FROM retail_store_stock WHERE store_id = ?').run(STORE);
  db.prepare('DELETE FROM store_products WHERE id = ?').run(PROD);
  db.prepare('DELETE FROM retail_stores WHERE id = ? OR code = ?').run(STORE, 'GZTEST-' + STORE);
  for (const id of ORDERS) {
    db.prepare('DELETE FROM gzgrocery_orders WHERE order_id = ?').run(id);
    db.prepare('DELETE FROM gzgrocery_order_log WHERE order_id = ?').run(id);
  }
}
function seed() {
  daemon.ensureTables();
  cleanup();
  db.prepare('INSERT INTO retail_stores (id,name_en,name_cn,code,is_active) VALUES (?,?,?,?,1)')
    .run(STORE, 'GzTest', '测试', 'GZTEST-' + STORE);
  db.prepare('INSERT INTO store_products (id,name_en,name_cn,sku,is_active) VALUES (?,?,?,?,1)')
    .run(PROD, 'Hummus', '鹰嘴豆泥', SKU);
  db.prepare('INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (?,?,?)').run(STORE, PROD, 2);
}
const shelf = () => db.prepare('SELECT physical_qty q FROM retail_store_stock WHERE store_id=? AND product_id=?').get(STORE, PROD).q;
const ledger = () => db.prepare('SELECT reason, delta FROM retail_stock_ledger WHERE store_id = ? ORDER BY id').all(STORE)
  .map((r) => `${r.reason}:${r.delta}`);
const state = (id) => db.prepare('SELECT decremented, reversed FROM gzgrocery_orders WHERE order_id = ?').get(id);
const logActions = (id) => db.prepare('SELECT action FROM gzgrocery_order_log WHERE order_id = ? ORDER BY id').all(id).map((r) => r.action);

const skuMap = new Map([[SKU.toUpperCase(), { productId: PROD, sku: SKU, name_en: 'Hummus', name_cn: '鹰嘴豆泥', canonical: true }]]);
const order = (id, status) => ({ orderId: id, orderNo: 'GZ' + id, status, total: 50, customer: 'x', dateAdded: '2026-10-19 10:00:00' });
const items = (qty, extra = []) => [{ product: 'Hummus', model: SKU, qty }, ...extra];

seed();
try {
  section('1. The clamp is gone: an order past the shelf writes the honest negative');
  daemon.processOrder(order(ORDERS[0], 'Paid'), items(5), skuMap, STORE, null);
  check('shelf 2, order of 5 → shelf −3, not 0', () => assert.strictEqual(shelf(), -3));
  check('the ledger carries the full −5', () => assert.deepStrictEqual(ledger(), ['gzgrocery_order:-5']));
  check('the oversell is in the order log', () => assert.ok(logActions(ORDERS[0]).includes('oversold')));
  daemon.processOrder(order(ORDERS[0], 'Cancelled'), items(5), skuMap, STORE, null);
  check('the cancel gives back exactly 5 → shelf 2 again', () => assert.strictEqual(shelf(), 2));
  check('ledger: −5 then +5', () => assert.deepStrictEqual(ledger(), ['gzgrocery_order:-5', 'gzgrocery_order_reverse:5']));
  daemon.processOrder(order(ORDERS[0], 'Cancelled'), items(5), skuMap, STORE, null);
  check('a second poll of the cancel moves nothing', () => assert.strictEqual(shelf(), 2));

  section('2. A pending refund is not a void');
  daemon.processOrder(order(ORDERS[1], '已支付'), items(1), skuMap, STORE, null);
  check('paid → taken', () => assert.strictEqual(shelf(), 1));
  daemon.processOrder(order(ORDERS[1], '退款中'), items(1), skuMap, STORE, null);
  check('退款中 → nothing moves, nothing is marked reversed', () => {
    assert.strictEqual(shelf(), 1);
    assert.deepStrictEqual(state(ORDERS[1]), { decremented: 1, reversed: 0 });
  });
  daemon.processOrder(order(ORDERS[1], '已支付'), items(1), skuMap, STORE, null);
  check('refund refused, order active again → still taken once', () => assert.strictEqual(shelf(), 1));
  daemon.processOrder(order(ORDERS[1], '已退款'), items(1), skuMap, STORE, null);
  check('已退款 (final) → given back', () => {
    assert.strictEqual(shelf(), 2);
    assert.deepStrictEqual(state(ORDERS[1]), { decremented: 1, reversed: 1 });
  });

  section('3. An order that comes back to life after a void is taken again, once');
  daemon.processOrder(order(ORDERS[2], 'Paid'), items(1), skuMap, STORE, null);
  daemon.processOrder(order(ORDERS[2], 'Refunded'), items(1), skuMap, STORE, null);
  check('taken then given back', () => assert.strictEqual(shelf(), 2));
  daemon.processOrder(order(ORDERS[2], 'Paid'), items(1), skuMap, STORE, null);
  check('active again → taken again', () => {
    assert.strictEqual(shelf(), 1);
    assert.deepStrictEqual(state(ORDERS[2]), { decremented: 1, reversed: 0 });
  });
  daemon.processOrder(order(ORDERS[2], 'Paid'), items(1), skuMap, STORE, null);
  check('and not a third time on the next poll', () => assert.strictEqual(shelf(), 1));
  daemon.processOrder(order(ORDERS[2], 'Cancelled'), items(1), skuMap, STORE, null);
  check('a later cancel gives it back once more', () => assert.strictEqual(shelf(), 2));

  section('4. An SKU-shaped line the catalogue does not know is logged, not dropped in silence');
  const r = daemon.processOrder(order(ORDERS[3], 'Paid'), items(1, [{ product: 'Mystery', model: '9-9999', qty: 2 }]), skuMap, STORE, null);
  check('the known line is taken', () => { assert.strictEqual(r.result, 'decremented'); assert.strictEqual(shelf(), 1); });
  check('the unknown line is in the order log', () => assert.ok(logActions(ORDERS[3]).includes('unmatched')));
  check('matchOurItems names it', () => {
    const m = daemon.matchOurItems(items(1, [{ product: 'Mystery', model: '9-9999', qty: 2 }]), skuMap);
    assert.strictEqual(m.length, 1);
    assert.deepStrictEqual(m.unmatched.map((u) => u.sku), ['9-9999']);
  });
  check('退款中 stays out of the void list', () => assert.ok(!daemon.VOID.has('退款中')));
} finally {
  cleanup();
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
