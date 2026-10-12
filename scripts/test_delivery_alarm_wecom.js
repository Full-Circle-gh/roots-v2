#!/usr/bin/env node
/**
 * §460 — the delivery alarm also rings the WeCom new-order group, for a
 * booking. A 15:00–17:00 booking rings at 14:30; a day-only booking at 10:00.
 *
 *   node scripts/test_delivery_alarm_wecom.js
 *
 * No network, no keys, no server. lib/delivery-reminders.js's real sweepDbOnce
 * runs against an in-memory retail_orders table on the prod host's clock
 * (Asia/Shanghai), with lib/tenant-notify replaced by a recorder.
 *
 * TO PROVE THE SUITE CAN FAIL:  DAW_MUTANT=1 node scripts/test_delivery_alarm_wecom.js
 * The mutant reads a bare date the old way (new Date('2026-10-14')), so an
 * order whose day the courier panel moved rings "Deliver soon" at 07:30
 * instead of "Deliver today" at 10:00. The suite must go RED.
 */
'use strict';

process.env.TZ = 'Asia/Shanghai';   // the prod host's clock, which dueAtFor reads

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const MUTANT = process.env.DAW_MUTANT === '1';

// The recorder stands in for lib/tenant-notify before delivery-reminders asks
// for it (it is required lazily, on the first alarm).
const sent = [];
let configured = true;
const TN = path.join(ROOT, 'lib', 'tenant-notify.js');
require.cache[TN] = {
  id: TN, filename: TN, loaded: true,
  exports: {
    orderGroupConfigured: () => configured,
    notifyOrderGroup: async (tid, db, content) => { sent.push({ tid, content }); return { ok: true }; },
  },
};

const rem = require(path.join(ROOT, 'lib', 'delivery-reminders.js'));
if (MUTANT) rem.parseScheduled = (v) => new Date(v);
const sweep = MUTANT
  ? (db, now, tid) => {
    // Same sweep, the bare date read the old way.
    const rows = db.prepare('SELECT id, scheduled_for FROM retail_orders').all();
    for (const r of rows) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(r.scheduled_for)) {
        db.prepare('UPDATE retail_orders SET scheduled_for = ? WHERE id = ?')
          .run(new Date(r.scheduled_for).toISOString(), r.id);
      }
    }
    return rem.sweepDbOnce(db, now, tid);
  }
  : rem.sweepDbOnce;

