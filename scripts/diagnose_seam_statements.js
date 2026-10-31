#!/usr/bin/env node
/**
 * diagnose_seam_statements.js — execute EVERY statement in a file, raw and
 * wrapped, and require the two to agree.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE SAMPLED HARNESS
 * ---------------------------------------------------
 * scripts/diagnose_seam_batch.js drives a module's exported reads. That samples:
 * statements behind an HTTP handler are never reached, and the ones that are
 * reached are whichever the exported functions happen to run. For a file that
 * touches MONEY columns that is not good enough — the converter will act on those
 * columns, and a statement nobody executed is a statement nobody checked.
 *
 * So for money-touching files, every statement is executed. Not a sample.
 *
 * TIED TO SOURCE BY CONSTRUCTION, NOT BY COPY
 * -------------------------------------------
 * The previous round held VERBATIM copies of the SQL in the harness and asserted
 * the copy still appeared in the source. That works, and it rots: the copy has to
 * be maintained. This EXTRACTS the SQL from the source file at run time, so it
 * cannot drift from what the file actually contains, and a statement added
 * tomorrow is picked up without anyone remembering to add it here.
 *
 * AGAINST A SCRATCH DATABASE, SO WRITES ARE REAL
 * ----------------------------------------------
 * The schema is built from the live census in scripts/postgres-full-copy/plan.json,
 * the same source the mechanism proof uses. That means INSERTs and UPDATEs can
 * actually run and be compared, which a read-only connection to live data cannot
 * do — there, every writer would collapse into "both sides threw". Nothing live is
 * opened and nothing live is written.
 *
 * Raw and wrapped get IDENTICAL bindings and each runs inside a transaction that
 * is rolled back, so the two see the same starting state and neither leaves a
 * trace. Money parameters are bound with real money values.
 *
 * Run: node scripts/diagnose_seam_statements.js <file> [<file> ...]
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const LIVE_APP = '/root/roots-v2';
const firstExisting = (c) => c.find((x) => fs.existsSync(x)) || null;
const PLAN_JSON = firstExisting([
  path.join(HOME, 'scripts', 'postgres-full-copy', 'plan.json'),
  path.join(LIVE_APP, 'scripts', 'postgres-full-copy', 'plan.json'),
]);
const DB_SEAM_JS = path.join(HOME, 'lib', 'db-seam.js');
const Database = (() => {
  try { return require(path.join(HOME, 'node_modules', 'better-sqlite3')); }
  catch (e) { return require('better-sqlite3'); }
})();
const { seam } = require(DB_SEAM_JS);

const VERBOSE = process.env.SEAM_MONEY_DETAIL === '1';
const MONEY_DETAIL = [];
let FAILURES = 0, CHECKS = 0;
const fail = (m) => { FAILURES++; console.log('   FAIL  ' + m); };
const ok = (m) => { CHECKS++; console.log('   ok    ' + m); };

function diff(a, b, p = '') {
  if (Object.is(a, b)) return null;
  if (typeof a !== typeof b) return `${p}: type ${typeof a} vs ${typeof b}`;
  if (a === null || b === null) return `${p}: ${a} vs ${b}`;
  if (typeof a !== 'object') return `${p}: ${String(a)} vs ${String(b)}`;
  if (Buffer.isBuffer(a) || Buffer.isBuffer(b)) return Buffer.compare(a, b) === 0 ? null : `${p}: bytes differ`;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return `${p}: ${ka.length} keys vs ${kb.length}`;
  for (const k of ka) { const d = diff(a[k], b[k], `${p}.${k}`); if (d) return d; }
  return null;
}

const qi = (id) => '"' + String(id).replace(/"/g, '""') + '"';

// ── scratch schema from the live census ─────────────────────────────────────
const plan = JSON.parse(fs.readFileSync(PLAN_JSON, 'utf8'));
const SCRATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'seam-stmt-'));
if (path.resolve(SCRATCH_DIR).startsWith(path.resolve(path.join(HOME, 'data')))) {
  console.error('FATAL: scratch path is inside the live data directory'); process.exit(2);
}
const db = new Database(path.join(SCRATCH_DIR, 'scratch.db'));
db.pragma('journal_mode = MEMORY');
db.pragma('foreign_keys = OFF');

const moneyCols = new Set();
let nTables = 0, nCons = 0;

// plan.json also carries the PRIMARY KEY and UNIQUE constraints, under their
// POSTGRES names. Without them an `INSERT … ON CONFLICT(col)` cannot even be
// prepared — SQLite requires a matching unique index — so three statements across
// push.js and markets.js were unverifiable until these were built. Translating
// them back to the SQLite names makes the scratch schema faithful enough to
// prepare the statements the application actually runs.
const pgToSq = new Map();                       // pg table -> [sq table, colmap]
for (const [t, tv] of Object.entries(plan.tables)) {
  const colmap = new Map();
  for (const c of tv.cols) if (c.pg && c.sq) colmap.set(c.pg, c.sq);
  if (tv.pg) pgToSq.set(tv.pg, [t, colmap]);
}
// The census records CONSTRAINTS but not INDEXES, and `ON CONFLICT(col)` needs a
// matching unique index either way. The as-built Postgres dump does record them —
// it is pg_dump output — so unique indexes are read from there and translated back
// to SQLite names. Without this, routes/push.js could not be verified at all: its
// ON CONFLICT(endpoint) relies on a CREATE UNIQUE INDEX, not a constraint.
const AS_BUILT = firstExisting([
  path.join(HOME, 'docs', 'tacet-postgres-schema-as-built-2026-08-04.sql'),
  path.join(LIVE_APP, 'docs', 'tacet-postgres-schema-as-built-2026-08-04.sql'),
]);
const pgUniqueIndexes = [];                     // {pgTable, pgCols[]}
if (AS_BUILT) {
  const dump = fs.readFileSync(AS_BUILT, 'utf8');
  const re = /CREATE UNIQUE INDEX \w+ ON public\.(\w+) USING btree \(([^)]*)\)/g;
  let mm;
  while ((mm = re.exec(dump)) !== null) {
    pgUniqueIndexes.push({ pgTable: mm[1], pgCols: mm[2].split(',').map((c) => c.trim().replace(/^"|"$/g, '')) });
  }
}

function constraintsFor(sqTable) {
  const out = [];
  for (const con of plan.cons || []) {
    const mapped = pgToSq.get(con.table);
    if (!mapped || mapped[0] !== sqTable) continue;
    if (con.type !== 'p' && con.type !== 'u') continue;
    const m = /\(([^)]*)\)/.exec(con.def || '');
    if (!m) continue;
    const cols = m[1].split(',').map((x) => x.trim().replace(/^"|"$/g, ''));
    const sqCols = cols.map((c) => mapped[1].get(c) || c);
    out.push(`${con.type === 'p' ? 'PRIMARY KEY' : 'UNIQUE'} (${sqCols.map(qi).join(', ')})`);
  }
  // Unique INDEXES from the as-built dump, expressed as UNIQUE constraints here —
  // for ON CONFLICT resolution the two are interchangeable.
  const mapped = [...pgToSq.entries()].find(([, v]) => v[0] === sqTable);
  if (mapped) {
    const [pgName, [, colmap]] = mapped;
    const seen = new Set(out.map((o) => o.replace(/^(PRIMARY KEY|UNIQUE)\s*/, '')));
    for (const idx of pgUniqueIndexes) {
      if (idx.pgTable !== pgName) continue;
      const sqCols = idx.pgCols.map((c) => colmap.get(c) || c);
      const clause = `(${sqCols.map(qi).join(', ')})`;
      if (!seen.has(clause)) { out.push(`UNIQUE ${clause}`); seen.add(clause); }
    }
  }
  return out;
}

