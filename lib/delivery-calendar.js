// The delivery calendar: the fresh-batch schedule's settings, the tenant's own
// clock (§82), the next batch day and whether today's batch is still coming,
// when a picked window closes and which fresh lines today's batch covers, the
// Express day, the delivery time slots offered at checkout (and the store's own
// hours they follow, §480), and the check a picked slot gets when the order is
// placed. Moved out of routes/retail.js unchanged (decisions §477). Pinned by
// scripts/test_delivery_slots.js.
'use strict';

const { tdb, currentTenantId } = require('./tenant-db');
const { cfgValue } = require('./store-config');
const businessDate = require('./business-date');
const batchCadence = require('./batch-cadence');

// "HH:MM" → minutes since midnight, or null if malformed.
function hhmmToMinutes(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}
// Config (storefront_config['batch.schedule']):
//   { enabled, anchor_date:'YYYY-MM-DD', interval_days:2, skip_dates:['YYYY-MM-DD'],
//     cutoff_hour:20 }
// plus two sets of optional operator copy, both blank-means-default: the
// shipping one (kicker/title/message/tip_en|cn, placeholders {ship_date} and
// {delivery_date}) and the Guangzhou one (local_kicker/local_title/
// local_message_en|cn, placeholder {make_date}). Both are edited in Mini App
// Backend → Delivery → Fresh batch schedule, which PUTs this object whole — a
// field omitted by that form is dropped, so new copy needs a control there.
// anchor_date is any reference batch day; the rhythm steps out from it both
// ways in interval_days jumps. skip_dates are one-off closures (vacations) the
// cadence rolls past.
//
// cutoff_hour is the hour (local, 0-23) after which today's batch is already
// made and shipped, so a batch day that is TODAY stops counting as available.
// Without it the cadence was calendar-only and an order placed at 21:32 on a
// batch day was promised that morning's batch — a ship date already in the
// past. Blank falls back to fresh.rescheduleCutoffHour (the same 20:00 kitchen
// close that locks a fresh order against rescheduling), so the two fresh-food
// deadlines stay in step unless the operator deliberately splits them.
function batchScheduleCfg() {
  const c = cfgValue('batch.schedule', null);
  if (!c || !c.enabled || !c.anchor_date) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(c.anchor_date))) return null;
  const interval = Math.max(1, parseInt(c.interval_days, 10) || 2);
  const skip = Array.isArray(c.skip_dates)
    ? c.skip_dates.filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)))
    : [];
  const str = (v) => (typeof v === 'string' ? v : '');
  const rawCut = parseInt(c.cutoff_hour, 10);
  const cutoffHour = (Number.isFinite(rawCut) && rawCut >= 0 && rawCut <= 23)
    ? rawCut
    : (() => {
      const f = parseInt(cfgValue('fresh.rescheduleCutoffHour', 20), 10);
      return (Number.isFinite(f) && f >= 0 && f <= 23) ? f : 20;
    })();
  // The hour today's batch reaches the shelf (§74). OPTIONAL, and its absence is
  // the off switch: null means every caller behaves exactly as it did before
  // §74, for every tenant, with no migration and no backfill. Set, it is the one
  // fact that lets a zero shelf on a batch morning still mean "today" — see
  // earliestBatchMakeDate, which forgives the stock roll-forward and nothing
  // else. A value later than cutoff_hour is operator error and the cutoff wins,
  // which is the safe direction; it is not clamped here because the two answer
  // different questions and silently moving one to satisfy the other would hide
  // the mistake rather than fix it.
  const rawReady = parseInt(c.ready_hour, 10);
  const readyHour = (Number.isFinite(rawReady) && rawReady >= 0 && rawReady <= 23)
    ? rawReady
    : null;
  return {
    anchor_date: c.anchor_date,
    interval_days: interval,
    skip_dates: skip,
    cutoff_hour: cutoffHour,
    ready_hour: readyHour,
    // Optional operator-authored popup copy. The body placeholders {ship_date}
    // and {delivery_date} are filled with the resolved YYYY-MM-DD dates. Title
    // and kicker are plain text. Any blank field falls back to a built-in
    // bilingual default in computeBatchNotice.
    title_en:   str(c.title_en),
    title_cn:   str(c.title_cn),
    kicker_en:  str(c.kicker_en),
    kicker_cn:  str(c.kicker_cn),
    message_en: str(c.message_en),
    message_cn: str(c.message_cn),
    // Optional freshness reminder line shown below the dates ("enjoy within …").
    tip_en:     str(c.tip_en),
    tip_cn:     str(c.tip_cn),
    // Optional copy for the LOCAL-RUN variant of the notice (Guangzhou, where
    // the only date we can name is the production day — there is no courier leg
    // to add). Kept separate from the fields above because the two notices say
    // different things: the shipping one promises make + arrive, this one
    // promises the batch. Blank falls back to the bilingual default in
    // computeLocalFreshNotice. `{make_date}` is the one placeholder.
    local_title_en:   str(c.local_title_en),
    local_title_cn:   str(c.local_title_cn),
    local_kicker_en:  str(c.local_kicker_en),
    local_kicker_cn:  str(c.local_kicker_cn),
    local_message_en: str(c.local_message_en),
    local_message_cn: str(c.local_message_cn),
  };
}

