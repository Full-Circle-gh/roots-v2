# Tacet core survey — current state before the shared-core consolidation

Read-only inventory, 2026-07-30. Every claim below is cited to a file (and line where it
helps). Where the code does not settle a question, the entry says **UNVERIFIED** and why.
No file in this repo was changed except this one.

---

## Executive summary (ten lines)

1. There is already **one backend service and one database**: a single Node/Express app
   (`server.js`, port 4000) over one SQLite file `data/roots.db` (`database.js:8`).
2. The two frontends are the **kitchen/ERP app** (`public/app.html`) and the **Mini App
   Backend / store console** (`public/retail-admin.html`). I read these as Production and
   Sales; the repo never uses those two words as app names (see "Naming" below).
3. The split is **not** at the database — it is at the **table** level. The same DB holds two
   parallel worlds: `products`/`recipes`/`ingredients`/`markets` (Production) and
   `store_products`/`retail_*` (Sales).
4. **Products is the big duplication**: `store_products` is a deliberate runtime *clone* of
   `products` (`database.js:3646-3778`) with its own SKU space, its own stock and 14 extra
   columns. Both tables are live and edited independently.
5. The link columns for a future re-integration exist (`kitchen_product_id`, `source_sku`,
   `synced_at`, `source`) but **no code ever reads them** — the fork stamped them once and
   nothing since.
6. **There is no product/catalogue sync between the two sides.** The only live cross-side data
   paths are the restock transfer and two kitchen-app screens that write Sales stock.
7. Those paths are the sharpest consolidation risk: they take a **`products.id`** and use it as a
   **`store_products.id`** (`routes/restock.js:237-247`, `routes/products.js:569-614`). It
   works only because the fork preserved ids.
8. **Two authorization models, two user tables**: Production is role + 18 boolean module
   flags (`users` + `permissions`); Sales is role-preset + capability keys
   (`tenant_users` + `tenant_user_caps`, 90 keys in `lib/capabilities.js`). Separate records,
   overlapping id spaces, one shared session store.
9. Capability enforcement on the big Sales API is **still off by default**
   (`tenants.rbac_enforce DEFAULT 0`, `routes/backend-auth.js:253`); only `/api/backend/*`
   team routes enforce unconditionally.
10. Other consolidation blockers found: divergent "today" (Sales normalises to UTC+8, Production does
    not), divergent delete semantics, divergent channel enums, three co-existing category
    schemes, two location tables, four stock stores, and account scoping that is row-level on
    three tables and database-level everywhere else.

---

## Naming — how I mapped "Sales" and "Production" onto this repo

The repo does not label any app "Sales" or "Production". Two things could mislead:

- `routes/sales.js` is a **Production** module (kitchen sales log over `sales_entries`,
  gated on the kitchen `sales` permission — `routes/sales.js:13`).
- "Sales" is also the name of a **page inside the Sales console** (`docs/tacet-sales-addendum.md`),
  and `routes/production.js` is a small kitchen batch-log module (`routes/production.js:8`).

So I used the **auth realm** as the app boundary, because that is what the code actually
separates on (`docs/PROJECT-KNOWLEDGE.md:19-26`, verified against `server.js:158-166`,
`middleware/auth.js:3-13`, `routes/retail.js:86-160`):

| Label | Frontends | Auth realm (session key) | User table |
|---|---|---|---|
| **[P] Production** | `public/app.html`, `public/kitchen.html`, `public/pos.html` | `session.userId` | `users` + `permissions` |
| **[S] Sales** | `public/retail-admin.html` + `public/retail-admin/01..17-*.js`, `public/product-editor.html`, `public/cms.html`, `public/stock.html`; customer surfaces `miniapp/` and `public/shop.html` | `session.backendUserId` + `session.tenantId` | `tenant_users` |
| **[H] Hybrid** | `public/restock.html` | either (calls both APIs) | both |
| *(third realm, out of scope but present)* | `public/store-admin.html`, `public/saas-admin.html` | `session.platformAdminId` | `platform_admins` (`lib/platform-admin.js:27`) |

`public/restock.html` is genuinely hybrid: it fetches `/api/products` (Production) at
`public/restock.html:1149` and `2825`, and `/api/retail-admin/quick-stock/context` (Sales) at
`public/restock.html:1454`.

Term definitions used below, one line each:
- **Data-plane table** — business data, cloned into each account's own DB file.
- **Control-plane table** — shared across all accounts, never cloned (`lib/tenant-db.js:44-49`).
- **Capability** — a `section:action` permission string, e.g. `orders:refund`.
- **Fork** — a copy of a table made once, then edited independently with no sync back.

---

## 1. Entity inventory

### 1.1 Products

| | Production `products` | Sales `store_products` |
|---|---|---|
| Defined | `schema.sql:136-158` (20 cols) + 51 `addColumn` calls in `database.js` (lines 24-28, 59-103, 132, 152, 996-1070, 2743-2771) → **64 distinct columns** | `database.js:3665-3686` — created at boot by reading `PRAGMA table_info(products)` and re-emitting it, then 10 store-only `addColumn`s (`database.js:3689-3753`) + 4 link columns (`3677-3680`) → **78 columns** |
| Stored | table `products` in `data/roots.db` | table `store_products` in `data/roots.db` |
| Written by | `routes/products.js` (34 statements), `scripts/import_products.js`, `scripts/import_gzgrocery.js` | `routes/retail.js` (138 references), `database.js` (the one-time seed) |
| Read by | `routes/products.js`, `ai.js`, `sales.js`, `alerts.js`, `pos.js`, `waste.js`, `markets.js`, `admin.js` | `routes/retail.js`, `retail-inventory.js`, `retail-purchasing.js`, `retail-setup.js`, `meituan-*`, `eleme-*`, `guanyi-*`, `lib/inventory.js`, `lib/brand-designer.js`, `public/retail-admin/09-products.js` |
| SKU space | `idx_products_sku` (UNIQUE, `schema.sql:140`) | **its own** `idx_store_products_sku` (UNIQUE, `database.js:3756`) |

`routes/retail.js` contains **zero** references to the bare `products` table (verified by
grep). The two catalogues are cleanly separated at the API layer.

### 1.2 Product categories — three co-existing schemes

1. **Flat, kind-scoped list** — table `categories(kind, name, sort_order)`, `schema.sql:413-420`.
   `kind` values seen in code: `'recipe'`, `'product'`, `'item_kind'`, `'payment_method'`,
   `'role'`. Written by both sides: Production via `routes/lookups.js:21-41` and
   `routes/admin.js:241`; Sales via `routes/retail.js:18284-18394`.
2. **Two-level bilingual tree** — `storefront_config['category.tree']` (JSON), read/written
   through `lib/category-tree.js:109-120` and `routes/retail.js:326, 375, 475`. Products carry
   `top_category` + `subcategory` as the tree's exact name strings.
3. **Hardcoded fallback** — `SEED_TREE`, 7 tops / 40 subs, `lib/category-tree.js:17-72`. Used
   on first boot and whenever the DB row is missing or unparseable.

`lib/category-tree.js` is genuinely shared: `normalizeCategoryPair()` is called by both
`routes/products.js:437, 497, 700` **and** `routes/retail.js:17720, 17864`.

