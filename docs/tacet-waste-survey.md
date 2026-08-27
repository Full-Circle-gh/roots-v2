> **STALE — superseded 2026-08-26.** Hypothesis H2 (that the packaging double-count still reaches
> waste through made materials) was correct when written and was closed by `c86ef74e`, committed
> 2m43s after this document. The exclusion is complete: packaging is removed where a made material's
> unit cost is DERIVED, so every consumer inherits the correction. See `packaging-findings.md`
> finding 16. H2's line citations no longer resolve. The rest of this survey has not been re-verified
> against post-fix code — treat every finding here as pre-`c86ef74e`.

# Waste — read-only survey of the kitchen app's Waste section

**2026-08-26 · A read-only survey of how the kitchen app's WASTE section works today, written so it
can be judged for migration into Tacet as part of the Production module. No file was changed,
created or deleted except this one. No code was run against any database.**

**Sources.** Repository at `origin/main` `3b2f5038`, working tree clean and identical to
`origin/main` at the time of reading. Every claim below is cited to `file:line` in that tree.
No live database was opened — this machine holds no `data/` copy — so every statement about live
row counts or live data shape is either quoted from an existing survey (with its date) or marked
**UNVERIFIED**.

**Decisions this survey serves.** `docs/tacet-consolidation-decisions.md` §21 (modules), §22
(rollout order), §28 (Production module, Phase 1 = Materials + Purchases, Recipes deferred) and its
addendum; `docs/tacet-glossary.md` v1.8; `docs/tacet-desktop-patterns.md`.

---

## 0 — The one-paragraph answer

Waste is one table, one route file of 198 lines, and one screen. It records **products only** — never
materials, never production batches — and it **moves nothing**: no stock, no ledger, no finance
posting, no batch link. Its single interesting behaviour is valuation, and valuation is where the
migration question sits. A wasted product is valued from **its linked recipe** (ingredients + labour
+ overhead, packaging deliberately excluded) and falls back to **the product's sell price** when the
recipe cannot produce a cost, which values the loss at retail rather than at cost. So the honest
answer to question 8 is: **waste as it stands today requires Recipes, which §28 defers out of
Production Phase 1** — but only for its cost number, and Tacet already has a Phase-1-compatible cost
column (`store_products.unit_cost`) that the kitchen route does not read. Migrating the *screen*
needs no recipe. Migrating the *number* does, unless it is re-pointed. And the thing Production
Phase 1 actually adds — wasting a **material** — does not exist anywhere in the code today.

---

## 1 — DATA MODEL

### 1.1 The one waste table

There is exactly one. Full DDL, verbatim:

`schema.sql:276-295`

```sql
-- ── Waste ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS waste_entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  date          DATE NOT NULL,
  product_id    INTEGER,
  product_name  TEXT NOT NULL,
  product_sku   TEXT,
  qty           REAL NOT NULL,
  unit          TEXT,
  reason        TEXT,
  cost_lost     REAL DEFAULT 0,
  retail_value  REAL DEFAULT 0,
  staff_name    TEXT,
  shift         TEXT,
  notes         TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by    INTEGER,
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);
```

One index: `CREATE INDEX IF NOT EXISTS idx_waste_date ON waste_entries(date)` — `schema.sql:493`.

One migration-added column, and only one:

`database.js:174-176`

```js
// Waste entries gained a cost_source column so reconciliation can tell
// recipe-derived costs from sell-price fallbacks.
addColumn('waste_entries', 'cost_source', 'TEXT');
```

`cost_source` is therefore **nullable with no default**. Rows written before that migration hold
`NULL`.

### 1.2 Nullability, defaults, foreign keys, ON DELETE

| Column | Type | Null? | Default | Notes |
|---|---|---|---|---|
| `id` | INTEGER | no | autoincrement | |
| `date` | DATE | **NOT NULL** | none | Stored as a `YYYY-MM-DD` string; SQLite does not enforce the type |
| `product_id` | INTEGER | **nullable** | none | FK → `products(id)`. In practice always set — see 1.3 |
| `product_name` | TEXT | **NOT NULL** | none | Denormalised snapshot |
| `product_sku` | TEXT | nullable | none | Denormalised snapshot |
| `qty` | REAL | **NOT NULL** | none | |
| `unit` | TEXT | nullable | none | Free text; both clients hardcode `'pcs'` |
| `reason` | TEXT | nullable | none | Free text; the vocabulary is client-side only |
| `cost_lost` | REAL | nullable | `0` | Yuan |
| `retail_value` | REAL | nullable | `0` | Yuan |
| `staff_name` | TEXT | nullable | none | Free text, **not** a user FK |
| `shift` | TEXT | nullable | none | Free text |
| `notes` | TEXT | nullable | none | |
| `created_at` | DATETIME | nullable | `CURRENT_TIMESTAMP` | UTC |
| `created_by` | INTEGER | nullable | none | FK → `users(id)` |
| `cost_source` | TEXT | nullable | none | Added by migration, `database.js:176` |

**Both foreign keys are bare — no `ON DELETE` clause on either** (`schema.sql:293-294`). SQLite's
default for an unqualified FK is `NO ACTION`, so deleting a referenced `products` or `users` row is
*rejected* while `PRAGMA foreign_keys` is on. That is load-bearing and is stated as such in the code:

`database.js:77-79`

```js
// Switching products from hard-delete to soft-delete (waste/restock reference
// product_id and would orphan otherwise). New rows default to active=1.
addColumn('products', 'is_active',  'INTEGER DEFAULT 1');
```

and again at `routes/products.js:658` — *"DELETE — soft delete (set is_active=0) so waste/restock
entries that…"*. The same reasoning drives the user-deletion guard at `routes/admin.js:86-101`,
which counts `waste_entries.created_by` rows and refuses a hard user delete when any exist.

