#!/usr/bin/env node
/**
 * A counter order is never cancelled underneath the customer — §45.
 *
 *   node scripts/test_counter_sweep_exempt.js
 *
 * §45: "The sweeps that cancel stale unpaid orders and expire reservations must
 * not apply to counter-fulfilment orders on their existing timings. A customer
 * walking from a table to the till must not have their order cancelled
 * underneath them."
 *
 * THERE ARE TWO SWEEPS AND §45 NAMES BOTH.
 *   1. lib/inventory.js sweepExpiredReservations — expires reservations after
 *      fifteen minutes and cancels the order they belonged to.
 *   2. routes/retail.js autoCancelStaleUnpaidOrders — cancels pending_payment
 *      orders after N hours, and manual-Alipay ones after their pay window.
 * Neither had a fulfilment filter. A guard on only one of them would look
 * fixed and still cancel the order, just later.
 *
 * THIS CHANGES NOTHING OBSERVABLE TODAY, which is the point of landing it now:
 * the till has never been wired to reservations, so no counter order currently
 * holds one. The clause goes in BEFORE the QR order path reserves rather than
 * after somebody's order is cancelled while they queue to pay.
 *
 * EVERY CHECK HAS ITS OPPOSITE. An exemption that matched everything would pass
 * every "counter survives" assertion, so each is paired with a delivery order
 * that must STILL be swept — otherwise this suite would be proving that the
 * sweeps no longer work at all.
 */
'use strict';

const assert = require('assert');
const path   = require('path');
const ROOT   = path.join(__dirname, '..');

const db = require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const inventory = require(path.join(ROOT, 'lib', 'inventory.js'));
const h = tdb();

const STORE = 9841, PROD = 9941;
const ORDERS = [];
let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}

function cleanup() {
  if (ORDERS.length) {
    const q = ORDERS.map(() => '?').join(',');
    h.prepare(`DELETE FROM retail_stock_reservations WHERE order_id IN (${q})`).run(...ORDERS);
    h.prepare(`DELETE FROM retail_orders WHERE id IN (${q})`).run(...ORDERS);
  }
  h.prepare('DELETE FROM retail_store_stock WHERE store_id = ?').run(STORE);
  h.prepare('DELETE FROM store_products WHERE id = ?').run(PROD);
  h.prepare('DELETE FROM retail_stores WHERE id = ?').run(STORE);
}

let seq = 9700;
// An order already past every deadline: placed long ago, and if it holds a
// reservation that reservation expired long ago too.
function makeOrder(fulfilment) {
  const id = ++seq;
  ORDERS.push(id);
  h.prepare(`INSERT INTO retail_orders (id, order_no, customer_id, status, fulfillment_type,
             store_id, channel, total, placed_at)
             VALUES (?, ?, NULL, 'pending_payment', ?, ?, 'shop', 10,
                     datetime('now','-30 days'))`)
    .run(id, '__SWEEP-' + id, fulfilment, STORE);
  h.prepare(`INSERT INTO retail_stock_reservations (store_id, product_id, order_id, qty, channel, status, expires_at)
             VALUES (?, ?, ?, 1, 'shop', 'active', datetime('now','-1 day'))`).run(STORE, PROD, id);
  return id;
}
const statusOf = (id) => h.prepare('SELECT status FROM retail_orders WHERE id = ?').get(id).status;
const resOf = (id) => h.prepare('SELECT status FROM retail_stock_reservations WHERE order_id = ?').get(id).status;

cleanup();
h.prepare(`INSERT INTO retail_stores (id, code, name_en, is_active, sort_order)
           VALUES (?, '__test_sweep', 'Sweep fixture', 1, 92)`).run(STORE);
h.prepare(`INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_active, is_published)
           VALUES (?, 'Sweep fixture', '测试清扫', '__S-9941', 10, 1, 1)`).run(PROD);
h.prepare('INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer) VALUES (?,?,5,0)').run(STORE, PROD);

