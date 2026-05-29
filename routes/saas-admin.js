// SaaS-admin console API (Phase 3, #2) — the PLATFORM owner's control panel
// for managing every tenant: subscriptions, payments, suspend/reactivate,
// per-tenant branding (#3), and provisioning new tenants.
//
// Gated to a kitchen `admin` session (the interim SaaS super-admin) — this is
// cross-tenant and must never be reachable by a tenant operator.

const express = require('express');
const db = require('../database');
const { provisionTenant } = require('../lib/provision-tenant');
const onboarding = require('../lib/onboarding-steps');
const router = express.Router();

// Per-tenant accent colour for white-label branding (#3). Idempotent.
try { db.exec('ALTER TABLE tenants ADD COLUMN brand_accent TEXT'); } catch (e) { /* already added */ }
// Per-tenant WeChat mini-program AppID — maps a shopper's request to this tenant
// (see middleware/public-tenant.js). Idempotent.
try { db.exec('ALTER TABLE tenants ADD COLUMN wx_appid TEXT'); } catch (e) { /* already added */ }
// Onboarding: model (A='self' | B='managed'), business category (drives which
// qualification steps apply), and a one-time setup fee (recorded for now).
try { db.exec('ALTER TABLE tenants ADD COLUMN onboarding_model TEXT'); } catch (e) { /* already added */ }
try { db.exec('ALTER TABLE tenants ADD COLUMN business_category TEXT'); } catch (e) { /* already added */ }
try { db.exec('ALTER TABLE tenants ADD COLUMN setup_fee_cents INTEGER'); } catch (e) { /* already added */ }
// Per-tenant onboarding checklist progress (step template: lib/onboarding-steps).
db.exec(`CREATE TABLE IF NOT EXISTS tenant_onboarding (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  INTEGER NOT NULL,
  step_key   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending|provided|verified|done|na
  value      TEXT,                             -- non-secret ref / notes
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, step_key)
)`);

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
      id: t.id, name: t.name, brand: t.brand_name, accent: t.brand_accent, wxAppid: t.wx_appid, status: t.status,
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
  const invoices = db.prepare('SELECT id, invoice_no, kind, period_start, period_end, amount_cents, currency, status, due_date, paid_at, provider FROM billing_invoices WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50').all(t.id);
  const operators = db.prepare('SELECT id, username, display_name, role, is_active, last_login FROM tenant_users WHERE tenant_id = ? ORDER BY id ASC').all(t.id);
  const hasOpenSetup = db.prepare("SELECT COUNT(*) c FROM billing_invoices WHERE tenant_id = ? AND kind = 'setup' AND status = 'open'").get(t.id).c > 0;
  res.json({ success: true, tenant: { id: t.id, name: t.name, brand: t.brand_name, accent: t.brand_accent, wxAppid: t.wx_appid, status: t.status, setupFeeCents: t.setup_fee_cents || 0 }, subscription: sub, plan, invoices, operators, hasOpenSetup });
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
  const body = req.body || {};
  const { brand_name, brand_accent } = body;
  if (brand_accent && !/^#[0-9a-fA-F]{6}$/.test(brand_accent)) {
    return res.status(400).json({ error: 'Accent must be a #RRGGBB hex colour · 强调色需为 #RRGGBB' });
  }
  const sets = ["brand_name = COALESCE(NULLIF(?, ''), brand_name)", 'brand_accent = ?'];
  const params = [brand_name != null ? String(brand_name).trim() : '', brand_accent || null];
  // Only touch the AppID when the client actually sends the key (so a brand-only
  // edit can't wipe it). Validate shape + global uniqueness.
  if (Object.prototype.hasOwnProperty.call(body, 'wx_appid')) {
    const appid = body.wx_appid != null ? String(body.wx_appid).trim() : '';
    if (appid && !/^wx[0-9a-zA-Z]{16}$/.test(appid)) {
      return res.status(400).json({ error: 'AppID looks invalid (expected wx + 16 chars) · AppID 格式不正确' });
    }
    if (appid) {
      const clash = db.prepare('SELECT id FROM tenants WHERE wx_appid = ? AND id != ?').get(appid, req.params.id);
      if (clash) return res.status(409).json({ error: 'That AppID is already assigned to another tenant · 该 AppID 已分配给其他租户' });
    }
    sets.push('wx_appid = ?');
    params.push(appid || null);
  }
  params.push(req.params.id);
  db.prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`).run(...params);
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
    // One-time charges (setup fee) carry no period — paying them must NOT touch
    // the subscription dates, or we'd wipe current_period_start/end with NULLs.
    const advancesSubscription = invoice.kind !== 'setup' && invoice.period_start && invoice.period_end;
    if (sub && !sub.is_internal && advancesSubscription) {
      db.prepare("UPDATE billing_subscriptions SET status = 'active', current_period_start = ?, current_period_end = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(invoice.period_start, invoice.period_end, sub.id);
      db.prepare("UPDATE tenants SET status = 'active' WHERE id = ?").run(invoice.tenant_id);
    }
  });
  tx();
  res.json({ success: true });
});

// ── Onboarding checklist: resolved roadmap + saved progress ───────────────
router.get('/api/saas-admin/tenants/:id/onboarding', requireSaasAdmin, (req, res) => {
  const t = db.prepare('SELECT id, name, brand_name, onboarding_model, business_category, setup_fee_cents FROM tenants WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tenant not found · 未找到租户' });
  const rows = db.prepare('SELECT step_key, status, value FROM tenant_onboarding WHERE tenant_id = ?').all(t.id);
  const state = {};
  for (const r of rows) state[r.step_key] = { status: r.status, value: r.value };
  const model = t.onboarding_model === 'managed' ? 'managed' : 'self';
  const phases = onboarding.resolveChecklist(model, t.business_category, state);
  res.json({
    success: true,
    tenant: { id: t.id, name: t.name, brand: t.brand_name },
    model, category: t.business_category || '', setupFeeCents: t.setup_fee_cents || 0,
    progress: onboarding.progress(phases), phases,
  });
});

// ── Update onboarding config (model / category / one-time setup fee) ──────
router.patch('/api/saas-admin/tenants/:id/onboarding/config', requireSaasAdmin, express.json(), (req, res) => {
  const t = db.prepare('SELECT id FROM tenants WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tenant not found · 未找到租户' });
  const b = req.body || {};
  const sets = [], params = [];
  if (Object.prototype.hasOwnProperty.call(b, 'model')) {
    sets.push('onboarding_model = ?'); params.push(b.model === 'managed' ? 'managed' : 'self');
  }
  if (Object.prototype.hasOwnProperty.call(b, 'category')) {
    sets.push('business_category = ?'); params.push(b.category ? String(b.category).trim() : null);
  }
  if (Object.prototype.hasOwnProperty.call(b, 'setup_fee_cents')) {
    sets.push('setup_fee_cents = ?'); params.push(Math.max(0, Math.round(Number(b.setup_fee_cents) || 0)));
  }
  if (!sets.length) return res.json({ success: true });
  params.push(t.id);
  db.prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
});

// ── Update a single checklist step (status + recorded non-secret note) ────
router.patch('/api/saas-admin/tenants/:id/onboarding/step', requireSaasAdmin, express.json(), (req, res) => {
  const t = db.prepare('SELECT id FROM tenants WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tenant not found · 未找到租户' });
  const b = req.body || {};
  const stepKey = String(b.step_key || '').trim();
  if (!stepKey) return res.status(400).json({ error: 'step_key required' });
  const status = onboarding.STATUSES.includes(b.status) ? b.status : 'pending';
  const value = b.value != null ? String(b.value).slice(0, 2000) : null;
  db.prepare(`INSERT INTO tenant_onboarding (tenant_id, step_key, status, value, updated_at)
              VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(tenant_id, step_key)
              DO UPDATE SET status = excluded.status, value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
    .run(t.id, stepKey, status, value);
  res.json({ success: true });
});

