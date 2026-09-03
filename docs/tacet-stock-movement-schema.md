# Tacet stock movement — schema survey and migration plan

**v1.3 · 2026-09-03 · SURVEY AND PROPOSAL ONLY. No code has been written, no migration exists, no schema has changed.** This document answers the seven unknowns in the stock-movement brief and proposes the schema that would satisfy `docs/tacet-consolidation-decisions.md` §39. It is a plan to be reviewed, not a description of the product. Where the survey contradicts the brief it was written from, it says so and quotes the code.

**v1.3 adds A8, a survey of the recipe screen's "Makes" field, which partly corrects A5 and re-scopes step 1 of the production work.** Short version: **"Makes" is not a stored field** — it is the reverse lookup on `store_products.recipe_id`, rendered read-only, and A5 understated how much of it already ships. **Step 1 shrinks** from building a mapping to finishing its data. **But a second gate appears**: a recipe's output exists as a sellable product *and* as a material, the material has no stock by decision, so **the bulk half of a split batch cannot be recorded at all.** No code, no schema change, no migration.

**v1.2 records D6, Ash's ruling on Q5 — the last of the six open questions — and its consequences for B6's scoping. All six are now answered; nothing in PART C gates implementation, and the one thing that does (E2) blocks a single migration step rather than the migration.**

**v1.1 folds in a second document that briefly existed at this same path on branch `claude/stock-movement-schema-decisions-av2e21`.** That branch was written without sight of this one — the session had only `origin/main` and its own branch in its refs, found no file here, and wrote a parallel one. **This document is primary and that branch is SUPERSEDED and abandoned**; its file is left in place as history and nothing further is committed to it. What it contributed and this document lacked is now here: **Ash's five rulings and their reasoning (PART D)**, which close four of PART C's open questions, and **the debt and consequences those rulings leave behind (PART E)**. Where the two said the same thing, this document's wording was kept — it was first, and its IN TRANSIT naming is the more precise.

Constraints taken as binding: **SQLite stays** (§24 — the Postgres migration is cancelled, and nothing here is deferred pending it); **every stock write goes through `lib/inventory.js` `adjustStock`** — no new direct writers; **everything must work on a tenant database**, not only Roots; **the markets / `retail_stores` split is out of scope** and is not touched anywhere below.

---

# PART A — SURVEY

## A0. Four findings that change the shape of the work

These came out of the survey rather than the brief, and two of them are live defects rather than gaps. They are stated first because B is built around them.

**A0.1 — `adjustStock` cannot record what a movement was for.** `lib/inventory.js:1066` takes `{ storeId, productId, newPhysicalQty, deltaQty, actorUserId, actorLabel, note, reason }` and hardcodes the ledger's provenance columns:

```js
INSERT INTO retail_stock_ledger
  (store_id, product_id, delta, reason, ref_table, ref_id, balance_after, actor_user_id, actor_label, note)
VALUES (?, ?, ?, ?, 'retail_store_stock', NULL, ?, ?, ?, ?)
```

`ref_table` is always the literal `'retail_store_stock'` and **`ref_id` is always NULL**, even though `retail_stock_ledger` declares both columns for exactly this purpose (`database.js:3112-3113`) and carries `idx_retail_ledger_ref ON (ref_table, ref_id)` — an index over a column nothing ever fills. The only link from a ledger row back to a restock order today is the free-text `note`, which `routes/restock.js:352` sets to `o.rs_number || ('RS#' + o.id)`.

**This matters far more under two steps than one.** With both halves inside one transaction, provenance was recoverable by inspection. With the halves hours apart, "has the OUT half for this transfer already been written?" becomes a question the system must answer from the ledger, and it currently cannot ask it except by string-matching a note.

**A0.2 — the zero clamp silently creates units.** Same function:

```js
if (deltaQty != null) newPhysicalQty = Math.max(0, oldQty + deltaQty);
```

Dispatching 50 from a warehouse holding 20 writes a delta of −20, not −50, and returns without error. Under the current one-step model the IN half then adds the full 50 and 30 units are created from nothing, inside a transaction that commits cleanly. Under the two-step model the OUT half is where the clamp bites and the IN half arrives hours later at the counted quantity, so the same 30 units still appear — with nothing on screen and nothing in the ledger saying so. **This is a live defect today, not one the new model introduces**, but the new model makes it harder to spot.

**A0.3 — quantities change type across the boundary.** `restock_items.qty_requested` and `qty_sent` are `REAL` (`schema.sql:330-331`). `retail_store_stock.physical_qty`, `retail_stock_ledger.delta` and `retail_stock_ledger.balance_after` are all `INTEGER` (`database.js:3073`, `3110`, `3114`). A restock line of 2.5 is accepted by the request and lands in SQLite's integer columns without complaint — SQLite applies INTEGER affinity and stores 2.5 as 2.5 anyway, because affinity is not a constraint. So the columns claim integer, the data may be fractional, and any reader that assumes integers is wrong. **Whichever way this is settled it must be settled deliberately** — see Q4.

**A0.4 — `data/roots.db` in this checkout is not live Roots data.** It holds **0 `restock_orders`, 0 `restock_items`, 0 `recipes`, 0 `production_batches`, 2 `store_products`** (both with `recipe_id` NULL), and four `retail_stores` of which two are fixtures (`tbt-warehouse`, `tbt-near`). There is no `tenants` table and `data/tenants/` does not exist. **A6 therefore cannot be answered from this repository** — see A6 for what that means for the migration.

---

## A1. Status lifecycle — the brief's reading is correct

`routes/restock.js:155`:

```js
const STATUS_FLOW = ['draft', 'sent', 'received', 'prepared', 'delivered'];
```

**Confirmed: `sent` and `received` describe the REQUEST, not the goods.** `sent` is the store submitting its request; `received` is the warehouse acknowledging it has the request. `public/kitchen.html:1238` is the clearest evidence — `const canCheck = o.status === 'sent' || o.status === 'received';` — the warehouse can only tick items off *while the order is in those two states*, which is only coherent if the goods have not moved yet.

The goods-bearing transitions are `prepared` and `delivered`, and the file's own comment (`routes/restock.js:159`) says so: *"status → 'prepared', the moment stock actually leaves the shelf"*.

**Timestamp columns that already exist on `restock_orders`** (`schema.sql:307-311`, all `DATETIME`, all nullable):

| Column | Set at |
|---|---|
| `created_at` | insert, `DEFAULT CURRENT_TIMESTAMP` |
| `sent_at` | transition to `sent` |
| `received_at` | transition to `received` |
| `prepared_at` | transition to `prepared` |
| `delivered_at` | transition to `delivered` |

Plus, added by migration in `database.js`: `archived_at` (826), `stock_applied_at` (832), and the direction columns `from_role` / `to_role` / `purpose` (816-821).

**What fires at each transition today** — all from the single handler at `routes/restock.js:694-733`:

| Transition | Timestamp | Stock | Push / SSE | Notes |
|---|---|---|---|---|
| → `sent` | `sent_at` | none | `_fireRestockPush` + `_broadcastRestock` | |
| → `received` | `received_at` | none | **none** — "internal warehouse state" (line 720) | |
| → `prepared` | `prepared_at` | **`_applyRestockTransfer`** — both halves, one transaction | push + broadcast | the real movement |
| → `delivered` | `delivered_at` | `_applyRestockTransfer` again — no-op via `stock_applied_at` | push + broadcast | "safety net" (line 712) |

Two properties of the handler that constrain B1. `toIdx <= fromIdx` is rejected outright (line 702), so **the flow is strictly forward and cannot skip backward** — but it *can* skip forward, e.g. `sent` → `delivered` directly, and that path fires the transfer with `prepared_at` left NULL. And a single `tsCol` map (line 705) means one status writes exactly one timestamp.

---

## A2. `restock_items` — full column list

From `schema.sql:323-337`. No migration adds columns to this table anywhere in `database.js`.

| Column | Type | Null | Meaning |
|---|---|---|---|
| `id` | INTEGER | PK | |
| `restock_id` | INTEGER | NOT NULL | FK → `restock_orders(id)` ON DELETE CASCADE |
| `product_id` | INTEGER | nullable | FK → `products(id)` — **a KITCHEN products id, see below** |
| `product_name` | TEXT | NOT NULL | snapshot |
| `product_cn` | TEXT | nullable | snapshot |
| `sku` | TEXT | nullable | snapshot |
| `qty_requested` | REAL | NOT NULL | **what the store asked for** |
| `qty_sent` | REAL | **nullable** | **what the warehouse actually allocated** |
| `unit` | TEXT | nullable | |
| `notes` | TEXT | nullable | |
| `is_checked` | INTEGER | DEFAULT 0 | warehouse tick-off, picking progress only |

**`qty_requested` and `qty_sent` both exist and mean what the brief expects.** `qty_sent` is nullable and the transfer treats NULL as "the warehouse did not override, so send what was asked": `routes/restock.js:326`, `const qty = (it.qty_sent != null) ? Number(it.qty_sent) : Number(it.qty_requested);`. That NULL-means-fallback convention is load-bearing and is preserved in B2.

**There is nothing resembling `qty_received`.** No column, no side table, no JSON blob. The received quantity has nowhere to go today, which is the single biggest gap between the schema and §39.

**A trap that the new column must not repeat.** `restock_items.product_id` is a *kitchen* `products.id`, while every table the transfer writes is keyed on `store_products.id`. `routes/restock.js:237-250` documents this at length: the two tables are separate AUTOINCREMENT counters over one integer space, the FK is satisfied either way, and a mismatched id silently moves the wrong product's stock. `_checkTransferIds` (line 251) exists solely to refuse a transfer where any line fails that check. **Any receipt path must run the same check**, and B8 says where.

---

## A3. Idempotency — one stamp is not enough, and nothing outside the tests reads it

`stock_applied_at` is added at `database.js:832` and its comment describes exactly one event: *"stamped the first time a restock_orders row transitions to 'delivered' and we apply the order's items"*. It is read in exactly three places in `routes/restock.js` — the guard at 306, the write at 370, and the doc comments — and **nowhere else in any route, page, script or daemon**. Outside `routes/restock.js` the only references in the entire repository are in the two test suites (`scripts/test_restock_tenant_handle.js`, `scripts/test_restock_tenant2_split.js`) and in `database.js` itself.

**So it can be replaced without breaking a reader.** It cannot simply be split, though, because it currently guards a *pair* of writes; under two steps each half needs its own guard, and the guards must be independent — the OUT half succeeding must never imply the IN half has run.

Proposal in B2: **two nullable stamps, `dispatched_at` and `received_confirmed_at`**, and `stock_applied_at` retained but frozen (see B8 for why it is not dropped).

---

## A4. Configuration — a working mechanism exists; do not build a second one

**The brief is correct that `settings` does not exist.** `routes/restock.js:186` queries `SELECT value FROM settings WHERE key = 'restock.warehouseStoreId'`, there is no `CREATE TABLE ... settings` anywhere in `schema.sql` or `database.js`, and the file's own comment (lines 179-184) already records that this lookup always throws and falls through. It is the only reader of that table in the repository.

**The working mechanism is `storefront_config`**, created at `database.js:1704`:

```sql
CREATE TABLE IF NOT EXISTS storefront_config (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_by  INTEGER
);
```

Read through `cfgValue(key, fallback)` at `routes/retail.js:8802`, which resolves on `tdb()` and JSON-parses the value. It is **data-plane** — absent from `CONTROL_PLANE_TABLES` in `lib/tenant-db.js:90-95` — so it is cloned per tenant and each tenant carries its own values, which is exactly what a warehouse-location setting needs.