// ─── §82 · THE TENANT'S CLOCK, NOT THE HOST'S ─────────────────────────────
// Every date and time decision below resolves in the timezone of the tenant
// that owns the order, read from a tenant setting. `new Date().getHours()`,
// `.getFullYear()`, `.getDate()` and their siblings read the HOST's clock and
// are forbidden anywhere a cutoff, a date or a slot is computed: the host
// offset is an accident of deployment, not a business fact.
//
// The zone is resolved through lib/business-date.js's shopTimezone(), which is
// the same answer the admin screen renders every timestamp in, so the calendar
// a customer is offered and the clock an operator reads cannot disagree.
//
// MEMOISED, and the TTL is why this is not a per-call database read: these
// helpers are called dozens of times inside one checkout, and shopTimezone()
// costs a query or two each time. Keyed by tenant, so one merchant's cached
// zone can never answer for another — the mistake lib/store-hours.js's unkeyed
// cache made with opening hours (audit D-02).
//
// NULL IS A LEGITIMATE ANSWER and is passed straight through: business-date's
// helpers treat it as SYSTEM_DEFAULT_TZ ('Asia/Shanghai'), which is exactly
// what this code did when it read a host pinned to UTC+8. A tenant that has
// never set a zone therefore behaves as it did before this change rather than
// losing its calendar. (§82 also asks that such a tenant fail LOUDLY at
// startup; that is a boot-time check, not this read, and is not in this change.)
const _tzCache = new Map();          // tenantId -> { tz, at }
const DELIVERY_TZ_TTL_MS = 60_000;
function deliveryTz() {
  let tid;
  try { tid = currentTenantId(); } catch (_) { tid = 0; }
  const now = Date.now();
  const hit = _tzCache.get(tid);
  if (hit && now - hit.at < DELIVERY_TZ_TTL_MS) return hit.tz;
  let tz = null;
  try { tz = businessDate.shopTimezone(tdb()); } catch (_) { tz = null; }
  _tzCache.set(tid, { tz, at: now });
  return tz;
}

// Midday-in-the-tenant's-zone Date for a YYYY-MM-DD string. Midday dodges any
// DST edge — which now matters, because the zone is no longer guaranteed to be
// one without DST. Returns null on a malformed string.
function parseYmdLocal(s, tz = deliveryTz()) {
  return businessDate.dateInZone(tz, s, 12, 0);
}
function toYmdLocal(d, tz = deliveryTz()) {
  return businessDate.businessDate(tz, d);
}
// The tenant's calendar date, hour and minute for an instant — the replacement
// for reading `.getFullYear()` / `.getHours()` off a Date.
function tzNowParts(now, tz = deliveryTz()) {
  return businessDate.zoneParts(tz, now || new Date());
}

// Smallest batch day (YYYY-MM-DD) on or after `fromDate`, skipping any
// skip_dates by rolling forward another whole interval. null when disabled.
// §85 — THE BODY OF THIS FUNCTION MOVED TO lib/batch-cadence.js, and what is
// left is the call. Nothing about the arithmetic changed: same midday anchoring
// for DST safety, same modulo, same skip_dates roll-forward, same 365-step
// guard, and it still takes THIS file's own normalised cfg object.
//
// WHY IT MOVED. A stock daemon deciding what number to push to Meituan, Eleme
// and gzgrocery has to know whether today is a batch day, and it cannot require
// this file to find out — a 36,000-line express router is not a dependency a
// daemon should carry to answer a date question. The alternative was a second
// copy of the cadence living beside the push, which is exactly what §80 spent a
// section removing: three copies became one so that "the pill, the checkout and
// the order agree", and a fourth would have disagreed where nobody looks — the
// platform quietly naming a different batch day from the app.
//
// The wrapper stays because this file's callers pass no tz and no cfg and
// should not have to; `deliveryTz()` and `batchScheduleCfg()` are its own.
function nextBatchShipDate(fromDate, cfg, tz = deliveryTz()) {
  return batchCadence.nextBatchDate(fromDate, cfg || batchScheduleCfg(), tz);
}

// The batch-made (is_batch_made) products among the given ids, as
// [{ id, name_en, name_cn }]. Empty array when none. Drives both the
// "does the notice apply" gate and the item list shown in the popup.
function batchItemsInCart(productIds) {
  const ids = [...new Set((productIds || []).map((n) => parseInt(n, 10)).filter(Boolean))];
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  return tdb().prepare(
    `SELECT id, name_en, name_cn FROM store_products
      WHERE id IN (${ph}) AND COALESCE(is_batch_made, 0) = 1`
  ).all(...ids);
}

// §80 — IS TODAY'S BATCH STILL COMING? Config and clock only; no cart, no store,
// no stock. Three conditions, and they were written out three times before this
// existed (earliestBatchMakeDate's todayBatchPending, nextFreshBatchDate's early
// return, and the shortage gate) — two copies too many for a rule whose whole
// job is that the pill, the checkout and the order agree.
//
//   • an hour is configured                (unset ⇒ null ⇒ §74 is off entirely)
//   • it has not arrived yet
//   • the day's ordering cutoff has not passed
//   • today is on the cadence, skip_dates and all
//
// Returns { readyHour, dateIso } or null. Never asks about stock: whether a
// given SHELF is empty is a different question, asked by whoever holds a store.
function todaysBatchStillComing(now, tz = deliveryTz()) {
  const cfg = batchScheduleCfg();
  if (!cfg || cfg.ready_hour == null) return null;
  const nowD = now || new Date();
  // One reading of the tenant's clock for both hour tests and the date.
  const p = tzNowParts(nowD, tz);
  if (p.hour >= cfg.ready_hour) return null;
  if (p.hour >= cfg.cutoff_hour) return null;
  if (nextBatchShipDate(nowD, cfg, tz) !== p.ymd) return null;
  return { readyHour: cfg.ready_hour, dateIso: p.ymd };
}

// When does the customer's chosen window CLOSE? A Date, or null for a pick that
// names no window it could close by — 'right_away' above all, which promises the
// soonest possible and cannot be answered by a batch that has not been made. A
// day-only chip closes when the kitchen does.
function slotWindowEnd(zone, slotId, now, tz = deliveryTz()) {
  if (!slotId || slotId === 'right_away') return null;
  const mTime = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(slotId));
  const mDay  = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(slotId));
  const dur = Number(zone && zone.slot_duration_minutes) > 0
    ? Number(zone.slot_duration_minutes) : 120;
  const endHour = Number(zone && zone.slot_end_hour) > 0 ? Number(zone.slot_end_hour) : 20;
  if (mTime) {
    // The instant the tenant's wall clock reads this slot's start — was built
    // against the HOST's zone, which put the window an offset's worth out for
    // any tenant not on the host's clock.
    const start = businessDate.dateInZone(tz, `${mTime[1]}-${mTime[2]}-${mTime[3]}`,
      Number(mTime[4]), Number(mTime[5]));
    return start ? new Date(start.getTime() + dur * 60000) : null;
  }
  if (mDay) {
    return businessDate.dateInZone(tz, `${mDay[1]}-${mDay[2]}-${mDay[3]}`, endHour, 0);
  }
  return null;
}

