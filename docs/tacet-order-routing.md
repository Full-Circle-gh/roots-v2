# Tacet order routing — which shop fills the order, and what happens when it can't

**2026-07-31 · Read-only behavioural survey of `lib/inventory.js` (`routeOrder`, `analyzeShortage`, the reservation lifecycle) and the checkout paths in `routes/retail.js`, written before the locations module is redesigned so nothing that works today is lost. Every claim is cited to a file and line and was re-verified against the code at `1d8e95ad`. Where the code contradicts a comment, the entry says so and follows the code. Anything the code does not settle is marked UNVERIFIED with the reason. No row data was read. No file was changed except this one. `public/app.html.bak` was ignored throughout.**

> **What this document is: a SURVEY, not a specification.** It describes how routing works today across **one business's** two-shop Guangzhou topology, with that business's districts, carriers and ¥ figures. Nothing below may be read as a Tacet product default or requirement (`docs/tacet-consolidation-decisions.md` §0). Where the current behaviour is Roots-shaped, that is a finding, not a design.

Terms used below, one line each:

- **Routing** — choosing which shop fulfils a customer's order.
- **Candidate pool** — the shops the router is willing to consider at all.
- **Haversine distance** — straight-line "as the crow flies" distance between two points.
- **Road distance** — real driving distance from a maps API. Slower to get, but honest about rivers and bridges.
- **Geocoding** — turning a typed address into coordinates.
- **Reservation (soft hold)** — a temporary claim on stock while an order waits to be paid. It does not change the shelf count.
- **Commit** — turning a hold into a real decrement of the shelf count.
- **Stock gate** — the rule deciding whether a shortage should block or warn at all.
- **Fallback store** — a farther shop that can fill the order when the nearest one can't.
- **Channel** — a place customers buy from: the mini app, the web shop, Meituan, Eleme, the gzgrocery feed.

---

## Summary — the rule, as a person would explain it

When a customer checks out for delivery, the shop asks one question: **which of our open shops is physically closest to this address, and can it fill the whole basket?**

It starts by throwing out any shop that is switched off — closed for the whole business, or closed for this particular channel. If the customer's address has coordinates, it ranks every remaining shop by real driving distance (falling back to straight-line if the maps API is unavailable), and distance alone decides the order. Only when the address has no coordinates does it fall back to coarser hints: a delivery zone's preferred shop, then a shop whose home district matches the address, then simply the first shop in the manual priority order.

Then it checks stock at the winner. If the nearest shop can fill everything, it's done and the customer never sees any of this. If it can't but a farther shop can, **the customer is asked** — in the mini app they get five options, in the web shop two. If nothing can fill it, the order is refused.

Two things sidestep routing entirely. **Collection orders aren't routed at all** — the customer picked the shop themselves, so that is the shop. And orders going outside Guangzhou (or to an outer district that didn't buy same-day) are pinned to a single designated out-of-city warehouse, because that's where the parcel actually ships and the receipt actually prints.

The decision is made **once, at checkout submit, before the customer pays**, and written into the order in the same breath as the order itself. After that it is effectively permanent: no automatic re-route, no operator screen to move it, and add-ons bought later inherit the same shop without re-checking. The one exception is a Qingyun "ships from" move, which changes where the rider collects but deliberately leaves the stock, the reporting and the shop attribution where they were.

Stock is held the moment the order is created — not at payment — for a default 15 minutes, and a sweeper cancels the order if payment never arrives. Payment turns the hold into a real decrement.

Orders staff type in by hand are a separate world: they are never routed, the operator picks the shop from a dropdown, and **the shop is optional** — a staff-created order is allowed to exist with no fulfilling shop at all.

Three things are worth knowing before redesigning any of this:

1. **`sort_order` almost never decides anything.** Once an address has coordinates, distance ranks every shop and the manual priority order is bypassed completely (`lib/inventory.js:404-411`). It is decisive only for un-geocoded addresses with no matching zone and no district match — and for the order of the collection-point list.
2. **Opening hours have no effect on routing whatsoever.** `open_time`/`close_time` are loaded into the store list (`lib/inventory.js:88`) and never read by any routing code. A shop that is shut for the night is still a routing candidate; only the manual open/closed toggles remove it. Hours matter for exactly one thing: validating a customer's chosen collection time.
3. **The two customer-facing shopfronts disagree about what to offer.** The mini app gives five options on a shortage; the web shop gives two, names no shop, and lists no items (`public/shop.html:2714-2721`). Any redesign inherits both.

---

## 1. How a location is chosen

The whole rule lives in `routeOrder` (`lib/inventory.js:370-532`). It runs in two stages: build a candidate list in priority order, then score each candidate against the basket.

### 1.1 The candidate pool

`lib/inventory.js:376-378`:

```
const closedForChan = channelClosedStores(orderChannelKey(channel));
const stores = listStores({ activeOnly: true }).filter(s => !closedForChan.has(s.code));
if (!stores.length) return { error: 'no_active_store' };
```

- `listStores({activeOnly: true})` is `WHERE is_active = 1 ORDER BY sort_order ASC, id ASC` (`lib/inventory.js:84-91`).
- `channelClosedStores` (`lib/inventory.js:124-132`) unions two things: every shop closed business-wide (`store_business_status.fulfillment_open = 0`, `lib/inventory.js:109-116`) and every shop closed for this channel (`channel_status.is_open = 0`). Both are keyed on `retail_stores.code`, not id. Both queries are wrapped so a missing table yields an empty set rather than an exception.
- `orderChannelKey` maps the channel to a `channel_status` key: `'web'` → `'web'`, anything else → `'mini_app'` (`lib/inventory.js:101`).

An empty pool returns `no_active_store`. Checkout also guards this earlier with a friendlier message when *every* shop is closed for the channel (`routes/retail.js:8576-8582`, `channelFullyClosed` at `lib/inventory.js:137-141`).

### 1.2 The precedence order, as the code actually runs it

