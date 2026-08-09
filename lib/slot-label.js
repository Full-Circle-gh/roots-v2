'use strict';

// ── Relative day word in a stored delivery-slot label ────────────────────────
//
// `retail_orders.delivery_slot_label` is a SNAPSHOT. computeDeliverySlots()
// mints "Tomorrow 10AM–12PM" / "明天 10:00–12:00" from the clock at the moment
// the customer was picking a slot (routes/retail.js, emitTimeSlots), checkout
// persists that string verbatim, and every customer surface echoes it. So an
// order picked yesterday for today still reads "Tomorrow" on the day it
// arrives. Confirmed on TC000178.
//
// The snapshot is deliberate and stays — database.js is right that a historical
// order must stay readable after slot definitions change. This module is the
// READ-time counterpart: it derives a fresh day word from `scheduled_for`, the
// absolute timestamp sitting on the same row, and leaves the stored column
// untouched. Nothing here writes.
//
// Two neighbours solve a related problem differently and are NOT duplicated
// here: `absolutizeSlot()` (lib/feie.js) and `absolutizeSlotLabel()`
// (public/retail-admin/04-orders.js) swap the relative word for a CONCRETE date
// ("Aug 12"), because a printed slip and an ops table are read out of time. A
// live customer card is read in time, so it wants the relative word to stay
// relative and stay TRUE.
//
// Everything is computed in Guangzhou wall-clock time, explicitly. No call here
// reads the process timezone — no repo sets TZ, and computeDeliverySlots'
// dependence on the host clock is what put the wrong word in the column in the
// first place.

// Guangzhou is UTC+8 all year (China dropped DST in 1991), so a fixed offset is
// exact for this zone and, unlike Intl, cannot be defeated by a host shipped
// without tzdata. Shift a real instant by this and read it back with getUTC*()
// and you are reading the Guangzhou wall clock.
const GZ_OFFSET_MS = 8 * 3600 * 1000;

// §1.18's vocabulary, copied from public/td-datetime.js so the two agree
// character for character. `date` takes the SHORT month, `weekday` the long one
// and the full weekday name — that asymmetry is the rulebook's, not a slip.
const MON_EN       = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MON_EN_LONG  = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const WDAY_EN_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WDAY_CN      = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// The only four words computeDeliverySlots can put at the FRONT of a label —
// 'Today'/'今天' from the same-day chips and the day-only chip, 'Tomorrow'/'明天'
// from the kitchen-closed fallback. Anything else it mints ('Right away',
// 'Ships when restocked', 'Earliest 2026-08-12', a raw calendar slot id) has no
// relative word to go stale and is passed straight through.
//
// The label's OWN language decides the output language. A Chinese label picked
// up by an English-mode viewer keeps its Chinese day word: the time window
// beside it is still Chinese, and half-translating the pair is the glued-language
// defect. The four words are disjoint across the two languages, so the match
// itself is the language detection — no locale needs to be passed in.
const PREFIXES = [
  { word: 'Today',    lang: 'en' },
  { word: 'Tomorrow', lang: 'en' },
  { word: '今天',      lang: 'cn' },
  { word: '明天',      lang: 'cn' },
];

const DAY_WORD = {
  today:    { en: 'Today',    cn: '今天' },
  tomorrow: { en: 'Tomorrow', cn: '明天' },
};

// ── Pickup ──────────────────────────────────────────────────────────────────
//
// A pickup label is REBUILT rather than patched, and that is the one place this
// module departs from the delivery path. The reason is what the two strings
// are. A delivery label is irreducible: it encodes a merchant's slot definition
// that may since have been edited, so database.js snapshots it and the delivery
// path replaces only the leading word. A pickup label encodes nothing but a
// lead word, a day and a time — all three derivable from `scheduled_for` on the
// same row. There is nothing in it worth preserving, and preserving it is
// exactly what keeps its two defects alive: resolvePickupTime mints the label
// in English regardless of the customer's language, and on a 24-hour clock
// regardless of §1.18. Rebuilding fixes rows already in the database, not only
// the ones written from here on.
//
// The stored column is still never written. It keeps its English snapshot for
// admin, print and continuity.
//
// The closed lead-word set has exactly ONE entry, and the test is anchored.
// resolvePickupTime is the sole producer of a mid-string relative word, and it
// always leads with 'Pickup' (routes/retail.js). Deliberately NOT a
// "contains a relative word" test: that would catch 'Ships when restocked' the
// day someone rewords it, and every pass-through row in the suite is the proof
// that this stays narrow.
const PICKUP_RE = /^Pickup\s/;

// 自提 is the term already in use — the customer receipt prints 'Pickup 自提'
// (lib/feie.js), the admin Ship-to cell reads 'pickup · 自提', and
// stripLeadWord's own lead-word alternation lists it first. Not minted here.
// CN leads with the word exactly as EN does, which is that alternation's
// expectation too, so no re-ordering is needed.
const PICKUP_WORD = { en: 'Pickup', cn: '自提' };

