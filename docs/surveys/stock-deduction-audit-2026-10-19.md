# Stock deduction audit — 2026-10-19

Read-only survey against main `9ae4cc3`. Nothing in this document is a decision;
it is what the tree does today, with the places that do not match the rules in
`docs/tacet-consolidation-decisions.md`. Line numbers are where each thing was
found on that SHA, not a current position.

The short version: the core is sound. One real bug in refunds, one in the
production log, and a family of gaps on the gzgrocery and platform ingests.
Pre-orders and waste themselves are correct.

## How stock moves today (so the findings have a frame)

There is one shelf table (`retail_store_stock.physical_qty`) and one ledger
(`retail_stock_ledger`). Everything that moves stock writes both. Orders take
stock by one of two doors:

- **A hold, then a commit.** Same-day Guangzhou, collection, QR table orders, and
  any `strict` product on any order: reserved at checkout, taken at payment (QR:
  at submit). Ledger reason `order_commit`, and the hold row stays `committed`.
- **Straight to the ledger.** Everything else: taken at payment under
  `order_prepare`, except a batch-made ("fresh") line, which waits (§58) for
  备货, packing, the parcel it rides on, or the ship-day restock (§478,
  `order_restock`). Parked pre-orders wait for the restock and take everything
  then (`awaiting_restock_release`, written as a committed hold).

Refunds and cancels go through one door, `reverseOrderStock`: it tries the hold
reverser first, and only if that returns nothing does it try the ledger
reverser. That ordering is finding 1.

Waste, production, transfers, purchase receipts and recounts all go through
`adjustStock`, which also fires two things on any INCREASE: release of parked
orders at that store, then the ship-day fresh take.

## Findings, in order of how much they matter

### 1. BUG — a mixed order gives back only half its stock on cancel or refund

`routes/retail.js` `reverseOrderStock` (~2239): `if (first && first.reversed > 0)
return first;` — the hold reverser returning anything stops the ledger reverser
from running.

An order that reserved SOME lines and ledger-committed the rest hits this. That
is the ordinary out-of-city basket: a bought-in product (drink, jar, snack) is
`strict` by default, so it reserves at checkout; a wrap or salad is batch-made,
held back by §58, and lands as `order_prepare` at 备货. On a full cancel or
refund the drink comes back and the wrap never does. A partial refund that names
both kinds of line does the same.

Proven with the real functions against a throwaway DB
(`scratchpad/proof_mixed_refund.js`):

```
after paid   jar=2 salad=5  ledger=[700:-1:order_commit]
after 备货    jar=2 salad=4  ledger=[… 310:-1:order_prepare]
after cancel jar=3 salad=4  ledger=[… 700:1:order_reverse]      ← salad never returned
```

Also reached by: an operator park from `paid` (§136) and release, parcel
recovery (`shipments/:sid/recovery`), and any order with both kinds of row.
§478 rule 4 already names this early-return as the reason it avoided writing a
hold; it worked around the bug rather than fixing it.

**The comment above the function is stale**: it says "commitUnreservedOrder
refuses any order carrying a reservation row at all", which stopped being true
when the per-product guard went in. Both kinds of row on one order is now the
normal case.

**Fix shape (one pass, low risk):** always fall through to the ledger reverser.
It is already safe to do so: it caps each product at `order%` minus
`order_reverse%`, and `order_commit`/`order_reverse` match those prefixes, so a
line the hold reverser already returned nets to zero. Scenario 3 of the proof
runs exactly that sequence twice and over-returns nothing.

### 2. BUG (narrow) — the production log can roll back on its own loss line

`routes/retail-production.js` ~227-251. A batch is written as +made (through
`adjustStock`) and then the loss (made − shelved) as waste. `adjustStock`'s
post-increase hooks run between the two, inside the route's outer transaction:
a parked order can be released against the GROSS figure, and the shelf can then
be short of the loss. `recordProductWaste` reads on-hand, throws
`insufficient_stock`, and the whole batch rolls back (batch row, +made, the
release, the customer promotion). The operator sees a generic 500 and a retry
fails the same way. Only bites when a parked order needs more than
`shelved`; then it bites every time.

