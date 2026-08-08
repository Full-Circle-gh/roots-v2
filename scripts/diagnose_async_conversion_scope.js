#!/usr/bin/env node
//
// diagnose_async_conversion_scope.js — the async-conversion scope numbers,
// regenerated from a PARSED AST rather than from grep.
//
// WHY THIS EXISTS
// ---------------
// The PostgreSQL cutover recorded in docs/tacet-consolidation-decisions.md §24
// converts the data layer to an async contract (Path A). Sizing that work means
// counting statement sites, transactions, handlers and helpers across ~2,700
// call sites, of which routes/retail.js alone holds 1,241 in 29,682 flat lines.
//
// FOUR FIGURES IN §24 HAVE NOW BEEN CORRECTED AFTER COMING FROM GREP. That is
// the reason this file is committed rather than left as throwaway tooling:
//
//   * routes/retail.js was reported as ~19,000 lines; it is 29,682.
//   * "761 handlers, 4 async (0.5%)" — the grep matched `async` only where it
//     followed the first comma, so every handler carrying middleware was
//     missed. By AST: 756 handlers, 72 async (9.5%).
//   * "30 transactions hold 1-4 statements" — hand-counted from a listing; the
//     real distribution gives 36.
//   * "requireRetailAdmin is imported by 5 files" — the grep filtered out the
//     `retail-*` prefixed files as noise and hid four real importers; it is 9.
//
// Grep cannot see nesting, argument position, or whether a match sits inside a
// function, a callback or a transaction. Every question this script answers is
// structural, so every answer here comes from the AST. If a future survey needs
// these numbers, RUN THIS rather than re-deriving them by hand.
//
// READ-ONLY. Parses source files. Opens no database, contacts no network, and
// writes nothing except its report to stdout (and --json <path> if asked).
//
// PARSER DEPENDENCY — DELIBERATELY NOT DECLARED. This uses `espree`, which is
// NOT in package.json. It arrives transitively via the `eslint` devDependency,
// so it is present wherever a full `npm install` has run and absent on the
// production box, which installs production dependencies only. The require is
// guarded below and exits with an explanation rather than a stack trace. That
// was a deliberate choice: declaring espree would mean editing package.json,
// which is in the deploy allowlist and would ship and restart the app for the
// sake of a diagnostic. This file ships to the box (scripts/ is deployable) and
// simply refuses to run there. Nothing in the application calls it.
//
// USAGE
//   node scripts/diagnose_async_conversion_scope.js
//   node scripts/diagnose_async_conversion_scope.js --json /tmp/scope.json
//   node scripts/diagnose_async_conversion_scope.js --file routes/retail.js

'use strict';

const fs = require('fs');
const path = require('path');

let espree;
try {
  espree = require('espree');
} catch (e) {
  console.error('[diagnose_async_conversion_scope] espree is not available.');
  console.error('');
  console.error('  This diagnostic parses an AST and needs `espree`. It is not declared in');
  console.error('  package.json — it comes in transitively with the `eslint` devDependency.');
  console.error('');
  console.error('  On a dev machine:  npm install          (installs devDependencies)');
  console.error('  On the production box this will never work, by design: the box installs');
  console.error('  production dependencies only. Nothing in the app calls this script.');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const jsonPath = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null;
const onlyFile = argv.includes('--file') ? argv[argv.indexOf('--file') + 1] : null;

// ── The runtime surface, matching how §24 counts it ─────────────────────────
function walkDir(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walkDir(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}
function runtimeFiles() {
  if (onlyFile) return [path.join(ROOT, onlyFile)];
  const files = [];
  for (const d of ['routes', 'lib', 'middleware']) {
    const full = path.join(ROOT, d);
    if (fs.existsSync(full)) walkDir(full, files);
  }
  for (const f of ['server.js', 'database.js']) {
    const full = path.join(ROOT, f);
    if (fs.existsSync(full)) files.push(full);
  }
  return files;
}

// ── AST helpers ─────────────────────────────────────────────────────────────
const FN = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const ROUTER_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'use', 'all']);
const ARRAY_CBS = new Set(['map', 'forEach', 'filter', 'sort', 'reduce', 'find', 'findIndex', 'some', 'every', 'flatMap']);

