// Mini App Backend — team management (operators within a tenant).
//
// The "Manage team" screen reached from the topbar profile menu. An operator
// can invite teammates, rename / re-role them, deactivate / reactivate, and
// reset passwords — all scoped to their OWN tenant (req.session.tenantId).
//
// Roles are PER-TENANT DATA (tenant_roles, via lib/roles.js) — a tenant names
// them, writes their descriptions and decides what each one reaches, in place,
// from the Roles tab beside People. This file serves both tabs.
//
// Enforcement is still behind tenants.rbac_enforce and still off by default:
// capabilities shape the view, the server blocks nothing. Two safety guards
// remain, and they are about not locking the tenant out, NOT about privilege:
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
const roles = require('../lib/roles');
const { requireBackend, requireCap, roleAboveCaps, loadCaller } = require('../lib/require-cap');
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

// ── Role facts, read from the tenant's own record ─────────────────────────
// These three were hardcoded sets keyed on the role NAME. That is the rename
// hazard: rename a role and a store-scoped operator's pin stopped applying on
// the next save, quietly showing them every store's data. They are fields on
// the record now, and these helpers are the only readers.
//
// The LEGACY_* sets below are the fallback for a tenant with no records yet —
// the same fail-open contract lib/operator-caps.js has always had, so an
// unseeded tenant behaves exactly as it did before roles became data.
const LEGACY_PINNED = new Set(['kitchen', 'store_stock', 'store_manager']);
const LEGACY_SCOPED = new Set(['store_manager']);

function roleRec(tenantId, key) {
  try { return roles.recordFor(tenantId, key); } catch (e) { return null; }
}
// Is this a role this tenant actually has? Both the invite and the edit path
// ask, and both now 400 on a no — see the note on the invite handler.
function knownRole(tenantId, key) {
  try { return roles.isKnownRole(tenantId, key); } catch (e) { return false; }
}
function isStorePinned(tenantId, key) {
  const r = roleRec(tenantId, key);
  return r ? r.storePinned : LEGACY_PINNED.has(key);
}
function isStoreScoped(tenantId, key) {
  const r = roleRec(tenantId, key);
  return r ? r.storeScoped : LEGACY_SCOPED.has(key);
}
// The role's own capability list. presetCapsFor is the fallback, not the source
// — see the long note at the top of lib/roles.js for why it must stay.
function roleCapsFor(tenantId, key) {
  let list = null;
  try { list = roles.capsForRole(tenantId, key); } catch (e) { list = null; }
  return list || capabilities.presetCapsFor(key);
}

// How many people hold each role, and how many of those carry exceptions. The
// Roles tab states this BEFORE anything is editable — "N people hold this role.
// Every change here reaches them on their next screen." Nothing counted people
// by role before: tmPaintStats counts people, owners, never-signed-in and
// store-limited, and stops there.
function roleCounts(tenantId) {
  const out = {};
  const bump = (k) => (out[k] = out[k] || { people: 0, active: 0, exceptions: 0 });
  try {
    for (const r of db.prepare(
      'SELECT role, COUNT(*) c, SUM(COALESCE(is_active,0)) a FROM tenant_users WHERE tenant_id = ? GROUP BY role'
    ).all(tenantId)) { const e = bump(r.role); e.people = r.c; e.active = r.a || 0; }
  } catch (e) { /* no users table — every role reads as empty */ }
  try {
    for (const r of db.prepare(
      `SELECT u.role role, COUNT(DISTINCT c.tenant_user_id) n
         FROM tenant_user_caps c JOIN tenant_users u ON u.id = c.tenant_user_id
        WHERE u.tenant_id = ? GROUP BY u.role`
    ).all(tenantId)) { bump(r.role).exceptions = r.n; }
  } catch (e) { /* no override table — nobody has exceptions */ }
  return out;
}

