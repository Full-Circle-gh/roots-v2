# packaging — Findings

Sixteen findings, opened 2026-08-26 by a simple question — *what does packaging
cost us* — and ending in a number that was counted twice on eleven materials and
sixteen recipe lines.

**Finding 1 is first because it was the one worth acting on. It has since been
FIXED** — see finding 15 for what was changed and what it moved. Everything else
in this document is structure, and the structure is mostly defensible.

**Findings 1 to 14 were a read-only survey and wrote nothing.** Finding 15 is the
fix that followed and it changed code. Finding 16 records what the fix does NOT
reach, so the gap is not mistaken for closed. Every number below is a read-only
query against `roots.db`, and the queries are given so they can be re-run.

Most of these are not packaging-specific. Finding 1 holds anywhere a derived cost
is folded into a unit price that is then consumed as an input; finding 4 holds
anywhere a lookup table's value is copied rather than referenced; finding 6 holds
anywhere a missing row and a deliberate zero render identically; finding 8 holds
anywhere one formula has two implementations; and finding 13 holds anywhere one
phrase names three unrelated things.

`docs/meituan-findings.md` is the companion in style rather than in subject: same
shape, same rule that a correction is marked in place rather than folded away.
The rules both documents answer to are in `docs/tacet-consolidation-decisions.md`
§29 (nested recipes) and §30 (channel sync). **No rule is proposed here.** Where
this document and the code disagree, this document is stale and should be
re-checked against the code.

Two of the claims that opened this survey did not survive it, and both are
corrected in place — see findings 4 and 5.

---

## 1. Packaging is counted twice on any recipe that consumes a made material, and it is live (found 2026-08-26)

Status: **FIXED 2026-08-26 — see finding 15.** The description below is of the
fault as it stood; the figures in it are the pre-fix figures and are left as they
were measured, because finding 15's table is the before-and-after and needs a
before to point at.

This was the headline.

### The mechanism, in three lines of code

A made material's unit cost is its recipe's **whole batch cost divided by batch
size** — and the batch cost includes that recipe's packaging.

`lib/recipe-cost.js:157-159`:

```js
  const packagingTotal = packaging * (servings > 0 ? servings : 1);
  const overheadAmount = ingredientCost * overheadPct / 100;
  const batchCost = ingredientCost + labour + packagingTotal + overheadAmount;
```

`lib/recipe-rollup.js:148-149` turns that into the material's cost per unit:

```js
  if (c.costPerGram === null) return { ok: false, reason: 'no_cost_per_unit', detail: c };
  return { ok: true, cpu: c.costPerGram, detail: c };
```

and `lib/recipe-rollup.js:266` writes it to the materials master:

```js
    const upd = db.prepare('UPDATE ingredients SET cost_per_unit = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND source_recipe_id = ?');
```

**So `ingredients.cost_per_unit` on a made material carries a per-gram share of
the boxes its own recipe is packed into.** When a parent recipe consumes that
material as an ingredient, it inherits that share as *ingredient cost* — and then
adds its own packaging on top.

The child's packaging is real when the child is sold on its own. It is not real
when the child is a bulk intermediate ladled into a parent's batch: nobody buys a
box for sour cream that goes into a wrap. **The parent pays for boxes that were
never bought.**

### The worked example: Cashew Sour Cream into Garlic Dill Sour Cream

`Cashew Sour Cream` is `ingredients` id **572**, made by recipe **15**.

| | |
|---|---|
| recipe 15 batch size | 12,000 g |
| recipe 15 servings | 55 |
| recipe 15 `recipe_cost_data.packaging` | 1.12 per serving |
| packaging per batch | 55 × 1.12 = **¥61.60** |
| phantom share per gram | 61.60 ÷ 12,000 = **¥0.005133/g** |
| `ingredients.cost_per_unit` (572) | ¥0.046483/g |
| **share of the material's cost that is packaging** | **11.04 %** |

Recipe **9**, `Garlic Dill Sour Cream` (batch 2,616 g, 12 servings), consumes
**2,500 g** of it:

```
phantom packaging in that one line = 2500 × 0.005133 = ¥12.83
```

And recipe 9 has packaging of its own — 1.12 × 12 servings = **¥13.44**.

The whole batch, from the live data:

```
ingredientCost   122.9652      ← includes ¥12.83 of phantom packaging
labour             0
packagingTotal    13.44        ← real: 12 × 1.12
overhead           0
                 --------
batchCost        136.4052
costPerServing   136.4052 / 12 = 11.3671
```

`SELECT unit_cost FROM store_products WHERE id = 347` returns
**11.3671016666667**. The arithmetic reconciles to the digit, which is how we
know the phantom is inside it.

**Of the ¥26.27 of packaging in that batch, ¥13.44 was bought and ¥12.83 was
not.** The false charge is 95 % the size of the true one — packaging is very
nearly doubled — and it is **9.4 % of the product's unit cost**.

### The eleven materials carrying a phantom share

```sql
SELECT i.id, i.name_en, i.cost_per_unit,
       ROUND(c.packaging * r.servings / NULLIF(r.batch_size,0), 6) AS phantom_per_unit,
       ROUND(100.0 * (c.packaging * r.servings / NULLIF(r.batch_size,0))
             / NULLIF(i.cost_per_unit,0), 2) AS pct_of_cpu
  FROM ingredients i
  JOIN recipes r ON r.id = i.source_recipe_id
  JOIN recipe_cost_data c ON c.recipe_id = r.id
 WHERE i.source_recipe_id IS NOT NULL AND c.packaging > 0
 ORDER BY pct_of_cpu DESC;
```

| id | material | cost_per_unit | phantom/unit | **% of its own cost** |
|---|---|---|---|---|
| 615 | Pickled Onions | 0.013376 | 0.005087 | **38.03 %** |
| 616 | Hummus Asli | 0.020614 | 0.005793 | **28.10 %** |
| 574 | Whole Sesame Tahini (Unhulled) | 0.019160 | 0.002495 | 13.02 % |
| 578 | Crunchy Peanut Butter | 0.019024 | 0.002379 | 12.51 % |
| 612 | Arugula-Basil Pesto | 0.040091 | 0.004560 | 11.37 % |
| 572 | Cashew Sour Cream | 0.046483 | 0.005133 | 11.04 % |
| 613 | Chick'EN Strips | 0.017895 | 0.001404 | 7.85 % |
| 617 | Baked Falafel | 0.023804 | 0.001514 | 6.36 % |
| 588 | Creamy Cashew Butter | 0.074223 | 0.004462 | 6.01 % |
| 634 | Crunchy Granola | 0.066353 | 0.002648 | 3.99 % |
| 587 | Beet salad dressing | 0.060201 | 0.002038 | 3.39 % |

