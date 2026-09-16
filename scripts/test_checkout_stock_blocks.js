#!/usr/bin/env node
/**
 * The checkout says WHICH lines are sold out, and says it before the customer pays.
 *
 *   node scripts/test_checkout_stock_blocks.js
 *
 * THE DEFECT THIS LOCKS DOWN, as reported by a customer on 2026-09-16:
 *
 *   "Falafel Wrap is out of stock"  →  delete it  →  "Tabbouleh Bowl is out of
 *   stock"  →  delete it  →  …
 *
 * POST /orders refuses a sold-out line at two gates (the hard out-of-stock gate
 * for a 'strict' policy, and the local pre-order gate for a Guangzhou shopper on
 * the local run). Both used `.find()`, so both named exactly ONE product.
 *
 * POST /checkout/quote ran NEITHER — priceCart selects neither oos_policy nor
 * real_stock, so the quote could not have answered the question if it had been
 * asked. The page therefore drew a priced cart and a live PLACE ORDER over a
 * cart the order endpoint had already decided to refuse. The customer met the
 * refusal as a toast naming one item, removed it, and met the next one. The
 * number of round trips was the number of sold-out lines, and none of them ever
 * said so.
 *
 * So the assertions below are about AGREEMENT and COMPLETENESS, in that order:
 *   1. the quote prices the cart (it must never start refusing — a failed quote
 *      makes the client fall back to a local subtotal and re-arm the button);
 *   2. the quote names EVERY sold-out line, not the first;
 *   3. it names only the sold-out ones — an in-stock line is never listed;
 *   4. the order endpoint refuses the same cart, and its 409 carries the same
 *      list, so a race lands on the same screen as a quote;
 *   5. a cart with nothing sold out is listed as blocking nothing.
 *
 * Runs against a REAL sqlite database and the REAL express route, mounted and
 * called over HTTP, so every status and body printed is an observed value.
 */
'use strict';

const assert  = require('assert');
const path    = require('path');
const express = require('express');

const ROOT   = path.join(__dirname, '..');
const RETAIL = path.join(ROOT, 'routes', 'retail.js');

require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const router  = require(RETAIL);
const db = tdb();

// ── Fixtures ───────────────────────────────────────────────────────────────
// High ids, clear of the 94xx/95xx/96xx block test_addon_stock_gate.js uses.
const STORE     = 9421;
const P_OUT_A   = 9521;   // plain line, default policy ⇒ 'strict', shelf at ZERO
const P_OUT_B   = 9522;   // a second one, so "names every line" is observable
const P_IN      = 9523;   // plenty on the shelf — the control
const P_SUPPLIER = 9524;  // supplier-direct at ZERO — 'always', never blocked
const CUSTOMER  = 9621;
const ADDRESS   = 9721;
const TOKEN     = 'checkoutstockblockstesttoken9621';

// The district is resolved from the LIVE zone table rather than hard-coded: a
// quote for an address no zone matches returns no_zone_match and never reaches
// the body this suite reads. Any active Guangzhou district will do — the hard
// out-of-stock gate under test refuses a 'strict' line in every region, so which
// district it is changes nothing about the assertions.
let ADDR_GZ = null;
function resolveGzDistrict() {
  const row = db.prepare(
    `SELECT match_district FROM retail_delivery_zones
      WHERE is_active = 1 AND zone_type = 'gz_district' AND match_district IS NOT NULL
      ORDER BY id ASC LIMIT 1`
  ).get();
  if (!row) return null;
  return {
    province: '广东省', city: '广州市', district: row.match_district,
    address: '测试路 1 号', detail: '101',
  };
}