// How much of a role's reach touches money. Summarised at the role level so an
// owner sees it in the list, not only by opening every group: the shipped
// store_manager preset carries FIVE money-moving capabilities while the
// comments around it claim none.
function moneyTally(capList) {
  let moves = 0, shows = 0;
  for (const k of capList) {
    const m = capabilities.MONEY_KEYS[k];
    if (m === 'moves') moves++; else if (m === 'shows') shows++;
  }
  return { moves, shows };
}

// The tenant's roles, shaped for a picker: identity and the facts a picker needs
// (does this role want a store?), never the capability list. Safe for any
// signed-in operator, which is what the roster and the invite form are.
function rolesForPicker(tenantId) {
  let list = [];
  try { list = roles.listRoles(tenantId); } catch (e) { list = []; }
  // A tenant with no records at all is a state seeding makes unreachable — but
  // if it happens, an empty picker would leave the invite form with no roles to
  // choose from, which is worse than a slow first load. Seed on the spot: the
  // seeder is idempotent and this is a roster read, not a hot path.
  if (!list.length) {
    try { roles.seedTenant(tenantId); list = roles.listRoles(tenantId); } catch (e) { list = []; }
  }
  if (!list.length) return [];
  return list.filter(r => r.roster !== 'store').map(r => ({
    key: r.key, nameEn: r.nameEn, nameCn: r.nameCn,
    descEn: r.descEn, descCn: r.descCn,
    storePinned: r.storePinned, stockAppOnly: r.stockAppOnly,
    layout: r.layout, isFixed: r.isFixed,
  }));
}