**Pickled Onions is more than a third packaging.** A twelfth material,
`Strawberry-Lemon Chia Jam` (603, recipe 86), would qualify but its
`cost_per_unit` is 0 and its recipe has no batch size, so it carries nothing
today — recorded so the count is understood as eleven *carrying*, not eleven
*eligible*.

### The sixteen lines it reaches, across eleven parent recipes

| parent | recipe | material | qty | phantom in the line |
|---|---|---|---|---|
| 9 | Garlic Dill Sour Cream | Cashew Sour Cream | 2500 g | **¥12.8333** |
| 31 | Nacho Cheese Dip | Creamy Cashew Butter | 700 g | ¥3.1235 |
| 24 | Noodle salad dressing | Crunchy Peanut Butter | 400 g | ¥0.9516 |
| 96 | Falafel Wrap | Hummus Asli | 75 g | ¥0.4345 |
| 38 | Tofu wrap sauce | Cashew Sour Cream | 72 g | ¥0.3696 |
| 97 | Shawarma Wrap | Hummus Asli | 60 g | ¥0.3476 |
| 10 | Chickpea Salad | Whole Sesame Tahini | 136 g | ¥0.3393 |
| 41 | Tabbouleh bowl dressing | Whole Sesame Tahini | 110 g | ¥0.2745 |
| 96 | Falafel Wrap | Baked Falafel | 100 g | ¥0.1514 |
| 95 | Pesto 'Chicken' Wrap | Chick'EN Strips | 80 g | ¥0.1123 |
| 101 | Ginger Tahini | Whole Sesame Tahini | 45 ml | ¥0.1123 |
| 95 | Pesto 'Chicken' Wrap | Arugula-Basil Pesto | 25 g | ¥0.1140 |
| 95 | Pesto 'Chicken' Wrap | Cashew Sour Cream | 20 g | ¥0.1027 |
| 35 | Beet Salad | Beet salad dressing | 50 g | ¥0.1019 |
| 95 | Pesto 'Chicken' Wrap | Pickled Onions | 15 g | ¥0.0763 |
| 96 | Falafel Wrap | Pickled Onions | 12 g | ¥0.0610 |

**16 lines · 11 parent recipes · 10 distinct materials.** The wraps compound it —
`Pesto 'Chicken' Wrap` inherits a phantom share from four separate materials in
one recipe.

### Where it lands

`lib/recipe-rollup.js:354` writes `costPerServing` — packaging included, phantom
included — straight to the catalogue:

```js
  const upd = db.prepare('UPDATE store_products SET unit_cost = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND recipe_id = ?');
```

Live products fed this way include `Garlic Dill Sour Cream` (347, 11.3671),
`Nacho Cheese Dip` (9, 9.2704), `Falafel Wrap` (210, 7.3923), `Chickpea Salad`
(203, 6.1235) and `Beet Salad` (71, 9.5427). From there it is the cost side of
the **Tacet margin column**.

**This is not a latent risk. It is in the numbers on the screen today.**

### What it is not

It is not a bug in either module taken alone. `computeRecipeCost` is right to
include packaging in a batch cost — that is what a batch costs. `recipe-rollup`
is right to divide batch cost by batch size — that is what a gram costs. **The
fault is that the second one consumes the first's output in a context where one
of its components does not apply**, and neither module is positioned to know
that. §29 made a made thing a material; what it did not settle is which of a
recipe's costs travel with the material and which belong to selling it.

---

## 2. The field is on the recipe, not the product (found 2026-08-26)

Status: open, and structural rather than faulty.

**There is no packaging column on `products` or on `store_products`.** Checked
against the live schema:

```sql
SELECT m.name || '.' || p.name FROM sqlite_master m, pragma_table_info(m.name) p
 WHERE m.type='table' AND (p.name LIKE '%packag%' OR p.name LIKE '%packing%'
    OR p.name LIKE '%package%');
```

returns eight columns, and **only two of them are the cost of a container**:
`recipe_cost_data.packaging` and `recipe_cost_data.packaging_type_id`. The other
six are delivery and channel fees — finding 13.

So a product only has a packaging cost if it is linked to a recipe, and it sees
the number **second-hand**, through `store_products.unit_cost` (finding 1). A
retail-only product — bought in, boxed, sold — has nowhere to record what its box
costs. Of the catalogue, only recipe-linked rows carry a derived cost at all.

The consequence worth stating: **"what does packaging cost for this product" is
not a question the product can answer.** It can only be asked of a recipe.

---

## 3. `packaging_types` is a standalone table with no join to materials, and the absence is deliberate (found 2026-08-26)

Status: open by design. **Documented in the code**, which is why this is recorded
as structure rather than as a fault.

```sql
CREATE TABLE packaging_types (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  name_cn       TEXT,
  cost          REAL DEFAULT 0,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
, image_data TEXT)
```

**44 rows. No foreign key. No `updated_at`. No link to `ingredients` of any
kind.** `recipe_cost_data.packaging_type_id` is a bare `INTEGER` with no FK
constraint either — the only FK on that table is `recipe_id → recipes(id)`.

The absence is deliberate and argued, at `routes/retail-materials.js:127-133`:

> `packaging` is deliberately left out of BOTH clauses on the OR … because
> `recipe_cost_data.packaging` … already prices packaging from the standalone
> `packaging_types` table — there is no link between that table and `ingredients`,
> so an `item_kind='packaging'` material appearing here too would give a jar two
> uncoordinated cost paths into the same recipe, one of them silent.

That reasoning is sound as far as it goes: it prevents a jar being priced twice
*within one recipe*. What it does not prevent is the same jar being priced
differently in four places overall — finding 12 — because the fix chosen was to
keep the paths apart rather than to join them.

---

## 4. The cost is typed and copied, not referenced (found 2026-08-26)

Status: open.

