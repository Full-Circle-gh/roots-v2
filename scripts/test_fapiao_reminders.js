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

// THE SHOP'S CLOCK, ON ANY SERVER CLOCK (§82). Every time below is a Guangzhou
// wall-clock time and every answer is read on Guangzhou's clock, and the suite
// re-runs itself on three server clocks, because a suite runs on whatever clock
// its host has, and Asia/Shanghai — production's today — is the one clock under
// which a host-clock read looks right. Until §82 this file and the code both read the host's clock, so it
// passed everywhere and proved nothing about the zone.
if (!process.env.FAPIAO_CLOCK_CHILD) {
  let bad = 0;
  for (const tz of ['UTC', 'America/New_York', 'Asia/Shanghai']) {
    const r = require('child_process').spawnSync(process.execPath, [__filename], {
      env: { ...process.env, TZ: tz, FAPIAO_CLOCK_CHILD: '1' }, encoding: 'utf8',
    });
    const last = (r.stdout || '').trim().split('\n').pop();
    console.log(`server clock ${tz.padEnd(18)} ${last}`);
    if (r.status !== 0) { bad++; console.log(r.stdout.split('\n').filter((l) => /✗/.test(l)).join('\n')); }
  }
  process.exit(bad ? 1 : 0);
}

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

// A Guangzhou wall-clock time, 'YYYY-MM-DDTHH:MM:SS', as the instant it is.
const businessDate = require('../lib/business-date');
const D = (s) => businessDate.dateInZone('Asia/Shanghai', s.slice(0, 10), +s.slice(11, 13), +s.slice(14, 16));
// …and an instant read back on Guangzhou's clock: { y, m, d, hour, minute }.
const gz = (d) => businessDate.zoneParts('Asia/Shanghai', d);
// placed_at as production stores it: SQLite's zone-less UTC stamp.
const STORED = (s) => D(s).toISOString().slice(0, 19).replace('T', ' ');

// ── 1. The cadence, in pure functions ───────────────────────────────────────
console.log('The cadence');

// A request at 23:40 must not spend its life waking people at 23:40.
const late = fr.dueAfter(D('2026-09-01T23:40:00'), fr.FIRST_DELAY_H);
ok(gz(late).hour === fr.REMIND_HOUR && gz(late).minute === 0,
   'a reminder lands at 10:00 whatever hour the request came in', late.toString());
ok(late.getTime() >= D('2026-09-01T23:40:00').getTime() + fr.FIRST_DELAY_H * 3600_000,
   'and never before the gap has actually elapsed', late.toString());

// Silence on day one.
const first = fr.nextDueAt(null, D('2026-09-01T09:00:00'), false);
ok(gz(first).d === 2 && gz(first).hour === 10,
   'a request at 09:00 is first asked about at 10:00 the NEXT day, not the same morning',
   first.toString());

// The repeat anchors on the LAST SEND, not on the request — otherwise an old
// debt is permanently overdue and fires on every single tick.
const repeat = fr.nextDueAt(D('2026-09-05T10:00:00'), D('2026-08-01T09:00:00'), false);
ok(gz(repeat).d === 7 && gz(repeat).m === 9,
   'the repeat is 48h from the last reminder, not from the request — a months-old '
   + 'debt must not be permanently due', repeat.toString());

const monthEndRepeat = fr.nextDueAt(D('2026-08-29T10:00:00'), D('2026-08-01T09:00:00'), true);
ok(gz(monthEndRepeat).d === 30,
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
  invoice_reminder_last_at DATETIME, invoice_reminder_count INTEGER DEFAULT 0,
  invoice_reminder_snoozed_until DATETIME
);
CREATE TABLE retail_customers (id INTEGER PRIMARY KEY, nickname TEXT);
-- The shop's zone, as Roots carries it (§82). A shop with none is asked
-- nothing at all; see "A shop with no zone" below.
CREATE TABLE storefront_config (key TEXT PRIMARY KEY, value_json TEXT);
INSERT INTO storefront_config (key, value_json) VALUES ('shop.timezone', '"Asia/Shanghai"');
INSERT INTO retail_customers (id, nickname) VALUES (1, 'Anders Sloth Nielsen');
INSERT INTO retail_orders (id, order_no, status, total, needs_invoice, invoice_status, invoice_title, placed_at, customer_id) VALUES
  (1, 'TC000342', 'delivered', 1061, 1, 'requested', NULL, '${STORED('2026-08-21T09:00:00')}', 1),
  -- The cancelled one from the same screenshot: it must never be reminded about.
  (2, 'TC000407', 'cancelled', 208.5, 1, 'requested', '广州海珠桐森品牌策划工作室', '${STORED('2026-08-26T09:00:00')}', NULL),
  -- Already issued. Done.
  (3, 'TC000408', 'delivered', 228.5, 1, 'issued', NULL, '${STORED('2026-08-27T09:00:00')}', NULL);
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
db.prepare(`UPDATE retail_orders SET invoice_reminder_last_at = '${D('2026-08-29T10:00:00').toISOString()}' WHERE id = 1`).run();
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

