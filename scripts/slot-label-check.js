/* Asserts lib/slot-label.js — the relative day word on a stored
   delivery_slot_label, re-derived at read time from scheduled_for.

   Run:  node scripts/slot-label-check.js

   This is a date-rollover bug class, which is to say it passes every day
   except the one that matters. TC000178 read "Tomorrow 10AM–12PM" on the
   morning it was due, because the word was minted at slot-pick time and
   frozen into the column. The guard is the boundary rows below plus the
   four-timezone sweep at the end: a host in the wrong zone flips the day
   eight hours early, and nothing on screen says so.

   The 2+-days and past rows render through §1.18's `weekday` and `date`
   names (docs/tacet-desktop-patterns.md:927-941). If a row here and that
   table disagree, ONE of them is wrong and the answer is not to adjust
   the test — the same rule scripts/check-td-datetime.js runs on. */
const { execFileSync } = require('child_process');
const { deliverySlotDisplay } = require('../lib/slot-label.js');

let pass = 0, fail = 0;
function is(got, want, label) {
  if (got === want) { pass++; console.log('  ok   ' + label + '  →  ' + JSON.stringify(got)); }
  else { fail++; console.log('  FAIL ' + label + '\n       got:  ' + JSON.stringify(got) + '\n       want: ' + JSON.stringify(want)); }
}

/* "now" is injected rather than pinned globally: this module takes the
   reference instant as an argument precisely so the rollover is testable.
   Written as a Guangzhou wall clock, converted to the real instant here. */
const gz = (s) => new Date(Date.parse(s + 'Z') - 8 * 3600 * 1000);
const NOW = gz('2026-08-09T11:00:00');           // Sun 9 Aug 2026, 11:00 GZ

/* Slot instants, in the shape resolveDeliverySlot stores them. 02:00Z is
   10:00 in Asia/Shanghai — the front of a 10AM–12PM window. */
const AUG08 = '2026-08-08T02:00:00.000Z';
const AUG09 = '2026-08-09T02:00:00.000Z';
const AUG10 = '2026-08-10T02:00:00.000Z';
const AUG12 = '2026-08-12T02:00:00.000Z';

console.log('\nThe bug — a word minted yesterday, read today');
is(deliverySlotDisplay('Tomorrow 10AM–12PM', AUG09, gz('2026-08-09T09:30:00')),
  'Today 10AM–12PM', 'TC000178 · booked yesterday for today');

console.log('\nEnglish — the four day cases');
is(deliverySlotDisplay('Today 4PM–6PM', '2026-08-09T08:00:00.000Z', NOW),
  'Today 4PM–6PM', 'today · window still ahead');
is(deliverySlotDisplay('Today 10AM–12PM', AUG09, gz('2026-08-09T16:00:00')),
  'Today 10AM–12PM', 'today · window ALREADY PASSED — still "Today"');
is(deliverySlotDisplay('Tomorrow 10AM–12PM', AUG10, NOW),
  'Tomorrow 10AM–12PM', 'tomorrow');
is(deliverySlotDisplay('Tomorrow 10AM–12PM', AUG12, NOW),
  'Wednesday, August 12 10AM–12PM', '3 days out · §1.18 `weekday`');
is(deliverySlotDisplay('Tomorrow 10AM–12PM', AUG08, NOW),
  'Aug 8 10AM–12PM', 'past · §1.18 `date`, no relative word');

console.log('\nChinese — the label\'s own language decides, never the viewer\'s');
is(deliverySlotDisplay('明天 10:00–12:00', AUG09, gz('2026-08-09T09:30:00')),
  '今天 10:00–12:00', 'cn · rolled over');
is(deliverySlotDisplay('明天 10:00–12:00', AUG10, NOW),
  '明天 10:00–12:00', 'cn · tomorrow');
is(deliverySlotDisplay('明天 10:00–12:00', AUG12, NOW),
  '8月12日 周三 10:00–12:00', 'cn · 3 days out · §1.18 `weekday`');
is(deliverySlotDisplay('今天 10:00–12:00', AUG08, NOW),
  '8月8日 10:00–12:00', 'cn · past · §1.18 `date`');

