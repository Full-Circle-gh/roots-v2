#!/usr/bin/env node
//
// test_material_search_typing.js — the search box on the Materials list, and
// the identical one on Recipes (public/retail-admin/18-materials.js,
// 19-recipes.js).
//
// THE DEFECT THIS COVERS, reported as "物料的搜索栏有点问题 … 我的文字还没输入
// 它就卡顿了" — the box stutters before the text has even been entered.
//
// Three separate faults, all of them in the same quarter-second:
//
//   1. EVERY LOAD REPAINTED THE WHOLE LIST ROOT, search box included. The field
//      being typed into was destroyed and rebuilt, and focus plus the caret were
//      handed back by hand — always to the END of the value, so correcting a
//      typo mid-term threw you to the end of it. An IME composition cannot be
//      handed back at all: the candidate window dies with the element that owned
//      it. That is the reported symptom exactly — for Chinese the field went
//      dead before a single character was committed.
//
//   2. THE "Loading…" LINE FIRED ON EVERY KEYSTROKE ONCE A SEARCH MATCHED
//      NOTHING. Its condition was `!_rows.length`, and it writes the whole root.
//      So the moment you were mid-word on a term with no matches YET — which for
//      a Chinese name is every pinyin letter of it — the field was replaced by
//      the word "Loading…", per keystroke.
//
//   3. HALF-TYPED PINYIN WAS SEARCHED FOR. A Chinese keyboard fires an input
//      event per letter while the candidate window is open — "s", "sh", "sha" —
//      none of it typed by anybody, none of it matching a catalogue stored in
//      characters. Four requests and four repaints for one character.
//
// And one fault that showed up as wrong rows rather than as lag: responses were
// not sequenced, so a slow answer for "sa" could repaint over the answer for
// "salt" and leave the table disagreeing with the box.
//
// WHY BOTH SCREENS. 19-recipes.js carries a verbatim copy of the same list code
// — same debounce, same repaint, same focus hand-back. The battery below runs
// against both, from one definition, so the copy cannot quietly drift back.
//
// WHAT THE STUB HAS TO BE HONEST ABOUT. Element IDENTITY. A test that only reads
// HTML back cannot tell "the box survived" from "the box was rebuilt with the
// same value in it" — and that difference is the entire bug. So setting a node's
// innerHTML here mints FRESH child nodes, exactly as a browser does, and the
// assertions compare object identity across a load.
//
// USAGE   node scripts/test_material_search_typing.js
// EXIT    0 every assertion held · 1 an assertion failed

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

// ── assert harness ────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };

const sleep = ms => new Promise(r => setTimeout(r, ms));
// The modules fire their reload off a 250ms debounce and do not await it, so
// the battery waits out the timer plus the fetch rather than reaching into
// either.
const settle = () => sleep(60);
const afterDebounce = () => sleep(340);

