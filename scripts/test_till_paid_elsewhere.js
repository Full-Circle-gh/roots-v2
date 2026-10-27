#!/usr/bin/env node
/**
 * §502 — a QR order paid on the customer's phone is not left stuck on the till.
 *
 *   node scripts/test_till_paid_elsewhere.js
 *
 * Reported 2026-10-27, TC001860: the customer paid with WeChat Pay on their
 * phone, the till listed the order in the seconds before WeChat confirmed, the
 * cashier opened it, and Mark paid said "did not save" with the order stuck on
 * screen. It was paid; nothing had failed.
 *
 * Held here:
 *   1. The QR menu writes 'wechat' on an order paid in the page from the
 *      moment it is placed, so the till can tell it apart at once.
 *   2. Such an order is tagged on the list and does not knock.
 *   3. An open order that turns out paid, on opening it, on Mark paid, on
 *      Cancel, or because it left the list, comes off the till with
 *      "<number> · Payment confirmed", not "did not save".
 *   4. The till's Cancel names the status it saw (expect_from), and the
 *      server refuses the move from anything else, so the till can never
 *      cancel a paid order and refund it. A caller that omits it is unchanged.
 *   5. The words: four pairs, all copied whole from live sources.
 *
 * No browser, no server. The till's functions and the route's guard are cut out
 * of the shipped files and run here against stubs, so what passes is the code
 * that runs.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const till = read('public/till.html');
const retail = read('routes/retail.js');
const menu = read('routes/shop-menu.js');

let failures = 0;
const pending = [];
function check(label, fn) {
  pending.push(async () => {
    try { await fn(); console.log(`  ✓ ${label}`); }
    catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
  });
}
function section(name) { pending.push(async () => console.log('\n' + name)); }

// One top-level till function, by name, as source.
function fn(name) {
  const re = new RegExp('\\n  function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n');
  const m = till.match(re);
  if (!m) throw new Error('till.html has no function ' + name + '()');
  return m[0];
}
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

// The till's own STRINGS table and T(), so the words checked are the shipped ones.
const stringsSrc = (() => {
  const at = till.indexOf('  var STRINGS = {');
  const end = till.indexOf('\n  };\n', at);
  return till.slice(at, end + 5);
})();
function words(lang) {
  const ctx = { lang };
  vm.createContext(ctx);
  vm.runInContext(stringsSrc + '\nvar T = function (k) { var p = STRINGS[k]; return lang === "cn" ? p[1] : p[0]; };', ctx);
  return ctx;
}

// A till with one order on the list and, optionally, that order open in the rail.
function world(opts) {
  const o = opts || {};
  const w = { renders: 0, knocks: 0, calls: [], answer: {}, loads: 0 };
  const S = {
    storeId: 1, view: o.view || 'till', pend: o.pend || null, pendSeen: o.pendSeen || null,
    lines: o.recall ? [{ id: 1 }] : [], recall: o.recall || null, busy: false, err: '', note: '',
    cxArm: !!o.cxArm, wallet: o.wallet || null, pane: 'pend', paneTouched: false,
    sheetOpen: false, useP: false, useB: false, cashIn: '', disc: null, sel: null, customer: null,
  };
  w.S = S;
  const W = words('en');
  const ctx = {
    S, String, Number, Array, JSON, setTimeout: () => 0, clearTimeout: () => {},
    T: W.T, cuT: (en) => en, esc: (x) => String(x), money: (x) => String(x),
    render: () => { w.renders++; }, playKnock: () => { w.knocks++; },
    pendUrl: () => '/pend', autoPane: () => {}, holdNow: () => true,
    custRow: (x) => x, loadCounterVouchers: () => {}, cashGiven: () => 0,
    api: (url, init) => {
      w.calls.push({ url, init });
      const a = typeof w.answer === 'function' ? w.answer(url, init) : w.answer;
      return Promise.resolve(a);
    },
  };
  vm.createContext(ctx);
  vm.runInContext(
    ['noteArrivals', 'payingOnPhone', 'settledElsewhere', 'checkRecallStill', 'loadPend',
     'recall', 'confirmRecall', 'cancelOrder'].map(fn).join('\n') +
    '\nvar _noteTimer = null;',
    ctx);
  // loadPend is real for the list tests; the paths that merely refresh after
  // a settle are counted rather than run, so a test sees one answer at a time.
  w.ctx = ctx;
  return w;
}
const row = (id, pm) => ({ id, shop_order_code: id, total: 30, payment_method: pm || 'offline' });
const rec = (id) => ({ id, order_no: 'TC00' + id, code: id, name: '', total: 30, loading: false });

// ── 1. placed as WeChat ─────────────────────────────────────────────────────
section('The QR menu marks a WeChat Pay order from the moment it is placed');
check("the placeholder tender is 'wechat' for an in-page WeChat order, 'offline' otherwise", () => {
  // §496 rule 9 — inPageRail is 'wechat' or 'alipay' when the customer pays on
  // the page, null otherwise.
  assert.match(menu, /const inPageRail = !payInPage \? null : \(wantsAlipay \? 'alipay' : 'wechat'\);/);
  assert.match(menu, /const PLACEHOLDER_TENDER = inPageRail \|\| 'offline';/);
});
check('payInPage is decided before the order is written, and the INSERT uses the placeholder', () => {
  const decided = menu.indexOf('const payInPage = (wantsWechat || wantsAlipay) && !cv;');
  const placeholder = menu.indexOf('const PLACEHOLDER_TENDER = inPageRail');
  assert.ok(decided > 0 && placeholder > decided, 'payInPage must be decided first');
  const insert = menu.indexOf("orderNo, cv ? cv.customerId : null, 'pending_payment', PLACEHOLDER_TENDER,", placeholder);
  assert.ok(insert > placeholder, 'the INSERT no longer binds PLACEHOLDER_TENDER');
});

// ── 2. tagged, not rung for ─────────────────────────────────────────────────
section('On the list: tagged, and no knock');
check('a new order being paid on the phone does not knock; a counter one does', async () => {
  const w = world({ pendSeen: {} });
  w.answer = { success: true, data: [row(5, 'wechat')] };
  w.ctx.loadPend(); await settle();
  assert.strictEqual(w.knocks, 0, 'a WeChat Pay order knocked');
  assert.ok(w.S.pendSeen[5], 'it must still be remembered, so it never knocks later');
  w.answer = { success: true, data: [row(6, 'offline'), row(5, 'wechat')] };
  w.ctx.loadPend(); await settle();
  assert.strictEqual(w.knocks, 1, 'a counter order must still knock');
});
check('the row carries the WeChat Pay tag only when the customer chose it', () => {
  const r = fn('renderPend');
  // §496 rule 9 — and names the rail: Alipay for an Alipay order.
  assert.match(r, /payingOnPhone\(o\) \? '<i class="wx">' \+ esc\(T\(o\.payment_method === 'alipay' \? 'aliPay' : 'wxPay'\)\) \+ '<\/i>' : ''/);
});
check('an Alipay order is being paid on the phone too; an offline one is not', () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fn('payingOnPhone'), ctx);
  assert.strictEqual(ctx.payingOnPhone({ payment_method: 'alipay' }), true);
  assert.strictEqual(ctx.payingOnPhone({ payment_method: 'wechat' }), true);
  assert.strictEqual(ctx.payingOnPhone({ payment_method: 'offline' }), false);
});

// ── 3. paid elsewhere ───────────────────────────────────────────────────────
section('An order paid on the phone comes off the till, said as paid');
check('settledElsewhere: off the list, out of the rail, "<number> · Payment confirmed"', () => {
  const w = world({ pend: [row(12), row(13)], recall: rec(12), view: 'settle', wallet: 'cash' });
  w.ctx.settledElsewhere(12, 'delivered');
  assert.deepStrictEqual(w.S.pend.map((o) => o.id), [13]);
  assert.strictEqual(w.S.recall, null);
  assert.strictEqual(w.S.lines.length, 0);
  assert.strictEqual(w.S.wallet, null);
  assert.strictEqual(w.S.view, 'till');
  assert.strictEqual(w.S.note, '12 · Payment confirmed');
  assert.strictEqual(w.S.err, '');
});
check('cancelled and refunded are named as such', () => {
  const w = world({ pend: [row(12)], recall: rec(12) });
  w.ctx.settledElsewhere(12, 'cancelled');
  assert.strictEqual(w.S.note, '12 · Cancelled');
  const v = world({ pend: [row(14)] });
  v.ctx.settledElsewhere(14, 'refunded');
  assert.strictEqual(v.S.note, '14 · Refunded');
});
check('Mark paid refused as invalid_transition from delivered → Payment confirmed, not "did not save"', async () => {
  const w = world({ pend: [row(12)], recall: rec(12), view: 'settle', wallet: 'wechat_alipay_offline' });
  w.answer = (url) => url.indexOf('/status') > 0
    ? { success: false, error: 'invalid_transition', from: 'delivered', to: 'paid' }
    : { success: true, data: [] };
  w.ctx.confirmRecall({ recallPayload: () => ({ status: 'paid', pay_method: 'wechat_alipay_offline' }) });
  await settle();
  assert.strictEqual(w.S.err, '', 'it still says "' + w.S.err + '"');
  assert.strictEqual(w.S.note, '12 · Payment confirmed');
  assert.strictEqual(w.S.recall, null);
  assert.strictEqual(w.S.view, 'till');
});
check('any other refusal still says "did not save" and keeps the order open', async () => {
  const w = world({ pend: [row(12)], recall: rec(12), view: 'settle' });
  w.answer = { success: false, error: 'server_error' };
  w.ctx.confirmRecall({ recallPayload: () => ({ status: 'paid' }) });
  await settle();
  assert.strictEqual(w.S.err, 'That did not save. Nothing was created.');
  assert.ok(w.S.recall, 'the order must stay open for a second try');
});
check('opening an order that is already paid says so at once', async () => {
  const w = world({ pend: [row(12)] });
  w.answer = { success: true, data: { status: 'delivered', items: [] } };
  w.ctx.recall(12); await settle();
  assert.strictEqual(w.S.recall, null);
  assert.strictEqual(w.S.note, '12 · Payment confirmed');
});
check('opening an unpaid order still loads it', async () => {
  const w = world({ pend: [row(12)] });
  w.answer = { success: true, data: { status: 'pending_payment', total: 30,
    items: [{ product_id: 1, name_en: 'Latte', unit_price: 30, qty: 1 }] } };
  w.ctx.recall(12); await settle();
  assert.ok(w.S.recall && !w.S.recall.loading);
  assert.strictEqual(w.S.lines.length, 1);
  assert.strictEqual(w.S.note, '');
});
check('an open order that drops off the list is asked about by id, and closed if paid', async () => {
  const w = world({ pend: [row(12)], pendSeen: { 12: 1 }, recall: rec(12) });
  w.answer = (url) => url === '/pend'
    ? { success: true, data: [] }
    : { success: true, data: { status: 'delivered' } };
  w.ctx.loadPend(); await settle();
  assert.ok(w.calls.some((c) => c.url === '/api/retail-admin/orders/12'), 'the order was not re-read');
  assert.strictEqual(w.S.recall, null);
  assert.strictEqual(w.S.note, '12 · Payment confirmed');
});
check('…and left open if the server says it is still waiting', async () => {
  const w = world({ pend: [row(12)], pendSeen: { 12: 1 }, recall: rec(12) });
  w.answer = (url) => url === '/pend'
    ? { success: true, data: [] }
    : { success: true, data: { status: 'pending_payment' } };
  w.ctx.loadPend(); await settle();
  assert.ok(w.S.recall, 'an unpaid order was closed');
  assert.strictEqual(w.S.note, '');
});
check('no re-read while the order is on the list', async () => {
  const w = world({ pend: [row(12)], pendSeen: { 12: 1 }, recall: rec(12) });
  w.answer = { success: true, data: [row(12)] };
  w.ctx.loadPend(); await settle();
  assert.strictEqual(w.calls.length, 1);
});

// ── 4. cancel cannot refund ─────────────────────────────────────────────────
section("The till's Cancel only cancels an unpaid order");
check("the till's Cancel sends expect_from: 'pending_payment'", async () => {
  const w = world({ pend: [row(12)], recall: rec(12), cxArm: true });
  w.answer = { success: true };
  w.ctx.cancelOrder(); await settle();
  const body = JSON.parse(w.calls[0].init.body);
  assert.deepStrictEqual(body, { status: 'cancelled', expect_from: 'pending_payment' });
});
check('a cancel refused because it was paid says Payment confirmed, not "past the point"', async () => {
  const w = world({ pend: [row(12)], recall: rec(12), cxArm: true });
  w.answer = (url) => url.indexOf('/status') > 0
    ? { success: false, error: 'invalid_transition', from: 'delivered', to: 'cancelled' }
    : { success: true, data: [] };
  w.ctx.cancelOrder(); await settle();
  assert.strictEqual(w.S.note, '12 · Payment confirmed');
  assert.strictEqual(w.S.err, '');
  assert.strictEqual(w.S.recall, null);
});

// The route's guard, cut out of routes/retail.js and run.
const guardSrc = (() => {
  const head = "router.patch('/api/retail-admin/orders/:id/status'";
  const at = retail.indexOf(head);
  assert.ok(at >= 0, 'status route not found');
  const g = retail.indexOf('  if (!def.prev.includes(o.status)', at);
  assert.ok(g > at, 'the transition guard is not in the status route');
  const end = retail.indexOf('\n  }\n', g);
  return retail.slice(g, end + 4);
})();
function guard(prev, status, expectFrom) {
  let refused = null;
  const res = { status: (c) => ({ json: (b) => { refused = { code: c, body: b }; return 'sent'; } }) };
  new Function('def', 'o', 'status', 'expect_from', 'res', guardSrc + '\nreturn null;')(
    { prev }, { status: prev.cur }, status, expectFrom, res);
  return refused;
}
const CANCEL_PREV = ['pending_payment', 'paid', 'preparing', 'awaiting_restock'];
function prevWith(cur) { const p = CANCEL_PREV.slice(); p.cur = cur; return p; }
check('the server refuses a cancel that expected pending_payment on a paid order (409, from: paid)', () => {
  const r = guard(prevWith('paid'), 'cancelled', 'pending_payment');
  assert.ok(r, 'it was allowed');
  assert.strictEqual(r.code, 409);
  assert.strictEqual(r.body.error, 'invalid_transition');
  assert.strictEqual(r.body.from, 'paid');
});
check('…and allows it while the order is still pending_payment', () => {
  assert.strictEqual(guard(prevWith('pending_payment'), 'cancelled', 'pending_payment'), null);
});
check('a caller that omits expect_from keeps every transition it had (admin cancels a paid order)', () => {
  assert.strictEqual(guard(prevWith('paid'), 'cancelled', undefined), null);
});
check('a move outside the transition table is still refused', () => {
  const r = guard(prevWith('delivered'), 'cancelled', undefined);
  assert.ok(r && r.code === 409 && r.body.from === 'delivered');
});

// ── 5. words ────────────────────────────────────────────────────────────────
section('The words: four pairs, copied whole');
check('the till carries the four pairs, each live where it says it was copied from', () => {
  const W = words('cn');
  const pairs = [
    ['payConfirmed', 'Payment confirmed', '支付成功', 'routes/retail.js', /paid: *\{ en: 'Payment confirmed', *cn: '支付成功' \}/],
    ['cancelledSt', 'Cancelled', '已取消', 'public/retail-admin/26-print.js', /cancelled: \['Cancelled', '已取消'\]/],
    ['refundedSt', 'Refunded', '已退款', 'public/retail-admin/26-print.js', /refunded: \['Refunded', '已退款'\]/],
    ['wxPay', 'WeChat Pay', '微信支付', 'public/retail-admin/03-dashboard.js', /wechat: \['WeChat Pay', '微信支付'\]/],
    // §496 rule 9 — the same tag for an order being paid with Alipay.
    ['aliPay', 'Alipay', '支付宝', 'public/retail-admin/03-dashboard.js', /alipay: \['Alipay', '支付宝'\]/],
  ];
  for (const [k, en, cn, src, re] of pairs) {
    assert.strictEqual(W.T(k), cn, k + ' Chinese');
    assert.strictEqual(words('en').T(k), en, k + ' English');
    assert.match(read(src), re, k + ' is no longer live in ' + src);
  }
});

(async () => {
  for (const p of pending) await p();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
