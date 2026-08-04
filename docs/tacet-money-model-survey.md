# Tacet money model — the unit gap between the application and Postgres

**2026-08-04 · Read-only survey of every column whose unit changed in the full data copy, every place the application reads or writes one, every place money arithmetic happens inside SQL rather than JavaScript, where fractional amounts arise, and what breaks during a mixed-engine transition. Live SQLite was opened `mode=ro` and proven so on every connection by a rejected write, not assumed. Postgres was read with SELECT only. Nothing was written to either database, no application code was changed, and no column type was altered. The `expense_entries` follow-up check in §8 was run the same day under the same constraints.**

> **What this document is: a SURVEY, not a specification.** It establishes what the conversion boundary must do. It is not the work itself, and it does not design the layer. Where the code does not settle a question the entry says so and flags it rather than classifying it.

> **Why it matters: this is the largest single item in Part 2 of the Postgres migration, and no amount of driver or compatibility work solves it.** The full data copy of 2026-08-04 changed 92 columns from `REAL` yuan to `bigint` cents and nine more from `REAL` yuan to `numeric(14,6)`. The application reads and writes yuan and contains **zero** conversion sites at the database boundary. An async `pg` driver, a sync shim, a query translator, a compatibility layer for `better-sqlite3` semantics — none of them change a unit. Point the application at Postgres unchanged and every price displays 100 times too high, every total sums in the wrong unit, and nothing errors, because `bigint` and `REAL` both arrive in JavaScript as `number`.

**Sources.** Live SQLite `/root/roots-v2/data/roots.db`; Postgres database `tacet` on 47.239.89.63; the copy plan `/root/tmp-migration-full/plan.json`, also committed at `scripts/postgres-full-copy/plan.json`; repository at `origin/main` `41780473`. The decision record this survey serves is `docs/tacet-consolidation-decisions.md` §24.

---

## 0 — The one-paragraph answer

The conversion is **not** a `×100` on 92 columns. It is a `×100` on 92 columns **plus** a second,
unconverted money model that lives outside those columns — in `storefront_config.value_json`, in
`retail_vouchers.value`, and in four `*_cents` columns that are already correct — and the boundary
layer cannot see any of it. Every one of the app's money *rules* (tier thresholds, points earn rate,
default delivery fees, affiliate rewards, voucher face values) is stored in yuan as JSON text and
will meet a converted column. Separately, ~97 SQL statements do money arithmetic **inside the
database**, where a JavaScript boundary layer has no reach, and at least two of those bind a
JavaScript-supplied yuan amount into a comparison against a converted column. A boundary layer is
the right shape for the problem; it will not be sufficient on its own.

---

## 1 — The columns

101 columns changed unit or type. 92 whole-cent, 9 `numeric(14,6)`. 40 distinct tables,
176,015 rows in those tables. Two of the 40 tables are empty (`invoice_pos`,
`retail_lifetime_commissions`) — their columns are still live code paths.

Every SQLite column below is declared `REAL` and holds **yuan**. Example values are a real paired
row: same `id`, read from live SQLite and from Postgres.

### 1a — Whole-cent transaction columns (92) — `REAL` yuan → `bigint` cents

| Table | Column | Rows | SQLite (¥) | Postgres (cents) |
|---|---|---:|---:|---:|
| guanyi_product_pricing | excel_retail | 187 | 40.0 | 4000 |
| guanyi_product_pricing | excel_gz_price | 187 | 32.0 | 3200 |
| gzgrocery_orders | total | 740 | 40.0 | 4000 |
| income_entries | amount | 13 | 283.16 | 28316 |
| invoice_lines | allocated_amount | 4 | 40.0 | 4000 |
| invoice_pos | allocated_amount | 0 | — | — |
| invoices | amount | 7 | 300.0 | 30000 |
| markets | daily_target | 6 | 1000.0 | 100000 |
| meituan_balance_flow | amount | 669 | 284.41 | 28441 |
| meituan_balance_flow | balance_after | 669 | 284.41 | 28441 |
| meituan_orders | product_total | 1844 | 141.0 | 14100 |
| meituan_orders | package_fee | 1844 | 1.5 | 150 |
| meituan_orders | customer_paid | 1844 | 144.5 | 14450 |
| meituan_orders | customer_delivery_fee | 1844 | 15.0 | 1500 |
| meituan_orders | merchant_subsidy | 1844 | −13.0 | −1300 |
| meituan_orders | platform_subsidy | 1844 | 3.0 | 300 |
| meituan_orders | delivery_fee_paid | 1844 | 14.1 | 1410 |
| meituan_orders | delivery_tip_paid | 1844 | 1.0 | 100 |
| meituan_orders | ad_spend | 1844 | 5.5 | 550 |
| meituan_orders | coupon_subsidy_paid | 1844 | 4.4 | 440 |
| meituan_orders | insurance_fee | 1844 | 0.14 | 14 |
| meituan_orders | commission | 1844 | −13.87 | −1387 |
| meituan_orders | partial_refund | 1844 | 40.44 | 4044 |
| meituan_orders | gross_amount | 1844 | 142.5 | 14250 |
| meituan_orders | net_to_merchant | 1844 | 130.49 | 13049 |
| meituan_settlements | bill_amount | 381 | 130.49 | 13049 |
| miniapp_order_lines | unit_price | 22447 | 45.0 | 4500 |
| miniapp_order_lines | line_total | 22447 | 45.0 | 4500 |
| miniapp_orders | product_total | 4457 | 170.0 | 17000 |
| miniapp_orders | delivery_fee | 4457 | 32.0 | 3200 |
| miniapp_orders | income | 4457 | 202.0 | 20200 |
| miniapp_orders | refund_amount | 4457 | 1.05 | 105 |
| miniapp_orders | coupon_discount | 4457 | 12.0 | 1200 |
| packaging_types | cost | 1 | 1.0 | 100 |
| products | sell_price | 278 | 57.0 | 5700 |
| products | retail_price | 278 | 0.0 | 0 |
| products | flash_price | 278 | *(all NULL)* | — |
| products | compare_at_price | 278 | 110.0 | 11000 |
| purchase_orders | extra_freight | 51 | 0.0 | 0 |
| purchase_orders | extra_tax | 51 | 0.0 | 0 |
| purchase_orders | extra_handling | 51 | 0.0 | 0 |
| recipe_cost_data | labour | 1 | 1.0 | 100 |
| recipe_cost_data | packaging | 1 | 1.0 | 100 |
| recipe_cost_data | sell_price | 1 | 38.0 | 3800 |
| **retail_checkout_quotes** | subtotal | **105735** | 367.0 | 36700 |
| retail_customers | lifetime_spend | 867 | 292.0 | 29200 |
| retail_customers | balance | 867 | 1741.5 | 174150 |
| retail_delivery_zones | base_fee | 15 | 15.0 | 1500 |
| retail_delivery_zones | max_fee | 15 | *(6 non-null, all 0)* | 0 |
| retail_delivery_zones | free_threshold | 15 | 299.0 | 29900 |
| retail_delivery_zones | packing_fee_per_item | 15 | 0.8 | 80 |
| retail_delivery_zones | packing_fee_cap | 15 | 10.0 | 1000 |
| retail_delivery_zones | same_day_surcharge | 15 | 40.0 | 4000 |
| retail_delivery_zones | weight_first_kg_fee | 15 | *(all NULL)* | — |
| retail_delivery_zones | weight_extra_kg_fee | 15 | *(all NULL)* | — |
| retail_lifetime_commissions | base_amount | 0 | — | — |
| retail_lifetime_commissions | commission_amount | 0 | — | — |
| retail_migration_credits | balance | 3420 | 74.55 | 7455 |
| retail_migration_unmatched | balance | 120 | 432.6 *(max)* | 43260 |
| retail_order_addons | amount | 16 | 31.0 | 3100 |
| retail_order_addons | addon_subtotal | 16 | 31.0 | 3100 |
| retail_order_addons | freed_shipping | 16 | 15.0 | 1500 |
| retail_order_items | unit_price | 2578 | 57.0 | 5700 |
| retail_order_items | line_total | 2578 | 57.0 | 5700 |
| retail_orders | subtotal | 767 | 367.0 | 36700 |
| retail_orders | shipping_fee | 767 | 40.0 | 4000 |
| retail_orders | voucher_amount | 767 | 20.0 | 2000 |
| retail_orders | points_amount | 767 | 30.0 | 3000 |
| retail_orders | total | 767 | 408.5 | 40850 |
| retail_orders | packing_fee | 767 | 1.5 | 150 |
| retail_orders | same_day_surcharge_fee | 767 | 40.0 | 4000 |
| retail_orders | refund_amount_requested | 767 | 15.0 | 1500 |
| retail_orders | refund_amount_approved | 767 | 15.0 | 1500 |
| retail_orders | refund_amount_paid | 767 | 15.0 | 1500 |
| retail_orders | balance_used | 767 | 18.6 | 1860 |
| retail_orders | refund_cash_amount | 767 | 15.0 | 1500 |
| retail_payments | amount | 439 | 408.5 | 40850 |
| retail_payments | refunded_amount | 439 | 15.0 | 1500 |
| retail_product_option_choices | price_delta | 117 | 6.0 | 600 |
| retail_referrals | reward_amount | 1 | 15.0 | 1500 |
| retail_referrals | referee_reward_amount | 1 | 15.0 | 1500 |
| retail_refund_events | amount | 51 | 15.0 | 1500 |
| retail_topup_packages | amount | 4 | 5000.0 | 500000 |
| retail_topup_transactions | amount | 178 | 5000.0 | 500000 |
| **retail_vouchers** | **min_subtotal** | 13 | 150.0 | 15000 |
| sales_entries | unit_price | 28400 | 53.3 | 5330 |
| sales_entries | total | 28400 | 53.3 | 5330 |
| store_products | sell_price | 325 | 89.0 | 8900 |
| store_products | retail_price | 325 | 56.0 | 5600 |
| store_products | flash_price | 325 | 145.0 | 14500 |
| store_products | compare_at_price | 325 | 220.0 | 22000 |
| waste_entries | retail_value | 3 | 86.0 | 8600 |

