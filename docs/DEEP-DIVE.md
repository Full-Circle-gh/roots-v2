# Roots v2 — Architecture Deep Dive

Mechanism-level reference for the whole system **except the kitchen/ERP app** (`public/app.html`
+ the `recipes/ingredients/purchases/production/waste/finance` routes), which is documented
separately. Written to be the "how it actually works" companion to `README.md`.

> Convention: `file:line` anchors are approximate — line numbers drift. Search the named
> symbol if an anchor is stale.

---

## 0. The shape of the system

One Node/Express + `better-sqlite3` service (`server.js`, port 4000) serves **five surfaces**
off one codebase and one schema:

| Surface | Users | Shell | Auth realm (session key) |
|---|---|---|---|
| WeChat Mini App | Customers | `miniapp/` | Bearer token (opaque hex) |
| Online store (web) | Customers | `public/shop.html` | Same Bearer token |
| Mini App Backend | Tenant operators | `public/retail-admin.html` | `session.backendUserId` + `tenantId` |
| Kitchen/ERP | Roots staff | `public/app.html` | `session.userId` |
| Platform Console | SaaS staff | `public/store-admin.html` | `session.platformAdminId` |
| PWAs (POS/Kitchen/Restock/Quick-Stock) | Staff | own manifests + `sw.js` | shared with the above |

**Tacet is a multi-business product; Roots is one business on it.** The multi-business machinery
is built and tested but **gated behind `TENANT_DATA_ISOLATION`** — Roots being the only live
business today is a fact about today, not a property of the system (`docs/tacet-consolidation-decisions.md` §0).

**⚠️ Commit = production deploy.** As of 2026-07-17 (`ecbce2d`) **CI is the single deployer**:
`.github/workflows/deploy.yml` ships changed `public/ routes/ lib/ middleware/ scripts/` +
`server.js/database.js/schema.sql` to `47.239.89.63` (gating **eslint** → syntax-gate → backup →
pm2 restart → health-probe → **auto-rollback**). The local post-commit hook now **only mirrors to
GitHub** (that push is what triggers the workflow); the old second, local deploy was removed because
it raced CI on a shared `__stage__`. `scripts/deploy-changed.sh` remains as the manual break-glass
ship. Only `main` deploys; `.md/.csv/miniapp/` are non-deployable (miniapp ships via WeChat DevTools
per tenant). `[skip deploy]` / `[no deploy]` in the subject bypasses.

---

## 1. Multi-tenancy, auth & RBAC

### Tenant resolution (per request, via AsyncLocalStorage)
- `middleware/public-tenant.js` `resolvePublicTenant()` — reads `x-wx-appid` first, falls back to
  Host → `tenant_domains` lookup, returns `null` for anything unknown. **Fail-safe:** unknown/forged
  appid lands on Roots' shared DB, never another tenant's data.
- `publicTenantScope` runs the request inside `tenantAls.run(getTenantDb(tid), next)`.
- `lib/tenant-db.js` `tdb()` = `tenantAls.getStore() || mainDb`. `getTenantDb(1) === mainDb`, so
  Roots is a zero-cost passthrough and every call site is unchanged.
- Per-tenant DBs are separate SQLite files `data/tenants/<id>.db` (WAL). `initTenantSchema` only
  creates **missing** tables and **never clones `CONTROL_PLANE_TABLES`** (`tenants`, `tenant_users`,
  `tenant_secrets`, `tenant_onboarding`, `billing_*`, `users`, `sessions`, `permissions`,
  `activity_log`). Everything else is data-plane and cloned.

### Operator RBAC (resolved fresh every request)
- `requireRetailAdmin` (`routes/retail.js:~86`) builds `req.backendUser`, then
  `lib/operator-caps.js` `resolveOperator()` computes
  **`effective = (preset ∪ grants) − revokes ∩ entitledFeatures`**; **owner → ALL** is an absolute
  bypass (`lib/capabilities.js`).
