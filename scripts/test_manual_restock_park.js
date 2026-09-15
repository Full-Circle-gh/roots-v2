#!/usr/bin/env node
/**
 * §136 — an operator can move a PAID order into the restock queue, and cannot
 * park one that would never come back out of it.
 *
 *   node scripts/test_manual_restock_park.js
 *
 * THE DEFECT THIS LOCKS DOWN. 'awaiting_restock' could only ever be reached by
 * the CHECKOUT — the customer answered the shortage modal, or §80/§128/§134's
 * park caught a short pre-order line. A shortage found AFTER the money landed
 * had nowhere to go: STATUS_TRANSITIONS offered no step from 'paid', so the
 * picker who reached the shelf and found nothing could only prepare an order
 * that cannot be picked, or cancel and refund a customer who would rather wait.
 * Order TC000735 is the live case — it settled as 'paid' and took the Tianhe
 * shelf to -1, and once §134 stopped that happening again there was still no
 * way to correct the orders it had already happened to.
 *
 * THE HALF THAT IS EASY TO GET WRONG, and most of this file: a park is only
 * useful if the order comes BACK. checkAwaitingRestockForRestock only looks at
 * an order when a product in `awaiting_restock_pids` is restocked, and only
 * releases it when every product it needs is covered — so a park written
 * carelessly is a strictly worse bug than the one it fixes, an order stranded
 * in a queue whose whole promise is that orders leave it by themselves. And an
 * order parked from 'paid' has ALREADY taken its stock, so a release that
 * deducts again takes the same units twice.
 *
 * Runs against a REAL sqlite database and the REAL express route, mounted and
 * called over HTTP, so every status and shelf count printed is an observed
 * value rather than reasoning about what the code should do.
 */
'use strict';

const assert  = require('assert');
const path    = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'database.js'));
const { tdb }   = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const inventory = require(path.join(ROOT, 'lib', 'inventory.js'));
const router    = require(path.join(ROOT, 'routes', 'retail.js'));
const db = tdb();

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
function section(t) { console.log('\n' + t); }

// ── Fixtures ───────────────────────────────────────────────────────────────
// High ids, clear of test_preorder_park.js's 98xx block.
const STORE    = 9701;
const P_SHORT  = 9711;   // the item the picker cannot find
const P_OK     = 9712;   // deep on the shelf
const P_EXTRA  = 9713;   // a stock-backed paid add-on, also short
const P_NOROW  = 9714;   // stocked NOWHERE — the can-never-release case
const OPT      = 9751;
const CH_EXTRA = 9761;
const CUSTOMER = 9731;
const OPERATOR = 1;      // tenant_users row the suite acts as

function orderIds() {
  return db.prepare('SELECT id FROM retail_orders WHERE customer_id = ?').all(CUSTOMER).map(r => r.id);
}

function cleanup() {
  const oids = orderIds();
  if (oids.length) {
    const ph = oids.map(() => '?').join(',');
    for (const t of ['retail_order_addons', 'retail_order_items', 'retail_stock_reservations',
                     'retail_points_transactions', 'retail_payments', 'retail_shipments',
                     'retail_refund_events', 'retail_reviews', 'retail_referrals',
                     'retail_subscriptions', 'retail_lifetime_commissions', 'delivery_jobs',
                     'qingyun_push_queue']) {
      try { db.prepare(`DELETE FROM ${t} WHERE order_id IN (${ph})`).run(...oids); } catch {}
    }
    try { db.prepare(`DELETE FROM retail_stock_ledger WHERE ref_table = 'retail_orders' AND ref_id IN (${ph})`).run(...oids); } catch {}
    db.prepare(`DELETE FROM retail_orders WHERE id IN (${ph})`).run(...oids);
  }
  const pids = [P_SHORT, P_OK, P_EXTRA, P_NOROW];
  const pph  = pids.map(() => '?').join(',');
  try { db.prepare('DELETE FROM retail_product_option_choices WHERE option_id = ?').run(OPT); } catch {}
  try { db.prepare('DELETE FROM retail_product_options WHERE id = ?').run(OPT); } catch {}
  db.prepare('DELETE FROM retail_customers        WHERE id = ?').run(CUSTOMER);
  db.prepare(`DELETE FROM retail_stock_ledger WHERE product_id IN (${pph})`).run(...pids);
  db.prepare(`DELETE FROM retail_store_stock  WHERE product_id IN (${pph})`).run(...pids);
  db.prepare(`DELETE FROM store_products      WHERE id         IN (${pph})`).run(...pids);
  db.prepare('DELETE FROM retail_stores       WHERE id = ?').run(STORE);
}

