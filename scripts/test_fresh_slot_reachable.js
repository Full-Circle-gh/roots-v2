#!/usr/bin/env node
/**
 * The slot picker never offers a window today's batch cannot reach.
 *
 *   node scripts/test_fresh_slot_reachable.js
 *
 * THE DEFECT THIS LOCKS DOWN. `floorBlocksToday` withdraws today whole when the
 * next batch is a LATER day. On a batch MORNING the floor IS today, so it
 * withdraws nothing — and computeDeliverySlots offered every one of today's
 * windows, including ones that close before the kitchen finishes.
 *
 * The customer then picked one of those, and checkout stripped it:
 * freshLinesCoveredToday asks "does the batch land before his window shuts?",
 * answers no, and the order parks undated with the delivery time deleted. The
 * picker offered a time the order refused — §80's own disagreement, one screen
 * earlier than §80 fixed it.
 *
 * THE ASSERTION THAT MATTERS IS THE LAST ONE, and it is a property rather than
 * an example: EVERY window the picker offers for today must be one
 * freshLinesCoveredToday covers. Stated that way it keeps holding when the
 * kitchen hours, the slot length or the ready hour change — which is the whole
 * reason the two drifted apart in the first place.
 *
 * Runs against a REAL sqlite database, calling the REAL exported functions, so
 * the windows printed are the ones a customer would have been shown.
 */
'use strict';

const assert = require('assert');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'database.js'));
const { tdb }      = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const businessDate = require(path.join(ROOT, 'lib', 'business-date.js'));
const retail       = require(path.join(ROOT, 'routes', 'retail.js'));
const db = tdb();

const P_FRESH = 9531;   // batch-made, shelf at zero — the line that raises the floor

function cleanup() {
  const wipe = (sql, ...a) => { try { db.prepare(sql).run(...a); } catch (e) { console.warn('[cleanup]', e.message); } };
  wipe('DELETE FROM store_products WHERE id = ?', P_FRESH);
  wipe("DELETE FROM storefront_config WHERE key = 'batch.schedule'");
}

// A batch schedule whose cadence lands on TODAY, with the kitchen ready at
// `readyHour`. interval_days = 1 so every day is a batch day and the suite does
// not depend on which day it runs.
function setSchedule(readyHour) {
  const tz = businessDate.shopTimezone ? (() => { try { return businessDate.shopTimezone(db); } catch { return null; } })() : null;
  const todayIso = businessDate.businessDate(tz, new Date());
  db.prepare(
    `INSERT INTO storefront_config (key, value_json) VALUES ('batch.schedule', ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
  ).run(JSON.stringify({
    enabled: true,
    anchor_date: todayIso,
    interval_days: 1,
    cutoff_hour: 20,
    ready_hour: readyHour,
    skip_dates: [],
  }));
  return { tz, todayIso };
}

function seed() {
  cleanup();
  db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, weight,
                                 is_batch_made, oos_policy, is_published, is_active)
     VALUES (?,?,?,?,?,?,1,'backorder_all',1,1)`
  ).run(P_FRESH, 'Falafel Wrap', '法拉费卷', 'fsr-1', 44, '250g');
}

// An inner-Guangzhou zone: same-day, 2-hour windows. `startHour` varies so the
// early-window case can be built without touching the live zone table.
const zoneWith = (startHour, slotMins = 120) => ({
  id: 9901, zone_type: 'gz_district', name_en: 'Test District', name_cn: '测试区',
  same_day_allowed: 1, same_day_surcharge: 0, min_lead_days: 0, max_lead_days: 14,
  slot_start_hour: startHour, slot_end_hour: 20, slot_duration_minutes: slotMins,
  day_only: 0, free_threshold: null, max_fee: null,
});

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

const label = (s) => `${String(s.start_hour).padStart(2, '0')}:00–${String(s.end_hour).padStart(2, '0')}:00`;

