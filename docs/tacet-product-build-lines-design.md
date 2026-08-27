# Product build lines — design

**v1.0 · 2026-08-27 · DESIGN ONLY. No code was written. Nothing here is built.**

**The survey this answers:** `docs/packaging-findings.md` Appendix B (2026-08-27). Every number
below comes from it or from a fresh live-DB query cited in place, and nothing established there is
re-derived here. **Governing decisions:** `docs/tacet-consolidation-decisions.md` §29 (a made thing
is a material), §29's second addendum (which of a recipe's costs travel), §31 (product unit cost —
contents plus packaging), §28 (materials build route — generalise the kitchen machinery).

**Decided before this document and not reopened here** (repeated from the brief so this document
reads standalone): anchor is `store_products`, not kitchen `products`. One build list per variant —
each variant is already its own `store_products` row. Build lines point at `ingredients`, never
`packaging_types`. Packaging is not special — one mechanism underneath, grouped for display only.
Same shape for made and bought-in. `unit_cost` stays a stored column, recomputed on write, not
computed live. Recipe cost goes food-only in the same change that lands build lines.

**Out of scope, deliberately.** The screen (Step 3) — Claude Design is briefed separately; nothing
here proposes a UI. The write path and migration script (Step 2). The recipe-cost-strip and
writer-switch (Step 4). Retiring `packaging_types` (Step 5). This document is the schema and the
mechanism those steps build against.

---

## 1 · The table

```sql
CREATE TABLE product_build_lines (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    INTEGER NOT NULL,
  ingredient_id INTEGER,               -- NULL if the material is later deleted
  name_en       TEXT NOT NULL,         -- snapshot at time of creation
  name_cn       TEXT,
  sku           TEXT,
  qty           REAL NOT NULL,
  unit          TEXT DEFAULT 'g',
  notes         TEXT,
  sort_order    INTEGER DEFAULT 0,
  FOREIGN KEY (product_id) REFERENCES store_products(id) ON DELETE CASCADE,
  FOREIGN KEY (ingredient_id) REFERENCES ingredients(id)
);
CREATE INDEX idx_product_build_lines_product ON product_build_lines(product_id);
CREATE INDEX idx_product_build_lines_ingredient ON product_build_lines(ingredient_id);
```

This is `recipe_ingredients` with `product_id` in place of `recipe_id` — B.12 called it a structural
clone rather than an adaptation, and having read the live schema directly, that holds column for
column. `qty`, `unit`, the material FK with a name/sku snapshot so a line survives the material being
deleted, `sort_order` for display order — everything `recipe_ingredients` carries that a build line
needs, nothing it doesn't.

**One column deliberately dropped: `substitutes`.** `recipe_ingredients.substitutes` is a free-text
alternates field for a kitchen worker mid-batch ("no cumin, use caraway"). A build list is fixed at
product-creation time per the brief's own framing — it is not read live during a production run —
so there is no moment a substitute would ever be consulted. Left out rather than copied for parity;
trivial to add later if that reading is wrong.

**No `line_kind` / packaging flag column.** §8 asks for packaging to display separately while staying
one mechanism underneath. The material's own `ingredients.item_kind` (`'food'` / `'packaging'` /
`'equipment'` / `'retail'` / `'other'`) already answers that question — it is what
`routes/retail-materials.js:139-141` and `public/app.html:7300` already read to classify a line as
packaging or not, for the very reason B.10/B.11 exists to name. Duplicating that classification onto
`product_build_lines` would create a second copy that can disagree with the material's own kind — the
exact drift pattern B.11 found between `packaging_types` and `ingredients`. The screen groups by
joining to `ingredients.item_kind` on read; the table stores nothing about grouping.

**Write pattern: delete-all-and-reinsert on product save**, mirroring
`routes/recipes.js:324,359-360` (recipe save does the identical thing to
`recipe_ingredients`). Simpler than diffing existing rows against a submitted list, and it is the
established pattern for exactly this parent/child shape in this codebase — Step 2 should not invent a
second one.

**`product_id` is `store_products.id`, always.** Per the anchor decision: every variant is already a
distinct, permanent `store_products` row (B.6 — Maple Cinnamon Almond Butter's two sizes are ids 268
and 305, no synthetic grouping needed), so "one build list per variant" costs nothing structurally —
each variant's build list is just the rows where `product_id` equals that variant's own id.

## 2 · Cost roll-up and unit conversion

