// The WeChat access token: fetched per AppID, cached, and force-refreshed
// when WeChat rejects one. Moved out of routes/retail.js unchanged (decisions
// §477). The cache lives here, so there is still exactly one.
'use strict';

const { currentTenantId } = require('./tenant-db');
const { getTenantCreds } = require('./tenant-creds');

// Server-side: cached WeChat access_token. Used for both subscribeMessage
// API and any other server-to-server WeChat calls. Token lives ~2 hours;
// we re-fetch when missing or near-expiry.
//
// Uses /cgi-bin/stable_token (not /cgi-bin/token). stable_token is WeChat's
// multi-server-safe endpoint: it returns a token that does NOT invalidate
// tokens held by other backends on the same AppID. The legacy /cgi-bin/token
// would knock out a co-resident backend's cached token on every fetch — a
// problem when the AppID is shared with another vendor (out1n) whose backend
// also fetches tokens. force_refresh=false lets WeChat reuse a cached token
// across calls, further reducing churn.
// Per-AppID token cache. Each tenant runs its own mini-program (own AppID), so
// the access_token is scoped to the AppID, not the process. Keyed by AppID so
// two tenants (or Roots + a tenant) never clobber each other's token. Roots'
// AppID resolves from env exactly as before — same stable_token semantics.
const _wxTokenCache = new Map();   // appId -> { token, expiresAt }
// When we last asked WeChat to FORCE a new token, per AppID. Forced refresh is
// rate-limited on WeChat's side, so it must stay an exception path — see
// refreshWeChatAccessTokenAfter().
const _wxTokenForcedAt = new Map();   // appId -> ms
const WX_TOKEN_FORCE_COOLDOWN_MS = 5 * 60_000;

// opts.forceRefresh — abandon the cached token and make WeChat mint a new one.
// The flag has to reach stable_token too, not just our own Map: with
// force_refresh=false WeChat answers from ITS cache and hands back the very
// token that was just rejected, so a "refresh" that only clears our side would
// loop on the same bad value.
async function getWeChatAccessToken(opts = {}) {
  const { appId, appSecret } = getTenantCreds(currentTenantId()).wechat;
  if (!appId || !appSecret) return null;
  if (opts.forceRefresh) _wxTokenCache.delete(appId);
  const hit = _wxTokenCache.get(appId);
  if (hit && Date.now() < hit.expiresAt - 60_000) return hit.token;
  if (opts.forceRefresh) _wxTokenForcedAt.set(appId, Date.now());
  const resp = await fetch('https://api.weixin.qq.com/cgi-bin/stable_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credential',
      appid:      appId,
      secret:     appSecret,
      force_refresh: !!opts.forceRefresh,
    }),
  });
  const j = await resp.json();
  if (!j.access_token) throw new Error('access_token_fetch_failed: ' + (j.errmsg || j.errcode));
  _wxTokenCache.set(appId, { token: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 7200) * 1000 });
  return j.access_token;
}

// WeChat errcodes that all mean "the access_token you sent is no good" — the
// token was invalidated early (another process forced a refresh, credentials
// were rotated) rather than expiring on the clock we cache it against. Without
// recovery every call keeps presenting the same dead token until our cache ages
// out on its own, which for a 7200s token is up to two hours of hard failure.
const WX_TOKEN_ERROR_CODES = new Set([
  40001, // invalid credential / access_token isn't latest
  40014, // invalid access_token
  42001, // access_token expired
]);
const isWxTokenError = (code) => WX_TOKEN_ERROR_CODES.has(code);

// Recover from one of the codes above. `staleToken` is the token that just got
// rejected: if the cache no longer holds it, another caller already refreshed
// and we simply take theirs — so a burst of concurrent 40001s costs ONE refresh,
// not one per caller. The cooldown then bounds the pathological case (bad
// AppSecret, revoked app) where every refresh produces another rejected token;
// there we let calls keep failing rather than hammer a rate-limited endpoint.
// Returns the token to retry with, or null when a retry isn't worth making.
async function refreshWeChatAccessTokenAfter(staleToken) {
  const { appId } = getTenantCreds(currentTenantId()).wechat;
  if (!appId) return null;
  const hit = _wxTokenCache.get(appId);
  if (hit && hit.token && hit.token !== staleToken) return hit.token;   // someone beat us to it
  const last = _wxTokenForcedAt.get(appId) || 0;
  if (Date.now() - last < WX_TOKEN_FORCE_COOLDOWN_MS) {
    console.warn('[wx-token] rejected token, but a forced refresh is on cooldown — not retrying');
    return null;
  }
  try {
    const fresh = await getWeChatAccessToken({ forceRefresh: true });
    console.warn('[wx-token] access_token was rejected — forced a refresh');
    return fresh && fresh !== staleToken ? fresh : null;
  } catch (e) {
    console.error('[wx-token] forced refresh failed:', e.message);
    return null;
  }
}

module.exports = { getWeChatAccessToken, refreshWeChatAccessTokenAfter, isWxTokenError };
