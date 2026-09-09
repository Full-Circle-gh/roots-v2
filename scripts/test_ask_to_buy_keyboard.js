#!/usr/bin/env node
/**
 * "Every time I click one number it turns back to letters."
 *
 *   node scripts/test_ask_to_buy_keyboard.js
 *
 * THE COMPLAINT, from the kitchen, typing a SKU into Ask to buy: `h-545` came
 * out one digit at a time because Gboard dropped back to its letter page after
 * each one. Not a keyboard setting — the screen was doing it.
 *
 * WHY IT HAPPENED. `render()` in public/m.html "replaces the whole app in one
 * innerHTML" (its own header). A search box whose `oninput` calls render() is
 * therefore DESTROYED and rebuilt on every keystroke, and a brand-new <input>
 * gets a brand-new soft keyboard, which opens on letters. The caret rescue that
 * every search handler in that file performs is the acknowledgement of this: it
 * puts the cursor back afterwards. Nothing could put the keyboard back.
 *
 * THE FIX, AND WHAT THIS FILE LOCKS. Typing repaints the LIST only, through
 * `#mMbBody`, leaving the input element alone for the whole of a search; a
 * quantity step repaints the list and the foot's tally and nothing else. So the
 * property under test is not "the list filters" — it is "render() is not called,
 * and the input is never replaced".
 *
 * No browser and no network: the real functions are SLICED OUT OF THE SHIPPED
 * public/m.html and evaluated against stubs, the same technique
 * scripts/test_kitchen_ready_dashboard.js uses for the dashboard fires. Nothing
 * is asserted against a copy of the markup — every check reads back what the
 * shipped source produced.
 *
 * Cases:
 *   1. the screen gives the list and the foot their own patch targets
 *   2. typing patches #mMbBody and NEVER calls render()
 *   3. ...and never touches the input element, which is the whole bug
 *   4. the filter still works, over name, Chinese name and SKU
 *   5. a step patches the list AND the tally, still without render()
 *   6. with no patch target (screen not painted) both fall back to render()
 *   7. the empty state tells a load failure apart from a search miss
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'm.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };
const eq = (a, b, msg) => ok(a === b, `${msg} (got ${JSON.stringify(a)})`);

/* Slice a top-level `function NAME(` out of the shipped file by matching braces.
 * Deliberately not a regex over the body: these functions contain template
 * literals full of braces and a lazy match would take half of one. */
function sliceFn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in m.html`);
  let i = SRC.indexOf('{', start), depth = 0;
  for (let j = i; j < SRC.length; j++) {
    const c = SRC[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
  }
  throw new Error(`unbalanced braces slicing ${name}`);
}
/* The same, for a `reg('name', v=>{ … })` command handler. */
function sliceHandler(name) {
  const start = SRC.indexOf(`reg('${name}'`);
  if (start < 0) throw new Error(`handler ${name} not found in m.html`);
  let i = SRC.indexOf('{', start), depth = 0;
  for (let j = i; j < SRC.length; j++) {
    const c = SRC[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return SRC.slice(i + 1, j); }
  }
  throw new Error(`unbalanced braces slicing handler ${name}`);
}

// ── the sandbox ───────────────────────────────────────────────────────────
// A node records every innerHTML assignment AND keeps an identity, so "was the
// input replaced" is answerable rather than assumed.
let renderCalls = 0;
const nodes = new Map();
let missingNode = false;          // case 6 flips this to simulate an unpainted screen
function node(id) {
  if (!nodes.has(id)) {
    let html = '';
    nodes.set(id, {
      id, writes: 0,
      get innerHTML() { return html; },
      set innerHTML(v) { html = v; this.writes++; },
      focus() { this.focused = (this.focused || 0) + 1; },
      setSelectionRange() {},
    });
  }
  return nodes.get(id);
}
const sandbox = {
  state: { mb: { materials: null, tried: false, q: '', qty: {}, busy: false, err: '', sent: null } },
  document: { getElementById: id => (missingNode ? null : node(id)) },
  render: () => { renderCalls++; },
  T: (en) => en,
  escAttr: (s) => String(s == null ? '' : s),
  ic: () => '',
  rqName: (p) => p.name_en || p.name_cn || '',
  console, Number, String, Array, Object, JSON,
};
vm.createContext(sandbox);
for (const fn of ['mbLines', 'mbChosen', 'mbCountCell', 'mbBodyHtml', 'mbFootHtml',
                  'mbPatch', 'mbTypeOpen', 'mbTypeCommit', 'mbBump']) {
  vm.runInContext(sliceFn(fn), sandbox, { filename: `m.html#${fn}` });
}
// The handler body, wrapped so it can be called with the typed value.
vm.runInContext(`function mbSearchHandler(v){ ${sliceHandler('mbSearch')} }`, sandbox,
                { filename: 'm.html#mbSearch' });

