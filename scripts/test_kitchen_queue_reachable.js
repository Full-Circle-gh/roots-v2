#!/usr/bin/env node
/**
 * The kitchen can reach the kitchen queue.
 *
 *   node scripts/test_kitchen_queue_reachable.js
 *
 * #262 built the kitchen's queue into /stock and gated it on `restock:fulfil`.
 * Ash opened it on a phone, on a kitchen account, and found nothing — not an
 * empty queue: no tile, no screen, no way in. "i don't even see the screen where
 * i can see it."
 *
 * THREE SEPARATE THINGS WERE IN THE WAY, and any one of them alone is enough to
 * hide the queue completely. That is what makes them worth a file: each is
 * silent, each is in a different layer, and fixing any two still shows nothing.
 *
 *   1. THE ROLE NEVER HELD THE CAPABILITY. PRESETS.kitchen was ['quickstock:add'].
 *      #262 added `restock:fulfil` to the registry and mapped the routes to it
 *      and never granted it to anybody. Worse than a refusal: an operator with
 *      NEITHER fulfil nor pick is not _kitchenScopedSession either, so had the
 *      other two blockers lifted they would have been read as a full transfer
 *      operator rather than a confined one.
 *
 *   2. THE SEEDED ROLE ROW WOULD NOT HAVE PICKED IT UP. tenant_roles is seeded
 *      INSERT OR IGNORE, so every tenant that already has a kitchen role keeps
 *      the caps written the day it was seeded. Changing the preset reaches new
 *      tenants only. The migration is what reaches Roots.
 *
 *   3. THE REQUEST NEVER REACHED THE ROUTE. The stock-app-only gate in server.js
 *      runs on every request and answers `kitchen_add_only` to anything off its
 *      list. /api/restock was not on it, so the queue's own calls were refused
 *      before the capability layer got a look.
 *
 * What is asserted below is the real preset, the real migration logic against a
 * real sqlite database, and the real allowlist predicate.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const caps = require(path.join(ROOT, 'lib', 'capabilities.js'));
const { stockAppOnlyAllows } = require(path.join(ROOT, 'lib', 'stock-app-only.js'));

let failures = 0, passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── 1. The role's shipped capabilities ─────────────────────────────────────
section('The kitchen role can fulfil, and cannot pick');

const kitchenCaps = caps.PRESETS.kitchen;

check('kitchen holds restock:fulfil — the queue is gated on exactly this', () => {
  assert.ok(kitchenCaps.indexOf('restock:fulfil') >= 0,
    `kitchen preset is ${JSON.stringify(kitchenCaps)}`);
});

// The asymmetry is not incidental: _kitchenScopedSession is `fulfil && !pick`.
// Grant both and the confinement evaporates and they can dispatch a van.
check('and NOT restock:pick — the confinement is the absence of it', () => {
  assert.ok(kitchenCaps.indexOf('restock:pick') < 0,
    'kitchen holding pick would stop being kitchen-scoped and could dispatch transfers');
});

check('it still logs what it made', () => {
  assert.ok(kitchenCaps.indexOf('quickstock:add') >= 0, 'lost quickstock:add');
});

/* THE THIRD TIME THIS SHAPE HAS GONE RED FOR A CORRECT CHANGE, and the second
   in this file. It asserted the literal pair, so `production:log` — a capability
   this role must hold, or the Production screen is invisible to the only people
   with anything to put in it — turned it red the moment it was granted. That is
   a change-detector, not a test: exactly what the store_stock case above was
   before it was rewritten, and the reason it sat red for weeks.

   THE PROPERTY IS THE CEILING, NOT THE LIST. What matters is that a kitchen
   operator stays confined to the kitchen's own jobs — make things, record what
   was made, put them on the shelf — and never acquires the backend: no orders,
   no money, no products, no settings, and above all no `restock:pick`, which is
   what would let them dispatch a van. Growing the kitchen's own tools is
   allowed and expected; growing sideways is not. */
check('and gains nothing outside the kitchen’s own work', () => {
  const KITCHEN_WORK = ['quickstock:add', 'restock:fulfil', 'production:log'];
  const extra = kitchenCaps.filter(k => KITCHEN_WORK.indexOf(k) < 0);
  assert.deepStrictEqual(extra, [],
    `kitchen gained ${JSON.stringify(extra)} — beyond making, recording and shelving`);
});

