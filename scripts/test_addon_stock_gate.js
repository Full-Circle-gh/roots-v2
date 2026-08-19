#!/usr/bin/env node
/**
 * An add-on must clear the same out-of-stock rules a fresh order clears —
 * BEFORE the customer is charged.
 *
 *   node scripts/test_addon_stock_gate.js
 *   node scripts/test_addon_stock_gate.js --baseline   (vs routes/_baseline_retail.js)
 *
 * The defect this locks down: POST /orders/:id/addon/create hung its stock gate
 * on orderTracksStock() — "does this order hold committed reservations?".
 * Orders created with the stock gate off never reserve (see the create-order
 * path: `if (!isWaitFlow && stockGate)`), and that is every out-of-city order,
 * every far-district scheduled order and every core-GZ scheduled one. For all of
 * them the gate was skipped whole, and the first stock check on the path ran
 * inside finalizeOrderAddon — after the WeChat charge, where its own comment
 * says it "can do nothing but warn".
 *
 * Everything here runs against a REAL sqlite database and the REAL express
 * route, mounted and called over HTTP, so the statuses and bodies printed are
 * observed values rather than reasoning about what the code should do.
 *
 * WHAT "charge initiated" MEANS HERE, precisely: the route stages the charge by
 * INSERTing a retail_order_addons row (status 'pending', carrying an
 * out_trade_no) and only then hands off to the WeChat gateway. The fixture
 * customer carries a `dev:` openid, so the handoff stops one line later at
 * 'no_real_openid' — no gateway call, no finalize, no stock movement, no WeCom
 * ping, no printer. That staged row is therefore the faithful, side-effect-free
 * marker of "money started moving": in production the same row is followed by a
 * real prepay and a real charge. A refusal that lands before any money moves
 * leaves NO row at all.
 */
'use strict';

// All the slot maths is local-time and production runs UTC+8 with no DST. Pin
// the zone BEFORE anything loads, or a UTC host reads the promised days wrong.
process.env.TZ = 'Asia/Shanghai';

const assert  = require('assert');
const path    = require('path');
const express = require('express');

const ROOT     = path.join(__dirname, '..');
const BASELINE = process.argv.includes('--baseline');
const RETAIL   = BASELINE
  ? path.join(ROOT, 'routes', '_baseline_retail.js')
  : path.join(ROOT, 'routes', 'retail.js');

require(path.join(ROOT, 'database.js'));
const { tdb }   = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const inventory = require(path.join(ROOT, 'lib', 'inventory.js'));
const router    = require(RETAIL);
const db = tdb();

// ── Fixtures ───────────────────────────────────────────────────────────────
// High ids so a live database's own rows are never touched, and clear of
// test_batch_timing.js's 91xx/92xx/93xx block.
const STORE_LOCAL = 9401;   // an inner-GZ shop (the local run)
const STORE_WH    = 9402;   // the out-of-city shipper
const P_BATCH     = 9501;   // batch-made, no stored policy ⇒ effective 'backorder_gz'
const P_STRICT    = 9502;   // batch-made but pinned 'strict' — never orderable at zero
const P_STOCKED   = 9503;   // plain pantry line, plenty on the shelf
const CUSTOMER    = 9601;
const TOKEN       = 'addonstockgatetesttoken9601';

const ORDERS = {
  a:  9701,   // out-of-city (Shanghai), express
  a2: 9702,   // out-of-city (Shanghai), express — the strict SKU
  b:  9703,   // core GZ (天河区), scheduled for a future day
  c:  9704,   // far district (opt-in same-day), scheduled
  d:  9705,   // out-of-city, and the line added IS in stock
  e:  9706,   // an order that DOES hold a committed reservation
};

const ADDR_SHANGHAI = { province: '上海市', city: '上海市', district: '静安区', address: '南京西路 1 号' };
const ADDR_GZ_CORE  = { province: '广东省', city: '广州市', district: '天河区', address: '天河路 1 号' };
let   ADDR_GZ_FAR   = null;   // resolved from the live zone table below

