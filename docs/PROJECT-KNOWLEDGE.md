# Tacet — Complete Knowledge Handoff

**Purpose.** A single, self-contained brain-dump of how this codebase works, written so a *fresh
Claude* (any account) can absorb the whole system from this one file and be productive immediately.
Companion to `README.md` and `docs/DEEP-DIVE.md` (this doc is the superset — it also covers the
kitchen/ERP app, the full schema, the scripts, and how to run it locally).

> How to use with a new Claude: paste this file (or say "read docs/PROJECT-KNOWLEDGE.md first").
> `file:line` anchors drift over time — search the named symbol if an anchor is stale.

---

## 0. TL;DR — what this is

**Tacet** is a **multi-business retail SaaS**. Businesses of any kind, in any country, register
and use it. Roots is the first business on it — one customer that happens to be first, not what
the product is built for (`docs/tacet-consolidation-decisions.md` §0). One Node/Express + `better-sqlite3` service (`server.js`, port 4000) serves **five
surfaces** off one codebase and one schema:

| Surface | Users | Shell | Auth realm (session key / token) |
|---|---|---|---|
| WeChat Mini App | Customers | `miniapp/` | Bearer token (opaque hex) |
| Online store (web) | Customers | `public/shop.html` | Same Bearer token |
| Mini App Backend (operator console) | Tenant operators | `public/retail-admin.html` | `session.backendUserId` + `tenantId` |
| Kitchen/ERP | Roots internal staff | `public/app.html` | `session.userId` |
| Platform Console (SaaS admin) | Platform staff | `public/store-admin.html` | `session.platformAdminId` |
| PWAs: POS / Kitchen / Restock / Quick-Stock | Staff | own manifests + `public/sw.js` | shared with the above |

The multi-tenant machinery is **built and tested but gated** behind `TENANT_DATA_ISOLATION` — today
Roots is the only live tenant. Server is HK-hosted (`47.239.89.63`), run under pm2.

Scale markers: `routes/retail.js` ≈ 23k lines (the customer API), `routes/ai.js` ≈ 3.4k,
`lib/inventory.js` ≈ 1.1k, ~36 route modules, ~47 `lib/` modules, ~230 miniapp files, ~146 scripts,
~140 DB tables.

---

## 1. ⚠️ Deploy model — commits are live deploys

**CI owns deploys** (changed 2026-07-17, commit `ecbce2d`). The GitHub Action
(`.github/workflows/deploy.yml`) is now the **single** deployer on every push to **`main`**:
gating **eslint** (setup-node + `npm ci --ignore-scripts` + eslint on the changed `.js`, so a lint
error now **blocks** the deploy) → syntax-gate → backup → install → `npm install` (if `package*.json`
shipped) → `pm2 restart` → health-probe → **auto-rollback** on crash-loop.

- The local **post-commit hook** now **only mirrors to GitHub** (`auto-push.sh`) — the push is what
  fires the deploy workflow. The old *second, local* deploy (`scripts/deploy-changed.sh`) was removed
  from the hook: it raced CI on a shared server `__stage__` dir, always lost, and printed a spurious
  red error. `deploy-changed.sh` stays on disk as the **break-glass** tool — run it by hand to re-ship
  `HEAD` when GitHub/CI is down. (`scripts/post-commit.hook`, the tracked install source, was synced to
  push-only.) Both paths still invoke the same `deploy-apply.sh` (backup / restart / probe / rollback).
- **Deployable paths:** `public/ routes/ lib/ middleware/ scripts/` + `server.js`, `database.js`,
  `schema.sql`, `package.json`, `package-lock.json`. **Non-deployable:** `*.md`, `*.csv`, `miniapp/`
  (WeChat build, shipped via DevTools per tenant).