Picking a packaging type **copies its cost into the input**. Every reader
afterwards uses `recipe_cost_data.packaging`; **nothing reads
`packaging_types.cost` again.** `lib/recipe-cost.js:150`:

```js
  const packaging = parseFloat(cd.packaging || 0);
```

`packaging_type_id` is stored beside it and is **never joined to** by any costing
path. It is a label recording what was picked, not a reference the cost is
derived through. Change a type's cost and no recipe moves.

Recipe 9 shows the copy plainly: `recipe_cost_data.packaging` = **1.12**, and
`packaging_types` id 2 (`300ml Plastic Box` / `300毫升塑料瓶`) `.cost` = **1.12**.
Identical because it was copied, not because anything keeps them equal.

**All 44 types were created in one sitting on 2026-08-11**, between 05:44:45 and
07:27:08 — one hour and forty-three minutes:

```sql
SELECT substr(created_at,1,10) AS day, COUNT(*) FROM packaging_types GROUP BY 1;
-- 2026-08-11 | 44
```

**And they have already separated from the materials master.** Joining by name to
`ingredients` where `item_kind='packaging'`, **eight of the twenty-one matched
pairs disagree**, four of them materially:

| type | `packaging_types.cost` | `ingredients.buy_price` | delta |
|---|---|---|---|
| 1oz (25ml) Plastic Container | 0.05 | 0.054 | **−7.41 %** |
| 280ml Plastic Food Container（include lids) | 0.488 | 0.458 | **+6.55 %** |
| 24oz 720ml Plastic Food Container - Soup Bowl | 0.48 | 0.513 | **−6.43 %** |
| 350ml Silver Aluminum Container | 3.8 | 3.74 | **+1.60 %** |
| 450ml Glass Jars with lids | 1.88 | 1.875 | +0.27 % |
| 3oz White Paper Ice Cream Container | 0.407 | 0.406 | +0.25 % |
| 300g Plastic Powders Container | 2.1 | 2.1017 | −0.08 % |
| 1kg Plastic Powders Container | 3.81 | 3.809 | +0.03 % |

**Nothing reconciles them and nothing ever will**, because no code path compares
the two tables.

A further **23 of the 44 types have no `ingredients` counterpart by name at
all** — they are priced only here.

> **Correction to the brief that opened this survey.** It said the 44 rows have
> had *"zero updates since"* creation. **That cannot be shown, and the truth is
> worse.** `packaging_types` has **no `updated_at` column**, and the update route
> `routes/lookups.js:91-99` **writes no activity-log entry** — unlike its
> siblings, which do (`:87` on create, `:104` on delete). The activity log holds
> 56 creates and 13 deletes for `packaging_type` and no update action, but that
> is the absence of a *log*, not the absence of an *edit*.
>
> **So a packaging cost can be changed by anyone with kitchen access and leave no
> trace of any kind** — not a timestamp, not an actor, not a previous value. We
> cannot say whether any of the 44 has ever been edited. That is the honest
> statement, and it is a stronger reason to act than the one it replaces.

---

## 5. The unit is per piece and the label is honest (found 2026-08-26)

Status: **not a fault.** Recorded because it was the survey's main suspicion and
it did not survive contact with the data.

`recipe_cost_data.packaging` is commented `-- per serving` in the schema, and the
Tacet field is labelled `Packaging (per serving) 包装(每份)`
(`public/retail-admin/19-recipes.js:693`). `lib/recipe-cost.js:157` multiplies by
servings to reach the batch. **All three agree, and the number in the field is
the price of one physical piece.**

Confirmed against a purchase order. Recipe 9 carries **1.12** and points at
`300ml Plastic Box`. `PO-0052`, dated 2026-08-06:

| line | qty | unit | cost_per_unit | total |
|---|---|---|---|---|
| `300ml Plastic Box(include inside lid)` | 500 | pcs | **1.12** | **560.00** |

500 × 1.12 = 560.00. **¥1.12 buys one box**, one box holds one 220 ml serving,
and recipe 9 charges 1.12 per serving. The label is right, the unit is right, and
the arithmetic ties out to a real invoice.

### But the pack-price-as-unit-price fault is real on the materials side

Recorded here so nobody reads "the label is right" as "the data is clean". These
are two different tables and only one of them is trustworthy.

**`ingredient_cost_skips` holds 23 rows, every one of them
`reason = 'no_pack_contents'`, and every one still unresolved** (`resolved_at`
NULL). Eight of the ten ingredients involved are `item_kind='packaging'`:

| id | material | line unit | line price recorded |
|---|---|---|---|
| 609 | 380ml Locking SoupCup | pcs | **16.89** |
| 607 | Transparent Round Box（Packaging Sample） | pcs | 10.00 |
| 630 | Bread Vacuum Bag（Packaging Sample） | pcs | 8.80 |
| 631 | OPP Food Plastic Bag | pcs | 8.00 |
| 629 | Plastic Oil Bottle（Coconut Oil） | pcs | 12.00 |
| 608 | Semi-transparent Kraft Paper Bag（Sample） | pcs | 5.00 |
| 604 | Round Wooden Box | pcs | 4.55882 |
| 628 | Bread Bag（Packaging Sample） | pcs | 4.00 |

The `380ml Locking SoupCup`'s real unit price is **0.554166**. The 16.89 is a
pack. The system caught these and refused to convert them, which is the system
working — but it left them unresolved.

**And `ingredient_price_history` shows the swings where it was not caught:**

| id | material | min | max | ratio | current `buy_price` |
|---|---|---|---|---|---|
| 556 | 10g Dry Desiccant | 0.153 | **230.00** | **1503×** | 0.153 ✅ |
| 304 | 280ml Plastic Food Container（include lids) | 0.458 | **229.00** | **500×** | 0.458 ✅ |
| 592 | Kraft Paper Bowl Lid（Sample） | 0.24 | 10.00 | 41.7× | **10.00 ❌** |
| 609 | 380ml Locking SoupCup | 0.554 | 16.89 | 30.5× | 0.554 ✅ |
| 313 | 1000ml Glass Juice Bottle | 3.70 | 111.00 | 30.0× | 3.70 ✅ |
| 597 | Degradable Tableware（Sample） | 0.547 | 13.00 | 23.8× | **12.35 ❌** |
| 527 | Rectangular shape cake container | 1.036 | 15.72 | 15.2× | 1.036 ✅ |
| 596 | plastic bag including card top（Sample） | 0.792 | 7.72 | 9.7× | **7.72 ❌** |

