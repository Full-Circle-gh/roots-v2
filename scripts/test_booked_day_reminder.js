#!/usr/bin/env node
/**
 * On the morning of a booked day, the new-order WeCom group gets one message
 * listing that day's booked deliveries — once, whatever restarts.
 *
 *   node scripts/test_booked_day_reminder.js
 *
 * No network, no keys, no server. lib/booked-day-reminder.js runs against a
 * real in-memory retail_orders table with the sender stubbed.
 *
 * TO PROVE THE SUITE CAN FAIL:  BDR_MUTANT=1 node scripts/test_booked_day_reminder.js
 * The mutant drops the claim, so every tick in the window re-sends the same
 * list to the group. The suite must go RED.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('@libsql/client');

const ROOT = path.join(__dirname, '..');
const MUTANT = process.env.BDR_MUTANT === '1';
const LIB = path.join(ROOT, 'lib', 'booked-day-reminder.js');
let rem;
if (MUTANT) {
  const src = fs.readFileSync(LIB, 'utf8')
    .replace(".filter((o) => claim.run(today, o.id, today).changes === 1);", ';');
  const Module = require('module');
  const m = new Module(LIB, module);
  m.filename = LIB;
  m.paths = Module._nodeModulePaths(path.dirname(LIB));
  m._compile(src, LIB);
  rem = m.exports;
} else {
  rem = require(LIB);
}

let pass = 0, fail = 0;
async function it(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

const ZONE = 'Asia/Shanghai';
// 2026-10-14 08:05 Guangzhou.
const MORNING = new Date('2026-10-14T00:05:00Z');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE retail_orders (
    id INTEGER PRIMARY KEY, order_no TEXT, status TEXT, fulfillment_type TEXT,
    delivery_slot_kind TEXT, scheduled_for TEXT, delivery_slot_label TEXT,
    paid_at TEXT, recipient_name TEXT, booked_reminder_day TEXT)`);
  const ins = db.prepare(`INSERT INTO retail_orders
    (order_no, status, fulfillment_type, delivery_slot_kind, scheduled_for, delivery_slot_label, paid_at, recipient_name)
    VALUES (?,?,?,?,?,?,?,?)`);
  // Paid 2026-10-12 (GZ), booked for 2026-10-14 10:00–12:00 — the one to list.
  ins.run('TC001090', 'paid', 'delivery', 'schedule', '2026-10-14T02:00:00.000Z', '10:00–12:00', '2026-10-12 00:43:00', 'miki');
  // Operator moved it to the 14th (null kind, bare date) — listed.
  ins.run('TC001091', 'preparing', 'delivery', null, '2026-10-14', '2026-10-14', '2026-10-11 03:00:00', 'Leo');
  // Express on the 14th — not a booking.
  ins.run('TC001092', 'paid', 'delivery', 'express', '2026-10-13T16:00:00.000Z', '2026-10-14', '2026-10-12 05:00:00', 'A');
  // Booked for tomorrow — not today.
  ins.run('TC001093', 'paid', 'delivery', 'schedule', '2026-10-15', '2026-10-15', '2026-10-12 05:00:00', 'B');
  // Paid this morning for today — the new-order card just covered it.
  ins.run('TC001094', 'paid', 'delivery', 'schedule', '2026-10-14T06:00:00.000Z', '14:00–16:00', '2026-10-14 00:01:00', 'C');
  // Already out of the door.
  ins.run('TC001095', 'dispatched', 'delivery', 'schedule', '2026-10-14', '2026-10-14', '2026-10-12 05:00:00', 'D');
  // Pickup booked for today — its own flow.
  ins.run('TC001096', 'paid', 'pickup', 'pickup', '2026-10-14T03:00:00.000Z', 'Pickup', '2026-10-12 05:00:00', 'E');
  // Cancelled.
  ins.run('TC001097', 'cancelled', 'delivery', 'schedule', '2026-10-14', '2026-10-14', '2026-10-12 05:00:00', 'F');
  return db;
}

function recorder(result = { ok: true }) {
  const sent = [];
  return { sent, send: async (c) => { sent.push(c); return result; } };
}

(async () => {
  console.log('booked-day reminder');

  await it('lists exactly the open, booked, earlier-paid deliveries due today', async () => {
    const db = freshDb();
    const { sent, send } = recorder();
    const r = await rem.runBookedReminder(db, { send, now: MORNING, zone: ZONE });
    assert.deepStrictEqual(r.orders, ['TC001091', 'TC001090']);
    assert.strictEqual(sent.length, 1);
    assert.ok(sent[0].includes('`TC001090`  10:00–12:00  miki'), sent[0]);
    assert.ok(!/TC00109[2-7]/.test(sent[0]), sent[0]);
  });

  await it('the lead lines are one language each, with the count', async () => {
    const msg = rem.buildMessage([{ order_no: 'X1', delivery_slot_label: '', recipient_name: 'z' }]);
    const [cn, en] = msg.split('\n');
    assert.strictEqual(cn, '**📅 今天的顾客预约 (1)**');
    assert.strictEqual(en, '**Booked for today (1)**');
  });

  await it('sends once — a second tick in the window sends nothing', async () => {
    const db = freshDb();
    const { sent, send } = recorder();
    await rem.runBookedReminder(db, { send, now: MORNING, zone: ZONE });
    const again = await rem.runBookedReminder(db, { send, now: new Date(MORNING.getTime() + 60_000), zone: ZONE });
    assert.strictEqual(again.skipped, 'nothing_due');
    assert.strictEqual(sent.length, 1);
  });

  await it('a failed send releases the claim, so the next tick retries', async () => {
    const db = freshDb();
    const bad = recorder({ ok: false, msg: 'boom' });
    const r1 = await rem.runBookedReminder(db, { send: bad.send, now: MORNING, zone: ZONE });
    assert.strictEqual(r1.ok, false);
    const good = recorder();
    const r2 = await rem.runBookedReminder(db, { send: good.send, now: MORNING, zone: ZONE });
    assert.deepStrictEqual(r2.orders, ['TC001091', 'TC001090']);
  });

  await it('an order moved to another day is listed again on that day', async () => {
    const db = freshDb();
    const { send } = recorder();
    await rem.runBookedReminder(db, { send, now: MORNING, zone: ZONE });
    db.prepare("UPDATE retail_orders SET scheduled_for = '2026-10-15' WHERE order_no = 'TC001090'").run();
    const next = await rem.runBookedReminder(db, { send, now: new Date(MORNING.getTime() + 86400000), zone: ZONE });
    assert.deepStrictEqual(next.orders, ['TC001090', 'TC001093']);
  });

  await it('outside 08:00–11:00 shop time nothing is read or sent', async () => {
    const db = freshDb();
    const { sent, send } = recorder();
    for (const utc of ['2026-10-13T23:59:00Z', '2026-10-14T03:00:00Z']) {   // 07:59, 11:00 GZ
      const r = await rem.runBookedReminder(db, { send, now: new Date(utc), zone: ZONE });
      assert.strictEqual(r.skipped, 'not_due', utc);
    }
    assert.strictEqual(sent.length, 0);
  });

  await it('no WeCom channel configured → nothing claimed', async () => {
    const db = freshDb();
    const { sent, send } = recorder();
    const r = await rem.runBookedReminder(db, { send, ready: () => false, now: MORNING, zone: ZONE });
    assert.strictEqual(r.skipped, 'not_configured');
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM retail_orders WHERE booked_reminder_day IS NOT NULL').get().n, 0);
  });

  await it('a long list stays one message, with the rest as a count', async () => {
    const many = Array.from({ length: rem.MAX_LINES + 3 }, (_, i) =>
      ({ order_no: 'TC9' + String(i).padStart(4, '0'), delivery_slot_label: '10:00–12:00', recipient_name: '王小明' }));
    const msg = rem.buildMessage(many);
    assert.ok(msg.endsWith('> +3'), msg.slice(-40));
    assert.ok(Buffer.byteLength(msg, 'utf8') < 2048, 'over the WeCom markdown cap');
  });

  await it('the column exists (database.js addColumn) and the sweeper is wired to the new-order channel', async () => {
    const dbSrc = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
    assert.ok(/addColumn\('retail_orders', 'booked_reminder_day', 'TEXT'\)/.test(dbSrc));
    const rSrc = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
    const i = rSrc.indexOf("require('../lib/booked-day-reminder').startBookedDayReminderSweeper(");
    assert.ok(i > 0, 'sweeper not started');
    const block = rSrc.slice(i, i + 900);
    assert.ok(/sendWecomAppMessage\(content\)/.test(block) && /postWecomMarkdown\(webhook, content\)/.test(block),
      'sweeper must send through the new-order channel');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
