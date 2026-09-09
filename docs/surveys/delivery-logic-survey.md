# Survey — customer-facing delivery option logic

**Read-only survey. No code was changed.**

| | |
|---|---|
| **Commit surveyed** | `e12357c48d3939107477fd953495ee6710726f70` (= `origin/main` at the time of writing) |
| **Date** | 2026-09-09 |
| **Scope** | How a customer ends up with a delivery method and a delivery date, and where that breaks |
| **Method** | Live code read end to end. Where a comment, doc or config disagrees with the running code, both are reported and the executing one is named. |

> **Line numbers are historical coordinates.** Per `CLAUDE.md` → Citations, every `file:line`
> below is where the thing was found at the commit named above, not a claim about any later
> tree. Re-verify before use. Where a finding is a *pattern* rather than a single site, the
> grep that finds all of it is given.

> **Multi-tenant reading.** Roots' data shape today (two stores, one city, this product mix)
> is treated as one case, not as the definition. Findings marked **Hardcoded assumption**
> are ones that work only because of how Roots' data happens to look.

---

## Part 1 — Path map

### Stage 1 — Product classification

**There is no product "type". There is one boolean and one policy string, both on `store_products`.**

| Field | Where defined | What it means |
|---|---|---|
| `store_products.is_batch_made` | `database.js:3749-3755` (declared on `products`; mirrored onto `store_products` by the parity backfill at `database.js:5034`) | "Short-shelf-life items (fresh meals, wraps) the kitchen makes on a fixed every-N-days cadence." This is the **only** fresh/dry classifier the delivery path reads. |
| `store_products.oos_policy` | `database.js:5080-5090` | `'strict'` \| `'backorder_gz'` \| `'always'`. NULL falls back to `is_batch_made` for back-compat. |
| `store_products.ship_modes` | `database.js:3737` | CSV of `air` / `land`, or the exclusive token `local`. Default `'air,land'`. |
| `store_products.needs_ice_pack` | `database.js:3738` | Cold-chain **badge for the packer only** — explicitly *not* a routing input (`routes/retail.js:9351-9352`). |
| `store_products.ship_from_supplier` | `database.js:3740-3747` | Drop-ship; gets its own parcel. |

The resolver is `effectiveOosPolicy` (`routes/retail.js:1073-1083`):

```js
if (p && p.ship_from_supplier) return 'always';
const pol = (p && p.oos_policy) || '';
if (pol === 'always' || pol === 'backorder_gz' || pol === 'strict') return pol;
return (p && p.is_batch_made) ? 'backorder_gz' : 'strict';
```

**Where it is set.** Admin only, per product: the checkbox `pd-is-batch-made`
(`public/retail-admin/09-products.js:3017`, submitted at `:5689`) and the bulk action
"Mark fresh batch / 标记现做" (`:2135-2136`). It PATCHes
`/api/retail-admin/products/:id` (`routes/retail.js:21854`), which writes
**`UPDATE store_products`** (`routes/retail.js:22065`, `:22135`). There is no DB default
other than `0`, no seed list, and no hardcoded category list.

**Products in no class / more than one class.** Every product is in exactly one class,
because the class is a boolean with a default. That is the problem, not the reassurance:

- "Dry goods" is not a value. It is *the absence of* `is_batch_made`. A newly created
  product is dry by default and nothing ever asks the operator.
- `category` (`schema.sql:197`) and `recipes.shelf_life` (`schema.sql:104`) exist and are
  **never read** by any delivery code (`grep -n "shelf_life" routes/ lib/` returns
  nothing outside recipes).
- `is_batch_made` and `ship_modes='local'` are orthogonal and can be combined, giving four
  states the code handles unevenly — see **F16**.

**Two catalogues, one flag name, no sync.** `products` and `store_products` are separate
tables, forked, with the sync job **explicitly not built** (`database.js:4995-5001`:
"the sync job itself is NOT built yet"). The parity backfill at `database.js:5034` copies
the *column*, never the *value*. So `products.is_batch_made` — the flag the (now-retired,
HEAD commit `e12357c`) kitchen app wrote — has no path into the storefront. See **F18**.

---

### Stage 2 — Delivery method eligibility

There are **two independent axes**, and neither is derived from the product mix.

**Axis A — fulfilment type**, chosen by the customer, stored on the order.
`lib/fulfilment.js:18` — `['delivery', 'pickup', 'counter']`. Column default
`'delivery'` (`database.js:4047`).

**Axis B — how a delivery leaves**, derived from the *address* plus one client-supplied
field. `planShipments` (`routes/retail.js:9423-9461`) is the decision:

```js
if (isGuangzhou(destCity)) {
  const isShipDistrict = destDistrict &&
    inventory.isOptInSameDayDistrict({ city: destCity, district: destDistrict });
  if (!isShipDistrict || slotKind === 'today') {
    return [{ mode: 'local', … }];      // same-city rider
  }
  // ship-district, not same-day → fall through to courier
}
if (isGuangdong(destProvince, destCity)) return [{ mode: 'land', … }];
// else air/land split by bucketForItem
```

The rider rail itself is gated separately by `isQingyunSameCityToday`
(`lib/inventory.js:1609-1643`), called from `maybeEnqueueQingyunPush`
(`routes/retail.js:4746-4774`) on payment, and **re-read on every queue poll**
(`routes/retail.js:27450-27462`).

**Per product / per cart / per channel / per store / per region — the actual answer:**

| Dimension | Does it affect the offered method? |
|---|---|
| Per **region** | Yes — this is the primary axis (`matchDeliveryZone`, `planShipments`). |
| Per **channel** | Yes, but only as a *closure* filter (`channelClosedStores`, `lib/inventory.js:206-214`) and a rider allow-list (`QINGYUN_PUSH_CHANNELS = ['wechat','web']`, `:1591`). |
| Per **store** | Yes — a closed store is dropped before ranking; the out-of-city pin (`fulfillingStoreFor`, `routes/retail.js:31653-31672`) overrides proximity. |
| Per **product** | **Only** via `ship_modes` (`local` blocks out-of-GZ; `air`/`land` picks a bucket) and `ship_from_supplier` (own parcel). |
| Per **cart** | **No intersection is ever computed.** |

**Mixed cart (fresh meal + dry goods).** There is no per-product method negotiation at
all. What actually happens:

