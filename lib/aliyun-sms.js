// 阿里云短信服务 (Aliyun SMS / Dysmsapi) — sends a transactional SMS to the
// customer when an out-of-Guangzhou courier order is marked delivered. This is
// the channel the OLD mini app used; roots-v2 now drives it directly.
//
// ── Status: dormant until credentials land ──────────────────────────────────
// Every function is a no-op returning { ok:false, error:'aliyun_sms_not_configured' }
// until accessKeyId / accessKeySecret / signName / a template code are saved in
// the Integrations panel (integrations.aliyun_sms.*). Nothing here fires on its
// own — retail.js's notifyOrderStatusChange() calls sendDeliveredSms() only on a
// 'delivered' transition for an out-of-city order whose customer has a phone.
//
// API: Dysmsapi SendSms, RPC-style POP request signed with HMAC-SHA1 (no SDK,
// no extra npm dependency — same self-contained style as lib/nuonuo.js).
//   Endpoint : https://dysmsapi.aliyuncs.com/   (cn-hangzhou region)
//   Version  : 2017-05-25
//   Docs     : https://help.aliyun.com/document_detail/101414.html
//
// Credentials (per-tenant, via getTenantCreds(tid).integrations.aliyun_sms):
//   accessKeyId       — AccessKey ID (ideally a RAM user with AliyunDysmsFullAccess)
//   accessKeySecret   — AccessKey Secret (signing only, never sent in clear)
//   signName          — approved 签名 text, e.g. 满圆 (reused from the old app)
//   templateDelivered — approved 模板CODE for the delivered notice, e.g. SMS_123456789
//
// The delivered template MUST be submitted in the Aliyun console (模板管理) with a
// single variable named exactly `order`, e.g.:
//   您的订单${order}已送达，请注意查收，感谢您的惠顾。
// If the approved template uses a different variable name, change the param key
// in sendDeliveredSms() to match — that's the only coupling.

const crypto = require('crypto');

const ENDPOINT  = 'https://dysmsapi.aliyuncs.com/';
const API_VER   = '2017-05-25';
const REGION_ID = 'cn-hangzhou';

// Base creds = enough to sign and send ANY approved template. The per-feature
// gates below additionally require the specific template code for that feature.
function hasBaseCreds(c) {
  return !!(c && c.accessKeyId && c.accessKeySecret && c.signName);
}
function aliyunSmsEnabled(c) {
  return hasBaseCreds(c) && !!c.templateDelivered;   // delivered-notice feature gate
}
function aliyunOtpEnabled(c) {
  return hasBaseCreds(c) && !!c.templateOtp;          // login OTP feature gate
}

// Aliyun POP percent-encoding: encodeURIComponent, then nudge the three chars
// where RFC 3986 and JS's encoder disagree.
function popEncode(s) {
  return encodeURIComponent(s)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

// RPC signature: sort params, build the canonicalized query, then
//   Signature = Base64( HMAC-SHA1( accessKeySecret + '&', StringToSign ) )
// where StringToSign = METHOD + '&' + enc('/') + '&' + enc(canonicalQuery).
function sign(params, accessKeySecret, method = 'POST') {
  const canonical = Object.keys(params)
    .sort()
    .map(k => popEncode(k) + '=' + popEncode(params[k]))
    .join('&');
  const stringToSign = method + '&' + popEncode('/') + '&' + popEncode(canonical);
  return crypto.createHmac('sha1', accessKeySecret + '&')
    .update(stringToSign, 'utf8')
    .digest('base64');
}

// Normalize to the 11-digit mainland mobile Aliyun expects (strips +86 / spaces).
// Returns '' if the result isn't a plausible CN mobile number (1 + 10 digits).
function normalizeCnMobile(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('86')) d = d.slice(2);
  if (d.length === 14 && d.startsWith('086')) d = d.slice(3);
  return /^1\d{10}$/.test(d) ? d : '';
}

// Low-level SendSms. `templateParam` is a plain object serialized to the
// TemplateParam JSON. Returns { ok, bizId } on success, { ok:false, code, error }
// otherwise. Never throws.
async function sendSms(phone, templateCode, templateParam, c) {
  if (!hasBaseCreds(c) || !templateCode) return { ok: false, error: 'aliyun_sms_not_configured' };
  const mobile = normalizeCnMobile(phone);
  if (!mobile) return { ok: false, error: 'bad_phone' };

  const params = {
    // ── action ──
    Action:        'SendSms',
    PhoneNumbers:  mobile,
    SignName:      c.signName,
    TemplateCode:  templateCode,
    TemplateParam: JSON.stringify(templateParam || {}),
    // ── common ──
    Format:           'JSON',
    Version:          API_VER,
    AccessKeyId:      c.accessKeyId,
    SignatureMethod:  'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce:   crypto.randomUUID(),
    Timestamp:        new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    RegionId:         REGION_ID,
  };
  params.Signature = sign(params, c.accessKeySecret, 'POST');

  try {
    const r = await fetch(ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams(params).toString(),
    });
    const j = await r.json().catch(() => null);
    if (!j) return { ok: false, error: 'aliyun_non_json' };
    // Success envelope: { Code:'OK', Message:'OK', BizId, RequestId }.
    if (j.Code === 'OK') return { ok: true, bizId: j.BizId, raw: j };
    return { ok: false, code: j.Code, error: j.Message || j.Code || 'aliyun_error', raw: j };
  } catch (e) {
    return { ok: false, error: 'aliyun_request_failed: ' + e.message };
  }
}

// The one call retail.js makes: notify a customer their package was delivered.
// `orderNo` fills the template's ${order} variable.
async function sendDeliveredSms(phone, { orderNo } = {}, c) {
  if (!aliyunSmsEnabled(c)) return { ok: false, error: 'aliyun_sms_not_configured' };
  return sendSms(phone, c.templateDelivered, { order: String(orderNo || '') }, c);
}

// Web-login one-time passcode. Fills the OTP template's ${code} variable. The
// approved OTP template (模板CODE in integrations.aliyun_sms.templateOtp) MUST use
// a single variable named exactly `code`, e.g.:
//   您的验证码${code}，5分钟内有效，请勿泄露。
async function sendOtpSms(phone, code, c) {
  if (!aliyunOtpEnabled(c)) return { ok: false, error: 'aliyun_otp_not_configured' };
  return sendSms(phone, c.templateOtp, { code: String(code) }, c);
}

// Credential sanity-check for the admin "Send test" button. Sends the real
// delivered template to the operator-supplied number so they see an actual SMS
// land — the only way Aliyun confirms sign+template+key are all approved & wired.
async function pingAliyunSms(phone, c) {
  if (!aliyunSmsEnabled(c)) return { ok: false, error: 'aliyun_sms_not_configured' };
  return sendDeliveredSms(phone, { orderNo: 'TEST0001' }, c);
}

module.exports = {
  aliyunSmsEnabled,
  aliyunOtpEnabled,
  normalizeCnMobile,
  sendSms,
  sendDeliveredSms,
  sendOtpSms,
  pingAliyunSms,
  sign,   // exported for signature unit-testing
};
