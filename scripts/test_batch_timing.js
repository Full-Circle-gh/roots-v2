#!/usr/bin/env node
/**
 * Fresh-batch timing: the promise, the calendar and the slot validator must
 * agree about which day a fresh order is MADE on.
 *
 *   node scripts/test_batch_timing.js
 *
 * The defect this locks down (order TC000306): a batch-made wrap sold at zero
 * stock was promised "made fresh · ship <today>" because computeBatchNotice read
 * the production cadence and the day's cutoff hour but never asked whether there
 * was any stock to sell. The stock had hit zero at 11:58; the order was placed at
 * 18:26, before the 20:00 cutoff, on a day the cadence said was a batch day — so
 * every input the code looked at said "today", and it promised a batch that had
 * already sold out.
 *
 * Everything here runs against a REAL sqlite database (data/roots.db, created by
 * database.js on require and gitignored) with a seeded store / product / stock /
 * config, and a FIXED clock, so the dates printed are observed values rather
 * than reasoning about what the code should do.
 *
 * `--baseline` runs the same scenarios against a pristine copy of routes/retail.js
 * taken from HEAD, so the "unchanged for in-city / non-fresh carts" claims are a
 * real before/after diff and not an assertion about the code's shape.
 */
'use strict';

// Production runs UTC+8 with no DST and all the slot maths is local-time. Pin the
// zone BEFORE anything loads or a UTC host reads 18:26 GZ as 10:26 and the whole
// cutoff scenario evaporates.
process.env.TZ = 'Asia/Shanghai';

const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const BASELINE = process.argv.includes('--baseline');
const RETAIL = BASELINE
  ? path.join(ROOT, 'routes', '_baseline_retail.js')
  : path.join(ROOT, 'routes', 'retail.js');

require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const retail = require(RETAIL);

const db = tdb();

// ── Fixtures ───────────────────────────────────────────────────────────────
// High ids so a dev database's own rows are never touched.
const STORE_WAREHOUSE = 9101;      // the out-of-city shipper (the pin target)
const STORE_NEAR      = 9102;      // a nearer store the proximity router prefers
const P_FRESH         = 9201;      // batch-made: the Pesto 'Chicken' Wrap, SKU 1-440
const P_PANTRY        = 9202;      // not batch-made

// 2026-08-17 18:26 local — TC000306's placement moment: past 11:58 (when stock
// hit zero) and before the 20:00 cutoff.
const NOW = new Date(2026, 7, 17, 18, 26, 0);

// anchor 2026-06-16 + every 2 days ⇒ 2026-08-17 IS a batch day (62 days on).
// Taken from the only stored schedule in the repo, public/shop/_gallery.fixtures.js.
const SCHEDULE = {
  enabled: true, anchor_date: '2026-06-16', interval_days: 2,
  skip_dates: [], cutoff_hour: 20,
};

// Out-of-city (Shanghai): ships by courier, day-only, earliest is tomorrow.
const ZONE_CITY = {
  id: 9301, zone_type: 'city', name_en: 'Shanghai', name_cn: '上海市',
  day_only: 1, same_day_allowed: 0, same_day_surcharge: 0,
  min_lead_days: 1, max_lead_days: 15,
  slot_start_hour: 10, slot_end_hour: 20, slot_duration_minutes: 120,
};
// Inner Guangzhou: same-day time slots, no surcharge. Out of scope by decision.
const ZONE_GZ = {
  id: 9302, zone_type: 'gz_district', name_en: 'Tianhe', name_cn: '天河区',
  day_only: 0, same_day_allowed: 1, same_day_surcharge: 0,
  min_lead_days: 0, max_lead_days: 14,
  slot_start_hour: 10, slot_end_hour: 20, slot_duration_minutes: 120,
};

const ADDR_SHANGHAI = { province: '上海市', city: '上海市', district: '静安区', address: 'x' };

