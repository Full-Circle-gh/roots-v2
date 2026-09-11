#!/usr/bin/env node
// THE FAPIAO REMINDER COMES BACK UNTIL THE FAPIAO IS ISSUED.
//
// THE DEFECT THIS COVERS. A 发票 a customer asked for and nobody issued had
// exactly one surface: an amber row on Home. No push existed for it —
// lib/push-events.js listed four operator alerts and a fapiao was not one of
// them — and nothing in the app re-asked about anything, ever: the one
// reminder that existed (lib/delivery-reminders.js) claims its row with
// `WHERE reminder_ship_sent_at IS NULL`, so a non-null stamp means never again.
// On 2026-09-11 an operator found two requests unissued from 21 and 26 August,
// both across a month boundary, with nothing having ever buzzed.
//
// THE RULES THIS PINS. Only ISSUING stops the asking — there is no dismissed
// column and a swipe writes nothing. The stamp is a WINDOW, not a latch: the
// row is claimable again once the gap has passed. Reminders land at 10:00 so a
// fapiao never wakes anybody at 03:00, and that is the reminder's own schedule,
// not the quiet-hours setting push-events refuses. The cadence goes DAILY in
// the last three days of the month, because what makes a late fapiao expensive
// is the tax period closing, not the number of days elapsed.
//
// USAGE   node scripts/test_fapiao_reminders.js
// EXIT    0 every assertion held · 1 an assertion failed · 2 no SQLite driver

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT      = path.join(__dirname, '..');
const DB_SRC    = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const SRV_SRC   = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const M_SRC     = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
const EVENTS    = require('../lib/push-events');

let pass = 0, fail = 0;
const ok = (cond, msg, got) => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (got === undefined ? '' : ' — got ' + JSON.stringify(got))); }
};

let openMemoryDb, driver;
try { ({ openMemoryDb, driver } = require('./test-support/memory-db')); }
catch (e) { console.error('[test_fapiao_reminders] no usable SQLite driver:', e.message); process.exit(2); }

// The sweeper requires routes/push, which pulls in the app. It degrades to a
// warning and a null when that is not loadable, and every send is fire-and-
// forget through it — so the sweep's DB behaviour is testable here with no
// server, exactly like the delivery sweeper's own shape. Sends are captured by
// swapping the module's push handle for a recorder.
const fr = require('../lib/fapiao-reminders');

console.log(`\ntest_fapiao_reminders — driver: ${driver}\n`);

const D = (s) => new Date(s);

// ── 1. The cadence, in pure functions ───────────────────────────────────────
console.log('The cadence');

// A request at 23:40 must not spend its life waking people at 23:40.
const late = fr.dueAfter(D('2026-09-01T23:40:00'), fr.FIRST_DELAY_H);
ok(late.getHours() === fr.REMIND_HOUR && late.getMinutes() === 0,
   'a reminder lands at 10:00 whatever hour the request came in', late.toString());
ok(late.getTime() >= D('2026-09-01T23:40:00').getTime() + fr.FIRST_DELAY_H * 3600_000,
   'and never before the gap has actually elapsed', late.toString());

// Silence on day one.
const first = fr.nextDueAt(null, D('2026-09-01T09:00:00'), false);
ok(first.getDate() === 2 && first.getHours() === 10,
   'a request at 09:00 is first asked about at 10:00 the NEXT day, not the same morning',
   first.toString());

// The repeat anchors on the LAST SEND, not on the request — otherwise an old
// debt is permanently overdue and fires on every single tick.
const repeat = fr.nextDueAt(D('2026-09-05T10:00:00'), D('2026-08-01T09:00:00'), false);
ok(repeat.getDate() === 7 && repeat.getMonth() === 8,
   'the repeat is 48h from the last reminder, not from the request — a months-old '
   + 'debt must not be permanently due', repeat.toString());

const monthEndRepeat = fr.nextDueAt(D('2026-08-29T10:00:00'), D('2026-08-01T09:00:00'), true);
ok(monthEndRepeat.getDate() === 30,
   'inside month-end the repeat is 24h — it asks every day', monthEndRepeat.toString());

// ── 2. Month-end is derived from the month, not a fixed date ────────────────
console.log('\nMonth-end');
ok(fr.isMonthEnd(D('2026-08-29T10:00:00')) && fr.isMonthEnd(D('2026-08-31T10:00:00')),
   'the last three days of a 31-day August are month-end');
ok(!fr.isMonthEnd(D('2026-08-28T10:00:00')),
   'the 28th of August is not');
ok(fr.isMonthEnd(D('2026-02-26T10:00:00')),
   'THE 26th OF FEBRUARY IS. The window is computed from the month\'s own length, so a '
   + 'short month is not quietly exempt from the rule the whole feature turns on');
