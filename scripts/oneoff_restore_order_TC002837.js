#!/usr/bin/env node
/**
 * Put TC002837 back to awaiting payment.
 *
 * Ash, 2026-11-12, on the cancelled order in the drawer: put it back to
 * pending for payment. The button that does this for every cancelled order
 * is the same function (lib/reopen-cancelled-order.js, §529). This run is
 * that button, for this one order, on the live database.
 *
 * Dry run is the default. --apply writes.
 *
 *   node scripts/oneoff_restore_order_TC002837.js
 *   node scripts/oneoff_restore_order_TC002837.js --apply
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const ORDER_NO = 'TC002837';
const APPLY = process.argv.includes('--apply');
const home = process.env.ROOTS_HOME || path.join(__dirname, '..');
const dbPath = process.env.ROOTS_DB || path.join(home, 'data', 'roots.db');

if (!fs.existsSync(dbPath)) {
  console.error('DB not found at', dbPath);
  process.exit(1);
}

const { reopenCancelledOrder } = require(path.join(home, 'lib', 'reopen-cancelled-order'));
const db = new Database(dbPath);

// The column the unpaid clocks read. The app adds it on boot; a repair that
// runs in the gap before that restart adds it here, the same ALTER.
try {
  db.exec('ALTER TABLE retail_orders ADD COLUMN payment_reopened_at DATETIME');
  console.log('added retail_orders.payment_reopened_at');
} catch (e) {
  if (!/duplicate column/i.test(e.message)) throw e;
}

const row = db.prepare('SELECT id, order_no, status FROM retail_orders WHERE order_no = ?').get(ORDER_NO);
if (!row) {
  console.error('NOT FOUND:', ORDER_NO, 'in', dbPath);
  process.exit(1);
}

console.log('db: ' + dbPath);
console.log('order ' + row.order_no + ' id ' + row.id + ' status ' + row.status);
console.log(APPLY ? 'APPLY' : 'DRY RUN');

const result = reopenCancelledOrder(db, row.id, { apply: APPLY });
console.log(JSON.stringify(result, null, 2));

if (!result.ok) process.exit(1);
if (result.already) {
  console.log('Already awaiting payment. Nothing written.');
  process.exit(0);
}
if (!APPLY) {
  console.log('DRY RUN — re-run with --apply to write.');
  process.exit(0);
}

try {
  const prior = db.prepare(
    `SELECT tenant_id FROM activity_log
      WHERE entity_type = 'retail_order' AND entity_id = ? ORDER BY id DESC LIMIT 1`
  ).get(row.id);
  db.prepare(
    `INSERT INTO activity_log (user_id, username, action, entity_type, entity_id, details, tenant_id)
     VALUES (NULL, 'script', 'status_change', 'retail_order', ?, ?, ?)`
  ).run(row.id, JSON.stringify(Object.assign({
    reason: 'restored_by_hand — Ash: put TC002837 back to pending for payment',
    script: 'scripts/oneoff_restore_order_TC002837.js',
  }, result.details || {})), prior ? prior.tenant_id : null);
} catch (e) {
  console.error('order was updated; activity log was not: ' + e.message);
}

const after = db.prepare(
  `SELECT id, order_no, status, paid_at, cancelled_at, cancelled_reason, payment_reopened_at
     FROM retail_orders WHERE id = ?`
).get(row.id);
console.log('AFTER ' + JSON.stringify(after));
