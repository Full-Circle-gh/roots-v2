#!/usr/bin/env node
/**
 * Pre-delete verification for the five phantom Eleme rows in retail_orders.
 *
 * Five rows are line items that the pre-b1e2db5 order-locator promoted to
 * orders. Before anything is deleted, this establishes four things against the
 * LIVE database, and it is read-only: it deletes nothing and changes nothing.
 *
 *  (a) Each of the five still matches the description — no line items, no
 *      customer, no stock movement. Any row that fails is named, and the answer
 *      is STOP for that row, not "delete it anyway".
 *  (b) Every row in every OTHER table that references those five order ids.
 *  (c) What deleting them would orphan.
 *  (d) That EL20260831339491 really holds subtotal 135 across 3 priced lines,
 *      so "counted twice" is a claim backed by the row rather than by arithmetic
 *      done elsewhere.
 *
 * HOW REFERENCES ARE FOUND. Not by grepping the schema file, which would only
 * find what someone remembered to declare. Two passes over the LIVE schema:
 *   1. every table's PRAGMA foreign_key_list, keeping those that point at
 *      retail_orders — the declared references;
 *   2. every table's columns, keeping any whose name could hold an order id
 *      (order_id, retail_order_id, ref_id beside a ref_table, …) — the
 *      UNDECLARED references, which is where a delete actually goes wrong. This
 *      codebase has several deliberate non-FK audit columns (retail_stock_ledger
 *      .ref_id / .ref_table among them), so pass 2 is the one that matters.
 * Both passes then COUNT ACTUAL ROWS against the five ids, so the report
 * distinguishes "a column that could reference them" from "a row that does".
 *
 * NO CUSTOMER DATA beyond what identifies a reference: table names, column
 * names, row counts, ids, and the money already known from the survey.
 *
 * Every statement is a SELECT or a PRAGMA, the database is opened read-only, and
 * the connection is PROVEN read-only before anything else runs.
 *
 * Run: Actions → "Read-only prod query" → script = scripts/diagnose_phantom_order_refs.js
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
console.log('db: ' + DB_PATH);
console.log('now: ' + new Date().toISOString() + '\n');

// The five, addressed by the ONE thing that identifies them unambiguously: the
// food id stored as their eleme_order_id. Order numbers and retail_orders ids
// are both quoted in the brief, and both are checked against this, so a
// mismatch between the three is caught here rather than assumed away.
const FOOD_IDS = [
  '2000001755518659', '2000001755174220',
  '2000001755025071', '2000001755039997', '2000001755697753',
];
const EXPECT_NO = {
  '2000001755518659': 'EL20260830933393',
  '2000001755174220': 'EL20260830921999',
  '2000001755025071': 'EL20260831895225',
  '2000001755039997': 'EL20260831559705',
  '2000001755697753': 'EL20260831335758',
};
const REAL_ORDER_NO = 'EL20260831339491';   // must NOT be touched
const OTHER_REAL_NO = 'EL20260901417897';   // must NOT be touched

// ── Resolve the five to retail_orders ids ──────────────────────────────────
const resolved = [];
for (const fid of FOOD_IDS) {
  const row = db.prepare(`
    SELECT o.id, o.order_no, o.channel, o.status, o.subtotal, o.total, o.store_id,
           o.customer_id, o.placed_at, o.paid_at, o.channel_settle_amount,
           o.channel_stock_restored, o.needs_invoice, o.voucher_code,
           i.id AS import_id, i.eleme_order_id, i.imported_at, i.status AS import_status
      FROM eleme_order_import i
      LEFT JOIN retail_orders o ON o.id = i.retail_order_id
     WHERE i.eleme_order_id = ?
  `).get(fid);
  resolved.push({ fid, row });
}

console.log('══ (a) Do the five still match the description? ════════════════\n');
const targetIds = [];
let stop = false;
for (const { fid, row } of resolved) {
  if (!row || row.id == null) {
    console.log(`  ${fid}: NO retail_orders row found (import row ${row ? row.import_id : 'missing too'}) — nothing to delete`);
    continue;
  }
  const lines = db.prepare('SELECT COUNT(*) AS n FROM retail_order_items WHERE order_id = ?').get(row.id).n;
  const priced = db.prepare('SELECT COUNT(*) AS n FROM retail_order_items WHERE order_id = ? AND line_total > 0').get(row.id).n;
  const ledger = db.prepare(
    "SELECT COUNT(*) AS n FROM retail_stock_ledger WHERE ref_table = 'retail_orders' AND ref_id = ?"
  ).get(row.id).n;
  // A ledger row can also be written with a bare note naming the order, so the
  // order NUMBER is searched too — a movement that names the order but does not
  // key on it still counts as a stock movement.
  const ledgerByNote = db.prepare(
    'SELECT COUNT(*) AS n FROM retail_stock_ledger WHERE note LIKE ?'
  ).get('%' + fid + '%').n;

  const noMatch = row.order_no !== EXPECT_NO[fid];
  const problems = [];
  if (lines > 0)                 problems.push(`HAS ${lines} LINE ITEM(S)`);
  if (row.customer_id != null)   problems.push(`HAS customer_id=${row.customer_id}`);
  if (ledger > 0)                problems.push(`HAS ${ledger} STOCK LEDGER ROW(S) by ref`);
  if (ledgerByNote > 0)          problems.push(`HAS ${ledgerByNote} STOCK LEDGER ROW(S) naming it`);
  if (row.channel !== 'eleme')   problems.push(`channel is '${row.channel}', not eleme`);
  if (noMatch)                   problems.push(`order_no is ${row.order_no}, brief says ${EXPECT_NO[fid]}`);
  if (problems.length) stop = true; else targetIds.push(row.id);

  console.log(`  ${fid} → retail_orders id ${row.id} (${row.order_no})`);
  console.log(`     status=${row.status} channel=${row.channel} subtotal=${row.subtotal} total=${row.total}`);
  console.log(`     line_items=${lines} (priced ${priced})  customer_id=${row.customer_id}  store_id=${row.store_id}`);
  console.log(`     channel_settle_amount=${row.channel_settle_amount}  channel_stock_restored=${row.channel_stock_restored}  needs_invoice=${row.needs_invoice}  voucher_code=${row.voucher_code}`);
  console.log(`     stock ledger rows: by ref=${ledger}, naming the id in a note=${ledgerByNote}`);
  console.log(`     import row id=${row.import_id} imported_at=${row.imported_at} import_status=${row.import_status}`);
  console.log(`     VERDICT: ${problems.length ? '*** STOP — ' + problems.join('; ') + ' ***' : 'matches the description — safe to consider'}`);
  console.log('');
}
console.log(`  ${targetIds.length} of ${FOOD_IDS.length} row(s) match; ids: [${targetIds.join(', ')}]`);
if (stop) console.log('  *** AT LEAST ONE ROW FAILED — see STOP above ***');
console.log('');

// ── (b) Everything in the schema that could reference an order ─────────────
console.log('══ (b) Every table referencing these five order ids ════════════\n');

const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all().map(r => r.name);
console.log(`  ${tables.length} table(s) in the schema.\n`);

const idList = targetIds.length ? targetIds.join(',') : '-1';
const declared = [];   // { table, column } from PRAGMA foreign_key_list
const candidate = [];  // { table, column } by name, no declared FK

for (const t of tables) {
  let fks = [];
  try { fks = db.prepare(`PRAGMA foreign_key_list("${t}")`).all(); } catch (e) { /* view-ish */ }
  for (const fk of fks) {
    if (String(fk.table).toLowerCase() === 'retail_orders') declared.push({ table: t, column: fk.from, onDelete: fk.on_delete });
  }
  let cols = [];
  try { cols = db.prepare(`PRAGMA table_info("${t}")`).all(); } catch (e) { continue; }
  const declaredCols = new Set(declared.filter(d => d.table === t).map(d => d.column));
  for (const c of cols) {
    const n = String(c.name).toLowerCase();
    if (declaredCols.has(c.name)) continue;
    if (t === 'retail_orders' && n === 'id') continue;
    // Names that could hold a retail_orders id.
    if (n === 'order_id' || n === 'retail_order_id' || n === 'ref_id'
        || n === 'source_order_id' || n === 'parent_order_id' || n === 'related_order_id') {
      candidate.push({ table: t, column: c.name });
    }
  }
}