function parseFile(full) {
  const src = fs.readFileSync(full, 'utf8');
  const ast = espree.parse(src, { ecmaVersion: 'latest', sourceType: 'script', loc: true, range: true });
  const parent = new Map();
  const all = [];
  (function visit(n, p) {
    if (!n || typeof n.type !== 'string') return;
    parent.set(n, p);
    all.push(n);
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'range') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(c => c && typeof c.type === 'string' && visit(c, n));
      else if (v && typeof v.type === 'string') visit(v, n);
    }
  })(ast, null);
  return { src, ast, parent, all, lines: src.split(/\r?\n/).length };
}

const memberCall = (n, name) => n.type === 'CallExpression' && n.callee
  && n.callee.type === 'MemberExpression' && n.callee.property && n.callee.property.name === name;

function makeCtx(f) {
  const { parent, all } = f;
  const ancestors = n => { const o = []; let p = parent.get(n); while (p) { o.push(p); p = parent.get(p); } return o; };
  const nearestFn = n => ancestors(n).find(a => FN.has(a.type)) || null;
  function fnName(fn) {
    if (!fn) return null;
    if (fn.id && fn.id.name) return fn.id.name;
    const p = parent.get(fn);
    if (!p) return null;
    if (p.type === 'VariableDeclarator' && p.id && p.id.name) return p.id.name;
    if (p.type === 'AssignmentExpression' && p.left && p.left.name) return p.left.name;
    if (p.type === 'Property' && p.key && (p.key.name || p.key.value)) return p.key.name || p.key.value;
    return null;
  }
  function calleeIs(fn, set) {
    const p = parent.get(fn);
    if (!p || p.type !== 'CallExpression') return false;
    const c = p.callee;
    return !!(c && c.type === 'MemberExpression' && c.property && set.has(c.property.name));
  }
  const isRouteHandler = fn => {
    const p = parent.get(fn);
    if (!p || p.type !== 'CallExpression') return false;
    const c = p.callee;
    return !!(c && c.type === 'MemberExpression' && c.property && ROUTER_METHODS.has(c.property.name)
      && c.object && (c.object.name === 'router' || c.object.name === 'app'));
  };
  const isTransactionCb = fn => calleeIs(fn, new Set(['transaction']));
  const isArrayCb = fn => calleeIs(fn, ARRAY_CBS);
  const descendants = root => {
    const out = [];
    (function sub(x) {
      if (!x || typeof x.type !== 'string') return;
      out.push(x);
      for (const k of Object.keys(x)) {
        if (k === 'loc' || k === 'range') continue;
        const v = x[k];
        if (Array.isArray(v)) v.forEach(c => c && typeof c.type === 'string' && sub(c));
        else if (v && typeof v.type === 'string') sub(v);
      }
    })(root);
    return out;
  };
  return { all, parent, ancestors, nearestFn, fnName, isRouteHandler, isTransactionCb, isArrayCb, descendants };
}