ok(!fr.isMonthEnd(D('2026-02-25T10:00:00')),
   'and the 25th of February is not');
ok(fr.isMonthEnd(D('2028-02-27T10:00:00')) && !fr.isMonthEnd(D('2028-02-26T10:00:00')),
   'a leap February shifts the window by a day, because it is a day longer');

// ── 3. The sweep: it asks, and then it asks again ───────────────────────────
console.log('\nThe sweep');

const db = openMemoryDb();
db.exec(`
CREATE TABLE retail_orders (
  id INTEGER PRIMARY KEY, order_no TEXT, status TEXT, total REAL,
  needs_invoice INTEGER DEFAULT 0, invoice_status TEXT, invoice_title TEXT,
  placed_at TEXT, recipient_name TEXT, customer_id INTEGER,
  invoice_reminder_last_at DATETIME, invoice_reminder_count INTEGER DEFAULT 0
);
CREATE TABLE retail_customers (id INTEGER PRIMARY KEY, nickname TEXT);
INSERT INTO retail_customers (id, nickname) VALUES (1, 'Anders Sloth Nielsen');
INSERT INTO retail_orders (id, order_no, status, total, needs_invoice, invoice_status, invoice_title, placed_at, customer_id) VALUES
  (1, 'TC000342', 'delivered', 1061, 1, 'requested', NULL, '2026-08-21T09:00:00', 1),
  -- The cancelled one from the same screenshot: it must never be reminded about.
  (2, 'TC000407', 'cancelled', 208.5, 1, 'requested', '广州海珠桐森品牌策划工作室', '2026-08-26T09:00:00', NULL),
  -- Already issued. Done.
  (3, 'TC000408', 'delivered', 228.5, 1, 'issued', NULL, '2026-08-27T09:00:00', NULL);
`);

const sent = [];
require('../routes/push'); // may or may not load; the recorder below is what counts
const pushStub = {
  sendPushToOperatorsWithCaps: (t, caps, p) => { sent.push({ t, caps, ...p }); return Promise.resolve({ sent: 1 }); },
  sendPushByPermission: () => Promise.resolve({ sent: 0 }),
};
// The module caches its push handle at load; swap it through require.cache so
// the sweep's sends land in `sent` instead of going nowhere.
const pushPath = require.resolve('../routes/push');
const realPush = require.cache[pushPath];
require.cache[pushPath] = { id: pushPath, filename: pushPath, loaded: true, exports: pushStub };
delete require.cache[require.resolve('../lib/fapiao-reminders')];
const frLive = require('../lib/fapiao-reminders');

const rowOf = (id) => db.prepare('SELECT * FROM retail_orders WHERE id = ?').get(id);

// Too early: the request is 21 August, "now" is the same morning it arrived.
sent.length = 0;
let fired = frLive.sweepDbOnce(db, D('2026-08-21T10:00:00'), 1);
ok(fired === 0 && sent.length === 0,
   'nothing is sent on the day the request arrives — the operator gets their working day');

// T+24h and change: due.
sent.length = 0;
fired = frLive.sweepDbOnce(db, D('2026-08-22T10:00:00'), 1);
ok(fired === 1 && sent.length === 1, 'the first reminder fires the next morning', { fired, sent });
ok(sent[0] && /TC000342/.test(sent[0].body || ''),
   'and it names the order, so the operator knows which one', sent[0]);
ok(sent[0] && sent[0].tag === 'retail-fapiao-1',
   'TAGGED PER ORDER — public/sw.js sets renotify whenever a tag is present, so the next '
   + 'reminder REPLACES this tray entry and still re-alerts rather than stacking', sent[0]);
ok(sent[0] && sent[0].event === 'invoice_pending',
   'carrying the event key its mute switch answers to', sent[0]);
ok(sent[0] && Array.isArray(sent[0].caps) && sent[0].caps.includes('invoices:manage'),
   'and addressed to whoever can actually issue one, not everyone who can read the list',
   sent[0] && sent[0].caps);
ok(rowOf(1).invoice_reminder_count === 1, 'the ask is recorded', rowOf(1));

// THE CENTRAL ASSERTION. Nothing is dismissed, nothing is issued, time passes.
sent.length = 0;
fired = frLive.sweepDbOnce(db, D('2026-08-23T10:00:00'), 1);
ok(fired === 0 && sent.length === 0,
   'a day later it stays quiet — the window has not reopened');

sent.length = 0;
fired = frLive.sweepDbOnce(db, D('2026-08-24T10:00:00'), 1);
ok(fired === 1 && sent.length === 1,
   'IT COMES BACK 48h LATER. No dismissal was recorded because there is nothing to '
   + 'record one in: a swipe is a statement about a phone, not about the work', { fired, sent });
