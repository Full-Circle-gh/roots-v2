'use strict';

// Dependency-free client for the Eleme open platform (饿了么开放平台).
//
// Eleme — unlike Meituan, which we drive through a headless browser — exposes a
// GENUINE OAuth2 + JSON-RPC API at open-api.shop.ele.me. The official
// `eleme-openapi-sdk` works but drags in aws-sdk + four more deps, so we vendor
// the ~3 calls we actually use here (OAuth token exchange/refresh + one signed
// JSON-RPC POST). The wire protocol is small and stable; this keeps the channel
// tenant-neutral and free of a heavy dependency tree.
//
// Protocol (verified against eleme-openapi-sdk@1.21.1):
//   • API gateway:   POST https://{apiBase}/api/v1/
//       body = { token, nop:"1.0.0", metas:{app_key,timestamp}, params, action,
//                id, signature }
//       signature = MD5( action + token + sortedKVs.join('') + secret ).upper
//       where sortedKVs = `${k}=${JSON.stringify(v)}` over {app_key,timestamp,
//       ...params}, sorted lexicographically.
//       reply = { result } on success, { error } on failure.
//   • OAuth token:   POST https://{oauthBase}/token  (Basic key:secret,
//       application/x-www-form-urlencoded). grant_type ∈ authorization_code |
//       refresh_token | client_credentials.
//   • Authorize URL: https://{oauthBase}/authorize?response_type=code&scope=all
//       &client_id=KEY&redirect_uri=CB&state=STATE
//
// Credentials come from env (tenant-neutral; no brand/region baked in):
//   ELEME_APP_KEY, ELEME_APP_SECRET, ELEME_SANDBOX(=1 for sandbox),
//   ELEME_REDIRECT_URI (the OAuth callback this app serves).

const crypto = require('crypto');

const PROD_HOST    = 'open-api.shop.ele.me';
const SANDBOX_HOST = 'open-api-sandbox.shop.ele.me';

// Resolve the runtime config from the environment. `requireCreds` throws a clear
// error when key/secret are missing (callers that only build URLs may pass false).
function elemeConfig(requireCreds = true) {
  const key      = process.env.ELEME_APP_KEY || '';
  const secret   = process.env.ELEME_APP_SECRET || '';
  const sandbox  = process.env.ELEME_SANDBOX === '1';
  const host     = sandbox ? SANDBOX_HOST : PROD_HOST;
  if (requireCreds && (!key || !secret)) {
    throw new Error('Eleme not configured — set ELEME_APP_KEY and ELEME_APP_SECRET');
  }
  return {
    key, secret, sandbox,
    apiBase:     host,
    oauthBase:   host,
    redirectUri: process.env.ELEME_REDIRECT_URI || '',
  };
}

function isConfigured() {
  return !!(process.env.ELEME_APP_KEY && process.env.ELEME_APP_SECRET);
}

// ── OAuth2 ────────────────────────────────────────────────────────────────────

// Build the merchant-facing authorize URL. The operator is sent here, logs into
// their Eleme merchant account, and Eleme redirects back to redirect_uri with
// ?code & ?state. `state` is an unguessable token we mint + verify on callback.
function authorizeUrl(state, scope = 'all', redirectUri) {
  const cfg = elemeConfig(false);
  const cb  = redirectUri || cfg.redirectUri;
  const host = cfg.oauthBase;
  const qs = new URLSearchParams({
    response_type: 'code',
    scope,
    client_id:     cfg.key,
    redirect_uri:  cb,
    state,
  });
  return `https://${host}/authorize?${qs.toString()}`;
}

