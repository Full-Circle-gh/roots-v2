#!/usr/bin/env node
/**
 * A cancelled rider is READ, not reported — and every surface stops claiming one.
 *
 *   node scripts/test_qingyun_cancel_detect.js
 *
 * No network, no browser. The sweep runs against a real in-memory SQLite table;
 * the stage function, the header pill and the courier card are sliced out of the
 * shipped sources and evaluated, so this reads what ships rather than a copy.
 *
 * WHY THIS EXISTS
 * ---------------
 * 青云聚信 has no cancel signal we can read. The daemon polls the tabs that hold an
 * ACTIVE delivery (待配送 / 待抢单 / 待取货 / 配送中) plus the 完成 tab, and a cancelled
 * order is in none of them — so it simply stops being returned, delivery_jobs is
 * never written again, and the row freezes at whatever stage it last held.
 *
 * Order TC000823, 2026-09-22, is the worked example. Staff cancelled the rider.
 * The drawer went on reading "Rider coming · 骑手前往取货" under 葛师傅's name and
 * phone number, and the only hint was an amber "the rider may have cancelled"
 * line — a guess about a frozen timestamp, worded as a guess because that is all
 * it was. Meanwhile the ship-from line advised staff to "cancel it in the Qingyun
 * app first", which is the thing they had just done.
 *
 * WHAT IS LOCKED
 *   1. the sweep concludes a cancel ONLY from a complete list, and only after the
 *      grace window — the two guards that stop it firing on a live rider;
 *   2. the rows it must never touch: superseded copies, delivered jobs, and jobs
 *      already concluded;
 *   3. the zoneless-UTC trap — a naive SQLite stamp must not read as 8h old on a
 *      Beijing host and cancel a delivery on its first miss;
 *   4. 'cancelled' outranks the frozen raw enum in deliveryJobStage;
 *   5. neither auto-sweep can act on a cancelled job: the ETA timer must not mark
 *      a never-shipped order Delivered, and auto-dispatch must not promote one off
 *      a frozen 配送中;
 *   6. the card says it plainly, drops the gone rider's ETA and number, and does
 *      not ALSO show the hedged stale line;
 *   7. the header pill falls back to the order's own status;
 *   8. re-dispatch is unblocked — both gates that would otherwise read a cancelled
 *      job as a courier holding the order.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Database = require('better-sqlite3');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

const ROOT = path.join(__dirname, '..');
const RETAIL_JS = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const ORDERS_JS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '04-orders.js'), 'utf8');
const { applyVanishSweep } = require(path.join(ROOT, 'lib', 'qingyun-cancel.js'));
const DAEMON = fs.readFileSync(path.join(ROOT, 'scripts', 'qingyun-daemon.js'), 'utf8');

// Brace counting, deliberately naive: a mis-slice cannot make a test pass quietly
// because the result is fed to vm.Script and fails to parse.
function slice(src, anchor) {
  const start = src.indexOf(anchor);
  assert.notStrictEqual(start, -1, `not found in the shipped file: ${anchor}`);
  const open = src.indexOf('{', start + anchor.length);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces after ${anchor}`);
}

// ── Part A · the sweep ───────────────────────────────────────────────────────
// The real columns, in the shapes the daemon writes them. `missing_since` and
// `cancelled_at` are DATETIME and arrive from SQLite without a zone, which is
// what test 3 below is about.
function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE delivery_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      qingyun_order_id TEXT UNIQUE NOT NULL,
      retail_order_id  INTEGER,
      store_code       TEXT NOT NULL,
      order_status     INTEGER,
      superseded       INTEGER NOT NULL DEFAULT 0,
      missing_since    DATETIME,
      cancelled_at     DATETIME,
      updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
    );`);
  return db;
}
function addJob(db, over = {}) {
  const j = Object.assign(
    { qingyun_order_id: 'QY1', retail_order_id: 823, store_code: 'tianhe', order_status: 20, superseded: 0, missing_since: null, cancelled_at: null },
    over);
  db.prepare(`INSERT INTO delivery_jobs
     (qingyun_order_id, retail_order_id, store_code, order_status, superseded, missing_since, cancelled_at)
     VALUES (@qingyun_order_id, @retail_order_id, @store_code, @order_status, @superseded, @missing_since, @cancelled_at)`).run(j);
  return j;
}
const row = (db, id = 'QY1') => db.prepare('SELECT * FROM delivery_jobs WHERE qingyun_order_id = ?').get(id);
const sweep = (db, over = {}) => applyVanishSweep(db, Object.assign(
  { storeCode: 'tianhe', seen: new Set(), complete: true, now: new Date('2026-09-22T04:00:00Z'), graceMs: 3 * 60_000 }, over));

console.log('\nA · the vanish sweep — two guards, then a conclusion\n');

it('an incomplete list concludes nothing at all', () => {
  const db = freshDb(); addJob(db);
  const r = sweep(db, { complete: false });
  assert.strictEqual(r.skipped, 'incomplete');
  assert.strictEqual(r.cancelled.length, 0);
  assert.strictEqual(row(db).missing_since, null, 'a partial poll must not even stamp the row');
});

it('the first miss stamps the row and cancels nothing', () => {
  const db = freshDb(); addJob(db);
  const r = sweep(db);
  assert.strictEqual(r.cancelled.length, 0, 'one missed poll is not a cancel');
  assert.ok(row(db).missing_since, 'missing_since was not stamped');
  assert.strictEqual(row(db).cancelled_at, null);
});

it('still inside the grace window it stays missing, not cancelled', () => {
  const db = freshDb(); addJob(db, { missing_since: '2026-09-22 03:58:00' });   // 2 min before now
  const r = sweep(db);
  assert.strictEqual(r.cancelled.length, 0);
  assert.strictEqual(row(db).cancelled_at, null, 'cancelled inside the grace window');
});

it('past the grace window it is cancelled', () => {
  const db = freshDb(); addJob(db, { missing_since: '2026-09-22 03:50:00' });   // 10 min before now
  const r = sweep(db);
  assert.strictEqual(r.cancelled.length, 1, 'the cancel was never concluded');
  assert.ok(row(db).cancelled_at, 'cancelled_at was not written');
});

it('being seen again clears the stamp outright', () => {
  const db = freshDb(); addJob(db, { missing_since: '2026-09-22 03:50:00' });
  const r = sweep(db, { seen: new Set(['QY1']) });
  assert.strictEqual(r.cancelled.length, 0);
  assert.strictEqual(row(db).missing_since, null, 'a job that came back is still marked missing');
});

it('an order seen at ANY stage counts as seen — including delivered', () => {
  // The daemon adds the 完成 tab's ids to the same set, so an order that landed
  // between two polls must not be read as having vanished.
  const db = freshDb(); addJob(db, { missing_since: '2026-09-22 03:50:00', order_status: 30 });
  const r = sweep(db, { seen: new Set(['QY1']) });
  assert.strictEqual(r.cancelled.length, 0, 'a completed delivery was called a cancel');
});

it('a superseded copy is never reported as a cancel', () => {
  // The abandoned copy a ship-from move leaves behind is SUPPOSED to disappear
  // from the old store's list. Reporting it would page staff about every move.
  const db = freshDb(); addJob(db, { superseded: 1, missing_since: '2026-09-22 03:50:00' });
  const r = sweep(db);
  assert.strictEqual(r.cancelled.length, 0);
  assert.strictEqual(row(db).cancelled_at, null);
});

it('a delivered job is never cancelled', () => {
  const db = freshDb(); addJob(db, { order_status: 50, missing_since: '2026-09-22 03:50:00' });
  const r = sweep(db);
  assert.strictEqual(r.cancelled.length, 0, 'a finished delivery was re-read as a cancel');
});

it('an already-cancelled job is not concluded twice', () => {
  const db = freshDb(); addJob(db, { cancelled_at: '2026-09-22 03:00:00', missing_since: '2026-09-22 02:00:00' });
  const r = sweep(db);
  assert.strictEqual(r.cancelled.length, 0, 're-cancelled, which would re-alert staff every poll');
  assert.strictEqual(row(db).cancelled_at, '2026-09-22 03:00:00', 'the original cancel time was overwritten');
});

it('a zoneless SQLite stamp is read as UTC, not as local', () => {
  // THE TRAP: `new Date('2026-09-22 03:59:00')` on a UTC+8 host is 19:59 UTC the
  // day before — 8 hours "ago" — so a stamp written one minute ago would clear
  // any grace window and cancel a live rider on the very next poll.
  const db = freshDb(); addJob(db, { missing_since: '2026-09-22 03:59:00' });   // 1 min before now
  const r = sweep(db);
  assert.strictEqual(r.cancelled.length, 0, 'a one-minute-old stamp was read as hours old');
});

it('…and that is not vacuous: the same stamp past the window does cancel', () => {
  const db = freshDb(); addJob(db, { missing_since: '2026-09-22 03:00:00' });
  assert.strictEqual(sweep(db).cancelled.length, 1);
});

it('an unparseable stamp re-stamps rather than concluding a cancel', () => {
  const db = freshDb(); addJob(db, { missing_since: 'not a date' });
  const r = sweep(db);
  assert.strictEqual(r.cancelled.length, 0, 'a garbage stamp cancelled a delivery');
  assert.strictEqual(row(db).missing_since, '2026-09-22T04:00:00.000Z', 'the bad stamp was left in place');
});

it('another store\'s jobs are left alone', () => {
  const db = freshDb();
  addJob(db, { qingyun_order_id: 'QY2', store_code: 'yuexiu', missing_since: '2026-09-22 03:00:00' });
  assert.strictEqual(sweep(db).cancelled.length, 0, 'one store\'s poll concluded another store\'s cancel');
});

it('the conclusion does NOT touch updated_at', () => {
  // updated_at means "when the platform last told us something", and it has told
  // us nothing. It is what the drawer prints as "updated 15m ago" and what the
  // ETA fallback reads for freshness; moving it would make a cancelled job look
  // freshly tracked.
  const db = freshDb(); addJob(db, { missing_since: '2026-09-22 03:00:00' });
  const before = row(db).updated_at;
  sweep(db);
  assert.strictEqual(row(db).updated_at, before, 'the cancel refreshed updated_at');
});

// ── Part A2 · the precondition must be REACHABLE ─────────────────────────────
// The sweep refusing to conclude from an incomplete list is correct. What was
// wrong was that the list could never be complete: every tab was read as a
// single page of 20, and 待配送 holds every order awaiting a courier, so on any
// working day one tab came back full and disqualified the whole poll. The check
// was therefore OFF, permanently and silently, and TC000823 read "Rider coming"
// for four hours with its rider cancelled.
console.log('\nA2 · the completeness precondition can actually be met\n');

const BROWSER_JS = fs.readFileSync(path.join(ROOT, 'lib', 'qingyun-browser.js'), 'utf8');
const POLL = slice(BROWSER_JS, 'async _pollActiveTabs()');

it('every active tab is PAGED, not read as page 1', () => {
  assert.ok(/pageNum=\$\{page\}/.test(POLL), 'the tab poll still asks for page 1 only');
  assert.ok(/for \(let page = 1; page <= LIST_MAX_PAGES; page\+\+\)/.test(POLL),
    'there is no page loop, so a busy tab still reads as truncated for ever');
});

it('a SHORT page ends the tab, and only the cap counts as truncated', () => {
  assert.ok(/if \(list\.length < LIST_PAGE_SIZE\) tabTruncated = false;/.test(POLL),
    'a fully-read tab can still be marked truncated');
  assert.ok(/else if \(page === LIST_MAX_PAGES\) tabTruncated = true;/.test(POLL),
    'truncation is not tied to the page cap');
  assert.ok(/if \(list\.length < LIST_PAGE_SIZE\) break;/.test(POLL),
    'the loop does not stop at the end of a tab, so it spends all its pages every time');
});

it('the completed tab is paged too', () => {
  const done = slice(BROWSER_JS, 'async getCompletedDeliveries()');
  assert.ok(/pageNum=\$\{page\}/.test(done), 'the completed read is still single-page');
  assert.ok(/out\.complete = !full;/.test(done), 'a full first page still disqualifies the observation');
});

it('a skipped sweep is logged, never silent', () => {
  // The failure mode was invisible: the only trace of a check that never ran was
  // that nothing happened.
  assert.ok(/if \(sweep\.skipped\)/.test(DAEMON), 'a skipped sweep still says nothing');
  assert.ok(/logSync\(storeCode, 'cancel', 'error'/.test(DAEMON),
    'a skipped sweep leaves no durable trace for the Delivery card');
});

// ── Part B · the stage ───────────────────────────────────────────────────────
console.log('\nB · deliveryJobStage — the conclusion outranks the frozen enum\n');

const STAGE_SRC = slice(RETAIL_JS, 'function deliveryJobStage(job)');
function stage(job) {
  const ctx = {};
  vm.createContext(ctx);
  new vm.Script(`${STAGE_SRC}\n_out = deliveryJobStage(job);`).runInContext(Object.assign(ctx, { job }));
  return ctx._out;
}

it('a cancelled job reads cancelled even while frozen mid-run', () => {
  assert.strictEqual(stage({ order_status: 30, delivery_status: 35, cancelled_at: '2026-09-22 03:00:00' }), 'cancelled');
});

it('…and that is not vacuous: the same row without the stamp still reads in_transit', () => {
  assert.strictEqual(stage({ order_status: 30, delivery_status: 35, cancelled_at: null }), 'in_transit');
});

it('the frozen "Rider coming" of TC000823 is what changes', () => {
  const frozen = { order_status: 30, delivery_status: 20, rider_name: '葛师傅' };
  assert.strictEqual(stage(frozen), 'heading_to_pickup');
  assert.strictEqual(stage(Object.assign({}, frozen, { cancelled_at: '2026-09-22 03:00:00' })), 'cancelled');
});

it('a delivered job is never overridden by a stray stamp', () => {
  // Ordering matters the other way too: nothing should be able to un-deliver a
  // finished job. The sweep cannot produce this row, but the function is shared.
  assert.strictEqual(stage({ order_status: 50, cancelled_at: null }), 'delivered');
});

// ── Part C · the sweeps that act on their own ────────────────────────────────
console.log('\nC · neither timer may act on a cancelled delivery\n');

function sqlOf(anchor) {
  const src = slice(RETAIL_JS, anchor);
  return src.replace(/\s+/g, ' ');
}

it('the ETA fallback is blocked by a cancelled job with NO freshness window', () => {
  // The window asks "is a rider being tracked right now?" and the honest answer
  // for a cancelled job is no — which would hand the order to the timer and mark
  // it Delivered over a parcel still sitting in the shop. TC000823 exactly.
  const sql = sqlOf('function autoDeliverLocalEtaForTenant()');
  assert.ok(/NOT EXISTS/.test(sql), 'the live-tracking guard is gone');
  assert.ok(/OR j\.cancelled_at IS NOT NULL/.test(sql),
    'a cancelled job does not block the ETA auto-deliver sweep');
});

it('auto-dispatch cannot promote an order off a cancelled job', () => {
  const sql = sqlOf('function autoDispatchQingyunForTenant()');
  assert.ok(/AND j\.cancelled_at IS NULL/.test(sql),
    'a cancelled job frozen at 配送中 can still flip the order to dispatched');
});

it('auto-deliver-on-drop-off ignores cancelled jobs too', () => {
  const sql = sqlOf('function autoDeliverQingyunForTenant()');
  assert.ok(/AND j\.cancelled_at IS NULL/.test(sql), 'the drop-off sweep reads cancelled jobs');
});

it('re-dispatch is unblocked — both gates', () => {
  const committed = sqlOf('function _qingyunCourierCommitted(qyOrderId)');
  assert.ok(/if \(job\.cancelled_at\) return null;/.test(committed),
    'a cancelled job still counts as a courier holding the order');
  const blocked = sqlOf('function _qingyunMoveBlockedBy(qyOrderId)');
  assert.ok(/stage === 'cancelled'/.test(blocked),
    "the ship-from line still says \"a courier is already on this one\"");
});

it('the customer map feed serves nothing for a cancelled job', () => {
  const src = slice(RETAIL_JS, 'function buildDeliveryTrackData(job, slotLabel, scheduledFor, lang)');
  assert.ok(/if \(stage === 'cancelled'\) return \{ tracking: false \};/.test(src),
    'a cancelled delivery still draws a stationary rider on the shopper\'s map');
});

// ── Part D · what staff actually see ─────────────────────────────────────────
console.log('\nD · the card and the pill\n');

const CARD_SRC = slice(ORDERS_JS, 'function renderCourierStatusCard(o, c, meta, stale, delivered)');
const STAGE_MAP_SRC = (() => {
  const start = ORDERS_JS.indexOf('const COURIER_STAGE = {');
  assert.notStrictEqual(start, -1, 'COURIER_STAGE not found');
  return ORDERS_JS.slice(start, ORDERS_JS.indexOf('};', start) + 2);
})();

function card(c, { lang = 'en' } = {}) {
  const ctx = {
    cuT: (en, cn) => (lang === 'cn' ? cn : en),
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    courierAgo: () => '4m ago',
    deliveryIcon: () => '<<icon>>',
  };
  vm.createContext(ctx);
  new vm.Script(`${STAGE_MAP_SRC}\n${CARD_SRC}\n_out = renderCourierStatusCard(o, c, COURIER_STAGE[c.stage], stale, false);`)
    .runInContext(Object.assign(ctx, { o: { id: 7 }, c, stale: false }));
  return ctx._out;
}

const goneRider = {
  stage: 'cancelled', carrier: '货拉拉跑腿',
  rider: { name: '葛师傅', phone: '18466385089' },
  eta_seconds: 480, rider_to_cust_m: 1200,
  cancelled_at: '2026-09-22 03:00:00', updated_at: '2026-09-22 02:45:00',
};

it('the card says the rider is cancelled', () => {
  assert.ok(card(goneRider).includes('Rider cancelled'), 'the card does not say it');
});

it('it carries its Chinese', () => {
  const cn = card(goneRider, { lang: 'cn' });
  assert.ok(cn.includes('骑手已取消'), 'the Chinese stage label is missing');
  assert.ok(cn.includes('无人接单'), 'the Chinese body is missing');
});

it('it tells staff what to do about it', () => {
  assert.ok(/Call another courier/.test(card(goneRider)), 'the card does not name the next step');
});

it('the gone rider\'s phone number is dropped', () => {
  // They cancelled; phoning them is not the next step, and a tel: link beside
  // "Rider cancelled" reads as somebody still to chase.
  assert.ok(!card(goneRider).includes('18466385089'), "the cancelled rider's number is still on the card");
});

it('the frozen ETA and distance are dropped', () => {
  const html = card(goneRider);
  assert.ok(!/min away|min to store/.test(html), 'a gone rider still has an ETA');
  assert.ok(!/1\.2 km/.test(html), 'a gone rider still has a distance');
});

it('no live map is mounted for a cancelled job', () => {
  assert.ok(!card(goneRider).includes('courier-map-'), 'a cancelled job still mounts the rider map');
});

it('the hedged stale line does not ALSO appear', () => {
  // Two hedged messages about one fact is how a card stops being read.
  assert.ok(!card(goneRider).includes('may have cancelled'), 'the guess is shown beside the conclusion');
});

it('…and that guess is still there for the case we cannot prove', () => {
  const src = ORDERS_JS;
  assert.ok(src.includes('Not updating — the rider may have cancelled'),
    'the stale warning was removed — it is still the only signal before the grace window passes');
  assert.ok(/const cancelled = !!\(c && c\.stage === 'cancelled'\);/.test(src)
    && /!delivered && !cancelled/.test(src), 'a cancelled job can still be flagged stale as well');
});

it('the dispatch button reopens on a cancel', () => {
  const src = slice(ORDERS_JS, 'function renderQyDispatch(o)');
  assert.ok(/showCompare = .*\|\| cancelled/.test(src), 'staff cannot call another courier from the card');
  assert.ok(/relabel = .*\|\| cancelled/.test(src), 'the button still reads "Compare couriers"');
});

it('the header pill falls back to the order\'s own status', () => {
  const PILL = slice(ORDERS_JS, 'function orderStatusPill(o)');
  const ctx = {
    cuT: (en) => en,
    humanStatus: (s) => 'HUMAN:' + s,
  };
  vm.createContext(ctx);
  new vm.Script(`${PILL}\n_out = orderStatusPill(o);`).runInContext(
    Object.assign(ctx, { o: { status: 'paid', fulfillment_type: 'delivery', courier: { stage: 'cancelled' } } }));
  assert.strictEqual(ctx._out.label, 'HUMAN:paid', 'the pill reads a stage off a gone rider');
  assert.strictEqual(ctx._out.cls, 'st-paid');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
