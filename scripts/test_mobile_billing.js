#!/usr/bin/env node
/**
 * §325 X13 — BILLING ON THE PHONE.
 *
 *   node scripts/test_mobile_billing.js
 *
 * The desktop's Billing page (public/backend-billing.html) on the phone: the
 * subscription and its alert, the plans, choosing one (select-plan, then
 * checkout), the WeChat QR's payment-status wait, the manual-transfer
 * instructions, and the invoices.
 *
 * What is asserted: every request's method, path and body, in the desktop's
 * order; choosing asks first and says what it does; the screen is the desktop
 * link's billing:view and choosing is billing:pay, neither drawn while the keys
 * are loading; refusals and failures render on the plan that was chosen, and
 * toasts report only success; the QR wait stops when the sheet closes or the
 * screen is left; empty, loading and failed reads; both languages. No browser —
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
const DESK = fs.readFileSync(path.join(ROOT, 'public/backend-billing.html'), 'utf8');

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
  slice(M, 'const PILL = {', '\n};') + '\n};',
  slice(M, 'const ROUTE_CAP={', '/* Fail-OPEN on null'),
  slice(M, 'const MCAN_MONEY_ONLY=', '/* NAMED FOR THE JOB'),
  '/*' + slice(M, '§325 X13 — BILLING ON THE PHONE', '/* §325 X13 ends */'),
].join('\n');

const REFUSED = () => { const e = new Error('refused'); e.refused = true; e.words = ['You don’t have permission for this', '你没有此操作的权限']; return e; };
const VIEW = (over) => Object.assign({ success: true,
  subscription: { id: 1, status: 'active', current_period_end: '2026-10-20 00:00:00', is_internal: 0 },
  plan: { code: 'starter', name: 'Starter', name_cn: '入门版', price_cents: 19900, currency: 'CNY', billing_interval: 'month', features: [] },
  invoices: [{ id: 7, invoice_no: 'INV-202609-2-AB12', period_start: '2026-09-20 00:00:00', period_end: '2026-10-20 00:00:00', amount_cents: 19900, currency: 'CNY', status: 'paid' },
    { id: 8, invoice_no: null, period_start: '2026-10-01 00:00:00', period_end: '2026-11-01 00:00:00', amount_cents: 49900, currency: 'CNY', status: 'open' }],
  daysLeft: 19, alert: 'none' }, over || {});
const PLANS = () => ({ success: true, plans: [
  { code: 'starter', name: 'Starter', name_cn: '入门版', price_cents: 19900, currency: 'CNY', billing_interval: 'month', features: [{ en: 'One store', cn: '一家门店' }] },
  { code: 'growth', name: 'Growth', name_cn: '成长版', price_cents: 49900, currency: 'CNY', billing_interval: 'month', features: ['Two stores'] },
  { code: 'yearly', name: 'Yearly', name_cn: '年付版', price_cents: 199900, currency: 'USD', billing_interval: 'year', features: [] },
] });

