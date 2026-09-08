#!/usr/bin/env node
/**
 * §74 — a sold-out fresh meal is orderable for TODAY while today's batch is
 * still coming, and for nothing else.
 *
 *   node scripts/test_fresh_today_batch.js
 *
 * THE LOSS THIS CLOSES, reported by Ash: the shelf empties at 17:00, a customer
 * opens the app at 08:00 the next morning wanting lunch, and the kitchen puts
 * the batch out at 11:00. Every availability decision resolves to
 * inventory.getAvailable — a statement about the shelf NOW — so the app said
 * sold out, offered the NEXT batch day, and the customer bought lunch elsewhere.
 *
 * WHAT IS ACTUALLY BEING PROTECTED HERE IS THE NARROWNESS. Opening today is one
 * line; opening it only on a cooking morning, only before the kitchen finishes,
 * only for stock (never for a store we cannot identify, never past the day's
 * cutoff), and not at all for a tenant that has not named the hour — that is the
 * decision, and every one of those edges is a case below. A suite that only
 * proved "today is offered" would pass on a change that offered today always.
 *
 * Runs against the real sqlite database (data/roots.db, created by database.js
 * on require and gitignored) with seeded rows and a FIXED clock, the same
 * arrangement as test_batch_timing.js, so the dates asserted are observed rather
 * than reasoned about.
 */
'use strict';

// Production runs UTC+8 with no DST and every hour comparison here is local
// time. Pin it BEFORE anything loads, or a UTC host reads 08:00 Guangzhou as
// 00:00 and "before the ready hour" stops meaning what it says.
process.env.TZ = 'Asia/Shanghai';

const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const retail = require(path.join(ROOT, 'routes', 'retail.js'));

const db = tdb();

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
const section = (t) => console.log('\n' + t);

// ── Fixtures ───────────────────────────────────────────────────────────────
// High ids so a dev database's own rows are never touched.
const STORE  = 9111;
const P_FRESH  = 9211;   // batch-made
const P_PANTRY = 9212;   // not batch-made — the cadence is none of its business

// anchor 2026-06-16 + every 2 days ⇒ EVEN days of that run are batch days.
// 2026-09-08 is 84 days on ⇒ a batch day. 2026-09-09 is 85 ⇒ not one.
const SCHEDULE = {
  enabled: true, anchor_date: '2026-06-16', interval_days: 2,
  skip_dates: [], cutoff_hour: 20,
};
const READY_HOUR = 11;

const BATCH_DAY     = '2026-09-08';
const NON_BATCH_DAY = '2026-09-09';
const NEXT_BATCH    = '2026-09-10';

// 08:00 on a cooking morning — the reported moment, three hours before the
// kitchen finishes.
const MORNING_OF_BATCH_DAY = new Date(2026, 8, 8, 8, 0, 0);
// 14:00 the same day: the batch has been made, and a zero shelf now means the
// batch sold out rather than that it has not happened.
const AFTERNOON_OF_BATCH_DAY = new Date(2026, 8, 8, 14, 0, 0);
// 08:00 on a day the kitchen does not cook.
const MORNING_OF_NON_BATCH_DAY = new Date(2026, 8, 9, 8, 0, 0);

const ZONE_GZ = {
  id: 9312, zone_type: 'gz_district', name_en: 'Tianhe', name_cn: '天河区',
  day_only: 0, same_day_allowed: 1, same_day_surcharge: 0,
  min_lead_days: 0, max_lead_days: 14,
  slot_start_hour: 10, slot_end_hour: 20, slot_duration_minutes: 120,
};

