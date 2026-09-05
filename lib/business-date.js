// What day did this happen on, for the business it happened to?
//
// THE PROBLEM THIS EXISTS FOR
// ---------------------------
// `new Date().toISOString().slice(0,10)` is the server's day, and the server
// runs UTC. Guangzhou runs UTC+8. So anything recorded between midnight and
// eight in the morning local time is dated to the PREVIOUS day, silently, and a
// daily total never reconciles with the one the store side computes — which
// does normalise to +8, in dozens of places. `docs/tacet-core-survey.md` records
// this as risk R3, and `docs/tacet-waste-survey.md` found the whole kitchen
// waste path sitting on the wrong side of it.
//
// WHICH ZONE, AND WHY THE LOCATION RATHER THAN THE ACCOUNT
// --------------------------------------------------------
// §32 rule 12 originally said the ACCOUNT's zone. Its 2026-08-27 addendum,
// point 2, amends that to the LOCATION's, for two reasons: there is no account
// time zone in the schema and there is a per-location one
// (`retail_stores.timezone`), and the location is the better anchor regardless —
// waste always occurs somewhere, so the place is a fact about the event rather
// than a setting standing in for one, and an account spanning two zones would
// otherwise date a loss by neither of them.
//
// THE FALLBACK IS THE EXISTING ONE, NOT A NEW ONE
// -----------------------------------------------
// A location with no zone on file falls back to UTC+8 — the same default
// `lib/store-hours.js` already applies when it answers "is this store open"
// (`localMinutes(now, utcOffsetHours = 8)`). One default, two readers; a store
// whose hours resolve at +8 must not have its losses dated at UTC.
//
// Subject to §0: the zone is configuration, never a constant. The fallback is a
// fallback — the moment a location carries a zone, that zone wins, including for
// a business nowhere near China.
//
// NO WRITES, NO DB. Pure functions over a zone string.

'use strict';

// The default when a location has no zone on file. Mirrors lib/store-hours.js's
// `utcOffsetHours = 8`. Expressed as an IANA name rather than an offset so the
// same value can be handed to Intl, and so it reads as a place rather than as a
// magic number.
const SYSTEM_DEFAULT_TZ = 'Asia/Shanghai';

// 'en-CA' formats as YYYY-MM-DD, which is the shape every DATE column here
// stores and the shape string comparison sorts correctly.
const DATE_LOCALE = 'en-CA';

/**
 * The calendar date `at` falls on, in `tz`.
 *
 * An absent, empty or unrecognised zone falls back to SYSTEM_DEFAULT_TZ rather
 * than throwing — a bad string in one location's settings must not stop a loss
 * being recorded, and dating it at the house default is closer to true than
 * dating it at UTC. If even that fails (an Intl build without tz data), the
 * arithmetic fallback below is +8 applied by hand, so this function always
 * returns a date.
 *
 * @param {string|null} tz  IANA zone, e.g. 'Asia/Shanghai'
 * @param {Date} [at]       the instant; defaults to now
 * @returns {string} 'YYYY-MM-DD'
 */
function businessDate(tz, at = new Date()) {
  const zone = tz && String(tz).trim() ? String(tz).trim() : SYSTEM_DEFAULT_TZ;
  try {
    return new Intl.DateTimeFormat(DATE_LOCALE, { timeZone: zone }).format(at);
  } catch (e) {
    try {
      return new Intl.DateTimeFormat(DATE_LOCALE, { timeZone: SYSTEM_DEFAULT_TZ }).format(at);
    } catch (e2) {
      return new Date(at.getTime() + 8 * 3600000).toISOString().slice(0, 10);
    }
  }
}

/**
 * The business date for a location, read from `retail_stores.timezone`.
 *
 * A location that does not exist resolves at the system default rather than
 * throwing; the caller is responsible for having checked the location, and this
 * function's job is to always produce a date.
 *
 * @param {object} db  a tenant connection (tdb())
 * @param {number} locationId  retail_stores.id
 * @param {Date} [at]
 * @returns {string} 'YYYY-MM-DD'
 */
function businessDateForLocation(db, locationId, at = new Date()) {
  let tz = null;
  try {
    tz = db.prepare('SELECT timezone FROM retail_stores WHERE id = ?').get(locationId)?.timezone || null;
  } catch (e) { tz = null; }
  return businessDate(tz, at);
}

