#!/usr/bin/env node
// "NOT TODAY" — the one way to quiet the fapiao chase without issuing it.
//
// WHAT THIS GUARDS. §99 shipped a reminder that comes back until the 发票 is
// issued, and deliberately gave a dismissed notification no effect whatsoever:
// there is no dismissed column, so a swipe writes nothing and the next sweep
// asks again. That is right, and on its own it leaves an operator who genuinely
// cannot act today with one available control — switching every push off. That
// is the failure lib/push-events.js is written about: "The switch that gets
// used is the one that turns the whole thing off, and then the pick that
// mattered arrives nowhere."
//
// So there is exactly one deferral, and it is a DECISION taken on a screen by
// somebody holding invoices:manage, not a gesture on a banner. This suite pins
// the endpoint's half of it:
//
//   • only a row that is actually WAITING may be deferred — issuing it, or the
//     order dying, refuses with not_pending rather than writing a date onto
//     work that no longer exists
//   • the date written is the sweeper's own snoozeTarget, not a second copy
//   • snoozed:false lifts it, and is explicit rather than a toggle so a double
//     tap cannot flip a deferral back on by accident
//
// The sweep's half — that a live snooze is skipped without being claimed, that
// one press hides at most one ask, and that a snoozed row is STILL counted by
// Home — is in scripts/test_fapiao_reminders.js.
//
// USAGE   node scripts/test_fapiao_snooze_route.js
// EXIT    0 every assertion held · 1 an assertion failed · 2 no driver/router

'use strict';

const path   = require('path');
const Module = require('module');

const ROOT        = path.join(__dirname, '..');
const RETAIL_PATH = path.join(ROOT, 'routes', 'retail.js');

let pass = 0, fail = 0;
const ok = (cond, msg, got) => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (got === undefined ? '' : ' — got ' + JSON.stringify(got))); }
};

let openMemoryDb, driver;
try { ({ openMemoryDb, driver } = require('./test-support/memory-db')); }
catch (e) { console.error('[test_fapiao_snooze_route] no usable SQLite driver:', e.message); process.exit(2); }

// Only the columns the route's predicate and its UPDATE touch. A narrower table
// than retail_orders on purpose — this suite is about the handler.
const handle = openMemoryDb();
handle.exec(`
CREATE TABLE retail_orders (
  id INTEGER PRIMARY KEY, order_no TEXT, status TEXT, total REAL, shipping_fee REAL,
  needs_invoice INTEGER DEFAULT 0, invoice_status TEXT, invoice_title TEXT,
  invoice_type TEXT, invoice_tax_id TEXT, invoice_email TEXT,
  invoice_file_url TEXT, invoice_number TEXT, invoice_issued_at TEXT,
  placed_at TEXT, customer_id INTEGER,
  invoice_reminder_snoozed_until DATETIME
);
CREATE TABLE retail_customers (id INTEGER PRIMARY KEY, nickname TEXT);
CREATE TABLE storefront_config (key TEXT PRIMARY KEY, value_json TEXT);
INSERT INTO storefront_config (key, value_json) VALUES ('shop.timezone', '"Asia/Shanghai"');
CREATE TABLE tenants (id INTEGER PRIMARY KEY, status TEXT, rbac_enforce INTEGER, roles_version INTEGER);
CREATE TABLE tenant_users (id INTEGER PRIMARY KEY, tenant_id INTEGER, username TEXT, role TEXT, is_active INTEGER, display_name TEXT);
INSERT INTO tenants (id, status, rbac_enforce, roles_version) VALUES (1, 'active', 1, 1);
-- Two operators, because the gate is half of what this route is: one holds
-- invoices:manage, the other can read the list and nothing else.
INSERT INTO tenant_users (id, tenant_id, username, role, is_active, display_name) VALUES
  (1, 1, 'manager', 'staff', 1, 'Manager'),
  (2, 1, 'viewer',  'staff', 1, 'Viewer');
CREATE TABLE retail_order_items (id INTEGER PRIMARY KEY, order_id INTEGER, product_id INTEGER,
  name_en TEXT, name_cn TEXT, qty REAL, line_total REAL);
INSERT INTO retail_orders (id, order_no, status, total, needs_invoice, invoice_status, placed_at) VALUES
  (1, 'TC000800', 'paid',            100, 1, 'requested', '2026-09-01T09:00:00'),
  (2, 'TC000801', 'delivered',       200, 1, 'issued',    '2026-09-01T09:00:00'),
  (3, 'TC000802', 'cancelled',       300, 1, 'requested', '2026-09-01T09:00:00'),
  (4, 'TC000803', 'pending_payment', 400, 1, 'requested', '2026-09-01T09:00:00'),
  (5, 'TC000804', 'paid',            500, 0, NULL,        '2026-09-01T09:00:00');
`);

