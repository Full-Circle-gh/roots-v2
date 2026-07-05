# Roots v2 / Full Circle — Complete Knowledge Handoff

**Purpose.** A single, self-contained brain-dump of how this codebase works, written so a *fresh
Claude* (any account) can absorb the whole system from this one file and be productive immediately.
Companion to `README.md` and `docs/DEEP-DIVE.md` (this doc is the superset — it also covers the
kitchen/ERP app, the full schema, the scripts, and how to run it locally).

> How to use with a new Claude: paste this file (or say "read docs/PROJECT-KNOWLEDGE.md first").
> `file:line` anchors drift over time — search the named symbol if an anchor is stale.

---

## 0. TL;DR — what this is

**Roots** is tenant #1 of **Full Circle**, a **multi-tenant retail SaaS** for Chinese food/grocery
merchants. One Node/Express + `better-sqlite3` service (`server.js`, port 4000) serves **five
surfaces** off one codebase and one schema:

| Surface | Users | Shell | Auth realm (session key / token) |
|---|---|---|---|
| WeChat Mini App | Customers | `miniapp/` | Bearer token (opaque hex) |
| Web storefront | Customers | `public/shop.html` | Same Bearer token |
| Mini App Backend (operator console) | Tenant operators | `public/retail-admin.html` | `session.backendUserId` + `tenantId` |
| Kitchen/ERP | Roots internal staff | `public/app.html` | `session.userId` |
| Platform Console (SaaS admin) | Platform staff | `public/store-admin.html` | `session.platformAdminId` |
| PWAs: POS / Kitchen / Restock / Quick-Stock | Staff | own manifests + `public/sw.js` | shared with the above |

The multi-tenant machinery is **built and tested but gated** behind `TENANT_DATA_ISOLATION` — today
Roots is the only live tenant. Server is HK-hosted (`47.239.89.63`), run under pm2.

Scale markers: `routes/retail.js` ≈ 23k lines (the customer API), `routes/ai.js` ≈ 3.4k,
`lib/inventory.js` ≈ 1.1k, ~39 route modules, ~48 `lib/` modules, ~230 miniapp files, ~195 scripts,
~140 DB tables, 17 numbered `retail-admin/` JS parts.

---

## 1. ⚠️ Deploy model — commits are live deploys

A **post-commit git hook** (`scripts/deploy-changed.sh` → `deploy-apply.sh`) **and** a GitHub Action
(`.github/workflows/deploy.yml`) ship changed files to production on every push to **`main`**:
syntax-gate → backup → `pm2 restart` → health-probe → **auto-rollback** on crash-loop.

- **Deployable paths:** `public/ routes/ lib/ middleware/ scripts/` + `server.js`, `database.js`,
  `schema.sql`. **Non-deployable:** `*.md`, `*.csv`, `miniapp/` (WeChat build, shipped via DevTools
  per tenant), `package*.json` (needs manual `npm install` on the box).