// ── The same day boundary, for SQL (audit A-05) ───────────────────────────
//
// The helpers above answer "what day is it" in JavaScript. Thirty-five places
// in the API ask the same question of SQLite instead, and every one of them
// asked it as the literal string `'+8 hours'` pasted into a date() modifier —
// so today's takings, the dashboard, the finance window and "new this week" all
// ended at midnight in Guangzhou for every merchant on the platform.
//
// SQLite has no timezone database. It offers 'localtime', which is the SERVER's
// zone, not the shop's, and would be wrong in a different way. So the offset is
// computed here, from the shop's IANA zone, and handed to SQLite as a modifier.
//
// MINUTES, NOT HOURS, and that is not fussiness: India is +5:30, Nepal +5:45,
// and parts of Australia +9:30. An hours-only modifier cannot express any of
// them, and would put a merchant in Kathmandu 45 minutes off their own midnight.
//
// ── THE LIMITATION, STATED ────────────────────────────────────────────────
// One offset is computed for the query and applied to every row it touches. In
// a zone that observes daylight saving, rows from the other half of the year are
// therefore bucketed an hour out — a row at 00:30 local can land on the wrong
// day. Fixing that properly needs a per-row zone conversion SQLite cannot do
// without a timezone table.
//
// It is still strictly better than what it replaces: China has no DST, so Roots
// and every other merchant in the zone are exact, and a merchant in a DST zone
// goes from "always wrong by the difference from Guangzhou" to "wrong by one
// hour, for rows near midnight, for half the year". Where exactness matters more
// than a single query — a closing figure, a tax period — use businessDate()
// above and pass the dates in.

/**
 * Minutes east of UTC for `tz` at the instant `at`. Negative west of UTC.
 *
 * Works by formatting the instant in the target zone, reading the wall-clock
 * fields back, and asking how far that clock is from UTC — which is the only
 * way to get an offset out of Intl, and correctly reflects DST at that instant.
 */
function zoneOffsetMinutes(tz, at = new Date()) {
  const zone = tz && String(tz).trim() ? String(tz).trim() : SYSTEM_DEFAULT_TZ;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at).reduce((o, p) => (o[p.type] = p.value, o), {});
    // hour comes back as '24' at midnight in some engines; %24 normalises it.
    const asIfUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)
    );
    const mins = Math.round((asIfUtc - at.getTime()) / 60000);
    // A sanity band. Real offsets run −12:00 to +14:00; anything outside it means
    // the parse went wrong, and the house default is closer to true than a number
    // that would silently shift every date on the screen.
    if (!Number.isFinite(mins) || mins < -720 || mins > 840) throw new Error('offset out of range');
    return mins;
  } catch (e) {
    return zone === SYSTEM_DEFAULT_TZ ? 480 : zoneOffsetMinutes(SYSTEM_DEFAULT_TZ, at);
  }
}

/**
 * The SQLite date-modifier that moves a stored UTC timestamp onto the shop's
 * clock — e.g. `'+480 minutes'`. Returned WITHOUT quotes, because every call
 * site interpolates it inside them: `date(placed_at, '${TZ}')`.
 */
function sqlDayShift(tz, at = new Date()) {
  const m = zoneOffsetMinutes(tz, at);
  return (m < 0 ? '-' : '+') + Math.abs(m) + ' minutes';
}

/**
 * The account's own zone, resolved the way the ADMIN SCREEN resolves it: the
 * first active location that carries one.
 *
 * Character for character the query GET /api/retail-admin/config answers with,
 * and deliberately so — that answer becomes `window.TD_TZ`, which is what every
 * timestamp on the screen is rendered in. If the server bucketed days by a
 * different rule, a row shown at 00:30 Monday could be counted into Sunday, and
 * the screen would be arguing with itself in front of the operator.
 *
 * A column that does not exist yet, or an account with no zone anywhere, returns
 * null — and null means the +8 fallback, which is what this code did before any
 * of it was per-account.
 */
function shopTimezone(db) {
  try {
    const row = db.prepare(
      `SELECT timezone FROM retail_stores
        WHERE is_active = 1 AND timezone IS NOT NULL AND TRIM(timezone) <> ''
        ORDER BY sort_order, id LIMIT 1`
    ).get();
    return (row && String(row.timezone).trim()) || null;
  } catch (e) { return null; }
}

/** sqlDayShift() for the account behind `db`. */
function sqlDayShiftForShop(db, at = new Date()) {
  return sqlDayShift(shopTimezone(db), at);
}

module.exports = {
  businessDate, businessDateForLocation, SYSTEM_DEFAULT_TZ,
  zoneOffsetMinutes, sqlDayShift, shopTimezone, sqlDayShiftForShop,
};
