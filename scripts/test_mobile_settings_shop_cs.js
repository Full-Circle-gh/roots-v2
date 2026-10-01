#!/usr/bin/env node
/**
 * §325 X5 — THE SHOP TAB AND THE CUSTOMER-SERVICE BUTTON, ON THE PHONE.
 *
 *   node scripts/test_mobile_settings_shop_cs.js
 *
 * Two desktop Settings panels that save themselves (§279): Shop tab
 * (05-marketing.js SHOP_CARD) and Customer service (CS_CARD). On the phone they
 * run on the same engine (public/tacet-autosave.js, loaded here for real), send
 * the desktop's whole card body to PUT /config?history=<card>, and offer Undo
 * and Version history from the same history.
 *
 * What is asserted: the body, key for key and in the desktop's order (read out
 * of 05-marketing.js), seeded with the desktop's defaults so opening a card
 * sends nothing; every write's path and note; Undo and a restore; refusals at
 * the foot; the QR upload's request; who is refused; both languages.
 * No browser — fast shard.
 */
'use strict';

// Fails unless the run reaches its own end: a test awaiting a write the fake
// server never answers would otherwise drain the event loop and exit 0.
process.exitCode = 1;

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const MKT = fs.readFileSync(path.join(ROOT, 'public/retail-admin/05-marketing.js'), 'utf8');
const TacetAutosave = require('../public/tacet-autosave.js');

let passed = 0, failed = 0;
const pending = [];
function section(t) { pending.push(() => console.log('\n' + t)); }
function it(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
  });
}
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a > 0 && b > a, 'slice not found: ' + from);
  return src.slice(a, b);
}
function block(src, anchor) {
  const a = src.indexOf(anchor);
  assert.ok(a >= 0, 'not found: ' + anchor);
  let d = 0;
  for (let j = src.indexOf('{', a); j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (!d) return src.slice(a, j + 1); }
  }
  throw new Error('unbalanced: ' + anchor);
}
const line = (src, anchor) => { const a = src.indexOf(anchor); assert.ok(a >= 0, anchor); return src.slice(a, src.indexOf('\n', a)); };
const plain = (v) => JSON.parse(JSON.stringify(v));

const SRC = [
  line(M, 'function E(en, zh)'),
  line(M, 'function tmOneLang(m)'),
  block(M, 'function toggle('),
  slice(M, 'const ROUTE_CAP={', '/* Fail-OPEN on null'),
  slice(M, 'const MCAN_MONEY_ONLY=', '/* NAMED FOR THE JOB'),
  slice(M, '/* ══════════════════════════════════════════════════════════════════════════\n   §325 X1 — WHAT THE SHOP DID', '/* §325 X1 ends */'),
  slice(M, '/* ══════════════════════════════════════════════════════════════════════════\n   §325 X5 — THE SHOP TAB', '/* §325 X5 ends */'),
].join('\n');

const SETTINGS = ['settings:shop', 'settings:push', 'settings:payments', 'stores:view', 'shipping:config'];

