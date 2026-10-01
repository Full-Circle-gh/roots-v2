#!/usr/bin/env node
/**
 * §325 X9a — THE CHANNEL HUB ON THE PHONE: STATE, TO-DOS, GET HELP, THE BOX,
 * AND ELEME'S SETUP.
 *
 *   node scripts/test_mobile_channel_hub.js
 *
 * The desktop's channel hub (15-integrations.js igCard, igDismissTodo, igHelp,
 * igRelayWizard / igRelayBoxRequest, igElemeWizard / igElemeShop /
 * igElemeEnable).
 *
 * What is asserted: the cards say the desktop's words; every write's method,
 * path and body; the box screen follows the box's state; Eleme's wizard moves
 * from linking to enabling as the desktop's does; each control is the
 * server's key and nothing is sent without it; refusals said in place; failed
 * reads; both languages. No browser — fast shard.
 */
'use strict';

process.exitCode = 1;

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const IG = fs.readFileSync(path.join(ROOT, 'public/retail-admin/15-integrations.js'), 'utf8');
const cap = require('../lib/cap-routes.js');

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
  assert.ok(a >= 0 && b > a, 'slice not found: ' + from);
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
  slice(M, 'const PILL = {', 'const KIND2PILL'),
  block(M, 'function tmRow('),
  block(M, 'function tmList('),
  block(M, 'function x1Err('),
  line(M, 'const x1Loading='),
  block(M, 'function x6Words('),
  line(M, 'const x6En='),
  line(M, 'const x6Zh='),
  slice(M, 'const ROUTE_CAP={', '/* Fail-OPEN on null'),
  slice(M, 'const MCAN_MONEY_ONLY=', '/* NAMED FOR THE JOB'),
  slice(M, '/* ══════════════════════════════════════════════════════════════════════════\n   §325 X9a — THE CHANNEL HUB', '/* §325 X9a ends */'),
].join('\n');

const ALL = ['dashboard:view', 'integrations:manage', 'eleme:view', 'eleme:sync', 'delivery:view'];
const REFUSED = () => { const e = new Error('refused'); e.refused = true; e.words = ['You don’t have permission for this', '你没有此操作的权限']; return e; };
const CARDS = () => [
  { kind: 'meituan', category: 'channel', labelEn: 'Meituan', labelCn: '美团', status: 'not_configured', blurbEn: 'Delivery orders from Meituan.', blurbCn: '美团外卖订单。', config: {} },
  { kind: 'eleme', category: 'channel', labelEn: 'Eleme', labelCn: '饿了么', status: 'error', health: { last_error: 'signed out' },
    config: { todos: [{ id: 't1', store_code: 'yx', store_name: 'Yuexiu' }] } },
  { kind: 'wechat_miniapp', category: 'first_party', labelEn: 'WeChat mini program', labelCn: '微信小程序', status: 'connected', blurbEn: 'Your shop in WeChat.', blurbCn: '微信里的店铺。' },
  { kind: 'jd', category: 'logistics', labelEn: 'JD Logistics', labelCn: '京东物流', status: 'configured', blurbEn: 'Waybills.', blurbCn: '运单。' },
  { kind: 'qingyun', category: 'logistics', labelEn: 'Qingyun', labelCn: '青云', status: 'in_setup', config: { box: { status: 'shipped', shipped_at: '2026-09-28 10:00:00', tracking: 'SF123' } } },
];

