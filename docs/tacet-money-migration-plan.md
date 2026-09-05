# Money as integers — the plan

Answers Q1 of `docs/tacet-fix-2026-09-handover.md` (audit finding **A-06**, High).
The question asked was "permission to plan it, or not now". This is the plan.

Nothing here is built. Nothing here is scheduled.

**§1a carries the measured baseline** taken from the live database on 2026-09-05,
before any change. It answers the questions §8 originally asked, and it forces one
correction to the approach that only the data could have shown: not every money
column should become integer cents.

---

## 1. What is actually wrong

Every amount a merchant deals in is a SQLite `REAL` — a binary floating-point
number. `0.1` has no exact binary representation, so sums of many small amounts
drift, and two figures that should be equal differ by a fraction of a cent.

This is not theoretical here, and the codebase already says so out loud.
`lib/channel-settlement.js:32`:

```js
// Money is compared at cent resolution everywhere in this codebase; a float sum
// of four decimals lands on 45.999999999999996 often enough to matter.
const r2 = (n) => Math.round(Number(n) * 100) / 100;
…
const CENT = 0.005;
const sameMoney = (a, b) => Math.abs(a - b) < CENT;
```

Somebody hit this, understood it exactly, and wrote a half-cent tolerance rather
than fix the storage. That was the right call at the time. There are now **about
twenty** such tolerance sites across `routes/`, `lib/` and `public/` — including
the refund path, where `isFull = amount + 0.005 >= remainingGross` decides
whether a customer is refunded in full.

Today it is invisible. The day it is not, it is a customer refunded the wrong
amount, and the tolerance is what let it through.

### The platform already does it correctly, for itself

`billing_invoices.amount_cents`, `billing_plans.price_cents`,
`tenants.setup_fee_cents`, `guanyi_listing_jobs.cost_total_cents`,
`waste_records.cost_total_cents` are all integer minor units.

So the platform's own money is exact and the merchant's money is not. That split
is not a design decision anybody made; it is where two eras of the codebase meet.
It also means **the convention already exists** and this work extends it rather
than inventing anything.

---

## 1a. MEASURED — the live numbers, 2026-09-05

Run: `scripts/diagnose_money_precision.js` through `ro-query.yml`, read-only and
proven so (the connection was handed a `CREATE TABLE` and rejected it). Actions
run 89, exit 0. **This is the Stage 0 baseline. It predates any change, which is
the only reason it is worth anything.**

### The inventory is 93, not 51 and not 89

**107 money-named columns across 49 tables — 93 REAL, 12 INTEGER, 1 DATE, 1 TEXT.**

Both earlier counts were wrong. The audit's 51-of-61-across-32 under-counted; the
source scan's 89-across-37 was closer but still missed columns and invented
others. The live schema settles it — and the live list *also* over-captures on
name alone (`tenants.commission_rate_bps` is a rate in basis points,
`meituan_settlements.settled_on` is a date, `retail_customers.points_balance` and
`retail_stock_ledger.balance_after` are points and stock, not money). So the
human pass this plan opens with is still required. It now has a correct starting
set rather than a guess.

### The backfill is trivial. This question is closed.

| rows | table |
|---:|---|
| 146,374 | `retail_checkout_quotes` |
| 28,400 | `sales_entries` |
| 22,446 | `miniapp_order_lines` |
| 5,147 | `retail_order_items` |
| 1,427 | `retail_orders` |
| 834 | `retail_payments` |

**325,091 non-null money values in total.** One `UPDATE` per column, sub-second.
No batching, no live-service stall, no maintenance window. The question about
production row counts is answered and needs nothing further.

### 0.73% of stored money is already not a whole number of cents

**2,381 dirty / 1,293 deep, of 325,091.** Not zero — so a rounding decision has
to be made, and it is the one irreversible act in the migration.

Where it is concentrated matters more than the total:

| dirty / of | column | share |
|---:|---|---:|
| 264 / 285 | `retail_order_items.unit_cost_at_sale` | **93%** |
| 454 / 760 | `ingredients.cost_per_unit` | **60%** |
| 79 / 94 | `store_products.unit_cost` | 84% |
| 65 / 187 | `guanyi_product_pricing.excel_gz_price` | 35% |
| 498 / 2,070 | `ingredient_price_history.price` | 24% |
| 280 / 5,147 | `retail_order_items.unit_price` | 5.4% |
| 21 / 834 | `retail_payments.amount` | 2.5% |
| 21 / 1,427 | `retail_orders.total` | 1.5% |

Two of these are the bug itself, sitting in the data where anyone can look at it:
`store_products.unit_cost` runs from `1.7342365999999998`, and
`guanyi_product_pricing.excel_gz_price` from `7.699999999999999` to
`131.20000000000002`. Those are not prices anybody typed. They are what a float
does to `7.70`.