// ── Per-file analysis ───────────────────────────────────────────────────────
function analyse(full) {
  const rel = path.relative(ROOT, full).replace(/\\/g, '/');
  let f;
  try { f = parseFile(full); }
  catch (e) { return { rel, parseError: e.message }; }
  const ctx = makeCtx(f);
  const { all, ancestors, nearestFn, fnName, isRouteHandler, isTransactionCb, isArrayCb, descendants } = ctx;

  const prepares = all.filter(n => memberCall(n, 'prepare'));
  const transactions = all.filter(n => memberCall(n, 'transaction'));

  // (2) terminal calls. Two measures, because they answer different questions.
  //  - chained: <...>.prepare(sql).get() — unambiguously a database terminal.
  //  - byName: every member call with that name, which is what a grep counts and
  //    therefore includes Map.get(), req.get(), array.find() and so on.
  const terminals = { chained: {}, byName: {} };
  for (const m of ['get', 'all', 'run', 'iterate', 'pluck']) {
    terminals.byName[m] = all.filter(n => memberCall(n, m)).length;
    terminals.chained[m] = 0;
  }
  for (const p of prepares) {
    const par = f.parent.get(p);
    if (par && par.type === 'MemberExpression' && par.property && par.property.name) {
      const nm = par.property.name;
      if (nm in terminals.chained) terminals.chained[nm]++;
    }
  }
  const execByName = all.filter(n => memberCall(n, 'exec')).length;

  // (3) transactions with statement counts and enclosing function
  const txDetail = transactions.map(t => {
    const inner = descendants(t).filter(x => memberCall(x, 'prepare')).length;
    const encl = nearestFn(t);
    return {
      line: t.loc.start.line,
      statements: inner,
      enclosing: fnName(encl) || (encl && isRouteHandler(encl) ? '(route handler)' : '(anonymous)'),
    };
  });

  // (4) handlers, two measures
  const handlerLiterals = all.filter(n => FN.has(n.type) && isRouteHandler(n));
  const registrations = all.filter(n => n.type === 'CallExpression' && n.callee
    && n.callee.type === 'MemberExpression' && n.callee.property && ROUTER_METHODS.has(n.callee.property.name)
    && n.callee.object && (n.callee.object.name === 'router' || n.callee.object.name === 'app'));

  // (5) handlers with no try/catch
  const noTry = handlerLiterals.filter(h => !descendants(h.body).some(x => x.type === 'TryStatement')).length;

  // (6) classification — evaluation order is stated in the report
  const terminalOf = prep => {
    const p = f.parent.get(prep);
    if (p && p.type === 'MemberExpression') {
      const pp = f.parent.get(p);
      if (pp && pp.type === 'CallExpression') return pp;
    }
    return null;
  };
  const isInlineDeref = prep => {
    const call = terminalOf(prep);
    if (!call) return false;
    const cp = f.parent.get(call);
    if (!cp) return false;
    if (cp.type === 'MemberExpression' || cp.type === 'Property' || cp.type === 'BinaryExpression'
      || cp.type === 'LogicalExpression' || cp.type === 'TemplateLiteral' || cp.type === 'SpreadElement') return true;
    if (cp.type === 'CallExpression' && cp.arguments.indexOf(call) !== -1) return true;
    return false;
  };
  const cls = { simple: 0, inlineDeref: 0, syncHelper: 0, inTransaction: 0, syncArrayCb: 0, moduleLevel: 0 };
  for (const prep of prepares) {
    const anc = ancestors(prep);
    if (anc.some(a => memberCall(a, 'transaction')) || anc.some(a => FN.has(a.type) && isTransactionCb(a))) { cls.inTransaction++; continue; }
    const fn = nearestFn(prep);
    if (!fn) { cls.moduleLevel++; continue; }
    if (fn.async) { if (isInlineDeref(prep)) cls.inlineDeref++; else cls.simple++; continue; }
    if (isRouteHandler(fn)) { if (isInlineDeref(prep)) cls.inlineDeref++; else cls.simple++; continue; }
    if (isArrayCb(fn)) { cls.syncArrayCb++; continue; }
    cls.syncHelper++;
  }

  // (7) synchronous DB-touching helpers returning a value + in-file caller counts
  const dbHelpers = new Map();
  for (const fn of all.filter(n => FN.has(n.type))) {
    const nm = fnName(fn);
    if (!nm) continue;
    const body = descendants(fn.body);
    const touches = body.some(x => memberCall(x, 'prepare'));
    if (!touches) continue;
    if (!dbHelpers.has(nm)) dbHelpers.set(nm, { name: nm, line: fn.loc.start.line, async: !!fn.async, node: fn });
    if (fn.async || isRouteHandler(fn) || isTransactionCb(fn) || isArrayCb(fn)) continue;
    // A return belonging to THIS function — not one inside a nested callback,
    // which would say nothing about what this helper hands back.
    let returnsValue = false;
    (function ownReturns(n) {
      if (!n || typeof n.type !== 'string') return;
      if (FN.has(n.type) && n !== fn) return;            // do not descend into nested functions
      if (n.type === 'ReturnStatement' && n.argument) returnsValue = true;
      for (const k of Object.keys(n)) {
        if (k === 'loc' || k === 'range') continue;
        const v = n[k];
        if (Array.isArray(v)) v.forEach(c => c && typeof c.type === 'string' && ownReturns(c));
        else if (v && typeof v.type === 'string') ownReturns(v);
      }
    })(fn.body);
    const rec = dbHelpers.get(nm);
    rec.sync = true;
    rec.returnsValue = rec.returnsValue || returnsValue;
    rec.prepares = body.filter(x => memberCall(x, 'prepare')).length;
  }
  const callCounts = new Map();
  for (const n of all) {
    if (n.type !== 'CallExpression') continue;
    const nm = n.callee && n.callee.type === 'Identifier' ? n.callee.name : null;
    if (nm) callCounts.set(nm, (callCounts.get(nm) || 0) + 1);
  }
  const syncHelpers = [...dbHelpers.values()]
    .filter(h => h.sync)
    .map(h => ({ name: h.name, line: h.line, prepares: h.prepares || 0, returnsValue: !!h.returnsValue, callers: callCounts.get(h.name) || 0 }))
    .sort((a, b) => b.callers - a.callers || b.prepares - a.prepares);

  // (8) dual-context helpers
  const inTxRange = n => transactions.some(t => n.range[0] >= t.range[0] && n.range[1] <= t.range[1]);
  const cin = new Map(), cout = new Map();
  for (const n of all) {
    if (n.type !== 'CallExpression') continue;
    const nm = n.callee && n.callee.type === 'Identifier' ? n.callee.name : null;
    if (!nm || !dbHelpers.has(nm)) continue;
    const m = inTxRange(n) ? cin : cout;
    m.set(nm, (m.get(nm) || 0) + 1);
  }
  const dual = [...cin.keys()].map(nm => ({
    name: nm, line: dbHelpers.get(nm).line, inTx: cin.get(nm) || 0, outTx: cout.get(nm) || 0,
  })).sort((a, b) => b.inTx - a.inTx || b.outTx - a.outTx);

  return {
    rel, lines: f.lines, prepares: prepares.length, terminals, execByName,
    transactions: txDetail, handlerLiterals: handlerLiterals.length,
    handlerLiteralsAsync: handlerLiterals.filter(h => h.async).length,
    registrations: registrations.length, noTry, cls, syncHelpers, dual,
  };
}