function setCfg(key, val) {
  db.prepare(
    `INSERT INTO storefront_config (key, value_json) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
  ).run(key, JSON.stringify(val));
}

function seed() {
  db.prepare('DELETE FROM retail_store_stock WHERE product_id IN (?,?)').run(P_FRESH, P_PANTRY);
  db.prepare('DELETE FROM store_products WHERE id IN (?,?)').run(P_FRESH, P_PANTRY);
  db.prepare('DELETE FROM retail_stores WHERE id IN (?,?)').run(STORE_WAREHOUSE, STORE_NEAR);

  const store = db.prepare(
    `INSERT INTO retail_stores (id, code, name_en, name_cn, city, district, is_active, sort_order)
     VALUES (?,?,?,?,?,?,1,?)`
  );
  store.run(STORE_WAREHOUSE, 'tbt-warehouse', 'Warehouse', '仓库', '广州市', '天河区', 1);
  store.run(STORE_NEAR,      'tbt-near',      'Near',      '近店', '广州市', '越秀区', 0);

  const prod = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_batch_made, oos_policy,
                                 is_published, is_active)
     VALUES (?,?,?,?,?,?,?,1,1)`
  );
  prod.run(P_FRESH,  "Pesto 'Chicken' Wrap", '青酱鸡肉卷', '1-440', 48, 1, 'backorder_gz');
  prod.run(P_PANTRY, 'Olive Oil',            '橄榄油',     '2-100', 88, 0, 'strict');

  setCfg('batch.schedule', SCHEDULE);
  setCfg('printer.out_of_city_store_id', STORE_WAREHOUSE);
}

// Sellable stock at a store. physical − safety_buffer − reservations; we drive
// it through physical_qty and leave the other two at 0.
function setStock(storeId, productId, qty) {
  db.prepare(
    `INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer)
     VALUES (?,?,?,0)
       ON CONFLICT(store_id, product_id) DO UPDATE SET physical_qty = excluded.physical_qty`
  ).run(storeId, productId, qty);
}

// ── The four numbers every scenario reports ────────────────────────────────
// Exactly what the brief asks for: the earliest make date, the two dates that
// get persisted on the order row, the calendar floor the customer is offered,
// and whether the banner and the picker agree.
function observe({ label, zone, productIds, storeId, slotId = null, slotKind = 'express' }) {
  const decision = retail.earliestBatchMakeDate
    ? retail.earliestBatchMakeDate({ zone, productIds, storeId, now: NOW, channel: 'wechat' })
    : null;
  const notice = retail.computeBatchNotice(
    zone, productIds, NOW, slotId, slotKind,
    decision ? { decision } : { storeId },
  );
  const sched = retail.computeDeliverySlots(zone, NOW, decision ? { batch: decision } : {});

  const shipDate = notice ? notice.ship_date : null;
  const minDate  = sched.schedule ? sched.schedule.min_date : null;
  // The banner says "made on ship_date, arrives delivery_date". The picker's
  // earliest bookable day must not be BEFORE that arrival, or the customer can
  // choose a date the banner contradicts — the whole point of the change.
  const agree = !notice ? 'n/a (no fresh promise)'
    // No calendar at all is the empty state, not a contradiction: there is no
    // date on offer for the banner to disagree with.
    : !minDate ? 'n/a (no calendar — empty state)'
    : (minDate >= notice.delivery_date) ? 'yes'
    : `NO — picker offers ${minDate}, banner promises ${notice.delivery_date}`;

  return {
    label,
    earliest_make_date: decision ? decision.make_date : '(no decision fn)',
    reason:             decision ? decision.reason    : '(baseline)',
    promised_ship_date:     shipDate,
    promised_delivery_date: notice ? notice.delivery_date : null,
    schedule_min_date:  minDate,
    schedule_max_date:  sched.schedule ? sched.schedule.max_date : null,
    express_slot_date:  sched.express_slot ? sched.express_slot.date_iso : null,
    banner_picker_agree: agree,
  };
}

function show(o) {
  console.log(`\n── ${o.label}`);
  for (const [k, v] of Object.entries(o)) {
    if (k === 'label') continue;
    console.log(`   ${k.padEnd(24)} ${v === null ? '(null)' : v}`);
  }
}

// ── Scenarios ──────────────────────────────────────────────────────────────
seed();
const results = {};

// TC000306 — the reported defect. Fresh item at ZERO at the warehouse.
setStock(STORE_WAREHOUSE, P_FRESH, 0);
setStock(STORE_NEAR, P_FRESH, 5);            // another store has it; irrelevant, we ship from the warehouse
results.tc000306 = observe({
  label: 'TC000306 — Shanghai, fresh SKU 1-440 at ZERO, 18:26 vs 20:00 cutoff',
  zone: ZONE_CITY, productIds: [P_FRESH], storeId: STORE_WAREHOUSE,
});

