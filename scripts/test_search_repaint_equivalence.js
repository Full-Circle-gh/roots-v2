#!/usr/bin/env node
/**
 * Four search boxes stopped re-rendering the app — and drew the same thing.
 *
 *   node scripts/test_search_repaint_equivalence.js
 *
 * THE CHANGE THIS GUARDS. `render()` replaces the whole app in one innerHTML,
 * so a search box whose `oninput` called it was destroyed and rebuilt on every
 * keystroke — and a rebuilt <input> opens a fresh soft keyboard on its letter
 * page. Ash reported it from the kitchen: typing a SKU gave one digit, then the
 * alphabet, then one digit.
 *
 * Ask to buy was fixed first (#437). This covers the rest of them:
 *
 *   rqPicker              Ask for stock, Ask the kitchen
 *   screenStockAdd        Add stock
 *   screenLogBatch        Log a batch
 *   screenProductCatalogue  Products
 *   screenReceiving       Receiving — both tabs
 *
 * Customers is fixed too and has no entry above, because it needed no split at
 * all: its list is fetched on Enter, so between keystrokes the query changes
 * nothing on screen and the handler now repaints nothing.
 *
 * RECEIVING IS THE ONE WHERE THE SEARCH REALLY GOES TO THE SERVER, and it needed
 * both ends: the keystroke, and the answer that lands 320ms later. Either alone
 * would still rebuild the field.
 *
 * WHY THIS FILE IS AN EQUIVALENCE TEST RATHER THAN A FEATURE TEST. Nothing about
 * what those screens SHOW was meant to change. Each was split so that the part
 * below the search box could be repainted on its own, and a split is exactly the
 * kind of edit that silently drops a branch — an error state, an empty state, a
 * footer. So the shipped functions are run beside the ones they replaced, taken
 * out of git, and their markup is compared.
 *
 * Both sides are SLICED FROM SOURCE and evaluated against identical stubs: the
 * old out of git at the baseline named below, the new from the working tree.
 * Nothing is asserted against a copy of the markup written into this file.
 *
 * WHITESPACE IS NORMALISED AND THE NEW WRAPPERS ARE STRIPPED, because those two
 * things are the whole of what was allowed to change. Everything else — every
 * tag, attribute, style and string — must match character for character.
 *
 * Cases, for each function and across every branch each has:
 *   1. the same markup comes out
 *   2. the container the repaint needs is actually in the new output
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const NEW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');

/* TWO HALVES, AND ONLY ONE OF THEM IS A REGRESSION TEST.
 *
 * The HANDLER half — no search handler re-renders the app, each patches its own
 * container, none needs a focus rescue — is a permanent rule and runs always. It
 * is the thing that must not come back.
 *
 * The EQUIVALENCE half is a MIGRATION PROOF and runs only under EQUIV=1. It is
 * deliberately off by default, and the reason is this file's own honesty rather
 * than convenience. Comparing against HEAD would compare the new code with
 * itself the moment a change lands — a test that cannot fail. Running the pinned
 * comparison on every CI pass would instead turn red on the next legitimate edit
 * to any of these screens, for a change nobody got wrong, which is precisely how
 * scripts/run-suites.js's header describes a suite becoming noise people learn
 * to ignore.
 */
/* TWO ROUNDS, TWO BEFORE-PICTURES. The first three screens were split in one
   change and the second three in the next, so a single baseline would compare
   half of them with themselves and quietly pass. Each group is therefore pinned
   to the commit it was actually split from.

   Set EQUIV=1 to run the comparison; without it only the handler rules run. */
