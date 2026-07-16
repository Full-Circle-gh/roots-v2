const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const db = require('../database');
const { logActivity } = require('../middleware/auth');
const router = express.Router();

// Brute-force guard on the login endpoint. 10 attempts per IP per 15 min is
// generous for legit fat-finger retries but kills credential-stuffing at
// scale. trust-proxy is set on the app so req.ip is the real client IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: '尝试过于频繁,请 15 分钟后再试 · Too many attempts, try again in 15 minutes' },
});

// Seed default users if none exist
function seedUsers() {
  const count = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (count > 0) return;
  const defaults = [
    { username: 'admin',     password: 'Admin2026!',     role: 'admin',     name: 'Admin' },
    { username: 'manager',   password: 'Manager2026!',   role: 'manager',   name: 'Manager' },
    { username: 'warehouse', password: 'Warehouse2026!', role: 'warehouse', name: 'Warehouse' },
    { username: 'kitchen',   password: 'Kitchen2026!',   role: 'kitchen',   name: 'Kitchen' },
  ];
  const insertUser = db.prepare('INSERT INTO users (username,password,role,display_name) VALUES (?,?,?,?)');
  const insertPerms = db.prepare(`INSERT INTO permissions (user_id,dashboard,recipes,ingredients,products,purchases,finance,sales,kitchen,waste,restock,alerts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const permMap = {
    admin:     [1,1,1,1,1,1,1,1,1,1,1],
    manager:   [1,1,1,1,1,1,1,1,1,1,1],
    warehouse: [1,0,1,0,1,0,0,0,1,1,1],
    kitchen:   [1,1,0,0,0,0,0,1,1,0,0],
  };
  defaults.forEach(u => {
    const hash = bcrypt.hashSync(u.password, 10);
    const result = insertUser.run(u.username, hash, u.role, u.name);
    insertPerms.run(result.lastInsertRowid, ...permMap[u.role]);
  });
  console.log('Default users created');
}
seedUsers();

// Boot-time check: any user still holding a publicly-known seeded password?
// Runs once per restart, logs LOUDLY if so. Cheap (4 bcrypt compares).
function warnDefaultPasswords() {
  const defaults = {
    admin:     'Admin2026!',
    manager:   'Manager2026!',
    warehouse: 'Warehouse2026!',
    kitchen:   'Kitchen2026!',
  };
  const names = Object.keys(defaults);
  const rows = db.prepare(
    `SELECT username, password FROM users WHERE username IN (${names.map(() => '?').join(',')})`
  ).all(...names);
  const stillDefault = rows.filter(u => bcrypt.compareSync(defaults[u.username], u.password)).map(u => u.username);
  if (stillDefault.length) {
    console.error('[security] WARNING — users still using publicly-known seeded passwords: ' + stillDefault.join(', '));
    console.error('[security] These literals live in the source code. Rotate via the admin UI (Settings > Users) now.');
  } else if (rows.length) {
    console.log('[security] default-password check: all ' + rows.length + ' seeded users rotated.');
  }
}
warnDefaultPasswords();

router.post('/api/auth/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, error: '请输入用户名和密码' });
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username.trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password)) {
    logActivity(null, username, 'login_failed', null, null, null, req.ip);
    return res.json({ success: false, error: '用户名或密码错误' });
  }
  db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  const perms = db.prepare('SELECT * FROM permissions WHERE user_id = ?').get(user.id) || {};
  req.session.userId = user.id;
  logActivity(user.id, user.username, 'login', null, null, null, req.ip);
  res.json({ success: true, user: { id: user.id, username: user.username, role: user.role, displayName: user.display_name, permissions: perms } });
});

router.post('/api/auth/logout', (req, res) => {
  if (req.session.userId) logActivity(req.session.userId, null, 'logout', null, null, null, req.ip);
  req.session.destroy();
  res.json({ success: true });
});

router.get('/api/auth/me', (req, res) => {
  // Auth state must NEVER be cached — not by the browser, a CDN, or an
  // intermediary proxy/VPN. This response otherwise carries only an ETag and
  // no Cache-Control, so some caches store the anonymous {user:null} and keep
  // serving it after the user logs in — bouncing a logged-in user to /login.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  // Bridge for the separate Mini App Backend realm: if there's no kitchen
  // session but a backend-operator session, return that operator as the
  // current principal (with `retail` access) so the backend page's existing
  // auth check passes without a second endpoint. Wrapped so a missing
  // tenant_users table never breaks the kitchen response below.
  if (!req.session?.userId && req.session?.backendUserId) {
    try {
      const bu = db.prepare('SELECT id, tenant_id, username, display_name, role FROM tenant_users WHERE id = ? AND is_active = 1').get(req.session.backendUserId);
      if (bu) {
        const tenant = db.prepare('SELECT id, name, brand_name FROM tenants WHERE id = ?').get(bu.tenant_id);
        return res.json({ user: {
          id: bu.id, username: bu.username, role: 'backend', displayName: bu.display_name,
          permissions: { retail: 1 }, is_backend: true,
          tenant: tenant ? { id: tenant.id, name: tenant.name, brand: tenant.brand_name } : null,
        } });
      }
    } catch (e) { /* tenant_users not ready — fall through to kitchen logic */ }
  }
  if (!req.session?.userId) return res.json({ user: null });
  const user = db.prepare('SELECT id,username,role,display_name,last_login,created_at,market_id,retail_store_id FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.json({ user: null });
  const perms = db.prepare('SELECT * FROM permissions WHERE user_id = ?').get(user.id) || {};
  // Hydrate the assigned market (used by the POS header). NULL if unassigned.
  let market = null;
  if (user.market_id) {
    market = db.prepare('SELECT id, name, name_cn FROM markets WHERE id = ?').get(user.market_id) || null;
  }
  // Hydrate the assigned retail store — drives which Stock cells the user
  // can edit on the Products page. Admin bypasses this on the server.
  let retail_store = null;
  if (user.retail_store_id) {
    retail_store = db.prepare('SELECT id, code, name_en, name_cn FROM retail_stores WHERE id = ?').get(user.retail_store_id) || null;
  }
  res.json({ user: { ...user, displayName: user.display_name, permissions: perms, market, retail_store } });
});

// PUT update own display name
router.put('/api/auth/profile', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  const { display_name } = req.body;
  if (!display_name || display_name.trim().length < 1) return res.status(400).json({ error: 'display_name required · 名称必填' });
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(display_name.trim(), req.session.userId);
  logActivity(req.session.userId, null, 'update_profile', 'user', req.session.userId, null, req.ip);
  // Live: nudge this user's OTHER open kitchen sessions to refetch their name
  // (reference/live-updates-spec.md). Scoped to the user's own id; best-effort.
  try {
    require('./events').broadcast('live',
      { entity: 'identity', action: 'update', scope: { userId: req.session.userId }, ids: [req.session.userId], ts: Date.now() },
      { userId: req.session.userId });
  } catch (e) { /* live push is best-effort */ }
  res.json({ success: true });
});

// PUT change own password — requires the current password to confirm
router.put('/api/auth/password', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated · 未登录' });
  const { current_password, new_password } = req.body;
  if (!new_password || new_password.length < 10) return res.status(400).json({ error: 'New password must be at least 10 characters · 新密码至少需要 10 位' });
  const user = db.prepare('SELECT password FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(404).json({ error: 'User not found · 用户未找到' });
  if (!current_password || !bcrypt.compareSync(current_password, user.password)) {
    return res.status(400).json({ error: 'Current password is incorrect · 当前密码不正确' });
  }
  if (bcrypt.compareSync(new_password, user.password)) {
    return res.status(400).json({ error: 'New password must differ from the current one · 新密码不能与当前密码相同' });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, req.session.userId);
  logActivity(req.session.userId, null, 'change_password', 'user', req.session.userId, null, req.ip);
  res.json({ success: true });
});

module.exports = router;