There is also a **legacy free-text** `products.category` / `store_products.category` column
(`schema.sql:141`) still indexed and filtered on by the shop (`database.js:3764`).

### 1.3 Locations / stores — two independent tables

| | Production `markets` | Sales `retail_stores` |
|---|---|---|
| Defined | `database.js:612-621` + `addColumn`s at `622-635` (`kind`, `lat`, `lng`, `daily_target`) | `database.js:2565-2581` |
| Kinds | `kind` ∈ `'market'` (default) / `'retail'` / `'warehouse'` / `'kitchen'` (`database.js:612-621` comment) | no kind column; `code` slug + `sort_order` = routing priority |
| Written by | `routes/markets.js` | `routes/retail-inventory.js:76-...` |
| Read by | `routes/markets.js`, `pos.js`, `ai.js`, `events.js:111`, `restock.js` | `routes/retail.js`, `retail-inventory.js`, `restock.js:171-201`, `products.js:536, 575`, `lib/inventory.js:84-99`, all channel modules |
| User binding | `users.market_id` (`database.js:636`) | `users.retail_store_id` (`database.js:640`) **and** `tenant_users.retail_store_id` + `tenant_user_stores` (`routes/backend-auth.js:81-86`) |

There is a **third**, string-only notion of location: `purchase_orders.warehouse` TEXT
(`schema.sql:167`) and `restock_orders.store_name` / `store_cn` TEXT (`schema.sql:290-291`),
which `routes/restock.js:181-192` resolves back to a `retail_stores` row by fuzzy name/code
match.

### 1.4 Inventory / stock — four separate stores of quantity

| Store | Table / column | Keyed on | Written by | App |
|---|---|---|---|---|
| Kitchen single number | `products.stock_qty` (`database.js:69`) | `products.id` | `routes/products.js:642` (the only writer) | P |
| Market stall stock | `market_stock(market_id, product_id, qty)` (`database.js:449-458`) | `markets.id` × `products.id` | `routes/markets.js:203` (the only writer) | P |
| Per-store sellable stock | `retail_store_stock(store_id, product_id, physical_qty, safety_buffer, wechat_quota, meituan_quota)` (`database.js:2583-2595`) | `retail_stores.id` × **`store_products.id`** | `lib/inventory.js` `adjustStock`/`upsertStockLayer` (706, 751), reached from `routes/retail.js`, `retail-inventory.js`, `retail-purchasing.js`, `restock.js`, the channel modules | S (+ P via two endpoints, see §3) |
| Legacy store number | `store_products.stock_qty` | `store_products.id` | superseded — `routes/retail.js:13196-13206` documents it as a fallback used only when no per-store rows exist | S |

Supporting Sales tables: `retail_stock_reservations` (`database.js:2599-2617`) and the
append-only `retail_stock_ledger` (`database.js:2620-2640`). Production's equivalent audit is
`market_stock_ledger` (`database.js:464-479`).

Two Production quantity stores are effectively **disconnected**: POS checkout
(`routes/pos.js`) touches `markets`, `products`, `sales_entries`, `users` — it never
decrements `market_stock`; and no route other than `routes/markets.js:203` writes
`market_stock`, despite the comment at `database.js:445-448` saying it is incremented when a
restock is delivered. That auto-increment does not exist in current code.

### 1.5 Users

| | Production | Sales | Platform |
|---|---|---|---|
| Table | `users` (`schema.sql:7-16`) | `tenant_users` (`routes/backend-auth.js:43-54`) | `platform_admins` (`lib/platform-admin.js:27-36`) |
| Extra cols | `market_id`, `retail_store_id` (`database.js:637, 640`) | `scope_all`, `retail_store_id`, `avatar_url` (`routes/backend-auth.js:157`), recovery email | — |
| Seeded | 4 users `admin`/`manager`/`warehouse`/`kitchen` (`routes/auth.js:23-42`) | 1 user `owner` per account (`routes/backend-auth.js:264-270`) | first-run seed in `lib/platform-admin.js` |
| Login | `routes/auth.js` | `routes/backend-auth.js` | `routes/store-admin.js` |
| Session key | `session.userId` | `session.backendUserId` + `session.tenantId` | `session.platformAdminId` |
| Plane | **control-plane** — never cloned per account (`lib/tenant-db.js:48`) | **control-plane** (`lib/tenant-db.js:45`) | control-plane |

Customers are a fourth, single-definition entity: `retail_customers`
(`database.js:1074-1092`), Sales-only, bearer-token auth via `retail_auth_tokens`
(`database.js:1113`). No Production counterpart exists.

### 1.6 Roles / permissions / capabilities

See §4 for the full lists. Storage:
- Production: `users.role` TEXT + `permissions` row of 18 boolean columns
  (`schema.sql:26-41` + `addColumn`s at `database.js:395, 401, 405, 409, 415, 420, 1359`).
- Sales: `tenant_users.role` TEXT (a preset name) + per-user deviations in
  `tenant_user_caps(capability_key, mode)` and store scope in `tenant_user_stores`
  (`routes/backend-auth.js:69-86`). The registry itself is **code, not data**:
  `lib/capabilities.js`.
- Custom Production roles are stored as `categories` rows with `kind='role'`
  (`routes/admin.js:17`) — a role list living inside the category table.

### 1.7 Other core entities found

| Entity | Table(s) | Defined | Apps |
|---|---|---|---|
| Ingredients | `ingredients`, `ingredient_price_history` | `schema.sql:44-78` | P only |
| Recipes | `recipes`, `recipe_ingredients`, `recipe_steps`, `recipe_cost_data` | `schema.sql:81-133` | P only |
| Production batches | `production_batches` | `schema.sql:323-340` | P only (`routes/production.js`) |
| Waste | `waste_entries` | `schema.sql:264-282` | P only |
| Kitchen ingredient orders | `kitchen_orders`, `kitchen_order_items` | `schema.sql:343-366` | P only |
| Suppliers | `suppliers`, `supplier_documents` | `schema.sql:380-409`, `database.js:503` | **both** (`routes/lookups.js` P, `routes/retail-purchasing.js` S) |
| Purchase orders | `purchase_orders`, `po_line_items`, `invoices`, `invoice_lines` | `schema.sql:161-196`, `database.js:235-268` | **both**, split by `purchase_orders.scope` |
| Finance ledger | `income_entries`, `expense_entries`, `price_alerts` | `schema.sql:204-227, 423-432` | P only (`routes/finance.js`) |
| Kitchen sales log | `sales_entries`, `sale_addons` | `schema.sql:230-261` | P only |
| Customer orders | `retail_orders`, `retail_order_items`, `retail_payments`, `retail_refund_events`, `retail_shipments` | `database.js:1169-1214, 1232, 1252, 1595, 2837` | S only |
| Restock movements | `restock_orders`, `restock_items` | `schema.sql:285-317` | **both** (see §3) |
| Legacy imported orders | `miniapp_orders`, `miniapp_order_lines` | `database.js:758, 809` | P (`routes/sales.js`) |
| Channel mirrors | `meituan_*` (11 tables), `eleme_*` (6), `guanyi_*` (5), `delivery_jobs` | `database.js:842-921, 3978-4110, 4166-4340, 4383-4600` | S |
| Tenancy / billing | `tenants`, `tenant_users`, `tenant_domains`, `tenant_secrets`, `billing_*` | `routes/backend-auth.js:29-125`, `routes/billing.js:27-70`, `lib/tenant-creds.js:31`, `lib/billing-lifecycle.js:41` | S + Platform |
| Storefront config (KV) | `storefront_config(key, value_json)` | `database.js:1306` | S (read by `routes/ai.js` too) |
| Activity log | `activity_log` | `schema.sql:435-446` | **both** (`middleware/auth.js:39-51`) |

