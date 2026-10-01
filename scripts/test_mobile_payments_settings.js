#!/usr/bin/env node
/**
 * §325 X10 — PAYMENTS ON THE PHONE: THE DISPLAY CURRENCY, TAX, AND ALIPAY BY
 * QR CODE.
 *
 *   node scripts/test_mobile_payments_settings.js
 *
 * The desktop's three money cards (05-marketing.js renderCurrencyControl,
 * taxCardSync, saveTaxSettings; 02-settings-ops.js loadAlipayManual,
 * saveAlipayManualInline).
 *
 * What is asserted: who may open it, and that it fails closed; what each card
 * shows from its read; the desktop's checks before a write; that every write
 * asks first and says what changes; every write's method, path and body,
 * against the desktop's own; that the AI key is never drawn and sent only
 * when typed, and the image only when picked; each refusal in place; a card
 * whose read failed cannot be saved; the doors; both languages. No browser —
 * fast shard.
 */
'use strict';

process.exitCode = 1;

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const MK = fs.readFileSync(path.join(ROOT, 'public/retail-admin/05-marketing.js'), 'utf8');
const OPS = fs.readFileSync(path.join(ROOT, 'public/retail-admin/02-settings-ops.js'), 'utf8');
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
  block(M, 'function toggle('),
  block(M, 'function x1Err('),
  line(M, 'const x1Loading='),
  block(M, 'function x6Words('),
  line(M, 'const x6En='),
  line(M, 'const x6Zh='),
  slice(M, 'const ROUTE_CAP={', '/* Fail-OPEN on null'),
  slice(M, 'const MCAN_MONEY_ONLY=', '/* NAMED FOR THE JOB'),
  slice(M, '/* ══════════════════════════════════════════════════════════════════════════\n   §325 X10 — PAYMENTS', '/* §325 X10 ends */'),
].join('\n');

const SETTINGS = ['settings:shop', 'settings:push', 'settings:payments', 'stores:view', 'shipping:config', 'delivery:view'];
const REFUSED = () => { const e = new Error('refused'); e.refused = true; e.words = ['You don’t have permission for this', '你没有此操作的权限']; return e; };
const CODE = (c) => { const e = new Error(c); e.code = c; return e; };
const CFG = () => ({ currency: { code: 'CNY', symbol: '¥', decimals: 2, position: 'before' },
  tax: { enabled: true, mode: 'exclusive', rateMicro: 200000, label: { en: 'VAT', cn: '增值税' }, number: 'GB123', shippingTaxable: false } });
const ALI = () => ({ enabled: true, account: '哈素萌', qr: 'data:image/png;base64,SAVEDQR', ocrEnabled: true, autoFlip: false,
  payeeMatch: '哈素萌, 玲', timeWindowMin: 30, proofAgeMin: 120, hasKey: true, keyMasked: 'sk-…abcd', serverKeyAvailable: false,
  anthropicKey: 'sk-ant-LEAKED-KEY' /* never sent by the server; if it were, it must not be drawn */ });