for (const [t, tv] of Object.entries(plan.tables)) {
  const cols = tv.cols.filter((c) => c.sq);
  if (!cols.length) continue;
  const defs = cols.map((c) => `${qi(c.sq)} ${c.sqtype || ''}`.trim());
  const cons = constraintsFor(t);
  nCons += cons.length;
  try {
    db.exec(`CREATE TABLE ${qi(t)} (${defs.concat(cons).join(', ')})`);
  } catch (e) {
    // A constraint that will not build is reported, not dropped quietly.
    fail(`scratch schema: ${t} would not build with its constraints (${e.message.slice(0, 60)})`);
    db.exec(`CREATE TABLE ${qi(t)} (${defs.join(', ')})`);
  }
  nTables++;
  for (const c of cols) if (c.cls === 'CENTS' || c.cls === 'NUM6') moneyCols.add(`${t}.${c.sq}`);
}
// One seed row per table, with money columns carrying real money values so a
// statement that reads them is reading something a converter would have to act on.
// Row-varying so three seed rows cannot collide on a PRIMARY KEY or UNIQUE now
// that those exist. The money values stay exact and distinct — they are what the
// round-trip is measuring, so they must not be perturbed to dodge a constraint.
const MONEY_SEED = { CENTS: [12345.67, 0.01, 99999999.99], NUM6: [1.234567, -1.234567, 0.000001] };
const seedFor = (c, r) => {
  if (c.cls === 'CENTS') return MONEY_SEED.CENTS[r];
  if (c.cls === 'NUM6') return MONEY_SEED.NUM6[r];
  if (c.cls === 'INT') return r + 1;
  if (c.cls === 'BOOL') return r % 2;
  if (c.cls === 'REAL') return 1.5 + r;
  if (c.cls === 'TS') return `2026-08-0${5 + r} 01:00:00`;
  if (c.cls === 'DATE') return `2026-08-0${5 + r}`;
  return 'seed' + r;
};
for (const [t, tv] of Object.entries(plan.tables)) {
  const cols = tv.cols.filter((c) => c.sq);
  if (!cols.length) continue;
  const st = db.prepare(`INSERT INTO ${qi(t)} (${cols.map((c) => qi(c.sq)).join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  for (let r = 0; r < 3; r++) {
    try { st.run(...cols.map((c) => (c.sq === 'id' || c.sq.endsWith('_id') ? r + 1 : seedFor(c, r)))); }
    catch (e) { if (r === 0) fail(`scratch seed: ${t} row 0 would not insert (${e.message.slice(0, 70)})`); }
  }
}
const W = seam(db);

// ── extract every prepare() SQL from a source file ──────────────────────────
// Static literals only. A dynamically built statement is REPORTED as unexecuted
// rather than skipped silently — the whole point is that nothing goes unchecked
// without saying so.
function extractStatements(rel) {
  const src = fs.readFileSync(path.join(HOME, rel), 'utf8');
  const out = [];
  let dynamic = 0;
  const re = /\.\s*prepare\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length;
    while (i < src.length && /\s/.test(src[i])) i++;
    const q = src[i];
    if (q !== '`' && q !== "'" && q !== '"') { dynamic++; continue; }
    let j = i + 1, buf = '';
    let interpolated = false;
    while (j < src.length) {
      if (src[j] === '\\') { buf += src[j + 1]; j += 2; continue; }
      if (q === '`' && src[j] === '$' && src[j + 1] === '{') { interpolated = true; }
      if (src[j] === q) break;
      buf += src[j]; j++;
    }
    if (interpolated) { dynamic++; continue; }
    // SQL built by CONCATENATION is dynamic too. Taking only the first literal
    // yields a truncated statement that fails to prepare and reads as a defect in
    // the file — which is exactly how routes/admin.js:238 was first reported.
    let k = j + 1;
    while (k < src.length && /\s/.test(src[k])) k++;
    if (src[k] === '+') { dynamic++; continue; }
    const line = src.slice(0, m.index).split('\n').length;
    // VERBATIM for prepare(); collapsed only for display. Collapsing newlines
    // turns a `--` line comment into one that swallows the rest of the statement,
    // which reports "incomplete input" and reads as a defect in the application.
    out.push({ sql: buf, disp: buf.replace(/\s+/g, ' ').trim(), line });
  }
  return { statements: out, dynamic };
}

