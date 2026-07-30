# Tacet locations — everything that breaks if `markets` and `retail_stores` become one list

**2026-07-30 · Read-only survey of the two location tables, the free-text location fields, the user bindings, the channel attachments and every screen that touches a location. Written before Locations is designed as a shared Tacet core module. Every claim is cited to a file and line. Where the code does not settle a question the entry says UNVERIFIED and why. No row data was read. No file was changed except this one. `public/app.html.bak` was ignored throughout.**

Terms used below, one line each:

- **Location** — any place the business operates from: a market stall, a shop, a warehouse, a kitchen.
- **Foreign key (FK)** — a column holding another table's id, declared to the database so it can refuse a value that points at nothing.
- **Free text** — a location stored as a typed name or code string rather than as an id. Nothing checks it.
- **Soft delete** — marking a row inactive (`is_active = 0`) instead of removing it. The row and everything pointing at it survive.
- **Control plane / data plane** — control-plane tables live once in the shared database for all businesses (`users`, `tenant_users`); data-plane tables are copied per business (`lib/tenant-db.js:44-49`).
- **Channel** — a place customers buy from: the mini app, the web shop, Meituan, Eleme, the gzgrocery/Guanyi feed, the market POS.
- **Store code** — `retail_stores.code`, a short operator-typed slug like `tianhe`. It is a second name for a location, used as the key in roughly twenty tables.

---

## Summary — the biggest obstacles to merging

**The two tables are not two halves of one idea. They are two complete, independently-evolved location models, and the newer one has quietly taken over everything that matters.** `retail_stores` carries the real stock, the real orders, every channel integration and every per-location setting. `markets` carries a stall list, a manual stock table nothing else writes to, and a notification-routing role. Merging is less "join two lists" than "absorb an abandoned model into the live one without losing its two live behaviours".

The obstacles, most damaging first:

1. **The id spaces overlap by construction and nothing records which table an id came from.** Both are `INTEGER PRIMARY KEY AUTOINCREMENT` starting at 1 (`database.js:613`, `database.js:2566`). A user row carries `market_id` and `retail_store_id` as two separate plain integers (`database.js:637`, `database.js:640`) with no FK on either. If the tables merge and ids are reassigned, every one of those integers silently points at a different place — and because there is no FK, nothing errors. This repo has already been bitten by exactly this failure with products: `routes/restock.js:210-217` describes "two separate AUTOINCREMENT counters over ONE integer space… the units simply land on the wrong product's shelf". §5.
2. **A location's real identity today is its `code` string, not its id, and that code is unvalidated operator-typed text.** `routes/retail-inventory.js:83-95` accepts any non-empty string. Around twenty tables key off `store_code` with **no FK** (§11 of the free-text findings, listed in §2 below), and `code` is not in the update allowlist (`routes/retail-inventory.js:127`) so it is immutable after creation. A merged table must decide whether `code` survives as the join key or every one of those tables is migrated. §2, §5, §6.
3. **`markets.kind` is almost entirely decorative.** It has four values, but no server behaviour branches on it at all — the only consumers are cosmetic groupings in one admin screen (`public/app.html:15800-15811`, `:15905-15921`) and a `?kind=` API filter no frontend ever calls (`routes/markets.js:18-21`; grep for callers returns nothing). The target model's PHYSICAL/TEMPORARY/KITCHEN distinction therefore has no existing behaviour to inherit — it must be built, not migrated. §1.
4. **`market_stock` is an orphan.** Its schema comment and its route comment both say it is auto-incremented when a restock order is delivered (`database.js:444-446`, `routes/markets.js:147-148`, naming a function `_applyDeliveryToStock`). **That function does not exist.** The only writer left is the manual admin adjust endpoint (`routes/markets.js:177-219`). POS sales do not decrement it either. So one of the two tables being merged has a stock model that no automated process has touched in a long time. §4, §9.
5. **The one binding that a merge would most obviously unify is enforced in only one direction, and only when a flag nobody has turned on is on.** Backend operator store-scoping (`tenant_user_stores`) is resolved on every request (`lib/operator-caps.js:38-51`) but enforced only when `tenants.rbac_enforce = 1` — which defaults to 0 (`routes/backend-auth.js:253`) — and even then only on URLs matching `^/api/retail-admin/stores/(\d+)` (`lib/cap-routes.js:147-150`). Every other route family is unscoped. `lib/require-cap.js:18-19` computes the scope and then throws it away. §3.
6. **Free-text location routing can silently move real stock to the wrong shop.** `restock_orders.store_name` is matched against `markets` for notifications (`routes/restock.js:58-63`) and against `retail_stores` for the actual stock movement (`routes/restock.js:188-194`) — two different tables, two different column sets, from one string. When it fails to match, the stock transfer falls through to "the only other active store" (`routes/restock.js:203-206`) with no warning. §2.
7. **Opening hours and time zone are half-wired, and one daemon ignores them entirely.** The columns exist and one thing reads them properly (pickup validation, `routes/retail.js:8664-8667`), but `lib/inventory.js:86-89` omits `timezone` from the store list every screen loads, `scripts/meituan-daemon.js` reads hours once at boot, and `scripts/shangou-daemon.js:68-70` hardcodes them with no database override at all. No date calculation anywhere uses a per-location time zone. §8.
8. **There is no such thing as closing a location safely today.** Both deactivations are one `UPDATE … is_active = 0` with no stock check, no confirmation of what is left on the shelf, and no cleanup (`routes/markets.js:135`, `routes/retail-inventory.js:169`). The target model's "closing requires stock to be moved out and confirmed" has nothing to build on. §9.
9. **Five separate screens create or edit a `retail_stores` row, each with a different subset of fields.** §7. Any merged editor has to replace all five or they will drift again.
10. **A third location table exists that nobody mentioned.** `meituan_stores` (`database.js:842-848`) is the finance-import dimension, with its own id space and `meituan_orders.store_id` pointing at it — a column name identical to `retail_store_stock.store_id`, meaning something completely different. Nothing joins it to `retail_stores`. §5.

---

## 1. The two tables

### 1.1 `markets`

Created at `database.js:612-620`, with four columns added later. It is only ever reached through the shared global connection (`routes/markets.js:8` uses `require('../database')`, never `tdb()`), so it always lives in the Roots database — see §5.4.

| Column | Meaning in current code | Written by |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` (`database.js:613`) | database |
| `name` | The primary name, English-ish. `NOT NULL`. Case-insensitive uniqueness is enforced **in the route, not the schema** (`routes/markets.js:54`, `:101`) | `routes/markets.js:66`, `:113` |
| `name_cn` | Chinese name, optional | `routes/markets.js:66`, `:113` |
| `location` | One free-text address-or-notes blob. Trimmed and stored; **never parsed, geocoded or matched** (`routes/markets.js:66`, read back only at `:22`) | `routes/markets.js:58`, `:66`, `:113` |
| `is_active` | Soft-delete flag. 0 hides the row from non-admin pickers (`routes/markets.js:17`) | `routes/markets.js:57`, `:116`, `:135` |
| `created_at` / `updated_at` | `updated_at` has **no default** — it is NULL until the first edit | database / routes |
| `kind` | `'market'` \| `'retail'` \| `'kitchen'` \| `'warehouse'`, default `'market'` (`database.js:628`). See §1.3 | `routes/markets.js:66`, `:115` |
| `lat` / `lng` | GPS captured by the POS "📍 Use my location" button (`database.js:629-631`). Validated for range, out-of-range values silently dropped rather than rejected (`routes/markets.js:46-50`) | `routes/markets.js:66`, `:110` |
| `daily_target` | Daily revenue target in yuan, drives the POS header progress chip. 0 means no target (`database.js:634-635`, read at `routes/pos.js:156-157`) | `routes/markets.js:66`, `:115` |

Everything is written by `routes/markets.js` alone. Create and edit are open to **any user holding the `pos` permission**, not just admins (`routes/markets.js:36-38`, `:93-95`) — a vendor arriving at a new stall provisions it themselves.

### 1.2 `retail_stores`

Created at `database.js:2565-2581`, with six columns added later (`database.js:2673-2688`). Reached through the per-business connection `tdb()` (`routes/retail-inventory.js:85`, `:142`, `:169`), so it is copied per business — see §5.4.

| Column | Meaning in current code | Written by |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` (`database.js:2566`) | database |
| `code` | `TEXT UNIQUE NOT NULL` — the location's real working identity. Operator-typed, only checked for non-emptiness and uniqueness (`routes/retail-inventory.js:84-86`). **Not in the update allowlist (`routes/retail-inventory.js:127`), so it can never be changed after creation.** Used as the key in ~20 integration tables | `routes/retail-inventory.js:94`; seeds `database.js:3220`, `:3263` |
| `name_en` / `name_cn` | Display names. **Both nullable, neither unique** | `routes/retail-inventory.js:95`, `:127` |
| `address` / `city` / `district` | Structured address, fed to the geocoder (`routes/retail-inventory.js:31-35`) | `routes/retail-inventory.js:96`, `:127` |
| `lat` / `lng` | Coordinates. Geocoded in the background from the address unless supplied (`routes/retail-inventory.js:27-41`, `:109`, `:147`). Drives nearest-store routing (`lib/inventory.js:294-301`) | `routes/retail-inventory.js:37`, `:97-98`, `:127`, `:466` |
| `phone` | Store phone | `routes/retail-inventory.js:99`, `:127` |
| `meituan_account_id` | Labelled "Meituan merchant id for future sync" (`database.js:2576`). **Dead** — written and displayed, never read by any sync, routing or auth logic. See §6.1 | `routes/retail-inventory.js:100`, `:127` |
| `is_active` | Soft-delete flag. 0 removes the store from routing, pickup and the grid (`lib/inventory.js:84-85`) | `routes/retail-inventory.js:101`, `:127`, `:169` |
| `sort_order` | Routing priority, lower preferred (`database.js:2578`, applied at `lib/inventory.js:88`) | `routes/retail-inventory.js:103`, `:127` |
| `created_at` / `updated_at` | Both default to `CURRENT_TIMESTAMP` (unlike `markets`) | database / routes |
| `pickup_enabled` | Whether the store is offered as a collection point at checkout. Explicitly independent of `is_active` (`database.js:2669-2672`) | `routes/retail-inventory.js:102`, `:127` |
| `open_time` / `close_time` | `'HH:MM'` local, both set or both NULL = always open (`database.js:2675-2679`) | `routes/retail-inventory.js:104`, `:127` |
| `timezone` | IANA zone the hours are in (`database.js:2680-2683`). See §8 | `routes/retail-inventory.js:105`, `:127` |
| `low_stock_threshold` | Per-store low-stock line; NULL falls back to the business-wide default (`database.js:2684-2688`) | `routes/retail-inventory.js:106`, `:127` |

