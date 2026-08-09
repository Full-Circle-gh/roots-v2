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

const MON_EN  = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WDAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

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
  // Otherwise it is an instant. Trust ONLY an explicit zone marker: a naive
  // 'YYYY-MM-DD HH:MM:SS' is SQLite's own shape and is stored UTC by house
  // convention, and letting new Date() read it as host-local is exactly the
  // process-timezone dependence this module exists to remove. (lib/feie.js
  // tests /[TZ]/, which lets a naive 'YYYY-MM-DDTHH:MM:SS' through to the host
  // clock; that shape does not occur in scheduled_for, but the stricter test
  // costs nothing and cannot be wrong.)
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

function fmtDate(gz, lang) {
  return lang === 'cn'
    ? `${gz.getUTCMonth() + 1}月${gz.getUTCDate()}日`
    : `${MON_EN[gz.getUTCMonth()]} ${gz.getUTCDate()}`;
}

function fmtWeekdayDate(gz, lang) {
  return lang === 'cn'
    ? `${fmtDate(gz, 'cn')}${WDAY_CN[gz.getUTCDay()]}`
    : `${WDAY_EN[gz.getUTCDay()]} ${fmtDate(gz, 'en')}`;
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
  // the day. Reachable only if scheduled_for moves without the label being
  // rewritten — the reschedule endpoint rewrites both — so this is a guard, not
  // a routine path.
  if (diff > 1) return fmtWeekdayDate(schedGz, lang);
  // Past. A plain date, with no relative word at all: "Yesterday" on a live
  // tracker card reads as a missed delivery, which is a claim this function has
  // no standing to make.
  return fmtDate(schedGz, lang);
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
