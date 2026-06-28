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

  -- ── Per-user permissions (RBAC) ────────────────────────────────────────
  -- A user's role (tenant_users.role) is a PRESET that expands to a base set of
  -- capabilities in lib/capabilities.js. These two tables hold the per-user
  -- DEVIATIONS from that preset, so the common case (a plain role) stores no
  -- rows at all. Effective caps are resolved fresh on every request — never
  -- cached in the session — so an admin's change takes effect immediately.
  --
  --   tenant_user_caps   : grant/revoke a single capability for one user.
  --                        mode = 'grant' (force ON) | 'revoke' (force OFF).
  --   tenant_user_stores : which stores a store-scoped user may touch. Used
  --                        only when tenant_users.scope_all = 0; otherwise the
  --                        user is unscoped (all stores).
  CREATE TABLE IF NOT EXISTS tenant_user_caps (
    tenant_id      INTEGER NOT NULL,
    tenant_user_id INTEGER NOT NULL,
    capability_key TEXT    NOT NULL,
    mode           TEXT    NOT NULL DEFAULT 'grant',   -- 'grant' | 'revoke'
    updated_by     INTEGER,
    updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_user_id, capability_key),
    FOREIGN KEY (tenant_user_id) REFERENCES tenant_users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_tenant_user_caps_user ON tenant_user_caps(tenant_user_id);

  CREATE TABLE IF NOT EXISTS tenant_user_stores (
    tenant_user_id INTEGER NOT NULL,
    store_id       INTEGER NOT NULL,
    PRIMARY KEY (tenant_user_id, store_id),
    FOREIGN KEY (tenant_user_id) REFERENCES tenant_users(id)
  );

  -- Web storefront hostnames. Each tenant can serve a browser website (alongside
  -- or instead of its WeChat mini-app); a request's Host maps to the tenant the
  -- same way x-wx-appid does for the mini-app (see middleware/public-tenant.js).
  -- Defined here (not saas-admin) so the table exists before the public-tenant
  -- middleware that reads it is mounted in server.js.
  --   kind   : 'subdomain' (free <slug>.<platform-base>) | 'custom' (BYO domain)
  --   status : 'active' (serve it) | 'pending' (DNS/SSL/ICP not ready) | 'disabled'
  CREATE TABLE IF NOT EXISTS tenant_domains (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id   INTEGER NOT NULL,
    host        TEXT NOT NULL,                     -- lowercased, no port
    kind        TEXT NOT NULL DEFAULT 'subdomain',
    status      TEXT NOT NULL DEFAULT 'active',
    is_primary  INTEGER NOT NULL DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_domains_host ON tenant_domains(host);
  CREATE INDEX IF NOT EXISTS idx_tenant_domains_tenant ON tenant_domains(tenant_id);
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

// Operator avatar (Google-style profile circle). Stored as a small data-URL
// (client downscales before upload); null = fall back to an initials monogram.
// Consistent with how customer avatars + other images live in SQLite today; the
// planned OSS migration will sweep these up with the rest.
try { db.exec('ALTER TABLE tenant_users ADD COLUMN avatar_url TEXT'); } catch (e) { /* already added */ }

// Store assignment for restricted operators (the Quick Stock app): the one store
// they manage stock for. Set for the 'kitchen' role (add stock) and the
// 'store_stock' role (recount a store). NULL for owner/admin/staff (full-access
// operators are not pinned to a store).
try { db.exec('ALTER TABLE tenant_users ADD COLUMN retail_store_id INTEGER'); } catch (e) { /* already added */ }

// Store-scope mode for the RBAC layer. 1 = all stores (the default, matches
// today's owner/admin/staff, who are not pinned); 0 = only the stores listed in
// tenant_user_stores. retail_store_id stays as the legacy single-store pin for
// kitchen/store_stock and is read as a fallback when no scope rows exist.
try { db.exec('ALTER TABLE tenant_users ADD COLUMN scope_all INTEGER NOT NULL DEFAULT 1'); } catch (e) { /* already added */ }

// RBAC enforcement switch (per tenant). 0 = OFF (default — capabilities are
// computed + the client renders by them, but the server blocks nothing, so an
// over-narrow assignment can never lock a tenant out of its own backend). 1 = ON
// (requireRetailAdmin enforces the route→capability map). Owners always bypass.
// Flipped from the Team page by an owner once they've assigned permissions.
try { db.exec('ALTER TABLE tenants ADD COLUMN rbac_enforce INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* already added */ }

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

// One-time: flip Roots (#1) to 'self'. The store catalog was forked into its
// own store_products table (the kitchen `products` table no longer drives the
// shop), so the Mini App Backend now OWNS the store catalog + per-store stock.
// 'self' lifts the upstream API locks and drops the catalog-upstream CSS, so
// the in-page product editor (create/edit/delete + full field set) goes live.
// Runs after the upstream migration above; a later admin change is preserved.
try {
  const done = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('tenant_catalog_mode_roots_self_v1');
  if (!done) {
    db.prepare("UPDATE tenants SET product_catalog_mode = 'self' WHERE id = 1").run();
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('tenant_catalog_mode_roots_self_v1');
  }
} catch (e) { console.error('[backend-auth] catalog-mode self migration', e); }

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
  const { username, password, remember } = req.body || {};
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
  // "Keep me signed in" — extend this operator's cookie to 30 days; otherwise
  // it stays at the global 8-hour default (lost when the browser closes the gap).
  req.session.cookie.maxAge = remember ? 30 * 24 * 60 * 60 * 1000 : 8 * 60 * 60 * 1000;
  res.json({
    success: true,
    user: { id: u.id, username: u.username, displayName: u.display_name, role: u.role, avatarUrl: u.avatar_url || null,
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
  const u = db.prepare('SELECT id, tenant_id, username, display_name, role, last_login, avatar_url, retail_store_id, scope_all FROM tenant_users WHERE id = ? AND is_active = 1').get(req.session.backendUserId);
  if (!u) return res.json({ user: null });
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(u.tenant_id);
  // Effective capabilities + store scope for the signed-in operator. The client
  // renders the backend from this (hide sections/buttons the user can't use).
  // Resolved fresh here, mirroring the server-side req.caps, so the view and the
  // (future) enforcement always agree. Fail-open to no list on any hiccup.
  let caps = null, scopeStores = null;
  try {
    const r = require('../lib/operator-caps').resolveOperator(db, u, tenant);
    caps = r.caps; scopeStores = r.scopeStores;
  } catch (e) { caps = null; scopeStores = null; }
  res.json({
    user: { id: u.id, username: u.username, displayName: u.display_name, role: u.role, lastLogin: u.last_login, avatarUrl: u.avatar_url || null,
            caps, scopeStores,
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

// Edit own profile. Only the display name is self-editable; username, role and
// tenant are login identity / admin-assigned and stay read-only.
router.put('/api/backend/profile', express.json(), (req, res) => {
  if (!req.session?.backendUserId) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  const name = String((req.body && req.body.display_name) || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required · 名称必填' });
  if (name.length > 60) return res.status(400).json({ error: 'Name is too long · 名称过长' });
  db.prepare('UPDATE tenant_users SET display_name = ? WHERE id = ?').run(name, req.session.backendUserId);
  res.json({ success: true, displayName: name });
});

// Set / clear own avatar (the Google-style profile circle). The client downscales
// to a small square data-URL before posting; we still cap the payload server-side
// so a hand-crafted request can't bloat the row. Pass avatar:null (or '') to clear
// back to the initials monogram. Larger JSON body limit just for this route.
router.put('/api/backend/avatar', express.json({ limit: '1mb' }), (req, res) => {
  if (!req.session?.backendUserId) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  let avatar = req.body && req.body.avatar;
  if (avatar === null || avatar === undefined || avatar === '') {
    db.prepare('UPDATE tenant_users SET avatar_url = NULL WHERE id = ?').run(req.session.backendUserId);
    return res.json({ success: true, avatarUrl: null });
  }
  avatar = String(avatar);
  if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(avatar)) {
    return res.status(400).json({ error: 'Unsupported image format · 不支持的图片格式' });
  }
  // ~700KB ceiling on the data-URL (the client targets a 256px square, well under).
  if (avatar.length > 700 * 1024) {
    return res.status(413).json({ error: 'Image is too large — please use a smaller photo · 图片过大，请使用更小的照片' });
  }
  db.prepare('UPDATE tenant_users SET avatar_url = ? WHERE id = ?').run(avatar, req.session.backendUserId);
  res.json({ success: true, avatarUrl: avatar });
});

module.exports = router;
