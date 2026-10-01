#!/usr/bin/env node
/**
 * §325 step PD1 — THE PRODUCTS, STOCK ACTIVITY AND WASTE LISTS READ LIKE THE
 * DESKTOP'S.
 *
 *   node scripts/test_mobile_products_lists.js
 *
 * The desktop modules are the spec: public/retail-admin/09-products.js (the
 * subcategory picker paFillSubFilter, the store switch paRenderStoreSeg /
 * _paStockOf, the Going nowhere / On promotion tiles paLoadHighlights, and
 * paExportCsv), 13-activity.js (the date boxes, the search, actExportCsv) and
 * 20-waste.js (the free date range). The phone code is RUN, lifted out of
 * public/m.html by name into a sandbox with a fake server, so every read is
 * asserted on the request it sends and every download on the URL it opens.
 * No browser — fast shard.
 *
 * What it pins:
 *   1. the catalogue — subcategory chips (tree order and names, a rename's
 *      leftovers, reset on a new category); the store switch (offered only
 *      where it can answer; Low / Out, the stock line and an assembled
 *      bundle answer for the picked store); the two highlight chips (the
 *      server's count and id set, hidden at zero and on a failed read);
 *      Export CSV (the whole file, on products:export);
 *   2. stock activity — a Custom window asked for in the ask-sheet, the
 *      search on Enter, Export CSV of exactly the view, on activity:export;
 *      empty and failed states keep the search on screen;
 *   3. waste — a Custom window, and Clear puts the week back;
 *   4. every string is a live pair (the desktop's or the phone's own).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const PRODUCTS_JS = fs.readFileSync(path.join(ROOT, 'public/retail-admin/09-products.js'), 'utf8');
const DESK = fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8');

// Values out of the sandbox are another realm's arrays; compare them as data.
const same = (a, b, m) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), b, m);

let passed = 0, failed = 0;
const pending = [];
function section(t) { pending.push(() => console.log('\n' + t)); }
function it(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
  });
}

/* ── Lifting by name ─────────────────────────────────────────────────────────
   A small scanner that knows strings, comments, regex literals and NESTED
   template literals (this file's markup is templates inside templates), so a
   function is cut at its own closing brace and nowhere else. */
function skipBalanced(src, i) {
  const open = src[i];
  const close = { '{': '}', '(': ')', '[': ']' }[open];
  const stack = [{ t: 'code', depth: 0 }];
  let prev = '';
  for (; i < src.length; i++) {
    const c = src[i], top = stack[stack.length - 1];
    if (top.t === 'tmpl') {
      if (c === '\\') { i++; continue; }
      if (c === '`') { stack.pop(); prev = '`'; continue; }
      if (c === '$' && src[i + 1] === '{') { stack.push({ t: 'code', depth: 0, inTmpl: true }); i++; continue; }
      continue;
    }
    if (c === '"' || c === "'") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      prev = c; continue;
    }
    if (c === '`') { stack.push({ t: 'tmpl' }); continue; }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); prev = ''; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === '/' && /[(,=:[!&|?{};]|^$/.test(prev)) {
      let inClass = false;
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
      }
      prev = 'x'; continue;
    }
    if (c === '{' || c === '(' || c === '[') top.depth++;
    else if (c === '}' || c === ')' || c === ']') {
      if (top.inTmpl && top.depth === 0 && c === '}') { stack.pop(); prev = '}'; continue; }
      top.depth--;
      if (stack.length === 1 && top.depth === 0 && c === close) return i + 1;
    }
    if (!/\s/.test(c)) prev = c;
  }
  throw new Error('unbalanced from ' + src.slice(i, i + 40));
}
function liftFn(name) {
  const at = M.indexOf('\nfunction ' + name + '(');
  assert.ok(at >= 0, 'cannot find function ' + name);
  const body = M.indexOf('{', M.indexOf(')', at));
  return M.slice(at + 1, skipBalanced(M, body));
}
function liftConst(name) {
  const m = new RegExp('\\nconst ' + name + '\\s*=').exec(M);
  const at = m ? m.index : -1;
  assert.ok(at >= 0, 'cannot find const ' + name);
  // To the first `;` outside any bracket, string or template.
  let i = at + 1;
  while (i < M.length) {
    const c = M[i];
    if (c === '{' || c === '(' || c === '[') { i = skipBalanced(M, i); continue; }
    if (c === '"' || c === "'") { for (i++; M[i] !== c; i++) if (M[i] === '\\') i++; i++; continue; }
    if (c === ';') return M.slice(at + 1, i + 1);
    i++;
  }
  throw new Error('cannot end const ' + name);
}
function liftReg(name) {
  const at = M.indexOf("\nreg('" + name + "',");
  assert.ok(at >= 0, 'cannot find reg ' + name);
  const open = M.indexOf('(', at + 1);
  return M.slice(at + 1, skipBalanced(M, open)) + ';';
}

