# Tacet delivery status — the complete fulfilment vocabulary, as implemented

**2026-08-02 · Read-only survey of every delivery/fulfilment status, every delivery-related time label, every transition and every translation across the admin, the mini app, the web store, the printed slip and the notification pipeline. Written before a single product-wide definition set is locked. Every claim is cited to a file and line. Where the code does not settle a question the entry says UNVERIFIED and why. No row data was read. No file was changed except this one. `public/app.html.bak` was ignored throughout.**

> **What this document is: a SURVEY, not a specification.** It records the vocabulary that exists today, grown one channel at a time. Nothing below is a recommendation, and no entry may be read as a Tacet default (`docs/tacet-consolidation-decisions.md` §0). Where a word appears in two places with two meanings, both are reported; neither is endorsed.

Terms used below, one line each:

- **Fulfilment type** — `retail_orders.fulfillment_type`: `delivery` | `pickup` | `counter` (`lib/fulfilment.js:18`). What the customer does to get the goods.
- **Order status** — `retail_orders.status`. The one lifecycle every channel is squeezed into.
- **Shipment state** — a per-parcel state derived from timestamps on `retail_shipments`. Not stored.
- **Tracking status** — a normalised courier-event code from 快递100/JD (`lib/tracking.js`).
- **Tracking scenario** — *how* a delivery ended (locker, doorstep, pickup point…), classified from Chinese event text.
- **Courier stage** — the live Qingyun (青云聚信) rider stage, computed from two raw platform enums.
- **Channel status** — the verbatim Chinese status label a read-only platform (Meituan 外卖/闪购, gzgrocery) reports for an order we mirror but do not fulfil.
- **Estimate vs actual** — a *promised/predicted* future time vs a *recorded* event time. Six separate mechanisms below produce one or the other, and four of the surfaces do not distinguish them in their label.

---

## Summary — what a consolidation has to reconcile

**There is no single delivery status vocabulary. There are six, layered on top of each other, none of them authoritative, and the UI picks a different one per surface per row.** An order in flight can simultaneously carry an order status of `dispatched`, a shipment state of `pending`, a tracking status of `out_for_delivery`, a courier stage of `heading_to_pickup`, and a channel status of `骑手已接单` — and the Orders list, the drawer header, the dashboard and the mini app each read a different one of those five as "the" status.

The obstacles, most damaging first:

1. **`retail_orders.status` has nine values, but the schema documents seven.** `database.js:1179-1180` declares a plain `TEXT` column (no `CHECK`) and comments the seven-value set. Two more are live: `rider_pickup` (written by the Meituan mirror, `routes/meituan-internal.js:123`) and `awaiting_restock` (written on payment, `routes/retail.js:4251`). Neither appears in the schema comment, and the mini app has no label for either — it prints the raw internal value to the customer. §1.1, §5.4.
2. **The word "arrival" is used for an estimate.** The Orders Delivery column labels a *future, promised* ETA as `arrival` / `预计送达` (`public/retail-admin/04-orders.js:2428` for platform orders, `:2441` for same-city). The EN half asserts a past event; the CN half correctly says "estimated delivery". They are not the same claim. §2.1.
3. **Two different EN labels share one CN string, in the same six lines.** `arrived` → `已送达` (actual), `ETA` → `预计送达` (estimate on a landed order), `arrival` → `预计送达` (estimate in flight) — `04-orders.js:2425-2428`. In Chinese view the estimate-in-flight row and the estimate-after-landing row are typographically identical and neither is distinguishable from the other. §5.2.
4. **The mini app keeps showing "Estimated arrival" after the order is delivered.** The ETA banner is gated on `wx:if="{{etaLabel}}"` with no status guard (`miniapp/pages/order/order.wxml:48`), and the server hands `delivery_eta` back unconditionally (`routes/retail.js:10069-10077` — the query filters on `mode='local'` and a non-empty `local_eta`, never on status). A delivered order shows a promise, not a record. §2.5.
5. **`dispatched` is shown with four different words.** "Dispatched" (admin pill, `04-orders.js:2564`), "On the way" (mini app + web store, `miniapp/pages/orders/orders.js:19`, `public/shop.html:2889`), "Out for delivery" (customer timeline, `routes/retail.js:10465`), and "Ready · 可取货" when the order is a pickup (`04-orders.js:2561`). §5.1.
6. **"Rider coming" names two different stages, and is untranslated in the one place it is a status.** `heading_to_pickup` ("rider is going to the store") reads "Rider coming" in the order drawer and the orders list (`04-orders.js:3232`, `:2371`); `awaiting_dispatch` ("no rider has taken it yet") also reads "Rider coming" on the dashboard's Ready-to-hand-off tile (`03-dashboard.js:1019`). Separately, the `rider_pickup` status chip is hardcoded English with no `· 中文` pair (`public/retail-admin.html:2218`) and the **inline** i18n dictionary — the one that actually runs — has no entry for it (`retail-admin.html:11502-11513`), while the dead fallback copy does (`10-extras.js:626`). §4.2, §5.2.
7. **The customer notification pipeline is fulfilment-blind.** `ORDER_STATUS_NOTIF` (`routes/retail.js:5725-5732`) maps status → message with no reference to `fulfillment_type`, so a **pickup** customer is told "Your order has shipped / 订单已发货" when staff mark it ready at the counter, and "Your order was delivered / 订单已送达" when they collect it themselves — while the timeline on the very same screen says "Ready to collect / 可取货" and "Collected / 已取货" (`routes/retail.js:10456-10457`). §1.6, §5.1.
8. **Two of the nine normalised tracking codes are dead or half-dead.** `placed` ("Label created / 已下单", `lib/tracking.js:40`) is never produced by any classifier — not `kd100StateToCode`, not `statusFromEventText`, not `deriveStatusFromOrder`. `arrived_local` ("At local hub / 到达派送区", `:43`) IS produced (`:116`) but `deliveryStateInfo` has no branch for it (`04-orders.js:2257-2277`), so it renders nothing in the orders list. The schema comment lists eight codes and omits `arrived_local` entirely (`database.js:2781`). §1.3, §3.5.
9. **Five statuses are stamped by automated sweeps that bypass the declared transition table.** `STATUS_TRANSITIONS` (`routes/retail.js:22923-22936`) is the explicit, guarded map used by the admin endpoint — and it contains no entry for `rider_pickup` at all, in either direction. Three timer/poll sweeps write `status` with raw SQL instead (`routes/retail.js:6672-6679`, `:6823-6851`, `routes/meituan-internal.js:422-429`), and all three list `rider_pickup` in their `WHERE status IN (…)`. So an order can *enter* `rider_pickup` and *leave* it, but never via the transition table that claims to be the single source of truth. §3.2, §3.3.
10. **Amber is doing the work of four different meanings and one badge uses pure red.** `pending_payment`, `preparing`, `dispatched` and `awaiting_restock` all resolve to `--td-amber` `#C9954A` (`public/retail-admin.css:57-69`), so the status pill carries no information across the whole middle of the lifecycle. Meanwhile the AIR DELAYED badge uses `var(--danger)` `#e8556a` (`04-orders.js:2471`, `retail-admin.css:48`) — a pure red, which `docs/tacet-design-system.md:29` rules out ("Never pure red"); every other error state on the page uses Brick `#B4533E`. §5.3.

