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
    // 销售平台编码 (salePlat / cancel `source`) — JD-assigned, per the LDOP
    // waybill.receive examples (default 0030001 for this account).
    salePlat:     process.env.JD_SALE_PLAT || '0030001',
    env:          process.env.JD_API_ENV || '',
    // Cloud-print (面单云打印) gateway + token. The JDL platform (api.jdl.com) is
    // separate from the JOS gateway above and may issue its own access_token.
    jdlAccessToken: process.env.JD_JDL_ACCESS_TOKEN || '',
    jdlGateway:     process.env.JD_JDL_GATEWAY || 'https://api.jdl.com',
    // LOP-DN service-domain for cloud-print (ydy). JD must open external access
    // + provide the outward value; until set, callJdl falls back to ydy.jdl.com.
    jdlLopDn:       process.env.JD_JDL_LOP_DN || '',
  };
}

// JD's promiseTimeType selects the carrier product. Values from the account's
// LDOP examples; product names confirmed against JD's printed 时效产品 2026-06-15.
//   LL-HD-M=17 → 生鲜标快 (fresh, ground)   [confirmed on JDVC36827541911]
//   LL-SD-M=16 → 生鲜特快 (fresh, air)
//   ed-m-0001=1 → 京东标快 (ambient, ground) [confirmed]
//   ed-m-0002=2 → 京东特快 (ambient, express)
const JD_PRODUCTS = {
  'LL-HD-M':   { promiseTimeType: 17, goodsType: 2 },
  'LL-SD-M':   { promiseTimeType: 16, goodsType: 2 },
  'ed-m-0001': { promiseTimeType: 1 },
  'ed-m-0002': { promiseTimeType: 2 },
};

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

// Build the jingdong.ldop.waybill.receive payload from a normalized order.
// Field set per the account's LDOP examples (Example §1.1). `p` carries the
// already-resolved sender (merchant 发货地址) + receiver (the customer) + parcel
// details; product/timeliness comes from JD_PRODUCTS[product] or an explicit
// promiseTimeType. JD spells the volume field "vloumn" — kept verbatim.
function buildWaybillReceivePayload(p, c) {
  const prod = (p.product && JD_PRODUCTS[p.product]) || {};
  const promiseTimeType = p.promiseTimeType != null ? p.promiseTimeType : prod.promiseTimeType;
  const payload = {
    salePlat:      p.salePlat || c.salePlat || '0030001',
    customerCode:  c.customerCode,
    orderId:       String(p.orderId),
    senderName:    p.senderName,
    senderAddress: p.senderAddress,
    senderMobile:  p.senderMobile,
    receiveName:    p.receiveName,
    receiveAddress: p.receiveAddress,
    receiveMobile:  p.receiveMobile,
    packageCount:  p.packageCount || 1,
    weight:        p.weight,        // kg
    vloumn:        p.vloumn,        // cm³ (JD's spelling)
    description:   p.description || '',
    promiseTimeType,
  };
  // 保价 (declared-value insurance) — only sent when opted in.
  if (p.guaranteeValue) {
    payload.guaranteeValue = 1;
    payload.guaranteeValueAmount = p.guaranteeValueAmount || 0;
  }
  // goodsType is required for LL-* products, omitted for ed-m-*.
  const goodsType = p.goodsType != null ? p.goodsType : prod.goodsType;
  if (goodsType != null) payload.goodsType = goodsType;
  return payload;
}

// Create a JD waybill via LDOP jingdong.ldop.waybill.receive (single call —
// the waybill number `deliveryId` comes back in the response; there is NO
// separate allocate step for this account). Returns { ok, waybillCode,
// presort, raw } on success. A waybill created this way IS under our account,
// so jingdong.ldop.receive.trace.get returns its events for free.
async function createWaybill(p, c) {
  c = c || _env();
  if (!jdEnabled(c)) return { ok: false, error: 'jd_not_configured' };
  if (!c.customerCode) return { ok: false, error: 'jd_customer_code_missing' };
  const payload = buildWaybillReceivePayload(p, c);
  if (payload.promiseTimeType == null) return { ok: false, error: 'jd_product_missing' };
  const r = await callJd('jingdong.ldop.waybill.receive', payload, c);
  if (!r.ok) return r;
  const inner = r.data.receiveorderinfo_result || {};
  if (inner.resultCode !== 100 || !inner.deliveryId) {
    return { ok: false, error: inner.resultMessage || 'jd_waybill_no_deliveryId', raw: inner };
  }
  return { ok: true, waybillCode: inner.deliveryId, presort: inner.preSortResult || null, raw: inner };
}

