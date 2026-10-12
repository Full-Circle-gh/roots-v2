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

/* THE SAME GATE, FOR A DECISION THAT LIVES IN THE BODY.
 *
 * requiredCapFor() is given (method, path) and nothing else, which is right for
 * a choke point that runs before express.json() has parsed anything. But one
 * capability decision in this product cannot be made from a path: a FULL REFUND
 * travels through PATCH /orders/:id/status with `refunded` in the body, and
 * that path maps to `orders:edit` — the capability a cashier holds so they can
 * work the till. So the server would accept a full refund from an operator the
 * capability model says may not issue one, while the client correctly hid the
 * button (audit K-01 recorded exactly this and reserved the close).
 *
 * Handlers that need a body-dependent gate call this. It mirrors the choke
 * point's conditions rather than restating them loosely, because a second
 * almost-identical rule is how the two come to disagree:
 *
 *   • only where the tenant has switched enforcement ON (tenants.rbac_enforce)
 *   • the owner always bypasses
 *   • no resolved cap set means no gate — same fail-open as an unmapped route,
 *     so a resolution failure never hard-blocks a working operator
 *
 * `cap` is a key or an array (any-of — hold ANY one), exactly the two shapes
 * requiredCapFor() returns, read the way the choke point reads them.
 *
 * Returns TRUE when the request must be refused. */
function capDenied(req, cap) {
  if (!req || !cap) return false;
  if (Array.isArray(cap) && !cap.length) return false;
  if (!req.tenant || !req.tenant.rbac_enforce) return false;
  if (req.backendUser && req.backendUser.role === 'owner') return false;
  if (!req.caps || typeof req.caps.has !== 'function') return false;
  return Array.isArray(cap) ? !cap.some(k => req.caps.has(k)) : !req.caps.has(cap);
}

/* §300 — WHAT A PURCHASE ORDER'S STATUS PUT NEEDS, FROM THE STATUS IN ITS BODY.
 *
 * The path (PUT /purchases/:id/status) is the same for every target, so the
 * choke point can only say "either key" (requiredCapFor, below). The body
 * decides the rest, and the handler in routes/retail-purchasing.js asks this:
 *
 *   • Delivered — "everything arrived", the receiver's one-tap answer at the
 *     door (the phone's purchase-order sheet sends it). Either key.
 *   • anything else — placing (Ordered), back to draft (Requested), cancelling
 *     (Cancelled) — is the buyer's, `purchasing:edit`, as the desktop's
 *     Place order / Back to draft / Cancel order buttons already say. A
 *     receive-only account could send those through the API before this, and
 *     cancel an order or stand one down to draft (the parity survey's defect 1).
 */
/* §325 (Ash's answer to §302.7) — AND ONLY FROM AN ORDER ALREADY PLACED.
 * Given the order's CURRENT status as well, Delivered takes either key only
 * when that status is Ordered: the one state both screens draw "Everything
 * arrived" / "All arrived as ordered" in. From a draft (Requested), a
 * cancelled order, or one already Delivered — which is how a part-arrived order
 * is stored, from its first counted line on — it is the buyer's alone; the
 * receiver finishes a part-arrived order line by line through /receive, which
 * this does not touch. Without `current` (the check made before the order is
 * read) the answer is as before, and the handler asks again once it has read
 * the order. */
function purchaseStatusCap(status, current) {
  if (status !== 'Delivered') return 'purchasing:edit';
  if (current !== undefined && current !== 'Ordered') return 'purchasing:edit';
  return ['purchasing:edit', 'purchasing:receive'];
}

/* §325 — WHO MAY WRITE WHICH STOREFRONT SETTING (PUT /config).
 *
 * PUT /api/retail-admin/config takes any dotted key and stores any JSON, and
 * it matched no rule in requiredCapFor(), so any signed-in operator could
 * change any setting — fees, tax, tiers, points rules, pop-ups, legal text —
 * whether or not enforcement was on (the parity survey's defect 3).
 *
 * ONE ANY-OF FOR THE WHOLE ROUTE WOULD BE WRONG IN BOTH DIRECTIONS. Some twenty
 * screens write it, each its own family of keys, each opened by a different
 * key. A union broad enough to keep every screen working would let a pop-up
 * editor change the tax rate; anything narrower would take a working switch
 * from somebody. So the gate is per key family, decided in the handler from
 * the body (the choke point sees only the path — §302's reason exactly), and
 * every key in a body must pass its own family's gate.
 *
 * THE RULE IS §325.3: each family is gated on the key(s) that open EVERY
 * desktop and phone screen writing it today, as an any-of — plus the family's
 * own edit key where one exists, which admits nobody who could not already
 * write it before this. Nobody who can open a screen that makes a write loses
 * it. The callers are listed in the decision and pinned by
 * scripts/test_config_write_gates.js, which fails when a new caller appears.
 *
 * Returns a key list (any-of) or null (no gate). */
// The desktop Settings tab (01-core.js TAB_CAP.config). Its Shop, Push,
// Customer-service and Operations panels carry no gate of their own, so this
// is who can reach every control on them.
const SETTINGS_SCREEN = ['settings:shop', 'settings:push', 'settings:payments', 'stores:view',
  'shipping:config', 'delivery:view'];
