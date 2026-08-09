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

// ── The same trick, for any table ─────────────────────────────────────────
// openQueueTableDb above rebuilds ONE table from database.js. The transaction
// conversion (decisions §24) needs four others, and hand-writing them in the
// suite would recreate precisely the drift this file was created to end — two of
// the four carry bolted-on columns the converted code writes
// (retail_product_option_choices.stock_product_id,
// retail_notifications.broadcast_id), so a hardcoded CREATE would go stale the
// same way scripts/test_address_pin.js's copies did.
//
// Parentheses are BALANCED rather than matched by indentation, because the two
// DDL styles in database.js close differently: tables inside a shared db.exec()
// block end on `  );`, while retail_broadcasts has its own db.exec(`…`) and ends
// on `)` at column 0. An indent-based regex silently truncates one of them.
// Line comments are skipped while balancing — the DDL is full of `-- single |
// multi | text` and one of those could otherwise unbalance the scan.
function extractCreateTable(source, table) {
  const head = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`).exec(source);
  if (!head) throw new Error(`DDL for ${table} not found in database.js`);
  let i = head.index + head[0].length - 1;      // sit on the opening paren
  let depth = 0;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === '-' && source[i + 1] === '-') {   // line comment — skip to newline
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (c === "'") {                            // string literal — skip it
      for (i++; i < source.length && source[i] !== "'"; i++);
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) throw new Error(`unbalanced DDL for ${table} in database.js`);
  return source.slice(head.index, i + 1);
}

/**
 * Create `tables` on an existing handle: the REAL CREATE out of `ddlSource`,
 * then every addColumn() `alterSource` has bolted onto each one since.
 *
 * The two sources are separate arguments because they are not always the same
 * file. Most tables are created in database.js, but some — `categories`, for one
 * — are created by schema.sql and only ALTERed by database.js. Reading the
 * CREATE from the wrong file throws "DDL not found" rather than silently
 * producing a thinner table, which is the intended failure.
 *
 * Foreign keys are stripped: these are single-table extracts, and the targets
 * (products, retail_customers, users) are not necessarily present.
 *
 * ── THE TYPE PATTERN, AND THE COLUMNS IT USED TO LOSE ─────────────────────
 * The scan originally read the type as `'(\w+)'` — a single-quoted single word.
 * database.js does not write them all that way, and the ones it writes
 * differently were dropped SILENTLY, which is the exact failure mode the header
 * above describes: the table is created, the suite is green, and a column the
 * code under test writes is simply not there. Three that the transaction
 * conversion needs were being lost:
 *
 *     addColumn('products',     'sort_order',        'INTEGER DEFAULT 0')
 *     addColumn('retail_polls', 'display_min_total', 'INTEGER NOT NULL DEFAULT 0')
 *     addColumn('retail_media', 'tags',              "TEXT DEFAULT '[]'")
 *
 * So the type is now "everything up to the matching quote", in EITHER quote
 * style — a DEFAULT clause routinely contains a space, and a default that is
 * itself a string forces the outer quotes to be double.
 */
function addTables(db, ddlSource, alterSource, tables) {
  for (const t of tables) {
    const ddl = extractCreateTable(ddlSource, t)
      .replace(/,\s*FOREIGN KEY[\s\S]*?(?=,\s*\w+\s|\s*\)$)/g, '')
      .replace(/,?\s*FOREIGN KEY[^,)]*\([^)]*\)[^,)]*(?:REFERENCES[^,)]*\([^)]*\)[^,)]*)?/g, '');
    db.exec(ddl);
    const added = [...alterSource.matchAll(
      new RegExp(`addColumn\\('${t}',\\s*'(\\w+)',\\s*(?:'([^']*)'|"([^"]*)")\\s*\\)`, 'g')
    )].map(([, col, sq, dq]) => [null, col, sq !== undefined ? sq : dq]);
    for (const [, col, type] of added) {
      // Swallowing duplicates is not leniency, it is the rule addColumn() itself
      // follows (database.js:20) — and it is load-bearing here: schema.sql's
      // `products` already declares description_en, which database.js re-adds
      // idempotently. Only "duplicate column" is swallowed, exactly as there, so
      // a genuinely bad ALTER still fails loudly.
      try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${col} ${type}`); }
      catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
    }
  }
  return db;
}

/**
 * An in-memory database carrying the REAL definitions of `tables`, each with
 * every addColumn() database.js has bolted onto it since.
 */
function openTablesDb(databaseJsSource, tables) {
  return addTables(picked.open(), databaseJsSource, databaseJsSource, tables);
}

/**
 * `store_products`, built the way the application builds it.
 *
 * There is no CREATE TABLE for it to extract ANYWHERE — database.js derives its
 * shape at boot by reading PRAGMA table_info(products) and mirroring every
 * column, then appending four store-only link columns (see the STORE_PRODUCTS
 * block in database.js). So the honest way to get it into a test database is to
 * run that same rule, not to hand-write the two or three columns a given suite
 * happens to touch: a hand-written copy is the drift this whole file exists to
 * end, and `products` gains columns regularly.
 *
 * `products` itself is created here as the source of that mirror and left in
 * place — it is what the rule reads, and the fork is only meaningful next to it.
 *
 * PRAGMA is issued through prepare().all() rather than better-sqlite3's
 * .pragma(), which node:sqlite does not have; the row shape is identical on
 * both (cid/name/type/notnull/dflt_value/pk), verified on each.
 */
function addForkedStoreProducts(db, schemaSqlSource, databaseJsSource) {
  addTables(db, schemaSqlSource, databaseJsSource, ['products']);
  const pcols = db.prepare('PRAGMA table_info(products)').all();
  if (!pcols.length) throw new Error('products has no columns — the fork rule has nothing to mirror');
  const defs = pcols.map(c => {
    if (c.pk) return `${c.name} INTEGER PRIMARY KEY AUTOINCREMENT`;
    let d = `${c.name} ${c.type || 'TEXT'}`;
    if (c.notnull) d += ' NOT NULL';
    if (c.dflt_value !== null && c.dflt_value !== undefined) d += ` DEFAULT ${c.dflt_value}`;
    return d;
  });
  defs.push('kitchen_product_id INTEGER', 'source_sku TEXT', 'synced_at DATETIME',
            "source TEXT DEFAULT 'fork'");
  db.exec(`CREATE TABLE store_products (\n  ${defs.join(',\n  ')}\n)`);
  return db;
}

// `driver` is printed by the suites so a run's results can be read against the
// engine that produced them — and so a silent fall back to the built-in is
// visible rather than inferred.
module.exports = {
  openMemoryDb: picked.open, openQueueTableDb, openTablesDb,
  addTables, addForkedStoreProducts, driver: picked.name,
};
