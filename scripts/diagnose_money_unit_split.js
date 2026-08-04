#!/usr/bin/env node
/**
 * Read-only comparison of the OLD and NEW forms of the five unit-mixing
 * statements in routes/retail-purchasing.js and routes/finance.js.
 *
 * Every statement here is a SELECT. The database is opened read-only and the
 * connection is PROVEN read-only before anything else runs, by attempting a
 * CREATE TABLE and aborting if the write is accepted.
 *
 * Sites compared:
 *   A  retail-purchasing.js:478-496  GET  /api/retail-admin/bills/outstanding
 *   B  retail-purchasing.js:570-591  POST /api/retail-admin/bills      (clamp)
 *   C  finance.js:496-518            POST /api/finance/invoices        (clamp)
 *   D  finance.js:552-568            PUT  /api/finance/invoices/:id    (clamp)
 *   E  finance.js:633,680-688        GET  /api/finance/outstanding-lines
 *
 * C and D are the same statement text against the same table with the same
 * consumer arithmetic, so they are compared once under "C/D".
 */
'use strict';

const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const Database = require('/root/roots-v2/node_modules/better-sqlite3');

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
  console.error('FATAL: the connection accepted a write. Aborting without comparing anything.');
  process.exit(2);
}
console.log('db: ' + DB_PATH);
console.log('sqlite: ' + db.prepare('select sqlite_version() v').get().v);
console.log('');

const eq = (a, b) => (a === b) || (Number.isNaN(a) && Number.isNaN(b));
let FAILURES = 0;
const bad = (msg) => { FAILURES++; console.log('   MISMATCH ' + msg); };

// ════════════════════════════════════════════════════════════════════════════
// 0 — Shape of the data the five sites read
// ════════════════════════════════════════════════════════════════════════════
console.log('══ 0 · data shape ══');
const shape = db.prepare(`
  SELECT (SELECT COUNT(*) FROM po_line_items)                              AS pli_rows,
         (SELECT COUNT(*) FROM po_line_items WHERE cost_per_unit IS NULL)  AS pli_cpu_null,
         (SELECT COUNT(*) FROM po_line_items WHERE qty IS NULL)            AS pli_qty_null,
         (SELECT COUNT(*) FROM purchase_orders)                            AS po_rows,
         (SELECT COUNT(*) FROM invoice_lines)                              AS il_rows,
         (SELECT COUNT(DISTINCT line_id) FROM invoice_lines)               AS il_lines,
         (SELECT COUNT(*) FROM invoices)                                   AS inv_rows`).get();
console.log(JSON.stringify(shape));
console.log('invoice_lines rows: ' + JSON.stringify(
  db.prepare('SELECT id, invoice_id, line_id, allocated_amount FROM invoice_lines ORDER BY id').all()));
console.log('allocations per line: ' + JSON.stringify(
  db.prepare('SELECT line_id, COUNT(*) n, SUM(allocated_amount) s FROM invoice_lines GROUP BY line_id ORDER BY n DESC').all()));
console.log('po scope/status spread: ' + JSON.stringify(
  db.prepare(`SELECT COALESCE(scope,'kitchen') scope, status, COUNT(*) n FROM purchase_orders GROUP BY 1,2 ORDER BY 1,2`).all()));
console.log('');

// ════════════════════════════════════════════════════════════════════════════
// A — GET /api/retail-admin/bills/outstanding
// ════════════════════════════════════════════════════════════════════════════
// The natural filter (scope='retail' AND status IN (...) AND both
// no_invoice_expected flags clear) is applied first; the run then WIDENS to
// every PO line in the table so the comparison is not proved on an empty set.
const A_SCOPES = [
  { name: 'as-shipped (retail scope, bill statuses)',
    where: `COALESCE(po.scope,'kitchen')='retail' AND COALESCE(po.tenant_id,1) = 1 AND po.status IN ('Ordered','Delivered','Confirmed')
            AND COALESCE(po.no_invoice_expected,0)=0 AND COALESCE(pli.no_invoice_expected,0)=0` },
  { name: 'widened · retail scope, any status',
    where: `COALESCE(po.scope,'kitchen')='retail'` },
  { name: 'widened · kitchen scope, bill statuses',
    where: `COALESCE(po.scope,'kitchen')='kitchen' AND po.status IN ('Ordered','Delivered','Confirmed')` },
  { name: 'widened · EVERY po line in the table',
    where: `1=1` },
];

