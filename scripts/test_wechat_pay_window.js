#!/usr/bin/env node
/**
 * The WeChat pay window and the late-payment safety net (decisions §478).
 *
 *   node scripts/test_wechat_pay_window.js
 *
 * The defect it pins: order TC001211 was cancelled unpaid by the 15-minute
 * reservation sweep while its WeChat charge stayed payable for hours. A payment
 * that then landed found no 'pending' row, was answered "OK", and the shop kept
 * the ¥15 with nobody told.
 *
 * BEHAVIOURAL — lib/wechat-pay-window.js runs as shipped against an in-memory
 * SQLite, with only ./tenant-db swapped for that handle. The gateway's three
 * charge functions are lifted from lib/payment-gateways.js and run against a
 * fake fetch, so what is checked is the body actually sent.
 * SOURCE — the wiring: every WeChat order charge passes the expiry, and the
 * callback looks for a late payment before it looks for a pending one. These
 * prove what is written, not what runs.
 *
 * No network, no keys on disk.
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { openTablesDb } = require('./test-support/memory-db');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const pending = [];
const section = (t) => pending.push(() => console.log('\n' + t));
const it = (name, fn) => pending.push(async () => {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
});

// ── the module under test, on an in-memory DB ──────────────────────────────
let db;
// The real table shapes, cut from database.js — not a hand-written copy.
const DB_SRC = read('database.js');
function freshDb() {
  db = openTablesDb(DB_SRC, ['retail_orders', 'retail_payments', 'retail_stock_reservations']);
  return db;
}
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename && parent.filename.endsWith(path.join('lib', 'wechat-pay-window.js'))
      && request === './tenant-db') {
    return { tdb: () => db };
  }
  return realLoad.call(this, request, parent, isMain);
};
const W = require('../lib/wechat-pay-window');
Module._load = realLoad;

// TC001211 as it stood: placed 11:13 Beijing (03:13 UTC), a 15-minute hold.
function seedTc001211({ orderStatus = 'cancelled', payStatus = 'cancelled' } = {}) {
  freshDb();
  db.prepare("INSERT INTO retail_orders (id, order_no, status, fulfillment_type, placed_at) VALUES (1211, 'TC001211', ?, 'delivery', '2026-10-15 03:13:00')").run(orderStatus);
  db.prepare("INSERT INTO retail_payments (order_id, method, amount, status, out_trade_no) VALUES (1211, 'wechat', 15, ?, 'FCTC001211')").run(payStatus);
  db.prepare("INSERT INTO retail_stock_reservations (store_id, product_id, qty, order_id, status, expires_at) VALUES (2, 1, 1, 1211, 'active', '2026-10-15 03:28:00')").run();
}

function harness({ refund }) {
  const calls = { refund: [], alerts: [], events: [], activity: [] };
  const deps = {
    wechatPayRefund: async (a) => { calls.refund.push(a); return refund(a, calls.refund.length); },
    sendAlert: (t) => { calls.alerts.push(t); return Promise.resolve(true); },
    logRefundEvent: (e) => calls.events.push(e),
    logActivity: (...a) => calls.activity.push(a),
  };
  return { calls, deps };
}
const TXN = { out_trade_no: 'FCTC001211', transaction_id: '4200000001', trade_state: 'SUCCESS', amount: { total: 1500 } };
const payRow = () => db.prepare("SELECT * FROM retail_payments WHERE out_trade_no = 'FCTC001211'").get();

section('1. The window: when WeChat stops taking the money');

it('time_expire is RFC 3339 in Beijing time, the shape WeChat documents', () => {
  assert.strictEqual(W.wechatTimeExpire(Date.UTC(2026, 9, 15, 3, 27, 0)), '2026-10-15T11:27:00+08:00');
});
it('a delivery order holding stock: the reservation decides, less one minute (TC001211 → 11:27)', () => {
  seedTc001211({ orderStatus: 'pending_payment', payStatus: 'pending' });
  assert.strictEqual(W.orderWechatTimeExpire(1211, { autoCancelHours: 6, counterMinutes: 120 }), '2026-10-15T11:27:00+08:00');
});
it('no reservation: the six-hour stale sweep decides', () => {
  assert.strictEqual(W.payDeadlineMs({ fulfillmentType: 'delivery', placedAt: '2026-10-15 03:13:00', reservationExpiresAt: null, autoCancelHours: 6, counterMinutes: 120 }),
    Date.UTC(2026, 9, 15, 9, 13, 0));
});
it('whichever sweep comes first wins', () => {
  assert.strictEqual(W.payDeadlineMs({ fulfillmentType: 'delivery', placedAt: '2026-10-15 03:13:00', reservationExpiresAt: '2026-10-15 12:00:00', autoCancelHours: 6, counterMinutes: 120 }),
    Date.UTC(2026, 9, 15, 9, 13, 0));
});
it('a counter order: the counter clock, and its reservation is ignored (the sweep exempts it)', () => {
  assert.strictEqual(W.payDeadlineMs({ fulfillmentType: 'counter', placedAt: '2026-10-15 03:13:00', reservationExpiresAt: '2026-10-15 03:28:00', autoCancelHours: 6, counterMinutes: 120 }),
    Date.UTC(2026, 9, 15, 5, 13, 0));
});
it('no clock at all: no expiry is sent, exactly as before', () => {
  assert.strictEqual(W.payDeadlineMs({ fulfillmentType: 'counter', placedAt: '2026-10-15 03:13:00', reservationExpiresAt: null, autoCancelHours: 6, counterMinutes: 0 }), null);
  assert.strictEqual(W.payDeadlineMs({ fulfillmentType: 'delivery', placedAt: '2026-10-15 03:13:00', reservationExpiresAt: null, autoCancelHours: 0, counterMinutes: 120 }), null);
});
it('a released or expired reservation does not count, only an active one', () => {
  seedTc001211({ orderStatus: 'pending_payment', payStatus: 'pending' });
  db.prepare("UPDATE retail_stock_reservations SET status = 'released'").run();
  assert.strictEqual(W.orderWechatTimeExpire(1211, { autoCancelHours: 6, counterMinutes: 120 }), '2026-10-15T17:12:00+08:00');
});
it('the same order asks for the same expiry every time (a second Pay tap is not a different charge)', () => {
  seedTc001211({ orderStatus: 'pending_payment', payStatus: 'pending' });
  const a = W.orderWechatTimeExpire(1211, { autoCancelHours: 6, counterMinutes: 120 });
  const b = W.orderWechatTimeExpire(1211, { autoCancelHours: 6, counterMinutes: 120 });
  assert.strictEqual(a, b);
});

section('2. Which payments are late');

it('an order still waiting for money is not late — the normal path settles it', () => {
  seedTc001211({ orderStatus: 'pending_payment', payStatus: 'pending' });
  assert.strictEqual(W.findLatePayment('FCTC001211'), null);
});
it('a sweep-cancelled order, its row flipped to cancelled: late (TC001211)', () => {
  seedTc001211();
  assert.strictEqual(W.findLatePayment('FCTC001211').order_no, 'TC001211');
});
it('a staff-cancelled order, its row left pending: late — it used to be marked paid and kept', () => {
  seedTc001211({ payStatus: 'pending' });
  assert.ok(W.findLatePayment('FCTC001211'));
});
it('a paid order cancelled and refunded through the cancel: not late — a re-sent notify changes nothing', () => {
  seedTc001211({ payStatus: 'refunded' });
  assert.strictEqual(W.findLatePayment('FCTC001211'), null);
});
it('a row already settled as paid: not this path', () => {
  seedTc001211({ payStatus: 'success' });
  assert.strictEqual(W.findLatePayment('FCTC001211'), null);
});

section('3. The safety net: refund in full, record it, tell the shop');

it('the ¥15 goes back: refund = what WeChat took, against the original charge', async () => {
  seedTc001211();
  const { calls, deps } = harness({ refund: () => ({ refund_id: 'RF1', status: 'PROCESSING' }) });
  const out = await W.refundLatePayment(W.findLatePayment('FCTC001211'), TXN, '{"x":1}', deps);
  assert.deepStrictEqual(out, { ok: true, retry: false });
  assert.strictEqual(calls.refund.length, 1);
  assert.strictEqual(calls.refund[0].outTradeNo, 'FCTC001211');
  assert.strictEqual(calls.refund[0].refundCents, 1500);
  assert.strictEqual(calls.refund[0].totalCents, 1500);
});
it('the payment row shows the money came in and went back', () => {
  const p = payRow();
  assert.strictEqual(p.status, 'refunded');
  assert.strictEqual(p.refunded_amount, 15);
  assert.strictEqual(p.transaction_id, '4200000001');
  assert.ok(p.raw_callback_json);
});
it('one refund event and one shop alert, in both languages, naming the order and amount', async () => {
  seedTc001211();
  const { calls, deps } = harness({ refund: () => ({ refund_id: 'RF1', status: 'SUCCESS' }) });
  await W.refundLatePayment(W.findLatePayment('FCTC001211'), TXN, '{}', deps);
  assert.strictEqual(calls.events.length, 1);
  assert.strictEqual(calls.events[0].amount, 15);
  assert.strictEqual(calls.alerts.length, 1);
  assert.match(calls.alerts[0], /已退款/);
  assert.match(calls.alerts[0], /refunded automatically/);
  assert.match(calls.alerts[0], /TC001211/);
  assert.match(calls.alerts[0], /¥15\.00/);
});
it('what WeChat took is refunded even when it differs from what we expected', async () => {
  seedTc001211();
  const { calls, deps } = harness({ refund: () => ({ refund_id: 'RF1', status: 'SUCCESS' }) });
  await W.refundLatePayment(W.findLatePayment('FCTC001211'), { ...TXN, amount: { total: 1499 } }, '{}', deps);
  assert.strictEqual(calls.refund[0].refundCents, 1499);
  assert.strictEqual(payRow().refunded_amount, 14.99);
});
it('a refund that fails asks WeChat to re-send, holds the row as money held, and tells the shop to refund by hand', async () => {
  seedTc001211();
  const { calls, deps } = harness({ refund: () => { throw new Error('wechat_refund_failed: SYSTEM_ERROR'); } });
  const out = await W.refundLatePayment(W.findLatePayment('FCTC001211'), TXN, '{}', deps);
  assert.deepStrictEqual(out, { ok: false, retry: true });
  assert.strictEqual(payRow().status, 'late_paid');
  assert.strictEqual(calls.events.length, 0);
  assert.strictEqual(calls.alerts.length, 1);
  assert.match(calls.alerts[0], /退款失败/);
  assert.match(calls.alerts[0], /by hand/);
});
it('ABNORMAL (merchant balance) is a failure, not a refund', async () => {
  seedTc001211();
  const { deps } = harness({ refund: () => ({ refund_id: 'RF1', status: 'ABNORMAL' }) });
  const out = await W.refundLatePayment(W.findLatePayment('FCTC001211'), TXN, '{}', deps);
  assert.strictEqual(out.retry, true);
  assert.strictEqual(payRow().status, 'late_paid');
});
it('the re-sent notify retries with the SAME refund number, so WeChat can never pay it twice', async () => {
  seedTc001211();
  const nos = [];
  const { deps } = harness({ refund: (a, n) => { nos.push(a.outRefundNo); if (n === 1) throw new Error('timeout'); return { refund_id: 'RF1', status: 'SUCCESS' }; } });
  await W.refundLatePayment(W.findLatePayment('FCTC001211'), TXN, '{}', deps);
  const row = W.findLatePayment('FCTC001211');
  assert.ok(row, 'a late_paid row is found again on the re-sent notify');
  await W.refundLatePayment(row, TXN, '{}', deps);
  assert.strictEqual(nos.length, 2);
  assert.strictEqual(nos[0], nos[1]);
  assert.strictEqual(payRow().status, 'refunded');
});
it('once refunded, a further notify finds nothing to do', () => {
  assert.strictEqual(W.findLatePayment('FCTC001211'), null);
});
it('two notifies racing: one event and one alert, not two', async () => {
  seedTc001211();
  const row = W.findLatePayment('FCTC001211');
  const { calls, deps } = harness({ refund: () => ({ refund_id: 'RF1', status: 'SUCCESS' }) });
  await Promise.all([W.refundLatePayment(row, TXN, '{}', deps), W.refundLatePayment(row, TXN, '{}', deps)]);
  assert.strictEqual(calls.events.length, 1);
  assert.strictEqual(calls.alerts.length, 1);
});
it('the alert composes no Chinese: every fragment is a live string', () => {
  const live = ['微信支付', '已取消', '已退款', '退款失败', '订单号', '金额', '请手动退款给顾客'];
  const text = W.lateAlertText({ order_no: 'TC001211' }, 15, true) + '\n' + W.lateAlertText({ order_no: 'TC001211' }, 15, false);
  const han = text.match(/[一-鿿]+/g) || [];
  for (const h of han) assert.ok(live.some((l) => l.includes(h)), `composed Chinese in the alert: ${h}`);
});

section('4. The gateway sends the expiry, and falls back once without it');

const GW = read('lib/payment-gateways.js');
function fnSrc(name) {
  const at = GW.search(new RegExp(`^(async )?function ${name}\\(`, 'm'));
  assert.ok(at >= 0, `function ${name} not found in lib/payment-gateways.js`);
  return GW.slice(at, GW.indexOf('\n}', at) + 2);
}
const MERCHANT = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const PAY = { appId: 'wx_app_test', mchId: '1900000001', serialNo: 'S1', privateKey: MERCHANT.privateKey, apiV3Key: 'k'.repeat(32), devMode: false };
const sent = [];
let replies = [];
const fakeFetch = async (url, init = {}) => { sent.push({ url, body: JSON.parse(init.body || '{}') }); const r = replies.shift() || {}; return { status: 200, json: async () => r }; };
const LIFTED = ['signMerchantRequest', 'retryWithoutExpiry', 'wechatJsapiPrepare', 'wechatPayCreate', 'wechatH5Prepare', 'wechatNativePrepare'];
const api = new Function('crypto', 'fetch', 'console', 'wechatNotifyUrl', 'payDescription', 'wxOutTradeNo', 'WX_PAY_USER_AGENT',
  `${LIFTED.map(fnSrc).join('\n')}\nreturn { ${LIFTED.join(', ')} };`,
)(crypto, fakeFetch, { warn() {}, error() {}, log() {} }, () => 'https://shop.test/cb', (n) => 'Order ' + n, (n) => 'FC' + n, 'UA');
const EXP = '2026-10-15T11:27:00+08:00';

it('JSAPI (mini app, QR menu): time_expire is in the body', async () => {
  sent.length = 0; replies = [{ prepay_id: 'p1' }];
  await api.wechatPayCreate({ order_no: 'TC001211', total: 15 }, 'openid', PAY, { timeExpire: EXP });
  assert.strictEqual(sent[0].body.time_expire, EXP);
});
it('H5 (phone browser): time_expire is in the body', async () => {
  sent.length = 0; replies = [{ h5_url: 'https://wx.test/h5' }];
  await api.wechatH5Prepare({ outTradeNo: 'FCTC001211', description: 'd', amountCents: 1500, timeExpire: EXP }, PAY);
  assert.strictEqual(sent[0].body.time_expire, EXP);
});
it('Native (desktop QR, guest pay): time_expire is in the body', async () => {
  sent.length = 0; replies = [{ code_url: 'weixin://x' }];
  await api.wechatNativePrepare({ outTradeNo: 'FCTC001211', description: 'd', amountCents: 1500, timeExpire: EXP }, PAY);
  assert.strictEqual(sent[0].body.time_expire, EXP);
});
it('no expiry given: none is sent, exactly as before', async () => {
  sent.length = 0; replies = [{ code_url: 'weixin://x' }];
  await api.wechatNativePrepare({ outTradeNo: 'FCTC001211', description: 'd', amountCents: 1500 }, PAY);
  assert.ok(!('time_expire' in sent[0].body));
});
it('WeChat refuses the charge with an expiry: asked once more without it, and the customer can still pay', async () => {
  sent.length = 0; replies = [{ code: 'OUT_TRADE_NO_USED' }, { prepay_id: 'p2' }];
  const id = await api.wechatPayCreate({ order_no: 'TC001211', total: 15 }, 'openid', PAY, { timeExpire: EXP });
  assert.strictEqual(id, 'p2');
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(sent[0].body.time_expire, EXP);
  assert.ok(!('time_expire' in sent[1].body));
});
it('a refusal without an expiry is still an error — the fallback runs once, not forever', async () => {
  sent.length = 0; replies = [{ code: 'PARAM_ERROR' }, { code: 'PARAM_ERROR' }];
  await assert.rejects(() => api.wechatNativePrepare({ outTradeNo: 'FCTC001211', description: 'd', amountCents: 1500, timeExpire: EXP }, PAY), /wechat_native_failed/);
  assert.strictEqual(sent.length, 2);
});

section('5. Wiring (source)');

const RETAIL = read('routes/retail.js');
const SHOP = read('routes/shop-menu.js');
it('every WeChat order charge in routes/retail.js passes the expiry (JSAPI, H5, Native, guest pay)', () => {
  assert.strictEqual((RETAIL.match(/timeExpire:\s*wechatPayExpiry\(/g) || []).length, 4);
  assert.strictEqual((RETAIL.match(/await wechatPayCreate\(/g) || []).length, 1);
  assert.strictEqual((RETAIL.match(/await wechatH5Prepare\(/g) || []).length, 1);
  assert.strictEqual((RETAIL.match(/await wechatNativePrepare\(/g) || []).length, 2);
});
it('the QR menu charge passes it too', () => {
  assert.strictEqual((SHOP.match(/timeExpire:\s*wechatPayExpiry\(/g) || []).length, 1);
  assert.strictEqual((SHOP.match(/await wechatJsapiPrepare\(/g) || []).length, 1);
});
it('the callback looks for a late payment BEFORE the pending lookup that used to miss it', () => {
  const late = RETAIL.indexOf('const late = findLatePayment(txn.out_trade_no);');
  const pend = RETAIL.indexOf("'SELECT order_id, amount FROM retail_payments WHERE out_trade_no = ? AND status = ?'");
  assert.ok(late > 0 && pend > 0 && late < pend);
});
it('a failed late refund answers WeChat non-200, so the notify comes back', () => {
  assert.ok(/if \(out\.retry\) return res\.status\(500\)/.test(RETAIL));
});

(async () => {
  for (const step of pending) await step();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