1. Method comes from the address, so both lines get the same method.
2. Date is a **single floor for the whole cart** — `earliestBatchMakeDate`
   (`routes/retail.js:31904-31905`): *"Zero sellable on ANY fresh line blocks the whole
   order: one promised date per order, so the cart moves together to the next batch it
   can all make."*
3. So the dry goods are **held back to the fresh item's batch date**, and nothing in the
   customer-facing copy says so. `computeBatchNotice`'s `items` array
   (`routes/retail.js:32167`) lists only the *fresh* items, so the notice names the wrap
   and stays silent about the rice that is now waiting three days for it.
4. `ship_from_supplier` lines are the one exception — split into their own parcel
   (`routes/retail.js:9561-9563`).

It does not "take the first product's" or "fail silently" — it takes the **maximum**
(latest) date across fresh lines and applies it to everything.

---

### Stage 3 — Date and time slot generation

The generator is `computeDeliverySlots(zone, now, opts)` — **`routes/retail.js:32437-32812`**.
Two consumers, and they are the same function by design:

- display: `POST /api/retail/checkout/quote` → `routes/retail.js:33899-33901`
- validate: `resolveDeliverySlot` → `routes/retail.js:32861-32919`, called from
  `POST /orders` at `routes/retail.js:10858-10860`

**Inputs, in the order they apply:**

| Input | Source | Line |
|---|---|---|
| `slot_start_hour` / `slot_end_hour` | zone row, else hardcoded `10` / `20` | `32457-32471` |
| `slot_duration_minutes` | zone row, else `120` | `32464` |
| `min_lead_days` / `max_lead_days` | zone row, else `0` / `14` | `32460-32461` |
| `same_day_allowed`, `same_day_surcharge`, `day_only` | zone row | `32458-32465` |
| Holiday mode | `storefront_config['delivery.holidayMode']` | `32476-32480` |
| Same-day cutoff buffer | `storefront_config['delivery.sameDayCutoffMinutes']`, default `10` | `32522-32534` |
| Fresh-batch floor (courier) | `opts.batch` → `earliestBatchMakeDate` | `32441-32444` |
| Fresh-batch floor (local run) | `opts.localFreshFloor` → `localFreshFloorFor` | `32455` |
| `SCHEDULE_MIN_LEAD` | **hardcoded `3`** | `32559` |

**Three separate date channels come out**, and they are not one list:

1. `today_slots` / `today_day_chip` — today's chips, or **tomorrow's** if today produced
   none (`32662-32679`).
2. `express_slot` — day-only zones only; the zone's true earliest day, deliberately
   ignoring `SCHEDULE_MIN_LEAD` (`32707-32739`).
3. `schedule` — an open `{min_date, max_date}` **range**, not a day list (`32681-32705`).

Because it is a range and not a list, the fresh-batch constraint is applied as a **floor on
`min_date`**, never as a per-day filter (`32430-32436`, `32697`).

**Blackout / holiday / production days.**

- `skip_dates` — `storefront_config['batch.schedule'].skip_dates`, rolled past a whole
  interval at a time (`routes/retail.js:31803-31806`). Applies to **fresh items only**.
- `delivery.holidayMode` — sets `same_day_allowed = 0` and nothing else; the calendar
  stays open (`32476-32480`).
- Weekday/weekend rules: **none exist.** The cadence is `anchor_date + N days`
  (`31789-31808`), so it drifts across weekdays.
- Store opening hours: `lib/store-hours.js` reads `retail_stores.open_time/close_time` —
  and is **not used by the slot generator at all**. The slot generator's "kitchen hours"
  come from the *zone* row (`32462-32463`).

**Timezone — this is the single biggest structural risk. See F2.**

Every comparison in the engine is **host-local**: `new Date()`, `.getHours()`,
`.getFullYear()`, `.getMonth()`, `.getDate()`.

`routes/retail.js:31775-31785`, `31900`, `31915`, `32029`, `32034-32036`, `32422`,
`32487`, `32504-32505`, `32511-32512`, `32526`, `32573`, `32638`, `32883`, `32910`,
`11886`.

There is exactly one deliberate exception, and it is in a *different* module:
`_gzDateStr` (`lib/inventory.js:1577-1584`) applies an explicit `+8h` and its comment says
*"Host-TZ independent (explicit +8h)"*. So the rider-eligibility check and the slot
calendar do not read "today" the same way.

**Where "now" is read from.** Always the **server clock**, via `new Date()`. Never the DB,
never the client. The order path hoists a single `orderNow` (`routes/retail.js:10815`)
specifically so two `new Date()` calls cannot straddle a cutoff hour — that discipline is
present and correct.

---

### Stage 4 — Every cutoff in the code

| # | Cutoff | Value | Lives in | What happens the moment it passes |
|---|---|---|---|---|
| C1 | Same-day delivery buffer | `10` min before close | `storefront_config['delivery.sameDayCutoffMinutes']`, admin-editable (`routes/retail.js:32522`) | `pastSameDayCutoff` → today's chips and `right_away` **disappear**; `same_day_cutoff_message` is returned so the UI can explain. Clamped to the open span (`32525`). **Requires `kitchenOpenNow`** (`32531-32534`) — so before opening hours it is always false. |
| C2 | Kitchen close (`slot_end_hour`) | zone row, default `20` | `retail_delivery_zones` (`routes/retail.js:32463`) | Time-slot zones: `emitTimeSlots(filterElapsed)` returns `[]`, and the code **rolls forward to tomorrow's full slot list** (`32662-32679`). Day-only zones: `todayStillFulfillable = tzNow.getHours() < endHour` (`32638`) → no Today chip, and there is **no tomorrow fallback** for day-only (`32673` excludes `isDayOnly`). |
| C3 | Per-slot elapse | slot **start** | `routes/retail.js:32602-32605` | The chip vanishes. `slotStartsAt <= tzNow` — i.e. a window is dropped once it has *started*, not once it has ended. **Contradicts `docs/shipping-rules.md:81`** — see F17. |
| C4 | Fresh batch order cutoff | `20` (0-23) | `storefront_config['batch.schedule'].cutoff_hour`; blank falls back to `fresh.rescheduleCutoffHour`, then to literal `20` (`routes/retail.js:31719-31725`) | `pastCutoff` → `searchFrom = tomorrow`, the make date **rolls to the next cadence day**. Reason string `'rolled_cutoff'` (`31915`, `31949-31951`, `31966`). The option does not disappear; the *date* moves and the calendar floor moves with it. |
| C5 | Fresh batch ready hour | unset (`null`) by default | `storefront_config['batch.schedule'].ready_hour` (`31735-31738`) | **Its absence is the off switch** (`31726-31734`). When set and not yet reached on a batch day, a zero shelf still counts as "today" (`'today_batch_pending'`, `31934-31937`, `31963`). A value later than `cutoff_hour` is operator error and **the cutoff wins**, deliberately unclamped (`31730-31734`). |
| C6 | Fresh reschedule lock | `20` | `storefront_config['fresh.rescheduleCutoffHour']` (`routes/retail.js:11884`) | Reschedule refused with `fresh_cutoff` + a `cutoff_at` timestamp. Measured as **20:00 the evening before the scheduled day** (`11885-11889`). |
| C7 | Express re-anchor on payment | n/a — relative | `expressEarliestIso` (`routes/retail.js:32417-32428`) | An express order left unpaid overnight re-earliests from the **pay** date, not the order date. Floored at `max(1, min_lead_days)` — never today. |
| C8 | `SCHEDULE_MIN_LEAD` | **hardcoded `3`** | `routes/retail.js:32559` | Not a cutoff that passes; a permanent floor that keeps the calendar from overlapping Today/Tomorrow. Not configurable per tenant. |

