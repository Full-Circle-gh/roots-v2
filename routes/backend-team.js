// Mini App Backend — team management (operators within a tenant).
//
// The "Manage team" screen reached from the topbar profile menu. An operator
// can invite teammates, rename / re-role them, deactivate / reactivate, and
// reset passwords — all scoped to their OWN tenant (req.session.tenantId).
//
// Roles (owner | admin | staff) are IDENTITY ONLY right now — the backend realm
// has no per-module permission gate, so every active operator has full access.
// Role is shown, not enforced. We still keep two safety guards that are about
// not locking the tenant out, NOT about privilege:
//   • you can't deactivate / demote your OWN account (avoid self-lockout)
//   • the tenant must always keep at least one active owner
//
// Username rules mirror lib/provision-tenant.js: lowercase [a-z0-9._-], unique
// across ALL tenants (backend login is username-based), password >= 10 chars.

const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../database');
const capabilities = require('../lib/capabilities');
const features = require('../lib/features');
const router = express.Router();

// Tenant feature entitlements (the plan ceiling) for a tenant id. A capability
// whose feature is switched off for this tenant is hidden from the matrix and
// never written as an override.
function tenantEntitlements(tenantId) {
  try {
    const t = db.prepare('SELECT features_json FROM tenants WHERE id = ?').get(tenantId);
    return features.entitlements(t ? t.features_json : null);
  } catch (e) { return features.entitlements(null); }
}
// Cap keys this tenant is entitled to (drops feature-gated caps that are off).
function entitledKeys(tenantId) {
  const ent = tenantEntitlements(tenantId);
  return new Set(capabilities.ALL_KEYS.filter(k => {
    const feat = capabilities.CAP_FEATURE[k];
    return !(feat && ent[feat] === false);
  }));
}

// owner/admin/staff are full-access labels. Two RESTRICTED roles only get the
// Quick Stock app (enforced in server.js) and are pinned to one store via
// retail_store_id:
//   • 'kitchen'     — kitchen staff, managed from this Team page.
//   • 'store_stock' — store stock clerks, managed under Settings → Operations →
//                     Stores (see the per-store staff endpoints at the bottom of
//                     this file). They are NOT listed on the Team page.
const ROLES = ['owner', 'admin', 'staff', 'kitchen', 'store_stock'];
const STORE_PINNED_ROLES = new Set(['kitchen', 'store_stock']);

function requireBackend(req, res, next) {
  if (!req.session?.backendUserId || !req.session?.tenantId) {
    return res.status(401).json({ error: 'Not authenticated · 未登录' });
  }
  next();
}

// Shape a tenant_users row for the client (never leak the password hash).
// `customSet` (optional) is a Set of user ids that carry per-user permission
// overrides, so the roster can flag them with a "Custom" chip.
function publicUser(u, selfId, customSet) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name || '',
    role: u.role,
    retailStoreId: u.retail_store_id || null,
    scopeAll: u.scope_all == null ? true : !!u.scope_all,
    isActive: !!u.is_active,
    hasAvatar: !!u.avatar_url,
    avatarUrl: u.avatar_url || null,
    lastLogin: u.last_login || null,
    isSelf: u.id === selfId,
    hasCustomPerms: customSet ? customSet.has(u.id) : false,
  };
}

// Which of these user ids carry override rows (for the roster "Custom" chip).
function customPermSet(userIds) {
  if (!userIds.length) return new Set();
  try {
    const rows = db.prepare(
      `SELECT DISTINCT tenant_user_id FROM tenant_user_caps WHERE tenant_user_id IN (${userIds.map(() => '?').join(',')})`
    ).all(...userIds);
    return new Set(rows.map(r => r.tenant_user_id));
  } catch (e) { return new Set(); }
}

function validateUsername(raw) {
  const username = String(raw || '').trim().toLowerCase();
  if (!username) throw new Error('Username required · 用户名必填');
  if (!/^[a-z0-9._-]+$/.test(username)) throw new Error('Username may use letters, numbers, . _ - only · 用户名仅限字母、数字和 . _ -');
  if (username.length > 40) throw new Error('Username is too long · 用户名过长');
  return username;
}

function countActiveOwners(tenantId, exceptId) {
  let sql = "SELECT COUNT(*) c FROM tenant_users WHERE tenant_id = ? AND role = 'owner' AND is_active = 1";
  const args = [tenantId];
  if (exceptId) { sql += ' AND id != ?'; args.push(exceptId); }
  return db.prepare(sql).get(...args).c;
}