// ─── Cloud print (面单云打印) — api.jdl.com ────────────────────────────────
// JD's electronic-waybill label printing. The label image isn't built here:
// pullData returns ENCRYPTED label data which the local "京东打印组件" (a Windows
// or macOS client on the PC wired to the label printer) renders + prints, after
// the admin page hands it the data over ws://127.0.0.1:9113. This module's only
// job is the server half: fetch that encrypted data for a created waybill.
//
// IMPORTANT: cloud-print lives on JD's NEWER "JDL" gateway (api.jdl.com), which
// is a different host + request convention than the JOS routerjson gateway
// callJd() uses above. It's REST-style (a path, JSON body) with app_key +
// access_token + an MD5 sign passed as query params.
//
// ⚠️ The exact JDL "LOP" signing canonicalization (param order, whether the JSON
// body folds into the signature, the timestamp format, any LOP-DN domain header)
// is account/SDK-specific. It is deliberately ISOLATED in callJdl() so that
// confirming it against JD's SDK once the merchant's api.jdl.com token is issued
// is a single-spot change. Gateway + token are config-driven (never hardcoded).

// 京东快递 (cpCode JD) official standard label templates, by paper size. The
// `tempUrl` the print component needs. Operators pick the size matching their
// label roll; 76×130 is the common thermal default. Full carrier list:
// https://cloud.jdl.com/#/open-business-document/access-guide/157/54628
const JD_PRINT_TEMPLATES = {
  '76x105':  'https://template-content.jd.com/template-oss?tempCode=jdkd76x105',
  '76x130':  'https://template-content.jd.com/template-oss?tempCode=jdkd76x130',
  '100x113': 'https://template-content.jd.com/template-oss?tempCode=jdkd100x113',
  '100x150': 'https://template-content.jd.com/template-oss?tempCode=jdkd100x150',
};

async function callJdl(path, bodyObj, c) {
  c = c || _env();
  const token = c.jdlAccessToken || c.accessToken;
  if (!c.appKey || !c.appSecret || !token) return { ok: false, error: 'jdl_not_configured' };
  const gateway = String(c.jdlGateway || 'https://api.jdl.com').replace(/\/+$/, '');
  const body = JSON.stringify(bodyObj == null ? {} : bodyObj);
  // LOP system params ride the query string. Verified against the live gateway
  // 2026-06-25: `timestamp` is an HTTP-date in GMT (toUTCString, e.g.
  // "Wed, 25 Jun 2026 12:34:56 GMT"), and the signature covers ONLY these query
  // params — NOT the JSON body: MD5(secret + sorted(k+v) + secret), uppercase.
  const params = {
    app_key:      c.appKey,
    access_token: token,
    timestamp:    new Date().toUTCString(),
    v:            '2.0',
  };
  const canonical = Object.keys(params).sort().map(k => k + params[k]).join('');
  params.sign = crypto.createHash('md5')
    .update(c.appSecret + canonical + c.appSecret).digest('hex').toUpperCase();
  const url = gateway + path + '?' + new URLSearchParams(params).toString();
  try {
    const r = await fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        // LOP-DN routes the call to the backend service domain. For 云打印
        // (pullData) the service is 'ydy', but JD serves it from an INTERNAL
        // domain by default ("ydy.jdl.com" → code 190 该服务域不允许外网访问). JD
        // must open the app's EXTERNAL (外网) access and give the outward LOP-DN;
        // set JD_JDL_LOP_DN to that value. Until then this best-guess errors 190.
        'LOP-DN': c.jdlLopDn || 'ydy.jdl.com',
      },
      body,
    });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { return { ok: false, error: 'non_json_response', raw: text.slice(0, 500) }; }
    return { ok: true, data: j };
  } catch (e) {
    return { ok: false, error: 'jdl_request_failed: ' + e.message };
  }
}

