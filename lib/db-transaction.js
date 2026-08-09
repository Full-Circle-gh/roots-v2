// The transaction helper — STEP THREE of the async conversion (decisions §24).
//
// Every money transaction in the application will eventually run through this
// one function. That is the whole reason it lands on its own, unused, with a
// test suite larger than itself: if the semantics here are subtly wrong, all 56
// call sites inherit the fault silently and the fault is then impossible to
// isolate. Proving it while nothing depends on it is cheap. Proving it after is
// not possible.
//
// THIS FILE IS UNUSED TODAY, BY DESIGN. Nothing requires it. No transaction has
// been converted. Landing it separately is the point.
//
//
// WHY NOT better-sqlite3's db.transaction()
// -----------------------------------------
// Two independent reasons, both verified by execution rather than assumed:
//
//   1. IT CANNOT HOLD ASYNC WORK. Its wrapper is synchronous: it calls the
//      function and commits when that call RETURNS. An async function returns a
//      promise immediately, so the commit happens at the first await — the
//      synchronous prefix is committed and a later throw rolls back nothing.
//      Measured on the box against the real binding: a body that inserted a row,
//      awaited, then threw left the row committed and db.inTransaction false.
//      Since the conversion's entire purpose is to make these bodies async, the
//      wrapper is not merely unhelpful, it is actively unsafe here.
//
//   2. THE TEST HARNESS CANNOT RUN IT. scripts/test-support/memory-db.js falls
//      back to node:sqlite wherever the native binding is not built, and
//      DatabaseSync has no .transaction() at all (verified: undefined). Anything
//      built on it is untestable off the box.
//
// So this helper issues BEGIN / COMMIT / ROLLBACK as statements itself.
//
//
// THE SIGNATURE, AND WHY IT IS THIS ONE
// -------------------------------------
//     await withTransaction(db, async (tx) => { ...; return value; })
//
//   * IT TAKES THE HANDLE AS AN ARGUMENT. Exactly the rule §24 settled for the
//     six dual-context helpers at step 2, applied one level up. The caller
//     passes the handle it is using.
//
//   * IT IS ASYNC TODAY EVEN THOUGH SQLITE IS SYNCHRONOUS. pg is asynchronous.
//     If this returned a plain value now, all 56 call sites would have to change
//     shape at the cutover — which is the one thing the conversion is trying to
//     avoid. Written as `await` today, they are already in their final form.
//
//   * THE BODY RECEIVES THE HANDLE; IT MUST NOT CLOSE OVER THE OUTER ONE. This
//     is the load-bearing part of the signature and the reason `fn` takes an
//     argument at all. On SQLite `tx` is the same object that was passed in, so
//     it looks redundant. On pg it will NOT be: a transaction there lives on one
//     checked-out client, and the helper will hand that client in as `tx`. A
//     body that used the pool handle instead would run its statements on
//     arbitrary other connections — outside the transaction, unrolled back by
//     it, and green in every test that does not run concurrently. Bodies written
//     against `tx` today survive that change untouched.
//
//
// NESTING
// -------
// better-sqlite3 gives nesting away free by mapping inner transactions to
// SAVEPOINTs. pg has no such implicit behaviour, so this reproduces it
// explicitly: the outermost call issues BEGIN/COMMIT, and any call made against
// a handle already inside a transaction issues SAVEPOINT/RELEASE instead. An
// inner block therefore rolls back with a failing outer, and commits on its own
// when nobody wrapped it.
//
// The savepoint statements use the verbose forms — ROLLBACK TO SAVEPOINT x,
// RELEASE SAVEPOINT x — because pg requires them and SQLite accepts them
// (verified on node:sqlite). One string set for both backends.
//
// DEPTH IS TRACKED HERE, NOT READ FROM THE DRIVER. better-sqlite3 exposes
// db.inTransaction; node:sqlite does not (verified: undefined) and neither does
// a pg client. Relying on it would work on exactly one of the three backends, so
// nesting depth is kept in a WeakMap keyed by the handle. Keyed by handle, not
// global, so two pg clients running concurrently never see each other's depth.
//
//
// WHAT THIS DOES NOT COVER — STATED SO IT IS NOT ASSUMED
// ------------------------------------------------------
//   * BEGIN IMMEDIATE. The checkout path uses better-sqlite3's .immediate() to
//     take the write lock up front. That is a SQLite-specific concurrency
//     control with no pg equivalent, it is a separate design problem, and it is
//     deliberately NOT implemented here. Checkout cannot be converted using this
//     helper as it stands.
//
//   * THE pg BACKEND ITSELF. The control-statement dispatch below already
//     recognises a pg-style handle, and the signature is chosen to survive the
//     cutover, but the pool checkout that makes `tx` a distinct client is NOT
//     written and NOT tested. This helper is proven on SQLite only.
//
'use strict';

// Per-handle transaction state. WeakMap so a handle that goes away takes its
// entry with it, and so nothing is shared between two different handles.
//   depth — 0 outside a transaction, 1 inside BEGIN, 2+ inside savepoints.
//   tail  — the serialisation queue described at acquire() below.
const STATE = new WeakMap();

function stateFor(handle) {
  let s = STATE.get(handle);
  if (!s) {
    s = { depth: 0, tail: Promise.resolve() };
    STATE.set(handle, s);
  }
  return s;
}

