#!/usr/bin/env node
/**
 * test_delivery_clock.js — the delivery jobs that run on a timer judge "today"
 * and "what time is it" on the SHOP's clock, never the server's (§82).
 *
 *   node scripts/test_delivery_clock.js
 *
 * WHAT IT GUARDS. Five places read the server's local clock and were right only
 * because the production server runs on China time. On the UTC server §82
 * requires, each went eight hours wrong:
 *
 *   1. the auto-deliver sweep (routes/retail.js autoDeliverLocalEtaForTenant):
 *      a local rider's order flipped to Delivered eight hours late;
 *   2. the "rider late, nobody assigned" alert (lib/delivery-alerts.js
 *      localStuckRows), which makes the same two decisions;
 *   3. the ship-today reminder (lib/delivery-reminders.js dueAtFor): a day pick
 *      stopped reading as "date only" and the reminder fired at 23:30 the night
 *      before instead of 10:00 on the day;
 *   4. an Express order's day, re-anchored at payment (markOrderPaid), stored at
 *      the server's midnight rather than the shop's;
 *   5. a Qingyun arrival time sent as text (scripts/qingyun-daemon.js
 *      beijingSameDayHHMM), read on the server's clock.
 *
 * HOW. The real code is run: the sweep lifted from the source over real tables,
 * the two lib modules required, the daemon's function lifted from its file.
 * Every instant is built in a named zone. THE SUITE RE-RUNS ITSELF on three
 * server clocks (UTC, New York, Shanghai), because a suite runs on whatever
 * clock its host has, and Asia/Shanghai — production's today, and the runner's
 * default until §82 — is exactly the clock that hid these.
 * Finally it refuses a host-local date read in any of the five.
 */
'use strict';

const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { retailSource } = require('./test-support/retail-source');

const ROOT = path.join(__dirname, '..');

// ── run on three server clocks ─────────────────────────────────────────────
if (!process.env.DELIVERY_CLOCK_CHILD) {
  let bad = 0;
  for (const tz of ['UTC', 'America/New_York', 'Asia/Shanghai']) {
    const r = cp.spawnSync(process.execPath, [__filename], {
      env: { ...process.env, TZ: tz, DELIVERY_CLOCK_CHILD: '1' }, encoding: 'utf8',
    });
    const last = (r.stdout || '').trim().split('\n').pop();
    console.log(`server clock ${tz.padEnd(18)} ${last}`);
    if (r.status !== 0) { bad++; console.log(r.stdout.split('\n').filter((l) => /✗|^\s{6}/.test(l)).join('\n')); console.log(r.stderr); }
  }
  process.exit(bad ? 1 : 0);
}

const SRC = retailSource();
const businessDate = require(path.join(ROOT, 'lib', 'business-date'));
const GZ = 'Asia/Shanghai';
const at = (ymd, h = 0, m = 0, tz = GZ) => businessDate.dateInZone(tz, ymd, h, m);

function declSrc(src, name) {
  const re = new RegExp(`^(function ${name}\\(|const ${name}\\b)`, 'm');
  const i = src.search(re);
  assert.ok(i >= 0, `${name} not found`);
  if (src.startsWith('function', i)) return src.slice(i, src.indexOf('\n}', i) + 2);
  return src.slice(i, src.indexOf(';\n', i) + 1);
}

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

