// One-off backfill: bump refund_amount_requested up to refund_amount_paid where
// a staff multi-refund left "requested" lagging behind what was actually paid.
//
// Before the accumulation fix, /refund/direct kept refund_amount_requested
// COALESCE'd at the FIRST refund's amount (e.g. ¥44) while later partial refunds
// accumulated into refund_amount_approved/paid (e.g. ¥128). The drawer refund
// panel reads refund_amount_requested for its REQUESTED figure, so it showed a
// stale ¥44 next to APPROVED/PAID ¥128. Code now uses MAX(requested, approved);
// this repairs already-settled rows.
//
// Idempotent + safe: only raises requested to paid when paid is larger; never
// lowers it, never touches money/payout fields. Dry-run by default.
//
//   node scripts/backfill_refund_requested_to_paid.js          # dry run
//   node scripts/backfill_refund_requested_to_paid.js --apply  # write

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const WRITE = process.argv.includes('--apply');

const dbPath = path.join(__dirname, '..', 'data', 'roots.db');
if (!fs.existsSync(dbPath)) { console.error('DB not found at', dbPath); process.exit(1); }
const db = new Database(dbPath);

const rows = db.prepare(
  `SELECT id, order_no, refund_status,
          refund_amount_requested, refund_amount_approved, refund_amount_paid
     FROM retail_orders
    WHERE refund_amount_paid IS NOT NULL
      AND COALESCE(refund_amount_requested, 0) + 0.005 < refund_amount_paid
    ORDER BY id ASC`
).all();

if (!rows.length) { console.log('Nothing to fix — no orders where requested lags paid.'); process.exit(0); }

console.log('Orders to fix (' + rows.length + '):');
for (const r of rows) {
  console.log('  ' + r.order_no + ': requested ' + r.refund_amount_requested +
    ' -> ' + r.refund_amount_paid + ' (approved ' + r.refund_amount_approved + ', status ' + r.refund_status + ')');
}

if (!WRITE) { console.log('\nDRY RUN — re-run with --apply to write.'); process.exit(0); }

const upd = db.prepare(
  `UPDATE retail_orders
      SET refund_amount_requested = refund_amount_paid,
          updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND COALESCE(refund_amount_requested, 0) + 0.005 < refund_amount_paid`
);
let n = 0;
const tx = db.transaction(() => { for (const r of rows) n += upd.run(r.id).changes; });
tx();
console.log('\nRows updated:', n);
