#!/usr/bin/env node
/**
 * An off-sale product left in an old cart does not block the rest of the order.
 *
 *   node scripts/test_checkout_unavailable_item.js
 *
 * The cart lives on the phone. Dried Sour Mango was added, then taken off sale
 * (unpublished, or switched off). Checkout used to refuse the WHOLE quote with
 * product_unavailable, which the mini app showed as "Couldn't load delivery
 * times". The other lines were fine. The quote now prices those lines and
 * names the one that has to come out. Placing the order drops that line and
 * takes the rest. An order that is nothing but off-sale lines is still refused.
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

let pass = 0;
const it = (label, fn) => { fn(); pass++; console.log('  ok  ' + label); };

const P_BREAD = 9741;
const P_MANGO = 9742;   // unpublished — "not for sale"
const P_OFF   = 9743;   // is_active = 0 — switched off
const CUSTOMER = 9746;
const ADDRESS  = 9747;
const TOKEN    = 'checkoutunavailable9746';
const ZONE     = 9748;

function cleanup() {
  const oids = db.prepare('SELECT id FROM retail_orders WHERE customer_id = ?').all(CUSTOMER).map(r => r.id);
  if (oids.length) {
    const ph = oids.map(() => '?').join(',');
    for (const t of ['retail_order_items', 'retail_payments', 'retail_shipments']) {
      try { db.prepare(`DELETE FROM ${t} WHERE order_id IN (${ph})`).run(...oids); } catch { /* optional */ }
    }
    db.prepare(`DELETE FROM retail_orders WHERE id IN (${ph})`).run(...oids);
  }
  const pids = [P_BREAD, P_MANGO, P_OFF];
  const pph = pids.map(() => '?').join(',');
  try { db.prepare('DELETE FROM retail_checkout_quotes WHERE customer_id = ?').run(CUSTOMER); } catch { /* optional */ }
  db.prepare('DELETE FROM retail_auth_tokens        WHERE customer_id = ?').run(CUSTOMER);
  db.prepare('DELETE FROM retail_customer_addresses WHERE customer_id = ?').run(CUSTOMER);
  db.prepare('DELETE FROM retail_customers          WHERE id = ?').run(CUSTOMER);
  try { db.prepare(`DELETE FROM retail_store_stock WHERE product_id IN (${pph})`).run(...pids); } catch { /* optional */ }
  db.prepare(`DELETE FROM store_products WHERE id IN (${pph})`).run(...pids);
  db.prepare('DELETE FROM retail_delivery_zones WHERE id = ?').run(ZONE);
}

function seed() {
  cleanup();
  db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, weight, is_active, is_published, oos_policy)
     VALUES (?,?,?,?,?,?,?,?, 'strict')`
  ).run(P_BREAD, 'Buckwheat Bread', '荞麦面包', 'unav-1', 15, '300g', 1, 1);
  db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, weight, is_active, is_published, oos_policy)
     VALUES (?,?,?,?,?,?,?,?, 'strict')`
  ).run(P_MANGO, 'Dried Sour Mango', '酸芒果干', 'unav-2', 27, '120g', 1, 0);
  db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, weight, is_active, is_published, oos_policy)
     VALUES (?,?,?,?,?,?,?,?, 'strict')`
  ).run(P_OFF, 'Switched Off Spread', '已下架酱', 'unav-3', 12, '100g', 0, 1);

  db.prepare(
    `INSERT INTO retail_customers (id, nickname, phone, openid, is_blocked, lifetime_spend, points_balance)
     VALUES (?,?,?,?,0,0,0)`
  ).run(CUSTOMER, 'Unavailable Cart Test', '13900009746', 'dev:unavailable-cart');
  db.prepare(
    "INSERT INTO retail_auth_tokens (token, customer_id, expires_at) VALUES (?,?,datetime('now','+1 day'))"
  ).run(TOKEN, CUSTOMER);
  db.prepare(
    `INSERT INTO retail_customer_addresses
       (id, customer_id, recipient_name, phone, province, city, district, address, detail, is_default)
     VALUES (?,?,?,?,?,?,?,?,?,1)`
  ).run(ADDRESS, CUSTOMER, '测试收货人', '13900009746',
        '广东省', '广州市', '天河区', '天河路 1 号', '101');
  db.prepare(
    `INSERT INTO retail_delivery_zones
       (id, zone_type, name_en, name_cn, match_city, base_fee, is_active, same_day_allowed, day_only, min_lead_days)
     VALUES (?, 'city', 'Suzhou', '苏州', ?, 12, 1, 0, 1, 0)`
  ).run(ZONE, '苏州市');
}

const app = express();
app.use(router);
let PORT = 0;

const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };

function quote(items) {
  return fetch(`http://127.0.0.1:${PORT}/api/retail/checkout/quote`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      address: { province: '江苏省', city: '苏州市', district: '姑苏区' },
      delivery_mode: 'standard',
      payment_method: 'wechat',
      items,
    }),
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
}

