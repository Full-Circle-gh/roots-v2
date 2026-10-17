#!/usr/bin/env node
/**
 * test_auto_deliver_sweep.js — the ETA auto-deliver sweep's own query RUNS, and
 * picks out exactly the orders it is meant to close.
 *
 *   node scripts/test_auto_deliver_sweep.js
 *
 * WHAT IT GUARDS. routes/retail.js autoDeliverLocalEtaForTenant marks a local
 * delivery Delivered once its rider's promised time (local_eta) plus a grace has
 * passed — the fallback for an order no live Qingyun job is tracking. From #1076
 * (2026-10-09) its SELECT carried one unclosed bracket: SQLite refused it with
 * "incomplete input", the sweep logged a warning and returned, every minute, and
 * nothing noticed. The suite that guarded it (test_qingyun_cancel_detect.js)
 * matched the SQL's TEXT and never ran it; text is exactly what a missing
 * bracket leaves intact.
 *
 * HOW. The real function is lifted from the source and run against real tables
 * (retail_orders, retail_shipments, delivery_jobs from database.js) in memory.
 * Only its side effects outside those tables — the stock commit, the activity
 * log, the customer notification — are stand-ins, and they are recorded so the
 * suite can say what was sent. Against the old SQL every case here fails.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openTablesDb } = require('./test-support/memory-db');
const { retailSource } = require('./test-support/retail-source');

const ROOT = path.join(__dirname, '..');
const SRC = retailSource();
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const businessDate = require(path.join(ROOT, 'lib', 'business-date'));

function declSrc(name) {
  const i = SRC.search(new RegExp(`^(function ${name}\\(|const ${name}\\b)`, 'm'));
  assert.ok(i >= 0, `${name} not found`);
  if (SRC.startsWith('function', i)) return SRC.slice(i, SRC.indexOf('\n}', i) + 2);
  return SRC.slice(i, SRC.indexOf(';\n', i) + 1);
}

const db = openTablesDb(DB_SRC, ['retail_orders', 'retail_shipments', 'delivery_jobs']);
let CFG = {};
const SENT = { commits: [], activity: [], notified: [] };
const sweep = new Function('cfgValue', 'tdb', 'deliveryTz', 'businessDate',
  'prepareCommitUnreservedOrder', 'logActivity', 'notifyOrderStatusChange',
  ['AUTO_DELIVER_DEFAULT_GRACE_MIN', 'AUTO_DELIVER_FROM_STATUSES', 'AUTO_DELIVER_FROM_SQL', 'autoDeliverLocalEtaForTenant']
    .map(declSrc).join('\n') + '\nreturn autoDeliverLocalEtaForTenant;')(
  (k, d) => (k in CFG ? CFG[k] : d), () => db, () => null, businessDate,
  (id) => SENT.commits.push(id),
  (...a) => SENT.activity.push({ id: a[4], details: a[5] }),
  (id, to) => SENT.notified.push([id, to]));

// Late in the shop's day, so every ETA below has passed with its grace. The
// courier-job freshness test inside the SQL reads SQLite's own clock, so job
// timestamps below are written relative to that, not to this instant.
const NOW = businessDate.wallClockOnDay(null, new Date(), 23, 59);

let nextId = 1;
function order({ status = 'dispatched', type = 'delivery', eta = '08:00', mode = 'local', job = null } = {}) {
  const id = nextId++;
  db.prepare(`INSERT INTO retail_orders (id, order_no, status, fulfillment_type, subtotal, total)
              VALUES (?, ?, ?, ?, 10, 10)`).run(id, 'TC' + id, status, type);
  if (mode) db.prepare('INSERT INTO retail_shipments (order_id, mode, local_eta) VALUES (?, ?, ?)').run(id, mode, eta);
  if (job) {
    db.prepare(`INSERT INTO delivery_jobs (qingyun_order_id, store_code, retail_order_id, order_status, updated_at, cancelled_at)
                VALUES (?, 'tianhe', ?, ?, datetime('now', ?), ?)`)
      .run('QY' + id, id, job.status, job.updatedAgo || '-0 minutes', job.cancelled ? new Date().toISOString() : null);
  }
  return id;
}
const statusOf = (id) => db.prepare('SELECT status FROM retail_orders WHERE id = ?').get(id).status;
function reset() {
  db.exec('DELETE FROM retail_orders; DELETE FROM retail_shipments; DELETE FROM delivery_jobs');
  CFG = {}; SENT.commits = []; SENT.activity = []; SENT.notified = [];
}

let pass = 0, fail = 0;
function it(name, fn) {
  reset();
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

console.log('\n1. the query runs');
it('the sweep\'s SELECT is valid SQL against the real tables', () => {
  const body = declSrc('autoDeliverLocalEtaForTenant');
  const sql = body.slice(body.indexOf('`') + 1, body.indexOf('`', body.indexOf('`') + 1))
    .replace('${AUTO_DELIVER_FROM_SQL}', "'paid','preparing','dispatched','rider_pickup'");
  db.prepare(sql).all();     // throws "incomplete input" on the #1076 SQL
});
it('a sweep over an empty day delivers nothing and does not throw', () => {
  assert.strictEqual(sweep(NOW), 0);
});

console.log('\n2. what it closes');
it('a dispatched local delivery whose ETA has passed is delivered, with everything that goes with it', () => {
  const id = order();
  assert.strictEqual(sweep(NOW), 1);
  assert.strictEqual(statusOf(id), 'delivered');
  const o = db.prepare('SELECT delivered_at, dispatched_at FROM retail_orders WHERE id = ?').get(id);
  assert.ok(o.delivered_at && o.dispatched_at, 'stamped delivered and dispatched');
  assert.ok(db.prepare('SELECT delivered_at FROM retail_shipments WHERE order_id = ?').get(id).delivered_at, 'the parcel too');
  assert.deepStrictEqual(SENT.commits, [id], 'stock commit for a fresh pre-order');
  assert.deepStrictEqual(SENT.notified, [[id, 'delivered']]);
  assert.strictEqual(SENT.activity[0].details.reason, 'auto_eta');
});
it('every status still in the shop\'s hands is closed: paid, preparing, dispatched, rider coming', () => {
  const ids = ['paid', 'preparing', 'dispatched', 'rider_pickup'].map((status) => order({ status }));
  assert.strictEqual(sweep(NOW), 4);
  for (const id of ids) assert.strictEqual(statusOf(id), 'delivered');
});
it('a courier job that went quiet more than 30 minutes ago no longer holds the timer back', () => {
  const id = order({ job: { status: 20, updatedAgo: '-2 hours' } });
  assert.strictEqual(sweep(NOW), 1);
  assert.strictEqual(statusOf(id), 'delivered');
});
it('a courier job already past drop-off does not hold it back either', () => {
  const id = order({ job: { status: 50 } });
  assert.strictEqual(sweep(NOW), 1);
  assert.strictEqual(statusOf(id), 'delivered');
});

console.log('\n3. what it leaves alone');
it('a live Qingyun rider (job updated in the last 30 minutes, not dropped off): the drop-off sweep decides', () => {
  const id = order({ job: { status: 20, updatedAgo: '-5 minutes' } });
  assert.strictEqual(sweep(NOW), 0);
  assert.strictEqual(statusOf(id), 'dispatched');
});
it('a CANCELLED courier job blocks it however old (TC000823): the parcel never went out', () => {
  const id = order({ job: { status: 20, updatedAgo: '-3 hours', cancelled: true } });
  assert.strictEqual(sweep(NOW), 0);
  assert.strictEqual(statusOf(id), 'dispatched');
});
it('already delivered, cancelled or unpaid orders are not touched', () => {
  const ids = ['delivered', 'cancelled', 'pending_payment'].map((status) => order({ status }));
  assert.strictEqual(sweep(NOW), 0);
  assert.deepStrictEqual(ids.map(statusOf), ['delivered', 'cancelled', 'pending_payment']);
});
it('a pickup order, or a parcel that is not a local run, is not this sweep\'s', () => {
  order({ type: 'pickup' });
  order({ mode: 'courier' });
  order({ mode: null });
  assert.strictEqual(sweep(NOW), 0);
});
it('no ETA, or one that is not HH:MM, is never delivered off', () => {
  order({ eta: '' });
  order({ eta: '8am' });
  assert.strictEqual(sweep(NOW), 0);
});
it('an ETA still inside its grace waits', () => {
  CFG['delivery.autoDeliverEtaMinutes'] = 20;
  order({ eta: '23:45' });
  assert.strictEqual(sweep(NOW), 0);
});
it('a negative grace switches the sweep off', () => {
  CFG['delivery.autoDeliverEtaMinutes'] = -1;
  order();
  assert.strictEqual(sweep(NOW), 0);
});

console.log('\n4. once, not twice');
it('a second tick finds nothing left to do', () => {
  order();
  assert.strictEqual(sweep(NOW), 1);
  assert.strictEqual(sweep(NOW), 0);
  assert.strictEqual(SENT.notified.length, 1, 'the customer is told once');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
