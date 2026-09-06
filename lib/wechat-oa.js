// WeChat Official Account (服务号) OAuth — the handshake an ordinary web page
// needs before it can take a WeChat payment. §50.
//
// WHY THIS IS NOT A BRANCH INSIDE THE MINI-APP'S WECHAT CODE. An openid
// identifies a person TO ONE APP. The mini program and this Official Account
// are two different WeChat registrations with two different appids, so an
// openid issued by one CANNOT pay an order created against the other — WeChat
// refuses it as an appid/openid mismatch. Two credential sets and two code
// paths, kept apart on purpose, is what stops that being mixed up by accident.
//
// The Official Account is also NOT lib/social-auth.js's `wechat` provider:
// that one is an Open Platform WEBSITE app (scope snsapi_login) used for the
// desktop scan-to-sign-in, a third registration again, and not payment-capable.

// snsapi_base, deliberately. It returns an openid and nothing else, and it is
// SILENT — no consent screen, no nickname, no avatar, no prompt of any kind.
// The customer sees a redirect and nothing more, which is what §44's "no login,
// no phone number" asks for. snsapi_userinfo would put a permission sheet in
// front of somebody who only wants to pay for a coffee, and everything extra it
// returns is something we would then be holding for no reason.
const SCOPE = 'snsapi_base';

// WeChat rejects a state carrying anything exotic and silently truncates a long
// one, so the shape is enforced here rather than discovered on a dead redirect.
const STATE_RE = /^[A-Za-z0-9_-]{1,128}$/;

// Build the URL that sends a WeChat browser off to get us an openid.
//
// The #wechat_redirect fragment is REQUIRED and is not decoration: without it
// WeChat's browser does not perform the redirect at all, and the customer sees
// a blank page. redirect_uri must be the full absolute URL and must sit under
// the domain registered against this Official Account — an unregistered domain
// fails with errcode 10003, which no amount of correct code here can fix.
function authorizeUrl({ appId, redirectUri, state }) {
  if (!appId) throw new Error('wechat_oa_appid_missing');
  if (!redirectUri) throw new Error('wechat_oa_redirect_missing');
  if (!STATE_RE.test(String(state || ''))) throw new Error('wechat_oa_bad_state');
  const q = new URLSearchParams({
    appid: appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    state: String(state),
  });
  return 'https://open.weixin.qq.com/connect/oauth2/authorize?' + q.toString() + '#wechat_redirect';
}

// Trade the one-time code WeChat handed back for the customer's openid.
//
// WeChat answers 200 with an errcode body on failure, so the HTTP status says
// nothing — the presence of an openid is the only success signal, and that is
// what this checks. The code is single-use and expires in five minutes; a
// replayed one lands here as errcode 40029 and is thrown, never treated as a
// customer.
async function exchangeCodeForOpenid(code, { appId, appSecret }) {
  if (!appId || !appSecret) throw new Error('wechat_oa_creds_missing');
  if (!code) throw new Error('wechat_oa_code_missing');
  const q = new URLSearchParams({
    appid: appId, secret: appSecret, code: String(code), grant_type: 'authorization_code',
  });
  const r = await fetch('https://api.weixin.qq.com/sns/oauth2/access_token?' + q.toString());
  const j = await r.json().catch(() => ({}));
  if (!j.openid) throw new Error('wechat_oa_exchange_failed:' + (j.errcode || r.status));
  return { openid: j.openid, unionid: j.unionid || null };
}

module.exports = { SCOPE, authorizeUrl, exchangeCodeForOpenid };
