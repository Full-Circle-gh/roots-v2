#!/usr/bin/env node
/**
 * lib/db-transaction.js — outermost vs nested, shaped like real requests.
 *
 *   node scripts/test_db_transaction_nesting.js
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM scripts/test_db_transaction.js.
 * That suite's section 8 already claims "concurrent transactions on one handle
 * do not interleave", and it passes. It passes because it calls withTransaction
 * TWICE IN ONE SYNCHRONOUS BLOCK, where neither call has started its body yet
 * and both are correctly seen as outermost. Real HTTP requests do not arrive
 * that way: the second one arrives in a LATER macrotask, while the first one's
 * body is suspended on an await. That is the shape this file tests, and it is
 * the shape the helper got wrong.
 *
 * THE DEFECT, as measured before any fix was written:
 *
 *   withTransaction sets depth = 1 on PER-HANDLE state BEFORE awaiting the body.
 *   Any outermost call arriving while that body is suspended reads depth > 0 and
 *   takes the nested SAVEPOINT path. Two independent requests produce ONE BEGIN,
 *   and the second is given a savepoint inside the first:
 *
 *       A sees depth=0        BEGIN
 *       A body in             SAVEPOINT tacet_sp_1
 *       B sees depth=1        COMMIT                 <- fires while B is running
 *       B body in             RELEASE SAVEPOINT tacet_sp_1
 *       A body out
 *       B body out
 *
 *   Two data-corrupting outcomes follow, both reproduced below on a real handle:
 *     - B succeeds and A rolls back  -> B's write is DESTROYED, and B is handed
 *       "no such savepoint: tacet_sp_1" instead of success.
 *     - A succeeds and B fails       -> B's rolled-back write is COMMITTED by
 *       A's COMMIT.
 *
 *   In checkout terms: an order vanishing because an unrelated customer's
 *   checkout failed, and a 409 insufficient_stock that leaves its order and its
 *   stock reservation committed anyway — an oversell produced by the code that
 *   exists to prevent one.
 *
 * WHY IT HAS BEEN DORMANT. Every converted body in batches 1-4 is fully
 * synchronous, so a transaction completes inside one microtask drain and no
 * second request can arrive mid-flight. Batch 2's "no await in a converted body"
 * assertion — a TEST, not the helper — is what has been holding it back. It
 * stays in place after this fix; it costs nothing and it is a second line.
 *
 * THE ORDER OF WORK WAS: this file first, red against the unfixed helper, then
 * the fix. A green run of this file means nothing without the red one, which is
 * why section 6 guards the specific mistake rather than only the symptom.
 *
 * TO PROVE THE SUITE CAN FAIL:  TX_NEST_SABOTAGE=1 node scripts/test_db_transaction_nesting.js
 */
'use strict';

const assert = require('assert');
const { openMemoryDb, driver } = require('./test-support/memory-db');
const { withTransaction, transactionDepth } = require('../lib/db-transaction');

const SABOTAGE = process.env.TX_NEST_SABOTAGE === '1';

