# Web Storefront — Build Plan

**Goal:** Every Full Circle tenant can offer a **browser website** alongside (or instead of)
their WeChat mini-app. Both surfaces are driven by the **same per-tenant backend**, so content
edited once in the Mini App Backend / CMS appears on both. The website targets **non-WeChat users**
(browsers, no WeChat required). Fulfillment stays **China-domestic** — no international shipping.

---

## Architecture truths this plan is built on (verified in code)

1. **Multi-tenant backend already exists.** Each tenant has its own DB (`lib/tenant-db.js`
   `getTenantDb`), its own creds (`lib/tenant-creds.js` `getTenantCreds`), full data isolation.
2. **Public tenant resolution already exists** — `middleware/public-tenant.js` maps the mini-app's
   `x-wx-appid` header → tenant, then runs the request inside that tenant's data scope. We extend
   the *same* file to also map **Host → tenant** for the website.
3. **Customer auth is already a generic opaque-token system.** `routes/retail.js`:
   `issueToken(customerId)` → row in `retail_auth_tokens`, sent as `Authorization: Bearer <hex>`,
   validated by `requireRetailAuth`. **Only customer *creation* is WeChat-coupled** (`/api/retail/auth`
   exchanges a wx code for openid). Web login just needs a *different way to mint a `customer_id`* and
   then calls the same `issueToken()`. Everything downstream is identity-agnostic.
4. **The whole ordering stack is identity-generic.** `/api/retail/cart/price`, `/checkout/quote`,
   `POST /orders`, `/orders`, `/wallet`, vouchers, addresses — all behind `requireRetailAuth`.
   A web user with a token reuses all of it **unchanged**.
5. **Host-based serving already exists.** `server.js` already branches `/` on `req.hostname`
   (`STORE_HOST` → backend shell, else kitchen SPA). We add: storefront host → web SPA shell.
6. **Helpers already in place:** `lib/aliyun-sms.js` (phone OTP), Alipay groundwork (gated by
   `ALIPAY_DEV_MODE`), WeChat 业务域名 verify-file route (`server.js` regex route), per-tenant
   payment creds.

**The one cost that does not go away:** feature *code* is written twice — WXML in the mini-app and
HTML/JS in the web SPA. Content/data is automatic; UI/behavior is not. (Avoiding this would require a
uni-app/Taro rewrite of the mini-app — out of scope, not worth it.) Mitigation: build **one** web SPA
that themes itself per tenant from API config — so it's two front-ends *total*, not two per tenant.

---

## Phase 0 — Domain → tenant routing + web shell hosting (foundation)

**New: tenant ↔ domain mapping (control DB).**
- `database.js` (the `tenants` region): add a `tenant_domains` table:
  `(id, tenant_id, host TEXT UNIQUE, kind TEXT['subdomain'|'custom'], status TEXT['pending'|'active'],
  ssl_status, created_at)`. (Or a simpler `web_domain` column on `tenants` if one domain per tenant
  is enough to start — table is the future-proof choice.)
- Default free subdomain per tenant, e.g. `<slug>.shop.fullcircle.app`, auto-created on provision
  (`lib/provision-tenant.js`).

**Extend tenant resolution.**
- `middleware/public-tenant.js`: add `resolveTenantByHost(host)` (looks up `tenant_domains`).
  `resolvePublicTenant(req)` falls back to Host when there's no `x-wx-appid`. Same fail-safe: unknown
  host → Roots/default, never another tenant's data.

**Serve the web SPA per host.**
- `server.js` `/` handler: add a branch — if `req.hostname` is a known storefront host
  (`tenant_domains` lookup, or `*.shop.fullcircle.app`), `sendFile('public/shop.html')` instead of the
  kitchen app. Keep `STORE_HOST` (backend) and kitchen branches intact.
- Mount the existing `publicTenantScope` for the SPA's API calls (already on `/api/retail`).
- New static shell: `public/shop.html` (+ `public/shop/` assets if split out).

**Ops (not code):**
- TLS for custom domains: wildcard cert for `*.shop.fullcircle.app` + on-demand certs per custom
  domain (Caddy on-demand TLS, or nginx + certbot). The `.well-known/` ACME path is already
  pass-through in `server.js`.
- **ICP备案** per custom domain (China hosting reality) — operational, per tenant, not code.

**Deliverable:** visiting a tenant's domain serves a (placeholder) SPA scoped to that tenant.

---

## Phase 1 — Browse-only storefront (themed) — ships first, useful immediately

- Evolve `public/storefront.html` (already a browse-only "Storefront Preview" hitting
  `/api/retail/{config,categories,products,products/top,flash-sales,leaderboard}`) into the real
  catalog SPA: **home (CMS blocks), category browse, product detail, search, bundles**.
- Tenant **theme from API**: `/api/retail/config` (`server.js`-mounted, returns branding/colors/fonts)
  → CSS variables. Logo, palette, fonts per tenant. (Port the brand-font + color-var block already in
  `storefront.html`.)
- Reuse the *rendering logic* (not the code) from `miniapp/pages/{home,shop,product}` and
  `miniapp/utils/lang.js` (i18n EN/CN, `pickVariantLabel`, etc.) — reimplemented in JS.
