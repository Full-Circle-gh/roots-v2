#!/usr/bin/env node
/**
 * diagnose_po_duplicates.js — is the same purchase on the books, or the 发票
 * chase, TWICE on the live box?
 *
 * WHY THIS EXISTS
 * ---------------
 * "Copy from kitchen" gives a kitchen buying order (scope='kitchen', PO-####) a
 * retail twin in Tacet (scope='retail', RPO-####, copied_from_po_id set). While
 * the twin is a draft it costs nothing; the moment it is placed, the same real
 * purchase used to go live twice — the buyer saw PO-0066 and RPO-0022 side by
 * side on the chase asking for the same three invoices, and Finance held the
 * goods twice. lib/po-supersede.js fixed that: a placed copy stands its kitchen
 * original down.
 *
 * That fix is a RULE, computed on every read. This asks whether the rule is
 * actually holding against the live data — not whether the test suite passes,
 * and not whether the deploy said OK.
 *
 * WHAT IT CHECKS, in the order a duplicate would show up:
 *   1. Every copy pair on the box: source, copy, both statuses, both totals.
 *   2. THE CHASE — for each pair, is the source still listed? (the reported bug)
 *      Run against the DEPLOYED routes/retail-purchasing.js predicate, not a
 *      transcription of it, so this cannot pass while the server disagrees.
 *   3. THE BOOKS — does any superseded source still hold expense_entries?
 *   4. Copies that are NOT copies: two POs of the same supplier and date whose
 *      line sets match, with no copied_from_po_id linking them — a duplicate the
 *      supersede rule cannot see, because nothing recorded that they are twins.
 *   5. Any 发票 recorded against a superseded source, which the chase reports on
 *      the copy rather than re-attributing (see lib/po-supersede.js).
 *
 * READ-ONLY, AND IT PROVES IT. The live database is opened with readonly:true
 * and a write is attempted and required to fail before anything else runs.
 * Nothing restarts, ships, or touches pm2.
 *
 * Run through .github/workflows/ro-query.yml (workflow_dispatch). The supersede
 * predicate is loaded from the DEPLOYED lib/, so section 2 grades the server.
 */
'use strict';

const path = require('path');

const DEPLOY_ROOT = process.env.ROOTS_DEPLOY_ROOT || '/root/roots-v2';
const DB_PATH = process.env.ROOTS_DB || path.join(DEPLOY_ROOT, 'data', 'roots.db');
const deployed = rel => path.join(DEPLOY_ROOT, rel);

const money = n => '¥' + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
let problems = 0;
const bad = m => { problems++; console.log('  ✗ ' + m); };
const good = m => console.log('  ✓ ' + m);

