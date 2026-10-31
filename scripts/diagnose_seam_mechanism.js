#!/usr/bin/env node
/**
 * diagnose_seam_mechanism.js — the ONE-TIME EXHAUSTIVE PROOF that lib/db-seam.js
 * is behaviour-neutral, against a scratch database built from the LIVE SCHEMA.
 *
 * WHY THIS EXISTS, AND WHY IT IS SEPARATE FROM THE PER-FILE HARNESS
 * ----------------------------------------------------------------
 * scripts/diagnose_seam_batch.js proves that a PARTICULAR module still behaves
 * the same once routed through the seam. It samples: it drives the reads a module
 * exports and compares raw against wrapped. That is the right shape for a batch,
 * and it is not a proof of the mechanism — it exercises whichever corner of
 * better-sqlite3 those modules happen to touch.
 *
 * The mechanism deserves proving ONCE, exhaustively, so that every later batch can
 * lean on it and only has to show that the batch's own files are inside the proven
 * envelope. That is what this file is. It enumerates the better-sqlite3 API rather
 * than listing it, so a method nobody thought of is still covered, and it drives
 * every column type and every money column the live schema actually has.
 *
 * THE SCRATCH DATABASE IS BUILT FROM THE LIVE SCHEMA, NOT INVENTED
 * ---------------------------------------------------------------
 * The tables and columns come from scripts/postgres-full-copy/plan.json — the
 * census taken off the live database during the 2026-08-04 full copy. 162 tables,
 * every column with its declared SQLite type and its conversion class. A toy
 * schema would prove the wrapper works on a toy schema; this proves it on the
 * shape the converter will actually meet.
 *
 * It is a SCRATCH database in the OS temp directory. This script never opens
 * data/roots.db — it refuses to run if its target path is anywhere near the live
 * application — so it is safe to run anywhere, including on the box.
 *
 * MONEY IS DRIVEN HARDEST
 * -----------------------
 * plan.json classifies every column. 92 are CENTS (REAL yuan heading for bigint
 * cents) and 9 are NUM6 (numeric(14,6)). Those 101 columns are what the converter
 * exists for, so every one of them is round-tripped through the wrapper with a set
 * of hostile float values, not just the schema-wide sweep.
 *
 * WHAT IT PROVES, IN NINE PARTS
 * -----------------------------
 *   0  the scratch schema really is the live schema's shape
 *   1  surface parity — every member of Database and Statement, ENUMERATED
 *   2  identity and caching invariants the seam promises
 *   3  behavioural parity, method by method, across the whole API
 *   4  value fidelity across every column type and every conversion class
 *   5  the no-converter invariant: wrapped output IS raw output
 *   6  error parity — same class, same message
 *   7  transaction semantics, including rollback
 *   8  iterate semantics
 *   9  the converter seat is really wired — proven with a marker converter that
 *      converts nothing, in a throwaway module instance
 *
 * Run: node scripts/diagnose_seam_mechanism.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// The seam under test always comes from HOME — under ro-query that is the staged
// checkout, which is the whole point: this checkout's seam, on production's Node
// and production's better-sqlite3 build.
const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_SEAM_JS = path.join(HOME, 'lib', 'db-seam.js');

// The schema census and the source scan need a COMPLETE tree, and ro-query
// stages only lib/, routes/ and middleware/. Resolving them separately from HOME
// is what lets this run on the box at all. Falling back silently to a partial
// tree would be worse than failing: the scan would cover fewer files and still
// report success, which is exactly the quiet under-measurement the coverage
// checker was corrected for on 2026-08-04. So a partial tree is refused, loudly.
const LIVE_APP = '/root/roots-v2';
const firstExisting = (cands) => cands.find((c) => fs.existsSync(c)) || null;

const PLAN_JSON = firstExisting([
  path.join(HOME, 'scripts', 'postgres-full-copy', 'plan.json'),
  path.join(LIVE_APP, 'scripts', 'postgres-full-copy', 'plan.json'),
]);

function loadBetterSqlite3() {
  const local = path.join(HOME, 'node_modules', 'better-sqlite3');
  try { return require(local); } catch (e) { return require('better-sqlite3'); }
}
const Database = loadBetterSqlite3();

let FAILURES = 0;
let CHECKS = 0;
const NOTES = [];
const fail = (m) => { FAILURES++; console.log('   FAIL  ' + m); };
const ok = (m) => { CHECKS++; console.log('   ok    ' + m); };
const note = (m) => { NOTES.push(m); console.log('   note  ' + m); };
// Quiet assertion — counts toward CHECKS, only speaks when it fails. The sweeps
// run thousands of these and a line each would bury the result.
const check = (cond, m) => { CHECKS++; if (!cond) { FAILURES++; console.log('   FAIL  ' + m); } return cond; };

// ── strict structural comparison ────────────────────────────────────────────
// Object.is at the leaves, so -0 vs 0 and NaN vs NaN are decided correctly. A
// loose compare here would let exactly the class of drift this exists to catch
// slip past.
function diff(a, b, p = '') {
  if (Object.is(a, b)) return null;
  if (typeof a !== typeof b) return `${p}: type ${typeof a} vs ${typeof b}`;
  if (a === null || b === null) return `${p}: ${a} vs ${b}`;
  if (typeof a !== 'object') return `${p}: ${String(a)} vs ${String(b)}`;
  const aBuf = Buffer.isBuffer(a) || a instanceof Uint8Array;
  const bBuf = Buffer.isBuffer(b) || b instanceof Uint8Array;
  if (aBuf || bBuf) {
    if (!aBuf || !bBuf) return `${p}: buffer vs non-buffer`;
    if (a.length !== b.length) return `${p}: buffer length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return `${p}[${i}]: byte ${a[i]} vs ${b[i]}`;
    return null;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${p}: array vs non-array`;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return `${p}: ${ka.length} keys vs ${kb.length}`;
  for (const k of ka) {
    if (!(k in b)) return `${p}.${k}: missing on the other side`;
    const d = diff(a[k], b[k], `${p}.${k}`);
    if (d) return d;
  }
  return null;
}

// Every member name up the prototype chain — this is what makes part 1 an
// enumeration rather than a list somebody has to remember to update.
function allMembers(obj) {
  const out = new Set();
  for (let o = obj; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) if (k !== 'constructor') out.add(k);
  }
  return [...out].sort();
}

const q = (id) => '"' + String(id).replace(/"/g, '""') + '"';

// ── in-scope source scanning ────────────────────────────────────────────────
// The scope rule from decisions §24: everything that can reach the live database
// on an ongoing, unattended basis. Used to turn "nothing depends on this" from a
// claim into a check that keeps running.
const DAEMONS = ['guanyi-daemon.js', 'meituan-daemon.js', 'shangou-daemon.js',
  'gzgrocery-order-daemon.js', 'qingyun-daemon.js', 'eleme-daemon.js'];

// A tree is only usable for the scan if it holds every in-scope surface. Partial
// is refused rather than quietly scanned.
function treeCompleteness(root) {
  const missing = [];
  for (const p of ['server.js', 'database.js', 'lib', 'routes', 'middleware']) {
    if (!fs.existsSync(path.join(root, p))) missing.push(p);
  }
  if (!DAEMONS.some((d) => fs.existsSync(path.join(root, 'scripts', d)))) missing.push('scripts/<daemons>');
  // ro-query writes a stub `module.exports = {}` database.js into the stage dir.
  // A 30-byte database.js is not the real one and must not count as complete.
  try {
    if (fs.existsSync(path.join(root, 'database.js')) &&
        fs.statSync(path.join(root, 'database.js')).size < 1024) missing.push('database.js (stub, not the real file)');
  } catch (e) { /* counted as missing above */ }
  return missing;
}