// Roles that never appear on the People roster because they are managed inside
// their store instead (Settings → Stores). Was a hardcoded `role != 'store_stock'`.
function offRosterRoles(tenantId) {
  let list = [];
  try { list = roles.listRoles(tenantId).filter(r => r.roster === 'store').map(r => r.key); }
  catch (e) { list = []; }
  return list.length ? list : ['store_stock'];
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
  // Roles whose roster is 'store' are managed inside their store (Settings →
  // Operations → Stores), not here, so the People tab shows only the rest.
  const off = offRosterRoles(req.session.tenantId);
  const rows = db.prepare(
    `SELECT id, username, display_name, role, retail_store_id, scope_all, is_active, avatar_url, last_login
       FROM tenant_users
      WHERE tenant_id = ? AND role NOT IN (${off.map(() => '?').join(',')})
      ORDER BY is_active DESC, role = 'owner' DESC, lower(display_name), lower(username)`
  ).all(req.session.tenantId, ...off);
  const custom = customPermSet(rows.map(r => r.id));
  let rbacEnforce = false;
  try { rbacEnforce = !!db.prepare('SELECT rbac_enforce FROM tenants WHERE id = ?').get(req.session.tenantId)?.rbac_enforce; } catch (e) {}
  // The roster's role chips, the invite picker and the edit picker all read
  // these — the five hardcoded label maps and the two sets of 16 <option>
  // elements they replaced could each be wrong on their own.
  res.json({
    success: true,
    team: rows.map(u => publicUser(u, req.session.backendUserId, custom)),
    roles: rolesForPicker(req.session.tenantId),
    rbacEnforce,
  });
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
router.post('/api/backend/team', requireCap('team:manage'), express.json(), (req, res) => {
  try {
    const { password } = req.body || {};
    const username = validateUsername(req.body && req.body.username);
    const displayName = String((req.body && req.body.display_name) || '').trim();
    // NO SILENT COERCION. This used to fall back to 'staff' for an unrecognised
    // role while the edit path 400'd on the same value. That asymmetry cannot
    // survive roles that can be deleted: a Roles tab open in one window removes
    // Stockroom, a People tab open in another still offers it, the invite posts
    // it — and somebody meant to count shelves is created on Shop floor, which
    // shows wallet balances, unit cost and margin. Nobody is told. The picker is
    // built from the tenant's live roles, so an unknown value can only mean a
    // stale form or a hand-rolled request; both deserve an error.
    const role = String((req.body && req.body.role) || '').trim().toLowerCase();
    if (!role) return res.status(400).json({ error: 'Pick a role · 请选择角色' });
    if (!knownRole(req.session.tenantId, role)) {
      return res.status(400).json({ error: 'That role no longer exists — reload and pick again · 该角色已不存在,请刷新后重新选择' });
    }
    if (roleAboveCaps(req.session.tenantId, role, req.backendCaps)) {
      return res.status(403).json({ error: 'You can’t grant a role with more access than your own · 不能授予超出自己权限的角色' });
    }
    if (displayName.length > 60) return res.status(400).json({ error: 'Name is too long · 名称过长' });
    if (!password || String(password).length < 10) {
      return res.status(400).json({ error: 'Password must be at least 10 characters · 密码至少需要 10 位' });
    }
    // A restricted operator must be pinned to one store (the store they manage
    // stock for). Full-access roles aren't store-scoped, so store id is dropped.
    let storeId = null;
    if (isStorePinned(req.session.tenantId, role)) {
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
    // A store-scoped position sees only its own store's data (operator-caps
    // falls back to the retail_store_id pin when tenant_user_stores is empty).
    if (isStoreScoped(req.session.tenantId, role)) {
      try { db.prepare('UPDATE tenant_users SET scope_all = 0 WHERE id = ?').run(r.lastInsertRowid); } catch (e) {}
    }
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
router.put('/api/backend/team/:id', requireCap('team:manage'), express.json(), (req, res) => {
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
    if (!knownRole(req.session.tenantId, role)) {
      return res.status(400).json({ error: 'That role no longer exists — reload and pick again · 该角色已不存在,请刷新后重新选择' });
    }
    if (roleAboveCaps(req.session.tenantId, role, req.backendCaps)) {
      return res.status(403).json({ error: 'You can’t grant a role with more access than your own · 不能授予超出自己权限的角色' });
    }
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
  if (isStorePinned(req.session.tenantId, newRole)) {
    let storeId = body.retail_store_id !== undefined ? parseInt(body.retail_store_id, 10) : u.retail_store_id;
    if (!storeId) return res.status(400).json({ error: 'Pick a store for this member · 请为该成员选择门店' });
    sets.push('retail_store_id = ?'); args.push(storeId);
  } else if (body.role !== undefined && u.retail_store_id != null) {
    sets.push('retail_store_id = ?'); args.push(null);
  }
  // Store scope follows the position: store_manager narrows to their pin;
  // moving OFF a scoped position lifts the narrow back to all-stores (an admin
  // can still narrow anyone later from the permission matrix).
  if (body.role !== undefined && newRole !== u.role) {
    if (isStoreScoped(req.session.tenantId, newRole)) { sets.push('scope_all = 0'); }
    else if (isStoreScoped(req.session.tenantId, u.role)) { sets.push('scope_all = 1'); }
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
router.post('/api/backend/team/:id/password', requireCap('team:manage'), express.json(), (req, res) => {
  const u = tenantMember(req);
  if (!u) return res.status(404).json({ error: 'Operator not found · 未找到操作员' });
  if (u.id !== req.session.backendUserId && roleAboveCaps(req.session.tenantId, u.role, req.backendCaps)) {
    return res.status(403).json({ error: 'You can’t reset a password for a role above your own · 不能重置权限高于自己的账户密码' });
  }
  const np = (req.body && req.body.new_password) || '';
  if (String(np).length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters · 密码至少需要 10 位' });
  db.prepare('UPDATE tenant_users SET password = ? WHERE id = ?').run(bcrypt.hashSync(String(np), 10), u.id);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════
// Per-user permissions (RBAC) — the permission matrix on the Team page.
//
// A member's role sets their base capabilities; the matrix tweaks individual
// capabilities and the store scope on top of it. We store only the DEVIATIONS
// from the role (tenant_user_caps), so editing the role reaches everyone holding
// it — including people with exceptions, whose exceptions survive as
// differences from the new definition. Resolution happens in
// lib/operator-caps.js; these endpoints read and write the overrides.
//
// Gating: BOTH read and write require `team:permissions`, with one carve-out —
// you may always read your OWN row, because the page's job is partly to show an
// operator what they hold. The read used to be requireBackend only, which meant
// any signed-in operator could pull anyone's effective permission set, the
// owner's included. The comment that lived here claimed the gate was Phase 2
// work; it had already shipped on the PUT.
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
    // Section and group NAMES. The registry's section/group are grouping ids,
    // not labels; shipping the names with the catalog is what stops the role
    // editor growing its own forty-entry map beside the five this pass removes.
    sections: capabilities.SECTIONS,
    groupNames: capabilities.GROUPS,
    // Why a money-marked capability is marked, where its label doesn't say so.
    // Shipped with the catalog because the marker is read at the same moment as
    // the label, and a coin with no sentence behind it stops being believed.
    moneyNotes: capabilities.MONEY_NOTES,
  });
});

// One member's effective permissions + scope (to populate the matrix).
// requireBackend, then an explicit capability check, so an operator can still
// read their OWN row without holding team:permissions.
router.get('/api/backend/team/:id/permissions', requireBackend, (req, res) => {
  const u = tenantMember(req);
  if (!u) return res.status(404).json({ error: 'Operator not found · 未找到操作员' });
  if (u.id !== req.session.backendUserId) {
    const caller = loadCaller(req);
    if (!caller || !caller.caps.has('team:permissions')) {
      return res.status(403).json({ error: 'You don’t have permission for this · 你没有此操作的权限' });
    }
  }
  const ent = entitledKeys(req.session.tenantId);
  // The role's OWN capability list, from this tenant's record. Falls back to the
  // shipped preset for an unseeded tenant, as everything else does.
  const base = roleCapsFor(req.session.tenantId, u.role);
  const roleCaps = base.filter(k => ent.has(k));
  // Effective = role ± overrides ∩ entitlements (mirrors lib/operator-caps).
  const r = require('../lib/operator-caps').resolveOperator(db, u, { features_json: null });
  let storeIds = [];
  try { storeIds = db.prepare('SELECT store_id FROM tenant_user_stores WHERE tenant_user_id = ?').all(u.id).map(x => x.store_id); }
  catch (e) { storeIds = []; }
  if (!storeIds.length && u.retail_store_id) storeIds = [u.retail_store_id];
  // The stored deviations, SIGNED. The matrix used to paint one tint for both
  // directions, so a capability forced ON for this person and one forced OFF
  // looked identical — the two facts an exception can state, and the screen
  // said neither. Sent separately so the client can say which is which.
  let grants = [], revokes = [];
  try {
    for (const row of db.prepare('SELECT capability_key, mode FROM tenant_user_caps WHERE tenant_user_id = ?').all(u.id)) {
      (row.mode === 'revoke' ? revokes : grants).push(row.capability_key);
    }
  } catch (e) { /* no override table — no exceptions to report */ }
  const rec = roleRec(req.session.tenantId, u.role);
  res.json({
    success: true,
    role: u.role,
    roleName: rec ? { en: rec.nameEn, cn: rec.nameCn } : null,
    isOwner: u.role === 'owner',
    isSelf: u.id === req.session.backendUserId,
    // `presetCaps` keeps its name for the client that already reads it; it is
    // the ROLE's list now, not a code literal.
    presetCaps: roleCaps,
    effective: r.caps.filter(k => ent.has(k)),
    grants: grants.filter(k => ent.has(k)),
    revokes: revokes.filter(k => ent.has(k)),
    scopeAll: u.scope_all == null ? true : !!u.scope_all,
    storeIds,
  });
});

// Save one member's permissions. The client sends the DESIRED on-list of caps;
// we diff it against the (entitled) preset to derive the minimal grant/revoke
// rows, then write scope. Owners are always-all and can't be narrowed; you
// can't edit your own matrix (avoids locking yourself out of team:permissions).
router.put('/api/backend/team/:id/permissions', requireCap('team:permissions'), express.json(), (req, res) => {
  const u = tenantMember(req);
  if (!u) return res.status(404).json({ error: 'Operator not found · 未找到操作员' });
  if (u.role === 'owner') return res.status(400).json({ error: 'Owner always has full access · 负责人始终拥有完整权限' });
  if (u.id === req.session.backendUserId) return res.status(400).json({ error: 'You can’t edit your own permissions · 不能编辑自己的权限' });

  const body = req.body || {};
  const ent = entitledKeys(req.session.tenantId);
  // Desired ON set — keep only known + entitled keys.
  const desired = new Set((Array.isArray(body.caps) ? body.caps : [])
    .filter(k => capabilities.isKnown(k) && ent.has(k)));
  // The ROLE's baseline, intersected with what the tenant is entitled to. This
  // is what keeps an override a DIFFERENCE: edit the role later and everyone
  // holding it moves, exceptions and all.
  const preset = new Set(roleCapsFor(req.session.tenantId, u.role).filter(k => ent.has(k)));
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
// ROLES (Settings → Team → Roles)
//
// Roles are edited IN PLACE. There is one set per tenant, no copy-from-template,
// no read-only originals and no reset-to-default: the thing on screen is the
// thing that is in force. Owner is fixed — not editable, not renameable, not
// deletable — because `role === 'owner'` is a reserved literal compared in six
// places outside this file and because a tenant that can narrow its own owner
// can lock itself out of its own account.
//
// Every write bumps tenants.roles_version inside its own transaction. That is
// the whole cache-invalidation story (lib/roles.js): the next request by anyone
// in the tenant reads the new number off the tenants row it was already
// fetching, reloads once, and resolves from the new definition. "Every change
// here reaches them on their next screen" is not a figure of speech.
// ══════════════════════════════════════════════════════════════════════════

// Turn a name into a stable slug. The KEY never changes once set — a rename
// edits name_en/name_cn and nothing else, which is the entire point of splitting
// them: renaming a role used to detach the account from its dashboard board and
// its store pin, because those were keyed on the name.
function slugForRole(tenantId, nameEn) {
  let base = String(nameEn || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
  if (!base) base = 'role';
  // 'owner' is reserved. So is any key this tenant already uses.
  const taken = new Set(['owner']);
  try { for (const r of roles.listRoles(tenantId)) taken.add(r.key); } catch (e) {}
  if (!taken.has(base)) return base;
  for (let n = 2; n < 200; n++) { const k = base + '_' + n; if (!taken.has(k)) return k; }
  return base + '_' + Date.now();
}

// Clean an incoming capability list: known keys only, and — the guard that
// matters — nothing the CALLER doesn't hold themselves. Writing a capability
// into a role you don't have is escalation by another door: roleAboveCaps stops
// you handing OUT a role above your own, and this stops you building one.
// Removing is always allowed; only additions are checked.
function vetRoleCaps(desired, existing, callerCaps, ent) {
  const had = new Set(existing || []);
  const out = new Set();
  // Capabilities the tenant is not entitled to are PRESERVED rather than
  // dropped: the editor never showed them, so their absence from `desired` is
  // silence, not a decision. Same rule the per-person matrix already follows.
  for (const k of had) if (!ent.has(k) && capabilities.isKnown(k)) out.add(k);
  const refused = [];
  for (const k of desired) {
    if (!capabilities.isKnown(k) || !ent.has(k)) continue;
    if (!had.has(k) && callerCaps && !callerCaps.has(k)) { refused.push(k); continue; }
    out.add(k);
  }
  return { caps: [...out].sort(), refused };
}

function roleDetail(tenantId, rec, counts, ent, withCaps) {
  const c = counts[rec.key] || { people: 0, active: 0, exceptions: 0 };
  const visible = rec.isFixed ? capabilities.ALL_KEYS : rec.caps;
  const entVisible = visible.filter(k => ent.has(k));
  const money = moneyTally(entVisible);
  const out = {
    key: rec.key,
    nameEn: rec.nameEn, nameCn: rec.nameCn,
    descEn: rec.descEn, descCn: rec.descCn,
    layout: rec.layout,
    storePinned: rec.storePinned, storeScoped: rec.storeScoped,
    roster: rec.roster, isFixed: rec.isFixed, sortOrder: rec.sortOrder,
    people: c.people, activePeople: c.active, exceptions: c.exceptions,
    capCount: entVisible.length, capTotal: ent.size,
    moneyMoves: money.moves, moneyShows: money.shows,
  };
  if (withCaps) out.caps = entVisible;
  return out;
}

// ── List this tenant's roles ─────────────────────────────────────────────
// Any signed-in operator gets identity and counts — the roster renders role
// chips from this. The capability LISTS only go to a caller who could edit
// them, matching the gate on every other permission read.
router.get('/api/backend/roles', requireBackend, (req, res) => {
  const tid = req.session.tenantId;
  const caller = loadCaller(req);
  const canEdit = !!(caller && caller.caps.has('team:permissions'));
  const ent = entitledKeys(tid);
  const counts = roleCounts(tid);
  let list = [];
  try { list = roles.listRoles(tid); } catch (e) { list = []; }
  res.json({
    success: true,
    canEdit,
    layouts: roles.LAYOUTS,
    roles: list.map(r => roleDetail(tid, r, counts, ent, canEdit)),
  });
});

// ── Add a role ───────────────────────────────────────────────────────────
router.post('/api/backend/roles', requireCap('team:permissions'), express.json(), (req, res) => {
  const tid = req.session.tenantId;
  const body = req.body || {};
  const nameEn = String(body.name_en || '').trim();
  const nameCn = String(body.name_cn || '').trim();
  if (!nameEn && !nameCn) return res.status(400).json({ error: 'Give the role a name · 请为角色命名' });
  if (nameEn.length > 40 || nameCn.length > 40) return res.status(400).json({ error: 'Name is too long · 名称过长' });
  const layout = roles.LAYOUTS.includes(body.layout) ? body.layout : 'default';
  const ent = entitledKeys(tid);
  const { caps: capList, refused } = vetRoleCaps(
    Array.isArray(body.caps) ? body.caps : [], [], req.backendCaps, ent);
  if (refused.length) {
    return res.status(403).json({ error: 'You can’t give a role a permission you don’t have yourself · 不能授予自己没有的权限', refused });
  }
  const key = slugForRole(tid, nameEn || nameCn);
  let sort = 100;
  try { const l = roles.listRoles(tid); sort = l.length ? Math.max(...l.map(r => r.sortOrder)) + 10 : 100; } catch (e) {}
  try {
    const write = db.transaction(() => {
      db.prepare(`INSERT INTO tenant_roles
          (tenant_id, role_key, name_en, name_cn, desc_en, desc_cn, caps_json,
           layout, store_pinned, store_scoped, stock_app_only, roster, is_fixed, sort_order, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,0,'team',0,?,CURRENT_TIMESTAMP)`)
        .run(tid, key, nameEn || nameCn, nameCn || nameEn,
          String(body.desc_en || '').slice(0, 200), String(body.desc_cn || '').slice(0, 200),
          JSON.stringify(capList), layout,
          body.store_pinned ? 1 : 0, body.store_scoped ? 1 : 0, sort);
      roles.bumpVersion(tid);
    });
    write();
  } catch (e) { return res.status(500).json({ error: 'Couldn’t add the role · 无法添加角色' }); }
  const rec = roleRec(tid, key);
  res.json({ success: true, role: roleDetail(tid, rec, roleCounts(tid), ent, true) });
});

// ── Edit a role, in place ────────────────────────────────────────────────
router.put('/api/backend/roles/:key', requireCap('team:permissions'), express.json(), (req, res) => {
  const tid = req.session.tenantId;
  const key = String(req.params.key || '');
  const rec = roleRec(tid, key);
  if (!rec) return res.status(404).json({ error: 'Role not found · 未找到角色' });
  if (rec.isFixed) {
    return res.status(400).json({ error: 'Owner has full access, always. It can’t be renamed or narrowed · 负责人始终拥有完整权限,不可重命名或缩减' });
  }
  const body = req.body || {};
  const ent = entitledKeys(tid);
  const sets = [], args = [];

  if (body.name_en !== undefined || body.name_cn !== undefined) {
    const en = String(body.name_en !== undefined ? body.name_en : rec.nameEn).trim();
    const cn = String(body.name_cn !== undefined ? body.name_cn : rec.nameCn).trim();
    if (!en && !cn) return res.status(400).json({ error: 'Give the role a name · 请为角色命名' });
    if (en.length > 40 || cn.length > 40) return res.status(400).json({ error: 'Name is too long · 名称过长' });
    sets.push('name_en = ?', 'name_cn = ?'); args.push(en || cn, cn || en);
  }
  if (body.desc_en !== undefined) { sets.push('desc_en = ?'); args.push(String(body.desc_en || '').slice(0, 200)); }
  if (body.desc_cn !== undefined) { sets.push('desc_cn = ?'); args.push(String(body.desc_cn || '').slice(0, 200)); }
  if (body.layout !== undefined) {
    if (!roles.LAYOUTS.includes(body.layout)) return res.status(400).json({ error: 'Unknown home board · 未知首页看板' });
    sets.push('layout = ?'); args.push(body.layout);
  }
  if (body.store_pinned !== undefined) {
    const on = body.store_pinned ? 1 : 0;
    // Turning pinning ON while somebody holding the role has no store would
    // leave them in a state the edit form can't produce and the save path
    // refuses. Say how many, rather than writing a record that half-applies.
    if (on && !rec.storePinned) {
      let missing = 0;
      try {
        missing = db.prepare('SELECT COUNT(*) c FROM tenant_users WHERE tenant_id = ? AND role = ? AND retail_store_id IS NULL')
          .get(tid, key).c;
      } catch (e) { missing = 0; }
      if (missing) {
        const who = missing === 1 ? '1 person holding this role has' : missing + ' people holding this role have';
        return res.status(400).json({
          error: who + ' no store yet. Give them one first · 有 ' + missing + ' 位成员尚未分配门店,请先分配',
        });
      }
    }
    sets.push('store_pinned = ?'); args.push(on);
  }
  if (body.store_scoped !== undefined) { sets.push('store_scoped = ?'); args.push(body.store_scoped ? 1 : 0); }

  let capList = null;
  if (Array.isArray(body.caps)) {
    const vetted = vetRoleCaps(body.caps, rec.caps, req.backendCaps, ent);
    if (vetted.refused.length) {
      return res.status(403).json({ error: 'You can’t give a role a permission you don’t have yourself · 不能授予自己没有的权限', refused: vetted.refused });
    }
    capList = vetted.caps;
    sets.push('caps_json = ?'); args.push(JSON.stringify(capList));
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update · 无可更新内容' });
  sets.push('updated_at = CURRENT_TIMESTAMP');
  args.push(tid, key);
  try {
    const write = db.transaction(() => {
      db.prepare(`UPDATE tenant_roles SET ${sets.join(', ')} WHERE tenant_id = ? AND role_key = ?`).run(...args);
      // Store scope follows the role for everyone holding it, the same way the
      // per-person edit path already moves it when someone changes role.
      if (body.store_scoped !== undefined) {
        db.prepare('UPDATE tenant_users SET scope_all = ? WHERE tenant_id = ? AND role = ?')
          .run(body.store_scoped ? 0 : 1, tid, key);
      }
      roles.bumpVersion(tid);
    });
    write();
  } catch (e) { return res.status(500).json({ error: 'Couldn’t save the role · 无法保存角色' }); }
  const fresh = roleRec(tid, key);
  res.json({ success: true, role: roleDetail(tid, fresh, roleCounts(tid), ent, true) });
});

// ── Delete a role ────────────────────────────────────────────────────────
// A role nobody holds deletes outright. A role somebody holds cannot be deleted
// without naming where its people go — `move_to` is required, there is no
// default, and the move happens in the same transaction as the delete. So the
// orphan state (an account pointing at a role that no longer exists) is never
// reachable through the product.
//
// Exceptions travel with the people, as differences from the NEW role. That is
// consistent with the standing decision that overrides are differences and with
// what already happens when an admin changes one person's role: tenant_user_caps
// is not touched. The dialog says so before the button is pressed.
router.delete('/api/backend/roles/:key', requireCap('team:permissions'), express.json(), (req, res) => {
  const tid = req.session.tenantId;
  const key = String(req.params.key || '');
  const rec = roleRec(tid, key);
  if (!rec) return res.status(404).json({ error: 'Role not found · 未找到角色' });
  if (rec.isFixed) return res.status(400).json({ error: 'The Owner role can’t be deleted · 负责人角色不可删除' });

  let holders = [];
  try {
    holders = db.prepare('SELECT id, retail_store_id FROM tenant_users WHERE tenant_id = ? AND role = ?').all(tid, key);
  } catch (e) { holders = []; }

  const moveTo = String((req.body && req.body.move_to) || req.query.move_to || '').trim();
  let dest = null;
  if (holders.length) {
    if (!moveTo) {
      const who = holders.length === 1 ? '1 person holds this role' : holders.length + ' people hold this role';
      return res.status(400).json({
        error: who + '. Choose where they go · 有 ' + holders.length + ' 人使用此角色,请选择迁移目标',
        people: holders.length,
      });
    }
    if (moveTo === key) return res.status(400).json({ error: 'Pick a different role · 请选择其他角色' });
    dest = roleRec(tid, moveTo);
    if (!dest) return res.status(400).json({ error: 'That role no longer exists — reload and pick again · 该角色已不存在,请刷新后重新选择' });
    // Same escalation guard the invite and edit paths use: you cannot move
    // people onto a role that reaches further than you do.
    if (roleAboveCaps(tid, moveTo, req.backendCaps)) {
      return res.status(403).json({ error: 'You can’t move people to a role with more access than your own · 不能迁移到超出自己权限的角色' });
    }
    // Moving onto a pinned role needs everybody to have a store already.
    if (dest.storePinned) {
      const missing = holders.filter(h => !h.retail_store_id).length;
      if (missing) {
        return res.status(400).json({
          error: 'That role needs a store per person, and ' + missing + ' of them have none · 目标角色需要为每人指定门店,其中 ' + missing + ' 人尚未分配',
        });
      }
    }
  }

  try {
    const write = db.transaction(() => {
      if (holders.length) {
        // Scoped to the people who actually MOVED, by id — not to everyone on
        // the destination role. Anyone already there may have been narrowed to
        // particular stores from their own permission matrix, and a delete
        // somewhere else in the list is not a reason to widen them back out.
        const ids = holders.map(h => h.id);
        const marks = ids.map(() => '?').join(',');
        db.prepare(`UPDATE tenant_users SET role = ? WHERE tenant_id = ? AND id IN (${marks})`).run(moveTo, tid, ...ids);
        // Store pin and scope follow the destination role, exactly as they do
        // when one person's role changes on the People tab.
        if (!dest.storePinned) {
          db.prepare(`UPDATE tenant_users SET retail_store_id = NULL WHERE id IN (${marks})`).run(...ids);
        }
        db.prepare(`UPDATE tenant_users SET scope_all = ? WHERE id IN (${marks})`)
          .run(dest.storeScoped ? 0 : 1, ...ids);
      }
      db.prepare('DELETE FROM tenant_roles WHERE tenant_id = ? AND role_key = ?').run(tid, key);
      roles.bumpVersion(tid);
    });
    write();
  } catch (e) { return res.status(500).json({ error: 'Couldn’t delete the role · 无法删除角色' }); }
  res.json({ success: true, moved: holders.length, movedTo: moveTo || null });
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
