// The tenant's brand as the shop shows it: the name on payment screens and
// receipts, whether the "runs on tacet" credit prints, and the logo URL for
// emails. Moved out of routes/retail.js unchanged (decisions §477).
'use strict';

const db = require('../database');
const { currentTenantId, ROOTS_TENANT_ID } = require('./tenant-db');

// Brand label for customer-visible payment strings (WeChat description, Alipay
// subject). Roots → "Roots" (unchanged); a tenant → its own brand_name, so a
// shopper's payment screen never reads another company's name. (⑦ de-Roots.)
function tenantBrandLabel() {
  const tid = currentTenantId();
  if (tid === ROOTS_TENANT_ID) return 'Roots';
  try {
    const t = db.prepare('SELECT brand_name, name FROM tenants WHERE id = ?').get(tid);
    return (t && (t.brand_name || t.name)) || 'Store';
  } catch { return 'Store'; }
}

// Co-brand: does this tenant show the "runs on tacet" credit? On for every
// non-Roots tenant unless the platform cleared brand_credit (white-label).
function tenantPrintCredit() {
  try {
    const tid = currentTenantId();
    if (!tid || tid === ROOTS_TENANT_ID) return false;
    const t = db.prepare('SELECT brand_credit FROM tenants WHERE id = ?').get(tid);
    return !t || t.brand_credit !== 0;
  } catch { return false; }
}

// Absolute URL to the tenant's logo for use in emails (customer inbox has no
// session, so the brand read endpoint is public + tenant-keyed). '' when the
// tenant has no logo or we can't resolve the host — the email just shows the name.
function tenantBrandLogoUrl(req) {
  try {
    const tid = currentTenantId();
    if (!tid || tid === ROOTS_TENANT_ID || !req) return '';
    const t = db.prepare('SELECT brand_logo_data, brand_updated_at FROM tenants WHERE id = ?').get(tid);
    if (!t || !t.brand_logo_data) return '';
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (!host) return '';
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const stamp = t.brand_updated_at ? +new Date(t.brand_updated_at) : 0;
    return `${proto}://${host}/api/backend/brand/${tid}/logo?v=${stamp}`;
  } catch { return ''; }
}

module.exports = { tenantBrandLabel, tenantPrintCredit, tenantBrandLogoUrl };
