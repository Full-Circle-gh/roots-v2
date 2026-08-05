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

// Routed through the database seam (lib/db-seam.js). No converter is installed,
// so this is a zero-cost passthrough; the point is that this file is now on the
// covered side of the boundary. Proven by scripts/diagnose_seam_batch.js.
const { seam } = require('../lib/db-seam');
const db = seam(require('../database'));
const { getTenantDb, rawTenantDb, tenantAls, ROOTS_TENANT_ID } = require('../lib/tenant-db');

// Normalize a Host header to a bare lowercased hostname (strip any :port).
function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/:\d+$/, '');
}

// Look up an ACTIVE storefront domain → its owning tenant, regardless of which
// tenant it is (including Roots #1). Returns { tenantId } or null. Used by the
// SERVING decision in server.js ("is this host a storefront at all?"), which
// must fire for Roots' own website too — unlike resolveTenantByHost below,
// which collapses Roots to the default (global) data scope.
function lookupStorefrontHost(host) {
  try {
    const h = normalizeHost(host);
    if (!h) return null;
    const row = db.prepare(
      `SELECT t.id AS tenant_id, t.status AS tenant_status
         FROM tenant_domains d JOIN tenants t ON t.id = d.tenant_id
        WHERE d.host = ? AND d.status = 'active'`
    ).get(h);
    if (row && row.tenant_status === 'active') return { tenantId: row.tenant_id };
  } catch (e) { /* tenant_domains not present yet → not a storefront host */ }
  return null;
}

// Resolve a Host to the tenant DATA scope: a non-Roots active tenant id, or
// null (= default/global db, which IS Roots). Mirrors the AppID semantics.
function resolveTenantByHost(host) {
  const m = lookupStorefrontHost(host);
  if (m && m.tenantId !== ROOTS_TENANT_ID) return m.tenantId;
  return null;
}

// Resolve the tenant for a public request, or null for "default (Roots)".
// Two signals, checked in order: the mini-app's AppID header, then (for the
// browser website, which sends no such header) the request Host.
function resolvePublicTenant(req) {
  try {
    const appid = String(req.get('x-wx-appid') || '').trim();
    if (appid) {
      const t = db.prepare('SELECT id, status FROM tenants WHERE wx_appid = ?').get(appid);
      if (t && t.status === 'active' && t.id !== ROOTS_TENANT_ID) return t.id;
    }
  } catch (e) { /* wx_appid column not present yet → fall through */ }
  return resolveTenantByHost(req.hostname || req.get('host'));
}

// Express middleware for the public /api/retail/* surface. Enters the tenant's
// ALS scope only for a recognised non-Roots tenant; otherwise it's a no-op and
// the request runs on the global db exactly as before.
function publicTenantScope(req, res, next) {
  const tid = resolvePublicTenant(req);
  if (!tid) return next();
  return tenantAls.run(rawTenantDb(tid), () => next());
}

module.exports = {
  publicTenantScope, resolvePublicTenant,
  resolveTenantByHost, lookupStorefrontHost, normalizeHost,
};