// Fetch the encrypted cloud-print label data for an already-created JD waybill.
// `waybillCode` is the JD deliveryId from createWaybill (jdWayBillCode). cpCode
// 'JD' = 京东快递; ewCustomerCode = the merchant's 青龙商家编码 (the same
// customerCode used for waybill creation). Returns { ok, printData, wayBillNo }.
async function getPrintData({ waybillCode, popFlag = 0, orderNo } = {}, c) {
  c = c || _env();
  if (!waybillCode) return { ok: false, error: 'jd_waybill_missing' };
  if (!c.customerCode) return { ok: false, error: 'jd_customer_code_missing' };
  const wb = { jdWayBillCode: String(waybillCode), popFlag };
  // popFlag=1 (京东商城/POP order) requires the sales-platform order number.
  if (popFlag === 1 && orderNo) wb.orderNo = String(orderNo);
  const objectId = (crypto.randomUUID ? crypto.randomUUID() : ('oid-' + Date.now() + '-' + waybillCode));
  const r = await callJdl('/PullDataService/pullData', [{
    cpCode:       'JD',
    objectId,
    wayBillInfos: [wb],
    parameters:   { ewCustomerCode: c.customerCode },
  }], c);
  if (!r.ok) return r;
  const d = r.data || {};
  // Outer code 1 = ok; 100 = bad ewCustomerCode; 101 = token needs authorizing.
  if (String(d.code) !== '1') return { ok: false, error: d.message || ('jdl_pulldata_' + d.code), raw: d };
  const first = (d.prePrintDatas || [])[0];
  if (!first || String(first.code) !== '1' || !first.perPrintData) {
    return { ok: false, error: (first && first.msg) || 'jdl_no_print_data', raw: d };
  }
  return { ok: true, printData: first.perPrintData, wayBillNo: first.wayBillNo || waybillCode, raw: d };
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

// Cancel a waybill before pickup — jingdong.ldop.delivery.provider.cancelWayBill.
// Success is responseDTO.statusCode === 0.
async function cancelWaybill(waybillCode, reason, operatorName, c) {
  c = c || _env();
  if (!jdEnabled(c)) return { ok: false, error: 'jd_not_configured' };
  const r = await callJd('jingdong.ldop.delivery.provider.cancelWayBill', {
    waybillCode,
    customerCode: c.customerCode,
    source:       c.salePlat || '0030001',
    cancelReason: reason || 'merchant_cancelled',
    operatorName: operatorName || 'system',
  }, c);
  if (!r.ok) return r;
  const dto = r.data.responseDTO || {};
  return dto.statusCode === 0 ? { ok: true } : { ok: false, error: dto.statusMessage || 'jd_cancel_failed', raw: dto };
}

// Intercept a waybill after pickup (in transit) — jingdong.ldop.receive.order.intercept.
// Success is resultInfo.stateCode === 100.
async function interceptWaybill(deliveryId, reason, c) {
  c = c || _env();
  if (!jdEnabled(c)) return { ok: false, error: 'jd_not_configured' };
  const r = await callJd('jingdong.ldop.receive.order.intercept', {
    vendorCode:      c.customerCode,
    deliveryId,
    interceptReason: reason || 'merchant_intercept',
  }, c);
  if (!r.ok) return r;
  const info = r.data.resultInfo || {};
  return info.stateCode === 100 ? { ok: true } : { ok: false, error: info.stateMessage || 'jd_intercept_failed', raw: info };
}

module.exports = {
  jdEnabled,
  callJd,
  pingJd,
  allocateWaybillCode,
  createWaybill,
  buildWaybillReceivePayload,
  JD_PRODUCTS,
  callJdl,
  getPrintData,
  JD_PRINT_TEMPLATES,
  getTrace,
  normalizeTrace,
  cancelWaybill,
  interceptWaybill,
  signParams,           // exported for tests / debugging
};
