#!/usr/bin/env node
/**
 * §296 — PROMO CARDS, AND THE TOP OF THE SHOP TAB.
 *
 *   node scripts/test_promo_cards.js
 *
 * Ash, 2026-09-30, sending 混果汁's shop with a row of tall promo cards above
 * the menu: "I like the idea to have in shop this kind of banner promotions",
 * then "go do all" on the mockup. What shipped:
 *
 *   - a page-editor block, promo_cards: up to 5 tall 3:4 pictures swiped
 *     sideways, each with its own link and optional start / end day;
 *   - the promo_cards blocks of the editor's Shop landing page drawn at the top
 *     of the mini app's Shop tab, tucked away once the list is scrolled and
 *     hidden while a search is typed.
 *
 * What this pins, by RUNNING the code rather than grepping it wherever it can:
 *
 *   1. "today" is China's day, and a card outside its dates is left out — the
 *      same answer in the mini app, the web renderer and the editor;
 *   2. the mini app block builds its cards and hands a tap its own link;
 *   3. the Shop tab takes ONLY promo_cards from the Shop landing page, drops a
 *      block with nothing to show, and never a web-only block;
 *   4. the row tucks on scroll only when the list can still scroll without it
 *      (otherwise tucking loops: the box grows, scroll clamps to 0, row back);
 *   5. a card's link from the Shop tab: a category opens on this tab;
 *   6. the block is registered everywhere the editor and server need it.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CMS    = read('public/cms.html');
const RETAIL = read('routes/retail.js');
const SHOPX  = read('miniapp/pages/shop/shop.wxml');
const SHOPJ  = read('miniapp/pages/shop/shop.json');
const BRX    = read('miniapp/components/block-renderer/block-renderer.wxml');

let passed = 0, failed = 0;
function section(t) { console.log('\n' + t); }
function it(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

// ── Mini app harness (same shape as test_fresh_today_label.js) ─────────────
const nav = [];
let appData = { globalData: { lang: 'en', customer: {} } };
function installWx() {
  global.getApp = () => appData;
  global.wx = new Proxy({
    navigateTo: (o) => nav.push(['navigateTo', o.url]),
    switchTab:  (o) => nav.push(['switchTab', o.url]),
    getStorageSync: () => null,
    getSystemInfoSync: () => ({ windowWidth: 375, statusBarHeight: 20 }),
    getAccountInfoSync: () => ({ miniProgram: { appId: 'wxtest' } }),
  }, { get: (t, k) => (k in t ? t[k] : () => {}) });
}
function load(relPath, kind) {
  const captured = {};
  const g = global;
  g.Page = (o) => { if (kind === 'Page') Object.assign(captured, o); return o; };
  g.Component = (o) => { if (kind === 'Component') Object.assign(captured, o); return o; };
  g.App = (o) => o;
  installWx();
  const full = path.join(ROOT, relPath);
  delete require.cache[require.resolve(full)];
  require(full);
  return captured;
}

const promo = require(path.join(ROOT, 'miniapp/utils/promo-cards.js'));
const DAY = (iso) => Date.parse(iso);

section('1 · which cards show today');
{
  it('"today" is China\'s day: 17:00 UTC on 31 Oct is already 1 Nov', () => {
    assert.strictEqual(promo.chinaToday(DAY('2026-10-31T17:00:00Z')), '2026-11-01');
    assert.strictEqual(promo.chinaToday(DAY('2026-10-31T15:59:00Z')), '2026-10-31');
  });
  it('start and end days are both inclusive; a missing bound is open', () => {
    const c = { start_at: '2026-10-01', end_at: '2026-10-31' };
    assert.strictEqual(promo.inDateWindow(c, '2026-09-30'), false);
    assert.strictEqual(promo.inDateWindow(c, '2026-10-01'), true);
    assert.strictEqual(promo.inDateWindow(c, '2026-10-31'), true);
    assert.strictEqual(promo.inDateWindow(c, '2026-11-01'), false);
    assert.strictEqual(promo.inDateWindow({}, '2030-01-01'), true);
  });
  it('a card with no picture is left out; order is kept; five at most', () => {
    const now = DAY('2026-10-10T04:00:00Z');
    const cards = [
      { id: 'a', image_url: '/a.jpg' },
      { id: 'b', image_url: '' },
      { id: 'c', image_url: '/c.jpg', end_at: '2026-10-09' },
      { id: 'd', image_url: '/d.jpg', start_at: '2026-10-11' },
      { id: 'e', image_url: '/e.jpg' }, { id: 'f', image_url: '/f.jpg' },
      { id: 'g', image_url: '/g.jpg' }, { id: 'h', image_url: '/h.jpg' },
      { id: 'i', image_url: '/i.jpg' },
    ];
    assert.deepStrictEqual(promo.promoCardsToShow(cards, now).map(c => c.id), ['a', 'e', 'f', 'g', 'h']);
  });
  it('the editor and the web renderer compute the same day the same way', () => {
    assert.ok(/function promoToday\(\) \{ return new Date\(Date\.now\(\) \+ 8 \* 3600e3\)\.toISOString\(\)\.slice\(0, 10\); \}/.test(CMS), 'cms.html promoToday');
    assert.ok(/function promoToday\(\) \{ return new Date\(Date\.now\(\) \+ 8 \* 3600e3\)\.toISOString\(\)\.slice\(0, 10\); \}/.test(read('public/shop/blocks.js')), 'blocks.js promoToday');
  });
}

section('2 · the mini app block');
{
  const comp = load('miniapp/components/block-renderer/block-renderer.js', 'Component');
  const run = (block) => {
    const ctx = {
      data: { block }, properties: { block, lang: 'en' },
      setData(o, cb) { Object.assign(this.data, o); if (cb) cb(); },
      triggerEvent(name, detail) { this.fired = [name, detail]; },
    };
    for (const [k, fn] of Object.entries(comp.methods)) ctx[k] = fn;
    comp.methods.recompute.call(ctx);
    return ctx;
  };
  it('builds today\'s cards with absolute picture URLs and their own links', () => {
    const ctx = run({ id: 'p', type: 'promo_cards', cards: [
      { id: 'a', image_url: '/api/retail/media/7', target: 'category:ready' },
      { id: 'b', image_url: '/api/retail/media/8', end_at: '2000-01-01' },
      { id: 'c', image_url: 'https://x/y.jpg', target: '' },
    ] });
    const cards = ctx.data.promoCards;
    assert.strictEqual(cards.length, 2, 'the ended card is left out');
    assert.ok(/^https:\/\/.+\/api\/retail\/media\/7$/.test(cards[0].img), cards[0].img);
    assert.strictEqual(cards[0].target, 'category:ready');
    assert.strictEqual(cards[1].img, 'https://x/y.jpg');
  });
  it('a tap hands the host the card\'s own link — and a card with none, nothing', () => {
    const ctx = run({ id: 'p', type: 'promo_cards', cards: [] });
    comp.methods.onPromoTap.call(ctx, { currentTarget: { dataset: { target: 'coupons' } } });
    assert.deepStrictEqual(ctx.fired, ['cta', { target: 'coupons' }]);
    ctx.fired = null;
    comp.methods.onPromoTap.call(ctx, { currentTarget: { dataset: { target: '' } } });
    assert.strictEqual(ctx.fired, null);
  });
  it('the WXML draws the row only when there is a card to draw', () => {
    assert.ok(/wx:elif="\{\{type === 'promo_cards' && promoCards\.length\}\}"/.test(BRX));
    assert.ok(/data-target="\{\{item\.target\}\}" bindtap="onPromoTap"/.test(BRX));
  });
}

section('3 · the web renderer, run');
{
  const sandbox = { window: {} };
  vm.runInNewContext(read('public/shop/blocks.js'), sandbox);
  const html = sandbox.window.ShopBlocks.render([{ id: 'p', type: 'promo_cards', cards: [
    { image_url: '/api/retail/media/1', target: 'product:5' },
    { image_url: '/api/retail/media/2', end_at: '2000-01-01' },
    { image_url: '' },
  ] }]);
  it('draws today\'s cards, each carrying its link', () => {
    assert.strictEqual((html.match(/class="sb-promo-card"/g) || []).length, 1);
    assert.ok(/data-cta-target="product:5"/.test(html));
  });
  it('nothing to show draws nothing', () => {
    const empty = sandbox.window.ShopBlocks.render([{ id: 'q', type: 'promo_cards', cards: [{ image_url: '' }] }]);
    assert.ok(!/sb-promo/.test(empty));
  });
}

section('4 · the Shop tab — which blocks, and the tuck');
{
  const page = load('miniapp/pages/shop/shop.js', 'Page');
  const ctxFor = (patch) => {
    const ctx = {
      ...page,
      data: { ...JSON.parse(JSON.stringify(page.data)), ...(patch || {}) },
      setData(p) { Object.assign(this.data, p); },
    };
    return ctx;
  };
  const live  = { id: 'L', type: 'promo_cards', cards: [{ id: 'x', image_url: '/x.jpg' }] };
  const ended = { id: 'E', type: 'promo_cards', cards: [{ id: 'y', image_url: '/y.jpg', end_at: '2000-01-01' }] };
  const web   = { id: 'W', type: 'promo_cards', show_on: 'web', cards: [{ id: 'z', image_url: '/z.jpg' }] };
  const hero  = { id: 'H', type: 'hero_banner', image_url: '/h.jpg' };

  it('takes ONLY live promo_cards from the Shop landing page — no hero, no web-only, no empty', () => {
    appData = { globalData: { lang: 'en', config: { categories: { layout: [hero, live, ended, web] }, shop: {} } } };
    installWx();
    const ctx = ctxFor();
    // With the config already cached, _syncConfig reaches its setData before
    // its first await, so the result is readable synchronously.
    page._syncConfig.call(ctx);
    assert.deepStrictEqual(ctx.data.promoBlocks.map(b => b.id), ['L']);
  });
  it('the row is hidden while a search is typed, and is the renderer\'s own block', () => {
    assert.ok(/wx:if="\{\{promoBlocks\.length && !query\}\}" class="promo-wrap \{\{promoTucked \? 'tucked' : ''\}\}"/.test(SHOPX));
    assert.ok(/<block-renderer wx:for="\{\{promoBlocks\}\}"[^>]*bind:cta="onPromoCta"/.test(SHOPX));
    assert.ok(/"block-renderer": "\/components\/block-renderer\/block-renderer"/.test(SHOPJ));
  });
  it('a long list: the row tucks once scrolled, and stays tucked near (not at) the top', () => {
    const ctx = ctxFor({ promoBlocks: [live] });
    ctx._listViewportH = 600;
    page._tuckPromos.call(ctx, 30, 3000);
    assert.strictEqual(ctx.data.promoTucked, true);
    page._tuckPromos.call(ctx, 10, 3000);
    assert.strictEqual(ctx.data.promoTucked, true, 'no flapping at 10px');
    page._tuckPromos.call(ctx, 2, 3000);
    assert.strictEqual(ctx.data.promoTucked, false, 'back at the very top');
    clearTimeout(ctx._promoMeasureT);
  });
  it('a SHORT list never tucks (it would loop: box grows, scroll clamps, row returns)', () => {
    const ctx = ctxFor({ promoBlocks: [live] });
    ctx._listViewportH = 600;
    page._tuckPromos.call(ctx, 30, 800);
    assert.strictEqual(ctx.data.promoTucked, false);
  });
  it('onListScroll drives the tuck, and switching layout brings the row back', () => {
    const ctx = ctxFor({ promoBlocks: [live] });
    ctx._listViewportH = 600;
    ctx._updateActiveByScrollTop = () => {};
    page.onListScroll.call(ctx, { detail: { scrollTop: 40, scrollHeight: 4000 } });
    assert.strictEqual(ctx.data.promoTucked, true);
    clearTimeout(ctx._promoMeasureT);
    ctx._measureSections = () => {}; ctx._measureGroups = () => {};
    page.setLayout.call(ctx, { currentTarget: { dataset: { key: 'list' } } });
    assert.strictEqual(ctx.data.promoTucked, false);
  });
}

section('5 · a card\'s link, from the Shop tab');
{
  const page = load('miniapp/pages/shop/shop.js', 'Page');
  const ctx = { ...page, data: JSON.parse(JSON.stringify(page.data)), setData(p) { Object.assign(this.data, p); } };
  it('category:<id> opens that category HERE, the way a Home tile does', () => {
    appData = { globalData: { lang: 'en' } };
    installWx();
    ctx._tree = [{ id: 'ready', name: 'Ready to Eat' }, { id: 'dry', name: 'Dry & Pantry' }];
    let applied = 0;
    ctx._applyPendingCategory = () => { applied++; };
    page._routePromoTarget.call(ctx, 'category:dry');
    assert.strictEqual(appData.globalData.pendingCategory, 'Dry & Pantry');
    assert.strictEqual(applied, 1);
  });
  it('product, tab and page links go where Home sends them', () => {
    nav.length = 0;
    page._routePromoTarget.call(ctx, 'product:42');
    page._routePromoTarget.call(ctx, 'cart');
    page._routePromoTarget.call(ctx, 'coupons');
    page._routePromoTarget.call(ctx, 'promotions');
    page._routePromoTarget.call(ctx, 'no-such-page');
    assert.deepStrictEqual(nav, [
      ['navigateTo', '/pages/product/product?id=42'],
      ['switchTab', '/pages/cart/cart'],
      ['navigateTo', '/pages/coupons/coupons'],
      ['navigateTo', '/pages/layout/layout?page=promotions'],
    ]);
  });
  it('every page the list names exists in app.json', () => {
    const pages = JSON.parse(read('miniapp/app.json')).pages;
    const src = read('miniapp/pages/shop/shop.js');
    const list = src.match(/const PROMO_NAV_PAGES = \[([\s\S]*?)\];/)[1].match(/'([a-z]+)'/g).map(s => s.slice(1, -1));
    for (const p of list) assert.ok(pages.includes(`pages/${p}/${p}`), p);
  });
}

section('6 · registered everywhere the editor and server need it');
{
  it('the server accepts the type', () => {
    assert.ok(/^\s+'promo_cards',$/m.test(RETAIL));
  });
  it('the editor has its icon, catalogue entry, defaults, form and preview', () => {
    assert.ok(/^  promo_cards:\s+'<svg/m.test(CMS), 'ICONS');
    assert.ok(/^  promo_cards:\s+\{ name: 'Promo cards'/m.test(CMS), 'BLOCK_META');
    assert.ok(/case 'promo_cards': return \{\s+id, type,\s+cards: \[\{ id: uid\(\), image_url: '', target: '', start_at: '', end_at: '' \}\],/.test(CMS), 'makeBlock');
    assert.ok(/case 'promo_cards':\s+buildPromoCardsForm\(body, b\); break;/.test(CMS), 'inspector');
    assert.ok(/case 'promo_cards': \{\s+\/\/ Every card is drawn/.test(CMS), 'preview');
  });
  it('the editor counts a card\'s link as a link to that page', () => {
    assert.ok(/if \(Array\.isArray\(b\.cards\)\) \{\s+b\.cards\.forEach\(c => \{ if \(c && c\.target\) targets\.push\(c\.target\); \}\);/.test(CMS));
  });
  it('the Shop landing page no longer claims its whole layout shows on the Shop tab', () => {
    const line = CMS.match(/\{ id: 'categories',[^\n]*/)[0];
    assert.ok(!/Intro \/ banners shown on the Shop tab/.test(line));
    assert.ok(/promo cards also show at the top of the Shop tab/.test(line));
  });
}

setTimeout(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}, 50);
