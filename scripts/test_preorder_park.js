#!/usr/bin/env node
/**
 * A shipped order holding a sold-out pre-order line waits where the office can
 * see it — 'awaiting_restock' — instead of joining the Paid queue.
 *
 *   node scripts/test_preorder_park.js
 *
 * The defect this locks down. A product on the 'backorder_gz' policy stays
 * orderable at zero stock for the shoppers we SHIP to (routes/retail.js →
 * effectiveOosPolicy; the local Guangzhou run is refused separately by
 * localPreorderLine). That is deliberate — it is what the PRE-ORDER pill and
 * the checkout "Ships soon" notice promise. But the order it produced was
 * indistinguishable from any other: requiresStockGate is false for a courier
 * order, so nothing reserved, markOrderPaid flipped it to 'paid', and
 * prepareCommitUnreservedOrder took the stock on the spot — pushing
 * physical_qty negative for an item that was not on any shelf. No status, no
 * chip, no queue said the order was waiting on a delivery. The office found
 * out by picking the order and not finding the item.
 *
 * The fix parks such an order exactly where the Guangzhou "wait for restock"
 * answer already parks: awaiting_restock_pids on the row, status
 * 'awaiting_restock' at payment, no stock taken, and
 * checkAwaitingRestockForRestock() promoting it to 'paid' the moment the
 * shipping store's count covers every line.
 *
 * Everything below runs against a REAL sqlite database and the REAL express
 * routes, mounted and called over HTTP — quote, order create, payment — so the
 * statuses printed are observed values, not reasoning about what should happen.
 * The fixture customer's tenant has no merchant credentials, so
 * /api/retail/payment/create takes its devMode branch and settles the order
 * through the same markOrderPaid() production uses.
 */
'use strict';

// Slot maths is local-time and production runs UTC+8 with no DST. Pin the zone
// BEFORE anything loads, or a UTC host reads the promised days wrong.
process.env.TZ = 'Asia/Shanghai';

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

// ── Fixtures ───────────────────────────────────────────────────────────────
// High ids so a live database's own rows are never touched, and clear of the
// 94xx/95xx/96xx block test_addon_stock_gate.js uses.
const STORE_WH  = 9801;         // the out-of-city shipper
const P_PRE     = 9811;         // sold out, policy 'backorder_gz' — the pre-order
const P_PRE2    = 9812;         // a second one, to prove every short pid is recorded
const P_SHELF   = 9813;         // plain pantry line, plenty on the shelf
const P_SUPPLIER = 9814;        // supplier-direct: no stock of ours, ever
const P_BUNDLE  = 9815;         // a bundle whose components include the pre-order
const ZONE_SH   = 9821;         // a Shanghai 'city' zone — courier, never same-day
const CUSTOMER  = 9831;
const ADDRESS   = 9841;
const TOKEN     = 'preorderparktesttoken9831';

const ADDR_SHANGHAI = {
  province: '上海市', city: '上海市', district: '静安区',
  address: '南京西路 1 号', detail: '1201',
};

function orderIds() {
  return db.prepare('SELECT id FROM retail_orders WHERE customer_id = ?').all(CUSTOMER).map(r => r.id);
}

