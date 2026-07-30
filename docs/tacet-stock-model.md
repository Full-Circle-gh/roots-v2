# Tacet stock model — how the store side actually behaves

**2026-07-30 · Read-only behavioural survey of `retail_store_stock`, `retail_stock_reservations`, `retail_stock_ledger` and `lib/inventory.js`, written before this model is adopted as the shared core. Every claim is cited to a file and line. Where the code does not settle a question the entry says UNVERIFIED and why. No row data was read. No file was changed except this one.**

Terms used below, one line each:

- **Physical** — the count of units believed to be on the shelf at one store.
- **Available / sellable** — how many a shopper may buy right now, after holdbacks.
- **Reservation (soft-reserve)** — a temporary hold on stock while an order waits to be paid. It does not change the physical count.
- **Commit** — turning a hold into a real decrement of the physical count.
- **Ledger** — an append-only history table; one row per movement, never updated.
- **Edge-triggered** — something that only reacts to a change event. If it misses the event, nothing retries.
- **Level-triggered** — something that periodically compares two states and fixes the difference regardless of what happened.

---

## Summary — is the store model internally consistent?

**No.** The core is sound and worth adopting: one row per (store, product), one ledger, one availability function, and every multi-step movement runs inside a database transaction. But the *edges* disagree with the core in ways that matter, and several of them are silent.

The single biggest issue: **there are two different answers to "how many can we sell", and the shopper sees the looser one.** The checkout gate subtracts the safety buffer and outstanding holds; the product list the shopper browses does not — it shows a raw sum of physical counts.

Every inconsistency found, most damaging first:

1. **Two availability formulas.** The catalogue/storefront `stock` figure is a raw `SUM(physical_qty)` across active stores (`routes/retail.js:902-908`), while the checkout gate uses `physical − safety_buffer − active holds` (`lib/inventory.js:163-188`). A shopper can be shown stock the checkout will refuse. §3.
2. **`safety_buffer` is applied to nothing except the mini-app/web availability check.** It is documented as "held back from any channel" (`database.js:2588`), but all three outbound channel queues push the raw `physical_qty` (`lib/meituan-bundles.js:76-82`, `lib/guanyi-sync.js:21-27`, `lib/eleme-sync.js:29-35`). Meituan/Eleme/Guanyi are told the un-buffered number. §1, §7.
3. **`meituan_quota` is dead.** Every caller of `getAvailable` passes `'wechat'` (grep, §3), so the Meituan branch at `lib/inventory.js:176` never executes. The column is stored, editable in the admin UI (`routes/retail-inventory.js:342`), and read by no decision. §1.
4. **Negative stock is handled three different ways.** Order commit has no floor and can drive a row below zero (`lib/inventory.js:476`, `523`); `adjustStock`'s delta path floors at 0 and silently loses the shortfall (`lib/inventory.js:712`); channel ingest clamps at 0 outside the transaction (`routes/meituan-internal.js:226`). §6.
5. **Writes to stock that produce no ledger row.** `upsertStockLayer` changes the sellable quantity (buffer/quotas) and writes nothing to the ledger, and creates rows with no audit trail (`lib/inventory.js:751-775`). Two migrations insert physical counts directly (`database.js:3234`, `3284`). §4.
6. **A committed order against a missing stock row writes a ledger entry for a movement that never happened** — the `UPDATE` matches no row, and `balance_after` is recorded as 0 (`lib/inventory.js:476-488`, `523-534`). §6.
7. **The restock transfer between stores is two separate transactions**, not one. A failure between them removes units from the warehouse without adding them to the destination (`routes/restock.js:237-247`). §5.
8. **A manual/walk-in order with no store attached never decrements stock, and nothing flags it.** `commitUnreservedOrder` returns `skipped: 'no_store'` (`lib/inventory.js:510`), and `isStockPending` ignores the `manual` channel (`lib/inventory.js:557`). Store is optional on that endpoint (`routes/retail.js:18999-19008`). §4.
9. **Only Meituan has a backstop for a failed outbound sync.** `lib/meituan-drift-sweep.js` re-compares and re-queues; Guanyi and Eleme are edge-triggered only, so a terminal error freezes that channel's stock until a human notices. §7.
10. **Read-then-write outside the transaction** in the channel ingest paths and the kitchen product page: the current quantity is read, then an absolute new value is written (`routes/meituan-internal.js:219-227`, `routes/eleme-internal.js:119-121`, `routes/products.js:579-604`). A concurrent order commit in between is overwritten. §5.
11. **`safety_buffer` carries two unrelated meanings.** Availability holdback in `lib/inventory.js:173`, and reorder point in purchasing, where a zero buffer silently becomes 5 (`routes/retail-purchasing.js:628`, `public/retail-admin/16-purchasing.js:505`). §1.
12. **Reservation expiry is enforced only by a timer, never lazily on read.** `sumActiveReservations` filters on `status = 'active'` and ignores `expires_at` (`lib/inventory.js:146-158`), so an expired hold keeps blocking stock until the sweep runs. §2.
13. **The `channel` recorded on holds and ledger rows is not the order's real channel.** Checkout hardcodes `'wechat'` even for web-shop orders (`routes/retail.js:9542`), and `commitUnreservedOrder` hardcodes `'wechat'` in the ledger (`lib/inventory.js:528`). §2, §4.
14. **A kitchen-side id is used as a store-side id.** `routes/products.js:573` validates the product against the kitchen `products` table, then writes store stock keyed on `store_products` ids. Correct only for rows the original fork seeded. §8.

