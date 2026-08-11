#!/usr/bin/env node
/**
 * Handle threading, `createOrReuseManualCustomer` (decisions §24, Path A step 2).
 *
 *   node scripts/test_handle_threading_manual_customer.js
 *
 * WHY THIS HELPER LANDS ALONE. Batch 2 deliberately left it out and said why:
 * its only in-transaction call site is `POST /api/retail-admin/orders`, and
 * threading it while that route was excluded would have been work with no
 * consumer. The route is now being converted, so the helper travels with it.
 *
 * SAME STANDARD AS BATCHES 1 AND 2, AND FOR THE SAME REASON. `d7515a36` claimed
 * this kind of work was done when it was not, so a signature is not evidence.
 * The function is EXTRACTED FROM routes/retail.js AND EXECUTED, with `tdb()`
 * pointing at one database and the handle at another. A parameter that is
 * accepted and then ignored fails, because the rows land in the wrong database.
 *
 * *** THE READS MATTER AS MUCH AS THE WRITES ***
 * The order route calls this from inside its open transaction. The reuse-by-
 * phone SELECT has to see rows that transaction has written but not committed.
 * On the wrong handle it would miss them and CREATE A DUPLICATE CUSTOMER rather
 * than reusing one — a silent wrong answer behind a 200, not an error. Tests 3
 * and 4 are that case in both directions.
 *
 * *** THE OTHER CALLER MUST KEEP WORKING UNTOUCHED ***
 * `POST /api/retail-admin/customers` is synchronous, is NOT being converted, and
 * passes no handle. Test 5 runs the helper exactly as that route calls it — one
 * argument — and proves the default parameter still binds to tdb() at call time.
 * Test 8 asserts in the source that the call site was not edited.
 *
 * NO CONCURRENCY IS CLAIMED HERE. The helper is synchronous, and a "concurrency"
 * test whose calls originate in one synchronous block tests nothing — that
 * mistake is recorded in lib/db-transaction.js. What this suite tests is which
 * database each statement reaches, which is the property this change alters.
 *
 * TO PROVE THE SUITE CAN FAIL:  HTMC_MUTANT=1 node scripts/test_handle_threading_manual_customer.js
 * The mutant rewrites `h.prepare(` back to `tdb().prepare(` in the extracted
 * source — an accepted-but-ignored parameter — and the suite must go RED.
 * Per §24 (v4.27) the mutation ASSERTS IT ACTUALLY MODIFIED THE SOURCE before
 * its red is allowed to count as evidence.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openTablesDb, driver } = require('./test-support/memory-db');

const MUTANT = process.env.HTMC_MUTANT === '1';
const ROOT = path.join(__dirname, '..');
const RETAIL_SRC = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');

// ── Source extraction ──────────────────────────────────────────────────────
// Comments are stripped so an anchor cannot match inside one — the failure mode
// §24 records twice as "comment-blind matching".
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}
const RETAIL = stripComments(RETAIL_SRC);

function extractFunction(code, name) {
  const m = new RegExp(`^function ${name}\\(`, 'm').exec(code);
  if (!m) throw new Error(`function ${name} not found`);
  const end = code.indexOf('\n}', m.index);
  if (end === -1) throw new Error(`unterminated function ${name}`);
  return code.slice(m.index, end + 2);
}

function instantiate(src, name, scope) {
  const keys = Object.keys(scope);
  return new Function(...keys, `${src}\nreturn ${name};`)(...keys.map((k) => scope[k]));
}

const REAL_SRC = extractFunction(RETAIL, 'createOrReuseManualCustomer');

// ── The mutant, and the guard that makes its red mean something ────────────
// An anchor that matched nothing would produce a green mutant run, which reads
// as "the suite cannot fail" when it actually means "the mutation never
// happened". So the substitution count is asserted, not assumed. The anchor
// carries no line ending — a `\r\n` anchor is the specific mistake §24 records.
const MUTATION_ANCHOR = 'h.prepare(';
let SRC = REAL_SRC;
let mutationCount = 0;
if (MUTANT) {
  mutationCount = REAL_SRC.split(MUTATION_ANCHOR).length - 1;
  assert.ok(
    mutationCount >= 3,
    `mutation anchor "${MUTATION_ANCHOR}" matched ${mutationCount} times — expected at least 3. ` +
    'The mutation did not modify the source, so a red run would prove nothing.'
  );
  SRC = REAL_SRC.split(MUTATION_ANCHOR).join('tdb().prepare(');
  assert.notStrictEqual(SRC, REAL_SRC, 'the mutant source is identical to the real source');
}

// ── Fixtures ───────────────────────────────────────────────────────────────
// The REAL retail_customers, extracted from database.js with every addColumn()
// applied. Not a hand-written subset: §24 records a batch-2 defect that was
// exactly "a suite green against a table thinner than the one the code writes
// to", and this helper INSERTs a column list that must match the live table.
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');

function freshPair() {
  const a = openTablesDb(DB_SRC, ['retail_customers']);   // what tdb() returns
  const b = openTablesDb(DB_SRC, ['retail_customers']);   // what the handle points at
  return { a, b };
}

// The scope the extracted function closes over. `tdb` is swappable per test so
// the two databases can be told apart by which one the rows land in.
function makeFn(tdbTarget) {
  return instantiate(SRC, 'createOrReuseManualCustomer', {
    tdb: () => tdbTarget,
    normEmail: (e) => (e == null ? '' : String(e).trim().toLowerCase()),
    crypto: require('crypto'),
  });
}

const rows = (db) => db.prepare('SELECT id, nickname, phone, email FROM retail_customers ORDER BY id').all();
const count = (db) => db.prepare('SELECT COUNT(*) AS c FROM retail_customers').get().c;

// ── Runner ─────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const failures = [];
function it(name, fn) {
  try { fn(); pass++; console.log(`  ok    ${name}`); }
  catch (e) { fail++; failures.push(name); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

console.log('\ncreateOrReuseManualCustomer — handle threading\n');

// 1 ── CREATE writes to the passed handle, not to tdb().
it('create: the INSERT lands in the handle database, not tdb()', () => {
  const { a, b } = freshPair();
  const fn = makeFn(a);
  const made = fn({ nickname: 'Ada', phone: '13800000001', userId: 7 }, b);
  assert.strictEqual(made.created, true, 'expected a create');
  assert.strictEqual(count(b), 1, 'the row did not land in the handle database');
  assert.strictEqual(count(a), 0, 'the row landed in tdb() — the handle was ignored');
  assert.strictEqual(rows(b)[0].phone, '13800000001');
});

// 2 ── The mirror. Swapping which database is which must swap the result, so a
// test that passes because both databases happen to agree cannot hide here.
it('create: mirror — swapping the two databases swaps where the row lands', () => {
  const { a, b } = freshPair();
  const fn = makeFn(b);
  fn({ nickname: 'Grace', phone: '13800000002', userId: 7 }, a);
  assert.strictEqual(count(a), 1, 'the row did not follow the handle');
  assert.strictEqual(count(b), 0, 'the row followed tdb() instead of the handle');
});

// 3 ── THE READ. The reuse lookup must see the handle's rows. This is the case
// that matters inside the order transaction: the row exists ONLY in the handle
// database, and failing to see it creates a duplicate instead of reusing.
it('reuse: the SELECT reads the handle database — an existing row is reused', () => {
  const { a, b } = freshPair();
  b.prepare("INSERT INTO retail_customers (openid, nickname, phone) VALUES ('x1', '', '13800000003')").run();
  const fn = makeFn(a);
  const made = fn({ nickname: 'Backfilled', phone: '13800000003', userId: 7 }, b);
  assert.strictEqual(made.reused, true, 'the existing row was not seen — the read went to tdb()');
  assert.strictEqual(made.created, false);
  assert.strictEqual(count(b), 1, 'a duplicate was created in the handle database');
  assert.strictEqual(count(a), 0, 'a row was written to tdb()');
});

// 4 ── The read's mirror: the row exists only in tdb(), so a handle-reading
// helper must NOT see it and must create. This is what distinguishes "reads the
// handle" from "reads whichever database happens to have the row".
it('reuse: mirror — a row only in tdb() is NOT seen, so the helper creates', () => {
  const { a, b } = freshPair();
  a.prepare("INSERT INTO retail_customers (openid, nickname, phone) VALUES ('x2', 'Old', '13800000004')").run();
  const fn = makeFn(a);
  const made = fn({ nickname: 'New', phone: '13800000004', userId: 7 }, b);
  assert.strictEqual(made.created, true, 'the helper read tdb() and reused a row it should not have seen');
  assert.strictEqual(count(b), 1);
  assert.strictEqual(count(a), 1, 'tdb() was written to');
});

// 5 ── THE UNCONVERTED CALLER. POST /api/retail-admin/customers passes ONE
// argument. The default parameter must bind to tdb() at call time.
it('omitted handle: the unconverted caller still writes to tdb()', () => {
  const { a, b } = freshPair();
  const fn = makeFn(a);
  const made = fn({ nickname: 'Walk-in', phone: '13800000005', userId: 7 });
  assert.strictEqual(made.created, true);
  assert.strictEqual(count(a), 1, 'the omitting caller did not reach tdb()');
  assert.strictEqual(count(b), 0, 'the omitting caller reached the other database');
});

// 6 ── The default is evaluated PER CALL, not once at definition. This is the
// property that makes an omitting caller bind to the request's tenant
// connection; a module-load-time default would pin every call to one database.
it('omitted handle: the default is evaluated per call, not captured once', () => {
  const { a, b } = freshPair();
  let target = a;
  const fn = instantiate(SRC, 'createOrReuseManualCustomer', {
    tdb: () => target,
    normEmail: (e) => (e == null ? '' : String(e).trim().toLowerCase()),
    crypto: require('crypto'),
  });
  fn({ nickname: 'First', phone: '13800000006', userId: 7 });
  target = b;                                   // the request's connection changes
  fn({ nickname: 'Second', phone: '13800000007', userId: 7 });
  assert.strictEqual(count(a), 1, 'the first call did not reach the first database');
  assert.strictEqual(count(b), 1, 'the second call did not follow the changed tdb()');
});

// 7 ── The backfill UPDATE lands on the handle too, and still only fills blanks.
it('reuse: the backfill UPDATE lands on the handle and fills only blanks', () => {
  const { a, b } = freshPair();
  b.prepare("INSERT INTO retail_customers (openid, nickname, phone, email) VALUES ('x3', '', '13800000008', 'keep@me.com')").run();
  const fn = makeFn(a);
  fn({ nickname: 'Filled', email: 'new@me.com', phone: '13800000008', userId: 7 }, b);
  const r = rows(b)[0];
  assert.strictEqual(r.nickname, 'Filled', 'the blank nickname was not backfilled on the handle');
  assert.strictEqual(r.email, 'keep@me.com', 'a non-blank email was overwritten');
  assert.strictEqual(count(a), 0, 'the UPDATE went to tdb()');
});

// 8 ── Validation still refuses before touching either database. The route
// turns { error } into a 400 and rolls its transaction back; if the helper wrote
// first, the rollback would be doing work it should never have had to do.
it('validation: a bad phone returns { error } and writes to neither database', () => {
  const { a, b } = freshPair();
  const fn = makeFn(a);
  const made = fn({ nickname: 'Bad', phone: 'not-a-phone', userId: 7 }, b);
  assert.strictEqual(made.error, 'bad_phone');
  assert.strictEqual(count(a) + count(b), 0, 'a rejected input still wrote a row');
});

// ── Source assertions: the shape, and the caller that must not have moved ──

it('source: the signature carries the trailing optional handle', () => {
  assert.ok(
    /^function createOrReuseManualCustomer\(\{ nickname, email, phone, userId \}, h = tdb\(\)\) \{$/m.test(RETAIL),
    'the signature is not the trailing-optional-handle form'
  );
});

it('source: no ambient tdb() survives inside the helper', () => {
  assert.ok(!/\btdb\(\)/.test(REAL_SRC.replace(/h = tdb\(\)/, '')),
    'an ambient tdb() call remains in the body — it would ignore the handle');
});

it('source: POST /api/retail-admin/customers was NOT edited — it passes no handle', () => {
  // The unconverted caller, verbatim. Anchor deliberately spans the argument
  // object and stops at its close, so adding a handle here would fail this.
  const call = /const made = createOrReuseManualCustomer\(\{\s*nickname: b\.nickname, email: b\.email, phone: b\.phone, userId: req\.user\.id,\s*\}\);/;
  assert.ok(call.test(RETAIL), 'the unconverted caller changed shape or gained a handle');
});

it('source: there are still exactly two call sites', () => {
  const n = (RETAIL.match(/createOrReuseManualCustomer\(/g) || []).length - 1;   // less the definition
  assert.strictEqual(n, 2, `expected 2 call sites, found ${n}`);
});

// ── Footer ─────────────────────────────────────────────────────────────────
console.log('');
console.log(`  driver: ${driver}`);
if (MUTANT) {
  console.log(`  mutant: "${MUTATION_ANCHOR}" -> "tdb().prepare(" applied ${mutationCount} times`);
  console.log(`  mutant: ${fail} failed  (0 would mean the suite cannot detect an ignored handle)`);
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
