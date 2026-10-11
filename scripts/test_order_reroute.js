#!/usr/bin/env node
/**
 * §458 — staff can move a paid order to another shop, and its stock goes with it.
 *
 *   node scripts/test_order_reroute.js
 *
 * THE THING THAT IS EASY TO GET WRONG. Changing retail_orders.store_id is one
 * line. A paid order has already taken its units off the first shop — through a
 * committed hold or straight to the ledger — so a move that changes only the
 * store leaves the first shop short for good and never charges the second, and
 * a later refund puts the units back on the wrong shelf. The one script that
 * ever rewrote store_id did exactly that. So most of this file is shelf counts:
 * before the move, after it, and after a refund that follows it.
 *
 * Runs against a REAL sqlite database and the REAL express routes, mounted and
 * called over HTTP, so every count printed is observed rather than reasoned.
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
async function it(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
function section(t) { console.log('\n' + t); }

// ── Fixtures ───────────────────────────────────────────────────────────────
// High ids, clear of the other stock suites' 97xx/98xx blocks.
const A = 9601, B = 9602, C = 9603;            // A: where it was; B: where it goes; C: a second move
const CODE = { [A]: 'rr-a', [B]: 'rr-b', [C]: 'rr-c' };
const P1 = 9611;   // ordinary shelf item, plenty at B
const P2 = 9612;   // the one B is short of
const P3 = 9613;   // stocked at A only — B has no row for it
const CUSTOMER = 9631;
const { testOperator } = require('./lib/test-operator');
const op = testOperator(99871, '__op_order_reroute');

function orderIds() {
  return db.prepare('SELECT id FROM retail_orders WHERE customer_id = ?').all(CUSTOMER).map(r => r.id);
}
function cleanup() {
  op.remove();
  const oids = orderIds();
  if (oids.length) {
    const ph = oids.map(() => '?').join(',');
    for (const t of ['retail_order_items', 'retail_stock_reservations', 'retail_shipments']) {
      try { db.prepare(`DELETE FROM ${t} WHERE order_id IN (${ph})`).run(...oids); } catch {}
    }
    try { db.prepare(`DELETE FROM qingyun_push_queue WHERE retail_order_id IN (${ph})`).run(...oids); } catch {}
    try { db.prepare(`DELETE FROM retail_stock_ledger WHERE ref_table = 'retail_orders' AND ref_id IN (${ph})`).run(...oids); } catch {}
    db.prepare(`DELETE FROM retail_orders WHERE id IN (${ph})`).run(...oids);
  }
  const pids = [P1, P2, P3];
  const pph = pids.map(() => '?').join(',');
  db.prepare('DELETE FROM retail_customers WHERE id = ?').run(CUSTOMER);
  db.prepare(`DELETE FROM retail_stock_ledger WHERE product_id IN (${pph})`).run(...pids);
  db.prepare(`DELETE FROM retail_store_stock  WHERE product_id IN (${pph})`).run(...pids);
  db.prepare(`DELETE FROM store_products      WHERE id         IN (${pph})`).run(...pids);
  try { db.prepare("DELETE FROM channel_status WHERE store_code IN ('rr-a','rr-b','rr-c')").run(); } catch {}
  db.prepare(`DELETE FROM retail_stores WHERE id IN (${A},${B},${C})`).run();
}

function seed() {
  cleanup();
  const st = db.prepare(
    `INSERT INTO retail_stores (id, code, name_en, name_cn, city, district, is_active, sort_order)
     VALUES (?,?,?,?,?,?,1,?)`
  );
  st.run(A, CODE[A], 'Reroute A', '改派甲', '广州市', '越秀区', 91);
  st.run(B, CODE[B], 'Reroute B', '改派乙', '广州市', '天河区', 92);
  st.run(C, CODE[C], 'Reroute C', '改派丙', '广州市', '海珠区', 93);
  const prod = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, weight,
                                 is_batch_made, oos_policy, ship_from_supplier, is_published, is_active)
     VALUES (?,?,?,?,?,?,0,'strict',0,1,1)`
  );
  prod.run(P1, 'Apple Pie Jar', '苹果派', 'rr-1', 30, '200g');
  prod.run(P2, 'Fig Jam',       '无花果酱', 'rr-2', 40, '200g');
  prod.run(P3, 'Olive Oil',     '橄榄油', 'rr-3', 80, '500g');
  db.prepare(
    `INSERT INTO retail_customers (id, nickname, phone, openid, is_blocked, lifetime_spend, points_balance)
     VALUES (?,?,?,?,0,0,0)`
  ).run(CUSTOMER, 'Reroute Test', '13900000003', 'dev:reroute');
}
function setShelf(store, pid, qty) {
  db.prepare('DELETE FROM retail_store_stock WHERE store_id = ? AND product_id = ?').run(store, pid);
  if (qty != null) {
    db.prepare('INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer) VALUES (?,?,?,0)')
      .run(store, pid, qty);
  }
}
const shelf = (store, pid) =>
  db.prepare('SELECT physical_qty q FROM retail_store_stock WHERE store_id = ? AND product_id = ?')
    .get(store, pid)?.q ?? null;

/* A paid delivery order at A whose stock is already taken, either way a real
   one is: `via: 'ledger'` as prepareCommitUnreservedOrder leaves it (decrement +
   order_prepare row), `via: 'hold'` as commitOrderReservations leaves it
   (committed hold + order_commit row), `via: 'active'` an active hold only. */
