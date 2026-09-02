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

  // Who earns the ongoing referral share. Deciding this hands one customer a
  // cut of other people's future orders, so it is a money decision and it is
  // gated on the capability that already means "edit affiliate rules".
  //
  // NARROW ON PURPOSE. The rest of /api/retail-admin/affiliate/* is still
  // unmapped and therefore still fail-open, including PATCH .../settings. That
  // is a pre-existing gap and closing it here would retroactively start 403-ing
  // operators on a screen they can use today, on any tenant with rbac_enforce
  // on — a lockout shipped as a side effect of an unrelated feature. Mapping
  // only the new route means no existing behaviour changes and the new control
  // is not born fail-open. The wider gap is worth closing deliberately, on its
  // own, with the affiliate tab's other writes surveyed alongside it.
  if (P.startsWith('/api/retail-admin/affiliate/eligible')) return 'affiliate:edit';

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

  // Supplier invoices (发票). Its own capability, checked BEFORE the
  // /purchases rule below so a path like .../purchasing/po/7/no-invoice is
  // gated as invoice work rather than as PO editing. The old /bills routes
  // had no mapping at all, which meant they fell through to the fail-open
  // default for unmapped mutations.
  if (P.startsWith('/api/retail-admin/purchasing/')) return 'purchasing:invoices';
  // A read, so purchasing:view — the blanket /suppliers rule below is
  // purchasing:edit and would gate looking at a QR behind editing vendors.
  if (/^\/api\/retail-admin\/suppliers\/\d+\/channel-qr$/.test(P)) return 'purchasing:view';

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

  // Recipes (§29). Same shape as Materials just above — write verbs are one
  // capability. Not reachable from any UI yet (routes/retail-recipes.js), but
  // mapped now so enforcement is correct the moment a client calls it.
  if (P.startsWith('/api/retail-admin/recipes')) return 'recipes:edit';

  // Waste (§32). TWO write verbs, and the specific one is first: VOIDING IS
  // NOT RECORDING. A void removes a recorded loss from every total, so an
  // operator trusted to write off a dropped jar is not thereby trusted to make
  // one disappear — that separation is the whole reason there are three
  // capabilities rather than two, and collapsing these two rules would undo it.
  //
  // The reads stay open like every other read here, per this file's design note.
  // What matters for waste specifically is what they are NOT gated on: the
  // kitchen screen's picker sits behind the `products` permission while its own
  // screen sits behind `waste`, so the default grant (waste on, products off)
  // hands a waste-only user an empty picker — H13 in the waste survey. The
  // picker here is reached through requireRetailAdmin and consults no products
  // permission at any layer.
  // Finance — typing a ledger row is what the business says it earned and
  // spent, so the write half is gated apart from the read half. Reads stay
  // open per this file's design; `finance:view` hides the surface client-side.
  if (P.startsWith('/api/retail-admin/finance/')) return 'finance:record';

  if (P.startsWith('/api/retail-admin/waste')) {
    if (/\/void(\/|$)/.test(P)) return 'waste:void';
    return 'waste:record';
  }

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
