#!/usr/bin/env node
/**
 * §300 step R2 — a recipe edited from the phone.
 *
 *   node scripts/test_mobile_recipes_edit.js
 *
 * New recipe, Details, Ingredients (the material picker, quantity and unit,
 * counts toward the batch weight, the line note, reorder, remove), Steps (add,
 * move, remove), autosave at the desktop's timings through
 * public/tacet-autosave.js, the save state in the status line, and version
 * history with restore.
 *
 * THE CASE THIS SUITE EXISTS FOR is §164's addendum: a desktop autosave once
 * read cost inputs out of a tab it no longer drew and wrote
 * {labour: 0, overhead_pct: 0, sell_price: 0, target_food_cost: 30} over a
 * recipe whose NAME was being corrected. The phone has no cost tab (that is
 * R3), so it must make no cost request at all — for a user without
 * `recipes:costs` AND for one with it, whose figures must never be blanked. Both
 * are proved on the request itself: every body's keys, at every depth, against
 * the desktop's own writeRecord() / readDetails() key list.
 *
 * The code is RUN, sliced out of public/m.html with the real autosave engine,
 * the real shared cost module and a fake clock — no browser, FAST shard.
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
const IngredientCost = require('../lib/ingredient-cost.js');

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
function codeOnly(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
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
  ctx.mCan = (k) => (opts.caps || ['recipes:view', 'recipes:edit']).indexOf(k) !== -1;
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
function openEdit(rec, opts = {}) {
  const t = mk({ ...opts, handlers: {
    '/api/retail-admin/recipes': { success: true, data: [], total: 0, limit: 500, truncated: false },
    '/api/retail-admin/recipes/meta/categories': { data: ['Sauces 酱料', 'Pickles 腌菜'] },
    'GET /api/retail-admin/recipes/1': { success: true, data: rec },
    'PUT /api/retail-admin/recipes/1': { success: true },
    ...(opts.handlers || {}) } });
  return t;
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
const DESK_DETAILS = between(DESK, '  function readDetails() {', '  window.rcpSave = async function')
  .match(/^\s{6}([a-z_]+):/gm).map((s) => s.trim().replace(':', ''));
const DESK_LINE = between(DESK, '    body.ingredients = _lines.map(l => ({', '    }));')
  .replace(/\/\/[^\n]*/g, '').match(/([a-z_]+):/g).map((s) => s.replace(':', ''));
const BODY_KEYS = DESK_DETAILS.concat(['ingredients', 'steps', 'save_source']);

