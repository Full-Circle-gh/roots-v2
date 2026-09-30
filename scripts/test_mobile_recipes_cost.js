#!/usr/bin/env node
/**
 * §300 step R3 — what a recipe costs, on the phone, to exactly the people the
 * desktop shows it to.
 *
 *   node scripts/test_mobile_recipes_cost.js
 *
 * The list's cost and cost per gram, the record's summary strip (batch cost,
 * the per-unit cost, a single product's price and margin), each line's cost
 * and rate with "no cost", the Cost & Pricing tab and its breakdown, the margin
 * beside several products, the linked material's rate — and the cost inputs
 * written back through PUT /:id/cost exactly as the desktop writes them.
 *
 * FAILS CLOSED, and each way has a case: no `recipes:costs`; the caps still
 * loading (the app's own mCan, lifted, answers no — MCAN_MONEY_ONLY); a
 * warehouse / dispatch / customer-service board (recapNoMoney); and a cap list
 * that says yes over a payload the server stripped.
 *
 * The harness is test_mobile_recipes_edit.js's (the code RUN, a fake clock,
 * the real engine and cost module), with the real capability gate added.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
const DESK = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '19-recipes.js'), 'utf8');
const ENGINE = fs.readFileSync(path.join(ROOT, 'public', 'tacet-autosave.js'), 'utf8');
const RecipeCost = require('../lib/recipe-cost.js');

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

const REGION = between(M, 'const rcpNum = v =>', '/* ── Making one (§167)');
const HELPERS = [
  between(M, 'function E(en, zh){', '\n') + '\n',
  between(M, 'const PILL = {', 'function toggle(on, onClick){'),
  between(M, 'function toggle(on, onClick){', '\n/* ===='),
  between(M, 'function chipRow(items, current, cmd){', '/* The same row, for a filter'),
  between(M, 'const escAttr=v=>', '\n') + '\n',
  between(M, 'const money=(cur,n)=>', '\n// Whole yuan'),
  between(M, 'function tmOneLang(m){', '\n') + '\n',
  between(M, "const RECAP_NO_MONEY=", '\n') + '\n',
  between(M, 'function recapNoMoney(){', '\n') + '\n',
  between(M, 'function liveHistorySheet(list, sub, restore, opts){', "reg('adjustPoints'"),
].join('\n');
const RCP_LIT = between(M, '  rcp:{rows:null', 'scale:1,got:{},step:null}') + 'scale:1,got:{},step:null}';
const PUSH = between(M, 'function push(route){', 'function pop(){');
const RESETS = ['recipes', 'recipeone', 'recipemake'].map((r) => {
  const m = PUSH.match(new RegExp("  if\\(route==='" + r + "'\\)\\{[^\\n]*\\}\\n"));
  assert.ok(m, 'push() has no reset line for ' + r);
  return m[0];
}).join('');
// pop() as the app has it, minus the two unrelated screens' flushes.
const POP = between(M, 'function pop(){', '\nconst CMD={}')
  .replace(/\n  if\(top==='receive'\) recvFlush\(\);/, '')
  .replace(/\n  if\(top==='teamrole'&&tmAuto\) tmAuto\.flush\(\);/, '');

// The money keys that must never reach the wire from this screen, at any depth.
const MONEY_KEYS = ['labour', 'overhead_pct', 'sell_price', 'target_food_cost', 'packaging', 'packaging_type_id',
  'costData', 'cost', 'master_cost', 'cost_per_unit', 'unit_cost', 'batchCost', 'costPerServing', 'costPerGram'];
function keysDeep(o, out = new Set()) {
  if (Array.isArray(o)) o.forEach((x) => keysDeep(x, out));
  else if (o && typeof o === 'object') for (const k of Object.keys(o)) { out.add(k); keysDeep(o[k], out); }
  return out;
}

function mk(opts = {}) {
  const calls = { req: [], toasts: [], renders: 0 };
  const handlers = opts.handlers || {};
  let clock = 1000000;
  let timers = [];
  let tid = 0;
  const reply = (method, p, body) => {
    calls.req.push({ method, p, body: body === undefined ? undefined : J(body) });
    const h = handlers[method + ' ' + p] || handlers[p];
    if (!h) return Promise.reject(new Error('HTTP 404'));
    try { const v = typeof h === 'function' ? h(body, calls) : h; return v instanceof Error ? Promise.reject(v) : Promise.resolve(J(v)); }
    catch (e) { return Promise.reject(e); }
  };
  const els = {};
  const ctx = {
    LANG: opts.lang || 'en', T: null,
    ic: (n) => `<i data-ic="${n}"></i>`,
    featOn: () => true, flagGate: () => 'GATED',
    nothingYet: (t, m) => `<div class="nothing">${t}|${m}</div>`,
    desktopNote: () => '', noteBar: (t) => `<div class="notebar">${t}</div>`,
    searchBox: (inner) => inner, searchClearShow: () => {},
    tdWhen: (v) => 'WHEN(' + v + ')', _tdL: () => ({}),
    CUR: '¥', DB: { products: [] }, SUBS: {}, CMD: {},
    state: { stack: [], ask: null, focus: null },
    render: () => { calls.renders++; },
    showToast: (m) => calls.toasts.push(String(m)),
    forgetScroll: () => {},
    loadCatalogue: () => Promise.resolve(),
    api: (p) => reply('GET', p).then((j) => ((j && j.data !== undefined) ? j.data : j)),
    apiRaw: (p) => reply('GET', p),
    apiWrite: (p, b, m) => reply(m || 'POST', p, b),
    document: {
      getElementById: (id) => els[id] || null,
      createElement: () => ({}), body: { appendChild: () => {} },
      documentElement: { classList: { add() {}, remove() {} } },
      addEventListener: () => {}, visibilityState: 'visible',
    },
    window: { RootsRecipeCost: opts.noCostModule ? undefined : RecipeCost, print() {}, addEventListener() {} },
    setTimeout: (fn, ms) => { const id = ++tid; timers.push({ id, fn, at: clock + (ms || 0) }); return id; },
    clearTimeout: (id) => { timers = timers.filter((t) => t.id !== id); },
    setInterval: () => 0, clearInterval: () => {},
    Date: { now: () => clock },
    Map, Set, Number, String, Array, Object, JSON, Math, Promise, Error, RegExp, encodeURIComponent,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : zh);
  ctx.reg = (n, f) => { ctx.CMD[n] = f; };
  ctx.canRoute = () => true;
  vm.createContext(ctx);
  vm.runInContext(ENGINE, ctx);
  ctx.TacetAutosave = ctx.window.TacetAutosave;
  vm.runInContext(HELPERS, ctx);
  vm.runInContext('state.rcp=({' + RCP_LIT + '}).rcp;', ctx);
  vm.runInContext(`push=function(route){ if(!canRoute(route)) return; ${RESETS} state.stack.push({route:route}); render(); };`, ctx);
  vm.runInContext(POP, ctx);
  vm.runInContext(REGION, ctx);
  // The status line and the error card are real nodes once the screen is up.
  els.mHeadStatus = { innerHTML: '' };
  els.mRcpEdErr = { style: {}, textContent: '' };
  els.mRcpPickRes = { innerHTML: '' };
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
  return { ctx, calls, advance, writes, els };
}

// ── The record, as each kind of reader receives it ─────────────────────────
const FULL = {
  id: 1, name_en: 'Garlic dill sour cream', name_cn: '蒜香莳萝酸奶油', sku: 'TS-10', category: 'Sauces 酱料',
  recipe_type: 'made', batch_size: 1620, servings: 16, serving_size: 100, batch_size_auto: 1, servings_auto: 1,
  shelf_life: 'best before date on pack', storage: 'fridge', notes: 'Label with the date.', is_active: 1,
  ingredients: [
    { id: 11, recipe_id: 1, ingredient_id: 900, name_en: 'Sour cream 20%', name_cn: '酸奶油', sku: 'M-0012', qty: 1500, unit: 'g',
      in_yield: 1, notes: null, substitutes: null, master_unit: 'g', master_cost: 0.0253, master_name_en: 'Sour cream 20%', master_sku: 'M-0012' },
    { id: 12, recipe_id: 1, ingredient_id: 55, name_en: 'Tahini dressing', name_cn: '芝麻酱汁', sku: 'M-0301', qty: 120, unit: 'g',
      in_yield: 1, notes: 'stir first', substitutes: null, master_unit: 'g', master_cost: 0.0599 },
    { id: 13, recipe_id: 1, ingredient_id: 901, name_en: 'Stock', name_cn: '高汤', sku: 'M-9', qty: 500, unit: 'g',
      in_yield: 0, notes: null, substitutes: 'water', master_unit: 'g', master_cost: 0.01 },
  ],
  steps: [{ id: 1, recipe_id: 1, step_number: 1, name: 'Mix', instructions: 'Whisk.' }, { id: 2, recipe_id: 1, step_number: 2, name: '', instructions: 'Chill.' }],
  costData: { recipe_id: 1, labour: 12, overhead_pct: 8, sell_price: 18, target_food_cost: 30, packaging: 0.5 },
  cost: { zeroCostIngredientLines: 0, unreconciledUnitLines: 0, batchCost: 86.4, costPerServing: 4.32 },
  backsMaterial: null, materialBlock: null, products: [],
};
function stripped() {
  const s = J(FULL);
  delete s.costData; s.cost = { zeroCostIngredientLines: 0, unreconciledUnitLines: 0 };
  s.ingredients.forEach((l) => delete l.master_cost);
  return s;
}
async function ready(t) {
  t.ctx.CMD.rcpOpen(1);
  t.ctx.screenRecipeOne(); await flushMicro();
  t.ctx.CMD.rcpEdit();
  return t;
}

// The desktop's own body: readDetails()'s keys in order, then what
// writeRecord() adds. Read out of 19-recipes.js, so the phone cannot drift
// from it without this failing.
// ── What this suite adds to the harness: the REAL capability gate ──────────
// mCan and MCAN_MONEY_ONLY are lifted out of m.html, so "fails closed while
// the caps load" is the app's own code answering, not a stub's.
const MCAN = between(M, 'const MCAN_MONEY_ONLY=', 'function canRoute(');
function mkMoney(opts = {}) {
  const t = mk(opts);
  vm.runInContext(MCAN, t.ctx);
  t.ctx.state.caps = opts.caps === undefined ? null : opts.caps;
  t.ctx.state.pos = opts.pos || 'owner';
  return t;
}
const COSTS = ['recipes:view', 'recipes:edit', 'recipes:costs'];
const NOCOSTS = ['recipes:view', 'recipes:edit'];
function openCost(rec, opts = {}) {
  return mkMoney({ caps: COSTS, ...opts, handlers: {
    '/api/retail-admin/recipes': { success: true, data: opts.rows || [], total: 0, limit: 500, truncated: false },
    '/api/retail-admin/recipes/meta/categories': { data: [] },
    'GET /api/retail-admin/recipes/1': { success: true, data: rec },
    'PUT /api/retail-admin/recipes/1': { success: true },
    'PUT /api/retail-admin/recipes/1/cost': { success: true },
    ...(opts.handlers || {}) } });
}
async function openRead(t) { t.ctx.CMD.rcpOpen(1); t.ctx.screenRecipeOne(); await flushMicro(); return t; }
// The record a cost holder receives: FULL, with the server's own computed cost.
function costed(extra = {}) {
  const r = J(FULL);
  r.cost = RecipeCost.computeRecipeCost({ recipe: r, ingredients: r.ingredients, costData: r.costData });
  return Object.assign(r, extra);
}
const FIG = (html, s) => html.indexOf(s) !== -1;

// ════════════════════════════════════════════════════════════════════════════
section('1 · who sees money: recipes:costs, failing closed three ways');
// ════════════════════════════════════════════════════════════════════════════
const ROWS = [{ id: 1, name_en: 'Garlic dill sour cream', batch_size: 1620, servings: 16, recipe_type: 'made',
  zeroCostIngredientLines: 1, unreconciledUnitLines: 0, batchCost: 86.4, costPerServing: 4.32, costPerGram: 0.0533,
  backsMaterial: null, materialBlock: null },
{ id: 2, name_en: 'Pickled turnip', batch_size: 5000, servings: null, recipe_type: 'repacked',
  zeroCostIngredientLines: 0, unreconciledUnitLines: 0, batchCost: 100, costPerServing: null, costPerGram: 0.02 }];
async function listHtml(opts) {
  const t = openCost(costed(), { rows: ROWS, ...opts });
  t.ctx.screenRecipes(); await flushMicro();
  return t.ctx.rcpBodyHtml();
}
it('with recipes:costs the list shows cost per serving, else the batch marked so, and cost per gram', async () => {
  const html = await listHtml({});
  assert.ok(FIG(html, '¥4.32<span') && FIG(html, '/serving'), 'per serving');
  assert.ok(FIG(html, '¥100 <span') && FIG(html, '(batch)'), 'the whole batch when no servings');
  assert.ok(FIG(html, '¥0.0533/g') && FIG(html, '¥0.0200/g'), 'per gram, to four places');
  assert.match(html, /1 ingredient missing cost — costs shown are too low/, 'the whole desktop sentence beside a figure');
});
it('without it: no figure, and the short sentence', async () => {
  const html = await listHtml({ caps: NOCOSTS });
  assert.ok(!FIG(html, '¥'));
  assert.match(html, /1 ingredient missing cost</);
});
it('while the caps are still loading: no figure (mCan fails closed for recipes:costs)', async () => {
  const html = await listHtml({ caps: null });
  assert.ok(!FIG(html, '¥'));
});
it('on a warehouse, dispatch or customer-service board: no figure, whatever the caps say', async () => {
  for (const pos of ['warehouse', 'dispatch', 'customer_service']) assert.ok(!FIG(await listHtml({ pos }), '¥'), pos);
});
it('a stale cap list over a stripped payload: no figure — the payload wins', async () => {
  const rows = J(ROWS).map((x) => { delete x.batchCost; delete x.costPerServing; delete x.costPerGram; return x; });
  const t = openCost(costed(), { rows });
  t.ctx.screenRecipes(); await flushMicro();
  assert.ok(!FIG(t.ctx.rcpBodyHtml(), '¥'));
});

// ════════════════════════════════════════════════════════════════════════════
section('2 · the record: strip, lines, tab, products, material');
// ════════════════════════════════════════════════════════════════════════════
it('the strip: batch cost and per serving; one product that still takes its cost from here — its price and margin', async () => {
  const rec = costed({ products: [{ id: 301, name_en: 'Tub', sell_price: 18, unit_cost: 8.64, build_line_count: 0 }] });
  const t = await openRead(openCost(rec));
  const html = t.ctx.screenRecipeOne();
  const sum = html.slice(html.indexOf('id="mRcpSum"'), html.indexOf('hscroll'));
  assert.match(sum, /Batch cost[\s\S]*¥/);
  assert.match(sum, /Cost per serving/);
  assert.match(sum, /Sells for<\/span>\s*<span[^>]*>¥18</);
  assert.match(sum, />Margin<\/span>\s*<span[^>]*>¥9\.36 <span style="font-size:13px">52\.0%<\/span>/);
});
it('a product costed by its build list: the RECIPE\'s own margin, labelled so', async () => {
  const rec = costed({ products: [{ id: 301, name_en: 'Tub', sell_price: 18, unit_cost: 1.23, build_line_count: 3 }] });
  const t = await openRead(openCost(rec));
  const html = t.ctx.screenRecipeOne();
  assert.match(html, /Margin \(recipe\)/);
  assert.doesNotMatch(html, /16\.77/, 'never the build list\'s figure');
});
it('selling below cost is said in words', async () => {
  const rec = costed({ products: [{ id: 301, name_en: 'Tub', sell_price: 5, unit_cost: 8.64, build_line_count: 0 }] });
  const t = await openRead(openCost(rec));
  const html = t.ctx.screenRecipeOne();
  assert.match(html, /Selling below cost/);
  assert.match(html, /−¥3\.64 <span style="font-size:13px">−72\.8%/);
});
it('each line: what it costs and its rate; a line with no cost says so', async () => {
  const rec = costed();
  rec.ingredients[2].master_cost = 0;
  const t = await openRead(openCost(rec));
  const html = t.ctx.screenRecipeOne();
  assert.match(html, /¥0\.0253\/g/); assert.match(html, />¥37\.95</, '1500 × 0.0253');
  assert.match(html, /no cost/);
});
it('the Cost & Pricing tab: the four inputs as stored and the breakdown', async () => {
  const t = await openRead(openCost(costed()));
  assert.match(t.ctx.screenRecipeOne(), /Cost &amp; Pricing|Cost & Pricing/);
  t.ctx.CMD.rcpTab('cost');
  const html = t.ctx.screenRecipeOne();
  for (const s of ['Inputs', 'Labour', '¥12', 'Overhead %', '8%', 'Sell price', '¥18', 'Target food cost %', '30%',
    'Ingredient cost', 'Overhead', 'Batch cost', 'Cost per serving', 'Cost per gram', 'Margin per serving', 'Food cost %', 'Suggested sell price']) {
    assert.ok(FIG(html, s), s);
  }
});
it('without the capability: no strip, no tab, no line figure — and a record left on the tab falls back', async () => {
  const t = await openRead(openCost(costed(), { caps: NOCOSTS }));
  t.ctx.state.rcp.tab = 'cost';
  const html = t.ctx.screenRecipeOne();
  assert.strictEqual(t.ctx.state.rcp.tab, 'ingredients');
  assert.ok(!FIG(html, 'mRcpSum') && !FIG(html, 'Cost & Pricing') && !FIG(html, '¥'));
});
it('several products: the sell price each, and the margin beside it only with money', async () => {
  const rec = costed({ products: [{ id: 301, name_en: 'Tub', sell_price: 18, unit_cost: 8.64 }, { id: 302, name_en: 'Fries', sell_price: 38.5, unit_cost: null }] });
  let t = await openRead(openCost(rec));
  t.ctx.CMD.rcpTab('details');
  let html = t.ctx.screenRecipeOne();
  assert.match(html, /Sells · Margin/); assert.match(html, /¥9\.36 52\.0%/);
  assert.match(html, /¥38\.50<\/span>\s*<span[^>]*>—</, 'an unknown cost is a dash, never 0%');
  t = await openRead(openCost(rec, { caps: NOCOSTS }));
  t.ctx.CMD.rcpTab('details');
  html = t.ctx.screenRecipeOne();
  assert.doesNotMatch(html, /Margin|52\.0%/);
  assert.match(html, /¥38\.50/, 'the price stays — it is not a cost');
});
it('the linked material\'s rate, or "not yet costed"', async () => {
  let t = await openRead(openCost(costed({ backsMaterial: { id: 60, name_en: 'Garlic dill sour cream', cost_per_unit: 0.0533, unit: 'g' } })));
  t.ctx.CMD.rcpTab('details');
  assert.match(t.ctx.screenRecipeOne(), /Garlic dill sour cream<\/b> — ¥0\.0533\/g/);
  t = await openRead(openCost(costed({ backsMaterial: { id: 60, name_en: 'X', cost_per_unit: 0, unit: 'g' } })));
  t.ctx.CMD.rcpTab('details');
  assert.match(t.ctx.screenRecipeOne(), /X<\/b> — not yet costed/);
});

// ════════════════════════════════════════════════════════════════════════════
section('3 · editing the cost: PUT /:id/cost exactly as the desktop');
// ════════════════════════════════════════════════════════════════════════════
it('a changed input: the recipe PUT, then the cost PUT with the four keys, no packaging', async () => {
  const t = await ready(openCost(costed()));
  t.ctx.CMD.rcpTab('cost');
  const html = t.ctx.screenRecipeOne();
  for (const k of ['labour', 'overhead_pct', 'sell_price', 'target_food_cost']) assert.match(html, new RegExp('id="mRcpC-' + k + '"'));
  t.ctx.CMD.rcpCostSet('labour', '15');
  t.ctx.CMD.rcpCostSet('sell_price', '');
  await t.advance(1200);
  const w = t.writes();
  assert.deepStrictEqual(w.map((x) => x.method + ' ' + x.p), ['PUT /api/retail-admin/recipes/1', 'PUT /api/retail-admin/recipes/1/cost']);
  assert.deepStrictEqual(J(w[1].body), { labour: 15, overhead_pct: 8, sell_price: 0, target_food_cost: 30, save_source: 'auto' },
    'parsed as draftCostData() parses: an empty field is 0, an empty target is 30');
});
it('the live figures move as the inputs and the lines are typed, in place', async () => {
  const t = await ready(openCost(costed()));
  const bk = { outerHTML: '' }, sum = { innerHTML: '' };
  t.els.mRcpBk = bk; t.els.mRcpSum = sum;
  t.ctx.CMD.rcpCostSet('labour', '100');
  assert.match(bk.outerHTML, /Labour[\s\S]*¥100/);
  t.ctx.CMD.rcpLineSet(0, 'qty', '3000');
  assert.match(sum.innerHTML, /Batch cost/);
  const live = t.ctx.rcpLiveCost(t.ctx.state.rcp.ed);
  assert.ok(Math.abs(live.ingredientCost - (3000 * 0.0253 + 120 * 0.0599 + 500 * 0.01)) < 1e-6, 'the draft\'s lines at their rates');
});
it('a new recipe for a cost holder: POST, then its cost row — empty inputs, target 30', async () => {
  const t = mkMoney({ caps: COSTS, handlers: {
    'POST /api/retail-admin/recipes': { success: true, id: 42 },
    'PUT /api/retail-admin/recipes/42/cost': { success: true },
    'GET /api/retail-admin/recipes/42': { data: { ...costed(), id: 42 } } } });
  t.ctx.CMD.rcpNew();
  t.ctx.CMD.rcpEdSet('name_en', 'Hummus');
  await t.advance(1200);
  const w = t.writes();
  assert.deepStrictEqual(w.map((x) => x.method + ' ' + x.p), ['POST /api/retail-admin/recipes', 'PUT /api/retail-admin/recipes/42/cost']);
  assert.deepStrictEqual(J(w[1].body), { labour: 0, overhead_pct: 0, sell_price: 0, target_food_cost: 30, save_source: 'auto' });
});
it('…and for anybody else a new recipe makes no cost row', async () => {
  const t = mkMoney({ caps: NOCOSTS, handlers: { 'POST /api/retail-admin/recipes': { success: true, id: 42 }, 'GET /api/retail-admin/recipes/42': { data: { ...stripped(), id: 42 } } } });
  t.ctx.CMD.rcpNew(); t.ctx.CMD.rcpEdSet('name_en', 'Hummus'); await t.advance(1200);
  assert.deepStrictEqual(t.writes().map((x) => x.method + ' ' + x.p), ['POST /api/retail-admin/recipes']);
});
it('Done sends the cost as a deliberate save too', async () => {
  const t = await ready(openCost(costed()));
  t.ctx.CMD.rcpCostSet('overhead_pct', '10');
  t.ctx.CMD.rcpEdDone(); await flushMicro();
  const w = t.writes();
  assert.deepStrictEqual(w.map((x) => [x.p, x.body.save_source]), [['/api/retail-admin/recipes/1', 'manual'], ['/api/retail-admin/recipes/1/cost', 'manual']]);
});
it('the picker shows a rate to a cost holder, and it prices the new line', async () => {
  const t = await ready(openCost(costed(), { handlers: { 'GET /api/retail-admin/materials?for_recipe=1&search=dill': { data: [
    { id: 902, name_en: 'Dill, fresh', unit: 'g', cost_per_unit: 0.08 }] } } }));
  t.ctx.CMD.rcpPickQ('dill'); await t.advance(220);
  assert.match(t.els.mRcpPickRes.innerHTML, /¥0\.0800\/g/);
  t.ctx.CMD.rcpPickAdd(902); t.ctx.CMD.rcpLineSet(3, 'qty', '10');
  const live = t.ctx.rcpLiveCost(t.ctx.state.rcp.ed);
  assert.ok(Math.abs(live.ingredientCost - (1500 * 0.0253 + 120 * 0.0599 + 500 * 0.01 + 10 * 0.08)) < 1e-6);
  await t.advance(1200);
  for (const k of MONEY_KEYS) assert.ok(!keysDeep(t.writes()[0].body).has(k), 'the rate never rides the recipe write: ' + k);
});

// ════════════════════════════════════════════════════════════════════════════
section('4 · the words');
// ════════════════════════════════════════════════════════════════════════════
it('every Chinese half is the desktop\'s, but one — declared', () => {
  for (const zh of ['成本与定价', '成本输入', '人工', '管理费用 %', '售价', '目标食品成本 %', '原料成本', '管理费用', '整批成本',
    '每份成本', '每克成本', '(未记录份数)', '(未记录批量)', '每份毛利', '食品成本率', '建议售价', '单位成本', '未记录批量大小或份数',
    '低于成本销售', '(整批)', '免费', '无成本', '尚未计算成本', '显示成本偏低', '毛利']) {
    assert.ok(DESK.indexOf(zh) !== -1, zh + ' is not the desktop\'s');
    assert.ok(M.indexOf(zh) !== -1, zh + ' is not on the phone');
  }
  // The desktop's `Margin (recipe)` has no Chinese of its own ("CN PENDING"),
  // so the phone's is composed from the two live words and declared.
  assert.match(DESK, /T\('Margin \(recipe\)', 'Margin \(recipe\)'\)/);
  assert.match(M, /T\('Margin \(recipe\)','毛利\(食谱\)'\)/);
});

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
