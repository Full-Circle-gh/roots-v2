#!/usr/bin/env node
// Proves the product detail page still builds and renders after the dead
// recipe-cost block was cut out of _loadProductCtx().
//
// Run:  node scripts/test_product_ctx_no_cost.js
//
// WHY THIS EXISTS
// ---------------
// _loadProductCtx() used to compute a full recipe cost breakdown into
// `costInfo` and return it on ctx. Nothing read it — the product page has never
// displayed a cost — so step 2 of the recipe-cost consolidation deleted it
// rather than porting it onto lib/recipe-cost.js. Deleting a field off an
// object that nine renderers destructure is the kind of change that looks safe
// and throws on one screen, so this runs the whole set.
//
// The half of that block that was NOT dead is the allergen derivation, which
// reads the linked recipe's ingredients. It is asserted positively here so a
// later "tidy the recipe fetch away" cannot pass silently.
//
// HOW IT RUNS THE REAL CODE
// -------------------------
// It executes public/app.html's entire inline <script> — the source the browser
// runs, verbatim — inside a vm context with a permissive DOM, then calls
// _loadProductCtx() and every ctx consumer.
//
// Everything happens inside ONE script, deliberately. The page declares its
// state with top-level `let` (`let _ingredients = []`), and a top-level `let` in
// a vm script is a lexical binding, not a property of the global object: a
// later runInContext() call cannot see it or assign to it. Appending the test
// body to the page source puts this code in the same scope, so it can seed the
// page's own globals the way a logged-in session would.
//
// An earlier version extracted individual functions by counting braces. That
// does not work here — these renderers are mostly template literals full of
// `${...}` and inline CSS, so a brace counter that does not model strings
// truncates a body and runs it into the next function. The failure then looks
// like a missing binding: a defect reported against the page that is really a
// defect in the harness.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'app.html'), 'utf8');

const CONSUMERS = [
  '_renderProdTopBar', '_renderProdHero', '_renderRecipeDietCard', '_renderDescCard',
  '_renderNotesCard', '_renderProdEssentialsCard', '_renderLessUsedCard',
  '_renderBundleCard', '_renderSizesCardInner',
];

// The page's largest inline <script> is its application code.
function mainScript() {
  const re = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, best = '';
  while ((m = re.exec(html))) if (m[1].length > best.length) best = m[1];
  if (!best.trim()) throw new Error('no inline <script> block found in public/app.html');
  return best;
}
const PAGE = mainScript();

let failures = 0, checks = 0;
function assert(cond, msg) { checks++; if (cond) console.log('  PASS  ' + msg); else { failures++; console.log('  FAIL  ' + msg); } }

// A DOM node that tolerates anything. The page itself is not under test —
// _loadProductCtx and the nine ctx consumers are — so the environment only has
// to be permissive enough that module-level setup runs without throwing.
function makeNode() {
  const target = {};
  return new Proxy(target, {
    get(t, k) {
      if (k === 'value' || k === 'textContent' || k === 'innerHTML' || k === 'innerText') return t[k] === undefined ? '' : t[k];
      if (k === 'style' || k === 'dataset') return t[k] || (t[k] = {});
      if (k === 'classList') return { add() {}, remove() {}, toggle() {}, contains: () => false };
      if (k === 'children' || k === 'childNodes') return [];
      if (k === 'checked') return false;
      if (k === 'files') return [];
      if (k === 'parentNode' || k === 'parentElement') return null;
      if (k === Symbol.toPrimitive) return () => '';
      if (k === 'toString') return () => '[node]';
      if (k === 'then') return undefined;            // never look thenable
      if (k in t) return t[k];
      return () => makeNode();
    },
    set(t, k, v) { t[k] = v; return true; },
    has() { return true; },
  });
}

