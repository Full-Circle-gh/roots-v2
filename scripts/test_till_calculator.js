#!/usr/bin/env node
/**
 * §510 — the counter till carries a calculator.
 *
 *   node scripts/test_till_calculator.js
 *
 * A quiet button in the rail foot, always up, opening a sheet that docks over
 * the order rail: a tool beside the sale that reads nothing from the basket and
 * writes nothing back. The engine is IMMEDIATE EXECUTION — no formula parser,
 * no eval — and is a pure function of { acc, op, cur, fresh, expr } and one key
 * SO THAT THIS SUITE CAN RUN IT: the till's browser probes all live in the slow
 * shard, which is not run, and a test that cannot run protects nothing
 * (CLAUDE.md). So this one lifts the shipped functions out of public/till.html
 * and does the arithmetic in plain node — the technique test_till_hold.js and
 * test_till_new_customer_kept.js use on the same file.
 *
 * What is held here:
 *   • the button sits in the rail foot, after Hold and Discount, and is never
 *     hidden and never disabled — no state of the sale has a say over a tool;
 *   • the sheet is the .right scrim, closes on a scrim tap, on its Cancel row,
 *     and when the view leaves the till (a QR order paid on the phone moves
 *     this till to the takeover from a poll, and the sheet must not outlive it);
 *   • the arithmetic: four operations, chains that fold on the next operator,
 *     %, ±, backspace, the second decimal point that must not land, the digit
 *     cap, −0 that must never render, and ∞ for division by zero — a symbol
 *     needs no locked pair, and "cannot divide by zero" would;
 *   • calcStep is PURE: the state passed in survives the call unchanged, which
 *     is what lets S.calc live across the fifteen-second poll's repaints;
 *   • the one composed pair, Calculator · 计算器, is declared where the lock
 *     says it must be: in STRINGS with its source comment, and in
 *     docs/tacet-delivery-vocabulary.md (v1.373), with §510 in the decisions
 *     doc behind it.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'public', 'till.html'), 'utf8');
const problems = [];
let checks = 0;
function ok(name, v) { checks++; if (!v) problems.push(name); }

// A function as shipped: a one-line body, or everything to the closing brace
// at the function's own indent (test_till_hold.js's extractor).
function fn(name) {
  const at = src.indexOf('\n  function ' + name + '(');
  if (at < 0) throw new Error('till.html has no function ' + name + '()');
  const lineEnd = src.indexOf('\n', at + 1);
  const first = src.slice(at, lineEnd);
  if (/\}\s*$/.test(first) && (first.match(/\{/g) || []).length === (first.match(/\}/g) || []).length) {
    return first + '\n';
  }
  const end = src.indexOf('\n  }\n', at);
  return src.slice(at, end + 5);
}

// ── 1. The button, in the rail foot, always up ────────────────────────────
console.log('\nthe control');
ok('the button is in the foot',
  src.indexOf('<button class="calcb" id="calc-open" type="button" data-calc="open"></button>') > -1);
const footAt = src.indexOf('<div class="foot">');
const discAt = src.indexOf('id="disc"', footAt);
const calcAt = src.indexOf('id="calc-open"', footAt);
ok('it sits after Discount in the foot', footAt > -1 && discAt > -1 && calcAt > discAt);
ok('it carries no hidden attribute — a tool does not wait for a basket',
  !/id="calc-open"[^>]*hidden/.test(src));
ok('its label is set from the locked pair in renderFoot',
  /\$\('calc-open'\)\.textContent = T\('calculator'\);/.test(src));

// ── 2. The sheet ──────────────────────────────────────────────────────────
console.log('\nthe sheet');
ok('the scrim is the right-docked one',
  src.indexOf('<div class="sscrim right" id="calcpick" hidden></div>') > -1);
ok('a right-dock rule exists', /\.sscrim\.right\{[^}]*justify-content:flex-end/.test(src));
ok('and a phone override turns it into a bottom sheet',
  /\.calc-sheet\{[^}]*width:100%/.test(src));
ok('a scrim tap puts the tool down',
  /S\.calcOpen && ev\.target\.id === 'calcpick'\) return closeCalc\(\)/.test(src));
ok('the sheet has its locked Cancel row', /data-calc="close"/.test(src));
ok('the view rule takes the sheet down with the till',
  /if \(S\.view !== 'till'\) S\.calcOpen = false;/.test(src));
ok('render() repaints the sheet', /\n    renderCalc\(\);\n/.test(src));
ok('keys are past the 44px touch floor', /\.ck\{[^}]*min-height:56px/.test(src));
// 20 keys: C ⌫ % ÷ / 7 8 9 × / 4 5 6 − / 1 2 3 + / ± 0 . =
const renderCalcSrc = fn('renderCalc');
ok('the sheet carries all 20 keys', (renderCalcSrc.match(/K\('/g) || []).length === 20);
ok('every key is a symbol — data-ck, no locked pair needed',
  (renderCalcSrc.match(/data-ck="/g) || []).length === 1);
// The tool never reaches for the page's own decision-shapes or an evaluator.
const JS = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
ok('no eval anywhere on the page', JS.indexOf('eval(') === -1);
ok('no Function constructor either', JS.indexOf('new Function') === -1);

// ── 3. The engine, as shipped ─────────────────────────────────────────────
console.log('\nthe arithmetic');
const ctx = vm.createContext({});
vm.runInContext([fn('calcNew'), fn('calcFmt'), fn('calcFold'), fn('calcStep')]
  .join('\n') + '\nthis.calcNew = calcNew; this.calcStep = calcStep;', ctx);
const step = (keys) => vm.runInContext(
  '(function(){ var s = calcNew(); for (var i = 0; i < ' + JSON.stringify(keys) + '.length; i++)'
  + ' s = calcStep(s, ' + JSON.stringify(keys) + '[i]); return s; })()', ctx);
const cur = (keys) => step(keys).cur;

ok('2 + 3 = 5', cur(['2', '+', '3', '=']) === '5');
ok('0.1 + 0.2 = 0.3, not 0.30000000000000004', cur(['0', '.', '1', '+', '0', '.', '2', '=']) === '0.3');
ok('1.5 × 4 = 6', cur(['1', '.', '5', '×', '4', '=']) === '6');
ok('10 ÷ 4 = 2.5', cur(['1', '0', '÷', '4', '=']) === '2.5');
ok('7 − 9 = −2, a negative answer a change calculation can need', cur(['7', '−', '9', '=']) === '-2');
ok('9 × 0 = 0', cur(['9', '×', '0', '=']) === '0');
ok('5 − 5 = 0, never -0', cur(['5', '−', '5', '=']) === '0');
ok('a chain folds on the next operator: 2 + 3 + 4 = 9', cur(['2', '+', '3', '+', '4', '=']) === '9');
ok('and the fold is visible before = is pressed', step(['2', '+', '3', '+']).cur === '5');
ok('= states what it worked out', step(['2', '+', '3', '=']).expr === '2 + 3 =');
ok('= with nothing pending changes nothing', cur(['4', '2', '=']) === '42');
ok('50 % is 0.5', cur(['5', '0', '%']) === '0.5');
ok('18 + 5 % = 18.9 — % after + means 5% of 18', cur(['1', '8', '+', '5', '%', '=']) === '18.9');
ok('18 − 5 % = 17.1 — % after − means 5% of 18', cur(['1', '8', '−', '5', '%', '=']) === '17.1');
ok('18 × 5 % = 0.9 — % after × is just 0.05', cur(['1', '8', '×', '5', '%', '=']) === '0.9');
ok('18 ÷ 5 % = 360 — % after ÷ is just 0.05', cur(['1', '8', '÷', '5', '%', '=']) === '360');
ok('± flips the sign', cur(['5', '±']) === '-5');
ok('and flips it back', cur(['5', '±', '±']) === '5');
ok('± on a bare 0 does nothing', cur(['0', '±']) === '0');
ok('⌫ takes the last digit off', cur(['1', '2', '3', 'B']) === '12');
ok('⌫ past the first digit is 0', cur(['5', 'B']) === '0');
ok('a second decimal point does not land', cur(['1', '.', '2', '.']) === '1.2');
ok('digits cap at 12', cur('1234567890123'.split('')).length === 12);
ok('C clears everything', (function () {
  const s = step(['7', '×', '8', 'C']);
  return s.cur === '0' && s.acc === null && s.op === null && s.expr === '';
})());
ok('5 ÷ 0 = ∞, a symbol and not a sentence', cur(['5', '÷', '0', '=']) === '∞');
ok('a digit after ∞ starts the next number', cur(['5', '÷', '0', '=', '7']) === '7');
ok('an operator after ∞ only clears', cur(['5', '÷', '0', '=', '+']) === '0');
ok('a fresh result starts the next entry', cur(['2', '+', '3', '=', '9']) === '9');
ok('. first is 0.something', cur(['.', '5']) === '0.5');

console.log('\nthe engine is pure');
const before = vm.runInContext('calcNew()', ctx);
const frozen = JSON.stringify(before);
vm.runInContext('(function(s){ calcStep(s, "5"); calcStep(s, "+"); calcStep(s, "3"); calcStep(s, "="); })',
  ctx)(before);
ok('calcStep never mutates the state it is handed', JSON.stringify(before) === frozen);

// ── 4. The composed pair is declared, where the lock says ─────────────────
console.log('\nthe Chinese');
ok('STRINGS carries the pair with its composed marker',
  /calculator:\s*\['Calculator', '计算器'\],\s*\/\/ composed, §510/.test(src));
ok('the STRINGS comment names the vocabulary entry',
  src.indexOf('docs/tacet-delivery-vocabulary.md (v1.373)') > -1);
const vocab = fs.readFileSync(path.join(ROOT, 'docs', 'tacet-delivery-vocabulary.md'), 'utf8');
ok('v1.373 in the vocabulary doc declares 计算器 composed',
  /v1\.373[^\n]*计算器[^\n]*COMPOSED|v1\.373[\s\S]{0,400}?\*\*COMPOSED:\*\* `Calculator · 计算器`/.test(vocab));
const decisions = fs.readFileSync(path.join(ROOT, 'docs', 'tacet-consolidation-decisions.md'), 'utf8');
ok('§510 in the decisions doc records the pick',
  decisions.indexOf('## §510 — THE COUNTER TILL CARRIES A CALCULATOR') > -1);

// ── verdict ────────────────────────────────────────────────────────────────
console.log('');
if (problems.length) {
  console.error(problems.length + ' failed of ' + checks + ':');
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
}
console.log('ok — ' + checks + ' counter-till calculator assertions.');
