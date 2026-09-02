#!/usr/bin/env node
/**
 * The unit-cost sanity warning — §36, docs/tacet-consolidation-decisions.md,
 * *Unit cost exceeding sell price now warns* (2026-09-02, decided by Ash):
 * Tacet warns when a product's unit cost exceeds its sell price, and does
 * not refuse the save. Product 3 (Jackfruit Chips) sat at ¥990.00 cost
 * against a ¥19.20 sell price with nothing on the product editor remarking
 * on it — that instance is what forced the decision.
 *
 *   node scripts/test_unit_cost_sanity_warning.js
 *
 * EVALUATED, not paraphrased: pdRenderCostSanity, pdRenderMargin, _paMargin,
 * _paChannelMargin and pdCostPill are sliced out of the shipped
 * public/retail-admin/09-products.js and run under vm against a stub DOM, so
 * a rewrite of the editor moves these tests rather than leaving them testing
 * a memory of the old one.
 *
 * WHAT THIS GUARDS
 *   1. The pill fires exactly when cost > price, never on a tie and never on
 *      zero/null cost or price (§36: that is cost_incomplete's case, not
 *      this one — _paMargin already returns null for both before the pill's
 *      own check ever runs).
 *   2. The pill's EN/CN pair is the one docs/tacet-delivery-vocabulary.md
 *      v1.13 adopted from this exact file rather than composing a second
 *      string for the same condition.
 *   3. The List-margin line's own trailing clause is suppressed once the pill
 *      exists (no double message); the Meituan-actual line's clause, a
 *      different comparison, is untouched.
 *   4. Nothing here blocks a save — this file never touches a save path, and
 *      that absence is itself part of the guard: a refusal would show up as
 *      a new call this test does not expect.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

const ROOT = path.join(__dirname, '..');
const PRODUCTS_JS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '09-products.js'), 'utf8');
const VOCAB_MD = fs.readFileSync(path.join(ROOT, 'docs', 'tacet-delivery-vocabulary.md'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.html'), 'utf8');

/** A braced block (function): from `anchor` to its matching `}`. */
function sliceBlock(src, anchor) {
  const start = src.indexOf(anchor);
  assert.notStrictEqual(start, -1, `not found in the shipped file: ${anchor}`);
  const open = src.indexOf('{', start + anchor.length);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces after ${anchor}`);
}

/** A single `const NAME = ...;` statement, verbatim. */
function sliceConst(src, name) {
  const start = src.indexOf(`const ${name} =`);
  assert.notStrictEqual(start, -1, `not found in the shipped file: const ${name}`);
  const end = src.indexOf(';\n', start);
  assert.notStrictEqual(end, -1, `unterminated const ${name}`);
  return src.slice(start, end + 1);
}

const SRC = [
  sliceConst(PRODUCTS_JS, 'PD_ICON_WARN'),
  sliceBlock(PRODUCTS_JS, 'function pdCostPill('),
  sliceBlock(PRODUCTS_JS, 'function _paMargin('),
  sliceBlock(PRODUCTS_JS, 'function _paChannelMargin('),
  sliceBlock(PRODUCTS_JS, 'function pdRenderMargin('),
  sliceBlock(PRODUCTS_JS, 'function pdRenderCostSanity('),
].join('\n');

// ── A stub DOM: just enough for these two render functions ─────────────────
// getElementById returns the SAME object on every call for a given id, so a
// test can hold a reference before calling the function under test and read
// it after. #pd-margin additionally collects the divs pdRenderMargin()
// appends, in order, so the two-line (List + Meituan-actual) case is
// checkable without a real DOM.
function makeSandbox(lang, products) {
  const nodes = {};
  function node(id) {
    if (!nodes[id]) {
      nodes[id] = {
        id, value: '', textContent: '', innerHTML: '', className: '',
        style: { display: '' }, children: [],
        appendChild(child) { this.children.push(child); },
      };
    }
    return nodes[id];
  }
  const sandbox = {
    _lang: lang,
    cuT: (en, cn) => (sandbox._lang === 'cn' ? cn : en),
    escapeHtml: (s) => String(s),
    paMoney: (n) => '¥' + Number(n || 0).toFixed(2),
    PA_PRODUCTS: products || [],
    document: {
      getElementById: node,
      createElement: () => ({ textContent: '', className: '' }),
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  sandbox._nodes = nodes;
  return sandbox;
}

/** Set #pd-price / #pd-cost / #pd-id, as the editor's own inputs, then run
 *  pdRenderMargin() exactly as the keystroke handler does. */
function typeAndRender(sb, { price, cost, id }) {
  sb._nodes = sb._nodes || {};
  const set = (elId, v) => { sb.document.getElementById(elId).value = v == null ? '' : String(v); };
  set('pd-price', price);
  set('pd-cost', cost);
  set('pd-id', id || '');
  sb.pdRenderMargin();
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('1. The pill fires on cost > price, and only there');
// ═══════════════════════════════════════════════════════════════════════════

it('product 3, as measured: ¥990 cost against ¥19.20 price fires the pill', () => {
  const sb = makeSandbox('en');
  typeAndRender(sb, { price: 19.20, cost: 990 });
  const host = sb.document.getElementById('pd-cost-sanity');
  assert.strictEqual(host.style.display, '');
  assert.match(host.innerHTML, /pd-cost-warn/);
  assert.match(host.innerHTML, /selling below cost/);
});

it('cost below price: no pill', () => {
  const sb = makeSandbox('en');
  typeAndRender(sb, { price: 100, cost: 40 });
  const host = sb.document.getElementById('pd-cost-sanity');
  assert.strictEqual(host.style.display, 'none');
  assert.strictEqual(host.innerHTML, '');
});

it('cost EQUAL to price: no pill — "exceeds" is strict', () => {
  const sb = makeSandbox('en');
  typeAndRender(sb, { price: 50, cost: 50 });
  assert.strictEqual(sb.document.getElementById('pd-cost-sanity').style.display, 'none');
});

it('a fraction of a cent over price still fires — no rounding tolerance', () => {
  const sb = makeSandbox('en');
  typeAndRender(sb, { price: 50, cost: 50.01 });
  assert.strictEqual(sb.document.getElementById('pd-cost-sanity').style.display, '');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n2. Never on zero or null — that is cost_incomplete\'s case');
// ═══════════════════════════════════════════════════════════════════════════

it('no cost typed yet: no pill', () => {
  const sb = makeSandbox('en');
  typeAndRender(sb, { price: 20, cost: '' });
  assert.strictEqual(sb.document.getElementById('pd-cost-sanity').style.display, 'none');
});

it('no price typed yet, cost present: no pill', () => {
  const sb = makeSandbox('en');
  typeAndRender(sb, { price: '', cost: 990 });
  assert.strictEqual(sb.document.getElementById('pd-cost-sanity').style.display, 'none');
});

it('price of zero: no pill (not a real price)', () => {
  const sb = makeSandbox('en');
  typeAndRender(sb, { price: 0, cost: 5 });
  assert.strictEqual(sb.document.getElementById('pd-cost-sanity').style.display, 'none');
});

it('cost of zero: no pill (zero cost never exceeds a positive price)', () => {
  const sb = makeSandbox('en');
  typeAndRender(sb, { price: 20, cost: 0 });
  assert.strictEqual(sb.document.getElementById('pd-cost-sanity').style.display, 'none');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n3. Both languages, the adopted pair, nothing composed');
// ═══════════════════════════════════════════════════════════════════════════

it('English pill reads "selling below cost"', () => {
  const sb = makeSandbox('en');
  typeAndRender(sb, { price: 19.20, cost: 990 });
  assert.match(sb.document.getElementById('pd-cost-sanity').innerHTML, /selling below cost/);
});

it('Chinese pill reads 低于成本销售 — the adopted pair, not a fresh composition', () => {
  const sb = makeSandbox('cn');
  typeAndRender(sb, { price: 19.20, cost: 990 });
  assert.match(sb.document.getElementById('pd-cost-sanity').innerHTML, /低于成本销售/);
});

it('the pill carries the shared warning icon and pill class, same shape as the recipe-cost alerts', () => {
  const sb = makeSandbox('en');
  typeAndRender(sb, { price: 19.20, cost: 990 });
  const html = sb.document.getElementById('pd-cost-sanity').innerHTML;
  assert.match(html, /class="pd-cost-warn"/);
  assert.match(html, /<svg/);
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n4. The margin line: no doubled message, the Meituan-actual line untouched');
// ═══════════════════════════════════════════════════════════════════════════

it('single-line case (no channel data): the List figure drops its own "selling below cost" — the pill says it now', () => {
  const sb = makeSandbox('en');
  typeAndRender(sb, { price: 19.20, cost: 990 });
  const margin = sb.document.getElementById('pd-margin');
  assert.doesNotMatch(margin.textContent, /selling below cost/);
  assert.match(margin.textContent, /Margin/);
});

it('two-line case: List margin drops the clause, Meituan-actual KEEPS its own — different comparison, out of scope', () => {
  const sb = makeSandbox('en', [{ id: 7, mt_revenue: 100, mt_units: 20 }]); // ¥5/unit settled
  typeAndRender(sb, { price: 19.20, cost: 990, id: 7 });
  const margin = sb.document.getElementById('pd-margin');
  const lines = margin.children.map(c => c.textContent);
  assert.strictEqual(lines.length, 2, 'expected List margin + Meituan actual');
  assert.doesNotMatch(lines[0], /selling below cost/, 'List margin line must not repeat the pill');
  assert.match(lines[1], /selling below cost/, 'Meituan-actual line keeps its own wording');
  // The pill still fires off the LIST comparison (cost vs sell price), not
  // the channel one — the condition §36 names.
  assert.strictEqual(sb.document.getElementById('pd-cost-sanity').style.display, '');
});

it('a product priced normally but underpaid by Meituan: pill silent, Meituan-actual line still says so — different question', () => {
  // price 100, cost 40 (List margin fine) but Meituan only settled ¥30/unit.
  const sb = makeSandbox('en', [{ id: 8, mt_revenue: 300, mt_units: 10 }]); // ¥30/unit
  typeAndRender(sb, { price: 100, cost: 40, id: 8 });
  assert.strictEqual(sb.document.getElementById('pd-cost-sanity').style.display, 'none');
  const lines = sb.document.getElementById('pd-margin').children.map(c => c.textContent);
  assert.match(lines[1], /selling below cost/);
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n5. The pair is locked in the vocabulary doc, adopted rather than minted');
// ═══════════════════════════════════════════════════════════════════════════

it('docs/tacet-delivery-vocabulary.md locks sellingBelowCost, both halves', () => {
  assert.match(VOCAB_MD, /`sellingBelowCost`/);
  assert.match(VOCAB_MD, /selling below cost/);
  assert.match(VOCAB_MD, /低于成本销售/);
  assert.match(VOCAB_MD, /ADOPTED FROM LIVE CODE/);
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n6. The markup carries the new host, wired between the recipe alert and the margin line');
// ═══════════════════════════════════════════════════════════════════════════

it('public/retail-admin.html has #pd-cost-sanity between #pd-cost-alert and #pd-margin', () => {
  const i1 = HTML.indexOf('id="pd-cost-alert"');
  const i2 = HTML.indexOf('id="pd-cost-sanity"');
  const i3 = HTML.indexOf('id="pd-margin"');
  assert.ok(i1 > -1 && i2 > -1 && i3 > -1, 'all three ids must be present');
  assert.ok(i1 < i2 && i2 < i3, 'expected order: cost-alert, cost-sanity, margin');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
