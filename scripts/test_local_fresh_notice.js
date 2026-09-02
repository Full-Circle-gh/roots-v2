#!/usr/bin/env node
/**
 * The Guangzhou fresh-batch notice: a shopper on the same-day local run whose
 * cart holds a sold-out fresh meal gets the kitchen's PRODUCTION DATE, not the
 * dateless "a few days" they used to get.
 *
 *   node scripts/test_local_fresh_notice.js
 *
 * What this locks down, and why each half matters:
 *
 *   • Zero sellable stock in Guangzhou → the notice fires with the next batch
 *     day. That date already exists (batch.schedule drives computeBatchNotice
 *     for out-of-city orders); it was simply never shown to Guangzhou, whose
 *     shoppers fell through to computePreorderNotice's dateless copy.
 *
 *   • STOCK ON HAND in Guangzhou → the notice stays SILENT, even on a day the
 *     kitchen isn't baking. This is the shelf-life rule and it is the half most
 *     likely to regress: a fresh item keeps ~3 days, so a batch made Monday
 *     still serves Guangzhou on Tuesday and Wednesday and the cadence is none
 *     of the shopper's business. Firing on 'next_cadence' would nag every
 *     in-stock Guangzhou cart about a wait that isn't happening.
 *
 * Out-of-city is untouched throughout (it keeps computeBatchNotice, with its
 * courier transit day), as is the dateless notice for generic grocery restock.
 *
 * Runs against a REAL sqlite database (data/roots.db, created by database.js on
 * require and gitignored) with a seeded store / products / stock / schedule and
 * a FIXED clock, so the dates printed are observed values.
 */
'use strict';

// Production runs UTC+8 with no DST and the batch maths is local-time. Pin the
// zone BEFORE anything loads or a UTC host reads 18:26 GZ as 10:26.
process.env.TZ = 'Asia/Shanghai';

const path = require('path');
const ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const retail = require(path.join(ROOT, 'routes', 'retail.js'));

const db = tdb();

// ── Fixtures ───────────────────────────────────────────────────────────────
// High ids so a dev database's own rows are never touched.
const STORE_GZ   = 9421;        // the Guangzhou shop the local run loads from
const P_FRESH    = 9431;        // batch-made: the wrap
const P_GROCERY  = 9432;        // not batch-made, backorder-able: the pantry item
const SKU_FRESH   = 'tlf-1-441';
const SKU_GROCERY = 'tlf-2-101';
const STORE_CODE  = 'tlf-gz';

// anchor 2026-06-16 + every 2 days ⇒ even days from it are batch days.
// 2026-08-17 IS one (62 days on); 2026-08-18 is NOT.
const SCHEDULE = {
  enabled: true, anchor_date: '2026-06-16', interval_days: 2,
  skip_dates: [], cutoff_hour: 20,
};

// Batch day, 18:26 — before the 20:00 cutoff, so only stock can block today.
const NOW_BATCH_DAY = new Date(2026, 7, 17, 18, 26, 0);
// The DAY AFTER a batch: not a batch day. This is "Monday's stock on Tuesday".
const NOW_OFF_DAY   = new Date(2026, 7, 18, 11, 0, 0);

const ADDR_GZ       = { province: '广东省', city: '广州市', district: '天河区', address: 'x' };
const ADDR_SHANGHAI = { province: '上海市', city: '上海市', district: '静安区', address: 'x' };

