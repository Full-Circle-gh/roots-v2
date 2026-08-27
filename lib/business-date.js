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

module.exports = { businessDate, businessDateForLocation, SYSTEM_DEFAULT_TZ };
