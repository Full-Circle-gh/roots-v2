#!/usr/bin/env node
/**
 * The reschedule button says what it actually did.
 *
 *   node scripts/test_qingyun_reschedule_truth.js
 *
 * No network, no browser. The endpoint's decision is read out of the shipped
 * source; the queue statements run against a real in-memory SQLite table.
 *
 * WHY THIS EXISTS
 * ---------------
 * `POST /api/retail-admin/orders/:id/qingyun/reschedule` returned early on ANY
 * qingyun_order_id:
 *
 *     if (q.qingyun_order_id) return res.json({ success: true, already_created: true });
 *
 * — before the date write, before the queue write. The client checked only
 * `j.success` and printed "Moved to today — it goes back in the queue now".
 *
 * So on live order TC000823 (2026-09-22), whose rider staff had cancelled: the
 * drawer showed "Delivery date passed", the operator pressed Reschedule, the
 * toast said it had been moved and re-queued, and NOTHING had happened. No date,
 * no queue row, no rider. The order would have sat there unsent with a green
 * message behind it — the silent no-op with a caption on it that this whole
 * surface was built to remove, reappearing one branch further in.
 *
 * WHAT IS LOCKED
 *   1. a LIVE courier copy still stops the endpoint — a rider on the road is not
 *      re-queued and the customer is not told a new day;
 *   2. a CANCELLED copy goes through, and takes a statement whose guard is a real
 *      compare-and-swap rather than none;
 *   3. the response can no longer be read as a move when it was not one;
 *   4. all three outcomes have their own sentence on screen, and the success one
 *      is reachable only when the queue actually took it;
 *   5. the ordinary manual-retry guard is untouched — this must not become a way
 *      to double-dispatch an order that has a live copy.
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

const ENDPOINT = slice(RETAIL_JS, "router.post('/api/retail-admin/orders/:id/qingyun/reschedule'");

// ── Part A · the endpoint's decision ─────────────────────────────────────────
console.log('\nA · which copies stop the endpoint, and which go through\n');

it('a live courier copy still stops it', () => {
  assert.ok(/if \(!job \|\| !job\.cancelled_at\)/.test(ENDPOINT),
    'the live-copy branch is gone — a rider on the road could be re-queued under a new date');
  assert.ok(/already_created: true/.test(ENDPOINT), 'the live-copy outcome lost its name');
});

it('the live-copy answer can no longer be read as a move', () => {
  // The whole defect: the client read `success` and called it a move.
  const live = ENDPOINT.slice(ENDPOINT.indexOf('already_created: true'));
  assert.ok(/requeued: false/.test(live.slice(0, 200)), 'the live-copy response does not say it re-queued nothing');
  assert.ok(/moved: false/.test(live.slice(0, 200)), 'the live-copy response does not say the date did not move');
});

it('a cancelled copy is recognised and carried to the write', () => {
  assert.ok(/cancelledCopy = String\(q\.qingyun_order_id\)/.test(ENDPOINT),
    'a cancelled copy is not carried past the branch');
  assert.ok(/REQUEUE_AFTER_CANCEL_SQL\)\.run\(id, cancelledCopy\)/.test(ENDPOINT),
    'the cancelled path does not take the compare-and-swap statement');
});

it('it reads the daemon\'s conclusion, never its own', () => {
  // Whether a delivery is cancelled is settled in one place, under two guards.
  assert.ok(/SELECT cancelled_at FROM delivery_jobs WHERE qingyun_order_id = \?/.test(ENDPOINT),
    'the endpoint decides cancelledness for itself instead of reading delivery_jobs');
});

it('a pre-migration tenant is treated as having a live copy', () => {
  // Failing safe: with no cancelled_at column we cannot know, and the costly
  // mistake is re-dispatching over a rider who is actually on the road.
  assert.ok(/catch \(_\) \{ job = null; \}/.test(ENDPOINT), 'the pre-migration fallback is gone');
});

it('the success response reports both halves separately', () => {
  assert.ok(/res\.json\(\{ success: true, moved: true, requeued, after_cancel/.test(ENDPOINT),
    'the response still collapses the date write and the queue write into one word');
});

it('a day that has GONE is still refused', () => {
  // This started as "the today-only refusal is untouched", and it was right for
  // as long as nothing could hold a future-dated row: a later day was accepted,
  // parked, and retired by the drain the next morning with no trace.
  //
  // Since the drain learned to wait (lib/inventory qingyunPushDisposition) a
  // later day is real and is accepted. What survives, and is the part worth
  // pinning, is the refusal of a day that has already passed — a past date never
  // becomes today, so a row parked on one would wait for ever.
  assert.ok(/if \(date < today\)/.test(ENDPOINT), 'a past date is no longer refused');
  assert.ok(/date_passed/.test(ENDPOINT), 'the refusal has no name the client can read');
  assert.ok(!/today_only/.test(ENDPOINT), 'a later day is still being refused');
});

// ── Part B · the statements ──────────────────────────────────────────────────
console.log('\nB · the queue statements, run for real\n');

function freshQueue(over = {}) {
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
  const r = Object.assign({ retail_order_id: 823, store_code: 'tianhe', status: 'done', qingyun_order_id: 'QY1' }, over);
  db.prepare(`INSERT INTO qingyun_push_queue (retail_order_id, store_code, status, qingyun_order_id)
              VALUES (@retail_order_id, @store_code, @status, @qingyun_order_id)`).run(r);
  return db;
}
const qrow = (db) => db.prepare('SELECT * FROM qingyun_push_queue WHERE retail_order_id = 823').get();

it('the cancelled requeue puts the row back and clears the dead id', () => {
  const db = freshQueue();
  const n = db.prepare(queue.REQUEUE_AFTER_CANCEL_SQL).run(823, 'QY1').changes;
  assert.strictEqual(n, 1, 'the row was not re-queued');
  assert.strictEqual(qrow(db).status, 'pending');
  assert.strictEqual(qrow(db).qingyun_order_id, null, 'the cancelled delivery id was left on the row');
  assert.strictEqual(qrow(db).attempts, 0, 'the attempt count was not reset');
});

it('it is a real compare-and-swap: a DIFFERENT id changes nothing', () => {
  // The daemon created a new delivery between the read and the write. Re-queueing
  // then would abandon a live rider and pay for a second one.
  const db = freshQueue({ qingyun_order_id: 'QY2' });
  const n = db.prepare(queue.REQUEUE_AFTER_CANCEL_SQL).run(823, 'QY1').changes;
  assert.strictEqual(n, 0, 'the swap fired against an id it had not verified');
  assert.strictEqual(qrow(db).status, 'done', 'the row was reset anyway');
  assert.strictEqual(qrow(db).qingyun_order_id, 'QY2', 'a live delivery id was cleared');
});

it('it clears the parked fields with the status, like its siblings', () => {
  const db = freshQueue({ status: 'error' });
  db.prepare(`UPDATE qingyun_push_queue SET geo_held_at = '2026-09-22 01:00:00',
              needs_point_at = '2026-09-22 01:00:00', guessed_lat = 23.1, guessed_lng = 113.3,
              guessed_precision = 'coarse', candidates_json = '[]' WHERE retail_order_id = 823`).run();
  db.prepare(queue.REQUEUE_AFTER_CANCEL_SQL).run(823, 'QY1');
  const r = qrow(db);
  for (const f of ['geo_held_at', 'needs_point_at', 'guessed_lat', 'guessed_lng', 'guessed_precision', 'candidates_json']) {
    assert.strictEqual(r[f], null, `${f} was left describing the state we just left`);
  }
});

it('the ORDINARY manual retry still refuses a row that has a copy', () => {
  // The guard this change routes around must still hold on its own path, or a
  // plain Retry becomes a way to pay for a second rider.
  const db = freshQueue({ status: 'error', qingyun_order_id: 'QY1' });
  const n = db.prepare(queue.MANUAL_RETRY_SQL).run(823).changes;
  assert.strictEqual(n, 0, 'manual retry now fires over an existing Qingyun copy');
});

it('…and still works on a row with no copy', () => {
  const db = freshQueue({ status: 'error', qingyun_order_id: null });
  assert.strictEqual(db.prepare(queue.MANUAL_RETRY_SQL).run(823).changes, 1);
});

// ── Part C · what the operator reads ─────────────────────────────────────────
console.log('\nC · three outcomes, three sentences\n');

const CLIENT = slice(ORDERS_JS, 'async function qpDoReschedule(orderId, iso, btn)');

it('the success toast is reachable only when the queue actually took it', () => {
  assert.ok(/if \(j\.already_created\)/.test(CLIENT), 'the client does not check for a live copy');
  assert.ok(/\} else if \(j\.requeued\) \{[\s\S]*?Moved to today — it goes back in the queue now/.test(CLIENT),
    'the success wording is not gated on requeued');
});

it('a live copy gets its own sentence, in both languages', () => {
  assert.ok(/A courier is already on this one — cancel it in the Qingyun app first/.test(CLIENT),
    'the live-copy sentence is missing');
  assert.ok(/已呼叫运力。请先在青云 App 取消该单。/.test(CLIENT), 'its Chinese is missing');
});

it('a date that moved without a requeue says BOTH halves', () => {
  // The customer HAS been told the new day, so this is not a no-op to retry
  // blindly; and no rider is queued, which is the part still owed.
  //
  // The day is a VARIABLE here, not the word "today": since the picker learned to
  // offer later days, this toast has to name the one that was chosen. The frame
  // and its Chinese are otherwise the ones this suite first pinned.
  assert.ok(/Moved to \$\{when\}, but it was not re-queued — check the courier/.test(CLIENT),
    'the partial outcome has no sentence');
  assert.ok(/已改期至\$\{whenCn\},但未重新排队 — 请核实运力。/.test(CLIENT), 'its Chinese is missing');
});

it('none of the three is vacuous — they are three different strings', () => {
  const said = ['Moved to today — it goes back in the queue now',
                'A courier is already on this one — cancel it in the Qingyun app first',
                'Moved to ${when}, but it was not re-queued — check the courier'];
  assert.strictEqual(new Set(said).size, 3);
  for (const t of said) assert.ok(CLIENT.includes(t), `missing: ${t}`);
});

it('only the success one is styled as a success', () => {
  const ok = CLIENT.indexOf("'success'");
  assert.ok(ok > 0, 'no success toast at all');
  assert.strictEqual((CLIENT.match(/'success'\)/g) || []).length, 1,
    'more than one outcome is styled as a success');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
