// Mini App Backend — billing payment adapter (provider-agnostic).
//
// One small interface, many providers. Only `manual` works without any
// credentials (the SaaS owner records an offline / bank-transfer payment and
// marks the invoice paid). wechat_native / alipay_native / stripe are
// skeletons: they advertise themselves but refuse to create a checkout until
// their credentials are present in the environment. This lets the whole
// subscription lifecycle be exercised today, and a real provider drops in
// later by filling its createCheckout() + a webhook handler.

function fmtAmount(invoice) {
  const cur = invoice.currency || 'CNY';
  const sym = cur === 'CNY' ? '¥' : cur + ' ';
  return sym + (Number(invoice.amount_cents || 0) / 100).toFixed(2);
}

const PROVIDERS = {
  manual: {
    id: 'manual',
    label: 'Manual / Bank transfer · 手动 / 银行转账',
    configured: () => true,
    async createCheckout(invoice /*, tenant */) {
      const amt = fmtAmount(invoice);
      return {
        kind: 'manual',
        reference: invoice.invoice_no || ('#' + invoice.id),
        instructions_en: 'Transfer ' + amt + ' and send the receipt to your account manager, quoting reference ' + (invoice.invoice_no || ('#' + invoice.id)) + '. We mark the invoice paid once the transfer is received.',
        instructions_cn: '请转账 ' + amt + ',并将凭证连同单号 ' + (invoice.invoice_no || ('#' + invoice.id)) + ' 发送给您的客户经理。确认到账后我们会将发票标记为已付。',
      };
    },
  },

  // ── Credential-gated skeletons ─────────────────────────────────────────
  wechat_native: {
    id: 'wechat_native',
    label: 'WeChat Pay (QR) · 微信支付',
    configured: () => !!process.env.WECHAT_PAY_MCH_ID && !!process.env.WECHAT_PAY_API_V3_KEY,
    async createCheckout() {
      // TODO: v3 /pay/transactions/native → returns a code_url to render as QR.
      // Reuse the merchant signer already in routes/retail.js (JSAPI) — Native
      // shares the same merchant credentials, different endpoint.
      throw new Error('WeChat Pay Native is not configured · 微信支付未配置 (set WECHAT_PAY_MCH_ID + WECHAT_PAY_API_V3_KEY + cert env vars)');
    },
  },
  alipay_native: {
    id: 'alipay_native',
    label: 'Alipay (QR) · 支付宝',
    configured: () => !!process.env.ALIPAY_APP_ID && !!process.env.ALIPAY_PRIVATE_KEY,
    async createCheckout() {
      // TODO: alipay.trade.precreate → returns a qr_code string to render.
      throw new Error('Alipay is not configured · 支付宝未配置 (set ALIPAY_APP_ID + ALIPAY_PRIVATE_KEY)');
    },
  },
  stripe: {
    id: 'stripe',
    label: 'Card (Stripe)',
    configured: () => !!process.env.STRIPE_SECRET_KEY,
    async createCheckout() {
      // TODO: Stripe Checkout Session / Payment Intent → return the hosted URL.
      throw new Error('Stripe is not configured (set STRIPE_SECRET_KEY)');
    },
  },
};

// Public, catalogue-friendly list (no secrets) — drives the checkout picker.
function listProviders() {
  return Object.values(PROVIDERS).map(p => ({ id: p.id, label: p.label, configured: p.configured() }));
}

// Create a normalized checkout descriptor for one invoice via one provider.
async function createCheckout(providerId, invoice, tenant) {
  const p = PROVIDERS[providerId];
  if (!p) throw new Error('Unknown payment provider: ' + providerId);
  if (!p.configured()) throw new Error(p.label + ' is not configured · 未配置');
  return p.createCheckout(invoice, tenant);
}

module.exports = { listProviders, createCheckout, fmtAmount };
