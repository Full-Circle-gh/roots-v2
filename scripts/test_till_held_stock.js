#!/usr/bin/env node
/**
 * §461 — a held till bill takes its shelf lines while it is held.
 *
 *   node scripts/test_till_held_stock.js
 *
 * Ash, 2026-10-12: "customer at the till might eat and pay later. that's why
 * till orders should immediately deduct from stock." §457 keeps a held bill on
 * the tablet; the tablet now tells the server what each bill holds and the
 * server moves the shelf by the difference (inventory.setTillHoldStock). Mark
 * paid gives the held units back the instant before the sale takes them.
 *
 * What this locks down, against the real database.js tables:
 *   • holding takes the bottles; sending the same bill again moves nothing;
 *   • adding to and taking from a held bill moves the shelf by the difference;
 *   • emptying a bill gives everything back, and the trail is in the ledger;
 *   • a hold never takes a shelf below zero, and returns exactly what it took;
 *   • a product with no shelf row (made-here, §43) is not taken;
 *   • paying a held bill (return, then the counter sale's own commit) leaves
 *     the shelf where an unheld sale would, with no §137 miscount row;
 *   • the order route returns the hold AFTER the order exists and BEFORE
 *     markOrderPaid, and the till's stock call lives under /orders.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const inventory = require(path.join(ROOT, 'lib', 'inventory.js'));
const h = tdb();

const STORE = 9846, P_BOTTLE = 9946, P_OAT = 9947, P_MADE = 9948;
const ORDERS = [];
let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}

function cleanup() {
  h.prepare('DELETE FROM retail_stock_ledger WHERE store_id = ?').run(STORE);
  if (ORDERS.length) {
    const q = ORDERS.map(() => '?').join(',');
    h.prepare(`DELETE FROM retail_orders WHERE id IN (${q})`).run(...ORDERS);
  }
  h.prepare('DELETE FROM retail_store_stock WHERE store_id = ?').run(STORE);
  h.prepare('DELETE FROM store_products WHERE id IN (?,?,?)').run(P_BOTTLE, P_OAT, P_MADE);
  h.prepare('DELETE FROM retail_stores WHERE id = ?').run(STORE);
}
const shelf = (pid) => h.prepare('SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?')
  .get(STORE, pid).physical_qty;
const setShelf = (pid, n) => h.prepare('UPDATE retail_store_stock SET physical_qty = ? WHERE store_id = ? AND product_id = ?')
  .run(n, STORE, pid);
const ledger = (bill) => h.prepare(
  "SELECT product_id, delta, reason FROM retail_stock_ledger WHERE store_id = ? AND ref_table = 'till_held_bill' AND note = ? ORDER BY id"
).all(STORE, bill);

cleanup();
h.prepare(`INSERT INTO retail_stores (id, code, name_en, is_active, sort_order)
           VALUES (?, '__test_heldstock', 'Held stock fixture', 1, 93)`).run(STORE);
const prod = h.prepare(`INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_active, is_published)
                        VALUES (?, ?, ?, ?, 10, 1, 1)`);
prod.run(P_BOTTLE, 'Held fixture kombucha', '测试康普茶', '__H-9946');
prod.run(P_OAT, 'Held fixture oat milk', '测试燕麦奶', '__H-9947');
prod.run(P_MADE, 'Held fixture toast', '测试吐司', '__H-9948');
const row = h.prepare('INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer) VALUES (?,?,?,0)');
row.run(STORE, P_BOTTLE, 5);
row.run(STORE, P_OAT, 3);
// P_MADE gets no shelf row: §43, a made-here item is not counted.

try {
  console.log('\nHolding, changing and emptying a bill');
  check('holding takes the bottles off the shelf', () => {
    const r = inventory.setTillHoldStock(STORE, 'hbill1', [{ product_id: P_BOTTLE, qty: 2 }, { product_id: P_OAT, qty: 1 }]);
    assert.strictEqual(shelf(P_BOTTLE), 3);
    assert.strictEqual(shelf(P_OAT), 2);
    assert.deepStrictEqual(r.taken, { [P_BOTTLE]: 2, [P_OAT]: 1 });
  });
  check('sending the same bill again moves nothing', () => {
    const r = inventory.setTillHoldStock(STORE, 'hbill1', [{ product_id: P_BOTTLE, qty: 2 }, { product_id: P_OAT, qty: 1 }]);
    assert.strictEqual(r.moved, 0, 'a resend took the bottles a second time');
    assert.strictEqual(shelf(P_BOTTLE), 3);
  });
  check('adding a third bottle takes one more, and only one', () => {
    inventory.setTillHoldStock(STORE, 'hbill1', [{ product_id: P_BOTTLE, qty: 3 }, { product_id: P_OAT, qty: 1 }]);
    assert.strictEqual(shelf(P_BOTTLE), 2);
    assert.strictEqual(shelf(P_OAT), 2);
  });
  check('taking the oat milk off the bill puts it back', () => {
    const r = inventory.setTillHoldStock(STORE, 'hbill1', [{ product_id: P_BOTTLE, qty: 3 }]);
    assert.strictEqual(shelf(P_OAT), 3);
    assert.deepStrictEqual(r.taken, { [P_BOTTLE]: 3 });
  });
  check('a second bill is its own: it does not see or move the first one\'s', () => {
    inventory.setTillHoldStock(STORE, 'hbill2', [{ product_id: P_BOTTLE, qty: 1 }]);
    assert.strictEqual(shelf(P_BOTTLE), 1);
    assert.strictEqual(inventory.tillHoldTaken(STORE, 'hbill1').get(P_BOTTLE), 3);
    assert.strictEqual(inventory.tillHoldTaken(STORE, 'hbill2').get(P_BOTTLE), 1);
  });
  check('emptying a bill gives everything back, and the ledger says so', () => {
    inventory.setTillHoldStock(STORE, 'hbill1', []);
    inventory.setTillHoldStock(STORE, 'hbill2', []);
    assert.strictEqual(shelf(P_BOTTLE), 5);
    assert.strictEqual(shelf(P_OAT), 3);
    assert.strictEqual(inventory.tillHoldTaken(STORE, 'hbill1').size, 0);
    const rs = ledger('hbill1').map((r) => r.reason);
    assert.ok(rs.includes('till_hold') && rs.includes('till_hold_return'),
      'the moves are not in the ledger under their own reasons: ' + rs.join(','));
  });

  console.log('\nWhat a hold will not do');
  check('a hold never takes a shelf below zero, and returns exactly what it took', () => {
    setShelf(P_BOTTLE, 1);
    const r = inventory.setTillHoldStock(STORE, 'hbill3', [{ product_id: P_BOTTLE, qty: 3 }]);
    assert.strictEqual(shelf(P_BOTTLE), 0, 'the hold drove the shelf negative');
    assert.deepStrictEqual(r.taken, { [P_BOTTLE]: 1 });
    inventory.setTillHoldStock(STORE, 'hbill3', []);
    assert.strictEqual(shelf(P_BOTTLE), 1, 'the return gave back more, or less, than was taken');
    setShelf(P_BOTTLE, 5);
  });
  check('a made-here item with no shelf row is not taken (§43)', () => {
    const r = inventory.setTillHoldStock(STORE, 'hbill4', [{ product_id: P_MADE, qty: 2 }]);
    assert.strictEqual(r.moved, 0);
    assert.strictEqual(ledger('hbill4').length, 0, 'a ledger row was written for a shelf that does not exist');
  });

  console.log('\nPaying a held bill');
  function counterSale(bill, lines) {
    const id = 98460 + ORDERS.length;
    ORDERS.push(id);
    h.prepare(`INSERT INTO retail_orders (id, order_no, status, fulfillment_type, store_id, channel, total, placed_at)
               VALUES (?, ?, 'paid', 'counter', ?, 'shop', 10, CURRENT_TIMESTAMP)`).run(id, '__HELD-' + id, STORE);
    // What the order route does, in its order: give the hold back, then the
    // sale's own commit (markOrderPaid → prepareCommitUnreservedOrder).
    inventory.setTillHoldStock(STORE, bill, []);
    inventory.commitUnreservedOrder(id, lines);
    return id;
  }
  check('a held bill paid leaves the shelf where an unheld sale would', () => {
    inventory.setTillHoldStock(STORE, 'hbill5', [{ product_id: P_BOTTLE, qty: 2 }]);
    assert.strictEqual(shelf(P_BOTTLE), 3);
    counterSale('hbill5', [{ product_id: P_BOTTLE, qty: 2 }]);
    assert.strictEqual(shelf(P_BOTTLE), 3, 'paying took the bottles a second time');
    assert.strictEqual(inventory.tillHoldTaken(STORE, 'hbill5').size, 0, 'the paid bill still holds stock');
  });
  check('...and when the hold had the last bottle, no §137 miscount is written', () => {
    setShelf(P_BOTTLE, 1);
    inventory.setTillHoldStock(STORE, 'hbill6', [{ product_id: P_BOTTLE, qty: 1 }]);
    assert.strictEqual(shelf(P_BOTTLE), 0);
    const id = counterSale('hbill6', [{ product_id: P_BOTTLE, qty: 1 }]);
    assert.strictEqual(shelf(P_BOTTLE), 0);
    const miscount = h.prepare(
      "SELECT 1 FROM retail_stock_ledger WHERE ref_table = 'retail_orders' AND ref_id = ? AND reason = 'counter_miscount'"
    ).get(id);
    assert.ok(!miscount, 'the sale met a shelf the hold had emptied and "corrected" it');
  });

  console.log('\nThe endpoint the till calls, run for real');
  // The real handler, out of the real router: the layers before it are
  // requireRetailAdmin and express.json, which a fake request stands in for.
  const retail = require(path.join(ROOT, 'routes', 'retail.js'));
  const layer = retail.stack.find((l) => l.route && l.route.path === '/api/retail-admin/orders/till-held/:billId'
                                         && l.route.methods.put);
  const handler = layer && layer.route.stack[layer.route.stack.length - 1].handle;
  const call = (billId, body) => {
    let out = null;
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; },
                  json(j) { out = { status: this.statusCode, json: j }; return this; } };
    handler({ params: { billId }, body, user: { id: 1, username: 'tester' } }, res);
    return out;
  };
  setShelf(P_BOTTLE, 5);   // the section above ends on an empty shelf
  check('the route is there', () => assert.ok(handler, 'PUT /orders/till-held/:billId is not registered'));
  check('a held bill sent by the till takes its bottles and says what it holds', () => {
    const r = call('hroute1', { store_id: STORE, lines: [{ product_id: P_BOTTLE, qty: 2 }] });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.deepStrictEqual(r.json.data.taken, { [P_BOTTLE]: 2 });
    assert.strictEqual(shelf(P_BOTTLE), 3);
  });
  check('...and an empty bill gives them back', () => {
    const r = call('hroute1', { store_id: STORE, lines: [] });
    assert.deepStrictEqual(r.json.data.taken, {});
    assert.strictEqual(shelf(P_BOTTLE), 5);
  });
  check('a bad bill id, an unknown shop and a missing list are refused and move nothing', () => {
    assert.strictEqual(call('nothex!', { store_id: STORE, lines: [] }).status, 400);
    assert.strictEqual(call('hroute2', { store_id: 1234567, lines: [{ product_id: P_BOTTLE, qty: 1 }] }).status, 404);
    assert.strictEqual(call('hroute2', { store_id: STORE }).status, 400);
    assert.strictEqual(shelf(P_BOTTLE), 5);
  });

  console.log('\nThe wiring in the route and the till');
  const RETAIL = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
  check('the till\'s stock call lives under /orders (orders:edit, which a cashier holds)', () => {
    assert.ok(RETAIL.includes("router.put('/api/retail-admin/orders/till-held/:billId'"));
  });
  check('the order route returns the hold after the order exists and before markOrderPaid', () => {
    const create = RETAIL.indexOf("router.post('/api/retail-admin/orders', requireRetailAdmin");
    const ret = RETAIL.indexOf('inventory.setTillHoldStock(storeId, heldBillId, []', create);
    const insert = RETAIL.indexOf('INSERT INTO retail_orders', create);
    const paid = RETAIL.indexOf('try { markOrderPaid(orderId); }', create);
    assert.ok(create > 0 && insert > create && ret > insert && paid > ret,
      `out of order: insert ${insert}, return ${ret}, markOrderPaid ${paid}`);
  });
  check('the add-on sold-out gate counts the bill\'s own held units as there', () => {
    assert.ok(/return !a \|\| a\.available \+ own <= 0;/.test(RETAIL));
  });
} finally {
  cleanup();
}

console.log(failures ? `\n${failures} check(s) failed\n` : '\nAll checks passed\n');
process.exit(failures ? 1 : 0);