/**
 * Run one transaction-control statement on the given handle.
 *
 * Dispatches on the handle's own shape rather than on a configured backend
 * name: both SQLite drivers expose exec(), a pg client exposes query(). Awaiting
 * a non-promise is harmless, so the synchronous drivers cost nothing here.
 */
async function control(handle, sql) {
  if (typeof handle.exec === 'function') {
    handle.exec(sql);                      // better-sqlite3 and node:sqlite
    return;
  }
  if (typeof handle.query === 'function') {
    await handle.query(sql);               // pg — see the caveat in the header
    return;
  }
  throw new TypeError(
    '[withTransaction] the handle exposes neither exec() nor query(); ' +
    'it is not a database handle this helper knows how to drive.'
  );
}

/**
 * Attach a failed rollback to the original error without replacing it.
 *
 * The money cluster's errors carry e.code and properties like e.product_id /
 * e.available, and route handlers read them to build 409s. So the error the
 * caller receives must be the ORIGINAL OBJECT, not a wrapper — a wrapper would
 * turn every one of those 409s into a 500. If the rollback itself also fails,
 * that is recorded as a non-enumerable property so it is available for
 * diagnosis without altering how the error serialises.
 */
function noteRollbackFailure(err, rollbackErr) {
  if (!err || typeof err !== 'object') return;
  try {
    Object.defineProperty(err, 'rollbackError', {
      value: rollbackErr, enumerable: false, writable: true, configurable: true,
    });
  } catch { /* frozen error object — diagnosis only, never worth throwing over */ }
}

/** The outermost transaction: BEGIN / COMMIT / ROLLBACK. */
async function runOutermost(db, fn, st) {
  await control(db, 'BEGIN');
  st.depth = 1;
  let result;
  try {
    result = await fn(db);
  } catch (err) {
    try {
      await control(db, 'ROLLBACK');
    } catch (rollbackErr) {
      noteRollbackFailure(err, rollbackErr);
    }
    throw err;                             // the original object, untouched
  } finally {
    st.depth = 0;
  }
  // Reached only when the body resolved — including via an early return, which
  // is an ordinary resolution and so must commit like any other.
  await control(db, 'COMMIT');
  return result;
}

/** A nested transaction: SAVEPOINT / RELEASE / ROLLBACK TO. */
async function runNested(db, fn, st) {
  // Named by the depth it opens at, so sibling and re-entered blocks cannot
  // collide: only one savepoint can be live at any given depth.
  const name = `tacet_sp_${st.depth}`;
  await control(db, `SAVEPOINT ${name}`);
  st.depth += 1;
  let result;
  try {
    result = await fn(db);
  } catch (err) {
    try {
      // Both statements: ROLLBACK TO rewinds but LEAVES the savepoint on the
      // stack, so without the RELEASE the nesting level would never close.
      await control(db, `ROLLBACK TO SAVEPOINT ${name}`);
      await control(db, `RELEASE SAVEPOINT ${name}`);
    } catch (rollbackErr) {
      noteRollbackFailure(err, rollbackErr);
    }
    throw err;
  } finally {
    st.depth -= 1;
  }
  await control(db, `RELEASE SAVEPOINT ${name}`);
  return result;
}

/**
 * Serialise outermost transactions on one handle.
 *
 * NOT in the original brief; added because the suite demonstrates the failure it
 * prevents, and because all 56 call sites would inherit that failure.
 *
 * A SQLite transaction belongs to a CONNECTION, and the application shares one
 * handle. The moment a body contains a real await, the event loop is free to run
 * another request's handler — and if that handler starts its own transaction on
 * the same handle, the two interleave: the second BEGIN errors, or worse, one
 * block's ROLLBACK discards the other's writes. Single-threaded JavaScript does
 * not protect against this; await is exactly where it breaks.
 *
 * So an outermost transaction waits for the previous one on that handle to
 * finish. Nested calls DO NOT wait — they are already inside the holder's turn,
 * and queueing them behind it would deadlock instantly.
 *
 * This is a no-op cost under pg, where each transaction gets its own client and
 * there is nothing to contend for.
 */
function acquire(st, run) {
  const queued = st.tail.then(run, run);
  // The queue must not stall on a failed transaction, and must not surface an
  // unhandled rejection from a link nobody else awaits.
  st.tail = queued.then(() => {}, () => {});
  return queued;
}

/**
 * Run `fn` inside a database transaction on `db`, and return what it returns.
 *
 * @param {object} db  the handle every statement inside will use
 * @param {(tx: object) => any} fn  the body; receives the handle to use
 * @returns {Promise<any>} whatever `fn` returned
 *
 * Commits when `fn` resolves, rolls back when it rejects, and rethrows the
 * original error object with its properties intact. Nests via savepoints.
 */
async function withTransaction(db, fn) {
  if (!db || typeof db !== 'object') {
    throw new TypeError('[withTransaction] a database handle is required as the first argument.');
  }
  if (typeof fn !== 'function') {
    throw new TypeError('[withTransaction] a transaction body function is required as the second argument.');
  }
  const st = stateFor(db);
  // Already inside a transaction on THIS handle — participate in it.
  if (st.depth > 0) return runNested(db, fn, st);
  return acquire(st, () => runOutermost(db, fn, st));
}

module.exports = {
  withTransaction,
  /** Depth on a handle: 0 outside a transaction. For tests and diagnostics. */
  transactionDepth: (db) => (STATE.get(db) || { depth: 0 }).depth,
};
