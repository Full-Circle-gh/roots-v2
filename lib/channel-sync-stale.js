'use strict';

// "Has a sales channel stopped accepting stock updates?" — one answer shared by
// Meituan, Eleme and GZ Grocery, because all three fan out from the same place
// (lib/inventory.js's enqueueChannelSync) into the same shape of queue table.
// The declared channel list below is the ONE place that knows there are three
// of them; a fourth channel is a new entry here, not an edit at every call site.
//
// This deliberately does NOT reuse lib/meituan-queue-stall.js. That module
// accumulates waited-time tick-by-tick inside a long-running daemon loop (see
// its own header comment) — it has no meaning called once, from a process with
// no ticking loop of its own, which is what the dashboard route is. This file
// answers the same question — "how much time has this row been waiting that
// the channel could actually have used" — as a one-shot calculation over
// [created_at, now] instead. lib/meituan-queue-stall.js is untouched and still
// drives Meituan's own 120-minute canary independently; two thresholds on two
// surfaces is intended, not a duplicate.

const { storeHours } = require('./store-hours');
const { isStoreTradingOnChannel } = require('./store-trading');

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// How long the oldest unresolved row may wait (of time the channel could
// actually have used) before its channel counts as stale. One named constant,
// expected to get tuned.
const STALE_THRESHOLD_MS = 3 * MINUTE_MS;

// key          — matches the channel's admin tab id (#tab-<key>), used for the
//                Needs-you row's deep link (goTab(key) on desktop).
// label        — EN display name; the card composes its own bilingual copy
//                (cuT) from this rather than the server sending translated text.
// queueTable   — the channel's own *_sync_queue table. Identical schema across
//                all three (store_code, status, created_at), so one query
//                template covers every entry in this list.
// hoursAware   — true: elapsed time counts only during the store's open hours
//                (same source, lib/store-hours.js, that Meituan's and Eleme's
//                own daemons already gate pushes on). false: this channel has
//                no open-hours concept anywhere in its code today (GZ
//                Grocery/Guanyi never reads store hours) — plain wall-clock
//                elapsed time instead of inventing a definition for it.
// openGraceMin — mirrors each daemon's own grace window, so a row here doesn't
//                read stale in the same few minutes the daemon itself still
//                treats as closed.
const CHANNELS = [
  { key: 'meituan', label: 'Meituan', queueTable: 'meituan_sync_queue', hoursAware: true, openGraceMin: 15 },
  { key: 'eleme', label: 'Eleme', queueTable: 'eleme_sync_queue', hoursAware: true, openGraceMin: 30 },
  { key: 'guanyi', label: 'GZ Grocery', queueTable: 'guanyi_sync_queue', hoursAware: false, openGraceMin: 0 },
];

// Midnight (Asia/Shanghai, fixed UTC+8) on-or-before `ms`, as an absolute ms
// timestamp. Same fixed-offset convention as lib/store-hours.js's own
// localMinutes(), so this and the daemons' open/closed gate can never disagree
// about what day it is.
function shanghaiDayStartMs(ms) {
  const shifted = ms + 8 * 3600_000;
  return Math.floor(shifted / DAY_MS) * DAY_MS - 8 * 3600_000;
}

// Milliseconds of [fromMs, toMs) that fall inside the store's opening window
// (expanded by graceMin on each side), walking one Shanghai calendar day at a
// time. `hours` null → no hours on file → always open, the same default
// lib/store-hours.js's own within() uses.
function pushableElapsedMs(fromMs, toMs, hours, graceMin) {
  if (toMs <= fromMs) return 0;
  if (!hours) return toMs - fromMs;
  let total = 0;
  for (let dayStart = shanghaiDayStartMs(fromMs); dayStart < toMs; dayStart += DAY_MS) {
    const winOpen = dayStart + Math.max(0, hours.open - graceMin) * MINUTE_MS;
    const winClose = dayStart + (hours.close + graceMin) * MINUTE_MS;
    const segStart = Math.max(fromMs, winOpen);
    const segEnd = Math.min(toMs, winClose);
    if (segEnd > segStart) total += segEnd - segStart;
  }
  return total;
}