ok(rowOf(1).invoice_reminder_count === 2, 'and the second ask is recorded too');

// Month-end: daily.
db.prepare("UPDATE retail_orders SET invoice_reminder_last_at = '2026-08-29T10:00:00' WHERE id = 1").run();
sent.length = 0;
fired = frLive.sweepDbOnce(db, D('2026-08-30T10:00:00'), 1);
ok(fired === 1,
   'in the last three days of the month it asks EVERY day — the tax period is what is '
   + 'closing, and 48h silence spans most of what is left of it');

// ── 4. What it must never ask about ─────────────────────────────────────────
console.log('\nWhat it leaves alone');
const askedAbout = sent.map(s => s.tag);
ok(!askedAbout.includes('retail-fapiao-2'),
   'the CANCELLED order is never reminded about — there is no sale to put a 发票 behind');
ok(!askedAbout.includes('retail-fapiao-3'),
   'and neither is the one already issued');

// Issuing it stops the asking, with no other write anywhere.
db.prepare("UPDATE retail_orders SET invoice_status = 'issued' WHERE id = 1").run();
sent.length = 0;
fired = frLive.sweepDbOnce(db, D('2026-09-02T10:00:00'), 1);
ok(fired === 0 && sent.length === 0,
   'ISSUING IT IS THE ONLY THING THAT STOPS IT. The row drops out of pendingSql and the '
   + 'sweep has nothing to claim — no reminder state had to be cleared');

// ── 5. The digest ───────────────────────────────────────────────────────────
console.log('\nThe digest');
db.exec(`
INSERT INTO retail_orders (id, order_no, status, total, needs_invoice, invoice_status, placed_at) VALUES
  (10, 'TC000600', 'paid', 10, 1, 'requested', '2026-09-01T09:00:00'),
  (11, 'TC000601', 'paid', 11, 1, 'requested', '2026-09-01T09:00:00'),
  (12, 'TC000602', 'paid', 12, 1, 'requested', '2026-09-01T09:00:00'),
  (13, 'TC000603', 'paid', 13, 1, 'requested', '2026-09-01T09:00:00');
`);
sent.length = 0;
fired = frLive.sweepDbOnce(db, D('2026-09-03T10:00:00'), 1);
ok(sent.length === 1 && sent[0].tag === 'retail-fapiao-digest',
   'above three pending it sends ONE message, not one each — a queue that buzzes twenty '
   + 'times is how somebody learns to switch the category off', sent.map(s => s.tag));
ok(/4/.test(sent[0].body || '') && /最久/.test(sent[0].body || ''),
   'the digest carries the count and the age of the oldest', sent[0] && sent[0].body);
ok(db.prepare('SELECT COUNT(*) AS n FROM retail_orders WHERE invoice_reminder_count > 0 AND id >= 10').get().n === 4,
   'AND EVERY ROW IT COVERED IS CLAIMED. A digest that claimed only the row it named '
   + 'would re-send the other three on the next tick');

if (realPush) require.cache[pushPath] = realPush; else delete require.cache[pushPath];

// ── 6. Wiring ───────────────────────────────────────────────────────────────
console.log('\nWiring');
ok(/addColumn\('retail_orders', 'invoice_reminder_last_at'/.test(DB_SRC)
   && /addColumn\('retail_orders', 'invoice_reminder_count'/.test(DB_SRC),
   'both columns are declared in database.js, not only self-healed at sweep time');
ok(/startFapiaoReminderSweeper/.test(SRV_SRC), 'the sweeper is started at boot');
ok(EVENTS.EVENTS ? EVENTS.EVENTS.some(e => e.key === 'invoice_pending')
                 : /invoice_pending/.test(fs.readFileSync(path.join(ROOT, 'lib', 'push-events.js'), 'utf8')),
   'invoice_pending is a switch a person can find and turn off — an event absent from '
   + 'that list can never be muted, which is the safe direction, but a switch is better');
ok(/fapiaoMonthEnd\(\)\?'brick':'amber'/.test(M_SRC),
   "Home's row goes brick at month-end, on the same boundary the cadence switches on");
ok(/const FAPIAO_MONTH_END_DAYS=3/.test(M_SRC) && /shopTodayDate\(\)/.test(M_SRC),
   "and it reads the SHOP's date, so a phone in another timezone cannot disagree with "
   + 'the server about which month it is');

console.log(`\n${fail ? '✗ ' + fail + ' failed' : '✓ ' + pass + ' passed, 0 failed'}`);
process.exit(fail ? 1 : 0);