// §80 — the FRESH lines today's batch will cover before the customer's own
// window closes, as a Set of product ids.
//
// THE RULE IS THE WINDOW'S END, NOT ITS START, and that is Ash's ruling stated
// as arithmetic: a batch landing at 11:00 serves a 10:00–12:00 delivery, so
// keying on the start would refuse exactly the slot he named. A window closing
// BEFORE the batch lands is not covered, which is what keeps the rule honest if
// an operator sets a late ready hour.
//
// Empty whenever §74 is off, today is not a cooking day, the batch has landed,
// or the pick names no window. An empty set restores every previous behaviour
// exactly, which is what makes this safe to consult unconditionally.
function freshLinesCoveredToday({ zone, deliverySlotId, productIds, now, tz = deliveryTz() }) {
  const out = new Set();
  const pending = todaysBatchStillComing(now, tz);
  if (!pending) return out;
  const end = slotWindowEnd(zone, deliverySlotId, now, tz);
  if (!end) return out;
  // The instant the kitchen finishes, on the TENANT's clock. `pending.dateIso`
  // is already that day in that zone, so it is used directly rather than
  // rebuilding the date from host getters.
  const readyAt = businessDate.dateInZone(tz, pending.dateIso, pending.readyHour, 0);
  if (!readyAt || end.getTime() < readyAt.getTime()) return out;
  for (const it of batchItemsInCart(productIds || [])) out.add(it.id);
  return out;
}

// ─── Delivery-slot enumerator ────────────────────────────────────────────
// Given a matched zone (or null) + the current server time, produce the
// list of slots the customer can pick from on the checkout page.
//
// Rules baked in (matching the product spec):
//   • Inside GZ districts (same_day_surcharge = 0, default): "right away"
//     is the natural default while the kitchen is open. Future days +
//     2-hour slots are also offered.
//   • Panyu-style override (same_day_surcharge > 0): the customer can pick
//     a same-day slot ONLY by paying the surcharge; without it they must
//     start from tomorrow.
//   • Outside GZ (zone_type = 'city', min_lead_days = 1 by default):
//     earliest selectable day is today + min_lead_days. The customer-facing
//     Express copy promises "1–2 days", so the lead is 1 (earliest = tomorrow)
//     to keep the scheduled earliest day in step with that promise.
//   • "Right away" is suppressed whenever the kitchen is not running this
//     minute — before slot_start_hour AND after slot_end_hour.
//   • Today's time-slot chips show every future slot up to slot_end_hour,
//     including pre-opening hours: ordering at 7am with kitchen opening at
//     10am still offers Today 10–12 / 12–14 / etc. Only after slot_end_hour
//     do today's chips empty out and the system rolls forward to Tomorrow.
//
// Returns: {
//   right_away_available, same_day_surcharge, min_lead_days,
//   slots: [{ slot_id, date_iso, start_hour, end_hour, is_same_day,
//             requires_surcharge, label_en, label_cn }],
//   kitchen_open_now,
// }

// The zone's TRUE earliest fulfillable day (the Express "ship ASAP / Earliest X"
// date), anchored to `now`. Floored at tomorrow because a day-only Express slot
// is never "today". Pulled out of computeDeliverySlots so payment finalization
// can RE-anchor an express order to its PAY date: the express date is a relative
// promise, so an order placed Sunday but left unpaid until Monday must earliest
// from Monday (the kitchen only starts once it's paid).
function expressEarliestIso(zone, now, tz = deliveryTz()) {
  let lead = zone && zone.min_lead_days != null ? Number(zone.min_lead_days) : 0;
  if (!(lead >= 0)) lead = 0;
  const days = Math.max(1, lead);
  const t = now || new Date();
  // Today in the TENANT's zone, at midday, then whole days added. The old form
  // built `new Date(t.getFullYear(), t.getMonth(), t.getDate())` — the host's
  // calendar day rebuilt at the host's midnight — and read the result back with
  // three more host getters. Midday is what keeps the addition DST-safe.
  const base = parseYmdLocal(toYmdLocal(t, tz), tz);
  return toYmdLocal(new Date(base.getTime() + days * 86400000), tz);
}

// §480 — a store's Opens/Closes as the delivery window computeDeliverySlots
// reads: `open`/`close` in minutes for the open-now tests, and the whole hours
// INSIDE them (open rounded up, close rounded down) for the slot windows. The
// close is rounded down with the one minute of slack emitTimeSlots already
// allows past close, so 23:59 — the only way to write "till midnight", since
// 24:00 is not a time — keeps the window that ends at 24:00.
// Null — and the zone's kitchen hours stand — when either end is missing or
// malformed, when close is not after open, or when no whole hour fits between
// them, so a half-filled or odd store row can never empty the slot list.
function storeDeliveryWindow(storeHours) {
  if (!storeHours) return null;
  const open  = hhmmToMinutes(storeHours.open);
  const close = hhmmToMinutes(storeHours.close);
  if (open == null || close == null || !(close > open)) return null;
  const startHour = Math.ceil(open / 60);
  const endHour   = Math.floor((close + 1) / 60);
  if (!(endHour > startHour)) return null;
  return { open, close, startHour, endHour };
}

