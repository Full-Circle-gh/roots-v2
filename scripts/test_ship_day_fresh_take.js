#!/usr/bin/env node
/**
 * §478 — on its ship day, a paid order's held-back fresh line takes its stock
 * the moment a restock lets the shelf cover it.
 *
 *   node scripts/test_ship_day_fresh_take.js
 *
 * THE CASE THIS LOCKS DOWN. TC001129, 2026-10-14: an advance courier order, paid
 * the day before, groceries taken at payment, four batch-made lines held back by
 * §58. The kitchen's wraps landed at 10:24, nothing took them for the order, a
 * shop transfer sent them away at 12:01, and 备货 at 12:08 drove two shelves to
 * −1. A parked order on the same shelf (§80) had taken its own wrap the second
 * it landed. Two orders waiting on the same food behaved two ways.
 *
 * THE HALVES THAT ARE EASY TO GET WRONG, and most of this file:
 *   • 备货 afterwards must not take the same units again;
 *   • a full refund must return the groceries AND the fresh line — the reason a
 *     hold was not used (reverseOrderStock stops after the hold reverser);
 *   • the kitchen's "to make" list must drop the line once it is taken;
 *   • a parked order keeps first claim; a short shelf, a future ship day, a
 *     split order already moving, a bundle, and a platform order take nothing.
 *
 * Runs against a REAL sqlite database, the REAL lib/inventory.js, and the REAL
 * status route for 备货, so every count printed is observed rather than argued.
 */
'use strict';

const assert  = require('assert');
const path    = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'database.js'));
const { tdb }      = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const inventory    = require(path.join(ROOT, 'lib', 'inventory.js'));
const batchOwed    = require(path.join(ROOT, 'lib', 'batch-owed.js'));
const businessDate = require(path.join(ROOT, 'lib', 'business-date.js'));
const router       = require(path.join(ROOT, 'routes', 'retail.js'));
const db = tdb();

