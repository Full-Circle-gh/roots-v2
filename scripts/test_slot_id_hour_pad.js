#!/usr/bin/env node
/**
 * A delivery slot id spells its hour with two digits, always.
 *
 *   node scripts/test_slot_id_hour_pad.js
 *
 * THE DEFECT. computeDeliverySlots built a slot id through an `hhmm` that
 * padded the MINUTE and left the HOUR alone, so a kitchen opening at 08:00
 * minted '2026-09-16T8:00'. Both readers demanded two digits:
 *
 *   • slotWindowEnd  → null, so the window had no end and
 *     freshLinesCoveredToday could never cover it;
 *   • resolveDeliverySlot → 'slot_invalid', because a single-digit hour
 *     matches neither the time shape nor the bare-date shape.
 *
 * The second one is the loss. The picker OFFERED the window and checkout
 * REFUSED it — for a zone opening before 10, every single-digit window was
 * unbookable, with no message that named a cause.
 *
 * WHY IT HAS NEVER BEEN SEEN. The one live zone's slot_start_hour is 10, so
 * every hour it generates is already two digits. It goes live the day any zone
 * opens earlier, or a slot duration lands a window on a single-digit hour.
 *
 * NOTHING PERSISTS A SLOT ID, and that is worth stating because it is the
 * question this change had to answer before changing the format. `retail_orders`
 * keeps scheduled_for, delivery_slot_label and delivery_slot_kind — there is no
 * delivery_slot_id column (database.js). An id lives for one request:
 * computeDeliverySlots mints it, the client echoes it back, resolveDeliverySlot
 * turns it into those three columns. So there is no back catalogue to keep
 * parsing. The tolerant read asserted in section 4 is for a picker already open
 * when the change ships, not for the database.
 *
 * SCOPE. This suite is about the SHAPE of an id and nothing else. Which windows
 * a batch morning ought to offer is a different question, asked by
 * test_fresh_slot_reachable.js; the one coverage case here (section 3) is
 * chosen so it holds either way.
 *
 * Runs against the real sqlite database (data/roots.db, created by database.js
 * on require and gitignored) with seeded rows and a fixed clock, the same
 * arrangement as test_fresh_today_batch.js.
 */
'use strict';

// NO process.env.TZ PIN, for the reason test_fresh_today_batch.js gives at
// length: §82 moved this maths onto the TENANT's zone, so the host's offset no
// longer reaches it. Every clock below is built with businessDate.dateInZone.

const path   = require('path');
const fs     = require('fs');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const businessDate = require(path.join(ROOT, 'lib', 'business-date.js'));
require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const retail  = require(path.join(ROOT, 'routes', 'retail.js'));

const db = tdb();

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
const section = (t) => console.log('\n' + t);

// ── Fixtures ───────────────────────────────────────────────────────────────
// A high id so a dev database's own rows are never touched.
const P_FRESH = 9541;   // batch-made — the only line §80 has anything to say about

// The tenant's own zone, read the way the engine reads it, so the clocks below
// are the ones a customer would be standing in.
let TZ = null;
try { TZ = businessDate.shopTimezone(db); } catch (_) { TZ = null; }
const TODAY = businessDate.businessDate(TZ, new Date());

// THE CANONICAL SHAPE, written out once. Deliberately strict where the reader
// is tolerant: a WRITER that emits anything else is the defect, and a test that
// accepted `\d{1,2}` here would pass on the broken code.
const CANONICAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

// An inner-Guangzhou zone with the opening hour as a parameter, so the early
// kitchen can be built without touching the live zone table.
const zoneWith = (startHour, slotMins = 120) => ({
  id: 9902, zone_type: 'gz_district', name_en: 'Test District', name_cn: '测试区',
  same_day_allowed: 1, same_day_surcharge: 0, min_lead_days: 0, max_lead_days: 14,
  slot_start_hour: startHour, slot_end_hour: 20, slot_duration_minutes: slotMins,
  day_only: 0, free_threshold: null, max_fee: null,
});

