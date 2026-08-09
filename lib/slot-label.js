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
 * Re-derive the leading relative day word of a stored delivery-slot label.
 *
 * @param {string|null} label         retail_orders.delivery_slot_label, verbatim
 * @param {string|Date|null} scheduledFor  retail_orders.scheduled_for
 * @param {Date} [now]                reference instant; defaults to the real clock
 * @returns {string|null} the display string, or `label` unchanged
 *
 * Returns `label` untouched — never null-for-a-string, never '' for a value —
 * whenever it cannot do better, so a caller can assign the result
 * unconditionally.
 */
function deliverySlotDisplay(label, scheduledFor, now) {
  if (!label) return label;
  const str = String(label);
  const hit = matchPrefix(str);
  if (!hit) return label;
  const schedGz = gzShift(scheduledFor);
  if (!schedGz) return label;
  const nowGz = gzShift(now instanceof Date ? now : new Date());
  if (!nowGz) return label;
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
function attachSlotDisplay(row, now) {
  if (!row) return row;
  row.delivery_slot_display = deliverySlotDisplay(row.delivery_slot_label, row.scheduled_for, now);
  return row;
}

module.exports = { deliverySlotDisplay, attachSlotDisplay };