---

## 2. Duplication map

Classification: **(a)** single shared definition · **(b)** two independent definitions ·
**(c)** partially shared.

| Entity | Verdict | Detail |
|---|---|---|
| **Products** | **(b) two independent definitions** | `products` vs `store_products` — field diff below |
| **Product categories** | **(c) partially shared** | one shared `categories` table + one Sales-only tree in `storefront_config` + a hardcoded seed tree; both sides validate `top_category`/`subcategory` through the same `lib/category-tree.js` |
| **Locations** | **(b) two independent definitions** | `markets` vs `retail_stores` — field diff below |
| **Inventory / stock** | **(b) two independent definitions** | `market_stock` + `products.stock_qty` vs `retail_store_stock` (+ reservations + ledger) |
| **Users** | **(b) two independent definitions** | `users` + `permissions` vs `tenant_users` + `tenant_user_caps` + `tenant_user_stores` |
| **Roles / permissions** | **(b) two independent definitions** | 18 boolean module flags vs 90 capability keys / 16 role presets |
| **Suppliers** | **(a) single shared definition**, with divergent read scoping | one `suppliers` table; Sales filters `tenant_id`, Production does not (see §6) |
| **Purchase orders / bills** | **(c) partially shared** | one `purchase_orders`/`po_line_items`/`invoices` set, discriminated by `scope` ∈ `'kitchen'`/`'retail'` (`database.js:43`); a retail line uses `store_product_id`, a kitchen line uses `ingredient_id` — "one of the two is always NULL" (`database.js:40`) |
| **Restock orders** | **(a) single shared definition** | one `restock_orders`/`restock_items` set; `routes/restock.js` serves both sides |
| **Customers** | **(a) single definition** | `retail_customers`, Sales-only — nothing to consolidate |
| **Revenue / sales reporting** | **(b) two independent definitions** | `sales_entries` (per line) vs `retail_orders` (per order) — enum + period diff below |
| **Sessions** | **(a) single store** | one `data/sessions.db` (`server.js:159`), three non-colliding keys |
| **Activity log** | **(a) single table**, lossy for Sales | `activity_log.user_id` FK → `users(id)`; an operator's id is **stored as NULL** because it would violate the FK (`middleware/auth.js:41-47`) |
| **Push subscriptions** | **(b) two independent definitions** | `push_subscriptions` FK→`users(id)` (`database.js:114-124`) vs `tenant_operator_push_subs` (`routes/backend-auth.js:221`) |
| **Live updates (SSE)** | **(b) two independent definitions** | `/api/events` permission-targeted broadcast (`routes/events.js:30, 69`) vs `/api/retail-admin/stream` signature-poll nudge (`routes/retail.js:13136`) |

### 2.1 `products` vs `store_products` — field-level differences

`store_products` is built by mirroring `products`' column list, so **all 64 `products`
columns exist on `store_products` with identical names and types** (`database.js:3669-3686`;
a parity backfill loop at `3686` re-mirrors any column `products` gains later).

**Present only on `store_products` (14):**

| Column | Purpose (from the code comment) |
|---|---|
| `kitchen_product_id` | source `products.id` at fork time (`database.js:3677`) |
| `source_sku` | SKU at fork time, "stable match key" (`3678`) |
| `synced_at` | "reserved: last pull-from-kitchen" (`3679`) |
| `source` | `'fork'` \| future `'sync'` (`3680`) |
| `product_facts` | JSON facts bag (`3689`) |
| `variant_label_cn` | Chinese half of the variant tag (`3693`) |
| `variant_noun_en`, `variant_noun_cn` | variant axis noun (`3699-3700`) |
| `low_stock_threshold` | per-product low-stock alert level (`3705`) |
| `bundle_items` | JSON `[{id, qty}]` component recipe (`3714`) |
| `bundle_mode` | `'assembled'` \| `'prepacked'` \| NULL (`3725`) |
| `no_coupon_on_flash` | exclude from voucher base while on flash (`3731`) |
| `supplier_paused` | supplier-direct "temporarily out" switch (`3747`) |
| `image_aspect` | PDP hero aspect ratio (`3753`) |

**Present only on `products` (1 constraint, not a column):** the inline
`FOREIGN KEY (recipe_id) REFERENCES recipes(id)` (`schema.sql:157`) is **dropped** on
`store_products` — "the store has no recipes" (`database.js:3660-3661`). The `recipe_id`
column itself is still mirrored across.

**Same columns, different meaning:**
- `sku` — separate UNIQUE indexes, so the same code can exist once on each side
  (`schema.sql:140` vs `database.js:3756`).
- `barcode` — separate UNIQUE partial indexes (`database.js:104` vs `3758`).
- `stock_qty` — authoritative on `products` (`routes/products.js:642`); legacy/fallback on
  `store_products` (`routes/retail.js:13196-13206`).
- `is_published`, `retail_price`, `retail_stock`, `retail_display_order`, `retail_tagline`,
  `retail_description_en/cn` — these were added to `products` **before** the fork
  (`database.js:996-1002`). They are dead on the Production side now that
  `product_catalog_mode` for account 1 is `'self'` (`routes/backend-auth.js:287-299`).

### 2.2 `markets` vs `retail_stores` — field-level differences

| `markets` only | `retail_stores` only | Shared (same meaning) |
|---|---|---|
| `location` (free text), `daily_target`, `kind` | `code` (UNIQUE slug), `address`, `city`, `district`, `phone`, `meituan_account_id`, `sort_order`, `open_time`/`close_time`/`timezone` (added later — referenced at `lib/tenant-db.js:87`) | `id`, `name`/`name_en`, `name_cn`, `lat`, `lng`, `is_active`, `created_at`, `updated_at` |

Note the name-column mismatch: `markets.name` vs `retail_stores.name_en`
(`database.js:612-621` vs `2566-2569`).

### 2.3 `permissions` vs capability registry

Production has **18 boolean gates**, all on one row per user:
`dashboard`, `recipes`, `ingredients`, `products`, `purchases`, `finance`, `sales`, `kitchen`,
`waste`, `restock`, `alerts` (`schema.sql:29-39`), then `can_delete`, `suppliers`, `pos`,
`ai`, `warehouse_inbox`, `kitchen_inbox` (`database.js:395-420`) and `retail`
(`database.js:1359`).