// The far-district scenario is only meaningful against a district the live zone
// table really flags as opt-in same-day (day_only=1, or a same-day surcharge).
// Pick one rather than inventing a name the matcher would not recognise.
function resolveFarDistrict() {
  const rows = db.prepare(
    `SELECT match_district FROM retail_delivery_zones
      WHERE is_active = 1 AND zone_type = 'gz_district' AND match_district IS NOT NULL
        AND (day_only = 1 OR same_day_surcharge > 0)`
  ).all();
  for (const r of rows) {
    const addr = { province: '广东省', city: '广州市', district: r.match_district, address: '测试路 1 号' };
    if (inventory.isOptInSameDayDistrict(addr)) return addr;
  }
  return null;
}

function cleanup() {
  const oids = Object.values(ORDERS);
  const ph   = oids.map(() => '?').join(',');
  // Every table carrying a foreign key to retail_orders, or the final DELETE
  // trips SQLITE_CONSTRAINT_FOREIGNKEY — a settled add-on also writes points.
  for (const t of ['retail_order_addons', 'retail_order_items', 'retail_stock_reservations',
                   'retail_points_transactions', 'retail_payments', 'retail_shipments',
                   'retail_refund_events', 'retail_reviews', 'retail_referrals',
                   'retail_subscriptions', 'retail_lifetime_commissions', 'delivery_jobs',
                   'qingyun_push_queue']) {
    try { db.prepare(`DELETE FROM ${t} WHERE order_id IN (${ph})`).run(...oids); } catch {}
  }
  db.prepare(`DELETE FROM retail_orders WHERE id IN (${ph})`).run(...oids);
  db.prepare('DELETE FROM retail_auth_tokens WHERE customer_id = ?').run(CUSTOMER);
  db.prepare('DELETE FROM retail_customers   WHERE id = ?').run(CUSTOMER);
  db.prepare('DELETE FROM retail_store_stock WHERE product_id IN (?,?,?)').run(P_BATCH, P_STRICT, P_STOCKED);
  db.prepare('DELETE FROM store_products     WHERE id         IN (?,?,?)').run(P_BATCH, P_STRICT, P_STOCKED);
  db.prepare('DELETE FROM retail_stores      WHERE id         IN (?,?)').run(STORE_LOCAL, STORE_WH);
}

// A Guangzhou day N days from now, 'YYYY-MM-DD 10:00:00'.
function gzDayOffset(n) {
  const t = new Date(Date.now() + n * 86400000);
  const p = x => String(x).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} 10:00:00`;
}

function seed() {
  cleanup();

  const store = db.prepare(
    `INSERT INTO retail_stores (id, code, name_en, name_cn, city, district, is_active, sort_order)
     VALUES (?,?,?,?,?,?,1,?)`
  );
  store.run(STORE_LOCAL, 'asg-local', 'Local Shop', '本地店', '广州市', '天河区', 1);
  store.run(STORE_WH,    'asg-wh',    'Warehouse',  '仓库',   '广州市', '白云区', 2);

  const prod = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, weight,
                                 is_batch_made, oos_policy, is_published, is_active)
     VALUES (?,?,?,?,?,?,?,?,1,1)`
  );
  prod.run(P_BATCH,   'Pesto Wrap', '青酱卷', 'asg-1', 48, '250g', 1, null);
  prod.run(P_STRICT,  'Miso Bowl',  '味噌碗', 'asg-2', 52, '300g', 1, 'strict');
  prod.run(P_STOCKED, 'Olive Oil',  '橄榄油', 'asg-3', 88, '500g', 0, 'strict');

  db.prepare(
    `INSERT INTO retail_customers (id, nickname, phone, openid, is_blocked, lifetime_spend, points_balance)
     VALUES (?,?,?,?,0,0,0)`
  ).run(CUSTOMER, 'Addon Gate Test', '13900000000', 'dev:addon-stock-gate');
  db.prepare(
    "INSERT INTO retail_auth_tokens (token, customer_id, expires_at) VALUES (?,?,datetime('now','+1 day'))"
  ).run(TOKEN, CUSTOMER);

  const order = db.prepare(
    `INSERT INTO retail_orders (id, order_no, customer_id, status, store_id, address_json,
                                fulfillment_type, subtotal, shipping_fee, same_day_surcharge_fee,
                                total, delivery_mode, delivery_slot_kind, scheduled_for, channel, paid_at)
     VALUES (?,?,?,'paid',?,?,'delivery',?,0,0,?,'standard',?,?,'wechat',CURRENT_TIMESTAMP)`
  );
  const mk = (id, storeId, addr, kind, sched) =>
    order.run(id, `ASG${id}`, CUSTOMER, storeId, JSON.stringify(addr), 100, 100, kind, sched);

  mk(ORDERS.a,  STORE_WH,    ADDR_SHANGHAI, 'express',    gzDayOffset(3));
  mk(ORDERS.a2, STORE_WH,    ADDR_SHANGHAI, 'express',    gzDayOffset(3));
  mk(ORDERS.b,  STORE_LOCAL, ADDR_GZ_CORE,  'schedule',   gzDayOffset(3));
  mk(ORDERS.c,  STORE_WH,    ADDR_GZ_FAR,   'schedule',   gzDayOffset(3));
  mk(ORDERS.d,  STORE_WH,    ADDR_SHANGHAI, 'express',    gzDayOffset(3));
  // (e) is the control: a same-day core-GZ order that DID reserve at checkout,
  // so orderTracksStock() is true for it and the gate fired even before.
  mk(ORDERS.e,  STORE_LOCAL, ADDR_GZ_CORE,  'right_away', null);
  db.prepare(
    `INSERT INTO retail_stock_reservations (order_id, store_id, product_id, qty, status, channel,
                                            expires_at, committed_at)
     VALUES (?,?,?,?,'committed','wechat', datetime('now','+30 day'), CURRENT_TIMESTAMP)`
  ).run(ORDERS.e, STORE_LOCAL, P_STOCKED, 1);

  // Stock: both sold-out lines are at ZERO on every shelf; the pantry line is
  // plentiful at both stores.
  const stock = db.prepare(
    `INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer)
     VALUES (?,?,?,0)`
  );
  for (const s of [STORE_LOCAL, STORE_WH]) {
    stock.run(s, P_BATCH,   0);
    stock.run(s, P_STRICT,  0);
    stock.run(s, P_STOCKED, 25);
  }
}

