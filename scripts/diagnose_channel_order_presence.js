#!/usr/bin/env node
/**
 * Which sales channels actually reach `retail_orders`, and since when?
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * §55 carries an open survey question that binds every Finance figure: the
 * Summary counts `retail_orders`, and if a channel's takings land somewhere else
 * — or nowhere — then Tacet's revenue is short with no screen saying so.
 *
 * `diagnose_income_ledger_overlap.js` turned that from a worry into a sighting.
 * Reading June and July 2026 it found ZERO Eleme orders in `retail_orders` while
 * the hand-kept ledger recorded ¥3,682.06 of Eleme in June and ¥2,969.72 in July.
 * A channel the business was demonstrably trading on was absent from the record
 * the Summary adds up.
 *
 * **THAT SIGHTING IS ABOUT JUNE AND JULY, WHICH IS HISTORY. THIS ASKS WHETHER IT
 * IS STILL TRUE**, and the difference is the difference between a note in a
 * decisions document and a live understatement of revenue. A channel missing in
 * June is a migration artefact; the same channel missing last week is a bug that
 * is costing the operator a true number today.
 *
 * ── WHAT IT PRINTS ─────────────────────────────────────────────────────────
 * 1. Every distinct channel the table has EVER held, with its first and last
 *    order — the roster, so a channel that stopped is visible beside one that
 *    never started.
 * 2. A channel × month grid for the last 6 months, so "arrived late", "stopped"
 *    and "never" are three different shapes rather than three readings of one
 *    number.
 * 3. The channels a tenant is CONFIGURED for, where that configuration is
 *    readable, against the channels that produced orders. A channel switched on
 *    and producing nothing is the finding this exists for.
 *
 * Counts are of PAID orders — the Summary's own filter, from lib/finance-window
 * — with a second unfiltered count beside them, because a channel whose orders
 * all sit in some other status is present-but-uncounted, which is a third thing
 * again and would read as absence under a paid-only count.
 *
 * NO CUSTOMER DATA. Channels, statuses, counts, months and money only.
 *
 * Every statement is a SELECT, the database is opened read-only, and the
 * connection is PROVEN read-only before anything else runs.
 *
 * Run: Actions → "Read-only prod query" → script = scripts/diagnose_channel_order_presence.js
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

const { PAID, odateFor, fen } = require(`${HOME}/lib/finance-window`);
const { sqlDayShiftForShop } = require(`${HOME}/lib/business-date`);

const ODATE = odateFor(sqlDayShiftForShop(db));
const money = n => '¥' + fen(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rule = t => console.log('\n' + '─'.repeat(78) + (t ? '\n' + t : ''));

// ── 1 · The roster ─────────────────────────────────────────────────────────
rule('1 · every channel retail_orders has ever held');
const roster = db.prepare(`
  SELECT COALESCE(channel, '(null)') AS channel,
         COUNT(*) AS all_orders,
         SUM(CASE WHEN ${PAID} THEN 1 ELSE 0 END) AS paid_orders,
         COALESCE(SUM(CASE WHEN ${PAID} THEN total ELSE 0 END), 0) AS paid_revenue,
         MIN(${ODATE}) AS first_day, MAX(${ODATE}) AS last_day
    FROM retail_orders
   GROUP BY channel ORDER BY paid_revenue DESC`).all();
console.log('  channel               all    paid        paid revenue   first        last');
for (const r of roster) {
  console.log(`  ${r.channel.padEnd(18)} ${String(r.all_orders).padStart(6)} ${String(r.paid_orders).padStart(6)}  `
    + `${money(r.paid_revenue).padStart(14)}   ${r.first_day}   ${r.last_day}`);
}

// ── 2 · The grid ───────────────────────────────────────────────────────────
// Six months of channel × month. Arrived-late, stopped and never are three
// different shapes here, and a single total would flatten all three.
rule('2 · paid orders by channel and month — the last 6 months');
const grid = db.prepare(`
  SELECT COALESCE(channel, '(null)') AS channel, substr(${ODATE}, 1, 7) AS ym,
         COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue
    FROM retail_orders
   WHERE ${PAID} AND ${ODATE} >= date('now', '-6 months')
   GROUP BY channel, ym`).all();
const months = [...new Set(grid.map(r => r.ym))].sort();
const chans = [...new Set(grid.map(r => r.channel))].sort();
if (!months.length) {
  console.log('  no paid orders in the last 6 months at all.');
} else {
  console.log('  channel           ' + months.map(m => m.padStart(12)).join(''));
  for (const c of chans) {
    const cells = months.map(m => {
      const hit = grid.find(r => r.channel === c && r.ym === m);
      return (hit ? String(hit.orders) : '·').padStart(12);
    });
    console.log('  ' + c.padEnd(16) + cells.join(''));
  }
  console.log('\n  revenue, same grid:');
  for (const c of chans) {
    const cells = months.map(m => {
      const hit = grid.find(r => r.channel === c && r.ym === m);
      return (hit ? money(hit.revenue) : '·').padStart(14);
    });
    console.log('  ' + c.padEnd(16) + cells.join(''));
  }
  console.log('\n  `·` is NO ORDERS AT ALL for that channel that month — not zero revenue.');
}

// ── 3 · Present but uncounted ──────────────────────────────────────────────
// A channel whose orders all sit outside PAID looks identical to an absent one
// under a paid-only count, and is a completely different problem.
rule('3 · orders OUTSIDE the paid filter, last 6 months — present but uncounted');
const unpaid = db.prepare(`
  SELECT COALESCE(channel, '(null)') AS channel, COALESCE(status, '(null)') AS status,
         COUNT(*) AS orders, COALESCE(SUM(total), 0) AS total
    FROM retail_orders
   WHERE NOT (${PAID}) AND ${ODATE} >= date('now', '-6 months')
   GROUP BY channel, status ORDER BY orders DESC`).all();
if (!unpaid.length) {
  console.log('  none — every order in the window is in a counted status.');
} else {
  for (const r of unpaid) {
    console.log(`  ${r.channel.padEnd(16)} ${r.status.padEnd(20)} ${String(r.orders).padStart(6)}  ${money(r.total).padStart(14)}`);
  }
}

// ── 4 · Configured against producing ───────────────────────────────────────
// The roster above says what DID arrive. This asks what was supposed to. A
// channel switched on and producing nothing is the whole point of the script.
rule('4 · channels configured on this box, against channels producing orders');
const tables = db.prepare(
  `SELECT name FROM sqlite_master WHERE type='table' AND name IN
     ('channel_accounts','channel_settings','channels','store_channels')`).all().map(r => r.name);
if (!tables.length) {
  console.log('  no channel configuration table found under the names this script knows');
  console.log('  (channel_accounts, channel_settings, channels, store_channels).');
  console.log('  The roster in section 1 is then the only statement available about');
  console.log('  which channels exist, and absence there cannot be told apart from');
  console.log('  never-configured. Say so rather than inferring.');
} else {
  for (const t of tables) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    console.log(`  ${t}: ${cols.join(', ')}`);
    const chanCol = cols.find(c => /^(channel|platform|provider|type)$/i.test(c));
    if (!chanCol) { console.log('    (no obvious channel column — not guessed at)'); continue; }
    const enabledCol = cols.find(c => /^(enabled|active|is_active|on)$/i.test(c));
    const rows = db.prepare(
      `SELECT ${chanCol} AS channel${enabledCol ? `, ${enabledCol} AS enabled` : ''},
              COUNT(*) AS n FROM ${t} GROUP BY ${chanCol}${enabledCol ? `, ${enabledCol}` : ''}`).all();
    for (const r of rows) {
      const produced = roster.find(x => String(x.channel).toLowerCase() === String(r.channel).toLowerCase());
      const note = produced
        ? `orders through ${produced.last_day}`
        : 'NO ORDERS EVER IN retail_orders';
      console.log(`    ${String(r.channel).padEnd(16)}`
        + (enabledCol ? ` enabled=${String(r.enabled).padEnd(6)}` : '')
        + ` rows=${String(r.n).padStart(3)}   ${note}`);
    }
  }
}

rule();
console.log('read-only. No write was attempted after the probe, and the probe was rejected.');
