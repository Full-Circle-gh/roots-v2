#!/usr/bin/env node
//
// test_ledger_invariants.js — red-proof for scripts/check_ledger_invariants.js.
//
// A CHECK SET WITH NO FAILING CASE IS NOT A CHECK SET. Every query in that file
// is asserted twice here: once against a clean fixture where it must return 0,
// and once against a fixture carrying exactly one seeded break, where it must
// return exactly that break. A check that cannot go red would sit in the output
// reading PASS forever and nobody would know.
//
// IT IMPORTS THE REAL QUERIES — THIS IS THE POINT
// -----------------------------------------------
// CHECKS is required from check_ledger_invariants.js rather than copied here.
// A fixture that validates its own copy of a query proves nothing about the
// query that actually ships; the two drift the first time one is edited, and
// the suite stays green while the shipped file rots. Same class of defect as
// the comment-blind source guards in §24 — a run that looks like proof and is
// not. If this file and that file disagree, this file fails to load.
//
// WHAT IS ASSERTED, AND WHICH KIND EACH ASSERTION IS
// --------------------------------------------------
// Per §24's rule that a suite must say which of its assertions are source-level
// and which are behavioural rather than letting both read as proof:
//
//   BEHAVIOURAL  the green pass, the eleven mutations, the detail-query run.
//                Real SQL against a real (in-memory) engine, real row counts.
//   SOURCE       the read-only assertion — that every query begins with SELECT.
//                It is a string check on the SQL text and it proves the AUTHOR'S
//                intent, not the ENGINE'S refusal. The engine's refusal is the
//                driver's readonly flag and pg's BEGIN READ ONLY, and neither of
//                those is exercised here. Do not read the SELECT assertion as
//                proof that a write is impossible; read it as proof that none
//                was written down.
//
// M and P are exempt from the green pass: M is a reconciliation whose clean
// value is not defined to be zero, and P is a measurement. Both are still run,
// because a query that throws is a defect whatever kind it is.
//
// USAGE
//   node scripts/test_ledger_invariants.js
//
// EXIT CODE
//   0  every assertion held
//   1  at least one assertion failed
//   2  the suite could not run (no driver)

'use strict';

const { CHECKS, MONEY_EPS } = require('./check_ledger_invariants');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  try {
    const Better = require('better-sqlite3');
    // Construct, don't just require — better-sqlite3 requires fine with no
    // binding built and throws only when a database is opened.
    const probe = new Better(':memory:');
    probe.close();
    DatabaseSync = function (file) { return new Better(file); };
  } catch (e2) {
    console.error('[test_ledger_invariants] no usable SQLite driver.');
    console.error(`  node:sqlite:    ${e.message}`);
    console.error(`  better-sqlite3: ${e2.message.split('\n')[0]}`);
    process.exit(2);
  }
}

// Only the columns the checks actually read. Kept minimal on purpose: a fixture
// that mirrors the whole schema hides which columns a check depends on.
const DDL = `
CREATE TABLE retail_customers (
  id INTEGER PRIMARY KEY, phone TEXT, balance REAL DEFAULT 0,
  points_balance INTEGER DEFAULT 0, lifetime_spend REAL DEFAULT 0,
  tier_key TEXT, created_at DATETIME);
CREATE TABLE retail_orders (
  id INTEGER PRIMARY KEY, customer_id INTEGER, subtotal REAL, total REAL,
  status TEXT, placed_at DATETIME, paid_at DATETIME, points_earned INTEGER DEFAULT 0);
CREATE TABLE retail_points_transactions (
  id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL, source TEXT NOT NULL, order_id INTEGER,
  topup_id INTEGER, note TEXT, expires_at DATETIME, expired_at DATETIME,
  created_at DATETIME);
CREATE TABLE retail_topup_transactions (
  id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, amount REAL NOT NULL,
  bonus_points INTEGER DEFAULT 0, payment_method TEXT, status TEXT DEFAULT 'pending',
  out_trade_no TEXT, created_at DATETIME, paid_at DATETIME);
CREATE TABLE retail_lifetime_commissions (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL UNIQUE, referrer_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL, base_amount REAL, rate_percent REAL,
  commission_amount REAL, reversed_at DATETIME, created_at DATETIME);
CREATE TABLE retail_referrals (
  id INTEGER PRIMARY KEY, referrer_id INTEGER NOT NULL, invitee_id INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'joined', reward_amount REAL DEFAULT 0,
  referee_reward_amount REAL DEFAULT 0, first_paid_order_id INTEGER,
  joined_at DATETIME, rewarded_at DATETIME);
CREATE TABLE retail_order_addons (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, customer_id INTEGER NOT NULL,
  amount REAL NOT NULL, earn_points INTEGER DEFAULT 0, status TEXT DEFAULT 'pending',
  out_trade_no TEXT, created_at DATETIME, paid_at DATETIME);
`;