const FNS = ['chipRow', 'searchBox', 'searchClearShow', 'searchClearRun', 'noteBar', 'nothingYet', 'E',
  'pill', 'toggle', 'prodLowThreshold', 'mapProduct', 'prodCategories', 'prodCatName', 'prodSubcats', 'prodSubName',
  'prodStoreOn', 'prodStoreQty', 'prodAtStore', 'prodRows', 'loadProdGrid', 'loadProdHi', 'productCard',
  'prodUnits', 'prodFiltered', 'prodBodyHtml', 'screenProductCatalogue', 'mCan',
  // §325 X3 — the Count sheet button rides the catalogue's top row beside Export.
  'countOffered', 'countButton',
  'actPreset', 'actWindow', 'loadActivity', 'actClock', 'actRangeLine', 'actDelta', 'actRow', 'actDigestCard',
  'screenActivity', 'actReload',
  'wstPreset', 'wstWindow', 'loadWasteReasons', 'wstReasonName', 'loadWaste', 'wstStoreName', 'wstProductName',
  'wstPulse', 'wstRow', 'screenWaste', 'wstRefilter'];
const CONSTS = ['cfgGet', 'PILL', 'KIND2PILL', 'prodBySize', 'PROD_STATUS_KIND', 'MCAN_MONEY_ONLY', 'ACT_SRC', 'actSrcName',
  'wstMoney', 'wstShowMoney', 'money'];
const REGS = ['askRun', 'prodStatus', 'prodCat', 'prodSub', 'prodStore', 'prodExport', 'prodClearQ',
  'actRange', 'actQ', 'actSearchGo', 'mActClr', 'actExport', 'actSource',
  'wstRange', 'wstReason', 'wstStore', 'wstClear', 'wstRetry'];
const SRC = [...CONSTS.map(liftConst), ...FNS.map(liftFn), ...REGS.map(liftReg)].join('\n');

const TODAY = '2026-09-30';
const ALL = ['products:view', 'products:export', 'activity:view', 'activity:export', 'waste:view', 'waste:record'];

/* The server. `serve(path)` answers each read; an Error is a failed read. */
function mk(opts = {}) {
  const calls = { reads: [], href: null, renders: 0, cats: 0 };
  const CMD = {};
  const els = {};
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥', API: '/api/retail-admin',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    DB: { products: [] },
    state: Object.assign({
      caps: opts.caps === undefined ? ALL : opts.caps, catalogMode: opts.catalogMode || 'self',
      cfg: {}, ask: null, askErr: null,
      prodQ: '', prodStatus: 'all', prodCat: 'all', prodSub: 'all', prodStore: '', prodErr: null, prodBusy: false,
      liveProductsLoaded: true, catalogueComplete: true, catalogueLoading: false, prodTotal: 0,
      prodGrid: { tried: false, seq: 0, ready: false, stores: [], qty: {} },
      prodHi: { tried: false, seq: 0, data: null },
      cats: opts.cats || null,
      act: null, actErr: null, actTried: false, actRange: 'today', actSource: '', actMore: false,
      actFrom: null, actTo: null, actQ: '',
      stores: opts.stores || [],
      wst: { rows: null, totals: null, tried: false, loading: false, err: null, listSeq: 0,
             range: 'week', reason: '', store: '', reasons: null, from: null, to: null },
    }, opts.state || {}),
    render: () => { calls.renders++; },
    reg: (n, f) => { CMD[n] = f; },
    CMD,
    shopToday: () => TODAY,
    fmtDateOnly: (v) => 'D' + String(v || '').slice(5),
    loadCatalogue: () => {},
    loadCategories: () => { calls.cats++; },
    showToast: () => {},
    apiRaw: (p) => { calls.reads.push(p); return answer(p); },
    api: (p) => { calls.reads.push(p); return answer(p).then((j) => (j && j.data !== undefined ? j.data : j)); },
    document: { getElementById: (id) => els[id] || null },
    location: { set href(v) { calls.href = v; }, get href() { return calls.href; } },
    APP: { cmd: (n, ...a) => CMD[n] && CMD[n](...a) },
    URLSearchParams, Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date,
    encodeURIComponent, isNaN,
  };
  function answer(p) {
    return new Promise((res, rej) => setImmediate(() => {
      let v;
      try { v = (opts.serve || (() => ({})))(p); } catch (e) { return rej(e); }
      if (v instanceof Error) rej(v); else res(v);
    }));
  }
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return { ctx, CMD, calls, els, text, s: ctx.state };
}
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