One stale comment worth deleting during the merge: `routes/markets.js:148` points readers to `restock.js _applyDeliveryToStock` for automatic market-stock increments. That function does not exist anywhere in the repo (grep). Nothing has ever auto-incremented `market_stock`.

---

## 1. The stock record

`retail_store_stock` is defined at `database.js:2583-2597`, plus one column added later.

One row per (store, product). `UNIQUE(store_id, product_id)` at `database.js:2592` is what makes it one record per item per location.

| Column | Defined | What it means in current code | Written by |
|---|---|---|---|
| `id` | `database.js:2584` | Surrogate key. Never used as a reference by any other table — the ledger and reservations key on `(store_id, product_id)` instead. | auto |
| `store_id` | `2585` | Which store's shelf. FK → `retail_stores(id)`, cascade delete. | inserts below |
| `product_id` | `2586` | Which product. FK text says `products(id)` (`2594`) but the live constraint was repointed to `store_products(id)` by migration `store_products_seed_fk_v1` (`database.js:3805-3823`). Reading the schema here gives the wrong answer. | inserts below |
| `physical_qty` | `2587` | Units believed to be on the shelf. The only quantity any decrement or increment touches. | `lib/inventory.js:476`, `523`, `603`, `647`, `716`, `720`, `758`, `1322`; migrations `database.js:3234`, `3284` |
| `safety_buffer` | `2588` | Units held back from the availability calculation. Default 0. | `lib/inventory.js:772` via `upsertStockLayer` only |
| `wechat_quota` | `2589` | Optional per-channel cap for mini-app/web sales. `NULL` = no cap. | `lib/inventory.js:772` only |
| `meituan_quota` | `2590` | Intended as the same cap for Meituan. Never read by any live path (see below). | `lib/inventory.js:772` only |
| `updated_at` | `2591` | Touched by every physical write and every layer write. Not read by any decision; surfaced to the admin at `routes/retail-inventory.js:356`. | same writers |
| `restock_target` | `database.js:2894` (`addColumn`) | A target shelf level for restocking. Display and planning only — read at `routes/retail-inventory.js:197`, `211` and `routes/products.js:541`, written at `lib/inventory.js:772`. **It does not affect availability, alerts, or any automatic reorder.** | `lib/inventory.js:772` only |

### The arithmetic that decides what a shopper may buy

One function: `getAvailable(storeId, productId, channel, ignoreOrderIds)` — `lib/inventory.js:163-188`.

```
allReserved     = Σ qty of reservations for this (store, product) with status='active'      [line 171]
chanReserved    = the same sum, narrowed to this channel                                     [line 172]
globalRemaining = max(0, physical_qty − safety_buffer − allReserved)                         [line 173]
chanRemaining   = quota is NULL ? infinity : max(0, quota − chanReserved)                    [lines 175-177]
available       = max(0, min(globalRemaining, chanRemaining))                                [line 180]
```

Where `quota` is `meituan_quota` when the channel is `'meituan'`, `wechat_quota` when it is `'wechat'`, and `NULL` (no cap) for anything else — `lib/inventory.js:176`.

Two things this means in practice:

- **`safety_buffer` only bites here.** It is subtracted from the availability answer and from nothing else. It is not subtracted from the number pushed to Meituan, Eleme or Guanyi (§7), and not from the number the shopper sees in the product list (§3).
- **`meituan_quota` never bites at all.** Every call site passes `'wechat'` — `routes/retail-inventory.js:207`, `269`; `routes/retail.js:8935`, `9169`, `9172`; and the internal calls at `lib/inventory.js:342`, `442`, `1141`, `1265`, `1306` inherit `'wechat'` from their callers or default to it (`lib/inventory.js:163`). The only order path that reserves passes `channel: 'wechat'` explicitly (`routes/retail.js:9542`), including for web-shop orders. Meituan orders never reserve at all — they decrement directly (§4) — so `chanReserved` for Meituan would be 0 even if someone did pass `'meituan'`.

`ignoreOrderIds` (`lib/inventory.js:146-157`) drops one customer's own unpaid holds from both sums, so their abandoned pending order does not make their next attempt read as out of stock.

