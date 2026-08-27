# packaging — Findings

Nineteen findings, opened 2026-08-26 by a simple question — *what does packaging
cost us* — and ending in a number that was counted twice on eleven materials and
sixteen recipe lines.

**Finding 1 is first because it was the one worth acting on. It has since been
FIXED** — see finding 15 for what was changed and what it moved. Everything else
in this document is structure, and the structure is mostly defensible.

**Findings 1 to 14 were a read-only survey and wrote nothing.** Finding 15 is the
fix that followed and it changed code. Finding 16 records what the fix does NOT
reach, so the gap is not mistaken for closed. Every number below is a read-only
query against `roots.db`, and the queries are given so they can be re-run.

**Findings 17, 18 and 19 shipped nothing and wrote nothing either, and none of
the three opened a database** — each is read from the code, and each carries the
read-only SQL that would verify it rather than the answer. **Findings 18 and 19
are the outliers of this document in subject**: 18 is a recipe-IDENTITY defect
and 19 is an unsourced figure in a decision record, and both are filed here only
because checking §31's worked example and its cost estimate surfaced them. Read
their opening paragraphs before citing either as a packaging finding.

> **Amended 2026-08-26 — FINDING 11 IS NOW ALSO FIXED.** The sentence above is
> true of the survey that produced findings 1 to 14 and is no longer true of
> finding 11's entry, which has since gained a fix of its own (`routes/` and a
> new `lib/`, no data written). It was fixed ahead of the other thirteen because
> it was the only one still actively DESTROYING data: every save on Tacet's Cost
> & Pricing tab discarded a packaging link, and those links are the packaging
> migration's machine-resolvable input. **The migration's input stopped
> degrading as of that change.** Amended in place rather than rewritten.

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

> **Added 2026-08-26, after §31 was written.** This document is now also the
> evidence behind **§31 (product unit cost — contents plus packaging)**, which
> settles that a product's cost is its contents plus its packaging, that
> packaging attaches to the PRODUCT as a LIST of ordinary materials, and that an
> empty list means unknown rather than zero. It draws on findings 2, 3, 4, 6, 9
> and 12. **The sentence above still holds — no rule is proposed here** — and the
> closing note at the foot of this document, that whether §29 or §30 should gain
> a line is a decision rather than a finding, is left standing as written: §31 is
> the answer that was given to it, recorded in the document that owns decisions.

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

Status: **FIXED 2026-08-26 — see "The fix" at the end of this finding.** The
description below is of the fault as it stood. **THE MIGRATION'S INPUT STOPPED
DEGRADING AS OF THIS CHANGE**; what was already lost before it is a separate
question, answered under "What was lost, and whether it comes back".

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

### The fix — an absent field is not a cleared field (built 2026-08-26)

**Fixed on the SERVER, not on the screen**, and the choice is the point. The
client repair — have Tacet send the stored id back untouched — fixes one caller
of one route. The fault is that a route DELETED A FIELD ON BEING HANDED NOTHING
ABOUT IT, and that is wrong for every caller, including ones not yet written.
This is §30 rule 3's worked example applied to a second surface: **a rule
enforced by the callers of a write is a convention, and a convention is declined
by whichever caller nobody checked.**

The UPSERT moved out of both cost routes into `lib/recipe-cost-data-write.js`,
which now owns the one rule:

| what the caller sends | what happens |
|---|---|
| **no `packaging_type_id` key** | the stored value is **kept** |
| the key, empty (`null` / `''` / `0`) | **cleared** — a deliberate unlink |
| the key with a value | that value is written |

**CLEARING HAD TO KEEP WORKING, AND THE OBVIOUS REPAIR WOULD HAVE BROKEN IT.**
`COALESCE(incoming, stored)` — one word, passes the regression test — makes an
explicit NULL indistinguishable from an absent key, so **a packaging link could
never be removed once set.** That is the trap `lib/meituan-map-write.js:148-162`
already documents on the mapping side, where the clear is checked FIRST, before
the gate, so a product with an unverifiable stored name stays removable rather
than frozen. Same distinction, same reason: a rule meant to protect a value must
not trap it.

**NOTHING ELSE GAINED PRESERVE-ON-ABSENT SEMANTICS.** An absent `labour` still
writes 0; an absent `target_food_cost` still writes 30, including the stored-0-
becomes-30 quirk `lib/recipe-cost.js:248` reads back. Deliberate, and asserted:
the other five are numbers a form always sends, and making them sticky would mean
a field cleared to blank could never return to zero.

**The kitchen route was changed too, though it was not the one losing links.**
The Cost Sheet does send `packaging_type_id` (`public/app.html:8062`), so its
behaviour is unchanged — but it carried a byte-identical copy of the same
coalesce, and leaving one route repaired and one not would be two answers to one
question, waiting to drift.

**Verified against an in-memory fixture, not production**
(`scripts/test_recipe_cost_data_write.js`, 32 assertions, the write called
directly rather than through HTTP). The two failure modes were confirmed
*catchable* by mutating the rule back and re-running: reverting to the original
coalesce fails 5 assertions, and the COALESCE trap fails 4 — including both
deliberate-clear cases. A test that passes against the broken code proves
nothing, which is why both mutants were run.

**One case is there because the repair introduced a new way to fail.** Preserving
means READING the stored row first, and both routes key that read on
`req.params.id` — a string, against an `INTEGER` column. Had a string id failed
to match, the lookup would return nothing, the stored value would read as null,
and the preserve would quietly become "write null": the original bug through a
new door, passing every other case in the file. SQLite applies numeric affinity
to the comparison so it matches, and that is asserted rather than reasoned about.