function mk(opts = {}) {
  const calls = { api: [], writes: [], toasts: [], pushes: [] };
  const CMD = {};
  const ctx = {
    LANG: opts.lang || 'en',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    SUBS: {},
    state: { caps: opts.caps === undefined ? SETTINGS : opts.caps, ask: null, askErr: null, stack: [], alipay: { enabled: true }, alipayTried: true,
      pay: { cfg: null, cfgTried: false, cfgErr: null, cur: '', tax: null, ali: null, aliTried: false, aliErr: null, alid: null, newQr: null, busy: null, curNote: null, taxNote: null, aliNote: null } },
    render: () => {}, reg: (n, f) => { CMD[n] = f; },
    push: (r) => { calls.pushes.push(r); ctx.state.stack.push({ route: r }); },
    pop: () => {}, showToast: (m) => calls.toasts.push(String(m)),
    recapNoMoney: () => !!opts.noMoney, featOn: () => true,
    api: (p) => new Promise((res, rej) => { calls.api.push({ p, res, rej }); }),
    apiWrite: (p, body, method) => new Promise((res, rej) => { calls.writes.push({ p, body: body == null ? body : plain(body), method: method || 'POST', res, rej }); }),
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, RegExp, encodeURIComponent, isNaN, parseInt,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  new vm.Script(SRC + '\nthis.ROUTE_CAP=ROUTE_CAP;this.canRoute=canRoute;this.PAY_CURRENCIES=PAY_CURRENCIES;').runInContext(ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  const html = () => ctx.SUBS.paycfg.render();
  return { ctx, CMD, calls, text, s: () => ctx.state.pay, html, t: () => text(html()) };
}
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
async function answer(h, p, v) {
  const c = h.calls.api.find((x) => x.p === p && !x.done);
  assert.ok(c, 'no read of ' + p + ' (have ' + h.calls.api.map((x) => x.p).join(', ') + ')');
  c.done = true; c.res(v); await tick();
}
async function fail(h, p, e) { const c = h.calls.api.find((x) => x.p === p && !x.done); c.done = true; c.rej(e); await tick(); }
const W = (h, i) => { const w = h.calls.writes[i]; assert.ok(w, 'no write #' + i); return w; };
async function open(cfg, ali, opts) {
  const h = mk(opts); h.CMD.payOpen(); h.html();
  await answer(h, '/config', cfg || CFG());
  await answer(h, '/alipay-manual', ali || ALI());
  return h;
}
/* The keys of an object literal that follows `anchor` inside a desktop function. */
function deskKeys(src, fnAnchor, bodyAnchor) {
  const f = block(src, fnAnchor);
  const obj = block(f.slice(f.indexOf(bodyAnchor)), '{');
  return [...obj.matchAll(/^\s*('?[\w.]+'?)\s*:/gm)].map((m) => m[1].replace(/'/g, ''));
}

// ─────────────────────────────────────────────────────────────────────────
section('1 · who may, and failing closed');
{
  it('the screen is the server\'s keys for these writes', () => {
    const h = mk();
    const want = plain(h.ctx.ROUTE_CAP.paycfg).sort();
    for (const k of ['currency', 'tax.enabled', 'tax.mode', 'tax.rateMicro', 'tax.label', 'tax.number', 'tax.shippingTaxable']) {
      assert.deepStrictEqual([...cap.configKeyCap(k)].sort(), want, k);
    }
    assert.deepStrictEqual([...cap.requiredCapFor('PUT', '/api/retail-admin/alipay-manual')].sort(), want);
  });
  it('closed when the keys are not known yet, without them, and on boards that see no money', () => {
    assert.strictEqual(mk({ caps: null }).ctx.canRoute('paycfg'), false, 'unknown keys open nothing');
    assert.strictEqual(mk({ caps: ['orders:view'] }).ctx.canRoute('paycfg'), false);
    assert.strictEqual(mk({ noMoney: true }).ctx.canRoute('paycfg'), false);
    assert.strictEqual(mk({ caps: ['delivery:view'] }).ctx.canRoute('paycfg'), true);
  });
  it('without the keys nothing is drawn to press and nothing is sent', async () => {
    const h = await open(null, null, { caps: ['orders:view'] });
    assert.ok(!h.t().includes('Save tax settings') && !/class="cta"/.test(h.html()));
    h.CMD.payCur('USD'); h.CMD.payTaxSave(); h.CMD.payAliSave(); h.CMD.payTaxFlip('enabled'); h.CMD.payAliFlip('enabled');
    assert.strictEqual(h.ctx.state.ask, null); assert.strictEqual(h.calls.writes.length, 0);
    assert.strictEqual(h.s().tax.enabled, true); assert.strictEqual(h.s().alid.enabled, true);
  });
  it('the doors: the Operations Alipay row, and Alipay\'s Set up on the web store page', () => {
    const ops = block(M, 'function screenOperations(){');
    assert.ok(ops.includes(`...(canRoute('paycfg')?{cmd:"APP.cmd('payOpen')",chev:true}:{})`));
    assert.ok(!M.includes("'Payment keys are set on desktop.'"), 'no payment setting is desktop-only now');
    assert.ok(block(M, 'function screenWebCfg(){').includes(`canRoute('paycfg')?\`<button class="btn2" style="width:auto;align-self:flex-start;padding:0 12px" onclick="APP.cmd('payOpen')">\${T('Set up','设置')}</button>\``));
    const g = block(M, 'function settingsGroupCard(');
    assert.ok(g.includes('r.cmd?`<button class="row" onclick="${r.cmd}"'), 'a row with cmd is a door');
  });
}

section('2 · reads');
{
  it('a failed read says so, and that card has no Save', async () => {
    const h = mk(); h.CMD.payOpen(); h.html();
    await answer(h, '/config', CFG());
    await fail(h, '/alipay-manual', new Error('HTTP 500'));
    const t = h.t();
    assert.ok(t.includes('Could not load this.') && t.includes('Save tax settings'));
    assert.ok(!t.includes('Enable manual Alipay'), 'the Alipay card is not drawn from nothing');
    h.CMD.payAliSave(); assert.strictEqual(h.calls.writes.length, 0, 'the record is replaced whole: no save from a card that never loaded');
    h.CMD.payRetryAli(); h.html(); await answer(h, '/alipay-manual', ALI());
    assert.ok(h.t().includes('Enable manual Alipay'));
    const c = mk(); c.CMD.payOpen(); c.html(); await fail(c, '/config', REFUSED()); await answer(c, '/alipay-manual', ALI());
    assert.ok(c.t().includes('You don’t have permission for this') && !c.t().includes('Save tax settings'));
    c.CMD.payRetryCfg(); c.html(); assert.strictEqual(c.calls.api.filter((x) => x.p === '/config').length, 2);
  });
}

section('3 · currency');
{
  it('the desktop\'s ten presets, field for field', () => {
    const presets = vm.runInNewContext(slice(MK, 'const CURRENCY_PRESETS = [', '];') + '];CURRENCY_PRESETS');
    const h = mk();
    const mine = plain(h.ctx.PAY_CURRENCIES).map(({ code, symbol, decimals, position }) => ({ code, symbol, decimals, position }));
    assert.deepStrictEqual(mine, plain(presets).map(({ code, symbol, decimals, position }) => ({ code, symbol, decimals, position })));
    for (const p of plain(presets).slice(1)) assert.ok(h.ctx.PAY_CURRENCIES.some((x) => x.en === p.label), p.label);
  });
  it('a change asks first, from and to; then PUT /config {currency}', async () => {
    const h = await open();
    assert.ok(h.html().includes('<option value="CNY" selected>Chinese Yuan (¥)</option>'));
    h.CMD.payCur('CNY'); assert.strictEqual(h.ctx.state.ask, null, 'the same currency asks nothing');
    h.CMD.payCur('USD');
    const a = h.ctx.state.ask;
    assert.strictEqual(a.title, 'Display currency'); assert.strictEqual(a.danger, true); assert.strictEqual(a.confirmLabel, 'Save');
    assert.ok(h.text(a.body).includes('Chinese Yuan (¥) → US Dollar ($)') && h.text(a.body).includes('WeChat Pay and Alipay always charge in RMB'));
    assert.strictEqual(h.calls.writes.length, 0);
    a.run();
    const w = W(h, 0); assert.strictEqual(w.p, '/config'); assert.strictEqual(w.method, 'PUT');
    assert.deepStrictEqual(w.body, { currency: { code: 'USD', symbol: '$', decimals: 2, position: 'before' } });
    assert.ok(block(MK, 'function renderCurrencyControl(').includes("body: { currency: { code: p.code, symbol: p.symbol, decimals: p.decimals, position: p.position } }"));
    w.res({ success: true }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Currency saved']);
    assert.ok(h.t().includes('A $100.00 price is charged as $120.00'), 'the tax preview follows the currency');
  });
  it('a failure and a refusal stay in place', async () => {
    let h = await open(); h.CMD.payCur('JPY'); h.ctx.state.ask.run(); W(h, 0).rej(new Error('update_failed')); await tick();
    assert.ok(h.t().includes('Save failed: update_failed')); assert.deepStrictEqual(h.calls.toasts, []);
    h = await open(); h.CMD.payCur('JPY'); h.ctx.state.ask.run(); W(h, 0).rej(REFUSED()); await tick();
    assert.ok(h.t().includes('You don’t have permission for this'));
  });
}

section('4 · tax');
{
  it('the card from the read: the rate in percent, the chip, the desktop\'s preview', async () => {
    const h = await open();
    const t = h.t();
    assert.ok(t.includes('Tax 20%') && t.includes('Charge tax on orders') && t.includes('Rate %'));
    assert.ok(t.includes('A ¥100.00 price is charged as ¥120.00 — ¥20.00 of tax added at checkout.'));
    assert.ok(h.html().includes('value="20"') && h.html().includes('value="VAT"') && h.html().includes('value="GB123"'));
    h.CMD.payTaxMode('inclusive');
    assert.ok(h.t().includes('A ¥100.00 price stays ¥100.00 — of which ¥16.67 is tax, and ¥83.33 is yours.'));
    h.CMD.payTaxIn('rate', '0');
    assert.strictEqual(h.ctx.payTaxPreview(), 'A rate of zero charges no tax — the switch above stays on but nothing is added.');
    const off = CFG(); off.tax = {};
    const o = await open(off);
    assert.ok(o.t().includes('Tax Off') && !o.t().includes('Rate %'), 'off: the fields are folded away, as on the desktop');
    assert.ok(!o.html().includes("'payTaxIn','rate'"), 'no rate box while tax is off');
  });
  it('the desktop\'s two checks before anything is asked or sent', async () => {
    const h = await open();
    h.CMD.payTaxIn('rate', '200'); h.CMD.payTaxSave();
    assert.ok(h.t().includes('That rate is not a number between 0 and 100.')); assert.strictEqual(h.ctx.state.ask, null);
    h.CMD.payTaxIn('rate', ''); h.CMD.payTaxSave();
    assert.ok(h.t().includes('Set a rate above zero, or turn tax off.')); assert.strictEqual(h.ctx.state.ask, null);
    assert.strictEqual(h.calls.writes.length, 0);
  });
  it('Save asks first with the preview, then PUT /config with the seven tax keys', async () => {
    const h = await open();
    h.CMD.payTaxIn('rate', '8.875'); h.CMD.payTaxFlip('shipping'); h.CMD.payTaxIn('label_en', ' Sales tax '); h.CMD.payTaxIn('number', '');
    h.CMD.payTaxSave();
    const a = h.ctx.state.ask;
    assert.strictEqual(a.title, 'Save tax settings'); assert.strictEqual(a.danger, true);
    assert.ok(h.text(a.body).includes('A ¥100.00 price is charged as ¥108.88 — ¥8.88 of tax added at checkout.'));
    a.run();
    const w = W(h, 0); assert.strictEqual(w.p, '/config'); assert.strictEqual(w.method, 'PUT');
    assert.deepStrictEqual(w.body, { 'tax.enabled': true, 'tax.mode': 'exclusive', 'tax.rateMicro': 88750,
      'tax.label': { en: 'Sales tax', cn: '增值税' }, 'tax.number': '', 'tax.shippingTaxable': true });
    assert.deepStrictEqual(Object.keys(w.body), deskKeys(MK, 'async function saveTaxSettings(', 'const body = {'));
    w.res({ success: true }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Tax settings saved']);
  });
  it('turning tax off says so; the server\'s refusals in the desktop\'s words', async () => {
    const h = await open();
    h.CMD.payTaxFlip('enabled'); h.CMD.payTaxSave();
    assert.strictEqual(h.text(h.ctx.state.ask.body), 'Charge tax on orders: Off');
    h.ctx.state.ask.run();
    assert.strictEqual(W(h, 0).body['tax.enabled'], false); assert.strictEqual(W(h, 0).body['tax.rateMicro'], 200000, 'the rate is kept for next time');
    for (const [e, words] of [[CODE('bad_tax_rate'), 'That rate is not a number between 0 and 100.'], [CODE('bad_tax_mode'), 'Pick how prices are shown.'], [REFUSED(), 'You don’t have permission for this']]) {
      const f = await open(); f.CMD.payTaxSave(); f.ctx.state.ask.run(); W(f, 0).rej(e); await tick();
      assert.ok(f.t().includes(words), words);
    }
  });
}

section('5 · Alipay by QR code');
{
  it('the card from the read; the AI key is never drawn, only the server\'s mask', async () => {
    const h = await open();
    const html = h.html(), t = h.t();
    assert.ok(t.includes('✓ LIVE') && t.includes('Enable manual Alipay') && t.includes('Money lands in whatever account this收款码 belongs to.'));
    assert.ok(html.includes('src="data:image/png;base64,SAVEDQR"') && html.includes('value="哈素萌"') && html.includes('value="30"') && html.includes('value="120"'));
    assert.ok(html.includes('placeholder="sk-…abcd — leave blank to keep"'));
    assert.ok(!html.includes('LEAKED') && !JSON.stringify(h.s().alid).includes('LEAKED'));
    assert.ok(/<input type="password" value=""/.test(html), 'the key box is a password box, empty');
  });
  it('nothing changed: sent straight away, every field, no image, no key — the desktop\'s body', async () => {
    const h = await open();
    h.CMD.payAliSave();
    assert.strictEqual(h.ctx.state.ask, null);
    const w = W(h, 0); assert.strictEqual(w.p, '/alipay-manual'); assert.strictEqual(w.method, 'PUT');
    assert.deepStrictEqual(w.body, { enabled: true, account: '哈素萌', ocrEnabled: true, autoFlip: false, payeeMatch: '哈素萌, 玲', timeWindowMin: 30, proofAgeMin: 120 });
    assert.deepStrictEqual(Object.keys(w.body), deskKeys(OPS, 'async function saveAlipayManualInline(', 'const body = {'));
    w.res({ success: true }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Saved']);
    h.html(); assert.strictEqual(h.calls.api.filter((x) => x.p === '/alipay-manual').length, 2, 'read again');
    assert.strictEqual(h.ctx.state.alipay, null, 'and the Operations row with it');
  });
  it('a new image, a typed key and auto-mark on: asked first, each change named, the desktop\'s warnings, then sent', async () => {
    const h = await open();
    h.ctx.payAliSetQr('data:image/jpeg;base64,NEWQR');
    h.CMD.payAliIn('key', ' sk-ant-typed-secret '); h.CMD.payAliFlip('autoFlip'); h.CMD.payAliIn('win', '15');
    h.CMD.payAliSave();
    const a = h.ctx.state.ask, b = h.text(a.body);
    assert.strictEqual(a.danger, true); assert.strictEqual(a.title, 'Alipay manual收款 (静态收款码)');
    assert.ok(a.body.includes('src="data:image/jpeg;base64,NEWQR"'), 'the new code is shown before it goes live');
    assert.ok(b.includes('Anthropic API key (sk-…): ••••••••') && !a.body.includes('typed-secret'), 'the key is named, never shown');
    assert.ok(b.includes('Pay within (minutes, 0 = no deadline): 15') && b.includes('Auto-mark paid on full match (no human review): On'));
    assert.ok(b.includes('Money lands in whatever account this收款码 belongs to.') && b.includes('a perfect fake screenshot can then auto-pass'));
    assert.strictEqual(h.calls.writes.length, 0);
    a.run();
    assert.deepStrictEqual(W(h, 0).body, { enabled: true, account: '哈素萌', ocrEnabled: true, autoFlip: true, payeeMatch: '哈素萌, 玲',
      timeWindowMin: 15, proofAgeMin: 120, anthropicKey: 'sk-ant-typed-secret', qr: 'data:image/jpeg;base64,NEWQR' });
    W(h, 0).res({ success: true }); await tick();
    assert.strictEqual(h.s().newQr, null);
    h.html(); await answer(h, '/alipay-manual', ALI());
    assert.strictEqual(h.s().alid.key, '', 'the typed key is dropped once saved');
  });
  it('switching the channel off asks, and says so', async () => {
    const h = await open();
    h.CMD.payAliFlip('enabled'); h.CMD.payAliSave();
    assert.ok(h.text(h.ctx.state.ask.body).startsWith('Enable manual Alipay: ✗ OFF'));
    assert.strictEqual(h.ctx.state.ask.danger, true);
  });
  it('auto-read off: its fields are greyed and cannot be typed in', async () => {
    const d = ALI(); d.ocrEnabled = false;
    const h = await open(null, d);
    assert.ok(/'payAliIn','payee',this.value\)/.test(h.html()));
    assert.ok((h.html().match(/ disabled /g) || []).length >= 4);
  });
  it('each refusal in the desktop\'s words, in place', async () => {
    for (const [e, words] of [[CODE('qr_required'), 'Upload a收款码 image first'], [CODE('image_too_big'), 'Image too large'],
      [CODE('ocr_key_required'), 'Enter the Anthropic API key to enable auto-read'], [CODE('bad_image'), 'Not a valid image'],
      [REFUSED(), 'You don’t have permission for this']]) {
      const h = await open(); h.CMD.payAliSave(); W(h, 0).rej(e); await tick();
      assert.ok(h.t().includes(words), words); assert.deepStrictEqual(h.calls.toasts, []);
    }
    assert.ok(block(OPS, 'async function saveAlipayManualInline(').includes("j.error === 'qr_required' ? 'Upload a收款码 image first · 请先上传收款码图片'"));
  });
}

section('6 · in Chinese');
{
  it('reads in Chinese', async () => {
    const h = await open(null, null, { lang: 'zh' });
    const t = h.t();
    for (const w of ['货币', '显示货币', '人民币 (¥)', '税费', '订单收取税费', '价格含税方式', '税率 %', '标价 ¥100.00 的商品结账收 ¥120.00', '保存税费设置',
      '支付宝手动收款', '✓ 已启用', '启用手动支付宝收款', '收款方名称(展示给顾客)', '自动识别付款截图', '保存']) assert.ok(t.includes(w), w);
    assert.strictEqual(h.ctx.SUBS.paycfg.title[1], '收款');
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
