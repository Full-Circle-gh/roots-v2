// Two-tenant scaffolding for the suites that have to prove a handle is right.
//
// WHY THIS IS A MODULE AND NOT INLINE SETUP
// -----------------------------------------
// A bug that only appears on a NON-Roots tenant cannot be caught by a
// single-database fixture. For tenant 1, tdb() and the shared `db` are the same
// connection, so a query on the wrong handle still reads and writes the right
// rows — every assertion passes and the suite looks green. The split only shows
// once there is a second tenant with its own database file.
//
// routes/restock.js is the worked example (see test_restock_tenant2_split.js),
// and the same scaffolding is needed by the stock-movement work that follows,
// so the setup lives here rather than being copied into each suite. The pieces
// are deliberately separate: a suite that only needs tenant 1 calls harness()
// and stops there.
//
// HOUSE RULES THIS KEEPS
// ----------------------
//   * Never touch data/roots.db. Each harness gets its own scratch directory
//     with its own database.js copy, so the app's real database path resolves
//     inside the scratch dir. Same trick scripts/test_undo_receive_clears.js
//     uses, and for the same reason: scripts/ is deployed.
//   * The tenant database DOES land in the repo's real data/tenants/ — that
//     path is resolved from lib/tenant-db.js's own __dirname, which the symlink
//     does not redirect. cleanup() removes it, including the -wal/-shm
//     sidecars, and is registered on process exit.
//   * tenantAls.run() is only ever entered with a RAW handle, via
//     rawTenantDb(id) inline — the shape scripts/check-tenant-als.js enforces.
'use strict';

const fs   = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');

// ── assertions ──────────────────────────────────────────────────────────────
// Shared so every suite reports in one format and exits on the same rule.
function counters() {
  const state = { pass: 0, fail: 0 };
  const ok = (cond, msg) => {
    if (cond) { state.pass++; console.log('  ✓ ' + msg); }
    else      { state.fail++; console.log('  ✗ ' + msg); }
    return !!cond;
  };
  const eq = (actual, expected, msg) =>
    ok(actual === expected, `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  const section = (title) => console.log('\n' + title);
  const done = () => {
    console.log(`\n${state.pass} passed, ${state.fail} failed`);
    process.exit(state.fail ? 1 : 0);
  };
  return { ok, eq, section, done, state };
}

// ── harness ─────────────────────────────────────────────────────────────────
// Builds a scratch database from the REAL database.js + schema.sql (so every
// migration runs exactly as it does in production), then makes that handle BE
// '../database' for every module required afterwards.
//
// Call this FIRST, before requiring anything from routes/ or lib/.
function harness() {
  const SCRATCH = path.join(REPO, `.test-scratch-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  fs.copyFileSync(path.join(REPO, 'database.js'), path.join(SCRATCH, 'database.js'));
  fs.copyFileSync(path.join(REPO, 'schema.sql'),  path.join(SCRATCH, 'schema.sql'));
  try { fs.symlinkSync(path.join(REPO, 'lib'), path.join(SCRATCH, 'lib'), 'dir'); } catch { /* already linked */ }

  const tenantFiles = [];
  const cleanup = () => {
    try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* gone */ }
    for (const f of tenantFiles) {
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(f + suffix, { force: true }); } catch { /* gone */ }
      }
    }
  };
  process.on('exit', cleanup);

  const db = require(path.join(SCRATCH, 'database.js'));
  const realDbPath = require.resolve(path.join(REPO, 'database.js'));
  require.cache[realDbPath] = {
    id: realDbPath, filename: realDbPath, path: REPO,
    loaded: true, children: [], paths: [], exports: db,
  };

  // Replace a repo module's exports for everything required afterwards.
  const stub = (rel, exports) => {
    const p = require.resolve(path.join(REPO, rel));
    require.cache[p] = {
      id: p, filename: p, path: path.dirname(p),
      loaded: true, children: [], paths: [], exports,
    };
    return exports;
  };

  return { db, stub, cleanup, SCRATCH, REPO, _tenantFiles: tenantFiles };
}

// ── the notification capture every restock-shaped suite wants ───────────────
// Returns the arrays the stubs push into, so a suite can assert on the audience
// without standing up SSE or web-push. Stub BEFORE requiring the route.
function captureNotifications(h, { pushEnabled = true } = {}) {
  const sse  = [];
  const push = [];
  h.stub('routes/events.js', { broadcast: (chan, payload, opts) => sse.push({ chan, payload, opts }) });
  h.stub('routes/push.js',   { ENABLED: pushEnabled, sendPushByPermission: (perm, msg) => push.push({ perm, msg }) });
  return { sse, push };
}