**A fact worth having:** the copy's `q_cents()` halts on any value that does not fit whole cents
(`abs(v×100 − round(v×100)) > 1e-6`). The run produced **zero halts**. So across all 92 columns and
176k rows there is **no genuine sub-cent value today** — every apparent "fractional" reading is
IEEE-754 representation noise (`0.14 × 100 = 14.000000000000002`), not business data. The boundary
layer does not have to preserve any existing sub-cent amount. It does have to stop new ones
appearing — see §4.

### 1b — The nine unit-cost columns — `REAL` yuan → `numeric(14,6)` **yuan**

These did **not** change unit. They changed *type*. They stay in yuan at scale 6. A boundary layer
that multiplies by 100 on the way out of these columns is wrong.

| Table | Column | Rows | SQLite (¥) | Postgres (¥, scale 6) | true >2dp values |
|---|---|---:|---:|---:|---:|
| ingredients | cost_per_unit | 565 | 127.1 | 127.100000 | 268 |
| ingredients | buy_price | 565 | 127.1 | 127.100000 | 107 |
| ingredient_price_history | price | 889 | 1.65166 | 1.651660 | 174 |
| po_line_items | cost_per_unit | 78 | 1.65166 | 1.651660 | 17 |
| po_line_items | total_cost | 78 | 79.27968 | 79.279680 | 15 |
| price_alerts | old_price | 256 | 44.64 | 44.640000 | 47 |
| price_alerts | new_price | 256 | 51.44 | 51.440000 | 65 |
| expense_entries | amount | 92 | 187.13958 | 187.139580 | 7 |
| waste_entries | cost_lost | 3 | 86.0 | 86.000000 | 1 |

Minimum live value is `ingredient_price_history.price = 0.004` — 0.4 of a cent. Whole cents would
have zeroed it. This is why these are numeric, per the decision recorded in
`docs/tacet-consolidation-decisions.md` §24.

**`expense_entries.amount` is the odd one here.** It is a general-ledger expense, not a unit cost —
it sits in the same finance queries as `income_entries.amount` (whole cents) and
`sales_entries.total` (whole cents). It was retyped to `numeric(14,6)` because 7 of its 92 rows
carry more than 2 decimal places. So `routes/finance.js:287-293` sums `income_entries.amount` in
**cents** and `expense_entries.amount` in **yuan** in adjacent statements and subtracts one from the
other downstream. **Flagged as ambiguous at the time of the survey — it was resolved by the
follow-up check in §8, and the decision is recorded in §24.**

### 1c — Must NOT convert: already cents on both sides (4)

| Table (SQLite → PG) | Column | Rows | SQLite | Postgres |
|---|---|---:|---:|---:|
| billing_plans | price_cents | 4 | 0 / 9900 / 29900 / 79900 | identical |
| tenants → **accounts** | setup_fee_cents | 1 | 300000 | 300000 |
| billing_invoices | amount_cents | 0 | *(empty)* | *(empty)* |
| plans | price_cents | 0 | *(empty, dead table)* | *(empty)* |

Copied verbatim, `cls=INT`. §24 records that multiplying `setup_fee_cents` would have overstated it
100-fold. Two are empty **today** — `billing_invoices` is written live by the commission-invoice
endpoint (`routes/store-admin.js:658`), so it will not stay empty.

### 1d — Money-shaped, deliberately left alone

| Table | Column | Type both sides | What it is | Verdict |
|---|---|---|---|---|
| **retail_vouchers** | **value** | `double precision` | **Polymorphic** — yuan when `type='fixed_amount'`, percent when `type='percent'` | §24 defers the split to the Stock stage |
| retail_lifetime_commissions | rate_percent | `double precision` | percent | not money |
| guanyi_product_pricing | discount_pct | `double precision` | fraction (0.2 = 20%) | not money |
| price_alerts | change_pct | `double precision` | percent | not money |
| recipe_cost_data | overhead_pct | `double precision` | percent | not money |
| miniapp_orders | used_points | `double precision` | points (all 0.0) | not money |

`retail_vouchers` today: 13 rows, 5 `fixed_amount` (all `value = 20.0`, yuan), 8 `percent`
(`value` = 5/8/10/20). **Live proof of the split unit in one row** — id 6, `SPROUT`:

```
sqlite:  value = 20.0   min_subtotal = 199.0     (both yuan)
pg:      value = 20     min_subtotal = 19900     (yuan, cents)
```

### 1e — Ambiguous, not classified

1. **`expense_entries.amount`** — see §1b. Ledger money typed as a unit cost, summed alongside
   whole-cent ledger money. **Resolved in §8.**
2. **`recipe_cost_data.target_food_cost`** — left `double precision`, single row, value `25.0`.
   The name reads as money; `25.0` next to `overhead_pct = 1.0` reads as a percent. Not resolved.
3. **`markets.daily_target`** — converted to cents. It is a revenue target, so cents is defensible,
   but it is a *configuration* value the operator types, and every other operator-typed money value
   in the system (§7) lives in config JSON in yuan. Inconsistent, not wrong.
4. **`retail_migration_unmatched.balance` / `retail_migration_credits.balance`** — converted. These
   are OUT1N migration balances loaded from an external roster (see
   `scripts/seed_migration_credits.js`). Whatever unit that roster is in has to match.

---

## 2 — Where money is read

### 2a — By file

Counts are of references to money column names (snake_case and the camelCase twins the API emits).
The generic names — `total`, `amount`, `subtotal`, `balance`, `income`, `price`, `cost` — are
counted separately with alias context, because a bare grep for `total` is meaningless.

**Server (routes/, lib/, database.js):**

| File | distinct money cols | generic (`o.total`, `p.amount`…) | `¥` / `toFixed(2)` |
|---|---:|---:|---:|
| routes/retail.js | 491 | 81 | 131 |
| database.js | 98 | — | — |
| routes/retail-purchasing.js | 40 | — | — |
| routes/sales.js | 38 | 28 | — |
| routes/ai.js | 34 | — | 31 |
| routes/waste.js | 31 | — | — |
| routes/purchases.js | 29 | 2 | — |
| routes/finance.js | 24 | 17 | — |
| routes/ingredients.js | 17 | — | — |
| routes/products.js | 14 | — | — |
| routes/pos.js | 12 | 5 | — |
| lib/inventory.js | 11 | — | — |
| routes/recipes.js / markets.js | 9 / 9 | — | — |
| lib/feie.js | 8 | 6 | 17 |
| routes/store-admin.js | 6 | 4 | — |
| lib/flashsales.js | 6 | — | — |
| 9 more files | 1–5 each | — | — |

**Admin + storefront (public/):**