/* ── A catalogue ────────────────────────────────────────────────────────────
   Three categories' worth: Bakery carries two subcategories the tree names
   (in the tree's order, NOT A–Z) and one a rename left behind; a bundle made
   of two parts; a supplier item; a draft. */
const ROW = (o) => Object.assign({ is_published: 1, effective_stock: 20, sell_price: 10 }, o);
const RAW = [
  ROW({ id: 1, sku: 'B1', name_en: 'Rye loaf', name_cn: '黑麦面包', top_category: 'Bakery', subcategory: 'Sourdough', effective_stock: 12 }),
  ROW({ id: 2, sku: 'B2', name_en: 'Croissant', name_cn: '可颂', top_category: 'Bakery', subcategory: 'Pastry', effective_stock: 30 }),
  ROW({ id: 3, sku: 'B3', name_en: 'Old bun', name_cn: '旧面包', top_category: 'Bakery', subcategory: 'Buns (old)', effective_stock: 4 }),
  ROW({ id: 4, sku: 'D1', name_en: 'Oat milk', name_cn: '燕麦奶', top_category: 'Drinks', effective_stock: 9 }),
  ROW({ id: 5, sku: 'K1', name_en: 'Breakfast box', name_cn: '早餐盒', top_category: 'Drinks', is_bundle: true,
        bundle_items: [{ id: 1, qty: 2 }, { id: 4, qty: 1 }], effective_stock: 0 }),
  ROW({ id: 6, sku: 'S1', name_en: 'Supplier jam', name_cn: '果酱', top_category: 'Drinks', ship_from_supplier: 1, effective_stock: 0 }),
  ROW({ id: 7, sku: 'X1', name_en: 'Draft thing', name_cn: '草稿', top_category: 'Drinks', is_published: 0 }),
];
const TREE = [{ id: 'bakery', name: 'Bakery', name_cn: '烘焙', subs: [
  { id: 'pastry', name: 'Pastry', name_cn: '酥皮' }, { id: 'sour', name: 'Sourdough', name_cn: '酸面包' }] }];
const STORES = [{ id: 1, code: 'TH', name_en: 'Tianhe', name_cn: '天河', low_stock_threshold: null },
                { id: 2, code: 'YX', name_en: 'Yuexiu', name_cn: '越秀', low_stock_threshold: 8 }];
/* Tianhe holds most of it; Yuexiu is nearly bare. Oat milk at Yuexiu is 6,
   which is under Yuexiu's own line of 8 — Low there, and not at Tianhe. */
const GRID = (over) => Object.assign({ success: true, total: 7, limit: 5000, truncated: false, data: {
  stores: STORES,
  products: [
    { product_id: 1, stocks: [{ store_id: 1, physical_qty: 12 }, { store_id: 2, physical_qty: 0 }] },
    { product_id: 2, stocks: [{ store_id: 1, physical_qty: 20 }, { store_id: 2, physical_qty: 10 }] },
    { product_id: 3, stocks: [{ store_id: 1, physical_qty: 4 }, { store_id: 2, physical_qty: 0 }] },
    { product_id: 4, stocks: [{ store_id: 1, physical_qty: 3 }, { store_id: 2, physical_qty: 6 }] },
  ] } }, over || {});
const HI = { success: true, goingNowhere: { count: 2, ids: [3, 7] }, onPromotion: { count: 1, ids: [2] } };

function catalogue(opts = {}) {
  const h = mk(Object.assign({
    serve: (p) => (p.startsWith('/inventory/grid') ? (opts.grid || GRID())
      : p === '/products/highlights' ? (opts.hi || HI) : {}),
  }, opts));
  h.ctx.DB.products = RAW.map(h.ctx.mapProduct);
  h.s.prodTotal = RAW.length;
  return h;
}
async function opened(opts) { const h = catalogue(opts); h.ctx.screenProductCatalogue(); await settle(); return h; }
const cardNames = (h) => h.text(h.ctx.prodBodyHtml()).match(/Rye loaf|Croissant|Old bun|Oat milk|Breakfast box|Supplier jam|Draft thing/g) || [];
const chipCount = (h, label) => {
  const m = h.ctx.prodBodyHtml().match(new RegExp('<span>' + label.replace(/[()]/g, '\\$&') + '</span><span class="c">(\\d+)</span>'));
  return m ? Number(m[1]) : null;
};

