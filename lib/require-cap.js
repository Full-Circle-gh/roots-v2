'use strict';

// Routed through the database seam (lib/db-seam.js). No converter is installed,
// so this is a zero-cost passthrough; the point is that this file is now on the
// covered side of the boundary. Proven by scripts/diagnose_seam_batch.js.
const { seam } = require('./db-seam');
const db = seam(require('../database'));
const capabilities = require('./capabilities');
const { resolveOperator } = require('./operator-caps');

// Session + DB row for the signed-in backend operator, or null. Re-read on
// every request (no role in the session) so a revoked/demoted user can't
// coast on a stale cookie.
function loadCaller(req) {
  if (!req.session?.backendUserId || !req.session?.tenantId) return null;
  const user = db.prepare(
    'SELECT id, role, retail_store_id, scope_all, is_active FROM tenant_users WHERE id = ? AND tenant_id = ?'
  ).get(req.session.backendUserId, req.session.tenantId);
  if (!user || !user.is_active) return null;
  let tenant = null;
  try { tenant = db.prepare('SELECT features_json FROM tenants WHERE id = ?').get(req.session.tenantId); } catch (e) {}
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
function roleAboveCaps(role, callerCaps) {
  return capabilities.presetCapsFor(role).some(k => !callerCaps.has(k));
}

module.exports = { requireBackend, requireCap, roleAboveCaps, loadCaller };