Related: `production_batches.request_id` has no unique index and is never
checked, so a double tap logs the batch twice (+2×made). There is no edit or
delete for a batch; the only undo is a recount.

### 3. BUG — gzgrocery orders still clamp at zero and reverse in full

`scripts/gzgrocery-order-daemon.js` ~489-519. Shelf 2, order of 5 → ledger
−2, three units vanish from the record with no alert (`notifyStockGaps` is
Meituan/Eleme only). Cancel → +5. The shelf now says 5 for a product it held 2
of. §39 rulings 1 and 7 removed this clamp everywhere else; §84 says gzgrocery
"has no order-ingest path to unclamp", which the tree contradicts — this daemon
IS that path.

Same daemon: `退款中` (refund pending) is in its VOID list, so a pending refund
restocks the order; if the refund is then rejected the flags stay set and the
stock is never re-taken. Meituan and Eleme get this right. Unmatched SKUs on a
gzgrocery order are skipped silently.

### 4. RISK — add-ons on out-of-city orders are never deducted for the same product

`routes/retail.js` `finalizeOrderAddon` (~35260): the add-on deducts only
`if (orderTracksStock(order.id))`, which tests for committed HOLDS. Since
2026-08-31 every paid order deducts, but the out-of-city ones do it straight to
the ledger with no hold, so this test says "not tracked" and skips. A NEW
product added later lands at the next forward transition (per-product guard
sees it as unseen). An add-on of a product already on the order (+1 more of the
same jar) is never deducted at all. The comment above it ("keep that policy for
the add-on too") describes the pre-August rule.

### 5. RISK — Meituan/Eleme ingest can deduct the same platform order twice

`scripts/meituan-daemon.js` 684-714 (Eleme and Shangou the same shape). The
"already imported?" check reads `meituan_order_import`, the server deducts,
and only THEN the import row is written. The server route has no key of its own
(the order_no is random). If the daemon dies or the fetch times out between
the deduction and the insert, the next poll ingests the order again: second
order, second deduction. Low probability per order, but it is the only
idempotency the platform path has, and it is on the wrong side of the write.

Related, same path: the order insert is one transaction but the deduction loop
runs outside it. A throw on line N (SQLITE_BUSY from a daemon holding the file
is the realistic one) leaves lines 1..N−1 off the shelf, the import row marked
`error` with no order link, and every later cancel answering `not_mirrored`
— so that stock can never come back by itself.

### 6. RISK — transfer quantities are REAL and never rounded

`routes/restock.js` 691, 777, 2161, 2216. A picker can type `2.5`; the shelf
goes 10 → 7.5 and every integer reader downstream sees a fraction. Purchase
receiving rounds (`retail-purchasing.js` 287-292); the transfer path does not.
Production has the same hole (`positiveNumber` accepts 20.5) while waste refuses
fractions.

### 7. RISK — a transfer with SOME unlinked lines ships the rest and says nothing

`routes/restock.js` 623-658. The §200 refusal fires only when NO line carries a
`product_id`. One bad line in three: two move, the order goes in transit, the
receipt never asks about the third, and the asker's screen marks all three
arrived.

### 8. RISK — quick-stock "+N" accepts a non-number as a silent success

`routes/retail-inventory.js` 537-561: `parseInt("1O") → NaN → 0`, no adjust,
`success: true`. The kitchen believes the batch was recorded. `reason` is also
client-supplied on this path, where the recount path refuses that.

### 9. RISK — a stock increase on 备货 of a split order takes the fresh line early

Known and documented (§58 addendum: "a whole-order caller takes everything")
but worth restating because it is the one place §58 is still routinely broken
in practice: pressing Start preparing to pack the land box of a split order
takes the air box's fresh food off the count that day. The parcel-level prepare
and dispatch routes are correct; the whole-order PATCH is the backstop and is
also the button people press.

### Small things, for the record

- `routes/retail-waste.js` void (800-873): the "already voided" check and the
  UPDATE carry no state guard. Safe today because one process, one connection,
  fully synchronous. An `await` inserted before the transaction would allow two
  reversals.
- Platform cancel restock (`meituan-internal.js` 895-909, Eleme twin) restores
  per line and sets `channel_stock_restored` after the loop; a throw mid-loop
  lets the next poll restore the first lines again. Uses an absolute figure read
  outside `adjustStock`'s transaction, unlike the delta on arrival.
- Partial refunds from the platforms (部分退款) mark the order `refunded` and
  return no stock. Deliberate per the code comments, written down nowhere.
- `commitUnreservedOrder`'s platform guard names `meituan` and `eleme`; the
  cancel lists name `gzgrocery` too. Nothing moves a gzgrocery mirror forward
  today, so no live double, but one guard short.
- Transfer dispatch and receipt are not store-scoped for a scoped operator.
- PO-receive ledger rows carry no `ref_table`/`ref_id` (string match on note).
- Stale comments say `adjustStock` clamps at zero: `lib/waste-record.js` 109,
  `retail-purchasing.js` 233 and 510, `channel-line-report.js` 117 (`已按 0 计`).
- Doc drift: §39's "four self-clamps" is now two (gzgrocery, Guanyi); §84's
  gzgrocery premise is false; the "restock warehouse override has never worked"
  item (~2041) is closed in code and still marked OPEN.
- The end-of-day auto-settle sweep for uncounted transfers (§39 ruling 2) is
  not built; `auto_settled_at` exists and nothing writes it. An abandoned count
  stays in transit forever, carried only by `inTransitByProduct`.

## What was checked and is right

- **Pre-orders.** Checkout park (§80/§128), operator park (§136), release on
  restock, the §187 "already in a box" exemption, the §478 ship-day take, the
  §58 fresh hold-back at payment and on parcel dispatch/prepare: all per-product
  idempotent through `order%` ledger rows and live holds, and every forward path
  out of `paid` (PATCH, parcel prepare/dispatch, JD waybill, rider pickup, both
  auto-deliver sweeps) commits. A parked order cannot be refunded (status
  guard), only cancelled, so the refunded-while-parked case cannot arise. The
  §478 take honours `refunded_qty`, skips bundles, never goes negative, and
  oldest promise wins.
- **Waste.** Every write is one transaction (row + movement + link); refuses
  below zero before calling `adjustStock`; §281 kept-line costing; void returns
  exactly once with a ledger row and fires channel sync; re-pricing (§465)
  touches no stock; §462 used-for-making goes through the same door and stays
  out of loss totals; units are whole each; tenancy on `tdb()` throughout.
- **QR and till.** §460 take-on-submit, every unpaid cancel (customer, admin,
  counter clock, reservation expiry) returns both the hold and the committed
  take; §461 held bill never drives a shelf below zero and nets to zero at
  payment; §137 counter miscount correction writes two rows and alerts.
- **Transfers.** Dispatch once (three guards, one transaction, `ref_table`
  `restock_orders`), receipt once at the counted figure, zero counted moves
  nothing, lines frozen after dispatch, §445 SKU check at both ends.
- **Purchase receiving.** Corrections apply the difference (receive 10, edit to
  8 → −2); returns refuse below zero; undo refuses rather than clamps.
- **Adjustments.** No floor (§39 rulings 1 and 7); negative visible on the
  dashboard; delta path refuses negatives; recount is server-labelled.
- **Hooks are store-scoped.** A warehouse add cannot release an order parked at
  a shop. No raw `physical_qty` write exists outside `lib/inventory.js`.
- **Platform single-deduct.** The `platform_deducted` guard covers all thirteen
  `prepareCommitUnreservedOrder` call sites; replacements still commit;
  born-void orders start restored; the #1162 dropped-rider fix holds.

## Recommendation

Fix 1 first. It is a one-line change with a proof already written, it touches
every out-of-city refund, and the ledger will show how much stock is sitting
wrong today (`order_prepare` rows on cancelled/refunded orders with no matching
`order_reverse%`). Then 2 and 4 together (both are "the order's stock" and both
one pass). 3 is its own PR and needs a line in §84 correcting the premise. 5-8
are each a small refusal and can ride one PR. 9 needs Ash to say whether the
whole-order Start preparing should also respect parcels; nothing else here
needs a decision.
