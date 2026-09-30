#!/usr/bin/env node
/**
 * §300 step R5 — Materials on the phone: the desktop's 18-materials.js.
 *
 *   node scripts/test_mobile_materials.js
 *
 * The list (Bought / Made / All, kind chips, search, category, supplier,
 * archived, the row ceiling), the record read and edited with autosave (the
 * price committed only when its field is left), New material with the
 * automatic SKU, the supplier book, Undo, and Archive with the used-by
 * warning. Every write is asserted on its request against the desktop's own
 * readForm() key list.
 *
 * MONEY: shown only with materials:costs, failing closed (no capability, caps
 * loading, a no-money board, a stripped payload). The price is SENT exactly
 * when the server sent it — which keeps a board that hides money from someone
 * holding the capability from wiping it (the server writes an absent price as
 * 0 for such a caller).
 *
 * Harness: test_mobile_recipes_cost.js's (the code RUN with the app's real
 * mCan, the real engine, the real cost modules, a fake clock).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
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
// The record a cost holder receives: FULL, with the server's own computed cost.


// ── What this suite adds: the materials block, its state and push resets ───
const DMAT = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '18-materials.js'), 'utf8');
const IngredientCost = require('../lib/ingredient-cost.js');
const MAT_SRC = between(M, '/* ==========================================================================\n   Materials (§300 step R5)', "SUBS.pick={title:['Pick'");
const MAT_LIT = between(M, '  mat:{rows:null', "skuRule:null,skuHint:'',skuNote:''}") + "skuRule:null,skuHint:'',skuNote:''}";
const MAT_RESETS = ['materials', 'materialone'].map((r) => {
  const mm = PUSH.match(new RegExp("  if\\(route==='" + r + "'\\)\\{[^\\n]*\\}\\n"));
  assert.ok(mm, 'push() has no reset line for ' + r);
  return mm[0];
}).join('');
const DESK_FORM = between(DMAT, '  function readForm() {', '  window.matSave = async function')
  .match(/^\s{6}([a-z_]+):/gm).map((x) => x.trim().replace(':', ''));
function mkMat(opts = {}) {
  const t = mkMoney(opts);
  t.ctx.window.RootsIngredientCost = opts.noIC ? undefined : IngredientCost;
  vm.runInContext('state.mat=({' + MAT_LIT + '}).mat;', t.ctx);
  vm.runInContext(`push=function(route){ if(!canRoute(route)) return; ${RESETS}${MAT_RESETS} state.stack.push({route:route}); render(); };`, t.ctx);
  vm.runInContext(MAT_SRC, t.ctx);
  t.els.mMatBody = { innerHTML: '' };
  return t;
}
const MCOSTS = ['materials:view', 'materials:edit', 'materials:costs', 'purchasing:edit'];
const MNOCOSTS = ['materials:view', 'materials:edit'];
const LROWS = [
  { id: 900, name_en: 'Sour cream 20%', name_cn: '酸奶油', sku: 'M-0012', category: 'Dairy 乳制品', supplier: 'Guangzhou Dairy',
    item_kind: 'food', unit: 'g', buy_unit: 'case', buy_price: 128, cost_per_unit: 0.0256, source_recipe_id: null },
  { id: 901, name_en: 'Tahini dressing', name_cn: '', sku: 'M-0301', item_kind: 'food', unit: 'g', buy_unit: 'kg',
    buy_price: 0, cost_per_unit: 0.0599, source_recipe_id: 7 },
];
const strippedRows = () => J(LROWS).map((x) => { delete x.buy_price; delete x.cost_per_unit; return x; });
const PICKERS = {
  'GET /api/retail-admin/materials/meta/kinds': { data: ['food', 'packaging', 'supplies & more'] },
  'GET /api/retail-admin/materials/meta/categories': { data: ['Dairy 乳制品', 'Cups 杯', 'Office 办公'], byKind: { food: ['Dairy 乳制品'], packaging: ['Cups 杯'] } },
  'GET /api/retail-admin/materials/meta/accounting-categories': { data: ['Food cost 食材成本', 'Packaging 包装'] },
  'GET /api/retail-admin/suppliers': { data: [{ id: 1, name: 'Guangzhou Dairy 广州乳业', is_active: 1 }, { id: 2, name: 'Gone Ltd', is_active: 0 }] },
};
const LIST = (rows = LROWS, extra = {}) => ({ success: true, data: rows, counts: { food: 2, packaging: 5 }, sourceCounts: { bought: 1, made: 1 }, total: rows.length, limit: 500, truncated: false, ...extra });
function listT(opts = {}) {
  const t = mkMat({ caps: MCOSTS, ...opts, handlers: { ...PICKERS, 'GET /api/retail-admin/materials?source=bought': LIST(opts.rows), ...(opts.handlers || {}) } });
  return t;
}
async function list(opts) { const t = listT(opts); t.ctx.screenMaterials(); await flushMicro(); return t; }

// ════════════════════════════════════════════════════════════════════════════
section('1 · the list');
// ════════════════════════════════════════════════════════════════════════════
it('the row, the four pickers, and the desktop\'s default place: Bought', async () => {
  const t = await list();
  const gets = t.calls.req.map((r) => r.p);
  assert.ok(gets.includes('/api/retail-admin/materials?source=bought'));
  for (const p of Object.keys(PICKERS)) assert.ok(gets.includes(p.slice(4)), p);
  assert.strictEqual(t.writes().length, 0);
  const html = t.els.mMatBody.innerHTML;
  assert.match(html, /Sour cream 20%[\s\S]*酸奶油[\s\S]*Food · M-0012 · Dairy 乳制品 · Guangzhou Dairy/);
  assert.match(html, /Tahini dressing[\s\S]*>Made</, 'a made material says so');
  assert.match(html, /<span>Bought<\/span><span class="c">1<\/span>/);
  assert.match(html, /<span>Packaging<\/span><span class="c">5<\/span>/);
});
it('with materials:costs: the buy price per buy unit and the cost per unit, to its places', async () => {
  const html = (await list()).els.mMatBody.innerHTML;
  assert.match(html, /¥128<span[^>]*>\/case/); assert.match(html, /¥0\.0256\/g/);
});
for (const [why, opts] of [['without the capability', { caps: MNOCOSTS }], ['while the caps load', { caps: null }],
  ['on a warehouse board', { pos: 'warehouse' }], ['over a stripped payload', { rows: strippedRows() }]]) {
  it(`no figure ${why}`, async () => {
    const html = (await list(opts)).els.mMatBody.innerHTML;
    assert.ok(html.indexOf('¥') === -1);
  });
}
it('every filter is the server\'s: search (settled), kind (by position), category, supplier, archived, source', async () => {
  const t = await list({ handlers: { 'GET /api/retail-admin/materials?search=dill&source=bought': LIST([]),
    'GET /api/retail-admin/materials?search=dill&kind=supplies%20%26%20more&source=bought': LIST([]),
    'GET /api/retail-admin/materials?search=dill&kind=supplies%20%26%20more&archived=1&source=made': LIST([]) } });
  t.ctx.CMD.matSearch('dill'); await t.advance(249);
  assert.ok(!t.calls.req.some((r) => /search=dill/.test(r.p)), 'settles first');
  await t.advance(1);
  assert.ok(t.calls.req.some((r) => r.p === '/api/retail-admin/materials?search=dill&source=bought'));
  t.ctx.CMD.matKind('2'); await flushMicro();
  assert.ok(t.calls.req.some((r) => r.p === '/api/retail-admin/materials?search=dill&kind=supplies%20%26%20more&source=bought'));
  t.ctx.CMD.matArch(); t.ctx.CMD.matSource('made'); await flushMicro();
  assert.ok(t.calls.req.some((r) => r.p === '/api/retail-admin/materials?search=dill&kind=supplies%20%26%20more&archived=1&source=made'));
});
it('a category that does not belong to the kind picked is dropped', async () => {
  const t = await list();
  t.ctx.CMD.matCatPick(); t.ctx.state.ask.run('0');
  assert.strictEqual(t.ctx.state.mat.cat, 'Dairy 乳制品');
  t.ctx.CMD.matKind('1'); // packaging
  assert.strictEqual(t.ctx.state.mat.cat, '');
  t.ctx.CMD.matSupPick(); t.ctx.state.ask.run('0');
  assert.strictEqual(t.ctx.state.mat.sup, 'Guangzhou Dairy 广州乳业');
});
it('nothing found here but something one tab over says where; Clear widens but keeps the archive and the tab', async () => {
  const t = await list({ rows: [], handlers: { 'GET /api/retail-admin/materials?search=x&source=bought': LIST([], { sourceCounts: { bought: 0, made: 3 } }) } });
  t.ctx.CMD.matSearch('x'); await t.advance(250);
  const html = t.els.mMatBody.innerHTML;
  assert.match(html, /Nothing matches/); assert.match(html, /3 in Made →/); assert.match(html, /Clear the filters/);
  t.ctx.state.mat.arch = true; t.ctx.CMD.matClear();
  assert.deepStrictEqual([t.ctx.state.mat.q, t.ctx.state.mat.arch, t.ctx.state.mat.source], ['', true, 'bought']);
});
it('an empty book offers the first material to an editor only; a failed read says so', async () => {
  let t = await list({ rows: [] });
  assert.match(t.els.mMatBody.innerHTML, /No materials yet[\s\S]*Add your first material/);
  t = await list({ rows: [], caps: ['materials:view'] });
  assert.doesNotMatch(t.els.mMatBody.innerHTML, /Add your first material/);
  assert.strictEqual(t.ctx.SUBS.materials.cta(), '');
  t = await list({ handlers: { 'GET /api/retail-admin/materials?source=bought': new Error('HTTP 500') } });
  assert.match(t.els.mMatBody.innerHTML, /Could not load materials/);
});
it('the row ceiling, in the desktop\'s sentence', async () => {
  const t = await list({ handlers: { 'GET /api/retail-admin/materials?source=bought': LIST(LROWS, { total: 1200, limit: 500, truncated: true }) } });
  assert.match(t.els.mMatBody.innerHTML, /Showing the first 500 of 1,200 materials\./);
});
it('the row is born behind the production switch, beside Recipes, on materials:view', () => {
  assert.match(M, /\['recipes','book-open','Recipes','食谱',null,'production'\],[\s\S]{0,300}\['materials','package','Materials','物料',null,'production'\]\]\}/);
  assert.match(M, /materials:'materials:view', materialone:'materials:view',/);
});

// ════════════════════════════════════════════════════════════════════════════
section('2 · the record, read');
// ════════════════════════════════════════════════════════════════════════════
const MROW = { id: 900, name_en: 'Sour cream 20%', name_cn: '酸奶油', sku: 'M-0012', category: 'Dairy 乳制品', item_kind: 'food',
  unit: 'g', buy_unit: 'case', buy_pack_size: 1, pack_contents_qty: 5000, pack_contents_unit: 'g', buy_price: 128, cost_per_unit: 0.0256,
  free_by_design: 0, supplier: 'Guangzhou Dairy 广州乳业', allergens: 'Milk', notes: 'Keep cold.', accounting_category: 'Food cost 食材成本', is_active: 1 };
const REC = (row = MROW, extra = {}) => ({ success: true, data: row,
  priceHistory: [{ price: 124, buy_unit: 'case', recorded_at: '2026-09-01 10:00:00', source: 'manual' }],
  purchases: [{ po_number: 'RPO-0042', date: '2026-09-14', qty: 2, unit: 'case', total_cost: 256, cost_per_unit: 128 }],
  derived: { cpu: 0.0256, reason: 'divided', gramsPerBuyUnit: 5000 }, usedByRecipes: [], sourceRecipe: null, sourceRecipeBlock: null, ...extra });
function stripRec(r) { const o = J(r); delete o.data.buy_price; delete o.data.cost_per_unit; o.priceHistory = []; o.purchases.forEach((p) => { delete p.total_cost; delete p.cost_per_unit; }); delete o.derived.cpu; return o; }
async function openMat(rec, opts = {}) {
  const t = mkMat({ caps: MCOSTS, ...opts, handlers: { ...PICKERS, 'GET /api/retail-admin/materials?source=bought': LIST(),
    'GET /api/retail-admin/materials/900': rec, 'PUT /api/retail-admin/materials/900': { success: true }, ...(opts.handlers || {}) } });
  t.ctx.screenMaterials(); await flushMicro();
  t.ctx.CMD.matOpen(900); t.ctx.screenMaterialOne(); await flushMicro();
  return t;
}
it('identity, units, the cost line with its arithmetic, supplier, allergens, notes, cost history, bought in', async () => {
  const t = await openMat(REC());
  const html = t.ctx.screenMaterialOne();
  for (const s of ['Identity', 'Kind', 'Food', 'Dairy 乳制品', 'Name (中文)', '酸奶油', 'M-0012', 'Finance category', 'Food cost 食材成本',
    'Units & cost', 'Recipe unit', 'Buy unit', 'case', 'Packs per order', 'Buy price', '¥128', 'Contents per pack', '5,000 g',
    'Cost per unit', '¥0.0256/g', '¥128 ÷ 5000', 'Guangzhou Dairy 广州乳业', 'Allergens', 'Milk', 'Keep cold.',
    'Cost history', '¥124/case', '2026-09-01', 'Bought in', 'RPO-0042', '2026-09-14 · 2 case · ¥256']) {
    assert.ok(html.indexOf(s) !== -1, s);
  }
  assert.strictEqual(t.ctx.SUBS.materialone.titleOf(), 'Sour cream 20%');
});
it('without money: no price, no cost figure, no cost history, the PO lines without their cost', async () => {
  const t = await openMat(stripRec(REC()), { caps: MNOCOSTS });
  const html = t.ctx.screenMaterialOne();
  assert.ok(html.indexOf('¥') === -1);
  assert.doesNotMatch(html, /Cost history|Buy price/);
  assert.match(html, /RPO-0042[\s\S]*2026-09-14 · 2 case</);
});
it('…but the pack diagnosis stays for everyone: a container with no contents says why it cannot be costed', async () => {
  const row = { ...MROW, pack_contents_qty: null, pack_contents_unit: null };
  const t = await openMat(stripRec(REC(row)), { caps: MNOCOSTS });
  assert.match(t.ctx.screenMaterialOne(), /This pack has no recorded contents, so a per-unit cost can’t be worked out\./);
  assert.doesNotMatch(t.ctx.screenMaterialOne(), /No price entered yet/, 'a fact about money this reader cannot know');
});
it('made by a recipe whose rollup is blocked: the recipe and why its cost is frozen', async () => {
  const t = await openMat(REC({ ...MROW, source_recipe_id: 7 }, { sourceRecipe: { id: 7, name_en: 'Tahini dressing', is_active: 1 }, sourceRecipeBlock: { ok: false, reason: 'no_batch_size' } }));
  assert.match(t.ctx.screenMaterialOne(), /Made by recipe: <b[^>]*>Tahini dressing<\/b>[\s\S]*Cost frozen at its last computed value\. This recipe has no batch size set\./);
});
it('a failed read says so', async () => {
  const t = await openMat(new Error('HTTP 500'));
  assert.match(t.ctx.screenMaterialOne(), /Could not open that material/);
});

// ════════════════════════════════════════════════════════════════════════════
section('3 · editing: the desktop\'s body, and the price only where it was loaded');
// ════════════════════════════════════════════════════════════════════════════
it('the key list is the desktop\'s readForm()', () => {
  assert.deepStrictEqual(DESK_FORM, ['name_en', 'name_cn', 'sku', 'category', 'unit', 'buy_unit', 'buy_pack_size', 'pack_contents_qty',
    'pack_contents_unit', 'buy_price', 'free_by_design', 'supplier', 'allergens', 'notes', 'accounting_category', 'item_kind']);
});
it('a cost holder: the name saves on the pause, the whole desktop body, the price as loaded', async () => {
  const t = await openMat(REC());
  assert.match(t.ctx.SUBS.materialone.cta(), /aria-label="Edit"[^>]*onclick="APP\.cmd\('matEdit'\)"/);
  t.ctx.CMD.matEdit();
  assert.strictEqual(t.writes().length, 0);
  t.ctx.CMD.matSet('name_en', 'Sour cream 20% (tub)');
  await t.advance(1200);
  const w = t.writes();
  assert.deepStrictEqual(w.map((x) => x.method + ' ' + x.p), ['PUT /api/retail-admin/materials/900']);
  assert.deepStrictEqual(Object.keys(w[0].body), DESK_FORM);
  assert.deepStrictEqual(J(w[0].body), { name_en: 'Sour cream 20% (tub)', name_cn: '酸奶油', sku: 'M-0012', category: 'Dairy 乳制品',
    unit: 'g', buy_unit: 'case', buy_pack_size: 1, pack_contents_qty: 5000, pack_contents_unit: 'g', buy_price: 128, free_by_design: 0,
    supplier: 'Guangzhou Dairy 广州乳业', allergens: 'Milk', notes: 'Keep cold.', accounting_category: 'Food cost 食材成本', item_kind: 'food' });
});
it('the price is sent when the field is LEFT, never on a pause mid-typing', async () => {
  const t = await openMat(REC());
  t.ctx.CMD.matEdit(); t.ctx.CMD.rcpTab && null;
  const html = t.ctx.screenMaterialOne();
  assert.match(html, /id="mMatF-buy_price" value="128" style="width:100%" inputmode="decimal" onchange="APP\.cmd\('matSet','buy_price',this\.value\)"/);
  assert.match(html, /id="mMatF-name_en"[^>]*oninput=/);
  t.ctx.CMD.matSet('buy_price', '132.5'); await t.advance(1200);
  assert.strictEqual(t.writes()[0].body.buy_price, 132.5);
});
it('a reader without the capability: no price field, and no buy_price key — the server keeps its own', async () => {
  const t = await openMat(stripRec(REC()), { caps: MNOCOSTS });
  t.ctx.CMD.matEdit();
  assert.doesNotMatch(t.ctx.screenMaterialOne(), /mMatF-buy_price/);
  t.ctx.CMD.matSet('name_cn', '酸奶油 20%'); await t.advance(1200);
  const b = t.writes()[0].body;
  assert.ok(!('buy_price' in b) && !('cost_per_unit' in b));
  assert.deepStrictEqual(Object.keys(b), DESK_FORM.filter((k) => k !== 'buy_price'));
  t.ctx.CMD.matSet('buy_price', '0'); await t.advance(1200);
  assert.strictEqual(t.writes().length, 1, 'and nothing can set a price that was never loaded');
});
it('a board that hides money from someone who HOLDS it: no field drawn, the stored price sent back untouched', async () => {
  const t = await openMat(REC(), { pos: 'warehouse' });
  t.ctx.CMD.matEdit();
  assert.doesNotMatch(t.ctx.screenMaterialOne(), /mMatF-buy_price|¥/);
  t.ctx.CMD.matSet('notes', 'x'); await t.advance(1200);
  assert.strictEqual(t.writes()[0].body.buy_price, 128, 'an absent key would have been written as 0 for this caller');
});
it('changing the kind drops a subcategory that is not the new kind\'s, and the allergens block is food-only', async () => {
  const t = await openMat(REC());
  t.ctx.CMD.matEdit();
  t.ctx.CMD.matSetRe('item_kind', 'packaging');
  assert.strictEqual(t.ctx.state.mat.ed.category, '');
  assert.doesNotMatch(t.ctx.screenMaterialOne(), /Allergens/);
  await t.advance(1200);
  assert.deepStrictEqual([t.writes()[0].body.item_kind, t.writes()[0].body.category, t.writes()[0].body.allergens], ['packaging', '', 'Milk'],
    'the allergens are kept, not wiped, while the block is not shown');
});
it('a container buy unit asks for the contents; the cost line follows the typing', async () => {
  const t = await openMat(REC({ ...MROW, buy_unit: 'kg', pack_contents_qty: null, pack_contents_unit: null }));
  t.ctx.CMD.matEdit();
  assert.doesNotMatch(t.ctx.screenMaterialOne(), /mMatF-pack_contents_qty/);
  t.ctx.CMD.matSetRe('buy_unit', 'box');
  assert.match(t.ctx.screenMaterialOne(), /mMatF-pack_contents_qty/);
  const cost = { innerHTML: '' }; t.els.mMatCost = cost;
  t.ctx.CMD.matSet('pack_contents_qty', '2000'); t.ctx.CMD.matSetRe && null;
  t.ctx.state.mat.ed.pack_contents_unit = 'g'; t.ctx.CMD.matSet('buy_pack_size', '1');
  assert.match(cost.innerHTML, /¥0\.0640\/g/, '128 ÷ 2000');
});
it('the supplier: chosen from the book (the whole stored name), or added to it', async () => {
  const t = await openMat(REC(), { handlers: { 'POST /api/retail-admin/suppliers': { success: true, id: 9 } } });
  t.ctx.CMD.matEdit();
  t.ctx.CMD.matSupChoose();
  assert.strictEqual(t.ctx.state.ask.options.length, 2, 'None + the one active supplier');
  assert.strictEqual(t.ctx.state.ask.options[1].label, 'Guangzhou Dairy');
  t.ctx.state.ask.run('0');
  assert.strictEqual(t.ctx.state.mat.ed.supplier, 'Guangzhou Dairy 广州乳业');
  t.ctx.CMD.matSupNew();
  t.ctx.state.ask.run({ name: 'Levant Foods' }); await flushMicro();
  assert.deepStrictEqual(t.writes().filter((x) => /suppliers/.test(x.p)).map((x) => [x.method, x.p, J(x.body)]), [['POST', '/api/retail-admin/suppliers', { name: 'Levant Foods' }]]);
  assert.strictEqual(t.ctx.state.mat.ed.supplier, 'Levant Foods');
  assert.deepStrictEqual(t.calls.toasts, ['Supplier added']);
});
it('an archived supplier of that name is set, not duplicated', async () => {
  const e = new Error('name_taken'); e.code = 'name_taken';
  const t = await openMat(REC(), { handlers: { 'POST /api/retail-admin/suppliers': () => { throw e; } } });
  t.ctx.CMD.matEdit(); t.ctx.CMD.matSupNew(); t.ctx.state.ask.run({ name: 'Gone Ltd 2' }); await flushMicro();
  assert.strictEqual(t.ctx.state.mat.ed.supplier, 'Gone Ltd 2');
  assert.match(t.calls.toasts[0], /already exists \(archived\)/);
});
it('a supplier nobody has in the book is flagged under the field', async () => {
  const t = await openMat(REC());
  t.ctx.CMD.matEdit();
  const note = { textContent: '' }; t.els.mMatSupNote = note;
  t.ctx.CMD.matSet('supplier', 'Nobody Co');
  assert.match(note.textContent, /Not in your supplier book yet/);
});
it('Undo puts the record back to how it was opened, and saves that', async () => {
  const t = await openMat(REC());
  t.ctx.CMD.matEdit();
  t.ctx.CMD.matSet('notes', 'changed'); await t.advance(1200);
  t.ctx.CMD.matUndo(); await flushMicro();
  const w = t.writes();
  assert.strictEqual(w.length, 2);
  assert.strictEqual(w[1].body.notes, 'Keep cold.');
  assert.strictEqual(t.ctx.state.mat.ed.notes, 'Keep cold.');
});
it('a refused save (a SKU another material has) stays on screen; Back asks before dropping it', async () => {
  const e = new Error('SKU "M-1" is already used by "X" (#3).');
  const t = await openMat(REC(), { handlers: { 'PUT /api/retail-admin/materials/900': () => { throw e; } } });
  t.ctx.CMD.matEdit(); t.ctx.CMD.matSet('sku', 'M-1'); await t.advance(1200);
  assert.match(t.ctx.screenMaterialOne(), /Not saved — SKU &quot;M-1&quot; is already used by/);
  t.ctx.pop();
  assert.strictEqual(t.ctx.state.ask.title, 'Leave without saving?');
  assert.strictEqual(t.ctx.state.ask.body, 'Your changes to this material will be lost.');
});
it('capability denied: no pencil, no ⋯, no New material for a reader', async () => {
  const t = await openMat(stripRec(REC()), { caps: ['materials:view'] });
  assert.strictEqual(t.ctx.SUBS.materialone.cta(), '');
  t.ctx.CMD.matEdit(); t.ctx.CMD.matNew(); t.ctx.CMD.matActs();
  assert.strictEqual(t.ctx.state.mat.ed, null);
  assert.strictEqual(t.writes().length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
section('4 · New material, and the automatic SKU');
// ════════════════════════════════════════════════════════════════════════════
it('the desktop\'s defaults; the code the rules would issue is shown, not claimed; the one issued is taken', async () => {
  const t = await list({ handlers: {
    'GET /api/retail-admin/sku/material/next?category=food&subcategory=&name=': { ok: true, sku: 'FD-0001', match_re: '^FD-\\d{4}$' },
    'GET /api/retail-admin/sku/material/next?category=food&subcategory=&name=Dill': { ok: true, sku: 'FD-0002', match_re: '^FD-\\d{4}$' },
    'POST /api/retail-admin/materials': { success: true, id: 950, sku: 'FD-0003' },
    'GET /api/retail-admin/materials/950': REC({ ...MROW, id: 950, name_en: 'Dill', sku: 'FD-0003' }),
    'PUT /api/retail-admin/materials/950': { success: true } } });
  assert.match(t.ctx.SUBS.materials.cta(), /APP\.cmd\('matNew'\)[\s\S]*New material/);
  t.ctx.CMD.matNew(); await flushMicro();
  assert.strictEqual(t.ctx.SUBS.materialone.titleOf(), 'New material');
  assert.match(t.ctx.screenMaterialOne(), /Will be saved as FD-0001 — type your own to override\./);
  t.ctx.CMD.matSet('name_en', 'Dill'); t.ctx.CMD.matSku(); await flushMicro();
  assert.strictEqual(t.ctx.state.mat.skuHint, 'FD-0002');
  t.ctx.CMD.matSet('sku', 'XX'); 
  assert.match(t.ctx.state.mat.skuNote, /Saved as typed\. Codes in this category normally look like FD-0002\./);
  t.ctx.CMD.matSet('sku', '');
  await t.advance(1200);
  const w = t.writes();
  assert.strictEqual(w[0].method + ' ' + w[0].p, 'POST /api/retail-admin/materials');
  assert.deepStrictEqual(J(w[0].body), { name_en: 'Dill', name_cn: '', sku: '', category: '', unit: 'g', buy_unit: 'kg', buy_pack_size: 1,
    pack_contents_qty: null, pack_contents_unit: null, buy_price: 0, free_by_design: 0, supplier: '', allergens: '', notes: '', accounting_category: '', item_kind: 'food' });
  assert.strictEqual(t.ctx.state.mat.ed.sku, 'FD-0003', 'the code the server issued, so the next save cannot blank it');
});
it('for a reader without money a new material carries no price key', async () => {
  const t = await list({ caps: MNOCOSTS, handlers: { 'POST /api/retail-admin/materials': { success: true, id: 950 },
    'GET /api/retail-admin/materials/950': stripRec(REC()) } });
  t.ctx.CMD.matNew(); t.ctx.CMD.matSet('name_en', 'Dill'); await t.advance(1200);
  assert.ok(!('buy_price' in t.writes()[0].body));
});
it('Done with no English name holds, and says why', async () => {
  const t = await list();
  t.ctx.CMD.matNew(); t.ctx.CMD.matDone(); await flushMicro();
  assert.ok(t.ctx.state.mat.ed);
  assert.match(t.ctx.SUBS.materialone.status(), /An English name is required/);
  assert.strictEqual(t.writes().length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
section('5 · Archive and Restore');
// ════════════════════════════════════════════════════════════════════════════
it('used by recipes: the TRUE consequence, named — hidden, not frozen', async () => {
  const t = await openMat(REC(MROW, { usedByRecipes: [{ id: 1, name_en: 'Garlic dill sour cream', name_cn: '蒜香' }] }),
    { handlers: { 'PUT /api/retail-admin/materials/900/archive': { success: true } } });
  t.ctx.CMD.matActs(); t.ctx.state.ask.run('arch');
  const a = t.ctx.state.ask;
  assert.deepStrictEqual([a.title, a.confirmLabel, a.danger], ['Archive this material?', 'Archive anyway', true]);
  assert.strictEqual(a.body, 'Used by 1 recipe (Garlic dill sour cream). Archiving hides &quot;Sour cream 20%&quot; from the materials list and the recipe picker — that recipe keeps costing with it exactly as before, but you won\'t be able to add it to a new recipe until you bring it back.');
  a.run();
  assert.match(t.ctx.SUBS.materialone.status(), /Saving…/);
  await flushMicro();
  assert.deepStrictEqual(t.writes().map((x) => [x.method, x.p, J(x.body)]), [['PUT', '/api/retail-admin/materials/900/archive', { restore: false }]]);
  assert.deepStrictEqual(t.calls.toasts, ['Archived']);
  assert.ok(!t.ctx.state.stack.some((f) => f.route === 'materialone'), 'the record came down');
});
it('unused: keeps its SKU; archived: "Bring this material back?"; a refusal stays', async () => {
  let t = await openMat(REC());
  t.ctx.CMD.matActs(); t.ctx.state.ask.run('arch');
  assert.strictEqual(t.ctx.state.ask.body, 'It keeps its SKU and stays on old purchase orders. You can bring it back later.');
  t = await openMat(REC({ ...MROW, is_active: 0 }), { handlers: { 'PUT /api/retail-admin/materials/900/archive': () => { throw new Error('not_found'); } } });
  t.ctx.CMD.matActs();
  assert.strictEqual(t.ctx.state.ask.options[0].label, 'Restore');
  t.ctx.state.ask.run('arch');
  assert.strictEqual(t.ctx.state.ask.title, 'Bring this material back?');
  t.ctx.state.ask.run(); await flushMicro();
  assert.deepStrictEqual(J(t.writes()[0].body), { restore: true });
  assert.match(t.ctx.screenMaterialOne(), /Failed: not_found/);
});

// ════════════════════════════════════════════════════════════════════════════
section('6 · the words');
// ════════════════════════════════════════════════════════════════════════════
it('every Chinese half is the desktop Materials screen\'s own', () => {
  for (const zh of ['物料', '采购', '自制', '全部', '分类', '供应商', '已归档', '全部分类', '全部供应商', '搜索名称或货号', '无法加载物料',
    '暂无物料', '换个搜索词,或清除筛选条件。', '清除筛选', '新建第一条物料', '新建物料', '无法打开该物料', '基本信息', '单位与成本',
    '类别', '货号', '财务分类', '配方单位', '采购单位', '每次采购包数', '采购价', '每包内容量', '内容量单位', '单位成本', '按设计免费',
    '尚未填写价格。', '未记录本包内容量,无法折算单位成本。', '产出自食谱:', '成本已冻结为最近一次计算的值。', '价格历史', '暂无价格变动记录。',
    '采购记录', '尚未出现在任何采购单中。', '过敏原', '备注', '新建供应商', '输入以搜索供应商', '尚未加入供应商名录', '已添加供应商',
    '该供应商已存在(已归档)', '添加供应商失败', '英文名称必填', '你对该物料的更改将丢失。', '归档该物料?', '仍然归档',
    '其货号会保留,历史采购单不受影响。之后可以恢复。', '恢复该物料?', '将自动生成为', '自动编码已关闭', '符合此分类的编码规则。', '将按输入内容保存。']) {
    assert.ok(DMAT.indexOf(zh) !== -1, zh + ' is not the desktop\'s');
    assert.ok(M.indexOf(zh) !== -1, zh + ' is not on the phone');
  }
});

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
