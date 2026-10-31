#!/usr/bin/env node
/**
 * diagnose_statement_sweep.js — prepare EVERY statement in the whole in-scope
 * application against the live schema, and report everything that will not.
 *
 * WHY
 * ---
 * Three defects were found as a SIDE EFFECT of routing three seam batches: a
 * `settings` table that exists nowhere, `sqlite_sequence` resets that Postgres
 * cannot honour, and a `created_at` column that is really `recorded_at`. Each was
 * invisible to the running application because each sits behind a `catch` or
 * inside a tool handler. None would ever have been found by using the product.
 *
 * Finding them incidentally three times is a signal that the sweep should be run
 * deliberately. This is that sweep.
 *
 * PREPARE ONLY. NOTHING IS EXECUTED.
 * ----------------------------------
 * `prepare()` compiles a statement and resolves every table and column it names,
 * which is the entire question being asked, and it runs no SQL. Nothing in this
 * file executes, so nothing can write. The scratch database is built from the
 * census in a temp directory and the live database is never opened.
 *
 * TWO GROUPS, BECAUSE THEY ARE DIFFERENT PROBLEMS
 * -----------------------------------------------
 *   FAILING TODAY      the statement cannot compile against the schema the
 *                      application is running on right now. It is throwing in
 *                      production every time its code path is reached.
 *   FAILS AT CUTOVER   it compiles against SQLite and uses a construct Postgres
 *                      does not have. It works today and stops working the moment
 *                      the application moves.
 *
 * `sqlite_sequence` is deliberately materialised in the scratch database, so those
 * statements land in the SECOND group where they belong rather than being reported
 * as broken today — they are not.
 *
 * Run: node scripts/diagnose_statement_sweep.js
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
const AS_BUILT = firstExisting([
  path.join(HOME, 'docs', 'tacet-postgres-schema-as-built-2026-08-04.sql'),
  path.join(LIVE_APP, 'docs', 'tacet-postgres-schema-as-built-2026-08-04.sql'),
]);
const Database = (() => {
  try { return require(path.join(HOME, 'node_modules', 'better-sqlite3')); }
  catch (e) { return require('better-sqlite3'); }
})();

const qi = (id) => '"' + String(id).replace(/"/g, '""') + '"';
const plan = JSON.parse(fs.readFileSync(PLAN_JSON, 'utf8'));

// ── scratch schema ──────────────────────────────────────────────────────────
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stmt-sweep-'));
const db = new Database(path.join(DIR, 's.db'));

const pgToSq = new Map();
for (const [t, tv] of Object.entries(plan.tables)) {
  const cm = new Map();
  for (const c of tv.cols) if (c.pg && c.sq) cm.set(c.pg, c.sq);
  if (tv.pg) pgToSq.set(tv.pg, [t, cm]);
}
const pgUniq = [];
if (AS_BUILT) {
  const dump = fs.readFileSync(AS_BUILT, 'utf8');
  const re = /CREATE UNIQUE INDEX \w+ ON public\.(\w+) USING btree \(([^)]*)\)/g;
  let m;
  while ((m = re.exec(dump)) !== null) pgUniq.push({ t: m[1], cols: m[2].split(',').map((c) => c.trim().replace(/^"|"$/g, '')) });
}
function consFor(sq) {
  const out = [], seen = new Set();
  for (const con of plan.cons || []) {
    const mp = pgToSq.get(con.table);
    if (!mp || mp[0] !== sq || (con.type !== 'p' && con.type !== 'u')) continue;
    const m = /\(([^)]*)\)/.exec(con.def || ''); if (!m) continue;
    const cl = `(${m[1].split(',').map((c) => qi(mp[1].get(c.trim().replace(/^"|"$/g, '')) || c.trim().replace(/^"|"$/g, ''))).join(', ')})`;
    if (!seen.has(cl)) { out.push(`${con.type === 'p' ? 'PRIMARY KEY' : 'UNIQUE'} ${cl}`); seen.add(cl); }
  }
  const mp = [...pgToSq.entries()].find(([, v]) => v[0] === sq);
  if (mp) for (const ix of pgUniq) {
    if (ix.t !== mp[0]) continue;
    const cl = `(${ix.cols.map((c) => qi(mp[1][1].get(c) || c)).join(', ')})`;
    if (!seen.has(cl)) { out.push(`UNIQUE ${cl}`); seen.add(cl); }
  }
  return out;
}
let nT = 0;
for (const [t, tv] of Object.entries(plan.tables)) {
  const cols = tv.cols.filter((c) => c.sq); if (!cols.length) continue;
  const defs = cols.map((c) => `${qi(c.sq)} ${c.sqtype || ''}`.trim()).concat(consFor(t));
  try { db.exec(`CREATE TABLE ${qi(t)} (${defs.join(', ')})`); nT++; }
  catch (e) { try { db.exec(`CREATE TABLE ${qi(t)} (${cols.map((c) => `${qi(c.sq)} ${c.sqtype || ''}`.trim()).join(', ')})`); nT++; } catch (e2) { /* reported by absence */ } }
}
// Materialise sqlite_sequence. Without an AUTOINCREMENT table SQLite does not
// create it, and the statements that reference it would be reported as broken
// today when in fact they work today and only break at cutover.
db.exec('CREATE TABLE __seq_anchor (id INTEGER PRIMARY KEY AUTOINCREMENT, x TEXT)');
db.prepare('INSERT INTO __seq_anchor (x) VALUES (?)').run('a');

