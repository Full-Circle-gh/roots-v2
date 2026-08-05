#!/usr/bin/env node
/**
 * diagnose_seam_capability.js — the STATIC gate a file must pass before it is
 * routed through the database seam.
 *
 * WHAT THIS IS FOR
 * ----------------
 * scripts/diagnose_seam_mechanism.js proved the seam behaviour-neutral across the
 * whole better-sqlite3 surface, once, exhaustively. That proof has an ENVELOPE:
 * it covers the members it enumerated, and it recorded three ways a caller can
 * step back OUT of the seam. A file is safe to route when it stays inside that
 * envelope. This checks that, per file, without a database and without running
 * anything.
 *
 * TWO QUESTIONS, BOTH ANSWERED BY READING THE SOURCE
 * -------------------------------------------------
 *   1. CAPABILITY — which handle members and statement members does the file
 *      actually use? Anything outside the proven set is reported and must be
 *      looked at by hand rather than shipped.
 *
 *   2. PROPAGATION — does the handle LEAVE this file? A module-level handle that
 *      is exported, or passed as an argument to another module's function, keeps
 *      travelling: wrapping it here silently wraps it wherever it lands. That is
 *      usually what we want — coverage propagates — but it is never something to
 *      discover afterwards, because the receiving module may hold it somewhere
 *      that must stay raw (tenantAls.run() and the dbToId map in lib/tenant-db.js
 *      both compare by identity, and lib/db-seam.js's own header says so).
 *      Detected automatically here rather than being noticed by eye, which is how
 *      the previous round found that require-cap hands its handle to
 *      operator-caps — by reading, and only because someone thought to look.
 *
 * Run: node scripts/diagnose_seam_capability.js <file> [<file> ...]
 *      With no arguments it audits every file already routed through the seam.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');

// The envelope, straight from what diagnose_seam_mechanism.js enumerated and
// proved. Handle members outside HANDLE_PROVEN, or statement members outside
// STMT_PROVEN, are not covered by that proof and must not be waved through.
const HANDLE_PROVEN = new Set([
  'prepare', 'exec', 'pragma', 'transaction', 'function', 'aggregate', 'table',
  'backup', 'serialize', 'loadExtension', 'close', 'defaultSafeIntegers',
  'unsafeMode', 'name', 'open', 'inTransaction', 'readonly', 'memory',
]);
const STMT_PROVEN = new Set([
  'get', 'all', 'run', 'iterate', 'pluck', 'expand', 'raw', 'columns', 'bind',
  'safeIntegers', 'reader', 'readonly', 'busy', 'source',
]);
// Proven to exist, and proven to hand back the RAW handle — using it is a way
// OUT of the seam, so it is called out separately rather than silently allowed.
const LEAVES_THE_SEAM = new Set(['database']);
// The methods that end a statement chain and hand back data.
const TERMINAL = new Set(['get', 'all', 'run', 'iterate']);

let FAILURES = 0, WARNINGS = 0;
const fail = (m) => { FAILURES++; console.log('   FAIL  ' + m); };
const warn = (m) => { WARNINGS++; console.log('   WARN  ' + m); };
const ok = (m) => console.log('   ok    ' + m);

// Strip comments and string/template/regex literals so a member name mentioned in
// prose or SQL is not mistaken for a real member access. Same hazard the coverage
// checker was corrected for on 2026-08-04, when a regex literal desynchronised its
// scanner and swallowed a whole daemon.
function scrub(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let prev = '';
  while (i < n) {
    const c = src[i], c2 = src.slice(i, i + 2);
    if (c2 === '//') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c2 === '/*') { i += 2; while (i < n && src.slice(i, i + 2) !== '*/') i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c; i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      out += ' "" ';
      continue;
    }
    // A regex literal, distinguished from division by what can precede it.
    if (c === '/' && /[=(,:[!&|?{};+\-*%~^]|return|typeof|case/.test(prev.trim().slice(-6) || '(')) {
      let j = i + 1, inClass = false, closed = false;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) { closed = true; j++; break; }
        else if (src[j] === '\n') break;
        j++;
      }
      if (closed) { while (j < n && /[gimsuy]/.test(src[j])) j++; i = j; out += ' RE '; continue; }
    }
    out += c;
    if (!/\s/.test(c)) prev += c;
    if (prev.length > 12) prev = prev.slice(-12);
    i++;
  }
  return out;
}

