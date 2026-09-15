#!/usr/bin/env node
/**
 * AN EMPTY SHOP AND A DROPPED REQUEST ARE NOT THE SAME SENTENCE.
 *
 *   node scripts/test_shop_load_failure.js
 *
 * REPORTED BY ASH from a customer's phone, 18:42 → 18:43. She opened the Shop
 * tab, watched the loading placeholders for about a minute, and landed on:
 *
 *     No products yet.
 *     Publish products in the Roots admin to see them here.
 *
 * The catalogue was full the whole time and the server answered every one of
 * those calls in about a second when asked from anywhere else. Her phone simply
 * never reached it: rootskitchenchina.com is served from Hong Kong and she was
 * on a mainland connection, while the person who could not reproduce it had a
 * VPN on.
 *
 * WHAT THE PAGE USED TO DO. miniapp/pages/shop/shop.js swallowed both browse
 * reads into the same empty array:
 *
 *     api.get('/api/retail/products' + qs).catch(() => []),
 *
 * so "the request never landed" and "this shop sells nothing" rendered as one
 * state — and the state it chose was the operator's, which tells a CUSTOMER the
 * shop is empty and instructs her to go and publish products in an admin she
 * cannot open. Of the two possible mistakes that is the worse one: it is
 * believed, and she leaves instead of retrying. This is the Shop-tab twin of
 * the bug scripts/test_product_load_failure.js pins on the product page.
 *
 * WHAT IS PINNED HERE, and why each case has to be its own:
 *
 *   products rejects          → loadError, the network copy, a retry button
 *   products resolves []      → the operator copy, and NO retry button
 *   only the tree rejects     → NOT a network error (grouping is optional)
 *
 * The third is the case a coarser fix gets wrong. Keying the verdict off either
 * call would report a failed connection to a customer whose catalogue arrived
 * intact, which is the same class of lie pointing the other way.
 *
 * The last two sections guard the things a later edit would quietly undo: that
 * the operator sentence stays unreachable from the failed branch, that the
 * Chinese is still the home page's own and not a fresh composition, and that
 * the delivery re-render cannot clear a standing verdict.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const checks = [];
function it(name, fn) { checks.push([name, fn]); }
const section = (t) => checks.push([t, null]);

// ── A mini-app page, loaded and RUN ────────────────────────────────────────
// Same harness shape as scripts/test_product_load_failure.js, kept local for
// the same reason: none of these suites exports one.
function loadMiniPage(relPath) {
  const captured = {};
  const g = global;
  const saved = { Page: g.Page, wx: g.wx, getApp: g.getApp, App: g.App, Component: g.Component };
  g.Page = (o) => { Object.assign(captured, o); return o; };
  g.Component = (o) => o;
  g.App = (o) => o;
  g.getApp = () => ({ globalData: { lang: 'en', customer: {} }, authReady: Promise.resolve() });
  g.wx = new Proxy({}, {
    get: (t, k) => {
      if (k === 'getStorageSync') return () => null;
      if (k === 'getSystemInfoSync') return () => ({ windowWidth: 375, statusBarHeight: 20 });
      if (k === 'getAccountInfoSync') return () => ({ miniProgram: { appId: 'wxtest' } });
      return () => {};
    },
  });
  try {
    const full = path.join(ROOT, relPath);
    delete require.cache[require.resolve(full)];
    require(full);
    return captured;
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete g[k]; else g[k] = v; }
  }
}

const PAGE = loadMiniPage('miniapp/pages/shop/shop.js');
const api = require(path.join(ROOT, 'miniapp/utils/api.js'));
const SHOP_JS   = fs.readFileSync(path.join(ROOT, 'miniapp/pages/shop/shop.js'), 'utf8');
const SHOP_WXML = fs.readFileSync(path.join(ROOT, 'miniapp/pages/shop/shop.wxml'), 'utf8');
const SHOP_WXSS = fs.readFileSync(path.join(ROOT, 'miniapp/pages/shop/shop.wxss'), 'utf8');

// One page context per case. The two measure passes and the deep-link handler
// are stubbed: this suite is about WHICH state a failure lands in, not about
// scroll geometry (that is scripts/test_shop_menu_geometry.js's ground).
function ctx(over) {
  const c = Object.create(PAGE);
  c.data = Object.assign({}, PAGE.data, { lang: 'en' }, over || {});
  c.setData = (o) => Object.assign(c.data, o);
  c._measureGroups = () => {};
  c._measureSections = () => {};
  c._applyPendingCategory = () => {};
  c._syncDelivery = () => {};
  return c;
}

// Drive refresh() with scripted answers, keyed by which endpoint was asked —
// the two browse reads run in parallel, so ordering them by call index would
// make this suite depend on Promise.all's scheduling.
async function runRefresh({ products, tree, data }) {
  const savedGet = api.get;
  const asked = [];
  api.get = (p, opts) => {
    asked.push({ path: p, opts: opts || {} });
    const a = p.indexOf('/api/retail/products') === 0 ? products : tree;
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
  };
  const c = ctx(data);
  try {
    await c.refresh();
    return { c, asked };
  } finally {
    api.get = savedGet;
  }
}

const netErr = () => new Error('network_request:fail timeout');
const ROW = {
  id: 1, name_en: 'Sourdough', name_cn: '酸面包', price: 38,
  category: 'Bakery', top_category: 'Bakery', stock: 5,
};

// ── 1. The request never landed ────────────────────────────────────────────
section('1. A dropped catalogue request reports the network, not an empty shop');

it('products rejects → loadError, and the pane says so', async () => {
  const { c } = await runRefresh({ products: netErr(), tree: [] });
  assert.strictEqual(c.data.loadError, true, 'a dropped request must be recorded as one');
  assert.strictEqual(c.data.loading, false, 'the placeholders must not be left spinning');
  assert.strictEqual(c.data.emptyTitle, 'No connection');
  assert.strictEqual(c.data.emptySub, 'Check your network and try again.');
});

it('…and she is given a way out', async () => {
  const { c } = await runRefresh({ products: netErr(), tree: [] });
  assert.strictEqual(c.data.emptyRetry, 'TRY AGAIN', 'the failed pane carries a retry');
  assert.strictEqual(typeof PAGE.retry, 'function', 'the button needs a handler');
});

it('the operator sentence is unreachable from a failed request', async () => {
  const { c } = await runRefresh({ products: netErr(), tree: [] });
  for (const v of [c.data.emptyTitle, c.data.emptySub]) {
    assert.ok(!/Roots admin|管理后台/.test(v),
      'a customer must never be told to publish products: ' + v);
    assert.ok(!/No products yet|暂无商品/.test(v),
      'the shop must not claim to be empty when nobody asked it: ' + v);
  }
});

it('a 5xx is a dropped request too — the catalogue is still unknown', async () => {
  const { c } = await runRefresh({ products: new Error('server_error_502'), tree: [] });
  assert.strictEqual(c.data.loadError, true);
  assert.strictEqual(c.data.emptyTitle, 'No connection');
});

// ── 2. The server answered, and the answer was "nothing" ───────────────────
section('2. A genuinely empty catalogue still reads as the operator\'s job');

it('products resolves [] → the operator copy, unchanged', async () => {
  const { c } = await runRefresh({ products: [], tree: [] });
  assert.strictEqual(c.data.loadError, false, 'an answer is not a failure');
  assert.strictEqual(c.data.emptyTitle, 'No products yet.');
  assert.strictEqual(c.data.emptySub, 'Publish products in the Roots admin to see them here.');
});

it('…and offers no retry, because there is nothing to retry', async () => {
  const { c } = await runRefresh({ products: [], tree: [] });
  assert.strictEqual(c.data.emptyRetry, '', 'the button must not appear under operator copy');
});

it('losing ONLY the category tree is a network error TOO, and here is why', async () => {
  // Nearly got this wrong. The tree reads like an optional grouping aid, so
  // the first cut keyed the verdict off the products call alone. It is not
  // optional: _buildSections walks the tree and indexes products into it, so
  // with no tree a product carrying a top_category is dropped on the floor.
  const { c } = await runRefresh({ products: [ROW], tree: netErr() });
  assert.strictEqual(c.data.sections.length, 0,
    'PREMISE: a categorised product cannot render without its tree');
  assert.strictEqual(c.data.loadError, true,
    'so the blank pane it produces must report the failure, not blame the catalogue');
  assert.strictEqual(c.data.emptyTitle, 'No connection');
});

it('a product with no category at all still survives a lost tree', async () => {
  // The one row shape "Other" is built for. The catalogue is still incomplete,
  // so the verdict stands — this pins that the rescue path exists, not that it
  // makes the failure go away.
  const loose = Object.assign({}, ROW, { top_category: null });
  const { c } = await runRefresh({ products: [loose], tree: netErr() });
  assert.ok(c.data.sections.length > 0, 'it lands in OTHER rather than vanishing');
  assert.strictEqual(c.data.loadError, true, 'and the lost tree is still reported');
});

// ── 3. Giving up sooner ────────────────────────────────────────────────────
section('3. The browse reads give up before the customer does');

it('both catalogue reads carry the shorter timeout', async () => {
  const { asked } = await runRefresh({ products: [ROW], tree: [] });
  assert.strictEqual(asked.length, 2, 'products + tree');
  for (const a of asked) {
    assert.strictEqual(a.opts.timeout, 8000,
      `${a.path} must not wait the 12s default`);
  }
});

it('the shorter timeout is scoped to browsing, never to writes', () => {
  assert.ok(/const BROWSE_TIMEOUT_MS = 8000;/.test(SHOP_JS), 'named, not inlined twice');
  const uses = SHOP_JS.match(/BROWSE_TIMEOUT_MS/g) || [];
  assert.strictEqual(uses.length, 3, 'the constant and exactly the two browse reads');
  assert.ok(!/timeout: BROWSE_TIMEOUT_MS[^]*api\.(post|put|patch|del)/.test(SHOP_JS),
    'no write may inherit it');
});

it('a tree that is merely EMPTY is not a failure', async () => {
  // An answer of "no categories" is the operator's business, not the network's.
  const { c } = await runRefresh({ products: [], tree: [] });
  assert.strictEqual(c.data.loadError, false);
});

it('no automatic second attempt doubles her wait on grey', async () => {
  const { asked } = await runRefresh({ products: netErr(), tree: netErr() });
  assert.strictEqual(asked.length, 2,
    'one attempt each — the retry on this page is the button, not a silent replay');
});

// ── 4. The copy itself ─────────────────────────────────────────────────────
section('4. Nothing here was composed');

it('the Chinese is the home page\'s own, character for character', () => {
  // CLAUDE.md's preference order: copy a live pair first. All three already
  // ship on home.wxml, so docs/tacet-delivery-vocabulary.md has nothing to
  // declare for this change.
  const HOME = fs.readFileSync(path.join(ROOT, 'miniapp/pages/home/home.wxml'), 'utf8');
  for (const s of ['网络连接失败', '请检查网络后重试。', '重试']) {
    assert.ok(HOME.includes(s), `${s} must already be live on the home page`);
    assert.ok(SHOP_JS.includes(s), `${s} must be the string the shop page uses`);
  }
});

it('the Chinese pane is the Chinese pane, not a half-translated one', async () => {
  const { c } = await runRefresh({ products: netErr(), tree: [], data: { lang: 'cn' } });
  assert.strictEqual(c.data.emptyTitle, '网络连接失败');
  assert.strictEqual(c.data.emptySub, '请检查网络后重试。');
  assert.strictEqual(c.data.emptyRetry, '重试');
});

it('switching language mid-failure keeps the failure copy', async () => {
  const { c } = await runRefresh({ products: netErr(), tree: [] });
  c._applyLang('cn');
  assert.strictEqual(c.data.emptyTitle, '网络连接失败',
    'the language toggle must not silently restore the operator sentence');
  assert.strictEqual(c.data.emptyRetry, '重试');
});

// ── 5. What a later edit would quietly undo ────────────────────────────────
section('5. The verdict survives the things that re-render without re-fetching');

it('the delivery re-render cannot clear a standing loadError', () => {
  const c = ctx({ loadError: true, _raw: [] });
  c._renderRows([]);        // _syncDelivery calls it with no verdict
  assert.strictEqual(c.data.loadError, true, 'a re-render is not new evidence');
  assert.strictEqual(c.data.emptyTitle, 'No connection');
});

it('both empty panes render the retry, gated on there being one', () => {
  const gated = SHOP_WXML.match(/wx:if="\{\{emptyRetry\}\}"[^]{0,140}?bindtap="retry"/g) || [];
  assert.strictEqual(gated.length, 2, 'the list pane and the gallery pane both have it');
  const panes = SHOP_WXML.match(/wx:elif="\{\{!sections\.length\}\}"/g) || [];
  assert.strictEqual(panes.length, 2, 'and there are still only two such panes');
  assert.ok(/\.empty-retry \{/.test(SHOP_WXSS), 'the button is styled here, not inherited');
});

it('the catch-all that caused this is gone', () => {
  assert.ok(!/api\.get\('\/api\/retail\/products' \+ qs\)\.catch\(\(\) => \[\]\)/.test(SHOP_JS),
    'the bare catch that made a dropped request look like an empty shop is gone');
  assert.ok(/_emptyCopy/.test(SHOP_JS), 'the two sentences resolve through one place');
});

// ── run ────────────────────────────────────────────────────────────────────
(async () => {
  for (const [name, fn] of checks) {
    if (!fn) { console.log('\n' + name); continue; }
    try { await fn(); console.log(`  ✓ ${name}`); pass++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