const SOURCE_ROOT = (() => {
  for (const root of [HOME, LIVE_APP]) {
    if (fs.existsSync(root) && treeCompleteness(root).length === 0) return root;
  }
  return null;
})();

function collectInScopeSources() {
  const files = [];
  const walk = (rel) => {
    const abs = path.join(SOURCE_ROOT, rel);
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const child = `${rel}/${e.name}`;
      // Dirent.isDirectory()/isFile() do NOT resolve symlinks, so a symlinked
      // routes/ or a symlinked module would be skipped and the scan would quietly
      // cover less. A symlinked source file is still in-scope code, so resolve it.
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try {
          const st = fs.statSync(path.join(SOURCE_ROOT, child));
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch (err) { continue; }        // dangling link — nothing to scan
      }
      if (isDir) walk(child);
      else if (isFile && e.name.endsWith('.js')) files.push(child);
    }
  };
  ['routes', 'lib', 'middleware'].forEach(walk);
  for (const f of ['server.js', 'database.js']) {
    if (fs.existsSync(path.join(SOURCE_ROOT, f))) files.push(f);
  }
  for (const d of DAEMONS) {
    const rel = `scripts/${d}`;
    if (fs.existsSync(path.join(SOURCE_ROOT, rel))) files.push(rel);
  }
  return files;
}

// `where(prefix, line)` gets the text before each match, so a hit can be rejected
// on context rather than by loosening the pattern. `typeof x.prepare === 'function'`
// and `x.prepare === y.prepare` look alike to a regex and are completely different
// things; only the second one is affected by the wrapper.
function grepSources(files, re, where) {
  const hits = [];
  for (const f of files) {
    let src;
    try { src = fs.readFileSync(path.join(SOURCE_ROOT, f), 'utf8'); } catch (e) { continue; }
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      let m;
      while ((m = rx.exec(lines[i])) !== null) {
        const prefix = lines[i].slice(0, m.index);
        if (where && !where(prefix, lines[i])) continue;
        hits.push({ file: f, line: i + 1, text: lines[i].trim() });
        break;
      }
    }
  }
  return hits;
}

// A `typeof` immediately governing the member access. That comparison is on the
// STRING 'function', which the wrapper preserves — proven in part 1 — so it is
// not a method-identity comparison and must not be reported as one.
const GOVERNED_BY_TYPEOF = /typeof\s+[\w.$[\]'"]*$/;

// ════════════════════════════════════════════════════════════════════════════
console.log('seam mechanism — exhaustive proof against a scratch copy of the live schema');
console.log('   home     : ' + HOME);
console.log('   seam     : ' + DB_SEAM_JS);

const { seam, unwrap, isWrapped, currentConverter } = require(DB_SEAM_JS);

if (currentConverter() !== null) {
  console.error('FATAL: a converter is already installed. This proof asserts the no-converter path.');
  process.exit(2);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 0 · scratch database, built from the live schema census ══');

const plan = JSON.parse(fs.readFileSync(PLAN_JSON, 'utf8'));
const tables = plan.tables;

const SCRATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'seam-mech-'));
const SCRATCH = path.join(SCRATCH_DIR, 'scratch.db');

// Refuse to run anywhere near the live application. The proof writes, so this is
// the one guard that actually matters.
const LIVE_MARKERS = [path.join(HOME, 'data'), '/root/roots-v2/data'];
for (const m of LIVE_MARKERS) {
  if (path.resolve(SCRATCH).startsWith(path.resolve(m))) {
    console.error('FATAL: scratch path is inside the live data directory: ' + SCRATCH);
    process.exit(2);
  }
}
console.log('   scratch  : ' + SCRATCH + '  (temp, writable, never the live database)');

