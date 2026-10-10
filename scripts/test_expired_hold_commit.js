#!/usr/bin/env node
/**
 * A hold that ran out does not stop the shelf being counted down.
 *
 *   node scripts/test_expired_hold_commit.js
 *
 * THE BUG, seen live 2026-10-09 on TC001023: an out-of-Guangzhou order with two
 * 'strict' kombuchas (Lemongrass, Mix Berries) and one sold-out line. The
 * kombuchas reserved at checkout; the sold-out line parked the order. On payment
 * markOrderPaid sends a parked order to 'awaiting_restock' and does NOT commit
 * its holds, so fifteen minutes later the sweeper expired them. The drawer
 * showed both as "expired" under "Stock reservations — needs attention".
 *
 * Then "Restocked · start preparing" reached commitUnreservedOrder, whose
 * per-product guard skipped any product with a reservation row of ANY status —
 * so the expired holds read as "already taken off the shelf" and nothing was
 * decremented. The bottles went in the box; the count still had them.
 *
 * LOCKED DOWN HERE:
 *   1. the sweeper expires the holds on a parked, paid order and does NOT
 *      cancel the order
 *   2. moving that order on then takes the units off the shelf, once
 *   3. a second commit does not take them again
 *   4. a 'released' hold is treated the same as an expired one
 *   5. a 'committed' hold still skips — no double count on the normal path
 *   6. an 'active' hold still skips — unchanged
 *   7. isStockPending reads an expired-only order as still owing the shelf
 *
 * Runs against a REAL sqlite database (data/roots.db, created by database.js on
 * require and gitignored). Every row it writes is namespaced to ids in the
 * 992000+ range and deleted on the way out, so it is re-runnable.
 */
'use strict';

const assert = require('assert');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const inventory = require(path.join(ROOT, 'lib', 'inventory.js'));

const db = tdb();
let pass = 0;
const ok = (label, actual, expected) => {
  assert.deepStrictEqual(actual, expected, `${label}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`);
  console.log('  ✓ ' + label);
  pass++;
};

const STORE = 992001;
const LEMON = 992002;
const BERRY = 992003;
const SHORT = 992004;   // the sold-out line the order is parked on
const BASE  = 992100;
const ids   = [];

function cleanup() {
  try {
    db.prepare('DELETE FROM retail_stock_ledger WHERE store_id = ?').run(STORE);
    db.prepare('DELETE FROM retail_stock_reservations WHERE store_id = ?').run(STORE);
    for (const id of ids) {
      db.prepare('DELETE FROM retail_payments WHERE order_id = ?').run(id);
      db.prepare('DELETE FROM retail_orders WHERE id = ?').run(id);
    }
    db.prepare('DELETE FROM retail_store_stock WHERE store_id = ?').run(STORE);
    for (const p of [LEMON, BERRY, SHORT]) db.prepare('DELETE FROM store_products WHERE id = ?').run(p);
    db.prepare('DELETE FROM retail_stores WHERE id = ?').run(STORE);
  } catch (e) { /* best effort — the fixture owns only its own ids */ }
}

process.on('exit', cleanup);
cleanup();

// ── Fixture ─────────────────────────────────────────────────────────────────
db.prepare(`INSERT INTO retail_stores (id, code, name_en, is_active, sort_order)
            VALUES (?, ?, ?, 1, 99)`).run(STORE, 'tst-expired-hold', 'Fixture store');
for (const [id, name] of [[LEMON, 'Lemongrass fixture'], [BERRY, 'Mix Berries fixture'], [SHORT, 'Sold-out fixture']]) {
  db.prepare('INSERT INTO store_products (id, name_en, sku) VALUES (?,?,?)').run(id, name, 'TST-EXP-' + id);
}
for (const [pid, qty] of [[LEMON, 10], [BERRY, 10], [SHORT, 0]]) {
  db.prepare('INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (?,?,?)').run(STORE, pid, qty);
}

const onHand = (pid) => db.prepare(
  'SELECT physical_qty AS q FROM retail_store_stock WHERE store_id = ? AND product_id = ?'
).get(STORE, pid).q;
const holdStatuses = (orderId) => db.prepare(
  'SELECT status FROM retail_stock_reservations WHERE order_id = ? ORDER BY product_id'
).all(orderId).map((r) => r.status);
const orderStatus = (orderId) => db.prepare('SELECT status FROM retail_orders WHERE id = ?').get(orderId).status;

