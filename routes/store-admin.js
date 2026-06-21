// store-admin console API — the PLATFORM account-manager backend.
//
// Serves store-admin.rootskitchenchina.com: the team that runs the SaaS signs
// in here (platform_admins realm — see lib/platform-admin.js) and manages every
// merchant account. This file owns the things UNIQUE to the platform console:
//   • platform-staff auth (login / me / logout / password)
//   • platform-staff management (super-admin only)
//   • the cross-tenant dashboard summary
//   • the audit-log feed
// Tenant lifecycle, billing and signup-lead actions REUSE the existing
// /api/saas-admin/* and /api/backend/signup/* endpoints (now also accepted for
// a platform session) — the console just calls those. No logic is duplicated.

const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const db = require('../database');
const crypto = require('crypto');
const {
  ROLES, capsFor, requirePlatformAdmin, currentActor, logAudit,
} = require('../lib/platform-admin');
const { registerTenantDomain } = require('../lib/provision-tenant');
const { normalizeHost } = require('../middleware/public-tenant');
const { getTenantDb } = require('../lib/tenant-db');
const router = express.Router();

// The merchant backend host — where an impersonation hand-off lands so the
// session cookie is set on the right origin (cookies are host-scoped). Override
// via env if the backend ever moves off store.rootskitchenchina.com.
const STORE_BACKEND_HOST = process.env.STORE_BACKEND_HOST || 'store.rootskitchenchina.com';
const STORE_ADMIN_HOST = process.env.STORE_ADMIN_HOST || 'store-admin.rootskitchenchina.com';
// Hosts reserved for the platform itself — never registrable as a tenant domain.
const RESERVED_HOSTS = new Set([STORE_BACKEND_HOST, STORE_ADMIN_HOST]);

