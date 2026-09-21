#!/usr/bin/env node
/**
 * The × that empties the product search box.
 *
 *   node scripts/test_search_clear.js
 *
 * WHAT THIS IS FOR. Ash, on a screenshot of Ask for stock with `toma` typed:
 * *"add a quick delete X of the search bar"*. Before it, emptying the field was
 * one backspace per character, so the query stayed put and the operator
 * scrolled past it.
 *
 * WHY IT NEEDS A TEST OF ITS OWN RATHER THAN A LOOK. The control is a button
 * sitting on top of a text field that MUST NOT BE REBUILT — the whole reason
 * scripts/test_search_repaint_equivalence.js exists is that a rebuilt <input>
 * opens a fresh soft keyboard on its letter page, which turned typing a SKU
 * into one digit, then the alphabet, then one digit. Every plausible way to
 * write a clear button walks back into that defect:
 *
 *   appending the × on the first keystroke   → rebuilds the field's wrapper
 *   clearing it with render()                → rebuilds the whole app
 *   letting the tap blur and re-focus()      → closes the keyboard and reopens
 *                                              it on the letter page
 *
 * So the rules below are not style. Each one is that defect arriving by a
 * different door, and all three doors are held shut here.
 *
 * Cases:
 *   1. the × is drawn either way, hidden when the box is empty
 *   2. it lives OUTSIDE the repainted body, and the field leaves room for it
 *   3. it refuses the focus change instead of undoing one
 *   4. typing shows it; the × empties field, state and list and hides itself
 *   5. neither handler re-renders the app except when the screen is not painted
 *   6. its label is the live `Clear · 清除` pair, not a new one
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };

/* Same slicer the repaint suite uses: brace-matched from source, so nothing is
   asserted against a copy of the markup written into this file. */
function sliceFn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  let depth = 0;
  for (let j = SRC.indexOf('{', start); j < SRC.length; j++) {
    const c = SRC[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
  }
  throw new Error(`unbalanced braces slicing ${name}`);
}
const handlerBody = (name) => {
  const at = SRC.indexOf(`reg('${name}'`);
  if (at < 0) throw new Error(`handler ${name} not found`);
  return SRC.slice(at, SRC.indexOf('\nreg(', at + 1));
};

const PRODUCTS = [
  { id: 1, product_id: 1, name_en: 'Turkish Tomato Salad', name_cn: '土耳其番茄沙拉', sku: 'P-1' },
  { id: 2, product_id: 2, name_en: 'Rye Loaf',             name_cn: '黑麦面包',       sku: 'P-2' },
];
const rqState = (over) => ({ rq: Object.assign(
  { products: PRODUCTS.slice(), tried: true, fromShelf: false, q: '', qty: {},
    busy: false, err: '', sent: null, purpose: null, from: null, to: null }, over) });

/* ── 1-3 · the markup ─────────────────────────────────────────────────────── */
function painted(over, lang) {
  const sb = {
    state: rqState(over),
    T: (en, zh) => (lang === 'zh' ? zh : en),
    escAttr: (s) => String(s == null ? '' : s),
    ic: (n) => `[icon:${n}]`,
    rqName: (p) => p.name_en || '',
    console, Number, String, Array, Object, JSON, Math,
  };
  vm.createContext(sb);
  for (const n of ['rqLines', 'searchClearBtn', 'rqBodyHtml', 'rqPicker']) {
    vm.runInContext(sliceFn(n), sb, { filename: `slice#${n}` });
  }
  return vm.runInContext('rqPicker()', sb);
}

console.log('\n══ the × is drawn either way, and hidden when there is nothing to clear ══');
{
  const empty = painted({});
  const typed = painted({ q: 'toma' });
  ok(/id="mRqClr"/.test(empty) && /id="mRqClr"/.test(typed),
     'the button is in the markup whether or not something is typed');
  ok(/display:none/.test(empty.slice(empty.indexOf('id="mRqClr"'))),
     'hidden on an empty box — absent would mean adding it later, which rebuilds the field');
  ok(!/display:none/.test(typed.slice(typed.indexOf('id="mRqClr"'), typed.indexOf('</button>'))),
     'shown the moment there is a query');
  ok(/\[icon:x\]/.test(typed), 'and it is the × icon, not a word');
}