### The correction this forces: amounts are not rates

**"Convert everything to integer cents" is wrong, and the data is what shows it.**

`ingredients.cost_per_unit` is 60% sub-cent because it is *not an amount*. It is a
cost per gram — oat groats at `0.042` yuan/g. In cents that is 4.2, which is not
an integer, and rounding it to 4 would move the cost basis of every recipe by 5%.
`unit_cost_at_sale` is 93% sub-cent for the same reason.

So the columns split into two kinds, and they need different targets:

- **Amounts** — what somebody actually pays or is paid. `retail_orders.total`,
  `retail_payments.amount`, `line_total`, the fees, the refunds. These are money
  and they go to **integer cents**. They are also the cleanest today (1–5% dirty),
  which is consistent with their being real amounts rather than computed rates.
- **Rates** — a price per unit of something. `cost_per_unit`, `unit_cost_at_sale`,
  and possibly `unit_price` where goods are priced per gram. Integer cents would
  *destroy* precision here. These need a smaller unit (integer micro-units, 1/10⁴
  of a yuan) or to keep numerator and denominator.

Deciding which kind each of the 93 columns is *is* the inventory pass in §2a, and
it is now the highest-value step in the plan. Getting it wrong on a rate column is
not a rounding error, it is a 5% error in every recipe cost.

### Today's failure baseline — recorded

| result | n | check |
|---|---:|---|
| ok | 0 | payments refunded for more than was paid |
| ok | 0 | orders refunded for more than the customer tendered |
| ok | 0 | orders approved to refund more than the customer tendered |
| ok | 0 | **cash returned above the cash actually taken** |
| ok | 0 | negative order totals |
| ok | 0 | line totals that are not `unit_price × qty` to the cent |
| — | 0 | lines priced on a fractional quantity |

**The baseline is clean. Nothing in the refund data is wrong.**

> **Correction, made the same day.** The first version of this section reported
> *"two orders are refunded for more than they cost — a real defect sitting in
> production right now"*. **That was wrong, and it was my check that was wrong,
> not the data.**
>
> The check compared the refund against `retail_orders.total`. But `total` is only
> the **cash** portion — what the customer paid with money once points and wallet
> balance were applied. `routes/retail.js:32439` gives the real ceiling:
>
> ```js
> function orderTenders(o) {
>   const P = points_amount, B = balance_used, C = total;
>   return { P, B, C, G: P + B + C };
> }
> ```
>
> A refund is capped at **G**, and `splitRefundAcrossTenders` returns each part to
> the tender it came from. So on an order paid partly with points or store credit,
> refunding more than `total` is exactly right.
>
> Both flagged orders are textbook correct (`scripts/diagnose_refund_ceiling.js`,
> Actions run 90):
>
> | order | cash | points | balance | gross | refunded | cash out |
> |---|---:|---:|---:|---:|---:|---:|
> | `R260625999440` | 25.00 | — | 38.80 | 63.80 | 63.00 | 24.69 |
> | `TC000306` | 24.40 | 322.00 | — | 346.40 | 346.40 | 24.40 |
>
> `TC000306` refunded ¥346.40 of value while only ¥24.40 of cash left the
> business; the other ¥322 went back as points. Against the correct ceiling:
> **0 approved over gross, 0 paid over gross, 0 cash returned above cash taken.**
> Ten orders sit exactly at the ceiling, which is what a full refund looks like.
>
> This is the failure the precision script's own header warns about — *"a guessed
> invariant reporting a scary number is worse than no invariant"* — committed two
> sections after writing the warning. The check in
> `diagnose_money_precision.js` is corrected to measure gross, and a third check
> added for the one that would actually cost money: cash returned above cash
> taken.

Zero fractional quantities is a useful negative: the sub-cent `unit_price` values
are **not** from selling by weight, so they need explaining before that column is
converted.

### Channel settlement

5 eleme orders, **2 do not settle** — but by ¥42.50 (`discount_unrecorded`) and
¥5.00 (`delivery_not_billed`). Those are missing data, not rounding. Floating
point is not implicated and this migration will not fix them. Noted so the 40%
is not read as a precision finding. The sample is 5 orders; the channel mix is
808 wechat, 377 gzgrocery, 221 meituan, 5 eleme.

### What this settles for §8

1. **Row counts — answered.** Trivial. No batching.
2. **External readers — answered "no" by the owner.** The `_cents` rename is safe.
3. **Channel tables — deferred with evidence.** The eleme gaps are a data-capture
   problem, so including the channel tables would not fix them. They can wait for
   the sync redesign without leaving a precision hole.

---

## 2. Stage 0 — the inventory, and the oracle. Before touching anything.

### 2a. An authoritative column inventory

The audit says **51 REAL of 61 money columns across 32 tables** (Part 1 §8.1).
A scan run while writing this plan, with looser name matching, found **89
money-shaped REAL columns across 37 tables**.