// ── DOM stub ──────────────────────────────────────────────────────────────
// Only as much document as this code touches, with one thing modelled
// properly: writing innerHTML DESTROYS the elements that were inside and mints
// new ones. Everything below turns on being able to see that happen.
function makeDom() {
  const nodes = new Map();
  const ID = /\bid="([A-Za-z0-9_-]+)"/g;

  function makeNode(id) {
    const n = {
      id, _html: '', _ids: new Set(), _writes: 0, _on: {},
      value: '', checked: false, hidden: false, style: {}, children: [],
      _focused: 0, _caretSet: 0,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      focus() { this._focused++; },
      // Listeners are KEPT, not swallowed. compositionend cannot be wired from
      // the markup — composition events are not in GlobalEventHandlers, so
      // `oncompositionend="…"` is ignored in silence by a real browser — and a
      // stub that drops addEventListener would let that mistake pass. Section 4
      // dispatches through whatever is registered here, so "the commit is not
      // wired up" fails rather than looking like a passing guard.
      addEventListener(type, fn) { (this._on[type] || (this._on[type] = [])).push(fn); },
      dispatch(type, ev) { (this._on[type] || []).forEach(fn => fn(ev)); return (this._on[type] || []).length; },
      blur() {}, scrollIntoView() {}, setAttribute() {},
      setSelectionRange() { this._caretSet++; },
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
      appendChild(child) { if (child && child.id) nodes.set(child.id, child); this.children.push(child); return child; },
      closest: () => null,
      querySelectorAll: () => [],
      querySelector(sel) {
        const want = String(sel).replace(/^#/, '');
        return this._ids.has(want) ? (nodes.get(want) || null) : null;
      },
    };
    Object.defineProperty(n, 'innerHTML', {
      get() { return this._html; },
      set(v) {
        this._html = String(v);
        this._writes++;
        // Whatever was inside is gone. Mint a fresh node per id, the way the
        // parser does — this is what makes "the field was rebuilt" visible.
        this._ids = new Set();
        let m;
        ID.lastIndex = 0;
        while ((m = ID.exec(this._html)) !== null) {
          this._ids.add(m[1]);
          nodes.set(m[1], makeNode(m[1]));
        }
      },
    });
    return n;
  }

  const document = {
    // null for an id that has not been painted, unlike the older stubs here —
    // this suite needs "is #mat-list on screen?" to be a real question.
    getElementById: id => nodes.get(id) || null,
    createElement: () => makeNode(''),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: makeNode('body'),
  };
  return { nodes, document, mint: id => { const n = makeNode(id); nodes.set(id, n); return n; } };
}

// ── one screen, loaded and driven ─────────────────────────────────────────
// SCREENS below is the only place the two modules differ.
const SCREENS = [
  {
    label: 'Materials 物料',
    file: '18-materials.js',
    root: 'mat-root', box: 'mat-q', list: 'mat-list', cat: 'mat-cat',
    init: 'matInit', search: 'matSearch', setCat: 'matSetCat', clear: 'matClearFilters',
    list_api: '/api/retail-admin/materials',
    meta: {
      '/api/retail-admin/materials/meta/kinds': ['food'],
      '/api/retail-admin/materials/meta/categories': ['Salt 盐'],
      '/api/retail-admin/materials/meta/accounting-categories': ['Ingredients 原材料'],
      '/api/retail-admin/suppliers': [{ id: 1, name: 'Dry Fruit 果干', is_active: 1 }],
    },
    rows: [
      { id: 1, name_en: 'Kosher Flake Sea Salt', name_cn: '海盐', sku: 'E-55', category: 'Salt 盐', unit: 'g', item_kind: 'food', buy_price: 30, cost_per_unit: 0.066 },
      { id: 2, name_en: 'Salad Leaves', name_cn: '沙拉菜', sku: 'E-56', category: 'Salt 盐', unit: 'g', item_kind: 'food', buy_price: 12, cost_per_unit: 0.02 },
    ],
    extra: j => ({ counts: { food: 2 }, sourceCounts: { bought: 2, made: 0 }, ...j }),
  },
  {
    label: 'Recipes 食谱',
    file: '19-recipes.js',
    root: 'rcp-root', box: 'rcp-q', list: 'rcp-list', cat: 'rcp-cat',
    init: 'rcpInit', search: 'rcpSearch', setCat: 'rcpSetCat', clear: null,
    list_api: '/api/retail-admin/recipes',
    meta: { '/api/retail-admin/recipes/meta/categories': ['Bread 面包'] },
    rows: [
      { id: 1, name_en: 'Kosher Flake Sea Salt Cure', name_cn: '海盐腌料', category: 'Bread 面包', batch_size: 500, servings: 4, batchCost: 12, recipe_type: 'made' },
      { id: 2, name_en: 'Salad Base', name_cn: '沙拉底', category: 'Bread 面包', batch_size: 300, servings: 2, batchCost: 6, recipe_type: 'made' },
    ],
    extra: j => j,
  },
];

function boot(screen) {
  const dom = makeDom();
  const root = dom.mint(screen.root);

  const state = {
    searches: [],        // every `search` param that reached the server, in order
    hold: null,          // set to a function to defer the next list response
    failNext: false,
    rowsFor: q => (q ? screen.rows.filter(r =>
      (r.name_en + ' ' + (r.name_cn || '') + ' ' + (r.sku || '')).toLowerCase().includes(q.toLowerCase())) : screen.rows),
  };

  async function api(p) {
    const [q, query] = p.split('?');
    if (Object.prototype.hasOwnProperty.call(screen.meta, q)) return { success: true, data: screen.meta[q] };
    if (q !== screen.list_api) return { success: true, data: [] };
    const term = new URLSearchParams(query || '').get('search') || '';
    state.searches.push(term);
    if (state.failNext) { state.failNext = false; throw new Error('network is down'); }
    const body = screen.extra({ success: true, data: state.rowsFor(term) });
    if (state.hold) { const gate = state.hold; state.hold = null; await gate(); }
    return body;
  }

  let langCb = null;
  const sandbox = {
    document: dom.document, console, setTimeout, clearTimeout, Promise, Date, Math, JSON,
    Set, Map, Array, Object, isFinite, String, Number, URLSearchParams, RegExp,
    api, toast: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    history: { pushState() {}, back() {} },
    escapeHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    cuT: en => en,
    fmt: n => String(n),
    acMoney: n => '¥' + n,
    applyCapGates: () => {},
    onLangChange: cb => { langCb = cb; },
    goTab: () => {},
    askConfirm: async () => true,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'retail-admin', screen.file), 'utf8'),
                  sandbox, { filename: screen.file });

  return { dom, root, state, sandbox, lang: () => langCb };
}