console.log('\n══ it sits outside the repainted body, and the field leaves room for it ══');
{
  const typed = painted({ q: 'toma' });
  ok(typed.indexOf('id="mRqClr"') < typed.indexOf('id="mRqBody"'),
     'the × is outside #mRqBody — the repaint must never be what draws it');
  ok(/padding-right:44px/.test(typed),
     'the field reserves the room permanently, so the text never shifts under the caret');
  // The magnifier is 39px from the left edge of its container; the × is 44px
  // wide with its right edge 17px in, which centres it 39px from the right.
  ok(/right:17px/.test(typed) && /left:30px/.test(typed),
     'the two icons are the same distance from their own edge');
  const sb = { T: (en) => en, ic: () => '', console };
  vm.createContext(sb);
  vm.runInContext(sliceFn('searchClearBtn'), sb, { filename: 'slice#searchClearBtn' });
  ok(/class="iconbtn"/.test(vm.runInContext(`searchClearBtn('a','b',true)`, sb)),
     'and it is a 44px .iconbtn, not a bare glyph — this is a thumb target');
}

console.log('\n══ it refuses the focus change rather than undoing one ══');
{
  const btn = sliceFn('searchClearBtn');
  ok(/onmousedown="event\.preventDefault\(\)"/.test(btn),
     'onmousedown prevents the blur — a blur closes the soft keyboard');
  ok(!/\.focus\(\)/.test(btn) && !/\.focus\(\)/.test(handlerBody('rqClear')),
     'and nothing re-focuses afterwards: re-focusing reopens the keyboard on its letter page');
}

/* ── 4-5 · the handlers, against a fake field ─────────────────────────────── */
console.log('\n══ typing shows it; the × empties the field, the state and the list ══');
{
  const el = { value: 'toma' }, clr = { style: { display: 'none' } }, body = { innerHTML: 'STALE' };
  let renders = 0;
  const sb = {
    state: rqState({ q: 'toma' }),
    document: { getElementById: (id) => ({ mRqQ: el, mRqClr: clr, mRqBody: body })[id] || null },
    render: () => { renders++; },
    rqBodyHtml: () => 'FRESH',
    CMD: {},
    console, Number, String, Array, Object, JSON, Math,
  };
  sb.reg = (n, f) => { sb.CMD[n] = f; };
  vm.createContext(sb);
  vm.runInContext(sliceFn('searchClearShow'), sb, { filename: 'slice#searchClearShow' });
  vm.runInContext(handlerBody('rqSearch'), sb, { filename: 'reg#rqSearch' });
  vm.runInContext(handlerBody('rqClear'), sb, { filename: 'reg#rqClear' });

  sb.CMD.rqSearch('tom');
  ok(clr.style.display === '', 'a keystroke with something in it shows the ×');
  sb.CMD.rqSearch('');
  ok(clr.style.display === 'none', 'backspacing to empty hides it again');

  clr.style.display = ''; body.innerHTML = 'STALE'; el.value = 'toma'; sb.state.rq.q = 'toma';
  sb.CMD.rqClear();
  ok(el.value === '', 'the × empties the field itself — the handler is told nothing to clear it from');
  ok(sb.state.rq.q === '', 'and the query in state with it');
  ok(body.innerHTML === 'FRESH', 'the list under it is repainted');
  ok(clr.style.display === 'none', 'and the × takes itself away');
  ok(renders === 0, 'none of that re-rendered the app');
}

console.log('\n══ neither handler re-renders except when the screen is not painted ══');
for (const name of ['rqSearch', 'rqClear']) {
  const body = handlerBody(name);
  const renders = (body.match(/render\(\)/g) || []).length;
  ok(renders === 1 && /else\s+render\(\)/.test(body),
     `${name} keeps render() only as the not-painted fallback`);
  ok(body.includes('mRqBody'), `${name} patches mRqBody and nothing wider`);
}

console.log('\n══ the label is the live pair, not a new one ══');
{
  const btn = sliceFn('searchClearBtn');
  ok(/T\('Clear','清除'\)/.test(btn), "it reads Clear · 清除 — copied, nothing composed");
  // Same pair already shipping on the waybill and ETA controls in this file.
  ok((SRC.match(/T\('Clear','清除'\)/g) || []).length >= 2,
     'and that pair was already live in this file before the × existed');
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
