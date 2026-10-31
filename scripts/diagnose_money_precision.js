#!/usr/bin/env node
/**
 * diagnose_money_precision.js — how much of the live money is already inexact,
 * and how big the tables are. Stage 0 of docs/tacet-money-migration-plan.md.
 *
 *   Run through .github/workflows/ro-query.yml (manual dispatch).
 *   Locally:  ROOTS_DB=/path/to/copy.db node scripts/diagnose_money_precision.js
 *
 * READ-ONLY, and it PROVES that rather than asserting it: the connection is
 * opened readonly and then handed a CREATE TABLE, and the script aborts if the
 * write is accepted. Same contract as every other diagnose_* here.
 *
 * WHY IT EXISTS. Audit A-06 says money is stored as floating point. The fix
 * plan's first stage is an inventory and a recorded baseline, and both have to
 * come from the live database rather than from the source:
 *
 *   1. THE INVENTORY IS DISPUTED. The audit counted 51 REAL money columns of 61
 *      across 32 tables. A source scan with looser name matching found 89 across
 *      37. Neither is trustworthy enough to migrate from — one under-counts, the
 *      other picks up `_migrations` snapshot columns. `PRAGMA table_info` over
 *      the live schema settles it, because it reads what exists rather than what
 *      the source says should exist.
 *
 *   2. THE BASELINE MUST PREDATE THE CHANGE. Some money invariants almost
 *      certainly fail today — the refund path carries a half-cent tolerance,
 *      which is what you write when they do. Unless the current failure set is
 *      recorded FIRST, every pre-existing discrepancy gets attributed to the
 *      migration and the migration gets reverted for a bug it did not cause.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not check "order total equals the
 * sum of its components" or "lifetime spend equals the sum of orders". Both
 * need business rules — which order statuses count, which fees are additive —
 * that this script would have to GUESS, and a guessed invariant reporting a
 * scary number is worse than no invariant. Those belong in
 * check_money_invariants.js, written against the code that computes them.
 *
 * What it checks instead is either pure arithmetic (a stored value either is or
 * is not a whole number of cents) or the SHIPPED predicate itself
 * (lib/channel-settlement.js's settlementGap, required and run, not reimplemented).
 */
'use strict';

const path = require('path');

const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
// The deployed node_modules by absolute path, as every other diagnose_* does —
// with a local fallback so this can be dry-run against a scratch copy first.
let Database;
try { Database = require('/root/roots-v2/node_modules/better-sqlite3'); }
catch (e) { Database = require('better-sqlite3'); }

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
console.log('db: ' + DB_PATH);
console.log('sqlite: ' + db.prepare('select sqlite_version() v').get().v);

// ── Which columns are money ─────────────────────────────────────────────────
// Name-based, because SQLite carries no unit. Two lists, and the NOT list wins:
// `unit_price` is money, `unit` is not; `total_cost` is money, `total_votes` is
// not; `cost_incomplete` is a flag whose name contains "cost".
const MONEY = /(price|cost|amount|total|fee|paid|refund|subtotal|discount|revenue|balance|charge|tax|tender|spend|wallet|credit|deposit|payout|commission|surcharge|settle)/i;
const NOT_MONEY = /(qty|count|votes|_id$|_at$|_by$|percent|pct|_rate$|ratio|level|status|type|method|note|reason|url|json|_code$|name|incomplete|uncosted|source|ref$|display_min)/i;

const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all().map(r => r.name);

const cols = [];              // { table, column, decl, rows }
for (const t of tables) {
  let info;
  try { info = db.prepare(`PRAGMA table_info("${t}")`).all(); } catch (e) { continue; }
  for (const c of info) {
    if (!MONEY.test(c.name) || NOT_MONEY.test(c.name)) continue;
    cols.push({ table: t, column: c.name, decl: (c.type || '').toUpperCase() || '(none)' });
  }
}

