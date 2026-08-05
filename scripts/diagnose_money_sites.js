#!/usr/bin/env node
/**
 * diagnose_money_sites.js — census of every statement site that touches a MONEY
 * column, across the whole in-scope surface, with the template-placeholder blind
 * spot closed.
 *
 * WHY THIS EXISTS
 * ---------------
 * The money detection we had lives inside scripts/diagnose_seam_statements.js. It
 * prepares each statement against a scratch schema and reads statement.columns(),
 * which is the right way to resolve a column — but it can only do that for a
 * statement it can extract as a LITERAL. Any `.prepare(` whose argument contains a
 * `${...}` is counted as "dynamically built and NOT executed" and never reaches the
 * money test at all. That is stated in its output, but a statement that is never
 * classified is a statement that is never counted, and the money totals it produces
 * are therefore floors, not counts.
 *
 * It bit us. On the 62 UNRESOLVED survey all four routes/retail.js money sites were
 * missed, because in every one of them the money column arrives through a variable:
 *
 *     const owed = hasPricing
 *       ? 'COALESCE(pp.excel_gz_price, pp.excel_retail, sp.sell_price, 0)'
 *       : 'COALESCE(sp.sell_price, 0)';
 *     ... db.prepare(`SELECT ${bkL} AS bucket, -l.delta AS units, ${owed} AS owed ...`)
 *
 * The literal source text of that statement names no money column. The value is a
 * plain string constant twelve lines up. They were found by hand-reading, which is
 * not a method that scales to 2,799 statement sites.
 *
 * WHAT THIS DOES DIFFERENTLY
 * --------------------------
 * It resolves the statement expression statically before classifying it:
 *
 *   ${var}                 template placeholders, including nested templates
 *   'a' + b + 'c'          concatenation, and the `q += ' AND …'` append form
 *   x ? 'a' : 'b'          ternaries — BOTH branches, as separate variants
 *   sets.join(', ')        column lists assembled from `sets.push('sell_price = ?')`
 *   FIELDS.join(',')       and from array literals, through .filter()/.slice()
 *   cols.map(c => …)       with the element substituted into the callback
 *   ...tdb().prepare(      spread prefixes, for the HANDLE the statement runs on
 *
 * Everything it cannot resolve is substituted with an opaque `__DYN__` token,
 * counted, and REPORTED — never silently dropped. The residual is the honest blind
 * spot and is printed as such on every run, together with how many of those
 * statements sit on tables that carry money columns, which is the size of the
 * region where the answer is UNKNOWN rather than clean.
 *
 * Scope is tracked well enough that a shadowed name is not answered with the wrong
 * binding: a receiver that is a function PARAMETER is reported as UNRESOLVED rather
 * than attributed to a module-level `const db = require('../database')` of the same
 * name. Guessing there is how a coverage number turns back into a claim.
 *
 * THE MONEY RULE IS OBEYED EXACTLY (decisions §"MONEY IS RESOLVED BY SCHEMA CLASS")
 * --------------------------------------------------------------------------------
 * A column is money if and only if scripts/postgres-full-copy/plan.json gives it
 * conversion class CENTS or NUM6. 101 columns. No name pattern, no SQLite type, no
 * judgement about what a column looks like it means. A reference counts as a hit
 * only when it also resolves to a table the statement actually names — so
 * `invoices.amount` in a statement that never mentions `invoices` is not a hit.
 *
 * WHAT IT CANNOT DO, SAID PLAINLY
 * -------------------------------
 * This resolves TEXT, not VALUES. A column name that arrives from a request
 * parameter, a database row, a function argument, or a module it does not read is
 * outside static reach by construction — no amount of scanner work reaches it, and
 * the residual list at the end of the report is exactly that set. It is also not a
 * schema resolver: diagnose_seam_statements.js asking SQLite via statement.columns()
 * is a stronger answer for the statements it CAN reach. The two are complementary,
 * and this one is deliberately the wider, weaker net.
 *
 * READ-ONLY, AND OPENS NOTHING. No database is opened — not the live SQLite file,
 * not a scratch one, not Postgres. It reads source files and plan.json and nothing
 * else, and it has no dependencies outside Node's standard library.
 *
 * Run:  node scripts/diagnose_money_sites.js [repo-root] [--json] [--all-sites]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ARGS = process.argv.slice(2);
const AS_JSON = ARGS.includes('--json');
const ALL_SITES = ARGS.includes('--all-sites');   // list every money site, not just the new ones
const REPO = ARGS.find((a) => !a.startsWith('--')) || path.join(__dirname, '..');

// ════════════════════════════════════════════════════════════════════════════
// 1 · SCOPE — the same rule db-seam-coverage.js uses, for the same reason
// ════════════════════════════════════════════════════════════════════════════
// A file is IN SCOPE if it can reach the LIVE database on an ongoing, unattended
// basis. Everything in routes/, lib/, middleware/, plus server.js and database.js,
// plus the six channel daemons. The one-off scripts are scanned too but reported
// separately, so the exclusion stays visible instead of quietly improving a number.
const RUNTIME_DIRS = ['routes', 'lib', 'middleware'];
const RUNTIME_FILES = ['server.js', 'database.js'];
const BACKGROUND_DIRS = ['scripts'];
const IN_SCOPE_SCRIPTS = new Set([
  'scripts/guanyi-daemon.js',
  'scripts/meituan-daemon.js',
  'scripts/shangou-daemon.js',
  'scripts/gzgrocery-order-daemon.js',
  'scripts/qingyun-daemon.js',
  'scripts/eleme-daemon.js',
]);
// The seam's own tooling holds raw handles by design; counting it would report a
// deficit that must never be closed. Same precedent as db-seam-coverage.js's SKIP
// and the SKIP set in diagnose_money_unit_mixing.py. This file is added because it
// quotes the retail.js `${owed}` statement in its own header.
const SKIP = new Set([
  'scripts/diagnose_store_hours_seam.js',
  'scripts/diagnose_seam_batch.js',
  'scripts/db-seam-coverage.js',
  'scripts/diagnose_money_sites.js',
  'scripts/diagnose_money_unit_split.js',   // holds verbatim copies of the pre-fix statements
]);

const rel = (p) => p.split(path.sep).join('/');
function jsFilesIn(dir) {
  const abs = path.join(REPO, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.isDirectory()) { out.push(...jsFilesIn(path.join(dir, e.name))); continue; }
    if (!e.name.endsWith('.js')) continue;
    const r = rel(path.join(dir, e.name));
    if (!SKIP.has(r)) out.push(r);
  }
  return out.sort();
}

// ════════════════════════════════════════════════════════════════════════════
// 2 · THE MONEY COLUMNS — read from the census, never inferred
// ════════════════════════════════════════════════════════════════════════════
const PLAN_JSON = path.join(REPO, 'scripts', 'postgres-full-copy', 'plan.json');
const plan = JSON.parse(fs.readFileSync(PLAN_JSON, 'utf8'));
const MONEY = new Map();              // table -> Map(column -> class)
const MONEY_BY_NAME = new Map();      // column -> [{ table, cls }]
let moneyColCount = 0;
for (const [t, tv] of Object.entries(plan.tables)) {
  for (const c of tv.cols || []) {
    if (c.cls !== 'CENTS' && c.cls !== 'NUM6') continue;
    if (!c.sq) continue;
    if (!MONEY.has(t)) MONEY.set(t, new Map());
    MONEY.get(t).set(c.sq, c.cls);
    if (!MONEY_BY_NAME.has(c.sq)) MONEY_BY_NAME.set(c.sq, []);
    MONEY_BY_NAME.get(c.sq).push({ table: t, cls: c.cls });
    moneyColCount++;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 3 · SOURCE SCANNING — strings, templates, regex literals and comments
// ════════════════════════════════════════════════════════════════════════════
// Everything below depends on knowing, at every offset, whether we are in code.
// Two of the three known blind spots in the coverage checker were failures of
// exactly this: a regex literal containing a quote put it into string mode, and a
// `//` inside a URL string ate the rest of a line. Both are handled here, and
// NESTED templates inside ${...} are tracked properly by recursion rather than by
// scanning to the next backtick.
const REGEX_OK_BEFORE = /[(,=:[!&|?{};+\-*%~^<>]$|\b(return|typeof|case|in|of|do|else|yield|await)$/;

// Returns the offset just past the construct starting at i, or -1 if src[i] does
// not start one. Handles // and /* */ comments, ' " ` strings, and regex literals.
function skipConstruct(src, i, prevCode) {
  const c = src[i], d = src[i + 1];
  if (c === '/' && d === '/') { let k = i + 2; while (k < src.length && src[k] !== '\n') k++; return k; }
  if (c === '/' && d === '*') { let k = i + 2; while (k < src.length && !(src[k] === '*' && src[k + 1] === '/')) k++; return Math.min(k + 2, src.length); }
  if (c === '"' || c === "'") {
    let k = i + 1;
    while (k < src.length) {
      if (src[k] === '\\') { k += 2; continue; }
      if (src[k] === c) return k + 1;
      if (src[k] === '\n') return k;                 // unterminated: do not run away
      k++;
    }
    return k;
  }
  if (c === '`') return skipTemplate(src, i);
  if (c === '/' && REGEX_OK_BEFORE.test(prevCode)) {
    let k = i + 1, inClass = false;
    while (k < src.length) {
      const r = src[k];
      if (r === '\\') { k += 2; continue; }
      if (r === '\n') break;
      if (r === '[') inClass = true;
      else if (r === ']') inClass = false;
      else if (r === '/' && !inClass) { k++; break; }
      k++;
    }
    while (k < src.length && /[a-z]/.test(src[k])) k++;
    return k;
  }
  return -1;
}

