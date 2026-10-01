#!/usr/bin/env node
/**
 * §325 M1 — THE PAGE EDITOR'S DOOR, AND WHAT THE PHONE EDITOR WAS MISSING.
 *
 *   node scripts/test_mobile_editor_door.js
 *
 * The phone app's Editor screen listed a page's blocks and said editing and
 * publishing were desktop-only, while the phone editor (/cms on a phone →
 * cms-mobile.html) could already do both — and nothing in the app led there.
 * The phone editor in turn lacked what every desktop inspector has at its foot
 * (Show on, Frame, Corner radius, Full width) and let a coupon block be typed
 * rather than linked to a real coupon.
 *
 * The code is RUN, sliced out of public/m.html, public/cms-mobile.html and
 * public/cms.html into sandboxes (no browser: this suite stays in the fast
 * shard). What it pins:
 *   1. m.html: the Editor header's door, drawn for content:edit only, leaving
 *      for /cms?from=m; the page names are the editor's own (Shop landing);
 *      nothing on the screen says the work is desktop-only; loading, empty
 *      and failed states;
 *   2. cms-mobile: every block's Show on / Frame / Corner radius / Full width,
 *      each a 'patch' of exactly the field desktop writes, with desktop's
 *      "none" (the key left undefined);
 *   3. cms-mobile: the coupon block picks a real coupon ('pickCoupon'), shows
 *      the headline / subtitle / discount / code read-only, and no longer
 *      offers them as typed fields; no coupons → the desktop's own note;
 *   4. cms.html's bridge: the facts the phone reads (showOn, its default, the
 *      coupons, the live display) and 'pickCoupon' running the desktop
 *      select's own handler;
 *   5. cms-mobile's Back, shown only when opened from the phone app.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MH = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const CM = fs.readFileSync(path.join(ROOT, 'public/cms-mobile.html'), 'utf8');
const CD = fs.readFileSync(path.join(ROOT, 'public/cms.html'), 'utf8');

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
const tick = () => new Promise((r) => setImmediate(r));
// Objects made inside a sandbox carry its prototypes; compare their JSON.
const plain = (x) => JSON.parse(JSON.stringify(x));

/* ── 1 · m.html ─────────────────────────────────────────────────────────── */
const ED_SRC = slice(MH, 'const CMS_PAGES=', 'function screenDelivery(){');
const MCAN_SRC = slice(MH, 'const MCAN_MONEY_ONLY=', 'function canRoute(k){');
const SUB_SRC = (() => {   // the whole editor:{…} entry, which spans a few lines
  const s = MH.indexOf("  editor:{title:['Editor','编辑器']");
  let depth = 0, i = MH.indexOf('{', s);
  for (; i < MH.length; i++) { if (MH[i] === '{') depth++; else if (MH[i] === '}' && --depth === 0) break; }
  return MH.slice(s, i + 1);
})();

function mkM(opts = {}) {
  const calls = { api: [], renders: 0 };
  const ctx = {
    LANG: opts.lang || 'en',
    T: (en, zh) => (opts.lang === 'zh' ? zh : en),
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    ic: () => '<i></i>',
    PILL: { warning: ['a', 'b'], success: ['c', 'd'] },
    noteBar: (t) => '<note>' + t + '</note>',
    render: () => { calls.renders++; },
    state: Object.assign({ cms: {}, cmsPage: 'home', cmsErr: null, cmsTried: {}, caps: null }, opts.state || {}),
    api: (u) => { calls.api.push(u); return opts.api ? opts.api(u) : new Promise(() => {}); },
    Object, String, Array, Set, Promise, encodeURIComponent,
  };
  ctx.E = (en, zh) => ({ toString() { return ctx.T(en, zh); } });
  ctx.chipRow = (items, cur, cmd) => items.map((c) => `<chip ${c.key === cur ? 'on' : ''} cmd="${cmd}" key="${c.key}">${ctx.T(c.en, c.zh)}</chip>`).join('');
  vm.createContext(ctx);
  vm.runInContext(MCAN_SRC + ED_SRC + '\nthis.SUB=({' + SUB_SRC + '}).editor;', ctx);
  return { ctx, calls };
}