console.log('\nThe year rule (§1.18) — the year only when it is not this year');
is(deliverySlotDisplay('Tomorrow 10AM–12PM', '2025-12-14T02:00:00.000Z', NOW),
  'Dec 14, 2025 10AM–12PM', 'en · past, other year');
is(deliverySlotDisplay('明天 10:00–12:00', '2025-12-14T02:00:00.000Z', NOW),
  '2025年12月14日 10:00–12:00', 'cn · past, other year');
is(deliverySlotDisplay('Tomorrow 10AM–12PM', '2027-01-05T02:00:00.000Z', NOW),
  'Tuesday, January 5, 2027 10AM–12PM', 'en · ahead, other year');
is(deliverySlotDisplay('明天 10:00–12:00', '2027-01-05T02:00:00.000Z', NOW),
  '2027年1月5日 周二 10:00–12:00', 'cn · ahead, other year');

console.log('\nDay-only zones — a bare day word, no window to keep');
is(deliverySlotDisplay('Today', '2026-08-08T16:00:00.000Z', NOW), 'Today', 'en · GZ midnight, rolled over');
is(deliverySlotDisplay('Today', '2026-08-09T00:00:00.000Z', NOW), 'Today', 'en · same day');
is(deliverySlotDisplay('今天', '2026-08-08T16:00:00.000Z', NOW), '今天', 'cn · GZ midnight, rolled over');

console.log('\nLabels with no leading relative word pass through untouched');
is(deliverySlotDisplay('Right away', null, NOW), 'Right away', 'right_away');
is(deliverySlotDisplay('Ships when restocked', null, NOW), 'Ships when restocked', 'restock');
is(deliverySlotDisplay('Earliest 2026-08-12', AUG12, NOW), 'Earliest 2026-08-12', 'express');
is(deliverySlotDisplay('2026-08-12T10:00', AUG12, NOW), '2026-08-12T10:00', 'raw calendar slot id');
is(deliverySlotDisplay('Deliver 2026-08-12', AUG12, NOW), 'Deliver 2026-08-12', 'mini-app reschedule');
/* This row asserted the gap, and the gap is now closed. Until the pickup
   work it read 'Pickup Today 14:30' unchanged — the relative word is not at
   position 0, so the delivery path's anchored guard skipped it. It is the
   ONE pre-existing assertion this pass changes, and changing it is the
   ticket. Kept here, rewritten, rather than deleted: the old expectation is
   the bug and the new one is the fix, on the same line. */
is(deliverySlotDisplay('Pickup Today 14:30', '2026-08-08T06:30:00.000Z', NOW),
  'Pickup Aug 8 2:30 PM', 'pickup · rebuilt (was: passed through — see the pickup section)');

console.log('\nNothing to work with → the stored label, unchanged');
is(deliverySlotDisplay('Tomorrow 10AM–12PM', null, NOW), 'Tomorrow 10AM–12PM', 'no scheduled_for');
is(deliverySlotDisplay('Tomorrow 10AM–12PM', '', NOW), 'Tomorrow 10AM–12PM', 'empty scheduled_for');
is(deliverySlotDisplay('Tomorrow 10AM–12PM', 'not-a-date', NOW), 'Tomorrow 10AM–12PM', 'junk scheduled_for');
is(deliverySlotDisplay(null, AUG09, NOW), null, 'null label');
is(deliverySlotDisplay('', AUG09, NOW), '', 'empty label');

console.log('\nStored shapes — every one the column actually holds');
is(deliverySlotDisplay('Tomorrow 10AM–12PM', '2026-08-09 02:00:00', gz('2026-08-09T09:30:00')),
  'Today 10AM–12PM', 'naive stamp read as UTC, not host-local');
is(deliverySlotDisplay('Tomorrow', '2026-08-09', gz('2026-08-09T09:30:00')),
  'Today', 'bare YYYY-MM-DD is the calendar day — no 8h shift');
is(deliverySlotDisplay('Tomorrow 10AM–12PM', new Date(AUG09), gz('2026-08-09T09:30:00')),
  'Today 10AM–12PM', 'Date object');

