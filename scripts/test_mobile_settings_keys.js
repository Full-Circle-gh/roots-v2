#!/usr/bin/env node
/**
 * §325 X7 — PRINTERS, COURIER KEYS, QINGYUN AND PUSH NOTIFICATIONS, ON THE PHONE.
 *
 *   node scripts/test_mobile_settings_keys.js
 *
 * The desktop panels that connect the shop to the outside: Receipt printing
 * (02-settings-ops.js _savePrinter / _testPrinter / _saveIntegration), Package
 * tracking and JD Logistics (_testKd100, _testJd), Qingyun riders
 * (_requestQingyun, _setQingyunAutoPush), and Push notifications
 * (05-marketing.js saveConfig, saveWecomApp, testWecomWebhook,
 * saveAliyunSms_, _testAliyunSms, _testSystemAlert).
 *
 * What is asserted: every write's method, path and body, against the desktop's
 * own body read out of its source; the desktop's checks before a write; a
 * secret left blank is kept (never sent); refusals and failures rendered in
 * place, toasts only for what worked; loading, empty and failed reads; who is
 * refused; both languages. No browser — fast shard.
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
const OPS = fs.readFileSync(path.join(ROOT, 'public/retail-admin/02-settings-ops.js'), 'utf8');
const MKT = fs.readFileSync(path.join(ROOT, 'public/retail-admin/05-marketing.js'), 'utf8');

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
const keysOf = (src) => [...('{' + src).matchAll(/[{,]\s*'?([a-z_.]+)'?\s*:/g)].map((m) => m[1]);

const SRC = [
  line(M, 'function E(en, zh)'),
  line(M, 'function tmOneLang(m)'),
  slice(M, 'const PILL = {', 'const KIND2PILL'),
  block(M, 'function toggle('),
  block(M, 'function chipRow('),
  block(M, 'function noteBar('),
  block(M, 'function settingsGroupCard('),
  block(M, 'function tmRow('),
  block(M, 'function tmList('),
  block(M, 'function tmCaption('),
  block(M, 'function x1Err('),
  line(M, 'const x1Loading='),
  line(M, 'const cfgHead='),
  slice(M, 'const ROUTE_CAP={', '/* Fail-OPEN on null'),
  slice(M, 'const MCAN_MONEY_ONLY=', '/* NAMED FOR THE JOB'),
  slice(M, '/* ══════════════════════════════════════════════════════════════════════════\n   §325 X6 — STORES', '/* §325 X6 ends */'),
  slice(M, '/* ══════════════════════════════════════════════════════════════════════════\n   §325 X7 — PRINTERS', '/* §325 X7 ends */'),
].join('\n');

const SETTINGS = ['settings:shop', 'settings:push', 'settings:payments', 'stores:view', 'shipping:config', 'delivery:view'];
const REFUSED = () => { const e = new Error('refused'); e.refused = true; e.words = ['You don’t have permission for this', '你没有此操作的权限']; return e; };
const INTEG = {
  kd100: { customer: 'C1', key_masked: 'ab••••yz', callback: 'https://t.example/cb', secret_masked: '', enabled: true },
  jd: { app_key: 'AK', app_secret_masked: 'se••••', access_token_masked: '', customer_code: '', env: 'sandbox', enabled: false },
  feie: { user: 'me@feie', ukey_masked: 'uk••••', enabled: true },
  spyun: { appid: '', appsecret_masked: '', enabled: false },
  wecom_app: { corp_id: 'ww1', agent_id: '1000002', secret_masked: 'ws••••', enabled: true },
  aliyun_sms: { ak_id: 'LTAI1', ak_secret_masked: '', sign_name: '满圆', template_delivered: 'SMS_1', template_otp: '', enabled: false },
};
const PRN = {
  auto_print: true, auto_print_addon: false, auto_print_refund: true, shop_name: 'Roots',
  kitchen_sn: '', kitchen_vendor: 'feie', kitchen_print_on: 'sent', kitchen_copies: 1, transfer_print_on: 'sent',
  vendors: [{ id: 'feie', label_en: 'Feie', label_cn: '飞鹅' }, { id: 'spyun', label_en: 'Shangpeng', label_cn: '商鹏' }],
  stores: [{ id: 3, code: 'th', name_en: 'Tianhe', name_cn: '天河店', sn: '550540977', template: 'receipt', copies: 1, vendor: 'feie' },
    { id: 4, code: 'yx', name_en: 'Yuexiu', name_cn: '越秀店', sn: '', template: 'packing', copies: 2, vendor: 'spyun' }],
  out_of_city_store_id: 3,
};