`safety_buffer` also has a **second, unrelated meaning** in purchasing, where it is read as a reorder point and a zero is silently replaced by 5: `routes/retail-purchasing.js:628` and the same rule client-side at `public/retail-admin/16-purchasing.js:505`. Same column, two meanings, no shared constant.

---

## 2. Reservations

Table at `database.js:2599-2618`. Columns: `store_id`, `product_id`, `order_id` (nullable), `qty`, `channel`, `status`, `expires_at`, `created_at`, `committed_at`, `released_at`, `note`.

**What creates one.** Only two places insert into this table (repo-wide grep):

1. `reserveForOrder` — `lib/inventory.js:427-462`. Called from exactly one checkout path, `routes/retail.js:9538`, and once more when an add-on is appended to an existing order (`routes/retail.js:26624`). It runs inside a transaction: for each line it re-checks `getAvailable`, throws `product_not_stocked_here` if no stock row exists (`:443`) or `insufficient_stock` if short (`:449`), then inserts a row with `status='active'` and an expiry of now + TTL. TTL comes from `storefront_config['inventory.reservationTtlMinutes']`, defaulting to **15 minutes** (`lib/inventory.js:29`, `73-82`).
2. `checkAwaitingRestockForRestock` — `lib/inventory.js:1314-1319`. Inserts rows already marked `'committed'`, deliberately, so the expiry sweeper ignores them.

Checkout **skips** reserving in two cases (`routes/retail.js:9530-9537`): the "wait for restock" flow, and whenever the stock gate is off — which is out-of-Guangzhou addresses and Guangzhou orders scheduled for a later day (`lib/inventory.js:930`, `requiresStockGate`).

The `order_id` column is nullable and the schema comment calls it "nullable for pre-order holds" (`database.js:2603`), but **no code ever creates a hold without an order** — both insert sites pass an order id. The pre-order case is unbuilt.

**What releases one.** `releaseOrderReservations` — `lib/inventory.js:566-581`. Flips every `active` row for the order to `'released'` (or `'expired'` when the caller says so) and stamps `released_at`. `physical_qty` is untouched, because an active hold never changed it. Idempotent. Called on customer cancel (`routes/retail.js:16629`), admin cancel (`:22949`), auto-cancel of unpaid orders (`:6909`), and when a new order supersedes an old one (`:6962`).

**What converts one into a real decrement.** `commitOrderReservations` — `lib/inventory.js:467-497`. Inside one transaction, for each active hold: subtract `qty` from `physical_qty`, read the new balance, write a ledger row with reason `order_commit`, mark the hold `'committed'` with `committed_at`, and enqueue the channel sync. Called from `markOrderPaid` (`routes/retail.js:4335`) and from admin "mark paid" (`:22915`). Idempotent: no active rows means no work.

Reversal (refund, cancel after payment) does **not** re-activate holds. `reverseCommittedOrder` (`lib/inventory.js:586-622`) adds the quantity back and writes an `order_reverse` ledger row; the reservation rows stay `'committed'` for audit. Partial refunds use `reverseCommittedLines` with reason `order_reverse_partial` (`:628-673`) so a later full reverse can still run.

**What happens to an abandoned one — and how expiry is enforced.**

Expiry is enforced by a **timer**, in the main web process only. It is **not** enforced lazily on read, and not by any database mechanism.

- `sweepExpiredReservations` (`lib/inventory.js:780-814`) selects `status='active' AND expires_at <= CURRENT_TIMESTAMP`, marks each `'expired'` with `released_at`, then auto-cancels any order still in `pending_payment` whose holds just expired — setting `cancelled_reason = 'reservation_expired'` and cancelling the pending payment row.
- `startReservationSweeper` (`lib/inventory.js:832-862`) runs it 5 seconds after boot and then **every 60 seconds**, once for the main tenant and once inside each other active tenant's scope when data isolation is on.
- It is started from exactly one place: `server.js:863`. The Meituan, Eleme, Guanyi and gzgrocery daemon processes do not start it.

The consequence: `sumActiveReservations` filters on `status = 'active'` only and never looks at `expires_at` (`lib/inventory.js:146-150`). **An expired-but-not-yet-swept hold still blocks stock** — for up to about a minute, longer if the sweep throws. Nothing anywhere treats an expired hold as free on read.

---

## 3. Available vs physical — every place the code answers "how many can be sold"

There are **two distinct formulas**, and they are used by different audiences.

### Variant A — the real gate (buffer and holds applied)

`getAvailable`, `lib/inventory.js:163-188`, formula as printed in §1. Used by:

- `reserveForOrder` — the checkout gate itself (`lib/inventory.js:442`).
- `routeOrder` — deciding which store can fulfil (`lib/inventory.js:342`).
- `analyzeShortage` — the shortage/substitute flow (`lib/inventory.js:1141`).
- `substitutesForProduct` (`:1265`) and `checkAwaitingRestockForRestock` (`:1306`).
- The admin inventory grid and per-store stock list, as `available_wechat` (`routes/retail-inventory.js:207`, `269`).
- The shortage and substitute endpoints (`routes/retail.js:8935`, `9169`, `9172`).

### Variant B — what the shopper is shown (raw physical, nothing applied)

The `stock` value on every catalogue and storefront read is a plain sum:

```sql
COALESCE(
  (SELECT SUM(rss.physical_qty)
     FROM retail_store_stock rss
     JOIN retail_stores rs ON rs.id = rss.store_id
    WHERE rss.product_id = p.id AND rs.is_active = 1),
  p.stock_qty
) AS stock
```

`routes/retail.js:902-908` (`RETAIL_PRODUCT_COLS`, the shared column list for shopper-facing product reads), and the same shape again at `routes/retail.js:1285`, `2320`, `8719`, `18609`.

No safety buffer. No reservations. No per-channel quota. It also falls back to the legacy `store_products.stock_qty` column when a product has no per-store rows at all.

So a product with 10 physical, a safety buffer of 3, and 4 units held by unpaid orders displays as **10** in the shop and sells **3** at checkout.

### Variant C — the dashboard's "low stock" figure

`routes/retail.js:13342-13353`. Same raw-physical shape as Variant B, with two differences: scoped to one store when a store is picked, and a three-argument `COALESCE(..., p.stock_qty, 0)` so a missing row reads 0 rather than null. Buffer and holds are again not applied.

### Variant D — purchasing's "running low"

`routes/retail-purchasing.js:620-634`. Compares `physical_qty` against `safety_buffer`, substituting 5 when the buffer is 0 or unset. This is the only place `safety_buffer` is treated as a reorder point rather than a holdback.

### Variant E — what the outbound channels are told

`physical_qty` verbatim, no subtraction: `lib/meituan-bundles.js:76-82`, `lib/guanyi-sync.js:21-27`, `lib/eleme-sync.js:29-35`. See §7.

**Assessment.** Variant A is the correct model and should become the single formula. Variants B and C are the ones a customer and an operator actually look at, and they disagree with A by exactly `safety_buffer + active holds`. Variant E means the buffer protects the mini-app and nothing else, which is the reverse of what its schema comment claims it is for ("sync-delay protection", `lib/inventory.js:5`).

---

## 4. The ledger

`retail_stock_ledger`, `database.js:2620-2642`. Append-only in practice: no `UPDATE` or `DELETE` against it exists anywhere in the repo (grep).

Fields on each entry: `store_id`, `product_id`, `delta` (signed), `reason`, `ref_table`, `ref_id`, `balance_after` (the physical count after the movement), `actor_user_id`, `actor_label` (added at `database.js:2901`), `channel`, `note`, `created_at`.

`actor_user_id` is deliberately **not** a foreign key (`database.js:2635-2639`, migration `drop_ledger_actor_fk_v1` at `database.js:3955-4000`): the actor may be a kitchen `users` id or an operator `tenant_users` id, two id spaces in one integer column. `actor_label` was added so a row can still be attributed to a person by name.

**Every write to the ledger** — six insert sites, all inside `lib/inventory.js`:

| Reason | Where | Movement |
|---|---|---|
| `order_commit` | `:479-483` | Paid order deducts reserved stock |
| `order_prepare` | `:525-529` | Order that never reserved, deducted when staff first work it |
| `order_reverse` | `:605-609` | Full refund / cancel after payment |
| `order_reverse_partial` | `:649-653` | Line-level refund |
| `awaiting_restock_release` | `:1327-1331` | A parked order becomes fulfillable and takes its stock |
| caller-supplied `reason` | `:723-727` | Everything routed through `adjustStock` — admin edits, kitchen adds, purchase receipts, restock transfers, and all channel order ingest |

Because every route, daemon and script that moves physical stock goes through `adjustStock` (call map: `routes/products.js:597`, `routes/retail-inventory.js:323`, `331`, `routes/retail-purchasing.js:110`, `routes/restock.js:237`, `243`, `routes/meituan-internal.js:225`, `370`, `388`, `routes/eleme-internal.js:121`, `routes/guanyi-admin.js:358`, `scripts/guanyi-daemon.js:454`, `scripts/gzgrocery-order-daemon.js:342`, `369`, `scripts/repair_guanyi_false_pickup.js:50`), coverage of physical movement is genuinely good.

### Stock changes that bypass the ledger — findings