// ── The route, mounted and called over HTTP ────────────────────────────────
const app = express();
app.use(router);

let PORT = 0;

function post(orderId, productId, qty = 1) {
  return fetch(`http://127.0.0.1:${PORT}/api/retail/orders/${orderId}/addon/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ items: [{ product_id: productId, qty }] }),
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
}

// The four things the brief asks to see for every scenario: is the addition
// admitted, is a charge initiated, what does the customer see, and did anything
// actually land on the order.
async function observe(label, orderId, productId) {
  const before = db.prepare('SELECT COUNT(*) n FROM retail_order_items WHERE order_id = ?').get(orderId).n;
  const shelfBefore = db.prepare(
    'SELECT COALESCE(SUM(physical_qty),0) n FROM retail_store_stock WHERE product_id = ?'
  ).get(productId).n;
  const r = await post(orderId, productId);
  const addon = db.prepare(
    'SELECT id, status, amount, out_trade_no FROM retail_order_addons WHERE order_id = ? ORDER BY id DESC LIMIT 1'
  ).get(orderId);
  const after = db.prepare('SELECT COUNT(*) n FROM retail_order_items WHERE order_id = ?').get(orderId).n;
  const shelfAfter = db.prepare(
    'SELECT COALESCE(SUM(physical_qty),0) n FROM retail_store_stock WHERE product_id = ?'
  ).get(productId).n;

  const shortages = r.body && Array.isArray(r.body.shortages) ? r.body.shortages : null;
  return {
    label,
    // 'no_real_openid' means the gate ADMITTED the line and the route got all
    // the way to the gateway handoff — the fixture openid is what stopped it.
    admitted:         r.status < 400 || r.body?.error === 'no_real_openid',
    http_status:      r.status,
    error:            r.body?.error || '(none)',
    charge_initiated: !!addon,
    staged_row:       addon ? `#${addon.id} ${addon.status} ¥${addon.amount} ${addon.out_trade_no}` : '(none)',
    shortages:        shortages
      ? shortages.map(s => `${s.name_en || s.product_id} requested ${s.requested}, available ${s.available}`).join('; ')
      : '(none)',
    items_added:      after - before,
    shelf_moved:      `${shelfBefore} → ${shelfAfter}`,
  };
}

