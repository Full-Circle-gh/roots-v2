#!/usr/bin/env node
/**
 * A paid order parked on a restock sits in the customer's PAID bucket.
 *
 *   node scripts/test_customer_paid_bucket.js
 *
 * THE DEFECT. 'awaiting_restock' is a paid order held until the line it is
 * waiting on is back on the shelf — the shopper's money has moved, the shop
 * owes them goods (lib/batch-owed.js), and lib/finance-window.js has counted
 * it among the paid statuses all along. Every customer-facing surface
 * disagreed. GET /api/retail/orders matched `status = 'paid'` exactly and
 * GET /api/retail/orders/stats read counts.paid on its own, so a parked order
 * belonged to no chip and no Me-tab bucket: the shopper who had just paid for
 * it could find it only under All. From the customer's side that reads as
 * "I paid and my order went nowhere" — which is the one thing the Paid bucket
 * exists to deny.
 *
 * WHAT IS LOCKED DOWN, and it is the decision rather than the SQL:
 *
 *   1. THE PAID CHIP LISTS BOTH. 'paid' and 'awaiting_restock', ordered
 *      together like any other page of the list.
 *   2. 🔴 THE BADGE AND THE LIST AGREE. The Me-tab bucket count and the screen
 *      it opens are computed in two different queries in two different routes.
 *      A badge reading 1 that opens a screen with two orders on it is worse
 *      than no badge at all, so both are asserted against the same fixture.
 *   3. NO OTHER CHIP WIDENED. 'preparing' still means preparing and
 *      'pending_payment' still means unpaid. The widening is one bucket's, not
 *      a general loosening of the status filter — and in particular this is
 *      NOT lib/finance-window.js's five-status predicate, which would drag
 *      dispatched and delivered orders into the Paid chip.
 *   4. THE PILL IS PAINTED. A status with no rule of its own falls through to
 *      the bare `.status-pill` — no background, a currentColor border — and
 *      renders as no status at all, which is how the orders looked on the
 *      screen that prompted this. Asserted against the stylesheets, because
 *      it is a CSS bug that no amount of route testing would catch.
 *   5. THE LABEL STILL SAYS WHY. Sharing the Paid colours must not cost the
 *      shopper the reason the order is held: the chip text stays
 *      'Awaiting stock / 等待补货'.
 *
 * The routes below are the REAL express routes, mounted and called over HTTP
 * against a real sqlite database, so what is printed is observed.
 */
'use strict';

const assert  = require('assert');
const fs      = require('fs');
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

// ── Fixtures ───────────────────────────────────────────────────────────────
// High ids, so a live database's own rows are never touched — and in a block
// no other suite has claimed. The shard shares ONE sqlite file and runs the
// files in sequence, so a fixture id is effectively global: 9731 was the first
// pick here and it is test_manual_restock_park.js's customer, whose admin
// fixture this suite's cleanup then swept out from under it. It failed only in
// the shard, never standalone. Check `grep -rhoE '9[0-9]{3}' scripts/test_*.js`
// before moving these.
const CUSTOMER = 9630;
const TOKEN    = 'paidbuckettesttoken9630';
// One order per status the buckets care about, so "no other chip widened" is
// asked of real rows rather than of the absence of them.
const ORDERS = [
  { id: 9631, no: 'PB-0001', status: 'paid',             placed: '2026-09-15 10:00:00' },
  { id: 9632, no: 'PB-0002', status: 'awaiting_restock', placed: '2026-09-15 11:00:00' },
  { id: 9633, no: 'PB-0003', status: 'preparing',        placed: '2026-09-15 12:00:00' },
  { id: 9634, no: 'PB-0004', status: 'pending_payment',  placed: '2026-09-15 13:00:00' },
];

function cleanup() {
  const ids = ORDERS.map(o => o.id);
  const ph  = ids.map(() => '?').join(',');
  try { db.prepare(`DELETE FROM retail_order_items WHERE order_id IN (${ph})`).run(...ids); } catch {}
  db.prepare(`DELETE FROM retail_orders     WHERE id IN (${ph})`).run(...ids);
  db.prepare('DELETE FROM retail_auth_tokens WHERE customer_id = ?').run(CUSTOMER);
  db.prepare('DELETE FROM retail_customers   WHERE id = ?').run(CUSTOMER);
}