- Bypass with `[skip deploy]` / `[no deploy]` in the commit **subject**.
- 🔴 **A gate-blocked commit does NOT re-ship on the next push.** The deploy computes its file list
  from the diff `github.event.before → github.sha` of *that* push. If a gating step fails, the ship
  step is skipped and those files stay stale on the box — and the next push's diff no longer contains
  them, so a later green run will not pick them up. Pushing the fix is not enough. **Recovery: run the
  workflow manually with `full_sync: true`** (Actions → Deploy to production → Run workflow, or
  `gh workflow run "Deploy to production" --ref main -f full_sync=true`), which ships every deployable
  file rather than the changed ones. Learnt 2026-07-30, when the fulfilment-test gate correctly blocked
  a broken install step and left `04-orders.js` on `main` but not on the box.
  - It ships ~400 files one at a time over the HK link: budget **~30 min**, versus ~1 min for a normal
    deploy. It is not a thing to reach for casually.
  - Its lint step lints **every tracked deployable `.js`**, not just the changed ones. That passes today
    (0 errors across 223 files). Untracked scratch scripts in `scripts/` are never linted because the
    file list is built from git.
  - To verify a full sync afterwards, compare content rather than trusting it: `git ls-tree -r main`
    for the deployable paths against `git hash-object` on the box (git is installed there). Expect
    exactly two mismatches — `public/sw.js`, whose CACHE token the installer re-stamps with a
    timestamp, and `package-lock.json`, which the box's older npm rewrites without the `libc` optional-
    dependency hints. Anything else is real drift.
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
| `routes/` | HTTP modules; `retail.js` is the online-store/mini-app API (huge) |
| `lib/` | Domain logic (inventory, integrations, tenancy, secrets, AI gateway, brand, …) |
| `middleware/` | `auth.js`, `public-tenant.js` |
| `public/` | Browser apps: online store, `retail-admin/` (split JS), `cms.html`, kitchen `app.html`, POS/kitchen/restock/stock PWAs |
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
entitledFeatures`**; **owner → ALL** is an absolute bypass (`lib/capabilities.js`).

**Two enforcement realms — don't conflate them:**
- **`/api/retail-admin/*`** (the big online-store API, `requireRetailAdmin`): central + mutation-only via
  `lib/cap-routes.js` `requiredCapFor(method, path)` — a cap (or an **any-of** array) for
  POST/PUT/PATCH/DELETE, `null` (fail-open) for GET/unmapped. **Still ships dark** behind
  `tenant.rbac_enforce` (off everywhere). `041274e` fixed six path-shape misses (four fail-open) and
  split **`orders:dispatch_courier`** out of `orders:edit` (booking a same-city courier debits the
  store's prepaid balance, so it shouldn't share a cap with editing a note; granted to the dispatch +
  fulfillment presets). `PERMISSIONS_PLAN.md §11` records the **three blockers owed before
  `rbac_enforce` can flip** (fail-open default, reads-open GET scoping, `/integrations` creds).
- **`/api/backend/*`** (the operator account/team/billing realm): `lib/require-cap.js` `requireCap`
  **enforces UNCONDITIONALLY** — no flag, live the moment it deployed (`94e38c7`). `POST/PUT /team` +
  `/team/:id/password` need **`team:manage`** (owner/admin/manager); `/team/:id/permissions` needs
  **`team:permissions`** (**owner only** — the admin preset excludes it), and `roleAboveCaps` blocks
  granting/resetting a role above the caller's own. (`require-cap.js` also centralizes the shared
  `requireBackend`/`loadCaller`; `billing*.js` + `backend-notices.js` dropped their local copies.)

Client `can()` (`public/retail-admin/01-core.js`) is still **cosmetic** (server is authority) — but as
of the dashboard work it is **genuinely differentiated per resolved cap set**, not "everyone resolves
to the FULL set". It drives which dashboard *Needs-you* sub-cards render (`DASH_CARD_CAP`) and gates
the ⌘K palette's reads on `can('*:view')`. Both take effect immediately and are view-layer only; the
GET endpoints stay open to any signed-in operator (reads-open is one of the blockers above).

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

**Others:** JD logistics (`lib/jd.js`: JOS waybill MD5 + JDL cloud-print HMAC, **separate app keys**);
tracking (`lib/tracking.js`: Kuaidi100 free webhook subscription + ~40 ordered CN→EN regex rules);
Feie thermal printer (`lib/feie.js`, SHA1); Nuonuo fapiao (`lib/nuonuo.js`, OAuth+HMAC, scaffold);
Aliyun SMS (`lib/aliyun-sms.js`, POP HMAC-SHA1 with `secret&` key); geocode Amap→Tencent failover
(`lib/geocode.js`); Alipay-screenshot OCR via Claude vision (`lib/alipay-ocr.js`); Eleme official
OAuth2/JSON-RPC (`lib/eleme-client.js`, scaffold); WeCom ops alerts (`lib/ops-alert.js`).

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

- **retail-admin** = 10–14 numbered files in **one global scope, load-order-critical** (hence
  `/* eslint-disable no-undef */`). `01-core.js` bootstraps `$`, `api()`, `toast`, `ICONS`, RBAC
  `can()/setCaps()`. File map: `01-core` shell/nav, `02-settings-ops`, `03-dashboard`, `04-orders`,
  `05-marketing`, `06-delivery`, `07-content-billing`, `08-customers`, `09-products`, `10-extras`
  (i18n engine), `11-meituan`, `12-guanyi`, `13-activity`, `14-eleme`.
- **Role-shaped dashboard** (`03-dashboard.js`): the owner view is a 4-card morning glance
  (Recap · Needs-you · Today · Customers — Today lost its intraday chart, that's a Reports job);
  warehouse / dispatch / customer-service / `/dashboard/ops` each get role-filtered Recap + Unhandled
  cards. Which cards render is gated **two ways**: money-card *presence* on the reliable `body.pos-*`
  CSS role string; *Needs-you* sub-cards on `DASH_CARD_CAP` → `can()/canAny()` against the operator's
  resolved caps (self-composing — a per-user grant toggles a row with no code change).
- **Write-in-flight discipline:** state-changing controls disable their trigger while the write is in
  flight (a double-click was double-submitting). `adminWrite(btnIds)` handles the common case; controls
  carrying an SVG icon use a manual `btn.disabled` guard instead (adminWrite's `textContent='…'` would
  strip the icon). `transition()` (order status writes) is likewise disabled mid-write.
- **Refund `paying` state:** the operator UI models the transient 7th `refund_status='paying'` (payout
  claimed, money moving through the gateway) — dusk-tinted badge/banner + a non-actionable in-progress
  note, and crucially **no Approve/Payout buttons** while money is mid-flight.
- **Embedded Profile frame** (`/backend/account` in `#profFrame`): a two-way, origin-pinned
  `postMessage` contract (`fc-theme` / `fc-lang`) keeps theme + language in sync across the iframe
  boundary (repaint-only, no localStorage write-back, so the echo terminates in one round trip).