---

## 1. Status definitions

### 1.1 `retail_orders.status` — the order lifecycle (all fulfilment types share it)

Declared `TEXT NOT NULL DEFAULT 'pending_payment'` at `database.js:1179`, with **no `CHECK` constraint** — any string is storable. The schema comment (`database.js:1180`) lists seven values. Nine are actually written.

| Internal value | In schema comment? | Admin label (EN) | Admin label (CN) | Set by |
|---|---|---|---|---|
| `pending_payment` | yes | `Pending` (`04-orders.js:2564`) | `待付款` (dict, `retail-admin.html:11506`) | order INSERT (default) |
| `paid` | yes | `Paid` | `已付款` (`:11507`) | `markOrderPaid` (`routes/retail.js:4251` region), admin PATCH |
| `preparing` | yes | `Preparing` | `备货中` (`:11508`) | admin PATCH, restock auto-advance |
| `rider_pickup` | **NO** | `Rider coming` (`04-orders.js:2564`) | **none in the live dict** — see §4.2 | Meituan mirror only (`routes/meituan-internal.js:123`) |
| `dispatched` | yes | `Dispatched` | `已发货` (`:11509`) | admin PATCH, waybill attach, Qingyun pickup sweep |
| `delivered` | yes | `Delivered` | `已送达` (`:11510`) | admin PATCH, 3 auto-sweeps, counter-terminal flip |
| `cancelled` | yes | `Cancelled` | `已取消` (`:11512`) | admin PATCH, stale-unpaid sweep |
| `refunded` | yes | `Refunded` | `已退款` (`:11513`) | admin PATCH, refund payout |
| `awaiting_restock` | **NO** | `Awaiting restock` | `等待补货` (`:11511`) | `markOrderPaid` when the customer chose "wait for restock" (`routes/retail.js:4247-4251`) |

Timestamp columns, one per milestone: `placed_at`, `paid_at`, `preparing_at`, `dispatched_at`, `delivered_at`, `cancelled_at` (`database.js:1205-1211`). There is **no** timestamp for `rider_pickup` or `awaiting_restock`.

**Shared or per-method?** **Shared, with relabelling.** One status column serves rider delivery, courier delivery, pickup and counter. The differences are applied at render time only:

- **Pickup** reuses `dispatched` = "ready at the counter" and `delivered` = "collected", relabelled in three separate places: the admin pill (`04-orders.js:2560-2563` → `Ready · 可取货` / `Picked up · 已取货`), the admin transition buttons (`04-orders.js:2617-2620` → `Mark ready for pickup · 标记可取货` / `Mark picked up · 标记已取货`), and the customer timeline (`routes/retail.js:10450-10458` → `Ready to collect · 可取货` / `Collected · 已取货`). Three relabellings, three different word choices for the same two states.
- **Counter** reaches `delivered` the moment it is paid (`lib/fulfilment.js:65-67`, applied at `routes/retail.js:4281-4289`) and is relabelled `Completed · 已完成` (`04-orders.js:2554-2556`; timeline `routes/retail.js:10443`). The design note at `lib/fulfilment.js:60-64` is explicit that this is a **third label on one state, not a fourth state**.
- **Rider vs courier** are **not** distinguished at the status level at all. The distinction lives in `retail_shipments.mode` (§1.2) and is inferred at render time from `o.is_local` (`routes/retail.js:19584-19585` — literally "does this order have a `mode='local'` shipment row").

### 1.2 `retail_shipments` — per-parcel mode and state

`mode` is stored `TEXT NOT NULL` (`database.js:2902`), commented `'local' | 'air' | 'land'`; a fourth value `'supplier'` is live in the UI (`04-orders.js:2999`, `:3048`). Labels at `04-orders.js:2995-3000`:

| `mode` | Label |
|---|---|
| `local` | `Local delivery · 同城配送` |
| `air` | `Air · 空运` |
| `land` | `Land · 陆运` |
| `supplier` | `Supplier-direct · 供应商直发` |

`state` is **derived, never stored** — `s.delivered_at ? 'delivered' : (s.dispatched_at ? 'dispatched' : 'pending')` (`routes/retail.js:10040`). Labels at `04-orders.js:2981-2985`:

| `state` | Label |
|---|---|
| `pending` | `Not shipped · 未发货` |
| `dispatched` | `Dispatched · 已发货` |
| `delivered` | `Delivered · 已送达` |

Split-order rollup words (orders list, `04-orders.js:2489-2496`): `N delivered · 已签收`, `N in transit · 运输中`, `N to ship · 待发货`, `N parcels · 个包裹`. Note `delivered` here renders **已签收** (signed for), not **已送达** (arrived) — the same English word, a different Chinese word, two lines apart from `shipmentStatePill`.

### 1.3 `tracking_status` — normalised carrier codes (courier/shipped only)

Defined once, `lib/tracking.js:39-51`. **Nine** codes; the schema comment at `database.js:2781` lists **eight** (omits `arrived_local`).

| Code | `label_en` | `label_cn` | Produced by | Rendered where |
|---|---|---|---|---|
| `placed` | Label created | 已下单 | **nothing — dead** (§3.5) | — |
| `picked_up` | Picked up | 已揽收 | kd100 state 1, text `已揽收\|揽收成功\|已取件` (`:118`) | mini-app pill; list line (`04-orders.js:2276`, own EN/CN pair "Picked up / 已揽收") |
| `in_transit` | In transit | 运输中 | kd100 0/7/10/11/12, `deriveStatusFromOrder('dispatched')` (`:92`) | mini-app pill; list line (`:2275`) |
| `arrived_local` | At local hub | 到达派送区 | text rule `:116` | **nowhere in the admin list** — `deliveryStateInfo` has no branch (§3.5) |
| `out_for_delivery` | Out for delivery | 派送中 | kd100 5, text `:115` | mini-app pill; list line (`:2273-2274`) |
| `delivered` | Delivered | 已签收 | kd100 3, text `:113`, `deriveStatusFromOrder('delivered')` | mini-app pill; list line (`:2272`, "Delivered / 已签收") |
| `exception` | Delivery issue | 配送异常 | kd100 2/13/14, text `:114` | list line (`:2265`, "Delivery issue / 配送异常") |
| `returning` | Returning to sender | 退回中 | kd100 6, text `:112` | list line (`:2266`) |
| `returned` | Returned | 已退回 | kd100 4, text `:111` | list line (`:2267`) |