const MATS = [
  { id: 11, name_en: 'Flour',     name_cn: '面粉',   sku: 'H-545',  buy_unit: 'bag' },
  { id: 12, name_en: 'Olive Oil', name_cn: '橄榄油', sku: 'M-2',    buy_unit: 'bottle' },
  { id: 13, name_en: 'Sea Salt',  name_cn: '海盐',   sku: 'S-9',    buy_unit: 'box' },
];
const reset = () => {
  sandbox.state.mb = { materials: MATS.slice(), tried: true, q: '', qty: {}, busy: false, err: '', sent: null,
                       typing: {}, typeErr: {} };
  renderCalls = 0; missingNode = false; nodes.clear();
};
// The typed-value handler is one line inside reg(); mirrored here rather than
// sliced, because slicing a one-line arrow body is more fragile than the line
// it would slice. Case 9 asserts the shipped source still matches this shape.
const type = (id, v) => { sandbox.state.mb.typing[id] = String(v == null ? '' : v); };

console.log('\n══ 1 · the screen gives the list and the foot their own patch targets ══');
// Read off the shipped source: without these ids there is nothing to patch and
// the handlers below would fall back to render() on every keystroke.
ok(/id="mMbBody"/.test(SRC), 'the list is wrapped in #mMbBody');
ok(/id="mMbFoot"/.test(SRC), 'the sticky bar carries #mMbFoot');
ok(SRC.indexOf('id="mMbQ"') > 0, 'and the search input still has its own id');

console.log('\n══ 2 · typing patches the list and NEVER re-renders ══');
reset();
const body = node('mMbBody');
const before = body.writes;
sandbox.mbSearchHandler('h-5');
eq(renderCalls, 0, 'render() was not called — the input is not destroyed');
eq(body.writes, before + 1, 'the list was patched exactly once');
eq(sandbox.state.mb.q, 'h-5', 'and the query was stored');

console.log('\n══ 3 · the input element is never touched — the whole bug ══');
reset();
const input = node('mMbQ');
const identity = input;
for (const s of ['h', 'h-', 'h-5', 'h-54', 'h-545']) sandbox.mbSearchHandler(s);
eq(renderCalls, 0, 'five keystrokes, zero re-renders');
eq(input.writes, 0, 'nothing was ever written into the input');
ok(node('mMbQ') === identity, 'and it is the same element throughout — a new one would open a new keyboard');
ok(!input.focused, 'no focus rescue was needed, because focus was never lost');

console.log('\n══ 4 · the filter still works ══');
reset();
sandbox.mbSearchHandler('h-545');
let html = node('mMbBody').innerHTML;
ok(html.includes('Flour') && !html.includes('Olive Oil'), 'a SKU search finds its material and only it');
sandbox.mbSearchHandler('橄榄');
html = node('mMbBody').innerHTML;
ok(html.includes('Olive Oil'), 'the Chinese name matches too');
sandbox.mbSearchHandler('zzz');
ok(node('mMbBody').innerHTML.includes('No materials match'), 'a miss says so');
sandbox.mbSearchHandler('');
html = node('mMbBody').innerHTML;
ok(html.includes('Flour') && html.includes('Olive Oil') && html.includes('Sea Salt'),
   'and clearing the box brings everything back');

console.log('\n══ 5 · a step patches the list and the tally, still without render() ══');
reset();
const foot = node('mMbFoot');
sandbox.mbBump(11, 1);
eq(renderCalls, 0, 'stepping does not re-render either — the keyboard survives a tap');
eq(node('mMbBody').writes, 1, 'the list was patched');
eq(foot.writes, 1, 'and so was the tally');
ok(foot.innerHTML.includes('>1</b> items'), 'which now reads one item');
ok(!/ disabled/.test(foot.innerHTML), 'and Send is live');
sandbox.mbBump(11, -1);
ok(/ disabled/.test(foot.innerHTML), 'stepping back to zero shuts Send again');
eq(sandbox.state.mb.qty[11], 0, 'and never goes negative');

console.log('\n══ 6 · with nothing painted, both fall back to render() ══');
// The fallback is what keeps these handlers safe if they are ever reached from
// somewhere the screen is not on — a stale command, a screen still loading.
reset();
missingNode = true;
sandbox.mbSearchHandler('flour');
eq(renderCalls, 1, 'a search with no list to patch re-renders instead');
sandbox.mbBump(12, 1);
eq(renderCalls, 2, 'and so does a step');