// ── in-scope files ──────────────────────────────────────────────────────────
const DAEMONS = ['guanyi-daemon.js', 'meituan-daemon.js', 'shangou-daemon.js',
  'gzgrocery-order-daemon.js', 'qingyun-daemon.js', 'eleme-daemon.js'];
const files = [];
(function walk(rel) {
  let es; try { es = fs.readdirSync(path.join(HOME, rel), { withFileTypes: true }); } catch (e) { return; }
  for (const e of es) {
    const ch = rel ? `${rel}/${e.name}` : e.name;
    let d = e.isDirectory(), f = e.isFile();
    if (e.isSymbolicLink()) { try { const st = fs.statSync(path.join(HOME, ch)); d = st.isDirectory(); f = st.isFile(); } catch (err) { continue; } }
    if (d) walk(ch); else if (f && e.name.endsWith('.js')) files.push(ch);
  }
})('routes');
['lib', 'middleware'].forEach((r) => (function w(rel) {
  let es; try { es = fs.readdirSync(path.join(HOME, rel), { withFileTypes: true }); } catch (e) { return; }
  for (const e of es) { const ch = `${rel}/${e.name}`; if (e.isDirectory()) w(ch); else if (e.isFile() && e.name.endsWith('.js')) files.push(ch); }
})(r));
for (const f of ['server.js', 'database.js']) if (fs.existsSync(path.join(HOME, f))) files.push(f);
for (const d of DAEMONS) if (fs.existsSync(path.join(HOME, 'scripts', d))) files.push(`scripts/${d}`);

// ── extraction (static literals only) ───────────────────────────────────────
function extract(rel) {
  const src = fs.readFileSync(path.join(HOME, rel), 'utf8');
  const out = []; let dyn = 0;
  const re = /\.\s*prepare\s*\(/g; let m;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length;
    while (i < src.length && /\s/.test(src[i])) i++;
    const q = src[i];
    if (q !== '`' && q !== "'" && q !== '"') { dyn++; continue; }
    let j = i + 1, buf = '', interp = false;
    while (j < src.length) {
      if (src[j] === '\\') { buf += src[j + 1]; j += 2; continue; }
      if (q === '`' && src[j] === '$' && src[j + 1] === '{') interp = true;
      if (src[j] === q) break;
      buf += src[j]; j++;
    }
    if (interp) { dyn++; continue; }
    let k = j + 1; while (k < src.length && /\s/.test(src[k])) k++;
    if (src[k] === '+') { dyn++; continue; }
    // Keep the SQL VERBATIM for prepare(). Collapsing newlines turns a `--` line
    // comment into one that swallows the rest of the statement, which reports
    // "incomplete input" and reads as a defect in the application. Six statements
    // in routes/retail.js and qingyun-daemon.js were misreported exactly that way.
    // The collapsed form is for DISPLAY only.
    out.push({ sql: buf, disp: buf.replace(/\s+/g, ' ').trim(), line: src.slice(0, m.index).split('\n').length });
  }
  return { stmts: out, dyn };
}

