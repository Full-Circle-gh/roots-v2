// Route → capability map for server-side enforcement (Phase 2).
//
// Applied at the single choke point every /api/retail-admin/* endpoint shares:
// requireRetailAdmin (routes/retail.js), and only when the tenant has switched
// enforcement ON (tenants.rbac_enforce).
//
// DESIGN — enforce MUTATIONS, leave reads open:
//   • Writes (POST/PUT/PATCH/DELETE) are gated on a capability — this is the
//     security-critical "can't DO" half (no unauthorized refund / coupon grant /
//     stock push / settings change).
//   • Reads (GET) return null here = allowed. "Can't SEE" is handled in the
//     client (applyCapGates hides whole sections), so we never risk 403-ing a
//     shared read (a store picker, the order drawer's customer lookup, a
//     dashboard channel-status poll) and breaking an otherwise-permitted screen.
//   • Anything unmapped returns null = allowed (fail-open), so a route we forgot
//     never hard-blocks a working operator. Owner bypasses this entirely.
//
// Return value: a capability key (string), an array (any-of — hold ANY one), or
// null (no gate). Keep the most specific rule first within each section.

'use strict';

function requiredCapFor(method, path) {
  const m = String(method || '').toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return null;   // reads open
  const P = String(path || '');
  const isDelete = m === 'DELETE';

  // Customers — money/identity actions split out from plain edits.
  if (P.startsWith('/api/retail-admin/customers')) {
    if (/\/(points|wallet|credit|balance|adjust)(\/|$)/.test(P)) return 'customers:adjust';
    if (/\/(block|unblock|logout|force-logout)(\/|$)/.test(P)) return 'customers:block';
    return 'customers:edit';
  }
  // Orders.
  if (P.startsWith('/api/retail-admin/orders')) {
    if (/\/refund(\/|$)/.test(P)) return 'orders:refund';
    return 'orders:edit';
  }
  if (P.startsWith('/api/retail-admin/invoices')) return 'invoices:manage';

  // Marketing.
  if (/^\/api\/retail-admin\/(coupons|vouchers)/.test(P)) {
    if (/\/(grant|revoke|grants)(\/|$)/.test(P)) return 'coupons:grant';
    if (isDelete) return 'coupons:delete';
    if (m === 'POST' && /\/(coupons|vouchers)\/?$/.test(P)) return 'coupons:create';
    return 'coupons:edit';
  }
  if (/^\/api\/retail-admin\/flash/.test(P))      return isDelete ? 'flash:delete'  : 'flash:edit';
  if (/^\/api\/retail-admin\/popups/.test(P))     return isDelete ? 'popups:delete' : 'popups:edit';
  if (/^\/api\/retail-admin\/broadcasts/.test(P)) return 'broadcasts:send';

  // Catalog.
  if (P.startsWith('/api/retail-admin/products')) {
    if (m === 'POST' && /\/products\/?$/.test(P)) return 'products:create';
    if (isDelete) return 'products:delete';
    return 'products:edit';
  }
  if (P.startsWith('/api/retail-admin/categories')) return 'categories:edit';

  // Inventory / stock writes — shared by the Quick Stock app AND the admin stock
  // modal, so any of the stock-capable caps passes.
  if (/^\/api\/retail-admin\/stores\/\d+\/stock/.test(P)) return ['quickstock:recount', 'quickstock:add', 'products:edit'];
  if (P.startsWith('/api/retail-admin/quick-stock'))      return ['quickstock:recount', 'quickstock:add'];

  // Stores.
  if (/^\/api\/retail-admin\/stores(\/|$)/.test(P)) return isDelete ? 'stores:delete' : 'stores:edit';

  // Settings.
  if (P.startsWith('/api/retail-admin/settings')) {
    if (/payment/.test(P)) return 'settings:payments';
    if (/push/.test(P))    return 'settings:push';
    return 'settings:shop';
  }

  // Channels (mutations only — reads open so dashboards/pickers never 403).
  // The integrations hub itself (set up / connect / pause / disconnect / help).
  if (P.startsWith('/api/retail-admin/integrations')) return 'integrations:manage';
  if (P.startsWith('/api/retail-admin/meituan')) return /\/products\/\d+\/map/.test(P) ? 'meituan:map' : 'meituan:sync';
  if (P.startsWith('/api/retail-admin/guanyi'))  return /\/(products\/\d+\/map|auto-match)/.test(P) ? 'guanyi:map' : 'guanyi:sync';
  if (P.startsWith('/api/retail-admin/eleme'))   return /\/products\/\d+\/map/.test(P) ? 'eleme:map' : 'eleme:sync';

  // AI brand studio.
  if (P.startsWith('/api/retail-admin/ai')) return /(publish|export)/.test(P) ? 'ai:publish' : 'ai:generate';

  // Delivery.
  if (/^\/api\/retail-admin\/(delivery|zones)/.test(P)) return isDelete ? 'delivery:delete' : 'delivery:edit';

  // Content.
  if (P.startsWith('/api/retail-admin/media'))    return isDelete ? 'media:delete' : 'media:upload';
  if (P.startsWith('/api/retail-admin/reviews'))  return 'reviews:moderate';
  if (P.startsWith('/api/retail-admin/feedback')) return 'feedback:moderate';

  return null;   // unmapped → allowed
}

// A store id embedded in a store-scoped path, for the scope check. Returns a
// number or null.
function storeIdFromPath(path) {
  const m = String(path || '').match(/^\/api\/retail-admin\/stores\/(\d+)(?:\/|$)/);
  return m ? parseInt(m[1], 10) : null;
}

module.exports = { requiredCapFor, storeIdFromPath };