It is in live use: `data/roots.db` holds 31+ keys including `batch.schedule` (the blob `batchScheduleCfg()` reads), `inventory.lowStockThreshold`, `inventory.reservationTtlMinutes`, `fees.*`, `points.*`, `delivery.*`. The naming convention is `domain.camelCaseKey`.

**Recommendation: use `storefront_config`. Do not create a `settings` table.** Two keys, both holding a `retail_stores.id`:

- `stock.warehouseStoreId` — the location goods ship out of
- `production.outputStoreId` — where a logged batch lands (§39: per tenant, Roots points it at the warehouse)

The name `storefront_config` reads oddly for a warehouse setting, and that is a fair objection — but it is already the tenant's general key/value config store, holding `inventory.*` keys that have nothing to do with the storefront either. **Renaming it is a separate change and a much larger one.** Noted as Q1 rather than decided here.

---

## A5. Recipe → product — the mapping exists, is one-directional, and is not unique

> **CORRECTED IN PART, 2026-09-03 — see A8.** Everything stated in A5 is factually true and none of it is withdrawn. What A5 got wrong is the **weight** it put on those facts: it presented the reverse lookup as something a future build would have to construct, and concluded production-to-stock "cannot be built on it as it stands". **That lookup is in fact already shipped, rendered on the recipe screen as the "Makes" line, filtered, ordered and read by the cost cascade — and since the recipe-link endpoint exists, the column is writable by hand, which A5 did not establish.** The original text is left exactly as written below, because the survey it records is sound and the conclusion drawn from it is the part that moved. **Read A5 for the facts and A8 for what they mean.**

**This is the piece the brief flagged as most likely missing. It is not missing, but it does not point the way production needs.**

What exists:

- **`store_products.recipe_id`** — a product → recipe pointer, populated by the one-off migration `store_products_recipe_link_v1` (`database.js:4560-4650`). Its rule is written out in the code rather than as an id list: a product is linked when two or more of {exact SKU, exact `name_en`, exact `name_cn`} agree, **exactly one** recipe qualifies, the recipe yields `costPerServing > 0`, and the product is not a sample size or multipack. Group-B pairs (one signal only — 36 of them, all SKU-only) are **deliberately left unlinked for Ash to confirm by hand**.
- **`products.recipe_id`** (`schema.sql:155`) — the kitchen-side equivalent, commented "linked recipe (for cost calc)". **The same migration explicitly refuses to use it as a signal** because the data is wrong: it cites kitchen product 23 "81% Hazel Chocolate Spread" pointing at recipe 46 "Pickle carrot（Do chua）", and concludes *"one bad row in four is not a signal"*.
- **`ingredients.source_recipe_id`** (`database.js:673`) — a made thing appearing as a material (§29, nested recipes). Different relationship, not a sellable-product link.
- No `product_recipes` join table exists. No `recipes.product_id` column exists.

**Three reasons this cannot carry production output as it stands:**

1. **The direction is wrong.** `production_batches.recipe_id` needs *recipe → product*; what exists is *product → recipe*. The reverse lookup is `SELECT id FROM store_products WHERE recipe_id = ?`.
2. **Nothing makes that reverse lookup single-valued.** There is no `UNIQUE` index on `store_products.recipe_id`. Two products legitimately made from one recipe — a 200g jar and a 500g jar — would both link to it, and the query returns two rows with nothing to choose between them.
3. **It is partial by design.** The migration leaves the 36 ambiguous pairs deliberately unlinked, so a recipe someone produces today may simply have no product.

There is also a unit problem underneath: a batch is `batches_made` × the recipe's `batch_size`, or `servings_made`. §39 wants a count of sellable units. `store_products_recipe_link_v1` asserts *"One serving is one sellable unit"*, but it asserts that only for the products it linked, and only to derive a cost.

**Verdict, plainly: the mapping is one-directional, non-unique and incomplete, and production-to-stock cannot be built on it as it stands.** B6 scopes the fix as its own piece of work, per the brief's instruction not to fold it in.

**D6 (2026-09-03) hardens this rather than softening it.** Ash has ruled that a batch may yield several products, so the fix **must not** be a `UNIQUE` index on `store_products.recipe_id` or a single `output_product_id` column — the two cheapest repairs are both now forbidden, because each asserts one recipe makes at most one product. **What is needed is a mapping that is single-valued in neither direction, and the 36 pairs this migration left ambiguous are a gate on building it** — see B6.1.

---

## A6. In-flight orders — cannot be answered from this repository

Queried `data/roots.db` directly:

```
restock_orders           0 rows
restock_items            0 rows
recipes                  0 rows
production_batches       0 rows
store_products           2 rows (both recipe_id NULL)
retail_stores            4 rows — tianhe, yuexiu, tbt-warehouse, tbt-near
```

There is no `tenants` table in this database and no `data/tenants/` directory, so no tenant database can be inspected either. **This checkout carries a development scaffold, not production data.**

**What this means for the migration, and it is not nothing:** the in-flight handling in B8 has to be written defensively rather than fitted to a known distribution. Specifically it must not assume that no order sits at `prepared`, that every `prepared` order has `stock_applied_at` set, or that `qty_sent` is populated. **Before the migration runs anywhere real, the counts in A6 must be re-taken against the actual production database** — that is a prerequisite step in B8, not an optional check. The query to run is recorded in B8.

---

## A7. Readers outside `routes/restock.js`

Grepped the whole repository for `stock_applied_at`, `restock_orders`, `restock_items` and `api/restock`.

**`stock_applied_at` — no production reader anywhere.** Only `scripts/test_restock_tenant_handle.js` (lines 123, 124, 131, 132, 153, 197, 198), `scripts/test_restock_tenant2_split.js` (79, 137, 167) and `database.js` (832, and a comment at 5971).

**`restock_orders` as a table:**

| File | Line | What it does | Breaks on a status change? |
|---|---|---|---|
| `routes/admin.js` | 108 | `{ tbl: 'restock_orders', col: 'created_by', label: 'restock' }` — a user-deletion sweep | No — status-blind |
| `routes/admin.js` | 248 | table name in a tenant-clone / reset list | No |
| `routes/ai.js` | 2491 | `restock_orders_total: cnt('SELECT COUNT(*) …')` — a bare count for the AI context | No |
| `database.js` | 816-832, 5946-5994 | the migrations themselves | No |
| `reference/roots_v1.html` | — | the archived v1 app | No — reference only, not served |

**Front ends that call `/api/restock`:** `public/app.html`, `public/kitchen.html`, `public/login.html`. `public/m.html` — the mobile app — **does not touch restock at all**, which contradicts the brief's expectation that the mobile app is a reader.

**Where the status literals actually live, and this is the exposure:**

- `public/kitchen.html:869` — `'received'` drives a row background colour
- `public/kitchen.html:1170-1172` — status pills for `sent` / `received` / `prepared`
- `public/kitchen.html:1213` — `o.status !== 'prepared'` gates a bulk-check affordance
- `public/kitchen.html:1238` — `const canCheck = o.status === 'sent' || o.status === 'received'`
- `public/kitchen.html:1247, 1249, 1283, 1296, 1314` — transition buttons and their guards
- `public/app.html:19190-19205, 19255, 19264, 19344` — the store-side and warehouse-side views, including `isWh && (status === 'received' || status === 'prepared')` gating the "Prepared 备货" column

**`public/app.html:18333`** is the one row-level reader of provenance: it renders a ledger line's `ref_table === 'restock_orders' && l.ref_id` as `RS #…`. **That branch is dead today** — per A0.1 `ref_id` is never written and `ref_table` is always `'retail_store_stock'`. Filling those columns (B4) would bring an existing, already-written UI affordance to life rather than requiring new front-end work.

**Conclusion for B1: every status reader is a front-end string comparison against the five existing values.** There is no server-side consumer to break. That is precisely why B1 refuses to redefine any of the five.

---

## A8. The recipe screen's "Makes" field — surveyed 2026-09-03, and it partly corrects A5

**Why this section exists.** The Tacet recipe screen shows a **Makes** line naming the recipe's output directly — *"Makes Choco-Hazel Bars 120g"* — with a second line reading *"Also stocked as a material: Choco-Hazel Bars — ¥0.1113/g"*. A5 said no recipe→product mapping pointing that direction existed. **Both are true, and the reason they are both true is the finding.**

**First, a correction to the premise this survey was commissioned with: it is not the kitchen app's screen.** `Makes` / `产出` appears in exactly one place in the repository — `public/retail-admin/19-recipes.js`, the **Tacet retail-admin** recipes screen (`:1149` for one product, `:1157` for the header of several). Neither `public/app.html` nor `public/kitchen.html` renders it.

### A8.1 — What "Makes" is: a rendered reverse lookup, not a stored field

**No table and no column stores it.** There is no `makes`, no `output_product_id`, nothing of the kind. The line is built from a query run at read time, `routes/retail-recipes.js:278-293`:

```sql
SELECT sp.id, sp.name_en, sp.name_cn, sp.weight AS size, sp.sell_price, sp.unit_cost, …
  FROM store_products sp
 WHERE sp.recipe_id = ? AND COALESCE(sp.is_active,1) = 1
 ORDER BY sp.name_en COLLATE NOCASE, sp.id
```

**That is precisely the reverse lookup A5 named** (`SELECT id FROM store_products WHERE recipe_id = ?`), shipped and rendering. The client (`19-recipes.js:1133` `productsHtml()`) receives it as the array `_rec.products`.

**The screen cannot write it, deliberately.** `19-recipes.js:1099-1102`:

> *"The reverse of the product editor's 'From recipe' note (that one names the recipe from the product; this names the products from the recipe). **READ ONLY — the link is owned and edited on the product side. Nothing here writes it, and there is deliberately no affordance to.**"*

`routes/retail-recipes.js:258` repeats it: *"owned and edited on the product side, never here."*

**The one client-reachable write is on the product side** — `PUT /api/retail-admin/products/:id/recipe-link` (`routes/retail.js:21333`), which runs `UPDATE store_products SET recipe_id = ?` (`:21349`) and fires the cost recompute. Its own header (`:21316-21326`) is worth quoting, because it answers a question A5 left hanging — whether the 36 ambiguous pairs could be resolved at all:

> *"`store_products.recipe_id` was first filled by the one-time link pass in database.js, which links only where two of {SKU, name_en, name_cn} agree exactly and leaves everything weaker 'for Ash to confirm by hand' — but **nothing in the app could write that column**, so **45 active products sit beside a same-SKU recipe with no way to connect them**… The rule is right to be strict; what was missing is the door. **This is that door.**"*

**Two different figures are now on record and this document does not reconcile them:** the migration's **36** group-B pairs (`database.js:4582`, one signal only, all SKU-only) and this endpoint's **45** active products beside a same-SKU recipe. They are different measurements taken at different times and neither is stated to be a subset of the other. **Do not treat them as the same number.**

### A8.2 — What it points at, and what enforces it

| | Points at | FK | Unique | Writable from |
|---|---|---|---|---|
| `store_products.recipe_id` | a `store_products` row → `recipes.id` | **NONE** | no | `PUT /api/retail-admin/products/:id/recipe-link` |
| `products.recipe_id` (kitchen) | a `products` row → `recipes.id` | **`FOREIGN KEY (recipe_id) REFERENCES recipes(id)`** (`schema.sql:171`) | no | kitchen product editor (`routes/products.js:373`) |
| `ingredients.source_recipe_id` | an `ingredients` row → `recipes.id` | **`INTEGER REFERENCES recipes(id)`** (`database.js:673`) | **YES — partial unique** | not client-reachable; `ensureMaterialized()` only |

