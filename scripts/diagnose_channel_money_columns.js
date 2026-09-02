#!/usr/bin/env node
/**
 * Which money columns are actually POPULATED on live orders, per channel, over
 * the last 30 days — the evidence a money-breakdown renderer needs before it can
 * decide which rows it is allowed to draw.
 *
 * The columns surveyed are the six the drawer would read:
 *   subtotal, packing_fee, shipping_fee,
 *   channel_discount, channel_commission, channel_settle_amount
 *
 * NULL AND ZERO ARE COUNTED SEPARATELY, and that distinction is the whole point.
 * routes/meituan-internal.js writes shipping_fee/packing_fee through
 * COALESCE(?, 0), so a Meituan order the platform told us nothing about holds 0,
 * not NULL — indistinguishable, in a plain "IS NOT NULL" count, from a real
 * zero-packaging order. routes/eleme-internal.js writes neither column at all
 * (see its note at :369-372, which declines them to avoid double-counting
 * against a subtotal that is already the goods value), so Eleme rows should show
 * the table DEFAULT. A renderer that hides zero rows behaves differently for
 * those two cases and needs to know which it is looking at.
 *
 * It also runs the two-step reconciliation the breakdown would claim:
 *   subtotal + packing + shipping - discount = total
 *   total - commission = channel_settle_amount
 * counting how many live orders each step actually holds for, because a
 * breakdown that does not reconcile must say so rather than print a derived
 * number that quietly differs from the platform's own.
 *
 * NO CUSTOMER DATA. Column names, counts, ranges and per-order money only — no
 * names, phones, addresses or notes are selected or printed.
 *
 * Every statement is a SELECT, the database is opened read-only, and the
 * connection is PROVEN read-only before anything else runs.
 *
 * Run: Actions → "Read-only prod query" → script = scripts/diagnose_channel_money_columns.js
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

const COLS = ['subtotal', 'packing_fee', 'shipping_fee',
              'channel_discount', 'channel_commission', 'channel_settle_amount'];

// The window. placed_at is the platform's own order time where we have it, which
// is what "last 30 days of trading" means; it falls back to our import stamp.
const WINDOW = "COALESCE(o.placed_at, o.paid_at) >= datetime('now', '-30 days')";

const channels = db.prepare(`
  SELECT COALESCE(NULLIF(TRIM(o.channel), ''), 'wechat') AS ch, COUNT(*) AS n
    FROM retail_orders o
   WHERE ${WINDOW}
   GROUP BY ch
   ORDER BY n DESC
`).all();

console.log('── orders in the last 30 days, by channel ────────────────');
for (const c of channels) console.log(`   ${String(c.n).padStart(5)}   ${c.ch}`);
console.log('');

// Per channel × column: how many rows are NULL, how many are exactly 0, how many
// carry a real non-zero value, and what range those values span.
console.log('── column population, last 30 days ───────────────────────');
console.log('   channel      column                  rows   NULL   zero   nonzero   min      max');
for (const c of channels) {
  for (const col of COLS) {
    const r = db.prepare(`
      SELECT COUNT(*) AS rows,
             SUM(CASE WHEN o.${col} IS NULL THEN 1 ELSE 0 END) AS nulls,
             SUM(CASE WHEN o.${col} = 0 THEN 1 ELSE 0 END) AS zeros,
             SUM(CASE WHEN o.${col} IS NOT NULL AND o.${col} != 0 THEN 1 ELSE 0 END) AS nonzero,
             MIN(CASE WHEN o.${col} IS NOT NULL AND o.${col} != 0 THEN o.${col} END) AS lo,
             MAX(CASE WHEN o.${col} IS NOT NULL AND o.${col} != 0 THEN o.${col} END) AS hi
        FROM retail_orders o
       WHERE ${WINDOW}
         AND COALESCE(NULLIF(TRIM(o.channel), ''), 'wechat') = ?
    `).get(c.ch);
    const f = (v) => v == null ? '—' : String(Math.round(Number(v) * 100) / 100);
    console.log(`   ${c.ch.padEnd(12)} ${col.padEnd(22)} ${String(r.rows).padStart(5)} ${String(r.nulls).padStart(6)} ${String(r.zeros).padStart(6)} ${String(r.nonzero).padStart(9)}   ${f(r.lo).padStart(7)} ${f(r.hi).padStart(8)}`);
  }
  console.log('');
}

// ── (c) What Eleme rows actually hold in the two fee columns ────────────────
// The survey read routes/eleme-internal.js as never writing them. This is the
// check on that reading against live rows, and it distinguishes the three
// answers that matter: the column DEFAULT, an explicit 0, and a real fee.
console.log('── eleme: packing_fee / shipping_fee, every distinct value ───');
for (const col of ['packing_fee', 'shipping_fee']) {
  const rows = db.prepare(`
    SELECT o.${col} AS v, COUNT(*) AS n
      FROM retail_orders o
     WHERE ${WINDOW} AND o.channel = 'eleme'
     GROUP BY o.${col} ORDER BY n DESC
  `).all();
  console.log(`   ${col}: ` + (rows.length
    ? rows.map(r => `${r.v === null ? 'NULL' : r.v} ×${r.n}`).join(', ')
    : '(no eleme orders in window)'));
}
// The declared default, so "0" above can be read as "the default" or "written".
const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='retail_orders'").get();
for (const col of ['packing_fee', 'shipping_fee']) {
  const m = new RegExp(`\\b${col}\\b[^,\\n]*`, 'i').exec((ddl && ddl.sql) || '');
  console.log(`   DDL  ${col}: ${m ? m[0].trim() : '(not found)'}`);
}
console.log('');

// ── Does the breakdown reconcile? ───────────────────────────────────────────
// Step 1: subtotal + packing + shipping - discount = total
// Step 2: total - commission = channel_settle_amount
// Counted per channel, at a 1-cent tolerance, over orders that carry every
// figure the step needs. An order missing an input is neither a pass nor a
// fail — it is a row the breakdown could not have drawn in the first place.
console.log('── reconciliation, last 30 days ──────────────────────────');
for (const c of channels) {
  const s1 = db.prepare(`
    SELECT COUNT(*) AS have,
           SUM(CASE WHEN ABS((COALESCE(o.subtotal,0) + COALESCE(o.packing_fee,0)
                            + COALESCE(o.shipping_fee,0) - COALESCE(o.channel_discount,0))
                            - COALESCE(o.total,0)) <= 0.011 THEN 1 ELSE 0 END) AS ok
      FROM retail_orders o
     WHERE ${WINDOW} AND COALESCE(NULLIF(TRIM(o.channel), ''), 'wechat') = ?
       AND o.subtotal IS NOT NULL AND o.total IS NOT NULL
  `).get(c.ch);
  const s2 = db.prepare(`
    SELECT COUNT(*) AS have,
           SUM(CASE WHEN ABS((COALESCE(o.total,0) - COALESCE(o.channel_commission,0))
                            - COALESCE(o.channel_settle_amount,0)) <= 0.011 THEN 1 ELSE 0 END) AS ok
      FROM retail_orders o
     WHERE ${WINDOW} AND COALESCE(NULLIF(TRIM(o.channel), ''), 'wechat') = ?
       AND o.channel_commission IS NOT NULL AND o.channel_settle_amount IS NOT NULL
  `).get(c.ch);
  console.log(`   ${c.ch.padEnd(12)} step1 items+pack+ship-disc=total: ${s1.ok}/${s1.have} hold` +
              `   |   step2 total-commission=income: ${s2.ok}/${s2.have} hold`);
}
console.log('');

// ── The derived commission rate, on rows that can carry one ─────────────────
// Neither platform sends a rate. This is what the drawer would compute, on the
// live spread, so the label can say whether "derived" means a stable number or
// a noisy one.
console.log('── derived commission rate (commission / total) ──────────');
for (const c of channels) {
  const r = db.prepare(`
    SELECT COUNT(*) AS n,
           MIN(o.channel_commission / o.total) AS lo,
           MAX(o.channel_commission / o.total) AS hi,
           AVG(o.channel_commission / o.total) AS avg
      FROM retail_orders o
     WHERE ${WINDOW} AND COALESCE(NULLIF(TRIM(o.channel), ''), 'wechat') = ?
       AND o.channel_commission IS NOT NULL AND o.channel_commission != 0
       AND o.total IS NOT NULL AND o.total > 0
  `).get(c.ch);
  if (!r.n) continue;
  const pc = (v) => (Number(v) * 100).toFixed(2) + '%';
  console.log(`   ${c.ch.padEnd(12)} n=${String(r.n).padStart(4)}   ${pc(r.lo)} … ${pc(r.hi)}   (avg ${pc(r.avg)})`);
}
console.log('');

// ── A handful of real rows, money only ──────────────────────────────────────
// So the shape above can be checked against actual orders rather than trusted.
console.log('── most recent channel orders, money columns only ─────────');
const recent = db.prepare(`
  SELECT o.order_no, o.channel, o.status, o.subtotal, o.packing_fee, o.shipping_fee,
         o.channel_discount, o.channel_commission, o.channel_settle_amount, o.total
    FROM retail_orders o
   WHERE ${WINDOW} AND o.channel IN ('meituan', 'eleme')
   ORDER BY o.id DESC LIMIT 12
`).all();
for (const r of recent) {
  console.log(`   ${r.order_no}  ${String(r.channel).padEnd(8)} ${String(r.status).padEnd(10)}` +
    ` sub=${r.subtotal} pack=${r.packing_fee} ship=${r.shipping_fee}` +
    ` disc=${r.channel_discount} comm=${r.channel_commission}` +
    ` income=${r.channel_settle_amount} total=${r.total}`);
}
if (!recent.length) console.log('   (no meituan/eleme orders in the window)');
