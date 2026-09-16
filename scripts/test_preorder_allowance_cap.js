#!/usr/bin/env node
/**
 * The mini app spends the same pre-order allowance the platforms spend.
 *
 *   node scripts/test_preorder_allowance_cap.js
 *
 * THE DEFECT THIS LOCKS DOWN. "How many to offer · 预订可售数量" caps what may be
 * sold against a batch that is not made yet. lib/channel-publish.js spends it
 * for Meituan, Eleme and gzgrocery — it publishes shelf + qty and no more.
 *
 * The mini app publishes nothing, so nothing capped it. A sold-out batch-made
 * line on a pre-order policy parked without limit and took no reservation, so
 * the shelf could not even show what had been promised: a batch of twenty could
 * be sold to sixty people, and the first anybody knew was the ready hour.
 *
 * The count that closes it is `parkedRestockDemand` — the demand already parked
 * against the batch, which is the one number the shelf cannot give, precisely
 * because a parked order holds nothing.
 *
 * WHAT IS ASSERTED, in order of what would hurt most if it broke:
 *   1. the order endpoint REFUSES past the allowance (the cap is real);
 *   2. the quote says so too, naming the line, so the page can hold the button
 *      instead of letting him find out at the pay sheet;
 *   3. it refuses at the right COUNT — allowance-1 is fine, allowance+1 is not;
 *   4. stock on the shelf is spent before the allowance, not alongside it;
 *   5. a blank allowance changes nothing, which is what makes this safe to ship
 *      to tenants who never filled the field in;
 *   6. a line that is NOT batch-made never spends it — channel-publish's rule.
 *
 * Runs against a REAL sqlite database and the REAL express routes over HTTP.
 */
'use strict';

const assert  = require('assert');
const path    = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'database.js'));
const { tdb }      = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const businessDate = require(path.join(ROOT, 'lib', 'business-date.js'));
const router       = require(path.join(ROOT, 'routes', 'retail.js'));
const db = tdb();

const STORE      = 9441;
const P_FRESH    = 9541;   // batch-made, backorder_all, shelf ZERO
const P_SHELF    = 9542;   // batch-made, backorder_all, THREE on the shelf
const P_GROCERY  = 9543;   // NOT batch-made, backorder_all, shelf ZERO
const CUSTOMER   = 9641;
const ADDRESS    = 9741;
const PARKED     = [9841, 9842, 9843, 9844, 9845, 9846];
const TOKEN      = 'preorderallowancecaptesttoken9641';
const ALLOWANCE  = 5;

let ADDR_GZ = null;
function resolveGzDistrict() {
  const row = db.prepare(
    `SELECT match_district FROM retail_delivery_zones
      WHERE is_active = 1 AND zone_type = 'gz_district' AND match_district IS NOT NULL
      ORDER BY id ASC LIMIT 1`).get();
  if (!row) return null;
  return { province: '广东省', city: '广州市', district: row.match_district,
    address: '测试路 1 号', detail: '101' };
}

