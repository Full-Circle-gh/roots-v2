#!/usr/bin/env node
/**
 * "The 发票 are recorded. Why does Purchasing → Invoices say ¥0.00?"
 *
 * Read-only. Lists every recorded-invoice allocation that the retail 发票 chase
 * (GET /api/retail-admin/purchasing/invoices/outstanding) cannot see, and says
 * why — the same three reasons routes/retail-purchasing.js recordedOffChase()
 * reports on the screen, listed here in full rather than topped at four.
 *
 * The chase counts a recorded 发票 through ONE path: the PO LINE its allocation
 * points at. Its five figures are the lines that read selects, added up by
 * state. So an allocation whose line falls out of that selection is counted
 * nowhere — and because the four states still add up to the total, nothing on
 * the screen looks wrong; the headline simply reads "Fully invoiced ¥0.00".
 *
 * The database is opened read-only and the connection is PROVEN read-only
 * before anything else runs, by attempting a CREATE TABLE and aborting if the
 * write is accepted. Same guard scripts/diagnose_money_unit_split.js uses.
 *
 * Usage:  node scripts/diagnose_invoice_off_chase.js
 *         ROOTS_DB=/path/to/roots.db node scripts/diagnose_invoice_off_chase.js
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || path.join(ROOT, 'data', 'roots.db');
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const { supersededByCopySql, PLACED_COPY_STATUSES } = require(path.join(ROOT, 'lib', 'po-supersede'));

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

let proven = false;
try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
catch (e) { proven = true; console.log('read-only PROVEN — write rejected: ' + e.message); }
if (!proven) {
  console.error('FATAL: the connection accepted a write. Aborting without reading anything.');
  process.exit(2);
}

// The chase's own placed-order set (routes/retail-purchasing.js INV_PO_STATUSES).
const INV_PO_STATUSES = "('Ordered','Delivered','Confirmed')";
const money = n => '¥' + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);

console.log('db: ' + DB_PATH);
console.log('');

const tenants = db.prepare(
  'SELECT DISTINCT COALESCE(tenant_id,1) AS tid FROM invoices ORDER BY 1').all().map(r => r.tid);
if (!tenants.length) { console.log('No invoices recorded at all.'); process.exit(0); }

for (const tid of tenants) {
  const totals = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amount
      FROM invoices WHERE COALESCE(tenant_id,1) = ?`).get(tid);
  const linked = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(il.allocated_amount),0) AS amount
      FROM invoice_lines il JOIN invoices inv ON inv.id = il.invoice_id
     WHERE COALESCE(inv.tenant_id,1) = ?`).get(tid);

  console.log(`══ tenant ${tid} ══`);
  console.log(`  ${totals.n} invoice(s) recorded, ${money(totals.amount)} on their headers`);
  console.log(`  ${linked.n} allocation(s) against PO lines, ${money(linked.amount)} matched`);
  console.log(`  ${money(totals.amount - linked.amount)} on invoices matched to no line at all `
            + '(the ledger already flags these per row as "unallocated")');

  const rows = db.prepare(`
    SELECT il.allocated_amount AS amount,
           inv.id AS invoice_id, inv.invoice_number, inv.supplier, inv.date,
           po.po_number, po.status, COALESCE(po.tenant_id,1) AS po_tenant,
           pli.id AS line_id, pli.name_en, pli.name_cn, pli.sku,
           ${supersededByCopySql('po')} AS superseded,
           (SELECT c.po_number FROM purchase_orders c
             WHERE c.copied_from_po_id = po.id
               AND COALESCE(c.scope,'kitchen') = 'retail'
               AND COALESCE(c.tenant_id,1)     = COALESCE(po.tenant_id,1)
               AND c.status IN ${PLACED_COPY_STATUSES}
             ORDER BY c.id LIMIT 1) AS copy_po_number
      FROM invoice_lines il
      JOIN invoices inv       ON inv.id = il.invoice_id
      JOIN po_line_items pli  ON pli.id = il.line_id
      JOIN purchase_orders po ON po.id  = pli.po_id
     WHERE COALESCE(inv.tenant_id,1) = ?
       AND (${supersededByCopySql('po')}
            OR po.status NOT IN ${INV_PO_STATUSES}
            OR COALESCE(po.tenant_id,1) <> ?)
     ORDER BY il.allocated_amount DESC`).all(tid, tid);

  if (!rows.length) {
    console.log('  ✓ every allocation lands on a line the chase shows — nothing is stranded\n');
    continue;
  }

  const reasonOf = r => r.superseded ? 'superseded'
                      : r.po_tenant !== tid ? 'other_tenant'
                      : 'not_placed';
  const stranded = rows.reduce((s, r) => s + (r.amount || 0), 0);
  const byReason = new Map();
  for (const r of rows) {
    const k = reasonOf(r);
    byReason.set(k, (byReason.get(k) || 0) + (r.amount || 0));
  }
  console.log(`  ✗ ${money(stranded)} across ${rows.length} allocation(s) is counted NOWHERE on the screen`);
  for (const [k, v] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`      ${k.padEnd(13)} ${money(v)}`);
  }
  console.log('');
  for (const r of rows) {
    const why = reasonOf(r) === 'superseded'
      ? `${r.po_number} replaced by ${r.copy_po_number}`
      : reasonOf(r) === 'other_tenant'
        ? `${r.po_number} belongs to tenant ${r.po_tenant}`
        : `${r.po_number} is ${r.status}`;
    console.log(`      ${money(r.amount).padStart(11)}  inv#${r.invoice_id}`
      + ` ${(r.invoice_number || '—')} ${r.date}  ${r.supplier}`);
    console.log(`                   line ${r.line_id} ${(r.name_en || r.name_cn || '')}`
      + `${r.sku ? ' [' + r.sku + ']' : ''} — ${why}`);
  }
  console.log('');
  console.log('  To put this money back on the chase: Purchasing → Invoices, the');
  console.log('  "Recorded, not counted above" strip, then Re-match. It shows the');
  console.log('  line-for-line pairing it proposes for each order before it moves');
  console.log('  anything, and leaves alone whatever it cannot pair with certainty.');
  console.log('  Anything listed above as not_placed or other_tenant has no');
  console.log('  replacing order to move to, and needs the 发票 editing by hand.');
  console.log('');
}