let seq = 0;
function makeOrder(status, { parkedOn = null } = {}) {
  const id = BASE + (++seq);
  ids.push(id);
  db.prepare(`INSERT INTO retail_orders (id, order_no, status, store_id, fulfillment_type, channel, awaiting_restock_pids)
              VALUES (?, ?, ?, ?, 'delivery', 'wechat', ?)`)
    .run(id, 'TEH' + id, status, STORE, parkedOn ? JSON.stringify(parkedOn) : null);
  return id;
}
// A hold as reserveForOrder writes it, with its expiry already set.
function hold(orderId, pid, status, expiresSql) {
  db.prepare(`INSERT INTO retail_stock_reservations (store_id, product_id, order_id, qty, channel, status, expires_at)
              VALUES (?, ?, ?, 1, 'wechat', ?, ${expiresSql})`).run(STORE, pid, orderId, status);
}
const kombuchas = [{ product_id: LEMON, qty: 1 }, { product_id: BERRY, qty: 1 }];

// ── 1–3 · The TC001023 shape ────────────────────────────────────────────────
console.log('\nan out-of-Guangzhou order, paid, parked on a sold-out line:');
{
  const lemonBefore = onHand(LEMON);
  const berryBefore = onHand(BERRY);
  const id = makeOrder('awaiting_restock', { parkedOn: [SHORT] });
  // Holds placed at checkout, and their fifteen minutes are up.
  hold(id, LEMON, 'active', "datetime('now', '-1 minute')");
  hold(id, BERRY, 'active', "datetime('now', '-1 minute')");

  inventory.sweepExpiredReservations();
  ok('the sweeper expires both holds', holdStatuses(id), ['expired', 'expired']);
  ok('the order is NOT cancelled — it was already paid', orderStatus(id), 'awaiting_restock');
  ok('the shelf has not moved yet', [onHand(LEMON), onHand(BERRY)], [lemonBefore, berryBefore]);
  ok('isStockPending says the shelf is still owed', inventory.isStockPending(id, 'paid', 'wechat'), true);

  // "Restocked · start preparing": status flips first, then the commit runs.
  db.prepare("UPDATE retail_orders SET status = 'preparing' WHERE id = ?").run(id);
  const res = inventory.commitUnreservedOrder(id, kombuchas, { note: 'TEH' + id });
  ok('the commit takes both kombuchas', res.committed, 2);
  ok('each shelf goes down by exactly 1', [onHand(LEMON), onHand(BERRY)], [lemonBefore - 1, berryBefore - 1]);
  ok('isStockPending then says the shelf is settled', inventory.isStockPending(id, 'paid', 'wechat'), false);

  const again = inventory.commitUnreservedOrder(id, kombuchas, { note: 'TEH' + id });
  ok('a second commit is a no-op', again, { skipped: 'already_committed' });
  ok('the shelf is still down by 1, not 2', [onHand(LEMON), onHand(BERRY)], [lemonBefore - 1, berryBefore - 1]);
}

// ── 4 · A released hold ─────────────────────────────────────────────────────
console.log('\na hold released without being committed:');
{
  const before = onHand(LEMON);
  const id = makeOrder('preparing');
  hold(id, LEMON, 'released', "datetime('now', '-1 minute')");
  const res = inventory.commitUnreservedOrder(id, [{ product_id: LEMON, qty: 1 }], { note: 'TEH' + id });
  ok('the commit takes it', res.committed, 1);
  ok('the shelf goes down by 1', onHand(LEMON), before - 1);
}

// ── 5 · A committed hold — the normal path, unchanged ───────────────────────
console.log('\na hold that was committed at payment:');
{
  const before = onHand(LEMON);
  const id = makeOrder('preparing');
  hold(id, LEMON, 'committed', "datetime('now', '+1 day')");
  const res = inventory.commitUnreservedOrder(id, [{ product_id: LEMON, qty: 1 }], { note: 'TEH' + id });
  ok('the commit skips it — the hold already took the unit', res, { skipped: 'reserved' });
  ok('the shelf does not move again', onHand(LEMON), before);
}

// ── 6 · An active hold — unchanged ──────────────────────────────────────────
console.log('\na hold still active:');
{
  const before = onHand(BERRY);
  const id = makeOrder('preparing');
  hold(id, BERRY, 'active', "datetime('now', '+10 minutes')");
  const res = inventory.commitUnreservedOrder(id, [{ product_id: BERRY, qty: 1 }], { note: 'TEH' + id });
  ok('the commit skips it, as before', res, { skipped: 'reserved' });
  ok('the shelf does not move', onHand(BERRY), before);
}

console.log(`\nPASS — ${pass} assertions held\n`);