let nextNo = 0;
function makeOrder(lines, { via = 'ledger', status = 'paid', store = A, fulfillment = 'delivery', channel = 'wechat' } = {}) {
  const orderNo = 'RR' + String(++nextNo).padStart(6, '0');
  const oid = db.prepare(
    `INSERT INTO retail_orders (order_no, customer_id, status, payment_method, store_id,
                                fulfillment_type, subtotal, total, paid_at, channel, routing_reason)
     VALUES (?,?,?,'wechat',?,?,100,100,CURRENT_TIMESTAMP,?,'fallback_no_stock')`
  ).run(orderNo, CUSTOMER, status, store, fulfillment, channel).lastInsertRowid;
  const ins = db.prepare(
    `INSERT INTO retail_order_items (order_id, product_id, name_en, qty, unit_price, line_total)
     VALUES (?,?,?,?,10,?)`
  );
  for (const l of lines) ins.run(oid, l.pid, 'line ' + l.pid, l.qty, 10 * l.qty);
  for (const l of lines) {
    if (via === 'active' || via === 'hold') {
      db.prepare(
        `INSERT INTO retail_stock_reservations (store_id, product_id, order_id, qty, channel, status, expires_at, committed_at)
         VALUES (?,?,?,?,'wechat',?,datetime('now','+1 day'),?)`
      ).run(store, l.pid, oid, l.qty, via === 'hold' ? 'committed' : 'active', via === 'hold' ? '2026-10-11 10:00:00' : null);
    }
    if (via === 'ledger' || via === 'hold') {
      db.prepare('UPDATE retail_store_stock SET physical_qty = physical_qty - ? WHERE store_id = ? AND product_id = ?')
        .run(l.qty, store, l.pid);
      db.prepare(
        `INSERT INTO retail_stock_ledger (store_id, product_id, delta, reason, ref_table, ref_id, balance_after, channel)
         VALUES (?,?,?,?,'retail_orders',?,?,'wechat')`
      ).run(store, l.pid, -l.qty, via === 'hold' ? 'order_commit' : 'order_prepare', oid, shelf(store, l.pid));
    }
  }
  return oid;
}
const order = (id) => db.prepare('SELECT * FROM retail_orders WHERE id = ?').get(id);