const EQUIV = !!process.env.EQUIV;
const BASE_A = process.env.BASE_A || '106d764d';   // before rqPicker / screenStockAdd / screenLogBatch
const BASE_B = process.env.BASE_B || '8a6d336b';   // before the Products catalogue / Receiving
const at = (ref) => execFileSync('git', ['show', `${ref}:public/m.html`],
  { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString();
const SRC_A = EQUIV ? at(BASE_A) : null;
const SRC_B = EQUIV ? at(BASE_B) : null;
// What each group compares against. OLD_SRC is reassigned per group below.
let OLD_SRC = null;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };

function sliceFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced braces slicing ${name}`);
}

/* The stub surface. Every leaf helper returns something DETERMINISTIC and
   distinctive, so that a branch quietly disappearing shows up as missing text
   rather than as two empty strings agreeing with each other. */
function makeSandbox(state) {
  const sb = {
    state,
    T: (en) => en,
    escAttr: (s) => String(s == null ? '' : s),
    ic: (n) => `[icon:${n}]`,
    nothingYet: (a, b) => `[nothingYet:${a}|${b}]`,
    qsName: (p) => p.name_en || '',
    rqName: (p) => p.name_en || '',
    batId: (p) => (p.product_id != null ? p.product_id : p.id),
    qsMode: () => 'add',
    asstCan: () => false,   // §495 rule 14: the shelf's mic is the assistant's, drawn only when it is open to the operator
    qsShelf: (p) => p.shelf == null ? 0 : p.shelf,
    qsMeta: (p, id) => `[meta:${id}]`,
    qsCountCell: (p, id) => `[count:${id}]`,
    qsCardFoot: (id) => `[foot:${id}]`,
    batChosen: () => [],
    batUnits: () => 0,
    loadQsCtx: () => {},
    console, Number, String, Array, Object, JSON, Math,
  };
  vm.createContext(sb);
  return sb;
}
// Helpers that genuinely filter are sliced from the NEW tree and shared by both
// sides — they are not what changed, and stubbing them would hide a filter bug
// behind two identical stubs.
/* searchBox is here for a different reason: it is not a filter. It is the
   search field wrapper carrying the × that empties the box, added to all
   fifteen of the phone's search boxes AFTER both baselines below were taken.
   The old screens never called it, so it is loaded from the new tree purely to
   let the old side run at all — and the equivalence half is expected to report
   the button as a difference, because it is one. See the EQUIV note above:
   that half is a migration proof, off by default, and a legitimate later edit
   to one of these screens is exactly what turns it red.
   The × itself is covered by scripts/test_search_clear.js, which holds the
   rules this suite's handler half and that one share. */
/* rcvSkuKey / rcvSkuCmp are here because qsRows sorts by them: Add stock runs
   in SKU order, on Receiving's comparator. Real, for the reason above. */
const SHARED = ['rcvSkuKey', 'rcvSkuCmp', 'qsRows', 'rqKindOf', 'rqLines', 'rqKindSeg', 'batLines', 'searchBox'];

function load(sb, src, names) {
  for (const n of SHARED) vm.runInContext(sliceFn(NEW_SRC, n), sb, { filename: `shared#${n}` });
  for (const n of names) vm.runInContext(sliceFn(src, n), sb, { filename: `slice#${n}` });
}

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const strip = (s) => String(s)
  .replace(/<div id="(mRqBody|mQsBody|mBatBody|mBatTop|mProdBody|mRcvSegs|mRcvToBody|mRcvBody)">/g, '')
  // the closing tags those four wrappers added; every other </div> is original
  .replace(/<\/div>/g, '</div>');

/* Compare by content rather than by tag count: the wrappers add an opening tag
   and a closing tag each, so the closing tags cannot simply be counted off.
   Removing ALL of a run's whitespace and both wrapper openings leaves exactly
   one extra `</div>` per wrapper, which is subtracted by comparing the two
   sides with every `</div>` collapsed out. Every other character must match. */
const shape = (s) => norm(strip(s))
  // ORDER MATTERS HERE. Whitespace BETWEEN tags is insignificant to the browser
  // and is the one thing wrapping a block in a <div> is bound to change: the old
  // markup had a newline and an indent where the new one has none. It has to be
  // collapsed while the tags on both sides of it are still present — do it after
  // the closing tags come out and the space loses its anchor and survives.
  .replace(/>\s+</g, '><')
  .replace(/<\/div>/g, '')
  .replace(/\s+/g, ' ').trim();

function compare(label, oldSb, newSb, call) {
  if (!OLD_SRC) return;                      // migration proof only — see BASELINE above
  let a, b;
  try { a = call(oldSb); } catch (e) { fail++; console.log(`  ✗ ${label} — OLD threw: ${e.message}`); return; }
  try { b = call(newSb); } catch (e) { fail++; console.log(`  ✗ ${label} — NEW threw: ${e.message}`); return; }
  if (shape(a) === shape(b)) { pass++; console.log('  ✓ ' + label); return; }
  fail++;
  console.log(`  ✗ ${label}`);
  const x = shape(a), y = shape(b);
  let i = 0; while (i < x.length && i < y.length && x[i] === y[i]) i++;
  console.log(`      diverges at ${i}`);
  console.log(`      old: …${x.slice(Math.max(0, i - 60), i + 90)}`);
  console.log(`      new: …${y.slice(Math.max(0, i - 60), i + 90)}`);
}

