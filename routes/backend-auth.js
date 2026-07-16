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
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../database');
const features = require('../lib/features');
const emailSender = require('../lib/email-sender');
const aliyunSms = require('../lib/aliyun-sms');
const { getTenantCreds } = require('../lib/tenant-creds');
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

  -- ── Signed-in devices (active sessions) ────────────────────────────────
  -- One row per browser/app session an operator has open, so the Profile →
  -- Devices tab can list them and sign any one out. Keyed by the express
  -- session id (sid); the real session lives in sessions.db (connect-sqlite3)
  -- and is destroyed via req.sessionStore.destroy(sid) on revoke — this table
  -- is just the human-readable index (who / what device / where / when).
  CREATE TABLE IF NOT EXISTS tenant_user_sessions (
    sid            TEXT PRIMARY KEY,
    tenant_user_id INTEGER NOT NULL,
    tenant_id      INTEGER,
    user_agent     TEXT,
    ip             TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_user_id) REFERENCES tenant_users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_tenant_user_sessions_user ON tenant_user_sessions(tenant_user_id);
`);

// Existing DBs predating product_catalog_mode get the column via ALTER. New
// tenants default to 'self'; Roots is flipped to 'upstream' by the migration
// below (after seedBackend, so the row is guaranteed to exist).
try { db.exec("ALTER TABLE tenants ADD COLUMN product_catalog_mode TEXT NOT NULL DEFAULT 'self'"); } catch (e) { /* already added */ }

// Co-brand identity (identity-only tier). A tenant uploads a logo + name that
// lead the admin chrome, sign-in, favicon and customer emails; a small
// "runs on tacet" credit stays unless the platform grants white-label
//   brand_logo_data  — primary logo, base64 data-URI (served via /api/backend/brand/:id/logo)
//   brand_mark_data  — square mark, auto-derived from the logo with sharp (favicon / folded rail)
//   brand_credit     — 1 = show the "runs on tacet" credit; only the platform clears it to 0
//   brand_updated_at — cache-bust stamp so the image URLs refresh on save
for (const [c, t] of [
  ['brand_logo_data', 'TEXT'],
  ['brand_mark_data', 'TEXT'],
  ['brand_credit', 'INTEGER NOT NULL DEFAULT 1'],
  ['brand_updated_at', 'DATETIME'],
]) { try { db.exec(`ALTER TABLE tenants ADD COLUMN ${c} ${t}`); } catch (e) { /* already added */ } }

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

// Recovery email — a personal address the operator can use to reset a
// forgotten password (login is username-only otherwise, so a lost password
// was previously unrecoverable without an admin). Verified via an emailed code
// before it's trusted for reset.
try { db.exec('ALTER TABLE tenant_users ADD COLUMN recovery_email TEXT'); } catch (e) { /* already added */ }
try { db.exec('ALTER TABLE tenant_users ADD COLUMN recovery_email_verified INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* already added */ }

// Two-step verification — when on, a login also requires a one-time code
// emailed to the operator's verified recovery address.
try { db.exec('ALTER TABLE tenant_users ADD COLUMN twofa_enabled INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* already added */ }

// Phone (mobile) — a personal number for SMS-based two-step verification.
// Verified via an SMS code (Aliyun) before it's trusted, mirroring the
// recovery-email flow. Masked everywhere it's shown back.
try { db.exec('ALTER TABLE tenant_users ADD COLUMN phone TEXT'); } catch (e) { /* already added */ }
try { db.exec('ALTER TABLE tenant_users ADD COLUMN phone_verified INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* already added */ }

// Two-step delivery channel — where the one-time sign-in code is sent when
// twofa_enabled is on: 'email' (to the recovery email, the default) or 'sms'
// (to the verified phone). Ignored when 2FA is off.
try { db.exec("ALTER TABLE tenant_users ADD COLUMN twofa_method TEXT NOT NULL DEFAULT 'email'"); } catch (e) { /* already added */ }

// One-time codes — emailed 6-digit codes for verifying a recovery address,
// resetting a forgotten password, enabling 2FA, and the login second step.
// Codes are stored HASHED (never plain), short-lived, and single-use; a small
// attempt counter blocks guessing.
db.exec(`
  CREATE TABLE IF NOT EXISTS tenant_user_codes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_user_id INTEGER NOT NULL,
    purpose        TEXT NOT NULL,               -- 'recovery_verify' | 'password_reset' | 'twofa_enable' | 'login_2fa'
    email          TEXT,                        -- target address (pending recovery email / recovery email)
    code_hash      TEXT NOT NULL,
    attempts       INTEGER NOT NULL DEFAULT 0,
    used           INTEGER NOT NULL DEFAULT 0,
    expires_at     DATETIME NOT NULL,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_user_id) REFERENCES tenant_users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_tenant_user_codes_user ON tenant_user_codes(tenant_user_id, purpose);

  -- Web Push subscriptions for BACKEND operators (tenant_users). Kept separate
  -- from push_subscriptions (which is keyed to kitchen users) so an operator's
  -- "Push to this device" toggle reaches THEIR device. One row per endpoint.
  CREATE TABLE IF NOT EXISTS tenant_operator_push_subs (
    endpoint       TEXT PRIMARY KEY,
    tenant_user_id INTEGER NOT NULL,
    tenant_id      INTEGER,
    p256dh         TEXT NOT NULL,
    auth           TEXT NOT NULL,
    user_agent     TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_user_id) REFERENCES tenant_users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_operator_push_user   ON tenant_operator_push_subs(tenant_user_id);
  CREATE INDEX IF NOT EXISTS idx_operator_push_tenant ON tenant_operator_push_subs(tenant_id);