**Three of these currently hold the pack price as the unit price** (592, 597,
596), and their `cost_per_unit` equals it. A 41× error is sitting in the
materials master today.

So: the *recipe* packaging field is honest per piece. The *materials* packaging
prices are not reliably per piece. Finding 12 is what happens when both feed the
same question.

---

## 6. Missing is treated as a hard zero, and a deliberate zero looks identical (found 2026-08-26)

Status: open.

```sql
SELECT (SELECT COUNT(*) FROM recipes)                                    AS recipes,      -- 137
       (SELECT COUNT(*) FROM recipe_cost_data)                           AS cost_rows,    -- 103
       (SELECT COUNT(*) FROM recipe_cost_data WHERE packaging > 0)       AS packaging_gt0,-- 93
       (SELECT COUNT(*) FROM recipe_cost_data WHERE packaging = 0)       AS zero,         -- 10
       (SELECT COUNT(*) FROM recipes r WHERE NOT EXISTS
          (SELECT 1 FROM recipe_cost_data c WHERE c.recipe_id=r.id))     AS no_cost_row;  -- 34
```

**93 recipes carry a packaging cost, 10 are explicitly zero, and 34 have no cost
row at all.**

`lib/recipe-cost.js:150` reads a missing row as zero:

```js
  const packaging = parseFloat(cd.packaging || 0);
```

with `cd = costData || {}` above it. **So 34 recipes are costed as if their
packaging is free**, and nothing distinguishes that from the 10 that genuinely
are.

The module *does* say which it is — it returns `hasCostRow` (`:143`, `:175`) —
**but no screen branches on it.** The kitchen cost sheet, `public/app.html:6610`,
branches on the amount instead:

```js
${packTotal>0 ? `…Packaging 包装…¥${packTotal.toFixed(2)}…` : `…Packaging — not set…Set →…`}
```

**So a recipe whose packaging is deliberately ¥0 is displayed as "not set"**,
with a call to action to go and set it — and a recipe with no cost row at all is
displayed identically. The one flag that could tell them apart is computed,
returned, and read by nobody.

---

## 7. One recipe, one cost row, one packaging type, one number (found 2026-08-26)

Status: open, and it is a modelling limit rather than a bug.

From the schema:

```sql
CREATE TABLE recipe_cost_data (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id     INTEGER NOT NULL UNIQUE,
  …
  packaging     REAL DEFAULT 0,        -- per serving
  packaging_type_id INTEGER,
  …
  FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE
)
```

`recipe_id` is **UNIQUE** and `packaging_type_id` is **scalar**. One row per
recipe, one type per row.

**Stated plainly: a jar with a lid, a label and a shipping box records one of the
four.** Whatever the operator picks, the other three either go into the typed
number by mental arithmetic — leaving no record of what was added — or go
uncounted. There is no way to tell afterwards which happened, because the number
is typed (finding 4) and the type link is only a label.

`packaging_type_id` is set on 91 of the 103 cost rows and NULL on 12.

### Recipe 7 holds a type id that is not an integer

```sql
SELECT recipe_id, packaging, packaging_type_id, typeof(packaging_type_id)
  FROM recipe_cost_data WHERE recipe_id = 7;
-- 7 | 1.0 | pt1778315688913 | text
```

**`'pt1778315688913'` — a client-generated string id in an `INTEGER` column.**
SQLite's flexible typing accepted it. It matches no row in `packaging_types`, so
the label points at nothing; the cost of 1.0 is unaffected, because nothing joins
on the id anyway (finding 4). It is an orphan that only surfaces if the link is
ever made real.

---

## 8. Twelve consumers of the formula, and two more that reimplement it (found 2026-08-26)

Status: open on the two that reimplement it.

`computeRecipeCost` is the shared derivation. Twelve production call sites
consume it, each with its own assumption about what to do with packaging:

| # | site | packaging treatment |
|---|---|---|
| 1 | `lib/recipe-rollup.js:142` → material `cost_per_unit` | **included** — the source of finding 1 |
| 2 | `lib/recipe-rollup.js:358` → `store_products.unit_cost` | **included** (costPerServing) |
| 3 | `database.js:4321` boot recompute | included |
| 4 | `routes/recipes.js:141` kitchen list | included, exposed as `packTotal` (`:209`) |
| 5 | `routes/retail-recipes.js:153` Tacet list | included |
| 6 | `routes/retail-recipes.js:200` Tacet detail | included |
| 7 | `routes/retail.js:20763` product-link preview | included |
| 8 | `routes/waste.js:51` waste costing | **EXCLUDED, deliberately, documented** |
| 9 | `public/app.html:6495` kitchen cost sheet | included; "not set" at `:6610` |
| 10 | `public/app.html:7685` kitchen recipe view | included, with/without split |
| 11 | `public/app.html:8025` cost-sheet recompute | included |
| 12 | `public/retail-admin/19-recipes.js:726` Tacet editor | included, `Packaging (batch)` at `:749` |

### The one deliberate exclusion is argued in the code

`routes/waste.js:28-35`:

> **PACKAGING IS EXCLUDED.** Packaging is recycled when a finished product is
> wasted (the box / container is reused on the replacement unit), so counting it
> would double-count. … No flag was added to the shared module for this: the
> policy belongs to waste, not to the derivation. If the policy ever changes, add
> `+ c.packagingTotal` here.

That is exactly how a divergence should be recorded: named, reasoned, and told
where to change.

### The two silent ones are the AI's

**Neither `routes/ai.js` cost tool calls `computeRecipeCost`.** Both hand-roll the
formula from ingredient lines alone:

`routes/ai.js:2114` `get_recipe_cost`:

```js
    const total = breakdown.reduce((s,b)=>s + (b.line_cost||0), 0);
    const servings = recipe.servings || 1;
    …  cost_per_serving: +(total / servings).toFixed(2),
```

`routes/ai.js:2292` `compute_margin`:

```js
    const totalRecipeCost = breakdown.reduce((s, b) => s + (b.line_cost || 0), 0);
    const cost_per_serving = totalRecipeCost / servings;
    const grossMarginPct = sell > 0 ? ((sell - cost_per_serving) / sell) * 100 : 0;
```