// ── 4b. "Not today" — the one quieting that is not a dismissal ──────────────
console.log('\nThe snooze');

// Where tomorrow lands. Not now+24h, which would walk the reminder hour later
// into the evening on every press.
const late23 = frLive.snoozeTarget(D('2026-09-03T23:40:00'));
ok(gz(late23).d === 4 && gz(late23).hour === frLive.REMIND_HOUR,
   'a press at 23:40 lands on TOMORROW at 10:00, not 23:40 the next night', late23.toString());
const early = frLive.snoozeTarget(D('2026-09-03T09:00:00'));
ok(gz(early).d === 4,
   'and a press at 09:00 does not leave an ask an hour later the same morning', early.toString());

ok(!frLive.isSnoozed(null, D('2026-09-03T10:00:00'))
   && !frLive.isSnoozed('', D('2026-09-03T10:00:00'))
   && !frLive.isSnoozed('not a date', D('2026-09-03T10:00:00')),
   'a null, blank or UNREADABLE stamp reads as not snoozed — failing towards asking '
   + 'is the safe direction for a debt');
ok(!frLive.isSnoozed(D('2026-09-03T10:00:00').toISOString(), D('2026-09-03T10:00:00')),
   'and a stamp that has arrived is spent, so nothing has to clear the column');

// A fresh pending row, reminded once, then deferred.
db.exec(`INSERT INTO retail_orders (id, order_no, status, total, needs_invoice, invoice_status, placed_at)
         VALUES (20, 'TC000700', 'paid', 700, 1, 'requested', '${STORED('2026-09-01T09:00:00')}');`);
sent.length = 0;
frLive.sweepDbOnce(db, D('2026-09-02T10:00:00'), 1);
ok(rowOf(20).invoice_reminder_count === 1, 'it is asked about once as normal');

// Snooze it to tomorrow, then run the tick that WOULD have asked.
db.prepare('UPDATE retail_orders SET invoice_reminder_snoozed_until = ? WHERE id = ?')
  .run(frLive.snoozeTarget(D('2026-09-04T09:00:00')).toISOString(), 20);
sent.length = 0;
frLive.sweepDbOnce(db, D('2026-09-04T10:00:00'), 1);
ok(sent.length === 0 && rowOf(20).invoice_reminder_count === 1,
   'the ask it would have made is skipped');
// Derived, never a UTC literal: a hardcoded Z-string bakes one zone's
// arithmetic into the fixture, and this suite runs on three server clocks.
ok(rowOf(20).invoice_reminder_last_at === D('2026-09-02T10:00:00').toISOString(),
   'AND THE STAMP IS UNTOUCHED — the row is skipped, never claimed, so a snooze '
   + 'defers the cadence rather than restarting it', rowOf(20).invoice_reminder_last_at);

// One day later the deferral has lapsed and the chase resumes by itself.
sent.length = 0;
frLive.sweepDbOnce(db, D('2026-09-05T10:00:00'), 1);
ok(sent.length === 1 && rowOf(20).invoice_reminder_count === 2,
   'ONE PRESS HIDES ONE ASK. The next day it comes back with nothing having cleared '
   + 'the column', { sent: sent.length, row: rowOf(20).invoice_reminder_count });

// THE SAFEGUARD. A snooze must never take the row off the screen an operator
// walks past — only the interruption is deferred.
db.prepare('UPDATE retail_orders SET invoice_reminder_snoozed_until = ? WHERE id = ?')
  .run(frLive.snoozeTarget(D('2026-09-05T11:00:00')).toISOString(), 20);
