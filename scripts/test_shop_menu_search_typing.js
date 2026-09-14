#!/usr/bin/env node
//
// test_shop_menu_search_typing.js — the "Add product" search box on the shop
// menu (Sales → a location → Shop menu), public/retail-admin/28-shops.js.
//
// THE DEFECT THIS COVERS, reported against the Tianhe shop as "the search bar
// flicking and doesn't bring up the product once searching for one".
//
// It is the same fault the Materials list had (test_material_search_typing.js),
// in a screen that was written before that one was fixed, and it had four
// parts:
//
//   1. A SEARCH REPAINTED THE WHOLE PAGE, TWICE. fetchPick() called paint()
//      once to put "Loading…" up and once to show the answer, and paint()
//      writes the entire root in one innerHTML — the <input> being typed into
//      with it. So the field was destroyed and rebuilt twice per settled
//      keystroke. That is the flicker, and it is literally the box blinking
//      out of existence and back.
//
//   2. FOCUS AND THE CARET WERE HANDED BACK BY HAND, always to the END of the
//      value. Correcting a term in the middle threw you to the end of it a
//      fifth of a second later.
//
//   3. A KEYSTROKE THAT LANDED ON THE DYING ELEMENT NEVER REACHED _pickQ, so
//      the term the server was asked for was not the term on the screen — the
//      product legitimately did not come up, for a search nobody typed.
//
//   4. AN IME COMPOSITION CANNOT BE HANDED BACK AT ALL: the browser drops the
//      candidate window with the element that owned it. Half this catalogue is
//      named in Chinese, and for those names the box died before a single
//      character was committed. Half-typed pinyin was also searched for — "h",
//      "hu", "hua" — four requests and four repaints for one character.
//
// And one fault that showed as wrong rows rather than as flicker: the answers
// were sequenced by comparing the term against the box, so nothing ordered the
// responses themselves.
//
// WHAT THE STUB HAS TO BE HONEST ABOUT — the same thing the Materials suite
// needed: element IDENTITY. A test that only reads HTML back cannot tell "the
// box survived" from "the box was rebuilt with the same value in it", and that
// difference is the entire bug. So setting innerHTML here mints fresh child
// nodes, exactly as a browser does, and the assertions compare object identity
// across a search.
//
// USAGE   node scripts/test_shop_menu_search_typing.js
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
const settle = () => sleep(60);
// The picker debounces on 220ms and does not await the fetch.
const afterDebounce = () => sleep(320);

// ── DOM stub ──────────────────────────────────────────────────────────────
// Only as much document as this screen touches, with one thing modelled
// properly: writing innerHTML DESTROYS what was inside and mints new elements.
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
      // Listeners are KEPT, not swallowed: compositionend cannot be wired from
      // the markup (composition events are not in GlobalEventHandlers, so
      // `oncompositionend="…"` is ignored in silence by a real browser), and a
      // stub that dropped addEventListener would let that mistake pass.
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

// ── the screen, loaded and driven ─────────────────────────────────────────
const SHOP = { id: 7, location_id: 42, public_code: 'KMTPXRDF', display_name_en: '', display_name_cn: '', is_active: 1 };
const LOC  = { id: 42, code: 'tianhe', name_en: 'Tianhe', name_cn: '天河', is_active: 1 };
// Two words in the name on purpose: the term typed at the box is two words too.
const CATALOGUE = [
  { id: 101, name_en: 'Peanut Butter Duo', name_cn: '花生酱双拼', sku: 'A-1', sell_price: 68 },
  { id: 102, name_en: 'Oat Latte',         name_cn: '燕麦拿铁',   sku: 'A-2', sell_price: 32 },
];

