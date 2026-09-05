// A row ceiling for the lists that grow without bound (audit J-01).
//
// Sixty-three list endpoints called `.all()` with no LIMIT. Most are small
// lookup lists where it does not matter; a handful grow with use and have no
// upper bound at all — every material a merchant has ever added, every
// supplier, every recipe with all its lines, every supplier invoice, every
// product × every location. The first merchant to reach a few thousand rows in
// one of them gets a response that is slow, then one that does not arrive.
//
// ── WHY A CEILING AND NOT PAGING ──────────────────────────────────────────
// Paging is the better answer and these screens should get it. But these lists
// are read whole by their screens today — they filter, count, sort and group
// client-side — so handing them page one and nothing else would break the
// counts on every one of them, in exchange for a limit no current tenant is
// near. That is a regression today to fix a problem tomorrow.
//
// A generous ceiling does the useful half now and lies to nobody: no tenant
// reaches it, so nothing changes for anyone; the response can no longer be
// unbounded; and when a merchant DOES reach it, the screen says so in plain
// words and tells them how to see the rest, instead of quietly showing a
// fraction. `?limit=` lets a caller ask for more (up to the hard maximum) or
// less, so paging can be added screen by screen without touching the server
// again.
//
// ── THE CONTRACT ──────────────────────────────────────────────────────────
// Every endpoint using this returns, alongside its `data`:
//
//   total      — how many rows MATCH, ignoring the ceiling. The number the
//                screen's own counter should show.
//   limit      — the ceiling actually applied.
//   truncated  — true when total > data.length. The one flag a client needs;
//                a client comparing lengths itself will eventually get it
//                wrong on the day an endpoint starts filtering post-query.
//
// `truncated` is computed from `total`, never guessed from "did we get exactly
// `limit` rows" — that guess is wrong exactly when the count is a round number,
// which is the one case somebody will hit and nobody will reproduce.

'use strict';

// The default ceiling. Chosen to be far above any real tenant's list — Roots'
// largest of these is in the hundreds — and far below the point where building
// the JSON costs real memory. A merchant who genuinely holds more than this in
// one list is told, not truncated in silence.
const DEFAULT_LIMIT = 2000;

// The most a caller may ask for. A client can raise the ceiling for a
// deliberate "give me everything" read; it cannot remove it.
const MAX_LIMIT = 10000;

/**
 * Resolve `?limit` / `?offset` into a bounded window.
 *
 * A malformed limit falls back to the default rather than erroring: a truncated
 * query string should show a list, not a 400.
 */
function listWindow(query, opts = {}) {
  const def = Number.isInteger(opts.defaultLimit) ? opts.defaultLimit : DEFAULT_LIMIT;
  const max = Number.isInteger(opts.maxLimit) ? opts.maxLimit : MAX_LIMIT;
  const askedLimit = parseInt((query || {}).limit, 10);
  const limit = Number.isFinite(askedLimit) && askedLimit > 0 ? Math.min(askedLimit, max) : def;
  const askedOffset = parseInt((query || {}).offset, 10);
  const offset = Number.isFinite(askedOffset) && askedOffset > 0 ? askedOffset : 0;
  return { limit, offset };
}

/**
 * The three fields every capped list adds to its response.
 *
 * `total` is the real match count, which the caller must have queried itself —
 * it cannot be derived here, and deriving it from the returned rows is exactly
 * the bug this exists to prevent.
 */
function windowMeta({ total, limit, offset = 0, returned }) {
  return {
    total,
    limit,
    ...(offset ? { offset } : {}),
    truncated: Number(total) > Number(returned) + Number(offset || 0),
  };
}

module.exports = { listWindow, windowMeta, DEFAULT_LIMIT, MAX_LIMIT };