- **Two enforcement realms — don't conflate them:**
  - **`/api/retail-admin/*`** (`requireRetailAdmin`): **central + mutation-only** via `lib/cap-routes.js`
    `requiredCapFor(method, path)` — a cap (or an **any-of array**) for POST/PUT/PATCH/DELETE, `null`
    (fail-open) for GET/unmapped. **Still ships dark** behind `tenant.rbac_enforce`. Store scope adds
    `storeId ∈ req.scopeStores`. `041274e` corrected six path-shape misses and split
    **`orders:dispatch_courier`** out of `orders:edit` (booking a same-city courier debits prepaid
    balance). Three blockers are owed before `rbac_enforce` can flip (fail-open default, reads-open GET
    scoping, `/integrations` creds — `PERMISSIONS_PLAN.md §11`).
  - **`/api/backend/*`** (`requireBackend` in `lib/require-cap.js`): `requireCap` **enforces
    unconditionally** — no flag, live since `94e38c7`. `team:manage` (owner/admin/manager) gates
    `POST/PUT /team` + password reset; `team:permissions` (**owner only**) gates the permission matrix;
    `roleAboveCaps` blocks granting a role above the caller's own.
- Client gating (`can()` in `public/retail-admin/01-core.js`) is **cosmetic** (server is authority) but
  now **genuinely differentiated per resolved cap set** — it drives which dashboard *Needs-you*
  sub-cards render and gates the ⌘K palette's reads on `can('*:view')` (both view-layer only; the GETs
  stay open).

### Three session realms + impersonation
- `session.userId` (kitchen) / `backendUserId` (operator) / `platformAdminId` (platform) never collide.
- A stock-role lockdown middleware pins `kitchen`/`store_stock` operators to `/stock` + a whitelist.
- Impersonation: `system.*` mints a one-time `platform_impersonation_tokens` row → `/impersonate` on
  `store.*` seeds a 2-hour operator session (cookies are host-scoped, so the handoff crosses origins).

### Secrets
- `lib/secret-box.js`: AES-256-GCM, versioned token `v1.<iv>.<tag>.<ct>`. `decrypt()` **throws on
  tamper/wrong key** (GCM tag is the gate). Key from `TENANT_SECRET_KEY` (hex/base64/scrypt-stretched).
