'use strict';

// ── Reading a cancel that the platform never tells us about ──────────────────
//
// 青云聚信 exposes no cancel signal the daemon can read. It polls the order-list
// tabs that hold an ACTIVE delivery (待配送 / 待抢单 / 待取货 / 配送中) and the 完成
// tab, and a cancelled order is in none of them. So when staff cancel a rider in
// the Qingyun app, the order simply stops being returned by everything we look
// at, `delivery_jobs` is never written again, and the row FREEZES at whatever
// stage it last held.
//
// What that looked like before this file existed: order TC000823, 2026-09-22.
// The rider was cancelled; the drawer went on saying "Rider coming · 骑手前往取货"
// under 葛师傅's name and phone number, and the only hint that anything had
// happened was the amber "Not updating — the rider may have cancelled" line,
// which is a GUESS about a frozen timestamp and says so in its own wording.
//
// The read here is by ELIMINATION, and it is sound only under a precondition
// the caller must establish: the poll saw the platform's WHOLE list. order/list
// is paged and the daemon reads page 1, so an order can be absent because it
// was cancelled OR because twenty newer ones pushed it off the page — the same
// observation, two meanings. `complete` is the caller's assertion that every tab
// answered and none of them filled its page. Without it this function does
// nothing at all, which is the right failure: a missed cancel costs a stale card
// for one more poll, and a wrongly-called one takes the live map and the rider's
// phone number away from staff while the rider is on the road.
//
// The grace window is the second guard. One missed poll is not a cancel — a list
// that raced a write, a tab that re-ordered mid-read — so the first miss only
// STAMPS `missing_since`, and the conclusion waits for the window to pass with
// the order still absent. Being seen again clears the stamp outright.
//
// Deliberately NOT done here: re-queueing the order for a new courier. Cancelling
// a rider is nearly always a decision somebody made — the shop is short, the
// customer moved the day, the address was wrong — and a system that answers a
// deliberate cancel by dispatching another rider is arguing with the person who
// cancelled. The cancel is SURFACED (the drawer offers "Call another courier");
// pressing it stays a human's call.

// Jobs this store is tracking that could still be cancelled: in-flight (never
// delivered), not already concluded, and not a superseded copy — a superseded row
// is an abandoned delivery the ship-from move left behind, which is EXPECTED to
// vanish from the old store's list and must never be reported as a cancel.
const OPEN_JOBS_SQL = `
  SELECT id, qingyun_order_id, retail_order_id, order_status, missing_since
    FROM delivery_jobs
   WHERE store_code = ?
     AND COALESCE(superseded, 0) = 0
     AND cancelled_at IS NULL
     AND (order_status IS NULL OR order_status < 50)`;

// Rows this sweep may touch are keyed by qingyun_order_id (the platform's own id,
// UNIQUE on the table), never by roots order id: an order can carry more than one
// delivery over its life and only the one that vanished is being concluded.
function markSeen(db, qingyunOrderId) {
  return db.prepare(
    `UPDATE delivery_jobs SET missing_since = NULL
      WHERE qingyun_order_id = ? AND missing_since IS NOT NULL`
  ).run(String(qingyunOrderId)).changes > 0;
}

function markMissing(db, qingyunOrderId, nowIso) {
  return db.prepare(
    `UPDATE delivery_jobs SET missing_since = ?
      WHERE qingyun_order_id = ? AND missing_since IS NULL`
  ).run(nowIso, String(qingyunOrderId)).changes > 0;
}

// The conclusion. `updated_at` is deliberately left alone: it means "when the
// platform last told us something", and the platform has told us nothing — it is
// what the drawer's "updated 15m ago" prints and what the ETA-fallback sweep
// reads for freshness, and moving it here would make a cancelled job look freshly
// tracked. cancelled_at is the new fact and carries its own clock.
function markCancelled(db, qingyunOrderId, nowIso) {
  return db.prepare(
    `UPDATE delivery_jobs SET cancelled_at = ?
      WHERE qingyun_order_id = ? AND cancelled_at IS NULL`
  ).run(nowIso, String(qingyunOrderId)).changes > 0;
}

// Naive-UTC tolerant: SQLite hands back "YYYY-MM-DD HH:MM:SS" with no zone, and a
// bare `new Date()` on that reads it as LOCAL — which on the Beijing host makes a
// stamp written moments ago look eight hours old, and would conclude a cancel on
// the very first miss. Same normalisation the drawer's courierAgeMs does.
function parseStamp(v) {
  if (!v) return NaN;
  const s = String(v);
  const hasZone = /[zZ]|[+-]\d\d:?\d\d$/.test(s);
  return new Date(hasZone ? s : s.replace(' ', 'T') + 'Z').getTime();
}

/**
 * Apply one poll's observation to this store's open delivery jobs.
 *
 * @param db              better-sqlite3 handle (already tenant-scoped)
 * @param opts.storeCode  the store whose jobs this poll covers
 * @param opts.seen       Set of qingyun_order_id strings the poll found, at ANY
 *                        stage — including delivered. An order that reached 50
 *                        between two polls has completed, not vanished.
 * @param opts.complete   true only when every tab answered and none filled its
 *                        page. False ⇒ this function is a no-op by design.
 * @param opts.now        Date (injectable for tests).
 * @param opts.graceMs    how long a job may be missing before it is cancelled.
 * @returns { cancelled: [...], missing: [...], skipped: 'incomplete'|null }
 */
function applyVanishSweep(db, opts) {
  const { storeCode, seen, complete, now = new Date(), graceMs = 3 * 60_000 } = opts || {};
  if (!complete) return { cancelled: [], missing: [], skipped: 'incomplete' };

  const nowIso = now.toISOString();
  const seenSet = seen instanceof Set ? seen : new Set(seen || []);
  let jobs;
  try { jobs = db.prepare(OPEN_JOBS_SQL).all(storeCode); }
  catch (e) {
    // Column missing ⇒ this tenant has not run the migration yet. Tracking is
    // unaffected; the sweep simply does not run until the columns exist.
    if (/no such column|no such table/i.test(e.message)) return { cancelled: [], missing: [], skipped: 'unmigrated' };
    throw e;
  }

  const cancelled = [], missing = [];
  for (const job of jobs) {
    const id = String(job.qingyun_order_id);
    if (seenSet.has(id)) { markSeen(db, id); continue; }

    if (!job.missing_since) {
      markMissing(db, id, nowIso);
      missing.push(job);
      continue;
    }
    const since = parseStamp(job.missing_since);
    // An unparseable stamp must not conclude a cancel on this poll — re-stamp it
    // and let the window run from a value we can actually read.
    if (!isFinite(since)) {
      db.prepare('UPDATE delivery_jobs SET missing_since = ? WHERE qingyun_order_id = ?').run(nowIso, id);
      missing.push(job);
      continue;
    }
    if (now.getTime() - since < graceMs) { missing.push(job); continue; }
    if (markCancelled(db, id, nowIso)) cancelled.push(job);
  }
  return { cancelled, missing, skipped: null };
}

module.exports = { applyVanishSweep, OPEN_JOBS_SQL };
