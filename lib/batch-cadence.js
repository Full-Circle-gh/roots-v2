'use strict';

/* ══════════════════════════════════════════════════════════════════════════
   THE BATCH CADENCE, WHERE BOTH READERS CAN REACH IT — §85.
   ──────────────────────────────────────────────────────────────────────────
   Two things now need to know whether today is a batch day: the checkout, which
   has always asked (§74, §80), and a stock daemon deciding what number to push
   to Meituan, Eleme and gzgrocery. The arithmetic lived inside
   `routes/retail.js` and it stays the SAME arithmetic — it is MOVED here and
   that file calls it, not copied.

   THE COPY RULE IS §80'S AND IT IS LOAD-BEARING. That section collapsed three
   written-out copies of this cadence into one function on the explicit ground
   that "the pill, the checkout and the order agree". A fourth copy living in a
   daemon would undo precisely that, and would do it where nobody would notice:
   the platform would quietly disagree with the app about which day a batch
   falls on. A daemon also cannot require a 36,000-line express router to answer
   a date question, which is the other half of why this file exists.

   `lib/inventory.js` STILL LEARNS NOTHING. §80 drew that line — inventory is a
   question about shelves and is not taught a production cadence — and this
   module is not required from there. The suite that pins it is unchanged.

   EVERY DATE RESOLVES IN THE TENANT'S ZONE (§82). Nothing here reads the host
   clock: `businessDate` takes the zone explicitly, and a null zone is passed
   straight through to mean the system default, exactly as routes/retail.js
   already treats it.
   ══════════════════════════════════════════════════════════════════════════ */

const businessDate = require('./business-date');

// The channels a pre-order window can be opened for. A name outside this set is
// dropped on read rather than trusted: the config is operator-editable JSON, and
// an unknown channel silently becoming "open" is the wrong direction to fail.
const PREORDER_CHANNELS = ['meituan', 'eleme', 'gzgrocery'];

function tzOf(db) {
  try { return businessDate.shopTimezone(db); } catch (_) { return null; }
}

/* Smallest batch day (YYYY-MM-DD) on or after `fromDate`, skipping any
   skip_dates by rolling forward another whole interval. null when disabled.

   MOVED VERBATIM from routes/retail.js's nextBatchShipDate — same midday
   anchoring for DST safety, same modulo, same 365-step guard. `cfg` is that
   file's own normalised config object, so its extra copy fields are simply
   unread here rather than needing a second shape. */
function nextBatchDate(fromDate, cfg, tz) {
  if (!cfg) return null;
  const anchor = businessDate.dateInZone(tz, cfg.anchor_date, 12, 0);
  if (!anchor) return null;
  const DAY = 86400000;
  const interval = Math.max(1, parseInt(cfg.interval_days, 10) || 2);
  const skip = new Set(cfg.skip_dates || []);
  const ymd = (d) => businessDate.businessDate(tz, d);
  const from = businessDate.dateInZone(tz, ymd(fromDate), 12, 0);
  const diff = Math.round((from.getTime() - anchor.getTime()) / DAY);
  const rem = ((diff % interval) + interval) % interval;       // 0..interval-1
  const offset = rem === 0 ? diff : diff + (interval - rem);   // first on-cadence day >= diff
  let cand = new Date(anchor.getTime() + offset * DAY);
  let guard = 0;
  while (skip.has(ymd(cand)) && guard < 365) {
    cand = new Date(cand.getTime() + interval * DAY);
    guard++;
  }
  return ymd(cand);
}

/* The parts of `batch.schedule` a stock push needs, read straight from the
   tenant's storefront_config.

   DELIBERATELY NOT routes/retail.js's `batchScheduleCfg()`, which normalises
   fourteen fields of operator popup copy this path has no use for. What the two
   share is the cadence arithmetic above and the KEY they read; duplicating the
   copy normalisation to get at four numbers would be the larger duplication.

   Returns null on anything that means "off", so a caller has one thing to test:
   no row, malformed JSON, the switch off, or no anchor date. */
function readCfg(db) {
  let raw;
  try {
    const row = db.prepare("SELECT value_json FROM storefront_config WHERE key = 'batch.schedule'").get();
    if (!row) return null;
    raw = JSON.parse(row.value_json);
  } catch (_) { return null; }
  if (!raw || !raw.enabled || !raw.anchor_date) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw.anchor_date))) return null;

  const hour = (v, fallback = null) => {
    const n = parseInt(v, 10);
    return (Number.isFinite(n) && n >= 0 && n <= 23) ? n : fallback;
  };
  const cutoff = hour(raw.cutoff_hour, 20);
  const ready = hour(raw.ready_hour, null);
  /* THE LOCK HOUR FALLS BACK TO THE READY HOUR, not to a literal. They answer
     different questions — "when may a platform still take a pre-order" and
     "when does the batch reach the shelf" — but a tenant that has set only the
     second has said the one thing that makes the first answerable, and Ash's
     own case has them at the same hour (11:00). An operator who wants them
     apart sets both; nobody has to set two numbers to express one. */
  const lock = hour(raw.lock_hour, ready);
  /* §102 — WHEN THE WINDOW OPENS, which until now nobody had chosen. The lock
     hour was Ash's and is; the start was simply the absence of a lower bound in
     preorderWindow, which landed it on midnight. It is a setting now, and it
     DEFAULTS TO 0 so that a tenant who never touches the field keeps exactly
     the behaviour they have — the same no-migration shape §74 and §85 chose.
     A malformed or out-of-range value falls back to 0 for the same reason: this
     field can only ever narrow the window, so failing it open is failing it the
     way it already worked. */
  const openHour = hour(raw.preorder_open_hour, 0);

  const rawQty = parseInt(raw.preorder_qty, 10);
  const qty = (Number.isFinite(rawQty) && rawQty > 0) ? rawQty : 0;

  const channels = Array.isArray(raw.preorder_channels)
    ? raw.preorder_channels.filter((c) => PREORDER_CHANNELS.includes(c))
    : [];

  return {
    anchor_date: String(raw.anchor_date),
    interval_days: Math.max(1, parseInt(raw.interval_days, 10) || 2),
    skip_dates: Array.isArray(raw.skip_dates)
      ? raw.skip_dates.filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)))
      : [],
    cutoff_hour: cutoff,
    ready_hour: ready,
    lock_hour: lock,
    preorder_open_hour: openHour,
    preorder_qty: qty,
    preorder_channels: channels,
  };
}