const stillPending = db.prepare(
  `SELECT COUNT(*) AS n FROM retail_orders o WHERE o.id = 20 AND ${require('../lib/fapiao-queue').pendingSql('o')}`
).get().n;
ok(stillPending === 1,
   'A SNOOZED ROW IS STILL PENDING WORK. It quiets the push and nothing else, so '
   + "Home's Needs-you row keeps counting it and still goes brick at month-end — "
   + 'which is what stops this from being a way to never do the work');

// MONTH-END HONOURS IT, and the honest shape of that is worth pinning in both
// directions — because the tempting "fix" for the second case is to make the
// snooze longer at month-end, which is exactly the wrong move.
//
// The control means: DO NOT ASK ME AGAIN BEFORE TOMORROW'S REMINDER HOUR. At
// month-end the cadence is already daily, so that defers an ask only when it is
// pressed BEFORE the day's ask has gone out. Pressed after it, tomorrow is when
// the next one was coming anyway and the press changes nothing — which is the
// button telling the truth, not failing.
db.prepare(`UPDATE retail_orders SET invoice_reminder_last_at = '${D('2026-08-29T10:00:00').toISOString()}', invoice_reminder_snoozed_until = ? WHERE id = 20`)
  .run(frLive.snoozeTarget(D('2026-08-30T09:00:00')).toISOString());
sent.length = 0;
frLive.sweepDbOnce(db, D('2026-08-30T10:00:00'), 1);
ok(sent.length === 0,
   'a month-end press made BEFORE the day\'s ask defers it — the control is not '
   + 'disabled for three days a month, because a button that reads as set and buzzes '
   + 'anyway is a lying control, and Home is showing the row in brick regardless');

db.prepare(`UPDATE retail_orders SET invoice_reminder_last_at = '${D('2026-08-29T10:00:00').toISOString()}', invoice_reminder_snoozed_until = ? WHERE id = 20`)
  .run(frLive.snoozeTarget(D('2026-08-29T11:00:00')).toISOString());
sent.length = 0;
frLive.sweepDbOnce(db, D('2026-08-30T10:00:00'), 1);
ok(sent.length === 1,
   'but pressed AFTER it, the same press is a no-op at month-end: it reaches tomorrow '
   + 'and tomorrow is when the daily cadence was asking anyway. A snooze cannot defer '
   + 'below the cadence it is already on, and must not be lengthened so that it could');
db.prepare('UPDATE retail_orders SET invoice_reminder_snoozed_until = NULL WHERE id = 20').run();

db.prepare('UPDATE retail_orders SET needs_invoice = 0 WHERE id = 20').run();  // out of the way of the digest

// ── 4b. The request's own time, read as the UTC it is stored in ─────────────
// placed_at is SQLite's zone-less UTC stamp. Read on the host's clock it was
// eight hours early, so a request made at 15:00 looked like 07:00 and its
// "24 hours of silence" ran out a day too soon: asked about at 10:00 the next
// morning, nineteen hours after the customer asked.
console.log('\nThe request\'s own time');
db.prepare('UPDATE retail_orders SET needs_invoice = 0 WHERE id = 1').run();     // only row 30 pending
db.exec(`INSERT INTO retail_orders (id, order_no, status, total, needs_invoice, invoice_status, placed_at)
         VALUES (30, 'TC000900', 'paid', 90, 1, 'requested', '${STORED('2026-09-10T15:00:00')}');`);
sent.length = 0;
frLive.sweepDbOnce(db, D('2026-09-11T10:00:00'), 1);
ok(!sent.some((x) => x.tag === 'retail-fapiao-30'),
   'a request at 15:00 is NOT asked about at 10:00 the next morning — 24 hours have not passed', sent.map((x) => x.tag));
frLive.sweepDbOnce(db, D('2026-09-12T10:00:00'), 1);
ok(sent.some((x) => x.tag === 'retail-fapiao-30'),
   'it is asked about at 10:00 the morning after that', sent.map((x) => x.tag));
db.prepare('UPDATE retail_orders SET needs_invoice = 0 WHERE id = 30').run();
db.prepare('UPDATE retail_orders SET needs_invoice = 1 WHERE id = 1').run();