- Bypass with `[skip deploy]` / `[no deploy]` in the commit **subject**.
- **Only `main` deploys.** Feature branches (and this repo's `claude/*` branches) are safe checkpoints.
- After editing retail-admin JS, **bump `public/sw.js`** cache version or clients keep stale JS.
- `.github/workflows/claude.yml` runs Claude on `@claude` mentions in issues/PRs.
- Secrets live in a gitignored `.env` on the box (never commit). Reliability history: a crash→pm2
  restart loop was fixed by adding process-level `unhandledRejection`/`uncaughtException` guards + a
  global Express error handler, and by parking idle daemons to stop restart-storms.

---

## 2. Repo layout

| Path | What's there |
|---|---|
| `server.js` | App entry — sessions, host-based SPA routing, mounts all routes, boot hooks |
| `database.js` | Loads `schema.sql` + ~85 idempotent `addColumn` migrations + one-shot seeds (runs on boot) |
| `schema.sql` | Base kitchen/ERP tables (29 CREATE TABLEs) |
| `routes/` | HTTP modules; `retail.js` is the storefront/mini-app API (huge). Newer splits: `retail-purchasing.js` (online-store buying dept), `integrations-admin.js` (Channels hub API), `meituan-admin.js` (sync config), `meituan-internal.js` (daemon-only, localhost + `X-Internal-Secret`) |
| `lib/` | Domain logic (inventory, integrations, tenancy, secrets, AI gateway, brand, …). `lib/integrations/registry.js` = channel/logistics status registry; `lib/onboarding-steps.js` = tenant onboarding roadmap template |
| `middleware/` | `auth.js`, `public-tenant.js` |
| `public/` | Browser apps: storefront, `retail-admin/` (split JS), `cms.html`, kitchen `app.html`, POS/kitchen/restock/stock PWAs |
| `miniapp/` | WeChat Mini App (pages, components, utils) |
| `scripts/` | ~146 migrations, imports, daemons, deploy tooling, diagnostics (run on the server) |
| `docs/`, `reference/`, `eval/`, `design-handoff/` | Docs, v1 reference, AI evals, design specs |

**Planning/audit docs at repo root** (read these for intent): `PERMISSIONS_PLAN.md` (RBAC),
`WEB-STOREFRONT-PLAN.md`, `PARITY_AUDIT.md` (mini-app vs web), `TENANT-ONBOARDING.md`,
`GO-LIVE-CUTOVER.md`, `ELEME_INTEGRATION.md`, `BRAND_STUDIO_HANDOFF.md`, `Product-Wizard-v1-Spec.md`,
`BUG-HUNT-OVERNIGHT.md` (risk ledger), `I18N-AUDIT-MINIAPP-BACKEND.md`, `docs/shipping-rules.md`.

---

## 3. Multi-tenancy, auth & RBAC

### Tenant resolution (per request, via AsyncLocalStorage)
- `middleware/public-tenant.js` `resolvePublicTenant()` — reads `x-wx-appid` header first, falls back
  to Host → `tenant_domains` lookup, returns `null` for anything unknown. **Fail-safe:** unknown/forged
  appid lands on Roots' shared DB, never another tenant's data. `publicTenantScope` runs the request
  inside `tenantAls.run(getTenantDb(tid), next)`.
- `lib/tenant-db.js` `tdb()` = `tenantAls.getStore() || mainDb`. `getTenantDb(1) === mainDb`, so Roots
  is a zero-cost passthrough and every call site is unchanged. Per-tenant DBs are separate SQLite files
  `data/tenants/<id>.db` (WAL). `initTenantSchema` only creates **missing** tables and **never clones
  `CONTROL_PLANE_TABLES`**. `reconcileLateColumns` self-heals columns added after a tenant DB existed.

### Data-plane vs control-plane
`CONTROL_PLANE_TABLES` (shared `roots.db` only, never cloned): `tenants`, `tenant_users`,
`tenant_secrets`, `tenant_onboarding`, `billing_plans/subscriptions/invoices/reminders`, `users`,
`sessions`, `permissions`, `activity_log`. **Everything else is data-plane** and cloned per tenant.
Rule when editing: data-plane reads/writes must use `tdb()`; only control-plane `users`/`sessions`
etc. may use the shared `db`.

### Three session realms
`session.userId` (kitchen `users` + 27-col `permissions`) / `session.backendUserId`+`tenantId`
(operator `tenant_users` + capability RBAC) / `session.platformAdminId` (`platform_admins`). Never
collide. A stock-role lockdown middleware pins `kitchen`/`store_stock` operators to `/stock` + a
whitelist. **Impersonation:** `system.*` mints a one-time `platform_impersonation_tokens` row →
`/impersonate` on `store.*` seeds a 2-hour operator session (cookies are host-scoped).

### Operator RBAC (resolved fresh every request)
`requireRetailAdmin` (`routes/retail.js:~86`) builds `req.backendUser`, then
`lib/operator-caps.resolveOperator()` computes **`effective = (preset ∪ grants) − revokes ∩
entitledFeatures`**; **owner → ALL** is an absolute bypass (`lib/capabilities.js`). Enforcement is
central + mutation-only: `lib/cap-routes.js` `requiredCapFor(method, path)` returns a cap (or an
any-of array) for POST/PUT/PATCH/DELETE, `null` (fail-open) for GET/unmapped. Gated behind
`tenant.rbac_enforce` so it ships dark. Client `can()` (`public/retail-admin/01-core.js`) is cosmetic.

### Secrets & provisioning
- `lib/secret-box.js`: AES-256-GCM, versioned token `v1.<iv>.<tag>.<ct>`; `decrypt()` **throws on
  tamper/wrong key** (GCM tag is the gate). Key from `TENANT_SECRET_KEY` (hex/base64/scrypt).
- `lib/tenant-creds.js`: Roots → `.env` bundle; non-Roots → decrypted `tenant_secrets`, **no env
  fallback** (missing creds → devMode). Cached, invalidated on write.
- `lib/provision-tenant.js`: atomic control-plane tx (tenant + owner `tenant_user` + 14-day trial) →
  best-effort data-plane DB create + `seedTenantDefaults` (~40 `storefront_config` rows) →
  `autoAssignSubdomain` into `tenant_domains`. Catalog/zones/stores are intentionally manual.

---

## 4. Customer API & the order saga (`routes/retail.js`)

### Auth model
`issueToken(customerId)` → `retail_auth_tokens` (32-byte hex, 24h). Entry via WeChat
`wx.login`→openid, phone/email OTP (Aliyun SMS / Resend email), or Google/Apple/WeChat-web OAuth
(stateless signed-state handoff). `requireRetailAuth` validates + checks `is_blocked`. **Migration
credit restore:** binding a phone atomically claims a legacy OUT1N `retail_migration_credits` row
(idempotent `WHERE claimed_at IS NULL`) → credits wallet/points + reconciles the signup voucher.

### Order placement — `POST /api/retail/orders` (~7275–8287)
1. **Idempotency** — replay by `(customer_id, idempotency_key)`; the `UNIQUE` index is the race
   backstop (loser throws, caught, replays winner). Prevents points/wallet double-spend.
2. Resolve items → snapshot price/options/flash; ring-fence flash lines from coupons.
3. **Hard OOS gate** — `oos_policy='strict'` refuses 409 when per-store stock < qty; `backorder_gz` +
   bundles exempt.
4. **Routing** (`lib/inventory.routeOrder`) — GPS-nearest of the two GZ stores, or
   `out_of_city_store_id` (warehouse) for non-GZ / scheduled ship-districts. Stock gate ON only for
   pickup + GZ-same-day; OFF for out-of-GZ/scheduled. Fallback choices drive `analyzeShortage`.
5. **Atomic tx** (`tdb().transaction().immediate()`) — every contended resource is an atomic
   floor-check UPDATE: voucher `used_count < max_uses`, `points_balance >= ?`, `balance >= ?`,
   `flash_sold + qty <= limit`, `reserveForOrder` free-stock. A zero-row UPDATE throws a specific
   error and rolls the whole order back; the loser retries.
6. Post-commit side-effects (batch notice, print, push) are fire-and-forget.

### Payment & refunds
- `markOrderPaid` flips status **only** `WHERE status='pending_payment'` (idempotent; side-effects
  fire once): commit reservations, award points, credit referral + lifetime commission, push/print/
  invoice. WeChat v3 + Alipay callbacks verify signature + **amount parity** first. `out_trade_no` is
  deterministic per channel.
- Refunds: `splitRefundAcrossTenders` returns each ¥ to its source (points/balance/cash).
  `reverseOrderRedeem/Balance` are **cumulative-capped** (never over-return). `isFull = amount +
  0.005 >= remainingGross`; only full refunds claw back earned points/referral/commission. Payout
  uses an atomic `approved→paying` claim (no double-payout).
- **Wait-for-restock:** order parks at `awaiting_restock` (no reservation);
  `inventory.checkAwaitingRestockForRestock` promotes to `paid` only when all products are back, then
  `inventory.setOnOrdersPromoted` runs the deferred side-effects.

### Money systems
Wallet balance (prepaid, never pays shipping); points earn/redeem/expiry ledger with tier multipliers
(seed→sprout→root→tree by `lifetime_spend`); vouchers (fixed/percent/free-ship, `auto_apply`, signup
grants) discounting off `couponableSubtotal` so flash prices can't stack with sitewide coupons. CMS:
`storefront_config` KV (dotted keys, JSON) drives theme + block layouts (home/product/voting);
draft→publish via preview tokens; media library (base64 blobs).

---

## 5. Fulfillment & shipping (`lib/inventory.js`, `docs/shipping-rules.md`)

Two GZ stores: **tianhe** (warehouse: GZ exceptions / out-of-GZ / nationwide) and **yuexiu**
(storefront: main-GZ when GPS-nearer). Zone groups: GZ-main (¥15 / free ¥199), GZ-exceptions (番禺/
花都/南沙/从化/增城 with per-district same-day surcharges), other GD cities, other provinces, HK.
**OOS pre-pay 5-option modal:** ship-from-other / replace / cancel-item / cancel-order /
wait-for-restock. Reservation lifecycle: reserve → commit(ledger) → release/reverse.

---

## 6. Kitchen / ERP (the operator-facing back office — `public/app.html` + routes)

The Roots internal operation. Auth realm: `users` + `permissions` (27 boolean module gates).

- **Inventory engine** (`lib/inventory.js`): per-store `retail_store_stock` (physical_qty,
  safety_buffer, per-channel quotas), reservations, ledger; availability =
  `physical_qty − safety_buffer − active_reservations`, capped by channel quota.
- **Ingredients ↔ recipes ↔ production ↔ waste** with cost rollups (`routes/ingredients.js`,
  `recipes.js`, `production.js`, `waste.js`); recipe cost = ingredients + labour + overhead ÷ servings.
- **Purchasing** (`routes/purchases.js`): PO lifecycle Requested→Ordered→Delivered, price alerts on
  ≥5% cost swings, auto-posts expenses to the finance ledger. **Restock** (`routes/restock.js`):
  store↔warehouse↔kitchen movements with push routing.
- **Finance** (`routes/finance.js`): income/expense ledger; sales auto-derived read-only.
- **POS** (`routes/pos.js`) for physical market stalls; **markets** = locations with per-market stock
  ledger. **Sales** (`routes/sales.js`) across channels (dinein/meituan/eleme/miniapp/gzgrocery/…).
- **Operator product management** (`routes/products.js`, 48KB): variants, bundles, flash sales,
  per-store stock, the Product Wizard. Kitchen app also hosts Sprout (AI) and the dashboard.

---

## 7. SaaS billing & platform console

- `routes/billing*.js` + `lib/billing-lifecycle.js`: daily idempotent heartbeat — reminders at
  T-14/7/3/1 deduped by `UNIQUE(subscription_id, period_end, milestone)`; dunning ladder
  trialing/active → `past_due` → `grace`(7d) → `suspended`(14d); `ensure_renewal_invoice` idempotent
  per (subscription, period_start); `is_internal` carve-out so Roots is never dunned.
- Providers (`lib/billing-providers.js`): manual + **WeChat Pay v3 Native** (outbound `RSA-SHA256`
  over `METHOD\nPATH\nTS\nNONCE\nBODY\n`; inbound `AES-256-GCM`, `decipher.final()` auth-tag is the
  gate; `out_trade_no = FCSUB<invoiceId>` deterministic). Alipay/Stripe skeletons.
- Platform console (`routes/store-admin.js`, `saas-admin.js`, `lib/platform-admin.js`): tenants,
  branding, credentials, onboarding checklist, impersonation, broadcasts, support tickets, append-only
  `platform_audit_log`. Roles: super / billing / support.

---

## 8. Integrations (`lib/*` + `scripts/*-daemon.js`)

**Two automation techniques:**
- **Playwright anti-fingerprint** (Meituan `lib/meituan-browser.js`, Guanyi `lib/guanyi-browser.js`):
  disk-persisted session; injected "Windows Chrome" story (webdriver undef, matching client-hints,
  WebGL vendor, plugins only-if-empty); UA version pulled dynamically so features never lie; orders
  read from the **signed JSON API issued from the logged-in page** (not the DOM); `验证中心`
  detection → escalating 30min→4h daemon cooldown.
- **CDP-attach** (Qingyun `lib/qingyun-browser.js`, Shangou `lib/shangou-browser.js`): Playwright's
  `webdriver=true` is 403'd by H5guard, so attach over CDP to a genuine Chrome (no automation flags);
  `_installCapture` patches `XMLHttpRequest.prototype` to harvest signed request bodies, replayed via
  the page's own `fetch`. **Gotcha:** tear down a failed CDP connect before reconnecting or leaked
  WebSockets wedge the box.

**Stock-sync spine:** `inventory.enqueueChannelSync` fans a stock delta to Meituan/Eleme/Guanyi queue
tables **via `tdb()`** (canonical path is `meituan-bundles.enqueueProductStock(tdb(), …)`, covering
the product + its bundles). Do enqueues **only** through `inventory.adjustStock` — never a direct
`db.prepare('INSERT INTO *_sync_queue …')` in a route (duplicate row + cross-tenant leak). pm2
daemons drain queues with transient-vs-terminal retry semantics + startup orphan-recovery + a
proxy-health gate. `scripts/health-watchdog.js` + `scripts/proxy-watchdog.js` keep the box alive.

**Qingyun same-city delivery auto-push (Phase 2):** on payment, a paid order is enqueued
best-effort into the merchant's Qingyun 待配送 list as a `delivery_jobs` row (`routes/retail.js:~4129`),
reconciled across **all** paid paths (callback, trade-query, wait-for-restock promotion) so nothing
is missed; geocoding hardened for pin-less / English addresses. The customer-facing rider tracker is a
read-only mirror of `delivery_jobs` (`routes/retail.js:~9675`). **Stage gotcha:** status `20 待配送`
means *created in the list*, not *dispatched* — a scheduled order sits at 待配送 for a later slot, so
"Finding a courier" must NOT fire on 待配送 alone; the pre-dispatch UI shows a preview map + calm
"Delivery scheduled" label, and only flips to rider/ETA once the order is actually grabbed (30 in-flight).

**Others:** JD logistics (`lib/jd.js`: JOS waybill MD5 + JDL cloud-print HMAC, **separate app keys**);
tracking (`lib/tracking.js`: Kuaidi100 free webhook subscription + ~40 ordered CN→EN regex rules);
Feie thermal printer (`lib/feie.js`, SHA1); Nuonuo fapiao (`lib/nuonuo.js`, OAuth+HMAC, scaffold);
Aliyun SMS (`lib/aliyun-sms.js`, POP HMAC-SHA1 with `secret&` key); geocode Amap→Tencent failover
(`lib/geocode.js`); Alipay-screenshot OCR via Claude vision (`lib/alipay-ocr.js`); Eleme official
OAuth2/JSON-RPC (`lib/eleme-client.js`, scaffold); WeCom ops alerts (`lib/ops-alert.js`).

**Channels registry & tenant plugins (Platform-readiness, Phase 1):** `lib/integrations/registry.js`
is a **control-plane** status registry (one row per tenant × channel/logistics plugin: `not_configured
/ connected / error / last-sync`), read by both the operator "Channels · 渠道" hub and the saas-admin
support dashboard. `routes/integrations-admin.js` exposes it under `/api/retail-admin/channel-hub`
(distinct from `retail.js`'s existing `/integrations` credential config). Phase 1 is read-mostly: cards
render live status + a "Get help" escape hatch (assisted-setup model); per-plugin connect/map/verify
wizards land in later phases and will POST transitions via `registry.upsertStatus()`. Full intent +
audit lives in `CHANNELS-LOGISTICS-PLUGINS-PLAN.md`. Guanyi (管易) and gzgrocery stay **Roots-only**,
never generalized to the tenant plugin list; Shangou (美团闪购) folds into the Meituan plugin.

---

## 9. AI subsystem (`routes/ai.js`, `lib/model-gateway.js`, `lib/brand-*.js`)

- **Two abstraction layers on purpose:** `routes/ai.js` is the business layer with its own live
  Anthropic⇄DeepSeek adapter (Anthropic tool_use ↔ OpenAI `tool_calls`, both directions);
  `lib/model-gateway.js` is the **white-label boundary** (`MODEL_API_*` → `ANTHROPIC_*` fallback keeps
  prod working with zero config change; `clientSafe()` strips `provider/usage/raw/_detail`). Default
  model `claude-sonnet-4-6`; HK box routes through a Singapore proxy.
- **Sprout chat agent** (`POST /api/ai/chat`): up to 8 hops; no `tool_use` ⇒ final reply. ~25+
  read-only DB tools (sales/lookup/ops). Tool results capped 12k chars; `parseToolInput` +
  `escapeStrayJsonQuotes` recover mis-escaped CJK JSON. System prompt split static/dynamic with
  `cache_control:ephemeral` on the static half + last tool (~90% input-cost savings). Vision images
  attach to the last user message; `ai_memory` facts inject weighted by importance.
- **Brand Studio** (`lib/brand-designer.js`): deterministic brief → catalog conditioning → forced
  `emit_brand_design` tool → `sanitizeLayout` (block allowlist, URL scrub, ≤14 blocks) → `coerceFonts`
  (installed families only) → `lib/brand-gates.js` deterministic checks (WCAG contrast = error;
  >10 colours = warning; monochrome-for-Chinese-audience advisory) → async job store (draft→publish).
- **compose-blocks** turns pasted product copy into structured bilingual PDP blocks (forced
  `emit_blocks`, schema-validated, 3-pass retry). Evals in `eval/brand/`.

---

## 10. WeChat mini app (`miniapp/`)

- **Auth + token recovery:** silent login exposes `app.authReady`; on 401 `utils/api.js` kills the
  stale token, **coalesces concurrent 401s onto one `_reauthPromise`**, replays once (`_retried`
  guard). Every request carries `x-wx-appid` (read once at boot); unwraps `body.data ?? body`.
- **Cart** (`utils/cart.js`): localStorage-persisted; dedup key `product_id + sorted choice_ids`;
  `reprice()` refreshes all price fields so flash windows stay honest; `couponableSubtotal()` excludes
  `coupon_blocked` lines.
- **Checkout state machine** (`pages/checkout/checkout.js`): profile-bind gate → address (CN native
  `chooseLocation` vs EN cascade via `utils/zones.js`, always writing canonical Chinese) →
  `/checkout/quote` **with `delivery_slot_id` included** (changes stock-gating) → coupon
  auto-vs-manual → points-then-wallet stacking → **OOS fallback** modal (`none`/`simple_confirm`/
  `options_5`) sending `fallback_choice` + `replacements[]`; on a 409 that disagrees with the quote
  (GPS-vs-centroid race) it re-quotes once then builds the modal from the 409 body. 20s "placing"
  watchdog. i18n via `utils/lang.js` (`pick/pickLabel/pickVariantLabel`).
- Registered pages, custom tab bar, components (`block-renderer`, `product-blocks`, `recent-buyers`,
  `popup-manager`, `cs-button`) live under `miniapp/pages`, `miniapp/components`, `miniapp/custom-tab-bar`.

---

## 11. Operator front-end + CMS + PWAs (`public/`)

- **retail-admin** = **17** numbered files in **one global scope, load-order-critical** (hence
  `/* eslint-disable no-undef */`). `01-core.js` bootstraps `$`, `api()`, `toast`, `ICONS`, RBAC
  `can()/setCaps()`. File map: `01-core` shell/nav, `02-settings-ops`, `03-dashboard`, `04-orders`,
  `05-marketing`, `06-delivery` (card hub — JD + Qingyun live here, moved in from Sales),
  `07-content-billing`, `08-customers`, `09-products`, `10-extras` (i18n engine), `11-meituan`,
  `12-guanyi`, `13-activity`, `14-eleme`, `15-integrations` (Channels & Delivery hub, `ig*`),
  `16-purchasing` (online-store buying dept, `pu*`), `17-setup-guide` (new-tenant "Open your store"
  guide — **loads last** so every `goTab` target it routes into already exists).
- **New-tenant "Open your store" setup guide** (`17-setup-guide.js`): a **router, not a form** — each
  step opens the real page/wizard that already exists (Products, Delivery wizard, payment config, …);
  the server reports which steps are satisfied from real data so steps **tick themselves off** (the
  operator never checks a box). Surfaces: first login → guide (welcome overlay + checklist), a pinned
  sidebar entry with a live % badge (gone at 100%), and a "continue setup" card atop the dashboard
  (gone at 100%). Nothing is hidden or locked; the rest of the backend is unchanged. The A-to-Z roadmap
  template (business identity → banking → brand → WeChat/pay → channels) lives in `lib/onboarding-steps.js`,
  per-tenant progress in `tenant_onboarding`. Two priced models: `self` (tenant registers their own Mini
  Program + WeChat Pay) vs `managed` (we operate it as service-provider) — but in **both**, sales settle
  to the tenant's own WeChat Pay merchant → their own bank; money never routes through the platform.
- **Bilingual convention:** operator UI renders **one live language** via `cuT('en','中文')` (defined
  in `10-extras.js`); kitchen app.html uses a DOM text-node/`data-lang-block` splitter. A label
  **leaks** when JS injects bilingual text without `data-no-i18n`; `tagBlockPair` pairs adjacent
  same-tag pure-CJK/pure-Latin `div`/`p` — a `<span>` CN half is immune (the codebase's own remedy).
- **CMS** (`public/cms.html` + `public/shop/blocks.js`): block layouts stored as JSON in
  `storefront_config`; draft→live with a preview-token `postMessage` bridge.
- **PWAs:** `sw.js` (network-first HTML, stale-while-revalidate assets, network-only API; bump cache
  version on JS change); manifests for `/kitchen /pos /restock /stock`. The **Stock** app (formerly
  "Restock") is now a Home launcher (`/stock`, tile grid) that folds in Quick Stock and Restock as
  tools; Quick Stock only shows its Home button when arrived via `/stock?from=home` (no dead-end for
  direct opens). Shipping a restock **auto-transfers** real store stock (deduct warehouse, add store).

---

## 12. Database schema (~140 tables)

`database.js` loads `schema.sql` (line ~13) then runs ~85 idempotent `addColumn` migrations + one-shot
`_migrations`-guarded seeds. Groups:

- **Control-plane (15, shared only):** `tenants`, `tenant_users/secrets/onboarding/domains/user_caps/
  user_stores`, `billing_plans/subscriptions/invoices/reminders`, `users`, `sessions`, `permissions`,
  `activity_log`.
- **Kitchen/ERP (~50):** `ingredients`(+price_history), `recipes`(+ingredients/steps/cost_data),
  `products`(90+ cols), `purchase_orders`/`po_line_items`/`invoices`/`invoice_lines`, `suppliers`(+docs),
  `production_batches`, `waste_entries`, `restock_orders`/`items`, `markets`/`market_stock`(+ledger),
  `income_entries`/`expense_entries`/`price_alerts`, `sales_entries`/`sale_addons`, `categories`,
  `packaging_types`, `kitchen_orders`/`items`, `feedback`(+attachments/comments), `ai_memory`/`ai_app_help`,
  `push_subscriptions`.
- **Retail (~60):** `retail_customers`/`addresses`/`auth_tokens`/`otp_codes`/`email_otp_codes`/
  `oauth_states`/`migration_credits`/`migration_unmatched`; `retail_orders`/`order_items`/`payments`/
  `order_addons`/`refund_events`; `retail_product_options`/`option_choices`; `retail_reviews`/
  `synthetic_reviews`; `retail_vouchers`/`customer_vouchers`; `retail_points_transactions`/
  `topup_packages`/`topup_transactions`; `retail_delivery_zones`; `retail_notifications`/`feedback`/
  `feedback_messages`/`subscriptions`/`broadcasts`; `storefront_config`(KV); `retail_media`/
  `media_folders`/`page_templates`; `retail_article_views`/`product_versions`; `retail_stores`/
  `store_products`/`store_stock`/`stock_ledger`.
- **Integrations (~15):** `meituan_stores/orders/settlements/balance_flow/product_map/sync_queue/
  bundles/bundle_components/sync_log/listings/listing_jobs`; `delivery_jobs`(Qingyun)/`qingyun_sync_log`;
  `eleme_tokens/shops/product_map/sync_queue/order_import/sync_log`; `guanyi_product_map/sync_queue/
  sync_log/listings/listing_jobs`; `miniapp_orders`/`order_lines` (legacy import).
- **Platform:** `platform_broadcasts/impersonation_tokens/tickets/ticket_messages` (+`platform_admins`,
  `platform_audit_log` in control-plane).

**Invariant-enforcing indexes to respect:** `UNIQUE(customer_id, idempotency_key) WHERE …` (order
dedup), `UNIQUE(out_trade_no) WHERE …` (payment dedup), `UNIQUE(subscription_id, period_end,
milestone)` (reminder idempotency), `UNIQUE(customer_id, product_id, order_id)` (one review per
purchase), partial flash/barcode/published indexes. **`addColumn` pattern:** `try { ALTER TABLE … ADD
COLUMN … } catch (dup) {}` — idempotent; a table must be CREATE'd *before* it's addColumn'd (see §14).

---

## 13. Scripts (`scripts/`, ~146 files + 28 data JSON)

- **Deploy/ops (9):** `deploy-changed.sh`, `deploy-apply.sh`, `ship.sh`, `rollback.sh`,
  `install-backup-cron.sh`, `setup-oss-backup.sh`, `restore-test.sh`, `check-default-passwords.sh`,
  `check-html-js.js` (inline-script syntax gate).
- **Daemons (12 + genuine-Chrome launchers):** `meituan-daemon`, `eleme-daemon`, `guanyi-daemon`,
  `qingyun-daemon`, `shangou-daemon`, `gzgrocery-order-daemon`, `health-watchdog`, `proxy-watchdog`
  (+ `*-chrome.js`, `*-login.js`, `shangou-inject/export-session`). Launched via `pm2 start`.
- **Migrations/backfills (~22):** `backfill_*`, `add_shipping_zones*`, `fix_*`, `collapse/consolidate/
  dedupe_*zones*` — all touch live orders/catalog; most back up the DB first + are idempotent.
- **Imports/seeding (~16):** `import_*`, `convert_*`, `organize_categories`, `apply_home_brand_colors`.
- **PII-critical (5):** `seed_migration_credits.js`, `seed_migration_roster.js`,
  `seed_migration_unmatched.js`, `build_migration_roster.js` (+ `reset_test_orders.js`) — handle OUT1N
  phone/name/balance. Keep the `migration_*.json` inputs off git; delete from the box after use.
- **Diagnostics (~12):** `diagnose_*`, `dump_*`, `*-probe`, `clear_stuck_*`, `repair_guanyi_false_pickup`.
- **Test/build/mockups (~22):** `test_brand.js`, `test_retail_local.*`, `build_gallery_fixtures`,
  `extract/split_retail_*`, `make_*_mocks.py`, `make_*_plan_pdf.py`.

---

## 14. Running it locally (dev notes)

```bash
npm install            # builds native better-sqlite3 + sharp (Node 18–22 OK)
node server.js         # → http://localhost:4000  (PORT env overrides)
```
- No `.env` needed to boot: SESSION_SECRET falls back to a random temp secret; WeChat Pay/Alipay run
  in **dev mode** (payment endpoints auto-succeed — never expose a dev instance publicly).
- The live DB (`data/roots.db`) and secrets are gitignored; a fresh boot creates an empty
  `data/roots.db` from `schema.sql` + migrations.
- **Cold-boot ordering rule (fixed 2026-07):** an `addColumn(table,…)` must run *after* that table's
  `CREATE TABLE`. `markets` used to be addColumn'd before its CREATE (and isn't in `schema.sql`), which
  crashed a from-scratch boot with `no such table: markets`; it now sits after the CREATE. If you add a
  new table + column, keep the CREATE above its addColumns or you'll reintroduce a cold-boot crash.
  (One remaining *non-fatal* caught warning on fresh DBs: a `SELECT FROM _migrations` before that table
  exists — logs an error, continues harmlessly.)
- Verified behavior on a clean checkout: `/`→302→`/login`(200), `/api/retail/config`→200 (bilingual
  config), products/categories/flash-sales→200, `/api/retail-admin/*` (no session)→401, unknown→SPA
  fallback.

---

## 15. Known risk classes (respect these when editing)

From the 2026-06-12 overnight bug-hunt + audits — all verified fixed in current code; the *classes*
stay on your radar:

1. **Money reversals on refund/cancel** — referral clawback, partial-refund points (scaled
   `split.points`, full reversal only when `isFull`), wait-for-restock referral (`setOnOrdersPromoted`).
   Keep reversals cumulative-capped + idempotent.
2. **`tdb()` scoping before isolation cutover** — data-plane reads/writes use `tdb()`; channel-sync
   enqueues only through `inventory.adjustStock`.
3. **Base64 blob leaks in list endpoints** — emit lazy `/image?v=` URLs via `hasImageFallbackSql`,
   never raw `image_data`.
4. **WeChat one-shot subscribe-consent burns** — set `used=1` only after `errcode===0`; guard the push
   branch with `if (!ORDER_STATUS_NOTIF[newStatus]) return;` (refund flows pass `null`).
5. **Bare-date coupon expiry as UTC midnight** — normalize via `normalizeVoucherExpiry` (POST + PATCH);
   a bare `YYYY-MM-DD` dies ~16h early in Beijing time.
6. **i18n pair-hiding** — never stack `EN · CN` data into a label node without `data-no-i18n`; never
   put a pure-CJK sub-label in an adjacent same-tag `div` (use `<span>` or a separate `<td>`).

---

## 16. Session changelog (2026-07-01, branch `claude/project-learning-gaxqxt`, PR #4)

- **i18n:** recipes-list Chinese name no longer hidden in EN mode (`public/app.html`, `<div>`→`<span>`).
- **Inventory:** removed a duplicate Meituan enqueue on the shared `db` handle in
  `routes/retail-inventory.js` (latent cross-tenant leak; the canonical `inventory.adjustStock` path
  already enqueues tenant-correctly).
- **DB cold-boot:** moved `markets.kind` addColumn to after the markets CREATE in `database.js` so a
  from-scratch boot on an empty DB works (verified serving).
- **Docs:** added `docs/DEEP-DIVE.md` (mechanism-level, non-kitchen) and this file.
- Verified all six risk classes above are already fixed in current code; booted the app end-to-end.

## 17. Session changelog (2026-07-05, branch `claude/memory-github-storage-mwu6ur`)

Doc refresh only — no code changes — bringing this handoff and `docs/DEEP-DIVE.md` up to date with
the ~52 commits since the 2026-07-01 snapshot, so a fresh Claude (any account) inherits current state:

- **Channels & Delivery hub** (`public/retail-admin/15-integrations.js` + `routes/integrations-admin.js`
  + `lib/integrations/registry.js`): the Delivery/Sales tabs became a card hub; JD + Qingyun moved in
  from Sales; a control-plane status registry backs both the operator hub (`/api/retail-admin/channel-hub`)
  and saas-admin. Plan/audit in `CHANNELS-LOGISTICS-PLUGINS-PLAN.md`.
- **Qingyun same-city delivery — Phase 2 auto-push**: paid orders enqueue into the merchant's 待配送
  list as `delivery_jobs`, reconciled across all paid paths; customer rider-tracker mirrors it; the
  "created 待配送 ≠ dispatched" stage fix (no premature "Finding a courier"; pre-dispatch preview map).
- **New-tenant onboarding**: "Open your store" setup guide (`17-setup-guide.js`, a router that ticks
  itself off from real data) + first-run Mini App setup wizard (every step skippable). Roadmap template
  in `lib/onboarding-steps.js`; progress in `tenant_onboarding`.
- **Meituan tab redesign**: status strip, sub-views, guided name-matching, per-store connection detail;
  daemon now talks to `routes/meituan-internal.js` (localhost + `X-Internal-Secret`), config via
  `routes/meituan-admin.js`.
- **Purchasing tab** (`16-purchasing.js` + `routes/retail-purchasing.js`): the online store's buying
  department — suppliers + retail POs (create → order → receive), received qty posts to store stock and
  fans out to channel sync; costs auto-post to Finance → Expenses.
- **Stock app** (formerly Restock): Home launcher at `/stock`, folds in Quick Stock; shipping a restock
  auto-transfers real store stock (deduct warehouse, add store); viewport-fit, voice feature removed.
- **Web storefront + config pages**: desktop cart/checkout (PC phase 2); real Mini App and Web-store
  configuration pages (all credentials on one page); store-box shipped + tracking flow.
