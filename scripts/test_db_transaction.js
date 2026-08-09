#!/usr/bin/env node
/**
 * Offline self-test for lib/db-transaction.js — the transaction helper that all
 * 56 money transactions will eventually run through (decisions §24, Path A
 * step 3). No network, no keys, no real DB: everything runs against an in-memory
 * SQLite from scripts/test-support/memory-db.js.
 *
 *   node scripts/test_db_transaction.js
 *
 * WHY THIS SUITE IS LARGER THAN THE FILE IT TESTS. The helper ships unused. Once
 * the conversion starts, every one of those 56 bodies inherits whatever this
 * does — including anything it does wrong, silently and everywhere at once. So
 * each behaviour is pinned here, while the cost of finding a fault is one file.
 *
 * WHICH DRIVER RAN IS PRINTED. The harness picks better-sqlite3 when its native
 * binding is built and node:sqlite when it is not, and the two have genuinely
 * different transaction surfaces — node:sqlite has no .transaction() and no
 * .inTransaction at all. A result is only meaningful against the engine that
 * produced it, so the run says which one it used.
 *
 * TO PROVE THE SUITE CAN FAIL:  TX_TEST_SABOTAGE=1 node scripts/test_db_transaction.js
 * That flips one expected value in the rollback test. It must go red. A green
 * run means nothing unless the red run is also demonstrated.
 */
'use strict';

const assert = require('assert');
const { openMemoryDb, driver } = require('./test-support/memory-db');
const { withTransaction, transactionDepth } = require('../lib/db-transaction');

const SABOTAGE = process.env.TX_TEST_SABOTAGE === '1';

