#!/usr/bin/env node
/**
 * §300 step R1 — everything the desktop Recipes screen SHOWS, on the phone.
 *
 *   node scripts/test_mobile_recipes_read.js
 *
 * Ash, 2026-09-30: "I want recipe full version on mobile … check all feature on
 * PC and bring them to mobile 100%". R1 is the read half, before anything on
 * the phone writes a recipe:
 *
 *   the list    — category filter (a chip that opens the desktop's category
 *                 list), Archived, the row-ceiling notice, the other
 *                 language's name as a second line, and the warnings the
 *                 desktop keeps in a tooltip: missing-cost count, UNIT
 *                 MISMATCH, a Material badge and why its cost is frozen;
 *   the record  — the same warnings above the tabs, UNIT MISMATCH on the line
 *                 it is about (through lib/recipe-cost.js, the shared rule), a
 *                 line that is another recipe marked and opening it, a Details
 *                 tab (SKU, category, type, serving size…), the products it
 *                 makes linking to the product sheet, and "Also stocked as a
 *                 material";
 *   the card    — the desktop's printed recipe card, whose data half is ported
 *                 line for line and held here to the desktop's own function.
 *
 * THE MONEY RULE THIS SUITE HOLDS: no COST figure on any of it, for anybody,
 * even when the server sent one (a `recipes:costs` holder's payload). The one
 * currency figure is a product's sell price beside several products, which the
 * desktop prints to every `recipes:view` holder in the same place.
 *
 * The code is RUN, sliced out of public/m.html into a sandbox — no browser, so
 * this is in the FAST shard and part of the gate.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
const DESK = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '19-recipes.js'), 'utf8');
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
const tick = () => new Promise((r) => setImmediate(r));

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

// ── What is lifted out of m.html ───────────────────────────────────────────
// The recipes region itself, the real small helpers it draws with (so a label
// that is escaped, a pill and a chip row are the app's own), and the three
// reset lines out of push() — the rest of push() is the whole app.
const REGION = between(M, 'const rcpNum = v =>', '/* ── Making one (§167)');
const HELPERS = [
  between(M, 'function E(en, zh){', '\n') + '\n',
  between(M, 'const PILL = {', 'function toggle(on, onClick){'),
  between(M, 'function chipRow(items, current, cmd){', '/* The same row, for a filter'),
  between(M, 'const escAttr=v=>', '\n') + '\n',
  between(M, 'const money=(cur,n)=>', '\n// Whole yuan'),
].join('\n');
const RCP_LIT = between(M, '  rcp:{rows:null', 'scale:1,got:{},step:null}') + 'scale:1,got:{},step:null}';
const PUSH = between(M, 'function push(route){', 'function pop(){');
const RESETS = ['recipes', 'recipeone', 'recipemake'].map((r) => {
  const m = PUSH.match(new RegExp("  if\\(route==='" + r + "'\\)\\{[^\\n]*\\}\\n"));
  assert.ok(m, 'push() has no reset line for ' + r);
  return m[0];
}).join('');
const CAPS = between(M, 'const ROUTE_CAP={', 'function canRoute(');

function mk(opts = {}) {
  const calls = { raw: [], api: [], writes: [], renders: 0, catalogue: 0, opened: [], printed: 0, appended: [] };
  const replies = opts.replies || {};
  const answer = (p) => {
    const r = replies[p];
    if (r instanceof Error) return Promise.reject(r);
    if (r === undefined) return Promise.reject(new Error('HTTP 404'));
    return Promise.resolve(JSON.parse(JSON.stringify(r)));
  };
  const els = {};
  const docEl = { classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); } } };
  const ctx = {
    LANG: opts.lang || 'en',
    T: null, // bound below, after LANG
    ic: (n) => `<i data-ic="${n}"></i>`,
    featOn: () => true, flagGate: () => 'GATED',
    nothingYet: (t, m) => `<div class="nothing">${t}|${m}</div>`,
    desktopNote: () => '<div class="desk">Best edited on desktop</div>',
    noteBar: (t) => `<div class="notebar">${t}</div>`,
    searchBox: (inner) => inner, searchClearShow: () => {},
    CUR: '¥',
    DB: { products: opts.products || [] },
    SUBS: {}, CMD: {},
    state: { stack: [], ask: null, focus: null },
    render: () => { calls.renders++; },
    loadCatalogue: () => { calls.catalogue++; return Promise.resolve(); },
    // api() unwraps the envelope to `data`, as the app's does; apiRaw does not.
    api: (p) => { calls.api.push(p); return answer(p).then((j) => ((j && j.data !== undefined) ? j.data : j)); },
    apiRaw: (p) => { calls.raw.push(p); return answer(p); },
    apiWrite: (p, b, m) => { calls.writes.push({ p, b, m }); return Promise.resolve({}); },
    document: {
      getElementById: (id) => els[id] || null,
      createElement: () => ({ id: '', innerHTML: '' }),
      body: { appendChild: (el) => { els[el.id] = el; calls.appended.push(el); } },
      documentElement: docEl,
      addEventListener: () => {},
    },
    window: {
      RootsRecipeCost: opts.noCostModule ? undefined : RecipeCost,
      print: () => { calls.printed++; },
      addEventListener: () => {},
    },
    Map, Number, String, Array, Object, JSON, Math, Promise, Error, RegExp,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : zh);
  ctx.reg = (n, f) => { ctx.CMD[n] = f; };
  ctx.canRoute = (k) => (opts.denied || []).indexOf(k) === -1;
  // R2's editor is in the same region; this suite reads, so every edit key is
  // simply absent unless a case grants it.
  ctx.mCan = (k) => (opts.caps || []).indexOf(k) !== -1;
  ctx.recapNoMoney = () => false;
  ctx.push = null;
  vm.createContext(ctx);
  vm.runInContext(HELPERS, ctx);
  vm.runInContext('state.rcp=(' + '{' + RCP_LIT + '}' + ').rcp;', ctx);
  vm.runInContext(`push=function(route){ if(!canRoute(route)) return; ${RESETS} state.stack.push({route:route}); render(); };`, ctx);
  vm.runInContext(REGION, ctx);
  ctx.CMD.openProduct = (sku) => calls.opened.push(sku);
  // The list body is a real node on the list screen; handlers patch it.
  if (opts.listMounted) els.mRcpBody = { innerHTML: '' };
  return { ctx, calls, els, docEl };
}

// ── Fixtures ────────────────────────────────────────────────────────────────
// The list as a `recipes:costs` holder receives it — every cost figure present
// — so "no cost on the screen" is proved against data that HAS cost in it.
const ROWS = [
  { id: 1, name_en: 'Garlic dill sour cream', name_cn: '蒜香莳萝酸奶油', sku: 'TS-10', category: 'Sauces 酱料',
    batch_size: 2000, servings: 20, recipe_type: 'made', zeroCostIngredientLines: 0, unreconciledUnitLines: 1,
    batchCost: 86.4, costPerServing: 4.32, costPerGram: 0.0432, backsMaterial: null, materialBlock: null },
  { id: 2, name_en: 'Tahini dressing', name_cn: '芝麻酱汁', sku: 'TS-11', category: 'Sauces 酱料',
    batch_size: 1200, servings: null, recipe_type: 'made', zeroCostIngredientLines: 2, unreconciledUnitLines: 0,
    batchCost: 71.99, costPerServing: null, costPerGram: 0.0599,
    backsMaterial: { id: 55, name_en: 'Tahini dressing', cost_per_unit: 0.0599, unit: 'g' },
    materialBlock: { ok: false, reason: 'unpriced_lines', unpriced: 2 } },
  { id: 3, name_en: 'Pickled turnip', name_cn: '', sku: 'TS-12', category: 'Pickles 腌菜',
    batch_size: 5000, servings: null, recipe_type: 'repacked', zeroCostIngredientLines: 0, unreconciledUnitLines: 0,
    batchCost: 100, costPerServing: null, costPerGram: 0.02,
    backsMaterial: { id: 77, name_en: 'Pickled turnip', cost_per_unit: 0.02, unit: 'g' },
    materialBlock: { ok: true, reason: null, unpriced: 0 } },
];
const LIST = { success: true, data: ROWS, total: 3, limit: 500, truncated: false };
const CATS = { success: true, data: ['Pickles 腌菜', 'Sauces 酱料', "Chef's & Co"] };
const REC = {
  id: 1, name_en: 'Garlic dill sour cream', name_cn: '蒜香莳萝酸奶油', sku: 'TS-10', category: 'Sauces 酱料',
  recipe_type: 'made', batch_size: 2000, servings: 20, serving_size: 100, shelf_life: '6 months',
  storage: 'fridge', notes: 'Label with the date.',
  ingredients: [
    { id: 11, ingredient_id: 900, name_en: 'Sour cream 20%', name_cn: '酸奶油', qty: 1500, unit: 'g',
      master_unit: 'g', master_cost: 0.0253, master_sku: 'M-0012', sku: 'OLD-12' },
    { id: 12, ingredient_id: 55, name_en: 'Tahini dressing', name_cn: '芝麻酱汁', qty: 120, unit: 'g',
      master_unit: 'g', master_cost: 0.0599, master_sku: 'M-0301' },
    { id: 13, ingredient_id: 901, name_en: 'Dill, fresh', name_cn: '', qty: 2, unit: 'ml',
      master_unit: 'g', master_cost: 0.08, notes: 'stalks out' },
    { id: 14, ingredient_id: null, name_en: 'Old salt', name_cn: '旧盐', qty: 18, unit: 'g', master_unit: null, sku: 'S-1' },
  ],
  steps: [{ id: 1, name: 'Mix the base', instructions: 'Whisk until smooth.' }, { id: 2, name: '', instructions: 'Chill.' }],
  costData: { labour: 12, overhead_pct: 8, sell_price: 18, target_food_cost: 30 },
  cost: { zeroCostIngredientLines: 1, unreconciledUnitLines: 1, batchCost: 86.4, costPerServing: 4.32,
    costPerGram: 0.0432, marginPerServing: 13.68, suggestedSellPrice: 14.4, foodCostPct: 24 },
  backsMaterial: { id: 60, name_en: 'Garlic dill sour cream', name_cn: '蒜香莳萝酸奶油', cost_per_unit: 0.0432, unit: 'g' },
  materialBlock: { ok: false, reason: 'no_batch_size', unpriced: 0 },
  products: [
    { id: 301, name_en: 'Sour cream tub 200 g', name_cn: '酸奶油 200克', size: '200g', sell_price: 18, unit_cost: 8.64, build_line_count: 0 },
    { id: 302, name_en: 'Loaded fries', name_cn: '', size: '', sell_price: 38.5, unit_cost: 12.1, build_line_count: 2 },
  ],
};
const COST_FIGURES = ['86.4', '4.32', '0.0432', '0.0253', '0.0599', '13.68', '14.4', '8.64', '12.1', '71.99'];

// ════════════════════════════════════════════════════════════════════════════
section('1 · the list: what is read, and from where');
// ════════════════════════════════════════════════════════════════════════════
it('the live list, the categories, and nothing else — two reads, no writes', async () => {
  const { ctx, calls } = mk({ replies: { '/api/retail-admin/recipes': LIST, '/api/retail-admin/recipes/meta/categories': CATS } });
  ctx.screenRecipes();
  await tick();
  assert.deepStrictEqual(calls.raw, ['/api/retail-admin/recipes'], 'the list, through apiRaw so the envelope survives');
  assert.deepStrictEqual(calls.api, ['/api/retail-admin/recipes/meta/categories'], 'the desktop\'s own category source');
  assert.strictEqual(calls.writes.length, 0);
  assert.strictEqual(ctx.state.rcp.rows.length, 3);
  assert.strictEqual(ctx.state.rcp.cats.length, 3);
});

it('the name in the screen\'s language, and the other one underneath', async () => {
  const { ctx } = mk({ replies: { '/api/retail-admin/recipes': LIST, '/api/retail-admin/recipes/meta/categories': CATS } });
  ctx.screenRecipes(); await tick();
  let html = ctx.rcpBodyHtml();
  assert.ok(html.indexOf('>Garlic dill sour cream</span>') < html.indexOf('>蒜香莳萝酸奶油</span>'), 'English first in English');
  ctx.LANG = 'zh';
  html = ctx.rcpBodyHtml();
  assert.ok(html.indexOf('>蒜香莳萝酸奶油</span>') !== -1 && html.indexOf('>蒜香莳萝酸奶油</span>') < html.indexOf('>Garlic dill sour cream</span>'),
    'Chinese first in Chinese, English under it');
  // A recipe with no Chinese name has no second line — not an empty one, and
  // not the English name twice.
  assert.strictEqual((html.match(/>Pickled turnip<\/span>/g) || []).length, 1);
});

it('the warnings the desktop keeps in a tooltip are written on the row', async () => {
  const { ctx } = mk({ replies: { '/api/retail-admin/recipes': LIST, '/api/retail-admin/recipes/meta/categories': CATS } });
  ctx.screenRecipes(); await tick();
  const html = ctx.rcpBodyHtml();
  const rowOf = (name) => { const a = html.indexOf('>' + name + '<'); const b = html.indexOf('</button>', a); return html.slice(a, b); };
  assert.match(rowOf('Garlic dill sour cream'), /UNIT MISMATCH/, 'the locked pair, with no count in it');
  assert.doesNotMatch(rowOf('Garlic dill sour cream'), /missing cost|>Material</);
  const tahini = rowOf('Tahini dressing');
  assert.match(tahini, /2 ingredients missing cost/);
  assert.match(tahini, />Material</, 'it backs a material');
  assert.match(tahini, /2 ingredients in this recipe are missing a cost\./, 'and says why that material\'s cost is frozen');
  const turnip = rowOf('Pickled turnip');
  assert.match(turnip, />Material</);
  assert.doesNotMatch(turnip, /missing a cost|archived|batch size set/, 'a material that is NOT blocked carries no reason');
});

it('no cost figure on the list, even when the server sent every one', async () => {
  const { ctx } = mk({ replies: { '/api/retail-admin/recipes': LIST, '/api/retail-admin/recipes/meta/categories': CATS } });
  ctx.screenRecipes(); await tick();
  for (const lang of ['en', 'zh']) {
    ctx.LANG = lang;
    const html = ctx.rcpBodyHtml();
    for (const f of COST_FIGURES) assert.ok(html.indexOf(f) === -1, `${f} is on the list (${lang})`);
    assert.ok(html.indexOf('¥') === -1, 'no currency sign on the list');
  }
});

it('Chinese halves are the desktop\'s own sentences', async () => {
  const { ctx } = mk({ lang: 'zh', replies: { '/api/retail-admin/recipes': LIST, '/api/retail-admin/recipes/meta/categories': CATS } });
  ctx.screenRecipes(); await tick();
  const html = ctx.rcpBodyHtml();
  assert.match(html, /2 项原料缺少成本/);
  assert.match(html, /该食谱中有 2 项原料缺少成本。/);
  assert.match(html, /单位不符/);
  assert.match(html, />物料</);
  for (const zh of ['项原料缺少成本', '该食谱中有 ', '单位不符', "'Material', '物料'", "'Archived', '已归档'", "'All categories', '全部分类'"]) {
    assert.ok(DESK.indexOf(zh) !== -1, zh + ' is not the desktop\'s — it was retyped, not lifted');
  }
});

// ════════════════════════════════════════════════════════════════════════════
section('2 · empty, loading, failed');
// ════════════════════════════════════════════════════════════════════════════
it('loading says so; an empty shop says "No recipes yet"', async () => {
  const { ctx } = mk({ replies: { '/api/retail-admin/recipes': { success: true, data: [], total: 0, limit: 500, truncated: false },
    '/api/retail-admin/recipes/meta/categories': { data: [] } } });
  assert.match(ctx.screenRecipes(), /Loading…/);
  await tick();
  assert.match(ctx.rcpBodyHtml(), /No recipes yet/);
});

it('a failed read says so and is not an empty catalogue', async () => {
  const { ctx } = mk({ replies: { '/api/retail-admin/recipes': new Error('HTTP 500'), '/api/retail-admin/recipes/meta/categories': CATS } });
  ctx.screenRecipes(); await tick();
  const html = ctx.rcpBodyHtml();
  assert.match(html, /Could not load recipes\./);
  assert.doesNotMatch(html, /No recipes yet/);
});

it('a failed category read leaves the list working and draws no Category chip', async () => {
  const { ctx } = mk({ replies: { '/api/retail-admin/recipes': LIST, '/api/retail-admin/recipes/meta/categories': new Error('HTTP 500') } });
  ctx.screenRecipes(); await tick();
  const html = ctx.rcpBodyHtml();
  assert.match(html, /Garlic dill sour cream/);
  assert.doesNotMatch(html, /rcpCatPick/);
  assert.match(html, /APP\.cmd\('rcpArch',''\)/, 'Archived is still offered');
});

// ════════════════════════════════════════════════════════════════════════════
section('3 · the row ceiling (audit J-01)');
// ════════════════════════════════════════════════════════════════════════════
it('a list the server cut says how much of it this is', async () => {
  const cut = { success: true, data: ROWS, total: 612, limit: 500, truncated: true };
  const { ctx } = mk({ replies: { '/api/retail-admin/recipes': cut, '/api/retail-admin/recipes/meta/categories': CATS } });
  ctx.screenRecipes(); await tick();
  assert.match(ctx.rcpBodyHtml(), /Showing the first 500 of 612 recipes\./);
  ctx.LANG = 'zh';
  assert.match(ctx.rcpBodyHtml(), /仅显示前 500 条,共 612 个食谱。/);
});
it('and a whole list says nothing', async () => {
  const { ctx } = mk({ replies: { '/api/retail-admin/recipes': LIST, '/api/retail-admin/recipes/meta/categories': CATS } });
  ctx.screenRecipes(); await tick();
  assert.doesNotMatch(ctx.rcpBodyHtml(), /Showing the first/);
});

// ════════════════════════════════════════════════════════════════════════════
section('4 · the category chip');
// ════════════════════════════════════════════════════════════════════════════
it('opens a choice of the shop\'s categories, escaped, keyed by position', async () => {
  const { ctx } = mk({ replies: { '/api/retail-admin/recipes': LIST, '/api/retail-admin/recipes/meta/categories': CATS } });
  ctx.screenRecipes(); await tick();
  assert.match(ctx.rcpBodyHtml(), /APP\.cmd\('rcpCatPick',''\)"><span>Category<\/span><i data-ic="chevron-down">/);
  ctx.CMD.rcpCatPick();
  const a = ctx.state.ask;
  assert.strictEqual(a.title, 'Category');
  assert.strictEqual(a.options.map((o) => o.key).join(','), 'all,0,1,2');
  assert.strictEqual(a.options[0].label, 'All categories ✓', 'nothing picked yet');
  assert.strictEqual(a.options[3].label, 'Chef\'s &amp; Co', 'operator-typed text is escaped');
});
it('picking one narrows the rows AND the chip counts, and lights the chip with its name', async () => {
  const { ctx } = mk({ replies: { '/api/retail-admin/recipes': LIST, '/api/retail-admin/recipes/meta/categories': CATS } });
  ctx.screenRecipes(); await tick();
  ctx.CMD.rcpCatPick(); ctx.state.ask.run('1');
  assert.strictEqual(ctx.state.rcp.cat, 'Sauces 酱料');
  const html = ctx.rcpBodyHtml();
  assert.match(html, /Garlic dill sour cream/); assert.match(html, /Tahini dressing/);
  assert.doesNotMatch(html, /Pickled turnip/);
  assert.match(html, /<span>All<\/span><span class="c">2<\/span>/, 'All counts the category, as the desktop\'s chips do');
  assert.doesNotMatch(html, />Repacked</, 'no repacked recipe in this category, so no chip for it');
  assert.match(html, /class="chip on" onclick="APP\.cmd\('rcpCatPick',''\)"><span>Sauces 酱料<\/span>/);
  ctx.CMD.rcpCatPick(); ctx.state.ask.run('all');
  assert.strictEqual(ctx.state.rcp.cat, '');
});
it('entering the list again drops the category and the archive, and keeps the catalogue', () => {
  const { ctx } = mk();
  Object.assign(ctx.state.rcp, { rows: ROWS, tried: true, q: 'x', type: 'made', cat: 'Sauces 酱料', arch: true });
  ctx.push('recipes');
  assert.deepStrictEqual([ctx.state.rcp.q, ctx.state.rcp.type, ctx.state.rcp.cat, ctx.state.rcp.arch], ['', '', '', false]);
  assert.strictEqual(ctx.state.rcp.rows, ROWS);
});

// ════════════════════════════════════════════════════════════════════════════
section('5 · Archived');
// ════════════════════════════════════════════════════════════════════════════
const ARCH = { success: true, data: [{ id: 8, name_en: 'Old hummus', name_cn: '旧鹰嘴豆泥', recipe_type: 'made', batch_size: 900 }],
  total: 1, limit: 500, truncated: false };
it('the switch reads the archive — the desktop\'s own query — and shows it instead of the live list', async () => {
  const { ctx, calls } = mk({ replies: { '/api/retail-admin/recipes': LIST, '/api/retail-admin/recipes/meta/categories': CATS,
    '/api/retail-admin/recipes?archived=1': ARCH } });
  ctx.screenRecipes(); await tick();
  ctx.CMD.rcpArch();
  ctx.screenRecipes(); await tick();
  assert.deepStrictEqual(calls.raw, ['/api/retail-admin/recipes', '/api/retail-admin/recipes?archived=1']);
  const html = ctx.rcpBodyHtml();
  assert.match(html, /Old hummus/);
  assert.doesNotMatch(html, /Garlic dill sour cream/);
  assert.match(html, /class="chip on" onclick="APP\.cmd\('rcpArch',''\)"><span>Archived/);
  assert.strictEqual(ctx.state.rcp.rows.length, 3, 'the live catalogue is kept — the record reads it');
  assert.strictEqual(ctx.SUBS.recipes.status(), '1 recipe');
  ctx.CMD.rcpArch();
  assert.match(ctx.rcpBodyHtml(), /Garlic dill sour cream/, 'and off again is the live list, with no read');
  assert.strictEqual(calls.raw.length, 2);
});
it('an empty archive is "Nothing matches", not "No recipes yet"', async () => {
  const { ctx } = mk({ replies: { '/api/retail-admin/recipes': LIST, '/api/retail-admin/recipes/meta/categories': CATS,
    '/api/retail-admin/recipes?archived=1': { success: true, data: [], total: 0, limit: 500, truncated: false } } });
  ctx.screenRecipes(); await tick(); ctx.CMD.rcpArch(); ctx.screenRecipes(); await tick();
  const html = ctx.rcpBodyHtml();
  assert.match(html, /Nothing matches/); assert.doesNotMatch(html, /No recipes yet/);
});
it('a failed archive says so and still offers the way back', async () => {
  const { ctx } = mk({ replies: { '/api/retail-admin/recipes': LIST, '/api/retail-admin/recipes/meta/categories': CATS,
    '/api/retail-admin/recipes?archived=1': new Error('HTTP 500') } });
  ctx.screenRecipes(); await tick(); ctx.CMD.rcpArch(); ctx.screenRecipes(); await tick();
  const html = ctx.rcpBodyHtml();
  assert.match(html, /Could not load recipes\./);
  assert.match(html, /APP\.cmd\('rcpArch',''\)/, 'the Archived chip is drawn above the failure');
});
it('a late answer patches the list body, not the search box above it', async () => {
  const { ctx, calls, els } = mk({ listMounted: true,
    replies: { '/api/retail-admin/recipes': LIST, '/api/retail-admin/recipes/meta/categories': CATS } });
  ctx.screenRecipes(); await tick();
  assert.match(els.mRcpBody.innerHTML, /Garlic dill sour cream/);
  assert.strictEqual(calls.renders, 0, 'no full render while the list is mounted');
});

// ════════════════════════════════════════════════════════════════════════════
section('6 · the record');
// ════════════════════════════════════════════════════════════════════════════
function openRec(o = {}) {
  const t = mk({ ...o, replies: { '/api/retail-admin/recipes': LIST, '/api/retail-admin/recipes/meta/categories': CATS,
    '/api/retail-admin/recipes/1': REC, '/api/retail-admin/recipes/2': { ...REC, id: 2, name_en: 'Tahini dressing', name_cn: '芝麻酱汁', products: [], ingredients: [], backsMaterial: null, materialBlock: null }, ...(o.replies || {}) } });
  t.ctx.CMD.rcpOpen(1);
  return t;
}
it('opens by id, reads the record and the live catalogue, and writes nothing', async () => {
  const { ctx, calls } = openRec();
  assert.match(ctx.screenRecipeOne(), /Loading…/);
  await tick();
  assert.deepStrictEqual(calls.api.filter((p) => /\/recipes\/\d/.test(p)), ['/api/retail-admin/recipes/1']);
  assert.ok(calls.raw.indexOf('/api/retail-admin/recipes') !== -1, 'the live list — which line is another recipe');
  assert.strictEqual(calls.writes.length, 0);
  assert.strictEqual(ctx.state.stack[0].rid, 1, 'the frame carries its own id');
});
it('the warnings sit above the tabs, from the server\'s counts', async () => {
  const { ctx } = openRec(); ctx.screenRecipeOne(); await tick();
  const html = ctx.screenRecipeOne();
  const tabs = html.indexOf("APP.cmd('rcpTab','ingredients')");
  assert.ok(html.indexOf('1 ingredient missing cost') !== -1 && html.indexOf('1 ingredient missing cost') < tabs);
  assert.ok(html.indexOf('UNIT MISMATCH') < tabs);
});
it('UNIT MISMATCH on the line it is about, with the desktop\'s locked explanation', async () => {
  const { ctx } = openRec(); ctx.screenRecipeOne(); await tick();
  const html = ctx.screenRecipeOne();
  const dill = html.slice(html.indexOf('>Dill, fresh<'), html.indexOf('>Old salt<'));
  assert.match(dill, /UNIT MISMATCH/);
  assert.match(dill, /This line is counted in ml but the material is stocked in g\./);
  const sour = html.slice(html.indexOf('>Sour cream 20%<'), html.indexOf('>Tahini dressing<'));
  assert.doesNotMatch(sour, /UNIT MISMATCH/);
  ctx.LANG = 'zh';
  assert.match(ctx.screenRecipeOne(), /本条按 ml 计量,而该物料按 g 库存。/);
  assert.ok(DESK.indexOf('两者计量的不是同一类量,系统不作换算,因此本条原料不计入配方成本。') !== -1, 'the Chinese is the desktop\'s');
});
it('without the shared cost module (offline), no line is marked — and the record\'s count still is', async () => {
  const { ctx } = openRec({ noCostModule: true }); ctx.screenRecipeOne(); await tick();
  const html = ctx.screenRecipeOne();
  assert.strictEqual((html.match(/UNIT MISMATCH/g) || []).length, 1, 'the count above the tabs only');
});
it('a line that is another recipe is marked and opens it; Back names where it came from', async () => {
  const { ctx, calls } = openRec(); ctx.screenRecipeOne(); await tick();
  const html = ctx.screenRecipeOne();
  const tahini = html.slice(html.lastIndexOf('<button', html.indexOf('>Tahini dressing<')), html.indexOf('>Dill, fresh<'));
  assert.match(tahini, /APP\.cmd\('rcpOpenSub',2\)/);
  assert.match(tahini, />Recipe</);
  assert.doesNotMatch(html.slice(html.indexOf('>Sour cream 20%<') - 200, html.indexOf('>Sour cream 20%<')), /rcpOpenSub/, 'a bought material is not');
  ctx.CMD.rcpOpenSub(2);
  assert.strictEqual(ctx.state.stack.length, 2);
  assert.deepStrictEqual([ctx.state.stack[1].rid, ctx.state.stack[1].back], [2, 'Garlic dill sour cream']);
  assert.strictEqual(ctx.SUBS.recipeone.backLabel(), 'Garlic dill sour cream');
  ctx.screenRecipeOne(); await tick();
  assert.strictEqual(ctx.SUBS.recipeone.titleOf(), 'Tahini dressing');
  // BACK — the app's or the phone's; either just drops the frame.
  ctx.state.stack.pop();
  assert.strictEqual(ctx.SUBS.recipeone.titleOf(), 'Recipes', 'the parent frame never borrows the child\'s name');
  assert.strictEqual(ctx.SUBS.recipeone.backLabel(), 'Recipes');
  ctx.screenRecipeOne(); await tick();
  assert.strictEqual(ctx.SUBS.recipeone.titleOf(), 'Garlic dill sour cream', 'and the parent is read again');
  assert.deepStrictEqual(calls.api.filter((p) => /\/recipes\/\d/.test(p)),
    ['/api/retail-admin/recipes/1', '/api/retail-admin/recipes/2', '/api/retail-admin/recipes/1']);
});
it('a line whose material was deleted says so', async () => {
  const { ctx } = openRec(); ctx.screenRecipeOne(); await tick();
  assert.match(ctx.screenRecipeOne(), /Old salt[\s\S]*material deleted/);
});
it('the line\'s SKU is the material\'s as it is NOW', async () => {
  const { ctx } = openRec(); ctx.screenRecipeOne(); await tick();
  const html = ctx.screenRecipeOne();
  assert.match(html, /M-0012 · 酸奶油/); assert.doesNotMatch(html, /OLD-12/);
});

section('The Details tab');
it('SKU, category, type, batch, servings, serving size, shelf life, storage, notes, and the other name', async () => {
  const { ctx } = openRec(); ctx.screenRecipeOne(); await tick();
  ctx.CMD.rcpTab('details');
  const html = ctx.screenRecipeOne();
  for (const s of ['Name (中文)', '蒜香莳萝酸奶油', 'SKU', 'TS-10', 'Category', 'Sauces 酱料', 'Type', 'Made',
    'Batch size', '2,000 g', 'Servings', 'Serving size (g)', '100', 'Shelf life', '6 Months', 'Storage', 'Fridge', 'Label with the date.']) {
    assert.ok(html.indexOf(s) !== -1, s + ' is missing');
  }
  ctx.LANG = 'zh';
  const zh = ctx.screenRecipeOne();
  assert.match(zh, /名称\(英文\)[\s\S]*Garlic dill sour cream/);
  assert.match(zh, /6 个月/, 'the stored "6 months" read back in Chinese, not printed raw');
  assert.match(zh, /冷藏/);
});
it('what it makes: each product by name, linking to the product sheet when the sheet can find it', async () => {
  const { ctx, calls } = openRec({ products: [{ _id: 301, sku: 'SKU 10231' }] });
  ctx.screenRecipeOne(); await tick();
  assert.strictEqual(calls.catalogue, 1, 'the catalogue the product sheet reads is asked for');
  ctx.CMD.rcpTab('details');
  const html = ctx.screenRecipeOne();
  assert.match(html, />Makes</);
  assert.match(html, /APP\.cmd\('rcpProduct',301\)[\s\S]*Sour cream tub 200 g/);
  assert.doesNotMatch(html, /rcpProduct',302/, 'a product the sheet cannot find is a name, not a dead tap');
  ctx.CMD.rcpProduct(301);
  assert.deepStrictEqual(calls.opened, ['SKU 10231']);
  // Several products: the sell price each (the desktop's Sells column) — and
  // never the product's cost, nor a margin, which is the cost by subtraction.
  assert.match(html, />Sells</); assert.match(html, />¥18</); assert.match(html, />¥38\.50</);
  for (const f of ['8.64', '12.1']) assert.ok(html.indexOf(f) === -1, f);
  assert.doesNotMatch(html, /Margin|毛利/);
});
it('one product: its name only — its price belongs to the cost strip, which is not drawn', async () => {
  const one = { ...REC, products: [REC.products[0]] };
  const { ctx } = openRec({ replies: { '/api/retail-admin/recipes/1': one } });
  ctx.screenRecipeOne(); await tick(); ctx.CMD.rcpTab('details');
  const html = ctx.screenRecipeOne();
  assert.match(html, /Sour cream tub 200 g/);
  assert.doesNotMatch(html, /¥|>Sells</);
});
it('capability denied: no products:view, no product link and no catalogue read', async () => {
  const { ctx, calls } = openRec({ denied: ['products'], products: [{ _id: 301, sku: 'SKU 10231' }] });
  ctx.screenRecipeOne(); await tick(); ctx.CMD.rcpTab('details');
  const html = ctx.screenRecipeOne();
  assert.strictEqual(calls.catalogue, 0);
  assert.doesNotMatch(html, /rcpProduct/);
  assert.match(html, /Sour cream tub 200 g/, 'the fact is still there');
});
it('makes nothing → draws nothing', async () => {
  const { ctx } = openRec({ replies: { '/api/retail-admin/recipes/1': { ...REC, products: [] } } });
  ctx.screenRecipeOne(); await tick(); ctx.CMD.rcpTab('details');
  assert.doesNotMatch(ctx.screenRecipeOne(), />Makes</);
});
it('"Also stocked as a material", and why its cost is frozen — without the cost', async () => {
  const { ctx } = openRec(); ctx.screenRecipeOne(); await tick(); ctx.CMD.rcpTab('details');
  const html = ctx.screenRecipeOne();
  assert.match(html, /Also stocked as a material: <b[^>]*>Garlic dill sour cream<\/b> — frozen at its last computed value\. This recipe has no batch size set\./);
  ctx.LANG = 'zh';
  assert.match(ctx.screenRecipeOne(), /同时作为物料备货:<b[^>]*>蒜香莳萝酸奶油<\/b> — 已冻结为最近一次计算的值。 该食谱未设置批量大小。/);
});
it('no cost figure anywhere on the record, in any tab or language, from a payload full of them', async () => {
  const { ctx } = openRec({ products: [{ _id: 301, sku: 'SKU 10231' }] }); ctx.screenRecipeOne(); await tick();
  for (const lang of ['en', 'zh']) for (const tab of ['ingredients', 'steps', 'details']) {
    ctx.LANG = lang; ctx.CMD.rcpTab(tab);
    const html = ctx.screenRecipeOne() + ctx.SUBS.recipeone.status() + ctx.SUBS.recipeone.cta();
    for (const f of COST_FIGURES) assert.ok(html.indexOf(f) === -1, `${f} on ${tab} (${lang})`);
  }
});
it('a failed record read says so', async () => {
  const { ctx } = openRec({ replies: { '/api/retail-admin/recipes/1': new Error('HTTP 500') } });
  ctx.screenRecipeOne(); await tick();
  assert.match(ctx.screenRecipeOne(), /Could not load recipes\./);
});
it('the record for somebody without recipes:costs — the server\'s stripped shape — draws the same', async () => {
  const stripped = JSON.parse(JSON.stringify(REC));
  delete stripped.costData; stripped.cost = { zeroCostIngredientLines: 1, unreconciledUnitLines: 1 };
  stripped.ingredients.forEach((l) => delete l.master_cost);
  stripped.products.forEach((p) => delete p.unit_cost);
  delete stripped.backsMaterial.cost_per_unit;
  const { ctx } = openRec({ replies: { '/api/retail-admin/recipes/1': stripped } });
  ctx.screenRecipeOne(); await tick();
  const html = ctx.screenRecipeOne();
  assert.match(html, /1 ingredient missing cost/); assert.match(html, /UNIT MISMATCH/);
});

// ════════════════════════════════════════════════════════════════════════════
section('7 · the recipe card');
// ════════════════════════════════════════════════════════════════════════════
// THE DESKTOP'S OWN FUNCTION, RUN. recipePrintCard() is private to the
// 19-recipes.js closure, so it and the four things it reads are sliced out and
// given the same recipe the phone is. Any drift in what the card says — a fact
// dropped, an order changed, a unit spelled differently — fails here.
function desktopCard() {
  const src = [
    between(DESK, '  const STORAGE_OPTIONS = [', '  const SHELF_LIFE_UNITS = ['),
    between(DESK, '  const SHELF_LIFE_UNITS = [', '  // Reads a stored'),
    between(DESK, '  function parseShelfLife(raw) {', '  // ── module state'),
    between(DESK, '  function lineSku(l) {', '  function lineRow(l, idx) {'),
    between(DESK, '  function recipePrintCard(details, lines, steps) {', '  window.rcpPrint = function'),
  ].join('\n');
  const c = { Number, String, Math };
  vm.createContext(c);
  vm.runInContext(src + '\nthis.recipePrintCard = recipePrintCard;', c);
  return c.recipePrintCard;
}
const shapes = [
  REC,
  { ...REC, shelf_life: '1 day', storage: 'room_temp', serving_size: null, name_cn: '' },
  { ...REC, shelf_life: 'best before date on pack', storage: '', servings: null, sku: '', notes: '' },
  { ...REC, shelf_life: '2 years', storage: 'freezer', ingredients: [{ name_en: '', name_cn: '' }, { name_en: 'Oats', qty: '', unit: 'g', sku: 'X' }] },
];
it('the phone\'s card is the desktop\'s card, field for field, across four shapes of recipe', () => {
  const desk = desktopCard();
  const { ctx } = mk();
  shapes.forEach((rec, i) => {
    const d = ctx.rcpPrintDetails(rec);
    const phone = JSON.parse(JSON.stringify(ctx.rcpPrintCard(d, rec.ingredients, rec.steps)));
    const want = JSON.parse(JSON.stringify(desk(d, rec.ingredients, rec.steps)));
    assert.deepStrictEqual(phone, want, 'shape ' + i);
  });
});
it('the card carries no money — the input has none to give it', () => {
  const { ctx } = mk();
  const html = ctx.rcpCardHtml(ctx.rcpPrintCard(ctx.rcpPrintDetails(REC), REC.ingredients, REC.steps).card);
  // The sell prices too: a card on a kitchen wall carries no figure of money.
  for (const f of COST_FIGURES.concat(['38.5', '¥'])) assert.ok(html.indexOf(f) === -1, f + ' on the card');
  assert.doesNotMatch(codeOnly(between(M, 'function rcpPrintDetails(rec){', "reg('rcpPrint'")),
    /cost|price|margin|money|labour|overhead/i, 'nothing on the card\'s path reads a money key');
});
it('both languages, in the desktop card\'s order: names, facts, ingredients (amount first), steps, notes', () => {
  const { ctx } = mk({ lang: 'zh' });
  const html = ctx.rcpCardHtml(ctx.rcpPrintCard(ctx.rcpPrintDetails(REC), REC.ingredients, REC.steps).card);
  const at = (s) => { const i = html.indexOf(s); assert.notStrictEqual(i, -1, s); return i; };
  assert.ok(at('Garlic dill sour cream') < at('蒜香莳萝酸奶油'));
  assert.ok(at('Servings · 份数') < at('SKU · 货号') && at('SKU · 货号') < at('Shelf life · 保质期') && at('Shelf life · 保质期') < at('Storage · 储存方式'));
  assert.match(html, /6 Months · 6 个月/); assert.match(html, /Fridge · 冷藏/); assert.match(html, /20 × 100 g/);
  assert.ok(at('Ingredients<span>原料') < at('Steps<span>步骤') && at('Steps<span>步骤') < at('Notes<span>备注'));
  assert.match(html, /<span class="rc-qty">1500 g<\/span>\s*<span class="rc-nm">Sour cream 20%<br>酸奶油<\/span>/, 'the amount first, bold');
  assert.match(html, /stalks out/, 'the line note prints beside it');
});
it('the print view names what will print in English only, above the card', async () => {
  const { ctx } = openRec(); ctx.screenRecipeOne(); await tick();
  ctx.CMD.rcpPrint();
  assert.strictEqual(ctx.state.stack[ctx.state.stack.length - 1].route, 'recipeprint');
  const html = ctx.screenRecipePrint();
  assert.match(html, /Add a name in Chinese: Dill, fresh/);
  assert.ok(html.indexOf('Add a name in Chinese') < html.indexOf('class="rcpcard"'));
  assert.strictEqual(ctx.SUBS.recipeprint.titleOf(), 'Garlic dill sour cream', 'it is about the record under it');
});
it('Print puts the card, and only the card, on paper — and writes nothing', async () => {
  const { ctx, calls, docEl, els } = openRec(); ctx.screenRecipeOne(); await tick();
  ctx.CMD.rcpPrint();
  assert.match(ctx.SUBS.recipeprint.cta(), /APP\.cmd\('rcpPrintNow'\)[\s\S]*Print/);
  ctx.CMD.rcpPrintNow();
  assert.strictEqual(calls.printed, 1);
  assert.ok(docEl.classList.set.has('m-print'));
  assert.ok(els.mPrintHost && /class="rcpcard"/.test(els.mPrintHost.innerHTML), 'the card is in the print host beside #app');
  assert.strictEqual(calls.writes.length, 0);
  assert.match(M, /html\.m-print body>\*:not\(#mPrintHost\)\{display:none!important\}/, 'and the print sheet hides everything else');
});
// §300 R4 moved Print into the record's ⋯ menu with the other actions; it is
// offered there to every reader, as the route is.
it('Print is in the record\'s ⋯ menu, for every reader', async () => {
  const { ctx } = openRec(); ctx.screenRecipeOne(); await tick();
  assert.match(ctx.SUBS.recipeone.cta(), /aria-label="More actions"[^>]*onclick="APP\.cmd\('rcpActs'\)"/);
  ctx.CMD.rcpActs();
  assert.strictEqual(ctx.state.ask.options[0].key, 'print');
  assert.match(CAPS, /recipeprint:'recipes:view'/);
});

// ════════════════════════════════════════════════════════════════════════════
section('8 · what R1 does not do');
// ════════════════════════════════════════════════════════════════════════════
// §300 R2 put the editor in this region; its writes are held to their own
// suite (test_mobile_recipes_edit.js). What stays true here is that the READ
// screens make none: every write lives in the two functions that save.
it('the only writes in the recipes region are the editor\'s save and restore', () => {
  const writes = codeOnly(REGION).match(/apiWrite\([^)]*/g) || [];
  // Four since R3: PUT, POST, the cost PUT (only for a draft that loaded the
  // cost inputs) and the restore. Three more since R4, each an action in the
  // ⋯ menu: archive/restore, unlink, make available.
  assert.strictEqual(writes.length, 7, writes.join(' | '));
  const saver = codeOnly(between(M, 'function rcpSend(d, p, note){', 'function rcpEdStart(d){'));
  const restore = codeOnly(between(M, 'function rcpRestore(id, v){', 'function rcpLeaveNow(discard){'));
  const acts = codeOnly(between(M, '/* ── The record\'s ⋯ menu (§300 step R4)', '/* ── Making one (§167)'));
  assert.strictEqual((saver.match(/apiWrite\(/g) || []).length + (restore.match(/apiWrite\(/g) || []).length, 4);
  assert.strictEqual((acts.match(/apiWrite\(/g) || []).length, 3);
  assert.match(acts, /apiWrite\('\/api\/retail-admin\/recipes\/'\+id\+'\/archive', \{restore:restoring\}, 'PUT'\)/);
  assert.match(acts, /apiWrite\('\/api\/retail-admin\/recipes\/'\+id\+'\/materialize', \{\}, 'DELETE'\)/);
  assert.match(acts, /apiWrite\('\/api\/retail-admin\/recipes\/'\+Number\(rec\.id\)\+'\/materialize', body, 'POST'\)/);
  assert.doesNotMatch(codeOnly(REGION), /apiPost|method:\s*'(POST|PUT|PATCH|DELETE)'/);
});
it('the shared cost module is loaded, deferred, and the service worker still lets it through to the network', () => {
  assert.match(M, /<script src="\/lib\/recipe-cost\.js" defer><\/script>/);
  const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
  assert.match(sw, /if \(url\.pathname === '\/lib\/recipe-cost\.js'\) return;/);
  assert.doesNotMatch(sw.match(/const SHELL = \[[^\]]*\]/)[0], /recipe-cost/, 'never precached — yesterday\'s cost rule');
});
it('chipRow draws a plain chip exactly as before (every other caller)', () => {
  const { ctx } = mk();
  assert.strictEqual(ctx.chipRow([{ key: 'a', en: 'A', zh: '甲', count: 2 }, { key: 'b', en: 'B', zh: '乙' }], 'a', 'go'),
    '<div class="hscroll" style="display:flex;gap:8px;padding:0 16px"><button class="chip on" onclick="APP.cmd(\'go\',\'a\')"><span>A</span><span class="c">2</span></button>'
    + '<button class="chip " onclick="APP.cmd(\'go\',\'b\')"><span>B</span></button></div>');
});

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