### What was lost, and whether it comes back

**Not recovered here — nothing was written.** What follows is what the evidence
can and cannot support.

**There is no audit trail of the destruction itself.** Neither cost route logs
activity (confirmed above), `recipe_cost_data` is last-write-wins with no history
table, and `updated_at` is overwritten by the save that did the damage. So
recovery cannot come from the record of the loss. It has to come from somewhere
else, and there are three somewheres:

1. **A backup.** The strongest, because it is exact rather than inferred. The box
   takes an **hourly** local SQLite snapshot (`/root/scripts/roots-backup.sh`)
   and a nightly off-site copy to OSS with **`RETAIN_DAYS=14`**
   (`scripts/db-backup.sh:70`). **Recipe 80 lost its link at 07:28:46 on
   2026-08-26** — the 07:00 snapshot of that same morning holds the answer
   outright. **Recipe 36 lost its at 07:14:04 on 2026-08-11, which is 15 days
   back and therefore just OUTSIDE the off-site window**; whether the local
   hourly tier still reaches it cannot be established from this repository,
   because `roots-backup.sh` is one of the three untracked scripts that exist
   only on the box (`docs/tacet-operating-findings.md` §3.4) and its retention
   is not readable here.
2. **The number matching exactly one type's cost.** Recipe 80's 1.12 equals
   `packaging_types` id 2 (`300ml Plastic Box`). This is evidence, not proof, and
   its weakness is finding 4's: a type's cost can be edited with no timestamp and
   no log, so today's cost is not necessarily the cost that was copied. It is
   only conclusive if exactly one of the 44 carries that figure.
3. **`activity_log`, which is better than finding 4 implies.** The packaging-type
   CREATE handler records `{ name, cost }` (`routes/lookups.js:87`) — so **the
   cost each type was born with survives even if the type has since been
   edited**, for all 56 creates including the 12 later deleted. The UPDATE
   handler still logs nothing (`:91-99`), so this recovers the original figure,
   never an intermediate one. **This evidence expires**: `activity_log` is purged
   on every startup at `ACTIVITY_LOG_RETENTION_DAYS`, default **90**
   (`database.js:4033-4039`), so the 2026-08-11 creation entries are readable
   until roughly **2026-11-09** and then are not.

**The rate of loss, and the current count, are not established here.** Two rows
were recorded on 2026-08-26; whether more were lost between then and this fix
needs a live query, which this pass did not run:

```sql
-- Every packaging number with no link, newest loss first.
SELECT recipe_id, packaging, updated_at
  FROM recipe_cost_data
 WHERE COALESCE(packaging,0) > 0 AND packaging_type_id IS NULL
 ORDER BY updated_at DESC;

-- Is recipe 80's 1.12 unique among the types? (>1 row = not recoverable this way)
SELECT id, name, cost FROM packaging_types WHERE ABS(cost - 1.12) < 0.0005;
SELECT id, name, cost FROM packaging_types WHERE ABS(cost - 0.10) < 0.0005;

-- The same question against the cost each type was CREATED with.
SELECT entity_id, json_extract(details,'$.name') AS name,
       json_extract(details,'$.cost') AS cost_at_create, created_at
  FROM activity_log
 WHERE entity_type = 'packaging_type' AND action = 'create'
   AND ABS(CAST(json_extract(details,'$.cost') AS REAL) - 1.12) < 0.0005;
```

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
| 612 | Arugula-Basil Pesto | 0.040091 | 0.035530 | −11.38 % |
| 572 | Cashew Sour Cream | 0.046483 | 0.041350 | −11.04 % |
| 613 | Chick'EN Strips | 0.017895 | 0.016491 | −7.85 % |
| 617 | Baked Falafel | 0.023804 | 0.022291 | −6.36 % |
| 588 | Creamy Cashew Butter | 0.074223 | 0.069761 | −6.01 % |
| 634 | Crunchy Granola | 0.066353 | 0.063705 | −3.99 % |
| 587 | Beet salad dressing | 0.060201 | 0.058163 | −3.39 % |
| **581** | **Noodle salad dressing** | 0.034121 | 0.033609 | −1.50 % *(inherited only)* |
| **619** | **Tofu wrap sauce** | 0.019506 | 0.018940 | −2.90 % *(inherited only)* |
| **621** | **Sesame tofu** | 0.014400 | 0.014335 | −0.45 % *(inherited only)* |

Every move is downward. No material moved that should not have.

> **Correction, 2026-08-26, made after the deploy against the live result.**
> Two figures in this table were first published as `0.041351` (572) and
> `0.035531` (612). **Those were my arithmetic, not the code’s.** The rollup
> rounds to six decimal places with `Math.round` (`lib/recipe-rollup.js:206`),
> and the raw values are `0.04134961…` and `0.03553024…`, which round to
> **0.041350** and **0.035530**. I had rounded the sixth decimal up by hand.
> Production wrote the correct values; this table did not match them. Corrected
> in place. The percentages are unaffected.
>
> It tightens the corroboration below rather than weakening it: the hand entry
> of **2026-08-16 reads `0.04135`**, which is the corrected figure exactly.

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
| Cashew Sour Cream | 0.04135 | 0.04135 | 0.046483 |
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