1. **`upsertStockLayer` — `lib/inventory.js:751-775`.** Changes `safety_buffer`, `wechat_quota`, `meituan_quota`, `restock_target` and writes **no ledger row**. Raising a safety buffer reduces what can be sold exactly as surely as removing units does, and leaves no trace of who did it or when — only `updated_at` moves. It also **creates a stock row** (`:757-759`) with no ledger entry. Reached from `routes/retail-inventory.js:349`.
2. **Migration seeds — `database.js:3234-3238` and `3284-3285`.** Both insert `physical_qty` directly from the legacy `products.stock_qty` column with no ledger rows, so the opening balance of every row has no history. One-shot and guarded by `_migrations`, so this is a historical gap rather than a live leak, but it means `SUM(delta)` will never reconstruct `physical_qty`.
3. **Ledger entries for movements that did not happen.** In `commitOrderReservations` (`:476-488`) and `commitUnreservedOrder` (`:523-534`) the `UPDATE` is issued without checking that it matched a row. If no stock row exists for the pair, the update changes nothing, `getBal` returns undefined, and `?? 0` records `balance_after = 0` alongside a negative `delta`. The ledger then asserts a decrement that never occurred. The reserve path guards against this (`:443`), so it is reachable mainly through `commitUnreservedOrder`, which has no such check.
4. **A manual/walk-in order with no store never decrements — and nothing reports it.** `commitUnreservedOrder` returns `{ skipped: 'no_store' }` when the order has no `store_id` (`lib/inventory.js:509-510`). The manual-order endpoint makes store optional (`routes/retail.js:18999-19008`). And `isStockPending` — the flag that tells staff an order's stock has not been taken yet — returns false for any channel other than `wechat`/`web` (`lib/inventory.js:557`), so a `manual` order is never flagged. Units leave the building with no decrement and no warning.
5. **Reservation lifecycle changes are not ledgered.** Creating, releasing or expiring a hold writes nothing to the ledger — by design, since physical stock does not move. Worth stating explicitly because "available" changes at those moments and the ledger cannot explain why.
6. **`channel` on ledger rows is not always the real channel.** `commitUnreservedOrder` hardcodes `'wechat'` (`lib/inventory.js:528`) whatever the order's actual channel, and `adjustStock` never sets `channel` at all (`:723-727`) — it is left NULL for every admin edit, purchase receipt, restock transfer and channel ingest. The activity view compensates by deriving a source from the `reason` text instead (`routes/retail.js:12712-12719`), which works but means `channel` is unreliable as a field.

Outside this ledger entirely: `products.stock_qty` (no history table at all) and `market_stock` (its own `market_stock_ledger`, `routes/markets.js:209-213`). See §8.

---

## 5. `adjustStock` and `upsertStockLayer`

### `adjustStock` — `lib/inventory.js:706-749`

Parameters: `storeId`, `productId`, `newPhysicalQty`, `deltaQty` (default null), `actorUserId`, `actorLabel`, `note`, `reason` (default `'adjust'`).

Two modes. Pass `newPhysicalQty` to set an absolute count (a recount). Pass `deltaQty` to move relative to whatever is there now.

Order of operations, all inside one `tdb().transaction()` (`:707`):

1. Read the current `physical_qty`; treat a missing row as 0 (`:708-711`).
2. If `deltaQty` was given, compute the target **inside the transaction**: `max(0, oldQty + deltaQty)` (`:712`). This is the lost-update-safe path — the caller never reads first.
3. Compute `delta = newPhysicalQty − oldQty` (`:713`).
4. `UPDATE` the row if it existed, otherwise `INSERT` it (`:714-722`). **A missing row is created here.**
5. Insert the ledger row with `ref_table = 'retail_store_stock'`, `ref_id = NULL`, `balance_after = newPhysicalQty` (`:723-727`).
6. Call `enqueueChannelSync` (`:728`) — still inside the transaction.

After the transaction commits: a coalesced live-update nudge if the delta was non-zero (`:732`), and if stock went **up**, a check for parked `awaiting_restock` orders that can now be fulfilled, plus a best-effort callback for their post-payment side effects (`:736-747`). Both are wrapped in `try/catch` and cannot fail the write.

**Transactional?** Yes for the stock row, the ledger row and the queue insert — better-sqlite3 transactions are synchronous and serialised, so a concurrent order commit cannot interleave. On any throw inside, all three roll back together.

**Partial failure.** The dangerous cases are all *outside* the transaction:

- **The restock transfer is not atomic.** `routes/restock.js:237-247` calls `adjustStock` twice — once negative at the warehouse, once positive at the destination — as **two independent transactions**. If the second throws, the first has already committed: units are gone from the warehouse and never arrived. The surrounding `try` only logs a warning (`routes/restock.js:254`), and `stock_applied_at` is stamped regardless of how many lines moved (`:250`), so the order is never re-evaluated. A half-applied transfer is permanent and silent.
- **Purchase receiving updates its bookkeeping outside the transaction.** `routes/retail-purchasing.js:110-117` adjusts stock, then separately writes `po_line_items.stock_applied_qty` (`:118`). A failure between them re-applies the same units on the next save.
- **Channel ingest reads before writing.** `routes/meituan-internal.js:219-227`, `routes/eleme-internal.js:119-121` and `routes/products.js:579-604` all read the current quantity, compute an absolute value in JavaScript, then pass `newPhysicalQty`. Anything that commits in between is overwritten — precisely the race the `deltaQty` path exists to avoid (`lib/inventory.js:678-681`).
- `enqueueChannelSync` swallows its own errors per channel (`lib/inventory.js:43-64`), so a channel fault never aborts the stock write. That is the right call, and it is why §7's failure modes matter.

