#!/usr/bin/env node
/**
 * §325 step PD12 — A NEW PRODUCT, MADE ON THE PHONE.
 *
 *   node scripts/test_mobile_product_new.js
 *
 * The desktop is the spec: Products → Add product ▾ → Add manually
 * (public/retail-admin.html → pdOpen(null)), pdAutoSaveNow's name hold, and
 * pdSaveCore's POST /products with its promotion to edit mode (the minted
 * DRAFT-… SKU written back, every later save a PATCH). The phone code is RUN,
 * lifted out of public/m.html by name into a sandbox with a fake server and the
 * REAL autosave engine, so the create and the write after it are asserted on
 * method, path and every body field. It also reads routes/retail.js's create
 * handler, so the list of keys the phone trusts the POST to store cannot drift
 * from the keys the POST really stores. No browser — fast shard.
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
  'peOptLinkTo', 'peOptCard', 'peOptAt', 'peSizesCard', 'mapProduct',
  'peCanCreate', 'peNewCard', 'loadPeNew', 'peCreate', 'peAfterCreate'];
const CONSTS = ['PE_CREATE_KEYS', 'PE_NEW_DEFAULT', 'peOptBlank', 'peOptTouched', 'PILL', 'KIND2PILL', 'PE_MAX_PHOTOS', 'MCAN_MONEY_ONLY', 'ROUTE_CAP', 'money', 'cfgGet', 'PE_FACTS', 'PE_FREE_OF', 'PE_FREE_ALIAS', 'PE_BADGES',
  'pePlainToHtml', 'peRichForEdit'];
const REGS = ['peNew', 'peFlag', 'peOpen', 'peField', 'peUndo', 'peBu', 'peBuRemove', 'peBpMode', 'peBpQty', 'peBpQtyDone', 'peBpRemove',
  'pePickOpen', 'pePickQ', 'pePickAdd', 'pePickClose', 'pePickRetry',
  'peOptQ', 'peOptC', 'peOptType', 'peOptReq', 'peOptLimit', 'peOptDefault', 'peOptAdd', 'peOptRemove', 'peOptMove',
  'peOptChoiceAdd', 'peOptChoiceRemove', 'peOptChoiceMove', 'peOptLinkOpen', 'peOptUnlink'];
const SUBS_PE = (() => { const at = M.indexOf('\nSUBS.productedit={'); assert.ok(at >= 0); return M.slice(at + 1, skipBalanced(M, M.indexOf('{', at))) + ';'; })();
const SRC = [...CONSTS.map(liftConst), 'let peAuto=null;', ...FNS.map(liftFn), ...REGS.map(liftReg), SUBS_PE].join('\n');

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
    loadPeSizes: (e) => { calls.sizes = (calls.sizes || 0) + 1; },
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


const RETAIL = fs.readFileSync(path.join(ROOT, 'routes/retail.js'), 'utf8');
const CREATE = ['products:view', 'products:edit', 'products:create', 'products:costs'];
const CATALOGUE = () => [{ _id: 7, sku: 'SKU OM-1', rawSku: 'OM-1', name: ['Oat milk', '燕麦奶'], hay: 'oat milk', parts: false }];
const NEWROW = (o) => Object.assign({ id: 55, name_en: 'Fig jam', name_cn: null, sku: 'DRAFT-AB12', sell_price: 0, compare_at_price: null,
  stock_qty: 0, ship_modes: 'air,land', is_published: 0, status: 'Active' }, o || {});
const serveNew = (extra) => (p) => (p === '/products/55' ? Object.assign(NEWROW(), { options: [], bundle: null, bundle_items: [], is_bundle: false }, extra || {}) : {});
function fresh(opts = {}) {
  const h = mk(Object.assign({ caps: CREATE, serve: serveNew(), products: CATALOGUE() }, opts));
  h.CMD.peNew();
  return h;
}
async function created(h, row) { h.calls.writes[0].res({ success: true, data: row || NEWROW() }); await settle(); }
const pe = (h) => h.s.pe;
const foot = (h) => h.text(h.ctx.peFootHtml());

section('1 · The door');
it('products:create with products:edit opens a blank Details screen; it is stacked with no product yet', () => {
  const h = fresh();
  same(h.s.stack, [{ route: 'productedit', pid: null }]);
  same([pe(h).pid, pe(h).draft.name_en, pe(h).draft.sku, pe(h).draft.sell_price], [null, '', '', '']);
  assert.strictEqual(h.calls.writes.length + h.calls.reads.length, 0, 'opening sends nothing and reads nothing');
});
it('no door without products:create, without products:edit, or where the catalogue is kept upstream', () => {
  for (const o of [{ caps: ['products:view', 'products:edit'] }, { caps: ['products:view', 'products:create'] }, { catalogMode: 'upstream' }]) {
    const h = mk(Object.assign({ caps: CREATE }, o));
    assert.strictEqual(h.ctx.peCanCreate(), false, JSON.stringify(o));
    h.CMD.peNew(); same(h.s.stack, []); assert.strictEqual(h.s.pe, null);
  }
});
it('the Products tab carries Add product on the catalogue view only, behind the same gate', () => {
  assert.ok(M.includes("const add=v==='catalogue'&&peCanCreate()?`<button class=\"cta inhead\" onclick=\"APP.cmd('peNew')\">${T('Add product','新增产品')}</button>`:'';"));
  assert.ok(M.includes("${pageHead({title:T('Products','产品'), cta:add, controls:true})}"));
});

section('2 · Before the first save');
it('titled New product; the foot says what starts the saving; no Undo, no Version history', () => {
  const h = fresh();
  assert.strictEqual(h.ctx.SUBS.productedit.titleOf(), 'New product');
  assert.strictEqual(foot(h), 'Add a name & SKU to start autosaving');
  assert.ok(!h.ctx.peFootHtml().includes('pvOpen') && !h.ctx.peFootHtml().includes('peUndo'));
});
it('the cards that need a product say so in the desktop’s words; Photos is ready now', () => {
  const h = fresh(); const t = h.text(h.ctx.screenProductEdit());
  ['Variants Add a name & SKU above — it saves automatically, then variants open here.',
    'Suggested add-ons Add a name & SKU above — it saves automatically, then suggest add-ons here.',
    'Bundle — sold as one Add a name & SKU above — it saves automatically, then set this up as a bundle.',
    'Options (customer chooses) Add a name & SKU above — it saves automatically, then add a choice like a dressing here.',
    'Photos No photos yet'].forEach((w) => assert.ok(t.includes(w), w));
  h.CMD.pePickOpen('bu'); h.CMD.peBpMode('assembled'); h.CMD.peOptAdd('pick');
  same([pe(h).pick, pe(h).draft.bpMode, pe(h).draft.opts], [null, null, null]);
});
it('a SKU alone is held: Add a name to start autosaving, nothing sent', async () => {
  const h = fresh(); h.CMD.peField('sku', 'FJ-1'); h.flush(); await settle();
  assert.strictEqual(h.calls.writes.length, 0);
  assert.strictEqual(foot(h), 'Add a name to start autosaving');
});

section('3 · The create');
it('the first save with a name is POST /products with what the create stores — no empty price, no cost, no bundles', async () => {
  const h = fresh(); h.CMD.peField('name_en', 'Fig jam'); h.flush();
  same(h.w(0), { p: '/products', method: 'POST', body: { name_en: 'Fig jam', name_cn: '', sku: '', weight: '', top_category: '', subcategory: '', tags: '',
    compare_at_price: 0, free_of: '', notes: '', is_market: 0, is_restock_only: 0, ship_modes: 'air,land',
    description_en: '', description_cn: '', description_format: 'rich' } });
  assert.strictEqual(foot(h), 'Saving…');
});
it('a price, a section and photos ride the create', async () => {
  const h = fresh(); h.CMD.peField('name_en', 'Fig jam'); h.CMD.peField('sell_price', '12'); h.CMD.peField('weight', '200 g');
  pe(h).gallery = ['data:image/jpeg;base64,QQ==']; pe(h).galDirty = true; h.flush();
  const b = h.w(0).body;
  same([b.sell_price, b.weight, b.images], [12, '200 g', ['data:image/jpeg;base64,QQ==']]);
});
it('the new product: its id, the minted DRAFT- SKU in the box, the list holds it, Back leads to its sheet — and nothing else is sent', async () => {
  const h = fresh(); h.CMD.peField('name_en', 'Fig jam'); h.flush(); await created(h);
  same([pe(h).pid, pe(h).created, pe(h).draft.sku], [55, true, 'DRAFT-AB12']);
  same(h.s.stack, [{ route: 'productedit', pid: 55 }]);
  same([h.ctx.DB.products[0]._id, h.ctx.DB.products[0].sku, h.ctx.DB.products[0].kind], [55, 'SKU DRAFT-AB12', 'draft']);
  same(h.calls.catalogue, [true]);
  h.flush(); await settle();
  assert.strictEqual(h.calls.writes.length, 1, 'the SKU written into the box and the choices read are not sent back');
  assert.strictEqual(foot(h), 'All changes saved Version history');
  assert.ok(h.ctx.peFootHtml().includes("pvOpen',55") && !h.ctx.peFootHtml().includes('peUndo'), 'history now; still no Undo back to a blank form');
});
it('every later edit is a PATCH of the new product with only its own key — the minted SKU is not sent back', async () => {
  const h = fresh(); h.CMD.peField('name_en', 'Fig jam'); h.flush(); await created(h);
  h.CMD.peField('sell_price', '12'); h.flush();
  same(h.w(1), { p: '/products/55', method: 'PATCH', body: { sell_price: 12 } });
});
it('what the create does not store goes straight after, in one PATCH: cost (with its tag), the low-stock line, made in batches', async () => {
  const h = fresh(); h.CMD.peField('name_en', 'Fig jam'); h.CMD.peField('unit_cost', '3.5'); h.CMD.peField('low_stock_threshold', '4'); h.CMD.peFlag('is_batch_made'); h.flush();
  const b = h.w(0).body; ['unit_cost', 'cost_incomplete', 'low_stock_threshold', 'is_batch_made'].forEach((k) => assert.ok(!(k in b), k));
  await created(h);
  same(h.w(1), { p: '/products/55', method: 'PATCH', body: { unit_cost: '3.5', cost_incomplete: 0, low_stock_threshold: '4', is_batch_made: 1 } });
  h.calls.writes[1].res({ success: true, data: NEWROW() }); await settle();
  h.CMD.peField('notes', 'n'); h.flush();
  same(h.w(2).body, { notes: 'n' }, 'and they are not sent a third time');
});
it('a failed create says why on the foot (sku_taken names the holder), and the next edit tries the create again', async () => {
  const h = fresh(); h.CMD.peField('name_en', 'Fig jam'); h.CMD.peField('sku', 'OM-1'); h.flush();
  h.calls.writes[0].rej(Object.assign(new Error('sku_taken'), { code: 'sku_taken', body: { conflict: { id: 7, name_en: 'Oat milk', is_active: 1, is_published: 1 } } }));
  await settle();
  assert.strictEqual(foot(h), 'Save failed: SKU “OM-1” is already used by “Oat milk”');
  assert.strictEqual(pe(h).pid, null);
  h.CMD.peField('sku', 'FJ-1'); h.flush();
  same([h.w(1).p, h.w(1).method, h.w(1).body.sku], ['/products', 'POST', 'FJ-1']);
});
it('a refused create says why', async () => {
  const h = fresh(); h.CMD.peField('name_en', 'Fig jam'); h.flush();
  h.calls.writes[0].rej(Object.assign(new Error('x'), { refused: true, words: ['You don’t have permission to do that.', '你没有执行此操作的权限。'] })); await settle();
  assert.strictEqual(foot(h), 'Save failed: You don’t have permission to do that.');
});

section('4 · After the create: the cards open');
it('the sizes are read and the product is read again; its choices card opens on what the server holds', async () => {
  const h = fresh(); h.CMD.peField('name_en', 'Fig jam'); h.flush(); await created(h);
  assert.strictEqual(h.calls.sizes, 1);
  same(h.calls.reads, ['/products/55']);
  same(pe(h).draft.opts, []);
  assert.ok(h.text(h.ctx.peOptCard()).includes('None · tap to add a choice'));
  assert.ok(h.text(h.ctx.peBuCard()).includes('No products yet — add some below.'));
  h.CMD.peOptAdd('pick'); h.CMD.peOptQ(0, 'question_en', 'Size'); h.CMD.peOptC(0, 0, 'label_en', 'Small'); h.flush();
  same(h.w(1), { p: '/products/55', method: 'PATCH', body: { options: [{ question_en: 'Size', question_cn: '', type: 'single', is_required: 1, min_choices: 0, max_choices: 0,
    choices: [{ label_en: 'Small', label_cn: '', price_delta: 0, is_default: 0, stock_product_id: null }] }] } });
});
it('if that read fails, the choices card says it could not load — never "none"', async () => {
  const h = fresh({ serve: () => new Error('HTTP 500') }); h.CMD.peField('name_en', 'Fig jam'); h.flush(); await created(h);
  assert.strictEqual(pe(h).draft.opts, null);
  assert.ok(h.text(h.ctx.peOptCard()).includes('Could not load. Close and try again.'));
});

section('5 · Leaving');
it('Back before a name: nothing is sent and no sheet opens', async () => {
  const h = fresh(); h.CMD.peField('sku', 'FJ-1');
  h.ctx.pePopped({ route: 'productedit', pid: null }); await settle();
  same([h.calls.writes.length, h.s.pe, h.s.productSku], [0, null, null]);
});
it('Back with a name not yet saved: the create goes on the wire as the screen closes', async () => {
  const h = fresh(); h.CMD.peField('name_en', 'Fig jam');
  h.ctx.pePopped({ route: 'productedit', pid: null });
  same([h.w(0).p, h.w(0).method], ['/products', 'POST']);
  await created(h);
  assert.strictEqual(h.ctx.DB.products[0]._id, 55, 'the list still learns of it');
});
it('Back after the create hands back the new product’s sheet', async () => {
  const h = fresh(); h.CMD.peField('name_en', 'Fig jam'); h.flush(); await created(h);
  h.ctx.pePopped(h.s.stack[0]);
  assert.strictEqual(h.s.productSku, 'SKU DRAFT-AB12');
});

section('6 · Words, and the desktop and server are the spec');
it('in Chinese: the desktop’s pairs', () => {
  const h = fresh({ lang: 'zh' });
  assert.strictEqual(h.ctx.SUBS.productedit.titleOf(), '新增产品');
  assert.strictEqual(foot(h), '填写名称和货号后自动保存');
  assert.ok(h.text(h.ctx.screenProductEdit()).includes('请先在上方填写名称和货号 — 系统会自动保存,随后即可在此添加规格。'));
});
it('the desktop: Add manually opens a blank editor; the hint and the hold are these', () => {
  assert.ok(DESK.includes('onclick="paAddMenuClose();pdOpen(null)"') && DESK.includes('Add manually · 手动新增'));
  assert.ok(PRODUCTS_JS.includes("cuT('Add a name & SKU to start autosaving', '填写名称和货号后自动保存')"));
  assert.ok(PRODUCTS_JS.includes("'New product · 新增产品'"));
  assert.ok(PRODUCTS_JS.includes("if (skuEl && !skuEl.value.trim() && j.data.sku) skuEl.value = j.data.sku;"));
});
it('the server’s create stores every key the phone trusts it with, and (since §325 S2i) the ones the phone sends after too', () => {
  const at = RETAIL.indexOf("router.post('/api/retail-admin/products', ");
  const end = RETAIL.indexOf('router.get(', at);
  const create = RETAIL.slice(at, end);
  const keys = vm.runInNewContext(liftConst('PE_CREATE_KEYS').replace(/^const PE_CREATE_KEYS\s*=/, '(') .replace(/;$/, ')'));
  keys.forEach((k) => assert.ok(new RegExp('\\bb\\.' + k + '\\b').test(create), 'POST reads b.' + k));
  const def = vm.runInNewContext(liftConst('PE_NEW_DEFAULT').replace(/^const PE_NEW_DEFAULT\s*=/, '(').replace(/;$/, ')'));
  /* S2i (§376) taught the create to store cost, its incomplete tag, the
     low-stock line and the batch flag. The phone's follow-up PATCH of those
     keys is now redundant but harmless; this pins that the create reads them,
     so the follow-up can be dropped safely later. */
  const S2I = ['unit_cost', 'cost_incomplete', 'low_stock_threshold', 'is_batch_made'];
  Object.keys(def).forEach((k) => {
    const reads = new RegExp('\\bb\\.' + k + '\\b').test(create);
    if (S2I.includes(k)) assert.ok(reads, 'POST now reads b.' + k);
    else assert.ok(!reads, 'POST still ignores b.' + k + ', so only the follow-up PATCH carries it');
  });
  S2I.forEach((k) => assert.ok(k in def, 'the follow-up still covers ' + k));
  assert.ok(/is_published, is_active, created_at/.test(create) && create.includes('b.is_published ? 1 : 0'), 'hidden unless told otherwise');
});

(async () => {
  for (const f of pending) await f();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