// Parse a stored value into a Date whose UTC fields read as the Guangzhou wall
// clock. Returns null on anything unparseable, which every caller treats as
// "leave the label alone".
function gzShift(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : new Date(value.getTime() + GZ_OFFSET_MS);
  }
  const str = String(value).trim();
  if (!str) return null;
  // A bare 'YYYY-MM-DD' IS the calendar date and carries no instant. Shifting it
  // would walk it eight hours into the previous day. Same carve-out as
  // fmtSlotDate() / absolutizeSlot() in lib/feie.js.
  const mDay = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (mDay) return new Date(Date.UTC(+mDay[1], +mDay[2] - 1, +mDay[3]));
  // Otherwise it is an instant, and a value with no zone marker is read as UTC.
  //
  // THE NAIVE BRANCH IS UNREACHABLE for scheduled_for, and stays only so this
  // function is safe on any timestamp. Every writer of the column produces an
  // explicit Z or a bare date: resolveDeliverySlot (`dt.toISOString()`),
  // resolvePickupTime (`when.toISOString()`), the customer reschedule (the
  // same resolved value) and markOrderPaid's Express re-anchor
  // (`new Date(y, m-1, d, 0, 0).toISOString()`) all end in Z; the Qingyun
  // same-day requeue writes a bare 'YYYY-MM-DD', which the day-only branch
  // above takes literally.
  //
  // miniapp/pages/checkout/checkout.js says the opposite — that a local-naive
  // datetime is sent because the server reads it in its own UTC+8 clock — and
  // it is right about the thing it describes: `pickup_time` is a REQUEST field.
  // resolvePickupTime does `new Date(raw)` on it (host-local, as that comment
  // intends) and then stores `when.toISOString()`. The naive string never
  // reaches the column; it is converted to an instant one line earlier. The two
  // conventions govern different values and never meet.
  //
  // UTC is also what the rest of the platform assumes for a naive stamp —
  // public/td-datetime.js ("the 'Z' is not optional"), lib/inventory.js,
  // lib/feie.js and 04-orders.js parseSchedFor ('"YYYY-MM-DD HH:MM:SS" UTC')
  // all agree. The stricter zone test here is deliberate: the other three test
  // /[TZ]/, so a 'YYYY-MM-DDTHH:MM:SS' (T, no Z) slips through to the host
  // clock. That shape has no producer either, but this is the one reader that
  // cannot be wrong about it.
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(str);
  const d = new Date(hasZone ? str : str.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return null;
  return new Date(d.getTime() + GZ_OFFSET_MS);
}

// Guangzhou calendar-day ordinal. Differencing two of these gives whole
// calendar days apart, which is the only comparison this module makes — the
// time of day is never compared. See dayWord() for why.
function gzDayIndex(shifted) {
  return Math.floor(shifted.getTime() / 86400000);
}

// The leading relative word, if there is one. Requires the word to sit at
// position 0 and to be followed by end-of-string or whitespace, so a label that
// merely CONTAINS one of these words ("Pickup Today 14:30") is not rewritten —
// that shape is out of scope here and is handled for the printed slip by
// absolutizeSlot().
function matchPrefix(str) {
  for (const p of PREFIXES) {
    if (!str.startsWith(p.word)) continue;
    const rest = str.slice(p.word.length);
    if (rest === '' || /^\s/.test(rest)) return { lang: p.lang, window: rest.trim() };
  }
  return null;
}

// §1.18's year rule: the year appears ONLY when the date is not in the current
// year, and "current" is read in the STORE's wall clock, not the host's — on
// Dec 31 those disagree. Both `date` and `weekday` carry it.
function needsYear(gz, nowGz) {
  return gz.getUTCFullYear() !== nowGz.getUTCFullYear();
}

// §1.18 `date` — 'Aug 8' / 'Dec 14, 2025' · '8月8日' / '2025年12月14日'.
function fmtDate(gz, lang, nowGz) {
  const yr = needsYear(gz, nowGz);
  return lang === 'cn'
    ? `${yr ? gz.getUTCFullYear() + '年' : ''}${gz.getUTCMonth() + 1}月${gz.getUTCDate()}日`
    : `${MON_EN[gz.getUTCMonth()]} ${gz.getUTCDate()}${yr ? ', ' + gz.getUTCFullYear() : ''}`;
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }

