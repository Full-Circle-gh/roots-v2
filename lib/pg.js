// The PostgreSQL pool, and the read-side money converter that comes with it.
//
// WHY THIS FILE EXISTS
// -------------------
// Decisions §24 ("READ-SIDE MONEY CONVERTER — DECIDED 2026-08-08") settled that
// PostgreSQL returns `numeric` as TEXT (type OID 1700) and that the conversion
// back to a JS number happens as a SINGLE GLOBAL pg type parser registered at
// module load — not a per-query mechanism, not a per-column one, and not a
// hand-maintained money-column list.
//
// The justification for dispatching on TYPE is that the type IS the money list:
// measured across all 162 tables of scripts/postgres-full-copy/plan.json, the
// `numeric(14,6)` set and the `cls: NUM6` money set are the same set — 101 both
// ways, nothing on either side. Every non-money float is `double precision`
// (OID 701) and already arrives as a number, so this parser never sees one. The
// four `*_cents` billing columns are `integer` and unreachable from here, so they
// cannot be double-handled. There are no `bigint` columns at all.
//
// REQUIRING THIS MODULE IS WHAT ARMS THE PARSER. The registration below runs at
// module load, before anything is exported, so no caller can obtain a connection
// from this file without the parser already being in place. That ordering is the
// entire reason the pool lives here rather than being constructed by callers.
//
// THIS MODULE IS NOT WIRED INTO THE APPLICATION. Nothing requires it yet. Roots
// runs on SQLite and continues to: database.js, lib/tenant-db.js and every route
// are untouched. This is the first Postgres connection in the codebase and it is
// deliberately inert — against SQLite the read side is already a no-op, so the
// only test that means anything is one run against this driver.

'use strict';

const { Pool, types } = require('pg');

// ── The numeric type parser ─────────────────────────────────────────────────
// OID 1700 is `numeric` / `decimal`. In pg-types 2.2.0 its default parser is
// `noParse`, i.e. the raw text is handed straight through as a string.
const NUMERIC_OID = 1700;

// The largest integer float64 represents exactly: 2^53 - 1.
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

// Plain decimal only: optional sign, digits, optional single fractional part.
// Anything else — exponent notation, NaN, Infinity, empty — fails this and is
// deliberately left as text rather than guessed at.
const PLAIN_DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

/**
 * Convert PostgreSQL `numeric` text to a JS number when that is lossless, and
 * otherwise return the original string untouched.
 *
 * THE SAFE-RANGE TEST, AND WHY THIS ONE. Strip the sign, remove the decimal
 * point, drop leading zeros, and read what remains as an integer — that is the
 * value expressed as a whole count of the smallest unit it actually carries.
 * If that integer is <= 2^53-1 the decimal has at most as many significant
 * digits as float64 represents exactly, so `Number()` round-trips it and the
 * original value is recoverable. The comparison is done in BigInt, so the
 * decision about whether floats are safe is not itself made using a float.
 *
 * This is deliberately a property of the VALUE, not of a list of known columns.
 * Every money column is numeric(14,6), whose ceiling of 99,999,999.999999 is
 * ~8 orders of magnitude inside the safe range, so no stored money value can
 * fail this test. The guard is here for the case §24 records as genuinely open:
 * `numeric` is UNBOUNDED as an EXPRESSION type even though every column is
 * numeric(14,6), so an aggregate such as SUM() over money can return a value no
 * column could hold. A carve-out list of known columns would not cover that, and
 * would not cover a column added later — the same reasoning that rejected a
 * money-column list. (COUNT(*) returns `bigint`, not `numeric`, and so never
 * reaches this function.)
 *
 * @param {string|null} text raw value from the driver
 * @returns {number|string|null} a number when lossless, else the original text
 */
function parseNumericText(text) {
  // pg does not invoke a type parser for SQL NULL — it short-circuits to null
  // before consulting the parser table. Handled anyway so that calling this
  // function directly behaves the same as going through the driver.
  if (text === null || text === undefined) return text;

  const s = String(text);
  if (!PLAIN_DECIMAL.test(s)) return text;

  const unsigned = s[0] === '+' || s[0] === '-' ? s.slice(1) : s;
  const digits = unsigned.replace('.', '').replace(/^0+/, '');
  // All zeros ("0", "0.000000") reduce to empty — exactly representable.
  if (digits === '') return 0;

  // Cheap length check first; 16 digits or fewer cannot exceed 2^53-1 by more
  // than the exact comparison would catch, and this keeps BigInt off the hot
  // path for ordinary values.
  if (digits.length > 16 || BigInt(digits) > MAX_SAFE) return text;

  return Number(s);
}

// ARM THE PARSER. Process-wide, before anything below is exported.
// setTypeParser mutates the shared pg-types registry, and pg/lib/result.js
// resolves getTypeParser(dataTypeID, format) per column on every query, so this
// single call covers every connection and every pool in the process.
types.setTypeParser(NUMERIC_OID, 'text', parseNumericText);

// ── Connection settings ─────────────────────────────────────────────────────
// Read explicitly from app-scoped variables and passed explicitly to the Pool.
//
// WHY NOT THE STANDARD PG* NAMES: `new Pool()` with no arguments silently falls
// back through libpq's defaults — host to localhost, database to the OS user
// name, user to the OS user. A missing or stray variable would then connect
// somewhere unintended rather than failing, which is precisely what must not
// happen on a database this app does not yet own. App-scoped names also mean a
// PGDATABASE set in the environment for psql cannot redirect the application.
const REQUIRED = ['TACET_PG_HOST', 'TACET_PG_DATABASE', 'TACET_PG_USER'];

const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  throw new Error(
    `[lib/pg] refusing to build a pool: missing ${missing.join(', ')}. ` +
    'Set them explicitly — there is no default host, database or user, on purpose. ' +
    'TACET_PG_PASSWORD is optional (a unix-socket peer connection needs none); ' +
    'TACET_PG_PORT defaults to 5432.'
  );
}

const pool = new Pool({
  host: process.env.TACET_PG_HOST,
  database: process.env.TACET_PG_DATABASE,
  user: process.env.TACET_PG_USER,
  // Optional by design: peer authentication over a unix socket carries no
  // password, and a passwordless TCP attempt fails at the server under
  // scram-sha-256 rather than connecting to anything unexpected.
  password: process.env.TACET_PG_PASSWORD || undefined,
  port: process.env.TACET_PG_PORT ? Number(process.env.TACET_PG_PORT) : 5432,
  application_name: process.env.TACET_PG_APPNAME || 'roots-v2',
});

// Surface pool-level failures instead of letting an idle-client error become an
// unhandled 'error' event on an EventEmitter, which would take the process down.
pool.on('error', (err) => {
  console.error('[lib/pg] idle client error:', err.message);
});

// The pool is the only handle exported. There is nothing here that hands back a
// connection with the parser bypassed — the parser is global to the process, so
// every query through this pool (or any other) is parsed the same way.
// parseNumericText and NUMERIC_OID are exported for tests and diagnostics; using
// them cannot circumvent the registration above.
module.exports = { pool, parseNumericText, NUMERIC_OID };
