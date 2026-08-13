#!/usr/bin/env node
/**
 * `claimMigrationCredit` writes the wallet ledger row (decisions §24, check F).
 *
 *   node scripts/test_migration_credit_ledger.js
 *
 * THE REAL FUNCTION IS EXTRACTED FROM routes/retail.js AND EXECUTED. A harness
 * that runs a copy is testing a different program — recorded twice in §24 — so
 * the body under test is sliced out of the file, not reproduced here.
 *
 * ── WHAT THIS SUITE HAS TO PROVE, GIVEN THE PATH IS CLAIM-ONCE ────────────
 * The compare-and-set means a credit can be claimed at most once per arming, so
 * "call it twice and assert one row" is unreachable against the real guard. The
 * assertions that ARE reachable are the ones that matter anyway:
 *
 *   • CHECK F ITSELF, per customer, after a claim — SUM(amount) over successful
 *     rows must equal balance. Not a proxy for the invariant: the invariant.
 *   • THE LOST RACE, which is the idempotency proof and needs no re-arming.
 *   • THE ROLLBACK, which is what proves the new write is INSIDE the
 *     transaction. This is the assertion that would have caught the original
 *     defect, because the defect was a credit with no row and a rollback that
 *     could not have told the difference.
 *   • THE RE-ARM, both directions, because the out_trade_no scheme exists
 *     entirely for that case and can be demonstrated nowhere else.
 *
 * ── WHAT IT DOES NOT PROVE ────────────────────────────────────────────────
 * Nothing about concurrency. better-sqlite3 is synchronous and the app runs
 * single-instance, so two claims cannot interleave; a suite that issued two
 * calls from one synchronous block would be green and prove nothing, which is
 * the mistake recorded in lib/db-transaction.js.
 *
 * TO PROVE THE SUITE CAN FAIL:  MCL_MUTANT=1 node scripts/test_migration_credit_ledger.js
 * The mutant deletes the new INSERT — restoring the defect exactly — and the
 * suite must go RED. Per §24 (v4.27) the mutation ASSERTS IT MODIFIED THE
 * SOURCE before its red is allowed to count as evidence.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openTablesDb, driver } = require('./test-support/memory-db');

const MUTANT = process.env.MCL_MUTANT === '1';
const ROOT = path.join(__dirname, '..');
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
// Normalised at read: routes/retail.js is CRLF in a Windows checkout, and an
// anchor written with "\n" would match nothing and pass silently.
const RETAIL_SRC = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8').replace(/\r\n/g, '\n');

function extractFunction(code, name) {
  const m = new RegExp(`^function ${name}\\(`, 'm').exec(code);
  assert.ok(m, `function ${name} not found`);
  const end = code.indexOf('\n}', m.index);
  assert.notStrictEqual(end, -1, `unterminated function ${name}`);
  return code.slice(m.index, end + 2);
}

const REAL_SRC = extractFunction(RETAIL_SRC, 'claimMigrationCredit');

// ── The mutant: delete the ledger INSERT, restoring the original defect ────
const MUTATION_ANCHOR = 'INSERT INTO retail_topup_transactions';
let SRC = REAL_SRC;
if (MUTANT) {
  const n = REAL_SRC.split(MUTATION_ANCHOR).length - 1;
  assert.strictEqual(n, 1,
    `mutation anchor matched ${n} times — expected exactly 1. The mutation did not ` +
    'modify the source, so a red run would prove nothing.');
  // Excise the whole prepare(...).run(...) statement, not just the SQL, so the
  // mutant is the pre-fix function rather than a syntax error.
  const start = REAL_SRC.indexOf('        tdb().prepare(\n          `INSERT INTO retail_topup_transactions');
  assert.notStrictEqual(start, -1, 'could not locate the ledger INSERT statement to excise');
  const end = REAL_SRC.indexOf('        );\n      }', start);
  assert.notStrictEqual(end, -1, 'could not locate the end of the ledger INSERT statement');
  SRC = REAL_SRC.slice(0, start) + REAL_SRC.slice(end + '        );\n'.length);
  assert.notStrictEqual(SRC, REAL_SRC, 'the mutant source is identical to the real source');
  assert.ok(!SRC.includes(MUTATION_ANCHOR), 'the mutant still contains the ledger INSERT');
}

// ── Fixture ────────────────────────────────────────────────────────────────
const TABLES = ['retail_customers', 'retail_migration_credits',
                'retail_topup_transactions', 'retail_points_transactions'];

/**
 * A reference .transaction(), for drivers that do not ship one.
 *
 * node:sqlite has no .transaction() at all — the split scripts/test-support/
 * memory-db.js documents. The same statements better-sqlite3 issues, because
 * the ROLLBACK test below is only meaningful against real BEGIN/ROLLBACK: a
 * fake that swallowed the unwind would make the most important assertion in
 * this suite pass for the wrong reason. Lifted from test_handle_threading_batch2.
 */
