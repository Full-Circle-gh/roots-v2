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
  // Unfinished New-order forms. Mapped EXPLICITLY and listed before the orders
  // prefix, because '/order-drafts' does not start with '/orders' — without this
  // line it falls through unmapped, and unmapped mutations are allowed. Same
  // capability as creating the order the draft becomes: someone who may not write
  // an order has no business keeping a half-written one either.
  if (P.startsWith('/api/retail-admin/order-drafts')) return 'orders:edit';
  // What a manual order's delivery and packing fees WOULD be. Mapped for the
  // SAME reason as the drafts line above, and missed for the same reason:
  // '/order-fees' does not start with '/orders' either, so it fell through
  // unmapped, and unmapped mutations are allowed. It is a POST that computes a
  // quote and writes nothing, so the fail-open cost no data — but it prices an
  // order from the live zone catalogue, and it is reachable only from the page
  // that creates one. Same capability as creating that order.
  if (P.startsWith('/api/retail-admin/order-fees')) return 'orders:edit';
  // Orders.
  if (P.startsWith('/api/retail-admin/orders')) {
    // Booking a same-city courier debits the store's prepaid account balance —
    // real money out. Gated apart from plain order edits so an order-note editor
    // can't spend. /qingyun/dispatch is the only path that calls the broker
    // (the generic /shipments/:sid/dispatch just flips a DB status).
    if (/\/qingyun\/dispatch(\/|$)/.test(P)) return 'orders:dispatch_courier';
    // Refund actions. Match the hyphen alias too: /refund-reject is the SAME
    // handler as /refund/reject — the old /refund(\/|$) missed the hyphen form
    // and let a refund action through on orders:edit.
    if (/\/refund(\/|-|$)/.test(P)) return 'orders:refund';
    return 'orders:edit';
  }
  if (P.startsWith('/api/retail-admin/invoices')) return 'invoices:manage';

  // Marketing.
  // Revoking an issued voucher lives at /voucher-grants/:id (DELETE). The
  // (coupons|vouchers) prefix below misses it (voucher-grants ≠ vouchers), so
  // without this line it fell through unmapped = allowed. Revoke = coupons:grant
  // (the "issue / revoke to customers" cap), NOT coupons:delete (which is about
  // deleting the coupon definition itself).
  if (P.startsWith('/api/retail-admin/voucher-grants')) return 'coupons:grant';
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
    // Duplicate writes a NEW product row (the handler blocks it for upstream
    // catalogs precisely because it's a create) — so it needs products:create,
    // not products:edit, or an edit-only operator could create by duplicating.
    if (m === 'POST' && /\/duplicate(\/|$)/.test(P)) return 'products:create';
    if (isDelete) return 'products:delete';
    return 'products:edit';
  }
  // Includes /category-tree (PUT rewrites the whole tree) — a distinct path from
  // /categories that the plain prefix missed, leaving the tree editor ungated.
  if (P.startsWith('/api/retail-admin/categories') ||
      P.startsWith('/api/retail-admin/category-tree')) return 'categories:edit';

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
  // The channels hub itself (set up / connect / pause / disconnect / help).
  // NOTE: distinct prefix from retail.js's existing /integrations credential
  // config — don't broaden this to /integrations or it re-gates those.
  if (P.startsWith('/api/retail-admin/channel-hub')) return 'integrations:manage';
  if (P.startsWith('/api/retail-admin/meituan')) return /\/products\/\d+\/map/.test(P) ? 'meituan:map' : 'meituan:sync';
  if (P.startsWith('/api/retail-admin/guanyi'))  return /\/(products\/\d+\/map|auto-match)/.test(P) ? 'guanyi:map' : 'guanyi:sync';
  if (P.startsWith('/api/retail-admin/eleme'))   return /\/products\/\d+\/map/.test(P) ? 'eleme:map' : 'eleme:sync';

  // Purchasing (buying dept). Receiving goods is a store-ops verb (store
  // managers hold purchasing:receive but not :edit); status flips are allowed
  // to either side — the receiver marks "all arrived" (Delivered), the buyer
  // moves everything else. Supplier records + PO create/edit stay buyer-only.
  if (P.startsWith('/api/retail-admin/purchases')) {
    if (/\/receive(\/|$)/.test(P)) return 'purchasing:receive';
    if (/\/status(\/|$)/.test(P))  return ['purchasing:edit', 'purchasing:receive'];
    return 'purchasing:edit';
  }
  if (P.startsWith('/api/retail-admin/suppliers')) return 'purchasing:edit';

  // Materials masterlist. Reads are open like every other read here; the write
  // verbs (create / edit / archive) are one capability — an operator who can add
  // a material can archive one, the same way purchasing:edit covers both.
  if (P.startsWith('/api/retail-admin/materials')) return 'materials:edit';

  // AI brand studio. The generate/apply/publish routes live under /brand/* (not
  // /ai/*), so the /ai prefix alone missed the entire studio — /brand/publish
  // goes LIVE to shoppers and was ungated. Map both prefixes.
  if (P.startsWith('/api/retail-admin/ai') ||
      P.startsWith('/api/retail-admin/brand')) return /(publish|export)/.test(P) ? 'ai:publish' : 'ai:generate';

  // Delivery.
  if (/^\/api\/retail-admin\/(delivery|zones)/.test(P)) return isDelete ? 'delivery:delete' : 'delivery:edit';

  // Content.
  // bulk-delete is a POST (not DELETE), so the method check alone under-gates it
  // to media:upload — force delete when the path says delete.
  if (P.startsWith('/api/retail-admin/media')) {
    if (isDelete || /\/bulk-delete(\/|$)/.test(P)) return 'media:delete';
    return 'media:upload';
  }
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
