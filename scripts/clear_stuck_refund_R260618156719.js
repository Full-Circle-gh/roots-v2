// One-off: clear a cancelled order stuck in the refund queue at refund_status='approved'.
//
// Order R260618156719 was approved for refund, then CANCELLED. The cancel path
// only flipped refund_status -> 'paid' when a WeChat gateway refund fired; this
// order's money was returned off-app (no gateway refund), so it stayed stuck at
// 'approved' and kept showing in the "Refund queue" badge. The money is already
// back to the customer — this just records the payout state so it leaves the queue.
//
// Safe to run once. Idempotent: only touches rows still in an OPEN refund state.
// Run ON THE SERVER, against data/roots.db. Default is dry-run.
//
//   node scripts/clear_stuck_refund_R260618156719.js          # dry run
//   node scripts/clear_stuck_refund_R260618156719.js --apply  # write

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const ORDER_NO = 'R260618156719';
const WRITE = process.argv.includes('--apply');

const dbPath = path.join(__dirname, '..', 'data', 'roots.db');
if (!fs.existsSync(dbPath)) { console.error('DB not found at', dbPath); process.exit(1); }
const db = new Database(dbPath);

const o = db.prepare(
  `SELECT id, order_no, status, refund_status, refund_amount_approved, refund_amount_paid, refund_paid_at
     FROM retail_orders WHERE order_no = ?`
).get(ORDER_NO);

if (!o) { console.error('NOT FOUND:', ORDER_NO, 'in', dbPath); process.exit(1); }

console.log('BEFORE:', o);

if (o.status !== 'cancelled') {
  console.error('Order is not cancelled (status=' + o.status + ') — aborting, this script only fixes cancelled+stuck refunds.');
  process.exit(1);
}
if (!['pending', 'reviewing', 'approved'].includes(o.refund_status)) {
  console.log('Refund status is "' + o.refund_status + '" — nothing to do (already out of the queue).');
  process.exit(0);
}

if (!WRITE) {
  console.log('\nDRY RUN — would set refund_status = "paid" (refund_paid_at = now if unset). Re-run with --apply to write.');
  process.exit(0);
}

// Clear the queue ONLY: flip refund_status and stamp the paid time for the
// audit trail. Deliberately do NOT touch refund_amount_* / payout_method — the
// money was returned off-app and the exact figure isn't asserted here.
const res = db.prepare(
  `UPDATE retail_orders
      SET refund_status  = 'paid',
          refund_paid_at = COALESCE(refund_paid_at, CURRENT_TIMESTAMP),
          updated_at     = CURRENT_TIMESTAMP
    WHERE id = ? AND refund_status IN ('pending', 'reviewing', 'approved')`
).run(o.id);

console.log('Rows updated:', res.changes);
console.log('AFTER:', db.prepare('SELECT id, order_no, status, refund_status, refund_amount_paid, refund_paid_at FROM retail_orders WHERE id = ?').get(o.id));