**The store-side link has no foreign key, and that is deliberate rather than an oversight.** `database.js:4331-4332`, describing how `store_products` was created by cloning `products`' column list: *"The only dropped constraint is the inline FK to recipes(id) — the store has no recipes."* `foreign_keys = ON` globally (`database.js:28`), so the kitchen link is enforced by the engine and **the store link — the one "Makes" reads — is not.**

**The material link is the only one of the three that is unique**, via `idx_ingredients_source_recipe` (`database.js:674-676`), `CREATE UNIQUE INDEX … ON ingredients(source_recipe_id) WHERE source_recipe_id IS NOT NULL`, whose own comment reads *"A recipe backs at most one material — the partial unique index (below) enforces 'one record, one identity' rather than leaving it a convention."*

### A8.3 — Cardinality: a recipe can already name several products, today

**In the schema:** `store_products.recipe_id` carries **no `UNIQUE` index** (grep confirms none anywhere), so any number of products may point at one recipe.

**In the UI:** the screen already handles it. `19-recipes.js:1148` branches on `rows.length === 1` — one product renders an identity line, **several render a table with a per-product Sells and Margin column.** `routes/retail-recipes.js:269-271`: *"Priced per ROW and never blended. One recipe can feed a 150g bag and a 25g sample at different prices; a single averaged margin across them would be a number that is true of neither."*

**So the premise that this screen supports exactly one output per recipe is not correct, and D6 should be read against what is actually there** — see A8.6.

**The reverse is impossible: two recipes cannot claim the same output.** `recipe_id` is a single scalar column on the product row, so a product has at most one recipe. The many-ness runs one way only — one recipe → many products.

### A8.4 — The size figure: freeform text, connected to nothing

**`120g` is `store_products.weight`, aliased `size` by the query.** Inherited from `products.weight`, declared at `schema.sql:158`:

```sql
weight          TEXT,                  -- freeform: "150g", "1 pc", "200ml"
```

**It is a display string. It is not a serving size, not a unit weight, not a pack size, and not a number.** Nothing parses it and nothing computes with it — `19-recipes.js:1142` renders it verbatim (`size = p => p.size ? … esc(p.size) : ''`).

**It has no relationship whatever to `recipes.batch_size` (`REAL`, *"total grams per batch"*), `recipes.servings` (`INTEGER`) or `recipes.serving_size` (`REAL`, *"grams per serving"*)** — `schema.sql:92-94`. The only bridge between a recipe's yield and a sellable unit anywhere in the system is an **assertion, not a column**: `lib/recipe-rollup.js` writes `store_products.unit_cost` as `costPerServing` on the stated rule *"one serving is one sellable unit"*. **That assertion is exactly P2**, and A8 does not weaken it — reading `"120g"` next to a product name may look like the missing unit, and it is not one.

### A8.5 — "Also stocked as a material": two records, no join between them, and only one of them can hold stock

**They are two separate records.** The sellable is a `store_products` row; the material is an `ingredients` row, fetched at `routes/retail-recipes.js:165` — `SELECT id, name_en, cost_per_unit, unit, source_recipe_id FROM ingredients WHERE source_recipe_id IN (…)` — and returned as `backsMaterial` (`:204`, `:301`).

**Nothing links them to each other.** They are siblings, not relatives: both point at the same `recipes.id`, one through `store_products.recipe_id` and the other through `ingredients.source_recipe_id`. **There is no column joining a product to its material**, and no query in the repository joins the two except through the recipe.

**The material row is auto-maintained from the recipe, never authored.** `ensureMaterialized(db, recipeId)` (`lib/recipe-materialize.js:225`) runs on recipe create (`routes/retail-recipes.js:330`) and update (`:379`), mirroring `name_en`, `name_cn` and `sku`. A **repack** is deliberately excluded — *"a one-line recipe needs no material of its own, and must not be given one."*

**What keeps their stock numbers from disagreeing: nothing — and nothing has to, because a material has no stock at all.** No stock column on the master, no material stock table:

- `routes/retail-purchasing.js:217` — *"Materials have no stock table (§28) — a material line's 'receiving' is the price write-back…"*
- `routes/retail-waste.js:365` — refuses material waste outright: *"Material waste is not available yet. Materials have no stock to move, so a material loss cannot be recorded as a stock movement."*
- §31 rule 6 and §32's addendum record this as **a decision, not a gap**, which means it cannot be treated as an oversight to patch around.

**So on a produced batch, only the product side can increment. The material side has nowhere to put a quantity.**

**AND THAT IS A LIVE PROBLEM FOR D6, not a curiosity.** §29's addendum records the actual kitchen behaviour, confirmed directly rather than inferred (`docs/tacet-consolidation-decisions.md:4258-4260`):

> *"a batch is part-sold as retail units in serving-sized containers, and **part-held in bulk for later use as a material**. The bulk half goes into reused kitchen tubs…"*

**D6 rules that a batch records what came out of it per product. The bulk half of exactly the split D6 exists to capture cannot be recorded, because its destination has no stock.** A batch that yields 40 bars and 3kg of bulk can record the 40 and must silently drop the 3kg. **This is not solved by the batch-output link table** — it is blocked on material stock, which §32's addendum states is its own decision and *"must not be smuggled into"* another build. See B6.1, where it is now the second gate.

### A8.6 — What this does and does not change about A5

**A5's factual claims all stand.** There is no recipe→product column; `store_products.recipe_id` is product→recipe, non-unique, partial by design; `products.recipe_id` is documented as wrong data; no `product_recipes` join table exists; no `recipes.product_id` column exists. **A8 contradicts none of that.**

**What A5 understated is how much of the reverse direction is already built and load-bearing.** A5 presented `SELECT id FROM store_products WHERE recipe_id = ?` as the reverse lookup one *would* have to do, and concluded *"production-to-stock cannot be built on it as it stands"*. In fact that query is **shipped, rendered on the recipe screen, filtered for active rows, ordered, and consumed by the cost cascade** — and since the recipe-link endpoint exists, the column is **writable by hand**, which A5 did not establish. A recipe→products *set* is a solved problem.

**What remains genuinely missing is narrower than A5 implied, and is not a mapping problem at all:**

1. **Quantities per batch.** `store_products.recipe_id` says *this recipe can produce this product*. It cannot say *this batch produced 40 of it*. That is D6's link table and no reverse lookup substitutes for it.
2. **Data quality.** The link is partial by design and unenforced on the store side; the 36 group-B pairs and the endpoint's 45 same-SKU products are unresolved, and per §29's addendum nobody may resolve them by inference.
3. **The material half of a split batch has no destination** (A8.5).

### A8.7 — What reads the link, beyond display

**It is load-bearing for costing, not decoration:**

- `lib/recipe-rollup.js:374` `loadLinkedProducts()` — `SELECT id, name_en, sku, unit_cost, recipe_id FROM store_products WHERE recipe_id IS NOT NULL AND COALESCE(is_active,1) = 1`; the cascade writes `store_products.unit_cost` from `costPerServing` for every row it returns. `routes/retail-recipes.js:262-264` notes the recipe screen deliberately uses **the same `COALESCE(is_active,1) = 1` filter** so *"the header can never advertise a product the rollup would not write to."*
- `routes/retail-product-build.js:114` reads it when a product gains a build list — after which, per §31's addendum, `recipe_id` is no longer that product's cost source (`19-recipes.js` carries `build_line_count` for exactly this reason, `retail-recipes.js:280-289`).
- `routes/retail.js:21276-21277`, `:21380-21381` join it for display; `:21349` writes it and fires `fireRecompute`.
- **Channel sync does not read it** — Meituan/Eleme/Guanyi push stock and price, not recipe links.

### A8.8 — Population: CANNOT BE ANSWERED FROM THIS REPOSITORY

**There is no database in this checkout at all.** `data/*.db` is gitignored (`.gitignore:13-17`) and no file is present — A6 recorded a scaffold `data/roots.db` with zero recipes; there is now not even that. **Every count below is unknown here and must be taken on the box.** Queries for Ash, on the tenant database:

```sql
-- 1. How many recipes name at least one product ("Makes" renders), and how many do not.
SELECT (SELECT COUNT(*) FROM recipes WHERE COALESCE(is_active,1)=1)                     AS active_recipes,
       (SELECT COUNT(DISTINCT sp.recipe_id) FROM store_products sp
         WHERE sp.recipe_id IS NOT NULL AND COALESCE(sp.is_active,1)=1)                 AS recipes_with_a_product,
       (SELECT COUNT(*) FROM ingredients WHERE source_recipe_id IS NOT NULL)            AS recipes_backing_a_material;

-- 2. The multi-output population — the recipes D6 is actually about.
SELECT sp.recipe_id, COUNT(*) AS products, GROUP_CONCAT(sp.name_en, ' | ') AS names
  FROM store_products sp
 WHERE sp.recipe_id IS NOT NULL AND COALESCE(sp.is_active,1)=1
 GROUP BY sp.recipe_id HAVING COUNT(*) > 1
 ORDER BY products DESC;

-- 3. Both outputs at once: a recipe that makes a sellable product AND backs a material.
--    These are the split batches of §29's addendum, and the ones A8.5 cannot fully record.
SELECT r.id, r.name_en,
       (SELECT COUNT(*) FROM store_products sp WHERE sp.recipe_id = r.id AND COALESCE(sp.is_active,1)=1) AS products,
       (SELECT i.id FROM ingredients i WHERE i.source_recipe_id = r.id)                                  AS material_id
  FROM recipes r
 WHERE COALESCE(r.is_active,1)=1
   AND (SELECT COUNT(*) FROM store_products sp WHERE sp.recipe_id = r.id AND COALESCE(sp.is_active,1)=1) > 0
   AND (SELECT i.id FROM ingredients i WHERE i.source_recipe_id = r.id) IS NOT NULL;

-- 4. Dangling store-side links — no FK enforces this one (A8.2).
SELECT sp.id, sp.name_en, sp.recipe_id
  FROM store_products sp
 WHERE sp.recipe_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM recipes r WHERE r.id = sp.recipe_id);

-- 5. Do the two product-side links agree where both exist? (A5's "wrong data" claim, measured.)
SELECT COUNT(*) AS both_set,
       SUM(CASE WHEN sp.recipe_id = p.recipe_id THEN 1 ELSE 0 END) AS agree
  FROM store_products sp JOIN products p ON p.id = sp.kitchen_product_id
 WHERE sp.recipe_id IS NOT NULL AND p.recipe_id IS NOT NULL;

-- 6. The unresolved hand-link backlog (the 36 / 45 figures of A8.1).
SELECT sp.id, sp.name_en, sp.sku, r.id AS recipe_id, r.name_en AS recipe_name
  FROM store_products sp JOIN recipes r ON r.sku = sp.sku
 WHERE sp.recipe_id IS NULL AND COALESCE(sp.is_active,1)=1 AND COALESCE(r.is_active,1)=1;
```

---

# PART B — PROPOSAL

## B1. Status model — keep the request lifecycle, add a goods lifecycle beside it