section('1 · the phone app\'s Editor screen');
{
  it('the door is drawn for content:edit and leaves for /cms?from=m', () => {
    const { ctx } = mkM({ state: { caps: ['editor:view', 'content:edit'] } });
    const html = ctx.SUB.cta();
    assert.ok(/<button class="cta inhead" onclick="APP\.cmd\('leave','\/cms\?from=m'\)">Open page editor<\/button>/.test(html), html);
  });
  it('no door for an account without content:edit (the key the editor\'s own gate admits)', () => {
    const { ctx } = mkM({ state: { caps: ['editor:view', 'editor:edit'] } });
    assert.strictEqual(ctx.SUB.cta(), '');
  });
  it('with capabilities unknown (permissions off) the door is drawn, as every non-money control is', () => {
    const { ctx } = mkM({ state: { caps: null } });
    assert.ok(/Open page editor/.test(ctx.SUB.cta()));
  });
  it('in Chinese, the capability\'s own pair', () => {
    const { ctx } = mkM({ lang: 'zh', state: { caps: ['content:edit'] } });
    assert.ok(/>打开页面编辑器<\/button>/.test(ctx.SUB.cta()));
  });
  it('the leave command goes only to a path on this host', () => {
    assert.ok(/reg\('leave', href=>\{ if\(typeof href==='string'&&href\.charAt\(0\)==='\/'&&href\.charAt\(1\)!=='\/'\) location\.href=href; \}\);/.test(MH));
  });
  it('the page names are the editor\'s own: Shop landing, not Categories', () => {
    const { ctx } = mkM({ state: { cms: { home: { live: [], draft: [] } } } });
    const html = ctx.screenEditor();
    const names = [...html.matchAll(/<chip[^>]*key="([a-z]+)">([^<]+)<\/chip>/g)].map((m) => m[1] + '=' + m[2]);
    assert.deepStrictEqual(names, ['home=Home', 'promotions=Promotions', 'categories=Shop landing', 'membership=Membership', 'onboarding=Onboarding']);
    const zh = mkM({ lang: 'zh', state: { cms: { home: { live: [], draft: [] } } } }).ctx.screenEditor();
    assert.deepStrictEqual([...zh.matchAll(/<chip[^>]*>([^<]+)<\/chip>/g)].map((m) => m[1]), ['首页', '优惠', '商品', '会员', '欢迎']);
    // …and they are the desktop editor's PAGES, word for word.
    for (const [id, en, cn] of [['home', 'Home', '首页'], ['promotions', 'Promotions', '优惠'], ['categories', 'Shop landing', '商品'], ['membership', 'Membership', '会员'], ['onboarding', 'Onboarding', '欢迎']]) {
      assert.ok(new RegExp("\\{ id: '" + id + "',\\s+name: '" + en + "',\\s+cn: '" + cn + "'").test(CD), id + ' in cms.html PAGES');
    }
  });
  it('an unpublished draft: said, and nothing says publishing is on desktop', () => {
    const { ctx } = mkM({ state: { cms: { home: { dirty: true, live: [{ type: 'hero_banner' }], draft: [{ type: 'hero_banner' }, { type: 'spacer' }] } } } });
    const html = ctx.screenEditor();
    assert.ok(/Unpublished changes/.test(html));
    assert.ok(/A draft is saved that does not match what shoppers see — 2 blocks in the draft, 1 live\./.test(html));
    assert.ok(!/desktop/i.test(html), 'no desktop-only claim');
    assert.ok(!/<note>/.test(html), 'no "placed, edited and published on desktop" note');
    const zh = mkM({ lang: 'zh', state: { cms: { home: { dirty: true, live: [], draft: [] } } } }).ctx.screenEditor();
    assert.ok(!/电脑端/.test(zh));
  });
  it('the live blocks, in order, by the composer\'s names and the operator\'s titles', () => {
    const { ctx } = mkM({ state: { cms: { home: { live: [{ type: 'hero_banner', props: { title_en: 'Autumn menu' } }, { type: 'coupon_block' }], draft: [] } } } });
    const html = ctx.screenEditor();
    assert.ok(/Hero banner[\s\S]*Autumn menu[\s\S]*Coupon/.test(html));
    assert.ok(!/<note>/.test(html));
  });
  it('loading, empty and failed', async () => {
    const loading = mkM();
    assert.ok(/Loading…/.test(loading.ctx.screenEditor()));
    assert.deepStrictEqual(loading.calls.api, ['/cms/layout?page=home']);
    const empty = mkM({ state: { cms: { home: { live: [], draft: [] } } } });
    assert.ok(/Nothing is published on this page yet\./.test(empty.ctx.screenEditor()));
    const bad = mkM({ api: () => Promise.reject(new Error('500')) });
    bad.ctx.screenEditor(); await tick();
    assert.ok(/Could not load the layout\./.test(bad.ctx.screenEditor()));
  });
}