// ── 0. the two shared reads ────────────────────────────────────────────────
console.log('\n0. the shop\'s day and the shop\'s wall clock');
it('a stored day is its own day; an instant is the day it falls on in the shop\'s zone', () => {
  assert.strictEqual(businessDate.dayOfStored(GZ, '2026-10-17'), '2026-10-17');
  assert.strictEqual(businessDate.dayOfStored('America/New_York', '2026-10-17'), '2026-10-17', 'never parsed as UTC midnight');
  assert.strictEqual(businessDate.dayOfStored(GZ, at('2026-10-17', 0, 30).toISOString()), '2026-10-17');
  assert.strictEqual(businessDate.dayOfStored('Europe/London', at('2026-10-17', 0, 30).toISOString()), '2026-10-16');
  for (const v of [null, '', 'soon']) assert.strictEqual(businessDate.dayOfStored(GZ, v), null, String(v));
});
it('"14:05 today" is 14:05 on the shop\'s clock, on the shop\'s day', () => {
  assert.strictEqual(businessDate.wallClockOnDay(GZ, at('2026-10-16', 9), 14, 5).toISOString(), '2026-10-16T06:05:00.000Z');
  assert.strictEqual(businessDate.wallClockOnDay(GZ, at('2026-10-16', 23, 50), 0, 10).toISOString(), at('2026-10-16', 0, 10).toISOString());
  assert.strictEqual(businessDate.wallClockOnDay('Europe/London', at('2026-10-16', 9), 14, 5).toISOString(), '2026-10-16T13:05:00.000Z');
});

// ── 1. the auto-deliver sweep ──────────────────────────────────────────────
console.log('\n1. the auto-deliver sweep marks a local rider\'s order delivered on the shop\'s clock');
// The sweep's SELECT is answered by a stand-in so this section tests the DATE
// decisions alone. (On main that SELECT does not run at all — an unbalanced
// bracket since #1076 — which is reported separately and fixed on its own.)
let TENANT_TZ = null;
let ROWS = [];
let DELIVERED = [];
const fakeDb = {
  prepare(sql) {
    if (/^\s*SELECT/.test(sql)) return { all: () => ROWS };
    if (/SET status = 'delivered'/.test(sql)) return { run: (id) => { DELIVERED.push(id); return { changes: 1 }; } };
    return { run: () => ({ changes: 1 }), all: () => [], get: () => null };
  },
};
const sweep = new Function('cfgValue', 'tdb', 'deliveryTz', 'businessDate',
  'prepareCommitUnreservedOrder', 'logActivity', 'notifyOrderStatusChange',
  ['AUTO_DELIVER_DEFAULT_GRACE_MIN', 'AUTO_DELIVER_FROM_STATUSES', 'AUTO_DELIVER_FROM_SQL', 'autoDeliverLocalEtaForTenant']
    .map((n) => declSrc(SRC, n)).join('\n') + '\nreturn autoDeliverLocalEtaForTenant;')(
  (k, d) => d, () => fakeDb, () => TENANT_TZ, businessDate, () => {}, () => {}, () => {});
const run = (rows, now) => { ROWS = rows; DELIVERED = []; sweep(now); return DELIVERED; };
const row = (id, eta, scheduledFor = null) => ({ id, order_no: 'T' + id, status: 'dispatched', local_eta: eta, scheduled_for: scheduledFor });
const NOW = at('2026-10-16', 14, 0);            // 14:00 in Guangzhou

it('ETA 13:30 + 20 minutes grace has passed at 14:00: delivered', () => {
  TENANT_TZ = null;
  assert.deepStrictEqual(run([row(1, '13:30')], NOW), [1]);
});
it('ETA 13:50 + 20 minutes is 14:10: not yet', () => {
  assert.deepStrictEqual(run([row(2, '13:50')], NOW), []);
});
it('an order booked for tomorrow is never delivered off today\'s ETA, in either stored shape', () => {
  assert.deepStrictEqual(run([row(3, '10:00', at('2026-10-17', 0, 0).toISOString()), row(4, '10:00', '2026-10-17')], NOW), []);
});
it('an order booked for today, as a window or as a day, is delivered once its ETA has passed', () => {
  assert.deepStrictEqual(run([row(5, '10:00', at('2026-10-16', 12, 0).toISOString()), row(6, '10:00', '2026-10-16')], NOW), [5, 6]);
});
it('just after midnight in Guangzhou, a booking for "today" is not mistaken for yesterday', () => {
  assert.deepStrictEqual(run([row(7, '00:05', at('2026-10-16', 0, 0).toISOString())], at('2026-10-16', 0, 30)), [7]);
});
it('a shop in London reads its own clock: 14:00 Guangzhou is 07:00 there, ETA 13:30 not reached', () => {
  TENANT_TZ = 'Europe/London';
  assert.deepStrictEqual(run([row(8, '13:30')], NOW), []);
  assert.deepStrictEqual(run([row(8, '13:30')], at('2026-10-16', 13, 50, 'Europe/London')), [8]);
  TENANT_TZ = null;
});
it('a malformed ETA is never delivered off', () => {
  assert.deepStrictEqual(run([row(9, '1:30'), row(10, ''), row(11, '25:00')], NOW), []);
});

