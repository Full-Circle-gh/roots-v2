// 诺诺发票 (Nuonuo, by 航天信息/Aisino) — electronic-fapiao issuance via the
// Nuonuo Open Platform. This is the channel that lets the platform issue a
// LEGALLY VALID 电子发票 automatically and have Nuonuo email/SMS the PDF to the
// buyer itself (pushMode), so our server never sends email.
//
// ── Status: SCAFFOLD, dormant until credentials land ────────────────────────
// We have no Nuonuo account yet. Every function is a no-op that returns
// { ok:false, error:'nuonuo_not_configured' } until appKey/appSecret/salerTaxNum
// are saved AND the admin `fapiao.autoIssue` toggle is on. Nothing here fires on
// its own. The signing + request shapes below follow the documented Nuonuo Open
// Platform v1 spec; the EXACT signature concatenation and the
// taxClassificationCode (税收分类编码) per product MUST be confirmed against the
// Nuonuo sandbox before go-live — see VERIFY notes inline.
//
// Two-step issuance (the issue call is asynchronous at the tax bureau):
//   1. issueInvoice(order)  → nuonuo.electronic.invoice.commonInvoice
//        returns a 流水号 (serialNo) — the fapiao is NOT ready yet.
//   2. queryResult(serialNo) → nuonuo.electronic.invoice.queryInvoiceResult
//        poll until state=2 (开具完成); returns 发票号码 + pdfUrl/pictureUrl.
// Nuonuo pushes the PDF to the buyer's email/phone (pushMode) when issuance
// completes, so step 2 is only for OUR record (store number + pdf url).
//
// Credentials (per-tenant, via getTenantCreds(tid).integrations.nuonuo):
//   appKey       — 开放平台应用 appKey
//   appSecret    — 应用 appSecret (signing only, never sent in the body)
//   salerTaxNum  — 销方税号 (the issuing company's tax id)
//   env          — 'sandbox' (default until live) | 'production'

const crypto = require('crypto');

// Gateways. Sandbox uses a separate host + separate app credentials from prod.
const HOSTS = {
  sandbox:    'https://sandbox.nuonuocs.cn/open/v1/services',
  production: 'https://api.nuonuo.com/open/v1/services',
};
// OAuth2 client_credentials token endpoint (same for both envs; the app key is
// what's bound to sandbox vs prod).
const TOKEN_URL = {
  sandbox:    'https://open.nuonuo.com/accessToken',
  production: 'https://open.nuonuo.com/accessToken',
};

function nuonuoEnabled(c) {
  return !!(c && c.appKey && c.appSecret && c.salerTaxNum);
}

function host(c)     { return HOSTS[c && c.env === 'production' ? 'production' : 'sandbox']; }
function tokenUrl(c) { return TOKEN_URL[c && c.env === 'production' ? 'production' : 'sandbox']; }

// ── access_token cache ──────────────────────────────────────────────────────
// Keyed by appKey so multiple tenants don't clobber each other. Nuonuo tokens
// last a fixed window (expires_in seconds); we refresh a minute early.
const _tokenCache = new Map();   // appKey -> { token, expMs }

async function getAccessToken(c) {
  if (!nuonuoEnabled(c)) return { ok: false, error: 'nuonuo_not_configured' };
  const cached = _tokenCache.get(c.appKey);
  if (cached && cached.expMs > Date.now() + 60000) return { ok: true, token: cached.token };
  const body = new URLSearchParams({
    client_id:     c.appKey,
    client_secret: c.appSecret,
    grant_type:    'client_credentials',
  }).toString();
  try {
    const r = await fetch(tokenUrl(c), {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const j = await r.json().catch(() => null);
    if (!j || !j.access_token) return { ok: false, error: 'nuonuo_token_failed', raw: j };
    const expMs = Date.now() + (Number(j.expires_in || 0) * 1000);
    _tokenCache.set(c.appKey, { token: j.access_token, expMs });
    return { ok: true, token: j.access_token };
  } catch (e) {
    return { ok: false, error: 'nuonuo_token_request_failed: ' + e.message };
  }
}

// ── Request signing ───────────────────────────────────────────────────────
// Nuonuo's gateway carries auth in query params + an X-Nuonuo-Sign header.
// VERIFY against the live docs before go-live: the documented signature is
//   Base64( HMAC-SHA1( appSecret, appKey + senid + nonce + timestamp + token + bodyJson ) )
// but Nuonuo has shipped variants (with/without token, with/without body) — the
// sandbox 调试 page is the source of truth. Isolated here so a fix is one line.
function sign(c, { senid, nonce, timestamp, token, bodyJson }) {
  const data = c.appKey + senid + nonce + timestamp + token + bodyJson;
  return crypto.createHmac('sha1', c.appSecret).update(data, 'utf8').digest('base64');
}

// A senid must be unique per request (idempotency key on Nuonuo's side). The
// caller passes one derived from the order so a retry can't double-issue.
function _nonce() {
  // 10-digit random string; crypto-strong so concurrent calls don't collide.
  return String(crypto.randomInt(1e9, 1e10));
}

// Generic gateway call. `method` e.g. 'nuonuo.electronic.invoice.commonInvoice'.
// `senid` is the per-request idempotency id (we pass the order's). Returns the
// parsed result object on success.
async function callNuonuo(method, content, { senid }, c) {
  if (!nuonuoEnabled(c)) return { ok: false, error: 'nuonuo_not_configured' };
  const tok = await getAccessToken(c);
  if (!tok.ok) return tok;

  const nonce     = _nonce();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyJson  = JSON.stringify(content || {});
  const signature = sign(c, { senid, nonce, timestamp, token: tok.token, bodyJson });

  const qs = new URLSearchParams({
    senid, nonce, timestamp,
    appkey: c.appKey,
  }).toString();

  try {
    const r = await fetch(host(c) + '?' + qs, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json;charset=UTF-8',
        'X-Nuonuo-Sign': signature,
        'accessToken':   tok.token,
        'userTax':       c.salerTaxNum,
        'method':        method,
      },
      body: bodyJson,
    });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { return { ok: false, error: 'nuonuo_non_json', raw: text.slice(0, 500) }; }
    // Gateway envelope: { code:'E0000', describe:'操作成功', result:{...} }.
    // E0000 is success; anything else is an error with a describe message.
    if (j.code && j.code !== 'E0000') {
      return { ok: false, code: String(j.code), error: j.describe || ('nuonuo_' + j.code), raw: j };
    }
    return { ok: true, data: j.result != null ? j.result : j };
  } catch (e) {
    return { ok: false, error: 'nuonuo_request_failed: ' + e.message };
  }
}

