'use strict';

// Routed through the database seam (lib/db-seam.js). No converter is installed,
// so this is a zero-cost passthrough; the point is that this file is now on the
// covered side of the boundary. Proven by scripts/diagnose_seam_batch.js.
const { seam } = require('./db-seam');
const db = seam(require('../database'));
const capabilities = require('./capabilities');
const roles = require('./roles');
const { resolveOperator } = require('./operator-caps');
const { schemaNotReady } = require('./sqlite-errors');

// Session + DB row for the signed-in backend operator, or null. Re-read on
// every request (no role in the session) so a revoked/demoted user can't
// coast on a stale cookie.
function loadCaller(req) {
  if (!req.session?.backendUserId || !req.session?.tenantId) return null;
  const user = db.prepare(
    'SELECT id, tenant_id, role, retail_store_id, scope_all, is_active FROM tenant_users WHERE id = ? AND tenant_id = ?'
  ).get(req.session.backendUserId, req.session.tenantId);
  if (!user || !user.is_active) return null;
  // roles_version comes back with features_json — it is what lets resolveOperator
  // check the role cache without a query of its own.
  /* NARROWED 2026-09-16 (§151). Both catches here swallowed everything, and
     what they are FOR is a pre-roles_version database — a missing column, on a
     schema that predates the feature. A locked database went the same way, and
     the cost is not a 500 avoided: `tenant` stays null, resolveOperator falls
     back to the shipped preset instead of this tenant's OWN edited role, and
     the request is then allowed or refused on capabilities nobody granted. A
     silently wrong permission decision is worse than a failed one, so anything
     that is not a schema gap is now raised. */
  let tenant = null;
  try { tenant = db.prepare('SELECT id, features_json, roles_version FROM tenants WHERE id = ?').get(req.session.tenantId); }
  catch (e) {
    if (!schemaNotReady(e)) throw e;
    // Pre-roles_version database — read what is certainly there. A missing
    // version simply means lib/roles.js looks it up itself.
    try { tenant = db.prepare('SELECT id, features_json FROM tenants WHERE id = ?').get(req.session.tenantId); }
    catch (e2) { if (!schemaNotReady(e2)) throw e2; }
  }
  const { caps, scopeStores } = resolveOperator(db, user, tenant);
  return { user, caps: new Set(caps), scopeStores };
}

// Session-only gate — for routes with no per-capability requirement.
function requireBackend(req, res, next) {
  if (!req.session?.backendUserId || !req.session?.tenantId) {
    return res.status(401).json({ error: 'Not authenticated · 未登录' });
  }
  next();
}

// Session + capability gate. cap: a capability key, or an array (any-of).
// Owner always passes (resolveOperator resolves owner to ALL caps).
// Attaches req.backendCaps (Set) + req.backendRole for handlers that need a
// finer privilege comparison (e.g. "can't grant a role above your own").
function requireCap(cap) {
  const need = Array.isArray(cap) ? cap : [cap];
  return function (req, res, next) {
    const caller = loadCaller(req);
    if (!caller) return res.status(401).json({ error: 'Not authenticated · 未登录' });
    if (!need.some(k => caller.caps.has(k))) {
      return res.status(403).json({ error: 'You don’t have permission for this · 你没有此操作的权限' });
    }
    req.backendCaps = caller.caps;
    req.backendRole = caller.user.role;
    next();
  };
}

// True if granting `role` would hand the recipient a capability the caller
// doesn't hold themselves — i.e. creating/promoting to `role` is escalation.
//
// TENANT-AWARE, and it has to be. Once a tenant can edit what a role reaches,
// a guard that measures against the shipped literal is not a guard: edit "Shop
// floor" up to near-owner and a caller holding the original nine capabilities
// would still be waved through to hand it out. So this reads the tenant's OWN
// definition, through the same cache as everything else, and only falls back to
// presetCapsFor for a tenant that has no record — where the literal IS the
// definition and the old answer is the right one.
function roleAboveCaps(tenantId, role, callerCaps) {
  let base = null;
  try { base = roles.capsForRole(tenantId, role); } catch (e) { base = null; }
  if (!base) base = capabilities.presetCapsFor(role);
  return base.some(k => !callerCaps.has(k));
}

/* §325 (S2l) — BILLING, on the keys that open the screens that use it
 * (lib/cap-routes.js billingCap: billing:view or billing:pay), with the two
 * doors that reach the desktop Billing page WITHOUT a key kept open, because
 * shutting them would take paying away from people who can pay today:
 *   • a shop that is not active (suspended for non-payment) — server.js
 *     serveRetailAdmin sends EVERY operator of it to /backend/billing to pay;
 *   • the provisioning hold — until TENANT_DATA_ISOLATION=1, every operator of
 *     a tenant other than Roots is sent to /backend/billing?provisioning=1.
 * Whether those doors should stay keyless is Ash's call, not this gate's. */
function billingKeylessDoor(tenantId) {
  const tenantDb = require('./tenant-db');
  if (!tenantDb.DATA_ISOLATION_READY && tenantId !== tenantDb.ROOTS_TENANT_ID) return true;
  try {
    const t = db.prepare('SELECT status FROM tenants WHERE id = ?').get(tenantId);
    return !!(t && t.status && t.status !== 'active');
  } catch (e) {
    if (!schemaNotReady(e)) throw e;
    return false;
  }
}
function requireBillingAccess(req, res, next) {
  const caller = loadCaller(req);
  if (!caller) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  const need = require('./cap-routes').billingCap();
  if (need.some(k => caller.caps.has(k)) || billingKeylessDoor(caller.user.tenant_id)) {
    req.backendCaps = caller.caps;
    req.backendRole = caller.user.role;
    return next();
  }
  return res.status(403).json({ error: 'You don’t have permission for this · 你没有此操作的权限' });
}

module.exports = { requireBackend, requireCap, roleAboveCaps, loadCaller, requireBillingAccess, billingKeylessDoor };
