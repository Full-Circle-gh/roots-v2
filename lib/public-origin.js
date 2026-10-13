// The site's public origin, and the WeChat Pay notify URL it is derived from.
// Moved out of routes/retail.js unchanged (decisions §477): the payment code
// and the content gate's image check both build URLs on it, so it lives in one
// place both can require.
'use strict';

const WECHAT_PAY_NOTIFY_URL    = process.env.WECHAT_PAY_NOTIFY_URL || 'https://rootskitchenchina.com/api/retail/payment/wechat/callback';

// Public origin for tenant async-notify URLs — the same server/domain as Roots
// (single-server SaaS), just a tenant-scoped path. Derived from Roots' notify
// URL so there's no new config to set; WeChat Pay v3 accepts any HTTPS URL.
const PAY_NOTIFY_ORIGIN = (() => {
  try { return new URL(WECHAT_PAY_NOTIFY_URL).origin; } catch { return 'https://rootskitchenchina.com'; }
})();

module.exports = { WECHAT_PAY_NOTIFY_URL, PAY_NOTIFY_ORIGIN };