function ensureTransactionMethod(db) {
  if (typeof db.transaction === 'function') return db;   // better-sqlite3: the real one
  let depth = 0;
  db.transaction = (fn) => (...args) => {
    const mine = depth;
    const sp = `tacet_test_sp_${mine}`;
    if (mine === 0) db.exec('BEGIN'); else db.exec(`SAVEPOINT ${sp}`);
    depth = mine + 1;
    try {
      const r = fn(...args);
      depth = mine;
      if (mine === 0) db.exec('COMMIT'); else db.exec(`RELEASE SAVEPOINT ${sp}`);
      return r;
    } catch (e) {
      depth = mine;
      try {
        if (mine === 0) db.exec('ROLLBACK');
        else { db.exec(`ROLLBACK TO SAVEPOINT ${sp}`); db.exec(`RELEASE SAVEPOINT ${sp}`); }
      } catch { /* already unwound */ }
      throw e;
    }
  };
  return db;
}
const REAL_TX = typeof openTablesDb(DB_SRC, ['retail_customers']).transaction === 'function';

function fresh() {
  const db = ensureTransactionMethod(openTablesDb(DB_SRC, TABLES));
  db.prepare("INSERT INTO retail_customers (id, openid, nickname, phone, balance, points_balance) VALUES (1,'o1','A','13800000001',0,0)").run();
  db.prepare("INSERT INTO retail_customers (id, openid, nickname, phone, balance, points_balance) VALUES (2,'o2','B','13800000002',0,0)").run();
  return db;
}
const credit = (db, { id = 10, phone = '13800000001', balance = 100.5, points = 40, uid = 'U9' } = {}) => {
  db.prepare('INSERT INTO retail_migration_credits (id, phone, balance, points, source_uid) VALUES (?,?,?,?,?)')
    .run(id, phone, balance, points, uid);
  return id;
};

function makeFn(db) {
  return new Function('tdb', 'normalizeMigrationPhone',
    `${SRC}\nreturn claimMigrationCredit;`)(
    () => db,
    new Function('raw', `${extractFunction(RETAIL_SRC, 'normalizeMigrationPhone').replace(/^function normalizeMigrationPhone\(raw\) \{|\}$/g, '')}`)
  );
}

const wallet = (db, cid) => db.prepare('SELECT * FROM retail_topup_transactions WHERE customer_id = ? ORDER BY id').all(cid);
const bal = (db, cid) => db.prepare('SELECT balance FROM retail_customers WHERE id = ?').get(cid).balance;
const pts = (db, cid) => db.prepare('SELECT COUNT(*) AS c FROM retail_points_transactions WHERE customer_id = ?').get(cid).c;
/** Check F, exactly as scripts/check_ledger_invariants.js computes it. */
const checkF = (db, cid) => {
  const r = db.prepare(`
    SELECT COALESCE(c.balance,0) AS bal,
           (SELECT COALESCE(SUM(t.amount),0) FROM retail_topup_transactions t
             WHERE t.customer_id = c.id AND t.status = 'success') AS led
      FROM retail_customers c WHERE c.id = ?`).get(cid);
  return Math.abs(r.bal - r.led) <= 0.005;
};
/** Check J, exactly as the checker computes it. */
const checkJ = (db) => db.prepare(`
  SELECT COUNT(*) AS n FROM (
    SELECT out_trade_no FROM retail_topup_transactions
     WHERE out_trade_no IS NOT NULL GROUP BY out_trade_no HAVING COUNT(*) > 1)`).get().n;

