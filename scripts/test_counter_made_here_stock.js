#!/usr/bin/env node
/**
 * §491 — a made-here item sold at the counter takes nothing off the shelf,
 * even when a stray shelf row exists.
 *
 *   node scripts/test_counter_made_here_stock.js
 *
 * Ash, 2026-10-20, on a 09:10 alert for 越秀 order TC001423 (美式咖啡 剩余 -2):
 * "how can it go below zero it's made here . on the spot". §43 says selling a
 * made-here item decrements nothing. Mark paid (commitUnreservedOrder) and a
 * held till bill (setTillHoldStock) kept that rule only by assuming the item
 * had no shelf row; once it had one, every sale took a unit and §137 raised
 * the "recount the shelf" alert.
 *
 * What this locks down, against the real database.js tables:
 *   • a counter sale takes nothing for a made-here listing, even with a row;
 *   • its stocked extra (oat milk) and a stocked sibling line still take;
 *   • a sale of only made-here lines writes no ledger row and says why;
 *   • a made-here item switched off for the day is still made here;
 *   • a held bill does not take a made-here item, and gives one back if it had;
 *   • the rule is per location, and only for counter sales.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const inventory = require(path.join(ROOT, 'lib', 'inventory.js'));
const h = tdb();

const STORE = 9591, STORE_B = 9592, SHOP = 9491;
const P_AMERICANO = 9591, P_OAT = 9592, P_BOTTLE = 9593, P_LATTE = 9594;
const ORDERS = [];
let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}

function cleanup() {
  h.prepare('DELETE FROM retail_stock_ledger WHERE store_id IN (?,?)').run(STORE, STORE_B);
  if (ORDERS.length) {
    const q = ORDERS.map(() => '?').join(',');
    h.prepare(`DELETE FROM retail_orders WHERE id IN (${q})`).run(...ORDERS);
  }
  h.prepare('DELETE FROM retail_store_stock WHERE store_id IN (?,?)').run(STORE, STORE_B);
  h.prepare('DELETE FROM shop_listings WHERE shop_id = ?').run(SHOP);
  h.prepare('DELETE FROM shops WHERE id = ?').run(SHOP);
  h.prepare('DELETE FROM store_products WHERE id IN (?,?,?,?)').run(P_AMERICANO, P_OAT, P_BOTTLE, P_LATTE);
  h.prepare('DELETE FROM retail_stores WHERE id IN (?,?)').run(STORE, STORE_B);
}
const shelf = (pid, store = STORE) => h.prepare(
  'SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?'
).get(store, pid).physical_qty;
const setShelf = (pid, n, store = STORE) => h.prepare(
  'UPDATE retail_store_stock SET physical_qty = ? WHERE store_id = ? AND product_id = ?'
).run(n, store, pid);
const orderRows = (id) => h.prepare(
  "SELECT product_id, delta, reason FROM retail_stock_ledger WHERE ref_table = 'retail_orders' AND ref_id = ? ORDER BY id"
).all(id);
function order({ store = STORE, ft = 'counter', channel = 'shop' } = {}) {
  const id = 94910 + ORDERS.length;
  ORDERS.push(id);
  h.prepare(`INSERT INTO retail_orders (id, order_no, status, fulfillment_type, store_id, channel, total, placed_at)
             VALUES (?, ?, 'paid', ?, ?, ?, 10, CURRENT_TIMESTAMP)`).run(id, '__MADEHERE-' + id, ft, store, channel);
  return id;
}

cleanup();
const store = h.prepare(`INSERT INTO retail_stores (id, code, name_en, is_active, sort_order)
                         VALUES (?, ?, ?, 1, ?)`);
store.run(STORE, '__test_madehere_a', 'Made-here fixture A', 94);
store.run(STORE_B, '__test_madehere_b', 'Made-here fixture B', 95);
const prod = h.prepare(`INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_active, is_published)
                        VALUES (?, ?, ?, ?, 10, 1, 1)`);
prod.run(P_AMERICANO, 'Made-here fixture americano', '测试美式', '__MH-9591');
prod.run(P_OAT, 'Made-here fixture oat milk', '测试燕麦奶', '__MH-9592');
prod.run(P_BOTTLE, 'Made-here fixture kombucha', '测试康普茶', '__MH-9593');
prod.run(P_LATTE, 'Made-here fixture latte', '测试拿铁', '__MH-9594');
h.prepare(`INSERT INTO shops (id, location_id, public_code, is_active) VALUES (?, ?, '__MHFX01', 1)`).run(SHOP, STORE);
const list = h.prepare(`INSERT INTO shop_listings (shop_id, store_product_id, price, fulfilment_mode, is_available)
                        VALUES (?, ?, 20, ?, ?)`);
list.run(SHOP, P_AMERICANO, 'made_here', 1);
list.run(SHOP, P_LATTE, 'made_here', 0);     // switched off for the day
list.run(SHOP, P_BOTTLE, 'stocked', 1);
const row = h.prepare('INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer) VALUES (?,?,?,0)');
// The stray rows the alert came from: a made-here item that has a shelf row.
row.run(STORE, P_AMERICANO, 0);
row.run(STORE, P_LATTE, 4);
row.run(STORE, P_OAT, 5);
row.run(STORE, P_BOTTLE, 3);
// Location B has no shop, so nothing is made here: its row is a real shelf.
row.run(STORE_B, P_AMERICANO, 6);

try {
  console.log('\nMark paid on a counter sale');
  check('two Americanos with oat milk and a kombucha: only the stocked lines come off', () => {
    const id = order();
    const r = inventory.commitUnreservedOrder(id, [
      { product_id: P_AMERICANO, qty: 2 }, { product_id: P_OAT, qty: 2 }, { product_id: P_BOTTLE, qty: 1 },
    ]);
    assert.strictEqual(r.committed, 2, JSON.stringify(r));
    assert.strictEqual(shelf(P_AMERICANO), 0, 'the Americano was taken off a shelf it does not have');
    assert.strictEqual(shelf(P_OAT), 3, 'the oat milk extra did not come off its own shelf');
    assert.strictEqual(shelf(P_BOTTLE), 2);
    const rows = orderRows(id);
    assert.ok(!rows.some((x) => x.product_id === P_AMERICANO), 'a ledger row was written for the Americano');
    assert.ok(!rows.some((x) => x.reason === 'counter_miscount'), 'a §137 miscount was written');
  });
  check('a sale of only made-here lines writes nothing and says why', () => {
    const id = order();
    const r = inventory.commitUnreservedOrder(id, [{ product_id: P_AMERICANO, qty: 1 }]);
    assert.strictEqual(r.skipped, 'made_here', JSON.stringify(r));
    assert.strictEqual(orderRows(id).length, 0);
  });
  check('a made-here item switched off for the day is still made here', () => {
    const id = order();
    inventory.commitUnreservedOrder(id, [{ product_id: P_LATTE, qty: 1 }]);
    assert.strictEqual(shelf(P_LATTE), 4);
  });

  console.log('\nA held till bill');
  check('holding a bill does not take a made-here item, even from a row with units on it', () => {
    setShelf(P_AMERICANO, 3);
    const r = inventory.setTillHoldStock(STORE, 'hmh1', [{ product_id: P_AMERICANO, qty: 2 }, { product_id: P_OAT, qty: 1 }]);
    assert.strictEqual(shelf(P_AMERICANO), 3, 'the hold took the Americano');
    assert.strictEqual(shelf(P_OAT), 2);
    assert.deepStrictEqual(r.taken, { [P_OAT]: 1 });
    inventory.setTillHoldStock(STORE, 'hmh1', []);
    assert.strictEqual(shelf(P_OAT), 3);
  });
  check('a bill that took a made-here unit before this fix gives it back on its next send', () => {
    // What the old code wrote: one Americano held off a shelf of 3.
    setShelf(P_AMERICANO, 2);
    h.prepare(`INSERT INTO retail_stock_ledger
                 (store_id, product_id, delta, reason, ref_table, ref_id, balance_after, channel, note)
               VALUES (?, ?, -1, 'till_hold', 'till_held_bill', NULL, 2, 'shop', 'hmh2')`).run(STORE, P_AMERICANO);
    const r = inventory.setTillHoldStock(STORE, 'hmh2', [{ product_id: P_AMERICANO, qty: 1 }]);
    assert.strictEqual(shelf(P_AMERICANO), 3, 'the unit the old hold took was not given back');
    assert.deepStrictEqual(r.taken, {});
    setShelf(P_AMERICANO, 0);
  });

  console.log('\nWhere the rule stops');
  check('at a location with no shop, the same product is a real shelf and comes off it', () => {
    const id = order({ store: STORE_B });
    inventory.commitUnreservedOrder(id, [{ product_id: P_AMERICANO, qty: 2 }]);
    assert.strictEqual(shelf(P_AMERICANO, STORE_B), 4);
  });
  check('a non-counter order from the same location still takes, as before', () => {
    setShelf(P_AMERICANO, 5);
    const id = order({ ft: 'delivery', channel: 'wechat' });
    inventory.commitUnreservedOrder(id, [{ product_id: P_AMERICANO, qty: 1 }]);
    assert.strictEqual(shelf(P_AMERICANO), 4);
  });
} finally {
  cleanup();
}

console.log(failures ? `\n${failures} check(s) failed\n` : '\nAll checks passed\n');
process.exit(failures ? 1 : 0);
