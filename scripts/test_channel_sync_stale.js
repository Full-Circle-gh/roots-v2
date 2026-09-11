#!/usr/bin/env node
/**
 * The "channel stopped accepting stock updates" card — lib/channel-sync-stale.js.
 *
 *   node scripts/test_channel_sync_stale.js
 *
 * WHAT IS BEING PROTECTED IS THE DENOMINATOR, not that a card appears. This
 * module's whole job is to measure time a channel COULD HAVE USED to send a
 * push, and every bug it has had has been a wrong model of that time rather
 * than a wrong query:
 *
 *   • Eleme was scored as if its pushes waited for opening hours. They never
 *     did — eleme-daemon's processStockQueue is gated on the operator's
 *     channel-close switch alone — so every overnight Eleme stall was scored at
 *     zero for the hours it was most likely to be stuck.
 *   • §102 then gave the daemons a SECOND pushable window, the pre-order one,
 *     and a file that knows only about opening hours would stay silent through
 *     a jam on a batch morning — the exact window §102 exists for.
 *
 * Both directions are asserted here: time that counts, and time that must not.
 * A suite that only checked "a stale row produces a card" would pass on either
 * of those and has nothing to say about the hours in between.
 *
 * NO DATABASE. The two functions under test take their config through a handle
 * they only ever `prepare().get()` on, so a literal stands in for it and the
 * arithmetic is visible in the test rather than seeded into a table.
 */
'use strict';

const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const stale = require(path.join(ROOT, 'lib', 'channel-sync-stale.js'));
const { pushableElapsedMs, preorderSpans, CHANNELS } = stale;

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
const section = (t) => console.log('\n' + t);

const MIN = 60_000, HOUR = 60 * MIN;
// Shanghai midnight (fixed +8, this module's own convention) for a known day.
// 2026-09-08 is a batch day on the anchor below; 2026-09-09 is not.
const day = (ymd) => Date.parse(`${ymd}T00:00:00+08:00`);
const at = (ymd, h, m = 0) => day(ymd) + h * HOUR + m * MIN;
const BATCH = '2026-09-08', NON_BATCH = '2026-09-09';

// A 10:00–20:00 shop with no explicit sync start ⇒ syncWindow opens at 08:00.
const HOURS = { open: 10 * 60, close: 20 * 60, syncStart: null };

// A db that answers exactly the one read lib/batch-cadence performs.
const fakeDb = (batchSchedule) => ({
  prepare: () => ({
    get: () => (batchSchedule ? { value_json: JSON.stringify(batchSchedule) } : undefined),
  }),
});
const SCHEDULE = {
  enabled: true, anchor_date: '2026-06-16', interval_days: 2, skip_dates: [],
  cutoff_hour: 20, ready_hour: 11, lock_hour: 11,
  preorder_open_hour: 0, preorder_qty: 20,
  preorder_channels: ['meituan', 'eleme', 'gzgrocery'],
};