let pass = 0, fail = 0;
async function it(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

function freshDb() {
  const db = openMemoryDb();
  db.exec('CREATE TABLE ledger (id INTEGER PRIMARY KEY, note TEXT)');
  return db;
}
const notes = (db) => db.prepare('SELECT note FROM ledger ORDER BY id').all().map((r) => r.note);
const insert = (h, note) => h.prepare('INSERT INTO ledger (note) VALUES (?)').run(note);

/**
 * Two independent "requests" on one handle.
 *
 * THIS HELPER IS THE POINT OF THE FILE. Each body is started from its OWN
 * setImmediate, so the second call is made from a later macrotask, from an async
 * context that knows nothing about the first — exactly how Express dispatches
 * two overlapping requests off two socket reads. `yieldOnce` inside a body
 * suspends it for a full macrotask turn, so the other request is guaranteed to
 * arrive while it is in flight.
 */
const yieldOnce = () => new Promise((r) => setImmediate(r));

function twoRequests(bodyA, bodyB) {
  const outcome = { a: null, b: null };
  return new Promise((done) => {
    let n = 0;
    const fin = () => { if (++n === 2) done(outcome); };
    setImmediate(async () => {
      try { outcome.a = { ok: true, value: await bodyA() }; }
      catch (e) { outcome.a = { ok: false, error: e }; }
      fin();
    });
    setImmediate(async () => {
      try { outcome.b = { ok: true, value: await bodyB() }; }
      catch (e) { outcome.b = { ok: false, error: e }; }
      fin();
    });
  });
}

/** A handle that records the transaction-control SQL it is asked to run. */
function recordingDb() {
  const db = freshDb();
  const sql = [];
  const realExec = db.exec.bind(db);
  db.exec = (s) => { sql.push(s); return realExec(s); };
  return { db, sql };
}

(async () => {

console.log(`\ndb-transaction — outermost vs nested, request-shaped (driver: ${driver})`);
if (SABOTAGE) console.log('  *** TX_NEST_SABOTAGE=1 — expected values flipped, this run MUST fail 5 ***');
console.log('');

// ─────────────────────────────────────────────────────────────────────────
console.log('1. two independent requests are TWO transactions, not one');

await it('a request arriving mid-await gets its own BEGIN, never a SAVEPOINT', async () => {
  const { db, sql } = recordingDb();
  await twoRequests(
    () => withTransaction(db, async (tx) => { insert(tx, 'A'); await yieldOnce(); }),
    () => withTransaction(db, async (tx) => { insert(tx, 'B'); await yieldOnce(); })
  );
  const begins = sql.filter((s) => s === 'BEGIN').length;
  const savepoints = sql.filter((s) => /^SAVEPOINT /.test(s)).length;
  assert.strictEqual(begins, SABOTAGE ? 99 : 2,
    `two independent requests must produce two BEGINs, saw ${begins} — SQL: ${sql.join(' | ')}`);
  assert.strictEqual(savepoints, 0,
    `an independent request must never be given a savepoint, saw ${savepoints}`);
});

await it('and the COMMIT of one never lands inside the other', async () => {
  const { db, sql } = recordingDb();
  await twoRequests(
    () => withTransaction(db, async (tx) => { insert(tx, 'A'); await yieldOnce(); }),
    () => withTransaction(db, async (tx) => { insert(tx, 'B'); await yieldOnce(); })
  );
  // BEGIN/COMMIT must alternate strictly. Interleaved control statements are
  // the signature of two transactions sharing one.
  assert.deepStrictEqual(sql, ['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
  assert.deepStrictEqual(notes(db), ['A', 'B']);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n2. FAILURE MODE ONE — an unrelated rollback must not destroy a good write');

await it('B commits even though A, arriving first, rolls back', async () => {
  const db = freshDb();
  const r = await twoRequests(
    () => withTransaction(db, async (tx) => {
      insert(tx, 'A'); await yieldOnce(); throw new Error('A fails');
    }),
    () => withTransaction(db, async (tx) => {
      insert(tx, 'B'); await yieldOnce();          // B does everything right
    })
  );
  assert.strictEqual(r.a.ok, false, 'A was supposed to fail');
  assert.strictEqual(r.b.ok, true,
    `B did nothing wrong and must not fail — it got: ${r.b.error && r.b.error.message}`);
  assert.deepStrictEqual(notes(db), SABOTAGE ? [] : ['B'],
    'B’s write must survive A’s rollback');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n3. FAILURE MODE TWO — a rolled-back write must not be committed by someone else');

await it('B\'s write is gone after B fails, even though A commits', async () => {
  const db = freshDb();
  const r = await twoRequests(
    () => withTransaction(db, async (tx) => {
      insert(tx, 'A'); await yieldOnce();          // A does everything right
    }),
    () => withTransaction(db, async (tx) => {
      insert(tx, 'B'); await yieldOnce(); throw new Error('B fails');
    })
  );
  assert.strictEqual(r.a.ok, true, 'A was supposed to succeed');
  assert.strictEqual(r.b.ok, false, 'B was supposed to fail');
  assert.deepStrictEqual(notes(db), SABOTAGE ? ['A', 'B'] : ['A'],
    'B rolled back — its row must NOT have been committed by A');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n4. the serialiser stays load-bearing — it must still queue');

await it('a request arriving mid-await WAITS; it does not run alongside', async () => {
  const db = freshDb();
  const order = [];
  await twoRequests(
    () => withTransaction(db, async (tx) => {
      order.push('A:in'); insert(tx, 'A'); await yieldOnce(); order.push('A:out');
    }),
    () => withTransaction(db, async (tx) => {
      order.push('B:in'); insert(tx, 'B'); await yieldOnce(); order.push('B:out');
    })
  );
  assert.deepStrictEqual(order, SABOTAGE ? [] : ['A:in', 'A:out', 'B:in', 'B:out'],
    'B must not enter its body until A has committed');
});

await it('a failed transaction still does not stall the queue behind it', async () => {
  const db = freshDb();
  const r = await twoRequests(
    () => withTransaction(db, async () => { await yieldOnce(); throw new Error('first fails'); }),
    () => withTransaction(db, async (tx) => { await yieldOnce(); insert(tx, 'after'); return 'ok'; })
  );
  assert.strictEqual(r.a.ok, false);
  assert.strictEqual(r.b.value, 'ok');
  assert.deepStrictEqual(notes(db), ['after']);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n5. GENUINE nesting still takes a savepoint');
// The fix must not buy correctness for independent callers by breaking real
// nesting — a helper called from inside a transaction body must still join it.

await it('a call made from INSIDE a body is nested, on the same handle', async () => {
  const { db, sql } = recordingDb();
  await withTransaction(db, async (tx) => {
    insert(tx, 'outer');
    await withTransaction(tx, async (inner) => { insert(inner, 'inner'); await yieldOnce(); });
  });
  assert.strictEqual(sql.filter((s) => s === 'BEGIN').length, 1, 'one real transaction');
  assert.ok(sql.some((s) => /^SAVEPOINT /.test(s)), 'the inner call must take a savepoint');
  assert.deepStrictEqual(notes(db), ['outer', 'inner']);
});

await it('a nested body that throws rolls back to its savepoint, outer survives', async () => {
  const db = freshDb();
  await withTransaction(db, async (tx) => {
    insert(tx, 'kept');
    try {
      await withTransaction(tx, async (inner) => {
        insert(inner, 'discarded'); await yieldOnce(); throw new Error('inner fails');
      });
    } catch { /* swallowed by the outer body on purpose */ }
  });
  assert.deepStrictEqual(notes(db), ['kept']);
});

await it('a nested call on a DIFFERENT handle is its own outermost transaction', async () => {
  const { db: a, sql: sqlA } = recordingDb();
  const { db: b, sql: sqlB } = recordingDb();
  await withTransaction(a, async (txA) => {
    insert(txA, 'on-a');
    await withTransaction(b, async (txB) => { insert(txB, 'on-b'); await yieldOnce(); });
  });
  assert.strictEqual(sqlA.filter((s) => s === 'BEGIN').length, 1);
  assert.strictEqual(sqlB.filter((s) => s === 'BEGIN').length, 1, 'handle b gets its own BEGIN');
  assert.strictEqual(sqlB.filter((s) => /^SAVEPOINT /.test(s)).length, 0);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n6. THE SPECIFIC MISTAKE — nesting state must not be readable by the next arrival');
// Not the symptom, the cause. The defect was a depth flag on PER-HANDLE state,
// assigned before the body was awaited, which any later caller could read. These
// assert that no such flag is observable, so the mistake cannot be reintroduced
// by a refactor that happens to keep the symptoms fixed.

await it('an unrelated async context sees depth 0 while a body is mid-await', async () => {
  const db = freshDb();
  let sampled = null;
  await new Promise((done) => {
    // Scheduled from OUT HERE, before the transaction opens, so this callback
    // does not inherit the transaction's async context — same as a socket read.
    setTimeout(() => { sampled = transactionDepth(db); }, 5);
    setImmediate(async () => {
      await withTransaction(db, async (tx) => {
        insert(tx, 'in-flight');
        await new Promise((r) => setTimeout(r, 25));   // still open when the sample fires
      });
      done();
    });
  });
  assert.strictEqual(sampled, SABOTAGE ? 1 : 0,
    'a caller outside the transaction must not see it as "in a transaction"');
});

await it('depth is still reported correctly from INSIDE, at every level', async () => {
  const db = freshDb();
  assert.strictEqual(transactionDepth(db), 0);
  await withTransaction(db, async (a) => {
    assert.strictEqual(transactionDepth(a), 1, 'inside outermost');
    await withTransaction(a, async (b) => {
      assert.strictEqual(transactionDepth(b), 2, 'inside first savepoint');
      await yieldOnce();
      assert.strictEqual(transactionDepth(b), 2, 'and still 2 after an await');
    });
    assert.strictEqual(transactionDepth(a), 1, 'back to outermost after release');
  });
  assert.strictEqual(transactionDepth(db), 0);
});

await it('the module keeps no per-handle nesting flag for a later caller to misread', () => {
  // Structural, not behavioural: whatever state the helper keeps per handle, none
  // of it may say "a transaction is open" in a way an unrelated caller can read.
  // If this ever fails, the depth flag has come back under a different name.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'db-transaction.js'), 'utf8');
  assert.ok(!/\bst\.depth\s*=/.test(src),
    'per-handle depth assignment is back — that is the exact defect this file exists for');
  assert.ok(/AsyncLocalStorage/.test(src),
    'nesting must be tracked per in-flight transaction, not on the handle');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n7. many concurrent requests, one handle');

await it('eight overlapping requests produce eight transactions and eight rows', async () => {
  const { db, sql } = recordingDb();
  const errors = [];
  await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((done) => {
    setImmediate(async () => {
      // Collected rather than thrown: against the unfixed helper these reject
      // with "no such savepoint", and an escaping rejection would abort the run
      // before the other assertions had a chance to report.
      try { await withTransaction(db, async (tx) => { insert(tx, 'r' + i); await yieldOnce(); }); }
      catch (e) { errors.push(e.message); }
      done();
    });
  })));
  assert.deepStrictEqual(errors, [], `no request should have errored: ${errors.join(' | ')}`);
  assert.strictEqual(sql.filter((s) => s === 'BEGIN').length, 8);
  assert.strictEqual(sql.filter((s) => /^SAVEPOINT /.test(s)).length, 0);
  assert.strictEqual(notes(db).length, 8);
});

await it('one failure among eight loses exactly one row', async () => {
  const db = freshDb();
  await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((done) => {
    setImmediate(async () => {
      try {
        await withTransaction(db, async (tx) => {
          insert(tx, 'r' + i);
          await yieldOnce();
          if (i === 3) throw new Error('r3 fails');
        });
      } catch { /* expected for i === 3 */ }
      done();
    });
  })));
  const got = notes(db).sort();
  assert.strictEqual(got.length, 7, `expected 7 survivors, got ${got.length}: ${got.join(',')}`);
  assert.ok(!got.includes('r3'), 'the failed one must be absent');
});

console.log('');
if (SABOTAGE) {
  console.log(`  sabotage: ${fail} of the 5 headline assertions failed`);
  console.log('  (one per proven claim: two BEGINs, failure mode one, failure mode two,');
  console.log('   the queue still queues, and the depth flag is not observable)');
}
console.log(`\n  ${pass} passed, ${fail} failed   [driver: ${driver}]\n`);
process.exitCode = fail === 0 ? 0 : 1;

})().catch((e) => { console.error(e); process.exitCode = 1; });