section('1 · the catalogue: subcategories');
it('no subcategory row until a category is picked', async () => {
  const h = await opened();
  assert.ok(!h.text(h.ctx.prodBodyHtml()).includes('All subcategories'));
});
it('picking a category reads the tree and offers its subcategories, in the tree order, then leftovers A–Z', async () => {
  const h = await opened({ cats: TREE });
  const bakery = h.ctx.prodCategories().find((c) => c.en === 'Bakery');
  h.CMD.prodCat(bakery.key);
  assert.strictEqual(h.calls.cats, 1, 'the tree is asked for');
  const subs = h.ctx.prodSubcats().map((c) => c.en);
  same(subs, ['All subcategories', 'Pastry', 'Sourdough', 'Buns (old)']);
  assert.ok(h.text(h.ctx.prodBodyHtml()).includes('All subcategories'));
});
it('in Chinese the tree names them, and a leftover keeps its own name', async () => {
  const h = await opened({ cats: TREE, lang: 'zh' });
  h.CMD.prodCat(h.ctx.prodCategories().find((c) => c.en === 'Bakery').key);
  const t = h.text(h.ctx.prodBodyHtml());
  assert.ok(t.includes('全部子分类') && t.includes('酥皮') && t.includes('酸面包') && t.includes('Buns (old)'));
});
it('without the tree, the products’ own subcategories, A–Z', async () => {
  const h = await opened();
  h.CMD.prodCat(h.ctx.prodCategories().find((c) => c.en === 'Bakery').key);
  same(h.ctx.prodSubcats().map((c) => c.en), ['All subcategories', 'Buns (old)', 'Pastry', 'Sourdough']);
});
it('a subcategory narrows the list to itself', async () => {
  const h = await opened({ cats: TREE });
  h.CMD.prodCat(h.ctx.prodCategories().find((c) => c.en === 'Bakery').key);
  h.CMD.prodSub(h.ctx.prodSubcats().find((c) => c.en === 'Pastry').key);
  same(cardNames(h), ['Croissant']);
});
it('a category with no subcategories draws no row', async () => {
  const h = await opened({ cats: TREE });
  h.CMD.prodCat(h.ctx.prodCategories().find((c) => c.en === 'Drinks').key);
  assert.ok(!h.text(h.ctx.prodBodyHtml()).includes('All subcategories'));
});
it('a new category resets the subcategory, and so does Clear the filters', async () => {
  const h = await opened({ cats: TREE });
  const bak = h.ctx.prodCategories().find((c) => c.en === 'Bakery').key;
  h.CMD.prodCat(bak); h.CMD.prodSub('1');
  h.CMD.prodCat(h.ctx.prodCategories().find((c) => c.en === 'Drinks').key);
  assert.strictEqual(h.s.prodSub, 'all');
  h.CMD.prodCat(bak); h.CMD.prodSub('1'); h.CMD.prodClearQ();
  assert.strictEqual(h.s.prodSub, 'all'); assert.strictEqual(h.s.prodCat, 'all');
});
it('a subcategory that matches nothing after a search says so and offers the clear', async () => {
  const h = await opened({ cats: TREE });
  h.CMD.prodCat(h.ctx.prodCategories().find((c) => c.en === 'Bakery').key);
  h.CMD.prodSub(h.ctx.prodSubcats().find((c) => c.en === 'Pastry').key);
  h.s.prodQ = 'rye';
  const t = h.text(h.ctx.prodBodyHtml());
  assert.ok(t.includes('No products match') && t.includes('Clear the filters'));
});

