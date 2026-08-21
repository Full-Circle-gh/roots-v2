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
// Requeue only a row an address edit could actually have fixed, and which
// produced no copy on the courier platform.
//   • qingyun_order_id set → the order already exists over there. Re-pushing
//     would create a second one, and you'd pay for a second rider.
//   • 'pending' / 'processing' → the daemon still has it; leave it alone.
//   • 'needs_point' → the address could not be placed. Correcting it is
//     PRECISELY the thing that might place it, so the edit re-runs the lookup
//     rather than leaving the row parked against an address that no longer
//     exists. If the new text is still too vague it simply parks again.
//   • 'skipped' → deliberately retired, and left out on purpose. The reasons
//     are 'not same-city same-day' and 'order cancelled/refunded/delivered',
//     and an address edit is not evidence about either. Requeuing a CLOSED
//     order's row on an edit would hand the drain a push for an order nobody
//     is delivering — the exact failure the drain-side gate was added to close,
//     and this would walk an order straight back into it. An operator who
//     believes a retired row is eligible again presses Retry, which is a
//     judgement someone made rather than a side effect of typing in a form.
//   • 'ready' → the address resolved cleanly and we are deliberately holding the
//     order back until staff call the delivery. No copy exists, and the resolved
//     point belonged to the address that has just been edited — so re-run it, for
//     exactly the reason 'needs_point' does. Skipping this would carry a pin for a
//     deleted address all the way to the moment someone dispatches on it.
//   • 'awaiting_choice' → the name search found several places and none was
//     obvious enough to take. Correcting the address changes what is searched,
//     so the same reasoning as 'needs_point' applies exactly: re-run the lookup
//     rather than leave the row parked against a list built from text that no
//     longer exists. A list of candidates for a deleted address is worse than
//     no list, because it still looks answerable.
function requeueEligible(row) {
  if (!row) return false;
  if (row.qingyun_order_id) return false;
  return row.status === 'error' || row.status === 'needs_point'
    || row.status === 'awaiting_choice' || row.status === 'ready';
}

// Validated, no copy on the platform, waiting for someone to call the delivery.
// Deliberately NOT part of needsAttention/manualRetryEligible: this is the healthy
// resting state of every booked order, not a stuck row, and flagging it would put an
// attention badge on routine work.
function awaitingDispatch(row) {
  return !!row && !row.qingyun_order_id && row.status === 'ready';
}

// A manual retry is broader: an operator looking at a stuck row may press it,
// and 'skipped' is worth re-testing on demand because the reason may have been
// fixed (the address moved into Guangzhou, the slot became today). Still never
// for a row that already produced a copy.
//
// 'needs_point' is here so the button the drawer draws is not a lie: the drawer
// gates that button on needsAttention() below, and if the two sets drifted the
// endpoint would refuse a press the UI had just offered — and the client toasts
// "Queued — the daemon will push it within a minute" on any success, so the
// operator would be told it worked while nothing happened. Pressing it on a
// parked row with an unchanged address costs nothing (no attempt is spent) and
// simply parks it again; pressing it after fixing something is the whole point.
//
// 'awaiting_choice' is here for the same reason as 'needs_point': the drawer
// draws its Retry button off needsAttention() below, and a set that drifted
// from this one would offer a press the endpoint then refuses.
function manualRetryEligible(row) {
  if (!row) return false;
  if (row.qingyun_order_id) return false;
  return row.status === 'error' || row.status === 'skipped'
    || row.status === 'needs_point' || row.status === 'awaiting_choice';
}

// Is this a row nobody is coming for that a person can do something about?
// Deliberately the SAME set as manualRetryEligible, by delegation rather than by
// a second list that has to be kept in step: the admin drawer decides both
// whether to raise the flag and whether to draw the Retry button from this one
// answer, and a row that is flagged but not retryable is a dead end wearing an
// action's clothes. Reasons differ per status — refused, retired, waiting for a
// point — and saying which is the drawer's job, not this predicate's.
function needsAttention(row) {
  return manualRetryEligible(row);
}

// Clearing the parked fields matters as much as the status: they described the
// state we are leaving, and a guess left behind on a pending row is read later
// as "this is where we're delivering". Same clause in MANUAL_RETRY_SQL below.
const REQUEUE_SQL = `
  UPDATE qingyun_push_queue
     SET status = 'pending', attempts = 0, last_error = ?, geo_held_at = NULL,
         needs_point_at = NULL, guessed_lat = NULL, guessed_lng = NULL, guessed_precision = NULL,
         candidates_json = NULL,
         updated_at = CURRENT_TIMESTAMP
   WHERE retail_order_id = ? AND qingyun_order_id IS NULL AND status IN ('error', 'needs_point', 'awaiting_choice', 'ready')`;