Sales has **90 capability keys** in 30 sections (`lib/capabilities.js:33-158`). There is
**no key overlap** with the Production flag names in either direction except by coincidence
of the English word (`products`, `restock`→`purchasing`, `alerts`→none). Notably absent from
the Sales registry: any capability for recipes, ingredients, production batches, waste, or
the finance ledger — those Production modules have no capability equivalent.

### 2.4 `sales_entries` vs `retail_orders`

| | `sales_entries` [P] | `retail_orders` [S] |
|---|---|---|
| Grain | one row **per product line** (`schema.sql:230-244`) | one row **per order** (`database.js:1169`) |
| Date field | `date` DATE, no time, no timezone normalisation | `placed_at`/`paid_at` DATETIME, read with `date(…, '+8 hours')` |
| Channel enum | `['dinein','meituan','eleme','miniapp','wechat','retail','gzgrocery']` (`routes/sales.js:10`) | default `'wechat'`; literals seen: `'wechat'`, `'web'`, `'meituan'`, `'gzgrocery'`, `'manual'` (`database.js:2650`, `routes/retail.js`) |
| Ticket count | de-duped by a `[miniapp:OID:LINE]` string parsed out of the `notes` column (`routes/sales.js:275-280`) | one row = one order |
| Populated by | POS checkout (`routes/pos.js:65`), manual entry (`routes/sales.js:55, 74`), three XLSX importers | live checkout (`routes/retail.js`), Meituan daemon mirror |
| Summary endpoint | `/api/sales/summary` (`routes/sales.js:232`), 7 period presets | `/api/retail-admin/sales/summary` (`routes/retail.js:11610`), today only |

Enum collisions to resolve: `miniapp` vs `wechat` for the same channel; `retail` vs `web`;
`dinein` exists only on the Production side.

**§0 framing, added 2026-07-31:** reconciling these seven is a migration detail, **not the task**.
Both enums are **Roots' channel list**, not Tacet's. `docs/tacet-consolidation-decisions.md` §0 makes the channel
list per-business configuration, with integrations offered as available options — so the target is
a configurable list, not one agreed hardcoded set. `gzgrocery` in particular is specific to one
customer.

*(Correction to the docs: `docs/tacet-sales-addendum.md` states that
`/api/retail-admin/sales/summary` "does not exist". It exists at `routes/retail.js:11610` and
is called at `public/retail-admin/01-core.js:416`. The doc is a 2026-07-19 save-point and is
stale on this point.)*

---

## 3. Sync code map

### 3.1 The catalogue: no sync exists

The fork was a **one-time migration**, guarded by `_migrations` name
`store_products_seed_fk_v1` (`database.js:3801-3859`). It:
1. inserted every published product plus every product referenced by a store-owned table into
   `store_products`, **preserving `id`** (`database.js:3830-3843`);
2. rewrote the FK on 8 store-owned tables from `REFERENCES products(` to
   `REFERENCES store_products(` (`database.js:3805-3823`).

The header comment is explicit: `kitchen_product_id` / `source_sku` "keep a link so a future
one-way 'pull from kitchen' sync can re-integrate the two (**the sync job itself is NOT built
yet**)" (`database.js:3652-3653`).

I verified that. A repo-wide grep for `kitchen_product_id`, `source_sku` and `synced_at` (as a
`store_products` column) returns hits **only** in `database.js` — no route, lib, script,
daemon or frontend reads or writes them. **There is no scheduled job, webhook, script, or API
call that copies products between the two sides.**

The dormant mechanism that *would* have kept them aligned is `tenants.product_catalog_mode`:

- `'upstream'` means the catalogue is mastered externally and the Sales console may edit only
  merchandising fields — enforced at `routes/retail.js:17553-17554` (field filter against
  `UPSTREAM_LOCKED_FIELDS`, `routes/retail.js:190-193`) and `17847`, `18068`, `18093`, `18615`
  (whole-product operations return HTTP 423).
- Roots (account 1) was set to `'upstream'` by migration
  `tenant_catalog_mode_roots_upstream_v1` (`routes/backend-auth.js:282`), then **flipped to
  `'self'`** by `tenant_catalog_mode_roots_self_v1` — "the store catalog was forked into its
  own store_products table (the kitchen `products` table no longer drives the shop)"
  (`routes/backend-auth.js:287-299`).

So the lock is live code, but off for the only live account.

### 3.2 The three live cross-side data paths

**(1) Restock transfer — Production writes Sales stock.** Direction: **P → S**.
`routes/restock.js:206-256` `_applyRestockTransfer()`. When a restock order reaches
`prepared`, it reads `restock_items.product_id` (a Production table — the FK repoint
deliberately left `restock_items` pointing at `products`, `database.js:3785-3786`) and calls
`inventory.adjustStock({ storeId, productId, deltaQty })` twice: minus at the warehouse store,
plus at the destination store (`routes/restock.js:237-247`). `adjustStock` writes
`retail_store_stock` and resolves product names from `store_products`
(`lib/inventory.js:706`, `1177`). Idempotent via `restock_orders.stock_applied_at`
(`routes/restock.js:213, 251`). Kitchen-direction transfers are skipped (`211`).

**(2) Kitchen product page writes Sales stock.** Direction: **P → S**.
- `GET /api/products/:id/store-stocks` (`routes/products.js:530-561`) reads `retail_stores` +
  `retail_store_stock` for a `products.id`.
- `POST /api/products/:id/store-stocks/:storeId/adjust` (`routes/products.js:569-614`)
  validates the id against `products` (line 573) then calls `inventory.adjustStock` (597).

**(3) Dual-realm inventory API.** Direction: **shared surface**.
`routes/retail-inventory.js:55-65` `requireInventoryRead` accepts **either** realm: a Sales
operator session routes to `requireRetailAdmin`, a Production session passes on
`role==='admin'`, `permissions.retail`, or a non-null `users.retail_store_id`. The same
pattern is in `requireRetailAdmin` itself, whose branch (2) admits a kitchen user holding the
`retail` permission and grants them **the full capability set** (`routes/retail.js:150-155`).

### 3.3 Frontend-level cross-calls

`public/app.html` (Production) calls Sales endpoints directly:
`/api/retail-admin/stores` (×6) and `/stores/…` (×8), `/api/retail-admin/inventory/grid`,
`/api/retail-admin/inventory/geocode-backfill`, `/api/retail-admin/products/…/substitutes`
(`public/app.html:12473, 12512`), `/api/retail/category-tree` (×5), `/api/retail/media/…`,
`/api/retail-admin/cms/media`.

The reverse does not happen: a grep of `public/retail-admin/*.js` + `retail-admin.html` for
`/api/products|ingredients|recipes|purchases|finance|sales|waste|restock|production|kitchen|markets|pos|admin`
returns **no matches**. Sales never calls Production.

### 3.4 Manual import scripts (CSV / XLSX / JSON), all Sales-or-channel → Production