**No packaging. No labour. No overhead. And no comment saying so** — unlike
waste, which explains itself. These two were missed when the formula was
consolidated into `lib/recipe-cost.js`.

**The consequence: the assistant quotes a margin that no screen in the system
shows, and quotes it as authority.** The AI's own prompt promotes these tools —
`routes/ai.js:1018` tells it to *"prefer the dedicated tools (compute_margin,
find_anomalies) over hand-arithmetic"*, and `:1192` offers `get_recipe_cost` as
the answer to *"Why is my margin off?"*. For any of the 93 recipes with
packaging, the number it returns is too favourable, and the gap is exactly the
packaging the screens include.

Note the irony worth recording: on a recipe consuming a made material, the AI's
number still contains finding 1's phantom packaging, because that hides inside
`ingredients.cost_per_unit` rather than in the packaging field. **It drops the
real packaging and keeps the fake.**

---

## 9. Purchasing yes, depletion no — and not only for packaging (found 2026-08-26)

Status: open, and much wider than packaging.

Packaging is bought properly. `po_line_items` records it with a supplier, a
quantity, a unit and a price, and `ingredient_price_history` keeps the series
(finding 5).

**Nothing consumes it.** And the reason is structural:

```sql
SELECT group_concat(name, ', ') FROM pragma_table_info('ingredients');
-- id, name_en, name_cn, sku, category, unit, buy_unit, buy_pack_size,
-- cost_per_unit, buy_price, supplier, allergens, notes, is_active, created_at,
-- updated_at, supplier_platform, supplier_link, supplier_qr_data, image_data,
-- pack_contents_qty, pack_contents_unit, accounting_category, item_kind,
-- free_by_design, source_recipe_id
```

**There is no stock column on `ingredients` at all**, and no ingredient-stock
table exists:

```sql
SELECT name FROM sqlite_master WHERE type='table'
   AND (name LIKE '%ingredient%' OR name LIKE '%material%');
-- ingredient_cost_skips · ingredient_price_history · ingredients · recipe_ingredients
```

So **nothing depletes any material — not packaging, not flour, not cashews.**
`retail_store_stock` tracks finished products only. Producing a batch consumes
nothing on paper; buying 500 boxes and using 500 boxes leave the same record.

Recording this under packaging because that is where it was found, but it should
not be read as a packaging gap. **"How many boxes do we have left" has the same
answer as "how much flour do we have left": the system does not know.**

---

## 10. Global, with no per-store anything (found 2026-08-26)

Status: open.

`packaging_types` has no store column. `recipe_cost_data` has no store column.
`ingredients` has no store column. **A packaging cost is one number for the whole
business.**

If the same box costs different amounts at 天河 and 越秀 there is nowhere to
record it — the schema has no slot, so the question cannot even be asked.

**Bought at different prices over time is already happening and already
unrecorded** in the costing path. `ingredient_price_history` keeps the series, but
`recipe_cost_data.packaging` is a typed copy (finding 4) that no price movement
reaches. Real examples from the packaging series, excluding the pack-price
artefacts in finding 5:

| material | price points | range |
|---|---|---|
| Ice Pack non-woven anti-condensation 250g (363) | 12 | 0.21 → 0.769 (**3.7×**), now 0.46 |
| 100ml Ice pack (455) | 5 | 0.048 → 0.1305 (**2.7×**), now 0.048 |
| Bread Bags #4（Small）(331) | 2 | 0.078 → 0.19 (**2.4×**), now 0.078 |

Every recipe that types one of these into its packaging field froze a number that
has since moved by two to four times, and nothing tells anyone.

---

## 11. Every Tacet cost save nulls `packaging_type_id`, and leaves no trace (found 2026-08-26)

Status: **open, and happening now.**

The Tacet recipe editor builds its save payload at
`public/retail-admin/19-recipes.js:713-722`:

```js
  function draftCostData() {
    const v = k => { const el = document.getElementById('rcp-f-' + k); return el ? el.value : null; };
    return {
      labour: parseFloat(v('labour')) || 0,
      packaging: parseFloat(v('packaging')) || 0,
      overhead_pct: parseFloat(v('overhead_pct')) || 0,
      sell_price: parseFloat(v('sell_price')) || 0,
      target_food_cost: parseFloat(v('target_food_cost')) || 30,
    };
  }
```

**Five fields. `packaging_type_id` is not among them.** It is sent as the request
body verbatim at `:1002`.

The server destructures it anyway, `routes/retail-recipes.js:318`, and writes the
missing value as NULL at `:323-324`:

```js
  const { labour, packaging, packaging_type_id, … } = req.body || {};
  …
    .run(req.params.id, labour || 0, packaging || 0, packaging_type_id || null, …)
```

**So opening a recipe in Tacet, changing anything on the cost tab and saving
keeps the packaging NUMBER and silently discards the record of which packaging it
was.**

Two rows are in that state today:

```sql
SELECT recipe_id, packaging, packaging_type_id, updated_at
  FROM recipe_cost_data WHERE packaging > 0 AND packaging_type_id IS NULL;
```

| recipe | packaging | type | updated_at |
|---|---|---|---|
| **80** | 1.12 | NULL | **2026-08-26 07:28:46** |
| 36 | 0.1 | NULL | 2026-08-11 07:14:04 |

**Recipe 80 is the unambiguous one.** It was saved *today*, and its 1.12 is
exactly `packaging_types` id 2's cost — so a type *was* picked at some point, the
number was copied from it, and a later save dropped the link. Recipe 36's save at
07:14 falls inside the window the 44 types were being created (05:44–07:27), so
it may simply never have had one; recorded as the weaker of the two rather than
claimed as equivalent.

**And the route logs nothing.** `routes/retail-recipes.js:315-329` writes no
activity-log entry — confirmed by
`SELECT COUNT(*) FROM activity_log WHERE entity_type LIKE '%recipe%' AND action LIKE '%cost%'`
returning **0**. The only evidence a save happened is `updated_at` moving. There
is no before, no after, and no actor — the same absence §30 rule 7 names on the
channel side.

---

## 12. The same physical jar is priced in four independent places, with no reconciler (found 2026-08-26)

Status: open. This is finding 3's deliberate separation, seen from the other end.

For one 450ml glass jar, the system holds:

1. **`packaging_types.cost`** — 1.88, typed into the lookup on 2026-08-11.
2. **`ingredients.buy_price`** — 1.875, from purchasing.
3. **`ingredients.cost_per_unit`** — the derived per-unit figure.
4. **`recipe_cost_data.packaging`** — whatever was typed into each recipe that
   uses it, frozen at the moment of typing.

**No code path compares any two of them.** (1) and (2) already disagree on eight
pairs (finding 4). (4) is a copy of (1) taken at an unknown time. (3) is
maintained by an entirely different mechanism.

**And `ingredients` cannot answer the question for two thirds of the list
anyway:**

```sql
SELECT COUNT(*) AS total,
       SUM(CASE WHEN COALESCE(cost_per_unit,0)=0 THEN 1 ELSE 0 END) AS cpu_zero,
       SUM(CASE WHEN COALESCE(buy_price,0)>0 THEN 1 ELSE 0 END) AS buy_price_set
  FROM ingredients WHERE item_kind='packaging';
-- 146 | 95 | 144
```

**146 packaging materials. 95 have `cost_per_unit = 0`. 144 have a
`buy_price`.** So the column that costing would read is empty on **65 %** of the
list, while the column purchasing fills is populated on 99 % of it. The data to
answer "what does packaging cost" exists; it is in the wrong column, and nothing
moves it across.

Note also that packaging is classified three different ways — `item_kind =
'packaging'` (146 rows), `accounting_category = 'Packaging Materials 包装材料'`
(137 rows), and free-text `category` values including
`Boxes & Containers / Bottles / Bags 包装盒/瓶/袋` (77) and
`Low-value consumable supplies - Packaging 低值易耗品-包材` (20). The three do not
agree on membership.

---

## 13. "Packaging cost" already means three other things (found 2026-08-26)

Status: open, and it is a naming problem rather than a data one — but it will
cost time in conversation.

The eight packaging-ish columns in the schema split into two unrelated families:

**What a container costs to buy** — the subject of this document:
- `recipe_cost_data.packaging`
- `recipe_cost_data.packaging_type_id`

**What a customer is charged, or a channel charges us** — unrelated:
- `retail_delivery_zones.packing_fee_per_item`
- `retail_delivery_zones.packing_fee_cap`
- `retail_orders.packing_fee`
- `meituan_orders.package_fee`

Plus two that are neither: `retail_shipments.package_count` (a count of parcels)
and `retail_topup_transactions.package_id` (a top-up bundle — "package" in the
marketing sense).

**Say "packaging cost" in a room and four different people will reach for four
different columns**, three of which have nothing to do with what a box costs.
`retail_delivery_zones.packing_fee_per_item` is a customer-facing charge;
`meituan_orders.package_fee` is what Meituan reports on an order. Neither
relates, even indirectly, to `packaging_types.cost`.

Recorded because the next conversation about this will otherwise start with
fifteen minutes of disambiguation.

---

## 14. `packaging_types` is in the Factory Reset wipe list (found 2026-08-26)

Status: open, low urgency, worth knowing.

`routes/admin.js:239`, in `TABLES_WIPE`:

```js
    // Lookups (everything user-edited)
    'suppliers', 'packaging_types', 'categories',
```

A factory reset deletes all 44 packaging types. **`recipe_cost_data` is not in
the wipe list**, so every recipe keeps its typed `packaging` number and its
`packaging_type_id` — pointing at rows that no longer exist. Because nothing
joins on that id (finding 4), no cost would change and nothing would error; the
labels would simply all become orphans, like recipe 7's already is (finding 7).

Deletion is not hypothetical: **13 `packaging_type` deletes are already in the
activity log**, all on 2026-08-11 during the same session that created the 56
rows the log records (44 survive).

```sql
SELECT action, COUNT(*), MIN(created_at), MAX(created_at)
  FROM activity_log WHERE entity_type='packaging_type' GROUP BY action;
-- create | 56 | 2026-08-11 05:44:45 | 2026-08-11 07:27:08
-- delete | 13 | 2026-08-11 05:44:45 | 2026-08-11 07:27:08
```

---

## 15. The fix: packaging no longer travels with a material (built 2026-08-26)

Status: **built and verified. Not yet deployed at the time of writing.** This is
finding 1's answer. The rule it implements is `docs/tacet-consolidation-decisions.md`
§29's addendum.

### What decided it — the kitchen, not the arithmetic

A batch is **part-sold** as retail units in serving-sized containers and
**part-held in bulk** for later use as a material. The bulk half goes into reused
kitchen tubs, which are not a tracked cost. So the retail container is a cost of
the sellable unit and of nothing else — and carrying it into a parent recipe
charges that parent for boxes that were never bought.

### Written as a declared table, not a subtraction

`lib/recipe-cost.js` now states the answer once:

```js
const MATERIAL_COST_COMPONENTS = Object.freeze({
  ingredients: true,
  labour:      true,
  overhead:    true,
  packaging:   false,
});
```

and derives a second figure from it beside the sale figure:

```js
  const materialBatchCost =
      (M.ingredients ? ingredientCost : 0) + (M.labour   ? labour         : 0)
    + (M.overhead    ? overheadAmount : 0) + (M.packaging ? packagingTotal : 0);
  const materialCostPerGram = batchSize > 0 ? materialBatchCost / batchSize : null;
```

`lib/recipe-rollup.js` reads `materialCostPerGram` where it read `costPerGram`.

**Why a table and not `batchCost - packagingTotal` at the one call site.** The
subtraction works today and is a trap: the next cost under question is overhead,
and it would land as a second subtraction in a second place with its own
arithmetic — at which point "which costs travel" has two answers that drift.
Written this way, changing the answer is editing one boolean.

**`costPerGram` is unchanged and still returned.** It is what the batch actually
cost per gram, several screens show it as exactly that, and conflating the two
would put a number on screen that is true of nothing.

### What moved: 14 materials

Eleven whose own recipe carries packaging, and **three that carry none of their
own and correct anyway**, because a material they consume was corrected. The
cascade is transitive and that is the proof of it.

