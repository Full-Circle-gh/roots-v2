// One in-memory SQLite opener, shared by the offline test suites.
//
// The app's driver when its native binding is built (the box), Node's built-in
// when it isn't (a bare checkout, or a machine where the rebuild never ran) —
// same exec/prepare/run/get/all surface either way, so the statements under
// test run verbatim on both. Keeps the suites to the house rule: no install,
// no network, safe to run anywhere.
//
// ── The bug this file exists to stop happening twice ──────────────────────
// scripts/test_needs_point.js used to carry its own copy of this, written as:
//
//     try { const B = require('better-sqlite3'); return () => new B(':memory:'); }
//     catch { ...node:sqlite... }
//
// `require('better-sqlite3')` SUCCEEDS when the native binding is missing — the
// wrapper is plain JavaScript, and "Could not locate the bindings file" is
// thrown by the CONSTRUCTOR, which sat outside the try. So the fallback never
// fired, and every DB-backed test failed on any machine without a built
// binding: 23 in test_needs_point.js, plus 9 in test_address_pin.js, which had
// no fallback at all. Both files reported those failures as if the code under
// test were broken.
//
// Two things follow, and both are why this is a module rather than a fixed copy
// in each file: the probe must CONSTRUCT, and there must be exactly one of it.
// The original defect was duplication drift — one copy had a broken fallback
// and the other had none — so a shared opener is the fix, not a tidier version
// of the same hazard.
'use strict';

// Probe once at load: open a database with the native driver and close it. That
// is the only thing that proves the binding is loadable.
const picked = (() => {
  try {
    const BetterSqlite = require('better-sqlite3');
    new BetterSqlite(':memory:').close();
    return { name: 'better-sqlite3', open: () => new BetterSqlite(':memory:') };
  } catch {
    // node:sqlite is experimental and warns on every load; the suites' output is
    // read by people, so silence it for the one require that triggers it.
    const quiet = () => {};
    process.on('warning', quiet);
    const { DatabaseSync } = require('node:sqlite');
    process.off('warning', quiet);
    return { name: 'node:sqlite', open: () => new DatabaseSync(':memory:') };
  }
})();

// ── The queue table, rebuilt from database.js ─────────────────────────────
// Not a mock: the REAL definition, both the CREATE and every addColumn() since
// bolted onto it, so a column added there and forgotten here cannot make a
// suite quietly pass.
//
// This is here for the same reason the opener is: it was duplicated, and the
// copies drifted. scripts/test_needs_point.js scanned for the addColumn() calls;
// the two copies in scripts/test_address_pin.js hardcoded a single one
// (`geo_held_at`) instead. When the delivery-point build bolted on
// needs_point_at / guessed_* and taught MANUAL_RETRY_SQL to clear them, those
// two scaffolds went stale and four tests began failing with "no such column:
// needs_point_at" — invisible at the time, because the missing native binding
// was killing the same tests one line earlier.
//
// The floor assertion matters: without it, a rename of the addColumn helper
// would make the scan match nothing and every ALTER silently disappear, which
// is the same class of failure with none of the noise.
function openQueueTableDb(databaseJsSource) {
  const ddl = databaseJsSource.match(/CREATE TABLE IF NOT EXISTS qingyun_push_queue[\s\S]*?\n {2}\);/);
  if (!ddl) throw new Error('qingyun_push_queue DDL not found in database.js');
  const db = picked.open();
  // The FK points at a table this in-memory database doesn't carry.
  db.exec(ddl[0].replace(/FOREIGN KEY[\s\S]*?ON DELETE CASCADE/, 'dummy_fk INTEGER'));
  const added = [...databaseJsSource.matchAll(/addColumn\('qingyun_push_queue',\s*'(\w+)',\s*'(\w+)'\)/g)];
  if (added.length < 7) {
    throw new Error(`expected at least 7 bolted-on qingyun_push_queue columns, found ${added.length}`);
  }
  for (const [, col, type] of added) db.exec(`ALTER TABLE qingyun_push_queue ADD COLUMN ${col} ${type}`);
  return db;
}

// `driver` is printed by the suites so a run's results can be read against the
// engine that produced them — and so a silent fall back to the built-in is
// visible rather than inferred.
module.exports = { openMemoryDb: picked.open, openQueueTableDb, driver: picked.name };