const PRODUCTS = [
  { id: 1, product_id: 1, name_en: 'Oat Milk',  name_cn: '燕麦奶', sku: 'P-1', shelf: 4 },
  { id: 2, product_id: 2, name_en: 'Rye Loaf',  name_cn: '黑麦面包', sku: 'P-2', shelf: 0 },
];

OLD_SRC = SRC_A;
// ── rqPicker — Ask for stock and Ask the kitchen ──────────────────────────
console.log('\n══ rqPicker · Ask for stock / Ask the kitchen ══');
{
  const mk = (over) => ({ rq: Object.assign(
    { products: PRODUCTS.slice(), tried: true, fromShelf: false, q: '', qty: {}, busy: false, err: '', sent: null,
      purpose: null, from: null, to: null }, over) });
  for (const [label, over] of [
    ['every product, nothing typed',      {}],
    ['a query that matches one',          { q: 'oat' }],
    ['a query that matches nothing',      { q: 'zzz' }],
    ['the shelf-fallback note showing',   { fromShelf: true }],
    ['quantities already picked',         { qty: { 1: 3 } }],
    ['the catalogue still loading',       { products: null }],
  ]) {
    if (!OLD_SRC) continue;
    const o = makeSandbox(mk(over)), n = makeSandbox(mk(over));
    load(o, OLD_SRC, ['rqPicker']);
    load(n, NEW_SRC, ['rqPicker', 'rqCountCell', 'rqBodyHtml']);
    compare(label, o, n, sb => sb.rqPicker());
  }
  const n = makeSandbox(mk({}));
  load(n, NEW_SRC, ['rqPicker', 'rqCountCell', 'rqBodyHtml']);
  ok(n.rqPicker().includes('id="mRqBody"'), 'and the new output carries the container the repaint needs');
}

// ── screenStockAdd — Add stock ────────────────────────────────────────────
console.log('\n══ screenStockAdd · Add stock ══');
{
  const mk = (over) => ({ qs: Object.assign(
    { ctx: { enabled: true, stores: [{ id: 1 }] }, ctxErr: null, itemsErr: null,
      items: PRODUCTS.slice(), q: '', add: {}, inflight: {}, rowErr: {}, fixing: {},
      typing: {}, typeErr: {}, canRecount: false, mode: 'add' }, over) });
  for (const [label, over] of [
    ['every product, nothing typed',   {}],
    ['a query that matches one',       { q: 'rye' }],
    ['a query that matches nothing',   { q: 'zzz' }],
    ['an empty catalogue, no query',   { items: [] }],
    ['the list failing to load',       { itemsErr: 'Could not load.' }],
    ['the list still loading',         { items: null }],
    ['a pending add on a card',        { add: { 1: 5 } }],
    ['a row error with its retry',     { rowErr: { 2: 'Nope.' } }],
  ]) {
    if (!OLD_SRC) continue;
    const o = makeSandbox(mk(over)), n = makeSandbox(mk(over));
    load(o, OLD_SRC, ['screenStockAdd']);
    load(n, NEW_SRC, ['screenStockAdd', 'qsBodyHtml']);
    compare(label, o, n, sb => sb.screenStockAdd());
  }
  const n = makeSandbox(mk({}));
  load(n, NEW_SRC, ['screenStockAdd', 'qsBodyHtml']);
  ok(n.screenStockAdd().includes('id="mQsBody"'), 'and the new output carries the container the repaint needs');
}

