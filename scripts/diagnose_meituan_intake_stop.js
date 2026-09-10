#!/usr/bin/env node
/**
 * Meituan orders fell 97% across the cutover. Did intake STOP, or did trade fall?
 *
 * ── THE SIGHTING ───────────────────────────────────────────────────────────
 * §89 records it open: 158 paid Meituan orders in July, 38 in August, 5 in
 * September, while `wechat` and `gzgrocery` grew over the same period. It may be
 * an ordinary commercial fact — a storefront closed, a platform paused — and it
 * may be a sync that stopped working. §89 declines to say which, and so does
 * this script.
 *
 * ── WHAT THIS CAN AND CANNOT SETTLE, SAID FIRST ────────────────────────────
 * **IT CANNOT SETTLE INTENT, AND NOTHING IN THIS DATABASE CAN.** Whether orders
 * exist on Meituan's side that never reached us is a question about Meituan's
 * records, not ours. That limit is stated here because the last open item in §89
 * — the `shop` channel — was read with total confidence off numbers that were
 * accurate and turned out to mean something else entirely. It was testing before
 * a shop opened, and no column said so. The same trap is set here.
 *
 * WHAT IT CAN SETTLE IS THE SHAPE, AND THE SHAPE IS DIAGNOSTIC:
 *
 *   · A CLIFF — many orders a day, then zero from one day on, with no taper —
 *     is a switch being thrown. Either the platform stopped sending or we
 *     stopped receiving, and a business does not decline in one step.
 *   · A TAPER — a decline over weeks — is trade, or a listing losing rank.
 *     Nobody flipped anything.
 *   · ONE STORE OF TWO going quiet while the other continues is a storefront
 *     decision, not an integration failure: a broken intake path does not know
 *     which shop it is dropping.
 *
 * ── THE CONTROL SERIES IS THE POINT ────────────────────────────────────────
 * Eleme and gzgrocery are printed on the same days beside Meituan, and they are
 * what makes the reading mean anything. If every platform stops on the same day
 * it is infrastructure — a daemon, a token, a box — and Meituan is not the
 * finding. If only Meituan stops while the others keep arriving, whatever
 * happened happened to Meituan alone. A single series cannot tell those apart
 * and would be read as though it could.
 *
 * NO CUSTOMER DATA. Dates, counts, money, store ids and channels only.
 *
 * Every statement is a SELECT, the database is opened read-only, and the
 * connection is PROVEN read-only before anything else runs.
 *
 * Run: Actions → "Read-only prod query" → script = scripts/diagnose_meituan_intake_stop.js
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
const money = n => '¥' + fen(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rule = t => console.log('\n' + '─'.repeat(78) + (t ? '\n' + t : ''));

// ── 1 · The three series, same days, side by side ──────────────────────────
rule('1 · orders per day — Meituan against its controls (all statuses)');
const daily = db.prepare(`
  SELECT ${ODATE} AS day, COALESCE(channel, '(null)') AS ch, COUNT(*) AS n
    FROM retail_orders
   WHERE channel IN ('meituan', 'eleme', 'gzgrocery', 'wechat')
     AND ${ODATE} >= date('now', '-100 days')
   GROUP BY day, ch ORDER BY day`).all();
const days = [...new Set(daily.map(r => r.day))].sort();
const at = (d, c) => { const h = daily.find(r => r.day === d && r.ch === c); return h ? h.n : 0; };
if (!days.length) {
  console.log('  no orders in the last 100 days on any of these channels.');
} else {
  console.log('  day          meituan     eleme  gzgrocery     wechat');
  for (const d of days) {
    const m = at(d, 'meituan');
    console.log(`  ${d}  ${String(m).padStart(7)}${m === 0 ? ' ·' : '  '} ${String(at(d, 'eleme')).padStart(7)} ${String(at(d, 'gzgrocery')).padStart(9)} ${String(at(d, 'wechat')).padStart(9)}`);
  }
  console.log('\n  A `·` marks a Meituan-silent day. Read the COLUMN, not the row: the');
  console.log('  question is whether meituan goes quiet while the others do not.');
}

// ── 2 · The last one, and how long the silence is ──────────────────────────
rule('2 · the last order on each channel');
const last = db.prepare(`
  SELECT COALESCE(channel, '(null)') AS ch, MAX(${ODATE}) AS last_day, COUNT(*) AS total
    FROM retail_orders GROUP BY channel ORDER BY last_day DESC`).all();
for (const r of last) {
  const gap = db.prepare(`SELECT CAST(julianday('now') - julianday(?) AS INTEGER) AS d`).get(r.last_day);
  console.log(`  ${r.ch.padEnd(14)} last ${r.last_day}   ${String(gap.d).padStart(3)} days ago   ${String(r.total).padStart(5)} orders all time`);
}

// ── 3 · One store or both? ─────────────────────────────────────────────────
// The ledger recorded Meituan-Yuexiu AND Meituan-Tianhe in June, but only
// Meituan-Yuexiu in July — so a storefront may already have gone before the
// window §89 measured. A broken intake path does not know which shop it is
// dropping; a closure does.
rule('3 · Meituan by store, per month');
const byStore = db.prepare(`
  SELECT substr(${ODATE}, 1, 7) AS ym, COALESCE(store_id, 0) AS store_id,
         COUNT(*) AS n, COALESCE(SUM(CASE WHEN ${PAID} THEN total ELSE 0 END), 0) AS paid_value
    FROM retail_orders WHERE channel = 'meituan'
   GROUP BY ym, store_id ORDER BY ym, store_id`).all();
if (!byStore.length) {
  console.log('  no meituan orders at all.');
} else {
  console.log('  month     store        orders     paid value');
  for (const r of byStore) {
    console.log(`  ${r.ym}  ${String(r.store_id).padStart(5)}  ${String(r.n).padStart(10)}  ${money(r.paid_value).padStart(13)}`);
  }
}

// ── 4 · What the stores say about themselves ───────────────────────────────
// Columns are read only where they exist. A missing column is a schema
// difference, not a finding.
rule('4 · the stores');
const cols = db.prepare('PRAGMA table_info(retail_stores)').all().map(c => c.name);
const want = ['id', 'code', 'name_en', 'name_cn', 'is_active', 'timezone'].filter(c => cols.includes(c));
console.log('  retail_stores columns: ' + cols.join(', '));
if (want.includes('id')) {
  for (const r of db.prepare(`SELECT ${want.join(', ')} FROM retail_stores ORDER BY id`).all()) {
    console.log('  ' + want.map(c => `${c}=${r[c]}`).join('  '));
  }
}

// ── 5 · Is anything queued and not arriving? ───────────────────────────────
// If an intake path broke, a queue or an error log is where it shows. Read only
// if such a table exists — naming one that does not would invent the finding.
rule('5 · queues and errors, where a table for them exists');
const tabs = db.prepare(
  `SELECT name FROM sqlite_master WHERE type='table'
    AND (name LIKE '%queue%' OR name LIKE '%sync%' OR name LIKE '%error%' OR name LIKE '%webhook%')`).all().map(r => r.name);
if (!tabs.length) {
  console.log('  no queue / sync / error / webhook table found. This script then has');
  console.log('  nothing to say about whether an intake path is failing, and says so');
  console.log('  rather than reading the silence as health.');
} else {
  for (const t of tabs) {
    const tc = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    const tsCol = ['created_at', 'updated_at', 'ts', 'occurred_at'].find(c => tc.includes(c));
    const latest = tsCol ? db.prepare(`SELECT MAX(${tsCol}) AS m FROM ${t}`).get().m : null;
    console.log(`  ${t.padEnd(34)} ${String(n).padStart(7)} rows` + (latest ? `   latest ${tsCol}=${latest}` : ''));
  }
}

rule('WHAT THIS RUN CAN SUPPORT');
console.log('  A cliff on one day, with the control channels still arriving, means a');
console.log('  switch was thrown — and does NOT say by whom or why.');
console.log('  A taper means trade, and needs no fix.');
console.log('  One store quiet while another continues is a storefront decision.');
console.log('  All channels stopping together is infrastructure, and Meituan is a symptom.');
console.log('\n  WHETHER ORDERS EXIST ON MEITUAN THAT NEVER REACHED US IS NOT IN THIS');
console.log('  DATABASE. That answer is on the merchant console, or from a person.');

rule();
console.log('read-only. No write was attempted after the probe, and the probe was rejected.');