function setCfg(key, val) {
  db.prepare(
    `INSERT INTO storefront_config (key, value_json) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
  ).run(key, JSON.stringify(val));
}
function schedule(readyHour) {
  setCfg('batch.schedule', readyHour == null
    ? SCHEDULE
    : { ...SCHEDULE, ready_hour: readyHour });
}
function setStock(productId, qty) {
  db.prepare(
    `INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer)
     VALUES (?,?,?,0)
       ON CONFLICT(store_id, product_id) DO UPDATE SET physical_qty = excluded.physical_qty`
  ).run(STORE, productId, qty);
}

function seed() {
  db.prepare('DELETE FROM retail_store_stock WHERE product_id IN (?,?)').run(P_FRESH, P_PANTRY);
  db.prepare('DELETE FROM store_products WHERE id IN (?,?)').run(P_FRESH, P_PANTRY);
  db.prepare('DELETE FROM retail_stores WHERE id = ?').run(STORE);
  db.prepare(
    `INSERT INTO retail_stores (id, code, name_en, name_cn, city, district, is_active, sort_order)
     VALUES (?,?,?,?,?,?,1,1)`
  ).run(STORE, 'tftb-store', 'Tianhe', '天河', '广州市', '天河区');
  const prod = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_batch_made, oos_policy,
                                 is_published, is_active)
     VALUES (?,?,?,?,?,?,?,1,1)`
  );
  prod.run(P_FRESH,  'Pesto Wrap', '青酱卷', '1-441', 48, 1, 'backorder_gz');
  prod.run(P_PANTRY, 'Olive Oil',  '橄榄油', '2-101', 88, 0, 'strict');
}

// The local-run decision the checkout actually asks for. `localRun: true`
// replaces the zone gate the same way the order path does.
function decide(now, { storeId = STORE, productIds = [P_FRESH] } = {}) {
  return retail.earliestBatchMakeDate({
    zone: null, productIds, storeId, now, channel: 'wechat', localRun: true,
  });
}

seed();