### `upsertStockLayer` — `lib/inventory.js:751-775`

Parameters: `storeId`, `productId`, `fields`, `actorUserId`.

`fields` is filtered against an allow-list of four columns: `safety_buffer`, `wechat_quota`, `meituan_quota`, `restock_target` (`:752`).

1. Look for an existing row; if absent, `INSERT` one with `physical_qty = 0` (`:753-760`).
2. Build a `SET` clause from whichever allowed keys are present (`:761-769`).
3. `UPDATE` the row, touching `updated_at` (`:771-773`).

**Not transactional.** There is no `transaction()` wrapper — the insert and the update are two separate statements. If the update fails after the insert, a stock row exists at 0 with none of the intended layer values, and no ledger row was written either way.

**`actorUserId` is accepted and never used.** It appears in the signature (`:751`) and nowhere in the body. The write is unattributable.

**No ledger row, ever** — see §4, finding 1.

---

## 6. Negative and missing

### Below zero

There is **no** database constraint preventing a negative `physical_qty` (`database.js:2587` — a plain `INTEGER NOT NULL DEFAULT 0`). Behaviour depends entirely on which path writes:

| Path | Behaviour below zero |
|---|---|
| `commitOrderReservations` (`lib/inventory.js:476`) | `physical_qty = physical_qty - ?` with **no floor**. Can go negative. |
| `commitUnreservedOrder` (`:523`) | Same, no floor. Can go negative. |
| `checkAwaitingRestockForRestock` (`:1322`) | Same, no floor — though it pre-checks that every line is fully covered (`:1305-1308`). |
| `adjustStock` delta path (`:712`) | Floors at `max(0, oldQty + deltaQty)`. **The shortfall is silently discarded** — asking to remove 5 from a shelf of 3 removes 3 and records a delta of −3, with no signal that 2 were unaccounted for. |
| `adjustStock` absolute path | Whatever the caller passes; `routes/products.js:586` and `routes/retail-inventory.js:330` reject negatives at the API edge. |
| Channel ingest (`routes/meituan-internal.js:226`) | Clamps at `max(0, oldQ - qty)` and **separately records the oversell** in an `oversold` list (`:224`) rather than letting it vanish — the best-behaved of the group. |
| Guanyi pickup daemon (`scripts/guanyi-daemon.js:448-459`) | Clamps at 0, logs `CLAMPED at 0`, and refuses to apply a drop larger than a cap (`:442-444`). |

In practice the commit paths are protected upstream: `reserveForOrder` refuses to hold more than is available, so a normal mini-app order cannot drive a row negative. The exposure is `commitUnreservedOrder`, which performs **no availability check at all** before decrementing — out-of-Guangzhou and scheduled orders take their stock whether or not it is there.

One caller opts out of that refusal by design. `reserveForOrder({ allowPartial: true })` judges each line on its own, reserves what the store can cover, and returns the remainder in `shortages` instead of throwing. Only the paid add-on path (`finalizeOrderAddon`) uses it, because it runs *after* the WeChat charge and cannot refuse the sale — and the all-or-nothing throw was worse there than a partial: its transaction rolled back **every** line in the batch, so one short item silently skipped the deduction for all the others too. Availability for an add-on is gated before the charge instead, in `POST /orders/:id/addon/create`, which is the point where refusing is still free. `allowPartial` never floors a row below zero (it reserves at most what is available); the residual short is reported to WeCom and logged, not absorbed.

So: three different policies (go negative, clamp and forget, clamp and report) in one model. Any merged core needs to pick one, and "clamp and report" is the only one that does not lose information.

### Missing rows

A missing `(store, product)` row is **read as zero, not created on read**:

- `getAvailable` returns `{ available: 0, exists: false, physical: 0 }` and does not insert (`lib/inventory.js:169`). The `exists` flag is what lets `reserveForOrder` say `product_not_stocked_here` (`:443`) rather than `insufficient_stock`.
- The admin grid renders a missing row as an editable 0 (`routes/retail-inventory.js:206`, `214` — `stocked: !!row`), and the per-store list `LEFT JOIN`s with `COALESCE(..., 0)` (`:247`).
- The storefront `stock` column falls back to the legacy `store_products.stock_qty` when *no* store has a row (`routes/retail.js:902-908`).