// ── Bill the one-time onboarding setup fee (the Model-A vs B difference) ──
// Creates a single open invoice for the tenant's recorded setup_fee_cents.
// kind='setup' + no period, so marking it paid never touches the subscription.
router.post('/api/saas-admin/tenants/:id/setup-invoice', requireSaasAdmin, (req, res) => {
  const t = db.prepare('SELECT id, setup_fee_cents FROM tenants WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tenant not found · 未找到租户' });
  if (isInternal(t.id)) return res.status(400).json({ error: 'Internal tenant is not billed · 内部租户不计费' });
  const amount = Math.max(0, Math.round(Number(t.setup_fee_cents) || 0));
  if (!amount) return res.status(400).json({ error: 'Set a setup fee first (in Onboarding) · 请先在入驻中设置开通费' });
  const openSetup = db.prepare("SELECT id FROM billing_invoices WHERE tenant_id = ? AND kind = 'setup' AND status = 'open'").get(t.id);
  if (openSetup) return res.status(409).json({ error: 'An unpaid setup-fee invoice already exists · 已存在未付开通费发票' });
  const sub = db.prepare('SELECT id FROM billing_subscriptions WHERE tenant_id = ?').get(t.id);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const invoiceNo = 'SU-' + t.id + '-' + stamp + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const info = db.prepare(`INSERT INTO billing_invoices (tenant_id, subscription_id, invoice_no, kind, amount_cents, currency, status)
                           VALUES (?, ?, ?, 'setup', ?, 'CNY', 'open')`)
    .run(t.id, sub ? sub.id : null, invoiceNo, amount);
  res.json({ success: true, invoiceId: info.lastInsertRowid, invoiceNo, amountCents: amount });
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
