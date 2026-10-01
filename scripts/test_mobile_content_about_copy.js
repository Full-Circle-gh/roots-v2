#!/usr/bin/env node
/**
 * §325 M4 — THE ABOUT PAGE AND THE MINI-APP COPY ARE EDITED ON THE PHONE.
 *
 *   node scripts/test_mobile_content_about_copy.js
 *
 * About was read-only on the phone ("written on desktop") and the mini-app
 * copy (the desktop's Snippets tab) was not on the phone at all. Both are now
 * §279 cards on the phone, with the desktop's card names and payloads
 * ('about' → about.content; 'copy.snippets' → every copy.* key), on the
 * shared engine (public/tacet-autosave.js, required for real). Sliced out of
 * public/m.html (fast shard). Pins:
 *   1. Snippets: the catalogue is the desktop's (keys, words, defaults, order);
 *      the body is every key { en, cn } in that order; the stored value wins
 *      over the default; read-only without the content keys;
 *   2. About: the desktop's sections and words; the payload keeps a key no
 *      control asks about; the stat strip stops at four; IN / OUT rows; the
 *      two pictures upload to /cms/media and a refusal is said on the screen.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MH = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const RA = fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8');
const MK = fs.readFileSync(path.join(ROOT, 'public/retail-admin/05-marketing.js'), 'utf8');
const ENGINE = require(path.join(ROOT, 'public/tacet-autosave.js'));

let passed = 0, failed = 0;
const queue = [];
function section(t) { queue.push(() => console.log('\n' + t)); }
function it(name, fn) {
  queue.push(async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
  });
}
const slice = (src, a, b) => {
  const s = src.indexOf(a), e = src.indexOf(b, s + 1);
  if (s < 0 || e < 0) throw new Error('slice not found: ' + a);
  return src.slice(s, e);
};
const plain = (x) => JSON.parse(JSON.stringify(x));

const SRC = slice(MH, '/* ==========================================================================\n   §325 M4 — CONTENT THAT SAVES ITSELF', '/* ==========================================================================\n   FAQ & help (desktop: 07-content-billing.js)');
const ABOUT_SUB = (() => {
  const s = MH.indexOf("  about:{title:['About page','关于页']");
  let depth = 0, i = MH.indexOf('{', s);
  for (; i < MH.length; i++) { if (MH[i] === '{') depth++; else if (MH[i] === '}' && --depth === 0) break; }
  return MH.slice(s, i + 1);
})();

const ABOUT = { kicker_en: 'WHO WE ARE', kicker_cn: '我们是谁', manifesto_en: 'We make **real** food.', manifesto_cn: '', stats: [{ value_en: '7', value_cn: '7', label_en: 'years', label_cn: '年' }],
  founder_name_en: 'Lin', in_items: [{ en: 'Beans', cn: '豆子' }], out_items: [], hero_image_url: '', founder_photo_url: '/api/retail/media/3', legacy_note: 'keep me' };
function mk(opts = {}) {
  const writes = [], fetches = [], CMD = {};
  const files = [];
  const ctx = {
    LANG: opts.lang || 'en', API: '/api/retail-admin',
    T: (en, zh) => (opts.lang === 'zh' ? zh : en),
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    ic: () => '<i></i>',
    nothingYet: (a, b) => `<empty>${a}|${b}</empty>`,
    desktopNote: () => '<desk>',
    state: { cfg: opts.cfg === undefined ? { about: { content: JSON.parse(JSON.stringify(ABOUT)) }, copy: { cart: { title: { en: 'Nearly there.', cn: '快好了。' } } } } : opts.cfg,
      caps: opts.caps === undefined ? null : opts.caps, ask: null, askErr: null },
    render: () => {},
    reg: (n, f) => { CMD[n] = f; },
    showToast: () => {},
    askLiveRepaint: () => {},
    liveHistorySheet: () => {},
    shopToday: () => '2026-10-01',
    TacetAutosave: ENGINE,
    MEDIA_ERR: { too_large: ['That photo is too large. Try a smaller one.', '图片太大，请换一张较小的。'] },
    catBannerShrink: async (f) => f,
    apiRefusal: async () => ({ message: 'Your role cannot do this.' }),
    apiWrite: async (p, body, method) => { writes.push({ p, body: JSON.parse(JSON.stringify(body)), method }); return { success: true, data: null }; },
    api: async () => ({ versions: [] }),
    fetch: async (u, o) => { fetches.push({ u, method: o && o.method }); return opts.upload || { status: 200, ok: true, json: async () => ({ success: true, data: { id: 41, url: '/api/retail/media/41' } }) }; },
    FormData: class { constructor() { files.push(this); this.parts = []; } append(k, v, n) { this.parts.push([k, n]); } },
    location: {},
    document: { addEventListener: () => {}, getElementById: () => null, createElement: () => ({ click() {} }) },
    Object, Array, String, Number, JSON, Promise, Set, Math, Error, encodeURIComponent, setTimeout, clearTimeout,
  };
  ctx.cfgGet = (p, d) => { let v = ctx.state.cfg; for (const k of String(p).split('.')) { if (v == null) return d; v = v[k]; } return v == null ? d : v; };
  ctx.mCan = (v) => { const has = (k) => (ctx.state.caps ? ctx.state.caps.indexOf(k) !== -1 : true); return Array.isArray(v) ? v.some(has) : has(v); };
  vm.createContext(ctx);
  vm.runInContext(SRC + '\nthis.SUBABOUT=({' + ABOUT_SUB + '}).about; this.card=(k)=>CFG_CARD[k]; this.aboutD=()=>ABOUT_D; this.SNIPPETS=SNIPPETS; this.img=()=>ABOUT_IMG;', ctx);
  return { ctx, CMD, writes, fetches, files };
}
const live = (ctx) => ctx.state.ask && ctx.state.ask.live;
const type = (ctx, id, v) => { live(ctx).set(id, v); live(ctx).auto.touch(); };

section('1 · Mini-app copy');
{
  it('the catalogue is the desktop\'s: groups, keys, words, defaults, in order', () => {
    const desk = vm.runInNewContext(slice(MK, 'const SNIPPETS = [', '\nfunction snippetsRender()').replace('const SNIPPETS =', 'SNIPPETS =') + '; SNIPPETS', {});
    assert.deepStrictEqual(plain(mk().ctx.SNIPPETS), plain(desk));
  });
  it('the screen: each group, each label and its value in the operator\'s language; the card\'s foot', () => {
    const { ctx } = mk();
    const html = ctx.screenSnippets();
    assert.ok(/<div class="eyebrow"[^>]*>Cart<\/div>/.test(html));
    assert.ok(/APP\.cmd\('snipEdit','copy\.cart\.title'\)[\s\S]*?Headline<\/span>[\s\S]*?Nearly there\./.test(html), 'the stored value');
    assert.ok(/APP\.cmd\('snipEdit','copy\.cart\.kicker'\)[\s\S]*?YOUR BASKET/.test(html), 'the default where none is stored');
    assert.ok(/cfgHistory','copy\.snippets'/.test(html));
    const zh = mk({ lang: 'zh' }).ctx.screenSnippets();
    assert.ok(/>购物车<\/div>/.test(zh) && /快好了。/.test(zh) && /大标题/.test(zh));
  });
  it('an edit sends every snippet { en, cn } in the catalogue\'s order, on the desktop\'s card', async () => {
    const { ctx, CMD, writes } = mk();
    ctx.screenSnippets();
    CMD.snipEdit('copy.product.sold_out');
    assert.strictEqual(ctx.state.ask.title, 'Sold-out badge');
    assert.ok(/Shown over the photo when stock is exhausted\./.test(ctx.state.ask.body) && /copy\.product\.sold_out/.test(ctx.state.ask.body));
    assert.deepStrictEqual(plain(ctx.state.ask.fields), [{ id: 'en', label: 'EN' }, { id: 'cn', label: '中' }]);
    type(ctx, 'cn', '卖完了');
    await live(ctx).auto.flush();
    assert.strictEqual(writes[0].p, '/config?history=copy.snippets');
    assert.strictEqual(writes[0].method, 'PUT');
    const keys = Object.keys(writes[0].body);
    assert.deepStrictEqual(keys, plain(ctx.SNIPPETS.flatMap((g) => g.items.map((s) => s.key))));
    assert.deepStrictEqual(writes[0].body['copy.product.sold_out'], { en: 'SOLD OUT', cn: '卖完了' });
    assert.deepStrictEqual(writes[0].body['copy.cart.title'], { en: 'Nearly there.', cn: '快好了。' });
    assert.ok(/card: 'copy\.snippets', root: '#snippets-mount'/.test(MK));
  });
  it('without the content keys: read only, no sheet', () => {
    const { ctx, CMD } = mk({ caps: ['orders:view'] });
    const html = ctx.screenSnippets();
    assert.ok(!/snipEdit/.test(html) && !/cfgHistory/.test(html) && /disabled/.test(html));
    CMD.snipEdit('copy.cart.title');
    assert.strictEqual(ctx.state.ask, null);
  });
  it('a More row and a route, on the desktop tab\'s key', () => {
    assert.ok(/\['snippets','languages','Mini-app copy','小程序文案'\]/.test(MH));
    assert.ok(/snippets:'content:view',/.test(MH));
    assert.ok(/<h2>Mini-app copy · 小程序文案<\/h2>/.test(RA));
  });
}

section('2 · About');
{
  it('the desktop\'s sections, each with Edit; the pictures; the lists; the foot', () => {
    const { ctx } = mk();
    const html = ctx.SUBABOUT.render();
    for (const s of ['Top of the page', 'Manifesto', 'Stat strip', 'Founder', 'Photo', "What's IN / What's OUT", 'Sign-off']) assert.ok(html.includes(s), s);
    assert.ok(/We make real food\./.test(html), 'bold marks hidden in the summary');
    assert.ok(/APP\.cmd\('aboutEdit','manifesto'\)/.test(html) && /APP\.cmd\('aboutEdit','signoff'\)/.test(html));
    assert.ok(/APP\.cmd\('aboutRow','stats',0\)[\s\S]*?7 · years/.test(html));
    assert.ok(/APP\.cmd\('aboutRow','in_items',0\)[\s\S]*?Beans/.test(html));
    assert.ok(/No image — the page starts at the text\./.test(html) && /<img src="\/api\/retail\/media\/3"/.test(html));
    assert.ok(/cfgHistory','about'/.test(html) && !/<desk>/.test(html));
  });
  it('a section\'s sheet: the desktop\'s words; an edit sends about.content whole, keeping a key no control asks about', async () => {
    const { ctx, CMD, writes } = mk();
    ctx.SUBABOUT.render();
    CMD.aboutEdit('founder');
    assert.deepStrictEqual(plain(ctx.state.ask.fields.map((f) => f.label)), ['Section kicker (EN)', 'Section kicker suffix (CN)', 'Name (EN)', 'Name (CN)', 'Title (EN)', 'Title (CN)', 'Quote (EN)', 'Quote (CN)']);
    type(ctx, 'founder_title_en', 'FOUNDER');
    await live(ctx).auto.flush();
    assert.strictEqual(writes[0].p, '/config?history=about');
    const c = writes[0].body['about.content'];
    assert.deepStrictEqual(Object.keys(writes[0].body), ['about.content']);
    assert.strictEqual(c.founder_title_en, 'FOUNDER');
    assert.strictEqual(c.legacy_note, 'keep me');
    assert.deepStrictEqual(c.stats, [{ value_en: '7', value_cn: '7', label_en: 'years', label_cn: '年' }]);
    assert.strictEqual(c.founder_photo_url, '/api/retail/media/3');
  });
  it('the stat strip: add up to four, then no Add; a row removed', async () => {
    const { ctx, CMD, writes } = mk();
    ctx.SUBABOUT.render();
    CMD.aboutAddRow('stats'); CMD.aboutAddRow('stats'); CMD.aboutAddRow('stats'); CMD.aboutAddRow('stats');
    assert.strictEqual(ctx.aboutD().stats.length, 4);
    assert.ok(!/aboutAddRow','stats'/.test(ctx.SUBABOUT.render()));
    CMD.aboutRow('stats', 0);
    assert.deepStrictEqual(plain(ctx.state.ask.fields.map((f) => f.label)), ['Value EN', 'Value CN', 'Label EN', 'Label CN']);
    CMD.askLiveAct('rm');
    await ctx.card('about').auto.flush();
    assert.strictEqual(writes[writes.length - 1].body['about.content'].stats.length, 3);
  });
  it('IN and OUT rows: add opens the new row; both languages', async () => {
    const { ctx, CMD, writes } = mk();
    ctx.SUBABOUT.render();
    CMD.aboutAddRow('out_items');
    type(ctx, 'en', 'Preservatives'); type(ctx, 'cn', '防腐剂');
    await live(ctx).auto.flush();
    assert.deepStrictEqual(writes[0].body['about.content'].out_items, [{ en: 'Preservatives', cn: '防腐剂' }]);
  });
  it('a picture: uploaded to /cms/media, set, saved; Remove clears it', async () => {
    const { ctx, CMD, writes, fetches } = mk();
    ctx.SUBABOUT.render();
    await ctx.aboutUpload('hero_image_url', { name: 'a.jpg', type: 'image/jpeg' });
    assert.deepStrictEqual(fetches, [{ u: '/api/retail-admin/cms/media', method: 'POST' }]);
    assert.strictEqual(ctx.aboutD().hero_image_url, '/api/retail/media/41');
    await ctx.card('about').auto.flush();
    assert.strictEqual(writes[0].body['about.content'].hero_image_url, '/api/retail/media/41');
    CMD.aboutPicClear('founder_photo_url');
    await ctx.card('about').auto.flush();
    assert.strictEqual(writes[1].body['about.content'].founder_photo_url, '');
  });
  it('a refused or failed upload is said on the screen; nothing changes', async () => {
    const no = mk({ upload: { status: 403, ok: false, json: async () => ({}) } });
    no.ctx.SUBABOUT.render();
    await no.ctx.aboutUpload('hero_image_url', {});
    assert.strictEqual(no.ctx.aboutD().hero_image_url, '');
    assert.ok(/Your role cannot do this\./.test(no.ctx.SUBABOUT.render()));
    const big = mk({ upload: { status: 400, ok: false, json: async () => ({ success: false, error: 'too_large' }) } });
    big.ctx.SUBABOUT.render();
    await big.ctx.aboutUpload('founder_photo_url', {});
    assert.ok(/That did not upload\. That photo is too large\. Try a smaller one\./.test(big.ctx.SUBABOUT.render()));
    assert.strictEqual(big.ctx.aboutD().founder_photo_url, '/api/retail/media/3');
  });
  it('without the content keys: the read-only page, no edit command works', () => {
    const { ctx, CMD } = mk({ caps: ['orders:view'] });
    const html = ctx.SUBABOUT.render();
    assert.ok(!/aboutEdit|cfgHistory/.test(html));
    CMD.aboutEdit('manifesto'); CMD.aboutAddRow('stats');
    assert.strictEqual(ctx.state.ask, null);
  });
  it('every About label is the desktop editor\'s own pair', () => {
    const fused = ["Kicker (EN) · 引题(英文)", "Kicker suffix (CN) · 引题后缀(中文)", "Body — English · 正文(英文)", "Section kicker (EN) · 栏目引题(英文)",
      "Section kicker suffix (CN) · 栏目引题后缀(中文)", "Name (EN) · 姓名(英文)", "Title (CN) · 头衔(中文)", "Quote (CN) · 引言(中文)", "Headline (EN) · 标题(英文)",
      "Button label (CN) · 按钮文字(中文)", "+ Add stat · 添加数据项", "+ Add IN item · 添加「是」项", "+ Add OUT item · 添加「否」项", "Choose image… · 选择图片…",
      "Value EN · 英文值", "Label CN · 中文标签", "Sign-off · 结尾", "Stat strip · 数据条", "Manifesto · 宣言", "What's IN / What's OUT · 是 / 否",
      "No image — the page starts at the text. · 暂无图片", "No photo — placeholder tile will show. · 暂无照片 — 将显示占位图。"];
    for (const f of fused) assert.ok(RA.includes(f), f);
  });
}

(async () => {
  for (const f of queue) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