function setCfg(key, val) {
  db.prepare(
    `INSERT INTO storefront_config (key, value_json) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
  ).run(key, JSON.stringify(val));
}

function seed() {
  db.prepare('DELETE FROM retail_store_stock WHERE product_id IN (?,?)').run(P_FRESH, P_GROCERY);
  db.prepare('DELETE FROM store_products WHERE id IN (?,?)').run(P_FRESH, P_GROCERY);
  db.prepare('DELETE FROM retail_stores WHERE id = ?').run(STORE_GZ);
  // Also clear by the UNIQUE business keys, not just the ids: a previous run of
  // this file under different fixture ids leaves rows whose sku / code would
  // trip the unique constraint on re-seed.
  db.prepare('DELETE FROM store_products WHERE sku IN (?,?)').run(SKU_FRESH, SKU_GROCERY);
  db.prepare('DELETE FROM retail_stores  WHERE code = ?').run(STORE_CODE);
  // No retail_delivery_zones row for 天河区 — isOptInSameDayDistrict then reads
  // it as an inner district, i.e. ON the local run, which is this test's subject.
  db.prepare(
    `INSERT INTO retail_stores (id, code, name_en, name_cn, city, district, is_active, sort_order)
     VALUES (?,?,?,?,?,?,1,?)`
  ).run(STORE_GZ, STORE_CODE, 'GZ Shop', '广州店', '广州市', '天河区', 1);

  const prod = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_batch_made, oos_policy,
                                 is_published, is_active)
     VALUES (?,?,?,?,?,?,?,1,1)`
  );
  prod.run(P_FRESH,   "Pesto 'Chicken' Wrap", '青酱鸡肉卷', SKU_FRESH,   48, 1, 'backorder_gz');
  prod.run(P_GROCERY, 'Olive Oil',            '橄榄油',     SKU_GROCERY, 88, 0, 'backorder_gz');

  setCfg('batch.schedule', SCHEDULE);
}

function setStock(storeId, productId, qty) {
  db.prepare(
    `INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer)
     VALUES (?,?,?,0)
       ON CONFLICT(store_id, product_id) DO UPDATE SET physical_qty = excluded.physical_qty`
  ).run(storeId, productId, qty);
}

function notice({ address, productIds, now, storeId = STORE_GZ, slotKind = 'today' }) {
  return retail.computeLocalFreshNotice(address, productIds, now, slotKind, { storeId, channel: 'wechat' });
}

// ── Scenarios ──────────────────────────────────────────────────────────────
seed();
const R = {};

setStock(STORE_GZ, P_FRESH, 0);
R.gzZeroOnBatchDay = notice({ address: ADDR_GZ, productIds: [P_FRESH], now: NOW_BATCH_DAY });

setStock(STORE_GZ, P_FRESH, 0);
R.gzZeroOnOffDay = notice({ address: ADDR_GZ, productIds: [P_FRESH], now: NOW_OFF_DAY });

// The shelf-life case: Monday's batch still on the shelf, ordered on a day the
// kitchen isn't baking. Must stay silent.
setStock(STORE_GZ, P_FRESH, 12);
R.gzStockedOnOffDay = notice({ address: ADDR_GZ, productIds: [P_FRESH], now: NOW_OFF_DAY });

setStock(STORE_GZ, P_FRESH, 12);
R.gzStockedOnBatchDay = notice({ address: ADDR_GZ, productIds: [P_FRESH], now: NOW_BATCH_DAY });

// Out-of-city keeps computeBatchNotice (dates + a courier day); this must not fire.
setStock(STORE_GZ, P_FRESH, 0);
R.outOfCity = notice({ address: ADDR_SHANGHAI, productIds: [P_FRESH], now: NOW_BATCH_DAY });

// Generic grocery sold out in GZ — no production date exists, dateless path.
setStock(STORE_GZ, P_GROCERY, 0);
R.gzGroceryOnly = notice({ address: ADDR_GZ, productIds: [P_GROCERY], now: NOW_BATCH_DAY });

// No store resolved → we cannot prove a shortage, so we say nothing.
setStock(STORE_GZ, P_FRESH, 0);
R.noStore = notice({ address: ADDR_GZ, productIds: [P_FRESH], now: NOW_BATCH_DAY, storeId: null });

// A mixed cart names only the sold-out fresh line, not every fresh line.
setStock(STORE_GZ, P_FRESH, 0);
setStock(STORE_GZ, P_GROCERY, 50);
R.mixedCart = notice({ address: ADDR_GZ, productIds: [P_FRESH, P_GROCERY], now: NOW_BATCH_DAY });