**Those two numbers disagreeing is the first finding.** Mine picks up columns the
audit's stricter list excluded (`retail_orders.channel_settle_amount`,
`.balance_used`, `.refund_cash_amount`) and also picks up false positives
(`_migrations.*` is a snapshot table, not money). Neither list is trustworthy
enough to migrate from.

So step one is a committed, reviewed file — one row per column:

| table | column | affinity | unit | written by | read by | derived from |
|---|---|---|---|---|---|---|

`derived from` is the important one. `retail_orders.total` is a *sum of other
columns*; `retail_customers.lifetime_spend` is a *rollup of other rows*. Derived
columns can be recomputed and checked. Source columns cannot — they are the
record, and a conversion error in one is unrecoverable. The two get different
treatment and different levels of paranoia.

### 2b. `scripts/check_money_invariants.js`

Built in the shape of the two that already exist — `check_ledger_invariants.js`,
`check_points_invariants.js` — which take `--db <path>` and read a real database
rather than a fixture. The invariants:

- an order's `total` equals its `subtotal` + fees − discounts
- payments against an order never exceed its total
- refunds never exceed what was paid
- `retail_customers.lifetime_spend` equals the sum of that customer's orders
- `settlementGap()` returns null for every channel order

### 2c. Record the baseline BEFORE any change

Run 2b against a copy of production and **write down what already fails.**

This is the step it would be easiest to skip and most expensive to have skipped.
Some of those invariants almost certainly do not hold today — that is what a
half-cent tolerance in the refund path implies. If the current failure set is not
recorded first, every pre-existing discrepancy gets attributed to the migration,
and the migration gets rolled back for a bug it did not cause.

**Deliverable of Stage 0: two files and a recorded number. No behaviour change.**

---

## 3. Stage 1 — `lib/money.js`, and stop the bleeding

One module, which does not exist today (there is no `lib/money.js`, and §8.2 of
the audit found *seven* disagreeing formatters):

```
toMinor(x)          yuan → cents, the single rounding decision in the codebase
fromMinor(n)        cents → yuan, for display and for legacy callers
sumMinor(xs)        exact
splitMinor(n, ws)   allocate n cents across weights, largest-remainder,
                    deterministic — 100 across 3 is 34/33/33 and always the
                    same 34. This is where the refund tender split belongs.
```

`splitMinor` is the one with teeth. Dividing money is where the fractions come
from, and "divide and hope" is what the tolerances are compensating for.

Alongside it, a gate — `scripts/check-money-helpers.js`, built exactly like
`scripts/check-swallowed-errors.js`: a budget at today's count of raw
`toFixed(2)`-on-money sites, failing when exceeded. The current surface is **606
`toFixed(` and 443 `Math.round(`** across `routes/`, `lib/` and `public/`. Not
all of those are money. The gate's job is only to stop the number growing while
the rest of this work happens.

**Deliverable of Stage 1: a module and a gate. No schema change, no behaviour
change, ships on its own, reversible by deletion.**

---

## 4. Stage 2 — convert, one table-family at a time

### Why not a single conversion

The tempting version is: rebuild every table, convert every value, flip every
reader, ship once. I would not do this, for one specific reason.

**A cents column read as yuan is a 100× error.** A 100× error in a refund is
catastrophic and obvious. A 100× error in a report is catastrophic and *not*
obvious — it looks like a good month. With 51+ columns and readers spread across
`routes/`, `lib/`, 23 admin JavaScript files and the mobile surfaces, a big-bang
depends on having found every single reader, and the failure mode of missing one
is silent and financial.

So the design goal is not "convert correctly". It is **"make a missed reader
impossible to miss."**

### The ladder, per table-family — four ships

1. **Add `<col>_cents` beside the existing column.** Idempotent `addColumn`, the
   file's own idiom. Backfill `CAST(ROUND(col * 100) AS INTEGER)`. Nothing reads
   it. Zero risk.
2. **Dual-write.** Every writer writes both columns. Ship it and let it run.
3. **Shadow-check.** A boot/nightly sweep asserting `ROUND(col*100) == col_cents`
   for every row, reporting divergence through the notification log that now
   exists. **A divergence is a writer that was missed** — found in production, by
   a check, before anything depends on the new column. This rung is the whole
   point of the ladder.
4. **Flip readers to `_cents`.** Ship. The old column is still there and still
   correct, so a missed reader is *stale*, not *wrong by 100×*.

The `REAL` column is dropped only after a full retention window with zero
divergence — a fifth ship, and the only irreversible one.

### Naming is not cosmetic

Every converted column is **renamed** with the `_cents` suffix, never converted
in place. JavaScript has no unit type and this codebase has no type checker, so
the suffix is the type system. A column that changes unit while keeping its name
is a trap set for whoever reads the code next — including me, six weeks later.