**Tier 1 — real proximity, and it is authoritative.** `lib/inventory.js:404-411`. Runs only when the address has both `lat` and `lng` (`hasAddrGps`, `:397`). It calls `rankStoresByProximity` and pushes **every** shop in the returned order. Because it pushes every shop, tiers 2–4 below find nothing left to add and become no-ops. The comment at `lib/inventory.js:380-391` states this explicitly, and the code matches: distance is the sole decider whenever coordinates exist.

`rankStoresByProximity` (`lib/inventory.js:310-352`) works in two passes:
1. Haversine sort of all shops, with any shop missing coordinates pushed to the bottom (`lib/inventory.js:311-323`).
2. Road distance for the nearest 4 by Haversine (`ROAD_CHECK_LIMIT = 4`, `:329-330`), via `drivingDistanceKm` (`lib/geocode.js:442-472`), which tries Amap then Tencent and caches results (`:451-466`).

The road pass is **all-or-nothing**: if any one of the checked candidates fails to resolve, the whole ranking falls back to Haversine, because comparing a resolved road distance against an unresolved one's straight-line distance could flip the order on bad data (`lib/inventory.js:341-344`). With fewer than two measurable candidates it also stays on Haversine (`:332`). Shops beyond the 4 checked keep their Haversine positions appended after the road-ranked ones (`:349-351`).

If the address has no coordinates at checkout time, the order endpoint tries to geocode it synchronously first (`routes/retail.js:8973-8991`), persisting the result to the address row. The comment records why: without coordinates the router once sent a ~1 km order to a ~9 km shop purely because the address string said 天河区 (`routes/retail.js:8966-8969`).

**Tier 2 — the delivery zone's preferred shop, only when there are no coordinates.** `lib/inventory.js:416-431`. Guarded by `!hasAddrGps`. Looks up `retail_delivery_zones` by `match_district` (zone_type `gz_district`) or `match_city` (zone_type `city`), `ORDER BY zone_type DESC LIMIT 1` so a district rule beats a city rule, and pushes `preferred_store_id` if that shop is in the pool. The comment at `:413-415` is explicit that this is a hint, never an override.

**Tier 3 — home-district name match.** `lib/inventory.js:434-438`. Adds any shop whose `district` column equals the address's district string. Exact string equality, no normalisation.

**Tier 4 — everything else, in `sort_order`.** `lib/inventory.js:441-445`. Iterates the remaining shops in `listStores` order, which is `sort_order ASC, id ASC`.

### 1.3 Where `sort_order` actually enters

Only as the base ordering of `listStores` (`lib/inventory.js:90`), which tier 4 inherits. **It is decisive only when all three of these hold: the address has no coordinates, no delivery zone matches with a preferred shop, and no shop's district matches the address.** With coordinates present it has no effect on routing at all.

It does have one other visible effect: the collection-point list shown to customers is ordered by it (`routes/retail.js:829`).

### 1.4 A labelling quirk worth knowing

Tier 4 assigns the reason `'only_store'` to the first shop it adds when the candidate list is still empty, and `'fallback_no_stock'` to the rest (`lib/inventory.js:443`). With two or more shops configured, an un-geocoded address that matches no zone and no district therefore produces an order stamped `routing_reason = 'only_store'` even though several shops exist. The label is a misnomer on that path. It is cosmetic — the admin renders nothing for it (`public/retail-admin/04-orders.js:2042`) — but it makes the column unreliable as a signal of how many shops were considered.

### 1.5 Scoring and the decision

Each candidate is scored per item with `getAvailable` (`lib/inventory.js:450-469`), where available = `physical_qty − safety_buffer − active holds`, further capped by a per-channel quota when one is set (`lib/inventory.js:280-295`). The first candidate is `nearest`; the first later candidate that can fill everything is `fallbackOk` (`:477-478`).

Outcomes, in the order the code tests them:

| Condition | Result | Line |
|---|---|---|
| `ignoreStock` (stock gate off) | the top candidate, no stock questions asked | `lib/inventory.js:485-488` |
| Only one shop in the pool, and it's OK | `reason: 'only_store'` | `:491-492` |
| Only one shop, not OK | `error: 'no_stock'` | `:493-497` |
| Nearest can fill everything | that shop, reason from its tier | `:501-503` |
| Nearest can't, a farther one can, `acceptFallback` set | the fallback, `reason: 'fallback_no_stock'`, plus the short product ids for diagnostics | `:507-518` |
| Nearest can't, a farther one can, no acceptance yet | `error: 'needs_fallback_confirmation'` with both shops | `:519-523` |
| Nothing can fill it | `error: 'no_stock'` | `:527-531` |

Note the single-shop branch tests `stores.length === 1` — the size of the *pool*, not the candidate list (`lib/inventory.js:491`).

### 1.6 Two pins that override the routed answer

Both applied after `routeOrder` returns, still before the order row is written:

- **Collection** — no routing runs at all; the chosen shop is used directly, `routing_reason = 'customer_pickup'` (`routes/retail.js:9011-9015`).
- **Out-of-city and outer ship-districts** — for a non-Guangzhou address, or a Guangzhou outer district where the customer did *not* buy same-day, the order is pinned to the configured out-of-city shop (`storefront_config` key `printer.out_of_city_store_id`, `routes/retail.js:9115`, `:21332`). The reason becomes `'out_of_city'` or `'scheduled_ship_district'` and `routed_by_distance` is set to NULL (`routes/retail.js:9114-9129`). The pin is skipped if that shop is itself closed for the channel, so the parcel still ships from somewhere (`:9117-9121`).

### 1.7 One thing the code does that the surrounding comments don't mention

