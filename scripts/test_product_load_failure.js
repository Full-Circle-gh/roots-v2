#!/usr/bin/env node
/**
 * A DROPPED REQUEST IS NOT A VERDICT ABOUT THE PRODUCT.
 *
 *   node scripts/test_product_load_failure.js
 *
 * REPORTED BY ASH from a customer's phone: a shared mini-program link opened
 * on "This product is unavailable — It was unpublished or removed by the
 * store." The product was published the whole time, and the same link opened
 * correctly for Ash minutes later.
 *
 * WHAT THE PAGE USED TO DO. miniapp/pages/product/product.js caught EVERY
 * failure of GET /api/retail/products/:id into one state:
 *
 *     catch (e) { this.setData({ notFound: true, loading: false }); }
 *
 * so a 12s timeout on weak mobile data, a radio drop, an expired token whose
 * silent re-login failed, and a 502 from a server in the middle of a deploy
 * restart (every push to main restarts pm2 — see the README) all told the
 * customer the shop had removed the product. Of the two possible mistakes,
 * that is the worse one: "unavailable" is a statement about the catalogue, it
 * is believed, and the customer leaves instead of pulling to refresh.
 *
 * WHAT IS PINNED HERE, and why each case has to be its own:
 *
 *   404 / 400 from the server    → notFound   (the server ANSWERED: it's gone)
 *   network_* , server_error_5xx → one retry, then loadError
 *   'unauthenticated'            → loadError  (carries no status at all)
 *
 * The retry is the case a regex could never prove and the one that actually
 * rescues the reported customer: a deploy restart is over in seconds, so the
 * second attempt succeeds and nothing is shown at all. Section 2 asserts the
 * product LOADS after a transient first failure — a change that kept the state
 * split but dropped the retry would pass every other case here.
 *
 * The last section guards the copy itself: the operator sentence must stay
 * unreachable from the loadError branch, which is the whole point of the split.
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
// Same harness shape as scripts/test_fresh_today_label.js and
// scripts/test_preorder_local.js, kept local because none of them exports one.
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

const PAGE = loadMiniPage('miniapp/pages/product/product.js');
const api = require(path.join(ROOT, 'miniapp/utils/api.js'));
const delivery = require(path.join(ROOT, 'miniapp/utils/delivery.js'));
const diag = require(path.join(ROOT, 'miniapp/utils/diag.js'));
const PROD_JS = fs.readFileSync(path.join(ROOT, 'miniapp/pages/product/product.js'), 'utf8');
const PROD_WXML = fs.readFileSync(path.join(ROOT, 'miniapp/pages/product/product.wxml'), 'utf8');

// One page context per case. recomputeDisplay is stubbed: this suite is about
// WHICH state a failure lands in, not about how a loaded product renders (that
// is test_fresh_today_label.js's ground), and running the real builder here
// would couple every future badge change to this file.
function ctx() {
  const c = Object.create(PAGE);
  c.data = Object.assign({}, PAGE.data, { id: 42, lang: 'en' });
  c.setData = (o) => Object.assign(c.data, o);
  c.displayed = 0;
  c.recomputeDisplay = () => { c.displayed++; };
  return c;
}

// Drive refresh() with a scripted sequence of answers, one per attempt.
// Returns the page context plus what the page reported to diag.
async function runRefresh(answers) {
  const savedGet = api.get, savedPost = api.post, savedLoad = delivery.load;
  const asked = [];
  const logged = [];
  api.get = (p) => {
    asked.push(p);
    const a = answers[asked.length - 1];
    if (!a) throw new Error('unexpected extra attempt: ' + p);
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
  };
  api.post = () => Promise.resolve({});     // diag is fire-and-forget
  delivery.load = () => Promise.resolve(false);
  const savedReport = diag.reportError;
  diag.reportError = (msg, stack, extra) => { logged.push({ msg, extra }); };
  const c = ctx();
  try {
    await c.refresh();
    return { c, asked, logged };
  } finally {
    api.get = savedGet; api.post = savedPost; delivery.load = savedLoad;
    diag.reportError = savedReport;
  }
}

function err(message, status) {
  const e = new Error(message);
  if (status !== undefined) e.status = status;
  return e;
}

// ── 1. The server answered: the product really is gone ─────────────────────
section('1. A real answer from the server still reads "removed by the store"');

it('404 not_found → notFound, never loadError', async () => {
  const { c, asked } = await runRefresh([err('not_found', 404)]);
  assert.strictEqual(c.data.notFound, true, 'a 404 must still land on notFound');
  assert.strictEqual(c.data.loadError, false, 'a 404 is an answer, not a dropped request');
  assert.strictEqual(c.data.loading, false);
  assert.strictEqual(asked.length, 1, 'a 404 is final — it must NOT be retried');
});

it('400 bad_id → notFound (a malformed link is not a network fault)', async () => {
  const { c } = await runRefresh([err('bad_id', 400)]);
  assert.strictEqual(c.data.notFound, true);
  assert.strictEqual(c.data.loadError, false);
});

// ── 2. The retry, which is what rescues the reported customer ──────────────
section('2. A transient failure is retried once, and a deploy restart is invisible');

it('server_error_502 then success → the product LOADS, nothing is shown', async () => {
  const { c, asked } = await runRefresh([err('server_error_502'), { id: 42, name_en: 'Kale' }]);
  assert.strictEqual(asked.length, 2, 'the 502 must be retried');
  assert.strictEqual(c.data.notFound, false, 'the product is on the page — say nothing');
  assert.strictEqual(c.data.loadError, false);
  assert.strictEqual(c.data.loading, false, 'the skeleton must not be left up');
  assert.ok(c.data.product, 'the retried answer must reach the page');
  assert.strictEqual(c.displayed, 1, 'and be rendered');
});

it('network_ timeout then success → same, the customer sees no error at all', async () => {
  const { c, asked } = await runRefresh([err('network_request:fail timeout'), { id: 42 }]);
  assert.strictEqual(asked.length, 2);
  assert.strictEqual(c.data.loadError, false);
  assert.ok(c.data.product);
});

it('the retry happens ONCE, not forever', async () => {
  const { asked } = await runRefresh([err('network_x'), err('network_x')]);
  assert.strictEqual(asked.length, 2, 'a second failure must give up, not loop');
});

// ── 3. Twice-failed transport: say so, and do not blame the shop ───────────
section('3. A request that never got an answer says so');

it('network_ twice → loadError, and notFound stays FALSE', async () => {
  const { c } = await runRefresh([err('network_x'), err('network_x')]);
  assert.strictEqual(c.data.loadError, true);
  assert.strictEqual(c.data.notFound, false,
    'this is the reported bug: a dropped request must never read as "removed"');
  assert.strictEqual(c.data.loading, false);
});

it('server_error_502 twice → loadError (the mid-deploy case)', async () => {
  const { c } = await runRefresh([err('server_error_502'), err('server_error_502')]);
  assert.strictEqual(c.data.loadError, true);
  assert.strictEqual(c.data.notFound, false);
});

it('unauthenticated → loadError, though it carries no status at all', async () => {
  // utils/api rejects with a bare Error here — no .status — after a failed
  // silent re-login. Read as "gone" it would tell every customer with a dead
  // token that the whole catalogue was removed.
  const { c } = await runRefresh([err('unauthenticated')]);
  assert.strictEqual(c.data.notFound, false);
  assert.strictEqual(c.data.loadError, true);
});

it('an unrecognised error is treated as transport, not as a verdict', async () => {
  const { c } = await runRefresh([err('something_new'), err('something_new')]);
  assert.strictEqual(c.data.notFound, false, 'only a real 4xx answer may claim "gone"');
  assert.strictEqual(c.data.loadError, true);
});

// ── 4. It leaves a trail ───────────────────────────────────────────────────
section('4. The failure is reported, so the next one need not be guessed at');

it('a failed load posts the id and the reason to client-log', async () => {
  const { logged } = await runRefresh([err('network_x'), err('network_x')]);
  assert.strictEqual(logged.length, 1, 'exactly one report per giving-up load');
  assert.strictEqual(logged[0].extra.id, 42, 'without the id support cannot look it up');
  assert.strictEqual(logged[0].extra.why, 'network_x');
  assert.strictEqual(logged[0].extra.gone, false);
});

it('a successful retry reports NOTHING — it was not a fault', async () => {
  const { logged } = await runRefresh([err('network_x'), { id: 42 }]);
  assert.strictEqual(logged.length, 0);
});

it('retry() clears loadError so the button cannot leave the error on screen', () => {
  assert.ok(typeof PAGE.retry === 'function', 'the wxml binds bindtap="retry"');
  const c = ctx();
  c.data.loadError = true;
  c.data.loading = false;
  c.refresh = () => { c.refreshed = true; };
  PAGE.retry.call(c);
  assert.strictEqual(c.data.loadError, false);
  assert.ok(c.refreshed, 'and it must actually re-fetch');
});

// ── 5. The copy stays on the right side of the split ───────────────────────
section('5. The operator sentence is unreachable from the load-failed branch');

it('the removed-by-the-store copy sits under wx:else, not the loadError block', () => {
  const i = PROD_WXML.indexOf('{{notFound || loadError}}');
  assert.notStrictEqual(i, -1, 'the empty state must cover BOTH failures');
  const block = PROD_WXML.slice(i, i + 2000);
  const errAt = block.indexOf('wx:if="{{loadError}}"');
  const elseAt = block.indexOf('wx:else');
  const goneAt = block.indexOf('unpublished or removed by the store');
  assert.ok(errAt !== -1 && elseAt !== -1 && goneAt !== -1, 'both branches must be present');
  assert.ok(goneAt > elseAt,
    'the operator copy must live AFTER wx:else — inside the loadError branch it is the bug again');
  assert.ok(block.indexOf('bindtap="retry"') > errAt && block.indexOf('bindtap="retry"') < elseAt,
    'the retry button belongs to the loadError branch only');
});

it('both new strings are LIVE pairs lifted from the home page, not composed', () => {
  // CLAUDE.md: prefer copying a live pair over minting one. These three are
  // home.wxml's, character for character — so nothing here is a new string and
  // docs/tacet-delivery-vocabulary.md has nothing to declare.
  const HOME = fs.readFileSync(path.join(ROOT, 'miniapp/pages/home/home.wxml'), 'utf8');
  for (const s of ['网络连接失败', '请检查网络后重试。', '重试']) {
    assert.ok(HOME.includes(s), `${s} must already be live on the home page`);
    assert.ok(PROD_WXML.includes(s), `${s} must be the string the product page uses`);
  }
});

it('nothing sets notFound from a bare catch any more', () => {
  assert.ok(!/catch \(e\) \{\s*console\.warn\('\[product\] load failed[^}]*notFound: true/.test(PROD_JS),
    'the catch-all that caused this is gone');
  assert.ok(/api\.isTransient/.test(PROD_JS), 'the page asks the shared transport test');
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
