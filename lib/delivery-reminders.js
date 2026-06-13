// Staff-facing "ship/prepare it on time" reminders.
//
// A boot-time sweeper (same shape as the inventory + kd100 sweepers) that scans
// paid-but-unfulfilled orders and fires ONE Web Push to retail operators when an
// order is coming due. It handles two fulfillment paths in the same tick:
//
//   • PICKUP orders → push the store 20 min BEFORE the chosen pickup time so the
//     order is prepared on arrival (see sweepPickupOnce / reminder_pickup_sent_at).
//   • DELIVERY orders → as below.
//
// For DELIVERY there are two cases, decided by the order's chosen slot:
//
//   • Time-window order (e.g. 14:00–16:00): push 30 min BEFORE the window opens
//     (i.e. 13:30). The window START is encoded in scheduled_for, so we anchor
//     the reminder on it.
//   • Date-only order (schedule-for-later / re-anchored Express): push at 10:00
//     on the delivery day. Date-only picks store scheduled_for at LOCAL MIDNIGHT
//     (see resolveDeliverySlot), which is our sentinel for "customer chose a day
//     but no hour".
//
// Each order fires at most once — guarded by retail_orders.reminder_ship_sent_at
// via an atomic UPDATE … WHERE reminder_ship_sent_at IS NULL (the same r.changes
// idempotency pattern the paid-order push uses). Best-effort: never throws.
//
// Timezone: the prod host runs UTC+8 (Beijing) and is the timezone authority for
// all of retail's slot logic (resolveDeliverySlot / resolvePickupTime store
// wall-clock via the local Date ctor), so the local Date getters here read the
// same Beijing wall-clock. Same assumption, same box.

let _push = null;
try { _push = require('../routes/push'); }
catch (e) { console.warn('[ship.reminder] push module not available:', e.message); }

const DAYOF_HOUR      = 10;                  // date-only orders → remind at 10:00 local
const WINDOW_LEAD_MIN = 30;                  // time-window orders → remind T-30 min
const PICKUP_LEAD_MIN = 20;                  // pickup orders → remind store T-20 min so it's prepared on arrival
const STALE_GRACE_MS  = 6 * 60 * 60_000;     // skip reminders already >6h overdue (also caps any first-deploy backlog)
// Paid but not yet handed to the carrier — i.e. still the store's job to ship.
// 'dispatched'/'delivered'/'cancelled'/'pending_payment' are deliberately out.
const SHIPPABLE_STATUSES = "('paid','preparing','awaiting_restock')";

// When should this order's reminder fire? `when` = parsed scheduled_for read as
// local (Beijing) wall-clock. Returns { at: Date, kind } or null if unusable.
function dueAtFor(when) {
  if (!when || isNaN(when.getTime())) return null;
  const dateOnly = when.getHours() === 0 && when.getMinutes() === 0;
  if (dateOnly) {
    const at = new Date(when.getFullYear(), when.getMonth(), when.getDate(), DAYOF_HOUR, 0, 0);
    return { at, kind: 'dayof' };
  }
  return { at: new Date(when.getTime() - WINDOW_LEAD_MIN * 60_000), kind: 'window' };
}

function pushFor(o, kind) {
  if (!(_push && _push.sendPushByPermission)) return;
  const slot = o.delivery_slot_label ? ` · ${o.delivery_slot_label}` : '';
  const payload = (kind === 'window')
    ? { title: '⏰ Deliver soon · 即将配送', body: `${o.order_no}${slot}` }
    : { title: '📦 Deliver today · 今日配送', body: `${o.order_no}${slot}` };
  payload.url = '/retail-admin?tab=orders';
  payload.tag = 'retail-ship-' + o.id;
  // Fire-and-forget; the row is already claimed so a failed send won't re-fire.
  Promise.resolve(_push.sendPushByPermission('retail', payload))
    .catch(e => console.warn('[ship.reminder push]', e.message));
}

function pickupPushFor(o) {
  if (!(_push && _push.sendPushByPermission)) return;
  const slot = o.delivery_slot_label ? ` · ${o.delivery_slot_label}` : '';
  Promise.resolve(_push.sendPushByPermission('retail', {
    title: '👨‍🍳 Prepare for pickup · 即将自取',
    body:  `${o.order_no}${slot}`,
    url:   '/retail-admin?tab=orders',
    tag:   'retail-pickup-' + o.id,
  })).catch(e => console.warn('[pickup.reminder push]', e.message));
}

