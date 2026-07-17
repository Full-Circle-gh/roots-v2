// Mini App Backend — billing payments & lifecycle (SaaS Phase 1, slice 2).
//
// Builds on routes/billing.js (the billing_* control-plane tables). Adds:
//   - GET  /api/backend/billing/providers          — checkout options
//   - POST /api/backend/billing/select-plan        — tenant picks a plan → open invoice
//   - POST /api/backend/billing/checkout           — get a checkout for an invoice
//   - POST /api/backend/billing/invoices/:id/mark-paid — SaaS-admin records payment
//
// Security model: a TENANT operator can browse plans, select one, and start a
// checkout — but can NEVER mark their own invoice paid (that would be free
// access). Marking paid is gated to the SaaS owner, which for now is your
// kitchen `admin` login (requireSaasAdmin). A provider webhook will mark paid
// automatically once a real provider is wired.

const express = require('express');
const db = require('../database');
const providers = require('../lib/billing-providers');
const { decryptWxBillingCallback, parseSubOutTradeNo } = providers;
const lifecycle = require('../lib/billing-lifecycle');
const { requireBackend } = require('../lib/require-cap');
const router = express.Router();

// Start the daily lifecycle heartbeat (idempotent — only ever starts once).
lifecycle.startBillingScheduler();

// ── Guards ─────────────────────────────────────────────────────────────
// SaaS super-admin = a kitchen `admin` session. Interim until a dedicated
// SaaS-admin console exists. Tenants (backend operators) never pass this.
function requireSaasAdmin(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'SaaS admin login required · 需要管理员登录' });
  const u = db.prepare('SELECT role FROM users WHERE id = ? AND is_active = 1').get(req.session.userId);
  if (!u || u.role !== 'admin') return res.status(403).json({ error: 'SaaS admin only · 仅限管理员' });
  next();
}

// ── Helpers ────────────────────────────────────────────────────────────
function sqlDt(d) { return d.toISOString().slice(0, 19).replace('T', ' '); }       // → 'YYYY-MM-DD HH:MM:SS' UTC
function addInterval(from, interval) {
  const d = new Date(from.getTime());
  if (interval === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);                                          // default: month
  return d;
}
function genInvoiceNo(tenantId) {
  const now = new Date();
  const ym = now.getUTCFullYear().toString() + String(now.getUTCMonth() + 1).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return 'INV-' + ym + '-' + tenantId + '-' + rand;
}
function getSub(tenantId) { return db.prepare('SELECT * FROM billing_subscriptions WHERE tenant_id = ?').get(tenantId) || null; }

// Shared: mark an invoice paid and activate the corresponding subscription.
// Called by manual mark-paid (SaaS admin) and by the WeChat Pay callback.
function activateInvoice(invoice, providerName) {
  db.transaction(() => {
    db.prepare(`UPDATE billing_invoices SET status = 'paid', paid_at = CURRENT_TIMESTAMP, provider = COALESCE(provider, ?) WHERE id = ?`)
      .run(providerName || 'manual', invoice.id);
    const sub = invoice.subscription_id
      ? db.prepare('SELECT * FROM billing_subscriptions WHERE id = ?').get(invoice.subscription_id)
      : db.prepare('SELECT * FROM billing_subscriptions WHERE tenant_id = ?').get(invoice.tenant_id);
    if (sub && !sub.is_internal) {
      db.prepare(`UPDATE billing_subscriptions SET status = 'active', current_period_start = ?, current_period_end = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(invoice.period_start, invoice.period_end, sub.id);
      db.prepare("UPDATE tenants SET status = 'active' WHERE id = ?").run(invoice.tenant_id);
    }
  })();
}

// ── GET providers ────────────────────────────────────────────────────────
router.get('/api/backend/billing/providers', requireBackend, (req, res) => {
  res.json({ success: true, providers: providers.listProviders() });
});

// ── POST select-plan — tenant chooses a plan, we raise an open invoice ────
router.post('/api/backend/billing/select-plan', requireBackend, express.json(), (req, res) => {
  const tenantId = req.session.tenantId;
  const { plan_code } = req.body || {};
  if (!plan_code) return res.status(400).json({ error: 'plan_code required · 缺少套餐代码' });

  const sub = getSub(tenantId);
  if (sub && sub.is_internal) {
    return res.status(400).json({ error: 'Your account is on an internal plan, managed directly by Full Circle. · 您的账户为内部套餐,由 Full Circle 直接管理。' });
  }
  const plan = db.prepare('SELECT * FROM billing_plans WHERE code = ? AND is_active = 1 AND is_public = 1').get(plan_code);
  if (!plan) return res.status(404).json({ error: 'Unknown plan · 未知套餐' });

  const now = new Date();
  const periodEnd = addInterval(now, plan.billing_interval);
  const dueDate = new Date(now.getTime() + 7 * 86400000);                          // net-7
  const invoiceNo = genInvoiceNo(tenantId);

  const tx = db.transaction(() => {
    // Ensure a subscription row exists for this tenant.
    let subId = sub ? sub.id : null;
    if (!sub) {
      const r = db.prepare(`INSERT INTO billing_subscriptions (tenant_id, plan_id, status) VALUES (?, ?, 'past_due')`).run(tenantId, plan.id);
      subId = r.lastInsertRowid;
    } else {
      db.prepare(`UPDATE billing_subscriptions SET plan_id = ?, status = 'past_due', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(plan.id, sub.id);
    }
    const inv = db.prepare(`INSERT INTO billing_invoices (tenant_id, subscription_id, invoice_no, period_start, period_end, amount_cents, currency, status, due_date)
                            VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`)
      .run(tenantId, subId, invoiceNo, sqlDt(now), sqlDt(periodEnd), plan.price_cents, plan.currency, sqlDt(dueDate));
    return inv.lastInsertRowid;
  });
  const invoiceId = tx();
  const invoice = db.prepare('SELECT * FROM billing_invoices WHERE id = ?').get(invoiceId);
  res.json({ success: true, invoice, providers: providers.listProviders() });
});

