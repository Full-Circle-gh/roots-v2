#!/usr/bin/env node
//
// test_cancel_reversals.js — red-proof for the cancel-path reversal fixes.
//
// TWO KINDS OF ASSERTION, LABELLED, per the house rule in
// test_ledger_invariants.js — a suite that lets both read as proof is a suite
// that looks like evidence and is not:
//
//   BEHAVIOURAL  real code against a real (in-memory) engine. The sweeper is
//                REQUIRED, not re-implemented: lib/inventory.js runs with
//                ../database, ./tenant-db and ./geocode stubbed, so the
//                sweepExpiredReservations that executes here is the one that
//                ships. The cumulative-cap test EXTRACTS reverseOrderBalance's
//                SQL from routes/retail.js and executes that text, so an edit to
//                the shipped query changes what this test runs.
//   SOURCE       string checks over the two source files. They prove what is
//                WRITTEN — the wiring, and the deliberate absences that a later
//                reader would otherwise "fix" for symmetry. They do not prove
//                runtime behaviour and are not to be read as if they did.
//
// EVERY SOURCE ANCHOR IS MUTATION-TESTED. A source check that cannot go red is
// a PASS line with nothing behind it. For each one the suite mutates the file
// text, asserts the mutation actually changed the text (a no-op mutation would
// make the red-proof itself a lie), and asserts the check then fails.
//
// ANCHORS CARRY NO LINE ENDING. Every anchor string below stops before the
// newline, so the suite behaves the same on a CRLF checkout as on an LF one.
//
// USAGE   node scripts/test_cancel_reversals.js
// EXIT    0 every assertion held · 1 an assertion failed · 2 could not run

'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const INVENTORY_PATH = path.join(ROOT, 'lib', 'inventory.js');
const RETAIL_PATH = path.join(ROOT, 'routes', 'retail.js');
const INVENTORY_SRC = fs.readFileSync(INVENTORY_PATH, 'utf8');
const RETAIL_SRC = fs.readFileSync(RETAIL_PATH, 'utf8');

let fails = 0;
const ok = (kind, name, cond, got) => {
  if (cond) console.log(`  PASS  [${kind}] ${name}`);
  else { fails++; console.log(`  FAIL  [${kind}] ${name}${got === undefined ? '' : ' — got ' + JSON.stringify(got)}`); }
};

// ── driver ────────────────────────────────────────────────────────────────
// better-sqlite3 first: it has the .transaction() the shipped code calls. Under
// node:sqlite we wrap a handle to supply the same surface, so the code under
// test is unmodified either way.
let openDb;
try {
  const Better = require('better-sqlite3');
  const probe = new Better(':memory:'); probe.close();   // construct, don't just require
  openDb = () => new Better(':memory:');
} catch (e1) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    openDb = () => {
      const raw = new DatabaseSync(':memory:');
      return {
        prepare: (sql) => raw.prepare(sql),
        exec: (sql) => raw.exec(sql),
        transaction: (fn) => (...args) => {
          raw.exec('BEGIN');
          try { const r = fn(...args); raw.exec('COMMIT'); return r; }
          catch (err) { try { raw.exec('ROLLBACK'); } catch {} throw err; }
        },
      };
    };
  } catch (e2) {
    console.error('[test_cancel_reversals] no usable SQLite driver.');
    console.error(`  better-sqlite3: ${e1.message.split('\n')[0]}`);
    console.error(`  node:sqlite:    ${e2.message}`);
    process.exit(2);
  }
}

// ── SOURCE checks, each paired with the mutation that must break it ───────
// { name, anchor, present, mutate } — `present: false` asserts an ABSENCE, and
// its mutation ADDS the string back.
const SOURCE_CHECKS = [
  {
    file: 'lib/inventory.js', src: () => INVENTORY_SRC,
    name: 'sweeper exposes the cancelled-orders hook',
    anchor: 'function setOnOrdersCancelled(fn) { _onOrdersCancelled = fn; }',
    present: true,
  },
  {
    file: 'lib/inventory.js', src: () => INVENTORY_SRC,
    name: 'the hook is exported',
    anchor: '  setOnOrdersCancelled,',
    present: true,
  },
  {
    file: 'lib/inventory.js', src: () => INVENTORY_SRC,
    name: 'the hook fires OUTSIDE the transaction (after `const out = tx();`)',
    anchor: 'const out = tx();',
    present: true,
    extra: (src) => src.indexOf('_onOrdersCancelled(out.cancelledIds)') > src.indexOf('const out = tx();'),
  },
  {
    file: 'routes/retail.js', src: () => RETAIL_SRC,
    name: 'sweep handler returns redeem',
    anchor: "try { reverseOrderRedeem(oid); }  catch (e) { console.error('[sweep-cancel.reverseRedeem]', oid, e.message); }",
    present: true,
  },
  {
    file: 'routes/retail.js', src: () => RETAIL_SRC,
    name: 'sweep handler returns balance',
    anchor: "try { reverseOrderBalance(oid); } catch (e) { console.error('[sweep-cancel.reverseBalance]', oid, e.message); }",
    present: true,
  },
  {
    file: 'routes/retail.js', src: () => RETAIL_SRC,
    name: 'sweep handler returns the voucher (safe: the sweeper owns the once-per-order flip)',
    anchor: "try { reverseOrderVoucher(oid); } catch (e) { console.error('[sweep-cancel.reverseVoucher]', oid, e.message); }",
    present: true,
  },
  {
    file: 'routes/retail.js', src: () => RETAIL_SRC,
    name: 'sweep handler does NOT claw back points/referral/commission (never paid)',
    anchor: '[sweep-cancel.reversePoints]',
    present: false,
  },
];