// `opts.batch` is earliestBatchMakeDate's answer. When the cart holds a
// fresh item, the calendar must not offer a day the batch cannot reach — before
// this, a customer could book a date the "made fresh · ship X" banner then
// contradicted. Because the calendar is an open {min_date, max_date} RANGE and
// not a day list, that constraint is a FLOOR on min_date, not a per-day filter.
// The caller passes the decision; this function never re-derives the cart or the
// store (it is handed neither, deliberately — one decision, computed once).
function computeDeliverySlots(zone, now, opts = {}) {
  // §82 — every hour, date and boundary below is read in the TENANT's zone.
  const tz = opts.tz || deliveryTz();
  // Earliest day a batch order can ARRIVE = make date + the same one-day transit
  // the promise uses (computeBatchNotice's soonestDelivery). Null when no fresh
  // item is involved, which leaves every date rule below exactly as it was.
  const batchDecision = opts.batch || null;
  const batchFloorIso = (batchDecision && batchDecision.applies && batchDecision.make_date)
    ? toYmdLocal(new Date(parseYmdLocal(batchDecision.make_date, tz).getTime() + 86400000), tz)
    : null;
  // The local run's own floor, and the two differ in the two ways the run does.
  // No transit day is added — the batch goes out on the day's run — so the floor
  // is the make date itself, not make + 1. And it is passed ONLY for a cart the
  // caller has established is sold out of a fresh line ('rolled_stock'); an
  // in-stock Guangzhou cart passes null and keeps every same-day option, because
  // a batch made Monday still serves the city on Tuesday within its shelf life
  // and the cadence is not that shopper's business.
  //
  // The two are mutually exclusive — a cart is on the run or it ships — so one
  // floor drives every rule below and they can never both apply.
  const localFreshFloor = opts.localFreshFloor || null;
  const floorIso = batchFloorIso || localFreshFloor || null;
  const cfg = {
    same_day_allowed:      1,
    same_day_surcharge:    0,
    min_lead_days:         0,
    max_lead_days:         14,
    slot_start_hour:       10,
    slot_end_hour:         20,
    slot_duration_minutes: 120,
    day_only:              0,
  };
  if (zone) {
    for (const k of Object.keys(cfg)) {
      if (zone[k] != null) cfg[k] = Number(zone[k]);
    }
  }
  // Holiday mode: orders still flow but all same-day options are suppressed
  // and the mini app shows a banner with the admin-configured message. The
  // schedule-for-later calendar remains pickable so customers can book a
  // future day.
  const holidayMode = !!cfgValue('delivery.holidayMode', false);
  const holidayMessage = cfgValue('delivery.holidayMessage', { en: '', cn: '' });
  if (holidayMode) {
    cfg.same_day_allowed = 0;
  }
  // Clamp pathological admin input so we never spin forever.
  if (!(cfg.slot_duration_minutes > 0))         cfg.slot_duration_minutes = 120;
  if (cfg.slot_start_hour >= cfg.slot_end_hour) cfg.slot_end_hour = cfg.slot_start_hour + 1;
  if (cfg.min_lead_days < 0)                    cfg.min_lead_days = 0;
  if (cfg.max_lead_days < cfg.min_lead_days)    cfg.max_lead_days = cfg.min_lead_days + 7;

  const tzNow      = now || new Date();
  // ONE reading of the tenant's clock. Every hour test, every minute test and
  // every calendar date below comes off this object rather than off the host.
  const nowParts   = tzNowParts(tzNow, tz);
  // Same-day is not merely floored but WITHDRAWN when the batch is a later day:
  // "right away" and today's chips are separate channels that no min_date
  // touches, so without this a shopper could reserve a wrap the kitchen has not
  // made and ask for it this afternoon.
  //
  // Deliberately the LOCAL floor and not the combined one. The shipping floor
  // is an ARRIVAL day (make + a transit day), and a ship-district whose batch
  // is made today legitimately keeps its Today chip — computeBatchNotice
  // suppresses its own notice in exactly that case for the same reason. Gating
  // same-day on that floor would withdraw the chip from an in-stock cart that
  // can still be served. Only the local run, where the floor IS the make day,
  // means "not made yet".
  //
  // Computed off tzNow rather than the `todayIso` further down, which this sits
  // above — the two are the same day by construction (both read tzNow's
  // calendar date), and midday dodges any DST edge as earliestBatchMakeDate does.
  const floorBlocksToday = !!localFreshFloor && localFreshFloor > nowParts.ymd;
  // §480 — WHOSE HOURS. The store that will cook this order, when the caller
  // names one carrying both Opens and Closes; the zone's kitchen hours
  // otherwise. Two readings of it, on purpose: "is the kitchen open now" (right
  // away, the cutoff, the reopen copy) is read to the MINUTE, so a 20:30 close
  // means 20:30; the slot WINDOWS stay on whole hours inside those hours,
  // because the mini app builds later days' windows itself from
  // kitchen_hours.start/end as whole hours, and a window the server then
  // refuses is worse than a half hour not offered.
  const storeWin   = storeDeliveryWindow(opts.storeHours);
  const openMin    = storeWin ? storeWin.open  : cfg.slot_start_hour * 60;
  const closeMin   = storeWin ? storeWin.close : cfg.slot_end_hour * 60;
  const startHour  = storeWin ? storeWin.startHour : cfg.slot_start_hour;
  const endHour    = storeWin ? storeWin.endHour   : cfg.slot_end_hour;
  const slotMins   = cfg.slot_duration_minutes;
  const isDayOnly  = cfg.day_only === 1;
  const nowMinutes = nowParts.hour * 60 + nowParts.minute;
  const kitchenOpenNow = nowMinutes >= openMin && nowMinutes < closeMin;

  // Same-day cutoff buffer — how many minutes BEFORE kitchen close we stop
  // taking same-day / right-away delivery. A Guangzhou store closing at 20:00
  // can't prep + dispatch an order placed at 19:55, so within this buffer the
  // same-day options are withdrawn and the customer is asked to pick tomorrow.
  // Configured once (delivery.sameDayCutoffMinutes) and applies to every
  // time-slot zone — Tianhe, Yuexiu, and any other same-city district. 0 keeps
  // the legacy behavior (accept right up to the closing minute). Clamped to a
  // sane bound so it can never swallow the whole business day.
  let sameDayCutoffMinutes = Number(cfgValue('delivery.sameDayCutoffMinutes', 10));
  if (!(sameDayCutoffMinutes >= 0)) sameDayCutoffMinutes = 0;
  const openSpanMinutes = closeMin - openMin;
  if (sameDayCutoffMinutes > openSpanMinutes) sameDayCutoffMinutes = openSpanMinutes;
  const closeMinutes = closeMin;
  // True only while the kitchen is still technically open but we're inside the
  // last `sameDayCutoffMinutes` before close — a distinct "too late for today"
  // state, separate from fully-closed (which the reopen copy already covers).
  const pastSameDayCutoff =
        kitchenOpenNow &&
        sameDayCutoffMinutes > 0 &&
        nowMinutes >= closeMinutes - sameDayCutoffMinutes;

  // "Right away" only applies in time-slot mode. Day-only zones express
  // the same-day option as a "Today (+¥X)" day-chip instead.
  const rightAwayAvailable = !floorBlocksToday &&
        !isDayOnly &&
        cfg.same_day_allowed === 1 &&
        kitchenOpenNow &&
        !pastSameDayCutoff &&
        cfg.min_lead_days === 0 &&
        cfg.same_day_surcharge === 0;

  // Simplified slot model (rewritten 2026-05-17):
  //   • Today: in time-slot mode, the remaining 2-hour windows that fit
  //     before kitchen close. In day-only mode, one "Today" chip (the
  //     Panyu surcharge option). Both gated by same_day_allowed +
  //     kitchen_open_now.
  //   • Schedule-for-later: a date-only calendar with bounds
  //     [today + SCHEDULE_MIN_LEAD, today + max_lead_days]. SCHEDULE_MIN_LEAD
  //     defaults to 3 (i.e. earliest scheduled day is the 3rd day from
  //     order placement) so the calendar never overlaps Today/Tomorrow,
  //     which are handled by the same-day option above.
  // The legacy `slots` array is kept (as a flat list of today's slots) for
  // backward-compat with anything still reading scheduling.slots; new
  // callers should prefer `today_slots` + `schedule`.
  const SCHEDULE_MIN_LEAD = 3;
  const fmtDateIso = (d) => toYmdLocal(d, tz);
  const fmtHour = (h) => {
    const mer = h < 12 ? 'AM' : 'PM';
    const dispH = h % 12 === 0 ? 12 : h % 12;
    return `${dispH}${mer}`;
  };
  const hhmm = (h, m) => `${h}:${String(m).padStart(2, '0')}`;

  // TWO ANCHORS, AND THE SPLIT IS LOAD-BEARING. `startOfDay` is the instant the
  // tenant's wall clock reads 00:00 today, and it exists so emitTimeSlots can
  // build a slot's start as `startOfDay + minutes`. `middayToday` is the anchor
  // for whole-DAY arithmetic. One variable used to do both, which is safe only
  // in a zone without DST: adding 86400000 to a midnight instant lands at 23:00
  // or 01:00 on a transition day, and reading the calendar date back off that
  // gives the wrong day. Midday has twelve hours of slack either side.
  const todayIso     = nowParts.ymd;
  const startOfDay   = businessDate.dateInZone(tz, todayIso, 0, 0);
  const middayToday  = parseYmdLocal(todayIso, tz);
  const tomorrowIso  = toYmdLocal(new Date(middayToday.getTime() + 86400000), tz);
  const tomorrowDate = businessDate.dateInZone(tz, tomorrowIso, 0, 0);
  const todaySlots = [];
  let   todayDayChip = null;
  // Which day we ended up populating chips for: 'today' when kitchen is
  // open right now AND at least one slot still fits before close; otherwise
  // we roll forward to 'tomorrow' so the customer always has a soonest-day
  // option (they shouldn't have to fall back to the calendar just because
  // the kitchen happens to be closed at the moment).
  let slotDayKind = null;  // 'today' | 'tomorrow' | null

  // Helper: emit the time-slot chips for a given day, given the absolute
  // start-of-day timestamp + a label prefix. `filterElapsed=true` skips
  // slots whose start time has already passed (only meaningful when
  // day === today) — a window must not have started yet to remain bookable,
  // so the customer can never pick an essentially-over slot (e.g. choosing
  // 16:00–18:00 at 17:45 and leaving the kitchen 15 min to deliver).
  function emitTimeSlots(startOfTargetDay, isoDate, prefixEn, prefixCn, filterElapsed) {
    const out = [];
    let hourCursor = startHour * 60;
    const endCursor = endHour * 60;
    while (hourCursor + slotMins <= endCursor + 1) {
      const slotStartH = Math.floor(hourCursor / 60);
      const slotStartM = hourCursor % 60;
      const slotEndCursor = Math.min(hourCursor + slotMins, endCursor);
      const slotEndH = Math.floor(slotEndCursor / 60);
      const slotEndM = slotEndCursor % 60;
      if (filterElapsed) {
        const slotStartsAt = new Date(startOfTargetDay.getTime() + hourCursor * 60000);
        if (slotStartsAt.getTime() <= tzNow.getTime()) { hourCursor += slotMins; continue; }
      }
      const requiresSurcharge = (isoDate === todayIso) && cfg.same_day_surcharge > 0;
      out.push({
        // Two-digit hour: resolveDeliverySlot only accepts 'THH:MM', and the
        // mini app's own later-day windows pad the same way. Unpadded, any
        // window before 10:00 was offered here and then refused at payment.
        slot_id:    `${isoDate}T${String(slotStartH).padStart(2, '0')}:${String(slotStartM).padStart(2, '0')}`,
        date_iso:   isoDate,
        start_hour: slotStartH,  start_minute: slotStartM,
        end_hour:   slotEndH,    end_minute:   slotEndM,
        is_same_day: isoDate === todayIso,
        is_day_only: false,
        requires_surcharge: requiresSurcharge,
        surcharge:          requiresSurcharge ? cfg.same_day_surcharge : 0,
        label_en: `${prefixEn} ${fmtHour(slotStartH)}–${fmtHour(slotEndH)}`,
        label_cn: `${prefixCn} ${hhmm(slotStartH, slotStartM)}–${hhmm(slotEndH, slotEndM)}`,
      });
      hourCursor += slotMins;
    }
    return out;
  }

  // ── Today's options ─────────────────────────────────────────────────
  // Gate on same_day_allowed AND a zero lead — NOT kitchenOpenNow. Pre-
  // opening hours (e.g. ordering at 7am with kitchen opening at 10am) must
  // still offer today's future slots; emitTimeSlots(filterElapsed=true)
  // naturally returns [] post-close, so the fallback to tomorrow still
  // kicks in. A zone with min_lead_days >= 1 (e.g. outside-GZ city zones)
  // can never be fulfilled today — its earliest day comes from the
  // schedule-for-later calendar below, never a same-day/today chip.
  if (cfg.same_day_allowed === 1 && cfg.min_lead_days === 0 && !pastSameDayCutoff
      && !floorBlocksToday) {
    if (isDayOnly) {
      // Day-only zones don't have per-slot times, so we need an explicit
      // "is today still fulfillable" check — kitchen must not be past
      // close. Ordering after kitchen close → no Today chip.
      const todayStillFulfillable = nowMinutes < closeMin;
      if (todayStillFulfillable) {
        const requiresSurcharge = cfg.same_day_surcharge > 0;
        todayDayChip = {
          slot_id: todayIso,
          date_iso: todayIso,
          is_same_day: true,
          is_day_only: true,
          requires_surcharge: requiresSurcharge,
          surcharge: requiresSurcharge ? cfg.same_day_surcharge : 0,
          label_en: 'Today',
          label_cn: '今天',
        };
        slotDayKind = 'today';
      }
    } else {
      const emitted = emitTimeSlots(startOfDay, todayIso, 'Today', '今天', /*filterElapsed=*/true);
      if (emitted.length) {
        todaySlots.push(...emitted);
        slotDayKind = 'today';
      }
    }
  }

  // ── Fallback: if no same-day options qualified (kitchen closed, all of
  // today's slots elapsed, or same_day_allowed=0), roll forward to
  // tomorrow's full slot list so the customer can still pick a time-slot
  // window without dropping into the calendar. Day-only zones don't get
  // a tomorrow-chip fallback — the Express option already routes to the
  // earliest available day from the schedule window.
  // The floor gates this fallback too, and it MUST: withdrawing today's chips
  // is precisely what makes `todaySlots` empty, so without the guard a fresh
  // floor would push the shopper onto tomorrow — a day earlier than the batch
  // it was raised to protect. Tomorrow qualifies only when the floor allows it.
  const tomorrowClearsFloor = !localFreshFloor || tomorrowIso >= localFreshFloor;
  if (!isDayOnly && todaySlots.length === 0 && cfg.min_lead_days <= 1 && tomorrowClearsFloor) {
    const emitted = emitTimeSlots(tomorrowDate, tomorrowIso, 'Tomorrow', '明天', /*filterElapsed=*/false);
    if (emitted.length) {
      todaySlots.push(...emitted);
      slotDayKind = 'tomorrow';
    }
  }

  // ── Schedule-for-later (calendar) ───────────────────────────────────
  // Earliest selectable day = max(SCHEDULE_MIN_LEAD, zone.min_lead_days).
  // Latest = today + max_lead_days. If max < min, the calendar is empty.
  // A fresh cart raises the floor to the first day its batch can arrive
  // (batchFloorIso) — never lowers it, so a zone whose own lead is already later
  // keeps its lead. If the floor runs past max_date there is no bookable day at
  // all: schedule stays null rather than becoming a backwards range that would
  // make every date "valid" against an inverted comparison.
  const scheduleStartDays = Math.max(SCHEDULE_MIN_LEAD, cfg.min_lead_days);
  const scheduleEndDays   = cfg.max_lead_days;
  let schedule = null;
  if (scheduleEndDays >= scheduleStartDays) {
    const startDate = new Date(middayToday.getTime() + scheduleStartDays * 86400000);
    const endDate   = new Date(middayToday.getTime() + scheduleEndDays   * 86400000);
    let minIso = fmtDateIso(startDate);
    const maxIso = fmtDateIso(endDate);
    if (floorIso && floorIso > minIso) minIso = floorIso;
    if (minIso <= maxIso) {
      schedule = {
        min_date: minIso,
        max_date: maxIso,
        surcharge: 0,
      };
    }
  }

  // Day-only "Express / ship ASAP" date — the zone's TRUE earliest fulfillable
  // day, independent of the schedule calendar's SCHEDULE_MIN_LEAD (=3) floor.
  // That floor only exists so the calendar never overlaps Today/Tomorrow; the
  // Express slot must NOT inherit it, or it reads "Earliest +3 days" even for
  // zones that ship in 1–2 days. Floor at 1 (tomorrow) because a day-only
  // Express slot is never "today" — today is the separate same-day day chip.
  // Express deliberately ignores SCHEDULE_MIN_LEAD, which makes it a SECOND date
  // channel — and one resolveDeliverySlot matches before the schedule-window
  // check (:express_slot branch), so a floor applied only to the calendar would
  // leave Express as an open door onto an unreachable day. Apply the same batch
  // floor here. It can only push the date later, so non-fresh carts are
  // untouched.
  let expressDateIso = expressEarliestIso(zone, tzNow, tz);
  if (floorIso && floorIso > expressDateIso) expressDateIso = floorIso;

  // Explicit Express ("ship ASAP") slot for day-only zones — the zone's true
  // earliest fulfillable day at NO surcharge. Exposed as its own field so the
  // mini app uses ONE authoritative source for both the auto-default and the
  // Express tap, instead of synthesizing from schedule.min_date (which carries
  // the +3-day calendar floor) or — worse — falling back to the surcharged
  // Today chip when that's the only entry in `slots` (which silently added the
  // same-day surcharge to an "Express" order). null when there's no schedule
  // window to ship toward.
  const expressSlot = (isDayOnly && schedule) ? {
    slot_id:    expressDateIso,
    date_iso:   expressDateIso,
    is_same_day: false,
    is_day_only: true,
    requires_surcharge: false,
    surcharge:  0,
    label_en:   `Earliest ${expressDateIso}`,
    label_cn:   `最早 ${expressDateIso}`,
  } : null;

  // "Too late for same-day" copy — shown when the kitchen is still open but the
  // order landed inside the cutoff buffer. Built server-side so both customer
  // apps read one authoritative bilingual string. `closeLabelEn` renders the
  // 24h close hour as a friendly 12h time (20 → "8pm").
  const closeH = Math.floor(closeMin / 60);
  const closeM = String(closeMin % 60).padStart(2, '0');
  const closeLabelEn = (() => {
    const mer = closeH < 12 ? 'am' : 'pm';
    const dh  = closeH % 12 === 0 ? 12 : closeH % 12;
    return closeM === '00' ? `${dh}${mer}` : `${dh}:${closeM}${mer}`;
  })();
  const closeLabelCn = `${closeH}:${closeM}`;
  // Operator can override this copy in Settings → Delivery → Same-day cutoff
  // (delivery.sameDayCutoffMessage). Blank fields fall back to the auto-built
  // text above, which stays accurate as the zone's hours/buffer change.
  const cutoffMsgOverride = cfgValue('delivery.sameDayCutoffMessage', { en: '', cn: '' }) || {};
  const sameDayCutoffMessage = pastSameDayCutoff ? {
    en: (cutoffMsgOverride.en && String(cutoffMsgOverride.en).trim())
      || `Too late for same-day delivery — we stop taking today's orders ${sameDayCutoffMinutes} min before we close at ${closeLabelEn}. Please choose a time for tomorrow.`,
    cn: (cutoffMsgOverride.cn && String(cutoffMsgOverride.cn).trim())
      || `已过今日配送截单时间 — 关门前 ${sameDayCutoffMinutes} 分钟停止接单(今日 ${closeLabelCn} 关门)。请选择明天的配送时段。`,
  } : null;

  return {
    mode: isDayOnly ? 'day_only' : 'time_slots',
    right_away_available: rightAwayAvailable,
    same_day_surcharge:   cfg.same_day_surcharge,
    same_day_allowed:     cfg.same_day_allowed === 1,
    min_lead_days:        cfg.min_lead_days,
    max_lead_days:        cfg.max_lead_days,
    kitchen_open_now:     kitchenOpenNow,
    // Same-day cutoff buffer state — see the pastSameDayCutoff derivation above.
    // `same_day_cutoff_passed` is true only during business hours inside the
    // last `same_day_cutoff_minutes` before close; the message is null otherwise.
    same_day_cutoff_minutes: sameDayCutoffMinutes,
    same_day_cutoff_passed:  pastSameDayCutoff,
    same_day_cutoff_message: sameDayCutoffMessage,
    // When closed, distinguishes "before today's opening" (reopens today) from
    // "after close" (reopens tomorrow) so the UI doesn't always say "tomorrow".
    kitchen_reopens_today: !kitchenOpenNow && nowMinutes < openMin,
    kitchen_hours:        { start: startHour, end: endHour },
    slot_duration_minutes: slotMins,
    holiday_mode:         holidayMode,
    holiday_message:      holidayMode ? holidayMessage : null,
    today_slots:          todaySlots,
    today_day_chip:       todayDayChip,
    // Authoritative Express slot (earliest day, no surcharge) — see expressSlot
    // above. The mini app reads this for the Express default + tap so Express
    // never inherits the Today chip's same-day surcharge.
    express_slot:         expressSlot,
    // 'today' when the chips above are today's, 'tomorrow' when we rolled
    // forward because the kitchen is closed. Drives the chip-strip header.
    slot_day_kind:        slotDayKind,
    schedule,
    // Legacy flat slot list — only TODAY's options now. Anything reading
    // `slots` and trusting it spans multiple days will need to migrate
    // to today_slots + schedule (the mini app does this in the same release).
    //
    // Day-only zones MUST seed at least one Express slot whenever a schedule
    // window exists — otherwise the mini-app's day-only handler bails on
    // an empty `slots` array and renders the Express radio with no label
    // (visible as an empty box). This synth slot is the "ship as soon as
    // possible" option, anchored to the zone's true earliest day
    // (expressDateIso), NOT schedule.min_date. resolveDeliverySlot matches
    // the slot_id against `slots` directly (before the schedule-window check)
    // so an Express date earlier than schedule.min_date still validates on
    // the /orders POST.
    slots: isDayOnly
      ? (todayDayChip
          ? [todayDayChip]
          : (expressSlot ? [expressSlot] : []))
      : todaySlots,
  };
}

