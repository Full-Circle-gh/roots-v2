// WeChat Pay v3 and Alipay: the merchant config, the per-tenant pay context,
// request signing, the charge / status / refund calls, and the checks on the
// gateways' async callbacks. Moved out of routes/retail.js unchanged
// (decisions §477). The routes that use these, and the callback handlers that
// settle orders, stay in routes/retail.js.
//
// Pinned by scripts/test_payment_signing.js: every signature is checked
// against the gateways' documented formats with keys made for the test.
'use strict';

const crypto = require('crypto');
const { currentTenantId, ROOTS_TENANT_ID } = require('./tenant-db');
const { getTenantCreds } = require('./tenant-creds');
const { WECHAT_PAY_NOTIFY_URL, PAY_NOTIFY_ORIGIN } = require('./public-origin');
const { tenantBrandLabel } = require('./tenant-brand');

const WECHAT_PAY_REFUND_NOTIFY_URL = process.env.WECHAT_PAY_REFUND_NOTIFY_URL || 'https://rootskitchenchina.com/api/retail/payment/wechat/refund-callback';

// Prefix the WeChat out_trade_no so roots-v2's orders can never collide with
// the live OUT1N app's orders on the SHARED merchant ledger (both backends
// use one mch_id). The internal order_no stays unprefixed for display/search;
// only the value sent to WeChat + stored in retail_payments.out_trade_no
// carries this prefix, and the callback echoes it straight back.
const WX_OUT_TRADE_PREFIX = 'FC';
const wxOutTradeNo = (orderNo) => WX_OUT_TRADE_PREFIX + orderNo;

// User-Agent on outbound WeChat Pay v3 API calls. WeChat only requires a
// non-empty UA; it's server-to-server (no customer ever sees it), so we send a
// neutral PLATFORM identifier rather than any one tenant's brand (⑦ de-Roots).
const WX_PAY_USER_AGENT = 'WeChatPay-Node/1.0';

// ── Alipay (支付宝) config ───────────────────────────────────────────────
// Alipay uses the classic OpenAPI gateway (gateway.do) with RSA2 signing
// (SHA256withRSA) — a different scheme from WeChat Pay v3, so it gets its own
// signer/verifier below rather than reusing signMerchantRequest(). We run in
// "public key" mode (not the cert-chain mode): one Alipay public key verifies
// the async-notify signature.
//   ALIPAY_APP_ID       the Alipay open-platform app id
//   ALIPAY_PRIVATE_KEY  our app's RSA private key (PKCS#8). Stored in .env as a
//                       single line with literal \n escapes, OR as bare base64.
//   ALIPAY_PUBLIC_KEY   Alipay's public key (from the merchant console) — used
//                       to verify the async-notify signature. Bare base64 or PEM.
//   ALIPAY_NOTIFY_URL   public callback URL Alipay POSTs the trade result to.
//   ALIPAY_GATEWAY      override the gateway (defaults to production).
const ALIPAY_APP_ID      = process.env.ALIPAY_APP_ID || '';
const ALIPAY_GATEWAY     = process.env.ALIPAY_GATEWAY || 'https://openapi.alipay.com/gateway.do';
const ALIPAY_NOTIFY_URL  = process.env.ALIPAY_NOTIFY_URL || 'https://rootskitchenchina.com/api/retail/payment/alipay/callback';
const ALIPAY_PRIVATE_KEY = normalizePem(process.env.ALIPAY_PRIVATE_KEY || '', 'PRIVATE KEY');
const ALIPAY_PUBLIC_KEY  = normalizePem(process.env.ALIPAY_PUBLIC_KEY  || '', 'PUBLIC KEY');
// Same FC prefix as WeChat so our orders can never collide with the live OUT1N
// app on a shared Alipay merchant ledger; the async notify echoes it back.
const alipayOutTradeNo = (orderNo) => WX_OUT_TRADE_PREFIX + orderNo;

