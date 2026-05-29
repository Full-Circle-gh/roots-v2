// Per-tenant SQLite connection router — DB-per-tenant isolation (Phase 2).
//
// Tenant #1 (Roots) keeps using the shared main roots.db, so the integrated
// kitchen + backend are completely unchanged. Every OTHER tenant gets its own
// file at data/tenants/<id>.db, created from the main DB's *schema only*
// (structure, no rows) on first open. Connections are cached per tenant.
//
// Control-plane tables (tenants, tenant_users, billing_*, kitchen users /
// sessions / permissions / activity_log) live ONLY in the shared roots.db and
// are never cloned into a tenant DB — they're cross-tenant by design.
//
// DATA_ISOLATION_READY gates the cut-over: until the data routes are actually
// routed through these per-tenant connections (Phase 2 slice 2), non-Roots
// tenants are held out of the shared data backend so nothing can leak. Flip it
// on with TENANT_DATA_ISOLATION=1 once the route refactor is live.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');
const mainDb = require('../database');

// Request-scoped tenant connection. The gate enters a context per request
// (tenantAls.run(conn, …)); data handlers then call tdb() to get the right
// connection WITHOUT threading it through every function. Outside any context
// (public endpoints, module load) tdb() is the shared global db. Crucially,
// getTenantDb(1) === mainDb, so for Roots tdb() is ALWAYS the global db —
// production behaviour is unchanged regardless of how broadly tdb() is used.
const tenantAls = new AsyncLocalStorage();
function tdb() { return tenantAls.getStore() || mainDb; }

const ROOTS_TENANT_ID = 1;
const TENANTS_DIR = path.join(__dirname, '..', 'data', 'tenants');
const DATA_ISOLATION_READY = process.env.TENANT_DATA_ISOLATION === '1';

// Tables that belong to the shared CONTROL plane — never cloned per-tenant.
const CONTROL_PLANE_TABLES = new Set([
  'tenants', 'tenant_users', 'tenant_secrets', 'tenant_onboarding',
  'billing_plans', 'billing_subscriptions', 'billing_invoices', 'billing_reminders',
  'users', 'sessions', 'permissions', 'activity_log',
]);

const cache = new Map();   // tenantId -> better-sqlite3 connection

function ensureDir() { if (!fs.existsSync(TENANTS_DIR)) fs.mkdirSync(TENANTS_DIR, { recursive: true }); }
function pathForTenant(id) { return path.join(TENANTS_DIR, String(id) + '.db'); }

// Clone the main DB's table + index definitions (structure only) into a fresh
// tenant DB. Tables first, then indexes; control-plane tables skipped.
function initTenantSchema(db) {
  const objs = mainDb.prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table','index') " +
    "ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name"
  ).all();
  const tx = db.transaction(() => {
    for (const o of objs) {
      if (!o.name || o.name.startsWith('sqlite_')) continue;
      if (o.type === 'table' && CONTROL_PLANE_TABLES.has(o.name)) continue;
      // Indexes on skipped tables will throw "no such table" — swallow those.
      try { db.exec(o.sql); } catch (e) { /* skip control-plane / incompatible objects */ }
    }
  });
  tx();
}

function openTenantDb(id) {
  ensureDir();
  const p = pathForTenant(id);
  const fresh = !fs.existsSync(p);
  const db = new Database(p);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  if (fresh) initTenantSchema(db);
  return db;
}

// Resolve the data-plane connection for a tenant. Roots → shared roots.db.
function getTenantDb(tenantId) {
  const id = Number(tenantId);
  if (!id || id === ROOTS_TENANT_ID) return mainDb;
  if (cache.has(id)) return cache.get(id);
  const db = openTenantDb(id);
  cache.set(id, db);
  return db;
}

// Express middleware (used by data routes once the cut-over happens) — attaches
// the right connection to req.tenantDb based on the backend session's tenant.
function attachTenantDb(req, res, next) {
  const tid = req.session?.tenantId || (req.tenant && req.tenant.id) || ROOTS_TENANT_ID;
  req.tenantDb = getTenantDb(tid);
  next();
}

module.exports = {
  getTenantDb, attachTenantDb, openTenantDb, initTenantSchema, pathForTenant,
  ROOTS_TENANT_ID, DATA_ISOLATION_READY, CONTROL_PLANE_TABLES,
  tenantAls, tdb,
};