| Script | Direction | Writes |
|---|---|---|
| `scripts/import_miniapp.js` | mini-app order export (S) → P | `miniapp_orders`, `miniapp_order_lines`, and projects each order into `sales_entries` with `channel='miniapp'` (`import_miniapp.js:1-21, 89`) |
| `scripts/import_meituan.js` | Meituan XLSX → P | `sales_entries` (`:123`) |
| `scripts/import_gzgrocery.js` | gzgrocery XLSX → P | `sales_entries` (`:135`) **and** `products` |
| `scripts/convert_gzgrocery_xlsx.js`, `convert_meituan_xlsx.py` | XLSX → JSON, feeds the above | — |
| `scripts/import_products.js` | JSON → P | `products` |
| `scripts/import_full.js`, `import_descriptions.js`, `import_yogurt.js` | external OUT1N export → S | `store_products` (`import_full.js:1-6`) |

These are hand-run on the server; none is scheduled.

### 3.5 Outbound channel sync (Sales → external, not cross-app)

`lib/inventory.js:60-72` `enqueueChannelSync()` fans a stock delta into
`meituan_sync_queue` / `eleme_sync_queue` / `guanyi_sync_queue`; pm2 daemons
(`scripts/meituan-daemon.js`, `eleme-daemon.js`, `guanyi-daemon.js`, `qingyun-daemon.js`,
`shangou-daemon.js`, `gzgrocery-order-daemon.js`) drain them. All product ids in these tables
are `store_products.id` (`database.js:3992`: `FOREIGN KEY (product_id) REFERENCES
store_products(id)`). This is Sales ↔ marketplace, not Sales ↔ Production.

### 3.6 Explicitly absent

- No products/categories/stock sync job between the two sides.
- No webhook in either direction (grep for `text/event-stream` finds only the two SSE
  endpoints in §2, both intra-app).
- No Production route reads `retail_orders` (verified: zero matches across
  `sales.js`, `finance.js`, `pos.js`, `products.js`, `ai.js`, `markets.js`, `waste.js`,
  `admin.js`, `kitchen.js`, `production.js`). Live customer revenue reaches the Production
  finance/sales views **only** through the manual XLSX importers in §3.4.

---

## 4. Permissions as-is

### 4.1 Model

**Mixed, and different per app.**

- **Production — role + boolean module flags.** `middleware/auth.js`: `requireAuth` loads the
  `users` row and its `permissions` row (lines 8-11); `requirePermission(...modules)` passes
  if **any** named flag is truthy (20-26); `requireAdmin` is a bare string compare on
  `role === 'admin'` (15-18); `requireDelete` gates destructive actions on the single
  `can_delete` flag (33-37). `role === 'admin'` is an unconditional bypass in all three.
- **Sales — role preset + capability set.** `lib/capabilities.js` `resolveCaps()`:
  `effective = (preset ∪ grants) − revokes ∩ entitledFeatures`, with `role === 'owner'`
  returning every key unconditionally (lines 300-320). `lib/operator-caps.js:21-54` is the DB
  reader. Resolved fresh on every request, never cached in the session
  (`routes/retail.js:110-117`).

### 4.2 Every role found in code

**Production `users.role`** — built-in list `['admin','manager','warehouse','kitchen']`
(`routes/admin.js:16`), plus any custom role name stored as a `categories` row with
`kind='role'` (`routes/admin.js:17`). `schema.sql:11` documents the same four.
Default permission maps: `routes/auth.js:31-36` (seed) and `routes/admin.js:28-34` (creation).

**Sales `tenant_users.role`** — 16 presets in `lib/capabilities.js:179-274`:
`owner` (= `'*'`), `admin`, `staff`, `manager`, `store_manager`, `warehouse`,
`customer_service`, `dispatch`, `marketing`, `fulfillment`, `channel`, `kitchen`,
`store_stock`, `custom`. The table's own comment says only `owner | admin | staff`
(`routes/backend-auth.js:49`) — **the comment is stale relative to the registry.**

**Platform `platform_admins.role`** — `['super','billing','support']`
(`lib/platform-admin.js:58`).

### 4.3 Every capability key (90, from `lib/capabilities.js:33-158`)

- **run/dashboard** — `dashboard:view`, `reports:view`
- **run/orders** — `orders:view`, `orders:edit`, `orders:refund`, `orders:dispatch_courier`, `orders:export`
- **run/invoices** — `invoices:view`, `invoices:manage`, `invoices:export`
- **run/customers** — `customers:view`, `customers:edit`, `customers:adjust`, `customers:block`, `customers:export`
- **run/activity** — `activity:view`, `activity:export`
- **run/quickstock** — `quickstock:add` *(feature `kitchenAdd`)*, `quickstock:recount` *(feature `quickStock`)*
- **run/purchasing** — `purchasing:view`, `purchasing:edit`, `purchasing:receive`
- **sell/products** — `products:view`, `products:create`, `products:edit`, `products:delete`, `products:export`
- **sell/categories** — `categories:view`, `categories:edit`
- **sell/editor** — `editor:view`, `editor:edit`
- **sell/coupons** — `coupons:view`, `coupons:create`, `coupons:edit`, `coupons:delete`, `coupons:grant`
- **sell/flash** — `flash:view`, `flash:edit`, `flash:delete`
- **sell/popups** — `popups:view`, `popups:edit`, `popups:delete`
- **sell/broadcasts** — `broadcasts:view`, `broadcasts:send`
- **sell/other** — `sharing:edit`, `social:edit` *(socialProof)*, `affiliate:view`, `affiliate:edit` *(affiliate)*, `loyalty:view`, `loyalty:edit`, `topup:edit`, `leaderboard:edit` *(membership)*, `voting:edit`
- **content** — `content:view`, `content:edit`, `media:view`, `media:upload`, `media:delete`, `reviews:view`, `reviews:moderate` *(reviews)*, `feedback:view`, `feedback:moderate`, `feedback:export` *(feedback)*
- **setup/integrations** — `integrations:view`, `integrations:manage`
- **setup/delivery** — `delivery:view`, `delivery:edit`, `delivery:delete`
- **setup/channels** — `meituan:view|map|sync`, `eleme:view|map|sync`, `guanyi:view|map|sync`
- **setup/shipping** — `shipping:config`
- **setup/settings** — `settings:shop`, `settings:push`, `settings:payments`
- **setup/stores** — `stores:view`, `stores:edit`, `stores:delete`
- **setup/team** — `team:view`, `team:manage`, `team:permissions`
- **setup/billing** — `billing:view`, `billing:pay`
- **setup/ai** — `ai:view`, `ai:generate`, `ai:publish`
- **setup/diagnostics** — `diagnostics:view`

### 4.4 Are the two apps on the same auth system and the same user records?

**No, on both counts.** Different tables, different login routes, different session keys
(`routes/auth.js` / `routes/backend-auth.js`; `session.userId` / `session.backendUserId`).
What they *do* share is one Express session store — `connect-sqlite3` over
`data/sessions.db`, one cookie, 8-hour `maxAge` (`server.js:158-170`).

Three deliberate bridges exist:
1. `requireRetailAdmin` branch (2): a Production user with `permissions.retail` gets full
   Sales access and the **entire capability set** (`routes/retail.js:148-156`).
2. `requireInventoryRead`: either realm (`routes/retail-inventory.js:55-65`).
3. `lib/platform-admin.js:18-20`: a Production `admin` session is accepted everywhere in the
   Platform console as an implicit super-admin.

### 4.5 Enforcement status