function seed() {
  cleanup();
  db.prepare(
    `INSERT INTO retail_customers (id, nickname, phone, openid, is_blocked, lifetime_spend, points_balance)
     VALUES (?,?,?,?,0,0,0)`
  ).run(CUSTOMER, 'Paid Bucket Test', '13900000002', 'dev:paid-bucket');
  db.prepare(
    "INSERT INTO retail_auth_tokens (token, customer_id, expires_at) VALUES (?,?,datetime('now','+1 day'))"
  ).run(TOKEN, CUSTOMER);
  const ins = db.prepare(
    `INSERT INTO retail_orders (id, customer_id, order_no, status, total, payment_method, placed_at)
     VALUES (?,?,?,?,?,'wechat',?)`
  );
  for (const o of ORDERS) ins.run(o.id, CUSTOMER, o.no, o.status, 100, o.placed);
}

// ── The routes, mounted and called over HTTP ───────────────────────────────
const app = express();
app.use(router);
let PORT = 0;

const get = (p) => fetch(`http://127.0.0.1:${PORT}${p}`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

// Only this fixture's orders — a live database may hold others for other
// customers, and the auth scope is asserted elsewhere.
const nos = (body) => (body?.data || [])
  .filter(o => o.order_no.startsWith('PB-'))
  .map(o => o.order_no).sort();

(async () => {
  seed();
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;

  try {
    console.log('\nGET /api/retail/orders — the Paid chip\n');

    const paid = await get('/api/retail/orders?status=paid');
    it('lists the paid order AND the one parked on a restock', () => {
      assert.strictEqual(paid.status, 200);
      assert.deepStrictEqual(nos(paid.body), ['PB-0001', 'PB-0002']);
    });

    const preparing = await get('/api/retail/orders?status=preparing');
    it("'preparing' did not widen with it", () => {
      assert.deepStrictEqual(nos(preparing.body), ['PB-0003']);
    });

    const unpaid = await get('/api/retail/orders?status=pending_payment');
    it("'pending_payment' did not widen with it", () => {
      assert.deepStrictEqual(nos(unpaid.body), ['PB-0004']);
    });

    const all = await get('/api/retail/orders');
    it('All still shows every order', () => {
      assert.deepStrictEqual(nos(all.body), ['PB-0001', 'PB-0002', 'PB-0003', 'PB-0004']);
    });

    console.log('\nGET /api/retail/orders/stats — the Me-tab badges\n');

    const stats = (await get('/api/retail/orders/stats')).body?.data || {};
    it('the Paid badge counts the parked order — it opens the list above', () => {
      assert.strictEqual(stats.pending, nos(paid.body).length,
        `badge says ${stats.pending}, the Paid list holds ${nos(paid.body).length}`);
      assert.strictEqual(stats.pending, 2);
    });
    it('to_ship (paid + preparing) counts it too', () => {
      assert.strictEqual(stats.to_ship, 3);
    });
    it('the Unpaid badge is untouched', () => {
      assert.strictEqual(stats.unpaid, 1);
      assert.strictEqual(stats.preparing, 1);
    });

    console.log('\nThe mini app — the pill the shopper actually sees\n');

    for (const page of ['orders/orders', 'order/order']) {
      const css = fs.readFileSync(path.join(ROOT, 'miniapp', 'pages', `${page}.wxss`), 'utf8');
      it(`pages/${page}.wxss paints .status-awaiting_restock`, () => {
        assert.match(css, /\.status-awaiting_restock\s*[,{]/,
          'no rule — the pill falls through to the bare .status-pill and reads as no status');
      });
      it(`pages/${page}.wxss paints it the same as .status-paid`, () => {
        assert.match(css, /\.status-paid,\s*\n\.status-awaiting_restock\s*\{/,
          'the two must share one declaration, or they drift apart on the next palette change');
      });
    }

    const js = fs.readFileSync(path.join(ROOT, 'miniapp', 'pages', 'orders', 'orders.js'), 'utf8');
    it('the chip still tells the shopper WHY the order is held', () => {
      assert.match(js, /awaiting_restock:\s*'Awaiting stock'/);
      assert.match(js, /awaiting_restock:\s*'等待补货'/);
    });
  } finally {
    server.close();
    cleanup();
  }

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