Written to `retail_orders.tracking_status` and `retail_shipments.tracking_status` in ~12 places (`routes/retail.js:8319`, `:8695`, `:10524`, `:22061`, `:22075`, `:22419`, `:22439`, `:22553`, `:22733`, `:22745`; cleared at `:20731`, `:22777`, `:22788`).

### 1.4 `tracking_scenario` — how the delivery ended (courier only)

`lib/tracking.js:139-205`, seven codes, each with its own EN/CN pair, an emoji icon and an `urgency` band:

| Code | icon | `label_en` | `label_cn` | urgency |
|---|---|---|---|---|
| `pickup_point` | 🏪 | Delivered to pickup point | 已送达驿站 | `action_needed` |
| `locker` | 📦 | Delivered to locker | 已存入快递柜 | `action_needed` |
| `proxy` | 👥 | Signed by someone else | 他人代收 | `info` |
| `left_at_door` | 🚪 | Left at your door | 已放门口 | `info` |
| `in_person` | 👤 | Delivered to you in person | 已本人签收 | `info` |
| `no_contact` | 📞 | Courier can't reach you | 快递员联系不上你 | `urgent` |
| `out_for_delivery` | 🛵 | Out for delivery | 派送中 | `transit` |

The admin orders list re-labels three of these with **different words** rather than reusing `label_en`/`label_cn` — `04-orders.js:2264` (`Can't reach customer / 联系不上客户`), `:2269` (`At pickup point / 已到驿站`), `:2270` (`In a locker / 已入快递柜`). The other four scenarios have no admin representation.

> Note: the emoji icons here are the **only** emoji in the delivery vocabulary; every admin-side delivery icon is a monochrome line SVG (`DELIVERY_ICON_PATHS`, `04-orders.js:2285-2302`). `label_en`/`label_cn` are surfaced to the customer, the icons are not currently rendered anywhere found.

### 1.5 Courier stage — live Qingyun rider (rider/local delivery only)

Computed, never stored: `deliveryJobStage()` at `routes/retail.js:10963-10982`, from the two raw Qingyun enums in `delivery_jobs` (`database.js:4280-4281`; enum meanings at `:4265-4267` — `orderStatus` 20 待配送 → 30 in-flight → 50 已送达, `deliveryStatus` parallel). Five stages, used identically by the customer track endpoint and the admin drawer *by design* (`routes/retail.js:10940-10941`).

| Stage | Meaning (per `routes/retail.js:10950-10954`) | Admin drawer (`04-orders.js:3230-3235`) | Admin list line (`:2370-2373`) | Admin header pill (`:3288-3290`) | Dashboard (`03-dashboard.js:966-976`) | Mini app (`order.js:605-610`) |
|---|---|---|---|---|---|---|
| `scheduled` | created 待配送, not dispatched | *(not in map)* | *(suppressed, `:2363`)* | — | — | `Delivery scheduled` / `等待配送` |
| `awaiting_dispatch` | dispatched, no rider yet | `Finding a rider` / `正在找骑手` | `Finding rider` / `正在找骑手` | `Finding a rider` / `正在找骑手` | `Finding rider` / `正在找骑手` — **but `Rider coming` / `骑手来取` on the Ready tile (`:1019`)** | `Finding a courier` / `正在为您找骑手` |
| `heading_to_pickup` | rider assigned, hasn't collected | `Rider coming` / `骑手前往取货` | `Rider coming` / `骑手前往取货` | `Rider coming` / `骑手前往取货` | `Rider coming` / `骑手前往取货` | `Rider picking up your order` / `骑手正在取货` |
| `in_transit` | carrying it to the customer | `On the way` / `配送中` | `En route` / `配送中` | `On the way` / `配送中` | `En route · N min` / `配送中 · N 分钟` | `On the way` / `骑手配送中` |
| `delivered` | 已送达 | `Delivered` / `已送达` | *(suppressed, `:2363`)* | falls through to `humanStatus` | — | `Delivered` / `已送达` |

Five stages × six render sites = **eleven distinct English strings and nine distinct Chinese strings** for five states.

### 1.6 Channel status — read-only platforms (Meituan 外卖/闪购, gzgrocery)

Mirrored verbatim into `retail_orders.channel_status` (`database.js:2713-2718`). Two independent maps read it:

- **`MT_STATUS`** (`04-orders.js:259-309`) — **50** Chinese platform labels → **21** English words + a status-pill tone. Plus a keyword fallback for unlisted labels (`:310-326`) that produces six generic English words (`Refund`, `Delivery failed`, `Cancelled`, `Delivered`, `Delivering`, `Preparing`, `Unpaid`, `In progress`). Surfaced as a drawer field only (`:4267-4271`), captioned `<channel> status · 平台状态`.
- **`internalStatusForChannel`** (`routes/meituan-internal.js:108-127`) — the same Chinese labels → **our** `retail_orders.status`, applied at mirror ingest (`:182`) and on each poll. This is what drives the pill and the tab counts (`04-orders.js:327-330`).

The two maps disagree by construction: `MT_STATUS['待配送']` is `Awaiting delivery` with tone `preparing`, while `internalStatusForChannel('待配送')` returns `'preparing'` — consistent here, but `MT_STATUS['已揽收']` is tone `dispatched` while the regex order in `internalStatusForChannel` sends `已揽收` to `dispatched` too. No systematic reconciliation exists; each was written separately and neither imports the other.

### 1.7 Fulfilment type — what the customer does

`lib/fulfilment.js:18` — `['delivery', 'pickup', 'counter']`, with the semantics written out at `:8-17`. Helper predicates: `isCounter` (`:25`), `isPickup` (`:30`), `shipsNothing` (`:42`, true for pickup **and** counter), `notifiesOnHandover` (`:51`), `isTerminalOnPaid` (`:65`).

Cell labels: `Counter / 前台` and `Pickup / 自提` in Ship-to (`04-orders.js:2519`, `:2522`), `counter / 前台` and `pickup / 自提` in the Delivery column (`:2394`, `:2397`).

> **Footgun already recorded elsewhere and confirmed here:** `docs`-level guidance says branch on `channel`, not `fulfillment_type`, for gzgrocery — its rows carry `fulfillment_type='delivery'` but are collected. `renderDeliveryCell` (`04-orders.js:2334`) correctly gates on `ordIsReadonlyChannel(o)` first.

### 1.8 Customer-facing order status labels (three separate maps, none shared)