// Accept a key as either a ready PEM (with BEGIN/END lines) or as bare base64
// (how the Alipay console hands them out), and return a valid PEM. Also turns
// literal "\n" escapes from a single-line .env value into real newlines.
function normalizePem(raw, label) {
  let s = (raw || '').replace(/\\n/g, '\n').trim();
  if (!s) return '';
  if (s.includes('BEGIN')) return s;
  const body = (s.replace(/\s+/g, '').match(/.{1,64}/g) || []).join('\n');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

// ── Per-tenant payment resolution (Platform readiness ③) ───────────────────
// Every pay/refund/callback path resolves THIS request's WeChat Pay creds
// instead of the module-level env consts. Roots / unscoped → the env bundle
// (byte-for-byte the old values); a tenant → its OWN merchant, or devMode when
// unconfigured — a tenant NEVER borrows Roots' merchant (that would be the
// cross-tenant money leak this whole layer exists to prevent). The forward
// paths (create / refund / topup) run inside the request's tenant ALS scope,
// so currentTenantId() is the right tenant; the async callbacks instead carry
// the tenant id in the URL path (a WeChat→server POST has no session/header).
function payContext() {
  const c = getTenantCreds(currentTenantId());
  return { appId: c.wechat.appId, ...c.pay };  // {appId,mchId,apiV3Key,privateKey,serialNo,devMode}
}
function wechatNotifyUrl() {
  const tid = currentTenantId();
  return tid === ROOTS_TENANT_ID ? WECHAT_PAY_NOTIFY_URL
    : `${PAY_NOTIFY_ORIGIN}/api/retail/payment/wechat/callback/${tid}`;
}
function wechatRefundNotifyUrl() {
  const tid = currentTenantId();
  return tid === ROOTS_TENANT_ID ? WECHAT_PAY_REFUND_NOTIFY_URL
    : `${PAY_NOTIFY_ORIGIN}/api/retail/payment/wechat/refund-callback/${tid}`;
}
function payDescription(orderNo) { return `${tenantBrandLabel()} order ${orderNo}`; }

// Build the wx.requestPayment params from a prepay_id. Signature is over
// the 5-line message: appid, timestamp, nonce, package, signed with the
// merchant private key (RSA-SHA256 → base64). See WeChat Pay v3 docs.
// `p` is the resolved payContext() for this request (appId + privateKey).
function buildWxRequestPaymentParams(prepayId, p) {
  const timeStamp = String(Math.floor(Date.now() / 1000));
  const nonceStr  = crypto.randomBytes(16).toString('hex');
  const pkg       = 'prepay_id=' + prepayId;
  const message   = [p.appId, timeStamp, nonceStr, pkg, ''].join('\n');
  const paySign   = crypto.createSign('RSA-SHA256')
                          .update(message)
                          .sign(p.privateKey, 'base64');
  return { timeStamp, nonceStr, package: pkg, signType: 'RSA', paySign };
}

// Sign an outbound HTTP request to api.mch.weixin.qq.com per the v3 spec.
// Header: Authorization: WECHATPAY2-SHA256-RSA2048 mchid="...",nonce_str="...",
//         timestamp=...,serial_no="...",signature="..."
// `p` is the resolved payContext() (mchId + serialNo + privateKey) for the
// tenant whose merchant this request is signing against.
function signMerchantRequest(method, urlPath, body, p) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonceStr  = crypto.randomBytes(16).toString('hex');
  const bodyStr   = body ? JSON.stringify(body) : '';
  const message   = [method.toUpperCase(), urlPath, timestamp, nonceStr, bodyStr].join('\n') + '\n';
  const signature = crypto.createSign('RSA-SHA256')
                          .update(message)
                          .sign(p.privateKey, 'base64');
  return 'WECHATPAY2-SHA256-RSA2048 ' +
    `mchid="${p.mchId}",nonce_str="${nonceStr}",timestamp="${timestamp}",serial_no="${p.serialNo}",signature="${signature}"`;
}

