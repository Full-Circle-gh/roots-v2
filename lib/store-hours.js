// Per-store opening hours, read from the store's own row (retail_stores
// open_time / close_time — the "Opens · 开门 / Closes · 关门" fields in the admin's
// store editor). Shared so background jobs read ONE source instead of each
// carrying its own copy of the hours and the timezone math.
//
// The row also carries sync_start_time — "Sync starts · 同步开始", the time the
// channel daemons should begin syncing that store, which is NOT the same as when
// its doors open. Waimai customers place PRE-ORDERS before opening, so a channel
// whose stock only starts moving at (open − 15 min) can serve hours-old numbers
// to the morning's pre-orders and oversell. syncWindow() below answers "when may
// this store sync" for every daemon; opening hours alone answer "is it trading".
//
// Deliberately holds no store codes and no default window: a caller that gets
// null back decides what "no hours on file" means for it. The daemons treat it as
// always-on, so a new store is never silently muted.
//
// scripts/meituan-daemon.js and scripts/shangou-daemon.js still carry their own
// copies of this logic; they can move onto this module in a later pass.

'use strict';

// Routed through the database seam (lib/db-seam.js) rather than holding the raw
// handle. No converter is installed, so this is a zero-cost passthrough and the
// read below is byte-for-byte what it was; the point is that when the unit
// converter arrives, this module is already on the covered side of the boundary.
// Proven equal to the raw path by scripts/diagnose_store_hours_seam.js.
const { seam } = require('./db-seam');
const db = seam(require('../database'));

// Re-read at most this often. These daemons run for days, and hours edited in the
// admin should take effect without a restart.
const CACHE_MS = 10 * 60_000;

// How early sync starts, in minutes before opening, for a store with no explicit
// "Sync starts · 同步开始" time on its row. Two hours: for a 10:00 shop that is
// 08:00, early enough that the pre-orders placed before the doors open are priced
// off live stock, late enough that the merchant backend is not being refreshed at
// 4am (which is a bot tell in itself). Tenants keep different hours, so this is
// only the default — a store that wants a specific clock time sets one, and a
// deployment that wants a different lead everywhere sets SYNC_PREOPEN_LEAD_MIN.
const DEFAULT_PREOPEN_LEAD_MIN = envLeadMin(process.env.SYNC_PREOPEN_LEAD_MIN) ?? 120;
let cache = null;
let cachedAt = 0;

// 'HH:MM' → minutes since midnight, or null if blank/malformed.
function parseHm(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m) return null;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return mins >= 0 && mins < 24 * 60 ? mins : null;
}

// A lead read off an env var: undefined when unset/blank/not a sane number, so a
// caller can hand it straight to syncWindow() and get the default back.
function envLeadMin(raw) {
  if (raw == null || String(raw).trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function loadAll() {
  const now = Date.now();
  if (cache && now - cachedAt < CACHE_MS) return cache;
  const fresh = {};
  try {
    // sync_start_time postdates this table, and this module also runs inside
    // long-lived daemons that may open a DB whose migration hasn't landed yet.
    // Falling back to the two-column read keeps the hours flowing instead of
    // throwing into the catch below, where every store would read "always open".
    let rows;
    try {
      rows = db.prepare('SELECT code, open_time, close_time, sync_start_time FROM retail_stores').all();
    } catch {
      rows = db.prepare('SELECT code, open_time, close_time FROM retail_stores').all();
    }
    for (const s of rows) {
      const open = parseHm(s.open_time);
      const close = parseHm(s.close_time);
      // Both must be set, and a close that isn't after the open is treated as
      // "not configured" rather than as an overnight window we can't honour.
      if (open != null && close != null && close > open) {
        fresh[s.code] = { open, close, syncStart: parseHm(s.sync_start_time) };
      }
    }
    cache = fresh;
    cachedAt = now;
  } catch {
    // Table missing / db busy — keep serving the last good read rather than
    // pretending every store is unconfigured.
  }
  return cache || fresh;
}

// { open, close, syncStart } in minutes since midnight (syncStart null when the
// store has no explicit sync start on file), or null when the store has no usable
// hours at all.
function storeHours(storeCode) {
  return loadAll()[storeCode] || null;
}

// Minutes since midnight at a fixed UTC offset (default +8, Asia/Shanghai) so the
// answer never depends on the server's own timezone.
function localMinutes(now = new Date(), utcOffsetHours = 8) {
  const shifted = new Date(now.getTime() + utcOffsetHours * 3600_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

// True when `now` falls inside [open - openGraceMin, close + closeGraceMin).
// hours = { open, close } in minutes since midnight; null hours → always true.
function within(hours, opts = {}) {
  if (!hours) return true;
  const {
    openGraceMin = 0, closeGraceMin = 0, now = new Date(), utcOffsetHours = 8,
  } = opts;
  const m = localMinutes(now, utcOffsetHours);
  return m >= (hours.open - openGraceMin) && m < (hours.close + closeGraceMin);
}

// The window the background daemons may sync in: the store's own hours, widened
// at the FRONT so stock is already current when the doors open and while
// pre-orders are being placed. Returns { open, close } for within() to judge —
// the caller keeps its own close grace, this only moves the start.
//
//   syncStart set   → that exact time, clamped so it can never be LATER than
//                     opening (a mis-typed 14:00 must not mute the morning).
//   syncStart unset → leadMin before opening (default DEFAULT_PREOPEN_LEAD_MIN),
//                     never less than the caller's own grace window.
//
// Pass the result to within() with openGraceMin: 0 — the front grace is already
// folded in here, and adding it twice would start sync earlier than the operator
// asked for.
function syncWindow(hours, opts = {}) {
  if (!hours) return null;
  const { leadMin = DEFAULT_PREOPEN_LEAD_MIN, graceMin = 0 } = opts;
  const start = hours.syncStart != null
    ? Math.min(hours.syncStart, hours.open)
    : hours.open - Math.max(leadMin, graceMin);
  return { open: Math.max(0, start), close: hours.close };
}

module.exports = {
  parseHm, storeHours, localMinutes, within, syncWindow, envLeadMin,
  DEFAULT_PREOPEN_LEAD_MIN,
};