/* IS THE PRE-ORDER WINDOW OPEN, for this channel, at this instant?

   Six conditions, and any one of them missing is the off switch:
     • the schedule is enabled and has an anchor  (readCfg returns null if not)
     • an allowance is set                        (preorder_qty > 0)
     • this channel is named                      (preorder_channels)
     • the hour is at or after the start          (preorder_open_hour, §102)
     • the hour is before the lock                (lock_hour)
     • today is on the cadence, skip_dates and all
   With none of them set — which is every tenant today — this returns closed and
   nothing anywhere behaves differently. That is the same shape §74 chose for
   `ready_hour` and it is chosen again for the same reason: no migration, no
   backfill, and nothing to undo if it is never switched on.

   Returns { open, qty, lock_hour, reason }. `reason` names the FIRST condition
   that failed, so a diagnostic can say which one rather than "closed". */
function preorderWindow(db, { channel, now = new Date(), cfg = null, tz } = {}) {
  const shut = (reason) => ({ open: false, qty: 0, lock_hour: null, reason });
  const c = cfg || readCfg(db);
  if (!c) return shut('no_schedule');
  if (!(c.preorder_qty > 0)) return shut('no_allowance');
  if (!channel || !c.preorder_channels.includes(channel)) return shut('channel_off');
  if (c.lock_hour == null) return shut('no_lock_hour');

  const zone = tz === undefined ? tzOf(db) : tz;
  const parts = businessDate.zoneParts(zone, now || new Date());
  /* §102 — BEFORE THE TENANT'S OWN START. Tested before the lock so the reason
     names the edge the clock is actually on: at 05:00 with a 06:00 start the
     honest answer is "not yet", not "past the lock". A start at or after the
     lock is operator error and lands here as a window that never opens, which
     is the safe direction; the settings card refuses that pair outright rather
     than letting it be saved, on §85's own "refused, never silently coerced"
     rule for the hours beside it. */
  if (parts.hour < c.preorder_open_hour) return shut('before_open_hour');
  if (parts.hour >= c.lock_hour) return shut('past_lock');
  /* THE ORDERING CUTOFF STILL APPLIES, and it is tested separately from the
     lock so a `lock_hour` set later than `cutoff_hour` — operator error, but
     expressible — cannot open a window on a day whose ordering has already
     shut. §74 settled this direction for `ready_hour` and the same answer holds
     here: the cutoff wins, which is the safe way round. */
  if (parts.hour >= c.cutoff_hour) return shut('past_cutoff');
  if (nextBatchDate(now || new Date(), c, zone) !== parts.ymd) return shut('not_a_batch_day');

  return { open: true, qty: c.preorder_qty, lock_hour: c.lock_hour, reason: 'open' };
}

/* §102 — DOES AN OPEN PRE-ORDER WINDOW OPEN THE DAEMON'S SYNC GATE?

   The daemons gate every push and every order read on `isStoreOpen()` — the
   store's opening hours widened at the front by its "Sync starts · 同步开始"
   time or the two-hour default. §85 opens the pre-order window at the tenant's
   own start hour, which can be, and by default is, hours EARLIER than that. The
   gap between the two is dead time: on Meituan the midnight flip enqueues the
   allowance and nothing pushes it until 08:00, and on Eleme — whose pushes were
   never hours-gated — the allowance publishes but the orders against it are not
   read, so the shelf never falls and the window stops capping itself.

   So a channel with an OPEN pre-order window is syncable, whatever the hour.

   IT IS ONE FUNCTION BECAUSE §80's COPY RULE IS THE RULE HERE TOO. Two daemons
   each carrying their own "…and also when the pre-order window is open" is how
   they come to disagree about a morning, in the place nobody would look.

   IT SWALLOWS ITS OWN ERRORS, for `flipTick`'s reason: this sits inside a gate
   that runs on a ten-second loop, and a config read must never be the thing
   that takes a daemon down. A false answer is the daemon's existing behaviour.

   NOTHING IS WIDENED FOR A TENANT WHO HAS NOT ASKED. Every one of §85's off
   switches is still upstream of this: the schedule enabled, an allowance set,
   this channel named, today on the cadence, the hour inside [start, lock). With
   none of them set — which is most tenants — this is false all day and the
   daemons behave exactly as they did. */
function preorderSyncOpen(db, { channel, now = new Date() } = {}) {
  try { return preorderWindow(db, { channel, now }).open === true; }
  catch (_) { return false; }
}

/* The window state as a comparable string, for a caller watching for the FLIP.
   The daemons poll this on their ten-second loop; a string that changes only
   when the answer changes is what keeps that poll free. */
function windowStamp(db, { channel, now = new Date() } = {}) {
  const w = preorderWindow(db, { channel, now });
  return `${channel}:${w.open ? 'open' : 'shut'}:${w.qty}`;
}

module.exports = { nextBatchDate, readCfg, preorderWindow, preorderSyncOpen, windowStamp, tzOf, PREORDER_CHANNELS };
