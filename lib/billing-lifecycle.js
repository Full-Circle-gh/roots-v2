// Mini App Backend — billing lifecycle & reminders job (SaaS Phase 1, slice 3).
//
// A daily heartbeat that keeps every tenant's subscription truthful without
// anyone touching the UI:
//   - reminders at T-14 / T-7 / T-3 / T-1 days before the period ends
//   - active period ends → raise a renewal invoice + move to past_due
//   - trial ends → past_due
//   - dunning ladder: past_due → grace (7d overdue) → suspended (14d overdue)
//   - cancelled + period elapsed → suspended
//
// It also mirrors the access decision onto tenants.status (active vs
// suspended) so the existing requireRetailAdmin gate enforces it for free.
// Internal tenants (Roots, is_internal=1) are NEVER reminded, dunned, or
// suspended — the WHERE clause excludes them and we never touch their row.

// Routed through the database seam (lib/db-seam.js). No converter is installed,
// so this is a zero-cost passthrough; the point is that this file is now on the
// covered side of the boundary. Proven by scripts/diagnose_seam_batch.js.
const { seam } = require('./db-seam');
const db = seam(require('../database'));

const DAY = 86400000;
const GRACE_AFTER_DAYS = 7;        // overdue >= 7  → grace
const SUSPEND_AFTER_DAYS = 14;     // overdue >= 14 → suspended
const REMINDER_MILESTONES = [14, 7, 3, 1];

function parseUtc(s) { return s ? new Date(String(s).replace(' ', 'T') + 'Z') : null; }
function sqlDt(d) { return d.toISOString().slice(0, 19).replace('T', ' '); }
function addInterval(from, interval) {
  const d = new Date(from.getTime());
  if (interval === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}
function genInvoiceNo(tenantId) {
  const now = new Date();
  const ym = now.getUTCFullYear() + String(now.getUTCMonth() + 1).padStart(2, '0');
  return 'INV-' + ym + '-' + tenantId + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

// Reminder ledger (billing_-prefixed). The unique index makes recording a
// reminder idempotent — the daily job can run many times, each milestone fires
// at most once per billing period.
db.exec(`
  CREATE TABLE IF NOT EXISTS billing_reminders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id       INTEGER NOT NULL,
    subscription_id INTEGER,
    period_end      DATETIME,
    milestone       INTEGER,                 -- 14 | 7 | 3 | 1
    channel         TEXT DEFAULT 'in_app',
    sent_at         DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_reminders_unique
    ON billing_reminders(subscription_id, period_end, milestone);
`);

function setSubStatus(id, status) {
  db.prepare('UPDATE billing_subscriptions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, id);
}
function setTenantStatus(tenantId, status) {
  db.prepare('UPDATE tenants SET status = ? WHERE id = ?').run(status, tenantId);
}

// One open renewal invoice per upcoming period (idempotent across runs).
function ensureRenewalInvoice(sub, plan, periodStart) {
  const exists = db.prepare(
    "SELECT id FROM billing_invoices WHERE subscription_id = ? AND period_start = ? AND status = 'open'"
  ).get(sub.id, sqlDt(periodStart));
  if (exists) return false;
  const periodEnd = addInterval(periodStart, plan ? plan.billing_interval : 'month');
  const due = new Date(periodStart.getTime() + 7 * DAY);
  db.prepare(`INSERT INTO billing_invoices (tenant_id, subscription_id, invoice_no, period_start, period_end, amount_cents, currency, status, due_date)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`)
    .run(sub.tenant_id, sub.id, genInvoiceNo(sub.tenant_id), sqlDt(periodStart), sqlDt(periodEnd),
         plan ? plan.price_cents : 0, plan ? plan.currency : 'CNY', sqlDt(due));
  return true;
}

function recordReminder(sub, milestone) {
  try {
    db.prepare('INSERT INTO billing_reminders (tenant_id, subscription_id, period_end, milestone) VALUES (?,?,?,?)')
      .run(sub.tenant_id, sub.id, sub.current_period_end, milestone);
    // In-app banner already derives from the subscription dates, so nothing
    // else is needed for in-app. External channels (email / SMS / WeCom) plug
    // in here once their integrations exist.
    console.log('[billing.lifecycle] reminder T-' + milestone + 'd → tenant #' + sub.tenant_id);
    return true;
  } catch (e) { return false; }    // unique index hit → already sent this period
}

// Pure, idempotent pass over all non-internal subscriptions. `now` is
// injectable so the manual-trigger endpoint / tests can pin a date.
function runBillingLifecycle(now = new Date()) {
  const res = { reminders: 0, invoices: 0, past_due: 0, grace: 0, suspended: 0 };
  const subs = db.prepare('SELECT * FROM billing_subscriptions WHERE COALESCE(is_internal, 0) = 0').all();

  for (const s of subs) {
    const end = parseUtc(s.current_period_end);
    const trialEnd = parseUtc(s.trial_end);
    const plan = s.plan_id ? db.prepare('SELECT * FROM billing_plans WHERE id = ?').get(s.plan_id) : null;

    // Pre-expiry reminders for healthy subscriptions.
    if ((s.status === 'active' || s.status === 'trialing') && end) {
      const daysLeft = Math.ceil((end - now) / DAY);
      if (REMINDER_MILESTONES.includes(daysLeft) && recordReminder(s, daysLeft)) res.reminders++;
    }

    // Trial elapsed → payment required.
    if (s.status === 'trialing' && trialEnd && trialEnd <= now) {
      if (ensureRenewalInvoice(s, plan, now)) res.invoices++;
      setSubStatus(s.id, 'past_due'); res.past_due++;
      continue;
    }

    // Active period elapsed → raise the renewal invoice + past_due (access
    // continues; tenants.status stays active through the grace ladder).
    if (s.status === 'active' && end && end <= now) {
      if (ensureRenewalInvoice(s, plan, end)) res.invoices++;
      setSubStatus(s.id, 'past_due'); setTenantStatus(s.tenant_id, 'active'); res.past_due++;
      continue;
    }

    // Dunning ladder, by how overdue the period end is.
    if (end && now > end) {
      const overdue = Math.floor((now - end) / DAY);
      if (s.status === 'past_due' && overdue >= GRACE_AFTER_DAYS && overdue < SUSPEND_AFTER_DAYS) {
        setSubStatus(s.id, 'grace'); res.grace++;
      } else if ((s.status === 'past_due' || s.status === 'grace') && overdue >= SUSPEND_AFTER_DAYS) {
        setSubStatus(s.id, 'suspended'); setTenantStatus(s.tenant_id, 'suspended'); res.suspended++;
      }
    }

    // Cancelled and the paid-through period has elapsed → suspend.
    if (s.status === 'cancelled' && end && end <= now) {
      setSubStatus(s.id, 'suspended'); setTenantStatus(s.tenant_id, 'suspended'); res.suspended++;
    }
  }
  return res;
}

let _started = false;
function startBillingScheduler(intervalMs = 24 * 60 * 60 * 1000) {
  if (_started) return null;
  _started = true;
  const tick = () => {
    try { console.log('[billing.lifecycle] ran:', JSON.stringify(runBillingLifecycle())); }
    catch (e) { console.error('[billing.lifecycle] tick threw', e); }
  };
  setTimeout(tick, 60_000);                  // first pass shortly after boot
  const handle = setInterval(tick, intervalMs);
  handle.unref?.();
  return handle;
}

module.exports = { runBillingLifecycle, startBillingScheduler };