// ── Issue (开具发票) ──────────────────────────────────────────────────────────
// `o` is a normalized order built by the caller:
//   { orderNo, senid, buyerName, buyerTaxNum, buyerEmail, buyerPhone,
//     invoiceLine, items:[{name, price, num, taxRate, taxCode}],
//     saler:{ taxNum, name, tel, address, account }, clerk }
// pushMode '0' = push to email (what we use — Nuonuo emails the PDF itself).
// Returns { ok, serialNo } — the fapiao is issued ASYNCHRONOUSLY; poll
// queryResult(serialNo) for the number + pdf url.
async function issueInvoice(o, c) {
  if (!nuonuoEnabled(c)) return { ok: false, error: 'nuonuo_not_configured' };
  const hasCompany = !!(o.buyerTaxNum && String(o.buyerTaxNum).trim());
  const invoiceDetail = (o.items || []).map((it) => ({
    goodsName:             it.name,
    num:                   String(it.num),
    price:                 Number(it.price).toFixed(2),
    taxRate:               String(it.taxRate),
    withTaxFlag:           '1',                 // unit price INCLUDES tax (our prices are tax-inclusive)
    taxClassificationCode: it.taxCode || '',    // 税收分类编码 — VERIFY per product before go-live
  }));
  const order = {
    buyerName:    o.buyerName,
    buyerTaxNum:  hasCompany ? o.buyerTaxNum : '',
    salerTaxNum:  o.saler.taxNum,
    salerTel:     o.saler.tel || '',
    salerAddress: o.saler.address || '',
    salerAccount: o.saler.account || '',
    orderNo:      o.orderNo,                    // our order_no — Nuonuo dedupes on it
    invoiceLine:  o.invoiceLine || 'pc',        // pc=增值税普通发票(电子) — VERIFY for 数电票 ('e')
    pushMode:     '0',                          // 0=email push (Nuonuo emails the PDF to buyer)
    email:        o.buyerEmail || '',
    buyerPhone:   o.buyerPhone || '',
    clerk:        o.clerk || '',
    invoiceDetail,
  };
  const r = await callNuonuo('nuonuo.electronic.invoice.commonInvoice', { order }, { senid: o.senid }, c);
  if (!r.ok) return r;
  // Result carries the serial (流水号) used to query the issued fapiao.
  const serialNo = r.data && (r.data.invoiceSerialNum || r.data.serialNo || r.data.fpqqlsh);
  if (!serialNo) return { ok: false, error: 'nuonuo_no_serial', raw: r.data };
  return { ok: true, serialNo, raw: r.data };
}

// ── Query result (查询开票结果) ───────────────────────────────────────────────
// Poll after issuing. Returns { ok, done, number, pdfUrl, raw }.
//   done=false  → still 开具中 (state 0/1); caller should poll again later.
//   done=true   → issued; number + pdfUrl are populated.
async function queryResult(serialNo, c) {
  if (!nuonuoEnabled(c)) return { ok: false, error: 'nuonuo_not_configured' };
  const r = await callNuonuo(
    'nuonuo.electronic.invoice.queryInvoiceResult',
    { serialNos: [serialNo] },
    { senid: 'q' + serialNo },
    c,
  );
  if (!r.ok) return r;
  // queryInvoiceResult returns an array; take the first row.
  const row = Array.isArray(r.data) ? r.data[0] : (r.data && (r.data[0] || r.data));
  if (!row) return { ok: false, error: 'nuonuo_no_result', raw: r.data };
  const state = String(row.status != null ? row.status : row.state);
  if (state !== '2') return { ok: true, done: false, state, raw: row };   // 0待开,1开具中,2成功,3失败
  return {
    ok:     true,
    done:   true,
    number: row.invoiceNo || row.fphm || '',
    code:   row.invoiceCode || row.fpdm || '',
    pdfUrl: row.pdfUrl || row.pictureUrl || row.invoiceUrl || '',
    raw:    row,
  };
}

// Lightweight credential check for the admin Integrations panel — proves
// appKey/appSecret can mint an access_token. A successful token mint means the
// credentials clear Nuonuo's auth even before any fapiao is issued.
async function pingNuonuo(c) {
  if (!nuonuoEnabled(c)) return { ok: false, error: 'nuonuo_not_configured' };
  const tok = await getAccessToken(c);
  return tok.ok ? { ok: true } : { ok: false, error: tok.error };
}

module.exports = {
  nuonuoEnabled,
  getAccessToken,
  callNuonuo,
  issueInvoice,
  queryResult,
  pingNuonuo,
  sign,                 // exported for sandbox signature verification
};
