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
//
// TWO TRANSACTION FORMS, REPORTED SEPARATELY AND NEVER SUMMED — READ THIS FIRST
// ----------------------------------------------------------------------------
// This tree opens a transaction in exactly TWO ways, and the whole tree was
// enumerated to be able to say "exactly" rather than "the two we know about":
//
//   UNCONVERTED   <handle>.transaction(fn)      better-sqlite3's own wrapper
//   CONVERTED     withTransaction(handle, fn)   lib/db-transaction.js
//
// Nothing else opens one. No raw BEGIN / SAVEPOINT is issued anywhere in the
// runtime surface except inside lib/db-transaction.js itself, which is the
// CONVERTED form's implementation and not a third mechanism. `.immediate()` is
// how one UNCONVERTED block is invoked, not a way of opening another. `pg` is
// installed and lib/pg.js exports a pool, but no runtime file opens a
// transaction on it. See the SELF-TEST section for how this claim is kept true.
//
// UNTIL 2026-08-10 THIS SCRIPT COULD ONLY SEE THE FIRST FORM, and that is the
// defect this header exists to stop recurring. It matched `.transaction` as a
// MEMBER PROPERTY. `withTransaction(h, fn)` is an `Identifier` callee, so it
// matched nothing at all — 26 converted blocks in routes/retail.js appeared in
// no figure this script printed, through four conversion batches, while every
// number it produced stayed entirely plausible.
//
// SO: EVERY TRANSACTION FIGURE BELOW IS LABELLED WITH ITS FORM, AND NO BLENDED
// TOTAL IS PRINTED ANYWHERE. That is deliberate and it is not tidiness. Every
// transaction count §24 has ever quoted — 103 runtime, 30 in routes/retail.js,
// the whole [8] dual-context table — means the UNCONVERTED form. A single
// combined number would silently change what all of those sentences mean
// without changing a word of them. If you need "how many transactions are in
// this file", the honest answer is two numbers and you must quote both.
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
// MAPPING ONTO THE FIGURES §24 ALREADY QUOTES — MEASURED 2026-08-10
// ------------------------------------------------------------------
// Recorded here, with the tool that produces the numbers, rather than by
// editing the dated entries that quote them. Those entries stand.
//
//   "103 runtime db.transaction() blocks"
//     BECOMES: 103 UNCONVERTED  +  26 CONVERTED, reported separately.
//     PARTIAL, NOT WRONG. 103 was a correct count of the unconverted form on
//     the day it was written and it is still 103 today. What it never said is
//     that it describes one of two populations.
//
//   "30 in routes/retail.js"
//     BECOMES: 30 UNCONVERTED  +  26 CONVERTED, reported separately.
//     PARTIAL, NOT WRONG — same reason. The two together are the 56 that
//     lib/db-transaction.js has been describing as "26 of the 56" all along,
//     which is the sentence that should have made the gap visible sooner.
//
//   "the [8] dual-context table"
//     BECOMES: three columns — inTxUnconverted / inTxConverted / outsideAny.
//     MIXED, and this is the one to read carefully:
//       * Every row the old table PRINTED keeps both of its numbers exactly.
//         Not one printed value was wrong.
//       * What was wrong is what the second column MEANT. `outTx` was "not
//         inside a db.transaction()", which is not "outside a transaction" —
//         it silently included every call made inside a converted block, in
//         the column that says no work is needed.
//       * And the table OMITTED a helper entirely: it listed a helper only if
//         that helper had a call inside an unconverted block, so one whose only
//         transaction context is a converted one never appeared. At this head
//         that is `ensureShipmentRow` (routes/retail.js L21130), 0/1/0.
//     So: partial in its rows, wrong in its column semantics, and short by one
//     helper. The current count of each is printed by section [8] itself.
//
//   "222 call sites inside a transaction" ([6] inTransaction)
//     BECOMES: 222 inTxUnconverted + 56 inTxConverted, reported separately in
//     view [6b]; view [6a] still prints 222 unchanged. PARTIAL, NOT WRONG.
//     All 56 came out of `syncHelper`, which is a fact about the code: every
//     converted body in this tree is still a SYNCHRONOUS function.
//
//
// SELF-TEST — THE DETECTOR HAS A CASE IT CAN FAIL ON
// --------------------------------------------------
// `--self-test` parses scripts/test-support/tx-detection-fixture.js, a file with
// a known count of each form written down in its own header, and asserts the
// exact numbers. It covers the alias import, nesting, and — as NEGATIVES that
// must contribute zero — both forms inside line comments, block comments, string
// literals and template literals.
//
// Detection is AST-only, so a comment cannot be matched: espree discards
// comments before this script sees a node. The self-test does not take that on
// trust. It also runs a naive regex over the RAW source and over the SAME source
// with comments stripped by a string-aware stripper, and prints all three, so
// the gap between "what a grep sees" and "what is actually code" is a measured
// number in the output rather than an assurance in a comment.
//
// USAGE
//   node scripts/diagnose_async_conversion_scope.js
//   node scripts/diagnose_async_conversion_scope.js --json /tmp/scope.json
//   node scripts/diagnose_async_conversion_scope.js --file routes/retail.js
//   node scripts/diagnose_async_conversion_scope.js --self-test

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
const selfTest = argv.includes('--self-test');