console.log('\nMidnight in Asia/Shanghai — the whole point');
is(deliverySlotDisplay('Tomorrow 10AM–12PM', AUG10, gz('2026-08-09T23:59:00')),
  'Tomorrow 10AM–12PM', '23:59 GZ · still Tomorrow');
is(deliverySlotDisplay('Tomorrow 10AM–12PM', AUG10, gz('2026-08-10T00:01:00')),
  'Today 10AM–12PM', '00:01 GZ · flipped to Today');
is(deliverySlotDisplay('Tomorrow 10AM–12PM', AUG10, new Date('2026-08-09T15:59:00Z')),
  'Tomorrow 10AM–12PM', '15:59Z = 23:59 GZ · a UTC-reading host flips 8h early');
is(deliverySlotDisplay('Tomorrow 10AM–12PM', AUG10, new Date('2026-08-09T16:01:00Z')),
  'Today 10AM–12PM', '16:01Z = 00:01 GZ · the real boundary');

/* ── Pickup: rebuilt from scheduled_for, not patched ───────────────────
   resolvePickupTime mints exactly two shapes and both are rebuilt here:
   'Pickup Today 14:30' (booked for the same day) and
   'Pickup Thu 12/8 14:30' (booked ahead — an absolute date that cannot
   rot, but is still rebuilt so the line is one format, one language and
   one clock convention). The stored label is English on a 24-hour clock
   whatever the customer speaks; the rebuilt line follows the VIEWER. */
const PU_1430 = '2026-08-09T06:30:00.000Z';   // 14:30 GZ, Sun 9 Aug
const PU_1800 = '2026-08-08T10:00:00.000Z';   // 18:00 GZ, Sat 8 Aug

console.log('\nPickup · English — rebuilt, and the EN clock becomes 12-hour');
is(deliverySlotDisplay('Pickup Today 14:30', PU_1430, NOW, 'en'),
  'Pickup Today 2:30 PM', 'same day · the live case');
is(deliverySlotDisplay('Pickup Today 18:00', PU_1800, gz('2026-08-09T09:00:00'), 'en'),
  'Pickup Aug 8 6:00 PM', 'UNCOLLECTED across midnight — the real bug');
is(deliverySlotDisplay('Pickup Thu 12/8 14:30', '2026-08-12T06:30:00.000Z', NOW, 'en'),
  'Pickup Wednesday, August 12 2:30 PM', 'booked ahead 3 days · rebuilt, not passed through');
is(deliverySlotDisplay('Pickup Today 14:30', '2026-08-10T06:30:00.000Z', NOW, 'en'),
  'Pickup Tomorrow 2:30 PM', 'tomorrow');
is(deliverySlotDisplay('Pickup Today 14:30', '2025-12-14T06:30:00.000Z', NOW, 'en'),
  'Pickup Dec 14, 2025 2:30 PM', 'year boundary · past');
is(deliverySlotDisplay('Pickup Today 14:30', '2027-01-05T06:30:00.000Z', NOW, 'en'),
  'Pickup Tuesday, January 5, 2027 2:30 PM', 'year boundary · ahead');

console.log('\nPickup · Chinese — the viewer decides, and the stored label is always English');
is(deliverySlotDisplay('Pickup Today 14:30', PU_1430, NOW, 'cn'),
  '自提 今天 14:30', 'same day · the live case');
is(deliverySlotDisplay('Pickup Today 18:00', PU_1800, gz('2026-08-09T09:00:00'), 'cn'),
  '自提 8月8日 18:00', 'UNCOLLECTED across midnight — the real bug');
is(deliverySlotDisplay('Pickup Thu 12/8 14:30', '2026-08-12T06:30:00.000Z', NOW, 'cn'),
  '自提 8月12日 周三 14:30', 'booked ahead 3 days · rebuilt, not passed through');
is(deliverySlotDisplay('Pickup Today 14:30', '2026-08-10T06:30:00.000Z', NOW, 'cn'),
  '自提 明天 14:30', 'tomorrow');
is(deliverySlotDisplay('Pickup Today 14:30', '2025-12-14T06:30:00.000Z', NOW, 'cn'),
  '自提 2025年12月14日 14:30', 'year boundary · past');
