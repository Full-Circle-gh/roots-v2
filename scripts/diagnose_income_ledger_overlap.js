#!/usr/bin/env node
/**
 * Does the ORDER RECORD cover the period the income ledger was covering?
 *
 * ── THE QUESTION, AND WHY IT IS NOT A MATTER OF OPINION ─────────────────────
 * `income_entries` holds 26 rows, 13 June to 31 July 2026, ¥239,841.06. Eleven
 * of them are month-end per-channel totals — the description is literally `6月`
 * or `7月`, the category is a channel, the date is the last day of the month —
 * and they come to ¥224,591.68.
 *
 * §36's *Settlement receipts are excluded from Finance entirely* says a platform
 * payout is money the order record ALREADY counted, and §55 puts `income_entries`
 * on the staircase as a summand. Those two cannot both hold for these rows, and
 * §55 records the collision unresolved, naming ¥151,895.69 — which is the two
 * Mini App rows only. The other nine were never counted. The real exposure is
 * ¥224,591.68, and this script is how that stops being an estimate.
 *
 * **EVERYTHING TURNS ON ONE FACT NOBODY HAS MEASURED: whether `retail_orders`
 * holds June and July.**
 *
 *   IF IT DOES — the eleven rows restate revenue the Summary already counts, and
 *   summing money in would double-count ¥224,591.68.
 *
 *   IF IT DOES NOT — the eleven rows are the ONLY record of June and July trading,
 *   and excluding them would delete the shop's history to fix a double count that
 *   was never there.
 *
 * Those lead to opposite work. Guessing between them is guessing with ¥224,591.68,
 * so this reads it instead.
 *
 * ── WHY IT IMPORTS RATHER THAN RE-DERIVES ──────────────────────────────────
 * `PAID` and `odateFor` come from lib/finance-window.js and the day shift from
 * lib/business-date.js — the same expressions routes/finance-summary.js uses for
 * the Revenue line. A comparison against a hand-written date filter would answer
 * a question nobody asked: the point is what the SUMMARY would show, not what a
 * plausible query returns. Under the ro-query workflow these load from the staged
 * CHECKOUT, so the comparison is against the code as it stands here.
 *
 * NO CUSTOMER DATA. Channels, statuses, counts, dates and money only. No name,
 * phone, address, note or order number is selected or printed. The ledger's
 * `description` IS printed for the eleven month-end rows, because it is the
 * month marker (`6月`) that identifies them and it carries nothing personal —
 * every other ledger description is aggregated away.
 *
 * Every statement is a SELECT, the database is opened read-only, and the
 * connection is PROVEN read-only before anything else runs.
 *
 * Run: Actions → "Read-only prod query" → script = scripts/diagnose_income_ledger_overlap.js
 *   or, on the box:  node scripts/diagnose_income_ledger_overlap.js
 */
'use strict';

const path = require('path');
const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const Database = require(`${HOME}/node_modules/better-sqlite3`);

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

const { PAID, odateFor, fen } = require(`${HOME}/lib/finance-window`);
const { sqlDayShiftForShop } = require(`${HOME}/lib/business-date`);

// The Summary's own day boundary, resolved the same way the route resolves it.
const SHIFT = sqlDayShiftForShop(db);
const ODATE = odateFor(SHIFT);
console.log('day shift: ' + SHIFT);
console.log('order date expression: ' + ODATE);

