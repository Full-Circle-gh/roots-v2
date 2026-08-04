#!/usr/bin/env node
// GATE — every tenantAls.run() must be entered with a RAW database handle.
//
// WHY THIS EXISTS
// ---------------
// currentTenantId() identifies the active tenant by looking the ALS store up in
// dbToId, which is keyed by raw handle identity, and by comparing it against
// mainDb. A seam-wrapped handle satisfies neither. Before this gate existed, a
// wrapper reaching the ALS made currentTenantId() fall through to "it must be
// Roots" — a silent, confident, wrong answer that selects a tenant's credentials.
//
// lib/tenant-db.js now throws at runtime if a wrapped handle reaches the ALS. This
// gate is the half that runs BEFORE anything ships, so a missed call site is a
// failed check rather than a failed request.
//
// IT ENUMERATES, IT DOES NOT CHECK A LIST. The call sites are discovered by
// scanning, so one added next month is caught by default. A hand-maintained list
// is exactly what went stale last time: this step was scoped as "~15 sites" and
// there are 23.
//
// Exit 0 = every site raw. Exit 1 = at least one violation.
// Read-only. Touches no database. Run: node scripts/check-tenant-als.js

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = process.argv.find(a => !a.startsWith('--') && a !== process.argv[0] && a !== process.argv[1])
  || path.join(__dirname, '..');

const DIRS = ['routes', 'lib', 'middleware', 'scripts'];
const FILES_EXTRA = ['server.js'];

// Expressions that produce a RAW handle.
//   rawTenantDb(id) / rawTdb()  — the accessors that exist for exactly this purpose
//   require('../database')      — the shared handle, raw in every step
//   new Database(...)           — a connection opened directly (test scripts)
// A member prefix is fine — the diagnostics call these through the module object
// (T.rawTenantDb(1)). What matters is which function is being called.
const RAW_CALL = /^(?:[A-Za-z_$][\w$]*\s*\.\s*)?(rawTenantDb|rawTdb)\s*\(/;
const RAW_PRODUCER = /\b(rawTenantDb|rawTdb)\s*\(|require\(\s*['"][^'"]*\/?database['"]\s*\)|new\s+Database\s*\(/;

// Expressions known to be, or to become, WRAPPED. Named explicitly so the failure
// message can say what to use instead rather than just "unrecognised".
const WRAPPED_PRODUCER = /\b(getTenantDb|tdb)\s*\(|\breq\.tenantDb\b/;

// Comment stripping must be STRING-AWARE. Without it, a `//` inside a string —
// 'https://...' is everywhere in this codebase — starts a phantom comment and eats
// the rest of the line, and a `/*` inside one eats until the next `*/`. That is how
// this gate first missed routes/retail.js:5670 entirely.
function stripComments(src) {
  let out = '', i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
        out += src[i]; i++;
      }
      if (i < n) { out += q; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

function jsFiles(dir) {
  const abs = path.join(REPO, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.isDirectory()) { out.push(...jsFiles(path.join(dir, e.name))); continue; }
    if (e.name.endsWith('.js')) out.push(path.join(dir, e.name));
  }
  return out.sort();
}

// Read the first argument of a call, balancing brackets so nested calls survive.
function firstArg(src, openParenIdx) {
  let depth = 0, i = openParenIdx;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) break; }
    else if (c === ',' && depth === 1) break;
  }
  return src.slice(openParenIdx + 1, i).trim();
}

const files = [...DIRS.flatMap(jsFiles), ...FILES_EXTRA.filter(f => fs.existsSync(path.join(REPO, f)))];

let sites = 0, violations = [], ok = [], gaps = [], mentions = [];

for (const rel of files) {
  if (rel === path.join('lib', 'tenant-db.js')) continue;         // defines the facade itself
  if (rel === path.join('scripts', 'check-tenant-als.js')) continue;   // this gate quotes the pattern
  // The Step A diagnostic deliberately enters the ALS with a seam-wrapped handle,
  // because proving the guard THROWS is its whole purpose. Scanning it would report
  // a permanent violation that must never be fixed — the same reason the seam's
  // harnesses are excluded from the coverage checker's denominator.
  if (rel === path.join('scripts', 'diagnose_tenant_step_a.js')) continue;
  if (rel === path.join('scripts', 'diagnose_tenant_step_b.js')) continue;   // same: proves the guard bites
  const raw = fs.readFileSync(path.join(REPO, rel), 'utf8');
  const src = stripComments(raw);
  // Two baselines. `inCode` is what the scanner must account for; `inRaw` includes
  // comment mentions (lib/db-seam.js's header discusses this very call), and the
  // difference is reported as prose rather than as a gap. A shortfall against
  // `inCode` is a real traversal loss and fails the gate.
  const inRaw = (raw.match(/tenantAls\s*\.\s*run\s*\(/g) || []).length;
  const inCode = (src.match(/tenantAls\s*\.\s*run\s*\(/g) || []).length;
  if (!inRaw) continue;
  if (inRaw > inCode) mentions.push({ file: rel, n: inRaw - inCode });
  if (!inCode) continue;

  // Local bindings that resolve to a raw producer.
  const rawNames = new Set();
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)) {
    if (RAW_PRODUCER.test(m[2]) && !WRAPPED_PRODUCER.test(m[2])) rawNames.add(m[1]);
  }

  let found = 0;
  const re = /tenantAls\s*\.\s*run\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    found++; sites++;
    const open = m.index + m[0].length - 1;
    const arg = firstArg(src, open);
    const line = src.slice(0, m.index).split('\n').length;
    const entry = { file: rel, line, arg: arg.replace(/\s+/g, ' ').slice(0, 70) };

    if (RAW_CALL.test(arg)) { ok.push({ ...entry, how: 'raw accessor' }); continue; }
    const root = arg.match(/^([A-Za-z_$][\w$]*)$/);
    if (root && rawNames.has(root[1])) { ok.push({ ...entry, how: `local bound to a raw producer` }); continue; }
    violations.push(entry);
  }
  if (found !== inCode) gaps.push({ file: rel, found, naive: inCode });
}

console.log('GATE — tenantAls.run() must receive a RAW handle\n');
console.log(`  scanned ${files.length} file(s), found ${sites} call site(s)\n`);

for (const o of ok) console.log(`   ok    ${o.file}:${o.line}  ${o.arg}   [${o.how}]`);

for (const m of mentions) {
  console.log(`   note  ${m.file}: ${m.n} mention(s) of the pattern in comments, not call sites`);
}

if (gaps.length) {
  console.log('\n  SCANNER GAPS — call sites the reader could not classify:');
  for (const g of gaps) console.log(`    ${g.file}: classified ${g.found}, found ${g.naive}`);
}

if (violations.length) {
  console.log(`\n  VIOLATIONS — ${violations.length}:`);
  for (const v of violations) {
    console.log(`   FAIL  ${v.file}:${v.line}  tenantAls.run(${v.arg}, …)`);
    if (WRAPPED_PRODUCER.test(v.arg)) {
      console.log('           this is (or will become) a seam-wrapped handle — use rawTenantDb(id) or rawTdb()');
    } else {
      console.log('           cannot prove this is raw — bind it from rawTenantDb(id) / rawTdb() so the gate can see it');
    }
  }
}

console.log('\n' + '═'.repeat(72));
if (violations.length || gaps.length) {
  console.log(`RESULT: FAIL — ${violations.length} violation(s), ${gaps.length} scanner gap(s).`);
  process.exit(1);
}
console.log(`RESULT: PASS — all ${sites} call sites enter the ALS with a raw handle.`);
process.exit(0);