| File | money cols | generic | `¥` / `money()` |
|---|---:|---:|---:|
| public/app.html | 172 | 31 | 231 |
| public/retail-admin/06-delivery.js | 63 | — | 28 |
| public/retail-admin/04-orders.js | 43 | 10 | 70 |
| public/retail-admin/09-products.js | 31 | 5 | 14 |
| public/retail-admin/16-purchasing.js | 28 | 2 | 51 |
| public/shop.html | 18 | 28 | 71 |
| public/cms.html | 15 | 10 | 63 |
| public/retail-admin/07-content-billing.js | 10 | 7 | 34 |
| public/m.html | 8 | 13 | 57 |
| public/retail-admin.html | 3 | 2 | 71 |
| public/retail-admin/{03,05,08,10,13} | 2–6 each | — | 14–27 each |
| public/store-admin.html | 2 | 10 | 21 |
| public/storefront.html, kitchen.html, shop/blocks.js | 1–6 | 3–8 | 9–31 |

`public/app.html.bak` carries 162/32/223 — a stale backup, not loaded, listed so it is not
mistaken for live code.

**Mini-app (miniapp/, separate codebase, separate deploy):**
checkout.js 35, order.js 15, product.js 9, add-to-order.js 9, block-renderer.js 8, shop.js 7,
cart.js 6, checkout.wxml 6, plus 9 more pages at 1–3. Money formatting: checkout.js 65,
block-renderer.js 41, checkout.wxml 24, order.js 23, affiliate.js 21, product.js 17, 10 more pages.

**Scripts:** `import_meituan.js` 26, `convert_meituan_xlsx.py` 26, `set_gz_district_zones.js` 15,
`import_miniapp.js` 13, four `add_shipping_zones*.js` at 12 each, `import_guanyi_pricing.js` 12,
`backfill_refund_requested_to_paid.js` 11, ~25 more at 1–10. Plus the fixture JSON
(`miniapp_2025_import.json` 45,974 references) — data, not code.

### 2b — Read and displayed directly

This is the largest group and the least dangerous — a boundary layer that returns yuan makes every
one of them correct unchanged. Roughly 900 formatting sites across `public/` and `miniapp/`.

The API is a **pass-through**: `routes/retail.js` alone has 48 statements of the form
`res.json({ success: true, data: rows })` handing raw DB rows to the client. That is good news for a
server-side boundary — the client never touches the database — and bad news for any design that
tries to convert per-endpoint, because there is no per-endpoint shaping to hook.

One display path is not a browser: `lib/feie.js` (17 `¥` sites) renders the kitchen receipt for a
thermal printer. Note the existing footgun that an enlarged line silently truncates at ~15 of 31
columns — a value rendered 100× wider would push the end of the line off the paper without error.

### 2c — Read and used in JavaScript arithmetic

The core money path, all in `routes/retail.js`, all in **yuan floats**. The file states the contract
itself at `routes/retail.js:24894`:

> `// All money is REAL (¥, 2dp); points are INTEGER.`

| Site | What it does |
|---|---|
| `retail.js:9484` | `grossTotal = max(0, subtotal + shippingFee + packingFee − voucherDiscount)` |
| `retail.js:9552-9555` | `balanceUsed = walletSpendForOrder(...)`; `total = max(0, grossTotal − pointsAmount − balanceUsed)` |
| `retail.js:11358` | `computeVoucherDiscount` — `min(voucher.value, couponable)` and `(couponable × pct / 100).toFixed(2)` |
| `retail.js:25914-25918` | `packingFee = packing_fee_per_item × totalQty`, capped at `packing_fee_cap` |
| `retail.js:26114` | `pointsCashValue(pts) = floor(pts / redeemRate × 100) / 100` |
| `retail.js:26130` | `pointsRedeemableBase(subtotal, shippingFee, packingFee, voucherDiscount)` |
| `retail.js:26148` | `walletSpendForOrder` — `round(min(balance, base) × 100) / 100` |
| `retail.js:26165` | `orderTenders` — `G = round((P + B + C) × 100) / 100` |
| `retail.js:26171` | `splitRefundAcrossTenders` — proportional split, cash absorbs remainder |
| `retail.js:26020` | `pointsEarnedFor(subtotal) = floor(subtotal × pts × mult / denom)` |
| `retail.js:7227` | `tierFromSpend(spend)` — compares `lifetime_spend` against config thresholds |
| `retail.js:1381`, `2093`, `25989` | bundle worth, compare-at savings, option-adjusted compare-at |
| `retail.js:3574`, `4476`, `4495` | `amountCents: Math.round(Number(order.total) × 100)` — WeChat Pay |
| `retail.js:4866`, `4892`, `4914`, `4992` | `expectCents = Math.round(Number(x.amount) × 100)` — callback verification |
| `retail.js:3349` | Alipay OCR: `Number(order.total).toFixed(2)` vs OCR'd screenshot amount |
| `store-admin.js:637-638` | `commissionCents = round(gmv × rateBps / 100)` |
| `scripts/import_meituan.js:135,157-158` | `total = product_total + package_fee`; `reduce` over `gross_amount`/`net_to_merchant` |
| `scripts/gzgrocery-order-daemon.js:214-226` | `subtotal += line`, then `+subtotal.toFixed(2)` |

**The gateway sites are the ones to be careful with.** `routes/retail.js:3574` etc. already do the
yuan→fen conversion the payment API requires. A boundary layer that hands the app **yuan** leaves
these correct and untouched. Any design that lets cents leak into application variables
double-converts here and charges the customer 100×.

### 2d — Read and written back

| Site | Read → write |
|---|---|
| `retail.js:9745` | `balance = ROUND(COALESCE(balance,0) − ?, 2) WHERE … AND ROUND(COALESCE(balance,0) − ?, 2) >= 0` |
| `retail.js:15111` | same shape, `+ ?` — top-up credit |
| `retail.js:26243` | `balance = ROUND(COALESCE(balance,0) + ?, 2)` — refund reversal |
| `retail.js:11320`, `27034` | `balance = COALESCE(balance,0) + ?` (no ROUND) |
| `retail.js:15476/15567/15606/15653` | `balance = ?` with `after` computed in JS |
| `retail.js:16923` | `currentSurcharge = Number(o.same_day_surcharge_fee) \|\| 0`, recomputed and rewritten |
| `retail.js:26234` | `SUM(amount)` over `refund_reverse` rows → cap for the next reversal |
| `retail.js:26228+` | `original = Math.round(−spend.amount × 100) / 100` → compared against prior reversals |
| `database.js:3541` | `UPDATE retail_customers SET lifetime_spend = (SELECT SUM(subtotal) FROM retail_orders …)` |
| `routes/finance.js:498/554/633` | `SUM(allocated_amount)` → `already_allocated` → caps the next allocation |

### 2e — **Money arithmetic inside SQL** — the group that a JS boundary does not reach

**97 statement lines** across 13 files carry `SUM`/`AVG` over a converted column. The complete list
is in the appendix. The shape of the problem, by kind:

**(i) Pure aggregates — safe under a uniform ×100, wrong only if mixed.**
`SUM(total)`, `SUM(income)`, `SUM(line_total)`, `AVG(income)` etc. `SUM` and `AVG` are linear:
`SUM(100x) = 100·SUM(x)`. If the boundary divides the *result* by 100 these are correct. Bulk:
`routes/sales.js` (33 lines), `routes/retail.js` (34), `routes/ai.js` (17), `routes/finance.js` (7),
`routes/retail-purchasing.js` (13), `routes/pos.js` (4), `routes/products.js` (3).

**(ii) Aggregates that mix a converted column with an unconverted one — not linear, not safe.**

- `routes/purchases.js:110` and `routes/retail-purchasing.js:65`:
  `SUM(COALESCE(qty_received, qty) × COALESCE(cost_per_unit, 0))` — `cost_per_unit` is
  `numeric(14,6)` **yuan** while the surrounding report renders alongside `invoices.amount`
  (**cents**).
- `routes/retail-purchasing.js:504-505`: `SUM(pli.qty × pli.cost_per_unit)` (yuan) as `purchased`
  next to `SUM(allocated_amount)` (cents) as `billed`, **and the two are compared**.
- `routes/finance.js:287-293`: `SUM(income_entries.amount)` (cents),
  `SUM(sales_entries.total)` (cents), `SUM(expense_entries.amount)` (**yuan**) — three sums in six
  adjacent lines, two units, and the P&L subtracts one from the others. **Resolved in §8** — the
  expense column becomes whole cents.
- `routes/sales.js:783`: `round(m.revenue / g.total × 1000)` — a **ratio**. Safe only if both
  operands convert identically; `revenue` and `total` both come from `sales_entries.total`, so this
  one holds.

**(iii) SQL arithmetic that produces a new money value.**