// (a) identical but stock available.
setStock(STORE_WAREHOUSE, P_FRESH, 12);
results.a_in_stock = observe({
  label: '(a) identical but stock AVAILABLE (12 at the warehouse)',
  zone: ZONE_CITY, productIds: [P_FRESH], storeId: STORE_WAREHOUSE,
});

// (b) identical but an in-city zone — out of scope, must not change.
setStock(STORE_WAREHOUSE, P_FRESH, 0);
results.b_in_city = observe({
  label: '(b) identical but IN-CITY zone (Tianhe, same-day slots)',
  zone: ZONE_GZ, productIds: [P_FRESH], storeId: STORE_WAREHOUSE,
});

// (c) no batch-made items at all.
results.c_no_fresh = observe({
  label: '(c) cart with NO batch-made items',
  zone: ZONE_CITY, productIds: [P_PANTRY], storeId: STORE_WAREHOUSE,
});

// (d) pin unset → the fulfilling store cannot be resolved.
setCfg('printer.out_of_city_store_id', null);
const pinned = retail.fulfillingStoreFor
  ? retail.fulfillingStoreFor({ address: ADDR_SHANGHAI, channel: 'wechat', isPickup: false, slotKind: 'express' })
  : null;
setStock(STORE_WAREHOUSE, P_FRESH, 99);      // plenty in stock — only the UNKNOWN store may roll it
results.d_no_store = observe({
  label: '(d) out-of-city pin UNSET — fulfilling store unresolvable (stock is 99)',
  zone: ZONE_CITY, productIds: [P_FRESH], storeId: pinned ? pinned.store.id : null,
});
setCfg('printer.out_of_city_store_id', STORE_WAREHOUSE);

// (e) The floor actually MOVING min_date. In the scenarios above the batch floor
// lands on the same day as the calendar's own +3 lead, so min_date doesn't shift
// and the narrowing is invisible there. Close the next two batch days as
// operator vacation so the make date is pushed well past the +3 floor.
setStock(STORE_WAREHOUSE, P_FRESH, 0);
setCfg('batch.schedule', { ...SCHEDULE, skip_dates: ['2026-08-19', '2026-08-21', '2026-08-23'] });
results.e_floor_moves = observe({
  label: '(e) zero stock + next three batch days closed (skip_dates) — floor must move min_date',
  zone: ZONE_CITY, productIds: [P_FRESH], storeId: STORE_WAREHOUSE,
});

// (f) Inversion guard: a horizon shorter than the floor must yield NO calendar
// rather than a backwards range (min > max), against which every date compares
// "valid" and the whole narrowing would invert into an open door.
const ZONE_TIGHT = { ...ZONE_CITY, max_lead_days: 2 };
results.f_inversion = observe({
  label: '(f) same, but zone horizon max_lead_days=2 — floor exceeds max_date',
  zone: ZONE_TIGHT, productIds: [P_FRESH], storeId: STORE_WAREHOUSE,
});
setCfg('batch.schedule', SCHEDULE);

for (const k of Object.keys(results)) show(results[k]);

// ── Store agreement: quote vs create ───────────────────────────────────────
// Both frames must now name the warehouse for a Shanghai cart. Pre-change the
// quote reported analyzeShortage's proximity pick (the nearer store) while
// creation shipped from the pinned warehouse.
console.log('\n── Fulfilling store, Shanghai cart (quote frame and create frame)');
if (retail.fulfillingStoreFor) {
  // baseStoreId is what proximity routing handed each frame — the nearer store.
  const atQuote  = retail.fulfillingStoreFor({ address: ADDR_SHANGHAI, channel: 'wechat', isPickup: false, slotKind: 'express', baseStoreId: STORE_NEAR });
  const atCreate = retail.fulfillingStoreFor({ address: ADDR_SHANGHAI, channel: 'wechat', isPickup: false, slotKind: 'express', baseStoreId: STORE_NEAR });
  console.log(`   quote  → ${atQuote ? atQuote.store.code : '(no pin)'}   reason: ${atQuote ? atQuote.reason : '—'}`);
  console.log(`   create → ${atCreate ? atCreate.store.code : '(no pin)'}   reason: ${atCreate ? atCreate.reason : '—'}`);
  console.log(`   proximity pick was: tbt-near`);
} else {
  console.log('   (baseline: no shared helper — quote used analyzeShortage, create pinned inline)');
}

