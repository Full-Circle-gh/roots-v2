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
// THERE IS NO FALLBACK ZONE (decisions §82, step 3 full, 2026-10-18)
// -------------------------------------------------------------------
// These helpers used to answer a missing or unreadable zone with Guangzhou's —
// "closer to true than UTC" — and that is exactly how a shop with no zone ran
// for months looking right. A zone is configuration, never a constant: a
// location's own, else the shop's (shopTimezone), and if neither is readable
// the answer is NoShopTimezoneError, not a guess. The startup check
// (lib/tenant-zone-check.js) names such a shop; checkout and the shop-local jobs
// refuse it before they get here.
//
// NO WRITES. Pure functions over a zone string, except the two readers that take
// a db to find the zone (businessDateForLocation, shopTimezone).

'use strict';

// Roots' zone, and the first one the setup wizard offers. NOT A FALLBACK any
// more: nothing below substitutes it for a missing zone. Kept because a fresh
// database seeds Roots' stores with it and screens name it.
const SYSTEM_DEFAULT_TZ = 'Asia/Shanghai';

// A zone that is missing, blank, or one the runtime cannot read. Carries the
// same code checkout refuses with, so a route that lets it escape still says
// what is wrong.
class NoShopTimezoneError extends Error {
  constructor(tz) {
    super(tz == null || !String(tz).trim()
      ? 'This shop has no time zone set (Settings → Stores) — decisions §82'
      : `This shop's time zone ${JSON.stringify(String(tz))} is not one the server can read (Settings → Stores) — decisions §82`);
    this.name = 'NoShopTimezoneError';
    this.code = 'shop_timezone_missing';
  }
}

/** null when `tz` is a zone the runtime can use; otherwise 'missing' or 'invalid'. */
function zoneProblem(tz) {
  if (tz == null || !String(tz).trim()) return 'missing';
  try { new Intl.DateTimeFormat('en-US', { timeZone: String(tz).trim() }); return null; }
  catch (e) { return 'invalid'; }
}

/** `tz`, trimmed, when it is a readable zone; NoShopTimezoneError otherwise. */
function requireZone(tz) {
  if (zoneProblem(tz)) throw new NoShopTimezoneError(tz);
  return String(tz).trim();
}

// 'en-CA' formats as YYYY-MM-DD, which is the shape every DATE column here
// stores and the shape string comparison sorts correctly.
const DATE_LOCALE = 'en-CA';

/**
 * The calendar date `at` falls on, in `tz`.
 *
 * A missing or unreadable zone is NoShopTimezoneError (§82): there is no house
 * default to date it at.
 *
 * @param {string|null} tz  IANA zone, e.g. 'Asia/Shanghai'
 * @param {Date} [at]       the instant; defaults to now
 * @returns {string} 'YYYY-MM-DD'
 */
function businessDate(tz, at = new Date()) {
  return new Intl.DateTimeFormat(DATE_LOCALE, { timeZone: requireZone(tz) }).format(at);
}

/**
 * The business date for a location: its own `retail_stores.timezone` when that
 * is readable, else the shop's (shopTimezone) — a store with no zone of its own
 * is in the shop's. Neither readable is NoShopTimezoneError (§82).
 *
 * @param {object} db  a tenant connection (tdb())
 * @param {number} locationId  retail_stores.id
 * @param {Date} [at]
 * @returns {string} 'YYYY-MM-DD'
 */
function businessDateForLocation(db, locationId, at = new Date()) {
  return businessDate(zoneForLocation(db, locationId), at);
}

/** A location's zone: its own when readable, else the shop's. May be null. */
function zoneForLocation(db, locationId) {
  let tz = null;
  try {
    tz = db.prepare('SELECT timezone FROM retail_stores WHERE id = ?').get(locationId)?.timezone || null;
  } catch (e) { tz = null; }
  return zoneProblem(tz) ? shopTimezone(db) : String(tz).trim();
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
  const zone = requireZone(tz);
  {
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
    // the parse went wrong, and a number that would silently shift every date on
    // the screen is worse than saying so.
    if (!Number.isFinite(mins) || mins < -720 || mins > 840) throw new Error(`offset for ${zone} out of range: ${mins}`);
    return mins;
  }
}

/**
 * The WALL-CLOCK fields of `at`, as read in `tz`. The replacement for
 * `d.getFullYear()` / `.getMonth()` / `.getDate()` / `.getHours()` /
 * `.getMinutes()`, which read the HOST's clock and are forbidden anywhere a
 * cutoff, date or slot is computed (§82).
 *
 * Returns `{ y, m, d, hour, minute, ymd }` — `m` 1-based, `ymd` the same
 * 'YYYY-MM-DD' string businessDate() would give, so a caller needs one call
 * rather than two that could straddle a tick.
 *
 * A missing or unreadable zone is NoShopTimezoneError (§82). Checkout refuses a
 * shop with no zone before it gets here, so a cutoff never throws mid-order.
 */
function zoneParts(tz, at = new Date()) {
  const zone = requireZone(tz);
  const build = (y, m, d, hour, minute) => ({
    y, m, d, hour, minute,
    ymd: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
  });
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(at).reduce((o, x) => (o[x.type] = x.value, o), {});
  // '24' at midnight in some engines, exactly as zoneOffsetMinutes guards for.
  return build(Number(p.year), Number(p.month), Number(p.day),
    Number(p.hour) % 24, Number(p.minute));
}

