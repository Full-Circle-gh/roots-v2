#!/usr/bin/env node
// Proves what the ingredient form does to a cost when it is opened and saved.
//
// It does NOT re-implement the form. It reads public/app.html, extracts the
// real calcCPU() and cpuForSave() source, and runs that source against a stub
// DOM with the real lib/ingredient-cost.js attached to `window` — the same file
// the browser loads from /lib/ingredient-cost.js. If someone edits the form,
// this test runs the edited code.
//
// Run:  node scripts/test_ingredient_form_cost.js
//
// The three behaviours it guards, all of which the old form got wrong:
//   1. a per-piece row survives open-and-save unchanged (it used to be divided)
//   2. a row whose cost cannot be derived keeps its stored value (it used to be
//      overwritten with 0 — the parseFloat('')||0 at the save)
//   3. a weight row still divides by the pack size

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'app.html'), 'utf8');

// Pull one function's source out of the page by matching braces.
function extract(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name}() not found in public/app.html`);
  let depth = 0, i = html.indexOf('{', start);
  for (let j = i; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') { depth--; if (depth === 0) return html.slice(start, j + 1); }
  }
  throw new Error(`${name}() has unbalanced braces`);
}

const source = [extract('calcCPU'), extract('cpuForSave')].join('\n\n');

// A DOM just big enough for the two functions: id → { value } plus the two
// display nodes they write into.
function makeDom(fields) {
  const el = (v) => ({ value: v === undefined ? '' : String(v), textContent: '', innerHTML: '' });
  const nodes = {
    fi_buy_price: el(fields.buy_price),
    fi_pack:      el(fields.buy_pack_size),
    fi_buy_unit:  el(fields.buy_unit),
    fi_pack_qty:  el(fields.pack_contents_qty),
    fi_pack_cu:   el(fields.pack_contents_unit),
    fi_unit:      el(fields.unit),
    fi_cpu:       el(fields.stored),          // seeded with the stored value, as the form does
    fi_cpu_stored: el(fields.stored),
    fi_cpu_hint:  el(''),
    fi_cpu_label: el(''),
  };
  return { nodes, document: { getElementById: (id) => nodes[id] || null } };
}

const lib = require(path.join(ROOT, 'lib', 'ingredient-cost'));

// One open-and-save cycle: calcCPU() runs on open, cpuForSave() supplies the
// value the PUT would carry.
function openAndSave(fields) {
  const dom = makeDom(fields);
  const ctx = vm.createContext({ document: dom.document, window: { RootsIngredientCost: lib }, console });
  vm.runInContext(source + '\ncalcCPU(); globalThis.__saved = cpuForSave();', ctx);
  return { shown: dom.nodes.fi_cpu.value, saved: ctx.__saved, hint: dom.nodes.fi_cpu_hint.textContent };
}

let failures = 0;
function check(label, actual, expected) {
  const ok = typeof expected === 'number' && typeof actual === 'number'
    ? Math.abs(actual - expected) < 1e-9 : actual === expected;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label} — expected ${expected}, got ${actual}`);
  if (!ok) failures++;
}

console.log('\n── 1. per-piece row survives open-and-save (4-250 Tortilla chips) ──');
// ¥28 for a 300 g bag, counted out whole. The old form showed 28/300 = 0.093333.
const chips = openAndSave({ unit: 'pcs', buy_unit: 'pcs', buy_pack_size: 1, pack_contents_qty: 300, pack_contents_unit: 'g', buy_price: 28, stored: 28 });
console.log(`     field shows "${chips.shown}" · hint: ${chips.hint}`);
check('cost saved unchanged', chips.saved, 28);
check('not divided to a per-gram figure', chips.saved === 0.093333, false);

console.log('\n── 2a. no derivable cost — bottle with no contents (G-7) ───────────');
// unit g, bought by the bottle, nobody recorded what a bottle holds.
const g7 = openAndSave({ unit: 'g', buy_unit: 'bottle', buy_pack_size: 1, pack_contents_qty: '', pack_contents_unit: '', buy_price: 43, stored: 0.9 });
console.log(`     field shows "${g7.shown}" · hint: ${g7.hint}`);
check('stored cost preserved', g7.saved, 0.9);
check('NOT zeroed', g7.saved === 0, false);

console.log('\n── 2b. no derivable cost — no price at all ─────────────────────────');
const noPrice = openAndSave({ unit: 'g', buy_unit: 'kg', buy_pack_size: 1, pack_contents_qty: '', pack_contents_unit: '', buy_price: 0, stored: 0.5 });
console.log(`     field shows "${noPrice.shown}" · hint: ${noPrice.hint}`);
check('stored cost preserved', noPrice.saved, 0.5);

console.log('\n── 2c. per-piece row with no contents (J-30 Ladle) ─────────────────');
// After this morning's unit fix these are pcs rows with no pack contents. The
// old form blanked the field and the save stored 0.
const ladle = openAndSave({ unit: 'pcs', buy_unit: 'pcs', buy_pack_size: 1, pack_contents_qty: '', pack_contents_unit: '', buy_price: 13.5, stored: 13.5 });
console.log(`     field shows "${ladle.shown}" · hint: ${ladle.hint}`);
check('cost saved unchanged', ladle.saved, 13.5);

console.log('\n── 3. weight row still divides (C-40 Black Sesame Seeds) ───────────');
const sesame = openAndSave({ unit: 'g', buy_unit: 'bag', buy_pack_size: 1, pack_contents_qty: 500, pack_contents_unit: 'g', buy_price: 15.8, stored: 15.8 });
console.log(`     field shows "${sesame.shown}" · hint: ${sesame.hint}`);
check('divided by the pack contents', sesame.saved, 0.0316);

console.log('\n── 3b. weight row bought by the kilo ───────────────────────────────');
const kilo = openAndSave({ unit: 'g', buy_unit: 'kg', buy_pack_size: 1, pack_contents_qty: '', pack_contents_unit: '', buy_price: 75.6, stored: 0.0756 });
check('divided by 1000', kilo.saved, 0.0756);

console.log('\n── 4. helper missing (blocked request) — nothing is written ────────');
{
  const dom = makeDom({ unit: 'g', buy_unit: 'bag', buy_pack_size: 1, pack_contents_qty: 500, pack_contents_unit: 'g', buy_price: 15.8, stored: 0.0316 });
  const ctx = vm.createContext({ document: dom.document, window: {}, console });
  vm.runInContext(source + '\ncalcCPU(); globalThis.__saved = cpuForSave();', ctx);
  console.log(`     field shows "${dom.nodes.fi_cpu.value}" · hint: ${dom.nodes.fi_cpu_hint.textContent}`);
  check('stored cost preserved with no helper', ctx.__saved, 0.0316);
}

console.log('\n── 5. the helper file itself loads in a browser ────────────────────');
{
  // No module, no require, no Node globals — just a window, the way the page
  // gets it from /lib/ingredient-cost.js. If the UMD tail ever breaks the form
  // silently loses its formula, so this is worth a test of its own.
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'ingredient-cost.js'), 'utf8');
  const win = {};
  const ctx = vm.createContext({ window: win });
  vm.runInContext(src, ctx);
  check('publishes itself on window', typeof win.RootsIngredientCost, 'object');
  check('and the derivation works there', win.RootsIngredientCost.deriveCostPerUnit(
    { unit: 'g', buy_unit: 'bag', buy_pack_size: 1, pack_contents_qty: 500, pack_contents_unit: 'g' }, 15.8).cpu, 0.0316);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}\n`);
process.exit(failures === 0 ? 0 : 1);
