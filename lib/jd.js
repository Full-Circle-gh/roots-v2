// JD Logistics — direct waybill creation via JOS (jos.jd.com).
//
// IMPORTANT: JD's logistics APIs live under TWO namespaces on JOS, NOT
// the `eclp.lop.*` namespace some older docs reference:
//   • jingdong.etms.*  — ETMS / 青龙 system (older, primary waybill flow)
//   • jingdong.ldop.*  — LDOP / Logistics Distribution Open Platform
//                        (newer tracking + intercept endpoints)
//
// Full daily workflow once credentials are wired:
//   1. jingdong.etms.range.check          — verify address is in JD coverage
//   2. jingdong.etms.waybillcode.get      — allocate a JD waybill number
//   3. jingdong.etms.waybill.send         — submit the order (青龙接单)
//      OR jingdong.ldop.waybill.receive   — newer submit endpoint
//   4. jingdong.ldop.receive.trace.get    — query tracking events
//   5. jingdong.ldop.receive.order.intercept — cancel a waybill
//
// Status: scaffold. Signing is implemented and matches JD's standard MD5
// algorithm. `createWaybill` is left as a guard until the user's JD
// account manager confirms which submit endpoint + payload shape applies
// to their merchant config (varies by carrier product and warehouse setup).
//
// Credentials live in process.env (hydrated from storefront_config at
// boot by database.js):
//   JD_APP_KEY        — app key from open.jd.com / lop.jd.com
//   JD_APP_SECRET     — app secret (used for signing only, never sent)
//   JD_ACCESS_TOKEN   — OAuth access token for the merchant account
//   JD_CUSTOMER_CODE  — 商家编码 from jdl.com 商家后台
//   JD_API_ENV        — 'production' (default) or 'sandbox'

const crypto = require('crypto');

// JD's gateway validates `timestamp` against its own clock (Beijing, UTC+8) and
// rejects anything skewed past a few minutes with error code 8. `toISOString()`
// is UTC, so on any server not set to Beijing time that's an 8-hour skew → every
// call fails. Build the wall-clock string in UTC+8 explicitly, independent of
// the host timezone.
function jdTimestamp() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

// Per-tenant integration creds (Platform readiness ⑤). Every JD fn takes an
// explicit `c` = { appKey, appSecret, accessToken, customerCode, env } resolved
// by the caller from getTenantCreds(tenantId).integrations.jd, so a tenant
// pushes waybills under ITS OWN JD merchant. `_env()` is the Roots/legacy
// fallback used only when no creds are passed; request handlers always pass
// explicit creds, so a tenant never falls back to Roots' env.
function _env() {
  return {
    appKey:       process.env.JD_APP_KEY || '',
    appSecret:    process.env.JD_APP_SECRET || '',
    accessToken:  process.env.JD_ACCESS_TOKEN || '',
    customerCode: process.env.JD_CUSTOMER_CODE || '',
    env:          process.env.JD_API_ENV || '',
  };
}

function jdEnabled(c) {
  c = c || _env();
  return !!(c.appKey && c.appSecret && c.accessToken);
}

function apiBase(c) {
  c = c || _env();
  return c.env === 'sandbox'
    ? 'https://api.jd.com/routerjson'    // sandbox: same host, separate app credentials
    : 'https://api.jd.com/routerjson';   // production
}

// JD's standard signing algorithm (used across LOP / POP / etc):
//   1. Drop the `sign` param if present
//   2. Sort remaining params alphabetically by key
//   3. Concatenate `app_secret + (k1 + v1) + (k2 + v2) + … + app_secret`
//   4. MD5(...).toUpperCase()
function signParams(params, appSecret) {
  const keys = Object.keys(params).filter(k => k !== 'sign').sort();
  const concat = keys.map(k => k + params[k]).join('');
  return crypto.createHash('md5').update(appSecret + concat + appSecret).digest('hex').toUpperCase();
}

