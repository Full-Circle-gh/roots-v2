'use strict';

// THE FAPIAO REMINDER THAT COMES BACK.
//
// A customer asks for a 发票 with their order. Until this file, the whole of
// what the system did about it was put an amber row on Home — "Invoices to
// issue · 待开发票" — and wait for somebody to walk past it. Nothing buzzed,
// ever: lib/push-events.js listed four operator alerts (new orders, restock,
// deliveries due, low stock) and a 发票 was not one of them. The one switch in
// settings called "Invoices" is the CUSTOMER's notification, sent when the
// fapiao is issued, which is the opposite end of the same job.
//
// On 2026-09-11 an operator found two requests unissued from 21 and 26 August.
// Both had crossed a month boundary in silence.
//
// ── WHY DISMISSING ONE DOES NOTHING ──────────────────────────────────────
// THIS IS THE WHOLE IDEA, so it is the first thing stated: the only thing that
// stops the reminder is the fapiao being ISSUED.
//
// Swiping a banner away writes nothing to the database. The order still
// matches lib/fapiao-queue.js's pendingSql on the next sweep, its window opens
// again, and it asks again. There is no "dismissed" column for a sweep to read
// because there must not be one — a dismissal is a statement about a phone, not
// about the work.
//
// Each order carries a TAG (`retail-fapiao-<id>`), so the second reminder
// REPLACES the first in the tray rather than stacking beside it, and public/sw.js
// sets `renotify` whenever a tag is present, so the replacement still re-alerts.
// One invoice holds one slot in the tray however many times it has asked.
//
// ── THE ONE THING THAT IS NOT A DISMISSAL: "not today" ───────────────────
// There is exactly one way to make this quiet without issuing the fapiao, and
// it is deliberately not the banner. `invoice_reminder_snoozed_until` is set by
// an operator pressing a control on the Invoices screen — a decision, taken on
// a screen, by somebody holding `invoices:manage`.
//
// It exists because without it the only available way to say "I know, not
// today" is to switch the whole category off, and the notification that then
// goes unread is somebody else's refund. lib/push-events.js is written about
// exactly that failure: "The switch that gets used is the one that turns the
// whole thing off, and then the pick that mattered arrives nowhere."
//
// THREE PROPERTIES KEEP IT FROM BECOMING A WAY TO NEVER DO THE WORK:
//   • It reaches tomorrow's REMIND_HOUR and no further, so one press can hide
//     at most ONE ask. There is no "next week".
//   • IT QUIETS THE PUSH ONLY. The order still matches pendingSql, so Home's
//     "Needs you" row still counts it and still goes brick at month-end. The
//     work never leaves the screen an operator walks past; only the
//     interruption is deferred.
//   • It is visible on the row that owns it, and pressing again lifts it.
//
// A snooze taken during month-end is honoured, and that is a decision rather
// than an oversight: silencing the control for three days a month would leave
// a button that reads as set and buzzes anyway, and a lying control is worse
// than one day of chosen silence — especially when Home is still showing the
// row in brick the whole time.
//
// ── A WINDOW, NOT A LATCH — the distinction lib/alert-latch.js already draws ─
// That file says it better than a paraphrase can:
//
//     A latch answers "is this condition still flagged?" … It is the wrong
//     question for an ADVISORY, which has no moment at all. "This login expires
//     on Thursday" is true all week; what it needs is not a flag but a WINDOW —
//     say it at most once every N hours, and mean it across restarts.
//
// An unissued fapiao is exactly that shape. It has no moment; it is true every
// day until somebody acts. So lib/delivery-reminders.js's once-ever claim —
// `UPDATE … WHERE reminder_ship_sent_at IS NULL`, where a non-null stamp means
// never again — is the wrong mechanism here, and is why that file could not
// simply be given a fifth case. The claim below is the same atomic UPDATE with
// a window in the WHERE instead of a NULL check: only the tick that moves the
// stamp sends, so overlapping ticks and restarts cannot double-fire, and the
// row becomes claimable again once the window has passed.
//
// ── THE CADENCE, AND WHY IT KEYS OFF MONTH-END ───────────────────────────
// Not a flat repeat. A flat repeat is either too loud on the first day or too
// quiet in the week that actually matters.
//
//   first 24h    silent — the request is already on Home, and an operator gets
//                their working day before the phone starts asking
//   then         every 48h
//   last 3 days  every 24h, and Home's row goes from amber to brick
//   of the month
//
// The month-end rule is the point. Elapsed days are not what makes a late
// fapiao expensive; the month boundary is. A 发票 requested in August and
// issued in September is issued in the wrong tax period against an August
// order, and no amount of "it is 12 days old" says that. Both of the requests
// found on 2026-09-11 would have been asking daily from 29 August.
//
// ── AT 10:00, WHICH IS NOT QUIET HOURS ───────────────────────────────────
// Reminders fire at 10:00 Beijing rather than at whatever moment the window
// happens to open, so nobody is woken at 03:00 by a fapiao.
//
// This is NOT the quiet-hours setting lib/push-events.js refuses, and the
// difference matters enough to name: quiet hours silence an alert that has
// already become true, by a clock somebody typed once — "an operational alert
// dropped by a clock is indistinguishable from one that failed". This is the
// reminder's own schedule, the same DAYOF_HOUR = 10 lib/delivery-reminders.js
// uses for a date-only delivery. Nothing is dropped; it is sent at ten.
//
// Timezone (§82): the SHOP's, never the host's. These used to read the host's
// Date getters on the grounds that the production host runs UTC+8; on the UTC
// host §82 requires, ten in the morning became six in the evening and month-end
// started on the wrong day. Every function below takes the shop's zone (null →
// the system default) and the sweep passes lib/business-date.js shopTimezone.
// The order's placed_at is SQLite's zone-less UTC stamp, and is read as UTC
// (parseStoredUtc) — read on the host's clock it was eight hours early even on
// the UTC+8 host, so a first reminder could come a day sooner than it should.
//
// ── ONE DIGEST ABOVE THREE ───────────────────────────────────────────────
// Two open requests, a push each — naming the customer is what makes it
// actionable. Twenty open requests, twenty banners is how a merchant learns to
// turn notifications off, and the notification that then goes unread is the
// refund one (lib/low-stock-digest.js reached this conclusion first, for the
// same reason, and the threshold here is lower only because a fapiao queue is
// smaller than a shopping list). Above three, one message with the count and
// the age of the oldest.
//
// Shape copied from lib/delivery-reminders.js and lib/low-stock-digest.js on
// purpose: same boot-time sweeper, same per-tenant fan-out, same two-realm
// send, same best-effort never-throw contract. A third scheduling idea in this
// codebase would be a third thing to get wrong.