**Adopting the brief's starting proposal.** The survey supports it rather than contradicting it, for a reason worth stating: A7 shows that all five status values are consumed by front-end string equality in two large HTML files, and A1 shows the warehouse's own picking affordance is gated on `sent`/`received`. Redefining any existing value would silently change what a picker can do, in files with no tests over them.

```
REQUEST lifecycle   restock_orders.status       draft → sent → received → prepared → delivered
                    (unchanged, all five values keep their present meaning)

GOODS lifecycle     restock_orders.goods_state  none → in_transit → settled
                    (new column, new vocabulary, no overlap with the above)
```

- **`none`** — nothing has left the warehouse. Every existing row starts here.
- **`in_transit`** — the OUT half has been written. Units belong to no location.
- **`settled`** — the IN half has been written at the counted quantity. The transfer is closed.

**Which transition fires which half.** The outbound half moves from `prepared` — where it already is (A1) — and the inbound half fires on a **new, separate endpoint**, not on a status transition:

| Event | Request status | Goods state | Stock |
|---|---|---|---|
| warehouse packs | → `prepared` | `none` → `in_transit` | **OUT only**, at `qty_sent` |
| driver hands off | → `delivered` | unchanged | **none** — see below |
| store confirms receipt | unchanged | `in_transit` → `settled` | **IN only**, at `qty_received` |

**`delivered` stops moving stock, and that is the one behavioural change to an existing transition.** Today it re-runs `_applyRestockTransfer` as a "safety net" (`routes/restock.js:712`). Under two steps that net is wrong: `delivered` means the driver handed the boxes over, which is not the same event as someone counting them. It becomes a pure request-lifecycle transition. The safety net is not lost — it moves to the receipt endpoint's own idempotency guard (B2).

**Why a separate endpoint rather than a sixth status.** `receipt_confirmed` as a sixth `STATUS_FLOW` value was considered and rejected: `toIdx <= fromIdx` (line 702) makes the flow strictly ordered, so a store confirming receipt before the warehouse marked `delivered` would be refused — and at Roots the driver marking `delivered` and the store counting are genuinely concurrent. **A strictly-ordered request lifecycle cannot express two lifecycles that interleave.** That is the failure mode the brief names, arrived at from the other direction.

**The two lifecycles are readable apart** because they are two columns with disjoint vocabularies. No value of one can be mistaken for a value of the other.

---

## B2. Columns

All additions via the existing `addColumn()` helper in `database.js` — an idempotent `ALTER TABLE ADD COLUMN` — so nothing needs a table rebuild. All are nullable with no default, or defaulted where a backfill value is honest.

**`restock_items`**

| Column | Type | Null | Meaning |
|---|---|---|---|
| `qty_received` | `REAL` | **nullable, no default** | What the store counted. |

**NULL versus zero, which the brief is right to insist on:**

- **NULL = nobody has counted this line yet.** The line is outstanding. It is the state every line is in between dispatch and receipt, and the state a resumed count leaves untouched lines in (`Resume.dc.html` in the design set).
- **0 = someone counted, and found none.** A real observation with a real consequence: nothing lands on the shelf for that line and the whole dispatched quantity is a discrepancy.

Conflating them would make an uncounted delivery indistinguishable from a delivery that entirely failed to arrive — and `Main.dc.html`'s inactive `Confirm receipt` button, whose only explanation is "4 of 14 lines counted", is built directly on the distinction.

This mirrors `qty_sent`'s existing NULL-means-not-overridden convention (A2), which is why `REAL` rather than `INTEGER` — matching its neighbours matters more than being right about a type both of them already get wrong (A0.3, Q4).

**`restock_orders`**

| Column | Type | Null | Meaning |
|---|---|---|---|
| `goods_state` | `TEXT` | `DEFAULT 'none'` | `none` \| `in_transit` \| `settled` — B1 |
| `dispatched_at` | `DATETIME` | nullable | OUT half written. **The idempotency guard for the outbound half.** |
| `received_confirmed_at` | `DATETIME` | nullable | IN half written. **The idempotency guard for the inbound half.** |

**D2 ADDS A REQUIREMENT THIS TABLE DID NOT ANTICIPATE, and it falls out of the NULL-versus-zero distinction above.** An auto-settled line has `qty_received` **written** — to the sent quantity — so the moment the sweep runs, an unverified line becomes byte-identical to one a person counted. That collapses exactly the distinction this section is built on, in the one case where it matters most. **D2's "permanently marked, never indistinguishable" therefore cannot be carried by `qty_received` and needs its own column** — a nullable `auto_settled_at DATETIME` on `restock_items` is the smallest thing that works, and being a timestamp rather than a flag it also answers *when*, which the repeat-offender safeguard needs. The three line states then read cleanly: `qty_received IS NULL` = outstanding; set with `auto_settled_at IS NULL` = **counted by a person**; set with `auto_settled_at` non-NULL = **assumed by the system, never verified.** Per D0, only the middle one may ever be treated as the counter's number.

`goods_state` is derivable from the two stamps and is stored anyway — it is the column every list query filters on, and a stored enum indexes where a `CASE` over two timestamps does not. The stamps remain the authority; `goods_state` is written in the same transaction and never independently.

**`stock_applied_at` is kept, and frozen.** No new code reads or writes it. It stays because it is the only record that a pre-migration order moved its stock under the old one-step model, and B8 uses it to decide what an in-flight order becomes. Its `database.js:827-832` comment gains a note saying it is historical.

**Nothing is added for the two yardsticks.** `qty_requested`, `qty_sent` and `qty_received` on one row are sufficient — see B5.

---

## B3. In-transit — derived, not stored

**Agreeing with the brief, and more strongly than it puts it.** In-transit is:

```sql
SELECT ri.product_id, SUM(COALESCE(ri.qty_sent, ri.qty_requested)) AS qty_in_transit
  FROM restock_items ri
  JOIN restock_orders ro ON ro.id = ri.restock_id
 WHERE ro.goods_state = 'in_transit'
   AND ri.product_id IS NOT NULL
 GROUP BY ri.product_id
```

A stored counter would be a third place a quantity lives, incremented by one code path and decremented by another hours later, with a crash between them leaving it wrong forever and nothing to reconcile it against. The derived form **cannot** disagree with the rows it is derived from.

Cost: one indexed join per read, over rows whose count is bounded by orders currently on a van — at Roots, single digits. `idx` on `restock_orders(goods_state)` is added with the column.

**No pseudo-location.** A `retail_stores` row called "In transit" was considered and rejected: it would appear in every store picker, every stock report and every channel-availability sweep, and `_resolveDestStoreId` (`routes/restock.js:230-233`) already falls back on "exactly one active store that isn't the warehouse" — a rule a phantom store silently breaks. §39 says in-transit stock belongs to **neither** location, and a row in the locations table is a location.

**Where in-transit is not derivable, and the honest limit:** if an order is edited after dispatch — a line deleted, a `qty_sent` changed — the derived total changes retroactively while the ledger's OUT rows do not. This is not a reason to store a counter; it is a reason to **refuse edits to `restock_items` once `goods_state != 'none'`**, which B8 includes as a guard.

---

## B4. Ledger — no new reasons, one real change

**Confirmed: `restock_transfer_out` and `restock_transfer_in` are sufficient.** They already name the two halves separately (`routes/restock.js:352`, `358`); the only thing that changes is that they are written hours apart. A reason names *what kind of movement this was*, and neither half's kind has changed. Inventing `restock_dispatch` / `restock_receipt` would orphan every existing row.

Checked against every reason in use: `restock`, `restock_transfer_out`, `restock_transfer_in`, `restock_undo` (`routes/retail-purchasing.js:369`), `waste`, `repack`, `undo_preparing`, `undo_fulfillment`, `qingyun_pickup`, `qingyun_dropoff`. No collision.

**The real change is provenance, and it is a prerequisite, not a nicety.** Per A0.1, `adjustStock` hardcodes `ref_table='retail_store_stock', ref_id=NULL`. **`adjustStock` must accept `refTable` and `refId` and write them**, defaulting to today's literals so no existing caller changes behaviour. Without it:

- the receipt path cannot verify from the ledger that the OUT half was written;
- a reconciliation between derived in-transit (B3) and the ledger is impossible;
- `public/app.html:18333`'s `RS #…` rendering stays dead.

This is a change to `lib/inventory.js`, which is the file the constraint "all stock writes go through the ledgered path" protects. It **widens the ledgered path's record-keeping without adding a writer**, which is the letter and the spirit of the constraint — but it is a change to shared inventory code and is flagged as such in B8's ordering.

**Also required here: A0.2's zero clamp.** `Math.max(0, oldQty + deltaQty)` must stop silently absorbing an over-decrement.

> ~~Recommendation: `adjustStock` gains a `refuseNegative` option that **throws** rather than clamping, and the restock OUT half passes it — so a dispatch exceeding warehouse stock rolls the whole transfer back and reports it, exactly as `_checkTransferIds` failures already do. Defaulting it off leaves every other caller unchanged. **This is a behaviour change to a live path and needs Ash — see Q3.**~~

**WITHDRAWN — Ash ruled the other way on 2026-09-03, see D1.** A dispatch is **never** blocked by the record: a picker who physically finds 50 on a shelf showing 20 sends 50 and the warehouse goes to −30. So the clamp is **deleted outright**, not made conditional, and no `refuseNegative` option is added. The reasoning is that refusing defends a number already known to be wrong, and a visible −30 is a truer record than a silent zero. **Q3 is answered; the strikethrough above is left in place so a later reader meets the rejected proposal rather than re-inventing it.** D1.1 lists which callers this actually reaches, and PART E the debt it leaves.

---

## B5. The two yardsticks — supported, with one arithmetic rule

Per line, after receipt:

| Gap | Computation | Owner |
|---|---|---|
| **counted vs sent** (the road) | `qty_received − COALESCE(qty_sent, qty_requested)` | transit |
| **counted vs asked** (the warehouse) | `qty_received − qty_requested` | allocation |
| *(allocation gap alone)* | `COALESCE(qty_sent, qty_requested) − qty_requested` | warehouse, visible before dispatch |

All three come off one row of `restock_items` with no joins and no aggregation. `Received.dc.html` renders exactly `asked 18 · sent 14 · counted 10` from `qty_requested`, `qty_sent`, `qty_received`.

**Can this disagree with the ledger? Only in one way, and it is closable.** The IN half writes `qty_received` and the OUT half writes `COALESCE(qty_sent, qty_requested)`, so:

- **counted vs sent is exactly the ledger's own arithmetic** — `ledger IN delta + ledger OUT delta` for that product and transfer equals the same number. Given B4's `ref_id`, this is checkable by query rather than by trust.
- **counted vs asked has no ledger counterpart**, because `qty_requested` never moves stock. It is a fact about the request, not about goods. It cannot disagree with the ledger because the ledger makes no claim about it.

**The rule that keeps them honest: the ledger is written from the same column the screen reads, in the same transaction, and neither is recomputed afterwards.** Concretely — the IN half's `deltaQty` must be `qty_received` read back from the row it just wrote, not a value carried in from the request body. Same discipline the OUT half already keeps with `qty_sent`.