/* THE KITCHEN'S GRANT DID NOT LEAK INTO THE OTHER RESTRICTED STOCKER, which is
   the property this case was always about — the two roles are refused each
   other's job, and a change to one must not quietly widen the other.

   IT USED TO ASSERT THE WHOLE LIST, and that made it a change-detector rather
   than a test. store_stock legitimately grew `restock:request` and
   `restock:receive` in "The restock notifications reach the people who do the
   work" — the shelf clerk is exactly who asks for stock and counts a delivery
   in, and #267 had already given them both tiles. That was a deliberate
   decision with a comment on it in lib/capabilities.js, and this line went red
   for it and stayed red, because nothing runs these files. A test that fails on
   correct changes teaches people to ignore it, and this one had already taught
   that lesson by the time anybody looked.

   So it asserts the invariant instead: whatever else the shelf clerk gains,
   they never gain the kitchen's two, and they never lose the recount that IS
   their job. */
check('store_stock never gains the kitchen’s capabilities', () => {
  const clerk = caps.PRESETS.store_stock;
  assert.ok(clerk.indexOf('quickstock:add') < 0,
    `store_stock holds quickstock:add — the kitchen's add door, not the clerk's: ${JSON.stringify(clerk)}`);
  assert.ok(clerk.indexOf('restock:fulfil') < 0,
    `store_stock holds restock:fulfil — it would put the shelf clerk in the kitchen queue: ${JSON.stringify(clerk)}`);
});

check('and keeps the recount that is its whole job', () => {
  assert.ok(caps.PRESETS.store_stock.indexOf('quickstock:recount') >= 0,
    `store_stock lost quickstock:recount: ${JSON.stringify(caps.PRESETS.store_stock)}`);
});

// ── 2. The migration, against a real database ──────────────────────────────
section('The migration reaches tenants that already have the role');

