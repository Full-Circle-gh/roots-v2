#!/usr/bin/env node
/**
 * What status do the till's orders actually end in? Read-only.
 *
 *   node scripts/diagnose_till_order_status.js
 *
 * Run through .github/workflows/ro-query.yml. Ash, 2026-10-08: *"all orders
 * from till stay under [paid] status and not complete"*. §441 fixed the one
 * path found by reading the code (a QR order settled at the till), but the
 * repair's dry run found NO counter sale at 'paid' on the live database. So
 * the orders Ash is looking at are something the code reading did not
 * predict: this prints what they are instead of guessing.
 *
 * Prints counts only, plus the latest orders' order_no, timestamps and the
 * columns that decide their status. No names, phones or addresses.
 */
'use strict';

const path = require('path');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';

function loadSqlite() {
  try { return require(path.join(HOME, 'node_modules', 'better-sqlite3')); }
  catch (e) { return require('/root/roots-v2/node_modules/better-sqlite3'); }
}
const Database = loadSqlite();
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// ── Prove read-only, do not assume it ───────────────────────────────────────
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

const SINCE = "datetime('now', '-30 days')";

console.log('\n== Last 30 days: every order, by where it came from and its status ==');
console.log('channel | door (shop_entry_method) | fulfilment | source | status | n');
for (const r of db.prepare(`
  SELECT COALESCE(channel,'-') AS channel, COALESCE(shop_entry_method,'-') AS door,
         COALESCE(fulfillment_type,'-') AS ft, COALESCE(source,'-') AS source,
         status, COUNT(*) AS n
    FROM retail_orders
   WHERE placed_at >= ${SINCE}
   GROUP BY 1,2,3,4,5
   ORDER BY 1,2,3,4,5`).all()) {
  console.log(`${r.channel} | ${r.door} | ${r.ft} | ${r.source} | ${r.status} | ${r.n}`);
}

const TILLISH = `(channel = 'shop' OR shop_entry_method IS NOT NULL OR fulfillment_type = 'counter'
                  OR source = 'manual' OR channel = 'manual')`;

console.log('\n== Latest 20 till / shop / hand-keyed orders ==');
console.log('order_no | placed_at | channel | door | fulfilment | source | status | pay | paid_at | delivered_at | store | refund');
for (const r of db.prepare(`
  SELECT order_no, placed_at, channel, shop_entry_method, fulfillment_type, source, status,
         payment_method, paid_at, delivered_at, store_id, refund_status
    FROM retail_orders
   WHERE ${TILLISH}
   ORDER BY id DESC LIMIT 20`).all()) {
  console.log([r.order_no, r.placed_at, r.channel, r.shop_entry_method, r.fulfillment_type, r.source,
    r.status, r.payment_method, r.paid_at, r.delivered_at, r.store_id, r.refund_status].map((v) => v == null ? '-' : v).join(' | '));
}

console.log('\n== Paid-and-waiting orders that look like they came from a counter ==');
for (const r of db.prepare(`
  SELECT COALESCE(channel,'-') AS channel, COALESCE(shop_entry_method,'-') AS door,
         COALESCE(fulfillment_type,'-') AS ft, status, COUNT(*) AS n,
         MIN(placed_at) AS oldest, MAX(placed_at) AS newest
    FROM retail_orders
   WHERE ${TILLISH} AND status IN ('paid', 'preparing', 'dispatched', 'awaiting_restock')
   GROUP BY 1,2,3,4 ORDER BY n DESC`).all()) {
  console.log(`${r.channel} | ${r.door} | ${r.ft} | ${r.status} | ${r.n} | ${r.oldest} → ${r.newest}`);
}
console.log('\ndone.');