(async () => {
  seed();
  const app = express();
  op.add();
  app.use((req, _res, next) => { req.session = { backendUserId: op.id }; next(); });
  app.use(router);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, id, body) => fetch(`${base}/api/retail-admin/orders/${id}/reroute`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  const move = (id, store, force) => call('POST', id, { store_code: CODE[store], ...(force ? { force: true } : {}) });

  try {
    section('── A paid order whose stock came straight off the ledger');
    setShelf(A, P1, 10); setShelf(B, P1, 10); setShelf(C, P1, 10);
    const o1 = makeOrder([{ pid: P1, qty: 3 }]);
    await it('before: A gave 3 (10 → 7), B untouched', () => {
      assert.strictEqual(shelf(A, P1), 7); assert.strictEqual(shelf(B, P1), 10);
    });
    const r1 = await move(o1, B);
    await it('the move succeeds', () => assert.strictEqual(r1.status, 200, JSON.stringify(r1.body)));
    await it('A gets its 3 back, B gives 3', () => {
      assert.strictEqual(shelf(A, P1), 10); assert.strictEqual(shelf(B, P1), 7);
    });
    await it('the order is at B, marked manual, with where it came from and who', () => {
      const o = order(o1);
      assert.strictEqual(o.store_id, B);
      assert.strictEqual(o.routing_reason, 'manual');
      assert.strictEqual(o.rerouted_from_store_id, A);
      assert.ok(o.rerouted_by && o.rerouted_at, 'who and when are written');
      assert.strictEqual(o.rerouted_forced_pids, null, 'nothing was forced');
    });
    await it('two ledger rows, neither of them an "order%" reason', () => {
      const rows = db.prepare(
        "SELECT store_id, delta, reason FROM retail_stock_ledger WHERE ref_table='retail_orders' AND ref_id=? AND reason LIKE 'reroute%' ORDER BY id"
      ).all(o1);
      assert.deepStrictEqual(rows.map(r => [r.store_id, r.delta, r.reason]),
        [[A, 3, 'reroute_return'], [B, -3, 'reroute_take']]);
    });
    await it('a refund after the move returns the units to B, not A', () => {
      inventory.reverseCommittedLedger(o1, [{ product_id: P1, qty: 3 }]);
      assert.strictEqual(shelf(A, P1), 10); assert.strictEqual(shelf(B, P1), 10);
    });

    section('── A second move, B → C');
    setShelf(A, P1, 10); setShelf(B, P1, 10); setShelf(C, P1, 10);
    const o2 = makeOrder([{ pid: P1, qty: 2 }]);
    await move(o2, B);
    const r2 = await move(o2, C);
    await it('A and B end where they started; C gave 2', () => {
      assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
      assert.strictEqual(shelf(A, P1), 10); assert.strictEqual(shelf(B, P1), 10); assert.strictEqual(shelf(C, P1), 8);
      assert.strictEqual(order(o2).rerouted_from_store_id, B, 'the latest move is the one recorded');
    });

    section('── A paid order that reserved and committed at checkout');
    setShelf(A, P1, 10); setShelf(B, P1, 10);
    const o3 = makeOrder([{ pid: P1, qty: 4 }], { via: 'hold' });
    const r3 = await move(o3, B);
    await it('A gets 4 back, B gives 4, and the hold now names B', () => {
      assert.strictEqual(r3.status, 200, JSON.stringify(r3.body));
      assert.strictEqual(shelf(A, P1), 10); assert.strictEqual(shelf(B, P1), 6);
      const h = db.prepare('SELECT store_id, status FROM retail_stock_reservations WHERE order_id = ?').get(o3);
      assert.deepStrictEqual([h.store_id, h.status], [B, 'committed']);
    });
    await it('a cancel after the move returns the units to B', () => {
      inventory.reverseCommittedOrder(o3);
      assert.strictEqual(shelf(A, P1), 10); assert.strictEqual(shelf(B, P1), 10);
    });

    section('── An order waiting for restock, holding stock it has not taken');
    setShelf(A, P1, 10); setShelf(B, P1, 10);
    const o4 = makeOrder([{ pid: P1, qty: 2 }], { via: 'active', status: 'awaiting_restock' });
    const r4 = await move(o4, B);
    await it('no shelf moves; the hold moves to B', () => {
      assert.strictEqual(r4.status, 200, JSON.stringify(r4.body));
      assert.strictEqual(shelf(A, P1), 10); assert.strictEqual(shelf(B, P1), 10);
      const h = db.prepare('SELECT store_id, status FROM retail_stock_reservations WHERE order_id = ?').get(o4);
      assert.deepStrictEqual([h.store_id, h.status], [B, 'active']);
      assert.strictEqual(order(o4).status, 'awaiting_restock', 'it keeps waiting');
    });

    section('── B is short: an alert first, then the person decides');
    setShelf(A, P2, 10); setShelf(B, P2, 1); setShelf(A, P3, 5); setShelf(B, P3, null);
    const o5 = makeOrder([{ pid: P2, qty: 3 }, { pid: P3, qty: 1 }]);
    const pick = await call('GET', o5);
    await it('the picker lists B with what it is short of', () => {
      assert.strictEqual(pick.status, 200);
      const b = pick.body.data.stores.find(s => s.id === B);
      assert.ok(b, 'B is listed');
      assert.ok(!pick.body.data.stores.some(s => s.id === A), 'the current shop is not');
      const byPid = new Map(b.short.map(s => [s.product_id, s]));
      assert.deepStrictEqual([byPid.get(P2).need, byPid.get(P2).available, byPid.get(P2).stocked], [3, 1, true]);
      assert.strictEqual(byPid.get(P3).stocked, false, 'B has no row for the oil');
    });
    const r5 = await move(o5, B);
    await it('without force: 409 needs_confirm, naming both, and nothing changes', () => {
      assert.strictEqual(r5.status, 409);
      assert.strictEqual(r5.body.error, 'needs_confirm');
      assert.deepStrictEqual(r5.body.short.map(s => s.product_id).sort(), [P2, P3]);
      assert.strictEqual(order(o5).store_id, A);
      assert.strictEqual(shelf(A, P2), 7); assert.strictEqual(shelf(B, P2), 1);
    });
    const r5f = await move(o5, B, true);
    await it('with force: it moves, B goes below zero honestly, and the override is kept', () => {
      assert.strictEqual(r5f.status, 200, JSON.stringify(r5f.body));
      assert.strictEqual(r5f.body.forced, true);
      assert.strictEqual(shelf(A, P2), 10); assert.strictEqual(shelf(B, P2), -2);
      assert.strictEqual(shelf(A, P3), 5);  assert.strictEqual(shelf(B, P3), -1, 'a row is made at zero and charged');
      assert.deepStrictEqual(JSON.parse(order(o5).rerouted_forced_pids).sort(), [P2, P3]);
    });

    section('── B is closed for online orders');
    setShelf(A, P1, 10); setShelf(B, P1, 10);
    db.prepare("INSERT OR REPLACE INTO channel_status (channel, store_code, is_open) VALUES ('mini_app', ?, 0)").run(CODE[B]);
    const o6 = makeOrder([{ pid: P1, qty: 1 }]);
    const r6 = await move(o6, B);
    await it('asks first, saying it is closed', () => {
      assert.strictEqual(r6.status, 409);
      assert.strictEqual(r6.body.error, 'needs_confirm');
      assert.strictEqual(r6.body.closed, true);
      assert.strictEqual(order(o6).store_id, A);
    });
    db.prepare("DELETE FROM channel_status WHERE store_code = ?").run(CODE[B]);

    section('── Orders that may not move');
    setShelf(A, P1, 50); setShelf(B, P1, 50);
    const refuse = async (label, oid, reason) => {
      const r = await move(oid, B);
      await it(`${label} → ${reason}`, () => {
        assert.strictEqual(r.status, 409, JSON.stringify(r.body));
        assert.strictEqual(r.body.error, reason);
        assert.strictEqual(order(oid).store_id, A, 'it stays at A');
      });
    };
    await refuse('a pickup', makeOrder([{ pid: P1, qty: 1 }], { fulfillment: 'pickup' }), 'pickup');
    await refuse('a counter sale', makeOrder([{ pid: P1, qty: 1 }], { fulfillment: 'counter' }), 'counter');
    await refuse('a Meituan order', makeOrder([{ pid: P1, qty: 1 }], { channel: 'meituan' }), 'channel');
    await refuse('an order already preparing', makeOrder([{ pid: P1, qty: 1 }], { status: 'preparing' }), 'status');
    const packed = makeOrder([{ pid: P1, qty: 1 }]);
    db.prepare("INSERT INTO retail_shipments (order_id, mode, prepared_at) VALUES (?, 'local', CURRENT_TIMESTAMP)").run(packed);
    await refuse('an order with a packed parcel', packed, 'packed');
    const booking = makeOrder([{ pid: P1, qty: 1 }]);
    db.prepare("INSERT INTO qingyun_push_queue (retail_order_id, store_code, status) VALUES (?, ?, 'processing')").run(booking, CODE[A]);
    await refuse('an order whose courier job is being created', booking, 'courier_booking');

    section('── A courier row with no copy yet follows the order');
    const skipped = makeOrder([{ pid: P1, qty: 1 }]);
    db.prepare("INSERT INTO qingyun_push_queue (retail_order_id, store_code, status) VALUES (?, ?, 'skipped')").run(skipped, CODE[A]);
    const r7 = await move(skipped, B);
    await it('the queue row now names B', () => {
      assert.strictEqual(r7.status, 200, JSON.stringify(r7.body));
      assert.strictEqual(db.prepare('SELECT store_code FROM qingyun_push_queue WHERE retail_order_id = ?').get(skipped).store_code, CODE[B]);
    });

    section('── A failing order write undoes the stock half too');
    setShelf(A, P1, 10); setShelf(B, P1, 10);
    const o8 = makeOrder([{ pid: P1, qty: 2 }]);
    await it('alsoInTx throwing rolls the shelves and holds back', () => {
      assert.throws(() => inventory.moveOrderStock(o8, A, B, { alsoInTx: () => { throw new Error('boom'); } }), /boom/);
      assert.strictEqual(shelf(A, P1), 8); assert.strictEqual(shelf(B, P1), 10);
      assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM retail_stock_ledger WHERE ref_id = ? AND reason LIKE 'reroute%'").get(o8).n, 0);
    });

    section('── The picker says why an order cannot move');
    const prep = makeOrder([{ pid: P1, qty: 1 }], { status: 'preparing' });
    const g = await call('GET', prep);
    await it('eligible: false with the reason', () => {
      assert.deepStrictEqual(g.body.data, { eligible: false, reason: 'status' });
    });
  } finally {
    server.close();
    cleanup();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