// Constructs Postgres does not have. Each one ERRORS there — this is not a list
// of things that merely behave differently.
const PG_INCOMPATIBLE = [
  [/\bsqlite_sequence\b/i, 'sqlite_sequence is a SQLite internal table; Postgres resets identity with setval()'],
  [/\bsqlite_master\b/i, 'sqlite_master is SQLite-only; Postgres uses information_schema / pg_catalog'],
  [/\bINSERT\s+OR\s+(IGNORE|REPLACE|ABORT|FAIL|ROLLBACK)\b/i, 'INSERT OR <action> is SQLite-only; Postgres uses ON CONFLICT'],
  [/\bIFNULL\s*\(/i, 'IFNULL() is SQLite-only; Postgres uses COALESCE()'],
  [/\bGROUP_CONCAT\s*\(/i, 'GROUP_CONCAT() is SQLite-only; Postgres uses string_agg()'],
  [/\bstrftime\s*\(/i, 'strftime() is SQLite-only; Postgres uses to_char() / date_trunc()'],
  [/\bjulianday\s*\(/i, 'julianday() is SQLite-only'],
  [/\bprintf\s*\(/i, 'printf() is SQLite-only; Postgres uses format()'],
  [/\bINSTR\s*\(/i, 'INSTR() is SQLite-only; Postgres uses strpos()'],
  [/\bRANDOM\s*\(\s*\)/i, 'RANDOM() is SQLite; Postgres spells it random()'],
  [/\btypeof\s*\(/i, 'typeof() is SQLite-only'],
  [/\bPRAGMA\b/i, 'PRAGMA is SQLite-only'],
];

const failToday = [], failCutover = [];
let total = 0, totalDyn = 0;
for (const rel of files) {
  const { stmts, dyn } = extract(rel);
  totalDyn += dyn;
  for (const s of stmts) {
    total++;
    try { db.prepare(s.sql); }
    catch (e) { failToday.push({ rel, line: s.line, sql: s.disp, why: e.message }); continue; }
    for (const [re, why] of PG_INCOMPATIBLE) {
      if (re.test(s.disp)) { failCutover.push({ rel, line: s.line, sql: s.disp, why }); break; }
    }
  }
}

db.close();
fs.rmSync(DIR, { recursive: true, force: true });

const show = (r) => {
  console.log(`   ${r.rel}:${r.line}`);
  console.log(`      ${r.sql.slice(0, 150)}${r.sql.length > 150 ? ' …' : ''}`);
  console.log(`      → ${r.why}`);
};

console.log('statement-preparation sweep — prepare only, nothing executed');
console.log(`   scratch schema: ${nT} tables from the live census + unique indexes from the as-built dump`);
console.log(`   ${files.length} in-scope file(s), ${total} static statement(s) prepared, ${totalDyn} dynamic and unreachable by this method`);

console.log(`\n══ FAILING TODAY — cannot compile against the schema now in production (${failToday.length}) ══`);
if (!failToday.length) console.log('   none'); else failToday.forEach(show);

console.log(`\n══ FAILS AT CUTOVER — compiles on SQLite, errors on Postgres (${failCutover.length}) ══`);
if (!failCutover.length) console.log('   none'); else failCutover.forEach(show);

console.log('\n' + '═'.repeat(72));
console.log(`${failToday.length} failing today, ${failCutover.length} failing at cutover, out of ${total} statements.`);
console.log(`${totalDyn} statements are built dynamically and cannot be reached this way — a known blind spot, stated rather than hidden.`);
process.exit(0);
