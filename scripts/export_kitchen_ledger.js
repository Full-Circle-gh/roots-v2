#!/usr/bin/env node
/**
 * Export the kitchen app's finance ledger to two CSV files.
 *
 * READ-ONLY. THIS SCRIPT CANNOT WRITE TO THE DATABASE. It opens its own
 * handle with better-sqlite3's `readonly: true` and asserts `db.readonly`
 * before reading a single row; a write attempted through this handle throws
 * at the SQLite layer rather than being caught by a convention someone can
 * forget. It deliberately does NOT `require('../database.js')` — that module
 * runs `schema.exec()` and a long list of ALTER TABLEs at require time, so
 * merely importing it writes.
 *
 *   node scripts/export_kitchen_ledger.js
 *   node scripts/export_kitchen_ledger.js --out /root/backups
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 * decisions §36, "Tacet's Finance begins on 1 August 2026, and the kitchen
 * app's ledger is exported rather than migrated". Nothing is deleted and
 * nothing is migrated; Tacet's Finance simply counts from 1 August 2026
 * forward. That leaves the rows before the cutover reachable by nothing once
 * the kitchen app is retired — present in the database, openable by nobody.
 * This file is what makes "still readable" true rather than nominal: a
 * spreadsheet of both ledger tables in full, handed to the operator and their
 * accountant, readable with no access to this system.
 *
 * ── WHAT IT DOES NOT DO ───────────────────────────────────────────────────
 * No filtering, no summarising, no rounding, no cleaning. Every row of
 * `income_entries` and every row of `expense_entries`, every column of each.
 * The cutover date does NOT appear in any query in this file: the export is
 * the whole table, because a partial archive of money is not an archive.
 *
 * AMOUNTS ARE WRITTEN EXACTLY AS STORED. Some expense rows carry sub-cent
 * values written by the PO poster (a PO's line costs divided across expense
 * categories, landing on values like 602.6800000000001). Those digits are the
 * record. `String(n)` is used rather than `toFixed(2)` or any locale
 * formatter, because it emits the shortest decimal that round-trips to the
 * identical IEEE-754 double — the stored value, not a rendering of it. A
 * `Sub-cent amount?` column flags them so they can be found in the sheet
 * without hunting, and the receipt counts them.
 *
 * HOW MANY THERE ARE IS NOT FIXED, AND THIS FILE DELIBERATELY DOES NOT SAY.
 * The poster writes one whenever a purchase order's line costs divide
 * unevenly across its categories, so the count rises with every received PO:
 * a survey found 7 on 2026-08-04, and the export returned 25 on 2026-09-01.
 * Those two are dated measurements, not a target. The receipt's figure is the
 * answer for the run that printed it, and checking it against a number frozen
 * in this comment would only ever catch the comment going stale.
 *
 * ── COLUMNS ARE DISCOVERED, NOT ASSUMED ───────────────────────────────────
 * The column list comes from `PRAGMA table_info` at run time, so a column
 * added by a migration this file has never heard of is still exported, under
 * its raw name. HEADERS maps the columns we know to something a person can
 * read without the schema open; anything unmapped falls through named as the
 * database names it. "All columns" is therefore literal rather than a list
 * that was accurate when this was written.
 *
 * ── THE PO JOIN ───────────────────────────────────────────────────────────
 * An expense row carrying a `po_id` was posted by Purchasing, and its
 * description reads like "PO-0050 · 2 lines". That is legible only to someone
 * holding the system. The join adds the purchase order's number, date,
 * supplier, store and warehouse, its status and scope, and its line count, so
 * the "2 lines" can be checked and the row stands on its own in a spreadsheet
 * years from now. `created_by` is resolved to a username for the same reason.
 *
 * ── THE RECEIPT ───────────────────────────────────────────────────────────
 * After writing, it prints row counts, the date range each table covers, and
 * the total money in each. That output is the evidence the export is
 * complete: the counts and totals are checkable against the database and
 * against §36 without opening the CSVs.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Arguments ───────────────────────────────────────────────────────────────
const argv    = process.argv.slice(2);
const outFlag = argv.indexOf('--out');
const OUT_DIR = outFlag !== -1 && argv[outFlag + 1] ? argv[outFlag + 1] : '/root/backups';
const dbFlag  = argv.indexOf('--db');
const DB_PATH = dbFlag !== -1 && argv[dbFlag + 1]
  ? argv[dbFlag + 1]
  : path.join(__dirname, '..', 'data', 'roots.db');

// The output directory must not be inside the repository. An export written
// into the working tree gets committed by accident, and this is live financial
// data with names and amounts in it.
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_ABS   = path.resolve(OUT_DIR);
if (OUT_ABS === REPO_ROOT || OUT_ABS.startsWith(REPO_ROOT + path.sep)) {
  console.error('REFUSING: --out is inside the repository (' + OUT_ABS + ').');
  console.error('This export contains live financial data. Write it outside the working tree, e.g. /root/backups.');
  process.exit(1);
}

// ── Open the database READ-ONLY ─────────────────────────────────────────────
let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.error('Cannot load better-sqlite3: ' + e.message);
  console.error('Run this from the repository root, where node_modules lives.');
  process.exit(1);
}

if (!fs.existsSync(DB_PATH)) {
  console.error('No database at ' + DB_PATH);
  console.error('Pass --db /path/to/roots.db if it lives elsewhere.');
  process.exit(1);
}

let db;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
} catch (e) {
  console.error('Could not open the database read-only: ' + e.message);
  if (/unable to open|CANTOPEN/i.test(e.message)) {
    console.error('');
    console.error('The database is in WAL mode. A read-only connection needs the -shm/-wal');
    console.error('files to already exist, which they do while the app is running. If the app');
    console.error('is stopped, start it (or run this while it is up) and try again.');
  }
  process.exit(1);
}

// Belt and braces. `readonly: true` is the structural guarantee; query_only is
// a second latch, and the assert below means a future edit that drops the flag
// fails loudly here instead of quietly gaining write access.
if (db.readonly !== true) {
  console.error('REFUSING: the database handle is not read-only.');
  process.exit(1);
}
try { db.pragma('query_only = true'); } catch (_) { /* readonly already forbids writes */ }

