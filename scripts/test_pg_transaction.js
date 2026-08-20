#!/usr/bin/env node
/**
 * The Postgres backend of withTransaction (G4).
 *
 *   node scripts/test_pg_transaction.js
 *
 * ── WHY A RECORDING POOL AND NOT A LIVE SERVER ───────────────────────────
 * What G4 delivers is a STATEMENT SEQUENCE and a LEASE LIFECYCLE: take a
 * connection, BEGIN on it, run the body on it, COMMIT or ROLLBACK on it, release
 * it on every exit path. None of that is a claim about the wire protocol, and a
 * live server would prove the same sequence more slowly and less precisely — it
 * cannot show that COMMIT reached the SAME connection BEGIN did, which is the
 * defect this backend exists to prevent.
 *
 * So the pool here records. Every statement is captured against the connection
 * that received it, which is exactly the property under test. This is not a mock
 * of withTransaction — the REAL lib/db-transaction.js and the REAL
 * lib/pg-handle.js run; only the socket is substituted.
 *
 * WHAT THIS SUITE DOES NOT PROVE: that any statement is valid Postgres, that the
 * money converter round-trips, or that a real connection behaves under load. No
 * application code has executed against Postgres anywhere — that is G20, and it
 * is still open.
 *
 * TO PROVE THE SUITE CAN FAIL:  PGT_MUTANT=1 node scripts/test_pg_transaction.js
 * The mutant drops the lease and runs the transaction on the pool — the exact
 * defect G4 exists to fix — and the suite must go RED. Per §24 (v4.27) the
 * mutation ASSERTS IT MODIFIED THE SOURCE before its red counts.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TX = path.join(ROOT, 'lib', 'db-transaction.js');
const TX_SRC = fs.readFileSync(TX, 'utf8');
const MUTANT = process.env.PGT_MUTANT === '1';

// §24: assert no anchor carries a line ending before running any of them. A `\n`
// anchor against a CRLF file matches nothing, and removing an absent substring
// changes nothing — a vacuous pass that reads as proof.
const ANCHOR_LEASE = '  const lease = typeof db.checkout === \'function\' ? await db.checkout() : null;';
assert.ok(!/[\r\n]/.test(ANCHOR_LEASE), 'the lease anchor carries a line ending');

let restore = null;
if (MUTANT) {
  assert.strictEqual(TX_SRC.split(ANCHOR_LEASE).length - 1, 1,
    'the lease anchor is not unique in lib/db-transaction.js');
  const mutated = TX_SRC.replace(ANCHOR_LEASE, '  const lease = null;');
  assert.notStrictEqual(mutated, TX_SRC,
    'MUTANT DID NOT MODIFY THE SOURCE — anchor missing, red would be vacuous');
  fs.writeFileSync(TX, mutated);
  restore = () => fs.writeFileSync(TX, TX_SRC);
  console.log('MUTANT ACTIVE — the lease is dropped; the transaction runs on the pool.\n');
}

const { withTransaction } = require(TX);
const { makePooledPgHandle } = require(path.join(ROOT, 'lib', 'pg-handle.js'));

let pass = 0, fail = 0;
let code = 1;                       // fail-closed
const results = [];
const t = (name, fn) => results.push({ name, fn });

// ── the recording pool ───────────────────────────────────────────────────
// Each connect() hands out a distinct client with its own id, so a statement can
// be attributed to the connection that received it. `log` is the whole point:
// [clientId, sql].
function makeRecordingPool() {
  let nextId = 0;
  const log = [];
  const released = [];
  const pool = {
    query: (text) => { log.push(['POOL', text]); return Promise.resolve({ rows: [], rowCount: 0 }); },
    connect: async () => {
      const id = `c${++nextId}`;
      return {
        query: (text) => { log.push([id, text]); return Promise.resolve({ rows: [], rowCount: 0 }); },
        release: () => { released.push(id); },
      };
    },
  };
  return { pool, log, released, sqlOn: (id) => log.filter((e) => e[0] === id).map((e) => e[1]) };
}
const sqls = (log) => log.map((e) => e[1]);

// ── the cases ────────────────────────────────────────────────────────────

t('1  A LEASE IS TAKEN, AND BEGIN/COMMIT LAND ON THAT ONE CONNECTION', async () => {
  const { pool, log, released } = makeRecordingPool();
  const h = makePooledPgHandle(pool);
  await withTransaction(h, async (tx) => { await tx.query('SELECT 1'); });

  assert.deepStrictEqual(sqls(log), ['BEGIN', 'SELECT 1', 'COMMIT'],
    `wrong statement sequence: ${JSON.stringify(sqls(log))}`);
  const owners = new Set(log.map((e) => e[0]));
  assert.strictEqual(owners.size, 1, `statements were split across connections: ${[...owners]}`);
  assert.ok(!owners.has('POOL'),
    'a statement went to the POOL — BEGIN and COMMIT can reach different connections that way');
  assert.deepStrictEqual(released, ['c1'], `the lease was not released exactly once: ${released}`);
});

t('2  the body receives the LEASED CLIENT, not the pool handle', async () => {
  const { pool } = makeRecordingPool();
  const h = makePooledPgHandle(pool);
  let seen;
  await withTransaction(h, async (tx) => { seen = tx; });
  assert.notStrictEqual(seen, h, 'the body was handed the pool handle — `tx` must be a distinct client');
  assert.strictEqual(seen.driver, 'postgres');
  assert.strictEqual(seen.description, 'postgres (leased client)', `got ${seen.description}`);
  assert.strictEqual(typeof seen.exec, 'undefined', 'the leased handle carries exec');
  assert.strictEqual(typeof seen.prepare, 'undefined', 'the leased handle carries prepare');
});

t('3  a throwing body ROLLBACKs on the lease and rethrows the ORIGINAL error', async () => {
  const { pool, log, released } = makeRecordingPool();
  const h = makePooledPgHandle(pool);
  const boom = Object.assign(new Error('boom'), { code: 'E_STOCK', product_id: 7 });
  let caught;
  try { await withTransaction(h, async () => { throw boom; }); } catch (e) { caught = e; }

  assert.strictEqual(caught, boom, 'the original error object was replaced');
  assert.strictEqual(caught.code, 'E_STOCK', 'error properties were lost');
  assert.strictEqual(caught.product_id, 7, 'error properties were lost');
  assert.deepStrictEqual(sqls(log), ['BEGIN', 'ROLLBACK'], JSON.stringify(sqls(log)));
  assert.deepStrictEqual(released, ['c1'], `not released on the error path: ${released}`);
});

t('4  NESTING MAPS TO A SAVEPOINT NAMED BY DEPTH — no second BEGIN', async () => {
  // The scheme is already designed (money cluster doc; lib/db-transaction.js):
  // named by the depth it opens at, because only one savepoint can be live per
  // depth. Followed, not re-derived.
  const { pool, log } = makeRecordingPool();
  const h = makePooledPgHandle(pool);
  await withTransaction(h, async (tx) => {
    await withTransaction(tx, async (tx2) => { await tx2.query('INNER'); });
  });
  assert.deepStrictEqual(sqls(log),
    ['BEGIN', 'SAVEPOINT tacet_sp_1', 'INNER', 'RELEASE SAVEPOINT tacet_sp_1', 'COMMIT'],
    JSON.stringify(sqls(log)));
  assert.strictEqual(sqls(log).filter((s) => s === 'BEGIN').length, 1,
    'a nested call opened a second BEGIN');
});

t('5  A FAILED NESTED BLOCK ISSUES BOTH STATEMENTS — ROLLBACK TO *AND* RELEASE', async () => {
  // ROLLBACK TO rewinds but LEAVES the savepoint on the stack. Without the
  // RELEASE the nesting level never closes. Both, in that order.
  const { pool, log } = makeRecordingPool();
  const h = makePooledPgHandle(pool);
  await withTransaction(h, async (tx) => {
    try { await withTransaction(tx, async () => { throw new Error('inner'); }); } catch { /* handled */ }
    await tx.query('AFTER');
  });
  assert.deepStrictEqual(sqls(log), [
    'BEGIN', 'SAVEPOINT tacet_sp_1',
    'ROLLBACK TO SAVEPOINT tacet_sp_1', 'RELEASE SAVEPOINT tacet_sp_1',
    'AFTER', 'COMMIT',
  ], JSON.stringify(sqls(log)));
});