// The phone's Settings (m.html ROUTE_CAP.settings), whose Features group flips
// six features.* switches.
const PHONE_SETTINGS_SCREEN = ['settings:shop', 'settings:push', 'settings:payments', 'stores:view',
  'shipping:config'];
// The Delivery panel (data-cap="delivery:view" on the desktop, ROUTE_CAP.delivery
// on the phone), plus the phone's Setup pair (ROUTE_CAP.setup): the desktop
// setup guide writes currency, pickup lead time and the delivery wizard's keys,
// and its rail row carries no gate of its own (01-core.js, beside TAB_CAP).
const SETUP_SCREEN = ['settings:shop', 'stores:view'];
const DELIVERY_PANEL = ['delivery:view', 'delivery:edit', ...SETUP_SCREEN];
const CONTENT_SCREENS = ['content:view', 'content:edit'];     // Snippets, About, Legal, FAQ
const CMS_EDITOR = ['content:edit', 'editor:edit'];           // cms.html / cms-mobile.html
/* §412.2 — WHERE MONEY GOES IS CHANGED ONLY WITH THE PAYMENTS PERMISSION.
 * Tax, the display currency, the manual-Alipay record and the WeChat Pay
 * merchant details take settings:payments alone (the owner holds every key).
 * Ash's call, overriding §325.3 for these writes only: it deliberately takes
 * them away from the other Settings keys, the setup pair and
 * integrations:manage, and the screens hide the controls to match. */
const PAYMENTS = ['settings:payments'];
const CONFIG_FAMILIES = {
  // Settings tab panels. Currency is also written by the setup guide, whose
  // pair (SETUP_SCREEN) is already inside SETTINGS_SCREEN.
  currency: PAYMENTS,                               // §412.2
  shop: SETTINGS_SCREEN, customer_service: SETTINGS_SCREEN, tax: PAYMENTS,
  system_alerts: SETTINGS_SCREEN, inventory: SETTINGS_SCREEN, product_page: SETTINGS_SCREEN,
  support: SETTINGS_SCREEN,                        // support.hidden is answered in configKeyCap
  // The Delivery panel, and the setup guide.
  delivery: DELIVERY_PANEL, fees: DELIVERY_PANEL, pickup: DELIVERY_PANEL,
  batch: DELIVERY_PANEL, fresh: DELIVERY_PANEL, notice: DELIVERY_PANEL,
  // Marketing, loyalty and content screens.
  popups: ['popups:view', 'popups:edit', 'popups:delete'],
  copy: CONTENT_SCREENS, legal: CONTENT_SCREENS, faq: CONTENT_SCREENS, about: CONTENT_SCREENS,
  social_proof: ['social:edit'], checkout: ['social:edit'],   // #upsell-card sits on Social proof
  sharing: ['sharing:edit'],
  points: ['loyalty:view', 'loyalty:edit'], roots_club: ['loyalty:view', 'loyalty:edit'],
  reviews: ['reviews:view', 'reviews:moderate'],
  // The mini-app editor.
  theme: CMS_EDITOR, tabBar: CMS_EDITOR, brand: CMS_EDITOR, me_page: CMS_EDITOR,
  // The product editor's cart notice, written only after the product's own
  // PATCH (products:edit) has succeeded, under the same Save.
  cart_notices: ['products:edit'],
};
// features.<key>: the feature's own page, and wherever else a switch for it is drawn.
const FEATURE_SCREENS = {
  membership:  ['loyalty:view', 'loyalty:edit', ...PHONE_SETTINGS_SCREEN],
  affiliate:   ['affiliate:view', 'affiliate:edit', ...PHONE_SETTINGS_SCREEN],
  reviews:     ['reviews:view', 'reviews:moderate', ...PHONE_SETTINGS_SCREEN],
  // The phone's Inbox (reviews:view | feedback:view) offers "Enable" for feedback.
  feedback:    ['feedback:view', 'feedback:moderate', 'reviews:view', ...PHONE_SETTINGS_SCREEN],
  socialProof: ['social:edit', ...PHONE_SETTINGS_SCREEN],
  faq:         ['content:view', 'content:edit', ...PHONE_SETTINGS_SCREEN],
  // Settings → Operations hosts these three (05-marketing.js FEATURE_HOMES).
  waste: SETTINGS_SCREEN, production: SETTINGS_SCREEN, lowStockHints: SETTINGS_SCREEN,
};
const NOTIF_CATEGORIES = ['broadcasts:view', 'broadcasts:send'];
// A key no family names: the union of every screen that writes this route, so
// an unlisted key closes only the account that can open none of them.
const ANY_CONFIG_SCREEN = [...new Set([
  ...Object.values(CONFIG_FAMILIES).flat(), ...Object.values(FEATURE_SCREENS).flat(), ...NOTIF_CATEGORIES,
])];
/* §325 (S2f) — THE LAST OPEN WRITES, EACH ON THE SCREENS THAT MAKE IT TODAY.
 *
 * The desktop Sales page (01-core.js TAB_CAP.sales). Its per-channel,
 * per-shop and per-cell open/close switches carry no gate of their own, and
 * the phone's Sales screen (ROUTE_CAP.sales, dashboard:view, already in this
 * list) draws the same per-shop and per-cell switches (§181, §253). */