is(deliverySlotDisplay('Pickup Today 14:30', '2027-01-05T06:30:00.000Z', NOW, 'cn'),
  '自提 2027年1月5日 周二 14:30', 'year boundary · ahead');

console.log('\nPickup · midnight in Asia/Shanghai');
is(deliverySlotDisplay('Pickup Today 14:30', '2026-08-10T06:30:00.000Z', gz('2026-08-09T23:59:00'), 'en'),
  'Pickup Tomorrow 2:30 PM', '23:59 GZ · still Tomorrow');
is(deliverySlotDisplay('Pickup Today 14:30', '2026-08-10T06:30:00.000Z', gz('2026-08-10T00:01:00'), 'en'),
  'Pickup Today 2:30 PM', '00:01 GZ · flipped to Today');
is(deliverySlotDisplay('Pickup Today 14:30', '2026-08-10T06:30:00.000Z', gz('2026-08-09T23:59:00'), 'cn'),
  '自提 明天 14:30', 'cn · 23:59 GZ');
is(deliverySlotDisplay('Pickup Today 14:30', '2026-08-10T06:30:00.000Z', gz('2026-08-10T00:01:00'), 'cn'),
  '自提 今天 14:30', 'cn · 00:01 GZ');

console.log('\nPickup · the two clock cases a 12-hour EN render always gets wrong');
is(deliverySlotDisplay('Pickup Today 00:00', '2026-08-08T16:00:00.000Z', NOW, 'en'),
  'Pickup Today 12:00 AM', 'GZ midnight → 12:00 AM, and 16:00Z belongs to the NEXT GZ day');
is(deliverySlotDisplay('Pickup Today 00:00', '2026-08-07T16:00:00.000Z', NOW, 'en'),
  'Pickup Aug 8 12:00 AM', 'the midnight before · past branch, still 12:00 AM');
is(deliverySlotDisplay('Pickup Today 00:00', '2026-08-08T16:00:00.000Z', NOW, 'cn'),
  '自提 今天 00:00', 'cn · midnight stays 00:00');
is(deliverySlotDisplay('Pickup Today 12:00', '2026-08-09T04:00:00.000Z', NOW, 'en'),
  'Pickup Today 12:00 PM', 'GZ noon → 12:00 PM');

console.log('\nPickup · degrades to the stored label rather than a partial line');
is(deliverySlotDisplay('Pickup Today 14:30', null, NOW, 'cn'),
  'Pickup Today 14:30', 'no scheduled_for');
is(deliverySlotDisplay('Pickup Today 14:30', 'not-a-date', NOW, 'cn'),
  'Pickup Today 14:30', 'junk scheduled_for');
is(deliverySlotDisplay('Pickup Today 14:30', PU_1430, NOW),
  'Pickup Today 2:30 PM', 'no lang argument → English');

console.log('\nPickup · the guard is anchored, not a contains-test');
is(deliverySlotDisplay('Pickuptoday 14:30', PU_1430, NOW, 'en'),
  'Pickuptoday 14:30', 'no word boundary after the lead word');
is(deliverySlotDisplay('Ships when restocked', PU_1430, NOW, 'cn'),
  'Ships when restocked', 'a label merely containing no lead word');

/* ── The host clock must not be able to reach any of this ──────────────
   Re-runs this file under four host zones spanning UTC-5 to UTC+14. The
   sweep is skipped inside the child runs (SLOT_LABEL_TZ_SWEEP) so it does
   not recurse. */
if (!process.env.SLOT_LABEL_TZ_SWEEP) {
  console.log('\nHost timezone independence — the same file under four zones');
  for (const zone of ['UTC', 'Asia/Shanghai', 'America/New_York', 'Pacific/Kiritimati']) {
    let out = '';
    try {
      out = execFileSync(process.execPath, [__filename], {
        env: { ...process.env, TZ: zone, SLOT_LABEL_TZ_SWEEP: '1' },
        encoding: 'utf8',
      });
    } catch (e) {
      out = String((e.stdout || '') + (e.stderr || ''));
    }
    const m = /^(\d+) passed, (\d+) failed$/m.exec(out);
    is(m ? m[2] : 'no result', '0', 'TZ=' + zone + ' · ' + (m ? m[1] + ' passed' : 'DID NOT RUN'));
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