// ── Slot validation: can a stale picker still push the old date through? ────
console.log('\n── Slot validator, Shanghai + fresh item at ZERO');
setStock(STORE_WAREHOUSE, P_FRESH, 0);
{
  const decision = retail.earliestBatchMakeDate
    ? retail.earliestBatchMakeDate({ zone: ZONE_CITY, productIds: [P_FRESH], storeId: STORE_WAREHOUSE, now: NOW, channel: 'wechat' })
    : null;
  const opts = decision ? { batch: decision } : {};
  for (const day of ['2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21']) {
    const r = retail.resolveDeliverySlot(ZONE_CITY, day, NOW, opts);
    console.log(`   pick ${day} → ${r.error ? r.error : 'ACCEPTED'}`);
  }
}

if (BASELINE) {
  console.log('\n(baseline run — pre-change behaviour above)');
} else {
  // ── Assertions: the invariants, not the prose ───────────────────────────
  console.log('\n── Assertions');
  let pass = 0, fail = 0;
  const it = (name, fn) => {
    try { fn(); console.log(`   ✓ ${name}`); pass++; }
    catch (e) { console.log(`   ✗ ${name}\n       ${e.message}`); fail++; }
  };

  it('TC000306 no longer promises today', () => {
    assert.notStrictEqual(results.tc000306.promised_ship_date, '2026-08-17');
    assert.strictEqual(results.tc000306.reason, 'rolled_stock');
  });
  it('TC000306 banner and picker agree', () => {
    assert.strictEqual(results.tc000306.banner_picker_agree, 'yes');
  });
  it('(a) in-stock still reaches today', () => {
    assert.strictEqual(results.a_in_stock.promised_ship_date, '2026-08-17');
    assert.strictEqual(results.a_in_stock.reason, 'reachable_today');
  });
  it('(b) in-city stays out of scope', () => {
    assert.strictEqual(results.b_in_city.reason, 'out_of_scope');
    assert.strictEqual(results.b_in_city.promised_ship_date, null);
  });
  it('(c) non-fresh cart carries no promise', () => {
    assert.strictEqual(results.c_no_fresh.reason, 'no_fresh_items');
    assert.strictEqual(results.c_no_fresh.promised_ship_date, null);
  });
  it('(d) unresolvable store rolls forward, distinctly', () => {
    assert.strictEqual(results.d_no_store.reason, 'rolled_store_unknown');
    assert.notStrictEqual(results.d_no_store.promised_ship_date, '2026-08-17');
  });
  it('(d) checkout can still complete — a date is offered', () => {
    assert.ok(results.d_no_store.schedule_min_date, 'no bookable day offered');
  });
  it('(e) the floor pushes min_date past the calendar\'s own +3 lead', () => {
    assert.strictEqual(results.e_floor_moves.earliest_make_date, '2026-08-25');
    assert.strictEqual(results.e_floor_moves.schedule_min_date, '2026-08-26');
    assert.strictEqual(results.e_floor_moves.express_slot_date, '2026-08-26');
    assert.strictEqual(results.e_floor_moves.banner_picker_agree, 'yes');
  });
  it('(f) an inverted range yields NO calendar, not a backwards one', () => {
    assert.strictEqual(results.f_inversion.schedule_min_date, null);
    assert.strictEqual(results.f_inversion.schedule_max_date, null);
    assert.strictEqual(results.f_inversion.express_slot_date, null,
      'express must not survive as a lone bookable day once the calendar is empty');
  });

  // The narrowing is inert for out-of-scope carts: with no applicable decision
  // every added line is skipped, so these two calls run the pre-change path.
  for (const [name, zone, pids] of [['(b) in-city', ZONE_GZ, [P_FRESH]], ['(c) non-fresh', ZONE_CITY, [P_PANTRY]]]) {
    it(`${name} calendar identical with and without the batch decision`, () => {
      const d = retail.earliestBatchMakeDate({ zone, productIds: pids, storeId: STORE_WAREHOUSE, now: NOW, channel: 'wechat' });
      assert.strictEqual(d.applies, false);
      assert.deepStrictEqual(
        retail.computeDeliverySlots(zone, NOW, { batch: d }),
        retail.computeDeliverySlots(zone, NOW),
      );
    });
  }

  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