**`lib/ingredient-cost.js` needs zero changes** — B.13 confirmed this from the file itself: every
function operates on a bare `ingredients` row plus a price, nothing about `recipe_id` appears
anywhere in it. A build line for "1 × 300ml plastic box" and one for "250g of a material" call the
same `deriveCostPerUnit`/`gramsPerBuyUnit` a recipe line calls today. Confirmed again reading the file
directly for this document: `PER_PIECE_RECIPE_UNITS` already includes `pcs`/`bag`/`bottle`/`box`,
which is exactly the unit a packaging build line will carry — a box's build line reads `qty=1,
unit='pcs'`, and its material's `cost_per_unit` is already the whole pack price undivided (the
`per_piece` branch, `lib/ingredient-cost.js:137-141`). **No new unit-conversion logic is needed for
packaging lines at all — the existing per-piece branch already does the right thing**, because a
recipe consuming one box and a product build list consuming one box are the identical fact.

**The layer above it — `lib/recipe-cost.js`'s `buildLines()` and `unitsReconcilable()` — needs
exporting, not rewriting.** Read directly for this document (`lib/recipe-cost.js:117-169`):

- `unitsReconcilable(lineUnit, stockUnit)` (`:117-122`) and `buildLines(ingredients)` (`:131-169`)
  are both private — absent from the file's exported `API` object (`:374`,
  `const API = { computeRecipeCost, MATERIAL_COST_COMPONENTS };`).
- `buildLines()`'s actual signature takes an array of
  `{ingredient_id, qty, unit, master_cost, master_unit, master_free, name_en, sku}`-shaped objects.
  Nothing in it reads `recipe_id`, `servings`, or `batch_size` — it is the line-level multiply-and-sum
  step, already generic over its caller. It also already carries the §7-addendum dimension check
  (mass vs. volume vs. count) that stops a volume line being priced as if it were a weight — exactly
  the guard a build line needs, since a build list mixes weight lines (food) with count lines
  (packaging) in the same list.
- `computeRecipeCost()` itself is the layer that IS bound to the recipe schema — it loads via
  `recipe_id`-keyed SQL and folds in `labour`/`packaging`/`overhead_pct`/`servings`/`batch_size`, none
  of which a build list has. It is not reusable as-is and should not be extended to try.

**Proposal for Step 2: export `buildLines` from `lib/recipe-cost.js`'s `API` object** (one line,
`const API = { computeRecipeCost, MATERIAL_COST_COMPONENTS, buildLines };`), and add a new sibling
module, `lib/product-build-cost.js`, following the same two-call-shape convention
`computeRecipeCost` already uses:

```js
// lib/product-build-cost.js — sketch, not a diff
const { buildLines } = require('./recipe-cost');

const SQL_LINES = `SELECT pbl.*, i.cost_per_unit AS master_cost, i.unit AS master_unit,
       i.free_by_design AS master_free, i.name_en AS master_name_en
  FROM product_build_lines pbl
  LEFT JOIN ingredients i ON pbl.ingredient_id = i.id
 WHERE pbl.product_id = ?
 ORDER BY pbl.sort_order`;