/**
 * The instant at which the wall clock in `tz` reads `ymd` at `hh:mm`. The
 * inverse of zoneParts(), and the replacement for `new Date(y, m, d, hh, mm)`,
 * which builds against the HOST's zone.
 *
 * Two passes, and the second is not belt-and-braces. The offset to apply is the
 * offset AT THE RESULTING INSTANT, which is not known until the instant is
 * built — so the first pass guesses with the offset at `ymd` midday UTC and the
 * second corrects it. They differ only across a DST boundary, which is exactly
 * when a single pass would place a slot an hour out.
 *
 * `ymd` malformed returns null; every caller already branches on a null date.
 */
function dateInZone(tz, ymd, hh = 0, mm = 0) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const wall = Date.UTC(y, mo - 1, d, Number(hh) || 0, Number(mm) || 0);
  let inst = new Date(wall - zoneOffsetMinutes(tz, new Date(Date.UTC(y, mo - 1, d, 12))) * 60000);
  inst = new Date(wall - zoneOffsetMinutes(tz, inst) * 60000);
  return inst;
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
 * null — and null is not a zone: the helpers above refuse it (§82).
 */
function shopTimezone(db) {
  try {
    const row = db.prepare(
      `SELECT timezone FROM retail_stores
        WHERE is_active = 1 AND timezone IS NOT NULL AND TRIM(timezone) <> ''
        ORDER BY sort_order, id LIMIT 1`
    ).get();
    const tz = (row && String(row.timezone).trim()) || null;
    if (tz) return tz;
  } catch (e) { /* no such table on an un-migrated account — try the config */ }
  // NO LOCATION YET (audit D-08). A brand-new account has no store for days:
  // creating one is a manual onboarding step, and the first orders can arrive
  // before it happens. The zone the merchant gave at sign-up is seeded as
  // `shop.timezone`, so their business day is their own from the first order
  // rather than Guangzhou's until they get round to adding a shop.
  //
  // Second, not first: a location that carries a zone is a fact about where the
  // trading happens, and beats an answer typed once on a sign-up form.
  try {
    const row = db.prepare("SELECT value_json FROM storefront_config WHERE key = 'shop.timezone'").get();
    if (!row) return null;
    const v = JSON.parse(row.value_json);
    return (typeof v === 'string' && v.trim()) ? v.trim() : null;
  } catch (e) { return null; }
}

/** sqlDayShift() for the account behind `db`. */
function sqlDayShiftForShop(db, at = new Date()) {
  return sqlDayShift(shopTimezone(db), at);
}

/**
 * The calendar day in `tz` that a stored `scheduled_for` falls on. The column
 * holds one of two shapes: a bare 'YYYY-MM-DD' (already a day — returned as it
 * is, never parsed, because `new Date('YYYY-MM-DD')` is UTC midnight and lands
 * on the previous day anywhere west of Greenwich) or an instant. Null when the
 * value is empty or unreadable. Never reads the host's clock (§82).
 */
function dayOfStored(tz, value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = value instanceof Date ? value : new Date(s);
  return isNaN(d.getTime()) ? null : businessDate(tz, d);
}

/**
 * The instant `tz`'s wall clock reads hh:mm on the day `at` falls on in `tz` —
 * how a bare 'HH:MM' promised for "today" (a local rider's ETA) becomes a time
 * to compare against. Replaces `new Date(now.getFullYear(), …, hh, mm)`, which
 * built it on the host's clock (§82).
 */
function wallClockOnDay(tz, at, hh, mm) {
  return dateInZone(tz, businessDate(tz, at), hh, mm);
}

/**
 * A timestamp as SQLite stores it — CURRENT_TIMESTAMP's 'YYYY-MM-DD HH:MM:SS',
 * which is UTC but SAYS nothing about it — read as the instant it is. `new
 * Date()` on that string reads it on the HOST's clock, eight hours early on a
 * UTC+8 host. A value that already names its zone (an ISO string ending in Z
 * or ±hh:mm) is read as written. Null when empty or unreadable.
 */
function parseStoredUtc(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const s = String(value).trim();
  // Only SQLite's own shape — a SPACE between date and time, no zone — is read
  // as UTC; every writer of it in this codebase stores UTC (CURRENT_TIMESTAMP,
  // and the channel daemons' toUtc stamps). An ISO string is read as written.
  const sqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s);
  const d = new Date(sqlite ? s.replace(' ', 'T') + 'Z' : s);
  return isNaN(d.getTime()) ? null : d;
}

/** An offset in minutes east of UTC as people write it: "UTC+8", "UTC-4", "UTC+5:30". */
function utcLabel(mins) {
  const a = Math.abs(mins);
  return 'UTC' + (mins < 0 ? '-' : '+') + Math.floor(a / 60) + (a % 60 ? ':' + String(a % 60).padStart(2, '0') : '');
}

/**
 * "HH:mm" on `tz`'s clock, for the time stamped on a chat message (a staff
 * alert, an order card). The one lenient helper here, and on purpose: a stamp
 * must never stop the message it is on from going out. A zone that cannot be
 * read gives "HH:mm UTC", which says what it is, rather than a guessed zone,
 * which would not (§82).
 */
function messageStamp(tz, at = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  if (!zoneProblem(tz)) {
    try { const z = zoneParts(tz, at); return `${p(z.hour)}:${p(z.minute)}`; } catch (_) { /* a zone Intl cannot read falls through to the labelled UTC stamp */ }
  }
  return `${p(at.getUTCHours())}:${p(at.getUTCMinutes())} UTC`;
}

module.exports = {
  businessDate, businessDateForLocation, zoneForLocation, SYSTEM_DEFAULT_TZ, messageStamp, utcLabel,
  NoShopTimezoneError, zoneProblem, requireZone,
  zoneParts, dateInZone, dayOfStored, wallClockOnDay, parseStoredUtc,
  zoneOffsetMinutes, sqlDayShift, shopTimezone, sqlDayShiftForShop,
};