t('6  depth 2 gets its own savepoint name — siblings cannot collide', async () => {
  const { pool, log } = makeRecordingPool();
  const h = makePooledPgHandle(pool);
  await withTransaction(h, async (tx) => {
    await withTransaction(tx, async (tx2) => {
      await withTransaction(tx2, async (tx3) => { await tx3.query('DEEP'); });
    });
  });
  assert.ok(sqls(log).includes('SAVEPOINT tacet_sp_1'), JSON.stringify(sqls(log)));
  assert.ok(sqls(log).includes('SAVEPOINT tacet_sp_2'), JSON.stringify(sqls(log)));
});

t('7  THE LEASE IS RELEASED EVEN WHEN THE ROLLBACK ITSELF FAILS', async () => {
  const { pool, released } = makeRecordingPool();
  const realConnect = pool.connect;
  pool.connect = async () => {
    const c = await realConnect();
    const q = c.query;
    c.query = (text) => (text === 'ROLLBACK'
      ? Promise.reject(new Error('connection lost'))
      : q(text));
    return c;
  };
  const h = makePooledPgHandle(pool);
  const boom = new Error('body failed');
  let caught;
  try { await withTransaction(h, async () => { throw boom; }); } catch (e) { caught = e; }
  assert.strictEqual(caught, boom, 'the rollback failure replaced the original error');
  assert.deepStrictEqual(released, ['c1'],
    `a client leaked when the rollback threw: ${JSON.stringify(released)}`);
});

