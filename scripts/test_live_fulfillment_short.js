#!/usr/bin/env node
/**
 * The "shipping store is short" warning reads the stock as it is NOW.
 *
 *   node scripts/test_live_fulfillment_short.js
 *
 * Ash, 2026-10-10: `fulfillment_short_pids` is written once at checkout and
 * nothing rewrote it, so the phone chip, the PC badge and the drawer strip kept
 * warning after the shop restocked — and on orders already delivered. The list
 * and detail routes now send that list narrowed to what is still true
 * (liveFulfillmentShortPids in routes/retail.js).
 *
 * Runs the REAL routes against a REAL sqlite database over HTTP.
 *
 * What it locks down:
 *   1. Still short at the shipping store → still warned, on list and drawer.
 *   2. Restocked, but not to this order's quantity → still warned.
 *   3. Restocked enough → the warning is gone.
 *   4. 🔴 A delivered order warns about nothing, whatever the column holds.
 *   5. A line already taken off the shelf for this order drops out; a line
 *      still waiting stays.
 *   6. The column itself is untouched — it is the checkout record the WeCom
 *      new-order card reads.
 */
'use strict';

const assert  = require('assert');
const path    = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const router  = require(path.join(ROOT, 'routes', 'retail.js'));
const db = tdb();

let pass = 0, fail = 0;
async function it(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// High ids, clear of the other suites' fixture blocks.
const SHIP = 97761, OTHER = 97762, CUSTOMER = 97771;
const P_SALAD = 97763, P_BOWL = 97764, P_TAKEN = 97765;
const PIDS = [P_SALAD, P_BOWL, P_TAKEN];
const { testOperator } = require('./lib/test-operator');
// The suite's own operator, made and removed by the suite — see scripts/lib/test-operator.js.
const op = testOperator(99877, '__op_live_short');

function cleanup() {
  op.remove();
  const oids = db.prepare('SELECT id FROM retail_orders WHERE customer_id = ?').all(CUSTOMER).map((r) => r.id);
  if (oids.length) {
    const ph = oids.map(() => '?').join(',');
    for (const t of ['retail_order_items', 'retail_payments', 'retail_shipments', 'retail_stock_reservations']) {
      try { db.prepare(`DELETE FROM ${t} WHERE order_id IN (${ph})`).run(...oids); } catch { /* table absent on this schema: nothing to clean */ }
    }
    db.prepare(`DELETE FROM retail_stock_ledger WHERE ref_table = 'retail_orders' AND ref_id IN (${ph})`).run(...oids);
    db.prepare(`DELETE FROM retail_orders WHERE id IN (${ph})`).run(...oids);
  }
  db.prepare('DELETE FROM retail_store_stock WHERE store_id IN (?, ?)').run(SHIP, OTHER);
  db.prepare('DELETE FROM retail_customers WHERE id = ?').run(CUSTOMER);
  db.prepare('DELETE FROM retail_stores WHERE id IN (?, ?)').run(SHIP, OTHER);
  db.prepare(`DELETE FROM store_products WHERE id IN (${PIDS.map(() => '?').join(',')})`).run(...PIDS);
}

function setStock(storeId, pid, qty) {
  db.prepare(
    `INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (?,?,?)
     ON CONFLICT(store_id, product_id) DO UPDATE SET physical_qty = excluded.physical_qty`
  ).run(storeId, pid, qty);
}

function seed() {
  cleanup();
  const store = db.prepare(
    `INSERT INTO retail_stores (id, code, name_en, name_cn, city, district, is_active, sort_order)
     VALUES (?,?,?,?,?,?,1,?)`
  );
  store.run(SHIP, 'ls-ship', 'Live Short Ship', '实时缺货发货店', '广州市', '天河区', 97);
  store.run(OTHER, 'ls-other', 'Live Short Other', '实时缺货其他店', '广州市', '越秀区', 98);
  db.prepare(
    `INSERT INTO retail_customers (id, nickname, phone, openid, is_blocked, lifetime_spend, points_balance)
     VALUES (?,?,?,?,0,0,0)`
  ).run(CUSTOMER, 'Live Short Test', '13900000077', 'dev:live-short');
  const prod = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_published, is_active, is_batch_made)
     VALUES (?,?,?,?,10,1,1,?)`
  );
  prod.run(P_SALAD, 'ls salad', '测试沙拉', 'ls-' + P_SALAD, 0);
  prod.run(P_BOWL,  'ls bowl',  '测试碗',   'ls-' + P_BOWL,  1);   // kitchen-made: deducted late
  prod.run(P_TAKEN, 'ls taken', '测试已扣', 'ls-' + P_TAKEN, 0);
  for (const pid of PIDS) { setStock(SHIP, pid, 0); setStock(OTHER, pid, 20); }
}

let n = 0;
function makeOrder(status, shortPids, lines) {
  const info = db.prepare(
    `INSERT INTO retail_orders (order_no, customer_id, status, payment_method, store_id,
                                fulfillment_type, subtotal, total, paid_at, channel, fulfillment_short_pids)
     VALUES (?,?,?,'wechat',?,'delivery',100,100,CURRENT_TIMESTAMP,'wechat',?)`
  ).run('LS' + String(++n).padStart(6, '0'), CUSTOMER, status, SHIP, JSON.stringify(shortPids));
  const ins = db.prepare(
    `INSERT INTO retail_order_items (order_id, product_id, name_en, name_cn, qty, unit_price, line_total)
     VALUES (?,?,?,?,?,10,?)`
  );
  for (const [pid, qty] of lines) ins.run(info.lastInsertRowid, pid, 'ls ' + pid, '测试' + pid, qty, 10 * qty);
  return info.lastInsertRowid;
}

(async () => {
  seed();
  const waiting   = makeOrder('paid',      [P_SALAD],         [[P_SALAD, 2]]);
  const delivered = makeOrder('delivered', [P_SALAD],         [[P_SALAD, 2]]);
  const partial   = makeOrder('paid',      [P_TAKEN, P_BOWL], [[P_TAKEN, 1], [P_BOWL, 1]]);
  // P_TAKEN has already come off the shelf for this order; P_BOWL (kitchen-made)
  // has not, which is what keeps the order stock-pending.
  db.prepare(
    `INSERT INTO retail_stock_ledger (store_id, product_id, delta, reason, ref_table, ref_id, balance_after, channel)
     VALUES (?,?,-1,'order_prepare','retail_orders',?,-1,'wechat')`
  ).run(SHIP, P_TAKEN, partial);

  const app = express();
  op.add();
  app.use((req, _res, next) => { req.session = { backendUserId: op.id }; next(); });
  app.use(router);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const listRows = async () => {
    const res = await fetch(`${base}/api/retail-admin/orders?customer_id=${CUSTOMER}&limit=50`);
    const body = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(body).slice(0, 200));
    return body.orders || body.data || body.rows || [];
  };
  const listShort = async (id) => {
    const r = (await listRows()).find((x) => x.id === id);
    assert.ok(r, 'row ' + id + ' missing from the list');
    return r.fulfillment_short_pids == null ? null : JSON.parse(r.fulfillment_short_pids);
  };
  const detailShort = async (id) => {
    const res = await fetch(`${base}/api/retail-admin/orders/${id}`);
    const body = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(body).slice(0, 200));
    const o = body.data;
    assert.ok(o && o.id === id, 'no order in the reply');
    return o.fulfillment_short_pids == null ? null : JSON.parse(o.fulfillment_short_pids);
  };

  try {
    console.log('\n1. still short at the shipping store → still warned');
    await it('list', async () => assert.deepStrictEqual(await listShort(waiting), [P_SALAD]));
    await it('drawer', async () => assert.deepStrictEqual(await detailShort(waiting), [P_SALAD]));

    console.log('\n5. a line already taken for this order drops out; the waiting one stays');
    await it('list: only the kitchen line is left', async () =>
      assert.deepStrictEqual(await listShort(partial), [P_BOWL]));
    await it('drawer: the same', async () =>
      assert.deepStrictEqual(await detailShort(partial), [P_BOWL]));

    console.log('\n4. 🔴 a delivered order warns about nothing');
    await it('list', async () => assert.strictEqual(await listShort(delivered), null));
    await it('drawer', async () => assert.strictEqual(await detailShort(delivered), null));

    console.log('\n2. restocked, but not to this order\'s quantity → still warned');
    setStock(SHIP, P_SALAD, 1);
    await it('1 on the shelf, 2 ordered', async () => assert.deepStrictEqual(await listShort(waiting), [P_SALAD]));

    console.log('\n3. restocked enough → the warning is gone');
    setStock(SHIP, P_SALAD, 5);
    await it('list', async () => assert.strictEqual(await listShort(waiting), null));
    await it('drawer', async () => assert.strictEqual(await detailShort(waiting), null));

    console.log('\n6. the checkout record is untouched');
    await it('the column still holds what checkout wrote', () => {
      const row = db.prepare('SELECT fulfillment_short_pids FROM retail_orders WHERE id = ?').get(waiting);
      assert.strictEqual(row.fulfillment_short_pids, JSON.stringify([P_SALAD]));
    });
  } finally {
    server.close();
    cleanup();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
