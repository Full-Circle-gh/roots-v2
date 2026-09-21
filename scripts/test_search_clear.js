#!/usr/bin/env node
/**
 * The × that empties a search box — all fifteen of them.
 *
 *   node scripts/test_search_clear.js
 *
 * WHAT THIS IS FOR. Ash, on a screenshot of Ask for stock with `toma` typed:
 * *"add a quick delete X of the search bar"*, then *"There are 13 other search
 * boxes … do it"*. Before it, emptying a field was one backspace per character,
 * so the query stayed where it was and the operator scrolled past it.
 *
 * WHY IT NEEDS A TEST RATHER THAN A LOOK. The control is a button sitting on
 * top of a text field that MUST NOT BE REBUILT — the whole reason
 * scripts/test_search_repaint_equivalence.js exists is that a rebuilt <input>
 * opens a fresh soft keyboard on its letter page, which turned typing a SKU
 * into one digit, then the alphabet, then one digit. Every plausible way to
 * write a clear button walks back into that defect:
 *
 *   appending the × on the first keystroke   → rebuilds the field's wrapper
 *   clearing with a full repaint             → rebuilds the whole app
 *   letting the tap blur and re-focus()      → closes the keyboard and reopens
 *                                              it on the letter page
 *
 * So the rules below are not style. Each is that defect arriving by a different
 * door, and all three doors are held shut.
 *
 * THE FOURTH DOOR, AND THE ONE THAT WOULD HAVE SHIPPED SILENTLY. Two screens
 * decide whether it is safe to patch their results list by asking whether the
 * focused element is the box's PREVIOUS SIBLING. Wrapping each field in the
 * span that carries its × makes the span the sibling and the input a child, so
 * an identity check there falls through to a full re-render on every keystroke
 * — the original defect, restored, on Onwards and on the customer address
 * form. Both guards are checked here.
 *
 * Cases:
 *   1. every search box on the phone has one, and each is wired to a handler
 *   2. the × is drawn either way, hidden when the box is empty
 *   3. it lives outside the repainted body, and the field leaves room for it
 *   4. it refuses the focus change instead of undoing one
 *   5. typing shows it; the × empties field, state and list, and hides itself
 *   6. the patch guards survive the wrapper
 *   7. no search handler re-renders the app except when the screen is unpainted
 *   8. its label is the live `Clear · 清除` pair, not a new one
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

/* ── 1 · the whole roster ─────────────────────────────────────────────────── */
/* Read off the page rather than listed here, so a search box added next year is
   a FAILURE on the day it is written and not a gap nobody notices. */
const BOXES = [...SRC.matchAll(/<input id="(m[A-Za-z]+)"[^>]*inputmode="search"/g)].map(m => m[1]);

console.log('\n══ every search box on the phone carries one ══');
{
  ok(BOXES.length >= 15, `found ${BOXES.length} search boxes to check`);

  /* Each box names its button at the call site. Read the pairing off there
     rather than from a list here, so a box wired to the wrong × is a failure
     and not a coincidence nobody checks. */
  const wired = new Map();
  for (const id of BOXES) {
    const at = SRC.indexOf(`<input id="${id}"`);
    const after = SRC.slice(at, at + 1400);
    const m = after.match(/,'(m[A-Za-z]+Clr)',/);
    if (m) wired.set(id, m[1]);
  }
  const noButton = BOXES.filter(id => !wired.has(id));
  ok(noButton.length === 0,
     noButton.length ? `these have no × at their call site: ${noButton.join(', ')}`
                     : 'every search box is drawn through searchBox with a button of its own');

  const ids = [...wired.values()];
  ok(new Set(ids).size === ids.length, 'no two boxes share a button id');

  /* A button whose command was never registered is a control that does nothing
     — the failure this whole file exists to make loud. Most are registered by
     the table; Customers is registered on its own, with its reason. */
  const rows = new Map([...SRC.matchAll(/\['(m[A-Za-z]+)','(m[A-Za-z]+Clr)','([A-Za-z]+)'\]/g)]
    .map(m => [m[2], { input: m[1], cmd: m[3] }]));
  const dead = ids.filter(b => !rows.has(b) && !SRC.includes(`reg('${b}'`));
  ok(dead.length === 0,
     dead.length ? `these × have no command: ${dead.join(', ')}`
                 : 'every × has a command, by the table or by its own registration');

  // The table's rows must name the box they claim to clear, and a real handler.
  const wrongInput = [...rows].filter(([btn, r]) => wired.get(r.input) !== btn);
  ok(wrongInput.length === 0,
     wrongInput.length ? `table rows point at the wrong field: ${wrongInput.map(r => r[0]).join(', ')}`
                       : 'every table row clears the field it names');
  const noHandler = [...rows].filter(([, r]) => !SRC.includes(`reg('${r.cmd}'`));
  ok(noHandler.length === 0,
     noHandler.length ? `rows point at handlers that do not exist: ${noHandler.map(r => r[1].cmd).join(', ')}`
                      : 'every table row points at a search handler that exists');
}