No cutoff leaves an option "clickable but doomed" on the happy path — `resolveDeliverySlot`
re-runs `computeDeliverySlots` against the same `now` and returns
`slot_unavailable` / `right_away_unavailable` (`32863-32882`, `32896-32898`).
The exception is the **zone-less** path — see **F1**.

---

### Stage 5 — Address / region eligibility

`matchDeliveryZone(address)` — **`routes/retail.js:31548-31628`**. Match order:

1. **Hong Kong** — regex `/香港/` or `/hong\s*kong/i` on a concatenated blob of
   province + address + detail + city + district (`31560-31561`, `31573-31579`).
2. **Guangzhou district** — only when the tenant actually has `gz_district` rows
   (`31590-31605`). Exact district match, then blob substring, then suffix-stripped
   substring (`天河区` → `天河`, `31564`, `31599-31600`). **If GZ districts are configured
   and none match, it returns `null` — it does not fall through** (`31602`).
3. **Exact city** (`31611-31613`), then **province-named zone** (`31615-31617`), then
   **blob substring** (`31619-31624`).
4. **National default** — `defaultDeliveryZone()` (`31500-31530`), a zone-shaped object
   synthesised from `storefront_config['delivery.defaultZone']`. Returns `null` when
   disabled.

So the boundary is a **district/city name list held in `retail_delivery_zones`**, matched
by string, with a free-text substring fallback. It is not a postcode and not a distance
calculation. Distance enters only *after* the zone is known, to pick a store
(`storeDistanceKm`, `lib/inventory.js:1670-1680`).

`isGuangzhouAddress` (`lib/inventory.js:1513-1520`) is a **separate, looser** predicate
used by the pre-order gate, the local-run gate and the rider check — it scans the blob for
`广州` with no district requirement at all.

**If the address matches no rule:** `matchDeliveryZone` returns `null`. Then:

- `/checkout/quote` → `computeDeliveryAndPacking` returns `{error:'no_zone_match'}`
  (`routes/retail.js:32941-32943`) → the quote is refused (`33588-33598`). Both clients
  disable the Place button (`miniapp/pages/checkout/checkout.wxml:722-726`;
  `public/shop.html:2715-2719`).
- `POST /orders` → **does not refuse.** See **F1**.

**Hardcoded / Roots-shaped:**

- `GZ_DISTRICT_CENTROIDS` — 11 named Guangzhou districts with literal lat/lng
  (`lib/inventory.js:1650-1662`). The routing fallback for un-geocoded addresses.
  Any tenant outside Guangzhou gets `null` and silently loses distance ranking.
- `gzExpressExcludedDistricts` defaults to `['番禺区','花都区']`
  (`lib/inventory.js:1480-1489`) — admin-overridable, but the default is Roots'.
- `isGuangzhou` / `isGuangdong` (`routes/retail.js:9252`, `9265`, `31484`) — literal
  city and province names.

---

### Stage 6 — Stock, batch dates and availability

**The shared date function** is `earliestBatchMakeDate`
(**`routes/retail.js:31885-31971`**). Its documented purpose (`31823-31831`) is that the
promise, the calendar and the validator cannot contradict each other. The rule, in order:

1. Zone gate — `city` zones, or `gz_district` zones that ship (`day_only=1` or
   `same_day_surcharge>0`) (`31887-31893`). `localRun: true` **replaces** the gate
   (`31871-31877`).
2. Which lines are batch-made — `batchItemsInCart` (`31813-31821`), reading
   `store_products`.
3. **Zero sellable stock at the fulfilling store** — `inventory.getAvailable` (`31911`),
   which is *physical − safety buffer − active reservations* (`lib/inventory.js:303-328`),
   and treats a **missing stock row as zero** (`:309`, and `routes/retail.js:31906-31907`).
4. The day's `cutoff_hour` (`31915`).
5. `skip_dates`, via `nextBatchShipDate` (`31789-31808`).

Stock, cutoff and an unresolvable store all feed **one** roll-forward (`31939-31952`), so a
day skipped for one reason is skipped identically for the others. That is good design and
it holds.

**Where stock is checked, and whether the checks agree — five points:**

| Point | Expression | Scope |
|---|---|---|
| Shop grid / PDP | `sellableStockSql` (`lib/inventory.js:266-279`) | SUM over **all open stores**, falling back to the legacy flat column when a product has *no* per-store rows |
| Add-to-cart | none (client only) | — |
| Quote | `analyzeShortage` (`lib/inventory.js:1695+`) | per-store, closures applied |
| Batch floor | `getAvailable` (`routes/retail.js:31911`) | **one store**, missing row = zero |
| Order hard gate | `r.product.real_stock` = `sellableStockSql` (`routes/retail.js:1044`, gate at `10247-10252`) | all open stores |
| Order write | `reserveForOrder` | one store, authoritative |

They **can and do disagree** — see **F24** and **F25**.