- `routes/sales.js:899`:
  `SUM(delivery_fee_paid + delivery_tip_paid + ad_spend + coupon_subsidy_paid + insurance_fee + partial_refund)`
  — six converted columns added inside the database. Linear, so safe under a uniform rule.
- `routes/retail.js:26998`: `MAX(0, COALESCE(shipping_fee, 0) …)`.
- `routes/retail.js:9745`, `15111`, `26243`: `ROUND(x, 2)`. **This is a yuan-native operation.** It
  exists to scrub float drift off a `REAL` column. On `bigint` cents it is a no-op at best; in
  Postgres `round(bigint, 2)` resolves through `numeric` and returns `numeric`, which then
  assignment-casts back to `bigint`. It will not error. It will also not mean anything. Every one of
  these three needs deleting, not translating.

**(iv) A JavaScript value bound into a SQL comparison against a converted column.**
This is the case a result-row boundary layer misses completely, because the value travels
*inward*.

- `routes/retail.js:11466` — `AND min_subtotal > 0 AND ? < min_subtotal`
  The `?` is the cart subtotal computed in JS in yuan. `min_subtotal` becomes cents. Every
  minimum-spend voucher becomes redeemable on any order.
- `routes/retail.js:27974` — `WHERE is_blocked = 0 AND lifetime_spend > ?`
  Broadcast audience segmentation by spend. The `?` comes from the admin form in yuan.
- `routes/retail.js:11854` — `WHERE status = 'success' AND amount > 0` — literal `0`, unit-invariant, safe.
- `routes/retail.js:27857` — `WHERE lifetime_spend > 0` — safe for the same reason.

**(v) `ORDER BY` on a money column — safe.**
`store-admin.js:524` (`lifetime_spend DESC`), `retail.js:1477-1478` (`sell_price ASC/DESC`),
`retail.js:26684/26703/27697` (`amount ASC`), `retail.js:27858` (`lifetime_spend DESC`),
`retail.js:14352` (`SORT_COLS` map, `spend`/`wallet`). `×100` is monotonic, so ordering within one
database is unchanged. **Except** `store-admin.js:524`, which sorts across databases — see §5.

**(vi) Two aggregates in *separate* statements, combined by JavaScript into one payload.**
The handler-level form of (ii). No single statement carries two units, so a statement-by-statement
reading of the code passes it; the mixing happens where JavaScript assembles the response, and the
screen renders the two side by side. `routes/finance.js:287-293` under (ii) is already this shape —
three `SELECT COALESCE(SUM(...),0) AS s, COUNT(*) AS c` statements in three adjacent lines — and is
resolved by §8 rather than by a code change.

- `routes/retail-purchasing.js:166-174` — `GET /api/retail-admin/suppliers/:id`, the supplier
  scorecard. `spend` is `COALESCE(SUM(pli.total_cost),0)`, and `po_line_items.total_cost` is
  `numeric(14,6)` **yuan** on both engines — it never changes unit. `owed` is
  `COALESCE(SUM(amount),0)` over `invoices`, and `invoices.amount` is **`bigint` cents**. Both are
  folded into one `scorecard` object at `:193-196` and rendered as adjacent tiles by
  `public/retail-admin/16-purchasing.js:1585-1586` — *Spend, all time* / 累计采购 beside
  *Owed now* / 当前应付, both through the same yuan formatter, with `owed_count` as the "bills"
  foot on the second tile.
  **Correct on SQLite today** — `invoices.amount` is `REAL` yuan (`database.js:244`), so both tiles
  are yuan and both are right. Wrong only after cutover, when "Owed now" reads exactly 100× too
  high next to a correct "Spend, all time". Nothing errors: both arrive in JavaScript as `number`.
  **Fixed** — `owed` now reads `amount` as a plain column and sums it in JavaScript, and the bill
  count comes from the row count, so the source column survives to the boundary. `spend` is
  untouched. Verified old-against-new on live SQLite before the change; comparison counts are in
  the commit message.

---

## 3 — Where money is written

### 3a — Statement counts per table

`INSERT`/`UPDATE` statements per money-bearing table (routes/, lib/, database.js, scripts/):

| Table | stmts | Files |
|---|---:|---|
| retail_orders | 122 | retail.js, database.js, meituan-internal.js, eleme-internal.js, lib/inventory.js, lib/tracking.js, lib/delivery-reminders.js, gzgrocery-order-daemon.js, + 6 scripts |
| retail_customers | 45 | retail.js, database.js, 2 scripts |
| store_products | 37 | retail.js, database.js, 12 scripts |
| products | 35 | products.js, database.js, 7 scripts |
| retail_payments | 27 | retail.js, lib/inventory.js, 2 scripts |
| po_line_items | 21 | retail-purchasing.js, purchases.js, ingredients.js, kitchen.js, database.js |
| retail_delivery_zones | 18 | retail.js, database.js, 10 scripts |
| retail_order_items | 15 | retail.js, meituan-internal.js, eleme-internal.js, gzgrocery-order-daemon.js |
| purchase_orders | 15 | purchases.js, retail-purchasing.js, kitchen.js |
| ingredients | 15 | ingredients.js, purchases.js, lookups.js, admin.js, database.js, 1 script |
| retail_topup_transactions | 11 | retail.js |
| sales_entries | 9 | pos.js, sales.js, database.js, 3 import scripts |
| retail_order_addons | 5 | retail.js |
| retail_referrals | 5 | retail.js |
| invoices / invoice_lines | 4 / 3 | finance.js, retail-purchasing.js |
| price_alerts | 4 | alerts.js, ingredients.js, purchases.js |
| ingredient_price_history | 4 | ingredients.js, purchases.js |
| expense_entries | 4 | finance.js, purchases.js, retail-purchasing.js |
| retail_migration_credits | 4 | retail.js, 3 scripts |
| markets, retail_product_option_choices | 4 each | markets.js; retail.js + 3 scripts |
| recipe_cost_data, packaging_types | 3 each | recipes.js, lookups.js, database.js |
| meituan_orders, miniapp_orders, gzgrocery_orders, retail_topup_packages, income_entries, retail_lifetime_commissions | 2 each | import scripts; retail.js; finance.js |
| retail_checkout_quotes, retail_refund_events, waste_entries, guanyi_product_pricing, miniapp_order_lines, meituan_settlements, meituan_balance_flow | 1 each | retail.js; waste.js; import scripts |

### 3b — Computed writes (a value the app derived, not a value it read back)

| Site | Value written | Derivation |
|---|---|---|
| `retail.js:9567+` | `retail_orders.{subtotal, shipping_fee, packing_fee, voucher_amount, points_amount, total, balance_used, same_day_surcharge_fee}` | the full checkout chain, §2c |
| `retail.js:9713` | `retail_payments.amount` ← `total` | same |
| `retail.js:9758` | `retail_topup_transactions.amount` ← `−balanceUsed` | negative ledger row |
| `retail.js:26171` | `retail_refund_events.amount`, `retail_orders.refund_*` | `splitRefundAcrossTenders` |
| `retail.js:25914` | `packingFee` ← `per_item × qty` capped | zone rule |
| `database.js:3541` | `retail_customers.lifetime_spend` | `SUM(retail_orders.subtotal)` in SQL |
| `retail.js:15476/15567/15606/15653` | `retail_customers.balance` ← `after` | JS-computed running balance |
| `store-admin.js:658` | `billing_invoices.amount_cents` | `max(0, round(Number(body.amount_cents)))` — **already cents** |
| `gzgrocery-order-daemon.js:226-239` | `retail_orders.{subtotal,total}`, `retail_order_items.{unit_price,line_total}` | `+subtotal.toFixed(2)` from a per-unit price read out of `guanyi_product_pricing`/`store_products` |
| `purchases.js:117`, `retail-purchasing.js:71` | `expense_entries.amount` | `SUM(qty × cost_per_unit)` grouped by category, in SQL, unrounded — see §8 |

### 3c — Values arriving from outside, and their unit