// ═══════════════════════════════════════════════════════════════════════════
section('1 · which channels are scored against opening hours at all');
{
  const by = Object.fromEntries(CHANNELS.map((c) => [c.key, c]));

  it('Meituan is hours-aware — its push queue really does wait for the gate', () => {
    assert.strictEqual(by.meituan.hoursAware, true);
  });
  it('ELEME IS NOT — its pushes have never been hours-gated', () => {
    /* The correction. eleme-daemon.js's processStockQueue filters on
       channelClosedStores('eleme') and nothing else; only its ORDER POLL reads
       the hours. Scoring it as hours-aware made every overnight stall invisible
       until the shop opened. */
    assert.strictEqual(by.eleme.hoursAware, false);
    assert.strictEqual(by.eleme.openGraceMin, 0, 'and there is no window to grace');
  });
  it('GZ Grocery is unchanged — it has never had an opening-hours concept', () => {
    assert.strictEqual(by.guanyi.hoursAware, false);
  });
  it('every channel still declares a queue table and a label', () => {
    for (const c of CHANNELS) {
      assert.ok(c.key && c.label && /^[a-z_]+$/.test(c.queueTable), `${c.key} is fully declared`);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('2 · the elapsed sum without a pre-order window (the behaviour that existed)');
{
  it('a row queued mid-window accrues wall-clock while the window is open', () => {
    assert.strictEqual(pushableElapsedMs(at(BATCH, 12), at(BATCH, 14), HOURS, 15), 2 * HOUR);
  });
  it('the overnight hours score ZERO — the daemon could not have sent them', () => {
    assert.strictEqual(pushableElapsedMs(at(BATCH, 21), at(NON_BATCH, 5), HOURS, 15), 0);
  });
  it('a row that spans a close and the next open counts only the open parts', () => {
    // 19:00 → 20:15 is 75 min of window (close 20:00 + 15 grace), then 08:00 →
    // 09:00 the next morning is 60 more.
    const got = pushableElapsedMs(at(BATCH, 19), at(NON_BATCH, 9), HOURS, 15);
    assert.strictEqual(got, 75 * MIN + 60 * MIN);
  });
  it('no hours on file means always-on, so it is plain wall-clock', () => {
    assert.strictEqual(pushableElapsedMs(at(BATCH, 2), at(BATCH, 5), null, 15), 3 * HOUR);
  });
  it('a backwards or empty interval is zero, not negative', () => {
    assert.strictEqual(pushableElapsedMs(at(BATCH, 14), at(BATCH, 12), HOURS, 15), 0);
    assert.strictEqual(pushableElapsedMs(at(BATCH, 14), at(BATCH, 14), HOURS, 15), 0);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('3 · §102 — the pre-order window is pushable time');
{
  const pre = () => preorderSpans(fakeDb(SCHEDULE), 'meituan');

  it('A JAM AT 00:30 ON A BATCH MORNING ACCRUES IMMEDIATELY', () => {
    /* The one that matters. Without this the card scores zero until 08:00 and
       stays silent through the window §102 exists to keep syncing. */
    const got = pushableElapsedMs(at(BATCH, 0, 30), at(BATCH, 2), HOURS, 15, pre());
    assert.strictEqual(got, 90 * MIN);
  });
  it('…and stops at the lock hour, not at the shop opening', () => {
    // 00:00 → 11:00 is the pre-order window (11h); 08:00 → 11:00 already lies
    // inside the sync window, so the merge must not count those 3h twice.
    const got = pushableElapsedMs(day(BATCH), at(BATCH, 11), HOURS, 15, pre());
    assert.strictEqual(got, 11 * HOUR, 'overlapping windows merge rather than double-count');
  });
  it('a day the kitchen does not cook gets NO extra credit', () => {
    assert.strictEqual(
      pushableElapsedMs(at(NON_BATCH, 0, 30), at(NON_BATCH, 2), HOURS, 15, pre()), 0);
  });
  it('a tenant-set later start is honoured — 06:00 means nothing before 06:00', () => {
    const p = preorderSpans(fakeDb({ ...SCHEDULE, preorder_open_hour: 6 }), 'meituan');
    assert.strictEqual(pushableElapsedMs(at(BATCH, 4), at(BATCH, 5), HOURS, 15, p), 0);
    assert.strictEqual(pushableElapsedMs(at(BATCH, 6), at(BATCH, 7), HOURS, 15, p), HOUR);
  });
  it('the ordering cutoff wins over a lock set past it, as batch-cadence rules', () => {
    // lock 23 but cutoff 20 ⇒ the window this file credits closes at 20:00, or
    // the card would credit time the daemon's own gate refused.
    const p = preorderSpans(fakeDb({ ...SCHEDULE, lock_hour: 23, cutoff_hour: 20 }), 'meituan');
    const span = p.spanOn(day(BATCH));
    assert.deepStrictEqual(span, [0, 20 * 60]);
  });
  it('a skipped date (a holiday) is not a batch day here either', () => {
    const p = preorderSpans(fakeDb({ ...SCHEDULE, skip_dates: [BATCH] }), 'meituan');
    assert.strictEqual(p.spanOn(day(BATCH)), null);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('4 · every off switch returns null, so most tenants pay one null check');
{
  const off = (patch, ch = 'meituan') => preorderSpans(fakeDb(patch), ch);

  it('no schedule row at all — the case of every tenant who never switched it on', () => {
    assert.strictEqual(preorderSpans(fakeDb(null), 'meituan'), null);
  });
  it('the schedule switched off', () => assert.strictEqual(off({ ...SCHEDULE, enabled: false }), null));
  it('no allowance set', () => assert.strictEqual(off({ ...SCHEDULE, preorder_qty: 0 }), null));
  it('this channel not named', () => {
    assert.strictEqual(off({ ...SCHEDULE, preorder_channels: ['eleme'] }, 'meituan'), null);
  });
  it('no lock hour and no ready hour to fall back to', () => {
    assert.strictEqual(off({ ...SCHEDULE, lock_hour: null, ready_hour: null }), null);
  });
  it('a start at or after the close is a window that never opens', () => {
    assert.strictEqual(off({ ...SCHEDULE, preorder_open_hour: 11, lock_hour: 11 }), null);
  });
  it('a broken handle is null, not a thrown dashboard', () => {
    const broken = { prepare() { throw new Error('database is locked'); } };
    assert.strictEqual(preorderSpans(broken, 'meituan'), null);
    assert.strictEqual(preorderSpans(null, 'meituan'), null);
  });
  it('null preorder leaves the sum exactly as section 2 measured it', () => {
    assert.strictEqual(pushableElapsedMs(at(BATCH, 0, 30), at(BATCH, 2), HOURS, 15, null), 0);
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