function cleanup() {
  const wipe = (sql, ...a) => { try { db.prepare(sql).run(...a); } catch (e) { console.warn('[cleanup]', e.message); } };
  /* EVERY order holding one of this suite's PRODUCTS, which is not the same as
     every order belonging to its customer — and the difference is a scar. The
     blank-allowance case proves its point by letting an order SUCCEED, and the
     row the checkout writes carries a NULL customer_id, so a cleanup keyed on
     the customer walked straight past it. The orphan then held a foreign key on
     the product, the next run collided on the primary key, and the fixtures
     were left behind for whatever ran after that.
     Keyed on the product ids instead: those are this file's own, nothing else
     can be stocking them, and it catches the parked orders in the same sweep. */
  const oids = db.prepare(
    'SELECT DISTINCT order_id FROM retail_order_items WHERE product_id IN (?,?,?)'
  ).all(P_FRESH, P_SHELF, P_GROCERY).map(r => r.order_id).filter(id => id != null);
  if (oids.length) {
    const ph = oids.map(() => '?').join(',');
    // Only the tables that actually carry order_id — delivery_jobs and
    // qingyun_push_queue key differently and neither is written by this suite.
    for (const t of ['retail_order_items', 'retail_stock_reservations', 'retail_payments',
                     'retail_shipments', 'retail_points_transactions']) {
      wipe(`DELETE FROM ${t} WHERE order_id IN (${ph})`, ...oids);
    }
    wipe(`DELETE FROM retail_orders WHERE id IN (${ph})`, ...oids);
  }
  wipe('DELETE FROM retail_auth_tokens        WHERE customer_id = ?', CUSTOMER);
  wipe('DELETE FROM retail_customer_addresses WHERE id = ?', ADDRESS);
  wipe('DELETE FROM retail_customers          WHERE id = ?', CUSTOMER);
  wipe('DELETE FROM retail_store_stock WHERE product_id IN (?,?,?)', P_FRESH, P_SHELF, P_GROCERY);
  wipe('DELETE FROM store_products     WHERE id         IN (?,?,?)', P_FRESH, P_SHELF, P_GROCERY);
  wipe('DELETE FROM retail_stores      WHERE id = ?', STORE);
  wipe("DELETE FROM storefront_config WHERE key = 'batch.schedule'");
}

function setAllowance(qty) {
  const tz = (() => { try { return businessDate.shopTimezone(db); } catch { return null; } })();
  db.prepare(
    `INSERT INTO storefront_config (key, value_json) VALUES ('batch.schedule', ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
  ).run(JSON.stringify({
    enabled: true, anchor_date: businessDate.businessDate(tz, new Date()),
    interval_days: 1, cutoff_hour: 20, ready_hour: 11, skip_dates: [],
    preorder_qty: qty, preorder_channels: ['meituan'],
  }));
}

function seed() {
  cleanup();
  db.prepare(
    `INSERT INTO retail_stores (id, code, name_en, name_cn, city, district, is_active, sort_order)
     VALUES (?,?,?,?,?,?,1,?)`
  ).run(STORE, 'pac-local', 'Local Shop', '本地店', '广州市', ADDR_GZ.district, 1);

  const prod = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, weight,
                                 is_batch_made, oos_policy, is_published, is_active)
     VALUES (?,?,?,?,?,?,?,'backorder_all',1,1)`
  );
  prod.run(P_FRESH,   'Falafel Wrap',  '法拉费卷', 'pac-1', 44, '250g', 1);
  prod.run(P_SHELF,   'Tabbouleh Bowl', '塔布勒碗', 'pac-2', 44, '300g', 1);
  prod.run(P_GROCERY, 'Rolled Oats',    '燕麦片',   'pac-3', 68, '500g', 0);

  const stock = db.prepare(
    `INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer)
     VALUES (?,?,?,0)`);
  stock.run(STORE, P_FRESH,   0);
  stock.run(STORE, P_SHELF,   3);
  stock.run(STORE, P_GROCERY, 0);

  db.prepare(
    `INSERT INTO retail_customers (id, nickname, phone, openid, is_blocked, lifetime_spend, points_balance)
     VALUES (?,?,?,?,0,0,0)`
  ).run(CUSTOMER, 'Allowance Cap Test', '13900000041', 'dev:preorder-allowance-cap');
  db.prepare(
    "INSERT INTO retail_auth_tokens (token, customer_id, expires_at) VALUES (?,?,datetime('now','+1 day'))"
  ).run(TOKEN, CUSTOMER);
  db.prepare(
    `INSERT INTO retail_customer_addresses
       (id, customer_id, recipient_name, phone, province, city, district, address, detail, is_default)
     VALUES (?,?,?,?,?,?,?,?,?,1)`
  ).run(ADDRESS, CUSTOMER, 'Asher', '13900000041',
        ADDR_GZ.province, ADDR_GZ.city, ADDR_GZ.district, ADDR_GZ.address, ADDR_GZ.detail);
}

