#!/usr/bin/env node
// Static coverage checker for the database seam (lib/db-seam.js).
//
// WHAT IT MEASURES, EXACTLY
// -------------------------
// Every prepared-statement site — a `<handle>.prepare(` call — is a place where a
// money value can cross between the application and the database. The converter
// decided in §24 acts per column at exactly those sites. So coverage is:
//
//     statement sites reached through the seam  /  all statement sites
//
// A site counts as covered only when the handle it is called on was obtained
// through lib/db-seam.js. Everything else is uncovered, and the report says which
// of four ways it was obtained instead, because they are not equally hard to fix:
//
//   SEAM     seam(...) — covered.
//   TENANT   tdb() / getTenantDb() / req.tenantDb — routed through tenant-db.js
//            but not yet through the seam. Cheapest to convert; one module.
//   DIRECT   require('../database') — the raw shared handle, held module-level.
//   RAW_OPEN new Database(...) — opens its own connection, bypassing everything.
//            §24 names these as where the yuan-JSON rule is paid for: the
//            gzgrocery, meituan, eleme and qingyun daemons.
//
// HONEST LIMITS. This is a static reader, not a type checker. It resolves the
// handle for a `.prepare(` call by tracking module-level and local `const/let`
// bindings and the inline call forms; a handle passed as a function parameter or
// stored on an object is attributed by name where the name is unambiguous and
// counted as UNRESOLVED where it is not. UNRESOLVED sites are reported and are
// counted in the denominator — never silently dropped, and never counted as
// covered.
//
// Read-only. Touches no database. Run: node scripts/db-seam-coverage.js

'use strict';

const fs = require('fs');
const path = require('path');

// Flags may appear in any order; the first non-flag argument is the repo root.
// (Taking argv[2] blindly makes `--by-file` the repo path and silently reports
// zero sites for everything.)
const ARGS = process.argv.slice(2);
const BY_FILE = ARGS.includes('--by-file');
const REPO = ARGS.find(a => !a.startsWith('--')) || path.join(__dirname, '..');

// The deployed application, split the way deploy-changed.sh splits it. RUNTIME is
// what serves requests; BACKGROUND is the scripts directory.
const RUNTIME_DIRS = ['routes', 'lib', 'middleware'];
const RUNTIME_FILES = ['server.js', 'database.js'];
const BACKGROUND_DIRS = ['scripts'];

// ── SCOPE — which scripts the seam is responsible for ───────────────────────
//
// THE RULE: a script is IN SCOPE if it can reach the LIVE database on an ongoing,
// unattended basis. That is the criterion because the converter exists to protect
// live money values; a script that cannot reach live data cannot corrupt it, and a
// script that ran once in the past and would have to be edited before it ran again
// is not part of the system's steady state.
//
// Note that "recurring" is NOT the test. scripts/verify-fulfilment-types.js runs on
// every deploy that touches fulfilment, but it builds a throwaway SQLite database in
// the OS temp directory and never opens the live one — so it is out of scope despite
// running constantly.
//
// IN  — the six channel daemons. They run continuously under pm2 and write live
//       order, stock and sync data.
// OUT — one-off backfills, fixups, imports, seeds and diagnostics that a person runs
//       by hand for a specific purpose, and verifiers that only ever touch a temp
//       database.
//
// THE HONEST CAVEAT, recorded rather than buried: ~80 of the excluded scripts open
// the live database by path and would do so again tomorrow if someone ran them
// unedited. Excluding them is a judgement that they will not be run AFTER the
// Postgres cutover, not a claim that they cannot be. If the SQLite file is left in
// place at cutover they will keep working against stale data, silently. Removing or
// renaming data/roots.db at cutover is what actually makes this exclusion safe, and
// that belongs on the cutover checklist rather than in the seam.
const IN_SCOPE_SCRIPTS = new Set([
  'scripts/guanyi-daemon.js',
  'scripts/meituan-daemon.js',
  'scripts/shangou-daemon.js',
  'scripts/gzgrocery-order-daemon.js',
  'scripts/qingyun-daemon.js',
  'scripts/eleme-daemon.js',
]);

const inScope = (rel) => !rel.startsWith('scripts' + path.sep) && !rel.startsWith('scripts/')
  ? true
  : IN_SCOPE_SCRIPTS.has(rel.split(path.sep).join('/'));

// The seam's own verification tooling is excluded, on the same precedent as the
// SKIP set in diagnose_money_unit_mixing.py. These files hold a RAW handle by
// design — the comparison harness has to, since being the un-seamed side of the
// comparison is its whole purpose — so counting them as uncovered would report a
// permanent deficit that must never be closed. Everything excluded is listed in
// the output; nothing is dropped silently.
const SKIP = new Set([
  'scripts/diagnose_store_hours_seam.js',   // the side-by-side harness: raw side is the point
  'scripts/diagnose_seam_batch.js',         // the batch harness: holds a raw handle as the comparison's raw side
  'scripts/db-seam-coverage.js',            // this reader itself
]);