// Bindings: identical on both sides, so any difference is the seam's. Money-ish
// floats are included so money parameters travel as money.
const BINDS = [1, 12345.67, 'seed', 1.234567, 2, 'x', 0.01, 3];
function bindingsFor(sql) {
  const n = (sql.match(/\?/g) || []).length;
  const named = [...new Set((sql.match(/[@:$][A-Za-z_][\w]*/g) || []).map((s) => s.slice(1)))];
  if (named.length) {
    const o = {};
    named.forEach((k, i) => { o[k] = BINDS[i % BINDS.length]; });
    return [o];
  }
  return Array.from({ length: n }, (_, i) => BINDS[i % BINDS.length]);
}

function runBoth(sql, params) {
  const attempt = (handle) => {
    const tx = db.transaction(() => {
      const st = handle.prepare(sql);
      const res = st.reader ? st.all(...params) : st.run(...params);
      throw { __rollback: true, res };          // always roll back; keep the result
    });
    try { tx(); } catch (e) {
      if (e && e.__rollback) return { value: e.res };
      return { error: e };
    }
    return { value: undefined };
  };
  return { raw: attempt(db), wrapped: attempt(W) };
}

const files = process.argv.slice(2);
console.log('every-statement execution, raw vs wrapped');
console.log(`   scratch schema: ${nTables} tables, ${nCons} PK/UNIQUE constraint(s) and unique index(es), ${moneyCols.size} money columns`);
console.log(`   sources: plan.json census + ${pgUniqueIndexes.length} unique index(es) from the as-built Postgres dump`);
console.log(`   ${files.length} file(s)\n`);