// ── Run ─────────────────────────────────────────────────────────────────────
const files = runtimeFiles();
const results = files.map(analyse);
const ok = results.filter(r => !r.parseError);
const failed = results.filter(r => r.parseError);

const sum = (k) => ok.reduce((s, r) => s + (r[k] || 0), 0);
const totals = {
  files: ok.length,
  prepares: sum('prepares'),
  transactions: ok.reduce((s, r) => s + r.transactions.length, 0),
  handlerLiterals: sum('handlerLiterals'),
  handlerLiteralsAsync: sum('handlerLiteralsAsync'),
  registrations: sum('registrations'),
  noTry: sum('noTry'),
  execByName: sum('execByName'),
};

console.log('Async-conversion scope — AST-derived (espree), NOT grep');
console.log('='.repeat(72));
console.log('Runtime surface: routes/, lib/, middleware/, server.js, database.js');
console.log('Files parsed:', totals.files, failed.length ? `(PARSE FAILURES: ${failed.length})` : '');
for (const f of failed) console.log('   PARSE FAILED:', f.rel, '—', f.parseError);

console.log('\n[1] .prepare() SITES');
console.log('  runtime total:', totals.prepares);
console.log('  top files:');
for (const r of ok.slice().sort((a, b) => b.prepares - a.prepares).slice(0, 10)) {
  if (!r.prepares) continue;
  console.log(`    ${String(r.prepares).padStart(5)}  ${r.rel}  (${r.lines} lines)`);
}

console.log('\n[2] TERMINAL CALLS');
console.log('  CHAINED off a .prepare() — unambiguously database terminals:');
for (const m of ['get', 'all', 'run', 'iterate', 'pluck']) {
  console.log(`    .${m.padEnd(8)} ${ok.reduce((s, r) => s + r.terminals.chained[m], 0)}`);
}
console.log('  BY NAME anywhere — what a grep counts, so it also includes');
console.log('  Map.get(), req.get(), array.find() and similar NON-database calls:');
for (const m of ['get', 'all', 'run', 'iterate', 'pluck']) {
  console.log(`    .${m.padEnd(8)} ${ok.reduce((s, r) => s + r.terminals.byName[m], 0)}`);
}
console.log('    .exec()   ', totals.execByName, '(includes RegExp.exec — not only database batch calls)');

console.log('\n[3] db.transaction() BLOCKS');
console.log('  runtime total:', totals.transactions);
for (const r of ok) {
  if (!r.transactions.length) continue;
  console.log(`  ${r.rel} — ${r.transactions.length} blocks`);
  const dist = {};
  r.transactions.forEach(t => { dist[t.statements] = (dist[t.statements] || 0) + 1; });
  console.log('    statement-count distribution:', Object.keys(dist).map(Number).sort((a, b) => a - b)
    .map(k => `${k}:${dist[k]}`).join('  '));
  const oneToFour = r.transactions.filter(t => t.statements >= 1 && t.statements <= 4).length;
  const empty = r.transactions.filter(t => t.statements === 0).length;
  console.log(`    holding 1-4 statements: ${oneToFour}   holding 0 direct statements: ${empty}`);
  for (const t of r.transactions.slice().sort((a, b) => b.statements - a.statements).slice(0, 6)) {
    console.log(`      L${String(t.line).padStart(5)}  statements=${String(t.statements).padStart(2)}  in ${t.enclosing}`);
  }
}