// ── Report ─────────────────────────────────────────────────────────────────
for (const [k, v] of Object.entries(R)) {
  console.log(`\n── ${k}`);
  if (!v) { console.log('   (no notice)'); continue; }
  console.log(`   make_date  ${v.make_date}`);
  console.log(`   delivery   ${v.delivery_date}`);
  console.log(`   title_en   ${v.title_en}`);
  console.log(`   message_en ${v.message_en}`);
  console.log(`   items      ${v.items.map(i => i.name_en).join(', ')}`);
}

// ── Assertions ─────────────────────────────────────────────────────────────
let failed = 0;
function check(label, fn) {
  let ok = false, err = null;
  try { ok = fn(); } catch (e) { err = e.message; }
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${label}${err ? ' — ' + err : ''}`);
  if (!ok) failed++;
}

console.log('\n── Assertions');

check('sold out on a batch day → the notice names the NEXT batch, not today',
  () => R.gzZeroOnBatchDay && R.gzZeroOnBatchDay.make_date === '2026-08-19');

check('sold out on an off day → the notice names the next batch day',
  () => R.gzZeroOnOffDay && R.gzZeroOnOffDay.make_date === '2026-08-19');

check('SHELF LIFE: stock on hand on an off day → silent (no nag about the cadence)',
  () => R.gzStockedOnOffDay === null);

check('stock on hand on a batch day → silent',
  () => R.gzStockedOnBatchDay === null);

check('out-of-city is untouched — it keeps computeBatchNotice',
  () => R.outOfCity === null);

check('a sold-out GROCERY item raises no dated notice (no production date exists)',
  () => R.gzGroceryOnly === null);

check('no resolvable store → silent rather than a guessed shortage',
  () => R.noStore === null);

check('a mixed cart names only the sold-out fresh line',
  () => R.mixedCart && R.mixedCart.items.length === 1 && R.mixedCart.items[0].id === P_FRESH);

check('the promised date is carried in the customer-facing copy',
  () => R.gzZeroOnBatchDay.message_en.includes('2026-08-19')
     && R.gzZeroOnBatchDay.message_cn.includes('2026-08-19'));

check('the arrival is the make day itself — the local run spends no transit day',
  () => R.gzZeroOnBatchDay.delivery_date === R.gzZeroOnBatchDay.make_date);

check('the promised day is always a FUTURE batch day, so no run has already left',
  () => R.gzZeroOnBatchDay.delivery_date > '2026-08-17'
     && R.gzZeroOnOffDay.delivery_date  > '2026-08-18');

// ── The endpoint, mounted and called over HTTP ─────────────────────────────
// The unit scenarios above call computeLocalFreshNotice directly, so they
// cannot see whether /checkout/quote actually HANDS it a store. That wiring is
// where this feature is easiest to get wrong: the quote resolves a store into
// `quoteStore` only on the no-shortage path, and a sold-out fresh line always
// raises a shortage gate — so reading that variable left the notice null on
// exactly the carts it exists for. This section is the regression guard for it.
const express = require('express');
const router  = require(path.join(ROOT, 'routes', 'retail.js'));

const CUSTOMER   = 9621;
const TOKEN      = 'localfreshnoticetesttoken9621';
const ZONE_ID    = 9441;
const DISTRICT   = '天河区';

// Other fixture files leave their own stores active in the shared dev database,
// and the router picks by proximity — so without this the quote resolves to
// someone else's store, whose (absent) stock row reads as zero and the in-stock
// scenario can never be observed. Park them for the duration and restore after.
let _parkedStores = [];
function parkOtherStores() {
  _parkedStores = db.prepare('SELECT id FROM retail_stores WHERE is_active = 1 AND id != ?')
    .all(STORE_GZ).map(r => r.id);
  if (_parkedStores.length) {
    db.prepare(`UPDATE retail_stores SET is_active = 0 WHERE id IN (${_parkedStores.map(() => '?').join(',')})`)
      .run(..._parkedStores);
  }
}
function restoreOtherStores() {
  if (!_parkedStores.length) return;
  db.prepare(`UPDATE retail_stores SET is_active = 1 WHERE id IN (${_parkedStores.map(() => '?').join(',')})`)
    .run(..._parkedStores);
  _parkedStores = [];
}

function seedHttp() {
  db.prepare('DELETE FROM retail_checkout_quotes WHERE customer_id = ?').run(CUSTOMER);
  db.prepare('DELETE FROM retail_auth_tokens WHERE customer_id = ?').run(CUSTOMER);
  db.prepare('DELETE FROM retail_customers   WHERE id = ?').run(CUSTOMER);
  db.prepare('DELETE FROM retail_delivery_zones WHERE id = ?').run(ZONE_ID);
  db.prepare(
    `INSERT INTO retail_customers (id, nickname, phone, openid, is_blocked, lifetime_spend, points_balance)
     VALUES (?,?,?,?,0,0,0)`
  ).run(CUSTOMER, 'Local Fresh Test', '13900000021', 'dev:local-fresh-notice');
  db.prepare(
    "INSERT INTO retail_auth_tokens (token, customer_id, expires_at) VALUES (?,?,datetime('now','+1 day'))"
  ).run(TOKEN, CUSTOMER);
  // An INNER district: day_only = 0 and no same-day surcharge, which is what
  // isOptInSameDayDistrict reads as "on the local run".
  db.prepare(
    `INSERT INTO retail_delivery_zones (id, zone_type, name_en, name_cn, match_city, match_district,
                                        base_fee, is_active, same_day_allowed, same_day_surcharge,
                                        min_lead_days, max_lead_days, day_only)
     VALUES (?, 'gz_district', 'Tianhe', ?, '广州市', ?, 8, 1, 1, 0, 0, 14, 0)`
  ).run(ZONE_ID, DISTRICT, DISTRICT);
}

function quote(productId) {
  return fetch(`http://127.0.0.1:${PORT}/api/retail/checkout/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      address: { province: '广东省', city: '广州市', district: DISTRICT },
      items: [{ product_id: productId, qty: 1 }],
      delivery_mode: 'standard',
      slot_kind: 'today',
    }),
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
}