let totalStmts = 0, totalDynamic = 0, totalMoney = 0;
for (const rel of files) {
  const { statements, dynamic } = extractStatements(rel);
  totalStmts += statements.length; totalDynamic += dynamic;
  console.log(`   ${rel} — ${statements.length} statement(s) extracted from source` +
              (dynamic ? `, ${dynamic} dynamically built and NOT executed` : ''));
  let bad = 0, money = 0, raw0 = null;
  for (const s of statements) {
    let rawSt, wrapSt;
    try { rawSt = db.prepare(s.sql); wrapSt = W.prepare(s.sql); }
    catch (e) {
      fail(`${rel}:${s.line} did not prepare against the live schema: ${e.message.slice(0, 90)}`);
      bad++; continue;
    }
    // Shape parity before execution parity.
    if (diff(rawSt.source, wrapSt.source)) { fail(`${rel}:${s.line} .source differs`); bad++; }
    if (!Object.is(rawSt.reader, wrapSt.reader)) { fail(`${rel}:${s.line} .reader differs`); bad++; }
    if (rawSt.reader) {
      const d = diff(rawSt.columns(), wrapSt.columns(), `${rel}:${s.line}.columns()`);
      if (d) { fail(d); bad++; }
      // Does this statement touch a money column? Reported per file so the money
      // claim is a measured number rather than an assertion about the file.
      const cols = rawSt.columns();
      const hit = cols.filter((c) => c.table && c.column && moneyCols.has(`${c.table}.${c.column}`));
      if (hit.length) {
        money++;
        if (VERBOSE) {
          const names = [...new Set(hit.map((c) => `${c.table}.${c.column}`))];
          const vals = [...new Set(hit.map((c) => JSON.stringify((raw0 && raw0[0]) ? raw0[0][c.name] : undefined)))];
          MONEY_DETAIL.push({ file: rel, line: s.line, kind: 'read', cols: names, vals });
        }
      }
    } else if (/\b(?:INSERT|UPDATE)\b/i.test(s.sql)) {
      const tbl = (/(?:INTO|UPDATE)\s+([A-Za-z_][\w]*)/i.exec(s.sql) || [])[1];
      const colList = (/\(([^)]*)\)\s*VALUES/i.exec(s.sql) || [])[1];
      const written = (tbl && colList)
        ? colList.split(',').map((c) => c.trim()).filter((c) => moneyCols.has(`${tbl}.${c}`))
        : [];
      if (written.length) {
        money++;
        if (VERBOSE) MONEY_DETAIL.push({ file: rel, line: s.line, kind: 'write', cols: written.map((c) => `${tbl}.${c}`), vals: [] });
      }
    }
    const { raw, wrapped } = runBoth(s.sql, bindingsFor(s.sql));
    raw0 = raw && raw.value;
    if (!!raw.error !== !!wrapped.error) {
      fail(`${rel}:${s.line} one side threw and the other did not: raw=${raw.error && raw.error.message} wrapped=${wrapped.error && wrapped.error.message}`);
      bad++; continue;
    }
    if (raw.error) {
      if (raw.error.message !== wrapped.error.message) { fail(`${rel}:${s.line} error text differs`); bad++; }
      CHECKS++; continue;
    }
    const d = diff(raw.value, wrapped.value, `${rel}:${s.line}`);
    if (d) { fail(`execution differs: ${d}`); bad++; } else CHECKS++;
  }
  totalMoney += money;
  if (bad === 0) ok(`${rel}: all ${statements.length} statement(s) identical raw and wrapped (${money} touch money columns)`);
  if (dynamic) {
    console.log(`         NOT EXECUTED: ${dynamic} dynamically built statement(s) in ${rel}.`);
    console.log('         Reported rather than skipped quietly — they are outside what this can reach.');
  }
}

db.close();
fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });

if (VERBOSE && MONEY_DETAIL.length) {
  console.log('\n   money detail — every statement that touches a CENTS or NUM6 column:');
  for (const d of MONEY_DETAIL) {
    console.log(`      ${d.file}:${d.line}  ${d.kind}  ${d.cols.join(', ')}`);
    if (d.vals.length && d.vals[0] !== undefined) console.log(`         round-tripped: ${d.vals.join(', ')}`);
  }
}

console.log('\n' + '═'.repeat(72));
console.log(`${totalStmts} statement(s) executed raw and wrapped across ${files.length} file(s); ` +
            `${totalMoney} touch money columns; ${totalDynamic} dynamic and not executed.`);
console.log(`${CHECKS} assertion(s).`);
if (FAILURES === 0) { console.log('RESULT: PASS'); process.exit(0); }
console.log(`RESULT: FAIL — ${FAILURES} check(s) failed.`);
process.exit(1);