function cartPrice(items) {
  return fetch(`http://127.0.0.1:${PORT}/api/retail/cart/price`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ items }),
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
}

function order(items) {
  return fetch(`http://127.0.0.1:${PORT}/api/retail/orders`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      address_id: ADDRESS,
      payment_method: 'wechat',
      delivery_slot_id: 'right_away',
      items,
    }),
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
}

(async () => {
  seed();
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;

  try {
    console.log('\nA · the mango is off sale, the bread is not');

    const mixed = await quote([
      { product_id: P_BREAD, qty: 1 },
      { product_id: P_MANGO, qty: 1 },
      { product_id: P_OFF, qty: 1 },
    ]);
    it('the quote succeeds and prices only what is still for sale', () => {
      assert.strictEqual(mixed.status, 200, JSON.stringify(mixed.body));
      assert.strictEqual(mixed.body.success, true);
      assert.strictEqual(mixed.body.data.subtotal, 15);
      assert.deepStrictEqual(mixed.body.data.lines.map(l => l.product_id), [P_BREAD]);
    });
    it('it names the lines that have to come out of the cart', () => {
      const gone = mixed.body.data.unavailable || [];
      const ids = gone.map(g => g.product_id).sort();
      assert.deepStrictEqual(ids, [P_MANGO, P_OFF]);
      const mango = gone.find(g => g.product_id === P_MANGO);
      assert.strictEqual(mango.name_en, 'Dried Sour Mango');
      assert.strictEqual(mango.name_cn, '酸芒果干');
    });

    const onlyMango = await quote([{ product_id: P_MANGO, qty: 1 }]);
    it('a cart of only the off-sale line is still refused, and still named', () => {
      assert.strictEqual(onlyMango.status, 400);
      assert.strictEqual(onlyMango.body.error, 'product_unavailable');
      assert.strictEqual(onlyMango.body.unavailable[0].name_en, 'Dried Sour Mango');
    });

    const priced = await cartPrice([
      { product_id: P_BREAD, qty: 1 },
      { product_id: P_MANGO, qty: 1 },
    ]);
    it('the cart page gets the same split, so it can remove the line before checkout', () => {
      assert.strictEqual(priced.status, 200, JSON.stringify(priced.body));
      assert.strictEqual(priced.body.data.subtotal, 15);
      assert.strictEqual(priced.body.data.unavailable[0].product_id, P_MANGO);
    });

    console.log('\nB · placing the order drops the off-sale line instead of refusing the basket');

    const onlyGone = await order([{ product_id: P_MANGO, qty: 1 }]);
    it('an order of only the off-sale line is still refused, and still named', () => {
      assert.strictEqual(onlyGone.status, 400, JSON.stringify(onlyGone.body));
      assert.strictEqual(onlyGone.body.error, 'product_unavailable');
      assert.strictEqual(onlyGone.body.product_id, P_MANGO);
      assert.strictEqual(onlyGone.body.name_en, 'Dried Sour Mango');
    });

    const placed = await order([
      { product_id: P_BREAD, qty: 1 },
      { product_id: P_MANGO, qty: 1 },
    ]);
    it('the bread is not refused because the mango is in the same cart', () => {
      assert.notStrictEqual(placed.body && placed.body.error, 'product_unavailable',
        JSON.stringify(placed.body));
      if (!(placed.body && placed.body.success)) {
        console.log('    (stopped later at ' + (placed.body && placed.body.error) + ', after the mango was no longer the reason)');
      }
      const orderId = placed.body && placed.body.data && (placed.body.data.id || placed.body.data.order_id);
      if (placed.body && placed.body.success && orderId) {
        const lines = db.prepare(
          'SELECT product_id FROM retail_order_items WHERE order_id = ?'
        ).all(orderId);
        assert.ok(lines.some(l => l.product_id === P_BREAD), 'the bread was not written');
        assert.ok(!lines.some(l => l.product_id === P_MANGO), 'the off-sale mango was written onto the order');
      }
    });

    console.log('\n' + pass + ' passed');
  } finally {
    server.close();
    cleanup();
  }
})().catch((e) => {
  console.error(e);
  try { cleanup(); } catch { /* already failing */ }
  process.exit(1);
});
