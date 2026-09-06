# Splitting `retail_vouchers.value` — design, not yet built

**Ash ruled 2026-09-06: the column splits.** This is the shape that ruling
needs before any schema moves, plus the reader list a change would have to
cover. **Nothing has been changed.** The money migrator refuses the column
meanwhile, so there is no deadline.

---

## What the column holds

One `REAL` column carrying three different things, chosen by `type`:

| `type` | `value` means | Example |
|---|---|---|
| `fixed_amount` | **yuan** | `20` = ¥20 off |
| `percent` | **a percentage** | `20` = 20% off |
| `free_shipping` | **nothing** | ignored entirely |

`20` and `20` are the same number and opposite instructions.

---

## Why this is the most dangerous column in the money registry

"Converting it multiplies every percent coupon by 100" undersells it, and I had
it wrong that way myself before reading the apply path.

`routes/retail.js:13028` clamps the percentage:

```js
const pct = Math.max(0, Math.min(100, Number(voucher.value || 0)));
```

So after a naive `ROUND(value * 100)`:

- a 20%-off coupon stores `2000`
- the clamp turns `2000` into exactly **`100`**
- the coupon becomes **100% off**

**It does not produce an absurd number somebody notices. It produces a free
order.** Verified by running the real function's arithmetic on a ¥200
couponable subtotal:

```
today  value=20    → discount ¥40.00   customer pays ¥160.00
after  value=2000  → discount ¥200.00  customer pays ¥0.00
```

And it would happen to **every percent coupon at once**, on the first order
after the migration, with no error anywhere.

---

## The proposed shape

Two columns, each meaning one thing, neither meaning anything for the type it
does not belong to:

| Column | Type | For | Unit |
|---|---|---|---|
| `discount_cents` | `INTEGER` | `fixed_amount` | integer cents (MINOR) |
| `discount_percent` | `REAL` | `percent` | a percentage — **not money** |

`free_shipping` sets neither. It already carries its meaning entirely in
`type`, and the apply path returns `{ discount: 0, free_shipping: true }`
without reading `value` at all.

**`discount_percent` stays out of the money registry**, in `NOT_MONEY`, beside
`recipe_cost_data.target_food_cost` — which the registry already records as *"a
PERCENTAGE… It is not money at all; it was caught by the word 'cost'."* Same
reasoning, same shelf. Putting a percentage in a money column is what caused
this.

**Why two columns rather than a per-type conversion:** a per-type conversion
leaves the trap in place. The next person to write a migration, a report or an
export against `value` has to know about `type` to be correct, and nothing in
the column's name or type tells them. Two columns cannot be misread — a
`_cents` column holds cents, and the suffix is the type system this codebase
uses (`scripts/migrate_money.js` says so in as many words).

---

## Everything that reads it

Small, which is what makes this tractable:

| Where | What it does |
|---|---|
| `routes/retail.js:13025` | `fixed_amount` — `Math.min(value, couponable)` |
| `routes/retail.js:13028` | `percent` — the clamp above |
| `routes/retail.js:668-670` | the display label: `'¥' + value` / `value + '%'` / `FREE` |
| `routes/retail.js:16529` | the admin's generic `UPDATE … SET` from a field map |
| `public/cms.html` | `couponDisplayFromVoucher()`, mirroring `:668` |
| `miniapp/pages/coupons/coupons.js:33` | `Number(v.value || 0)` for the wallet card |

Two of those are display, one is a generic update, and the mini app one **ships
on a WeChat release cycle** — so the client cannot be assumed to have moved
when the server does.

---

## Order it would have to happen in

The mini-app constraint decides this. A handset can be running last month's
build.

1. **Add both columns.** Backfill from `value` by `type`: `fixed_amount` →
   `discount_cents = ROUND(value*100)`, `percent` → `discount_percent = value`.
   Nothing reads them. Reversible. This is the money ladder's own rung-1 shape.
2. **Write both.** The admin writes the new columns *and* keeps `value` correct,
   so an old mini-app build still works.
3. **Read the new ones** on the server, with `value` still maintained.
4. **Publish the mini app** reading the new fields.
5. **Only then** stop writing `value`, and drop it a release later.

Steps 1–3 change no behaviour. Step 5 is the only irreversible one and it is
months of caution away from the danger described above.

---

## What I would check before step 1

One read-only query, which needs somebody at the box:

```sql
SELECT type, COUNT(*) AS n, MIN(value) AS lo, MAX(value) AS hi
  FROM retail_vouchers GROUP BY type;
```

It answers two things the design assumes: how many `percent` coupons exist at
all, and whether any `fixed_amount` value carries sub-cent precision that a
`_cents` column would round. If there are no `percent` coupons in the whole
table, this is a much smaller job than the above — and the danger, while real,
would be theoretical rather than live.

---

## Recommendation

**Do not start with the schema.** Run the query first. The design above is
sound either way, but its size depends entirely on that answer, and there is no
pressure: the migrator refuses the column, so nothing can convert it by
accident today.
