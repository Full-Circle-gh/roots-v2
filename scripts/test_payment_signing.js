#!/usr/bin/env node
/**
 * test_payment_signing.js — every payment message is signed over the exact
 * bytes the other side checks, and every inbound one is checked the same way.
 *
 *   node scripts/test_payment_signing.js
 *
 * WHAT IT GUARDS. The money paths sign and verify with RSA-SHA256 against
 * WeChat Pay v3 and Alipay. Nothing tested any of it. A mutation sweep of
 * routes/retail.js (2026-10-14) changed the line that builds WeChat's signed
 * message, and the filter that builds Alipay's sign string, and every suite
 * stayed green. The failure such a change causes is total and silent here:
 * the gateway rejects every charge, every refund and every status query, and
 * customers simply cannot pay.
 *
 * HOW. The real functions are lifted from the source (retailSource(), so they
 * are found in routes/retail.js or in lib/ after decisions §477 moves them) and
 * run with keys generated for the test, a pinned clock, and a stand-in for
 * fetch that records exactly what would have been sent. Every expected signed
 * string is written out HERE, from the gateways' documented formats, rather
 * than rebuilt with the code under test, so a change on both sides at once
 * cannot agree with itself.
 *
 *   1. WeChat Pay requests: charge, status query, refund, and the mini-app's
 *      pay-sheet signature.
 *   2. WeChat Pay callbacks: signature, replay window, tampering.
 *   3. Alipay: the sign string, a signed API call, a signed redirect, and the
 *      callback check (which drops sign_type, unlike the outbound side).
 *   4. A wallet refund in several parts: each part gets its own numbered row,
 *      and the parts never add up to more than was spent.
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { openTablesDb } = require('./test-support/memory-db');
const { retailSource } = require('./test-support/retail-source');

const ROOT = path.join(__dirname, '..');
const SRC = retailSource();
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');

function fnSrc(name) {
  const at = SRC.search(new RegExp(`^(async )?function ${name}\\(`, 'm'));
  assert.ok(at >= 0, `function ${name} not found`);
  return SRC.slice(at, SRC.indexOf('\n}', at) + 2);
}
function constSrc(name) {
  const m = new RegExp(`^const ${name} = .*;$`, 'm').exec(SRC);
  assert.ok(m, `const ${name} not found`);
  return m[0];
}

// ── keys, clock, and a fetch that records instead of sending ──────────────
const keyPair = () => crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const MERCHANT = keyPair();   // our WeChat Pay merchant key
const WX_PLATFORM = keyPair(); // WeChat's platform key, signs callbacks
const ALI_APP = keyPair();     // our Alipay app key
const ALI_GATEWAY = keyPair(); // Alipay's key, signs notifies

const NOW = Date.parse('2040-01-04T02:00:00.000Z');
const NOW_S = String(NOW / 1000);
class FixedDate extends Date {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
}

const sent = [];
let reply = {};
const fakeFetch = async (url, init = {}) => {
  sent.push({ url, ...init });
  return { status: 200, json: async () => reply };
};

const PAY = {
  appId: 'wx_app_test', mchId: '1900000001', serialNo: 'SERIAL0001',
  privateKey: MERCHANT.privateKey, apiV3Key: 'k'.repeat(32), devMode: false,
};

const LIFTED = ['normalizePem', 'buildWxRequestPaymentParams', 'signMerchantRequest', 'wechatJsapiPrepare',
  'wechatPayCreate', 'wechatTradeState', 'wechatPayRefund', 'verifyWxPayNotify', 'alipayTimestamp',
  'alipaySignString', 'alipayApiCall', 'alipayPageRedirectUrl', 'alipayVerifyNotify'];
const api = new Function(
  'crypto', 'Date', 'fetch', 'console', 'payContext', 'wechatNotifyUrl', 'wechatRefundNotifyUrl',
  'payDescription', 'wxOutTradeNo', 'alipayOutTradeNo', 'WX_PAY_USER_AGENT',
  'ALIPAY_APP_ID', 'ALIPAY_PRIVATE_KEY', 'ALIPAY_PUBLIC_KEY', 'ALIPAY_GATEWAY', 'ALIPAY_NOTIFY_URL',
  `${constSrc('WXPAY_NOTIFY_MAX_SKEW_MS')}\n${LIFTED.map(fnSrc).join('\n')}\nreturn { ${LIFTED.join(', ')} };`,
)(crypto, FixedDate, fakeFetch, { error() {}, warn() {}, log() {} }, () => PAY,
  () => 'https://shop.test/api/retail/payment/wechat/callback',
  () => 'https://shop.test/api/retail/payment/wechat/refund-callback',
  (no) => `Roots order ${no}`, (no) => 'FC' + no, (no) => 'FC' + no, 'WeChatPay-Node/1.0',
  '2021000000000001', ALI_APP.privateKey, ALI_GATEWAY.publicKey, 'https://openapi.alipay.test/gateway.do',
  'https://shop.test/api/retail/payment/alipay/callback');

const verifies = (pub, message, sig) =>
  crypto.createVerify('RSA-SHA256').update(message, 'utf8').verify(pub, sig, 'base64');
const sign = (priv, message) =>
  crypto.createSign('RSA-SHA256').update(message, 'utf8').sign(priv, 'base64');

// Authorization: WECHATPAY2-SHA256-RSA2048 mchid="…",nonce_str="…",timestamp="…",serial_no="…",signature="…"
function parseWxAuth(h) {
  const m = /^WECHATPAY2-SHA256-RSA2048 (.*)$/.exec(h || '');
  assert.ok(m, `not a WeChat Pay v3 Authorization header: ${h}`);
  const f = {};
  for (const [, k, v] of m[1].matchAll(/(\w+)="([^"]*)"/g)) f[k] = v;
  return f;
}
// WeChat Pay v3: METHOD \n URL path (with query) \n timestamp \n nonce \n body \n
const wxMessage = (method, urlPath, ts, nonce, body) => `${method}\n${urlPath}\n${ts}\n${nonce}\n${body}\n`;

const pending = [];
const section = (t) => pending.push(() => console.log('\n' + t));
const it = (name, fn) => pending.push(async () => {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
});
let pass = 0, fail = 0;

// ══ 1. WeChat Pay requests ═════════════════════════════════════════════════
section('1. WeChat Pay requests are signed over exactly what is sent');

it('a charge: the header names our merchant and certificate, at the pinned clock', async () => {
  sent.length = 0; reply = { prepay_id: 'wx_prepay_1' };
  assert.strictEqual(await api.wechatPayCreate({ order_no: 'TC001129', total: 19.99 }, 'openid-1', PAY), 'wx_prepay_1');
  const f = parseWxAuth(sent[0].headers.Authorization);
  assert.strictEqual(f.mchid, '1900000001');
  assert.strictEqual(f.serial_no, 'SERIAL0001');
  assert.strictEqual(f.timestamp, NOW_S);
  assert.match(f.nonce_str, /^[0-9a-f]{32}$/);
});
it('a charge: the signature checks against the body actually sent, in WeChat\'s five-line format', () => {
  const s = sent[0];
  const f = parseWxAuth(s.headers.Authorization);
  assert.strictEqual(s.url, 'https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi');
  assert.ok(verifies(MERCHANT.publicKey, wxMessage('POST', '/v3/pay/transactions/jsapi', f.timestamp, f.nonce_str, s.body), f.signature),
    'WeChat would answer SIGN_ERROR: the signature does not cover the bytes sent');
});
it('a charge: the same signature does not check against any other body (the check above means something)', () => {
  const s = sent[0];
  const f = parseWxAuth(s.headers.Authorization);
  const other = s.body.replace('"total":1999', '"total":1');
  assert.notStrictEqual(other, s.body);
  assert.ok(!verifies(MERCHANT.publicKey, wxMessage('POST', '/v3/pay/transactions/jsapi', f.timestamp, f.nonce_str, other), f.signature));
});
it('a charge: ¥19.99 is 1999 fen, not 1998 — the float is rounded, not truncated', () => {
  const b = JSON.parse(sent[0].body);
  assert.strictEqual(b.amount.total, 1999);
  assert.strictEqual(b.amount.currency, 'CNY');
  assert.strictEqual(b.out_trade_no, 'FCTC001129');
  assert.strictEqual(b.payer.openid, 'openid-1');
  assert.strictEqual(b.appid, 'wx_app_test');
  assert.strictEqual(b.mchid, '1900000001');
});
it('a status query: GET, the query string inside the signed path, and an empty body line', async () => {
  sent.length = 0; reply = { trade_state: 'SUCCESS' };
  assert.strictEqual(await api.wechatTradeState('FCTC001129', PAY), 'SUCCESS');
  const s = sent[0];
  const f = parseWxAuth(s.headers.Authorization);
  const urlPath = '/v3/pay/transactions/out-trade-no/FCTC001129?mchid=1900000001';
  assert.strictEqual(s.url, 'https://api.mch.weixin.qq.com' + urlPath);
  assert.ok(verifies(MERCHANT.publicKey, `GET\n${urlPath}\n${f.timestamp}\n${f.nonce_str}\n\n`, f.signature),
    'a status query would be refused, so a missed callback could never settle the order');
});
it('a refund: signed over the body sent, refund and total in fen, reason cut to 80 characters', async () => {
  sent.length = 0; reply = { refund_id: 'r1', status: 'PROCESSING' };
  await api.wechatPayRefund({ outTradeNo: 'FCTC001129', outRefundNo: 'RF1', refundCents: 500, totalCents: 1999, reason: 'x'.repeat(120) });
  const s = sent[0];
  const f = parseWxAuth(s.headers.Authorization);
  assert.strictEqual(s.url, 'https://api.mch.weixin.qq.com/v3/refund/domestic/refunds');
  assert.ok(verifies(MERCHANT.publicKey, wxMessage('POST', '/v3/refund/domestic/refunds', f.timestamp, f.nonce_str, s.body), f.signature),
    'WeChat would refuse every refund');
  const b = JSON.parse(s.body);
  assert.deepStrictEqual(b.amount, { refund: 500, total: 1999, currency: 'CNY' });
  assert.strictEqual(b.reason.length, 80);
  assert.strictEqual(b.notify_url, 'https://shop.test/api/retail/payment/wechat/refund-callback');
});
it('a refund WeChat rejects is an error carrying WeChat\'s own code', async () => {
  reply = { code: 'ORDERNOTEXIST', message: '订单不存在' };
  await assert.rejects(api.wechatPayRefund({ outTradeNo: 'FCX', outRefundNo: 'RF2', refundCents: 1, totalCents: 1 }),
    (e) => e.code === 'wechat_refund_failed' && e.wxCode === 'ORDERNOTEXIST');
});
it('the mini-app pay sheet: paySign covers appId, time, nonce and package, one per line', () => {
  const p = api.buildWxRequestPaymentParams('wx_prepay_1', PAY);
  assert.strictEqual(p.package, 'prepay_id=wx_prepay_1');
  assert.strictEqual(p.signType, 'RSA');
  assert.strictEqual(p.timeStamp, NOW_S);
  assert.ok(verifies(MERCHANT.publicKey, `wx_app_test\n${NOW_S}\n${p.nonceStr}\nprepay_id=wx_prepay_1\n`, p.paySign),
    'wx.requestPayment would fail on the phone with a signature error');
});

// ══ 2. WeChat Pay callbacks ════════════════════════════════════════════════
section('2. a WeChat Pay callback is believed only when WeChat signed it, recently');

const notifyReq = ({ ts = NOW_S, nonce = 'n0nce', body = '{"id":"EV-1","resource":{}}', sig, drop } = {}) => {
  const headers = {
    'Wechatpay-Timestamp': ts, 'Wechatpay-Nonce': nonce,
    'Wechatpay-Signature': sig != null ? sig : sign(WX_PLATFORM.privateKey, `${ts}\n${nonce}\n${body}\n`),
  };
  if (drop) delete headers[drop];
  return { get: (h) => headers[h], rawBody: Buffer.from(body, 'utf8'), body: JSON.parse(body) };
};

it('signed by WeChat over timestamp, nonce and the raw body → ok', () => {
  assert.strictEqual(api.verifyWxPayNotify(notifyReq(), WX_PLATFORM.publicKey), 'ok');
});
it('the platform key pasted as bare base64 (how consoles hand it out) still checks', () => {
  const bare = WX_PLATFORM.publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  assert.strictEqual(api.verifyWxPayNotify(notifyReq(), bare), 'ok');
});
it('one byte of the body changed after signing → fail', () => {
  const body = '{"id":"EV-1","resource":{}}';
  const req = notifyReq({ body, sig: sign(WX_PLATFORM.privateKey, `${NOW_S}\nn0nce\n${body.replace('EV-1', 'EV-2')}\n`) });
  assert.strictEqual(api.verifyWxPayNotify(req, WX_PLATFORM.publicKey), 'fail');
});
it('signed by someone else\'s key → fail', () => {
  const body = '{"id":"EV-1","resource":{}}';
  const req = notifyReq({ body, sig: sign(MERCHANT.privateKey, `${NOW_S}\nn0nce\n${body}\n`) });
  assert.strictEqual(api.verifyWxPayNotify(req, WX_PLATFORM.publicKey), 'fail');
});
it('four minutes old is accepted; six minutes old is a replay → fail', () => {
  assert.strictEqual(api.verifyWxPayNotify(notifyReq({ ts: String(NOW / 1000 - 240) }), WX_PLATFORM.publicKey), 'ok');
  assert.strictEqual(api.verifyWxPayNotify(notifyReq({ ts: String(NOW / 1000 - 300) }), WX_PLATFORM.publicKey), 'ok',
    'exactly five minutes is still inside the window');
  assert.strictEqual(api.verifyWxPayNotify(notifyReq({ ts: String(NOW / 1000 - 360) }), WX_PLATFORM.publicKey), 'fail');
  assert.strictEqual(api.verifyWxPayNotify(notifyReq({ ts: String(NOW / 1000 + 360) }), WX_PLATFORM.publicKey), 'fail');
});
it('no raw body captured: the parsed body, re-serialised, is what is checked', () => {
  const body = '{"id":"EV-1","resource":{}}';
  const req = notifyReq({ body });
  delete req.rawBody;
  assert.strictEqual(api.verifyWxPayNotify(req, WX_PLATFORM.publicKey), 'ok');
});
it('a missing signature, nonce or timestamp header → fail', () => {
  for (const drop of ['Wechatpay-Signature', 'Wechatpay-Nonce', 'Wechatpay-Timestamp']) {
    assert.strictEqual(api.verifyWxPayNotify(notifyReq({ drop }), WX_PLATFORM.publicKey), 'fail', drop);
  }
});
it('no platform key on file → unconfigured, so the caller keeps its existing check', () => {
  assert.strictEqual(api.verifyWxPayNotify(notifyReq(), ''), 'unconfigured');
  assert.strictEqual(api.verifyWxPayNotify(notifyReq(), null), 'unconfigured');
});

// ══ 3. Alipay ══════════════════════════════════════════════════════════════
section('3. Alipay: one sign string, sign_type in it going out, out of it coming in');

const ALI_PARAMS = { sign: 'SIG', sign_type: 'RSA2', b: '2', a: '1', empty: '', nothing: null, missing: undefined,
  zero: 0, biz_content: '{"out_trade_no":"FC1"}' };
it('outbound: sign dropped, empty values dropped, zero kept, keys sorted, raw values', () => {
  assert.strictEqual(api.alipaySignString(ALI_PARAMS),
    'a=1&b=2&biz_content={"out_trade_no":"FC1"}&sign_type=RSA2&zero=0');
});
it('inbound: sign_type dropped as well', () => {
  assert.strictEqual(api.alipaySignString(ALI_PARAMS, true),
    'a=1&b=2&biz_content={"out_trade_no":"FC1"}&zero=0');
});

it('an API call: posted form carries a sign that checks over every other field, sign_type included', async () => {
  sent.length = 0; reply = { alipay_trade_query_response: { code: '10000', trade_status: 'TRADE_SUCCESS' } };
  const biz = await api.alipayApiCall('alipay.trade.query', { out_trade_no: 'FCTC001129' });
  assert.strictEqual(biz.trade_status, 'TRADE_SUCCESS');
  const form = Object.fromEntries(new URLSearchParams(sent[0].body));
  assert.strictEqual(form.timestamp, '2040-01-04 10:00:00', 'Alipay wants Beijing time');
  const expected = 'app_id=2021000000000001&biz_content={"out_trade_no":"FCTC001129"}&charset=utf-8&format=JSON'
    + '&method=alipay.trade.query&sign_type=RSA2&timestamp=2040-01-04 10:00:00&version=1.0';
  assert.ok(verifies(ALI_APP.publicKey, expected, form.sign), 'Alipay would answer isv.invalid-signature');
});
it('an API call Alipay refuses is an error with Alipay\'s codes', async () => {
  reply = { alipay_trade_query_response: { code: '40004', sub_code: 'ACQ.TRADE_NOT_EXIST' } };
  await assert.rejects(api.alipayApiCall('alipay.trade.query', { out_trade_no: 'FCX' }),
    (e) => e.code === 'alipay_failed' && e.aliSubCode === 'ACQ.TRADE_NOT_EXIST');
});
it('a redirect to Alipay: the URL\'s sign checks over every other query field', () => {
  const url = new URL(api.alipayPageRedirectUrl({ order_no: 'TC001129', total: 19.9 }, { mobile: true, returnUrl: 'https://shop.test/r' }));
  const q = Object.fromEntries(url.searchParams);
  assert.strictEqual(q.method, 'alipay.trade.wap.pay');
  const expected = Object.keys(q).filter((k) => k !== 'sign').sort().map((k) => `${k}=${q[k]}`).join('&');
  assert.ok(expected.includes('sign_type=RSA2') && expected.includes('return_url=https://shop.test/r'));
  assert.ok(verifies(ALI_APP.publicKey, expected, q.sign), 'the shopper would land on an Alipay signature error page');
  assert.strictEqual(JSON.parse(q.biz_content).total_amount, '19.90');
});

const notifyParams = () => ({
  notify_id: 'N1', out_trade_no: 'FCTC001129', total_amount: '19.99', trade_status: 'TRADE_SUCCESS',
  app_id: '2021000000000001', sign_type: 'RSA2',
});
const notifySigned = (over) => {
  const p = notifyParams();
  // Alipay's notify signature leaves out sign and sign_type (rsaCheckV1).
  p.sign = sign(ALI_GATEWAY.privateKey,
    over || 'app_id=2021000000000001&notify_id=N1&out_trade_no=FCTC001129&total_amount=19.99&trade_status=TRADE_SUCCESS');
  return p;
};
it('a callback signed by Alipay over everything but sign and sign_type → believed', () => {
  assert.strictEqual(api.alipayVerifyNotify(notifySigned()), true);
});
it('a callback whose amount was changed after signing → refused', () => {
  const p = notifySigned(); p.total_amount = '0.01';
  assert.strictEqual(api.alipayVerifyNotify(p), false);
});
it('a callback signed with sign_type inside the string is not Alipay\'s format → refused', () => {
  const p = notifySigned('app_id=2021000000000001&notify_id=N1&out_trade_no=FCTC001129&sign_type=RSA2&total_amount=19.99&trade_status=TRADE_SUCCESS');
  assert.strictEqual(api.alipayVerifyNotify(p), false);
});
it('a callback with no sign, or no params at all → refused', () => {
  const p = notifyParams();
  assert.strictEqual(api.alipayVerifyNotify(p), false);
  assert.strictEqual(api.alipayVerifyNotify(null), false);
});

// ══ 4. A wallet refund in parts ════════════════════════════════════════════
section('4. a wallet refund in parts: one numbered row per part, never more than was spent');

it('three parts are rows :1, :2, :3; a fourth gives nothing and writes nothing', () => {
  const db = openTablesDb(DB_SRC, ['retail_customers', 'retail_topup_transactions']);
  db.prepare("INSERT INTO retail_customers (id, openid, balance) VALUES (5, 'o5', 0)").run();
  db.prepare(`INSERT INTO retail_topup_transactions (customer_id, amount, bonus_points, payment_method, status, out_trade_no)
              VALUES (5, -30, 0, 'order_redeem', 'success', 'orderspend:77')`).run();
  const reverseOrderBalance = new Function('tdb', 'console', `${fnSrc('reverseOrderBalance')}\nreturn reverseOrderBalance;`)(
    () => db, { error() {} });

  assert.strictEqual(reverseOrderBalance(77, 0), 0, 'a part of nothing is nothing');
  assert.strictEqual(reverseOrderBalance(78), 0, 'an order that spent no wallet money has nothing to return');
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM retail_topup_transactions WHERE payment_method = 'refund_reverse'").get().n, 0,
    'and neither writes a row, which would use up a number');
  assert.strictEqual(reverseOrderBalance(77, 10), 10);
  assert.strictEqual(reverseOrderBalance(77, 5), 5);
  assert.strictEqual(reverseOrderBalance(77), 15, 'the rest, and only the rest');
  assert.strictEqual(reverseOrderBalance(77), 0);

  const rows = db.prepare("SELECT out_trade_no, amount FROM retail_topup_transactions WHERE payment_method = 'refund_reverse' ORDER BY id").all()
    .map((r) => [r.out_trade_no, r.amount]);
  assert.deepStrictEqual(rows, [['orderrefund:77:1', 10], ['orderrefund:77:2', 5], ['orderrefund:77:3', 15]],
    'each part must carry its own number, or two refunds read as one in every trace');
  assert.strictEqual(db.prepare('SELECT balance FROM retail_customers WHERE id = 5').get().balance, 30);
});

(async () => {
  for (const step of pending) await step();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