const byDecl = {};
for (const c of cols) (byDecl[c.decl] = byDecl[c.decl] || []).push(c);

console.log('\n══ 1 · THE INVENTORY, from the live schema ═══════════════════════');
console.log(`${cols.length} money-named column(s) across ${new Set(cols.map(c => c.table)).size} table(s)`);
for (const d of Object.keys(byDecl).sort()) {
  console.log(`  ${d.padEnd(10)} ${byDecl[d].length}`);
}
console.log('\n  Non-REAL money columns (already exact, or not numbers at all):');
for (const c of cols.filter(c => c.decl !== 'REAL')) {
  console.log(`    ${c.decl.padEnd(9)} ${c.table}.${c.column}`);
}

// ── Row counts, for the tables that hold money ──────────────────────────────
console.log('\n══ 2 · TABLE SIZES ═══════════════════════════════════════════════');
console.log('  (decides whether a backfill is one UPDATE or needs batching)');
const moneyTables = [...new Set(cols.map(c => c.table))].sort();
const rowCount = {};
let biggest = 0;
for (const t of moneyTables) {
  try {
    const n = db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n;
    rowCount[t] = n;
    if (n > biggest) biggest = n;
  } catch (e) { rowCount[t] = null; }
}
for (const t of moneyTables.sort((a, b) => (rowCount[b] || 0) - (rowCount[a] || 0))) {
  if (rowCount[t] === null) { console.log(`  ${String('?').padStart(9)}  ${t}  (unreadable)`); continue; }
  if (rowCount[t] === 0) continue;                     // empty tables are noise here
  console.log(`  ${String(rowCount[t]).padStart(9)}  ${t}`);
}
const empties = moneyTables.filter(t => rowCount[t] === 0).length;
console.log(`  (${empties} money table(s) are empty and not listed)`);
console.log(`\n  Largest money table: ${biggest.toLocaleString('en-US')} rows`);

// ── The actual precision damage ─────────────────────────────────────────────
// A value is clean if it is already a whole number of cents. ROUND(v,2) is the
// test rather than v*100, because v*100 is itself float arithmetic and
// 45.99*100 is 4598.999999999999 — the multiply would manufacture the very
// finding this is trying to measure.
console.log('\n══ 3 · HOW MUCH IS ALREADY NOT A WHOLE NUMBER OF CENTS ════════════');
console.log('  dirty = stored value differs from ROUND(value, 2)');
console.log('  deep  = differs from ROUND(value, 4) — sub-cent content, not a rounding artefact\n');