// Generic JOS method invocation. `method` is e.g. 'jingdong.etms.waybillcode.get'
// or 'jingdong.ldop.waybill.receive'. `bizParams` is the method-specific
// param object (becomes JSON-stringified in `360buy_param_json`).
async function callJd(method, bizParams, c) {
  c = c || _env();
  if (!jdEnabled(c)) return { ok: false, error: 'jd_not_configured' };
  const params = {
    method,
    app_key:      c.appKey,
    access_token: c.accessToken,
    timestamp:    jdTimestamp(),
    format:       'json',
    v:            '2.0',
    sign_method:  'md5',
    '360buy_param_json': JSON.stringify(bizParams || {}),
  };
  params.sign = signParams(params, c.appSecret);

  const body = new URLSearchParams(params).toString();
  try {
    const r = await fetch(apiBase(c), {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { return { ok: false, error: 'non_json_response', raw: text.slice(0, 500) }; }
    // Gateway-level rejection (bad sign/token/method/param/clock) comes back as
    // `error_response` with code + zh_desc/en_desc. Surface code so callers
    // (pingJd) can tell an auth failure from a missing business param.
    if (j.error_response) {
      const er = j.error_response;
      return { ok: false, code: String(er.code), error: er.zh_desc || er.en_desc || ('jd_error_' + er.code), raw: er };
    }
    // JD wraps each method's result under `<method>_response` — but many LDOP/
    // ECLP methods misspell it `_responce`. Accept either.
    const base = method.replace(/\./g, '_');
    const inner = j[base + '_response'] || j[base + '_responce'] || j;
    if (inner && (inner.code === '0' || inner.code === 0 || inner.success === true)) {
      return { ok: true, data: inner };
    }
    return { ok: false, error: inner?.msg || inner?.zhDesc || inner?.zh_desc || inner?.errorCode || 'jd_error', raw: inner };
  } catch (e) {
    return { ok: false, error: 'jd_request_failed: ' + e.message };
  }
}

// Lightweight reachability check for the admin Integrations panel. We probe
// `jingdong.etms.range.check` — a read-only method this LOP product exposes
// (jingdong.time.get is NOT subscribed → code 15). The point is to validate
// the *credentials*, not the business call: any response that clears JD's
// auth gateway proves app_key/secret/access_token + signing are correct. A
// missing business param (e.g. customerCode → code 61) is therefore a PASS,
// reported with a note. Only genuine auth failures fail the ping.
async function pingJd(c) {
  c = c || _env();
  if (!jdEnabled(c)) return { ok: false, error: 'jd_not_configured' };
  const r = await callJd('jingdong.etms.range.check', {
    customerCode: c.customerCode || '',
    orderId:      'PINGCHK',
    goodsType:    1,
  }, c);
  if (r.ok) return { ok: true };
  // Codes/keywords that mean the credentials themselves are wrong.
  const AUTH_FAIL_CODES = new Set(['8', '15', '18', '19', '20', '21', '22', '23', '24']);
  const desc = String(r.error || '').toLowerCase();
  const looksAuth = /sign|secret|token|授权|签名|未授权|invalid app|access denied|ip/.test(desc);
  if (AUTH_FAIL_CODES.has(r.code) || looksAuth) return { ok: false, error: r.error };
  // Reached JD's business layer (e.g. "customerCode cannot be empty") → creds valid.
  return { ok: true, note: r.error };
}

// Two-step JD submit flow:
//   1. allocateWaybillCode() — POST etms.waybillcode.get to get a JD
//      waybill number we'll then attach to the order.
//   2. submitWaybill()       — POST etms.waybill.send (青龙接单) with
//      the allocated code + sender/recipient/items.
// We expose `createWaybill` that chains both — but the exact field set
// in step 2 varies by merchant config (carrier product code, warehouse,
// packing options) so it's left as a guard until the JD account
// manager returns the exact required fields.

async function allocateWaybillCode({ orderType = 0 } = {}, c) {
  c = c || _env();
  if (!jdEnabled(c)) return { ok: false, error: 'jd_not_configured' };
  if (!c.customerCode) return { ok: false, error: 'jd_customer_code_missing' };
  return callJd('jingdong.etms.waybillcode.get', {
    preNum:       1,
    customerCode: c.customerCode,
    orderType,
  }, c);
}

// Stub: turn a retail_orders row + items into the waybill.send payload.
// LEFT UNIMPLEMENTED until the user's JD account manager confirms the
// exact field set for their merchant config (which carrier product code,
// which sender warehouse, which packing options).
function buildWaybillSendPayload(/* order, items, waybillCode */) {
  // Typical fields per jingdong.etms.waybill.send docs (varies by merchant):
  //   customerCode:   process.env.JD_CUSTOMER_CODE
  //   thrOrderId:     order.order_no (our system's order #)
  //   deliveryId:     allocated JD waybill code from step 1
  //   senderName / senderMobile / senderAddress:  kitchen address
  //   senderProvince / senderCity / senderCounty: parsed from kitchenAddress
  //   receiverName / receiverMobile / receiverAddress: from order
  //   receiverProvince / receiverCity / receiverCounty: from address_json
  //   pickupStartTime / pickupEndTime: optional pickup window
  //   weight:         sum of items × shipping_weight (grams)
  //   packageCount:   1
  //   goodsType:      goods category code
  //   productCode / vendorCode: carrier product (varies by contract)
  throw new Error('buildWaybillSendPayload not implemented yet — confirm field set with JD account manager');
}

async function createWaybill(order, items, c) {
  c = c || _env();
  if (!jdEnabled(c)) return { ok: false, error: 'jd_not_configured' };
  // GUARD: full waybill flow is pending field-set confirmation. See
  // module header. Calling this today returns a soft no-op so the
  // admin UI can wire the button up but get a clear error message.
  return { ok: false, error: 'jd_create_waybill_not_implemented' };
  // eslint-disable-next-line no-unreachable
  const alloc = await allocateWaybillCode({}, c);
  if (!alloc.ok) return alloc;
  const waybillCode = alloc.data?.deliveryIdList?.[0] || alloc.data?.waybillCode;
  if (!waybillCode) return { ok: false, error: 'no_waybill_code_returned', raw: alloc.data };
  const payload = buildWaybillSendPayload(order, items, waybillCode);
  const send = await callJd('jingdong.etms.waybill.send', payload, c);
  if (!send.ok) return send;
  return { ok: true, waybillCode, raw: send.data };
}

// Query tracking events for a waybill via LDOP.
async function getTrace(waybillCode, c) {
  c = c || _env();
  if (!jdEnabled(c)) return { ok: false, error: 'jd_not_configured' };
  return callJd('jingdong.ldop.receive.trace.get', {
    waybillCode,
    customerCode: c.customerCode,
  }, c);
}

// Map a jingdong.ldop.receive.trace.get result (r.data from getTrace) into the
// tracking-event shape the mini app stores — identical to what
// lib/tracking.parseKd100Callback emits: newest-first array of
// { time, description_cn, location, status_code }, plus a `delivered` flag.
// This lets JD waybills flow through the SAME mini-app tracking UI as 快递100.
function normalizeTrace(data) {
  const arr = data && data.querytrace_result && data.querytrace_result.data;
  if (!Array.isArray(arr)) return { events: [], delivered: false };
  const events = arr.map(e => ({
    time:           String(e.opeTime || '').replace(/\//g, '-'),
    description_cn: e.opeRemark || e.opeTitle || '',
    location:       e.opeCityName || e.opeProvinceName || '',
    status_code:    null,
  }));
  // JD's array isn't reliably ordered; sort newest-first so events[0] is the
  // latest (the mini app + scenario classifier both assume that).
  events.sort((a, b) => (b.time || '').localeCompare(a.time || ''));
  // `妥投` is JD's canonical "delivered to recipient" op; the merchant-handoff
  // event (title 快递签收 / "货物已交付京东物流") must NOT count as delivered.
  const delivered = arr.some(e => e.opeTitle === '妥投' || /已送达/.test(e.opeRemark || ''));
  return { events, delivered };
}

// Cancel / intercept a waybill before pickup.
async function cancelWaybill(waybillCode, reason, c) {
  c = c || _env();
  if (!jdEnabled(c)) return { ok: false, error: 'jd_not_configured' };
  return callJd('jingdong.ldop.receive.order.intercept', {
    waybillCode,
    customerCode: c.customerCode,
    reason: reason || 'merchant_cancelled',
  }, c);
}

module.exports = {
  jdEnabled,
  callJd,
  pingJd,
  allocateWaybillCode,
  createWaybill,
  getTrace,
  normalizeTrace,
  cancelWaybill,
  signParams,           // exported for tests / debugging
};