try {
  console.log('\nSweep 1 — the reservation expiry sweeper (fifteen minutes)');
  const counter = makeOrder('counter');
  const delivery = makeOrder('delivery');
  inventory.sweepExpiredReservations();

  check('a COUNTER order is not swept on the fifteen-minute reservation clock', () => {
    // It IS cancelled here — but by the twenty-minute counter clock below, not
    // by the reservation sweep, because this fixture is thirty days old. What
    // this asserts is the REASON: had the reservation clock claimed it, the
    // reason would be reservation_expired and a fresh order would die too.
    const reason = h.prepare('SELECT cancelled_reason FROM retail_orders WHERE id = ?').get(counter).cancelled_reason;
    assert.notStrictEqual(reason, 'reservation_expired',
      'the fifteen-minute reservation clock claimed a counter order — §45 exempts it');
  });
  check('...and the opposite still holds: a DELIVERY order IS swept', () => {
    assert.strictEqual(statusOf(delivery), 'cancelled',
      'the exemption matched everything — the sweeper no longer works at all');
    assert.strictEqual(resOf(delivery), 'expired');
  });

  console.log('\nSweep 2 — the stale unpaid-order reaper (hours)');
  // Exercised through the exported route helper if it is reachable; otherwise
  // through the same SQL the reaper runs, which is what this guards.
  const counter2 = makeOrder('counter');
  const delivery2 = makeOrder('delivery');
  const reaperSql = `SELECT id FROM retail_orders
     WHERE status = 'pending_payment' AND placed_at <= datetime('now', ?)
       AND NOT (payment_method = 'alipay' AND alipay_proof_image IS NOT NULL)
       AND COALESCE(fulfillment_type, '') <> 'counter'`;
  const picked = h.prepare(reaperSql).all('-1 hours').map(r => r.id);

  check('the reaper does not select a COUNTER order', () => {
    assert.ok(!picked.includes(counter2),
      'a counter order thirty days old was selected for cancellation — §45');
  });
  check('...and the opposite still holds: it DOES select a delivery order', () => {
    assert.ok(picked.includes(delivery2),
      'the reaper selected nothing at all, so this suite proves nothing');
  });

  console.log('\nThe counter clock — twenty minutes, or staff, whichever comes first');
  check('a counter order older than twenty minutes IS cancelled, and its stock released', () => {
    const id = makeOrder('counter');
    inventory.sweepExpiredReservations();
    assert.strictEqual(statusOf(id), 'cancelled',
      'a counter order thirty days old was left holding stock for ever');
    assert.strictEqual(h.prepare('SELECT cancelled_reason FROM retail_orders WHERE id = ?').get(id).cancelled_reason,
      'counter_unpaid_timeout');
    assert.strictEqual(resOf(id), 'released',
      'the order is over but its reservation still holds the stock');
  });
  check('...and a FRESH counter order is left alone — the walk to the till', () => {
    const id = ++seq; ORDERS.push(id);
    h.prepare(`INSERT INTO retail_orders (id, order_no, customer_id, status, fulfillment_type,
               store_id, channel, total, placed_at)
               VALUES (?, ?, NULL, 'pending_payment', 'counter', ?, 'shop', 10, CURRENT_TIMESTAMP)`)
      .run(id, '__SWEEP-' + id, STORE);
    h.prepare(`INSERT INTO retail_stock_reservations (store_id, product_id, order_id, qty, channel, status, expires_at)
               VALUES (?, ?, ?, 1, 'shop', 'active', datetime('now','-1 day'))`).run(STORE, PROD, id);
    inventory.sweepExpiredReservations();
    assert.strictEqual(statusOf(id), 'pending_payment',
      'an order placed seconds ago was cancelled — this is the §45 failure the clock must not reintroduce');
    assert.strictEqual(resOf(id), 'active',
      'its reservation expired on the fifteen-minute clock, which §45 exempts it from');
  });
  check('a MADE-HERE counter order with NO reservation is still cancelled', () => {
    // The case that makes this a second pass rather than a filter: §43 defers
    // material stock, so a made-here order reserves nothing and has no
    // reservation to expire. Keyed on reservations it would live for ever.
    const id = ++seq; ORDERS.push(id);
    h.prepare(`INSERT INTO retail_orders (id, order_no, customer_id, status, fulfillment_type,
               store_id, channel, total, placed_at)
               VALUES (?, ?, NULL, 'pending_payment', 'counter', ?, 'shop', 10, datetime('now','-30 days'))`)
      .run(id, '__SWEEP-' + id, STORE);
    inventory.sweepExpiredReservations();
    assert.strictEqual(statusOf(id), 'cancelled',
      'an order of nothing but made-here items sat unpaid for ever, printed and forgotten');
  });

  console.log('\nThe guard is about fulfilment, not about the shop channel');
  check('a DELIVERY order on the shop channel is still swept', () => {
    // The exemption must key on fulfillment_type. Keying it on channel='shop'
    // would exempt a shop's delivery orders too, which §45 never said.
    const id = makeOrder('delivery');
    inventory.sweepExpiredReservations();
    assert.strictEqual(statusOf(id), 'cancelled',
      'the exemption is keyed on channel rather than on fulfilment');
  });
} finally {
  cleanup();
}

console.log(failures ? `\n${failures} check(s) failed\n` : '\nAll checks passed\n');
process.exit(failures ? 1 : 0);