**A fresh meal whose batch date makes it unshippable on the picked date.** The intended
answer is the floor: `computeDeliverySlots` raises `schedule.min_date` (`32697`), withdraws
today's chips via `floorBlocksToday` (`32504-32505`, `32632-32633`), gates the tomorrow
fallback (`32672`), and pushes `expressDateIso` (`32720`). `resolveDeliverySlot` then
re-derives the same window and refuses a stale pick with `slot_unavailable`
(`32858-32860`). **This is genuinely well built for the checkout path** — and is bypassed
by reschedule (**F27**) and by the manual order route (**F9**).

---

### Stage 7 — Checkout validation: display vs submit

**Re-checked at submit (`POST /api/retail/checkout/orders`):**

| Check | Line |
|---|---|
| Non-empty cart → `no_items` | `routes/retail.js:10093` |
| `delivery_mode ∈ {standard,max,sameday}` → `invalid_delivery_method` | `10131` |
| `delivery_slot_id` present → `delivery_slot_required` | `10134` |
| Address belongs to this customer → `address_not_found` | `10136-10139` |
| Idempotency replay | `10145-10156` |
| Per-line price re-resolved server-side (flash windows, option deltas) | `10158-10236` |
| Flash stock cap → `flash_stock_exceeded` | `10211-10216` |
| Hard OOS for `strict` products → `insufficient_stock` | `10240-10259` |
| Local-only outside GZ → `local_only_outside_gz` | `10280-10290` |
| Local pre-order gate (sold-out `backorder_gz` on the local run) | `10491-10505` |
| Store routing + closures + `no_active_store` | `10577-10587` |
| Zone re-matched from the saved address | `10776-10777` |
| Fee re-computed; `max_not_offered` | `10791-10792` |
| **Slot re-validated against the batch-floored window** | `10858-10863` |
| Voucher ownership, cap, pool bump inside the tx | `10901-10940`, `11171-11197` |
| Stock reserved inside the tx | `reserveForOrder` |

**NOT re-checked at submit, though it gated the display:**

| Rule shown at display | Where it lives | Why submit misses it |
|---|---|---|
| **`no_zone_match`** | quote `33588-33598` | `POST /orders` calls `computeDeliveryAndPacking` only inside `else if (zone)` (`10783`); with `zone === null` it falls to a legacy flat-fee branch (`10796-10804`). **F1** |
| **`delivery_slot_kind` consistency** | never checked anywhere | Written verbatim from the request body (`10886-10888`). **F5** |
| **Channel closures for `web`** | quote hardcodes `'wechat'` (`33720`, `33806`, `33833`, `33844`) | order uses the real channel (`10684`). **F7** |
| `store_move_notice` | quote `33804-33809` | advisory only — correct to skip |
| `preorder_notice` / `batch_notice` / `local_fresh_notice` | quote `33902-33913` | recomputed post-commit (`11386-11447`) rather than validated — correct, they are copy |
| Bundle-cart shortage collapse | quote `33728-33730` | order refuses bundles differently — not traced further |

---

### Stage 8 — Order write and downstream

**Fields written by the customer checkout** (`routes/retail.js:11114-11166`):

`delivery_mode` (= `resolvedMode`, `'pickup'` when pickup else the requested mode),
`delivery_zone_id` (**NULL when the zone is the synthesised national default** — `10795`),
`scheduled_for` (ISO string, or NULL for `right_away` / wait-for-restock),
`delivery_slot_label`, `delivery_slot_kind`, `same_day_surcharge_fee`,
`store_id`, `routing_reason`, `routed_by_distance`, `channel`,
`fulfillment_type` (`'pickup'` or `'delivery'`), `fallback_choice`,
`awaiting_restock_pids`, `fulfillment_short_pids`.

Post-commit, best-effort: `promised_ship_date` / `promised_delivery_date` from
`computeBatchNotice` (`11396-11398`) **or** `computeLocalFreshNotice` (`11437-11439`) —
the two cannot both fire (`11414-11416`).

**Defaults applied when a field is missing or null:**

| Field | Default | Line |
|---|---|---|
| `fulfillment_type` | `'delivery'` (column DEFAULT) | `database.js:4047` |
| `channel` | `'wechat'` whenever `body.channel !== 'web'` — **client-declared, unverified** | `routes/retail.js:10074` |
| `delivery_slot_kind` | `'right_away'` if the slot id was `right_away`, else **NULL** | `10886-10888` |
| `retail_order_items.ship_modes` | `'air,land'` | `11213`, `24312`, and again on read `9548` |
| shipping fee with no zone | `fees.standardShipping` (12) or `fees.sameDayDelivery` (18) | `10799-10803` |
| `unit_cost_at_sale` | `null`, never `0` — deliberate | `11217-11222` |

**How an order reaches fulfilment — rider vs courier.** Two decisions, and they read
different fields:

1. **Parcels.** `ensureShipments` (`routes/retail.js:9501-9564`) → `planShipments`
   (`9423-9461`). Mirrored channels return `[]` before anything is planned (`9539`).
   Inputs: `address_json.city/province/district` and **`o.delivery_slot_kind`** (`9560`).
2. **Rider queue.** `maybeEnqueueQingyunPush` (`4746-4774`), fired from `markOrderPaid`
   (`5004`). Requires `delivery.qingyunAutoPush === true` (`4748`),
   `!shipsNothing(o)`, `o.store_id`, `isQingyunSameCityToday(o)` (`4753`), and a
   `qingyun_status` row for the store (`4759`). The drain re-evaluates
   `isQingyunSameCityToday` on **every poll** (`27450-27462`).

`isQingyunSameCityToday` (`lib/inventory.js:1609-1643`) requires: channel ∈
`['wechat','web']`; a Guangzhou address; not an opt-in ship-district unless
`kind === 'today'`; and then `kind ∈ {right_away, today}`, **or** `kind === 'express'`
with no date, **or** a scheduled day equal to today in GZ time.

---

### Stage 9 — Channel differences

