// When a refused courier push may be put back in the queue.
//
// scripts/qingyun-daemon.js drains `status='pending'` and gives up after
// QINGYUN_PUSH_MAX_ATTEMPTS, flipping the row to 'error'. Nothing reset it: the
// enqueue hook is INSERT OR IGNORE against a UNIQUE retail_order_id, so it could
// never re-add one either. An order the push refused — because its drop-off pin
// couldn't be trusted — was therefore inert forever, and correcting the address
// that caused the refusal changed nothing at all. That is the difference between
// "we caught a bad address" and "we silently dropped an order".
//
// The predicate is here, apart from the SQL, so it can be reasoned about and
// tested on its own.

'use strict';

// row: a qingyun_push_queue row (status, qingyun_order_id).
// Requeue only a row that FAILED and produced no copy on the courier platform.
//   • qingyun_order_id set → the order already exists over there. Re-pushing
//     would create a second one, and you'd pay for a second rider.
//   • 'pending' / 'processing' → the daemon still has it; leave it alone.
//   • 'skipped' → deliberately retired (not same-city, not same-day, order
//     closed). An address edit doesn't make it eligible again; the enqueue
//     sweep decides that.
function requeueEligible(row) {
  if (!row) return false;
  if (row.qingyun_order_id) return false;
  return row.status === 'error';
}

// A manual retry is broader: an operator looking at a refused row may press it,
// and 'skipped' is worth re-testing on demand because the reason may have been
// fixed (the address moved into Guangzhou, the slot became today). Still never
// for a row that already produced a copy.
function manualRetryEligible(row) {
  if (!row) return false;
  if (row.qingyun_order_id) return false;
  return row.status === 'error' || row.status === 'skipped';
}

const REQUEUE_SQL = `
  UPDATE qingyun_push_queue
     SET status = 'pending', attempts = 0, last_error = ?, updated_at = CURRENT_TIMESTAMP
   WHERE retail_order_id = ? AND qingyun_order_id IS NULL AND status = 'error'`;

module.exports = { requeueEligible, manualRetryEligible, REQUEUE_SQL };