let pass = 0, fail = 0;
const failures = [];
function it(name, fn) {
  try { fn(); pass++; console.log(`  ok    ${name}`); }
  catch (e) { fail++; failures.push(name); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

console.log('\nclaimMigrationCredit — the wallet ledger row\n');

// 1 ── The row exists, and it is the right row.
it('a claim writes exactly one wallet row, with the designed shape', () => {
  const db = fresh(); credit(db);
  makeFn(db)(1);
  const rows = wallet(db, 1);
  assert.strictEqual(rows.length, 1, 'expected exactly one wallet row');
  const r = rows[0];
  assert.strictEqual(Number(r.amount), 100.5, 'amount is not the credited balance');
  assert.strictEqual(r.status, 'success', "status must be 'success' or check F ignores the row");
  assert.strictEqual(r.payment_method, 'migration');
  assert.strictEqual(r.bonus_points, 0, 'points must not be double-recorded here');
  assert.strictEqual(r.out_trade_no, 'migration:10:1');
  assert.ok(r.paid_at, 'paid_at not stamped');
  const payload = JSON.parse(r.raw_callback_json);
  assert.strictEqual(payload.migration_credit_id, 10);
  assert.strictEqual(payload.source_uid, 'U9');
  assert.strictEqual(payload.points, 40);
});

// 2 ── THE INVARIANT ITSELF, not a proxy for it.
it('check F holds for the customer after a claim', () => {
  const db = fresh(); credit(db);
  makeFn(db)(1);
  assert.strictEqual(bal(db, 1), 100.5, 'balance was not credited');
  assert.ok(checkF(db, 1), 'check F fails: the balance is not explained by the ledger');
});

// 3 ── Both halves still land, and neither leaks into the other.
it('the points half is unchanged and still writes its own row', () => {
  const db = fresh(); credit(db);
  makeFn(db)(1);
  assert.strictEqual(pts(db, 1), 1, 'the points ledger row went missing');
  assert.strictEqual(wallet(db, 1).length, 1, 'the points half wrote a wallet row');
});

it('branch independence: a points-only credit writes NO wallet row', () => {
  const db = fresh(); credit(db, { balance: 0, points: 25 });
  makeFn(db)(1);
  assert.strictEqual(wallet(db, 1).length, 0, 'a zero-balance credit wrote a wallet row');
  assert.strictEqual(pts(db, 1), 1);
  assert.ok(checkF(db, 1));
});

it('branch independence: a balance-only credit writes NO points row', () => {
  const db = fresh(); credit(db, { points: 0 });
  makeFn(db)(1);
  assert.strictEqual(wallet(db, 1).length, 1);
  assert.strictEqual(pts(db, 1), 0, 'a zero-points credit wrote a points row');
  assert.ok(checkF(db, 1));
});

// 4 ── THE LOST RACE. The idempotency proof, reachable without re-arming.
it('lost race: an already-claimed credit writes no row and moves no money', () => {
  const db = fresh(); credit(db);
  db.prepare('UPDATE retail_migration_credits SET claimed_at = CURRENT_TIMESTAMP, claimed_customer_id = 2 WHERE id = 10').run();
  const out = makeFn(db)(1);
  assert.strictEqual(out, null, 'a lost race should return null');
  assert.strictEqual(wallet(db, 1).length, 0, 'a lost race wrote a wallet row');
  assert.strictEqual(bal(db, 1), 0, 'a lost race moved money');
  assert.strictEqual(pts(db, 1), 0);
});

// 5 ── THE ROLLBACK. What proves the write is INSIDE the transaction — and the
// assertion that would have caught the original defect.
it('rollback: a failing ledger INSERT unwinds the claim AND the balance', () => {
  const db = fresh(); credit(db);
  db.exec('DROP TABLE retail_topup_transactions');     // forced failure at the new write
  const out = makeFn(db)(1);
  assert.strictEqual(out, null, 'the failure was swallowed as a success');
  assert.strictEqual(bal(db, 1), 0, 'the balance survived a rolled-back claim');
  assert.strictEqual(pts(db, 1), 0, 'a points row survived a rolled-back claim');
  const c = db.prepare('SELECT claimed_at, claimed_customer_id FROM retail_migration_credits WHERE id = 10').get();
  assert.strictEqual(c.claimed_at, null, 'the credit stayed claimed after a rollback — it can never be claimed again');
  assert.strictEqual(c.claimed_customer_id, null);
});

// 6 ── THE RE-ARM, both directions. The whole reason the key carries the claimant.
it('re-arm + DIFFERENT customer: two rows, distinct keys, check J stays clean', () => {
  const db = fresh(); credit(db);
  makeFn(db)(1);
  // A re-import resets claimed_at — §24, the staging table is not append-only.
  db.prepare('UPDATE retail_migration_credits SET claimed_at = NULL, claimed_customer_id = NULL, phone = ? WHERE id = 10')
    .run('13800000002');
  makeFn(db)(2);
  const keys = db.prepare('SELECT out_trade_no FROM retail_topup_transactions ORDER BY id').all().map((r) => r.out_trade_no);
  assert.deepStrictEqual(keys, ['migration:10:1', 'migration:10:2'], 'the two claims did not get distinct keys');
  assert.strictEqual(checkJ(db), 0, 'check J reported a duplicate for two legitimate claims');
  assert.ok(checkF(db, 1) && checkF(db, 2), 'check F broke after a re-armed claim');
});

it('re-arm + SAME customer: check J FIRES, because that is a real double credit', () => {
  const db = fresh(); credit(db);
  makeFn(db)(1);
  db.prepare('UPDATE retail_migration_credits SET claimed_at = NULL, claimed_customer_id = NULL WHERE id = 10').run();
  makeFn(db)(1);
  assert.strictEqual(wallet(db, 1).length, 2, 'the second claim wrote no row');
  assert.strictEqual(checkJ(db), 1, 'check J stayed silent on a genuine double credit');
});

// ── Source assertions ──────────────────────────────────────────────────────

it('source: the INSERT is inside the balance branch, above the points branch', () => {
  const balAt = REAL_SRC.indexOf("SET balance = COALESCE(balance, 0) + ?");
  const insAt = REAL_SRC.indexOf('INSERT INTO retail_topup_transactions');
  const ptsAt = REAL_SRC.indexOf("SET points_balance = COALESCE(points_balance, 0) + ?");
  assert.ok(balAt !== -1 && insAt !== -1 && ptsAt !== -1, 'one of the three anchors is missing');
  assert.ok(balAt < insAt && insAt < ptsAt,
    'the ledger INSERT is not between the balance UPDATE and the points branch');
});

it('source: the whole claim is still one transaction', () => {
  assert.ok(/tdb\(\)\.transaction\(\(\) => \{/.test(REAL_SRC), 'the transaction wrapper changed shape');
  const txAt = REAL_SRC.indexOf('tdb().transaction(');
  assert.ok(txAt < REAL_SRC.indexOf('INSERT INTO retail_topup_transactions'),
    'the ledger INSERT moved outside the transaction');
});

it("source: status is 'success', or check F would ignore the row", () => {
  assert.ok(/'migration', 'success', CURRENT_TIMESTAMP/.test(REAL_SRC),
    "the row is no longer written as payment_method 'migration' / status 'success'");
});

it('source: out_trade_no carries BOTH the credit id and the claimant', () => {
  assert.ok(/`migration:\$\{credit\.id\}:\$\{customerId\}`/.test(REAL_SRC),
    'the out_trade_no scheme dropped the claimant — a re-armed credit would collide');
});

// ── Footer ─────────────────────────────────────────────────────────────────
console.log('');
console.log(`  driver: ${driver}${REAL_TX ? '' : '  (.transaction() = reference BEGIN/ROLLBACK implementation — this driver has none)'}`);
if (MUTANT) {
  console.log('  mutant: the ledger INSERT was excised (the pre-fix function)');
  console.log(`  mutant: ${fail} failed  (0 would mean the suite cannot detect the original defect)`);
  if (fail === 0) {
    console.log('\n  MUTANT SURVIVED — the suite proves nothing. Treat as a failure.\n');
    process.exitCode = 1;
  } else {
    console.log(`\n  ${pass} passed, ${fail} failed — mutant correctly detected\n`);
    process.exitCode = 0;
  }
} else {
  if (failures.length) console.log(`  failed: ${failures.join(', ')}`);
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exitCode = fail === 0 ? 0 : 1;
}
