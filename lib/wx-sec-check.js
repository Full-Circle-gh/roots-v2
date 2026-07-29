// WeChat content-security (内容安全) helper.
//
// WeChat refuses to publish a mini program that lets a user put content in
// front of other users without running it past their moderation API first
// (《微信小程序平台运营规范》3.2). Two endpoints do the work:
//
//   • msgSecCheck      — text. Synchronous: the verdict is in the response.
//   • mediaCheckAsync  — images / audio. Asynchronous: the call only hands back
//     a trace_id. The verdict arrives minutes-to-seconds later as a
//     `wxa_media_check` event on the mini program's message-push URL, which is
//     configured in 微信公众平台 → 开发管理 → 消息推送.
//
// This module holds no credentials and no tenant state: callers pass in the
// access token they already resolved for the current tenant, so a second
// tenant on its own AppID uses its own token without touching this file.

const crypto = require('crypto');

const MSG_SEC_CHECK = 'https://api.weixin.qq.com/wxa/msg_sec_check';
const MEDIA_CHECK   = 'https://api.weixin.qq.com/wxa/media_check_async';

// WeChat's scene codes — which surface the content is published on. Passing a
// truthful scene is part of what they check for; profile and comment are the
// only two this app has.
const SCENE = { PROFILE: 1, COMMENT: 2, FORUM: 3, LOG: 4 };
const MEDIA_TYPE = { AUDIO: 1, IMAGE: 2 };

// msgSecCheck v2 needs a real mini-program openid — a user WeChat can resolve,
// who has opened this mini program. Web/social logins get a synthetic
// `provider:id` openid and dev mode gets `dev:<code>`; both carry a colon,
// neither means anything to WeChat, so the check is skipped for them rather
// than firing a call we know will fail.
function isMiniProgramOpenid(openid) {
  return typeof openid === 'string' && openid.length >= 16 && !openid.includes(':');
}

// Text check. Resolves to { verdict, label, traceId, reason }, where verdict is
// 'risky' (block it), 'pass', or 'skipped'.
//
// Never throws and never blocks on an infrastructure problem. A WeChat outage,
// a missing AppID or a non-WeChat customer degrades to 'skipped' — blocking
// every save in the app because WeChat is unreachable would be a worse failure
// than letting a few minutes of content through unchecked. Only an actual
// risky verdict blocks.
async function checkText(accessToken, { text, openid, scene = SCENE.PROFILE } = {}) {
  const content = (text == null ? '' : String(text)).trim();
  if (!content)                       return { verdict: 'skipped', reason: 'empty' };
  if (!accessToken)                   return { verdict: 'skipped', reason: 'no_access_token' };
  if (!isMiniProgramOpenid(openid))   return { verdict: 'skipped', reason: 'not_wechat_user' };
  try {
    const resp = await fetch(`${MSG_SEC_CHECK}?access_token=${encodeURIComponent(accessToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 2500 characters is WeChat's hard cap — a longer body is refused
      // outright, so trim rather than lose the whole check.
      body: JSON.stringify({ version: 2, scene, openid, content: content.slice(0, 2500) }),
    });
    const j = await resp.json();
    // 87014 is the v1-era "content is risky" errcode. v2 answers errcode 0 and
    // puts the verdict in result.suggest. Honour both.
    if (j.errcode === 87014) {
      return { verdict: 'risky', label: j.result && j.result.label, traceId: j.trace_id };
    }
    if (j.errcode) {
      console.warn('[wx-sec] msgSecCheck errcode', j.errcode, j.errmsg || '');
      return { verdict: 'skipped', reason: 'api_error_' + j.errcode };
    }
    const suggest = j.result && j.result.suggest;
    if (suggest === 'risky') {
      return { verdict: 'risky', label: j.result.label, traceId: j.trace_id };
    }
    // 'review' means WeChat is unsure and wants a human to look. We let it
    // through and log it — refusing on 'review' would reject ordinary text.
    if (suggest === 'review') console.warn('[wx-sec] msgSecCheck flagged for review, allowed:', j.trace_id);
    return { verdict: 'pass', traceId: j.trace_id };
  } catch (e) {
    console.warn('[wx-sec] msgSecCheck failed:', e.message);
    return { verdict: 'skipped', reason: 'network' };
  }
}

// Image/audio check. Only submits the job — WeChat fetches `url` itself, so it
// must be publicly reachable, and the verdict comes back on the message-push
// URL. Resolves to { ok: true, traceId } or { ok: false, reason }.
async function submitMediaCheck(accessToken, {
  url, openid, scene = SCENE.PROFILE, mediaType = MEDIA_TYPE.IMAGE,
} = {}) {
  if (!url)                         return { ok: false, reason: 'no_url' };
  if (!accessToken)                 return { ok: false, reason: 'no_access_token' };
  if (!isMiniProgramOpenid(openid)) return { ok: false, reason: 'not_wechat_user' };
  try {
    const resp = await fetch(`${MEDIA_CHECK}?access_token=${encodeURIComponent(accessToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ media_url: url, media_type: mediaType, version: 2, openid, scene }),
    });
    const j = await resp.json();
    // errcode 0 here means "job accepted", NOT "image is clean" — the verdict
    // is the callback's job.
    if (j.errcode || !j.trace_id) {
      console.warn('[wx-sec] mediaCheckAsync errcode', j.errcode, j.errmsg || '');
      return { ok: false, reason: 'api_error_' + (j.errcode || 'no_trace_id') };
    }
    return { ok: true, traceId: j.trace_id };
  } catch (e) {
    console.warn('[wx-sec] mediaCheckAsync failed:', e.message);
    return { ok: false, reason: 'network' };
  }
}

// Message-push URL verification. WeChat proves it is the caller by sending
// signature/timestamp/nonce; the signature is sha1 over those three values
// (minus the signature itself, plus our shared token) sorted as strings.
function verifyPushSignature(token, { signature, timestamp, nonce } = {}) {
  if (!token || !signature) return false;
  const expected = crypto
    .createHash('sha1')
    .update([token, String(timestamp || ''), String(nonce || '')].sort().join(''))
    .digest('hex');
  // Both sides are fixed-length hex, so a length mismatch means it's bogus
  // anyway and timingSafeEqual would throw on it.
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  SCENE, MEDIA_TYPE,
  isMiniProgramOpenid,
  checkText,
  submitMediaCheck,
  verifyPushSignature,
};