| Surface | File | Values covered | Missing |
|---|---|---|---|
| Mini app — order detail | `miniapp/pages/order/order.js:17-31` | 7 | `rider_pickup`, `awaiting_restock` → renders the **raw internal string** (`:566` `labels[data.status] \|\| data.status`) |
| Mini app — orders list | `miniapp/pages/orders/orders.js:15-31` | 7 (identical copy) | same two |
| Web store | `public/shop.html:2886-2891` | 8 (has `awaiting_restock`) | `rider_pickup` |
| Mini app — home order tracker block | `miniapp/components/block-renderer/block-renderer.js:657-663` | 4 (`pending_payment`…`dispatched`) + a second "headline" map with different words | everything past `dispatched` |
| Web store — home order tracker block | `public/shop/blocks.js:391-394` | same 4 + headline map | same |
| Customer timeline (server-built) | `routes/retail.js:10428-10468` | 4 variants: cancelled / counter / pickup / delivery | — |

`awaiting_restock` is reachable from the mini app: the customer picks "wait for restock" at checkout and `markOrderPaid` writes the status (`routes/retail.js:4247-4251`, checkout branch documented at `:8987`, `:9118`). The mini app then prints the literal string `awaiting_restock` in the status pill, and `miniapp/pages/orders/orders.wxss:81-87` has no `.status-awaiting_restock` rule, so it also loses its pill colour.

---

## 2. Time labels

Every place a delivery-related time is rendered, with the exact label and whether the value is an **ESTIMATE** (future/predicted) or an **ACTUAL** (recorded event).

### 2.1 Orders list — the Delivery column (`04-orders.js`)

Column header: `Delivery · 配送` (`public/retail-admin.html:2634`).

| Line | Label EN | Label CN | Value | Kind | Colour |
|---|---|---|---|---|---|
| `:2425` | `arrived` | `已送达` | `o.delivered_at` | **ACTUAL** | `var(--text-3)` grey |
| `:2426` | `ETA` | `预计送达` | `o.channel_eta` on a delivered order | **ESTIMATE** | `var(--text-3)` grey |
| `:2427` | `booked` | `顾客预约` | `o.channel_preorder_at` | **ESTIMATE** (customer-booked window start) | `#8A6516` amber |
| `:2428` | **`arrival`** | `预计送达` | `o.channel_eta` in flight | **ESTIMATE** | `#5C7A4E` green |
| `:2441` | **`arrival`** | `预计送达` | `s.local_eta` (operator/courier-set "HH:MM") | **ESTIMATE** | `#5C7A4E` green |
| `:2444` | `no ETA set` | `未设送达时间` | — | — | muted |
| `:2450` | `⚠ missing` | `⚠ 缺运单号` | — | — | `.err` = `var(--danger)` `#e8556a` |

**The "arrival" label the brief asks about is `04-orders.js:2428` and `04-orders.js:2441`** — the small line rendered under the time, in both the read-only-channel branch and the same-city-local branch. In both cases the value is a **prediction**, not a recorded arrival. The English word asserts the event happened; the Chinese word (`预计送达`, "estimated delivery") correctly says it has not. The two halves of the same label disagree about tense.

The code comment immediately above (`:2409-2417`) documents that this cell **used to** read the ETA back as an arrival on landed orders and was corrected for that case — `arrivedAt` is now used only when `delivered_at` is genuinely stamped, and an order delivered by the past-ETA timer or the Meituan poll (neither of which stamps `delivered_at`) deliberately falls back to the `ETA` label. **The in-flight case at `:2428` was not part of that correction and still says `arrival`.**

Live courier line (replaces the above when a rider is moving, `:2386-2387`): `En route` / `配送中`, `Rider coming` / `骑手前往取货`, `Finding rider` / `正在找骑手`, all `#B4533E` brick; sub-line `~Nm` + distance, both **ESTIMATE**.

### 2.2 Orders list — the Ship-by plan (`04-orders.js:1701-1810`, rendered `:1879-1909`)

Kickers, chosen by plan kind and whether the order is closed:

| Condition | Kicker EN | Kicker CN | Kind |
|---|---|---|---|
| closed (dispatched/delivered/cancelled/refunded) | `Requested timing` | `原定时间` | historical |
| pickup | `Pickup time` | `取货时间` | **ESTIMATE** (promised window) |
| batch with an arrival date | `Deliver` | `送达时间` | **ESTIMATE** |
| batch without one | `Ship by` | `最迟发货` | deadline |
| right-away | `Requested` | `客户要求` | — |
| ASAP / nothing chosen | `Ship by` | `最迟发货` (headline `Courier — ship when ready` / `快递 · 备好即发`) | deadline |
| customer-scheduled | `Deliver` | `送达时间` | **ESTIMATE** |

Urgency tags on the sub-line (`:1895-1901`), suppressed once the order is no longer actionable: `OVERDUE` / `已逾期`, `today` / `今天`, `tomorrow` / `明天`. Batch sub-line: `made fresh · ship <date>` / `现做 · <date>发货`.

`urgencyBasis` internally takes the literal value `'arrival'` (`:1718`, `:1744`, `:1754`, `:1808`) — an internal key, never rendered, but the same word as the user-facing label above with a different meaning.

### 2.3 Order drawer (`04-orders.js`)

| Line | Label | Value | Kind |
|---|---|---|---|
| `:4287` | `Arrived · 送达` | `o.delivered_at` | **ACTUAL** |
| `:4287` | `Booked for · 顾客预约` | `o.channel_preorder_at` | **ESTIMATE** |
| `:4287` | `ETA · 预计送达` | `o.channel_eta` | **ESTIMATE** |
| `:3193` | `Delivery time · 送达时间` (section kicker) | — | — |
| `:3197` | `Estimated arrival · 预计送达` | `s.local_eta`, `eta_source='auto'` | **ESTIMATE** |
| `:3201` | `Set by the courier · 来自骑手,自动` | provenance | — |
| `:3183` | `Set arrival time · 设置送达时间` / `Update time · 更新时间` (buttons) | — | — |
| `:3205` | `Set a time manually · 手动设置时间` | — | — |
| `:3208` | `Shown to the customer · 已展示给顾客` | — | — |
| `:3314` | `~N min away` / `约 N 分钟` | `c.eta_seconds`, in_transit only | **ESTIMATE** |
| `:3316` | `~N min to store` / `约 N 分钟到店` | `c.eta_seconds`, heading_to_pickup only | **ESTIMATE** |
| `:3249-3252` | `just now` / `刚刚`, `Nm ago` / `N 分钟前` … | courier row freshness | **ACTUAL** |
| `:4228` | `Order placed · 下单于` | `o.placed_at` | **ACTUAL** |

The drawer is the **only** surface that distinguishes the three cases with three different words (`Arrived` / `Booked for` / `ETA`) — `:4283-4287` uses exactly the same `arrivedAt` guard as the list cell but chooses honest labels for all three.

### 2.4 Dashboard (`03-dashboard.js`)