Rows are created on demand by exactly two functions: `adjustStock` (`lib/inventory.js:718-722`, with the real quantity) and `upsertStockLayer` (`:756-760`, at quantity 0). This was a deliberate choice — the Yuexiu store was added without pre-seeding 269 zero rows (`database.js:3247-3252`).

The gap is the one in §4: the two commit paths decrement without checking `exists`, so they can write a ledger row against a pair that has no stock record at all.

---

## 7. Channel sync

### What triggers it

`enqueueChannelSync(storeId, productId)` — `lib/inventory.js:67-71` — fans out to three per-channel enqueue functions, each wrapped in its own `try/catch` so one channel's fault cannot block another (`:43-64`).

It is called from **every** physical movement: `adjustStock` (`:728`), `commitOrderReservations` (`:490`), `commitUnreservedOrder` (`:535`), `reverseCommittedOrder` (`:615`), `reverseCommittedLines` (`:664`), and `checkAwaitingRestockForRestock` (`:1332`). So sale-driven depletion is pushed outward, not just operator edits.

### What is queued

Each channel checks for an enabled mapping row for that (store, product), and if present inserts one queue row containing the **current `physical_qty`**:

- Meituan — `lib/meituan-bundles.js:70-86`, into `meituan_sync_queue`, plus any bundle the product is a component of (`:84`).
- Guanyi — `lib/guanyi-sync.js:15-29`, into `guanyi_sync_queue`.
- Eleme — `lib/eleme-sync.js:22-37`, into `eleme_sync_queue`, gated on a tenant switch (`:24`).

All three read `COALESCE(physical_qty, 0)`. **None subtracts `safety_buffer`, and none subtracts active reservations.** The marketplaces are told the raw shelf count, so the buffer that is supposed to protect against sync delay protects only the mini-app.

Unmapped products enqueue nothing at all — the sync is opt-in per product per store.

### What happens when the outbound push fails

**Local stock stays correct.** This is the model's strongest property. The queues are strictly outbound mirrors: no daemon writes back into `retail_store_stock` from a channel's reported quantity. A failed push means the marketplace is stale, never that our own number is wrong.

The daemons drain with retry and coalescing (Meituan shown; Eleme and Guanyi follow the same shape):

- Rows are picked up while `status='pending' AND attempts < 3` (`scripts/meituan-daemon.js:598`).
- Multiple queued rows for the same target collapse to the newest; older ones are retired as `superseded` (`:632-639`). Intermediate values are never replayed.
- Pushes are suppressed — rows left pending — while the store is closed, in a verification cool-down, or its session binding is suspected lost (`:614-621`).
- Transient failures go back to `pending` (`:717`); a lost binding goes back to pending *without* burning an attempt (`:708`); a terminal failure lands in `status='error'` (`:723`).

**The failure mode that matters:** a row in `status='error'` is never re-read by the queue. Meituan has a fix — `lib/meituan-drift-sweep.js` is a level-triggered partner that compares live `physical_qty` against the last quantity the channel accepted and re-enqueues the difference regardless of why the earlier push died, with a per-target cool-down, a per-sweep cap, and a latched alert for anything drifting past 24 hours (`lib/meituan-drift-sweep.js:19-41`). Its header records the incident that prompted it: 13 products drifting at one store, 502 error rows, zero pending.

**Guanyi and Eleme have no equivalent.** `ls lib/*drift*` returns only the Meituan sweep. Both daemons write terminal errors the same way (`scripts/guanyi-daemon.js:121`, `166`, `205`, `252`; `scripts/eleme-daemon.js:362`) and nothing ever revisits those rows. A permanently-failed push freezes that channel's stock for that product until a human spots it.

---

## 8. The two kitchen stores being retired

### `products.stock_qty`

**Writers — one.** `routes/products.js:642`, the `POST /api/products/:id/stock-adjust` endpoint. That is the only `UPDATE ... SET stock_qty` against the kitchen `products` table in the repo (grep across `routes/`, `lib/`, `scripts/`, `database.js`; matches on `store_products.stock_qty` excluded). It has no history table of its own — the endpoint's own comment says the column stores no history, so `activity_log` is the trail (`routes/products.js:620-622`).

**Is it still surfaced to a user? Yes, in several places.**

| Screen / endpoint | Where | What it shows |
|---|---|---|
| Kitchen Products list — Stock column, sortable, red under 5 | `public/app.html:8525`, `8530`, `8544`, `9281-9282` | the column directly |
| Kitchen Products list — inline stock edit | `public/app.html:13315`, `13323` | writes via the endpoint above |
| Kitchen dashboard / alert card | `public/app.html:23694`, `26592` | "only N left" |
| POS product search + top-sellers | `public/pos.html:1366`, `1449` | per-line stock figure |
| Alerts counts (out of stock, low stock) | `routes/alerts.js:48-49` | counts over the column |
| AI assistant tools and prompts | `routes/ai.js:2196-2202`, `2255-2259`, `2516`, `2588-2593`, and the descriptive prompts at `955`, `981`, `1214`, `1292`, `1345-1346`, `1584` | lists and answers "what's out of stock" |
| Storefront fallback | `routes/retail.js:907`, `13353`, `18609` | the `COALESCE` fallback when a product has **no** per-store rows — this reads `store_products.stock_qty`, not the kitchen column |

