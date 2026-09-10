#!/usr/bin/env node
/**
 * The `shop` channel has taken 38 orders and made zero revenue. Why?
 *
 * ── THE SIGHTING ───────────────────────────────────────────────────────────
 * `diagnose_channel_order_presence.js`, run 2026-09-10, found `shop` with 38
 * orders, 0 paid, ¥0.00, first 2026-09-06 and last 2026-09-08, every one
 * cancelled and ¥2,065.00 of cancelled value. Every other channel converts —
 * `wechat` 712 paid against 138 cancelled, `gzgrocery` 418 of 419. Recorded as
 * open in §89 because that is where it was found, and deliberately not ruled on
 * there: nothing in that reading distinguishes a cause.
 *
 * ── WHAT `shop` IS, WHICH IS WHY THIS MATTERS ──────────────────────────────
 * §44: the till and the QR menu SHARE the channel `shop` and are told apart by
 * `shop_entry_method` ('till' / 'qr'), so a shop's revenue is never split across
 * two channel lines. Both doors are the physical shop. A QR order is written
 * `pending_payment` by routes/shop-menu.js — nobody has paid yet, the customer
 * walks to the till, and staff's Mark-paid is what settles it. Anything still
 * `pending_payment` after `orders.autoCancelHours` (default 6) is swept to
 * cancelled with `cancelled_reason='auto_cancelled_unpaid'`
 * (routes/retail.js:7854).
 *
 * ── THREE CAUSES, AND THEY NEED DIFFERENT ANSWERS ──────────────────────────
 * A. CUSTOMERS ABANDON. People open the menu, build an order, never submit
 *    themselves at the till. Nothing is lost; the shape is ordinary and the
 *    only question is whether the menu is confusing.
 *
 * B. THE SALE HAPPENS BUT THE ORDER IS ORPHANED. The customer does pay, staff
 *    ring it up some other way, and nobody marks the QR order paid — so it is
 *    swept. Revenue is not lost, but the order record is polluted with phantom
 *    cancellations and the QR door looks dead when it is working.
 *
 * C. MARK-PAID IS BROKEN, OR NOBODY KNOWS TO USE IT. The sale is lost from the
 *    record entirely, and every QR customer is a cancelled row.
 *
 * **A AND B AND C LOOK IDENTICAL IN A STATUS COUNT.** They are told apart by
 * `cancelled_reason`, by which door the rows came through, by how long each
 * lived before it was reaped, and by whether any till row exists at all. That
 * is what this prints, and it prints the evidence rather than a verdict —
 * naming a cause a count cannot support is the mistake this script exists to
 * avoid.
 *
 * NO CUSTOMER DATA. `recipient_name` is a person and is NOT selected. Order
 * numbers, timestamps, statuses, reasons, doors, counts and money only.
 *
 * Every statement is a SELECT, the database is opened read-only, and the
 * connection is PROVEN read-only before anything else runs.
 *
 * Run: Actions → "Read-only prod query" → script = scripts/diagnose_shop_channel_cancels.js
 */
'use strict';

const path = require('path');
const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const Database = require(`${HOME}/node_modules/better-sqlite3`);

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
console.log('db: ' + DB_PATH);

