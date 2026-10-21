#!/usr/bin/env node
/**
 * diagnose_in_store_today.js — why does the phone's Sales board say
 * "In store · 0 today · ¥0"?
 *
 * That line is channels.pos from GET /api/retail-admin/sales/summary: paid
 * orders (lib/finance-window.js PAID) with fulfillment_type='counter', dated by
 * COALESCE(paid_at, placed_at) on the shop's day. Both shop doors — the till and
 * the QR menu — write channel='shop', fulfillment_type='counter'; a QR order is
 * written 'pending_payment' and only counts once staff mark it paid.
 *
 * This prints, for the last 7 Guangzhou days, every order that is a shop sale by
 * ANY reading (channel 'shop', fulfillment 'counter', or a shop_entry_method),
 * broken down by status / channel / fulfilment / door, and which of them the
 * card's own predicate counts. Counts and money only — no names, phones or
 * addresses. Every statement is a SELECT; the connection is PROVEN read-only.
 *
 *   node scripts/diagnose_in_store_today.js   (via .github/workflows/ro-query.yml)
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
let proven = false;
try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
catch (e) { proven = true; console.log('read-only PROVEN — write rejected: ' + e.message); }
if (!proven) { console.error('FATAL: the connection accepted a write. Aborting.'); process.exit(2); }

const PAID = "status IN ('paid','preparing','dispatched','delivered','awaiting_restock') AND COALESCE(replacement_for_order_id, 0) = 0";
const PDATE = "date(COALESCE(paid_at, placed_at), '+8 hours')";
const PLACED = "date(placed_at, '+8 hours')";
const SHOPISH = "(channel='shop' OR fulfillment_type='counter' OR shop_entry_method IS NOT NULL)";
const POS = "fulfillment_type='counter' AND COALESCE(channel,'') NOT IN ('meituan','gzgrocery')";

const cols = new Set(db.prepare('PRAGMA table_info(retail_orders)').all().map(c => c.name));
for (const c of ['shop_entry_method', 'replacement_for_order_id', 'paid_at', 'fulfillment_type', 'store_id']) {
  console.log('retail_orders.' + c + ': ' + (cols.has(c) ? 'present' : 'MISSING'));
}
console.log('run at: ' + new Date().toISOString() + '\n');

console.log('══ 1 · the card itself: In store (pos) by paid day, last 7 days ══');
for (const r of db.prepare(`
  SELECT ${PDATE} AS d, COUNT(*) AS n, ROUND(COALESCE(SUM(total),0),2) AS rev
    FROM retail_orders WHERE ${POS} AND ${PAID}
     AND ${PDATE} >= date('now','+8 hours','-6 days')
   GROUP BY 1 ORDER BY 1 DESC`).all()) console.log(`  ${r.d}  ${r.n} orders  ¥${r.rev}`);

console.log('\n══ 2 · every shop-looking order PLACED in the last 7 days ══');
console.log('  placed_day | status | channel | fulfilment | door | store | counted_by_card | n | ¥');
for (const r of db.prepare(`
  SELECT ${PLACED} AS d, status, COALESCE(channel,'∅') AS ch, COALESCE(fulfillment_type,'∅') AS ft,
         COALESCE(shop_entry_method,'∅') AS door, COALESCE(store_id,'∅') AS st,
         CASE WHEN (${POS}) AND (${PAID}) THEN 'yes' ELSE 'no' END AS counted,
         COUNT(*) AS n, ROUND(COALESCE(SUM(total),0),2) AS rev
    FROM retail_orders WHERE ${SHOPISH} AND ${PLACED} >= date('now','+8 hours','-6 days')
   GROUP BY 1,2,3,4,5,6,7 ORDER BY 1 DESC, n DESC`).all()) {
  console.log(`  ${r.d} | ${r.status} | ${r.ch} | ${r.ft} | ${r.door} | ${r.st} | ${r.counted} | ${r.n} | ¥${r.rev}`);
}

console.log('\n══ 3 · ALL orders placed today (any channel), by channel/fulfilment/status ══');
for (const r of db.prepare(`
  SELECT COALESCE(channel,'∅') AS ch, COALESCE(fulfillment_type,'∅') AS ft, status,
         COUNT(*) AS n, ROUND(COALESCE(SUM(total),0),2) AS rev
    FROM retail_orders WHERE ${PLACED} = date('now','+8 hours')
   GROUP BY 1,2,3 ORDER BY n DESC`).all()) console.log(`  ${r.ch} | ${r.ft} | ${r.status} | ${r.n} | ¥${r.rev}`);

console.log('\n══ 4 · today\'s shop orders, one line each (no personal data) ══');
for (const r of db.prepare(`
  SELECT order_no, status, channel, fulfillment_type, shop_entry_method AS door, store_id,
         payment_method, total, placed_at, paid_at
    FROM retail_orders WHERE ${SHOPISH} AND ${PLACED} >= date('now','+8 hours','-1 days')
   ORDER BY placed_at DESC LIMIT 40`).all()) console.log('  ' + JSON.stringify(r));

console.log('\ndone.');