// ── Phase 2 schema (idempotent) ───────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS platform_broadcasts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title_en   TEXT, title_cn TEXT,
    body_en    TEXT, body_cn  TEXT,
    level      TEXT NOT NULL DEFAULT 'info',   -- info | warn | critical
    audience   TEXT NOT NULL DEFAULT 'all',    -- all | tenant
    tenant_id  INTEGER,                        -- set when audience='tenant'
    active     INTEGER NOT NULL DEFAULT 1,
    starts_at  DATETIME, ends_at DATETIME,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  -- One-time, short-lived hand-off tokens for "log in as store". Minted on the
  -- store-admin host, consumed on the merchant-backend host (server.js
  -- GET /impersonate) which then starts the impersonated tenant_users session.
  CREATE TABLE IF NOT EXISTS platform_impersonation_tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    token       TEXT NOT NULL UNIQUE,
    tenant_id   INTEGER NOT NULL,
    operator_id INTEGER NOT NULL,
    by_kind     TEXT, by_id INTEGER, by_name TEXT,
    expires_at  DATETIME NOT NULL,
    used_at     DATETIME,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  -- Support tickets raised by merchants from their backend, triaged by platform
  -- staff in the store-admin Support inbox. Thread of messages per ticket.
  CREATE TABLE IF NOT EXISTS platform_tickets (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id     INTEGER NOT NULL,
    operator_id   INTEGER,
    operator_name TEXT,
    subject       TEXT,
    status        TEXT NOT NULL DEFAULT 'open',   -- open | pending | resolved
    last_sender   TEXT,                           -- merchant | platform
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_platform_tickets_status ON platform_tickets(status, updated_at);
  CREATE TABLE IF NOT EXISTS platform_ticket_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id   INTEGER NOT NULL,
    sender_kind TEXT NOT NULL,                    -- merchant | platform
    sender_name TEXT,
    body        TEXT NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_platform_ticket_messages ON platform_ticket_messages(ticket_id, id);
`);

// ── Brute-force guard, same posture as the kitchen / backend logins ───────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many attempts, try again in 15 minutes · 尝试过于频繁,请 15 分钟后再试' },
});

function actorPayload(actor) {
  return {
    id: actor.id, kind: actor.kind, username: actor.username,
    displayName: actor.name, role: actor.role, caps: capsFor(actor.role),
  };
}

// ── Auth ──────────────────────────────────────────────────────────────────
router.post('/api/store-admin/login', loginLimiter, express.json(), (req, res) => {
  const { username, password, remember } = req.body || {};
  if (!username || !password) return res.json({ success: false, error: 'Enter username and password · 请输入用户名和密码' });
  const a = db.prepare('SELECT * FROM platform_admins WHERE username = ? AND is_active = 1').get(String(username).trim().toLowerCase());
  if (!a || !bcrypt.compareSync(password, a.password)) {
    return res.json({ success: false, error: 'Incorrect username or password · 用户名或密码错误' });
  }
  db.prepare('UPDATE platform_admins SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(a.id);
  req.session.platformAdminId = a.id;
  req.session.cookie.maxAge = remember ? 30 * 24 * 60 * 60 * 1000 : 8 * 60 * 60 * 1000;
  const actor = { kind: 'platform', id: a.id, username: a.username, name: a.display_name || a.username, role: a.role };
  req.platformActor = actor;
  logAudit(req, { action: 'auth.login', targetType: 'staff', targetId: a.id });
  res.json({ success: true, user: actorPayload(actor) });
});

router.post('/api/store-admin/logout', (req, res) => {
  if (req.session) delete req.session.platformAdminId;
  res.json({ success: true });
});

router.get('/api/store-admin/me', (req, res) => {
  const actor = currentActor(req);
  if (!actor) return res.json({ user: null });
  res.json({ user: actorPayload(actor) });
});

// Change own password (platform staff only — a kitchen admin manages their
// password in the kitchen app, not here). Min 10 chars, must differ.
router.put('/api/store-admin/password', express.json(), (req, res) => {
  if (!req.session?.platformAdminId) return res.status(401).json({ error: 'Not a platform account · 非平台账户' });
  const { current_password, new_password } = req.body || {};
  if (!new_password || new_password.length < 10) return res.status(400).json({ error: 'New password must be at least 10 characters · 新密码至少需要 10 位' });
  const a = db.prepare('SELECT password FROM platform_admins WHERE id = ?').get(req.session.platformAdminId);
  if (!a) return res.status(404).json({ error: 'Account not found · 未找到账户' });
  if (!current_password || !bcrypt.compareSync(current_password, a.password)) {
    return res.status(400).json({ error: 'Current password is incorrect · 当前密码不正确' });
  }
  if (bcrypt.compareSync(new_password, a.password)) {
    return res.status(400).json({ error: 'New password must differ from the current one · 新密码不能与当前密码相同' });
  }
  db.prepare('UPDATE platform_admins SET password = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), req.session.platformAdminId);
  logAudit(req, { action: 'auth.password_change', targetType: 'staff', targetId: req.session.platformAdminId });
  res.json({ success: true });
});

// ── Platform-staff management (super-admin only) ──────────────────────────
const USERNAME_RE = /^[a-z0-9._-]+$/;

router.get('/api/store-admin/staff', requirePlatformAdmin('staff.manage'), (req, res) => {
  const rows = db.prepare('SELECT id, username, display_name, role, is_active, last_login, created_at FROM platform_admins ORDER BY id ASC').all();
  res.json({
    success: true,
    staff: rows.map(r => ({
      id: r.id, username: r.username, displayName: r.display_name, role: r.role,
      isActive: !!r.is_active, lastLogin: r.last_login, createdAt: r.created_at,
    })),
    roles: ROLES,
  });
});

router.post('/api/store-admin/staff', requirePlatformAdmin('staff.manage'), express.json(), (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim().toLowerCase();
  const password = String(b.password || '');
  const displayName = String(b.display_name || '').trim();
  const role = ROLES.includes(b.role) ? b.role : 'support';
  if (!username || !USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username may use letters, numbers, . _ - only · 用户名仅限字母、数字和 . _ -' });
  if (password.length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters · 密码至少需要 10 位' });
  if (db.prepare('SELECT id FROM platform_admins WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'That username is already taken · 该用户名已被占用' });
  }
  const info = db.prepare('INSERT INTO platform_admins (username, password, display_name, role) VALUES (?,?,?,?)')
    .run(username, bcrypt.hashSync(password, 10), displayName || username, role);
  logAudit(req, { action: 'staff.create', targetType: 'staff', targetId: info.lastInsertRowid, meta: { username, role } });
  res.json({ success: true, id: info.lastInsertRowid });
});

router.patch('/api/store-admin/staff/:id', requirePlatformAdmin('staff.manage'), express.json(), (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM platform_admins WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'Account not found · 未找到账户' });
  const b = req.body || {};
  const sets = [], params = [], changed = {};

  if (Object.prototype.hasOwnProperty.call(b, 'display_name')) {
    sets.push('display_name = ?'); params.push(String(b.display_name || '').trim() || target.username); changed.display_name = true;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'role')) {
    const role = ROLES.includes(b.role) ? b.role : target.role;
    // Don't let the last active super-admin be demoted out of existence.
    if (target.role === 'super' && role !== 'super' && lastSuperGuard(id)) {
      return res.status(400).json({ error: 'At least one active super-admin is required · 必须保留至少一名超级管理员' });
    }
    sets.push('role = ?'); params.push(role); changed.role = role;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'is_active')) {
    const active = b.is_active ? 1 : 0;
    if (!active && req.platformActor.kind === 'platform' && req.platformActor.id === id) {
      return res.status(400).json({ error: 'You cannot deactivate your own account · 不能停用自己的账户' });
    }
    if (!active && target.role === 'super' && lastSuperGuard(id)) {
      return res.status(400).json({ error: 'At least one active super-admin is required · 必须保留至少一名超级管理员' });
    }
    sets.push('is_active = ?'); params.push(active); changed.is_active = !!active;
  }
  if (b.new_password != null && String(b.new_password).length) {
    if (String(b.new_password).length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters · 密码至少需要 10 位' });
    sets.push('password = ?'); params.push(bcrypt.hashSync(String(b.new_password), 10)); changed.password = true;
  }
  if (!sets.length) return res.json({ success: true });
  params.push(id);
  db.prepare(`UPDATE platform_admins SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  logAudit(req, { action: 'staff.update', targetType: 'staff', targetId: id, meta: changed });
  res.json({ success: true });
});