function makeSandbox(product, recipe, opts) {
  opts = opts || {};
  const doc = {
    getElementById: () => makeNode(),
    querySelector: () => makeNode(),
    querySelectorAll: () => [],
    createElement: () => makeNode(),
    createTextNode: () => makeNode(),
    addEventListener() {}, removeEventListener() {},
    body: makeNode(), head: makeNode(), documentElement: makeNode(),
    cookie: '', readyState: 'complete', title: '',
  };
  const sandbox = {
    console,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    queueMicrotask: (fn) => Promise.resolve().then(fn),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
    location: { pathname: '/', search: '', href: 'http://localhost/', hash: '', reload() {}, replace() {} },
    history: { pushState() {}, replaceState() {}, back() {} },
    navigator: { userAgent: 'node', language: 'en', onLine: true, serviceWorker: { register: () => Promise.resolve(), addEventListener() {}, ready: Promise.resolve() } },
    document: doc,
    URL, URLSearchParams, TextEncoder, TextDecoder, Intl,
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    alert() {}, confirm: () => true, prompt: () => null,
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    // Browser APIs the page arms at module level. Inert stubs: this test is
    // about _loadProductCtx and the ctx consumers, not about observers firing.
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    performance: { now: () => 0, mark() {}, measure() {} },
    Notification: class { static requestPermission() { return Promise.resolve('denied'); } },
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    Image: class { set src(_v) {} },
    FileReader: class { readAsDataURL() {} },
    Blob: class {}, FormData: class { append() {} },
    EventSource: class { addEventListener() {} close() {} },
    WebSocket: class { addEventListener() {} send() {} close() {} },
    CustomEvent: class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } },
    Event: class { constructor(t) { this.type = t; } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    scrollTo() {}, open: () => null, print() {}, focus() {}, close() {},
    // The two endpoints _loadProductCtx touches; everything else is inert.
    async fetch(url) {
      const u = String(url);
      if (u.includes('/api/products/')) return { ok: true, status: 200, json: async () => ({ success: true, data: product }) };
      if (u.includes('/api/recipes/')) {
        if (opts.recipeFetchThrows) throw new Error('simulated network failure');
        return { ok: true, status: 200, json: async () => (recipe ? { success: true, data: recipe } : { success: false }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: false, data: [] }) };
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  return sandbox;
}

// The test body, appended to the page source so it shares the page's scope and
// can seed the `let` globals a logged-in session would have populated.
function epilogue(opts) {
  return `
;(async () => {
  _ingredients = ${JSON.stringify(opts.ingredients || [])};
  _products = [];
  _recipes = ${JSON.stringify(opts.recipes || [])};
  _user = { id: 1, role: 'admin', username: 'probe' };
  if (typeof _pdAutosave !== 'undefined') _pdAutosave = true;
  if (typeof _pdQueue !== 'undefined') _pdQueue.length = 0;
  const out = { errors: [], ctx: null, rendered: {} };
  try {
    out.ctx = await _loadProductCtx(1);
  } catch (e) { out.errors.push('_loadProductCtx: ' + (e && e.message)); }
  if (out.ctx) {
    out.ctxKeys = Object.keys(out.ctx);
    out.allergens = out.ctx.allergens;
    for (const fn of ${JSON.stringify(CONSUMERS)}) {
      try {
        const r = (typeof globalThis[fn] === 'function' ? globalThis[fn] : eval(fn))(out.ctx);
        out.rendered[fn] = typeof r;
      } catch (e) { out.errors.push(fn + ': ' + (e && e.message)); }
    }
  }
  globalThis.__result = out;
})();
`;
}

const RECIPE = {
  id: 7, name_en: 'Hummus', name_cn: '鹰嘴豆泥', servings: 10, batch_size: 2000,
  ingredients: [
    { ingredient_id: 1, sku: 'C1', name_en: 'Chickpeas', qty: 1500, unit: 'g', master_cost: 0.012, master_free: 0 },
    { ingredient_id: 2, sku: 'W1', name_en: 'Water', qty: 300, unit: 'g', master_cost: 0, master_free: 1 },
  ],
  costData: { labour: 25, packaging: 1.5, overhead_pct: 10, sell_price: 38, target_food_cost: 25 },
};
const INGREDIENTS = [
  { id: 1, sku: 'C1', name_en: 'Chickpeas', allergens: 'sesame, nuts' },
  { id: 2, sku: 'W1', name_en: 'Water', allergens: '' },
];

async function runCase(label, product, recipe, opts) {
  opts = opts || {};
  console.log(`\n── ${label} ──`);
  const sandbox = makeSandbox(product, recipe, opts);
  vm.createContext(sandbox);
  try {
    vm.runInContext(PAGE + epilogue(opts), sandbox, { timeout: 30000 });
  } catch (e) {
    assert(false, `the page script threw while loading: ${e && e.message}`);
    return null;
  }
  // Let the async epilogue settle.
  for (let i = 0; i < 50 && !sandbox.__result; i++) await new Promise(r => setImmediate(r));
  const out = sandbox.__result;
  if (!out) { assert(false, 'the test epilogue never completed'); return null; }

  assert(out.errors.length === 0,
    out.errors.length ? `no throw from ctx build or any renderer — got: ${out.errors.join(' | ')}`
                      : 'no throw from ctx build or any renderer');
  assert(out.ctx !== null, '_loadProductCtx returned a ctx');
  if (!out.ctx) return null;
  assert(!out.ctxKeys.includes('costInfo'), `ctx carries NO costInfo key (keys: ${out.ctxKeys.join(', ')})`);
  assert(Array.isArray(out.allergens), 'ctx.allergens is still an array');
  const ran = Object.keys(out.rendered).length;
  assert(ran === CONSUMERS.length, `all ${CONSUMERS.length} ctx consumers ran (${ran} did)`);
  return out;
}

(async () => {
  console.log('══ product detail ctx, after the dead cost block was removed ══');

  const c1 = await runCase(
    'product with a linked recipe (allergens must survive)',
    { id: 1, name_en: 'Hummus Tub', sku: 'P1', recipe_id: 7, sell_price: 30, free_of: 'gluten' },
    RECIPE, { ingredients: INGREDIENTS },
  );
  if (c1 && c1.allergens) {
    assert(c1.allergens.includes('sesame') && c1.allergens.includes('nuts'),
      `allergens derived from the linked recipe: [${c1.allergens.join(', ')}]`);
  }

  const c2 = await runCase(
    'product whose recipe is inlined on the payload',
    { id: 1, name_en: 'Inlined', sku: 'P2', recipe_id: 7, sell_price: 20, recipe: RECIPE },
    null, { ingredients: INGREDIENTS },
  );
  if (c2 && c2.allergens) assert(c2.allergens.length === 2, 'allergens derived from the inlined recipe');

  const c3 = await runCase(
    'product with no recipe_id',
    { id: 1, name_en: 'No Recipe', sku: 'P3', recipe_id: null, sell_price: 12 },
    null, {},
  );
  if (c3 && c3.allergens) assert(c3.allergens.length === 0, 'no allergens, no throw');

  const c4 = await runCase(
    'product whose recipe fetch throws (catch path)',
    { id: 1, name_en: 'Broken Fetch', sku: 'P4', recipe_id: 7, sell_price: 15 },
    RECIPE, { ingredients: INGREDIENTS, recipeFetchThrows: true },
  );
  if (c4 && c4.allergens) assert(c4.allergens.length === 0, 'fetch failure is swallowed, ctx still usable');

  // Source-level: the computation is really gone, and the live half really stays.
  console.log('\n── source-level ──');
  const start = PAGE.indexOf('async function _loadProductCtx(');
  const ctxSrc = PAGE.slice(start, PAGE.indexOf('\nfunction _renderProdTopBar', start));
  const noComments = ctxSrc.replace(/\/\/[^\n]*/g, '');
  assert(start > -1, '_loadProductCtx found in the page source');
  assert(!/costInfo/.test(noComments), '_loadProductCtx source has no costInfo outside comments');
  assert(!/cpServ|batchCost|packagingBatch|overheadBatch|prodMissing/.test(noComments),
    '_loadProductCtx source carries no cost arithmetic at all');
  assert(/allergenSet/.test(ctxSrc), '_loadProductCtx still derives allergens (the live half of that block)');

  console.log(`\n══ ${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks passed ══`);
  process.exit(failures === 0 ? 0 : 1);
})();