// interval_days = 1 so every day is a batch day and the suite does not depend
// on which day it runs.
function setSchedule(readyHour) {
  db.prepare(
    `INSERT INTO storefront_config (key, value_json) VALUES ('batch.schedule', ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
  ).run(JSON.stringify({
    enabled: true, anchor_date: TODAY, interval_days: 1,
    cutoff_hour: 20, ready_hour: readyHour, skip_dates: [],
  }));
}

function cleanup() {
  const wipe = (sql, ...a) => {
    try { db.prepare(sql).run(...a); } catch (e) { console.warn('[cleanup]', e.message); }
  };
  wipe('DELETE FROM store_products WHERE id = ?', P_FRESH);
  // Restored rather than left set: this key is global, the suites share one
  // database, and a schedule left behind is a fixture leaking into whichever
  // suite the runner happens to start next.
  wipe("DELETE FROM storefront_config WHERE key = 'batch.schedule'");
}

function seed() {
  cleanup();
  db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price,
                                 is_batch_made, oos_policy, is_published, is_active)
     VALUES (?,?,?,?,?,1,'backorder_all',1,1)`
  ).run(P_FRESH, 'Falafel Wrap', '法拉费卷', 'sip-1', 44);
}

const at = (h, m = 0) => businessDate.dateInZone(TZ, TODAY, h, m);
const label = (s) => `${String(s.start_hour).padStart(2, '0')}:${String(s.start_minute).padStart(2, '0')}`;
const todaysWindows = (zone, now) =>
  (retail.computeDeliverySlots(zone, now, {}).today_slots || [])
    .filter((s) => s.date_iso === TODAY && !s.is_day_only);

seed();