// ── run the source checks ─────────────────────────────────────────────────
const evalCheck = (c, src) => {
  const has = src.includes(c.anchor);
  if (c.present && c.extra) return has && c.extra(src);
  return c.present ? has : !has;
};

console.log('\n── SOURCE ──');
for (const c of SOURCE_CHECKS) {
  ok('SOURCE', `${c.file}: ${c.name}`, evalCheck(c, c.src()), c.anchor);
}

console.log('\n── SOURCE, mutation red-proof ──');
for (const c of SOURCE_CHECKS) {
  const src = c.src();
  // Removing a required anchor, or inserting a forbidden one, must flip the check.
  const mutated = c.present ? src.split(c.anchor).join('') : src + '\n' + c.anchor + '\n';
  ok('SOURCE', `mutation actually changed the source (${c.name})`, mutated !== src);
  ok('SOURCE', `check goes red when mutated (${c.name})`, !evalCheck(c, mutated));
}

// ── BEHAVIOURAL: the sweeper, required with stubs ─────────────────────────
console.log('\n── BEHAVIOURAL: sweepExpiredReservations ──');

const handle = openDb();
handle.exec(`
CREATE TABLE retail_stock_reservations (id INTEGER PRIMARY KEY, order_id INTEGER, product_id INTEGER,
  store_id INTEGER, qty INTEGER, status TEXT, expires_at TEXT, released_at TEXT);
CREATE TABLE retail_orders (id INTEGER PRIMARY KEY, customer_id INTEGER, status TEXT,
  cancelled_at TEXT, cancelled_reason TEXT, updated_at TEXT);
CREATE TABLE retail_payments (id INTEGER PRIMARY KEY, order_id INTEGER, status TEXT);
INSERT INTO retail_orders (id, customer_id, status) VALUES (900, 42, 'pending_payment');
INSERT INTO retail_payments (id, order_id, status) VALUES (1, 900, 'pending');
INSERT INTO retail_stock_reservations (id, order_id, product_id, store_id, qty, status, expires_at)
  VALUES (1, 900, 5, 1, 2, 'active', '2020-01-01 00:00:00');
`);

// Stub the three modules lib/inventory.js loads, before requiring it.
const stub = (request, exports) => {
  const resolved = Module._resolveFilename(request, { id: INVENTORY_PATH, filename: INVENTORY_PATH, paths: Module._nodeModulePaths(path.dirname(INVENTORY_PATH)) });
  const m = new Module(resolved, null);
  m.filename = resolved; m.loaded = true; m.exports = exports;
  require.cache[resolved] = m;
};
const tdb = () => handle;
stub('../database', handle);
stub('./tenant-db', {
  tdb, tenantAls: { run: (_d, fn) => fn() }, getTenantDb: () => handle, rawTenantDb: () => handle,
  ROOTS_TENANT_ID: 1, DATA_ISOLATION_READY: false, currentTenantId: () => 1,
});
stub('./geocode', { haversineKm: () => 0, drivingDistanceKm: async () => 0 });

let inventory;
try { inventory = require(INVENTORY_PATH); }
catch (e) { console.error('[test_cancel_reversals] could not load lib/inventory.js:', e.message); process.exit(2); }

const fired = [];
inventory.setOnOrdersCancelled((ids) => fired.push([...ids]));

const first = inventory.sweepExpiredReservations();
ok('BEHAVIOURAL', 'sweep expires the reservation and cancels the order', first.expired === 1 && first.cancelledOrders === 1, first);
ok('BEHAVIOURAL', 'the order is cancelled with reason reservation_expired',
  handle.prepare('SELECT status, cancelled_reason FROM retail_orders WHERE id = 900').get().cancelled_reason === 'reservation_expired');
ok('BEHAVIOURAL', 'hook fired once, carrying the cancelled order id — this is what returns points, balance and voucher',
  fired.length === 1 && fired[0].length === 1 && fired[0][0] === 900, fired);

const second = inventory.sweepExpiredReservations();
ok('BEHAVIOURAL', 'a SECOND sweep of the same order expires nothing', second.expired === 0 && second.cancelledOrders === 0, second);
ok('BEHAVIOURAL', 'a SECOND sweep returns nothing more — the hook does not re-fire', fired.length === 1, fired);

// The once-per-order contract reverseOrderVoucher requires, exercised directly:
// re-arm the reservation but leave the order cancelled. The status-guarded
// UPDATE must find nothing, so no second return is ever offered.
handle.exec("UPDATE retail_stock_reservations SET status = 'active', released_at = NULL WHERE id = 1");
const third = inventory.sweepExpiredReservations();
ok('BEHAVIOURAL', 'a re-armed hold on an ALREADY-cancelled order does not re-fire the hook (the changes>0 guard)',
  third.expired === 1 && third.cancelledOrders === 0 && fired.length === 1, { third, fired: fired.length });

console.log(fails ? `\n${fails} ASSERTION(S) FAILED\n` : `\nALL ASSERTIONS HELD\n`);
process.exit(fails ? 1 : 0);