function aOld(where, params) {
  const rows = db.prepare(`
    SELECT pli.id AS line_id, pli.name_en, pli.name_cn, pli.sku, pli.qty, pli.cost_per_unit,
           (pli.qty*pli.cost_per_unit) AS line_total,
           COALESCE((SELECT SUM(allocated_amount) FROM invoice_lines WHERE line_id=pli.id),0) AS covered,
           po.id AS po_id, po.po_number, po.date,
           COALESCE(NULLIF(TRIM(COALESCE(pli.supplier_name,'')),''),po.supplier,'') AS supplier
      FROM po_line_items pli JOIN purchase_orders po ON po.id=pli.po_id
     WHERE ${where}
     ORDER BY supplier, po.date DESC, pli.id`).all(...params);
  const bySup = new Map();
  for (const r of rows) {
    r.outstanding = Math.max(0, r.line_total - r.covered);
    r.status = r.covered <= 0.01 ? 'awaiting' : (r.covered + 0.01 >= r.line_total ? 'fully' : 'partial');
    if (!bySup.has(r.supplier)) bySup.set(r.supplier, { supplier: r.supplier || null, total: 0, covered: 0, outstanding: 0, lines: [] });
    const g = bySup.get(r.supplier);
    g.total += r.line_total; g.covered += r.covered; g.outstanding += r.outstanding; g.lines.push(r);
  }
  return { rows, groups: [...bySup.values()].filter(g => g.outstanding > 0.01).sort((a, b) => b.outstanding - a.outstanding) };
}

function aNew(where, params) {
  const rows = db.prepare(`
    SELECT pli.id AS line_id, pli.name_en, pli.name_cn, pli.sku, pli.qty, pli.cost_per_unit,
           po.id AS po_id, po.po_number, po.date,
           COALESCE(NULLIF(TRIM(COALESCE(pli.supplier_name,'')),''),po.supplier,'') AS supplier
      FROM po_line_items pli JOIN purchase_orders po ON po.id=pli.po_id
     WHERE ${where}
     ORDER BY supplier, po.date DESC, pli.id`).all(...params);
  const covered = coveredByLine(rows.map(r => r.line_id));
  const bySup = new Map();
  for (const r of rows) {
    r.line_total = (r.qty || 0) * (r.cost_per_unit || 0);
    r.covered = covered.get(r.line_id) || 0;
    r.outstanding = Math.max(0, r.line_total - r.covered);
    r.status = r.covered <= 0.01 ? 'awaiting' : (r.covered + 0.01 >= r.line_total ? 'fully' : 'partial');
    if (!bySup.has(r.supplier)) bySup.set(r.supplier, { supplier: r.supplier || null, total: 0, covered: 0, outstanding: 0, lines: [] });
    const g = bySup.get(r.supplier);
    g.total += r.line_total; g.covered += r.covered; g.outstanding += r.outstanding; g.lines.push(r);
  }
  return { rows, groups: [...bySup.values()].filter(g => g.outstanding > 0.01).sort((a, b) => b.outstanding - a.outstanding) };
}

// Verbatim copies of the two helpers the shipped code now uses.
function coveredByLine(lineIds) {
  const out = new Map();
  for (let i = 0; i < lineIds.length; i += 400) {
    const chunk = lineIds.slice(i, i + 400);
    const rows = db.prepare(`SELECT line_id, allocated_amount FROM invoice_lines
                              WHERE line_id IN (${chunk.map(() => '?').join(',')})
                              ORDER BY id`).all(...chunk);
    for (const a of rows) out.set(a.line_id, (out.get(a.line_id) || 0) + (a.allocated_amount || 0));
  }
  return out;
}
function allocatedForLine(lineId) {
  return db.prepare('SELECT allocated_amount FROM invoice_lines WHERE line_id = ? ORDER BY id')
    .all(lineId)
    .reduce((sum, r) => sum + (r.allocated_amount || 0), 0);
}