| Line | Label | Kind |
|---|---|---|
| `:970` | `En route · N min` / `配送中 · N 分钟` | **ESTIMATE** |
| `:976` | `Out for delivery` / `配送中` (fallback, no live courier) | status, no time |
| `:1019` | `Rider coming` / `骑手来取` (on `awaiting_dispatch`) | status, no time |
| `:2415` | `Delivery needs a call` / `配送需要跟进` + oldest-waiting minutes | **ACTUAL** (age) |
| `retail-admin.html:1918` | `Rider coming · 骑手来取` (Delivery bento tile) | status |
| `:861`, `:903`, `:936` | purchasing ETAs (`Expected arrival · 预计到货`, `16-purchasing.js:415`) | **ESTIMATE** — inbound POs, adjacent vocabulary |

`.bx-in-eta.is-soon` renders `var(--td-amber-ink)` (`retail-admin.css:8899`) when the rider is ≤10 min out.

### 2.5 Customer surfaces

| Surface | Label EN | Label CN | Value | Kind |
|---|---|---|---|---|
| Mini app order page (`order.js:76` / `:250`, markup `order.wxml:48-54`) | `Estimated arrival` | `预计送达` | `delivery_eta.label_en/cn` from `formatLocalEta` (`routes/retail.js:9975-9988`) | **ESTIMATE** |
| Mini app live track (`order.js:637-639`) | `~N min` / `约 N 分钟` | | `eta_seconds`, in_transit only | **ESTIMATE** |
| Mini app pickup (`order.js:74` / `:248`) | `PICKUP TIME` | (CN copy block) | `delivery_slot_label` | **ESTIMATE** |
| Mini app timeline | per-step labels, §1.1 | | milestone timestamps | **ACTUAL** |
| Printed slip (`lib/feie.js:422`) | `Arrives 预计送达` — **one glued bilingual string** | | `~<promised_delivery_date>` | **ESTIMATE** |

**Estimate shown after completion — confirmed, one place:** the mini-app ETA banner (`miniapp/pages/order/order.wxml:48`) renders whenever `etaLabel` is truthy. `etaLabel` comes from `data.delivery_eta` (`order.js:495-498`), which the server sets from the `local` shipment's `local_eta` with **no status filter** (`routes/retail.js:10069-10077`). A delivered same-city order therefore still shows "Estimated arrival · 2:50 PM" with no arrival time beside it. The banner is styled with a green `--forest` left border and tinted background (`order.wxss:318-328`) whose comment reads *"Green accent = 'on its way'"* — so a completed order keeps an in-flight treatment.

**Estimate vs actual not distinguished — four places:**
1. `04-orders.js:2428` / `:2441` — `arrival` (EN) on an estimate (§2.1).
2. `miniapp/pages/order/order.wxml:48` — banner persists past delivery (above).
3. `04-orders.js:2426` — a **delivered** order whose ETA never resolved shows the ETA in a settled grey with no "this is still only a promise" cue beyond the word `ETA`; in Chinese it is `预计送达`, identical to the in-flight case at `:2428`.
4. `lib/feie.js:422` — the printed slip's `Arrives` is an estimate (`~` prefix is the only marker) and there is no companion actual-arrival print.

---

## 3. Transitions

### 3.1 The declared table

`STATUS_TRANSITIONS` (`routes/retail.js:22923-22936`) — the only guarded map, used by `PATCH /api/retail-admin/orders/:id/status` (`:23050-23060`), which rejects anything not listed with `409 invalid_transition`.

| To | From (allowed) | Stamps |
|---|---|---|
| `paid` | `pending_payment` | `paid_at` |
| `preparing` | `paid`, `awaiting_restock` | `preparing_at` |
| `dispatched` | `preparing`, `paid` | `dispatched_at` |
| `delivered` | `dispatched` | `delivered_at` |
| `cancelled` | `pending_payment`, `paid`, `preparing`, `awaiting_restock` | `cancelled_at` |
| `refunded` | `paid`, `preparing`, `dispatched`, `delivered` | *(none)* |

**`rider_pickup` appears nowhere in this table** — not as a target, not as a `prev`. **`awaiting_restock`** appears only as a `prev`; it is never a target here.

Client-side mirror: `NEXT_STATUS` (`04-orders.js:2594-2611`) — same shape plus explicit empty arrays for `rider_pickup`, `cancelled`, `refunded`, and an `awaiting_restock` row offering `preparing` / `cancelled`. Pickup relabels via `NEXT_STATUS_PICKUP_LABELS` (`:2617-2620`).

### 3.2 Triggers, by actor

| Trigger | Transition | Where |
|---|---|---|
| **Merchant** — status chip / drawer button | any row in §3.1 | `routes/retail.js:23050` |
| **Merchant** — attach waybill | → `dispatched` (first parcel) | `routes/retail.js:22759`, `:22565` |
| **Merchant** — mark parcel delivered | → `delivered` when all parcels land | `routes/retail.js:22469` |
| **Merchant** — cancel waybill | `dispatched` → `preparing` (rollback) | `routes/retail.js:22908-22914` |
| **Customer payment** | `pending_payment` → `paid`, or → `awaiting_restock` when they chose to wait | `routes/retail.js:4251` |
| **Customer payment (counter)** | `paid` → `delivered` immediately | `routes/retail.js:4281-4289`, rule at `lib/fulfilment.js:65` |
| **Qingyun rider pickup** (daemon poll) | `paid`/`preparing`/`rider_pickup` → `dispatched` once `order_status ≥ 40`, or `≥30` with `delivery_status ≥ 30` | `routes/retail.js:6726-6746`, notify `:6775` |
| **Qingyun drop-off** (daemon poll) | → `delivered` on `order_status ≥ 50` | `routes/retail.js:6804-6851` |
| **Local-ETA timer** (60s sweep) | → `delivered` once `local_eta + grace` (default 20 min) passes, **only when no live Qingyun job is fresh** | `routes/retail.js:6620-6697`; grace from `delivery.autoDeliverEtaMinutes` |
| **Meituan status poll** | any → whatever `internalStatusForChannel` returns, incl. → `rider_pickup` | `routes/meituan-internal.js:108-127`, `:313` |
| **Meituan past-ETA timer** | `paid`/`preparing`/`dispatched`/`rider_pickup` → `delivered` at `channel_eta + 1h` | `routes/meituan-internal.js:420-430` |
| **Restock arrival** | `awaiting_restock` → `preparing` (`checkAwaitingRestockForRestock`) | noted `04-orders.js:2606-2610` |
| **Carrier feed (快递100 / JD)** | writes `tracking_status` only — **never** `retail_orders.status` | `routes/retail.js:8695`, `:10524` |

### 3.3 The three sweeps bypass the transition table