// The identifier the module-level handle is bound to, e.g. `const db = require('../database')`.
function findHandleName(src) {
  const m = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:seam\s*\(\s*)?require\(\s*['"][.\/]*(?:\.\.\/)*database['"]\s*\)/.exec(src);
  return m ? m[1] : null;
}

function auditFile(rel) {
  const abs = path.join(HOME, rel);
  let raw;
  try { raw = fs.readFileSync(abs, 'utf8'); } catch (e) { fail(`${rel}: cannot read (${e.code})`); return; }
  const src = scrub(raw);
  const handle = findHandleName(raw);
  if (!handle) { fail(`${rel}: no module-level \`require('…/database')\` binding found`); return; }

  const alreadyRouted = /=\s*seam\s*\(\s*require\(/.test(raw);

  // 1 — capability. Members reached directly off the handle, and members reached
  // off whatever prepare() returned.
  const handleMembers = new Set();
  const stmtMembers = new Set();
  const hRe = new RegExp(`\\b${handle}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g');
  let m;
  while ((m = hRe.exec(src)) !== null) handleMembers.add(m[1]);
  // `<handle>.prepare(...)` … `.member` — the chain after a prepare on this handle.
  const pRe = new RegExp(`\\b${handle}\\s*\\.\\s*prepare\\s*\\(`, 'g');
  while ((m = pRe.exec(src)) !== null) {
    // Walk the balanced call, then collect the member chain that follows it.
    let i = m.index + m[0].length, depth = 1;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    }
    const tail = src.slice(i, i + 200);
    const cRe = /^\s*\.\s*([A-Za-z_$][\w$]*)/;
    let t = tail;
    let guard = 0;
    while (guard++ < 6) {
      const cm = cRe.exec(t);
      if (!cm) break;
      stmtMembers.add(cm[1]);
      // get/all/run/iterate END the statement chain — what follows is a ROW, an
      // ARRAY or an info object, and its members belong to the result, not to
      // better-sqlite3. Walking past them reports `.get().c` (a column named c)
      // and `.all().map(…)` (Array.prototype.map) as unknown statement members,
      // which is how this check first read five files as outside the envelope.
      if (TERMINAL.has(cm[1])) break;
      const after = t.slice(cm[0].length);
      if (after.trimStart().startsWith('(')) {
        let j = after.indexOf('('), d = 1; j++;
        while (j < after.length && d > 0) { if (after[j] === '(') d++; else if (after[j] === ')') d--; j++; }
        t = after.slice(j);
      } else t = after;
    }
  }

  const badHandle = [...handleMembers].filter((x) => !HANDLE_PROVEN.has(x));
  const badStmt = [...stmtMembers].filter((x) => !STMT_PROVEN.has(x) && !LEAVES_THE_SEAM.has(x));
  const leaks = [...stmtMembers].filter((x) => LEAVES_THE_SEAM.has(x));

  // 2 — propagation. Where does this handle GO?
  const prop = [];
  // exported
  if (new RegExp(`module\\.exports\\s*=\\s*(?:\\{[^}]*\\b${handle}\\b|${handle}\\b)`).test(src)) prop.push('module.exports');
  if (new RegExp(`exports\\.[\\w$]+\\s*=\\s*${handle}\\b`).test(src)) prop.push('exports.<name>');
  // passed as an argument: `foo(..., db, ...)` where foo is not the handle itself
  const argRe = new RegExp(`([A-Za-z_$][\\w$.]*)\\s*\\(([^()]*)\\)`, 'g');
  while ((m = argRe.exec(src)) !== null) {
    const callee = m[1], args = m[2];
    if (callee === handle || callee.startsWith(handle + '.')) continue;
    if (new RegExp(`(^|[,\\s])${handle}([,\\s]|$)`).test(args)) prop.push(`passed to ${callee}()`);
  }
  // attached to a request/context object
  // `x.y = db` propagates the HANDLE. `x.y = db.prepare(...).get()` assigns a ROW
  // and propagates nothing — the trailing \b matches before the dot, so without
  // this the two are indistinguishable. middleware/auth.js:11 was reported as a
  // propagation on exactly that basis and is not one.
  const attachRe = new RegExp(`\\.\\s*[\\w$]+\\s*=\\s*${handle}\\s*(?![\\w$.(])`, 'g');
  while ((m = attachRe.exec(src)) !== null) prop.push(`assigned: ${m[0].trim()}`);

  const uniqProp = [...new Set(prop)];

  const status = alreadyRouted ? 'routed' : 'not yet routed';
  console.log(`\n   ${rel}   handle=\`${handle}\`  (${status})`);
  console.log(`      handle members : ${[...handleMembers].sort().join(', ') || '(none)'}`);
  console.log(`      stmt members   : ${[...stmtMembers].sort().join(', ') || '(none)'}`);

  if (badHandle.length) fail(`${rel}: handle member(s) OUTSIDE the proven envelope: ${badHandle.join(', ')}`);
  if (badStmt.length) fail(`${rel}: statement member(s) OUTSIDE the proven envelope: ${badStmt.join(', ')}`);
  if (leaks.length) fail(`${rel}: uses ${leaks.join(', ')} — proven to hand back the RAW handle, which steps outside the seam`);
  if (!badHandle.length && !badStmt.length && !leaks.length) ok(`${rel}: every member used is inside the proven envelope`);

  if (uniqProp.length) {
    warn(`${rel}: the handle PROPAGATES — ${uniqProp.join('; ')}`);
    console.log('            Wrapping here wraps it wherever it lands. That is usually the point,');
    console.log('            but the receiver must not be a site that compares handles by identity.');
  } else {
    ok(`${rel}: the handle does not leave this file`);
  }
}

const args = process.argv.slice(2);
console.log('seam capability + propagation audit');
console.log('   envelope from scripts/diagnose_seam_mechanism.js');
console.log(`   ${args.length} file(s)`);
for (const f of args) auditFile(f);

console.log('\n' + '═'.repeat(72));
console.log(`${FAILURES} failure(s), ${WARNINGS} propagation warning(s).`);
if (FAILURES === 0) {
  console.log('RESULT: PASS — every file stays inside the envelope the mechanism proof covers.');
  process.exit(0);
}
console.log('RESULT: FAIL — look at the reported files by hand before routing them.');
process.exit(1);