### 1.3 Which columns waste READS

Waste reads no column outside its own table and these:

- `products.sell_price`, `products.recipe_id`, `products.name_en` — `routes/waste.js:42`
- `products.id`, `name_en`, `name_cn`, `sku`, `sell_price` — `routes/waste.js:159`
- `recipes.*` (`servings`, `batch_size` used) — `lib/recipe-cost.js:94`, `:153`, `:162`
- `recipe_ingredients.*` joined to `ingredients.cost_per_unit`, `ingredients.unit`,
  `ingredients.free_by_design`, `ingredients.name_en` — `lib/recipe-cost.js:95-101`
- `recipe_cost_data.labour`, `packaging`, `overhead_pct`, `sell_price`, `target_food_cost` —
  `lib/recipe-cost.js:102`, `:149-152`
- `permissions.waste`, `permissions.can_delete`, `users.*` — `middleware/auth.js:12-15`, `:24-40`

`product_name`/`product_sku` are snapshotted at write time from `products`
(`routes/waste.js:181`), so a later rename does not rewrite history — but see hazard **H5** and the
grouping note in §9.

### 1.4 Kitchen-only assumptions baked into this table

Each of these is a shape a non-kitchen business would not choose, and each is a decision the Tacet
version has to make explicitly rather than inherit:

1. **`shift`** — `schema.sql:289`, populated from a fixed three-value roster (Morning / Afternoon /
   Evening) hardcoded in the form at `public/app.html:23111-23116`. A roster concept, not a
   universal one.