/* ── 2-4 · the markup ─────────────────────────────────────────────────────── */
const PRODUCTS = [
  { id: 1, product_id: 1, name_en: 'Turkish Tomato Salad', name_cn: '土耳其番茄沙拉', sku: 'P-1' },
  { id: 2, product_id: 2, name_en: 'Rye Loaf',             name_cn: '黑麦面包',       sku: 'P-2' },
];
const rqState = (over) => ({ rq: Object.assign(
  { products: PRODUCTS.slice(), tried: true, fromShelf: false, q: '', qty: {},
    busy: false, err: '', sent: null, purpose: null, from: null, to: null }, over) });

function painted(over) {
  const sb = {
    state: rqState(over),
    T: (en) => en,
    escAttr: (s) => String(s == null ? '' : s),
    ic: (n) => `[icon:${n}]`,
    rqName: (p) => p.name_en || '',
    console, Number, String, Array, Object, JSON, Math,
  };
  vm.createContext(sb);
  for (const n of ['rqLines', 'searchBox', 'rqBodyHtml', 'rqPicker']) {
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
  ok(/onclick="APP\.cmd\('mRqClr'\)"/.test(typed), "the button's id is its command");
}

console.log('\n══ it sits outside the repainted body, and the field leaves room for it ══');
{
  const typed = painted({ q: 'toma' });
  ok(typed.indexOf('id="mRqClr"') < typed.indexOf('id="mRqBody"'),
     'the × is outside #mRqBody — the repaint must never be what draws it');
  ok(/class="srchwrap"/.test(typed), 'the field is wrapped in the span the × is positioned against');
  // The room is reserved in CSS, once, rather than inline at fifteen call sites.
  ok(/\.srchwrap>input\{padding-right:46px\}/.test(SRC),
     'the field reserves the room permanently, so the text never shifts under the caret');
  ok(/\.srchclr\{position:absolute/.test(SRC),
     'and the × is positioned against the field, not against the screen padding');
  const sb = { T: (en) => en, ic: () => '', console };
  vm.createContext(sb);
  vm.runInContext(sliceFn('searchBox'), sb, { filename: 'slice#searchBox' });
  ok(/class="iconbtn srchclr"/.test(vm.runInContext(`searchBox('<input>','a',true)`, sb)),
     'it is a 44px .iconbtn, not a bare glyph — this is a thumb target');
  ok(/style="flex:1"/.test(vm.runInContext(`searchBox('<input>','a',true,'flex:1')`, sb)),
     'and a box that lives in a flex row can say so');
}

console.log('\n══ it refuses the focus change rather than undoing one ══');
{
  const box = sliceFn('searchBox');
  ok(/onmousedown="event\.preventDefault\(\)"/.test(box),
     'onmousedown prevents the blur — a blur closes the soft keyboard');
  ok(!/\.focus\(\)/.test(box) && !/\.focus\(\)/.test(sliceFn('searchClearRun')),
     'and nothing re-focuses afterwards: re-focusing reopens the keyboard on its letter page');
}

/* ── 5 · the handlers, against a fake field ───────────────────────────────── */
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
  for (const n of ['searchClearShow', 'searchClearRun']) {
    vm.runInContext(sliceFn(n), sb, { filename: `slice#${n}` });
  }
  vm.runInContext(handlerBody('rqSearch'), sb, { filename: 'reg#rqSearch' });

  sb.CMD.rqSearch('tom');
  ok(clr.style.display === '', 'a keystroke with something in it shows the ×');
  sb.CMD.rqSearch('');
  ok(clr.style.display === 'none', 'backspacing to empty hides it again');

  clr.style.display = ''; body.innerHTML = 'STALE'; el.value = 'toma'; sb.state.rq.q = 'toma';
  vm.runInContext(`searchClearRun('mRqQ','mRqClr','rqSearch')`, sb);
  ok(el.value === '', 'the × empties the field itself — the handler is told a value, it cannot read one');
  ok(sb.state.rq.q === '', 'and the query in state with it');
  ok(body.innerHTML === 'FRESH', 'the list under it is repainted');
  ok(clr.style.display === 'none', 'and the × takes itself away');
  ok(renders === 0, 'none of that re-rendered the app');

  // A box whose handler is not registered must not throw — the sheet search
  // reaches this path before its screen has ever been painted.
  let threw = null;
  try { vm.runInContext(`searchClearRun('mNope','mNopeClr','noSuchHandler')`, sb); }
  catch (e) { threw = e; }
  ok(!threw, 'and an unregistered handler is a no-op rather than a thrown error');
}

/* ── 6 · the guards the wrapper could have broken ─────────────────────────── */
console.log('\n══ the sibling guards survive the wrapper ══');
{
  // Both of these ask "is the focused field the box's previous sibling?". The
  // wrapper makes the SPAN the sibling, so an identity check now falls through
  // to a full re-render on every keystroke — the rebuilt-field defect, restored.
  const onw = sliceFn('onwRepaint');
  ok(/\.contains\(on\)/.test(onw),
     'onwRepaint accepts the field inside its wrapper, not only the field itself');
  ok(!/if\(box&&on&&box\.previousElementSibling===on\)/.test(onw),
     'and no longer demands the input BE the sibling');
  const caddr = handlerBody('caddrCityQ');
  ok(/\.contains\(on\)/.test(caddr), 'the customer-address city box carries the same guard');
  ok(!/box\.previousElementSibling===on/.test(caddr), 'and not the old identity check');
  // Waste checks by id instead, which the wrapper cannot affect — so it is
  // correct as it stands and is asserted so nobody "fixes" it into a sibling test.
  const wst = sliceFn('wstRepaintPicks');
  ok(/activeElement\.id==='mWstQ'/.test(wst),
     'waste identifies its field by id, which a wrapper cannot break');
}

/* ── 7 · the standing rule, extended to every handler that now toggles ────── */
console.log('\n══ no search handler rebuilds its own field ══');
for (const [name, ids] of [['rqSearch', ['mRqBody']], ['qsSearch', ['mQsBody']],
                           ['batSearch', ['mBatTop', 'mBatBody']], ['mbSearch', ['mMbBody']],
                           ['prodSearch', ['mProdBody']], ['expQ', ['mExpPickBody']]]) {
  const body = handlerBody(name);
  const renders = (body.match(/render\(\)/g) || []).length;
  ok(renders === 1 && /else\s+render\(\)/.test(body),
     `${name} keeps render() only as the not-painted fallback`);
  ok(ids.every(id => body.includes(id)), `${name} patches ${ids.join(' + ')}`);
  ok(/searchClearShow\('m[A-Za-z]+Clr'/.test(body), `${name} shows and hides its own ×`);
}
{
  // The order sheet is the one handler that exists ONLY for the ×.
  const sheet = handlerBody('orderSheetQ');
  ok(/searchClearShow\('mSearchClr'/.test(sheet) && !/render\(\)/.test(sheet) && !/innerHTML/.test(sheet),
     'orderSheetQ toggles the × and repaints nothing — its list is built when the sheet opens');
  // Customers fetches on Enter, so its × has to ask for the list again or it
  // would empty the box and leave the old results showing.
  const cust = handlerBody('mCustClr');
  ok(/loadCustomers\(\)/.test(cust),
     'the customers × asks for the list again — clearing a search there means a fetch');
}

/* ── 8 · the words ────────────────────────────────────────────────────────── */
console.log('\n══ the label is the live pair, not a new one ══');
{
  const box = sliceFn('searchBox');
  ok(/T\('Clear','清除'\)/.test(box), 'it reads Clear · 清除 — copied, nothing composed');
  ok((SRC.match(/T\('Clear','清除'\)/g) || []).length >= 2,
     'and that pair was already live in this file before the × existed');
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
