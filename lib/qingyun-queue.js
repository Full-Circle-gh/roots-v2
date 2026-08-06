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

// ── An order nobody should be collecting ──────────────────────────────────
// The terminal statuses from the retail_orders enum (see database.js — the
// column comment beside `status`). Once an order reaches one of these, creating
// a courier job for it means a rider sent for something that isn't happening,
// and a delivery fee for it.
//
// This was reachable three ways, all of which the drain-side gate now closes:
//   • a queue row that never produced a copy was never retired on cancel, so it
//     pushed on the next drain;
//   • a HELD row sat pending for the length of a geocoder outage and pushed on
//     recovery, long after the order was cancelled;
//   • a manual Retry on a row skipped because the order closed re-created the
//     very job the cancel had deleted.
// 'delivered' is included on the same reasoning and matches what the ship-from
// override already treats as closed (routes/retail.js) — an order marked
// delivered by hand must not then have a rider dispatched for it.
const CLOSED_ORDER_STATUSES = ['cancelled', 'refunded', 'delivered'];
function isClosedOrderStatus(status) {
  return CLOSED_ORDER_STATUSES.includes(String(status || ''));
}

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

// Retire a row because its ORDER is closed, from either side: the drain (which
// notices on its next pass) or the cancel itself (which notices immediately).
// Clears geo_held_at so a held row stops counting toward the outage alert the
// moment the order closes rather than at the next drain.
//
// Deliberately status-agnostic: a row waiting on a confirmed point is retired
// by a cancel exactly like a pending one, so a cancelled order stops asking
// staff to point at a door nobody is delivering to.
const RETIRE_CLOSED_SQL = `
  UPDATE qingyun_push_queue
     SET status = 'skipped', last_error = ?, geo_held_at = NULL, updated_at = CURRENT_TIMESTAMP
   WHERE retail_order_id = ? AND qingyun_order_id IS NULL`;

// ── Waiting for a human to say where the door is ──────────────────────────
// The address resolves only to a coarse AREA and the order's own coordinates
// have no provenance, so nothing here knows the door to within kilometres.
// That used to be an error: five identical attempts, then a page and a dead
// row. Both halves were wrong. The coordinate was almost always minted by one
// of our own text geocodes, so nobody did anything wrong; and the geocoder's
// answer for a given address string cannot change between attempts, so the
// retries only spent the budget that would later have made the row actionable.
//
// So it parks here instead, with the point we would have sent attached, and
// waits for a person to confirm the spot. Like HOLD_SQL it writes `attempts`
// back to the value it had BEFORE the drain incremented it — the counter is for
// pushes that could have worked, and this one never could. needs_point_at is
// first-write-wins so the age is the age of the wait, not of the last drain.
//
// Guarded on qingyun_order_id IS NULL for the same compare-and-swap reason as
// MANUAL_RETRY_SQL: the row is read, then written, and a concurrent drain can
// stamp a created order in between. Parking a row that already has a copy would
// hide a live delivery behind a "needs a point" prompt.
const NEEDS_POINT_SQL = `
  UPDATE qingyun_push_queue
     SET status = 'needs_point', attempts = ?,
         guessed_lat = ?, guessed_lng = ?, guessed_precision = ?,
         needs_point_at = COALESCE(needs_point_at, CURRENT_TIMESTAMP),
         last_error = ?, geo_held_at = NULL, updated_at = CURRENT_TIMESTAMP
   WHERE id = ? AND qingyun_order_id IS NULL`;

// A person has pointed at the door. The row goes back to the front of the
// queue with a FULL attempt budget: the pushes it never got to spend were
// refused for the want of this point, and holding the old count against it
// would let an order confirmed at attempt 5 die on its first real try.
//
// The guess is cleared with the status — it described the state we just left,
// and a stale guess sitting on a pending row is the kind of phantom that gets
// read later as "this is where we're delivering".
//
// Same qingyun_order_id guard, and pinned to status='needs_point' so a double
// click (or a confirm racing the cancel that retired the row) can't drag a
// skipped or done row back into the queue. 0 rows affected says exactly that
// happened; the caller reports it rather than claiming a dispatch.
const CONFIRM_POINT_SQL = `
  UPDATE qingyun_push_queue
     SET status = 'pending', attempts = 0, last_error = NULL,
         needs_point_at = NULL,
         guessed_lat = NULL, guessed_lng = NULL, guessed_precision = NULL,
         geo_held_at = NULL, updated_at = CURRENT_TIMESTAMP
   WHERE retail_order_id = ? AND qingyun_order_id IS NULL AND status = 'needs_point'`;

// Should this push error park the row instead of failing it? True only for the
// marker lib/qingyun-payload attaches when the address could not be placed and
// the order's coordinates carry no provenance.
function shouldMarkNeedsPoint(err) {
  return !!(err && err.needsPoint === true);
}

// Is this row waiting on a point? The confirm path checks it before doing the
// work of resolving one; the SQL above is what actually guarantees it.
function awaitingPoint(row) {
  if (!row) return false;
  if (row.qingyun_order_id) return false;
  return row.status === 'needs_point';
}

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
  requeueEligible, manualRetryEligible, awaitingPoint,
  CLOSED_ORDER_STATUSES, isClosedOrderStatus,
  REQUEUE_SQL, MANUAL_RETRY_SQL, HOLD_SQL, RETIRE_CLOSED_SQL,
  NEEDS_POINT_SQL, CONFIRM_POINT_SQL,
  shouldHoldForGeocoder, shouldMarkNeedsPoint, geoHoldAlertDecision,
};