// One customer whose balances are exactly what their ledgers say, and whose
// lifetime_spend exactly matches the migration formula — so M is 0 here too,
// even though M is not required to be 0 in the wild.
const CLEAN = `
INSERT INTO retail_customers (id, phone, balance, points_balance, lifetime_spend, tier_key, created_at)
  VALUES (1, '18800000001', 50.00, 12, 100.00, 'silver', '2026-06-01 09:00:00');
INSERT INTO retail_orders (id, customer_id, subtotal, total, status, placed_at, paid_at, points_earned)
  VALUES (10, 1, 100.00, 100.00, 'paid', '2026-08-01 09:00:00', '2026-08-01 10:00:00', 12);
INSERT INTO retail_points_transactions (id, customer_id, delta, balance_after, source, order_id, created_at)
  VALUES (100, 1, 12, 12, 'order_earn', 10, '2026-08-01 10:00:01');
INSERT INTO retail_topup_transactions (id, customer_id, amount, status, payment_method, out_trade_no, created_at)
  VALUES (200, 1, 50.00, 'success', 'wechat', 'FCTU-1', '2026-07-01 12:00:00');
INSERT INTO retail_lifetime_commissions (id, order_id, referrer_id, customer_id, commission_amount, created_at)
  VALUES (300, 10, 1, 1, 0, '2026-08-01 10:00:02');
`;

// Each mutation seeds ONE break and declares which checks must move and by how
// much. A mutation that takes an unrelated check red is itself a finding, so
// every expectation is written out rather than only the interesting one.
const MUTATIONS = [
  { label: 'points_balance bumped with no ledger row (a lost award, or a silent gift)',
    sql: `UPDATE retail_customers SET points_balance = points_balance + 5 WHERE id = 1`,
    expect: { E: 1, G: 0, H: 0 } },

  { label: 'balance credited with no ledger row (money from nowhere)',
    sql: `UPDATE retail_customers SET balance = balance + 9.99 WHERE id = 1`,
    expect: { F: 1, E: 0 } },

  { label: 'balance off by less than half a fen (must NOT trip — this is the tolerance)',
    sql: `UPDATE retail_customers SET balance = balance + 0.004 WHERE id = 1`,
    expect: { F: 0 } },

  { label: 'balance_after stamped from a stale read (two writers interleaved)',
    sql: `INSERT INTO retail_points_transactions (id, customer_id, delta, balance_after, source, created_at)
            VALUES (101, 1, 3, 12, 'admin_adjust', '2026-08-02 11:00:00');
          UPDATE retail_customers SET points_balance = 15 WHERE id = 1`,
    expect: { G: 1, E: 0 } },

  { label: 'a clawback drove the wallet negative',
    sql: `UPDATE retail_customers SET balance = -0.01 WHERE id = 1;
          INSERT INTO retail_topup_transactions (id, customer_id, amount, status, payment_method, out_trade_no, created_at)
            VALUES (201, 1, -50.01, 'success', 'referral_clawback', 'rc-1', '2026-08-03 09:00:00')`,
    expect: { H: 1, F: 0 } },

  { label: 'a ledger row whose customer is gone (what the boot migration purged)',
    sql: `INSERT INTO retail_points_transactions (id, customer_id, delta, balance_after, source, created_at)
            VALUES (102, 999, 5, 5, 'order_earn', '2026-08-04 09:00:00')`,
    expect: { I: 1 } },

  { label: 'the same out_trade_no credited twice (the column is not unique)',
    sql: `INSERT INTO retail_topup_transactions (id, customer_id, amount, status, payment_method, out_trade_no, created_at)
            VALUES (202, 1, 50.00, 'success', 'wechat', 'FCTU-1', '2026-08-05 09:00:00')`,
    expect: { J: 1, F: 1 } },

  { label: 'a commission row with no wallet ledger row (half-committed)',
    sql: `INSERT INTO retail_lifetime_commissions (id, order_id, referrer_id, customer_id, commission_amount, created_at)
            VALUES (301, 11, 1, 1, 4.50, '2026-08-06 09:00:00')`,
    expect: { K: 1 } },

  { label: 'a referral marked paid with no reward row (half-committed)',
    sql: `INSERT INTO retail_referrals (id, referrer_id, invitee_id, status, reward_amount, first_paid_order_id, rewarded_at, joined_at)
            VALUES (400, 1, 2, 'ordered', 20.00, 10, '2026-08-07 09:00:00', '2026-07-07 09:00:00')`,
    expect: { L: 1 } },

  { label: 'lifetime_spend drifted from the orders it is derived from',
    sql: `UPDATE retail_customers SET lifetime_spend = 250.00 WHERE id = 1`,
    expect: { M: 1 } },

  { label: 'a settled add-on with no earn ledger row (half-committed)',
    sql: `INSERT INTO retail_order_addons (id, order_id, customer_id, amount, earn_points, status, paid_at, created_at)
            VALUES (500, 10, 1, 30.00, 3, 'success', '2026-08-08 09:00:00', '2026-08-08 08:00:00')`,
    expect: { N: 1 } },

  { label: 'an earn batch marked swept with no expiry row written',
    sql: `UPDATE retail_points_transactions SET expired_at = '2026-08-09 00:00:00' WHERE id = 100`,
    expect: { O: 1 } },
];