let pass = 0, fail = 0;
async function it(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
const settle = () => new Promise((r) => setImmediate(r));

function freshDb(rows) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE retail_orders (
    id INTEGER PRIMARY KEY, order_no TEXT, status TEXT, fulfillment_type TEXT,
    delivery_slot_kind TEXT, scheduled_for TEXT, delivery_slot_label TEXT,
    recipient_name TEXT, recipient_phone TEXT, address_full TEXT,
    reminder_ship_sent_at DATETIME, reminder_pickup_sent_at DATETIME);
    CREATE TABLE notification_log (id INTEGER PRIMARY KEY, tenant_id INTEGER, channel TEXT, kind TEXT,
      subject TEXT, recipient TEXT, entity_type TEXT, entity_id INTEGER, ok INTEGER, error TEXT,
      detail_json TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  const ins = db.prepare(`INSERT INTO retail_orders
    (order_no, status, fulfillment_type, delivery_slot_kind, scheduled_for, delivery_slot_label,
     recipient_name, recipient_phone, address_full) VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const r of rows) ins.run(...r);
  return db;
}
// 2026-10-14 HH:MM Guangzhou, as a Date.
const gz = (hm) => new Date(`2026-10-14T${hm}:00+08:00`);

(async () => {
  console.log('delivery alarm → WeCom group');

  await it('a 15:00–17:00 booking rings the group at 14:30, not before', async () => {
    sent.length = 0;
    const db = freshDb([['TC001090', 'paid', 'delivery', 'schedule', gz('15:00').toISOString(), '15:00–17:00',
      'miki', '18675883000', '广州市 黄埔区 水西路']]);
    sweep(db, gz('14:29'), 1); await settle();
    assert.strictEqual(sent.length, 0, 'rang early');
    sweep(db, gz('14:30'), 1); await settle();
    assert.strictEqual(sent.length, 1);
    const c = sent[0].content;
    assert.ok(c.startsWith('**⏰ 即将配送**\n**Deliver soon**'), c);
    assert.ok(c.includes('> 订单号 Order: `TC001090`'), c);
    assert.ok(c.includes('> 顾客预约 Booked: <font color="warning">15:00–17:00</font>'), c);
    assert.ok(c.includes('> 收货人 To: miki 18675883000'), c);
    assert.ok(c.includes('> 地址 Address: 广州市 黄埔区 水西路'), c);
    const log = db.prepare('SELECT channel, kind, entity_id, ok FROM notification_log').all();
    assert.deepStrictEqual(log.map((r) => ({ ...r })), [{ channel: 'wecom', kind: 'delivery_alarm', entity_id: 1, ok: 1 }]);
  });

  await it('it rings once — the next tick sends nothing', async () => {
    sent.length = 0;
    const db = freshDb([['TC1', 'paid', 'delivery', 'schedule', gz('15:00').toISOString(), '15:00–17:00', 'a', '', '']]);
    sweep(db, gz('14:30'), 1); sweep(db, gz('14:31'), 1); await settle();
    assert.strictEqual(sent.length, 1);
  });

  await it('a same-day window chosen this morning rings too', async () => {
    sent.length = 0;
    const db = freshDb([['TC2', 'paid', 'delivery', 'today', gz('15:00').toISOString(), '15:00–17:00', 'a', '', '']]);
    sweep(db, gz('14:30'), 1); await settle();
    assert.strictEqual(sent.length, 1);
  });

  await it('a day-only booking rings at 10:00 as "Deliver today"', async () => {
    sent.length = 0;
    const db = freshDb([['TC3', 'paid', 'delivery', 'schedule', gz('00:00').toISOString(), '2026-10-14', 'a', '', '']]);
    sweep(db, gz('09:59'), 1); await settle();
    assert.strictEqual(sent.length, 0);
    sweep(db, gz('10:00'), 1); await settle();
    assert.strictEqual(sent.length, 1);
    assert.ok(sent[0].content.startsWith('**📦 今日配送**\n**Deliver today**'), sent[0].content);
    assert.ok(sent[0].content.includes('Booked: <font color="warning">2026-10-14</font>'), sent[0].content);
  });

  await it('a day moved by the courier panel (bare date) rings at 10:00, not 07:30', async () => {
    sent.length = 0;
    const db = freshDb([['TC4', 'paid', 'delivery', null, '2026-10-14', '2026-10-14', 'a', '', '']]);
    sweep(db, gz('07:30'), 1); await settle();
    assert.strictEqual(sent.length, 0, 'rang at 07:30 — the bare date was read as 08:00');
    sweep(db, gz('10:00'), 1); await settle();
    assert.strictEqual(sent.length, 1);
    assert.ok(sent[0].content.includes('今日配送'), sent[0].content);
  });

  await it('not bookings: Express, restock, a same-day day-only chip — phones only', async () => {
    sent.length = 0;
    const db = freshDb([
      ['TC5', 'paid', 'delivery', 'express', gz('00:00').toISOString(), 'Earliest 2026-10-14', 'a', '', ''],
      ['TC6', 'awaiting_restock', 'delivery', 'restock', gz('00:00').toISOString(), '', 'a', '', ''],
      ['TC7', 'paid', 'delivery', 'today', gz('00:00').toISOString(), 'Today', 'a', '', ''],
    ]);
    const fired = sweep(db, gz('10:00'), 1); await settle();
    assert.strictEqual(fired, 3, 'the phone reminders still fire');
    assert.strictEqual(sent.length, 0, 'but the group is not rung');
  });

  await it('no WeCom channel configured → no send, phone reminder unchanged', async () => {
    sent.length = 0; configured = false;
    try {
      const db = freshDb([['TC8', 'paid', 'delivery', 'schedule', gz('15:00').toISOString(), '15:00–17:00', 'a', '', '']]);
      assert.strictEqual(sweep(db, gz('14:30'), 1), 1);
      await settle();
      assert.strictEqual(sent.length, 0);
    } finally { configured = true; }
  });

  await it('a MOVED time re-arms the alarm; re-saving the same time does not', async () => {
    // The reschedule handlers' own CASE, run on SQLite: SET reads the OLD value.
    const db = freshDb([['TC9', 'paid', 'delivery', 'schedule', '2026-10-14', '2026-10-14', 'a', '', '']]);
    db.prepare("UPDATE retail_orders SET reminder_ship_sent_at = '2026-10-14 02:00:00'").run();
    const resched = db.prepare(`UPDATE retail_orders
        SET scheduled_for = ?,
            reminder_ship_sent_at = CASE WHEN scheduled_for IS ? THEN reminder_ship_sent_at ELSE NULL END
      WHERE id = 1`);
    resched.run('2026-10-14', '2026-10-14');
    assert.ok(db.prepare('SELECT reminder_ship_sent_at s FROM retail_orders').get().s, 'same day cleared the stamp');
    resched.run('2026-10-16', '2026-10-16');
    assert.strictEqual(db.prepare('SELECT reminder_ship_sent_at s FROM retail_orders').get().s, null);
  });

  await it('both reschedule writes in routes/retail.js carry the re-arm', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
    const hits = src.match(/reminder_ship_sent_at\s*=\s*CASE WHEN scheduled_for IS \? THEN reminder_ship_sent_at\s+ELSE NULL END/g) || [];
    assert.strictEqual(hits.length, 2, `found ${hits.length}`);
    assert.ok(/reminder_pickup_sent_at\s*=\s*CASE WHEN scheduled_for IS \? THEN reminder_pickup_sent_at\s+ELSE NULL END/.test(src));
  });

  await it('the 08:00 "Booked for today" list is gone', async () => {
    assert.ok(!fs.existsSync(path.join(ROOT, 'lib', 'booked-day-reminder.js')));
    const src = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
    assert.ok(!src.includes('booked-day-reminder'));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
