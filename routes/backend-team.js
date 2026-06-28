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
const router = express.Router();

// owner/admin/staff are full-access labels; 'kitchen' is a RESTRICTED role —
// that operator only gets the Add Stock app (enforced in server.js) and is
// pinned to one store via retail_store_id.
const ROLES = ['owner', 'admin', 'staff', 'kitchen'];

function requireBackend(req, res, next) {
  if (!req.session?.backendUserId || !req.session?.tenantId) {
    return res.status(401).json({ error: 'Not authenticated · 未登录' });
  }
  next();
}

// Shape a tenant_users row for the client (never leak the password hash).
function publicUser(u, selfId) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name || '',
    role: u.role,
    retailStoreId: u.retail_store_id || null,
    isActive: !!u.is_active,
    hasAvatar: !!u.avatar_url,
    avatarUrl: u.avatar_url || null,
    lastLogin: u.last_login || null,
    isSelf: u.id === selfId,
  };
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
  const rows = db.prepare(
    'SELECT id, username, display_name, role, retail_store_id, is_active, avatar_url, last_login FROM tenant_users WHERE tenant_id = ? ORDER BY is_active DESC, role = \'owner\' DESC, lower(display_name), lower(username)'
  ).all(req.session.tenantId);
  res.json({ team: rows.map(u => publicUser(u, req.session.backendUserId)) });
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
    // A kitchen operator must be pinned to one store (the shelf they add to).
    // Full-access roles aren't store-scoped, so store id is dropped for them.
    let storeId = null;
    if (role === 'kitchen') {
      storeId = parseInt(req.body && req.body.retail_store_id, 10);
      if (!storeId) return res.status(400).json({ error: 'Pick a store for the kitchen member · 请为后厨成员选择门店' });
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

  // Store assignment follows the (resulting) role: a kitchen operator must have
  // one store; any full-access role clears it. Honour an explicit store id from
  // the body, else keep the existing one.
  if (newRole === 'kitchen') {
    let storeId = body.retail_store_id !== undefined ? parseInt(body.retail_store_id, 10) : u.retail_store_id;
    if (!storeId) return res.status(400).json({ error: 'Pick a store for the kitchen member · 请为后厨成员选择门店' });
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

module.exports = router;
