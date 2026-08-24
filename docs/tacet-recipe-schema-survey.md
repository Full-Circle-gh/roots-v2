# Recipe survey — schema, routes, UI, vocabulary, volume

**2026-08-24 · read-only survey.** Scope note carried over from the task: Recipes are **not** being linked to retail Products or the storefront in this phase — that connection is deliberately deferred, so this survey does not investigate storefront/product-pricing implications. It answers one question set: what a recipe IS today, and what generalising it into a Tacet module (the way Ingredients became Materials) would touch. No design proposals, no build plan.

---

## 1. Schema

### Tables

**`recipes`** — schema.sql:86-101, plus three columns added later by migration.

| column | type | notes |
|---|---|---|
| id | INTEGER PK | |
| name_en | TEXT NOT NULL | |
| name_cn | TEXT | |
| sku | TEXT UNIQUE | |
| category | TEXT | free string, matched against `categories` kind='recipe' in the UI, not FK'd |
| batch_size | REAL | total grams per batch |
| servings | INTEGER | |
| serving_size | REAL | grams per serving |
| shelf_life | TEXT | |
| storage | TEXT | |
| notes | TEXT | |
| is_active | INTEGER DEFAULT 1 | soft-delete flag |
| created_at / updated_at | DATETIME | |
| is_favorite | INTEGER DEFAULT 0 | database.js:54 |
| image_data | TEXT | base64 data URI, database.js:68 |

**`recipe_ingredients`** — schema.sql:103-116, plus one migrated column.

| column | notes |
|---|---|
| id, recipe_id | `FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE` (schema.sql:114) |
| ingredient_id | nullable; `FOREIGN KEY (ingredient_id) REFERENCES ingredients(id)` — **the only FK target**, see §Q1 below |
| name_en, name_cn, sku | snapshot of the ingredient at the time the line was added |
| qty, unit | |
| notes | |
| sort_order | drag-reorder position |
| substitutes | TEXT, database.js:69 |

**`recipe_steps`** — schema.sql:118-125: id, recipe_id (CASCADE), step_number, name, instructions.

**`recipe_cost_data`** — schema.sql:127-138: id, recipe_id (UNIQUE, CASCADE), labour, packaging (per serving), packaging_type_id, overhead_pct, sell_price, target_food_cost (default 30), updated_at. Holds only the four **manual** inputs — no cost column exists here or anywhere else; every actual figure is derived at read time (see §2).

**`production_batches`** — schema.sql:328-345 (the kitchen production log, not a recipe table per se but the only table besides `products` that references `recipes.id`): date, recipe_id (nullable — "recipe might be deleted later"), recipe_name/recipe_sku (snapshot), batches_made, servings_made, staff_name, shift, notes, created_by.

**`categories`** where `kind='recipe'` — schema.sql:418-425: id, kind, name, sort_order, created_at, `UNIQUE(kind, name)`. Generic lookup table shared with `kind='product'` and others (routes/lookups.js:46 `VALID_KINDS`).

**`packaging_types`** — schema.sql:374-381, plus image_data (database.js:76): id, name, name_cn, cost, image_data, created_at. Referenced by `recipe_cost_data.packaging_type_id`.

Related but outside the recipe tables themselves: **`ingredients`** gained `item_kind TEXT DEFAULT 'food'` (database.js:393) specifically so "the recipe picker filters to item_kind='food' so non-food items don't leak into recipes" (database.js:391-392) — see §Q1c.

### Q1 — Does a recipe have a direct FK to a product/menu item?

**Yes, on one table, not on the other — and this is the single fact that matters for scoping "don't connect to Products yet."**