`autoDeliverLocalEtaForTenant` (`routes/retail.js:6672-6679`), the Qingyun drop-off sweep (`:6823`) and `auto-deliver-past-eta` (`routes/meituan-internal.js:422-429`) all write `status` with raw `UPDATE … WHERE status IN (…)`, using the shared constant `AUTO_DELIVER_FROM_STATUSES = ['paid','preparing','dispatched','rider_pickup']` (`routes/retail.js:6615`). This is how `rider_pickup` and direct `paid → delivered` jumps happen despite §3.1 forbidding both. The comment at `:6608-6614` records that an earlier inline copy of that list drifted and stranded an order reading "Delivered" in its row and "Rider coming" in its tab.

Both delivered sweeps backfill `dispatched_at = COALESCE(dispatched_at, CURRENT_TIMESTAMP)`, producing orders whose dispatch and delivery timestamps are identical — the activity feed suppresses the phantom dispatch row for exactly this reason (`routes/retail.js:13086-13101`).

### 3.4 Terminal states

- `delivered` — terminal for fulfilment; **not** for money (refund is still reachable, `STATUS_TRANSITIONS.refunded.prev` includes it). `lib/fulfilment.js:13-17` states the rule explicitly for counter sales.
- `cancelled`, `refunded` — terminal, empty transition arrays (`04-orders.js:2604-2605`).
- Mini app stops polling on `delivered | cancelled | refunded` (`miniapp/pages/order/order.js:9`).
- `air_delay_cleared_at` (`database.js:2950`) is an **operator-cleared flag on an already-terminal order** — the AIR DELAYED alert cannot clear itself because the order is already `delivered`.

### 3.5 Dead and half-dead states

| Value | Status |
|---|---|
| `tracking_status = 'placed'` | **Dead.** Defined `lib/tracking.js:40`; produced by nothing — `KD100_STATE_TO_CODE` (`:60-74`) has no `placed`, `STATUS_TEXT_RULES` (`:110-119`) has no `placed`, `deriveStatusFromOrder` (`:91-95`) returns only `delivered`/`in_transit`/`null`. |
| `tracking_status = 'arrived_local'` | **Half-dead.** Produced (`:116`) and surfaced to the customer via `statusByCode` (`routes/retail.js:8620`, `:10739`), but `deliveryStateInfo` (`04-orders.js:2257-2277`) has no branch → the admin orders list renders **nothing** for it, silently falling through to `null`. Also absent from the schema comment (`database.js:2781`). |
| `tracking_scenario` ∈ {`proxy`, `left_at_door`, `in_person`, `out_for_delivery`} | Classified and stored, but the admin list only branches on `no_contact`, `pickup_point`, `locker` and `out_for_delivery` (`04-orders.js:2264-2274`); `proxy`, `left_at_door`, `in_person` have no admin representation. |
| `retail_orders.status = 'rider_pickup'` | Live but unreachable through the declared transition table (§3.1) and settable by exactly one code path (`routes/meituan-internal.js:123`). Self-fulfilled orders can never hold it. |
| `carrier code 'other'` (`lib/tracking.js:30`) | Defined with `url: () => null`; UNVERIFIED whether any order carries it — no writer restricts the value, `04-orders.js:2453` just upper-cases whatever is stored. |

---

## 4. Translations

### 4.1 Mechanisms in use (four, on one page)

1. **Source pairs `EN · 中文` collapsed at runtime.** The inline i18n engine (`public/retail-admin.html:11492+`, deliberately inline — `:11480-11490` explains why) splits on the first ` · ` where the left half has no Chinese and the right half does. Used by `shipmentStatePill` (`04-orders.js:2982-2984`), the mode labels (`:2996-2999`), the transition buttons (`:2595-2610`), the drawer kickers (`:4287`), the column header (`retail-admin.html:2634`).
2. **`cuT('EN','中文')` picked in JS.** Used by every dynamically-built delivery label — the Delivery-column labels (`:2425-2444`), `COURIER_STAGE` is a data map read through `cuT` at the call sites (`:3288-3290`), the dashboard stage words (`03-dashboard.js:970-976`).
3. **`EN_ONLY_MAP` dictionary.** English-only static markup translated by lookup — `retail-admin.html:11502-11513` covers the status chips.
4. **Per-language copy blocks.** Mini app (`order.js:66-…` EN, `:243-…` CN), web store inline ternaries (`shop.html:2886-2891`).

### 4.2 Labels with no translation entry

| Label | Where | Why it fails |
|---|---|---|
| **`Rider coming`** (status chip) | `public/retail-admin.html:2218` | Hardcoded English, no ` · 中文` pair. The **inline** dictionary (`:11502-11513`) has no entry. The **fallback copy** in `10-extras.js:626` *does* (`'Rider coming': '骑手来取货'`) — but that copy only runs if the inline engine did not (`:11493` `if (window.__raI18nEngine) return;`), i.e. never in practice. **Renders untranslated in Chinese view.** |
| `Drafts` (chip) | `retail-admin.html:2232` | same mechanism, out of delivery scope but the same defect |
| `Not shipped` / `Dispatched` / `Delivered` (shipment pills) | `04-orders.js:2982-2984` | translated — source pairs, listed for completeness |
| `arrival`, `arrived`, `booked`, `ETA`, `no ETA set` | `04-orders.js:2425-2444` | all `cuT` pairs — translated |
| `counter` / `pickup` in the Delivery cell | `04-orders.js:2394`, `:2397` | `cuT` pairs — translated |
| `Arrives 预计送达` | `lib/feie.js:422` | **one glued bilingual string**, printed as-is. Not a source pair; the printer has no language mode. |
| `已付款 Paid`, `备货中 Preparing`, `已发货 Shipped`, `已送达 Delivered` | `routes/retail.js:5802-5809` (`ORDER_STATUS_TIP`) | **glued CN+EN**, pushed to the customer's WeChat subscribe-message `温馨提示` field. Constrained by WeChat's 20-char limit (comment `:5912-5914`), but still a glued pair reaching a customer. |
| `awaiting_restock`, `rider_pickup` in the mini app | `miniapp/pages/order/order.js:17-31`, `orders/orders.js:15-31` | **no entry in either language** — the raw internal string is printed (`order.js:566`) |
| `rider_pickup` in the web store | `public/shop.html:2886-2891` | no entry — raw string printed |

### 4.3 The same concept, different CJK strings

| Concept | Strings found | Where |
|---|---|---|
| "delivered" (courier) | `已送达` · `已签收` · `已完成` | `04-orders.js:2984` · `:2272`, `:2489` · `:2555` |
| "rider coming" | `骑手前往取货` · `骑手来取` · `骑手来取货` · `骑手正在取货` | `04-orders.js:3232` · `retail-admin.html:1918`, `03-dashboard.js:1019` · `10-extras.js:626` · `miniapp/order.js:607` |
| "finding a rider" | `正在找骑手` · `正在为您找骑手` | `04-orders.js:3231`, `03-dashboard.js:975` · `miniapp/order.js:606` |
| "on the way" | `配送中` · `骑手配送中` | `04-orders.js:3233` · `miniapp/order.js:608` |
| "awaiting payment" | `待付款` · `待支付` | `retail-admin.html:11506`, `shop.html:2888` · `miniapp/order.js:25` |
| "estimated delivery time" | `预计送达` · `送达时间` · `设置送达时间` · `未设送达时间` | `04-orders.js:2428` · `:3193` · `:3183` · `:2444` |

