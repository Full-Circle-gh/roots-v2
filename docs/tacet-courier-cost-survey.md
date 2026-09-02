# Courier cost — where the money we PAY a courier lives today

**2026-09-02 · Read-only survey. No code was changed, no schema was altered, and no database
was opened.** Commissioned to answer one question before any design: is the money we pay a
courier recorded anywhere, and could attaching it to an order double-count against what
Finance already counts as an operating cost.

**Scope note, stated first because it bounds every row count below.** This session runs in an
ephemeral container with **no `data/roots.db`** — `database.js:26` opens
`path.join(DATA_DIR,'roots.db')` and that file does not exist in the repository or in this
container. **So no live-row count in this document was measured by this survey.** Every figure
quoted is attributed to `docs/tacet-money-model-survey.md` (2026-08-04, live SQLite `mode=ro`)
or to `docs/tacet-consolidation-decisions.md` §36, with its date. Where the honest answer is
"the column does not exist", that is a fact about the schema and is established from code.

Repository at `origin/main` `d510b048`.

---

## 0 — The one-paragraph answer

**Courier cost is not captured on any first-party delivery, and there is no column anywhere to
put it.** Qingyun quotes us a real fee at dispatch and we spend it out of a prepaid wallet; the
figure crosses the wire, renders once in the drawer, and is discarded — nothing writes it. JD
labels carry no price at all. Phoned-in deliveries leave no trace. **The one place a delivery
cost we actually paid IS recorded is `meituan_orders.delivery_fee_paid`**, which arrives by a
hand-run settlement import into a table Finance does not read, and is netted out of revenue on
the kitchen app's Meituan tab. **So there is no double-count today** — but only because one
side of the pair is empty. The two sides are already independent ledgers of the same reality,
and the double-count Ash is worried about becomes reachable the moment courier cost lands on an
order while a person keeps typing courier spend into `expense_entries`, which nothing prevents,
flags, or even names.

---

# PART A — is courier cost captured at all?

## A1 — Qingyun: the fee is KNOWN, quoted, and spent, and it is never stored

**`delivery_jobs` has no cost column.** The full DDL is `database.js:5066-5096` plus one
migration (`:5103`, `superseded`). Twenty-six columns: identifiers, carrier and rider,
two raw status enums, rider GPS, ETA, recipient snapshot, two raw JSON blobs, timestamps.
**Not one of them is money.** Nothing named `fee`, `cost`, `price`, `amount` or `charge`
appears in the table at any point in its history.

**But the fee exists and we see it.** `lib/qingyun-browser.js:567` `quoteCarriers()` calls
`delivery/previewSingle` per carrier and reads `d.totalFee`, exposing it as
`feeCents` / `feeYuan` (`:591-592`). `dispatch()` (`:616`) passes it straight back as
`deliveryFee` in the `delivery/create` body. **That call spends real money** — the route's own
comment at `routes/retail.js:25041` says "deducts the fee from the Qingyun wallet + sends a
courier", and the confirm dialog in `public/retail-admin/04-orders.js:4805` tells staff so.

**The path the number takes, and where it stops:**

| Step | File | What happens to the fee |
|---|---|---|
| Quote | `lib/qingyun-browser.js:591` | `feeCents` / `feeYuan` read from `previewSingle` |
| Serve | `routes/retail.js:25009` | whole carrier list returned to the browser |
| Render | `public/retail-admin/04-orders.js:4783` | `¥${c.feeYuan}` in the picker |
| Dispatch | `routes/retail.js:25061` | the chosen carrier is sent; wallet is charged |
| Echo | `routes/retail.js:25071` | `fee_yuan` returned in the response |
| Display | `public/retail-admin/04-orders.js:4820` | `✓ Dispatched: <name> ¥<fee>` |
| **Persist** | — | **nothing. No INSERT, no UPDATE, anywhere.** |

**Reload the drawer and the figure is gone.** There is no server-side record that a dispatch
cost anything, only `activity_log`-free silence — the dispatch route logs no activity row
either. `delivery_jobs` gains a row from the daemon's poll, but that row describes the rider,
not the bill.

**One recovery candidate, named because it is the only one.** `delivery_jobs.raw_order`
(`database.js:5089`) holds `JSON.stringify(d.raw).slice(0,20000)` — the whole `order/list`
entry as Qingyun returned it (`lib/qingyun-browser.js:264`). Whether that payload carries a
settled delivery fee is **unknown and unverifiable from the repository**: `_parseOrder`
(`:245-266`) names twenty fields and none of them is money, and no other code reads
`raw_order`. It may or may not be in there. It is not a finding that it is; it is a finding
that nobody has looked.