// ── auth ────────────────────────────────────────────────────────────────────
// A fixed actor, so a suite drives real handlers without a session. `actor` is
// mutable by the caller between requests when a suite needs a different role.
function stubAuth(h, actor, permissions = { restock: 1, warehouse_inbox: 1, kitchen_inbox: 1 }) {
  const state = { actor, permissions };
  h.stub('middleware/auth.js', {
    requireAuth: (req, res, next) => { req.user = state.actor; req.permissions = state.permissions; next(); },
    requirePermission: () => (req, res, next) => next(),
    requireDelete: (req, res, next) => next(),
    requireAdmin:  (req, res, next) => next(),
    logActivity: () => {},
  });
  return state;
}

// ── tenant 2 ────────────────────────────────────────────────────────────────
// A genuinely separate database file, created by lib/tenant-db.js's own opener
// so the schema clone (control-plane tables excluded) happens for real.
//
// Returns the RAW handle. Callers pass it nowhere near tenantAls directly —
// use inTenant() below, which re-derives it inline.
function openTenant(h, tenantId = 2) {
  const T = require(path.join(h.REPO, 'lib/tenant-db.js'));
  const raw = T.rawTenantDb(tenantId);
  h._tenantFiles.push(path.join(h.REPO, 'data', 'tenants', `${tenantId}.db`));
  return { T, raw, tenantId };
}

// Run fn inside a real tenant ALS scope. rawTenantDb() is called INLINE here on
// purpose: scripts/check-tenant-als.js scans for exactly this shape, and a
// handle passed through a variable would read as a possible wrapper.
function inTenant(T, tenantId, fn) {
  return T.tenantAls.run(T.rawTenantDb(tenantId), fn);
}

// ── seeding ─────────────────────────────────────────────────────────────────
// A product that exists in BOTH catalogues under the same id. That is the
// normal, transferable case: routes/restock.js lines carry a kitchen
// products.id but every stock table is keyed on store_products.id, and the two
// are separate AUTOINCREMENT counters over one integer space.
//
// Pass a different storeSku to build the MISMATCH case the transfer guard
// (_checkTransferIds) exists to refuse.
function seedProduct(conn, { id, name, sku, storeName = null, storeSku = null }) {
  conn.prepare('INSERT INTO products (id, name_en, sku) VALUES (?,?,?)').run(id, name, sku);
  conn.prepare('INSERT INTO store_products (id, name_en, sku) VALUES (?,?,?)')
      .run(id, storeName || name, storeSku === null ? sku : storeSku);
}

function setShelf(conn, storeId, productId, qty) {
  conn.prepare(`INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (?,?,?)
                ON CONFLICT(store_id, product_id) DO UPDATE SET physical_qty = excluded.physical_qty`)
      .run(storeId, productId, qty);
}

function shelf(conn, storeId, productId) {
  const r = conn.prepare('SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?')
                .get(storeId, productId);
  return r ? r.physical_qty : null;
}

function ledgerFor(conn, storeId, productId) {
  return conn.prepare(`SELECT delta, reason, balance_after, note, actor_user_id
                         FROM retail_stock_ledger
                        WHERE store_id = ? AND product_id = ? ORDER BY id`).all(storeId, productId);
}

// ── driving a mounted router without a socket ───────────────────────────────
// Finds one route on an express Router and runs its FINAL handler with a
// minimal req/res. Used where the request must run inside a tenant ALS scope —
// a real HTTP round trip would leave the scope at the socket boundary, and
// this repo has no tenant middleware wired for the kitchen realm.
function callRoute(router, method, routePath, { params = {}, body = {}, user, permissions, ip = '::1' } = {}) {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method.toUpperCase()} route ${routePath} on this router`);
  let captured = null;
  let statusCode = 200;
  const req = { params, body, query: {}, user, permissions, ip };
  const res = {
    json: (b) => { captured = b; return res; },
    status: (c) => { statusCode = c; return res; },
    // Header setters as chainable no-ops. Handlers that set cache or content
    // headers before answering (the dashboard ops endpoint sets Cache-Control)
    // would otherwise throw "res.set is not a function" and take the assertion
    // down with them. Nothing here asserts on headers; these exist so a handler
    // that touches them can still be driven.
    set: () => res,
    setHeader: () => res,
    type: () => res,
    send: (b) => { captured = b; return res; },
  };
  const handlers = layer.route.stack.map(s => s.handle);
  handlers[handlers.length - 1](req, res, () => {});
  return { status: statusCode, body: captured };
}

module.exports = {
  counters, harness, captureNotifications, stubAuth,
  openTenant, inTenant,
  seedProduct, setShelf, shelf, ledgerFor,
  callRoute,
};