const fapiaoQueue = require('./fapiao-queue');
const businessDate = require('./business-date');

let _push = null;
try { _push = require('../routes/push'); }
catch (e) { console.warn('[fapiao.reminder] push module not available:', e.message); }

const REMIND_HOUR      = 10;   // 10:00 shop-local, like delivery-reminders' date-only case
const FIRST_DELAY_H    = 24;   // silence on the day the request arrives
const REPEAT_H         = 48;   // the ordinary cadence
const MONTH_END_H      = 24;   // the cadence inside MONTH_END_DAYS
const MONTH_END_DAYS   = 3;    // how many days at the end of a month count as month-end
const DIGEST_OVER      = 3;    // more than this many pending → one message, not one each

// ── When is it month-end? ────────────────────────────────────────────────────
// The last MONTH_END_DAYS calendar days, whatever the month's length: 29–31 in
// August, 26–28 in a common February. Computed from the month rather than a
// fixed date so February is not quietly exempt.
function isMonthEnd(now, tz = null) {
  const p = businessDate.zoneParts(tz, now);
  const daysInMonth = new Date(Date.UTC(p.y, p.m, 0)).getUTCDate();   // day 0 of next month
  return p.d > daysInMonth - MONTH_END_DAYS;
}

// The next REMIND_HOUR at or after `anchor` + `gapHours`. Returns a Date.
//
// Anchoring on the hour rather than on anchor+gap exactly is what keeps every
// reminder at ten in the morning no matter what time of day the request came
// in: a fapiao asked for at 23:40 does not spend the rest of its life waking
// people at 23:40.
function dueAfter(anchor, gapHours, tz = null) {
  const earliest = new Date(anchor.getTime() + gapHours * 3600_000);
  const at = businessDate.wallClockOnDay(tz, earliest, REMIND_HOUR, 0);
  if (at.getTime() >= earliest.getTime()) return at;
  // The next calendar day's ten, on the shop's calendar: midday of this day
  // plus a day lands on the next day whatever the zone's DST does.
  const nextDay = businessDate.businessDate(tz,
    new Date(businessDate.dateInZone(tz, businessDate.businessDate(tz, earliest), 12, 0).getTime() + 86_400_000));
  return businessDate.dateInZone(tz, nextDay, REMIND_HOUR, 0);
}

