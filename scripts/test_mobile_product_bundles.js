#!/usr/bin/env node
/**
 * §325 step PD10 — A PRODUCT'S TWO BUNDLES, EDITED ON THE PHONE.
 *
 *   node scripts/test_mobile_product_bundles.js
 *
 * The desktop is the spec: public/retail-admin/09-products.js — buLoad /
 * buRender / buPickerList / buBody ("Suggested add-ons", the `bundle` key) and
 * bpLoad / bpSetMode / bpRadioClick / bpPickerList / bpBody / bpModeBody
 * ("Bundle — sold as one", `bundle_items` + `bundle_mode`), folded into the
 * editor's save (pdCollectBody). The phone code is RUN, lifted out of
 * public/m.html by name into a sandbox with a fake server and the REAL
 * autosave engine (public/tacet-autosave.js), so every save is asserted on
 * its method, path and every body field. No browser — fast shard.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const DESK = fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8');
const PRODUCTS_JS = fs.readFileSync(path.join(ROOT, 'public/retail-admin/09-products.js'), 'utf8');
const CORE_JS = fs.readFileSync(path.join(ROOT, 'public/retail-admin/01-core.js'), 'utf8');
const ENGINE = require(path.join(ROOT, 'public/tacet-autosave.js'));

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

const FNS = ['E', 'pill', 'mCan', 'canRoute', 'prodCanEdit', 'pcMoney', 'prodLowThreshold', 'nothingYet', 'footBar',
  'peBadgeOf', 'peRteClean', 'peBundleDraft', 'peBuBody', 'peBpBody', 'peBpModeBody', 'peBundleOwnsCost', 'peDraftFrom', 'peBody', 'peDiff', 'peSkuTaken', 'peErrText', 'peApplyToCatalogue',
  'peCostOn', 'peAutoStart', 'loadPe', 'peFootHtml', 'peSubcats', 'screenProductEdit', 'peEntryRow', 'pePopped',
  'prodRecordsDrop', 'loadPeImages', 'pePhotosCard', 'searchBox', 'searchClearShow',
  'peProdName', 'peBuCard', 'peBpCard', 'pePickRows', 'pePickListHtml', 'sheetPePick', 'pePickRepaint'];
const CONSTS = ['PILL', 'KIND2PILL', 'PE_MAX_PHOTOS', 'MCAN_MONEY_ONLY', 'ROUTE_CAP', 'money', 'cfgGet', 'PE_FACTS', 'PE_FREE_OF', 'PE_FREE_ALIAS', 'PE_BADGES',
  'pePlainToHtml', 'peRichForEdit'];
const REGS = ['peOpen', 'peField', 'peUndo', 'peBu', 'peBuRemove', 'peBpMode', 'peBpQty', 'peBpQtyDone', 'peBpRemove',
  'pePickOpen', 'pePickQ', 'pePickAdd', 'pePickClose', 'pePickRetry'];
const SRC = [...CONSTS.map(liftConst), 'let peAuto=null;', ...FNS.map(liftFn), ...REGS.map(liftReg)].join('\n');

const ALL = ['products:view', 'products:edit', 'products:costs'];
const ROW = (o) => Object.assign({ id: 7, name_en: 'Oat milk', name_cn: '燕麦奶', sku: 'OM-1', size: '1 L',
  top_category: 'Drinks', subcategory: 'Plant milk', tags: 'new', sell_price: 18, compare_at_price: null, unit_cost: 6.5,
  cost_incomplete: 0, low_stock_threshold: null, free_of: 'nuts, Organic', notes: 'shelf B',
  product_facts: { origin_en: 'Sweden', storage_cn: '冷藏', care_en: 'Shake well' }, is_market: 0, is_restock_only: 0, is_batch_made: 0,
  ship_modes: 'air,land', description_en: 'Creamy.\nGood cold.', description_cn: '顺滑。', description_format: 'plain',
  recipe_id: null, is_bundle: false }, o || {});

function mk(opts = {}) {
  const calls = { reads: [], writes: [], renders: 0, catalogue: [] };
  const CMD = {};
  const els = {};
  const timers = [];
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥', API: '/api/retail-admin',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    SUBS: {}, CMD,
    DB: { products: opts.products || CATALOGUE() },
    state: { caps: opts.caps === undefined ? ALL : opts.caps, pos: opts.pos || 'owner', catalogMode: opts.catalogMode || 'self',
      cfg: {}, stack: [], productSku: 'SKU OM-1', oosSku: null, prodBusy: false, cats: opts.cats || null,
      prodVer: { open: false }, prodSales: { pid: null, seq: 0 }, pe: null,
      catalogueLoading: !!opts.catLoading, catalogueTried: opts.catTried !== false, liveProductsLoaded: opts.catLoaded !== false },
    loadCatalogue: (force) => { calls.catalogue.push(!!force); return Promise.resolve(); },
    render: () => { calls.renders++; },
    reg: (n, f) => { CMD[n] = f; },
    push: (route) => { ctx.state.stack.push({ route }); },
    loadCategories: () => {},
    // The sizes card (§325 PD9) has its own suite, test_mobile_product_sizes.js.
    loadPeSizes: () => {}, peSizesCard: () => '',
    recapNoMoney: () => ['warehouse', 'dispatch', 'customer_service'].includes(ctx.state.pos),
    featOn: () => true,
    navTabs: () => [],
    api: (p) => { calls.reads.push(p); const v = (opts.serve || (() => ({})))(p);
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(v); },
    // The gallery read (§325 PD6) has its own list; this suite's reads are the
    // row and the build list. test_mobile_product_photos.js holds the gallery.
    apiRaw: (p) => { (calls.rawReads = calls.rawReads || []).push(p);
      return Promise.resolve({ success: true, images: [], inherited: false }); },
    apiWrite: (p, body, method) => new Promise((res, rej) => {
      calls.writes.push({ p, body: JSON.parse(JSON.stringify(body)), method, res, rej });
    }),
    TacetAutosave: { create: (o) => ENGINE.create(Object.assign({}, o, { delay: 0 })) },
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
    document: { getElementById: (id) => els[id] || null, activeElement: null },
    URLSearchParams, Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, isNaN, parseFloat,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  const h = { ctx, CMD, calls, els, text, s: ctx.state,
    flush: () => vm.runInContext('peAuto && peAuto.flush()', ctx),
    auto: () => vm.runInContext('peAuto', ctx),
    w: (i) => { const x = calls.writes[i]; return x && { p: x.p, body: x.body, method: x.method }; } };
  return h;
}
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
const serve = (row, lines) => (p) => (p === '/products/7' ? row
  : p === '/products/7/build-lines' ? (lines instanceof Error ? lines : { lines: lines || [] }) : {});
async function opened(opts = {}) {
  const h = mk(Object.assign({ serve: serve(opts.row || ROW(), opts.lines) }, opts));
  h.CMD.peOpen(7); await settle();
  return h;
}
async function saved(h, data) { h.calls.writes[h.calls.writes.length - 1].res({ success: true, data: data || ROW() }); await settle(); }


const CATALOGUE = () => [
  { _id: 7, sku: 'SKU OM-1', rawSku: 'OM-1', name: ['Oat milk', '燕麦奶'], vLabel: '', size: '1 L', hay: 'oat milk 燕麦奶 om-1', parts: false },
  { _id: 21, sku: 'SKU GR-1', rawSku: 'GR-1', name: ['Granola', '格兰诺拉'], vLabel: '', size: '500 g', hay: 'granola 格兰诺拉 gr-1', parts: false },
  { _id: 22, sku: 'SKU HN-1', rawSku: 'HN-1', name: ['Honey', '蜂蜜'], vLabel: 'Big', size: '', hay: 'honey 蜂蜜 hn-1', parts: false },
  { _id: 23, sku: 'SKU BS-1', rawSku: 'BS-1', name: ['Breakfast set', '早餐套装'], vLabel: '', size: '', hay: 'breakfast set 早餐套装 bs-1', parts: true }];
const BUNDLED = () => ({ bundle: { title_en: 'Goes with', title_cn: '搭配', ids: [21, 22], price: 30, voucher: 'SET5' },
  bundle_items: [{ id: 21, qty: 2, name_en: 'Granola', name_cn: '格兰诺拉' }, { id: 99, qty: 1, name_en: 'Old jar', name_cn: '旧罐' }],
  bundle_mode: 'assembled', is_bundle: true });
const bu = (h) => h.text(h.ctx.peBuCard());
const bp = (h) => h.text(h.ctx.peBpCard());
const pickIds = (h) => (h.ctx.pePickListHtml().match(/pePickAdd',(\d+)\)/g) || []).map((x) => Number(/(\d+)\)$/.exec(x)[1]));

section('1 · What the two cards show');
it('a product with neither: the desktop’s words, nothing listed, no way chosen', async () => {
  const h = await opened(); const a = bu(h), b = bp(h);
  assert.ok(a.startsWith('Suggested add-ons Suggest other products on this product’s page — a one-tap “add these too”.'), a);
  ['Title EN', 'Title CN', 'No products yet — add some below.', '+ Add product', 'Set price ¥ (optional)', 'Auto voucher (optional)'].forEach((w) => assert.ok(a.includes(w), w));
  assert.ok(h.ctx.peBuCard().includes('placeholder="blank = item total"') && h.ctx.peBuCard().includes('placeholder="Goes well with"'));
  assert.ok(b.startsWith('Bundle — sold as one Customers see ONE product at the price you set above. Choose how you stock it.'), b);
  assert.ok(b.includes('Assembled from other products Stock follows the parts — no count to keep.') && b.includes('Pre-packed on a shelf You stock finished sets'));
  assert.strictEqual((h.ctx.peBpCard().match(/aria-pressed="true"/g) || []).length, 0);
  assert.ok(!b.includes('+ Add product'), 'parts are only for an assembled set');
});
it('a product with both: the add-ons by name (a size says which), the set price and voucher; the parts with their counts, named by the server when the catalogue does not hold them', async () => {
  const h = await opened({ row: ROW(BUNDLED()) }); const html = h.ctx.peBuCard();
  assert.ok(bu(h).includes('Granola Honey · Big'));
  assert.ok(html.includes('value="Goes with"') && html.includes('value="搭配"') && html.includes('value="30"') && html.includes('value="SET5"'));
  const b = h.ctx.peBpCard();
  assert.ok(/aria-pressed="true"[^]*Assembled from other products/.test(b));
  assert.ok(bp(h).includes('Granola × Old jar ×'), bp(h));
  assert.ok(b.includes('value="2"') && b.includes('value="1"'));
});
it('a saved set with no way stated is an assembled one (bpLoad)', async () => {
  const h = await opened({ row: ROW({ bundle_items: [{ id: 21, qty: 1 }], bundle_mode: null }) });
  assert.strictEqual(h.s.pe.draft.bpMode, 'assembled');
  h.CMD.peField('name_en', 'Oat milk set'); h.flush();
  same(h.w(0).body, { name_en: 'Oat milk set' }, 'reading it that way is not an edit');
});
it('in Chinese: the desktop’s pairs', async () => {
  const h = await opened({ lang: 'zh' }); const t = bu(h) + ' ' + bp(h);
  ['推荐搭配', '标题(英文)', '标题(中文)', '尚未添加商品 — 在下方添加。', '+ 添加商品', '搭配价 ¥(可选)', '自动优惠券(可选)',
    '套装产品', '顾客看到的是上方价格的单个产品。请选择其库存管理方式。', '由其他产品组成', '预先包装成套'].forEach((w) => assert.ok(t.includes(w), w));
});
it('without products:edit: the cards are read only and every command refuses', async () => {
  const h = await opened({ row: ROW(BUNDLED()) }); h.s.caps = ['products:view'];
  const a = h.ctx.peBuCard(), b = h.ctx.peBpCard();
  ['pePickOpen', 'peBuRemove', 'peBpRemove'].forEach((c) => assert.ok(!a.includes(c) && !b.includes(c), c));
  assert.ok(/value="Goes with"[^>]*disabled/.test(a));
  h.CMD.peBu('title_en', 'X'); h.CMD.peBuRemove(21); h.CMD.peBpMode('prepacked'); h.CMD.peBpRemove(21); h.CMD.pePickOpen('bu');
  same([h.s.pe.draft.bu.title_en, h.s.pe.draft.bu.ids, h.s.pe.draft.bpMode, h.s.pe.draft.bp.length, h.s.pe.pick], ['Goes with', [21, 22], 'assembled', 2, null]);
});

section('2 · Suggested add-ons: the `bundle` key, in buBody’s shape');
it('the picker hides what is already listed and finds by name or SKU', async () => {
  const h = await opened({ row: ROW(BUNDLED()) }); h.CMD.pePickOpen('bu');
  same(pickIds(h), [7, 23]);
  h.CMD.pePickQ('BS-'); same(pickIds(h), [23]);
  h.CMD.pePickQ('zzz'); assert.strictEqual(h.text(h.ctx.pePickListHtml()), 'No matches');
});
it('a first pick: PATCH {bundle: {title_en, title_cn, ids, price: 0, voucher}} and nothing else; the picker stays open, its search emptied', async () => {
  const h = await opened(); h.CMD.pePickOpen('bu'); h.CMD.pePickQ('gran'); h.CMD.pePickAdd(21); h.flush();
  same(h.w(0), { p: '/products/7', method: 'PATCH', body: { bundle: { title_en: '', title_cn: '', ids: [21], price: 0, voucher: '' } } });
  assert.ok(h.s.pe.pick && h.s.pe.pick.q === '');
  assert.ok(!pickIds(h).includes(21));
});
it('title, set price and voucher go trimmed, the price a number', async () => {
  const h = await opened({ row: ROW(BUNDLED()) });
  h.CMD.peBu('title_en', ' Breakfast '); h.CMD.peBu('price', '28.5'); h.CMD.peBu('voucher', ' SET6 '); h.flush();
  same(h.w(0).body, { bundle: { title_en: 'Breakfast', title_cn: '搭配', ids: [21, 22], price: 28.5, voucher: 'SET6' } });
});
it('an emptied set price is 0 (the items’ own total)', async () => {
  const h = await opened({ row: ROW(BUNDLED()) }); h.CMD.peBu('price', ''); h.flush();
  same(h.w(0).body.bundle.price, 0);
});
it('removing the last item clears the whole thing: {bundle: null}', async () => {
  const h = await opened({ row: ROW(BUNDLED()) }); h.CMD.peBuRemove(21); h.CMD.peBuRemove(22); h.flush();
  same(h.w(0).body, { bundle: null });
});

section('3 · Sold as one: `bundle_items` and `bundle_mode`, always together');
it('choosing Assembled: {bundle_items: null, bundle_mode: "assembled"} — no parts yet', async () => {
  const h = await opened(); h.CMD.peBpMode('assembled'); h.flush();
  same(h.w(0).body, { bundle_items: null, bundle_mode: 'assembled' });
  assert.ok(bp(h).includes('Add the products this bundle contains. + Add product'));
});
it('parts can only be picked for an assembled set, and the picker hides this product, any other set and what is already in', async () => {
  const h = await opened(); h.CMD.pePickOpen('bp'); assert.strictEqual(h.s.pe.pick, null);
  h.CMD.peBpMode('assembled'); h.CMD.pePickOpen('bp');
  same(pickIds(h), [21, 22]);
  h.CMD.pePickAdd(23); h.CMD.pePickAdd(7); same(h.s.pe.draft.bp, [], 'a stale tap on a hidden row adds nothing');
  h.CMD.pePickAdd(21); same(pickIds(h), [22]);
});
it('a part: {bundle_items: [{id, qty: 1}], bundle_mode}; its count a whole number, at least 1', async () => {
  const h = await opened(); h.CMD.peBpMode('assembled'); h.CMD.pePickOpen('bp'); h.CMD.pePickAdd(21); h.flush();
  same(h.w(0).body, { bundle_items: [{ id: 21, qty: 1 }], bundle_mode: 'assembled' });
  await saved(h);
  h.CMD.peBpQty(21, '3'); h.flush(); same(h.w(1).body, { bundle_items: [{ id: 21, qty: 3 }], bundle_mode: 'assembled' });
  await saved(h);
  h.CMD.peBpQty(21, '0'); h.flush(); same(h.w(2).body, { bundle_items: [{ id: 21, qty: 1 }], bundle_mode: 'assembled' });
});
it('Pre-packed sends no parts but keeps them on hand; back to Assembled sends them again', async () => {
  const h = await opened({ row: ROW(BUNDLED()) }); h.CMD.peBpMode('prepacked'); h.flush();
  same(h.w(0).body, { bundle_items: null, bundle_mode: 'prepacked' });
  assert.ok(!bp(h).includes('Granola'));
  await saved(h);
  h.CMD.peBpMode('assembled'); h.flush();
  same(h.w(1).body, { bundle_items: [{ id: 21, qty: 2 }, { id: 99, qty: 1 }], bundle_mode: 'assembled' });
});
it('tapping the chosen way again: not a set — {bundle_items: null, bundle_mode: null}', async () => {
  const h = await opened({ row: ROW(BUNDLED()) }); h.CMD.peBpMode('assembled'); h.flush();
  same(h.w(0).body, { bundle_items: null, bundle_mode: null });
});
it('removing a part sends the rest, with the mode', async () => {
  const h = await opened({ row: ROW(BUNDLED()) }); h.CMD.peBpRemove(99); h.flush();
  same(h.w(0).body, { bundle_items: [{ id: 21, qty: 2 }], bundle_mode: 'assembled' });
});
it('the first part takes the cost box away, and a cost typed before it never leaves', async () => {
  const h = await opened();
  assert.ok(h.text(h.ctx.screenProductEdit()).includes('Cost'));
  h.CMD.peField('unit_cost', '7'); h.CMD.peBpMode('assembled'); h.CMD.pePickOpen('bp'); h.CMD.pePickAdd(21); h.flush();
  same(h.w(0).body, { bundle_items: [{ id: 21, qty: 1 }], bundle_mode: 'assembled' });
  assert.ok(!h.ctx.screenProductEdit().includes("peField','unit_cost'"));
});

section('4 · Undo, the catalogue, the picker’s states, and the Back gesture');
it('Undo puts both bundles back as the screen opened them, and the next save says so', async () => {
  const h = await opened({ row: ROW(BUNDLED()) });
  h.CMD.peBuRemove(21); h.CMD.peBpMode('prepacked'); h.flush(); await saved(h);
  h.CMD.peUndo(); await settle();
  same([h.s.pe.draft.bu.ids, h.s.pe.draft.bpMode, h.s.pe.draft.bp], [[21, 22], 'assembled', [{ id: 21, qty: 2 }, { id: 99, qty: 1 }]]);
  h.flush(); await settle();
  const last = h.calls.writes[h.calls.writes.length - 1];
  same([last.body.bundle && last.body.bundle.ids, last.body.bundle_items, last.body.bundle_mode],
    [[21, 22], [{ id: 21, qty: 2 }, { id: 99, qty: 1 }], 'assembled']);
});
it('a save that made a set brings the list’s row up to date (its parts, and that it is a set)', async () => {
  const h = await opened(); h.CMD.peBpMode('assembled'); h.CMD.pePickOpen('bp'); h.CMD.pePickAdd(21); h.flush();
  await saved(h, ROW({ bundle_items: [{ id: 21, qty: 1, name_en: 'Granola' }], is_bundle: true, bundle_mode: 'assembled' }));
  const p = h.ctx.DB.products.find((x) => x._id === 7);
  same([p.bItems, p.parts, p.bundle], [[{ id: 21, qty: 1 }], true, true]);
});
it('the picker asks for the catalogue; while it loads it says so, a failed one offers Try again', async () => {
  const h = await opened(); h.ctx.DB.products = []; h.s.catalogueLoading = true; h.CMD.pePickOpen('bu');
  same(h.calls.catalogue, [false]);
  assert.strictEqual(h.text(h.ctx.pePickListHtml()), 'Loading…');
  h.s.catalogueLoading = false; h.s.liveProductsLoaded = false;
  assert.strictEqual(h.text(h.ctx.pePickListHtml()), 'Load failed Try again');
  h.CMD.pePickRetry(); same(h.calls.catalogue, [false, true]);
});
it('the sheet: its search, Close, and the Back gesture closes it before the screen', async () => {
  const h = await opened(); h.CMD.pePickOpen('bu');
  const t = h.text(h.ctx.sheetPePick());
  assert.ok(h.ctx.sheetPePick().includes('placeholder="Search a product to add…"') && t.includes('Close'));
  h.CMD.pePickClose(); assert.strictEqual(h.s.pe.pick, null);
  assert.ok(M.includes("if(state.pe&&state.pe.pick) html += layer('pepick:'+state.pe.pick.kind, sheetPePick());"));
  assert.ok(M.includes("if(state.pe&&state.pe.pick) L.push(()=>{ state.pe.pick=null; });"));
  assert.ok(M.includes("['mPePickQ','mPePickClr','pePickQ']"));
});

section('5 · The desktop is the spec');
it('the same three keys, built the same way, and the same picker filters', () => {
  assert.ok(PRODUCTS_JS.includes('body.bundle = buBody();'));
  assert.ok(PRODUCTS_JS.includes('body.bundle_items = bpBody(); body.bundle_mode = bpModeBody();'));
  assert.ok(PRODUCTS_JS.includes("ids: BU.ids.slice(), price: BU.price === '' ? 0 : (Number(BU.price) || 0),"));
  assert.ok(PRODUCTS_JS.includes("if (BP_MODE !== 'assembled' || !BP.length) return null;"));
  assert.ok(PRODUCTS_JS.includes('p.id !== BP_ID && !have.has(p.id) && !p.is_bundle'));
  assert.ok(PRODUCTS_JS.includes("bpSetMode(input.dataset.wasOn === '1' ? null : mode);"));
});
it('the Details screen draws both cards', () => {
  const scr = liftFn('screenProductEdit');
  assert.ok(/\$\{peSizesCard\(\)\}\s*\$\{peBuCard\(\)\}\s*\$\{peBpCard\(\)\}/.test(scr));
});

(async () => {
  for (const f of pending) await f();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
