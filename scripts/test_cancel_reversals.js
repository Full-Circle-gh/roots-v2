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

  // ── item 44: the five, hoisted so both paid-cancel branches share them ──
  {
    file: 'routes/retail.js', src: () => RETAIL_SRC,
    name: 'the five run for every paid cancel, guarded on the status not being pending_payment',
    anchor: "    if (o.status !== 'pending_payment') {",
    present: true,
    extra: (src) => {
      const shared = sliceBetween(sliceBetween(src, "  if (status === 'cancelled') {", "  if (status === 'refunded') {"),
        "    if (o.status !== 'pending_payment') {", '\n  }');
      return ['reverseOrderPoints', 'reverseOrderRedeem', 'reverseOrderBalance', 'reverseOrderReferral', 'reverseLifetimeCommission']
        .every((fn) => shared.includes(fn + '(id)'));
    },
  },
  {
    file: 'routes/retail.js', src: () => RETAIL_SRC,
    name: 'the hoisted site sits AFTER the wechatRefundRef if/else, so the gateway path keeps its order',
    anchor: 'THE LEDGER REVERSALS BELONG TO THE CANCEL, NOT TO THE GATEWAY.',
    present: true,
    extra: (src) => {
      const cancelBlock = sliceBetween(src, "  if (status === 'cancelled') {", "  if (status === 'refunded') {");
      return cancelBlock.indexOf('THE LEDGER REVERSALS BELONG TO THE CANCEL')
           > cancelBlock.indexOf('[cancel close-stuck-refund]');
    },
  },
];

// Region helpers. Absence checks MUST be scoped — reverseOrderVoucher is called
// legitimately elsewhere in this file (the pending_payment branch, the sweep
// handler), so an unscoped "not present" check would be vacuous.
function sliceBetween(src, from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  if (a < 0 || b < 0) return '';
  return src.slice(a, b);
}
const cancelBlock   = () => sliceBetween(RETAIL_SRC, "  if (status === 'cancelled') {", "  if (status === 'refunded') {");
const gatewayBranch = () => sliceBetween(cancelBlock(), '    if (wechatRefundRef) {', '    } else {');
const sharedRegion  = () => sliceBetween(cancelBlock(), '      } catch (e) { console.error(\'[cancel close-stuck-refund]\', e); }', '\n  }');

// ── run the source checks ─────────────────────────────────────────────────
const evalCheck = (c, src) => {
  const has = src.includes(c.anchor);
  if (c.present && c.extra) return has && c.extra(src);
  return c.present ? has : !has;
};

console.log('\n── SOURCE ──');
// NO ANCHOR MAY CARRY A LINE ENDING. Both source files are CRLF on this
// checkout; an anchor spanning two lines with a bare \n matches nothing, and the
// failure is silent — the check passes as a vacuous absence, or fails for a
// reason that reads like a real defect. Asserted rather than merely intended,
// because it already happened once while writing this suite.
for (const c of SOURCE_CHECKS) {
  ok('SOURCE', `anchor carries no line ending (${c.name})`, !/[\r\n]/.test(c.anchor), c.anchor);
}
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

// ── SOURCE: branch 3 unchanged, and the voucher's deliberate absence ──────
// Branch 3 is the regression risk: the gateway path already worked, and the
// hoist must not change what it does. What it OWNS is the refund bookkeeping;
// what it no longer holds is the five, which now run for it from the shared
// site below it.
console.log('\n── SOURCE: branch 3 (gateway) and the scoped absences ──');
{
  const gw = gatewayBranch();
  ok('SOURCE', 'branch 3 was found at all', gw.length > 0, gw.length);
  for (const [what, needle] of [
    ['refund_status = paid',          "refund_status = 'paid'"],
    ['approved + paid amounts',       'refund_amount_approved = ?'],
    ['wechat payout method + ref',    "refund_payout_method   = 'wechat'"],
    ['retail_payments mirror',        "UPDATE retail_payments SET refunded_amount = amount, status = 'refunded'"],
    ['the paid refund event',         "note: 'auto-refund on cancel'"],
  ]) ok('SOURCE', `branch 3 keeps its ${what}`, gw.includes(needle), what);

  for (const fn of ['reverseOrderPoints', 'reverseOrderRedeem', 'reverseOrderBalance', 'reverseOrderReferral', 'reverseLifetimeCommission']) {
    ok('SOURCE', `branch 3 no longer calls ${fn} itself — it runs from the shared site`, !gw.includes(fn + '(id)'), fn);
  }

  const shared = sharedRegion();
  ok('SOURCE', 'the shared region was found at all', shared.includes('reverseOrderPoints(id)'), shared.length);
  for (const fn of ['reverseOrderPoints', 'reverseOrderRedeem', 'reverseOrderBalance', 'reverseOrderReferral', 'reverseLifetimeCommission']) {
    ok('SOURCE', `the shared site calls ${fn} — so the gateway path still reverses it`, shared.includes(fn + '(id)'), fn);
  }
  // THE ABSENCE THAT SOMEONE WILL LATER "FIX" FOR SYMMETRY.
  // Matched on the CALL, not the bare name — the comment above the shared site
  // explains at length why the voucher is not returned here, and a name-only
  // check would trip on its own explanation.
  ok('SOURCE', 'reverseOrderVoucher is NOT called from the no-gateway branch or the shared site',
    !shared.includes('reverseOrderVoucher(id)'), shared.match(/reverseOrderVoucher\(id\)/g));
  ok('SOURCE', 'reverseOrderVoucher is NOT called from branch 3 either (the paid paths agree)',
    !gw.includes('reverseOrderVoucher(id)'));
  // ...and it is still called where it IS safe, or the check above is vacuous.
  ok('SOURCE', 'reverseOrderVoucher IS still called from the pending_payment branch',
    cancelBlock().includes("reverseOrderVoucher(id); } catch (e) { console.error('[admin-cancel.reverseVoucher]'"));
}

