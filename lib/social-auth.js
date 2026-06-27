// Social / SSO sign-in protocol helpers for the web storefront.
//
// Pure protocol layer — NO database, NO Express. retail.js owns the customer
// upsert + token issue; this module only speaks each provider's OAuth dialect
// and returns a NORMALIZED profile:
//   { providerId, email, emailVerified, name, avatar, unionid }
//
// Tenant-neutral: credentials come from env first, with an optional per-tenant
// override object (integ().oauth / integ()) passed in. A provider with no creds
// is simply "not enabled" — the routes hide its button and 503 its endpoints,
// exactly like the WeChat-Pay dev-mode pattern elsewhere in the app.
//
// Provider apps are SEPARATE from the mini-app: WeChat web login uses a
// 微信开放平台 *website* app (WECHAT_WEB_APP_ID), never the mini-app AppID.

const crypto = require('crypto');

// ── base64url ──────────────────────────────────────────────────────────────
function b64urlEncode(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// Decode (NOT verify) a JWT payload. Safe here because every id_token we read is
// fetched directly from the provider's token endpoint over TLS — we never accept
// a JWT from the browser, so signature verification adds no security.
function decodeJwtPayload(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length < 2) throw new Error('bad_jwt');
  return JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
}

// ── credential resolution (env, then tenant override) ────────────────────────
function providerCreds(provider, integ) {
  integ = integ || {};
  const o = (integ.oauth && integ.oauth[provider]) || integ[provider] || {};
  switch (provider) {
    case 'google':
      return {
        clientId:     o.client_id     || process.env.GOOGLE_CLIENT_ID     || '',
        clientSecret: o.client_secret || process.env.GOOGLE_CLIENT_SECRET || '',
      };
    case 'apple':
      return {
        clientId:   o.service_id  || process.env.APPLE_SERVICE_ID || '',  // Services ID = OAuth client_id
        teamId:     o.team_id     || process.env.APPLE_TEAM_ID    || '',
        keyId:      o.key_id      || process.env.APPLE_KEY_ID     || '',
        privateKey: (o.private_key || process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      };
    case 'wechat':
      return {
        appId:     o.app_id     || process.env.WECHAT_WEB_APP_ID     || '',
        appSecret: o.app_secret || process.env.WECHAT_WEB_APP_SECRET || '',
      };
    default:
      return {};
  }
}

function isEnabled(provider, integ) {
  const c = providerCreds(provider, integ);
  if (provider === 'google') return !!(c.clientId && c.clientSecret);
  if (provider === 'apple')  return !!(c.clientId && c.teamId && c.keyId && c.privateKey);
  if (provider === 'wechat') return !!(c.appId && c.appSecret);
  return false;
}

// ── authorize URL (where we redirect the browser to begin sign-in) ───────────
function authorizeUrl(provider, { creds, redirectUri, state }) {
  if (provider === 'google') {
    const p = new URLSearchParams({
      client_id: creds.clientId, redirect_uri: redirectUri, response_type: 'code',
      scope: 'openid email profile', state, access_type: 'online', prompt: 'select_account',
    });
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
  }
  if (provider === 'apple') {
    // Requesting the email scope forces response_mode=form_post (Apple posts the
    // code back as a form body, so the callback must also accept POST).
    const p = new URLSearchParams({
      client_id: creds.clientId, redirect_uri: redirectUri, response_type: 'code',
      scope: 'name email', state, response_mode: 'form_post',
    });
    return 'https://appleid.apple.com/auth/authorize?' + p.toString();
  }
  if (provider === 'wechat') {
    const p = new URLSearchParams({
      appid: creds.appId, redirect_uri: redirectUri, response_type: 'code',
      scope: 'snsapi_login', state,
    });
    return 'https://open.weixin.qq.com/connect/qrconnect?' + p.toString() + '#wechat_redirect';
  }
  throw new Error('unknown_provider');
}

// Apple's client_secret is itself a short-lived ES256 JWT signed with the .p8 key.
function appleClientSecret(creds) {
  const now = Math.floor(Date.now() / 1000);
  const header  = { alg: 'ES256', kid: creds.keyId, typ: 'JWT' };
  const payload = { iss: creds.teamId, iat: now, exp: now + 300,
    aud: 'https://appleid.apple.com', sub: creds.clientId };
  const signingInput = b64urlEncode(JSON.stringify(header)) + '.' + b64urlEncode(JSON.stringify(payload));
  const sig = crypto.sign('SHA256', Buffer.from(signingInput),
    { key: creds.privateKey, dsaEncoding: 'ieee-p1363' });   // ieee-p1363 → ES256 raw r||s
  return signingInput + '.' + b64urlEncode(sig);
}

// ── exchange the authorization code for a normalized profile ─────────────────
async function exchange(provider, { creds, code, redirectUri }) {
  if (provider === 'google') {
    const body = new URLSearchParams({
      client_id: creds.clientId, client_secret: creds.clientSecret, code,
      grant_type: 'authorization_code', redirect_uri: redirectUri,
    });
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const j = await r.json().catch(() => ({}));
    if (!j.id_token) throw new Error('google_no_id_token:' + (j.error || r.status));
    const p = decodeJwtPayload(j.id_token);
    return {
      providerId: p.sub,
      email: (p.email || '').toLowerCase() || null,
      emailVerified: p.email_verified === true || p.email_verified === 'true',
      name: p.name || null, avatar: p.picture || null, unionid: null,
    };
  }
  if (provider === 'apple') {
    const body = new URLSearchParams({
      client_id: creds.clientId, client_secret: appleClientSecret(creds), code,
      grant_type: 'authorization_code', redirect_uri: redirectUri,
    });
    const r = await fetch('https://appleid.apple.com/auth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const j = await r.json().catch(() => ({}));
    if (!j.id_token) throw new Error('apple_no_id_token:' + (j.error || r.status));
    const p = decodeJwtPayload(j.id_token);
    return {
      providerId: p.sub,
      email: (p.email || '').toLowerCase() || null,
      // Apple only returns verified emails (its own relay or a verified address).
      emailVerified: p.email_verified === true || p.email_verified === 'true' || !!p.email,
      name: null, avatar: null, unionid: null,
    };
  }
  if (provider === 'wechat') {
    const tu = new URLSearchParams({
      appid: creds.appId, secret: creds.appSecret, code, grant_type: 'authorization_code' });
    const r = await fetch('https://api.weixin.qq.com/sns/oauth2/access_token?' + tu.toString());
    const j = await r.json().catch(() => ({}));
    if (!j.access_token || !j.openid) throw new Error('wechat_token_failed:' + (j.errcode || r.status));
    let name = null, avatar = null;
    try {
      const iu = new URLSearchParams({ access_token: j.access_token, openid: j.openid, lang: 'zh_CN' });
      const ur = await fetch('https://api.weixin.qq.com/sns/userinfo?' + iu.toString());
      const uj = await ur.json().catch(() => ({}));
      if (uj && uj.openid) { name = uj.nickname || null; avatar = uj.headimgurl || null; }
    } catch (_) { /* userinfo is best-effort; openid/unionid already suffice */ }
    // unionid ties this person to their mini-app account (same 开放平台 subject).
    return { providerId: j.openid, email: null, emailVerified: false, name, avatar, unionid: j.unionid || null };
  }
  throw new Error('unknown_provider');
}

module.exports = { providerCreds, isEnabled, authorizeUrl, exchange, decodeJwtPayload };