function mk(opts = {}) {
  const calls = { reads: [], writes: [], toasts: [], timers: [] };
  const CMD = {};
  const ctx = {
    LANG: opts.lang || 'en',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    SUBS: {},
    state: {
      caps: opts.caps === undefined ? ['billing:view', 'billing:pay'] : opts.caps,
      stack: [{ route: 'settings' }, { route: 'billing' }], ask: null,
      bill: { view: null, plans: null, tried: false, readErr: null, seq: 0, busy: null, err: null, ck: null, ckPlan: null, ckSeq: 0 },
    },
    render: () => {}, reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => calls.toasts.push(String(m)),
    tdWhen: (v) => String(v).slice(0, 10), _tdL: () => ({}),
    x1Err: (msg, retry) => `<div>${msg} <button onclick="APP.cmd('${retry}')">Try again</button></div>`,
    x1Loading: () => '<div>Loading…</div>',
    api: (p) => new Promise((res, rej) => { calls.reads.push({ p, res, rej }); }),
    apiRaw: (p) => new Promise((res, rej) => { calls.reads.push({ p, res, rej }); }),
    apiWrite: (p, body, method) => new Promise((res, rej) => { calls.writes.push({ p, body: body == null ? body : plain(body), method: method || 'POST', res, rej }); }),
    setTimeout: (f, ms) => { calls.timers.push({ f, ms }); return 0; },
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, RegExp, encodeURIComponent, isNaN,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  new vm.Script(SRC + '\nthis.ROUTE_CAP=ROUTE_CAP;').runInContext(ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  const screen = () => ctx.SUBS.billing.render();
  return { ctx, CMD, calls, text, screen, b: ctx.state.bill, st: ctx.state };
}
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
const fn = (h, name) => vm.runInContext(name, h.ctx);
const answer = async (h, p, v) => {
  const c = h.calls.reads.find((x) => x.p === p && !x.done);
  assert.ok(c, 'no read of ' + p + ' (have ' + h.calls.reads.map((x) => x.p).join(', ') + ')');
  c.done = true; c.res(v); await tick();
};
const fail = async (h, p, err) => {
  const c = h.calls.reads.find((x) => x.p === p && !x.done);
  assert.ok(c, 'no read of ' + p); c.done = true; c.rej(err); await tick();
};
const W = (h, i) => { const w = h.calls.writes[i]; assert.ok(w, 'no write #' + i); return w; };
async function loaded(opts, view, plans) {
  const h = mk(opts);
  h.screen();
  await answer(h, '/api/backend/billing', view || VIEW());
  await answer(h, '/api/backend/plans', plans || PLANS());
  return h;
}
const PROVIDERS = (wechat) => [{ id: 'manual', label: 'Manual', configured: true }, { id: 'wechat_native', label: 'WeChat', configured: !!wechat }];
async function choose(h, code, wechat) {
  h.CMD.billChoose(code); h.st.ask.run();
  W(h, 0).res({ success: true, invoice: { id: 41 }, providers: PROVIDERS(wechat) }); await tick();
}

// ─────────────────────────────────────────────────────────────────────────
section('1 · who reaches it, and who may choose');
{
  it('the screen is the desktop link\'s key, reached from Settings beside Brand', () => {
    const h = mk();
    assert.strictEqual(h.ctx.ROUTE_CAP.billing, 'billing:view');
    assert.ok(/<a href="\/backend\/billing" data-cap="billing:view">/.test(fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8')), 'the desktop link carries billing:view');
    const set = block(M, 'function screenSettings(){');
    assert.ok(set.includes("...(mCanKnown('billing:view')?[{label:T('Billing','账单'),cmd:\"APP.cmd('push','billing')\""), 'the Settings row waits for the keys');
    assert.ok(set.indexOf("APP.cmd('push','billing')") > set.indexOf("APP.cmd('push','brand')"), 'beside Brand');
    assert.strictEqual(mk({ caps: ['orders:view'] }).ctx.canRoute('billing'), false);
  });
  it('Choose is billing:pay, and is not drawn while the keys are loading or without it', async () => {
    let h = await loaded();
    assert.strictEqual((h.screen().match(/APP\.cmd\('billChoose'/g) || []).length, 2, 'every plan but the current one');
    for (const caps of [null, ['billing:view']]) {
      h = await loaded({ caps });
      const t = h.text(h.screen());
      assert.ok(t.includes('Growth') && t.includes('Current plan'), 'the plans still read');
      assert.ok(!h.screen().includes("APP.cmd('billChoose'"), 'no Choose for ' + JSON.stringify(caps));
      h.CMD.billChoose('growth'); await tick();
      assert.strictEqual(h.st.ask, null); assert.strictEqual(h.calls.writes.length, 0);
    }
  });
  it('the push reset reopens the screen fresh and drops any checkout', () => {
    assert.ok(/if\(route==='billing'\)\{ const b=state\.bill; b\.tried=false; b\.readErr=null; b\.err=null; b\.busy=null; b\.ck=null; b\.ckPlan=null; b\.ckSeq\+\+; \}/.test(block(M, 'function push(route)')));
  });
}

section('2 · reading it');
{
  it('loading, then the plan, its price, renewal and status', async () => {
    const h = mk();
    assert.ok(h.text(h.screen()).includes('Loading…'));
    await answer(h, '/api/backend/billing', VIEW());
    assert.ok(h.text(h.screen()).includes('Loading…'), 'both reads, not one');
    await answer(h, '/api/backend/plans', PLANS());
    const t = h.text(h.screen());
    for (const w of ['Starter', 'Active', 'Price', '¥199 / month', 'Renews', '2026-10-20 · 19 days left', 'Plans', 'Invoices']) assert.ok(t.includes(w), w);
  });
  it('the plans: price per interval in its currency, features in one language, the current one marked', async () => {
    const h = await loaded();
    const t = h.text(h.screen());
    assert.ok(t.includes('Growth ¥499 / month') && t.includes('USD 1,999 / year'));
    assert.ok(t.includes('One store') && !t.includes('一家门店') && t.includes('Two stores'));
    assert.ok(t.includes('Current plan'));
  });
  it('the invoices: number (or #id), period, amount, status in words', async () => {
    const h = await loaded();
    const t = h.text(h.screen());
    assert.ok(t.includes('INV-202609-2-AB12 Paid 2026-09-20 – 2026-10-20 ¥199'));
    assert.ok(t.includes('#8 Open 2026-10-01 – 2026-11-01 ¥499'));
  });
  it('empty answers look empty', async () => {
    const h = await loaded({}, VIEW({ subscription: null, plan: null, invoices: [] }), { success: true, plans: [] });
    const t = h.text(h.screen());
    for (const w of ['No subscription on file.', 'No plans available.', 'No invoices yet.']) assert.ok(t.includes(w), w);
  });
  it('an internal subscription is perpetual; a free plan says Free', async () => {
    const h = await loaded({}, VIEW({ subscription: { status: 'active', is_internal: 1, current_period_end: '2099-12-31 00:00:00' },
      plan: { code: 'internal', name: 'Internal', price_cents: 0, billing_interval: 'month' } }));
    const t = h.text(h.screen());
    assert.ok(t.includes('Perpetual (internal)') && t.includes('Free'));
  });
  it('each alert is the desktop\'s sentence', async () => {
    for (const [alert, w] of [['expiring', 'Your subscription ends in 19 day(s). Renew to avoid interruption.'],
      ['trial_ending', 'Your trial ends in 19 day(s).'],
      ['past_due', 'Payment is past due — please settle your latest invoice to keep access.'],
      ['suspended', 'This account is suspended for non-payment. Settle the outstanding invoice to restore access.']]) {
      const h = await loaded({}, VIEW({ alert }));
      assert.ok(h.text(h.screen()).includes(w), alert);
      assert.ok(DESK.includes(w.replace('19', "' + dl + '") + ' · '), alert + ' is the desktop\'s own');
    }
    const n = await loaded();
    assert.ok(!n.screen().includes('triangle-alert'), 'no alert, no banner');
  });
  it('status words for every state, and an unknown one shown as it came', async () => {
    for (const [st, w] of [['trialing', 'Trialing'], ['past_due', 'Past due'], ['grace', 'Grace period'], ['suspended', 'Suspended'], ['cancelled', 'Cancelled'], ['weird', 'weird']]) {
      const h = await loaded({}, VIEW({ subscription: { status: st, current_period_end: null } }));
      assert.ok(h.text(h.screen()).includes(w), st);
    }
  });
  it('a failed read says the desktop\'s words with a retry, which reads both again', async () => {
    const h = mk(); h.screen();
    await fail(h, '/api/backend/billing', new Error('HTTP 500'));
    await answer(h, '/api/backend/plans', PLANS());   // the half that answered changes nothing
    const t = h.text(h.screen());
    assert.ok(t.includes('Failed to load billing') && t.includes('Try again'));
    h.CMD.billRetry();
    await answer(h, '/api/backend/billing', VIEW());
    await answer(h, '/api/backend/plans', PLANS());
    assert.ok(h.text(h.screen()).includes('Starter'));
  });
  it('an answer that is not success is a failed read', async () => {
    const h = mk(); h.screen();
    await answer(h, '/api/backend/billing', { success: false });
    await answer(h, '/api/backend/plans', PLANS());
    assert.ok(h.text(h.screen()).includes('Failed to load billing'));
  });
  it('a refused read says why', async () => {
    const h = mk(); h.screen();
    await fail(h, '/api/backend/plans', REFUSED());
    assert.ok(h.text(h.screen()).includes('You don’t have permission for this'));
  });
}

section('3 · choosing a plan');
{
  it('asks first: the desktop\'s question, and that the account reads past due until paid', async () => {
    const h = await loaded();
    h.CMD.billChoose('growth');
    const a = h.st.ask;
    assert.strictEqual(String(a.title), 'Select the Growth plan?');
    assert.ok(String(a.body).startsWith('An invoice will be created for you to pay.'));
    assert.ok(String(a.body).includes('Until it is paid, billing shows the account as past due.'));
    assert.strictEqual(String(a.confirmLabel), 'Select plan');
    assert.ok(DESK.includes("'Select the ' + name + ' plan? An invoice will be created for you to pay. · 选择「' + name + '」套餐?系统将生成一张待支付发票。'"), 'split from the desktop\'s own');
    assert.strictEqual(h.calls.writes.length, 0);
  });
  it('select-plan {plan_code}, then checkout {invoice_id, provider:manual} when WeChat Pay is not configured', async () => {
    const h = await loaded();
    h.CMD.billChoose('growth'); h.st.ask.run();
    const w = W(h, 0);
    assert.strictEqual(w.p, '/api/backend/billing/select-plan'); assert.strictEqual(w.method, 'POST');
    assert.deepStrictEqual(w.body, { plan_code: 'growth' });
    assert.ok(h.text(h.screen()).includes('Saving…'));
    assert.ok(!/<button class="cta" style="width:100%" +onclick/.test(h.screen()), 'every Choose is disabled while it runs');
    h.CMD.billChoose('yearly'); assert.strictEqual(h.calls.writes.length, 1, 'a second choice sends nothing');
    w.res({ success: true, invoice: { id: 41 }, providers: PROVIDERS(false) }); await tick();
    const c = W(h, 1);
    assert.strictEqual(c.p, '/api/backend/billing/checkout'); assert.strictEqual(c.method, 'POST');
    assert.deepStrictEqual(c.body, { invoice_id: 41, provider: 'manual' });
  });
  it('the manual checkout: the instructions in one language, the reference, the desktop\'s note — and the screen reads again', async () => {
    const h = await loaded();
    await choose(h, 'growth', false);
    W(h, 1).res({ success: true, checkout: { kind: 'manual', reference: 'INV-202610-2-ZZ', instructions_en: 'Transfer ¥499.00 and send the receipt.', instructions_cn: '请转账 ¥499.00。' } });
    await tick();
    const t = h.text(fn(h, 'sheetBillCheckout')());
    for (const w of ['Payment', 'Growth', 'Transfer ¥499.00 and send the receipt.', 'Ref: INV-202610-2-ZZ', 'We’ll mark the invoice paid once the transfer is received.']) assert.ok(t.includes(w), w);
    assert.ok(!t.includes('请转账'));
    assert.strictEqual(h.calls.reads.filter((r) => r.p === '/api/backend/billing').length, 2, 'the new invoice shows');
    assert.strictEqual(h.calls.timers.length, 0, 'nothing to wait for on a transfer');
    assert.strictEqual(h.b.busy, null);
  });
  it('WeChat Pay when configured: the QR, the amount, and a wait that asks every 3 s until paid', async () => {
    const h = await loaded();
    await choose(h, 'growth', true);
    assert.deepStrictEqual(W(h, 1).body, { invoice_id: 41, provider: 'wechat_native' });
    W(h, 1).res({ success: true, checkout: { kind: 'wechat_native', qr_data_url: 'data:image/png;base64,AAA', amount_display: '¥499.00', invoice_id: 41 } });
    await tick();
    const html = fn(h, 'sheetBillCheckout')();
    assert.ok(html.includes('src="data:image/png;base64,AAA"'));
    const t = h.text(html);
    assert.ok(t.includes('¥499.00') && t.includes('Scan with WeChat to pay') && t.includes('Waiting for payment…'));
    assert.strictEqual(h.calls.timers.length, 1); assert.strictEqual(h.calls.timers[0].ms, 3000);
    h.calls.timers.shift().f();
    await answer(h, '/api/backend/billing/invoices/41/payment-status', { success: true, status: 'open' });
    assert.strictEqual(h.calls.timers.length, 1, 'asked again');
    h.calls.timers.shift().f();
    await answer(h, '/api/backend/billing/invoices/41/payment-status', { success: true, status: 'paid' });
    assert.deepStrictEqual(h.calls.toasts, ['Payment received ✓']);
    assert.strictEqual(h.b.ck, null, 'the sheet closes');
    assert.strictEqual(h.calls.timers.length, 0, 'and the wait ends');
  });
  it('a missing QR says so instead of an empty box', async () => {
    const h = await loaded();
    h.b.ck = { kind: 'wechat_native', qr_data_url: null, amount_display: '¥1.00', invoice_id: 1 };
    assert.ok(h.text(fn(h, 'sheetBillCheckout')()).includes('QR unavailable'));
  });
  it('closing the sheet, or leaving the screen, ends the wait', async () => {
    const h = await loaded();
    await choose(h, 'growth', true);
    W(h, 1).res({ success: true, checkout: { kind: 'wechat_native', qr_data_url: 'x', invoice_id: 41 } }); await tick();
    h.CMD.billCkClose();
    h.calls.timers.shift().f(); await tick();
    assert.ok(!h.calls.reads.some((r) => /payment-status/.test(r.p)), 'no ask after Close');
    const g = await loaded();
    await choose(g, 'growth', true);
    W(g, 1).res({ success: true, checkout: { kind: 'wechat_native', qr_data_url: 'x', invoice_id: 41 } }); await tick();
    g.st.stack.pop();
    g.calls.timers.shift().f(); await tick();
    assert.ok(!g.calls.reads.some((r) => /payment-status/.test(r.p)), 'no ask once the screen is left');
  });
  it('a failed ask is asked again, not shown as a failure', async () => {
    const h = await loaded();
    await choose(h, 'growth', true);
    W(h, 1).res({ success: true, checkout: { kind: 'wechat_native', qr_data_url: 'x', invoice_id: 41 } }); await tick();
    h.calls.timers.shift().f();
    await fail(h, '/api/backend/billing/invoices/41/payment-status', new Error('HTTP 502'));
    assert.strictEqual(h.calls.timers.length, 1);
    assert.deepStrictEqual(h.calls.toasts, []);
  });
  it('the server\'s refusal of a plan shows on that plan, in one language', async () => {
    const h = await loaded();
    h.CMD.billChoose('growth'); h.st.ask.run();
    W(h, 0).rej(new Error('Your account is on an internal plan, managed directly by Tacet. · 您的账户为内部套餐,由 Tacet 直接管理。')); await tick();
    const html = h.screen();
    assert.ok(h.text(html).includes('Your account is on an internal plan, managed directly by Tacet.'));
    assert.ok(!h.text(html).includes('您的账户'));
    assert.strictEqual(h.calls.writes.length, 1, 'no checkout after a refusal');
    assert.deepStrictEqual(h.calls.toasts, []);
    assert.strictEqual(h.b.busy, null);
  });
  it('a 403 says why; a plain failure says the desktop\'s fallback', async () => {
    const h = await loaded();
    h.CMD.billChoose('growth'); h.st.ask.run(); W(h, 0).rej(REFUSED()); await tick();
    assert.ok(h.text(h.screen()).includes('You don’t have permission for this'));
    const g = await loaded();
    g.CMD.billChoose('growth'); g.st.ask.run(); W(g, 0).res({ success: false }); await tick();
    assert.ok(g.text(g.screen()).includes('Could not select plan'));
  });
  it('a checkout the provider refuses says so with its words, and the new invoice still shows', async () => {
    const h = await loaded();
    await choose(h, 'growth', true);
    W(h, 1).rej(new Error('WeChat Pay error [SYSTEM_ERROR]')); await tick();
    assert.ok(h.text(h.screen()).includes('Checkout unavailable: WeChat Pay error [SYSTEM_ERROR]'));
    assert.strictEqual(h.b.ck, null);
    assert.strictEqual(h.calls.reads.filter((r) => r.p === '/api/backend/billing').length, 2);
    assert.deepStrictEqual(h.calls.toasts, []);
  });
  it('a signed-out session neither toasts nor paints an error', async () => {
    const h = await loaded();
    h.CMD.billChoose('growth'); h.st.ask.run(); W(h, 0).rej(new Error('auth')); await tick();
    assert.strictEqual(h.b.err, null); assert.deepStrictEqual(h.calls.toasts, []);
  });
  it('the sheet is mounted only over this screen, and Back closes it', () => {
    assert.ok(M.includes("if(state.bill&&state.bill.ck&&billOnTop()) html += layer('billck:'+state.bill.ck.invoice_id, sheetBillCheckout());"));
    assert.ok(block(M, 'function layers(){').includes('if(state.bill&&state.bill.ck&&billOnTop()) L.push(()=>{ state.bill.ck=null; state.bill.ckPlan=null; });'));
  });
}

section('4 · Chinese');
{
  it('the screen and the question read in Chinese, with Chinese plan names', async () => {
    const h = await loaded({ lang: 'zh' }, VIEW({ alert: 'past_due' }));
    const t = h.text(h.screen());
    for (const w of ['入门版', '活跃', '价格', '¥199 / 月', '到期', '剩余 19 天', '套餐', '成长版', '一家门店', '当前套餐', '选择', '发票', '已付', '未结', '账单逾期,请尽快支付以保持访问。']) assert.ok(t.includes(w), w);
    h.CMD.billChoose('growth');
    assert.strictEqual(String(h.st.ask.title), '选择「成长版」套餐?');
    assert.strictEqual(String(h.st.ask.confirmLabel), '选择套餐');
    h.b.ck = { kind: 'manual', reference: 'R1', instructions_en: 'Transfer', instructions_cn: '请转账' }; h.b.ckPlan = '成长版';
    const s = h.text(fn(h, 'sheetBillCheckout')());
    assert.ok(s.includes('支付') && s.includes('请转账') && s.includes('单号: R1') && s.includes('到账后我们将标记为已付。'));
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