function jsFilesIn(dir) {
  const abs = path.join(REPO, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.isDirectory()) { out.push(...jsFilesIn(path.join(dir, entry.name))); continue; }
    if (entry.name.endsWith('.js')) {
      const rel = path.join(dir, entry.name);
      if (!SKIP.has(rel)) out.push(rel);
    }
  }
  return out.sort();
}

// Strip comments so that prose mentioning `db.prepare(` — tenant-db.js's own
// header does — is never counted as a call site.
//
// String bodies are stripped only for the CALL-SITE pass, where a `.prepare(`
// inside a SQL literal would be a false positive. The BINDING pass needs them
// intact, because `require('../database')` is identified by the path inside the
// quotes: scrubbing it first is what makes every DIRECT site look UNRESOLVED.
// Regex literals must be recognised, not treated as code. `.replace(/^['"]|['"]$/g, '')`
// in scripts/guanyi-daemon.js contains both quote characters; without this the
// scanner entered string mode inside the regex, desynchronised, and swallowed the
// rest of the file — reporting 0 statement sites for a daemon that has 40. A blind
// spot like that does not announce itself, which is why the reconciliation check
// below exists as well.
//
// Regex-vs-division is decided the usual way: a `/` is a regex only where a value
// cannot already have been produced — after an operator, an opening bracket, a
// comma, a semicolon, or a keyword like return/typeof/case.
const REGEX_OK_BEFORE = /[(,=:[!&|?{};+\-*%~^<>]$|\b(return|typeof|case|in|of|do|else|yield|await)$/;

function scrub(src, { strings = true } = {}) {
  let out = '', i = 0;
  const n = src.length;
  const prevSignificant = () => {
    let j = out.length - 1;
    while (j >= 0 && /\s/.test(out[j])) j--;
    return out.slice(0, j + 1);
  };
  // Skip a quoted run starting at `from` (src[from] is the quote). Template
  // literals may contain ${...} whose expression may itself contain strings and
  // FURTHER templates — `${x ? `<div>${y}</div>` : ''}` appears throughout
  // routes/retail.js. Skipping to the next backtick desynchronises there and the
  // scanner then reads HTML as code; that hid 96 statement sites. Brace depth and
  // recursion keep it in step.
  const skipQuoted = (from) => {
    const quote = src[from];
    let k = from + 1;
    while (k < n) {
      const ch = src[k];
      if (ch === '\\') { k += 2; continue; }
      if (ch === quote) return k + 1;
      if (quote !== '`' && ch === '\n') return k;        // unterminated ' or "
      // NOTE — nested templates inside ${...} are NOT tracked. Attempting it made
      // the measurement worse, not better (retail.js fell from 1124 attributed to
      // 476), so this deliberately stops at the next backtick and lets the
      // reconciliation check below report what it could not see. A loud, stated
      // gap beats a clever scanner that is silently wrong.
      k++;
    }
    return k;
  };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { i++; } continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2; continue;
    }
    if (c === '/' && REGEX_OK_BEFORE.test(prevSignificant())) {
      out += ' '; i++;
      let inClass = false;
      while (i < n) {
        const r = src[i];
        if (r === '\\') { i += 2; continue; }
        if (r === '\n') break;
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) { i++; break; }
        i++;
      }
      while (i < n && /[a-z]/.test(src[i])) i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const end = skipQuoted(i);
      if (strings) {
        out += ' ';
        for (let k = i; k < end; k++) if (src[k] === '\n') out += '\n';
      } else {
        out += src.slice(i, end);
      }
      i = end; continue;
    }
    out += c; i++;
  }
  return out;
}

const DB_REQUIRE = /require\(\s*['"][^'"]*\/?database['"]\s*\)/;

