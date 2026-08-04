// Per-store opening hours, read from the store's own row (retail_stores
// open_time / close_time — the "Opens · 开门 / Closes · 关门" fields in the admin's
// store editor). Shared so background jobs read ONE source instead of each
// carrying its own copy of the hours and the timezone math.
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
// Proven equal to the raw path by scripts/verify-store-hours-seam.js.
const { seam } = require('./db-seam');
const db = seam(require('../database'));

// Re-read at most this often. These daemons run for days, and hours edited in the
// admin should take effect without a restart.
const CACHE_MS = 10 * 60_000;
let cache = null;
let cachedAt = 0;

// 'HH:MM' → minutes since midnight, or null if blank/malformed.
function parseHm(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m) return null;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return mins >= 0 && mins < 24 * 60 ? mins : null;
}

function loadAll() {
  const now = Date.now();
  if (cache && now - cachedAt < CACHE_MS) return cache;
  const fresh = {};
  try {
    for (const s of db.prepare('SELECT code, open_time, close_time FROM retail_stores').all()) {
      const open = parseHm(s.open_time);
      const close = parseHm(s.close_time);
      // Both must be set, and a close that isn't after the open is treated as
      // "not configured" rather than as an overnight window we can't honour.
      if (open != null && close != null && close > open) fresh[s.code] = { open, close };
    }
    cache = fresh;
    cachedAt = now;
  } catch {
    // Table missing / db busy — keep serving the last good read rather than
    // pretending every store is unconfigured.
  }
  return cache || fresh;
}

// { open, close } in minutes since midnight, or null when the store has no usable
// hours on file.
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

module.exports = { parseHm, storeHours, localMinutes, within };