// EACH DELETE IS INDEPENDENTLY GUARDED, and that is not defensive noise — it is
// this suite's own scar. An early draft died inside seed() on a column name, one
// statement after inserting the customer and its auth token. The rows survived,
// and the NEXT full shard run failed a suite fourteen files away with a bare
// "Not authenticated" that pointed at nothing. A test that pollutes the shared
// database costs more than it is worth, so a cleanup that gets part-way through
// must still finish the rest.
function cleanup() {
  const wipe = (sql, ...args) => {
    try { db.prepare(sql).run(...args); } catch (e) { console.warn(`[cleanup] ${e.message}`); }
  };
  wipe('DELETE FROM retail_auth_tokens        WHERE customer_id = ?', CUSTOMER);
  wipe('DELETE FROM retail_customer_addresses WHERE id  = ?', ADDRESS);
  wipe('DELETE FROM retail_customers          WHERE id  = ?', CUSTOMER);
  wipe('DELETE FROM retail_store_stock WHERE product_id IN (?,?,?,?)', P_OUT_A, P_OUT_B, P_IN, P_SUPPLIER);
  wipe('DELETE FROM store_products     WHERE id         IN (?,?,?,?)', P_OUT_A, P_OUT_B, P_IN, P_SUPPLIER);
  wipe('DELETE FROM retail_stores      WHERE id          = ?', STORE);
}

function seed() {
  cleanup();

  db.prepare(
    `INSERT INTO retail_stores (id, code, name_en, name_cn, city, district, is_active, sort_order)
     VALUES (?,?,?,?,?,?,1,?)`
  ).run(STORE, 'csb-local', 'Local Shop', '本地店', '广州市', '天河区', 1);

  // No stored oos_policy and not batch-made ⇒ effectiveOosPolicy is 'strict',
  // the default, which is what the two reported items resolve to.
  const prod = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, weight,
                                 is_batch_made, oos_policy, is_published, is_active)
     VALUES (?,?,?,?,?,?,0,NULL,1,1)`
  );
  prod.run(P_OUT_A, 'Falafel Wrap',  '法拉费卷', 'csb-1', 44, '250g');
  prod.run(P_OUT_B, 'Tabbouleh Bowl', '塔布勒碗', 'csb-2', 44, '300g');
  prod.run(P_IN,    'Rolled Oats',    '燕麦片',   'csb-3', 68, '500g');
  // Supplier-direct: effectiveOosPolicy returns 'always' regardless of the
  // shelf, because the supplier is the source of truth and we hold none of it.
  // At ZERO stock, exactly like the two blocked lines — so if this one ever
  // appears in the list, the gate has started reading the shelf instead of the
  // policy, and customers are being told to remove things they can buy.
  db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, weight,
                                 is_batch_made, oos_policy, ship_from_supplier, is_published, is_active)
     VALUES (?,?,?,?,?,?,0,NULL,1,1,1)`
  ).run(P_SUPPLIER, 'Kara Coconut Cream', '椰浆', 'csb-4', 35, '200g');

  const stock = db.prepare(
    `INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer)
     VALUES (?,?,?,0)`
  );
  stock.run(STORE, P_OUT_A, 0);
  stock.run(STORE, P_OUT_B, 0);
  stock.run(STORE, P_IN,   25);
  stock.run(STORE, P_SUPPLIER, 0);

  db.prepare(
    `INSERT INTO retail_customers (id, nickname, phone, openid, is_blocked, lifetime_spend, points_balance)
     VALUES (?,?,?,?,0,0,0)`
  ).run(CUSTOMER, 'Stock Blocks Test', '13900000021', 'dev:checkout-stock-blocks');
  db.prepare(
    "INSERT INTO retail_auth_tokens (token, customer_id, expires_at) VALUES (?,?,datetime('now','+1 day'))"
  ).run(TOKEN, CUSTOMER);
  db.prepare(
    `INSERT INTO retail_customer_addresses
       (id, customer_id, recipient_name, phone, province, city, district, address, detail, is_default)
     VALUES (?,?,?,?,?,?,?,?,?,1)`
  ).run(ADDRESS, CUSTOMER, 'Asher', '13900000021',
        ADDR_GZ.province, ADDR_GZ.city, ADDR_GZ.district, ADDR_GZ.address, ADDR_GZ.detail);
}

// ── The routes, mounted and called over HTTP ───────────────────────────────
const app = express();
app.use(router);
let PORT = 0;

