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
//
// DATABASE SEAM — READ BEFORE WRAPPING ANYTHING HERE. The money-unit converter
// (decisions §24) installs into lib/db-seam.js, and tdb()/getTenantDb() are the
// next handles due to be routed through it. Two hard constraints when that
// happens, both because identity is load-bearing here:
//
//   * tenantAls.run() must receive a RAW handle, never a wrapper. currentTenantId()
//     compares the ALS store against mainDb by identity.
//   * dbToId is keyed by RAW handle, never a wrapper.
//
// Roughly fifteen call sites outside this file pass getTenantDb(tid) straight
// into tenantAls.run(...) — routes/retail.js, lib/inventory.js,
// middleware/public-tenant.js. Wrapping getTenantDb() without giving those a raw
// accessor at the same time puts wrappers into the ALS. That is a behaviour
// change, not a refactor: stop and raise it rather than doing it quietly.
const tenantAls = new AsyncLocalStorage();
function tdb() { return tenantAls.getStore() || mainDb; }

const ROOTS_TENANT_ID = 1;

// Reverse map: connection → tenant id. The ALS stores the *connection* (so
// tdb() stays a one-liner and the existing tenantAls.run(db, …) call sites are
// untouched), but per-tenant credential resolution needs the id. We populate
// this whenever getTenantDb() hands out a connection; currentTenantId() reads
// it back out of the active ALS scope. Outside any scope → Roots.
const dbToId = new Map();
const TENANTS_DIR = path.join(__dirname, '..', 'data', 'tenants');
const DATA_ISOLATION_READY = process.env.TENANT_DATA_ISOLATION === '1';

// Tables that belong to the shared CONTROL plane — never cloned per-tenant.
const CONTROL_PLANE_TABLES = new Set([
  'tenants', 'tenant_users', 'tenant_secrets', 'tenant_onboarding',
  'tenant_integrations', 'integration_help_requests', 'integration_sessions',
  'billing_plans', 'billing_subscriptions', 'billing_invoices', 'billing_reminders',
  'users', 'sessions', 'permissions', 'activity_log',
]);

const cache = new Map();   // tenantId -> better-sqlite3 connection

function ensureDir() { if (!fs.existsSync(TENANTS_DIR)) fs.mkdirSync(TENANTS_DIR, { recursive: true }); }
function pathForTenant(id) { return path.join(TENANTS_DIR, String(id) + '.db'); }

// Sync the main DB's data-plane table + index definitions (structure only)
// into a tenant DB. Runs on EVERY open, not just on first creation, so that
// schema additions made after a tenant was provisioned (new tables/indexes)
// self-heal on the next boot instead of throwing at query time. Only objects
// MISSING from the tenant DB are created; existing ones are left untouched.
// Tables first, then indexes; control-plane tables skipped.
function initTenantSchema(db) {
  const objs = mainDb.prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table','index') " +
    "ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name"
  ).all();
  const have = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all().map(r => r.name)
  );
  const tx = db.transaction(() => {
    for (const o of objs) {
      if (!o.name || o.name.startsWith('sqlite_')) continue;
      if (have.has(o.name)) continue;                       // already present
      if (o.type === 'table' && CONTROL_PLANE_TABLES.has(o.name)) continue;
      // Indexes on skipped tables will throw "no such table" — swallow those.
      try { db.exec(o.sql); } catch (e) { /* skip control-plane / incompatible objects */ }
    }
  });
  tx();
}

// Generic column self-heal. initTenantSchema only creates MISSING tables — it
// never adds a column to a table the tenant DB already has. So every column
// added later (via database.js addColumn) was absent from older tenant DBs,
// and any query referencing it 500'd for those tenants (e.g. retail_feedback
// .initiated_by, retail_stores.open_time/close_time/timezone). This diffs each
// shared data-plane table against the main DB and adds whatever's missing, so
// ALL late columns heal — not a hand-maintained list. Runs on every open;
// ALTER TABLE ADD COLUMN persists, so a tenant DB is fixed on first access.
function reconcileTenantColumns(db) {
  let tables;
  try {
    tables = mainDb.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).all().map(r => r.name);
  } catch (_) { return; }
  for (const t of tables) {
    if (CONTROL_PLANE_TABLES.has(t)) continue;
    let have, mainCols;
    try {
      have = new Set(db.prepare('SELECT name FROM pragma_table_info(?)').all(t).map(r => r.name));
      if (!have.size) continue;   // tenant doesn't have this table (control-plane / skipped) → leave it
      mainCols = mainDb.prepare('SELECT name, type, dflt_value FROM pragma_table_info(?)').all(t);
    } catch (_) { continue; }
    for (const c of mainCols) {
      if (have.has(c.name)) continue;
      const type = c.type || '';
      const dflt = c.dflt_value != null ? ` DEFAULT ${c.dflt_value}` : '';
      try {
        db.exec(`ALTER TABLE "${t}" ADD COLUMN "${c.name}" ${type}${dflt}`);
      } catch (e) {
        if (/duplicate column/i.test(e.message)) continue;
        // A non-constant default (e.g. CURRENT_TIMESTAMP) can't be added via
        // ALTER — add the column nullable so the schema still lines up.
        try { db.exec(`ALTER TABLE "${t}" ADD COLUMN "${c.name}" ${type}`); }
        catch (e2) { if (!/duplicate column/i.test(e2.message)) console.warn('[tenant-db reconcile]', t, c.name, e2.message); }
      }
    }
  }
}

function openTenantDb(id) {
  ensureDir();
  const db = new Database(pathForTenant(id));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initTenantSchema(db);   // create the file's schema if fresh; backfill missing tables otherwise
  reconcileTenantColumns(db);   // add any columns that postdate the tenant DB's creation
  // Repoint Meituan product_id FKs products(id) → store_products(id) for tenant
  // DBs created before the storefront catalog fork (initTenantSchema only adds
  // MISSING tables, never rebuilds an existing one's constraints).
  if (typeof mainDb.repointMeituanProductFk === 'function') {
    for (const t of ['meituan_product_map', 'meituan_bundle_components', 'meituan_sync_queue']) {
      try { mainDb.repointMeituanProductFk(db, t); } catch (e) { /* best-effort */ }
    }
  }
  return db;
}

// Resolve the data-plane connection for a tenant. Roots → shared roots.db.
function getTenantDb(tenantId) {
  const id = Number(tenantId);
  if (!id || id === ROOTS_TENANT_ID) return mainDb;
  if (cache.has(id)) return cache.get(id);
  const db = openTenantDb(id);
  cache.set(id, db);
  dbToId.set(db, id);
  return db;
}

// The tenant id for the active request scope (or Roots when unscoped). Mirrors
// tdb(): tdb() gives the connection, currentTenantId() gives the matching id.
function currentTenantId() {
  const store = tenantAls.getStore();
  if (!store || store === mainDb) return ROOTS_TENANT_ID;
  return dbToId.get(store) || ROOTS_TENANT_ID;
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
  tenantAls, tdb, currentTenantId,
};