// POST the OAuth token endpoint. Returns the parsed token object
// { access_token, refresh_token, token_type, expires_in, scope } or throws.
async function tokenRequest(form) {
  const cfg  = elemeConfig(true);
  const auth = Buffer.from(`${cfg.key}:${cfg.secret}`).toString('base64');
  const res  = await fetch(`https://${cfg.oauthBase}/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type':  'application/x-www-form-urlencoded',
      'User-Agent':    'roots-eleme-client',
    },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`Eleme token: bad response ${res.status}: ${text.slice(0, 200)}`); }
  if (!json.access_token) {
    throw new Error(`Eleme token error: ${json.error || json.error_description || text.slice(0, 200)}`);
  }
  return json;
}

// Exchange an authorization code (from the callback) for an access/refresh token.
function exchangeCode(code, redirectUri) {
  const cfg = elemeConfig(true);
  return tokenRequest({
    grant_type:   'authorization_code',
    code,
    redirect_uri: redirectUri || cfg.redirectUri,
    client_id:    cfg.key,
  });
}

// Refresh an expiring access token.
function refreshToken(refresh_token, scope = 'all') {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token, scope });
}

// ── Signed JSON-RPC ─────────────────────────────────────────────────────────

function signature(action, token, params, key, secret, timestamp) {
  const obj = { app_key: key, timestamp };
  for (const k of Object.keys(params || {})) obj[k] = params[k];
  const arr = Object.keys(obj).map(k => `${k}=${JSON.stringify(obj[k])}`).sort();
  const str = action + (token || '') + arr.join('') + secret;
  return crypto.createHash('md5').update(str, 'utf8').digest('hex').toUpperCase();
}

function reqId() {
  return crypto.randomUUID().replace(/-/g, '').toUpperCase() + '|' + Date.now();
}

// Core call. `token` is the merchant access_token (or '' for app-level actions).
// Resolves with the `result` payload, rejects with the Eleme `error` object.
async function rpc(action, params, token) {
  const cfg = elemeConfig(true);
  const timestamp = Math.floor(Date.now() / 1000);
  const body = {
    nop:    '1.0.0',
    id:     reqId(),
    action,
    token:  token || '',
    metas:  { app_key: cfg.key, timestamp },
    params: params || {},
    signature: signature(action, token || '', params, cfg.key, cfg.secret, timestamp),
  };
  const res = await fetch(`https://${cfg.apiBase}/api/v1/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=utf-8', 'User-Agent': 'roots-eleme-client' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`Eleme rpc ${action}: bad response ${res.status}: ${text.slice(0, 200)}`); }
  if (json.error) {
    const e = new Error(`Eleme ${action}: ${json.error.message || JSON.stringify(json.error)}`);
    e.elemeError = json.error; // { code, message } — code present = genuine API rejection
    throw e;
  }
  return json.result;
}

// ── Named helpers (the slice of the API the channel uses) ──────────────────────
// Method names + param shapes verified against eleme-openapi-sdk service files.

const product = {
  // Resolve an Eleme item by its 货号 (extend code) — our primary mapping key.
  getItemByExtendCode: (token, shopId, extendCode) =>
    rpc('eleme.product.item.getItemByShopIdAndExtendCode', { shopId, extendCode }, token),
  getItemsByBarCode: (token, shopId, barCode) =>
    rpc('eleme.product.item.getItemsByShopIdAndBarCode', { shopId, barCode }, token),
  // stockMap: { [specId]: stock } — set absolute stock for one or many specs.
  batchUpdateStock: (token, stockMap) =>
    rpc('eleme.product.item.batchUpdateStock', { stockMap }, token),
  // Paged listing query. queryPage: { shopId, page, pageSize, ... }
  queryItemByPage: (token, queryPage) =>
    rpc('eleme.product.item.queryItemByPage', { queryPage }, token),
  getShopSalesItems: (token, shopId) =>
    rpc('eleme.product.item.getShopSalesItems', { shopId }, token),
};

const order = {
  getAllOrders: (token, shopId, pageNo, pageSize, date) =>
    rpc('eleme.order.getAllOrders', { shopId, pageNo, pageSize, date }, token),
  getUnprocessOrders: (token, shopId) =>
    rpc('eleme.order.getUnprocessOrders', { shopId }, token),
  getOrder: (token, orderId) =>
    rpc('eleme.order.getOrder', { orderId }, token),
  mgetOrders: (token, orderIds) =>
    rpc('eleme.order.mgetOrders', { orderIds }, token),
  getCommodities: (token, orderId) =>
    rpc('eleme.order.getCommodities', { orderId }, token),
};

const shop = {
  getShop: (token, shopId) => rpc('eleme.shop.getShop', { shopId }, token),
  mgetShopStatus: (token, shopIds) => rpc('eleme.shop.mgetShopStatus', { shopIds }, token),
};

const user = {
  // Authorised user + their shop ids — used to discover which shop to map.
  getUser: (token) => rpc('eleme.user.getUser', {}, token),
};

module.exports = {
  elemeConfig, isConfigured,
  authorizeUrl, exchangeCode, refreshToken,
  rpc, signature,
  product, order, shop, user,
};