- **No new server endpoints** (verify a public home-layout/CMS-blocks endpoint exists; if home layout
  is only served to the editor, add a public `GET /api/retail/home-layout`).
- Add SEO: per-product `<title>`/OG tags, `sitemap.xml`, prerender-friendly meta (a web advantage the
  mini-app can't have).
- CTA for non-logged-in browsing: "Sign in to order" → Phase 2.

**Deliverable:** a real, shareable, indexable catalog website per tenant. No login/pay yet.

---

## Phase 2 — Web identity (non-WeChat accounts)

**Schema (per-tenant DB, `database.js`):**
- Make `retail_customers.openid` **nullable** (currently `UNIQUE NOT NULL`). SQLite can't drop NOT NULL
  in place → **table rebuild migration** (create new table, copy, swap). Keep `UNIQUE` but allow NULL
  (SQLite treats multiple NULLs as distinct, which is what we want).
- Add `password_hash TEXT`, ensure `email` usable as a login (partial unique index on non-null email),
  `phone` already indexed. Optionally `auth_provider` for clarity.

**New auth endpoints** (`routes/retail-web-auth.js`, mounted like the others; all reuse `issueToken`,
`publicCustomer`, `requireRetailAuth`):
- `POST /api/retail/web/otp/send` — phone OTP via `lib/aliyun-sms.js` (rate-limited, per-tenant creds).
- `POST /api/retail/web/otp/verify` — find-or-create customer by phone → `issueToken()`.
- `POST /api/retail/web/register` + `POST /api/retail/web/login` — email + password (bcrypt).
- *(Optional)* `GET /api/retail/web/wechat/oauth` — WeChat web OAuth (开放平台 网站应用) so WeChat users
  on a browser can one-tap sign in; maps to the same customer via `unionid`.

**Account linking / dedup:** when a phone/email matches an existing openid customer (or vice-versa),
**attach to the same row** rather than creating a duplicate. `unionid` is the bridge when both a
mini-app and web account exist for one person.

**Client:** web SPA stores the Bearer token in `localStorage` (matches the mini-app's token scheme —
**not** express-session). All existing `/api/retail/*` customer calls then "just work."

**Deliverable:** a browser user can create an account and is a first-class customer.

---

## Phase 3 — Cart + checkout + first payment rail

- **Cart:** client-side (localStorage), mirroring the mini-app's cart model. Price via existing
  `POST /api/retail/cart/price`; delivery/fee via `POST /api/retail/checkout/quote`; place via
  `POST /api/retail/orders` (all already identity-generic). Address picker reuses the existing geocode
  flow. **No order-engine changes** — same stores, routing, couriers, delivery windows.
- **Payment (start with Alipay web — closest to done):**
  - New `POST /api/retail/payment/web/create` → returns a redirect URL (Alipay PC `page.pay` /
    mobile `wap.pay`) or a QR (`precreate`) using per-tenant creds.
  - Reuse/extend the existing Alipay notify/verify handler (signing already proven per project notes).
  - Return page → poll order status → success screen.

**Deliverable:** a browser user can buy and pay end-to-end with Alipay.

---

## Phase 4 — Full parity + more payment rails

- **More payments:** WeChat Pay **H5** (mobile browser) + **Native/QR** (desktop) using per-tenant
  merchant creds (whitelist domain in 业务域名 — verify-file route already exists). Optional **Stripe**
  cards (`lib/billing-providers.js` has a Stripe *skeleton* for SaaS billing — customer-checkout Stripe
  is new) for any non-Chinese payment method you want to add later.
- **Account screens** (all map to existing endpoints): orders list/detail + tracking, wallet + topup,
  vouchers/coupons, addresses, favorites, reviews/pending-reviews, affiliate, notifications, invoices.
- **PWA:** `shop-manifest.webmanifest` + service worker so the store is installable to home screen
  (same pattern as `pos`/`kitchen`/`restock` shells already in `server.js`).
- **Mini App Backend toggle:** a per-tenant "Website" switch + domain field in the backend admin
  (surface the `tenant_domains` row, show ICP/SSL status).

---

## Reuse scorecard (why this is smaller than it looks)

| Concern | Status |
|---|---|
| Per-tenant data isolation | ✅ exists (`tenant-db`) |
| Tenant resolution | ✅ exists (`public-tenant`, extend to Host) |
| Customer token auth | ✅ generic (`issueToken`/`requireRetailAuth`) |
| Browse APIs | ✅ exist (storefront.html already uses them) |
| Cart / quote / order / wallet / vouchers | ✅ exist, identity-generic |
| Phone OTP | ✅ `lib/aliyun-sms.js` |
| Alipay | 🟡 groundwork shipped, gated |
| Host→tenant map, web identity, web pay flows, web SPA UI | ❌ new (this plan) |

## Risks / footguns

- `retail_customers.openid NOT NULL UNIQUE` → needs a **table-rebuild migration** (SQLite limitation).
- **Account dedup** across openid ↔ phone/email — get the linking rule right or you split one person
  into two accounts (and two wallets/point balances).
- Web SPA must use the **Bearer-token** scheme, not express-session (don't cross the wires).
- **ICP备案** + TLS per custom domain are real per-tenant operational steps.
- WeChat Pay H5 needs the storefront domain in the AppID's **业务域名/支付域名** whitelist.
