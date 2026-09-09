#!/usr/bin/env node
/**
 * The kitchen-list clear — what it empties, and what it must leave alone.
 *
 *   node scripts/test_clear_kitchen_lists.js
 *
 * scripts/clear_kitchen_lists.js empties the three kitchen-request lists by
 * stamping `archived_at` on the kitchen-bound orders. That one UPDATE is the
 * whole script, and it ships to the production box on every deploy (scripts/ is
 * in the deploy allowlist), so what it reaches is worth pinning down.
 *
 * TWO THINGS ARE ASSERTED, AND THEY ARE DIFFERENT KINDS OF THING.
 *
 * That it empties all three lists is arithmetic: the fixture carries a row for
 * each list and the counts go to zero. That it stops there is the part worth
 * having a suite for — an UPDATE with one condition too few reaches the store's
 * transfers as well, and the difference between the right sweep and that one is
 * a single AND nobody would see in review. The bulk-archive endpoint it is NOT
 * built on (POST /api/restock/archive-bulk) has exactly that shape: no
 * direction filter, every direction swept.
 *
 * THE LEGACY ROW IS THE ONE THAT CATCHES A NAIVE FIX. `to_role` arrived by
 * migration, so a row raised before it reads NULL, and every reader in the app
 * coalesces it to 'warehouse' rather than comparing the column raw. A sweep
 * written as `to_role = 'kitchen'` passes every other case here and still
 * quietly means something different from what the lists show; one written as
 * `to_role != 'warehouse'` archives those legacy store rows outright. RS2 is in
 * the fixture for that reason and no other.
 *
 * WHY THE SQL IS READ OUT OF THE SCRIPT rather than retyped: a suite carrying
 * its own copy of the statement proves the copy correct and says nothing about
 * what runs on the box. Same rule as lib/kitchen-ready.js itself, which exists
 * so the fire, the dot and the list cannot disagree.
 *
 * NO NATIVE BINDING NEEDED — it runs on the shared in-memory opener, which
 * falls back to node:sqlite where better-sqlite3 is not built (test-support/
 * memory-db.js). The house rule: no install, no network, safe to run anywhere.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const F = require('./test-support/tenant-fixture');
const M = require('./test-support/memory-db');
const kitchenReady = require('../lib/kitchen-ready');

const { ok, eq, section, done } = F.counters();
const REPO = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(REPO, 'scripts', 'clear_kitchen_lists.js'), 'utf8');

console.log(`(driver: ${M.driver})`);

section('The script reads the lists it claims to empty');

// The Ready clause is shared, not copied. A second copy of it here — or in the
// script — is the drift lib/kitchen-ready.js was written to end.
ok(/kitchenReady\.KITCHEN_READY_WHERE/.test(SRC),
   'the Ready count comes from lib/kitchen-ready.js, not a copy of its clause');
ok(!/i\.seen_at IS NULL/.test(SRC),
   'and the clause itself is not retyped in the script');

section('The guards a destructive script ships with (decisions §24)');

ok(/--confirm/.test(SRC) && /REFUSED/.test(SRC),
   '--apply refuses without a token from a preview of the same database');
ok(/copyFileSync/.test(SRC), 'the database is backed up before anything is written');
ok(!/DELETE\s+FROM/i.test(SRC), 'nothing is deleted — this is a soft archive only');

// The one promise made to Ash in the request that prompted this: don't touch
// the stock. A script that names a stock table cannot be keeping it.
ok(!/retail_store_stock|retail_stock_ledger|stock_movements/.test(SRC),
   'no stock table is named anywhere in the script');

section('What the sweep reaches');

// The statements under test, lifted from the script verbatim.
const SWEEP = (SRC.match(/UPDATE restock_orders\s+SET archived_at[\s\S]*?= 'kitchen'/) || [])[0];
ok(!!SWEEP, 'the sweep UPDATE was found in the script');
// The count carries the script's own `KITCHEN` constant by interpolation, so it
// is lifted with it rather than around it: the direction test is the thing being
// checked, and substituting a hand-written one here would test this file.
const KITCHEN = (SRC.match(/const KITCHEN = `([\s\S]*?)`/) || [])[1];
ok(/COALESCE\(\s*r\.to_role,\s*'warehouse'\s*\)\s*=\s*'kitchen'/.test(KITCHEN || ''),
   'the direction test coalesces a NULL to_role the way every reader in the app does');
const ACTIVE_SQL = ((SRC.match(/const ACTIVE_SQL = `([\s\S]*?)`/) || [])[1] || '')
  .replace(/\$\{KITCHEN\}/g, KITCHEN);
ok(!!ACTIVE_SQL && !ACTIVE_SQL.includes('${'), 'the Waiting/Queue count was found in the script');

// Stop HERE if either statement could not be lifted, rather than carrying an
// undefined into prepare() and reporting a crash where a failure belongs. The
// statements are matched by shape, so an edit that rewrites the sweep is
// exactly when this fires — and a stack trace is a poor way to be told.
if (!SWEEP || !ACTIVE_SQL || !KITCHEN) {
  console.log('\n  the statements under test could not be read — nothing below can run');
  done();
}

// Real table definitions: schema.sql's CREATE plus every column database.js has
// bolted on since — which is where to_role, archived_at and seen_at come from.
const db = M.openTablesDb(
  fs.readFileSync(path.join(REPO, 'database.js'), 'utf8'),
  []);
M.addTables(db,
  fs.readFileSync(path.join(REPO, 'schema.sql'), 'utf8'),
  fs.readFileSync(path.join(REPO, 'database.js'), 'utf8'),
  ['restock_orders', 'restock_items']);

const cols = db.prepare('PRAGMA table_info(restock_orders)').all().map(c => c.name);
for (const c of ['to_role', 'archived_at', 'seen_at']) {
  ok(cols.includes(c), `restock_orders carries ${c} (bolted on by database.js)`);
}

const addOrder = (rs, status, toRole, archivedAt, preparedAt) => db.prepare(
  `INSERT INTO restock_orders (rs_number, date, status, from_role, to_role, archived_at, prepared_at)
   VALUES (?, '2026-09-09', ?, 'warehouse', ?, ?, ?)`).run(rs, status, toRole, archivedAt, preparedAt)
  .lastInsertRowid;
const addItem = (id, name, status, preparedAt) => db.prepare(
  `INSERT INTO restock_items (restock_id, product_name, qty_requested, status, prepared_at)
   VALUES (?, ?, 1, ?, ?)`).run(id, name, status, preparedAt);

// One row per list, plus the two that must survive.
addItem(addOrder('PR1', 'sent', 'kitchen', null, null), 'Jam', 'sent', null);            // Waiting/Queue
addItem(addOrder('PR2', 'prepared', 'kitchen', null, '2026-09-09'), 'Bread', 'prepared', '2026-09-09'); // Ready
const split = addOrder('PR3', 'sent', 'kitchen', null, null);                            // both at once
addItem(split, 'Sauce', 'prepared', '2026-09-09');
addItem(split, 'Stock', 'sent', null);
addItem(addOrder('PR4', 'draft', 'kitchen', null, null), 'Curd', 'sent', null);          // unsent draft
addItem(addOrder('PR5', 'sent', 'kitchen', '2026-09-08', null), 'Old', 'sent', null);    // already archived
addItem(addOrder('RS1', 'sent', 'warehouse', null, null), 'Cups', 'sent', null);         // other direction
addItem(addOrder('RS2', 'sent', null, null, null), 'Lids', 'sent', null);                // LEGACY: to_role NULL

const readyN = () => db.prepare(
  `SELECT COUNT(*) n FROM ${kitchenReady.KITCHEN_READY_FROM} WHERE ${kitchenReady.KITCHEN_READY_WHERE}`).get().n;
const activeN = () => db.prepare(ACTIVE_SQL).get().n;
const unarchived = () => db.prepare(
  'SELECT rs_number FROM restock_orders WHERE archived_at IS NULL ORDER BY rs_number').all()
  .map(r => r.rs_number);

eq(readyN(), 2, 'before: Ready from the kitchen shows the finished lines');
eq(activeN(), 3, 'before: Waiting / Kitchen queue shows the unfinished requests');

db.prepare(SWEEP).run('2026-09-09T10:00:00Z');

section('…and afterwards');

eq(readyN(), 0, 'Ready from the kitchen is empty');
eq(activeN(), 0, 'Waiting on the kitchen is empty');
eq(activeN(), 0, 'Kitchen queue is empty (the same rows, read from the kitchen side)');

// The point of the whole suite.
const left = unarchived();
eq(left.join(','), 'RS1,RS2',
   'the store→warehouse rows are the only ones left — including the legacy NULL to_role');

eq(db.prepare('SELECT COUNT(*) n FROM restock_orders').get().n, 7, 'no order row was deleted');
eq(db.prepare('SELECT COUNT(*) n FROM restock_items').get().n, 8, 'no item row was deleted');

// An archived row is a record of WHEN it was archived. Restamping PR5 would
// rewrite a fact about a day the sweep did not happen on.
eq(db.prepare(`SELECT archived_at FROM restock_orders WHERE rs_number = 'PR5'`).get().archived_at,
   '2026-09-08', 'a row archived earlier keeps its own stamp');

// Nothing here restores by hand: the app's own unarchive puts a row back, and
// if it does not, "nothing was destroyed" is not true in any useful sense.
db.prepare(`UPDATE restock_orders SET archived_at = NULL WHERE rs_number = 'PR2'`).run();
eq(readyN(), 1, 'unarchiving a row puts it back on the list it came from');

done();