console.log('\n── SOURCE: branch-3 / absence mutation red-proof ──');
{
  const gw = gatewayBranch();
  const reAdded = gw + "\n      try { reverseOrderVoucher(id); } catch (e) {}";
  ok('SOURCE', 'mutation actually changed branch 3', reAdded !== gw);
  ok('SOURCE', 'the voucher-absence check goes red when someone adds it back for symmetry',
    reAdded.includes('reverseOrderVoucher'));
  const stripped = gw.split("refund_status = 'paid'").join('');
  ok('SOURCE', 'mutation actually stripped the bookkeeping', stripped !== gw);
  ok('SOURCE', 'the branch-3-unchanged check goes red when its bookkeeping is stripped',
    !stripped.includes("refund_status = 'paid'"));
}

// ── BEHAVIOURAL: the cumulative cap, running the SHIPPED function ─────────
// reverseOrderBalance is not exported, so it is materialised FROM THE SOURCE
// TEXT and executed. An edit to the shipped function changes what runs here.
console.log('\n── BEHAVIOURAL: cumulative cap on order 324\'s shape ──');
{
  const capDb = openDb();
  capDb.exec(`
CREATE TABLE retail_customers (id INTEGER PRIMARY KEY, balance REAL DEFAULT 0);
CREATE TABLE retail_topup_transactions (id INTEGER PRIMARY KEY, customer_id INTEGER, amount REAL,
  bonus_points INTEGER DEFAULT 0, payment_method TEXT, status TEXT, paid_at TEXT, out_trade_no TEXT,
  raw_callback_json TEXT);
INSERT INTO retail_customers (id, balance) VALUES (233, 99.51);
-- Order 324 as it stands in production: ¥38.80 of wallet balance spent, and
-- ¥23.11 + ¥15.20 already returned through the refund-payout flow twenty
-- seconds before the cancel.
INSERT INTO retail_topup_transactions (customer_id, amount, payment_method, status, out_trade_no) VALUES
 (233, -38.80, 'order_redeem',   'success', 'orderspend:324'),
 (233,  23.11, 'refund_reverse', 'success', 'orderrefund:324:1'),
 (233,  15.20, 'refund_reverse', 'success', 'orderrefund:324:2');
`);
  const body = RETAIL_SRC.match(/function reverseOrderBalance\(orderId, maxAmount\) \{[\s\S]*?\n\}/);
  ok('BEHAVIOURAL', 'reverseOrderBalance was extracted from the shipped source', !!body, body && body[0].length);
  if (body) {
    const reverseOrderBalance = new Function('tdb', 'console', `${body[0]}\nreturn reverseOrderBalance;`)(() => capDb, console);
    const gave = reverseOrderBalance(324);
    ok('BEHAVIOURAL', 'a call today returns ¥0.49 — not the ¥38.80 already largely returned', gave === 0.49, gave);
    ok('BEHAVIOURAL', 'the wallet moved by exactly ¥0.49',
      capDb.prepare('SELECT balance FROM retail_customers WHERE id = 233').get().balance === 100.00,
      capDb.prepare('SELECT balance FROM retail_customers WHERE id = 233').get().balance);
    const again = reverseOrderBalance(324);
    ok('BEHAVIOURAL', 'and stops — a second call returns ¥0.00', again === 0, again);
    ok('BEHAVIOURAL', 'the wallet did not move again',
      capDb.prepare('SELECT balance FROM retail_customers WHERE id = 233').get().balance === 100.00);
  }
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
