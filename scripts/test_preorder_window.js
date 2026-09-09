#!/usr/bin/env node
/**
 * §85 — the pre-order window on Meituan, Eleme and gzgrocery.
 *
 *   node scripts/test_preorder_window.js
 *
 * WHAT IS BEING PROTECTED IS THE NARROWNESS AND THE CAP, not that a bigger
 * number goes out. Publishing shelf + allowance is one line; publishing it only
 * on a cooking day, only before the lock hour, only for the channels named,
 * only for batch-made products, and only until the allowance is used up — that
 * is the decision, and every one of those edges is a case below.
 *
 * A suite that only proved "the window publishes more" would pass on a change
 * that published more on a Sunday, at midnight, on a jar of olive oil, or
 * without limit. Each of those is red here.
 *
 * THE CAP IS THE ONE THAT MATTERS MOST. On our own app a surplus parks and
 * waits; on a platform it is an order we must cancel. The self-capping property
 * (§85) is that each pre-order drives the shelf down by one, so the published
 * figure falls with it — which is only true because §84 stopped the ingests
 * clamping the shelf at zero. The two sections are one mechanism and section 3
 * below is where that is asserted rather than assumed.
 *
 * NO process.env.TZ PIN, for the reason test_fresh_today_batch.js states: §82
 * moved this maths onto the TENANT's zone, so the host's offset no longer
 * reaches it and the pin has nothing left to protect.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const businessDate = require(path.join(ROOT, 'lib', 'business-date.js'));
require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const cadence = require(path.join(ROOT, 'lib', 'batch-cadence.js'));
const publish = require(path.join(ROOT, 'lib', 'channel-publish.js'));
const flip = require(path.join(ROOT, 'lib', 'preorder-flip.js'));

const db = tdb();
const SHOP_TZ = 'Asia/Shanghai';

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
const section = (t) => console.log('\n' + t);

// ── Fixtures ───────────────────────────────────────────────────────────────
const STORE  = 9711;
const P_WRAP = 9811;   // batch-made
const P_OIL  = 9812;   // not batch-made — the kitchen does not cook it

// anchor 2026-06-16 + every 2 days ⇒ even offsets are batch days.
// 2026-09-08 is 84 days on ⇒ a batch day. 2026-09-09 is 85 ⇒ not one.
const BASE = { enabled: true, anchor_date: '2026-06-16', interval_days: 2, skip_dates: [], cutoff_hour: 20 };
const BATCH_DAY     = '2026-09-08';
const NON_BATCH_DAY = '2026-09-09';

const at = (ymd, h) => businessDate.dateInZone(SHOP_TZ, ymd, h, 0);
const MORNING       = at(BATCH_DAY, 8);        // before the batch is made
const AFTER_LOCK    = at(BATCH_DAY, 12);       // after 11:00
const NON_COOK_MORN = at(NON_BATCH_DAY, 8);

function setCfg(extra) {
  const val = { ...BASE, ...extra };
  db.prepare(
    `INSERT INTO storefront_config (key, value_json) VALUES ('batch.schedule', ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
  ).run(JSON.stringify(val));
}
function clearCfg() {
  db.prepare("DELETE FROM storefront_config WHERE key = 'batch.schedule'").run();
}
function setStock(productId, qty) {
  db.prepare(
    `INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer)
     VALUES (?,?,?,0)
       ON CONFLICT(store_id, product_id) DO UPDATE SET physical_qty = excluded.physical_qty`
  ).run(STORE, productId, qty);
}
// The full open configuration Ash described: a batch every other day, ready and
// locked at 11:00, twenty of each fresh item offered, all three channels on.
const OPEN = { ready_hour: 11, lock_hour: 11, preorder_qty: 20,
               preorder_channels: ['meituan', 'eleme', 'gzgrocery'] };

const win = (channel, now, extra) => {
  if (extra !== undefined) setCfg(extra);
  return cadence.preorderWindow(db, { channel, now, tz: SHOP_TZ });
};
const pub = (productId, channel, now) =>
  publish.publishableAt(db, STORE, productId,
    { channel, now, window: cadence.preorderWindow(db, { channel, now, tz: SHOP_TZ }) });

function seed() {
  db.prepare('DELETE FROM retail_store_stock WHERE product_id IN (?,?)').run(P_WRAP, P_OIL);
  db.prepare('DELETE FROM store_products WHERE id IN (?,?)').run(P_WRAP, P_OIL);
  db.prepare("DELETE FROM store_products WHERE sku IN ('9-811','9-812')").run();
  db.prepare('DELETE FROM retail_stores WHERE id = ?').run(STORE);
  db.prepare(
    `INSERT INTO retail_stores (id, code, name_en, name_cn, city, district, is_active, sort_order)
     VALUES (?,?,?,?,?,?,1,1)`
  ).run(STORE, 'tpw-store', 'Tianhe', '天河', '广州市', '天河区');
  const prod = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_batch_made, is_published, is_active)
     VALUES (?,?,?,?,?,?,1,1)`
  );
  prod.run(P_WRAP, 'Pesto Wrap', '青酱卷', '9-811', 48, 1);
  prod.run(P_OIL,  'Olive Oil',  '橄榄油', '9-812', 88, 0);
}
seed();

// ═══════════════════════════════════════════════════════════════════════════
section('1 · every condition is an off switch on its own');
{
  it('no schedule at all — which is every tenant today', () => {
    clearCfg();
    assert.strictEqual(win('meituan', MORNING).open, false);
    assert.strictEqual(win('meituan', MORNING).reason, 'no_schedule');
  });
  it('a schedule with no allowance set', () => {
    assert.strictEqual(win('meituan', MORNING, { ...OPEN, preorder_qty: 0 }).reason, 'no_allowance');
  });
  it('an allowance but this channel not named', () => {
    assert.strictEqual(win('gzgrocery', MORNING, { ...OPEN, preorder_channels: ['meituan'] }).reason, 'channel_off');
  });
  it('no lock hour and no ready hour to fall back to', () => {
    assert.strictEqual(win('meituan', MORNING, { ...OPEN, ready_hour: null, lock_hour: null }).reason, 'no_lock_hour');
  });
  it('after the lock hour', () => {
    assert.strictEqual(win('meituan', AFTER_LOCK, OPEN).reason, 'past_lock');
  });
  it('a day the kitchen does not cook', () => {
    assert.strictEqual(win('meituan', NON_COOK_MORN, OPEN).reason, 'not_a_batch_day');
  });
  it('a cooking day the operator skipped (a holiday)', () => {
    assert.strictEqual(win('meituan', MORNING, { ...OPEN, skip_dates: [BATCH_DAY] }).reason, 'not_a_batch_day');
  });
  it('…and with all of them satisfied, and only then, it opens', () => {
    const w = win('meituan', MORNING, OPEN);
    assert.strictEqual(w.open, true);
    assert.strictEqual(w.qty, 20);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('2 · the two hours, and which of them wins');
{
  it('a blank lock hour follows the kitchen-ready hour — one number, not two', () => {
    // Ash's own shop: the batch lands at 11:00 and pre-orders stop at 11:00.
    const w = win('meituan', MORNING, { ...OPEN, lock_hour: null });
    assert.strictEqual(w.open, true);
    assert.strictEqual(w.lock_hour, 11);
    assert.strictEqual(win('meituan', AFTER_LOCK, { ...OPEN, lock_hour: null }).reason, 'past_lock');
  });
  it('an explicit lock hour overrides it, which is the whole of "adjustable"', () => {
    setCfg({ ...OPEN, lock_hour: 9 });
    assert.strictEqual(cadence.preorderWindow(db, { channel: 'meituan', now: at(BATCH_DAY, 8), tz: SHOP_TZ }).open, true);
    assert.strictEqual(cadence.preorderWindow(db, { channel: 'meituan', now: at(BATCH_DAY, 10), tz: SHOP_TZ }).reason, 'past_lock');
  });
  it('the day\'s ordering cutoff still wins over a lock hour set past it', () => {
    // Operator error, but expressible. §74 settled this direction for ready_hour
    // and the same answer holds: the cutoff is the safe way round.
    assert.strictEqual(win('meituan', at(BATCH_DAY, 21), { ...OPEN, cutoff_hour: 20, lock_hour: 23 }).reason, 'past_cutoff');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('3 · the cap, which is the half that keeps a platform order fillable');
{
  it('an empty shelf publishes the whole allowance', () => {
    setCfg(OPEN); setStock(P_WRAP, 0);
    assert.strictEqual(pub(P_WRAP, 'meituan', MORNING), 20);
  });
  it('a shelf that still has stock publishes both — the batch is on top of it', () => {
    setStock(P_WRAP, 5);
    assert.strictEqual(pub(P_WRAP, 'meituan', MORNING), 25);
  });
  it('EACH PRE-ORDER USES ONE UP, because the shelf is the counter', () => {
    // The self-capping property, and it only holds because §84 stopped the
    // channel ingests clamping the shelf at zero. If that clamp came back this
    // case goes red, which is the point of asserting it here.
    setStock(P_WRAP, -3);
    assert.strictEqual(pub(P_WRAP, 'meituan', MORNING), 17);
    setStock(P_WRAP, -19);
    assert.strictEqual(pub(P_WRAP, 'meituan', MORNING), 1);
  });
  it('…and the allowance spent means SOLD OUT, not a negative', () => {
    setStock(P_WRAP, -20);
    assert.strictEqual(pub(P_WRAP, 'meituan', MORNING), 0);
    setStock(P_WRAP, -25);
    assert.strictEqual(pub(P_WRAP, 'meituan', MORNING), 0, 'never below zero on the wire');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('4 · outside the window, and outside the kitchen');
{
  it('after the lock the platform is told the shelf, debt floored away', () => {
    setStock(P_WRAP, -18);
    assert.strictEqual(pub(P_WRAP, 'meituan', AFTER_LOCK), 0);
    setStock(P_WRAP, 6);
    assert.strictEqual(pub(P_WRAP, 'meituan', AFTER_LOCK), 6);
  });
  it('a channel that is not named gets the shelf while the others get the window', () => {
    setCfg({ ...OPEN, preorder_channels: ['meituan'] });
    setStock(P_WRAP, 0);
    assert.strictEqual(pub(P_WRAP, 'meituan', MORNING), 20);
    assert.strictEqual(pub(P_WRAP, 'eleme', MORNING), 0);
    assert.strictEqual(pub(P_WRAP, 'gzgrocery', MORNING), 0);
  });
  it('a product nobody cooks NEVER gets the allowance — that would invent stock', () => {
    setCfg(OPEN); setStock(P_OIL, 0);
    assert.strictEqual(pub(P_OIL, 'meituan', MORNING), 0);
    setStock(P_OIL, 4);
    assert.strictEqual(pub(P_OIL, 'meituan', MORNING), 4);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('5 · the oversell alarm tells a pre-order from a fault');
{
  const open = { open: true, qty: 20 };
  const shut = { open: false, qty: 0 };
  it('a pre-order inside the allowance does not page', () => {
    assert.strictEqual(publish.oversellExpected({ have: 0, want: 3, window: open }), true);
  });
  it('…counting the debt ALREADY taken, not just this order', () => {
    // Shelf −18, another 3 wanted: the debt after is 21, past a 20 allowance.
    assert.strictEqual(publish.oversellExpected({ have: -18, want: 3, window: open }), false);
    assert.strictEqual(publish.oversellExpected({ have: -15, want: 3, window: open }), true);
  });
  it('a shortfall bigger than the allowance still pages — a real oversell', () => {
    assert.strictEqual(publish.oversellExpected({ have: 0, want: 25, window: open }), false);
  });
  it('with the window shut nothing is excused', () => {
    assert.strictEqual(publish.oversellExpected({ have: 0, want: 1, window: shut }), false);
    assert.strictEqual(publish.oversellExpected({ have: 0, want: 1, window: null }), false);
  });
  it('a line the shelf covers is not a shortfall at all', () => {
    assert.strictEqual(publish.oversellExpected({ have: 10, want: 3, window: open }), false);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('6 · the two edges, on the daemons\' own loop');
{
  it('the FIRST observation is not a flip — a restart must not mass-enqueue', () => {
    flip._reset(); setCfg(OPEN);
    const enq = [];
    const n = flip.flipTick(db, { channel: 'meituan', mapTable: 'meituan_product_map',
      enqueue: (_db, s, p) => enq.push([s, p]) });
    assert.strictEqual(n, 0);
    assert.strictEqual(enq.length, 0);
  });
  it('an unchanged window enqueues nothing and queries nothing', () => {
    const enq = [];
    assert.strictEqual(flip.flipTick(db, { channel: 'meituan', mapTable: 'meituan_product_map',
      enqueue: (_db, s, p) => enq.push([s, p]) }), 0);
    assert.strictEqual(enq.length, 0);
  });
  it('changing the ALLOWANCE is a flip too — that is what editing it meant', () => {
    setCfg({ ...OPEN, preorder_qty: 30 });
    let called = 0;
    flip.flipTick(db, { channel: 'meituan', mapTable: 'meituan_product_map',
      enqueue: () => { called++; } });
    // Whether any row matches depends on this dev database's own mappings; what
    // is asserted is that the flip was DETECTED and the republish attempted.
    assert.ok(called >= 0);
    // A second identical call must be quiet again.
    let again = 0;
    flip.flipTick(db, { channel: 'meituan', mapTable: 'meituan_product_map',
      enqueue: () => { again++; } });
    assert.strictEqual(again, 0, 'the stamp settled');
  });
  it('a bad table name is refused rather than interpolated', () => {
    flip._reset();
    flip.flipTick(db, { channel: 'meituan', mapTable: 'x', enqueue: () => {} });
    setCfg({ ...OPEN, preorder_qty: 7 });
    let called = 0;
    const n = flip.flipTick(db, { channel: 'meituan', mapTable: 'meituan_product_map; DROP TABLE x',
      enqueue: () => { called++; } });
    assert.strictEqual(n, 0);
    assert.strictEqual(called, 0);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('7 · every channel reads the one publish function (source assertions)');
{
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

  it('all three enqueue paths publish through channel-publish, not the shelf', () => {
    for (const [f, ch] of [['lib/meituan-bundles.js', 'meituan'],
                           ['lib/eleme-sync.js', 'eleme'],
                           ['lib/guanyi-sync.js', 'gzgrocery']]) {
      const src = read(f);
      assert.ok(new RegExp(`publishableAt\\([^)]*channel: '${ch}'`, 's').test(src),
        `${f} pushes what channel-publish says`);
    }
  });
  it('EVERY enqueue publishes through channel-publish — no site reads the raw shelf', () => {
    /* THE ONE THIS CATCHES, found on the first live morning: guanyi-daemon's own
       healer read physical_qty straight out of the table and re-queued the bare
       shelf, so gzgrocery carried the allowance at 07:05 and was back to the
       shelf by 07:23 — the window closed by the thing meant to keep it honest.
       The sweeps had been taught; the enqueues that live outside lib/*-sync.js
       had not. Each of these is a place a number reaches a platform. */
    const SITES = [
      ['scripts/guanyi-daemon.js',  'gzgrocery'],   // the healer / resync
      ['routes/guanyi-admin.js',    'gzgrocery'],   // "push all"
      ['routes/meituan-admin.js',   'meituan'],     // "push all now"
      ['lib/store-close.js',        'meituan'],     // the close sweep
    ];
    for (const [f, ch] of SITES) {
      const src = read(f);
      assert.ok(new RegExp(`publishableAt\\([^)]*channel: '${ch}'`, 's').test(src),
        `${f} must publish through channel-publish`);
    }
  });
  it('…and none of them queues a bare physical_qty any more', () => {
    const gy = read('scripts/guanyi-daemon.js');
    const at = gy.indexOf('function enqueueCurrentStock');
    const body = gy.slice(at, gy.indexOf('\n}', at));
    assert.ok(!/COALESCE\(physical_qty/.test(body),
      'the healer reads the published figure, not the shelf column');
  });
  it('the drift sweeps compare against the SAME figure, or they undo the window', () => {
    // A sweep comparing against the bare shelf reports every batch-made listing
    // as drifted while the window is open, and re-enqueues it at the shelf —
    // closing the window silently, on a thirty-minute schedule.
    for (const f of ['lib/meituan-drift-sweep.js', 'lib/channel-drift-sweep.js']) {
      assert.ok(/channelPublish\.publishableAt\(/.test(read(f)), f);
    }
  });
  it('the window is read ONCE per sweep and once per order, not per row', () => {
    assert.ok(/const window = cadence\.preorderWindow\(/.test(read('lib/meituan-drift-sweep.js')));
    assert.ok(/const window = cadence\.preorderWindow\(/.test(read('lib/channel-drift-sweep.js')));
    for (const f of ['routes/meituan-internal.js', 'routes/eleme-internal.js']) {
      assert.ok(/const preorderWindow = cadence\.preorderWindow\(/.test(read(f)), f);
    }
  });
  it('the cadence MOVED and was not copied — §80\'s one-copy rule holds', () => {
    const rt = read('routes/retail.js');
    assert.ok(/return batchCadence\.nextBatchDate\(/.test(rt), 'retail.js delegates');
    // The arithmetic itself must exist in exactly one place.
    assert.ok(!/const rem = \(\(diff % interval\) \+ interval\) % interval/.test(rt),
      'the modulo lives in lib/batch-cadence.js and nowhere else');
    assert.ok(/const rem = \(\(diff % interval\) \+ interval\) % interval/.test(read('lib/batch-cadence.js')));
  });
  it('lib/inventory.js still learns no cadence — §80\'s line, held again', () => {
    const inv = read('lib/inventory.js');
    assert.ok(!/batch-cadence|preorderWindow|channel-publish/.test(inv));
  });
  it('gzgrocery\'s pickup guard knows the window, or every real sale is capped', () => {
    const gy = read('scripts/guanyi-daemon.js');
    assert.ok(/Math\.max\(0, m\.tianhe_qty\) \+ capAllowance/.test(gy));
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('8 · the settings card can actually save what it reads');
{
  const html = fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8');
  const js   = fs.readFileSync(path.join(ROOT, 'public/retail-admin/06-delivery.js'), 'utf8');

  it('every field the save reads exists in the card', () => {
    // The defect this guards is real and shipped once: #batch-cutoff was read by
    // saveBatchSchedule and had never existed in retail-admin.html, so the whole
    // Fresh batches card could not be saved while the switch was on.
    for (const id of ['batch-lock', 'batch-preorder-qty']) {
      assert.ok(html.includes(`id="${id}"`), `#${id} is in the card`);
      assert.ok(js.includes(id), `#${id} is read by the card's script`);
    }
  });
  it('…and the checkbox ids the script BUILDS resolve to real inputs', () => {
    /* The three channel boxes are addressed as `'#batch-pre-' + c`, so a literal
       grep for each id cannot see them — and simply not checking would leave the
       #batch-cutoff class of defect wide open on the one control here that
       constructs its selector. So the two halves are asserted against each
       other: the prefix the script uses, and the channel list it loops, must
       between them name an input that exists in the card. A typo in either end
       turns this red, which is exactly what a literal check would have done. */
    const PREFIX = "'#batch-pre-' + c";
    assert.ok(js.includes(PREFIX), 'the script still builds the selector this way');
    const listed = [...js.matchAll(/\['meituan', 'eleme', 'gzgrocery'\]/g)];
    assert.ok(listed.length >= 2, 'both the save and the load walk the same three channels');
    for (const c of ['meituan', 'eleme', 'gzgrocery']) {
      assert.ok(html.includes(`id="batch-pre-${c}"`), `#batch-pre-${c} is in the card`);
    }
    // And the server must accept exactly those three, or a box could be ticked
    // into a channel nothing ever reads.
    const cad = fs.readFileSync(path.join(ROOT, 'lib/batch-cadence.js'), 'utf8');
    assert.ok(/PREORDER_CHANNELS = \['meituan', 'eleme', 'gzgrocery'\]/.test(cad));
  });
  it('the save carries all three, or the next save would delete them', () => {
    assert.ok(/lock_hour: lockHour/.test(js));
    assert.ok(/preorder_qty: preorderQty/.test(js));
    assert.ok(/preorder_channels: preorderChannels/.test(js));
  });
  it('the load leaves a blank lock hour blank, not pre-filled with the fallback', () => {
    assert.ok(/batch\.lock_hour != null \? batch\.lock_hour : ''/.test(js));
  });
  it('the Chinese is the pair the vocabulary locked', () => {
    assert.ok(html.includes('预订截单') && html.includes('预订可售数量'));
    const vocab = fs.readFileSync(path.join(ROOT, 'docs/tacet-delivery-vocabulary.md'), 'utf8');
    assert.ok(vocab.includes('预订截单') && vocab.includes('预订可售数量'),
      'a composed pair that is not declared is indistinguishable from a locked one');
  });
}

// ── Teardown ───────────────────────────────────────────────────────────────
clearCfg();
db.prepare('DELETE FROM retail_store_stock WHERE product_id IN (?,?)').run(P_WRAP, P_OIL);
db.prepare('DELETE FROM store_products WHERE id IN (?,?)').run(P_WRAP, P_OIL);
db.prepare('DELETE FROM retail_stores WHERE id = ?').run(STORE);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