| Channel | Path | Zone match | Slot generation | Cutoffs | Batch/fresh | Stock gate | Rider push |
|---|---|---|---|---|---|---|---|
| **WeChat mini-app** | `POST /checkout/quote` + `POST /checkout/orders` | ✅ | ✅ full (chips + express + calendar) | ✅ | ✅ | ✅ | ✅ |
| **Website (`shop.html`)** | same two endpoints, `channel:'web'` | ✅ | ⚠️ **chips + express only — never renders `scheduling.schedule`** (F11) | ✅ | ✅ | ✅ | ✅ |
| **Staff / manual order** | `POST /api/retail-admin/orders` — `routes/retail.js:23911`, INSERT at `24276-24296` | ❌ | ❌ | ❌ | ❌ | ❌ (no local-only gate either) | via `markOrderPaid`, but `delivery_slot_kind` is NULL |
| **Meituan** | `routes/meituan-internal.js:458-492` | ❌ mirrored | ❌ | ❌ | ❌ | stock deducted only | ❌ blocked by `QINGYUN_PUSH_CHANNELS` |
| **Eleme** | `routes/eleme-internal.js:570-600` | ❌ mirrored | ❌ | ❌ | ❌ | stock deducted only | ❌ blocked |
| **gzgrocery** | `scripts/gzgrocery-order-daemon.js:307-315` | ❌ mirrored | ❌ | ❌ | ❌ | stock deducted only | ❌ blocked |

The three marketplace mirrors are **correct by design** — `isMirroredChannel`
(`lib/fulfilment.js:62-66`) and the guard at `routes/retail.js:9539` stop them creating
phantom parcels, and the reasoning is documented at `9516-9538`. They are listed here
because it means stages 2–7 **do not exist** for three of six order sources, and any rule
added to checkout will silently not apply to 3/6 of the order book.

The **staff / manual route is not correct by design** — see **F9**.

Also note: `/checkout/quote` hardcodes `channel: 'wechat'` at every call site
(`routes/retail.js:33720`, `33806`, `33833`, `33844`, `33911`, `33929`), while
`POST /orders` derives the channel from the request (`10074`) and uses it for closures
(`10684`). See **F7**.

---

## Part 2 — Findings table

Severity: **breaks orders** > **wrong data** > **confusing** > **cosmetic**.