**A1 answer to "how many live rows carry a non-null value": the column does not exist, so the
count is not zero — it is unaskable.**

## A2 — JD: no price field exists on any JD path

`lib/jd.js` is 475 lines and contains **no** `fee`, `cost`, `price`, `freight` or `amount`
identifier. The nine exported functions are range check, waybill-code allocation, waybill
create, cloud-print pull, trace, cancel and intercept — a logistics API surface with no billing
surface. JD bills the merchant account out of band.

The create handler (`routes/retail.js:27379-27404`) writes back exactly three things on
success: `tracking_carrier='jd'`, `tracking_number` (the waybill), `tracking_status`, plus
`package_count` and `dispatched_at`. **`retail_shipments` has no cost column either** —
DDL at `database.js:3388-3408`, migrations at `:3417-3441` (`local_eta`, `eta_source`,
`package_count`, `air_delay_cleared_at/by`). Nineteen columns, none of them money.

`package_count` (一单多件) is the closest thing to a cost driver on the table and it is a count,
not a charge.

**A2 answer: no column, so no rows.**

## A3 — Deliveries arranged outside Tacet: nothing is recorded

**Phoned-in couriers leave no trace at all.** There is no manual courier-cost entry surface on
an order, no "how was this delivered" free-text cost field, and no ad-hoc delivery record. A
staff member who rings a rider and pays cash creates no row anywhere in this system.

**A delivery booked directly in the Qingyun app is HALF-visible.** The daemon polls the store's
own order tabs and upserts every in-flight job it finds (`scripts/qingyun-daemon.js:373`,
matching a roots order by the `order_no` stamped in 备注 or by phone tail,
`:300-327`), so the rider, carrier and status arrive. **The fee does not**, for the same reason
as A1 — there is no column.

**A delivery booked in a marketplace's own app is invisible by construction:** we never see the
carrier's bill, and for Meituan and Eleme the cost is already inside the settlement (A4).

**A3 answer: no, it is not recorded anywhere. Stated plainly because the question asked for it.**

## A4 — Per channel: how delivery is arranged, and whether a cost reaches our data

| Channel | Who delivers | What the customer paid us | **What the courier cost us** |
|---|---|---|---|
| **meituan** | Meituan's own rider (`美团直送` / `经济送`) or 商家自配 — `meituan_orders.delivery_method` | `retail_orders.shipping_fee` ← `money.shipping` (`routes/meituan-internal.js:443`); also `meituan_orders.customer_delivery_fee` | **Captured, but only in the settlement table.** `meituan_orders.delivery_fee_paid` (`database.js:1266`, 配送费用) + `delivery_tip_paid`. Written ONLY by `scripts/import_meituan.js:65` — a hand-run import of the B2B billing export. **Never reaches `retail_orders`.** |
| **eleme** | Eleme's own rider | `retail_orders.shipping_fee` ← `packingFee`/`shippingFee` (`routes/eleme-internal.js:439`) | **Nothing.** Eleme has no settlement-export importer at all. The cost is folded silently inside `channel_settle_amount` (`merchantIncome`) and is not separable. |
| **gzgrocery** | gzgrocery's own logistics, off our books | **Nothing** — the mirror writes `subtotal = total` with no fee (`scripts/gzgrocery-order-daemon.js:308-315`); it is a wholesale ledger, not a retail sale | **Nothing, and correctly so** — we do not pay this courier. |
| **wechat / web** (first-party) | **Us.** GZ same-city same-day → Qingyun (`lib/inventory.js:1369` `QINGYUN_PUSH_CHANNELS = ['wechat','web']`, gate at `:1387`). Out-of-city / later-day → JD air or land waybill. Anything else → phoned in. | `retail_orders.shipping_fee`, priced from `retail_delivery_zones` | **Nothing, on all three routes.** This is the whole gap: **the only channel where we actually pay a courier out of our own pocket is the only one with no cost record.** |

**Two channels appear in production and are mapped nowhere:** `wechat_chat` and `pickup`,
¥4,043 across 3 orders from August 2026 (§36, *Explicitly NOT decided here*). Not delivery
channels for this purpose, but named so the four-channel list is not read as exhaustive.

## A5 — Columns intended for actual delivery cost and currently unused