// Park `qty` units of `pid` as an awaiting_restock order — the shape the mini
// app's own pre-order park writes, holding no reservation.
let parkCursor = 0;
function park(pid, qty) {
  const id = PARKED[parkCursor++];
  db.prepare(
    `INSERT INTO retail_orders (id, order_no, customer_id, status, store_id, address_json,
                                fulfillment_type, subtotal, shipping_fee, same_day_surcharge_fee,
                                total, delivery_mode, channel, awaiting_restock_pids)
     VALUES (?,?,?,'awaiting_restock',?,?,'delivery',?,0,0,?,'standard','wechat',?)`
  ).run(id, `PAC${id}`, CUSTOMER, STORE, JSON.stringify(ADDR_GZ), 44 * qty, 44 * qty,
        JSON.stringify([pid]));
  db.prepare(
    `INSERT INTO retail_order_items (order_id, product_id, qty, unit_price, line_total, options_json)
     VALUES (?,?,?,?,?,'[]')`
  ).run(id, pid, qty, 44, 44 * qty);
  return id;
}
function unparkAll() {
  const ph = PARKED.map(() => '?').join(',');
  try { db.prepare(`DELETE FROM retail_order_items WHERE order_id IN (${ph})`).run(...PARKED); } catch {}
  try { db.prepare(`DELETE FROM retail_orders WHERE id IN (${ph})`).run(...PARKED); } catch {}
  parkCursor = 0;
}