// The migration's rule, run against a real sqlite file. Only rows carrying
// EXACTLY the old shipped preset are rewritten: an edited role is somebody's
// considered choice and is left for them to change in the editor.
//
// THIS MIRRORS kitchen_role_can_fulfil_v1 in database.js and is not the same
// code. That migration runs at require-time against the live schema, so it
// cannot be called in isolation; what is checked here is the RULE. If you change
// one, change both — the assertions below are about the decision, not the copy.
function runMigration(db) {
  const rows = db.prepare("SELECT rowid AS rid, tenant_id, caps_json FROM tenant_roles WHERE role_key = 'kitchen'").all();
  const put = db.prepare('UPDATE tenant_roles SET caps_json = ? WHERE rowid = ?');
  const bump = db.prepare('UPDATE tenants SET roles_version = COALESCE(roles_version, 0) + 1 WHERE id = ?');
  let done = 0, kept = 0;
  for (const r of rows) {
    let list = null;
    try { const p = JSON.parse(r.caps_json || 'null'); if (Array.isArray(p)) list = p; } catch (e) { list = null; }
    if (!list) { kept++; continue; }
    if (list.indexOf('restock:fulfil') >= 0) { kept++; continue; }
    if (list.length !== 1 || list[0] !== 'quickstock:add') { kept++; continue; }
    put.run(JSON.stringify(['quickstock:add', 'restock:fulfil']), r.rid);
    bump.run(r.tenant_id);
    done++;
  }
  return { done, kept };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-mig-'));
const db = new Database(path.join(dir, 'test.db'));
db.exec(`CREATE TABLE tenants (id INTEGER PRIMARY KEY, roles_version INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE tenant_roles (tenant_id INTEGER, role_key TEXT, caps_json TEXT);`);
db.prepare('INSERT INTO tenants (id, roles_version) VALUES (1,4),(2,0),(3,0),(4,0)').run();
const seed = db.prepare('INSERT INTO tenant_roles (tenant_id, role_key, caps_json) VALUES (?,?,?)');
seed.run(1, 'kitchen', JSON.stringify(['quickstock:add']));                          // untouched — gets it
seed.run(2, 'kitchen', JSON.stringify(['quickstock:add', 'products:view']));         // edited — left alone
seed.run(3, 'kitchen', JSON.stringify(['quickstock:add', 'restock:fulfil']));        // already has it
seed.run(4, 'kitchen', 'not json');                                                  // unreadable — left alone
seed.run(1, 'store_stock', JSON.stringify(['quickstock:recount']));                  // a different role

const res = runMigration(db);
const capsOf = (t, k) => JSON.parse(db.prepare('SELECT caps_json FROM tenant_roles WHERE tenant_id = ? AND role_key = ?').get(t, k).caps_json);
const verOf = (t) => db.prepare('SELECT roles_version FROM tenants WHERE id = ?').get(t).roles_version;

check('the unedited kitchen role gains restock:fulfil', () => {
  assert.deepStrictEqual(capsOf(1, 'kitchen'), ['quickstock:add', 'restock:fulfil']);
});

// The whole invalidation story: the next request by anyone in the tenant reads
// the new number off the tenants row it was already fetching. Nobody logs out.
check('and its tenant’s roles_version is bumped, so nobody has to sign out', () => {
  assert.strictEqual(verOf(1), 5);
});

check('an EDITED kitchen role is left exactly as its owner shaped it', () => {
  assert.deepStrictEqual(capsOf(2, 'kitchen'), ['quickstock:add', 'products:view']);
});

check('and that tenant is not bumped — nothing changed for it', () => {
  assert.strictEqual(verOf(2), 0);
});

check('a role that already has it is not rewritten', () => {
  assert.deepStrictEqual(capsOf(3, 'kitchen'), ['quickstock:add', 'restock:fulfil']);
  assert.strictEqual(verOf(3), 0);
});

check('unreadable caps_json is left alone rather than replaced', () => {
  assert.strictEqual(db.prepare("SELECT caps_json FROM tenant_roles WHERE tenant_id = 4").get().caps_json, 'not json');
});

check('store_stock is not touched', () => {
  assert.deepStrictEqual(capsOf(1, 'store_stock'), ['quickstock:recount']);
});

check('the counts report what happened', () => {
  assert.deepStrictEqual(res, { done: 1, kept: 3 });
});

// Idempotent: a second run must find nothing to do, because the rows it wrote
// no longer match the old preset.
check('running it twice changes nothing the second time', () => {
  const again = runMigration(db);
  assert.deepStrictEqual(again, { done: 0, kept: 4 });
  assert.strictEqual(verOf(1), 5);
});

db.close();
fs.rmSync(dir, { recursive: true, force: true });

// ── 3. The gate the request has to pass first ──────────────────────────────
section('A stock-app-only role can reach the queue, and only the queue');

check('the queue’s list', () => {
  assert.strictEqual(stockAppOnlyAllows('GET', '/api/restock'), true);
});
check('one request, opened', () => {
  assert.strictEqual(stockAppOnlyAllows('GET', '/api/restock/91'), true);
});
check('and moving it along — sent → received → prepared', () => {
  assert.strictEqual(stockAppOnlyAllows('PUT', '/api/restock/91/status'), true);
});

// METHOD IS THE WHOLE DISTINCTION on the first of those URLs. Admitting the path
// would hand a confined role the create route, and cap-routes only refuses that
// on a tenant with rbac_enforce switched on — a flag that is dark for most.
check('but NOT raising a transfer — same path, different method', () => {
  assert.strictEqual(stockAppOnlyAllows('POST', '/api/restock'), false);
});
check('nor settling a receipt', () => {
  assert.strictEqual(stockAppOnlyAllows('PUT', '/api/restock/91/receive'), false);
});
check('nor retrying a dispatch', () => {
  assert.strictEqual(stockAppOnlyAllows('POST', '/api/restock/91/retry-dispatch'), false);
});
check('nor editing a line', () => {
  assert.strictEqual(stockAppOnlyAllows('PUT', '/api/restock/91/item/4'), false);
});
check('nor deleting one', () => {
  assert.strictEqual(stockAppOnlyAllows('DELETE', '/api/restock/91'), false);
});
check('nor archiving', () => {
  assert.strictEqual(stockAppOnlyAllows('PUT', '/api/restock/91/archive'), false);
});
// The "what the kitchen has finished" count, which is the ASKING side's dot.
// The route answers this role a zero anyway (_kitchenScopedSession), and it has
// no screen in /stock that reads it — so it has no business on this list.
check('nor the count of what the kitchen has finished — that is the ASKER\'s dot', () => {
  assert.strictEqual(stockAppOnlyAllows('GET', '/api/restock/kitchen-ready'), false);
});
// Reading the news is the asker's act. A confined kitchen role has no screen
// that shows it, and letting this through would let the maker put the
// warehouse's dot out on their behalf — for a warehouse still not told.
check('nor marking that news read on the asker\'s behalf', () => {
  assert.strictEqual(stockAppOnlyAllows('POST', '/api/restock/kitchen-ready/seen'), false);
});

check('the three the Add Stock app already had still work', () => {
  assert.strictEqual(stockAppOnlyAllows('GET', '/api/retail-admin/quick-stock/context'), true);
  assert.strictEqual(stockAppOnlyAllows('PUT', '/api/retail-admin/stores/3/stock/7'), true);
  assert.strictEqual(stockAppOnlyAllows('POST', '/api/backend/logout'), true);
});

check('and the rest of the backend is still shut', () => {
  for (const p of ['/api/retail-admin/products', '/api/retail-admin/orders',
                   '/api/backend/roles', '/api/retail-admin/customers']) {
    assert.strictEqual(stockAppOnlyAllows('GET', p), false, `${p} was let through`);
  }
});

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