// ── 5. The digest ───────────────────────────────────────────────────────────
console.log('\nThe digest');
db.exec(`
INSERT INTO retail_orders (id, order_no, status, total, needs_invoice, invoice_status, placed_at) VALUES
  (10, 'TC000600', 'paid', 10, 1, 'requested', '${STORED('2026-09-01T09:00:00')}'),
  (11, 'TC000601', 'paid', 11, 1, 'requested', '${STORED('2026-09-01T09:00:00')}'),
  (12, 'TC000602', 'paid', 12, 1, 'requested', '${STORED('2026-09-01T09:00:00')}'),
  (13, 'TC000603', 'paid', 13, 1, 'requested', '${STORED('2026-09-01T09:00:00')}');
`);
sent.length = 0;
fired = frLive.sweepDbOnce(db, D('2026-09-03T10:00:00'), 1);
ok(sent.length === 1 && sent[0].tag === 'retail-fapiao-digest',
   'above three pending it sends ONE message, not one each — a queue that buzzes twenty '
   + 'times is how somebody learns to switch the category off', sent.map(s => s.tag));
ok(/4/.test(sent[0].body || '') && /最久/.test(sent[0].body || ''),
   'the digest carries the count and the age of the oldest', sent[0] && sent[0].body);
ok(db.prepare('SELECT COUNT(*) AS n FROM retail_orders WHERE invoice_reminder_count > 0 AND id BETWEEN 10 AND 13').get().n === 4,
   'AND EVERY ROW IT COVERED IS CLAIMED. A digest that claimed only the row it named '
   + 'would re-send the other three on the next tick');

// ── 5b. A shop with no zone (§82 step 3) ────────────────────────────────────
console.log('\nA shop with no zone');
db.exec(`INSERT INTO retail_orders (id, order_no, status, total, needs_invoice, invoice_status, placed_at)
         VALUES (40, 'TC000940', 'paid', 40, 1, 'requested', '${STORED('2026-09-20T09:00:00')}');`);
db.prepare("DELETE FROM storefront_config WHERE key = 'shop.timezone'").run();
sent.length = 0;
fired = frLive.sweepDbOnce(db, D('2026-09-22T10:00:00'), 1);
ok(fired === 0 && sent.length === 0 && rowOf(40).invoice_reminder_count === 0,
   'NOTHING IS ASKED, rather than asked at Guangzhou\'s ten as if it were the shop\'s — and nothing is claimed, '
   + 'so the ask comes the first morning after the zone is set', { fired, sent: sent.length });
db.prepare("INSERT INTO storefront_config (key, value_json) VALUES ('shop.timezone', '\"Asia/Shanghai\"')").run();
fired = frLive.sweepDbOnce(db, D('2026-09-22T10:00:00'), 1);
ok(fired > 0 && rowOf(40).invoice_reminder_count === 1,
   'with the zone back, it is asked (inside the digest, as rows 10–13 are still waiting)', { fired, row: rowOf(40) });

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
ok(/addColumn\('retail_orders', 'invoice_reminder_snoozed_until'/.test(DB_SRC),
   'the snooze column is declared in database.js too');
ok(/invoices\/:id\/snooze/.test(fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8')),
   'the snooze endpoint exists');
ok(/fapiaoReminders\.snoozeTarget/.test(fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8')),
   'AND IT TAKES ITS DATE FROM THE SWEEPER. Two copies of "tomorrow" would '
   + 'eventually disagree by an hour on one day of the year');
ok(/明天提醒我/.test(M_SRC) && /APP\.cmd\('invSnooze'/.test(M_SRC),
   'the phone offers the control, in the live-word pair');
ok(/mCan\('invoices:manage'\)/.test(M_SRC.slice(M_SRC.indexOf("invSnooze"), M_SRC.indexOf("invSnooze") + 4000))
   || /!v\.dead&&!v\.issued&&v\.dbId!=null&&mCan\('invoices:manage'\)/.test(M_SRC),
   'offered only on a pending row, to somebody who could actually issue it');
ok(/const FAPIAO_MONTH_END_DAYS=3/.test(M_SRC) && /shopTodayDate\(\)/.test(M_SRC),
   "and it reads the SHOP's date, so a phone in another timezone cannot disagree with "
   + 'the server about which month it is');

console.log(`\n${fail ? '✗ ' + fail + ' failed' : '✓ ' + pass + ' passed, 0 failed'}`);
process.exit(fail ? 1 : 0);