/* ── 2 · cms-mobile: chrome and coupon ──────────────────────────────────── */
const PM_SRC = slice(CM, "/* ── §325 · THE COUPON BLOCK'S PICKER", '/* ── §299 · PROMO CARDS, ON THE PHONE');

// A stand-in element: keeps its HTML; hands out one control per data-a="…",
// and one per data-frame / data-corner value found in the HTML.
function el() {
  const e = {
    html: '', kids: [], controls: {}, groups: {}, style: {}, className: '',
    set innerHTML(v) {
      this.html = v; this.kids = []; this.controls = {}; this.groups = {};
      for (const attr of ['frame', 'corner']) {
        this.groups[attr] = [...v.matchAll(new RegExp('data-' + attr + '="([^"]*)"', 'g'))]
          .map((m) => ({ dataset: { [attr]: m[1] }, onclick: null }));
      }
    },
    get innerHTML() { return this.html; },
    appendChild(k) { this.kids.push(k); },
    querySelector(sel) {
      const m = sel.match(/\[data-a=([a-z]+)\]/);
      const k = m && m[1];
      if (!k) return null;
      if (!this.controls[k]) this.controls[k] = { onclick: null, onchange: null };
      return this.controls[k];
    },
    querySelectorAll(sel) {
      const m = sel.match(/\[data-(frame|corner)\]/);
      return m ? this.groups[m[1]] : [];
    },
  };
  return e;
}
const FRAMES = [{ value: 'lime-leaf', label: 'Lime · 青柠', hex: '#CCD900' }, { value: 'ink', label: 'Ink · 墨黑', hex: '#1a1a17' }];
const CORNERS = [{ value: 'sharp', label: 'Sharp · 直角' }, { value: 'subtle', label: 'Subtle · 微圆角' }, { value: 'bold', label: 'Bold · 大圆角' }];
function mkC(opts = {}) {
  const sent = [];
  const ctx = {
    M: Object.assign({ lang: opts.lang || 'en', editId: 'b1', extra: opts.extra || null, frameColors: FRAMES, corners: CORNERS }),
    cuT: (en, cn) => (opts.lang === 'cn' ? cn : en),
    esc: (s) => (s == null ? '' : String(s)).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    // Raw, as postMessage's structured clone keeps it: an undefined value is
    // a key that is THERE with nothing in it, which the spread then clears.
    send: (cmd, x) => sent.push({ cmd, x }),
    document: { createElement: () => el() },
    Object, String, Array, JSON,
  };
  vm.createContext(ctx);
  vm.runInContext(PM_SRC, ctx);
  return { ctx, sent };
}
const chrome = (ctx, blk) => { const body = el(); ctx.renderChrome(body, blk); return body.kids[0]; };