// The two forms, named once. Every label printed below is built from these, so
// a report cannot drift out of step with what was measured.
const FORM = {
  unconverted: { key: 'unconverted', label: 'UNCONVERTED  <handle>.transaction(fn)   — better-sqlite3' },
  converted: { key: 'converted', label: 'CONVERTED    withTransaction(handle, fn) — lib/db-transaction.js' },
};
const TX_MODULE = /(^|\/)lib\/db-transaction$|(^|\/)db-transaction$/;
const TX_EXPORT = 'withTransaction';

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

// A call by BARE NAME — the shape the old detector had no case for at all.
const identCall = (n, names) => n.type === 'CallExpression' && n.callee
  && n.callee.type === 'Identifier' && names.has(n.callee.name);

/**
 * Which local names in this file mean lib/db-transaction's withTransaction.
 *
 * Resolved from the file's own requires rather than assumed, because a
 * destructuring rename — `const { withTransaction: runTx } = require(...)` —
 * produces call sites that share nothing textual with the export's name. The
 * bare export name is always included as well: a file that re-exports the
 * helper, or reaches it through a barrel this does not model, still calls it by
 * that name, and counting a helper of the same name that is genuinely local
 * would be a visible over-count rather than a silent blind spot. Which names
 * were resolved is printed in the report, so an odd one is legible.
 */