section('2 · the catalogue: the store switch');
it('reads the per-store grid once, at the endpoint’s ceiling', async () => {
  const h = await opened();
  same(h.calls.reads.filter((p) => p.startsWith('/inventory/grid')), ['/inventory/grid?limit=5000']);
  h.ctx.screenProductCatalogue(); await settle();
  assert.strictEqual(h.calls.reads.filter((p) => p.startsWith('/inventory/grid')).length, 1, 'latched');
});
it('two stores: All stores and each store by name', async () => {
  const h = await opened();
  const t = h.text(h.ctx.prodBodyHtml());
  assert.ok(t.includes('All stores') && t.includes('Tianhe') && t.includes('Yuexiu'));
});
it('in Chinese, the stores’ Chinese names', async () => {
  const h = await opened({ lang: 'zh' });
  const t = h.text(h.ctx.prodBodyHtml());
  assert.ok(t.includes('全部门店') && t.includes('天河') && t.includes('越秀'));
});
it('one store: no switch', async () => {
  const h = await opened({ grid: GRID({ data: { stores: [STORES[0]], products: [] } }) });
  assert.ok(!h.text(h.ctx.prodBodyHtml()).includes('All stores'));
});
it('a grid cut short by its ceiling: no switch (it would invent sold-outs past the cut)', async () => {
  const h = await opened({ grid: GRID({ truncated: true }) });
  assert.ok(!h.text(h.ctx.prodBodyHtml()).includes('All stores'));
});
it('an upstream-catalogue shop keeps no stock here: no read, no switch', async () => {
  const h = await opened({ catalogMode: 'upstream' });
  assert.ok(!h.calls.reads.some((p) => p.startsWith('/inventory/grid')));
  assert.ok(!h.text(h.ctx.prodBodyHtml()).includes('All stores'));
});
it('a failed grid read: the shop-wide figures, and no switch', async () => {
  const h = await opened({ grid: new Error('HTTP 500') });
  assert.ok(!h.text(h.ctx.prodBodyHtml()).includes('All stores'));
  assert.strictEqual(chipCount(h, 'Out'), 1, 'the whole-shop Out count stands (Breakfast box at 0)');
});
it('picking Yuexiu: Low and Out count Yuexiu’s shelf, with its own low line', async () => {
  const h = await opened();
  assert.strictEqual(chipCount(h, 'Low'), 1, 'whole shop: Old bun at 4');
  h.CMD.prodStore('2');
  assert.strictEqual(h.s.prodStore, '2');
  // Yuexiu: Rye 0, Old bun 0, Breakfast box min(0/2, 6/1)=0 → Out 3; Oat milk 6 ≤ 8 → Low 1.
  assert.strictEqual(chipCount(h, 'Out'), 3);
  assert.strictEqual(chipCount(h, 'Low'), 1);
  h.CMD.prodStatus('low');
  same(cardNames(h), ['Oat milk']);
});
it('a card says its stock at the picked store', async () => {
  const h = await opened();
  h.CMD.prodStore('1');
  const card = h.text(h.ctx.productCard({ group: false, p: h.ctx.prodRows().find((p) => p._id === 2) }));
  assert.ok(card.includes('20 in stock'), card);
});
it('an assembled bundle at a store is how many whole sets its parts make there', async () => {
  const h = await opened();
  h.CMD.prodStore('1');
  // Tianhe: Rye 12 / 2 = 6, Oat milk 3 / 1 = 3 → 3.
  assert.strictEqual(h.ctx.prodRows().find((p) => p._id === 5).stock, 3);
});
it('a supplier item is never Low or Out at any store, and a draft stays a draft', async () => {
  const h = await opened();
  h.CMD.prodStore('2');
  const rows = h.ctx.prodRows();
  assert.strictEqual(rows.find((p) => p._id === 6).kind, 'on');
  assert.strictEqual(rows.find((p) => p._id === 7).kind, 'draft');
});
it('the store is a view, not a filter: every product is still listed, and the lookup array is untouched', async () => {
  const h = await opened();
  const before = h.ctx.DB.products.map((p) => p.stock).join();
  h.CMD.prodStore('2');
  assert.strictEqual(cardNames(h).length, 7);
  assert.strictEqual(h.ctx.DB.products.map((p) => p.stock).join(), before);
});
it('a store that is gone after a re-read falls back to All stores', async () => {
  const h = await opened();
  h.CMD.prodStore('2');
  h.ctx.state.prodGrid.tried = false;
  const h2serve = GRID({ data: { stores: [STORES[0], { id: 3, name_en: 'Panyu' }], products: [] } });
  h.ctx.apiRaw = () => Promise.resolve(h2serve);
  await h.ctx.loadProdGrid(true);
  assert.strictEqual(h.s.prodStore, '');
});

section('3 · the catalogue: Going nowhere and On promotion');
it('reads /products/highlights and draws both chips with the server’s counts', async () => {
  const h = await opened();
  assert.ok(h.calls.reads.includes('/products/highlights'));
  assert.strictEqual(chipCount(h, 'Going nowhere'), 2);
  assert.strictEqual(chipCount(h, 'On promotion'), 1);
});
it('each chip narrows to exactly the server’s id set', async () => {
  const h = await opened();
  h.CMD.prodStatus('dead');
  same(cardNames(h), ['Old bun', 'Draft thing']);
  h.CMD.prodStatus('promo');
  same(cardNames(h), ['Croissant']);
  h.CMD.prodStatus('promo');
  assert.strictEqual(h.s.prodStatus, 'all', 'a second tap clears, like every status chip');
});
it('a count of zero hides its chip', async () => {
  const h = await opened({ hi: { success: true, goingNowhere: { count: 0, ids: [] }, onPromotion: { count: 1, ids: [2] } } });
  assert.ok(!h.text(h.ctx.prodBodyHtml()).includes('Going nowhere'));
  assert.ok(h.text(h.ctx.prodBodyHtml()).includes('On promotion'));
});
it('a failed read draws neither, and a lit one lets its filter go', async () => {
  const h = await opened();
  h.CMD.prodStatus('dead');
  h.ctx.apiRaw = () => Promise.reject(new Error('HTTP 500'));
  await h.ctx.loadProdHi(true);
  const t = h.text(h.ctx.prodBodyHtml());
  assert.ok(!t.includes('Going nowhere') && !t.includes('On promotion'));
  assert.strictEqual(h.s.prodStatus, 'all');
  assert.strictEqual(cardNames(h).length, 7);
});
it('in Chinese, the desktop’s own words', async () => {
  const h = await opened({ lang: 'zh' });
  const t = h.text(h.ctx.prodBodyHtml());
  assert.ok(t.includes('无人问津') && t.includes('促销中'));
});