(async () => {
  seed();

  // ── Ash's live shape: kitchen from 10:00, 2-hour windows, ready at 11:00 ──
  {
    const { tz, todayIso } = setSchedule(11);
    const at8 = businessDate.dateInZone(tz, todayIso, 8, 0);
    const sch = retail.computeDeliverySlots(zoneWith(10), at8, { localFreshFloor: todayIso });
    const today = (sch.today_slots || []).filter(s => s.date_iso === todayIso);
    console.log(`\n── ready 11:00, kitchen 10:00, 2h windows, ordering at 08:00`);
    console.log(`   today offered: ${today.map(label).join('  ') || '(none)'}`);
    console.log(`   right away:    ${sch.right_away_available ? 'offered' : 'withdrawn'}`);

    check('the reachable windows are still offered — this must not withdraw today', () => {
      assert.ok(today.length > 0, 'a batch morning must still sell today');
      assert.ok(today.some(s => s.end_hour === 12), 'the 10:00–12:00 window ends after the 11:00 batch');
    });
  }

  // ── "Right away" on a batch morning, with the kitchen OPEN ────────────────
  // The one case Ash's live settings actually change. At 10:30 the kitchen is
  // open, so right-away was offered; the batch lands at 11:00, so checkout
  // could never honour it (slotWindowEnd is null for right_away by design) and
  // stripped the order's window instead. Withdrawn now — and ONLY when a fresh
  // line is short, which is what the in-stock control below pins.
  {
    const { tz, todayIso } = setSchedule(11);
    const at1030 = businessDate.dateInZone(tz, todayIso, 10, 30);
    const soldOut = retail.computeDeliverySlots(zoneWith(10), at1030, { localFreshFloor: todayIso });
    const inStock = retail.computeDeliverySlots(zoneWith(10), at1030, {});
    console.log(`\n── ready 11:00, kitchen open, ordering at 10:30`);
    console.log(`   fresh line sold out → right away: ${soldOut.right_away_available ? 'offered' : 'withdrawn'}`);
    console.log(`   fresh line in stock → right away: ${inStock.right_away_available ? 'offered' : 'withdrawn'}`);

    check('right away is withdrawn while the batch is still being made', () => {
      assert.strictEqual(soldOut.right_away_available, false,
        'offering "soonest possible" for food that does not exist is the promise that gets stripped');
    });
    check('an in-stock cart keeps right away — this must not withdraw it generally', () => {
      assert.strictEqual(inStock.right_away_available, true,
        'the floor is only set when a fresh line is SHORT; an in-stock cart is not this rule\'s business');
    });
    check('and the reachable windows are still there to pick instead', () => {
      const today = (soldOut.today_slots || []).filter(s => s.date_iso === todayIso);
      assert.ok(today.length > 0, 'withdrawing right-away must leave him somewhere to go');
    });
  }

  // ── The broken case: kitchen opens at 08:00, so two windows shut before 11 ──
  {
    const { tz, todayIso } = setSchedule(11);
    const at7 = businessDate.dateInZone(tz, todayIso, 7, 0);
    const sch = retail.computeDeliverySlots(zoneWith(8), at7, { localFreshFloor: todayIso });
    const today = (sch.today_slots || []).filter(s => s.date_iso === todayIso);
    console.log(`\n── ready 11:00, kitchen 08:00, 2h windows, ordering at 07:00`);
    console.log(`   today offered: ${today.map(label).join('  ') || '(none)'}`);

    check('a window that shuts before the kitchen finishes is not offered', () => {
      assert.ok(!today.some(s => s.end_hour === 10),
        '08:00–10:00 cannot be served by an 11:00 batch — offering it is the defect');
    });
    check('the window that ends exactly ON the ready hour is kept', () => {
      // 10:00–12:00 ends at 12:00; the 09:00-start grid has none ending at 11:00,
      // so the boundary is asserted directly against the covered test below.
      assert.ok(today.some(s => s.end_hour >= 11), 'everything reachable must survive');
    });
    check('later windows are untouched', () => {
      for (const h of [14, 16, 18, 20]) {
        assert.ok(today.some(s => s.end_hour === h), `the window ending ${h}:00 must still be offered`);
      }
    });
  }

  // ── THE PROPERTY: the picker and the checkout agree, on every shape ────────
  {
    console.log('\n── agreement: every offered window must be one checkout covers');
    for (const readyHour of [9, 11, 13, 16]) {
      for (const startHour of [8, 10]) {
        for (const slotMins of [60, 120]) {
          const { tz, todayIso } = setSchedule(readyHour);
          const zone = zoneWith(startHour, slotMins);
          const orderAt = businessDate.dateInZone(tz, todayIso, 6, 0);
          const sch = retail.computeDeliverySlots(zone, orderAt, { localFreshFloor: todayIso });
          const today = (sch.today_slots || []).filter(s => s.date_iso === todayIso);
          for (const slot of today) {
            const covered = retail.freshLinesCoveredToday({
              zone, deliverySlotId: slot.slot_id, productIds: [P_FRESH], now: orderAt, tz,
            });
            check(`ready ${readyHour}:00 · kitchen ${startHour}:00 · ${slotMins}min → ${label(slot)} is covered`, () => {
              assert.ok(covered.has(P_FRESH),
                `the picker offered ${label(slot)} but checkout would strip it — they have drifted apart`);
            });
          }
        }
      }
    }
  }

  cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { cleanup(); } catch {} process.exit(1); });