// The manual button's statement. It MUST carry the same guard as REQUEUE_SQL,
// and for the same reason as a compare-and-swap: the endpoint reads the row,
// then writes it, and the daemon can complete a push in between. Guarding only
// in JS meant a Retry clicked at the wrong instant reset a row that had just
// been created on the courier platform — the next drain then created a SECOND
// 待配送 order, and you pay for the second rider. 0 rows affected is the signal
// that this happened, and the endpoint reports it as "already created".
// 'skipped' is included because an operator may legitimately re-test a row that
// was retired for a reason since fixed; 'needs_point' because the drawer offers
// the button on one (see manualRetryEligible).
const MANUAL_RETRY_SQL = `
  UPDATE qingyun_push_queue
     SET status = 'pending', attempts = 0, last_error = 'manual retry', geo_held_at = NULL,
         needs_point_at = NULL, guessed_lat = NULL, guessed_lng = NULL, guessed_precision = NULL,
         candidates_json = NULL,
         updated_at = CURRENT_TIMESTAMP
   WHERE retail_order_id = ? AND qingyun_order_id IS NULL
     AND status IN ('error', 'skipped', 'needs_point', 'awaiting_choice')`;

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

// ── Waiting for a human to say WHICH PLACE ────────────────────────────────
// A sibling of needs_point, and deliberately not a variant of it. The two
// states describe opposite situations and want opposite surfaces:
//
//   needs_point     nothing could be placed. The operator supplies the answer
//                   by tapping a map. There is no candidate, by design — a
//                   pre-placed marker is a centroid waiting to be laundered.
//   awaiting_choice the name search found real places and could not choose
//                   between them (lib/qingyun-payload POI_AUTO_SCORE). The
//                   answer is already on the screen; the operator picks it.
//
// Collapsing them would cost the distinction that makes the second one fast.
// Asking someone to tap a map when three correct-looking answers are already
// in hand is strictly more work for a strictly worse result, and asking them
// to pick from a list when the list is empty is not a question at all.
//
// Like NEEDS_POINT_SQL this writes `attempts` back to the pre-drain value —
// nothing was learned about whether a push would work — and stamps the wait
// first-write-wins so the age is the age of the wait. Same qingyun_order_id
// compare-and-swap guard, for the same reason: a concurrent drain can stamp a
// created order between the read and this write, and parking a row that
// already has a copy hides a live delivery behind a question.
const AWAITING_CHOICE_SQL = `
  UPDATE qingyun_push_queue
     SET status = 'awaiting_choice', attempts = ?,
         candidates_json = ?,
         guessed_lat = ?, guessed_lng = ?, guessed_precision = ?,
         needs_point_at = COALESCE(needs_point_at, CURRENT_TIMESTAMP),
         last_error = ?, geo_held_at = NULL, updated_at = CURRENT_TIMESTAMP
   WHERE id = ? AND qingyun_order_id IS NULL`;

// A person has picked a place. Identical in shape and reasoning to
// CONFIRM_POINT_SQL — full attempt budget back, parked fields cleared with the
// status they described, pinned to the state being left so a double click or a
// confirm racing a cancel cannot drag a skipped or done row into the queue.
//
// Pinned to 'awaiting_choice' specifically, NOT to both parked states. The two
// have different endpoints writing different provenance ('poi_picked' vs
// 'staff_pin'), and a statement that accepted either would let a stale drawer
// stamp the wrong one — a map tap recorded as a chosen POI, or the reverse.
// 0 rows affected is the signal, and the caller reports it as row_moved.
const CONFIRM_CHOICE_SQL = `
  UPDATE qingyun_push_queue
     SET status = 'pending', attempts = 0, last_error = NULL,
         needs_point_at = NULL, candidates_json = NULL,
         guessed_lat = NULL, guessed_lng = NULL, guessed_precision = NULL,
         geo_held_at = NULL, updated_at = CURRENT_TIMESTAMP
   WHERE retail_order_id = ? AND qingyun_order_id IS NULL AND status = 'awaiting_choice'`;

// None of the candidates is the place. Move the row to the OTHER parked state
// so the operator gets a map, and drop the list that was wrong.
//
// This exists because the obvious alternative does not work. Requeuing the row
// through the ordinary Retry path would send it back to the daemon, which would
// run the same name search against the same unchanged address, get the same
// candidates, and park it as 'awaiting_choice' again about a minute later. The
// operator would ask for a map, wait, and be handed the identical list — a
// silent no-op with a caption on it, which is precisely the failure the parked
// states were built to remove.
//
// So it is a direct transition instead, and it is a STATE change only: no pin
// is written, no source is stamped, no attempt is spent. The guessed_* fields
// are deliberately KEPT — they are what the map opens on, and they are still
// the best guess anyone has about where this address is.
//
// candidates_json is cleared with the status, on the same reasoning as every
// other parked field: it described the state being left, and a list left behind
// on a needs_point row would be read later as a choice someone declined to make
// rather than one they already rejected.
const REJECT_CHOICE_SQL = `
  UPDATE qingyun_push_queue
     SET status = 'needs_point', candidates_json = NULL,
         needs_point_at = COALESCE(needs_point_at, CURRENT_TIMESTAMP),
         last_error = ?, updated_at = CURRENT_TIMESTAMP
   WHERE retail_order_id = ? AND qingyun_order_id IS NULL AND status = 'awaiting_choice'`;