function call(url, body) {
  return fetch(`http://127.0.0.1:${PORT}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
}

const quote = (items) => call('/api/retail/checkout/quote', {
  address_id: ADDRESS, items, delivery_mode: 'standard',
  payment_method: 'wechat', delivery_slot_id: 'right_away',
});
const order = (items) => call('/api/retail/orders', {
  address_id: ADDRESS, items, delivery_mode: 'standard',
  payment_method: 'wechat', delivery_slot_id: 'right_away',
});

const names = (list) => (Array.isArray(list) ? list : []).map(b => b.name_en).sort();

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

(async () => {
  ADDR_GZ = resolveGzDistrict();
  if (!ADDR_GZ) {
    console.error('No active gz_district in retail_delivery_zones — the quote would return no_zone_match.');
    process.exit(2);
  }
  seed();
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;

  // The reported cart: two sold-out lines and one that is fine.
  const CART_MIXED = [
    { product_id: P_IN,    qty: 4 },
    { product_id: P_OUT_A, qty: 1 },
    { product_id: P_OUT_B, qty: 1 },
    { product_id: P_SUPPLIER, qty: 2 },
  ];
  const CART_CLEAN = [{ product_id: P_IN, qty: 4 }];

  const qMixed = await quote(CART_MIXED);
  const qClean = await quote(CART_CLEAN);
  const oMixed = await order(CART_MIXED);

  const blocked = qMixed.body?.data?.blocked_items;
  console.log('\n── observed');
  console.log(`   quote(mixed)  http ${qMixed.status}  blocked_items ${JSON.stringify(names(blocked))}`);
  console.log(`   quote(clean)  http ${qClean.status}  blocked_items ${JSON.stringify(names(qClean.body?.data?.blocked_items))}`);
  console.log(`   order(mixed)  http ${oMixed.status}  error ${oMixed.body?.error}  blocked_items ${JSON.stringify(names(oMixed.body?.blocked_items))}`);
  console.log('');

  check('the quote still prices the cart — it reports, it never refuses', () => {
    assert.strictEqual(qMixed.status, 200, 'a 4xx here re-arms the button via applyQuoteFallback');
    assert.strictEqual(qMixed.body?.success, true);
    assert.ok(Number(qMixed.body?.data?.subtotal) > 0, 'a reporting quote still carries a price');
  });

  check('the quote names EVERY sold-out line, not just the first', () => {
    assert.deepStrictEqual(names(blocked), ['Falafel Wrap', 'Tabbouleh Bowl'],
      'naming one at a time is the reported defect: remove it, meet the next');
  });

  check('each blocked line carries what the customer needs to see', () => {
    const a = (blocked || []).find(b => b.product_id === P_OUT_A);
    assert.ok(a, 'the sold-out line must be in the list');
    assert.strictEqual(a.name_cn, '法拉费卷', 'both languages travel — the page renders either');
    assert.strictEqual(a.requested, 1);
    assert.strictEqual(a.available, 0);
    assert.strictEqual(a.reason, 'out_of_stock');
  });

  check('an in-stock line is never listed', () => {
    assert.ok(!(blocked || []).some(b => b.product_id === P_IN),
      'listing a line that is fine would have the customer remove it for nothing');
  });

  check('a supplier-direct line at ZERO is never listed — policy, not shelf', () => {
    assert.ok(!(blocked || []).some(b => b.product_id === P_SUPPLIER),
      'over-blocking tells a customer to remove something they could have bought');
  });

  check('a cart with nothing sold out blocks nothing', () => {
    assert.strictEqual(qClean.status, 200);
    assert.deepStrictEqual(qClean.body?.data?.blocked_items, [],
      'an empty list is what lifts the hold once the customer has removed them');
  });

  check('POST /orders refuses the same cart — the two still agree', () => {
    assert.strictEqual(oMixed.status, 409);
    assert.strictEqual(oMixed.body?.error, 'insufficient_stock');
  });

  check('the refusal carries the same list, so a race lands on the same screen', () => {
    assert.deepStrictEqual(names(oMixed.body?.blocked_items), ['Falafel Wrap', 'Tabbouleh Bowl']);
  });

  check('the refusal still names its one offender, unchanged', () => {
    assert.ok([P_OUT_A, P_OUT_B].includes(oMixed.body?.product_id),
      'the 409 shape every existing client reads must not move');
    assert.strictEqual(typeof oMixed.body?.available, 'number');
  });

  cleanup();
  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { cleanup(); } catch {} process.exit(1); });
