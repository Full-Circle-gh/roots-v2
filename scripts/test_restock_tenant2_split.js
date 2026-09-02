#!/usr/bin/env node
// Restock on a NON-Roots tenant — the suite that actually catches the bug.
//
// ══ WHY A TENANT-2 FIXTURE EXISTS AT ALL ═══════════════════════════════════
//
// FOUR ASSERTIONS IN THIS FILE FAIL ON PRE-1588d18 CODE:
//
//     ✗ stock_applied_at stamped IN TENANT 2
//     ✗ source NOT decremented a second time by the delivered retry
//     ✗ destination NOT incremented a second time by the delivered retry
//     ✗ no duplicate ledger rows from the retry
//
// AND THE TENANT-1 SUITE (scripts/test_restock_tenant_handle.js, 54 assertions)
// PASSES COMPLETELY ON THAT SAME BROKEN CODE.
//
// That gap is the whole reason this file is here, and it is worth understanding
// before anyone decides a second fixture is redundant.
//
// Before 1588d18, routes/restock.js read and wrote every table through the
// shared global handle, while the stock movement it triggers goes through
// inventory.adjustStock on tdb(). lib/tenant-db.js returns mainDb for tenant 1,
// so on Roots those are the same connection: a query on the wrong handle still
// reads and writes the right rows, and every tenant-1 assertion passes. Nothing
// in a single-database fixture can distinguish the two handles.
//
// On any other tenant they are different database FILES, and the failure was
// not a subtle one. The stock_applied_at idempotency stamp was written with the
// shared handle from inside a transaction opened on the tenant handle, so the
// UPDATE ran against the shared database — where the order does not exist. It
// matched zero rows and reported success. The guard never engaged, and the
// 'delivered' safety-net call re-ran the entire transfer:
//
//     source shelf        80 → 71 → 62      (moved twice)
//     destination shelf    3 → 12 → 21      (moved twice)
//     ledger rows                4 → 8      (duplicated)
//
// Silent stock corruption with a duplicated audit trail, on every restock, for
// every non-Roots tenant. A tenant-1 suite reports that as green.
//
// So: when a handle is what is under test, the fixture needs two tenants. The
// scaffolding is in scripts/test-support/tenant-fixture.js precisely so the
// stock-movement work that follows does not have to re-derive this.
//
// Run:  npm run test:restock-handles     (both suites)
//       node scripts/test_restock_tenant2_split.js
//
// Cases:
//   A. the transfer reads and writes ONE database, and the shared one stays clean
//   B. the 'delivered' retry is a real no-op (the four assertions above)
//   C. a mid-transfer failure rolls back the stock AND the stamp, in tenant 2
//   D. restock_orders inserts on a tenant connection with foreign_keys = ON
//      (drop_created_by_user_fk_v1 — before that migration this was impossible)
'use strict';

const path = require('path');
const F = require('./test-support/tenant-fixture');

const { ok, eq, section, done } = F.counters();
const h = F.harness();
F.captureNotifications(h, { pushEnabled: false });
F.stubAuth(h, { id: 7, username: 't2wh', role: 'warehouse' });

const restock = require(path.join(h.REPO, 'routes/restock.js'));
const { T, raw: t2 } = F.openTenant(h, 2);

const ACTOR = { id: 7, username: 't2wh', role: 'warehouse' };
const PERMS = { restock: 1, warehouse_inbox: 1 };

// The status transition, run inside a real tenant ALS scope. A round trip over
// a socket would leave the scope at the socket boundary, and the kitchen realm
// has no tenant middleware wired, so the handler is driven directly.
const setStatus = (id, status) => F.inTenant(T, 2, () =>
  F.callRoute(restock, 'put', '/api/restock/:id/status', {
    params: { id: String(id) }, body: { status }, user: ACTOR, permissions: PERMS,
  }));

const shelf  = (s, p) => F.shelf(t2, s, p);
const ledgerCount = () => t2.prepare('SELECT COUNT(*) AS n FROM retail_stock_ledger').get().n;
const stampOf = (id) => t2.prepare('SELECT stock_applied_at FROM restock_orders WHERE id = ?').get(id).stock_applied_at;

