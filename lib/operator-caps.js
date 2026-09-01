// Resolve a backend operator's EFFECTIVE capabilities + store scope from the
// control-plane DB. The pure rule lives in lib/capabilities.js; this is the thin
// DB-reading wrapper that both the auth middleware (req.caps) and /api/backend/me
// share, so the read logic exists in exactly one place.
//
// Fail-OPEN by design: while the RBAC layer is dark (Phase 0/1), any error
// (tables not yet created, etc.) resolves from the role alone with no overrides —
// which for owner/admin/staff is still ALL caps. Nothing a current operator can
// do is ever lost to a resolution hiccup. The tenant_roles read added below
// keeps the same contract: it cannot throw out of here, and a miss lands back on
// the shipped preset.

'use strict';

const caps = require('./capabilities');
const features = require('./features');
const roles = require('./roles');

// db    : the control-plane database (require('../database')).
// user  : a tenant_users row — needs { id, tenant_id, role, retail_store_id, scope_all }.
// tenant: a tenants row (for features_json entitlements AND roles_version); may
//         be null. Pass the WHOLE row where you have one — requireRetailAdmin
//         already does `SELECT * FROM tenants`, so roles_version arrives free
//         and the role cache is checked without a second query.
// → { caps: string[], scopeStores: number[] | null }
//   scopeStores null = unscoped (all stores).
function resolveOperator(db, user, tenant) {
  if (!user) return { caps: [], scopeStores: [] };
  const role = user.role || 'staff';
  const entitlements = features.entitlements(tenant ? tenant.features_json : null);

  // THE ROLE'S OWN CAPABILITIES, from this tenant's tenant_roles row. This is
  // the read that used to be a code literal. It is served from an in-process
  // cache keyed on tenants.roles_version — the integer sitting on the `tenant`
  // row above — so a warm request costs nothing and a stale one costs one
  // indexed read. A role edit bumps that integer, so the very next request by
  // anyone in the tenant reloads: "every change reaches them on their next
  // screen", literally.
  //
  // null (no record, no table, any error) means fall back, and resolveCaps
  // treats an absent baseCaps as presetCapsFor(role) — the pre-roles behaviour,
  // unchanged. An unseeded tenant therefore resolves exactly as it always did.
  let baseCaps = null;
  try {
    const tid = user.tenant_id || (tenant && tenant.id) || null;
    if (tid) baseCaps = roles.capsForRole(tid, role, tenant ? tenant.roles_version : undefined);
  } catch (e) { baseCaps = null; }

  let grants = [];
  let revokes = [];
  try {
    const rows = db.prepare('SELECT capability_key, mode FROM tenant_user_caps WHERE tenant_user_id = ?').all(user.id);
    for (const r of rows) {
      if (r.mode === 'revoke') revokes.push(r.capability_key);
      else grants.push(r.capability_key);
    }
  } catch (e) { /* table not ready — resolve from role alone (fail-open) */ }

  const effective = caps.resolveCaps({ role, baseCaps, grants, revokes, entitlements });

  // Store scope. scope_all defaults to 1 (unscoped); 0 means restrict to the
  // rows in tenant_user_stores, falling back to the legacy single pin.
  let scopeStores = null;
  try {
    const scopeAll = user.scope_all == null ? 1 : Number(user.scope_all);
    if (!scopeAll) {
      const rows = db.prepare('SELECT store_id FROM tenant_user_stores WHERE tenant_user_id = ?').all(user.id);
      scopeStores = rows.map(r => r.store_id);
      if (!scopeStores.length && user.retail_store_id) scopeStores = [user.retail_store_id];
    }
  } catch (e) {
    // No scope table yet — honour only the legacy single pin if present.
    scopeStores = user.retail_store_id ? [user.retail_store_id] : null;
  }

  return { caps: effective, scopeStores };
}

module.exports = { resolveOperator };