`routeOrder`, `analyzeShortage` and `reserveForOrder` are all called with a hardcoded `channel: 'wechat'` (`routes/retail.js:9032`, `:8870`, `:9022`, `:9526`), while the same handler correctly uses the real `orderChannel` for the closure check at `:9119`. For a **web-shop** order this means the candidate pool's closure filter resolves through `orderChannelKey('wechat')` → `'mini_app'` (`lib/inventory.js:101`), and the reservation counts against the `wechat` channel quota rather than `web`. UNVERIFIED whether this is deliberate — no comment addresses it, and the surrounding code is careful about the distinction elsewhere.

---

## 2. When is it decided

### 2.1 Not at add-to-cart

Nothing in the cart path routes. The only pre-checkout touch is `POST /api/retail/checkout/quote` (`routes/retail.js:26071`), a **preview**. It calls `analyzeShortage` (`:26232-26237`) and builds a `routingPreview` object for the response (`:26250-26290`). It persists nothing, and the whole block is wrapped in a try/catch that only logs (`:26292-26294`) — a routing failure there silently yields no preview and the quote still succeeds. This exists so the mini app can pre-warn the customer, not to decide anything.

### 2.2 At checkout submit, before payment

The decision happens inside `POST /api/retail/orders` (`routes/retail.js:8568`) and is written into the order row in the same transaction as the insert (`routes/retail.js:9397`, `:9423`), while the status is still `pending_payment` (`:9402`). The payment row is created `pending` alongside it (`:9531-9534`).

**So the shop is chosen before the customer has paid.** No payment callback re-routes: `markOrderPaid` (`routes/retail.js:4239`) writes only status, timestamps and the payment row, and none of its callers — WeChat callback (`:4923`), Alipay callback (`:5272`), the status poll (`:4622`), the points/¥0 shortcut (`:4445`), the guest pay link (`:4973`) — touches `store_id`.

### 2.3 Can it change afterwards?

**Automatically: no.** There is no `UPDATE retail_orders … SET store_id` anywhere in `routes/`, `lib/` or `server.js`. The single repo-wide match is the offline repair script `scripts/fix_shipdistrict_orders.js:45`.

**By an operator through the app: no.** See §8.

**Silently inherited: yes, and this is the one to watch.** "Forgot something?" add-ons take `order.store_id` and never re-route (`routes/retail.js:26747-26750`). The commit that added the stock gate for that path says so in its own message ("The add-on inherits order.store_id and never re-routes", `1bcf7925`). An add-on bought hours later is therefore gated against a shop that was chosen for a basket that no longer reflects the order.

---

## 3. Stock shortfall

### 3.1 When a shortage is treated as a problem at all

`requiresStockGate` (`lib/inventory.js:1062-1064`) — shortages only block when the address is in Guangzhou **and** the delivery is same-day. Everything else (outside Guangzhou, or scheduled for a later day) routes with `ignoreStock: true`, never warns and never reserves, because the kitchen restocks before the fulfilment date (`lib/inventory.js:1055-1061`). Collection is the exception: `stockGate` is forced true for it (`routes/retail.js:9004`).

### 3.2 What the customer is asked — the mini app

`analyzeShortage` (`lib/inventory.js:1214-1363`) returns a `gate`. In practice it is only ever `'none'` or `'options_5'`: `lib/inventory.js:1308-1309` sets `options_5` for any non-OK nearest shop, and the comment at `:1304-1307` records that `simple_confirm` is kept only as a defined-but-unreachable fallback. The legacy yes/no modal still exists in the mini app (`miniapp/pages/checkout/checkout.wxml:899-957`) but no server path can trigger it.

The five-option sheet (`miniapp/pages/checkout/checkout.wxml:672-790`) opens when the customer taps Place Order with a shortage pending (`checkout.js:2392-2402`), or reactively when the order POST returns 409 (`checkout.js:2820`, `:3029-3082`). There is deliberately **no inline warning** on the checkout screen — it was removed by request (`checkout.wxml:641-643`).

Header copy (`checkout.wxml:676-683`): EN "Some items out of stock" / CN "部分商品缺货", then "&lt;nearest shop&gt; is out of these. Pick what to do:" and a list of the short items with image and quantity (`:684-694`).

| Option | Copy | Sends | What it does |
|---|---|---|---|
| 1 | EN "Cancel the missing item(s)" / CN "取消缺货商品" — sub "Ship the rest from the nearest store" (`checkout.wxml:703-716`) | `fallback_choice: 'cancel_missing'` (`checkout.js:3093`) | Server drops the short lines and routes the remainder to the nearest shop (`routes/retail.js:8882-8887`). Refuses with 409 `no_items_remaining` if the basket empties (`:8886`). |
| 2 | EN "Replace the missing item(s)" / CN "替换缺货商品" — sub "Pick a substitute · you pay any price difference" (`checkout.wxml:718-731`) | `fallback_choice: 'replace_missing'` + `replacements[]` (`checkout.js:3184-3190`) | Opens a substitute picker per missing item (`checkout.js:3179-3224`) fed by `GET /api/retail/products/:id/substitute-options?store_id=` (`routes/retail.js:1606-1612`). Server requires a replacement for every missing item (`:8901-8905`), checks the substitute is published and in stock at that shop (`:8915`, `:8918`), and re-prices the line at the substitute's price (`:8920-8928`). |
| 3 | EN "Ship from &lt;fallback shop&gt;" / CN "从 … 发整单货" — sub "+N km · ~N min slower · no extra charge" (`checkout.wxml:738-754`) | `fallback_choice: 'full_from_fallback'` (`checkout.js:3108`) | The **whole** order ships from the farther shop (`routes/retail.js:8994`, `lib/inventory.js:507-518`). Only rendered when a fallback shop exists (`checkout.wxml:738`). |
| 4 | EN "Wait for restock" / CN "等补货后发货" — sub "Not in a rush? We ship same-day or next-day once restocked" (`checkout.wxml:756-769`) | `fallback_choice: 'wait_for_restock'` (`checkout.js:3136`) | See §4. |
| 5 | EN "Cancel the whole order" / CN "取消整单订单" — sub "Don't place it · close this dialog" (`checkout.wxml:771-784`) | **nothing** | Purely local: `fbCancelOrder() { this.closeFallbackModal(); }` (`checkout.js:3176`). |

