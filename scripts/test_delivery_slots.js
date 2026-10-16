#!/usr/bin/env node
/**
 * test_delivery_slots.js — the delivery times a customer is offered, the check
 * that a picked time is still allowed, and the fresh-batch calendar behind both.
 *
 *   node scripts/test_delivery_slots.js
 *
 * WHAT IT GUARDS. A mutation sweep of routes/retail.js (2026-10-15) broke the
 * slot and batch-calendar code and much of it went unnoticed: the batch
 * schedule settings, the shop-clock cache, "is today's batch still coming",
 * when a picked window closes, the Express day, the today/tomorrow chips, the
 * schedule-for-later calendar and the validator that re-checks a pick when the
 * order is placed. Getting these wrong offers a time the kitchen cannot meet,
 * refuses one it can, or drops the same-day surcharge.
 *
 * HOW. The real code is lifted from the source (retailSource(), so it is found
 * in routes/retail.js or in lib/ after decisions §477 moves it) and run with the
 * real lib/business-date.js and lib/batch-cadence.js, over the real
 * store_products table. The clock is FIXED and every instant is built in the
 * shop's zone (Asia/Shanghai), so the runner's own timezone never matters.
 * Every expected value below is worked out by hand from the rules, not read
 * back from the code.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openMemoryDb, addForkedStoreProducts } = require('./test-support/memory-db');
const { retailSource } = require('./test-support/retail-source');

const ROOT = path.join(__dirname, '..');
const SRC = retailSource();
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const SCHEMA_SRC = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
const realBusinessDate = require(path.join(ROOT, 'lib', 'business-date'));
const batchCadence = require(path.join(ROOT, 'lib', 'batch-cadence'));

// A top-level declaration by name: a function to its closing brace, a one-line
// const to the end of its line.
function declSrc(name) {
  const at = SRC.search(new RegExp(`^(function ${name}\\(|(const|let) ${name}\\b)`, 'm'));
  assert.ok(at >= 0, `${name} not found`);
  if (SRC.startsWith('function', at)) return SRC.slice(at, SRC.indexOf('\n}', at) + 2);
  return SRC.slice(at, SRC.indexOf('\n', at));
}

const TZ = 'Asia/Shanghai';
const at = (ymd, h = 0, m = 0) => realBusinessDate.dateInZone(TZ, ymd, h, m);

const db = openMemoryDb();
addForkedStoreProducts(db, SCHEMA_SRC, DB_SRC);
const ins = db.prepare('INSERT INTO store_products (id, sku, name_en, name_cn, is_batch_made) VALUES (?, ?, ?, ?, ?)');
ins.run(1, '1-440', 'Pesto Wrap', '香蒜卷', 1);
ins.run(2, '2-100', 'Granola', '燕麦', 0);

let CFG = {};
const cfgValue = (k, d) => (k in CFG ? CFG[k] : d);

// The shop clock as deliveryTz() reads it: which tenant is current, what zone
// that tenant's shop is in, and how many times the zone was looked up.
const W = { tid: 1, tzFor: { 1: TZ, 5: 'Europe/London', 6: 'America/Los_Angeles' }, lookups: 0, throwTid: false, throwTz: false };
const businessDate = {
  ...realBusinessDate,
  shopTimezone: () => {
    W.lookups++;
    if (W.throwTz) throw new Error('no table');
    return W.tzFor[W.tid] || null;
  },
};
// Date.now() as deliveryTz() sees it, so the cache's one-minute life can be
// stepped through. Everything else about Date is the real one.
let CLOCK = null;
class FakeDate extends Date {
  static now() { return CLOCK == null ? Date.now() : CLOCK; }
}

const NAMES = ['batchScheduleCfg', '_tzCache', 'DELIVERY_TZ_TTL_MS', 'deliveryTz', 'parseYmdLocal', 'toYmdLocal',
  'tzNowParts', 'nextBatchShipDate', 'batchItemsInCart', 'todaysBatchStillComing', 'slotWindowEnd',
  'freshLinesCoveredToday', 'expressEarliestIso', 'hhmmToMinutes', 'storeDeliveryWindow', 'computeDeliverySlots',
  'matchScheduledTimeSlot', 'logSlotKindMismatch', 'resolveDeliverySlot'];
const F = new Function('cfgValue', 'tdb', 'currentTenantId', 'businessDate', 'batchCadence', 'Date',
  `${NAMES.map(declSrc).join('\n')}\nreturn { ${NAMES.filter((n) => n !== 'DELIVERY_TZ_TTL_MS').join(', ')} };`)(
  cfgValue, () => db, () => { if (W.throwTid) throw new Error('no tenant'); return W.tid; },
  businessDate, batchCadence, FakeDate);

// Batch every other day from Thursday 2026-10-15, so the 15th, 17th, 19th ...
// are batch days. Today's batch lands at 11:00; ordering for today shuts at 20:00.
const SCHEDULE = { enabled: true, anchor_date: '2026-10-15', interval_days: 2, skip_dates: [], cutoff_hour: 20, ready_hour: 11 };

let pass = 0, fail = 0;
const pending = [];
const section = (t) => pending.push(() => console.log('\n' + t));
const it = (name, fn) => pending.push(() => {
  CFG = {}; CLOCK = null; W.tid = 1; W.throwTid = false; W.throwTz = false; F._tzCache.clear();
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
});

// ── 1. the batch schedule settings ─────────────────────────────────────────
section('1. the batch schedule settings are read safely');
it('missing, switched off, no anchor, or a malformed anchor all mean "no schedule"', () => {
  assert.strictEqual(F.batchScheduleCfg(), null);
  for (const c of [{ enabled: false, anchor_date: '2026-10-15' }, { enabled: true }, { enabled: true, anchor_date: '2026-1-5' }]) {
    CFG['batch.schedule'] = c;
    assert.strictEqual(F.batchScheduleCfg(), null, JSON.stringify(c));
  }
});
it('the interval is a whole number of days, at least one, two when unset or zero', () => {
  const interval = (v) => { CFG['batch.schedule'] = { enabled: true, anchor_date: '2026-10-15', interval_days: v }; return F.batchScheduleCfg().interval_days; };
  assert.strictEqual(interval('3'), 3);
  assert.strictEqual(interval(undefined), 2);
  assert.strictEqual(interval(0), 2);
  assert.strictEqual(interval(-5), 1);
});
it('closure days keep only real dates; anything else is no closures', () => {
  CFG['batch.schedule'] = { enabled: true, anchor_date: '2026-10-15', skip_dates: ['2026-10-17', 'soon', 20261019] };
  assert.deepStrictEqual(F.batchScheduleCfg().skip_dates, ['2026-10-17']);
  CFG['batch.schedule'] = { enabled: true, anchor_date: '2026-10-15', skip_dates: '2026-10-17' };
  assert.deepStrictEqual(F.batchScheduleCfg().skip_dates, []);
});
it('the cutoff hour is 0–23; out of range it borrows the reschedule cutoff, and failing that 20', () => {
  const cut = (v, fallback) => {
    CFG = { 'batch.schedule': { enabled: true, anchor_date: '2026-10-15', cutoff_hour: v } };
    if (fallback !== undefined) CFG['fresh.rescheduleCutoffHour'] = fallback;
    return F.batchScheduleCfg().cutoff_hour;
  };
  assert.strictEqual(cut(18), 18);
  assert.strictEqual(cut(0), 0);
  assert.strictEqual(cut(23), 23);
  assert.strictEqual(cut(24, 21), 21);
  assert.strictEqual(cut(-1, 0), 0);
  assert.strictEqual(cut(undefined, 23), 23);
  assert.strictEqual(cut(undefined, 24), 20);
  assert.strictEqual(cut(undefined, -1), 20);
  assert.strictEqual(cut(undefined), 20);
});
it('the ready hour is 0–23, and anything else switches it off (null)', () => {
  const ready = (v) => { CFG['batch.schedule'] = { enabled: true, anchor_date: '2026-10-15', ready_hour: v }; return F.batchScheduleCfg().ready_hour; };
  assert.strictEqual(ready(0), 0);
  assert.strictEqual(ready(23), 23);
  assert.strictEqual(ready('11'), 11);
  assert.strictEqual(ready(24), null);
  assert.strictEqual(ready(-1), null);
  assert.strictEqual(ready(undefined), null);
});
it('popup copy is kept when it is text and blanked when it is not', () => {
  CFG['batch.schedule'] = { enabled: true, anchor_date: '2026-10-15', title_en: 'Made fresh', title_cn: 5, local_message_cn: '{make_date}' };
  const c = F.batchScheduleCfg();
  assert.strictEqual(c.title_en, 'Made fresh');
  assert.strictEqual(c.title_cn, '');
  assert.strictEqual(c.local_message_cn, '{make_date}');
  assert.strictEqual(c.tip_en, '');
});

// ── 2. the shop's clock ────────────────────────────────────────────────────
section('2. the shop clock: looked up per tenant, remembered for one minute');
it('a second read inside the minute is remembered; at a full minute it is looked up again', () => {
  W.tid = 5; CLOCK = 1_000_000; W.lookups = 0;
  assert.strictEqual(F.deliveryTz(), 'Europe/London');
  CLOCK = 1_000_000 + 59_999;
  assert.strictEqual(F.deliveryTz(), 'Europe/London');
  assert.strictEqual(W.lookups, 1);
  CLOCK = 1_000_000 + 60_000;
  F.deliveryTz();
  assert.strictEqual(W.lookups, 2);
});
it('one tenant\'s remembered zone never answers for another', () => {
  CLOCK = 5_000_000;
  W.tid = 5; assert.strictEqual(F.deliveryTz(), 'Europe/London');
  W.tid = 6; assert.strictEqual(F.deliveryTz(), 'America/Los_Angeles');
  W.tid = 5; assert.strictEqual(F.deliveryTz(), 'Europe/London');
});
it('no zone set, a failed lookup, or no tenant at all give null (the system default), not a crash', () => {
  W.tid = 7; assert.strictEqual(F.deliveryTz(), null);
  F._tzCache.clear(); W.throwTz = true; assert.strictEqual(F.deliveryTz(), null);
  F._tzCache.clear(); W.throwTz = false; W.throwTid = true; W.tid = 5;
  assert.strictEqual(F.deliveryTz(), 'Europe/London');
  assert.deepStrictEqual([...F._tzCache.keys()], [0], 'remembered under tenant 0');
});
it('the date and hour are read on the shop\'s clock, from the instant given', () => {
  const p = F.tzNowParts(at('2026-10-16', 1, 5), TZ);
  assert.strictEqual(p.ymd, '2026-10-16');
  assert.strictEqual(p.hour, 1);
  assert.strictEqual(p.minute, 5);
  assert.strictEqual(F.tzNowParts(at('2026-10-16', 1, 5), 'Europe/London').ymd, '2026-10-15');
  assert.strictEqual(F.tzNowParts(undefined, TZ).ymd, realBusinessDate.businessDate(TZ, new Date()));
});

// ── 3. the batch calendar ──────────────────────────────────────────────────
section('3. the batch calendar');
it('the next batch day is today on a batch day, otherwise the next one, rolling past closures', () => {
  CFG['batch.schedule'] = SCHEDULE;
  assert.strictEqual(F.nextBatchShipDate(at('2026-10-15', 10), null, TZ), '2026-10-15');
  assert.strictEqual(F.nextBatchShipDate(at('2026-10-16', 10), null, TZ), '2026-10-17');
  const skip = { ...F.batchScheduleCfg(), skip_dates: ['2026-10-17'] };
  assert.strictEqual(F.nextBatchShipDate(at('2026-10-16', 10), skip, TZ), '2026-10-19');
});
it('the day is the shop\'s day: 01:00 Friday in Shanghai is still Thursday in Los Angeles', () => {
  CFG['batch.schedule'] = SCHEDULE;
  assert.strictEqual(F.nextBatchShipDate(at('2026-10-16', 1), null, TZ), '2026-10-17');
  assert.strictEqual(F.nextBatchShipDate(at('2026-10-16', 1), null, 'America/Los_Angeles'), '2026-10-15');
});
it('the fresh items in a cart are found once each; everything else is ignored', () => {
  assert.deepStrictEqual(F.batchItemsInCart([1, '1', 2, 0, null, 'x']), [{ id: 1, name_en: 'Pesto Wrap', name_cn: '香蒜卷' }]);
  assert.deepStrictEqual(F.batchItemsInCart([2]), []);
  assert.deepStrictEqual(F.batchItemsInCart([]), []);
  assert.deepStrictEqual(F.batchItemsInCart(null), []);
});
it('today\'s batch is "still coming" before the ready hour, on a batch day', () => {
  CFG['batch.schedule'] = SCHEDULE;
  assert.deepStrictEqual(F.todaysBatchStillComing(at('2026-10-15', 10, 59), TZ), { readyHour: 11, dateIso: '2026-10-15' });
});
it('...and not from the ready hour on, nor on a day off', () => {
  CFG['batch.schedule'] = SCHEDULE;
  assert.strictEqual(F.todaysBatchStillComing(at('2026-10-15', 11, 0), TZ), null);
  assert.strictEqual(F.todaysBatchStillComing(at('2026-10-16', 9, 0), TZ), null);
});
it('...nor once the day\'s ordering cutoff has passed, even before the ready hour', () => {
  CFG['batch.schedule'] = { ...SCHEDULE, cutoff_hour: 9 };
  assert.strictEqual(F.todaysBatchStillComing(at('2026-10-15', 9, 30), TZ), null);
  assert.deepStrictEqual(F.todaysBatchStillComing(at('2026-10-15', 8, 59), TZ), { readyHour: 11, dateIso: '2026-10-15' });
});
it('...and never when no ready hour is set, or there is no schedule', () => {
  CFG['batch.schedule'] = { ...SCHEDULE, ready_hour: undefined };
  assert.strictEqual(F.todaysBatchStillComing(at('2026-10-15', 8), TZ), null);
  delete CFG['batch.schedule'];
  assert.strictEqual(F.todaysBatchStillComing(at('2026-10-15', 8), TZ), null);
});

// ── 4. when a picked window closes, and what today's batch covers ──────────
section('4. when a picked window closes, and which fresh lines today\'s batch covers');
it('a time window closes its length after it starts; two hours when the zone does not say', () => {
  assert.strictEqual(F.slotWindowEnd({}, '2026-10-15T10:00', null, TZ).getTime(), at('2026-10-15', 12).getTime());
  assert.strictEqual(F.slotWindowEnd(null, '2026-10-15T10:00', null, TZ).getTime(), at('2026-10-15', 12).getTime());
  assert.strictEqual(F.slotWindowEnd({ slot_duration_minutes: 90 }, '2026-10-15T10:00', null, TZ).getTime(), at('2026-10-15', 11, 30).getTime());
  assert.strictEqual(F.slotWindowEnd({ slot_duration_minutes: 0 }, '2026-10-15T10:00', null, TZ).getTime(), at('2026-10-15', 12).getTime());
});
it('a whole-day pick closes when the kitchen does; 20:00 when the zone does not say', () => {
  assert.strictEqual(F.slotWindowEnd({}, '2026-10-15', null, TZ).getTime(), at('2026-10-15', 20).getTime());
  assert.strictEqual(F.slotWindowEnd({ slot_end_hour: 18 }, '2026-10-15', null, TZ).getTime(), at('2026-10-15', 18).getTime());
  assert.strictEqual(F.slotWindowEnd({ slot_end_hour: 0 }, '2026-10-15', null, TZ).getTime(), at('2026-10-15', 20).getTime());
});
it('"right away", nothing, or a garbled id close at no time at all', () => {
  assert.strictEqual(F.slotWindowEnd({}, 'right_away', null, TZ), null);
  assert.strictEqual(F.slotWindowEnd({}, '', null, TZ), null);
  assert.strictEqual(F.slotWindowEnd({}, 'tomorrow', null, TZ), null);
});
it('the window is read on the shop\'s clock: 10:00 in London is 09:00 UTC', () => {
  assert.strictEqual(F.slotWindowEnd({}, '2026-10-15T10:00', null, 'Europe/London').toISOString(), '2026-10-15T11:00:00.000Z');
});
it('a window that ends when the batch lands, or after, is covered — only its fresh lines', () => {
  CFG['batch.schedule'] = SCHEDULE;
  const cover = (slot, zone = {}) => [...F.freshLinesCoveredToday({ zone, deliverySlotId: slot, productIds: [1, 2, '1'], now: at('2026-10-15', 9), tz: TZ })];
  assert.deepStrictEqual(cover('2026-10-15T10:00'), [1]);
  assert.deepStrictEqual(cover('2026-10-15T09:00'), [1], 'ends 11:00, the minute the batch lands');
  assert.deepStrictEqual(cover('2026-10-15'), [1]);
});
it('a window that closes before the batch lands is not covered', () => {
  CFG['batch.schedule'] = SCHEDULE;
  const out = F.freshLinesCoveredToday({ zone: { slot_duration_minutes: 60 }, deliverySlotId: '2026-10-15T09:00', productIds: [1], now: at('2026-10-15', 9), tz: TZ });
  assert.strictEqual(out.size, 0);
});
it('nothing is covered for "right away", or once the batch has landed', () => {
  CFG['batch.schedule'] = SCHEDULE;
  assert.strictEqual(F.freshLinesCoveredToday({ zone: {}, deliverySlotId: 'right_away', productIds: [1], now: at('2026-10-15', 9), tz: TZ }).size, 0);
  assert.strictEqual(F.freshLinesCoveredToday({ zone: {}, deliverySlotId: '2026-10-15T14:00', productIds: [1], now: at('2026-10-15', 11), tz: TZ }).size, 0);
});

// ── 5. the Express day ─────────────────────────────────────────────────────
section('5. the Express ("ship as soon as possible") day');
it('never earlier than tomorrow; otherwise the zone\'s own lead in days', () => {
  const now = at('2026-10-15', 11, 30);
  assert.strictEqual(F.expressEarliestIso(null, now, TZ), '2026-10-16');
  assert.strictEqual(F.expressEarliestIso({ min_lead_days: 0 }, now, TZ), '2026-10-16');
  assert.strictEqual(F.expressEarliestIso({ min_lead_days: 1 }, now, TZ), '2026-10-16');
  assert.strictEqual(F.expressEarliestIso({ min_lead_days: 2 }, now, TZ), '2026-10-17');
  assert.strictEqual(F.expressEarliestIso({ min_lead_days: 5 }, now, TZ), '2026-10-20');
});
it('a negative or garbled lead counts as none', () => {
  const now = at('2026-10-15', 11, 30);
  assert.strictEqual(F.expressEarliestIso({ min_lead_days: -3 }, now, TZ), '2026-10-16');
  assert.strictEqual(F.expressEarliestIso({ min_lead_days: 'abc' }, now, TZ), '2026-10-16');
});
it('"tomorrow" is the shop\'s tomorrow: 02:00 Friday in Shanghai is Thursday evening in London', () => {
  assert.strictEqual(F.expressEarliestIso({}, at('2026-10-16', 2), TZ), '2026-10-17');
  assert.strictEqual(F.expressEarliestIso({}, at('2026-10-16', 2), 'Europe/London'), '2026-10-16');
});

// ── 6. the times on offer ──────────────────────────────────────────────────
const slots = (zone, now, opts = {}) => F.computeDeliverySlots(zone, now, { tz: TZ, ...opts });
const ids = (list) => list.map((s) => s.slot_id);

section('6. the times on offer: time-window zones (Guangzhou districts)');
it('mid-morning: today\'s windows that have not started, "right away", and the calendar from day 3', () => {
  const r = slots({}, at('2026-10-15', 11, 30));
  assert.strictEqual(r.mode, 'time_slots');
  assert.strictEqual(r.right_away_available, true);
  assert.strictEqual(r.kitchen_open_now, true);
  assert.strictEqual(r.slot_day_kind, 'today');
  assert.deepStrictEqual(ids(r.today_slots), ['2026-10-15T12:00', '2026-10-15T14:00', '2026-10-15T16:00', '2026-10-15T18:00']);
  assert.deepStrictEqual(r.today_slots[0], {
    slot_id: '2026-10-15T12:00', date_iso: '2026-10-15',
    start_hour: 12, start_minute: 0, end_hour: 14, end_minute: 0,
    is_same_day: true, is_day_only: false, requires_surcharge: false, surcharge: 0,
    label_en: 'Today 12PM–2PM', label_cn: '今天 12:00–14:00',
  });
  assert.strictEqual(r.today_slots[3].label_en, 'Today 6PM–8PM');
  assert.deepStrictEqual(r.slots, r.today_slots);
  assert.deepStrictEqual(r.schedule, { min_date: '2026-10-18', max_date: '2026-10-29', surcharge: 0 });
  assert.strictEqual(r.express_slot, null);
  assert.strictEqual(r.today_day_chip, null);
  assert.deepStrictEqual(r.kitchen_hours, { start: 10, end: 20 });
  assert.strictEqual(r.slot_duration_minutes, 120);
  assert.strictEqual(r.same_day_cutoff_passed, false);
  assert.strictEqual(r.same_day_cutoff_message, null);
  assert.strictEqual(r.holiday_mode, false);
  assert.strictEqual(r.holiday_message, null);
});
it('a window that starts this very minute is gone; one starting a minute later is not', () => {
  assert.strictEqual(slots({}, at('2026-10-15', 11, 59)).today_slots[0].slot_id, '2026-10-15T12:00');
  assert.strictEqual(slots({}, at('2026-10-15', 12, 0)).today_slots[0].slot_id, '2026-10-15T14:00');
});
it('before opening: no "right away", but all of today\'s windows, and the kitchen "reopens today"', () => {
  const r = slots({}, at('2026-10-15', 8));
  assert.strictEqual(r.kitchen_open_now, false);
  assert.strictEqual(r.right_away_available, false);
  assert.strictEqual(r.kitchen_reopens_today, true);
  assert.deepStrictEqual(ids(r.today_slots), ['2026-10-15T10:00', '2026-10-15T12:00', '2026-10-15T14:00', '2026-10-15T16:00', '2026-10-15T18:00']);
  assert.strictEqual(slots({}, at('2026-10-15', 10)).kitchen_open_now, true);
});
it('after close: tomorrow\'s windows instead, at no surcharge, and not "reopens today"', () => {
  const r = slots({ same_day_surcharge: 8 }, at('2026-10-15', 20));
  assert.strictEqual(r.kitchen_open_now, false);
  assert.strictEqual(r.kitchen_reopens_today, false);
  assert.strictEqual(r.slot_day_kind, 'tomorrow');
  assert.deepStrictEqual(ids(r.today_slots), ['2026-10-16T10:00', '2026-10-16T12:00', '2026-10-16T14:00', '2026-10-16T16:00', '2026-10-16T18:00']);
  assert.deepStrictEqual(r.today_slots[0], {
    slot_id: '2026-10-16T10:00', date_iso: '2026-10-16',
    start_hour: 10, start_minute: 0, end_hour: 12, end_minute: 0,
    is_same_day: false, is_day_only: false, requires_surcharge: false, surcharge: 0,
    label_en: 'Tomorrow 10AM–12PM', label_cn: '明天 10:00–12:00',
  });
});
it('a same-day surcharge is charged on today\'s windows and turns off "right away"', () => {
  const r = slots({ same_day_surcharge: 8 }, at('2026-10-15', 11, 30));
  assert.strictEqual(r.right_away_available, false);
  assert.strictEqual(r.same_day_surcharge, 8);
  assert.strictEqual(r.today_slots[0].requires_surcharge, true);
  assert.strictEqual(r.today_slots[0].surcharge, 8);
});
it('the last 10 minutes before close: same-day stops, the message says why, tomorrow is offered', () => {
  const before = slots({}, at('2026-10-15', 19, 49));
  assert.strictEqual(before.same_day_cutoff_passed, false);
  assert.strictEqual(before.right_away_available, true);
  const r = slots({}, at('2026-10-15', 19, 50));
  assert.strictEqual(r.same_day_cutoff_passed, true);
  assert.strictEqual(r.same_day_cutoff_minutes, 10);
  assert.strictEqual(r.right_away_available, false);
  assert.strictEqual(r.slot_day_kind, 'tomorrow');
  assert.deepStrictEqual(r.same_day_cutoff_message, {
    en: "Too late for same-day delivery — we stop taking today's orders 10 min before we close at 8pm. Please choose a time for tomorrow.",
    cn: '已过今日配送截单时间 — 关门前 10 分钟停止接单(今日 20:00 关门)。请选择明天的配送时段。',
  });
});
it('the operator\'s own cutoff wording wins where it is filled in, trimmed', () => {
  CFG['delivery.sameDayCutoffMessage'] = { en: '  We are closing up  ', cn: '   ' };
  const m = slots({}, at('2026-10-15', 19, 55)).same_day_cutoff_message;
  assert.strictEqual(m.en, 'We are closing up');
  assert.ok(m.cn.startsWith('已过今日配送截单时间'), m.cn);
});
it('the cutoff buffer: 0 turns it off, negative counts as 0, and it can never exceed the open hours', () => {
  CFG['delivery.sameDayCutoffMinutes'] = 0;
  assert.strictEqual(slots({}, at('2026-10-15', 19, 59)).right_away_available, true);
  CFG['delivery.sameDayCutoffMinutes'] = -5;
  assert.strictEqual(slots({}, at('2026-10-15', 19, 59)).same_day_cutoff_minutes, 0);
  CFG['delivery.sameDayCutoffMinutes'] = 999;
  const r = slots({}, at('2026-10-15', 10, 0));
  assert.strictEqual(r.same_day_cutoff_minutes, 600);
  assert.strictEqual(r.same_day_cutoff_passed, true);
});
it('the close time is written in 12-hour English: noon is 12pm, 11 is 11am', () => {
  assert.ok(slots({ slot_start_hour: 8, slot_end_hour: 12 }, at('2026-10-15', 11, 55)).same_day_cutoff_message.en.includes('close at 12pm'));
  const r = slots({ slot_start_hour: 8, slot_end_hour: 11 }, at('2026-10-15', 10, 55));
  assert.ok(r.same_day_cutoff_message.en.includes('close at 11am'), r.same_day_cutoff_message.en);
  assert.ok(r.same_day_cutoff_message.cn.includes('今日 11:00 关门'), r.same_day_cutoff_message.cn);
});
it('midnight on the chip reads 12AM', () => {
  const r = slots({ slot_start_hour: 0, slot_end_hour: 2 }, at('2026-10-14', 23));
  assert.strictEqual(r.today_slots[0].label_en, 'Tomorrow 12AM–2AM');
  assert.strictEqual(r.today_slots[0].label_cn, '明天 0:00–2:00');
});
it('odd window lengths: 90 minutes from 10:00 to 13:00 is two windows', () => {
  const r = slots({ slot_start_hour: 10, slot_end_hour: 13, slot_duration_minutes: 90 }, at('2026-10-15', 8));
  assert.deepStrictEqual(ids(r.today_slots), ['2026-10-15T10:00', '2026-10-15T11:30']);
  assert.strictEqual(r.today_slots[0].label_en, 'Today 10AM–11AM');
  assert.strictEqual(r.today_slots[1].start_minute, 30);
  assert.strictEqual(r.today_slots[1].label_cn, '今天 11:30–13:00');
});
it('a window may run one minute past close, and is cut back to the close', () => {
  const r = slots({ slot_start_hour: 10, slot_end_hour: 11, slot_duration_minutes: 61 }, at('2026-10-15', 8));
  assert.deepStrictEqual(ids(r.today_slots), ['2026-10-15T10:00']);
  assert.strictEqual(r.today_slots[0].end_hour, 11);
  assert.strictEqual(r.today_slots[0].end_minute, 0);
});
it('a one-day lead skips today but still offers tomorrow; two days offers neither', () => {
  const one = slots({ min_lead_days: 1 }, at('2026-10-15', 11, 30));
  assert.strictEqual(one.slot_day_kind, 'tomorrow');
  assert.strictEqual(one.right_away_available, false);
  const two = slots({ min_lead_days: 2 }, at('2026-10-15', 11, 30));
  assert.deepStrictEqual(two.today_slots, []);
  assert.strictEqual(two.slot_day_kind, null);
});
it('same day switched off for the zone: no today, but tomorrow', () => {
  const r = slots({ same_day_allowed: 0 }, at('2026-10-15', 11, 30));
  assert.strictEqual(r.same_day_allowed, false);
  assert.strictEqual(r.slot_day_kind, 'tomorrow');
});
it('holiday mode withdraws same day, shows its message, and keeps tomorrow and the calendar', () => {
  CFG['delivery.holidayMode'] = true;
  CFG['delivery.holidayMessage'] = { en: 'Closed for the holiday', cn: '假期休息' };
  const r = slots({}, at('2026-10-15', 11, 30));
  assert.strictEqual(r.holiday_mode, true);
  assert.deepStrictEqual(r.holiday_message, { en: 'Closed for the holiday', cn: '假期休息' });
  assert.strictEqual(r.right_away_available, false);
  assert.strictEqual(r.slot_day_kind, 'tomorrow');
  assert.deepStrictEqual(r.schedule, { min_date: '2026-10-18', max_date: '2026-10-29', surcharge: 0 });
});
it('bad zone settings are repaired, not looped on', () => {
  const r = slots({ slot_duration_minutes: 0, slot_start_hour: 12, slot_end_hour: 12, min_lead_days: -2 }, at('2026-10-15', 8));
  assert.strictEqual(r.slot_duration_minutes, 120);
  assert.deepStrictEqual(r.kitchen_hours, { start: 12, end: 13 });
  assert.strictEqual(r.min_lead_days, 0);
  assert.deepStrictEqual(slots({ slot_start_hour: 20, slot_end_hour: 10 }, at('2026-10-15', 8)).kitchen_hours, { start: 20, end: 21 });
});
it('a booking horizon shorter than the lead becomes lead + 7; equal is left alone', () => {
  const short = slots({ min_lead_days: 3, max_lead_days: 1 }, at('2026-10-15', 11, 30));
  assert.strictEqual(short.max_lead_days, 10);
  assert.deepStrictEqual(short.schedule, { min_date: '2026-10-18', max_date: '2026-10-25', surcharge: 0 });
  const equal = slots({ min_lead_days: 4, max_lead_days: 4 }, at('2026-10-15', 11, 30));
  assert.deepStrictEqual(equal.schedule, { min_date: '2026-10-19', max_date: '2026-10-19', surcharge: 0 });
});
it('the calendar is exactly day 3 when the horizon is 3 days, and absent when it is 2', () => {
  assert.deepStrictEqual(slots({ max_lead_days: 3 }, at('2026-10-15', 11, 30)).schedule, { min_date: '2026-10-18', max_date: '2026-10-18', surcharge: 0 });
  assert.strictEqual(slots({ max_lead_days: 2 }, at('2026-10-15', 11, 30)).schedule, null);
});
it('the shop\'s clock decides "today": 02:00 Friday in Shanghai is 19:00 Thursday in London', () => {
  const sh = slots({}, at('2026-10-16', 2));
  assert.strictEqual(sh.slot_day_kind, 'today');
  assert.strictEqual(sh.today_slots[0].slot_id, '2026-10-16T10:00');
  assert.strictEqual(sh.right_away_available, false);
  const ldn = slots({}, at('2026-10-16', 2), { tz: 'Europe/London' });
  assert.strictEqual(ldn.slot_day_kind, 'tomorrow');
  assert.strictEqual(ldn.today_slots[0].slot_id, '2026-10-16T10:00');
  assert.strictEqual(ldn.right_away_available, true);
});
it('with no zone given in the call, the tenant\'s own zone is used', () => {
  W.tid = 5;
  const r = F.computeDeliverySlots({}, at('2026-10-16', 2));
  assert.strictEqual(r.slot_day_kind, 'tomorrow');
});

section('7. the times on offer: whole-day zones (Panyu, out-of-city)');
const PANYU = { day_only: 1, same_day_surcharge: 15 };
it('before close: a surcharged "Today" chip, and a free Express day for tomorrow', () => {
  const r = slots(PANYU, at('2026-10-15', 11));
  assert.strictEqual(r.mode, 'day_only');
  assert.strictEqual(r.right_away_available, false);
  assert.strictEqual(r.slot_day_kind, 'today');
  assert.deepStrictEqual(r.today_day_chip, {
    slot_id: '2026-10-15', date_iso: '2026-10-15', is_same_day: true, is_day_only: true,
    requires_surcharge: true, surcharge: 15, label_en: 'Today', label_cn: '今天',
  });
  assert.deepStrictEqual(r.express_slot, {
    slot_id: '2026-10-16', date_iso: '2026-10-16', is_same_day: false, is_day_only: true,
    requires_surcharge: false, surcharge: 0, label_en: 'Earliest 2026-10-16', label_cn: '最早 2026-10-16',
  });
  assert.deepStrictEqual(r.slots, [r.today_day_chip]);
  assert.deepStrictEqual(r.today_slots, []);
});
it('a "Today" chip with no surcharge configured charges nothing', () => {
  const chip = slots({ day_only: 1 }, at('2026-10-15', 11)).today_day_chip;
  assert.strictEqual(chip.requires_surcharge, false);
  assert.strictEqual(chip.surcharge, 0);
});
it('at close, or inside the last 10 minutes, no "Today": the Express day is the only choice', () => {
  assert.ok(slots(PANYU, at('2026-10-15', 19)).today_day_chip);
  for (const now of [at('2026-10-15', 19, 59), at('2026-10-15', 20)]) {
    const r = slots(PANYU, now);
    assert.strictEqual(r.today_day_chip, null);
    assert.strictEqual(r.slot_day_kind, null);
    assert.deepStrictEqual(ids(r.slots), ['2026-10-16']);
  }
});
it('an out-of-city zone with a two-day lead: no Today, Express in two days, calendar from day 3', () => {
  const r = slots({ day_only: 1, min_lead_days: 2, max_lead_days: 10 }, at('2026-10-15', 11));
  assert.strictEqual(r.today_day_chip, null);
  assert.strictEqual(r.express_slot.slot_id, '2026-10-17');
  assert.deepStrictEqual(r.schedule, { min_date: '2026-10-18', max_date: '2026-10-25', surcharge: 0 });
  assert.deepStrictEqual(ids(r.slots), ['2026-10-17']);
});
it('a five-day lead moves the calendar start to day 5 as well', () => {
  const r = slots({ day_only: 1, min_lead_days: 5, max_lead_days: 10 }, at('2026-10-15', 11));
  assert.strictEqual(r.express_slot.slot_id, '2026-10-20');
  assert.strictEqual(r.schedule.min_date, '2026-10-20');
});

section('8. a fresh cart moves the earliest day');
it('a shipped fresh cart: the calendar and Express start the day after the batch is made', () => {
  const batch = { applies: true, make_date: '2026-10-20' };
  assert.strictEqual(slots({}, at('2026-10-15', 11, 30), { batch }).schedule.min_date, '2026-10-21');
  assert.strictEqual(slots(PANYU, at('2026-10-15', 11), { batch }).express_slot.slot_id, '2026-10-21');
});
it('...but a batch decision that does not apply changes nothing', () => {
  const r = slots({}, at('2026-10-15', 11, 30), { batch: { applies: false, make_date: '2026-10-20' } });
  assert.strictEqual(r.schedule.min_date, '2026-10-18');
});
it('...and a batch the booking horizon cannot reach leaves no calendar and no Express day', () => {
  const r = slots(PANYU, at('2026-10-15', 11), { batch: { applies: true, make_date: '2026-10-29' } });
  assert.strictEqual(r.schedule, null);
  assert.strictEqual(r.express_slot, null);
  const edge = slots({}, at('2026-10-15', 11, 30), { batch: { applies: true, make_date: '2026-10-28' } });
  assert.deepStrictEqual(edge.schedule, { min_date: '2026-10-29', max_date: '2026-10-29', surcharge: 0 });
});
it('a sold-out Guangzhou fresh cart made tomorrow: no today and no "right away", tomorrow is fine', () => {
  const r = slots({}, at('2026-10-15', 11, 30), { localFreshFloor: '2026-10-16' });
  assert.strictEqual(r.right_away_available, false);
  assert.strictEqual(r.slot_day_kind, 'tomorrow');
  assert.strictEqual(r.today_slots[0].date_iso, '2026-10-16');
});
it('...made the day after tomorrow: no chips at all, and the calendar as usual', () => {
  const r = slots({}, at('2026-10-15', 11, 30), { localFreshFloor: '2026-10-17' });
  assert.deepStrictEqual(r.today_slots, []);
  assert.strictEqual(r.slot_day_kind, null);
  assert.strictEqual(r.schedule.min_date, '2026-10-18');
});
it('...made later than the calendar would start: the calendar starts on the make day', () => {
  assert.strictEqual(slots({}, at('2026-10-15', 11, 30), { localFreshFloor: '2026-10-20' }).schedule.min_date, '2026-10-20');
});
it('a batch earlier than the zone\'s own lead never pulls the Express day earlier', () => {
  const r = slots({ day_only: 1, min_lead_days: 5, max_lead_days: 10 }, at('2026-10-15', 11), { batch: { applies: true, make_date: '2026-10-17' } });
  assert.strictEqual(r.express_slot.slot_id, '2026-10-20');
  assert.strictEqual(r.schedule.min_date, '2026-10-20');
});
it('...made today: today\'s windows and "right away" stay', () => {
  const r = slots({}, at('2026-10-15', 11, 30), { localFreshFloor: '2026-10-15' });
  assert.strictEqual(r.right_away_available, true);
  assert.strictEqual(r.slot_day_kind, 'today');
});

// ── 9. a calendar time pick ────────────────────────────────────────────────
section('9. a time picked on a calendar day is checked against opening hours');
const ENUM = { mode: 'time_slots', schedule: { min_date: '2026-10-18', max_date: '2026-10-29' }, kitchen_hours: { start: 10, end: 20 }, slot_duration_minutes: 120 };
const T = (id) => /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(id);
it('a window on the hour grid inside opening hours is accepted, as a free calendar pick', () => {
  assert.deepStrictEqual(F.matchScheduledTimeSlot(ENUM, T('2026-10-20T14:00')), {
    slot_id: '2026-10-20T14:00', date_iso: '2026-10-20',
    start_hour: 14, start_minute: 0, end_hour: 16, end_minute: 0,
    is_same_day: false, is_day_only: false, requires_surcharge: false, surcharge: 0,
    label_en: '2026-10-20T14:00', label_cn: '2026-10-20T14:00',
  });
});
it('the first and last days of the calendar are in; the days either side are out', () => {
  assert.ok(F.matchScheduledTimeSlot(ENUM, T('2026-10-18T12:00')));
  assert.ok(F.matchScheduledTimeSlot(ENUM, T('2026-10-29T12:00')));
  assert.strictEqual(F.matchScheduledTimeSlot(ENUM, T('2026-10-17T12:00')), null);
  assert.strictEqual(F.matchScheduledTimeSlot(ENUM, T('2026-10-30T12:00')), null);
});
it('before opening, off the grid, or running past close is refused; the last window is fine', () => {
  assert.strictEqual(F.matchScheduledTimeSlot(ENUM, T('2026-10-20T08:00')), null);
  assert.strictEqual(F.matchScheduledTimeSlot(ENUM, T('2026-10-20T15:00')), null);
  assert.strictEqual(F.matchScheduledTimeSlot(ENUM, T('2026-10-20T20:00')), null);
  assert.strictEqual(F.matchScheduledTimeSlot(ENUM, T('2026-10-20T18:00')).end_hour, 20);
  assert.strictEqual(F.matchScheduledTimeSlot({ ...ENUM, kitchen_hours: { start: 10, end: 19 } }, T('2026-10-20T18:00')), null);
});
it('90-minute windows land on half hours; a window may run one minute past close', () => {
  const m = F.matchScheduledTimeSlot({ ...ENUM, slot_duration_minutes: 90 }, T('2026-10-20T11:30'));
  assert.deepStrictEqual([m.start_hour, m.start_minute, m.end_hour, m.end_minute], [11, 30, 13, 0]);
  const tight = F.matchScheduledTimeSlot({ ...ENUM, kitchen_hours: { start: 10, end: 11 }, slot_duration_minutes: 61 }, T('2026-10-20T10:00'));
  assert.deepStrictEqual([tight.end_hour, tight.end_minute], [11, 0]);
});
it('no window length means two hours', () => {
  assert.ok(F.matchScheduledTimeSlot({ ...ENUM, slot_duration_minutes: 0 }, T('2026-10-20T12:00')));
  assert.strictEqual(F.matchScheduledTimeSlot({ ...ENUM, slot_duration_minutes: 0 }, T('2026-10-20T11:00')), null);
});
it('a whole-day zone, no calendar, broken hours or a negative window length accept no calendar time', () => {
  assert.strictEqual(F.matchScheduledTimeSlot(null, T('2026-10-20T12:00')), null);
  assert.strictEqual(F.matchScheduledTimeSlot({ ...ENUM, mode: 'day_only' }, T('2026-10-20T12:00')), null);
  assert.strictEqual(F.matchScheduledTimeSlot({ ...ENUM, schedule: null }, T('2026-10-20T12:00')), null);
  assert.strictEqual(F.matchScheduledTimeSlot({ ...ENUM, kitchen_hours: { start: 10, end: 10 } }, T('2026-10-20T10:00')), null);
  assert.strictEqual(F.matchScheduledTimeSlot({ ...ENUM, slot_duration_minutes: -60 }, T('2026-10-20T12:00')), null);
});

// ── 10. the pick is checked again when the order is placed ─────────────────
section('10. the pick is checked again when the order is placed');
const resolve = (zone, slot, now, opts = {}) => F.resolveDeliverySlot(zone, slot, now, { tz: TZ, ...opts });
const NOON = at('2026-10-15', 11, 30);
it('no pick: nothing scheduled, nothing charged', () => {
  assert.deepStrictEqual(resolve({}, '', NOON), { scheduled_for: null, slot: null, surcharge: 0, kind: null });
});
it('"right away" while it is offered, and refused once it is not', () => {
  assert.deepStrictEqual(resolve({}, 'right_away', NOON), { scheduled_for: null, slot: { slot_id: 'right_away' }, surcharge: 0, kind: 'right_away' });
  assert.deepStrictEqual(resolve({}, 'right_away', at('2026-10-15', 19, 55)), { error: 'right_away_unavailable' });
});
it('one of today\'s windows: "today", at that time on the shop\'s clock, with its surcharge', () => {
  const r = resolve({ same_day_surcharge: 8 }, '2026-10-15T14:00', NOON);
  assert.strictEqual(r.kind, 'today');
  assert.strictEqual(r.scheduled_for, '2026-10-15T06:00:00.000Z');
  assert.strictEqual(r.surcharge, 8);
  assert.strictEqual(r.slot.slot_id, '2026-10-15T14:00');
});
it('a window that has already started, or tomorrow before the calendar opens, is refused', () => {
  assert.deepStrictEqual(resolve({}, '2026-10-15T10:00', NOON), { error: 'slot_unavailable' });
  assert.deepStrictEqual(resolve({}, '2026-10-17T12:00', NOON), { error: 'slot_unavailable' });
});
it('tomorrow\'s window after close is a free "schedule" pick', () => {
  const r = resolve({ same_day_surcharge: 8 }, '2026-10-16T10:00', at('2026-10-15', 21));
  assert.strictEqual(r.kind, 'schedule');
  assert.strictEqual(r.surcharge, 0);
  assert.strictEqual(r.scheduled_for, '2026-10-16T02:00:00.000Z');
});
it('a time on a calendar day: "schedule", free; off-grid is refused', () => {
  const r = resolve({}, '2026-10-20T14:00', NOON);
  assert.strictEqual(r.kind, 'schedule');
  assert.strictEqual(r.scheduled_for, '2026-10-20T06:00:00.000Z');
  assert.strictEqual(r.surcharge, 0);
  assert.deepStrictEqual(resolve({}, '2026-10-20T15:00', NOON), { error: 'slot_unavailable' });
});
it('a whole calendar day: midnight that day, "schedule"; the edges of the calendar hold', () => {
  const r = resolve({}, '2026-10-20', NOON);
  assert.strictEqual(r.kind, 'schedule');
  assert.strictEqual(r.scheduled_for, '2026-10-19T16:00:00.000Z');
  assert.deepStrictEqual(r.slot, {
    slot_id: '2026-10-20', date_iso: '2026-10-20', is_same_day: false, is_day_only: true,
    requires_surcharge: false, surcharge: 0, label_en: '2026-10-20', label_cn: '2026-10-20',
  });
  assert.strictEqual(resolve({}, '2026-10-18', NOON).kind, 'schedule');
  assert.strictEqual(resolve({}, '2026-10-29', NOON).kind, 'schedule');
  assert.deepStrictEqual(resolve({}, '2026-10-17', NOON), { error: 'slot_unavailable' });
  assert.deepStrictEqual(resolve({}, '2026-10-30', NOON), { error: 'slot_unavailable' });
});
it('whole-day zone: Today is "today" with its surcharge; the Express day is "express" and free', () => {
  const today = resolve(PANYU, '2026-10-15', at('2026-10-15', 11));
  assert.strictEqual(today.kind, 'today');
  assert.strictEqual(today.surcharge, 15);
  const express = resolve(PANYU, '2026-10-16', at('2026-10-15', 11));
  assert.strictEqual(express.kind, 'express');
  assert.strictEqual(express.surcharge, 0);
  assert.strictEqual(express.scheduled_for, '2026-10-15T16:00:00.000Z');
  assert.deepStrictEqual(resolve(PANYU, '2026-10-17', at('2026-10-15', 11)), { error: 'slot_unavailable' });
});
it('after close the Express day is the only chip, and still reads "express"', () => {
  assert.strictEqual(resolve(PANYU, '2026-10-16', at('2026-10-15', 21)).kind, 'express');
  assert.deepStrictEqual(resolve(PANYU, '2026-10-15', at('2026-10-15', 21)), { error: 'slot_unavailable' });
});
it('the fresh-cart floor applies when the pick is re-checked, not only when it is offered', () => {
  const batch = { applies: true, make_date: '2026-10-20' };
  assert.deepStrictEqual(resolve(PANYU, '2026-10-18', at('2026-10-15', 11), { batch }), { error: 'slot_unavailable' });
  assert.strictEqual(resolve(PANYU, '2026-10-21', at('2026-10-15', 11), { batch }).kind, 'express');
});
it('the time is the shop\'s time: 14:00 in London is 13:00 UTC', () => {
  assert.strictEqual(resolve({}, '2026-10-20T14:00', NOON, { tz: 'Europe/London' }).scheduled_for, '2026-10-20T13:00:00.000Z');
});
it('anything that is not a date or a date and time is refused as invalid', () => {
  assert.deepStrictEqual(resolve({}, 'tomorrow', NOON), { error: 'slot_invalid' });
  assert.deepStrictEqual(resolve({}, '2026-10-20 14:00', NOON), { error: 'slot_invalid' });
});

section('11. a client that names the wrong kind is logged, never refused');
const warned = (fn) => {
  const lines = []; const orig = console.warn;
  console.warn = (s) => lines.push(s);
  try { fn(); } finally { console.warn = orig; }
  return lines;
};
it('silent when nothing was sent, or it agrees (spaces aside)', () => {
  assert.deepStrictEqual(warned(() => {
    F.logSlotKindMismatch(7, null, 'today', 'orders.create');
    F.logSlotKindMismatch(7, '   ', 'today', 'orders.create');
    F.logSlotKindMismatch(7, ' today ', 'today', 'orders.create');
  }), []);
});
it('one line when the client and the server disagree', () => {
  assert.deepStrictEqual(warned(() => F.logSlotKindMismatch(7, 'today', 'express', 'orders.create')),
    ['[slot-kind mismatch] orders.create order=7 submitted="today" derived="express"']);
  assert.deepStrictEqual(warned(() => F.logSlotKindMismatch(7, 'today', null, 'orders.create')),
    ['[slot-kind mismatch] orders.create order=7 submitted="today" derived=null']);
});
it('never throws, whatever it is handed', () => {
  const bad = { toString() { throw new Error('boom'); } };
  assert.deepStrictEqual(warned(() => F.logSlotKindMismatch(7, bad, 'today', 'orders.create')), []);
});

// ── 12. §480: the cooking store's own hours ────────────────────────────────
section('12. the store that cooks the order sets the hours (§480)');
// The two real shops: Yuexiu opens 08:00 and closes 20:30; Tianhe keeps the
// zone default's 10:00–20:00. The zone below is the default (10–20) throughout,
// so every difference comes from the store.
const YUEXIU = { open: '08:00', close: '20:30' };
const TIANHE = { open: '10:00', close: '20:00' };
it('a store\'s hours become minutes for "open now" and whole hours inside them for the windows', () => {
  assert.deepStrictEqual(F.storeDeliveryWindow(YUEXIU), { open: 480, close: 1230, startHour: 8, endHour: 20 });
  assert.deepStrictEqual(F.storeDeliveryWindow({ open: '07:30', close: '20:00' }), { open: 450, close: 1200, startHour: 8, endHour: 20 });
  // 23:59 is how "till midnight" is written; it keeps the window ending at 24:00.
  assert.deepStrictEqual(F.storeDeliveryWindow({ open: '00:00', close: '23:59' }), { open: 0, close: 1439, startHour: 0, endHour: 24 });
});
it('a time is read as "HH:MM" on a 24-hour clock; 24:00, 23:60 and anything else are not times', () => {
  assert.strictEqual(F.hhmmToMinutes('08:00'), 480);
  assert.strictEqual(F.hhmmToMinutes(' 8:05 '), 485);
  assert.strictEqual(F.hhmmToMinutes('23:59'), 1439);
  for (const v of ['24:00', '23:60', '25:99', '8am', '0800', '', null, undefined]) {
    assert.strictEqual(F.hhmmToMinutes(v), null, String(v));
  }
});
it('no store, a missing or malformed end, close not after open, or no whole hour between: the zone\'s hours stand', () => {
  for (const h of [null, undefined, {}, { open: '08:00' }, { open: '08:00', close: '' }, { open: '8am', close: '20:00' },
    { close: '20:00' }, { open: '', close: '20:00' },
    { open: '20:00', close: '08:00' }, { open: '08:00', close: '08:00' }, { open: '08:30', close: '09:15' }]) {
    assert.strictEqual(F.storeDeliveryWindow(h), null, JSON.stringify(h));
  }
  const t = at('2026-10-15', 8, 15);
  assert.deepStrictEqual(slots({}, t, { storeHours: { open: '08:00', close: null } }), slots({}, t));
});
it('08:15 near Yuexiu: "right away" is on, and today\'s windows run from the store\'s hours', () => {
  const r = slots({}, at('2026-10-15', 8, 15), { storeHours: YUEXIU });
  assert.strictEqual(r.kitchen_open_now, true);
  assert.strictEqual(r.right_away_available, true);
  assert.deepStrictEqual(r.kitchen_hours, { start: 8, end: 20 });
  assert.deepStrictEqual(ids(r.today_slots), ['2026-10-15T10:00', '2026-10-15T12:00', '2026-10-15T14:00', '2026-10-15T16:00', '2026-10-15T18:00']);
});
it('07:50 near Yuexiu: closed, reopens today, and the 08:00 window is on offer', () => {
  const r = slots({}, at('2026-10-15', 7, 50), { storeHours: YUEXIU });
  assert.strictEqual(r.kitchen_open_now, false);
  assert.strictEqual(r.right_away_available, false);
  assert.strictEqual(r.kitchen_reopens_today, true);
  assert.strictEqual(r.today_slots[0].slot_id, '2026-10-15T08:00');
});
it('08:15 near Tianhe: no "right away", reopens today, windows from 10:00 — exactly the zone default', () => {
  const t = at('2026-10-15', 8, 15);
  const r = slots({}, t, { storeHours: TIANHE });
  assert.strictEqual(r.kitchen_open_now, false);
  assert.strictEqual(r.right_away_available, false);
  assert.strictEqual(r.kitchen_reopens_today, true);
  assert.deepStrictEqual(r, slots({}, t));
});
it('the store\'s hours win over the zone\'s own kitchen hours', () => {
  const r = slots({ slot_start_hour: 11, slot_end_hour: 17 }, at('2026-10-15', 8, 15), { storeHours: YUEXIU });
  assert.deepStrictEqual(r.kitchen_hours, { start: 8, end: 20 });
  assert.strictEqual(r.right_away_available, true);
});
it('20:15: Yuexiu still takes today\'s orders, Tianhe has closed', () => {
  const y = slots({}, at('2026-10-15', 20, 15), { storeHours: YUEXIU });
  assert.strictEqual(y.kitchen_open_now, true);
  assert.strictEqual(y.right_away_available, true);
  assert.strictEqual(y.same_day_cutoff_passed, false);
  // No two-hour window still fits today, so the chips are tomorrow's, from 08:00.
  assert.strictEqual(y.slot_day_kind, 'tomorrow');
  assert.deepStrictEqual(ids(y.today_slots), ['2026-10-16T08:00', '2026-10-16T10:00', '2026-10-16T12:00', '2026-10-16T14:00', '2026-10-16T16:00', '2026-10-16T18:00']);
  const t = slots({}, at('2026-10-15', 20, 15), { storeHours: TIANHE });
  assert.strictEqual(t.kitchen_open_now, false);
  assert.strictEqual(t.right_away_available, false);
  assert.strictEqual(t.kitchen_reopens_today, false);
});
it('the same-day cutoff counts back from the store\'s half-hour close, and says so', () => {
  const before = slots({}, at('2026-10-15', 20, 19), { storeHours: YUEXIU });
  assert.strictEqual(before.same_day_cutoff_passed, false);
  const r = slots({}, at('2026-10-15', 20, 20), { storeHours: YUEXIU });
  assert.strictEqual(r.same_day_cutoff_passed, true);
  assert.strictEqual(r.right_away_available, false);
  assert.ok(r.same_day_cutoff_message.en.includes('close at 8:30pm'), r.same_day_cutoff_message.en);
  assert.ok(r.same_day_cutoff_message.cn.includes('今日 20:30 关门'), r.same_day_cutoff_message.cn);
  assert.ok(slots({}, at('2026-10-15', 19, 50)).same_day_cutoff_message.en.includes('close at 8pm'));
});
it('a whole-day zone keeps its Today chip until the store\'s own close', () => {
  const zone = { day_only: 1, same_day_surcharge: 8 };
  assert.ok(slots(zone, at('2026-10-15', 20, 5), { storeHours: YUEXIU }).today_day_chip);
  assert.strictEqual(slots(zone, at('2026-10-15', 20, 5)).today_day_chip, null);
});
it('all four places that offer or check a delivery time hand over the cooking store\'s hours', () => {
  // The checkout quote, the order itself, and the reschedule picker and its
  // check. One that stopped passing them would quietly fall back to the zone.
  const sites = SRC.match(/storeHours: deliveryStoreHours\(/g) || [];
  assert.strictEqual(sites.length, 4);
});
it('a window before 10:00 carries a two-digit hour, so the one offered is the one accepted', () => {
  // Was 'T8:00', which resolveDeliverySlot's 'THH:MM' refused at payment.
  const t = at('2026-10-15', 7, 0);
  for (const [zone, opts] of [[{ slot_start_hour: 8 }, {}], [{}, { storeHours: YUEXIU }]]) {
    const offered = slots(zone, t, opts).today_slots[0];
    assert.strictEqual(offered.slot_id, '2026-10-15T08:00');
    assert.strictEqual(offered.label_cn, '今天 8:00–10:00');
    assert.strictEqual(resolve(zone, offered.slot_id, t, opts).kind, 'today');
  }
});
it('placing the order: "right away" at 08:15 is accepted for Yuexiu and refused for Tianhe', () => {
  const t = at('2026-10-15', 8, 15);
  assert.strictEqual(resolve({}, 'right_away', t, { storeHours: YUEXIU }).kind, 'right_away');
  assert.deepStrictEqual(resolve({}, 'right_away', t, { storeHours: TIANHE }), { error: 'right_away_unavailable' });
});
it('placing the order: an 08:00 window on a later day is Yuexiu\'s to give, not Tianhe\'s', () => {
  const t = at('2026-10-15', 11, 30);
  assert.strictEqual(resolve({}, '2026-10-20T08:00', t, { storeHours: YUEXIU }).kind, 'schedule');
  assert.deepStrictEqual(resolve({}, '2026-10-20T08:00', t, { storeHours: TIANHE }), { error: 'slot_unavailable' });
});

for (const run of pending) run();
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