| # | Category | Severity | Where | What the code does | What the customer / shop experiences |
|---|---|---|---|---|---|
| **F1** | Contradiction + Silent default | breaks orders | `routes/retail.js:10768-10804` vs `33586-33598`; `32941-32943` | The comment says *"If no zone matches the address, we currently refuse the order"*. The code does not: with `zone === null` it skips `computeDeliveryAndPacking` entirely and prices the order at `fees.standardShipping` (12) / `fees.sameDayDelivery` (18). `resolveDeliverySlot(null, …)` then validates the slot against `computeDeliverySlots`' **hardcoded defaults** (10:00–20:00, same-day on, 0 lead, 14-day calendar), not the tenant's config. | The quote refuses the address; the order endpoint accepts it. Both clients disable Place, so today this is reachable only by a stale client or a direct API call — but when it is reached the order is created with a fee nobody configured and a delivery window from no zone. The concrete route in: a Guangzhou district not present in `retail_delivery_zones` (`31602` returns null rather than falling through). |
| **F2** | Contradiction | breaks orders (if true) | `routes/retail.js:31774` + `.github/workflows/tests.yml:132-137` vs `lib/business-date.js:5-11` | Three assertions about the production timezone, two of which cannot both hold. `retail.js:31774`: *"the host runs UTC+8 with no DST anyway"*. `tests.yml:133`: *"Production runs UTC+8 with no DST"*. `business-date.js:5-7`: *"`new Date().toISOString()` is the server's day, and **the server runs UTC**"* — and that module exists **because** of it. `TZ` is set **only** in `tests.yml:137`; `deploy.yml` and `ops/` set nothing. | If the host is UTC, every cutoff in Stage 4 fires 8 hours early: the 20:00 batch cutoff bites at noon Guangzhou, "today's" slots roll to tomorrow mid-afternoon, and `toYmdLocal` dates an evening order to the previous day. CI can never catch it because CI pins `Asia/Shanghai`. **I cannot resolve this from the repo** — see Open Question Q1. |
| **F3** | Hardcoded assumption | breaks orders | whole engine, per Stage 3; vs `database.js:3667-3670` | `retail_stores.timezone` exists and `lib/business-date.js` honours it per location. The delivery engine reads it **nowhere** — `grep -n "timezone" routes/retail.js` returns nothing. | Every tenant's delivery calendar is computed in the single host timezone. A second tenant in another zone gets a calendar shifted by the offset difference, silently. |
| **F4** | Unreachable rule | confusing | `routes/retail.js:9252-9256` and `31484-31488` | `isGuangzhou` is declared **twice at module scope** in one file (verified: the only duplicate among 393 top-level `function` declarations). The second declaration wins for every call site in the module; the first is dead. | No wrong answer today — the two agree on every realistic input. It is a maintenance trap: an edit to `9252-9256` (which sits beside `isGuangdong` and reads like the shipping-side copy) has **zero effect**, and the change will look correct in review. |
| **F5** | Unhandled case | breaks orders | `routes/retail.js:10886-10888` | `delivery_slot_kind` is taken verbatim from the request body and **never cross-checked against the slot the server just resolved**. It then drives: the out-of-city warehouse pin (`10459-10463`, `31656-31659`), the local pre-order gate (`10491-10496`), `planShipments` local-vs-courier (`9434-9439`), `isQingyunSameCityToday` (`inventory.js:1622-1642`), and which fresh notice fires. | A client posting `delivery_slot_kind:'today'` alongside the **free** `express_slot` in a Panyu-style district is treated as same-day: routed to the nearest GZ shop instead of the warehouse, planned as a `local` rider drop, and pushed to Qingyun — while `resolveDeliverySlot` computed a surcharge of 0, so the same-day surcharge is never charged. |
| **F6** | Unhandled case | wrong data | `routes/retail.js:20737-20738` | The customer reschedule writes `delivery_slot_kind` straight from the body too. The price-neutrality guard (`20711-20718`) compares only the **surcharge**, which a bare date pick leaves at 0. | Same escalation as F5, available post-payment. The Qingyun drain re-reads eligibility every poll (`27450-27462`), so a ship-district order rescheduled with `kind:'today'` enters 待配送. |
| **F7** | Contradiction | wrong data | `routes/retail.js:33720`, `33806`, `33833`, `33844`, `33911`, `33929` vs `10074`, `10684`; `lib/inventory.js:183` | `/checkout/quote` hardcodes `channel: 'wechat'` → `orderChannelKey` → `'mini_app'`. `POST /orders` uses the real channel → `'web'` for the website. Closures are per channel (`inventory.js:206-214`). | Close the `web` channel for a store and the website still quotes a price and a store from it; the order then reroutes or fails `no_active_store`. Stock quotas are also per channel (`getAvailable`, `inventory.js:316`), so a `wechat_quota` silently caps web sales. |
| **F8** | Silent default | wrong data | `routes/retail.js:10074` | `const orderChannel = body.channel === 'web' ? 'web' : 'wechat';` — client-declared, never verified against the session or origin. | A web order that omits `channel` is filed as a mini-app order. Affects the rider allow-list, the closure check, and every per-channel report. |
| **F9** | Unhandled case + Silent default | wrong data | `routes/retail.js:23911` (route), INSERT at `24276-24296` | The staff/manual order INSERT writes **no** `scheduled_for`, `delivery_slot_label`, `delivery_slot_kind`, `delivery_mode`, `delivery_zone_id` or `same_day_surcharge_fee`, and the route performs **no** zone match, slot validation, batch/fresh gate, local-only gate or GZ same-day stock gate. `fulfillment_type` relies on the column default `'delivery'` (`database.js:4047`). | A staff-keyed fresh meal to an out-of-city address carries no promised dates and no batch cadence at all. Because `delivery_slot_kind` is NULL, `ensureShipments` (`9560`) reads a 番禺 address as "not same-day" and plans a **courier waybill** where staff may have meant a same-day rider drop. |
| **F10** | Unhandled case | confusing | `scripts/gzgrocery-order-daemon.js:311` vs `lib/inventory.js:1588` | The gzgrocery mirror hardcodes `fulfillment_type='delivery'`, while the comment describing the channel says *"gzgrocery is wholesale **pickup**"*. | Wholesale pickups are counted as deliveries by every `fulfillment_type='delivery'` worklist and report. Harmless for the rider rail (mirrored channels are blocked upstream), misleading everywhere else. |
| **F11** | Dead end | wrong data | `public/shop.html:2661-2691` (`renderCoSlots`); `3208` is the *reschedule* sheet, not checkout | The website checkout renders only `sc.slots` (today/tomorrow chips, or the synthesised express slot). `scheduling.schedule` — the `{min_date, max_date}` calendar — is read **only** by the reschedule modal, never by checkout. The mini-app renders it (`checkout.wxml:374-377`, `422-425`). | A website customer in a time-slot zone can book **today or tomorrow and nothing else**. Every date from day 3 to day 14 that the server offers is invisible to them. If the chips are empty they get "No delivery dates available" and a disabled button, even though the server returned a valid 12-day window. |
| **F12** | Dead end | breaks orders | `routes/retail.js:32698` (`if (minIso <= maxIso)`), `32730` (`expressSlot` needs `schedule`), `32806-32810` | `today_slots: []`, `today_day_chip: null`, `express_slot: null` and `schedule: null` can all be true at once — when a fresh floor pushes `min_date` past `max_date` (`32697-32704`), or when `max_lead_days < SCHEDULE_MIN_LEAD` (3) and same-day does not qualify. | The customer sees "No delivery dates available" / "暂无可选配送日期" (`shop.html:2682`; `checkout.wxml:391-392`, `438-439`, `461-462`) with **no reason and no next step** — not the batch date, not "try a smaller cart", not "remove the fresh item". The one thing that would fix it (dropping the fresh line) is never suggested. |
| **F13** | Unreachable rule | confusing | `routes/retail.js:10131` + `10800-10802` vs `32966-32981` | `delivery_mode: 'sameday'` passes validation, but `computeDeliveryAndPacking` has no `'sameday'` branch — only `'max'` is special-cased. The legacy `fees.sameDayDelivery` (default 18) is read **only** on the zone-less path at `10801`. | For any tenant with zones configured — i.e. every working tenant — the `fees.sameDayDelivery` setting is dead config that an operator can edit with no effect. |
| **F14** | Unreachable rule | confusing | `routes/retail.js:31525-31528` + `32482-32483`, `32638` | `defaultDeliveryZone()` defaults `slot_start_hour: 0`, `slot_end_hour: 0`, `slot_duration_minutes: 0`. The clamp turns that into a **00:00–01:00** kitchen day with 120-minute slots. `day_only` defaults to 1, so time slots are not emitted — but `kitchenOpenNow` and `todayStillFulfillable` (`tzNow.getHours() < 1`) are computed from it anyway. | If an operator ever enables `same_day_allowed` on the national default zone, the "Today" chip is offered **only between midnight and 1am**. Nothing in the delivery wizard would explain why. |
| **F15** | Silent default + "fresh assumed, not checked" | wrong data | `routes/retail.js:9347-9359`, `9351-9352`; defaults at `11213`, `24312`, `9548` | `bucketForItem` maps "Any mode" → **land** (`9359`, *"land (cheaper)"*). `needs_ice_pack` is explicitly *"no longer a per-item factor"* (`9351-9352`). `ship_modes` defaults to `'air,land'` in three places. | **A batch-made fresh meal with no `ship_modes` set ships by LAND to any out-of-Guangdong province.** Perishability never enters the shipping-mode decision — only the operator's manually-set `ship_modes` does, and its default is the slow option. This is the clearest answer to "is the fresh/dry distinction assumed but not checked". |
| **F16** | Unhandled case | wrong data | `routes/retail.js:9280-9289` + `9353-9359` | `parseShipModes` returns the exclusive `['local']` for a Guangzhou-only product. `bucketForItem` then finds neither `air` nor `land` and falls through to `return 'land'`. The only thing stopping a local-only item leaving the city is the explicit gate at `10287`, `33578`, `34784`. | The manual/staff route (F9) has **no** local-only gate. A staff-keyed order with a local-only fresh meal to Shanghai is silently planned as a land parcel. |
| **F17** | Contradiction (doc vs code) | confusing | `docs/shipping-rules.md:81,83,37,85` vs `routes/retail.js:32602-32605`, `32522-32534`, `32592-32621`, `31715-31717` | Four disagreements. (a) Doc: *"Slot closes when slot **ends** (no lead-time buffer)"*; code drops a slot once its **start** has passed. (b) Doc: *"After 20:00 close — same-day fully hidden"*; code withdraws same-day `delivery.sameDayCutoffMinutes` (default 10) **before** close → 19:50. (c) Doc lists windows `10-12 · 12-14 · 14-17 · 17-19 · 19-21`; `emitTimeSlots` emits **uniform** `slot_duration_minutes` windows bounded by `slot_end_hour`, so the uneven ones are unproducible and 21:00 exceeds the 20:00 close. (d) Doc: *"no blackout dates"*; `batch.schedule.skip_dates` and `delivery.holidayMode` are both blackout mechanisms. | **The code executes in all four cases.** Staff answering a customer from the doc will give the wrong cutoff by 10 minutes and the wrong slot list entirely. The doc's implementation line-number index (`:145-162`) is also stale by ~26,000 lines. |
| **F18** | Unhandled case | wrong data | `database.js:4995-5001`, `5034`; `routes/retail.js:1614`, `31818`, `32204`, `22065`, `22135` | `products.is_batch_made` and `store_products.is_batch_made` are two columns on two forked tables with **no sync job** (*"the sync job itself is NOT built yet"*). The parity backfill copies the **column**, never the **value**. Every delivery read uses `store_products`. | A product marked fresh in the kitchen catalogue is treated as dry goods by the entire delivery path. With the kitchen app retired at HEAD (`e12357c`), `products.is_batch_made` is now write-nothing/read-nothing — see Q4. |
| **F19** | Hardcoded assumption | confusing | `lib/inventory.js:1650-1662` | `GZ_DISTRICT_CENTROIDS` — 11 Guangzhou districts with literal lat/lng, used as the routing fallback when an address has no coordinates. | Works only because Roots is in Guangzhou. Any other tenant gets `null` from `districtCentroid` → `storeDistanceKm` returns `null` → distance ranking silently degrades to name matching, with no signal. |
| **F20** | Hardcoded assumption | confusing | `routes/retail.js:32559`; `lib/inventory.js:1488`, `1591`; `lib/fulfilment.js:62` | `SCHEDULE_MIN_LEAD = 3` (not configurable); `gzExpressExcludedDistricts` default `['番禺区','花都区']`; `QINGYUN_PUSH_CHANNELS`; `MIRRORED_CHANNELS`. Also the literal fee defaults `air {base:20, per_kg:8}` / `land {base:12, per_kg:5}` (`routes/retail.js:9386-9389`). | A tenant who ships next-day everywhere still has a 3-day hole between the Tomorrow chip and the first calendar date. None of these are surfaced in the delivery wizard. |
| **F21** | Contradiction | confusing | `miniapp/pages/checkout/checkout.js:1859-1865` vs `routes/retail.js:32737-32738` | The mini-app hardcodes the Express label to *"Express delivery (1–2 days)"* **regardless of the zone's `min_lead_days`** — the comment says so outright. The server labels the same slot `Earliest <date>`. | Two different promises for one slot. A zone configured with `min_lead_days: 5` still advertises "1–2 days" in the mini-app radio while the date beside it says otherwise. |
| **F22** | Unhandled case | wrong data | `routes/retail.js:20644-20649`, `20701-20705`, `20724-20731` | Reschedule passes only `opts.batch` to `computeDeliverySlots` / `resolveDeliverySlot` — **never `localFreshFloor`**. The `fresh_no_sameday` guard blocks only *same-day* moves (`requiresStockGate`), not an earlier-than-batch **future** day. It also never re-runs the local pre-order gate. | A Guangzhou local-run order holding a sold-out fresh line can be rescheduled onto a day **before** the next batch — precisely the move the checkout calendar floors away. The kitchen gets an order for a day it cannot cook. |
| **F23** | Unhandled case | breaks orders | `routes/retail.js:31590-31603` | When a tenant has `gz_district` zones configured and the address's district matches none of them, `matchDeliveryZone` returns `null` — it deliberately does **not** fall through to city / province / national-default matching. | This is the reachable path into F1 for Roots' own data: any Guangzhou district not in `retail_delivery_zones` is refused by the quote and accepted by the order endpoint. |
| **F24** | Contradiction | wrong data | `lib/inventory.js:266-279` vs `routes/retail.js:31911` (`getAvailable`) | The shop grid and the hard-OOS gate read `sellableStockSql` — a **SUM across all open stores**. The batch floor reads `getAvailable` at **one** store. | A fresh meal reads "in stock" on the grid because the *other* store has it, the customer adds it and picks a date, and only then does the batch floor fire at the fulfilling store and move the date. Nothing on the product page could have predicted it. |
| **F25** | Contradiction | wrong data | `lib/inventory.js:309` + `routes/retail.js:31906-31912` vs `lib/inventory.js:263-265` | `getAvailable` returns `{available: 0, exists: false}` when a product has **no stock row at that store**, and `earliestBatchMakeDate` counts that as zero (*"there is nothing there to ship today"*). `sellableStockSql` does the **opposite** on purpose — it falls back to the legacy column *"so a newly-added product doesn't silently read as sold out"*. | The two "no data" policies point opposite ways. A newly-added fresh product never stocked at the out-of-city warehouse is permanently promised the *next* batch, never today, even on a batch morning with stock at the other store. |
| **F26** | Unhandled case | confusing | `routes/retail.js:33723-33724` vs `10834-10844` | The quote derives its local-run shelf from `analysis.resolved.store \|\| analysis.nearest.store` (no out-of-city pin). The order derives it from `fulfillingStore` (pinned). **Not proven to diverge** for inner-GZ carts, where the pin returns `null` — flagged as a shape risk, not a demonstrated defect. | If they ever resolve to different stores, the calendar the customer was offered and the calendar the order enforces are floored off different shelves. |
| **F27** | Silent default | cosmetic | `routes/retail.js:10795` | `deliveryZoneId = zone.is_default ? null : zone.id` — an order served by the synthesised national default stores `delivery_zone_id = NULL`, the same value a pickup and a zone-less order store. | `zoneForOrder` (`12066`) and the reschedule sheet cannot tell "national default" from "no zone recorded". |
| **F28** | Silent default | confusing | `routes/retail.js:32483-32485` | `computeDeliverySlots` silently repairs pathological zone config: `slot_end_hour = slot_start_hour + 1` when start ≥ end; `slot_duration_minutes = 120` when ≤ 0; `max_lead_days = min_lead_days + 7` when max < min. | An operator who mis-types opening hours gets a working-but-wrong one-hour delivery day and no warning anywhere. |