section('2 · every block: Show on, Frame, Corner radius, Full width');
{
  it('the sheet draws them on every block with a loaded copy, promo cards included', () => {
    const re = CM.slice(CM.indexOf('function renderEdit() {'), CM.indexOf("/* ── §325 · THE COUPON BLOCK'S PICKER"));
    assert.ok(/\n  if \(blk\) renderChrome\(body, blk\);\n/.test(re));
    const afterPromo = re.slice(re.indexOf('renderPromoEdit(body, blk);'), re.indexOf('if (blk) renderChrome(body, blk);'));
    assert.ok(afterPromo.length > 0 && !/\breturn\b/.test(afterPromo), 'nothing returns between the promo editor and the chrome');
  });
  it('the effective Show on, as the bridge worked it out, with the inspector\'s words', () => {
    const { ctx } = mkC({ extra: { showOn: 'web', showOnDefault: 'both' } });
    const w = chrome(ctx, { id: 'b1', type: 'hero_banner' });
    assert.ok(/<div class="t">Show on<\/div>/.test(w.html));
    assert.ok(/<option value="both">Mini app \+ website<\/option><option value="miniapp">Mini app only<\/option><option value="web" selected>Website only<\/option>/.test(w.html));
    assert.ok(/Where customers see this block\./.test(w.html));
    assert.ok(!/has no wallet/.test(w.html));
  });
  it('a mini-app-only type left at its default says why the website skips it', () => {
    const { ctx } = mkC({ extra: { showOn: 'miniapp', showOnDefault: 'miniapp' } });
    assert.ok(/The website has no wallet, notifications or order pages yet/.test(chrome(ctx, { id: 'b1', type: 'top_up' }).html));
    const turnedOn = mkC({ extra: { showOn: 'both', showOnDefault: 'miniapp' } });
    assert.ok(!/has no wallet/.test(chrome(turnedOn.ctx, { id: 'b1', type: 'top_up' }).html));
  });
  it('Show on writes show_on, and only that', () => {
    const { ctx, sent } = mkC({ extra: { showOn: 'both' } });
    chrome(ctx, { id: 'b1' }).controls.showon.onchange({ target: { value: 'miniapp' } });
    assert.deepStrictEqual(plain(sent), [{ cmd: 'patch', x: { id: 'b1', patch: { show_on: 'miniapp' } } }]);
  });
  it('Frame: none plus the inspector\'s colours; the current one lit; none clears the key', () => {
    const { ctx, sent } = mkC({ extra: {} });
    const w = chrome(ctx, { id: 'b1', frame_color: 'ink' });
    assert.ok(/<div class="sw none" data-frame="" title="— none —"><\/div>/.test(w.html));
    assert.ok(/<div class="sw on" data-frame="ink" title="Ink" style="background:#1a1a17"><\/div>/.test(w.html));
    assert.ok(/Add a coloured outline around this block\./.test(w.html));
    w.groups.frame[1].onclick();
    w.groups.frame[0].onclick();
    assert.strictEqual(sent[0].x.patch.frame_color, 'lime-leaf');
    assert.ok('frame_color' in sent[1].x.patch && sent[1].x.patch.frame_color === undefined, 'none is undefined, as desktop sends');
    assert.deepStrictEqual(Object.keys(sent[1].x.patch), ['frame_color']);
  });
  it('Corner radius: subtle when unset, each chip writes corner_radius', () => {
    const { ctx, sent } = mkC({ extra: {} });
    const w = chrome(ctx, { id: 'b1' });
    assert.ok(/<button class="vchip on" data-corner="subtle">Subtle<\/button>/.test(w.html));
    w.groups.corner[2].onclick();
    assert.deepStrictEqual(plain(sent[0]), { cmd: 'patch', x: { id: 'b1', patch: { corner_radius: 'bold' } } });
  });
  it('Full width: true when ticked, the key cleared when not', () => {
    const { ctx, sent } = mkC({ extra: {} });
    const w = chrome(ctx, { id: 'b1', full_bleed: true });
    assert.ok(/<input type="checkbox" data-a="bleed" checked><span>Stretch full width \(edge to edge\)<\/span>/.test(w.html));
    w.controls.bleed.onchange({ target: { checked: false } });
    w.controls.bleed.onchange({ target: { checked: true } });
    assert.ok('full_bleed' in sent[0].x.patch && sent[0].x.patch.full_bleed === undefined);
    assert.strictEqual(sent[1].x.patch.full_bleed, true);
  });
  it('in Chinese, the inspector\'s Chinese', () => {
    const { ctx } = mkC({ lang: 'cn', extra: { showOn: 'both' } });
    const w = chrome(ctx, { id: 'b1', frame_color: 'lime-leaf' });
    for (const s of ['显示位置', '小程序 + 网页版', '边框、圆角与宽度', '为本模块添加彩色边框。', 'title="青柠"', '>微圆角<', '拉伸至全宽（贴合屏幕两侧）']) {
      assert.ok(w.html.includes(s), s);
    }
  });
}