- `lib/tenant-creds.js`: Roots → `.env` bundle; non-Roots → decrypted `tenant_secrets` with **no env
  fallback** (missing creds → devMode, never Roots' keys). Cached, invalidated on write.

### Provisioning
- `lib/provision-tenant.js`: atomic control-plane tx (tenant + owner `tenant_user` + 14-day
  `trialing` subscription) → best-effort data-plane DB create + `seedTenantDefaults` (~40
  storefront_config rows) → `autoAssignSubdomain` into `tenant_domains`. Catalog/zones/store are
  intentionally manual (business-specific).

---

## 2. Customer API & the order saga (`routes/retail.js`, ~23k lines)

### Auth model
- `issueToken(customerId)` → `retail_auth_tokens` (32-byte hex, 24h). Entry via WeChat
  `wx.login`→openid, phone/email OTP (Aliyun SMS / Resend), or Google/Apple/WeChat-web OAuth
  (stateless signed-state handoff). `requireRetailAuth` validates + checks `is_blocked`.
- **Migration credit restore**: binding a phone atomically claims a legacy OUT1N
  `retail_migration_credits` row (idempotent: `WHERE claimed_at IS NULL`) → credits wallet/points,
  and reconciles the signup voucher (returning customers get it revoked).

### Order placement — `POST /api/retail/orders` (~7275–8287)
1. **Idempotency** (~7361): replay by `(customer_id, idempotency_key)`; the `UNIQUE` constraint is
   the race backstop — the losing concurrent submit throws and is caught (~8248) to replay the winner.
   Without this, points/wallet double-spend.
2. **Resolve items** → snapshot price/options/flash; ring-fence flash lines from coupons
   (`noCoupon = isFlash && no_coupon_on_flash`).
3. **Hard OOS gate** (~7453): `oos_policy='strict'` refuses 409 when per-store stock < qty;
   `backorder_gz` and bundles exempt.
4. **Routing** (`lib/inventory.js routeOrder`): GPS-nearest of the two GZ stores, or
   `out_of_city_store_id` (warehouse) for non-GZ / scheduled ship-districts so parcel + receipt match.
   **Stock gate is ON** only for pickup + GZ-same-day; OFF for out-of-GZ/scheduled (kitchen restocks
   before the fulfillment date). Fallback choices `cancel_missing`/`replace_missing`/
   `full_from_fallback`/`wait_for_restock` drive `analyzeShortage`.
5. **Atomic tx** (`tdb().transaction().immediate()` — `BEGIN IMMEDIATE` serializes the order-number
   read-then-insert). Every contended resource is an **atomic floor-check UPDATE**:
   voucher `used_count < max_uses` else `voucher_exhausted`; `points_balance >= ?`; `balance >= ?`;
   `flash_sold + qty <= limit`; `reserveForOrder` free-stock check. A zero-row UPDATE throws a
   specific error and **rolls the whole order back**; the loser retries.
6. **Post-commit side-effects** are all fire-and-forget (batch notice, print, push).

### Payment & settlement
- `markOrderPaid` (~3932) flips status **only** `WHERE status='pending_payment'` (idempotent;
  side-effects fire once on `changes>0`): commit reservations, award points, credit referral +
  lifetime commission, push/print/invoice, re-anchor "Earliest X" express slots to payment date.
- WeChat v3 + Alipay async callbacks verify signature + **amount parity** before `markOrderPaid`.
  `/payment/status` does live trade-query fallbacks (idempotent). `out_trade_no` is deterministic per
  channel so callbacks recover the order without extra storage.

### Refunds
- `splitRefundAcrossTenders` returns each ¥ to its source (points as points, balance as balance, cash
  as cash). `reverseOrderRedeem/Balance` are **cumulative-capped** (sum prior returns, never
  over-return) — this is the partial-refund-points correctness fix.
- `isFull = amount + 0.005 >= remainingGross`; **only full refunds** claw back earned points
  (`reverseOrderPoints`) + referral (`reverseOrderReferral`) + lifetime commission.
- Payout uses an atomic `approved→paying` claim so double-payout is impossible; direct (operator)
  refunds use a `NOT IN (pending,reviewing,approved,paying)` claim to avoid colliding with the
  customer-request flow. The transient `paying` state (money moving through the gateway) is now
  surfaced in the operator UI as a non-actionable in-progress note with **no Approve/Payout buttons**
  while the payout is mid-flight (see §6).

### Wait-for-restock
- Order parks at `awaiting_restock` (no reservation). `inventory.adjustStock` →
  `checkAwaitingRestockForRestock` promotes to `paid` only when **all** the order's products are back,
  then the `inventory.setOnOrdersPromoted` hook runs the deferred side-effects (points/referral/
  commission) that `markOrderPaid` skipped.

### Money/points/vouchers/tiers
- Wallet balance = prepaid credit (never pays shipping). Points earn/redeem/expiry ledger
  (`retail_points_transactions`), tier multipliers (seed→sprout→root→tree by `lifetime_spend`,
  reconciled at auth). Vouchers: fixed/percent/free-ship, `auto_apply`, signup grants; discount off
  `couponableSubtotal` so flash prices can't stack with sitewide coupons.

---

## 3. Integrations (`lib/*` + `scripts/*-daemon.js`)

### Two automation techniques
- **Playwright anti-fingerprint (Meituan, Guanyi).** Session persists to disk (a logged-out shell
  never overwrites a good session). `fingerprintInitScript` injects an internally-consistent "Windows
  Chrome" story (webdriver undef, Win32, matching client-hints, WebGL vendor, plugins synthesized only
  if empty), UA version pulled *dynamically* from the real Chromium so claimed features never lie.
  Orders read from the **signed JSON API issued from the logged-in page** (H5guard signs it), not the
  DOM (auto-accepted orders vanish from the UI). `验证中心` detection triggers escalating 30min→4h
  daemon cooldowns.