// ── CSV ─────────────────────────────────────────────────────────────────────
// RFC 4180: CRLF line endings, quotes doubled inside quoted fields. A field is
// quoted when it contains a delimiter, a quote, a newline, or edge whitespace
// that a reader would otherwise trim.
function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s;
  if (typeof v === 'number') {
    // Shortest round-trip decimal. NOT toFixed — see the header comment.
    s = Number.isFinite(v) ? String(v) : '';
  } else if (Buffer.isBuffer(v)) {
    s = '0x' + v.toString('hex');
  } else {
    s = String(v);
  }
  if (/[",\r\n]/.test(s) || s !== s.trim()) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function csvRow(cells) { return cells.map(csvCell).join(',') + '\r\n'; }

// UTF-8 BOM. Excel on Windows reads a BOM-less UTF-8 CSV in the system code
// page, which turns every Chinese category and supplier name into mojibake.
// The BOM is three bytes that make the file open correctly without anyone
// needing to know why it would not have.
const BOM = '\uFEFF';

// ── Human-readable headers ──────────────────────────────────────────────────
const HEADERS = {
  id:             'Entry ID',
  date:           'Date',
  amount:         'Amount (CNY)',
  category:       'Category',
  description:    'Description',
  channel:        'Channel',
  po_id:          'Purchase order ID',
  payment_method: 'Payment method',
  created_at:     'Created at',
  created_by:     'Created by (user ID)',
  updated_at:     'Last updated at',
};
const headerFor = (col) => HEADERS[col] || col;

const columnsOf = (table) =>
  db.prepare('PRAGMA table_info(' + table + ')').all().map((r) => r.name);

const tableExists = (t) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

for (const t of ['income_entries', 'expense_entries']) {
  if (!tableExists(t)) {
    console.error('REFUSING: table ' + t + ' does not exist in ' + DB_PATH);
    process.exit(1);
  }
}

// ── Lookups ─────────────────────────────────────────────────────────────────
const users = new Map();
if (tableExists('users')) {
  for (const u of db.prepare('SELECT id, username, display_name FROM users').all()) {
    users.set(u.id, u.display_name ? u.display_name + ' (' + u.username + ')' : u.username);
  }
}

// Purchase orders, with the store resolved and the line count counted. Built
// once into a Map rather than joined per row, so the export is one pass over
// each ledger table regardless of how many rows carry a po_id.
const pos = new Map();
if (tableExists('purchase_orders')) {
  const poCols  = columnsOf('purchase_orders');
  const has     = (c) => poCols.includes(c);
  const hasStores = tableExists('retail_stores');
  const hasLines  = tableExists('po_line_items');
  const hasSupTbl = tableExists('suppliers');

  const sql =
    'SELECT po.id, po.po_number, po.date AS po_date, po.supplier' +
    (has('status')    ? ', po.status'    : ', NULL AS status') +
    (has('scope')     ? ', po.scope'     : ', NULL AS scope') +
    (has('warehouse') ? ', po.warehouse' : ', NULL AS warehouse') +
    (has('store_id')  ? ', po.store_id'  : ', NULL AS store_id') +
    (hasStores
      ? ', (SELECT COALESCE(s.name_cn, s.name_en, s.code) FROM retail_stores s WHERE s.id = po.store_id) AS store_name'
      : ', NULL AS store_name') +
    (hasSupTbl
      ? ', (SELECT sp.name_cn FROM suppliers sp WHERE sp.name = po.supplier) AS supplier_cn'
      : ', NULL AS supplier_cn') +
    (hasLines
      ? ', (SELECT COUNT(*) FROM po_line_items li WHERE li.po_id = po.id) AS line_count'
      : ', NULL AS line_count') +
    ' FROM purchase_orders po';

  for (const p of db.prepare(sql).all()) pos.set(p.id, p);
}

// ── Export one table ────────────────────────────────────────────────────────
function exportTable(table, file, withPO) {
  const cols = columnsOf(table);
  const rows = db.prepare('SELECT * FROM ' + table + ' ORDER BY date, id').all();

  const header = cols.map(headerFor);
  header.push('Created by (name)');
  if (withPO) {
    header.push(
      'PO number', 'PO date', 'PO supplier', 'PO supplier (中文)',
      'PO store', 'PO warehouse', 'PO status', 'PO scope', 'PO line count',
    );
  }
  header.push('Sub-cent amount?');

  let csv = BOM + csvRow(header);

  let total = 0;
  let subCent = 0;
  let minDate = null;
  let maxDate = null;

  for (const r of rows) {
    const cells = cols.map((c) => r[c]);
    cells.push(users.get(r.created_by) || '');

    if (withPO) {
      const p = r.po_id != null ? pos.get(r.po_id) : null;
      cells.push(
        p ? p.po_number   : '', p ? p.po_date     : '',
        p ? p.supplier    : '', p ? p.supplier_cn : '',
        p ? p.store_name  : '', p ? p.warehouse   : '',
        p ? p.status      : '', p ? p.scope       : '',
        p ? p.line_count  : '',
      );
    }

    // Sub-cent means the stored double is not exactly a two-decimal value:
    // 602.6800000000001 and 41.666666666666664 are, 602.68 and 655 are not.
    // Comparing against its own 2dp rounding is the whole test — anything that
    // scales by 100 and rounds collapses exactly the digits being looked for.
    const amt  = typeof r.amount === 'number' ? r.amount : Number(r.amount);
    const isSub = Number.isFinite(amt) && Number(amt.toFixed(2)) !== amt;
    if (isSub) subCent++;
    cells.push(isSub ? 'yes' : '');

    csv += csvRow(cells);

    if (Number.isFinite(amt)) total += amt;
    const d = r.date == null ? null : String(r.date);
    if (d) {
      if (minDate === null || d < minDate) minDate = d;
      if (maxDate === null || d > maxDate) maxDate = d;
    }
  }

  fs.writeFileSync(file, csv, 'utf8');
  return {
    table, file,
    count: rows.length,
    columns: cols.length,
    total, subCent, minDate, maxDate,
    bytes: fs.statSync(file).size,
  };
}

// ── Run ─────────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });

const stamp = new Date().toISOString().slice(0, 10);
const income  = exportTable('income_entries',
  path.join(OUT_DIR, 'kitchen-ledger-income_' + stamp + '.csv'), false);
const expense = exportTable('expense_entries',
  path.join(OUT_DIR, 'kitchen-ledger-expenses_' + stamp + '.csv'), true);

db.close();

// ── The receipt ─────────────────────────────────────────────────────────────
const yuan = (n) => '¥' + n.toFixed(2);
const line = (r) => {
  console.log('  ' + r.table);
  console.log('    rows          ' + r.count + '   (' + r.columns + ' table columns, exported in full)');
  console.log('    date range    ' + (r.minDate || 'n/a') + '  to  ' + (r.maxDate || 'n/a'));
  console.log('    total         ' + yuan(r.total));
  console.log('    exact sum     ' + r.total);
  if (r.subCent) console.log('    sub-cent rows ' + r.subCent + '   (written exactly as stored, flagged in the sheet)');
  console.log('    file          ' + r.file + '   (' + r.bytes + ' bytes)');
};

console.log('');
console.log('KITCHEN LEDGER EXPORT — decisions §36 cutover');
console.log('database  ' + DB_PATH + '   (opened read-only)');
console.log('written   ' + new Date().toISOString());
console.log('');
line(income);
console.log('');
line(expense);
console.log('');
console.log('  combined      ' + (income.count + expense.count) + ' rows, ' +
            yuan(income.total) + ' in, ' + yuan(expense.total) + ' out');
console.log('');
console.log('Nothing was written to the database. Both files are UTF-8 with BOM;');
console.log('open them in Excel directly — the Chinese will be correct.');
console.log('');