// ── List operators in this tenant ────────────────────────────────────────
router.get('/api/backend/team', requireBackend, (req, res) => {
  // store_stock clerks are managed under their store (Settings → Operations →
  // Stores), not here, so the Team roster shows only the people roles.
  const rows = db.prepare(
    "SELECT id, username, display_name, role, retail_store_id, scope_all, is_active, avatar_url, last_login FROM tenant_users WHERE tenant_id = ? AND role != 'store_stock' ORDER BY is_active DESC, role = 'owner' DESC, lower(display_name), lower(username)"
  ).all(req.session.tenantId);
  const custom = customPermSet(rows.map(r => r.id));
  let rbacEnforce = false;
  try { rbacEnforce = !!db.prepare('SELECT rbac_enforce FROM tenants WHERE id = ?').get(req.session.tenantId)?.rbac_enforce; } catch (e) {}
  res.json({ team: rows.map(u => publicUser(u, req.session.backendUserId, custom)), rbacEnforce });
});

// Master switch — turn capability enforcement on/off for this tenant. Owner only.
// Off (default): capabilities shape the view but the server blocks nothing.
// On: requireRetailAdmin enforces the route→capability map (owner still bypasses).
router.put('/api/backend/rbac-enforce', requireBackend, express.json(), (req, res) => {
  const self = db.prepare('SELECT role FROM tenant_users WHERE id = ? AND tenant_id = ?').get(req.session.backendUserId, req.session.tenantId);
  if (!self || self.role !== 'owner') return res.status(403).json({ error: 'Only the owner can change this · 仅负责人可更改' });
  const on = req.body && req.body.enforce ? 1 : 0;
  try { db.prepare('UPDATE tenants SET rbac_enforce = ? WHERE id = ?').run(on, req.session.tenantId); }
  catch (e) { return res.status(500).json({ error: 'Couldn’t update · 更新失败' }); }
  res.json({ success: true, rbacEnforce: !!on });
});

