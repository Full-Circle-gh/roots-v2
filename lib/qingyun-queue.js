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
     SET status = 'pending', attempts = 0, last_error = ?, geo_held_at = NULL, updated_at = CURRENT_TIMESTAMP
   WHERE retail_order_id = ? AND qingyun_order_id IS NULL AND status = 'error'`;

// The manual button's statement. It MUST carry the same guard as REQUEUE_SQL,
// and for the same reason as a compare-and-swap: the endpoint reads the row,
// then writes it, and the daemon can complete a push in between. Guarding only
// in JS meant a Retry clicked at the wrong instant reset a row that had just
// been created on the courier platform — the next drain then created a SECOND
// 待配送 order, and you pay for the second rider. 0 rows affected is the signal
// that this happened, and the endpoint reports it as "already created".
// 'skipped' is included because an operator may legitimately re-test a row that
// was retired for a reason since fixed.
const MANUAL_RETRY_SQL = `
  UPDATE qingyun_push_queue
     SET status = 'pending', attempts = 0, last_error = 'manual retry', geo_held_at = NULL,
         updated_at = CURRENT_TIMESTAMP
   WHERE retail_order_id = ? AND qingyun_order_id IS NULL AND status IN ('error', 'skipped')`;

// ── Held on a geocoder outage ─────────────────────────────────────────────
// A push that failed because the GEOCODER was unreachable learned nothing about
// the order, so it must not spend an attempt: `attempts` is written back to the
// value it had before the drain incremented it, and geo_held_at records when the
// hold started (first hold wins, so the age is the age of the outage).
const HOLD_SQL = `
  UPDATE qingyun_push_queue
     SET status = 'pending', attempts = ?, last_error = ?,
         geo_held_at = COALESCE(geo_held_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
   WHERE id = ?`;

// Should this push error be treated as a hold rather than a refusal? True only
// for the marker lib/qingyun-payload attaches when the geocoder itself failed.
function shouldHoldForGeocoder(err) {
  return !!(err && err.geoHold === true);
}

// One page per outage, not one per order per drain.
//   { alert: 'page' } — enough orders have been held long enough, and we haven't
//                       paged recently
//   { alert: 'clear' } — nothing is held any more and we had paged
//   { alert: null }    — say nothing
// Pure: the caller supplies the clock and the previous state, so the throttle is
// testable without waiting fifteen minutes.
function geoHoldAlertDecision({
  heldCount = 0, oldestHeldMs = null, alerted = false, lastAlertMs = null, now = 0,
  thresholdMin = 10, everyMin = 15,
} = {}) {
  if (!heldCount) return { alert: alerted ? 'clear' : null };
  if (oldestHeldMs == null || (now - oldestHeldMs) < thresholdMin * 60_000) return { alert: null };
  if (lastAlertMs != null && (now - lastAlertMs) < everyMin * 60_000) return { alert: null };
  return { alert: 'page', heldCount, heldMin: Math.round((now - oldestHeldMs) / 60_000) };
}

module.exports = {
  requeueEligible, manualRetryEligible,
  REQUEUE_SQL, MANUAL_RETRY_SQL, HOLD_SQL,
  shouldHoldForGeocoder, geoHoldAlertDecision,
};
