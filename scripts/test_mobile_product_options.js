#!/usr/bin/env node
/**
 * §325 step PD11 — WHAT THE CUSTOMER CHOOSES, EDITED ON THE PHONE.
 *
 *   node scripts/test_mobile_product_options.js
 *
 * The desktop is the spec: public/retail-admin/09-products.js — optLoad,
 * optRender / _optChoiceRow, optType, optReq, optLimit, optDefault,
 * optAddOption / optAddExtras, optPick / optUnlink, optBody, and the
 * OPT_LOADED / options_clear gate in pdCollectBody. The server's options save
 * is REPLACE-ALL, so the two rules that stopped 39 products losing their
 * questions are pinned here first: options never read are never sent, and an
 * empty list is sent only with options_clear, only when the server last held
 * some. The phone code is RUN, lifted out of public/m.html by name into a
 * sandbox with a fake server and the REAL autosave engine, so every save is
 * asserted on method, path and every body field. No browser — fast shard.
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
  'peBadgeOf', 'peRteClean', 'peBundleDraft', 'peBuBody', 'peBpBody', 'peBpModeBody', 'peBundleOwnsCost', 'peOptsDraft', 'peOptBody', 'peDraftFrom', 'peBody', 'peDiff', 'peSkuTaken', 'peErrText', 'peApplyToCatalogue',
  'peCostOn', 'peAutoStart', 'loadPe', 'peFootHtml', 'peSubcats', 'screenProductEdit', 'peEntryRow', 'pePopped',
  'prodRecordsDrop', 'loadPeImages', 'pePhotosCard', 'searchBox', 'searchClearShow',
  'peProdName', 'peBuCard', 'peBpCard', 'pePickRows', 'pePickListHtml', 'sheetPePick', 'pePickRepaint',
  'peOptLinkTo', 'peOptCard', 'peOptAt'];
const CONSTS = ['peOptBlank', 'peOptTouched', 'PILL', 'KIND2PILL', 'PE_MAX_PHOTOS', 'MCAN_MONEY_ONLY', 'ROUTE_CAP', 'money', 'cfgGet', 'PE_FACTS', 'PE_FREE_OF', 'PE_FREE_ALIAS', 'PE_BADGES',
  'pePlainToHtml', 'peRichForEdit'];
const REGS = ['peOpen', 'peField', 'peUndo', 'peBu', 'peBuRemove', 'peBpMode', 'peBpQty', 'peBpQtyDone', 'peBpRemove',
  'pePickOpen', 'pePickQ', 'pePickAdd', 'pePickClose', 'pePickRetry',
  'peOptQ', 'peOptC', 'peOptType', 'peOptReq', 'peOptLimit', 'peOptDefault', 'peOptAdd', 'peOptRemove', 'peOptMove',
  'peOptChoiceAdd', 'peOptChoiceRemove', 'peOptChoiceMove', 'peOptLinkOpen', 'peOptUnlink'];
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
    // The Delete row (§325 PD14): test_mobile_products_bulk.js.
    peDeleteRow: () => '',
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
  { _id: 7, sku: 'SKU OM-1', rawSku: 'OM-1', name: ['Oat milk', '燕麦奶'], vLabel: '', size: '1 L', hay: 'oat milk 燕麦奶 om-1', parts: false, priceNum: 18, stock: 9 },
  { _id: 31, sku: 'SKU PK-1', rawSku: 'PK-1', name: ['Pickles', '腌菜'], vLabel: '', size: '50 g', hay: 'pickles 腌菜 pk-1', parts: false, priceNum: 4, stock: 12 },
  { _id: 32, sku: 'SKU HS-1', rawSku: 'HS-1', name: ['Hot sauce', 'Hot sauce'], vLabel: 'Small', size: '30 ml', hay: 'hot sauce hs-1', parts: false, priceNum: 0, stock: 0 }];
const DRESSING = () => ({ id: 1, question_en: 'Choose dressing', question_cn: '选择酱料', type: 'single', is_required: 1, min_choices: 0, max_choices: 0,
  choices: [{ id: 11, label_en: 'Tahini', label_cn: '芝麻酱', price_delta: 0, is_default: 1, stock_product_id: null },
            { id: 12, label_en: 'Lemon', label_cn: '柠檬', price_delta: 0, is_default: 0, stock_product_id: null }] });
const EXTRAS = () => ({ id: 2, question_en: 'Add extras?', question_cn: '加点配料?', type: 'multi', is_required: 0, min_choices: 0, max_choices: 2,
  choices: [{ id: 21, label_en: 'Pickles', label_cn: '腌菜', price_delta: 4, is_default: 0, stock_product_id: 31 }] });
const WITH = (...o) => ROW({ options: o });
const OUT = (o) => { const x = JSON.parse(JSON.stringify(o)); delete x.id; x.choices = x.choices.map((c) => { const y = Object.assign({}, c); delete y.id; return y; }); return x; };
const card = (h) => h.text(h.ctx.peOptCard());
const opts = (h) => h.s.pe.draft.opts;

section('1 · Read, or it is never sent (OPT_LOADED)');
it('the questions come with the product: both drawn, the default ticked, the link named with its stock', async () => {
  const h = await opened({ row: WITH(DRESSING(), EXTRAS()) }); const t = card(h), html = h.ctx.peOptCard();
  assert.ok(t.startsWith('Options (customer chooses) Let customers choose. A free pick (dressing) never affects stock.'), t);
  assert.ok(html.includes('value="Choose dressing"') && html.includes('value="选择酱料"') && html.includes('value="Tahini"'));
  assert.ok(t.includes('Pickles · 12 in stock'), t);
  assert.ok(/aria-pressed="true" aria-label="Default pick"/.test(html));
  assert.ok(html.includes('value="2" placeholder="0"'), 'the ceiling of a pick-any');
  assert.ok(t.includes('Pick-any extras. Link each to a product'));
});
it('a product that asks nothing: None · tap to add a choice, and both Add buttons', async () => {
  const h = await opened({ row: WITH() });
  assert.strictEqual(card(h).replace(/^.*?when low\. /, ''), 'None · tap to add a choice + Add a pick (free) + Add paid extras');
});
it('a row that did not carry its questions: the card says so, offers no control, and no save ever mentions options', async () => {
  const h = await opened();
  assert.strictEqual(card(h), 'Options (customer chooses) Could not load. Close and try again.');
  h.CMD.peOptAdd('pick'); assert.strictEqual(opts(h), null);
  h.CMD.peField('name_en', 'Oat milk 2'); h.flush();
  same(h.w(0).body, { name_en: 'Oat milk 2' });
});
it('editing anything else never resends the questions', async () => {
  const h = await opened({ row: WITH(DRESSING()) });
  h.CMD.peField('notes', 'x'); h.flush();
  same(h.w(0).body, { notes: 'x' });
});
it('without products:edit: read only, and the commands refuse', async () => {
  const h = await opened({ row: WITH(DRESSING(), EXTRAS()) }); h.s.caps = ['products:view'];
  const html = h.ctx.peOptCard();
  ['peOptAdd', 'peOptRemove', 'peOptLinkOpen', 'peOptUnlink', 'peOptChoiceAdd'].forEach((c) => assert.ok(!html.includes(c), c));
  assert.ok(/value="Choose dressing"[^>]*disabled/.test(html));
  h.CMD.peOptRemove(0); h.CMD.peOptQ(0, 'question_en', 'X'); h.CMD.peOptAdd('pick');
  same([opts(h).length, opts(h)[0].question_en], [2, 'Choose dressing']);
});

section('2 · The list sent, in optBody’s shape');
it('a question edited: the WHOLE list, every key of every question and choice', async () => {
  const h = await opened({ row: WITH(DRESSING(), EXTRAS()) });
  h.CMD.peOptQ(0, 'question_en', ' Pick a dressing '); h.flush();
  const d = OUT(DRESSING()); d.question_en = 'Pick a dressing';
  same(h.w(0), { p: '/products/7', method: 'PATCH', body: { options: [d, OUT(EXTRAS())] } });
});
it('+ Add a pick (free): two blank choices and Required — nothing is sent until it has words', async () => {
  const h = await opened({ row: WITH() }); h.CMD.peOptAdd('pick');
  same(opts(h)[0], { question_en: '', question_cn: '', type: 'single', is_required: 1, min_choices: 0, max_choices: 0,
    choices: [{ label_en: '', label_cn: '', price_delta: 0, is_default: 0, stock_product_id: null }, { label_en: '', label_cn: '', price_delta: 0, is_default: 0, stock_product_id: null }] });
  h.flush(); assert.strictEqual(h.calls.writes.length, 0, 'a question with no words is not part of the list');
  h.CMD.peOptQ(0, 'question_en', 'Spice'); h.CMD.peOptC(0, 0, 'label_en', 'Mild'); h.flush();
  same(h.w(0).body, { options: [{ question_en: 'Spice', question_cn: '', type: 'single', is_required: 1, min_choices: 0, max_choices: 0,
    choices: [{ label_en: 'Mild', label_cn: '', price_delta: 0, is_default: 0, stock_product_id: null }] }] });
});
it('+ Add paid extras: the desktop’s seed — "Add extras?" / 加点配料?, pick any, not required, one slot', async () => {
  const h = await opened({ row: WITH() }); h.CMD.peOptAdd('extras');
  same([opts(h)[0].question_en, opts(h)[0].question_cn, opts(h)[0].type, opts(h)[0].is_required, opts(h)[0].choices.length], ['Add extras?', '加点配料?', 'multi', 0, 1]);
});
it('a charge is a number; a pick-one has no charge to type', async () => {
  const h = await opened({ row: WITH(DRESSING(), EXTRAS()) });
  h.CMD.peOptC(1, 0, 'price_delta', '4.5'); h.CMD.peOptC(0, 0, 'price_delta', '9'); h.flush();
  same(h.w(0).body.options.map((o) => o.choices[0].price_delta), [0, 4.5]);
  assert.ok(!/peOptC',0,0,'price_delta'/.test(h.ctx.peOptCard()));
});
it('Pick one ⇄ Pick any: to a free pick drops every charge, link and limit', async () => {
  const h = await opened({ row: WITH(EXTRAS()) }); h.CMD.peOptType(0, 'single'); h.flush();
  same(h.w(0).body.options[0], { question_en: 'Add extras?', question_cn: '加点配料?', type: 'single', is_required: 0, min_choices: 0, max_choices: 0,
    choices: [{ label_en: 'Pickles', label_cn: '腌菜', price_delta: 0, is_default: 0, stock_product_id: null }] });
});
it('a text question stays what it is (no choices, the type shown and not offered)', async () => {
  const h = await opened({ row: WITH({ id: 3, question_en: 'Note', question_cn: '', type: 'text', is_required: 0, min_choices: 0, max_choices: 0, choices: [] }) });
  assert.ok(/<option value="text" selected disabled>Type an answer \(unsupported\)<\/option>/.test(h.ctx.peOptCard()));
  h.CMD.peOptQ(0, 'question_cn', '备注'); h.flush();
  same(h.w(0).body.options, [{ question_en: 'Note', question_cn: '备注', type: 'text', is_required: 0, min_choices: 0, max_choices: 0, choices: [] }]);
  h.CMD.peOptType(0, 'text'); assert.strictEqual(opts(h)[0].type, 'text', 'and nothing moves back onto it');
});
it('limits: a floor makes it Required; un-ticking Required drops the floor; 0 or nonsense is no limit', async () => {
  const h = await opened({ row: WITH(EXTRAS()) });
  h.CMD.peOptLimit(0, 'min_choices', '1'); assert.strictEqual(opts(h)[0].is_required, 1);
  h.CMD.peOptLimit(0, 'max_choices', 'x'); h.flush();
  same([h.w(0).body.options[0].min_choices, h.w(0).body.options[0].max_choices, h.w(0).body.options[0].is_required], [1, 0, 1]);
  await saved(h);
  h.CMD.peOptReq(0); h.flush();
  same([h.w(1).body.options[0].min_choices, h.w(1).body.options[0].is_required], [0, 0]);
  h.CMD.peOptLimit(0, 'min_choices', '2'); h.CMD.peOptType(0, 'single'); assert.strictEqual(opts(h)[0].min_choices, 0);
});
it('defaults: exactly one on a pick-one; each its own on a pick-any', async () => {
  const h = await opened({ row: WITH(DRESSING(), EXTRAS()) });
  h.CMD.peOptDefault(0, 1); same(opts(h)[0].choices.map((c) => c.is_default), [0, 1]);
  h.CMD.peOptDefault(1, 0); h.CMD.peOptAdd('extras'); h.CMD.peOptDefault(1, 0);
  same(opts(h)[1].choices.map((c) => c.is_default), [0]);
});
it('order: questions and choices move up and down, and the list is sent in its new order', async () => {
  const h = await opened({ row: WITH(DRESSING(), EXTRAS()) });
  h.CMD.peOptMove(1, -1); h.CMD.peOptChoiceMove(1, 1, -1); h.flush();
  same(h.w(0).body.options.map((o) => [o.question_en, o.choices.map((c) => c.label_en)]), [['Add extras?', ['Pickles']], ['Choose dressing', ['Lemon', 'Tahini']]]);
  h.CMD.peOptMove(0, -1); h.CMD.peOptChoiceMove(1, 1, 1);
  same(opts(h).map((o) => o.question_en), ['Add extras?', 'Choose dressing'], 'nothing moves past an end');
});

section('3 · Linked stock');
it('+ Stock product opens the picker over every product but this one, with size and SKU spelled out', async () => {
  const h = await opened({ row: WITH(EXTRAS()) }); h.CMD.peOptChoiceAdd(0); h.CMD.peOptLinkOpen(0, 1);
  same([h.s.pe.pick.kind, h.s.pe.pick.oi, h.s.pe.pick.ci], ['opt', 0, 1]);
  const ids = (h.ctx.pePickListHtml().match(/pePickAdd',(\d+)\)/g) || []).map((x) => Number(/(\d+)\)$/.exec(x)[1]));
  same(ids, [31, 32]);
  assert.ok(h.text(h.ctx.pePickListHtml()).includes('Hot sauce Small · 30 ml · HS-1'));
  assert.ok(h.ctx.sheetPePick().includes('placeholder="Search a product to use for stock…"'));
  same(h.calls.catalogue, [false]);
});
it('a pick links it, seeds blank labels from the product (never an English name as the Chinese) and the charge from its price, and closes', async () => {
  const h = await opened({ row: WITH(EXTRAS()) }); h.CMD.peOptChoiceAdd(0); h.CMD.peOptLinkOpen(0, 1); h.CMD.pePickAdd(31);
  assert.strictEqual(h.s.pe.pick, null);
  h.flush();
  same(h.w(0).body.options[0].choices[1], { label_en: 'Pickles', label_cn: '腌菜', price_delta: 4, is_default: 0, stock_product_id: 31 });
  await saved(h);
  h.CMD.peOptChoiceAdd(0); h.CMD.peOptC(0, 2, 'price_delta', '2'); h.CMD.peOptLinkOpen(0, 2); h.CMD.pePickAdd(32); h.flush();
  same(h.w(1).body.options[0].choices[2], { label_en: 'Hot sauce', label_cn: '', price_delta: 2, is_default: 0, stock_product_id: 32 });
});
it('a free pick cannot be linked; Unlink sends the choice with no link', async () => {
  const h = await opened({ row: WITH(DRESSING(), EXTRAS()) });
  h.CMD.peOptLinkOpen(0, 0); assert.strictEqual(h.s.pe.pick, null);
  assert.ok(!h.ctx.peOptCard().includes("peOptLinkOpen',0,"));
  h.CMD.peOptUnlink(1, 0); h.flush();
  same(h.w(0).body.options[1].choices[0].stock_product_id, null);
});

section('4 · An empty list removes questions only when said out loud (options_clear)');
it('removing every question the server holds: {options: [], options_clear: true}', async () => {
  const h = await opened({ row: WITH(DRESSING(), EXTRAS()) });
  h.CMD.peOptRemove(1); h.CMD.peOptRemove(0); h.flush();
  same(h.w(0).body, { options: [], options_clear: true });
});
it('a product that asked nothing, given a blank question and then not: nothing is sent', async () => {
  const h = await opened({ row: WITH() }); h.CMD.peOptAdd('pick'); h.CMD.peOptRemove(0); h.flush();
  assert.strictEqual(h.calls.writes.length, 0);
});
it('a question added and saved, then removed in the same visit: cleared too — the server holds it now', async () => {
  const h = await opened({ row: WITH() });
  h.CMD.peOptAdd('pick'); h.CMD.peOptQ(0, 'question_en', 'Spice'); h.CMD.peOptC(0, 0, 'label_en', 'Mild'); h.flush(); await saved(h);
  h.CMD.peOptRemove(0); h.flush();
  same(h.w(1).body, { options: [], options_clear: true });
});
it('a list with questions left never carries options_clear', async () => {
  const h = await opened({ row: WITH(DRESSING(), EXTRAS()) }); h.CMD.peOptRemove(1); h.flush();
  same(Object.keys(h.w(0).body), ['options']);
});
it('Undo puts the questions back as they were read', async () => {
  const h = await opened({ row: WITH(DRESSING(), EXTRAS()) });
  h.CMD.peOptRemove(0); h.flush(); await saved(h);
  h.CMD.peUndo(); await settle();
  same(opts(h).map((o) => o.question_en), ['Choose dressing', 'Add extras?']);
});

section('5 · Words, and the desktop is the spec');
it('in Chinese: the desktop’s pairs', async () => {
  const h = await opened({ lang: 'zh', row: WITH(DRESSING(), EXTRAS()) }); const t = card(h), html = h.ctx.peOptCard();
  ['选项(顾客选择)', '单选', '多选', '必选', '+ 添加选项', '+ 添加选择(免费)', '+ 添加付费加项', '腌菜 · 12 库存', '选'].forEach((w) => assert.ok(t.includes(w), w));
  ['问题(英文,如:选择酱料)', '问题(中文)', '选项(英文)', '选项(中文)'].forEach((w) => assert.ok(html.includes(`placeholder="${w}"`), w));
});
it('the desktop’s body, gate and clear rule are the ones mirrored', () => {
  assert.ok(PRODUCTS_JS.includes("if (id && OPT_ID === Number(id) && OPT_LOADED) {"));
  assert.ok(PRODUCTS_JS.includes('if (!body.options.length && OPT_LOADED_N > 0) body.options_clear = true;'));
  assert.ok(PRODUCTS_JS.includes(".filter(o => (o.question_en || o.question_cn) && (o.type === 'text' || o.choices.length));"));
  assert.ok(PRODUCTS_JS.includes("is_required: (o.is_required || lim.min > 0) ? 1 : 0,"));
  assert.ok(PRODUCTS_JS.includes("OPT.push({ question_en: 'Add extras?', question_cn: '加点配料?', type: 'multi', is_required: 0,"));
  const lifted = liftFn('peOptBody');
  assert.ok(lifted.includes(".filter(o=>(o.question_en||o.question_cn)&&(o.type==='text'||o.choices.length))"));
});
it('the Details screen draws the card after the bundles', () => {
  assert.ok(/\$\{peBpCard\(\)\}\s*\$\{peOptCard\(\)\}/.test(liftFn('screenProductEdit')));
});

(async () => {
  for (const f of pending) await f();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