function boot() {
  const dom = makeDom();
  const root = dom.mint('shp-root');

  const state = {
    searches: [],     // every q that reached the server, in order
    hold: null,       // set to a promise-returning gate to defer the next answer
    rowsFor: q => {
      const terms = String(q || '').trim().split(/\s+/).filter(Boolean);
      return CATALOGUE.filter(p => terms.every(t =>
        (p.name_en + ' ' + p.name_cn + ' ' + p.sku).toLowerCase().includes(t.toLowerCase())));
    },
  };

  async function api(p, opts) {
    const [route, query] = p.split('?');
    if (route === '/api/retail-admin/shops') {
      return { success: true, data: [{ location: LOC, shop: SHOP }] };
    }
    if (route === `/api/retail-admin/shops/${SHOP.id}/candidates`) {
      const q = new URLSearchParams(query || '').get('q') || '';
      state.searches.push(q);
      const body = { success: true, data: state.rowsFor(q) };
      if (state.hold) { const gate = state.hold; state.hold = null; await gate(); }
      return body;
    }
    if (route === `/api/retail-admin/shops/${SHOP.id}/listings` && opts && opts.method === 'POST') {
      const p2 = CATALOGUE.find(x => x.id === opts.body.store_product_id);
      return { success: true, data: { id: 900 + p2.id, name_en: p2.name_en, name_cn: p2.name_cn,
                                      sku: p2.sku, price: p2.sell_price, fulfilment_mode: 'stocked',
                                      is_available: 1, sort_position: 0 } };
    }
    if (route === `/api/retail-admin/shops/${SHOP.id}`) return { success: true, data: { shop: SHOP, listings: [] } };
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
    cuT: en => en,
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

  return { dom, root, state, sandbox, lang: () => langCb };
}

// ── the battery ───────────────────────────────────────────────────────────
(async () => {
  console.log('\n══ Shop menu — Add product search (28-shops.js)');
  const { dom, root, state, sandbox, lang } = boot();
  const box  = () => dom.document.getElementById('shp-pick-q');
  const list = () => dom.document.getElementById('shp-pick-list');
  const tableBox = () => dom.document.getElementById('shp-table-box');

  // Typing, the way the markup does it: the field holds the new text, then the
  // handler is called with the event the browser would pass.
  const type = (v, composing) => {
    const b = box(); if (b) b.value = v;
    sandbox.shpPickSearch(v, { isComposing: !!composing, type: 'input' });
  };
  // Committing a pinyin candidate, as Chromium actually delivers it: `input`
  // fires FIRST with isComposing still true and the finished characters
  // already in the field, and compositionend follows.
  const commit = (v) => {
    const b = box(); if (b) b.value = v;
    sandbox.shpPickSearch(v, { isComposing: true, type: 'input' });
    return b.dispatch('compositionend', { type: 'compositionend', data: v });
  };

  sandbox.shopMenuOpen('tianhe');
  await settle();

  console.log('\n1. the picker opens with the field focused once');
  sandbox.shpPickerToggle();
  await afterDebounce();
  ok(!!box(), 'the search box is on screen');
  ok(!!list(), 'the results sit in their own node, not loose in the panel');
  ok(!!tableBox(), 'the listings table sits in its own node too');
  ok(box()._focused === 1, 'opening the picker focuses the field — once');

  console.log('\n2. typing does not destroy the field being typed into');
  const held = box();
  const rootWrites = root._writes;
  const focusedAtStart = held._focused, caretAtStart = held._caretSet;
  type('peanut');
  await afterDebounce();
  ok(box() === held, 'the same input element is still there after the search answers');
  ok(root._writes === rootWrites, 'the page root was not repainted at all');
  ok(list().innerHTML.includes('Peanut Butter Duo'), 'the results did update');
  ok(!list().innerHTML.includes('Oat Latte'), 'to the matching rows only');
  ok(held._focused === focusedAtStart && held._caretSet === caretAtStart,
     'and focus and the caret were never touched — there is nothing to put back');

  console.log('\n3. "Loading…" goes in the results box, never over the field');
  let release;
  state.hold = () => new Promise(r => { release = r; });
  type('oat');
  await sleep(260);                      // debounce fired; the answer is held
  ok(box() === held, 'the field survives the loading state');
  ok(list().innerHTML.includes('Loading…'), 'the loading line is in the results box');
  release();
  await settle();
  ok(list().innerHTML.includes('Oat Latte'), 'and the answer replaces it there');

  console.log('\n4. a slow answer cannot overwrite a newer one');
  state.hold = () => new Promise(r => { release = r; });
  type('peanut');                        // this one will be held back
  await sleep(260);
  type('oat');                           // and this one asked for next
  await afterDebounce();
  release();                             // the stale "peanut" answer lands last
  await settle();
  ok(box().value === 'oat', 'the box still says what was typed last');
  ok(list().innerHTML.includes('Oat Latte') && !list().innerHTML.includes('Peanut Butter Duo'),
     'and the rows are the ones it asked for, not the stale answer that landed after');

  console.log('\n5. half-typed pinyin is not a search term');
  const before = state.searches.length;
  type('h', true); type('hu', true); type('hua', true);
  await afterDebounce();
  ok(state.searches.length === before, 'nothing was sent while the candidate window was open');
  const wired = commit('花生');
  ok(wired === 1, 'compositionend is wired to a real listener, not an ignored attribute');
  await afterDebounce();
  ok(state.searches[state.searches.length - 1] === '花生', 'the committed characters are what gets searched');
  // Rendered under the English label, because the admin is in English — the
  // point is that the CHINESE term found it at all.
  ok(list().innerHTML.includes('Peanut Butter Duo'), 'and the product named in Chinese comes up');
  ok(box() === held, 'through all of which the field was never rebuilt');

  console.log('\n6. adding a product leaves the search box alone');
  type('peanut');
  await afterDebounce();
  const listWrites = list()._writes, tableWrites = tableBox()._writes;
  await sandbox.shpAdd(101, { disabled: false, textContent: '' });
  await settle();
  ok(box() === held, 'the field is the same element after an add — the next search can be typed straight in');
  ok(root._writes === rootWrites, 'the page root was still never repainted');
  ok(list()._writes > listWrites, 'the candidate list redrew (the added product drops out of it)');
  ok(tableBox()._writes > tableWrites, 'and so did the listings table');
  ok(tableBox().innerHTML.includes('Peanut Butter Duo'), 'which now carries the product just added');
  ok(!list().innerHTML.includes('Peanut Butter Duo'), 'and the picker no longer offers it');

  console.log('\n7. a language change still repaints everything');
  // The guard is "typing repaints the list and nothing else", not "nothing
  // ever repaints" — every string on this screen is baked at paint time, so a
  // language change has to rebuild the field with it. Nobody is mid-word in a
  // search box at the moment they click 中文.
  const cb = lang();
  ok(typeof cb === 'function', 'the screen registered a language-change handler');
  cb();
  ok(root._writes > rootWrites, 'and it repaints the page');
  ok(box() !== held, 'the field is rebuilt by it, which is correct — its placeholder changed language');

  console.log(`\n${fail === 0 ? 'All checks passed' : fail + ' check(s) failed'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
