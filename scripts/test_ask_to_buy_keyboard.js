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
 *  14. the unit reads in Chinese on the Chinese app, and the map is complete
 *  15-20. §176's urgency and wanted-by day, and the count that looks tappable
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
/* The same brace-match, for a top-level `const NAME={ … }`. mbUnit reads a
 * module-level table, and a function sliced without the table it reads is a
 * ReferenceError at the first row rather than a wrong answer — which is how
 * this case was found. */
function sliceConst(name) {
  const start = SRC.indexOf(`const ${name}={`);
  if (start < 0) throw new Error(`const ${name} not found in m.html`);
  let i = SRC.indexOf('{', start), depth = 0;
  for (let j = i; j < SRC.length; j++) {
    const c = SRC[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return SRC.slice(start, j + 1) + ';'; }
  }
  throw new Error(`unbalanced braces slicing const ${name}`);
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
      // mbDateOpen asks the browser to raise the native day picker. Not every
      // browser has it and the shipped code already swallows that, so the stub
      // records the ask rather than pretending it cannot happen.
      showPicker() { this.picked = (this.picked || 0) + 1; },
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
vm.runInContext(sliceConst('MB_UNIT_CN'), sandbox, { filename: 'm.html#MB_UNIT_CN' });
// A `const` in a vm context is a lexical binding, not a property of the sandbox
// object, so it is read back explicitly rather than off `sandbox`.
const UNIT_CN = vm.runInContext('MB_UNIT_CN', sandbox);
for (const fn of ['mbUnit', 'mbLines', 'mbChosen', 'mbCountCell', 'mbBodyHtml', 'mbFootHtml',
                  'mbPatch', 'mbTypeOpen', 'mbTypeCommit', 'mbBump',
                  'mbDateLabel', 'mbUrgent', 'mbDateOpen', 'mbDateSet', 'mbMarksHtml', 'mbItems']) {
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
                       typing: {}, typeErr: {}, urg: {}, by: {}, dating: {} };
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

console.log('\n══ 14 · the unit reads in the language the rest of the row is in ══');
// `ingredients.buy_unit` is stored in English because lib/ingredient-cost.js
// validates it and firePriceAlertsForPO matches on it. The row around it is
// Chinese, and a raw `pcs` under a Chinese name is one language leaking into
// another. T() here returns the ENGLISH half (the stub at the top), so the
// checks below read the map directly rather than through a render.
reset();
eq(sandbox.mbUnit('pcs'), 'pcs', 'the English app is unchanged');
eq(UNIT_CN.pcs, '件', 'pcs has its Chinese word');
eq(UNIT_CN.kg, '公斤', 'and so does kg');
eq(sandbox.mbUnit(''), '', 'a material with no buy unit prints nothing, not a stray word');
eq(sandbox.mbUnit('firkin'), 'firkin', 'an unmapped unit falls through to itself rather than vanishing');
// THE MAP MUST COVER EVERY UNIT THE MATERIAL EDITOR CAN SET. lib/ingredient-cost.js
// owns the two lists; a unit added there and not here would print English on a
// Chinese row, which is the exact fault this locks.
const COST = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ingredient-cost.js'), 'utf8');
const unitsIn = (name) => {
  const m = COST.match(new RegExp(name + '\\s*=\\s*\\[([^\\]]*)\\]'));
  return m ? m[1].split(',').map(x => x.trim().replace(/^['\"]|['\"]$/g, '')).filter(Boolean) : [];
};
const everyUnit = unitsIn('MEASURE_BUY_UNITS').concat(unitsIn('CONTAINER_BUY_UNITS'));
ok(everyUnit.length >= 15, `the two buy-unit lists were found (${everyUnit.length} units)`);
const unmapped = everyUnit.filter(u => !UNIT_CN[u]);
eq(unmapped.join(','), '', 'every buy unit the editor offers has a Chinese word');
// And the row actually uses it rather than printing p.buy_unit raw.
ok(/mbUnit\(p\.buy_unit\)/.test(SRC), 'the picker row calls mbUnit rather than printing buy_unit raw');
// DISPLAY ONLY: what is sent is still the id and the number.
ok(!/MB_UNIT_CN/.test(sliceFn('mbItems')), 'mbItems never touches the map — the wire is unchanged');

console.log('\n══ 15 · §176 · the two marks live on the row, and only on a row with a number ══');
// Ash chose shape C: urgency AND a wanted-by day, both per LINE. The ordinary
// line must stay one tap, so the controls appear only once a quantity exists.
reset();
ok(!/mbMarksHtml/.test(sandbox.mbBodyHtml()), 'a list of empty rows draws no marks at all');
sandbox.mbBump(11, 1);
const marksHtml = node('mMbBody').innerHTML;
ok(marksHtml.includes("APP.cmd('mbUrgent',11)"), 'the row with a number gains an Urgent control');
ok(marksHtml.includes("APP.cmd('mbDateOpen',11)"), 'and a day control');
ok(!marksHtml.includes("APP.cmd('mbUrgent',12)"), 'the row still at zero gains neither');
// ...and loses them again when it goes back to zero, or a request could carry an
// urgency belonging to a line nobody ordered.
sandbox.mbBump(11, -1);
ok(!/mbUrgent/.test(node('mMbBody').innerHTML), 'stepping back to zero takes them away');

console.log('\n══ 16 · the marks reach the wire, and an unclaimed mark sends nothing ══');
reset();
sandbox.mbBump(11, 4); sandbox.mbBump(12, 2);
sandbox.mbUrgent(11);
sandbox.mbDateSet(12, '2026-12-24');
const items = sandbox.mbItems();
eq(items.length, 2, 'both chosen lines are sent');
const a = items.find(i => i.ingredient_id === 11), b = items.find(i => i.ingredient_id === 12);
eq(a.urgent, true, 'the urgent line says so');
eq('needed_by' in a, false, 'and carries no day key at all, rather than a null');
eq(b.needed_by, '2026-12-24', 'the dated line carries its day');
eq('urgent' in b, false, 'and no urgency key — absent means absent (§39)');
// A MARK ON A ROW THAT IS NOT IN THE REQUEST IS NOT IN THE REQUEST.
sandbox.mbBump(11, -4);
ok(!sandbox.mbItems().some(i => i.ingredient_id === 11), 'a row stepped to zero leaves the payload');

console.log('\n══ 17 · urgent toggles, a day is set and cleared, and neither repaints the app ══');
reset();
sandbox.mbBump(11, 1);
renderCalls = 0;
sandbox.mbUrgent(11);
eq(!!sandbox.state.mb.urg[11], true, 'the first tap claims urgency');
sandbox.mbUrgent(11);
eq(!!sandbox.state.mb.urg[11], false, 'the second gives it back');
sandbox.mbDateSet(11, '2026-10-01');
eq(sandbox.state.mb.by[11], '2026-10-01', 'a day is stored as the ISO string the input gives');
sandbox.mbDateSet(11, '');
eq(sandbox.state.mb.by[11], undefined, 'and an empty value clears it, which is how a line loses its day');
eq(renderCalls, 0, 'none of it called render() — this screen patches, it does not repaint');
// Opening the field asks for the native picker rather than drawing a calendar.
sandbox.mbDateOpen(11);
eq(sandbox.state.mb.dating[11], 1, 'the field opens');
ok((node('mbday-11').picked || 0) > 0, 'and the browser is asked to raise its own day picker');

console.log('\n══ 18 · the day reads as a day, in both languages, without moving ══');
// `new Date('2026-09-30')` is UTC midnight and prints as the 29th anywhere west
// of Greenwich. A wanted-by day that shifts with the reader's clock is the one
// thing this label must not do, so it is parsed by hand.
eq(sandbox.mbDateLabel('2026-09-30'), '30 Sep', 'the English label names the day it was given');
eq(sandbox.mbDateLabel('2026-01-01'), '1 Jan', 'and the turn of the year');
eq(sandbox.mbDateLabel(''), '', 'no day, no label');
eq(sandbox.mbDateLabel('nonsense'), '', 'and nothing invented from rubbish');

console.log('\n══ 19 · the tally counts urgent lines, over what is CHOSEN ══');
reset();
sandbox.mbBump(11, 2); sandbox.mbUrgent(11);
sandbox.mbBump(12, 1);
sandbox.mbPatch();
ok(node('mMbFoot').innerHTML.includes('>1</span> urgent'), 'one urgent line is counted');
// Flagged, then stepped off the list: it is not in the request, so it is not in
// the count. Counting `urg` directly would have printed 1 here.
sandbox.mbBump(11, -2);
ok(!/urgent/.test(node('mMbFoot').innerHTML), 'and a flagged row stepped to zero is counted by nobody');

console.log('\n══ 20 · the count wears an edge, because an invisible affordance is not one ══');
// It opened a keypad from the day §46 built it and looked exactly like the SKU
// line above it, which is a label. Ash asked for a feature that was already
// there. Same finding, same fix, as .qsnum on the Quick Stock card.
reset();
const cell = sandbox.mbCountCell(MATS[0]);
ok(/border:1\.5px solid var\(--edge\)/.test(cell), 'the closed count carries the edge every control here has');
ok(/background:var\(--surface-raised\)/.test(cell), 'and the raised ground that goes with it');
ok(!/border:0/.test(cell), 'and no longer declares itself borderless');
ok(/APP\.cmd\('mbType'/.test(cell), 'while still being the button that opens the keypad');

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