Create and edit require `requireRetailAdmin` (`routes/retail-inventory.js:82`, `:123`, `:166`) — a mini-app backend operator or a kitchen user with the `retail` permission (`routes/retail-inventory.js:44-49`).

### 1.3 `markets.kind` — values, writers, and what actually branches on it

**Values:** `'market'`, `'retail'`, `'kitchen'`, `'warehouse'`. Whitelisted identically on create (`routes/markets.js:44-45`) and on edit (`routes/markets.js:106-108`); anything else silently falls back to `'market'` on create or to the existing value on edit. Default `'market'` (`database.js:628`).

**Where set:** exactly one place — the kind dropdown in the kitchen app's market form (`public/app.html:17989-17995`), submitted at `public/app.html:18017`. The POS create form (`public/pos.html:1781-1793`) does not send `kind` at all, so every market a vendor creates from the POS is `'market'`.

**What branches on it:**

| Site | Behaviour |
|---|---|
| `public/app.html:15800-15802` | Groups the per-user location dropdown into four `optgroup`s by kind. Cosmetic. |
| `public/app.html:15905-15910` | Renders a coloured kind chip in the markets table. Cosmetic. |
| `public/app.html:15921` | **The only functional branch anywhere:** the per-market Stock button is rendered only when `kind === 'retail'`. |
| `routes/markets.js:18-21` | `GET /api/markets?kind=` filters the list. **No frontend calls it** — a repo-wide grep for a caller passing `kind` as a query parameter returns nothing. |
| `routes/markets.js:27` | `ORDER BY kind, name`. Cosmetic. |
| `routes/events.js:112` | Selected and echoed in the admin diagnostic response. Not branched on. |

The form's own help text claims kind "drives notification routing · 决定通知路由" (`public/app.html:17988`). **It does not.** The restock notification path resolves a location by name and then reads `users.market_id` (`routes/restock.js:58-65`); `kind` never appears in that query. Note also that the `kind` in `routes/restock.js:39`, `:56`, `:117-125` is an *event* kind (`sent`/`prepared`/`delivered`) and has nothing to do with `markets.kind`.

**Consequence for the target model:** PHYSICAL vs TEMPORARY, and the KITCHEN flag, are new concepts. `kind` supplies a rough starting classification for existing rows but carries no behaviour to preserve — except the one Stock button.

### 1.4 Where the two disagree in meaning, not just in name

| Idea | `markets` | `retail_stores` | The disagreement |
|---|---|---|---|
| Name | `name` `NOT NULL`, uniqueness enforced in the route (`routes/markets.js:54`) | `name_en` nullable, no uniqueness; `code` is the unique key instead | One table treats the display name as identity; the other treats it as a label. Merging must pick one, and the losing side's rows may violate the winner's rule. |
| Address | `location` — one free-text blob, never parsed | `address` + `city` + `district`, geocoded | Not a rename. A `markets.location` value cannot be split into the three columns without a human reading it. |
| Coordinates | Captured by a person standing at the stall pressing a button (`database.js:629-631`) | Derived from the typed address by a geocoder (`routes/retail-inventory.js:27-41`) | Same columns, opposite provenance and opposite trust level. |
| Deactivation | Also clears `users.market_id` for everyone assigned (`routes/markets.js:136`) | Leaves `users.retail_store_id` and `tenant_users.retail_store_id` untouched | Two different answers to "what happens to the people". §9. |
| `updated_at` | No default; NULL until first edit | `DEFAULT CURRENT_TIMESTAMP` | A merged column cannot mean both. |
| Who may create | Anyone with the `pos` permission (`routes/markets.js:36-38`) | `requireRetailAdmin` (`routes/retail-inventory.js:82`) | A merged create endpoint inherits the looser gate unless deliberately tightened. |
| Stock | `market_stock` (`database.js:449-457`), `qty` as `REAL`, manual adjustment only | `retail_store_stock` (`database.js:2583-2595`), `physical_qty` as `INTEGER`, plus safety buffer and per-channel quotas | Two stock models with different types and different richness. §4. |

**Columns with no counterpart at all.** On `markets` only: `kind`, `daily_target`. On `retail_stores` only: `code`, `phone`, `sort_order`, `pickup_enabled`, `open_time`, `close_time`, `timezone`, `low_stock_threshold`, `meituan_account_id`.

---

## 2. Free-text locations

Every place a location is stored or passed as a string rather than a reference.

### 2.1 `purchase_orders.warehouse` — write-only decoration

**Schema:** `schema.sql:167`, plain `TEXT`, no FK, no index, no check.

**Written by:** `routes/purchases.js:210-211` (create) and `:252-253` (edit), taking `req.body.warehouse` unvalidated; `routes/kitchen.js:140`, which hardcodes the string literal `'Main Warehouse'` on every kitchen-originated purchase order; and three clone paths that copy it verbatim (`routes/purchases.js:475`, `:521`, `:569`).

The client value comes from a **hidden input** (`public/app.html:14843`), which the comment at `:14839-14842` explains was left behind only to carry a legacy value through an edit. On a new purchase order it is always empty.

**Read back by:** three display sites only — `public/app.html:13895` (list cell), `:14020` (detail drawer), `:14843` (round-trip into the hidden input). Nothing joins, matches or branches on it.

**How it fails when the text does not match:** it cannot fail, because it is never matched. `'Main Warehouse'` corresponds to no row in either location table (the seeded store names are `Roots Kitchen — Tianhe` / `— Yuexiu`, `database.js:3220`, `:3263`). The real consequence is an absence: **which physical location a purchase is destined for is simply not captured.** The separate `purchase_orders.store_id` column (`database.js:44`) does capture it, but only for retail-scope purchase orders (`database.js:40-42`).

### 2.2 `restock_orders.store_name` / `store_cn` — one string, matched against two different tables

**Schema:** `schema.sql:290-291`, both `TEXT`, no FK.

**Written by:** `routes/restock.js:577` (create) and `:628` (edit), straight from the request body with no validation against either location table.

**But no user interface populates them today.** The warehouse-side sender hard-returns `store_name: null` (`public/restock.html:3168`), with the comment at `:3165-3167` stating "Single-store world today — no picker… When a second retail store joins, reintroduce a chooser here". The desktop restock creator never sends the field at all (`public/app.html:19111-19118`). So these columns are non-null only on legacy rows or direct API calls.

**Read back — four consumers, three different meanings:**