// ═══════════════════════════════════════════════════════════════════════════
section('1 · with no ready hour set, nothing whatsoever changes');
// The off switch, asserted FIRST and against the same clock every case below
// uses. Every tenant is here until an operator types an hour, so if this pair
// ever goes red the change has escaped its config rather than merely misbehaved.
{
  schedule(null);
  setStock(P_FRESH, 0);
  const d = decide(MORNING_OF_BATCH_DAY);
  it('a sold-out fresh meal on a cooking morning still rolls to the next batch', () => {
    assert.strictEqual(d.reason, 'rolled_stock');
    assert.strictEqual(d.make_date, NEXT_BATCH);
  });
  it('…and the browse pill names that same day, not today', () => {
    assert.strictEqual(retail.nextFreshBatchDate(MORNING_OF_BATCH_DAY), NEXT_BATCH);
  });
  it('an out-of-range hour is treated as unset rather than coerced', () => {
    for (const bad of [24, -1, 'eleven', null]) {
      schedule(bad);
      assert.strictEqual(decide(MORNING_OF_BATCH_DAY).reason, 'rolled_stock', `ready_hour=${bad}`);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('2 · the reported case: a cooking morning, before the kitchen finishes');
{
  schedule(READY_HOUR);
  setStock(P_FRESH, 0);
  const d = decide(MORNING_OF_BATCH_DAY);
  it('today is the make day, under its own reason', () => {
    assert.strictEqual(d.reason, 'today_batch_pending');
    assert.strictEqual(d.make_date, BATCH_DAY);
  });
  it('the browse pill names the same day the checkout will — they cannot disagree', () => {
    assert.strictEqual(retail.nextFreshBatchDate(MORNING_OF_BATCH_DAY), d.make_date);
  });
  it('in-stock is untouched: it was never blocked and is not now reasoned about', () => {
    setStock(P_FRESH, 5);
    const live = decide(MORNING_OF_BATCH_DAY);
    assert.strictEqual(live.reason, 'reachable_today');
    setStock(P_FRESH, 0);
  });
  it('a grocery line is not batch-made, so the cart holds no fresh item at all', () => {
    setStock(P_PANTRY, 0);
    assert.strictEqual(decide(MORNING_OF_BATCH_DAY, { productIds: [P_PANTRY] }).reason,
      'no_fresh_items');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('3 · and for nothing else — every edge that must still roll the day');
{
  schedule(READY_HOUR);
  setStock(P_FRESH, 0);

  it('AFTER the ready hour, a zero shelf means the batch sold out — roll forward', () => {
    const d = decide(AFTERNOON_OF_BATCH_DAY);
    assert.strictEqual(d.reason, 'rolled_stock');
    assert.strictEqual(d.make_date, NEXT_BATCH);
  });
  it('on a day the kitchen does not cook, the morning buys nothing', () => {
    const d = decide(MORNING_OF_NON_BATCH_DAY);
    assert.strictEqual(d.reason, 'rolled_stock');
    assert.strictEqual(d.make_date, NEXT_BATCH,
      'the next cooking day, not the non-cooking one the customer is standing in');
    assert.notStrictEqual(NON_BATCH_DAY, d.make_date);
  });
  it('a skipped cooking day is not a cooking day — a holiday still rolls', () => {
    setCfg('batch.schedule', { ...SCHEDULE, ready_hour: READY_HOUR, skip_dates: [BATCH_DAY] });
    const d = decide(MORNING_OF_BATCH_DAY);
    assert.strictEqual(d.reason, 'rolled_stock');
    assert.notStrictEqual(d.make_date, BATCH_DAY);
    schedule(READY_HOUR);
  });
  it('an unresolvable store still rolls: we cannot promise a shelf we cannot name', () => {
    const d = decide(MORNING_OF_BATCH_DAY, { storeId: null });
    assert.strictEqual(d.reason, 'rolled_store_unknown');
  });
  it('the day cutoff still wins, so a ready hour set after it cannot reopen the day', () => {
    // Operator error made harmless: cutoff 07:00, ready 11:00. 08:00 is past the
    // cutoff, so the day is gone whatever the kitchen is about to do.
    //
    // The reason is 'rolled_stock', NOT 'rolled_cutoff', and that is the
    // function's own pre-existing precedence — "stock first: it is the one an
    // operator can act on, and it outranks a cutoff we would have hit anyway".
    // §74 does not disturb it. What is asserted is the thing that matters: the
    // day is not reopened, and the date agrees with the reason.
    setCfg('batch.schedule', { ...SCHEDULE, cutoff_hour: 7, ready_hour: READY_HOUR });
    const d = decide(MORNING_OF_BATCH_DAY);
    assert.notStrictEqual(d.reason, 'today_batch_pending');
    assert.notStrictEqual(d.make_date, BATCH_DAY, 'the closed day must not come back');
    assert.strictEqual(retail.localFreshFloorFor(d).notBeforeHour, null,
      'and no morning-withdrawing hour rides along on a future date');
    // The pill has no cart and no store but it has the clock, so it must reach
    // the same verdict from the terms it CAN ask. Its first version did not read
    // the cutoff at all and named today here while the checkout had rolled past.
    assert.strictEqual(retail.nextFreshBatchDate(MORNING_OF_BATCH_DAY), d.make_date,
      'the pill must not offer a day the checkout has already closed');
    schedule(READY_HOUR);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('4 · the floor both the quote and the order path read');
{
  schedule(READY_HOUR);
  setStock(P_FRESH, 0);
  it('the §74 case floors on TODAY and carries the hour', () => {
    const f = retail.localFreshFloorFor(decide(MORNING_OF_BATCH_DAY));
    assert.deepStrictEqual(f, { date: BATCH_DAY, notBeforeHour: READY_HOUR });
  });
  it('an ordinary shortage floors on a future day and carries no hour', () => {
    const f = retail.localFreshFloorFor(decide(AFTERNOON_OF_BATCH_DAY));
    assert.deepStrictEqual(f, { date: NEXT_BATCH, notBeforeHour: null });
  });
  it('every other reason raises no floor at all', () => {
    setStock(P_FRESH, 5);
    assert.strictEqual(retail.localFreshFloorFor(decide(MORNING_OF_BATCH_DAY)), null,
      'reachable_today');
    setStock(P_FRESH, 0);
    assert.strictEqual(retail.localFreshFloorFor(decide(MORNING_OF_BATCH_DAY, { storeId: null })),
      null, 'rolled_store_unknown — could not check is not the same as short');
    assert.strictEqual(retail.localFreshFloorFor(null), null);
    assert.strictEqual(retail.localFreshFloorFor({ applies: false }), null);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('5 · the calendar withdraws the morning and keeps the afternoon');
// This is where the promise is actually kept. Today stays bookable — that is the
// whole point — but a window that starts before the kitchen finishes cannot be
// honoured however early the order is placed.
{
  schedule(READY_HOUR);
  setStock(P_FRESH, 0);
  const floor = retail.localFreshFloorFor(decide(MORNING_OF_BATCH_DAY));
  const sched = retail.computeDeliverySlots(ZONE_GZ, MORNING_OF_BATCH_DAY, {
    localFreshFloor: floor.date, localFreshNotBeforeHour: floor.notBeforeHour,
  });
  const todaySlots = sched.slots.filter((s) => s.is_same_day);

  it('today is still on offer — the customer is not pushed to tomorrow', () => {
    assert.ok(todaySlots.length > 0, 'expected same-day windows, got none');
  });
  it('no window starts before the kitchen finishes', () => {
    const early = todaySlots.filter((s) => s.start_hour < READY_HOUR);
    assert.strictEqual(early.length, 0,
      `these start before ${READY_HOUR}:00 — ${early.map((s) => s.slot_id).join(', ')}`);
  });
  it('the afternoon survives intact', () => {
    assert.ok(todaySlots.some((s) => s.start_hour >= 12),
      'expected an afternoon window to remain bookable');
  });
  it('"right away" is withdrawn — it names no hour it could be floored to', () => {
    assert.strictEqual(sched.right_away_available, false);
  });

  // Same clock, same zone, no §74 floor: the morning windows are there. Without
  // this the case above passes on a calendar that had already elapsed them.
  it('…and all of that is the floor talking, not the hour of day', () => {
    const open = retail.computeDeliverySlots(ZONE_GZ, MORNING_OF_BATCH_DAY, {});
    assert.ok(open.slots.some((s) => s.is_same_day && s.start_hour < READY_HOUR),
      'unfloored, the 10:00 window is offered at 08:00 — so its absence above is §74');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('6 · nothing new is said to the customer');
// §30 locks Chinese to live sources and no live pair says "made this morning,
// ready from 11". The control ships without the sentence: the calendar simply
// does not offer a window the batch cannot reach. computeLocalFreshNotice keeps
// firing on rolled_stock ALONE, which is the honest state until the pair exists.
{
  schedule(READY_HOUR);
  setStock(P_FRESH, 0);
  const ADDR_GZ = { province: '广东省', city: '广州市', district: '天河区', address: 'x' };
  it('the next-batch notice stays silent on a batch that lands today', () => {
    const n = retail.computeLocalFreshNotice(ADDR_GZ, [P_FRESH], MORNING_OF_BATCH_DAY, 'today',
      { storeId: STORE, decision: decide(MORNING_OF_BATCH_DAY) });
    assert.strictEqual(n, null);
  });
  it('…and still speaks for a batch that lands on a later day', () => {
    const n = retail.computeLocalFreshNotice(ADDR_GZ, [P_FRESH], AFTERNOON_OF_BATCH_DAY, 'today',
      { storeId: STORE, decision: decide(AFTERNOON_OF_BATCH_DAY) });
    assert.ok(n && n.make_date === NEXT_BATCH, 'the ordinary shortage notice is untouched');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('7 · the operator can actually set the hour');
// saveBatchSchedule PUTs batch.schedule WHOLESALE, so a field the card cannot
// read is a field the next save deletes. Both inputs are asserted on the page
// because #batch-cutoff was missing from it entirely — and since the save
// refuses a non-numeric cutoff, the whole card could not be saved with the
// switch on.
{
  const fs = require('fs');
  const html = fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'public/retail-admin/06-delivery.js'), 'utf8');

  it('the order-by hour input exists again, so the card can be saved at all', () => {
    assert.ok(/id="batch-cutoff"/.test(html));
  });
  it('the ready-hour input exists', () => {
    assert.ok(/id="batch-ready"/.test(html));
  });
  it('both labels are live pairs, and no Chinese was composed (§30)', () => {
    // 当日截单 — lifted from this file's own live refusal toast.
    assert.ok(/Order-by hour · 当日截单/.test(html));
    assert.ok(/当日截单请输入 0–23 的小时/.test(js), 'the live source of that half');
    // 厨房已完成 — lifted verbatim from Tacet Mobile.
    assert.ok(/Ready from the kitchen · 厨房已完成/.test(html));
    const m = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
    assert.ok(/厨房已完成/.test(m), 'the live source of that pair');
  });
  it('the save carries ready_hour, or the next save would delete it', () => {
    assert.ok(/ready_hour: readyHour/.test(js));
  });
  it('blank round-trips as blank — the off switch must not pick up a default', () => {
    assert.ok(/batch\.ready_hour != null \? batch\.ready_hour : ''/.test(js));
    assert.ok(/rawReady === '' \? null : parseInt\(rawReady, 10\)/.test(js));
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