**One case the columns do not cover**, and it should be named rather than discovered: a line dispatched but *absent* from the delivery entirely — not "counted zero", but never counted. `qty_received` stays NULL and the line never settles. Under B1 the order cannot reach `settled` while any line is NULL, which is correct (`Main.dc.html`'s inactive button says so) but means an abandoned count leaves an order stuck `in_transit` forever, holding phantom in-transit stock. ~~**This needs a decision — Q2.**~~

**ANSWERED by D2**: at the end of the trading day the sweep settles those lines at the sent quantity and stamps `auto_settled_at`, so the order reaches `settled` and stops holding phantom in-transit stock. **The yardsticks above still work on such a line, and must be read with D0 in mind:** its "counted vs sent" gap computes to exactly zero — not because the delivery was perfect but because nobody looked, which is why the stamp and not the arithmetic is what tells them apart. **Any screen showing a gap on an auto-settled line must show the mark beside it**, or it reports a verified match where none happened.

---

## B6. Production — scoped separately, as the brief instructs

**Per A5, the recipe-to-product mapping does not exist in a usable form, so this is a prerequisite piece of work and not part of the stock-movement migration.** Scoped here, not planned in detail, and not to be started alongside B1-B5.

~~**Prerequisite P1 — a recipe → product link that is single-valued and explicit.** The options, for a separate brief to choose between: a `recipes.output_product_id` column; a `UNIQUE` index on `store_products.recipe_id`; a `recipe_outputs` join table, if one recipe genuinely yields several products in one run. The third is the only one that survives a recipe producing both a 200g and a 500g jar, and nothing in the survey tells us whether Roots does that. **That question is Ash's — Q5.**~~

**RESOLVED 2026-09-03 by D6: Roots does that, so the third option wins and the first two are withdrawn** — both encode "one recipe, at most one product", which is now known to be false. **The link must be single-valued in neither direction.** What follows is no longer a choice between shapes; it is an ordered piece of work.

### B6.1 — production wiring, in order, as its own brief

**This is clearly larger than a column addition, and stating that plainly is the point of this section.** Four pieces, in this order, none of which can usefully start before the one above it:

> **RE-SCOPED 2026-09-03 after the A8 survey.** Step 1 below was written believing the recipe→product direction had to be built. **It does not: it exists, it ships, and it is read by the cost cascade** — A8.1. **Step 1 shrinks from "build a mapping" to "finish the data and decide whether to enforce it", which is much smaller.** What did NOT shrink, and what A8 added, is set out under *What step 1 actually is* below. The original text stands; the estimate attached to it was wrong.

**1. A recipe → product mapping that points the right way.** This is the prerequisite and it is where the difficulty is. Today:

- `store_products.recipe_id` is **product → recipe** — the wrong direction for "what can this batch produce", which must ask recipe → products;
- it carries **no `UNIQUE` index**, and under D6 it must not gain one;
- it is **partial by design** — `store_products_recipe_link_v1` links only where two of three signals agree, so a recipe someone produces today may have no product at all;
- the kitchen-side `products.recipe_id` is **documented as wrong data by that same migration**, which refuses to use it as a signal and cites product 23 "81% Hazel Chocolate Spread" pointing at recipe 46 "Pickle carrot（Do chua）" — *"one bad row in four is not a signal"*.

**Neither column supports asking what a batch can produce, and no amount of indexing makes them.** A5 has the full survey.

**A SECOND GATE, FOUND BY A8 AND NOT PREVIOUSLY ON THIS LIST: the material half of a split batch has nowhere to go.** §29's addendum records that a Roots batch is *"part-sold as retail units… and part-held in bulk for later use as a material"*. **A material has no stock** — no column on the master, no material stock table, and §31 rule 6 / §32's addendum record that as a decision rather than a gap (A8.5). So a batch yielding 40 bars and 3 kg of bulk **can record the 40 and must silently drop the 3 kg.** D6's output lines name products; the material half is unrepresentable. **This is not solved by the batch-output table and must not be worked around inside it** — §32's addendum states material stock is its own decision and must not be smuggled into another build. **Either production ships knowingly recording only the sellable half, or material stock is decided first. That is Ash's call and it is not made here.**

**2. The batch output table.** One row per (batch, product, quantity) — D6's link table. `production_batches` gains no product column.

**3. The UI for entering a split, with the one-line pre-fill.** D6: the general shape, with the single-product case pre-filled to one confirm. One code path.

**What the screens actually need, after A8 — less than assumed for viewing, and all of the writing.** The brief for this survey assumed the recipe screen supports exactly one output per recipe. **It does not: it already renders several** (`19-recipes.js:1148` branches one-line vs. a per-product Sells/Margin table, and the server orders and filters the set — A8.3). So the *display* of a multi-output recipe is built. What is missing is everything that writes and everything about quantity:

- **A batch-logging surface that takes a split.** Nothing today captures a per-batch quantity per product; `production_batches` has `batches_made` and `servings_made` and no product dimension at all.
- **The one-line pre-fill**, drawn from the recipe's existing product set — which A8.1 confirms is a query that already exists and is already exposed on the recipe endpoint. **Offered for confirmation, never committed unconfirmed** (D6).
- **A write affordance for the link on the recipe side, or a deliberate decision to keep it product-side.** The recipe screen is read-only *by design* (`19-recipes.js:1101`: *"there is deliberately no affordance to"*), and the only door is the product editor, one product at a time. **Setting up a recipe that makes four products means opening four product editors.** That is fine for a rare edit and poor for onboarding a tenant; it is a UX decision, not a schema one, and it should be taken knowingly rather than inherited.
- **Nothing in the material line.** `backsMaterial` is auto-maintained and carries no quantity; per the second gate above, it is not part of this UI until material stock is decided.

**4. The stock increment itself.** Per output line, at the configured output location, through `adjustStock`, one ledger row per product, guarded by a `stock_applied_at`-style stamp on `production_batches`.

**What step 1 actually is, after A8.** Not a new mapping. Three things, none of which is a schema build:

- **Finish the data.** The link is partial by design; the 36 group-B pairs and the recipe-link endpoint's 45 same-SKU products (two different figures — A8.1 — which must not be assumed to be the same set) are unresolved. **The door to resolve them by hand already exists**: `PUT /api/retail-admin/products/:id/recipe-link`. This is data entry with a human, not development.
- **Decide whether the store-side link gets a foreign key.** `store_products.recipe_id` has none, deliberately (A8.2), while the kitchen twin does and `foreign_keys = ON`. Query 4 in A8.8 measures whether anything is already dangling. **A decision, not a defect** — but production would be the first feature to depend on that column being sound.
- **Do NOT add a `UNIQUE` index to it.** D6 forbids it, and A8.3 confirms the non-uniqueness is already exercised: the recipe screen renders a multi-product table today.

**THE GATE ON STEP 1, AND NOBODY MAY GUESS PAST IT.** `store_products_recipe_link_v1` deliberately left **36 ambiguous pairs** unlinked — one signal only, all SKU-only — **for Ash to confirm by hand.** Those 36 are a data question, not a schema question, and §29's own addendum already established the rule for exactly this situation: no automatic signal is trustworthy as a silent discriminator, migration tooling must surface each candidate for a person to confirm, and **must not act on its own judgement.** **Step 1 cannot be called done while they are open, and no session may resolve them by inference.** They are Ash's.

**Prerequisite P2 — units.** `production_batches` records `batches_made` (a multiplier on `recipes.batch_size`) and `servings_made`. `store_products_recipe_link_v1` asserts one serving is one sellable unit, but only for the products it costed. Whether that holds generally is unestablished. Without it, "increment stock by N" has no N.

**The mechanics of step 4 are small and follow the shape B1-B5 establishes**: logging a batch calls `adjustStock` at `cfgValue('production.outputStoreId')` with a new reason `production_output`, `refTable='production_batches'`, `refId` the batch id, guarded by a `stock_applied_at`-style stamp on `production_batches`. **Under D6 that is once per output line rather than once per batch.** §39's "closes off the request that asked for it" is a second link — `production_batches` has no column pointing at the `restock_orders` row that prompted it — and is part of the same separate brief.

**PRODUCTION STAYS OUT OF SCOPE FOR THE STOCK-MOVEMENT MIGRATION. It is its own piece of work, with its own brief, sequenced after the two-step transfer ships.** Not because the two conflict — they do not, and B1-B5 depends on none of it — but because step 1 alone carries an open data question that is Ash's to answer, and attaching that to the transfer migration would hold a shippable change behind an unrelated decision. **The dependency runs one way only: production needs nothing from B1-B5 except the provenance change in B4, which ships as Step 1 of the migration regardless.**

---

## B7. Warehouse and output location as real settings

Replace `_resolveWarehouseStoreId()`'s three tiers (`routes/restock.js:177-206`) with a single read:

```js
const id = cfgValue('stock.warehouseStoreId', null);
```

**Tier 1** (`settings` table) becomes this read — same intent, a table that exists.
**Tier 2** (a warehouse-role user's bound store) is dropped. It reaches across the control/data plane, taking a `retail_store_id` off control-plane `users` and using it as a tenant `retail_stores.id` — the file's own comment flags this at lines 190-193.
**Tier 3** (whichever store holds the most stock) is dropped, and the brief's objection is right: the day a second warehouse exists it silently picks whichever happens to be fuller, and nothing on any screen says a guess was made. It is also wrong *before* that day — a store that has just taken a large delivery can outweigh the warehouse.

**When the setting is unset, refuse and say so.** `_applyRestockTransfer` already has the shape for this — it returns `{ ok: false, error: … }` and `routes/restock.js:729` already puts that message in front of whoever pressed the button. The message names the setting rather than the failure.

`production.outputStoreId` is read the same way and defaults to nothing. §39 makes it per-tenant, and Roots' value happens to equal its warehouse — that is a value, not a default.

**D2 adds a third key: `stock.tradingDayEnd`** — the tenant's trading-day boundary (a local clock time plus a zone) that the auto-settle sweep acts on. It is per-tenant for the reasons D2 gives: the per-store hours columns are optional, routinely unset, and fall back to always-open, and no day-boundary calculation in this codebase reads a per-location zone today. **Unset must not mean "never settle"** — an unset boundary should fall back to a stated default (`lib/business-date.js`'s `SYSTEM_DEFAULT_TZ` is the existing precedent) rather than silently leaving transfers open forever, which is the failure D2 exists to end. **And per D3, the sweep must enter each tenant's scope before reading any of these three keys** — it is the one caller here that does not run inside a request.

**Backfill on migration**, for tenants that never had a setting: if exactly one active `retail_stores` row has `code LIKE '%warehouse%'`, write it and log it. Otherwise write nothing and log that the tenant must set it before restock can move stock. **Never guess by stock volume, even once.**

---

## B8. Migration order and in-flight handling

**Step 0 — re-take A6 against the real database.** Per A6 this repository has no live data. Before anything runs:

```sql
SELECT status, goods_state_would_be, COUNT(*) FROM (
  SELECT status,
         CASE WHEN stock_applied_at IS NOT NULL THEN 'settled' ELSE 'none' END AS goods_state_would_be
    FROM restock_orders
) GROUP BY 1, 2;

SELECT COUNT(*) FROM restock_orders WHERE status IN ('prepared','delivered') AND stock_applied_at IS NULL;
SELECT COUNT(*) FROM restock_items WHERE qty_sent IS NULL;
```

The second query is the one that matters: an order at `prepared` or `delivered` whose stock never applied is the case the backfill cannot classify honestly.

**Step 1 — `lib/inventory.js`: `adjustStock` accepts and writes `refTable` / `refId`** (B4), defaulting to today's literals. Ships alone, changes no behaviour, is independently testable. **Everything else depends on it.**

**Step 1b — the zero clamp comes out (D1), and it is GATED.** Deleting `Math.max(0, oldQty + deltaQty)` at `lib/inventory.js:1084` is one line, but it is **not a one-line change**, and it must not ship until all four of these land in the same step: **(a)** the clamp deletion itself; **(b)** the `d < 0` guard on `routes/retail-inventory.js:343`, or an explicit ruling that a kitchen delta may go negative; **(c)** a resolution of the PO-receiving downward correction (E2) — **which needs Ash and is the actual blocker, not an implementer's call** — together with the amendment to `docs/purchase-returns.md` item 3 that any resolution forces; and **(d)** the dashboard filter fix (E3), all four clauses, or a negative balance is true in the database and invisible on the screen built to surface exactly this. **Callers already carrying their own guard need nothing** (`retail-waste.js`, `retail-purchasing.js:366`). **The four channel ingest paths of E1 are explicitly NOT part of this step** and keep clamping; that is per-channel work with its own decisions.

**What this step blocks, and what it does not.** E2 is unresolved and is the gate on **this step alone**. **Every other step — 0, 1, 2, 3, 4, 5, 6, 7 — proceeds without it**, because none of them touches `applyReceivedToStock`. **The two-step transfer can therefore ship complete while the clamp is still in place.** What it cannot do is ship honest: until 1b lands, a dispatch exceeding warehouse stock still invents units (A0.2), and under two steps it does so with the two halves hours apart, which is harder to spot rather than easier.

Ordering note: this can ship **before or after** Step 1, and **preferably before Step 4** — the split transfer is where a dispatch first outlives its receipt by hours, and a clamp still in place at that point is A0.2 with a longer fuse. **That is a preference, not a dependency**: if E2 is still open when Step 4 is ready, Step 4 ships and 1b follows, rather than the migration waiting on a purchasing decision it has nothing to do with.

**Step 2 — columns.** `addColumn()` for `qty_received`, **`auto_settled_at`** (D2, per B2 — the mark that keeps an assumed line distinguishable from a counted one), `goods_state`, `dispatched_at`, `received_confirmed_at`, plus `CREATE INDEX idx_restock_goods_state ON restock_orders(goods_state)`. Pure additions; no rebuild; safe on a populated table. **Every existing row backfills `auto_settled_at` as NULL, which is correct** — no historical line was ever auto-settled, and NULL is exactly the claim "this was not assumed by the system".

**Step 3 — backfill `goods_state`**, guarded by `_migrations` (`database.js:192`, the established pattern):

| Existing row | `goods_state` | `dispatched_at` | `received_confirmed_at` | `qty_received` |
|---|---|---|---|---|
| `stock_applied_at` set | `settled` | ← `stock_applied_at` | ← `stock_applied_at` | **left NULL** |
| `stock_applied_at` NULL, status `prepared`/`delivered` | `none` | NULL | NULL | NULL |
| everything else | `none` | NULL | NULL | NULL |

**Two deliberate choices here.**

*Backfilled `qty_received` stays NULL even on settled orders.* Nobody counted those lines — the old model moved `qty_sent` and never asked. Writing `qty_received = qty_sent` would fabricate an observation, and every historical discrepancy report would then read "no gaps" for a period where gaps were simply never recordable. NULL on a settled order means *closed under the old model*, and any reader of `qty_received` must handle it.

*An order at `prepared` with `stock_applied_at` NULL becomes `none`, not `in_transit`.* Its stock genuinely never moved — that is what the empty stamp means — so it has nothing on a van. It is dispatchable again under the new model, which is the honest state. **This is the case Step 0's second query counts, and if it returns anything non-trivial it should be looked at by hand before the migration runs.**

**Step 4 — routes.** Split `_applyRestockTransfer` into `_applyDispatch` and `_applyReceipt`; `prepared` calls the first; `delivered` calls neither; a new `PUT /api/restock/:id/receive` calls the second. `_checkTransferIds` (A2) runs on **both** halves — the catalogue can drift between dispatch and receipt. Guard: reject `restock_items` writes when `goods_state != 'none'` (B3).

**Step 5 — `_resolveWarehouseStoreId` → `cfgValue`** (B7), with the single-warehouse backfill.

**Step 6 — front ends.** `public/app.html` and `public/kitchen.html` gain the receipt screen and read `goods_state`. No existing status literal changes (A7), so nothing already on screen breaks.

**Step 7 — the auto-settle sweep (D2), LAST and separable.** It cannot run before Step 4 (nothing is `in_transit` until dispatch and receipt are split) and it must not run before `auto_settled_at` exists, or it silently manufactures verified-looking lines — the one failure D2 is written to prevent. It needs the `stock.tradingDayEnd` key (B7), a tenant-scoped read per D3, and **its mandatory repeat-offender surface, which is part of the ruling and not a follow-up**: shipping the sweep without it is shipping the button D2 rejected. **Until this step lands, an abandoned count still strands a transfer `in_transit`** — the Q2 behaviour, unchanged and now merely time-boxed by intent rather than by code.

**What is reversible.** Steps 1, 2 and 3 are: added columns can be ignored, the backfill is derived entirely from `stock_applied_at` which is never modified, and it can be re-derived after a revert. **Step 4 is the point of no return** — once a dispatch has written an OUT half with no IN half, reverting to one-step code leaves those units nowhere. If Step 4 needs backing out, in-transit orders must be settled first.

SQLite adds no obstacle: every step is `ALTER TABLE ADD COLUMN`, `CREATE INDEX` or `UPDATE`. **No table rebuild, so none of `drop_created_by_user_fk_v1`'s machinery is needed.**

---

## B9. Test plan

Both suites use `scripts/test-support/tenant-fixture.js` — `harness()`, `openTenant()`, `inTenant()`, `seedProduct()`, `setShelf()`, `shelf()`, `ledgerFor()`, `callRoute()`, `stubAuth()`, `captureNotifications()` — run under one `npm run test:stock-movement`, alongside the existing `test:restock-handles`.

**Tenant 1 (`scripts/test_stock_two_step.js`)**

| # | Assertion | Fails on today's code because |
|---|---|---|
| 1 | `prepared` decrements the warehouse and **leaves the destination unchanged** | today both halves fire together; destination is already incremented |
| 2 | after `prepared`, `goods_state = 'in_transit'` and `dispatched_at` is set | column does not exist |
| 3 | derived in-transit for the product equals `qty_sent` | no query to derive |
| 4 | `delivered` moves **no** stock | today it re-runs the transfer (no-op only via the stamp) |
| 5 | receipt at `qty_received < qty_sent` increments the destination by **`qty_received`** | no receipt path; destination got `qty_sent` |
| 6 | after receipt, `goods_state = 'settled'` and derived in-transit is 0 | no state |
| 7 | ledger holds exactly one `restock_transfer_out` and one `restock_transfer_in`, **each with `ref_table='restock_orders'` and `ref_id` = the order id** | `ref_id` is always NULL (A0.1) |
| 8 | over-receipt (`qty_received > qty_sent`) is accepted and increments by the counted figure | no path; §39 forbids blocking |
| 9 | a line left `qty_received IS NULL` prevents `settled` | no state machine |
| 10 | double-calling receipt is a no-op — one IN row only | no guard |
| 11 | double-calling `prepared` is a no-op — one OUT row only | passes today via `stock_applied_at`; must keep passing on the new guard |
| 12 | editing `restock_items` after dispatch is refused | no guard (B3) |
| 13 | dispatch exceeding warehouse stock rolls back rather than clamping | **fails today**: `Math.max(0, …)` clamps silently (A0.2) |
| 14 | unset `stock.warehouseStoreId` refuses with a message naming the setting | today it falls through to the most-stock guess (B7) |

**Tenant 2 (`scripts/test_stock_two_step_tenant2.js`)** — same discipline as `test_restock_tenant2_split.js`, which exists because a tenant-1 suite cannot catch a handle bug: reverting the `:333` fix left all 54 tenant-1 assertions green.

| # | Assertion |
|---|---|
| 15 | dispatch on tenant 2 writes `dispatched_at` **in tenant 2's database** |
| 16 | receipt on tenant 2 writes `qty_received` and `received_confirmed_at` in tenant 2 |
| 17 | tenant 1's shelves and ledger are untouched by either half |
| 18 | a receipt that throws mid-way rolls back **both** the stamp and the stock — the order stays `in_transit` and retryable |
| 19 | `stock.warehouseStoreId` resolves per tenant — tenant 2's value, not tenant 1's |
| 20 | derived in-transit on tenant 2 counts only tenant 2's orders |

**19 is the one that would fail loudest on a careless implementation**, and it is the direct descendant of the `:333` bug: a config read that resolved on the shared handle would give every tenant Roots' warehouse.

`scripts/check-tenant-als.js` must still pass — any new `tenantAls.run()` takes a raw handle.

---

# PART C — OPEN QUESTIONS

**STATUS, 2026-09-03: ALL SIX QUESTIONS ARE ANSWERED.** Q1, Q2, Q3, Q4 and Q6 by the first five rulings in PART D; **Q5 by D6**, which closed the last of them. Each question's text is left exactly as written — the framing is what a later reader needs in order to understand why the answer went the way it did — with the answer marked at the end of it. **Q3's answer went against this document's own recommendation.**

**Nothing in PART C now gates implementation. One thing outside it does: E2**, the purchase-order receiving downward correction, which Ash is ruling on. **E2 blocks one migration step, not the migration** — B8 says exactly which.

## For Ash

**Q1 — `storefront_config` for warehouse settings, or a rename first?** A4 recommends reusing it: it works, it is per-tenant, and it already holds `inventory.*` keys unrelated to any storefront. But `stock.warehouseStoreId` living in a table called `storefront_config` will read as a mistake to whoever finds it next. Options: use it as-is (recommended, zero risk); use it and rename the table in a separate pass; or create a `tenant_config` table now and accept two config mechanisms during the transition. **ANSWERED — D3: use it as-is. No rename, no settings table; the name mismatch is recorded as deliberate debt.**

**Q2 — an abandoned count.** B5: a delivery someone starts counting and never finishes leaves lines at NULL, so the order never settles and holds phantom in-transit stock indefinitely. §39 forbids a global accept, which rules out the easy answer. Options: leave it open forever and surface it on a warehouse screen; let the *warehouse* close it at dispatched quantities after N days, recorded as a warehouse action rather than a store count; or a manual "close this transfer" with a reason. **§39 does not settle this and neither should I.** **ANSWERED — D2: none of the three. A per-tenant end-of-trading-day sweep settles uncounted lines at the sent quantity, permanently marked unverified, conditional on a repeat-offender safeguard. Requires the `auto_settled_at` column in B2.**

**Q3 — should a dispatch exceeding warehouse stock be refused?** A0.2: today `adjustStock` clamps at zero and creates units. B4 proposes throwing instead, for the restock OUT half only. This is a behaviour change to a live path — a picker who could previously dispatch 50 from a shelf showing 20 would now be stopped. Whether that is a correct refusal or an obstruction depends on how much Roots trusts its warehouse counts, which is Ash's to judge. **Note that leaving it as-is means the migration knowingly preserves a path that invents stock.** **ANSWERED — D1, AGAINST THIS DOCUMENT'S RECOMMENDATION: not refused. A dispatch is never blocked by the record; the clamp is deleted and the balance goes negative. B4's `refuseNegative` proposal is withdrawn.**

**Q5 — can one recipe make more than one sellable product?** A5/B6: a 200g and a 500g jar from one batch. The answer picks the shape of the recipe→product link, and getting it wrong means redoing it. Nothing in the survey answers it. **ANSWERED — D6: YES, and both happen at Roots.** So the model is the many-products shape, because it contains the one-product case: a single-product batch is a split with one line in it, and there are not two code paths. A batch records what came out of it per product — **a link table, not a column** — the split is **typed by the person logging the batch and never inferred**, and stock increments **per output line, one ledger row per product**. The one-product case is pre-filled to a single confirm, which is convenience, not inference. **This confirms production wiring is larger than a column addition and keeps it out of this migration** — B6.1 sequences it as its own brief, gated on a recipe→product mapping whose 36 ambiguous pairs are Ash's to resolve.

## For you and me

**Q4 — `REAL` or `INTEGER` for quantities?** A0.3: `restock_items` says `REAL`, `retail_store_stock` and `retail_stock_ledger` say `INTEGER`, and SQLite enforces neither. B2 proposes `qty_received REAL` to match its neighbours. If stock is genuinely always whole units this should be settled and enforced in application code; if it is not, the ledger's `INTEGER` columns are already lying. **Either way this is bigger than the stock-movement work and should not be fixed inside it** — but a decision is needed on which way `qty_received` leans, and this document's answer is "match `qty_sent`". **ANSWERED — D4: match `qty_sent`, i.e. `REAL`. The wider split stays named, separate work.**

**Q6 — does `delivered` stay in `STATUS_FLOW` at all?** B1 empties it of stock meaning, leaving it as "the driver handed the boxes over" — a fact nobody currently records except by pressing a button that used to do something else. It may be worth keeping purely as a request-lifecycle milestone, or it may become a button that no longer earns its place on the screen. Design question more than schema, and it does not block anything. **ANSWERED — D5: it stays, as a pure logistics timestamp — the driver finished his leg. D2's repeat-offender safeguard gives it a second job: it is the only field that says how long a delivery sat uncounted after arriving.**

---

# PART D — ASH'S RULINGS, 2026-09-03

**These were ruled after PART C was written and they close Q1, Q2, Q3, Q4 and Q6. Q5 stays open.** They are recorded here with their reasoning because the reasoning is what a later reader needs in order not to re-open them; the decisions themselves are also in `docs/tacet-consolidation-decisions.md` §39. **Nothing below is built.**

## D0. THE PRECEDENCE RULE — which quantity sets stock

**Stated out loud because two rulings read as contradictory without it, and one session lost time treating them as a conflict.** §39 says the received quantity sets stock and never the dispatched quantity; D2 below settles an uncounted line at the sent quantity. **These never apply to the same line**, and the rule that separates them is:

> **A counted quantity always sets stock.** The sent quantity is used **only** for a line nobody counted, and any line settled that way is **permanently marked unverified** and is never indistinguishable from a counted line. **The record never prefers the warehouse's number to the counter's — it falls back to the warehouse's number only where there is no counter's number at all.**

So the order of preference per line is: **counted (`qty_received` set by a person) → sent (`COALESCE(qty_sent, qty_requested)`, marked unverified) → nothing.** A counted zero is a counted quantity and outranks the sent figure absolutely; it is the case B2's NULL-versus-zero distinction exists to protect, and D2 does not weaken it.

## D1. A dispatch is never blocked by the record — Q3 ANSWERED, against B4's recommendation

**The rule.** If the warehouse's on-hand figure says 20 and the picker physically finds and sends 50, **the send goes through for 50**, and the warehouse balance goes to −30. Nothing refuses the dispatch to protect a number that was already wrong.

**Why.** His hands are right and the record is wrong. Blocking the dispatch stops real, physical work in order to defend a figure reality has already contradicted. **−30 is an honest statement — at least 30 more units were at the warehouse than the system believed — and it is visible**, which silently inventing 30 units so the arithmetic stays non-negative is not.

**This overrules B4.** B4 recommended `adjustStock` gain a `refuseNegative` option that **throws**, with the restock OUT half passing it, and Q3 put that to Ash. **Ash ruled the other way: not refuse — go negative.** B4's recommendation is withdrawn; the clamp at `lib/inventory.js:1084` is **deleted** rather than made conditional. A0.2 already establishes the defect and its arithmetic and is not restated here.

**A negative on-hand must be visible somewhere a person looks, not only true in the database.** The one concrete gap found is in PART E.

### D1.1 The clamp removal is narrower than "18 callers" suggests

`adjustStock` has two call shapes and **the clamp governs only one of them.** Pass `deltaQty` and it applies; pass `newPhysicalQty` (an absolute target) and there is **no floor today, before or after this change**. Most channel-ingest callers compute their own `Math.max(0, …)` in JavaScript and pass the *result* as `newPhysicalQty`, so **deleting line 1084 does not reach them at all** (PART E).

Of roughly 20 real call sites, **five are actually touched**:

| Call site | Shape | Guard today | Verdict |
|---|---|---|---|
| `routes/retail-inventory.js:343` — admin Quick Stock delta add | `deltaQty` | none; sign not restricted server-side, the UI is trusted to send `+N` | **Needs a small guard** (`d < 0` rejection), or an explicit ruling that a kitchen delta may go negative as a correction |
| `routes/retail-waste.js:452` — waste write-off | `deltaQty: −qty` | **yes** — reads on-hand in the same transaction and throws `insufficient_stock`; its comment reads *"REFUSE, DO NOT CLAMP… this does not fix adjustStock, it stops depending on it being wrong"* | Already safe. **The pattern to copy** for any `deltaQty` caller that needs one |
| `routes/retail-waste.js:582` — waste void | `deltaQty: +qty` | n/a | Never negative |
| `routes/restock.js` — the transfer's OUT and IN halves | `deltaQty: ∓qty` | **none** | **This ruling's own case.** No guard wanted; the point is to stop hiding it. A non-blocking "this dispatch drove the warehouse negative" flag on the response is worth adding as UX, never as a gate |
| `routes/retail-purchasing.js:232` — PO receiving downward correction | `deltaQty` | partial, and a **named exception** | **Blocks the clamp removal — see PART E** |
| `routes/retail-purchasing.js:366` — PO receipt reversal | `deltaQty: −qty` | **yes** — `planPOReversal` refuses the whole operation if short, and asserts post-call that the clamp never bit | Already safe; its `reversal_clamped` assertion becomes dead but harmless |

**One consequence carries into all later work on this:** every self-clamping site reads the current quantity, computes an absolute figure in JavaScript, then passes `newPhysicalQty` — the read-then-write race `docs/tacet-stock-model.md` §5 records. **Moving a site onto `deltaQty` is what makes it honest and what closes that race; they are one change, not two.**

## D2. Abandoned counts auto-settle at end of the trading day — Q2 ANSWERED

**Q2 asked what happens to a delivery someone starts counting and never finishes, and named three options. Ash chose a fourth.** A part-counted delivery left open closes automatically at the end of the trading day it arrived on:

- **Counted lines land at the counted quantity** — nothing changes for them, and per D0 a counted figure always wins.
- **Uncounted lines land at the sent quantity.** The goods are physically on the shelf; leaving them out would have the store selling stock the system believes it lacks.
- **Uncounted lines are marked as not counted, permanently** — never indistinguishable from a verified line. See B2 for the column this requires.
- **End of trading day, not a rolling timer.** A fixed-duration timer fires at a different clock time depending on when the delivery arrived; end-of-day is predictable and matches how a shop already thinks about its own business.
- **The store is told the next morning, and so is the warehouse** — an auto-settle changes what a later unreported discrepancy on that transfer means.
- **Any line stays correctable afterwards** as an ordinary stock correction. This stops a transfer hanging open; it is not a final number.

**Recorded honestly: this is a global accept with a timer standing in for a button, and Q2 is right that §39 forbids the easy version of that.** A "mark the rest as sent" button was considered and rejected — it would become the fast path on the busiest days, exactly when an under-count is most likely and least likely to be caught. **The timer is defensible only because it catches genuinely abandoned counts rather than being reached for on purpose, and leaves a permanent mark.** Strip either property and it degrades into the thing the button was rejected for.

**MANDATORY SAFEGUARD — the ruling is conditional on it.** **Repeated auto-settling at one store must surface somewhere a person actually looks.** One abandoned count in a fortnight is a busy Tuesday; four means that store has stopped counting, and today nobody would find that out except by noticing stock drift. Without the repeat-offender signal the timer stops being a safety net and becomes the store's normal way of receiving. **Not optional polish — the ruling does not stand without it.**

**What the job is.** A per-tenant sweep that, once per trading day, finds every transfer still `in_transit` past the boundary and settles each uncounted line per the rule above, then notifies store and warehouse. Level-triggered: it compares state against a boundary rather than reacting to an event, so a missed tick (restart, slow deploy) does not strand a transfer — the next tick still finds it.

**What schedules it, and why "every 24 hours" is the wrong shape.** The one existing daily-cadence precedent, `startBillingScheduler()` (`lib/billing-lifecycle.js`), is `setInterval(tick, 24 * 60 * 60 * 1000)` armed at process start — it fires 24 hours after whenever the process last booted, anchored to nothing, and per `docs/tacet-write-surface.md` is never started at all. **A boot-anchored interval is exactly the "8pm one day, 2am the next" problem this ruling rejects.** The job must resolve each tenant's trading-day-end instant and act on that, not on an interval; a frequent cheap poll asking "has any tenant crossed its boundary since the last tick" is the more restart-safe way to get there, closer in shape to `sweepExpiredReservations`.

**Why the boundary cannot be read off `retail_stores`.** `open_time`/`close_time` (`database.js:3231-3232`) are optional free-text `'HH:MM'` captured only by the Add-location wizard, and `lib/store-hours.js` treats either being unset — or `close` not after `open` — as **"not configured", falling back to always-open**. `timezone` (`:3236`) is written by one screen only, defaulting to `Asia/Shanghai`, and `lib/inventory.js`'s `listStores()` omits the column entirely, so most admin surfaces cannot see it. `docs/tacet-multibusiness-audit.md` reached the same place independently: *"No reporting, settlement, cut-off or day-boundary calculation currently reads a per-location time zone… This supports the decision that the business day is business-wide, not per location."* **So the boundary is per-tenant config, not per-store** — a third `storefront_config` key beside B7's two. **A tenant whose stores genuinely keep different hours is a real case this does not solve, and is named rather than assumed away.**

## D3. `storefront_config`, as is — Q1 ANSWERED

**Use it. Do not rename it, do not build a settings table.** A4's recommendation is ratified in full and its reasoning is not restated here. **The name's poor fit for a warehouse setting is recorded as known, deliberate debt** — renaming a live config store mid-build is a gratuitous risk for a naming preference.

**One requirement A4 does not cover: the read must be on the tenant handle.** `cfgValue()` already resolves on `tdb()`, so a request-scoped call is tenant-safe by construction. **The risk is any caller running outside a request's tenant scope** — which is precisely the shape of D2's auto-settle sweep, since it iterates every tenant rather than living inside one tenant's request. A read there on the shared handle would hand every tenant Roots' warehouse: the same class of bug as the `:333` stamp, silently returning another tenant's data instead of erroring. **The sweep must enter each tenant's scope explicitly and never rely on an ambient one.**

## D4. `qty_received` is `REAL` — Q4 ANSWERED

**Match `qty_sent`.** B2's answer is ratified: a column disagreeing in type with the one it is compared against on the same line is a worse defect than the wider split. **The wider REAL/INTEGER inconsistency is real, is separate work, and is named rather than fixed** — A0.3 has the analysis.

**One piece of evidence A0.3 does not carry: the split already costs a rounding step in live code.** `routes/retail-purchasing.js:225-228`, applying a received PO line to store stock:

```js
// Whole units: retail_store_stock.physical_qty is an INTEGER, so both the
// applied bookkeeping and the delta are rounded the same way — repeated
// saves always converge instead of drifting on a fractional entry.
const good = Math.round(onHandQty(l) || 0);
```

`qty_received` inherits that same seam at the same boundary. It does not add a second, narrower one between itself and `qty_sent`.

## D5. `delivered` stays — Q6 ANSWERED

**Kept.** Q6 asked whether it still earns its place once B1 empties it of stock meaning. It does: **once it stops carrying stock meaning it still records a true, distinct fact — the driver finished his leg.** At Roots delivery and counting happen close enough together that the distinction barely shows; on a longer route, or a warehouse serving stores across town, they are genuinely different instants, and `delivered_at` is the only field that answers *"how long did this sit uncounted after it physically arrived"* — which under D2 is the exact question a repeat-offender signal is built on. **Document that its job changed** from a nominal stock gate to a pure logistics timestamp.

## D6. A batch yields one product or several — Q5 ANSWERED, and the last open question closes

**Ash: a batch can yield one product or several, and both happen at Roots.** So P1's third option wins outright.

**The model is the many-products shape, because it contains the one-product case.** A single-product batch is a split with one line in it. **There are not two paths and must never be two paths** — a one-product branch beside a many-product branch is two implementations of one fact, and they drift.

**A batch records what came out of it, per product.** One `production_batches` row, one or more **output lines**, each naming a product and a quantity. **That is a link table, not a column** on `production_batches`. **`recipes.output_product_id` and a `UNIQUE` index on `store_products.recipe_id` are both withdrawn** — each encodes "one recipe, at most one product", which Ash has just said is false.

**`recipe_id` keeps its job and does not gain one.** It stays the record of **what was made from what**. It does **not** determine what the batch yielded — the output lines do. A recipe is the method; the split is an observation about one run of it, and the same recipe run twice may split differently.

**The split is entered, never inferred.** Ash's answer is that it varies. **Tacet cannot compute it, cannot default it from the recipe, and must not guess.** Whoever logs the batch states it. This is the same discipline `qty_sent` and `qty_received` already keep: a person's number, typed by the person who can see the goods.

**But the common case must not become a form.** Where a recipe has only ever produced one product, the log **pre-fills that product and asks only for the quantity — one confirm.** The multi-product case is the general shape; the single-product case is that shape with one line already filled. **Same code path, different amount of typing.** Note what the pre-fill is allowed to be: a convenience drawn from what this recipe has produced *before*, presented for confirmation and freely overridable. It is **not** an inference about what this batch produced, and it must never be committed unconfirmed — that would be the guess this ruling forbids, wearing a default's clothing.

**Stock increments per output line**, at `cfgValue('production.outputStoreId')`, through the ledgered path, **one ledger row per product.** **A8.5 finds a limit on this that D6 did not anticipate: a recipe's output may also exist as a material, materials have no stock by decision, and so the bulk-held half of a split batch has no destination.** Output lines can name products only. See B6.1's second gate. Not one row for the batch: each product's stock moved, so each product's movement is a ledger row, with `refTable='production_batches'` and `refId` the batch id so all lines of one batch are recoverable together (B4's provenance change is what makes that possible).

**P2 (units) is untouched by this ruling and still stands.** The split says *which products and how many of each*; it does not say what one unit of a product is. `production_batches` still records `batches_made` and `servings_made`, and "one serving is one sellable unit" is still asserted only for the products `store_products_recipe_link_v1` costed. **A quantity per output line is a number the logger types, which sidesteps P2 for the batch itself** — but any later attempt to *check* that number against the recipe's yield still needs P2 settled.

---

# PART E — DEBT AND CONSEQUENCES OF D1

## E1. NAMED DEBT — four channel ingest paths keep their own clamps, and stay dishonest

**This is D1's largest collateral gap.** Removing the central clamp makes the transfer honest. It leaves **four ingest paths silently doing the exact thing D1 rejects** — absorbing a real shortfall into `Math.max(0, …)` so the shelf figure stays non-negative and the discrepancy is never stated. Each does it in its own file, **before `adjustStock` is called**, so deleting `lib/inventory.js:1084` does not reach any of them.

| Site | What it is | What it does today when the deduction exceeds on-hand |
|---|---|---|
| `routes/eleme-internal.js:488` | Eleme order ingest, per-line deduction | `newPhysicalQty: Math.max(0, oldQ - took)`. **Clamps, records nothing.** Not counted, not logged, not flagged — the most silent of the five. |
| `routes/meituan-internal.js:535,538` | Meituan order ingest, per-line deduction | Clamps identically, but **first** pushes `{ name, sku, have, want }` onto an `oversold[]` list (`:535`) surfaced to the operator. **Clamp-and-report** — the only one that does not lose the number. |
| `routes/guanyi-admin.js:356` | An **operator** confirming a flagged gzgrocery pickup really happened | `Math.max(0, curQty - inferred_pickup)`. **Clamps, records nothing.** A human asserting a physical event — which is D1's own case. |
| `scripts/guanyi-daemon.js:588-589` | Guanyi pickup-drift daemon, unattended | Clamps, but computes `clamped` and writes `(CLAMPED at 0)` to the log row and daemon log. **Clamp-and-log** — the shortfall survives in a log, not in the data. |
| `scripts/gzgrocery-order-daemon.js:493` | gzgrocery order ingest, per-line deduction | `Math.max(0, cur - it.qty)`. Clamps; the ledger note carries `(cur→next)` so truncation is *inferable* from two numbers, but no shortfall is stated as such. |

**Stated plainly, because the scoping is easy to misread as completeness: after D1 ships, a warehouse dispatch tells the truth and four sales channels still do not.** A Meituan, Eleme or gzgrocery order that oversells a shelf, and an operator-confirmed Guanyi pickup exceeding the record, all go on writing a floor of zero and discarding the difference — the same behaviour, in the same direction, that D1 calls silently inventing units.

**Making each channel honest is separate, per-channel work and is deliberately NOT in scope here.** Per-channel rather than one change because the right answer differs by path: an unattended daemon inferring loss from a scraped listing (`scripts/guanyi-daemon.js` — already burned once by a bad read that removed 1,863 units and needed `scripts/repair_guanyi_false_pickup.js` to undo) has a real argument for keeping a floor, while an operator confirming a pickup by hand has the same argument for losing one that the picker in D1 does. **Nothing here approves stripping the other four in one pass.**

## E2. THE PO-RECEIVING DOWNWARD CORRECTION — STILL OPEN, AND IT BLOCKS STEP 1b ONLY

**Ash is ruling on this now. Do not act on it.**

**Scope of the block, stated precisely because "blocks D1" has been read too widely.** E2 gates **Step 1b — the clamp deletion — and nothing else.** Steps 0, 1, 2, 3, 4, 5, 6 and 7 do not touch `applyReceivedToStock` and can all proceed while this is open. **The two-step transfer can ship in full with the clamp still in place**; what it cannot do is ship *honest*, because A0.2's invented units survive until Step 1b lands. B8 carries the same statement at the step itself.

`routes/retail-purchasing.js:232` (`applyReceivedToStock`) calls `adjustStock` with `deltaQty: good − alreadyApplied`, so it **is** on the path the clamp governs, and lowering an arrived count on a re-save produces a negative delta. **The codebase has already ruled on this path twice, in writing, and both rulings assume the clamp stays.**

`routes/retail-purchasing.js:296-298`:

> `inventory.adjustStock`'s `Math.max(0, …)` clamp is **deliberately NOT changed — other callers depend on it.** This pre-check is what stops this path from ever reaching it, and the assertion below is what proves it never did.

`docs/purchase-returns.md`, *What this does not do*, item 3:

> **A downward correction to an arrived count still clamps at zero stock** rather than refusing. Returns refuse; corrections behave as they always have. Making both refuse is a one-line change to `applyReceivedToStock` and a behavioural change to a path the warehouse uses daily, which is not something to smuggle in beside a new feature.

**So this path has three possible behaviours and only two of them have ever been considered:**

| | Behaviour on a below-zero correction | Status |
|---|---|---|
| Today | **Clamps at 0**, shortfall discarded | Recorded and accepted in `docs/purchase-returns.md` item 3 |
| The documented intent | **Refuses** the save outright, as the returns path already does | Named, deferred, never scheduled |
| What D1 delivers by default | **Writes a negative balance**, silently | **Never proposed, never ruled on** |

**THE CLAMP CANNOT COME OUT UNTIL THIS IS SETTLED.** Three reasons it is not safe to assume the default is fine. It lands on a path `docs/purchase-returns.md` explicitly calls one *"the warehouse uses daily"*, which is why tightening it was deferred rather than done. Its sibling path in the same file refuses and proves it refused (`planPOReversal`, plus a post-call `reversal_clamped` assertion), so letting corrections drift to silently-negative makes two siblings disagree about the same event. And `stock_applied_qty` is written from `good` regardless (`retail-purchasing.js:239`), so a negative shelf and the line's applied figure would diverge in exactly the way that file's own comment was written to prevent.

**`docs/purchase-returns.md` item 3 becomes false whichever of the last two wins, and must be amended in the same change.**

## E3. THE DASHBOARD FILTER — negative stock disappears from the "Needs you" panel

**Documented, NOT made.** No code has been changed; the clauses below read as shown today.

A negative on-hand is only honest if somebody sees it. The admin dashboard's "Needs you" panel filters stock by strict comparisons that **a negative balance matches none of** — so a store at −30 vanishes from both cards rather than being shown wrong.

**It is four clauses, not one.** Each card's count query and its preview-items query are written separately, so a partial fix makes the count and the list disagree with each other:

| # | File and line | Clause | Card |
|---|---|---|---|
| 1 | `routes/retail.js:15249-15250` | `WHERE ${REAL_STOCK} > 0 AND ${REAL_STOCK} <= ${LOW_THRESHOLD}` | **Low stock — count** (`lowCount`) |
| 2 | `routes/retail.js:15258-15259` | `WHERE ${REAL_STOCK} > 0 AND ${REAL_STOCK} <= ${LOW_THRESHOLD}` | **Low stock — preview items** (`lowItems`) |
| 3 | `routes/retail.js:15267` | `WHERE ${REAL_STOCK} = 0` | **Out of stock — count** (`oosCount`) |
| 4 | `routes/retail.js:15275` | `WHERE ${REAL_STOCK} = 0` | **Out of stock — preview items** (`oosItems`) |

**Minimum fix: clauses 3 and 4 both become `<= 0`, in the same change.** Fixing one and not its twin gives a card whose count and list contradict each other, which is worse than the bug. **Whether `low` (clauses 1 and 2) should also catch negatives is an open call** — a negative is arguably more urgent than a low positive, but it is already claimed by `out_of_stock` under the minimum fix, and a product must not appear on both cards.

---

## What this document does not cover

- **The markets / `retail_stores` split.** Out of scope by instruction and untouched throughout.
- **Production-to-stock.** Scoped in B6 as prerequisites P1 and P2; not planned.
- **`store_products` versus `products` id spaces.** A2 records the trap and B8 keeps `_checkTransferIds` on both halves. The underlying fork is not addressed.
- **The receiving UI itself.** Drawn in `design-handoff/store-receiving/`; this document covers only what the schema owes it.