Option 4 adds an interstitial when the customer had picked a hard time slot (`checkout.js:3123-3134`, modal at `checkout.wxml:964-996`): EN "Time slot may not be honored" / CN "时段可能无法保证", warning that the chosen window may not be met and that "any same-day surcharge is refunded". The server honours that promise — `routes/retail.js:9238-9242` clears `scheduled_for`, zeroes the same-day surcharge and relabels the slot "Ships when restocked".

The distance figures shown in option 3 are floored, not raw: a minimum of 1.5 km and 15 minutes, because picking up from a non-preferred shop always costs real time even when the straight-line distance ties (`lib/inventory.js:1331-1346`).

### 3.3 What the customer is asked — the web shop

**Two of the five options, as an inline text line with no item list and no pre-warning.** The entire implementation is `public/shop.html:2714-2721`:

- Prompt: EN "Some items are short at the nearest store: " / CN "部分商品在最近门店缺货："
- Button A: EN "Ship from a nearby store" / CN "从邻近门店发货" → `full_from_fallback`
- Button B: EN "Remove out-of-stock & order" / CN "移除缺货商品并下单" → `cancel_missing`

It is triggered only by the 409 at submit (`public/shop.html:2709`); the web shop never reads the routing preview from the quote. It never names the fallback shop, never shows the distance delta, and never lists which items are short — `coFallback()` takes no arguments and ignores the 409 body. Substitution and wait-for-restock are absent from the file entirely.

### 3.4 What is not offered

- **Split fulfilment across two shops does not exist.** `routeOrder` returns exactly one shop for the whole basket in every branch (`lib/inventory.js:487`, `:492`, `:502`, `:512-517`), its own doc comment says "pick a store that can satisfy ALL items" (`:355-356`), the order carries a single `store_id`, and `VALID_CHOICES` has no split value (`routes/retail.js:8833`). A repo-wide search for split/partial-fulfilment routing found only unrelated matches (team permission arrays, a Meituan import script, and `scripts/fix_partial_shipment_clobber.js`, which repairs tracking rows on an existing order).
- **Partial shipment — shipping the in-stock lines now and the rest later — does not exist.** The wait flow holds the whole order together until every line can be filled (`lib/inventory.js:1443-1447`).
- **Bundles are excluded from the whole flow.** A basket containing a bundle is refused options 1, 2 and 4 with 409 `bundle_no_fallback` (`routes/retail.js:8859-8862`). The mini app has no copy for that code, so it surfaces as a raw error toast (`checkout.js:3006-3010`). UNVERIFIED whether that is intended — no handler or copy exists either way.
- **The `no_stock` case offers nothing.** When nothing can fill the basket, checkout returns 409 `insufficient_stock` (`routes/retail.js:9063-9069`) and the mini app shows a toast with one auto-retry and no options (`checkout.js:2951-2989`). At quote time this path returns a preview with no `gate` key (`routes/retail.js:26263`), so the mini app computes `needsFallback = false` (`checkout.js:1395-1396`) and the customer gets no warning on the checkout screen at all.

---

## 4. The `awaiting_restock` path

### 4.1 The schema comment is stale — confirmed

`database.js:1174-1175` declares the status column and lists seven values:

```
status              TEXT NOT NULL DEFAULT 'pending_payment',
  -- pending_payment | paid | preparing | dispatched | delivered | cancelled | refunded
```

`awaiting_restock` is not there, and neither is `rider_pickup`. Both are real. The admin's canonical list is nine states (`public/retail-admin/03-dashboard.js:3018`). The columns that drive the status were added later by `addColumn` migrations that never revisited the comment (`database.js:3036-3037`).

### 4.2 What puts an order into it

One path only, in two steps.

**Step 1, at checkout.** The customer picks option 4. The server re-runs `analyzeShortage` and refuses if there is no genuine shortage (409 `no_shortage`, `routes/retail.js:8876-8881`) — an anti-tampering check, since the choice arrives from the client. It then records the short product ids as `awaiting_restock_pids` (`:8959`), pins the order to the **nearest** shop with `routing_reason = 'wait_for_restock'` (`:9016-9027`), and inserts the row as ordinary `pending_payment` — **taking no stock reservation at all** (`:9521`, rationale at `:9513-9520`).

**Step 2, at payment.** `markOrderPaid` reads `fallback_choice` and `awaiting_restock_pids` back off the row and, when both are set, writes `status = 'awaiting_restock'` instead of `'paid'` (`routes/retail.js:4244-4255`).

### 4.3 What moves it out

**Automatically, when stock arrives.** `checkAwaitingRestockForRestock` (`lib/inventory.js:1415-1481`) is called from `adjustStock` and only when the stock movement was positive (`:869-871`). For each waiting order at that shop whose `awaiting_restock_pids` includes the restocked product, it:

1. Sums the order's real per-product demand from its line items (`:1430-1436`).
2. Requires **every** product to have enough free stock — `av.available >= qty`, not merely more than zero. The comment records that the old `> 0` check oversold and drove shelf counts negative (`:1437-1447`).
3. Inserts reservation rows **already marked `'committed'`** with a 24-hour expiry, explicitly so the expiry sweeper skips them (`:1448-1457`).
4. Decrements the shelf and writes an `awaiting_restock_release` ledger row (`:1458-1470`).
5. Flips the order to `'paid'`, keeping `awaiting_restock_pids` for audit (`:1472-1475`).

The promoted order ids are handed to a hook (`lib/inventory.js:875-878`) wired at `routes/retail.js:15502-15510` to fire the points, referral and commission awards that `markOrderPaid` skipped.

**Manually, by an operator.** `STATUS_TRANSITIONS` (`routes/retail.js:22703`) allows exactly two moves out (`:22709`, `:22714`), surfaced as two buttons: "Restocked → Start preparing · 已补货 → 开始备货" and "Cancel + refund · 取消并退款" (`public/retail-admin/04-orders.js:2594`). It cannot jump straight to dispatched — that requires `preparing` or `paid` (`routes/retail.js:22711`).