// ═══════════════════════════════════════════════════════════════════════════
section('1 · an early kitchen mints ids of the one canonical shape');
// Ordering at 06:00, before the kitchen opens — computeDeliverySlots offers
// today's FUTURE windows then by design, so an 08:00 zone yields the
// single-digit hours that carry the defect.
{
  for (const [startHour, slotMins] of [[8, 60], [8, 120], [0, 60], [9, 120]]) {
    const zone = zoneWith(startHour, slotMins);
    const windows = todaysWindows(zone, at(0, 1));
    it(`kitchen ${startHour}:00 · ${slotMins}min → every id is YYYY-MM-DDTHH:MM`, () => {
      assert.ok(windows.length > 0, 'the fixture must actually offer windows to check');
      for (const s of windows) {
        assert.ok(CANONICAL.test(s.slot_id),
          `${s.slot_id} — a single-digit hour is the defect, not a variant spelling`);
      }
    });
  }

  it('the single-digit hours are really in the run — otherwise nothing is proven', () => {
    const windows = todaysWindows(zoneWith(8, 60), at(0, 1));
    const early = windows.filter((s) => s.start_hour < 10);
    assert.ok(early.length >= 2, `expected 08:00 and 09:00, got ${windows.map(label).join(' ')}`);
    assert.deepStrictEqual(early.map((s) => s.slot_id.split('T')[1]).slice(0, 2), ['08:00', '09:00']);
  });

  it('a 10:00 kitchen is unchanged — the live tenant sees nothing move', () => {
    for (const s of todaysWindows(zoneWith(10, 120), at(0, 1))) {
      assert.ok(CANONICAL.test(s.slot_id));
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('2 · every window the picker offers can be read back');
// The two readers, asked about the SAME ids the picker just minted. Before the
// pad both answered "not a slot" for any hour below 10: slotWindowEnd with
// null, resolveDeliverySlot with slot_invalid — so the picker offered a window
// checkout would refuse.
{
  for (const [startHour, slotMins] of [[8, 60], [8, 120], [0, 120]]) {
    const zone = zoneWith(startHour, slotMins);
    const now = at(0, 1);
    const windows = todaysWindows(zone, now);

    it(`kitchen ${startHour}:00 · ${slotMins}min → slotWindowEnd answers for every window`, () => {
      for (const s of windows) {
        const end = retail.slotWindowEnd(zone, s.slot_id, now, TZ);
        assert.ok(end instanceof Date, `${s.slot_id} has no window end`);
        const p = businessDate.zoneParts(TZ, end);
        assert.strictEqual(p.hour * 60 + p.minute, s.end_hour * 60 + s.end_minute,
          `${s.slot_id} ends at ${p.hour}:${p.minute}, not ${s.end_hour}:${s.end_minute}`);
      }
    });

    it(`kitchen ${startHour}:00 · ${slotMins}min → every window is bookable`, () => {
      for (const s of windows) {
        const r = retail.resolveDeliverySlot(zone, s.slot_id, now, {});
        assert.ok(!r.error, `${s.slot_id} → ${r.error} for a window the picker had just offered`);
        assert.strictEqual(r.slot.slot_id, s.slot_id);
        assert.strictEqual(r.kind, 'today');
      }
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('3 · an early window the batch reaches is covered');
// The §80 half, in the one shape that holds whatever computeDeliverySlots
// decides to offer: kitchen at 08:00, hour-long windows, batch ready at 09:00.
// The 08:00–09:00 window ends exactly ON the ready hour, which freshLines-
// CoveredToday counts as covered (its rule is the window's END, not its start).
// Before the pad this returned empty — not because the batch was late, but
// because slotWindowEnd could not read the id at all.
{
  setSchedule(9);
  const zone = zoneWith(8, 60);
  const now  = at(6, 0);
  const covered = (slotId) => retail.freshLinesCoveredToday({
    zone, deliverySlotId: slotId, productIds: [P_FRESH], now, tz: TZ,
  });

  it('08:00–09:00 is covered by a 09:00 batch', () => {
    assert.ok(covered(`${TODAY}T08:00`).has(P_FRESH));
  });
  it('09:00–10:00 is covered too', () => {
    assert.ok(covered(`${TODAY}T09:00`).has(P_FRESH));
  });
  it('…and a window that shuts BEFORE the batch still is not — the rule is intact', () => {
    setSchedule(11);
    assert.strictEqual(covered(`${TODAY}T08:00`).size, 0);
    setSchedule(9);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('4 · a single-digit id is still read, and read as the same window');
// THE TOLERANCE IS NOT FOR THE DATABASE — nothing stores a slot id (see the
// header). It is for a picker that was already open when this shipped, holding
// ids minted by the old build. Those must resolve to the window they name
// rather than to nothing, which is the failure they were minted into.
{
  setSchedule(9);
  const zone = zoneWith(8, 60);
  const now  = at(6, 0);
  const OLD = `${TODAY}T8:00`;
  const NEW = `${TODAY}T08:00`;

  it('slotWindowEnd reads the old spelling as the same instant', () => {
    const a = retail.slotWindowEnd(zone, OLD, now, TZ);
    const b = retail.slotWindowEnd(zone, NEW, now, TZ);
    assert.ok(a instanceof Date && b instanceof Date);
    assert.strictEqual(a.getTime(), b.getTime());
  });

  it('resolveDeliverySlot books it, and hands back the CANONICAL id', () => {
    const r = retail.resolveDeliverySlot(zone, OLD, now, {});
    assert.ok(!r.error, `old spelling → ${r.error}`);
    // The point of canonicalising rather than merely parsing: `slots` carries
    // the padded spelling, so a tolerant regex alone would parse the id and
    // then fail to match any chip.
    assert.strictEqual(r.slot.slot_id, NEW);
    assert.strictEqual(r.scheduled_for,
      retail.resolveDeliverySlot(zone, NEW, now, {}).scheduled_for);
  });

  it('freshLinesCoveredToday covers it, the same as the new spelling', () => {
    const one = retail.freshLinesCoveredToday({
      zone, deliverySlotId: OLD, productIds: [P_FRESH], now, tz: TZ });
    assert.ok(one.has(P_FRESH));
  });

  it('a scheduled-for-later window canonicalises too', () => {
    // matchScheduledTimeSlot synthesises its own slot object, and its label_en
    // is persisted to delivery_slot_label when the client sends none — so an
    // unpadded hour would have reached the column that lib/feie.js and
    // public/retail-admin/04-orders.js read with a two-digit assumption.
    const laterIso = businessDate.businessDate(TZ, new Date(Date.now() + 5 * 86400000));
    const r = retail.resolveDeliverySlot(zone, `${laterIso}T8:00`, now, {});
    assert.ok(!r.error, `scheduled early window → ${r.error}`);
    assert.strictEqual(r.slot.slot_id, `${laterIso}T08:00`);
    assert.ok(CANONICAL.test(r.slot.label_en), `label_en is ${r.slot.label_en}`);
  });

  it('a genuinely malformed id is still refused', () => {
    // Tolerance has a floor. Widening the hour must not have widened anything
    // else, or 'slot_invalid' stops meaning anything.
    for (const bad of [`${TODAY}T8:0`, `${TODAY}T108:00`, `${TODAY}T8`, `${TODAY}-T8:00`, '8:00']) {
      assert.strictEqual(retail.resolveDeliverySlot(zone, bad, now, {}).error, 'slot_invalid', bad);
      assert.strictEqual(retail.slotWindowEnd(zone, bad, now, TZ), null, bad);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('5 · no writer is left minting the old spelling');
// A finding filed at one line is where it was found, not the extent of it. The
// pad is only true while every BUILDER goes through it, so the builders are
// named here rather than left to a reader to rediscover.
{
  const src = fs.readFileSync(path.join(ROOT, 'routes/retail.js'), 'utf8');

  it('emitTimeSlots\' hhmm pads both halves', () => {
    const m = /const hhmm = \(h, m\) => `([^`]+)`;/.exec(src);
    assert.ok(m, 'the helper that builds the time half must still be findable');
    assert.strictEqual(m[1], '${String(h).padStart(2, \'0\')}:${String(m).padStart(2, \'0\')}');
  });

  it('the two readers share ONE shape, so they cannot drift apart again', () => {
    assert.ok(/const SLOT_TIME_RE = \/\^\(\\d\{4\}\)-\(\\d\{2\}\)-\(\\d\{2\}\)T\(\\d\{1,2\}\):\(\\d\{2\}\)\$\//.test(src),
      'SLOT_TIME_RE is the one tolerant shape');
    // The old literal, in either reader, is the regression this catches.
    assert.strictEqual(
      (src.match(/\/\^\(\\d\{4\}\)-\(\\d\{2\}\)-\(\\d\{2\}\)T\(\\d\{2\}\):\(\\d\{2\}\)\$\//g) || []).length, 0,
      'a two-digit-hour slot-id regex is back; it cannot read what an early kitchen mints');
  });

  it('no comparison against an enumerated chip skips canonicalSlotId', () => {
    // A tolerant parse buys nothing if the id is then compared raw: the chips
    // carry the padded spelling and '…T8:00' === '…T08:00' is false.
    const at = src.indexOf('function resolveDeliverySlot');
    const body = src.slice(at, at + 2600);
    assert.ok(/found = enumed\.slots\.find\(s => s\.slot_id === canonicalSlotId\(mTime\)\)/.test(body),
      'the time-slot branch must match on the canonical spelling');
  });

  it('the mini app\'s mirror still pads the id it builds itself', () => {
    const mini = fs.readFileSync(path.join(ROOT, 'miniapp/pages/checkout/checkout.js'), 'utf8');
    assert.ok(/slot_id: `\$\{isoDate\}T\$\{pad\(sH\)\}:\$\{pad\(sM\)\}`/.test(mini),
      'buildWindowsForDate mints ids the server must be able to resolve');
    assert.ok(/const hhmm = \(h, mm\) => `\$\{pad\(h\)\}:\$\{pad\(mm\)\}`/.test(mini),
      'and its CN label agrees with the server\'s, character for character');
  });
}

cleanup();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