console.log('── declared foreign keys pointing at retail_orders ───────────');
if (!declared.length) console.log('   (none)');
for (const d of declared) {
  const n = db.prepare(`SELECT COUNT(*) AS n FROM "${d.table}" WHERE "${d.column}" IN (${idList})`).get().n;
  console.log(`   ${String(d.table).padEnd(30)} ${String(d.column).padEnd(20)} ON DELETE ${String(d.onDelete).padEnd(10)} rows matching the five: ${n}`);
}
console.log('');

console.log('── undeclared columns that could hold an order id ────────────');
if (!candidate.length) console.log('   (none)');
for (const c of candidate) {
  let n = 0, detail = '';
  try {
    // ref_id is only an order reference when its ref_table says so.
    const cols = db.prepare(`PRAGMA table_info("${c.table}")`).all().map(x => x.name);
    if (c.column === 'ref_id' && cols.includes('ref_table')) {
      n = db.prepare(`SELECT COUNT(*) AS n FROM "${c.table}" WHERE ref_table = 'retail_orders' AND ref_id IN (${idList})`).get().n;
      detail = " (scoped by ref_table='retail_orders')";
    } else {
      n = db.prepare(`SELECT COUNT(*) AS n FROM "${c.table}" WHERE "${c.column}" IN (${idList})`).get().n;
    }
  } catch (e) { detail = ' (query failed: ' + e.message.slice(0, 60) + ')'; }
  console.log(`   ${String(c.table).padEnd(30)} ${String(c.column).padEnd(20)} rows matching the five: ${n}${detail}`);
}
console.log('');