### 4.4 It holds no stock while it waits

Confirmed three ways: no reservation at creation (`routes/retail.js:9521`), no commit at payment (`:4319`), and the promotion code's own note — "awaiting_restock orders hold no reservation, so av.available is the true free stock" (`lib/inventory.js:1441-1442`).

**One asymmetry worth flagging for the redesign.** The automatic promotion gates on `available >= qty` (`lib/inventory.js:1443-1447`). The manual "Restocked → Start preparing" route goes through `commitUnreservedOrder` (`lib/inventory.js:640-674`), which performs **no availability check at all** before decrementing (`:655`, `:663-664`). An operator who clicks it prematurely drives the shelf negative, where the automatic path would have declined.

### 4.5 What the customer sees

Nothing useful in the mini app: `STATUS_LABELS_EN`/`_CN` omit `awaiting_restock` (`miniapp/pages/order/order.js:18-35`) and the render falls through to the raw code (`:566`), so the customer is shown the literal string `awaiting_restock`. The web shop does have a label — EN "Awaiting restock" / CN "等待补货" (`public/shop.html:2890`) — with its own chip style (`:1215`). The mini app's payment poller does at least treat the status as success (`miniapp/pages/alipay-pay/alipay-pay.js:152`).

---

## 5. Reservation timing

### 5.1 When stock is held

At **order creation**, inside the same transaction as the order insert — not at payment (`routes/retail.js:9521-9529`). Skipped in exactly two cases: the wait-for-restock flow, and any order where the stock gate is off (outside Guangzhou, or scheduled for a later day).

The hold lasts `storefront_config` key `inventory.reservationTtlMinutes`, defaulting to **15 minutes** (`lib/inventory.js:29`, `:73-82`, expiry computed at `:545-546`).

A shortage at this point throws and rolls back the whole order transaction, surfacing as a 409 (`lib/inventory.js:566-583`, `routes/retail.js:9587-9594`). The one exception is the paid add-on path, which passes `allowPartial: true` because the charge has already settled and cannot be refused (`lib/inventory.js:538-543`, `routes/retail.js:26747-26750`).

### 5.2 What releases it

| Situation | What happens | Where |
|---|---|---|
| Customer abandons, never pays | Sweeper marks reservations `'expired'` and auto-cancels the order with `cancelled_reason = 'reservation_expired'` | `lib/inventory.js:912-946`, run every 60 s from `server.js:863` (first tick 5 s after boot, `lib/inventory.js:990-991`) |
| Abandoned order that never reserved | A separate flat-time sweeper cancels `pending_payment` orders older than `orders.autoCancelHours` (default 6) and releases any holds. It exists precisely because un-gated orders are invisible to the reservation sweeper | `routes/retail.js:6844`, `:6896`, rationale at `:6827-6830` |
| Same customer orders again | Their earlier unpaid orders holding stock on a product in the new basket are cancelled and released as `'superseded_by_new_order'` | `routes/retail.js:6916`, fired from checkout at `:9628-9631` |
| Payment fails | **No dedicated handler exists.** The callbacks only act on success; an amount mismatch returns an error without touching the order (`routes/retail.js:4915-4927`, `:5265-5267`). A failed payment therefore degenerates into the abandonment case above | — |
| Order cancelled while unpaid | `releaseOrderReservations` marks holds `'released'` and **does not touch the shelf count** | `lib/inventory.js:698-709`; callers `routes/retail.js:16651`, `:23037` |
| Paid order cancelled | Different branch — `reverseCommittedOrder` adds the quantity back and writes an `order_reverse` ledger row, leaving the reservation rows `'committed'` for audit | `routes/retail.js:23050-23072`, `lib/inventory.js:716-748` |
| Payment succeeds | `commitOrderReservations` marks holds `'committed'`, **decrements the shelf**, writes an `order_commit` ledger row and pushes a channel sync. Idempotent, so a retried callback is a no-op | `lib/inventory.js:599-629`, called at `routes/retail.js:4322` |

Orders that never reserved decrement later, through `commitUnreservedOrder` (`lib/inventory.js:640-674`) — triggered when a Guangzhou order is paid (`routes/retail.js:4338-4340`), at the first forward transition into preparing/dispatched/delivered (`:22962-22964`), or when a waybill is pasted (`:22323`). Out-of-Guangzhou orders are deliberately not decremented on payment so the warehouse keeps its restock window (`routes/retail.js:4330-4336`).

**UNVERIFIED:** whether points, vouchers and wallet balance are ever returned on an order cancelled by the *reservation* sweeper. Those reversals live only in the 6-hour sweeper (`routes/retail.js:6893-6895`), and since the reservation sweeper flips the status to `cancelled` first, the later sweeper's `WHERE status = 'pending_payment'` can no longer match it. No other caller of the reversal was found, but this was not traced end to end.

---

## 6. Delivery vs collection

The rule is not merely different — **collection does not use the router at all.**

### 6.1 Collection

The customer picks the shop. `routes/retail.js:9011-9015` assigns it directly with `routing_reason = 'customer_pickup'`; no distance, no zone, no district, no fallback. The fallback machinery is explicitly forced off for collection (`routes/retail.js:8829-8832`).

The list they pick from is `is_active = 1 AND pickup_enabled = 1`, minus shops closed business-wide or closed on both online channels, ordered by `sort_order` (`routes/retail.js:824-830`, `lib/inventory.js:148-158`). It is re-checked at submit, because a shop can close between loading the list and pressing pay — and a collection is the one fulfilment that cannot be rerouted, since the customer is walking to that door (`routes/retail.js:8641-8648`).

Collection always gates stock, even when a delivery in the same circumstances would not (`routes/retail.js:9004`, rationale at `:9001-9003`) — so it always takes a real reservation.

