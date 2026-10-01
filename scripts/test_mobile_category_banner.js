#!/usr/bin/env node
/**
 * §298 — A CATEGORY'S BANNER, EDITED FROM THE PHONE.
 *
 *   node scripts/test_mobile_category_banner.js
 *
 * Ash, 2026-09-30: "can edit the banner from the mobile app ?" — it could not:
 * the phone admin's Categories screen was read-only. Now an open category on
 * the phone carries the same banner editor as the desktop pane (§297).
 *
 * The code is RUN, sliced out of public/m.html into a sandbox. What it pins:
 *   1. no banner → "Add banner"; a banner → picture, status, link list (with
 *      this shelf's products), start / end, Replace, Remove;
 *   2. every change saves the WHOLE tree at once (the banner lives on its
 *      node; a partial tree would delete the other categories);
 *   3. a failed save says so and reloads the tree, so the screen never shows a
 *      banner the server did not keep;
 *   4. an upload lands on the category it was picked for, then saves; a
 *      refused upload names the server's reason and saves nothing.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');

let passed = 0, failed = 0;
const pending = [];
function section(t) { pending.push(() => console.log('\n' + t)); }
function it(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
  });
}

const start = M.indexOf('const CAT_BANNER_PAGES=');
const end = M.indexOf('function statusCategories(){');
const SRC = M.slice(start, end);

const B = { image_url: '/api/retail/media/12', target: 'product:7', start_at: '', end_at: '' };
function mk(opts = {}) {
  const calls = { writes: [], toasts: [], renders: 0, reloads: 0, fetches: [] };
  const CMD = {};
  const ctx = {
    T: (en) => en, LANG: 'en', API: '/api/retail-admin',
    escAttr: (s) => String(s == null ? '' : s).replace(/"/g, '&quot;'),
    ic: () => '<i></i>',
    state: { cats: opts.cats, catTop: opts.catTop || null, catShelf: opts.catShelf || null },
    // §325 S1d — the card and its commands ask mCan; null caps = still loading,
    // which these keys read as held (MCAN_MONEY_ONLY does not name them).
    mCan: (k) => (opts.caps ? [].concat(k).some((x) => opts.caps.includes(x)) : true),
    render: () => { calls.renders++; },
    reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => calls.toasts.push(m),
    loadCategories: () => { calls.reloads++; },
    apiRaw: () => Promise.resolve({ data: opts.shelfRows || [] }),
    apiWrite: async (p, body, method) => {
      calls.writes.push({ p, body: JSON.parse(JSON.stringify(body)), method });
      if (opts.saveFails) { const e = new Error('dup_top'); throw e; }
      return { success: true, data: body.tree };
    },
    MEDIA_ERR: { too_large: ['That photo is too large. Try a smaller one.', '图片太大'] },
    FormData: class { append() {} },
    fetch: async (u) => { calls.fetches.push(u); return opts.upload; },
    createImageBitmap: async () => { throw new Error('no canvas in node'); },
    URLSearchParams, Object, Promise, Math, Date, String, Array, JSON, Error,
    location: {},
    document: { createElement: () => ({}) },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, CMD, calls };
}
const tree = () => [{ id: 'ready', name: 'Ready to Eat', subs: [] }, { id: 'fresh', name: 'Fresh & Deli', subs: [], banner: { ...B } }];

section('1 · the card');
{
  it('the block is where it was, and the open shelf draws it', () => {
    assert.ok(start > 0 && end > start);
    assert.ok(/<div class="list">\$\{catRow\(top,null,subs\.length\)\}<\/div>\s*\$\{catBannerCard\(top\)\}/.test(M));
  });
  it('no banner: "Add banner", in the phone\'s own button style', () => {
    const { ctx } = mk({ cats: tree(), catTop: 'ready' });
    const html = ctx.catBannerCard(ctx.state.cats[0]);
    assert.ok(/Banner \(optional\)/.test(html));
    assert.ok(/class="btn2"[^>]*onclick="APP\.cmd\('catBannerPick'\)"[\s\S]*Add banner/.test(html));
  });
  it('a banner: picture, status, link list with this shelf\'s products, dates, actions', async () => {
    const { ctx } = mk({ cats: tree(), catTop: 'fresh', shelfRows: [{ id: 7, name_en: 'Hummus Asli' }] });
    ctx.catBannerCard(ctx.state.cats[1]);          // first draw asks for the shelf
    await new Promise((r) => setImmediate(r));
    const html = ctx.catBannerCard(ctx.state.cats[1]);
    assert.ok(/<img src="\/api\/retail\/media\/12"/.test(html));
    assert.ok(/>Live</.test(html));
    assert.ok(/<option value="product:7" selected>Hummus Asli<\/option>/.test(html));
    assert.ok(/value="promotions"/.test(html));
    assert.ok(/APP\.cmd\('catBannerSet','start_at',this\.value\)/.test(html));
    assert.ok(/Replace picture/.test(html) && /Remove banner/.test(html));
  });
  it('a saved link in neither list is kept, not swapped', () => {
    const t = tree(); t[1].banner.target = 'product:999';
    const { ctx } = mk({ cats: t, catTop: 'fresh', catShelf: { top: 'Fresh & Deli', rows: [] } });
    assert.ok(/<option value="product:999" selected>product:999<\/option>/.test(ctx.catBannerCard(t[1])));
  });
  it('status in the pop-ups\' words, on China\'s day', () => {
    const { ctx } = mk({ cats: [] });
    assert.strictEqual(ctx.catBannerStatus({ start_at: '2999-01-01' }).text, 'Starts 2999-01-01');
    assert.strictEqual(ctx.catBannerStatus({ end_at: '2000-01-01' }).text, 'Ended 2000-01-01');
  });
}

section('2 · every change saves the WHOLE tree');
{
  it('a new link saves at once, every category included', async () => {
    const { CMD, calls } = mk({ cats: tree(), catTop: 'fresh' });
    CMD.catBannerSet('target', 'coupons');
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(calls.writes.length, 1);
    const w = calls.writes[0];
    assert.strictEqual(w.p, '/category-tree'); assert.strictEqual(w.method, 'PUT');
    assert.strictEqual(w.body.tree.length, 2, 'the other category rides along');
    assert.strictEqual(w.body.tree[1].banner.target, 'coupons');
    assert.deepStrictEqual(calls.toasts, ['Saved']);
  });
  it('remove takes it off the node and saves', async () => {
    const { CMD, calls } = mk({ cats: tree(), catTop: 'fresh' });
    CMD.catBannerRemove();
    await new Promise((r) => setImmediate(r));
    assert.ok(!('banner' in calls.writes[0].body.tree[1]));
  });
  it('a failed save says so and reloads the tree', async () => {
    const { ctx, CMD, calls } = mk({ cats: tree(), catTop: 'fresh', saveFails: true });
    CMD.catBannerSet('end_at', '2026-10-31');
    await new Promise((r) => setImmediate(r));
    assert.ok(/^Save failed/.test(ctx.state.catBannerErr));
    assert.strictEqual(calls.reloads, 1);
    assert.strictEqual(ctx.state.cats, null, 'the edited copy is thrown away');
  });
}

section('3 · uploading a picture');
{
  const ok = { ok: true, status: 200, json: async () => ({ success: true, data: { url: '/api/retail/media/55' } }) };
  it('lands on the category it was picked for, then saves', async () => {
    const { ctx, calls } = mk({ cats: tree(), catTop: 'ready', upload: ok });
    await ctx.catBannerUpload({ name: 'x.jpg' });
    assert.deepStrictEqual(calls.fetches, ['/api/retail-admin/media/upload']);
    const b = calls.writes[0].body.tree[0].banner;
    assert.deepStrictEqual(b, { target: '', start_at: '', end_at: '', image_url: '/api/retail/media/55' });
    assert.strictEqual(ctx.state.catBannerBusy, false);
  });
  it('a refused upload names the server\'s reason and saves nothing', async () => {
    const tooBig = { ok: false, status: 400, json: async () => ({ success: false, error: 'too_large' }) };
    const { ctx, calls } = mk({ cats: tree(), catTop: 'ready', upload: tooBig });
    await ctx.catBannerUpload({ name: 'x.jpg' });
    assert.strictEqual(calls.writes.length, 0);
    assert.ok(/That did not upload\. That photo is too large/.test(ctx.state.catBannerErr));
  });
  it('replacing keeps the link and dates already set', async () => {
    const t = tree(); t[1].banner = { ...B, end_at: '2026-10-31' };
    const { ctx, calls } = mk({ cats: t, catTop: 'fresh', upload: ok });
    await ctx.catBannerUpload({ name: 'x.jpg' });
    const b = calls.writes[0].body.tree[1].banner;
    assert.strictEqual(b.target, 'product:7'); assert.strictEqual(b.end_at, '2026-10-31');
    assert.strictEqual(b.image_url, '/api/retail/media/55');
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