const money = n => '¥' + fen(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rule = t => console.log('\n' + '─'.repeat(78) + (t ? '\n' + t : ''));

// ── 1 · When does the order record actually begin? ─────────────────────────
// The whole question in one table. A month with orders in it is a month the
// ledger's own row for that month is restating.
rule('1 · retail_orders by month — every month the record holds, PAID only');
const byMonth = db.prepare(`
  SELECT substr(${ODATE}, 1, 7) AS ym, COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue
    FROM retail_orders
   WHERE ${PAID}
   GROUP BY ym ORDER BY ym`).all();
if (!byMonth.length) {
  console.log('  NO PAID ORDERS AT ALL. That is the answer to everything below.');
} else {
  console.log('  month     orders        revenue');
  for (const r of byMonth) {
    console.log(`  ${r.ym}  ${String(r.orders).padStart(6)}  ${money(r.revenue).padStart(14)}`);
  }
  console.log(`  earliest: ${byMonth[0].ym}   latest: ${byMonth[byMonth.length - 1].ym}`);
}

// ── 2 · June and July, per channel, the way the Summary counts ─────────────
rule('2 · retail_orders for 2026-06-01 … 2026-07-31, per channel');
const perChannel = db.prepare(`
  SELECT substr(${ODATE}, 1, 7) AS ym, COALESCE(channel, '(null)') AS channel,
         COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue
    FROM retail_orders
   WHERE ${PAID} AND ${ODATE} BETWEEN ? AND ?
   GROUP BY ym, channel ORDER BY ym, revenue DESC`).all('2026-06-01', '2026-07-31');
if (!perChannel.length) {
  console.log('  NOTHING. The order record does not cover June or July 2026.');
} else {
  console.log('  month     channel                orders        revenue');
  for (const r of perChannel) {
    console.log(`  ${r.ym}  ${r.channel.padEnd(20)}  ${String(r.orders).padStart(6)}  ${money(r.revenue).padStart(14)}`);
  }
}

// ── 3 · Every status, not only the paid ones ───────────────────────────────
// A month can look empty under PAID and be full of orders in another status.
// That is a different finding from an empty month and must not read as one.
rule('3 · the same window with NO status filter — is anything there at all?');
const anyStatus = db.prepare(`
  SELECT COALESCE(status, '(null)') AS status, COUNT(*) AS orders,
         COALESCE(SUM(total), 0) AS total
    FROM retail_orders
   WHERE ${ODATE} BETWEEN ? AND ?
   GROUP BY status ORDER BY orders DESC`).all('2026-06-01', '2026-07-31');
if (!anyStatus.length) {
  console.log('  No rows in that window in ANY status.');
} else {
  for (const r of anyStatus) {
    console.log(`  ${r.status.padEnd(24)} ${String(r.orders).padStart(6)}  ${money(r.total).padStart(14)}`);
  }
}

// ── 4 · The ledger's month-end rows ────────────────────────────────────────
rule('4 · income_entries — the month-end channel totals');
const monthEnd = db.prepare(`
  SELECT date, amount, category, description
    FROM income_entries
   WHERE trim(description) IN ('6月', '7月')
   ORDER BY date, amount DESC`).all();
let monthEndTotal = 0;
for (const r of monthEnd) {
  monthEndTotal = fen(monthEndTotal + r.amount);
  console.log(`  ${r.date}  ${money(r.amount).padStart(14)}  ${r.description}  ${r.category || '(no category)'}`);
}
console.log(`  ${monthEnd.length} rows   TOTAL ${money(monthEndTotal)}`);

rule('5 · income_entries — everything else, and the whole table');
const rest = db.prepare(`
  SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total
    FROM income_entries WHERE trim(description) NOT IN ('6月', '7月') OR description IS NULL`).get();
const whole = db.prepare(`
  SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total,
         MIN(date) AS first, MAX(date) AS last FROM income_entries`).get();
console.log(`  other rows : ${rest.n} rows, ${money(rest.total)}`);
console.log(`  whole table: ${whole.n} rows, ${money(whole.total)}   ${whole.first} … ${whole.last}`);

// Is `channel` — the column the write path never fills — populated on anything?
const chan = db.prepare(`
  SELECT COALESCE(channel, '(null)') AS channel, COUNT(*) AS n
    FROM income_entries GROUP BY channel ORDER BY n DESC`).all();
console.log('  income_entries.channel:');
for (const r of chan) console.log(`    ${r.channel.padEnd(24)} ${r.n}`);

// ── 6 · The comparison, said plainly ───────────────────────────────────────
rule('6 · THE ANSWER');
// PER MONTH, NOT ONLY THE LUMP. A record that begins mid-window is the case a
// single ratio hides: June empty and July complete averages to "about half",
// which is true of the pair and true of neither month. The two months are asked
// separately and the verdict is only allowed to be simple when they agree.
const ordersInWindow = perChannel.reduce((t, r) => fen(t + r.revenue), 0);
const orderCount = perChannel.reduce((t, r) => t + r.orders, 0);
console.log(`  orders  1 Jun – 31 Jul, PAID : ${orderCount} orders, ${money(ordersInWindow)}`);
console.log(`  ledger  month-end channel rows: ${monthEnd.length} rows,  ${money(monthEndTotal)}`);

console.log('\n  month     order revenue      ledger rows        ledger ÷ orders');
const verdicts = [];
for (const ym of ['2026-06', '2026-07']) {
  const ord = perChannel.filter(r => r.ym === ym)
    .reduce((t, r) => ({ n: t.n + r.orders, v: fen(t.v + r.revenue) }), { n: 0, v: 0 });
  const led = monthEnd.filter(r => String(r.date).startsWith(ym))
    .reduce((t, r) => fen(t + r.amount), 0);
  const pct = ord.v > 0 ? (led / ord.v) : null;
  console.log(`  ${ym}  ${money(ord.v).padStart(14)} (${String(ord.n).padStart(4)})  ${money(led).padStart(14)}   `
    + (pct === null ? 'no orders to compare' : (pct * 100).toFixed(1) + '%'));
  verdicts.push({ ym, orders: ord.n, orderRev: ord.v, ledger: led, pct });
}

const covered = verdicts.filter(v => v.orders > 0);
console.log('');
if (!covered.length) {
  console.log('  → THE ORDER RECORD DOES NOT COVER THIS PERIOD AT ALL.');
  console.log('    The ledger rows are the only record of June/July trading. Excluding');
  console.log('    or zeroing them would delete history, not fix a double count.');
} else if (covered.length < verdicts.length) {
  console.log('  → THE ORDER RECORD COVERS THIS PERIOD ONLY IN PART.');
  console.log(`    Covered: ${covered.map(v => v.ym).join(', ')}. The rest has no paid orders.`);
  console.log('    The two halves need different treatment and one rule cannot serve both —');
  console.log('    read the per-month table above rather than any single figure.');
} else {
  const near = verdicts.every(v => v.pct !== null && v.pct > 0.8 && v.pct < 1.25);
  console.log(`  → THE ORDER RECORD COVERS BOTH MONTHS (${orderCount} paid orders).`);
  if (near) {
    console.log('    Each month\'s ledger rows are close to that month\'s order revenue, so they');
    console.log('    restate revenue already counted: summing money in would double-count them.');
  } else {
    console.log('    BUT THE MONTHLY FIGURES DO NOT LINE UP CLOSELY, so "the same money twice" is');
    console.log('    NOT established by this run. Some of the difference is expected — a payout');
    console.log('    is net of platform commission while an order total is gross — but the gap');
    console.log('    has to be explained before anything is excluded on the strength of it.');
  }
}
console.log('\n  Either way NOTHING IS WRONG ON A SCREEN TODAY: routes/finance-summary.js');
console.log('  never reads income_entries, so no total in production includes these rows.');

rule();
console.log('read-only. No write was attempted after the probe, and the probe was rejected.');
