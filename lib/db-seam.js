// The database seam — the one place a unit converter can ever be installed.
//
// WHY THIS EXISTS
// ---------------
// The full data copy of 2026-08-04 changed 92 columns from REAL yuan to bigint
// cents, plus nine to numeric(14,6). The application reads and writes yuan and
// contains zero conversion sites at the database boundary. Decisions §24 settled
// that the conversion happens at the boundary rather than across hundreds of call
// sites, and that the boundary returns YUAN to the application.
//
// This module is that boundary's seam. It does not convert anything yet. It is
// the seat the converter will sit in, built and proven behaviour-neutral first,
// so that when the converter arrives it has exactly one place to go and one set
// of call sites to cover.
//
// WHAT IT DOES TODAY
// ------------------
// Nothing observable. With no converter installed, every call is forwarded to the
// raw better-sqlite3 handle and its result is returned untouched — the same
// zero-cost passthrough shape tenant-db.js already uses for Roots. The seam's
// value today is that coverage becomes a number you can measure and grow, rather
// than a claim. See scripts/db-seam-coverage.js.
//
// PERMANENT PASS-THROUGHS — exec AND pragma. THIS IS NOT A GAP.
// -------------------------------------------------------------
// `exec` and `pragma` are forwarded raw, forever, by design. They are not
// "unconverted yet"; the converter will never reach them, and a later step must
// not try to route them through it:
//
//   * exec() takes raw SQL with no bound parameters and returns no rows. There is
//     nothing to convert on the way in (no parameters) and nothing to convert on
//     the way out (no result set, therefore no column identity). The converter is
//     per-column and needs a column to act on; exec offers none in either
//     direction. It is DDL and batch statements — CREATE TABLE, ALTER TABLE,
//     ADD COLUMN, the schema self-heal in tenant-db.js.
//   * pragma() addresses SQLite's own settings — journal_mode, foreign_keys,
//     table_info. It never carries application money.
//
// If a future change appears to need conversion inside exec, the correct fix is
// to move that statement to prepare() where it has parameters and columns — not
// to widen the converter. Recorded in docs/tacet-consolidation-decisions.md §24.
//
// RAW HANDLES — WHERE THEY ARE STILL REQUIRED
// -------------------------------------------
// tenantAls.run() and the dbToId map in lib/tenant-db.js hold RAW handles, never
// a wrapper. The ALS store is compared by identity against mainDb, and dbToId is
// keyed by handle identity; a wrapper in either place changes behaviour. Those two
// sites stay raw. A later step that finds it needs a wrapper there must stop and
// raise it as the behaviour change it is, rather than doing it quietly.

'use strict';

// ── The converter seat ──────────────────────────────────────────────────────
// Exactly one converter may be installed, process-wide. None is installed today.
// A converter is { bindIn(sql, params), readOut(sql, rows) }; until one exists,
// `converter` stays null and every wrapped call takes the raw path below, so the
// seam cannot alter a value even by accident.
let converter = null;

function installConverter(c) {
  if (converter) throw new Error('[db-seam] a converter is already installed');
  if (!c || typeof c.bindIn !== 'function' || typeof c.readOut !== 'function') {
    throw new Error('[db-seam] converter must provide bindIn() and readOut()');
  }
  converter = c;
  return converter;
}

function currentConverter() { return converter; }

// ── Wrapping ────────────────────────────────────────────────────────────────
// One wrapper per raw handle, cached, so identity is stable: seam(db) === seam(db).
// Without this, two calls would produce two objects and any `===` comparison
// between them would silently start returning false.
const wrappers = new WeakMap();   // raw handle    -> wrapped handle
const raws = new WeakMap();       // wrapped handle -> raw handle
const stmtWrappers = new WeakMap();

// Methods intercepted on the handle. Everything else — including exec and pragma,
// and anything better-sqlite3 gains in a future version — forwards untouched, so
// the seam can never crash a call site by not knowing about a method.
const HANDLE_INTERCEPT = new Set(['prepare']);

// Statement methods that carry values across the boundary. These are the four the
// converter will act on: parameters travel in, rows travel out.
const STMT_INTERCEPT = new Set(['get', 'all', 'run', 'iterate']);

function isRawHandle(v) {
  return !!v && typeof v === 'object' && typeof v.prepare === 'function' && typeof v.exec === 'function';
}

// Wrap a prepared statement. `sql` is captured so the converter can identify the
// columns and parameters in play without re-deriving them per call.
function wrapStatement(stmt, sql) {
  if (!stmt || typeof stmt !== 'object') return stmt;
  const cached = stmtWrappers.get(stmt);
  if (cached) return cached;

  const proxy = new Proxy(stmt, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;

      return function (...args) {
        // No converter installed → the raw call, verbatim. This is the live path
        // today and it is deliberately indistinguishable from not having a seam.
        if (!converter || !STMT_INTERCEPT.has(prop)) {
          const out = value.apply(target, args);
          // Chainable statement methods (.pluck(), .raw(), .expand(),
          // .safeIntegers(), .bind()) return the statement itself. Hand back the
          // wrapper instead, or the chain would drop out of the seam.
          return out === target ? proxy : out;
        }
        const params = converter.bindIn(sql, args);
        const out = value.apply(target, params);
        if (prop === 'run') return out;              // an info object, no columns
        return converter.readOut(sql, out);
      };
    },
  });

  stmtWrappers.set(stmt, proxy);
  return proxy;
}

// Wrap a raw better-sqlite3 handle. Idempotent: wrapping a wrapper returns it.
function seam(handle) {
  if (!isRawHandle(handle)) return handle;
  if (raws.has(handle)) return handle;                 // already a wrapper
  const cached = wrappers.get(handle);
  if (cached) return cached;

  const proxy = new Proxy(handle, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function' || !HANDLE_INTERCEPT.has(prop)) {
        // exec and pragma land here, permanently, along with transaction(),
        // close(), backup(), function(), and every property.
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return function (...args) {
        return wrapStatement(value.apply(target, args), args[0]);
      };
    },
  });

  wrappers.set(handle, proxy);
  raws.set(proxy, handle);
  return proxy;
}

// The raw handle behind a wrapper. For the two sites that must hold a raw handle
// — tenantAls.run() and dbToId — and for the side-by-side comparison harness.
function unwrap(handle) { return raws.get(handle) || handle; }

function isWrapped(handle) { return raws.has(handle); }

module.exports = { seam, unwrap, isWrapped, installConverter, currentConverter };