// ── 2. the stuck-rider alert ───────────────────────────────────────────────
console.log('\n2. the stuck-rider alert reads the same two things the same way');
it('it uses the shared reads, not its own copy', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'delivery-alerts.js'), 'utf8');
  const body = declSrc(src, 'localStuckRows');
  assert.ok(/businessDate\.dayOfStored\(tz, r\.scheduled_for\)/.test(body), 'later-day test');
  assert.ok(/businessDate\.wallClockOnDay\(tz, nowD,/.test(body), 'ETA instant');
  assert.ok(/businessDate\.shopTimezone\(db\)/.test(body), 'the shop\'s zone');
});

// ── 3. the ship-today reminder ─────────────────────────────────────────────
console.log('\n3. the ship-today reminder');
const { dueAtFor } = require(path.join(ROOT, 'lib', 'delivery-reminders'));
it('a day pick (the shop\'s midnight) reminds at 10:00 on the day, shop time', () => {
  const d = dueAtFor(at('2026-10-20', 0, 0), GZ);
  assert.strictEqual(d.kind, 'dayof');
  assert.strictEqual(d.at.toISOString(), at('2026-10-20', 10, 0).toISOString());
});
it('a window pick reminds 30 minutes before the window', () => {
  const d = dueAtFor(at('2026-10-20', 14, 0), GZ);
  assert.strictEqual(d.kind, 'window');
  assert.strictEqual(d.at.toISOString(), at('2026-10-20', 13, 30).toISOString());
});
it('no zone means the system default, and an unreadable time means no reminder', () => {
  assert.strictEqual(dueAtFor(at('2026-10-20', 0, 0), null).kind, 'dayof');
  assert.strictEqual(dueAtFor(new Date('soon'), GZ), null);
  assert.strictEqual(dueAtFor(null, GZ), null);
});
it('a shop in London: its own midnight is a day pick, Guangzhou\'s midnight is not', () => {
  const lon = 'Europe/London';
  assert.strictEqual(dueAtFor(at('2026-10-20', 0, 0, lon), lon).kind, 'dayof');
  assert.strictEqual(dueAtFor(at('2026-10-20', 0, 0, lon), lon).at.toISOString(), at('2026-10-20', 10, 0, lon).toISOString());
  assert.strictEqual(dueAtFor(at('2026-10-20', 0, 0), lon).kind, 'window');
});
it('the sweep hands the reminder the shop\'s zone', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'delivery-reminders.js'), 'utf8');
  assert.ok(/const tz = businessDate\.shopTimezone\(db\);/.test(src));
  assert.ok(/dueAtFor\(new Date\(o\.scheduled_for\), tz\)/.test(src));
});

