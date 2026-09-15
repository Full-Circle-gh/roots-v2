#!/usr/bin/env node
//
// test_shop_menu_filter.js — the SEARCH BAR OVER THE MENU ITSELF, on the shop
// menu (Sales → a location → Shop menu), public/retail-admin/28-shops.js.
//
// WHAT THIS IS, AND WHAT IT IS NOT. The screen has two search boxes and they
// are different things:
//
//   · "Search a product to add…" lives in the Add product picker, asks the
//     SERVER for candidates that are not on the menu yet, and is covered by
//     test_shop_menu_search_typing.js.
//   · "Search by name or SKU…" — this one — narrows the LISTINGS TABLE, the
//     products already on the menu. It fetches nothing: the whole menu is
//     loaded, so the filter is a local pass over _rows and the table redraws
//     on the keystroke.
//
// THE REGRESSION THIS EXISTS TO CATCH is the one the picker already paid for
// in full (read the header of test_shop_menu_search_typing.js): a search field
// painted INSIDE the thing its own keystrokes repaint is destroyed mid-word.
// The caret is then guessed at, a keystroke landing on the dying element never
// reaches the term, and an IME composition dies before a character is
// committed — the browser drops the candidate window with the element that
// owned it, and half this catalogue is named in Chinese.
//
// The filter bar is therefore painted OUTSIDE #shp-table-box, which is the
// only node a filter redraws. That is a structural property, not a visual one,
// so it is asserted structurally below — and by element IDENTITY across a
// filter, which is the one thing that tells "the box survived" apart from "the
// box was rebuilt with the same value in it".
//
// The stub is the sibling suite's, for the same reason: writing innerHTML here
// MINTS FRESH CHILD NODES exactly as a browser does, so identity means what it
// means in a browser.
//
// USAGE   node scripts/test_shop_menu_filter.js
// EXIT    0 every assertion held · 1 an assertion failed

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const settle = () => sleep(60);

// ── DOM stub — innerHTML destroys and re-mints, as a browser does ─────────
function makeDom() {
  const nodes = new Map();
  const ID = /\bid="([A-Za-z0-9_-]+)"/g;

  function makeNode(id) {
    const n = {
      id, _html: '', _ids: new Set(), _writes: 0, _on: {},
      value: '', checked: false, hidden: false, style: {}, children: [],
      _focused: 0, _caretSet: 0, textContent: '',
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      focus() { this._focused++; },
      addEventListener(type, fn) { (this._on[type] || (this._on[type] = [])).push(fn); },
      dispatch(type, ev) { (this._on[type] || []).forEach(fn => fn(ev)); return (this._on[type] || []).length; },
      blur() {}, scrollIntoView() {}, setAttribute() {}, removeAttribute() {},
      getAttribute: () => null,
      setSelectionRange() { this._caretSet++; },
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
    getElementById: id => nodes.get(id) || null,
    createElement: () => makeNode(''),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: makeNode('body'),
  };
  return { nodes, document, mint: id => { const n = makeNode(id); nodes.set(id, n); return n; } };
}

// ── fixtures ──────────────────────────────────────────────────────────────
const SHOP = { id: 7, location_id: 42, public_code: 'VFVLPLYY', display_name_en: 'Main Menu Ramada Hotel',
               display_name_cn: '华美达酒店', is_active: 1 };
const LOC  = { id: 42, code: 'ramada', name_en: 'Ramada', name_cn: '华美达', is_active: 1 };
// Named the way the real menu is: English and Chinese on every row, a SKU that
// is NOT a substring of either name, and one product whose English name shares
// a word with another so a term can legitimately match two rows.
const LISTINGS = () => ([
  { id: 901, name_en: 'Garlic Dill Sour Cream', name_cn: '蒜香莳萝酸奶油', sku: 'TS-10',
    price: 26, fulfilment_mode: 'made_here', is_available: 1, sort_position: 6 },
  { id: 902, name_en: 'Almond Butter', name_cn: '杏仁酱', sku: '2-400',
    price: 50, fulfilment_mode: 'stocked', is_available: 1, sort_position: 7 },
  { id: 903, name_en: 'Apple Pie Overnight Oats', name_cn: '苹果派隔夜燕麦', sku: '1-120',
    price: 27, fulfilment_mode: 'stocked', is_available: 1, sort_position: 9 },
]);

function boot() {
  const dom = makeDom();
  const root = dom.mint('shp-root');
  let rows = LISTINGS();

  async function api(p, opts) {
    const [route] = p.split('?');
    const method = (opts && opts.method) || 'GET';
    if (route === '/api/retail-admin/shops') return { success: true, data: [{ location: LOC, shop: SHOP }] };
    if (route === `/api/retail-admin/shops/${SHOP.id}` && method === 'GET') {
      return { success: true, data: { shop: SHOP, listings: rows } };
    }
    if (route.startsWith(`/api/retail-admin/shops/${SHOP.id}/listings/`)) {
      const id = Number(route.split('/').pop());
      if (method === 'DELETE') { rows = rows.filter(r => r.id !== id); return { success: true, data: {} }; }
      if (method === 'PATCH') {
        const r = rows.find(x => x.id === id);
        return { success: true, data: Object.assign({}, r, opts.body) };
      }
    }
    if (route === `/api/retail-admin/shops/${SHOP.id}/candidates`) return { success: true, data: [] };
    return { success: true, data: [] };
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
    cuT: (en, cn) => en,
    cuLang: () => 'en',
    acMoney: n => '¥' + n,
    acCurrencySymbol: () => '¥',
    tdErrorText: (code, msg) => msg || code,
    can: () => true,
    applyCapGates: () => {},
    onLangChange: cb => { langCb = cb; },
    goTab: () => {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'retail-admin', '28-shops.js'), 'utf8'),
                  sandbox, { filename: '28-shops.js' });

  return { dom, root, sandbox, lang: () => langCb };
}