| Surface | Gate | Live? |
|---|---|---|
| Production `/api/*` | `requirePermission` / `requireAdmin` / `requireDelete` | **yes, always** |
| Sales `/api/backend/*` (team, billing, notices) | `lib/require-cap.js` `requireCap` | **yes, unconditional** — no flag (`require-cap.js:34-46`) |
| Sales `/api/retail-admin/*` (the large API) | `lib/cap-routes.js` `requiredCapFor` inside `requireRetailAdmin` | **behind `tenants.rbac_enforce`, default 0** (`routes/backend-auth.js:253`; check at `routes/retail.js:121`) |
| Sales client | `can()` in `public/retail-admin/01-core.js` | cosmetic — hides UI only |

Two structural properties of the Sales gate, both documented as intentional
(`lib/cap-routes.js:9-18`): **all GET/HEAD/OPTIONS return `null` = allowed** (reads open),
and **any unmapped path returns `null` = allowed** (fail-open). Owner bypasses entirely.

### 4.6 Hardcoded permission checks — migration risks

Every string-literal role comparison in server code (`routes/`, `lib/`, `middleware/`,
`server.js`). Counts by literal: `'admin'` ×39, `'owner'` ×19, `'kitchen'` ×12,
`'store_stock'` ×4, `'super'` ×3, `'warehouse'` ×1, `'store_manager'` ×1, `'store'` ×1,
`'staff'` ×1.

The ones that will bite the consolidation:

| Location | Check | Why it is a risk |
|---|---|---|
| `middleware/auth.js:16, 22, 34` | `role !== 'admin'` / `=== 'admin'` | three separate admin bypasses; the string is the authority for the whole Production app |
| `server.js:292` | `role !== 'kitchen' && role !== 'store_stock'` | the Quick-Stock lockdown middleware — a whole-app route whitelist keyed on two `tenant_users.role` strings |
| `routes/retail-inventory.js:234, 292-293, 580-581, 596` | `req.backendUser.role === 'kitchen'` / `'store_stock'` | decides `add` vs `recount` mode, i.e. whether stock is relative or absolute |
| `routes/retail-inventory.js:303, 417, 588` | `req.user.role !== 'admin'` | mixes the Production role string into a Sales-realm endpoint |
| `routes/restock.js:263, 282, 287, 454, 520` | `role === 'admin'` / `'warehouse'` | origin-side resolution for the two-sided restock workflow |
| `routes/ai.js:3077, 3231, 3292`, `alerts.js:39`, `products.js:129`, `recipes.js:159`, `ingredients.js:260`, `markets.js:17-126`, `pos.js:23`, `feedback.js:32`, `admin.js:83`, `events.js:82, 145` | `role === 'admin'` | admin-only carve-outs scattered across 12 modules, none routed through a shared helper |
| `routes/billing-pay.js:32` | `u.role !== 'admin'` | uses the **Production** `admin` string to gate a **SaaS billing** route |
| `routes/backend-auth.js:684, 786, 831, 889`, `backend-team.js:122, 201-233, 301, 317` | `role === 'owner'` / `'admin'` | owner-singleton invariants (last-active-owner guards) written as string compares, not capability checks |
| `public/retail-admin/03-dashboard.js` (via `body.pos-*`) | CSS role string | money-card *presence* gates on a role string, while *Needs-you* sub-cards gate on caps — two mechanisms on one page (`docs/PROJECT-KNOWLEDGE.md:320-324`) |
| `routes/admin.js:17, 129` | custom roles read from `categories WHERE kind='role'` | roles are data in a table meant for categories; a consolidation that unifies categories will move the role list |

Also: `lib/capabilities.js` marks `quickstock:add` / `quickstock:recount` with features
`kitchenAdd` / `quickStock`, but neither key exists in `lib/features.js:15-51`. Because
`resolveCaps` drops a cap only on an explicit `=== false` (`capabilities.js:314`), the
undefined entitlement leaves both caps in place — behaviour is correct today, but the two
files disagree about what a feature key is.

---

## 5. Database topology

**One database.** A single `better-sqlite3` handle on `data/roots.db`, opened once in
`database.js:8` with `journal_mode = WAL` and `foreign_keys = ON` (lines 9-10). Both apps
`require('../database')` and get that same handle. `schema.sql` (29 `CREATE TABLE`s) is
executed at `database.js:14`, then ~105 further `CREATE TABLE IF NOT EXISTS` blocks and ~230
`addColumn` calls run in-file; more tables are created by modules at require time
(`routes/backend-auth.js:28`, `routes/billing.js:27`, `lib/platform-admin.js:26`,
`lib/tenant-creds.js:31`, `lib/billing-lifecycle.js:41`).

**One backend service.** One Express app, one process, port `process.env.PORT || 4000`
(`server.js:853`). All 41 route modules are mounted on it (`server.js:309-356`). Which
frontend you get is decided by **Host**, not by service (`server.js:606-641`):

| Host | Serves |
|---|---|
| `system.rootskitchenchina.com` (`server.js:486`) | Platform console `store-admin.html` |
| `store.rootskitchenchina.com` (`server.js:480`) | Sales console `retail-admin.html` |
| a host in `tenant_domains` | customer online store `shop.html` |
| `food.rootskitchenchina.com` (`server.js:179`) / anything else | Production app `app.html`, auth-gated |

`/retail-admin` is retired and 302s to the store host (`server.js:650-655`).

**One auth/session store.** `connect-sqlite3` over `data/sessions.db` in the same `data/`
directory (`server.js:159`), one cookie for all three realms. A separate, unused `sessions`
table also exists in `schema.sql:18-24` — the only code touching it is a best-effort
`DELETE FROM sessions WHERE user_id = ?` at `routes/admin.js:115`.

**Per-account fan-out (built, gated off).** `lib/tenant-db.js` can give each account its own
file `data/tenants/<id>.db`, cloning only data-plane objects and skipping the 16
`CONTROL_PLANE_TABLES` (lines 44-49). `getTenantDb(1) === mainDb`, so account 1 is a
zero-cost passthrough (line 143). The cut-over is behind `TENANT_DATA_ISOLATION === '1'`
(`lib/tenant-db.js:41`); when off, non-Roots operators are held out of the Sales console
entirely (`server.js:256-265`).

**Connection / config locations** (no values read or reproduced):
- DB path — `database.js:5-8` (`<repo>/data/roots.db`), account files `lib/tenant-db.js:40, 54`.
- Session store + secret — `server.js:146, 158-170`; `SESSION_SECRET` from env with a random
  fallback.
- Env vars referenced: `PORT` (`server.js:853`), `SESSION_SECRET` (`146`),
  `TENANT_DATA_ISOLATION` (`lib/tenant-db.js:41`), `TENANT_SECRET_KEY`
  (`lib/secret-box.js`), `ACTIVITY_LOG_RETENTION_DAYS` (`database.js:3638`),
  `QINGYUN_ACTIVE_STATUSES` (`lib/qingyun-browser.js:72`), `MODEL_API_*` / `ANTHROPIC_*`
  (`lib/model-gateway.js`).