// ── 4. the Express day, re-anchored at payment ─────────────────────────────
console.log('\n4. an Express order\'s day, re-anchored when it is paid');
const markPaid = declSrc(SRC, 'markOrderPaid');
const reanchorAt = markPaid.indexOf("lbl.startsWith('Earliest ')");
const reanchor = markPaid.slice(reanchorAt, markPaid.indexOf('[markOrderPaid reanchor]', reanchorAt));
it('it stores the shop\'s midnight of the Express day', () => {
  assert.ok(reanchorAt > 0, 'the re-anchor block is where it was');
  assert.ok(/businessDate\.dateInZone\(deliveryTz\(\), iso, 0, 0\)\.toISOString\(\)/.test(reanchor), reanchor.slice(0, 400));
});
it('…which the ship reminder reads as a day pick: 10:00 on that day', () => {
  const stored = businessDate.dateInZone(null, '2026-10-21', 0, 0).toISOString();
  const d = dueAtFor(new Date(stored), null);
  assert.strictEqual(d.kind, 'dayof');
  assert.strictEqual(d.at.toISOString(), at('2026-10-21', 10, 0).toISOString());
});

// ── 5. a Qingyun arrival time ──────────────────────────────────────────────
console.log('\n5. a Qingyun arrival time, as a number or as text');
const QY = fs.readFileSync(path.join(ROOT, 'scripts', 'qingyun-daemon.js'), 'utf8');
let CLOCK = at('2026-10-16', 10, 0).getTime();
class FakeDate extends Date { static now() { return CLOCK; } }
const bjHHMM = new Function('Date', declSrc(QY, 'beijingSameDayHHMM') + '\nreturn beijingSameDayHHMM;')(FakeDate);
it('text with no zone is Qingyun\'s Beijing wall clock', () => {
  assert.strictEqual(bjHHMM('2026-10-16 14:05:00'), '14:05');
  assert.strictEqual(bjHHMM('2026-10-16T14:05:00'), '14:05');
});
it('text that names its zone is read in that zone', () => {
  assert.strictEqual(bjHHMM('2026-10-16T06:05:00Z'), '14:05');
  assert.strictEqual(bjHHMM('2026-10-16T14:05:00+08:00'), '14:05');
  assert.strictEqual(bjHHMM('2026-10-16T07:05:00+0100'), '14:05');
});
it('epoch seconds and milliseconds', () => {
  const t = at('2026-10-16', 14, 5).getTime();
  assert.strictEqual(bjHHMM(Math.floor(t / 1000)), '14:05');
  assert.strictEqual(bjHHMM(String(t)), '14:05');
});
it('another day, or nothing readable, gives no time', () => {
  assert.strictEqual(bjHHMM('2026-10-17 01:00:00'), null);
  CLOCK = at('2026-10-16', 23, 50).getTime();
  assert.strictEqual(bjHHMM('2026-10-17 00:10:00'), null, 'just past midnight is tomorrow');
  CLOCK = at('2026-10-16', 10, 0).getTime();
  for (const v of [null, '', 'soon', 0]) assert.strictEqual(bjHHMM(v), null, String(v));
});

// ── 6. no host-local reads left ────────────────────────────────────────────
console.log('\n6. no host-local date read in any of the five');
{
  const HOST = /\.(getHours|getMinutes|getDate|getDay|getMonth|getFullYear|setHours|setDate|toDateString)\(|new Date\([^()]*,[^()]*,/;
  const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '');
  const cases = {
    autoDeliverLocalEtaForTenant: declSrc(SRC, 'autoDeliverLocalEtaForTenant'),
    localStuckRows: declSrc(fs.readFileSync(path.join(ROOT, 'lib', 'delivery-alerts.js'), 'utf8'), 'localStuckRows'),
    dueAtFor: declSrc(fs.readFileSync(path.join(ROOT, 'lib', 'delivery-reminders.js'), 'utf8'), 'dueAtFor'),
    'markOrderPaid Express re-anchor': reanchor,
    beijingSameDayHHMM: declSrc(QY, 'beijingSameDayHHMM'),
  };
  for (const [name, body] of Object.entries(cases)) {
    it(name, () => {
      const hit = HOST.exec(strip(body));
      assert.strictEqual(hit && hit[0], null);
    });
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
