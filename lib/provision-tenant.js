// Tenant provisioning (Phase 2). Creates a brand-new, fully isolated tenant:
//   1. a tenants row (the company)
//   2. an owner tenant_user (bcrypt password)
//   3. a 14-day trial billing_subscription
//   4. the tenant's own empty SQLite data file (schema cloned, no rows)
//
// Control-plane rows (1–3) go in the shared roots.db; (4) is the isolated
// per-tenant DB via tenant-db.js. Usernames are enforced GLOBALLY unique so
// the username-based backend login stays unambiguous across tenants.

const bcrypt = require('bcrypt');
const mainDb = require('../database');
const { getTenantDb } = require('./tenant-db');

const TRIAL_DAYS = 14;

function sqlDt(d) { return d.toISOString().slice(0, 19).replace('T', ' '); }

function provisionTenant({ company, brand, ownerUsername, ownerPassword, ownerName }) {
  company = String(company || '').trim();
  brand = String(brand || '').trim();
  ownerUsername = String(ownerUsername || '').trim().toLowerCase();
  ownerName = String(ownerName || '').trim();

  if (!company) throw new Error('Company name required · 公司名称必填');
  if (!ownerUsername) throw new Error('Owner username required · 用户名必填');
  if (!ownerPassword || ownerPassword.length < 10) throw new Error('Password must be at least 10 characters · 密码至少需要 10 位');
  if (!/^[a-z0-9._-]+$/.test(ownerUsername)) throw new Error('Username may use letters, numbers, . _ - only · 用户名仅限字母、数字和 . _ -');

  // Username must be unique across ALL tenants (login is username-based).
  if (mainDb.prepare('SELECT id FROM tenant_users WHERE username = ?').get(ownerUsername)) {
    throw new Error('That username is already taken · 该用户名已被占用');
  }

  const now = new Date();
  const trialEnd = new Date(now.getTime() + TRIAL_DAYS * 86400000);
  const hash = bcrypt.hashSync(ownerPassword, 10);

  const tx = mainDb.transaction(() => {
    const t = mainDb.prepare('INSERT INTO tenants (name, brand_name, status) VALUES (?, ?, ?)')
      .run(company, brand || company, 'active');
    const tenantId = t.lastInsertRowid;

    mainDb.prepare('INSERT INTO tenant_users (tenant_id, username, password, display_name, role) VALUES (?,?,?,?,?)')
      .run(tenantId, ownerUsername, hash, ownerName || 'Owner', 'owner');

    mainDb.prepare(`INSERT INTO billing_subscriptions (tenant_id, plan_id, status, current_period_start, current_period_end, trial_end, is_internal)
                    VALUES (?, NULL, 'trialing', ?, ?, ?, 0)`)
      .run(tenantId, sqlDt(now), sqlDt(trialEnd), sqlDt(trialEnd));

    return tenantId;
  });

  const tenantId = tx();

  // Materialize the isolated, empty per-tenant data DB (schema only). Done
  // after the control-plane commit so a rolled-back tenant leaves no file.
  try { getTenantDb(tenantId); }
  catch (e) { console.error('[provision] tenant #' + tenantId + ' DB init failed:', e.message); }

  console.log('[provision] tenant #' + tenantId + ' (' + company + ') created — owner: ' + ownerUsername + ', 14-day trial.');
  return { tenantId, ownerUsername, trialEnd: sqlDt(trialEnd) };
}

module.exports = { provisionTenant, TRIAL_DAYS };