The customer checkout recognises only two fulfilment types: `isPickup` is `body.fulfillment_type === 'pickup'` and everything else is a delivery (`routes/retail.js:8622`). A third type, `counter`, exists but only on the staff-created path — see §8.4.

### 6.2 How `retail_stores.timezone` is used

At submit, the chosen shop's own hours and zone are passed into `resolvePickupTime` (`routes/retail.js:8651-8653`):

```
const pk = resolvePickupTime(body.pickup_time, new Date(), {
  open: pickupStore.open_time, close: pickupStore.close_time, timezone: pickupStore.timezone,
});
```

Inside (`routes/retail.js:7843-7873`): the chosen moment must be in the future, no more than 30 days out, and at least `pickup.leadMinutes` away (`:7852-7853`). The window is the **shop's** hours when both are set, otherwise the single business-wide `pickup.window` config (`:7856-7858`). The time-of-day comparison is done in the shop's zone via `localPartsInTz` (`:7807-7835`), which uses `Intl.DateTimeFormat` and degrades to the host clock on a bad or absent zone string — so existing China shops behave exactly as before (`:7804-7806`). Outside the window returns `pickup_time_outside_hours` (`:7863`).

**Two gaps in that mechanism, both verified:**

1. **The customer's picker doesn't know the shop's hours.** `/api/retail/pickup-stores` selects `id, code, name_en, name_cn, address, city, district, lat, lng, phone` — no `open_time`, `close_time` or `timezone` — and returns the single global `pickup.window` alongside (`routes/retail.js:825-831`). So the mini app builds its time slots from the business-wide window while the server validates against the shop's own. A shop whose hours are narrower than the global window can offer the customer a time that submit then rejects.
2. **Rescheduling ignores the shop entirely.** `routes/retail.js:16727` calls `resolvePickupTime(body.pickup_time, now)` with **no** third argument, so it falls back to the global window and the host clock. The comment directly above says it "re-validates against the pickup hours" (`:16725-16726`) — the code validates against the *global* hours, not the shop's. Following the code: a collection order can be rescheduled to a time outside the shop's own opening hours.

### 6.3 Do opening hours affect which shop is chosen?

**No.** `open_time` and `close_time` are selected into the store list (`lib/inventory.js:88`) and then never read anywhere in `lib/inventory.js` — the only occurrence of either name in the file is that SELECT. `timezone` is not even in the list. Routing removes a shop from consideration only via `is_active` and the two manual closed toggles. A shop that is simply shut for the night remains a full routing candidate.

---

## 7. Channel orders

**Orders arriving from an external channel are never routed. The fulfilling shop is fixed by the channel-to-shop mapping**, and stock is decremented at that shop immediately on import — no reservation, no commit step.

| Channel | Who decides the shop | Where the id comes from | Stock on import |
|---|---|---|---|
| Meituan 外卖 | Fixed | The Meituan account the order was polled from. `scripts/meituan-daemon.js:374-389` enumerates active shops and their per-shop credentials, then passes `{storeId, storeCode}` through to the ingest POST (`:449`, `:475-480`) | Decremented at once (`routes/meituan-internal.js:217-233`), clamped at 0. Cancels restore it (`:366-379`) |
| Meituan 闪购 | Fixed | `SHANGOU_STORES` env (default `yuexiu`, `scripts/shangou-daemon.js:47`) → `SELECT id FROM retail_stores WHERE code = ?` (`:190-193`) → same ingest endpoint (`:500-503`) | Same as 外卖 — same endpoint |
| Eleme | Fixed | The `eleme_shops` mapping table: `retail_stores s JOIN eleme_shops e ON e.retail_store_id = s.id` (`scripts/eleme-daemon.js:139-148`). The row is written by an operator picking the Eleme shop (`routes/eleme-admin.js:107-116`) | Decremented at once (`routes/eleme-internal.js:117-130`) |
| Guanyi / gzgrocery | Fixed, effectively single-shop | `GZGROCERY_STORE_ID` env wins; otherwise `GZGROCERY_STORE_CODE` (default `'tianhe'`) resolved through the Guanyi mapping table (`scripts/gzgrocery-order-daemon.js:51`, `:120-128`) | Decremented **before** the mirror order row is written (`:336-350`), guarded by a `decremented` flag. Voids reverse it (`:364-372`) |
| WeChat mini app | `routeOrder` | `lib/inventory.js:370` via `routes/retail.js:9029` | Not decremented — soft reservation only, commits on payment |
| Web shop | `routeOrder` | Same endpoint; channel whitelisted to `'web'` at `routes/retail.js:8608` | Same as the mini app |

The ingest endpoints take the shop id straight from the request body and reject a missing one (`routes/meituan-internal.js:148-150`, `routes/eleme-internal.js:83-84`). None of them writes `routing_reason`, so every channel order has it NULL.

`scripts/guanyi-daemon.js` and `routes/guanyi-admin.js` never touch `retail_orders` at all — they only push stock and manage the product mapping.

**On the comment at `lib/inventory.js:99-100`** ("routeOrder only ever runs for these two (Meituan/gzgrocery orders arrive via their daemons, not routeOrder)"): its substance is correct — a repo-wide search finds `routeOrder` called only inside `lib/inventory.js`, at `routes/retail.js:9029`, and in two verification scripts (`scripts/test-fulfillment-reroute.js:16`, `scripts/verify-closed-store-routing.js:115`). But it is incomplete in two ways. It predates Eleme, which is a third daemon-fed fixed-shop channel that also bypasses routing. And "only ever runs for these two" overstates the case even within the customer endpoint: collection, wait-for-restock, the out-of-city pin and the staff-created manual order all set `store_id` on that path without `routeOrder` deciding it.

---

## 8. Operator override

### 8.1 Staff cannot move a placed order to a different fulfilling shop

There is no endpoint and no screen. Verified by exhaustion:

- No `UPDATE retail_orders … SET store_id` exists in `routes/`, `lib/` or `server.js`. The only repo-wide match is the offline script `scripts/fix_shipdistrict_orders.js:45`.
- The one dynamic status-update builder assembles its column list from a fixed set — status, timestamps, payment method, cancelled reason, staff note, refund status — with no shop branch (`routes/retail.js:22914-22935`).
- `routes/retail-inventory.js` contains no reference to `retail_orders` at all.
- A request-body `store_id` is accepted in only three places, none of them a reassignment: order creation (`routes/retail.js:19023-19030`), a test print (`:21692`) and choosing a reprint printer (`:21723`).
- In the admin order drawer, "Fulfilled by · 出货门店" is read-only text with no control (`public/retail-admin/04-orders.js:4433-4439`).

The admin does contain three shop `<select>` controls, and none of them reassigns an order: two are list **filters** — the dashboard's (`public/retail-admin.html:2016`) and the orders list's (`:2237`) — and the third, `#onw-store` (`:2823`), sets the shop on the create-order page at the moment an order is *created*, not afterwards (`public/retail-admin/04-orders.js:7553`).

### 8.2 What does exist: the Qingyun "ships from" move

One operator action changes a physical location on a live order, and it is explicitly **not** a change of fulfilling shop. `POST /api/retail-admin/orders/:id/qingyun/ship-from` (`routes/retail.js:21027`), UI at `public/retail-admin/04-orders.js:3536-3684`.

Reading the handler through: it requires a target shop code (`:21029`), refuses same-shop, unknown or unconnected targets (`:21032-21038`), refuses cancelled/refunded/delivered orders (`:21040-21048`), refuses once a rider is already on it (409 `courier_already_called`, `:21049-21050`), then creates a new delivery job at the target shop (`:21062-21070`) — and only on success supersedes the old job (`:21086-21091`), deletes the old Qingyun copy (`:21098`), repoints the push queue (`:21099-21104`) and logs the move with both shop codes and the operator (`:21116-21125`).

**What happens to stock at the original shop: nothing. It stays there, by design and by explicit statement.** The only tables written are `delivery_jobs`, `qingyun_push_queue` and `qingyun_sync_log` — verified by listing every write in the handler. `retail_orders.store_id`, `retail_store_stock`, `retail_stock_reservations` and `retail_stock_ledger` are untouched. The UI says so to the operator's face (`public/retail-admin/04-orders.js:3540-3546`):

> "Collected here, but the order still counts against &lt;original shop&gt; for stock and reports."

So after this move a rider collects goods from a shop whose shelf was never debited, while the hold or decrement sits at the original shop. The system does not model that transfer. That is a deliberate, documented limitation rather than a bug — but it is exactly the kind of thing a locations redesign should decide whether to keep.

Capability: the route is gated by `requireRetailAdmin` (`routes/retail.js:21027`), and the capability map sends any non-GET `/api/retail-admin/orders*` to `orders:edit` unless it matches the dispatch or refund paths (`lib/cap-routes.js:42-52`). `ship-from` matches neither, so moving the collection point needs the same capability as editing an order note. Note that capability enforcement only runs when `tenants.rbac_enforce` is on (`lib/cap-routes.js:3-5`), which is off by default.

### 8.3 `routing_reason = 'manual'` is never written

`database.js:2649` lists `'manual'` among the column's values and the admin has a decoder for it — "manually routed · 手动改派" (`public/retail-admin/04-orders.js:2040`). **No code anywhere assigns it.** The only INSERT that writes the column is customer checkout (`routes/retail.js:9397`, `:9423`), whose value can only be `customer_pickup`, `wait_for_restock`, `cancel_missing`, `replace_missing`, `nearest`, `only_store`, `fallback_no_stock`, `out_of_city` or `scheduled_ship_district`. The staff-created manual order sets `source = 'manual'` and takes `channel` from the payload but omits `routing_reason` entirely (`routes/retail.js:19121-19137`), leaving it NULL even though the operator hand-picked the shop. Channel imports omit it too. The admin's decoder is dead code.

The decoder is also silent on most real values: it renders a note only for `fallback_no_stock`, `manual` and `out_of_city` (`public/retail-admin/04-orders.js:2037-2042`). `wait_for_restock`, `cancel_missing`, `replace_missing`, `scheduled_ship_district` and `customer_pickup` all display nothing.

### 8.4 The staff-created order: no routing, and the shop is optional

`POST /api/retail-admin/orders` (`routes/retail.js:18942`) never calls `routeOrder`. The operator's `store_id` is taken from the request body and written straight through — but **it is optional**: when absent the order is inserted with `store_id = NULL`, and only an id that *was* sent has to resolve to a real shop (`routes/retail.js:19023-19030`). The comment gives the reason: a phone order taken before routing is decided has no shop yet. Nothing later assigns one, so such an order stays shopless until someone edits it — and there is no screen that can (§8.1).

This path also carries the only third fulfilment type. `ORDER_FULFILLMENT_TYPES` is `['delivery', 'pickup', 'counter']` (`routes/retail.js:18940`); `counter` never appears on the customer path, which branches on `pickup` versus everything else (`:8622`).

As of `1d8e95ad` this endpoint requires `fulfillment_type` (`:19039-19044`) and binds the address rule on every request — delivery must have an address, pickup and counter must not (`:19067-19077`). The same commit moved customer creation inside the order's transaction (`:19110-19118`, helper at `:13974`). None of this changes routing; it is recorded here because it is the path that sets `store_id` by hand.

---

## 9. What depends on location fields

Every column the routing and fulfilment logic actually reads. **Anything in the "load-bearing" rows must survive the locations redesign.**

### 9.1 `retail_stores` columns — load-bearing