console.log('══ A · GET /api/retail-admin/bills/outstanding ══');
let aRowsCompared = 0, aGroupsCompared = 0;
for (const sc of A_SCOPES) {
  const months = db.prepare(`SELECT DISTINCT substr(po.date,1,7) m FROM po_line_items pli
                              JOIN purchase_orders po ON po.id=pli.po_id
                             WHERE ${sc.where} AND po.date IS NOT NULL ORDER BY 1`).all().map(r => r.m);
  const cases = [{ label: 'no month filter', where: sc.where, params: [] }]
    .concat(months.map(m => ({ label: 'month=' + m, where: sc.where + ' AND substr(po.date,1,7)=?', params: [m] })));
  for (const c of cases) {
    const o = aOld(c.where, c.params), n = aNew(c.where, c.params);
    if (o.rows.length !== n.rows.length) { bad(`A ${sc.name} ${c.label}: row count ${o.rows.length} vs ${n.rows.length}`); continue; }
    for (let i = 0; i < o.rows.length; i++) {
      const a = o.rows[i], b = n.rows[i];
      aRowsCompared++;
      for (const k of ['line_id', 'line_total', 'covered', 'outstanding', 'status']) {
        if (!eq(a[k], b[k])) bad(`A ${sc.name} ${c.label} line_id=${a.line_id} ${k}: ${a[k]} vs ${b[k]}`);
      }
    }
    if (o.groups.length !== n.groups.length) bad(`A ${sc.name} ${c.label}: group count ${o.groups.length} vs ${n.groups.length}`);
    for (let i = 0; i < Math.min(o.groups.length, n.groups.length); i++) {
      const a = o.groups[i], b = n.groups[i];
      aGroupsCompared++;
      for (const k of ['supplier', 'total', 'covered', 'outstanding']) {
        if (!eq(a[k], b[k])) bad(`A ${sc.name} ${c.label} group=${a.supplier} ${k}: ${a[k]} vs ${b[k]}`);
      }
    }
  }
  const tot = aOld(sc.where, []);
  console.log(`  ${sc.name}: ${tot.rows.length} lines, ${tot.groups.length} groups, ${cases.length} filter cases`);
}
console.log(`  compared ${aRowsCompared} row readings and ${aGroupsCompared} group readings`);
console.log('');

// ════════════════════════════════════════════════════════════════════════════
// B — POST /api/retail-admin/bills  (the clamp)  ·  C/D — the finance clamps
// ════════════════════════════════════════════════════════════════════════════
// B and C/D differ only in the alias name (`already` / `already_allocated`) and
// the message text. The statement, the arithmetic and the decision are the same,
// so one comparison covers all three; the alias is asserted separately.
const clampOldB = db.prepare(`
    SELECT pli.id, pli.qty, pli.cost_per_unit,
           COALESCE((SELECT SUM(allocated_amount) FROM invoice_lines WHERE line_id=pli.id),0) AS already
      FROM po_line_items pli WHERE pli.id=?`);
const clampOldCD = db.prepare(`
    SELECT pli.id, pli.qty, pli.cost_per_unit,
           COALESCE((SELECT SUM(allocated_amount) FROM invoice_lines WHERE line_id = pli.id), 0) AS already_allocated
      FROM po_line_items pli
     WHERE pli.id = ?`);
const clampNew = db.prepare(`
    SELECT pli.id, pli.qty, pli.cost_per_unit
      FROM po_line_items pli WHERE pli.id=?`);

console.log('══ B, C/D · the two allocation clamps ══');
const allLineIds = db.prepare('SELECT id FROM po_line_items ORDER BY id').all().map(r => r.id);
let clampCases = 0, clampLines = 0;
for (const lineId of allLineIds) {
  const oB = clampOldB.get(lineId), oCD = clampOldCD.get(lineId), nR = clampNew.get(lineId);
  if (!eq(oB.already, oCD.already_allocated)) bad(`clamp line ${lineId}: B alias ${oB.already} vs C/D alias ${oCD.already_allocated}`);
  const alreadyNew = allocatedForLine(lineId);
  if (!eq(oB.already, alreadyNew)) bad(`clamp line ${lineId}: already ${oB.already} vs ${alreadyNew}`);

  const lineTotalOld = (oB.qty || 0) * (oB.cost_per_unit || 0);
  const lineTotalNew = (nR.qty || 0) * (nR.cost_per_unit || 0);
  if (!eq(lineTotalOld, lineTotalNew)) bad(`clamp line ${lineId}: lineTotal ${lineTotalOld} vs ${lineTotalNew}`);

  const remOld = Math.max(0, lineTotalOld - oB.already);
  const remNew = Math.max(0, lineTotalNew - alreadyNew);
  if (!eq(remOld, remNew)) bad(`clamp line ${lineId}: remaining ${remOld} vs ${remNew}`);
  clampLines++;

  // Grid of candidate allocations around the boundary, including the exact
  // knife edges the +0.01 tolerance sits on.
  const grid = [0.01, 1, remOld - 0.02, remOld - 0.01, remOld, remOld + 0.005, remOld + 0.01,
                remOld + 0.0100001, remOld + 0.02, lineTotalOld, lineTotalOld * 2,
                lineTotalOld * 100, 1e9];
  for (const alloc of grid) {
    if (!(alloc > 0)) continue;
    const vOld = alloc > remOld + 0.01 ? 'reject' : 'accept';
    const vNew = alloc > remNew + 0.01 ? 'reject' : 'accept';
    clampCases++;
    if (vOld !== vNew) bad(`clamp line ${lineId} alloc=${alloc}: ${vOld} vs ${vNew}`);
  }
}
console.log(`  ${clampLines} PO lines · ${clampCases} allocation decisions compared`);
console.log(`  lines carrying a prior allocation: ${db.prepare('SELECT COUNT(DISTINCT line_id) n FROM invoice_lines').get().n}`);
console.log('');