// Generic WeChat Pay v3 JSAPI prepare. Returns a prepay_id. Shared by order
// checkout AND wallet top-ups so the signing/transport is identical for both;
// callers supply the charge specifics. `p` is the resolved payContext() for
// this request's tenant (own merchant, own AppID).
async function wechatJsapiPrepare({ outTradeNo, description, amountCents }, openid, p) {
  const url = 'https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi';
  const body = {
    appid:        p.appId,
    mchid:        p.mchId,
    description,
    out_trade_no: outTradeNo,
    notify_url:   wechatNotifyUrl(),
    amount:       { total: amountCents, currency: 'CNY' },
    payer:        { openid },
  };
  const auth = signMerchantRequest('POST', '/v3/pay/transactions/jsapi', body, p);
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Accept':        'application/json',
      'Authorization': auth,
      'User-Agent':    WX_PAY_USER_AGENT,
    },
    body: JSON.stringify(body),
  });
  const j = await resp.json();
  if (!j.prepay_id) {
    const err = new Error('wechat_pay_failed: ' + (j.message || JSON.stringify(j)));
    err.code = 'wechat_pay_failed';
    throw err;
  }
  return j.prepay_id;
}

// Real WeChat Pay JSAPI prepare for an ORDER. Returns { prepay_id }. `p` is the
// resolved payContext() for this request's tenant (own merchant, own AppID).
async function wechatPayCreate(order, openid, p) {
  return wechatJsapiPrepare({
    outTradeNo:  wxOutTradeNo(order.order_no),
    description: payDescription(order.order_no),
    amountCents: Math.round(Number(order.total) * 100),
  }, openid, p);
}

// ── WeChat Pay web channels (storefront, not the mini-app) ─────────────────
// The mini-app pays via JSAPI (wx.requestPayment) above. The browser storefront
// (shop.html) can't call JSAPI, so it uses two other v3 products, picked by the
// shopper's device:
//   • H5 (MWEB)  → mobile browser OUTSIDE WeChat: returns an h5_url the browser
//                  redirects to, which hands off to the WeChat app and bounces
//                  back to redirect_url when done.
//   • Native     → desktop browser: returns a code_url (weixin://) we render as
//                  a QR the shopper scans with their phone's WeChat.
// Both settle through the SAME async /wechat/callback as JSAPI (keyed on
// out_trade_no), so no new callback is needed — only these prepare calls.

// POST /v3/pay/transactions/h5 → returns h5_url. `redirectUrl` (optional) is
// where WeChat returns the browser after pay; `clientIp` is the shopper's IP
// (required by the H5 scene). `p` is the resolved payContext() for the tenant.
async function wechatH5Prepare({ outTradeNo, description, amountCents, clientIp, redirectUrl }, p) {
  const urlPath = '/v3/pay/transactions/h5';
  const body = {
    appid:        p.appId,
    mchid:        p.mchId,
    description,
    out_trade_no: outTradeNo,
    notify_url:   wechatNotifyUrl(),
    amount:       { total: amountCents, currency: 'CNY' },
    scene_info:   { payer_client_ip: clientIp || '127.0.0.1', h5_info: { type: 'Wap' } },
  };
  const auth = signMerchantRequest('POST', urlPath, body, p);
  const resp = await fetch('https://api.mch.weixin.qq.com' + urlPath, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'Accept': 'application/json',
      'Authorization': auth, 'User-Agent': WX_PAY_USER_AGENT,
    },
    body: JSON.stringify(body),
  });
  const j = await resp.json();
  if (!j.h5_url) {
    const err = new Error('wechat_h5_failed: ' + (j.message || JSON.stringify(j)));
    err.code = 'wechat_pay_failed';
    throw err;
  }
  // Append redirect_url so WeChat returns the shopper to our status page after
  // pay (WeChat requires it URL-encoded on the h5_url query string).
  if (redirectUrl) {
    return j.h5_url + (j.h5_url.includes('?') ? '&' : '?') + 'redirect_url=' + encodeURIComponent(redirectUrl);
  }
  return j.h5_url;
}

// POST /v3/pay/transactions/native → returns code_url (weixin://wxpay/...) for a
// desktop QR. `p` is the resolved payContext() for the tenant.
async function wechatNativePrepare({ outTradeNo, description, amountCents }, p) {
  const urlPath = '/v3/pay/transactions/native';
  const body = {
    appid:        p.appId,
    mchid:        p.mchId,
    description,
    out_trade_no: outTradeNo,
    notify_url:   wechatNotifyUrl(),
    amount:       { total: amountCents, currency: 'CNY' },
  };
  const auth = signMerchantRequest('POST', urlPath, body, p);
  const resp = await fetch('https://api.mch.weixin.qq.com' + urlPath, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'Accept': 'application/json',
      'Authorization': auth, 'User-Agent': WX_PAY_USER_AGENT,
    },
    body: JSON.stringify(body),
  });
  const j = await resp.json();
  if (!j.code_url) {
    const err = new Error('wechat_native_failed: ' + (j.message || JSON.stringify(j)));
    err.code = 'wechat_pay_failed';
    throw err;
  }
  return j.code_url;
}