const app = express();
app.use(router);
let PORT = 0;
const call = (url, body) => fetch(`http://127.0.0.1:${PORT}${url}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

const payload = (items, slotId) => ({
  address_id: ADDRESS, items, delivery_mode: 'standard',
  payment_method: 'wechat', delivery_slot_id: slotId || 'right_away',
});
const quote = (items, slotId) => call('/api/retail/checkout/quote', payload(items, slotId));
const order = (items, slotId) => call('/api/retail/orders', payload(items, slotId));

/* A slot the picker is actually offering right now. 'right_away' is deliberately
   NOT used for an order that is expected to SUCCEED: the batch schedule this
   suite switches on withdraws right-away while a fresh line is short (that is
   the previous change, and test_fresh_slot_reachable.js pins it), so an order
   carrying it is refused on the slot and would never reach the question this
   suite is asking. */
async function firstOfferedSlot(items) {
  const q = await quote(items);
  const sch = q.body?.data?.scheduling || {};
  const list = (sch.today_slots && sch.today_slots.length ? sch.today_slots : sch.slots) || [];
  return list.length ? list[0].slot_id : null;
}
const capped = (b) => ((b && b.data ? b.data.blocked_items : b && b.blocked_items) || [])
  .filter(x => x.reason === 'preorder_full').map(x => x.name_en);

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

(async () => {
  ADDR_GZ = resolveGzDistrict();
  if (!ADDR_GZ) { console.error('No active gz_district in retail_delivery_zones.'); process.exit(2); }
  seed();
  setAllowance(ALLOWANCE);

  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;

  // ── Nothing parked yet: the allowance is untouched ────────────────────────
  {
    const q = await quote([{ product_id: P_FRESH, qty: 1 }]);
    console.log(`\n── allowance ${ALLOWANCE}, nothing parked yet`);
    console.log(`   quote capped: ${JSON.stringify(capped(q.body))}`);
    check('a pre-order inside the allowance is not capped', () => {
      assert.strictEqual(q.status, 200);
      assert.deepStrictEqual(capped(q.body), [], 'the first wrap must still sell');
    });
  }

  // ── Four parked: one more fits, two do not ────────────────────────────────
  {
    park(P_FRESH, 4);
    const ok   = await quote([{ product_id: P_FRESH, qty: 1 }]);
    const over = await quote([{ product_id: P_FRESH, qty: 2 }]);
    console.log(`\n── allowance ${ALLOWANCE}, 4 already parked`);
    console.log(`   asking for 1 → capped: ${JSON.stringify(capped(ok.body))}`);
    console.log(`   asking for 2 → capped: ${JSON.stringify(capped(over.body))}`);
    check('4 parked + 1 more is exactly the allowance, and is allowed', () => {
      assert.deepStrictEqual(capped(ok.body), [], '5 of 5 is not over the line');
    });
    check('4 parked + 2 more is over the allowance, and is not', () => {
      assert.deepStrictEqual(capped(over.body), ['Falafel Wrap']);
    });
  }

  // ── Five parked: the order endpoint itself refuses ────────────────────────
  {
    unparkAll();
    park(P_FRESH, 5);
    const q = await quote([{ product_id: P_FRESH, qty: 1 }]);
    const o = await order([{ product_id: P_FRESH, qty: 1 }]);
    console.log(`\n── allowance ${ALLOWANCE}, 5 already parked`);
    console.log(`   quote capped: ${JSON.stringify(capped(q.body))}`);
    console.log(`   order        : http ${o.status} ${o.body && o.body.error}`);
    check('the ORDER endpoint refuses past the allowance', () => {
      assert.strictEqual(o.status, 409, 'an uncapped app is the whole defect');
      assert.strictEqual(o.body?.error, 'insufficient_stock');
      assert.strictEqual(o.body?.product_id, P_FRESH);
    });
    check('the quote says so too, so the page can hold the button', () => {
      assert.strictEqual(q.status, 200, 'the quote reports, it never refuses');
      assert.deepStrictEqual(capped(q.body), ['Falafel Wrap']);
    });
    check('the refusal carries the list the checkout page removes from', () => {
      assert.deepStrictEqual(capped(o.body), ['Falafel Wrap']);
    });
  }

  // ── Shelf stock is spent BEFORE the allowance ─────────────────────────────
  {
    unparkAll();
    park(P_SHELF, 5);                       // allowance fully spent
    const onShelf = await quote([{ product_id: P_SHELF, qty: 3 }]);   // 3 on the shelf
    const beyond  = await quote([{ product_id: P_SHELF, qty: 4 }]);   // 3 + 1 pre-order
    console.log(`\n── 3 on the shelf, allowance ${ALLOWANCE} fully parked`);
    console.log(`   asking for 3 (all from stock) → capped: ${JSON.stringify(capped(onShelf.body))}`);
    console.log(`   asking for 4 (1 pre-ordered)  → capped: ${JSON.stringify(capped(beyond.body))}`);
    check('a line the shelf covers spends no allowance', () => {
      assert.deepStrictEqual(capped(onShelf.body), [],
        'three off a shelf of three pre-orders nothing');
    });
    check('only the part the shelf cannot cover is capped', () => {
      assert.deepStrictEqual(capped(beyond.body), ['Tabbouleh Bowl']);
    });
  }

  // ── A line that is not batch-made never spends the allowance ──────────────
  {
    unparkAll();
    park(P_GROCERY, 20);
    const q = await quote([{ product_id: P_GROCERY, qty: 5 }]);
    console.log(`\n── not batch-made, 20 parked, allowance ${ALLOWANCE}`);
    console.log(`   quote capped: ${JSON.stringify(capped(q.body))}`);
    check('a grocery line is not the kitchen\'s cooking day, so the cap ignores it', () => {
      assert.deepStrictEqual(capped(q.body), [],
        'channel-publish never gives a non-batch-made product the allowance either');
    });
  }

  // ── A blank allowance changes nothing ─────────────────────────────────────
  {
    unparkAll();
    setAllowance(0);
    park(P_FRESH, 50);
    const cart = [{ product_id: P_FRESH, qty: 1 }];
    const slot = await firstOfferedSlot(cart);
    const q = await quote(cart, slot);
    const o = await order(cart, slot);
    console.log(`\n── allowance BLANK, 50 parked, slot ${slot}`);
    console.log(`   quote capped: ${JSON.stringify(capped(q.body))}   order: http ${o.status} ${(o.body && o.body.error) || 'accepted'}`);
    check('an unset allowance leaves the app exactly as it was', () => {
      assert.deepStrictEqual(capped(q.body), [],
        'off-by-default is what makes this safe for a tenant who never set the field');
      assert.notStrictEqual(o.body?.error, 'insufficient_stock',
        'fifty parked against a blank allowance must still sell — nothing may start refusing');
    });
  }

  unparkAll();
  cleanup();
  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { unparkAll(); cleanup(); } catch {} process.exit(1); });
