#!/usr/bin/env node
/**
 * Every channel order whose own money doesn't add up, grouped by WHY.
 *
 *     subtotal + packing + delivery - merchant discount  =?  total
 *
 * The drawer's Settlement panel has always enforced this one order at a time,
 * and said so one order at a time: somebody had to open EL20260903163199 before
 * anyone knew it had come in with its components overshooting its total by
 * exactly the delivery fee. This is the same identity asked of the whole table
 * at once, so a systematic fault — a fee the platform stopped billing, a
 * promotion field that moved, a scale slip after a units change — shows up as a
 * count instead of as a coincidence somebody noticed.
 *
 * Rows are classified by lib/channel-settlement.js, the same module
 * routes/eleme-internal.js logs from at ingest, so a `kind` here means exactly
 * what it means in eleme_sync_log. What each one is asking you to check:
 *
 *   delivery_not_billed     the components overshoot by exactly shipping_fee.
 *                           Was the customer actually charged for delivery? A
 *                           free-delivery promotion or a merchant-borne 配送费
 *                           gives a real fee that does NOT belong in the sum.
 *   packaging_not_billed    the same, for packing_fee.
 *   discount_unrecorded     channel_discount is NULL and the sum overshoots. A
 *                           promotion existed and no column caught it.
 *   discount_understated    a discount IS recorded and the sum still overshoots
 *                           — the platform discounted more than the one field
 *                           we read (merchantActivityInfo, for Eleme).
 *   total_above_components  the total exceeds everything we hold. A component
 *                           never captured, or a total read off the wrong key.
 *   scale_x100 / _div100    a units slip. Fix this before reading anything else.
 *
 * For Eleme rows it also prints the archived moneyKeyPaths — which payload field
 * each figure came out of — because that is what separates "the fee is wrong"
 * from "the total was read from a delivery-free field", and the two produce an
 * identical gap.
 *
 * NO CUSTOMER DATA. Order numbers, channels, stores, timestamps, statuses and
 * money. Names, phones, addresses and notes are neither selected nor printed.
 *
 * Every statement is a SELECT, the database is opened read-only, and the
 * connection is PROVEN read-only before anything else runs.
 *
 * Run: Actions → "Read-only prod query" → script = scripts/diagnose_channel_settlement.js
 *   or, on the box:  node scripts/diagnose_channel_settlement.js [days]
 */
'use strict';

const ROOT = process.env.ROOTS_ROOT || '/root/roots-v2';
const DB_PATH = process.env.ROOTS_DB || `${ROOT}/data/roots.db`;
const Database = require(`${ROOT}/node_modules/better-sqlite3`);
const { settlementGap, describeSettlementGap } = require(`${ROOT}/lib/channel-settlement`);

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

// Default 90 days. The window is generous on purpose: a fault that only affects
// one promotion type can go a month between instances, and a survey that can't
// see the previous instance can't tell you it is systematic.
const DAYS = Number(process.argv[2]) || 90;
console.log(`db: ${DB_PATH}\nwindow: last ${DAYS} days\n`);

const rows = db.prepare(`
  SELECT o.id, o.order_no, o.channel, o.store_id, o.status, o.channel_status,
         o.placed_at, o.subtotal, o.packing_fee, o.shipping_fee,
         o.channel_discount, o.channel_commission, o.channel_settle_amount, o.total
    FROM retail_orders o
   WHERE o.channel IN ('meituan', 'eleme')
     AND COALESCE(o.placed_at, o.paid_at) >= datetime('now', ?)
   ORDER BY o.placed_at
`).all(`-${DAYS} days`);

// The Eleme archive, keyed by our order id, for the key paths. LEFT of the main
// query rather than joined into it: a missing archive must not drop the order.
const archives = new Map();
try {
  for (const a of db.prepare(`
    SELECT retail_order_id, detail_json FROM eleme_order_import
     WHERE retail_order_id IS NOT NULL
  `).all()) {
    try { archives.set(a.retail_order_id, JSON.parse(a.detail_json || 'null')); } catch { /* unparseable archive */ }
  }
} catch (e) {
  console.log(`(no eleme_order_import archive readable: ${e.message})\n`);
}

const bad = [];
for (const r of rows) {
  const g = settlementGap(r);
  if (g) bad.push({ row: r, gap: g });
}

console.log(`${rows.length} channel order(s) in window; ${bad.length} do not reconcile ` +
            `(${rows.length ? Math.round(bad.length / rows.length * 100) : 0}%).\n`);

if (!bad.length) {
  console.log('Every channel order in the window adds up. Nothing to chase.');
  process.exit(0);
}

// ── By kind, because one order is an anecdote and eleven are a bug ──────────
console.log('══ by kind ═════════════════════════════════════════════════════\n');
const byKind = new Map();
for (const b of bad) {
  const k = b.gap.kind;
  if (!byKind.has(k)) byKind.set(k, []);
  byKind.get(k).push(b);
}
for (const [kind, list] of [...byKind.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const chans = [...new Set(list.map(b => b.row.channel))].sort().join(', ');
  const total = list.reduce((a, b) => a + Math.abs(b.gap.gap), 0);
  console.log(`  ${String(list.length).padStart(4)}  ${kind.padEnd(24)} ${chans.padEnd(18)} ¥${total.toFixed(2)} unexplained in total`);
}
console.log('');

// ── The orders themselves ───────────────────────────────────────────────────
console.log('══ orders ══════════════════════════════════════════════════════\n');
for (const [kind, list] of [...byKind.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`── ${kind} (${list.length}) ───────────────────────────────`);
  for (const { row: r, gap: g } of list) {
    console.log(`  ${String(r.order_no).padEnd(18)} ${String(r.channel).padEnd(8)} ` +
                `${String(r.placed_at || '').slice(0, 16).padEnd(17)} ${String(r.status).padEnd(10)}`);
    console.log(`     ${describeSettlementGap(g)}`);
    const paths = archives.get(r.id) && archives.get(r.id).moneyKeyPaths;
    if (paths) {
      // Only the terms in the failed identity; income/commission are not part of it.
      const shown = ['total', 'packagingFee', 'deliveryFee', 'shopDiscount']
        .map(k => `${k}=${paths[k] || '—'}`).join('  ');
      console.log(`     read from: ${shown}`);
    } else if (r.channel === 'eleme') {
      console.log('     read from: (no archived key paths — order predates the moneyKeyPaths write)');
    }
    console.log('');
  }
}

// ── The one number worth acting on ──────────────────────────────────────────
const worst = [...byKind.entries()].sort((a, b) => b[1].length - a[1].length)[0];
console.log('══ what to do ══════════════════════════════════════════════════\n');
console.log(`  Largest group: ${worst[0]} (${worst[1].length} order(s)).`);
console.log('  Confirm against the archived payload before changing any parser rule —');
console.log('  every kind above is a hypothesis the arithmetic suggests, not a proven cause.');
console.log('  scripts/diagnose_eleme_order_money.js dumps the payload figures for Eleme rows.');