// Anything that stores the order NUMBER rather than the id, or names it in text.
console.log('── rows naming the five by ORDER NUMBER or food id ───────────');
const nos = FOOD_IDS.map(f => EXPECT_NO[f]);
for (const t of tables) {
  let cols = [];
  try { cols = db.prepare(`PRAGMA table_info("${t}")`).all(); } catch (e) { continue; }
  const textCols = cols.filter(c => /TEXT|CHAR|CLOB/i.test(String(c.type || '')) || c.type === '').map(c => c.name);
  for (const col of textCols) {
    const parts = nos.concat(FOOD_IDS).map(() => `"${col}" LIKE ?`).join(' OR ');
    const args = nos.concat(FOOD_IDS).map(v => '%' + v + '%');
    let n = 0;
    try { n = db.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE ${parts}`).get(...args).n; } catch (e) { continue; }
    if (n > 0) console.log(`   ${String(t).padEnd(30)} ${String(col).padEnd(24)} ${n} row(s) mention one of them`);
  }
}
console.log('');

// ── (c) Orphans a delete would leave ───────────────────────────────────────
console.log('══ (c) What a delete would orphan ══════════════════════════════\n');
console.log('   Any row counted above under a column WITHOUT "ON DELETE CASCADE"');
console.log('   survives its parent and becomes an orphan. Counts are printed above;');
console.log('   a zero there means nothing to orphan from that table.');
console.log('');
console.log('── the import + log rows for these five ──────────────────────');
for (const fid of FOOD_IDS) {
  const imp = db.prepare('SELECT id, retail_order_id, store_code, status, imported_at FROM eleme_order_import WHERE eleme_order_id = ?').get(fid);
  const logs = db.prepare("SELECT COUNT(*) AS n FROM eleme_sync_log WHERE detail LIKE ?").get('%' + fid + '%').n;
  console.log(`   ${fid}: eleme_order_import id=${imp ? imp.id : '-'} retail_order_id=${imp ? imp.retail_order_id : '-'} status=${imp ? imp.status : '-'} | eleme_sync_log rows mentioning it: ${logs}`);
}
console.log('');

// ── (d) The real order the three 31 Aug phantoms duplicate ─────────────────
console.log('══ (d) The real order EL20260831339491 ═════════════════════════\n');
for (const no of [REAL_ORDER_NO, OTHER_REAL_NO]) {
  const r = db.prepare(`
    SELECT o.id, o.order_no, o.status, o.subtotal, o.total, o.customer_id,
           o.channel_commission, o.channel_settle_amount,
           i.eleme_order_id, i.imported_at
      FROM retail_orders o LEFT JOIN eleme_order_import i ON i.retail_order_id = o.id
     WHERE o.order_no = ?
  `).get(no);
  if (!r) { console.log(`   ${no}: NOT FOUND`); continue; }
  const items = db.prepare('SELECT id, name_en, name_cn, qty, unit_price, line_total FROM retail_order_items WHERE order_id = ?').all(r.id);
  const priced = items.filter(i => Number(i.line_total) > 0);
  const sum = Math.round(priced.reduce((a, i) => a + Number(i.line_total), 0) * 100) / 100;
  console.log(`   ${no} → retail_orders id ${r.id}`);
  console.log(`      eleme_order_id=${r.eleme_order_id} imported_at=${r.imported_at} status=${r.status}`);
  console.log(`      subtotal=${r.subtotal} total=${r.total} commission=${r.channel_commission} income=${r.channel_settle_amount}`);
  console.log(`      line items: ${items.length} (${priced.length} priced), line_total sum = ${sum}`);
  for (const it of items) console.log(`         qty=${it.qty} unit_price=${it.unit_price} line_total=${it.line_total}`);
}
console.log('');
// The duplication claim, stated as arithmetic against the rows themselves.
const three = resolved.filter(x => ['2000001755025071', '2000001755039997', '2000001755697753'].includes(x.fid) && x.row);
const threeSum = Math.round(three.reduce((a, x) => a + (Number(x.row.total) || 0), 0) * 100) / 100;
const real = db.prepare('SELECT subtotal, total FROM retail_orders WHERE order_no = ?').get(REAL_ORDER_NO);
console.log(`   the three 31 Aug phantoms total ${threeSum}; ${REAL_ORDER_NO} subtotal is ${real ? real.subtotal : '(missing)'} → ${real && Math.abs(threeSum - Number(real.subtotal)) <= 0.011 ? 'MATCH — they are its lines' : 'NO MATCH'}`);
console.log('');

// ── before-totals, for the after-comparison ────────────────────────────────
console.log('══ Before-totals (for comparison after any delete) ═════════════\n');
const win = db.prepare(`
  SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total, COALESCE(SUM(subtotal),0) AS subtotal
    FROM retail_orders
   WHERE channel = 'eleme' AND DATE(COALESCE(placed_at, paid_at)) BETWEEN '2026-08-30' AND '2026-09-01'
`).get();
const all = db.prepare(`
  SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total, COALESCE(SUM(subtotal),0) AS subtotal
    FROM retail_orders WHERE channel = 'eleme'
`).get();
console.log(`   eleme rows, 30 Aug – 1 Sep : count=${win.n}  SUM(total)=${win.total}  SUM(subtotal)=${win.subtotal}`);
console.log(`   eleme rows, all time       : count=${all.n}  SUM(total)=${all.total}  SUM(subtotal)=${all.subtotal}`);
console.log(`   eleme_order_import rows    : ${db.prepare('SELECT COUNT(*) AS n FROM eleme_order_import').get().n}`);
console.log(`   eleme_sync_log rows        : ${db.prepare('SELECT COUNT(*) AS n FROM eleme_sync_log').get().n}`);
