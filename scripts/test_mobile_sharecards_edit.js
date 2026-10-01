#!/usr/bin/env node
/**
 * §325 M8 — SHARE CARDS ARE SET ON THE PHONE, AND SAVE THEMSELVES.
 *
 *   node scripts/test_mobile_sharecards_edit.js
 *
 * The phone showed which of the four share cards had a picture and said
 * "Pictures and titles are set on desktop". It now edits them as the desktop
 * does (10-extras.js SC_CARDS): one §279 card per page — 'share.home',
 * 'share.product', 'share.voting' on PUT /config (sharing.<key>,
 * sharing.<key>Title), and 'share.invite' on PATCH /affiliate/settings
 * (shareImage, shareTitle only). Sliced out of public/m.html and run in a
 * sandbox (fast shard), with the real autosave engine. Pins:
 *   1. the list: each page opens on sharing:edit; the invite card loading,
 *      and failing — when it is never started;
 *   2. what each card sends, titles trimmed, the product card titleless;
 *   3. the picture: POST /media/upload (on media:upload), removed, refused;
 *   4. the invite card's history, from the affiliate keys;
 *   5. without sharing:edit nothing opens or writes.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MH = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
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
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const plain = (x) => JSON.parse(JSON.stringify(x));

const CARD_SRC = slice(MH, '/* ==========================================================================\n   §325 M4 — CONTENT THAT SAVES ITSELF', '/* ── Legal pages');
const SC_SRC = slice(MH, '/* ==========================================================================\n   Share cards (desktop: 10-extras.js)', '/* ==========================================================================\n   §325 M8 — SOCIAL PROOF');

const CFG = { sharing: { home: '/api/retail/media/1', homeTitle: { en: 'Fresh', cn: '新鲜' }, product: '', voting: '', votingTitle: { en: '', cn: '' } } };
const AFF = { shareImage: '/api/retail/media/9', shareTitle: { en: 'Join me', cn: '一起来' }, rewardPerOrder: 10 };

function mk(opts = {}) {
  const writes = [], reads = [], toasts = [], uploads = [], CMD = {};
  let histSheet = null;
  const T = (en, zh) => (opts.lang === 'zh' ? zh : en);
  const ctx = {
    LANG: opts.lang || 'en', T, API: '/api/retail-admin',
    E: (en, zh) => ({ toString() { return T(en, zh); } }),
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    ic: () => '<i></i>',
    PILL: { success: ['g', 'G'], muted: ['m', 'M'] },
    MEDIA_ERR: { too_large: ['Too large.', '太大。'] },
    apiRefusal: async () => ({ message: 'Your role cannot upload pictures.' }),
    catBannerShrink: async (f) => f,
    FormData: class { constructor() { this.parts = []; } append(k, v, n) { this.parts.push([k, v, n]); } },
    fetch: async (u, o) => {
      uploads.push({ u, method: o && o.method });
      if (opts.upload === 403) return { status: 403, ok: false };
      if (opts.upload === 'big') return { status: 400, ok: false, json: async () => ({ success: false, error: 'too_large' }) };
      return { status: 200, ok: true, json: async () => ({ success: true, data: { url: '/api/retail/media/77' } }) };
    },
    location: { href: '' },
    state: { cfg: opts.cfg === undefined ? plain(CFG) : opts.cfg, caps: opts.caps === undefined ? null : opts.caps, ask: null, askErr: null,
      scTried: false, scAff: null, stack: [{ route: 'sharecards' }] },
    render: () => {},
    CMD,
    reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => toasts.push(m),
    askLiveRepaint: () => {},
    liveHistorySheet: (list, sub, restore) => { histSheet = { list, sub, restore }; },
    TacetAutosave: ENGINE,
    apiWrite: async (p, body, method) => {
      writes.push({ p, body: JSON.parse(JSON.stringify(body)), method });
      if (opts.writeFails) { const e = new Error('Your role cannot change share cards.'); e.refused = true; throw e; }
      return { success: true, data: ctx.state.cfg };
    },
    api: async (p) => {
      reads.push(p);
      if (p === '/affiliate/settings') { if (opts.affFails) throw new Error('network'); return plain(AFF); }
      if (p.startsWith('/config/history')) return opts.history || { success: true, versions: [] };
      return {};
    },
    document: { addEventListener: () => {}, getElementById: () => null, visibilityState: 'visible' },
    Object, Array, String, Number, JSON, Promise, Set, Math, Error, encodeURIComponent, setTimeout, clearTimeout, parseInt,
  };
  CMD.push = (r) => ctx.state.stack.push({ route: r });
  ctx.cfgGet = (p, d) => { let v = ctx.state.cfg; for (const k of String(p).split('.')) { if (v == null) return d; v = v[k]; } return v == null ? d : v; };
  ctx.mCan = (v) => { if (v === undefined) return true; const has = (k) => (ctx.state.caps ? ctx.state.caps.indexOf(k) !== -1 : true); return Array.isArray(v) ? v.some(has) : has(v); };
  vm.createContext(ctx);
  vm.runInContext(CARD_SRC + SC_SRC + '\nthis.card=(k)=>CFG_CARD[k]; this.scD=()=>SC_D; this.scUpload=scUpload; this.cardFootHtml=cardFootHtml;' +
    ' this.screenShareCards=screenShareCards; this.screenShareCard=screenShareCard;', ctx);
  return { ctx, CMD, writes, reads, toasts, uploads, hist: () => histSheet };
}
const opened = async (o, key) => { const m = mk(o); m.ctx.screenShareCards(); await tick(); m.ctx.screenShareCards(); m.CMD.scOpen(key); return m; };
const flush = (ctx, k) => ctx.card('share.' + k).auto.flush();

section('1 · the list');
{
  it('each page opens with sharing:edit; the picture and title are the stored ones; no "set on desktop"', async () => {
    const { ctx, reads } = mk();
    ctx.screenShareCards(); await tick();
    const html = ctx.screenShareCards();
    for (const k of ['home', 'product', 'voting', 'invite']) assert.ok(html.includes(`APP.cmd('scOpen','${k}')`), k);
    assert.ok(html.includes('“Fresh”') && html.includes('“Join me”') && html.includes('2 of 4 pages have a picture you set.'));
    assert.ok(!/on desktop|电脑端/.test(html));
    assert.strictEqual((html.match(/<a href="\/api\/retail\/media\//g) || []).length, 2, 'the pictures are still links to look at');
    assert.ok(reads.includes('/affiliate/settings'));
    for (const k of ['home', 'product', 'voting', 'invite']) assert.ok(ctx.card('share.' + k).auto, k + ' started');
  });
  it('the invite card says Loading until Affiliate answers, and if it fails says so and is never started', async () => {
    const { ctx, CMD } = mk({ affFails: true });
    assert.ok(ctx.screenShareCards().includes('Loading…'));
    await tick();
    const html = ctx.screenShareCards();
    assert.ok(html.includes('Couldn’t load invite card') && !html.includes("APP.cmd('scOpen','invite')"));
    assert.ok(!ctx.card('share.invite'));
    CMD.scOpen('invite');
    assert.strictEqual(ctx.state.stack.length, 1);
    assert.ok(ctx.card('share.home').auto, 'the page cards are unaffected');
  });
}

section('2 · what each card sends');
{
  it('Home: PUT /config?history=share.home with the picture and both titles, trimmed; 60 at most', async () => {
    const { ctx, CMD, writes } = await opened({}, 'home');
    assert.strictEqual(ctx.state.stack[ctx.state.stack.length - 1].route, 'sharecard');
    const html = ctx.screenShareCard();
    assert.ok(html.includes('Card title · English') && html.includes('卡片标题 · 中文') && /maxlength="60"/.test(html) && html.includes('5 / 60'));
    assert.ok(html.includes('Replace the picture') && html.includes('Remove picture') && /cardHistory','share\.home'/.test(html));
    CMD.scTitle('en', '  Fresh this week  ');
    await flush(ctx, 'home');
    assert.deepStrictEqual(writes, [{ p: '/config?history=share.home', method: 'PUT',
      body: { 'sharing.home': '/api/retail/media/1', 'sharing.homeTitle': { en: 'Fresh this week', cn: '新鲜' } } }]);
  });
  it('Product: the picture only, and the desktop\'s note in place of titles', async () => {
    const { ctx, CMD, writes } = await opened({}, 'product');
    const html = ctx.screenShareCard();
    assert.ok(html.includes('Products share their own name and photo.') && !html.includes('Card title'));
    CMD.scTitle('en', 'ignored');
    await ctx.scUpload('product', {});
    await flush(ctx, 'product');
    assert.deepStrictEqual(writes, [{ p: '/config?history=share.product', method: 'PUT', body: { 'sharing.product': '/api/retail/media/77' } }]);
  });
  it('Invite: PATCH /affiliate/settings?history=share.invite with shareImage and shareTitle, nothing else', async () => {
    const { ctx, CMD, writes } = await opened({}, 'invite');
    assert.ok(ctx.screenShareCard().includes('Leave the titles empty to keep the automatic one'));
    CMD.scTitle('cn', '来领奖励');
    await flush(ctx, 'invite');
    assert.deepStrictEqual(writes, [{ p: '/affiliate/settings?history=share.invite', method: 'PATCH',
      body: { shareImage: '/api/retail/media/9', shareTitle: { en: 'Join me', cn: '来领奖励' } } }]);
  });
}

section('3 · the picture');
{
  it('upload: POST /media/upload, then the card saves the new address', async () => {
    const { ctx, writes, uploads, toasts } = await opened({}, 'voting');
    await ctx.scUpload('voting', {});
    assert.deepStrictEqual(plain(uploads), [{ u: '/api/retail-admin/media/upload', method: 'POST' }]);
    assert.deepStrictEqual(toasts, ['Uploaded']);
    await flush(ctx, 'voting');
    assert.strictEqual(writes[0].body['sharing.voting'], '/api/retail/media/77');
  });
  it('a refused or failed upload is said on the card and changes nothing', async () => {
    const a = await opened({ upload: 403 }, 'home');
    await a.ctx.scUpload('home', {});
    assert.ok(a.ctx.screenShareCard().includes('Your role cannot upload pictures.'));
    assert.strictEqual(a.ctx.scD().home.img, '/api/retail/media/1');
    const b = await opened({ upload: 'big' }, 'home');
    await b.ctx.scUpload('home', {});
    assert.ok(b.ctx.screenShareCard().includes('Upload failed Too large.'));
  });
  it('Remove picture: the address goes empty and is saved; the page falls back to its own look', async () => {
    const { ctx, CMD, writes, toasts } = await opened({}, 'home');
    CMD.scClear();
    await flush(ctx, 'home');
    assert.strictEqual(writes[0].body['sharing.home'], '');
    assert.deepStrictEqual(toasts, ['Picture removed']);
    assert.ok(ctx.screenShareCard().includes('Leave empty to use the page’s own look.'));
  });
  it('without media:upload: no Choose button, and the upload does not run', async () => {
    const { ctx, uploads } = await opened({ caps: ['sharing:edit'] }, 'product');
    const html = ctx.screenShareCard();
    assert.ok(!/scPick/.test(html));
    await ctx.scUpload('product', {});
    assert.strictEqual(uploads.length, 0);
  });
}

section('4 · history, refusals');
{
  it('the invite card\'s history restores from the affiliate keys, as a restore', async () => {
    const versions = [{ id: 1, at: 'x', changed: ['affiliate.shareTitle'], snapshot: { 'affiliate.shareImage': '/api/retail/media/3', 'affiliate.shareTitle': { en: 'Old', cn: '旧' } } }];
    const { CMD, writes, reads, hist } = await opened({ history: { success: true, versions } }, 'invite');
    CMD.cardHistory('share.invite'); await tick();
    assert.ok(reads.includes('/config/history?card=share.invite'));
    assert.strictEqual(hist().sub(versions[0]), 'Card title');
    await hist().restore(versions[0]);
    assert.deepStrictEqual(writes[writes.length - 1], { p: '/affiliate/settings?history=share.invite&note=restore', method: 'PATCH',
      body: { shareImage: '/api/retail/media/3', shareTitle: { en: 'Old', cn: '旧' } } });
  });
  it('a refusal stays in the foot', async () => {
    const { ctx, CMD } = await opened({ writeFails: true }, 'home');
    CMD.scTitle('en', 'x');
    await flush(ctx, 'home');
    assert.ok(/Save failed: Your role cannot change share cards\./.test(ctx.cardFootHtml(ctx.card('share.home'))));
  });
}

section('5 · without sharing:edit');
{
  it('the list is read-only: nothing opens, no card starts, the commands do nothing', async () => {
    const { ctx, CMD, writes } = mk({ caps: ['orders:view'] });
    ctx.screenShareCards(); await tick();
    const html = ctx.screenShareCards();
    assert.ok(!/scOpen/.test(html) && html.includes('“Fresh”'));
    for (const k of ['home', 'invite']) assert.ok(!ctx.card('share.' + k));
    CMD.scOpen('home'); CMD.scTitle('en', 'x'); CMD.scClear();
    assert.strictEqual(ctx.state.stack.length, 1);
    assert.strictEqual(writes.length, 0);
    assert.ok(/sharecard:'sharing:edit'/.test(MH));
  });
}

(async () => {
  for (const f of queue) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