const stub = (request, exports) => {
  const resolved = Module._resolveFilename(request, {
    id: RETAIL_PATH, filename: RETAIL_PATH, paths: Module._nodeModulePaths(path.dirname(RETAIL_PATH)),
  });
  const m = new Module(resolved, null);
  m.filename = resolved; m.loaded = true; m.exports = exports;
  require.cache[resolved] = m;
};
stub('../database', handle);
stub('../lib/tenant-db', {
  tdb: () => handle, currentTenantId: () => 1,
  getTenantDb: () => handle, rawTenantDb: () => handle, rawTdb: () => handle,
  ROOTS_TENANT_ID: 1, DATA_ISOLATION_READY: true,
  // The real ALS; the route runs next() inside it and nothing here reads the store.
  tenantAls: { run: (_db, fn) => fn(), getStore: () => handle },
});
// Whoever is signed in decides their own caps — the suite flips this between
// requests to exercise the gate rather than asserting it from source.
let CAPS = ['invoices:manage', 'invoices:view'];
stub('../lib/operator-caps', { resolveOperator: () => ({ caps: CAPS, scopeStores: null }) });
// lib/inventory and lib/category-text are NOT stubbed: retail.js calls a wide
// surface of both at load, a hand-written fake of that surface rots the moment
// either grows a function, and neither is on this route's path. They read
// through the same stubbed database handle.
stub('../middleware/auth', {
  logActivity: () => {},
  requireAuth: (req, _res, next) => { req.user = { id: 1, username: 'tester' }; next(); },
  requirePermission: () => (_req, _res, next) => next(),
  requireDelete: (_req, _res, next) => next(),
});
stub('../lib/recipe-rollup', { recipeOwnsProductCost: () => false, fireRecompute: () => {} });
stub('../middleware/block-kitchen-cost-writes', {
  blockCostWrite: () => (_req, _res, next) => next(), blockCostWriteIf: () => (_req, _res, next) => next(),
});

let express, retailRouter;
try { express = require('express'); retailRouter = require(RETAIL_PATH); }
catch (e) { console.error('[test_fapiao_snooze_route] could not load the router:', e.message); process.exit(2); }

const fr = require('../lib/fapiao-reminders');
const businessDate = require('../lib/business-date');

