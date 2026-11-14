#!/usr/bin/env node
/**
 * diagnose_yuexiu_1150_gap.js
 *
 * Shelf count at Yuexiu for vanilla coconut yogurt SKU 1-150 is 1. The ledger
 * at 19:35 on 2026-11-08 said 2. This prints the recent ledger, the restock
 * line that last brought stock in, every order line for this SKU since
 * 6 Nov, and any same-day yogurt sale at Yuexiu that could have left the
 * shelf without touching 1-150.
 *
 * Read-only. Proves a write is rejected before any SELECT. No customer data.
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

const has = (t) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t);
function cols(table) {
  if (!has(table)) return new Set();
  return new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map(c => c.name));
}

const SHIFT = '+480 minutes';
const now = new Date();
console.log('run at UTC ' + now.toISOString() + '  Guangzhou ' + new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
}).format(now));

const product = db.prepare(`SELECT id, sku, name_en, name_cn, sell_price FROM store_products WHERE UPPER(TRIM(sku)) = '1-150'`).get();
const store = db.prepare(`SELECT id, code, name_en FROM retail_stores WHERE code = 'yuexiu'`).get();
if (!product || !store) {
  console.log('missing product or store', !!product, !!store);
  process.exit(1);
}
console.log(`product #${product.id} ${product.sku} ${product.name_en} / ${product.name_cn} ¥${product.sell_price}`);
console.log(`store #${store.id} ${store.code} ${store.name_en}`);

const stock = db.prepare(`SELECT physical_qty, safety_buffer, updated_at FROM retail_store_stock WHERE store_id = ? AND product_id = ?`).get(store.id, product.id);
console.log('shelf row: ' + JSON.stringify(stock));

console.log('\n══ ledger since 1 Nov, Yuexiu, 1-150 ══');
const ledger = db.prepare(`
  SELECT l.id, datetime(l.created_at, ?) AS local_ts, l.delta, l.balance_after, l.reason,
         l.actor_label, l.channel, l.note, l.ref_table, l.ref_id, o.order_no
    FROM retail_stock_ledger l
    LEFT JOIN retail_orders o ON l.ref_table = 'retail_orders' AND o.id = l.ref_id
   WHERE l.product_id = ? AND l.store_id = ?
     AND datetime(l.created_at, ?) >= '2026-11-01 00:00:00'
   ORDER BY l.created_at, l.id
`).all(SHIFT, product.id, store.id, SHIFT);
for (const m of ledger) {
  console.log(`  #${m.id} ${m.local_ts} ${m.delta >= 0 ? '+' : ''}${m.delta} -> ${m.balance_after} ${m.reason} ${m.channel || ''} ${m.actor_label || ''} ${m.order_no || ''} ${m.ref_table || ''}#${m.ref_id == null ? '' : m.ref_id} ${(m.note || '').replace(/\s+/g, ' ')}`);
}

const restockIds = [...new Set(ledger.filter(m => m.ref_table === 'restock_orders' && m.ref_id).map(m => m.ref_id))];
console.log('\n══ restock lines for those orders, SKU 1-150 ══');
if (restockIds.length && has('restock_items') && has('restock_orders')) {
  const q = restockIds.map(() => '?').join(',');
  const roCols = cols('restock_orders');
  const riCols = cols('restock_items');
  const recv = riCols.has('qty_received') ? 'i.qty_received' : 'NULL';
  const bits = ['o.id', 'o.rs_number', 'o.status', 'o.date'];
  for (const c of ['store_name', 'goods_state', 'dispatched_at', 'received_confirmed_at', 'delivered_at', 'prepared_at']) {
    if (roCols.has(c)) bits.push('o.' + c);
  }
  const rows = db.prepare(`
    SELECT ${bits.join(', ')}, i.sku, i.qty_requested, i.qty_sent, ${recv} AS qty_received, i.product_name
      FROM restock_orders o
      JOIN restock_items i ON i.restock_id = o.id
     WHERE o.id IN (${q}) AND (i.product_id = ? OR UPPER(TRIM(i.sku)) = '1-150')
  `).all(...restockIds, product.id);
  for (const r of rows) console.log('  ' + JSON.stringify(r));
  if (!rows.length) console.log('  (no matching line)');
} else console.log('  (no restock refs)');

console.log('\n══ order lines for 1-150 since 6 Nov, any store ══');
const lines = db.prepare(`
  SELECT o.order_no, o.status, o.channel, o.fulfillment_type, o.store_id,
         datetime(COALESCE(o.paid_at, o.placed_at), ?) AS local_ts,
         i.qty, i.sku, i.name_en, i.unit_price
    FROM retail_order_items i
    JOIN retail_orders o ON o.id = i.order_id
   WHERE (i.product_id = ? OR UPPER(TRIM(i.sku)) = '1-150')
     AND datetime(COALESCE(o.paid_at, o.placed_at), ?) >= '2026-11-06 00:00:00'
   ORDER BY COALESCE(o.paid_at, o.placed_at), i.id
`).all(SHIFT, product.id, SHIFT);
for (const r of lines) console.log(`  ${r.local_ts} ${r.order_no} ${r.status} ${r.channel || ''} ${r.fulfillment_type || ''} store ${r.store_id} qty ${r.qty} ${r.sku} ¥${r.unit_price} ${r.name_en || ''}`);
if (!lines.length) console.log('  (none)');

console.log('\n══ Yuexiu orders today whose lines are any coconut yogurt ══');
const yog = db.prepare(`
  SELECT o.order_no, o.status, o.channel, o.fulfillment_type,
         datetime(COALESCE(o.paid_at, o.placed_at), ?) AS local_ts,
         i.qty, i.sku, i.name_en, i.product_id, i.unit_price
    FROM retail_order_items i
    JOIN retail_orders o ON o.id = i.order_id
   WHERE o.store_id = ?
     AND date(datetime(COALESCE(o.paid_at, o.placed_at), ?)) = '2026-11-08'
     AND (UPPER(TRIM(i.sku)) IN ('1-130','1-140','1-150','1-160','1-180','1-190')
          OR i.name_en LIKE '%ogurt%' OR i.name_cn LIKE '%酸奶%')
   ORDER BY COALESCE(o.paid_at, o.placed_at), i.id
`).all(SHIFT, store.id, SHIFT);
for (const r of yog) console.log(`  ${r.local_ts} ${r.order_no} ${r.status} ${r.channel || ''} ${r.fulfillment_type || ''} qty ${r.qty} ${r.sku} #${r.product_id} ¥${r.unit_price} ${r.name_en || ''}`);
if (!yog.length) console.log('  (none)');

console.log('\n══ ledger rows for those order numbers, any product ══');
const nos = [...new Set(yog.map(r => r.order_no))];
if (nos.length) {
  const q = nos.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT o.order_no, l.id, datetime(l.created_at, ?) AS local_ts, l.delta, l.balance_after,
           l.reason, p.sku, l.store_id
      FROM retail_orders o
      JOIN retail_stock_ledger l ON l.ref_table = 'retail_orders' AND l.ref_id = o.id
      LEFT JOIN store_products p ON p.id = l.product_id
     WHERE o.order_no IN (${q})
     ORDER BY o.order_no, l.id
  `).all(SHIFT, ...nos);
  for (const r of rows) console.log(`  ${r.order_no} ledger #${r.id} ${r.local_ts} store ${r.store_id} ${r.sku} ${r.delta} -> ${r.balance_after} ${r.reason}`);
  if (!rows.length) console.log('  (no ledger rows linked by ref)');
}

console.log('\n══ waste for product 262 since 6 Nov ══');
if (has('waste_records')) {
  const rows = db.prepare(`
    SELECT id, location_id, qty, reason_code, business_date, created_at, created_by_label, voided_at, note
      FROM waste_records
     WHERE store_product_id = ? AND business_date >= '2026-11-06'
  `).all(product.id);
  for (const r of rows) console.log('  ' + JSON.stringify(r));
  if (!rows.length) console.log('  (none)');
} else console.log('  (no waste_records)');
if (has('waste_entries')) {
  const rows = db.prepare(`
    SELECT id, date, qty, reason, product_sku, product_name, notes, created_at
      FROM waste_entries
     WHERE (product_sku = '1-150' OR product_id = ?) AND date >= '2026-11-06'
  `).all(product.id);
  for (const r of rows) console.log('  entry ' + JSON.stringify(r));
  if (!rows.length) console.log('  (no waste_entries)');
}

console.log('\n══ done ══');