**Explicitly checked and found handled** (recorded so nobody re-hunts them): empty cart is
refused (`10093`); `resolved` is re-synced from `mutatedItems` at `10757`, so the
substitution path and the batch decision cannot read different carts; `computeBatchNotice`
and `computeLocalFreshNotice` are mutually exclusive by construction (`11414-11416`) and so
are `computePreorderNotice` / `computeLocalFreshNotice` (`32267-32270`);
`right_away` deliberately reads only the *local* floor and not the courier one, with the
reasoning at `32488-32505`; the single `orderNow` hoist at `10815` correctly stops two
`new Date()` calls straddling a cutoff.

---

## Part 3 — The ten worst problems, ranked

1. **F2 — the timezone the whole calendar rests on is asserted three times and contradicted once.**
   Every cutoff, batch date and slot comparison uses host-local time; `retail.js:31774` and
   `tests.yml:133` say production is UTC+8, `lib/business-date.js:5-7` says it is UTC and
   exists because of it, and `TZ` is pinned only in CI.
   If UTC is the truth, every cutoff in Stage 4 fires eight hours early in production and
   the test suite is structurally incapable of noticing.

2. **F5 — `delivery_slot_kind` is client-supplied and never validated against the slot the server resolved.**
   It decides warehouse-vs-shop routing, courier-vs-rider parcels, the rider queue and the
   pre-order gate.
   A client can claim `'today'` while picking the free Express slot and get same-day rider
   fulfilment in a surcharge district without paying the surcharge.