function seed() {
  cleanup();
  db.prepare(
    `INSERT INTO retail_stores (id, code, name_en, name_cn, city, district, is_active, sort_order)
     VALUES (?,?,?,?,?,?,1,?)`
  ).run(STORE, 'mp-st', 'Park Test Store', '测试门店', '广州市', '天河区', 95);

  const prod = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, weight,
                                 is_batch_made, oos_policy, ship_from_supplier, is_published, is_active)
     VALUES (?,?,?,?,?,?,?,?,?,1,1)`
  );
  prod.run(P_SHORT, 'Pita Bread',    '皮塔饼',  'mp-1', 45, '400g', 0, 'backorder_gz', 0);
  prod.run(P_OK,    'Green Dip',     '青酱',    'mp-2', 69, '225g', 0, 'strict',       0);
  prod.run(P_EXTRA, 'Crisp Crackers','薄脆饼',  'mp-3', 27, '100g', 0, 'strict',       0);
  prod.run(P_NOROW, 'Olive Oil',     '橄榄油',  'mp-4', 88, '500g', 0, null,           0);
  db.prepare(
    `INSERT INTO retail_product_options (id, product_id, question_en, question_cn, type, is_required, sort_order)
     VALUES (?,?,?,?,'multi',0,0)`
  ).run(OPT, P_OK, 'Add extras?', '加点配料?');
  db.prepare(
    `INSERT INTO retail_product_option_choices
       (id, option_id, label_en, label_cn, price_delta, stock_product_id, sort_order)
     VALUES (?,?,?,?,?,?,0)`
  ).run(CH_EXTRA, OPT, 'Crisp Crackers (1 pack)', '薄脆饼(1包)', 27, P_EXTRA);

  db.prepare(
    `INSERT INTO retail_customers (id, nickname, phone, openid, is_blocked, lifetime_spend, points_balance)
     VALUES (?,?,?,?,0,0,0)`
  ).run(CUSTOMER, 'Manual Park Test', '13900000002', 'dev:manual-park');

  const stock = db.prepare(
    'INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer) VALUES (?,?,?,0)'
  );
  stock.run(STORE, P_SHORT, 0);
  stock.run(STORE, P_OK,    40);
  stock.run(STORE, P_EXTRA, 20);
  // P_NOROW gets NO retail_store_stock row anywhere — that is what makes it the
  // can-never-release case, exactly as a supplier-direct line is.
}

const shelf = (pid) =>
  db.prepare('SELECT physical_qty q FROM retail_store_stock WHERE store_id = ? AND product_id = ?')
    .get(STORE, pid)?.q ?? null;

/* An order in the state the report arrived in: SETTLED, and its stock already
   taken. Written directly rather than through checkout because that is the
   point — these are the orders that exist now, placed before §134, that no
   checkout path will produce again. `committed` mirrors what
   prepareCommitUnreservedOrder leaves behind: the decrement plus its ledger
   row, which is what makes the shelf negative when it could not cover the line. */
let nextNo = 0;
function makePaidOrder(lines, { committed = true } = {}) {
  const orderNo = 'MP' + String(++nextNo).padStart(6, '0');
  const info = db.prepare(
    `INSERT INTO retail_orders (order_no, customer_id, status, payment_method, store_id,
                                fulfillment_type, subtotal, total, paid_at, channel)
     VALUES (?,?,'paid','wechat',?,'delivery',?,?,CURRENT_TIMESTAMP,'wechat')`
  ).run(orderNo, CUSTOMER, STORE, 100, 100);
  const oid = info.lastInsertRowid;
  const ins = db.prepare(
    `INSERT INTO retail_order_items (order_id, product_id, name_en, qty, unit_price, line_total, options_json)
     VALUES (?,?,?,?,?,?,?)`
  );
  for (const l of lines) {
    ins.run(oid, l.pid, 'line ' + l.pid, l.qty, 10, 10 * l.qty,
      l.choices ? JSON.stringify(l.choices) : null);
  }
  if (committed) {
    // Take the stock the way a settled order already has, ledger row included —
    // that row is what orderCommittedPids reads, and skipping it here would test
    // an order shape that does not exist in the database.
    for (const [pid, qty] of inventory.orderStockNeed(oid).entries()) {
      const row = db.prepare('SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?').get(STORE, pid);
      if (!row) continue;
      db.prepare('UPDATE retail_store_stock SET physical_qty = physical_qty - ? WHERE store_id = ? AND product_id = ?').run(qty, STORE, pid);
      db.prepare(
        `INSERT INTO retail_stock_ledger (store_id, product_id, delta, reason, ref_table, ref_id, balance_after, channel)
         VALUES (?,?,?,'order_prepare','retail_orders',?,?,'wechat')`
      ).run(STORE, pid, -qty, oid, row.physical_qty - qty);
    }
  }
  return oid;
}
const load = (id) =>
  db.prepare('SELECT id, status, awaiting_restock_pids FROM retail_orders WHERE id = ?').get(id);

(async () => {
  seed();
  const app = express();
  app.use((req, _res, next) => { req.session = { backendUserId: OPERATOR }; next(); });
  app.use(router);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const park = (id, status = 'awaiting_restock') => fetch(
    `${base}/api/retail-admin/orders/${id}/status`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }
  ).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

  try {
    section('── A paid order the picker cannot fill');
    // P_SHORT is at 0 and this order already took 1 of it, so the shelf reads -1
    // — the TC000735 shape exactly.
    const a = makePaidOrder([{ pid: P_SHORT, qty: 1 }, { pid: P_OK, qty: 1 }]);
    it('the fixture really is the reported shape: settled, and the shelf below zero', () => {
      assert.strictEqual(load(a).status, 'paid');
      assert.strictEqual(shelf(P_SHORT), -1);
    });

    const r1 = await park(a);
    it('the operator can move it into the restock queue', () => {
      assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
      assert.strictEqual(load(a).status, 'awaiting_restock');
    });
    it('the server computed WHICH product it waits on — the operator never named one',
      () => assert.deepStrictEqual(JSON.parse(load(a).awaiting_restock_pids), [P_SHORT]));
    it('parking moves no stock: the shelf is exactly as the picker left it', () => {
      assert.strictEqual(shelf(P_SHORT), -1);
      assert.strictEqual(shelf(P_OK), 39);
    });

    section('── The delivery arrives');
    it('a restock that does not cover the order does NOT release it', () => {
      inventory.adjustStock({ storeId: STORE, productId: P_SHORT, deltaQty: 1,
        reason: 'purchase_receipt', note: 'test_manual_restock_park' });
      // -1 + 1 = 0, still short of the 1 this order needs.
      assert.strictEqual(shelf(P_SHORT), 0);
      assert.strictEqual(load(a).status, 'awaiting_restock');
    });
    it('a restock that covers it releases it back to Paid', () => {
      inventory.adjustStock({ storeId: STORE, productId: P_SHORT, deltaQty: 6,
        reason: 'purchase_receipt', note: 'test_manual_restock_park' });
      assert.strictEqual(load(a).status, 'paid');
    });
    /* 🔴 THE ONE THAT BREAKS SILENTLY. This order took its stock when it was
       paid. The release deducting again would take the same unit twice and put
       the shelf straight back under, which is the fault the park exists to make
       visible. 0 + 6 = 6, and nothing further comes off. */
    it('and does NOT take the stock a second time',
      () => assert.strictEqual(shelf(P_SHORT), 6));
    it('nor the line that was never short',
      () => assert.strictEqual(shelf(P_OK), 39));

    section('── An add-on can be the short thing too (§134 end to end)');
    const b = makePaidOrder([{ pid: P_OK, qty: 1, choices: [{ choice_id: CH_EXTRA, stock_product_id: P_EXTRA }] }]);
    db.prepare('UPDATE retail_store_stock SET physical_qty = 0 WHERE store_id = ? AND product_id = ?').run(STORE, P_EXTRA);
    const r2 = await park(b);
    it('an order whose only shortage is a paid extra parks on the EXTRA', () => {
      assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
      assert.deepStrictEqual(JSON.parse(load(b).awaiting_restock_pids), [P_EXTRA]);
    });

    section('── The three refusals, which are the point of the guard');
    const c = makePaidOrder([{ pid: P_OK, qty: 1 }]);
    const r3 = await park(c);
    it('nothing short → refused, and the order is left where it was', () => {
      assert.strictEqual(r3.status, 409);
      assert.strictEqual(r3.body?.error, 'nothing_short');
      assert.strictEqual(load(c).status, 'paid');
      assert.strictEqual(load(c).awaiting_restock_pids, null);
    });

    /* A line with no stock row at the store can never satisfy the release's
       `av.exists` test, so parking this order would strand it forever — the same
       hazard the checkout park refuses by counting supplier-direct lines whole. */
    const d = makePaidOrder([{ pid: P_SHORT, qty: 1 }, { pid: P_NOROW, qty: 1 }]);
    db.prepare('UPDATE retail_store_stock SET physical_qty = 0 WHERE store_id = ? AND product_id = ?').run(STORE, P_SHORT);
    const r4 = await park(d);
    it('a line not stocked here → refused rather than stranded forever', () => {
      assert.strictEqual(r4.status, 409);
      assert.strictEqual(r4.body?.error, 'line_not_stocked_here');
      assert.deepStrictEqual(r4.body?.product_ids, [P_NOROW]);
      assert.strictEqual(load(d).status, 'paid');
    });
    it('and the refusal NAMES the item, so the operator knows which one',
      () => assert.strictEqual(r4.body?.products?.[0]?.name_en, 'Olive Oil'));

    const e = makePaidOrder([{ pid: P_SHORT, qty: 1 }]);
    db.prepare("UPDATE retail_orders SET status = 'preparing' WHERE id = ?").run(e);
    const r5 = await park(e);
    it('only a PAID order may be parked — preparing is refused', () => {
      assert.strictEqual(r5.status, 409);
      assert.strictEqual(r5.body?.error, 'invalid_transition');
      assert.strictEqual(load(e).status, 'preparing');
    });

    section('── The step forward still works from here');
    const f = makePaidOrder([{ pid: P_SHORT, qty: 1 }]);
    assert.strictEqual((await park(f)).status, 200);
    const r6 = await park(f, 'preparing');
    it("a parked order still moves on when the operator says so", () => {
      assert.strictEqual(r6.status, 200, JSON.stringify(r6.body));
      assert.strictEqual(load(f).status, 'preparing');
    });
  } finally {
    server.close();
    cleanup();
  }

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