const { fen } = require(`${HOME}/lib/finance-window`);
const money = n => '¥' + fen(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rule = t => console.log('\n' + '─'.repeat(78) + (t ? '\n' + t : ''));

const cols = db.prepare('PRAGMA table_info(retail_orders)').all().map(c => c.name);
const has = c => cols.includes(c);
// Read a column only if it exists. A missing column here is a schema difference,
// not a finding, and inventing a value for it would be inventing the answer.
const col = (c, alias) => has(c) ? `${c} AS ${alias || c}` : `NULL AS ${alias || c}`;

// ── 1 · Which door, and what happened to each ──────────────────────────────
rule('1 · every `shop` order by door and outcome');
const byDoor = db.prepare(`
  SELECT COALESCE(${has('shop_entry_method') ? 'shop_entry_method' : 'NULL'}, '(null)') AS door,
         COALESCE(status, '(null)') AS status,
         COALESCE(${has('cancelled_reason') ? 'cancelled_reason' : 'NULL'}, '') AS reason,
         COUNT(*) AS n, COALESCE(SUM(total), 0) AS value
    FROM retail_orders
   WHERE channel = 'shop'
   GROUP BY door, status, reason
   ORDER BY n DESC`).all();
if (!byDoor.length) {
  console.log('  no `shop` orders at all.');
} else {
  console.log('  door     status            cancelled_reason              n           value');
  for (const r of byDoor) {
    console.log(`  ${r.door.padEnd(8)} ${r.status.padEnd(17)} ${(r.reason || '—').padEnd(28)} ${String(r.n).padStart(3)}  ${money(r.value).padStart(12)}`);
  }
}
console.log('\n  auto_cancelled_unpaid   = the 6h sweep reaped it; nobody marked it paid.');
console.log('  superseded_by_new_order = the customer re-submitted; the old row was replaced.');
console.log('  a HAND-ENTERED reason or none = a person cancelled it deliberately.');

// ── 2 · How long each one lived ────────────────────────────────────────────
// The single most decisive number here. A row reaped at almost exactly the
// sweep deadline was never touched by anybody; one cancelled after two minutes
// was cancelled by a person, and they are opposite findings.
rule('2 · minutes from placed to cancelled — was it a person, or the sweep?');
if (has('cancelled_at') && has('placed_at')) {
  const lives = db.prepare(`
    SELECT COALESCE(${has('shop_entry_method') ? 'shop_entry_method' : 'NULL'}, '(null)') AS door,
           CAST((julianday(cancelled_at) - julianday(placed_at)) * 24 * 60 AS INTEGER) AS mins,
           COUNT(*) AS n
      FROM retail_orders
     WHERE channel = 'shop' AND status = 'cancelled'
       AND cancelled_at IS NOT NULL AND placed_at IS NOT NULL
     GROUP BY door, mins ORDER BY mins`).all();
  if (!lives.length) {
    console.log('  no cancelled shop order carries both timestamps.');
  } else {
    const bucket = m => m < 5 ? '< 5 min' : m < 60 ? '5–60 min' : m < 355 ? '1–6 h' : m <= 375 ? '~6 h (THE SWEEP)' : '> 6 h';
    const agg = {};
    for (const r of lives) {
      const k = r.door + ' · ' + bucket(r.mins);
      agg[k] = (agg[k] || 0) + r.n;
    }
    for (const k of Object.keys(agg).sort()) console.log(`  ${k.padEnd(34)} ${String(agg[k]).padStart(3)} orders`);
    const ms = lives.flatMap(r => Array(r.n).fill(r.mins)).sort((a, b) => a - b);
    console.log(`\n  min ${ms[0]} min · median ${ms[Math.floor(ms.length / 2)]} min · max ${ms[ms.length - 1]} min`);
    console.log('  A tight cluster at ~360 min IS the sweep and means NOBODY TOUCHED THESE.');
  }
} else {
  console.log('  cancelled_at / placed_at not both present on this schema — skipped rather than guessed.');
}

// ── 3 · Has the till EVER produced a paid order? ───────────────────────────
// Cause B says the money arrived by another route. If the till is the other
// route, its rows are here. If the till has never produced a paid order either,
// B needs a route that is not in this database at all.
rule('3 · the till, across every channel it has ever written');
const till = db.prepare(`
  SELECT COALESCE(channel, '(null)') AS channel,
         COALESCE(${has('shop_entry_method') ? 'shop_entry_method' : 'NULL'}, '(null)') AS door,
         COALESCE(status, '(null)') AS status,
         COUNT(*) AS n, COALESCE(SUM(total), 0) AS value,
         MIN(date(COALESCE(paid_at, placed_at))) AS first, MAX(date(COALESCE(paid_at, placed_at))) AS last
    FROM retail_orders
   WHERE ${has('shop_entry_method') ? "shop_entry_method = 'till' OR " : ''}channel IN ('manual', 'shop')
   GROUP BY channel, door, status ORDER BY n DESC`).all();
if (!till.length) {
  console.log('  nothing under channel manual/shop at all.');
} else {
  console.log('  channel   door     status            n           value   first        last');
  for (const r of till) {
    console.log(`  ${r.channel.padEnd(9)} ${r.door.padEnd(8)} ${r.status.padEnd(17)} ${String(r.n).padStart(3)}  ${money(r.value).padStart(12)}   ${r.first}   ${r.last}`);
  }
}

// ── 4 · The rows themselves ────────────────────────────────────────────────
rule('4 · every `shop` order, most recent first (no customer data)');
const rows = db.prepare(`
  SELECT ${col('order_no')}, ${col('placed_at')}, ${col('cancelled_at')},
         ${col('status')}, ${col('total')},
         ${col('shop_entry_method', 'door')}, ${col('cancelled_reason', 'reason')},
         ${col('shop_order_code', 'code')}, ${col('store_id')}
    FROM retail_orders WHERE channel = 'shop'
   ORDER BY placed_at DESC`).all();
console.log(`  ${rows.length} rows`);
for (const r of rows) {
  console.log(`  ${String(r.order_no || '').padEnd(18)} ${String(r.placed_at || '').padEnd(20)} `
    + `${String(r.door || '—').padEnd(5)} ${String(r.status || '').padEnd(16)} ${money(r.total).padStart(10)}  `
    + `${String(r.reason || '—')}`);
}

// ── 5 · Did the items come back? ───────────────────────────────────────────
// A cancelled QR order reverses its reservation. If these are abandonment the
// stock was never really gone; if they are lost sales the shelf disagrees with
// the shop. Reported as a count only — the reversal path is not re-derived here.
rule('5 · what those orders held');
const items = db.prepare(`
  SELECT COUNT(DISTINCT i.order_id) AS orders, COUNT(*) AS lines,
         COALESCE(SUM(i.qty), 0) AS units
    FROM retail_order_items i JOIN retail_orders o ON o.id = i.order_id
   WHERE o.channel = 'shop'`).get();
console.log(`  ${items.orders} of the ${rows.length} orders have line items — ${items.lines} lines, ${items.units} units.`);
if (items.orders < rows.length) {
  const n = rows.length - items.orders;
  console.log(`  ${n} ${n === 1 ? 'carries' : 'carry'} NO line items, which is a different failure from an`);
  console.log('  abandoned basket: an order with nothing in it was never a sale.');
}

rule();
console.log('read-only. No write was attempted after the probe, and the probe was rejected.');
