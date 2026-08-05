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
let nTables = 0;
for (const [t, tv] of Object.entries(plan.tables)) {
  const cols = tv.cols.filter((c) => c.sq);
  if (!cols.length) continue;
  db.exec(`CREATE TABLE ${qi(t)} (${cols.map((c) => `${qi(c.sq)} ${c.sqtype || ''}`.trim()).join(', ')})`);
  nTables++;
  for (const c of cols) if (c.cls === 'CENTS' || c.cls === 'NUM6') moneyCols.add(`${t}.${c.sq}`);
}
// One seed row per table, with money columns carrying real money values so a
// statement that reads them is reading something a converter would have to act on.
const seedFor = (c) => {
  if (c.cls === 'CENTS') return 12345.67;
  if (c.cls === 'NUM6') return 1.234567;
  if (c.cls === 'INT') return 1;
  if (c.cls === 'BOOL') return 1;
  if (c.cls === 'REAL') return 1.5;
  if (c.cls === 'TS') return '2026-08-05 01:00:00';
  if (c.cls === 'DATE') return '2026-08-05';
  return 'seed';
};
for (const [t, tv] of Object.entries(plan.tables)) {
  const cols = tv.cols.filter((c) => c.sq);
  if (!cols.length) continue;
  const st = db.prepare(`INSERT INTO ${qi(t)} (${cols.map((c) => qi(c.sq)).join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  for (let r = 0; r < 3; r++) st.run(...cols.map((c) => (c.sq === 'id' || c.sq.endsWith('_id') ? r + 1 : seedFor(c))));
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
    const line = src.slice(0, m.index).split('\n').length;
    out.push({ sql: buf.replace(/\s+/g, ' ').trim(), line });
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
console.log(`   scratch schema: ${nTables} tables from the live census, ${moneyCols.size} money columns`);
console.log(`   ${files.length} file(s)\n`);

let totalStmts = 0, totalDynamic = 0, totalMoney = 0;
for (const rel of files) {
  const { statements, dynamic } = extractStatements(rel);
  totalStmts += statements.length; totalDynamic += dynamic;
  console.log(`   ${rel} — ${statements.length} statement(s) extracted from source` +
              (dynamic ? `, ${dynamic} dynamically built and NOT executed` : ''));
  let bad = 0, money = 0;
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
      if (cols.some((c) => c.table && c.column && moneyCols.has(`${c.table}.${c.column}`))) money++;
    } else if (/\b(?:INSERT|UPDATE)\b/i.test(s.sql)) {
      const tbl = (/(?:INTO|UPDATE)\s+([A-Za-z_][\w]*)/i.exec(s.sql) || [])[1];
      const colList = (/\(([^)]*)\)\s*VALUES/i.exec(s.sql) || [])[1];
      if (tbl && colList && colList.split(',').some((c) => moneyCols.has(`${tbl}.${c.trim()}`))) money++;
    }
    const { raw, wrapped } = runBoth(s.sql, bindingsFor(s.sql));
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

console.log('\n' + '═'.repeat(72));
console.log(`${totalStmts} statement(s) executed raw and wrapped across ${files.length} file(s); ` +
            `${totalMoney} touch money columns; ${totalDynamic} dynamic and not executed.`);
console.log(`${CHECKS} assertion(s).`);
if (FAILURES === 0) { console.log('RESULT: PASS'); process.exit(0); }
console.log(`RESULT: FAIL — ${FAILURES} check(s) failed.`);
process.exit(1);