let totalNonNull = 0, totalDirty = 0, totalDeep = 0;
const offenders = [];
for (const c of cols.filter(c => c.decl === 'REAL')) {
  if (!rowCount[c.table]) continue;
  let r;
  try {
    r = db.prepare(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN "${c.column}" != ROUND("${c.column}", 2) THEN 1 ELSE 0 END) AS dirty,
              SUM(CASE WHEN "${c.column}" != ROUND("${c.column}", 4) THEN 1 ELSE 0 END) AS deep,
              MIN("${c.column}") AS lo, MAX("${c.column}") AS hi
         FROM "${c.table}" WHERE "${c.column}" IS NOT NULL`
    ).get();
  } catch (e) { continue; }
  const n = r.n || 0, dirty = r.dirty || 0, deep = r.deep || 0;
  totalNonNull += n; totalDirty += dirty; totalDeep += deep;
  if (dirty) offenders.push({ ...c, n, dirty, deep, lo: r.lo, hi: r.hi });
}
offenders.sort((a, b) => b.dirty - a.dirty);
if (!offenders.length) {
  console.log('  No stored value in any REAL money column is off a whole cent.');
  console.log('  The drift is therefore all in ARITHMETIC, not in storage — which is');
  console.log('  what the half-cent tolerances are compensating for, and it does not');
  console.log('  make the migration less necessary. It does mean the backfill is safe:');
  console.log('  every value converts to an integer with nothing to round away.');
} else {
  console.log(`  ${'dirty'.padStart(8)} ${'deep'.padStart(7)} ${'of'.padStart(9)}  column`);
  for (const o of offenders) {
    console.log(`  ${String(o.dirty).padStart(8)} ${String(o.deep).padStart(7)} ${String(o.n).padStart(9)}  ${o.table}.${o.column}   [${o.lo} … ${o.hi}]`);
  }
}
console.log(`\n  Totals: ${totalDirty} dirty / ${totalDeep} deep, out of ${totalNonNull} non-null money values.`);
console.log('  A "dirty" value cannot be converted to cents without CHOOSING a rounding.');
console.log('  That choice is the one irreversible decision in the whole migration.');

// ── Unambiguous invariants — no business rules guessed ──────────────────────
console.log('\n══ 4 · BASELINE: what is already inconsistent today ═══════════════');
// An informational count, which is never a failure however large it is.
const note = (label, sql) => {
  try {
    const n = db.prepare(sql).get().n;
    console.log(`  --    ${String(n).padStart(7)}  ${label}`);
    return n;
  } catch (e) {
    console.log(`  skip           ${label}  (${e.message})`);
    return null;
  }
};
const check = (label, sql) => {
  try {
    const n = db.prepare(sql).get().n;
    console.log(`  ${n === 0 ? 'ok  ' : 'FAIL'}  ${String(n).padStart(7)}  ${label}`);
    return n;
  } catch (e) {
    console.log(`  skip           ${label}  (${e.message})`);
    return null;
  }
};
check('payments refunded for more than was paid',
  `SELECT COUNT(*) n FROM retail_payments
    WHERE COALESCE(refunded_amount,0) > COALESCE(amount,0) + 0.005`);
// AGAINST GROSS, NOT AGAINST `total`. This was wrong when first written, and it
// reported two perfectly correct orders as over-refunded. `retail_orders.total`
// is only the CASH portion — what the customer paid with money once points and
// wallet balance were applied. routes/retail.js:32439 orderTenders() gives the
// real ceiling as points_amount + balance_used + total, because a refund sends
// each part back to the tender it came from. So on any order paid partly with
// points or store credit, refunding MORE than `total` is correct.
//
// The check that actually matters is the third one: cash returned must never
// exceed the cash taken, whatever the gross ceiling allows. That is the only one
// of the three where the business is out of pocket.
const GROSS = `(COALESCE(points_amount,0) + COALESCE(balance_used,0) + COALESCE(total,0))`;
check('orders refunded for more than the customer actually tendered',
  `SELECT COUNT(*) n FROM retail_orders
    WHERE COALESCE(refund_amount_paid,0) > ${GROSS} + 0.005`);
check('orders approved to refund more than the customer actually tendered',
  `SELECT COUNT(*) n FROM retail_orders
    WHERE COALESCE(refund_amount_approved,0) > ${GROSS} + 0.005`);
check('CASH returned above the cash actually taken',
  `SELECT COUNT(*) n FROM retail_orders
    WHERE refund_cash_amount IS NOT NULL
      AND refund_cash_amount > COALESCE(total,0) + 0.005`);
check('negative order totals',
  `SELECT COUNT(*) n FROM retail_orders WHERE total < 0`);
// qty is REAL, not INTEGER — weighed goods are sold as 0.35 kg. So this is the
// one place sub-cent amounts are MANUFACTURED rather than stored, and it is the
// most likely source of anything section 3 reports as dirty.
check('order line totals that are not unit_price * qty (to the cent)',
  `SELECT COUNT(*) n FROM retail_order_items
    WHERE line_total IS NOT NULL AND unit_price IS NOT NULL AND qty IS NOT NULL
      AND ABS(line_total - (unit_price * qty)) > 0.005`);
// Informational, NOT a failure: weighed goods are sold by the fraction and a
// shop that sells them is working correctly. It is here because it sizes the
// population where sub-cent line totals can legitimately arise.
note('order lines priced on a fractional quantity (weighed goods — not a fault)',
  `SELECT COUNT(*) n FROM retail_order_items WHERE qty IS NOT NULL AND qty != ROUND(qty, 0)`);

// ── The shipped settlement predicate, run rather than reimplemented ─────────
console.log('\n══ 5 · CHANNEL SETTLEMENT, using the shipped predicate ════════════');
// What channels actually exist here, so the number below has a denominator.
try {
  const mix = db.prepare(
    `SELECT COALESCE(channel,'(null)') c, COUNT(*) n FROM retail_orders GROUP BY 1 ORDER BY n DESC`
  ).all();
  console.log('  orders by channel:');
  for (const m of mix) console.log(`     ${String(m.n).padStart(8)}  ${m.c}`);
} catch (e) { console.log('  (channel mix unreadable: ' + e.message + ')'); }
let settlement = null;
for (const p of [
  process.env.ROOTS_HOME ? path.join(process.env.ROOTS_HOME, 'lib', 'channel-settlement.js') : null,
  path.join(__dirname, '..', 'lib', 'channel-settlement.js'),
  '/root/roots-v2/lib/channel-settlement.js',
]) {
  if (!p) continue;
  try { settlement = require(p); break; } catch (e) { /* try the next path */ }
}
if (!settlement || typeof settlement.settlementGap !== 'function') {
  console.log('  skipped — could not load lib/channel-settlement.js');
} else {
  let rows = [];
  try {
    rows = db.prepare(
      // ELEME ONLY, deliberately. settlementGap is called from exactly one
      // place — routes/eleme-internal.js at ingest — so it encodes eleme's
      // money model. Pointing it at meituan or wechat orders would report
      // "gaps" that are really just a different fee structure, and a false
      // finding here is worse than a missing one.
      `SELECT id, order_no, subtotal, packing_fee, shipping_fee, channel_discount, total, channel
         FROM retail_orders WHERE channel = 'eleme'`
    ).all();
  } catch (e) { console.log('  skipped — ' + e.message); }
  if (rows.length) {
    const gaps = [];
    for (const r of rows) {
      let g = null;
      try { g = settlement.settlementGap(r); } catch (e) { g = { error: e.message }; }
      if (g) gaps.push({ id: r.id, order_no: r.order_no, channel: r.channel, gap: g });
    }
    console.log(`\n  ${rows.length} eleme order(s) examined with the shipped predicate`);
    console.log(`  ${gaps.length} do not settle (${rows.length ? (100 * gaps.length / rows.length).toFixed(1) : '0'}%)`);
    const byShape = {};
    for (const g of gaps) {
      const k = (g.gap && (g.gap.shape || g.gap.kind || g.gap.reason)) || JSON.stringify(g.gap).slice(0, 60);
      byShape[k] = (byShape[k] || 0) + 1;
    }
    for (const k of Object.keys(byShape).sort((a, b) => byShape[b] - byShape[a])) {
      console.log(`     ${String(byShape[k]).padStart(6)}  ${k}`);
    }
    for (const g of gaps.slice(0, 5)) {
      console.log(`     e.g. order ${g.order_no || g.id} (${g.channel}): ${JSON.stringify(g.gap).slice(0, 160)}`);
    }
  } else {
    console.log('  no eleme orders in this database');
  }
}

console.log('\n══ WHAT THIS DOES AND DOES NOT SETTLE ═════════════════════════════');
console.log('  Settles: the column inventory, the table sizes, whether any stored');
console.log('  value needs a rounding decision, and today\'s failure count on five');
console.log('  unambiguous checks plus the shipped settlement predicate.');
console.log('  Does NOT settle: order-total-vs-components and lifetime-spend, which');
console.log('  need the business rules and belong in check_money_invariants.js.');
db.close();