function cleanup() {
  const oids = orderIds();
  if (oids.length) {
    const ph = oids.map(() => '?').join(',');
    // Every table carrying a foreign key to retail_orders, or the final DELETE
    // trips SQLITE_CONSTRAINT_FOREIGNKEY.
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
  const pids = [P_PRE, P_PRE2, P_SHELF, P_SUPPLIER, P_BUNDLE];
  const pph  = pids.map(() => '?').join(',');
  try { db.prepare('DELETE FROM retail_checkout_quotes WHERE customer_id = ?').run(CUSTOMER); } catch {}
  db.prepare('DELETE FROM retail_auth_tokens        WHERE customer_id = ?').run(CUSTOMER);
  db.prepare('DELETE FROM retail_customer_addresses WHERE customer_id = ?').run(CUSTOMER);
  db.prepare('DELETE FROM retail_customers          WHERE id = ?').run(CUSTOMER);
  db.prepare(`DELETE FROM retail_stock_ledger  WHERE product_id IN (${pph})`).run(...pids);
  db.prepare(`DELETE FROM retail_store_stock   WHERE product_id IN (${pph})`).run(...pids);
  db.prepare(`DELETE FROM store_products       WHERE id         IN (${pph})`).run(...pids);
  db.prepare('DELETE FROM retail_stores        WHERE id = ?').run(STORE_WH);
  db.prepare('DELETE FROM retail_delivery_zones WHERE id = ?').run(ZONE_SH);
}

function seed() {
  cleanup();

  db.prepare(
    `INSERT INTO retail_stores (id, code, name_en, name_cn, city, district, is_active, sort_order)
     VALUES (?,?,?,?,?,?,1,?)`
  ).run(STORE_WH, 'pp-wh', 'Warehouse', '仓库', '广州市', '天河区', 90);

  // A plain out-of-city zone, shaped like the real ones: day_only, so the
  // customer's pick is the Express "ship when ready" chip rather than a time
  // window, and no same-day. requiresStockGate is false for every order to it
  // — the relaxed courier path this change is about.
  db.prepare(
    `INSERT INTO retail_delivery_zones
       (id, zone_type, name_en, name_cn, match_city, base_fee, is_active, same_day_allowed, day_only, min_lead_days)
     VALUES (?, 'city', 'Shanghai', '上海', ?, 12, 1, 0, 1, 0)`
  ).run(ZONE_SH, '上海市');

  const prod = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, weight,
                                 is_batch_made, oos_policy, ship_from_supplier, is_published, is_active)
     VALUES (?,?,?,?,?,?,?,?,?,1,1)`
  );
  prod.run(P_PRE,      'Buckwheat Bread', '荞麦面包', 'pp-1', 49, '400g', 0, 'backorder_gz', 0);
  prod.run(P_PRE2,     'Rye Loaf',        '黑麦面包', 'pp-2', 45, '400g', 0, 'backorder_gz', 0);
  prod.run(P_SHELF,    'Peanut Butter',   '花生酱',   'pp-3', 83, '500g', 0, 'strict',       0);
  prod.run(P_SUPPLIER, 'Olive Oil',       '橄榄油',   'pp-4', 88, '500g', 0, null,           1);
  prod.run(P_BUNDLE,   'Breakfast Box',   '早餐礼盒', 'pp-5', 99, '900g', 0, 'backorder_gz', 0);
  db.prepare('UPDATE store_products SET bundle_items = ? WHERE id = ?')
    .run(JSON.stringify([{ id: P_PRE, qty: 1 }, { id: P_SHELF, qty: 1 }]), P_BUNDLE);

  db.prepare(
    `INSERT INTO retail_customers (id, nickname, phone, openid, is_blocked, lifetime_spend, points_balance)
     VALUES (?,?,?,?,0,0,0)`
  ).run(CUSTOMER, 'Preorder Park Test', '13900000001', 'dev:preorder-park');
  db.prepare(
    "INSERT INTO retail_auth_tokens (token, customer_id, expires_at) VALUES (?,?,datetime('now','+1 day'))"
  ).run(TOKEN, CUSTOMER);
  db.prepare(
    `INSERT INTO retail_customer_addresses
       (id, customer_id, recipient_name, phone, province, city, district, address, detail, is_default)
     VALUES (?,?,?,?,?,?,?,?,?,1)`
  ).run(ADDRESS, CUSTOMER, '测试收货人', '13900000001',
        ADDR_SHANGHAI.province, ADDR_SHANGHAI.city, ADDR_SHANGHAI.district,
        ADDR_SHANGHAI.address, ADDR_SHANGHAI.detail);

  // Stock at EVERY active store, so whichever one routing lands on has a real
  // row for each line — `exists` is one of the park guards, and the test must
  // exercise the policy rule rather than an accident of which shop won.
  // The two pre-order lines are at zero everywhere; the pantry line is deep.
  // The supplier line gets no row at all — that is what makes it supplier-direct.
  const stock = db.prepare(
    'INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer) VALUES (?,?,?,0)'
  );
  for (const s of db.prepare('SELECT id FROM retail_stores WHERE is_active = 1').all()) {
    stock.run(s.id, P_PRE,   0);
    stock.run(s.id, P_PRE2,  0);
    stock.run(s.id, P_SHELF, 40);
  }
}

// ── The routes, mounted and called over HTTP ───────────────────────────────
const app = express();
app.use(router);
let PORT = 0;

const call = (p, body) => fetch(`http://127.0.0.1:${PORT}${p}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

// Place an order the way the mini app does: quote first (which is also where
// the customer is shown the "Ships soon" pre-order notice), then create against
// a slot the server itself offered, then pay.
async function placeAndPay(items) {
  const quote = await call('/api/retail/checkout/quote', { address_id: ADDRESS, items });
  assert(quote.body?.success, `quote failed: ${JSON.stringify(quote.body)}`);
  // The Express chip — "ship when ready", the default an out-of-city shopper
  // gets and the one the reported order carried. Taken from the server's own
  // offer rather than hand-built, so the slot validator sees what it produced.
  const slot = quote.body.data.scheduling?.express_slot;
  assert(slot, 'no express slot offered for the out-of-city zone');

  const created = await call('/api/retail/orders', {
    address_id: ADDRESS, items, payment_method: 'wechat',
    delivery_mode: 'standard',
    delivery_slot_id: slot.slot_id, delivery_slot_kind: 'express', delivery_slot_label: slot.label_en,
  });
  if (!created.body?.success) return { created, quote, order: null };

  const orderId = created.body.data.order_id || created.body.data.id;
  const paid = await call('/api/retail/payment/create', { order_id: orderId });
  assert(paid.body?.success, `payment failed: ${JSON.stringify(paid.body)}`);
  return { created, quote, paid, order: loadOrder(orderId) };
}

function loadOrder(id) {
  return db.prepare(
    'SELECT id, order_no, status, store_id, awaiting_restock_pids, fallback_choice FROM retail_orders WHERE id = ?'
  ).get(id);
}
const shelf = (storeId, pid) =>
  db.prepare('SELECT physical_qty q FROM retail_store_stock WHERE store_id = ? AND product_id = ?')
    .get(storeId, pid)?.q ?? null;

// Put a product back to sold-out everywhere. Through adjustStock rather than a
// bare UPDATE so the row, the ledger and the restock hook all move as they do
// in production — and downwards, which never triggers a release.
function emptyShelves(pid) {
  for (const s of db.prepare('SELECT id FROM retail_stores WHERE is_active = 1').all()) {
    inventory.adjustStock({
      storeId: s.id, productId: pid, newPhysicalQty: 0,
      reason: 'adjust', note: 'test_preorder_park reset',
    });
  }
}

(async () => {
  seed();
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;

  try {
    console.log('\n── A sold-out pre-order line on a courier order');
    const a = await placeAndPay([{ product_id: P_PRE, qty: 1 }, { product_id: P_SHELF, qty: 1 }]);
    assert(a.order, `order refused: ${JSON.stringify(a.created.body)}`);
    console.log(`   order ${a.order.order_no} → status '${a.order.status}', pids ${a.order.awaiting_restock_pids}`);

    it('the order is accepted (backorder_gz is orderable for shoppers we ship to)',
      () => assert.strictEqual(a.created.status, 200));
    it("it parks in 'awaiting_restock', not 'paid'",
      () => assert.strictEqual(a.order.status, 'awaiting_restock'));
    it('the sold-out product is recorded as what it waits on',
      () => assert.deepStrictEqual(JSON.parse(a.order.awaiting_restock_pids), [P_PRE]));
    it('no fallback_choice — no modal preceded this, unlike the Guangzhou wait flow',
      () => assert.strictEqual(a.order.fallback_choice, null));
    it('no stock is taken while it waits (the in-stock line stays on the shelf)',
      () => assert.strictEqual(shelf(a.order.store_id, P_SHELF), 40));
    it('the sold-out line is not driven negative',
      () => assert.strictEqual(shelf(a.order.store_id, P_PRE), 0));

    console.log('\n── The restock arrives');
    inventory.adjustStock({
      storeId: a.order.store_id, productId: P_PRE, deltaQty: 6,
      reason: 'purchase_receipt', note: 'test_preorder_park',
    });
    const released = loadOrder(a.order.id);
    console.log(`   after +6 → status '${released.status}', shelf ${shelf(a.order.store_id, P_PRE)}`);

    it("it promotes itself to 'paid'",
      () => assert.strictEqual(released.status, 'paid'));
    it('and takes its stock on the way through',
      () => assert.strictEqual(shelf(a.order.store_id, P_PRE), 5));
    it('the rest of the order is deducted too',
      () => assert.strictEqual(shelf(a.order.store_id, P_SHELF), 39));
    it('the release is on the ledger, linked to the order', () => {
      const row = db.prepare(
        `SELECT reason, delta FROM retail_stock_ledger
          WHERE ref_table = 'retail_orders' AND ref_id = ? AND product_id = ?`
      ).get(a.order.id, P_PRE);
      assert.strictEqual(row?.reason, 'awaiting_restock_release');
      assert.strictEqual(row?.delta, -1);
    });

    console.log('\n── Controls');
    const b = await placeAndPay([{ product_id: P_SHELF, qty: 1 }]);
    it("an order with nothing short still goes straight to 'paid'", () => {
      assert(b.order, `order refused: ${JSON.stringify(b.created.body)}`);
      assert.strictEqual(b.order.status, 'paid');
      assert.strictEqual(b.order.awaiting_restock_pids, null);
    });

    // A supplier-direct line has no stock row and never will, so an order
    // carrying one could never satisfy the promotion's availability check.
    // Parking it would be parking it forever — it must stay paid.
    //
    // The reset is what makes this control mean anything: P_PRE went back on
    // the shelf in the restock above, and a control that is not short does not
    // test a guard against parking. Every active store, since routing picks
    // the shop, not this test.
    emptyShelves(P_PRE);
    const c = await placeAndPay([{ product_id: P_PRE, qty: 1 }, { product_id: P_SUPPLIER, qty: 1 }]);
    it('an order carrying an untracked (supplier-direct) line is NOT parked', () => {
      assert(c.order, `order refused: ${JSON.stringify(c.created.body)}`);
      assert.strictEqual(c.order.status, 'paid');
      assert.strictEqual(c.order.awaiting_restock_pids, null);
    });

    // A bundle line stores the bundle's OWN id on retail_order_items, and that
    // id has no stock row — so the release check would ask after a count that
    // does not exist and never pass. Parked, this order would never come back.
    emptyShelves(P_PRE);
    const e = await placeAndPay([{ product_id: P_BUNDLE, qty: 1 }]);
    it('an order carrying a bundle is NOT parked', () => {
      assert(e.order, `order refused: ${JSON.stringify(e.created.body)}`);
      assert.strictEqual(e.order.status, 'paid');
      assert.strictEqual(e.order.awaiting_restock_pids, null);
    });

    // Two short lines: both must be recorded, or the promotion releases the
    // order while the second one is still missing.
    emptyShelves(P_PRE);
    const d = await placeAndPay([{ product_id: P_PRE2, qty: 2 }, { product_id: P_PRE, qty: 1 }]);
    it('every short line is recorded, not just the first', () => {
      assert(d.order, `order refused: ${JSON.stringify(d.created.body)}`);
      assert.strictEqual(d.order.status, 'awaiting_restock');
      assert.deepStrictEqual(JSON.parse(d.order.awaiting_restock_pids).sort(), [P_PRE, P_PRE2].sort());
    });

    it('a partial restock does NOT release it — the other line is still missing', () => {
      inventory.adjustStock({
        storeId: d.order.store_id, productId: P_PRE2, deltaQty: 2,
        reason: 'purchase_receipt', note: 'test_preorder_park',
      });
      assert.strictEqual(loadOrder(d.order.id).status, 'awaiting_restock');
    });
    it('the last missing line releases it', () => {
      inventory.adjustStock({
        storeId: d.order.store_id, productId: P_PRE, deltaQty: 1,
        reason: 'purchase_receipt', note: 'test_preorder_park',
      });
      assert.strictEqual(loadOrder(d.order.id).status, 'paid');
    });
  } finally {
    server.close();
    cleanup();
  }

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