- **Bilingual convention:** operator UI renders **one live language** via `cuT('en','中文')` (defined
  in `10-extras.js`); kitchen app.html uses a DOM text-node/`data-lang-block` splitter. A label
  **leaks** when JS injects bilingual text without `data-no-i18n`; `tagBlockPair` pairs adjacent
  same-tag pure-CJK/pure-Latin `div`/`p` — a `<span>` CN half is immune (the codebase's own remedy).
- **CMS** (`public/cms.html` + `public/shop/blocks.js`): block layouts stored as JSON in
  `storefront_config`; draft→live with a preview-token `postMessage` bridge.
- **PWAs:** `sw.js` (network-first HTML, stale-while-revalidate assets, network-only API; bump cache
  version on JS change); manifests for `/kitchen /pos /restock /stock`.

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
  `store_products`/`store_stock`/`stock_ledger`; `retail_shipments` (+ `package_count` — 一单多件
  box count for a JD waybill; NULL/1 = the ordinary single-box case).
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

---

## 17. Changelog — 2026-07-17 → 07-21 (landed on `main`)

Filling the gap since this doc was last written (2026-07-16). Grouped by theme; the invariant-level
changes (deploy model, RBAC realms) are already folded into §1 and §3 above.

- **Deploy model — CI is now the single deployer** (`ecbce2d`). Post-commit hook only mirrors to
  GitHub; the local `deploy-changed.sh` deploy was dropped (raced CI, always lost); `deploy.yml` gained
  a **gating** eslint step before ship. `deploy-changed.sh` is now break-glass. (Full detail in §1.)
- **RBAC — `/api/backend/*` team management enforces live** (`94e38c7`): new `lib/require-cap.js`
  (`requireCap`/`roleAboveCaps`/`loadCaller`); `team:manage` (owner/admin/manager) and
  `team:permissions` (owner-only) gate the team routes **unconditionally** (not behind `rbac_enforce`).
  Live effect on Roots: three admins keep create/edit/reset but lose the permission matrix — only the
  owner edits operator permissions now. Separately (`041274e`, still dark) the retail-admin
  `cap-routes.js` map got six path-shape fixes + a new `orders:dispatch_courier` cap. (Detail in §3.)
- **Role-shaped dashboard** (`6bc2e5b`, `2fb130a`, `8ab2410`, `ba02fd6`, `62c6534`, `0013673`,
  `1272941`): owner 4-card glance; warehouse / dispatch-CS / `/dashboard/ops` role-filtered views; dead
  cards + their orphan CSS swept; Needs-you sub-cards now gate on caps (`DASH_CARD_CAP`) not the role
  string; the stale `01-core.js` comment claiming caps were "fully dark" was corrected. (Detail in §11.)
- **Meituan / order status reconciliation** (`94d7aae`, `38a27b5`, `e624602`, `d18a6c0`):
  `internalStatusForChannel()` now counts 妥投/已妥投/签收成功 as delivered (the badge was stuck on "On
  the way" while the card said "Delivered"); the drawer's header pill reconciles the live courier stage
  even while the order is still `preparing`; a Meituan "Delivered" label gets a **"Platform-reported ·
  rider still on the way"** caveat when the linked courier job shows no drop-off yet (trust the live
  rider, not Meituan's bookkeeping); a delivered/cancelled order hides its frozen "En route" rider line.
- **Refund `paying` state rendered** (`514bbfc`, `5391079`): the transient 7th `refund_status='paying'`
  no longer leaks as an untranslated literal — badge/banner/in-progress note, no Approve/Payout buttons
  mid-flight, and the in-progress note live-toggles on language switch. (Detail in §11.)
- **Write-in-flight discipline** (`74c5f83`, `b078697`, `b1bed6a`): 12 controls disabled while their
  write is in flight (double-click double-write); `transition()` disabled during a status write; added
  the missing **paid → dispatched** button. (Pattern in §11.)
- **JD 一单多件 (multi-box waybill)** (`63add46`): staff set a box count when creating a JD label; JD
  keeps one tracking number but prints one box label per piece. New `retail_shipments.package_count`
  column (`lib/jd.js`, `routes/retail.js`, `04-orders.js`).
- **Orders — customer-scoped list** (`935979a`, `eb2a8db`): a customer drawer's "View all N orders"
  link scopes the Orders tab to that customer (`AND o.customer_id = ?` on the shared `filterSql`, exact
  FK, `Number.isFinite`-guarded) with a removable chip; Esc + outside-click route the drawer dismiss
  through back-to-customer.
- **Embedded Profile theme/language sync** (`12186ee`): origin-pinned two-way `postMessage`
  (`fc-theme`/`fc-lang`) between the shell and the `/backend/account` iframe. (Detail in §11.)
- **Products** (`902cfe4`): low-stock threshold moved to Settings → Operations → Stores (tenant
  default; per-store overrides already existed); the Bulk button became a permanent (greyed-until-
  selected) bulk-action bar.
- **Qingyun** (`2e5bab7`): debounce the not-logged-in alert so a transient blip doesn't page ops.