function mk(opts = {}) {
  const calls = { api: [], writes: [], toasts: [], pushes: [], pops: 0 };
  const CMD = {};
  const ctx = {
    LANG: opts.lang || 'en',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    SUBS: {},
    state: { caps: opts.caps === undefined ? ALL : opts.caps, ask: null, askErr: null, stack: [],
      hub: { cards: null, stores: null, tried: false, err: null, busy: null, note: {}, boxKind: null, elStores: null, elTried: false, elErr: null, shopIds: {} } },
    render: () => {}, reg: (n, f) => { CMD[n] = f; },
    push: (r) => { calls.pushes.push(r); ctx.state.stack.push({ route: r }); },
    pop: () => { calls.pops++; ctx.state.stack.pop(); },
    showToast: (m) => calls.toasts.push(String(m)),
    recapNoMoney: () => false, featOn: () => true,
    api: (p) => new Promise((res, rej) => { calls.api.push({ p, res, rej }); }),
    apiRaw: (p) => new Promise((res, rej) => { calls.api.push({ p, raw: true, res, rej }); }),
    apiWrite: (p, body, method) => new Promise((res, rej) => { calls.writes.push({ p, body: body == null ? body : plain(body), method: method || 'POST', res, rej }); }),
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, RegExp, encodeURIComponent, isNaN, parseInt,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  new vm.Script(SRC + '\nthis.ROUTE_CAP=ROUTE_CAP;this.canRoute=canRoute;').runInContext(ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  return { ctx, CMD, calls, text, s: () => ctx.state.hub, sc: (r) => ctx.SUBS[r].render() };
}
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
const answer = async (h, p, v) => {
  const c = h.calls.api.find((x) => x.p === p && !x.done);
  assert.ok(c, 'no read of ' + p + ' (have ' + h.calls.api.map((x) => x.p).join(', ') + ')');
  c.done = true; c.res(v); await tick();
};
const W = (h, i) => { const w = h.calls.writes[i]; assert.ok(w, 'no write #' + i); return w; };
async function hubOpen(opts) {
  const h = mk(opts); h.CMD.hubOpen(); h.sc('chhub');
  await answer(h, '/channel-hub', { success: true, data: CARDS(), stores: [{ code: 'th', name: 'Tianhe' }] });
  return h;
}

// ─────────────────────────────────────────────────────────────────────────
section('1 · keys');
{
  it('each write is the server\'s key, and the controls are drawn for it', async () => {
    for (const p of ['/channel-hub/help', '/channel-hub/meituan/box-request', '/channel-hub/eleme/todos/dismiss']) {
      assert.strictEqual(cap.requiredCapFor('POST', '/api/retail-admin' + p), 'integrations:manage', p);
    }
    for (const p of ['/eleme/shop', '/eleme/enable']) assert.strictEqual(cap.requiredCapFor('POST', '/api/retail-admin' + p), 'eleme:sync', p);
    const h = await hubOpen({ caps: ['dashboard:view'] });
    const t = h.text(h.sc('chhub'));
    assert.ok(t.includes('Meituan') && !t.includes('Get help') && !t.includes('Dismiss'));
    h.CMD.hubDismiss('eleme', 't1'); h.CMD.hubHelp('meituan');
    h.s().boxKind = 'meituan'; h.CMD.hubBoxRequest();
    h.s().elStores = [{ id: 5, code: 'yx' }]; h.s().shopIds[5] = '123'; h.CMD.hubElemeShop(5); h.CMD.hubElemeEnable();
    assert.strictEqual(h.calls.writes.length, 0); assert.strictEqual(h.ctx.state.ask, null);
  });
  it('its door is on the Sales screen', () => {
    assert.ok(block(M, 'function screenSales(){').includes('${x9HubDoor()'));
    const h = mk({ caps: ['orders:view'] }); assert.strictEqual(h.ctx.x9HubDoor(), '');
  });
}

section('2 · the hub');
{
  it('every card: its state in the desktop\'s words, its health or blurb, its to-dos, its action', async () => {
    const h = await hubOpen();
    const t = h.text(h.sc('chhub'));
    for (const w of ['Meituan Not set up', 'Delivery orders from Meituan.', 'Set up', 'Eleme Needs attention', 'signed out',
      '⚑ New location Yuexiu — link it here', 'Fix', 'WeChat mini program Connected', 'Set up on desktop for now',
      'JD Logistics Ready to set up', 'Qingyun In setup', 'Get help']) assert.ok(t.includes(w), w);
    const STATUS = slice(IG, 'const STATUS = {', '};');
    for (const [en, zh] of [['Connected', '已连接'], ['Ready to set up', '待设置'], ['Needs attention', '需处理'], ['Not set up', '未配置'], ['In setup', '设置中']]) {
      assert.ok(STATUS.includes(`en: '${en}'`) && STATUS.includes(`cn: '${zh}'`), en);
    }
  });
  it('Set up opens the phone\'s own screen for each kind that has one', async () => {
    const h = await hubOpen();
    const html = h.sc('chhub');
    assert.ok(html.includes(`APP.cmd('hubBoxOpen','meituan')`) && html.includes(`APP.cmd('hubElemeOpen')`) && html.includes(`APP.cmd('push','jdcfg')`) && html.includes(`APP.cmd('hubBoxOpen','qingyun')`));
  });
  it('a to-do is dismissed with its id, and the hub is read again', async () => {
    const h = await hubOpen();
    h.CMD.hubDismiss('eleme', 'nope'); assert.strictEqual(h.calls.writes.length, 0);
    h.CMD.hubDismiss('eleme', 't1');
    const w = W(h, 0); assert.strictEqual(w.p, '/channel-hub/eleme/todos/dismiss'); assert.deepStrictEqual(w.body, { todoId: 't1' });
    w.res({ success: true }); await tick();
    assert.strictEqual(h.calls.api.filter((c) => c.p === '/channel-hub').length, 2);
  });
  it('Get help asks for an optional note and sends {kind, note}', async () => {
    const h = await hubOpen();
    h.CMD.hubHelp('meituan');
    const a = h.ctx.state.ask;
    assert.strictEqual(a.title, 'Tell us what you\'re stuck on with Meituan (optional):');
    assert.strictEqual(a.confirmLabel, 'Send request');
    a.run({ note: '' });
    assert.deepStrictEqual(W(h, 0).body, { kind: 'meituan', note: '' }); assert.strictEqual(W(h, 0).p, '/channel-hub/help');
    W(h, 0).res({ success: true }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Help request sent — we’ll be in touch.']);
    h.CMD.hubHelp('eleme'); h.ctx.state.ask.run({ note: 'the shop id' });
    W(h, 1).rej(REFUSED()); await tick();
    assert.ok(h.text(h.sc('chhub')).includes('You don’t have permission for this'));
  });
  it('a failed read and an empty hub', async () => {
    const h = mk(); h.CMD.hubOpen(); h.sc('chhub');
    const c = h.calls.api[0]; c.done = true; c.rej(new Error('HTTP 500')); await tick();
    assert.ok(h.text(h.sc('chhub')).includes('Could not load this.'));
    const e = mk(); e.CMD.hubOpen(); e.sc('chhub'); await answer(e, '/channel-hub', { data: [] });
    assert.ok(e.text(e.sc('chhub')).includes('No channels available.'));
  });
}

section('3 · the box (Meituan, Qingyun)');
{
  it('no box yet: what it is, and Request the box', async () => {
    const h = await hubOpen(); h.CMD.hubBoxOpen('meituan');
    assert.deepStrictEqual(h.calls.pushes, ['chhub', 'hubbox']);
    const t = h.text(h.sc('hubbox'));
    assert.ok(t.includes('Meituan setup starts with a small box we ship to you.') && t.includes('Request the box') && t.includes('I already have it — continue'));
    assert.strictEqual(h.ctx.SUBS.hubbox.titleOf(), 'Set up Meituan');
    h.CMD.hubBoxRequest();
    const w = W(h, 0); assert.strictEqual(w.p, '/channel-hub/meituan/box-request'); assert.deepStrictEqual(w.body, {});
    w.res({ success: true }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Box requested — we’ll contact you']);
  });
  it('a shipped box says so, with its tracking, and continuing asks for help', async () => {
    const h = await hubOpen(); h.CMD.hubBoxOpen('qingyun');
    const t = h.text(h.sc('hubbox'));
    assert.ok(t.includes('✓ Box shipped — on its way 2026-09-28') && t.includes('Tracking: SF123') && t.includes('Box is plugged in — continue'));
    assert.ok(!t.includes('Request the box'));
  });
  it('a failed request stays on the screen', async () => {
    const h = await hubOpen(); h.CMD.hubBoxOpen('meituan');
    h.CMD.hubBoxRequest(); W(h, 0).rej(new Error('HTTP 500')); await tick();
    assert.ok(h.text(h.sc('hubbox')).includes('Request failed — try again'));
  });
}

section('4 · Eleme');
{
  const STORES = [{ id: 5, code: 'yx', name: '越秀店', nameEn: 'Yuexiu', shop_id: '' }, { id: 6, code: 'th', name: '天河店', nameEn: 'Tianhe', shop_id: 'S9', shop_name: 'Roots 天河', sessionActive: true }];
  async function el(stores) {
    const h = await hubOpen(); h.CMD.hubElemeOpen(); h.sc('hubeleme');
    await answer(h, '/eleme/stores', { data: plain(stores) });
    return h;
  }
  it('step 1 links each store\'s shop id', async () => {
    const h = await el(STORES);
    const t = h.text(h.sc('hubeleme'));
    assert.ok(t.includes('1. Link shops') && t.includes('…/app/shop/<id>/…') && t.includes('✓ Roots 天河'));
    h.CMD.hubElemeShop(5); assert.strictEqual(h.calls.writes.length, 0, 'nothing typed, nothing sent');
    h.CMD.hubShopId(5, ' 12345 '); h.CMD.hubElemeShop(5);
    const w = W(h, 0); assert.strictEqual(w.p, '/eleme/shop'); assert.deepStrictEqual(w.body, { storeId: 5, storeCode: 'yx', shopId: '12345' });
    assert.ok(block(IG, 'window.igElemeShop = async function').includes('{ storeId, storeCode, shopId }'));
    w.res({ success: true }); await tick(); h.sc('hubeleme');
    assert.strictEqual(h.calls.api.filter((c) => c.p === '/eleme/stores').length, 2, 'the stores are read again');
    assert.strictEqual(h.calls.api.filter((c) => c.p === '/channel-hub').length, 2, 'and the hub, as the desktop\'s igLoad');
  });
  it('step 2, every store linked: who still needs a login, and Enable channel', async () => {
    const h = await el([Object.assign({}, STORES[0], { shop_id: 'S1', sessionActive: false }), STORES[1]]);
    const t = h.text(h.sc('hubeleme'));
    assert.ok(t.includes('2. Verify & enable') && t.includes('These stores still need a one-time login') && t.includes('Yuexiu'));
    h.CMD.hubElemeEnable();
    const w = W(h, 0); assert.strictEqual(w.p, '/eleme/enable'); assert.deepStrictEqual(w.body, { enabled: true });
    w.res({ success: true }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Eleme enabled']);
    assert.strictEqual(h.calls.pops, 1);
  });
  it('a refused shop id stays on the screen', async () => {
    const h = await el(STORES);
    h.CMD.hubShopId(5, '1'); h.CMD.hubElemeShop(5); W(h, 0).rej(REFUSED()); await tick();
    assert.ok(h.text(h.sc('hubeleme')).includes('You don’t have permission for this'));
  });
}

section('5 · in Chinese');
{
  it('reads in Chinese', async () => {
    const h = await hubOpen({ lang: 'zh' });
    const t = h.text(h.sc('chhub'));
    for (const w of ['美团', '未配置', '开始设置', '需处理', '修复', '已连接', '暂请在电脑端设置', '获取帮助', '新门店 Yuexiu — 请在此关联']) assert.ok(t.includes(w), w);
    h.CMD.hubBoxOpen('meituan');
    assert.ok(h.text(h.sc('hubbox')).includes('申请盒子'));
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
