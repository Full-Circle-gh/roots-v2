// Routed through the database seam (lib/db-seam.js). No converter is installed,
// so this is a zero-cost passthrough; the point is that this file is now on the
// covered side of the boundary. Proven by scripts/diagnose_seam_statements.js.
const { seam } = require('../lib/db-seam');
const db = seam(require('../database'));

function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
    return res.redirect('/login');
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(req.session.userId);
  if (!user) { req.session.destroy(); return res.redirect('/login'); }
  req.user = user;
  req.permissions = db.prepare('SELECT * FROM permissions WHERE user_id = ?').get(user.id) || {};
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

function requirePermission(...modules) {
  return (req, res, next) => {
    if (req.user?.role === 'admin') return next();
    if (modules.some(m => req.permissions?.[m])) return next();
    return res.status(403).json({ error: `No access to ${modules.join('/')}` });
  };
}

// Gate destructive actions behind a separate flag (`can_delete` on the
// permissions row). Admin always passes. Managers / warehouse / kitchen
// only pass when the admin has explicitly toggled can_delete on for them.
// Apply this BEFORE / ALONGSIDE the per-module requirePermission so the
// 403 is specific: "you can read this module, but not delete from it".
function requireDelete(req, res, next) {
  if (req.user?.role === 'admin') return next();
  if (req.permissions?.can_delete) return next();
  return res.status(403).json({ error: 'Delete not allowed for this user · 此用户无删除权限' });
}

function logActivity(userId, username, action, entityType, entityId, details, ip) {
  try {
    // activity_log.user_id has a FK to users(id). Kitchen users have a real
    // users row; backend/tenant operators (session.backendUserId) do NOT — their
    // id would violate the FK and the whole insert would be dropped, losing the
    // audit trail for everything they do. Store NULL for the id in that case but
    // keep the username string, so the actor is still recorded.
    let uid = userId || null;
    if (uid != null && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(uid)) uid = null;
    // WHOSE history this is. activity_log is a control-plane table — one shared
    // file for every account — so a row that does not say which account it
    // belongs to cannot be shown to anybody without showing it to everybody.
    // Read from the request's tenant scope rather than passed in, because all
    // 139 call sites already run inside that scope (requireRetailAdmin enters
    // it) and threading an argument through every one of them is 139 chances to
    // forget. Outside any scope — the kitchen realm, a boot task — this is
    // Roots, which is what those writes have always meant.
    //
    // require() is inline to keep this module loadable from lib/tenant-db.js's
    // own dependents without a cycle; Node caches it, so it costs one map
    // lookup per call.
    let tenantId = null;
    try { tenantId = require('../lib/tenant-db').currentTenantId(); } catch (e) { tenantId = null; }
    db.prepare('INSERT INTO activity_log (user_id,username,action,entity_type,entity_id,details,ip_address,tenant_id) VALUES (?,?,?,?,?,?,?,?)')
      .run(uid, username, action, entityType||null, entityId||null, details?JSON.stringify(details):null, ip||null, tenantId);
  } catch(e) { console.error('Log error:', e.message); }
}

module.exports = { requireAuth, requireAdmin, requirePermission, requireDelete, logActivity };