| Column | Read by | Consequence if it changes or disappears |
|---|---|---|
| `id` | Everything. Written to `retail_orders.store_id`, `retail_store_stock`, reservations, ledger, all channel mapping tables | Total. |
| `code` | The closure lookups, which key on code not id: `channel_status.store_code`, `store_business_status.store_code` (`lib/inventory.js:112`, `:127`, `:151-155`). Also the collection re-check (`routes/retail.js:8647`), Qingyun queueing (`:4232-4235`), the ship-from move, and every channel daemon | A shop whose code changes silently stops matching its own open/closed rows — and nothing errors, because the lookups are by string. |
| `is_active` | The candidate pool (`lib/inventory.js:85`), the collection list (`routes/retail.js:828`), the out-of-city pin (`:9120`) | Removes the shop from all routing. |
| `lat`, `lng` | Proximity ranking, both Haversine and road (`lib/inventory.js:314-315`, `:336-337`); the district-centroid fallback (`:1189-1198`) | Without them a shop sorts to the bottom of the distance ranking and can only be reached by the coarse tiers. |
| `district` | Tier-3 home-district match (`lib/inventory.js:435`, `:1273`); shown in shortage modals (`routes/retail.js:26276`) | Loses the district fallback for un-geocoded addresses. |
| `sort_order` | The base ordering of `listStores` (`lib/inventory.js:90`), which tier 4 inherits; the collection list order (`routes/retail.js:829`) | Only decisive for un-geocoded addresses with no zone and no district match — see §1.3. |
| `pickup_enabled` | The collection list and the submit re-check (`routes/retail.js:828`, `:8642`) | Shop stops being offered for collection. |
| `open_time`, `close_time`, `timezone` | **Collection-time validation only** (`routes/retail.js:8651-8653` → `:7855-7863`). Not read by routing. Note `timezone` is *not* in `listStores` (`lib/inventory.js:87-89`) — the collection path gets it from a direct `SELECT *` (`routes/retail.js:8641-8642`) | Loses per-shop collection hours; everything falls back to the global window and the host clock. |
| `city`, `address`, `phone` | Synthesised into the order's address snapshot for collection orders (`routes/retail.js:8659-8663`) | Collection orders lose their printed pickup address. |
| `name_en`, `name_cn` | Shortage modals (`routes/retail.js:26274-26275`), admin order drawer, the ship-from note | Display only. |

### 9.2 `retail_stores` columns the routing does **not** read

`low_stock_threshold` and `meituan_account_id`. Neither appears in any routing or fulfilment decision — `meituan_account_id` is selected into the store list (`lib/inventory.js:88`) and displayed, but the Meituan daemon resolves shops by `code` plus environment credentials instead.

### 9.3 Other tables and config the routing depends on

| Source | Fields | Used for |
|---|---|---|
| `retail_delivery_zones` | `preferred_store_id`, `zone_type`, `match_district`, `match_city`, `is_active` | Tier-2 fallback (`lib/inventory.js:417-426`) |
| `retail_delivery_zones` | `day_only`, `same_day_surcharge` | Deciding an outer "ship-district" that pins to the out-of-city shop (`lib/inventory.js:1079-1090`) |
| `channel_status` | `channel`, `store_code`, `is_open` | Per-channel closures (`lib/inventory.js:127`, `:151-155`) |
| `store_business_status` | `store_code`, `fulfillment_open` | Business-wide closures (`lib/inventory.js:112`) |
| `retail_store_stock` | `physical_qty`, `safety_buffer`, `wechat_quota`, `meituan_quota` | Availability scoring (`lib/inventory.js:260-295`) |
| `storefront_config` | `printer.out_of_city_store_id` | The out-of-city pin (`routes/retail.js:9115`, `:21332`) |
| `storefront_config` | `inventory.reservationTtlMinutes` (default 15) | Hold duration (`lib/inventory.js:73-82`) |
| `storefront_config` | `pickup.window`, `pickup.leadMinutes` | Collection-time validation fallback (`routes/retail.js:7852`, `:7858`) |
| `eleme_shops` | `retail_store_id`, `shop_id` | Fixing the shop for Eleme orders (`scripts/eleme-daemon.js:139-148`) |
| Environment | `GZGROCERY_STORE_ID` / `GZGROCERY_STORE_CODE`, `SHANGOU_STORES`, `MEITUAN_<CODE>_USER/_PASS` | Fixing the shop for the daemon-fed channels (§7) |

### 9.4 The one field the redesign is most likely to break

**`code`.** It is the join key for every closure lookup, every channel mapping table and every daemon — all by string, none with a foreign key. It is also immutable today: it is not in the store update allowlist (`routes/retail-inventory.js:127`), so nothing can change it through the app. If a consolidated locations model regenerates or renames codes, routing will not error — it will simply stop finding the closure rows and start treating closed shops as open.

---

## Items marked UNVERIFIED

1. **The hardcoded `channel: 'wechat'` for web-shop orders** (`routes/retail.js:9032`, `:8870`, `:9022`, `:9526`). The behaviour is confirmed — a web order routes and reserves against the wechat channel — but whether it is deliberate is not settled by any comment.
2. **Points, vouchers and wallet balance on a reservation-expired order** (§5.2). The reversal helpers live only in the 6-hour sweeper, which can no longer match an order the 15-minute sweeper already cancelled. No other caller was found, but the full reversal path was not traced end to end.
3. **`bundle_no_fallback` having no customer-facing copy** (`routes/retail.js:8861`, mini app falls through to a generic error toast at `checkout.js:3006-3010`). Whether that is an intentional dead end or an oversight is not determinable from the code.
4. **The web shop's `co.fallback` persistence** (`public/shop.html:2725`). It is cleared only when payment starts, so a retry that fails with `no_shortage` would carry the stale choice into the next attempt. This is a code-reading inference, not an observed failure.
5. **`routes/retail.js` was not read end to end.** The file is roughly 28,000 lines. It was searched exhaustively for `routeOrder`, `analyzeShortage`, `store_id`, `routing_reason`, `reserveForOrder`, `awaiting_restock`, `pickup`, `fallback_choice`, `fulfillment_type` and the reservation helpers, and every matching region was read.