function main() {
  const Database = require(path.join(DEPLOY_ROOT, 'node_modules', 'better-sqlite3'));
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  let proven = false;
  try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
  catch (e) { proven = true; console.log('read-only PROVEN — write rejected: ' + e.message); }
  if (!proven) { console.error('FATAL: the connection accepted a write. Aborting.'); process.exit(2); }

  // The DEPLOYED rule, not a copy of it. If the box is running an older
  // retail-purchasing.js than this file expects, that is itself the finding.
  let notSupersededSql = null;
  try {
    ({ notSupersededByCopySql: notSupersededSql } = require(deployed('lib/po-supersede.js')));
    console.log('loaded the DEPLOYED lib/po-supersede.js\n');
  } catch (e) {
    console.log('!! lib/po-supersede.js is NOT on the box: ' + e.message);
    console.log('   The supersede rule is not deployed — every pair below is a live duplicate.\n');
  }

  const PLACED = "('Ordered','Delivered','Confirmed')";
  const total = poId => db.prepare(
    'SELECT COALESCE(SUM(COALESCE(qty,0) * COALESCE(cost_per_unit,0)),0) AS t FROM po_line_items WHERE po_id = ?'
  ).get(poId).t;

  console.log('══ 1 · every kitchen order that has a copy in Tacet ══');
  const pairs = db.prepare(`
    SELECT c.id AS copy_id, c.po_number AS copy_no, c.status AS copy_status, c.date AS copy_date,
           s.id AS src_id, s.po_number AS src_no, s.status AS src_status
      FROM purchase_orders c
      JOIN purchase_orders s ON s.id = c.copied_from_po_id
     WHERE c.copied_from_po_id IS NOT NULL
       AND COALESCE(c.scope,'kitchen') = 'retail'
     ORDER BY c.id`).all();
  if (!pairs.length) console.log('  (none — nothing has been copied from the kitchen list)');
  for (const p of pairs) {
    p.placed = ['Ordered', 'Delivered', 'Confirmed'].includes(p.copy_status);
    console.log(`  ${p.src_no} (${p.src_status}, ${money(total(p.src_id))})`
      + ` → ${p.copy_no} (${p.copy_status}, ${money(total(p.copy_id))})`
      + `  ${p.placed ? 'COPY IS PLACED — source must stand down' : 'copy is a draft — source still stands'}`);
  }

  console.log('\n══ 2 · the 发票 chase — is any purchase listed twice? ══');
  if (!notSupersededSql) {
    bad('cannot check: the deployed rule is missing (see above)');
  } else {
    // Exactly what the chase asks: placed, and not stood down by a placed copy.
    const chased = new Set(db.prepare(`
      SELECT po.id FROM purchase_orders po
       WHERE po.status IN ${PLACED} AND ${notSupersededSql('po')}`).all().map(r => r.id));
    let dupes = 0;
    for (const p of pairs) {
      if (!p.placed) continue;
      const srcIn = chased.has(p.src_id), copyIn = chased.has(p.copy_id);
      if (srcIn && copyIn) { dupes++; bad(`${p.src_no} AND ${p.copy_no} are BOTH on the chase — the same purchase twice`); }
      else if (srcIn && !copyIn) bad(`${p.src_no} is chased but its placed copy ${p.copy_no} is not — backwards`);
      else good(`${p.copy_no} is chased, ${p.src_no} stood down — counted once`);
    }
    if (!pairs.some(p => p.placed)) console.log('  (no placed copies — nothing for the rule to do yet)');
    if (!dupes) good('no purchase appears twice on the chase');
  }

  console.log('\n══ 3 · the books — expense rows on a stood-down order ══');
  for (const p of pairs) {
    if (!p.placed) continue;
    const srcExp = db.prepare('SELECT COALESCE(SUM(amount),0) AS t, COUNT(*) AS n FROM expense_entries WHERE po_id = ?').get(p.src_id);
    const copyExp = db.prepare('SELECT COALESCE(SUM(amount),0) AS t, COUNT(*) AS n FROM expense_entries WHERE po_id = ?').get(p.copy_id);
    if (srcExp.n > 0 && copyExp.n > 0) {
      bad(`${p.src_no} still holds ${srcExp.n} expense row(s) ${money(srcExp.t)} while ${p.copy_no} holds ${money(copyExp.t)}`
        + ' — the goods are in the books TWICE. Re-save the copy (or flip its status) to clear it.');
    } else if (srcExp.n > 0) {
      bad(`${p.src_no} holds ${money(srcExp.t)} but its placed copy ${p.copy_no} holds nothing — backwards`);
    } else {
      good(`${p.copy_no} holds ${money(copyExp.t)}, ${p.src_no} holds nothing — booked once`);
    }
  }

  console.log('\n══ 4 · unlinked twins — same supplier, same date, same lines, no copy link ══');
  // A duplicate the supersede rule CANNOT see: nothing records that these two
  // are the same purchase, so no rule can stand either of them down. Reported
  // rather than acted on — only a person knows if it was bought twice.
  const placedPos = db.prepare(`
    SELECT id, po_number, date, COALESCE(supplier,'') AS supplier, scope, copied_from_po_id
      FROM purchase_orders WHERE status IN ${PLACED}`).all();
  const fingerprint = poId => db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(name_en),''), NULLIF(TRIM(name_cn),''), COALESCE(sku,'')) AS k,
           COALESCE(qty,0) AS q
      FROM po_line_items WHERE po_id = ? ORDER BY k, q`).all(poId).map(r => r.k + '×' + r.q).join('|');
  const byKey = new Map();
  for (const po of placedPos) {
    const fp = fingerprint(po.id);
    if (!fp) continue;
    const key = po.date + '|' + po.supplier + '|' + fp;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(po);
  }
  let unlinked = 0;
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    // Already-linked pairs are section 2's business, not this one's.
    const linked = group.some(p => p.copied_from_po_id && group.some(o => o.id === p.copied_from_po_id));
    if (linked) continue;
    unlinked++;
    bad('same supplier, date and lines with NO copy link: '
      + group.map(p => `${p.po_number} (${p.scope || 'kitchen'})`).join(' + ')
      + ' — a person must decide whether this was bought twice');
  }
  if (!unlinked) good('no unlinked twins');

  console.log('\n══ 5 · 发票 recorded against a stood-down order ══');
  let carried = 0;
  for (const p of pairs) {
    if (!p.placed) continue;
    const inv = db.prepare(`
      SELECT COALESCE(SUM(il.allocated_amount),0) AS amount
        FROM invoice_lines il JOIN po_line_items pli ON pli.id = il.line_id
       WHERE pli.po_id = ?`).get(p.src_id).amount;
    if (inv > 0.005) {
      carried++;
      console.log(`  · ${p.src_no} carries ${money(inv)} of recorded 发票. It stays in the ledger and`
        + ` the chase reports it on ${p.copy_no} — not lost, not re-attributed.`);
    }
  }
  if (!carried) good('none — no invoice money sits on a stood-down order');

  console.log(`\n${problems ? '✗ ' + problems + ' problem(s) found' : '✓ no duplicate purchase found'}\n`);
  db.close();
  process.exit(problems ? 1 : 0);
}

main();