- **CDP-attach (Qingyun, Shangou).** Playwright's `webdriver=true` gets 403'd by H5guard, so these
  attach over CDP to a *genuine* Chrome (no automation flags). `_installCapture` patches
  `XMLHttpRequest.prototype` (can't be bypassed by a saved reference) to harvest correctly-signed
  request bodies, then replays via the page's own `fetch` so H5guard re-signs transparently.
  **Gotcha:** tear down a failed CDP connection before reconnecting, or leaked WebSockets wedge the box.

### Stock-sync spine
- `inventory.enqueueChannelSync(storeId, productId)` fans a stock delta to Meituan/Eleme/Guanyi queue
  tables, each via the **tenant handle** (`tdb()`). For Meituan this is
  `lib/meituan-bundles.enqueueProductStock(tdb(), …)`, which enqueues the mapped product **and** any
  bundle it belongs to. **Do the enqueue only through `inventory.adjustStock`** — do not add a direct
  `db.prepare('INSERT INTO *_sync_queue …')` in a route (it would duplicate the row and, under
  isolation, write a non-Roots change into Roots' queue). See `routes/retail-inventory.js` note.
- pm2 daemons drain the queues with **transient-vs-terminal** semantics (API rejection = terminal;
  nav hiccup = transient, ≤3 attempts), startup orphan-recovery re-enqueues crashed `processing` rows
  at *current* stock (prevents drift), and a proxy-health gate stops a dead proxy from cascading into
  false "session expired" re-logins.

### Signing schemes
- JD JOS = MD5 `secret+sortedKV+secret`; JD JDL cloud-print = fixed-order MD5 with **separate app
  keys** (mixing them silently breaks waybills); Nuonuo = OAuth + HMAC-SHA1 (base64); Feie =
  SHA1(`user+ukey+stime`); Aliyun SMS = POP HMAC-SHA1 with the `secret&`-trailing-ampersand key.
- **JD 一单多件 (multi-box):** staff set a box count when creating a JD label; JD keeps **one** tracking
  number but returns/prints one box label per piece from the same waybill. Persisted as
  `retail_shipments.package_count` (NULL/1 = ordinary single box); handled in `lib/jd.js`.
- **Kuaidi100** is a free webhook-subscription model (they poll carriers, push to a per-waybill
  salted callback), with ~40 ordered CN→EN regex rules that preserve location proper-nouns and swap
  only the verbs.

---

## 4. AI subsystem (`routes/ai.js`, `lib/model-gateway.js`, `lib/brand-*.js`)

- **Two abstraction layers on purpose:** `routes/ai.js` is the business layer with its own live
  Anthropic⇄DeepSeek adapter (converts Anthropic tool_use ↔ OpenAI `tool_calls` both directions);
  `lib/model-gateway.js` is the **white-label boundary** — the one file where vendor tells live
  (`MODEL_API_*` → `ANTHROPIC_*` fallback keeps prod working with zero config change), plus
  `clientSafe()` strips `provider/usage/raw/_detail` before anything reaches the browser.
- **Sprout chat loop** (`POST /api/ai/chat`, ~3171): up to 8 hops; no `tool_use` block ⇒ final reply.
  Tool results appended in one user turn, **capped at 12k chars each**; `parseToolInput` +
  `escapeStrayJsonQuotes` (a state machine escaping content quotes inside JSON strings) recover
  mis-escaped CJK tool args. System prompt split static/dynamic with `cache_control:ephemeral` on the
  static half + last tool → ~90% input-cost savings and rate-limit exemption within the 5-min window.
  Vision images attach to the last user message; `ai_memory` facts inject weighted by importance.
- **Brand designer** (`lib/brand-designer.js`): deterministic brief → catalog conditioning → forced
  `emit_brand_design` tool → `sanitizeLayout` (block allowlist, `javascript:`/`data:text/html` scrub,
  ≤14 blocks) → `coerceFonts` (installed families only) → `lib/brand-gates.js` deterministic checks
  (WCAG contrast = error/blocks; >10 colours = warning; monochrome-for-Chinese-audience advisory) →
  async in-memory job store (draft→publish).
- **compose-blocks** forces `emit_blocks`, validates against `COMPOSE_SCHEMA`, three-pass retry
  (full bilingual → nudge-on-empty → English-only+translate), bails on truncation.

---

## 5. WeChat mini app (`miniapp/`)

- **Auth + token recovery:** silent login exposes `app.authReady` so checkout awaits settle. On 401,
  `utils/api.js` kills the stale token and **coalesces concurrent 401s onto one `_reauthPromise`**,
  replays the original request once (`_retried` guard), nulls the promise on settle. Every request
  carries `x-wx-appid` (read once at boot) for tenant routing; unwraps `body.data ?? body`.
- **Cart** (`utils/cart.js`): localStorage-persisted; dedup key `product_id + sorted choice_ids`;
  `reprice()` refreshes *all* price fields from `/cart/price` so flash windows opening/closing
  mid-session stay honest; `couponableSubtotal()` excludes `coupon_blocked` lines.
- **Checkout state machine** (`pages/checkout/checkout.js`): profile-bind gate → address (CN native
  `chooseLocation` vs EN cascade via `utils/zones.js`, always writing canonical Chinese so the server
  matcher agrees) → `/checkout/quote` **with `delivery_slot_id` included** (its same-day nature
  changes stock-gating; omitting it caused quote↔orders disagreement) → coupon auto-apply-vs-manual
  (higher value wins) → points-then-wallet stacking (neither pays shipping). **OOS fallback** modal is
  server-gated (`none`/`simple_confirm`/`options_5`); the 5-option flow sends `fallback_choice` +
  `replacements[]`. On a 409 `needs_fallback_confirmation` that disagrees with the quote (GPS-vs-
  centroid race), it re-quotes once, then builds the modal from the 409 body. A 20s watchdog un-sticks
  a frozen "placing" button.
- **i18n** (`utils/lang.js`): `pick/pickLabel/pickVariantLabel/splitMixed/addrRegion`; language =
  user choice > `config.theme.language` > system.

---

## 6. Operator front-end + SaaS billing

- **retail-admin** = 10–14 numbered files in **one global scope, load-order-critical** (hence
  `/* eslint-disable no-undef */`). `01-core.js` bootstraps `$`, `api()`, `toast`, `ICONS`, RBAC
  `can()`/`setCaps()`/`applyCapGates()`. **Bump `public/sw.js` cache version when admin JS changes.**
- **Role-shaped dashboard** (`03-dashboard.js`): owner sees a 4-card morning glance (Recap · Needs-you ·
  Today · Customers; Today dropped its intraday chart — that's a Reports job); warehouse / dispatch-CS /
  `/dashboard/ops` get role-filtered Recap + Unhandled views. Money-card *presence* gates on the
  reliable `body.pos-*` role string; *Needs-you* sub-cards on `DASH_CARD_CAP` → `can()/canAny()` against
  the resolved cap set (self-composing — a per-user grant toggles a row with no code change).
- **Write-in-flight discipline:** state-changing controls disable their trigger while the write is in
  flight (double-click was double-submitting). `adminWrite(btnIds)` covers the common case; icon-bearing
  buttons use a manual `btn.disabled` guard (adminWrite's `textContent='…'` would strip the SVG);
  `transition()` (status writes) is disabled mid-write.
- **Refund `paying` render:** the transient 7th `refund_status='paying'` is modelled across
  `refundStepBadge`/`refundBadge`/`drawerRefundBanner` (dusk tint) with a non-actionable in-progress
  note and **no Approve/Payout buttons** while money is mid-flight (front-end only; no schema change).
- **Embedded Profile frame:** `/backend/account` runs in `#profFrame`; a two-way, origin-pinned
  `postMessage` contract (`fc-theme`/`fc-lang`) keeps theme + language synced across the boundary
  (repaint-only, no localStorage write-back, so the echo terminates in one round trip).
- **i18n engine** (`10-extras.js`): both languages live in the DOM as `EN · CN` text nodes /
  `data-lang-block` pairs; toggling rewrites `nodeValue` in place (no reflow), with an anti-FOUC
  `visibility:hidden` guard until `data-ui-lang` is stamped. A label **leaks** when JS injects
  bilingual text without `data-no-i18n` and the splitter mis-pairs it. `tagBlockPair` pairs **adjacent
  same-tag** pure-CJK/pure-Latin `div`/`p`; a `<span>` CN half is immune (the codebase's own remedy —
  used at the ingredient, gzgrocery-analytics, and recipes-list tables in `app.html`).
- **CMS** (`public/cms.html` + `public/shop/blocks.js`): block layouts stored as JSON in
  `storefront_config`; draft→live with a preview-token `postMessage` bridge to the mobile shell.
- **Billing lifecycle** (`lib/billing-lifecycle.js`): daily idempotent heartbeat — reminders at
  T-14/7/3/1 deduped by `UNIQUE(subscription_id, period_end, milestone)`, dunning ladder
  trialing/active → `past_due` → `grace`(7d) → `suspended`(14d), `ensure_renewal_invoice` idempotent
  per (subscription, period_start), `is_internal` carve-out so Roots is never dunned.
- **WeChat Pay v3** (`lib/billing-providers.js`): outbound `RSA-SHA256` over
  `METHOD\nPATH\nTS\nNONCE\nBODY\n`; inbound callback `AES-256-GCM` where `decipher.final()`
  (auth-tag verify) is the security gate; `out_trade_no = FCSUB<invoiceId>` is deterministic.

---

## 7. Known risk classes (respect these when editing)

From the 2026-06-12 overnight bug-hunt + audits. All verified **fixed in current code**; listed so the
*classes* stay on your radar:

1. **Money reversals on refund/cancel** — referral clawback (`reverseOrderReferral`), partial-refund
   points (scaled `split.points`, full reversal only when `isFull`), wait-for-restock referral (via
   `setOnOrdersPromoted`). Keep reversals cumulative-capped and idempotent.
2. **`tdb()` scoping before isolation cutover** — data-plane reads/writes must use `tdb()`; only
   control-plane `users` reads may use the shared `db`. Do channel-sync enqueues **only** through
   `inventory.adjustStock` (see §3).
3. **Base64 blob leaks in list endpoints** — list responses must emit lazy `/image?v=` URLs via
   `hasImageFallbackSql`, never raw `image_data`.
4. **WeChat one-shot subscribe-consent burns** — set `used=1` only after a confirmed `errcode===0`;
   guard the push branch with `if (!ORDER_STATUS_NOTIF[newStatus]) return;` (refund flows pass `null`).
5. **Bare-date coupon expiry as UTC midnight** — normalize via `normalizeVoucherExpiry` (applied in
   both POST and PATCH); a bare `YYYY-MM-DD` otherwise dies ~16h early in Beijing time.
6. **i18n pair-hiding** — never stack `EN · CN` data into a label node without `data-no-i18n`; never
   put a pure-CJK sub-label in an adjacent same-tag `div` (use a `<span>` or separate `<td>`).