1. **Notification audience** — `routes/restock.js:58-63` matches it against **`markets`** on `LOWER(TRIM(name))` or exact `TRIM(name_cn)`, then narrows the live-event audience to users whose `market_id` equals that row (`routes/restock.js:65`).
2. **Stock movement** — `routes/restock.js:188-194` matches the *same string* against **`retail_stores`** on `LOWER(TRIM(name_en))`, exact `TRIM(name_cn)`, or `LOWER(TRIM(code))`. This is the fuzzy resolution flagged in the brief. Note it accepts `code`, which the notification query does not; and it matches `name_en` where the other matches `name`.
3. **Push notification text** — `routes/restock.js:94`, interpolated into the title and body at `:119`, `:123`, `:127`. Display only.
4. **Frontend display** — `public/restock.html:1885`, `:2079`, `:2133`, `:2228`, `:2241`, `:2346`, `:2351`, `:2527`; `public/app.html:3590`. All fall back to a generic "Store · 门店".

**How it fails when the text does not match:**

- *Notifications:* silently falls through to a permission-wide broadcast (`routes/restock.js:82`). Everyone with the permission is notified instead of the assigned people. No log, no warning. The same happens when the location matches but has no users assigned (`routes/restock.js:66-71`).
- *Stock movement:* the resolver falls through a ladder — the creator's own `users.retail_store_id` (`routes/restock.js:198-201`), then **"if there is exactly one other active store, use that"** (`routes/restock.js:203-206`), then null. With two stores configured, a stale or mistyped name therefore **silently moves real stock to the wrong shop** — a genuine decrement at one location and increment at another, ledgered through `inventory.adjustStock` (`routes/restock.js:316-326`), with channel availability resynced on both sides. No warning is emitted on that path.
- *Unresolvable:* `_applyRestockTransfer` returns a plain-English error (`routes/restock.js:276-280`) that **is** surfaced to the person who pressed the button (`routes/restock.js:686-688`). But the status change was already committed at `routes/restock.js:663`, before the transfer ran at `:674`, and status cannot move backwards (`:659`). So the order reads as prepared while nothing moved, and the only remaining retry is the later `delivered` transition.

There is also an empty-string hazard: when `store_name` is null but `store_cn` is set, parameters 1 and 3 of the `retail_stores` query are `''` (`routes/restock.js:194`), so `LOWER(TRIM(name_en)) = ''` would match any store whose English name is blank — and `name_en` is nullable with no uniqueness.

### 2.3 The warehouse side of a restock is a heuristic, not a stored reference

`routes/restock.js:161-181` resolves which location goods leave *from*:

1. A settings row `restock.warehouseStoreId` (`routes/restock.js:164`). **No code anywhere writes this key** — a repo-wide grep finds only this read. Unreachable in practice unless someone edits the database by hand.
2. The first user with `role = 'warehouse'` and a non-null `retail_store_id`, ordered by id (`routes/restock.js:169-173`).
3. **Whichever active store currently holds the most total stock** (`routes/restock.js:175-180`).

Step 3 is data-dependent: the identity of "the warehouse" can change between two calls with no configuration change at all, purely because stock moved.

### 2.4 Hardcoded opening-hours maps keyed by location name

Three daemons carry a location-name → hours constant:

- `scripts/meituan-daemon.js:96-99` — `yuexiu` and `tianhe`. Overridden from `retail_stores.open_time`/`close_time` by `loadStoreHours` (`:111-117`), but **only once at boot** (called from `getStoreConfigs`, `:380`). Hours edited in the admin do not take effect until the daemon restarts. An unknown code returns always-open (`:137-138`).
- `scripts/shangou-daemon.js:68-70` — `yuexiu` only, and **no database override whatsoever**. `tianhe` and every future location are treated as open around the clock (`:81-82`).
- `scripts/qingyun-daemon.js:74-77` — a legacy fallback, correctly consulted only after the shared `lib/store-hours` module (`:84`), which re-reads the database every ten minutes (`lib/store-hours.js:19`, `:33`).

`lib/store-hours.js` is the correct shared implementation, keyed on `retail_stores.code` (`:36`). Its own header admits the other two daemons still carry private copies (`lib/store-hours.js:10-11`).

### 2.5 Hardcoded `'tianhe'` / `'yuexiu'` literals standing in for a location

- **gzgrocery is hard-bound to `'tianhe'`:** `routes/meituan-admin.js:606` filters the store list to that code, `:644` pins it, `:648` and `:686` filter the channel grid, `:660` rejects any other code with a 400. `scripts/gzgrocery-order-daemon.js:51` defaults to it, and `:399` uses the literal `'tianhe'` in SQL while ignoring its own `STORE_CODE` constant — so a business that sets `GZGROCERY_STORE_CODE` to anything else reads its open/closed state from the wrong row.
- **Guanyi:** `routes/guanyi-admin.js:18`, `scripts/guanyi-daemon.js:67`, `scripts/guanyi-login.js:17`, `scripts/diagnose_gzgrocery_stock.js:29`, `scripts/qingyun-chrome.js:45` all default to `'tianhe'`. A wrong or absent code yields an **empty listing array with `success: true`** (`routes/guanyi-admin.js:222`) — indistinguishable from "Guanyi has no products". `guanyi_pickup_log` bakes a location name into a column name: `tianhe_qty` (`scripts/guanyi-daemon.js:49`).
- **Proxy channels are named after locations:** `lib/proxy-manager.js:147-148` defines `CHANNELS = ['tianhe','yuexiu']` and branches on the name at `:57`. `scripts/meituan-daemon.js:168` passes the literal `'tianhe'` rather than the loop's own store code.
- **Credential keys are named after locations:** `lib/tenant-creds.js:97-100`, `:227-228` expose `MEITUAN_TIANHE_*` / `MEITUAN_YUEXIU_*`, and the "is Meituan configured?" check at `routes/integrations-admin.js:50` only ever inspects those two names. A third location's credentials would report the integration as unconfigured.
- **Analytics buckets branch on the code:** `routes/retail.js:12712-12714`. A third location's Meituan rows fall into the generic `'meituan'` bucket at `:12711` — verified, there is a fallthrough, so nothing is lost, but the per-location split silently stops at two.
- **A regex-on-name fallback picks the out-of-city shipping store:** `routes/retail.js:21481-21484` runs `/天河|tianhe/i` across the concatenated `name_cn`, `name_en` and `code`. Any location whose English name happens to contain "tianhe" wins.

### 2.6 The POS market id lives inside a free-text notes string

`routes/pos.js:63` builds the tag `[markets:txn:N:M]`, where `M` is the market id, and prepends it to `sales_entries.notes`. It is read back by regex at `routes/pos.js:127`, `:236`, and by `LIKE` at `:208` and `:170-176`.

**Failure:** an untagged row parses to `market_id: null` and buckets to "Unassigned · 未分配" (`routes/pos.js:254-255`). Anyone editing the notes text destroys the tag and silently detaches the sale from its stall. If the market is later soft-deleted the historic tags keep the now-dangling id — acknowledged in the code (`routes/markets.js:121-124`).

### 2.7 `miniapp_orders.pickup_store`

`database.js:796`, plain `TEXT`. Written by the importer straight from the export JSON (`scripts/import_miniapp.js:154`, `:166`). Read at `routes/sales.js:579` **only as an emptiness test** — non-empty means "Pickup", empty means "Delivery". The string content is never compared to anything, so a whitespace-only value counts as a pickup, a genuinely-pickup order with a blank column counts as a delivery, and **which** location a historic pickup happened at is unrecoverable.

### 2.8 `retail_orders.address_json` — a snapshot, not a reference

`routes/retail.js:9421-9428` embeds the pickup store's id, code, names, phone and address into the order's address JSON. The source is a properly validated lookup (`routes/retail.js:8654-8661`) and the order also carries a real `store_id` column, so this is a receipt snapshot rather than a routing key. Read back for display only (`routes/retail.js:4663-4669`), inside a try/catch that swallows malformed JSON. Renaming a location leaves old orders showing the old name — arguably correct. Listed for completeness; low severity.

### 2.9 `store_code` as an unvalidated key across the integration tables

Roughly twenty tables key off `retail_stores.code` as text. Two also carry a real FK (`meituan_product_map` at `database.js:4026`, `meituan_sync_queue` at `:4045`); the rest carry **only the string** — including `channel_status` (`database.js:4185`, composite primary key), `store_business_status` (`:4149`, `store_code` as the primary key), `delivery_jobs` (`:4207`), `guanyi_listings` (`:4601`, unique on `store_code` + sku), and the Eleme, Qingyun and Guanyi queue and log tables.