// When is this row next due? `last` is invoice_reminder_last_at (null = never
// asked), `placed` is when the customer asked for the fapiao.
//
// A never-reminded row waits FIRST_DELAY_H from the REQUEST; a reminded one
// waits the repeat gap from the LAST REMINDER. Anchoring the repeat on the
// last send rather than on the request is what stops a months-old debt from
// being permanently overdue and therefore firing on every single tick.
function nextDueAt(last, placed, monthEnd, tz = null) {
  if (!last) return dueAfter(placed, FIRST_DELAY_H, tz);
  return dueAfter(last, monthEnd ? MONTH_END_H : REPEAT_H, tz);
}

/**
 * Is this row deferred past `now`? Null, blank or unparseable all read as NOT
 * snoozed — a stamp nobody can read must not silence a debt.
 */
function isSnoozed(until, now) {
  if (!until) return false;
  const d = new Date(until);
  if (isNaN(d.getTime())) return false;
  return d.getTime() > now.getTime();
}

/**
 * Where "not today" lands: TOMORROW's REMIND_HOUR, shop-local.
 *
 * Not `now + 24h`, which would drift the reminder hour a little further into
 * the evening on every press until the chase arrived at midnight. Not today's
 * REMIND_HOUR either — pressing it at 09:00 must not leave an ask an hour
 * later. The next calendar day at ten, whatever time the press happened.
 *
 * Exported because the route that writes the stamp and the sweep that reads it
 * have to agree about what "tomorrow" means, and two implementations of that
 * would eventually disagree by an hour on one day of the year.
 */
function snoozeTarget(now, tz = null) {
  const tomorrow = businessDate.businessDate(tz,
    new Date(businessDate.dateInZone(tz, businessDate.businessDate(tz, now), 12, 0).getTime() + 86_400_000));
  return businessDate.dateInZone(tz, tomorrow, REMIND_HOUR, 0);
}

// WHO IS TOLD. `invoices:manage`, not `invoices:view` — lib/capabilities.js
// says it plainly: "Issuing a 发票 is a fiscal act, not a record of one." The
// audience is whoever can actually do the thing, not everyone who can read the
// list.
//
// Two sends for the same reason lib/delivery-reminders.js documents at length:
// the capability send reaches an account's own operators (tenant_users holding
// capabilities), the kitchen-permission send is what the first account's staff
// have always received. A person holding both realms gets two; the alternative
// is an account that gets none.
function notifyOperators(tenantId, payload) {
  // `event` names the switch this alert answers to (audit E-10, lib/push-events).
  payload = { ...payload, event: 'invoice_pending' };
  if (tenantId != null && _push && _push.sendPushToOperatorsWithCaps) {
    Promise.resolve(_push.sendPushToOperatorsWithCaps(tenantId, ['invoices:manage'], payload))
      .catch(e => console.warn('[fapiao.reminder operator push]', e.message));
  }
  if (_push && _push.sendPushByPermission) {
    Promise.resolve(_push.sendPushByPermission('retail', payload))
      .catch(e => console.warn('[fapiao.reminder push]', e.message));
  }
}

// Whole days between two instants, floored. Used only for the age in a message.
const daysBetween = (a, b) => Math.max(0, Math.floor((b.getTime() - a.getTime()) / 86_400_000));