// ── Harness ───────────────────────────────────────────────────────────────
let failed = 0;
function ok(label, pass, got, want) {
  if (!pass) failed++;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${label}${pass ? '' : `   got ${got}, want ${want}`}`);
}

function fresh(seed) {
  const db = new DatabaseSync(':memory:');
  db.exec(DDL);
  for (const stmt of seed.split(';')) if (stmt.trim()) db.exec(stmt);
  return db;
}
const runCheck = (db, c) =>
  Number(db.prepare(c.count).all(...(c.countParams || []))[0].n || 0);
const byId = (id) => {
  const c = CHECKS.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id} in check_ledger_invariants.js — the suite and the script disagree`);
  return c;
};

console.log(`\ntest_ledger_invariants — ${CHECKS.length} checks imported from check_ledger_invariants.js`);
console.log(`money tolerance under test: ¥${MONEY_EPS}\n`);

console.log('BEHAVIOURAL — green pass: clean fixture, every INVARIANT must return 0');
{
  const db = fresh(CLEAN);
  for (const c of CHECKS) {
    const n = runCheck(db, c);
    if (c.kind === 'invariant') ok(`[${c.id}] ${c.title}`, n === 0, n, 0);
    else console.log(`  n/a   [${c.id}] ${c.title} — ${c.kind}, clean value = ${n}`);
  }
  db.close();
}

console.log('\nBEHAVIOURAL — red pass: one seeded break each, caught by the named checks');
for (const m of MUTATIONS) {
  const db = fresh(CLEAN);
  for (const stmt of m.sql.split(';')) if (stmt.trim()) db.exec(stmt);
  for (const [cid, want] of Object.entries(m.expect)) {
    const n = runCheck(db, byId(cid));
    ok(`${m.label}  ->  ${cid}`, n === want, n, want);
  }
  db.close();
}

console.log('\nBEHAVIOURAL — every DETAIL query runs and returns the rows behind its count');
{
  // Seeded so that every check has something to show. A detail query that
  // throws would otherwise only be discovered on the day something breaks —
  // which is the one day nobody wants to debug the diagnostic.
  const db = fresh(CLEAN);
  for (const m of MUTATIONS) {
    for (const stmt of m.sql.split(';')) {
      if (!stmt.trim()) continue;
      try { db.exec(stmt); } catch (e) { /* later mutations can conflict; the earlier one stands */ }
    }
  }
  for (const c of CHECKS) {
    let rows = null, err = null;
    try { rows = db.prepare(c.detail).all(...(c.detailParams || [])); }
    catch (e) { err = e.message; }
    ok(`[${c.id}] detail query executes`, err === null, err, 'no error');
    if (rows && c.kind === 'invariant' && rows.length === 0) {
      // Not fatal — a mutation may have been undone by a later one — but say so.
      console.log(`        note: [${c.id}] detail returned 0 rows in the combined fixture`);
    }
  }
  db.close();
}