**A concrete unvalidated write:** `routes/meituan-admin.js:656-663` accepts `storeCode` from the request body, checks only that it is truthy and handles the gzgrocery special case, then writes it unconditionally into `channel_status`. A mistyped code creates an **orphan row that no read path will ever show** (`csStores` at `:605-607` iterates only real stores), so the operator sees the toggle succeed and nothing change. The sibling endpoint twelve lines below **does** validate (`routes/meituan-admin.js:684-686`, `SELECT code FROM retail_stores WHERE code=? AND is_active=1` → 404). The inconsistency is the finding.

---

## 3. Who is tied to a location

### 3.1 `users.market_id` — kitchen realm

**Schema:** `database.js:637`, plain `INTEGER`, **no FK**.

**Set by:** the self-service POS switch `PUT /api/pos/my-market` (`routes/markets.js:85`), open to admin or anyone with `pos`, changing only the caller's own row; the admin assignment `PUT /api/admin/users/:userId/market` (`routes/markets.js:248`); and cleared in bulk when a market is deactivated (`routes/markets.js:136`).

**What it restricts:** almost nothing.

- **Sales tagging** (`routes/pos.js:61-63`) — the checkout re-reads it and bakes it into the notes tag. This *labels* sales; it restricts nothing.
- **POS daily-target chip** (`routes/pos.js:155-158`) — display only.
- **Restock notification audience** (`routes/restock.js:65`) — the one genuine restriction. For warehouse→store `sent`/`delivered` events only, and it fails open to a permission-wide broadcast (`routes/restock.js:82`).
- **Admin diagnostic** (`routes/events.js:124`) — read-only introspection of who would receive an event.
- **Client hydration** — `routes/auth.js:120-121`, `routes/admin.js:48`.

**Stored but not enforced:** `GET /api/pos/today` returns every markets-channel sale for the day across all locations with no filter (`routes/pos.js:111-118`); the per-market split happens later in aggregation (`routes/pos.js:253-264`). `GET /api/pos/top-products` reads `market_id` (`routes/pos.js:300-301`) but none of its three queries filter on it (`:322-325`, `:330-333`, `:341-348`) — it is only echoed back at `:351`. The per-market stock endpoints gate on `requireAdmin` (`routes/markets.js:149`, `:177`), not on the caller's own assignment, and market create/edit/delete are open to any `pos` holder for **any** market.

### 3.2 `users.retail_store_id` — kitchen realm

**Schema:** `database.js:640`, plain `INTEGER`, **no FK**.

**Set by:** one endpoint, `PUT /api/admin/users/:userId/retail-store` (`routes/retail-inventory.js:416-427`), admin-only, validated against a real store at `:423`.

**What it restricts — this one does gate writes:**

- **Per-store stock edits.** `routes/retail-inventory.js:303-308`: a non-admin kitchen caller whose `retail_store_id` differs from the URL's store gets `403 store_not_assigned`.
- **Quick Stock scoping.** `routes/retail-inventory.js:607-612`: a plain store staffer is offered exactly their one location; admins and `retail` holders get all.
- **Read admission — note this *widens*, not narrows.** `requireInventoryRead` (`routes/retail-inventory.js:55-65`) admits any kitchen user who has *any* `retail_store_id` set, even without the `retail` permission (`:61-62`) — and once admitted they can read the whole cross-store grid (`/api/retail-admin/inventory/grid`, `:181`, which applies no scope).
- **Restock routing (not a permission).** Used to pick the warehouse (`routes/restock.js:169-173`) and the destination (`routes/restock.js:198-201`). Heuristic, not access control.

### 3.3 `tenant_users.retail_store_id` and `tenant_user_stores` — backend operators

**Schema lives in `routes/backend-auth.js`, not `database.js`:** `tenant_user_stores` at `:81-86` (composite primary key `(tenant_user_id, store_id)`, **FK to `tenant_users` only — none to any store table**); `tenant_users.retail_store_id` at `:240`; `tenant_users.scope_all` at `:246`, **default 1 = unscoped**; `tenants.rbac_enforce` at `:253`, **default 0 = enforcement off**.