// THE DESTINATION IS THE PHONE'S OWN PARAMETER, deliberately.
//
// delivery-reminders sends '/?tab=orders', which both surfaces understand. There
// is no equivalent here: `?tab=invoices` on the DESKTOP opens the purchasing
// Invoices screen (public/retail-admin/16-purchasing.js) — supplier invoices,
// the other direction entirely, and a worse place to land than the default.
// `?to=` is m.html's own shortcut parameter, which the phone reads (it accepts
// `to` first, then `tab`) and the desktop ignores. The phone is the surface
// holding the push subscription, so it is the one that gets deep-linked; the
// desktop opens where it always does.
const OPEN_URL = '/?to=invoices';

function pushForOne(o, tenantId, monthEnd) {
  // Title from the live pair Home's row already prints; body is the order
  // number and the money, which need no label in either language.
  const title = monthEnd ? '🧾 Issue before month end · 本月内开票'
                         : '🧾 Invoices to issue · 待开发票';
  const who   = o.invoice_title || o.buyer || '';
  const body  = [o.order_no, o.total != null ? '¥' + o.total : '', who].filter(Boolean).join(' · ');
  notifyOperators(tenantId, { title, body, url: OPEN_URL, tag: 'retail-fapiao-' + o.id });
}

function pushDigest(rows, now, tenantId, monthEnd) {
  const oldest = rows.reduce((acc, r) => {
    const d = businessDate.parseStoredUtc(r.placed_at);
    return (!acc || (d && d < acc)) ? (d || acc) : acc;
  }, null);
  const age = (oldest && !isNaN(oldest.getTime())) ? daysBetween(oldest, now) : null;
  const title = monthEnd ? '🧾 Issue before month end · 本月内开票'
                         : '🧾 Invoices to issue · 待开发票';
  // Count and age only. Both are numerals, and a numeral needs no label — the
  // tail is the live "oldest · 最久" pair the Home row already uses for exactly
  // this figure.
  const body = rows.length + (age != null ? ' · oldest ' + age + 'd · 最久 ' + age + ' 天' : '');
  notifyOperators(tenantId, { title, body, url: OPEN_URL, tag: 'retail-fapiao-digest' });
}

// Sweep one data-plane DB once. Returns the number of reminders fired (a digest
// counts as one).
function sweepDbOnce(db, now, tenantId = null) {
  const tz = businessDate.shopTimezone(db);
  const monthEnd = isMonthEnd(now, tz);
  let rows;
  try {
    rows = db.prepare(
      `SELECT o.id, o.order_no, o.total, o.placed_at, o.invoice_title,
              o.invoice_reminder_last_at, o.invoice_reminder_count,
              o.invoice_reminder_snoozed_until,
              COALESCE(NULLIF(TRIM(c.nickname), ''), NULLIF(TRIM(o.recipient_name), '')) AS buyer
         FROM retail_orders o
         LEFT JOIN retail_customers c ON c.id = o.customer_id
        WHERE ${fapiaoQueue.pendingSql('o')}
        ORDER BY o.placed_at ASC`
    ).all();
  } catch (e) {
    // A tenant DB provisioned before these columns existed throws "no such
    // column" — initTenantSchema backfills whole tables, not columns. Add them
    // here so the tenant self-heals, then skip this tick. Same shape, and the
    // same reason, as delivery-reminders' reminder_ship_sent_at.
    if (/no such column/i.test(e.message)) {
      try { db.exec('ALTER TABLE retail_orders ADD COLUMN invoice_reminder_last_at DATETIME'); } catch { /* already there */ }
      try { db.exec('ALTER TABLE retail_orders ADD COLUMN invoice_reminder_count INTEGER DEFAULT 0'); } catch { /* already there */ }
      try { db.exec('ALTER TABLE retail_orders ADD COLUMN invoice_reminder_snoozed_until DATETIME'); } catch { /* already there */ }
      return 0;
    }
    throw e;
  }

  // Which of them are due right now?
  const due = [];
  for (const o of rows) {
    const placed = businessDate.parseStoredUtc(o.placed_at);
    if (!placed) continue;                      // unparseable; nothing to anchor on
    // "Not today." Skipped, never claimed — the stamp is untouched, so once the
    // snooze lapses the row resumes its own cadence rather than restarting it.
    // An unparseable stamp is treated as no snooze: failing towards asking is
    // the safe direction for a debt.
    if (isSnoozed(o.invoice_reminder_snoozed_until, now)) continue;
    const last = o.invoice_reminder_last_at ? new Date(o.invoice_reminder_last_at) : null;
    const at = nextDueAt(last && !isNaN(last.getTime()) ? last : null, placed, monthEnd, tz);
    if (at.getTime() <= now.getTime()) due.push(o);
  }
  if (!due.length) return 0;

  // THE CLAIM. Atomic, and a WINDOW rather than a NULL check: the row is
  // claimable again once its gap has passed, which is the whole difference
  // between this and a once-ever reminder. `last_at` is re-tested inside the
  // UPDATE against the value the SELECT saw, so a concurrent tick that already
  // claimed the row changes nothing here and we skip it.
  const claim = db.prepare(
    `UPDATE retail_orders
        SET invoice_reminder_last_at = ?,
            invoice_reminder_count   = COALESCE(invoice_reminder_count, 0) + 1
      WHERE id = ?
        AND invoice_reminder_last_at IS ?`
  );
  const stamp = now.toISOString();
  const claimed = [];
  for (const o of due) {
    // SQLite's IS compares like = but matches NULL to NULL, so one placeholder
    // covers both "never reminded" and "last reminded at exactly this stamp".
    const r = claim.run(stamp, o.id, o.invoice_reminder_last_at || null);
    if (r.changes > 0) claimed.push(o);
  }
  if (!claimed.length) return 0;

  // Above the threshold the queue is a list, not a set of individual jobs.
  if (claimed.length > DIGEST_OVER) {
    pushDigest(claimed, now, tenantId, monthEnd);
    return 1;
  }
  for (const o of claimed) pushForOne(o, tenantId, monthEnd);
  return claimed.length;
}