section('4 · the catalogue: Export CSV');
it('the button is beside the search, and opens the whole-catalogue file', async () => {
  const h = await opened();
  const html = h.ctx.screenProductCatalogue();
  assert.ok(h.text(html).includes('Export CSV'));
  assert.ok(html.indexOf('mProdQ') < html.indexOf("APP.cmd('prodExport')"));
  h.s.prodQ = 'rye'; h.s.prodStatus = 'low';
  h.CMD.prodExport();
  assert.strictEqual(h.calls.href, '/api/retail-admin/products/export.csv', 'never the filtered view');
});
it('without products:export, no button', async () => {
  const h = await opened({ caps: ['products:view'] });
  assert.ok(!h.ctx.screenProductCatalogue().includes('prodExport'));
});
it('in Chinese, 导出', async () => {
  const h = await opened({ lang: 'zh' });
  assert.ok(h.text(h.ctx.screenProductCatalogue()).includes('导出'));
});

/* ── Stock activity ─────────────────────────────────────────────────────── */
const ENV = (rows) => ({ success: true, total: rows.length, rows,
  summary: [{ source: 'manual', events: rows.length, units_out: 2, units_in: 0 }],
  digest: { zeroed: [], big: [], zeroed_total: 0 } });
const AROWS = [{ id: 1, ts_local: '2026-09-30 09:12:00', source: 'manual', store: 'Tianhe', product: 'Rye loaf', sku: 'B1', delta: -2, balance_after: 10, note: 'RT-1047' }];
function activity(opts = {}) {
  return mk(Object.assign({ serve: (p) => (p.startsWith('/activity') ? (opts.fail ? new Error('HTTP 500') : ENV(opts.rows || AROWS)) : {}) }, opts));
}
const lastAct = (h) => new URLSearchParams(h.calls.reads.filter((p) => p.startsWith('/activity?')).slice(-1)[0].split('?')[1]);

section('5 · stock activity: Custom dates');
it('four ranges now: Today, 7 days, 30 days, Custom', async () => {
  const h = activity(); h.ctx.screenActivity(); await settle();
  const t = h.text(h.ctx.screenActivity());
  assert.ok(t.includes('Today') && t.includes('7 days') && t.includes('30 days') && t.includes('Custom'));
});
it('Custom asks for From and To first, filled with the window on screen, and reads nothing yet', async () => {
  const h = activity(); h.ctx.screenActivity(); await settle();
  const before = h.calls.reads.length;
  h.CMD.actRange('custom');
  const a = h.s.ask;
  assert.strictEqual(a.title, 'Custom');
  same(a.fields.map((f) => [f.id, f.label, f.type, f.value]),
    [['from', 'From', 'date', TODAY], ['to', 'To', 'date', TODAY]]);
  assert.strictEqual(a.confirmLabel, 'Apply');
  assert.strictEqual(h.calls.reads.length, before);
});
it('a missing day or an inverted window is refused in the sheet', async () => {
  const h = activity(); h.CMD.actRange('custom');
  assert.strictEqual(h.s.ask.validate({ from: '', to: TODAY }), 'Pick a date');
  assert.strictEqual(h.s.ask.validate({ from: '2026-09-10', to: '2026-09-01' }), 'From is after to');
  assert.strictEqual(h.s.ask.validate({ from: '2026-09-01', to: '2026-09-10' }), null);
});
it('Apply reads the ledger for exactly those two days, and the dates show under the switch', async () => {
  const h = activity(); h.CMD.actRange('custom');
  h.els['ask-from'] = { value: '2026-09-01' }; h.els['ask-to'] = { value: '2026-09-10' };
  h.CMD.askRun(); await settle();
  const q = lastAct(h);
  assert.strictEqual(q.get('from'), '2026-09-01'); assert.strictEqual(q.get('to'), '2026-09-10');
  assert.strictEqual(q.get('limit'), '60'); assert.strictEqual(q.get('offset'), '0');
  assert.ok(!q.has('q') && !q.has('source'));
  assert.strictEqual(h.s.actRange, 'custom');
  assert.ok(h.text(h.ctx.screenActivity()).includes('D09-01 – D09-10'));
});
it('a multi-day window keeps the month-day on each row; one day shows the clock alone', async () => {
  const h = activity(); h.s.actRange = 'custom'; h.s.actFrom = '2026-09-01'; h.s.actTo = '2026-09-10';
  assert.strictEqual(h.ctx.actClock('2026-09-30 09:12:00'), '09-30 09:12');
  h.s.actFrom = h.s.actTo = '2026-09-05';
  assert.strictEqual(h.ctx.actClock('2026-09-05 09:12:00'), '09:12');
});
it('a Custom pick that IS a preset lights the preset', async () => {
  const h = activity(); h.CMD.actRange('custom');
  h.els['ask-from'] = { value: '2026-09-24' }; h.els['ask-to'] = { value: TODAY };
  h.CMD.askRun(); await settle();
  assert.strictEqual(h.s.actRange, 'week'); assert.strictEqual(h.s.actFrom, null);
});
it('a preset after Custom drops the custom days', async () => {
  const h = activity(); h.s.actRange = 'custom'; h.s.actFrom = '2026-09-01'; h.s.actTo = '2026-09-10';
  h.CMD.actRange('month'); await settle();
  assert.strictEqual(lastAct(h).get('from'), '2026-09-01');
  assert.strictEqual(h.s.actFrom, null);
});