// ── screenLogBatch — Log a batch ──────────────────────────────────────────
console.log('\n══ screenLogBatch · Log a batch ══');
{
  const mk = (over) => ({
    qs: { items: PRODUCTS.slice(), ctx: { enabled: true, stores: [{ id: 1 }] } },
    bat: Object.assign({ q: '', qty: {} }, over),
  });
  for (const [label, over] of [
    ['every product, nothing typed',  {}],
    ['a query that matches one',      { q: 'oat' }],
    ['a query that matches nothing',  { q: 'zzz' }],
    ['quantities already entered',    { qty: { 1: 2 } }],
  ]) {
    if (!OLD_SRC) continue;
    const o = makeSandbox(mk(over)), n = makeSandbox(mk(over));
    load(o, OLD_SRC, ['screenLogBatch']);
    load(n, NEW_SRC, ['screenLogBatch', 'batTopHtml', 'batBodyHtml']);
    compare(label, o, n, sb => sb.screenLogBatch());
  }
  // The list still loading: the old screen dropped its header on this branch and
  // so does the new one — asserted rather than assumed, because the header is
  // the one thing that moved into a container of its own.
  {
    const st = mk({}); st.qs.items = null;
    if (OLD_SRC) {
    const o = makeSandbox(st), n = makeSandbox(JSON.parse(JSON.stringify(st)));
    load(o, OLD_SRC, ['screenLogBatch']);
    load(n, NEW_SRC, ['screenLogBatch', 'batTopHtml', 'batBodyHtml']);
    compare('the list still loading', o, n, sb => sb.screenLogBatch());
    }
  }
  const n = makeSandbox(mk({}));
  load(n, NEW_SRC, ['screenLogBatch', 'batTopHtml', 'batBodyHtml']);
  const out = n.screenLogBatch();
  ok(out.includes('id="mBatTop"') && out.includes('id="mBatBody"'),
     'and the new output carries both containers the repaint needs');
  // The header belongs above the box, and staying there is the reason it needed
  // a second container rather than riding with the list.
  ok(out.indexOf('id="mBatTop"') < out.indexOf('id="mBatQ"'), 'with the header still above the search box');
  ok(out.indexOf('id="mBatQ"') < out.indexOf('id="mBatBody"'), 'and the list still below it');
}

OLD_SRC = SRC_B;
// ── screenProductCatalogue — the Products catalogue ───────────────────────
// Baseline for this one and the two below: 8a6d336b (they were split a round
// later than the three above, so they have their own before-picture).
console.log('\n══ screenProductCatalogue · Products ══');
{
  const PRODS = [
    { id: 1, name_en: 'Oat Milk', name_cn: '燕麦奶', sku: 'P-1', kind: 'simple', is_active: 1 },
    { id: 2, name_en: 'Rye Loaf', name_cn: '黑麦面包', sku: 'P-2', kind: 'simple', is_active: 1 },
  ];
  const mk = (over) => Object.assign({
    prodQ: '', prodStatus: 'all', prodCat: 'all', prodErr: null,
    liveProductsLoaded: true, catalogueComplete: true, catalogueLoading: false, prodTotal: 2,
    // §325 PD1: the store switch, the subcategory chips and the two highlight
    // chips, all at rest — none drawn — so the comparison is of the same list.
    prodSub: 'all', prodStore: '', prodGrid: { stores: [] }, prodHi: { data: null },
  }, over);
  const extra = {
    DB: { products: PRODS.slice() },
    loadCatalogue: () => {},
    loadProdGrid: () => {}, loadProdHi: () => {},
    prodRows: () => PRODS.slice(), prodSubcats: () => [], prodStoreOn: () => false,
    mCan: () => false,
    // §325 X3: the Count sheet button beside Export. With mCan false it is not
    // drawn, exactly as Export is not, so the two outputs still compare.
    countButton: () => '',
    // §325 PD14: Select and the bulk bar — not selecting, so neither is drawn.
    prodBulkAny: () => false, prodBulkBar: () => '',
    prodCategories: () => [],
    prodFiltered: () => PRODS.slice(),
    prodUnits: (r) => r,
    productCard: (p) => `[card:${p.id}]`,
    chipRow: (a, sel, key) => `[chips:${key}:${sel}]`,
    noteBar: (t) => `[note:${t}]`,
  };
  const build = (over) => {
    const sb = makeSandbox(mk(over));
    Object.assign(sb, extra, { prodFiltered: () => (over && over._rows) || PRODS.slice() });
    return sb;
  };
  for (const [label, over] of [
    ['the whole catalogue',        {}],
    ['a query narrowing it',       { prodQ: 'oat', _rows: [PRODS[0]] }],
    ['a query matching nothing',   { prodQ: 'zzz', _rows: [] }],
    ['the catalogue still walking', { catalogueLoading: true, catalogueComplete: false }],
    ['only part of it held',       { catalogueComplete: false, prodTotal: 900 }],
    ['an error on the catalogue',  { prodErr: 'Could not load.' }],
  ]) {
    if (!OLD_SRC) continue;
    const o = build(over), n = build(over);
    // The old screen was an inline arrow in SUBS; it is sliced by locating that
    // entry rather than by name, because it did not have one.
    const arrowAt = OLD_SRC.indexOf("products:{title:['Products','产品'],render:()=>{");
    let d = 0, s0 = OLD_SRC.indexOf('{', arrowAt + "products:{title:['Products','产品'],render:()=>".length), e0 = -1;
    for (let j = s0; j < OLD_SRC.length; j++) {
      const c = OLD_SRC[j];
      if (c === '{') d++; else if (c === '}') { d--; if (d === 0) { e0 = j; break; } }
    }
    vm.runInContext(`function screenProductCatalogue()${OLD_SRC.slice(s0, e0 + 1)}`, o, { filename: 'old#catalogue' });
    load(n, NEW_SRC, ['screenProductCatalogue', 'prodBodyHtml']);
    compare(label, o, n, sb => sb.screenProductCatalogue());
  }
  const n = build({});
  load(n, NEW_SRC, ['screenProductCatalogue', 'prodBodyHtml']);
  ok(n.screenProductCatalogue().includes('id="mProdBody"'), 'and the new output carries the container the repaint needs');
  ok(n.screenProductCatalogue().indexOf('id="mProdQ"') < n.screenProductCatalogue().indexOf('id="mProdBody"'),
     'with the search box still above the list');
}

