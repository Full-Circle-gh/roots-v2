#!/usr/bin/env node
/**
 * Tight follow-up to scripts/diagnose_eleme_courier_status.js's question 2.
 * That capture named channel_status's whole live vocabulary ("VALID", 3/3)
 * and the real per-order lifecycle labels sitting elsewhere in the payload
 * (header.orderLatestStatus, printDataInfo.statusForPrint,
 * deliveryInfo.distTraceView.traceView.status). It did not select
 * retail_orders.delivered_at, which the mapping decision needs alongside
 * o.status to cross-reference against — this adds exactly that, for the
 * same three live Eleme orders, nothing else.
 *
 * Every statement is a SELECT, the database is opened read-only, and the
 * connection is PROVEN read-only before anything else runs.
 *
 * Run: Actions → "Read-only prod query" → script = scripts/diagnose_eleme_status_survey.js
 */
'use strict';

const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const Database = require('/root/roots-v2/node_modules/better-sqlite3');

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

let proven = false;
try {
  db.exec('CREATE TABLE __ro_probe__ (x)');
} catch (e) {
  proven = true;
  console.log('read-only PROVEN — write rejected: ' + e.message);
}
if (!proven) {
  console.error('FATAL: the connection accepted a write. Aborting without reading anything.');
  process.exit(2);
}
console.log('db: ' + DB_PATH + '\n');

console.log('── channel_status vocabulary across every eleme row in retail_orders ──');
const dist = db.prepare(`
  SELECT channel_status, COUNT(*) AS n
    FROM retail_orders
   WHERE channel = 'eleme'
   GROUP BY channel_status
   ORDER BY n DESC
`).all();
for (const r of dist) console.log(`   ${String(r.n).padStart(4)}   channel_status = ${JSON.stringify(r.channel_status)}`);
console.log(`   (${dist.reduce((a, r) => a + r.n, 0)} eleme row(s) total)\n`);

console.log('── each, cross-referenced against status / lifecycle timestamps ──');
// retail_orders' own timestamp columns (database.js) — no refunded_at here,
// that column lives on the unrelated meituan_orders import table.
const rows = db.prepare(`
  SELECT id, order_no, status, channel_status, channel_status_at,
         placed_at, paid_at, preparing_at, dispatched_at, delivered_at, cancelled_at
    FROM retail_orders
   WHERE channel = 'eleme'
   ORDER BY id
`).all();
for (const r of rows) {
  console.log(`   ${r.order_no}  (id ${r.id})`);
  console.log(`     status=${r.status}  channel_status=${JSON.stringify(r.channel_status)}  channel_status_at=${r.channel_status_at}`);
  console.log(`     placed_at=${r.placed_at}  paid_at=${r.paid_at}  preparing_at=${r.preparing_at}`);
  console.log(`     dispatched_at=${r.dispatched_at}  delivered_at=${r.delivered_at}  cancelled_at=${r.cancelled_at}`);
}
console.log('');