// Should this push error park the row for a CHOICE rather than failing it?
// True only for the marker lib/qingyun-payload attaches when the name search
// returned candidates it could not choose between.
function shouldMarkAwaitingChoice(err) {
  return !!(err && err.pickPlace === true);
}

// Is this row waiting on a choice? Same contract as awaitingPoint: the endpoint
// checks it before doing work, and the SQL above is what actually guarantees it.
function awaitingChoice(row) {
  if (!row) return false;
  if (row.qingyun_order_id) return false;
  return row.status === 'awaiting_choice';
}

// The candidates a parked row was stored with, as an array — never null, so a
// caller can iterate without guarding. A row whose JSON is absent or corrupt
// reads as "no candidates", which the drawer renders as the map surface: the
// honest fallback, since a choice cannot be offered from a list we cannot read.
function readCandidates(row) {
  if (!row || !row.candidates_json) return [];
  try {
    const v = JSON.parse(row.candidates_json);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
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

// ── A refusal that four more tries cannot fix ─────────────────────────────
// Qingyun refuses a recipient phone it doesn't like with
// `40001 请输入合法的收货人电话`. Retrying spends four more attempts on a value
// that cannot change between them, and delays the ops page by however long the
// backoff takes — for the one failure a human could fix in seconds if told.
//
// CONSERVATIVE ON PURPOSE. Being wrong in this direction costs a real order:
// a transient failure misread as permanent gives up after one try instead of
// five. So all three of these must hold, and anything else keeps the normal
// five-attempt behaviour:
//   • Qingyun actually answered (a structured code came back) — a network drop
//     or a geocoder error whose text happens to mention a phone is not this;
//   • the message names the RECIPIENT (收货人/收件人/recipient), and
//   • the message names a PHONE (电话/手机/phone/mobile).
// The code is deliberately not part of the test: 40001 is Qingyun's generic
// invalid-parameter code and identifies nothing on its own, while the message
// is the evidence. If they ever change the code, this still works; if they
// change the message, we fall back to retrying, which is the safe direction.
const NAMES_RECIPIENT = /收货人|收件人|recipient/i;
const NAMES_PHONE     = /电话|手机|phone|mobile/i;
function isRecipientPhoneRejection(err) {
  if (!err) return false;
  if (err.qyCode == null) return false;
  const msg = String(err.qyMsg || '');
  if (!msg) return false;
  return NAMES_RECIPIENT.test(msg) && NAMES_PHONE.test(msg);
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

// What a failed push attempt should DO — the whole decision in one pure place,
// so the "one attempt vs five" rule can be tested without a browser, a courier
// account or a five-minute drain loop.
//
//   { status, lastError, phoneRefused }
//
// `attemptsBefore` is the row's attempts value BEFORE the drain incremented it,
// matching what the daemon holds. Geocoder holds never reach here — the caller
// checks shouldHoldForGeocoder first, because a hold has to give the attempt
// back and this function only ever moves forward.
function pushFailureOutcome({ err, attemptsBefore = 0, maxAttempts = 5 } = {}) {
  const phoneRefused = isRecipientPhoneRejection(err);
  const attempts = attemptsBefore + 1;
  return {
    phoneRefused,
    attempts,
    // A phone Qingyun has already refused cannot pass on the next try, so the
    // remaining attempts are dead time in front of a page someone can act on.
    status: (phoneRefused || attempts >= maxAttempts) ? 'error' : 'pending',
    // The drawer's refusal panel prints this verbatim under "Push refused", so
    // it names the problem AND the fix. The raw Qingyun text stays on the end:
    // it is the evidence, and it is what staff would search for.
    lastError: phoneRefused
      ? `recipient phone refused by Qingyun — fix the number in Edit ship-to, then Retry (code ${err && err.qyCode}, ${err && err.qyMsg})`
      : String((err && err.message) || 'push failed'),
  };
}

module.exports = {
  requeueEligible, manualRetryEligible, needsAttention, awaitingPoint, awaitingDispatch,
  awaitingChoice, readCandidates,
  pushFailureOutcome,
  CLOSED_ORDER_STATUSES, isClosedOrderStatus,
  REQUEUE_SQL, MANUAL_RETRY_SQL, HOLD_SQL, RETIRE_CLOSED_SQL,
  NEEDS_POINT_SQL, CONFIRM_POINT_SQL,
  AWAITING_CHOICE_SQL, CONFIRM_CHOICE_SQL, REJECT_CHOICE_SQL,
  shouldHoldForGeocoder, shouldMarkNeedsPoint, shouldMarkAwaitingChoice,
  geoHoldAlertDecision, isRecipientPhoneRejection,
};
