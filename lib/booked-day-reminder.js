'use strict';

/* ══════════════════════════════════════════════════════════════════════════
   ON THE MORNING OF A BOOKED DAY, THE NEW-ORDER GROUP IS REMINDED.
   ──────────────────────────────────────────────────────────────────────────
   Ash: "when there is an order that schedule for later there should be an
   alert in wecom in the same bot of the new order group". The new-order card
   fires when the order is PAID, which for a booking can be days before the
   delivery day, and by then it has scrolled out of the group. This sends one
   message on the booked day's morning listing that day's booked deliveries.

   ── WHICH ORDERS ───────────────────────────────────────────────────────────

   A DELIVERY that is still open (paid, awaiting restock, preparing), whose
   booked day is today, and which was PAID ON AN EARLIER DAY. An order placed
   this morning for this afternoon is not a booking anyone could have
   forgotten, and the new-order card has just told the group about it.

   Booked means delivery_slot_kind 'schedule' (the checkout's future pick) or
   NULL (what the operator's Change delivery day writes for a later date).
   'express' is not a booking: its date is the system's earliest day, not one
   the customer chose. Pickup, counter, today, right away and restock are not
   deliveries booked for a later day.

   ── WHERE ──────────────────────────────────────────────────────────────────

   The new-order alert's own channel — the WeCom app when configured, else the
   group-bot webhook. The sender is INJECTED from routes/retail.js so there is
   one definition of that channel, not a copy here.

   ── WHEN ───────────────────────────────────────────────────────────────────

   From HOUR (08:00 shop time) for CATCH_UP_HOURS, so a box down at 08:00
   still sends at 09:10. Not configurable yet: nobody has asked for another
   hour, and a setting with no screen is one nobody can find.

   ── THE ONCE-GUARD IS THE ORDER ROW ────────────────────────────────────────

   retail_orders.booked_reminder_day holds the day the order was last reminded
   for. Each order is CLAIMED with a compare-and-set before the send, so two
   ticks or two app servers cannot both list it, and a rebuilt container does
   not send again. A failed send releases the claim so the next tick retries.
   An order moved to ANOTHER day is reminded again on that day, because the
   stored day no longer matches.
   ══════════════════════════════════════════════════════════════════════════ */

const businessDate = require('./business-date');
// A shop with no readable timezone does no work on a shop-local clock (§82).
const zoneCheck = require('./tenant-zone-check');

const HOUR = 8;
const CATCH_UP_HOURS = 3;
const OPEN_STATUSES = ['paid', 'awaiting_restock', 'preparing'];
// One line per order keeps the message under WeCom's 2048-byte markdown cap;
// past this many, the rest is a count. The orders list has every one.
const MAX_LINES = 20;

function inWindow(nowHour) {
  return nowHour >= HOUR && nowHour < Math.min(HOUR + CATCH_UP_HOURS, 24);
}