section('6 · stock activity: search');
it('typing holds the words and reads nothing; Enter reads with q, on the same window and channel', async () => {
  const h = activity(); h.ctx.screenActivity(); await settle();
  h.CMD.actSource('manual'); await settle();
  const before = h.calls.reads.length;
  h.CMD.actQ('RT-1047');
  assert.strictEqual(h.calls.reads.length, before, 'a keystroke is not a read');
  h.CMD.actSearchGo(); await settle();
  const q = lastAct(h);
  same([q.get('from'), q.get('to'), q.get('source'), q.get('q')], [TODAY, TODAY, 'manual', 'RT-1047']);
});
it('the search box stays on screen while its answer loads, and when it fails', async () => {
  const h = activity({ fail: true }); h.s.actQ = 'oat';
  let html = h.ctx.screenActivity();
  assert.ok(html.includes('id="mActQ"') && html.includes('value="oat"') && h.text(html).includes('Loading'));
  await settle();
  html = h.ctx.screenActivity();
  assert.ok(html.includes('id="mActQ"') && h.text(html).includes('Could not load stock activity'));
});
it('the × empties the box and reads again without q', async () => {
  const h = activity(); h.s.actQ = 'oat';
  h.els.mActQ = { value: 'oat' }; h.els.mActClr = { style: {} };
  h.CMD.mActClr(); await settle();
  assert.strictEqual(h.s.actQ, ''); assert.strictEqual(h.els.mActQ.value, '');
  assert.ok(!lastAct(h).has('q'));
});
it('nothing found says the ledger’s own empty line', async () => {
  const h = activity({ rows: [] }); h.s.actQ = 'zzz'; h.ctx.screenActivity(); await settle();
  assert.ok(h.text(h.ctx.screenActivity()).includes('Nothing moved in this range.'));
});
it('the placeholder is the desktop’s, in both languages', async () => {
  assert.ok(activity().ctx.screenActivity().includes('placeholder="SKU / name / order"'));
  assert.ok(activity({ lang: 'zh' }).ctx.screenActivity().includes('placeholder="货号 / 名称 / 订单"'));
});

section('7 · stock activity: Export CSV');
it('opens the file of the view: window, channel and search', async () => {
  const h = activity(); h.s.actRange = 'custom'; h.s.actFrom = '2026-09-01'; h.s.actTo = '2026-09-10';
  h.s.actSource = 'miniapp'; h.s.actQ = ' oat ';
  h.CMD.actExport();
  const [p, qs] = h.calls.href.split('?');
  assert.strictEqual(p, '/api/retail-admin/activity/export.csv');
  const q = new URLSearchParams(qs);
  same([...q.keys()], ['from', 'to', 'source', 'q']);
  same([q.get('from'), q.get('to'), q.get('source'), q.get('q')], ['2026-09-01', '2026-09-10', 'miniapp', 'oat']);
});
it('with nothing narrowing it, just the window', async () => {
  const h = activity(); h.CMD.actExport();
  assert.strictEqual(h.calls.href, `/api/retail-admin/activity/export.csv?from=${TODAY}&to=${TODAY}`);
});
it('without activity:export, no button', async () => {
  const h = activity({ caps: ['activity:view'] }); h.ctx.screenActivity(); await settle();
  assert.ok(!h.ctx.screenActivity().includes('actExport'));
  const h2 = activity(); h2.ctx.screenActivity(); await settle();
  assert.ok(h2.ctx.screenActivity().includes("APP.cmd('actExport')"));
});