// SQLite's CURRENT_TIMESTAMP comes back as 'YYYY-MM-DD HH:MM:SS' with no zone
// marker — it IS UTC, so parsing it as local time (what a bare `new Date(str)`
// does) reads hours ahead, exactly the bug just fixed in the Eleme activity log
// (routes/eleme-admin.js). Same fix here: force UTC before parsing.
function parseUtc(sqliteStamp) {
  const t = Date.parse(String(sqliteStamp).replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? t : null;
}

// One row per channel whose oldest pending/error push has sat unresolved past
// STALE_THRESHOLD_MS of time the channel could actually have used to send it.
// Empty array is the common case. Sorted oldest-first. A single channel's
// table being missing/busy drops just that channel, not the whole result.
function channelSyncStale(db, nowMs = Date.now()) {
  const out = [];
  for (const ch of CHANNELS) {
    // "Unresolved" means the LATEST queue row for a given (store, product)
    // target is still pending/error — not "any row ever marked error". A
    // channel that has been running a while accumulates error rows nobody
    // deletes (a target that fails is later re-queued by the drift sweep with
    // a fresh row; the failed one is left behind as history), so a plain
    // MIN(created_at) over every pending/error row ever written finds ancient
    // dead rows and never clears. Verified against production: one Meituan
    // target sat in this shape from 2026-06-27 to 2026-08-23 before a later
    // re-queue finally succeeded — the June row is still in the table.
    // ROW_NUMBER() picks each target's own most recent row (by id, which
    // tracks insertion order / created_at); only rn=1 rows are live candidates.
    const LATEST_CTE = `
      WITH latest AS (
        SELECT store_code, status, created_at,
               ROW_NUMBER() OVER (PARTITION BY retail_store_id, product_id ORDER BY id DESC) AS rn
        FROM ${ch.queueTable}
      )`;
    let head, waitingCount;
    try {
      // A location that is not TRADING on this channel is out of scope entirely
      // — its rows are not counted and its age is not measured. This is a
      // different question from opening hours above: hours decide when the three
      // minutes accrue for a trading store; this decides whether the store is in
      // the check at all. A store switched off indefinitely will hold its queued
      // pushes forever by design, and a row that can never clear is one an
      // operator learns to ignore — which costs the alert its meaning for the
      // stores that ARE trading. Never mirrored locally: lib/store-trading.js is
      // the single predicate, so this and the daemons' own push gates cannot
      // drift apart.
      const trading = db.prepare('SELECT code FROM retail_stores WHERE is_active = 1').all()
        .map(s => s.code)
        .filter(code => isStoreTradingOnChannel(db, code, ch.key));
      // No trading location left on this channel → no row for it at all.
      if (!trading.length) continue;
      const ph = trading.map(() => '?').join(',');

      head = db.prepare(`${LATEST_CTE}
        SELECT store_code, created_at FROM latest
         WHERE rn = 1 AND status IN ('pending','error') AND store_code IN (${ph})
         ORDER BY created_at ASC LIMIT 1`
      ).get(...trading);
      if (!head) continue;
      waitingCount = (db.prepare(`${LATEST_CTE}
        SELECT COUNT(*) AS n FROM latest
         WHERE rn = 1 AND status IN ('pending','error') AND store_code IN (${ph})`
      ).get(...trading) || {}).n || 0;
    } catch {
      continue;
    }
    const createdAtMs = parseUtc(head.created_at);
    if (createdAtMs == null) continue;

    const hours = ch.hoursAware ? storeHours(head.store_code) : null;
    const elapsedMs = ch.hoursAware
      ? pushableElapsedMs(createdAtMs, nowMs, hours, ch.openGraceMin)
      : Math.max(0, nowMs - createdAtMs);
    if (elapsedMs < STALE_THRESHOLD_MS) continue;

    out.push({ channel: ch.key, label: ch.label, waiting_count: waitingCount, oldest_at: head.created_at });
  }
  out.sort((a, b) => String(a.oldest_at).localeCompare(String(b.oldest_at)));
  return out;
}

module.exports = { channelSyncStale, CHANNELS, STALE_THRESHOLD_MS };
