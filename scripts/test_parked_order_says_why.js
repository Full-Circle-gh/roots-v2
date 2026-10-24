#!/usr/bin/env node
/**
 * A paid order parked on a restock tells the shopper so, and says what for.
 *
 *   node scripts/test_parked_order_says_why.js
 *
 * THE DEFECT. A shopper in Chengdu paid for a sold-out frozen loaf. The order
 * parked as 'awaiting_restock' without being asked — markOrderPaid parks on the
 * order's awaiting_restock_pids, and a sold-out 'backorder_gz' line writes them
 * with no modal in front. The success screen said "Order placed. We're on it.",
 * the timeline's highlighted dot read "Paid", and the one place that said
 * "Awaiting stock" was a header scrolled off the screen. She reported she had
 * never been told her order was waiting.
 *
 * WHAT IS LOCKED DOWN:
 *   1. THE ORDER PAYLOAD NAMES WHAT IT WAITS ON — the held line only, not the
 *      other lines that happened to be in the same order.
 *   2. THE TIMELINE HAS A STEP FOR IT, straight after Paid, so the highlighted
 *      dot is not "Paid". CN is the locked 等待补货.
 *   3. THE SUCCESS SCREEN'S PAYLOAD (payment/status) NAMES IT TOO.
 *   4. 🔴 ONLY A PARKED ORDER. awaiting_restock_pids is kept after release as
 *      the audit trail, so an order that is paid, with pids on it, must read
 *      exactly as before: no names, no extra step.
 *   5. THE RAW COLUMN IS NOT HANDED OUT. Product ids are the server's.
 *
 * The routes are the REAL express routes, mounted and called over HTTP against
 * a real sqlite database.
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
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// High ids in a block no other suite claims (the shard shares one sqlite file).
const CUSTOMER = 9984;
const TOKEN    = 'parkedwhytesttoken9984';
const PARKED = 9985, RELEASED = 9986;
const HELD_PID = 9987001, OTHER_PID = 9987002;
const IDS = [PARKED, RELEASED];

function cleanup() {
  const ph = IDS.map(() => '?').join(',');
  try { db.prepare(`DELETE FROM retail_order_items WHERE order_id IN (${ph})`).run(...IDS); } catch {}
  db.prepare(`DELETE FROM retail_orders WHERE id IN (${ph})`).run(...IDS);
  db.prepare('DELETE FROM retail_auth_tokens WHERE customer_id = ?').run(CUSTOMER);
  db.prepare('DELETE FROM retail_customers WHERE id = ?').run(CUSTOMER);
  db.prepare('DELETE FROM store_products WHERE id IN (?,?)').run(HELD_PID, OTHER_PID);
}

function seed() {
  cleanup();
  db.prepare(
    `INSERT INTO retail_customers (id, nickname, phone, openid, is_blocked, lifetime_spend, points_balance)
     VALUES (?,?,?,?,0,0,0)`
  ).run(CUSTOMER, 'Parked Why Test', '13900000050', 'dev:parked-why');
  db.prepare(
    "INSERT INTO retail_auth_tokens (token, customer_id, expires_at) VALUES (?,?,datetime('now','+1 day'))"
  ).run(TOKEN, CUSTOMER);
  const prod = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, weight,
                                 is_batch_made, oos_policy, ship_from_supplier, is_published, is_active)
     VALUES (?,?,?,?,?,?,0,'backorder_gz',0,1,1)`
  );
  prod.run(HELD_PID,  'Buckwheat Bread',   '荞麦面包', 'pw-1', 49, '600g');
  prod.run(OTHER_PID, 'White Bean Tempeh', '白豆天贝', 'pw-2', 31, '200g');
  const ord = db.prepare(
    `INSERT INTO retail_orders (id, customer_id, order_no, status, total, payment_method,
                                placed_at, paid_at, awaiting_restock_pids)
     VALUES (?,?,?,?,100,'wechat','2026-10-23 07:06:00','2026-10-23 07:06:30',?)`
  );
  const pids = JSON.stringify([HELD_PID]);
  ord.run(PARKED,   CUSTOMER, 'PW-0001', 'awaiting_restock', pids);
  ord.run(RELEASED, CUSTOMER, 'PW-0002', 'paid',             pids);
  const line = db.prepare(
    `INSERT INTO retail_order_items (order_id, product_id, name_en, name_cn, qty, unit_price, line_total)
     VALUES (?,?,?,?,?,?,?)`
  );
  for (const id of IDS) {
    line.run(id, HELD_PID,  'Buckwheat Bread', '荞麦面包', 4, 49, 196);
    line.run(id, OTHER_PID, 'White Bean Tempeh', '白豆天贝', 1, 31, 31);
  }
}

const app = express();
app.use(router);
let PORT = 0;
const get = (p) => fetch(`http://127.0.0.1:${PORT}${p}`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

(async () => {
  seed();
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;

  try {
    console.log('\nGET /api/retail/orders/:id — a parked order\n');
    const parked = await get(`/api/retail/orders/${PARKED}`);
    const po = parked.body?.data || {};
    it('names the held line and only the held line', () => {
      assert.strictEqual(parked.status, 200);
      assert.deepStrictEqual(po.waiting_items.map(w => w.name_en), ['Buckwheat Bread']);
      assert.strictEqual(po.waiting_items[0].name_cn, '荞麦面包');
      assert.strictEqual(po.waiting_items[0].qty, 4);
    });
    it('has a waiting step straight after Paid, stamped with the paid time', () => {
      const keys = po.timeline.map(s => s.key);
      assert.strictEqual(keys[keys.indexOf('paid') + 1], 'awaiting_stock');
      const step = po.timeline.find(s => s.key === 'awaiting_stock');
      assert.strictEqual(step.cn, '等待补货');
      assert.ok(step.at, 'the step is "done", so the page marks it active');
    });
    it('does not hand out the raw product-id column', () => {
      assert.ok(!('awaiting_restock_pids' in po));
    });

    console.log('\nGET /api/retail/orders/:id — paid, with the audit-trail pids left on it\n');
    const rel = await get(`/api/retail/orders/${RELEASED}`);
    const ro = rel.body?.data || {};
    it('names nothing and gains no step', () => {
      assert.deepStrictEqual(ro.waiting_items, []);
      assert.ok(!ro.timeline.some(s => s.key === 'awaiting_stock'));
    });

    console.log('\nGET /api/retail/payment/status/:id — the success screen\n');
    const ps = await get(`/api/retail/payment/status/${PARKED}`);
    it('says what the parked order waits on', () => {
      assert.strictEqual(ps.status, 200);
      assert.strictEqual(ps.body.data.status, 'awaiting_restock');
      assert.deepStrictEqual(ps.body.data.waiting_items.map(w => w.name_en), ['Buckwheat Bread']);
      assert.ok(!('awaiting_restock_pids' in ps.body.data));
    });
    const pr = await get(`/api/retail/payment/status/${RELEASED}`);
    it('says nothing for an order that is not parked', () => {
      assert.deepStrictEqual(pr.body.data.waiting_items, []);
    });
  } finally {
    server.close();
    cleanup();
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