// ── the battery ───────────────────────────────────────────────────────────
async function run(screen) {
  console.log(`\n══ ${screen.label} — ${screen.file}`);
  const { dom, root, state, sandbox, lang } = boot(screen);
  const box = () => dom.document.getElementById(screen.box);
  const listBody = () => dom.document.getElementById(screen.list);
  // Typing, the way the markup does it: the field holds the new text, then the
  // handler is called with the event the browser would pass.
  const type = (v, composing) => {
    const b = box(); if (b) b.value = v;
    sandbox[screen.search](v, { isComposing: !!composing, type: composing ? 'input' : 'input' });
  };
  // Committing a candidate, as Chromium actually delivers it — measured, not
  // assumed: `input` fires FIRST with isComposing still true and the finished
  // characters already in the field, and compositionend follows. So the guard
  // must skip that input event and the listener must pick the term up.
  const commit = (v) => {
    const b = box(); if (b) b.value = v;
    sandbox[screen.search](v, { isComposing: true, type: 'input' });
    return b.dispatch('compositionend', { type: 'compositionend', data: v });
  };

  await sandbox[screen.init]();
  await settle();

  console.log('\n1. the list paints, and the search box is part of it');
  ok(!!box(), 'the search box is on screen');
  ok(!!listBody(), 'the table sits in its own node, not loose in the root');
  // The first paint writes the shell and the table together, so the rows are in
  // the root's own markup; every paint after it writes the table node alone.
  ok(root.innerHTML.includes('Kosher Flake Sea Salt'), 'and the rows are in it');

  console.log('\n2. typing does not destroy the field being typed into');
  const held = box();
  const rootWrites = root._writes;
  type('salt');
  await afterDebounce();
  ok(box() === held, 'the same input element is still there after the search reloads');
  ok(root._writes === rootWrites, 'the list root was not repainted at all');
  ok(listBody().innerHTML.includes('Kosher Flake Sea Salt'), 'the table did update');
  ok(!listBody().innerHTML.includes('Salad'), 'to the matching rows only');
  ok(held._focused === 0 && held._caretSet === 0,
     'and focus and the caret were never touched — there is nothing to put back');

  console.log('\n3. a search that matches nothing does not eat the next keystroke');
  type('zzzz');
  await afterDebounce();
  ok(listBody().innerHTML.includes('Nothing matches'), 'the empty state is shown');
  ok(box() === held, 'the field survived the empty result');
  type('zzzza');
  ok(!root.innerHTML.includes('Loading…'), 'the next keystroke does not paint “Loading…” over the whole screen');
  ok(box() === held, 'so the field is still the one being typed into');
  await afterDebounce();
  ok(box() === held, 'and still is once the answer lands');

  console.log('\n4. half-typed pinyin is not a search term');
  state.searches.length = 0;
  type('s', true); type('sh', true); type('sha', true); type('shal', true);
  await afterDebounce();
  ok(state.searches.length === 0, 'nothing is sent while the IME is still composing');
  ok(box() === held, 'and the field is left alone to compose in');
  const listeners = commit('沙拉');
  ok(listeners === 1, 'compositionend is wired up in code — an HTML attribute would not be a handler');
  await afterDebounce();
  ok(state.searches.length === 1, 'the committed characters are searched, once');
  ok(state.searches[0] === '沙拉', 'and they are what goes on the wire, not the pinyin');
  ok(listBody().innerHTML.includes('沙拉'), 'the Chinese term finds its row');

  console.log('\n5. plain typing is unaffected — an event with no composition still searches');
  state.searches.length = 0;
  type('salad');
  await afterDebounce();
  ok(state.searches.length === 1 && state.searches[0] === 'salad', 'one request, for what was typed');

  console.log('\n6. a slow answer cannot repaint over a newer one');
  // "sa" is held open; "salt" goes out behind it and comes back first. The
  // stale answer must be dropped, or the table disagrees with the box.
  let release;
  state.hold = () => new Promise(r => { release = r; });
  type('sa');
  await afterDebounce();                  // "sa" is now in flight, gated
  type('salt');
  await afterDebounce();                  // "salt" has been and gone
  release();
  await settle();
  ok(listBody().innerHTML.includes('Kosher Flake Sea Salt'), 'the newer answer is what is on screen');
  ok(!listBody().innerHTML.includes('Salad'),
     'the older, slower answer for “sa” was dropped rather than painted over it');

  console.log('\n7. a load that fails keeps the box, and says so where the table was');
  const before = root._writes;
  state.failNext = true;
  type('salt');
  await afterDebounce();
  ok(box() === held, 'the field survives a failed load');
  ok(root._writes === before, 'the root was not repainted out from under it');
  ok(/network is down/.test(listBody().innerHTML), 'the failure is reported in the table area');

  console.log('\n8. a language change still rebuilds the whole shell');
  const cb = lang();
  ok(typeof cb === 'function', 'the module registered a language handler');
  const wasBox = box();
  cb();
  ok(root._writes > before, 'the root is repainted — every label in the shell is bilingual');
  ok(box() !== wasBox, 'including the search box, which is rebuilt in the new language');

  if (screen.clear) {
    console.log('\n9. clearing the filters still clears every control it owns');
    await settle();
    sandbox[screen.setCat]('Salt 盐');
    await afterDebounce();
    ok(dom.document.getElementById(screen.cat).value === 'Salt 盐', 'the category select holds the choice');
    sandbox[screen.clear]();
    await afterDebounce();
    ok(dom.document.getElementById(screen.cat).value === '', 'and is put back when the filters are cleared');
    ok(box().value === '', 'along with the search box');
  }
}

async function main() {
  for (const s of SCREENS) await run(s);
  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