(async () => {
  console.log('\n══ Shop menu — the search bar over the menu (28-shops.js)');
  const { dom, root, sandbox, lang } = boot();
  const field    = () => dom.document.getElementById('shp-menu-q');
  const bar      = () => dom.document.getElementById('shp-filter');
  const count    = () => dom.document.getElementById('shp-filter-n');
  const tableBox = () => dom.document.getElementById('shp-table-box');

  // Typing, the way the markup does it.
  const type = (v, composing) => {
    const f = field(); if (f) f.value = v;
    sandbox.shpMenuFilter(v, { isComposing: !!composing, type: 'input' });
  };
  // Committing a pinyin candidate as Chromium actually delivers it: `input`
  // fires FIRST with isComposing still true and the finished characters
  // already in the field, and compositionend follows.
  const commit = (v) => {
    const f = field(); if (f) f.value = v;
    sandbox.shpMenuFilter(v, { isComposing: true, type: 'input' });
    return f.dispatch('compositionend', { type: 'compositionend', data: v });
  };

  sandbox.shopMenuOpen('ramada');
  await settle();

  console.log('\n1. the bar is on the page, above the table and outside it');
  ok(!!field(), 'the search field is on screen');
  ok(!!bar(), 'it sits in its own row');
  ok(!!tableBox(), 'the table has its own node');
  ok(!tableBox().innerHTML.includes('shp-menu-q'),
     'THE FIELD IS NOT INSIDE #shp-table-box — the node a filter repaints');
  ok(root.innerHTML.indexOf('shp-filter') < root.innerHTML.indexOf('shp-table-box'),
     'and it is painted above the table, where the operator looks for it');
  // Read from the ROOT here, not from #shp-table-box: the first paint writes
  // the whole page in one string, and only renderTable() ever writes the table
  // node on its own. The stub mints a node per id without parsing what is
  // inside it, so the child is empty until something addresses it directly —
  // which is exactly the split this screen is built on.
  ok(root.innerHTML.includes('Garlic Dill Sour Cream')
     && root.innerHTML.includes('Almond Butter')
     && root.innerHTML.includes('Apple Pie Overnight Oats'),
     'with nothing typed, the whole menu is drawn');
  ok(count().textContent === '' && !/>\s*\d+\s*\/\s*\d+\s*</.test(root.innerHTML),
     'and no count is shown, because nothing is filtered');

  console.log('\n2. typing narrows the table and does NOT destroy the field');
  const held = field();
  const rootWrites = root._writes;
  const focusedAtStart = held._focused, caretAtStart = held._caretSet;
  type('almond');
  ok(field() === held, 'the same input element is still there after the filter ran');
  ok(root._writes === rootWrites, 'the page root was not repainted at all');
  ok(held._focused === focusedAtStart && held._caretSet === caretAtStart,
     'focus and the caret were never touched — there is nothing to put back');
  ok(tableBox().innerHTML.includes('Almond Butter'), 'the matching row is drawn');
  ok(!tableBox().innerHTML.includes('Garlic Dill Sour Cream')
     && !tableBox().innerHTML.includes('Apple Pie Overnight Oats'),
     'and the rows that do not match are gone');
  ok(count().textContent === '1 / 3', 'the count reads what is shown out of what there is');

  console.log('\n3. the term is case-folded, and the SKU is searchable too');
  type('ALMOND');
  ok(tableBox().innerHTML.includes('Almond Butter'), 'an upper-case term finds a lower-case name');
  type('ts-10');
  ok(tableBox().innerHTML.includes('Garlic Dill Sour Cream'),
     'a SKU finds its row even though it appears in neither name');
  ok(!tableBox().innerHTML.includes('Almond Butter'), 'and only its row');

  console.log('\n4. a Chinese name is reachable, through an IME');
  type('杏', true);
  ok(tableBox().innerHTML.includes('Garlic Dill Sour Cream'),
     'nothing narrowed while the candidate window was open — that is not a term yet');
  const fired = commit('杏仁');
  ok(fired === 1, 'compositionend is wired to a real listener, not an ignored attribute');
  ok(tableBox().innerHTML.includes('Almond Butter'), 'the committed characters are what gets filtered');
  ok(!tableBox().innerHTML.includes('Apple Pie Overnight Oats'), 'and they narrow the table');
  ok(field() === held, 'through all of which the field was never rebuilt');

  console.log('\n5. a term that matches nothing says so — and does not claim the menu is empty');
  type('zzzz');
  ok(tableBox().innerHTML.includes('No products match this filter'),
     'the no-match line is the catalogue\'s own, already live on this screen');
  ok(!tableBox().innerHTML.includes('No products yet'),
     'NOT the empty-menu line: the menu has products, this term found none of them');
  ok(count().textContent === '0 / 3', 'and the count says so too');

  console.log('\n6. clearing the box puts the whole menu back');
  type('');
  ok(tableBox().innerHTML.includes('Garlic Dill Sour Cream')
     && tableBox().innerHTML.includes('Almond Butter')
     && tableBox().innerHTML.includes('Apple Pie Overnight Oats'),
     'every row is drawn again');
  ok(count().textContent === '', 'and the count empties');
  ok(field() === held, 'still the same element, after everything above');

  console.log('\n7. a write with a filter up still finds its row, and leaves the box alone');
  type('almond');
  const beforeWrite = field();
  await sandbox.shpToggleAvail(902, false);
  await settle();
  ok(field() === beforeWrite, 'toggling a row did not rebuild the search field');
  ok(tableBox().innerHTML.includes('Almond Butter'), 'the filtered row is still the one drawn');
  ok(count().textContent === '1 / 3', 'and the count is unchanged — a write is not a filter');
  await sandbox.shpSaveField(902, 'price', { value: '55' });
  await settle();
  ok(field() === beforeWrite, 'editing a price did not rebuild it either');
  ok(tableBox().innerHTML.includes('55.00'), 'and the row shows what was saved');

  console.log('\n8. removing rows keeps the count honest, and the bar goes with the last one');
  type('');
  await sandbox.shpRemove(903, { disabled: false });
  await settle();
  type('a');
  ok(count().textContent === '2 / 2', 'the count counts what is left, not what was loaded');
  await sandbox.shpRemove(901, { disabled: false });
  await sandbox.shpRemove(902, { disabled: false });
  await settle();
  ok(bar().hidden === true, 'with no listings left there is nothing to search, so the bar is hidden');
  ok(tableBox().innerHTML.includes('No products yet'),
     'and NOW the empty-menu line is the right one');

  console.log('\n9. a language change repaints the field, which is correct');
  const cb = lang();
  ok(typeof cb === 'function', 'the screen registered a language-change handler');
  const wasField = field();
  cb();
  await settle();
  ok(field() !== wasField, 'the field is rebuilt by it — its placeholder changed language');

  console.log('\n' + (fail === 0 ? `All checks passed — ${pass} passed, 0 failed`
                                 : `${pass} passed, ${fail} FAILED`));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