// ── screenReceiving — both tabs ───────────────────────────────────────────
console.log('\n══ screenReceiving · Receiving ══');
{
  const DELIV = [{ id: 1, po_number: 'RPO-1' }, { id: 2, po_number: 'RPO-2' }];
  const TO = [{ id: 7, po_number: 'RPO-7' }];
  const mk = (over) => Object.assign({
    rcvSeg: 'received', rcvQ: '', rcvToQ: '', rcvFlag: 'all',
    rcvDeliv: DELIV.slice(), rcvTo: TO.slice(), rcvErr: null, rcvToErr: null,
    rcvLoading: false, rcvTried: true, rcvToTried: true,
  }, over);
  const extra = {
    loadToReceive: () => {}, loadDeliveries: () => {},
    rcvToReceive: () => TO.slice(),
    rcvDeliveryRow: (d) => `[deliv:${d.id}]`,
    rcvPartial: () => false,
    poPill: () => '[popill]',
    pill: (k, l) => `[pill:${k}:${l}]`,
    RCV_FLAGS: [{ key: 'all', en: 'All', zh: '全部' }],
    poStore: (p) => `[store:${p.id}]`,
    tdWhen: (d) => `[when:${d}]`,
    money: (n) => `[money:${n}]`,
    rcvMatched: (p) => `[matched:${p.id}]`,
    fmtDateOnly: (d) => `[date:${d}]`,
  };
  const build = (over) => { const sb = makeSandbox(mk(over)); Object.assign(sb, extra); return sb; };
  for (const [label, over] of [
    ['received · deliveries listed',   {}],
    ['received · a query set',         { rcvQ: 'mint' }],
    ['received · nothing matches',     { rcvDeliv: [], rcvQ: 'zzz' }],
    ['received · nothing at all yet',  { rcvDeliv: [] }],
    ['received · still loading',       { rcvDeliv: null }],
    ['received · an error',            { rcvErr: 'Could not load deliveries.' }],
    ['to receive · orders listed',     { rcvSeg: 'toreceive' }],
    ['to receive · a query set',       { rcvSeg: 'toreceive', rcvToQ: 'mint' }],
    ['to receive · still loading',     { rcvSeg: 'toreceive', rcvTo: null }],
    ['to receive · an error',          { rcvSeg: 'toreceive', rcvToErr: 'Could not load orders.' }],
  ]) {
    if (!OLD_SRC) continue;
    const o = build(over), n = build(over);
    if (over.rcvTo === null) { o.rcvToReceive = () => []; n.rcvToReceive = () => []; }
    if (Array.isArray(over.rcvDeliv) && !over.rcvDeliv.length) { /* empty list stays empty */ }
    load(o, OLD_SRC, ['screenReceiving']);
    load(n, NEW_SRC, ['screenReceiving', 'rcvSegsHtml', 'rcvToBodyHtml', 'rcvBodyHtml']);
    compare(label, o, n, sb => sb.screenReceiving());
  }
  const n = build({});
  load(n, NEW_SRC, ['screenReceiving', 'rcvSegsHtml', 'rcvToBodyHtml', 'rcvBodyHtml']);
  const out = n.screenReceiving();
  ok(out.includes('id="mRcvSegs"') && out.includes('id="mRcvBody"'), 'the received tab carries both containers');
  ok(out.indexOf('id="mRcvSegs"') < out.indexOf('id="mRcvQ"'), 'with the counts above the search box');
  ok(out.indexOf('id="mRcvQ"') < out.indexOf('id="mRcvBody"'), 'and the list below it');
  const n2 = build({ rcvSeg: 'toreceive' });
  load(n2, NEW_SRC, ['screenReceiving', 'rcvSegsHtml', 'rcvToBodyHtml', 'rcvBodyHtml']);
  ok(n2.screenReceiving().includes('id="mRcvToBody"'), 'and the to-receive tab carries its own');
}