- Secrets file — a gitignored `.env` (`.gitignore:2-3`); there is **no `.env.example`** in
  the repo despite `.gitignore:4` allowing one. Per-account credentials are encrypted rows in
  `tenant_secrets` (`lib/tenant-creds.js:31`), AES-256-GCM via `lib/secret-box.js`.
- Mini-app API base is a hardcoded constant, not config: `miniapp/utils/api.js:8`.
- Deploy target and host list — `.github/workflows/deploy.yml`; hosts in `server.js:179-186,
  480, 486`.

---

## 6. Risk notes for the consolidation

Ordered by how much damage each can do silently.

### R1 — `products.id` used as `store_products.id` (ID scheme conflict, active today)

Two live code paths take an id from the Production catalogue and hand it to Sales inventory:

- `routes/restock.js:237-247` — `restock_items.product_id` (FK → `products`, left there
  deliberately at `database.js:3785-3786`) → `inventory.adjustStock({ productId })`, which
  writes `retail_store_stock.product_id` (FK → `store_products`) and resolves the name from
  `store_products` (`lib/inventory.js:1177`).
- `routes/products.js:569-614` — validates the id against `products` (573) then calls the
  same `adjustStock` (597).

This is correct **only** for rows the fork seeded, because the seed preserved ids
(`database.js:3832`). Both tables are `INTEGER PRIMARY KEY AUTOINCREMENT` over the **same
integer space** with independent counters, so any product created on either side after the
fork has an id that means something different on the other side. A restock line for a
kitchen-only product will silently move stock for whatever `store_products` row happens to
hold that id — no FK error, no log, just wrong numbers. `public/restock.html` makes this
reachable from the UI: its picker is `/api/products` (`:1149`, `:2825`).

### R2 — `market_stock` is an orphaned inventory model

`market_stock` is written by exactly one endpoint, `routes/markets.js:203` (manual admin
adjustment). POS checkout does not decrement it (`routes/pos.js` touches only `markets`,
`products`, `sales_entries`, `users`), and no restock path increments it — contradicting the
comment at `database.js:445-448`. Any consolidation that treats `market_stock` as a real ledger will
import numbers that have drifted for as long as the table has existed. **UNVERIFIED:** how far
the live data has drifted — that needs the production DB, which is gitignored.

### R3 — Divergent "today" (timezone)

Sales normalises to UTC+8 in dozens of places: `HK_OFFSET_MS = 8 * 3600 * 1000`
(`routes/retail.js:1856`), `date(…, '+8 hours')` in the sales summary
(`routes/retail.js:11611-11614`), `gzToday()`/`gzNow()` (`routes/retail-purchasing.js:464-465`).

Production does **none** of it: a grep for `8 * 3600`, `Asia/Shanghai`, `+08:00` and
`'localtime'` across `products.js`, `sales.js`, `finance.js`, `pos.js`, `purchases.js`,
`waste.js`, `production.js`, `restock.js`, `markets.js` returns nothing. Those routes use
SQLite `CURRENT_TIMESTAMP` / `date('now')` (UTC) and JS `new Date().toISOString().slice(0,10)`
(`routes/production.js:11`). Guangzhou is UTC+8, so a row created between 00:00 and 08:00
local is dated to the previous day on the Production side and the correct day on the Sales
side. Consolidating the two revenue models without picking one convention will produce daily
totals that never reconcile.

Display formatting is Sales-only too: `public/td-datetime.js` is loaded by
`public/retail-admin.html` and by nothing else.

### R4 — Divergent delete semantics

| Entity | Production | Sales |
|---|---|---|
| Product | `UPDATE products SET is_active = 0` — **keeps the SKU** (`routes/products.js:660, 720`) | `UPDATE store_products SET is_active = 0, is_published = 0, sku = NULL` — **releases the SKU** (`routes/retail.js:18077`) |
| Recipe | hard `DELETE FROM recipes`, admin-only (`routes/recipes.js:159-167`) — plus a soft path at `137` | n/a |
| Ingredient | soft (`routes/ingredients.js:246`), with a hard-delete wipe path at `294-297` | n/a |
| Category | hard `DELETE FROM categories` (`routes/lookups.js:41`) | hard `DELETE FROM categories` (`routes/retail.js:18394`) — same shared table, two delete endpoints, neither checks the other side's references |
| Store / user | soft (`retail-inventory.js:169`, `backend-team.js:429`) | — |
| Kitchen user | hard `DELETE FROM users` (`routes/admin.js:116`) | — |

A unified product table must pick one SKU-on-delete rule; today the same action frees a code
on one side and holds it forever on the other. And the shared `categories` table has two
independent hard-delete endpoints, so deleting a category from the kitchen app can orphan
`store_products.category` strings (and vice versa) with no warning.

### R5 — Divergent enums

- **Channel:** `['dinein','meituan','eleme','miniapp','wechat','retail','gzgrocery']`
  (`routes/sales.js:10`) vs `wechat`/`web`/`meituan`/`gzgrocery`/`manual` on `retail_orders`.
  `miniapp`↔`wechat` and `retail`↔`web` are the same channels under different names, and
  `routes/sales.js:6-10` records that `'wechat'` was *already* renamed to `'miniapp'` once by
  a migration — a second rename is a data-migration, not a rename.
- **Product status:** `products.status` ∈ `Active|Inactive|Seasonal|Coming Soon`
  (`schema.sql:143`, TitleCase) coexists on the same row with `is_active` and `is_published`
  INTEGER flags. `store_products` inherits all three. Three overlapping notions of "live".
- **PO status:** `Requested|Ordered|Delivered|Confirmed|Cancelled` (TitleCase,
  `schema.sql:166`) — used by both sides of the shared table (`routes/purchases.js:104, 305`;
  `routes/retail-purchasing.js`).
- **Restock status:** `draft|sent|received|prepared|delivered` (lowercase,
  `schema.sql:289`, `routes/restock.js:135`) — same table family, opposite casing convention.
- **Order status:** `pending_payment|paid|preparing|dispatched|delivered|cancelled|refunded`
  plus the undocumented-in-schema `awaiting_restock` (`database.js:1174-1175` vs
  `routes/retail.js:22254-22267`) — the schema comment is already incomplete.
- **Refund status:** a 7th transient value `'paying'` exists in code only, no schema comment
  (`docs/PROJECT-KNOWLEDGE.md:329-331`).

### R6 — Account scoping is inconsistent

Exactly **three** data-plane tables carry a `tenant_id` column: `suppliers`,
`purchase_orders`, `invoices` (`database.js:306-307, 326`), all `DEFAULT 1`. Everything else
relies on database-level isolation via `tdb()` — which is currently a no-op because
`TENANT_DATA_ISOLATION` is off.

Two concrete consequences in current code:

1. **Production ignores `tenant_id` on `suppliers`.** `routes/retail-purchasing.js` filters
   (`:145, 228, 257`), `routes/lookups.js:121-228` does not. So the kitchen app's supplier
   list shows every account's suppliers.
2. **`suppliers.name` is globally UNIQUE** (`schema.sql:382`). Two accounts cannot both have a
   supplier called "Taobao". The duplicate check at `routes/retail-purchasing.js:208` also
   omits the account filter, so a second account gets "name already exists" for a supplier they
   cannot see.