// ── seed TENANT 2's data plane ──────────────────────────────────────────────
// initTenantSchema clones structure only (control-plane tables excluded), so
// every row below is ours. No PRAGMA workaround: foreign_keys stays ON, which
// only works because drop_created_by_user_fk_v1 removed the created_by FK.
ok(t2 !== h.db, 'tenant 2 is a genuinely different database from the shared one');
eq(t2.pragma('foreign_keys', { simple: true }), 1, 'foreign_keys is ON for the tenant connection');

t2.prepare("INSERT OR IGNORE INTO retail_stores (id,code,name_en,is_active) VALUES (1,'t2-wh','T2 Warehouse',1)").run();
t2.prepare("INSERT OR IGNORE INTO retail_stores (id,code,name_en,is_active) VALUES (2,'t2-shop','T2 Shop',1)").run();
F.seedProduct(t2, { id: 500, name: 'T2 Hummus',   sku: 'T2-500' });
F.seedProduct(t2, { id: 501, name: 'T2 Tortilla', sku: 'T2-501' });
F.setShelf(t2, 1, 500, 80); F.setShelf(t2, 2, 500, 3);
F.setShelf(t2, 1, 501, 60); F.setShelf(t2, 2, 501, 0);

// The warehouse-role user is control-plane: it lives in the SHARED database and
// its retail_store_id points at TENANT 2's retail_stores.id. That cross-plane
// reference is pre-existing and is why _resolveWarehouseStoreId still reads
// `users` off the shared handle.
h.db.prepare(`INSERT INTO users (id, username, password, role, retail_store_id, is_active)
              VALUES (7,'t2wh','x','warehouse',1,1)`).run();

(() => {
  section('Case D — restock_orders inserts on a tenant connection, foreign_keys = ON');
  // Before drop_created_by_user_fk_v1 this threw "no such table: main.users":
  // restock_orders.created_by carried a hard FK to a control-plane table that
  // is never cloned into a tenant database.
  let inserted = true, why = '';
  try {
    t2.prepare(`INSERT INTO restock_orders (id, rs_number, date, status, store_name, created_by, from_role, to_role)
                VALUES (77,'T2-RS-001','2026-09-02','received','T2 Shop', 7, 'warehouse','store')`).run();
  } catch (e) { inserted = false; why = e.message; }
  ok(inserted, 'INSERT with a non-null created_by succeeds' + (inserted ? '' : ` — ${why}`));
  eq(t2.prepare('SELECT created_by FROM restock_orders WHERE id = 77').get().created_by, 7,
     'created_by is still written and readable — the column stayed, only the FK went');
  ok(!t2.pragma('foreign_key_list(restock_orders)').some(f => f.table === 'users'),
     'restock_orders carries no FK to users on the tenant database');
})();

t2.prepare(`INSERT INTO restock_items (restock_id, product_id, product_name, sku, qty_requested)
            VALUES (77,500,'T2 Hummus','T2-500',9)`).run();
t2.prepare(`INSERT INTO restock_items (restock_id, product_id, product_name, sku, qty_requested)
            VALUES (77,501,'T2 Tortilla','T2-501',6)`).run();