function txHelperNames(f) {
  const names = new Set([TX_EXPORT]);
  for (const n of f.all) {
    if (n.type !== 'CallExpression') continue;
    if (!n.callee || n.callee.name !== 'require') continue;
    const arg = n.arguments && n.arguments[0];
    if (!arg || typeof arg.value !== 'string' || !TX_MODULE.test(arg.value)) continue;
    const decl = f.parent.get(n);
    if (!decl || decl.type !== 'VariableDeclarator' || !decl.id) continue;
    if (decl.id.type === 'ObjectPattern') {
      for (const p of decl.id.properties) {
        if (p.type !== 'Property' || !p.key || p.key.name !== TX_EXPORT) continue;
        if (p.value && p.value.name) names.add(p.value.name);
      }
    }
  }
  return names;
}

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

  // THE TWO TRANSACTION FORMS. Collected into two separate arrays that are never
  // concatenated, because the moment they are, every figure §24 quotes changes
  // meaning. See the header.
  const txNames = txHelperNames(f);
  const transactions = all.filter(n => memberCall(n, 'transaction'));      // UNCONVERTED
  const converted = all.filter(n => identCall(n, txNames));                // CONVERTED

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

  // (3) transactions with statement counts and enclosing function — ONE detail
  // list PER FORM, built by the same function so the two are measured alike and
  // any difference between them is a difference in the code, not in the method.
  const detailFor = nodes => nodes.map(t => {
    const inner = descendants(t).filter(x => memberCall(x, 'prepare')).length;
    const encl = nearestFn(t);
    return {
      line: t.loc.start.line,
      statements: inner,
      enclosing: fnName(encl) || (encl && isRouteHandler(encl) ? '(route handler)' : '(anonymous)'),
    };
  });
  const txDetail = detailFor(transactions);
  const convDetail = detailFor(converted);

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
  // (6a) THE UNCONVERTED-ONLY VIEW. Byte-for-byte the classification this script
  // has always produced, kept unchanged so every classification figure §24 has
  // quoted stays comparable. `inTransaction` here means the UNCONVERTED form and
  // nothing else — a site inside a withTransaction body lands in `simple`.
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

  // (6b) THE BOTH-FORMS VIEW. Same evaluation order, except that the enclosing
  // transaction is looked for in BOTH forms and reported in TWO buckets that are
  // never added together. Everything a site can be is still one bucket, so the
  // two views have the same total and differ only in where the converted sites
  // sit — which is exactly the correction.
  const enclosingForm = node => {
    for (const a of ancestors(node)) {
      if (memberCall(a, 'transaction')) return FORM.unconverted.key;
      if (identCall(a, txNames)) return FORM.converted.key;
    }
    return null;
  };
  const cls2 = {
    simple: 0, inlineDeref: 0, syncHelper: 0,
    inTxUnconverted: 0, inTxConverted: 0,
    syncArrayCb: 0, moduleLevel: 0,
  };
  for (const prep of prepares) {
    const form = enclosingForm(prep);
    if (form === FORM.unconverted.key) { cls2.inTxUnconverted++; continue; }
    if (form === FORM.converted.key) { cls2.inTxConverted++; continue; }
    const fn = nearestFn(prep);
    if (!fn) { cls2.moduleLevel++; continue; }
    if (fn.async) { if (isInlineDeref(prep)) cls2.inlineDeref++; else cls2.simple++; continue; }
    if (isRouteHandler(fn)) { if (isInlineDeref(prep)) cls2.inlineDeref++; else cls2.simple++; continue; }
    if (isArrayCb(fn)) { cls2.syncArrayCb++; continue; }
    cls2.syncHelper++;
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

  // (8) dual-context helpers — THREE columns, not two.
  //
  // THIS IS THE PLACE THE OLD DETECTOR WAS WRONG RATHER THAN MERELY PARTIAL.
  // Its two columns were "inside a transaction" and "outside", where "inside"
  // could only mean the UNCONVERTED form. A call inside a CONVERTED block was
  // therefore filed under "outside" — reported as standing alone when it is in
  // a transaction. Elsewhere the blindness lost sites; here it MOVED them, into
  // the column that says no work is needed.
  //
  // Containment is by SMALLEST enclosing block, so a converted block nested in
  // an unconverted one attributes its calls to the block they are actually in.
  const containing = (n, nodes) => nodes.filter(t => n.range[0] >= t.range[0] && n.range[1] <= t.range[1]);
  const width = t => t.range[1] - t.range[0];
  const formOfCall = n => {
    const u = containing(n, transactions);
    const c = containing(n, converted);
    if (!u.length && !c.length) return null;
    const nu = u.length ? u.reduce((a, b) => (width(a) <= width(b) ? a : b)) : null;
    const nc = c.length ? c.reduce((a, b) => (width(a) <= width(b) ? a : b)) : null;
    if (nu && nc) return width(nu) <= width(nc) ? FORM.unconverted.key : FORM.converted.key;
    return nu ? FORM.unconverted.key : FORM.converted.key;
  };
  // The OLD predicate, kept verbatim and computed alongside, so the report can
  // state what each historical row becomes instead of asserting it.
  const legacyInTx = n => transactions.some(t => n.range[0] >= t.range[0] && n.range[1] <= t.range[1]);

  const cinU = new Map(), cinC = new Map(), cout = new Map(), cLegacyIn = new Map();
  for (const n of all) {
    if (n.type !== 'CallExpression') continue;
    const nm = n.callee && n.callee.type === 'Identifier' ? n.callee.name : null;
    if (!nm || !dbHelpers.has(nm)) continue;
    const form = formOfCall(n);
    const m = form === FORM.unconverted.key ? cinU : form === FORM.converted.key ? cinC : cout;
    m.set(nm, (m.get(nm) || 0) + 1);
    if (legacyInTx(n)) cLegacyIn.set(nm, (cLegacyIn.get(nm) || 0) + 1);
  }
  const dualNames = new Set([...cinU.keys(), ...cinC.keys()]);
  const dual = [...dualNames].map(nm => ({
    name: nm,
    line: dbHelpers.get(nm).line,
    inTxUnconverted: cinU.get(nm) || 0,
    inTxConverted: cinC.get(nm) || 0,
    outsideAny: cout.get(nm) || 0,
    // What the old two-column table printed for this helper. Kept so a reader
    // holding an old §24 table can line the rows up rather than guess.
    legacyInTx: cLegacyIn.get(nm) || 0,
    legacyOutTx: (cinU.get(nm) || 0) + (cinC.get(nm) || 0) + (cout.get(nm) || 0) - (cLegacyIn.get(nm) || 0),
  })).sort((a, b) => (b.inTxUnconverted - a.inTxUnconverted)
    || (b.inTxConverted - a.inTxConverted)
    || (b.outsideAny - a.outsideAny));

  return {
    rel, lines: f.lines, prepares: prepares.length, terminals, execByName,
    transactions: txDetail, converted: convDetail,
    txHelperNames: [...txNames],
    handlerLiterals: handlerLiterals.length,
    handlerLiteralsAsync: handlerLiterals.filter(h => h.async).length,
    registrations: registrations.length, noTry, cls, cls2, syncHelpers, dual,
  };
}