> **Amended 2026-08-26 — finding 11 is no longer on that list.** It was fixed by
> a separate, later change (see finding 11's own "The fix"), not by finding 15's.
> The rest of the sentence stands.

---

## 17. A BLOCKED material never catches up, so finding 15's fix does not reach it (found 2026-08-26)

Status: **open. Read-only — nothing was shipped for this and no data was written.**

**THIS IS A STALE-INPUT CONSEQUENCE OF BLOCKING, NOT AN INCOMPLETE EXCLUSION.**
Stated first because the symptom is identical to the one finding 15 closed, and a
reader meeting it will reasonably conclude the fix did not work. It did.
Packaging is removed where a made material's unit cost is DERIVED
(`lib/recipe-cost.js:184` → `lib/recipe-rollup.js:174`), so every consumer
inherits the correction and `routes/waste.js:56`'s exclusion is complete. What
follows is about a material the corrected derivation **never runs for**.

`lib/recipe-rollup.js:205-216` — when `costOneRecipe` refuses, `planRollup`
records the material in `blocked[]`, sets its override to `null`, and `continue`s:

```js
    if (!result.ok) {
      overrides.set(mat.ingredient_id, { cpu: null });
      …
      blocked.push({ … oldCpu: mat.cost_per_unit });
      continue;
    }
```

**No write happens on that branch, and that is correct** — it is the rule
`lib/recipe-rollup.js:20-28` states as *"BLOCKED NODES STOP THE CASCADE, THEY DO
NOT ZERO IT"*, which is what stops a blocked material reading as free. The
consequence is the part worth recording: **the row keeps whatever
`cost_per_unit` it already had, indefinitely, and nothing marks it as stale.**

**So a material blocked since before `c86ef74e` still holds a
packaging-inclusive figure**, and a wasted product whose recipe consumes it is
costed with that packaging included. Not because the exclusion is incomplete, but
because the corrected derivation has never been allowed to run for that material.
The block is the cause; the stale number is the symptom.

**Seven conditions block, not the four most often named:**

| reason | line |
|---|---|
| `recipe_missing` | `:132` |
| `recipe_archived` | `:133` |
| `no_ingredient_lines` | `:145` |
| `unpriced_lines` | `:147` |
| `unreconciled_units` | `:162` |
| `no_batch_size` | `:164` |
| `no_cost_per_unit` | `:173` |

**The count is UNKNOWN and UNMEASURED.** No database was opened for this finding —
the container it was written in holds no copy of `roots.db` and no route to the
box. How many linked materials are blocked, how many of those were last written
before `c86ef74e`, and whether any is consumed by a recipe backing a product that
is actually wasted, are all open. **The clearing case is open too**: a block that
lifts causes the next trigger to write the corrected figure, so this self-heals
per material at an unknown rate.

### How to measure it — and how NOT to

> ⚠️ **DO NOT REQUIRE THE APPLICATION'S MODULES AGAINST PRODUCTION TO ANSWER
> THIS.** `require('./database')` is not a read: `database.js:4033-4039` runs
> **`DELETE FROM activity_log WHERE created_at < …`** at module load, on every
> load, gated only by `ACTIVITY_LOG_RETENTION_DAYS` (default 90). **A "read-only"
> diagnostic that pulls in the app has already purged the activity log once.**
> That log is currently the only surviving record of what each packaging type
> cost when it was created (`routes/lookups.js:87`), which finding 11 depends on
> for recovery — so the tool used to measure this finding can destroy the
> evidence another one needs. The same hazard is recorded in
> `docs/meituan-findings.md`'s working note.

Two safe routes, both of which avoid loading any application module:

1. **`sqlite3 -readonly` against production**, or equivalently
   `sqlite3 'file:…?mode=ro'`. Read the candidates directly; derive nothing:

```sql
-- Linked materials, with when each was last written. Any row whose
-- updated_at predates c86ef74e (2026-08-26 17:30:56 +0800) is a candidate.
SELECT id, name_en, sku, cost_per_unit, source_recipe_id, updated_at
  FROM ingredients
 WHERE source_recipe_id IS NOT NULL
 ORDER BY updated_at;

-- Which of those a wasted product could actually reach.
SELECT DISTINCT p.id, p.name_en
  FROM products p
  JOIN recipe_ingredients ri ON ri.recipe_id = p.recipe_id
  JOIN ingredients i         ON i.id = ri.ingredient_id
 WHERE i.source_recipe_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM waste_entries w WHERE w.product_id = p.id);
```

2. **A detached fixture against a restored backup** — restore a snapshot into a
   throwaway file and run `planRollup` there, where requiring the app is
   harmless because the activity log being purged is a copy. `blocked[]` is the
   answer directly, with each material's `reason` and `oldCpu` already on it, and
   `scripts/rollup_made_material_costs.js` already drives exactly this in
   dry-run.

**Neither route writes to production, and route 2 is the only one that can name
the reason per material** — the SQL in route 1 finds candidates by date, not by
block state, so it over-reports.

---

## 18. Two recipes are named Hummus Asli, so its products link to neither — and nothing says so (found 2026-08-27)

Status: **open. Read-only — nothing was shipped for this and no data was written.**

**THIS IS A RECIPE-IDENTITY DEFECT, NOT A PACKAGING ONE.** Stated first so it is
not read as belonging to this document's subject: nothing about packaging causes
it, nothing about packaging is needed to fix it, and it would be exactly as true
in a system with no packaging model at all. **It is filed here only because
§31's rule 2 offered Hummus Asli as a worked example, and checking the example
surfaced it.** Whoever owns recipe identity owns this; this entry is the record,
not the claim on it.

### Two recipes, one name, differing only by SKU

`database.js:4267-4268`, in the comment above the one-off product→recipe link:

```js
//     knows which is current — that is what excludes both Hummus Asli recipes
//     (7 / 1-12 and 92 / 1-10), without needing to name them.
```

Recipe **7** (SKU `1-12`) and recipe **92** (SKU `1-10`) share **both**
`name_en` and `name_cn`. The only field that separates them is the SKU.

### Why sharing both names is exactly the case the matcher cannot resolve

`database.js:4263` states the rule the linker enforces:

```js
//   * two or more of {exact SKU, exact name_en, exact name_cn} agree — survey
//     group A. One signal alone (group B, 36 pairs, all SKU-only) is NOT enough
```

and `:4311` enforces it — `if (sigs.size < 2) continue;`.

**Two of three must agree, and the SKUs differ, so SKU can serve for neither
recipe.** That leaves `name_en` and `name_cn` as the only signals available, and
both are required. But both are what the two recipes SHARE — so any product
matching one recipe on both names matches the other on both names too, and
**both qualify**. The rule that was written to demand more evidence produces, on
this family, two equally-evidenced answers. Nothing in the data prefers either.

### The product is then dropped silently

`database.js:4332`:

```js
        if (rids.size > 1) { ambiguous++; continue; }
```

`continue` — no write, no log line, no row marked. The product keeps
`recipe_id IS NULL` and `unit_cost` untouched. The only trace is a counter, in
the migration's own console line, `database.js:4345-4346`:

```js
    console.log(`[store_products] recipe link: ${linked} product(s) linked + costed from a recipe `
      + `(skipped ${ambiguous} ambiguous, ${noCost} no usable recipe cost, ${scaled} sample/multipack); `
```

**That is server stdout at migration time, seen once by whoever was watching the
boot.** No warning reaches any user, no screen names the products, and the
counter does not say WHICH products or WHICH recipes collided. A reader of the
catalogue afterwards sees products with no recipe and no reason given.

### What this means for §31

**The affected products therefore hold NO recipe link at all** — not a link to
the wrong recipe, not a shared link, none. So Hummus Asli is not §31 rule 2's
shape (one recipe, several products packed differently); **it is the case rules
7 and 8 exist for** — a product that must be able to carry packaging with no
recipe anywhere in the picture. Rule 2 has been corrected accordingly
(`docs/tacet-consolidation-decisions.md` §31, v4.93); Crunchy Granola remains
that rule's only worked example.

### The 300ml box attributed to it was recipe 9's

§31 rule 2 said Hummus Asli sat "on one recipe carrying a single 300ml box".
Recipe 7's packaging link is not a 300ml box and is not a link:

```sql
SELECT recipe_id, packaging, packaging_type_id, typeof(packaging_type_id)
  FROM recipe_cost_data WHERE recipe_id = 7;
-- 7 | 1.0 | pt1778315688913 | text
```

**`'pt1778315688913'` is a client-generated string id sitting in an `INTEGER`
column, and it matches no `packaging_types` row** — finding 7 records it as an
orphan. The `300ml Plastic Box` / `300毫升塑料瓶` is `packaging_types` id 2 and
belongs to **recipe 9**, per `packaging-findings.md:314-315`. The box was
attributed to the wrong recipe.

### UNVERIFIED — no database was opened for this finding

**That recipes 7 and 92 both still exist, and still share both `name_en` and
`name_cn`, is NOT a live read.** `database.js:4267` is a claim made by whoever
wrote that migration, at the time they wrote it. Either recipe may since have
been renamed, re-SKU'd, archived or deleted, in which case the family is no
longer ambiguous and the products may have linked on a later run — though the
migration is `_migrations`-guarded and does not re-run, so a link would have to
come from somewhere else. **Everything above about the MATCHING RULE is read
from the code and is verified; everything about the two rows is not.**

### How to verify it — read-only

The finding 17 constraint applies unchanged and is not optional here:
**`sqlite3 -readonly` only, no application modules, and never
`require('./database')`** — `database.js:4033-4039` runs
`DELETE FROM activity_log WHERE created_at < …` at module load, so requiring the
app to "read" the database purges the activity log that finding 11's recovery
depends on. Loading `database.js` would additionally attempt this very
migration.

```sh
sqlite3 -readonly roots.db        # or: sqlite3 'file:roots.db?mode=ro'
```

```sql
-- 1. Do both rows still exist, and do they still collide on both names?
SELECT id, sku, name_en, name_cn
  FROM recipes
 WHERE id IN (7, 92)
 ORDER BY id;

-- 2. The collision without naming ids — every name pair carried by more than
--    one recipe. Hummus Asli should appear; anything else here is the same
--    defect on another family.
SELECT name_en, name_cn, COUNT(*) AS n, GROUP_CONCAT(id) AS recipe_ids,
       GROUP_CONCAT(sku) AS skus
  FROM recipes
 GROUP BY name_en, name_cn
HAVING COUNT(*) > 1
 ORDER BY n DESC, name_en;

-- 3. The products that lost their link to it. Unlinked actives whose own
--    name matches a recipe name — the population the ambiguous counter hid.
SELECT sp.id, sp.sku, sp.name_en, sp.name_cn, sp.recipe_id, sp.unit_cost
  FROM store_products sp
 WHERE COALESCE(sp.is_active,1) = 1
   AND sp.recipe_id IS NULL
   AND EXISTS (SELECT 1 FROM recipes r
                WHERE r.name_en = sp.name_en OR r.name_cn = sp.name_cn)
 ORDER BY sp.name_en, sp.sku;

-- 4. Recipe 7's orphan type id, and whether it resolves. Expect no row from
--    the join half.
SELECT c.recipe_id, c.packaging, c.packaging_type_id,
       typeof(c.packaging_type_id) AS ty,
       (SELECT COUNT(*) FROM packaging_types t
         WHERE CAST(t.id AS TEXT) = CAST(c.packaging_type_id AS TEXT)) AS resolves
  FROM recipe_cost_data c
 WHERE c.recipe_id IN (7, 9, 92);
```

Query 3 over-reports by design: it finds unlinked products whose name matches
*any* recipe, which includes products skipped for the other three reasons in the
counter (`noCost`, `scaled`) as well as the ambiguous ones. **Narrowing it to the
ambiguous set alone requires re-running the matcher's own logic, and that must
not be done by importing the app** — read the four fields and apply the
two-of-three rule by hand, or use finding 17's route 2, a detached fixture
against a restored backup.

---

## 19. The "65 margins" figure has no measured source, and the operative number is smaller (found 2026-08-27)

Status: **open. Read-only — nothing was shipped for this and no data was written.
No number is corrected here, because no number was measured here.**

§31's consequences state:

> **65 products carry a packaging figure through their recipe today, and each one
> needs its packaging picked once.** That one-time pass is **the real cost of this
> change** — not the code.

**Sixty-five is the budget for the pass §31 calls the real cost of the change,
and it appears in exactly two places, both of which are §31 itself:**

| where | what it is |
|---|---|
| `docs/tacet-consolidation-decisions.md:4244` | §31's consequences — the claim |
| `docs/tacet-consolidation-decisions.md:19` | v4.88's changelog entry — the same claim, restating the section |

*(Both were `:4240` and `:17` until v4.93's own entry and rule-2 correction shifted
them by four and two lines respectively. The line numbers move; the count of two
does not — grep `65 products` if they have drifted again.)*

No query, no survey line, and no finding in this document produces it. The
counted figures this survey *did* produce are finding 6's — 93 cost rows with
`packaging > 0`, 10 explicitly zero, 34 recipes with no cost row — and those are
counts of RECIPES, not of products. **65 is not derivable from them**, because
the recipe→product fan-out is exactly what nobody has counted: one recipe backs
several products (that is rule 2's whole subject), and some products link to no
recipe at all (finding 18). **It is recorded here as unsourced, not as wrong.**

### The operative number is NOT 65

Even taken at face value, 65 is the wrong number for the decision it is being
spent on. **A product that already shows an em dash in its margin column for want
of a sell price has no margin to move**, whatever packaging is picked for it.
`public/retail-admin/09-products.js:786`:

```js
  if (!Number.isFinite(p) || p <= 0) return null;   // no price → no margin to state
```

and `:1165` renders that null:

```js
  if (!ms.length) return '<span class="pa-col-margin pa-col-muted">—</span>';
```

So the number that matters is **65 minus the products already rendering an em
dash** — and it is that smaller number, not 65, that §31 rule 9's third-state
rendering decision turns on. Rule 9 requires unknown, explicit-no-packaging and a
figure to be three distinguishable states; the cost of showing the unknown state
is paid per product whose margin cell would visibly change. **A product with no
sell price shows an em dash before the change and an em dash after it.** Sizing
the rendering decision against 65 sizes it against a population that includes
rows the decision cannot reach.

### Pin the population BEFORE running either query

Both queries below are unrunnable as *definitions* until three things are
settled, and the two figures will not agree with each other or with 65 unless
the same choices are made for both:

1. **Archived in or out.** `status = 'Active'` means "not archived"
   (`routes/retail.js:14733`), and it is independent of `is_published`. An
   archived product is not being sold and arguably needs no pass; an unpublished
   but active one may be published tomorrow. 65 states which of the three
   populations it counted: it does not.
2. **Whether `packaging = 0` counts as needing the pass.** Finding 6 counts 10
   cost rows at an explicit zero and 34 recipes with no cost row at all, and
   finding 6's whole point is that today those two are indistinguishable on
   screen. Under §31 rule 9 they are different facts — one is "no packaging",
   the other is "unknown" — so whether the zeros need an operator to confirm
   them is a rule-9 question, not a counting question, and it must be answered
   first.
3. **Which product table.** `store_products` is the retail catalogue §31 is
   about; kitchen `products` is a separate id space with its own `recipe_id`,
   which `database.js:4276-4278` records as unreliable ("one bad row in four").
   The queries below read `store_products` only.

Answer those three, then run both. **Do not reconcile the results against 65** —
65 has no method behind it to reconcile with.

### The two queries — read-only

Finding 17's constraint again, unchanged: **`sqlite3 -readonly`, no application
modules, never `require('./database')`** (`database.js:4033-4039` purges the
activity log at module load).

```sh
sqlite3 -readonly roots.db        # or: sqlite3 'file:roots.db?mode=ro'
```

```sql
-- (a) THE GROSS POPULATION — products carrying a packaging figure through their
--     recipe. This is the claim 65 makes. Adjust the two pinned choices in
--     place: drop the status filter to include archived; change `> 0` to
--     `>= 0` to count explicit zeros as needing the pass.
SELECT COUNT(*) AS gross
  FROM store_products sp
  JOIN recipe_cost_data c ON c.recipe_id = sp.recipe_id
 WHERE sp.recipe_id IS NOT NULL
   AND COALESCE(sp.status, 'Active') = 'Active'
   AND COALESCE(c.packaging, 0) > 0;

-- (b) THE OPERATIVE POPULATION — the same set, minus every product whose margin
--     already renders as an em dash for want of a sell price. Mirrors
--     _paMargin() at public/retail-admin/09-products.js:786: a margin exists
--     only where sell_price is finite and > 0.
SELECT COUNT(*) AS operative
  FROM store_products sp
  JOIN recipe_cost_data c ON c.recipe_id = sp.recipe_id
 WHERE sp.recipe_id IS NOT NULL
   AND COALESCE(sp.status, 'Active') = 'Active'
   AND COALESCE(c.packaging, 0) > 0
   AND sp.sell_price IS NOT NULL
   AND CAST(sp.sell_price AS REAL) > 0;

-- (c) The difference, itemised — the products (b) drops. Worth reading rather
--     than counting: a product with a recipe, a packaging figure and no sell
--     price is its own question.
SELECT sp.id, sp.sku, sp.name_en, sp.sell_price, sp.status, c.packaging
  FROM store_products sp
  JOIN recipe_cost_data c ON c.recipe_id = sp.recipe_id
 WHERE sp.recipe_id IS NOT NULL
   AND COALESCE(sp.status, 'Active') = 'Active'
   AND COALESCE(c.packaging, 0) > 0
   AND (sp.sell_price IS NULL OR CAST(sp.sell_price AS REAL) <= 0)
 ORDER BY sp.name_en;
```

**Neither query is a substitute for the third pinned choice.** Query (a) with
`> 0` silently adopts the answer "explicit zeros do not need the pass"; that is a
decision under rule 9 and it should be made deliberately, not inherited from a
comparison operator.

### 65 is left standing in §31

**Deliberately.** It has not been changed, because replacing an unsourced number
with a second unsourced number is not an improvement, and no database was opened
for this finding. §31's v4.93 entry records the gap and points here. When the
queries above are run against a pinned population, §31's consequence bullet can
be corrected from a measurement.

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

- **Finding 11 then changed code too**, in a later pass the same day —
  `routes/recipes.js`, `routes/retail-recipes.js` and a new
  `lib/recipe-cost-data-write.js` that both now share. **Again nothing was
  written to production data**: the write was verified against an in-memory
  fixture (`scripts/test_recipe_cost_data_write.js`), and the two rows that had
  already lost their link were deliberately **left alone** — whether the original
  type is recoverable is set out under finding 11 and the decision is Ash's, not
  this pass's. **The pass that established recoverability had no database
  access** and did not run a live query; every count in that section is flagged
  as needing one.

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

---

# Appendix A — the packaging schema, established against the live database (2026-08-27)

This appendix exists because the schema was being reconstructed over SSH from
the wrong table and the reconstruction kept coming out wrong. Everything below
is a live read of `/root/roots-v2/data/roots.db` (721 MB) on 2026-08-27, run as
`sqlite3 'file:…?mode=ro'`. No application module was loaded against production,
for the reason recorded in this document's method note.

**The 721 MB file is the live one.** `/root/roots-v2/roots.db` is a 0-byte
placeholder from 2026-06-04 and answers "no such table" to every query. So does
`/root/roots-v2/data/tenants/roots.db`, a second 0-byte file from 2026-07-05.
A query aimed at either reads as "the column does not exist", which is the
single easiest way to conclude a column was dropped when it never moved.

## A.1 `recipes` has never held packaging. `recipe_cost_data` does.

`PRAGMA table_info(recipes)` is correct as quoted — sixteen columns, no
`packaging`, no `packaging_type_id`. That is not a loss and not a migration.
**Packaging has always lived one table over.** `recipes` holds what a recipe
IS; `recipe_cost_data` holds what someone TYPED about its cost, one row per
recipe, `recipe_id` UNIQUE with `ON DELETE CASCADE`.

```sql
CREATE TABLE recipe_cost_data (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id     INTEGER NOT NULL UNIQUE,
  labour        REAL DEFAULT 0,
  packaging     REAL DEFAULT 0,        -- per serving
  packaging_type_id INTEGER,
  overhead_pct  REAL DEFAULT 0,
  sell_price    REAL DEFAULT 0,
  target_food_cost REAL DEFAULT 30,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE
)
```

`sqlite_master` reports **no indexes** on this table beyond the implicit unique
index behind `recipe_id`.

**The cost column is named `packaging`, not `packaging_cost`.** A query written
against `packaging_cost` fails with `no such column`, which reads identically to
querying the 0-byte decoy. Two different mistakes, one indistinguishable
symptom — worth naming because both were in play.

The lookup table it points at:

```sql
CREATE TABLE packaging_types (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  name_cn       TEXT,
  cost          REAL DEFAULT 0,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
, image_data TEXT)
```

No `updated_at` — which is finding 4's problem restated: an edit to a type's
cost leaves no timestamp and no log, so today's `cost` is not necessarily the
cost that was copied into any recipe.

## A.2 Only one screen can set the type pointer, and it is not Tacet's

**Tacet's Cost & Pricing tab writes `recipe_cost_data.packaging` and nothing
else about packaging.** `costTab()` in
`public/retail-admin/19-recipes.js:686-702` renders five plain number inputs;
the packaging one is at `:694-695`, with the helper text pointing at the kitchen
app. `draftCostData()` at `:715-722` builds the save payload and carries exactly
five keys — `labour`, `packaging`, `overhead_pct`, `sell_price`,
`target_food_cost`. **`packaging_type_id` is not among them.** The payload goes
to `PUT /api/retail-admin/recipes/:id/cost` from `rcpSave` at `:1019`.

So the answer to "does anything on that screen write the type pointer" is **no,
and there is no control on that screen that could.** The helper text is the only
thing on it that knows the pointer exists.

**The picker lives in the kitchen app.** `public/app.html`:

| what | where |
|---|---|
| type `<select>` | `#cs_pack_type`, `app.html:7750-7754` |
| its change handler | `onCsPackTypeChange()`, `app.html:7843` |
| the number box it mirrors | `#cs_packaging`, `app.html:7757` |
| the save that sends the pointer | `saveCostSheet(recipeId)`, `app.html:8057-8062` |
| type CRUD modal | `showPackTypeManager()` / `savePackTypesFromDOM()`, `app.html:7864-8008` |

`saveCostSheet` at `:8062` sends
`packaging_type_id: (packSel && packSel.value && packSel.value !== '__manage__') ? packSel.value : null`
— a real id when one is selected, a literal `null` when the operator picks
"Custom / None". That literal null is the deliberate unlink the fix at
`lib/recipe-cost-data-write.js` had to keep working, and is why COALESCE was the
wrong repair.

Note the shape: **the number box mirrors the selected type's cost** (`:7757`
reads `pt.cost` when a type is linked, and greys the field). So on the kitchen
app the number is a *copy of* the type's cost. On Tacet the same number is a
free-typed figure with nothing behind it. Same column, two different meanings
depending on which screen last wrote it — finding 4's copy-not-reference,
observed from the UI side.

## A.3 Ninety-one rows carry a pointer; ninety of them resolve

Live counts, 2026-08-27:

| | |
|---|---|
| `packaging_types` rows | 44 |
| `recipes` rows | 137 |
| `recipe_cost_data` rows | 104 |
| rows with `packaging_type_id IS NOT NULL` | **91** |
| of those, resolving to a real `packaging_types.id` | **90** |
| of those, dangling | **1** |
| rows with `packaging <> 0` | 93 |
| distinct types actually pointed at | 24 (23 real + 1 bogus) |
| types nothing points at | 21 of 44 |

All 91 pointer rows belong to real, `is_active = 1` recipes. **The recipe ids
holding a pointer** (91):

```
7   8   9   10  11  12  13  14  15  16  17  18  20  21  22  23  25  26  27  28
34  35  40  42  43  47  48  49  52  54  55  56  62  63  64  65  67  68  69  70
71  72  73  74  75  77  78  79  81  82  83  85  86  87  88  90  92  96  98  102
111 112 113 114 115 116 117 118 119 120 121 122 124 125 126 127 128 129 130 131
132 133 134 135 136 137 138 139 140 141 142
```

### The dangling one is a client-generated id that was never a row

**Recipe 7 (`Hummus Asli`) holds `packaging_type_id = 'pt1778315688913'`, and
`typeof()` says `text`.** `packaging_types.id` is `INTEGER PRIMARY KEY
AUTOINCREMENT`; nothing in that table has ever had that id. SQLite's loose
typing accepted the string into an INTEGER column without complaint.

The origin is `readPackTypeRowsFromDOM()` at `app.html:7973-7976`:

```js
id: _packagingTypes[i]?.id || 'pt' + Date.now() + i,
```

A newly added type gets a **client-side placeholder id** before the server has
given it a real one. If the operator selects that fresh type in the dropdown and
saves the cost sheet before the type list round-trips, the placeholder is what
lands in `recipe_cost_data`. It resolved to nothing then and it resolves to
nothing now.

**This is a second way to lose the link, and the de29c633 fix does not touch
it.** That fix stops an absent key from erasing a good pointer. This one writes
a bad pointer through the front door — the key is present and non-empty, so
every rule in `lib/recipe-cost-data-write.js` passes it straight through. Not
fixed here; recorded so the packaging migration (§31) knows one of its 91 inputs
is unresolvable for a different reason than the two NULLs are.

## A.4 Recipes 36 and 80, restated against the real schema

Both earlier statements were about the right rows and the wrong table name.
What actually happened, and where:

| | recipe 36 | recipe 80 |
|---|---|---|
| name | Beet salad dressing / 甜菜根沙拉酱 | Zhoug — Green Chill Dip / 青辣椒酱 |
| table | `recipe_cost_data` | `recipe_cost_data` |
| `packaging` | **0.1** | **1.12** |
| `packaging_type_id` | NULL | NULL |
| `updated_at` | 2026-08-11 07:14:04 | 2026-08-26 07:28:46 |

**"Recipe 36 lost its `packaging_type_id` on 2026-08-11"** — the row is on
`recipe_cost_data`, not `recipes`, and 2026-08-11 07:14:04 is that row's
`updated_at`, which is the last write of ANY of its six cost columns. It is not
a timestamp of the pointer specifically, because no such timestamp exists.
**Whether 36 ever had a pointer is not established.** Its save falls inside the
window the 44 types were being created (05:44–07:27 that morning), so "never
set" and "set then erased" are both consistent with the evidence. Its 0.1
matches exactly one type today — id 57, a pressure-sensitive gasket for powder
bottles — which is a poor semantic match for a salad dressing and is weak
evidence either way.

**And yes — recipe 36's pointer is still absent today.** `packaging` is still
`0.1`, `packaging_type_id` is still NULL, and `updated_at` has not moved off
2026-08-11 07:14:04 in the sixteen days since. Nothing has written that row,
including the fix.

**"Recipe 80 shows packaging 1.12 with a NULL pointer"** — correct as stated,
and it is the stronger of the two. `activity_log` has recipe 80 created
2026-08-14 08:00:55 and renamed 2026-08-14 08:01:33; its cost row was last
written 2026-08-26 07:28:46. Its 1.12 is exactly `packaging_types` id 2
(`300ml Plastic Box`, 1.12) and no other type carries that figure. So a type was
picked, the number was copied from it, and a later save dropped the link — the
finding-11 mechanism, on the row that shows it most clearly. **Also still
absent today**, unchanged since 2026-08-26 07:28:46.

**Neither loss appears in `activity_log`.** The log holds `create`/`update`/
`delete` on `recipe` only — 269 updates, 136 creates, 2 deletes — and **zero**
entries of any action from either cost route. Confirmed live, as finding 11
predicted from the code.

### Nothing new has been lost since the fix

The fix is deployed: `/root/roots-v2/lib/recipe-cost-data-write.js` is on the
box. The set of rows with a packaging number and no pointer is **still exactly
{36, 80}** — no third row has joined them. Eleven further rows have a NULL
pointer, but all eleven carry `packaging = 0`, so there is no number to have
been orphaned:

| recipe | packaging | updated_at |
|---|---|---|
| 19 | 0.0 | 2026-08-27 01:22:47 |
| 30 | 0.0 | 2026-08-11 11:51:00 |
| 31 | 0.0 | 2026-08-11 09:46:01 |
| 32 | 0.0 | 2026-08-11 09:36:35 |
| 33 | 0.0 | 2026-08-11 09:36:11 |
| 39 | 0.0 | 2026-08-11 09:37:18 |
| 51 | 0.0 | 2026-08-11 09:37:37 |
| 59 | 0.0 | 2026-08-11 10:56:39 |
| 60 | 0.0 | 2026-08-11 09:36:55 |
| 66 | 0.0 | 2026-08-11 10:54:00 |
| 143 | 0.0 | 2026-08-25 07:25:30 |

Recipe 19 was written on 2026-08-27, after the fix landed, and still has a NULL
pointer — which is the correct outcome for a row that never had one, not a
regression. **This is evidence the loss stopped, not proof.** A save on a row
that never had a pointer is indistinguishable from a save that preserved a null,
and the absent audit trail means that will remain true.

## A.5 The de29c633 fix was never testable from Cost & Pricing

**The test plan assumed a control that does not exist.** Cost & Pricing has no
packaging picker, no type name, no type thumbnail — it shows one number and one
line of helper text. There is nothing on that screen that displays
`packaging_type_id`, so nothing on it can show whether the pointer survived a
save. Opening the tab, editing a field, saving, and looking at the screen would
have shown an unchanged number both before and after the fix. **That test passes
against the bug.**

That is not a gap in the fix; it is the fix's own premise. The commit message
says the client repair "fixes one caller of one route" and that the fault was a
route deleting a field it was handed nothing about. The screen was never the
subject.

**The real test is a two-surface test, and neither surface is Cost & Pricing:**

1. **Set the pointer in the kitchen app** — `app.html`, cost sheet,
   `#cs_pack_type` (`:7750`), save via `saveCostSheet` (`:8057`).
2. **Save from Tacet's Cost & Pricing tab** — change any input, save.
3. **Read the pointer back out of the database**, because no screen will tell
   you:

```sql
SELECT recipe_id, packaging, packaging_type_id, updated_at
  FROM recipe_cost_data WHERE recipe_id = ?;
```

   Pre-fix the pointer is NULL and `updated_at` has moved. Post-fix the pointer
   is unchanged and `updated_at` has moved.
4. **Confirm the clear still works** — back in the kitchen app, select
   "Custom / None" and save. The pointer must go to NULL. This is the half the
   COALESCE repair would have broken, and skipping it tests only the easy
   direction.

**The headless version already exists and is the better test:**
`scripts/test_recipe_cost_data_write.js` drives `saveRecipeCostData()` against
an in-memory fixture and asserts all three cases — absent key preserves, present
and empty clears, present with a value writes — plus that no other column gained
preserve-on-absent semantics. It needs no browser, no login, and no production
database. Run that; use the four UI steps above only to confirm the two real
callers send what the unit test assumes.

## A.6 Working note — `data/tenants/*.db` are provisioning orphans

`/root/roots-v2/data/tenants/` holds `2.db`, `4.db`, `5.db`, `6.db`, `7.db`
(~1.6 MB each) and a 0-byte `roots.db`. They are written by
`lib/tenant-db.js` — `getTenantDb(id)` opens `data/tenants/<id>.db` and runs
`initTenantSchema()` into it on **every** open, cloning the main DB's
data-plane structure (148 tables, no rows, control-plane tables skipped);
`lib/provision-tenant.js` then seeds a `storefront_config` baseline. Tenant #1
(Roots) deliberately does not get a file — `getTenantDb(1) === mainDb` — which
is why there is no `1.db`. **All five are abandoned.** Every one is
schema-only apart from its storefront baseline (0 orders, 0 products, 0
customers; `storefront_config` 5/32/33/32/33 rows), the newest was last touched
2026-08-05, and — decisively — the `tenants` control-plane table in the live
`roots.db` holds **one row, id 1 (Roots, active)**, and `tenant_users` holds 7
rows all on tenant 1. There are no control-plane rows for 2, 4, 5, 6 or 7, so
nothing can route a request to any of those files; they are residue of
provisioning runs whose `tenants` rows were removed, plus whatever the
`scripts/diagnose_tenant_step_*.js` helpers created as a side effect of
requiring `tenant-db.js`. `TENANT_DATA_ISOLATION=1` **is** set in the box's
`.env`, so the machinery is armed and functioning — it simply has no non-Roots
tenant to serve. The 0-byte `data/tenants/roots.db` is a third decoy, created
2026-07-05, distinct from the 0-byte one at the repo root.

Source: read-only queries of `/root/roots-v2/data/roots.db` and
`data/tenants/*.db` on 2026-08-27 over SSH, and the code cited above at
`0f82a1f2`.
