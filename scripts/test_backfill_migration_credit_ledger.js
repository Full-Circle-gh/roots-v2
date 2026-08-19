#!/usr/bin/env node
/**
 * backfill_migration_credit_ledger.js — the suite.
 *
 *   node scripts/test_backfill_migration_credit_ledger.js
 *
 * THE REAL SCRIPT IS EXECUTED, as a child process against a real SQLite file
 * built from database.js's own DDL. Not a copy of its logic, not a stub: the
 * file that would run against production, driven exactly as an operator drives
 * it. A harness that runs a copy is testing a different program (§24, twice).
 *
 * ── THE FIXTURE IS AN ASSERTION, NOT A SETUP STEP ─────────────────────────
 * Test 1 runs check F's OWN query against the fixture before anything else and
 * requires 7 customers and ¥3,669.64. If that fails, every later test is
 * meaningless — a suite that proves a repair works against a state that is not
 * the broken state proves nothing. The fixture reproduces §24's table row for
 * row, including the two customers with NEGATIVE ledger sums (161, 416), which
 * are the shape most likely to be got wrong by a repair that assumes the ledger
 * side starts at zero.
 *
 * ── WHAT THIS SUITE EXISTS TO CATCH ───────────────────────────────────────
 * One thing above all others: A BACKFILL THAT ALSO CREDITS THE BALANCE. The
 * money is already in the wallet; crediting it again would create ¥3,669.64 of
 * real liability while making check F pass, so F cannot detect it and the
 * script's own output would report success. Test 5 is that assertion and the
 * mutant below is built to violate exactly it.
 *
 * TO PROVE THE SUITE CAN FAIL:  BMC_MUTANT=1 node scripts/test_backfill_migration_credit_ledger.js
 * The mutant adds the balance UPDATE the header forbids — the most expensive
 * plausible edit anyone could make to this script — and the suite must go RED.
 * Per §24 (v4.27) the mutation ASSERTS IT MODIFIED THE SOURCE before its red is
 * allowed to count as evidence.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const REAL = path.join(__dirname, 'backfill_migration_credit_ledger.js');
const REAL_SRC = fs.readFileSync(REAL, 'utf8');
const MUTANT = process.env.BMC_MUTANT === '1';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ok    ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n          ${e.message}`); }
};

// ── the script under test, possibly mutated ──────────────────────────────
// The mutant is written INTO scripts/ rather than a temp directory so that
// require('better-sqlite3') resolves identically; it is removed in the finally
// at the bottom.
let SCRIPT = REAL;
if (MUTANT) {
  const anchor = `    db.prepare(\n      \`INSERT INTO retail_topup_transactions`;
  const mutated = REAL_SRC.replace(
    anchor,
    `    db.prepare('UPDATE retail_customers SET balance = ROUND(COALESCE(balance,0) + ?, 2) WHERE id = ?').run(p.unexplained, p.customerId);\n` + anchor
  );
  // §24 v4.27: a mutation that did not modify the source proves nothing, and a
  // vacuous pass is the failure mode this rule exists to stop.
  assert.notStrictEqual(mutated, REAL_SRC, 'MUTANT DID NOT MODIFY THE SOURCE — anchor missing, red would be vacuous');
  SCRIPT = path.join(__dirname, '_mutant_backfill_migration_credit_ledger.js');
  fs.writeFileSync(SCRIPT, mutated);
  console.log('MUTANT ACTIVE — the balance UPDATE has been added. The suite MUST go red.\n');
}

// ── fixture ──────────────────────────────────────────────────────────────
// Tables built from database.js's real DDL, so a column added there and
// forgotten here cannot make this suite quietly pass.
// addTables is the repo's shared builder — the REAL CREATE plus every
// addColumn() bolted on since. Hand-rolling the extraction here is the exact
// duplication drift scripts/test-support/memory-db.js exists to end, so this
// suite borrows it and passes a FILE-backed handle instead of :memory:, because
// the script under test is driven over --db as an operator drives it.
const { addTables } = require('./test-support/memory-db');
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
// The first four are what the backfill touches. The last four are empty and
// exist only so check_ledger_invariants.js can RUN against this fixture — test
// 15 drives the real checker rather than this file's copy of check F's query,
// and a checker that dies on a missing table proves nothing either way.
const TABLES = ['retail_customers', 'retail_topup_transactions',
  'retail_migration_credits', 'retail_points_transactions',
  'retail_orders', 'retail_lifetime_commissions', 'retail_referrals', 'retail_order_addons'];

// §24 v4.36's table, reproduced exactly.
const SEVEN = [
  { id: 57,  balance:    9.99, ledger:    0.00, staging: null,    orphan: true },
  { id: 92,  balance:  885.00, ledger:    0.00, staging:  885.00, orphan: false },
  { id: 161, balance:    0.00, ledger: -394.95, staging:  394.95, orphan: false },
  { id: 306, balance:   98.40, ledger:    0.00, staging:   98.40, orphan: false },
  { id: 416, balance:  196.50, ledger: -199.50, staging:  396.00, orphan: false },
  { id: 693, balance:  143.80, ledger:    0.00, staging:  143.80, orphan: false },
  { id: 814, balance: 1741.50, ledger:    0.00, staging: 1741.50, orphan: false },
];

let tmpDir;
let code = 1;   // fail-closed: only an explicit pass sets this to 0
function makeDb() {
  const p = path.join(tmpDir, `fx-${Math.random().toString(36).slice(2)}.db`);
  const db = addTables(new Database(p), DB_SRC, DB_SRC, TABLES);

  // openid is NOT NULL on the real table. 57's is the `_reset_` shape §24
  // identifies it by — the suite carries the real thing so the orphan target
  // looks in the fixture the way it looks in production.
  const insC = db.prepare('INSERT INTO retail_customers (id, openid, balance) VALUES (?, ?, ?)');
  const insT = db.prepare(
    `INSERT INTO retail_topup_transactions (customer_id, amount, bonus_points, payment_method, status, paid_at, out_trade_no)
     VALUES (?, ?, 0, ?, 'success', ?, ?)`);
  const insM = db.prepare(
    `INSERT INTO retail_migration_credits (id, phone, balance, points, source_uid, claimed_at, claimed_customer_id)
     VALUES (?, ?, ?, 0, ?, ?, ?)`);
  const insP = db.prepare(
    `INSERT INTO retail_points_transactions (customer_id, delta, balance_after, source, created_at)
     VALUES (?, 0, 0, 'migration', ?)`);

  let creditId = 1500;
  for (const c of SEVEN) {
    insC.run(c.id, c.id === 57 ? '_reset_1781343070821_oeqDi5KI8Mex' : `oOpenid${c.id}`, c.balance);
    // The negative-ledger customers got there by SPENDING with only the spend
    // recorded. That is the real shape and the suite uses it, not a shortcut.
    if (c.ledger !== 0) insT.run(c.id, c.ledger, 'order_redeem', '2026-07-01 10:00:00', `orderspend:${c.id}`);
    if (!c.orphan) {
      insM.run(++creditId, `1380000${String(c.id).padStart(4, '0')}`, c.staging, `uid-${c.id}`, '2026-07-01 09:00:00', c.id);
    }
    // Every claim wrote its POINTS row — that half was never broken. It is also
    // the orphan's only timestamp source.
    insP.run(c.id, '2026-07-01 09:00:00');
  }
  db.close();
  return p;
}

// check F's own query, lifted verbatim in shape from check_ledger_invariants.js.
function checkF(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(`
    SELECT cmp.cid AS customer_id, cmp.bal AS balance, cmp.led AS ledger_sum, (cmp.bal - cmp.led) AS drift
      FROM (SELECT c.id AS cid, COALESCE(c.balance, 0) AS bal,
                   (SELECT COALESCE(SUM(tt.amount), 0) FROM retail_topup_transactions tt
                     WHERE tt.customer_id = c.id AND tt.status = 'success') AS led
              FROM retail_customers c) AS cmp
     WHERE ABS(cmp.bal - cmp.led) > 0.005 ORDER BY cmp.cid`).all();
  db.close();
  const total = Math.round(rows.reduce((s, r) => s + r.drift, 0) * 100) / 100;
  return { count: rows.length, total, rows };
}
// check J's own query — duplicate out_trade_no.
function checkJ(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const n = db.prepare(`SELECT COUNT(*) AS n FROM (
      SELECT out_trade_no FROM retail_topup_transactions WHERE out_trade_no IS NOT NULL
       GROUP BY out_trade_no HAVING COUNT(*) > 1) AS d`).get().n;
  db.close();
  return n;
}
function balances(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const r = db.prepare('SELECT id, balance FROM retail_customers ORDER BY id').all();
  db.close();
  return r;
}
function run(dbPath, args) {
  return execFileSync(process.execPath, [SCRIPT, '--db', dbPath, ...args], { encoding: 'utf8', cwd: ROOT });
}

// ── the suite ────────────────────────────────────────────────────────────
try {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmcl-'));
  console.log('backfill_migration_credit_ledger — suite\n');

  t('1  THE FIXTURE IS THE BROKEN STATE: check F reports 7 customers and ¥3,669.64', () => {
    const f = checkF(makeDb());
    assert.strictEqual(f.count, 7, `expected 7 failing customers, got ${f.count}`);
    assert.strictEqual(f.total, 3669.64, `expected ¥3,669.64 unexplained, got ¥${f.total}`);
  });

  t('2  the two negative-ledger customers are reproduced, not flattened', () => {
    const f = checkF(makeDb());
    const c161 = f.rows.find((r) => r.customer_id === 161);
    const c416 = f.rows.find((r) => r.customer_id === 416);
    assert.strictEqual(Math.round(c161.ledger_sum * 100) / 100, -394.95);
    assert.strictEqual(Math.round(c416.ledger_sum * 100) / 100, -199.50);
    assert.strictEqual(Math.round(c416.drift * 100) / 100, 396.00);
  });

  t('3  DRY RUN BY DEFAULT — no --apply writes nothing at all', () => {
    const p = makeDb();
    const before = checkF(p);
    const out = run(p, ['--include-orphan']);
    assert.ok(/DRY RUN/.test(out), 'output does not announce a dry run');
    const after = checkF(p);
    assert.deepStrictEqual(after.count, before.count, 'a dry run changed the data');
    assert.strictEqual(after.total, 3669.64);
  });

  t('4  the orphan is excluded unless --include-orphan is given', () => {
    const p = makeDb();
    const out = run(p, []);
    assert.ok(/customer 57: ORPHAN/.test(out), 'customer 57 was not skipped as an orphan');
    assert.ok(/6 row\(s\)/.test(out), `expected 6 planned rows without the flag, got:\n${out}`);
  });

  t('5  *** NO BALANCE IS TOUCHED *** — the assertion this script exists under', () => {
    const p = makeDb();
    const before = balances(p);
    run(p, ['--include-orphan', '--apply']);
    assert.deepStrictEqual(balances(p), before,
      'A BALANCE MOVED. The money was already in the wallet; this doubles it.');
  });

  t('6  --apply --include-orphan takes check F to ZERO', () => {
    const p = makeDb();
    run(p, ['--include-orphan', '--apply']);
    const f = checkF(p);
    assert.strictEqual(f.count, 0, `check F still fails on ${f.count}: ${JSON.stringify(f.rows)}`);
    assert.strictEqual(f.total, 0);
  });

  t('7  without the orphan, exactly customer 57 and ¥9.99 remain', () => {
    const p = makeDb();
    run(p, ['--apply']);
    const f = checkF(p);
    assert.strictEqual(f.count, 1);
    assert.strictEqual(f.rows[0].customer_id, 57);
    assert.strictEqual(Math.round(f.rows[0].drift * 100) / 100, 9.99);
  });

  t('8  IDEMPOTENT — a second --apply writes nothing and F stays at zero', () => {
    const p = makeDb();
    run(p, ['--include-orphan', '--apply']);
    const rowsAfterFirst = new Database(p, { readonly: true }).prepare(
      'SELECT COUNT(*) AS n FROM retail_topup_transactions').get().n;
    const out = run(p, ['--include-orphan', '--apply']);
    assert.ok(/already backfilled/.test(out), 'second run did not recognise the existing rows');
    const rowsAfterSecond = new Database(p, { readonly: true }).prepare(
      'SELECT COUNT(*) AS n FROM retail_topup_transactions').get().n;
    assert.strictEqual(rowsAfterSecond, rowsAfterFirst, 'the second run wrote rows');
    assert.strictEqual(checkF(p).count, 0);
  });

  t('9  the rows carry the LIVE WRITER\'s shape and key scheme', () => {
    const p = makeDb();
    run(p, ['--include-orphan', '--apply']);
    const db = new Database(p, { readonly: true });
    const rows = db.prepare(
      "SELECT * FROM retail_topup_transactions WHERE payment_method = 'migration' ORDER BY customer_id").all();
    db.close();
    assert.strictEqual(rows.length, 7);
    for (const r of rows) {
      assert.strictEqual(r.status, 'success', 'status must be success or check F ignores the row');
      assert.strictEqual(r.bonus_points, 0, 'bonus_points must stay 0 — the points half already has its row');
      assert.ok(r.paid_at, 'paid_at must carry the historical claim time');
      assert.ok(JSON.parse(r.raw_callback_json).backfill === true, 'the row must declare itself a backfill');
    }
    const c92 = rows.find((r) => r.customer_id === 92);
    assert.ok(/^migration:\d+:92$/.test(c92.out_trade_no), `key scheme wrong: ${c92.out_trade_no}`);
    const c57 = rows.find((r) => r.customer_id === 57);
    assert.strictEqual(c57.out_trade_no, 'migration:orphan:57');
  });

  t('10 check J stays at zero — no duplicate out_trade_no is created', () => {
    const p = makeDb();
    run(p, ['--include-orphan', '--apply']);
    assert.strictEqual(checkJ(p), 0, 'the backfill created a duplicate out_trade_no');
  });

  t('11 A MOVED DRIFT IS REFUSED, not adjusted', () => {
    const p = makeDb();
    const db = new Database(p);
    db.prepare('UPDATE retail_customers SET balance = balance + 50 WHERE id = 92').run();
    db.close();
    const out = run(p, ['--include-orphan', '--apply']);
    assert.ok(/customer 92: drift is ¥935\.00 but the measured figure was ¥885\.00 — data moved, refusing/.test(out),
      `92 was not refused on moved drift:\n${out}`);
    const f = checkF(p);
    assert.ok(f.rows.some((r) => r.customer_id === 92), '92 was written despite moved drift');
  });

  t('12 SOURCES THAT DISAGREE ARE REFUSED — staging edited under the script', () => {
    const p = makeDb();
    const db = new Database(p);
    db.prepare('UPDATE retail_migration_credits SET balance = 111.11 WHERE claimed_customer_id = 306').run();
    db.close();
    const out = run(p, ['--include-orphan', '--apply']);
    assert.ok(/customer 306: 0 staging rows carry ¥98\.40/.test(out), `306 was not refused:\n${out}`);
    assert.ok(checkF(p).rows.some((r) => r.customer_id === 306), '306 was written on one source');
  });

  t('13 a customer whose row already exists is skipped, not doubled', () => {
    const p = makeDb();
    const db = new Database(p);
    const cid = db.prepare('SELECT id FROM retail_migration_credits WHERE claimed_customer_id = 693').get().id;
    db.prepare(`INSERT INTO retail_topup_transactions
      (customer_id, amount, bonus_points, payment_method, status, out_trade_no)
      VALUES (693, 143.80, 0, 'migration', 'success', ?)`).run(`migration:${cid}:693`);
    db.close();
    const out = run(p, ['--include-orphan', '--apply']);
    assert.ok(/customer 693: migration:\d+:693 already exists/.test(out), `693 not recognised:\n${out}`);
    const db2 = new Database(p, { readonly: true });
    const n = db2.prepare("SELECT COUNT(*) AS n FROM retail_topup_transactions WHERE customer_id = 693 AND payment_method = 'migration'").get().n;
    db2.close();
    assert.strictEqual(n, 1, 'a second row was written for 693');
  });

  t('14 THE UNDO FILE ACTUALLY UNDOES — its instructions restore the finding', () => {
    const p = makeDb();
    const out = run(p, ['--include-orphan', '--apply']);
    const m = out.match(/UNDO FILE: (.+)/);
    assert.ok(m, 'no undo file was announced');
    const undo = JSON.parse(fs.readFileSync(m[1].trim(), 'utf8'));
    assert.strictEqual(undo.planned.length, 7);
    assert.strictEqual(checkF(p).count, 0);
    const db = new Database(p);
    const del = db.prepare("DELETE FROM retail_topup_transactions WHERE out_trade_no = ? AND payment_method = 'migration'");
    for (const row of undo.planned) del.run(row.out_trade_no);
    db.close();
    const back = checkF(p);
    assert.strictEqual(back.count, 7, 'the undo did not restore all seven');
    assert.strictEqual(back.total, 3669.64, `undo left ¥${back.total}, expected ¥3,669.64`);
  });

  t('15 THE REAL ACCEPTANCE TEST: check_ledger_invariants.js goes 1-OF-10-FAILED to ALL 10 PASSED', () => {
    // The strongest assertion in this file, and the only one that uses the
    // instrument the runbook actually names. Everything above measures F with
    // this suite's own copy of F's query; this drives the real checker, reads
    // its verdict line, and checks its EXIT CODE — which is the thing Part G of
    // the cutover runbook reads.
    const p = makeDb();
    const checker = path.join(__dirname, 'check_ledger_invariants.js');
    const runChecker = () => {
      try {
        const out = execFileSync(process.execPath, [checker, '--db', p], { encoding: 'utf8', cwd: ROOT });
        return { code: 0, out };
      } catch (e) { return { code: e.status, out: String(e.stdout || '') }; }
    };

    const before = runChecker();
    assert.strictEqual(before.code, 1, 'the checker did not fail on the broken fixture');
    assert.ok(/1 OF 10 INVARIANTS FAILED: F/.test(before.out),
      `expected exactly F to fail before, got:\n${before.out.slice(-400)}`);

    run(p, ['--include-orphan', '--apply']);

    const after = runChecker();
    assert.ok(/ALL 10 INVARIANTS PASSED/.test(after.out),
      `checker did not go green after the backfill:\n${after.out.slice(-600)}`);
    assert.strictEqual(after.code, 0, 'the checker still exits non-zero after the backfill');
  });

  t('16 the target list refuses to run if it no longer sums to the recorded total', () => {
    // Source-level, and labelled as such per §24 v4.34: this asserts the guard
    // EXISTS, not that it fires. It is the only one of the sixteen that does.
    assert.ok(/TARGET LIST SUMS TO/.test(REAL_SRC), 'the sum guard is gone');
    assert.ok(/TOTAL_EXPECTED = 3669\.64/.test(REAL_SRC), 'the recorded total is gone');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (MUTANT) {
    if (fail > 0) { console.log('MUTANT: suite went RED as required. The red-proof holds.'); code = 0; }
    else { console.log('MUTANT: suite stayed GREEN. THE SUITE DOES NOT PROVE WHAT IT CLAIMS.'); code = 1; }
  } else {
    code = fail ? 1 : 0;
  }
} finally {
  // process.exit() does not unwind to a finally, so the exit code is carried out
  // of the try and applied AFTER cleanup. The first version of this file exited
  // inside the try and left its mutant copy in scripts/ — a test that litters
  // the tree it is testing.
  if (MUTANT && SCRIPT !== REAL && fs.existsSync(SCRIPT)) fs.unlinkSync(SCRIPT);
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}
process.exit(code);