// ════════════════════════════════════════════════════════════════════════════
// E — GET /api/finance/outstanding-lines
// ════════════════════════════════════════════════════════════════════════════
const E_SCOPES = [
  { name: 'as-shipped (Ordered/Delivered/Confirmed)', where: `po.status IN ('Ordered','Delivered','Confirmed')` },
  { name: 'widened · every po line in the table', where: `1=1` },
];
const E_SELECT = `
    SELECT pli.id AS line_id, pli.po_id, pli.name_en, pli.name_cn, pli.sku,
           pli.qty, pli.unit, pli.cost_per_unit,
           COALESCE(
             NULLIF(TRIM(pli.supplier_name),''),
             NULLIF(TRIM(po.supplier),''),
             NULLIF(TRIM(ing.supplier),''),
             '未指定 Unspecified'
           ) AS supplier_name,
           pli.purchase_channel, pli.no_invoice_expected AS line_no_invoice,
           po.po_number, po.date, po.status, po.no_invoice_expected AS po_no_invoice`;
const E_FROM = `
      FROM po_line_items pli
      JOIN purchase_orders po ON po.id = pli.po_id
      LEFT JOIN ingredients ing ON ing.id = pli.ingredient_id
     WHERE `;
const round = n => Math.round(n * 100) / 100;

function enrich(rows, coveredOf) {
  return rows.map(r => {
    const amount = round((parseFloat(r.qty) || 0) * (parseFloat(r.cost_per_unit) || 0));
    const covered = round(coveredOf(r));
    const outstanding = round(Math.max(0, amount - covered));
    let status = 'awaiting';
    if (r.line_no_invoice || r.po_no_invoice) status = 'no_invoice_expected';
    else if (covered >= amount && amount > 0) status = 'fully_invoiced';
    else if (covered > 0) status = 'partially_invoiced';
    return { ...r, amount, covered_amount: covered, outstanding, status };
  });
}

function eOld(where, params) {
  const rows = db.prepare(E_SELECT + `,
           COALESCE((SELECT SUM(allocated_amount) FROM invoice_lines WHERE line_id = pli.id), 0) AS covered_amount`
    + E_FROM + where + ' ORDER BY po.date DESC, pli.sort_order').all(...params);
  return enrich(rows, r => r.covered_amount);
}
function eNew(where, params) {
  const rows = db.prepare(E_SELECT + E_FROM + where + ' ORDER BY po.date DESC, pli.sort_order').all(...params);
  const covered = coveredByLine(rows.map(r => r.line_id));
  return enrich(rows, r => covered.get(r.line_id) || 0);
}

console.log('══ E · GET /api/finance/outstanding-lines ══');
let eRows = 0;
for (const sc of E_SCOPES) {
  const months = db.prepare(`SELECT DISTINCT substr(po.date,1,7) m FROM po_line_items pli
                              JOIN purchase_orders po ON po.id=pli.po_id
                             WHERE ${sc.where} AND po.date IS NOT NULL ORDER BY 1`).all().map(r => r.m);
  const sups = db.prepare(`SELECT DISTINCT COALESCE(NULLIF(TRIM(pli.supplier_name),''),NULLIF(TRIM(po.supplier),''),'') s
                             FROM po_line_items pli JOIN purchase_orders po ON po.id=pli.po_id
                            WHERE ${sc.where}`).all().map(r => r.s).filter(Boolean);
  const cases = [{ label: 'unfiltered', where: sc.where, params: [] }]
    .concat(months.map(m => ({ label: 'month=' + m, where: sc.where + ' AND substr(po.date, 1, 7) = ?', params: [m] })))
    .concat(sups.map(s => ({
      label: 'supplier~' + s,
      where: sc.where + ` AND LOWER(COALESCE(NULLIF(TRIM(pli.supplier_name),''),NULLIF(TRIM(po.supplier),''),NULLIF(TRIM(ing.supplier),''),'')) LIKE LOWER(?)`,
      params: ['%' + s + '%'],
    })));
  for (const c of cases) {
    const o = eOld(c.where, c.params), n = eNew(c.where, c.params);
    if (o.length !== n.length) { bad(`E ${sc.name} ${c.label}: row count ${o.length} vs ${n.length}`); continue; }
    for (let i = 0; i < o.length; i++) {
      eRows++;
      for (const k of ['line_id', 'amount', 'covered_amount', 'outstanding', 'status']) {
        if (!eq(o[i][k], n[i][k])) bad(`E ${sc.name} ${c.label} line_id=${o[i].line_id} ${k}: ${o[i][k]} vs ${n[i][k]}`);
      }
    }
  }
  console.log(`  ${sc.name}: ${eOld(sc.where, []).length} lines, ${cases.length} filter cases`);
}
console.log(`  compared ${eRows} row readings`);
console.log('');