// Sweep paid-but-uncollected PICKUP orders once; push the store T-20 min before
// the chosen pickup time so it's prepared on arrival. Pickup times always carry a
// concrete hour (resolvePickupTime rejects times outside the window), so there's
// no date-only case — every order fires at scheduled_for − PICKUP_LEAD_MIN.
// Mirrors the delivery sweep's atomic-claim idempotency on reminder_pickup_sent_at.
function sweepPickupOnce(db, now) {
  let rows;
  try {
    rows = db.prepare(
      `SELECT id, order_no, scheduled_for, delivery_slot_label
         FROM retail_orders
        WHERE fulfillment_type = 'pickup'
          AND status IN ${SHIPPABLE_STATUSES}
          AND scheduled_for IS NOT NULL
          AND reminder_pickup_sent_at IS NULL`
    ).all();
  } catch (e) {
    if (/no such column/i.test(e.message)) {
      try { db.exec('ALTER TABLE retail_orders ADD COLUMN reminder_pickup_sent_at DATETIME'); } catch {}
      return 0;
    }
    throw e;
  }
  let fired = 0;
  for (const o of rows) {
    const when = new Date(o.scheduled_for);
    if (isNaN(when.getTime())) continue;
    const dueAt = when.getTime() - PICKUP_LEAD_MIN * 60_000;
    const overdueMs = now.getTime() - dueAt;
    if (overdueMs < 0) continue;                  // not due yet
    if (overdueMs > STALE_GRACE_MS) continue;     // too late to be useful
    const claim = db.prepare(
      'UPDATE retail_orders SET reminder_pickup_sent_at = CURRENT_TIMESTAMP WHERE id = ? AND reminder_pickup_sent_at IS NULL'
    ).run(o.id);
    if (claim.changes === 0) continue;
    pickupPushFor(o);
    fired++;
  }
  return fired;
}

// Sweep one data-plane DB once. Returns the number of reminders fired.
function sweepDbOnce(db, now) {
  let rows;
  try {
    rows = db.prepare(
      `SELECT id, order_no, scheduled_for, delivery_slot_label
         FROM retail_orders
        WHERE fulfillment_type = 'delivery'
          AND status IN ${SHIPPABLE_STATUSES}
          AND scheduled_for IS NOT NULL
          AND reminder_ship_sent_at IS NULL`
    ).all();
  } catch (e) {
    // A tenant DB provisioned before this column existed will throw "no such
    // column" — initTenantSchema only backfills whole tables, not columns. Add
    // it here so the tenant self-heals, then skip this tick.
    if (/no such column/i.test(e.message)) {
      try { db.exec('ALTER TABLE retail_orders ADD COLUMN reminder_ship_sent_at DATETIME'); } catch {}
      return 0;
    }
    throw e;
  }
  let fired = 0;
  for (const o of rows) {
    const due = dueAtFor(new Date(o.scheduled_for));
    if (!due) continue;
    const overdueMs = now.getTime() - due.at.getTime();
    if (overdueMs < 0) continue;                  // not due yet
    if (overdueMs > STALE_GRACE_MS) continue;     // too late to be useful
    // Atomic claim: only the tick that flips NULL→now actually sends, so
    // overlapping ticks (or a retry) can never double-fire.
    const claim = db.prepare(
      'UPDATE retail_orders SET reminder_ship_sent_at = CURRENT_TIMESTAMP WHERE id = ? AND reminder_ship_sent_at IS NULL'
    ).run(o.id);
    if (claim.changes === 0) continue;
    pushFor(o, due.kind);
    fired++;
  }
  // Same tick, same DB: also remind pickup orders (T-20 min). Best-effort —
  // a pickup-sweep failure must not lose the delivery count above.
  try { fired += sweepPickupOnce(db, now); }
  catch (e) { console.error('[pickup.reminder] sweep error', e.message); }
  return fired;
}

// Start the every-minute sweeper. ctx = { mainDb, getTenantDb } fans out across
// active tenants (mirrors startKd100Sweeper); a bare better-sqlite3 handle, or
// no ctx, falls back to a single-DB sweep.
function startDeliveryReminderSweeper(ctx = {}, { intervalMs = 60_000 } = {}) {
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
        catch { tenants = null; }                 // tenants table not migrated yet
        if (!tenants) {
          total += sweepDbOnce(mainDb, now);
        } else {
          for (const t of tenants) {
            try { total += sweepDbOnce(getTenantDb(t.id), now); }
            catch (e) { console.error('[ship.reminder] tenant ' + t.id + ' failed', e.message); }
          }
        }
      } else if (mainDb) {
        total += sweepDbOnce(mainDb, now);
      }
      if (total > 0) console.log(`[ship.reminder] fired=${total}`);
    } catch (e) {
      console.error('[ship.reminder] tick error', e);
    }
  };
  // First tick shortly after boot, then on interval.
  setTimeout(tick, 15_000);
  const handle = setInterval(tick, intervalMs);
  handle.unref?.();
  return handle;
}

module.exports = { startDeliveryReminderSweeper, sweepDbOnce, sweepPickupOnce, dueAtFor };