let PORT = 0;

(async () => {
  seedHttp();
  parkOtherStores();
  process.on('exit', restoreOtherStores);
  const app = express();
  app.use(router);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;

  console.log('\n── Over HTTP: POST /api/retail/checkout/quote');

  setStock(STORE_GZ, P_FRESH, 0);
  const soldOut = await quote(P_FRESH);
  const n = soldOut.body && soldOut.body.data && soldOut.body.data.local_fresh_notice;
  console.log(`   sold-out fresh  status ${soldOut.status}  notice ${n ? n.make_date : '(null)'}`);

  setStock(STORE_GZ, P_FRESH, 20);
  const inStock = await quote(P_FRESH);
  const n2 = inStock.body && inStock.body.data && inStock.body.data.local_fresh_notice;
  console.log(`   in-stock fresh  status ${inStock.status}  notice ${n2 ? n2.make_date : '(null)'}`);

  check('the quote REACHES a store on the shortage path and returns the notice',
    () => !!n && /^\d{4}-\d{2}-\d{2}$/.test(n.make_date));

  check('the quote names the sold-out fresh item',
    () => !!n && n.items.length === 1 && n.items[0].id === P_FRESH);

  check('the quote carries the same-day arrival too',
    () => !!n && n.delivery_date === n.make_date);

  check('an in-stock Guangzhou cart gets no notice from the endpoint either',
    () => !n2);

  check('the dateless pre-order notice never fires alongside it (complementary gates)',
    () => !(soldOut.body && soldOut.body.data && soldOut.body.data.preorder_notice));

  server.close();
  restoreOtherStores();
  console.log(failed ? `\n${failed} assertion(s) FAILED` : '\nAll assertions passed');
  process.exit(failed ? 1 : 0);
})();