// A template literal, including every ${...} in it. The expression inside ${} is
// real code and may hold further templates, strings, comments and braces; this
// recurses so `${x ? `<b>${y}</b>` : ''}` — which appears throughout retail.js —
// stays in step instead of ending the template at the first inner backtick.
function skipTemplate(src, i) {
  let k = i + 1;
  while (k < src.length) {
    if (src[k] === '\\') { k += 2; continue; }
    if (src[k] === '`') return k + 1;
    if (src[k] === '$' && src[k + 1] === '{') {
      k = skipBraced(src, k + 1);
      continue;
    }
    k++;
  }
  return k;
}

// From the `{` at position i to just past its matching `}`.
function skipBraced(src, i) {
  let k = i + 1, depth = 1, prev = '';
  while (k < src.length && depth > 0) {
    const s = skipConstruct(src, k, prev);
    if (s !== -1) { k = s; prev = 'x'; continue; }
    if (src[k] === '{') depth++;
    else if (src[k] === '}') depth--;
    if (!/\s/.test(src[k])) prev = src[k];
    k++;
  }
  return k;
}

// Walk a source file and hand every CODE offset to the visitor. Constructs are
// skipped wholesale, so a `.prepare(` inside a SQL string is never a call site.
function walkCode(src, visit) {
  let i = 0, prev = '';
  while (i < src.length) {
    const s = skipConstruct(src, i, prev);
    if (s !== -1) { i = s; prev = 'x'; continue; }
    const jump = visit(i);
    if (typeof jump === 'number' && jump > i) { i = jump; prev = 'x'; continue; }
    if (!/\s/.test(src[i])) prev += src[i];
    if (prev.length > 24) prev = prev.slice(-24);
    i++;
  }
}

const lineIndex = (src) => {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return (off) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
};

// ── every `.prepare(` site, with its receiver and its argument expression ────
const PREPARE = /^\.\s*prepare\s*\(/;

function prepareSites(src) {
  const lineOf = lineIndex(src);
  const sites = [];
  walkCode(src, (i) => {
    if (src[i] !== '.') return;
    const m = PREPARE.exec(src.slice(i, i + 20));
    if (!m) return;
    const open = i + m[0].length - 1;               // index of the '('
    const close = matchParen(src, open);
    sites.push({
      line: lineOf(i),
      offset: i,
      receiver: receiverBefore(src, i),
      argSrc: src.slice(open + 1, close).trim(),
    });
    return open + 1;                                // resume inside the argument
  });
  return sites;
}

function matchParen(src, open) {
  let k = open + 1, depth = 1, prev = '(';
  while (k < src.length && depth > 0) {
    const s = skipConstruct(src, k, prev);
    if (s !== -1) { k = s; prev = 'x'; continue; }
    const c = src[k];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (depth === 0) return k;
    if (!/\s/.test(c)) prev = c;
    k++;
  }
  return src.length;
}

// Walk backwards from the `.` of `.prepare(` to recover the receiver expression.
// Balances brackets so tdb().prepare( and getTenantDb(id).prepare( come back whole.
//
// THE SPREAD PREFIX. `picks.push(...tdb().prepare(...))` — six sites in retail.js —
// walks back into `...tdb()`, which the coverage checker's receiver recovery then
// fails to classify (its inline test is anchored with ^ and its binding lookup wants
// an identifier at the start), so six demonstrably TENANT sites land in UNRESOLVED.
// The leading dots are punctuation, not part of the expression: they are stripped.
function receiverBefore(src, dotIdx) {
  let i = dotIdx - 1, depth = 0;
  // `const f = (id) => db\n  .prepare(…)` — routes/finance.js:490 and
  // routes/retail-purchasing.js:485, both money reads. The receiver is on the
  // previous line, so a walk that stops at the first non-word character recovers
  // nothing and the site is filed as unattributable. Step over the break first.
  while (i >= 0 && /\s/.test(src[i])) i--;
  while (i >= 0) {
    const c = src[i];
    if (c === ')' || c === ']') { depth++; i--; continue; }
    if (c === '(' || c === '[') { if (depth === 0) break; depth--; i--; continue; }
    if (depth === 0 && !/[\w$.]/.test(c)) break;
    i--;
  }
  let raw = src.slice(i + 1, dotIdx).trim();
  raw = raw.replace(/^\.{3}/, '');                  // spread prefix: `...tdb()`
  if (!raw) return null;
  if (/\bnew\s*$/.test(src.slice(Math.max(0, i - 6), i + 1))) return 'new ' + raw;
  return raw;
}

// ── function scopes, so a shadowed name is not answered with the wrong binding ─
// `function guanyiPickupSales(db, from, to)` — the four retail.js money sites — uses
// a receiver named `db` that is a PARAMETER. routes/retail.js also has a module-level
// `const db = require('../database')` on line 18. A file-level binding lookup answers
// DIRECT for those sites, confidently and wrongly: what that handle is depends on the
// caller. Scope is therefore tracked, and a parameter receiver is reported as
// UNRESOLVED (param) rather than guessed at — the same discipline as currentTenantId()
// no longer answering "Roots" when it cannot tell.
function functionScopes(src) {
  const scopes = [];
  walkCode(src, (i) => {
    // function declarations and expressions
    if (/^function\b/.test(src.slice(i, i + 9)) && !/[\w$.]/.test(src[i - 1] || ' ')) {
      let k = i + 8;
      while (k < src.length && src[k] !== '(' && src[k] !== '{') k++;
      if (src[k] !== '(') return;
      const close = matchParen(src, k);
      let b = close + 1;
      while (b < src.length && /\s/.test(src[b])) b++;
      if (src[b] !== '{') return;
      scopes.push({ start: b, end: matchBrace(src, b), params: paramNames(src.slice(k + 1, close)) });
      return;
    }
    // arrow functions: (a, b) => …  and  a => …
    if (src[i] === '=' && src[i + 1] === '>') {
      let j = i - 1;
      while (j >= 0 && /\s/.test(src[j])) j--;
      let params;
      if (src[j] === ')') {
        const open = backToOpen(src, j);
        if (open < 0) return;
        params = paramNames(src.slice(open + 1, j));
      } else {
        let e = j;
        while (e >= 0 && /[\w$]/.test(src[e])) e--;
        if (e === j) return;
        params = paramNames(src.slice(e + 1, j + 1));
      }
      let b = i + 2;
      while (b < src.length && /\s/.test(src[b])) b++;
      const end = src[b] === '{' ? matchBrace(src, b) : exprEnd(src, b);
      scopes.push({ start: b, end, params });
      return;
    }
  });
  return scopes;
}
const paramNames = (txt) => new Set(
  txt.split(',').map((p) => (/^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(p) || [])[1]).filter(Boolean));
function matchBrace(src, open) {
  let k = open + 1, depth = 1, prev = '{';
  while (k < src.length && depth > 0) {
    const s = skipConstruct(src, k, prev);
    if (s !== -1) { k = s; prev = 'x'; continue; }
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return k + 1; }
    if (!/\s/.test(src[k])) prev = src[k];
    k++;
  }
  return k;
}
function backToOpen(src, closeIdx) {
  let k = closeIdx - 1, depth = 0;
  while (k >= 0) {
    if (src[k] === ')' || src[k] === ']' || src[k] === '}') depth++;
    else if (src[k] === '(') { if (depth === 0) return k; depth--; }
    else if (src[k] === '[' || src[k] === '{') depth--;
    k--;
  }
  return -1;
}