**Written by:** `routes/backend-team.js:353-357` (the only writer of `tenant_user_stores`, a delete-then-insert inside `PUT /api/backend/team/:id/permissions`, with store ids validated against the business's own `retail_stores` at `:341-345`); `scope_all` at `:358`, forced to 0 for store-scoped roles on create (`:161-163`) and on role change (`:226-227`); `retail_store_id` on create (`:156-158`) and for store-pinned clerks (`:405-407`).

**Resolved by:** `lib/operator-caps.js:38-51`. When `scope_all` is falsy it reads `tenant_user_stores`, falling back to `[retail_store_id]` when that table is empty (`:46`) or errors (`:50`). `null` means unscoped.

**What it actually enforces:**

- **The general scope check** (`routes/retail.js:131-137`) requires **all three** of: `tenants.rbac_enforce = 1` (default 0), the operator is not the owner, and capabilities resolved. Even then, `storeIdFromPath` matches only `^/api/retail-admin/stores/(\d+)` (`lib/cap-routes.js:147-150`) — orders, products, coupons, purchases and media are entirely unscoped by location.
- **Role-pinned restrictions that are always on, independent of the flag:** a `kitchen` operator sees only their own store's product list (`routes/retail-inventory.js:234-237`) and may only add deltas, never set absolutes (`:311-313`); `kitchen` and `store_stock` operators may only patch their pinned store's stock (`:292-296`); Quick Stock returns their one store (`:600-603`); the whole backend is blocked for those two roles except a Quick Stock allowlist (`server.js:289-296`, which **fails open** if the tables are not ready).

**Stored but never enforced:**

- **`lib/require-cap.js:18-19` computes `scopeStores` and discards it** — it attaches only `req.backendCaps` and `req.backendRole` (`:42-43`). Every route guarded by `requireCap`, which is all of `routes/backend-team.js`, is location-unscoped. `GET /api/backend/stores/:storeId/staff` uses only `requireBackend` (`routes/backend-team.js:379`), so a store-scoped operator can list, create and delete stock clerks at **any** location in the business.
- `tenant_user_stores` is inert for every business by default, because `scope_all` defaults to 1 **and** `rbac_enforce` defaults to 0.
- Legacy kitchen retail operators are explicitly handed `scopeStores = null` (`routes/retail.js:157`).
- Client-side, the scope is used cosmetically: `public/retail-admin/02-settings-ops.js:1585-1586` sets a `RA_STORE_LOCK` used to pin and hide the dashboard filter.

### 3.4 Anything else binding a person to a location

- **The kitchen `permissions` table has no location column** — every column is a boolean feature flag (`database.js:395`, `:401`, `:405`, `:409`, `:415`, `:420`).
- **No courier or rider accounts exist.** There is no such table; rider identity arrives only as Qingyun tracking payload on an order.
- **No user↔Meituan-account binding exists.** Channel credentials are bound to *locations*, not people (`lib/tenant-creds.js:97-100`, `:113-116`).
- `retail_stock_ledger.actor_user_id` records who moved stock (`routes/retail-inventory.js:403`) but is deliberately not an FK, because the actor may be a kitchen `users.id` **or** a backend `tenant_users.id` — two id spaces sharing one column (`database.js:2635-2639`). This is the same class of problem the merge will create for location ids, and the code's own note on it is worth reading before deciding.

---

## 4. What references a location

### 4.1 Declared foreign keys

**To `markets(id)`:**

| Table.column | Rule | What breaks on a merge with reassigned ids |
|---|---|---|
| `market_stock.market_id` (`database.js:450`, `:455`) | `ON DELETE CASCADE` | Points at the wrong location. This table is otherwise near-dead (§4.3), so the cheapest option may be to migrate the balances rather than the ids. |
| `market_stock_ledger.market_id` (`database.js:466`, `:475`) | no cascade | Historic audit rows would be re-attributed to a different location. An audit log that quietly changes its mind is worse than one that is missing. |

**To `retail_stores(id)`:**

| Table.column | Rule | What breaks on a merge with reassigned ids |
|---|---|---|
| `retail_store_stock.store_id` (`database.js:2585`, `:2593`) | `ON DELETE CASCADE` | Every shelf balance lands at the wrong shop. |
| `retail_stock_reservations.store_id` (`database.js:2601`, `:2612`) | — | In-flight holds released against the wrong shop. |
| `retail_stock_ledger.store_id` (`database.js:2622`, `:2633`) | — | The entire stock audit trail is re-attributed. |
| `meituan_product_map.retail_store_id` (`database.js:4017`, `:4027`) | `CASCADE` | Listings push to the wrong Meituan shop. Note the row *also* carries `store_code`, so id and code would disagree — the daemon reads the code. |
| `meituan_sync_queue.retail_store_id` (`database.js:4037`, `:4046`) | — | Same, for pending pushes. |
| `meituan_bundles.retail_store_id` (`database.js:4309`, `:4319`) | `CASCADE` | Same, for combos. |
| `eleme_shops.retail_store_id` (`database.js:4439`, `:4446`) | `CASCADE`, `UNIQUE(retail_store_id)` | The Eleme shop link — the cleanest per-location channel binding in the repo — points at the wrong location. |
| `eleme_product_map.retail_store_id` (`database.js:4458`, `:4471`) | `CASCADE` | Listings push to the wrong Eleme shop. |
| `eleme_sync_queue.retail_store_id` (`database.js:4481`, `:4490`) | — | Same, pending. |
| `guanyi_product_map.retail_store_id` (`database.js:4539`, `:4554`) | `CASCADE` | Guanyi stock reconciliation targets the wrong warehouse. |
| `guanyi_sync_queue.retail_store_id` (`database.js:4566`, `:4575`) | — | Same, pending. |

Foreign keys are enforced (`database.js:10`, `lib/tenant-db.js:126`), so a merge that leaves a dangling id will be *rejected* on these columns — which is the good case. The dangerous columns are the ones below.

### 4.2 Plain integer columns with **no** foreign key — these fail silently

| Column | Points at | What breaks |
|---|---|---|
| `users.market_id` (`database.js:637`) | `markets` | Sales tagging and notification routing silently follow the wrong location. Nothing errors. |
| `users.retail_store_id` (`database.js:640`) | `retail_stores` | Stock-edit permission granted for the wrong shop. Nothing errors. |
| `tenant_users.retail_store_id` (`routes/backend-auth.js:240`) | `retail_stores` | Same, for backend operators. Cross-plane: this column lives in the shared database, the table it points at is per-business (§5.4). |
| `tenant_user_stores.store_id` (`routes/backend-auth.js:83`) | `retail_stores` | Scope lists become wrong. Its FK is to `tenant_users` only, deliberately — there is no store FK to catch this. |
| `retail_orders.store_id` (`database.js:2648`) | `retail_stores` | Every historic order is re-attributed to a different fulfilling shop. This is the single largest historic table involved. |
| `purchase_orders.store_id` (`database.js:44`) | `retail_stores` | Retail purchases receive into the wrong shop; `routes/retail-purchasing.js:111` uses it to push received quantities into stock. |
| `invoices.store_id` (`database.js:290`) | `retail_stores` | Bills attributed to the wrong location. |
| `retail_delivery_zones.preferred_store_id` (`database.js:3208`) | `retail_stores` | Zone routing prefers the wrong shop (`lib/inventory.js:317-318`, `:1132`). No frontend writes it — a repo-wide grep across `public/` finds nothing — so it is set by hand or not at all. |

### 4.3 `market_stock` is an orphan and should be treated as one

`database.js:444-446` and `routes/markets.js:147-148` both state that market stock is incremented automatically when a restock order is delivered, naming a function `_applyDeliveryToStock`. **That function does not exist** — a repo-wide grep finds only the two comments. The live transfer function is `_applyRestockTransfer` (`routes/restock.js:265`), and it writes `retail_store_stock` through `inventory.adjustStock` (`routes/restock.js:316-326`), never `market_stock`.

The only writer of `market_stock` and `market_stock_ledger` left in the codebase is the manual adjust endpoint (`routes/markets.js:203-213`). POS sales do not decrement it either — `routes/pos.js` contains no reference to the table. So a stall's counted stock only ever changes when an admin types a new number.

---

## 5. Id collision

### 5.1 The two id spaces overlap by construction

`markets.id` is `INTEGER PRIMARY KEY AUTOINCREMENT` (`database.js:613`). `retail_stores.id` is `INTEGER PRIMARY KEY AUTOINCREMENT` (`database.js:2566`). Neither has an offset, a prefix or any separation, so both begin at 1 and both increment by one. `retail_stores` is seeded with two rows in a fixed order — `tianhe` first (`database.js:3218-3221`), `yuexiu` second (`database.js:3261-3264`) — so ids 1 and 2 are certainly in use there. `markets` has no seed migration; its rows are created by people through the POS and the kitchen admin, from id 1 upward.

**Structurally, the ranges overlap.** UNVERIFIED at the level of actual live values, because reading row data was out of scope for this survey — but the schema leaves no way for them not to overlap once both tables have rows.

### 5.2 Columns holding a bare location id with no record of which table it came from

- **`users.market_id` and `users.retail_store_id`** (`database.js:637`, `:640`) are two separate columns, so the *column name* disambiguates them today. But both are untyped integers with no FK, and the kitchen admin presents them as two dropdowns side by side on the same user row (`public/app.html:15799-15811` and `:15815-15822`). Merging the tables collapses two columns into one and removes the only thing currently distinguishing the two id spaces.
- **`sales_entries.notes`** carries a bare market id inside the text tag `[markets:txn:N:M]` (`routes/pos.js:63`). The tag names `markets` in its prefix, so it is *self-describing* — but it is a string in a free-text column, parsed by regex (`routes/pos.js:127`), and a merge that reassigns market ids would need to rewrite historic notes text or leave every past POS sale pointing at the wrong location.
- **`meituan_orders.store_id`** (`database.js:852`) is a **third** id space entirely — it references `meituan_stores(id)` (`database.js:881`), the finance-import dimension created at `database.js:842-848` from the Meituan export's own `门店id`. It has no `retail_store_id` column and nothing joins it to `retail_stores` (its only consumers are `routes/sales.js:831`, `:901`, `:911` and `scripts/import_meituan.js:38-40`). So the column name `store_id` already means two unrelated things in this schema, and Meituan per-location profit-and-loss lives in a namespace disconnected from the per-location inventory.
- **`retail_stock_ledger.actor_user_id`** (`database.js:2629`) is the existing precedent for exactly this hazard — one integer column that may hold a `users.id` or a `tenant_users.id`, deliberately left without a foreign key because a hard one rejected every operator-driven write (`database.js:2635-2639`).

### 5.3 The repo has already been burned by this, on products

`routes/restock.js:210-217` is worth quoting in full when the merge is designed. It describes `products` and `store_products` as "two separate AUTOINCREMENT counters over ONE integer space, so an id only means the same thing on both sides for rows the fork seeded. For anything created since, the same integer points at a different product on each side — and because the FK is satisfied either way, nothing errors: the units simply land on the wrong product's shelf." The mitigation built for it — a pre-flight check comparing ids and SKUs before moving anything (`routes/restock.js:224-243`) — is the shape of what a location merge will need.

### 5.4 A structural mismatch that must be decided before ids are

`markets` is **not** in `CONTROL_PLANE_TABLES` (`lib/tenant-db.js:44-49`), so its schema is cloned into every business's own database (`lib/tenant-db.js:62-80`) — but `routes/markets.js` only ever uses the shared global connection (`routes/markets.js:8`), never `tdb()`. So the per-business copies of `markets` exist and stay empty, and all real market rows live in the shared database.

`retail_stores` is reached through `tdb()` everywhere (`routes/retail-inventory.js:85`, `:142`, `:169`; `lib/inventory.js:86`), so it is genuinely per-business.

Meanwhile `users` **is** control-plane (`lib/tenant-db.js:48`), so `users.retail_store_id` is a shared-database column pointing at a per-business table, and `tenant_users.retail_store_id` (`routes/backend-auth.js:240`) has the same shape. **The merged locations table has to pick a plane, and whichever it picks, one of these bindings crosses it.**

---

## 6. Channel attachment today

### 6.1 Meituan (外卖 and 闪购)

**`retail_stores.meituan_account_id` is dead.** Declared "for future sync" (`database.js:2576`), written on create (`routes/retail-inventory.js:100`) and via the update allowlist (`:127`), selected into the store list (`lib/inventory.js:88`), and displayed in two places (`public/app.html:17080`, and an inline `prompt()` edit at `:17136-17137`). **No sync, routing or authentication code reads it.**

The real link is `retail_stores.code` plus environment variables. `scripts/meituan-daemon.js:374-380` selects active stores by id, code and hours, then looks up credentials as `process.env['MEITUAN_' + code.toUpperCase() + '_USER'/'_PASS']` (`:386-387`). Which stores go to 外卖 versus 闪购 is decided by an opt-out environment list, `MEITUAN_SKIP_STORES` (`scripts/meituan-daemon.js:52-53`, applied at `:389`). Every Meituan table keys on `store_code`. For non-Roots businesses the same idea moves into encrypted per-location secret keys, `meituan.<store_code>.user|pass` (`lib/tenant-creds.js:113-116`).

**Verdict: per location, but the location is identified by a code string and the configuration lives in environment variables or per-location secrets, not on the location row.**

### 6.2 Eleme

The cleanest of the three. `eleme_shops` (`database.js:4436-4449`) has a real `retail_store_id` foreign key, `UNIQUE(retail_store_id)`, holding the operator-chosen Eleme shop id. Written at `routes/eleme-admin.js:111`, `:268`, `:276`; read at `:95`. Even the OAuth grant is per location — `eleme_tokens.account` is the store code (`database.js:4422`). The application-level keys (`ELEME_APP_KEY`, `ELEME_APP_SECRET`) are per business, in environment variables (`lib/eleme-client.js:38-49`).

**Verdict: per location, via a proper database column, with per-business application credentials.**

### 6.3 Guanyi / gzgrocery

A single environment variable with a hardcoded default: `GUANYI_STORE_CODE || 'tianhe'` (`routes/guanyi-admin.js:18`), resolved to a row by code at `:31` and **falling back to the first active store** at `:32`. The same default appears in the daemon and three scripts (§2.5). The Guanyi-side warehouse is not mapped to a local location by any column — it is either discovered from the scraped listings or forced by `GUANYI_WAREHOUSE_ID` (`lib/guanyi-browser.js:85`).

**Verdict: per business, effectively single-location, with the location baked into a default string.**

### 6.4 Mini app and web shop

Neither is tied to a location at all. The mini app resolves to a *business* by `x-wx-appid` → `tenants.wx_appid` (`middleware/public-tenant.js:57-62`); the web shop resolves by hostname → `tenant_domains` (`middleware/public-tenant.js:36-40`). The location is chosen **per order**, at checkout, by `routeOrder` (`lib/inventory.js:261`): nearest by real distance (`:294-301`), then the delivery zone's preferred store when there are no coordinates (`:303-320`), then a home-district match (`:323-328`), then a fallback (`:330-335`). The choice is stamped on the order as `store_id` + `routing_reason` (`database.js:2646-2649`).

Collection is the one explicit customer choice: `routingReason = 'customer_pickup'` with no routing at all (`routes/retail.js:9030-9034`), from the list of stores that are active, `pickup_enabled`, and not closed on both online channels (`routes/retail.js:819-830`, validated again at `:8654-8661`).

**Verdict: per business; the location is a per-order routing outcome.**

### 6.5 The one genuinely per-location, per-channel thing

`channel_status(channel, store_code)` (`database.js:4183-4190`) — a composite-primary-key row per channel × location saying whether that location is open on that channel. Keys are `mini_app`, `web`, `eleme`, `gzgrocery`. Read by `lib/inventory.js:107-114` to drop closed locations from routing, and surfaced as a grid plus a per-location master toggle in the admin (`public/retail-admin/01-core.js:601-660`, `:693-712`). Meituan is deliberately excluded — its per-outlet 置休 lives in `store_business_status` (`database.js:4148-4165`), also keyed on `store_code` alone.

Channel *credentials*, by contrast, are strictly per business: `tenant_integrations` is `UNIQUE(tenant_id, kind)` (`lib/integrations/registry.js:37`). Only the login **sessions** are per location: `integration_sessions` is `UNIQUE(tenant_id, kind, store_code)` (`lib/integrations/session-relay.js:41`) — again keyed on the code string, with no foreign key.

When a new location is created, the registry fans out a "link this store" to-do onto every configured channel's card, keyed by `store.code` (`lib/integrations/registry.js:252-277`). That is currently the only thing connecting a new location to the channels.

### 6.6 Summary

| Channel | Where the location link lives | Kind |
|---|---|---|
| Meituan 外卖 / 闪购 | `retail_stores.code` + `MEITUAN_<CODE>_USER/PASS`, or `meituan.<code>.*` secrets | Per location, via a code string in environment/secrets |
| `retail_stores.meituan_account_id` | Written and displayed only | Per-location column — **dead** |
| Meituan finance import | `meituan_stores.source_store_id` — no link to `retail_stores` | Separate, unlinked |
| Eleme | `eleme_shops.retail_store_id` (real FK) + `eleme_tokens.account = code` | **Per location, proper column** |
| Guanyi / gzgrocery | `GUANYI_STORE_CODE \|\| 'tianhe'` | Per business, hardcoded default |
| Mini app | `tenants.wx_appid` | Per business; location chosen per order |
| Web shop | `tenant_domains.host` | Per business; location chosen per order |
| Any of the above, open/closed | `channel_status(channel, store_code)` | **Per location × channel** |
| POS / markets | `[markets:txn:N:M]` inside `sales_entries.notes` | Per location, inside free text |

---

## 7. Every screen

This is the change surface. Grouped by application; completeness prioritised over depth.

### 7.1 Kitchen / production app — `public/app.html`

**Markets, full create-read-update-delete:**

| Screen | Location | Action |
|---|---|---|
| Admin → Markets tab, table of all locations with kind chip | `public/app.html:15890-15935`, dispatched `:16063` | list |
| `+ Add Market 新建市场` button | `public/app.html:16057` | create entry |
| Market form overlay: name, Chinese name, **kind select**, address, daily target, active | `public/app.html:17977-18010` | create + edit |
| Form save | `public/app.html:18013-18031` → `POST`/`PUT /api/markets` | create + edit |
| Deactivate button | `public/app.html:18033-18040`, button at `:15923` → `DELETE /api/markets/:id` | soft delete |
| Per-market stock overlay (only on `kind === 'retail'`) | `public/app.html:18048-18110`, launched `:15922` | per-location stock |
| Per-market stock adjust | `public/app.html:18170-18185` → `POST /api/markets/:id/stock/adjust` | edit stock |
| Per-market stock ledger | `public/app.html:18191-18195` | list movements |

**Retail stores, inside the same app:**

| Screen | Location | Action |
|---|---|---|
| Inventory page shell, tabs Stock / Stores / Ledger | `public/app.html:16936-16985` | list |
| Ledger tab store select | `public/app.html:16964-16968` | filter |
| Stores tab: inline add form + store table | `public/app.html:17030-17088` | list + create |
| Inline create | `public/app.html:17090-17110` → `POST /api/retail-admin/stores` | create |
| Inline field edits (including a `prompt()` for `meituan_account_id`) | `public/app.html:17113-17122`, `:17136-17137` | edit |
| Full store form overlay (with manual coordinate override) | `public/app.html:8929-9000` | create + edit |
| Store form save / delete | `public/app.html:9010-9046`, `:9070-9080` | create, edit, delete |

**Location pickers embedded elsewhere in this app:**

| Screen | Location | Action |
|---|---|---|
| **User management: two location dropdowns on the same row** — 📍 Markets (`market_id`, grouped by kind) and 🏪 Inv. Store (`retail_store_id`) | `public/app.html:15799-15811` and `:15815-15822` | assign user → location, twice |
| Products → Stock view: one editable column per store | `public/app.html:8620-8800`, cell save `:8878-8905` | list all + edit per location |
| Per-store edit gate (may only edit own `retail_store_id` column) | `public/app.html:8612-8617` | scoping |
| Product edit form: per-store stock rows | `public/app.html:12380-12430`, save `:12437-12460` | edit stock per location |
| Product detail 📦 Stock card, one row per active store | `public/app.html:13230-13270`, adjust modal `:13054-13175` | list + adjust per location |
| Sales → Markets analytics, series per `market_id` | `public/app.html:20821-20860` → `GET /api/markets/analytics` | analytics by location |
| Sales → Meituan tab store filter ("All stores · 全部门店") | `public/app.html:21260-21276` | filter — note this lists **`meituan_stores`**, the third table |
| Purchase order form: hidden `po_warehouse` input | `public/app.html:14843` | vestigial free-text location |
| Restock page role toggle 🏪 门店 / 🏭 仓库 | `public/app.html:18496-18512` | switches location side |

### 7.2 Mini-app backend / store admin — `public/retail-admin.html` + `public/retail-admin/*.js`

| Screen | Location | Action |
|---|---|---|
| Settings → Operations store list | `public/retail-admin/02-settings-ops.js:176-208` | list |
| Store form: code, phone, names, city, district, address, **hours**, pickup, GPS | `…/02-settings-ops.js:215-267`, save `:268-300` | create + edit |
| Per-store "Stock staff · 库存员" panel | `…/02-settings-ops.js:312-397` | list, create, delete users at a location |
| Team invite: store select for store-pinned roles | `public/retail-admin.html:11181-11184`, filled `…/02-settings-ops.js:1926-1937` | assign user → location |
| Team edit: store select | `public/retail-admin.html:11245-11247` | reassign user → location |
| Permissions modal: **per-location checkbox scope list** + "All stores" toggle | `public/retail-admin.html:11288`, `…/02-settings-ops.js:2134-2142` → `PUT /api/backend/team/:id/permissions` | multi-location scope |
| Dashboard store filter (hidden for single-location businesses; pinned for `store_manager`) | `public/retail-admin.html:2016`, `…/03-dashboard.js:283-320` | filter |
| Running-low / stock drawer store select | `…/03-dashboard.js:1489-1524`, rendered `:2344`, `:2622` | filter |
| Orders list store filter | `public/retail-admin.html:2234`, `…/04-orders.js:2515-2532` | filter |
| "Print at which store? · 在哪个门店打印？" reprint modal | `…/04-orders.js:4860-4890`, called `:4733-4751` | select location |
| Products list "Stock for [All / Tianhe / Yuexiu]" segment | `public/retail-admin.html:4228`, `…/09-products.js:681-745` | filter |
| Products list per-store stock columns | `…/09-products.js:1020-1060`, save `:779-800` | edit stock per location |
| Product editor per-store / per-variant stock block | `public/retail-admin.html:4411`, `…/09-products.js:1927-1950`, save `:2070-2145` | list + edit |
| Product wizard writes initial stock into the primary store | `…/09-products.js:6007-6025` | implicit location choice |
| Purchasing wizard "Deliver to · 收货门店" | `…/16-purchasing.js:396-412`, store list `:119-124` | select destination |
| Purchasing item picker scoped to the chosen store's stock | `…/16-purchasing.js:137-143` | per-location read |
| Sales/Channels: per-location toggle rows inside each channel card | `…/01-core.js:601-660` | list + toggle location × channel |
| Sales/Channels **Locations section**: one card per location, master open/close toggle | `…/01-core.js:693-712` | list + toggle whole location |
| "Add location · 新增门店" button on that section | `…/01-core.js:710`, `:560-562` | create entry |
| **Add-location wizard** (Integrations): code, phone, names, city, district select, address with auto-geocode, open/close time, pickup | `…/15-integrations.js:216-260`, save `:288-310`, follow-up to-dos `:313-340` | create |
| Channel-relay credential wizard: which location's merchant login | `…/15-integrations.js:420-424` → `storeCode` at `:496` | select location |
| **Setup-guide store wizard**, four steps: name → address with map pin → phone → hours and **time zone** | `…/17-setup-guide.js:203-502`, finish `:539-580` | create or edit |
| "Which store do you want to set up?" picker, plus "Add a new location" | `…/17-setup-guide.js:253-288` | select or create |
| "Add another location" prompt after save | `…/17-setup-guide.js:589-610` | create loop |
| Per-store printer panels, tabbed by location | `public/retail-admin.html:9784`, `…/02-settings-ops.js:541-610` | select location, edit per-location config |
| Qingyun per-location connect cards | `public/retail-admin.html:7049`, `…/02-settings-ops.js:471-540` | list + per-location action |
| Meituan mapping board, per-location columns | `public/retail-admin.html:10536-10537`, `…/11-meituan.js:94-120`, `:381`, `:847` | list |
| Meituan paste-import location select | `…/11-meituan.js:740` | select |
| Meituan bundle builder location picker | `…/11-meituan.js:921` | select |
| Eleme store list with per-location connect / link shop | `public/retail-admin.html:10883`, `…/14-eleme.js:83-130` | list + link |
| Integration-hub cards, one row per location for Meituan and Eleme | `…/15-integrations.js:544`, `:596`, `:635-712` | list + link |

### 7.3 POS — `public/pos.html`

| Screen | Location | Action |
|---|---|---|
| "🏪 Select Market · 选择市场" full-screen picker | `public/pos.html:806-812`, opened `:1747`, rendered `:1752-1800` | list + select |
| Inline "+ 新建市场" form with **📍 Use my location** GPS capture | `public/pos.html:1781-1793` | create |
| Inline edit of an existing market | `public/pos.html:1826-1848` | edit |
| Save | `public/pos.html:1968-2010` → `POST`/`PUT /api/markets` | create + edit |
| Delete | `public/pos.html:1849-1860` → `DELETE /api/markets/:id` | soft delete |
| Pick / clear own market | `public/pos.html:2013-2030` → `PUT /api/pos/my-market` | select and persist |
| **Market gate** — scanning, adding to cart, opening the cart and login all bounce to the picker when no market is set | `public/pos.html:1022`, `:1047-1060`, `:1107-1122`, `:1152` | forced selection |
| Daily-target chip | `public/pos.html:1243` | location-derived display |

### 7.4 Web shop — `public/shop.html`

Delivery-only; there is no collection flow and therefore no location picker (`public/shop.html:1653`). Locations appear only as display: the collection store's name and address on an order (`public/shop.html:2950-2955`), a 🏬 Pickup tag (`:2899-2902`), and the store's hours behind the reschedule modal (`:3017-3070`).

### 7.5 WeChat mini app — `miniapp/`

| Screen | Location | Action |
|---|---|---|
| Checkout **collection-point picker** — radio list of pickup-enabled locations with a "View on map" link per row | `miniapp/pages/checkout/checkout.wxml:162-192`, loaded `checkout.js:961-990` → `GET /api/retail/pickup-stores` | list + select |
| Delivery ⇄ Pickup toggle (forced to pickup when delivery is not configured) | `miniapp/pages/checkout/checkout.wxml:54-59`, `checkout.js:349-352` | select fulfilment mode |
| Date/time pickers bounded by the chosen location's window | `miniapp/pages/checkout/checkout.wxml:194-212` | hours-scoped input |
| Fallback-store consent ("ship from the farther store") | `miniapp/pages/checkout/checkout.js:140-152` | implicit location selection |
| Order detail / success screens showing the collection location | `miniapp/pages/order/order.js:530-557`, `order-success/order-success.js:63-64` | display |

### 7.6 Standalone pages

| Screen | Location | Action |
|---|---|---|
| **Quick-Stock PWA** `public/stock.html` — loads allowed locations, remembers the last one | `public/stock.html:363-378` → `GET /api/retail-admin/quick-stock/context` | list + auto-select |
| Its location bottom-sheet picker (static pill for single-location users) | `public/stock.html:716-730`, select `:475-482` | select |
| Its per-location stock list and edits | `public/stock.html:485-500`, `:600-655` | list + edit stock |
| **Restock PWA** `public/restock.html` — "Where to send? · 发往哪里" destination modal (Kitchen / Store) | `public/restock.html:3143-3168` | select destination role |
| Its store branch: **no picker**, hard-coded single-location assumption | `public/restock.html:3165-3168` | known gap |
| Its inbox polling split by location role | `public/restock.html:1841-1865`, `:1899-1910` | role filter |
| **`public/backend-team.html`** — invite store select, edit member store, and a multi-location permission scope grid | `:613-621`, `:659-684`, `:861-897` | assign user → location(s) |
| `public/kitchen.html` — direction filter only, kitchen is implicitly the current location | `public/kitchen.html:1055-1180` | no picker |
| `public/m.html` mobile companion — location strings are **mock data only**, no live location surface | `public/m.html:153-161`, `:628` | display (mock) |

**Verified to have no location surface:** `public/product-editor.html`, `public/cms.html`, `public/cms-mobile.html`, `public/full-circle.html`, the `backend-*` pages, `public/brand-studio.html`, `public/storefront.html`, `public/shop/*`. **Out of scope:** `public/store-admin.html` and `public/saas-admin.html`, whose "store" means a customer business, not a place.

### 7.7 The consequence for the merge

**Five separate user interfaces create or edit a `retail_stores` row**, each with a different field set: the full form in the kitchen app (`public/app.html:8929`, the only one with a manual coordinate override), the inline add form in the same app (`:17030`), the Operations form (`…/02-settings-ops.js:215`, the only one with phone and hours), the Add-location wizard (`…/15-integrations.js:219`, create-only), and the setup-guide wizard (`…/17-setup-guide.js:203`, **the only one that captures a time zone**). Plus two more that manage `markets` (`public/app.html:17977`, `public/pos.html:1781`). Seven editors, two tables, one idea.

---

## 8. Opening hours and time zone

**The columns exist.** `open_time` and `close_time` were added at `database.js:2678-2679` as `'HH:MM'` local text, "both set or both NULL = always open" (`database.js:2675-2676`). `timezone` was added at `database.js:2683` as an IANA zone name, explicitly so "checkout validates a pickup time against the store's LOCAL clock rather than the UTC+8 host. NULL = fall back to host-local" (`database.js:2680-2682`). `markets` has no equivalent columns at all.

**What reads them:**

| Reader | What it does |
|---|---|
| `routes/retail.js:8664-8667` | Collection-time validation at checkout passes the chosen location's `open_time`, `close_time` **and `timezone`** into `resolvePickupTime`. |
| `routes/retail.js:7866-7876` | `resolvePickupTime` itself — uses the location's zone when given (`:7868`), otherwise falls back to the single business-wide `pickup.window` config. This is the only place a per-location time zone genuinely changes a result. |
| `lib/store-hours.js:36-41` | The shared hours module. Reads `code`, `open_time`, `close_time` for all locations, cached ten minutes. **Does not read `timezone`** — it computes minutes at a fixed UTC+8 offset (`lib/store-hours.js:58-63`). Its only consumer is `scripts/qingyun-daemon.js:84`. |
| `scripts/meituan-daemon.js:111-117` | Merges the database hours over its hardcoded map — **once, at boot** (`:380`). An admin edit needs a daemon restart. Also fixed UTC+8 (`:118-121`). |
| `public/retail-admin/02-settings-ops.js:241-242`, `:276` | The Operations store form writes hours (not time zone). |
| `public/retail-admin/15-integrations.js:298` | The Add-location wizard writes hours (not time zone). |
| `public/retail-admin/17-setup-guide.js:189-192`, `:366-368`, `:554-558` | The setup-guide wizard is **the only interface that writes `timezone`**, defaulting to `Asia/Shanghai` (`:445`). |

**What ignores them:**

- `scripts/shangou-daemon.js:68-70` hardcodes `yuexiu`'s hours and has **no database override at all** — no call to `lib/store-hours`, no `loadStoreHours`. Every other location is treated as open around the clock (`:81-82`).
- **`lib/inventory.js:86-89` omits `timezone` from `listStores`.** Every screen that loads the store list therefore cannot see it. Only `getStore` (`lib/inventory.js:94`, `SELECT *`) returns it, which is why the checkout path works and the admin list does not.

**Is any location-level time zone used in date calculations? No.** Every date and business-day computation in the codebase uses a fixed Asia/Shanghai / UTC+8 offset, independent of any location: `lib/store-hours.js:58-63`, `scripts/meituan-daemon.js:118-121`, `scripts/shangou-daemon.js:76-78`, `lib/ops-alert.js:54`, `lib/platform-alert.js:26`, `lib/gzgrocery-order-notify.js:48`, `lib/meituan-browser.js:354`, `:720`, `lib/shangou-browser.js:285`, `lib/guanyi-browser.js:129`, `routes/retail.js:5836`. The single exception is collection-time validation (`routes/retail.js:7868`), which is a customer-facing check on one order rather than a business-day boundary.

**This supports the decision that the business day is business-wide, not per location.** No reporting, settlement, cut-off or day-boundary calculation currently reads a per-location zone, so making the business day business-wide breaks nothing. The per-location `timezone` column has exactly one honest job — validating a collection time against the shop's own clock — and it should be allowed to keep it.

---

## 9. Closing and deleting

### 9.1 Deactivating a market

`DELETE /api/markets/:id` (`routes/markets.js:125-141`) is a **soft delete**, open to admin or any `pos` holder. Inside one transaction it does two things: sets `is_active = 0` (`:135`), and **clears `users.market_id` for every user assigned to it** (`:136`) so they are prompted to re-pick rather than silently tagging future sales to a dead location.

- **Stock is not checked.** Nothing looks at `market_stock` before or after. Whatever balance was recorded stays in the table, attached to an inactive location, invisible to every picker.
- **Historic sales keep their tag.** The `[markets:txn:N:M]` notes tag still carries the dangling id, acknowledged at `routes/markets.js:121-124`. Analytics resolve the name via `marketsById` (`routes/pos.js:256-264`), which reads the full list, so the name still renders.
- **Reactivation exists** two ways: creating a market with the same name reactivates the old row rather than inserting a parallel one (`routes/markets.js:55-61`), and the edit form's Active checkbox can flip it back (`public/app.html:18001`, sent at `:18022`).
- Both confirmation dialogs tell the truth about what happens (`public/app.html:18034`, `public/pos.html:1851`) — that sales keep their data and the location stops appearing in pickers.
- **No hard delete path exists anywhere** for `markets`. The `ON DELETE CASCADE` on `market_stock` (`database.js:455`) is therefore unreachable through the application.

### 9.2 Deactivating a retail store

`DELETE /api/retail-admin/stores/:id` (`routes/retail-inventory.js:166-173`) is also a **soft delete** — a single `UPDATE retail_stores SET is_active = 0`, with the comment "so historical orders keep the reference" (`:168`).

**What it does not do:**

- **No stock check.** `retail_store_stock` rows survive untouched. Because `listStores` defaults to active-only (`lib/inventory.js:84-85`) and the cross-store grid iterates only active stores (`routes/retail-inventory.js:185`), that stock becomes **invisible in every screen while still existing in the table**. Nothing tells the operator it is there, and nothing offers to move it.
- **No user cleanup.** Unlike the markets path, `users.retail_store_id`, `tenant_users.retail_store_id` and `tenant_user_stores.store_id` are all left pointing at the closed location. A kitchen user still passes the "has any store assigned" read gate (`routes/retail-inventory.js:61-62`); Quick Stock does check `is_active` and returns an empty list (`routes/retail-inventory.js:602`, `:610`), giving the `nostore` empty state (`public/stock.html:369-372`) with no explanation of why.
- **No channel cleanup.** The `eleme_shops`, `meituan_product_map`, `guanyi_product_map` and `channel_status` rows all remain. `channel_status` and the rest key on `code`, not id, so nothing about deactivation touches them.
- **No confirmation of consequences.** The dialogs are generic.

**What deactivation does correctly:** the location drops out of order routing (`lib/inventory.js:266-268`), out of the collection list (`routes/retail.js:819-830`), out of the cross-store grid, and out of the Quick Stock picker. Historic orders keep their `store_id`, and `getStore` (`SELECT *`, no active filter) still resolves the name for display.

**Reactivation** is possible through the update allowlist — `is_active` is in it (`routes/retail-inventory.js:127`).

**No hard delete path exists** for `retail_stores` either. The many `ON DELETE CASCADE` rules on the channel-mapping tables (§4.1) are unreachable through the application, which is fortunate: a hard delete would silently destroy every Meituan, Eleme and Guanyi mapping for that location.

### 9.3 What this means for the target model

"Temporary locations can be closed but never deleted, and closing requires stock to be moved out and confirmed" has **no existing implementation to build on**. There is no stock check, no move-out flow, no confirmation step, and no distinction between the two kinds of closing. What does exist and is worth keeping is the shape of the markets path — deactivate and *unassign the people* in one transaction — which the retail-stores path lacks and should gain regardless of whether the tables merge.

---

## Items marked UNVERIFIED

1. **Actual overlapping id values.** §5.1 establishes that both tables use unoffset autoincrement from 1, so the ranges overlap structurally. The live values were not checked because reading row data was out of scope for this survey.
2. **`settings['restock.warehouseStoreId']`.** No writer was found anywhere in `routes/`, `lib/`, `scripts/` or `public/`. A manual database edit cannot be ruled out.
3. **`routes/retail.js` end to end.** The file is roughly 28,000 lines. It was searched for `warehouse`, `store_name`, `store_code`, `pickup_store`, `location`, `timezone`, `scopeStores` and the location literals, and the matching regions were read, but it was not read in full.
4. **`routes/ai.js`.** Contains extensive prose describing locations to the language model (`:913`, `:981`, `:1287`, `:1456`, `:1464`, `:1580`). These are prompt text, not storage or routing. A grep for location-table inserts in that file returned nothing, but the file was not read in full.
5. **`miniapp/` beyond checkout and order pages.** Hits for the location literals in `pages/addresses`, `pages/cart`, `pages/map-picker` and `utils/zones.js` appear to be customer delivery-address district data (Guangzhou districts), not business locations. Not audited in depth.
6. **The exact save endpoint for the global collection-window config** (`public/retail-admin.html:6694-6723`, fields `cfg-pickup-open`, `cfg-pickup-close`, `cfg-pickup-lead`). These are location-hours settings shared across all collection-enabled locations; the endpoint was not traced.
7. **The read endpoint behind the product-detail per-store Stock card** (`public/app.html:13230-13270`). The adjust call is confirmed (`:13170`); the read is inferred from the response shape at `:13064`.
