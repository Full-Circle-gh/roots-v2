'use strict';

// Head-of-line stall detection for the Meituan stock-push queue.
//
// The daemon's queue canary answers one question: "has the oldest stock push been
// waiting too long?" Getting that question right is harder than it looks, and the
// first version got it wrong in a way that pages ops every single morning.
//
// WHAT WENT WRONG (2026-08-23, 09:48 — 天河)
// -----------------------------------------
// The canary measured the oldest pending row's age as plain wall-clock time since
// created_at, and compared it against a two-hour threshold. But a store can only
// be pushed to while it is OPEN: 天河 trades 10:00–20:00, and the drift sweep runs
// every 30 minutes around the clock and deliberately does NOT gate on opening
// hours (it needs no browser, and re-queued rows should be waiting at the doors
// when the shop opens). So the overnight sequence is:
//
//   21:57  drift sweep re-queues 5 rows — correct, nothing can push them yet
//   ..     the store is closed; the drain skips it, as it must
//   09:45  opening hours + 15 min grace: the store becomes pushable
//   09:48  the stall check runs — BEFORE that cycle's drain — sees a row
//          created 711 minutes ago, and pages 🔴 "stock pushes are stuck"
//   09:48  ten seconds later the drain pushes all five rows
//   09:53  the next check finds an empty queue and pages ✅ "moving again"
//
// Nothing was stuck. The rows waited exactly as long as they were supposed to,
// and the canary could not tell "stuck" from "waiting for opening hours" because
// wall-clock age does not distinguish them. Red-then-green every morning, on the
// one canary that exists to catch a genuine 19-hour freeze — which is how a canary
// gets muted, and how the next real freeze goes unseen.
//
// WHAT THIS MEASURES INSTEAD
// --------------------------
// Waiting time that the store could actually have used: elapsed time while the
// store is PUSHABLE, accumulated only for as long as the SAME row sits at the head
// of the queue. Two properties fall out of that, and both are load-bearing:
//
//   • Closed hours, verify cool-downs and binding outages are parked, not counted.
//     A store that cannot be pushed to is not stalled, it is waiting — and each of
//     those states already owns its own alert.
//   • A busy queue that keeps moving never trips it. Counting "the queue has been
//     non-empty for two hours" would page a shop that is pushing all day; counting
//     "THIS row has been at the head for two hours of trading" is the real fault.
//
// The clock is per-process (the alert latch is what survives a restart), so a
// restart re-starts the measurement. That is the safe direction — it delays a page,
// it cannot fabricate one — and a daemon restarting often enough to matter is
// already covered by the browser-down and heartbeat alerts.

// One tick of the canary for one store.
//
//   state    — the previous return's `state` ({} or null on the first ever tick)
//   pushable — can the daemon push to this store RIGHT NOW (open, no cool-down,
//              binding intact)? The caller owns this; it is the same predicate the
//              drain uses, so the two can never disagree.
//   head     — the oldest push waiting to go out: { id, createdAtMs, pending } —
//              or null when nothing is eligible.
//   alerted  — is the 🔴 latch currently set for this store?
//
// Returns { state, alert, waitedMs, waitedMin, ageMin, pending, headId }, where
// alert is:
//   'page'  — the head row has burned through stallMs of pushable time
//   'clear' — the queue emptied, or the head moved on, and we owe an all-clear
//   null    — say nothing
function stallTick({ state, pushable, head, alerted = false, now = 0, stallMs = 0 } = {}) {
  const prev = state || {};
  const carry = { headId: prev.headId != null ? prev.headId : null,
                  waitedMs: prev.waitedMs || 0,
                  lastTickMs: prev.lastTickMs != null ? prev.lastTickMs : null };
  const out = (next, alert, extra) => ({
    state: next, alert: alert || null,
    waitedMs: next.waitedMs || 0,
    waitedMin: Math.round((next.waitedMs || 0) / 60_000),
    headId: next.headId,
    ...(extra || {}),
  });

  // Not pushable: park the clock (keep what we have accumulated, stop adding to
  // it) and stay quiet. Closed / cooling down / unbound is not a stall.
  if (!pushable) return out({ ...carry, lastTickMs: null }, null);

  // Nothing waiting: the backlog is gone. Whether that is good news depends on
  // HOW it went — the caller checks the retired head's final status before
  // choosing its words, because rows that burned their last attempt also vanish
  // from this window.
  if (!head) {
    return out({ headId: null, waitedMs: 0, lastTickMs: now },
      alerted ? 'clear' : null, { pending: 0, retiredHeadId: carry.headId });
  }

  const pending = head.pending || 0;
  const ageMs = head.createdAtMs != null ? Math.max(0, now - head.createdAtMs) : 0;

  // A different row at the head means the queue moved — restart the measurement.
  // Cold start (headId == null) is NOT movement: the process has simply never
  // looked before, so adopt the head silently and leave any standing latch alone
  // rather than announcing a recovery a restart cannot possibly have observed.
  if (head.id !== carry.headId) {
    const cold = carry.headId == null;
    return out({ headId: head.id, waitedMs: 0, lastTickMs: now },
      !cold && alerted ? 'clear' : null,
      { pending, ageMin: Math.round(ageMs / 60_000) });
  }

  // Same head as last tick: add the pushable time that has passed since then.
  // lastTickMs == null means we are resuming from a park, so this tick's gap is
  // closed-hours time and adds nothing. Capped by the row's real age so the
  // measurement can never claim more waiting than the row has existed for.
  const step = carry.lastTickMs == null ? 0 : Math.max(0, now - carry.lastTickMs);
  const waitedMs = Math.min(carry.waitedMs + step, ageMs);
  const next = { headId: head.id, waitedMs, lastTickMs: now };
  const extra = { pending, ageMin: Math.round(ageMs / 60_000) };

  // Only 'page' can come from here. A standing latch is cleared by evidence that
  // the queue MOVED — a new head, or an empty window — and "the same row is still
  // at the head, and my clock says 0" is not that: it is what a process that just
  // restarted mid-incident sees. Clearing on it would send the all-clear this
  // codebase already learned to distrust (see lib/alert-latch).
  if (waitedMs >= stallMs && !alerted) return out(next, 'page', extra);
  return out(next, null, extra);
}

module.exports = { stallTick };