function mk(opts = {}) {
  const calls = { api: [], writes: [], toasts: [], renders: 0, fetches: [], asks: [] };
  const CMD = {};
  const els = {};
  const ctx = {
    LANG: opts.lang || 'en', API: '/api/retail-admin',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    SUBS: {}, DB: { products: [] }, TacetAutosave,
    state: {
      caps: opts.caps === undefined ? SETTINGS : opts.caps, cfg: {}, ask: null, ops: null,
      chl: { rows: null, seq: 0 }, nlg: { rows: null, seq: 0 }, elm: { cat: {}, seq: 0 },
      cfgc: { tried: { shop: false, cs: false }, err: { shop: null, cs: null }, shop: null, cs: null, qrBusy: false, qrErr: null },
    },
    render: () => { calls.renders++; },
    reg: (n, f) => { CMD[n] = f; },
    push: () => {}, showToast: (m) => calls.toasts.push(String(m)),
    recapNoMoney: () => false, featOn: () => true, tdWhen: () => '', _tdL: () => ({}),
    liveHistorySheet: (list, sub, restore) => { calls.asks.push({ list, sub, restore }); },
    api: (p) => new Promise((res, rej) => { calls.api.push({ p, res, rej }); }),
    apiRaw: (p) => new Promise((res, rej) => { calls.api.push({ p, res, rej }); }),
    apiWrite: (p, body, method) => new Promise((res, rej) => {
      calls.writes.push({ p, body: plain(body), keys: Object.keys(body), method: method || 'POST', res, rej });
    }),
    apiRefusal: async () => { const e = new Error('refused'); e.refused = true; e.words = ['You don’t have permission for this', '你没有此操作的权限']; return e; },
    fetch: (u, o) => new Promise((res) => { calls.fetches.push({ u, o, res }); }),
    FormData: class { constructor() { this.parts = []; } append(k, v) { this.parts.push([k, v]); } },
    document: { getElementById: (id) => els[id] || null },
    location: { href: '' },
    setTimeout, clearTimeout,
    URLSearchParams, Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, RegExp, encodeURIComponent, isNaN, parseInt,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  new vm.Script(SRC + '\nthis.ROUTE_CAP=ROUTE_CAP;this.cfgAuto=cfgAuto;').runInContext(ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return { ctx, CMD, calls, els, text, c: ctx.state.cfgc };
}
const tick = () => new Promise((r) => setImmediate(r));
async function opened(which, cfg, opts) {
  const h = mk(opts);
  const route = which === 'shop' ? 'shopdisplay' : 'custservice';
  h.ctx.SUBS[route].render();
  assert.strictEqual(h.calls.api[0].p, '/config');
  h.calls.api[0].res(cfg || {}); await tick();
  return h;
}
const engine = (h, k) => h.ctx.cfgAuto[k];

// The desktop card bodies, read out of 05-marketing.js.
const DESK_SHOP_KEYS = vm.runInNewContext(slice(MKT, 'const SHOP_KEYS = [', '];').replace('const SHOP_KEYS = ', '') + ']').map((x) => 'shop.' + x[0]);
const DESK_CS_KEYS = [...block(MKT, 'const CS_CARD = autosaveCard({').split('apply:')[0].matchAll(/'(customer_service\.[a-z_]+)':/g)].map((m) => m[1]);

// ─────────────────────────────────────────────────────────────────────────
section('1 · who reaches them');
{
  it('both carry exactly the Settings screen\'s keys, and Settings draws their rows only where they open', () => {
    const { ctx } = mk();
    assert.deepStrictEqual(plain(ctx.ROUTE_CAP.shopdisplay), SETTINGS);
    assert.deepStrictEqual(plain(ctx.ROUTE_CAP.custservice), SETTINGS);
    const s = block(M, 'function screenSettings(){');
    assert.ok(/canRoute\('shopdisplay'\)\?\[\{label:T\('Shop tab','商城页'\)/.test(s));
    assert.ok(/canRoute\('custservice'\)\?\[\{label:T\('Customer service','客户服务'\)/.test(s));
  });
  it('without them no engine starts and nothing is sent', async () => {
    const h = await opened('shop', {}, { caps: ['orders:view'] });
    assert.strictEqual(engine(h, 'shop'), null);
    h.CMD.shopdSet('showSort');
    assert.strictEqual(h.calls.writes.length, 0);
  });
  it('each is read fresh on entry, and a pending edit goes on the way out', () => {
    assert.ok(/route==='shopdisplay'\|\|route==='custservice'\)\{ const c=state\.cfgc/.test(block(M, 'function push(route)')));
    assert.ok(/if\(top==='shopdisplay'\|\|top==='custservice'\) cfgFlushAll\(\);/.test(block(M, 'function pop()')));
    assert.ok(/t\.route==='shopdisplay'\|\|t\.route==='custservice'\)\) cfgFlushAll\(\);/.test(block(M, 'function layers()')));
  });
}

section('2 · Shop tab');
{
  it('the body is the desktop\'s SHOP_CARD body, key for key and in its order', async () => {
    const h = await opened('shop', {});
    assert.deepStrictEqual(plain(Object.keys(h.ctx.shopdBody())), plain(DESK_SHOP_KEYS));
  });
  it('seeded with the desktop\'s readings — a legacy grid is the 2-column grid, dietary chips default on — so opening sends nothing', async () => {
    const h = await opened('shop', { shop: { layout: 'grid', showSort: true } });
    assert.deepStrictEqual(plain(h.ctx.shopdBody()), {
      'shop.layout': 'grid-2col', 'shop.defaultSort': '', 'shop.showSort': true, 'shop.showDietary': true, 'shop.showStockFilter': false,
      'shop.showBadgeFilter': false, 'shop.showPriceFilter': false, 'shop.hideOutOfStock': false, 'shop.lockLayout': false });
    engine(h, 'shop').flush(); await tick();
    assert.strictEqual(h.calls.writes.length, 0);
    const t = h.text(h.ctx.SUBS.shopdisplay.render());
    assert.ok(t.includes('Layout') && t.includes('Default sort') && t.includes('Filter & controls bar') && t.includes('All changes saved'));
  });
  it('a switch saves the whole card to the desktop\'s history card', async () => {
    const h = await opened('shop', {});
    h.CMD.shopdSet('lockLayout');
    engine(h, 'shop').flush(); await tick();
    const w = h.calls.writes[0];
    assert.strictEqual(w.p, '/config?history=shop.display'); assert.strictEqual(w.method, 'PUT');
    assert.strictEqual(w.body['shop.lockLayout'], true);
    assert.strictEqual(Object.keys(w.body).length, DESK_SHOP_KEYS.length);
    w.res({ success: true }); await tick();
    assert.strictEqual(h.ctx.state.cfg.shop.lockLayout, true, 'the cached config follows');
  });
  it('a pick outside the desktop\'s list is not sent', async () => {
    const h = await opened('shop', {});
    h.CMD.shopdSet('layout', 'mosaic'); h.CMD.shopdSet('defaultSort', 'random'); h.CMD.shopdSet('nope');
    engine(h, 'shop').flush(); await tick();
    assert.strictEqual(h.calls.writes.length, 0);
    h.CMD.shopdSet('layout', 'gallery');
    engine(h, 'shop').flush(); await tick();
    assert.strictEqual(h.calls.writes[0].body['shop.layout'], 'gallery');
  });
  it('Undo sends the visit\'s first body back, filed as an undo', async () => {
    const h = await opened('shop', {});
    h.CMD.shopdSet('showSort'); engine(h, 'shop').flush(); await tick();
    h.calls.writes[0].res({ success: true }); await tick();
    assert.ok(/APP\.cmd\('cfgUndo','shop'\)/.test(h.ctx.cfgFootHtml('shop')));
    h.CMD.cfgUndo('shop'); await tick();
    assert.strictEqual(h.calls.writes[1].p, '/config?history=shop.display&note=undo');
    assert.strictEqual(h.calls.writes[1].body['shop.showSort'], false);
    assert.strictEqual(h.c.shop.showSort, false, 'the screen goes back too');
  });
  it('Version history reads the desktop\'s history and restores a version, filed as a restore', async () => {
    const h = await opened('shop', {});
    h.CMD.cfgHistory('shop'); await tick();
    assert.strictEqual(h.calls.api[1].p, '/config/history?card=shop.display');
    h.calls.api[1].res({ success: true, versions: [{ id: 2, changed: ['shop.showSort'] }, { id: 1, snapshot: { 'shop.layout': 'gallery', 'shop.showSort': true } }] }); await tick();
    const sheet = h.calls.asks[0];
    assert.strictEqual(sheet.sub(sheet.list[0]), 'Show sort dropdown');
    const done = sheet.restore(sheet.list[1]);
    assert.strictEqual(h.calls.writes[0].p, '/config?history=shop.display&note=restore');
    assert.strictEqual(h.calls.writes[0].body['shop.layout'], 'gallery');
    h.calls.writes[0].res({ success: true }); await done;
  });
  it('a refusal stays at the foot in the server\'s words; a toast never reports it', async () => {
    const h = await opened('shop', {});
    h.CMD.shopdSet('showSort'); const p = engine(h, 'shop').flush();
    const e = new Error('refused'); e.refused = true; e.words = ['You don’t have permission for this', '你没有此操作的权限'];
    h.calls.writes[0].rej(e); await p;
    assert.ok(h.text(h.ctx.cfgFootHtml('shop')).includes('Save failed: You don’t have permission for this'));
    assert.deepStrictEqual(h.calls.toasts, []);
  });
  it('a failed read says so and offers Try again', async () => {
    const h = mk(); h.ctx.SUBS.shopdisplay.render();
    h.calls.api[0].rej(new Error('HTTP 500')); await tick();
    assert.ok(/Could not load this\./.test(h.text(h.ctx.SUBS.shopdisplay.render())));
    h.CMD.cfgRetry('shop');
    assert.strictEqual(h.calls.api.length, 2);
  });
}

section('3 · Customer service');
{
  it('the body is the desktop\'s CS_CARD body, key for key and in its order', async () => {
    const h = await opened('cs', {});
    assert.ok(DESK_CS_KEYS.length >= 20, 'read the desktop card');
    assert.deepStrictEqual(plain(Object.keys(h.ctx.csBody())), plain(DESK_CS_KEYS));
  });
  it('seeded with the desktop\'s defaults, so opening sends nothing', async () => {
    const h = await opened('cs', { customer_service: { mode: 'qr', label_cn: '联系客服' } });
    const b = plain(h.ctx.csBody());
    assert.strictEqual(b['customer_service.mode'], 'qr');
    assert.strictEqual(b['customer_service.show_me'], true); assert.strictEqual(b['customer_service.show_home'], false);
    assert.strictEqual(b['customer_service.fab_size'], 'md'); assert.strictEqual(b['customer_service.fab_color'], '#365329');
    assert.strictEqual(b['customer_service.fab_bottom'], 220);
    engine(h, 'cs').flush(); await tick();
    assert.strictEqual(h.calls.writes.length, 0);
  });
  it('typed fields are sent trimmed, after the pause, without repainting under the thumb', async () => {
    const h = await opened('cs', {});
    const before = h.calls.renders;
    h.CMD.csText('label_en', '  Chat with us ');
    h.CMD.csText('fab_bottom', 'abc');
    assert.strictEqual(h.calls.renders, before);
    engine(h, 'cs').flush(); await tick();
    const w = h.calls.writes[0];
    assert.strictEqual(w.p, '/config?history=customer_service'); assert.strictEqual(w.method, 'PUT');
    assert.strictEqual(w.body['customer_service.label_en'], 'Chat with us');
    assert.strictEqual(w.body['customer_service.fab_bottom'], 220, 'not a number: the desktop\'s 220');
  });
  it('the mode decides what is asked: WeCom its credentials, QR its image', async () => {
    const h = await opened('cs', {});
    assert.ok(!/Corp ID/.test(h.text(h.ctx.SUBS.custservice.render())));
    h.CMD.csSet('mode', 'wecom');
    assert.ok(/Corp ID/.test(h.text(h.ctx.SUBS.custservice.render())));
    h.CMD.csSet('mode', 'qr');
    const t = h.text(h.ctx.SUBS.custservice.render());
    assert.ok(t.includes('No QR uploaded yet.') && t.includes('Upload a QR code image'));
    h.CMD.csSet('mode', 'pigeon');
    assert.strictEqual(h.c.cs.mode, 'qr', 'a mode outside the list is refused');
  });
  it('where to show, the bubble\'s look, a custom emoji only when chosen', async () => {
    const h = await opened('cs', {});
    h.CMD.csSet('show_home'); h.CMD.csSet('fab_shape', 'pill'); h.CMD.csSet('fab_color', '#C2674A'); h.CMD.csSet('fab_color', 'red');
    h.CMD.csSet('fab_icon', 'custom');
    assert.ok(/Custom emoji/.test(h.text(h.ctx.SUBS.custservice.render())));
    engine(h, 'cs').flush(); await tick();
    const b = h.calls.writes[0].body;
    assert.strictEqual(b['customer_service.show_home'], true);
    assert.strictEqual(b['customer_service.fab_shape'], 'pill');
    assert.strictEqual(b['customer_service.fab_color'], '#C2674A');
    assert.strictEqual(b['customer_service.fab_icon'], 'custom');
  });
  it('the QR goes up the desktop\'s way and its URL is what the card saves', async () => {
    const h = await opened('cs', { customer_service: { mode: 'qr' } });
    const input = { files: [{ name: 'qr.png' }], value: 'x' };
    h.CMD.csQr(input);
    assert.strictEqual(input.value, '');
    const f = h.calls.fetches[0];
    assert.strictEqual(f.u, '/api/retail-admin/cms/media'); assert.strictEqual(f.o.method, 'POST');
    assert.deepStrictEqual(f.o.body.parts.map((p) => p[0]), ['file']);
    assert.ok(/Uploading QR…/.test(h.text(h.ctx.SUBS.custservice.render())));
    f.res({ status: 200, json: async () => ({ success: true, data: { url: '/api/retail/media/9' } }) }); await tick(); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['QR uploaded']);
    engine(h, 'cs').flush(); await tick();
    assert.strictEqual(h.calls.writes[0].body['customer_service.qr_image_url'], '/api/retail/media/9');
    h.CMD.csQrClear();
    engine(h, 'cs').flush(); await tick();
  });
  it('a refused or failed upload is said beside it, and nothing is saved', async () => {
    const r = await opened('cs', { customer_service: { mode: 'qr' } });
    r.CMD.csQr({ files: [{}] });
    r.calls.fetches[0].res({ status: 403, json: async () => ({ error: 'forbidden_capability' }) }); await tick(); await tick();
    assert.ok(r.text(r.ctx.SUBS.custservice.render()).includes('You don’t have permission for this'));
    const f = await opened('cs', { customer_service: { mode: 'qr' } });
    f.CMD.csQr({ files: [{}] });
    f.calls.fetches[0].res({ status: 200, json: async () => ({ success: false, error: 'too_large' }) }); await tick(); await tick();
    assert.ok(f.text(f.ctx.SUBS.custservice.render()).includes('Upload failed: too_large'));
    engine(f, 'cs').flush(); await tick();
    assert.strictEqual(f.calls.writes.length, 0);
  });
  it('in Chinese', async () => {
    const h = await opened('cs', { customer_service: { mode: 'wecom' } }, { lang: 'zh' });
    const t = h.text(h.ctx.SUBS.custservice.render());
    assert.ok(t.includes('顾客联系方式') && t.includes('企业微信凭证') && t.includes('显示位置') && t.includes('悬浮按钮样式') && t.includes('已自动保存'));
    const s = await opened('shop', {}, { lang: 'zh' });
    assert.ok(s.text(s.ctx.SUBS.shopdisplay.render()).includes('筛选与操作条'));
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