**Breakage if removed:** the kitchen Products list Stock column and its sort, the inline stock editor and its endpoint, the kitchen low-stock alert card, the POS stock display, both counts in `routes/alerts.js`, and roughly a dozen AI tool queries and prompt passages. The storefront fallback is a separate column on `store_products` and is unaffected by removing the kitchen one — but it is the same name, and a careless sweep would take both.

### `market_stock`

**Writers — one.** `routes/markets.js:201-208`, the manual `POST /api/markets/:id/stock/adjust` endpoint, which writes the row and a `market_stock_ledger` entry in one transaction (`:201-214`). Repo-wide grep for `market_stock` returns hits in `routes/markets.js` only.

Two consequences worth stating plainly:

- **Nothing decrements it when goods are sold.** The POS checkout path does not touch it.
- **Nothing increments it when a restock arrives.** `routes/markets.js:148` tells the reader that automatic increments happen "when a restock order is delivered (see routes/restock.js `_applyDeliveryToStock`)". **That function does not exist** — grep finds only the comment and `_applyRestockTransfer`, which writes `retail_store_stock`, not `market_stock` (`routes/restock.js:206-256`). The comment is stale and describes behaviour that was never built or was removed.

So the number only ever moves when an admin types into it. **UNVERIFIED:** how far live `market_stock` values have drifted from physical reality — that needs the production database, which is gitignored.

**Is it still surfaced? Yes, one screen.** The per-market stock overlay in the kitchen app: list at `public/app.html:18098`, save at `:18178`, movement history at `:18193`. Server side, three endpoints: `GET /api/markets/:id/stock` (`routes/markets.js:149`), `POST /api/markets/:id/stock/adjust` (`:177`), `GET /api/markets/:id/stock/ledger` (`:223`). All three are admin-only.

**Breakage if both are removed:** the market stock overlay and its three endpoints, plus everything listed in the `products.stock_qty` table above. Nothing in the store side, the storefront, the mini-app, or any channel daemon reads either one — the only cross-over is the historical migration seed that copied `products.stock_qty` into `retail_store_stock` once (`database.js:3229`, `3279`).

### One id-space hazard to carry into the merge

`routes/products.js:569-604` — the kitchen product page's per-store stock adjuster — validates the product id against the **kitchen** `products` table (`:573`), then hands that id to `adjustStock`, which writes `retail_store_stock` keyed on **`store_products`** ids. It is correct only for rows the original fork seeded with matching ids (`database.js:3830-3843`). The same hazard exists in the restock transfer, which reads `restock_items.product_id` (pointing at `products`) and passes it to the same function (`routes/restock.js:237-247`). Collapsing the two product tables removes this hazard entirely, which is one more reason the merge is worth doing.

---

## Verification notes

- Read in full: `lib/inventory.js`, `lib/guanyi-sync.js`, `lib/eleme-sync.js`, `lib/meituan-bundles.js` (enqueue paths), `lib/meituan-drift-sweep.js` (header and guards), `routes/retail-inventory.js` (stock endpoints), `routes/markets.js` (stock endpoints).
- Read in part: `database.js` (2554-2660, 2890-2905, 3218-3300, 3800-3860, 3950-4005), `routes/retail.js` (888-920, 1276-1370, 4328-4360, 8700-8740, 9490-9570, 12690-12730, 13316-13400, 18888-19115, 22220-22240, 22860-22990), `routes/products.js` (525-655), `routes/restock.js` (200-262), `routes/retail-purchasing.js` (95-125, 615-640), `routes/meituan-internal.js` (210-400), `routes/eleme-internal.js` (115-125), `scripts/meituan-daemon.js` (555-760), `scripts/guanyi-daemon.js` (110-260, 420-470), `scripts/eleme-daemon.js` (300-400), `public/app.html` (8520-8550, 13300-13330, 18040-18200), `public/pos.html` (1360-1455).
- Statements about "the only writer" / "every call site" come from repo-wide greps over `routes/ lib/ scripts/ public/ server.js database.js` for the table names, the exported function names, `getAvailable(`, `safety_buffer`, `stock_qty` and `market_stock`.
- Not verifiable from the repo, and therefore not asserted: live quantities, how many rows carry a non-zero `safety_buffer` or a non-null quota, actual drift in `market_stock`, and how often the negative-stock or missing-row paths have fired in production. All of those need the production database, which is gitignored.