`);

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

// ── Device / session index (Profile → Devices) ───────────────────────────
// Turn a raw User-Agent into a short, human label + a device class. Kept
// deliberately small — enough to tell "Chrome on Windows" from "WeChat mini
// app · iPhone" at a glance, not a full UA-parsing library.
function describeUA(ua) {
  ua = String(ua || '');
  let os = 'Unknown device', kind = 'computer';
  if (/iPhone/i.test(ua))                 { os = 'iPhone';  kind = 'phone'; }
  else if (/iPad/i.test(ua))              { os = 'iPad';    kind = 'tablet'; }
  else if (/Android/i.test(ua))           { os = 'Android'; kind = /Mobile/i.test(ua) ? 'phone' : 'tablet'; }
  else if (/Windows/i.test(ua))           { os = 'Windows'; kind = 'computer'; }
  else if (/Mac OS X|Macintosh/i.test(ua)){ os = 'Mac';     kind = 'computer'; }
  else if (/Linux/i.test(ua))             { os = 'Linux';   kind = 'computer'; }

  let browser = '';
  if (/MicroMessenger/i.test(ua))         browser = 'WeChat';
  else if (/Edg\//i.test(ua))             browser = 'Edge';
  else if (/OPR\/|Opera/i.test(ua))       browser = 'Opera';
  else if (/Firefox\//i.test(ua))         browser = 'Firefox';
  else if (/Chrome\//i.test(ua))          browser = 'Chrome';
  else if (/Safari\//i.test(ua))          browser = 'Safari';

  const label = browser ? `${browser} on ${os}` : os;
  return { label, kind };
}

// Record (or refresh) the current session in the device index. Called on login
// and on each /me poll so pre-existing logins surface too. Best-effort: a hiccup
// here must never block auth.
function touchSession(req, user) {
  try {
    const sid = req.sessionID;
    if (!sid || !user) return;
    const ua = String(req.headers['user-agent'] || '').slice(0, 400);
    const ip = String(req.ip || req.headers['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 60);
    db.prepare(`INSERT INTO tenant_user_sessions (sid, tenant_user_id, tenant_id, user_agent, ip)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(sid) DO UPDATE SET
                  tenant_user_id = excluded.tenant_user_id,
                  tenant_id      = excluded.tenant_id,
                  user_agent     = COALESCE(NULLIF(excluded.user_agent, ''), tenant_user_sessions.user_agent),
                  ip             = COALESCE(NULLIF(excluded.ip, ''), tenant_user_sessions.ip),
                  last_seen      = CURRENT_TIMESTAMP`)
      .run(sid, user.id, user.tenant_id || null, ua, ip);
    dedupeSessions(user.id, sid);
  } catch (e) { /* index-only; never blocks auth */ }
}

// Collapse duplicate rows for the same operator + browser + IP down to the
// newest one. A "new device" in this table is really just a new session
// cookie — clearing cookies, an incognito window, or a stale un-revoked
// login all mint a fresh sid for what is physically the same machine. Keeps
// `currentSid` unconditionally so the active session never disappears mid-poll.
function dedupeSessions(tenantUserId, currentSid) {
  try {
    db.prepare(`
      DELETE FROM tenant_user_sessions
       WHERE tenant_user_id = ?
         AND sid != ?
         AND user_agent != '' AND ip != ''
         AND last_seen < (
           SELECT MAX(t2.last_seen) FROM tenant_user_sessions t2
            WHERE t2.tenant_user_id = tenant_user_sessions.tenant_user_id
              AND t2.user_agent     = tenant_user_sessions.user_agent
              AND t2.ip             = tenant_user_sessions.ip
         )`).run(tenantUserId, currentSid);
  } catch (e) { /* index-only; never blocks auth */ }
}

// ── Brute-force guard, same posture as the kitchen login ─────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many attempts, try again in 15 minutes · 尝试过于频繁,请 15 分钟后再试' },
});

router.post('/api/backend/login', loginLimiter, express.json(), async (req, res) => {
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

  // Two-step verification — password checked out, but a code is required before
  // the session is granted. Send it over the operator's chosen channel (email
  // to the recovery address, or SMS to the verified phone) and hold the pending
  // login on THIS browser session (bound by cookie). The full session
  // (backendUserId) is deliberately NOT set yet. If the preferred channel isn't
  // deliverable we fall back to the other verified one; if NEITHER can deliver,
  // we sign in password-only rather than lock the operator out (fail-open).
  if (u.twofa_enabled) {
    const emailOk = !!(u.recovery_email && u.recovery_email_verified && emailSender.isConfigured());
    const smsCreds = smsOtpCreds(u.tenant_id);
    const smsOk = !!(u.phone && u.phone_verified && aliyunSms.aliyunOtpEnabled(smsCreds));
    let channel = null;
    if (u.twofa_method === 'sms' && smsOk) channel = 'sms';
    else if (u.twofa_method === 'email' && emailOk) channel = 'email';
    else if (smsOk) channel = 'sms';
    else if (emailOk) channel = 'email';
    if (channel) {
      const code = genCode();
      req.session.pending2fa = { userId: u.id, remember: !!remember, at: Date.now() };
      if (channel === 'sms') {
        insertCode(u.id, 'login_2fa', u.phone, code, 10);
        try { await aliyunSms.sendOtpSms(u.phone, code, smsCreds); } catch (e) {}
        return res.json({ success: false, twofa: true, channel: 'sms', hint: maskPhone(u.phone) });
      }
      insertCode(u.id, 'login_2fa', u.recovery_email, code, 10);
      try { await emailSender.sendOtpEmail(u.recovery_email, code, null, emailBrandOpts(req, u.tenant_id)); } catch (e) {}
      return res.json({ success: false, twofa: true, channel: 'email', hint: maskEmail(u.recovery_email) });
    }
    // No deliverable channel — fall through to a normal password-only sign-in.
  }

  db.prepare('UPDATE tenant_users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(u.id);
  req.session.backendUserId = u.id;
  req.session.tenantId = u.tenant_id;
  // "Keep me signed in" — extend this operator's cookie to 30 days; otherwise
  // it stays at the global 8-hour default (lost when the browser closes the gap).
  req.session.cookie.maxAge = remember ? 30 * 24 * 60 * 60 * 1000 : 8 * 60 * 60 * 1000;
  touchSession(req, u);   // index this device for the Profile → Devices tab
  res.json({
    success: true,
    user: { id: u.id, username: u.username, displayName: u.display_name, role: u.role, avatarUrl: u.avatar_url || null,
            tenant: { id: tenant.id, name: tenant.name, brand: tenant.brand_name,
                      catalogMode: tenant.product_catalog_mode || 'self',
                      entitlements: features.entitlements(tenant.features_json) } },
  });
});

// Two-step verification — second step. Consumes the pending login held on this
// browser session (set by /login after a correct password) + the emailed code.
router.post('/api/backend/login/2fa', loginLimiter, express.json(), (req, res) => {
  const pending = req.session && req.session.pending2fa;
  if (!pending || !pending.userId || (Date.now() - (pending.at || 0)) > 10 * 60 * 1000) {
    if (req.session) delete req.session.pending2fa;
    return res.json({ success: false, error: 'Your sign-in expired — please start again · 登录已过期,请重新开始', restart: true });
  }
  const code = String((req.body && req.body.code) || '').trim();
  if (!/^\d{6}$/.test(code)) return res.json({ success: false, error: 'Enter the 6-digit code · 请输入 6 位验证码' });
  const row = liveCode(pending.userId, 'login_2fa');
  if (!row) return res.json({ success: false, error: 'Code expired — please sign in again · 验证码已过期,请重新登录', restart: true });
  if (row.attempts >= 5) return res.json({ success: false, error: 'Too many tries — please sign in again · 尝试次数过多,请重新登录', restart: true });
  if (hashCode(code) !== row.code_hash) {
    db.prepare('UPDATE tenant_user_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return res.json({ success: false, error: 'Incorrect code · 验证码不正确' });
  }
  const u = db.prepare('SELECT * FROM tenant_users WHERE id = ? AND is_active = 1').get(pending.userId);
  const tenant = u && db.prepare('SELECT * FROM tenants WHERE id = ?').get(u.tenant_id);
  if (!u || !tenant || tenant.status !== 'active') return res.json({ success: false, error: 'This account is not active · 此账户未激活', restart: true });

  db.prepare('UPDATE tenant_user_codes SET used = 1 WHERE id = ?').run(row.id);
  db.prepare('UPDATE tenant_users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(u.id);
  req.session.backendUserId = u.id;
  req.session.tenantId = u.tenant_id;
  req.session.cookie.maxAge = pending.remember ? 30 * 24 * 60 * 60 * 1000 : 8 * 60 * 60 * 1000;
  delete req.session.pending2fa;
  touchSession(req, u);
  res.json({
    success: true,
    user: { id: u.id, username: u.username, displayName: u.display_name, role: u.role, avatarUrl: u.avatar_url || null,
            tenant: { id: tenant.id, name: tenant.name, brand: tenant.brand_name,
                      catalogMode: tenant.product_catalog_mode || 'self',
                      entitlements: features.entitlements(tenant.features_json) } },
  });
});

router.post('/api/backend/logout', (req, res) => {
  try { if (req.sessionID) db.prepare('DELETE FROM tenant_user_sessions WHERE sid = ?').run(req.sessionID); } catch (e) {}
  if (req.session) { delete req.session.backendUserId; delete req.session.tenantId; }
  res.json({ success: true });
});

router.get('/api/backend/me', (req, res) => {
  if (!req.session || !req.session.backendUserId) return res.json({ user: null });
  const u = db.prepare('SELECT id, tenant_id, username, display_name, role, last_login, avatar_url, retail_store_id, scope_all FROM tenant_users WHERE id = ? AND is_active = 1').get(req.session.backendUserId);
  if (!u) return res.json({ user: null });
  touchSession(req, u);   // keep the Devices index warm (surfaces pre-existing logins + heartbeat)
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
  const brandStamp = tenant && tenant.brand_updated_at ? +new Date(tenant.brand_updated_at) : 0;
  res.json({
    user: { id: u.id, username: u.username, displayName: u.display_name, role: u.role, lastLogin: u.last_login, avatarUrl: u.avatar_url || null,
            caps, scopeStores,
            tenant: tenant ? { id: tenant.id, name: tenant.name, brand: tenant.brand_name, accent: tenant.brand_accent || null, status: tenant.status, catalogMode: tenant.product_catalog_mode || 'self', entitlements: features.entitlements(tenant.features_json),
            // Co-brand identity — logo/mark served as bytes (kept out of this payload);
            // ?v= busts the cache when the logo changes. brandCredit gates the credit line.
            brandLogoUrl: tenant.brand_logo_data ? `/api/backend/brand/${tenant.id}/logo?v=${brandStamp}` : null,
            brandMarkUrl: tenant.brand_mark_data ? `/api/backend/brand/${tenant.id}/mark?v=${brandStamp}` : null,
            brandCredit: tenant.brand_credit !== 0 } : null },
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

// Fan a live "identity changed" nudge to this operator's OTHER open sessions so
// the topbar name / avatar update without a refresh (reference/live-updates-spec.md).
// Scoped to the operator's own userId. Best-effort — the DB write has already
// committed, so a failure here must never surface to the caller. Lazily requires
// routes/retail so there's no load-order / circular dependency at startup.
function bumpBackendIdentity(req) {
  try {
    const uid = req.session && req.session.backendUserId;
    if (!uid) return;
    const tenantId = (req.session && req.session.tenantId)
      || (db.prepare('SELECT tenant_id FROM tenant_users WHERE id = ?').get(uid) || {}).tenant_id;
    if (!tenantId) return;
    require('./retail').retailLiveBump(tenantId, 'identity', { scope: { userId: uid }, ids: [uid] });
  } catch (e) { /* live push is best-effort */ }
}

// Edit own profile. Only the display name is self-editable; username, role and
// tenant are login identity / admin-assigned and stay read-only.
router.put('/api/backend/profile', express.json(), (req, res) => {
  if (!req.session?.backendUserId) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  const name = String((req.body && req.body.display_name) || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required · 名称必填' });
  if (name.length > 60) return res.status(400).json({ error: 'Name is too long · 名称过长' });
  db.prepare('UPDATE tenant_users SET display_name = ? WHERE id = ?').run(name, req.session.backendUserId);
  bumpBackendIdentity(req);
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
    bumpBackendIdentity(req);
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
  bumpBackendIdentity(req);
  res.json({ success: true, avatarUrl: avatar });
});

// ── Co-brand identity ────────────────────────────────────────────────────
// Brand assets are NOT sensitive — they're shown to customers on receipts,
// emails and the storefront by design — so the read endpoints are public and
// keyed by tenant id. That lets pre-auth surfaces (the sign-in page, the
// favicon, customer emails) load them without a session. Writes stay gated.
let _brandSharp = null;
try { _brandSharp = require('sharp'); } catch (e) { /* thumbnails degrade to the logo as-is */ }

function serveBrandImage(col) {
  return (req, res) => {
    const id = parseInt(req.params.tenantId, 10);
    if (!(id > 0)) return res.status(404).end();
    let data = null;
    try { const r = db.prepare(`SELECT ${col} AS d FROM tenants WHERE id = ?`).get(id); data = r && r.d; }
    catch (e) { return res.status(404).end(); }
    if (!data) return res.status(404).end();
    const m = /^data:([^;,]*?)(;base64)?,([\s\S]*)$/.exec(String(data));
    if (!m) return res.redirect(String(data));            // plain URL fallback
    res.set('Content-Type', m[1] || 'application/octet-stream');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8'));
  };
}
router.get('/api/backend/brand/:tenantId/logo', serveBrandImage('brand_logo_data'));
router.get('/api/backend/brand/:tenantId/mark', serveBrandImage('brand_mark_data'));

function brandPayload(t) {
  const stamp = t.brand_updated_at ? +new Date(t.brand_updated_at) : 0;
  return {
    name: t.brand_name || null,
    brandLogoUrl: t.brand_logo_data ? `/api/backend/brand/${t.id}/logo?v=${stamp}` : null,
    brandMarkUrl: t.brand_mark_data ? `/api/backend/brand/${t.id}/mark?v=${stamp}` : null,
    brandCredit: t.brand_credit !== 0,
  };
}

// Set / clear the tenant's brand — owner or admin only. Body: { name?, logo?, credit? }.
//   name  — brand text (≤60 chars); '' clears it.
//   logo  — data-URL of the primary logo; null/'' clears both logo and mark.
//           The square mark is auto-derived with sharp (contain onto a 256px
//           transparent canvas); if sharp is unavailable the logo is reused as-is.
//   credit — IGNORED here. The "runs on tacet" credit is platform-controlled
//            (white-label is a plan grant), so a tenant can never remove it.
router.put('/api/backend/brand', express.json({ limit: '4mb' }), async (req, res) => {
  if (!req.session?.backendUserId) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  const u = db.prepare('SELECT tenant_id, role FROM tenant_users WHERE id = ? AND is_active = 1').get(req.session.backendUserId);
  if (!u) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  if (u.role !== 'owner' && u.role !== 'admin') {
    return res.status(403).json({ error: 'Only an owner or admin can change the brand · 仅负责人或管理员可修改品牌' });
  }
  const b = req.body || {};

  if (b.name !== undefined) {
    const name = String(b.name || '').trim().slice(0, 60);
    db.prepare('UPDATE tenants SET brand_name = ? WHERE id = ?').run(name || null, u.tenant_id);
  }

  if (b.logo !== undefined) {
    if (b.logo === null || b.logo === '') {
      db.prepare('UPDATE tenants SET brand_logo_data = NULL, brand_mark_data = NULL WHERE id = ?').run(u.tenant_id);
    } else {
      const logo = String(b.logo);
      if (!/^data:image\/(png|jpe?g|webp|svg\+xml);base64,/i.test(logo)) {
        return res.status(400).json({ error: 'Logo must be a PNG, JPEG, WebP or SVG image · 徽标须为 PNG、JPEG、WebP 或 SVG 图片' });
      }
      if (logo.length > 3 * 1024 * 1024) {
        return res.status(413).json({ error: 'Logo is too large — please use a smaller file · 徽标过大,请使用更小的文件' });
      }
      // Derive the square mark (favicon + folded rail) from the logo, and trim
      // any baked-in canvas padding from the logo itself first — exported logo
      // files commonly sit on an oversized white/transparent canvas, and every
      // consumer (rail, favicon, account menu) sizes the image by height, so
      // untrimmed padding shrinks the visible artwork down to near-nothing.
      let mark = logo;
      let storedLogo = logo;
      const mm = /^data:([^;,]*?);base64,([\s\S]*)$/.exec(logo);
      if (_brandSharp && mm && !/svg/i.test(mm[1])) {
        try {
          const rawBuf = Buffer.from(mm[2], 'base64');
          const { data: corner } = await _brandSharp(rawBuf)
            .extract({ left: 0, top: 0, width: 1, height: 1 }).raw().ensureAlpha()
            .toBuffer({ resolveWithObject: true });
          const bg = { r: corner[0], g: corner[1], b: corner[2], alpha: corner[3] / 255 };
          const trimmedBuf = await _brandSharp(rawBuf).trim({ background: bg, threshold: 15 }).png().toBuffer();
          storedLogo = 'data:image/png;base64,' + trimmedBuf.toString('base64');
          const png = await _brandSharp(trimmedBuf)
            .resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png().toBuffer();
          mark = 'data:image/png;base64,' + png.toString('base64');
        } catch (e) { mark = logo; storedLogo = logo; }   // fall back to the logo as-is
      }
      db.prepare('UPDATE tenants SET brand_logo_data = ?, brand_mark_data = ? WHERE id = ?').run(storedLogo, mark, u.tenant_id);
    }
  }

  db.prepare("UPDATE tenants SET brand_updated_at = datetime('now') WHERE id = ?").run(u.tenant_id);
  const t = db.prepare('SELECT id, brand_name, brand_logo_data, brand_mark_data, brand_credit, brand_updated_at FROM tenants WHERE id = ?').get(u.tenant_id);
  res.json({ success: true, brand: brandPayload(t) });
});

// Read the tenant's current brand (for the setup page to hydrate its form).
router.get('/api/backend/brand', (req, res) => {
  if (!req.session?.backendUserId) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  const u = db.prepare('SELECT tenant_id FROM tenant_users WHERE id = ? AND is_active = 1').get(req.session.backendUserId);
  if (!u) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  const t = db.prepare('SELECT id, brand_name, brand_logo_data, brand_mark_data, brand_credit, brand_updated_at FROM tenants WHERE id = ?').get(u.tenant_id);
  res.json({ success: true, brand: t ? brandPayload(t) : null });
});

// ── Profile → Devices ─────────────────────────────────────────────────────
// List this operator's signed-in devices (their own sessions only), newest
// activity first, with the current one flagged. Stale rows (past the 30-day
// cookie ceiling) are pruned on read so a long-dead device doesn't linger.
router.get('/api/backend/sessions', (req, res) => {
  if (!req.session?.backendUserId) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  try {
    db.prepare("DELETE FROM tenant_user_sessions WHERE last_seen < datetime('now', '-31 days')").run();
  } catch (e) {}
  dedupeSessions(req.session.backendUserId, req.sessionID);
  let rows = [];
  try {
    rows = db.prepare(`SELECT sid, user_agent, ip, created_at, last_seen
                         FROM tenant_user_sessions
                        WHERE tenant_user_id = ?
                        ORDER BY last_seen DESC`).all(req.session.backendUserId);
  } catch (e) { rows = []; }
  const sessions = rows.map(r => {
    const d = describeUA(r.user_agent);
    return {
      id: r.sid,
      current: r.sid === req.sessionID,
      label: d.label,
      kind: d.kind,
      ip: r.ip || null,
      lastSeen: r.last_seen,
      createdAt: r.created_at,
    };
  });
  res.json({ sessions });
});

// Owner/admin only: every operator's sessions across the whole tenant, so an
// owner can see (and sign out) a teammate's device. Same shape + pruning as
// the personal list above, plus who each session belongs to.
router.get('/api/backend/sessions/team', (req, res) => {
  if (!req.session?.backendUserId) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  const me = db.prepare('SELECT tenant_id, role FROM tenant_users WHERE id = ? AND is_active = 1').get(req.session.backendUserId);
  if (!me) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  if (me.role !== 'owner' && me.role !== 'admin') {
    return res.status(403).json({ error: 'Only an owner or admin can view team devices · 仅负责人或管理员可查看团队设备' });
  }
  try {
    db.prepare("DELETE FROM tenant_user_sessions WHERE last_seen < datetime('now', '-31 days')").run();
  } catch (e) {}
  let rows = [];
  try {
    rows = db.prepare(`SELECT s.sid, s.tenant_user_id, s.user_agent, s.ip, s.created_at, s.last_seen,
                              u.display_name, u.username
                         FROM tenant_user_sessions s
                         JOIN tenant_users u ON u.id = s.tenant_user_id
                        WHERE s.tenant_id = ? AND u.is_active = 1
                        ORDER BY s.last_seen DESC`).all(me.tenant_id);
  } catch (e) { rows = []; }
  const sessions = rows.map(r => {
    const d = describeUA(r.user_agent);
    return {
      id: r.sid,
      current: r.sid === req.sessionID,
      label: d.label,
      kind: d.kind,
      ip: r.ip || null,
      lastSeen: r.last_seen,
      createdAt: r.created_at,
      ownerId: r.tenant_user_id,
      ownerName: r.display_name || r.username,
      isYou: r.tenant_user_id === req.session.backendUserId,
    };
  });
  res.json({ sessions });
});

// Sign a device out. A user may always revoke their OWN sessions; an owner
// or admin may also revoke any device belonging to their tenant (e.g. from
// the Team devices view). Revoking your own current one is allowed (it's
// just "sign out here"); the client then bounces to the login page.
router.post('/api/backend/sessions/revoke', express.json(), (req, res) => {
  if (!req.session?.backendUserId) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  const me = db.prepare('SELECT tenant_id, role FROM tenant_users WHERE id = ? AND is_active = 1').get(req.session.backendUserId);
  if (!me) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  const sid = String((req.body && req.body.sid) || '').trim();
  if (!sid) return res.status(400).json({ error: 'Missing session · 缺少会话' });
  let row = db.prepare('SELECT sid, tenant_user_id FROM tenant_user_sessions WHERE sid = ? AND tenant_user_id = ?').get(sid, req.session.backendUserId);
  if (!row && (me.role === 'owner' || me.role === 'admin')) {
    row = db.prepare('SELECT sid, tenant_user_id FROM tenant_user_sessions WHERE sid = ? AND tenant_id = ?').get(sid, me.tenant_id);
  }
  if (!row) return res.status(404).json({ error: 'Session not found · 未找到会话' });
  const finish = () => {
    try { db.prepare('DELETE FROM tenant_user_sessions WHERE sid = ?').run(sid); } catch (e) {}
    res.json({ success: true, wasCurrent: sid === req.sessionID });
  };
  if (req.sessionStore && typeof req.sessionStore.destroy === 'function') {
    req.sessionStore.destroy(sid, () => finish());
  } else { finish(); }
});

// Sign out every OTHER device — keep only the one making this request.
router.post('/api/backend/sessions/revoke-others', (req, res) => {
  if (!req.session?.backendUserId) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  let others = [];
  try {
    others = db.prepare('SELECT sid FROM tenant_user_sessions WHERE tenant_user_id = ? AND sid != ?')
      .all(req.session.backendUserId, req.sessionID).map(r => r.sid);
  } catch (e) { others = []; }
  let done = 0;
  const after = () => {
    if (++done < others.length) return;
    try { db.prepare('DELETE FROM tenant_user_sessions WHERE tenant_user_id = ? AND sid != ?').run(req.session.backendUserId, req.sessionID); } catch (e) {}
    res.json({ success: true, revoked: others.length });
  };
  if (!others.length) return res.json({ success: true, revoked: 0 });
  const canDestroy = req.sessionStore && typeof req.sessionStore.destroy === 'function';
  others.forEach(sid => { if (canDestroy) req.sessionStore.destroy(sid, after); else after(); });
});

// ── Profile → Access ──────────────────────────────────────────────────────
// A plain-language, read-only summary of what this operator can do — resolved
// from the same capability engine the app gates on. Owners get a short
// "full access" note; everyone else gets their granted capabilities grouped by
// area (Running the shop / Selling / Content / Set up).
const _caps = require('../lib/capabilities');
const ACCESS_GROUPS = [
  ['run',     'Running the shop'],
  ['sell',    'Selling & marketing'],
  ['content', 'Content & inbox'],
  ['setup',   'Set up & admin'],
];
router.get('/api/backend/access', (req, res) => {
  if (!req.session?.backendUserId) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  const u = db.prepare('SELECT id, tenant_id, role, retail_store_id, scope_all FROM tenant_users WHERE id = ? AND is_active = 1').get(req.session.backendUserId);
  if (!u) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(u.tenant_id);
  let caps = [], scopeStores = null;
  try {
    const r = require('../lib/operator-caps').resolveOperator(db, u, tenant);
    caps = r.caps || []; scopeStores = r.scopeStores;
  } catch (e) { caps = []; }
  const roleLabel = ({ owner: 'Owner', admin: 'Admin', staff: 'Staff', store_manager: 'Store manager',
    warehouse: 'Warehouse', customer_service: 'Customer service', dispatch: 'Dispatch', manager: 'Manager',
    marketing: 'Marketing', fulfillment: 'Fulfilment', channel: 'Channel operator' })[u.role] || (u.role || 'Operator');

  if (u.role === 'owner') {
    return res.json({ owner: true, role: u.role, roleLabel, groups: [], scopeStores: null });
  }
  const have = new Set(caps);
  const groups = ACCESS_GROUPS.map(([g, title]) => {
    const items = _caps.CAPABILITIES.filter(c => c.group === g && have.has(c.key)).map(c => c.labelEn);
    return items.length ? { title, items } : null;
  }).filter(Boolean);
  res.json({ owner: false, role: u.role, roleLabel, groups, scopeStores: scopeStores || null });
});

// ── Recovery email + forgotten-password reset ─────────────────────────────
const CODE_PEPPER = process.env.SESSION_SECRET || 'tacet-code-pepper';
function genCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }
function hashCode(code) { return crypto.createHmac('sha256', CODE_PEPPER).update(String(code)).digest('hex'); }
function validEmail(e) { return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 190; }
function maskEmail(e) {
  if (!e) return null;
  var at = e.indexOf('@'); if (at < 1) return e;
  var name = e.slice(0, at), dom = e.slice(at);
  return name[0] + '****' + dom;
}
// Mask a mobile for display — keep the first 3 and last 2 digits (e.g. 138****01).
function maskPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length < 6) return p || null;
  return d.slice(0, 3) + '****' + d.slice(-2);
}
// Per-tenant Aliyun SMS creds + whether the login-OTP template is wired. SMS
// two-step is only offered when this returns true for the operator's tenant.
function smsOtpCreds(tenantId) {
  try { return (getTenantCreds(tenantId).integrations || {}).aliyun_sms || null; }
  catch (e) { return null; }
}
function smsOtpConfigured(tenantId) {
  return aliyunSms.aliyunOtpEnabled(smsOtpCreds(tenantId));
}
// Branding for the code email (co-brand when the tenant has a name/mark).
function emailBrandOpts(req, tenantId) {
  try {
    const t = db.prepare('SELECT brand_name, brand_mark_data FROM tenants WHERE id = ?').get(tenantId);
    if (!t) return {};
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
    return {
      brand: t.brand_name || '',
      logoUrl: t.brand_mark_data && host ? `${proto}://${host}/api/backend/brand/${tenantId}/mark` : '',
    };
  } catch (e) { return {}; }
}
function insertCode(userId, purpose, email, code, minutes) {
  db.prepare(`INSERT INTO tenant_user_codes (tenant_user_id, purpose, email, code_hash, expires_at)
              VALUES (?, ?, ?, ?, datetime('now', ?))`)
    .run(userId, purpose, email || null, hashCode(code), '+' + (minutes || 15) + ' minutes');
}
// Latest live (unused, unexpired) code for a user+purpose. Returns the row or null.
function liveCode(userId, purpose) {
  return db.prepare(`SELECT * FROM tenant_user_codes
                       WHERE tenant_user_id = ? AND purpose = ? AND used = 0 AND expires_at > datetime('now')
                       ORDER BY id DESC LIMIT 1`).get(userId, purpose);
}