// ── the handlers themselves ───────────────────────────────────────────────
const handlerBody = (name) => {
  const at = NEW_SRC.indexOf(`reg('${name}'`);
  if (at < 0) throw new Error(`handler ${name} not found`);
  return NEW_SRC.slice(at, NEW_SRC.indexOf('\nreg(', at + 1));
};

console.log('\n══ no search handler rebuilds its own field ══');
for (const [name, ids] of [['rqSearch', ['mRqBody']], ['qsSearch', ['mQsBody']],
                           ['batSearch', ['mBatTop', 'mBatBody']], ['mbSearch', ['mMbBody']],
                           ['prodSearch', ['mProdBody']]]) {
  const body = handlerBody(name);
  // A render() survives ONLY as the fallback for a screen that is not painted.
  const renders = (body.match(/render\(\)/g) || []).length;
  ok(renders === 1 && /else\s+render\(\)/.test(body),
     `${name} keeps render() only as the not-painted fallback`);
  ok(ids.every(id => body.includes(id)), `${name} patches ${ids.join(' + ')}`);
  ok(!/\.focus\(\)/.test(body) && !/state\.focus\s*=/.test(body),
     `${name} needs no focus rescue — the input is never destroyed`);
}

/* The two that do not fit the shape above, each for its own reason. */
console.log('\n══ the two exceptions, and why each is one ══');
{
  // Customers fetches on Enter, so between keystrokes the query changes nothing
  // that is on the screen. The right amount of repainting is none.
  const cust = handlerBody('custSearch');
  ok(!/render\(\)/.test(cust) && !/innerHTML/.test(cust),
     'custSearch repaints nothing at all — its list is not filtered until Enter');
  ok(!/state\.focus\s*=/.test(cust), 'and arms no focus rescue');

  // Receiving goes to the server on a debounce, so BOTH the keystroke and the
  // answer have to stop re-rendering. Either alone still rebuilds the field.
  for (const name of ['rcvQuery', 'rcvToQuery']) {
    const body = handlerBody(name);
    ok(/rcvPatch\(\)/.test(body) && !/[^v]render\(\)/.test(body),
       `${name} patches through rcvPatch and never re-renders`);
    ok(!/state\.focus\s*=/.test(body), `${name} arms no focus rescue`);
  }
  // The answers, 320ms later. This is the half that is easy to miss.
  for (const fn of ['loadDeliveries', 'loadToReceive']) {
    const at = NEW_SRC.indexOf(`function ${fn}(`);
    const body = NEW_SRC.slice(at, NEW_SRC.indexOf('\nfunction ', at + 1));
    ok(!/[^v]render\(\)/.test(body) && /rcvPatch\(\)/.test(body),
       `${fn}'s answer patches too — fixing only the keystroke would still rebuild the field`);
  }
  // And the fallback, which is what makes patching safe when the operator has
  // moved on before the answer lands.
  const patch = NEW_SRC.slice(NEW_SRC.indexOf('function rcvPatch()'));
  ok(/return render\(\)/.test(patch.slice(0, 500)),
     'rcvPatch falls back to render() when the receiving screen is not the one showing');
}

if (!EQUIV) console.log('\n(equivalence against the pre-split markup not run — set EQUIV=1 to run it)');
console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