// How a name was bound, from its declaration line.
function classifyBinding(rhs) {
  if (/\bseam\s*\(/.test(rhs)) return 'SEAM';
  if (/\bnew\s+Database\s*\(/.test(rhs)) return 'RAW_OPEN';
  if (DB_REQUIRE.test(rhs)) return 'DIRECT';
  if (/\b(?:tdb|getTenantDb)\s*\(/.test(rhs)) return 'TENANT';
  if (/\breq\.tenantDb\b/.test(rhs)) return 'TENANT';
  return null;
}

// Inline receivers — the handle is the call expression itself, with no binding.
function classifyInlineReceiver(receiver) {
  if (/^seam\s*\(/.test(receiver)) return 'SEAM';
  if (/^new\s+Database\s*\(/.test(receiver)) return 'RAW_OPEN';
  if (/^(?:tdb|getTenantDb)\s*\(/.test(receiver)) return 'TENANT';
  if (/^req\.tenantDb$/.test(receiver)) return 'TENANT';
  if (/^(?:this\.)?db$/.test(receiver)) return null;
  return null;
}

function analyseFile(rel) {
  const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
  const bindingCode = scrub(src, { strings: false });   // paths intact
  const code = scrub(src, { strings: true });           // SQL literals removed
  const lines = code.split('\n');

  // Pass 1 — collect name -> category bindings from declarations and assignments.
  const bindings = new Map();
  const DECL = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g;
  const REASSIGN = /^\s*([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/;
  let m;
  while ((m = DECL.exec(bindingCode))) {
    const cat = classifyBinding(m[2]);
    if (cat) bindings.set(m[1], cat);
  }
  for (const line of bindingCode.split('\n')) {
    const r = REASSIGN.exec(line);
    if (!r) continue;
    const cat = classifyBinding(r[2]);
    if (cat && !bindings.has(r[1])) bindings.set(r[1], cat);
  }

  // Pass 2 — every `.prepare(` site, attributed to its receiver.
  const sites = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let idx = -1;
    while ((idx = line.indexOf('.prepare(', idx + 1)) !== -1) {
      const receiver = receiverBefore(line, idx);
      // A receiver we cannot recover is UNRESOLVED, never dropped. Dropping it
      // would quietly shrink the denominator, which is the one number this whole
      // exercise is judged on.
      if (!receiver) { sites.push({ file: rel, line: i + 1, receiver: '<unrecoverable>', category: 'UNRESOLVED' }); continue; }
      let cat = classifyInlineReceiver(receiver);
      if (!cat) {
        const root = receiver.replace(/^this\./, '').match(/^([A-Za-z_$][\w$]*)/);
        if (root && bindings.has(root[1])) cat = bindings.get(root[1]);
      }
      sites.push({ file: rel, line: i + 1, receiver, category: cat || 'UNRESOLVED' });
    }
  }
  // RECONCILIATION. Count `.prepare(` in the comment-stripped source and compare
  // with what was attributed. These must agree; a shortfall means the scanner lost
  // sites somewhere, which is exactly the failure that hid 40 daemon statements
  // behind a regex literal. Reported, not swallowed.
  const naive = (scrub(src, { strings: false }).match(/\.prepare\(/g) || []).length;
  return { sites, naive };
}

// Walk backwards from `.prepare(` to recover the receiver expression, balancing
// brackets so that tdb().prepare( and getTenantDb(id).prepare( resolve whole.
function receiverBefore(line, dotIdx) {
  let i = dotIdx - 1, depth = 0;
  while (i >= 0) {
    const c = line[i];
    if (c === ')' || c === ']') { depth++; i--; continue; }
    if (c === '(' || c === '[') {
      if (depth === 0) break;
      depth--; i--; continue;
    }
    if (depth === 0 && !/[\w$.]/.test(c)) break;
    i--;
  }
  const raw = line.slice(i + 1, dotIdx).trim();
  if (!raw) return null;
  if (/^new\s/.test(line.slice(Math.max(0, i - 4), dotIdx).trim())) return 'new ' + raw;
  return raw;
}

function report(label, files) {
  const analysed = files.map(f => ({ file: f, ...analyseFile(f) }));
  const sites = analysed.flatMap(a => a.sites);
  const gaps = analysed.filter(a => a.naive > a.sites.length);
  const by = {};
  for (const s of sites) by[s.category] = (by[s.category] || 0) + 1;
  const total = sites.length;
  const covered = by.SEAM || 0;
  const pct = total ? (covered * 100) / total : 0;

  console.log(`\n══ ${label} ══`);
  console.log(`  files: ${files.length}   statement sites: ${total}`);
  console.log(`  COVERAGE: ${covered}/${total} = ${pct.toFixed(2)}%  through the seam`);
  for (const cat of ['SEAM', 'TENANT', 'DIRECT', 'RAW_OPEN', 'UNRESOLVED']) {
    if (by[cat]) console.log(`    ${cat.padEnd(11)} ${String(by[cat]).padStart(5)}`);
  }
  if (gaps.length) {
    console.log(`  SCANNER GAPS — sites the reader could not see (denominator would be short):`);
    for (const g of gaps) console.log(`    ${g.file}: attributed ${g.sites.length}, found ${g.naive}`);
  }
  return { covered, total, sites, gaps };
}

const runtimeFiles = [
  ...RUNTIME_DIRS.flatMap(jsFilesIn),
  ...RUNTIME_FILES.filter(f => fs.existsSync(path.join(REPO, f))),
].sort();
const backgroundFiles = BACKGROUND_DIRS.flatMap(jsFilesIn);

console.log('Database seam coverage — statement sites reached through lib/db-seam.js');
console.log('Excluded (the seam\'s own tooling, which holds raw handles by design):');
for (const f of [...SKIP].sort()) console.log('  - ' + f);

const daemonFiles = backgroundFiles.filter(f => inScope(f));
const excludedFiles = backgroundFiles.filter(f => !inScope(f));

const runtime = report('RUNTIME — routes/, lib/, middleware/, server.js, database.js', runtimeFiles);
const daemons = report('DAEMONS — scripts/ that run continuously against live data (IN SCOPE)', daemonFiles);
const excluded = report('EXCLUDED — one-off scripts and temp-database verifiers (OUT OF SCOPE)', excludedFiles);

const covered = runtime.covered + daemons.covered;
const total = runtime.total + daemons.total;
const allCovered = covered + excluded.covered;
const allTotal = total + excluded.total;

console.log(`\n══ HEADLINE ══`);
console.log(`  IN SCOPE  (runtime + daemons):   ${covered}/${total} = ${((covered * 100) / total).toFixed(2)}%`);
console.log(`  Runtime surface only:            ${runtime.covered}/${runtime.total} = ` +
            `${((runtime.covered * 100) / runtime.total).toFixed(2)}%`);
console.log(`  Daemons only:                    ${daemons.covered}/${daemons.total} = ` +
            `${daemons.total ? ((daemons.covered * 100) / daemons.total).toFixed(2) : '0.00'}%`);
console.log(`\n  Both numbers, so the exclusion stays visible rather than flattering the figure:`);
console.log(`    with the excluded scripts counted:    ${allCovered}/${allTotal} = ${((allCovered * 100) / allTotal).toFixed(2)}%`);
console.log(`    without them (the number we track):   ${covered}/${total} = ${((covered * 100) / total).toFixed(2)}%`);
console.log(`    excluded from the denominator:        ${excluded.total} site(s) across ${excludedFiles.length} file(s)`);

console.log('\n  Covered sites:');
for (const s of [...runtime.sites, ...daemons.sites].filter(s => s.category === 'SEAM')) {
  console.log(`    ${s.file}:${s.line}  ${s.receiver}.prepare(`);
}

const unresolved = [...runtime.sites, ...daemons.sites].filter(s => s.category === 'UNRESOLVED');
console.log(`\n  UNRESOLVED receivers (counted in the denominator, never as covered): ${unresolved.length}`);
const byFile = {};
for (const s of unresolved) byFile[s.file] = (byFile[s.file] || 0) + 1;
for (const [f, n] of Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`    ${String(n).padStart(4)}  ${f}`);
}
// ── --by-file ───────────────────────────────────────────────────────────────
// Per-file breakdown, smallest first. This is how the next batch gets chosen:
// a file whose sites are ALL one category, and few, is a clean candidate; a file
// mixing DIRECT with TENANT cannot move until tdb()/getTenantDb() move, and a
// file with UNRESOLVED sites needs its handle-passing read by eye first.
if (BY_FILE) {
  console.log('\n══ BY FILE — candidates for the next batch, smallest first ══');
  const per = new Map();
  for (const s of [...runtime.sites, ...daemons.sites, ...excluded.sites]) {
    if (!per.has(s.file)) per.set(s.file, {});
    const c = per.get(s.file);
    c[s.category] = (c[s.category] || 0) + 1;
  }
  const rows = [...per.entries()].map(([file, c]) => {
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    const cats = Object.keys(c).sort();
    return { file, c, total, cats, pure: cats.length === 1 };
  }).sort((a, b) => a.total - b.total || a.file.localeCompare(b.file));

  const fmt = (r) => `${String(r.total).padStart(4)}  ${r.file.padEnd(46)} ` +
    ['SEAM', 'TENANT', 'DIRECT', 'RAW_OPEN', 'UNRESOLVED']
      .filter(k => r.c[k]).map(k => `${k}:${r.c[k]}`).join(' ');

  console.log('\n  MOVABLE NOW — every site is DIRECT (a module-level shared handle),');
  console.log('  so routing the file means changing how it acquires that one handle:');
  for (const r of rows.filter(r => r.pure && r.cats[0] === 'DIRECT')) console.log('   ' + fmt(r));

  console.log('\n  BLOCKED — mixes DIRECT/RAW_OPEN with TENANT, so it cannot move until');
  console.log('  tdb()/getTenantDb() are routed (their own step, needing a raw accessor):');
  for (const r of rows.filter(r => r.cats.includes('TENANT') && r.cats.length > 1)) console.log('   ' + fmt(r));

  console.log('\n  NEEDS A LOOK — carries UNRESOLVED receivers (a handle arriving as a');
  console.log('  parameter), so what it is called with must be read before it moves:');
  for (const r of rows.filter(r => r.c.UNRESOLVED)) console.log('   ' + fmt(r));
}

console.log('');
