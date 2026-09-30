#!/usr/bin/env node
/**
 * §297 — A CATEGORY'S BANNER, AT THE TOP OF ITS SECTION ON THE SHOP TAB.
 *
 *   node scripts/test_category_banner.js
 *
 * Ash, 2026-09-30: "what about middle of page between categories advertising
 * banners?", then "go do all" on the mockup. Claude's conditions, agreed on
 * the mockup: one banner per TOP category, set on the category itself (so it
 * moves with it), a fixed 5:2 shape, hidden while searching.
 *
 * What this pins:
 *   1. the tree keeps a usable banner on a top and nothing else — no banner on
 *      a subcategory, no banner without a picture, no script scheme, no
 *      malformed day;
 *   2. NEITHER tree writer drops it: the Categories screen sends its model,
 *      and the product wizard's "add category" used to rebuild every node from
 *      three named fields, which would have deleted every banner the first
 *      time anyone added a category there;
 *   3. the Shop tab shows it only inside its dates (China's day), first in its
 *      section, in a fixed box, never during a search;
 *   4. the Categories screen's banner editor, run in a sandbox.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const { sanitizeTree, sanitizeBanner } = require(path.join(ROOT, 'lib/category-tree.js'));
const RETAIL = read('routes/retail.js');
const WIZ    = read('public/retail-admin/09-products.js');
const CORE   = read('public/retail-admin/01-core.js');
const SHOPX  = read('miniapp/pages/shop/shop.wxml');
const SHOPS  = read('miniapp/pages/shop/shop.wxss');

let passed = 0, failed = 0;
function section(t) { console.log('\n' + t); }
function it(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

const B = { image_url: '/api/retail/media/12', target: 'product:7', start_at: '2026-10-01', end_at: '2026-10-31' };

section('1 · the tree keeps a usable banner, and only that');
{
  it('a top category keeps its banner through a save', () => {
    const [t] = sanitizeTree([{ id: 'ready', name: 'Ready to Eat', banner: B }]);
    assert.deepStrictEqual(t.banner, B);
  });
  it('a subcategory never carries one', () => {
    const [t] = sanitizeTree([{ name: 'Ready', subs: [{ name: 'Salads', banner: B }] }]);
    assert.ok(!('banner' in t.subs[0]));
  });
  it('no picture, or a picture that is not a path or http(s), is no banner', () => {
    assert.strictEqual(sanitizeBanner({ ...B, image_url: '' }), null);
    assert.strictEqual(sanitizeBanner({ ...B, image_url: 'javascript:alert(1)' }), null);
    assert.strictEqual(sanitizeBanner({ ...B, image_url: 'data:image/png;base64,AAAA' }), null);
    assert.strictEqual(sanitizeBanner({ ...B, image_url: '//evil.example/x.jpg' }), null, 'protocol-relative');
    assert.ok(sanitizeBanner({ ...B, image_url: 'https://cdn.example/x.jpg' }));
    const [t] = sanitizeTree([{ name: 'A', banner: { image_url: '' } }]);
    assert.ok(!('banner' in t), 'dropped whole, not stored half-made');
  });
  it('a script link becomes picture-only; a long one is bounded', () => {
    assert.strictEqual(sanitizeBanner({ ...B, target: 'javascript:alert(1)' }).target, '');
    assert.strictEqual(sanitizeBanner({ ...B, target: 'x'.repeat(500) }).target.length, 200);
  });
  it('a malformed day is cleared, not guessed', () => {
    const b = sanitizeBanner({ ...B, start_at: '1 Oct', end_at: '2026-10-31T00:00' });
    assert.strictEqual(b.start_at, '');
    assert.strictEqual(b.end_at, '');
  });
  it('a tree without banners reads exactly as before', () => {
    const [t] = sanitizeTree([{ id: 'a', name: 'A', name_cn: '甲', subs: [] }]);
    assert.deepStrictEqual(Object.keys(t), ['id', 'name', 'name_cn', 'subs']);
  });
  it('the save route still cleans the tree through sanitizeTree', () => {
    assert.ok(/router\.put\('\/api\/retail-admin\/category-tree',[\s\S]{0,200}const incoming = sanitizeTree\(req\.body && req\.body\.tree\);/.test(RETAIL));
  });
}

section('2 · neither tree writer drops it');
{
  it('the product wizard\'s "add category" sends every node back WHOLE', () => {
    const m = WIZ.match(/const newTree = (\(PA_CAT_TREE \|\| \[\]\)\.map\([^\n]*\))/);
    assert.ok(m, 'the rebuild line is where it was');
    const PA_CAT_TREE = [{ id: 'ready', name: 'Ready', name_cn: '即食', banner: B, subs: [{ id: 's', name: 'Salads', name_cn: '沙拉' }] }];
    // Through JSON: the sandbox builds its objects on its own prototypes.
    const rebuilt = JSON.parse(JSON.stringify(vm.runInNewContext(m[1], { PA_CAT_TREE })));
    assert.deepStrictEqual(rebuilt[0].banner, B);
    assert.deepStrictEqual(rebuilt[0].subs[0], PA_CAT_TREE[0].subs[0]);
  });
  it('the Categories screen saves its whole model', () => {
    assert.ok(/api\('\/api\/retail-admin\/category-tree', \{ method: 'PUT', body: \{ tree: catModel \} \}\)/.test(CORE));
  });
}

section('3 · the Shop tab');
{
  // Load the page as shipped (harness shape of test_fresh_today_label.js).
  const captured = {};
  const g = global;
  g.Page = (o) => { Object.assign(captured, o); return o; };
  g.Component = (o) => o; g.App = (o) => o;
  g.getApp = () => ({ globalData: { lang: 'en' } });
  g.wx = new Proxy({}, { get: () => () => null });
  require(path.join(ROOT, 'miniapp/pages/shop/shop.js'));
  const page = captured;
  const build = (tree, now) => {
    const ctx = { ...page, data: JSON.parse(JSON.stringify(page.data)), _onLocalRun: false };
    const realNow = Date.now;
    if (now) Date.now = () => now;
    try {
      const prods = tree.map((t, i) => ({ id: i + 1, name_en: 'P' + i, top_category: t.name, subcategory: '', price: 10 }));
      return page._buildSections.call(ctx, prods, tree, 'en');
    } finally { Date.now = realNow; }
  };
  const tree = [
    { id: 'a', name: 'A', subs: [], banner: B },
    { id: 'b', name: 'B', subs: [] },
    { id: 'c', name: 'C', subs: [], banner: { image_url: '/api/retail/media/9', target: '' } },
  ];
  it('inside its dates the section carries the picture (absolute) and its link', () => {
    const s = build(tree, Date.parse('2026-10-15T04:00:00Z'));
    assert.ok(/^https:\/\/.+\/api\/retail\/media\/12$/.test(s[0].banner.img), s[0].banner.img);
    assert.strictEqual(s[0].banner.target, 'product:7');
    assert.strictEqual(s[1].banner, null, 'no banner, nothing');
    assert.strictEqual(s[2].banner.target, '', 'picture only');
  });
  it('outside its dates, on CHINA\'S day, it is gone', () => {
    // 16:30 UTC on 31 Oct is already 1 Nov in China: the banner has ended.
    assert.strictEqual(build(tree, Date.parse('2026-10-31T16:30:00Z'))[0].banner, null);
    assert.ok(build(tree, Date.parse('2026-10-31T15:30:00Z'))[0].banner, 'still 31 Oct in China');
    assert.strictEqual(build(tree, Date.parse('2026-09-30T04:00:00Z'))[0].banner, null, 'not started');
  });
  it('drawn first in its section, in both layouts, never during a search', () => {
    const blocks = SHOPX.match(/id="\{\{section\.id\}\}" class="cat-section">[\s\S]*?<view wx:for="\{\{section\.groups\}\}"/g) || [];
    assert.strictEqual(blocks.length, 2, 'rail layouts and gallery');
    for (const b of blocks) {
      assert.ok(/wx:if="\{\{section\.banner && !query\}\}"/.test(b));
      assert.ok(/bindtap="onBannerTap"/.test(b));
    }
  });
  it('the box is a fixed 5:2 (height from width, not from the picture)', () => {
    assert.ok(/\.cat-banner-box \{[^}]*height: 0; padding-top: 40%;/.test(SHOPS));
  });
  it('a tap goes through the promo cards\' routing', () => {
    const calls = [];
    const ctx = { _routePromoTarget: (t) => calls.push(t) };
    page.onBannerTap.call(ctx, { currentTarget: { dataset: { target: 'coupons' } } });
    assert.deepStrictEqual(calls, ['coupons']);
  });
}

section('4 · the Categories screen\'s banner editor, run');
{
  const start = CORE.indexOf('function catBannerToday()');
  const end = CORE.indexOf("// `p` is the row's place as drawn");
  assert.ok(start > 0 && end > start, 'the banner block is where it was');
  const src = CORE.slice(start, end);
  const mk = (model) => {
    const dirty = [];
    const ctx = {
      cuT: (en) => en,
      escapeHtml: (s) => String(s),
      escapeAttr: (s) => String(s),
      CAT_ICON: { plus: '+', trash: 'x' },
      catModel: model, catSel: 0, _catBannerRows: [],
      catUpdateDirty: () => dirty.push(1),
      document: { getElementById: () => null },
      toast: () => {},
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    return { ctx, dirty };
  };
  it('no banner: the section offers "Add banner"', () => {
    const { ctx } = mk([{ name: 'A' }]);
    const html = ctx.catBannerHtml(ctx.catModel[0]);
    assert.ok(/Banner \(optional\)/.test(html) && /Add banner/.test(html));
    assert.ok(!/cat2-banner-pic/.test(html));
  });
  it('a banner: picture, link list with this shelf\'s products, dates, status', () => {
    const { ctx } = mk([{ name: 'A', banner: { ...B, start_at: '', end_at: '' } }]);
    vm.runInContext('_catBannerRows = [{ id: 7, name_en: "Beet Salad" }, { id: 8, name_en: "Hummus" }]', ctx);
    const html = ctx.catBannerHtml(ctx.catModel[0]);
    assert.ok(/<img src="\/api\/retail\/media\/12"/.test(html));
    assert.ok(/<option value="product:7" selected>Beet Salad<\/option>/.test(html));
    assert.ok(/value="promotions"/.test(html));
    assert.ok(/cat2-pill-live">Live</.test(html));
  });
  it('a saved link that is in neither list is KEPT, not swapped', () => {
    const { ctx } = mk([{ name: 'A', banner: { ...B, target: 'product:999' } }]);
    assert.ok(/<option value="product:999" selected>product:999<\/option>/.test(ctx.catBannerTargetOptions('product:999')));
  });
  it('status follows the dates, in the pop-ups\' own words', () => {
    const { ctx } = mk([]);
    assert.ok(/^Starts 2999-01-01$/.test(ctx.catBannerStatus({ start_at: '2999-01-01' }).label));
    assert.ok(/^Ended 2000-01-01$/.test(ctx.catBannerStatus({ end_at: '2000-01-01' }).label));
  });
  it('editing a field or removing the banner marks the tree for autosave', () => {
    const { ctx, dirty } = mk([{ name: 'A', banner: { ...B } }]);
    ctx.catBannerSet('target', 'coupons');
    assert.strictEqual(ctx.catModel[0].banner.target, 'coupons');
    ctx.catBannerRemove();
    assert.ok(!('banner' in ctx.catModel[0]));
    assert.strictEqual(dirty.length, 2);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