// GET /v3/pay/transactions/out-trade-no/{no}?mchid=... → current trade_state.
// Poll-time fallback so a blocked/missed async notify still settles an H5/Native
// order (mirrors alipayTradeQuery). The signed url-path INCLUDES the query
// string per the v3 spec. Returns the trade_state string or null on not-found.
async function wechatTradeState(outTradeNo, p) {
  const urlPath = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(p.mchId)}`;
  const auth = signMerchantRequest('GET', urlPath, '', p);
  const resp = await fetch('https://api.mch.weixin.qq.com' + urlPath, {
    method: 'GET',
    headers: { 'Accept': 'application/json', 'Authorization': auth, 'User-Agent': WX_PAY_USER_AGENT },
  });
  if (resp.status === 404) return null;   // order not yet seen by WeChat
  const j = await resp.json();
  return j.trade_state || null;   // NOTPAY | SUCCESS | REFUND | CLOSED | USERPAYING | PAYERROR
}

// Real WeChat Pay v3 refund. Sends money back to the payer's original method.
// Docs: POST /v3/refund/domestic/refunds. Returns the refund result object
// { refund_id, status: 'SUCCESS'|'PROCESSING'|'CLOSED'|'ABNORMAL', ... }.
// amount.total MUST equal the original transaction total (in cents).
async function wechatPayRefund({ outTradeNo, outRefundNo, refundCents, totalCents, reason }) {
  const p = payContext();   // tenant whose merchant issued the original charge
  const urlPath = '/v3/refund/domestic/refunds';
  const body = {
    out_trade_no:  outTradeNo,
    out_refund_no: outRefundNo,
    notify_url:    wechatRefundNotifyUrl(),
    amount:        { refund: refundCents, total: totalCents, currency: 'CNY' },
  };
  if (reason) body.reason = String(reason).slice(0, 80);
  const auth = signMerchantRequest('POST', urlPath, body, p);
  const resp = await fetch('https://api.mch.weixin.qq.com' + urlPath, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Accept':        'application/json',
      'Authorization': auth,
      'User-Agent':    WX_PAY_USER_AGENT,
    },
    body: JSON.stringify(body),
  });
  const j = await resp.json();
  if (!j.refund_id) {
    const err = new Error('wechat_refund_failed: ' + (j.message || j.code || JSON.stringify(j)));
    err.code = 'wechat_refund_failed';
    err.wxCode = j.code || null;
    throw err;
  }
  return j;
}

// "WeChat has no such transaction." Raised when we try to refund an out_trade_no
// the gateway never charged — the signature of an order whose money was taken
// off-app (see hasGatewayRef). Matched on the v3 error code, with the message
// text as a fallback for the shapes that omit it.
function isMissingTransactionError(e) {
  if (!e) return false;
  const code = String(e.wxCode || '');
  if (code === 'ORDERNOTEXIST' || code === 'RESOURCE_NOT_EXISTS') return true;
  return /ORDERNOTEXIST|RESOURCE_NOT_EXISTS|订单不存在/i.test(String(e.message || ''));
}

// ─── Alipay API helpers ───────────────────────────────────────────────────
// Alipay's timestamp must be Beijing time (GMT+8), formatted "YYYY-MM-DD HH:mm:ss".
function alipayTimestamp() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

// The RSA2 sign base-string. Alipay treats the two directions ASYMMETRICALLY:
//   • Outbound request signing  → sign over all params except `sign`
//     (sign_type IS part of the signed string — the gateway includes it).
//   • Inbound async-notify verify → drop BOTH `sign` and `sign_type`
//     (matches the official rsaCheckV1 the notify uses).
// Getting this wrong yields isv.invalid-signature on requests (verified live
// against the gateway, 2026-06-16). Always drop empty values; sort ascending;
// join k=v with & using the RAW (un-encoded) values.
function alipaySignString(params, dropSignType = false) {
  return Object.keys(params)
    .filter(k => k !== 'sign' && (!dropSignType || k !== 'sign_type') && params[k] !== '' && params[k] != null)
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
}

// Call an Alipay OpenAPI method and return the inner business-response object
// (e.g. alipay_trade_precreate_response). Throws with err.code='alipay_failed'
// on a non-10000 result.
async function alipayApiCall(method, bizContent, { notifyUrl } = {}) {
  const params = {
    app_id:      ALIPAY_APP_ID,
    method,
    format:      'JSON',
    charset:     'utf-8',
    sign_type:   'RSA2',
    timestamp:   alipayTimestamp(),
    version:     '1.0',
    biz_content: JSON.stringify(bizContent),
  };
  if (notifyUrl) params.notify_url = notifyUrl;
  params.sign = crypto.createSign('RSA-SHA256')
                      .update(alipaySignString(params), 'utf8')
                      .sign(ALIPAY_PRIVATE_KEY, 'base64');

  const resp = await fetch(ALIPAY_GATEWAY, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body:    new URLSearchParams(params).toString(),
  });
  const j   = await resp.json();
  const biz = j[method.replace(/\./g, '_') + '_response'];
  if (!biz) {
    const err = new Error('alipay_bad_response: ' + JSON.stringify(j).slice(0, 200));
    err.code = 'alipay_failed';
    throw err;
  }
  if (biz.code && biz.code !== '10000') {
    const err = new Error(`alipay_${method}_failed: ${biz.code}/${biz.sub_code || ''} ${biz.sub_msg || biz.msg || ''}`);
    err.code = 'alipay_failed';
    err.aliCode = biz.code;
    err.aliSubCode = biz.sub_code;
    throw err;
  }
  return biz;
}

// alipay.trade.precreate → returns the qr_code string the customer scans in the
// Alipay app. The FC-prefixed out_trade_no ties the async notify back to us.
async function alipayPrecreate(order) {
  const biz = await alipayApiCall('alipay.trade.precreate', {
    out_trade_no: alipayOutTradeNo(order.order_no),
    total_amount: Number(order.total).toFixed(2),
    subject:      payDescription(order.order_no),
  }, { notifyUrl: ALIPAY_NOTIFY_URL });
  return biz.qr_code;
}

// Build a signed Alipay "page" redirect URL the browser navigates to. Unlike
// precreate (a server POST returning a QR string), alipay.trade.wap.pay (mobile
// web → hands off to the Alipay app) and alipay.trade.page.pay (desktop web →
// Alipay login page) are GET redirects: every param + the RSA2 sign rides on the
// gateway query string. Settles through the SAME async /alipay/callback (keyed
// on out_trade_no) plus the status-poll query fallback — same as precreate.
//   mobile === true  → alipay.trade.wap.pay
//   mobile === false → alipay.trade.page.pay
// `returnUrl` is the browser-return page after pay (sync redirect; the notify is
// the source of truth). Returns a fully-signed absolute URL.
function alipayPageRedirectUrl(order, { mobile, returnUrl } = {}) {
  const method = mobile ? 'alipay.trade.wap.pay' : 'alipay.trade.page.pay';
  const bizContent = {
    out_trade_no: alipayOutTradeNo(order.order_no),
    total_amount: Number(order.total).toFixed(2),
    subject:      payDescription(order.order_no),
    product_code: mobile ? 'QUICK_WAP_WAY' : 'FAST_INSTANT_TRADE_PAY',
  };
  const params = {
    app_id:      ALIPAY_APP_ID,
    method,
    format:      'JSON',
    charset:     'utf-8',
    sign_type:   'RSA2',
    timestamp:   alipayTimestamp(),
    version:     '1.0',
    notify_url:  ALIPAY_NOTIFY_URL,
    biz_content: JSON.stringify(bizContent),
  };
  if (returnUrl) params.return_url = returnUrl;
  params.sign = crypto.createSign('RSA-SHA256')
                      .update(alipaySignString(params), 'utf8')
                      .sign(ALIPAY_PRIVATE_KEY, 'base64');
  return ALIPAY_GATEWAY + '?' + new URLSearchParams(params).toString();
}

// alipay.trade.query → current trade_status for an out_trade_no. Used as a
// poll-time fallback so a blocked/missed async notify still settles the order.
async function alipayTradeQuery(outTradeNo) {
  try {
    const biz = await alipayApiCall('alipay.trade.query', { out_trade_no: outTradeNo });
    return biz.trade_status || null;   // WAIT_BUYER_PAY | TRADE_SUCCESS | TRADE_FINISHED | TRADE_CLOSED
  } catch (e) {
    if (e.aliSubCode === 'ACQ.TRADE_NOT_EXIST') return null; // nobody has paid yet
    throw e;
  }
}

// Verify an Alipay async-notify signature against Alipay's public key (RSA2).
function alipayVerifyNotify(params) {
  if (!ALIPAY_PUBLIC_KEY || !params || !params.sign) return false;
  try {
    return crypto.createVerify('RSA-SHA256')
                 .update(alipaySignString(params, true), 'utf8')   // notify: drop sign + sign_type
                 .verify(ALIPAY_PUBLIC_KEY, params.sign, 'base64');
  } catch (e) {
    console.error('[alipay/verify]', e.message);
    return false;
  }
}

// WeChat Pay v3 inbound-notify signature verification (Platform readiness ⑩).
// Defense-in-depth ON TOP OF the APIv3-key AES-256-GCM auth tag that already
// authenticates the decrypted payload (a forged body fails decipher.final()).
// The signed message is `timestamp\nnonce\nrawBody\n`; WeChat signs it with its
// PLATFORM key (RSA-SHA256) and sends it base64 in the Wechatpay-Signature
// header. We verify with the merchant's platform PUBLIC key.
//
// Returns:
//   'unconfigured' — no platform key for this tenant → caller keeps the
//                    GCM-only behaviour (so Roots + every current tenant are
//                    unaffected until an operator supplies the key). FAIL-OPEN.
//   'ok'           — signature + timestamp valid.
//   'fail'         — missing headers, stale timestamp (>5 min replay window),
//                    or a bad signature → caller 401s and WeChat retries.
const WXPAY_NOTIFY_MAX_SKEW_MS = 5 * 60 * 1000;
function verifyWxPayNotify(req, platformPubKeyRaw) {
  const key = normalizePem(platformPubKeyRaw || '', 'PUBLIC KEY');
  if (!key) return 'unconfigured';
  const ts    = req.get('Wechatpay-Timestamp');
  const nonce = req.get('Wechatpay-Nonce');
  const sig   = req.get('Wechatpay-Signature');
  if (!ts || !nonce || !sig) return 'fail';
  const skew = Math.abs(Date.now() - Number(ts) * 1000);
  if (!Number.isFinite(skew) || skew > WXPAY_NOTIFY_MAX_SKEW_MS) return 'fail';
  const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
  const message = `${ts}\n${nonce}\n${raw}\n`;
  try {
    const ok = crypto.createVerify('RSA-SHA256').update(message, 'utf8').verify(key, sig, 'base64');
    return ok ? 'ok' : 'fail';
  } catch (e) {
    console.error('[wechat-pay/verify]', e.message);
    return 'fail';
  }
}

module.exports = {
  WECHAT_PAY_REFUND_NOTIFY_URL, WX_OUT_TRADE_PREFIX, wxOutTradeNo, WX_PAY_USER_AGENT,
  ALIPAY_APP_ID, ALIPAY_GATEWAY, ALIPAY_NOTIFY_URL, ALIPAY_PRIVATE_KEY, ALIPAY_PUBLIC_KEY, alipayOutTradeNo,
  normalizePem, payContext, wechatNotifyUrl, wechatRefundNotifyUrl, payDescription,
  buildWxRequestPaymentParams, signMerchantRequest, wechatJsapiPrepare, wechatPayCreate,
  wechatH5Prepare, wechatNativePrepare, wechatTradeState, wechatPayRefund, isMissingTransactionError,
  alipayTimestamp, alipaySignString, alipayApiCall, alipayPrecreate, alipayPageRedirectUrl,
  alipayTradeQuery, alipayVerifyNotify, WXPAY_NOTIFY_MAX_SKEW_MS, verifyWxPayNotify,
};
