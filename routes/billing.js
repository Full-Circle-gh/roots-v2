// Mini App Backend — billing control plane (SaaS Phase 1).
//
//   billing_plans          — the subscription catalogue (Starter / Growth /
//                            Pro + a hidden Internal plan for exempt tenants)
//   billing_subscriptions  — one per tenant; status drives access (later)
//   billing_invoices       — billing history per tenant
//
// Tables are deliberately `billing_`-prefixed: the bare names `plans` /
// `subscriptions` / `invoices` collide with existing app tables (e.g.
// database.js already owns `invoices`), and CREATE TABLE IF NOT EXISTS would
// silently keep the wrong schema. Keep this prefix for every SaaS-billing
// object so the control plane never clashes with tenant/business tables.
//
// This slice is read-mostly: stand up the schema, seed the catalogue, and
// guarantee tenant #1 (Roots) holds a PERPETUAL internal subscription so it
// can never be billed-out of its own backend. Payment-provider checkout, the
// automated lifecycle job, and hard access-gating land in later slices.
// Amounts are stored in minor units (cents/分). Currency defaults to CNY.

const express = require('express');
const db = require('../database');
const { requireBackend } = require('../lib/require-cap');
const router = express.Router();

// ── Schema (idempotent) ─────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS billing_plans (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    code             TEXT UNIQUE NOT NULL,           -- internal | starter | growth | pro
    name             TEXT NOT NULL,
    name_cn          TEXT,
    price_cents      INTEGER NOT NULL DEFAULT 0,
    currency         TEXT NOT NULL DEFAULT 'CNY',
    billing_interval TEXT NOT NULL DEFAULT 'month',  -- month | year
    features_json    TEXT,                           -- JSON array of {en,cn}
    is_public        INTEGER DEFAULT 1,              -- 0 = hidden from the catalogue
    sort_order       INTEGER DEFAULT 0,
    is_active        INTEGER DEFAULT 1,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS billing_subscriptions (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id            INTEGER NOT NULL,
    plan_id              INTEGER,
    status               TEXT NOT NULL DEFAULT 'trialing', -- trialing|active|past_due|grace|suspended|cancelled
    current_period_start DATETIME,
    current_period_end   DATETIME,
    trial_end            DATETIME,
    cancel_at            DATETIME,
    is_internal          INTEGER DEFAULT 0,                -- exempt tenants: never auto-suspended
    created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (plan_id)   REFERENCES billing_plans(id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_subscriptions_tenant ON billing_subscriptions(tenant_id);
  CREATE TABLE IF NOT EXISTS billing_invoices (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id       INTEGER NOT NULL,
    subscription_id INTEGER,
    invoice_no      TEXT,
    period_start    DATETIME,
    period_end      DATETIME,
    amount_cents    INTEGER NOT NULL DEFAULT 0,
    currency        TEXT NOT NULL DEFAULT 'CNY',
    status          TEXT NOT NULL DEFAULT 'open',          -- open | paid | void | past_due
    due_date        DATETIME,
    paid_at         DATETIME,
    provider        TEXT,                                  -- wechat | alipay | stripe | manual
    provider_ref    TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  );
  CREATE INDEX IF NOT EXISTS idx_billing_invoices_tenant ON billing_invoices(tenant_id, created_at);
`);
// One-time charges (e.g. Model-B onboarding setup fee) vs recurring subscription
// invoices. NULL/'subscription' = the normal periodic invoice; 'setup' = a
// one-off charge with no billing period (must not advance the subscription).
try { db.exec('ALTER TABLE billing_invoices ADD COLUMN kind TEXT'); } catch (e) { /* already added */ }

// ── Seed the plan catalogue (prices are placeholders — edit freely) ──────
function seedPlans() {
  if (db.prepare('SELECT COUNT(*) c FROM billing_plans').get().c > 0) return;
  const rows = [
    { code: 'internal', name: 'Internal', name_cn: '内部', price: 0,     pub: 0, sort: 0,
      features: [{ en: 'All features included', cn: '包含全部功能' }] },
    { code: 'starter',  name: 'Starter',  name_cn: '入门', price: 9900,  pub: 1, sort: 1,
      features: [{ en: 'Up to 100 products', cn: '最多 100 个产品' }, { en: '1 operator', cn: '1 个操作员' }, { en: 'Core backend', cn: '核心后台' }] },
    { code: 'growth',   name: 'Growth',   name_cn: '成长', price: 29900, pub: 1, sort: 2,
      features: [{ en: 'Up to 1,000 products', cn: '最多 1,000 个产品' }, { en: '3 operators', cn: '3 个操作员' }, { en: 'Marketing tools', cn: '营销工具' }] },
    { code: 'pro',      name: 'Pro',      name_cn: '专业', price: 79900, pub: 1, sort: 3,
      features: [{ en: 'Unlimited products', cn: '无限产品' }, { en: '10 operators', cn: '10 个操作员' }, { en: 'Full analytics + priority support', cn: '完整分析 + 优先支持' }] },
  ];
  const ins = db.prepare('INSERT INTO billing_plans (code,name,name_cn,price_cents,currency,billing_interval,features_json,is_public,sort_order) VALUES (?,?,?,?,?,?,?,?,?)');
  rows.forEach(p => ins.run(p.code, p.name, p.name_cn, p.price, 'CNY', 'month', JSON.stringify(p.features), p.pub, p.sort));
  console.log('[billing] seeded ' + rows.length + ' plans');
}

// ── Guarantee tenant #1 (Roots) is on a perpetual internal subscription ──
function seedRootsSubscription() {
  try {
    const roots = db.prepare('SELECT id FROM tenants ORDER BY id ASC LIMIT 1').get();
    if (!roots) return;
    if (db.prepare('SELECT id FROM billing_subscriptions WHERE tenant_id = ?').get(roots.id)) return;
    const internal = db.prepare("SELECT id FROM billing_plans WHERE code = 'internal'").get();
    db.prepare(`INSERT INTO billing_subscriptions (tenant_id, plan_id, status, current_period_start, current_period_end, is_internal)
                VALUES (?, ?, 'active', CURRENT_TIMESTAMP, '2099-12-31 00:00:00', 1)`).run(roots.id, internal ? internal.id : null);
    console.log('[billing] seeded perpetual internal subscription for tenant #' + roots.id + ' (Roots)');
  } catch (e) { console.warn('[billing] roots-sub seed skipped:', e.message); }
}
seedPlans();
seedRootsSubscription();

// ── Helpers ──────────────────────────────────────────────────────────────
function parseSqliteUtc(s) {
  if (!s) return null;
  // SQLite CURRENT_TIMESTAMP is 'YYYY-MM-DD HH:MM:SS' in UTC.
  return new Date(String(s).replace(' ', 'T') + 'Z');
}

// Derive the at-a-glance billing state for a tenant (days left + alert band).
function billingView(tenantId) {
  const sub = db.prepare('SELECT * FROM billing_subscriptions WHERE tenant_id = ?').get(tenantId) || null;
  let plan = null;
  if (sub && sub.plan_id) plan = db.prepare('SELECT * FROM billing_plans WHERE id = ?').get(sub.plan_id) || null;
  if (plan) { try { plan.features = JSON.parse(plan.features_json || '[]'); } catch { plan.features = []; } delete plan.features_json; }

  const invoices = db.prepare(
    'SELECT id, invoice_no, period_start, period_end, amount_cents, currency, status, due_date, paid_at, provider, created_at FROM billing_invoices WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 24'
  ).all(tenantId);

  let daysLeft = null, alert = 'none';
  if (sub && sub.current_period_end) {
    const end = parseSqliteUtc(sub.current_period_end);
    if (end) daysLeft = Math.ceil((end.getTime() - Date.now()) / 86400000);
  }
  if (sub) {
    if (sub.is_internal)                              alert = 'none';
    else if (sub.status === 'suspended')             alert = 'suspended';
    else if (sub.status === 'past_due' || sub.status === 'grace') alert = 'past_due';
    else if (sub.status === 'cancelled')             alert = 'cancelled';
    else if (sub.status === 'trialing')              alert = (daysLeft != null && daysLeft <= 7) ? 'trial_ending' : 'trial';
    else if (sub.status === 'active' && daysLeft != null && daysLeft <= 14) alert = 'expiring';
  }
  return { subscription: sub, plan, invoices, daysLeft, alert };
}

// ── Read APIs ──────────────────────────────────────────────────────────────
router.get('/api/backend/billing', requireBackend, (req, res) => {
  res.json({ success: true, ...billingView(req.session.tenantId) });
});

router.get('/api/backend/plans', requireBackend, (req, res) => {
  const plans = db.prepare(
    'SELECT id, code, name, name_cn, price_cents, currency, billing_interval, features_json, sort_order FROM billing_plans WHERE is_active = 1 AND is_public = 1 ORDER BY sort_order ASC'
  ).all();
  plans.forEach(p => { try { p.features = JSON.parse(p.features_json || '[]'); } catch { p.features = []; } delete p.features_json; });
  res.json({ success: true, plans });
});

module.exports = router;
