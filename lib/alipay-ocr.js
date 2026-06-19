// Alipay payment-screenshot reader (Vision AI).
//
// Reads a customer-uploaded Alipay "支付成功 / 付款成功" screenshot and returns
// the structured fields we verify a manual payment against. Used by the manual
// 收款码 flow to auto/assist the pending→paid decision. Cheap (Haiku) — a few
// fen per order — and ALWAYS fail-soft: any error returns verdict 'error' and
// the order stays pending for a human, never silently flips.
//
// IMPORTANT: a screenshot is forgeable, so this is a convenience/assist layer.
// The caller decides whether a full match may auto-flip (operator toggle); the
// hard guardrail against reuse is the txn-id dedup the caller applies.

const https = require('https');
const gateway = require('./model-gateway');   // reuses the server's existing model key + (China) relay URL

const ANTHROPIC_HOST = 'api.anthropic.com';
const OCR_MODEL = 'claude-haiku-4-5-20251001';   // cheapest vision tier — plenty for reading a receipt

// Can we OCR at all? True when the shared model gateway is configured (reuses the
// Brand-Studio key + any relay/proxy) OR the operator pasted a standalone key.
function ocrAvailable(pastedKey) { return gateway.isConfigured() || !!pastedKey; }

// Split a data URL into { mediaType, base64 }. Returns null if not an image.
function splitDataUrl(dataUrl) {
  const m = /^data:(image\/(?:png|jpe?g|webp));base64,([\s\S]+)$/.exec(dataUrl || '');
  if (!m) return null;
  return { mediaType: m[1] === 'image/jpg' ? 'image/jpeg' : m[1], base64: m[2] };
}

const PROMPT = [
  'This image is a screenshot from the Alipay (支付宝) app. It is usually a',
  'payment-result screen ("支付成功" / "付款成功" / "交易成功"). Read it carefully and',
  'return ONLY a single JSON object, no prose, with these keys:',
  '{',
  '  "success": boolean,        // true ONLY if the screen clearly shows a SUCCESSFUL payment',
  '  "amount": number|null,     // the paid amount in RMB yuan as a number, e.g. 60.50',
  '  "payee": string|null,      // the payee / 收款方 / "向…付款" name text exactly as shown',
  '  "paid_at": string|null,    // payment time as "YYYY-MM-DD HH:MM" (Beijing) if visible, else null',
  '  "txn_id": string|null,     // the 订单号 / 商家订单号 / 流水号 transaction number if visible, else null',
  '  "raw_time_text": string|null // the literal time string you saw, if any',
  '}',
  'If a field is not visible, use null. Do not guess the amount — read it. Output JSON only.',
].join('\n');

// Call Anthropic /v1/messages with the image. Resolves to the raw text reply.
function callAnthropic(apiKey, mediaType, base64) {
  const body = JSON.stringify({
    model: OCR_MODEL,
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: PROMPT },
      ],
    }],
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: ANTHROPIC_HOST, path: '/v1/messages', method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-length': Buffer.byteLength(body),
      },
      timeout: 20000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (res.statusCode !== 200) return reject(new Error('anthropic_' + res.statusCode + ': ' + (j.error?.message || data).slice(0, 160)));
          const text = Array.isArray(j.content) ? j.content.filter(b => b.type === 'text').map(b => b.text).join('') : '';
          resolve(text);
        } catch (e) { reject(new Error('anthropic_bad_json')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('anthropic_timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Pull the first {...} JSON object out of a model reply (it may add ``` fences).
function parseJsonReply(text) {
  if (!text) return null;
  let s = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < 0 || b < a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

// Read a payment screenshot → { success, amount, payee, paid_at, txn_id, raw_time_text }.
// Prefers the shared model gateway (reuses the server's key + relay URL — works
// behind a China proxy); falls back to a directly-supplied key. Throws on
// transport/auth errors (caller treats as verdict 'error').
async function readPaymentScreenshot(dataUrl, opts = {}) {
  const apiKey = (opts && opts.apiKey) || '';
  const img = splitDataUrl(dataUrl);
  if (!img) throw new Error('bad_image');
  let text;
  if (gateway.isConfigured()) {
    const r = await gateway.callModel({
      system: 'You read screenshots from the Alipay (支付宝) app and output only JSON.',
      max_tokens: 400,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } },
        { type: 'text', text: PROMPT },
      ]}],
    });
    text = gateway.extractText(r.content_blocks);
  } else if (apiKey) {
    text = await callAnthropic(apiKey, img.mediaType, img.base64);
  } else {
    throw new Error('no_api_key');
  }
  const out = parseJsonReply(text);
  if (!out || typeof out !== 'object') throw new Error('unparseable_reply');
  return {
    success: !!out.success,
    amount: (out.amount == null || isNaN(Number(out.amount))) ? null : Number(out.amount),
    payee: out.payee == null ? null : String(out.payee).slice(0, 120),
    paid_at: out.paid_at == null ? null : String(out.paid_at).slice(0, 40),
    txn_id: out.txn_id == null ? null : String(out.txn_id).replace(/\s+/g, '').slice(0, 64),
    raw_time_text: out.raw_time_text == null ? null : String(out.raw_time_text).slice(0, 60),
  };
}

module.exports = { readPaymentScreenshot, ocrAvailable, OCR_MODEL };