section('3 · the coupon block links a real coupon');
{
  const LIVE = { title_en: 'Welcome back', title_cn: '欢迎回来', subtitle_en: 'Min spend ¥50', subtitle_cn: '满 50 元可用', discount_label_en: '¥10', code: 'HELLO10' };
  const pick = (ctx, blk) => { const body = el(); ctx.renderCouponPick(body, blk); return body.kids; };
  it('no title, subtitle or code to type any more; the kicker and button stay', () => {
    // Since §325 M3 the sheet's fields are the inspector's own (mirrored), so
    // what can be typed is what the desktop coupon form lets be typed.
    const form = CD.slice(CD.indexOf('function buildCouponForm('), CD.indexOf('function buildPointsForm('));
    const typed = [...form.matchAll(/txtPair\(b\.(\w+)_en/g)].map((m) => m[1]);
    assert.deepStrictEqual(typed, ['kicker', 'cta_label']);
    assert.ok(!/txt\(b\.code|txtPair\(b\.title_en|txtPair\(b\.subtitle_en/.test(form));
    // the picker and the three read-only lines are the sheet's own, not mirrored twice
    assert.strictEqual((form.match(/fcSkip\(field\(/g) || []).length, 5);
    assert.ok(/if \(type === 'coupon_block'\) renderCouponPick\(body, blk\);/.test(CM));
    assert.ok(!/^const F = \{/m.test(CM), 'the curated text-field list is gone');
  });
  it('the active coupons, the linked one chosen, and the read-only lines from it', () => {
    const { ctx } = mkC({ extra: { coupons: [{ id: 3, code: 'HELLO10', title_en: 'Welcome back' }, { id: 4, code: '', title_en: '' }], couponLive: LIVE } });
    const [p, head, sub, disc] = pick(ctx, { id: 'b1', type: 'coupon_block', voucher_id: 3 });
    assert.ok(/<option value="">— Select a coupon —<\/option><option value="3" selected>HELLO10 — Welcome back<\/option><option value="4">#4<\/option>/.test(p.html), p.html);
    assert.ok(/<label>Headline<\/label><div class="ro-line">Welcome back<\/div>/.test(head.html));
    assert.ok(/Follows the coupon — change it by editing the coupon’s name in Marketing\./.test(head.html));
    assert.ok(/<div class="ro-line">Min spend ¥50<\/div>/.test(sub.html));
    assert.ok(/<div class="ro-line">Big number: ¥10   ·   CODE: HELLO10<\/div>/.test(disc.html));
    assert.ok(!/<input/.test(head.html + sub.html + disc.html), 'nothing here is typed');
  });
  it('picking sends pickCoupon with the coupon; the empty choice unlinks', () => {
    const { ctx, sent } = mkC({ extra: { coupons: [{ id: 3, code: 'HELLO10' }] } });
    const [p] = pick(ctx, { id: 'b1', type: 'coupon_block' });
    p.controls.coupon.onchange({ target: { value: '3' } });
    p.controls.coupon.onchange({ target: { value: '' } });
    assert.deepStrictEqual(plain(sent), [{ cmd: 'pickCoupon', x: { id: 'b1', voucherId: '3' } }, { cmd: 'pickCoupon', x: { id: 'b1', voucherId: null } }]);
  });
  it('nothing linked yet: the lines say to pick one', () => {
    const { ctx } = mkC({ extra: { coupons: [{ id: 3, code: 'HELLO10' }], couponLive: null } });
    const kids = pick(ctx, { id: 'b1', type: 'coupon_block' });
    assert.strictEqual(kids.length, 3, 'no subtitle line without a coupon');
    assert.ok(/Pick a coupon above\./.test(kids[1].html));
    assert.ok(/Pick a coupon above to set the discount and code\./.test(kids[2].html));
    assert.ok(/<option value="" selected>— Select a coupon —/.test(kids[0].html));
  });
  it('no coupons at all: the desktop\'s own note, and no picker', () => {
    const { ctx } = mkC({ extra: { coupons: [] } });
    const [p] = pick(ctx, { id: 'b1', type: 'coupon_block' });
    assert.ok(/No coupons exist yet\. Create one in the Mini App Backend → Marketing → Coupons, then pick it here\./.test(p.html));
    assert.ok(!/<select/.test(p.html));
  });
  it('in Chinese, the coupon\'s Chinese title', () => {
    const { ctx } = mkC({ lang: 'cn', extra: { coupons: [{ id: 3, code: 'HELLO10' }], couponLive: LIVE } });
    const kids = pick(ctx, { id: 'b1', type: 'coupon_block', voucher_id: 3 });
    assert.ok(/<label>标题<\/label><div class="ro-line">欢迎回来<\/div>/.test(kids[1].html));
    assert.ok(/左侧大号数字:¥10/.test(kids[3].html));
  });
}

/* ── 4 · the bridge in cms.html ─────────────────────────────────────────── */
section('4 · the bridge carries the facts, and pickCoupon is the desktop select\'s handler');
{
  const BR = slice(CD, "  // §325 — what the phone's edit sheet needs beside the block itself", '  const postDesign = () => {');
  const PICK = slice(CD, "        case 'pickCoupon': {", "        case 'switchPage':");
  function mkB(vouchers) {
    const posted = [], updates = [];
    const ctx = {
      state: { vouchers },
      SHOW_ON_DEFAULTS: { top_up: 'miniapp' },
      showOnFor: (b) => b.show_on || (b.type === 'top_up' ? 'miniapp' : 'both'),
      liveCouponDisplay: (b) => (b.voucher_id ? { code: 'X' } : null),
      couponDisplayFromVoucher: (v) => ({ voucher_id: v.id, code: v.code, title_en: v.title_en }),
      updateBlock: (id, patch) => updates.push({ id, patch }),
      POST: (m) => posted.push(m),
      selectedBlock: () => ctx._sel,
      String,
    };
    vm.createContext(ctx);
    vm.runInContext(BR + '\nthis.postSelected=postSelected;\nthis.run=(d)=>{ switch (d.cmd) {\n' + PICK + '} };', ctx);
    return { ctx, posted, updates };
  }
  it('selected carries showOn and its default; a coupon block also carries coupons and the live display', () => {
    const { ctx, posted } = mkB([{ id: 3, code: 'HELLO10', title_en: 'Welcome', is_active: true, value: 10 }]);
    ctx._sel = { id: 'b1', type: 'top_up' };
    ctx.postSelected();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(posted[0])), { evt: 'selected', block: { id: 'b1', type: 'top_up' }, extra: { showOn: 'miniapp', showOnDefault: 'miniapp' } });
    ctx._sel = { id: 'b2', type: 'coupon_block', voucher_id: 3 };
    ctx.postSelected();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(posted[1].extra)), { showOn: 'both', showOnDefault: 'both', coupons: [{ id: 3, code: 'HELLO10', title_en: 'Welcome' }], couponLive: { code: 'X' } });
    ctx._sel = null;
    ctx.postSelected();
    assert.strictEqual(posted[2].extra, null);
  });
  it('pickCoupon: a coupon fills the block from it; none unlinks; an unknown one changes nothing', () => {
    const { ctx, updates } = mkB([{ id: 3, code: 'HELLO10', title_en: 'Welcome' }]);
    ctx.run({ cmd: 'pickCoupon', id: 'b1', voucherId: '3' });
    ctx.run({ cmd: 'pickCoupon', id: 'b1', voucherId: null });
    ctx.run({ cmd: 'pickCoupon', id: 'b1', voucherId: '99' });
    assert.deepStrictEqual(plain(updates), [
      { id: 'b1', patch: { voucher_id: 3, code: 'HELLO10', title_en: 'Welcome' } },
      { id: 'b1', patch: { voucher_id: null } },
    ]);
  });
  it('the desktop select does the same two things', () => {
    assert.ok(/if \(!val\) \{ updateBlock\(b\.id, \{ voucher_id: null \}\); return; \}\s*const v = vouchers\.find\(x => String\(x\.id\) === String\(val\)\);\s*if \(v\) updateBlock\(b\.id, couponDisplayFromVoucher\(v\)\);/.test(CD));
  });
  it('ready carries the inspector\'s own Frame and Corner radius lists', () => {
    assert.ok(/frameColors: BRAND_COLOR_OPTIONS\.map\(o => \(\{ value: o\.value, label: o\.label, hex: dcResolveHex\(o\.value\) \|\| null \}\)\),/.test(CD));
    assert.ok(/corners: CORNER_RADIUS_OPTIONS\.map\(o => \(\{ value: o\.value, label: o\.label \}\)\),/.test(CD));
    assert.ok(/M\.frameColors = d\.frameColors \|\| \[\];\s*M\.corners = d\.corners \|\| \[\];/.test(CM));
    assert.ok(/M\.extra = d\.extra \|\| null;/.test(CM));
  });
}

/* ── 5 · the way back ───────────────────────────────────────────────────── */
section('5 · cms-mobile\'s Back, when opened from the phone app');
{
  const BD = slice(CM, 'function fromPhoneApp() {', 'function gateLogin() {');
  function mkD(search, referrer, histLen) {
    const nav = { back: 0, href: null };
    const brand = { innerHTML: '<span class="logo">F</span>' };
    const ctx = {
      location: { search, origin: 'https://store.example', set href(v) { nav.href = v; } },
      document: { referrer, querySelector: () => brand },
      history: { length: histLen, back: () => { nav.back++; } },
      URL, URLSearchParams,
      cuT: (en) => en,
      esc: (s) => String(s),
      SV: () => '<svg></svg>',
    };
    vm.createContext(ctx);
    vm.runInContext(BD, ctx);
    return { ctx, nav, brand };
  }
  it('opened from the app: the logo becomes Back', () => {
    const { ctx, brand } = mkD('?from=m', '', 1);
    ctx.backDoor();
    assert.ok(/<button class="icon-btn" id="back-btn" onclick="backToApp\(\)" aria-label="Back"/.test(brand.innerHTML));
  });
  it('opened any other way: the logo stays', () => {
    const { ctx, brand } = mkD('', '', 1);
    ctx.backDoor();
    assert.strictEqual(brand.innerHTML, '<span class="logo">F</span>');
  });
  it('Back returns to the very screen when the browser holds it, else to the app', () => {
    const a = mkD('?from=m', 'https://store.example/m', 3); a.ctx.backToApp();
    assert.deepStrictEqual(a.nav, { back: 1, href: null });
    const b = mkD('?from=m', '', 1); b.ctx.backToApp();
    assert.deepStrictEqual(b.nav, { back: 0, href: '/m' });
    const c = mkD('?from=m', 'https://elsewhere.example/m', 3); c.ctx.backToApp();
    assert.deepStrictEqual(c.nav, { back: 0, href: '/m' });
  });
  it('it runs at boot, once the account is let in', () => {
    assert.ok(/\/\/ Auth OK — show the editor, mount the real preview\.\s*backDoor\(\);/.test(CM));
  });
}

(async () => {
  for (const f of queue) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
