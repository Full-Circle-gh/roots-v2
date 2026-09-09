'use strict';

/* ══════════════════════════════════════════════════════════════════════════
   THE MOMENT THE WINDOW OPENS, AND THE MOMENT IT SHUTS — §85.
   ──────────────────────────────────────────────────────────────────────────
   Every channel's push queue is EDGE-TRIGGERED: a stock change enqueues a row,
   the daemon pushes it, done. Nothing about a clock reaching 11:00 is a stock
   change, so without this nothing would be enqueued at either edge of the
   pre-order window — the platform would keep showing the morning's allowance
   into the afternoon, selling food the kitchen has stopped making.

   ── WHY NOT LEAVE IT TO THE DRIFT SWEEP ────────────────────────────────────

   The drift sweep is the level-triggered backstop for exactly this and it WILL
   catch it — in up to thirty minutes. Half an hour of selling past a lock the
   operator set to a particular hour makes the setting a lie, and the whole
   point of `lock_hour` being adjustable is that the operator means the hour
   they typed. The sweep stays as the backstop it already was.

   ── WHY THIS IS CHEAP ENOUGH TO SIT IN A TEN-SECOND LOOP ───────────────────

   The common case is one config read and a string comparison. Nothing is
   queried, nothing is enqueued and no browser is touched unless the answer has
   actually CHANGED, which happens twice a day at most. The stamp carries the
   allowance as well as the open/shut state, so an operator editing the number
   mid-window is also a flip and also republishes — which is what they meant by
   editing it.

   ── THE FIRST OBSERVATION IS NOT A FLIP ────────────────────────────────────

   A daemon restarting at 09:00 has no previous state to compare against, and
   treating that as a flip would mass-enqueue every mapped product on every
   deploy. It records the state and does nothing; anything genuinely stale from
   the restart is the drift sweep's to find, which is its job and its cost
   profile rather than this one's.
   ══════════════════════════════════════════════════════════════════════════ */

const cadence = require('./batch-cadence');

// channel -> the last window stamp this process saw. Module state, so a daemon
// that requires this once keeps one answer per channel for its lifetime.
const _last = new Map();

/* Re-publish every listing the window applies to, if and only if the window's
   answer has changed since the last call.

   `enqueue(db, storeId, productId)` is the channel's own — each of the three
   sync libs exports one with that shape, and they carry the map/enabled/store
   gating this function has no business re-deriving.

   Returns the number of products enqueued: 0 on the overwhelmingly common
   no-change call, so a caller can log only when something happened. */
function flipTick(db, { channel, mapTable, enqueue, log = null } = {}) {
  if (!channel || !mapTable || typeof enqueue !== 'function') return 0;

  let stamp;
  try { stamp = cadence.windowStamp(db, { channel }); }
  catch (e) { return 0; }   // a config read must never take a daemon loop down

  const prev = _last.get(channel);
  _last.set(channel, stamp);
  if (prev === undefined || prev === stamp) return 0;

  /* ONLY BATCH-MADE PRODUCTS MOVE. The allowance is a statement about the
     kitchen's cooking day, and publishableAt already refuses it to anything
     else — so enqueuing a jar of olive oil here would push the number it
     already has and spend a browser slot proving it. Archived products are
     excluded for the reason the drift sweep excludes them: a listing for
     something we no longer sell is not ours to keep in step.

     The identifier is interpolated, so it is checked rather than trusted —
     the three call sites are code, but this is SQL and the rule is the rule. */
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(mapTable)) return 0;
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT m.retail_store_id, m.product_id
        FROM ${mapTable} m
        JOIN store_products p ON p.id = m.product_id
       WHERE m.sync_enabled = 1
         AND COALESCE(p.is_batch_made, 0) = 1
         AND COALESCE(p.is_active, 1) = 1
    `).all();
  } catch (e) { return 0; }

  let n = 0;
  for (const r of rows) {
    try { enqueue(db, r.retail_store_id, r.product_id); n++; }
    catch (e) { /* one bad row must not stop the rest of the republish */ }
  }
  if (n && typeof log === 'function') {
    log(`pre-order window ${stamp} — re-published ${n} fresh listing(s)`);
  }
  return n;
}

// Test seam. The module remembers per channel for the life of the process,
// which is right in a daemon and unhelpful in a suite asserting both edges.
function _reset() { _last.clear(); }

module.exports = { flipTick, _reset };