// ════════════════════════════════════════════════════════════════════════════
section('1 · §164\'s addendum — no cost field reaches the wire, for anybody');
// ════════════════════════════════════════════════════════════════════════════
it('the key list is the desktop\'s (read out of 19-recipes.js)', () => {
  assert.deepStrictEqual(DESK_DETAILS, ['name_en', 'name_cn', 'sku', 'category', 'recipe_type', 'batch_size', 'servings',
    'serving_size', 'batch_size_auto', 'servings_auto', 'shelf_life', 'storage', 'notes']);
  assert.deepStrictEqual(DESK_LINE, ['ingredient_id', 'name_en', 'name_cn', 'sku', 'qty', 'unit', 'in_yield', 'notes', 'substitutes']);
});
for (const [who, rec, caps] of [
  ['without recipes:costs (the server\'s stripped read)', stripped(), ['recipes:view', 'recipes:edit']],
  ['WITH recipes:costs (a read full of cost figures)', J(FULL), ['recipes:view', 'recipes:edit', 'recipes:costs']],
]) {
  it(`a name corrected by somebody ${who}: one PUT, the desktop's keys, no cost key at any depth, no cost request`, async () => {
    const t = await ready(openEdit(rec, { caps }));
    assert.strictEqual(t.writes().length, 0, 'opening the editor writes nothing');
    t.ctx.CMD.rcpEdSet('name_en', 'Garlic dill sour cream 2');
    await t.advance(1199);
    assert.strictEqual(t.writes().length, 0, 'not before the pause');
    await t.advance(1);
    const w = t.writes();
    assert.strictEqual(w.length, 1, JSON.stringify(w.map((x) => x.method + ' ' + x.p)));
    assert.strictEqual(w[0].method + ' ' + w[0].p, 'PUT /api/retail-admin/recipes/1');
    assert.deepStrictEqual(Object.keys(w[0].body), BODY_KEYS);
    w[0].body.ingredients.forEach((l) => assert.deepStrictEqual(Object.keys(l), DESK_LINE));
    w[0].body.steps.forEach((s) => assert.deepStrictEqual(Object.keys(s), ['name', 'instructions']));
    const deep = keysDeep(w[0].body);
    for (const k of MONEY_KEYS) assert.ok(!deep.has(k), `${k} is on the wire`);
    assert.ok(!t.calls.req.some((r) => /\/cost$/.test(r.p)), 'the cost endpoint is never called');
    assert.strictEqual(w[0].body.save_source, 'auto');
  });
  it(`…and nothing else about the recipe is blanked (${who.split(' (')[0]})`, async () => {
    const t = await ready(openEdit(rec, { caps }));
    t.ctx.CMD.rcpEdSet('notes', 'Label with the date. Keep cold.');
    await t.advance(1200);
    const b = t.writes()[0].body;
    assert.deepStrictEqual(J(b), {
      name_en: 'Garlic dill sour cream', name_cn: '蒜香莳萝酸奶油', sku: 'TS-10', category: 'Sauces 酱料', recipe_type: 'made',
      // Derived: 1500 + 120 counted; the 500 g stock is out of the batch.
      batch_size: 1620, servings: 16, serving_size: 100, batch_size_auto: 1, servings_auto: 1,
      shelf_life: 'best before date on pack', storage: 'fridge', notes: 'Label with the date. Keep cold.',
      ingredients: [
        { ingredient_id: 900, name_en: 'Sour cream 20%', name_cn: '酸奶油', sku: 'M-0012', qty: 1500, unit: 'g', in_yield: 1, notes: null, substitutes: null },
        { ingredient_id: 55, name_en: 'Tahini dressing', name_cn: '芝麻酱汁', sku: 'M-0301', qty: 120, unit: 'g', in_yield: 1, notes: 'stir first', substitutes: null },
        { ingredient_id: 901, name_en: 'Stock', name_cn: '高汤', sku: 'M-9', qty: 500, unit: 'g', in_yield: 0, notes: null, substitutes: 'water' },
      ],
      steps: [{ name: 'Mix', instructions: 'Whisk.' }, { name: null, instructions: 'Chill.' }],
      save_source: 'auto',
    });
  });
}
it('the draft is built without the money the read carried', async () => {
  const t = await ready(openEdit(J(FULL), { caps: ['recipes:view', 'recipes:edit', 'recipes:costs'] }));
  const deep = keysDeep(J(t.ctx.state.rcp.ed));
  for (const k of MONEY_KEYS) assert.ok(!deep.has(k), `${k} is in the draft`);
  assert.doesNotMatch(codeOnly(between(M, '/* ── Editing a recipe (§300 step R2)', '/* ── Making one (§167)')),
    /\/cost['`]|labour|overhead|sell_price|target_food_cost|costData|master_cost/, 'the editor never names a cost key or the cost route');
});

// ════════════════════════════════════════════════════════════════════════════
section('2 · the desktop\'s timings, and the save line');
// ════════════════════════════════════════════════════════════════════════════
it('1.2s after the last keystroke — and never more than 8s however long the typing goes on', async () => {
  const t = await ready(openEdit(stripped()));
  for (let i = 0; i < 12; i++) { t.ctx.CMD.rcpEdSet('notes', 'n' + i); await t.advance(1000); if (t.writes().length) break; }
  assert.strictEqual(t.writes().length, 1);
  assert.strictEqual(t.writes()[0].body.notes, 'n7', 'the burst began at 0 and was cut at 8s');
});
it('the status line says where the work is, in the desktop\'s words', async () => {
  const t = await ready(openEdit(stripped()));
  const st = () => t.ctx.SUBS.recipeone.status();
  assert.strictEqual(st(), ' ', 'nothing to say yet, but the line exists to be patched');
  t.ctx.CMD.rcpEdSet('sku', 'TS-11');
  assert.strictEqual(st(), 'Unsaved changes');
  assert.strictEqual(t.els.mHeadStatus.innerHTML, 'Unsaved changes', 'patched in place, no render');
  await t.advance(1200);
  assert.match(st(), /^Saved · just now$/);
  t.ctx.LANG = 'zh';
  assert.match(st(), /^已保存 · 刚刚$/);
});
it('each save reads the record back — into the record, not the draft being typed', async () => {
  const t = await ready(openEdit(stripped()));
  t.ctx.CMD.rcpEdSet('sku', 'TS-11');
  await t.advance(1200);
  const gets = t.calls.req.filter((r) => r.method === 'GET' && r.p === '/api/retail-admin/recipes/1');
  assert.strictEqual(gets.length, 2, 'the open, and the read-back');
  assert.strictEqual(t.ctx.state.rcp.tried, false, 'and the list behind is marked stale');
});

// ════════════════════════════════════════════════════════════════════════════
section('3 · a new recipe: POST, then it is that recipe');
// ════════════════════════════════════════════════════════════════════════════
it('held until it has an English name, created by the first save that has one, PUT after', async () => {
  const t = mk({ handlers: {
    'POST /api/retail-admin/recipes': { success: true, id: 42 },
    'GET /api/retail-admin/recipes/42': { success: true, data: { ...stripped(), id: 42, name_en: 'Hummus', ingredients: [], steps: [] } },
    'PUT /api/retail-admin/recipes/42': { success: true },
  } });
  assert.match(t.ctx.SUBS.recipes.cta(), /APP\.cmd\('rcpNew'\)[\s\S]*New recipe/);
  t.ctx.CMD.rcpNew();
  assert.strictEqual(t.ctx.SUBS.recipeone.titleOf(), 'New recipe');
  assert.strictEqual(t.ctx.state.rcp.tab, 'details', 'it opens where the name is typed');
  assert.match(t.ctx.screenRecipeOne(), /id="mRcpF-name_en"/);
  t.ctx.CMD.rcpEdSet('name_cn', '鹰嘴豆泥');
  await t.advance(9000);
  assert.strictEqual(t.writes().length, 0, 'no English name, no write');
  assert.strictEqual(t.ctx.SUBS.recipeone.status(), 'Unsaved changes — this recipe still needs an English name');
  t.ctx.CMD.rcpEdSet('name_en', 'Hummus');
  await t.advance(1200);
  const w = t.writes();
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].method + ' ' + w[0].p, 'POST /api/retail-admin/recipes');
  assert.deepStrictEqual(Object.keys(w[0].body), BODY_KEYS);
  assert.deepStrictEqual([w[0].body.name_en, w[0].body.name_cn, w[0].body.batch_size_auto, w[0].body.servings_auto, w[0].body.recipe_type],
    ['Hummus', '鹰嘴豆泥', 1, 1, 'made'], 'both yield figures start derived, the desktop\'s rcpRecordNew()');
  for (const k of MONEY_KEYS) assert.ok(!keysDeep(w[0].body).has(k), k);
  const f = t.ctx.state.stack[t.ctx.state.stack.length - 1];
  assert.deepStrictEqual([f.rid, f.isNew], [42, false], 'the frame takes the new id');
  assert.strictEqual(t.ctx.state.rcp.rec.id, 42, 'and it is opened — read back');
  t.ctx.CMD.rcpEdSet('notes', 'Soak overnight.');
  await t.advance(1200);
  assert.deepStrictEqual(t.writes().map((x) => x.method + ' ' + x.p),
    ['POST /api/retail-admin/recipes', 'PUT /api/retail-admin/recipes/42'], 'never a second POST');
});
it('a refused create (a SKU another recipe has) says so where the operator is looking, and stays', async () => {
  const e = new Error('SKU "TS-10" is already used by "Garlic dill sour cream" (#1).'); e.code = 'sku_taken';
  const t = mk({ handlers: { 'POST /api/retail-admin/recipes': () => { throw e; } } });
  t.ctx.CMD.rcpNew();
  t.ctx.CMD.rcpEdSet('name_en', 'Hummus'); t.ctx.CMD.rcpEdSet('sku', 'TS-10');
  await t.advance(1200);
  const want = 'Not saved — SKU "TS-10" is already used by "Garlic dill sour cream" (#1).';
  assert.strictEqual(t.ctx.SUBS.recipeone.status(), want.replace(/"/g, '&quot;'));
  assert.strictEqual(t.els.mRcpEdErr.textContent, want);
  assert.strictEqual(t.els.mRcpEdErr.style.display, '');
  assert.match(t.ctx.screenRecipeOne(), /id="mRcpEdErr" style="margin/, 'drawn on the next paint too');
  await t.advance(20000);
  assert.strictEqual(t.writes().length, 1, 'a refusal is not retried on its own');
});
it('a cycle refusal is said in the reader\'s half of the server\'s pair', async () => {
  const e = new Error('Can\'t add "X" here: … · 无法添加“X”:配方不能依赖自身产出。');
  const t = await ready(openEdit(stripped(), { lang: 'zh', handlers: { 'PUT /api/retail-admin/recipes/1': () => { throw e; } } }));
  t.ctx.CMD.rcpEdSet('sku', 'X'); await t.advance(1200);
  assert.strictEqual(t.els.mRcpEdErr.textContent, '未保存 — 无法添加“X”:配方不能依赖自身产出。');
});

// ════════════════════════════════════════════════════════════════════════════
section('4 · Done, and leaving');
// ════════════════════════════════════════════════════════════════════════════
it('Done sends what is waiting now, as a deliberate save, and the record reads again', async () => {
  const t = await ready(openEdit(stripped()));
  assert.match(t.ctx.SUBS.recipeone.cta(), /^<button class="cta inhead" onclick="APP\.cmd\('rcpEdDone'\)">Done<\/button>$/);
  t.ctx.CMD.rcpEdSet('sku', 'TS-11');
  t.ctx.CMD.rcpEdDone(); await flushMicro();
  const w = t.writes();
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].body.save_source, 'manual', 'files its own restore point, the desktop\'s Save');
  assert.strictEqual(t.ctx.state.rcp.ed, null);
  assert.doesNotMatch(t.ctx.SUBS.recipeone.cta(), /rcpEdDone/);
});
it('Done with nothing changed sends nothing', async () => {
  const t = await ready(openEdit(stripped()));
  t.ctx.CMD.rcpEdDone(); await flushMicro();
  assert.strictEqual(t.writes().length, 0);
  assert.strictEqual(t.ctx.state.rcp.ed, null);
});
it('Back with work that can be saved sends it on the way out, and asks nothing', async () => {
  const t = await ready(openEdit(stripped()));
  t.ctx.CMD.rcpEdSet('sku', 'TS-11');
  t.ctx.pop();
  assert.strictEqual(t.writes().length, 1, 'on the wire before the frame came down');
  assert.strictEqual(t.ctx.state.stack.length, 0);
  assert.strictEqual(t.ctx.state.ask, null);
});
it('Back with work that CANNOT be saved asks, says why, and only then drops it', async () => {
  const t = mk({});
  t.ctx.CMD.rcpNew();
  t.ctx.CMD.rcpEdSet('name_cn', '鹰嘴豆泥');
  t.ctx.pop();
  assert.strictEqual(t.ctx.state.stack.length, 1, 'still here');
  const a = t.ctx.state.ask;
  assert.strictEqual(a.title, 'Leave without saving?');
  assert.strictEqual(a.body, 'This recipe could not be saved — this recipe still needs an English name. Your changes will be lost.');
  assert.deepStrictEqual([a.confirmLabel, a.danger], ['Leave', true]);
  a.run();
  assert.strictEqual(t.ctx.state.stack.length, 0);
  await t.advance(10000);
  assert.strictEqual(t.writes().length, 0);
});
it('the phone\'s edge swipe cannot wait — the work goes on the wire as the frame comes down', () => {
  const layers = between(M, 'function layers(){', '  // Order first, record second');
  assert.match(layers, /if\(t&&t\.route==='recipeone'\) rcpLeaveNow\(false\);\s*forgetScroll\(\); state\.stack\.pop\(\);/);
  assert.match(M, /if\(rcpAuto&&rcpAuto\.busy\(\)\) return true;/, 'and a reload waits for it (mUnsavedWork)');
});

// ════════════════════════════════════════════════════════════════════════════
section('5 · Details');
// ════════════════════════════════════════════════════════════════════════════
it('every field the desktop\'s Details sheet has, with its hints', async () => {
  const t = await ready(openEdit(stripped()));
  t.ctx.CMD.rcpTab('details');
  const html = t.ctx.screenRecipeOne();
  for (const id of ['name_en', 'name_cn', 'sku', 'category', 'recipe_type', 'batch_size', 'servings', 'serving_size', 'shelf_n', 'shelf_u', 'storage', 'notes']) {
    assert.match(html, new RegExp('id="mRcpF-' + id + '"'), id);
  }
  assert.match(html, /Kept forever, even after archiving\./);
  assert.match(html, /Filing only — it changes nothing about cost\./);
  assert.match(html, /Auto · 2 ingredient lines added up · 1 left out of the batch/);
  assert.match(html, /Auto · 1,620 g ÷ 100 g · 20 g left over/);
  assert.match(html, /id="mRcpF-batch_size" inputmode="decimal" value="1620"\s+readonly/);
});
it('the stored category is kept as a choice even when the list did not load — no silent clear', async () => {
  const t = await ready(openEdit({ ...stripped(), category: 'Old one' }, { handlers: { '/api/retail-admin/recipes/meta/categories': new Error('x') } }));
  t.ctx.CMD.rcpTab('details');
  assert.match(t.ctx.screenRecipeOne(), /<option value="Old one" selected>Old one<\/option>/);
});
it('shelf life: untouched free text is carried through; a number and a unit write "3 days"', async () => {
  const t = await ready(openEdit(stripped()));
  t.ctx.CMD.rcpEdSet('name_cn', 'x'); await t.advance(1200);
  assert.strictEqual(t.writes()[0].body.shelf_life, 'best before date on pack');
  t.ctx.CMD.rcpEdSet('shelf_n', '3'); t.ctx.CMD.rcpEdSet('shelf_u', 'days'); await t.advance(1200);
  assert.strictEqual(t.writes()[1].body.shelf_life, '3 days');
  t.ctx.CMD.rcpEdSet('shelf_n', '1'); await t.advance(1200);
  assert.strictEqual(t.writes()[2].body.shelf_life, '1 day');
});
it('taking the batch size over keeps the figure it showed; handing it back derives again', async () => {
  const t = await ready(openEdit(stripped()));
  t.ctx.CMD.rcpYieldAuto('batch', 0);
  assert.strictEqual(t.ctx.state.rcp.ed.batch_size, '1620');
  t.ctx.CMD.rcpEdSet('batch_size', '5000'); await t.advance(1200);
  let b = t.writes()[0].body;
  assert.deepStrictEqual([b.batch_size, b.batch_size_auto, b.servings], [5000, 0, 50]);
  t.ctx.CMD.rcpTab('details');
  assert.match(t.ctx.screenRecipeOne(), /Typed 5,000 g — bigger than the ingredient total \(1,620 g\)\. Cost per gram divides by 5,000 g\./);
  t.ctx.CMD.rcpYieldAuto('batch', 1); await t.advance(1200);
  b = t.writes()[1].body;
  assert.deepStrictEqual([b.batch_size, b.batch_size_auto], [1620, 1]);
});
it('offline (no cost module) a derived figure is sent as stored, never as nothing', async () => {
  const t = await ready(openEdit(stripped(), { noCostModule: true }));
  t.ctx.CMD.rcpEdSet('sku', 'TS-12'); await t.advance(1200);
  const b = t.writes()[0].body;
  assert.deepStrictEqual([b.batch_size, b.servings], [1620, 16]);
});

// ════════════════════════════════════════════════════════════════════════════
section('6 · Ingredients: the picker, quantity, unit, weight, note, order, remove');
// ════════════════════════════════════════════════════════════════════════════
const MATS = { success: true, data: [
  { id: 900, name_en: 'Sour cream 20%', unit: 'g', cost_per_unit: 0.0253 },
  { id: 902, name_en: 'Dill, fresh', name_cn: '莳萝', sku: 'M-0140', unit: 'g', cost_per_unit: 0.08 },
] };
it('the picker asks the desktop\'s query, leaves out what is already there, and shows no money', async () => {
  const t = await ready(openEdit(stripped(), { handlers: { 'GET /api/retail-admin/materials?for_recipe=1&search=dill': MATS } }));
  t.ctx.CMD.rcpPickQ('dill');
  assert.match(t.els.mRcpPickRes.innerHTML, /Loading…/);
  await t.advance(219);
  assert.ok(!t.calls.req.some((r) => /materials/.test(r.p)), 'debounced');
  await t.advance(1);
  assert.ok(t.calls.req.some((r) => r.p === '/api/retail-admin/materials?for_recipe=1&search=dill'));
  const html = t.els.mRcpPickRes.innerHTML;
  assert.match(html, /Dill, fresh/); assert.doesNotMatch(html, /Sour cream/, 'already a line');
  assert.doesNotMatch(html, /0\.08|¥/);
  t.ctx.CMD.rcpPickAdd(902);
  await t.advance(1200);
  const lines = t.writes()[0].body.ingredients;
  assert.deepStrictEqual(J(lines[3]), { ingredient_id: 902, name_en: 'Dill, fresh', name_cn: '莳萝', sku: 'M-0140', qty: 0, unit: 'g', in_yield: 1, notes: null, substitutes: null });
});
it('the picker: nothing found, and a failed search, each say so', async () => {
  const t = await ready(openEdit(stripped(), { handlers: {
    'GET /api/retail-admin/materials?for_recipe=1&search=zzz': { data: [] },
    'GET /api/retail-admin/materials?for_recipe=1&search=err': new Error('HTTP 500') } }));
  t.ctx.CMD.rcpPickQ('zzz'); await t.advance(220);
  assert.match(t.els.mRcpPickRes.innerHTML, /Nothing matches/);
  t.ctx.CMD.rcpPickQ('err'); await t.advance(220);
  assert.match(t.els.mRcpPickRes.innerHTML, /Could not load materials/);
});
it('quantity, unit, the batch-weight switch, the note, move and remove — all on the request', async () => {
  const t = await ready(openEdit(stripped()));
  t.ctx.CMD.rcpLineSet(0, 'qty', '1400');
  t.ctx.CMD.rcpLineSet(1, 'notes', 'fresh only');
  t.ctx.CMD.rcpLineUnit(1, 'ml');
  t.ctx.CMD.rcpLineYield(2);
  t.ctx.CMD.rcpLineMove(2, -1);
  await t.advance(1200);
  let L = t.writes()[0].body.ingredients;
  assert.deepStrictEqual(L.map((l) => [l.ingredient_id, l.qty, l.unit, l.in_yield, l.notes]),
    [[900, 1400, 'g', 1, null], [901, 500, 'g', 1, null], [55, 120, 'ml', 1, 'fresh only']]);
  t.ctx.CMD.rcpLineRm(1);
  await t.advance(1200);
  L = t.writes()[1].body.ingredients;
  assert.deepStrictEqual(L.map((l) => l.ingredient_id), [900, 55]);
});
it('a line whose unit cannot be costed is marked as it is edited', async () => {
  const t = await ready(openEdit(stripped()));
  t.ctx.CMD.rcpLineUnit(1, 'ml');
  assert.match(t.ctx.screenRecipeOne(), /Tahini dressing[\s\S]*UNIT MISMATCH[\s\S]*This line is counted in ml but the material is stocked in g/);
});
it('the unit list is the desktop\'s (lib/ingredient-cost.js), plus a stored legacy unit shown as itself', async () => {
  const want = IngredientCost.DIVISIBLE_RECIPE_UNITS.concat(IngredientCost.PER_PIECE_RECIPE_UNITS);
  const t = await ready(openEdit({ ...stripped(), ingredients: [{ ...stripped().ingredients[0], unit: 'L' }] }));
  assert.deepStrictEqual(J(t.ctx.RCP_UNITS || vm.runInContext('RCP_UNITS', t.ctx)), want);
  assert.match(t.ctx.screenRecipeOne(), /<option value="L" selected>L<\/option>/);
});

// ════════════════════════════════════════════════════════════════════════════
section('7 · Steps');
// ════════════════════════════════════════════════════════════════════════════
it('add, type, move and remove — in order on the request', async () => {
  const t = await ready(openEdit(stripped()));
  t.ctx.CMD.rcpStepAdd();
  t.ctx.CMD.rcpStepSet(2, 'name', 'Season'); t.ctx.CMD.rcpStepSet(2, 'instructions', 'Salt to taste.');
  t.ctx.CMD.rcpStepMove(2, -1);
  t.ctx.CMD.rcpStepRm(0);
  await t.advance(1200);
  assert.deepStrictEqual(J(t.writes()[0].body.steps), [{ name: 'Season', instructions: 'Salt to taste.' }, { name: null, instructions: 'Chill.' }]);
  t.ctx.CMD.rcpTab('steps');
  const html = t.ctx.screenRecipeOne();
  assert.match(html, /Add step/); assert.match(html, /Step name \(optional\)/); assert.match(html, /Instructions/);
});

// ════════════════════════════════════════════════════════════════════════════
section('8 · version history, and putting one back');
// ════════════════════════════════════════════════════════════════════════════
const VERS = { success: true, data: [
  { id: 7, source: 'auto', actor: 'Mei', line_count: 3, step_count: 2, created_at: '2026-09-29 08:00:00' },
  { id: 6, source: 'restore', actor: 'Ash', line_count: 2, step_count: 1, created_at: '2026-09-28 08:00:00' },
] };
it('pending work goes first, then the list: now, then each filed state, "until" it was replaced', async () => {
  const t = await ready(openEdit(stripped(), { handlers: { 'GET /api/retail-admin/recipes/1/versions': VERS } }));
  t.ctx.CMD.rcpEdSet('sku', 'TS-11');
  t.ctx.CMD.rcpHistory(); await flushMicro();
  const order = t.calls.req.map((r) => r.method + ' ' + r.p);
  assert.ok(order.indexOf('PUT /api/retail-admin/recipes/1') < order.indexOf('GET /api/retail-admin/recipes/1/versions'), order.join(' | '));
  const a = t.ctx.state.ask;
  assert.strictEqual(a.title, 'Version history');
  assert.strictEqual(a.options.length, 3);
  assert.match(a.options[0].label, /^Now — the live recipe<div[^>]*>3 ingredients · 2 steps<\/div>$/);
  assert.match(a.options[1].label, /^until WHEN\(2026-09-29 08:00:00\) · Mei<div[^>]*>3 ingredients · 2 steps · autosaved<\/div>$/);
  assert.match(a.options[2].label, /restored an older version/);
});
it('restore asks in the desktop\'s words, stops the autosave, POSTs, reads back, restarts the editor', async () => {
  const t = await ready(openEdit(stripped(), { handlers: {
    'GET /api/retail-admin/recipes/1/versions': VERS,
    'POST /api/retail-admin/recipes/1/versions/7/restore': { success: true, version_id: 9, held: [] } } }));
  t.ctx.CMD.rcpHistory(); await flushMicro();
  t.ctx.state.ask.run('now');
  assert.strictEqual(t.ctx.state.ask.title, 'Version history', 'the live row is not a thing to restore');
  t.ctx.state.ask.run('7');
  const c = t.ctx.state.ask;
  assert.deepStrictEqual([c.title, c.confirmLabel], ['Restore this version?', 'Restore']);
  assert.match(c.body, /goes back to how it stood until WHEN\(2026-09-29 08:00:00\) — its details, ingredient lines, steps and cost inputs, all four\./);
  c.run(); await flushMicro();
  const w = t.writes();
  assert.deepStrictEqual(w.map((x) => x.method + ' ' + x.p), ['POST /api/retail-admin/recipes/1/versions/7/restore']);
  assert.deepStrictEqual(J(w[0].body), {}, 'the server restores from its own copy — nothing of the screen\'s is sent');
  assert.deepStrictEqual(t.calls.toasts, ['Restored']);
  assert.ok(t.ctx.state.rcp.ed, 'still editing, from the server\'s copy');
  await t.advance(10000);
  assert.strictEqual(t.writes().length, 1, 'the draft that was on screen is never saved over the restore');
});
it('a restore that could not put the SKU back says so', async () => {
  const t = await ready(openEdit(stripped(), { handlers: {
    'GET /api/retail-admin/recipes/1/versions': VERS,
    'POST /api/retail-admin/recipes/1/versions/7/restore': { success: true, held: ['SKU TS-9'] } } }));
  t.ctx.CMD.rcpHistory(); await flushMicro();
  t.ctx.state.ask.run('7'); t.ctx.state.ask.run(); await flushMicro();
  assert.deepStrictEqual(t.calls.toasts, ['Restored — except SKU TS-9, which another recipe now owns.']);
});
it('capability denied: a reader may open the history and put nothing back', async () => {
  const t = mk({ caps: ['recipes:view'], handlers: {
    'GET /api/retail-admin/recipes/1': { data: stripped() }, 'GET /api/retail-admin/recipes/1/versions': VERS } });
  t.ctx.CMD.rcpOpen(1); t.ctx.screenRecipeOne(); await flushMicro();
  assert.doesNotMatch(t.ctx.SUBS.recipeone.cta(), /rcpEdit/, 'no pencil');
  t.ctx.CMD.rcpEdit();
  assert.strictEqual(t.ctx.state.rcp.ed, null, 'and the command refuses');
  assert.strictEqual(t.ctx.SUBS.recipes.cta(), '', 'no New recipe');
  t.ctx.CMD.rcpHistory(); await flushMicro();
  t.ctx.state.ask.run('7');
  assert.strictEqual(t.ctx.state.ask.title, 'Version history', 'tapping a version does nothing');
  assert.strictEqual(t.writes().length, 0);
});
it('no history yet says so; a failed read says so', async () => {
  let t = await ready(openEdit(stripped(), { handlers: { 'GET /api/retail-admin/recipes/1/versions': { data: [] } } }));
  t.ctx.CMD.rcpHistory(); await flushMicro();
  assert.deepStrictEqual(t.calls.toasts, ['No earlier versions yet — this recipe has not been changed since it was created.']);
  t = await ready(openEdit(stripped(), { handlers: { 'GET /api/retail-admin/recipes/1/versions': new Error('HTTP 500') } }));
  t.ctx.CMD.rcpHistory(); await flushMicro();
  assert.deepStrictEqual(t.calls.toasts, ['Could not load history']);
});

// ════════════════════════════════════════════════════════════════════════════
section('9 · the engine and the Chinese');
// ════════════════════════════════════════════════════════════════════════════
it('tacet-autosave.js: maxWait is optional — without it, a steady typist still waits (every other screen)', async () => {
  const eng = require('../public/tacet-autosave.js');
  let sent = 0, v = 0;
  const a = eng.create({ delay: 50, read: () => ({ v }), send: () => { sent++; return Promise.resolve(); } });
  a.start();
  for (let i = 0; i < 5; i++) { v++; a.touch(); await new Promise((r) => setTimeout(r, 20)); }
  assert.strictEqual(sent, 0);
  await new Promise((r) => setTimeout(r, 70));
  assert.strictEqual(sent, 1);
});
it('every Chinese half in the editor is the desktop\'s own', () => {
  for (const zh of ['名称(英文)', '归档后仍永久保留。', '仅用于归类 —— 不影响成本。', '批量大小(克)', '每份克数', '计入批量重量',
    '搜索要添加的物料…', '暂无原料。', '步骤名称(可选)', '操作说明', '添加步骤', '暂无步骤。', '有未保存的更改', '保存中…', '未保存',
    '该食谱还需要填写英文名称', '未保存就离开?', '恢复该版本?', '当前 —— 正在使用的版本', '恢复了旧版本', '无法加载修改记录',
    '手动填写', '按原料合计填写', '自动算出', '新建食谱', '无法加载物料', '上移', '下移', '移除']) {
    assert.ok(DESK.indexOf(zh) !== -1 || fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '18-materials.js'), 'utf8').indexOf(zh) !== -1,
      zh + ' is not the desktop\'s');
    assert.ok(M.indexOf(zh) !== -1, zh + ' is not on the phone');
  }
});

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
