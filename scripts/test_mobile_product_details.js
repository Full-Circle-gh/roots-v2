#!/usr/bin/env node
/**
 * §325 step PD5 — A PRODUCT'S CORE FIELDS AND DESCRIPTION, EDITED ON THE PHONE.
 *
 *   node scripts/test_mobile_product_details.js
 *
 * The desktop is the spec: public/retail-admin/09-products.js — pdOpen (what
 * the editor shows), pdCollectBody (the keys and their meanings), pdSaveCore
 * (sku_taken), pdAutoSaveNow (the hold before a name). The phone code is RUN,
 * lifted out of public/m.html by name into a sandbox with a fake server and
 * the REAL autosave engine (public/tacet-autosave.js), so every save is
 * asserted on its method, path and every body field. No browser — fast shard.
 *
 * What it pins:
 *   1. who gets the door, and what opening it reads;
 *   2. only what changed is sent, in the desktop's keys;
 *   3. the autosave rules — a name first, never an empty price, unit_cost only
 *      when loaded and the operator's, facts only once touched, the two
 *      descriptions together and rich;
 *   4. sku_taken and a refusal say so on the screen's foot;
 *   5. what the rest of the phone reads is brought up to date, and leaving
 *      sends what is pending and hands back the product's sheet;
 *   6. the desktop's own strings.
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
  'peBadgeOf', 'peRteClean', 'peDraftFrom', 'peBody', 'peDiff', 'peSkuTaken', 'peErrText', 'peApplyToCatalogue',
  'peCostOn', 'peAutoStart', 'loadPe', 'peFootHtml', 'peSubcats', 'screenProductEdit', 'peEntryRow', 'pePopped',
  'prodRecordsDrop', 'loadPeImages', 'pePhotosCard'];
const CONSTS = ['PILL', 'KIND2PILL', 'PE_MAX_PHOTOS', 'MCAN_MONEY_ONLY', 'ROUTE_CAP', 'money', 'cfgGet', 'PE_FACTS', 'PE_FREE_OF', 'PE_FREE_ALIAS', 'PE_BADGES',
  'pePlainToHtml', 'peRichForEdit'];
const REGS = ['peOpen', 'peField', 'peFact', 'peFlag', 'peShip', 'peFree', 'peDesc', 'peUndo'];
const SRC = [...CONSTS.map(liftConst), 'let peAuto=null;', ...FNS.map(liftFn), ...REGS.map(liftReg)].join('\n');

const ALL = ['products:view', 'products:edit', 'products:costs'];
const ROW = (o) => Object.assign({ id: 7, name_en: 'Oat milk', name_cn: '燕麦奶', sku: 'OM-1', size: '1 L',
  top_category: 'Drinks', subcategory: 'Plant milk', tags: 'new', sell_price: 18, compare_at_price: null, unit_cost: 6.5,
  cost_incomplete: 0, low_stock_threshold: null, free_of: 'nuts, Organic', notes: 'shelf B',
  product_facts: { origin_en: 'Sweden', storage_cn: '冷藏', care_en: 'Shake well' }, is_market: 0, is_restock_only: 0, is_batch_made: 0,
  ship_modes: 'air,land', description_en: 'Creamy.\nGood cold.', description_cn: '顺滑。', description_format: 'plain',
  recipe_id: null, is_bundle: false }, o || {});

function mk(opts = {}) {
  const calls = { reads: [], writes: [], renders: 0 };
  const CMD = {};
  const els = {};
  const timers = [];
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥', API: '/api/retail-admin',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    SUBS: {}, CMD,
    DB: { products: [{ _id: 7, sku: 'SKU OM-1', rawSku: 'OM-1', name: ['Oat milk', '燕麦奶'], priceNum: 18, price: '¥18', cat: 'Drinks', sub: 'Plant milk', stock: 9, hay: '' }] },
    state: { caps: opts.caps === undefined ? ALL : opts.caps, pos: opts.pos || 'owner', catalogMode: opts.catalogMode || 'self',
      cfg: {}, stack: [], productSku: 'SKU OM-1', oosSku: null, prodBusy: false, cats: opts.cats || null,
      prodVer: { open: false }, prodSales: { pid: null, seq: 0 }, pe: null },
    render: () => { calls.renders++; },
    reg: (n, f) => { CMD[n] = f; },
    push: (route) => { ctx.state.stack.push({ route }); },
    loadCategories: () => {},
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

section('1 · the door, and what opening it reads');
it('products:edit gets Details on the sheet; without it, or on an upstream catalogue, no door', () => {
  assert.ok(mk().text(mk().ctx.peEntryRow({ _id: 7, sku: 'SKU OM-1' })).includes('Details'));
  assert.strictEqual(mk({ caps: ['products:view'] }).ctx.peEntryRow({ _id: 7 }), '');
  assert.strictEqual(mk({ catalogMode: 'upstream' }).ctx.peEntryRow({ _id: 7 }), '');
  const h = mk({ caps: ['products:view'] }); h.CMD.peOpen(7);
  assert.strictEqual(h.s.stack.length, 0, 'the command refuses too');
});
it('opening closes the sheet, stacks the screen for this product, and reads the row and its build list', async () => {
  const h = await opened();
  assert.strictEqual(h.s.productSku, null);
  same(h.s.stack, [{ route: 'productedit', pid: 7 }]);
  same(h.calls.reads, ['/products/7', '/products/7/build-lines']);
});
it('the screen shows what was read, a legacy plain description as HTML', async () => {
  const h = await opened();
  const html = h.ctx.screenProductEdit(), t = h.text(html);
  for (const w of ['Basics', 'Name', 'Name (second language)', 'SKU', 'Where it shows', 'Shop section', 'Subcategory', 'Badge',
    'Size / weight', 'Price', 'Was price', 'Cost', 'Low-stock alert at', 'Product details', 'Origin', 'Description',
    'Shipping', 'Flags', 'Free of', 'Internal notes']) assert.ok(t.includes(w), w);
  assert.ok(html.includes('value="Oat milk"') && html.includes('value="OM-1"') && html.includes('value="Sweden"'));
  assert.ok(html.includes('Creamy.<br>Good cold.'));
  assert.ok(html.includes('placeholder="Default 5"'));
});
it('without products:costs: no build-list read, and no cost box', async () => {
  const h = await opened({ caps: ['products:view', 'products:edit'] });
  same(h.calls.reads, ['/products/7']);
  assert.ok(!h.text(h.ctx.screenProductEdit()).includes('Cost'));
});

section('2 · only what changed is sent');
it('a new name: PATCH /products/7 {name_en} and nothing else', async () => {
  const h = await opened();
  h.CMD.peField('name_en', 'Oat milk barista'); h.flush();
  same(h.w(0), { p: '/products/7', body: { name_en: 'Oat milk barista' }, method: 'PATCH' });
});
it('the next edit sends only its own key, measured from what landed', async () => {
  const h = await opened();
  h.CMD.peField('name_en', 'Oat milk barista'); h.flush(); await saved(h);
  h.CMD.peField('sku', 'OM-2'); h.flush();
  same(h.w(1).body, { sku: 'OM-2' });
});
it('price, was price, size, badge, low-stock line and notes, each in the desktop’s shape', async () => {
  const h = await opened();
  h.CMD.peField('sell_price', '19.5'); h.CMD.peField('compare_at_price', '25'); h.CMD.peField('weight', '1.5 L');
  h.CMD.peField('tags', 'hot'); h.CMD.peField('low_stock_threshold', '4'); h.CMD.peField('notes', 'shelf C'); h.flush();
  same(h.w(0).body, { weight: '1.5 L', tags: 'hot', sell_price: 19.5, compare_at_price: 25, low_stock_threshold: '4', notes: 'shelf C' });
});
it('a new shop section clears the subcategory, and both travel', async () => {
  const h = await opened({ cats: [{ name: 'Drinks', subs: [{ name: 'Plant milk' }] }, { name: 'Bakery', name_cn: '烘焙', subs: [] }] });
  h.CMD.peField('top_category', 'Bakery'); h.flush();
  same(h.w(0).body, { top_category: 'Bakery', subcategory: '' });
});
it('Local only clears Air and Land, and is sent as local alone', async () => {
  const h = await opened();
  h.CMD.peShip('local'); h.flush();
  same(h.w(0).body, { ship_modes: 'local' });
  await saved(h);
  h.CMD.peShip('air'); h.flush();
  same(h.w(1).body, { ship_modes: 'air' }, 'ticking Air takes Local away');
});
it('Free of keeps what no box names, and a flag is 1 or 0', async () => {
  const h = await opened();
  h.CMD.peFree('soy'); h.CMD.peFlag('is_market'); h.flush();
  same(h.w(0).body, { free_of: 'nuts, soy, Organic', is_market: 1 });
});

section('3 · the autosave rules');
it('no name in either language: held, said, and nothing sent', async () => {
  const h = await opened();
  h.CMD.peField('name_en', ' '); h.CMD.peField('name_cn', ''); h.flush();
  assert.strictEqual(h.calls.writes.length, 0);
  assert.ok(h.text(h.ctx.peFootHtml()).includes('Add a name to start autosaving'));
});
it('an emptied price is never sent — it would make the product free', async () => {
  const h = await opened();
  h.CMD.peField('sell_price', ''); h.flush(); await settle();
  assert.strictEqual(h.calls.writes.length, 0);
  h.CMD.peField('notes', 'x'); h.flush(); await settle();
  assert.ok(!('sell_price' in h.w(0).body));
});
it('a price that is not a number of 0 or more is held', async () => {
  const h = await opened();
  h.CMD.peField('sell_price', 'abc'); h.flush();
  assert.strictEqual(h.calls.writes.length, 0);
  assert.ok(h.text(h.ctx.peFootHtml()).includes('Enter a price — a number, 0 or more.'));
});
it('the cost, when loaded and the operator’s: sent with its tag', async () => {
  const h = await opened();
  h.CMD.peField('unit_cost', '7'); h.flush();
  same(h.w(0).body, { unit_cost: '7', cost_incomplete: 0 });
  await saved(h);
  h.CMD.peFlag('cost_incomplete'); h.flush();
  same(h.w(1).body, { unit_cost: '7', cost_incomplete: 1 }, 'the tag never travels apart from the figure');
});
it('unit_cost never leaves when the figure is not loaded or not the operator’s', async () => {
  const cases = [
    ['no products:costs', { caps: ['products:view', 'products:edit'] }],
    ['a warehouse board', { pos: 'warehouse' }],
    ['the server sent no cost', { row: (() => { const r = ROW(); delete r.unit_cost; return r; })() }],
    ['a recipe owns it', { row: ROW({ recipe_id: 3 }) }],
    ['a bundle owns it', { row: ROW({ is_bundle: true }) }],
    ['a build list owns it', { lines: [{ id: 1 }] }],
    ['the build list could not be read', { lines: new Error('HTTP 500') }],
  ];
  for (const [why, o] of cases) {
    const h = await opened(o);
    h.CMD.peField('unit_cost', '0'); h.CMD.peField('name_en', 'Renamed'); h.flush();
    assert.ok(!('unit_cost' in h.w(0).body) && !('cost_incomplete' in h.w(0).body), why);
    assert.ok(!h.ctx.screenProductEdit().includes("'unit_cost'"), why + ': no box');
  }
});
it('Product details are sent only once a box is touched — then the whole bag', async () => {
  const h = await opened();
  h.CMD.peField('name_en', 'Renamed'); h.flush();
  assert.ok(!('product_facts' in h.w(0).body), 'an untouched card writes nothing');
  await saved(h);
  h.CMD.peFact('origin_en', 'Denmark'); h.flush();
  same(h.w(1).body, { product_facts: { care_en: 'Shake well', origin_en: 'Denmark', storage_cn: '冷藏' } },
    'a key the five boxes do not show is carried back, not dropped');
});
it('emptying every box the phone shows is still a statement, and is sent', async () => {
  const h = await opened();
  h.CMD.peFact('origin_en', ''); h.CMD.peFact('storage_cn', ''); h.flush();
  same(h.w(0).body, { product_facts: { care_en: 'Shake well' } });
});
it('a description edit sends both descriptions, rich, together', async () => {
  const h = await opened();
  h.CMD.peDesc('desc_en', '<p>Creamy and <b>good</b> cold.</p>'); h.flush();
  same(h.w(0).body, { description_en: '<p>Creamy and <b>good</b> cold.</p>', description_cn: '顺滑。', description_format: 'rich' });
});
it('a box left with no text and no picture saves as empty', async () => {
  const h = await opened();
  h.CMD.peDesc('desc_cn', '<p><br></p>&nbsp;'); h.flush();
  assert.strictEqual(h.w(0).body.description_cn, '');
  assert.strictEqual(h.ctx.peRteClean('<p><img src="x"></p>'), '<p><img src="x"></p>');
});

section('4 · refusals on the foot');
it('sku_taken names the product that holds the code, in the desktop’s words', async () => {
  const h = await opened();
  h.CMD.peField('sku', 'RY-1'); h.flush();
  h.calls.writes[0].rej(Object.assign(new Error('sku_taken'), { code: 'sku_taken', body: { error: 'sku_taken',
    conflict: { id: 9, name_en: 'Rye loaf', name_cn: '黑麦面包', is_active: 1, is_published: 1 } } }));
  await settle();
  assert.strictEqual(h.auto().state, 'error');
  assert.ok(h.text(h.ctx.peFootHtml()).includes('Save failed: SKU “RY-1” is already used by “Rye loaf”'), h.text(h.ctx.peFootHtml()));
});
it('a permission refusal says why', async () => {
  const h = await opened();
  h.CMD.peField('notes', 'x'); h.flush();
  h.calls.writes[0].rej(Object.assign(new Error('x'), { refused: true, words: ['You don’t have permission to do that.', '你没有执行此操作的权限。'] }));
  await settle();
  assert.ok(h.text(h.ctx.peFootHtml()).includes('You don’t have permission to do that.'));
});
it('a failed read says so and draws no form', async () => {
  const h = await opened({ serve: () => new Error('HTTP 500') });
  const t = h.text(h.ctx.screenProductEdit());
  assert.ok(t.includes('Could not load this.') && !t.includes('Basics'));
});

section('5 · after a save, and on the way out');
it('the catalogue row the phone reads takes the saved name, code and price', async () => {
  const h = await opened();
  h.CMD.peField('name_en', 'Oat milk barista'); h.flush();
  await saved(h, ROW({ name_en: 'Oat milk barista', sku: 'OM-9', sell_price: 21 }));
  const p = h.ctx.DB.products[0];
  same([p.name[0], p.sku, p.rawSku, p.priceNum, p.stock], ['Oat milk barista', 'SKU OM-9', 'OM-9', 21, 9]);
});
it('leaving sends what is pending and hands back this product’s sheet', async () => {
  const h = await opened();
  h.CMD.peField('notes', 'pending'); 
  h.ctx.pePopped({ route: 'productedit', pid: 7 });
  same(h.w(0).body, { notes: 'pending' });
  assert.strictEqual(h.s.productSku, 'SKU OM-1');
  assert.strictEqual(h.s.pe, null);
});
it('Undo puts the visit back and sends it', async () => {
  const h = await opened();
  h.CMD.peField('name_en', 'Wrong'); h.flush(); await saved(h);
  h.CMD.peUndo();
  same(h.w(1).body, { name_en: 'Oat milk' });
  assert.strictEqual(h.s.pe.draft.name_en, 'Oat milk');
});

section('6 · the desktop’s strings');
it('copied whole', () => {
  for (const [en, zh] of [['Basics', '基础'], ['Name', '名称'], ['Name (second language)', '名称(第二语言)'], ['SKU', '货号'],
    ['Where it shows', '分类与陈列'], ['Shop section', '商店分区'], ['Subcategory', '子分类'], ['Badge', '标签'],
    ['Size / weight', '规格'], ['Was price', '划线价'], ['Low-stock alert at', '低库存提醒阈值'], ['Product details', '产品详情'],
    ['Origin', '产地'], ['Ingredients', '配料'], ['Storage', '储存方式'], ['Shelf life', '保质期'], ['Serving suggestion', '食用建议'],
    ['Description', '描述'], ['Shipping', '配送方式'], ['Air', '空运'], ['Land', '陆运'], ['Local only', '仅广州'],
    ['Flags', '标记'], ['Sold at markets', '市集销售'], ['Made fresh in batches', '分批现做'], ['Restock-only, internal', '仅内部补货'],
    ['Free of', '不含'], ['Nuts', '无坚果'], ['Soy', '无大豆'], ['Gluten', '无麸质'], ['5 Spice', '无五香'], ['Internal notes', '内部备注'],
    ['Bold', '加粗'], ['Italic', '斜体'], ['Underline', '下划线'], ['Bulleted list', '项目符号'], ['Numbered list', '编号'],
    ['Clear formatting', '清除格式'], ['Details', '详情'], ['Stock', '库存']]) {
    assert.ok(DESK.includes(`${en} · ${zh}`), 'desktop has ' + en);
    assert.ok(M.includes(`T('${en}','${zh}')`) || M.includes(`['${en}','${zh}']`) || M.includes(`'${en}','${zh}'`), 'phone uses ' + en);
  }
  for (const [en, zh] of [['Add a name to start autosaving', '填写名称后自动保存'], ['Default', '默认'],
    [' is already used by ', ' 已被 '], [' is already in use', ' 已被占用']]) {
    assert.ok(PRODUCTS_JS.includes(`cuT('${en}', '${zh}')`) || CORE_JS.includes(`cuT('${en}', '${zh}')`), 'desktop has ' + en);
    assert.ok(M.includes(`T('${en}','${zh}')`), 'phone uses ' + en);
  }
});

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