// §1.18 `time` — '10:30 AM' / '2:00 PM' · '10:30' / '14:00'. English is a
// 12-hour clock with AM/PM, Chinese a 24-hour one, because that is each
// language's own convention. Mirrors clockEn()/renderCn() in
// public/td-datetime.js, midnight-and-noon behaviour included: 00:00 renders
// '12:00 AM' in EN and '00:00' in CN.
function fmtTime(gz, lang) {
  const h = gz.getUTCHours();
  const mi = gz.getUTCMinutes();
  if (lang === 'cn') return `${pad2(h)}:${pad2(mi)}`;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad2(mi)} ${h < 12 ? 'AM' : 'PM'}`;
}

// §1.18 `weekday` — 'Wednesday, August 12' / 'Sunday, December 14, 2025'
//                 · '8月12日 周三'        / '2025年12月14日 周日'.
// The CN form puts the weekday AFTER the date, separated by a space. Both
// details are the rulebook's; do not tidy them.
function fmtWeekdayDate(gz, lang, nowGz) {
  const yr = needsYear(gz, nowGz);
  return lang === 'cn'
    ? `${fmtDate(gz, 'cn', nowGz)} ${WDAY_CN[gz.getUTCDay()]}`
    : `${WDAY_EN_LONG[gz.getUTCDay()]}, ${MON_EN_LONG[gz.getUTCMonth()]} ${gz.getUTCDate()}`
      + `${yr ? ', ' + gz.getUTCFullYear() : ''}`;
}

// Which day is this slot on, said freshly. A PURE CALENDAR-DATE comparison:
// whether the window itself has already elapsed is deliberately never tested.
// An order booked for today 10AM–1PM still reads "Today 10AM–1PM" at 4pm on
// that day — the four progress steps under the header carry the delivery-state
// story, and the header's only job is to name the day.
function dayWord(schedGz, nowGz, lang) {
  const diff = gzDayIndex(schedGz) - gzDayIndex(nowGz);
  if (diff === 0) return DAY_WORD.today[lang];
  if (diff === 1) return DAY_WORD.tomorrow[lang];
  // Two or more days out: no relative word is honest at that distance, so name
  // the day, through §1.18's `weekday` name. Roots' own zone settings cannot
  // reach this today, but Tacet is multi-tenant — a tenant with a longer lead
  // time, or a staff edit that moves a delivery date without rewriting the
  // label, both land here.
  if (diff > 1) return fmtWeekdayDate(schedGz, lang, nowGz);
  // Past. §1.18's `date` name, with no relative word at all: "Yesterday" on a
  // live tracker card reads as a missed delivery, which is a claim this
  // function has no standing to make.
  return fmtDate(schedGz, lang, nowGz);
}

/**
 * The customer-facing delivery/pickup slot line, said freshly.
 *
 * Two paths, and which one runs is decided by the stored string:
 *   • pickup  ('Pickup …')  — REBUILT from scheduled_for, in the VIEWER's
 *                             language. Nothing in the stored string survives.
 *   • delivery ('Today …', 'Tomorrow …', '今天 …', '明天 …')
 *                           — only the leading word is replaced, in the
 *                             STORED string's language.
 * Everything else is returned untouched.
 *
 * The language difference is deliberate. A delivery label carries a merchant's
 * slot wording that we cannot translate, so its day word stays in the language
 * the customer ordered in or the line would end up half-translated. A pickup
 * line has no merchant wording in it at all, so it can and should follow the
 * viewer.
 *
 * @param {string|null} label         retail_orders.delivery_slot_label, verbatim
 * @param {string|Date|null} scheduledFor  retail_orders.scheduled_for
 * @param {Date} [now]                reference instant; defaults to the real clock
 * @param {'en'|'cn'} [lang]          VIEWER's language; pickup only. Default 'en'.
 * @returns {string|null} the display string, or `label` unchanged
 *
 * Returns `label` untouched — never null-for-a-string, never '' for a value —
 * whenever it cannot do better, so a caller can assign the result
 * unconditionally. In particular a pickup line is never emitted partially: no
 * usable scheduled_for means the stored label is returned whole.
 */
function deliverySlotDisplay(label, scheduledFor, now, lang) {
  if (!label) return label;
  const str = String(label);
  const isPickup = PICKUP_RE.test(str);
  if (!isPickup && !matchPrefix(str)) return label;
  const schedGz = gzShift(scheduledFor);
  if (!schedGz) return label;
  const nowGz = gzShift(now instanceof Date ? now : new Date());
  if (!nowGz) return label;

  if (isPickup) {
    // Rebuilt, not patched — the stored string's own words are read for
    // nothing beyond the lead-word test above.
    const L = lang === 'cn' ? 'cn' : 'en';
    return `${PICKUP_WORD[L]} ${dayWord(schedGz, nowGz, L)} ${fmtTime(schedGz, L)}`;
  }

  const hit = matchPrefix(str);
  const word = dayWord(schedGz, nowGz, hit.lang);
  return hit.window ? `${word} ${hit.window}` : word;
}

/**
 * Stamp `delivery_slot_display` onto an order-shaped row, in place.
 *
 * Every wiring site calls this rather than the bare function so the field is
 * derived identically everywhere and a new endpoint is one line. The column
 * itself is never modified — `delivery_slot_label` still ships alongside, and
 * clients fall back to it.
 */
function attachSlotDisplay(row, now, lang) {
  if (!row) return row;
  row.delivery_slot_display = deliverySlotDisplay(row.delivery_slot_label, row.scheduled_for, now, lang);
  return row;
}

module.exports = { deliverySlotDisplay, attachSlotDisplay };