### R7 — FK repoint is incomplete for pre-fork account databases

The mainDb migration repointed **8** store-owned tables from `products` to `store_products`
(`database.js:3805-3809`: `retail_order_items`, `retail_product_options`, `retail_reviews`,
`retail_store_stock`, `retail_stock_reservations`, `retail_stock_ledger`,
`retail_product_substitutes`, `retail_customer_favorites`).

`lib/tenant-db.js` repoints only **3** tables, and only Meituan ones
(`lib/tenant-db.js:129-136`: `meituan_product_map`, `meituan_bundle_components`,
`meituan_sync_queue`). `initTenantSchema` "only creates MISSING tables, never rebuilds an
existing one's constraints" (its own comment, `lib/tenant-db.js:130-131`), and
`reconcileTenantColumns` only adds columns. So an account DB created **before** the fork still
has `retail_store_stock.product_id → products(id)`.

Fresh account DBs are fine (they clone the already-repointed `sqlite_master` SQL). **UNVERIFIED:**
whether any pre-fork account DB exists on the box — `data/tenants/` is gitignored.

Related, and confusing for anyone reading the source: the `CREATE TABLE` text in
`database.js:2583-2640` still says `REFERENCES products(id)` for `retail_store_stock`,
`retail_stock_reservations` and `retail_stock_ledger`. The live constraint is
`store_products(id)`, applied later by the migration. Reading the schema file gives the wrong
answer.

### R8 — Audit trail loses the Sales actor

`activity_log.user_id` has an FK to `users(id)` (`schema.sql:445`). `logActivity` therefore
**stores NULL** for any Sales operator, keeping only the username string
(`middleware/auth.js:41-47`). A unified user table fixes this, but the historical rows are
already unattributable by id.

`retail_stock_ledger.actor_user_id` documents the same collision and solves it the other way —
by dropping the FK entirely: "the actor can be a kitchen `users(id)` OR a Mini App Backend
operator's `tenant_users(id)` — two id spaces" (`database.js:3918-3925`, migration
`drop_ledger_actor_fk_v1`). `retail_vouchers.created_by` hit the same trap
(`reference` in the same comment). **Any consolidated user table must reconcile two id spaces that
have already been written into audit columns as bare integers.**

### R9 — Capability enforcement is off, so the consolidation cannot rely on it

`tenants.rbac_enforce` is `NOT NULL DEFAULT 0` (`routes/backend-auth.js:253`). With it off,
`/api/retail-admin/*` performs **no** server-side capability check
(`routes/retail.js:121-137`). Even switched on, the design leaves all reads open and all
unmapped routes allowed (`lib/cap-routes.js:9-18`). `PERMISSIONS_PLAN.md §11` is cited in
`docs/DEEP-DIVE.md:65-66` as recording three blockers owed before the flag can flip.
Meanwhile a Production user with `permissions.retail` gets **every** capability
(`routes/retail.js:150-155`).

If Production's 18 boolean flags are mapped onto capability keys, the mapping will run
against a gate that is currently dark for the biggest API — so the migration cannot be
validated by observing 403s.

### R10 — Currency and money representation

Money on `retail_orders` is REAL with a two-decimal comment (`database.js:1183`); billing uses
integer `amount_cents` (`lib/billing-lifecycle.js:69-72`). Sales has a configurable display
currency (`normalizeCurrency`, `routes/retail.js:279`, `686-691`) and a separate accounting
currency, but the payment paths hardcode `currency: 'CNY'` (`routes/retail.js:3555, 3611,
3647, 3694`) and one response hardcodes the symbol `'¥'` (`routes/retail.js:8329`). Production
has **no** currency abstraction at all — the symbol is baked into markup: 209 literal `¥` in
`public/app.html`, 13 in `public/pos.html`, against 61 in `public/retail-admin.html`.

### R11 — Two live product-catalogue frontends, one dormant lock

`tenants.product_catalog_mode` is the only mechanism designed to stop two apps editing one
catalogue, and for the live account it is set to `'self'`, which disables it
(`routes/backend-auth.js:296`). If a merge re-unifies `products` and `store_products` without
re-enabling something like the `UPSTREAM_LOCKED_FIELDS` guard
(`routes/retail.js:190-193, 17553`), both frontends become concurrent writers of the same
rows with no field-level ownership and no optimistic-concurrency column (neither table has a
version or `updated_by`).

### R12 — Smaller items worth a line each

- `docs/tacet-sales-addendum.md` and the `tenant_users.role` comment
  (`routes/backend-auth.js:49`) are both stale against current code — treat docs as leads,
  verify in code.
- `public/app.html.bak` is **tracked in git** (`git ls-files public/`) and contains a full
  older copy of the Production frontend, including its own `/api/sales/summary` calls
  (`:2973`, `:16317`). It will show up in any grep-driven migration.
- Production and Sales each have their own SSE channel and their own push-subscription table
  (§2); a consolidated notification layer has to reconcile permission-targeted broadcast
  (`routes/events.js:69-90`) with signature-poll nudging (`routes/retail.js:13115-13160`).
- `routes/retail.js` is ~1.5 MB in one file; `public/app.html` is 28,218 lines with inline
  script. Mechanical refactors across the boundary will be hard to review.
- `schema.sql:3` claims "PostgreSQL / SQLite compatible", but the runtime uses SQLite-only
  features throughout (`PRAGMA table_info`, `legacy_alter_table`, `INSERT OR IGNORE`,
  `date(…,'+8 hours')`). Treat the header as aspirational.

---

## Verification notes

- Read in full: `schema.sql`, `middleware/auth.js`, `lib/tenant-db.js`, `lib/category-tree.js`,
  `lib/operator-caps.js`, `lib/require-cap.js`, `lib/features.js`, `lib/capabilities.js`,
  `README.md`, `docs/DEEP-DIVE.md`, `docs/PROJECT-KNOWLEDGE.md`, `PARITY_AUDIT.md`.
- Read in part: `database.js` (migration blocks around lines 1-175, 296-340, 440-500,
  605-650, 1074-1216, 2560-2660, 3630-3970), `server.js` (146-360, 480-800),
  `routes/retail.js` (60-200, 11604-11660, 13110-13215, 18068-18100, 22254-22290),
  `routes/products.js` (520-620, 655-725), `routes/restock.js` (130-290),
  `routes/retail-inventory.js` (1-80, 560-632), `routes/backend-auth.js` (25-160, 255-310),
  `routes/auth.js` (1-60), `routes/admin.js` (1-70), `routes/sales.js` (1-60, 232-280),
  `routes/events.js`, `lib/platform-admin.js` (1-60), `lib/cap-routes.js` (1-75),
  `scripts/import_miniapp.js` + `import_full.js` (headers).
- Structural claims (which module touches which table, which frontend calls which API,
  role/literal counts, column diffs) come from repo-wide `grep`/`comm` over
  `routes/ lib/ middleware/ public/ scripts/ miniapp/ server.js database.js schema.sql`.
- Not verifiable from the repo, and therefore not asserted anywhere above: live row counts,
  actual id-collision incidence, whether any pre-fork account DB exists, and the contents of
  `.env` / `data/*.db` (all gitignored).
