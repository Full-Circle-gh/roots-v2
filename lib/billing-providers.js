// Mini App Backend — billing payment adapter (provider-agnostic).
//
// One small interface, many providers:
//   manual         — always available; bank-transfer + operator marks paid
//   wechat_native  — WeChat Pay v3 Native (QR scan). Full Circle's OWN merchant
//                    credentials (env). The out_trade_no is deterministic per
//                    invoice (FCSUB{id}) so the async callback can recover the
//                    invoice without extra storage. The AES-256-GCM auth tag
//                    on the callback payload is the primary security gate
//                    (same fail-open principle as ⑩ in retail.js).
//   alipay_native  — skeleton (not yet implemented)
//   stripe         — skeleton (not yet implemented)

'use strict';
const crypto = require('crypto');
const { qrPngDataUrl } = require('./qrpng');

// ── WeChat Pay v3 helpers (Full Circle platform merchant) ──────────────────
// These use Full Circle's OWN env credentials — subscription fees settle to
// Full Circle, never to a tenant. Mirrors the subset of retail.js needed for
// billing Native payments; kept self-contained to avoid coupling to retail.

function normalizePem(raw, label) {
  let s = (raw || '').replace(/\\n/g, '\n').trim();
  if (!s) return '';
  if (s.includes('BEGIN')) return s;
  const body = (s.replace(/\s+/g, '').match(/.{1,64}/g) || []).join('\n');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
}

// Sign an outbound request to api.mch.weixin.qq.com (WECHATPAY2-SHA256-RSA2048).
function wxBillingSign(method, urlPath, body) {
  const mchId    = process.env.WECHAT_PAY_MCH_ID       || '';
  const serialNo = process.env.WECHAT_PAY_SERIAL_NO     || '';
  const privKey  = normalizePem(process.env.WECHAT_PAY_PRIVATE_KEY, 'PRIVATE KEY');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce     = crypto.randomBytes(16).toString('hex');
  const bodyStr   = body ? JSON.stringify(body) : '';
  const message   = [method.toUpperCase(), urlPath, timestamp, nonce, bodyStr].join('\n') + '\n';
  const signature = crypto.createSign('RSA-SHA256').update(message).sign(privKey, 'base64');
  return `WECHATPAY2-SHA256-RSA2048 mchid="${mchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${serialNo}",signature="${signature}"`;
}

// Decrypt a WeChat Pay v3 callback resource (AES-256-GCM).
// The last 16 bytes of the base64-decoded ciphertext are the auth tag.
function decryptWxBillingCallback(resource) {
  const apiV3Key = process.env.WECHAT_PAY_API_V3_KEY || '';
  const buf      = Buffer.from(resource.ciphertext, 'base64');
  const authTag  = buf.slice(-16);
  const data     = buf.slice(0, -16);
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(apiV3Key, 'utf8'),
    Buffer.from(resource.nonce, 'utf8')
  );
  decipher.setAuthTag(authTag);
  decipher.setAAD(Buffer.from(resource.associated_data || '', 'utf8'));
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
}

// Deterministic out_trade_no per billing invoice (FCSUB + zero-padded id).
// Max 32 chars; parseable back to invoice_id without extra storage.
function subOutTradeNo(invoiceId) {
  return 'FCSUB' + String(invoiceId).padStart(8, '0');
}
function parseSubOutTradeNo(s) {
  if (!s || !s.startsWith('FCSUB')) return null;
  const n = parseInt(s.slice(5), 10);
  return isNaN(n) ? null : n;
}

// ── Amount helpers ─────────────────────────────────────────────────────────
function fmtAmount(invoice) {
  const cur = invoice.currency || 'CNY';
  const sym = cur === 'CNY' ? '¥' : cur + ' ';
  return sym + (Number(invoice.amount_cents || 0) / 100).toFixed(2);
}

