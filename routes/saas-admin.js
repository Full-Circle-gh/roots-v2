// SaaS-admin console API (Phase 3, #2) — the PLATFORM owner's control panel
// for managing every tenant: subscriptions, payments, suspend/reactivate,
// per-tenant branding (#3), and provisioning new tenants.
//
// Gated to a kitchen `admin` session (the interim SaaS super-admin) — this is
// cross-tenant and must never be reachable by a tenant operator.

const express = require('express');
const db = require('../database');
const { provisionTenant } = require('../lib/provision-tenant');
const router = express.Router();

// Per-tenant accent colour for white-label branding (#3). Idempotent.
try { db.exec('ALTER TABLE tenants ADD COLUMN brand_accent TEXT'); } catch (e) { /* already added */ }

function requireSaasAdmin(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Admin login required · 需要管理员登录' });
  const u = db.prepare('SELECT role FROM users WHERE id = ? AND is_active = 1').get(req.session.userId);
  if (!u || u.role !== 'admin') return res.status(403).json({ error: 'Admin only · 仅限管理员' });
  next();
}

// ── List every tenant with owner + subscription + plan + counts ───────────
router.get('/api/saas-admin/tenants', requireSaasAdmin, (req, res) => {
  const tenants = db.prepare('SELECT * FROM tenants ORDER BY id ASC').all();
  const rows = tenants.map(t => {
    const sub = db.prepare('SELECT * FROM billing_subscriptions WHERE tenant_id = ?').get(t.id) || null;
    let plan = null;
    if (sub && sub.plan_id) plan = db.prepare('SELECT code, name, price_cents, currency, billing_interval FROM billing_plans WHERE id = ?').get(sub.plan_id) || null;
    const owner = db.prepare('SELECT username, display_name FROM tenant_users WHERE tenant_id = ? ORDER BY id ASC LIMIT 1').get(t.id);
    const operators = db.prepare('SELECT COUNT(*) c FROM tenant_users WHERE tenant_id = ?').get(t.id).c;
    const openInvoices = db.prepare("SELECT COUNT(*) c FROM billing_invoices WHERE tenant_id = ? AND status = 'open'").get(t.id).c;
    return {
      id: t.id, name: t.name, brand: t.brand_name, accent: t.brand_accent, status: t.status,
      owner: owner ? (owner.display_name || owner.username) : null,
      ownerUsername: owner ? owner.username : null,
      operators, openInvoices, plan,
      subStatus: sub ? sub.status : null, isInternal: sub ? !!sub.is_internal : false,
      periodEnd: sub ? sub.current_period_end : null, trialEnd: sub ? sub.trial_end : null,
    };
  });
  res.json({ success: true, tenants: rows });
});

// ── Tenant detail: subscription + invoices + operators ────────────────────
router.get('/api/saas-admin/tenants/:id', requireSaasAdmin, (req, res) => {
  const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tenant not found · 未找到租户' });
  const sub = db.prepare('SELECT * FROM billing_subscriptions WHERE tenant_id = ?').get(t.id) || null;
  let plan = null;
  if (sub && sub.plan_id) plan = db.prepare('SELECT code, name, price_cents, currency, billing_interval FROM billing_plans WHERE id = ?').get(sub.plan_id) || null;
  const invoices = db.prepare('SELECT id, invoice_no, period_start, period_end, amount_cents, currency, status, due_date, paid_at, provider FROM billing_invoices WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50').all(t.id);
  const operators = db.prepare('SELECT id, username, display_name, role, is_active, last_login FROM tenant_users WHERE tenant_id = ? ORDER BY id ASC').all(t.id);
  res.json({ success: true, tenant: { id: t.id, name: t.name, brand: t.brand_name, accent: t.brand_accent, status: t.status }, subscription: sub, plan, invoices, operators });
});

function isInternal(tenantId) {
  const sub = db.prepare('SELECT is_internal FROM billing_subscriptions WHERE tenant_id = ?').get(tenantId);
  return !!(sub && sub.is_internal);
}

// ── Suspend / reactivate. Internal tenants (Roots) can't be suspended. ────
router.post('/api/saas-admin/tenants/:id/suspend', requireSaasAdmin, (req, res) => {
  if (isInternal(req.params.id)) return res.status(400).json({ error: 'Internal tenant cannot be suspended · 内部租户不可暂停' });
  db.prepare("UPDATE tenants SET status = 'suspended' WHERE id = ?").run(req.params.id);
  db.prepare("UPDATE billing_subscriptions SET status = 'suspended', updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?").run(req.params.id);
  res.json({ success: true });
});
router.post('/api/saas-admin/tenants/:id/reactivate', requireSaasAdmin, (req, res) => {
  db.prepare("UPDATE tenants SET status = 'active' WHERE id = ?").run(req.params.id);
  db.prepare("UPDATE billing_subscriptions SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?").run(req.params.id);
  res.json({ success: true });
});

// ── Edit per-tenant branding (#3) ─────────────────────────────────────────
router.patch('/api/saas-admin/tenants/:id/brand', requireSaasAdmin, express.json(), (req, res) => {
  const t = db.prepare('SELECT id FROM tenants WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tenant not found · 未找到租户' });
  const { brand_name, brand_accent } = req.body || {};
  if (brand_accent && !/^#[0-9a-fA-F]{6}$/.test(brand_accent)) {
    return res.status(400).json({ error: 'Accent must be a #RRGGBB hex colour · 强调色需为 #RRGGBB' });
  }
  db.prepare("UPDATE tenants SET brand_name = COALESCE(NULLIF(?, ''), brand_name), brand_accent = ? WHERE id = ?")
    .run(brand_name != null ? String(brand_name).trim() : '', brand_accent || null, req.params.id);
  res.json({ success: true });
});

// ── Mark an invoice paid (records an offline/manual payment) ───────────────
router.post('/api/saas-admin/invoices/:id/mark-paid', requireSaasAdmin, (req, res) => {
  const invoice = db.prepare('SELECT * FROM billing_invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found · 未找到发票' });
  if (invoice.status === 'paid') return res.json({ success: true, alreadyPaid: true });
  const tx = db.transaction(() => {
    db.prepare("UPDATE billing_invoices SET status = 'paid', paid_at = CURRENT_TIMESTAMP, provider = COALESCE(provider, 'manual') WHERE id = ?").run(invoice.id);
    const sub = invoice.subscription_id
      ? db.prepare('SELECT * FROM billing_subscriptions WHERE id = ?').get(invoice.subscription_id)
      : db.prepare('SELECT * FROM billing_subscriptions WHERE tenant_id = ?').get(invoice.tenant_id);
    if (sub && !sub.is_internal) {
      db.prepare("UPDATE billing_subscriptions SET status = 'active', current_period_start = ?, current_period_end = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(invoice.period_start, invoice.period_end, sub.id);
      db.prepare("UPDATE tenants SET status = 'active' WHERE id = ?").run(invoice.tenant_id);
    }
  });
  tx();
  res.json({ success: true });
});

// ── Provision a new tenant from the console ───────────────────────────────
router.post('/api/saas-admin/provision', requireSaasAdmin, express.json(), (req, res) => {
  const { company, brand, username, password, owner_name } = req.body || {};
  try {
    const r = provisionTenant({ company, brand, ownerUsername: username, ownerPassword: password, ownerName: owner_name });
    res.json({ success: true, tenantId: r.tenantId, username: r.ownerUsername });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