2. **`staff_name` as free text** — `schema.sql:288`. The logged-in user is *already* recorded in
   `created_by` (`routes/waste.js:182`), so this is a second, unvalidated actor field that exists
   because the person who wastes something is often not the person at the keyboard. There is a
   staff-name lookup route (`routes/lookups.js:109` — *"Used by Production-log + waste-log
   dropdowns"*) but the waste form does not use it; it is a plain `<input type="text">`
   (`public/app.html:23107`).
3. **`unit` free text, defaulted to `'pcs'` by the client, never by the schema** —
   `routes/waste.js:181` (`unit || 'pcs'`), `public/app.html:23423` and `:23563` both send the
   literal `'pcs'`. There is no unit list, no per-product unit, and no conversion.
4. **The `reason` vocabulary is a browser constant, not data** — `public/app.html:23031-23038`:
   `expired · spoiled · dropped · spilled · damaged · other`. The column accepts any string
   (`schema.sql:285`) and the API does not validate it (`routes/waste.js:181`). These six are food
   spoilage words.
5. **No location.** Nothing in the table says *where* the loss happened. The kitchen app assumes one
   implicit place. Tacet's §10 stock model is explicitly *"ONE stock record per thing per location"*
   (`docs/tacet-consolidation-decisions.md:479`), so a Tacet waste movement has to name one and the
   column does not exist.
6. **No batch, lot or expiry link.** `production_batches` (`schema.sql:336-351`) has no waste
   reference and `routes/production.js` contains the string "waste" zero times. Expiry lives on
   purchase lines (`po_line_items.expiry_date`, read by the alerts feed at `routes/ai.js:2215-2217`)
   and never reaches a waste row.
7. **No `tenant_id` / account column.** Every other multi-account table carries one; this one does
   not (`schema.sql:277-295`).
8. **Recipe unit assumptions arrive indirectly**, through the costing path: `ingredients.unit` is
   documented as *"recipe unit (g/ml/pcs)"* and `ingredients.cost_per_unit` as *"cost per recipe
   unit (¥/g)"* — `schema.sql:49`, `:55`. Waste inherits both without ever naming a unit itself.

---

## 2 — ROUTES

`routes/waste.js`, 198 lines, mounted globally at `server.js:367` (`app.use(require('./routes/waste'))`).
The DB handle is the seam passthrough, `routes/waste.js:5-6`.

Five endpoints. **Every one is gated `requireAuth` + `requirePermission('waste')`**; the delete adds
`requireDelete`.

| # | Method · path | Gate | Reads | Writes | Returns |
|---|---|---|---|---|---|
| 1 | `GET /api/waste` — `:74` | `requireAuth`, `requirePermission('waste')` | `waste_entries` (`SELECT *`), optional `?period` `?product_id` `?reason` — `:76-85` | — | `{success, data:[rows]}` — `:86` |
| 2 | `GET /api/waste/preview/:product_id` — `:90` | same | `products`, `recipes`, `recipe_ingredients`, `ingredients`, `recipe_cost_data` via `computeProductCost` — `:40-63` | — | `{success, data:{cost_per_unit, sell_price, source}}` — `:91` |
| 3 | `GET /api/waste/summary` — `:95` | same | `waste_entries` ×3 (period, today, previous period) — `:100-113` | — | `{success, data:{period, days, from, today, totalCost, todayCost, totalQty, avgPerDay, prevCost, costDeltaPct, todayCount, periodCount, buckets[], topItems[]}}` — `:140-148` |
| 4 | `POST /api/waste` — `:152` | same | `products` (`:159`) + the whole costing path (`:162`) | **`INSERT INTO waste_entries`** — `:175-183`; **`INSERT INTO activity_log`** via `logActivity` — `:184` | `{success, id, data:row}` — `:186` |
| 5 | `DELETE /api/waste/:id` — `:191` | `requireAuth`, **`requireDelete`**, `requirePermission('waste')` | — | **`DELETE FROM waste_entries`** — `:192`; `activity_log` — `:194` | `{success:true}` — `:195` |

Gate definitions: `requireAuth` `middleware/auth.js:7-17`; `requirePermission`
`middleware/auth.js:24-30` (admin bypasses; otherwise `permissions.waste` must be truthy);
`requireDelete` `middleware/auth.js:37-41` (admin bypasses; otherwise `permissions.can_delete`).
The `waste` permission column is `schema.sql:37`, `waste INTEGER DEFAULT 1` — **on by default for
every new permissions row**, and it is written by `routes/admin.js:47`, `:75-80` and
`routes/auth.js:34`.

### 2.1 Handlers that write outside the waste tables

**Exactly one, and it is the audit log.**

- `routes/waste.js:184` — `logActivity(req.user.id, req.user.username, 'create', 'waste', id, {product, qty, cost_lost, cost_source}, req.ip)` → `INSERT INTO activity_log` (`middleware/auth.js:52-53`).
- `routes/waste.js:194` — the same for `'delete'`, with `details` passed as **`null`**.

No handler in this file touches `products`, `products.stock_qty`, `market_stock`,
`market_stock_ledger`, `retail_store_stock`, `retail_stock_ledger`, `income_entries`,
`expense_entries`, `ingredients`, `production_batches` or any invoice table. The only two write
statements in the whole file are the `INSERT` at `:175` and the `DELETE` at `:192`. Verified by
reading all 198 lines and by a repo-wide grep for `waste_entries`, which finds no writer outside
this file.

### 2.2 Validation the POST performs, and does not

Performs (`routes/waste.js:155-160`): `date` present; `qty` parses and is `> 0`; `product_id`
present; the product exists in `products` (404 otherwise).

Does **not**: validate that `date` is a date, or is not in the future (the UI sets
`max="${today}"` at `public/app.html:23076` — the API does not); validate `reason` against any list;
validate `unit`; check for a duplicate entry; require a non-zero cost.

---

## 3 — HOW WASTE IS VALUED

### 3.1 The inputs, named

**A mix, in a fixed order of preference:** recipe-derived production cost first, product sell price
second, zero third. Purchase cost reaches waste only *indirectly*, through
`ingredients.cost_per_unit`, which purchasing writes back (`lib/ingredient-cost.js:1-33`). Waste
itself never reads a purchase order.

### 3.2 The trace, end to end

**Step 1 — resolve the product.** `routes/waste.js:42`

```sql
SELECT sell_price, recipe_id, name_en FROM products WHERE id = ?
```

`sellPrice = p.sell_price || 0` (`:44`). Note this is **`products.sell_price`**, not
`recipe_cost_data.sell_price` — two different columns exist and waste reads only the first.

**Step 2 — no recipe link ⇒ immediate fallback.** `routes/waste.js:45-47`

```js
if (!p.recipe_id) {
  return { cost_per_unit: null, sell_price: sellPrice, source: sellPrice > 0 ? 'sell_price' : null };
}
```

**Step 3 — the shared recipe derivation.** `routes/waste.js:51` calls
`computeRecipeCost(p.recipe_id, db)` — `lib/recipe-cost.js:123`. Returns `null` if the recipe id
points at nothing, which falls through to the same sell-price fallback (`routes/waste.js:52-54`).

Its three statements, `lib/recipe-cost.js:94-102`:

```sql
SELECT * FROM recipes WHERE id = ?

SELECT ri.*, i.cost_per_unit AS master_cost, i.unit AS master_unit,
       i.free_by_design AS master_free,
       i.name_en AS master_name_en
  FROM recipe_ingredients ri
  LEFT JOIN ingredients i ON ri.ingredient_id = i.id
 WHERE ri.recipe_id = ?
 ORDER BY ri.sort_order

SELECT * FROM recipe_cost_data WHERE recipe_id = ?
```

**Step 4 — one ingredient line.** `lib/recipe-cost.js:66-87`

```js
const costPerUnit = i.master_cost || 0;      // ingredients.cost_per_unit — ¥ per RECIPE unit
const qty = parseFloat(i.qty) || 0;          // recipe_ingredients.qty
const isFree = !!i.master_free;              // ingredients.free_by_design
const lineCost = isFree ? 0 : (costPerUnit > 0 ? qty * costPerUnit : null);
if (lineCost === null) zeroCostLines++;      // NOT added to the subtotal
else ingredientCost += lineCost;
```

Two behaviours matter and are deliberate (`lib/recipe-cost.js:40-42`): a line whose master cost is
0 or null contributes **nothing** and is counted as *missing*, not as a genuine zero; a line flagged
`free_by_design` contributes a **real** zero and is not counted as missing.

`master_unit` is selected on line 96 and **never used** — no unit comparison, no conversion. See
hazard **H3**.

**Step 5 — the batch.** `lib/recipe-cost.js:149-159`

```js
const labour      = parseFloat(cd.labour || 0);        // recipe_cost_data.labour        (¥ per batch)
const packaging   = parseFloat(cd.packaging || 0);     // recipe_cost_data.packaging     (¥ PER SERVING)
const overheadPct = parseFloat(cd.overhead_pct || 0);  // recipe_cost_data.overhead_pct  (percent)
const servings    = parseFloat(recipe.servings || 0);  // recipes.servings

const packagingTotal = packaging * (servings > 0 ? servings : 1);
const overheadAmount = ingredientCost * overheadPct / 100;
const batchCost      = ingredientCost + labour + packagingTotal + overheadAmount;
```

**Step 6 — waste re-assembles the batch WITHOUT packaging.** `routes/waste.js:55-57`

```js
// Packaging-free batch total — see note 1 above.
const batchCost = c.ingredientCost + c.labour + c.overheadAmount;
const costPerServ = c.servings > 0 ? batchCost / c.servings : null;
```

The reason is argued in the file header, `routes/waste.js:28-35`: packaging is recycled when a
finished unit is wasted, so counting it would double-count. `docs/packaging-findings.md:502` records
this as the **only** one of twelve `computeRecipeCost` call sites that excludes packaging, and calls
the exclusion correctly documented.

**Step 7 — choose.** `routes/waste.js:59-62`

```js
if (costPerServ !== null && costPerServ > 0) {
  return { cost_per_unit: costPerServ, sell_price: sellPrice, source: 'recipe' };
}
return { cost_per_unit: null, sell_price: sellPrice, source: sellPrice > 0 ? 'sell_price' : null };
```

**Step 8 — the write.** `routes/waste.js:168-172`

```js
const cost_source = cost_per_unit != null
  ? 'recipe'
  : (sell_price > 0 ? 'sell_price_fallback' : 'none');
const cost_lost    = (cost_per_unit != null ? cost_per_unit : sell_price) * q;
const retail_value = sell_price * q;
```

Note the vocabulary shifts between the preview and the write: the preview returns `source:
'sell_price'` (`:46`) while the stored column records `'sell_price_fallback'` (`:170`). Same
condition, two spellings.

### 3.3 Units at every step

**Every figure is yuan, stored as SQLite `REAL`. There are no cents anywhere on this path.**

| Value | Unit | Cited |
|---|---|---|
| `ingredients.cost_per_unit` | ¥ per *recipe* unit (¥/g for weighed, ¥/piece for counted) | `schema.sql:55`; `lib/ingredient-cost.js:5-7` |
| `recipe_ingredients.qty` | recipe units | `schema.sql:118` |
| `ingredientCost` | ¥ per batch | `lib/recipe-cost.js:75` |
| `recipe_cost_data.labour` | ¥ per batch | `schema.sql:138` |
| `recipe_cost_data.packaging` | ¥ **per serving** | `schema.sql:139` (`-- per serving`) |
| `overhead_pct` | percent of `ingredientCost` | `lib/recipe-cost.js:158` |
| `costPerServ` | ¥ per serving | `routes/waste.js:57` |
| `products.sell_price` | ¥ | `schema.sql:157` |
| `waste_entries.cost_lost` | ¥ | `schema.sql:286` |
| `waste_entries.retail_value` | ¥ | `schema.sql:287` |

No `×100`, no `/100`, no cents column touches this path. `docs/tacet-money-model-survey.md:155`
classifies `waste_entries.cost_lost` as one of the nine **unit-cost** columns that stay in yuan, and
`docs/tacet-consolidation-decisions.md:819` records the same. `docs/tacet-consolidation-decisions.md:1351`
notes that the one live value carrying eleven decimal places — `cost_lost` = `14.47993935862069` —
is *"the result of a division, not money anyone recorded"*, which is exactly what step 6 produces.

### 3.4 Worked arithmetic

A product linked to a recipe with 20 servings, ¥46.00 of ingredients, ¥12.00 labour, ¥1.50/serving
packaging, 8% overhead, sell price ¥18.00, 3 units wasted:

```
ingredientCost   = 46.00
overheadAmount   = 46.00 × 8 / 100                       = 3.68
packagingTotal   = 1.50 × 20                             = 30.00   ← computed, then DISCARDED by waste
batchCost(waste) = 46.00 + 12.00 + 3.68                  = 61.68   ← routes/waste.js:56
costPerServ      = 61.68 / 20                            = 3.084
cost_lost        = 3.084 × 3                             = 9.252   → waste_entries.cost_lost
retail_value     = 18.00 × 3                             = 54.00   → waste_entries.retail_value
cost_source      = 'recipe'
```

Had the recipe been absent: `cost_lost = 18.00 × 3 = 54.00`, `cost_source = 'sell_price_fallback'`,
and `cost_lost == retail_value`. **The loss is then booked at retail, three-to-six times its true
cost on a typical margin** — the number is not wrong so much as it is a different number wearing the
same column name.

### 3.5 A wasted thing with no recipe and no cost

`cost_per_unit` is `null` and `sell_price` is `0`, so `routes/waste.js:171` evaluates
`0 × qty = 0`. The row is **written**, with `cost_lost = 0`, `retail_value = 0`, and
`cost_source = 'none'` (`:170`).

The screen warns but does not block. `public/app.html:23388-23392` renders
*"⚠️ 无成本数据 No cost data — add ingredient prices to the cost sheet"* and leaves the cost field
blank, and `wasteSubmitEntry` (`public/app.html:23411-23414`) checks only that a product is selected
and `qty > 0`. **A zero-value waste row is one click away and looks like a successful save.**

---

## 4 — WHAT CAN BE WASTED

**Products only. Confirmed from the code, not the labels.**

- The table has a `product_id` FK to `products` and **no** `ingredient_id`, `material_id`,
  `recipe_id` or `batch_id` column — `schema.sql:277-295`.
- `POST /api/waste` requires `product_id` and 400s without it — `routes/waste.js:157`.
- It resolves that id against `products` and 404s if absent — `routes/waste.js:159-160`.
- The picker is fed by `GET /api/products` — `public/app.html:23047-23050` — which reads the kitchen
  `products` table (`routes/products.js:65`).
- `routes/production.js` contains the string "waste" **zero times**; `production_batches`
  (`schema.sql:336-351`) has no waste column and nothing joins the two.
- No route anywhere writes `waste_entries` other than `routes/waste.js` (repo-wide grep for
  `waste_entries`).

So: **not** materials/ingredients, **not** production batches, **not** all three. One of the three.

**One document disagrees with the code, and the code wins.** The assistant's built-in help text says
*"Pick product (or ingredient)"* and offers a reason list of *"spoiled / overproduction / damaged /
other"* — `routes/ai.js:1329-1331`. Neither is true: there is no ingredient path, and
`overproduction` is not one of the six reasons at `public/app.html:23031-23038`. Recorded here
because migrating the screen without correcting that text leaves the assistant teaching a flow that
does not exist.

---

## 5 — SIDE EFFECTS

**Recording waste moves no stock, posts to no ledger, and touches no production batch.** Every
downstream write, exhaustively:

| # | Write | Site | Table | Transactional? |
|---|---|---|---|---|
| 1 | `INSERT INTO waste_entries (…14 cols…)` | `routes/waste.js:175-183` | `waste_entries` | Single statement — atomic in itself. **No explicit transaction.** |
| 2 | `INSERT INTO activity_log (…)` — action `create`, entity `waste` | `routes/waste.js:184` → `middleware/auth.js:52-53` | `activity_log` | **Separate statement, outside any transaction, inside its own `try/catch`** (`middleware/auth.js:44`, `:54`) — a failed log is swallowed and the waste row stands |
| 3 | `DELETE FROM waste_entries WHERE id = ?` | `routes/waste.js:192` | `waste_entries` | Single statement. **Hard delete** |
| 4 | `INSERT INTO activity_log (…)` — action `delete`, entity `waste`, **`details = null`** | `routes/waste.js:194` | `activity_log` | Same as #2 |

There is **no** `db.transaction(...)` anywhere in `routes/waste.js`. Nothing is rolled back, because
nothing is paired.

Things that are explicitly **not** written, each checked directly:

- **Stock.** `products.stock_qty` is documented as *"a snapshot updated by sales/waste/restock
  movements"* (`database.js:84`) and `docs/tacet-product-fields.md:119` repeats that phrasing — **but
  waste does not update it.** `routes/waste.js` never names `stock_qty`. The comment is aspirational.
- **Stock ledger.** `retail_stock_ledger.reason` lists `waste` as a permitted value
  (`database.js:2899`) and **nothing writes it** — grep for a `'waste'` reason string across
  `lib/inventory.js`, `routes/markets.js` and `routes/retail-inventory.js` returns nothing.
  `market_stock_ledger` has exactly one insert site, `routes/markets.js:214`, and it is not waste.
- **Market stock.** `database.js:625-626` describes manual market-stock corrections as being for
  *"write-offs that aren't already covered by `waste_entries`"* — a comment that assumes waste moves
  stock somewhere. It does not.
- **Finance.** `income_entries` / `expense_entries` are never touched. Waste cost never becomes an
  expense.
- **Production batches.** No reference in either direction.
- **Ingredients / materials.** No reference.

**Consequence, stated plainly:** waste today is a *record*, not a *movement*. The wasted units are
still counted as sellable everywhere in the system. That is a design fact, not a bug report — but it
is the single biggest gap between what waste is now and what §10 of the consolidation decisions
requires of it in Tacet (*"ONE movement ledger. Every stock change writes to it."* —
`docs/tacet-consolidation-decisions.md:480`).

---

## 6 — THE SCREEN

`public/app.html`, `renderWaste()` at `:23046`. Reached from the sidebar row `Waste · 损耗`
(`:2606`), which is shown only to admins and to users holding the `waste` permission (`:3074`), and
routed at `:3921`.

**What a person sees, top to bottom.**

A page headed *WASTE LOG · 损耗记录* with the subtitle *"Staff log wasted / damaged / expired retail
products"* (`:23059-23060`) and two buttons top-right: **Bulk Entry** and **Export CSV**
(`:23063-23064`).

Then **four number tiles** (`_wasteRenderKPIs`, `:23148-23182`): waste cost for the chosen period —
with an up/down arrow comparing it to the previous period of the same length — today's waste cost
and entry count, total units wasted, and average daily cost.

Then **two cards side by side** (`:23068-23071`). On the left, a bar chart of waste cost per day,
hand-drawn on a `<canvas>` (`_wasteDrawBar`, `:23209`), with three period buttons above it — *Today
/ 7d / 30d* (`:23187-23191`) — which are the **only** filter on the page. On the right, a ranked
**Top Waste Items** list, up to eight rows, each a name, a cost, a proportional bar and a
*"N 个 · N 次"* subline (`_wasteRenderTop`, `:23279`).

Then **the entry form** — one card, headed *"记录损耗 Log New Waste Entry"* with a note that cost is
calculated automatically (`:23074-23075`). Eight fields (`:23079-23122`):

- **Date**, defaulted to today and capped at today (`:23081`).
- **Product** — a type-ahead over the product list, matching English name, Chinese name or SKU
  (`wasteSearchProduct`, `:23347`). Picking one shows a small confirmation strip with name, SKU and
  sell price, and fires a server call for the cost (`wastePickProduct`, `:23366`).
- **Quantity**, a number spinner starting at 1, stepping by 1.
- **Reason**, a dropdown of six: expired, spoiled, dropped, spilled, damaged, other.
- **Cost ¥** — **read-only**, greyed, marked *"● 自动计算 auto"*. Underneath it a one-line
  explanation of the sum, e.g. *"¥3.08 产品成本 prod cost × 3 = ¥9.25"* followed by a hover chip
  reading *"♻ excl. packaging"* (`wasteUpdateCostPreview`, `:23384-23410`). On the fallback path the
  same line turns amber and says *"⚠️ 后备 fallback: 售价 sell price …"*. With no cost at all it says
  *"⚠️ 无成本数据 No cost data"*.
- **Staff Name**, free text.
- **Shift**, a dropdown: any / Morning / Afternoon / Evening.
- **Notes**, a textarea prompting for batch number, shelf location or complaint.

Two buttons: *Clear* and a red *记录损耗 Log Waste*.

Then **the log table** (`_wasteRenderLog`, `:23308`) — every entry in the selected period, newest
first, with columns: Date (and time beneath it), SKU, Product, Qty, Reason badge, Cost, Staff chip,
Shift, Notes (truncated, full text on hover) and a red ✕ that deletes the row after a browser
`confirm()` (`wasteDeleteEntry`, `:23446`).

**Bulk Entry** (`wasteOpenBulk`, `:23460`) opens a modal with five blank rows — date, product
type-ahead, qty, reason, staff, notes — plus *Add Row*, a live *"N ready to submit"* counter, and a
*Log N Items* button. It promises *"Cost is auto-computed for each row"* (`:23503`) but shows no cost
anywhere. Submitting fires **one HTTP request per row in a loop** and reports a tally
(`_wasteBulkSubmit`, `:23557-23573`). It does **not** send `shift`, although the row object carries
the field (`:23561-23564` vs `:23461`).

**Export CSV** (`wasteExportCSV`, `:23575`) downloads only what is currently loaded — the selected
period, not the whole history — with columns Date, SKU, Product, Qty, Unit, Reason, Cost (¥), Retail
Value (¥), Staff, Shift, Notes. `retail_value` appears here and nowhere else on the screen.

**Reports.** There are none beyond the above. No date range picker, no per-product drill-down, no
reason breakdown, no per-staff view. The API supports `?product_id=` and `?reason=` filters
(`routes/waste.js:83-84`) and **no screen sends either** — `public/app.html:23139-23140` passes only
`period`.

**Elsewhere in the app**, waste surfaces twice more: a dashboard tile showing 7-day waste cost that
navigates to this page (`:3994`), and a dashboard row showing the same cost, the entry count and
waste as a percentage of the week's revenue (`:4011-4013`). Both read
`GET /api/waste/summary?period=7d` (`:3950`). There is also a command-palette action *Log Waste ·
记录损耗* gated on the same permission (`:4143`).

**There is no waste screen on the phone** — `public/m.html` contains the string "waste" zero times —
and **no waste screen in Tacet**: `public/retail-admin/*.js` matches only the ordinary English word
"wasted"/"wastes" in comments.

---

## 7 — USAGE

**Live volume.** `docs/tacet-money-model-survey.md:131` and `:155` both record
**`waste_entries` = 3 rows**, measured against live SQLite on **2026-08-04** during the Postgres
copy census. That is the most recent measurement in the repository. `docs/tacet-consolidation-decisions.md:1351`
corroborates it, describing *a single value* at eleven decimal places as the only one affected by
retyping the column. **Current row count is UNVERIFIED** — no database is reachable from this
checkout, and I did not open the production one.

**Who reads waste data.** Six consumers, all read-only:

1. **The dashboard** — `public/app.html:3950`, `:3994`, `:4011-4013`.
2. **The assistant, four ways** —
   - `routes/ai.js:331-337`, a six-month monthly waste rollup fed into the business-analysis prompt;
   - `routes/ai.js:2223-2246`, the `query_waste` tool, grouping by day, month, reason or product;
   - `routes/ai.js:2365`, `find_anomalies` with `metric = 'waste_cost'`, a z-score over `SUM(cost_lost)`;
   - `routes/ai.js:2488`, a `waste_entries_total` count in the system-health tool.
3. **Admin user deletion** — `routes/admin.js:101` counts `created_by` references to refuse a hard
   delete.
4. **Factory reset** — `routes/admin.js:235` includes `waste_entries` in the wipe list.
5. **The CSV export** — `public/app.html:23575`, period-scoped only.
6. **Diagnostics** — `scripts/diagnose_waste_cost_parity.js` (the gate that proved moving
   `computeProductCost` onto the shared module changed no live number) and
   `scripts/diagnose_free_by_design_conflict.js:124-129`, which counts *"historical waste_entries
   rows … (already-written `cost_lost`, NOT retroactively changed)"*.

**No module reads waste cost into a financial figure.** It never becomes an expense, never reduces
stock, never appears in a margin. Its entire downstream is a dashboard tile, a chart, and the
assistant's prose.

---

## 8 — DEPENDENCIES ON THINGS TACET DOES NOT HAVE YET

*This is the question the migration turns on, so it is answered plainly first and then in parts.*

**Plainly: waste as written today requires Recipes, and Recipes are deferred out of Production Phase 1
(`docs/tacet-consolidation-decisions.md:4000` — "Phase 1 scope: Materials and Purchases only. Recipes
are deferred."). But the dependency is on the cost NUMBER, not on the feature. Everything else waste
does works with nothing Tacet lacks. And a Phase-1-compatible cost source already exists in Tacet —
`store_products.unit_cost` — which the kitchen route does not read.**

**Does waste require Recipes?**
**For its cost, yes; for its existence, no.** The recipe path is one of two branches
(`routes/waste.js:45-62`). Strip recipes out and the code still runs — every entry simply takes the
`sell_price_fallback` branch and books the loss at retail price. That is not a crash; it is a wrong
number that looks right, which is worse. So the choice at migration is not *"can it ship without
recipes"* but *"what does it cost a loss at"*, and there are exactly three answers:

- **`store_products.unit_cost`** — a real column (`database.js:4177`) written by purchase-order
  receiving and by hand in the product editor (`docs/tacet-product-fields.md:300-310` AMENDED
  2026-08-26). **This needs no recipe and is available in Phase 1.** It is the obvious re-point.
- **The recipe path**, ported as-is — needs Recipes, deferred.
- **Sell price** — available always, and wrong.

**Does waste require production batches?**
**No.** Not a single reference exists in either direction (§5). Batch, lot and expiry are absent from
the table entirely (§1.4).

**Does waste require anything else deferred out of Production Phase 1?**
**No.** Its remaining requirements are all things Tacet has today:

| Requirement | Status in Tacet |
|---|---|
| A product master with a sell price | `store_products` — present |
| A per-product cost | `store_products.unit_cost` — present (`database.js:4177`) |
| A logged-in user for `created_by` | present |
| A permission gate | present; `materials:view` / `materials:edit` pattern already decided (`docs/tacet-consolidation-decisions.md:4008`) |
| A tenant on/off switch | pattern already decided — `FEATURE_CATALOG` / `mountFeatureControls` (`docs/tacet-consolidation-decisions.md:4008`) |
| A stock ledger to post the movement to | present (`retail_stock_ledger`, `database.js:2894-2899`) — and it **already reserves `waste` as a reason value**, unused |

**The inverse dependency, which matters more.** Production Phase 1 adds **Materials**. Wasting a
material — a spoiled sack of oats, a crushed box of jars — is the case a Materials module most
obviously implies, and **it does not exist in any form today** (§4). It is net-new work. It is also
the *easier* of the two: a material's cost is `ingredients.cost_per_unit`, a stored scalar that
needs no recipe, no batch and nothing deferred. **Material waste is Phase-1-compatible; product
waste as currently costed is not.**

**One scoping note.** §21 lists eight modules and does not list Waste
(`docs/tacet-consolidation-decisions.md:584-588`). `docs/tacet-ia-blueprint.md` contains the string
"waste" **zero times**, so waste has no assigned archetype and no batch in the 34-page build order
(`docs/tacet-desktop-patterns.md:1424-1445`). Whichever archetype it lands in — A7 Report for the
charts, A1 Worklist for the log, or a Console-style entry form folded into Materials — is an open
choice, and the §6 new-feature gate (`docs/tacet-desktop-patterns.md:1497-1506`) has not been run on
it.

---

## 9 — BLOCKERS AND HAZARDS

Ordered by how quietly each produces a wrong number.

**H1 · The `products` vs `store_products` id space. This is the migration-breaking one.**
`waste_entries.product_id` references the **kitchen** `products` table (`schema.sql:293`), and the
store-products fork migration deliberately left it there:

`database.js:4355-4357`

```
// Kitchen-owned tables
// (market_stock, market_stock_ledger, miniapp_order_lines, sales_entries,
// sale_addons, waste_entries, restock_items) keep pointing at products.
```

Eight *store-owned* tables were repointed to `store_products` (`database.js:4376-4379`); waste was
not. The two tables were seeded with **matching ids** at fork time (`database.js:4362` —
*"Ids are preserved so existing retail_* rows resolve unchanged"*) but have **separate
`AUTOINCREMENT` primary keys** (`database.js:4064`) and **separate SKU namespaces**
(`database.js:4178-4180`). Every row created on either side since the fork has an id that means
something different on the other. A Tacet waste screen picks from `store_products`; writing that id
into `waste_entries.product_id` either violates the FK or — worse, when the id happens to exist on
both sides — **silently attributes the loss to a different product**. Any migration must decide
explicitly which catalogue owns the reference and, if it re-points, backfill the existing rows
through `store_products.kitchen_product_id` (`database.js:4071`).

**H2 · Packaging is already double-counted upstream, so the deliberate exclusion is incomplete.**
`routes/waste.js:56` removes the recipe's *own* packaging. It cannot remove packaging that is already
baked into an ingredient line's `cost_per_unit`. `docs/packaging-findings.md:36-57` documents exactly
that: a made material's unit cost is *"its recipe's whole batch cost divided by batch size — and the
batch cost includes that recipe's packaging"* (`lib/recipe-cost.js:157-159` →
`lib/recipe-rollup.js:148-149`). Status in that document: **open, live, no code changed.** So a
wasted product whose recipe consumes a made material is costed with that material's packaging
included, which is precisely what `routes/waste.js:28-35` believes it is preventing.

**H3 · No unit reconciliation between a recipe line and its ingredient.**
`lib/recipe-cost.js:73` computes `qty × costPerUnit` with no check that `recipe_ingredients.unit`
matches `ingredients.unit`. `master_unit` is selected at `:96` and never read. A line entered in kg
against an ingredient priced per gram is off by 1000× and nothing warns. §7 of the decisions record
says *"Recipes always use the item's stocking unit"* (`docs/tacet-consolidation-decisions.md:383`) —
a rule stated in prose and enforced nowhere in this path, and the §7 addendum of 2026-08-26 requires
the system to **refuse** a conversion it cannot state a factor for.

**H4 · Every date on this path is UTC; the business runs at UTC+8.**
`routes/waste.js:66`, `:69`, `:98`, `:112`, `:120` all use `new Date().toISOString().slice(0,10)`,
and `created_at` defaults to SQLite `CURRENT_TIMESTAMP` (`schema.sql:291`), also UTC.
`docs/tacet-core-survey.md:615-627` records this as risk **R3**: the store side normalises to +8 in
dozens of places, the production side in none, so *"a row created between 00:00 and 08:00 local is
dated to the previous day on the Production side and the correct day on the Sales side."* Waste's
"today", its 7/30-day cutoffs and its daily buckets are all on the wrong side of that line. Merging
waste into a Tacet dashboard that already computes +8 produces two totals that never reconcile.

**H5 · `cost_lost` is a snapshot and is never recomputed.**
Written once at `routes/waste.js:171` and read thereafter as fact. Correcting an ingredient price,
a recipe or a sell price does not move a historical row —
`scripts/diagnose_free_by_design_conflict.js:129` names this explicitly (*"already-written
`cost_lost`, NOT retroactively changed"*). That is defensible for an accounting record and
indefensible for the three-row live table if any of those three rows was written on the fallback
path. Which rows are on which path: **UNVERIFIED** — `cost_source` is nullable and pre-migration
rows hold `NULL`.

**H6 · A zero-cost waste row saves silently.** §3.5. The form warns; the submit does not block; the
API does not require a cost. The KPI tiles then show a total that is quietly short.

**H7 · `unit` is a lie of convenience.** Both client paths hardcode `'pcs'`
(`public/app.html:23423`, `:23563`) and the server defaults to it (`routes/waste.js:181`). Nothing
reads the per-product weight (`products.weight` is free text — `schema.sql:158`). A weighed product
wasted by mass cannot be recorded truthfully, and the CSV export prints `pcs` regardless
(`public/app.html:23587`).

**H8 · `qty` is `REAL` but the UI is integer-only.** `min="1" step="1"` in both forms
(`public/app.html:23093`, `:23482`). Half a tray cannot be entered from the screen; the API accepts
it (`routes/waste.js:154-156`). A Tacet screen built from the API's contract and one built from the
current screen's behaviour will disagree.

**H9 · No duplicate guard and no idempotency.** Two taps of *Log Waste* write two rows. Bulk entry is
N independent HTTP requests in a `for` loop (`public/app.html:23559-23566`) with a tally of successes
and failures and no rollback — a partial submit leaves partial rows and the user is told
*"5 logged · ⚠ 2 failed"* with no way to see which two.

**H10 · Delete is a hard delete with no content in the audit trail.**
`routes/waste.js:192` removes the row; `:194` logs the action with `details = null`. The row's
product, quantity and cost are gone from every record. The create log does carry them (`:184`), so a
deleted entry is reconstructable only by pairing two log rows by entity id. Worth contrasting with
`docs/tacet-consolidation-decisions.md` §20 (deletion policy) and the glossary's ARCHIVED state,
which the waste table has no equivalent of.

**H11 · `cost_source` is write-only.** Grep across the repo finds it written at
`routes/waste.js:168-184` and read by **nothing** — no route, no screen, no script, no export. The
COGS reconciliation it was added for (`database.js:174-175`) does not exist. It is still the right
column to keep; it is not yet doing anything.

**H12 · `retail_value` is written and almost never read.** Only the CSV export
(`public/app.html:23590`). The summary endpoint does not aggregate it (`routes/waste.js:103-148`), so
the dashboard's *"% of sales"* line (`public/app.html:4013`) divides **cost** by revenue, not retail
value. Whether that is the intended ratio is a product question this survey cannot settle —
**UNVERIFIED**.

**H13 · A waste-only user gets an empty product picker and no error.**
The API is gated on `waste` (`routes/waste.js:74`), but the picker calls `GET /api/products`, which
is gated on `products` (`routes/products.js:49`). `renderWaste` swallows the 403 —
`_wasteProducts = d.data || []` (`public/app.html:23050`) — leaving a type-ahead that matches
nothing and never explains why. The default permissions row grants `waste` (`schema.sql:37`,
`DEFAULT 1`) and denies `products` (`schema.sql:32`, `DEFAULT 0`), so **this is the default
configuration**, not an edge case.

**H14 · Soft-deleted products can still be wasted through the API.**
`routes/waste.js:42` and `:159` select from `products` with no `is_active` filter, while the picker
only ever shows active rows (`routes/products.js:67`). A stale client, a script or a replayed request
can log waste against a product the catalogue considers deleted.

**H15 · `date` is unvalidated server-side.** `routes/waste.js:155` checks only that it is truthy. The
UI caps it at today (`public/app.html:23081`); the API does not. Any string lands in a `DATE` column
that SQLite does not type-check, and period filtering is a string comparison (`:80`), so a malformed
date silently escapes every filter and every bucket while still counting toward `SELECT *`.

**H16 · `GET /api/waste` with no `period` returns the entire table, unpaginated.**
`routes/waste.js:76-86` — no `LIMIT`, no offset. Harmless at three rows; not harmless after a year
of daily logging by a business that actually uses it.

**H17 · No account scoping.** `waste_entries` has no `tenant_id` (`schema.sql:277-295`) and no route
filters by one. Every multi-account table in the platform carries one. This must be added before the
table is shared.

**H18 · The assistant's help text describes a feature that does not exist.** `routes/ai.js:1329-1331`
— §4. Migrating the screen without correcting this leaves the AI confidently instructing users to
waste an ingredient.

**H19 · One stale comment, doc-only, worth fixing while nearby.**
`lib/recipe-cost.js:24-28` still says waste *"does not yet read `free_by_design`"*. It does — since
`routes/waste.js:51` was moved onto the shared module, which reads the flag at
`lib/recipe-cost.js:96`. `routes/waste.js:17-24` records the fix. No behaviour is affected.

**H20 · Money precision, for the record.** `cost_lost` is `REAL` yuan and is a **division result**
(`routes/waste.js:57`), so it carries float residue by construction —
`docs/tacet-consolidation-decisions.md:1351` cites a live value at eleven decimal places. The
Postgres rebuild would have retyped it to `numeric(14,6)` (`:819`); that migration is cancelled, so
`REAL` stays. Not urgent at three rows; it is the reason the column must never be summed against a
cents column.

---

## What this survey does not settle

- **Current live row count, and how many rows are on the fallback path.** No database was opened.
  The last measurement in the repo is 3 rows on 2026-08-04
  (`docs/tacet-money-model-survey.md:155`). **UNVERIFIED** as of today.
- **How many products carry a `recipe_id`**, and therefore what proportion of future waste entries
  would take the recipe path rather than the sell-price fallback. **UNVERIFIED** — this decides
  whether H1's re-point to `store_products.unit_cost` is an improvement or a regression, and it
  cannot be answered from code.
- **Whether the dashboard's "% of sales" should divide cost or retail value** (H12). A product
  decision, not a code fact.
- **Which archetype the Tacet waste screen should be.** Waste is absent from
  `docs/tacet-ia-blueprint.md` entirely; the §6 new-feature gate has not been run.
- **Whether waste should post a stock movement in Tacet.** §10 of the decisions record says every
  stock change writes to the ledger; whether a waste entry *is* a stock change is a decision nobody
  has recorded, and the ledger already reserves the word (`database.js:2899`) without anyone having
  chosen to use it.
