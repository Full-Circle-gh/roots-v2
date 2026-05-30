// Mini App Backend — operator identity (control plane).
//
// This is the SEPARATE auth realm for the Mini App Backend product, distinct
// from the Roots kitchen `users` table. It is the first step of turning the
// backend into a standalone, multi-tenant SaaS:
//
//   tenants       — one row per customer company (Roots = tenant #1)
//   tenant_users  — backend operators, scoped to a tenant
//
// Sessions use their OWN keys (req.session.backendUserId / .tenantId) so a
// backend operator is never mistaken for a kitchen user, and vice-versa.
// Business data is NOT yet tenant-scoped — that isolation decision (DB-per-
// tenant vs shared + tenant_id) is deliberately deferred to a later phase.

const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const db = require('../database');
const features = require('../lib/features');
const router = express.Router();

// ── Schema (idempotent) ─────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    brand_name  TEXT,
    status      TEXT NOT NULL DEFAULT 'active',   -- active | suspended | cancelled
    -- Who owns this tenant's product catalog + stock?
    --   'self'     = managed here, in the mini-app backend (standalone tenants
    --                with no upstream system behind them).
    --   'upstream' = owned by an external system (e.g. Roots' kitchen app); the
    --                mini-app backend only merchandises the channel, never edits
    --                master data or stock.
    product_catalog_mode TEXT NOT NULL DEFAULT 'self',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS tenant_users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id    INTEGER NOT NULL,
    username     TEXT NOT NULL,
    password     TEXT NOT NULL,                    -- bcrypt hash
    display_name TEXT,
    role         TEXT NOT NULL DEFAULT 'staff',    -- owner | admin | staff
    is_active    INTEGER DEFAULT 1,
    last_login   DATETIME,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_users_login ON tenant_users(tenant_id, username);
`);

// Existing DBs predating product_catalog_mode get the column via ALTER. New
// tenants default to 'self'; Roots is flipped to 'upstream' by the migration
// below (after seedBackend, so the row is guaranteed to exist).
try { db.exec("ALTER TABLE tenants ADD COLUMN product_catalog_mode TEXT NOT NULL DEFAULT 'self'"); } catch (e) { /* already added */ }

// Per-tenant feature ENTITLEMENT ceiling (dormant by default). A JSON object of
// { <featureKey>: false } disables a feature for this tenant; null/absent =
// entitled to everything (see lib/features.js). The platform lowers this in
// saas-admin only once a feature is gated/paid; until then every tenant keeps
// full self-serve control via storefront_config `features.*`.
try { db.exec('ALTER TABLE tenants ADD COLUMN features_json TEXT'); } catch (e) { /* already added */ }

// ── Seed Roots as tenant #1 + an owner operator (mirrors auth.js seedUsers) ──
function seedBackend() {
  let roots = db.prepare("SELECT id FROM tenants ORDER BY id ASC LIMIT 1").get();
  if (!roots) {
    const r = db.prepare("INSERT INTO tenants (name, brand_name, status) VALUES (?,?,?)")
      .run('Roots', 'Full Circle', 'active');
    roots = { id: r.lastInsertRowid };
    console.log('[backend-auth] seeded tenant #' + roots.id + ' (Roots · Full Circle)');
  }
  const count = db.prepare('SELECT COUNT(*) c FROM tenant_users WHERE tenant_id = ?').get(roots.id).c;
  if (count === 0) {
    const hash = bcrypt.hashSync('FullCircle2026!', 10);
    db.prepare("INSERT INTO tenant_users (tenant_id, username, password, display_name, role) VALUES (?,?,?,?,?)")
      .run(roots.id, 'owner', hash, 'Owner', 'owner');
    console.log('[backend-auth] seeded owner operator (username: owner) — ROTATE the default password.');
  }
}
seedBackend();

// One-time: Roots (the integrated tenant, #1) is upstream-sourced — its product
// catalog and stock live in the kitchen app, not in the mini-app backend. Run
// once via the shared _migrations guard so a later manual change to Roots'
// mode isn't clobbered on every boot. New standalone tenants stay 'self'.
try {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  const done = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('tenant_catalog_mode_roots_upstream_v1');
  if (!done) {
    db.prepare("UPDATE tenants SET product_catalog_mode = 'upstream' WHERE id = 1").run();
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('tenant_catalog_mode_roots_upstream_v1');
  }
} catch (e) { console.error('[backend-auth] catalog-mode migration', e); }

// Boot-time nag if the seeded operator still holds the public default password.
try {
  const owner = db.prepare("SELECT password FROM tenant_users WHERE username = 'owner' ORDER BY id ASC LIMIT 1").get();
  if (owner && bcrypt.compareSync('FullCircle2026!', owner.password)) {
    console.error('[backend-auth] WARNING — operator "owner" still uses the seeded password (FullCircle2026!). Rotate it.');
  }
} catch (e) {}

// ── Brute-force guard, same posture as the kitchen login ─────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many attempts, try again in 15 minutes · 尝试过于频繁,请 15 分钟后再试' },
});

router.post('/api/backend/login', loginLimiter, express.json(), (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.json({ success: false, error: 'Enter username and password · 请输入用户名和密码' });
  const u = db.prepare('SELECT * FROM tenant_users WHERE username = ? AND is_active = 1').get(String(username).trim().toLowerCase());
  if (!u || !bcrypt.compareSync(password, u.password)) {
    return res.json({ success: false, error: 'Incorrect username or password · 用户名或密码错误' });
  }
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(u.tenant_id);
  if (!tenant || tenant.status !== 'active') {
    return res.json({ success: false, error: 'This account is not active · 此账户未激活' });
  }
  db.prepare('UPDATE tenant_users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(u.id);
  req.session.backendUserId = u.id;
  req.session.tenantId = u.tenant_id;
  res.json({
    success: true,
    user: { id: u.id, username: u.username, displayName: u.display_name, role: u.role,
            tenant: { id: tenant.id, name: tenant.name, brand: tenant.brand_name,
                      catalogMode: tenant.product_catalog_mode || 'self',
                      entitlements: features.entitlements(tenant.features_json) } },
  });
});

router.post('/api/backend/logout', (req, res) => {
  if (req.session) { delete req.session.backendUserId; delete req.session.tenantId; }
  res.json({ success: true });
});

router.get('/api/backend/me', (req, res) => {
  if (!req.session || !req.session.backendUserId) return res.json({ user: null });
  const u = db.prepare('SELECT id, tenant_id, username, display_name, role, last_login FROM tenant_users WHERE id = ? AND is_active = 1').get(req.session.backendUserId);
  if (!u) return res.json({ user: null });
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(u.tenant_id);
  res.json({
    user: { id: u.id, username: u.username, displayName: u.display_name, role: u.role, lastLogin: u.last_login,
            tenant: tenant ? { id: tenant.id, name: tenant.name, brand: tenant.brand_name, accent: tenant.brand_accent || null, status: tenant.status, catalogMode: tenant.product_catalog_mode || 'self', entitlements: features.entitlements(tenant.features_json) } : null },
  });
});

// Change own password — requires the current password, mirrors the kitchen
// /api/auth/password policy (min 10 chars, must differ). Closes the seeded
// default-password gap for backend operators.
router.put('/api/backend/password', express.json(), (req, res) => {
  if (!req.session?.backendUserId) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  const { current_password, new_password } = req.body || {};
  if (!new_password || new_password.length < 10) return res.status(400).json({ error: 'New password must be at least 10 characters · 新密码至少需要 10 位' });
  const u = db.prepare('SELECT password FROM tenant_users WHERE id = ?').get(req.session.backendUserId);
  if (!u) return res.status(404).json({ error: 'Operator not found · 未找到操作员' });
  if (!current_password || !bcrypt.compareSync(current_password, u.password)) {
    return res.status(400).json({ error: 'Current password is incorrect · 当前密码不正确' });
  }
  if (bcrypt.compareSync(new_password, u.password)) {
    return res.status(400).json({ error: 'New password must differ from the current one · 新密码不能与当前密码相同' });
  }
  db.prepare('UPDATE tenant_users SET password = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), req.session.backendUserId);
  res.json({ success: true });
});

module.exports = router;