/* ── Waste ──────────────────────────────────────────────────────────────── */
function waste(opts = {}) {
  return mk(Object.assign({ serve: (p) => (p === '/waste/reasons' ? { success: true, data: [] }
    : p.startsWith('/waste?') ? (opts.fail ? new Error('HTTP 500') : { success: true, data: opts.rows || [], totals: { entries: 0 } }) : {}) }, opts));
}
const lastWst = (h) => new URLSearchParams(h.calls.reads.filter((p) => p.startsWith('/waste?')).slice(-1)[0].split('?')[1]);

section('8 · waste: a free date range');
it('the week by default, and Custom beside the presets', async () => {
  const h = waste(); h.ctx.screenWaste(); await settle();
  assert.strictEqual(lastWst(h).get('from'), '2026-09-24');
  assert.ok(h.text(h.ctx.screenWaste()).includes('Custom'));
});
it('Custom asks first, then reads exactly those days, voided rows included', async () => {
  const h = waste(); h.ctx.screenWaste(); await settle();
  h.CMD.wstRange('custom');
  same(h.s.ask.fields.map((f) => [f.id, f.type, f.value]), [['from', 'date', '2026-09-24'], ['to', 'date', TODAY]]);
  assert.strictEqual(h.s.ask.validate({ from: '2026-09-10', to: '2026-09-01' }), 'From is after to');
  h.els['ask-from'] = { value: '2026-08-01' }; h.els['ask-to'] = { value: '2026-08-31' };
  h.CMD.askRun(); await settle();
  const q = lastWst(h);
  same([q.get('from'), q.get('to'), q.get('include_voided')], ['2026-08-01', '2026-08-31', '1']);
  assert.ok(h.text(h.ctx.screenWaste()).includes('D08-01 – D08-31'));
});
it('an empty custom window is a filter: it offers the clear, and the clear puts the week back', async () => {
  const h = waste(); h.s.wst.range = 'custom'; h.s.wst.from = '2026-08-01'; h.s.wst.to = '2026-08-31';
  h.ctx.screenWaste(); await settle();
  assert.ok(h.text(h.ctx.screenWaste()).includes('Nothing matches those filters'));
  h.CMD.wstClear(); await settle();
  same([h.s.wst.range, h.s.wst.from, h.s.wst.to], ['week', null, null]);
  assert.strictEqual(lastWst(h).get('from'), '2026-09-24');
});
it('a preset after Custom drops the custom days', async () => {
  const h = waste(); h.s.wst.range = 'custom'; h.s.wst.from = '2026-08-01'; h.s.wst.to = '2026-08-31';
  h.CMD.wstRange('today'); await settle();
  same([lastWst(h).get('from'), lastWst(h).get('to')], [TODAY, TODAY]);
  assert.strictEqual(h.s.wst.from, null);
});
it('a failed read still says it failed, with the switch above it', async () => {
  const h = waste({ fail: true }); h.s.wst.range = 'custom'; h.s.wst.from = '2026-08-01'; h.s.wst.to = '2026-08-31';
  h.ctx.screenWaste(); await settle();
  const t = h.text(h.ctx.screenWaste());
  assert.ok(t.includes('Could not load waste records.') && t.includes('Custom'));
});

section('9 · every string is a live pair');
const phoneHas = (en, zh) => M.includes(`T('${en}','${zh}')`);
it('the desktop’s own pairs, copied whole', () => {
  for (const [en, zh] of [['All subcategories', '全部子分类'], ['Going nowhere', '无人问津'], ['On promotion', '促销中'],
    ['Export CSV', '导出'], ['SKU / name / order', '货号 / 名称 / 订单']]) {
    assert.ok(DESK.includes(`${en} · ${zh}`) || PRODUCTS_JS.includes(`${en} · ${zh}`)
      || DESK.includes(`data-ph-en="${en}" data-ph-cn="${zh}"`), 'desktop has ' + en);
    assert.ok(M.includes(`'${en}'`) && M.includes(`'${zh}'`), 'phone uses ' + en);
  }
  assert.ok(PRODUCTS_JS.includes("cuT('All stores', '全部门店')"));
});
it('the ask-sheet’s pairs are Finance’s and Trend’s', () => {
  for (const [en, zh] of [['Custom', '自定义'], ['From', '从'], ['To', '至'], ['Apply', '应用'],
    ['Pick a date', '选日期'], ['From is after to', '起始日期晚于结束日期']]) {
    assert.ok(phoneHas(en, zh), en);
  }
});

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