// Validate a 'YYYY-MM-DDTHH:MM' pick that lands on a SCHEDULE-FOR-LATER day
// (i.e. not in today/tomorrow's enumerated `slots`). Time-slot zones now offer
// 2-hour windows across the whole calendar, so the customer can pick an hour on
// a future date too — but the server must still confirm the date sits inside the
// schedule window AND the time aligns to a real kitchen-hours window (so a
// hand-crafted slot_id can't book an out-of-hours delivery). Returns a
// synthesized slot object on success, or null to fall through to slot_unavailable.
function matchScheduledTimeSlot(enumed, mTime) {
  if (!enumed || enumed.mode !== 'time_slots') return null;
  const sch = enumed.schedule;
  if (!sch) return null;
  const dateIso = `${mTime[1]}-${mTime[2]}-${mTime[3]}`;
  if (dateIso < sch.min_date || dateIso > sch.max_date) return null;
  const kh       = enumed.kitchen_hours || {};
  const dayStart = Number(kh.start) * 60;
  const dayEnd   = Number(kh.end) * 60;
  const slotMins = Number(enumed.slot_duration_minutes) || 120;
  if (!(dayEnd > dayStart) || !(slotMins > 0)) return null;
  const startCursor = Number(mTime[4]) * 60 + Number(mTime[5]);
  // Must start on a slot boundary inside opening hours, and fit before close
  // (mirrors emitTimeSlots' `cursor + slotMins <= endCursor + 1`).
  if (startCursor < dayStart) return null;
  if ((startCursor - dayStart) % slotMins !== 0) return null;
  if (startCursor + slotMins > dayEnd + 1) return null;
  const endCursor = Math.min(startCursor + slotMins, dayEnd);
  return {
    slot_id:    `${dateIso}T${mTime[4]}:${mTime[5]}`,
    date_iso:   dateIso,
    start_hour: Math.floor(startCursor / 60), start_minute: startCursor % 60,
    end_hour:   Math.floor(endCursor / 60),   end_minute:   endCursor % 60,
    is_same_day: false,
    is_day_only: false,
    requires_surcharge: false,
    surcharge:  0,
    label_en:   `${dateIso}T${mTime[4]}:${mTime[5]}`,
    label_cn:   `${dateIso}T${mTime[4]}:${mTime[5]}`,
  };
}

