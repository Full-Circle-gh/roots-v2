#!/usr/bin/env node
/**
 * Move counter sales left stuck at Paid to Completed (§441 follow-up).
 *
 *   node scripts/oneoff_complete_stuck_counter_sales.js          # counts, writes nothing
 *   node scripts/oneoff_complete_stuck_counter_sales.js --apply  # moves them
 *
 * ── WHAT THEY ARE ──────────────────────────────────────────────────────────
 * Before §441 (PR #1068, 2026-10-08), a counter sale marked paid through
 * PATCH /api/retail-admin/orders/:id/status — every QR order settled at the
 * till, and any counter sale marked paid from the order drawer — stayed at
 * 'paid' for good. markOrderPaid would have moved it to 'delivered' (shown as
 * Completed · 已完成) the moment it was paid; that route never did. New
 * payments are fixed; these are the ones left behind. Ash, 2026-10-08:
 * *"do both"*.
 *
 * ── WHAT THIS DOES ─────────────────────────────────────────────────────────
 * status 'paid' → 'delivered', delivered_at = the moment it was paid, for
 * rows with fulfillment_type = 'counter' — the same UPDATE markOrderPaid and
 * the status route make. Nothing else moves: the stock already left the shelf
 * when it was paid (both routes commit it then), points and referral credits
 * already ran then, and nobody is notified, for markOrderPaid's reason.
 *
 * SKIPPED, AND LISTED: a row with a refund still open (refund_status pending,
 * reviewing, approved or paying). It is left for a person to finish, not
 * moved under them.
 *
 * ONLY data/roots.db IS WRITTEN, because that is the only file
 * .github/workflows/oneoff.yml backs up before an apply. Other tenants' files
 * are opened read-only and their counts printed, so a second run can be asked
 * for if any of them has the same backlog.
 *
 * IDEMPOTENT: a second run finds nothing and says so.
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const WRITE = process.argv.includes('--apply');
const dbPath = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');
if (!fs.existsSync(dbPath)) { console.error('DB not found at', dbPath); process.exit(1); }

const STUCK_SQL = `
  SELECT o.id, o.order_no, o.store_id, o.shop_entry_method, o.paid_at, o.total, o.refund_status,
         s.name_en AS store_name
    FROM retail_orders o
    LEFT JOIN retail_stores s ON s.id = o.store_id
   WHERE o.status = 'paid' AND o.fulfillment_type = 'counter'
   ORDER BY o.paid_at, o.id`;
// The open states of database.js's refund workflow, plus 'paying' (a gateway
// refund in flight). 'paid', 'rejected' and 'withdrawn' are finished.
const OPEN_REFUND = new Set(['pending', 'reviewing', 'approved', 'paying']);
const refundUnderWay = (r) => OPEN_REFUND.has(String(r.refund_status || ''));

function summarise(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = `${r.store_name || ('store ' + r.store_id)} · ${r.shop_entry_method || 'no door'}`;
    const e = by.get(k) || { n: 0, total: 0 };
    e.n++; e.total += Number(r.total) || 0;
    by.set(k, e);
  }
  for (const [k, e] of by) console.log(`    ${k}: ${e.n} order(s), ¥${e.total.toFixed(2)}`);
  if (rows.length) console.log(`    paid between ${rows[0].paid_at} and ${rows[rows.length - 1].paid_at}`);
}

console.log(`\n${WRITE ? 'APPLYING' : 'DRY RUN'} — ${dbPath}\n`);

// ── Other tenants: read-only counts ───────────────────────────────────────
const tenantsDir = path.join(path.dirname(dbPath), 'tenants');
if (fs.existsSync(tenantsDir)) {
  for (const f of fs.readdirSync(tenantsDir).filter((n) => /^\d+\.db$/.test(n)).sort()) {
    try {
      const t = new Database(path.join(tenantsDir, f), { readonly: true, fileMustExist: true });
      const rows = t.prepare(STUCK_SQL).all();
      t.close();
      console.log(`  tenant ${f.replace('.db', '')} (read-only, not changed): ${rows.length} stuck`);
      if (rows.length) summarise(rows);
    } catch (e) {
      console.log(`  tenant ${f}: could not read (${e.message})`);
    }
  }
  console.log('');
}

// ── Roots: the one file this run may write ────────────────────────────────
const db = new Database(dbPath);
const all = db.prepare(STUCK_SQL).all();
const held = all.filter(refundUnderWay);
const todo = all.filter((r) => !refundUnderWay(r));

console.log(`Roots (data/roots.db): ${all.length} counter sale(s) at Paid.`);
if (todo.length) { console.log('  to move to Completed:'); summarise(todo); }
if (held.length) {
  console.log(`  left alone, refund under way (${held.length}):`);
  for (const r of held) console.log(`    ${r.order_no}  refund_status=${r.refund_status}`);
}
if (!todo.length) {
  console.log('\nNothing to move. Done.');
  process.exit(0);
}
console.log(`\n  order numbers: ${todo.map((r) => r.order_no).join(', ')}`);

if (!WRITE) {
  console.log(`\nDry run — nothing changed. Re-run with --apply to move exactly these ${todo.length}.`);
  process.exit(0);
}

const upd = db.prepare(
  `UPDATE retail_orders
      SET status = 'delivered',
          delivered_at = COALESCE(delivered_at, paid_at, CURRENT_TIMESTAMP),
          updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'paid' AND fulfillment_type = 'counter'`
);
const moved = db.transaction(() => todo.reduce((n, r) => n + upd.run(r.id).changes, 0))();
const left = db.prepare(STUCK_SQL).all().filter((r) => !refundUnderWay(r)).length;
console.log(`\nMoved ${moved} order(s) to Completed. Counter sales still at Paid (excluding refunds under way): ${left}.`);
process.exit(left ? 1 : 0);