(async () => {
  console.log(`\ntest_fapiao_snooze_route — driver: ${driver}\n`);

  const app = express();
  app.use(express.json());
  // requireRetailAdmin reads req.session.backendUserId and resolves the operator
  // from tenant_users — so signing in is one line, and the suite can change who
  // is holding the phone between requests.
  let WHO = 1;
  app.use((req, _res, next) => { req.session = { backendUserId: WHO }; next(); });
  app.use(retailRouter);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (method, p, body) => {
    const r = await fetch(base + p, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const snoozeOf = (id) =>
    handle.prepare('SELECT invoice_reminder_snoozed_until AS s FROM retail_orders WHERE id = ?').get(id).s;

  console.log('1 · deferring a request that is genuinely waiting');
  const on = await send('POST', '/api/retail-admin/invoices/1/snooze', { snoozed: true });
  ok(on.status === 200, 'the press answers', on.status);
  ok(!!snoozeOf(1), 'and a date is written', snoozeOf(1));
  ok(snoozeOf(1) === fr.snoozeTarget(new Date(), 'Asia/Shanghai').toISOString(),
     'THE DATE IS THE SWEEPER\'S OWN snoozeTarget — two copies of "tomorrow" would '
     + 'eventually disagree by an hour on one day of the year',
     { wrote: snoozeOf(1), sweeper: fr.snoozeTarget(new Date(), 'Asia/Shanghai').toISOString() });
  // Read on the SHOP's clock, not the host's: Guangzhou, the zone the tenant
  // carries (shop.timezone in the fixture — §82 has no default).
  ok(businessDate.zoneParts('Asia/Shanghai', new Date(snoozeOf(1))).hour === fr.REMIND_HOUR,
     'landing on the reminder hour, not on now+24h', snoozeOf(1));
  ok(!fr.isSnoozed(snoozeOf(1), fr.snoozeTarget(new Date(), 'Asia/Shanghai')),
     'and spent exactly when it arrives, so nothing has to clear the column');

  console.log('\n2 · lifting it again');
  const off = await send('POST', '/api/retail-admin/invoices/1/snooze', { snoozed: false });
  ok(off.status === 200 && snoozeOf(1) === null, 'snoozed:false clears the date', snoozeOf(1));
  const off2 = await send('POST', '/api/retail-admin/invoices/1/snooze', { snoozed: false });
  ok(off2.status === 200 && snoozeOf(1) === null,
     'and lifting an already-lifted row is harmless — EXPLICIT, not a toggle, so a '
     + 'double tap cannot flip a deferral back on by accident');

  console.log('\n3 · what may not be deferred');
  const issued = await send('POST', '/api/retail-admin/invoices/2/snooze', { snoozed: true });
  ok(issued.status === 404 && issued.json.error === 'not_pending' && snoozeOf(2) === null,
     'an ISSUED fapiao is refused — there is no reminder left to defer, and a date '
     + 'written here would be a stale stamp for whoever reads the column next',
     { status: issued.status, json: issued.json });

  const cancelled = await send('POST', '/api/retail-admin/invoices/3/snooze', { snoozed: true });
  ok(cancelled.status === 404 && snoozeOf(3) === null,
     'a request on a CANCELLED order is refused — it was never pending work (§99)');

  const unpaid = await send('POST', '/api/retail-admin/invoices/4/snooze', { snoozed: true });
  ok(unpaid.status === 404 && snoozeOf(4) === null,
     'and one on an unpaid order too');

  const never = await send('POST', '/api/retail-admin/invoices/5/snooze', { snoozed: true });
  ok(never.status === 404, 'an order that never asked for a fapiao has nothing to defer');

  const missing = await send('POST', '/api/retail-admin/invoices/99999/snooze', { snoozed: true });
  ok(missing.status === 404, 'and neither does an order that does not exist');

  const bad = await send('POST', '/api/retail-admin/invoices/abc/snooze', { snoozed: true });
  ok(bad.status === 400 && bad.json.error === 'bad_id',
     'a non-numeric id is refused at the door rather than becoming NaN in a query',
     { status: bad.status, json: bad.json });

  console.log('\n4 · the list carries the state back');
  await send('POST', '/api/retail-admin/invoices/1/snooze', { snoozed: true });
  const list = await send('GET', '/api/retail-admin/invoices?status=requested');
  const row = (list.json.data || []).find((r) => r.id === 1);
  ok(!!row && !!row.invoice_reminder_snoozed_until,
     'the pending row ships its deferral, so the phone can draw the control as set',
     row && row.invoice_reminder_snoozed_until);
  ok(!!row,
     'AND IT IS STILL IN THE PENDING LIST. A snooze quiets the push and nothing else — '
     + 'the work never leaves the screen an operator walks past');

  console.log('\n5 · who may defer');
  // The list is a read and stays open — lib/cap-routes.js opens every GET, and
  // "can't SEE" is a different mechanism. The WRITE is the gated one.
  CAPS = ['invoices:view'];
  const viewer = await send('POST', '/api/retail-admin/invoices/1/snooze', { snoozed: false });
  ok(viewer.status === 403 && viewer.json.error === 'forbidden_capability',
     'invoices:VIEW cannot defer a chase — lib/cap-routes.js maps every write under '
     + '/api/retail-admin/invoices to invoices:manage, so the existing gate covers this '
     + 'route and no new mapping was added', { status: viewer.status, json: viewer.json });
  ok(!!snoozeOf(1),
     'and the refusal wrote nothing — the deferral set above is untouched', snoozeOf(1));

  const stillReads = await send('GET', '/api/retail-admin/invoices?status=requested');
  ok(stillReads.status === 200,
     'while the same operator can still READ the list: reads stay open by that file\'s '
     + 'own rule, and hiding is the client\'s job');
  CAPS = ['invoices:manage', 'invoices:view'];

  server.close();
  console.log(`\n${fail ? '✗ ' + fail + ' failed' : '✓ ' + pass + ' passed, 0 failed'}`);
  process.exit(fail ? 1 : 0);
})();
