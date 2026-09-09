// Routed through the database seam (lib/db-seam.js). No converter is installed,
// so this is a zero-cost passthrough; the point is that this file is now on the
// covered side of the boundary. Proven by scripts/diagnose_seam_statements.js.
const { seam } = require('../lib/db-seam');
const db = seam(require('../database'));

/* THE FOUR REALM GATES STOOD HERE AND ARE GONE (§81): requireAuth,
   requireAdmin, requirePermission and requireDelete.
   
   Every one of them read `req.session.userId` against the `users` table and
   its `permissions` row — the kitchen realm. §78 deleted the app that realm
   existed for; §81 deleted its login page and its /api/auth routes, so no such
   session can be created, and a gate that can only refuse is not a gate.
   
   WHAT REPLACED THEM, so nothing here reads as merely removed: Tacet's
   requireRetailAdmin (routes/retail.js) on the tenant realm, and
   requirePlatformAdmin (lib/platform-admin.js) for the platform console. Both
   already existed; this file's gates were the second way in.
   
   logActivity STAYS and is why this module does. It is realm-agnostic — 139
   call sites across both surfaces write the shared activity_log through it —
   and its FK note below is now history rather than a live branch: with no
   `users` rows being created, every id it is handed is a tenant operator's,
   which is exactly the case that comment says to store as NULL. */

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

module.exports = { logActivity };