const SALES_SCREEN = ['dashboard:view', 'meituan:view', 'guanyi:view', 'eleme:view', 'integrations:view'];
/* Opening and closing EVERYTHING, the online store or one shop
 * (/store-status/*). The desktop Settings → Operations panel draws those three
 * buttons for `settings:edit`, a key that does not exist, so nobody presses
 * them today; §326.2 brings them to the phone. They take the same keys as the
 * per-channel switches beside them on Sales, plus Settings', whose panel
 * they live in — one rule for every open/close, so a phone screen built on
 * either door is not born refused. Narrowing is Ash's (the decision says so). */
const OPEN_CLOSE = [...new Set([...SALES_SCREEN, ...SETTINGS_SCREEN])];
/* The product editor (product-editor.html): opened from Products
 * (products:view), from the desktop Editor tab (editor:view) and from the
 * mini-app editor (content:edit); its own save is products:edit. */
const PRODUCT_EDITOR = ['products:view', 'products:edit', 'editor:view', 'editor:edit', 'content:edit'];
/* PUT /integrations stores credentials per service, and each service's form
 * sits on a different panel, so the handler asks per service, the way PUT
 * /config asks per key (configKeyCap):
 *   • kd100, jd — Settings → Delivery (data-cap="delivery:view"), plus
 *     shipping:config, the "Configure shipping / print" key;
 *   • feie, spyun — the printer card in Settings → Operations;
 *   • wecom_app, aliyun_sms — Settings → Push;
 *   • nuonuo — no screen writes it today; invoicing's own key. */
const INTEGRATION_SERVICE_CAP = {
  kd100: ['delivery:view', 'delivery:edit', 'shipping:config'],
  jd:    ['delivery:view', 'delivery:edit', 'shipping:config'],
  feie: SETTINGS_SCREEN, spyun: SETTINGS_SCREEN,
  wecom_app: SETTINGS_SCREEN, aliyun_sms: SETTINGS_SCREEN,
  nuonuo: ['invoices:manage'],
};
const INTEGRATIONS_ANY = [...new Set(Object.values(INTEGRATION_SERVICE_CAP).flat())];
function integrationServiceCap(svc) {
  const k = String(svc || '');
  return (Object.prototype.hasOwnProperty.call(INTEGRATION_SERVICE_CAP, k) ? INTEGRATION_SERVICE_CAP[k] : INTEGRATIONS_ANY).slice();
}
/* POST /setup writes the setup guide's flags. `welcomeSeen` is set when the
 * first-login welcome is dismissed, which every operator sees, so it stays
 * open. The rest are steps of the guide (pickup confirmed, store opened, store
 * details done): the phone's Setup pair (ROUTE_CAP.setup); the desktop rail
 * row has no gate of its own (01-core.js, beside TAB_CAP) — the S2a edge. */
/* §412.2 — POST /channel-hub/miniapp/wechat-creds writes two kinds of field.
 * The mini program's login pair (AppID, AppSecret) decides who can sign in
 * and stays on integrations:manage; the WeChat Pay merchant details decide
 * where customers' money is paid to and take settings:payments. */
const WECHAT_LOGIN_FIELDS = ['appId', 'appSecret'];
const WECHAT_PAY_FIELDS = ['mchId', 'apiV3Key', 'privateKey', 'serialNo', 'platformPubKey'];
function wechatCredsFieldCap(field) {
  if (WECHAT_LOGIN_FIELDS.includes(field)) return 'integrations:manage';
  if (WECHAT_PAY_FIELDS.includes(field)) return 'settings:payments';
  return null;
}
function setupFlagCap(flag) {
  return flag === 'welcomeSeen' ? null : SETUP_SCREEN.slice();
}

/* §325 (S2g) — A STORE'S STOCK-STAFF SIGN-INS (routes/backend-team.js,
 * /api/backend/stores/:storeId/staff — add, remove, reset password). Not under
 * /api/retail-admin, so this map's choke point never saw them and any
 * signed-in operator could make them. Gated on every screen that makes them
 * today: the desktop's Settings → Operations → Stores list, whose "Stock
 * staff" button carries no gate of its own (so: the Settings tab's keys), and
 * the phone's store screen, which draws it for stores:edit or team:manage. */
const STORE_STAFF_WRITE = [...new Set([...SETTINGS_SCREEN, 'stores:edit', 'team:manage'])];
function storeStaffCap() { return STORE_STAFF_WRITE.slice(); }

/* §325 (S2l) — BILLING. Every /api/backend/billing* route took any signed-in
 * operator. The screens that read and press them today:
 *   • the desktop Billing page (public/backend-billing.html), whose door is the
 *     Settings link tagged data-cap="billing:view" — and the page itself draws
 *     Choose for whoever is on it, so billing:view can pay there today;
 *   • the phone's Billing screen (§325 X13): billing:view to open, billing:pay
 *     to choose.
 * So reads AND writes take either key; the owner holds every key. Two doors
 * to the desktop page carry no key at all (a suspended shop, and the
 * provisioning hold) — those are kept open in lib/require-cap.js
 * requireBillingAccess, not here, because they are about the shop, not the
 * operator. mark-paid and run-lifecycle stay SaaS-admin only; the WeChat
 * callback stays unauthenticated (its signature is the gate). */