console.log('\nSOURCE — every query is written as a SELECT');
console.log('  (author intent only; the ENGINE\'s refusal is the readonly flag / BEGIN READ ONLY,');
console.log('   neither of which is exercised here — see the header)');
for (const c of CHECKS) {
  for (const [which, sql] of [['count', c.count], ['detail', c.detail]]) {
    const first = String(sql).trim().split(/\s+/)[0].toUpperCase();
    ok(`[${c.id}] ${which} starts with SELECT`, first === 'SELECT', first, 'SELECT');
  }
}

console.log('\nSOURCE — M and P cannot set the exit code');
for (const id of ['M', 'P']) {
  const c = byId(id);
  ok(`[${id}] kind is not 'invariant' (is '${c.kind}')`, c.kind !== 'invariant', c.kind, "not 'invariant'");
  ok(`[${id}] prints its caveat in the output`, Array.isArray(c.notes) && c.notes.length >= 3,
    c.notes ? c.notes.length : 0, '>= 3 note lines');
}

// M shipped 2026-08-13 asserting that stored could never exceed derived, and the
// first live run met a customer at +899.00. Reason 4 is pinned here so a later
// tidy-up of the note cannot quietly restore the false claim — the assertion is
// about the TEXT because the text is what the operator acts on.
//
// REPINNED 2026-08-17, AND THE OLD PIN IS THE LESSON. This asserted that reason 4
// cited `:24839`. A LINE NUMBER IS NOT AN ANCHOR: the reference had already
// drifted off the branch it named — at the 08-17 head, 24839 lands inside an
// unrelated comment about offline payment methods — so the assertion was
// guarding a string that no longer pointed at anything, and it went red for
// the fix that made it obsolete rather than for a regression. §24's own rule is
// to cite by symbol; the pin now does. Deliberately NOT weakened to make the fix
// pass: it gained the two facts a later tidy-up is most likely to lose.
console.log('\nSOURCE — M names the fourth reason, records its fix, and no longer claims positive drift is impossible');
{
  const m = byId('M').notes.join('\n');
  ok('[M] names reason 4 (the no-gateway-refund cancel), by symbol not line number',
    /^\s*4\./m.test(m) && /reversal helpers/.test(m) && /awardOrderPoints/.test(m),
    'missing', 'a numbered reason 4 naming the reversal helpers');
  ok('[M] says reason 4 is a defect, not legitimate',
    /NOT LEGITIMATE/.test(m), 'missing', 'reason 4 marked NOT LEGITIMATE');
  ok('[M] no longer asserts stored-above-derived is impossible',
    !/none of the (three|four) can produce that/.test(m), 'the false claim is back', 'claim absent');
  // Fixed 2026-08-17. Reason 4 stays on the list because the 20 orders it already
  // produced are still in the data, but the note must say it no longer accrues —
  // otherwise the next reader chases a live defect that is closed.
  ok('[M] records that reason 4 is FIXED and no longer accrues',
    /FIXED AND DEPLOYED 2026-08-17/.test(m) && /NO LONGER ACCRUES/.test(m),
    'missing', 'reason 4 marked fixed');
  // The two facts most likely to be lost in a tidy-up, pinned for that reason.
  ok('[M] records that reason 4 touched ZERO real customers',
    /REAL CUSTOMERS AFFECTED: ZERO/.test(m), 'missing', 'the zero-real-customers finding');
  ok('[M] carries the ¥38.80 -> ¥0.49 correction rather than the original figure',
    /outstanding figure is ¥0\.49/.test(m), 'missing', 'the corrected balance figure');
}

console.log(failed === 0
  ? `\nPASSED — ${CHECKS.length} checks, ${MUTATIONS.length} mutations, every assertion held.\n`
  : `\n${failed} ASSERTION(S) FAILED.\n`);
process.exitCode = failed === 0 ? 0 : 1;
