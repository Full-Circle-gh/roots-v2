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
const {
  ROLES, capsFor, requirePlatformAdmin, currentActor, logAudit,
} = require('../lib/platform-admin');
const router = express.Router();

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

module.exports = router;