function mk(opts = {}) {
  const calls = { api: [], writes: [], toasts: [], renders: 0 };
  const CMD = {};
  const ctx = {
    LANG: opts.lang || 'en',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    SUBS: {},
    state: {
      caps: opts.caps === undefined ? [...SETTINGS, 'delivery:edit'] : opts.caps, cfg: {}, stores: [], stack: [], ask: null,
      sto: { id: null, rec: null, d: null, add: {} }, tmd: {},
      x7: { integ: null, integTried: false, integErr: null, prn: null, prnTried: false, prnErr: null, prnD: null, prnStore: null, prev: {},
        qy: null, qyTried: false, qyErr: null, qyAsked: {}, cfgTried: false, cfgErr: null, d: {}, busy: null, err: {}, ok: {} },
    },
    render: () => { calls.renders++; },
    reg: (n, f) => { CMD[n] = f; },
    push: () => {}, pop: () => {}, showToast: (m) => calls.toasts.push(String(m)),
    recapNoMoney: () => false, featOn: () => true, acctAgo: () => '', tdWhen: () => '', _tdL: () => ({}),
    api: (p) => new Promise((res, rej) => { calls.api.push({ p, res, rej }); }),
    apiRaw: (p) => new Promise((res, rej) => { calls.api.push({ p, raw: true, res, rej }); }),
    apiWrite: (p, body, method) => new Promise((res, rej) => {
      calls.writes.push({ p, body: body == null ? body : plain(body), method: method || 'POST', res, rej });
    }),
    document: { getElementById: () => null }, location: { href: '' },
    setTimeout: () => 0, clearTimeout: () => {},
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, RegExp, encodeURIComponent, isNaN, parseInt, parseFloat,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  new vm.Script(SRC + '\nthis.ROUTE_CAP=ROUTE_CAP;this.canRoute=canRoute;').runInContext(ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  return { ctx, CMD, calls, text, s: ctx.state.x7 };
}
const tick = () => new Promise((r) => setImmediate(r));
const fn = (h, name) => vm.runInContext(name, h.ctx);
const answer = async (h, p, v) => {
  const c = h.calls.api.find((x) => x.p === p && !x.done);
  assert.ok(c, 'no read of ' + p + ' (have ' + h.calls.api.map((x) => x.p).join(', ') + ')');
  c.done = true; c.res(v); await tick();
};
const W = (h, i) => { const w = h.calls.writes[i]; assert.ok(w, 'no write #' + i); return w; };
async function open(route, opts) {
  const h = mk(opts);
  h.ctx.SUBS[route].render();
  if (route === 'printers') { await answer(h, '/integrations', plain(INTEG)); await answer(h, '/printer', plain(PRN)); }
  else if (route === 'qycfg') { /* answered by the caller */ }
  else if (route === 'pushcfg') { await answer(h, '/integrations', plain(INTEG)); await answer(h, '/config', opts && opts.cfg || {}); }
  else await answer(h, '/integrations', plain(INTEG));
  return h;
}

// The desktop's bodies, read out of its source.
const DESK_PRN_KEYS = keysOf(block(OPS, 'async function _savePrinter()').split('const body = {')[1].split('};')[0]);
const DESK_CFG_KEYS = keysOf(block(MKT, 'async function saveConfig()').split('const body = {')[1].split('};')[0]);
const svcKeys = (svc) => keysOf(slice(OPS, 'async function _saveIntegration(', 'async function _testKd100').split(`payload.${svc} = {`)[1].split('};')[0]);
const DESK_SMS_KEYS = keysOf(block(MKT, 'async function saveAliyunSms_()').split('aliyun_sms: {')[1].split('},')[0]);

// ─────────────────────────────────────────────────────────────────────────
section('1 · who reaches them');
{
  it('each screen carries the keys the server asks of its writes', () => {
    const { ctx } = mk();
    const cap = require('../lib/cap-routes.js');
    assert.deepStrictEqual(plain(ctx.ROUTE_CAP.printers), cap.integrationServiceCap('feie'));
    assert.deepStrictEqual(plain(ctx.ROUTE_CAP.pushcfg), cap.integrationServiceCap('wecom_app'));
    assert.deepStrictEqual(plain(ctx.ROUTE_CAP.pushcfg), cap.configKeyCap('system_alerts.enabled'));
    assert.deepStrictEqual(plain(ctx.ROUTE_CAP.printers), cap.requiredCapFor('PUT', '/api/retail-admin/printer'));
    assert.deepStrictEqual(plain(ctx.ROUTE_CAP.kd100cfg), cap.integrationServiceCap('kd100'));
    assert.deepStrictEqual(plain(ctx.ROUTE_CAP.jdcfg), cap.integrationServiceCap('jd'));
    assert.deepStrictEqual(plain(ctx.ROUTE_CAP.qycfg), cap.requiredCapFor('POST', '/api/retail-admin/integrations/qingyun/autopush'));
  });
  it('the doors: Operations for printers, Settings for push and the three delivery cards, the Delivery screen for those three', () => {
    const h = mk();
    assert.ok(h.text(fn(h, 'x7PrinterDoor')()).includes('Receipt printing'));
    /* The real card, not a stand-in: a stand-in that drew `cmd` is how these
       doors shipped as rows that did nothing when tapped (fixed in §325 X10). */
    assert.ok(fn(h, 'x7PrinterDoor')().includes(`<button class="row" onclick="APP.cmd('push','printers')"`), 'the printer row is a door');
    const dd = fn(h, 'x7DeliveryDoors')();
    for (const r of ['kd100cfg', 'jdcfg', 'qycfg']) assert.ok(dd.includes(`onclick="APP.cmd('push','${r}')"`), r + ' is a door');
    const rows = fn(h, 'x7DeliveryRows')().map((r) => r.label);
    assert.deepStrictEqual(plain(rows), ['Package tracking', 'JD Logistics', 'Qingyun riders']);
    const none = mk({ caps: ['orders:view'] });
    assert.strictEqual(fn(none, 'x7PrinterDoor')(), '');
    assert.strictEqual(fn(none, 'x7DeliveryRows')().length, 0);
    const ship = mk({ caps: ['shipping:config'] });
    assert.deepStrictEqual(plain(fn(ship, 'x7DeliveryRows')().map((r) => r.label)), ['Package tracking', 'JD Logistics'], 'Qingyun is not shipping:config\'s');
    assert.ok(block(M, 'function screenOperations(){').includes('${x7PrinterDoor()}'));
    assert.ok(block(M, 'function screenDelivery(){').includes('${x7DeliveryDoors()'));
    const st = block(M, 'function screenSettings(){');
    assert.ok(/canRoute\('pushcfg'\)\?\[\{label:T\('Push notifications','推送通知'\)/.test(st));
    assert.ok(st.includes("{h:T('Delivery','配送'),rows:x7DeliveryRows()}"));
  });
  it('without the keys, no command writes', async () => {
    const h = mk({ caps: ['orders:view'] });
    h.s.prnD = fn(h, 'x7PrnSeed')(PRN); h.s.prn = plain(PRN); h.s.qy = { stores: [{ code: 'th', connected: false }], any: true, autoPush: false };
    h.s.d = { 'cfg.template': '', 'cfg.webhook': '', 'cfg.alerts_on': false, 'cfg.alerts_webhook': 'x', 'sms.testphone': '13800138000' };
    for (const c of ['x7PrnSave', 'x7CfgSave', 'x7WecomSave', 'x7WecomTest', 'x7SmsSave', 'x7SmsTest', 'x7AlertTest', 'x7QyAuto']) h.CMD[c]();
    h.CMD.x7PrnTest(3); h.CMD.x7SvcSave('kd100'); h.CMD.x7SvcTest('jd'); h.CMD.x7QyAsk('th');
    await tick();
    assert.strictEqual(h.calls.writes.length, 0);
  });
  it('each is read fresh on every entry', () => {
    assert.ok(/\['printers','kd100cfg','jdcfg','qycfg','pushcfg'\]\.includes\(route\)\)\{ const x=state\.x7;/.test(block(M, 'function push(route)')));
  });
}

section('2 · receipt printing');
{
  it('opens on the stored settings, the first store\'s printer, and its preview', async () => {
    const h = await open('printers');
    assert.strictEqual(h.s.prnStore, 3);
    assert.ok(h.calls.api.some((c) => c.p === '/printer/preview?store_id=3&template=receipt'));
    await answer(h, '/printer/preview?store_id=3&template=receipt', { ok: true, content: '<CB>Roots</CB>\nOrder 1', sample: true });
    const t = h.text(h.ctx.SUBS.printers.render());
    for (const w of ['Feie', 'LIVE', 'Shangpeng', 'NOT SET', 'Auto-print every paid order at its store', 'Receipt header',
      'Printers by store', 'Tianhe', 'Yuexiu', 'Printer SN', 'Template', 'Copies', 'Print preview', 'Roots', 'Order 1', 'Sample data',
      'Save & test this store', 'Kitchen printer', 'Stock requests', 'Out-of-Guangzhou orders', 'Save all']) assert.ok(t.includes(w), w);
    assert.ok(h.ctx.SUBS.printers.render().includes('uk•••• — leave blank to keep'), 'a saved key shows only its mask');
  });
  it('the printer body is _savePrinter\'s, key for key and in its order', async () => {
    const h = await open('printers');
    assert.ok(DESK_PRN_KEYS.length === 11, 'read the desktop body: ' + DESK_PRN_KEYS.join(','));
    assert.deepStrictEqual(plain(Object.keys(fn(h, 'x7PrnBody')())), DESK_PRN_KEYS);
  });
  it('Save all sends each brand\'s account, a blank secret kept, then the printer settings', async () => {
    const h = await open('printers');
    h.CMD.x7In('feie.user', ' me@feie '); h.CMD.x7In('spyun.appid', 'SP1'); h.CMD.x7In('spyun.appsecret', 'shh');
    h.CMD.x7Prn('auto_print_addon'); h.CMD.x7Prn('shop_name', 'Roots Kitchen'); h.CMD.x7Prn('kitchen_sn', ' 9988 ');
    h.CMD.x7Prn('kitchen_print_on', 'both'); h.CMD.x7Prn('kitchen_copies', '2'); h.CMD.x7Prn('transfer_print_on', 'off');
    h.CMD.x7Prn('out_of_city_store_id', '4');
    h.CMD.x7PrnStore(4, 'sn', ' 123 '); h.CMD.x7PrnStore(4, 'copies', '3'); h.CMD.x7PrnStore(4, 'vendor', 'feie');
    h.CMD.x7PrnSave(); await tick();
    let w = W(h, 0);
    assert.strictEqual(w.p, '/integrations'); assert.strictEqual(w.method, 'PUT');
    assert.deepStrictEqual(w.body, { feie: { user: 'me@feie' } }, 'the USERKEY left blank is not sent');
    assert.deepStrictEqual(Object.keys(w.body.feie).concat(['ukey']), svcKeys('feie'));
    w.res({ success: true }); await tick();
    w = W(h, 1);
    assert.deepStrictEqual(w.body, { spyun: { appid: 'SP1', appsecret: 'shh' } });
    assert.deepStrictEqual(Object.keys(w.body.spyun), svcKeys('spyun'));
    w.res({ success: true }); await tick();
    w = W(h, 2);
    assert.strictEqual(w.p, '/printer'); assert.strictEqual(w.method, 'PUT');
    assert.deepStrictEqual(w.body, {
      auto_print: true, auto_print_addon: true, auto_print_refund: true, shop_name: 'Roots Kitchen',
      kitchen_sn: ' 9988 ', kitchen_vendor: 'feie', kitchen_print_on: 'both', kitchen_copies: '2', transfer_print_on: 'off',
      by_store: { 3: { sn: '550540977', vendor: 'feie', template: 'receipt', copies: 1 }, 4: { sn: '123', vendor: 'feie', template: 'packing', copies: 3 } },
      out_of_city_store_id: '4' });
    w.res({ success: true }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Printer settings saved']);
    assert.strictEqual(h.s.d['spyun.appsecret'], '', 'the typed secret is not kept in the field');
  });
  it('picks outside the lists are ignored, and "each order\'s own store" sends null', async () => {
    const h = await open('printers');
    h.CMD.x7Prn('kitchen_print_on', 'sometimes'); h.CMD.x7Prn('kitchen_vendor', 'acme'); h.CMD.x7PrnStore(3, 'template', 'poster');
    h.CMD.x7Prn('out_of_city_store_id', '99'); h.CMD.x7Prn('out_of_city_store_id', '');
    const b = fn(h, 'x7PrnBody')();
    assert.strictEqual(b.kitchen_print_on, 'sent'); assert.strictEqual(b.kitchen_vendor, 'feie');
    assert.strictEqual(b.by_store[3].template, 'receipt'); assert.strictEqual(b.out_of_city_store_id, null);
  });
  it('a refused account stays on the screen; the printer settings still go, as the desktop sends them', async () => {
    const h = await open('printers');
    h.CMD.x7PrnSave(); await tick();
    W(h, 0).rej(REFUSED()); await tick();
    W(h, 1).res({ success: true }); await tick();
    W(h, 2).res({ success: true }); await tick();
    assert.deepStrictEqual(h.calls.toasts, []);
    assert.ok(h.text(h.ctx.SUBS.printers.render()).includes('You don’t have permission for this'));
  });
  it('Save & test saves everything, then asks that store\'s printer, and a wrong brand is named in place', async () => {
    const h = await open('printers');
    h.CMD.x7PrnTest(3); await tick();
    W(h, 0).res({ success: true }); await tick(); W(h, 1).res({ success: true }); await tick(); W(h, 2).res({ success: true }); await tick();
    const w = W(h, 3);
    assert.strictEqual(w.p, '/printer/test'); assert.strictEqual(w.method, 'POST'); assert.deepStrictEqual(w.body, { store_id: 3 });
    w.res({ ok: false, error: 'printer not found', code: 'unknown_printer', vendor_label: '飞鹅', sn: '550540977' }); await tick();
    const t = h.text(h.ctx.SUBS.printers.render());
    assert.ok(t.includes('Print failed: printer not found — 飞鹅 · SN 550540977'));
    assert.ok(t.includes('Is the BRAND right for this store?'));
    assert.deepStrictEqual(h.calls.toasts, []);
  });
  it('a test that prints says so', async () => {
    const h = await open('printers');
    h.CMD.x7PrnTest(3); await tick();
    for (let i = 0; i < 3; i++) { W(h, i).res({ success: true }); await tick(); }
    W(h, 3).res({ ok: true }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Test sent — check that store\'s printer']);
  });
  it('switching store or template re-reads the preview; no preview says so', async () => {
    const h = await open('printers');
    h.CMD.x7PrnTab(4);
    await answer(h, '/printer/preview?store_id=4&template=packing', { ok: false });
    assert.ok(h.text(h.ctx.SUBS.printers.render()).includes('No preview available'));
    h.CMD.x7PrnStore(4, 'template', 'compact');
    assert.ok(h.calls.api.some((c) => c.p === '/printer/preview?store_id=4&template=compact'));
  });
  it('no stores: the desktop\'s line; a failed read: Try again', async () => {
    const h = mk(); h.ctx.SUBS.printers.render();
    await answer(h, '/integrations', plain(INTEG)); await answer(h, '/printer', Object.assign(plain(PRN), { stores: [] }));
    assert.ok(h.text(h.ctx.SUBS.printers.render()).includes('No active stores. Add stores under Stores first.'));
    const f = mk(); f.ctx.SUBS.printers.render();
    f.calls.api.find((c) => c.p === '/printer').rej(new Error('HTTP 500')); await tick();
    const t = f.text(f.ctx.SUBS.printers.render());
    assert.ok(t.includes('Could not load this.') && t.includes('Try again'));
  });
}

section('3 · Kuaidi100 and JD keys');
{
  it('Kuaidi100: the desktop body, the blank key and secret kept, then Save & test', async () => {
    const h = await open('kd100cfg');
    const t = h.text(h.ctx.SUBS.kd100cfg.render());
    assert.ok(t.includes('Kuaidi100 tracking push') && t.includes('LIVE') && t.includes('Callback secret'));
    h.CMD.x7In('kd100.customer', ' C2 ');
    h.CMD.x7SvcTest('kd100');
    const w = W(h, 0);
    assert.strictEqual(w.p, '/integrations'); assert.strictEqual(w.method, 'PUT');
    assert.deepStrictEqual(w.body, { kd100: { customer: 'C2', callback: 'https://t.example/cb' } });
    assert.deepStrictEqual(['customer', 'key', 'callback', 'secret'], svcKeys('kd100'));
    w.res({ success: true }); await tick();
    const t2 = W(h, 1);
    assert.strictEqual(t2.p, '/integrations/kd100/test'); assert.strictEqual(t2.method, 'POST');
    t2.res({ ok: false, error: 'kd100_auth' }); await tick();
    assert.ok(h.text(h.ctx.SUBS.kd100cfg.render()).includes('Test failed: kd100_auth'));
    assert.deepStrictEqual(h.calls.toasts, []);
  });
  it('Kuaidi100 with nothing stored opens on the desktop\'s callback address, so both send the same body', async () => {
    const h = mk(); h.ctx.SUBS.kd100cfg.render();
    await answer(h, '/integrations', Object.assign(plain(INTEG), { kd100: { enabled: false } }));
    const desk = OPS.length && fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8').match(/id="kd100-callback"[^>]*value="([^"]+)"/)[1];
    assert.strictEqual(h.s.d['kd100.callback'], desk);
    assert.ok(h.text(h.ctx.SUBS.kd100cfg.render()).includes('NOT CONFIGURED'));
  });
  it('JD: the desktop body, env kept, a typed secret sent, Save & ping', async () => {
    const h = await open('jdcfg');
    assert.ok(h.text(h.ctx.SUBS.jdcfg.render()).includes('PENDING JD ACCOUNT'));
    h.CMD.x7In('jd.access_token', 'TOK'); h.CMD.x7In('jd.customer_code', ' 0201 ');
    h.CMD.x7SvcTest('jd');
    const w = W(h, 0);
    assert.deepStrictEqual(w.body, { jd: { app_key: 'AK', access_token: 'TOK', customer_code: '0201', env: 'sandbox' } });
    assert.deepStrictEqual(['app_key', 'app_secret', 'access_token', 'customer_code', 'env'], svcKeys('jd'));
    w.res({ success: true }); await tick();
    W(h, 1).res({ ok: true, note: 'missing customerCode' }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['JD reachable · auth OK']);
    assert.ok(h.text(h.ctx.SUBS.jdcfg.render()).includes('Next: enter CUSTOMER_CODE (商家编码) to enable waybill push'));
  });
  it('a refused save stays in place and no test is sent', async () => {
    const h = await open('jdcfg');
    h.CMD.x7SvcTest('jd'); W(h, 0).rej(REFUSED()); await tick();
    assert.strictEqual(h.calls.writes.length, 1);
    assert.ok(h.text(h.ctx.SUBS.jdcfg.render()).includes('You don’t have permission for this'));
    h.CMD.x7SvcSave('kd100');
    assert.strictEqual(h.calls.writes.length, 2, 'Save alone');
    W(h, 1).res({ success: true }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Saved']);
  });
}

section('4 · Qingyun riders');
{
  async function qy(j, opts) {
    const h = mk(opts); h.ctx.SUBS.qycfg.render();
    const c = h.calls.api.find((x) => x.p === '/integrations/qingyun');
    assert.ok(c && c.raw, 'the whole answer is read: autoPush and anyConnected ride beside the list');
    c.res(j); await tick();
    return h;
  }
  const J = { success: true, data: [{ code: 'th', name_en: 'Tianhe', name_cn: '天河店', connected: true }, { code: 'yx', name_en: 'Yuexiu', name_cn: '', connected: false }], autoPush: false, anyConnected: true };
  it('each store\'s status, Request setup for the unconnected, and Auto-send once one is connected', async () => {
    const h = await qy(plain(J));
    const t = h.text(h.ctx.SUBS.qycfg.render());
    assert.ok(t.includes('Tianhe · 天河店') && t.includes('Connected') && t.includes('Yuexiu') && t.includes('Not set up') && t.includes('Request setup'));
    assert.ok(t.includes('Auto-send paid orders to Qingyun'));
    const none = await qy(Object.assign(plain(J), { anyConnected: false }));
    assert.ok(!none.text(none.ctx.SUBS.qycfg.render()).includes('Auto-send'));
    const empty = await qy({ success: true, data: [] });
    assert.ok(empty.text(empty.ctx.SUBS.qycfg.render()).includes('No active stores yet.'));
  });
  it('Request setup POSTs {store_code}, then says Requested', async () => {
    const h = await qy(plain(J));
    h.CMD.x7QyAsk('th'); assert.strictEqual(h.calls.writes.length, 0, 'a connected store is not asked');
    h.CMD.x7QyAsk('yx');
    const w = W(h, 0);
    assert.strictEqual(w.p, '/integrations/qingyun/request'); assert.strictEqual(w.method, 'POST'); assert.deepStrictEqual(w.body, { store_code: 'yx' });
    w.res({ success: true }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Request sent — we will set it up']);
    assert.ok(h.text(h.ctx.SUBS.qycfg.render()).includes('Requested'));
    h.CMD.x7QyAsk('yx'); assert.strictEqual(h.calls.writes.length, 1, 'once');
  });
  it('Auto-send POSTs {enabled}, and the switch moves only when the server says so', async () => {
    const h = await qy(plain(J));
    h.CMD.x7QyAuto();
    const w = W(h, 0);
    assert.strictEqual(w.p, '/integrations/qingyun/autopush'); assert.deepStrictEqual(w.body, { enabled: true });
    assert.strictEqual(h.s.qy.autoPush, false);
    w.res({ success: true, enabled: true }); await tick();
    assert.strictEqual(h.s.qy.autoPush, true);
    assert.deepStrictEqual(h.calls.toasts, ['Auto-send on']);
    h.CMD.x7QyAuto(); W(h, 1).rej(REFUSED()); await tick();
    assert.strictEqual(h.s.qy.autoPush, true, 'a refused change leaves it as it was');
    assert.ok(h.text(h.ctx.SUBS.qycfg.render()).includes('You don’t have permission for this'));
  });
  it('a failed read says so', async () => {
    const h = mk(); h.ctx.SUBS.qycfg.render();
    h.calls.api[0].rej(new Error('HTTP 500')); await tick();
    assert.ok(h.text(h.ctx.SUBS.qycfg.render()).includes('Could not load this.'));
  });
}

section('5 · Push notifications');
{
  const CFG = { notifications: { order_status_template_id: 'TPL', wecom_order_webhook: '' }, system_alerts: { enabled: false, wecom_webhook: '' } };
  it('opens on the stored values and the keys\' state', async () => {
    const h = await open('pushcfg', { cfg: plain(CFG) });
    const t = h.text(h.ctx.SUBS.pushcfg.render());
    for (const w of ['New-order alert to your phone', 'LIVE', 'SMS when delivered (out-of-Guangzhou orders)', 'NOT CONFIGURED',
      'Order-status subscribe-message template', 'Alternative: group-bot webhook', 'System Alerts', 'Enable system alerts', 'Save settings']) assert.ok(t.includes(w), w);
    assert.strictEqual(h.s.d['cfg.template'], 'TPL');
  });
  it('Save settings sends saveConfig\'s four keys, and only those', async () => {
    const h = await open('pushcfg', { cfg: plain(CFG) });
    h.CMD.x7In('cfg.template', ' TPL2 '); h.CMD.x7In('cfg.webhook', ' https://qyapi.weixin.qq.com/x ');
    h.CMD.x7Flip('cfg.alerts_on'); h.CMD.x7In('cfg.alerts_webhook', 'https://qyapi.weixin.qq.com/y');
    h.CMD.x7CfgSave();
    const w = W(h, 0);
    assert.strictEqual(w.p, '/config'); assert.strictEqual(w.method, 'PUT');
    assert.deepStrictEqual(Object.keys(w.body), DESK_CFG_KEYS);
    assert.deepStrictEqual(w.body, { 'notifications.order_status_template_id': 'TPL2', 'notifications.wecom_order_webhook': 'https://qyapi.weixin.qq.com/x',
      'system_alerts.enabled': true, 'system_alerts.wecom_webhook': 'https://qyapi.weixin.qq.com/y' });
    w.res({ success: true }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Settings saved']);
  });
  it('a refused Save stays on the screen', async () => {
    const h = await open('pushcfg', { cfg: plain(CFG) });
    h.CMD.x7CfgSave(); W(h, 0).rej(REFUSED()); await tick();
    assert.ok(h.text(h.ctx.SUBS.pushcfg.render()).includes('You don’t have permission for this'));
    assert.deepStrictEqual(h.calls.toasts, []);
  });
  it('WeCom app: the desktop body, a blank secret kept; the test asks with the typed group-bot address', async () => {
    const h = await open('pushcfg', { cfg: plain(CFG) });
    h.CMD.x7In('wecom.corp_id', ''); h.CMD.x7WecomSave();
    let w = W(h, 0);
    assert.strictEqual(w.p, '/integrations'); assert.strictEqual(w.method, 'PUT');
    assert.deepStrictEqual(w.body, { wecom_app: { corp_id: null, agent_id: '1000002' } }, 'an emptied field clears; the secret is kept');
    assert.deepStrictEqual(['corp_id', 'agent_id', 'secret'], keysOf(block(MKT, 'async function saveWecomApp()').split('wecom_app: {')[1].split('}')[0]));
    w.res({ success: true }); await tick();
    h.CMD.x7In('cfg.webhook', ' https://qyapi.weixin.qq.com/z ');
    h.CMD.x7WecomTest();
    w = W(h, 1);
    assert.strictEqual(w.p, '/wecom/test'); assert.deepStrictEqual(w.body, { webhook: 'https://qyapi.weixin.qq.com/z' });
    w.res({ success: false, error: 'no_valid_webhook' }); await tick();
    assert.ok(h.text(h.ctx.SUBS.pushcfg.render()).includes('Set up the app above, or paste a qyapi.weixin.qq.com URL'));
  });
  it('SMS: the phone is checked first; then saved, then a real test SMS; not_configured is said in words', async () => {
    const h = await open('pushcfg', { cfg: plain(CFG) });
    h.CMD.x7In('sms.testphone', '12345'); h.CMD.x7SmsTest();
    assert.strictEqual(h.calls.writes.length, 0);
    assert.ok(h.text(h.ctx.SUBS.pushcfg.render()).includes('Enter an 11-digit mainland mobile'));
    h.CMD.x7In('sms.testphone', '+86 138 0013 8000'); h.CMD.x7In('sms.ak_secret', 'SEC'); h.CMD.x7SmsTest();
    let w = W(h, 0);
    assert.deepStrictEqual(w.body, { aliyun_sms: { ak_id: 'LTAI1', ak_secret: 'SEC', sign_name: '满圆', template_delivered: 'SMS_1', template_otp: null } });
    assert.deepStrictEqual(Object.keys(w.body.aliyun_sms), DESK_SMS_KEYS);
    w.res({ success: true }); await tick();
    w = W(h, 1);
    assert.strictEqual(w.p, '/integrations/aliyun_sms/test'); assert.deepStrictEqual(w.body, { phone: '+86 138 0013 8000' });
    w.res({ ok: false, error: 'not_configured' }); await tick();
    assert.ok(h.text(h.ctx.SUBS.pushcfg.render()).includes('Fill in all four fields first'));
    assert.strictEqual(h.s.d['sms.ak_secret'], '', 'the typed secret is not kept in the field');
  });
  it('System Alerts test: a webhook is required first; the server\'s refusal of the address is said in words', async () => {
    const h = await open('pushcfg', { cfg: plain(CFG) });
    h.CMD.x7AlertTest();
    assert.strictEqual(h.calls.writes.length, 0);
    assert.ok(h.text(h.ctx.SUBS.pushcfg.render()).includes('Paste a webhook first'));
    h.CMD.x7In('cfg.alerts_webhook', ' https://evil.example/ '); h.CMD.x7AlertTest();
    const w = W(h, 0);
    assert.strictEqual(w.p, '/system-alerts/test'); assert.deepStrictEqual(w.body, { webhook: 'https://evil.example/' });
    w.res({ success: false, error: 'domain_not_allowed' }); await tick();
    assert.ok(h.text(h.ctx.SUBS.pushcfg.render()).includes('Only qyapi.weixin.qq.com URLs'));
    h.CMD.x7AlertTest(); W(h, 1).res({ success: true }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Sent — check the group']);
  });
  it('a failed read says so and offers Try again', async () => {
    const h = mk(); h.ctx.SUBS.pushcfg.render();
    h.calls.api.find((c) => c.p === '/config').rej(new Error('HTTP 500')); await tick();
    const t = h.text(h.ctx.SUBS.pushcfg.render());
    assert.ok(t.includes('Could not load this.') && t.includes('Try again'));
  });
}

section('6 · in Chinese');
{
  it('the five screens read in Chinese', async () => {
    const p = await open('printers', { lang: 'zh' });
    const t = p.text(p.ctx.SUBS.printers.render());
    for (const w of ['飞鹅', '已启用', '商鹏', '付款后在对应门店自动打印', '小票抬头', '各门店打印机', '编号', '模板', '份数', '厨房打印机', '补货申请', '广州以外订单', '全部保存']) assert.ok(t.includes(w), w);
    const k = await open('kd100cfg', { lang: 'zh' });
    assert.ok(k.text(k.ctx.SUBS.kd100cfg.render()).includes('快递100轨迹订阅'));
    const j = await open('jdcfg', { lang: 'zh' });
    assert.ok(j.text(j.ctx.SUBS.jdcfg.render()).includes('待开通京东账号'));
    const u = await open('pushcfg', { lang: 'zh', cfg: {} });
    const ut = u.text(u.ctx.SUBS.pushcfg.render());
    for (const w of ['新订单手机提醒', '送达短信(广州市外订单)', '订单状态订阅消息模板', '系统告警', '开启系统告警', '保存设置']) assert.ok(ut.includes(w), w);
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