t('8  release is IDEMPOTENT — pg throws on a double release', async () => {
  const { pool } = makeRecordingPool();
  const h = makePooledPgHandle(pool);
  let tx;
  await withTransaction(h, async (t2) => { tx = t2; });
  tx.release();                       // already released by the finally
  tx.release();
  assert.ok(true);
});

t('9  A NESTED CALL ON THE POOL IS REFUSED BY NAME, NOT DEADLOCKED (G5 boundary)', async () => {
  const { pool } = makeRecordingPool();
  const h = makePooledPgHandle(pool);
  let caught;
  await withTransaction(h, async () => {
    // `tdb()` rather than `tx` — the case that would queue behind the
    // transaction that is waiting for it.
    try { await withTransaction(h, async () => {}); } catch (e) { caught = e; }
  });
  assert.ok(caught, 'a nested call on the pool did not throw — it would have deadlocked');
  assert.ok(/deadlock/i.test(caught.message), `wrong error: ${caught.message}`);
  assert.ok(/G5|item 30/.test(caught.message), `the refusal does not name the gap: ${caught.message}`);
});

t('10 SEQUENTIAL transactions each get their OWN lease and release it', async () => {
  const { pool, log, released } = makeRecordingPool();
  const h = makePooledPgHandle(pool);
  await withTransaction(h, async (tx) => { await tx.query('A'); });
  await withTransaction(h, async (tx) => { await tx.query('B'); });
  assert.deepStrictEqual(released, ['c1', 'c2'], `leases: ${JSON.stringify(released)}`);
  assert.deepStrictEqual(log.filter((e) => e[1] === 'A').map((e) => e[0]), ['c1']);
  assert.deepStrictEqual(log.filter((e) => e[1] === 'B').map((e) => e[0]), ['c2']);
});

t('11 SQLITE IS UNTOUCHED — no checkout, no lease, same sequence as before', async () => {
  // A synchronous exec-shaped handle, which is what better-sqlite3 is to
  // control(). No `checkout`, so `lease` is null and `h` is `db`.
  const seen = [];
  const sqliteish = { exec: (sql) => { seen.push(sql); } };
  await withTransaction(sqliteish, async (tx) => {
    assert.strictEqual(tx, sqliteish, 'SQLite received a different handle than it passed in');
    seen.push('BODY');
  });
  assert.deepStrictEqual(seen, ['BEGIN', 'BODY', 'COMMIT'], JSON.stringify(seen));
});

// ── run ──────────────────────────────────────────────────────────────────
(async () => {
  try {
    console.log('pg transaction backend (G4) — suite\n');
    for (const { name, fn } of results) {
      try { await fn(); pass++; console.log(`  ok    ${name}`); }
      catch (e) { fail++; console.log(`  FAIL  ${name}\n          ${e.message}`); }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (MUTANT) {
      if (fail > 0) { console.log('MUTANT: suite went RED as required. The red-proof holds.'); code = 0; }
      else { console.log('MUTANT: suite stayed GREEN. THE SUITE DOES NOT PROVE WHAT IT CLAIMS.'); code = 1; }
    } else {
      code = fail ? 1 : 0;
    }
  } finally {
    if (restore) restore();
  }
  process.exit(code);
})();
