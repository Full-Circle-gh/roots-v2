// The content gate: WeChat's text and image checks on what customers publish,
// and the one refusal they see. Moved out of routes/retail.js unchanged
// (decisions §477).
'use strict';

const wxSec = require('./wx-sec-check');   // WeChat 内容安全 — every customer-published surface
const { tdb } = require('./tenant-db');
const { getWeChatAccessToken, refreshWeChatAccessTokenAfter, isWxTokenError } = require('./wx-access-token');
const { PAY_NOTIFY_ORIGIN } = require('./public-origin');

// ═══════════════════════════════════════════════════════════════════════
// WeChat content safety (内容安全)
// ═══════════════════════════════════════════════════════════════════════
// WeChat rejects a mini program that lets a customer publish anything without
// checking it first — that is what killed the 2026-07 audit ("头像 功能在进行
// 内容安全验证时，存在信息安全风险"). Every surface where a customer's own words
// or pictures end up on a screen routes through the two helpers below:
//
//   nickname + avatar       → profile scene
//   review text + photos    → comment scene
//   feedback text + photos  → comment scene
//
// Text is decided on the spot. Images can't be: WeChat only accepts the job
// and pushes the verdict back later (see the /api/wx/callback route), so an
// image is held as 'pending' and stays unpublished until it passes.

// Resolve this tenant's access token without ever letting a token failure
// throw into a request handler.
async function wxSecToken() {
  try { return await getWeChatAccessToken(); }
  catch (e) { console.warn('[wx-sec] access token unavailable:', e.message); return null; }
}

// wx-sec-check does its own fetching, so it can't go through wxApiPost — but it
// reports the errcode back as reason 'api_error_<code>', which is enough to spot
// a rejected token and replay the call once with a fresh one. Worth the retry
// here specifically because BOTH checks fail open: a stale token would let text
// and images publish unchecked for as long as the token stayed stale, which is
// the exact exposure the content-safety gate exists to prevent.
async function callWxSecWithTokenRetry(call) {
  const token = await wxSecToken();
  let r = await call(token);
  const code = Number(String((r && r.reason) || '').replace('api_error_', ''));
  if (token && isWxTokenError(code)) {
    const fresh = await refreshWeChatAccessTokenAfter(token);
    if (fresh) r = await call(fresh);
  }
  return r;
}

// Text gate. Returns true when the caller should refuse the content.
async function isRiskyText(customer, text, scene) {
  const r = await callWxSecWithTokenRetry((t) => wxSec.checkText(t, {
    text, openid: customer && customer.openid, scene,
  }));
  if (r.verdict === 'risky') {
    console.warn('[wx-sec] risky text refused — customer', customer && customer.id, 'scene', scene, 'label', r.label);
    return true;
  }
  return false;
}

// The single refusal a customer ever sees. WeChat asks only that we tell them
// the content contains disallowed information — no label, no category, no
// score, because naming what tripped it teaches people how to get around it.
function refuseContent(res) {
  return res.status(400).json({
    success: false,
    error: 'content_violation',
    message_en: 'That contains something we cannot publish. Please change it and try again.',
    message_cn: '内容含违规信息，请修改后重试。',
  });
}

// Image gate. Submits a freshly-uploaded media row to WeChat and records the
// hold. Returns the sec_status now stored on the row: 'pending' when the job
// is running, 'skipped' when no check was possible (dev mode, web login,
// WeChat unreachable) — 'skipped' publishes immediately, because holding every
// image hostage to an outage would break uploads for everyone.
async function submitImageSecCheck(mediaId, customer, scene) {
  const url = `${PAY_NOTIFY_ORIGIN}/api/retail/media/${mediaId}`;
  const r = await callWxSecWithTokenRetry((t) => wxSec.submitMediaCheck(t, {
    url, openid: customer && customer.openid, scene,
  }));
  const status = r.ok ? 'pending' : 'skipped';
  try {
    tdb().prepare(
      `UPDATE retail_media
          SET sec_status = ?, sec_trace_id = ?,
              sec_checked_at = CASE WHEN ? = 'skipped' THEN CURRENT_TIMESTAMP ELSE NULL END
        WHERE id = ?`
    ).run(status, r.traceId || null, status, mediaId);
  } catch (e) { console.warn('[wx-sec] could not record media hold:', e.message); }
  return status;
}

module.exports = { callWxSecWithTokenRetry, isRiskyText, refuseContent, submitImageSecCheck };