// True when `id` is the only remaining active super-admin (so we must block a
// demotion / deactivation that would lock everyone out of staff management).
function lastSuperGuard(id) {
  const others = db.prepare("SELECT COUNT(*) c FROM platform_admins WHERE role = 'super' AND is_active = 1 AND id != ?").get(id).c;
  return others === 0;
}

// ── Cross-tenant dashboard summary ────────────────────────────────────────
// A single roll-up the home screen reads: tenant counts by status, billing
// health (trialing / past-due / suspended), open invoices + their value, and
// new signup leads waiting. Cheap aggregate queries over the control plane.
router.get('/api/store-admin/summary', requirePlatformAdmin('view'), (req, res) => {
  const tByStatus = {};
  db.prepare('SELECT status, COUNT(*) c FROM tenants GROUP BY status').all().forEach(r => { tByStatus[r.status] = r.c; });
  const totalTenants = db.prepare('SELECT COUNT(*) c FROM tenants').get().c;

  const subByStatus = {};
  db.prepare('SELECT status, COUNT(*) c FROM billing_subscriptions GROUP BY status').all().forEach(r => { subByStatus[r.status] = r.c; });

  const openInv = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(amount_cents),0) v FROM billing_invoices WHERE status = 'open'").get();
  const pastDueInv = db.prepare("SELECT COUNT(*) c FROM billing_invoices WHERE status = 'past_due'").get().c;

  const leadsNew = db.prepare("SELECT COUNT(*) c FROM tenant_signup_requests WHERE status = 'new'").get().c;
  const leadsTotal = db.prepare('SELECT COUNT(*) c FROM tenant_signup_requests').get().c;

  // Approx MRR: sum the monthly price of every active, non-internal plan.
  const mrr = db.prepare(`
    SELECT COALESCE(SUM(p.price_cents),0) v
    FROM billing_subscriptions s JOIN billing_plans p ON p.id = s.plan_id
    WHERE s.status = 'active' AND s.is_internal = 0 AND p.billing_interval = 'month'
  `).get().v;

  const recentTenants = db.prepare(`
    SELECT t.id, t.name, t.brand_name AS brand, t.status, t.created_at,
           s.status AS subStatus, s.trial_end AS trialEnd
    FROM tenants t LEFT JOIN billing_subscriptions s ON s.tenant_id = t.id
    ORDER BY t.id DESC LIMIT 8
  `).all();

  res.json({
    success: true,
    tenants: { total: totalTenants, byStatus: tByStatus },
    subscriptions: { byStatus: subByStatus },
    billing: { openInvoices: openInv.c, openValueCents: openInv.v, pastDueInvoices: pastDueInv, mrrCents: mrr },
    leads: { new: leadsNew, total: leadsTotal },
    recentTenants,
  });
});

// ── Cross-tenant billing views ────────────────────────────────────────────
// One list the Billing tab reads: every unsettled invoice across ALL tenants
// (so the billing role works a single queue instead of opening each store).
router.get('/api/store-admin/invoices', requirePlatformAdmin('view'), (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  let sql = `SELECT iv.*, t.name AS tenant_name, t.brand_name AS tenant_brand
             FROM billing_invoices iv JOIN tenants t ON t.id = iv.tenant_id`;
  const params = [];
  if (status) { sql += ' WHERE iv.status = ?'; params.push(status); }
  else { sql += " WHERE iv.status IN ('open','past_due')"; }
  sql += ' ORDER BY iv.created_at DESC LIMIT 200';
  const rows = db.prepare(sql).all(...params).map(iv => ({
    id: iv.id, tenantId: iv.tenant_id, tenant: iv.tenant_brand || iv.tenant_name,
    invoiceNo: iv.invoice_no, kind: iv.kind || 'subscription',
    periodStart: iv.period_start, periodEnd: iv.period_end,
    amountCents: iv.amount_cents, currency: iv.currency, status: iv.status,
    dueDate: iv.due_date, paidAt: iv.paid_at, provider: iv.provider,
  }));
  res.json({ success: true, invoices: rows });
});