---

## 5. Inconsistencies

### 5.1 One status, different words

| Status | Words used |
|---|---|
| `dispatched` (delivery) | `Dispatched` (`04-orders.js:2564`) · `On the way` (`miniapp/orders.js:19`, `shop.html:2889`) · `Out for delivery` (`routes/retail.js:10465`) · `已发货` (admin) vs `配送中` (customer) vs `配送中` (timeline) |
| `dispatched` (pickup) | `Ready · 可取货` (`04-orders.js:2561`) · `Mark ready for pickup · 标记可取货` (`:2618`) · `Ready to collect · 可取货` (`routes/retail.js:10456`) · **and the push notification still says `Your order has shipped / 订单已发货`** (`routes/retail.js:5728`) |
| `delivered` (pickup) | `Picked up · 已取货` (`04-orders.js:2562`) · `Collected · 已取货` (`routes/retail.js:10457`) · **push says `Your order was delivered / 订单已送达`** (`:5729`) |
| `delivered` (counter) | `Completed · 已完成` (`04-orders.js:2555`, `routes/retail.js:10443`) |
| `tracking_status='delivered'` | `Delivered / 已签收` (`04-orders.js:2272`) vs `Delivered · 已送达` (shipment pill `:2984`) vs `N delivered / N 已签收` (rollup `:2489`) |
| `awaiting_dispatch` | `Finding a rider` · `Finding rider` · `Finding a courier` · **`Rider coming`** (dashboard Ready tile, `03-dashboard.js:1019`) |
| `heading_to_pickup` | `Rider coming` · `Rider picking up your order` |
| `in_transit` | `On the way` · `En route` · `配送中` · `骑手配送中` |

### 5.2 Different things, same word

| Word | Meanings |
|---|---|
| **`Rider coming`** | `heading_to_pickup` — a rider is riding to the store (`04-orders.js:3232`, `:2371`, `:3289`) **and** `awaiting_dispatch` — no rider has taken the job (`03-dashboard.js:1019`, `retail-admin.html:1918`) **and** the `rider_pickup` order status (Meituan mirror, `04-orders.js:2564`) |
| **`预计送达`** | `arrival` (estimate, in flight, `04-orders.js:2428`) **and** `ETA` (estimate, order already delivered, `:2426`) **and** `arrival` (same-city operator-set ETA, `:2441`) **and** `Estimated arrival` (drawer, `:3197`) **and** `Arrives` on the printed slip (`lib/feie.js:422`) — five call sites, three different English words |
| **`Delivered`** | order status `delivered` · shipment `state='delivered'` · `tracking_status='delivered'` · courier `stage='delivered'` · Meituan `已送达`/`已完成`/`妥投`… (`04-orders.js:283-302`) — **five independent state machines, one word**, and they routinely disagree (the drawer carries explicit caveat lines for exactly that, `:4262-4266`) |
| **`Out for delivery`** | `tracking_status='out_for_delivery'` (`lib/tracking.js:44`) · `tracking_scenario='out_for_delivery'` (`:200`) · order status `dispatched` in the customer timeline (`routes/retail.js:10465`) · the dashboard's no-courier fallback (`03-dashboard.js:976`) |
| **`Picked up`** | `tracking_status='picked_up'` = the *carrier* collected the parcel (`04-orders.js:2276`) **and** pickup-order `delivered` = the *customer* collected it (`:2562`) |
| **`dispatched`** | order status **and** shipment state **and** the Meituan pill tone (`04-orders.js:271-295`) — three namespaces, same token |
| **`delivered`** (adjacent) | `restock_orders.status='delivered'` in the restock app means a warehouse→store transfer arrived (`public/restock.html:1962`, `:2311` `Delivered · 已送达`) — a separate lifecycle reusing the same value |
| **`arrival`** | the user-facing label (`04-orders.js:2428`) **and** `urgencyBasis: 'arrival'`, an internal ship-by key meaning "urgency is measured against a promised delivery date" (`:1718`, `:1744`, `:1754`, `:1808`) |

### 5.3 Colours used on delivery status text

| Colour | Value | Where | Meaning as used |
|---|---|---|---|
| `--st-pending_payment` | `var(--td-amber)` `#C9954A` | `retail-admin.css:57` | pill |
| `--st-paid` | `var(--td-sage-ink)` (`#4A6249` light / `#A3B49F` dark, `css:8230`, `:8249`) | `:58` | pill |
| `--st-preparing` | `var(--td-amber)` `#C9954A` | `:59` | pill |
| `--st-rider_pickup` | `#4A72B0` — a hardcoded blue, **not a `--td-*` token** | `:62` | pill |
| `--st-dispatched` | `var(--td-amber)` `#C9954A` | `:63` | pill |
| `--st-delivered` | `var(--td-sage-ink)` | `:64` | pill |
| `--st-cancelled` / `--st-refunded` | `#8a8780` — hardcoded neutral, not a token | `:65-66` | pill |
| `--st-awaiting_restock` | `var(--td-amber)` `#C9954A` | `:69` | pill |
| green | `#5C7A4E` | `04-orders.js:2260`, `:2272`, `:2424`, `:2430`, `:2440`, `:2489`, `:3233`(dot), `:3234`(dot) | delivered · in-flight ETA |
| grey | `#6B7280` | `:2274`, `:2275`, `:2276`, `:2490` | transit |
| amber | `#9A6E2A` | `:2269`, `:2270`, `:2493`, `:3231`(dot), `:4263`, `:4265` | attention |
| amber | `#8A6516` | `:2424` (booked), `:4226` (Pre-order pill text on `#FBF0DC`) | booked window |
| brick | `#B4533E` | `:2264`, `:2265`, `:2266`, `:2267`, `:2386` | urgent · live rider line |
| blue | `#4A72B0` | `:3232` (dot) | heading_to_pickup |
| **pure red** | `var(--danger)` **`#e8556a`** (`retail-admin.css:48`) | `04-orders.js:2471` (AIR DELAYED badge), `:2450` via `.err` (missing waybill), `css:6180` | food-safety alert · missing waybill |
| customer green | `--forest`, `rgba(54,83,41,.10)` fill | `miniapp/pages/order/order.wxss:318-328` | "on its way" — **stays lit after delivery**, §2.5 |
| customer pills | `#c66800` / `#2456a3` / `#7f5800` / `#3a6817` / white-on-`--forest` / `#9c1f33` | `miniapp/pages/orders/orders.wxss:81-87` | status pills; **no rule for `rider_pickup` or `awaiting_restock`** |

