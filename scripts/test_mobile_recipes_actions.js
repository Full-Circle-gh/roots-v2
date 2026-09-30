#!/usr/bin/env node
/**
 * §300 step R4 — the recipe record's ⋯ menu on the phone.
 *
 *   node scripts/test_mobile_recipes_actions.js
 *
 * Duplicate (duplicateOf: read fresh, a new recipe, suffixes per language,
 * cost inputs only for a cost holder, no SKU / material / products), Archive
 * and Restore (the desktop's confirms, with the used-by warning for a recipe
 * that supplies a material), Make available as material (new or link, the
 * desktop's filters) and unlink — each gated on the capability its write
 * needs, every write asserted on the request, every refusal kept on screen.
 *
 * Harness: test_mobile_recipes_cost.js's (the code RUN with the app's real
 * mCan, the real engine and cost module, a fake clock).
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

// ── R4 fixtures ────────────────────────────────────────────────────────────
// The desktop's own body keys, read out of 19-recipes.js (as the edit suite does).
const BODY_KEYS = between(DESK, '  function readDetails() {', '  window.rcpSave = async function')
  .match(/^\s{6}([a-z_]+):/gm).map((x) => x.trim().replace(':', '')).concat(['ingredients', 'steps', 'save_source']);
const ALL = ['recipes:view', 'recipes:edit', 'recipes:costs', 'materials:edit'];
async function openAct(rec, opts = {}) {
  const t = openCost(rec, { caps: ALL, ...opts, handlers: {
    'PUT /api/retail-admin/recipes/1/archive': { success: true, is_active: 0 },
    'DELETE /api/retail-admin/recipes/1/materialize': { success: true, material_id: 60 },
    'POST /api/retail-admin/recipes/1/materialize': { success: true, material_id: 61, warning: null },
    ...(opts.handlers || {}) } });
  return openRead(t);
}
const keysOf = (t) => t.ctx.state.ask.options.map((o) => o.key).join(',');

// ════════════════════════════════════════════════════════════════════════════
section('1 · the ⋯ menu, and who sees what in it');
// ════════════════════════════════════════════════════════════════════════════
it('everything, for recipes:edit + materials:edit', async () => {
  const t = await openAct(costed());
  assert.match(t.ctx.SUBS.recipeone.cta(), /aria-label="More actions"[^>]*onclick="APP\.cmd\('rcpActs'\)"/);
  t.ctx.CMD.rcpActs();
  assert.strictEqual(t.ctx.state.ask.title, 'More actions');
  assert.strictEqual(keysOf(t), 'print,dup,hist,mz,arch');
  assert.deepStrictEqual(t.ctx.state.ask.options.map((o) => o.label).join(' | '),
    'Print | Duplicate | Version history | Make available as material | Archive');
});
it('a linked recipe offers the unlink, named; an archived one offers Restore', async () => {
  const t = await openAct(costed({ is_active: 0, backsMaterial: { id: 60, name_en: 'Garlic dill sour cream', unit: 'g', consumers: [] } }));
  t.ctx.CMD.rcpActs();
  assert.strictEqual(keysOf(t), 'print,dup,hist,unlink,arch');
  assert.match(t.ctx.state.ask.options[3].label, /^Linked to material: Garlic dill sour cream$/);
  assert.strictEqual(t.ctx.state.ask.options[4].label, 'Restore');
});
it('capability denied: without materials:edit no material action; without recipes:edit only Print and history', async () => {
  let t = await openAct(costed(), { caps: ['recipes:view', 'recipes:edit'] });
  t.ctx.CMD.rcpActs(); assert.strictEqual(keysOf(t), 'print,dup,hist,arch');
  assert.strictEqual(t.ctx.canRoute('recipemz'), true, 'the harness stub; the app\'s own canRoute is asserted below');
  t = await openAct(costed(), { caps: ['recipes:view', 'materials:edit'] });
  t.ctx.CMD.rcpActs(); assert.strictEqual(keysOf(t), 'print,hist');
  assert.match(between(M, 'function canRoute(k){', '\n}'), /if\(k==='recipemz'\) return mCan\('recipes:edit'\) && mCan\('materials:edit'\);/);
  // And the commands refuse on their own, whatever calls them.
  t.ctx.CMD.rcpAct('arch'); t.ctx.CMD.rcpAct('dup'); t.ctx.CMD.rcpAct('mz');
  await flushMicro();
  assert.strictEqual(t.writes().length, 0);
  assert.strictEqual(t.ctx.state.rcp.mz, null);
});

// ════════════════════════════════════════════════════════════════════════════
section('2 · Duplicate');
// ════════════════════════════════════════════════════════════════════════════
it('reads the source fresh, opens the copy as a new recipe, and says nothing is saved yet', async () => {
  const t = await openAct(costed());
  const before = t.calls.req.filter((r) => r.p === '/api/retail-admin/recipes/1').length;
  t.ctx.CMD.rcpAct('dup'); await flushMicro();
  assert.strictEqual(t.calls.req.filter((r) => r.p === '/api/retail-admin/recipes/1').length, before + 1, 'read fresh');
  const f = t.ctx.state.stack[t.ctx.state.stack.length - 1];
  assert.deepStrictEqual([f.route, f.isNew, t.ctx.state.stack.length], ['recipeone', true, 2]);
  assert.strictEqual(t.ctx.SUBS.recipeone.titleOf(), 'New recipe');
  assert.deepStrictEqual(t.calls.toasts, ['Duplicated · edit the copy']);
  const d = t.ctx.state.rcp.ed;
  assert.deepStrictEqual([d.name_en, d.name_cn, d.sku, d.id], ['Garlic dill sour cream (copy)', '蒜香莳萝酸奶油(副本)', '', null]);
  assert.strictEqual(t.writes().length, 0, 'nothing written until Done or an edit');
});
it('the suffixes are stored data, one per language, whatever the screen reads in', async () => {
  const t = await openAct(costed(), { lang: 'zh' });
  t.ctx.CMD.rcpAct('dup'); await flushMicro();
  const d = t.ctx.state.rcp.ed;
  assert.deepStrictEqual([d.name_en, d.name_cn], ['Garlic dill sour cream (copy)', '蒜香莳萝酸奶油(副本)']);
});
it('for a cost holder, Done writes the copy — POST, then the SOURCE\'s cost inputs — and not the source\'s SKU, material or products', async () => {
  const t = await openAct(costed({ backsMaterial: { id: 60, name_en: 'X', unit: 'g' } }), { handlers: {
    'POST /api/retail-admin/recipes': { success: true, id: 77 },
    'PUT /api/retail-admin/recipes/77/cost': { success: true },
    'GET /api/retail-admin/recipes/77': { data: { ...costed(), id: 77 } } } });
  t.ctx.CMD.rcpAct('dup'); await flushMicro();
  t.ctx.CMD.rcpEdDone(); await flushMicro();
  const w = t.writes();
  assert.deepStrictEqual(w.map((x) => x.method + ' ' + x.p), ['POST /api/retail-admin/recipes', 'PUT /api/retail-admin/recipes/77/cost']);
  const b = w[0].body;
  assert.deepStrictEqual(Object.keys(b), BODY_KEYS);
  assert.deepStrictEqual([b.name_en, b.sku, b.save_source, b.ingredients.length, b.steps.length], ['Garlic dill sour cream (copy)', '', 'manual', 3, 2]);
  assert.deepStrictEqual(J(w[1].body), { labour: 12, overhead_pct: 8, sell_price: 18, target_food_cost: 30, save_source: 'manual' });
  for (const k of ['id', 'recipe_id', 'backsMaterial', 'products']) assert.ok(!keysDeep(b).has(k), k + ' rode along');
});
it('for anybody else the copy carries no cost inputs and makes no cost request', async () => {
  const t = await openAct(stripped(), { caps: NOCOSTS, handlers: {
    'POST /api/retail-admin/recipes': { success: true, id: 77 }, 'GET /api/retail-admin/recipes/77': { data: { ...stripped(), id: 77 } } } });
  t.ctx.CMD.rcpAct('dup'); await flushMicro();
  assert.strictEqual(t.ctx.state.rcp.ed.cost, null);
  t.ctx.CMD.rcpEdDone(); await flushMicro();
  assert.deepStrictEqual(t.writes().map((x) => x.method + ' ' + x.p), ['POST /api/retail-admin/recipes']);
  for (const k of MONEY_KEYS) assert.ok(!keysDeep(t.writes()[0].body).has(k), k);
});
it('a source that cannot be read says so on the record, and opens nothing', async () => {
  const t = await openAct(costed());
  t.calls.req.length = 0;
  t.ctx.state.rcp.rec = costed(); // the record in hand stays
  const h = t.ctx; h.api = () => Promise.reject(new Error('HTTP 500'));
  vm.runInContext('api=function(){ return Promise.reject(new Error("HTTP 500")); }', h);
  h.CMD.rcpAct('dup'); await flushMicro();
  assert.strictEqual(h.state.stack.length, 1);
  assert.match(h.screenRecipeOne(), /Could not open that recipe: HTTP 500/);
});
it('Done on a never-saved copy with no English name holds, and says why', async () => {
  const t = await openAct(costed({ name_en: '' }));
  t.ctx.CMD.rcpAct('dup'); await flushMicro();
  t.ctx.CMD.rcpEdSet('name_en', '');
  t.ctx.CMD.rcpEdDone(); await flushMicro();
  assert.ok(t.ctx.state.rcp.ed, 'still editing');
  assert.match(t.ctx.SUBS.recipeone.status(), /this recipe still needs an English name/);
  assert.strictEqual(t.writes().length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
section('3 · Archive and Restore');
// ════════════════════════════════════════════════════════════════════════════
it('a plain recipe: the desktop\'s confirm, PUT /archive {restore:false}, back to the list', async () => {
  const t = await openAct(costed());
  t.ctx.CMD.rcpAct('arch');
  const a = t.ctx.state.ask;
  assert.deepStrictEqual([a.title, a.body, a.confirmLabel, a.danger], ['Archive this recipe?', 'You can bring it back later.', 'Archive', true]);
  assert.strictEqual(t.writes().length, 0, 'nothing before the confirm');
  a.run();
  assert.match(t.ctx.SUBS.recipeone.status(), /Saving…/, 'says what it is doing');
  assert.match(t.ctx.SUBS.recipeone.cta(), /aria-label="More actions" disabled/);
  await flushMicro();
  const w = t.writes();
  assert.deepStrictEqual(w.map((x) => [x.method, x.p, J(x.body)]), [['PUT', '/api/retail-admin/recipes/1/archive', { restore: false }]]);
  assert.deepStrictEqual(t.calls.toasts, ['Archived']);
  assert.strictEqual(t.ctx.state.stack.length, 0, 'the record came down');
  assert.deepStrictEqual([t.ctx.state.rcp.tried, t.ctx.state.rcp.archTried], [false, false], 'both lists re-read');
});
it('a recipe that supplies a material: the used-by warning, named, with the frozen rate for a cost holder', async () => {
  const bm = { id: 60, name_en: 'GDSC', cost_per_unit: 0.0533, unit: 'g',
    consumers: [{ id: 5, name_en: 'Loaded fries', name_cn: '薯条' }, { id: 6, name_en: 'Wrap' }] };
  let t = await openAct(costed({ backsMaterial: bm }));
  t.ctx.CMD.rcpAct('arch');
  let a = t.ctx.state.ask;
  assert.strictEqual(a.confirmLabel, 'Archive anyway');
  assert.strictEqual(a.body, '&quot;Garlic dill sour cream&quot; supplies the material &quot;GDSC&quot;, used by 2 recipes (Loaded fries, Wrap). Archiving freezes its cost at ¥0.0533/g — those recipes will keep using that number until you bring it back.');
  t = await openAct(stripped(), { caps: ['recipes:view', 'recipes:edit'], handlers: { 'GET /api/retail-admin/recipes/1': { data: { ...stripped(), backsMaterial: { id: 60, name_en: 'GDSC', unit: 'g', consumers: [] } } } } });
  t.ctx.CMD.rcpAct('arch');
  a = t.ctx.state.ask;
  assert.match(a.body, /Archiving freezes its cost — nothing uses it yet, but anything that does will keep using that number/, 'no figure without money');
  t.ctx.LANG = 'zh'; t.ctx.CMD.rcpAct('arch');
  assert.match(t.ctx.state.ask.body, /归档后其成本将冻结 —— 目前没有食谱使用它,但之后使用它的食谱会持续使用该数值/);
});
it('an archived recipe: "Bring this recipe back?", PUT /archive {restore:true}', async () => {
  const t = await openAct(costed({ is_active: 0 }));
  t.ctx.CMD.rcpAct('arch');
  assert.deepStrictEqual([t.ctx.state.ask.title, t.ctx.state.ask.confirmLabel], ['Bring this recipe back?', 'Restore']);
  t.ctx.state.ask.run(); await flushMicro();
  assert.deepStrictEqual(J(t.writes()[0].body), { restore: true });
  assert.deepStrictEqual(t.calls.toasts, ['Restored']);
});
it('a refused archive says so on the record and stays', async () => {
  const e = new Error('not_found');
  const t = await openAct(costed(), { handlers: { 'PUT /api/retail-admin/recipes/1/archive': () => { throw e; } } });
  t.ctx.CMD.rcpAct('arch'); t.ctx.state.ask.run(); await flushMicro();
  assert.strictEqual(t.ctx.state.stack.length, 1);
  assert.match(t.ctx.screenRecipeOne(), /Failed: not_found/);
  assert.deepStrictEqual(t.calls.toasts, [], 'a toast never reports a failure');
  assert.strictEqual(t.ctx.state.rcp.actBusy, null, 'and the menu opens again');
});

// ════════════════════════════════════════════════════════════════════════════
section('4 · Make available as material, and unlink');
// ════════════════════════════════════════════════════════════════════════════
it('opens its own screen, named from the recipe, and a new material is POSTed as the desktop posts it', async () => {
  const t = await openAct(costed());
  t.ctx.CMD.rcpAct('mz');
  assert.strictEqual(t.ctx.state.stack[t.ctx.state.stack.length - 1].route, 'recipemz');
  let html = t.ctx.screenRecipeMz();
  assert.match(html, /id="mRcpMz-name_en" value="Garlic dill sour cream"/);
  assert.match(html, /Recipe unit[\s\S]*value="g" disabled/);
  assert.match(html, /<option value="food" selected>Food<\/option>/);
  t.ctx.CMD.rcpMzSet('sku', ' GDSC-1 '); t.ctx.CMD.rcpMzSet('kind', 'other');
  t.ctx.CMD.rcpMzGo(); await flushMicro();
  const w = t.writes();
  assert.deepStrictEqual(w.map((x) => [x.method, x.p, J(x.body)]), [['POST', '/api/retail-admin/recipes/1/materialize',
    { mode: 'new', name_en: 'Garlic dill sour cream', name_cn: '蒜香莳萝酸奶油', sku: 'GDSC-1', item_kind: 'other' }]]);
  assert.deepStrictEqual(t.calls.toasts, ['Now available as a material']);
  assert.strictEqual(t.ctx.state.stack[t.ctx.state.stack.length - 1].route, 'recipeone', 'back on the record');
  assert.strictEqual(t.ctx.state.rcp.recTried, false, 'which is read again');
});
it('no English name: the reason, and the button off', async () => {
  const t = await openAct(costed());
  t.ctx.CMD.rcpAct('mz'); t.ctx.CMD.rcpMzSet('name_en', '  ');
  const html = t.ctx.screenRecipeMz();
  assert.match(html, /An English name is required\./);
  assert.match(html, /id="mRcpMzGo" class="cta" disabled/);
  t.ctx.CMD.rcpMzGo(); await flushMicro();
  assert.strictEqual(t.writes().length, 0);
});
it('link: searches the picker\'s query, offers only g-stocked materials no recipe makes, warns of a buy price, POSTs the id', async () => {
  const t = await openAct(costed(), { handlers: { 'GET /api/retail-admin/materials?for_recipe=1&search=dill': { data: [
    { id: 902, name_en: 'Dill sauce', unit: 'g', buy_price: 12, cost_per_unit: 0.012 },
    { id: 903, name_en: 'Dill bunch', unit: 'pcs' },
    { id: 904, name_en: 'Dill oil', unit: 'g', source_recipe_id: 9 }] } } });
  t.ctx.CMD.rcpAct('mz'); t.ctx.CMD.rcpMzMode('link');
  let html = t.ctx.screenRecipeMz();
  assert.match(html, /Pick a material to link\./);
  t.ctx.CMD.rcpMzQ('dill'); await t.advance(220);
  html = t.ctx.rcpMzResultsHtml();
  assert.match(html, /Dill sauce/); assert.doesNotMatch(html, /Dill bunch|Dill oil/);
  assert.match(html, /¥0\.0120\/g/, 'the rate, to a cost holder');
  t.ctx.CMD.rcpMzPick(902);
  html = t.ctx.screenRecipeMz();
  assert.match(html, /Selected: <b[^>]*>Dill sauce<\/b>/);
  assert.match(html, /This material has a buy price — linking will switch its cost to come from this recipe instead\./);
  t.ctx.CMD.rcpMzGo(); await flushMicro();
  assert.deepStrictEqual(J(t.writes()[0].body), { mode: 'link', material_id: 902 });
});
it('a refusal stays on the screen, the button comes back, nothing is toasted', async () => {
  const e = new Error('That material is already made by another recipe.');
  const t = await openAct(costed(), { handlers: { 'POST /api/retail-admin/recipes/1/materialize': () => { throw e; } } });
  t.ctx.CMD.rcpAct('mz'); t.ctx.CMD.rcpMzGo();
  assert.match(t.ctx.screenRecipeMz(), /id="mRcpMzGo" class="cta" disabled[^>]*>Saving…/, 'says what it is doing');
  await flushMicro();
  const html = t.ctx.screenRecipeMz();
  assert.match(html, /Failed: That material is already made by another recipe\./);
  assert.doesNotMatch(html, /id="mRcpMzGo" class="cta" disabled/);
  assert.strictEqual(t.ctx.state.stack[t.ctx.state.stack.length - 1].route, 'recipemz');
  assert.deepStrictEqual(t.calls.toasts, []);
});
it('the server\'s warning, when it sends one, is the toast', async () => {
  const t = await openAct(costed(), { handlers: { 'POST /api/retail-admin/recipes/1/materialize': { success: true, warning: 'This material has purchase history.' } } });
  t.ctx.CMD.rcpAct('mz'); t.ctx.CMD.rcpMzGo(); await flushMicro();
  assert.deepStrictEqual(t.calls.toasts, ['This material has purchase history.']);
});
it('unlink: the desktop\'s confirm, then DELETE /materialize, and the record read again', async () => {
  const t = await openAct(costed({ backsMaterial: { id: 60, name_en: 'GDSC', unit: 'g', consumers: [] } }));
  t.ctx.CMD.rcpAct('unlink');
  const a = t.ctx.state.ask;
  assert.deepStrictEqual([a.title, a.confirmLabel, a.danger], ['Unlink this material?', 'Unlink', true]);
  assert.match(a.body, /&quot;GDSC&quot; stops being backed by this recipe\. It is not deleted/);
  a.run(); await flushMicro();
  assert.deepStrictEqual(t.writes().map((x) => [x.method, x.p]), [['DELETE', '/api/retail-admin/recipes/1/materialize']]);
  assert.deepStrictEqual(t.calls.toasts, ['Unlinked']);
  assert.strictEqual(t.ctx.state.rcp.recTried, false);
});

// ════════════════════════════════════════════════════════════════════════════
section('5 · the words');
// ════════════════════════════════════════════════════════════════════════════
it('every Chinese half is the desktop\'s own', () => {
  for (const zh of ['复制', '已复制 · 编辑副本', '无法打开该食谱', '归档该食谱?', '之后可以恢复。', '仍然归档', '恢复该食谱?', '已归档',
    '操作失败', '取消关联该物料?', '已取消关联', '设为可用物料', '已关联物料:', '让其他食谱可以将本食谱的产出作为原料使用。', '新建', '关联现有',
    '配方单位', '货号(可选)', '类别', '食品', '包装', '设备', '零售', '其他', '搜索物料', '名称或货号…', '英文名称为必填项。',
    '请选择一个要关联的物料。', '已选择:', '该物料已有采购价 —— 关联后其成本将改为来自本食谱。', '设为可用', '已设为可用物料', '(副本)']) {
    assert.ok(DESK.indexOf(zh) !== -1, zh + ' is not the desktop\'s');
    assert.ok(M.indexOf(zh) !== -1, zh + ' is not on the phone');
  }
  assert.ok(M.indexOf("T('More actions','更多操作')") !== -1, 'the phone\'s own ⋯ label');
});

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
