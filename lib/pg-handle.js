// The Postgres handle. DELIBERATELY ALIEN — it shares no method name with
// better-sqlite3, and that is the decision this file exists to enforce.
//
// ══ DO NOT MAKE THIS AN ADAPTER. READ THIS BEFORE CHANGING ANYTHING. ══════
//
// The instinct when replacing a driver is to make the new handle look like the
// old one, so existing call sites keep working. Here that instinct is wrong, and
// it is wrong for a measured reason rather than an aesthetic one.
//
// THE MEASUREMENT. The runtime holds 3,344 terminal statement calls —
// 1,619 `.get(`, 648 `.all(`, 1,077 `.run(`. FIVE of them are awaited. Every
// other one is written like `db.prepare(q).get(id).name`, reading a property
// straight off the return value. better-sqlite3 is synchronous; node-postgres is
// not.
//
// SO AN ADAPTER FAILS SILENTLY, NOT LOUDLY. Give those 3,339 sites a `.prepare()`
// that returns something with `.get/.all/.run`, and each one receives a PROMISE
// where it expects a row. JavaScript does not throw on that. `.name` on a Promise
// is `undefined`. `.changes` is `undefined`. `lastInsertRowid` is `undefined`. The
// application does not crash — it quietly computes wrong answers, across every
// route at once, and the first evidence is a customer.
//
// WITHOUT `.prepare`, the same 3,339 sites throw `TypeError: ... is not a
// function` at the first call, with a stack trace pointing at the exact line.
// That is the entire value of this file. A handle that cannot be mistaken for
// better-sqlite3 converts the worst failure mode available into the best one.
//
// AND ONE NAME IS SHARPER THAN THE REST: `exec`. lib/db-transaction.js `control()`
// dispatches on shape, testing `typeof handle.exec === 'function'` BEFORE
// `typeof handle.query === 'function'`. An object exposing both takes the SQLite
// branch and issues BEGIN synchronously down a driver that cannot execute it.
// `exec` must never appear here. The suite asserts its absence by name.
//
// `query` IS ALLOWED, AND IS THE ONE BORROWED NAME. It is node-postgres's own
// method name, better-sqlite3 has nothing called `query`, and `control()` already
// routes it correctly. It collides with nothing.
//
// ── WHAT THIS HANDLE IS FOR TODAY ────────────────────────────────────────
// Nothing runs on it. No call site is converted. It exists so that G3 (the pool)
// and G4 (the transaction backend) have something to plug into, and so that
// selecting Postgres produces a loud, immediate, locatable failure at every
// unconverted site rather than a silent wrong answer.
'use strict';

// Every method and property name better-sqlite3 puts on a Database or a
// Statement. Presence of any one of them here is a bug, not a convenience.
// `exec` heads the list because control() tests it first — see the header.
const FORBIDDEN_NAMES = Object.freeze([
  'exec', 'prepare', 'transaction', 'pragma',
  'backup', 'function', 'aggregate', 'table', 'loadExtension', 'serialize',
  'defaultSafeIntegers', 'unsafeMode', 'close',
  'get', 'all', 'run', 'iterate', 'pluck', 'expand', 'raw', 'safeIntegers',
  'bind', 'columns', 'reader', 'source', 'busy', 'memory', 'readonly',
  'inTransaction', 'open', 'name',
]);

/**
 * Throw if `handle` exposes any better-sqlite3 name.
 *
 * Uses `in` rather than an own-property check on purpose: an adapter bolted on
 * through a prototype or a Proxy is the same hazard as one assigned directly,
 * and this is the guard that has to catch the version of this file that somebody
 * "improved" two years from now.
 */
function assertAlien(handle, label) {
  const found = FORBIDDEN_NAMES.filter((n) => n in handle);
  if (found.length) {
    throw new Error(
      `[pg-handle] ${label} exposes better-sqlite3 name(s): ${found.join(', ')}. ` +
      'This handle must share NO method name with better-sqlite3 — see the header of ' +
      'lib/pg-handle.js. An adapter-shaped handle hands 3,339 synchronous call sites a ' +
      'Promise where they expect a row, and none of them throws. ' +
      (found.includes('exec')
        ? 'And `exec` specifically makes lib/db-transaction.js control() take the SQLite branch. '
        : '') +
      'Remove the name rather than relaxing this check.'
    );
  }
}

/**
 * Build the application-facing Postgres handle.
 *
 * @param {object} opts
 * @param {(text: string, params?: any[]) => Promise<any>} opts.query
 *        Runs one statement. The only data path this handle has.
 * @param {(() => Promise<object>)|null} opts.checkout
 *        Leases a dedicated connection for a transaction, or null while
 *        unimplemented. See lib/db-transaction.js for why a transaction cannot
 *        run on a pool.
 * @param {string} opts.description  What this handle is pointed at, for logs.
 * @param {string} [opts.label]      What to call it in errors.
 */
function makePgHandle({ query, checkout = null, description, label = 'the Postgres handle' }) {
  if (typeof query !== 'function') {
    throw new TypeError('[pg-handle] query must be a function');
  }
  const handle = {
    // Declares itself rather than being duck-typed. Anything deciding what to do
    // with this handle should read this, not probe for method names — probing is
    // what control() does and is precisely the trap this file is built around.
    driver: 'postgres',
    description,
    query,
    checkout,
  };
  assertAlien(handle, label);
  // Frozen so `.prepare` cannot be bolted on at runtime by a later well-meaning
  // patch. The assertion above only runs here, once; the freeze is what makes it
  // hold for the life of the process.
  return Object.freeze(handle);
}

/**
 * The live handle, backed by the connection pool (G3).
 *
 * ── IDENTITY IS LOAD-BEARING, AND THIS IS THE ONE OF THESE EVER BUILT ────
 * lib/tenant-db.js compares the AsyncLocalStorage store against `mainDb` BY
 * IDENTITY to answer currentTenantId(), keys dbToId by raw handle, and
 * tenantAls.run() throws outright if it is handed a seam wrapper. If two
 * different objects were ever handed out for one driver, currentTenantId() would
 * stop recognising the Roots scope and either report the wrong tenant or throw
 * on every request — and that value selects a tenant's credentials.
 *
 * One object per process is what makes that safe, and it comes free: database.js
 * calls this once and Node's module cache hands the same export to all 94
 * requiring files. lib/db-seam.js also leaves it alone — seam() only wraps
 * something with BOTH .prepare and .exec, and this has neither — so tdb() returns
 * this very object rather than a proxy of it. That is not a happy accident; it is
 * the alien shape paying for itself a second time.
 *
 * @param {import('pg').Pool} pool
 */
function makePooledPgHandle(pool) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('[pg-handle] makePooledPgHandle needs a pg Pool');
  }
  return makePgHandle({
    // The pool's own query, bound. Returns pg's result object whole — rows AND
    // rowCount — rather than unwrapping to rows: rowCount is what a converted
    // call site will need where better-sqlite3 gave it info.changes, and a
    // handle that threw that away would have to be widened later.
    query: (text, params) => pool.query(text, params),
    // Transactions cannot run on a pool: consecutive statements can land on
    // different connections, so BEGIN and its body would come apart. The lease
    // that fixes it is G4 — lib/db-transaction.js refuses rather than guessing
    // while this is null.
    checkout: null,
    description: 'postgres (pooled)',
    label: 'the pooled Postgres handle',
  });
}

module.exports = {
  makePgHandle, makePooledPgHandle, assertAlien, FORBIDDEN_NAMES,
};