// The shop-calendar day of a stored timestamp. A bare 'YYYY-MM-DD' (a day-only
// pick, or the operator's reschedule) is already that day. '' when unreadable.
function dayIn(zone, ts) {
  if (!ts) return '';
  const s = String(ts).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(/[TZ]/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return '';
  return businessDate.zoneParts(zone, d).ymd;
}

// Open booked deliveries due `today` that have not been reminded for it.
function dueOrders(db, { zone, today }) {
  const rows = db.prepare(
    `SELECT id, order_no, paid_at, scheduled_for, delivery_slot_label, recipient_name
       FROM retail_orders
      WHERE status IN (${OPEN_STATUSES.map(() => '?').join(',')})
        AND COALESCE(fulfillment_type, 'delivery') = 'delivery'
        AND (delivery_slot_kind IS NULL OR delivery_slot_kind = 'schedule')
        AND scheduled_for IS NOT NULL AND paid_at IS NOT NULL
        AND (booked_reminder_day IS NULL OR booked_reminder_day <> ?)
      ORDER BY scheduled_for, id`
  ).all(...OPEN_STATUSES, today);
  return rows.filter((o) => {
    const paidDay = dayIn(zone, o.paid_at);
    return dayIn(zone, o.scheduled_for) === today && paidDay !== '' && paidDay < today;
  });
}

// Words: `Booked for · 顾客预约` and `今天` are live; the CN lead line is
// composed and declared in docs/tacet-delivery-vocabulary.md. The two languages
// sit on their own lines (§1.11), as the counter card's lead does.
function buildMessage(orders) {
  const lines = [
    `**📅 今天的顾客预约 (${orders.length})**`,
    `**Booked for today (${orders.length})**`,
  ];
  for (const o of orders.slice(0, MAX_LINES)) {
    const win = /\d{1,2}:\d{2}\s*[–—-]\s*\d{1,2}:\d{2}/.exec(String(o.delivery_slot_label || ''));
    lines.push(['>', `\`${o.order_no}\``, win ? win[0] : null, o.recipient_name || null]
      .filter(Boolean).join('  '));
  }
  if (orders.length > MAX_LINES) lines.push(`> +${orders.length - MAX_LINES}`);
  return lines.join('\n');
}

/* One pass for the tenant behind `db`. `send(content)` resolves to {ok,msg};
   `ready()` says whether the new-order channel is configured at all, checked
   first so an unconfigured tenant costs one call and claims nothing. */
async function runBookedReminder(db, { send, ready, now = new Date(), zone = undefined } = {}) {
  if (typeof ready === 'function' && !ready()) return { skipped: 'not_configured' };
  const tz = zone === undefined ? businessDate.shopTimezone(db) : zone;
  // §82 step 3: a shop with no readable zone gets no reminder on Guangzhou's clock.
  if (zoneCheck.zoneRefused(tz, null, 'booked.reminder')) return { skipped: 'no_timezone' };
  const parts = businessDate.zoneParts(tz, now);
  if (!inWindow(parts.hour)) return { skipped: 'not_due' };
  const today = parts.ymd;

  const claim = db.prepare(
    `UPDATE retail_orders SET booked_reminder_day = ?
      WHERE id = ? AND (booked_reminder_day IS NULL OR booked_reminder_day <> ?)`
  );
  const claimed = dueOrders(db, { zone: tz, today })
    .filter((o) => claim.run(today, o.id, today).changes === 1);
  if (!claimed.length) return { skipped: 'nothing_due' };

  const content = buildMessage(claimed);
  let r;
  try { r = await send(content); } catch (e) { r = { ok: false, msg: e.message }; }
  if (!r || !r.ok) {
    const release = db.prepare(
      'UPDATE retail_orders SET booked_reminder_day = NULL WHERE id = ? AND booked_reminder_day = ?'
    );
    for (const o of claimed) {
      try { release.run(o.id, today); } catch (e) { /* the next tick re-reads the row either way */ }
    }
  }
  return { date: today, orders: claimed.map((o) => o.order_no), ok: !!(r && r.ok), error: r && r.ok ? null : (r && r.msg) };
}

/* Every minute, per tenant, inside the tenant's scope — the arrangement of
   lib/kitchen-prep-preview.js's sweeper, and for its reason: the injected
   sender resolves the tenant's WeCom config through tdb(), which in a bare
   timer answers the MAIN handle. The handle is taken inside the scope and
   carried through the await. */
function startBookedDayReminderSweeper(ctx = {}, { intervalMs = 60_000 } = {}) {
  const { tdb, tenantAls, rawTenantDb, getTenantDb, ROOTS_TENANT_ID, DATA_ISOLATION_READY }
    = require('./tenant-db');
  const { send, ready } = ctx;
  if (typeof send !== 'function') throw new Error('startBookedDayReminderSweeper needs send');

  const sweepScope = (label) => {
    let db;
    try { db = tdb(); } catch (e) { return; /* no handle for this scope; the next tick tries again */ }
    runBookedReminder(db, { send, ready })
      .then((res) => {
        if (!res || res.skipped) return;
        if (res.ok) console.log(`[booked.reminder] ${label} ${res.date} orders=${res.orders.length}`);
        else console.warn(`[booked.reminder] ${label} ${res.date} failed`, res.error);
      })
      .catch((e) => console.error(`[booked.reminder] ${label} error`, e.message));
  };

  const activeNonRootsTenantIds = () => {
    try {
      return getTenantDb(ROOTS_TENANT_ID)
        .prepare("SELECT id FROM tenants WHERE status = 'active' AND id != ?")
        .all(ROOTS_TENANT_ID)
        .map((r) => Number(r.id))
        .filter(Boolean);
    } catch (e) {
      console.error('[booked.reminder] tenant list failed', e.message);
      return [];
    }
  };

  const tick = () => {
    sweepScope('roots');
    if (DATA_ISOLATION_READY) {
      for (const id of activeNonRootsTenantIds()) {
        try { tenantAls.run(rawTenantDb(id), () => sweepScope('tenant ' + id)); }
        catch (e) { console.error('[booked.reminder] tenant ' + id + ' failed', e.message); }
      }
    }
  };

  // Not at boot: a deploy inside the window would send the moment the process
  // came up, which hides a wrong hour behind what looks like the schedule.
  const handle = setInterval(tick, intervalMs);
  handle.unref?.();
  return handle;
}

module.exports = {
  HOUR,
  CATCH_UP_HOURS,
  MAX_LINES,
  inWindow,
  dayIn,
  dueOrders,
  buildMessage,
  runBookedReminder,
  startBookedDayReminderSweeper,
};