- `products.recipe_id INTEGER` — schema.sql:147, `FOREIGN KEY (recipe_id) REFERENCES recipes(id)` (schema.sql:162). `products` is the kitchen/menu-item table (distinct from the storefront's own catalog, see below), and this FK is live and actively used:
  - `routes/products.js:12,37,66,157,183-209` — every product read JOINs recipes through it and pulls the recipe's cost breakdown.
  - `routes/waste.js:16-29` — waste cost calc reads `products.recipe_id` → `recipes` → `recipe_cost_data` to compute a wasted unit's cost (deliberately excluding packaging).
  - `routes/admin.js:441-487`, `routes/ai.js:1741-2517` (AI tool schema, `products_with_recipe_link` diagnostic) also read/write it.
  - `public/app.html:9567,9655,10221-10233,12117-12148,12826,15151` — the product edit form has a "Linked Recipe 关联食谱" select (12142) with a "⤓ Pull from recipe" button (12148) that copies recipe fields (allergens etc.) into the product.
- `store_products` — the storefront's own forked catalog — **deliberately dropped this FK when it was forked from `products`.** database.js:3896-3897: *"The only dropped constraint is the inline FK to recipes(id) — the store has no recipes (allergens live in the editable `free_of` column instead)."* Store products carry no `recipe_id` at all.

So: the link from a recipe to a *kitchen menu item* already exists and is load-bearing (cost calc, waste calc, AI tools). The link from a recipe to a *retail/storefront product* was already cut, on purpose, when the storefront catalog forked. "Not connecting Recipes to retail Products yet" therefore means *nothing changes* on the storefront side (already decoupled) — it does **not** mean touching or hiding the existing `products.recipe_id` FK, which is kitchen-internal and out of this phase's way regardless.

### Q2 — Can a recipe's output be consumed as an ingredient in another recipe today?

**No. This is new ground, not existing schema.**

`recipe_ingredients.ingredient_id` has exactly one FK target: `ingredients(id)` (schema.sql:115). There is no `recipe_ingredients.sub_recipe_id` or equivalent, and grepping every `recipe_id` reference in the codebase (routes, database.js, app.html) turns up no case of a recipe referencing another recipe as a component. The ingredient-row autocomplete in the recipe form enforces this explicitly:

```
// app.html:7263-7267
// Recipes can only contain food items — packaging / equipment / retail
// never go into a recipe. The Items page shows everything; this picker
// is the one place we narrow it. quickCreateIngredient also stamps
// item_kind='food' so anything created from here lands in the right tab.
const matches = _ingredients.filter(i => (i.item_kind || 'food') === 'food').filter(matchTokens).slice(0,8);
```

The picker's universe is `_ingredients` filtered to `item_kind==='food'` — never `_recipes`. There is no code path by which a recipe becomes a selectable line in another recipe.

That said, the *idea* is already recorded as a planning decision, unbuilt: `docs/tacet-consolidation-decisions.md:293-303` (§6 "Production"):

> Multi-level, any depth. Real-world depth today is three levels. A recipe may produce an item or a product. Cost rolls up through levels. … Recipe output is FIXED. A recipe states its output quantity and a batch produces exactly that amount.

This is the "bulk sauce made once, used in three other things" case from earlier planning — it is written down as intent, but nothing in `schema.sql`, `database.js`, `routes/recipes.js`, or `app.html` implements it. Building it means adding the self-reference (and deciding unit/conversion, output-fixed-vs-input-actual semantics, and cost roll-up), not un-hiding something already there.

### Q3 — Yield/batch-size vs. per-unit cost

Yes, and they are cleanly separate concepts, one stored and one derived:

- **Stored**: `batch_size` (total grams the recipe yields), `servings` (count), `serving_size` (grams per serving) — three independent columns on `recipes` (schema.sql:92-94).
- **Derived, never stored**: `costPerGram = batchCost / batchSize` and `costPerServing = batchCost / servings`, computed fresh on every read (`lib/recipe-cost.js:141-143`). `recipe_cost_data` never holds a cost figure of any kind — only the four manual inputs (labour, packaging, overhead_pct, sell_price) plus `target_food_cost`.

---

## 2. Routes — `routes/recipes.js`

All under `requireAuth, requirePermission('recipes')` unless noted.

| Method & path | Line | What it does |
|---|---|---|
| `GET /api/recipes` | 12 | List, active only, favorites first then A–Z. `count_only=1` for the dashboard KPI tile (17-22). Search over name_en/name_cn/sku. |
| `PUT /api/recipes/:id/favorite` | 32 | Toggle `is_favorite`. |
| `GET /api/recipes/trash` | 45 | Soft-deleted recipes, with a live `ingredient_count` subquery. Must be declared before `/:id` (Express route-order comment at 40-42). |
| `GET /api/recipes/export` | 70 | Excel export, 3 sheets (Recipes / Ingredient Lines / Ingredient Prices), computed via `computeRecipeCost()` — explicitly read-only, no cache-back (comment 56-63). |
| `GET /api/recipes/:id` | 266 | Full recipe + ingredients (LEFT JOIN ingredients for cost/free-flag) + steps + cost data. |
| `POST /api/recipes` | 276 | Create, with nested `ingredients[]`/`steps[]` insert in the same handler (no transaction wrapper on create, unlike update/duplicate). SKU-collision error distinguishes "belongs to a deleted recipe" from "already used." |
| `PUT /api/recipes/:id` | 309 | Update; replaces ingredients/steps wholesale (DELETE + re-INSERT) if arrays are present in the body. |
| `PUT /api/recipes/:id/cost` | 340 | Upsert `recipe_cost_data` (ON CONFLICT). |
| `DELETE /api/recipes/:id` | 350 | Soft delete (`is_active=0`). |
| `PUT /api/recipes/:id/restore` | 359 | **The restore/unarchive endpoint — confirmed, still present, exact route unchanged.** Flips `is_active` back to 1; no-ops with `already_active:true` if already active. Children (ingredients/steps/cost) were never touched on delete, so restore is a single column flip (comment 356-358). |
| `DELETE /api/recipes/:id/permanent` | 372 | Hard delete, admin-only (`req.user.role !== 'admin'` check inline, not middleware), refuses unless already soft-deleted, cascades ingredients/steps/cost in a transaction. |
| `POST /api/recipes/:id/duplicate` | 393 | Clone (no SKU — unique constraint), with optional `scale` multiplier applied to batch_size/servings/every ingredient qty and (proportionally) labour — feeds the UI's "Save as New Recipe" batch-scaler button. |
| `POST /api/recipes/bulk` | 465 | Bulk import, array of recipe objects with nested ingredients/steps, SKU-match or name-match to link `ingredient_id`, skips rows whose SKU already exists, transaction-wrapped. |

**Ingredients restore comparison, re-confirmed:** `routes/ingredients.js` has **no** `/trash` or `/restore` route — grepped, only hit is an unrelated comment mentioning `restore_recipe_data.js` (line 312). Ingredient delete is soft (`UPDATE ingredients SET is_active = 0…`, routes/ingredients.js:295) but there is no UI or route path back from that state short of a hard bulk-wipe/reimport. Recipes have the full soft-delete → trash list → restore round trip; ingredients only have the soft-delete half.

### How is recipe cost computed?

**Separate logic from `lib/ingredient-cost.js` — different job entirely.** `lib/ingredient-cost.js` computes one number: an ingredient's `cost_per_unit` (¥/g or ¥/piece) from a purchase price, used by Materials/Purchasing write-back. `lib/recipe-cost.js` is a completely different computation — it reads an ingredient's *already-computed* `cost_per_unit` and rolls it up into a recipe's batch/serving/gram cost. Recipe cost is **not** computed by a single canonical function used everywhere; per the header comment in `lib/recipe-cost.js:1-22`, it exists in **four separate copies**:

1. `public/app.html` `viewRecipe()` ~6483-6506 — recipe detail card
2. `public/app.html` `showCostSheet()`/`renderCS()` ~7660-7673 — the Cost Sheet modal
3. `public/app.html` product detail block ~9523 (not surveyed here — out of scope per the storefront/product note)
4. `lib/recipe-cost.js` `computeRecipeCost()` — used **only** by the Excel export route (`GET /api/recipes/export`)

Plus a deliberately *different* fifth: `routes/waste.js` `computeProductCost()`, which excludes packaging (packaging is reused when a unit is wasted, so it shouldn't count as lost cost). The module's own comment (lib/recipe-cost.js:18-22) is explicit that consolidating these onto one function is a separate, not-yet-done job, because any drift between the four is user-visible money.

---

## 3. Live UI

### List view — `renderRecipes()`, app.html:6279-6323

Route: navigate to `recipes` (nav item `{ id:'recipes', label:'Recipes · 食谱', iconKey:'book' }`, app.html:2591). Page header **"RECIPES · 食谱库"** (6286) with buttons: Trash 回收站 (6288), Import CSV 导入 (6289), Export Excel 导出 (6290), + 新建食谱 New Recipe (6291). Search box + category-filter `<select>` populated live from `_recipes.map(r=>r.category)` (6297-6300, not from the categories table — the filter only shows categories actually in use). Table columns: favorite star toggle · SKU 编号 · English Name 英文名 · Chinese Name 中文名 · Category 分类 · Batch 批次 · Servings 份数 · edit/delete icon buttons (6307). Row click opens the detail view; the star and action buttons `stopPropagation()`.

### Detail view — `viewRecipe()`, app.html:6475-6696

Header: back button, photo thumbnail if set, favorite-star + name/name_cn, SKU/category subline, then Print 打印 / Duplicate 复制 / **💰 Cost Sheet** / Edit 编辑 buttons (6508-6521).

Two-column info row (6525-6621):
- **Recipe Info card** — Batch Size, Servings, Serving Size, Shelf Life, Storage, plus an allergen-chip row computed by unioning every ingredient's `allergens` field (6535-6549).
- **Cost summary card** — a dark headline block showing **"Total Batch Cost"** (¥ figure) with a **"¥X / serving"** subline (6571-6573), a With-Pkg/No-Pkg toggle (6576-6579), a segmented cost bar (Ingredients/Labour/Overhead/Packaging, 6560-6590), then a line-item breakdown table repeating Ingredients, Labour, Overhead, Packaging, Without/With Packaging totals (each with a per-serving figure alongside), Margin/serving, Food Cost % (6591-6600). **So batch cost and per-serving cost are shown together, side by side, everywhere this card appears** — never one without the other when servings is set.

**Batch Scaler** (6624-6644) — a separate card with ×1/×2/×3/×4/×5/×10 quick-multiplier buttons plus a free-text target-batch-grams input, live-updating a `scaledQty`/`scaledCost` pair of columns in the ingredients table below (mutates DOM in place rather than re-rendering — comment 6712-6715) and exposing "Save as New Recipe" (calls `duplicate` with `scale`).

**Ingredients table** (6647-6683) — columns SKU 编号, Name 名称, Qty 数量 (+ hidden Scaled Qty column), Unit 单位, Cost/unit 单价, Line Cost (+ hidden Scaled Cost column), row click → `navigateToIngredient()` (opens the ingredient record). **No nested-recipe row type exists here** — every row is an ingredient line; this matches the schema finding in Q2. A missing-cost warning banner appears when any line has no priced cost (6650).

**Steps** (6686-6695) — numbered circles, name + instructions, only rendered if `rec.steps.length`.

### Add/edit form — `showRecipeForm()`/`renderRecipeFormContent()`, app.html:7025-7237

An overlay with five card sections:
1. **Basic Info 基本信息** (7062-7078): English Name*, Chinese Name, SKU, Category `<select>` sourced from `_recipeCategories` + a "Manage 管理" button opening the category manager.
2. **Batch Info 批次信息** (7081-7111): Batch Size (g) — auto-computed from ingredient weights unless manually overridden (`_batchManualOverride`), Serving Size (g), Servings (auto-calculated, `recipeCalcServings()`), Shelf Life (number + Days/Months/Years unit picker), Storage (fixed 3-option select: 4°C Fridge / -18°C Freezer / Room Temperature).
3. **Recipe Photo 食谱图片** (7114-7129): click-to-upload thumbnail, 3 MB cap.
4. **Ingredients 食材** (7131-7144, rows rendered by `renderIngRowsUI()` 7164-7182): draggable rows, each with SKU input + combined "Name EN / 中文" input, both wired to `showRFAC()` autocomplete **restricted to `item_kind==='food'` ingredients** (the Q2/Q1c finding), Qty, Unit `<select>` (g/kg/ml/L/pcs/bag/box/bottle/tbsp/tsp), Notes, remove button.
5. **Steps 制作步骤** (7147-7153, `renderStepRowsUI()` 7184-7196): draggable numbered rows, name + instructions textarea.

Save 保存食谱 / Cancel 取消 (7155-7157).

### Cost Sheet — `showCostSheet()`/`renderCS()`, app.html:7639+

A separate, editable overlay (distinct from the read-only card on the detail view): **成本表 Cost Sheet** header, Ingredients Subtotal 食材小计 line, then an **Additional Costs 附加成本** card with editable Labour ¥ 人工成本, Packaging Type 包装类型 (`<select>` of `packaging_types` rows with cost + thumbnail, or custom), Overhead % 间接费用. Below that, a 4-tile **Batch summary**: **批次总成本 Total Batch Cost**, **每份成本 Cost Per Serving**, **每克成本 Cost Per Gram**, **售价毛利 Margin at Sell Price** (7719-7739) — **so the display explicitly covers per-batch, per-serving, AND per-gram simultaneously**, not just per-batch/per-unit. Then a Sell Price & Food Cost % card: Sell Price/Serving, Target Food Cost %, read-only Suggested Sell Price, plus a colour-coded food-cost-% bar (green <25%, amber 25–35%, red >35%).

### Trash — `_renderRecipeTrash()`, app.html:7558-7627

**Recipe Trash · 食谱回收站** modal, table of SKU/name/ingredient count/deleted-at, each row with **↩ Restore 恢复** (calls `PUT /api/recipes/:id/restore`) and, admin-only, **💥** permanent-delete. Copy: *"Deleted recipes live here. Click Restore to bring one back — its ingredients, steps, and cost data are preserved."*

### Nested-recipe-as-ingredient UI

None exists, consistent with the Q2 schema finding — there is no picker, tab, or row type anywhere in the recipe form or detail view that lets a recipe be selected as a component of another recipe.

---

## 4. Vocabulary

Pulled verbatim from live `app.html` source, not composed:

- Nav item: `label:'Recipes · 食谱'` (app.html:2591)
- Page title: `RECIPES · 食谱库` (app.html:6286) — i.e. "recipe library," the same `‑库` suffix pattern as `物料库` (Materials library) from the earlier Ingredients→Materials survey.
- New-recipe command: `New Recipe · 新建食谱` (app.html:4135)
- Singular term used throughout error/toast copy: **食谱** (shípǔ) — e.g. "Recipe not found · 食谱未找到" (routes/recipes.js:361,375), "Could not load recipe · 无法加载食谱" (app.html:6333), "Recipe name is required · 食谱名称必填" (app.html:7441). No competing term (e.g. 配方) appears anywhere in `app.html` — 食谱 is the exclusive live label.
- **Recipe category**, as a distinct labelled concept: **食谱分类** — "Recipe Categories 食谱分类" is the header of the dedicated category-manager modal (app.html:15623, function `renderCatManagerContent()`), reached via the "Manage 管理" button next to the Category field on the recipe form (app.html:7075).
- Batch/serving cost labels used on-screen (Cost Sheet): 批次总成本 Total Batch Cost, 每份成本 Cost Per Serving, 每克成本 Cost Per Gram, 售价毛利 Margin at Sell Price, 食材成本率 Food Cost %, 食材小计 Ingredients Subtotal, 附加成本 Additional Costs (app.html:7679-7757).

### Seeded recipe categories

The live source of truth is the `categories` table (`kind='recipe'`), seeded once by `database.js:759-763` (migration `lookups_seed_v1`) with exactly this array, each entry an EN+CN pair joined in one string:

```
'Dips & Spreads 酱料', 'Salads 沙拉', 'Hot Dishes 热菜', 'Cold Dishes 冷菜',
'Baked Goods 烘焙', 'Beverages 饮料', 'Snacks 小食', 'Sauces & Condiments 调味',
'Desserts 甜点', 'Other 其他'
```

**That's 10, not 13.** Two things are worth flagging rather than silently reconciling:
- The client has its own hardcoded fallback default at `app.html:2286-2290` — 10 entries again, but not the *same* 10: it has `'Sauces 调味汁'` (not "Sauces & Condiments 调味"), `'Desserts 甜品'` (not "甜点"), `'Breads 面包'` (not seeded server-side at all), and drops `'Other 其他'` entirely. In practice this fallback is overwritten on every page load by a live `fetch('/api/categories/recipe')` (app.html:2469,2505) and only survives if that fetch fails, so it's not what a user normally sees — but it is a second, drifted copy of the same list sitting in the codebase.
- The category list is fully admin-editable at runtime (`POST`/`DELETE /api/categories/recipe`, routes/lookups.js:54-71, backing the "Manage 管理" UI at app.html:15612-15650) with no ceiling — so a live install could easily hold 13 rows today even though the seed only ever inserted 10. This survey has no live database attached (see §5) to confirm the current count directly.

All ten seeded names are food-specific ("Dips & Spreads," "Hot Dishes," "Cold Dishes," "Baked Goods," "Sauces & Condiments") the same way `item_kind`'s original categories were — this is the generalisation question the earlier `item_kind` work (database.js:393, 398-420) already solved once for Materials, and it would recur here if Recipes' categories need to speak to a non-food Production tenant.

---

## 5. Volume

**No live database is attached to this survey session** — there is no `roots.db` (or any `.db` file) in this container, and no DB-query tool is available, so none of the row-count / orphan questions below can be answered by direct query. What follows is what the code itself implies, clearly separated from anything measured live.

- **Recipe count**: `lib/recipe-cost.js:94` documents the export route's approach as *"reads all 85 recipes in three queries instead of 255"* — an **undated comment**, so 85 is a snapshot from whenever that line was written, not a current figure. Not independently verified here.
- **Diagnostic queries that exist in code but weren't run**: `routes/ai.js:2476-2480` — the AI assistant's own db-diagnostic tool computes exactly the numbers this section wants: `recipes_active`, `recipes_total` (COUNT with/without the `is_active` filter) and `products_with_recipe_link` (`COUNT(*) FROM products WHERE is_active=1 AND recipe_id IS NOT NULL`). `routes/ai.js:2509` also groups recipes by category. These are the queries to run against the live box for real Q5 numbers — this survey cannot run them.
- **A dated, adjacent figure**: `docs/tacet-consolidation-decisions.md:323`, dated today (2026-08-24), records *"145 of the 630 rows in `ingredients` are already `item_kind = packaging`"* — a real, current ingredient-table count, but no comparable recipe-table figure sits next to it in that document.
- **Products referencing a recipe**: no count available here; `products_with_recipe_link` above is the exact live query for it (out of scope to run/interpret further per the storefront note, but it exists and is cheap).
- **Recipe categories row count**: unknown live; 10 were seeded (§4).

### Orphans

Structurally, the schema makes classic orphaning hard to produce through normal use, though the comments use looser language than the mechanics:

- **`recipe_ingredients` pointing at a deleted recipe**: schema.sql:114 gives `recipe_id` `ON DELETE CASCADE`. A recipe's *hard* delete (`DELETE /api/recipes/:id/permanent`, routes/recipes.js:372-386) explicitly deletes `recipe_ingredients`/`recipe_steps`/`recipe_cost_data` first inside a transaction anyway, so the CASCADE is a backstop, not the only guard. A recipe's normal (soft) delete never touches `recipe_ingredients` at all. Net: this kind of orphan should not occur through the app's own routes.
- **`recipe_ingredients` pointing at a deleted ingredient**: the schema comment says *"NULL if ingredient deleted"* (schema.sql:106) but this is aspirational/imprecise — nothing in the code ever nulls `recipe_ingredients.ingredient_id`. In normal use, ingredient delete is **soft** (`UPDATE ingredients SET is_active=0`, routes/ingredients.js:295), so the FK target still exists, just inactive; `recipe_ingredients` rows keep resolving via `LEFT JOIN ingredients` (routes/recipes.js:269, lib/recipe-cost.js:75-79) and fall back to their own snapshot `name_en`/`name_cn`/`sku` columns if the join comes back empty. A genuine hard-delete of `ingredients` rows only happens inside the admin-only bulk-import wipe path (routes/ingredients.js:338-348), which deletes `recipe_ingredients`, `recipe_steps`, `recipe_cost_data` and `recipes` in the same transaction, *before* wiping `ingredients` — so even that path can't leave a dangling `ingredient_id` behind.

No live query was run to confirm zero orphans in practice; the above is what the write paths make possible, not a measurement.

---

## Files touched by this survey (for reference)

`schema.sql`, `database.js`, `routes/recipes.js`, `routes/ingredients.js`, `routes/products.js`, `routes/waste.js`, `routes/lookups.js`, `routes/admin.js` (grep only), `routes/ai.js` (grep only), `lib/recipe-cost.js`, `lib/ingredient-cost.js` (grep only), `public/app.html`, `docs/tacet-consolidation-decisions.md`, `docs/tacet-glossary.md`, `docs/tacet-money-model-survey.md`, `docs/tacet-schema-change-survey.md`.
