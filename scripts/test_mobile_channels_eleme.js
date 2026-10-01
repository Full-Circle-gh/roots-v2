#!/usr/bin/env node
/**
 * §325 X1 — ELEME ON THE PHONE, READ-ONLY.
 *
 *   node scripts/test_mobile_channels_eleme.js
 *
 * The phone had Meituan and gzgrocery screens and nothing for Eleme. It now has
 * the desktop Eleme tab's reads (public/retail-admin/14-eleme.js): the channel
 * switch's state, the stock waiting to go, one line per store, each store's
 * catalogue as last read, and the two logs of the tab's Activity view.
 *
 * The phone code is RUN, sliced out of public/m.html into a sandbox with a fake
 * server; every request is asserted on its path. Nothing on this screen may
 * write, and the sandbox's apiWrite throws to prove it. No browser — fast shard.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const EL = fs.readFileSync(path.join(ROOT, 'public/retail-admin/14-eleme.js'), 'utf8');
const { tdWhen } = require('../public/td-datetime.js');

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

const SRC = [
  slice(M, 'const PILL = {', 'function toggle('),
  line(M, 'function E(en, zh)'),
  block(M, 'function nothingYet('),
  block(M, 'function noteBar('),
  block(M, 'function searchBox('),
  line(M, 'function searchClearShow('),
  block(M, 'const _date=v=>'),
  block(M, 'function oldestMins(items)'),
  block(M, 'function oldestOf(items)'),
  slice(M, 'const ROUTE_CAP={', '/* Fail-OPEN on null'),
  slice(M, 'const MCAN_MONEY_ONLY=', '/* NAMED FOR THE JOB'),
  slice(M, '/* ══════════════════════════════════════════════════════════════════════════\n   §325 X1 — WHAT THE SHOP DID', '/* §325 X1 ends */'),
].join('\n');