// Resolve a slot_id back into a Date + validated metadata. Used by the
// orders POST to confirm the customer's pick before persisting.
// Returns { scheduled_for: ISO string, slot, surcharge, kind } or { error }.
// `opts` is forwarded to computeDeliverySlots — in practice { batch } carrying
// earliestBatchMakeDate's decision, so the window this validates against is the SAME window the
// customer was offered. A stale picker holding a date below the batch floor now
// falls outside min_date and is refused with the existing slot_unavailable, with
// no new failure shape for clients to learn.
//
// `kind` IS THE SERVER'S OWN VERDICT ON WHAT KIND OF PICK THIS IS, and it is
// returned here rather than derived by the caller because this function is the
// only place that knows WHICH BRANCH matched. The same date string can be a
// day-only Today chip, an Express earliest-day, or a calendar pick, and telling
// them apart is exactly the branching below — a caller re-deriving it from the
// date alone would have to guess at the one distinction (express vs schedule)
// that no date comparison can make.
//
// It exists because `delivery_slot_kind` used to be taken from the request body
// and stored unchecked, while deciding the out-of-city warehouse pin, the local
// pre-order gate, courier-vs-rider parcels (planShipments) and the Qingyun rider
// queue (isQingyunSameCityToday). A client could send 'today' beside the FREE
// Express slot and be routed and dispatched as same-day without the surcharge
// resolveDeliverySlot had just computed as zero. The value the server resolved
// is now the value the server stores.
//
//   'right_away' — the no-date ASAP pick (time-slot zones, kitchen open)
//   'today'      — a slot whose date IS today (the day-only Today chip, or a
//                  time-slot window on today)
//   'express'    — the day-only zone's earliest fulfillable day, no surcharge
//   'schedule'   — anything else: a deliberate future calendar day or window
//
// 'pickup' and 'restock' are order-level states rather than slot shapes and are
// applied by the caller, which is the only side that knows them.
// One line when a submitted delivery_slot_kind disagrees with the one the server
// resolved. DERIVE AND DISCARD, NEVER VALIDATE-AND-REJECT: a mismatch is not a
// reason to refuse an otherwise valid order — the slot itself has already been
// validated, and the kind is now computed rather than accepted, so there is
// nothing left to protect by failing. This exists only so the disagreement is
// visible.
//
// Silent when they agree, when nothing was sent (older clients, and the mini
// app's own '' for a time-slot zone), and when the order has no kind at all.
// Never throws: this runs after the order has committed and must not be able to
// turn a placed order into a 500.
function logSlotKindMismatch(orderId, submitted, derived, where) {
  try {
    const sent = submitted == null ? '' : String(submitted).trim();
    if (!sent) return;
    if (sent === String(derived || '')) return;
    console.warn(
      `[slot-kind mismatch] ${where} order=${orderId} submitted=${JSON.stringify(sent)} derived=${JSON.stringify(derived)}`
    );
  } catch (_) { /* a log line must never cost a placed order */ }
}