// Throttle code sends + reset attempts (per IP). Same posture as login.
const codeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false,
  message: { success: false, error: 'Too many attempts, try again later · 尝试过于频繁,请稍后再试' } });

// Current contact (email + phone) + 2FA state for the signed-in operator.
// Backs both My Info (email/phone) and Security (two-step) in the account pop-up.
router.get('/api/backend/recovery', (req, res) => {
  if (!req.session?.backendUserId) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  const u = db.prepare('SELECT tenant_id, recovery_email, recovery_email_verified, phone, phone_verified, twofa_enabled, twofa_method FROM tenant_users WHERE id = ?').get(req.session.backendUserId);
  res.json({
    email: u && u.recovery_email ? maskEmail(u.recovery_email) : null,
    verified: !!(u && u.recovery_email_verified),
    phone: u && u.phone ? maskPhone(u.phone) : null,
    phoneVerified: !!(u && u.phone_verified),
    twofaEnabled: !!(u && u.twofa_enabled),
    twofaMethod: (u && u.twofa_method) || 'email',
    emailConfigured: emailSender.isConfigured(),
    smsConfigured: smsOtpConfigured(u && u.tenant_id),
  });
});

// ── Two-step verification management ──────────────────────────────────────
// Enabling requires a VERIFIED channel — the recovery email (default) or the
// verified phone (method:'sms'). We send a code over that channel and confirm
// it so we know delivery works before turning 2FA on.
router.post('/api/backend/twofa/enable/start', codeLimiter, express.json(), async (req, res) => {
  if (!req.session?.backendUserId) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  const method = (req.body && req.body.method) === 'sms' ? 'sms' : 'email';
  const u = db.prepare('SELECT tenant_id, recovery_email, recovery_email_verified, phone, phone_verified FROM tenant_users WHERE id = ?').get(req.session.backendUserId);
  if (!u) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  const code = genCode();
  if (method === 'sms') {
    if (!u.phone || !u.phone_verified) return res.status(400).json({ error: 'Add a verified phone first · 请先设置并验证手机号' });
    const creds = smsOtpCreds(u.tenant_id);
    if (!aliyunSms.aliyunOtpEnabled(creds)) return res.status(503).json({ error: 'SMS isn’t set up on this workspace · 此工作区未启用短信' });
    insertCode(req.session.backendUserId, 'twofa_enable', u.phone, code, 15);
    const r = await aliyunSms.sendOtpSms(u.phone, code, creds);
    if (!r.ok) return res.status(502).json({ error: 'Couldn’t send the code — please try again · 验证码发送失败,请重试' });
    return res.json({ success: true, method: 'sms', hint: maskPhone(u.phone) });
  }
  if (!u.recovery_email || !u.recovery_email_verified) return res.status(400).json({ error: 'Add a verified recovery email first · 请先设置并验证恢复邮箱' });
  if (!emailSender.isConfigured()) return res.status(503).json({ error: 'Email isn’t set up yet · 邮件功能尚未配置' });
  insertCode(req.session.backendUserId, 'twofa_enable', u.recovery_email, code, 15);
  const r = await emailSender.sendOtpEmail(u.recovery_email, code, null, emailBrandOpts(req, u.tenant_id));
  if (!r.ok) return res.status(502).json({ error: 'Couldn’t send the email — please try again · 邮件发送失败,请重试' });
  res.json({ success: true, method: 'email', hint: maskEmail(u.recovery_email) });
});
router.post('/api/backend/twofa/enable/confirm', codeLimiter, express.json(), (req, res) => {
  if (!req.session?.backendUserId) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  const method = (req.body && req.body.method) === 'sms' ? 'sms' : 'email';
  const code = String((req.body && req.body.code) || '').trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code · 请输入 6 位验证码' });
  const row = liveCode(req.session.backendUserId, 'twofa_enable');
  if (!row) return res.status(400).json({ error: 'Code expired — request a new one · 验证码已过期,请重新获取' });
  if (row.attempts >= 5) return res.status(429).json({ error: 'Too many tries — request a new code · 尝试次数过多,请重新获取' });
  if (hashCode(code) !== row.code_hash) {
    db.prepare('UPDATE tenant_user_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return res.status(400).json({ error: 'Incorrect code · 验证码不正确' });
  }
  // Re-check the channel is still verified before trusting it as the 2FA route.
  const u = db.prepare('SELECT recovery_email_verified, phone_verified FROM tenant_users WHERE id = ?').get(req.session.backendUserId);
  if (method === 'sms' && !(u && u.phone_verified)) return res.status(400).json({ error: 'Verify a phone first · 请先验证手机号' });
  if (method === 'email' && !(u && u.recovery_email_verified)) return res.status(400).json({ error: 'Verify a recovery email first · 请先验证恢复邮箱' });
  db.prepare('UPDATE tenant_user_codes SET used = 1 WHERE id = ?').run(row.id);
  db.prepare('UPDATE tenant_users SET twofa_enabled = 1, twofa_method = ? WHERE id = ?').run(method, req.session.backendUserId);
  res.json({ success: true, method });
});
router.post('/api/backend/twofa/disable', (req, res) => {
  if (!req.session?.backendUserId) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  db.prepare('UPDATE tenant_users SET twofa_enabled = 0 WHERE id = ?').run(req.session.backendUserId);
  res.json({ success: true });
});

// ── Operator Web Push (Profile → Notifications) ───────────────────────────
const _push = require('./push');
router.get('/api/backend/push/vapid', (req, res) => {
  res.json({ enabled: !!_push.ENABLED, publicKey: _push.vapidPublicKey || '' });
});
router.post('/api/backend/push/subscribe', express.json(), (req, res) => {
  if (!req.session?.backendUserId) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  const { endpoint, keys } = req.body || {};
  const r = _push.operatorSubscribe({ tenantUserId: req.session.backendUserId, tenantId: req.session.tenantId, endpoint, keys, ua: req.headers['user-agent'] });
  if (!r.ok) return res.status(r.error === 'push not configured' ? 503 : 400).json({ error: r.error || 'Couldn’t subscribe' });
  res.json({ success: true });
});
router.post('/api/backend/push/unsubscribe', express.json(), (req, res) => {
  if (!req.session?.backendUserId) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  _push.operatorUnsubscribe((req.body && req.body.endpoint) || '', req.session.backendUserId);
  res.json({ success: true });
});
router.post('/api/backend/push/test', async (req, res) => {
  if (!req.session?.backendUserId) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  const r = await _push.sendPushToOperator(req.session.backendUserId, {
    title: '🌿 Test notification · 测试通知',
    body: 'Push is working on this device. · 此设备的推送已生效。',
    url: '/retail-admin',
    tag: 'operator-test',
  });
  res.json({ success: true, sent: (r && r.sent) || 0 });
});

// Start setting a recovery email — emails a 6-digit verification code.
router.post('/api/backend/recovery/start', codeLimiter, express.json(), async (req, res) => {
  if (!req.session?.backendUserId) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email · 请输入有效邮箱' });
  if (!emailSender.isConfigured()) return res.status(503).json({ error: 'Email isn’t set up yet · 邮件功能尚未配置' });
  const code = genCode();
  insertCode(req.session.backendUserId, 'recovery_verify', email, code, 15);
  const opts = emailBrandOpts(req, req.session.tenantId);
  const r = await emailSender.sendOtpEmail(email, code, null, opts);
  if (!r.ok) return res.status(502).json({ error: 'Couldn’t send the email — please try again · 邮件发送失败,请重试' });
  res.json({ success: true, email: maskEmail(email) });
});

// Confirm the code → save + mark the recovery email verified.
router.post('/api/backend/recovery/confirm', codeLimiter, express.json(), (req, res) => {
  if (!req.session?.backendUserId) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  const code = String((req.body && req.body.code) || '').trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code · 请输入 6 位验证码' });
  const row = liveCode(req.session.backendUserId, 'recovery_verify');
  if (!row) return res.status(400).json({ error: 'Code expired — request a new one · 验证码已过期,请重新获取' });
  if (row.attempts >= 5) return res.status(429).json({ error: 'Too many tries — request a new code · 尝试次数过多,请重新获取' });
  if (hashCode(code) !== row.code_hash) {
    db.prepare('UPDATE tenant_user_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return res.status(400).json({ error: 'Incorrect code · 验证码不正确' });
  }
  db.prepare('UPDATE tenant_user_codes SET used = 1 WHERE id = ?').run(row.id);
  db.prepare('UPDATE tenant_users SET recovery_email = ?, recovery_email_verified = 1 WHERE id = ?').run(row.email, req.session.backendUserId);
  res.json({ success: true, email: maskEmail(row.email) });
});

// Remove the recovery email. If email is the channel 2FA relies on, turn 2FA
// off too — otherwise the operator would have no way to receive a sign-in code.
router.delete('/api/backend/recovery', (req, res) => {
  if (!req.session?.backendUserId) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  const u = db.prepare('SELECT twofa_enabled, twofa_method FROM tenant_users WHERE id = ?').get(req.session.backendUserId);
  const killTwofa = !!(u && u.twofa_enabled && u.twofa_method === 'email');
  db.prepare('UPDATE tenant_users SET recovery_email = NULL, recovery_email_verified = 0' + (killTwofa ? ', twofa_enabled = 0' : '') + ' WHERE id = ?').run(req.session.backendUserId);
  db.prepare("DELETE FROM tenant_user_codes WHERE tenant_user_id = ? AND purpose = 'recovery_verify'").run(req.session.backendUserId);
  res.json({ success: true, twofaDisabled: killTwofa });
});

// ── Phone (SMS) — verify a mobile for SMS two-step verification ────────────
// Mirrors the recovery-email flow, but the code is sent by SMS (Aliyun). The
// pending number rides in tenant_user_codes.email (a generic target slot).
router.post('/api/backend/phone/start', codeLimiter, express.json(), async (req, res) => {
  if (!req.session?.backendUserId) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  const mobile = aliyunSms.normalizeCnMobile(String((req.body && req.body.phone) || '').trim());
  if (!mobile) return res.status(400).json({ error: 'Enter a valid mobile number · 请输入有效的手机号' });
  const creds = smsOtpCreds(req.session.tenantId);
  if (!aliyunSms.aliyunOtpEnabled(creds)) return res.status(503).json({ error: 'SMS isn’t set up on this workspace · 此工作区未启用短信' });
  const code = genCode();
  insertCode(req.session.backendUserId, 'phone_verify', mobile, code, 10);
  const r = await aliyunSms.sendOtpSms(mobile, code, creds);
  if (!r.ok) return res.status(502).json({ error: 'Couldn’t send the code — please try again · 验证码发送失败,请重试' });
  res.json({ success: true, phone: maskPhone(mobile) });
});
router.post('/api/backend/phone/confirm', codeLimiter, express.json(), (req, res) => {
  if (!req.session?.backendUserId) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  const code = String((req.body && req.body.code) || '').trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code · 请输入 6 位验证码' });
  const row = liveCode(req.session.backendUserId, 'phone_verify');
  if (!row) return res.status(400).json({ error: 'Code expired — request a new one · 验证码已过期,请重新获取' });
  if (row.attempts >= 5) return res.status(429).json({ error: 'Too many tries — request a new code · 尝试次数过多,请重新获取' });
  if (hashCode(code) !== row.code_hash) {
    db.prepare('UPDATE tenant_user_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return res.status(400).json({ error: 'Incorrect code · 验证码不正确' });
  }
  db.prepare('UPDATE tenant_user_codes SET used = 1 WHERE id = ?').run(row.id);
  db.prepare('UPDATE tenant_users SET phone = ?, phone_verified = 1 WHERE id = ?').run(row.email, req.session.backendUserId);
  res.json({ success: true, phone: maskPhone(row.email) });
});
// Remove the phone. If SMS is the channel 2FA relies on, turn 2FA off too.
router.delete('/api/backend/phone', (req, res) => {
  if (!req.session?.backendUserId) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  const u = db.prepare('SELECT twofa_enabled, twofa_method FROM tenant_users WHERE id = ?').get(req.session.backendUserId);
  const killTwofa = !!(u && u.twofa_enabled && u.twofa_method === 'sms');
  db.prepare('UPDATE tenant_users SET phone = NULL, phone_verified = 0' + (killTwofa ? ', twofa_enabled = 0' : '') + ' WHERE id = ?').run(req.session.backendUserId);
  db.prepare("DELETE FROM tenant_user_codes WHERE tenant_user_id = ? AND purpose = 'phone_verify'").run(req.session.backendUserId);
  res.json({ success: true, twofaDisabled: killTwofa });
});

// ── Forgotten-password reset (pre-auth) ───────────────────────────────────
// Start: look up the username; if it has a VERIFIED recovery email, mail a
// reset code there. The response is ALWAYS generic so this can't be used to
// discover which usernames exist or who has recovery set up.
router.post('/api/backend/password-reset/start', codeLimiter, express.json(), async (req, res) => {
  const username = String((req.body && req.body.username) || '').trim().toLowerCase();
  const generic = { success: true };
  if (!username) return res.json(generic);
  const u = db.prepare('SELECT id, tenant_id, recovery_email, recovery_email_verified FROM tenant_users WHERE username = ? AND is_active = 1').get(username);
  if (!u || !u.recovery_email || !u.recovery_email_verified || !emailSender.isConfigured()) return res.json(generic);
  const code = genCode();
  insertCode(u.id, 'password_reset', u.recovery_email, code, 15);
  try { await emailSender.sendOtpEmail(u.recovery_email, code, null, emailBrandOpts(req, u.tenant_id)); } catch (e) {}
  res.json(generic);
});

// Confirm: verify the reset code + set the new password.
router.post('/api/backend/password-reset/confirm', codeLimiter, express.json(), (req, res) => {
  const username = String((req.body && req.body.username) || '').trim().toLowerCase();
  const code = String((req.body && req.body.code) || '').trim();
  const newPassword = (req.body && req.body.new_password) || '';
  if (!username || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the code from your email · 请输入邮件中的验证码' });
  if (!newPassword || newPassword.length < 10) return res.status(400).json({ error: 'New password must be at least 10 characters · 新密码至少需要 10 位' });
  const u = db.prepare('SELECT id FROM tenant_users WHERE username = ? AND is_active = 1').get(username);
  if (!u) return res.status(400).json({ error: 'Incorrect or expired code · 验证码不正确或已过期' });
  const row = liveCode(u.id, 'password_reset');
  if (!row) return res.status(400).json({ error: 'Code expired — request a new one · 验证码已过期,请重新获取' });
  if (row.attempts >= 5) return res.status(429).json({ error: 'Too many tries — request a new code · 尝试次数过多,请重新获取' });
  if (hashCode(code) !== row.code_hash) {
    db.prepare('UPDATE tenant_user_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return res.status(400).json({ error: 'Incorrect code · 验证码不正确' });
  }
  db.prepare('UPDATE tenant_user_codes SET used = 1 WHERE id = ?').run(row.id);
  db.prepare("UPDATE tenant_user_codes SET used = 1 WHERE tenant_user_id = ? AND purpose = 'password_reset'").run(u.id);
  db.prepare('UPDATE tenant_users SET password = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), u.id);
  res.json({ success: true });
});

module.exports = router;