// ── how the handle was obtained ─────────────────────────────────────────────
const DB_REQUIRE = /require\(\s*['"][^'"]*\/?database['"]\s*\)/;
const classifyBinding = (rhs) =>
  /\bseam\s*\(/.test(rhs) ? 'SEAM'
  : /\bnew\s+Database\s*\(/.test(rhs) ? 'RAW_OPEN'
  : DB_REQUIRE.test(rhs) ? 'DIRECT'
  : /\b(?:tdb|getTenantDb)\s*\(/.test(rhs) ? 'TENANT'
  : /\breq\.tenantDb\b/.test(rhs) ? 'TENANT'
  : null;
const classifyInline = (recv) =>
  /^seam\s*\(/.test(recv) ? 'SEAM'
  : /^new\s+Database\s*\(/.test(recv) ? 'RAW_OPEN'
  : /^(?:tdb|getTenantDb)\s*\(/.test(recv) ? 'TENANT'
  : /^req\.tenantDb$/.test(recv) ? 'TENANT'
  : null;

// ════════════════════════════════════════════════════════════════════════════
// 4 · STATIC EVALUATION — the fix
// ════════════════════════════════════════════════════════════════════════════
// Turn a prepare() argument expression into the SQL text(s) it can produce.
// Returns { variants: [string], dyn: [expression source] }. A ternary yields BOTH
// branches as separate variants rather than a spliced hybrid, because a hybrid can
// invent a table alias that never co-occurs with the column that uses it —
// `${hasPricing ? 'LEFT JOIN guanyi_product_pricing pp …' : ''}` is exactly that
// shape. Anything unresolvable becomes the opaque token __DYN__, which matches no
// column name, and is recorded so the residual can be reported.
const DYN = '__DYN__';
const MAX_VARIANTS = 16;

// `bindings` here is a lookup function: name -> [right-hand side source, …], already
// resolved against the site's scope chain by makeResolver() below.
function evalExpr(src, bindings, depth, seen) {
  const s = stripComments(src);
  if (depth > 5) return { variants: [DYN], dyn: [s] };

  // Parenthesised whole expression.
  if (s.startsWith('(') && matchParen(s, 0) === s.length - 1) {
    return evalExpr(s.slice(1, -1), bindings, depth + 1, seen);
  }
  // Ternary at top level -> both branches.
  const t = splitTernary(s);
  if (t) {
    const a = evalExpr(t.cons, bindings, depth + 1, seen);
    const b = evalExpr(t.alt, bindings, depth + 1, seen);
    return { variants: cap([...a.variants, ...b.variants]), dyn: [...a.dyn, ...b.dyn] };
  }
  // Concatenation at top level.
  const parts = splitConcat(s);
  if (parts) {
    let variants = [''], dyn = [];
    for (const p of parts) {
      const r = evalExpr(p, bindings, depth + 1, seen);
      dyn = dyn.concat(r.dyn);
      variants = cap(variants.flatMap((v) => r.variants.map((w) => v + w)));
    }
    return { variants, dyn };
  }
  // Numeric and boolean literals interpolate as their own text — `datetime('now',
  // '-${LOCK_TTL_MIN} minutes')` with `const LOCK_TTL_MIN = 10` is a fully resolved
  // statement, and reporting it as residual would inflate the unknown region.
  if (/^-?\d+(?:\.\d+)?$/.test(s) || s === 'true' || s === 'false') return { variants: [s], dyn: [] };
  // String literal.
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    if (skipConstruct(s, 0, '=') === s.length) return { variants: [s.slice(1, -1)], dyn: [] };
  }
  // Template literal.
  if (s.startsWith('`') && skipTemplate(s, 0) === s.length) {
    return evalTemplate(s, bindings, depth, seen);
  }
  // `sets.join(', ')`, `FIELDS.join(',')`, `cols.map(c => `${c} = ?`).join(', ')` —
  // the assembled column list. This is where the money writes hide: the statement
  // names no column of its own, and the columns it will write are literals pushed or
  // listed elsewhere in the same file. Every fragment visible from this site is
  // unioned, which over-approximates the branches that actually fire — the right
  // direction, because a money column present in ANY branch means the statement can
  // carry money.
  const call = splitTrailingCall(s);
  if (call && call.method === 'join') {
    const sepEval = call.args.trim() ? evalExpr(call.args, bindings, depth + 1, seen) : { variants: [','] };
    const sep = (sepEval.variants[0] === DYN || sepEval.variants[0] === undefined) ? ' , ' : sepEval.variants[0];
    const inner = splitTrailingCall(call.recv);
    const mapped = inner && inner.method === 'map';
    const els = elementsOfExpr(mapped ? inner.recv : call.recv, bindings, new Set());
    const arrow = mapped ? parseArrow(inner.args) : null;
    if (mapped && arrow && !arrow.param) {
      // `xs.map(() => '?')` — the element cannot depend on anything, so its text is
      // fully known even though the LENGTH is a run-time fact. One element is enough:
      // a list of question marks names no column.
      const r = evalExpr(arrow.body, bindings, depth + 1, seen);
      if (r.variants[0] !== DYN) return { variants: [r.variants[0]], dyn: r.dyn };
    }
    if (els && els.length) {
      let dyn = [], texts = [];
      for (const el of els.slice(0, 80)) {
        let r;
        if (mapped && arrow && arrow.param) {
          const sub = (name) => (name === arrow.param ? [el] : bindings(name));
          sub.elements = bindings.elements;
          r = evalExpr(arrow.body, sub, depth + 1, seen);
        } else if (mapped && !arrow) {
          r = { variants: [DYN], dyn: [inner.args] };
        } else {
          r = evalExpr(el, bindings, depth + 1, seen);
        }
        dyn = dyn.concat(r.dyn);
        texts.push(r.variants[0]);
      }
      return { variants: [texts.join(sep)], dyn };
    }
  }

  // A bare identifier: the ${owed} case. Resolve it against the bindings visible
  // from the site — innermost scope first, then module scope.
  if (/^[A-Za-z_$][\w$]*$/.test(s)) {
    const bound = bindings(s);
    if (!bound || !bound.length || seen.has(s)) return { variants: [DYN], dyn: [s] };
    const next = new Set(seen); next.add(s);
    let variants = [], dyn = [];
    for (const rhs of bound.slice(0, 4)) {
      const r = evalExpr(rhs, bindings, depth + 1, next);
      variants = variants.concat(r.variants); dyn = dyn.concat(r.dyn);
    }
    return { variants: cap(variants), dyn };
  }
  return { variants: [DYN], dyn: [s] };
}

function evalTemplate(s, bindings, depth, seen) {
  let variants = [''], dyn = [], buf = '', k = 1;
  const flush = () => { if (buf) { const b = buf; variants = variants.map((v) => v + b); buf = ''; } };
  while (k < s.length - 1) {
    if (s[k] === '\\') { buf += s[k + 1]; k += 2; continue; }
    if (s[k] === '$' && s[k + 1] === '{') {
      const end = skipBraced(s, k + 1);
      const inner = s.slice(k + 2, end - 1);
      flush();
      const r = evalExpr(inner, bindings, depth + 1, seen);
      dyn = dyn.concat(r.dyn);
      variants = cap(variants.flatMap((v) => r.variants.map((w) => v + w)));
      k = end; continue;
    }
    buf += s[k]; k++;
  }
  flush();
  return { variants: cap(variants), dyn };
}

const cap = (v) => [...new Set(v)].slice(0, MAX_VARIANTS);

// Comments inside an expression — a commented array literal is common — are not
// part of the value. Strings and templates are stepped over, so a `//` inside a URL
// is not mistaken for one.
function stripComments(src) {
  let out = '', i = 0, prev = '';
  while (i < src.length) {
    if (src[i] === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) { i = skipConstruct(src, i, prev); continue; }
    const c = skipConstruct(src, i, prev);
    if (c !== -1) { out += src.slice(i, c); i = c; prev = 'x'; continue; }
    out += src[i];
    if (!/\s/.test(src[i])) prev = src[i];
    i++;
  }
  return out.trim();
}

// The elements an array expression can hold, as expression sources. `.filter()`,
// `.slice()` and `.sort()` can only narrow or reorder a list, so resolving through
// them to the underlying array is a sound OVER-approximation: it can name a column
// the statement will not actually write, never miss one it will.
function elementsOfExpr(expr, bindings, seen) {
  const s = stripComments(expr || '');
  if (!s || seen.size > 6) return null;
  if (s.startsWith('[') && s.endsWith(']')) {
    let out = [];
    for (const p of splitArgs(s.slice(1, -1))) {
      const t = stripComments(p);
      if (!t) continue;                                    // a comment-only line in the array
      if (t.startsWith('...')) { const e = elementsOfExpr(t.slice(3), bindings, seen); if (e) out = out.concat(e); }
      else out.push(t);
    }
    return out;
  }
  if (/^[A-Za-z_$][\w$]*$/.test(s)) {
    if (seen.has(s)) return null;
    const next = new Set(seen); next.add(s);
    let out = (bindings.elements ? bindings.elements(s) : []).slice();
    for (const rhs of bindings(s) || []) {
      const e = elementsOfExpr(rhs, bindings, next);
      if (e) out = out.concat(e);
    }
    return out.length ? out : null;
  }
  const call = splitTrailingCall(s);
  if (call && ['filter', 'slice', 'sort', 'reverse', 'flat'].includes(call.method)) {
    return elementsOfExpr(call.recv, bindings, seen);
  }
  if (call && call.method === 'concat') {
    const a = elementsOfExpr(call.recv, bindings, seen) || [];
    const b = splitArgs(call.args).flatMap((x) => elementsOfExpr(x, bindings, seen) || []);
    return a.concat(b).length ? a.concat(b) : null;
  }
  return null;
}

// `a.b.method(args)` at the end of an expression -> { recv, method, args }.
function splitTrailingCall(s) {
  if (!s.endsWith(')')) return null;
  let prev = '';
  for (let i = 0; i < s.length; i++) {
    const c = skipConstruct(s, i, prev);
    if (c !== -1) { i = c - 1; prev = 'x'; continue; }
    if (s[i] === '(' || s[i] === '[' || s[i] === '{') {
      const end = s[i] === '(' ? matchParen(s, i) : skipGroup(s, i);
      if (s[i] === '(' && end === s.length - 1) {
        const head = s.slice(0, i);
        const m = /\.\s*([A-Za-z_$][\w$]*)\s*$/.exec(head);
        if (!m) return null;
        return { recv: head.slice(0, m.index).trim(), method: m[1], args: s.slice(i + 1, end) };
      }
      i = end; prev = 'x'; continue;
    }
    if (!/\s/.test(s[i])) prev = s[i];
  }
  return null;
}
function skipGroup(s, open) {
  const closer = { '[': ']', '{': '}' }[s[open]];
  let k = open + 1, depth = 1, prev = s[open];
  while (k < s.length && depth > 0) {
    const c = skipConstruct(s, k, prev);
    if (c !== -1) { k = c; prev = 'x'; continue; }
    if (s[k] === s[open]) depth++;
    else if (s[k] === closer) { depth--; if (!depth) return k; }
    if (!/\s/.test(s[k])) prev = s[k];
    k++;
  }
  return k;
}

// `(x) => body`, `x => body`, `() => body`. Returns null for anything else —
// a function expression, a method reference, a multi-statement body.
function parseArrow(src) {
  const s = (src || '').trim();
  let m = /^\(\s*([A-Za-z_$][\w$]*)?\s*\)\s*=>\s*([\s\S]+)$/.exec(s) || /^([A-Za-z_$][\w$]*)\s*=>\s*([\s\S]+)$/.exec(s);
  if (!m) return null;
  const body = m[2].trim();
  if (body.startsWith('{')) return null;                    // a block body, not an expression
  return { param: m[1] || null, body };
}

// `a ? b : c` at depth 0. `?.` and `??` are not ternaries and must not be split on.
function splitTernary(s) {
  let depth = 0, prev = '', q = -1;
  for (let i = 0; i < s.length; i++) {
    const c = skipConstruct(s, i, prev);
    if (c !== -1) { i = c - 1; prev = 'x'; continue; }
    const ch = s[i];
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (depth === 0 && ch === '?' && s[i + 1] !== '.' && s[i + 1] !== '?' && prev.slice(-1) !== '?') { q = i; break; }
    if (!/\s/.test(ch)) prev += ch;
  }
  if (q === -1) return null;
  let depth2 = 0, prev2 = '';
  for (let i = q + 1; i < s.length; i++) {
    const c = skipConstruct(s, i, prev2);
    if (c !== -1) { i = c - 1; prev2 = 'x'; continue; }
    const ch = s[i];
    if ('([{'.includes(ch)) depth2++;
    else if (')]}'.includes(ch)) depth2--;
    else if (depth2 === 0 && ch === '?') return null;          // nested ternary: leave it
    else if (depth2 === 0 && ch === ':') return { cons: s.slice(q + 1, i), alt: s.slice(i + 1) };
    if (!/\s/.test(ch)) prev2 += ch;
  }
  return null;
}

// Top-level `+` operands, or null when there is no top-level `+`.
function splitConcat(s) {
  const parts = [];
  let depth = 0, start = 0, prev = '', found = false;
  for (let i = 0; i < s.length; i++) {
    const c = skipConstruct(s, i, prev);
    if (c !== -1) { i = c - 1; prev = 'x'; continue; }
    const ch = s[i];
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (depth === 0 && ch === '+' && s[i + 1] !== '+' && prev.slice(-1) !== '+') {
      parts.push(s.slice(start, i)); start = i + 1; found = true;
    }
    if (!/\s/.test(ch)) prev += ch;
  }
  if (!found) return null;
  parts.push(s.slice(start));
  return parts;
}

// ── bindings, with the scope they were declared in ──────────────────────────
// Every `name = expression` in the file, recorded with its offset so it can be
// resolved against the scope chain of the site that uses it. Block scope inside a
// function is not modelled — function scope is — because the failure it has to
// avoid is a PARAMETER being answered with a module-level binding of the same name,
// and that is a function-scope question.
function collectBindings(src) {
  const out = [];
  walkCode(src, (i) => {
    const m = /^(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(\+?=)(?!=)\s*/.exec(src.slice(i, i + 80));
    if (!m) return;
    if (i > 0 && /[\w$.]/.test(src[i - 1])) return;            // token boundary only
    const valStart = i + m[0].length;
    const end = exprEnd(src, valStart);
    if (end <= valStart) return;
    out.push({ name: m[1], rhs: src.slice(valStart, end).trim(), offset: i, append: m[2] === '+=' });
  });
  return out;
}

// `sets.push('sell_price = ?')` — the OTHER way a statement is assembled, and the
// one that matters most: `UPDATE store_products SET ${sets.join(', ')}` names no
// column at all in its source, and the columns it will write are pushed one per
// `if (field in body)` branch, as string literals, in the same function. That is
// statically reachable, and whether one of those literals is a money column is
// precisely the question this scanner exists to answer.
function collectPushes(src) {
  const out = [];
  walkCode(src, (i) => {
    const m = /^([A-Za-z_$][\w$]*)\s*\.\s*push\s*\(/.exec(src.slice(i, i + 60));
    if (!m) return;
    if (i > 0 && /[\w$.]/.test(src[i - 1])) return;
    const open = i + m[0].length - 1;
    const close = matchParen(src, open);
    for (const arg of splitArgs(src.slice(open + 1, close))) out.push({ name: m[1], rhs: arg.trim(), offset: i });
    return close;
  });
  return out;
}

// Top-level comma-separated arguments.
function splitArgs(txt) {
  const out = [];
  let depth = 0, start = 0, prev = '';
  for (let i = 0; i < txt.length; i++) {
    const s = skipConstruct(txt, i, prev);
    if (s !== -1) { i = s - 1; prev = 'x'; continue; }
    const c = txt[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { out.push(txt.slice(start, i)); start = i + 1; }
    if (!/\s/.test(c)) prev = c;
  }
  out.push(txt.slice(start));
  return out.filter((x) => x.trim());
}

// Resolve a name as seen from a given offset: innermost enclosing function first,
// then module scope, then — flagged — anywhere in the file.
function makeResolver(src) {
  const scopes = functionScopes(src).sort((a, b) => a.start - b.start || b.end - a.end);
  const bindings = collectBindings(src);
  const pushes = collectPushes(src);
  const innermost = (off) => {
    let best = null;
    for (const s of scopes) { if (s.start <= off && off < s.end && (!best || s.start > best.start)) best = s; }
    return best;
  };
  const chain = (off) => {
    const out = [];
    for (const s of scopes) if (s.start <= off && off < s.end) out.push(s);
    return out.sort((a, b) => b.start - a.start);              // innermost first
  };
  const declScope = new Map();                                  // binding -> its scope (or null)
  for (const b of bindings) declScope.set(b, innermost(b.offset));

  // `let q = '…'; if (x) q += ' AND p.sell_price > ?'` — the append-built statement.
  // Each fragment is a separate binding; the statement the application prepares is
  // the base with every fragment appended. That whole form is offered as one extra
  // right-hand side, expressed as a concatenation the evaluator already understands.
  // It unions the conditional branches, which over-approximates on purpose: a money
  // column that appears only in an appended WHERE clause is exactly what a scan of
  // the base literal misses.
  const withAppends = (list) => {
    const bases = list.filter((b) => !b.append).map((b) => b.rhs);
    const appends = list.filter((b) => b.append).map((b) => b.rhs);
    if (!appends.length) return bases.slice(0, 4);
    const whole = [...(bases.length ? [bases[0]] : []), ...appends].map((r) => `(${r})`).join(' + ');
    return [...bases.slice(0, 3), whole];
  };

  // What kind of thing is this name at this offset?
  const classify = (name, off) => {
    for (const s of chain(off)) {
      if (s.params.has(name)) return { kind: 'param', rhss: [] };
      const here = bindings.filter((b) => b.name === name && declScope.get(b) === s);
      if (here.length) return { kind: 'local', rhss: withAppends(here) };
    }
    const mod = bindings.filter((b) => b.name === name && declScope.get(b) === null);
    if (mod.length) return { kind: 'module', rhss: withAppends(mod) };
    const any = bindings.filter((b) => b.name === name);
    if (any.length) return { kind: 'elsewhere', rhss: withAppends(any) };
    return { kind: 'none', rhss: [] };
  };
  // Elements pushed onto an array, narrowed to the scope the site sits in — the
  // same scope discipline as bindings, so one handler's `sets` is not answered with
  // another handler's.
  const pushScope = new Map();
  for (const p of pushes) pushScope.set(p, innermost(p.offset));
  const elementsOf = (name, off) => {
    for (const s of chain(off)) {
      const here = pushes.filter((p) => p.name === name && pushScope.get(p) === s);
      if (here.length) return here.map((p) => p.rhs);
    }
    const mod = pushes.filter((p) => p.name === name && pushScope.get(p) === null);
    return mod.map((p) => p.rhs);
  };

  // The lookup handed to evalExpr: SQL fragments only, so an `elsewhere` match is
  // accepted (over-approximating a column name is recoverable; the report prints the
  // substitution). A PARAMETER is never guessed at.
  const forSql = (off) => {
    const look = (name) => {
      const c = classify(name, off);
      return c.kind === 'param' ? [] : c.rhss;
    };
    look.elements = (name) => elementsOf(name, off);
    return look;
  };
  return { classify, forSql };
}

// End of an expression: the first `;` or `,` or newline at depth 0, or the closing
// bracket of the enclosing construct.
function exprEnd(src, start) {
  let k = start, depth = 0, prev = '';
  while (k < src.length) {
    const s = skipConstruct(src, k, prev);
    if (s !== -1) { k = s; prev = 'x'; continue; }
    const c = src[k];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (depth === 0) return k; depth--; }
    else if (depth === 0 && (c === ';' || c === ',')) return k;
    else if (depth === 0 && c === '\n') {
      // A newline ends the expression unless the line so far is clearly unfinished.
      const sofar = src.slice(start, k).trim();
      if (sofar && !/[+?:=([{,|&]$/.test(sofar) && !/^\s*[?:.+]/.test(src.slice(k + 1, k + 40))) return k;
    }
    if (!/\s/.test(c)) prev = c;
    k++;
  }
  return k;
}

// ════════════════════════════════════════════════════════════════════════════
// 5 · MONEY CLASSIFICATION — class from the census, table from the statement
// ════════════════════════════════════════════════════════════════════════════
const SQL_KEYWORDS = new Set(('select from join where and or on as left right inner outer full cross group by order ' +
  'having limit offset set values into insert update delete case when then else end not null is in like glob between ' +
  'desc asc distinct union all exists with recursive returning conflict do nothing excluded default primary key unique ' +
  'coalesce ifnull nullif sum avg count min max round cast abs total substr trim replace strftime date datetime julianday ' +
  'length lower upper instr printf group_concat json_extract json_each json_array json_object iif over partition rows ' +
  'current_timestamp true false pragma table index view trigger begin commit rollback replace or_ignore').split(/\s+/));

const stripSqlStrings = (sql) => sql
  .replace(/'(?:''|[^'])*'/g, ' ')                 // SQL string literals
  .replace(/--[^\n]*/g, ' ')                       // line comments
  .replace(/\/\*[\s\S]*?\*\//g, ' ');              // block comments

function tablesIn(sql) {
  const aliases = new Map(), tables = new Set();
  const note = (t, a) => {
    if (!t || SQL_KEYWORDS.has(t.toLowerCase())) return;
    tables.add(t); aliases.set(t, t);
    if (a && !SQL_KEYWORDS.has(a.toLowerCase())) aliases.set(a, t);
  };
  for (const m of sql.matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_]\w*)\s*(?:\bAS\s+)?([A-Za-z_]\w*)?/gi)) note(m[1], m[2]);
  for (const m of sql.matchAll(/\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE)\s+([A-Za-z_]\w*)/gi)) note(m[1], null);
  return { aliases, tables };
}

// Which columns sit in a WRITTEN position — the INSERT column list, or the SET
// list of an UPDATE. A money column in a WHERE clause of an UPDATE is read, not
// written, and the two are not the same risk.
function writtenColumns(sql) {
  const out = new Set();
  const ins = /\b(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\s+[A-Za-z_]\w*\s*\(([^)]*)\)/i.exec(sql);
  if (ins) for (const c of ins[1].split(',')) out.add(c.trim().replace(/^"|"$/g, ''));
  const set = /\bSET\b([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|$)/i.exec(sql);
  if (set) for (const m of set[1].matchAll(/(?:^|,)\s*(?:[A-Za-z_]\w*\.)?([A-Za-z_]\w*)\s*=/g)) out.add(m[1]);
  // UPSERT: `ON CONFLICT … DO UPDATE SET` is caught by the SET pass above.
  return out;
}

const kindOf = (sql) => {
  const m = /\b(SELECT|INSERT|REPLACE|UPDATE|DELETE|CREATE|ALTER|DROP|PRAGMA|WITH)\b/i.exec(sql);
  if (!m) return 'OTHER';
  const k = m[1].toUpperCase();
  return k === 'REPLACE' ? 'INSERT' : k;
};
const IS_WRITE = (k) => k === 'INSERT' || k === 'UPDATE' || k === 'DELETE';

// Every money reference in one SQL variant.
function moneyRefs(sqlRaw) {
  const sql = stripSqlStrings(sqlRaw);
  const { aliases, tables } = tablesIn(sql);
  const written = writtenColumns(sql);
  const hits = new Map();                            // "table.col" -> hit
  for (const m of sql.matchAll(/(?:\b([A-Za-z_]\w*)\s*\.\s*)?\b([A-Za-z_]\w*)\b/g)) {
    const qual = m[1], col = m[2];
    if (SQL_KEYWORDS.has(col.toLowerCase())) continue;
    let candidates = [];
    if (qual) {
      const t = aliases.get(qual);
      if (!t) continue;                              // alias we cannot resolve: not a claim
      const cls = MONEY.get(t) && MONEY.get(t).get(col);
      if (cls) candidates = [{ table: t, cls }];
    } else {
      candidates = (MONEY_BY_NAME.get(col) || []).filter((c) => tables.has(c.table));
    }
    for (const c of candidates) {
      const key = `${c.table}.${col}`;
      if (!hits.has(key)) hits.set(key, { table: c.table, column: col, cls: c.cls, written: false, qualified: !!qual });
      if (written.has(col)) hits.get(key).written = true;
    }
  }
  return [...hits.values()];
}

// ════════════════════════════════════════════════════════════════════════════
// 6 · THE SCAN
// ════════════════════════════════════════════════════════════════════════════
const collapse = (s) => s.replace(/\s+/g, ' ').trim();

function scanFile(r) {
  const src = fs.readFileSync(path.join(REPO, r), 'utf8');
  const resolver = makeResolver(src);
  const sites = prepareSites(src);

  // Reconciliation, the lesson from the coverage checker: compare what was
  // attributed against a naive count of `.prepare(` in the same source. A shortfall
  // is a scanner gap and is REPORTED, never swallowed. Comments are stripped first —
  // three files discuss `.prepare(` in prose, and a permanent false gap teaches
  // people to ignore the check. A `.prepare(` inside a STRING still counts, so the
  // reconciliation stays conservative; those are named in the report.
  let naive = 0;
  for (const m of stripComments(src).matchAll(/\.\s*prepare\s*\(/g)) { void m; naive++; }

  const out = [];
  for (const s of sites) {
    const interpolated = /\$\{/.test(s.argSrc);
    // The statement TEXT AS WRITTEN: the leading literal with every ${…} left in
    // place. This is what a grep over source sees, and it is one of the two
    // baselines the fix is measured against.
    const asWritten = /^[`'"]/.test(s.argSrc) ? s.argSrc.slice(1, -1) : DYN;
    const { variants, dyn } = evalExpr(s.argSrc, resolver.forSql(s.offset), 0, new Set());
    const resolved = variants.filter((v) => v !== DYN);
    // The statement kind is taken across ALL variants, and a write wins. Reading it
    // off variant 0 alone would call an append-built UPDATE a non-write whenever the
    // first variant happened to be a fragment — the exact shape of under-count this
    // scanner exists to stop.
    const kinds = (resolved.length ? resolved : [asWritten]).map(kindOf);
    const kind = kinds.find(IS_WRITE) || kinds.find((k) => k !== 'OTHER') || 'OTHER';

    // THREE READINGS OF THE SAME SITE:
    //   dropRule  — what diagnose_seam_statements.js sees: an interpolated statement
    //               is not extracted at all, so it is never classified.
    //   textRule  — what a scan of the literal source text sees.
    //   resolved  — what this scanner sees after static resolution.
    const textHits = moneyRefs(asWritten);
    const dropHits = interpolated ? [] : textHits;
    const newHits = new Map();
    for (const v of resolved) for (const h of moneyRefs(v)) {
      const key = `${h.table}.${h.column}`;
      if (!newHits.has(key)) newHits.set(key, h);
      else if (h.written) newHits.get(key).written = true;
    }

    // Handle attribution, scope-aware.
    let cat = s.receiver ? (classifyInline(s.receiver) || null) : null;
    let how = cat ? 'inline' : null;
    if (!cat && s.receiver) {
      const root = (s.receiver.replace(/^this\./, '').match(/^([A-Za-z_$][\w$]*)/) || [])[1];
      if (root) {
        const c = resolver.classify(root, s.offset);
        how = c.kind;
        for (const rhs of c.rhss) { const k = classifyBinding(rhs); if (k) { cat = k; break; } }
      }
    }
    // A statement this scanner could NOT fully resolve, on a table that carries
    // money columns, is not "clean" — it is UNKNOWN. `UPDATE x SET ${sets.join(', ')}`
    // is the shape that matters: the assignment list is assembled at run time from
    // request keys, so whether a money column is written is unanswerable statically.
    // Counting these is the only honest way to state how big the floor still is.
    const namedTables = new Set();
    for (const v of (resolved.length ? resolved : [asWritten])) for (const t of tablesIn(stripSqlStrings(v)).tables) namedTables.add(t);
    const moneyTables = [...namedTables].filter((t) => MONEY.has(t));

    out.push({
      file: r, line: s.line, receiver: s.receiver || '<unrecoverable>',
      category: cat || 'UNRESOLVED', how: how || 'none',
      moneyTables,
      kind, write: IS_WRITE(kind),
      interpolated, residual: [...new Set(dyn)],
      sql: collapse(resolved[0] || s.argSrc).slice(0, 400),
      dropMoney: dropHits, textMoney: textHits, money: [...newHits.values()],
      variants: resolved.length,
    });
  }
  return { sites: out, naive };
}

// ── run over each surface ───────────────────────────────────────────────────
const runtimeFiles = [
  ...RUNTIME_DIRS.flatMap(jsFilesIn),
  ...RUNTIME_FILES.filter((f) => fs.existsSync(path.join(REPO, f))),
].sort();
const backgroundFiles = BACKGROUND_DIRS.flatMap(jsFilesIn);
const daemonFiles = backgroundFiles.filter((f) => IN_SCOPE_SCRIPTS.has(f));
const excludedFiles = backgroundFiles.filter((f) => !IN_SCOPE_SCRIPTS.has(f));

function scanSurface(files) {
  const sites = [], gaps = [];
  for (const f of files) {
    const { sites: s, naive } = scanFile(f);
    sites.push(...s);
    if (naive > s.length) gaps.push({ file: f, attributed: s.length, naive });
  }
  return { sites, gaps };
}

const inScope = scanSurface([...runtimeFiles, ...daemonFiles]);
const excluded = scanSurface(excludedFiles);

// ════════════════════════════════════════════════════════════════════════════
// 7 · REPORT
// ════════════════════════════════════════════════════════════════════════════
const isMoney = (s) => s.money.length > 0;
const seenByDropRule = (s) => s.dropMoney.length > 0;      // the old harness's view
const seenByTextRule = (s) => s.textMoney.length > 0;      // a grep over source text
const newlyFound = (s) => isMoney(s) && !seenByDropRule(s);
// The class that bit us: the money column is nowhere in the source text of the
// statement. Only resolving the placeholder reveals it. `${owed}` is this shape.
const resolutionOnly = (s) => isMoney(s) && !seenByTextRule(s);

function summarise(label, surf) {
  const sites = surf.sites;
  const money = sites.filter(isMoney);
  const drop = sites.filter(seenByDropRule);
  const text = sites.filter(seenByTextRule);
  const only = money.filter(resolutionOnly);
  const writes = money.filter((s) => s.write);
  console.log(`\n══ ${label} ══`);
  console.log(`  statement sites:                 ${sites.length}`);
  console.log(`  MONEY sites — this scanner:      ${money.length}   (${writes.length} write, ${money.length - writes.length} read)`);
  console.log(`  MONEY sites — drop rule (old):   ${drop.length}   every ${'${…}'} statement never classified`);
  console.log(`  MONEY sites — text-as-written:   ${text.length}   a grep over the literal source`);
  console.log(`  NEW vs the old drop rule:        ${money.length - drop.length}`);
  console.log(`    of which RESOLUTION-ONLY:      ${only.length}   money named nowhere in the source text`);
  console.log(`  statements carrying ${'${…}'}:       ${sites.filter((s) => s.interpolated).length}`);
  return { sites, money, before: drop, text, only, writes };
}

if (!AS_JSON) {
  console.log('Money-site census — every statement site that touches a CENTS or NUM6 column');
  console.log(`  census:  ${path.relative(REPO, PLAN_JSON)} — ${moneyColCount} money columns across ${MONEY.size} tables`);
  console.log('  method:  static resolution of template placeholders, concatenation, ternaries and');
  console.log('           file-level string bindings; class read from the census, never from a name.');
  console.log('  opens no database — not live SQLite, not scratch, not Postgres.');
  console.log('  excluded (tooling that holds raw handles or quotes the statements by design):');
  for (const f of [...SKIP].sort()) if (fs.existsSync(path.join(REPO, f))) console.log('    - ' + f);
}

const A = summarise('IN SCOPE — routes/, lib/, middleware/, server.js, database.js, six daemons', inScope);
const B = summarise('EXCLUDED — one-off scripts (reported, never folded into the headline)', excluded);

// ── the answer the risk picture turns on, first and separately ──────────────
console.log('\n══ MONEY WRITES (INSERT / UPDATE / DELETE) — in scope ══');
const newWrites = A.writes.filter(newlyFound);
console.log(`  ${A.writes.length} money write site(s); ${newWrites.length} of them newly surfaced by the fix.`);
if (newWrites.length) {
  for (const s of newWrites) printSite(s, '  ');
} else {
  console.log('  Every newly surfaced money site is a READ. No new money WRITE was found.');
}

console.log('\n══ RESOLUTION-ONLY MONEY SITES — the ${…} blind spot itself ══');
console.log('  The money column is named nowhere in the statement\'s source text. No scan of');
console.log('  the literal text could ever have found these; they were reachable only by');
console.log('  resolving the placeholder to the string it holds.');
console.log(`  ${A.only.length} site(s) in scope.`);
for (const s of A.only) printSite(s, '  ');

console.log('\n══ ALL NEWLY SURFACED MONEY SITES — never classified by the old drop rule ══');
const news = A.sites.filter(newlyFound);
console.log(`  ${news.length} site(s) in scope (includes the ${A.only.length} resolution-only sites above).`);
for (const s of news) printSite(s, '  ');

if (ALL_SITES) {
  console.log('\n══ EVERY MONEY SITE IN SCOPE ══');
  for (const s of A.money) printSite(s, '  ');
}

// ── the residual blind spot, named so it is a known limit, not a silent one ──
console.log('\n══ RESIDUAL BLIND SPOT — statements this scanner still cannot resolve ══');
const residual = inScope.sites.filter((s) => s.residual.length);
console.log(`  ${residual.length} in-scope statement site(s) still carry at least one expression that`);
console.log('  static analysis cannot reduce to text. Their money status is UNKNOWN, not clean.');
const byExpr = new Map();
for (const s of residual) for (const d of s.residual) byExpr.set(collapse(d).slice(0, 60), (byExpr.get(collapse(d).slice(0, 60)) || 0) + 1);
for (const [e, n] of [...byExpr.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`    ${String(n).padStart(4)}  ${e}`);
}
const byFileRes = new Map();
for (const s of residual) byFileRes.set(s.file, (byFileRes.get(s.file) || 0) + 1);
console.log('  by file (top 12):');
for (const [f, n] of [...byFileRes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`    ${String(n).padStart(4)}  ${f}`);
}

// ── the part of the residual that could be money and cannot be shown either way ─
const unknown = residual.filter((s) => !isMoney(s) && s.moneyTables.length);
const unknownWrites = unknown.filter((s) => s.write);
console.log('\n══ UNKNOWN — unresolved statements on tables that carry money columns ══');
console.log(`  ${unknown.length} of the ${residual.length} residual site(s) name a table with money columns but`);
console.log('  were not classified as money. They are NOT clean; they are unanswerable statically.');
console.log(`  ${unknownWrites.length} of them are writes — an INSERT/UPDATE whose column or SET list is built at run time.`);
for (const s of unknownWrites.slice(0, 40)) {
  console.log(`    ${s.file}:${s.line}  ${s.kind}  tables=${s.moneyTables.join(',')}  handle=${s.category}`);
  console.log(`       residual: ${s.residual.map((d) => collapse(d).slice(0, 46)).join(' | ')}`);
}
if (unknownWrites.length > 40) console.log(`    … and ${unknownWrites.length - 40} more`);

if (inScope.gaps.length || excluded.gaps.length) {
  console.log('\n══ SCANNER GAPS — sites this reader could not see ══');
  console.log('  (a `.prepare(` written inside a STRING literal counts in the naive number and is');
  console.log('   not a real site — check each of these by eye rather than assuming either way.)');
  for (const g of [...inScope.gaps, ...excluded.gaps]) {
    console.log(`    ${g.file}: attributed ${g.attributed}, naive count ${g.naive}`);
  }
} else {
  console.log('\n  RECONCILED: every `.prepare(` in every scanned file was attributed. No scanner gap.');
}

// ── handle attribution of the money sites ───────────────────────────────────
console.log('\n══ MONEY SITES BY HANDLE ══');
const byCat = {};
for (const s of A.money) byCat[s.category] = (byCat[s.category] || 0) + 1;
for (const c of ['SEAM', 'TENANT', 'DIRECT', 'RAW_OPEN', 'UNRESOLVED']) {
  if (byCat[c]) console.log(`    ${c.padEnd(11)} ${String(byCat[c]).padStart(4)}`);
}

console.log('\n' + '═'.repeat(76));
console.log(`IN SCOPE: ${A.money.length} money site(s) — was ${A.before.length} under the literal-text rule. ` +
            `${A.writes.length} are writes.`);
console.log(`${residual.length} site(s) remain statically unresolvable: that is the floor this cannot lift.`);

function printSite(s, ind) {
  const cols = s.money.map((h) => `${h.table}.${h.column} [${h.cls}]${h.written ? ' WRITTEN' : ''}`).join(', ');
  console.log(`${ind}${s.file}:${s.line}  ${s.kind}${s.write ? ' (WRITE)' : ''}  handle=${s.category} (${s.receiver})`);
  console.log(`${ind}   money: ${cols}`);
  console.log(`${ind}   sql:   ${s.sql.slice(0, 260)}` +
              (s.variants > 1 ? `   [1 of ${s.variants} resolved variants; money is the union of all]` : ''));
  if (s.residual.length) console.log(`${ind}   residual: ${s.residual.map((d) => collapse(d).slice(0, 40)).join(' | ')}`);
}

// ── --unresolved: the receivers this reader still cannot recover ────────────
// db-seam-coverage.js reports 62 of these in scope. Its receiver recovery does not
// strip a spread prefix, so `picks.push(...tdb().prepare(…))` lands in UNRESOLVED
// even though the handle is plainly tdb(). This list is what remains once that
// prefix is handled: a genuinely unknown handle, almost always a function parameter.
if (ARGS.includes('--unresolved')) {
  const u = inScope.sites.filter((s) => s.category === 'UNRESOLVED');
  console.log(`\n══ UNRESOLVED RECEIVERS — in scope: ${u.length} ══`);
  for (const s of u) {
    console.log(`    ${s.file}:${s.line}  receiver=${s.receiver}  (${s.how})` +
                (isMoney(s) ? `  MONEY: ${s.money.map((h) => `${h.table}.${h.column}`).join(', ')}` : ''));
  }
}

// ── --by-file, so this census can be reconciled against db-seam-coverage.js ──
if (ARGS.includes('--by-file')) {
  console.log('\n══ BY FILE — statement sites / money sites / money writes ══');
  const per = new Map();
  for (const s of [...inScope.sites, ...excluded.sites]) {
    if (!per.has(s.file)) per.set(s.file, { n: 0, money: 0, writes: 0 });
    const c = per.get(s.file);
    c.n++; if (isMoney(s)) { c.money++; if (s.write) c.writes++; }
  }
  for (const [f, c] of [...per.entries()].sort((a, b) => b[1].n - a[1].n)) {
    if (!c.n) continue;
    console.log(`    ${String(c.n).padStart(5)}  ${String(c.money).padStart(4)} money  ${String(c.writes).padStart(4)} write   ${f}`);
  }
}

if (AS_JSON) {
  console.log(JSON.stringify({
    moneyColumns: moneyColCount,
    inScope: { sites: inScope.sites.length, money: A.money.length, oldRule: A.before.length, writes: A.writes.length },
    excluded: { sites: excluded.sites.length, money: B.money.length, oldRule: B.before.length },
    new: news, residual: residual.map((s) => ({ file: s.file, line: s.line, residual: s.residual })),
  }, null, 2));
}