// Start the sweeper. ctx = { mainDb, getTenantDb } fans out across active
// tenants (mirrors the delivery and low-stock sweepers); a bare better-sqlite3
// handle, or no ctx, falls back to a single-DB sweep.
//
// Ten minutes, not sixty seconds. The finest granularity this cadence has is
// one hour of one day, so a minute tick would be 59 wasted passes over the
// orders table an hour, forever, on every tenant.
function startFapiaoReminderSweeper(ctx = {}, { intervalMs = 600_000 } = {}) {
  const legacyDb = (ctx && typeof ctx.prepare === 'function') ? ctx : null;
  const { mainDb, getTenantDb } = legacyDb ? {} : ctx;
  const tick = () => {
    try {
      const now = new Date();
      let total = 0;
      if (legacyDb) {
        total += sweepDbOnce(legacyDb, now);
      } else if (mainDb && getTenantDb) {
        let tenants;
        try { tenants = mainDb.prepare("SELECT id FROM tenants WHERE status = 'active'").all(); }
        catch { tenants = null; }               // tenants table not migrated yet
        if (!tenants) {
          total += sweepDbOnce(mainDb, now);
        } else {
          for (const t of tenants) {
            try { total += sweepDbOnce(getTenantDb(t.id), now, t.id); }
            catch (e) { console.error('[fapiao.reminder] tenant ' + t.id + ' failed', e.message); }
          }
        }
      } else if (mainDb) {
        total += sweepDbOnce(mainDb, now);
      }
      if (total > 0) console.log(`[fapiao.reminder] fired=${total}`);
    } catch (e) {
      console.error('[fapiao.reminder] tick error', e);
    }
  };
  setTimeout(tick, 20_000);
  const handle = setInterval(tick, intervalMs);
  handle.unref?.();
  return handle;
}

module.exports = {
  startFapiaoReminderSweeper,
  sweepDbOnce,
  isMonthEnd,
  isSnoozed,
  snoozeTarget,
  dueAfter,
  nextDueAt,
  REMIND_HOUR,
  FIRST_DELAY_H,
  REPEAT_H,
  MONTH_END_H,
  MONTH_END_DAYS,
  DIGEST_OVER,
};