3. **F1/F23 — an address that matches no delivery zone is refused by the quote and accepted by the order endpoint**, against a comment that says the opposite.
   A Guangzhou district missing from `retail_delivery_zones` is the reachable path in.
   The order is created at a legacy flat fee nobody configured, with a delivery window
   validated against hardcoded defaults belonging to no zone.

4. **F9 — the staff/manual order route writes no delivery fields and runs no delivery validation at all.**
   No zone, no slot, no cutoff, no batch gate, no local-only gate, no stock gate.
   A staff-keyed fresh meal has no promised dates, and a 番禺 address silently becomes a
   courier waybill instead of a same-day drop because `delivery_slot_kind` is NULL.

5. **F12 — the customer can be shown zero delivery dates with no reason and no way out.**
   All four date channels can be empty simultaneously, most easily when a fresh floor
   pushes `min_date` past `max_date`.
   Both clients render "No delivery dates available", disable the button, and never
   mention that removing the fresh item would fix it.

6. **F11 — the website checkout never renders the schedule-for-later calendar.**
   `scheduling.schedule` is read only by the reschedule modal, never by `renderCoSlots`.
   Website customers in time-slot zones can book today or tomorrow and nothing else, while
   the server is offering a 12-day window they cannot see.

7. **F15/F16 — perishability never influences how a parcel ships.**
   `bucketForItem` sends "Any mode" to **land** as the cheaper option, `needs_ice_pack` is
   explicitly not a routing input, and `ship_modes` defaults to `'air,land'`.
   A fresh meal with unset ship modes goes by ground to any out-of-province address, and a
   local-only item leaked past the gates becomes a land parcel rather than an error.

8. **F22 — reschedule re-opens every fresh-date gate the checkout closes.**
   It passes `batch` but never `localFreshFloor`, and its fresh guard blocks only same-day
   moves.
   A Guangzhou order holding a sold-out fresh line can be moved to a day before the batch
   exists, giving the kitchen an order it cannot cook.

9. **F24/F25 — stock is answered by two different questions with opposite "no data" policies.**
   The grid sums all open stores and treats a missing row as *available*; the batch floor
   asks one store and treats a missing row as *zero*.
   A fresh product reads in-stock on the shelf and then silently moves the customer's date
   at checkout, and a fresh product never stocked at the warehouse can never be offered
   today at all.

10. **F7/F8 — the channel a quote is priced for is not the channel the order is filed under.**
    The quote hardcodes `'wechat'`; the order takes `body.channel`, unverified, defaulting
    to `'wechat'`.
    Closing the `web` channel for a store still lets the website quote from it and then
    fail at submit, and per-channel stock quotas apply to the wrong channel.

---

## Part 4 — Open questions for Ash

These are the things the code genuinely cannot answer. Listed, not asked.

**Q1 — What timezone does production actually run in?** (blocks F2, F3)
`routes/retail.js:31774` and `.github/workflows/tests.yml:133` both assert UTC+8;
`lib/business-date.js:5-7` asserts UTC and the module exists because of it. `TZ` is set
only in the test workflow. Nothing in `deploy.yml` or `ops/` settles it. Everything about
Stage 3 and Stage 4 depends on the answer.

**Q2 — Should a mixed cart hold the dry goods back to the fresh item's batch date, or split into two deliveries?**
`earliestBatchMakeDate:31904-31905` chose "one promised date per order" deliberately. That
is a business call, and the customer is currently never told their rice is waiting for
their wrap.

**Q3 — Is `delivery_slot_kind` meant to be a customer *intent* or a server *verdict*?**
It is currently written from the request body at both checkout (`10886`) and reschedule
(`20737`) and read as authoritative by routing, parcels and the rider queue. Deciding
which it is determines whether F5/F6 are a validation gap or a naming problem.

**Q4 — Now that the kitchen app is retired (HEAD `e12357c`), what is `products.is_batch_made` for?**
The delivery path reads only `store_products`. Is the `products` catalogue still a live
input to anything, or is F18 now moot for a reason the code does not record?

**Q5 — For the staff/manual order route: is the absence of delivery dates and slots intentional (staff arrange it by phone) or an omission?**
F9's severity depends entirely on this. If intentional, the missing local-only gate
(F16) is still a defect on its own.

**Q6 — Should `docs/shipping-rules.md` be corrected or retired?**
It disagrees with the code on four behavioural points (F17) and its line-number index is
stale by ~26,000 lines. It is explicitly scoped as "one business's setup", so it may be
serving a purpose that correctness would not improve.

**Q7 — Is `gzgrocery` a pickup channel or a delivery channel?**
`lib/inventory.js:1588` calls it "wholesale pickup"; the mirror writes
`fulfillment_type='delivery'` (`gzgrocery-order-daemon.js:311`).

**Q8 — What should a customer see when there are zero delivery dates?** (F12)
The code has the reason in hand at that moment (`decision.reason` is one of
`rolled_stock` / `rolled_cutoff` / `today_batch_pending` / `rolled_store_unknown`) but
throws it away before the client sees it. Whether to surface it, and how much, is a
product decision.

---

*No fixes are proposed here, per the survey brief. Recommendations, if wanted, belong in a
separate document.*