// ── Invite / create an operator ──────────────────────────────────────────
router.post('/api/backend/team', requireBackend, express.json(), (req, res) => {
  try {
    const { password } = req.body || {};
    const username = validateUsername(req.body && req.body.username);
    const displayName = String((req.body && req.body.display_name) || '').trim();
    let role = String((req.body && req.body.role) || 'staff').trim().toLowerCase();
    if (!ROLES.includes(role)) role = 'staff';
    if (displayName.length > 60) return res.status(400).json({ error: 'Name is too long · 名称过长' });
    if (!password || String(password).length < 10) {
      return res.status(400).json({ error: 'Password must be at least 10 characters · 密码至少需要 10 位' });
    }
    // A restricted operator must be pinned to one store (the store they manage
    // stock for). Full-access roles aren't store-scoped, so store id is dropped.
    let storeId = null;
    if (STORE_PINNED_ROLES.has(role)) {
      storeId = parseInt(req.body && req.body.retail_store_id, 10);
      if (!storeId) return res.status(400).json({ error: 'Pick a store for this member · 请为该成员选择门店' });
    }
    // Global uniqueness — login resolves a username across every tenant.
    if (db.prepare('SELECT id FROM tenant_users WHERE username = ?').get(username)) {
      return res.status(409).json({ error: 'That username is already taken · 该用户名已被占用' });
    }
    const hash = bcrypt.hashSync(String(password), 10);
    const r = db.prepare(
      'INSERT INTO tenant_users (tenant_id, username, password, display_name, role, retail_store_id) VALUES (?,?,?,?,?,?)'
    ).run(req.session.tenantId, username, hash, displayName || username, role, storeId);
    const u = db.prepare('SELECT id, username, display_name, role, retail_store_id, is_active, avatar_url, last_login FROM tenant_users WHERE id = ?').get(r.lastInsertRowid);
    res.json({ success: true, user: publicUser(u, req.session.backendUserId) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Resolve a :id that belongs to the caller's tenant, or null.
function tenantMember(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return null;
  return db.prepare('SELECT * FROM tenant_users WHERE id = ? AND tenant_id = ?').get(id, req.session.tenantId) || null;
}

// ── Update an operator (name / role / active) ────────────────────────────
router.put('/api/backend/team/:id', requireBackend, express.json(), (req, res) => {
  const u = tenantMember(req);
  if (!u) return res.status(404).json({ error: 'Operator not found · 未找到操作员' });
  const isSelf = u.id === req.session.backendUserId;
  const body = req.body || {};

  const sets = [], args = [];

  if (body.display_name !== undefined) {
    const name = String(body.display_name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required · 名称必填' });
    if (name.length > 60) return res.status(400).json({ error: 'Name is too long · 名称过长' });
    sets.push('display_name = ?'); args.push(name);
  }

  let newRole = u.role;
  if (body.role !== undefined) {
    const role = String(body.role || '').trim().toLowerCase();
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role · 未知角色' });
    if (isSelf && u.role === 'owner' && role !== 'owner') {
      return res.status(400).json({ error: 'You can’t change your own owner role · 不能更改自己的负责人角色' });
    }
    // Demoting the last active owner would leave the tenant ownerless.
    if (u.role === 'owner' && role !== 'owner' && u.is_active && countActiveOwners(req.session.tenantId, u.id) === 0) {
      return res.status(400).json({ error: 'Assign another owner first · 请先指定另一位负责人' });
    }
    newRole = role;
    sets.push('role = ?'); args.push(role);
  }

  // Store assignment follows the (resulting) role: a restricted operator must
  // have one store; any full-access role clears it. Honour an explicit store id
  // from the body, else keep the existing one.
  if (STORE_PINNED_ROLES.has(newRole)) {
    let storeId = body.retail_store_id !== undefined ? parseInt(body.retail_store_id, 10) : u.retail_store_id;
    if (!storeId) return res.status(400).json({ error: 'Pick a store for this member · 请为该成员选择门店' });
    sets.push('retail_store_id = ?'); args.push(storeId);
  } else if (body.role !== undefined && u.retail_store_id != null) {
    sets.push('retail_store_id = ?'); args.push(null);
  }

  if (body.is_active !== undefined) {
    const active = body.is_active ? 1 : 0;
    if (isSelf && !active) return res.status(400).json({ error: 'You can’t deactivate your own account · 不能停用自己的账户' });
    if (!active && u.role === 'owner' && countActiveOwners(req.session.tenantId, u.id) === 0) {
      return res.status(400).json({ error: 'The tenant needs at least one active owner · 至少需保留一位在用负责人' });
    }
    sets.push('is_active = ?'); args.push(active);
  }

  if (!sets.length) return res.status(400).json({ error: 'Nothing to update · 无可更新内容' });
  args.push(u.id);
  db.prepare(`UPDATE tenant_users SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  const fresh = db.prepare('SELECT id, username, display_name, role, retail_store_id, is_active, avatar_url, last_login FROM tenant_users WHERE id = ?').get(u.id);
  res.json({ success: true, user: publicUser(fresh, req.session.backendUserId) });
});

// ── Reset an operator's password ─────────────────────────────────────────
router.post('/api/backend/team/:id/password', requireBackend, express.json(), (req, res) => {
  const u = tenantMember(req);
  if (!u) return res.status(404).json({ error: 'Operator not found · 未找到操作员' });
  const np = (req.body && req.body.new_password) || '';
  if (String(np).length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters · 密码至少需要 10 位' });
  db.prepare('UPDATE tenant_users SET password = ? WHERE id = ?').run(bcrypt.hashSync(String(np), 10), u.id);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════
// Per-user permissions (RBAC) — the permission matrix on the Team page.
//
// A member's role is a PRESET (base cap set). The matrix lets the admin tweak
// individual capabilities and the store scope on top of it. We store only the
// DEVIATIONS from the preset (tenant_user_caps), so changing the preset later
// auto-adjusts. Resolution happens in lib/operator-caps.js; this endpoint just
// reads/writes the overrides.
//
// Gating note: while RBAC is dark (Phase 0/1) every operator reaches this page,
// so these routes use requireBackend only. Phase 2 adds a `team:permissions`
// gate here once enforcement goes live.
// ══════════════════════════════════════════════════════════════════════════

// The capability catalog + this tenant's entitlements, for rendering the matrix.
router.get('/api/backend/capabilities', requireBackend, (req, res) => {
  const ent = tenantEntitlements(req.session.tenantId);
  // Hide caps whose feature the tenant has switched off.
  const caps = capabilities.CAPABILITIES.filter(c => !(c.feature && ent[c.feature] === false));
  res.json({
    success: true,
    capabilities: caps,                 // ordered; client groups by group→section
    groups: ['run', 'sell', 'content', 'setup'],
    entitlements: ent,
  });
});

// One member's effective permissions + scope (to populate the matrix).
router.get('/api/backend/team/:id/permissions', requireBackend, (req, res) => {
  const u = tenantMember(req);
  if (!u) return res.status(404).json({ error: 'Operator not found · 未找到操作员' });
  const ent = entitledKeys(req.session.tenantId);
  const presetCaps = capabilities.presetCapsFor(u.role).filter(k => ent.has(k));
  // Effective = preset ± overrides ∩ entitlements (mirrors lib/operator-caps).
  const r = require('../lib/operator-caps').resolveOperator(db, u, { features_json: null });
  let storeIds = [];
  try { storeIds = db.prepare('SELECT store_id FROM tenant_user_stores WHERE tenant_user_id = ?').all(u.id).map(x => x.store_id); }
  catch (e) { storeIds = []; }
  if (!storeIds.length && u.retail_store_id) storeIds = [u.retail_store_id];
  res.json({
    success: true,
    role: u.role,
    isOwner: u.role === 'owner',
    isSelf: u.id === req.session.backendUserId,
    presetCaps,
    effective: r.caps.filter(k => ent.has(k)),
    scopeAll: u.scope_all == null ? true : !!u.scope_all,
    storeIds,
  });
});

// Save one member's permissions. The client sends the DESIRED on-list of caps;
// we diff it against the (entitled) preset to derive the minimal grant/revoke
// rows, then write scope. Owners are always-all and can't be narrowed; you
// can't edit your own matrix (avoids locking yourself out of team:permissions).
router.put('/api/backend/team/:id/permissions', requireBackend, express.json(), (req, res) => {
  const u = tenantMember(req);
  if (!u) return res.status(404).json({ error: 'Operator not found · 未找到操作员' });
  if (u.role === 'owner') return res.status(400).json({ error: 'Owner always has full access · 负责人始终拥有完整权限' });
  if (u.id === req.session.backendUserId) return res.status(400).json({ error: 'You can’t edit your own permissions · 不能编辑自己的权限' });

  const body = req.body || {};
  const ent = entitledKeys(req.session.tenantId);
  // Desired ON set — keep only known + entitled keys.
  const desired = new Set((Array.isArray(body.caps) ? body.caps : [])
    .filter(k => capabilities.isKnown(k) && ent.has(k)));
  // Preset baseline, intersected with what the tenant is entitled to.
  const preset = new Set(capabilities.presetCapsFor(u.role).filter(k => ent.has(k)));
  // Minimal overrides: grant what's wanted but not in preset; revoke what's in
  // preset but not wanted. Caps off purely due to entitlement are left alone.
  const grants = [...desired].filter(k => !preset.has(k));
  const revokes = [...preset].filter(k => !desired.has(k));

  // Store scope.
  const scopeAll = body.scope_all ? 1 : 0;
  let storeIds = [];
  if (!scopeAll) {
    storeIds = (Array.isArray(body.store_ids) ? body.store_ids : [])
      .map(n => parseInt(n, 10)).filter(Number.isInteger);
    // Restrict to this tenant's real stores so a stray id can't be written.
    // retail_stores is a tenant DATA-plane table (per-tenant DB connection),
    // not the control-plane `db`, so resolve it via the tenant connection.
    try {
      const conn = require('../lib/tenant-db').getTenantDb(req.session.tenantId);
      const valid = new Set(conn.prepare('SELECT id FROM retail_stores').all().map(s => s.id));
      storeIds = storeIds.filter(id => valid.has(id));
    } catch (e) { /* connection/table not available — keep parsed ids */ }
  }

  const write = db.transaction(() => {
    db.prepare('DELETE FROM tenant_user_caps WHERE tenant_user_id = ?').run(u.id);
    const ins = db.prepare('INSERT INTO tenant_user_caps (tenant_id, tenant_user_id, capability_key, mode, updated_by) VALUES (?,?,?,?,?)');
    for (const k of grants)  ins.run(req.session.tenantId, u.id, k, 'grant', req.session.backendUserId);
    for (const k of revokes) ins.run(req.session.tenantId, u.id, k, 'revoke', req.session.backendUserId);
    db.prepare('DELETE FROM tenant_user_stores WHERE tenant_user_id = ?').run(u.id);
    if (!scopeAll) {
      const sins = db.prepare('INSERT OR IGNORE INTO tenant_user_stores (tenant_user_id, store_id) VALUES (?,?)');
      for (const id of storeIds) sins.run(u.id, id);
    }
    db.prepare('UPDATE tenant_users SET scope_all = ? WHERE id = ?').run(scopeAll, u.id);
  });
  try { write(); } catch (e) { return res.status(500).json({ error: 'Couldn’t save permissions · 无法保存权限' }); }

  // Echo the fresh effective set so the client can repaint without a reload.
  const fresh = db.prepare('SELECT * FROM tenant_users WHERE id = ?').get(u.id);
  const r = require('../lib/operator-caps').resolveOperator(db, fresh, { features_json: null });
  res.json({ success: true, effective: r.caps.filter(k => ent.has(k)), scopeAll: !!scopeAll, storeIds, hasCustomPerms: (grants.length + revokes.length) > 0 });
});

// ══════════════════════════════════════════════════════════════════════════
// Per-store stock staff (Settings → Operations → Stores)
//
// A 'store_stock' operator can do ONLY the Quick Stock app, pinned to ONE store
// (server.js lockdown + retail-inventory.js store check). They are created and
// removed here, from inside the store they belong to — never from the Team page —
// so a Yuexiu clerk can never see or touch Tianhe stock. All rows are scoped to
// the caller's tenant (req.session.tenantId) and the :storeId in the path.
// ══════════════════════════════════════════════════════════════════════════

// List the stock clerks for one store.
router.get('/api/backend/stores/:storeId/staff', requireBackend, (req, res) => {
  const storeId = parseInt(req.params.storeId, 10);
  if (!storeId) return res.status(400).json({ error: 'Bad store · 门店无效' });
  const rows = db.prepare(
    "SELECT id, username, display_name, role, retail_store_id, is_active, avatar_url, last_login FROM tenant_users WHERE tenant_id = ? AND retail_store_id = ? AND role = 'store_stock' ORDER BY is_active DESC, lower(display_name), lower(username)"
  ).all(req.session.tenantId, storeId);
  res.json({ success: true, staff: rows.map(u => publicUser(u, req.session.backendUserId)) });
});

// Add a stock clerk to one store. Role + store are fixed by the endpoint — the
// caller only supplies a name, login and password.
router.post('/api/backend/stores/:storeId/staff', requireBackend, express.json(), (req, res) => {
  try {
    const storeId = parseInt(req.params.storeId, 10);
    if (!storeId) return res.status(400).json({ error: 'Bad store · 门店无效' });
    const username = validateUsername(req.body && req.body.username);
    const displayName = String((req.body && req.body.display_name) || '').trim();
    const { password } = req.body || {};
    if (displayName.length > 60) return res.status(400).json({ error: 'Name is too long · 名称过长' });
    if (!password || String(password).length < 10) {
      return res.status(400).json({ error: 'Password must be at least 10 characters · 密码至少需要 10 位' });
    }
    if (db.prepare('SELECT id FROM tenant_users WHERE username = ?').get(username)) {
      return res.status(409).json({ error: 'That username is already taken · 该用户名已被占用' });
    }
    const hash = bcrypt.hashSync(String(password), 10);
    const r = db.prepare(
      "INSERT INTO tenant_users (tenant_id, username, password, display_name, role, retail_store_id) VALUES (?,?,?,?,'store_stock',?)"
    ).run(req.session.tenantId, username, hash, displayName || username, storeId);
    const u = db.prepare('SELECT id, username, display_name, role, retail_store_id, is_active, avatar_url, last_login FROM tenant_users WHERE id = ?').get(r.lastInsertRowid);
    res.json({ success: true, user: publicUser(u, req.session.backendUserId) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Resolve a store_stock member that belongs to the caller's tenant AND store.
function storeStaffMember(req) {
  const id = Number(req.params.userId);
  const storeId = parseInt(req.params.storeId, 10);
  if (!Number.isInteger(id) || !storeId) return null;
  return db.prepare(
    "SELECT * FROM tenant_users WHERE id = ? AND tenant_id = ? AND retail_store_id = ? AND role = 'store_stock'"
  ).get(id, req.session.tenantId, storeId) || null;
}

// Remove a stock clerk (deactivate — keeps their stock-ledger history intact).
router.delete('/api/backend/stores/:storeId/staff/:userId', requireBackend, (req, res) => {
  const u = storeStaffMember(req);
  if (!u) return res.status(404).json({ error: 'Member not found · 未找到成员' });
  db.prepare('UPDATE tenant_users SET is_active = 0 WHERE id = ?').run(u.id);
  res.json({ success: true });
});

// Reset a stock clerk's password.
router.post('/api/backend/stores/:storeId/staff/:userId/password', requireBackend, express.json(), (req, res) => {
  const u = storeStaffMember(req);
  if (!u) return res.status(404).json({ error: 'Member not found · 未找到成员' });
  const np = (req.body && req.body.new_password) || '';
  if (String(np).length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters · 密码至少需要 10 位' });
  db.prepare('UPDATE tenant_users SET password = ? WHERE id = ?').run(bcrypt.hashSync(String(np), 10), u.id);
  res.json({ success: true });
});

module.exports = router;
