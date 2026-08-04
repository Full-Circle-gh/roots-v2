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
// what serves requests; BACKGROUND is the daemons and the one-off scripts.
const RUNTIME_DIRS = ['routes', 'lib', 'middleware'];
const RUNTIME_FILES = ['server.js', 'database.js'];
const BACKGROUND_DIRS = ['scripts'];

// The seam's own verification tooling is excluded, on the same precedent as the
// SKIP set in diagnose_money_unit_mixing.py. These files hold a RAW handle by
// design — the comparison harness has to, since being the un-seamed side of the
// comparison is its whole purpose — so counting them as uncovered would report a
// permanent deficit that must never be closed. Everything excluded is listed in
// the output; nothing is dropped silently.
const SKIP = new Set([
  'scripts/diagnose_store_hours_seam.js',   // the side-by-side harness: raw side is the point
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
function scrub(src, { strings = true } = {}) {
  let out = '', i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { i++; } continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      if (!strings) { out += c; i++; }
      else { out += ' '; i++; }
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') { if (!strings) out += src.slice(i, i + 2); i += 2; continue; }
        if (src[i] === '\n') out += '\n';
        else if (!strings) out += src[i];
        i++;
      }
      if (!strings && i < n) out += quote;
      i++; continue;
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
      if (!receiver) continue;
      let cat = classifyInlineReceiver(receiver);
      if (!cat) {
        const root = receiver.replace(/^this\./, '').match(/^([A-Za-z_$][\w$]*)/);
        if (root && bindings.has(root[1])) cat = bindings.get(root[1]);
      }
      sites.push({ file: rel, line: i + 1, receiver, category: cat || 'UNRESOLVED' });
    }
  }
  return sites;
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
  const sites = files.flatMap(analyseFile);
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
  return { covered, total, sites };
}

const runtimeFiles = [
  ...RUNTIME_DIRS.flatMap(jsFilesIn),
  ...RUNTIME_FILES.filter(f => fs.existsSync(path.join(REPO, f))),
].sort();
const backgroundFiles = BACKGROUND_DIRS.flatMap(jsFilesIn);

console.log('Database seam coverage — statement sites reached through lib/db-seam.js');
console.log('Excluded (the seam\'s own tooling, which holds raw handles by design):');
for (const f of [...SKIP].sort()) console.log('  - ' + f);

const runtime = report('RUNTIME — routes/, lib/, middleware/, server.js, database.js', runtimeFiles);
const background = report('BACKGROUND — scripts/ (daemons and one-off scripts)', backgroundFiles);

const covered = runtime.covered + background.covered;
const total = runtime.total + background.total;
console.log(`\n══ HEADLINE ══`);
console.log(`  Whole deployed application: ${covered}/${total} = ${((covered * 100) / total).toFixed(2)}%`);
console.log(`  Runtime surface only:       ${runtime.covered}/${runtime.total} = ` +
            `${((runtime.covered * 100) / runtime.total).toFixed(2)}%`);

console.log('\n  Covered sites:');
for (const s of [...runtime.sites, ...background.sites].filter(s => s.category === 'SEAM')) {
  console.log(`    ${s.file}:${s.line}  ${s.receiver}.prepare(`);
}

const unresolved = [...runtime.sites, ...background.sites].filter(s => s.category === 'UNRESOLVED');
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
  for (const s of [...runtime.sites, ...background.sites]) {
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