// ── POST checkout — get a payment descriptor for an open invoice ──────────
router.post('/api/backend/billing/checkout', requireBackend, express.json(), async (req, res) => {
  const tenantId = req.session.tenantId;
  const { invoice_id, provider } = req.body || {};
  if (!invoice_id || !provider) return res.status(400).json({ error: 'invoice_id and provider required · 缺少发票或支付方式' });

  const invoice = db.prepare('SELECT * FROM billing_invoices WHERE id = ? AND tenant_id = ?').get(invoice_id, tenantId);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found · 未找到发票' });
  if (invoice.status === 'paid') return res.status(400).json({ error: 'Invoice already paid · 发票已支付' });

  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
  try {
    const checkout = await providers.createCheckout(provider, invoice, tenant);
    if (checkout.out_trade_no) {
      db.prepare('UPDATE billing_invoices SET provider = ?, provider_ref = ? WHERE id = ?').run(provider, checkout.out_trade_no, invoice.id);
    } else {
      db.prepare('UPDATE billing_invoices SET provider = ? WHERE id = ?').run(provider, invoice.id);
    }
    res.json({ success: true, checkout });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST mark-paid — SaaS admin records a (manual) payment ────────────────
router.post('/api/backend/billing/invoices/:id/mark-paid', requireSaasAdmin, express.json(), (req, res) => {
  const invoice = db.prepare('SELECT * FROM billing_invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found · 未找到发票' });
  if (invoice.status === 'paid') return res.json({ success: true, alreadyPaid: true });
  activateInvoice(invoice, 'manual');
  res.json({ success: true });
});

// ── GET payment-status — polled from the checkout QR screen ─────────────────
router.get('/api/backend/billing/invoices/:id/payment-status', requireBackend, (req, res) => {
  const tenantId = req.session.tenantId;
  const row = db.prepare('SELECT status, paid_at FROM billing_invoices WHERE id = ? AND tenant_id = ?')
                .get(req.params.id, tenantId);
  if (!row) return res.status(404).json({ error: 'Invoice not found · 未找到发票' });
  res.json({ success: true, status: row.status, paid_at: row.paid_at });
});

// ── POST WeChat Pay callback (no auth — WeChat's servers call this) ───────────
// The AES-256-GCM auth tag is the primary security gate: any tampered payload
// causes .final() to throw, so we never process unauthenticated data.
// WeChat retries for up to 15 min unless we return { code:'SUCCESS' }.
router.post('/api/backend/billing/payment/wechat/callback', express.json(), (req, res) => {
  try {
    const { resource } = req.body || {};
    if (!resource) return res.status(400).json({ code: 'FAIL', message: 'Missing resource' });
    let payload;
    try {
      payload = decryptWxBillingCallback(resource);
    } catch (e) {
      console.error('[billing/wechat/cb] decrypt failed', e.message);
      return res.status(400).json({ code: 'FAIL', message: 'Decryption failed' });
    }
    // Non-success states (NOTPAY, USERPAYING, CLOSED…) — ack and ignore.
    if (payload.trade_state !== 'SUCCESS') return res.json({ code: 'SUCCESS', message: 'OK' });
    const invoiceId = parseSubOutTradeNo(payload.out_trade_no);
    if (!invoiceId) return res.status(400).json({ code: 'FAIL', message: 'Unrecognised out_trade_no' });
    const invoice = db.prepare('SELECT * FROM billing_invoices WHERE id = ?').get(invoiceId);
    if (!invoice) return res.status(404).json({ code: 'FAIL', message: 'Invoice not found' });
    if (invoice.status !== 'paid') activateInvoice(invoice, 'wechat_native');
    res.json({ code: 'SUCCESS', message: 'OK' });
  } catch (e) {
    console.error('[billing/wechat/cb]', e);
    res.status(500).json({ code: 'FAIL', message: 'Internal error' });
  }
});

// ── POST run-lifecycle — manual trigger for the daily pass (testing) ──────
// SaaS-admin only. Lets you exercise reminders / dunning / suspension without
// waiting for the 24h timer. `now` is server-time; seed test dates to verify.
router.post('/api/backend/billing/run-lifecycle', requireSaasAdmin, (req, res) => {
  try {
    res.json({ success: true, result: lifecycle.runBillingLifecycle() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
