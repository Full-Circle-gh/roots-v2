// Platform staff realm — the people who run the SaaS (store-admin console).
//
// This is a THIRD, separate auth realm, distinct from both:
//   • kitchen `users`      (Roots' own staff — req.session.userId)
//   • tenant `tenant_users` (a merchant's operators — req.session.backendUserId)
//
// Platform staff manage EVERY tenant from store-admin.rootskitchenchina.com:
// onboarding new merchants, billing, suspending, support. Their session key is
// its own (req.session.platformAdminId) so a platform admin is never mistaken
// for a kitchen user or a tenant operator, and vice-versa.
//
// Roles → capabilities (the console hides what a role can't do; the server
// enforces it again here so a hand-crafted request can't escalate):
//   super    — everything (tenant lifecycle, billing, signups, staff, settings)
//   billing  — view + billing actions (invoices, plans, setup fees)
//   support  — view + signup/lead actions (the front line for new merchants)
//
// A kitchen `admin` session is accepted everywhere as an implicit super-admin,
// so the platform owner's existing login keeps full reach without a second
// account (and the legacy /saas-admin page keeps working unchanged).

const bcrypt = require('bcrypt');
const db = require('../database');

// ── Schema (idempotent) ─────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS platform_admins (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    username     TEXT NOT NULL UNIQUE,            -- lowercased login handle
    password     TEXT NOT NULL,                   -- bcrypt hash
    display_name TEXT,
    role         TEXT NOT NULL DEFAULT 'support', -- super | billing | support
    is_active    INTEGER NOT NULL DEFAULT 1,
    last_login   DATETIME,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Append-only trail of every consequential platform action (who suspended /
  -- provisioned / marked-paid / impersonated what, and when). Read-only in the
  -- console; never updated or deleted in normal operation.
  CREATE TABLE IF NOT EXISTS platform_audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_kind  TEXT NOT NULL,                    -- platform | kitchen
    actor_id    INTEGER,
    actor_name  TEXT,
    action      TEXT NOT NULL,                    -- e.g. tenant.suspend, invoice.mark_paid
    target_type TEXT,                             -- tenant | invoice | lead | staff | plan
    target_id   TEXT,
    meta_json   TEXT,                             -- small JSON blob of extra context
    ip          TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_platform_audit_created ON platform_audit_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_platform_audit_target ON platform_audit_log(target_type, target_id);
`);

const ROLES = ['super', 'billing', 'support'];

// Capability matrix. Keep this the single source of truth — the console reads
// the same map (served via /api/store-admin/me) to decide which buttons to show.
const ROLE_CAPS = {
  super:   ['view', 'tenant.manage', 'billing.write', 'signup.write', 'staff.manage', 'settings.write', 'impersonate', 'broadcast'],
  billing: ['view', 'billing.write'],
  support: ['view', 'signup.write', 'impersonate'],
};

function capsFor(role) { return ROLE_CAPS[role] || ROLE_CAPS.support; }
function roleHasCap(role, cap) { return !cap || capsFor(role).includes(cap); }

// ── Seed a first super-admin so the console is reachable on day one ───────
// Mirrors backend-auth's owner seed: a known default + a boot-time nag to
// rotate it. The platform owner changes this immediately from the console.
const DEFAULT_USERNAME = 'platform';
const DEFAULT_PASSWORD = 'StoreAdmin2026!';
function seedPlatformAdmin() {
  try {
    const count = db.prepare('SELECT COUNT(*) c FROM platform_admins').get().c;
    if (count === 0) {
      const hash = bcrypt.hashSync(DEFAULT_PASSWORD, 10);
      db.prepare("INSERT INTO platform_admins (username, password, display_name, role) VALUES (?,?,?,?)")
        .run(DEFAULT_USERNAME, hash, 'Platform Owner', 'super');
      console.log('[platform-admin] seeded super-admin (username: ' + DEFAULT_USERNAME + ') — ROTATE the default password.');
    }
    const owner = db.prepare("SELECT password FROM platform_admins WHERE username = ?").get(DEFAULT_USERNAME);
    if (owner && bcrypt.compareSync(DEFAULT_PASSWORD, owner.password)) {
      console.error('[platform-admin] WARNING — "' + DEFAULT_USERNAME + '" still uses the seeded password (' + DEFAULT_PASSWORD + '). Rotate it from the console.');
    }
  } catch (e) { console.error('[platform-admin] seed failed:', e.message); }
}
seedPlatformAdmin();

// ── Resolve the current actor (platform staff OR kitchen admin) ───────────
// Returns null when neither realm is authenticated. Kitchen admins are folded
// in as implicit super-admins so the owner's existing session keeps full reach.
function currentActor(req) {
  if (req.session?.platformAdminId) {
    const a = db.prepare('SELECT id, username, display_name, role, is_active FROM platform_admins WHERE id = ?').get(req.session.platformAdminId);
    if (a && a.is_active) {
      return { kind: 'platform', id: a.id, username: a.username, name: a.display_name || a.username, role: a.role };
    }
    // Stale cookie (deleted/deactivated) — clear it so the login form can take over.
    delete req.session.platformAdminId;
  }
  if (req.session?.userId) {
    const u = db.prepare('SELECT id, username, display_name, role FROM users WHERE id = ? AND is_active = 1').get(req.session.userId);
    if (u && u.role === 'admin') {
      const nm = u.display_name || u.username || ('user#' + u.id);
      return { kind: 'kitchen', id: u.id, username: u.username || nm, name: nm, role: 'super' };
    }
  }
  return null;
}

// ── Gate factory ─────────────────────────────────────────────────────────
// requirePlatformAdmin()            → any active platform staff (or kitchen admin)
// requirePlatformAdmin('billing.write') → only roles holding that capability
// Attaches req.platformActor for the route + audit logging.
function requirePlatformAdmin(cap) {
  return function (req, res, next) {
    const actor = currentActor(req);
    if (!actor) return res.status(401).json({ error: 'Platform login required · 需要平台登录' });
    if (!roleHasCap(actor.role, cap)) {
      return res.status(403).json({ error: 'Your role cannot perform this action · 您的角色无权执行此操作' });
    }
    req.platformActor = actor;
    next();
  };
}

// ── Append to the audit trail (best-effort; never throws into a route) ────
function logAudit(req, { action, targetType = null, targetId = null, meta = null } = {}) {
  try {
    const actor = req.platformActor || currentActor(req) || {};
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64);
    db.prepare(`INSERT INTO platform_audit_log (actor_kind, actor_id, actor_name, action, target_type, target_id, meta_json, ip)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(actor.kind || 'unknown', actor.id || null, actor.name || null, String(action),
           targetType, targetId != null ? String(targetId) : null,
           meta != null ? JSON.stringify(meta) : null, ip || null);
  } catch (e) { console.warn('[platform-admin] audit write failed:', e.message); }
}

module.exports = {
  ROLES, ROLE_CAPS, capsFor, roleHasCap,
  currentActor, requirePlatformAdmin, logAudit,
  DEFAULT_USERNAME, DEFAULT_PASSWORD,
};