// ── Provider table ─────────────────────────────────────────────────────────
const PROVIDERS = {
  manual: {
    id: 'manual',
    label: 'Manual / Bank transfer · 手动 / 银行转账',
    configured: () => true,
    async createCheckout(invoice /*, tenant */) {
      const amt = fmtAmount(invoice);
      const ref = invoice.invoice_no || ('#' + invoice.id);
      return {
        kind: 'manual',
        reference: ref,
        instructions_en: 'Transfer ' + amt + ' and send the receipt to your account manager, quoting reference ' + ref + '. We\'ll mark the invoice paid once the transfer is received.',
        instructions_cn: '请转账 ' + amt + '，并将凭证连同单号 ' + ref + ' 发送给您的客户经理。确认到账后我们会将发票标记为已付。',
      };
    },
  },

  // ── WeChat Pay v3 Native (QR scan) ──────────────────────────────────────
  // Requires: WECHAT_APP_ID, WECHAT_PAY_MCH_ID, WECHAT_PAY_API_V3_KEY,
  //           WECHAT_PAY_PRIVATE_KEY, WECHAT_PAY_SERIAL_NO
  wechat_native: {
    id: 'wechat_native',
    label: 'WeChat Pay (QR) · 微信支付',
    configured: () => !!(process.env.WECHAT_PAY_MCH_ID   &&
                         process.env.WECHAT_PAY_API_V3_KEY &&
                         process.env.WECHAT_PAY_PRIVATE_KEY &&
                         process.env.WECHAT_PAY_SERIAL_NO),
    async createCheckout(invoice /*, tenant */) {
      const mchId  = process.env.WECHAT_PAY_MCH_ID || '';
      const appId  = process.env.WECHAT_APP_ID || process.env.WECHAT_PAY_APP_ID || '';
      const out_trade_no = subOutTradeNo(invoice.id);
      const notifyUrl = 'https://rootskitchenchina.com/api/backend/billing/payment/wechat/callback';
      const body = {
        appid:         appId,
        mchid:         mchId,
        description:   'Full Circle subscription · 订阅费',
        out_trade_no,
        notify_url:    notifyUrl,
        amount:        { total: Number(invoice.amount_cents), currency: invoice.currency || 'CNY' },
      };
      const urlPath = '/v3/pay/transactions/native';
      const auth    = wxBillingSign('POST', urlPath, body);
      const resp    = await fetch('https://api.mch.weixin.qq.com' + urlPath, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept':       'application/json',
          'Authorization': auth,
          'User-Agent':   'WeChatPay-Node/1.0',
        },
        body: JSON.stringify(body),
      });
      const j = await resp.json();
      if (!j.code_url) {
        throw new Error((j.message || 'WeChat Pay error') + ' [' + (j.code || resp.status) + ']');
      }
      let qr_data_url = null;
      try { qr_data_url = qrPngDataUrl(j.code_url, { scale: 10, quiet: 4 }); } catch (_) {}
      return {
        kind: 'wechat_native',
        code_url: j.code_url,
        qr_data_url,
        out_trade_no,
        invoice_id: invoice.id,
        amount_cents: invoice.amount_cents,
        amount_display: fmtAmount(invoice),
      };
    },
  },

  alipay_native: {
    id: 'alipay_native',
    label: 'Alipay (QR) · 支付宝',
    configured: () => !!(process.env.ALIPAY_APP_ID && process.env.ALIPAY_PRIVATE_KEY),
    async createCheckout() {
      throw new Error('Alipay billing is not yet implemented');
    },
  },
  stripe: {
    id: 'stripe',
    label: 'Card (Stripe)',
    configured: () => !!process.env.STRIPE_SECRET_KEY,
    async createCheckout() {
      throw new Error('Stripe billing is not yet implemented');
    },
  },
};

// ── Public API ─────────────────────────────────────────────────────────────
function listProviders() {
  return Object.values(PROVIDERS).map(p => ({ id: p.id, label: p.label, configured: p.configured() }));
}

async function createCheckout(providerId, invoice, tenant) {
  const p = PROVIDERS[providerId];
  if (!p) throw new Error('Unknown payment provider: ' + providerId);
  if (!p.configured()) throw new Error(p.label + ' is not configured · 未配置');
  return p.createCheckout(invoice, tenant);
}

module.exports = {
  listProviders,
  createCheckout,
  fmtAmount,
  decryptWxBillingCallback,
  parseSubOutTradeNo,
};