This is also why the existing `_cents` columns are the right convention to extend
rather than replace.

### Proposed order — by consequence, not by size

| # | Family | Why here |
|---|---|---|
| 1 | `retail_payments`, `retail_orders` refund columns | Where the half-cent tolerance decides a real refund to a real customer. Smallest blast radius, highest value. |
| 2 | `retail_orders` money columns, `retail_order_items` | The largest family (14 + 3 columns) and the settlement gap. |
| 3 | `retail_customers.lifetime_spend`/`.balance`, points | The rollups, where drift compounds over time rather than per-row. |
| 4 | Purchasing + recipes (`po_line_items`, `ingredients`) | Costs, and where the SQL-side `SUM(billableQty * cost_per_unit)` lives. |
| 5 | Channel tables (`meituan_orders` ×12, settlement, zones, vouchers) | **See the open question in §7** — the channel sync redesign is out of scope. |
| 6 | The remainder | Whatever the Stage 0 inventory turns up. |

---

## 5. Stage 3 — the SQL-side arithmetic

Roughly **112** `SUM(...)` / `ROUND(...)` sites over money columns, built inside
SQL strings — the PO line total posted to the expense ledger, the dashboard's
takings, the finance summary, the lifetime-spend rollups. These bypass every
helper, so today their rounding is SQLite's.

Most of this stage **fixes itself**: `SUM()` over an INTEGER column is exact.
What needs real work is division — splitting a discount across lines, prorating
a delivery fee — which moves to `splitMinor` so the remainder is allocated
deterministically instead of landing wherever the float did.

---

## 6. Stage 4 — delete the tolerances. This is the acceptance test.

The ~20 `0.005` sites and `lib/channel-settlement.js`'s `CENT` become exact
comparisons. **Deleting them is how you know the work is finished** — not a
passing test suite, which can pass with the tolerances still in place.

Any tolerance that *cannot* become an exact comparison is the interesting
outcome: it means there is a real modelling disagreement the floats were hiding,
and it is worth more than the migration.

---

## 7. Rehearsal — reusing the pattern this repo already trusts

`scripts/db-backup.sh` writes hourly snapshots to `/root/backups/hourly`.
`scripts/restore-test.sh` already restores one, runs `PRAGMA integrity_check`,
and counts rows in the load-bearing tables.

`scripts/verify_made_material_links.js` establishes the pattern for a change like
this one, and says why in its own header: *"a copy for rehearsal, then production
after deploy. A fixture passing is not evidence about production, which is why
this takes a path."*

So each rung of each ladder runs:

1. restore the latest snapshot to a scratch path
2. run the migration against it
3. `check_money_invariants.js --db <scratch>` — require zero delta against the
   Stage 0 baseline
4. only then production, and the same gate against production afterwards

### Per-tenant

Tacet is database-per-tenant. Every migration and every sweep iterates
`tenants WHERE status = 'active'` the way `lib/low-stock-digest.js` does, not the
shared handle. Roots is tenant 1 and `getTenantDb(1) === mainDb`, so for Roots
this is a passthrough — which makes Roots a poor test of the per-tenant path and
means a second account must be exercised deliberately.

The control-plane billing tables are already `_cents` and are not touched.

---

## 8. What I need from you before starting

**All three original questions are now closed — see §1a.** Row counts came from
the live database (trivial, no batching). External readers: answered "no", so the
rename is safe. Channel tables: deferred with evidence, because the eleme gaps
turned out to be missing data rather than rounding, so including them would not
have fixed anything.

What remains is not a question I can answer by measuring:

1. **Go or no-go**, given that §1a moved the shape of the work. The rate-vs-amount
   split means the inventory pass is no longer clerical — it is a judgement about
   what each of 93 columns *means*, and it has to be right.
2. ~~The two over-refunded orders.~~ Investigated and closed — see the correction
   in §1a. There is no defect; the check was wrong. No action needed.

---

## 9. Honest sizing

Stage 0 and Stage 1 are one pass each and are worth doing **whether or not the
rest ever happens** — the inventory, the invariant checker with a recorded
baseline, the money module and the gate all stand alone and all reduce risk on
their own.

Stage 2 is five or six families at four ships each. Stages 3 and 4 are one to two
passes. This is weeks of calendar time, most of it spent waiting for shadow-check
rungs to prove themselves in production rather than writing code.

**The recommendation stands as it was in the handover: yes, but as its own piece
of work with a rehearsal on a copy of production — never folded into a fix pass.**

If that is too much, the fallback that keeps most of the value is **Stage 0 +
Stage 1 + family 1 only**: the refund path made exact, the invariants measurable,
and the bleeding stopped. That is a fraction of the cost and covers the case where
this bug actually costs somebody money.