console.log('\n[4] ROUTE HANDLERS — two measures, both defensible');
console.log('  inline handler FUNCTION LITERALS :', totals.handlerLiterals,
  `(async ${totals.handlerLiteralsAsync}, ${(totals.handlerLiteralsAsync / Math.max(1, totals.handlerLiterals) * 100).toFixed(1)}%)`);
console.log('  router.<method>() REGISTRATIONS  :', totals.registrations);
console.log('  The two differ because some registrations pass a NAMED FUNCTION');
console.log('  REFERENCE rather than an inline literal, so there is no literal to');
console.log('  count. Neither is wrong; they answer different questions.');

console.log('\n[5] HANDLERS WITH NO try/catch');
console.log('  runtime total:', totals.noTry, 'of', totals.handlerLiterals);
console.log('  Express does not catch rejections from an async handler, so each of');
console.log('  these becomes a request that never responds once made async without');
console.log('  an asyncHandler wrapper.');

console.log('\n[6] CALL-SITE CLASSIFICATION');
console.log('  EVALUATION ORDER (first match wins, as implemented):');
console.log('    1 inside a transaction   2 module-level   3 enclosing fn is async');
console.log('    4 enclosing fn is a route handler   5 sync array callback   6 sync helper');
console.log('  For 3 and 4 the site is reported as inline-dereferenced when its');
console.log('  result is consumed in the same expression, otherwise simple.');
const clsTotals = { simple: 0, inlineDeref: 0, syncHelper: 0, inTransaction: 0, syncArrayCb: 0, moduleLevel: 0 };
ok.forEach(r => Object.keys(clsTotals).forEach(k => { clsTotals[k] += r.cls[k]; }));
for (const [k, v] of Object.entries(clsTotals)) console.log(`    ${k.padEnd(16)} ${v}`);
console.log(`    ${'TOTAL'.padEnd(16)} ${Object.values(clsTotals).reduce((a, b) => a + b, 0)}`);
console.log('');
console.log('  *** FLOORS, NOT TOTALS ***');
console.log('  `syncHelper` and `inTransaction` are classified by NEAREST ENCLOSING');
console.log('  FUNCTION, not by transitive reachability. A site counted `simple` may');
console.log('  still be reachable only through a synchronous helper further up the');
console.log('  chain, and a helper called from inside a transaction drags its own');
console.log('  sites in with it. Both classes therefore UNDERSTATE the real cost.');

console.log('\n[7] SYNCHRONOUS DB-TOUCHING HELPERS THAT RETURN A VALUE');
for (const r of ok) {
  const list = r.syncHelpers.filter(h => h.returnsValue);
  if (!list.length) continue;
  console.log(`  ${r.rel} — ${list.length} such helpers (of ${r.syncHelpers.length} sync db helpers)`);
  for (const h of list.slice(0, 12)) {
    console.log(`    ${String(h.callers).padStart(3)} in-file callers  ${h.name.padEnd(32)} L${String(h.line).padStart(5)}  prepares=${h.prepares}`);
  }
}

console.log('\n[8] HELPERS CALLED BOTH INSIDE AND OUTSIDE A TRANSACTION');
console.log('  Inside a transaction these must participate in it; outside they stand');
console.log('  alone. Each needs a dual form or a moved transaction boundary.');
for (const r of ok) {
  const d = r.dual.filter(x => x.outTx > 0);
  if (!r.dual.length) continue;
  console.log(`  ${r.rel} — ${r.dual.length} helpers called inside a transaction, ${d.length} of them ALSO outside:`);
  for (const x of r.dual) {
    console.log(`    ${x.name.padEnd(32)} L${String(x.line).padStart(5)}  inTx=${String(x.inTx).padStart(2)}  outTx=${String(x.outTx).padStart(3)}${x.outTx > 0 ? '   <-- DUAL CONTEXT' : ''}`);
  }
}

if (jsonPath) {
  fs.writeFileSync(jsonPath, JSON.stringify({ totals, files: ok }, null, 2));
  console.log('\nJSON written to', jsonPath);
}