| id | material | before | after | drop |
|---|---|---|---|---|
| 615 | Pickled Onions | 0.013376 | 0.008289 | **−38.03 %** |
| 616 | Hummus Asli | 0.020614 | 0.014821 | **−28.10 %** |
| 574 | Whole Sesame Tahini (Unhulled) | 0.019160 | 0.016665 | −13.02 % |
| 578 | Crunchy Peanut Butter | 0.019024 | 0.016645 | −12.51 % |
| 612 | Arugula-Basil Pesto | 0.040091 | 0.035531 | −11.38 % |
| 572 | Cashew Sour Cream | 0.046483 | 0.041351 | −11.04 % |
| 613 | Chick'EN Strips | 0.017895 | 0.016491 | −7.85 % |
| 617 | Baked Falafel | 0.023804 | 0.022291 | −6.36 % |
| 588 | Creamy Cashew Butter | 0.074223 | 0.069761 | −6.01 % |
| 634 | Crunchy Granola | 0.066353 | 0.063705 | −3.99 % |
| 587 | Beet salad dressing | 0.060201 | 0.058163 | −3.39 % |
| **581** | **Noodle salad dressing** | 0.034121 | 0.033609 | −1.50 % *(inherited only)* |
| **619** | **Tofu wrap sauce** | 0.019506 | 0.018940 | −2.90 % *(inherited only)* |
| **621** | **Sesame tofu** | 0.014400 | 0.014335 | −0.45 % *(inherited only)* |

Every move is downward. No material moved that should not have.

### What moved: 7 products, of 75 recipe-linked

| id | product | before | after | drop |
|---|---|---|---|---|
| 347 | Garlic Dill Sour Cream | 11.367102 | 10.297727 | **−9.41 %** |
| 210 | Falafel Wrap | 7.392295 | 6.745476 | **−8.75 %** |
| 9 | Nacho Cheese Dip | 9.270428 | 8.923383 | −3.74 % |
| 71 | Beet Salad | 9.542650 | 9.440750 | −1.07 % |
| 42 | Tofu Banh Mi Wrap | 6.276001 | 6.243151 | −0.52 % |
| 203 | Chickpea Salad | 6.123505 | 6.092658 | −0.50 % |
| 66 | Thai Buckwheat Noodle Salad | 9.996110 | 9.964366 | −0.32 % |

The other 68 do not move, and a product moves **only** when its recipe consumes a
corrected material — asserted, not assumed.

### The nine dual-purpose products do not move at all

A product is dual-purpose when its recipe **also** backs a linked material — the
same batch part-sold and part-held. These are where the two costings meet, so a
mistake would surface here first:

| product | recipe | material |
|---|---|---|
| 78 Pickled Onions | 21 | 615 |
| 100 Baked Falafel | 40 | 617 |
| 101 Seitan | 51 | 590 |
| 189 Whole Sesame Tahini | 16 | 574 |
| 199 Creamy Cashew Butter | 54 | 588 |
| 212 Chick'EN Strips | 62 | 613 |
| 226 Crunchy Granola | 14 | 634 |
| 234 Arugula-Basil Pesto | 11 | 612 |
| 348 Crunchy Peanut Butter | 25 | 578 |

**Every one keeps its `unit_cost` unchanged while its material side drops.** That
is the split doing exactly what it is for: the jar on the shelf still carries its
jar, and the same sauce ladled into a wrap no longer does.

### Recipe 9, the worked example, after

```
ingredientCost  110.13272   (was 122.9652 — the ¥12.83 phantom is gone)
packagingTotal   13.44      (real, unchanged — this batch IS boxed)
batchCost       123.57272
costPerServing   10.297727  = store_products.unit_cost for product 347
```

### Independent corroboration nobody planned

`ingredient_price_history` holds seven hand-entered per-gram figures recorded by
`jing` on **2026-08-16**. Four can be cross-checked against the fix:

| material | hand entry, 2026-08-16 | the fix computes | the pre-fix value |
|---|---|---|---|
| Cashew Sour Cream | 0.04135 | 0.041351 | 0.046483 |
| Creamy Cashew Butter | 0.06976 | 0.069761 | 0.074223 |
| Crunchy Peanut Butter | 0.01664 | 0.016645 | 0.019024 |
| Whole Sesame Tahini | 0.01666 | 0.016665 | 0.019160 |

**A person working these out by hand ten days ago arrived at the packaging-free
figures, not the packaging-inclusive ones.** The rollup never reads price history,
so this is genuinely independent. It is corroboration of the answer, not evidence
used to reach it.

### Verification

33 assertions, all passing, against a fixture cut read-only out of production and
driving the real modules — the old tree and the new tree over identical copies:

- the 14 materials move to the figures above and nothing else moves;
- exactly 7 products move, and the 9 dual-purpose ones do not;
- **the sale path is byte-identical** — 137 recipes × 12 fields (`batchCost`,
  `costPerServing`, `costPerGram`, `marginPerServing`, `foodCostPct`,
  `suggestedSellPrice`, `packagingTotal`, `ingredientCost`, `labour`,
  `overheadAmount`, `hasCostRow`, `zeroCostIngredientLines`) with **zero**
  differences;