console.log('\n══ 7 · a list that could not be read is not an empty list ══');
reset();
sandbox.state.mb.materials = [];
sandbox.state.mb.err = 'The material list could not be read. Try again.';
ok(sandbox.mbBodyHtml().includes('could not be read'), 'a load failure says what went wrong');
sandbox.state.mb.err = '';
ok(sandbox.mbBodyHtml().includes('No materials yet'), 'a genuinely empty catalogue says that instead');
sandbox.state.mb.materials = MATS.slice();
sandbox.state.mb.q = 'zzz';
ok(sandbox.mbBodyHtml().includes('No materials match'), 'and a search miss keeps its own wording');

console.log('\n══ 8 · a quantity can be TYPED, because a hundred taps is not an input method ══');
// Ash: "what happens if need 100pc of something." This is the answer, and it is
// the property that matters — 100 reaches the basket in one go.
reset();
sandbox.mbTypeOpen(11);
ok(node('mMbBody').innerHTML.includes('id="mbnum-11"'), 'tapping the number opens a field');
ok(node('mMbBody').innerHTML.includes('inputmode="decimal"'), 'and asks for the number pad');
eq(renderCalls, 0, 'without re-rendering the app');
type(11, '100');
sandbox.mbTypeCommit(11);
eq(sandbox.state.mb.qty[11], 100, 'a hundred lands in one go');
eq(renderCalls, 0, 'still no re-render');
ok(!node('mMbBody').innerHTML.includes('id="mbnum-11"'), 'and the field closes behind it');
ok(node('mMbFoot').innerHTML.includes('>1</b> items'), 'the tally counts the line');

console.log('\n══ 9 · typing itself never repaints — the keyboard rule ══');
// The defect this whole file exists for, in its second form: a field rebuilt by
// its own oninput drops the keyboard exactly as the search box did.
ok(/reg\('mbTyped',\s*\(id,v\)=>\{\s*state\.mb\.typing\[Number\(id\)\]=String\(v==null\?''\:v\);\s*\}\);/
     .test(SRC.replace(/\s+/g, m => m.includes('\n') ? '\n' : ' ').replace(/\n/g, ' ')),
   'the shipped mbTyped handler stores and does nothing else — no render, no patch');
reset();
const bodyWrites = node('mMbBody').writes;
sandbox.mbTypeOpen(12);
const afterOpen = node('mMbBody').writes;
for (const s of ['1', '10', '100', '100.']) type(12, s);
eq(node('mMbBody').writes, afterOpen, 'four keystrokes patched the list zero times');
eq(renderCalls, 0, 'and re-rendered zero times');
ok(afterOpen > bodyWrites, 'only OPENING the field repainted, once');

console.log('\n══ 10 · decimals are allowed, because a material can be bought by the kilo ══');
// material_request_items.qty is REAL and the route takes any finite number above
// zero. Refusing 2.5 here would be the screen inventing a rule the column and
// the route do not have.
reset();
sandbox.mbTypeOpen(11); type(11, '2.5'); sandbox.mbTypeCommit(11);
eq(sandbox.state.mb.qty[11], 2.5, 'two and a half kilos is a quantity');

console.log('\n══ 11 · a non-number keeps the field open and says why ══');
// "13o" silently becoming 13 would write a quantity nobody entered.
reset();
sandbox.mbTypeOpen(11); type(11, '13o'); sandbox.mbTypeCommit(11);
ok(sandbox.state.mb.typing[11] != null, 'the field stays open');
ok(!!sandbox.state.mb.typeErr[11], 'an error is recorded against that row');
ok(node('mMbBody').innerHTML.includes('Enter a number'), 'and shown on it');
ok(sandbox.state.mb.qty[11] === undefined || sandbox.state.mb.qty[11] === 0,
   'and nothing was written into the basket');

console.log('\n══ 12 · an empty field is zero, which is how a line comes off ══');
reset();
sandbox.state.mb.qty[11] = 40;
sandbox.mbTypeOpen(11);
eq(sandbox.state.mb.typing[11], '40', 'the field opens showing what the row already holds');
type(11, ''); sandbox.mbTypeCommit(11);
eq(sandbox.state.mb.qty[11], 0, 'clearing it takes the line off');
ok(node('mMbFoot').innerHTML.includes('>0</b> items'), 'and the tally follows');

console.log('\n══ 13 · committing twice is safe, and a step takes what was typed ══');
// Enter blurs and then commits, so commit must survive being reached twice.
reset();
sandbox.mbTypeOpen(11); type(11, '7');
sandbox.mbTypeCommit(11); sandbox.mbTypeCommit(11);
eq(sandbox.state.mb.qty[11], 7, 'the second call is a no-op, not a reset');
// A + tapped on a row mid-type must not throw the typed figure away.
sandbox.mbTypeOpen(12); type(12, '99');
sandbox.mbBump(12, 1);
eq(sandbox.state.mb.qty[12], 100, 'stepping a row being typed into keeps the figure and adds to it');

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