function resolveDeliverySlot(zone, slotId, now, opts = {}) {
  const tz = opts.tz || deliveryTz();
  if (!slotId) return { scheduled_for: null, slot: null, surcharge: 0, kind: null };
  if (slotId === 'right_away') {
    const enumed = computeDeliverySlots(zone, now, opts);
    if (!enumed.right_away_available) return { error: 'right_away_unavailable' };
    return { scheduled_for: null, slot: { slot_id: 'right_away' }, surcharge: 0, kind: 'right_away' };
  }
  const enumed = computeDeliverySlots(zone, now, opts);
  // Two slot-id shapes: 'YYYY-MM-DDTHH:MM' (today's time-slot pick) or
  // 'YYYY-MM-DD' (today's day-only chip OR any schedule-for-later calendar
  // pick). For the latter, the day need not be in `slots` (the calendar
  // covers an open range) — we just validate it falls inside the
  // schedule window or matches the today_day_chip.
  let dt, found, kind;
  const mTime = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(slotId);
  const mDay  = /^(\d{4})-(\d{2})-(\d{2})$/.exec(slotId);
  if (mTime) {
    found = enumed.slots.find(s => s.slot_id === slotId);
    // Not in today/tomorrow's chips → try a scheduled-for-later time window
    // (time-slot zones offer hour windows across the whole calendar).
    if (!found) found = matchScheduledTimeSlot(enumed, mTime);
    if (!found) return { error: 'slot_unavailable' };
    // A time-slot window is same-day only when its own date is today —
    // emitTimeSlots stamps that on the chip, and matchScheduledTimeSlot's
    // synthesized windows are calendar days and always carry false.
    kind = found.is_same_day ? 'today' : 'schedule';
    // scheduled_for is persisted from this, so it must be the instant the
    // TENANT's clock reads that slot, not the host's.
    dt = businessDate.dateInZone(tz, `${mTime[1]}-${mTime[2]}-${mTime[3]}`, Number(mTime[4]), Number(mTime[5]));
  } else if (mDay) {
    // Same-day day-only chip first (Panyu).
    found = enumed.slots.find(s => s.slot_id === slotId);
    if (found) kind = found.is_same_day ? 'today' : 'express';
    // Express ("ship ASAP") day — its date is the zone's true earliest and can
    // sit EARLIER than the schedule-for-later window's +3-day floor, so it
    // wouldn't pass the window check below. Match it explicitly (no surcharge).
    if (!found && enumed.express_slot && enumed.express_slot.slot_id === slotId) {
      found = enumed.express_slot;
      kind  = 'express';
    }
    if (!found) {
      // Otherwise it must fall inside the schedule-for-later window.
      const sch = enumed.schedule;
      if (!sch || slotId < sch.min_date || slotId > sch.max_date) {
        return { error: 'slot_unavailable' };
      }
      kind = 'schedule';
      found = {
        slot_id: slotId,
        date_iso: slotId,
        is_same_day: false,
        is_day_only: true,
        requires_surcharge: false,
        surcharge: 0,
        label_en: slotId,
        label_cn: slotId,
      };
    }
    dt = businessDate.dateInZone(tz, `${mDay[1]}-${mDay[2]}-${mDay[3]}`, 0, 0);
  } else {
    return { error: 'slot_invalid' };
  }
  return {
    scheduled_for: dt.toISOString(),
    slot: found,
    surcharge: found.requires_surcharge ? Number(found.surcharge) || 0 : 0,
    kind,
  };
}

module.exports = {
  hhmmToMinutes, batchScheduleCfg, deliveryTz, parseYmdLocal, toYmdLocal, tzNowParts, nextBatchShipDate,
  batchItemsInCart, todaysBatchStillComing, slotWindowEnd, freshLinesCoveredToday, expressEarliestIso,
  storeDeliveryWindow, computeDeliverySlots, matchScheduledTimeSlot, logSlotKindMismatch, resolveDeliverySlot,
};