let pass = 0, fail = 0;
async function it(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// ── Fixture: the smallest thing shaped like the money tables ──────────────
// One row whose balance must never be left half-written, which is the property
// every one of the 56 call sites actually cares about.
function freshDb() {
  const db = openMemoryDb();
  db.exec('CREATE TABLE ledger (id INTEGER PRIMARY KEY, note TEXT, amount INTEGER)');
  return db;
}
const notes = (db) => db.prepare('SELECT note FROM ledger ORDER BY id').all().map((r) => r.note);
const insert = (h, id, note, amount) =>
  h.prepare('INSERT INTO ledger (id, note, amount) VALUES (?, ?, ?)').run(id, note, amount);

(async () => {

console.log(`\ndb-transaction — driver: ${driver}${SABOTAGE ? '   [SABOTAGE ON]' : ''}\n`);

// ─────────────────────────────────────────────────────────────────────────
console.log('1. commit on success');

await it('a body that resolves leaves its writes committed', async () => {
  const db = freshDb();
  await withTransaction(db, async (tx) => {
    insert(tx, 1, 'first', 100);
    insert(tx, 2, 'second', 200);
  });
  assert.deepStrictEqual(notes(db), ['first', 'second']);
  assert.strictEqual(transactionDepth(db), 0, 'depth must return to 0 after commit');
});

await it('writes are durable to a later read outside the transaction', async () => {
  const db = freshDb();
  await withTransaction(db, async (tx) => insert(tx, 1, 'kept', 5));
  const row = db.prepare('SELECT amount FROM ledger WHERE id=1').get();
  assert.strictEqual(Number(row.amount), 5);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n2. rollback on throw — no partial state');

await it('a throw after a write leaves NO row behind', async () => {
  const db = freshDb();
  insert(db, 1, 'pre-existing', 1);        // committed before the transaction
  let caught = null;
  try {
    await withTransaction(db, async (tx) => {
      insert(tx, 2, 'partial-A', 10);
      insert(tx, 3, 'partial-B', 20);
      throw new Error('boom, after two writes');
    });
  } catch (e) { caught = e; }

  assert.ok(caught, 'the error must reach the caller');
  assert.strictEqual(caught.message, 'boom, after two writes');

  // THE PROOF: row state after the throw. Only the pre-existing row survives —
  // both writes made inside the transaction are gone.
  const after = notes(db);
  const expected = SABOTAGE ? ['pre-existing', 'partial-A'] : ['pre-existing'];
  assert.deepStrictEqual(after, expected,
    `rows after rollback were ${JSON.stringify(after)}`);
  assert.strictEqual(transactionDepth(db), 0, 'depth must return to 0 after rollback');
});

await it('a throw AFTER an await still rolls back (the db.transaction() defect)', async () => {
  // This is the exact case better-sqlite3's own wrapper gets wrong: it commits
  // the synchronous prefix at the first await and the later throw undoes
  // nothing. Measured on the box. The helper must not repeat it.
  const db = freshDb();
  try {
    await withTransaction(db, async (tx) => {
      insert(tx, 1, 'written-before-await', 1);
      await new Promise((r) => setTimeout(r, 5));
      throw new Error('late failure');
    });
  } catch { /* expected */ }
  assert.deepStrictEqual(notes(db), [], 'the pre-await write must NOT survive');
});

await it('the handle is usable again after a rollback', async () => {
  const db = freshDb();
  try { await withTransaction(db, async () => { throw new Error('x'); }); } catch { /* expected */ }
  await withTransaction(db, async (tx) => insert(tx, 1, 'after-rollback', 1));
  assert.deepStrictEqual(notes(db), ['after-rollback']);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n3. return values propagate (9 of the 56 bodies return one)');

await it('the body\'s return value is what the caller receives', async () => {
  const db = freshDb();
  const orderId = await withTransaction(db, async (tx) => {
    insert(tx, 1, 'order', 1);
    return 4471;                            // checkout returns orderId
  });
  assert.strictEqual(orderId, 4471);
});

await it('object and falsy return values survive intact', async () => {
  const db = freshDb();
  const obj = await withTransaction(db, async () => ({ orderId: 7, total: 1250 }));
  assert.deepStrictEqual(obj, { orderId: 7, total: 1250 });

  // 0 and null must come back as themselves, not be coerced or lost.
  assert.strictEqual(await withTransaction(db, async () => 0), 0);
  assert.strictEqual(await withTransaction(db, async () => null), null);
  assert.strictEqual(await withTransaction(db, async () => undefined), undefined);
});

await it('a synchronous body also returns its value', async () => {
  // Not every one of the 56 will be async on day one.
  const db = freshDb();
  const v = await withTransaction(db, (tx) => { insert(tx, 1, 'sync', 1); return 'sync-value'; });
  assert.strictEqual(v, 'sync-value');
  assert.deepStrictEqual(notes(db), ['sync']);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n4. typed errors reach the caller intact (the money cluster\'s 409s)');

await it('e.code and custom properties both survive the round trip', async () => {
  const db = freshDb();
  let caught = null;
  try {
    await withTransaction(db, async (tx) => {
      insert(tx, 1, 'reserved', 1);
      const err = new Error('insufficient stock');
      err.code = 'OUT_OF_STOCK';
      err.product_id = 8812;
      err.available = 3;
      throw err;
    });
  } catch (e) { caught = e; }

  assert.ok(caught, 'the typed error must reach the caller');
  assert.strictEqual(caught.code, 'OUT_OF_STOCK', 'e.code must survive');
  assert.strictEqual(caught.product_id, 8812, 'e.product_id must survive');
  assert.strictEqual(caught.available, 3, 'e.available must survive');
  assert.ok(caught instanceof Error, 'it must still be an Error');
  // AND the rollback still happened — both halves of requirement 4.
  assert.deepStrictEqual(notes(db), [], 'rollback must happen for typed errors too');
});

await it('the caller receives the SAME error object, not a copy', async () => {
  // A wrapper would break `err instanceof AppError` checks and any identity
  // comparison a route handler does. Identity is the strongest form of the
  // "properties preserved" requirement.
  const db = freshDb();
  const thrown = Object.assign(new Error('exact'), { code: 'E_EXACT' });
  let caught = null;
  try { await withTransaction(db, async () => { throw thrown; }); } catch (e) { caught = e; }
  assert.strictEqual(caught, thrown, 'must be the identical object reference');
});

await it('a custom Error SUBCLASS keeps its prototype', async () => {
  class InsufficientFunds extends Error {
    constructor(short) { super('insufficient funds'); this.code = 'NO_FUNDS'; this.short = short; }
  }
  const db = freshDb();
  let caught = null;
  try {
    await withTransaction(db, async () => { throw new InsufficientFunds(250); });
  } catch (e) { caught = e; }
  assert.ok(caught instanceof InsufficientFunds, 'subclass identity must survive');
  assert.strictEqual(caught.short, 250);
});

await it('a non-Error throw still rolls back and propagates', async () => {
  const db = freshDb();
  let caught = 'nothing';
  try {
    await withTransaction(db, async (tx) => { insert(tx, 1, 'x', 1); throw 'a bare string'; });
  } catch (e) { caught = e; }
  assert.strictEqual(caught, 'a bare string');
  assert.deepStrictEqual(notes(db), [], 'rollback must not depend on the throw being an Error');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n5. early return still COMMITS (23 bodies loop, 33 branch)');

await it('returning from inside a branch commits the writes so far', async () => {
  const db = freshDb();
  const out = await withTransaction(db, async (tx) => {
    insert(tx, 1, 'before-branch', 1);
    if (true) return 'early';               // eslint-disable-line no-constant-condition
    insert(tx, 2, 'never', 2);
  });
  assert.strictEqual(out, 'early');
  assert.deepStrictEqual(notes(db), ['before-branch'], 'the early-return path must COMMIT');
});

await it('returning from inside a loop commits the writes so far', async () => {
  const db = freshDb();
  const out = await withTransaction(db, async (tx) => {
    for (let i = 1; i <= 5; i++) {
      insert(tx, i, `row-${i}`, i);
      if (i === 3) return `stopped at ${i}`;  // break out mid-loop
    }
    return 'ran to completion';
  });
  assert.strictEqual(out, 'stopped at 3');
  assert.deepStrictEqual(notes(db), ['row-1', 'row-2', 'row-3']);
});

await it('an early return inside a NESTED body commits that savepoint', async () => {
  const db = freshDb();
  await withTransaction(db, async (tx) => {
    insert(tx, 1, 'outer', 1);
    const r = await withTransaction(tx, async (inner) => {
      insert(inner, 2, 'inner', 2);
      return 'inner-early';
    });
    assert.strictEqual(r, 'inner-early');
  });
  assert.deepStrictEqual(notes(db), ['outer', 'inner']);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n6. nesting — the two-sided savepoint proof');

await it('SIDE A: an inner transaction rolls back WITH a failing outer', async () => {
  const db = freshDb();
  try {
    await withTransaction(db, async (tx) => {
      insert(tx, 1, 'outer-write', 1);
      await withTransaction(tx, async (inner) => {
        insert(inner, 2, 'inner-write', 2);  // inner SUCCEEDS and releases
      });
      throw new Error('outer fails after the inner committed');
    });
  } catch { /* expected */ }
  // The inner block completed on its own terms, but it participated in the
  // outer — so the outer's rollback must take it with it.
  assert.deepStrictEqual(notes(db), [],
    'a released savepoint must still be undone by the outer ROLLBACK');
});

await it('SIDE B: the same inner transaction COMMITS when it stands alone', async () => {
  const db = freshDb();
  await withTransaction(db, async (inner) => {
    insert(inner, 2, 'inner-write', 2);      // identical body, no outer
  });
  assert.deepStrictEqual(notes(db), ['inner-write'],
    'unwrapped, the same block must commit');
});

await it('a failing inner rolls back WITHOUT killing a surviving outer', async () => {
  const db = freshDb();
  await withTransaction(db, async (tx) => {
    insert(tx, 1, 'outer-keeps', 1);
    try {
      await withTransaction(tx, async (inner) => {
        insert(inner, 2, 'inner-discarded', 2);
        throw new Error('inner only');
      });
    } catch { /* the outer chooses to continue */ }
    insert(tx, 3, 'outer-after', 3);
  });
  assert.deepStrictEqual(notes(db), ['outer-keeps', 'outer-after'],
    'only the inner block\'s write is discarded');
});

await it('three levels deep nest and unwind correctly', async () => {
  const db = freshDb();
  await withTransaction(db, async (a) => {
    insert(a, 1, 'L1', 1);
    await withTransaction(a, async (b) => {
      insert(b, 2, 'L2', 2);
      try {
        await withTransaction(b, async (c) => {
          insert(c, 3, 'L3-discarded', 3);
          throw new Error('level 3 fails');
        });
      } catch { /* swallowed at level 2 */ }
    });
  });
  assert.deepStrictEqual(notes(db), ['L1', 'L2']);
  assert.strictEqual(transactionDepth(db), 0, 'depth must unwind fully');
});

await it('depth is reported correctly at each level', async () => {
  const db = freshDb();
  assert.strictEqual(transactionDepth(db), 0);
  await withTransaction(db, async (a) => {
    assert.strictEqual(transactionDepth(a), 1, 'inside outermost');
    await withTransaction(a, async (b) => {
      assert.strictEqual(transactionDepth(b), 2, 'inside first savepoint');
    });
    assert.strictEqual(transactionDepth(a), 1, 'back to outermost after release');
  });
  assert.strictEqual(transactionDepth(db), 0);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n7. the given handle is used for every statement');

await it('the body receives the handle that was passed in', async () => {
  const db = freshDb();
  let seen = null;
  await withTransaction(db, async (tx) => { seen = tx; });
  assert.strictEqual(seen, db, 'tx must be the handle the caller supplied');
});

await it('every control statement goes through THAT handle, not a fresh one', async () => {
  // A recording proxy stands in for the handle. If the helper ever reached for
  // its own connection, the control statements would not appear here — and on
  // pg that is the difference between a transaction and four autocommits.
  const real = freshDb();
  const seenSql = [];
  const spy = new Proxy(real, {
    get(target, prop) {
      const v = target[prop];
      if (prop === 'exec') return (sql) => { seenSql.push(sql); return target.exec(sql); };
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });

  await withTransaction(spy, async (tx) => {
    assert.strictEqual(tx, spy, 'the body must be handed the spy, not the real handle');
    insert(tx, 1, 'through-spy', 1);
  });

  assert.ok(seenSql.includes('BEGIN'), `BEGIN must run on the given handle; saw ${JSON.stringify(seenSql)}`);
  assert.ok(seenSql.includes('COMMIT'), `COMMIT must run on the given handle; saw ${JSON.stringify(seenSql)}`);
  assert.deepStrictEqual(notes(real), ['through-spy']);
});

await it('a rollback\'s control statements also go through the given handle', async () => {
  const real = freshDb();
  const seenSql = [];
  const spy = new Proxy(real, {
    get(target, prop) {
      const v = target[prop];
      if (prop === 'exec') return (sql) => { seenSql.push(sql); return target.exec(sql); };
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  try { await withTransaction(spy, async () => { throw new Error('x'); }); } catch { /* expected */ }
  assert.ok(seenSql.includes('ROLLBACK'), `ROLLBACK must run on the given handle; saw ${JSON.stringify(seenSql)}`);
});

await it('nesting uses SAVEPOINT on the given handle, not a second BEGIN', async () => {
  const real = freshDb();
  const seenSql = [];
  const spy = new Proxy(real, {
    get(target, prop) {
      const v = target[prop];
      if (prop === 'exec') return (sql) => { seenSql.push(sql); return target.exec(sql); };
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  await withTransaction(spy, async (tx) => {
    await withTransaction(tx, async () => {});
  });
  const begins = seenSql.filter((s) => s === 'BEGIN').length;
  assert.strictEqual(begins, 1, `exactly one BEGIN, saw ${JSON.stringify(seenSql)}`);
  assert.ok(seenSql.some((s) => s.startsWith('SAVEPOINT ')), 'the inner block must use SAVEPOINT');
  assert.ok(seenSql.some((s) => s.startsWith('RELEASE SAVEPOINT ')), 'and must release it');
});

await it('two DIFFERENT handles keep independent depth', async () => {
  const a = freshDb(), b = freshDb();
  await withTransaction(a, async () => {
    assert.strictEqual(transactionDepth(a), 1);
    assert.strictEqual(transactionDepth(b), 0, 'a second handle must be unaffected');
  });
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n8. concurrent transactions on one handle do not interleave');
// NOT in the original requirement list. Added because a shared SQLite handle
// makes this reachable the moment a body awaits, and all 56 call sites would
// inherit it. See the acquire() comment in lib/db-transaction.js.

await it('a second transaction waits rather than joining the first', async () => {
  const db = freshDb();
  const order = [];
  const slow = withTransaction(db, async (tx) => {
    order.push('A:begin');
    insert(tx, 1, 'A', 1);
    await new Promise((r) => setTimeout(r, 20));   // yields the event loop
    order.push('A:end');
  });
  const fast = withTransaction(db, async (tx) => {
    order.push('B:begin');
    insert(tx, 2, 'B', 2);
    order.push('B:end');
  });
  await Promise.all([slow, fast]);
  assert.deepStrictEqual(order, ['A:begin', 'A:end', 'B:begin', 'B:end'],
    'B must not start until A has finished');
  assert.deepStrictEqual(notes(db), ['A', 'B']);
});

await it('a failed transaction does not stall the queue behind it', async () => {
  const db = freshDb();
  const failed = withTransaction(db, async () => { throw new Error('first fails'); }).catch(() => 'caught');
  const after = withTransaction(db, async (tx) => { insert(tx, 1, 'still-runs', 1); return 'ok'; });
  assert.strictEqual(await failed, 'caught');
  assert.strictEqual(await after, 'ok');
  assert.deepStrictEqual(notes(db), ['still-runs']);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n9. argument guards');

await it('a missing handle or body is refused clearly', async () => {
  await assert.rejects(() => withTransaction(null, async () => {}), /database handle is required/);
  await assert.rejects(() => withTransaction(freshDb(), 'not a function'), /body function is required/);
});

console.log(`\n${pass} passed, ${fail} failed   [driver: ${driver}]\n`);
process.exit(fail ? 1 : 0);

})();