**There are none.** Every money column on `retail_orders` and its neighbours was enumerated —
the base DDL (`database.js:1567-1606`) and all 96 `addColumn('retail_orders', …)` migrations
(`:1968-3692`). The money columns are `subtotal`, `shipping_fee`, `voucher_amount`,
`points_amount`, `total`, `packing_fee`, `same_day_surcharge_fee`, `balance_used`, the five
refund amounts, and `channel_commission` / `channel_settle_amount` / `channel_discount`.
**Every one is customer-side or platform-side. Not one is a cost we pay a courier.**

Four columns are close enough that a reader could mistake one for the answer, so each is ruled
out explicitly:

- **`retail_delivery_zones.weight_first_kg_fee` / `weight_extra_kg_fee`** (`database.js:2934`).
  The comment calls this "per-area courier weight pricing (首重/续重)" and the delivery screen's
  helper is named `zoneCourierRate` in spirit (`06-delivery.js:646`: "the courier rate when the
  zone prices by weight"). **It is a rate card we CHARGE the customer**, feeding `shipping_fee`.
  It happens to mirror a courier's own table, which is exactly why it reads like a cost.
  **Both are NULL on all 15 zones** (money survey §1a) — so this is genuinely unused, and it is
  still not the column being looked for.
- **`retail_order_addons.freed_shipping`** (`database.js:2843`) — delivery fee *waived* to the
  customer when an add-on crosses the free threshold. Revenue foregone, not cost incurred.
- **`purchase_orders.extra_freight`** (`database.js:570`) — **inbound** freight on a supplier
  purchase order. It posts to Finance as `运费及杂费 Freight & fees`
  (`routes/retail-purchasing.js:132`). This is the one existing "freight" concept in the ledger
  and it is the opposite direction. **A courier-cost category sitting next to it would be one
  vocabulary away from being summed with it.**
- **`retail_shipments.package_count`** — a box count, not a charge.

---

# PART B — what does Finance already count?

## B1 — What the Finance section reads (Q6)

**Two endpoints, four tables, and that is the whole surface.**

**Summary** — `routes/finance-summary.js`:

| Line | Source | Statement |
|---|---|---|
| Revenue | `retail_orders` | `SUM(total)` where `PAID` and `date(COALESCE(paid_at,placed_at),'+8 hours')` in window (`:97-101`) |
| Cost of goods | — | **hard `null`**, always, until a cost reader exists (`:141`) |
| Gross profit | — | **hard `null`** |
| Operating expenses | `expense_entries` | `SUM(amount)` over the window (`:108-111`), plus a `GROUP BY category` breakdown (`:119-124`) |
| Net | — | `revenue − expenses`, **with no cost taken off** (`:145`) |

**Transactions** — `routes/finance-transactions.js:237`: `income_entries` (typed non-sale
income), `expense_entries WHERE po_id IS NULL` (hand-entered), and
`expense_entries JOIN purchase_orders` collapsed to one row per PO. **It does not read orders**
(§36, *Transactions reads typed rows, not the order record*).

**Is courier or delivery spend among them? Only if a person typed it, and nothing named it.**

- **Writers of `expense_entries`, all four:** the Tacet form (`finance-transactions.js:171`),
  the retired kitchen form (`routes/finance.js:230`), and the two PO posters
  (`routes/purchases.js:553`, `routes/retail-purchasing.js:125`). **There is no bank import, no
  invoice feed, no OCR path, and no automatic writer of any kind for delivery spend.**
- **`expense_entries` has no channel, no location, no order reference.** Its columns are
  `id, date, amount, category, description, po_id, created_at, created_by`
  (`schema.sql:229-240`). A courier expense could never be attributed to an order even if typed.
- **`category` is free text**, normalised for bytes only (`lib/category-text.js`), snapped
  against a per-tenant `categories` list that ships **empty** for income and is
  tenant-authored for expense. **The shipped expense defaults are
  `食材采购 Ingredients · 人工 Labour · 房租水电 Rent & Utilities · 营销 Marketing · 设备 Equipment ·
  其他 Other`** (`public/app.html:23984`). **No delivery or courier category exists in any
  seed, list or constant in this repository.** The nearest thing is on the wrong side of the
  ledger: `外送 Delivery` is an **income** default (`:23983`).
- **Whether any live row is in fact courier spend is unmeasurable here** — no database. §36
  records the ledger holds 111 expense rows across May–July 2026 totalling ¥180,332.28; the
  money survey (2026-08-04) counted 92 rows, 65 manual and 27 PO-derived, with only
  `未分类 Uncategorized`, `Ingredients(Kitchen+Retail Use) 原材料`, `Packaging Materials 包装材料`
  and `Rent` visible in its samples. **`未分类 Uncategorized` is where a courier payment would
  most plausibly be hiding**, and nothing in the repository can say whether it is.

## B2 — Does anything already subtract a delivery cost from revenue at order level? (Q7)

**Yes — one screen, and it is not Tacet's.**

`GET /api/meituan/analytics` (`routes/sales.js:820`) builds a fee waterfall over
`meituan_orders` and sums
`delivery_fee_paid + delivery_tip_paid + ad_spend + coupon_subsidy_paid + insurance_fee +
partial_refund + |commission|` as `total_fees` (`:861-864`), rendered as
`Delivery fees · 配送费` in the deduction bars (`public/app.html:21180`) against
`net_to_merchant`. The same subtraction appears per store (`routes/sales.js:903`).

**This is a real delivery cost netted off revenue, per order, today.** Three things keep it from
being a double-count right now:

1. **It is the KITCHEN app** (`public/app.html`, `requirePermission('sales')`, the global `db`
   handle — not `tdb()`), the app §36 is retiring. Tacet's Finance never calls it.
2. **It reads `meituan_orders`, which Finance does not touch.** Finance reads `retail_orders`.
   These are two separate records of the same Meituan sales — the settlement import and the
   daemon mirror — and no query sums them together.
3. **It is a courier cost we never pay directly.** Meituan deducts it from the settlement before
   the money reaches us, so it is already absent from `channel_settle_amount`.

**But note the shape, because it is the shape of the risk.** The same yuan of Meituan delivery
cost is present as a deduction in `meituan_orders.delivery_fee_paid` and absent-by-deduction
inside `retail_orders.channel_settle_amount`. **Two records, two treatments, no reconciliation
between them.** Adding a third home for courier cost on `retail_orders` without deciding what
happens to these two makes it three.

**One more order-level allocation worth flagging, though it is not a cost subtraction.** The
Products list allocates `channel_settle_amount` across a Meituan order's lines by goods share
(`routes/retail.js:22278`). **`channel_settle_amount` contains the customer's delivery fee**, so
the delivery money is spread across products as product revenue. A per-product margin read off
that figure overstates product revenue by the delivery share. Recorded because it is the one
place a delivery figure is already being pushed down to line level.

## B3 — `shipping_fee` and `packing_fee`: where they are consumed (Q8)

**Both are REVENUE everywhere they appear in a financial figure. Neither is treated as a cost
anywhere in Tacet.**

| Site | Treatment |
|---|---|
| Checkout pricing (`routes/retail.js:9484`) | `grossTotal = subtotal + shippingFee + packingFee − voucherDiscount` — **inside `total`** |
| **Finance revenue** (`routes/finance-summary.js:97`) | `SUM(total)` — **so both fees are revenue, silently, on every channel** |
| Dashboard composition (`routes/retail.js:13924-13926`) | `SUM(shipping_fee) AS delivery_fee`, rendered as a revenue-composition segment (`03-dashboard.js:3672`) and exported as `revenue_composition.delivery_fees` (`:3979`) |
| Settlement panel (`04-orders.js:5375`) | `Customer delivery fee 顾客配送费` — a revenue row above the commission deduction |
| Invoice "Copy for accounting" (`07-content-billing.js:497`) | goods-only; delivery **excluded** from the fapiao total. Not a cost treatment — an exclusion. |
| Receipt print (`lib/feie.js:586`) | `Shipping` line item on the customer's receipt |

**On the conflation the earlier survey found — confirmed, and Finance inherits it in a worse
form than the Dashboard.**

The Dashboard's `delivery_fee` is `SUM(retail_orders.shipping_fee)` across **all paid orders,
every channel**. For a Meituan order that column is written from `money.shipping`
(`routes/meituan-internal.js:443`) — **用户支付配送费, what the customer paid MEITUAN**, money we
never received as delivery revenue and which Meituan then spends on its own rider. For Eleme it
is the same (`routes/eleme-internal.js:439`). For wechat/web it is **our own delivery charge**,
which we did receive. **The Dashboard sums the two as one figure. Confirmed.**

**Finance inherits it, and loses the ability to see it.** Finance never selects `shipping_fee`
at all — it reads `SUM(total)`, and `shipping_fee` is a term inside `total` on every channel.
So the conflated delivery money is **inside the Finance revenue line, unlabelled and
unseparable**. The Dashboard at least draws it as its own segment where someone could notice;
Finance shows one number with it folded in. **Finance does not reproduce the Dashboard's
delivery figure — it swallows it.**

**A second-order consequence, recorded because it bears directly on the double-count question.**
Ash's framing is that 预计收入 includes the delivery fee the customer paid. That is true of the
settlement panel's `channel_settle_amount`, and it is **also** true of Finance's revenue line by
a different road: `retail_orders.total` for a Meituan order is `userPayTotalAmount`
(`routes/meituan-internal.js:440`), which likewise includes it. **Finance's revenue line already
counts marketplace delivery fees as our revenue on ~every channel order.** No courier cost is
netted against them anywhere in Tacet.

## B4 — Do Finance and the order-level margin work share a figure? (Q9)

**No. They are fully independent today, and by explicit decision.**

- **`unit_cost_at_sale` is WRITE-ONLY.** Written on all six sale paths
  (`routes/retail.js:10817`, `:23046`, `:32374`; `routes/meituan-internal.js:506`;
  `routes/eleme-internal.js:464`; `scripts/gzgrocery-order-daemon.js:318`) and **read by
  nothing** — no route, no script, no screen. Verified by exhaustive grep.
- **Finance reports cost as `null`, deliberately.** `routes/finance-summary.js:141` returns
  `cost_of_goods: null` and `gross_profit: null`, with the file's own header stating "There is
  no cost reader, and this file does not become one" and "Null, never zero: *zero claims the
  goods were free*".
- **Net is therefore revenue − operating expenses with no cost taken off** (`:145`), which the
  file records as a decision rather than an oversight.
- **The only figures they will ever share are the tables**: Finance revenue reads
  `retail_orders`, the future cost reader reads `retail_order_items`. §36's *Six ways the cost
  reader will silently miscount* binds that build.

**Delivery cost appears in none of it.** It is not in the staircase, not in the six miscount
rules, not in the two "non-null cost is still wrong" findings, and **not in §36's
*Explicitly NOT decided here* list.** It is not an open item. It has never been raised.

---

## C — The double-count paths, stated as findings

Ash asked whether the same yuan could be counted twice. **Today it cannot, because one side is
empty.** These are the paths by which it becomes possible, ranked by how little work each takes.

**C1 · A person types courier spend into `expense_entries` while an order also carries it.**
Nothing prevents this, nothing detects it, and **nothing would look wrong**: the expense row
would carry a tenant-authored category with no channel, no location and no order reference
(B1), so no query could ever tell it apart from rent. This is the exact failure §36 already
records for the Mini App settlement receipts — ¥152,309 filed under a channel name because the
operator had money and nowhere to file it. **The mechanism is identical and the direction is
reversed.**

**C2 · Meituan's delivery cost has two homes already.** `meituan_orders.delivery_fee_paid` is
deducted from revenue on the kitchen Meituan tab (B2); the same cost is deducted upstream inside
`channel_settle_amount` on `retail_orders`. **Attaching a third figure to the retail order would
be the second double-count, not the first.**

**C3 · `未分类 Uncategorized` is an unmeasured liability.** Two of the money survey's seven
sub-cent expense rows carry it, and the survey did not enumerate categories on the 65 manual
rows. **Whether courier spend is already in the ledger under a name nobody chose is the one
question in this survey that only a live database can answer**, and it is the one that decides
whether C1 is a future risk or a present fact.

**C4 · A courier cost category would sit one vocabulary edit from inbound freight.**
`运费及杂费 Freight & fees` is machine-written by the PO posters (`retail-purchasing.js:132`) for
supplier freight IN. A hand-typed 运费 for courier spend OUT would read identically on the
Summary's category breakdown, and `storeCategory` normalises bytes, not meaning
(`lib/category-text.js`, *NOT NORMALISED — case, and translation*).

**C5 · The Dashboard/Finance delivery conflation is not itself a double-count, but it means
delivery revenue is already overstated** by the marketplace fees the customer paid the platform
(B3). Netting a courier cost against a revenue figure that already contains money we never
received produces a margin that is wrong in both terms at once.

---

## D — What is NOT decided, and is not decided here

This document proposes nothing. Recorded so a later session does not read absence as consent:

- Whether courier cost belongs on the order, on a delivery job, in the ledger, or in more than
  one place.
- What happens to `meituan_orders.delivery_fee_paid` and the kitchen Meituan tab when the
  kitchen app is retired.
- Whether `delivery_jobs.raw_order` already contains a settled Qingyun fee. **Unknown.
  Answerable by reading one production row and nothing else.**
- Whether any live `expense_entries` row is courier spend today (C3).
- Whether the Dashboard's conflated delivery figure is corrected, and whether Finance's revenue
  line should separate marketplace delivery from our own.