Against the design system, for a later check (findings only, no recommendation):

- `docs/tacet-design-system.md:29` — *"Functional (product UI only): Amber `#C9954A` for warnings, Brick `#B4533E` for errors. Never pure red, never neon anything."* The AIR DELAYED badge and the missing-waybill `.err` both render `#e8556a`.
- `docs/tacet-desktop-patterns.md:534` — *"A down delta renders in Graphite, never Brick."* No delivery status found rendering a negative delta in Brick; the Brick uses above (`:2264-2267`) are error/exception states, which `docs/tacet-design-system.md:135` assigns Brick tint.
- `docs/tacet-desktop-patterns.md:251` — *"Text on a tint is always the `-ink`, never the base."* The delivery status text colours listed above are hardcoded hex, not `--td-*-ink` tokens; `#5C7A4E`, `#6B7280`, `#9A6E2A`, `#8A6516`, `#4A72B0` have no token equivalent in `retail-admin.css:8225-8260`.
- Four of the nine order statuses (`pending_payment`, `preparing`, `dispatched`, `awaiting_restock`) resolve to the identical amber, so the pill carries no state information across the entire active middle of the lifecycle.

### 5.4 Definition drift between schema and code

| Claim | Where | Reality |
|---|---|---|
| `status` has 7 values | `database.js:1180` | 9 (§1.1) |
| `tracking_status` has 8 codes | `database.js:2781` | 9 (`lib/tracking.js:39-51`) — `arrived_local` missing from the comment |
| `retail_shipments.mode` is `'local' \| 'air' \| 'land'` | `database.js:2902` | a fourth, `'supplier'`, is live (`04-orders.js:2999`) |
| `routing_reason` includes `'customer_pickup'` | `database.js:2711` | accurate — written at `routes/retail.js:9178`. Listed only because it is the one place the schema comment and the code agree. |
| `STATUS_TRANSITIONS` is the single guarded map | `routes/retail.js:22921-22922` (*"Stays explicit so accidental sql-injection-style status values can't slip in"*) | three sweeps write `status` directly (§3.3) and one of them is the only way into `rider_pickup` |

### 5.5 Surfaces carrying their own private vocabulary

- `public/m.html` — the mobile companion prototype. Its own status map (`:1017`), its own PO-status mapping (`:1081`), its own fixture strings (`Out for delivery / 配送中`, `Dispatched / 已发货`, `:159-160`), and its own chip words (`:440` — `Dispatched / 已发`, `Delivered / 送达`, both shorter than the admin's). Fixture-driven, no server data; recorded because it is a fifth vocabulary that will have to be reconciled when it goes live.
- `public/restock.html` — internal restock orders reuse `delivered` for a warehouse→store transfer (`:1962`, `:2311`).
- `public/retail-admin/16-purchasing.js:415` — `Expected arrival · 预计到货` for inbound POs: a sixth "arrival" with a seventh Chinese string.

---

## Appendix — file map

| File | What it owns |
|---|---|
| `database.js:1174-1216` | `retail_orders` — status + milestone timestamps |
| `database.js:2707-2729` | channel/routing columns, `channel_status`, `channel_eta`, `channel_preorder_at` |
| `database.js:2773-2796` | `tracking_*` columns + scenario columns |
| `database.js:2890-2951` | `retail_shipments` — mode, per-parcel tracking, `local_eta`, `eta_source`, air-delay clear |
| `database.js:4259-4306` | `delivery_jobs` — raw Qingyun enums, rider GPS, `expected_delivery_at` |
| `lib/fulfilment.js` | what delivery / pickup / counter mean |
| `lib/tracking.js:39-51` | the 9 normalised carrier codes + EN/CN labels |
| `lib/tracking.js:139-205` | the 7 delivery scenarios |
| `lib/tracking.js:228-283` | CN→EN event-text translation rules |
| `lib/delivery-reminders.js` | staff-facing "deliver soon / deliver today" pushes |
| `lib/feie.js:395-422` | printed-slip ship-by / arrival lines |
| `routes/retail.js:5725-5732` | customer notification titles per status |
| `routes/retail.js:5802-5809` | WeChat subscribe-message tips per status |
| `routes/retail.js:6588-6716` | local-ETA auto-deliver sweep |
| `routes/retail.js:6718-6860` | Qingyun auto-dispatch + auto-deliver sweeps |
| `routes/retail.js:9975-9988` | `formatLocalEta` — the customer's ETA string |
| `routes/retail.js:10428-10468` | the four customer timelines |
| `routes/retail.js:10963-10982` | `deliveryJobStage` — the 5 courier stages |
| `routes/retail.js:13479-13952` | dashboard ops payload incl. `delivery_alerts` |
| `routes/retail.js:19540-19600` | orders-list SELECT — `is_local`, `local_eta`, split rollup, air delay |
| `routes/retail.js:22921-22936` | `STATUS_TRANSITIONS` |
| `routes/meituan-internal.js:108-127` | platform label → our status |
| `routes/meituan-internal.js:420-435` | past-ETA auto-deliver |
| `public/retail-admin/04-orders.js:259-326` | `MT_STATUS` — 50 platform labels |
| `public/retail-admin/04-orders.js:1689-1909` | ship-by plan + urgency + cell |
| `public/retail-admin/04-orders.js:2257-2302` | `deliveryStateInfo` + delivery icons |
| `public/retail-admin/04-orders.js:2316-2498` | the Delivery column — **`arrival` label at `:2428` and `:2441`** |
| `public/retail-admin/04-orders.js:2549-2637` | `humanStatus`, `NEXT_STATUS`, pickup relabels |
| `public/retail-admin/04-orders.js:3144-3235` | local-ETA card + `COURIER_STAGE` |
| `public/retail-admin/04-orders.js:3265-3294` | `orderStatusPill` — stage-over-status reconciliation |
| `public/retail-admin/04-orders.js:4239-4291` | drawer platform-status field + `Arrived`/`Booked for`/`ETA` |
| `public/retail-admin/03-dashboard.js:941-1026` | On-the-road + Ready-to-hand-off tiles |
| `public/retail-admin.html:2213-2234` | the status chips |
| `public/retail-admin.html:11492-11515` | the live `EN_ONLY_MAP` |
| `public/retail-admin/10-extras.js:620-634` | the dead fallback `EN_ONLY_MAP` |
| `public/retail-admin.css:53-69`, `:5017-5034` | status pill colour tokens + rules |
| `miniapp/pages/order/order.js` | customer order labels, ETA banner, live stages |
| `miniapp/pages/orders/orders.js:15-31` | customer list labels |
| `public/shop.html:2886-2891` | web-store labels |
| `public/shop/blocks.js:391-394`, `miniapp/components/block-renderer/block-renderer.js:657-663` | home order-tracker block labels |
