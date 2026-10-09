#!/usr/bin/env node
/**
 * §300 step R6 — a product's Cost & Pricing on the phone: the desktop product
 * editor's tab of that name (09-products.js pdApplyCostSource,
 * pdRecipeLinkOpen, pdRecipeUnlink, pdRecipeHealthPaint; 21-product-build.js,
 * the build list).
 *
 *   node scripts/test_mobile_product_cost.js
 *
 * Where the cost comes from (bundle > build list > recipe), the recipe link
 * (Link / Change / Unlink, with the desktop's confirmation), the recipe's
 * warnings, Open recipe, and the build list: lines, the recipe bridge, the
 * material picker, quantity and unit, remove, Save. Every write is asserted on
 * its request, the build-list body against blSave()'s own keys.
 *
 * MONEY FAILS CLOSED: the cost block needs products:costs, a line's rate and
 * cost also need materials:costs, a recipe's cost in the picker needs
 * recipes:costs, and none of it is drawn on a board that never sees money or
 * while the caps are still loading. The app's REAL gates answer (ROUTE_CAP,
 * MCAN_MONEY_ONLY, mCan, canRoute are lifted out of m.html).
 *
 * Harness: the other §300 recipe suites' (the code RUN in a vm context with
 * the app's own helpers, a fake clock, a recorded request log).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
const DPROD = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '09-products.js'), 'utf8');
const DBUILD = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '21-product-build.js'), 'utf8');

let passed = 0, failed = 0;
const pending = [];
function section(t) { pending.push(() => console.log('\n' + t)); }
function it(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }
  });
}
const flushMicro = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const J = (x) => JSON.parse(JSON.stringify(x));

function between(src, from, to) {
  const a = src.indexOf(from);
  assert.notStrictEqual(a, -1, 'not found: ' + from);
  const b = src.indexOf(to, a + from.length);
  assert.notStrictEqual(b, -1, 'not found after ' + from + ': ' + to);
  return src.slice(a, b);
}

const HELPERS = [
  between(M, 'function E(en, zh){', '\n') + '\n',
  between(M, 'const PILL = {', 'function toggle(on, onClick){'),
  between(M, 'function toggle(on, onClick){', '\n/* ===='),
  between(M, 'const escAttr=v=>', '\n') + '\n',
  between(M, 'const money=(cur,n)=>', '\n// Whole yuan'),
  between(M, 'function tmOneLang(m){', '\n') + '\n',
  between(M, "const RECAP_NO_MONEY=", '\n') + '\n',
  between(M, 'function recapNoMoney(){', '\n') + '\n',
].join('\n');
const GATES = between(M, 'const ROUTE_CAP={', '/* NAMED FOR THE JOB THEY HOLD');
const BLOCK = between(M, "/* ==========================================================================\n   A product's Cost & Pricing (§300 step R6)", "SUBS.pick={");
const PC_LIT = between(M, '  pc:{pid:null', 'stale:false}') + 'stale:false}';
const PUSH = between(M, 'function push(route){', 'function pop(){');
const PC_RESET = (PUSH.match(/  if\(route==='productcost'\) pcFresh\(\);\n/) || [])[0];
assert.ok(PC_RESET, 'push() reads a Cost & Pricing screen fresh');
// pop() as the app has it, minus the two unrelated screens' flushes.
const POP = between(M, 'function pop(){', '\nconst CMD={}')
  .replace(/\n  if\(top==='receive'\) recvFlush\(\);/, '')
  .replace(/\n  if\(top==='teamrole'&&tmAuto\) tmAuto\.flush\(\);/, '');
const MAP = between(M, 'function mapProduct(r){', 'function mapReview(r){');

const ALL = ['products:view', 'products:edit', 'products:delete', 'products:costs', 'materials:costs',
  'recipes:view', 'recipes:costs'];

function mk(opts = {}) {
  const calls = { req: [], toasts: [], renders: 0, opened: [] };
  const handlers = opts.handlers || {};
  let clock = 1000000, timers = [], tid = 0;
  const reply = (method, p, body) => {
    calls.req.push({ method, p, body: body === undefined ? undefined : J(body) });
    const h = handlers[method + ' ' + p] || handlers[p];
    if (!h) return Promise.reject(new Error('HTTP 404'));
    try {
      const v = typeof h === 'function' ? h(body, calls) : h;
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(J(v));
    } catch (e) { return Promise.reject(e); }
  };
  const els = {};
  const ctx = {
    LANG: opts.lang || 'en', T: null,
    ic: (n) => `<i data-ic="${n}"></i>`,
    featOn: (k) => (k === 'production' ? opts.production !== false : true),
    searchBox: (inner) => inner, searchClearShow: () => {},
    prodLowThreshold: () => 5,
    CUR: '¥', DB: { products: [] }, SUBS: {}, CMD: {},
    state: { stack: [], ask: null, focus: null, productSku: null, oosSku: null, prodBusy: false,
      caps: opts.caps === undefined ? ALL : opts.caps, pos: opts.pos || 'owner' },
    render: () => { calls.renders++; },
    showToast: (m) => calls.toasts.push(String(m)),
    forgetScroll: () => {},
    api: (p) => reply('GET', p).then((j) => ((j && j.data !== undefined) ? j.data : j)),
    apiRaw: (p) => reply('GET', p),
    apiWrite: (p, b, m) => reply(m || 'POST', p, b).catch((e) => {
      // apiWrite's own shape: the server's message, its error code, its body.
      if (e && e.body) { const x = new Error(e.body.message || e.body.error); x.code = e.body.error; x.body = e.body; throw x; }
      throw e;
    }),
    document: { getElementById: (id) => els[id] || null },
    setTimeout: (fn, ms) => { const id = ++tid; timers.push({ id, fn, at: clock + (ms || 0) }); return id; },
    clearTimeout: (id) => { timers = timers.filter((t) => t.id !== id); },
    Map, Set, Number, String, Array, Object, JSON, Math, Promise, Error, RegExp, encodeURIComponent,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : zh);
  ctx.reg = (n, f) => { ctx.CMD[n] = f; };
  vm.createContext(ctx);
  vm.runInContext(HELPERS, ctx);
  vm.runInContext(GATES, ctx);
  vm.runInContext('state.pc=({' + PC_LIT + '}).pc;', ctx);
  vm.runInContext(`push=function(route){ const s=SUBS[route]; if(!s||!canRoute(route)) return; ${PC_RESET} state.stack.push({route:route}); render(); };`, ctx);
  vm.runInContext(POP, ctx);
  vm.runInContext(MAP, ctx);
  vm.runInContext(BLOCK, ctx);
  // The recipe screen's own opener, recorded rather than run.
  ctx.CMD.rcpOpen = (id) => { calls.opened.push(id); ctx.state.stack.push({ route: 'recipeone', rid: id }); };
  const advance = async (ms) => {
    const until = clock + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > until) break;
      timers.shift(); clock = t.at; t.fn(); await flushMicro();
    }
    clock = until; await flushMicro();
  };
  const writes = () => calls.req.filter((r) => r.method !== 'GET');
  const gets = () => calls.req.filter((r) => r.method === 'GET').map((r) => r.p);
  const screen = () => ctx.SUBS.productcost.render();
  const el = (id) => (els[id] = els[id] || { textContent: '', innerHTML: '', style: {}, disabled: false });
  return { ctx, calls, advance, writes, gets, screen, els, el };
}

// ── The product as the catalogue hands it over ─────────────────────────────
const ROW = { id: 41, sku: '1-225', name_en: 'Zhoug 200 g', name_cn: '青酱 200克', sell_price: 20, unit_cost: 8.5,
  size: '200g', is_published: 1, stock_qty: 12, recipe_id: 80, recipe_name_en: 'Zhoug', recipe_name_cn: '青酱', is_bundle: false };
function seed(t, row = ROW) {
  const p = vm.runInContext('mapProduct', t.ctx)(J(row));
  t.ctx.DB.products = [p];
  return p;
}
const LINES = [
  { id: 1, ingredient_id: 500, name_en: 'Zhoug (made)', name_cn: '青酱(自制)', sku: 'M-80', qty: 200, unit: 'g', notes: null,
    sort_order: 0, packed_separately: 0, material_item_kind: 'food', material_cost_per_unit: 0.04, material_buy_price: null,
    material_unit: 'g', material_free_by_design: 0, material_is_active: 1 },
  { id: 2, ingredient_id: 600, name_en: 'Tub 200 ml', name_cn: '200毫升杯', sku: 'P-1', qty: 1, unit: 'pcs', notes: null,
    sort_order: 1, packed_separately: 0, material_item_kind: 'packaging', material_cost_per_unit: 0.45, material_buy_price: 0.45,
    material_unit: 'pcs', material_free_by_design: 0, material_is_active: 1 },
];
const BL = '/api/retail-admin/products/41/build-lines';
const HEALTH = '/api/retail-admin/products/41/recipe-health';
const LINK = '/api/retail-admin/products/41/recipe-link';
function h(extra = {}) {
  return Object.assign({
    ['GET ' + BL]: { success: true, data: { product_id: 41, lines: LINES, cost: null, recipe: { state: 'none' } } },
    ['GET ' + HEALTH]: { success: true, data: null },
  }, extra);
}
async function open(t) {
  t.ctx.CMD.pcOpen('SKU 1-225');
  t.screen();               // the first draw asks for the list
  await flushMicro();
  return t.screen();
}
const noMoney = (html) => !/¥/.test(html);

// ════════════════════════════════════════════════════════════════════════════
section('1 · In from the product sheet, and back to it');
// ════════════════════════════════════════════════════════════════════════════
it('the sheet carries a Cost & Pricing row for a saved product — and the sheet really draws it', () => {
  const t = mk();
  const p = seed(t);
  const row = t.ctx.pcEntryRow(p);
  assert.match(row, /Cost &amp; Pricing|Cost & Pricing/);
  assert.match(row, /APP\.cmd\('pcOpen','SKU 1-225'\)/);
  assert.strictEqual(t.ctx.pcEntryRow(Object.assign({}, p, { _id: null })), '', 'a sample product has no row to open');
  assert.match(between(M, 'function sheetProduct(){', 'function fbBubble('), /\$\{oosCard\(p\)\}\s*\$\{pcEntryRow\(p\)\}/);
  t.ctx.LANG = 'zh';
  assert.match(t.ctx.pcEntryRow(p), /成本与定价/, 'the desktop tab’s own pair');
});
it('…and not for someone who may not open the catalogue', () => {
  const t = mk({ caps: ['orders:view'] });
  assert.strictEqual(t.ctx.pcEntryRow(seed(t)), '');
});
it('opening closes the sheet, stacks the screen with its product, and reads the build list', async () => {
  const t = mk({ handlers: h() });
  seed(t);
  t.ctx.state.productSku = 'SKU 1-225';
  const html = await open(t);
  assert.strictEqual(t.ctx.state.productSku, null, 'the sheet is down');
  const f = t.ctx.state.stack[t.ctx.state.stack.length - 1];
  assert.strictEqual(f.route, 'productcost'); assert.strictEqual(f.pid, 41); assert.strictEqual(f.sku, 'SKU 1-225');
  assert.ok(t.gets().includes(BL), 'GET /products/:id/build-lines');
  assert.match(html, /Zhoug \(made\)/); assert.match(html, /Tub 200 ml/);
  assert.strictEqual(t.ctx.SUBS.productcost.titleOf(), 'Zhoug 200 g');
});
it('Back hands the operator back to the sheet they came from', async () => {
  const t = mk({ handlers: h() });
  seed(t);
  await open(t);
  t.ctx.pop();
  assert.strictEqual(t.ctx.state.stack.length, 0);
  assert.strictEqual(t.ctx.state.productSku, 'SKU 1-225');
});
it('loading, then a failed read that says so, offers the read again, and draws no editing', async () => {
  let fail = true;
  const t = mk({ handlers: h({ ['GET ' + BL]: () => (fail ? new Error('HTTP 500')
    : { success: true, data: { lines: [], recipe: { state: 'none' } } }) }) });
  seed(t);
  t.ctx.CMD.pcOpen('SKU 1-225');
  assert.match(t.screen(), /Loading…/);
  await flushMicro();
  const html = t.screen();
  assert.match(html, /Could not load this\./); assert.match(html, /pcRetry/);
  assert.ok(!/mPcSave|mPcQ|No materials yet/.test(html), 'a failed read is NOT an empty list — no Save to write one over it');
  fail = false;
  t.ctx.CMD.pcRetry(); await flushMicro();
  assert.strictEqual(t.gets().filter((p) => p === BL).length, 2);
  assert.match(t.screen(), /No materials yet/);
});
it('an empty list says so, the picker is under it, and Save waits for a change', async () => {
  const t = mk({ handlers: h({ ['GET ' + BL]: { success: true, data: { lines: [], recipe: { state: 'none' } } } }) });
  seed(t);
  const html = await open(t);
  assert.match(html, /No materials yet/);
  assert.match(html, /id="mPcQ"/); assert.match(html, /Search materials to add…/);
  assert.match(html, /id="mPcSave" class="cta" disabled/);
});

// ════════════════════════════════════════════════════════════════════════════
section('2 · Money, failing closed');
// ════════════════════════════════════════════════════════════════════════════
it('with every key: the product’s cost, each line’s rate and cost, the figures and the margin', async () => {
  const t = mk({ handlers: h() });
  seed(t);
  const html = await open(t);
  assert.match(html, /¥8\.50/, 'the stored cost');
  assert.match(html, /¥0\.0400\/g/, 'a line’s rate, with its places');
  assert.match(html, /id="mPcLc-0"[^>]*>¥8</, 'a line’s cost: 200 g × ¥0.04');
  assert.match(html, /id="mPcTot"[^>]*>¥8\.45</, 'contents + tub');
  assert.match(html, /id="mPcMargin"[^>]*>57\.8%</, '(20 − 8.45) / 20');
});
it('products:costs without materials:costs: the product’s figures, but no material’s price and no “no cost” mark', async () => {
  const t = mk({ handlers: h(), caps: ALL.filter((k) => k !== 'materials:costs') });
  seed(t);
  const html = await open(t);
  assert.match(html, /id="mPcTot"/);
  assert.ok(!/mPcLc-|\/g<|no cost/.test(html), 'no rate, no line cost, no mark');
});
it('…and as the server now answers that reader (§300 R7: no rates), the figure is the server’s for the saved list', async () => {
  // The payload lib/product-build-cost-visibility.js sends a products:costs
  // holder without materials:costs: no rate on any line, the total kept.
  const V = require('../lib/product-build-cost-visibility.js');
  const req = { caps: new Set(ALL.filter((k) => k !== 'materials:costs')) };
  const full = { product_id: 41, name_en: 'Zhoug 200 g', unit_cost: 8.5, lines: J(LINES),
    cost: { hasBuildList: true, unitCost: 8.45, ingredientCost: 8.45, ingredientLines: 2, zeroCostLines: 0,
      unreconciledUnitLines: 0, packagingOnly: false, lines: [] }, recipe: { state: 'none' } };
  const sent = V.stripBuildPayload(req, full);
  assert.ok(!('material_cost_per_unit' in sent.lines[0]), 'the fixture really is the stripped shape');
  const t = mk({ handlers: h({ ['GET ' + BL]: { success: true, data: sent } }), caps: [...req.caps] });
  seed(t);
  const html = await open(t);
  assert.match(html, /id="mPcTot"[^>]*>¥8\.45</, 'the server’s total, not a sum of rates it no longer has');
  assert.match(html, /id="mPcMargin"[^>]*>57\.8%</);
  assert.ok(!/mPcSubM|has no unit cost|no cost/.test(html), 'no subtotals it cannot make, no false “no unit cost”');
  const tot = t.el('mPcTot'), mg = t.el('mPcMargin');
  t.ctx.CMD.pcQty(0, '100');
  assert.strictEqual(tot.textContent, '—', 'an edit in hand has no figure until it is saved');
  assert.strictEqual(mg.textContent, '—');
});
it('without products:costs: no cost block, no link, no figures — and the recipe’s health is never asked', async () => {
  const t = mk({ handlers: h(), caps: ALL.filter((k) => k !== 'products:costs') });
  seed(t);
  const html = await open(t);
  assert.ok(noMoney(html), 'no ¥ anywhere');
  assert.ok(!/From recipe|Link a recipe|Unlink|Margin|mPcTot/.test(html));
  assert.ok(!t.gets().includes(HEALTH));
  assert.match(html, /Zhoug \(made\)/, 'the list itself is still there to read');
});
it('while the caps are still loading, nothing with money is drawn', async () => {
  const t = mk({ handlers: h(), caps: null });
  seed(t);
  const html = await open(t);
  assert.ok(noMoney(html));
  assert.ok(!/From recipe|Link a recipe|mPcTot|mPcMargin/.test(html), 'no cost block, no figures');
  assert.ok(!t.gets().includes(HEALTH));
});
it('a board that never sees money sees none, whatever its caps say', async () => {
  const t = mk({ handlers: h(), pos: 'warehouse' });
  seed(t);
  const html = await open(t);
  assert.ok(noMoney(html));
  assert.ok(!/Link a recipe|Change|Unlink/.test(html));
});
it('a stripped payload draws a dash for the cost, never ¥0', async () => {
  const t = mk({ handlers: h() });
  const row = J(ROW); delete row.unit_cost;
  const p = seed(t, row);
  assert.strictEqual(p.unitCost, undefined, 'mapProduct keeps absent absent');
  const html = await open(t);
  assert.match(html, /class="eyebrow">Cost<\/span><span class="num"[^>]*>—</);
  assert.ok(!/¥0</.test(html));
});

// ════════════════════════════════════════════════════════════════════════════
section('3 · Where the cost comes from — pdApplyCostSource');
// ════════════════════════════════════════════════════════════════════════════
const EMPTY = { success: true, data: { lines: [], recipe: { state: 'unbuilt', recipe_id: 80, name_en: 'Zhoug', name_cn: '青酱', material: null } } };
it('a recipe owns it: From recipe, its name opening the recipe, Change and Unlink', async () => {
  const t = mk({ handlers: h({ ['GET ' + BL]: EMPTY }) });
  seed(t);
  const html = await open(t);
  assert.match(html, /From recipe<\/span><button onclick="APP\.cmd\('pcOpenRecipe',80\)"/);
  assert.match(html, /pcLinkOpen'\)">Change</); assert.match(html, /pcUnlinkAsk'\)">Unlink</);
  t.ctx.CMD.pcOpenRecipe(80);
  assert.deepStrictEqual(J(t.calls.opened), [80]);
  assert.strictEqual(t.ctx.state.pc.stale, true, 'coming back reads the list again');
});
it('the recipe’s warnings, in the recipe screen’s own words — UNIT MISMATCH copied', async () => {
  const t = mk({ handlers: h({ ['GET ' + BL]: EMPTY,
    ['GET ' + HEALTH]: { success: true, data: { recipe_id: 80, recipe_active: false, missing: 2, unreconciled: 1, cost_per_serving: null } } }) });
  seed(t);
  await open(t); await flushMicro();
  const html = t.screen();
  assert.ok(t.gets().includes(HEALTH));
  assert.match(html, /This recipe is archived — frozen at its last computed value\./);
  assert.match(html, /2 ingredients missing cost — costs shown are too low/);
  assert.match(html, /<b style="font-weight:600">UNIT MISMATCH<\/b> — 1 ingredient in this recipe is counted in a unit/);
  assert.match(html, /This recipe has no cost yet — it needs servings, a batch size, and a price on every ingredient\./);
  // Word for word against the desktop's pdRecipeHealthPaint.
  const desk = between(DPROD, 'function pdRecipeHealthPaint(id) {', 'function pdCostPill(');
  for (const s of ['This recipe is archived — frozen at its last computed value.', ' ingredient', ' missing cost — costs shown are too low',
    'UNIT MISMATCH', '单位不符', '该配方已归档。已冻结为最近一次计算的值。', ' 项原料缺少成本 — 显示成本偏低', '无法加载配方']) {
    assert.ok(desk.includes(s) && BLOCK.includes(s), 'copied: ' + s);
  }
});
it('a health check that could not run says so rather than falling silent', async () => {
  const t = mk({ handlers: h({ ['GET ' + BL]: EMPTY, ['GET ' + HEALTH]: new Error('HTTP 500') }) });
  seed(t);
  await open(t); await flushMicro();
  assert.match(t.screen(), /Couldn’t load the recipe/);
});
it('with a build list, the recipe is its own row — Recipe, name, Change, Unlink — and not the source of the cost', async () => {
  const t = mk({ handlers: h() });
  seed(t);
  const html = await open(t);
  assert.ok(!/From recipe/.test(html));
  assert.match(html, />Recipe<\/span><button onclick="APP\.cmd\('pcOpenRecipe',80\)"/);
  assert.match(html, />Change</); assert.match(html, />Unlink</);
});
it('a bundle is added up from what is inside, and asks no recipe for a warning', async () => {
  const t = mk({ handlers: h({ ['GET ' + BL]: EMPTY }) });
  seed(t, Object.assign(J(ROW), { is_bundle: true }));
  const html = await open(t);
  assert.match(html, /Added up from what’s inside/);
  assert.ok(!/From recipe|Link a recipe/.test(html));
  assert.ok(!t.gets().includes(HEALTH));
});
it('unlinked: Link a recipe with Production on, nothing with it off', async () => {
  const row = Object.assign(J(ROW), { recipe_id: null, recipe_name_en: null, recipe_name_cn: null });
  const on = mk({ handlers: h({ ['GET ' + BL]: EMPTY }) }); seed(on, row);
  assert.match(await open(on), /pcLinkOpen'\)">Link a recipe</);
  const off = mk({ handlers: h({ ['GET ' + BL]: EMPTY }), production: false }); seed(off, row);
  assert.ok(!/Link a recipe/.test(await open(off)));
  assert.strictEqual(off.ctx.canRoute('productrecipe'), false);
});
it('each button only for the key the server checks: Change products:edit, Unlink products:delete', async () => {
  const noDel = mk({ handlers: h({ ['GET ' + BL]: EMPTY }), caps: ALL.filter((k) => k !== 'products:delete') });
  seed(noDel);
  const a = await open(noDel);
  assert.match(a, />Change</); assert.ok(!/>Unlink</.test(a), 'DELETE /recipe-link is products:delete in lib/cap-routes.js');
  const noEdit = mk({ handlers: h({ ['GET ' + BL]: EMPTY }), caps: ALL.filter((k) => k !== 'products:edit') });
  seed(noEdit);
  const b = await open(noEdit);
  assert.ok(!/>Change</.test(b)); assert.match(b, />Unlink</);
  assert.strictEqual(noEdit.ctx.canRoute('productrecipe'), false);
  // The server's own mapping, read rather than remembered.
  const { requiredCapFor } = require('../lib/cap-routes.js');
  assert.strictEqual(requiredCapFor('DELETE', LINK), 'products:delete');
  assert.strictEqual(requiredCapFor('PUT', LINK), 'products:edit');
  assert.strictEqual(requiredCapFor('PUT', BL), 'products:edit');
});

// ════════════════════════════════════════════════════════════════════════════
section('4 · Link and Change — pdRecipeLinkOpen');
// ════════════════════════════════════════════════════════════════════════════
const RECIPES = [
  { id: 80, name_en: 'Zhoug', name_cn: '青酱', sku: '1-225', costPerServing: 8.5 },
  { id: 81, name_en: 'Zhoug (spicy)', name_cn: '辣青酱', sku: '1-225S', costPerServing: 9.1 },
  { id: 82, name_en: 'Zhoug base', name_cn: '青酱底', sku: '1-225B', costPerServing: null },
];
it('opens prefilled with the product’s own SKU, searches at once, and leaves out the recipe already linked', async () => {
  const t = mk({ handlers: h({ ['GET ' + BL]: EMPTY, 'GET /api/retail-admin/recipes?search=1-225': { success: true, data: RECIPES } }) });
  seed(t);
  await open(t);
  t.ctx.CMD.pcLinkOpen();
  assert.strictEqual(t.ctx.state.stack[t.ctx.state.stack.length - 1].route, 'productrecipe');
  assert.strictEqual(t.ctx.state.pc.link.q, '1-225', 'the stored SKU, not the “SKU …” label');
  assert.match(t.ctx.SUBS.productrecipe.render(), /Searching…/);
  await flushMicro();
  const html = t.ctx.SUBS.productrecipe.render();
  assert.ok(t.gets().includes('/api/retail-admin/recipes?search=1-225'));
  assert.ok(!/pcLinkPick',80\)/.test(html), 'the linked recipe is not a candidate');
  assert.match(html, /pcLinkPick',81\)/); assert.match(html, /¥9\.10/); assert.match(html, /no cost yet/);
  assert.match(html, /id="mPcLinkGo" class="cta" disabled/); assert.match(html, /Pick a recipe to link\./);
});
it('a recipe’s cost is drawn only with recipes:costs — and its “no cost yet” warning with it', async () => {
  const t = mk({ handlers: h({ ['GET ' + BL]: EMPTY, 'GET /api/retail-admin/recipes?search=1-225': { success: true, data: RECIPES } }),
    caps: ALL.filter((k) => k !== 'recipes:costs') });
  seed(t);
  await open(t);
  t.ctx.CMD.pcLinkOpen(); await flushMicro();
  t.ctx.CMD.pcLinkPick(82);
  const html = t.ctx.SUBS.productrecipe.render();
  assert.ok(noMoney(html)); assert.ok(!/no cost yet|has no cost yet/.test(html));
});
it('Link sends PUT /recipe-link {recipe_id} and nothing else, folds the answer in, and passes the server’s warning on verbatim', async () => {
  const warning = 'Linked, but "Zhoug base" has no cost yet — it needs servings, a batch size, and a price on every ingredient.';
  let linked = false;
  const t = mk({ handlers: h({
    ['GET ' + BL]: () => (linked ? { success: true, data: { lines: [], recipe: { state: 'ready', recipe_id: 82, material: { id: 700, name_en: 'Zhoug base (made)', unit: 'g' } } } } : EMPTY),
    'GET /api/retail-admin/recipes?search=1-225': { success: true, data: RECIPES },
    ['PUT ' + LINK]: () => { linked = true; return { success: true, data: { id: 41, recipe_id: 82, unit_cost: 8.5, recipe_name_en: 'Zhoug base', recipe_name_cn: '青酱底' }, warning }; },
  }) });
  const p = seed(t);
  await open(t);
  t.ctx.CMD.pcLinkOpen(); await flushMicro();
  t.ctx.CMD.pcLinkPick(82);
  let html = t.ctx.SUBS.productrecipe.render();
  assert.match(html, /Selected: <b[^>]*>Zhoug base<\/b>/);
  assert.match(html, /The link is saved either way/);
  assert.match(html, /id="mPcLinkGo" class="cta"\s+onclick/, 'enabled once picked');
  t.ctx.CMD.pcLinkGo();
  assert.match(t.ctx.SUBS.productrecipe.render(), /Saving…/, 'the control says what it is doing');
  t.ctx.CMD.pcLinkGo();
  await flushMicro();
  const w = t.writes();
  assert.strictEqual(w.length, 1, 'one write, however many taps');
  assert.deepStrictEqual(w[0], { method: 'PUT', p: LINK, body: { recipe_id: 82 } });
  assert.strictEqual(t.ctx.state.stack[t.ctx.state.stack.length - 1].route, 'productcost', 'back on the product');
  assert.strictEqual(p.recipeId, 82); assert.strictEqual(p.recipeName.join('|'), 'Zhoug base|青酱底');
  assert.deepStrictEqual(t.calls.toasts, [warning]);
  await flushMicro();
  html = t.screen();
  assert.match(html, /Zhoug base \(made\)/, 'the list is read again — the bridge answers from the link');
});
it('a refusal is said on the screen and stays; nothing moves', async () => {
  const t = mk({ handlers: h({ ['GET ' + BL]: EMPTY,
    'GET /api/retail-admin/recipes?search=1-225': { success: true, data: RECIPES },
    ['PUT ' + LINK]: () => { const e = new Error('x'); e.body = { success: false, error: 'recipe_archived', message: '"Zhoug (spicy)" is archived. Restore it first, or pick a live recipe.' }; return e; },
  }) });
  const p = seed(t);
  await open(t);
  t.ctx.CMD.pcLinkOpen(); await flushMicro();
  t.ctx.CMD.pcLinkPick(81); t.ctx.CMD.pcLinkGo(); await flushMicro();
  const html = t.ctx.SUBS.productrecipe.render();
  assert.match(html, /Could not link: &quot;Zhoug \(spicy\)&quot; is archived\./);
  assert.match(html, /id="mPcLinkGo" class="cta"\s+onclick/, 'ready to try again');
  assert.strictEqual(t.ctx.state.stack[t.ctx.state.stack.length - 1].route, 'productrecipe');
  assert.strictEqual(p.recipeId, 80); assert.deepStrictEqual(t.calls.toasts, []);
});
it('the picker’s words are the desktop modal’s, copied', () => {
  const desk = between(DPROD, 'async function pdRecipeLinkOpen() {', 'function pdRecipeLinkApplied(');
  for (const s of ['Link a recipe', '关联配方', 'The cost of this product is then worked out from the recipe, and updates whenever the recipe does.',
    '关联后，本产品的成本将由该配方计算得出，并随配方更新。', 'Search recipes', '搜索配方', 'Name or SKU…', '名称或货号…',
    'No recipe matches that.', '没有匹配的配方。', 'no cost yet', '暂无成本', 'Pick a recipe to link.', '请选择要关联的配方。',
    'Cost now comes from the recipe', '成本已改为来自配方', 'Could not link', '关联失败', 'Selected: ', '已选择：']) {
    assert.ok(desk.includes(s), 'desktop has: ' + s);
    assert.ok(BLOCK.includes(s), 'phone has: ' + s);
  }
});

// ════════════════════════════════════════════════════════════════════════════
section('5 · Unlink — pdRecipeUnlink');
// ════════════════════════════════════════════════════════════════════════════
it('asks in the desktop’s words, then DELETE /recipe-link, and the product lets go of the recipe', async () => {
  const t = mk({ handlers: h({ ['GET ' + BL]: EMPTY,
    ['DELETE ' + LINK]: { success: true, data: { id: 41, recipe_id: null, unit_cost: 8.5, recipe_name_en: null, recipe_name_cn: null } } }) });
  const p = seed(t);
  await open(t);
  t.ctx.CMD.pcUnlinkAsk();
  const a = t.ctx.state.ask;
  const desk = between(DPROD, 'async function pdRecipeUnlink() {', 'function paOpenRecipe(');
  for (const s of [a.title, a.body, a.confirmLabel]) assert.ok(desk.includes(s), 'the desktop’s own words: ' + s);
  assert.strictEqual(a.danger, true);
  assert.strictEqual(t.writes().length, 0, 'nothing before the confirm');
  a.run();
  assert.match(t.screen(), /Saving…/);
  await flushMicro();
  assert.deepStrictEqual(t.writes(), [{ method: 'DELETE', p: LINK, body: {} }]);
  assert.strictEqual(p.recipeId, null);
  assert.deepStrictEqual(t.calls.toasts, ['Unlinked']);
  await flushMicro();
  assert.match(t.screen(), /Link a recipe/);
});
it('a failed unlink is said on the screen and stays', async () => {
  const t = mk({ handlers: h({ ['GET ' + BL]: EMPTY, ['DELETE ' + LINK]: new Error('HTTP 500') }) });
  const p = seed(t);
  await open(t);
  t.ctx.CMD.pcUnlinkAsk(); t.ctx.state.ask.run(); await flushMicro();
  const html = t.screen();
  assert.match(html, /Could not unlink: HTTP 500/);
  assert.strictEqual(p.recipeId, 80); assert.deepStrictEqual(t.calls.toasts, []);
  assert.match(html, /pcUnlinkAsk'\)">Unlink</, 'and can be tried again');
});

// ════════════════════════════════════════════════════════════════════════════
section('6 · The build list — 21-product-build.js');
// ════════════════════════════════════════════════════════════════════════════
const DESK_KEYS = between(DBUILD, '_blLines.map(l => ({', '})),')
  .match(/[a-z_]+(?=:)/g);
it('grouped as the desktop groups it — Materials, then Packaging', async () => {
  const t = mk({ handlers: h() });
  seed(t);
  const html = await open(t);
  const a = html.indexOf('>Materials</div>'), b = html.indexOf('>Packaging</div>');
  assert.ok(a !== -1 && b > a, 'both groups, in order');
  assert.ok(html.indexOf('Zhoug (made)') > a && html.indexOf('Zhoug (made)') < b);
  assert.ok(html.indexOf('Tub 200 ml') > b);
  assert.match(html, /Not counted as waste if it expires or spoils/, 'the contents line carries the §281 tick');
});
it('typing a quantity moves the money and the Save button in place — no repaint to take the keyboard', async () => {
  const t = mk({ handlers: h() });
  seed(t);
  await open(t);
  const lc = t.el('mPcLc-0'), tot = t.el('mPcTot'), mg = t.el('mPcMargin'), save = t.el('mPcSave');
  save.disabled = true;
  const before = t.calls.renders;
  t.ctx.CMD.pcQty(0, '100');
  assert.strictEqual(t.calls.renders, before, 'no render');
  assert.strictEqual(lc.textContent, '¥4'); assert.strictEqual(tot.textContent, '¥4.45');
  assert.strictEqual(mg.textContent, '77.8%'); assert.strictEqual(save.disabled, false);
  assert.strictEqual(t.ctx.state.pc.dirty, true);
});
it('Save sends blSave()’s body, key for key, in the list’s order — and writes no cost', async () => {
  const t = mk({ handlers: h({ ['PUT ' + BL]: { success: true, data: { id: 41, unit_cost: 7.2 } } }) });
  const p = seed(t);
  await open(t);
  t.ctx.CMD.pcQty(0, '180');
  t.ctx.CMD.pcUnit(1, 'box');
  t.ctx.CMD.pcKept(0);
  t.ctx.CMD.pcSave();
  assert.match(t.screen(), /id="mPcSave" class="cta" disabled[^>]*>Saving…/, 'the control disables and says so');
  t.ctx.CMD.pcSave();
  await flushMicro();
  const w = t.writes();
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].method, 'PUT'); assert.strictEqual(w[0].p, BL);
  assert.deepStrictEqual(Object.keys(w[0].body), ['lines']);
  assert.deepStrictEqual(Object.keys(w[0].body.lines[0]), DESK_KEYS, 'the desktop’s keys: ' + DESK_KEYS.join(','));
  assert.deepStrictEqual(w[0].body.lines.map((l) => [l.ingredient_id, l.qty, l.unit, l.packed_separately]),
    [[500, 180, 'g', true], [600, 1, 'box', false]]);
  assert.ok(!JSON.stringify(w[0].body).match(/cost|unit_cost|buy_price/), 'no cost field reaches the wire');
  assert.deepStrictEqual(t.calls.toasts, ['Build list saved']);
  assert.strictEqual(t.gets().filter((x) => x === BL).length, 2, 'read again — the server’s figures, not this screen’s sum');
  assert.strictEqual(p.unitCost, 7.2);
  assert.strictEqual(t.ctx.state.pc.dirty, false);
});
it('without products:costs the saved figure is not taken in, even when the server sends one', async () => {
  const t = mk({ handlers: h({ ['PUT ' + BL]: { success: true, data: { id: 41, unit_cost: 7.2 } } }),
    caps: ALL.filter((k) => k !== 'products:costs') });
  const row = J(ROW); delete row.unit_cost;
  const p = seed(t, row);
  await open(t);
  t.ctx.CMD.pcQty(0, '150'); t.ctx.CMD.pcSave(); await flushMicro();
  assert.strictEqual(t.writes().length, 1);
  assert.strictEqual(p.unitCost, undefined);
});
it('a quantity of zero is refused before the wire, on the screen, naming the line', async () => {
  const t = mk({ handlers: h() });
  seed(t);
  await open(t);
  t.ctx.CMD.pcQty(1, '0');
  t.ctx.CMD.pcSave();
  assert.strictEqual(t.writes().length, 0);
  assert.match(t.screen(), /“Tub 200 ml” needs a quantity greater than zero\./);
  t.ctx.LANG = 'zh';
  assert.match(t.screen(), /“200毫升杯”的数量必须大于 0。/);
});
it('a failed save is said where the operator is looking and stays; the list is kept to try again', async () => {
  const t = mk({ handlers: h({ ['PUT ' + BL]: new Error('HTTP 500') }) });
  seed(t);
  await open(t);
  t.ctx.CMD.pcRm(1);
  t.ctx.CMD.pcSave(); await flushMicro();
  const html = t.screen();
  assert.match(html, /That did not save\. Nothing has changed — try again\./);
  assert.strictEqual(t.ctx.state.pc.dirty, true); assert.strictEqual(t.ctx.state.pc.lines.length, 1);
  assert.deepStrictEqual(t.calls.toasts, []);
  assert.match(html, /id="mPcSave" class="cta"\s+onclick/);
});
it('the picker: the build list’s own endpoint, what is on the list drops out, packaging opens at one', async () => {
  const MATS = [{ id: 600, name_en: 'Tub 200 ml', unit: 'pcs', item_kind: 'packaging', cost_per_unit: 0.45 },
    { id: 601, name_en: 'Lid label', name_cn: '盖标', unit: 'pcs', item_kind: 'packaging', cost_per_unit: 0.08 },
    { id: 700, name_en: 'Zhoug base (made)', unit: 'g', item_kind: 'food', cost_per_unit: 0, source_recipe_id: 82 }];
  const t = mk({ handlers: h({ 'GET /api/retail-admin/product-build/materials?search=l': { success: true, data: MATS, matched: 34 } }) });
  seed(t);
  await open(t);
  const res = t.el('mPcPick');
  t.ctx.CMD.pcPickQ('l');
  assert.match(res.innerHTML, /Searching…/);
  await t.advance(220);
  assert.ok(t.gets().includes('/api/retail-admin/product-build/materials?search=l'), 'never for_recipe=1: packaging belongs here');
  assert.ok(!/pcPickAdd',600\)/.test(res.innerHTML), 'already on the list');
  assert.match(res.innerHTML, /pcPickAdd',601\)/);
  assert.match(res.innerHTML, /2 \/ 34/, 'a count of what matched, in numerals');
  assert.match(res.innerHTML, /from recipe/, 'a recipe’s stand-in is labelled');
  t.ctx.CMD.pcPickAdd(601);
  const l = t.ctx.state.pc.lines[2];
  assert.strictEqual(l.ingredient_id, 601); assert.strictEqual(l.qty, 1); assert.strictEqual(l.unit, 'pcs');
  assert.strictEqual(t.ctx.state.pc.q, ''); assert.strictEqual(t.ctx.state.pc.dirty, true);
});
it('a first contents line opens at the product’s net weight, says where it came from, and only the first', async () => {
  const MATS = [{ id: 700, name_en: 'Zhoug base (made)', unit: 'g', item_kind: 'food', cost_per_unit: 0.03 },
    { id: 701, name_en: 'Olive oil', unit: 'ml', item_kind: 'food', cost_per_unit: 0.05 },
    { id: 702, name_en: 'Chilli', unit: 'g', item_kind: 'food', cost_per_unit: 0.02 }];
  const t = mk({ handlers: h({ ['GET ' + BL]: { success: true, data: { lines: [LINES[1]], recipe: { state: 'none' } } },
    'GET /api/retail-admin/product-build/materials?search=z': { success: true, data: MATS, matched: 3 } }) });
  seed(t);
  await open(t);
  t.ctx.CMD.pcPickQ('z'); await t.advance(220);
  t.ctx.CMD.pcPickAdd(700);
  const l = t.ctx.state.pc.lines[1];
  assert.strictEqual(l.qty, 200); assert.strictEqual(l.qty_from_weight, '200g');
  assert.match(t.screen(), /from the product’s net weight \(200g\)/);
  t.ctx.CMD.pcPickQ('z'); await t.advance(220);
  t.ctx.CMD.pcPickAdd(702);
  assert.strictEqual(t.ctx.state.pc.lines[2].qty, 0, 'a second contents line is the operator’s to measure');
  t.ctx.CMD.pcQty(1, '180');
  assert.strictEqual(t.ctx.state.pc.lines[1].qty_from_weight, null, 'typed over, the note is no longer true');
});
it('no match, and a search that failed, are two different sentences', async () => {
  const t = mk({ handlers: h({ 'GET /api/retail-admin/product-build/materials?search=zz': { success: true, data: [], matched: 0 },
    'GET /api/retail-admin/product-build/materials?search=x': new Error('HTTP 500') }) });
  seed(t);
  await open(t);
  const res = t.el('mPcPick');
  t.ctx.CMD.pcPickQ('zz'); await t.advance(220);
  assert.match(res.innerHTML, /No materials match/);
  t.ctx.CMD.pcPickQ('x'); await t.advance(220);
  assert.match(res.innerHTML, /Could not load materials/);
});
it('the recipe bridge: Add puts the recipe’s material on as contents; a repack at the recipe’s own quantity', async () => {
  const ready = mk({ handlers: h({ ['GET ' + BL]: { success: true, data: { lines: [LINES[1]],
    recipe: { state: 'ready', recipe_id: 80, material: { id: 500, name_en: 'Zhoug (made)', unit: 'g', item_kind: 'food', cost_per_unit: 0.04 } } } } }) });
  seed(ready);
  let html = await open(ready);
  assert.match(html, /Zhoug \(made\)[\s\S]*from recipe[\s\S]*pcAddRecipeMat'\)">Add</);
  ready.ctx.CMD.pcAddRecipeMat();
  const l = ready.ctx.state.pc.lines[1];
  assert.strictEqual(l.ingredient_id, 500); assert.strictEqual(l.qty, 200, 'the net weight, for a made material');
  html = ready.screen();
  assert.ok(!/pcAddRecipeMat/.test(html), 'gone once the list has contents');
  const repack = mk({ handlers: h({ ['GET ' + BL]: { success: true, data: { lines: [],
    recipe: { state: 'repack', recipe_id: 90, qty: 120, qty_unit: 'g', material: { id: 800, name_en: 'Turmeric (bulk)', unit: 'g', cost_per_unit: 0.1 } } } } }) });
  seed(repack);
  assert.match(await open(repack), /120 g<\/span> · from recipe/);
  repack.ctx.CMD.pcAddRecipeMat();
  assert.strictEqual(repack.ctx.state.pc.lines[0].qty, 120);
  assert.strictEqual(repack.ctx.state.pc.lines[0].qty_from_weight, null, 'the recipe’s number, not the weight text');
});
it('a recipe not yet a material says so and opens the recipe — the place the fix is', async () => {
  const t = mk({ handlers: h({ ['GET ' + BL]: EMPTY }) });
  seed(t);
  const html = await open(t);
  assert.match(html, /Not available as a material yet/);
  assert.match(html, /pcOpenRecipe',80\)">Open recipe</);
  const noRecipes = mk({ handlers: h({ ['GET ' + BL]: EMPTY }), caps: ALL.filter((k) => k !== 'recipes:view') });
  seed(noRecipes);
  assert.ok(!/Open recipe/.test(await open(noRecipes)), 'no door to a screen that will not open');
});
it('without products:edit it is read, not edited: no inputs, no picker, no Remove, no Add, no Save', async () => {
  const t = mk({ handlers: h(), caps: ALL.filter((k) => k !== 'products:edit') });
  seed(t);
  const html = await open(t);
  assert.ok(!/mPcQty-|mPcQ"|pcRm|pcAddRecipeMat|mPcSave|pcKept/.test(html));
  assert.match(html, /200 g/); assert.match(html, /1 pcs/);
  t.ctx.CMD.pcQty(0, '5'); t.ctx.CMD.pcRm(0);
  assert.strictEqual(t.ctx.state.pc.lines.length, 2); assert.strictEqual(t.ctx.state.pc.dirty, false);
});
it('an unsaved list asks before it is dropped — by Back and by the edge swipe — and a reload waits for it', async () => {
  const t = mk({ handlers: h() });
  seed(t);
  await open(t);
  t.ctx.CMD.pcQty(0, '150');
  t.ctx.pop();
  assert.strictEqual(t.ctx.state.stack.length, 1, 'still here');
  assert.strictEqual(t.ctx.state.ask.title, 'Leave without saving?');
  t.ctx.state.ask.run();
  assert.strictEqual(t.ctx.state.stack.length, 0);
  assert.strictEqual(t.ctx.state.productSku, 'SKU 1-225', 'back on the sheet');
  assert.strictEqual(t.ctx.state.pc.dirty, false);
  assert.strictEqual(t.writes().length, 0);
  const layers = between(M, 'function layers(){', '  // Order first, record second');
  assert.match(layers, /if\(t&&t\.route==='productcost'&&!pcMayLeave\(\)\) return;/);
  assert.match(layers, /if\(gone&&gone\.route==='productcost'\) pcPopped\(gone\);/);
  assert.match(between(M, 'function mUnsavedWork(){', 'let swPending'),
    /if\(state\.pc&&state\.pc\.dirty&&\(state\.stack\|\|\[\]\)\.some\(f=>f&&f\.route==='productcost'\)\) return true;/);
});
it('the blocked states: a line with no unit cost is named and the total is a dash; all-packaging has no cost', async () => {
  const unpriced = Object.assign({}, LINES[0], { material_cost_per_unit: 0 });
  const t = mk({ handlers: h({ ['GET ' + BL]: { success: true, data: { lines: [unpriced, LINES[1]], recipe: { state: 'none' } } } }) });
  seed(t);
  const html = await open(t);
  assert.match(html, /id="mPcTot"[^>]*>—</); assert.match(html, /id="mPcMargin"[^>]*>—</);
  assert.match(html, /“Zhoug \(made\)” has no unit cost\./);
  assert.match(html, /no cost/);
  const pk = mk({ handlers: h({ ['GET ' + BL]: { success: true, data: { lines: [LINES[1]], recipe: { state: 'none' } } } }) });
  seed(pk);
  assert.match(await open(pk), /Every line here is packaging\./);
});
it('Chinese throughout — the live pairs, and no English left behind on a line the screen draws', async () => {
  const t = mk({ handlers: h({ ['GET ' + BL]: EMPTY }), lang: 'zh' });
  seed(t);
  const html = await open(t);
  for (const s of ['来自配方', '更换', '取消关联', '暂无物料', '搜索要添加的物料…', '尚未设为可用物料', '打开配方', '成本', '毛利'])
    assert.ok(html.includes(s), 'has ' + s);
  assert.ok(!/From recipe|Change<|Unlink<|No materials yet|Open recipe/.test(html));
  assert.strictEqual(t.ctx.SUBS.productcost.status(), '成本与定价');
});

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