const BILLING_SCREEN = ['billing:view', 'billing:pay'];
function billingCap() { return BILLING_SCREEN.slice(); }

/* §325 — PUTTING A DELETED RECORD BACK (POST /deleted/:id/restore).
 * Restoring re-creates whatever was deleted, so it takes the key that edits
 * that kind of record — the key the phone draws "Put it back" on, per kind.
 * The kind is in the stored copy, not the path, so the choke point lets the
 * union through (requiredCapFor, RESTORE_ANY) and routes/recycle.js asks this
 * once it has read the copy. The desktop's button is tagged with a key that
 * does not exist (settings:edit), so no desktop operator presses it today. */
const RESTORE_KIND_CAP = {
  delivery_zone:  ['delivery:edit'],
  finance_in:     ['finance:record'],
  finance_out:    ['finance:record'],
  voucher:        ['coupons:edit', 'coupons:delete'],
  purchase_order: ['purchasing:edit'],
};
const RESTORE_ANY = [...new Set(Object.values(RESTORE_KIND_CAP).flat())];
function restoreKindCap(kind) {
  const k = String(kind || '');
  return (Object.prototype.hasOwnProperty.call(RESTORE_KIND_CAP, k) ? RESTORE_KIND_CAP[k] : RESTORE_ANY).slice();
}
function configKeyCap(key) {
  const k = String(key || '');
  // The floating Support panel's "Hide" (retail-admin.html) is drawn for every
  // operator, whatever they hold. It stays open.
  if (k === 'support.hidden') return null;
  const dot = k.indexOf('.');
  const fam = dot === -1 ? k : k.slice(0, dot);
  if (fam === 'features') {
    const f = k.slice(dot + 1).split('.')[0];
    return (FEATURE_SCREENS[f] || ANY_CONFIG_SCREEN).slice();
  }
  if (fam === 'notifications') {
    // The automatic-update switches: the desktop's Broadcasts tab
    // (broadcasts:view) and the phone's Automatic updates (bcauto,
    // broadcasts:send). The template id and the webhook are Settings → Push.
    if (k === 'notifications.categories' || k.startsWith('notifications.categories.')) return NOTIF_CATEGORIES.slice();
    return SETTINGS_SCREEN.slice();
  }
  if (Object.prototype.hasOwnProperty.call(CONFIG_FAMILIES, fam)) return CONFIG_FAMILIES[fam].slice();
  return ANY_CONFIG_SCREEN.slice();
}

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
  /* §325 — THAT DELIBERATE CLOSE. The affiliate tab's other two writes, each
     gated on the keys that open every screen making it today (§325.3), so the
     lockout the note above feared does not happen:
       • PATCH /affiliate/settings — the desktop Affiliate tab (affiliate:view,
         01-core.js TAB_CAP) and the Share cards tab's invite card
         (sharing:edit, 10-extras.js SC_CARDS). The phone writes it too, since
         M8/M9: its Share cards screen saves the invite card here
         (m.html scCard 'share.invite', ROUTE_CAP sharecards: sharing:edit),
         so sharing:edit stays in this list for both.
       • PATCH /affiliate/referrals/:id — the Affiliate tab's referral rows.
     `affiliate:edit` rides along as the family's own key. What this closes is
     the account that can open neither screen. Narrowing either to
     affiliate:edit alone is Ash's call, recorded as open in the decision. */
  if (P === '/api/retail-admin/affiliate/settings') return ['affiliate:view', 'affiliate:edit', 'sharing:edit'];
  if (/^\/api\/retail-admin\/affiliate\/referrals\/\d+$/.test(P)) return ['affiliate:view', 'affiliate:edit'];

  /* §325 (S2f) — THE LAST OPEN WRITES (the constants above say whose screens).
     /setup and /integrations are decided in their handlers, per flag and per
     service, because the body says what is being written; the choke point
     lets the union through (null for /setup, whose welcome flag is open). */
  if (/^\/api\/retail-admin\/store-status\/(online|master|store\/[^/]+)$/.test(P)) return OPEN_CLOSE.slice();
  if (/^\/api\/retail-admin\/channel-status\/(cell|channel|location)$/.test(P)) return SALES_SCREEN.slice();
  if (P === '/api/retail-admin/alipay-manual') return PAYMENTS.slice();   // §412.2
  if (P === '/api/retail-admin/integrations') return INTEGRATIONS_ANY.slice();
  if (P === '/api/retail-admin/fapiao-settings') return 'invoices:manage';
  if (P === '/api/retail-admin/printer') return SETTINGS_SCREEN.slice();
  if (/^\/api\/retail-admin\/integrations\/qingyun\/(autopush|request)$/.test(P)) return ['delivery:view', 'delivery:edit'];
  if (P === '/api/retail-admin/setup') return null;
  if (/^\/api\/retail-admin\/page-templates(\/[^/]+)?$/.test(P)) return PRODUCT_EDITOR.slice();

  /* §325 (S2h) — THE TEST BUTTONS THAT SEND SOMETHING REAL. Each prints a
     ticket, sends an SMS or WeCom message, or calls a courier's API, and each
     matched no rule (S2f left them open as "store nothing"; they still reach a
     printer or a phone). Gated on the panel each button sits on, the same keys
     as the save beside it:
       • printer — the printer card, Settings → Operations;
       • kd100 / jd — the Delivery panel's tracking and JD views (the same
         keys integrationServiceCap gives their credentials);
       • aliyun_sms, the WeCom webhook, system alerts — Settings → Push. */
  if (P === '/api/retail-admin/printer/test') return SETTINGS_SCREEN.slice();
  if (/^\/api\/retail-admin\/integrations\/(kd100|jd)\/test$/.test(P)) return integrationServiceCap(P.split('/')[4]);
  // nuonuo: no screen presses it; invoicing's key, as for its credentials.
  if (P === '/api/retail-admin/integrations/nuonuo/test') return 'invoices:manage';
  if (P === '/api/retail-admin/integrations/aliyun_sms/test' ||
      P === '/api/retail-admin/wecom/test' ||
      P === '/api/retail-admin/system-alerts/test') return SETTINGS_SCREEN.slice();
  // §432 — the evening to-make message's group and time, and its test: a card
  // on Settings → Push beside the new-order webhook, so that panel's keys.
  if (P === '/api/retail-admin/kitchen-prep-message' ||
      P === '/api/retail-admin/kitchen-prep-message/test') return SETTINGS_SCREEN.slice();

  /* §325 — TWO MORE WRITES THAT MATCHED NOTHING.
     • Put a deleted record back: the union of the per-kind keys here, and the
       handler (routes/recycle.js) narrows it to the record's own kind through
       restoreKindCap() once it has read the copy.
     • Geocode every store and address now (spends the maps quota): its one
       button is in desktop Settings → Operations, which carries no gate of its
       own, so it takes the Settings tab's keys (SETTINGS_SCREEN). The phone's
       Operations only reads the counts. */
  if (/^\/api\/retail-admin\/deleted\/\d+\/restore$/.test(P)) return RESTORE_ANY.slice();
  if (P === '/api/retail-admin/inventory/geocode-backfill') return SETTINGS_SCREEN.slice();

  /* §325 — STOREFRONT SETTINGS. PUT /config is gated IN ITS HANDLER, per key
     family, by configKeyCap() above: the keys are in the body, which this
     function cannot see, and one any-of wide enough for the twenty screens that
     write it would hand the tax rate to a pop-up editor. Null here is
     deliberate, not an omission — the handler refuses before it writes.
     Its one sub-path is the Delivery panel's Guangzhou district chips
     (02-settings-ops.js), so it takes that panel's keys. */
  if (P === '/api/retail-admin/config') return null;
  if (P === '/api/retail-admin/config/gz-excluded-districts') return ['delivery:view', 'delivery:edit'];

  /* §325 — LOYALTY AND WALLET WRITES THAT MATCHED NOTHING. Each screen that
     makes them is gated, on the desktop (01-core.js TAB_CAP) and the phone
     (m.html ROUTE_CAP) alike, on the one key named here, so the gate is that
     key and nobody who can open the screen loses the write:
       • polls and the voting settings — Voting, voting:edit;
       • the leaderboard settings — Leaderboard, leaderboard:edit;
       • top-up packages, and marking a pending top-up paid (which credits a
         wallet) — Top-up / Wallet, topup:edit. */
  if (/^\/api\/retail-admin\/polls(\/\d+)?$/.test(P)) return 'voting:edit';
  if (P === '/api/retail-admin/voting/config') return 'voting:edit';
  if (P === '/api/retail-admin/leaderboard/config') return 'leaderboard:edit';
  if (/^\/api\/retail-admin\/topup-packages(\/\d+)?$/.test(P)) return 'topup:edit';
  if (/^\/api\/retail-admin\/topup-transactions\/\d+\/finalize$/.test(P)) return 'topup:edit';

  /* §325 — THE MINI-APP EDITOR (/cms/*), publish included. cms.html and
     cms-mobile.html open on `content:edit` (their own gate), and are the only
     callers of everything here except the picture upload; `editor:edit`
     ("Edit storefront pages") rides along as the editor's own key.
     THE UPLOAD IS SHARED: POST /cms/media also takes the category banner
     (categories:view), the customer-service QR (Settings), the pop-up picture
     (popups:view) and the About page's pictures (content:view) on the desktop,
     so it is the any-of of all of them, and of media:upload. Deleting a
     picture here has no caller on any screen, so it closes to the editor and
     media:delete without taking anything from anyone. */
  if (P.startsWith('/api/retail-admin/cms/')) {
    if (P === '/api/retail-admin/cms/media') {
      return [...CMS_EDITOR, 'media:upload', 'content:view', 'categories:view', 'categories:edit',
        'popups:view', 'popups:edit', ...SETTINGS_SCREEN];
    }
    if (P === '/api/retail-admin/cms/media/video') return [...CMS_EDITOR, 'media:upload'];
    if (isDelete && /^\/api\/retail-admin\/cms\/media\/[^/]+$/.test(P)) return [...CMS_EDITOR, 'media:delete'];
    return CMS_EDITOR.slice();
  }

  // §287 — a cashier marks a made-here item sold out from the till. Any-of:
  // the cashier's till:use, or the office's stores:edit, which already writes
  // the same switch from the Shops screen. NARROW ON PURPOSE, like the rule
  // above: the rest of /shops/* stays as it was, and this route is not born
  // fail-open.
  if (/^\/api\/retail-admin\/shops\/\d+\/listings\/\d+\/sold-out$/.test(P)) return ['till:use', 'stores:edit'];

  // Transfers between locations, and asking the kitchen to make something.
  //
  // NOT under /api/retail-admin/*. These routes predate that prefix and are
  // mounted at /api/restock/*, so they were only ever reachable by the kitchen
  // realm. They now accept a Tacet operator too (routes/restock.js), and this
  // map is what gates that half — the same choke point, the same tenant switch,
  // the same owner bypass as every other Tacet mutation.
  //
  // THREE KEYS, MAPPED BY WHAT THE REQUEST DOES rather than by URL shape:
  //   • settling a receipt is `receive` — it is the count that sets stock;
  //   • dispatching, retrying a dispatch and editing a line are `pick` —
  //     they are the picker's hands on the run;
  //   • creating, editing a draft, archiving and deleting are `request`.
  // A line edit is `pick` and not `request` deliberately: after the goods leave
  // it is refused outright, so the only time it is reachable is while somebody
  // is picking.
  //
  // Reads stay open, as everywhere in this file: what a screen SHOWS is the
  // client's job, and 403-ing a shared read breaks a permitted screen.
  if (P.startsWith('/api/restock')) {
    if (/\/receive$/.test(P)) return 'restock:receive';
    if (/\/retry-dispatch$/.test(P)) return 'restock:pick';
    // ANY-OF, because these two routes serve both ends of the request. Marking a
    // transfer prepared dispatches a van; marking a KITCHEN request prepared says
    // the food is made. Same URL, different jobs, and the URL cannot tell them
    // apart — which order it is only becomes knowable once the row is read. So
    // the coarse gate is any-of here, and routes/restock.js narrows it: an
    // operator holding fulfil WITHOUT pick is confined to kitchen requests.
    if (/\/(status)$/.test(P)) return ['restock:pick', 'restock:fulfil'];
    if (/\/item\/\d+$/.test(P)) return ['restock:pick', 'restock:fulfil'];
    return 'restock:request';
  }


  // Customers — money/identity actions split out from plain edits.
  if (P.startsWith('/api/retail-admin/customers')) {
    /* MATCH THE HYPHEN FORM TOO, and this is the same bug the refund line
       below already carries a note about. The two endpoints that move a
       customer's money are `/customers/:id/points-adjust` and
       `/customers/:id/wallet-adjust`. The old `(\/|$)` required a slash or the
       end of the path after the word, so `points-adjust` — a HYPHEN after
       `points` — never matched, and both fell through to `customers:edit`.

       `customers:adjust` exists, is marked `money: 'moves'` in
       lib/capabilities.js, and is what the role editor offers for exactly
       this. It simply gated nothing: an operator with plain customer-edit
       could add store credit or points to any account. Audit K-01 recorded it
       as a finding rather than an omission and reserved the close; this is
       that close. */
    if (/\/(points|wallet|credit|balance|adjust)(\/|-|$)/.test(P)) return 'customers:adjust';
    /* `reset-test` RIDES THIS LINE, and it is the most destructive thing in
       the file. It archives the customer's openid so their next silent
       mini-app login cannot match it and WeChat mints them a brand-new
       customer row: their orders, points, balance and addresses are all still
       here, and their phone can never reach any of it again.

       It used to fall through to `customers:edit` — the WEAKEST customer
       capability, the one most staff hold — because it matched none of the
       words above. That was survivable only while no button existed: the
       endpoint was reachable but unreachable, TESTING ONLY in a comment and
       nowhere else. A control in the drawer ends that, so the gate moves
       first.

       Narrowing refuses nobody who can do this today, which is what
       distinguishes it from the affiliate-block gap pinned in
       scripts/test_capability_gaps.js §4: that one is live and narrowing it
       would take a tool away from operators mid-shift. This one has no users
       to take it from. */
    if (/\/(block|unblock|logout|force-logout|reset-test)(\/|$)/.test(P)) return 'customers:block';
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
  /* §300 F5b, NARROWED BY §324 — THE AI READ AND ASK ON REPORTS
     (POST /reports/read, /reports/ask). Each is a billed model call that reads
     the period's figures back, revenue included. They matched no rule, so they
     fell through fail-open; F5b gated them on either key that opens a screen
     calling them. Ash then decided (§324): a Trend-only account does not get
     the AI read. So it is `reports:view` alone — the desktop Reports tab's key
     (01-core.js TAB_CAP), and the key the phone already drew the read for
     (m.html trendAiOn). Nobody who could see the read on either screen loses
     it. Exact paths, so nothing else under /reports rides on it. */
  if (/^\/api\/retail-admin\/reports\/(read|ask)$/.test(P)) return 'reports:view';
  if (P.startsWith('/api/retail-admin/invoices')) return 'invoices:manage';
  /* §300 F4b — THE FAPIAO FILE UPLOAD (POST /invoice-file), which stores the
     PDF or photo of an issued 发票 and hands back the URL that Mark issued then
     attaches to the order. It matched nothing above — `invoice-file` is not
     `invoices` — so it was an unmapped write and fell through fail-open: any
     signed-in operator could store a file, enforcement on or not.

     ANY-OF, AND DELIBERATELY SO: `invoices:manage` ("Issue / upload invoices")
     OR `orders:edit` — the key Mark issued (PUT /orders/:id/invoice, the /orders
     rule above) already takes. The upload is the first half of issuing, so it
     is gated on exactly the people who may already finish the act. Narrowing
     it to `invoices:manage` alone would take the upload away from the `staff`
     and `dispatch` presets, who can do it today; that is Ash's call, recorded
     as open in the decision, and not a session's to make overnight. What this
     closes is the account that holds neither. Callers: the desktop order
     drawer (07-content-billing.js uploadInvoicePdf) and the phone order sheet
     (m.html invFile, which draws its button for invoices:manage + orders:edit). */
  if (P === '/api/retail-admin/invoice-file') return ['invoices:manage', 'orders:edit'];

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
  /* No route lives under /flash or /popups: a flash sale is written through
     /products/:id/flash-sale (next rule) and the pop-ups through PUT /config
     (configKeyCap). These two lines gate nothing and are left for a route that
     may yet arrive there. */
  if (/^\/api\/retail-admin\/flash/.test(P))      return isDelete ? 'flash:delete'  : 'flash:edit';
  if (/^\/api\/retail-admin\/popups/.test(P))     return isDelete ? 'popups:delete' : 'popups:edit';
  /* §325 — THE FLASH-SALE KEYS NOW GATE THE FLASH SALE. PUT and DELETE
     /products/:id/flash-sale fell to the /products rule below, so `flash:edit`
     and `flash:delete` gated nothing, and the `marketing` preset — which holds
     every flash key and no products:edit — was refused on its own Flash sales
     screen. Now either key opens it: the flash key, or the products key that
     let the write through until today (products:edit for PUT, and
     products:delete for DELETE, which is what the /products rule answered for
     any DELETE). Nobody who could set or end a sale before loses it. Callers:
     the desktop Flash sales tab (07-content-billing.js), and since §325 M15
     the phone's Flash sales screen (m.html fsEndNow, fscStart, fscCancelSale). */
  if (/^\/api\/retail-admin\/products\/\d+\/flash-sale$/.test(P)) {
    return isDelete ? ['flash:delete', 'products:delete'] : ['flash:edit', 'products:edit'];
  }
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

  /* Recording a batch. `production:log` alone — deliberately NOT any-of with
     `quickstock:add`, even though the row it writes also moves the shelf.
     Holding the shelf key is permission to say what is ON a shelf; this is
     permission to state what a batch YIELDED, which is a claim about the
     kitchen's output and outlives the count. An account may grant the first and
     withhold this one, and that only means anything if the gate reads one key.
     (GET /production/reasons is a read and falls through allowed, like every
     other read here.) */
  if (P.startsWith('/api/retail-admin/production'))       return 'production:log';

  /* Asking the buyer to buy a material (§86). Its own key, for the reasons
     lib/capabilities.js states beside the grant: NOT `materials:edit`, which is
     the masterlist and its buy prices, and NOT `restock:request`, which moves
     Roots' own goods between Roots' own locations and spends nothing.

     THIS GATE COVERS THE ASK ONLY. Turning the ask into a purchase order is
     POST /api/retail-admin/purchases/from-material-requests, which falls under
     the /purchases rule below and is therefore `purchasing:edit` — the buyer's
     key, on the buyer's screen. The split is the whole design: the kitchen asks
     and the buyer spends.

     `material-requests` is NOT caught by the `/api/retail-admin/materials` rule
     further down — the next character after "material" is a hyphen, not an "s" —
     but the two are named closely enough that it is worth saying so here rather
     than leaving the next reader to check. */
  /* §300 — EXCEPT STRIKING A LINE OFF (§174), which is the BUYER's answer to
     the ask, not the kitchen's ask: "we are not buying this one". The desktop
     draws its ✕ for `purchasing:edit`, on the buyer's screen, and the route's
     own comment calls it the buyer's refusal. It sat under the rule below, so
     the buyer was refused and any cook was not (the parity survey's defect 2).
     Most specific first. The cook's own way to take an ask back is untouched:
     PUT /material-requests/:id/archive (withdraw the whole request) and
     PUT /material-requests/:id (edit a draft) stay `production:request`. */
  if (/^\/api\/retail-admin\/material-requests\/lines\/\d+\/decline$/.test(P)) return 'purchasing:edit';
  if (P.startsWith('/api/retail-admin/material-requests')) return 'production:request';

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
  /* §412.2 — the Mini App's credentials split by field. The payment keys'
     own check is all WeChat Pay, so it is settings:payments alone; the save
     carries either half, so the choke point admits either key and the
     handler asks per field (wechatCredsFieldCap). */
  if (P === '/api/retail-admin/channel-hub/miniapp/wechat-pay-verify') return 'settings:payments';
  if (P === '/api/retail-admin/channel-hub/miniapp/wechat-creds') return ['integrations:manage', 'settings:payments'];
  if (P.startsWith('/api/retail-admin/channel-hub')) return 'integrations:manage';
  /* §117 part two — the Channel sync page's own two writes, one path shape for
     all three channels. Pushing ONE item is the same verb as pushing all of
     them ({channel}:sync); turning an item's sync off changes its MAPPING,
     which is the verb the channel's own /products/:id/map already answers
     ({channel}:map). Placed above the three per-channel rules below because it
     is a different prefix and must not be read as one of them. An unmapped
     mutation fails OPEN here, so this rule is the gate, not a description of
     one. */
  {
    const cs = P.match(/^\/api\/retail-admin\/channel-sync\/([a-z]+)\/products\/\d+\/(push|sync)$/);
    if (cs) return cs[1] + (cs[2] === 'push' ? ':sync' : ':map');
  }
  if (P.startsWith('/api/retail-admin/meituan')) return /\/products\/\d+\/map/.test(P) ? 'meituan:map' : 'meituan:sync';
  /* §430 — checking gzgrocery's statement is a POST only because it carries a
     file; it writes nothing, so it asks for the Billing panel's own read key
     (§399), not the sync key every other gzgrocery POST needs. */
  if (P === '/api/retail-admin/guanyi/statement-check') return 'guanyi:view';
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
  // to either side HERE because the target is in the body, which this function
  // cannot see — the receiver marks "all arrived" (Delivered), the buyer moves
  // everything else, and the handler narrows it with purchaseStatusCap() above
  // (§300). Supplier records + PO create/edit stay buyer-only.
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

  // SKU codes (Settings → SKU codes). Numbering rules ARE the material
  // catalogue — an operator trusted to add a material is trusted to say how
  // materials are coded — so this reuses materials:edit rather than inventing a
  // capability nobody has been granted. When recipes and products join the
  // engine, split this on the :entity segment rather than widening it.
  if (P.startsWith('/api/retail-admin/sku/')) return 'materials:edit';

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

  // Expense claims (§87). NOT the line above, and the distance between the two
  // keys is the point: `finance:record` writes the ledger, this one writes a
  // claim that reaches no total until somebody approves it. The floor presets
  // hold this and none of them holds finance.
  //
  // TWO KEYS UNDER ONE PREFIX, AND THE ORDER OF THESE TWO LINES IS THE WHOLE
  // GUARD. Deciding a claim writes a row into `expense_entries`; submitting one
  // writes nothing anybody can spend. If the specific rule sat below the general
  // one, every submitter would be an approver — which is not what §87 part five
  // decided. It allows an APPROVER to approve their own claim; it does not make
  // everyone an approver, and the difference between those two sentences is the
  // two lines below being in this order.
  if (/^\/api\/retail-admin\/staff-expenses\/\d+\/decide$/.test(P)) return 'expenses:approve';
  // §90: reversing an already-approved claim. Its own key, checked before the
  // generic prefix below for the same reason `decide` is — the general rule
  // would otherwise gate this money-reversing route on `expenses:submit`, which
  // every floor role holds.
  if (/^\/api\/retail-admin\/staff-expenses\/\d+\/void$/.test(P)) return 'expenses:cancel';
  // §146: re-filing an approved claim under a different category. Above the
  // generic prefix for the third time and for the third identical reason — it
  // re-posts a ledger row, and the general rule would gate it on
  // `expenses:submit`, which every floor role holds.
  //
  // EITHER KEY, not a fourth of its own. The `bookkeeper` preset holds
  // `expenses:cancel` and not `expenses:approve`, so a single `approve` here
  // let the accountant remove a claim from the books entirely while refusing
  // them the heading it sits under. Re-filing moves no money and is strictly
  // less power than the void they already hold.
  if (/^\/api\/retail-admin\/staff-expenses\/\d+\/category$/.test(P)) {
    return ['expenses:approve', 'expenses:cancel'];
  }
  // §207: correcting who paid on an approved claim. Above the generic prefix for
  // the fourth time and for the fourth identical reason — and this one is the
  // sharpest case yet. It decides whether the business owes a person money, and
  // the general rule would gate it on `expenses:submit`, which every floor role
  // holds: the submitter of a claim could then mark their own approved claim as
  // own-money and conjure a debt the shop would pay out.
  //
  // `expenses:approve` ALONE, not §146's either-key. Re-filing renames a heading
  // and moves nothing; this moves the debt, which is `/settle`'s axis, and
  // `/settle` is an approver's call.
  if (/^\/api\/retail-admin\/staff-expenses\/\d+\/paid-by$/.test(P)) return 'expenses:approve';
  // §270: approving several not-arrived claims onto ONE purchase order. It is
  // `/decide` for several claims at once, so it takes `/decide`'s key, and it
  // sits above the generic prefix for the reason every line above does.
  if (P === '/api/retail-admin/staff-expenses/approve-together') return 'expenses:approve';
  if (P.startsWith('/api/retail-admin/staff-expenses')) return 'expenses:submit';

  if (P.startsWith('/api/retail-admin/waste')) {
    if (/\/void(\/|$)/.test(P)) return 'waste:void';
    // §465: re-pricing past entries moves money the way a void does. The
    // route also checks waste:void and waste:costs itself, for every tenant.
    if (P === '/api/retail-admin/waste/recalculate') return 'waste:void';
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

module.exports = { requiredCapFor, storeIdFromPath, capDenied, purchaseStatusCap, configKeyCap, restoreKindCap, integrationServiceCap, setupFlagCap, storeStaffCap, billingCap, wechatCredsFieldCap, WECHAT_LOGIN_FIELDS, WECHAT_PAY_FIELDS };
