#!/usr/bin/env node
/**
 * A delivery can be booked for a later day, and the drain waits for it.
 *
 *   node scripts/test_qingyun_future_day.js
 *
 * No network, no browser. The disposition is the real exported function; the
 * queue statements run against a real in-memory table; the endpoint and the
 * picker are sliced out of the shipped sources.
 *
 * WHY THIS EXISTS
 * ---------------
 * Asked for by Ash, 2026-09-22, after live order TC000823: the shop cancelled
 * the rider and wanted to send the order the next day, and there was no way to
 * say so anywhere in the back office.
 *
 * The reason was one boolean. `isQingyunSameCityToday` returned false both for
 * an order that is not a same-city rider job AND for one that simply is not due
 * yet, and the drain retired everything false as 'skipped'. Nothing re-queues a
 * skipped row, so a delivery booked for tomorrow was thrown out every morning,
 * on every pass, silently. The reschedule control knew this and offered only
 * today, telling the operator to build any other day by hand in the Qingyun app.
 *
 * WHAT IS LOCKED
 *   1. the three outcomes are distinguishable, and a PAST day is 'skip' rather
 *      than 'wait' — a date that has gone never becomes today, so waiting on it
 *      would wait for ever;
 *   2. isQingyunSameCityToday still answers exactly as before for every caller
 *      that asks about today — a 'wait' is false to them;
 *   3. a parked row is INVISIBLE to the drain's select until its day, which is
 *      the whole reason this is a column: the drain claims 3 rows a poll, so
 *      three waiting rows left pending would starve every live order;
 *   4. parking gives back the attempt it spent, like the geocoder hold does;
 *   5. a future date does NOT get slot kind 'today' — that kind makes the
 *      disposition push unconditionally, which would ship the order today;
 *   6. a past date is still refused by the endpoint;
 *   7. both requeue statements clear a stale hold;
 *   8. the picker offers real future days and the toast names the day it moved
 *      to, without promising a rider is on the way.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

const ROOT = path.join(__dirname, '..');
const RETAIL_JS = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const ORDERS_JS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '04-orders.js'), 'utf8');
const DAEMON_JS = fs.readFileSync(path.join(ROOT, 'scripts', 'qingyun-daemon.js'), 'utf8');
const inventory = require(path.join(ROOT, 'lib', 'inventory.js'));
const queue = require(path.join(ROOT, 'lib', 'qingyun-queue.js'));

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

// ── Part A · push, wait, or never ────────────────────────────────────────────
// 2026-09-22 12:00 Beijing, so "today" is unambiguous either side of midnight.
const NOW = new Date('2026-09-22T04:00:00Z');
const GZ_ADDR = JSON.stringify({ province: '广东省', city: '广州市', district: '天河区', detail: '高德置地冬广场G座8楼' });
const order = (over = {}) => Object.assign({ channel: 'wechat', address_json: GZ_ADDR }, over);
const disp = (over) => inventory.qingyunPushDisposition(order(over), NOW);

console.log('\nA · the disposition — three answers where there was one boolean\n');

it('a delivery promised today pushes', () => {
  assert.strictEqual(disp({ scheduled_for: '2026-09-22T02:00:00Z' }).action, 'push');
});

it('a delivery promised tomorrow WAITS, and names the day', () => {
  const d = disp({ scheduled_for: '2026-09-23T02:00:00Z' });
  assert.strictEqual(d.action, 'wait', 'tomorrow is still being retired');
  assert.strictEqual(d.until, '2026-09-23', 'the day it waits for is wrong');
});

it('a day further out waits too', () => {
  assert.strictEqual(disp({ scheduled_for: '2026-09-29T02:00:00Z' }).until, '2026-09-29');
});

it('a day that has PASSED is skip, never wait', () => {
  // The distinction that stops a row waiting for ever. That order has its own
  // surface ("Delivery date passed") and its own control.
  const d = disp({ scheduled_for: '2026-09-21T02:00:00Z' });
  assert.strictEqual(d.action, 'skip', 'a past date would be waited on for ever');
  assert.ok(/has passed/.test(d.why));
});

it('the day is read on the GUANGZHOU clock, not UTC', () => {
  // 2026-09-22 23:30 Beijing is 15:30 UTC the same day, but an order timestamped
  // 2026-09-22T17:00:00Z is already the 23rd in Guangzhou. Read as UTC it would
  // look like today and be dispatched eight hours early.
  const lateNight = new Date('2026-09-22T16:00:00Z');   // 2026-09-23 00:00 Beijing
  const d = inventory.qingyunPushDisposition(order({ scheduled_for: '2026-09-23T02:00:00Z' }), lateNight);
  assert.strictEqual(d.action, 'push', 'the promised day had arrived in Guangzhou and was still being held');
});

it('kind "today" still pushes whatever date it carries — which is why the endpoint must not use it', () => {
  // Not a bug, a documented shortcut: 'today' means the customer bought same-day.
  // It is the reason a future-dated reschedule must NOT write this kind.
  assert.strictEqual(disp({ delivery_slot_kind: 'today', scheduled_for: '2026-09-29T02:00:00Z' }).action, 'push');
});

it('the old rules are all still rules', () => {
  assert.strictEqual(inventory.qingyunPushDisposition({ channel: 'meituan', address_json: GZ_ADDR }, NOW).action, 'skip');
  assert.strictEqual(inventory.qingyunPushDisposition(
    { channel: 'wechat', address_json: JSON.stringify({ province: '北京市', city: '北京市' }) }, NOW).action, 'skip');
  assert.strictEqual(disp({ delivery_slot_kind: 'right_away' }).action, 'push');
  assert.strictEqual(disp({ delivery_slot_kind: 'express', scheduled_for: null }).action, 'push');
  assert.strictEqual(disp({ scheduled_for: null }).action, 'skip', 'an undated non-express order should not push');
});

it('isQingyunSameCityToday answers exactly as before — a wait is false to it', () => {
  // Every existing caller asks about TODAY. None of them may start seeing true
  // for an order that is not due.
  assert.strictEqual(inventory.isQingyunSameCityToday(order({ scheduled_for: '2026-09-22T02:00:00Z' }), NOW), true);
  assert.strictEqual(inventory.isQingyunSameCityToday(order({ scheduled_for: '2026-09-23T02:00:00Z' }), NOW), false);
  assert.strictEqual(inventory.isQingyunSameCityToday(order({ scheduled_for: '2026-09-21T02:00:00Z' }), NOW), false);
});

it('and it is defined in terms of the disposition, so the rules have one home', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'inventory.js'), 'utf8');
  const fn = slice(src, 'function isQingyunSameCityToday(order, now = new Date())');
  assert.ok(/qingyunPushDisposition\(order, now\)\.action === 'push'/.test(fn),
    'the two functions carry separate copies of the rules and will drift');
});

// ── Part B · the queue ───────────────────────────────────────────────────────
console.log('\nB · a parked row is invisible until its day\n');

function freshQueue(rows) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE qingyun_push_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      retail_order_id INTEGER UNIQUE, store_code TEXT, status TEXT,
      attempts INTEGER DEFAULT 0, last_error TEXT, qingyun_order_id TEXT,
      geo_held_at DATETIME, needs_point_at DATETIME,
      guessed_lat REAL, guessed_lng REAL, guessed_precision TEXT,
      candidates_json TEXT, hold_until_date TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );`);
  const ins = db.prepare(`INSERT INTO qingyun_push_queue
    (retail_order_id, store_code, status, hold_until_date, attempts, qingyun_order_id)
    VALUES (@retail_order_id, @store_code, @status, @hold_until_date, @attempts, @qingyun_order_id)`);
  for (const r of rows) ins.run(Object.assign(
    { store_code: 'tianhe', status: 'pending', hold_until_date: null, attempts: 0, qingyun_order_id: null }, r));
  return db;
}
const due = (db, today = '2026-09-22', limit = 3) =>
  db.prepare(queue.PENDING_DUE_SQL).all({ store_code: 'tianhe', today, limit });

it('an unheld row is due', () => {
  const db = freshQueue([{ retail_order_id: 1 }]);
  assert.strictEqual(due(db).length, 1);
});

it('a row held for tomorrow is NOT selected today', () => {
  const db = freshQueue([{ retail_order_id: 1, hold_until_date: '2026-09-23' }]);
  assert.strictEqual(due(db).length, 0, 'a future-dated row was handed to the drain');
});

it('…and IS selected on its day', () => {
  const db = freshQueue([{ retail_order_id: 1, hold_until_date: '2026-09-23' }]);
  assert.strictEqual(due(db, '2026-09-23').length, 1, 'the row never becomes due');
});

it('…and on any day after it, so a missed morning is not a lost order', () => {
  const db = freshQueue([{ retail_order_id: 1, hold_until_date: '2026-09-23' }]);
  assert.strictEqual(due(db, '2026-09-25').length, 1);
});

it('THREE waiting rows do not starve a live one — the reason this is a column', () => {
  // The drain claims the three oldest pending rows per poll. Left pending, three
  // future orders would hold all three slots on every poll, for ever, and no
  // live order would be dispatched again.
  const db = freshQueue([
    { retail_order_id: 1, hold_until_date: '2026-10-01' },
    { retail_order_id: 2, hold_until_date: '2026-10-02' },
    { retail_order_id: 3, hold_until_date: '2026-10-03' },
    { retail_order_id: 4 },                                  // today's order, queued last
  ]);
  const rows = due(db);
  assert.strictEqual(rows.length, 1, 'the waiting rows are still consuming slots');
  assert.strictEqual(rows[0].retail_order_id, 4, 'the live order was not the one selected');
});

it('parking sets the day, returns to pending, and gives back the attempt', () => {
  const db = freshQueue([{ retail_order_id: 1, status: 'processing', attempts: 1 }]);
  db.prepare(queue.PARK_UNTIL_SQL).run({ id: 1, until: '2026-09-23', why: 'waiting for 2026-09-23' });
  const r = db.prepare('SELECT * FROM qingyun_push_queue WHERE id = 1').get();
  assert.strictEqual(r.status, 'pending', 'a parked row is not an error state');
  assert.strictEqual(r.hold_until_date, '2026-09-23');
  assert.strictEqual(r.attempts, 0, 'waiting burned a retry — nothing was learned about this order');
  assert.ok(/waiting for 2026-09-23/.test(r.last_error), 'the drawer has nothing to print');
});

it('the attempt give-back never goes negative', () => {
  const db = freshQueue([{ retail_order_id: 1, attempts: 0 }]);
  db.prepare(queue.PARK_UNTIL_SQL).run({ id: 1, until: '2026-09-23', why: 'x' });
  assert.strictEqual(db.prepare('SELECT attempts FROM qingyun_push_queue WHERE id = 1').get().attempts, 0);
});

it('both requeue statements clear a stale hold', () => {
  for (const sql of [queue.MANUAL_RETRY_SQL, queue.REQUEUE_AFTER_CANCEL_SQL]) {
    const cancelled = sql === queue.REQUEUE_AFTER_CANCEL_SQL;
    const db = freshQueue([{ retail_order_id: 1, status: 'error', hold_until_date: '2026-10-01',
                             qingyun_order_id: cancelled ? 'QY1' : null }]);
    const n = cancelled ? db.prepare(sql).run(1, 'QY1').changes : db.prepare(sql).run(1).changes;
    assert.strictEqual(n, 1, 'the statement did not fire');
    assert.strictEqual(db.prepare('SELECT hold_until_date FROM qingyun_push_queue WHERE id = 1').get().hold_until_date,
      null, 'a requeued row stayed parked on the day it left');
  }
});

// ── Part C · the drain ───────────────────────────────────────────────────────
console.log('\nC · the drain waits instead of retiring\n');

const DRAIN = slice(DAEMON_JS, 'async function drainPushQueue(storeCode, br)');

it('it selects only DUE rows, on the Guangzhou day', () => {
  assert.ok(/qingyunQueue\.PENDING_DUE_SQL/.test(DRAIN), 'the drain still has its own inline select');
  assert.ok(/today: inventory\.gzDateStr\(/.test(DRAIN),
    "the drain passes something other than the Guangzhou day, so a future order can go out early");
});

it('a wait parks the row; only a non-push that is not a wait is retired', () => {
  assert.ok(/disp\.action === 'wait'/.test(DRAIN), 'the drain cannot tell a wait from a skip');
  assert.ok(/PARK_UNTIL_SQL/.test(DRAIN), 'a waiting row is not parked');
  assert.ok(/status='skipped'/.test(DRAIN), 'the skip path was lost — a bad order would now be pushed');
  const parkAt = DRAIN.indexOf("disp.action === 'wait'");
  const skipAt = DRAIN.indexOf("disp.action !== 'push'");
  assert.ok(parkAt > 0 && skipAt > parkAt, 'the skip branch runs before the wait branch, so nothing ever waits');
});

// ── Part D · the endpoint ────────────────────────────────────────────────────
console.log('\nD · the endpoint takes a later day, and words it right\n');

const ENDPOINT = slice(RETAIL_JS, "router.post('/api/retail-admin/orders/:id/qingyun/reschedule'");

it('the today-only refusal is gone', () => {
  assert.ok(!/today_only/.test(ENDPOINT), 'a later day is still refused');
});

it('a PAST day is still refused', () => {
  assert.ok(/if \(date < today\)/.test(ENDPOINT), 'a past date would be accepted and parked for ever');
  assert.ok(/date_passed/.test(ENDPOINT), 'the refusal has no name the client can read');
});

it('a future day does NOT get slot kind "today"', () => {
  // Part A proves that kind pushes unconditionally. Writing it here would
  // dispatch the order today whatever date the operator picked.
  assert.ok(/const kind = date === today \? 'today' : null;/.test(ENDPOINT),
    'the slot kind is not conditioned on the date — a future booking would ship today');
});

// ── Part E · what the operator sees ──────────────────────────────────────────
console.log('\nE · the picker and the toast\n');

const PICKER = slice(ORDERS_JS, 'function qpDayOptions()');
const OPEN   = slice(ORDERS_JS, 'function qpOpenReschedule(orderId, btn)');
const DO     = slice(ORDERS_JS, 'async function qpDoReschedule(orderId, iso, btn)');
const DISPATCH = slice(ORDERS_JS, 'function renderQyDispatch(o)');

it('the picker offers a week of days, not just today', () => {
  assert.ok(/QP_DAYS_AHEAD/.test(PICKER), 'the picker has no horizon');
  assert.ok(/qpDayOptions\(\)\.map/.test(OPEN), 'the picker still renders a single hardcoded day');
  assert.ok(!/Only today can go back in the queue/.test(ORDERS_JS),
    'the today-only copy is still on screen');
});

it('the days are distinct and consecutive Beijing days', () => {
  const vm = require('vm');
  const ctx = { cuT: (en) => en, Date, QP_DAYS_AHEAD: 7 };
  vm.createContext(ctx);
  new vm.Script(`${PICKER}\n_out = qpDayOptions();`).runInContext(ctx);
  const days = ctx._out.map(d => d.iso);
  assert.strictEqual(days.length, 7);
  assert.strictEqual(new Set(days).size, 7, 'a day appeared twice');
  for (let i = 1; i < days.length; i++) {
    const gap = (Date.parse(days[i]) - Date.parse(days[i - 1])) / 86400000;
    assert.strictEqual(gap, 1, `days ${days[i - 1]} → ${days[i]} are not consecutive`);
  }
  assert.strictEqual(ctx._out[0].rel, 'today');
  assert.strictEqual(ctx._out[1].rel, 'tomorrow');
});

it('a future move does not claim a rider is queued', () => {
  assert.ok(/the rider is called that morning/.test(DO), 'the future wording is missing');
  assert.ok(/已改期至 \$\{iso\} — 当天呼叫骑手/.test(DO), 'its Chinese is missing');
  // Today keeps its own, truer sentence.
  assert.ok(/Moved to today — it goes back in the queue now/.test(DO), 'the today wording was lost');
});

it('the partial outcome names the day too', () => {
  assert.ok(/Moved to \$\{when\}, but it was not re-queued/.test(DO),
    'the partial toast still hardcodes "today"');
});

it('a live order can reach the control from the courier block', () => {
  assert.ok(/Change delivery day/.test(DISPATCH), 'there is still no control on a live order');
  assert.ok(/更改配送日期/.test(DISPATCH), 'it has no Chinese');
  assert.ok(/qpOpenReschedule\(\$\{o\.id\}/.test(DISPATCH), 'the button opens nothing');
});

it('…but not while a rider is carrying it, and not on a closed order', () => {
  assert.ok(/heldByRider = !stale && !!\(c && \['heading_to_pickup', 'in_transit'\]/.test(DISPATCH),
    'a rider on the road can be re-dated from the drawer');
  assert.ok(/'delivered', 'cancelled', 'refunded'/.test(DISPATCH), 'a closed order still offers a day change');
});

it('…and a STALE job is NOT held, which is the case that matters most', () => {
  // TC000823, the day this shipped: the rider had been cancelled, the card was
  // frozen on "Rider coming" with the amber "may have cancelled" warning beside
  // it, and this guard read the frozen stage as a rider on the road — hiding the
  // control on the one order that needed it, while the same screen said the
  // rider was probably gone. `stale` is the drawer's own freeze test, so the
  // button now appears exactly when the card admits something is wrong.
  assert.ok(/const heldByRider = !stale &&/.test(DISPATCH),
    'a frozen "Rider coming" still hides the day change');
  // Order of declaration matters: `stale` must be computed before it is read.
  assert.ok(DISPATCH.indexOf('const stale =') < DISPATCH.indexOf('const heldByRider ='),
    'heldByRider reads stale before it is assigned, so it is always undefined');
});

it('…and never alongside the expired surface, which has its own', () => {
  // Both emit qp-resched-<id>; two of them and getElementById takes the first,
  // so the visible button would write into the hidden box.
  assert.ok(/date_posture === 'passed'/.test(DISPATCH), 'the duplicate-id guard is gone');
  assert.ok(/!expired/.test(DISPATCH), 'the guard is computed but not applied');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