// Plan catalogue — read for any viewer, edit (price / visibility) for billing.
router.get('/api/store-admin/plans', requirePlatformAdmin('view'), (req, res) => {
  const rows = db.prepare('SELECT * FROM billing_plans ORDER BY sort_order ASC, id ASC').all().map(p => ({
    id: p.id, code: p.code, name: p.name, nameCn: p.name_cn, priceCents: p.price_cents,
    currency: p.currency, interval: p.billing_interval, isPublic: !!p.is_public, isActive: !!p.is_active,
    features: safeParse(p.features_json) || [],
  }));
  res.json({ success: true, plans: rows });
});

router.patch('/api/store-admin/plans/:id', requirePlatformAdmin('billing.write'), express.json(), (req, res) => {
  const p = db.prepare('SELECT * FROM billing_plans WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Plan not found · 未找到套餐' });
  const b = req.body || {}; const sets = [], params = [], changed = {};
  if (Object.prototype.hasOwnProperty.call(b, 'name')) { sets.push('name = ?'); params.push(String(b.name || '').trim() || p.name); changed.name = true; }
  if (Object.prototype.hasOwnProperty.call(b, 'name_cn')) { sets.push('name_cn = ?'); params.push(String(b.name_cn || '').trim() || null); changed.name_cn = true; }
  if (Object.prototype.hasOwnProperty.call(b, 'price_cents')) { sets.push('price_cents = ?'); params.push(Math.max(0, Math.round(Number(b.price_cents) || 0))); changed.price_cents = true; }
  if (Object.prototype.hasOwnProperty.call(b, 'is_public')) { sets.push('is_public = ?'); params.push(b.is_public ? 1 : 0); changed.is_public = !!b.is_public; }
  if (Object.prototype.hasOwnProperty.call(b, 'is_active')) { sets.push('is_active = ?'); params.push(b.is_active ? 1 : 0); changed.is_active = !!b.is_active; }
  if (!sets.length) return res.json({ success: true });
  params.push(p.id);
  db.prepare(`UPDATE billing_plans SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  logAudit(req, { action: 'plan.update', targetType: 'plan', targetId: p.id, meta: changed });
  res.json({ success: true });
});

// ── Audit log feed (view) ─────────────────────────────────────────────────
router.get('/api/store-admin/audit', requirePlatformAdmin('view'), (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const targetType = req.query.targetType ? String(req.query.targetType) : null;
  const targetId = req.query.targetId ? String(req.query.targetId) : null;
  let sql = 'SELECT * FROM platform_audit_log';
  const where = [], params = [];
  if (targetType) { where.push('target_type = ?'); params.push(targetType); }
  if (targetId) { where.push('target_id = ?'); params.push(targetId); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(limit);
  const rows = db.prepare(sql).all(...params).map(r => ({
    id: r.id, actorKind: r.actor_kind, actorName: r.actor_name, action: r.action,
    targetType: r.target_type, targetId: r.target_id,
    meta: r.meta_json ? safeParse(r.meta_json) : null, ip: r.ip, at: r.created_at,
  }));
  res.json({ success: true, audit: rows });
});

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

// ════════════════ DOMAINS (tenant_domains) ════════════════
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](-?[a-z0-9])*\.)+[a-z]{2,}$/;

router.get('/api/store-admin/tenants/:id/domains', requirePlatformAdmin('view'), (req, res) => {
  const t = db.prepare('SELECT id FROM tenants WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Store not found · 未找到店铺' });
  const rows = db.prepare('SELECT id, host, kind, status, is_primary, created_at FROM tenant_domains WHERE tenant_id = ? ORDER BY is_primary DESC, id ASC').all(t.id)
    .map(d => ({ id: d.id, host: d.host, kind: d.kind, status: d.status, isPrimary: !!d.is_primary, createdAt: d.created_at }));
  res.json({ success: true, domains: rows, backendHost: STORE_BACKEND_HOST });
});

router.post('/api/store-admin/tenants/:id/domains', requirePlatformAdmin('tenant.manage'), express.json(), (req, res) => {
  const t = db.prepare('SELECT id FROM tenants WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Store not found · 未找到店铺' });
  const host = normalizeHost(req.body && req.body.host);
  if (!host || !DOMAIN_RE.test(host)) return res.status(400).json({ error: 'Enter a valid domain (e.g. shop.example.com) · 请输入有效域名' });
  if (RESERVED_HOSTS.has(host)) return res.status(400).json({ error: 'That host is reserved by the platform · 该域名为平台保留' });
  if (db.prepare('SELECT tenant_id FROM tenant_domains WHERE host = ?').get(host)) {
    return res.status(409).json({ error: 'That domain is already registered · 该域名已登记' });
  }
  const kind = req.body.kind === 'subdomain' ? 'subdomain' : 'custom';
  // Custom (BYO) domains start 'pending' until DNS/ICP/TLS are verified; a free
  // platform subdomain can serve immediately.
  const status = ['active', 'pending', 'disabled'].includes(req.body.status) ? req.body.status : (kind === 'custom' ? 'pending' : 'active');
  registerTenantDomain(t.id, host, { kind, status, primary: false });
  const row = db.prepare('SELECT id FROM tenant_domains WHERE host = ?').get(host);
  logAudit(req, { action: 'domain.add', targetType: 'tenant', targetId: t.id, meta: { host, kind, status } });
  res.json({ success: true, id: row && row.id });
});

router.patch('/api/store-admin/domains/:domainId', requirePlatformAdmin('tenant.manage'), express.json(), (req, res) => {
  const d = db.prepare('SELECT * FROM tenant_domains WHERE id = ?').get(req.params.domainId);
  if (!d) return res.status(404).json({ error: 'Domain not found · 未找到域名' });
  const b = req.body || {};
  if (Object.prototype.hasOwnProperty.call(b, 'status') && ['active', 'pending', 'disabled'].includes(b.status)) {
    db.prepare('UPDATE tenant_domains SET status = ? WHERE id = ?').run(b.status, d.id);
  }
  if (b.is_primary === true) {
    // Exactly one primary per tenant; promoting also activates it.
    const tx = db.transaction(() => {
      db.prepare('UPDATE tenant_domains SET is_primary = 0 WHERE tenant_id = ?').run(d.tenant_id);
      db.prepare("UPDATE tenant_domains SET is_primary = 1, status = CASE WHEN status = 'disabled' THEN 'active' ELSE status END WHERE id = ?").run(d.id);
    });
    tx();
  }
  logAudit(req, { action: 'domain.update', targetType: 'tenant', targetId: d.tenant_id, meta: { host: d.host, status: b.status, primary: b.is_primary === true } });
  res.json({ success: true });
});

router.delete('/api/store-admin/domains/:domainId', requirePlatformAdmin('tenant.manage'), (req, res) => {
  const d = db.prepare('SELECT * FROM tenant_domains WHERE id = ?').get(req.params.domainId);
  if (!d) return res.status(404).json({ error: 'Domain not found · 未找到域名' });
  db.prepare('DELETE FROM tenant_domains WHERE id = ?').run(d.id);
  logAudit(req, { action: 'domain.remove', targetType: 'tenant', targetId: d.tenant_id, meta: { host: d.host } });
  res.json({ success: true });
});

// ════════════════ BROADCASTS (merchant-facing notices) ════════════════
const BROADCAST_LEVELS = ['info', 'warn', 'critical'];
function broadcastRow(r) {
  return {
    id: r.id, titleEn: r.title_en, titleCn: r.title_cn, bodyEn: r.body_en, bodyCn: r.body_cn,
    level: r.level, audience: r.audience, tenantId: r.tenant_id, active: !!r.active,
    startsAt: r.starts_at, endsAt: r.ends_at, createdBy: r.created_by, createdAt: r.created_at,
    tenant: r.tenant_brand || r.tenant_name || null,
  };
}
router.get('/api/store-admin/broadcasts', requirePlatformAdmin('view'), (req, res) => {
  const rows = db.prepare(`SELECT b.*, t.name AS tenant_name, t.brand_name AS tenant_brand
                           FROM platform_broadcasts b LEFT JOIN tenants t ON t.id = b.tenant_id
                           ORDER BY b.active DESC, b.id DESC`).all().map(broadcastRow);
  res.json({ success: true, broadcasts: rows });
});
router.post('/api/store-admin/broadcasts', requirePlatformAdmin('broadcast'), express.json(), (req, res) => {
  const b = req.body || {};
  const level = BROADCAST_LEVELS.includes(b.level) ? b.level : 'info';
  const audience = b.audience === 'tenant' ? 'tenant' : 'all';
  const tenantId = audience === 'tenant' ? Number(b.tenant_id) || null : null;
  if (audience === 'tenant' && !tenantId) return res.status(400).json({ error: 'Pick a store for a targeted notice · 请选择目标店铺' });
  const clip = (s, n) => s == null ? null : String(s).slice(0, n) || null;
  const titleEn = clip(b.title_en, 160), titleCn = clip(b.title_cn, 160);
  const bodyEn = clip(b.body_en, 1200), bodyCn = clip(b.body_cn, 1200);
  if (!titleEn && !titleCn && !bodyEn && !bodyCn) return res.status(400).json({ error: 'Enter a title or message · 请输入标题或内容' });
  const info = db.prepare(`INSERT INTO platform_broadcasts (title_en,title_cn,body_en,body_cn,level,audience,tenant_id,active,starts_at,ends_at,created_by)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(titleEn, titleCn, bodyEn, bodyCn, level, audience, tenantId, b.active === false ? 0 : 1,
         clip(b.starts_at, 30), clip(b.ends_at, 30), (req.platformActor && req.platformActor.name) || null);
  logAudit(req, { action: 'broadcast.create', targetType: 'broadcast', targetId: info.lastInsertRowid, meta: { level, audience, tenantId } });
  res.json({ success: true, id: info.lastInsertRowid });
});
router.patch('/api/store-admin/broadcasts/:id', requirePlatformAdmin('broadcast'), express.json(), (req, res) => {
  const r = db.prepare('SELECT * FROM platform_broadcasts WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Notice not found · 未找到通知' });
  const b = req.body || {}; const sets = [], params = [], changed = {};
  const setIf = (key, col, fn) => { if (Object.prototype.hasOwnProperty.call(b, key)) { sets.push(col + ' = ?'); params.push(fn ? fn(b[key]) : b[key]); changed[key] = true; } };
  setIf('title_en', 'title_en', v => v ? String(v).slice(0, 160) : null);
  setIf('title_cn', 'title_cn', v => v ? String(v).slice(0, 160) : null);
  setIf('body_en', 'body_en', v => v ? String(v).slice(0, 1200) : null);
  setIf('body_cn', 'body_cn', v => v ? String(v).slice(0, 1200) : null);
  if (Object.prototype.hasOwnProperty.call(b, 'level')) { sets.push('level = ?'); params.push(BROADCAST_LEVELS.includes(b.level) ? b.level : r.level); changed.level = true; }
  if (Object.prototype.hasOwnProperty.call(b, 'active')) { sets.push('active = ?'); params.push(b.active ? 1 : 0); changed.active = !!b.active; }
  if (!sets.length) return res.json({ success: true });
  params.push(r.id);
  db.prepare(`UPDATE platform_broadcasts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  logAudit(req, { action: 'broadcast.update', targetType: 'broadcast', targetId: r.id, meta: changed });
  res.json({ success: true });
});
router.delete('/api/store-admin/broadcasts/:id', requirePlatformAdmin('broadcast'), (req, res) => {
  const r = db.prepare('SELECT id FROM platform_broadcasts WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Notice not found · 未找到通知' });
  db.prepare('DELETE FROM platform_broadcasts WHERE id = ?').run(r.id);
  logAudit(req, { action: 'broadcast.delete', targetType: 'broadcast', targetId: r.id });
  res.json({ success: true });
});

// ════════════════ IMPERSONATE (log in as a store) ════════════════
// Mints a one-time token; the console opens STORE_BACKEND_HOST/impersonate?t=…
// which consumes it (server.js) and starts the impersonated tenant_users session.
router.post('/api/store-admin/tenants/:id/impersonate', requirePlatformAdmin('impersonate'), (req, res) => {
  const t = db.prepare('SELECT id, name, brand_name, status FROM tenants WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Store not found · 未找到店铺' });
  if (t.status !== 'active') return res.status(400).json({ error: 'Store is not active · 店铺未激活' });
  const op = db.prepare("SELECT id, username FROM tenant_users WHERE tenant_id = ? AND is_active = 1 ORDER BY (role = 'owner') DESC, id ASC LIMIT 1").get(t.id);
  if (!op) return res.status(400).json({ error: 'This store has no active operator to act as · 该店铺没有可用操作员' });
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 120000).toISOString();   // 2-minute single-use window
  const actor = req.platformActor;
  db.prepare(`INSERT INTO platform_impersonation_tokens (token, tenant_id, operator_id, by_kind, by_id, by_name, expires_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(token, t.id, op.id, actor.kind, actor.id, actor.name, expiresAt);
  logAudit(req, { action: 'impersonate.start', targetType: 'tenant', targetId: t.id, meta: { operator: op.username } });
  res.json({ success: true, url: 'https://' + STORE_BACKEND_HOST + '/impersonate?t=' + token, store: t.brand_name || t.name, expiresInSec: 120 });
});

// ════════════════ ANALYTICS (control-plane roll-ups) ════════════════
router.get('/api/store-admin/analytics', requirePlatformAdmin('view'), (req, res) => {
  // Plan mix among paying (active, non-internal) subscriptions.
  const planMix = db.prepare(`
    SELECT p.code, p.name, p.price_cents, COUNT(*) c
    FROM billing_subscriptions s JOIN billing_plans p ON p.id = s.plan_id
    WHERE s.status = 'active' AND s.is_internal = 0
    GROUP BY p.id ORDER BY p.sort_order ASC`).all();
  const subHealth = {};
  db.prepare('SELECT status, COUNT(*) c FROM billing_subscriptions GROUP BY status').all().forEach(r => { subHealth[r.status] = r.c; });
  const leadFunnel = {};
  db.prepare('SELECT status, COUNT(*) c FROM tenant_signup_requests GROUP BY status').all().forEach(r => { leadFunnel[r.status] = r.c; });
  // Collected revenue (paid invoices) in the trailing 30 / 90 days.
  const collected = (days) => db.prepare(
    "SELECT COALESCE(SUM(amount_cents),0) v, COUNT(*) c FROM billing_invoices WHERE status = 'paid' AND paid_at >= datetime('now', ?)"
  ).get('-' + days + ' days');
  // New stores per month, last 6 months.
  const signupsByMonth = db.prepare(`
    SELECT strftime('%Y-%m', created_at) ym, COUNT(*) c
    FROM tenants GROUP BY ym ORDER BY ym DESC LIMIT 6`).all().reverse();
  res.json({
    success: true,
    planMix: planMix.map(p => ({ code: p.code, name: p.name, priceCents: p.price_cents, count: p.c })),
    subHealth, leadFunnel,
    revenue: { last30: collected(30), last90: collected(90) },
    signupsByMonth,
  });
});

// ════════════════ GLOBAL LOOKUP (cross-tenant customers + orders) ════════════════
// Support tool: find a shopper or order across EVERY store. Each tenant's
// customer/order data lives in its OWN DB (data plane) — Roots in the shared
// db, others in data/tenants/<id>.db — so we iterate active tenants and query
// each connection, tagging every hit with its store. One bad tenant DB is
// skipped, never failing the whole search.
router.get('/api/store-admin/lookup', requirePlatformAdmin('view'), (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.status(400).json({ error: 'Type at least 2 characters · 请输入至少 2 个字符' });
  const like = '%' + q.replace(/[%_]/g, '') + '%';
  const PER = 6;
  const customers = [], orders = [];
  const tenants = db.prepare("SELECT id, name, brand_name FROM tenants WHERE status = 'active' ORDER BY id ASC").all();
  for (const t of tenants) {
    let tdb; try { tdb = getTenantDb(t.id); } catch (e) { continue; }
    const label = t.brand_name || t.name;
    try {
      tdb.prepare(`SELECT id, nickname, phone, email, tier_key, lifetime_spend, points_balance, balance, is_blocked, created_at
                   FROM retail_customers WHERE phone LIKE ? OR nickname LIKE ? OR email LIKE ? OR CAST(id AS TEXT) = ?
                   ORDER BY lifetime_spend DESC LIMIT ?`).all(like, like, like, q, PER)
        .forEach(c => customers.push({ tenantId: t.id, tenant: label, id: c.id, nickname: c.nickname, phone: c.phone, email: c.email, tier: c.tier_key, lifetimeSpend: c.lifetime_spend, pointsBalance: c.points_balance, balance: c.balance, isBlocked: !!c.is_blocked, createdAt: c.created_at }));
    } catch (e) { /* tenant has no customer table / unreadable → skip */ }
    try {
      tdb.prepare(`SELECT id, order_no, status, payment_method, recipient_name, recipient_phone, address_full, total, created_at
                   FROM retail_orders WHERE order_no LIKE ? OR recipient_phone LIKE ? OR recipient_name LIKE ?
                   ORDER BY created_at DESC LIMIT ?`).all(like, like, like, PER)
        .forEach(o => orders.push({ tenantId: t.id, tenant: label, id: o.id, orderNo: o.order_no, status: o.status, paymentMethod: o.payment_method, recipientName: o.recipient_name, recipientPhone: o.recipient_phone, addressFull: o.address_full, total: o.total, createdAt: o.created_at }));
    } catch (e) { /* skip */ }
  }
  customers.sort((a, b) => (b.lifetimeSpend || 0) - (a.lifetimeSpend || 0));
  orders.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  logAudit(req, { action: 'lookup.search', meta: { q, customers: customers.length, orders: orders.length } });
  res.json({ success: true, query: q, customers: customers.slice(0, 60), orders: orders.slice(0, 60) });
});

// Drill into one customer (in one store): profile + recent orders.
router.get('/api/store-admin/lookup/customer', requirePlatformAdmin('view'), (req, res) => {
  const tid = Number(req.query.tenant), cid = Number(req.query.id);
  if (!tid || !cid) return res.status(400).json({ error: 'tenant and id required' });
  const t = db.prepare('SELECT id, name, brand_name FROM tenants WHERE id = ?').get(tid);
  if (!t) return res.status(404).json({ error: 'Store not found · 未找到店铺' });
  let tdb; try { tdb = getTenantDb(tid); } catch (e) { return res.status(500).json({ error: 'Store data unavailable · 店铺数据不可用' }); }
  let c; try { c = tdb.prepare(`SELECT id, nickname, phone, email, tier_key, lifetime_spend, points_balance, balance, coupon_count, is_blocked, created_at, last_login_at FROM retail_customers WHERE id = ?`).get(cid); }
  catch (e) { return res.status(500).json({ error: 'Store data unavailable · 店铺数据不可用' }); }
  if (!c) return res.status(404).json({ error: 'Customer not found · 未找到顾客' });
  let orders = [];
  try { orders = tdb.prepare(`SELECT id, order_no, status, payment_method, total, created_at FROM retail_orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 20`).all(cid); } catch (e) {}
  logAudit(req, { action: 'lookup.customer', targetType: 'tenant', targetId: tid, meta: { customerId: cid } });
  res.json({
    success: true, store: t.brand_name || t.name,
    customer: { id: c.id, nickname: c.nickname, phone: c.phone, email: c.email, tier: c.tier_key, lifetimeSpend: c.lifetime_spend, pointsBalance: c.points_balance, balance: c.balance, couponCount: c.coupon_count, isBlocked: !!c.is_blocked, createdAt: c.created_at, lastLoginAt: c.last_login_at },
    orders: orders.map(o => ({ id: o.id, orderNo: o.order_no, status: o.status, paymentMethod: o.payment_method, total: o.total, createdAt: o.created_at })),
  });
});

// ════════════════ SUPPORT INBOX (merchant tickets) ════════════════
function ticketSummary(r) {
  return { id: r.id, tenantId: r.tenant_id, tenant: r.tenant_brand || r.tenant_name || ('#' + r.tenant_id),
    operator: r.operator_name, subject: r.subject, status: r.status, lastSender: r.last_sender,
    createdAt: r.created_at, updatedAt: r.updated_at };
}
router.get('/api/store-admin/tickets', requirePlatformAdmin('view'), (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  let sql = `SELECT k.*, t.name AS tenant_name, t.brand_name AS tenant_brand
             FROM platform_tickets k LEFT JOIN tenants t ON t.id = k.tenant_id`;
  const params = [];
  if (status && ['open', 'pending', 'resolved'].includes(status)) { sql += ' WHERE k.status = ?'; params.push(status); }
  sql += " ORDER BY (k.status = 'resolved') ASC, k.updated_at DESC LIMIT 200";
  const rows = db.prepare(sql).all(...params).map(ticketSummary);
  const openCount = db.prepare("SELECT COUNT(*) c FROM platform_tickets WHERE status != 'resolved'").get().c;
  res.json({ success: true, tickets: rows, openCount });
});
router.get('/api/store-admin/tickets/:id', requirePlatformAdmin('view'), (req, res) => {
  const k = db.prepare(`SELECT k.*, t.name AS tenant_name, t.brand_name AS tenant_brand
                        FROM platform_tickets k LEFT JOIN tenants t ON t.id = k.tenant_id WHERE k.id = ?`).get(req.params.id);
  if (!k) return res.status(404).json({ error: 'Ticket not found · 未找到工单' });
  const messages = db.prepare('SELECT id, sender_kind, sender_name, body, created_at FROM platform_ticket_messages WHERE ticket_id = ? ORDER BY id ASC').all(k.id)
    .map(m => ({ id: m.id, senderKind: m.sender_kind, senderName: m.sender_name, body: m.body, at: m.created_at }));
  res.json({ success: true, ticket: ticketSummary(k), messages });
});
router.post('/api/store-admin/tickets/:id/reply', requirePlatformAdmin('support.write'), express.json(), (req, res) => {
  const k = db.prepare('SELECT id FROM platform_tickets WHERE id = ?').get(req.params.id);
  if (!k) return res.status(404).json({ error: 'Ticket not found · 未找到工单' });
  const body = String((req.body && req.body.body) || '').trim();
  if (!body) return res.status(400).json({ error: 'Enter a reply · 请输入回复' });
  const name = (req.platformActor && req.platformActor.name) || 'Platform';
  db.prepare('INSERT INTO platform_ticket_messages (ticket_id, sender_kind, sender_name, body) VALUES (?,?,?,?)').run(k.id, 'platform', name, body.slice(0, 4000));
  // A platform reply moves the ticket to 'pending' (awaiting the merchant).
  db.prepare("UPDATE platform_tickets SET status = CASE WHEN status = 'resolved' THEN 'resolved' ELSE 'pending' END, last_sender = 'platform', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(k.id);
  logAudit(req, { action: 'ticket.reply', targetType: 'ticket', targetId: k.id });
  res.json({ success: true });
});
router.post('/api/store-admin/tickets/:id/status', requirePlatformAdmin('support.write'), express.json(), (req, res) => {
  const status = String((req.body && req.body.status) || '').trim();
  if (!['open', 'pending', 'resolved'].includes(status)) return res.status(400).json({ error: 'Unknown status · 未知状态' });
  const r = db.prepare('UPDATE platform_tickets SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Ticket not found · 未找到工单' });
  logAudit(req, { action: 'ticket.status', targetType: 'ticket', targetId: req.params.id, meta: { status } });
  res.json({ success: true });
});

module.exports = router;