// ════════════════════════════════════════════════════════════════════════════
// F — SQL SUM(...) vs JavaScript reduce, over MULTI-ROW groups
// ════════════════════════════════════════════════════════════════════════════
// Live invoice_lines carries at most one allocation per PO line, so sites A-E
// never exercise the only new arithmetic the change introduces: adding several
// REAL money values in JavaScript where SQLite added them. SQLite 3.43+ sums
// floats with Kahan-Babuska compensation and a plain `reduce` does not, so the
// two are not identical by construction and the question has to be asked of
// real data. This runs it over every REAL money column in this database that
// has multi-row groups, in the same id order the new helpers read.
console.log('══ F · SQL SUM vs JS reduce over multi-row groups ══');
const SUM_CASES = [
  ['invoice_lines',     'allocated_amount', 'line_id'],
  ['invoice_lines',     'allocated_amount', 'invoice_id'],
  ['po_line_items',     'total_cost',       'po_id'],
  ['po_line_items',     'cost_per_unit',    'po_id'],
  ['retail_order_items', 'line_total',      'order_id'],
  ['retail_order_items', 'unit_price',      'order_id'],
  ['retail_payments',   'amount',           'order_id'],
  ['expense_entries',   'amount',           'po_id'],
  ['retail_order_addons', 'amount',         'order_id'],
  ['sales_entries',     'total',            'date'],
  ['retail_refund_events', 'amount',        'order_id'],
];
for (const [tbl, col, key] of SUM_CASES) {
  let groups = 0, multi = 0, diff = 0, worst = 0, worstAt = null;
  let sqlRows;
  try {
    sqlRows = db.prepare(`SELECT ${key} AS k, COALESCE(SUM(${col}),0) AS s, COUNT(*) AS n
                            FROM ${tbl} WHERE ${key} IS NOT NULL GROUP BY ${key}`).all();
  } catch (e) { console.log(`  ${tbl}.${col} by ${key}: skipped (${e.message})`); continue; }
  const detail = db.prepare(`SELECT ${col} AS v FROM ${tbl} WHERE ${key} = ? ORDER BY id`);
  for (const g of sqlRows) {
    groups++;
    if (g.n > 1) multi++;
    const js = detail.all(g.k).reduce((s, r) => s + (r.v || 0), 0);
    if (!eq(g.s, js)) {
      diff++;
      const d = Math.abs(g.s - js);
      if (d > worst) { worst = d; worstAt = `${key}=${g.k} n=${g.n} sql=${g.s} js=${js}`; }
    }
  }
  const note = diff ? `  DIFFERS in ${diff} (worst |delta| ${worst} at ${worstAt})` : '  identical';
  console.log(`  ${tbl}.${col} by ${key}: ${groups} groups (${multi} multi-row) ->${note}`);
  // A difference here is float summation order, not a unit error. It is
  // reported, not counted as a mismatch of the five sites.
}
console.log('');

// ── Non-zero coverage: prove the comparison ran over data that is not all 0 ──
console.log('══ non-empty evidence ══');
const covRows = eOld(`1=1`, []).filter(r => r.covered_amount > 0);
console.log(`  lines with covered_amount > 0: ${covRows.length}`);
for (const r of covRows) {
  console.log(`    line ${r.line_id} ${r.po_number} amount=${r.amount} covered=${r.covered_amount} outstanding=${r.outstanding} status=${r.status}`);
}
const aAll = aOld(`1=1`, []);
console.log(`  A groups with non-zero outstanding: ${aAll.groups.length}, largest = ${aAll.groups[0] ? aAll.groups[0].outstanding : 'n/a'}`);
console.log('');

console.log(FAILURES === 0 ? 'RESULT=IDENTICAL (0 mismatches)' : `RESULT=MISMATCHES (${FAILURES})`);
db.close();
process.exit(FAILURES === 0 ? 0 : 1);
