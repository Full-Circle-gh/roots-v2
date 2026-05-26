// Public storefront tenant resolver (Phase 2 — public mini-app routing).
//
// Customer-facing /api/retail/* requests carry no backend login, so we can't
// tell which company's storefront a shopper is in from a session. Instead each
// tenant runs its OWN WeChat mini-program, and the mini-app sends its AppID on
// every request (header `x-wx-appid`, from wx.getAccountInfoSync()). We map
// AppID → tenant and run the request inside that tenant's data scope, so
// tdb() (in retail.js + lib/inventory.js) reads that tenant's catalogue/orders.
//
// Fail-safe by design: anything we can't positively map to an ACTIVE, NON-Roots
// tenant falls through with NO scope → the global db (Roots). So Roots' live
// storefront is completely unaffected (it sends no such header / its AppID maps
// to tenant #1, which we treat as the default), and a forged AppID can at worst
// land on Roots' own public catalogue — never another tenant's customer data
// (auth tokens live in each tenant's own DB, so a mismatched token just fails).

const db = require('../database');
const { getTenantDb, tenantAls, ROOTS_TENANT_ID } = require('../lib/tenant-db');

// Resolve the tenant for a public request, or null for "default (Roots)".
function resolvePublicTenant(req) {
  try {
    const appid = String(req.get('x-wx-appid') || '').trim();
    if (!appid) return null;
    const t = db.prepare('SELECT id, status FROM tenants WHERE wx_appid = ?').get(appid);
    if (t && t.status === 'active' && t.id !== ROOTS_TENANT_ID) return t.id;
  } catch (e) { /* wx_appid column not present yet → fall through to Roots */ }
  return null;
}

// Express middleware for the public /api/retail/* surface. Enters the tenant's
// ALS scope only for a recognised non-Roots tenant; otherwise it's a no-op and
// the request runs on the global db exactly as before.
function publicTenantScope(req, res, next) {
  const tid = resolvePublicTenant(req);
  if (!tid) return next();
  return tenantAls.run(getTenantDb(tid), () => next());
}

module.exports = { publicTenantScope, resolvePublicTenant };