// ── Comment stripping, for the self-test's source-level comparison ──────────
//
// Verbatim from scripts/check-tenant-als.js, and string-aware for the reason
// recorded there: a `//` inside a string — 'https://…' is everywhere in this
// codebase — starts a phantom comment and eats the rest of the line, and a `/*`
// inside one eats to the next `*/`. The fixture contains exactly that case on
// purpose, so a stripper that is not string-aware loses a real transaction and
// the self-test says so.
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

// ── Self-test ───────────────────────────────────────────────────────────────
//
// A detector with no failing case is not proven, it is only unfalsified — which
// is precisely how this one shipped blind through four conversion batches. The
// fixture states its own counts in its header; this asserts them.
if (selfTest) {
  const FIXTURE = 'scripts/test-support/tx-detection-fixture.js';
  const full = path.join(ROOT, FIXTURE);
  const raw = fs.readFileSync(full, 'utf8');
  const r = analyse(full);

  const results = [];
  const check = (name, got, want) => {
    const pass = JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, got, want, pass });
  };

  console.log('diagnose_async_conversion_scope — SELF-TEST');
  console.log('='.repeat(72));
  console.log('Fixture:', FIXTURE);
  if (r.parseError) {
    console.log('PARSE FAILED —', r.parseError);
    process.exit(1);
  }

  // The counts the fixture's own header declares.
  check('UNCONVERTED blocks  <handle>.transaction(fn)', r.transactions.length, 7);
  check('CONVERTED blocks    withTransaction(h, fn)', r.converted.length, 5);
  check('import alias resolved to the helper', r.txHelperNames.slice().sort(), ['runTx', 'withTransaction']);

  const touch = r.dual.find(x => x.name === 'touchOnce') || null;
  check('touchOnce inside an UNCONVERTED block', touch && touch.inTxUnconverted, 1);
  check('touchOnce inside a CONVERTED block', touch && touch.inTxConverted, 1);
  check('touchOnce outside both', touch && touch.outsideAny, 1);
  // The row as the old two-column table would have printed it. This is the
  // defect stated as a number: one of those two "outside" calls is in a
  // transaction.
  check('touchOnce as the OLD table read it (inTx/outTx)',
    touch && [touch.legacyInTx, touch.legacyOutTx], [1, 2]);

  // NEGATIVES, measured rather than asserted in prose. A naive regex over the
  // raw source counts comments and strings; over stripped source it still counts
  // strings; only the AST counts code.
  const MEMBER_RE = /\.transaction\s*\(/g;
  const IDENT_RE = /\bwithTransaction\s*\(/g;
  const count = (s, re) => (s.match(re) || []).length;
  const stripped = stripComments(raw);
  const naive = {
    memberRaw: count(raw, MEMBER_RE), memberStripped: count(stripped, MEMBER_RE),
    identRaw: count(raw, IDENT_RE), identStripped: count(stripped, IDENT_RE),
  };
  results.push({
    name: 'comments inflate a raw source-level match (member form)',
    got: naive.memberRaw, want: `> ${naive.memberStripped} (stripped)`,
    pass: naive.memberRaw > naive.memberStripped,
  });
  results.push({
    name: 'comments inflate a raw source-level match (ident form)',
    got: naive.identRaw, want: `> ${naive.identStripped} (stripped)`,
    pass: naive.identRaw > naive.identStripped,
  });
  // The stripper's string-awareness, pinned to an EXACT number rather than an
  // inequality, because an inequality is what let a broken stripper look fine.
  //
  // After stripping, the fixture's member form should appear AST + 1 times: the
  // 7 real blocks, plus the one string literal 'tdb().transaction(' — which is
  // data, not code, and which no comment stripper can remove. A stripper that is
  // NOT string-aware reads the `//` inside u6's 'https://…' literal as starting
  // a comment, eats the rest of that line, and loses BOTH the real u6 block and
  // the string false positive — landing back on 7 and looking correct under any
  // "more than the AST count" test. This equality is what catches that.
  results.push({
    name: 'string-aware stripping keeps u6 AND the one string-literal false positive',
    got: naive.memberStripped, want: `${r.transactions.length + 1} (AST ${r.transactions.length} + 1 string literal)`,
    pass: naive.memberStripped === r.transactions.length + 1,
  });
  results.push({
    name: 'no source-level match can equal the AST — stripping is necessary, not sufficient',
    got: naive.memberStripped, want: `> ${r.transactions.length} (AST)`,
    pass: naive.memberStripped > r.transactions.length,
  });

  let failed = 0;
  console.log('');
  for (const t of results) {
    if (!t.pass) failed++;
    console.log(`  ${t.pass ? 'PASS' : 'FAIL'}  ${t.name}`);
    console.log(`        got ${JSON.stringify(t.got)}   want ${JSON.stringify(t.want)}`);
  }
  console.log('');
  console.log('  Source-level counts, for the record:');
  console.log(`    member form  raw ${naive.memberRaw}   comment-stripped ${naive.memberStripped}   AST ${r.transactions.length}`);
  console.log(`    ident  form  raw ${naive.identRaw}   comment-stripped ${naive.identStripped}   AST ${r.converted.length}`);
  console.log('');
  console.log(failed ? `SELF-TEST FAILED — ${failed} of ${results.length}` : `SELF-TEST PASSED — ${results.length} of ${results.length}`);
  process.exit(failed ? 1 : 0);
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
  // TWO transaction totals. There is deliberately no third field adding them:
  // a combined figure has no reader it would not mislead. See the header.
  transactionsUnconverted: ok.reduce((s, r) => s + r.transactions.length, 0),
  transactionsConverted: ok.reduce((s, r) => s + r.converted.length, 0),
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
console.log('');
console.log('TRANSACTIONS ARE COUNTED IN TWO FORMS AND THE TWO ARE NEVER ADDED UP:');
console.log(`  ${FORM.unconverted.label}`);
console.log(`  ${FORM.converted.label}`);
console.log('Every transaction figure §24 quotes means the UNCONVERTED form alone.');
console.log('This report labels each one so a number cannot be read as a total.');

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

// One printer, used twice. The two forms are measured and shown alike, so a
// difference between the sections is a difference in the code.
function printBlocks(tag, form, pick, total) {
  console.log(`\n[${tag}] TRANSACTION BLOCKS — ${form.label}`);
  console.log('  runtime total:', total, `  <- ${form.key.toUpperCase()} FORM ONLY, not a total of both`);
  for (const r of ok) {
    const list = pick(r);
    if (!list.length) continue;
    console.log(`  ${r.rel} — ${list.length} ${form.key} blocks`);
    const dist = {};
    list.forEach(t => { dist[t.statements] = (dist[t.statements] || 0) + 1; });
    console.log('    statement-count distribution:', Object.keys(dist).map(Number).sort((a, b) => a - b)
      .map(k => `${k}:${dist[k]}`).join('  '));
    const oneToFour = list.filter(t => t.statements >= 1 && t.statements <= 4).length;
    const empty = list.filter(t => t.statements === 0).length;
    console.log(`    holding 1-4 statements: ${oneToFour}   holding 0 direct statements: ${empty}`);
    for (const t of list.slice().sort((a, b) => b.statements - a.statements).slice(0, 6)) {
      console.log(`      L${String(t.line).padStart(5)}  statements=${String(t.statements).padStart(2)}  in ${t.enclosing}`);
    }
  }
}

printBlocks('3a', FORM.unconverted, r => r.transactions, totals.transactionsUnconverted);
console.log('\n  THIS IS THE NUMBER §24 HAS ALWAYS QUOTED. It was correct when it was');
console.log('  written and it is correct now; what was missing is that it describes');
console.log('  one of two populations. Section [3b] is the other one.');

printBlocks('3b', FORM.converted, r => r.converted, totals.transactionsConverted);
console.log('\n  NEW — this population appeared in NO figure this script printed before');
console.log('  2026-08-10, through four conversion batches. Do not add it to [3a] and');
console.log('  quote the sum: no sentence in §24 means that number.');
const aliased = ok.filter(r => r.txHelperNames.length > 1);
if (aliased.length) {
  console.log('  Local names resolved to lib/db-transaction\'s withTransaction:');
  for (const r of aliased) console.log(`    ${r.rel}: ${r.txHelperNames.join(', ')}`);
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

console.log('\n[6] CALL-SITE CLASSIFICATION — TWO VIEWS, PRINTED SEPARATELY');
console.log('  EVALUATION ORDER (first match wins, as implemented):');
console.log('    1 inside a transaction   2 module-level   3 enclosing fn is async');
console.log('    4 enclosing fn is a route handler   5 sync array callback   6 sync helper');
console.log('  For 3 and 4 the site is reported as inline-dereferenced when its');
console.log('  result is consumed in the same expression, otherwise simple.');

console.log('\n  [6a] UNCONVERTED-ONLY VIEW — what this script has always printed.');
console.log('       `inTransaction` here means the UNCONVERTED form and nothing else,');
console.log('       so a site inside a withTransaction body lands in `simple`.');
const clsTotals = { simple: 0, inlineDeref: 0, syncHelper: 0, inTransaction: 0, syncArrayCb: 0, moduleLevel: 0 };
ok.forEach(r => Object.keys(clsTotals).forEach(k => { clsTotals[k] += r.cls[k]; }));
for (const [k, v] of Object.entries(clsTotals)) console.log(`       ${k.padEnd(18)} ${v}`);
console.log(`       ${'TOTAL'.padEnd(18)} ${Object.values(clsTotals).reduce((a, b) => a + b, 0)}`);

console.log('\n  [6b] BOTH-FORMS VIEW — the same sites, with the enclosing transaction');
console.log('       looked for in BOTH forms and reported in two buckets. Same total.');
const cls2Totals = {
  simple: 0, inlineDeref: 0, syncHelper: 0,
  inTxUnconverted: 0, inTxConverted: 0, syncArrayCb: 0, moduleLevel: 0,
};
ok.forEach(r => Object.keys(cls2Totals).forEach(k => { cls2Totals[k] += r.cls2[k]; }));
for (const [k, v] of Object.entries(cls2Totals)) console.log(`       ${k.padEnd(18)} ${v}`);
console.log(`       ${'TOTAL'.padEnd(18)} ${Object.values(cls2Totals).reduce((a, b) => a + b, 0)}`);
console.log('       DO NOT ADD inTxUnconverted TO inTxConverted and quote the sum.');
console.log(`       The [6a] figure to compare against is inTransaction = ${clsTotals.inTransaction}, and it`);
console.log(`       is unchanged here as inTxUnconverted = ${cls2Totals.inTxUnconverted}.`);
console.log('');
console.log(`       WHERE THE ${cls2Totals.inTxConverted} NEWLY-VISIBLE CONVERTED SITES SAT IN [6a] — computed,`);
console.log('       not asserted, because which bucket they came from says something');
console.log('       about the code rather than about this script:');
for (const k of ['simple', 'inlineDeref', 'syncHelper', 'syncArrayCb', 'moduleLevel']) {
  const d = clsTotals[k] - cls2Totals[k];
  if (d) console.log(`         ${k.padEnd(14)} ${clsTotals[k]} -> ${cls2Totals[k]}   (${d} moved out)`);
}
if (clsTotals.syncHelper - cls2Totals.syncHelper === cls2Totals.inTxConverted) {
  console.log('       ALL of them were classified `syncHelper`, which means every converted');
  console.log('       transaction BODY in this tree is a SYNCHRONOUS function — an async body');
  console.log('       would have put its sites in `simple` instead. That is the same property');
  console.log('       lib/db-transaction.js records as the reason its nesting defect stayed');
  console.log('       dormant, arrived at here from the opposite direction.');
}
console.log('');
console.log('  *** FLOORS, NOT TOTALS *** (true of both views)');
console.log('  `syncHelper` and the in-transaction classes are classified by NEAREST');
console.log('  ENCLOSING FUNCTION, not by transitive reachability. A site counted');
console.log('  `simple` may still be reachable only through a synchronous helper');
console.log('  further up the chain, and a helper called from inside a transaction');
console.log('  drags its own sites in with it. Both classes therefore UNDERSTATE the');
console.log('  real cost.');

console.log('\n[7] SYNCHRONOUS DB-TOUCHING HELPERS THAT RETURN A VALUE');
for (const r of ok) {
  const list = r.syncHelpers.filter(h => h.returnsValue);
  if (!list.length) continue;
  console.log(`  ${r.rel} — ${list.length} such helpers (of ${r.syncHelpers.length} sync db helpers)`);
  for (const h of list.slice(0, 12)) {
    console.log(`    ${String(h.callers).padStart(3)} in-file callers  ${h.name.padEnd(32)} L${String(h.line).padStart(5)}  prepares=${h.prepares}`);
  }
}

console.log('\n[8] HELPERS CALLED INSIDE A TRANSACTION — THREE COLUMNS, NOT TWO');
console.log('  Inside a transaction of either form a helper must participate in it;');
console.log('  outside both it stands alone. Each dual-context helper needs a dual');
console.log('  form or a moved transaction boundary.');
console.log('');
console.log('  THIS TABLE USED TO BE WRONG, NOT MERELY PARTIAL. Its old `outTx`');
console.log('  column meant "not inside a db.transaction()", which put every call');
console.log('  made inside a CONVERTED block in the column that says no work is');
console.log('  needed. The legacy pair is printed beside each row so an old §24');
console.log('  table can be lined up against this one rather than guessed at:');
console.log('    legacy inTx  == inTxUnconverted');
console.log('    legacy outTx == inTxConverted + outsideAny');
let invisibleRows = 0, recoloured = 0;
for (const r of ok) {
  if (!r.dual.length) continue;
  const dualCtx = r.dual.filter(x => x.outsideAny > 0);
  // A helper the old table could not print AT ALL: it listed only helpers with
  // at least one call inside an UNCONVERTED block, so a helper whose only
  // transaction context is a converted one was absent, not merely mis-columned.
  invisibleRows += r.dual.filter(x => x.legacyInTx === 0).length;
  recoloured += r.dual.filter(x => x.legacyInTx > 0 && x.inTxConverted > 0).length;
  console.log(`  ${r.rel} — ${r.dual.length} helpers called inside a transaction, ${dualCtx.length} of them ALSO outside both:`);
  for (const x of r.dual) {
    const flags = [];
    if (x.outsideAny > 0) flags.push('DUAL CONTEXT');
    if (x.inTxConverted > 0) flags.push(`WAS MISFILED AS outTx (legacy read ${x.legacyInTx}/${x.legacyOutTx})`);
    console.log(`    ${x.name.padEnd(32)} L${String(x.line).padStart(5)}`
      + `  inTxUnconv=${String(x.inTxUnconverted).padStart(2)}`
      + `  inTxConv=${String(x.inTxConverted).padStart(2)}`
      + `  outsideAny=${String(x.outsideAny).padStart(3)}`
      + (flags.length ? `   <-- ${flags.join(' · ')}` : ''));
  }
}
console.log('');
console.log('  HOW THIS TABLE RELATES TO THE ONE §24 QUOTES — counted, not asserted:');
console.log(`    helpers the old table could not print AT ALL : ${invisibleRows}`);
console.log('      Their only transaction context is a converted block, and the old');
console.log('      table listed a helper only if it had a call inside an unconverted');
console.log('      one. Absent from the table, not mis-columned within it.');
console.log(`    printed rows whose outTx hid a converted call : ${recoloured}`);
console.log('      Any row here read as "also called outside a transaction" when part');
console.log('      of that count was inside one.');
console.log('    Every other printed row keeps both of its old numbers exactly. What');
console.log('    changed for those is what the second column MEANS, not its value:');
console.log('    "outside a db.transaction()" is not "outside a transaction".');

if (jsonPath) {
  fs.writeFileSync(jsonPath, JSON.stringify({ totals, files: ok }, null, 2));
  console.log('\nJSON written to', jsonPath);
}