| Source | Path | Arrives in | Lands in |
|---|---|---|---|
| **Admin forms** (product editor) | `retail.js:18030` `parseFloat(body.sell_price)`; `:18033` `compare_at_price`; `:18587` `Number(body.flash_price)` | **yuan**, 2dp, straight off an `<input>` | `store_products.*` (cents) |
| **Admin forms** (delivery zones) | `retail.js` zone CRUD, `06-delivery.js` (63 refs) | **yuan** | `retail_delivery_zones.*` (cents) |
| **Admin forms** (vouchers) | `retail.js` voucher CRUD | **yuan** *(fixed_amount)* / **percent** | `retail_vouchers.value` (unconverted) + `min_subtotal` (cents) |
| **Admin form** (manual expense) | `finance.js:216` `parseFloat(amount)`, only a `> 0` check | **yuan** | `expense_entries.amount` |
| **Mini-app checkout** | `POST /api/retail/orders` — cart lines + `points_to_use`, `use_balance`, `voucher_code` | server recomputes every amount from the DB; the client sends **no money** | — |
| **WeChat Pay callback** | `retail.js:4865/4891/4913` `txn.amount.total` | **fen (cents)** — gateway native | compared against `Math.round(Number(row.amount) × 100)` |
| **Alipay proof OCR** | `retail.js:3349` `ocr.amount` | **yuan** — read off a screenshot | compared against `Number(order.total).toFixed(2)` |
| **Meituan importer** | `scripts/import_meituan.js:83-87`, from `convert_meituan_xlsx.py` | **yuan** — merchant XLSX export | `meituan_orders.*`, `meituan_settlements`, `meituan_balance_flow` (cents) |
| **Guanyi pricing importer** | `scripts/import_guanyi_pricing.js:86-91` | **yuan** — supplier sheet | `guanyi_product_pricing.{excel_retail,excel_gz_price}` (cents) |
| **gzgrocery order daemon** | `scripts/gzgrocery-order-daemon.js:315-323` | **yuan** — scraped channel order | its **own** `gzgrocery_orders` table, created by the daemon at boot as `total REAL` (line 73) |
| **Mini-app 2025 import** | `scripts/import_miniapp.js` ← `miniapp_*_import.json` | **yuan** | `miniapp_orders`, `miniapp_order_lines` (cents) |
| **OUT1N migration roster** | `scripts/seed_migration_credits.js` | **yuan** | `retail_migration_credits.balance` (cents) |
| **`storefront_config`** | admin Settings → generic `PUT /api/retail-admin/config` (no allow-list) | **yuan**, as JSON | `storefront_config.value_json` — **TEXT, never converted**. See §7. |

Note `gzgrocery-order-daemon.js:73` issues `CREATE TABLE … total REAL` at startup. Against Postgres
that DDL is both invalid and unwanted, and it is a **write** from a process that would otherwise be
read-only in the cutover.

---

## 4 — The rounding question

### 4a — Where fractions are created today