function mk(opts = {}) {
  const calls = { api: [], renders: 0, pushed: [] };
  const CMD = {};
  const els = {};
  const ctx = {
    LANG: opts.lang || 'en', API: '/api/retail-admin',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    SUBS: {},
    DB: { products: [{ _id: 5, name: ['Hummus Asli', '鹰嘴豆泥'] }] },
    state: {
      caps: opts.caps === undefined ? null : opts.caps, ask: null, ops: null,
      chl: { rows: null, seq: 0 }, nlg: { rows: null, seq: 0 },
      elm: { cfg: null, st: null, err: null, tried: false, seq: 0, cat: {}, catStore: null, catQ: '' },
    },
    render: () => { calls.renders++; },
    reg: (n, f) => { CMD[n] = f; },
    push: (r) => { calls.pushed.push(r); },
    recapNoMoney: () => false, featOn: () => true,
    tdWhen, _tdL: () => ({ lang: ctx.LANG === 'en' ? 'en' : 'cn' }),
    api: (p) => new Promise((res, rej) => { calls.api.push({ p, res, rej }); }),
    apiRaw: (p) => new Promise((res, rej) => { calls.api.push({ p, res, rej }); }),
    apiWrite: () => { throw new Error('the Eleme screen is read-only — nothing here may write'); },
    location: { href: '' },
    document: { getElementById: (id) => els[id] || null },
    setTimeout: () => 0, clearTimeout: () => {},
    URLSearchParams, Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, RegExp,
    encodeURIComponent, isNaN,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  new vm.Script(SRC + '\nthis.ROUTE_CAP=ROUTE_CAP;').runInContext(ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  const screen = () => ctx.SUBS.mirror_eleme.render();
  return { ctx, CMD, calls, els, text, screen, e: ctx.state.elm };
}
const tick = () => new Promise((r) => setImmediate(r));
const byPath = (h, p) => h.calls.api.find((c) => c.p === p);
async function answer(h, p, data) { const c = byPath(h, p); assert.ok(c, 'no request for ' + p); c.res(data); await tick(); }
async function refuse(h, p) { const c = byPath(h, p); assert.ok(c, 'no request for ' + p); c.rej(new Error('HTTP 500')); await tick(); }

const hoursAgo = (n) => new Date(Date.now() - n * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
const STATUS = () => ({
  success: true,
  stores: [
    { id: 1, code: 'tianhe', name: '天河', nameEn: 'Tianhe', blocked: false, blockedBy: null, pending: 2, processing: 1, catalogueCount: 120, catalogueAt: hoursAgo(3) },
    { id: 2, code: 'yuexiu', name: '越秀', nameEn: 'Yuexiu', blocked: true, blockedBy: 'no_shop', pending: 0, processing: 0, catalogueCount: 0, catalogueAt: null },
    { id: 3, code: 'panyu', name: '番禺', nameEn: 'Panyu', blocked: true, blockedBy: 'needs_login', pending: 2, processing: 0, catalogueCount: 40, catalogueAt: hoursAgo(30) },
  ],
  recentStock: [
    { store_code: 'tianhe', event_type: 'stock_push', status: 'ok', detail: '{"product_id":5,"qty":4}', created_at: '2026-09-30 02:00:00' },
    { store_code: 'panyu', event_type: 'stock_push', status: 'error', detail: '{"product_id":9,"sku":"RT-9"}', error_msg: 'listing not found', created_at: '2026-09-30 01:00:00' },
  ],
  recentSystem: [{ store_code: 'panyu', event_type: 'login', status: 'error', error_msg: 'session expired', created_at: '2026-09-30 00:00:00' }],
});

// ─────────────────────────────────────────────────────────────────────────
section('1 · who reaches it, and from where');
{
  it('the screen and each store\'s catalogue carry the desktop tab\'s key', () => {
    const { ctx } = mk();
    assert.strictEqual(ctx.ROUTE_CAP.mirror_eleme, 'eleme:view');
    assert.strictEqual(ctx.ROUTE_CAP.elemecat, 'eleme:view');
    assert.strictEqual(mk({ caps: ['meituan:view'] }).ctx.canRoute('mirror_eleme'), false);
    assert.strictEqual(mk({ caps: ['eleme:view'] }).ctx.canRoute('mirror_eleme'), true);
  });
  it('Eleme is a mirrored channel on Sales, and its door is drawn only where it opens', () => {
    assert.ok(/eleme:\{icon:'utensils-crossed',en:'Eleme',zh:'饿了么',key:'eleme',mirror:'eleme'\}/.test(M));
    const sheet = block(M, 'function sheetChannel(){');
    assert.ok(/\$\{m\.mirror&&canRoute\('mirror_'\+m\.mirror\)\?`<button/.test(sheet));
    assert.ok(/m\.mirror==='eleme'\?T\('View Eleme sync','查看饿了么同步'\)/.test(sheet));
    assert.ok(/\(m\.mirror&&canRoute\('mirror_'\+m\.mirror\)\)\?`APP\.cmd\('mirror'/.test(M), 'the card itself too');
  });
  it('the Meituan and gzgrocery doors are unchanged: no key, so no one loses them', () => {
    const { ctx } = mk({ caps: [] });
    assert.strictEqual(ctx.ROUTE_CAP.mirror_meituan, undefined);
    assert.strictEqual(ctx.canRoute('mirror_meituan'), true);
  });
  it('the shared mirror loader leaves Eleme to its own read, and every entry re-reads', () => {
    assert.ok(/if\(which==='eleme'\) return;/.test(block(M, 'async function loadMirror(which)')));
    assert.ok(/route==='mirror_eleme'\)\{ const e=state\.elm; e\.tried=false; e\.st=null; e\.cfg=null; e\.err=null; \}/.test(block(M, 'function push(route)')));
  });
}

section('2 · the reads');
{
  it('first paint says Loading and asks the desktop\'s two endpoints, once', () => {
    const h = mk();
    assert.ok(/Loading…/.test(h.text(h.screen())));
    assert.deepStrictEqual(h.calls.api.map((c) => c.p).sort(), ['/eleme/config', '/eleme/status']);
    h.screen();
    assert.strictEqual(h.calls.api.length, 2);
  });
  it('the head: stock waiting, per store, and the switch\'s state', async () => {
    const h = mk();
    h.screen();
    await answer(h, '/eleme/config', { success: true, enabled: true });
    await answer(h, '/eleme/status', STATUS());
    const t = h.text(h.screen());
    assert.ok(t.includes('Stock updates waiting Channel on 5'), t);
    assert.ok(t.includes('3 Tianhe · 0 Yuexiu · 2 Panyu'));
  });
  it('each store says why it cannot push, or what is waiting, and how fresh its catalogue is', async () => {
    const h = mk();
    h.screen();
    await answer(h, '/eleme/status', STATUS());
    const t = h.text(h.screen());
    assert.ok(t.includes('Tianhe 3 stock updates waiting · 120 listings read · 3 h ago'), t);
    assert.ok(t.includes('Yuexiu has no Eleme shop linked yet · no catalogue read yet, so nothing can be matched here'));
    assert.ok(t.includes('Panyu is signed out · 40 listings read · 1 d ago'));
  });
  it('a store with a catalogue opens it; one without is not a control', async () => {
    const h = mk();
    h.screen();
    await answer(h, '/eleme/status', STATUS());
    const html = h.screen();
    assert.ok(/onclick="APP\.cmd\('elmCat',1\)"/.test(html));
    assert.ok(/onclick="APP\.cmd\('elmCat',3\)"/.test(html));
    assert.ok(!/APP\.cmd\('elmCat',2\)/.test(html));
  });
  it('the two logs: pushes named from the catalogue of products, failures in words', async () => {
    const h = mk();
    h.screen();
    await answer(h, '/eleme/status', STATUS());
    const t = h.text(h.screen());
    assert.ok(t.includes('Stock pushes') && t.includes('Hummus Asli → 4'));
    assert.ok(t.includes('RT-9') && t.includes('listing not found'));
    assert.ok(t.includes('Sync events') && t.includes('login: session expired'));
  });
  it('empty logs say so rather than drawing nothing', async () => {
    const h = mk();
    h.screen();
    await answer(h, '/eleme/status', { success: true, stores: [], recentStock: [], recentSystem: [] });
    const t = h.text(h.screen());
    assert.strictEqual((t.match(/Nothing yet/g) || []).length, 2);
    assert.ok(t.includes('Stock updates waiting 0'));
  });
  it('the switch not answering leaves its pill off and the rest standing', async () => {
    const h = mk();
    h.screen();
    await refuse(h, '/eleme/config');
    await answer(h, '/eleme/status', STATUS());
    const t = h.text(h.screen());
    assert.ok(!/Channel (on|off)/.test(t));
    assert.ok(t.includes('Stock updates waiting 5'), t);
  });
  it('switched off reads as off', async () => {
    const h = mk();
    h.screen();
    await answer(h, '/eleme/config', { success: true, enabled: false });
    await answer(h, '/eleme/status', STATUS());
    assert.ok(/Channel off/.test(h.text(h.screen())));
  });
  it('the health not answering is a failure with Try again, which asks again', async () => {
    const h = mk();
    h.screen();
    await refuse(h, '/eleme/status');
    const t = h.text(h.screen());
    assert.ok(t.includes('The channel did not answer.') && t.includes('Try again'));
    h.CMD.elmRetry();
    h.screen();
    assert.strictEqual(h.calls.api.filter((c) => c.p === '/eleme/status').length, 2);
  });
  it('a stale answer is dropped', async () => {
    const h = mk();
    h.screen();
    const first = h.calls.api.find((c) => c.p === '/eleme/status');
    h.CMD.elmRetry(); h.screen();
    const second = h.calls.api.filter((c) => c.p === '/eleme/status')[1];
    second.res({ success: true, stores: [], recentStock: [], recentSystem: [] }); await tick();
    first.res(STATUS()); await tick();
    assert.strictEqual(h.e.st.stores.length, 0);
  });
  it('in Chinese, with the store\'s Chinese name', async () => {
    const h = mk({ lang: 'zh' });
    h.screen();
    await answer(h, '/eleme/config', { success: true, enabled: true });
    await answer(h, '/eleme/status', STATUS());
    const t = h.text(h.screen());
    assert.ok(t.includes('待推送库存') && t.includes('渠道开启') && t.includes('越秀 尚未关联饿了么店铺'));
    assert.ok(t.includes('天河 3 条库存待推送 · 已读取 120 个商品'));
    assert.ok(t.includes('鹰嘴豆泥 → 4') && t.includes('库存推送') && t.includes('系统事件'));
  });
  /* The desktop writes these in \\u escapes, and until §325 X2 one of them
     carried 饶 (ráo, U+9976) where the platform's name is 饿 (è, U+997F). Both
     surfaces print 饿 now, and the guard stays so the misprint cannot return. */
  it('the words are the desktop\'s: the blocked reasons, decoded from its source', () => {
    const desk = vm.runInNewContext('(' + slice(EL, 'const EL_BLOCK_TXT = {', '};').replace('const EL_BLOCK_TXT = ', '') + '})');
    const phone = vm.runInContext('ELM_BLOCK', mk().ctx);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(phone)), JSON.parse(JSON.stringify(desk)));
    // The tab's own comment still quotes the old misprint as history, so the
    // check is on the escapes the strings are written in, not on the file.
    assert.ok(!/\\u9976/i.test(EL), 'the desktop Eleme tab never writes 饶 for Eleme');
    assert.ok(!/\u9976/.test(JSON.stringify(phone)));
  });
}

section('3 · one store\'s catalogue');
{
  async function opened(lang) {
    const h = mk({ lang });
    h.screen();
    await answer(h, '/eleme/status', STATUS());
    h.CMD.elmCat(1);
    return h;
  }
  it('opens the store\'s catalogue by its code, titled with its name', async () => {
    const h = await opened();
    assert.deepStrictEqual(h.calls.pushed, ['elemecat']);
    assert.ok(byPath(h, '/eleme/catalogue?storeCode=tianhe'));
    assert.strictEqual(h.ctx.SUBS.elemecat.titleOf(), 'Tianhe');
    assert.ok(/Loading…/.test(h.text(h.ctx.SUBS.elemecat.render())));
  });
  it('the listings and the stock each shows, and when they were read', async () => {
    const h = await opened();
    await answer(h, '/eleme/catalogue?storeCode=tianhe', { success: true, data: [{ name: 'Hummus 200g', stock: 7 }, { name: 'Pita', stock: null }], refreshedAt: hoursAgo(2) });
    const t = h.text(h.ctx.SUBS.elemecat.render());
    assert.ok(t.includes('2 listings read · 2 h ago'));
    assert.ok(t.includes('Hummus 200g Stock 7') && t.includes('Pita Stock —'));
  });
  it('the search filters what was read, and asks nothing', async () => {
    const h = await opened();
    await answer(h, '/eleme/catalogue?storeCode=tianhe', { success: true, data: [{ name: 'Hummus 200g', stock: 7 }, { name: 'Pita', stock: 2 }], refreshedAt: null });
    h.els.mElmCatBody = { innerHTML: '' };
    const n = h.calls.api.length;
    h.CMD.elmCatQ('hum');
    assert.strictEqual(h.calls.api.length, n);
    assert.ok(/Hummus 200g/.test(h.els.mElmCatBody.innerHTML) && !/Pita/.test(h.els.mElmCatBody.innerHTML));
    h.CMD.elmCatQ('zzz');
    assert.ok(/No matches/.test(h.els.mElmCatBody.innerHTML));
  });
  it('an empty catalogue says nothing can be matched; a failed one says so and retries', async () => {
    const e = await opened();
    await answer(e, '/eleme/catalogue?storeCode=tianhe', { success: true, data: [], refreshedAt: null });
    assert.ok(/no catalogue read yet/.test(e.text(e.ctx.SUBS.elemecat.render())));
    const f = await opened();
    await refuse(f, '/eleme/catalogue?storeCode=tianhe');
    assert.ok(/Could not load this\./.test(f.text(f.ctx.SUBS.elemecat.render())));
    f.CMD.elmCatRetry();
    assert.strictEqual(f.calls.api.filter((c) => c.p === '/eleme/catalogue?storeCode=tianhe').length, 2);
  });
  it('an unknown store opens nothing', async () => {
    const h = mk();
    h.screen();
    await answer(h, '/eleme/status', STATUS());
    h.CMD.elmCat(99);
    assert.deepStrictEqual(h.calls.pushed, []);
  });
  it('in Chinese', async () => {
    const h = await opened('zh');
    await answer(h, '/eleme/catalogue?storeCode=tianhe', { success: true, data: [{ name: '鹰嘴豆泥', stock: 3 }], refreshedAt: null });
    assert.strictEqual(h.ctx.SUBS.elemecat.titleOf(), '天河');
    assert.ok(/已读取 1 个商品/.test(h.text(h.ctx.SUBS.elemecat.render())) && /库存 3/.test(h.text(h.ctx.SUBS.elemecat.render())));
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