let pass = 0, fail = 0;
async function it(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
function section(t) { console.log('\n' + t); }

// ── Fixtures ───────────────────────────────────────────────────────────────
// 958x block — clear of every other suite's ids.
const STORE    = 9581;
const P_WRAP   = 9582;   // batch-made: the Shawarma Wrap
const P_JAR    = 9583;   // shelf goods, taken at payment
const P_BUNDLE = 9584;   // a bundle wrapper
const CUSTOMER = 9585;
const { testOperator } = require('./lib/test-operator');
const op = testOperator(99881, '__op_ship_day_fresh_take');

const TODAY    = businessDate.zoneParts(businessDate.shopTimezone(db)).ymd;
const TOMORROW = (() => { const d = new Date(TODAY + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();

function orderIds() {
  return db.prepare('SELECT id FROM retail_orders WHERE customer_id = ?').all(CUSTOMER).map(r => r.id);
}
function cleanup() {
  op.remove();
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
  const pids = [P_WRAP, P_JAR, P_BUNDLE];
  const pph  = pids.map(() => '?').join(',');
  db.prepare('DELETE FROM retail_customers WHERE id = ?').run(CUSTOMER);
  db.prepare(`DELETE FROM retail_stock_ledger WHERE product_id IN (${pph})`).run(...pids);
  db.prepare(`DELETE FROM retail_store_stock  WHERE product_id IN (${pph})`).run(...pids);
  db.prepare(`DELETE FROM store_products      WHERE id         IN (${pph})`).run(...pids);
  db.prepare('DELETE FROM retail_stores WHERE id = ?').run(STORE);
}
function seed() {
  cleanup();
  db.prepare(
    `INSERT INTO retail_stores (id, code, name_en, name_cn, city, district, is_active, sort_order)
     VALUES (?,?,?,?,?,?,1,?)`
  ).run(STORE, 'sd-st', 'Ship Day Store', '测试门店', '广州市', '天河区', 96);
  const prod = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, weight,
                                 is_batch_made, bundle_items, is_published, is_active)
     VALUES (?,?,?,?,?,?,?,?,1,1)`
  );
  prod.run(P_WRAP,   'Shawarma Wrap', '沙威玛卷', 'sd-1', 49, '420g', 1, null);
  prod.run(P_JAR,    'Hummus Jar',    '鹰嘴豆泥', 'sd-2', 44, '200g', 0, null);
  prod.run(P_BUNDLE, 'Wrap Box',      '卷饼套餐', 'sd-3', 99, '1kg',  0, JSON.stringify([{ id: P_WRAP, qty: 2 }]));
  db.prepare(
    `INSERT INTO retail_customers (id, nickname, phone, openid, is_blocked, lifetime_spend, points_balance)
     VALUES (?,?,?,?,0,0,0)`
  ).run(CUSTOMER, 'Ship Day Test', '13900000003', 'dev:ship-day');
  const stock = db.prepare('INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer) VALUES (?,?,?,0)');
  stock.run(STORE, P_WRAP, 0);
  stock.run(STORE, P_JAR, 10);
}

const shelf = (pid) =>
  db.prepare('SELECT physical_qty q FROM retail_store_stock WHERE store_id = ? AND product_id = ?').get(STORE, pid)?.q ?? null;
const setShelf = (pid, q) =>
  db.prepare('UPDATE retail_store_stock SET physical_qty = ? WHERE store_id = ? AND product_id = ?').run(q, STORE, pid);
const rows = (oid, pid) => db.prepare(
  `SELECT reason, delta, actor_label, note FROM retail_stock_ledger
    WHERE ref_table = 'retail_orders' AND ref_id = ? AND product_id = ? ORDER BY id`
).all(oid, pid);
const kitchenAdd = (qty) => inventory.adjustStock({
  storeId: STORE, productId: P_WRAP, deltaQty: qty, reason: 'kitchen_add', actorLabel: 'K-test', note: 'add-stock',
});
const owedWraps = () =>
  (batchOwed.owedAt(db, STORE).find(r => r.product_id === P_WRAP) || { from_promised: 0 }).from_promised;

/* An order in the TC001129 shape: paid, shipping on `shipDate`, its grocery
   lines already taken the way prepareCommitUnreservedOrder leaves them at
   payment ('order_prepare' rows), its fresh lines held back by §58. */
let nextNo = 0;
function makeOrder(lines, { status = 'paid', shipDate = TODAY, channel = 'wechat', parkedOn = null } = {}) {
  const orderNo = 'SD' + String(++nextNo).padStart(6, '0');
  const oid = db.prepare(
    `INSERT INTO retail_orders (order_no, customer_id, status, payment_method, store_id, fulfillment_type,
                                subtotal, total, paid_at, channel, promised_ship_date, awaiting_restock_pids)
     VALUES (?,?,?,'wechat',?,'delivery',100,100,datetime('now', ?),?,?,?)`
  ).run(orderNo, CUSTOMER, status, STORE, `-${100 - nextNo} minutes`, channel, shipDate,
        parkedOn ? JSON.stringify(parkedOn) : null).lastInsertRowid;
  const ins = db.prepare(
    `INSERT INTO retail_order_items (order_id, product_id, name_en, qty, unit_price, line_total)
     VALUES (?,?,?,?,10,?)`
  );
  for (const l of lines) ins.run(oid, l.pid, 'line ' + l.pid, l.qty, 10 * l.qty);
  if (status !== 'awaiting_restock') {
    for (const l of lines) {
      if (l.pid !== P_JAR) continue;
      db.prepare('UPDATE retail_store_stock SET physical_qty = physical_qty - ? WHERE store_id = ? AND product_id = ?').run(l.qty, STORE, l.pid);
      db.prepare(
        `INSERT INTO retail_stock_ledger (store_id, product_id, delta, reason, ref_table, ref_id, balance_after, channel)
         VALUES (?,?,?,'order_prepare','retail_orders',?,?,'wechat')`
      ).run(STORE, l.pid, -l.qty, oid, shelf(l.pid));
    }
  }
  return oid;
}
const clearOrders = () => {
  const oids = orderIds();
  if (!oids.length) return;
  const ph = oids.map(() => '?').join(',');
  // Every table that points at an order — a §80 release writes more than the
  // stock rows (its post-payment side effects), and a foreign key refuses the
  // order's delete while any of them is left.
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'retail_orders'").all()
    .map(t => t.name)
    .filter(t => db.prepare(`PRAGMA table_info(${t})`).all().some(c => c.name === 'order_id'));
  for (const t of tables) db.prepare(`DELETE FROM ${t} WHERE order_id IN (${ph})`).run(...oids);
  db.prepare(`DELETE FROM retail_stock_ledger WHERE ref_table = 'retail_orders' AND ref_id IN (${ph})`).run(...oids);
  db.prepare(`DELETE FROM retail_orders WHERE id IN (${ph})`).run(...oids);
};

(async () => {
  seed();
  const app = express();
  op.add();
  app.use((req, _res, next) => { req.session = { backendUserId: op.id }; next(); });
  app.use(router);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const setStatus = (id, status) => fetch(
    `${base}/api/retail-admin/orders/${id}/status`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }
  ).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

  try {
    section('── TC001129: shipping today, groceries taken at payment, wrap held back');
    const o = makeOrder([{ pid: P_WRAP, qty: 1 }, { pid: P_JAR, qty: 1 }]);

    await it('before the restock the wrap is owed to the kitchen and not taken', () => {
      assert.strictEqual(rows(o, P_WRAP).length, 0);
      assert.strictEqual(owedWraps(), 1);
    });

    kitchenAdd(5);
    await it('the kitchen adds 5 → the order takes its wrap in the same call (5 → 4)', () => {
      assert.strictEqual(shelf(P_WRAP), 4, 'shelf');
      const r = rows(o, P_WRAP);
      assert.strictEqual(r.length, 1, JSON.stringify(r));
      assert.strictEqual(r[0].reason, 'order_restock');
      assert.strictEqual(r[0].delta, -1);
      assert.strictEqual(r[0].actor_label, 'Auto · ship day');
    });
    await it('the kitchen list drops the line — it has been made and taken', () => {
      assert.strictEqual(owedWraps(), 0);
    });

    inventory.adjustStock({ storeId: STORE, productId: P_WRAP, deltaQty: -4, reason: 'restock_transfer_out', actorLabel: 'restock', note: 'RS-test' });
    await it('a transfer of everything left cannot take the order\'s wrap (4 → 0, not −1 later)', () => {
      assert.strictEqual(shelf(P_WRAP), 0);
    });

    const prep = await setStatus(o, 'preparing');
    await it('备货 afterwards takes nothing more for the wrap (shelf stays 0)', () => {
      assert.strictEqual(prep.status, 200, JSON.stringify(prep.body));
      assert.strictEqual(shelf(P_WRAP), 0, 'shelf');
      assert.deepStrictEqual(rows(o, P_WRAP).map(r => r.reason), ['order_restock']);
      assert.deepStrictEqual(rows(o, P_JAR).map(r => r.reason), ['order_prepare']);
    });

    // The refund helper's own sequence (routes/retail.js reverseOrderStock):
    // the hold reverser first, then the ledger reverser over the order's lines.
    const jarBefore = shelf(P_JAR);
    const first = inventory.reverseCommittedOrder(o, {});
    const back = inventory.reverseCommittedLedger(o, [{ product_id: P_WRAP, qty: 1 }, { product_id: P_JAR, qty: 1 }], {});
    await it('a full refund returns BOTH the wrap and the jar, once each', () => {
      assert.strictEqual(first.reversed || 0, 0, 'no holds to reverse');
      assert.strictEqual(back.reversed, 2, JSON.stringify(back));
      assert.strictEqual(shelf(P_WRAP), 1);
      assert.strictEqual(shelf(P_JAR), jarBefore + 1);
    });
    const again = inventory.reverseCommittedLedger(o, [{ product_id: P_WRAP, qty: 1 }, { product_id: P_JAR, qty: 1 }], {});
    await it('a second refund returns nothing', () => {
      assert.strictEqual(again.reversed, 0);
      assert.strictEqual(shelf(P_WRAP), 1);
    });

    section('── What takes nothing');
    clearOrders(); setShelf(P_WRAP, 0);
    const tomorrow = makeOrder([{ pid: P_WRAP, qty: 1 }], { shipDate: TOMORROW });
    kitchenAdd(3);
    await it('shipping tomorrow → nothing taken a day early (§58 stands)', () => {
      assert.strictEqual(rows(tomorrow, P_WRAP).length, 0);
      assert.strictEqual(shelf(P_WRAP), 3);
    });

    clearOrders(); setShelf(P_WRAP, 0);
    const big = makeOrder([{ pid: P_WRAP, qty: 2 }]);
    kitchenAdd(1);
    await it('shelf cannot cover the whole line → nothing taken, never negative', () => {
      assert.strictEqual(rows(big, P_WRAP).length, 0);
      assert.strictEqual(shelf(P_WRAP), 1);
    });
    kitchenAdd(1);
    await it('…and the next add that covers it takes it (1 → 2 → 0)', () => {
      assert.deepStrictEqual(rows(big, P_WRAP).map(r => r.delta), [-2]);
      assert.strictEqual(shelf(P_WRAP), 0);
    });

    clearOrders(); setShelf(P_WRAP, 0);
    const moving = makeOrder([{ pid: P_WRAP, qty: 1 }], { status: 'dispatched' });
    kitchenAdd(2);
    await it('a split order already moving (dispatched) is left for its parcel', () => {
      assert.strictEqual(rows(moving, P_WRAP).length, 0);
    });

    clearOrders(); setShelf(P_WRAP, 0);
    const boxed = makeOrder([{ pid: P_WRAP, qty: 1 }, { pid: P_BUNDLE, qty: 1 }]);
    kitchenAdd(5);
    await it('an order holding a bundle is left for 备货', () => {
      assert.strictEqual(rows(boxed, P_WRAP).length, 0);
      assert.strictEqual(shelf(P_WRAP), 5);
    });

    clearOrders(); setShelf(P_WRAP, 0);
    const mt = makeOrder([{ pid: P_WRAP, qty: 1 }], { channel: 'meituan' });
    kitchenAdd(2);
    await it('a Meituan order is not this rule\'s (the ingest takes its stock)', () => {
      assert.strictEqual(rows(mt, P_WRAP).length, 0);
    });

    section('── Who goes first');
    clearOrders(); setShelf(P_WRAP, 0);
    const shipDay = makeOrder([{ pid: P_WRAP, qty: 1 }]);
    const parked  = makeOrder([{ pid: P_WRAP, qty: 1 }], { status: 'awaiting_restock', parkedOn: [P_WRAP] });
    kitchenAdd(1);
    await it('one wrap lands → the parked order (§80) takes it, the ship-day order waits', () => {
      assert.strictEqual(db.prepare('SELECT status FROM retail_orders WHERE id = ?').get(parked).status, 'paid');
      assert.strictEqual(rows(shipDay, P_WRAP).length, 0);
      assert.strictEqual(shelf(P_WRAP), 0);
    });
    kitchenAdd(1);
    await it('the next wrap goes to the ship-day order', () => {
      assert.deepStrictEqual(rows(shipDay, P_WRAP).map(r => r.reason), ['order_restock']);
      assert.strictEqual(shelf(P_WRAP), 0);
    });

    clearOrders(); setShelf(P_WRAP, 0);
    const older = makeOrder([{ pid: P_WRAP, qty: 1 }]);
    const newer = makeOrder([{ pid: P_WRAP, qty: 1 }]);
    kitchenAdd(1);
    await it('two ship-day orders, one wrap → the older order gets it', () => {
      assert.strictEqual(rows(older, P_WRAP).length, 1);
      assert.strictEqual(rows(newer, P_WRAP).length, 0);
    });

    section('── The label both Stock activity screens show');
    const fs = require('fs');
    for (const f of ['public/retail-admin/13-activity.js', 'public/m.html']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      await it(`${f} labels order_restock with the release's live pair`, () => {
        assert.ok(/order_restock[^\n]*'Taken on restock'[^\n]*'已补货，自动扣减'/.test(src), 'label missing');
      });
    }
  } finally {
    server.close();
    cleanup();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