(async () => {
  section('Case A — the transfer reads and writes ONE database (tenant 2)');
  eq(F.inTenant(T, 2, () => T.currentTenantId()), 2, 'ALS scope reports tenant 2');
  ok(F.inTenant(T, 2, () => T.rawTdb()) === t2, "tdb() inside the scope is tenant 2's connection");

  const out = setStatus(77, 'prepared');
  ok(out.body && out.body.success, 'status → prepared handled inside the tenant scope');
  ok(!out.body.stock_transfer, 'no stock_transfer error');

  eq(shelf(1, 500), 71, 'tenant 2 source 500 decremented (80 → 71)');
  eq(shelf(2, 500), 12, 'tenant 2 destination 500 incremented (3 → 12)');
  eq(shelf(1, 501), 54, 'tenant 2 source 501 decremented (60 → 54)');
  eq(shelf(2, 501),  6, 'tenant 2 destination 501 incremented (0 → 6)');
  ok(!!stampOf(77), 'stock_applied_at stamped IN TENANT 2');          // ← fails pre-1588d18

  eq(h.db.prepare('SELECT COUNT(*) AS n FROM restock_orders WHERE id = 77').get().n, 0,
     'the shared database has no copy of the order (nothing was cross-written)');
  eq(h.db.prepare('SELECT COUNT(*) AS n FROM retail_stock_ledger').get().n, 0,
     'the shared database got no ledger rows');

  section('Case B — the delivered retry is a real no-op');
  // THE CONSEQUENCE of the stamp landing in the wrong database: the guard never
  // engaged, so this safety-net call used to move the stock a second time.
  const after = { wh: shelf(1, 500), sh: shelf(2, 500), ledger: ledgerCount() };
  const again = setStatus(77, 'delivered');
  ok(again.body && again.body.success, 'status → delivered accepted');
  eq(shelf(1, 500), after.wh,     'source NOT decremented a second time by the delivered retry');   // ← fails pre-1588d18
  eq(shelf(2, 500), after.sh,     'destination NOT incremented a second time by the delivered retry'); // ← fails pre-1588d18
  eq(ledgerCount(), after.ledger, 'no duplicate ledger rows from the retry');                        // ← fails pre-1588d18

  section('Case C — a mid-transfer failure rolls back the stamp too, in tenant 2');
  t2.prepare(`INSERT INTO restock_orders (id, rs_number, date, status, store_name, created_by, from_role, to_role)
              VALUES (78,'T2-RS-002','2026-09-02','received','T2 Shop', 7, 'warehouse','store')`).run();
  t2.prepare(`INSERT INTO restock_items (restock_id, product_id, product_name, sku, qty_requested)
              VALUES (78,501,'T2 Tortilla','T2-501',5)`).run();
  t2.exec(`CREATE TRIGGER _boom2 BEFORE INSERT ON retail_stock_ledger
           WHEN NEW.product_id = 501 AND NEW.reason = 'restock_transfer_in'
           BEGIN SELECT RAISE(ABORT,'simulated'); END`);
  const b = { wh: shelf(1, 501), sh: shelf(2, 501) };
  const failed = setStatus(78, 'prepared');
  ok(failed.body.stock_transfer && failed.body.stock_transfer.ok === false, 'failure reported to the caller');
  eq(shelf(1, 501), b.wh, 'tenant 2 source rolled back');
  eq(shelf(2, 501), b.sh, 'tenant 2 destination rolled back');
  ok(!stampOf(78), 'stock_applied_at rolled back WITH the stock — the order stays retryable');
  t2.exec('DROP TRIGGER _boom2');

  section('Case E — routes/production.js writes to the tenant, not the shared db');
  // Production is about to start moving real stock, so it is on tdb() before
  // that happens rather than after. Today the only damage a wrong handle does
  // is misfile the log; the assertions are the same either way.
  const production = require(path.join(h.REPO, 'routes/production.js'));
  t2.prepare("INSERT INTO recipes (id, name_en, sku, servings) VALUES (4242,'T2 Soup','T2-R-4242',20)").run();
  const sharedBatchesBefore = h.db.prepare('SELECT COUNT(*) AS n FROM production_batches').get().n;

  const logged = F.inTenant(T, 2, () =>
    F.callRoute(production, 'post', '/api/production', {
      body: { date: '2026-09-02', recipe_id: 4242, batches_made: 3 },
      user: ACTOR, permissions: { kitchen: 1 },
    }));
  ok(logged.body && logged.body.success, 'batch logged inside the tenant scope');
  eq(t2.prepare('SELECT COUNT(*) AS n FROM production_batches').get().n, 1,
     'the batch landed in TENANT 2');
  eq(h.db.prepare('SELECT COUNT(*) AS n FROM production_batches').get().n, sharedBatchesBefore,
     'the shared database got no batch row');
  // Read back defensively: on a wrong handle there is no row at all, and an
  // assertion that throws reports worse than one that fails.
  const batch = t2.prepare('SELECT * FROM production_batches ORDER BY id DESC LIMIT 1').get() || {};
  eq(batch.recipe_name, 'T2 Soup', 'the recipe was resolved from the tenant catalogue, not the shared one');
  eq(batch.servings_made, 60, 'servings derived from the tenant recipe (3 × 20)');
  eq(batch.created_by, 7, 'created_by written with foreign_keys ON — no FK to users any more');

  const listed = F.inTenant(T, 2, () =>
    F.callRoute(production, 'get', '/api/production', { user: ACTOR, permissions: { kitchen: 1 } }));
  eq(((listed.body || {}).data || []).length, 1,
     'the list endpoint reads the tenant, and sees exactly its own row');

  done();
})().catch(e => { console.error(e); process.exit(1); });
