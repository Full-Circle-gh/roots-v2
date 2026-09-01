#!/usr/bin/env node
/**
 * diagnose_arrived_prefill.js — why does an order still at SENT show arrived
 * quantities nobody typed?
 *
 * WHAT WAS REPORTED
 * -----------------
 * RPO-0001 sits at Sent (status 'Ordered'), and every line's ARRIVED box holds
 * the ordered quantity. The buyer says they never entered them.
 *
 * WHAT THE CODE SAYS SHOULD BE TRUE
 * ---------------------------------
 * The ARRIVED box renders the ordered qty as a grey PLACEHOLDER when nothing is
 * recorded, and a solid VALUE only when po_line_items.qty_received is non-null
 * (public/retail-admin/16-purchasing.js, receiveRow). So a filled box means
 * stored data, not a default. Exactly three paths write that column:
 *
 *   a) PUT /purchases/:id/status → 'Delivered' seeds qty_received = qty on every
 *      line — the "everything arrived" shortcut behind "All arrived as ordered"
 *      (puAllArrived → puSetStatus('Delivered')).
 *   b) the bulk receive save ("Confirm delivery"), per line, from the inputs.
 *   c) nothing else. The kitchen COPY path explicitly does not carry it over.
 *
 * And /undo-receive drops a Delivered order back to 'Ordered' while DELIBERATELY
 * leaving qty_received where it is, so the counts survive the trip back.
 *
 * So "Sent, but filled" should mean: it went to Delivered at some point and came
 * back. This asks the live data whether that is what happened, or whether
 * something wrote those counts with no such history — which would be a bug.
 *
 * SECTIONS
 *   1. Every retail order NOT at Delivered that carries qty_received anyway.
 *   2. For each, its own activity_log history — every status change, receive,
 *      undo and copy event, in order, with who and when.
 *   3. The verdict per order: explained by a Delivered round trip, or NOT.
 *   4. Did stock actually move? stock_applied_qty per line, since a reversal
 *      that left stock behind would be a second, worse problem.
 *
 * READ-ONLY, AND IT PROVES IT: the connection is opened readonly and a write is
 * attempted and required to fail before anything else runs.
 *
 * Run through .github/workflows/ro-query.yml (workflow_dispatch).
 */
'use strict';

const path = require('path');

const DEPLOY_ROOT = process.env.ROOTS_DEPLOY_ROOT || '/root/roots-v2';
const DB_PATH = process.env.ROOTS_DB || path.join(DEPLOY_ROOT, 'data', 'roots.db');

function main() {
  const Database = require(path.join(DEPLOY_ROOT, 'node_modules', 'better-sqlite3'));
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  let proven = false;
  try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
  catch (e) { proven = true; console.log('read-only PROVEN — write rejected: ' + e.message); }
  if (!proven) { console.error('FATAL: the connection accepted a write. Aborting.'); process.exit(2); }
  console.log('');

  console.log('══ 1 · orders NOT at Delivered that carry arrived quantities ══');
  const suspect = db.prepare(`
    SELECT po.id, po.po_number, po.status, po.date, COALESCE(po.scope,'kitchen') AS scope,
           po.copied_from_po_id,
           (SELECT COUNT(*) FROM po_line_items l WHERE l.po_id = po.id) AS lines,
           (SELECT COUNT(*) FROM po_line_items l WHERE l.po_id = po.id AND l.qty_received IS NOT NULL) AS filled,
           (SELECT COUNT(*) FROM po_line_items l WHERE l.po_id = po.id AND COALESCE(l.stock_applied_qty,0) > 0) AS applied
      FROM purchase_orders po
     WHERE po.status <> 'Delivered'
       AND EXISTS (SELECT 1 FROM po_line_items l WHERE l.po_id = po.id AND l.qty_received IS NOT NULL)
     ORDER BY po.id`).all();
  if (!suspect.length) {
    console.log('  (none — every order carrying arrived counts is at Delivered, as expected)');
    console.log('\n✓ nothing to explain\n');
    db.close();
    return;
  }
  for (const s of suspect) {
    console.log(`  ${s.po_number} · ${s.scope} · status ${s.status} · ${s.filled}/${s.lines} lines filled`
      + ` · ${s.applied} line(s) with stock applied${s.copied_from_po_id ? ' · is a kitchen copy' : ''}`);
  }

  console.log('\n══ 2 · what the activity log says happened to each ══');
  const hist = db.prepare(`
    SELECT action, username, created_at, details
      FROM activity_log
     WHERE entity_type = 'purchase_order' AND entity_id = ?
     ORDER BY id`);
  const verdicts = [];
  for (const s of suspect) {
    console.log(`\n  ── ${s.po_number} (id ${s.id}) ──`);
    const rows = hist.all(s.id);
    if (!rows.length) console.log('    (no activity_log rows at all)');
    let sawDelivered = false, sawReceive = false, sawUndo = false;
    for (const r of rows) {
      let d = {};
      try { d = JSON.parse(r.details || '{}'); } catch { d = {}; }
      const to = d.to || d.status || '';
      if (to === 'Delivered') sawDelivered = true;
      if (d.undo_receive) sawUndo = true;
      if (r.action === 'receive' || r.action === 'receipt') sawReceive = true;
      const bits = [r.action, to ? '→ ' + to : '', d.undo_receive ? '(undo receiving)' : '']
        .filter(Boolean).join(' ');
      console.log(`    ${r.created_at}  ${(r.username || '?').padEnd(12)}  ${bits}`);
    }
    verdicts.push({ s, sawDelivered, sawReceive, sawUndo, events: rows.length });
  }

  console.log('\n══ 3 · verdict ══');
  let unexplained = 0;
  for (const v of verdicts) {
    if (v.sawDelivered && v.sawUndo) {
      console.log(`  ✓ ${v.s.po_number}: went to Delivered and was undone — the counts are the`
        + ' documented leftover of /undo-receive, not something written on its own.');
    } else if (v.sawDelivered) {
      console.log(`  ✓ ${v.s.po_number}: went to Delivered at some point (seeding qty_received = qty),`
        + ' then left that status. Counts are explained.');
    } else if (v.sawReceive) {
      console.log(`  ✓ ${v.s.po_number}: a receive was saved against it — counts were entered.`);
    } else {
      unexplained++;
      console.log(`  ✗ ${v.s.po_number}: NO Delivered transition and NO receive in the log, yet`
        + ` ${v.s.filled} line(s) carry arrived quantities. Unexplained — worth treating as a bug.`);
    }
  }

  console.log('\n══ 4 · did stock actually move on these? ══');
  for (const s of suspect) {
    if (!s.applied) { console.log(`  ✓ ${s.po_number}: no stock applied`); continue; }
    const rows = db.prepare(`
      SELECT COALESCE(NULLIF(TRIM(name_en),''), name_cn) AS name, qty, qty_received, stock_applied_qty
        FROM po_line_items WHERE po_id = ? AND COALESCE(stock_applied_qty,0) > 0 ORDER BY sort_order`).all(s.id);
    console.log(`  · ${s.po_number}: ${rows.length} line(s) still hold applied stock —`);
    for (const r of rows) console.log(`      ${r.name}: ordered ${r.qty}, received ${r.qty_received}, applied ${r.stock_applied_qty}`);
  }

  console.log(`\n${unexplained ? '✗ ' + unexplained + ' order(s) unexplained' : '✓ every case is explained by a Delivered round trip'}\n`);
  db.close();
  process.exit(unexplained ? 1 : 0);
}

main();