- the three inherited-only materials correct, and a two-hop chain (recipe 23 →
  Noodle salad dressing #581 → Crunchy Peanut Butter #578) lands on the
  table-derived figure rather than on batch-cost-over-size;
- the blocked set, the dependency order and the cycle check are unchanged;
- **the cascade is stable** — run 1 writes 14 materials + 7 products, runs 2 and 3
  write **zero**. The same gate PR #78 used.

### It reaches production through the existing triggers, with no manual pass

`applyRollup` **re-plans the entire graph** on every call — not just the recipe
that triggered it — so the first trigger of any kind corrects all 14 materials and
all 7 products in one transaction. The ten live trigger points from PR #78:

| trigger | site |
|---|---|
| `admin.repair_items` | `routes/admin.js:407` |
| `ingredients.update` | `routes/ingredients.js:207` |
| `purchases.po_price_writeback` | `routes/purchases.js:187` |
| `recipes.update` | `routes/recipes.js:372` |
| `recipes.cost_update` | `routes/recipes.js:399` |
| `retail-materials.update` | `routes/retail-materials.js:303` |
| `retail-recipes.update` | `routes/retail-recipes.js:305` |
| `retail-recipes.cost_update` | `routes/retail-recipes.js:326` |
| `products.recipe_link` | `routes/retail.js:20749` |
| `materialize_new` / `materialize_link` | `lib/recipe-materialize.js:79`, `:141` |

**The deploy's own restart is NOT a trigger.** The only boot-time path that
computes recipe costs (`database.js:4287-4321`) is a one-time migration guarded by
`_migrations` — `store_products_recipe_link_v1` is already recorded as run — and
additionally scoped `WHERE recipe_id IS NULL`. So nothing fires on start, and the
stale figures stand until a person acts.

**What the first trigger will be, on the evidence:** a material price edit or a
purchase-order price write-back. Over the last seven days `ingredients.updated_at`
moved 135 times and `purchase_orders.updated_at` 12 times, both most recently at
`2026-08-26 09:09:46` — minutes before this was written. `recipes` moved 61 times
and `recipe_cost_data` 36. In practice this corrects itself within hours of
deploy, not days; `admin.repair_items` is the button if it needs forcing.

---

## 16. What the fix does not reach (found 2026-08-26)

Status: open. Recorded rather than fixed, so neither gap is mistaken for closed.

### Price history keeps two incompatible definitions, and the fix leaves both

`ingredient_price_history` is **append-only** and holds **18 rows** for made
materials. They are in two different units, and nothing in the row says which:

| when | rows | shape | example |
|---|---|---|---|
| 2026-08-07 → 2026-08-11 | **11** | per jar / per pack | Cashew Sour Cream **6.62** |
| 2026-08-16 | **7** | per gram | Cashew Sour Cream **0.04135** |

Same material, same column, same `source`, a 160× difference in magnitude, and no
discriminator. `buy_unit` does not separate them; `notes` is empty on all 18.

> **Correction to the brief that commissioned this work.** It described the split
> as *"ten packaging-inclusive from the rollup, four packaging-free from the
> 2026-08-16 hand entries"*. **The rollup writes no price history at all** — no
> `INSERT INTO ingredient_price_history` exists in `lib/recipe-rollup.js` or
> anywhere else outside `routes/ingredients.js`, and **all 18 rows carry
> `source = 'manual'` and `recorded_by = 'jing'`.** The real split is 11 and 7,
> both hand-entered. The finding is unchanged in substance and slightly worse in
> detail: there is not even a `source` value to tell the two definitions apart.

**The fix leaves every one of them.** It writes `ingredients.cost_per_unit` and
nothing else; history is append-only and is not rewritten. So after the fix the
history holds per-jar figures, packaging-inclusive per-gram figures, and
packaging-free per-gram figures, all indistinguishable. Anything reading it as a
series — `routes/ai.js` `price_history` and `compute_margin`'s mover detection
(`:2325-2328`) both do — is comparing numbers that do not mean the same thing.

### Waste costing's packaging exclusion was defeated — and this fix CLOSES it

Stated plainly because the answer is not the one the shape of the question
suggests.

`routes/waste.js:56` deliberately rebuilds a packaging-free batch total:

```js
  // Packaging-free batch total — see note 1 above.
  const batchCost = c.ingredientCost + c.labour + c.overheadAmount;
```

and its reasoning is sound (`:28-35`): packaging is reused when a finished unit is
wasted, so counting it would double-count.

**It was being defeated.** Excluding `packagingTotal` removes only the recipe's
OWN packaging. A made material arrived inside `c.ingredientCost` with the child
recipe's packaging already folded into its `cost_per_unit`, and no subtraction at
this level could see it. Waste was asking the right question of a number that had
already been contaminated one level down.

**Option A closes it, and closes it without waste changing at all** — because the
contamination is removed at the source. Measured on recipe 9:

```
waste figure BEFORE : 10.247102 per serving
waste figure AFTER  :  9.177727 per serving
difference          :  1.069375  — exactly the packaging waste meant to exclude
                                   and did not
```

**11 recipes were affected.** After the fix, `waste.js`'s exclusion means what it
says for the first time. This is a repair it gets for free, and it is worth
recording as evidence for §29's second supporting note: waste excluded at the
CONSUMER and was defeated; deriving the exclusion at the SOURCE is what made it
hold.

### Everything else in findings 2 to 14 is untouched

The fix changes which costs travel with a material. It does not give products a
packaging field (finding 2), join `packaging_types` to materials (findings 3, 12),
make the typed cost a reference (finding 4), clean the materials master (finding
5), distinguish a missing cost row from a zero one (finding 6), allow more than
one packaging type per recipe (finding 7), correct the two AI tools (finding 8),
deplete anything (finding 9), add per-store costs (finding 10), stop the Tacet
save nulling `packaging_type_id` (finding 11), resolve the naming collision
(finding 13) or remove `packaging_types` from the wipe list (finding 14).

---

## Context — what was and was not done on 2026-08-26

> **Amended after findings 15 and 16.** The bullet below was written when this
> document ended at finding 14 and it was true of that survey. A later pass the
> same day changed code. Amended in place rather than deleted.

- **The survey behind findings 1 to 14 wrote nothing and changed no code.** Every
  figure in them is from a read-only query or from reading the source. No recipe,
  cost row, packaging type, material, product or purchase order was modified.

- **Finding 15 then changed code** — `lib/recipe-cost.js` and
  `lib/recipe-rollup.js` — and `docs/tacet-consolidation-decisions.md` §29 gained
  the rule behind it. **Still nothing was written to production data by this
  session**: the verification ran against a detached fixture, and the corrected
  figures reach production only when one of the ten existing triggers next fires.

- **Method.** Queries were run against `roots.db` over SSH using
  `sqlite3 'file:…?mode=ro'`. No application module was loaded against
  production — requiring one is not read-only, for the reason recorded in
  `docs/meituan-findings.md`'s working note.

- **Two of the survey's opening claims did not survive it**, and both are
  corrected in place rather than dropped: the "zero updates since" claim in
  finding 4 (unprovable, and the real situation is worse), and the
  pack-price-as-unit-price suspicion in finding 5 (false for the recipe field,
  true for the materials master).

- **Finding 1 was found by asking what a made material's unit cost is made of**,
  after findings 2 through 14 were already written. It is placed first because it
  is the only one that is a wrong number rather than a missing structure.

- **No rule is proposed here.** Whether §29 or §30 should gain a line about
  which of a recipe's costs travel with a made material is a decision, not a
  finding, and it belongs to whoever owns that document.

Source: read-only queries of `roots.db` on 2026-08-26 over SSH, and the code
cited above at `488dddf1`.