function computeProductBuildCost(productId, db) {
  const lines = db.prepare(SQL_LINES).all(productId);
  if (!lines.length) return { productId, hasBuildList: false, unitCost: null, lines: [] };
  const { lines: built, ingredientCost, zeroCostLines, unreconciledUnitLines } = buildLines(lines);
  const blocked = zeroCostLines > 0 || unreconciledUnitLines > 0;
  return {
    productId, hasBuildList: true, lines: built,
    unitCost: blocked ? null : ingredientCost,
    zeroCostLines, unreconciledUnitLines,
  };
}
```

**Why there is no servings/batch-size division here, and `computeRecipeCost` needed one:** a recipe
describes a whole batch and divides down to one serving. A build list, per the brief's own framing,
already describes **one sellable unit** — the Zhoug example is "250g Zhoug + 1 box + 1 label," not "a
batch that makes 46 jars." So `unitCost` is the flat sum of `qty × costPerUnit` across the list, no
division step at all. This is a genuine simplification over the recipe path, not a gap.

**Same all-or-nothing block discipline as the existing rollup, not a partial sum.**
`costOneRecipe()` (`lib/recipe-rollup.js:130-175`) refuses to write a material's cost at all when any
line is unpriced or unreconciled — it does not silently sum the lines that did resolve. The sketch
above mirrors that: `zeroCostLines > 0 || unreconciledUnitLines > 0` blocks the whole product's
`unitCost` to `null` rather than reporting a confidently-low number missing one line's contribution.
A blocked product keeps its last-known `unit_cost` (see §3) exactly the way a blocked material or a
blocked recipe-linked product does today.

## 3 · The recompute trigger

**This reuses the existing trigger network. No new call site is needed anywhere.** Read directly for
this document — every place a material's `cost_per_unit` changes already calls `fireRecompute`, guarded
by the identical `cpuMoved` pattern:

| file:line | fires when |
|---|---|
| `routes/ingredients.js:207` | kitchen ingredient edit form saves a changed cost |
| `routes/retail-materials.js:303` | Tacet materials edit saves a changed cost |
| `routes/purchases.js:187` | a PO price write-back moves a material's cost |
| `routes/admin.js:407` | the bulk cost-repair tool fixes a cost |
| `routes/recipes.js:373,401` | kitchen recipe save, when the recipe backs a linked material or product |
| `routes/retail-recipes.js:306,328` | Tacet recipe save, same condition |
| `routes/retail.js:20757` | a product's recipe link is set |

Every one of these calls `fireRecompute(db, {source, ...})` → `applyRollup(db, trigger)`
(`lib/recipe-rollup.js:284-313`), which already runs, inside one transaction: plan the linked-material
topological pass → write changed material costs → **call `applyProductCosts(db)` last, inside the
same transaction, so a product sees the just-written material figure, not a stale one**
(`:299-303`, the file's own comment explains this ordering).

**Proposal: add `applyProductBuildCosts(db)` as a sibling to `applyProductCosts(db)`, called from the
same place in `applyRollup`.** Its shape mirrors `applyProductCosts` exactly (`:374-398`): load every
active `store_products` row that has at least one `product_build_lines` row, call
`computeProductBuildCost(id, db)`, write `unit_cost` when it resolved and differs from the stored
value, write nothing when it's blocked. Same compound-match `WHERE id = ?` write-safety the existing
function uses. **This is additive in Step 2 — both functions can run side by side, since a product
either has build lines or is recipe-linked, and Step 4 is what decides which one wins when both are
present (§6 below).** No route file changes at all; every one of the eight trigger points above starts
covering build-list products for free the moment `applyRollup` calls the new function.

**Expected fan-out on live data.** `applyRollup` is deliberately a full-graph recompute, never a
partial walk — its own comment (`:251-259`) argues a partial "just the affected subtree" mode is a
second, subtly different code path for a problem the full recompute already solves for free, and that
the whole graph is "single-digit milliseconds at this size (27 linked materials today)." The build-list
pass adds one more full table scan of comparable size: 248 active `store_products` rows today (B.5),
each with an expected 2-4 build lines once populated (the Zhoug worked example has 3) — call it
roughly 500-1000 `product_build_lines` rows at full adoption, against 846 `recipe_ingredients` rows
today. That is the same order of magnitude the rollup already walks on every trigger fire; no
optimisation is proposed and none looks necessary at this scale.

## 4 · The 91 recipes carrying a packaging pointer

Live counts, queried for this document: **91 `recipe_cost_data` rows carry a `packaging_type_id`
(90 resolve to a real `packaging_types` row — the 91st is recipe 7's broken text placeholder,
`docs/packaging-findings.md:1922`). Of those 91 recipes, 65 back an active `store_products` row via
`recipe_id`** (`store_products.recipe_id = recipe_cost_data.recipe_id`, both active) — this is the
live re-count of §31's "65 products carry a packaging figure through their recipe" and it still holds.
The other ~172 active `store_products` rows have no `recipe_id` at all and so have no packaging
pointer to migrate from in the first place.

**Per the §29 addendum's rule — migration tooling presents candidates for a human to confirm and must
not classify on its own judgement — nothing here proposes writing `product_build_lines` rows
automatically.** What is proposed is a **candidate-generation pass**, run once the Step 3 screen
exists, that pre-fills a suggestion the human still has to accept:

1. For each of the 65 products, read its recipe's `packaging_type_id`, resolve it to a
   `packaging_types.name`.
2. Attempt the same name-match B.11 already performed live: exact match first, then the documented
   fuzzy pass (plurals, parenthetical suffixes, one known typo). B.11 found this resolves **confidently
   for 28 of the 44 `packaging_types` rows, generously up to 36** — meaning a meaningful minority of
   the 65 will have a packaging figure recorded but no confident `ingredients` counterpart to suggest.
3. Where a confident match exists, surface it on the product's build-list screen as an **unsaved
   suggestion** — qty 1, unit `pcs`, pointing at the matched `ingredients` row — for the human to
   accept, edit, or discard. Where it doesn't, surface the recipe's packaging figure as plain text
   ("this product's recipe records ¥1.12 of packaging with no confident match — pick the material by
   hand") so the number isn't silently dropped, only its auto-suggestion is.
4. Nothing is written until a human saves the build list. The 91st recipe (the broken pointer) and the
   ~172 products with no recipe at all get no suggestion, in the first case because there's nothing
   resolvable to suggest from, in the second because there was never a pointer to read.

This is a Step 2/3-adjacent tool, not Step 1 code — recorded here because the brief asked what happens
to the 91, and the answer is "a suggestion, never a write."

## 5 · The 130 products with no cost at all

B.3 established 131 of 208 displayed units show "—", and 130 of those are missing cost only (price is
fine) — at the raw `store_products` row level (the level a build list actually attaches to, since
each variant gets its own list), that's **171 active rows with `unit_cost IS NULL`, all 171 with
`recipe_id IS NULL`** (re-confirmed live for this document). These products gain a cost for the first
time the day someone gives them a build list — there is no migration to run for them, because there
is nothing to migrate from.

**Proposed as out of scope for Steps 2-5**, for the same reason §31 already states for the 65:
*"That one-time pass is the real cost of this change — not the code. Any plan that budgets the build
and not the pass has budgeted the cheap half."* Steps 2-5 build the mechanism; populating 248 products'
build lists (171 from nothing, 65 from a suggestion, plus whatever's needed for the ~12 already-costed
non-recipe rows) is one continuous operational pass that happens **after** Step 3 ships a screen to do
it on, using the same human-confirms-every-line discipline as §4 — not bundled into any of the four
code PRs. Recorded here as a scope decision this document is proposing, not one already made — Ash
should confirm it rather than have it default in by omission.

## 6 · A dependency this design surfaces: materialize is opt-in today, not automatic

The brief's decided context states a recipe's output "ALWAYS gets a materials row, automatically... a
build line points at exactly one thing: a material, never a recipe" — restating §29. Reading the
current code for this document, **that automatic half is not built yet.** `lib/recipe-materialize.js`
is a human-triggered action — `POST /api/retail-admin/recipes/:id/materialize`
(`routes/retail-recipes.js:372`) — and today **28 of 137 active recipes** have been materialized
(live count, this document). The other 109 have no `ingredients` row a build line could point at yet.

**This is a real dependency for the Zhoug worked example, not a hypothetical one.** If Zhoug's recipe
has not been materialized, there is no `ingredients` row for a build line to reference "250g Zhoug"
against, regardless of how good the build-list screen is. Two ways this resolves, both workable, and
this document is not choosing between them:

- **The human materializes on demand.** The build-list screen's material picker is the same picker a
  recipe line uses — a made thing simply isn't in it until someone has hit Materialize on its recipe
  once. This needs no new code; it is today's behaviour, and the screen surfaces the gap naturally
  (the food content isn't in the list to pick).
- **Materialize becomes automatic on recipe save**, closing the gap the brief's decided context
  describes as already true. That is new work, not scoped by this brief's five steps, and not
  proposed here — flagged only so it isn't assumed done.

**Not re-litigating §29's decision — only noting the build-then-strip order (decided point 8) makes
the first path sufficient for launch.** Nothing forces every recipe to be materialized before Step 2
ships; a product's build list simply can't include its food content as a line until that one step
happens, the same one-time-per-product friction §4 and §5 already describe for packaging and cost.

## 7 · What this means for `store_products.recipe_id` — read back for confirmation, not assumed

The Zhoug worked example in the brief lists **"250g Zhoug (material)"** as a build line, not as a
`recipe_id` link plus separate packaging lines. Read plainly, that means once build lines exist, a
product's food content is costed the same way its packaging is — a line pointing at a material, full
stop — and `store_products.recipe_id` **stops being an input to `unit_cost` at all** once Step 4 lands
(Step 4's own text: "switch `unit_cost`'s writer from the recipe rollup to the build lines"). This
document reads that as the intended design — one mechanism, no second path — rather than build lines
adding a packaging figure on top of a recipe-rollup figure that keeps running alongside it.

`recipe_id` does not disappear — `routes/products.js:174-211` (kitchen side) reads a product's linked
recipe for its allergen rollup, unrelated to costing, and would keep doing so untouched. It simply
stops being read by `applyProductCosts`/Step 4's replacement for the purpose of writing `unit_cost`.

**Flagged for Ash to confirm rather than assumed**, because it is the one place this document infers
intent from an example instead of from an explicit rule: is a build line meant to fully replace
`recipe_id` as a cost source (this document's reading), or should a recipe-linked product's food-only
`costPerServing` keep feeding `unit_cost` directly, with build lines adding only what a recipe can't
carry (packaging)? The schema in §1 supports either reading unchanged — this only affects what
`computeProductBuildCost`/`applyProductBuildCosts` sum in Step 2, and what Step 4 turns off.

---

## Open questions for Ash

1. **§7 above** — does a build line fully replace `recipe_id` as a product's cost source (this
   document's reading of the Zhoug example), or does a recipe-linked product's food cost keep coming
   from the recipe directly, with build lines carrying only what the recipe can't (packaging)?
2. **§6** — does "a recipe's output always gets a materials row" need to become automatic-on-save
   before or alongside this work, or is "the human hits Materialize when the picker shows the gap"
   sufficient for launch, with automatic materialization left for later?
3. **§5** — confirm the 171-row cost pass is explicitly out of scope for Steps 2-5, so it isn't
   silently expected to land inside one of the four PRs.
4. **§1** — confirm dropping `substitutes` from the template (recipe_ingredients has it, this
   proposal doesn't) is correct for a list that's fixed at product-creation time rather than read
   live during production.