| # | Source | Site | Created how | Rounded? |
|---|---|---|---|---|
| 1 | **Percentage voucher** | `retail.js:11369` | `couponable × pct / 100` | **Yes** — `+(...).toFixed(2)`, immediately, half-up-ish (float `toFixed`) |
| 2 | **Points → cash** | `retail.js:26115` | `pts / redeemRate` | **Yes** — `Math.floor(x × 100) / 100`, **floors** (in the store's favour) |
| 3 | **Points earned** | `retail.js:26031` | `subtotal × pts × tierMult / denom` | **Yes** — `Math.floor`, once at the end. `tierMult` is 1.0–1.5, so this genuinely produces fractions before flooring |
| 4 | **Wallet spend** | `retail.js:26151` | `min(balance, base)` | **Yes** — `Math.round(x × 100) / 100`, comment says "so we never charge sub-fen dust" |
| 5 | **Refund tender split** | `retail.js:26173-26175` | `A × B / G`, `A × P / G` — **proportional** | **Yes** — each part `Math.round(× 100) / 100`; **cash absorbs the remainder** by construction (`cash = A − balance − pointsValue`) |
| 6 | **Packing fee** | `retail.js:25916` | `per_item × qty`, `per_item = 0.8` | **No explicit rounding** — `0.8 × 3 = 2.4000000000000004`. Capped at `packing_fee_cap`, then flows into `total` |
| 7 | **Platform commission** | `store-admin.js:637` | `gmv × rateBps / 100` | **Yes** — `Math.round`, result is **cents** |
| 8 | **Order tender total** | `retail.js:26169` | `P + B + C` | **Yes** — `Math.round(× 100) / 100` |
| 9 | **Compare-at + option delta** | `retail.js:25990` | `compare_at_price + optionDelta` | **Yes** — `Math.round(× 100) / 100` |
| 10 | **Bundle worth** | `retail.js:1381` | sum of components | **Yes** — `Math.round(× 100) / 100` |
| 11 | **gzgrocery mirror subtotal** | `gzgrocery-order-daemon.js:226` | `Σ (unit × qty)` | **Yes** — `+subtotal.toFixed(2)` |
| 12 | **Unit costs** | `po_line_items.cost_per_unit`, `ingredient_price_history.price` | supplier pack price ÷ pack size | **No** — this is *why* they are `numeric(14,6)`; min live value `0.004` |
| 13 | **Balance mutation** | `retail.js:9745/15111/26243` | `balance ± ?` | **Yes** — `ROUND(…, 2)` **in SQL** |
| 14 | **PO → expense subtotal** | `purchases.js:110`, `retail-purchasing.js:65` | `SUM(qty × cost_per_unit)` grouped by category | **No** — see §8 |

**There is no tax and no shipping-split.** No VAT/GST computation exists in the codebase — invoices
(`needs_invoice`, `invoice_title`, `invoice_tax_id`) capture *fapiao* details for a third party to
issue; no tax rate is applied to any amount. `purchase_orders.extra_tax` exists and every one of its
51 rows is `0.0`. Shipping is a flat zone fee, never split across lines.

**Commission is at basis points** (`tenants.commission_rate_bps`, `store-admin.js:637`) and it is
the one place that *already* produces cents — `Math.round(gmv × bps / 100)`.

### 4b — Does anything rely on fractional yuan surviving?

**Among the 92 whole-cent columns: no.** The copy proved it — `q_cents()` halts on any value that
does not fit whole cents to within 1e-6, and it halted zero times over 176k rows. Every fraction
listed above is rounded to 2dp *before* it reaches one of those columns.

**Among the nine `numeric(14,6)` columns: yes, decisively — with one exception.** 268 of 565
`ingredients.cost_per_unit` values, 174 of 889 `ingredient_price_history.price`, and 65 of 256
`price_alerts.new_price` carry more than two decimals. `0.004` yuan is a real, live, meaningful unit
cost. Any boundary rule that sends these through the cents path destroys them — §24 records that
whole cents zeroed 12 unit costs and broke 188 by more than 10%. The exception is
`expense_entries.amount`, whose seven sub-cent values are arithmetic residue rather than data — see
§8.

**One live gap:** #6, the packing fee, is the only fraction source in the checkout path with no
rounding step of its own. `0.8 × 3` is `2.4000000000000004` today and it enters `grossTotal`
un-scrubbed. Today `REAL` storage swallows it. A cents boundary must round it, and where it rounds
decides whether `subtotal + shipping + packing − voucher` still equals the stored `total`.

### 4c — What the boundary would have to do

| Case | Requirement |
|---|---|
| 1, 3, 5 | Rounding must stay **where it is now**, at the point the fraction is created, not at the boundary. If the boundary rounds instead, #5's "cash absorbs the remainder" invariant breaks and a refund can return more than was taken. |
| 2 | `Math.floor` must survive. A boundary that rounds half-up here silently changes redemption in the customer's favour. |
| 6, 14 | Need an explicit rounding decision that does not currently exist. |
| 12 | Must be exempt from the cents rule entirely — pass through as decimal yuan. |
| 5, 8 | The components must still sum to the whole. Independent rounding of `P`, `B`, `C` on the way out can make `P + B + C ≠ G`. |

---

## 5 — The transition hazard: a converted value meeting an unconverted one

**Direct answer: it breaks silently, it breaks in money, and there are four specific places it
happens today. Two of them bill people.**

### 5a — Why it can happen at all

The routing already exists. `lib/tenant-db.js:30`:

```js
function tdb() { return tenantAls.getStore() || mainDb; }
```

A request enters an `AsyncLocalStorage` scope carrying **that account's connection**; every handler
calls `tdb()` and gets it without threading. Roots is account 1 and `getTenantDb(1) === mainDb`.
Swap the connection a scope carries and the same code serves a different engine — which is exactly
what a phased cutover would do. The *unit* then travels with the connection, and **nothing in the
code carries the unit with the value.**

Within one request that is survivable: one scope, one engine, one unit. The failure is in the code
that **leaves the scope** — the platform-admin surfaces that loop over accounts and open each
account's connection directly.

### 5b — The four sites

**(1) `routes/store-admin.js:626-644` — platform commission. This one creates invoices.**

```js
for (const t of tenants) {
  let tdb; try { tdb = getTenantDb(t.id); } catch (e) { continue; }
  const cur = gmvFor(tdb, thisMonth), prev = gmvFor(tdb, lastMonth);   // SUM(retail_orders.total)
  const unpaid = db.prepare("SELECT COALESCE(SUM(amount_cents),0) v FROM billing_invoices …").get(t.id).v;
  rows.push({
    gmvThisMonth: cur.v,
    commissionThisMonthCents: Math.round(cur.v * rate / 100),   // gmv(¥)×bps/10000 ×100
    unpaidCommissionCents: unpaid,
  });
}
```

Three units in one loop body. `cur.v` is `SUM(total)` from **that account's** database. The
comment on line 637 states the assumption out loud: `gmv(¥)`. `unpaid` is `amount_cents` — cents on
both engines, never converted. If account A is on Postgres and account B on SQLite, the same
expression yields A's commission **100× too high**, and the response places it in the same column as
B's correct figure and next to a genuinely-cents `unpaidCommissionCents`. The operator then clicks
through to `POST /commission-invoice` and a `billing_invoices` row is written from it.

A boundary layer *does* fix this — but only if it wraps `getTenantDb()` as well as `tdb()`. Written
naively (a wrapper on the request-scoped handle only) this loop bypasses it entirely, because it
never enters a scope.

**(2) `routes/store-admin.js:519-531` — global customer/order lookup.**

```js
for (const t of tenants) {
  tdb = getTenantDb(t.id);
  tdb.prepare(`SELECT … lifetime_spend, balance … ORDER BY lifetime_spend DESC LIMIT ?`)…
}
customers.sort((a, b) => (b.lifetimeSpend || 0) - (a.lifetimeSpend || 0));
```

The per-account `ORDER BY` is safe (monotonic). The **cross-account `.sort()` on line 536 is not**:
every Postgres-backed customer sorts above every SQLite-backed one regardless of actual spend, and
the support tool renders `lifetimeSpend`, `balance` and order `total` for both in one list. Wrong
answers to "who is our biggest customer", and wrong wallet balances shown to support staff.

**(3) `routes/store-admin.js:546` — customer drill-down.** Single account, so the units are
self-consistent; the risk is only that the operator reads it right after (2) and compares.

**(4) `routes/saas-admin.js:50` — `tenants.map(...)`.** Same iteration shape; worth checking against
whatever it renders before the cutover.

### 5c — The failure signature

None of these throw. `bigint` and `REAL` both arrive in JavaScript as `number`. Comparison,
`Math.round`, `+`, `.toFixed(2)` all succeed. The output is a plausible number that is wrong by
exactly two orders of magnitude — and ¥40,850 rendered where ¥408.50 belongs is the kind of error
that looks like a good month.

### 5d — The honest conclusion

The mixed-engine window is safe **inside** a request scope and unsafe **across** account boundaries.
The exposure is small — four call sites, all platform-admin, all in two files — but two of them
touch billing, so it is not tolerable, and none of it is caught by a boundary layer that only wraps
the request-scoped handle.

Note also that §24 **retires** `lib/tenant-db.js`; there is currently only one real account (Roots),
and `TENANT_DATA_ISOLATION` is off everywhere. So the cheapest resolution may be to ensure the
transition window never contains two accounts on two engines at once — a scheduling constraint
rather than a code change. That is a decision to make deliberately rather than discover.

---

## 6 — What the layer must do

### 6a — Direction

Return **yuan** to the application. Not cents. Three reasons from the evidence:

1. `routes/retail.js:24894` states the app's contract as `¥, 2dp`; ~900 formatting sites and every
   arithmetic helper in §2c assume it.
2. The payment gateways already convert yuan→fen at the outbound edge (`retail.js:3574`, `4476`,
   `4495`) and verify fen→yuan on the callback (`4866`, `4892`, `4914`, `4992`). Handing the app
   cents makes all seven of those double-convert.
3. The nine `numeric(14,6)` columns are **already** yuan. A yuan-facing boundary treats them as
   pass-through; a cents-facing one has to special-case them.

### 6b — Rules

1. **Read (cents columns).** `bigint` → `value / 100`, exact. Never `parseFloat` a Postgres numeric
   string via locale-sensitive paths.
2. **Write (cents columns).** yuan → `Math.round(v × 100)`, and **fail loudly** on any value that is
   not within 1e-6 of a whole cent — the same test `q_cents()` used. Silence here is how a fraction
   gets destroyed.
3. **Unit-cost columns.** Pass through as **exact decimal yuan**. Do not route through a float.
   `numeric(14,6)` arrives from `pg` as a string; the layer must not lose the scale.
4. **`*_cents` columns — never touch.** `billing_plans.price_cents`, `accounts.setup_fee_cents`,
   `billing_invoices.amount_cents`, `plans.price_cents`. An explicit deny-list, not name-matching:
   `retail_customers.balance` has no `_cents` suffix and must convert, `setup_fee_cents` has one and
   must not. §24 records that this trap already sprang once.
5. **`NULL` is not `0`.** `products.flash_price` is NULL on all 278 rows; `retail_delivery_zones.
   weight_*_kg_fee` NULL on all 15; `max_fee` NULL on 9 of 15. `COALESCE` inside the layer changes
   `free_threshold IS NULL` semantics.
6. **Negatives round the same way.** `meituan_orders.commission` runs to −59.32 and
   `merchant_subsidy` to −24.0; `retail_topup_transactions.amount` to −1000.0. `ROUND_HALF_UP` on a
   negative is not `Math.round` — `Math.round(-0.5) === -0` in JS, `Decimal` half-up gives −1.
7. **Bound parameters convert too, not just result rows.** `retail.js:11466` and `:27974` bind a
   yuan value into a SQL comparison against a converted column. A layer that only maps result sets
   leaves both wrong.
8. **Cover `getTenantDb()`, not only `tdb()`.** §5.
9. **Delete, don't translate, the yuan-native SQL.** The three `ROUND(…, 2)` guards
   (`retail.js:9745`, `15111`, `26243`) exist only because the column is `REAL`.

### 6c — What the layer cannot handle, and where it has to be solved instead

| # | Case | Why the layer can't | Where it belongs |
|---|---|---|---|
| 1 | **`storefront_config.value_json`** — `fees.*`, `points.*`, `delivery.defaultZone.*`, `affiliate.*`, `roots_club.tiers[].threshold` | It's TEXT. There is no column to type. The layer cannot know which JSON leaf is money. | An explicit config-schema pass. See §7.1. |
| 2 | **`retail_vouchers.value`** | Polymorphic on `type` in another column. A per-column rule cannot branch on a sibling. | §24 already defers it: split into separate amount/percent columns at the Stock stage. |
| 3 | **Mixed-unit SQL aggregates** — `SUM(qty × cost_per_unit)` beside `SUM(allocated_amount)` (`retail-purchasing.js:504-505`) | The arithmetic completes inside the database. The layer only sees one scalar and cannot tell which unit produced it. | Rewrite each statement to one unit, or move the arithmetic into JS. |
| 4 | **`expense_entries.amount`** | Its classification was unresolved at survey time. | **Resolved — §8. It becomes whole cents.** |
| 5 | **Cross-account loops** (§5) | They bypass the request scope. | Wrap `getTenantDb`, or forbid a mixed-engine window. |
| 6 | **The packing-fee fraction** (§4, #6) | It is created in JS before any write. | An explicit rounding decision in `retail.js:25916`. |
| 7 | **`gzgrocery-order-daemon.js:73`** `CREATE TABLE … total REAL` | DDL, executed at daemon boot. | Remove it from the daemon's startup path. |
| 8 | **Standing invariants** — `subtotal + shipping + packing − voucher − points − balance = total`; `P + B + C = G` | Per-value rounding can break a per-row identity. | A verification pass after conversion, not a rule inside it. |

---

## 7 — What surprised me

**1. There is a second, complete money model in `storefront_config`, and none of it converts.**
151 rows, `value_json` is TEXT. Live values:

```
fees.freeShippingThreshold      199
fees.pickupPackingFee           1.5
fees.sameDayDelivery            18
fees.standardShipping           12
fees.minOrder                   0
delivery.defaultFreeThreshold   499
delivery.defaultZone            {"base_fee":25,"free_threshold":329,
                                 "packing_fee_per_item":0.8,"packing_fee_cap":10, …}
affiliate.rewardPerOrder        20
affiliate.rewardReferee         15
points.earnSpend                100        (¥ per point)
points.redeemRate               1          (points per ¥)
roots_club.tiers[].threshold    0 / 4000 / …
```

Every number there is **yuan**, and every one of them meets a converted column:

- `defaultDeliveryZone()` (`retail.js:24929-24955`) **synthesizes a zone object from config** when an
  address matches no row. It is the fallback for all of mainland China. Its `base_fee`,
  `free_threshold`, `packing_fee_per_item` and `packing_fee_cap` are yuan; the same-named fields on
  a real `retail_delivery_zones` row become cents. **The same function returns both shapes**, and
  `computeDeliveryAndPacking` cannot tell them apart.
- `affiliate.rewardPerOrder`/`rewardReferee` (¥20/¥15) are written into
  `retail_referrals.reward_amount` / `referee_reward_amount` — cents columns. Referral payouts
  become ¥0.20 / ¥0.15.
- `tierFromSpend()` (`retail.js:7227`) compares `lifetime_spend` against `roots_club.tiers[].
  threshold`. `lifetime_spend` becomes cents; thresholds stay yuan. **Every customer with more than
  ¥40 of history jumps to the top tier**, and `reconcileTier()` writes it back.
- `pointsEarnedFor()` (`retail.js:26031`) is `floor(subtotal × pts × mult / denom)` with `denom =
  points.earnSpend = 100`. Subtotal in cents awards **100× the points**.
- `leaderboard.config` is `{"metric":"lifetime_spend", …}` — a config string naming a converted column.

This is larger than the 92-column problem in reach, because these are the *rules*, not the records.

**2. `retail_vouchers` carries two units in one row, on purpose, live.**
Row 6 `SPROUT`: `value = 20` (yuan) and `min_subtotal = 19900` (cents). §24 decided this
deliberately and deferred the split — but the deferral means `computeVoucherDiscount`
(`retail.js:11364-11368`) compares `subtotal` (cents) against `min_subtotal` (cents) on one line and
`min(voucher.value, couponable)` — yuan against cents — three lines later. Correct and incorrect in
the same function.

**3. The code already converts yuan→cents in seven places, and gets it right.**
`retail.js:3574`, `4476`, `4495` (charge), `4866`, `4892`, `4914`, `4992` (callback verification).
The comment at `:3676` — "amount.total MUST equal the original transaction total (in cents)" — shows
the pattern is understood. So "zero conversion sites" is true of the *database* boundary, not of the
codebase: the *gateway* boundary is already a working instance of exactly the layer being proposed.
That is a good sign and a hazard — a cents-facing design breaks all seven.

**4. `expense_entries.amount` is ledger money typed as a unit cost.**
It is `numeric(14,6)` yuan while `income_entries.amount` and `sales_entries.total` are cents, and
`routes/finance.js:287-293` sums all three within six lines to build the P&L. The retype was
justified on precision grounds (7 of 92 rows exceed 2dp), but it puts the expense side of the
accounts in a different unit from the income side. **Flagged, not classified, at survey time.
Resolved in §8.**

**5. `retail_checkout_quotes` is by far the biggest converted table — 105,735 rows — and it is
ephemeral.** It is a quote cache. It also drifts fastest (it was the slowest table in the copy at
15s and one of the tables that gained rows *during* the run). Converting 105k rows of throwaway data
is most of the row count for none of the value; whether it needs copying at all is worth asking.

**6. The gzgrocery daemon issues DDL at boot.** `scripts/gzgrocery-order-daemon.js:73` runs
`CREATE TABLE IF NOT EXISTS … total REAL`. It is a channel poller, not a migration, and it will
attempt this against whatever database it is pointed at.

**7. `products.retail_price` is all zeros** (278 rows, min 0.0, max 0.0) and `products.flash_price`
is entirely NULL, while their `store_products` twins are populated. `products` looks superseded by
`store_products` for pricing. Converting four dead columns is harmless; assuming they are live is
not.

**8. Where the current code is already wrong about units — one instance, benign today.**
`store-admin.js:637`'s comment reads `gmv(¥)×bps/10000 ×100 = gmv×bps/100`. The algebra is right and
the code matches it. But the *name* `commissionThisMonthCents` sits in the same object literal as
`gmvThisMonth`, which is yuan, with nothing distinguishing them. It is correct by arithmetic and
undefended by naming — the same shape as the `setup_fee_cents` trap §24 already records.

---

## 8 — Closing check: `expense_entries.amount` and the seven sub-cent values

Run 2026-08-04, same read-only constraints, to settle the ambiguity flagged in §1b, §1e and §7.4
before the column is retyped.

### 8a — Verdict

**All seven are calculation artifacts. None is a real transaction amount.**

Every one is a per-category **subtotal of a purchase order's line items**, computed in SQL as
`SUM(qty × cost_per_unit)`, written by machine, and **regenerated from scratch** on every PO status
change. Nobody paid ¥602.67992. The sub-cent tail is truncation error in a per-unit rate, multiplied
by quantity.

Converting `expense_entries.amount` to whole cents is safe, and more than safe — it is more correct.
Rounding each of the eight underlying line totals to whole cents recovers *exactly* the figure the
arithmetic was reaching for, in 8 cases out of 8. Whole-ledger impact: **¥0.0118 on ¥148,331.73**.

`income_entries.amount` and `sales_entries.total` contain **no** genuinely sub-cent values.

### 8b — The seven rows

Every one has `po_id` set, `created_by` NULL, `payment_method` NULL, and a description of the form
`PO-XXXX · N lines`. Suppliers are not stored on the expense row; they come from the PO, and none of
these five POs carries one.

| id | date | amount | category | description | po_id | PO |
|---:|---|---:|---|---|---:|---|
| 36 | 2026-05-09 | `40.016` | 未分类 Uncategorized | `PO-0018 · 2 lines` | 36 | PO-0018 |
| 49 | 2026-05-09 | `471.2857` | 未分类 Uncategorized | `PO-0017 · 3 lines` | 35 | PO-0017 |
| 128 | 2026-08-02 | `1897.9180000000001` | Ingredients(Kitchen+Retail Use) 原材料 | `PO-0049 · 4 lines` | 67 | PO-0049 |
| 133 | 2026-08-03 | `602.67992` | Ingredients(Kitchen+Retail Use) 原材料 | `PO-0050 · 2 lines` | 68 | PO-0050 |
| 134 | 2026-08-03 | `654.999` | Packaging Materials 包装材料 | `PO-0050 · 3 lines` | 68 | PO-0050 |
| 135 | 2026-08-04 | `198.21998` | Ingredients(Kitchen+Retail Use) 原材料 | `PO-0051 · 3 lines` | 69 | PO-0051 |
| 136 | 2026-08-04 | `187.13958` | Packaging Materials 包装材料 | `PO-0051 · 2 lines` | 69 | PO-0051 |

`1897.9180000000001` is float representation noise on a genuine 3-decimal value, `1897.918`. The
other six carry real 3–5 decimal precision.

### 8c — The manual/machine split is perfectly clean

| | rows | sub-cent | `created_by` set | `payment_method` set |
|---|---:|---:|---:|---:|
| **PO-derived** (`po_id` NOT NULL) | 27 | **7** | 0 / 27 | 0 / 27 |
| **Manually entered** (`po_id` NULL) | 65 | **0** | 65 / 65 | 62 / 65 |

**Not one human-entered expense in the ledger carries sub-cent precision.** All 65 are already at
2dp or fewer. Every sub-cent value in the table was produced by machine.

### 8d — How each was written

Four writers touch `expense_entries`: the manual admin route
(`routes/finance.js:222` insert, `:261` update) and the PO poster
(`routes/purchases.js:117`, `routes/retail-purchasing.js:71`). All seven came from the PO poster.

Its core is one statement (`purchases.js:109-116`, mirrored at `retail-purchasing.js:63-70`):

```sql
SELECT
  COALESCE(NULLIF(TRIM(expense_category),''),'未分类 Uncategorized') AS category,
  SUM(COALESCE(qty_received, qty) * COALESCE(cost_per_unit, 0))     AS amount,
  COUNT(*)                                                          AS line_count
FROM po_line_items
WHERE po_id = ? AND COALESCE(qty_received, qty) > 0
GROUP BY 1
```

then `insert.run(po.date, +g.amount, g.category, desc, poId)`.

Three properties settle the question:

1. **The value is computed entirely inside SQLite** — `qty × cost_per_unit`, summed, grouped by
   category. It is never seen, typed or approved by a person.
2. **There is no rounding anywhere in the path.** `+g.amount` is a numeric cast, not a round. The
   full float lands in the column.
3. **The rows are a projection, not a record.** Both functions do `DELETE FROM expense_entries
   WHERE po_id = ?` then re-insert, on every status change (`purchases.js:103`, whose comment reads
   *"Always clear so flipping status back to Requested correctly removes the entries"*). Flip
   PO-0051 back to Requested and rows 135/136 cease to exist. Flip it forward and they are
   recomputed.

### 8e — The rows reconcile exactly to their POs

Each PO's expense rows sum to `SUM(po_line_items.total_cost)` — to the last digit. This is the proof
that they are a category split, not independent transactions:

| PO | line items | `SUM(total_cost)` | expense rows | sum |
|---|---:|---:|---|---:|
| PO-0017 (35) | 3 | `471.2857` | id 49 | `471.2857` ✓ |
| PO-0018 (36) | 2 | `40.016` | id 36 | `40.016` ✓ |
| PO-0049 (67) | 5 | `2025.018` | id 128 `1897.918` + id 129 `127.1` | `2025.018` ✓ |
| PO-0050 (68) | 5 | `1257.67892` | id 133 `602.67992` + id 134 `654.999` | `1257.67892` ✓ |
| PO-0051 (69) | 5 | `385.35956` | id 135 `198.21998` + id 136 `187.13958` | `385.35956` ✓ |

PO-0049's fifth line (a ¥127.10 folding table) split off into its own *Office Supplies* row, id 129
— which is why id 128's description says "4 lines" against a 5-line PO. All five POs have
`extra_freight`/`extra_tax`/`extra_handling` = 0, so nothing else is folded in.

### 8f — Where the sub-cent tail comes from

`po_line_items.total_cost` is `qty × cost_per_unit`, and `cost_per_unit` is a **derived per-unit
rate** — a pack price divided by a pack quantity, stored truncated:

| ing | name | `cost_per_unit` | the division it is |
|---:|---|---:|---|
| 501 | Old tofu 老豆腐 | `4.16666` | 25/6 = 4.1666̅ |
| 456 | Film bags 保温手提袋 | `0.93333` | 14/15 = 0.9333̅ |
| 254 | Real Thai Coconut Milk 椰浆 | `24.45333` | 1834/75 = 24.45333̅ |
| 318 | ROOTS Retail Bags 牛皮纸手提袋 | `0.359533` | 5393/15000 = 0.3595333̅ |
| 358 | Foam Box #5 泡沫箱 | `1.65166` | 991/600 = 1.651666̅ |
| 231 | Kaboo Coconut Sugar 椰子花糖 | `41.653` | 3124/75 = 41.65333̅ |
| 21 | Cherry Tomato 圣女果 | `0.016` /g | ¥16/kg ÷ 1000 |
| 310 | 150ml Glass Jars 玻璃瓶 | `1.2857` *(buy_price)* | 9/7 = 1.28571̅ |

Every one is a non-terminating decimal truncated at 5–6 places. Multiply the truncated rate by a
quantity and the truncation error scales with it: `4.16666 × 3 = 12.49998` instead of `12.50`;
`0.93333 × 300 = 279.999` instead of `280.00`. **The sub-cent tail is the error, not the data.**

### 8g — What rounding to whole cents actually does

| line | qty | stored `cost_per_unit` | stored `total_cost` | → cents | implied exact rate |
|---|---:|---:|---:|---:|---|
| PO-0051 li 160 Old tofu | 3 | 4.16666 | `12.49998` | **12.50** ✓ | 25/6 |
| PO-0050 li 144 Film bags | 300 | 0.93333 | `279.999` | **280.00** ✓ | 14/15 |
| PO-0050 li 147 Coconut milk | 24 | 24.45333 | `586.87992` | **586.88** ✓ | 1834/75 |
| PO-0051 li 159 Retail bags | 300 | 0.359533 | `107.8599` | **107.86** ✓ | 5393/15000 |
| PO-0051 li 161 Foam box #5 | 48 | 1.65166 | `79.27968` | **79.28** ✓ | 991/600 |
| PO-0049 li 128 Coconut sugar | 6 | 41.653 | `249.918` | **249.92** ✓ | 3124/75 |
| PO-0018 li 67 Cherry tomato | 1 g | 0.016 | `0.016` | **0.02** | ¥16/kg |
| PO-0017 li 65 Glass jar | 1 | 1.2857 | `1.2857` | **1.29** | 9/7 |

Eight out of eight land on a clean two-decimal figure. Six recover a value that is provably what the
supplier's pack price implies.

Whole-ledger impact:

| | ¥ |
|---|---:|
| sum of all 92 `expense_entries.amount` today | **148,331.72818** |
| same, each row rounded half-up to whole cents | **148,331.74** |
| **delta** | **+0.0118** |

Largest single-row movement is **¥0.0043** (id 49). The other 85 rows are already exact cents and do
not move at all.

**The one honest caveat.** The two `qty = 1` lines are different in kind from the other six.
Rounding a *line total* is lossless when quantity is large, because the truncation error is what
gets removed. When quantity is 1, rounding the line total is the same as rounding the unit rate —
cherry tomato at ¥0.016 for one gram becomes ¥0.02, a 25% relative move on ¥0.004 absolute. That is
an argument about **`po_line_items.cost_per_unit`**, which stays `numeric(14,6)` and should. It is
not an argument about `expense_entries.amount`, which is a *category subtotal* — a
transaction-level figure that has no business carrying a unit rate's precision. A one-gram cherry
tomato line is also, on its face, junk data.

### 8h — `income_entries.amount` and `sales_entries.total`

Both clean.

| column | rows | repr shows >2 decimals | **genuinely sub-cent** (>1e-6 off a whole cent) |
|---|---:|---:|---:|
| `income_entries.amount` | 13 | 0 | **0** |
| `sales_entries.total` | 28,400 | 12 | **0** |
| `sales_entries.unit_price` *(adjacent, checked too)* | 28,400 | 0 | **0** |
| `expense_entries.amount` | 92 | 7 | **7** |

The 12 `sales_entries.total` values that *look* like they carry more decimals are IEEE-754
representation noise on exact 2dp amounts — `80.03999999999999`, `64.28999999999999`,
`128.30000000000002`. Every one is within 1e-12 of a whole cent.

### 8i — Reading

The precision exception was the right call for the nine columns it was made for. It was applied to
`expense_entries.amount` because the *symptom* matched — values with more than two decimals — but
the *cause* is different. The nine unit-cost columns hold rates that are genuinely sub-cent
(`ingredient_price_history.price` bottoms out at `0.004`, and whole cents would zero it).
`expense_entries.amount` holds no rate. It holds a sum of money, and the sub-cent digits are
arithmetic residue from rates that live elsewhere and stay `numeric(14,6)`.

**Two requirements for whoever applies the change:**

1. **Round at the source, not only at the column.** `postPOExpenses()` and
   `postRetailPOExpenses()` compute `SUM(qty × cost_per_unit)` with no rounding. If the column
   becomes whole cents and the poster is left alone, the next PO status flip regenerates a sub-cent
   value and the write fails the whole-cent check.
2. **Round the category subtotal, not each line**, so the expense rows continue to sum exactly to
   the PO total — the invariant §8e shows holds today.

Separately: the manual route `finance.js:216` is `parseFloat(amount)` with only a `> 0` check. No
human has typed a 3-decimal expense in 65 rows, but nothing stops one.

---

## Appendix — the 97 SQL aggregate lines

`database.js:3548` ·
`routes/ai.js:317,324,332,2024,2031,2038,2049,2069,2228,2235,2241,2362,2365,2455,2571,2612,2613` ·
`routes/finance.js:80,287,288,289,290,291,292,293,498,554,633` ·
`routes/pos.js:201,215,222,306` ·
`routes/products.js:860,875,884` ·
`routes/purchases.js:110,186` ·
`routes/retail-purchasing.js:65,157,168,173,178,305,370,403,444,481,504,505,532,558` ·
`routes/retail.js:1664,1684,11852,11880,11902,11921,12038,12039,12210,12225,12254,12308,12314,12334,12342,12364,12384,12411,12424,12433,12434,12441,12457,12486,12487,12488,12489,12490,12491,14607,14608,14674,14676,14718,14737,14790,15347,15819,15843,18410,26234,27841` ·
`routes/sales.js:176,185,336,353,364,406,445,446,447,448,449,476,489,506,517,529,530,544,558,569,594,647,648,663,783,836,837,838,839,840,841,842,843,844,845,846,847,873,874,888,897,898,899` ·
`routes/store-admin.js:615`

Aggregates over the already-cents `*_cents` columns — **not** in scope, listed so they are not
converted by mistake: `routes/store-admin.js:243,251,490,634`, `routes/saas-admin.js:332,364`.