function show(o) {
  console.log(`\n── ${o.label}`);
  for (const [k, v] of Object.entries(o)) {
    if (k === 'label') continue;
    console.log(`   ${String(k).padEnd(18)} ${v === null ? '(null)' : v}`);
  }
}

let pass = 0, fail = 0;
function check(name, fn) {
  if (BASELINE) return;                        // baseline is observed, never asserted
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

(async () => {
  ADDR_GZ_FAR = resolveFarDistrict();
  if (!ADDR_GZ_FAR) {
    console.error('No opt-in same-day GZ district in retail_delivery_zones — (c) cannot be observed.');
    process.exit(2);
  }
  seed();

  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;

  console.log(`\n${BASELINE ? 'BASELINE (routes/_baseline_retail.js)' : 'CURRENT (routes/retail.js)'}`);
  console.log(`far district under test: ${ADDR_GZ_FAR.district}`);

  const R = {};
  R.a  = await observe('(a)  out-of-city order + batch-made SKU (backorder_gz) at ZERO', ORDERS.a,  P_BATCH);
  R.a2 = await observe('(a2) out-of-city order + batch-made SKU pinned STRICT at ZERO',  ORDERS.a2, P_STRICT);
  R.b  = await observe('(b)  core-GZ scheduled order + sold-out backorder_gz line',      ORDERS.b,  P_BATCH);
  R.c  = await observe('(c)  far-district scheduled order + sold-out backorder_gz line', ORDERS.c,  P_BATCH);
  R.d  = await observe('(d)  out-of-city order + a line that IS in stock',               ORDERS.d,  P_STOCKED);
  R.e  = await observe('(e)  order holding a COMMITTED reservation + sold-out line',     ORDERS.e,  P_BATCH);
  for (const k of Object.keys(R)) show(R[k]);

  console.log('\n── Assertions');
  // The carve-outs, asserted rather than merely observed. An add-on must clear
  // the rules a FRESH order clears -- no more and no less -- so a line the same
  // customer could pre-order at checkout must stay addable here. Checkout says
  // it plainly at its own hard-OOS gate: "'backorder_gz' products are
  // deliberately exempt (out-of-city pre-order is the whole point)", and the
  // ship-district carve-out is that same rule for a Guangzhou parcel that
  // leaves on the batch cadence. If either of these ever flips to a refusal,
  // this seam has drifted STRICTER than the checkout it exists to mirror.
  check('(a) an out-of-city order may still pre-order a sold-out backorder_gz line', () => {
    assert.strictEqual(R.a.admitted, true, 'out-of-city pre-order is the whole point of the policy');
    assert.strictEqual(R.a.http_status, 200);
  });
  check('(c) a far-district SCHEDULED order keeps that same pre-order right', () => {
    assert.strictEqual(R.c.admitted, true, 'this parcel leaves on the batch cadence, like an out-of-city one');
    assert.strictEqual(R.c.http_status, 200);
  });
  check('(a2) a strict sold-out SKU is refused before any charge, on an order that never reserved', () => {
    assert.strictEqual(R.a2.http_status, 409);
    assert.strictEqual(R.a2.error, 'insufficient_stock');
    assert.strictEqual(R.a2.charge_initiated, false, 'a refusal must leave no staged charge');
  });
  check('(b) a core-GZ scheduled order may not pre-order a sold-out backorder_gz line', () => {
    assert.strictEqual(R.b.http_status, 409);
    assert.strictEqual(R.b.error, 'insufficient_stock');
    assert.strictEqual(R.b.charge_initiated, false);
  });
  check('(b) the refusal names the item, so the picker can render a real sentence', () => {
    assert.match(R.b.shortages, /Pesto Wrap/);
  });
  check('(d) an in-stock line is still admitted and staged', () => {
    assert.strictEqual(R.d.admitted, true);
    assert.strictEqual(R.d.charge_initiated, true, 'an admitted add-on must stage its charge');
  });
  check('(e) an order that DOES hold reservations still refuses a sold-out line', () => {
    assert.strictEqual(R.e.http_status, 409);
    assert.strictEqual(R.e.error, 'insufficient_stock');
    assert.strictEqual(R.e.charge_initiated, false);
  });

  cleanup();
  server.close();
  if (!BASELINE) console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { cleanup(); } catch {} process.exit(1); });