const db = new Database(SCRATCH);
db.pragma('journal_mode = MEMORY');

let tableCount = 0, colCount = 0;
const moneyCols = [];          // {table, col, cls, sqtype}
const byClass = {};
for (const [tname, tv] of Object.entries(tables)) {
  const cols = tv.cols.filter((c) => c.sq);
  if (!cols.length) continue;
  const defs = cols.map((c) => `${q(c.sq)} ${c.sqtype || ''}`.trim()).join(', ');
  try {
    db.exec(`CREATE TABLE ${q(tname)} (${defs})`);
  } catch (e) {
    fail(`could not create scratch table ${tname}: ${e.message}`);
    continue;
  }
  tableCount++;
  for (const c of cols) {
    colCount++;
    byClass[c.cls] = (byClass[c.cls] || 0) + 1;
    if (c.cls === 'CENTS' || c.cls === 'NUM6') moneyCols.push({ table: tname, col: c.sq, cls: c.cls, sqtype: c.sqtype });
  }
}
console.log(`   built ${tableCount} table(s), ${colCount} column(s)`);
console.log('   conversion classes: ' + Object.entries(byClass).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k}=${v}`).join('  '));
console.log(`   money columns (CENTS + NUM6): ${moneyCols.length}`);
check(tableCount >= 150, `expected the live census to yield 150+ tables, got ${tableCount}`);
check(moneyCols.length === 101, `expected 101 money columns (92 CENTS + 9 NUM6), got ${moneyCols.length}`);
ok(`scratch schema matches the live census: ${tableCount} tables, ${colCount} columns, ${moneyCols.length} money columns`);

const W = seam(db);            // the wrapper under test, over the same connection

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 1 · surface parity — every member, enumerated not listed ══');

{
  const probeSql = `SELECT 1 AS a`;
  const rawStmt = db.prepare(probeSql);
  const wrapStmt = W.prepare(probeSql);

  const dbMembers = allMembers(db);
  const stMembers = allMembers(rawStmt);
  console.log(`   Database exposes ${dbMembers.length} member(s); Statement exposes ${stMembers.length}`);

  const lostDb = [], typeDb = [], identityDiff = [];
  for (const m of dbMembers) {
    let rv, wv;
    try { rv = db[m]; } catch (e) { rv = `<throw:${e.message}>`; }
    try { wv = W[m]; } catch (e) { wv = `<throw:${e.message}>`; }
    if (wv === undefined && rv !== undefined) { lostDb.push(m); continue; }
    if (typeof rv !== typeof wv) { typeDb.push(`${m}: ${typeof rv} vs ${typeof wv}`); continue; }
    if (typeof rv === 'function' && rv !== wv) identityDiff.push(m);
  }
  check(lostDb.length === 0, `handle members unreachable through the wrapper: ${lostDb.join(', ')}`);
  check(typeDb.length === 0, `handle members whose type changed: ${typeDb.join('; ')}`);
  ok(`all ${dbMembers.length} Database members reachable through the wrapper with the same type`);

  const lostSt = [], typeSt = [];
  for (const m of stMembers) {
    let rv, wv;
    try { rv = rawStmt[m]; } catch (e) { rv = `<throw:${e.message}>`; }
    try { wv = wrapStmt[m]; } catch (e) { wv = `<throw:${e.message}>`; }
    if (wv === undefined && rv !== undefined) { lostSt.push(m); continue; }
    if (typeof rv !== typeof wv) typeSt.push(`${m}: ${typeof rv} vs ${typeof wv}`);
  }
  check(lostSt.length === 0, `statement members unreachable through the wrapper: ${lostSt.join(', ')}`);
  check(typeSt.length === 0, `statement members whose type changed: ${typeSt.join('; ')}`);
  ok(`all ${stMembers.length} Statement members reachable through the wrapper with the same type`);

  // Getters must evaluate against the real handle, not the proxy.
  for (const g of ['open', 'inTransaction', 'readonly', 'memory', 'name']) {
    check(Object.is(db[g], W[g]), `handle getter ${g}: raw ${String(db[g])} vs wrapped ${String(W[g])}`);
  }
  for (const g of ['reader', 'readonly', 'busy', 'source']) {
    check(Object.is(rawStmt[g], wrapStmt[g]), `statement getter ${g}: raw ${String(rawStmt[g])} vs wrapped ${String(wrapStmt[g])}`);
  }
  ok('property getters evaluate against the underlying handle, not the proxy');

  check(W instanceof Database, 'wrapped handle fails instanceof Database');
  check(Object.getPrototypeOf(W) === Object.getPrototypeOf(db), 'wrapped handle has a different prototype');
  ok('instanceof and prototype identity survive wrapping');

  // Two real differences. Neither is a defect today, and both are only inert
  // because nothing in the codebase depends on them — so that is SCANNED below,
  // not asserted in prose. The scan is the part that keeps being true.
  if (!SOURCE_ROOT) {
    fail('no COMPLETE in-scope source tree found — refusing to scan a partial one. ' +
         `HOME (${HOME}) is missing: ${treeCompleteness(HOME).join(', ')}; ` +
         `${LIVE_APP} is missing: ${fs.existsSync(LIVE_APP) ? treeCompleteness(LIVE_APP).join(', ') : 'the directory itself'}. ` +
         'A partial scan would report success while covering fewer files, which is the exact ' +
         'under-measurement the coverage checker was corrected for on 2026-08-04.');
  }
  const inScope = SOURCE_ROOT ? collectInScopeSources() : [];
  console.log(`   scanning ${inScope.length} in-scope source file(s) under ${SOURCE_ROOT || '(none)'}`);
  // A tree that suddenly scans far fewer files is a broken harness, not a clean result.
  check(inScope.length >= 100,
    `only ${inScope.length} in-scope source file(s) found — expected 100+; the scan is not covering the application`);

  if (identityDiff.length) {
    // `db.prepare === db.prepare` is true; `W.prepare === W.prepare` is not,
    // because the seam hands back a fresh bound function on each access.
    const RE_ID = /\.(prepare|exec|pragma|transaction|function|aggregate|close|backup|serialize)\s*(===|!==)/;
    const identityHits = grepSources(inScope, RE_ID, (prefix) => !GOVERNED_BY_TYPEOF.test(prefix));
    const typeofHits = grepSources(inScope, RE_ID, (prefix) => GOVERNED_BY_TYPEOF.test(prefix));
    check(identityHits.length === 0,
      `method-identity comparison found in ${identityHits.length} place(s) — the wrapper would change its answer: ` +
      identityHits.slice(0, 5).map((h) => `${h.file}:${h.line}`).join(', '));

    // The duck-typing sites are not identity comparisons, but they ARE a real
    // dependency on the wrapper's surface: three of them decide whether an object
    // passed in is treated as a database handle at all. If the wrapper failed the
    // duck-type, those modules would silently take their legacy branch instead.
    // So the sites are counted AND the property they rely on is asserted.
    check(typeof W.prepare === 'function' && typeof W.exec === 'function',
      'the wrapper fails the `typeof handle.prepare === "function"` duck-type that ' +
      `${typeofHits.length} in-scope site(s) use to recognise a database handle`);
    if (typeofHits.length) {
      console.log(`   ${typeofHits.length} site(s) duck-type a handle via typeof — unaffected, and now asserted:`);
      for (const h of typeofHits) console.log(`         ${h.file}:${h.line}  ${h.text.slice(0, 76)}`);
    }
    note(`method IDENTITY is not stable through the wrapper — W.x !== W.x for ${identityDiff.length} handle method(s), ` +
         'because the seam hands back a fresh bound function on each access. Values and behaviour are identical; only ' +
         '`===` between two reads of the same method differs. Scanned all in-scope sources: 0 sites compare a handle ' +
         'method by identity, so this is inert today. The scan is the guard — a future memoiser keyed on method identity ' +
         'would fail this check rather than surprise someone.');
  }

  const dbFromStmt = wrapStmt.database;
  if (dbFromStmt === db && dbFromStmt !== W) {
    // A statement hands back the RAW handle. Reaching it is a way out of the seam.
    const hits = grepSources(inScope, /\b(?:stmt|st|statement|s|q|sel|ins|upd|del)\w*\s*\.\s*database\b/i)
      .filter((h) => !/require\s*\(/.test(h.text));
    check(hits.length === 0,
      `statement.database is reached in ${hits.length} place(s) — those step outside the seam: ` +
      hits.slice(0, 5).map((h) => `${h.file}:${h.line}`).join(', '));
    note('stmt.database returns the RAW handle, not the wrapper. A module that reaches a database handle back out of ' +
         'a statement steps OUTSIDE the seam. Scanned all in-scope sources: 0 sites do it. The scan is the guard, and ' +
         'the per-file capability audit repeats it per batch.');
  }
  // Third leak, same family, found by the mutation test: exec() returns the RAW
  // handle, so chaining off it steps outside the seam exactly like stmt.database.
  check(W.exec('SELECT 1') === db, 'exec() through the wrapper should hand back the raw handle');
  // `.exec(` is also RegExp.prototype.exec, which is unrelated and far more
  // common here. Reject a regex-literal or RegExp(...) receiver so the check is
  // about the database handle it is actually asking about.
  const IS_REGEX_RECEIVER = /(?:\/[gimsuy]*|RegExp\s*\([^)]*\))\s*$/;
  const execChain = grepSources(inScope, /\.exec\s*\([^)]*\)\s*\./,
    (prefix) => !IS_REGEX_RECEIVER.test(prefix));
  check(execChain.length === 0,
    `chaining off exec() found in ${execChain.length} place(s) — exec returns the RAW handle, so the chain ` +
    `leaves the seam: ${execChain.slice(0, 5).map((h) => `${h.file}:${h.line}`).join(', ')}`);
  note('exec() returns the RAW handle, so `db.exec(sql).prepare(...)` would leave the seam. Scanned all in-scope ' +
       'sources: 0 sites chain off exec(). Same family as stmt.database, and scanned the same way.');

  ok('the three wrapper-visible differences are scanned for in every in-scope source, not assumed harmless');
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 2 · identity and caching invariants ══');

// Two separate calls held in two variables. Comparing seam(db) === seam(db)
// inline reads as a self-comparison to eslint, and it is the two RESULTS that
// must be identical — the same reason lib/tenant-db.js's own check is written
// this way.
const wrapA = seam(db);
const wrapB = seam(db);
check(wrapA === wrapB, 'seam(db) is not stable across calls — identity comparisons would break');
check(seam(seam(db)) === seam(db), 'seam() is not idempotent');
check(unwrap(W) === db, 'unwrap(seam(db)) does not return the raw handle');
check(unwrap(db) === db, 'unwrap() of a raw handle should return it unchanged');
check(isWrapped(W) === true, 'isWrapped(wrapper) should be true');
check(isWrapped(db) === false, 'isWrapped(raw) should be false');
check(seam(null) === null && seam(42) === 42, 'seam() should pass non-handles through untouched');
check(seam({}) !== undefined, 'seam() should not choke on a plain object');
ok('handle wrapping is cached, idempotent, reversible and safe on non-handles');

{
  // Chainable statement methods return the statement itself; the seam must hand
  // back the wrapper or the chain silently drops out of the seam.
  const s = W.prepare('SELECT 1 AS a');
  check(s.pluck() === s, 'stmt.pluck() did not return the wrapper — the chain leaves the seam');
  check(s.raw() === s, 'stmt.raw() did not return the wrapper');
  check(s.expand() === s, 'stmt.expand() did not return the wrapper');
  check(s.safeIntegers() === s, 'stmt.safeIntegers() did not return the wrapper');
  s.pluck(false); s.raw(false); s.expand(false); s.safeIntegers(false);
  ok('pluck/raw/expand/safeIntegers keep the chain inside the seam');
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 3 · behavioural parity, method by method ══');

db.exec('CREATE TABLE _probe (id INTEGER PRIMARY KEY, t TEXT NOT NULL, r REAL, b BLOB, i INTEGER UNIQUE)');
const seedProbe = db.prepare('INSERT INTO _probe (t, r, b, i) VALUES (?, ?, ?, ?)');
for (let n = 1; n <= 25; n++) seedProbe.run('row' + n, n / 7, Buffer.from([n, n + 1]), n);

{
  const SQL = 'SELECT * FROM _probe ORDER BY id';
  const cmp = (label, fn) => {
    let ra, wa, re = null, we = null;
    try { ra = fn(db); } catch (e) { re = e; }
    try { wa = fn(W); } catch (e) { we = e; }
    if (re || we) {
      check(!!re === !!we && String(re && re.message) === String(we && we.message),
        `${label}: raw ${re && re.message} vs wrapped ${we && we.message}`);
      return;
    }
    const d = diff(ra, wa, label);
    check(d === null, `${label}: ${d}`);
  };

  cmp('prepare().all()', (h) => h.prepare(SQL).all());
  cmp('prepare().get()', (h) => h.prepare(SQL).get());
  cmp('prepare().all(bound)', (h) => h.prepare('SELECT * FROM _probe WHERE i > ? AND t LIKE ?').all(3, 'row%'));
  cmp('prepare().get(named)', (h) => h.prepare('SELECT * FROM _probe WHERE i = @i').get({ i: 5 }));
  cmp('prepare().pluck().all()', (h) => h.prepare('SELECT t FROM _probe ORDER BY id').pluck().all());
  cmp('prepare().raw().all()', (h) => h.prepare(SQL).raw().all());
  cmp('prepare().expand().get()', (h) => h.prepare(SQL).expand().get());
  cmp('prepare().columns()', (h) => h.prepare(SQL).columns());
  cmp('prepare().bind().all()', (h) => h.prepare('SELECT * FROM _probe WHERE i = ?').bind(7).all());
  cmp('prepare().safeIntegers().get()', (h) => h.prepare('SELECT i FROM _probe WHERE i = 9').safeIntegers().get());
  cmp('iterate() drained', (h) => [...h.prepare(SQL).iterate()]);
  cmp('pragma(table_info)', (h) => h.pragma('table_info(_probe)'));
  cmp('pragma(simple)', (h) => h.pragma('journal_mode', { simple: true }));
  // NOT `typeof` — that is 'object' whether exec returns the handle or a proxy
  // around it, and an earlier version of this proof compared only the type and
  // let a seam that intercepted exec pass. Compare what actually comes back.
  cmp('exec() return value', (h) => h.exec('SELECT 1') === db ? 'the raw handle' : 'something else');
  // Asserted directly rather than compared raw-vs-wrapped, because `r === h` is
  // EXPECTED to differ: exec returns the raw handle, so it equals the receiver
  // only on the raw side. That asymmetry is the documented leak, not a defect,
  // and folding it into an equality comparison would report the seam as broken.
  check(W.exec('SELECT 1') === db, 'exec() through the wrapper must hand back the raw handle untouched');
  check(W.exec('SELECT 1') !== W, 'exec() unexpectedly returned the wrapper — the seam is intercepting it');
  cmp('statement source', (h) => h.prepare(SQL).source);
  cmp('statement reader/readonly/busy', (h) => {
    const s = h.prepare(SQL); return { reader: s.reader, readonly: s.readonly, busy: s.busy };
  });
  cmp('name/open/memory/readonly', (h) => ({ name: h.name, open: h.open, memory: h.memory, readonly: h.readonly }));
  cmp('function() registration + use', (h) => {
    const fname = 'seamfn_' + (h === db ? 'raw' : 'wrap');
    h.function(fname, (x) => x * 2);
    return h.prepare(`SELECT ${fname}(21) AS v`).get();
  });
  cmp('aggregate() registration + use', (h) => {
    const aname = 'seamagg_' + (h === db ? 'raw' : 'wrap');
    h.aggregate(aname, { start: 0, step: (t, v) => t + v });
    return h.prepare(`SELECT ${aname}(i) AS v FROM _probe`).get();
  });
  cmp('serialize()', (h) => h.serialize().length);
  ok('every exercised Database and Statement method returns identical results raw and wrapped');
}

{
  // run() writes: prove the info object and the actual effect match.
  const before = db.prepare('SELECT COUNT(*) AS c FROM _probe').pluck().get();
  const rawInfo = db.prepare('INSERT INTO _probe (t, r, i) VALUES (?, ?, ?)').run('viaRaw', 1.25, 901);
  const wrapInfo = W.prepare('INSERT INTO _probe (t, r, i) VALUES (?, ?, ?)').run('viaWrap', 1.25, 902);
  check(typeof rawInfo.changes === 'number' && typeof wrapInfo.changes === 'number', 'run() info missing changes');
  check(rawInfo.changes === wrapInfo.changes, `run() changes differ: ${rawInfo.changes} vs ${wrapInfo.changes}`);
  check(wrapInfo.lastInsertRowid === rawInfo.lastInsertRowid + 1,
    `run() lastInsertRowid did not advance as expected: ${rawInfo.lastInsertRowid} then ${wrapInfo.lastInsertRowid}`);
  const after = db.prepare('SELECT COUNT(*) AS c FROM _probe').pluck().get();
  check(after === before + 2, `two inserts should add two rows, got ${after - before}`);
  const rr = db.prepare('SELECT t, r, i FROM _probe WHERE i IN (901,902) ORDER BY i').all();
  check(diff(rr[0].r, rr[1].r) === null, 'the wrapped write stored a different value than the raw write');
  ok('run() reports the same info and has the same effect through the wrapper');
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 4 · value fidelity — every column type, every conversion class ══');

// Hostile values chosen to break a naive converter or a lossy round-trip.
const EDGE = {
  INT: [0, -0, 1, -1, 2147483647, -2147483648, 9007199254740991, -9007199254740991, null],
  CENTS: [0, -0, 0.01, -0.01, 0.1 + 0.2, 1 / 3, 12345.67, -12345.67, 99999999.99, 1e-7, 2.675, null],
  NUM6: [0, 0.000001, -0.000001, 1.234567, -1.234567, 1e6 + 0.5, null],
  REAL: [0, -0, Number.MIN_VALUE, 1.7976931348623157e308, -1.7976931348623157e308, 0.1, null],
  // The fourth entry carries a NUL inside TEXT — SQLite truncates there, which
  // is worth exercising. It is written as an ESCAPE deliberately: a raw NUL byte
  // in the source makes the whole file read as binary to grep and diff tooling.
  TEXT: ['', ' ', 'plain', '\u0000embedded', '中文字符', "quote'and\"double", '\\backslash', 'x'.repeat(4096), null],
  BOOL: [0, 1, null],
  TS: ['2026-08-05 01:23:45', '1970-01-01 00:00:00', null],
  DATE: ['2026-08-05', null],
};
const edgesFor = (cls) => EDGE[cls] || EDGE.TEXT;

{
  // Sweep 1 — every table, every column, one representative value each.
  let sweptTables = 0, sweptCols = 0, mismatches = 0;
  for (const [tname, tv] of Object.entries(tables)) {
    const cols = tv.cols.filter((c) => c.sq);
    if (!cols.length) continue;
    const names = cols.map((c) => q(c.sq)).join(', ');
    const marks = cols.map(() => '?').join(', ');
    const vals = cols.map((c) => {
      const e = edgesFor(c.cls);
      return e[Math.min(2, e.length - 1)];
    });
    let insRaw, insWrap;
    try {
      insRaw = db.prepare(`INSERT INTO ${q(tname)} (${names}) VALUES (${marks})`);
      insWrap = W.prepare(`INSERT INTO ${q(tname)} (${names}) VALUES (${marks})`);
      insRaw.run(...vals);
      insWrap.run(...vals);
    } catch (e) {
      fail(`sweep insert failed on ${tname}: ${e.message}`);
      continue;
    }
    const readRaw = db.prepare(`SELECT * FROM ${q(tname)} ORDER BY rowid`).all();
    const readWrap = W.prepare(`SELECT * FROM ${q(tname)} ORDER BY rowid`).all();
    const d = diff(readRaw, readWrap, tname);
    if (d) { mismatches++; fail(`schema sweep mismatch: ${d}`); }
    // The raw-written row and the wrapper-written row must also be identical.
    const d2 = diff(readRaw[0], readRaw[1], `${tname}[raw-write vs wrapped-write]`);
    if (d2) { mismatches++; fail(`write-path mismatch: ${d2}`); }
    sweptTables++; sweptCols += cols.length;
  }
  CHECKS += sweptTables * 2;
  check(mismatches === 0, `${mismatches} table(s) differed between raw and wrapped`);
  ok(`schema sweep: ${sweptTables} tables / ${sweptCols} columns round-tripped identically, read and write`);
}

{
  // Sweep 2 — the money columns, driven hard. These are what the converter is for.
  let done = 0, bad = 0;
  for (const m of moneyCols) {
    const edges = edgesFor(m.cls);
    for (const v of edges) {
      let rawOut, wrapOut;
      try {
        db.prepare(`DELETE FROM ${q(m.table)}`).run();
        db.prepare(`INSERT INTO ${q(m.table)} (${q(m.col)}) VALUES (?)`).run(v);
        rawOut = db.prepare(`SELECT ${q(m.col)} AS v FROM ${q(m.table)}`).pluck().get();
        W.prepare(`DELETE FROM ${q(m.table)}`).run();
        W.prepare(`INSERT INTO ${q(m.table)} (${q(m.col)}) VALUES (?)`).run(v);
        wrapOut = W.prepare(`SELECT ${q(m.col)} AS v FROM ${q(m.table)}`).pluck().get();
      } catch (e) {
        bad++; fail(`money round-trip threw on ${m.table}.${m.col} (${m.cls}) with ${String(v)}: ${e.message}`);
        continue;
      }
      const d = diff(rawOut, wrapOut, `${m.table}.${m.col}`);
      if (d) { bad++; fail(`money round-trip differs: ${d} (value ${String(v)})`); }
      // And the value must survive at all — a silent coercion would be just as
      // bad as a mismatch. Object.is, not ===, because -0 is deliberately in the
      // edge set and SQLite stores it as 0; that one normalisation is expected
      // and is the only value excused here.
      const negZero = Object.is(v, -0);
      const dv = diff(rawOut, negZero ? 0 : v, `${m.table}.${m.col} vs input`);
      if (dv && !negZero) { bad++; fail(`money value not preserved: ${dv}`); }
      done++;
      CHECKS += 2;
    }
  }
  check(bad === 0, `${bad} money round-trip(s) differed`);
  ok(`money sweep: ${moneyCols.length} columns (CENTS + NUM6) × edge values = ${done} round-trips, all identical`);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 5 · the no-converter invariant ══');

check(currentConverter() === null, 'a converter is installed — the live path must have none');
{
  // The claim the whole seam rests on today: with no converter, the wrapped call
  // is the raw call. Drive it across the corpus rather than on one statement.
  let n = 0, bad = 0;
  const stmts = [
    'SELECT * FROM _probe ORDER BY id',
    'SELECT t, r FROM _probe WHERE i BETWEEN 3 AND 12 ORDER BY i',
    'SELECT COUNT(*) AS c, SUM(r) AS s, AVG(r) AS a, MIN(b) AS mn, MAX(b) AS mx FROM _probe',
    'SELECT hex(b) AS h FROM _probe ORDER BY id LIMIT 5',
    "SELECT json_object('t', t, 'r', r) AS j FROM _probe ORDER BY id LIMIT 3",
    'SELECT NULL AS n, 1 AS one, 1.5 AS onefive, \'txt\' AS s',
  ];
  for (const s of stmts) {
    for (const m of ['all', 'get']) {
      const d = diff(db.prepare(s)[m](), W.prepare(s)[m](), `${m}(${s.slice(0, 34)}…)`);
      if (d) { bad++; fail(`no-converter invariant broken: ${d}`); }
      n++; CHECKS++;
    }
  }
  check(bad === 0, `${bad} statement(s) differed with no converter installed`);
  ok(`no-converter invariant holds across ${n} statement executions — wrapped output IS raw output`);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 6 · error parity ══');

{
  const cases = [
    ['syntax error', (h) => h.prepare('SELEKT oops')],
    ['unknown table', (h) => h.prepare('SELECT * FROM no_such_table_here')],
    ['unknown column', (h) => h.prepare('SELECT nope FROM _probe')],
    ['NOT NULL violation', (h) => h.prepare('INSERT INTO _probe (t) VALUES (?)').run(null)],
    ['UNIQUE violation', (h) => h.prepare('INSERT INTO _probe (t, i) VALUES (?, ?)').run('dup', 5)],
    ['too few parameters', (h) => h.prepare('SELECT * FROM _probe WHERE i = ? AND t = ?').all(1)],
    ['unsupported bind type', (h) => h.prepare('SELECT ?').get({ weird: Symbol('x') })],
    ['run() on a reader', (h) => h.prepare('SELECT 1').run()],
    ['get() on a writer', (h) => h.prepare('DELETE FROM _probe WHERE i = -999').get()],
    ['exec() bad sql', (h) => h.exec('NOT SQL AT ALL')],
    ['pragma() bad name', (h) => h.pragma('definitely_not_a_pragma_name(x)')],
  ];
  let bad = 0;
  for (const [label, fn] of cases) {
    let re = null, we = null;
    try { fn(db); } catch (e) { re = e; }
    try { fn(W); } catch (e) { we = e; }
    if (!re && !we) { note(`error-parity case "${label}" threw on neither side — not an error in this build`); continue; }
    if (!!re !== !!we) { bad++; fail(`${label}: raw ${re ? 'threw' : 'did not throw'}, wrapped ${we ? 'threw' : 'did not throw'}`); continue; }
    if (re.constructor.name !== we.constructor.name) { bad++; fail(`${label}: error class ${re.constructor.name} vs ${we.constructor.name}`); continue; }
    if (re.message !== we.message) { bad++; fail(`${label}: message "${re.message}" vs "${we.message}"`); continue; }
    if (re.code !== we.code) { bad++; fail(`${label}: code ${re.code} vs ${we.code}`); continue; }
    CHECKS++;
  }
  check(bad === 0, `${bad} error case(s) differed between raw and wrapped`);
  ok(`error parity: ${cases.length} failure modes raise the same class, message and code through the wrapper`);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 7 · transaction semantics ══');

{
  db.exec('CREATE TABLE _tx (n INTEGER)');
  const countRaw = () => db.prepare('SELECT COUNT(*) AS c FROM _tx').pluck().get();

  const txWrap = W.transaction((vals) => {
    const ins = W.prepare('INSERT INTO _tx (n) VALUES (?)');
    for (const v of vals) ins.run(v);
    return vals.length;
  });
  const n1 = txWrap([1, 2, 3]);
  check(n1 === 3 && countRaw() === 3, `wrapped transaction committed wrongly: returned ${n1}, rows ${countRaw()}`);

  let threw = false;
  const txBad = W.transaction(() => {
    W.prepare('INSERT INTO _tx (n) VALUES (?)').run(99);
    throw new Error('deliberate rollback');
  });
  try { txBad(); } catch (e) { threw = e.message === 'deliberate rollback'; }
  check(threw, 'a throwing wrapped transaction did not propagate its error');
  check(countRaw() === 3, `rollback failed — expected 3 rows, found ${countRaw()}`);

  check(W.inTransaction === false, 'inTransaction should be false outside a transaction');
  let insideWrapped = null, insideRaw = null;
  W.transaction(() => { insideWrapped = W.inTransaction; insideRaw = db.inTransaction; })();
  check(insideWrapped === true && insideRaw === true,
    `inTransaction inside a transaction: wrapped ${insideWrapped}, raw ${insideRaw}`);

  // Statements prepared from the RAW handle inside a WRAPPED transaction, and
  // vice versa — both are the same connection, so both must participate.
  const txMixed = W.transaction(() => { db.prepare('INSERT INTO _tx (n) VALUES (?)').run(7); });
  txMixed();
  check(countRaw() === 4, `a raw statement inside a wrapped transaction did not commit (rows ${countRaw()})`);

  const txNested = W.transaction(() => {
    W.prepare('INSERT INTO _tx (n) VALUES (?)').run(10);
    W.transaction(() => { W.prepare('INSERT INTO _tx (n) VALUES (?)').run(11); })();
  });
  txNested();
  check(countRaw() === 6, `nested wrapped transactions lost rows (rows ${countRaw()})`);
  ok('transactions commit, roll back, nest and report inTransaction identically through the wrapper');
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 8 · iterate semantics ══');

{
  const SQL = 'SELECT * FROM _probe ORDER BY id';
  check(diff([...db.prepare(SQL).iterate()], [...W.prepare(SQL).iterate()], 'iterate-drained') === null,
    'full iteration differs between raw and wrapped');

  // Abandoning an iterator part-way must leave the statement reusable, or a
  // wrapper that held the statement busy would surface as a later throw.
  const it = W.prepare(SQL).iterate();
  it.next(); it.next();
  if (typeof it.return === 'function') it.return();
  let reusable = true;
  try { W.prepare(SQL).all(); } catch (e) { reusable = false; }
  check(reusable, 'the statement was left busy after an abandoned wrapped iteration');

  let rawCount = 0, wrapCount = 0;
  for (const _ of db.prepare(SQL).iterate()) rawCount++;
  for (const _ of W.prepare(SQL).iterate()) wrapCount++;
  check(rawCount === wrapCount, `iterate yielded ${rawCount} rows raw and ${wrapCount} wrapped`);
  ok(`iterate() yields identical rows (${rawCount}) and releases the statement cleanly`);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 9 · the converter seat is really wired ══');
console.log('   A marker converter that converts NOTHING, in a throwaway module instance, so');
console.log('   the intercept set is shown to be real rather than taken on trust. The live');
console.log('   seam module is untouched and still has no converter.');

{
  delete require.cache[require.resolve(DB_SEAM_JS)];
  const fresh = require(DB_SEAM_JS);
  const calls = { bindIn: [], readOut: [] };
  fresh.installConverter({
    bindIn: (sql, params) => { calls.bindIn.push(sql); return params; },
    readOut: (sql, rows) => { calls.readOut.push(sql); return rows; },
  });
  const FW = fresh.seam(db);

  const S = 'SELECT * FROM _probe ORDER BY id LIMIT 2';
  FW.prepare(S).all();
  check(calls.bindIn.includes(S) && calls.readOut.includes(S), 'all() did not route through bindIn and readOut');
  FW.prepare(S).get();
  FW.prepare('INSERT INTO _probe (t, i) VALUES (?, ?)').run('marker', 950);
  check(calls.bindIn.some((s) => s.startsWith('INSERT INTO _probe')), 'run() did not route through bindIn');
  check(!calls.readOut.some((s) => s.startsWith('INSERT INTO _probe')),
    'run() routed through readOut — it returns an info object with no columns and must not');

  // Two independent ways of asking whether exec/pragma stayed out of the seam.
  // The counter alone is not enough: intercepting exec() wraps its RETURN VALUE
  // without invoking the converter, so the counter would not move and a seam that
  // had quietly started intercepting exec would pass. The identity check is what
  // actually detects that, and the mutation test is how the gap was found.
  const beforeExec = calls.bindIn.length + calls.readOut.length;
  const execOut = FW.exec('SELECT 1');
  const pragmaOut = FW.pragma('table_info(_probe)');
  check(calls.bindIn.length + calls.readOut.length === beforeExec,
    'exec() or pragma() routed through the converter — both are permanent pass-throughs by design');
  check(execOut === db,
    'exec() did not return the raw handle — it is being intercepted, and exec is a permanent pass-through');
  check(diff(pragmaOut, db.pragma('table_info(_probe)')) === null,
    'pragma() returned something other than the raw pragma result — it is being intercepted');

  // A real finding, not a defect today: iterate() hands readOut an ITERATOR.
  const beforeIter = calls.readOut.length;
  const itOut = FW.prepare(S).iterate();
  const iterGotIterator = calls.readOut.length > beforeIter &&
    itOut && typeof itOut[Symbol.iterator] === 'function' && typeof itOut.next === 'function';
  if (iterGotIterator) {
    note('iterate() passes readOut an ITERATOR, where get()/all() pass it ROWS. With no converter this is ' +
         'invisible — the iterator is returned untouched. A future converter must therefore handle iterate() ' +
         'as its own case, or wrap the iterator, rather than assuming readOut() always receives an array. ' +
         'Recorded, not changed: altering it now would be a behaviour change to the seam with no converter to justify it.');
  }
  check([...itOut].length === 2, 'iterate() through a converter-installed seam did not yield its rows');

  db.prepare('DELETE FROM _probe WHERE i = 950').run();
  delete require.cache[require.resolve(DB_SEAM_JS)];
  const live = require(DB_SEAM_JS);
  check(live.currentConverter() === null, 'the live seam module was left with a converter installed');
  ok('get/all/run route through the converter seat, exec/pragma never do, and no converter is left behind');
}

// ════════════════════════════════════════════════════════════════════════════
db.close();
fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });

console.log('\n' + '═'.repeat(72));
console.log(`${CHECKS} assertion(s) run against a ${tableCount}-table scratch copy of the live schema.`);
if (NOTES.length) {
  console.log(`\n${NOTES.length} thing(s) recorded, none of them defects:`);
  NOTES.forEach((n, i) => console.log(`  ${i + 1}. ${n}`));
}
if (FAILURES === 0) {
  console.log('\nRESULT: PASS — the seam is behaviour-neutral across the whole better-sqlite3 surface,');
  console.log('        every live column type, and all 101 money columns. Per-file batches may rely');
  console.log('        on this and prove only that their files stay inside the audited envelope.');
  process.exit(0);
}
console.log(`\nRESULT: FAIL — ${FAILURES} check(s) failed.`);
process.exit(1);
