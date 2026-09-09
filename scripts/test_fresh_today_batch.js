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
    assert.strictEqual(retail.localFreshFloorFor(d), d.make_date,
      'and the floor is that later day, not the closed one');
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
  it('the §74 case floors on TODAY, which reads as no constraint downstream', () => {
    assert.strictEqual(retail.localFreshFloorFor(decide(MORNING_OF_BATCH_DAY)), BATCH_DAY);
  });
  it('an ordinary shortage floors on a future day, which withdraws today', () => {
    assert.strictEqual(retail.localFreshFloorFor(decide(AFTERNOON_OF_BATCH_DAY)), NEXT_BATCH);
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
section('5 · the calendar is left alone — every window today survives');
// DECIDED BY ASH, against a first version that withdrew today's windows starting
// before ready_hour and withdrew "right away" with them. Redundant twice over.
//
// A window is a WINDOW: 10:00–12:00 is honoured by a batch that lands at 11:00,
// so withdrawing it refused an order the kitchen could serve. And the honesty it
// reached for is enforced a layer down, and better — a sold-out same-day
// Guangzhou cart meets analyzeShortage's modal, whose wait_for_restock branch
// CLEARS scheduled_for, refunds the same-day surcharge and relabels the order
// "Ships when restocked", so a parked order carries no time promise whatever was
// picked, 'right_away' included.
{
  schedule(READY_HOUR);
  setStock(P_FRESH, 0);
  const floor = retail.localFreshFloorFor(decide(MORNING_OF_BATCH_DAY));
  const sched = retail.computeDeliverySlots(ZONE_GZ, MORNING_OF_BATCH_DAY,
    { localFreshFloor: floor });
  const todaySlots = sched.slots.filter((s) => s.is_same_day);

  it('the floor is a plain date — no hour rides along with it', () => {
    assert.strictEqual(floor, BATCH_DAY);
  });
  it('today is on offer — the customer is not pushed to tomorrow', () => {
    assert.ok(todaySlots.length > 0, 'expected same-day windows, got none');
  });
  it('the 10:00–12:00 window is still bookable, batch or no batch', () => {
    assert.ok(todaySlots.some((s) => s.start_hour === 10),
      `expected the 10:00 window; got ${todaySlots.map((s) => s.slot_id).join(', ')}`);
  });
  it('the afternoon is there too', () => {
    assert.ok(todaySlots.some((s) => s.start_hour >= 12));
  });
  it('"right away" is untouched — wait_for_restock is what makes it honest', () => {
    const open = retail.computeDeliverySlots(ZONE_GZ, MORNING_OF_BATCH_DAY, {});
    assert.strictEqual(sched.right_away_available, open.right_away_available);
  });
  it('the floored calendar is identical to the unfloored one on this day', () => {
    const open = retail.computeDeliverySlots(ZONE_GZ, MORNING_OF_BATCH_DAY, {});
    assert.deepStrictEqual(sched.slots.map((s) => s.slot_id), open.slots.map((s) => s.slot_id),
      'a floor of TODAY must read as no constraint anywhere');
  });
  // And the ordinary shortage still withdraws today, which is the case the floor
  // was built for and must not be lost in removing the hour.
  it('a shortage on a NON-cooking morning still takes today away', () => {
    const later = retail.localFreshFloorFor(decide(MORNING_OF_NON_BATCH_DAY));
    assert.strictEqual(later, NEXT_BATCH);
    const s2 = retail.computeDeliverySlots(ZONE_GZ, MORNING_OF_NON_BATCH_DAY,
      { localFreshFloor: later });
    assert.strictEqual(s2.slots.filter((x) => x.is_same_day).length, 0,
      'today must be withdrawn when the batch really is on a later day');
    assert.strictEqual(s2.right_away_available, false);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('5b · the order the customer actually places carries no time promise');
// The mechanism Ash's ruling leans on, asserted against the source rather than
// assumed: whatever window is picked, the wait branch clears it.
{
  const fs = require('fs');
  const src = fs.readFileSync(path.join(ROOT, 'routes/retail.js'), 'utf8');
  it('wait_for_restock clears scheduled_for, the surcharge and the label', () => {
    // Anchored on the slot-clearing branch itself, NOT on `indexOf('if
    // (isWaitFlow) {')` — the routing branch three hundred lines earlier reads
    // `} else if (isWaitFlow) {`, which contains that substring, so a bare
    // indexOf lands there and asserts nothing about this. The same trap
    // test_confined_role_home.js recorded against itself (v4.171).
    const at = src.indexOf("slotLabel         = 'Ships when restocked';");
    assert.ok(at > -1, 'the slot-clearing branch exists');
    const body = src.slice(Math.max(0, at - 260), at + 60);
    assert.ok(/scheduledFor\s*=\s*null/.test(body), 'the picked window is dropped');
    assert.ok(/sameDaySurcharge\s*=\s*0/.test(body), 'the same-day surcharge is refunded');
    assert.ok(/slotLabel\s*=\s*'Ships when restocked'/.test(body), 'and it is relabelled');
  });
  it('the shortage modal is what a sold-out same-day Guangzhou cart meets', () => {
    const inv = fs.readFileSync(path.join(ROOT, 'lib/inventory.js'), 'utf8');
    assert.ok(/if \(!requiresStockGate\(\{ address, deliverySlotId \}\)\)/.test(inv),
      'analyzeShortage gates on GZ + same-day');
    assert.ok(/gate = 'options_5'/.test(inv), 'and offers the five-option flow');
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
  // ── The A4 Console rebuild (2026-09-09) ────────────────────────────────
  const freshBlock = () => {
    const a = html.indexOf('id="dlv-fresh"');
    const b = html.indexOf('PACKAGE TRACKING VIEW');
    assert.ok(a > 0 && b > a, 'the fresh batches view is still findable');
    return html.slice(a, b);
  };

  it('one card is one save — the evening-before lock rides batch.schedule', () => {
    assert.ok(/'fresh\.rescheduleCutoffHour': rawResched/.test(js));
    assert.ok(!/async function saveRescheduleSettings/.test(js),
      'the function is gone, and so is the card that was its only caller');
    assert.ok(/id="fresh-resched-cutoff"/.test(html), 'the input it saved is still on the page');
  });

  it('no label on the card is glued — the walker needs space-middot-space', () => {
    // The runtime splitter only CONSIDERS a text node containing ' · '. Seven
    // labels here used to write '(中文)· English' with no leading space, so they
    // were never split and rendered both languages at once in both settings.
    const bad = [...freshBlock().matchAll(/>([^<>]*·[^<>]*)</g)]
      .map((m) => m[1].trim())
      .filter((t) => !t.includes(' · '));
    assert.deepStrictEqual(bad, [], 'a middot with no space either side never splits');
  });

  it('every pair on the card is English-first, or the walker bails', () => {
    // Second gate: the left half must be Chinese-free and the right half must
    // have Chinese, or `if (!hasChinese(cn) || hasChinese(en)) return;` returns.
    const cjk = /[\u4e00-\u9fff]/;
    const bad = [...freshBlock().matchAll(/>([^<>]* · [^<>]*)</g)]
      .map((m) => m[1].trim())
      .filter((t) => cjk.test(t.split(' · ')[0]));
    assert.deepStrictEqual(bad, [], 'Chinese on the left of the middot kills the split');
  });

  it('no pair is fragmented by inline markup — README Conventions gotcha', () => {
    // The " · " split runs PER TEXT NODE. A <code>/<b>/<span> sitting between
    // the English and the Chinese leaves the pair's own node holding only a
    // scrap of English, so the prose before it survives into the other
    // language and BOTH leak. An element carrying no text (the back button's
    // svg icon) is not markup between the halves and does not count.
    const blk = freshBlock();
    const bad = [];
    // Element opens, then TEXT with words, then more markup, then the pair.
    const re = /<(div|span|label|h3|p|button)\b[^>]*>([^<>]*[A-Za-z]{3}[^<>]*)<[a-z][^>]*>[\s\S]{0,200}?·/g;
    let m;
    while ((m = re.exec(blk))) {
      const between = blk.slice(m.index, re.lastIndex);
      // svg-only icons carry no text; anything with letters inside the tag does
      if (/<(code|b|strong|em|i|span)\b[^>]*>[^<>]*[A-Za-z0-9{]/.test(between)) bad.push(m[2].trim().slice(0, 70));
    }
    assert.deepStrictEqual(bad, [], 'a pair split across text nodes leaks both languages');
  });

  it('the card carries no uppercase eyebrow classes (§1.6)', () => {
    const blk = freshBlock();
    assert.ok(!/class="[^"]*\bstacked\b/.test(blk), 'label.stacked is uppercase 600');
    assert.ok(!/class="[^"]*\bfc-sec\b/.test(blk), '.fc-sec is mono-caps 700');
  });

  it('a hidden language pane actually hides — display:flex beats [hidden]', () => {
    const css = fs.readFileSync(path.join(ROOT, 'public/retail-admin.css'), 'utf8');
    assert.ok(/#dlv-fresh \.fb-fields\[hidden\] \{ display: none; \}/.test(css));
  });

  it('blank round-trips as blank — the off switch must not pick up a default', () => {
    assert.ok(/batch\.ready_hour != null \? batch\.ready_hour : ''/.test(js));
    assert.ok(/rawReady === '' \? null : parseInt\(rawReady, 10\)/.test(js));
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('8 · §80 — nothing is short from the customer\'s side');
// Ash, on being walked through §74 as shipped: "why tell him its short? he
// doesnt need to wait. there is a new batch made and ready at 11, we deliver on
// time according to his request." He was right, and the shipped behaviour was
// worse than the walkthrough said: the five-option modal fired, and choosing
// "wait for restock" DELETED the window he had picked.
{
  schedule(READY_HOUR);
  setStock(P_FRESH, 0);
  const covered = (slotId, now = MORNING_OF_BATCH_DAY, ids = [P_FRESH]) =>
    retail.freshLinesCoveredToday({ zone: ZONE_GZ, deliverySlotId: slotId, productIds: ids, now });

  it('THE 10:00–12:00 WINDOW IS COVERED — the end is the rule, not the start', () => {
    // The slot Ash named. A batch landing at 11:00 serves a window closing at
    // 12:00, so keying on the start hour would have refused exactly this one.
    assert.ok(covered(BATCH_DAY + 'T10:00').has(P_FRESH));
  });
  it('so is a window entirely after the batch', () => {
    assert.ok(covered(BATCH_DAY + 'T12:00').has(P_FRESH));
  });
  it('a window that CLOSES before the batch lands is not covered', () => {
    // ready 18:00 against a 10:00–12:00 window: the meal cannot make it.
    schedule(18);
    assert.strictEqual(covered(BATCH_DAY + 'T10:00').size, 0);
    schedule(READY_HOUR);
  });
  it('"right away" is never covered — it names no window to close by', () => {
    assert.strictEqual(covered('right_away').size, 0);
  });
  it('a day-only chip closes when the kitchen does, so it is covered', () => {
    assert.ok(covered(BATCH_DAY).has(P_FRESH));
  });
  it('nothing is covered on a day the kitchen does not cook', () => {
    assert.strictEqual(covered(NON_BATCH_DAY + 'T12:00', MORNING_OF_NON_BATCH_DAY).size, 0);
  });
  it('nothing is covered once the batch has landed', () => {
    assert.strictEqual(covered(BATCH_DAY + 'T16:00', AFTERNOON_OF_BATCH_DAY).size, 0);
  });
  it('nothing is covered with no ready hour — §80 is off with §74', () => {
    schedule(null);
    assert.strictEqual(covered(BATCH_DAY + 'T10:00').size, 0);
    schedule(READY_HOUR);
  });
  it('a grocery line is never covered — no batch is coming for it', () => {
    assert.strictEqual(covered(BATCH_DAY + 'T12:00', MORNING_OF_BATCH_DAY, [P_PANTRY]).size, 0);
  });

  it('slotWindowEnd reads the zone rather than assuming two hours', () => {
    const end = retail.slotWindowEnd({ ...ZONE_GZ, slot_duration_minutes: 90 },
      BATCH_DAY + 'T10:00', MORNING_OF_BATCH_DAY);
    assert.strictEqual(end.getHours(), 11);
    assert.strictEqual(end.getMinutes(), 30);
    assert.strictEqual(retail.slotWindowEnd(ZONE_GZ, 'right_away', MORNING_OF_BATCH_DAY), null);
    assert.strictEqual(retail.slotWindowEnd(ZONE_GZ, null, MORNING_OF_BATCH_DAY), null);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('9 · the modal does not fire, and the window survives');
{
  const fs = require('fs');
  const inv = fs.readFileSync(path.join(ROOT, 'lib/inventory.js'), 'utf8');
  const src = fs.readFileSync(path.join(ROOT, 'routes/retail.js'), 'utf8');

  it('a covered line counts as OK, so the five-option gate never opens', () => {
    assert.ok(/ok: isCovered \|\| \(av\.exists && av\.available >= it\.qty\)/.test(inv),
      'analyzeShortage treats a covered line as satisfied');
    assert.ok(/gate = 'options_5'/.test(inv) && /if \(nearest && !nearest\.ok\)/.test(inv),
      'and the gate still keys on nearest.ok, so covering the line closes it');
  });
  it('the covered set is computed by retail.js, not re-derived in inventory.js', () => {
    assert.ok(!/batchScheduleCfg|ready_hour/.test(inv),
      'lib/inventory.js must stay a stock question and learn no production cadence');
    assert.ok(/coveredProductIds: freshLinesCoveredToday\(/.test(src), 'the quote hands it down');
  });
  it('the order parks without reserving — there is nothing on the shelf to hold', () => {
    assert.ok(/if \(!isWaitFlow && !isBatchPark && \(stockGate \|\| strictItems\.length\)\) \{/.test(src));
  });
  it('…and KEEPS the window, which is the whole of Ash\'s ruling', () => {
    // isWaitFlow clears scheduled_for. isBatchPark must not appear in that
    // branch at all, or the window the batch was going to fill is thrown away.
    const at = src.indexOf("slotLabel         = 'Ships when restocked';");
    assert.ok(at > -1);
    const branch = src.slice(at - 300, at + 60);
    assert.ok(/if \(isWaitFlow\) \{/.test(branch), 'the clearing branch is isWaitFlow only');
    assert.ok(!/isBatchPark/.test(branch), 'a batch park must never reach the slot-clearing branch');
  });
  it('the quote reads one clock, declared before anything uses it', () => {
    // The first wiring put the covered-lines call ABOVE `const quoteNow`, which
    // is a ReferenceError on every checkout quote, not a lint error.
    const h = src.indexOf("router.post('/api/retail/checkout/quote'");
    const decl = src.indexOf('const quoteNow = new Date();', h);
    const use  = src.indexOf('now: quoteNow', h);
    assert.ok(decl > -1 && use > -1 && decl < use, 'quoteNow is declared before it is read');
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
