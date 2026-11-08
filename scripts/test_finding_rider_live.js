#!/usr/bin/env node
/**
 * "Finding a rider" shows up without a reload.
 *
 *   node scripts/test_finding_rider_live.js
 *
 * THE COMPLAINT. The same-city card stayed on whatever it said when the
 * drawer opened. "Finding a rider" appeared only after a full page reload.
 * The stage lives on delivery_jobs, which the Qingyun daemon writes, and
 * nothing that paints the admin was watching that write: the live watermark
 * read the order row, the list's fingerprint ignored the courier, and the
 * open drawer only polled once a rider was already on the map.
 *
 * No browser. Fast shard.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const RETAIL = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const ORDERS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '04-orders.js'), 'utf8');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

function sliceFn(src, name) {
  const at = src.indexOf('function ' + name);
  assert.ok(at >= 0, name + ' is gone');
  const rest = src.slice(at + 1);
  const m = /\n(?:async )?function /.exec(rest);
  return src.slice(at, m ? at + 1 + m.index : src.length);
}

function selectFor(fnSrc, table) {
  const at = fnSrc.search(new RegExp('FROM ' + table + '(?![_a-z])'));
  assert.ok(at >= 0, 'the watermark no longer selects from ' + table);
  const start = fnSrc.lastIndexOf('SELECT', at);
  assert.ok(start >= 0, 'no SELECT for ' + table);
  // Through the closing backtick of the prepare() string, so a WHERE on the
  // next line is part of the query and the ").get()" after it is not.
  const end = fnSrc.indexOf('`', at);
  assert.ok(end > at, 'the ' + table + ' query lost its end');
  return fnSrc.slice(start, end);
}

const sigFn = sliceFn(RETAIL, '_dashActivitySignature');
const stampFn = sliceFn(RETAIL, '_qingyunNoteSeekingRider');
const stageFn = sliceFn(RETAIL, 'deliveryJobStage');
const jobSql = selectFor(sigFn, 'delivery_jobs');

const stampSql = (/prepare\(`([\s\S]*?)`\)/.exec(stampFn) || [])[1];
assert.ok(stampSql, 'the dispatch stamp SQL is gone');

function loadOrdersFns() {
  const src = [
    sliceFn(ORDERS, '_ordersFp'),
    sliceFn(ORDERS, 'courierCardKey'),
    sliceFn(ORDERS, 'courierStageMoved'),
    sliceFn(ORDERS, 'courierOrderWatchable'),
  ].join('\n');
  const ctx = {};
  vm.runInNewContext(src + '\nthis._ordersFp=_ordersFp; this.courierCardKey=courierCardKey; this.courierStageMoved=courierStageMoved; this.courierOrderWatchable=courierOrderWatchable;', ctx);
  return ctx;
}
const ui = loadOrdersFns();

function stageOf(row) {
  const ctx = { deliveryJobStage: null };
  vm.runInNewContext(stageFn + '\ndeliveryJobStage = deliveryJobStage;', ctx);
  return ctx.deliveryJobStage(row);
}

function jobDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE delivery_jobs (
      id INTEGER PRIMARY KEY,
      qingyun_order_id TEXT UNIQUE NOT NULL,
      retail_order_id INTEGER,
      store_code TEXT NOT NULL,
      carrier_name TEXT,
      delivery_id TEXT,
      rider_name TEXT,
      order_status INTEGER,
      delivery_status INTEGER,
      cancelled_at TEXT,
      superseded INTEGER NOT NULL DEFAULT 0,
      rider_lat INTEGER,
      updated_at TEXT
    );
  `);
  return db;
}

function stamp(db, id, name) {
  db.prepare(stampSql).run(String(id), 7, 'YX', name || null);
}

console.log('\nThe watermark moves when a rider starts being sought, and not when the dot moves');

it('the signature reads delivery_jobs, and not the GPS clock', () => {
  assert.ok(/FROM delivery_jobs/.test(sigFn), 'delivery_jobs left the watermark');
  assert.ok(!/updated_at|rider_lat|eta_seconds/.test(jobSql),
    'a GPS tick is in the courier signature — that refetches the whole admin');
});

it('calling a rider moves it; a position rewrite does not', () => {
  const db = jobDb();
  const sig = () => {
    const j = db.prepare(jobSql).get();
    return [j.n, j.os, j.ds, j.cx, j.live].join('|');
  };
  const empty = sig();
  db.prepare(`INSERT INTO delivery_jobs (qingyun_order_id, store_code, order_status, retail_order_id)
              VALUES ('QY1', 'YX', 20, 7)`).run();
  const scheduled = sig();
  assert.notStrictEqual(scheduled, empty, 'a new delivery did not move the watermark');
  db.prepare(`UPDATE delivery_jobs SET rider_lat = 23123456, updated_at = '2026-11-08 02:00:00'`).run();
  assert.strictEqual(sig(), scheduled, 'a GPS tick moved the watermark');
  db.prepare(`UPDATE delivery_jobs SET order_status = 30, delivery_status = 10`).run();
  assert.notStrictEqual(sig(), scheduled, '待抢单 did not move the watermark');
  db.close();
});

console.log('\nA dispatch the operator just accepted reads as finding a rider, immediately');

it('a scheduled copy becomes "finding a rider", and a rider already at the door is left there', () => {
  const db = jobDb();
  db.prepare(`INSERT INTO delivery_jobs (qingyun_order_id, store_code, order_status, retail_order_id)
              VALUES ('QY1', 'YX', 20, 7)`).run();
  stamp(db, 'QY1', '达达');
  const seeking = db.prepare('SELECT * FROM delivery_jobs WHERE qingyun_order_id = ?').get('QY1');
  assert.strictEqual(stageOf(seeking), 'awaiting_dispatch');
  assert.strictEqual(seeking.carrier_name, '达达');

  db.prepare(`INSERT INTO delivery_jobs
                (qingyun_order_id, store_code, order_status, delivery_status, rider_name, retail_order_id)
              VALUES ('QY2', 'YX', 30, 20, '葛师傅', 8)`).run();
  stamp(db, 'QY2', '达达');
  const coming = db.prepare('SELECT * FROM delivery_jobs WHERE qingyun_order_id = ?').get('QY2');
  assert.strictEqual(stageOf(coming), 'heading_to_pickup');
  assert.strictEqual(coming.rider_name, '葛师傅');
  assert.strictEqual(coming.delivery_status, 20);

  db.prepare(`INSERT INTO delivery_jobs
                (qingyun_order_id, store_code, order_status, cancelled_at, retail_order_id)
              VALUES ('QY3', 'YX', 30, '2026-11-08 01:00:00', 9)`).run();
  stamp(db, 'QY3', '达达');
  const gone = db.prepare('SELECT * FROM delivery_jobs WHERE qingyun_order_id = ?').get('QY3');
  assert.strictEqual(stageOf(gone), 'cancelled');
  assert.strictEqual(gone.order_status, 30);

  // No row yet — the stamp creates one, and it reads the same way.
  stamp(db, 'QY4', null);
  const born = db.prepare('SELECT * FROM delivery_jobs WHERE qingyun_order_id = ?').get('QY4');
  assert.strictEqual(stageOf(born), 'awaiting_dispatch');
  assert.strictEqual(born.retail_order_id, 7);
  db.close();
});

it('an in-flight order with no delivery status is not pulled back to "finding a rider"', () => {
  const db = jobDb();
  db.prepare(`INSERT INTO delivery_jobs (qingyun_order_id, store_code, order_status, retail_order_id)
              VALUES ('QY5', 'YX', 30, 7)`).run();
  const before = db.prepare('SELECT * FROM delivery_jobs WHERE qingyun_order_id = ?').get('QY5');
  assert.strictEqual(stageOf(before), 'in_transit');
  stamp(db, 'QY5', '达达');
  const after = db.prepare('SELECT * FROM delivery_jobs WHERE qingyun_order_id = ?').get('QY5');
  assert.strictEqual(after.order_status, 30);
  assert.strictEqual(after.delivery_status, null);
  assert.strictEqual(stageOf(after), 'in_transit');
  db.close();
});

console.log('\nThe list and the open drawer notice the stage, and ignore a GPS tick');

it('the list fingerprint changes when the stage does, and not when only the order clock does', () => {
  const row = { id: 7, status: 'preparing', updated_at: '2026-11-08 00:41:00', courier: { stage: 'scheduled' } };
  const before = ui._ordersFp([row]);
  const sameClock = ui._ordersFp([Object.assign({}, row, { updated_at: '2026-11-08 00:41:00' })]);
  assert.strictEqual(sameClock, before);
  const sought = ui._ordersFp([Object.assign({}, row, { courier: { stage: 'awaiting_dispatch' } })]);
  assert.notStrictEqual(sought, before, 'finding a rider did not break the list fingerprint');
  const gps = ui._ordersFp([Object.assign({}, row, {
    courier: { stage: 'scheduled', updated_at: '2026-11-08 02:00:00', eta_seconds: 49 },
  })]);
  assert.strictEqual(gps, before, 'a GPS tick broke the list fingerprint');
});

it('the open drawer refreshes into "finding a rider", and does not refresh backwards off it', () => {
  assert.strictEqual(ui.courierStageMoved(null, { tracking: true, stage: 'awaiting_dispatch' }), true);
  assert.strictEqual(ui.courierStageMoved({ stage: 'scheduled' }, { tracking: true, stage: 'awaiting_dispatch' }), true);
  assert.strictEqual(ui.courierStageMoved(
    { stage: 'awaiting_dispatch' },
    { tracking: true, stage: 'awaiting_dispatch' }), false);
  // The click landed, the daemon has not. Keep the card.
  assert.strictEqual(ui.courierStageMoved(
    { stage: 'awaiting_dispatch' },
    { tracking: true, stage: 'scheduled' }), false);
  assert.strictEqual(ui.courierStageMoved(
    { stage: 'heading_to_pickup', rider: { name: '葛师傅' } },
    { tracking: true, stage: 'heading_to_pickup', rider: { name: '葛师傅' }, eta_seconds: 80 }), false);
  assert.strictEqual(ui.courierStageMoved(
    { stage: 'heading_to_pickup', rider: { name: '葛师傅' } },
    { tracking: false }), true);
  assert.strictEqual(ui.courierStageMoved({ stage: 'cancelled' }, { tracking: false }), false);
});

it('the drawer keeps watching until the run is actually over', () => {
  assert.strictEqual(ui.courierOrderWatchable({ status: 'preparing', qingyun_ship_from: { store_code: 'YX' } }), true);
  assert.strictEqual(ui.courierOrderWatchable({ status: 'preparing', courier: { stage: 'scheduled' } }), true);
  assert.strictEqual(ui.courierOrderWatchable({ status: 'preparing', courier: { stage: 'awaiting_dispatch' } }), true);
  assert.strictEqual(ui.courierOrderWatchable({ status: 'preparing', courier: { stage: 'cancelled' } }), true);
  assert.strictEqual(ui.courierOrderWatchable({ status: 'delivered', courier: { stage: 'delivered' } }), false);
  assert.strictEqual(ui.courierOrderWatchable({ status: 'preparing' }), false);
});

it('the drawer actually polls, and the list poll is what repaints', () => {
  assert.ok(/startCourierWatch\(o\)/.test(ORDERS), 'opening an order does not watch the rider stage');
  assert.ok(/stopCourierWatch\(\)/.test(ORDERS), 'closing the drawer leaves the watch running');
  assert.ok(/courierStageMoved\(/.test(ORDERS), 'the watch never compares the stage');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
