# The PRE-ORDER pill — browse-surface survey

Survey only. No changes proposed, none made.

**Scope.** The PRE-ORDER pill and everything a shopper sees because of it, on browse
surfaces: the mini-app shop grid, its quick-add size picker, the PDP hero badge, the PDP
size sheet, the favourites page, and `public/shop.html`. The checkout `wait_for_restock`
flow is out of scope except where a browse decision hands off to it. Addresses are out of
scope except where `same_city` is read.

**Baseline.** Working tree at `6632939` ("A pre-order the local scooter run can't
deliver is not an offer"), fetched from `origin` at survey time. That commit is the
"today's change" referred to throughout; `origin/main` is at `588a9f0` and does **not**
contain it. Line numbers are from this tree.

**Method.** Source reading plus the local `data/roots.db`. That database is the
container's own, created fresh by `database.js` migrations — it holds **0 rows** in both
`products` and `store_products`, so it answers nothing about live data. Production is not
reachable from here; every claim about live stored values is marked UNVERIFIED.

Where a doc and the code disagree, the code is reported as the truth and the disagreement
is called out.

---

## 1. Where the pill comes from

### 1.1 The chain, per surface

Everything starts at one server helper. `effectiveOosPolicy()` (`routes/retail.js:939-949`)
resolves a row to `'always' | 'backorder_gz' | 'strict'`: supplier-direct wins first
(`:945`), then an explicit `oos_policy` (`:947`), then the legacy fallback
`is_batch_made ? 'backorder_gz' : 'strict'` (`:948`). The catalog endpoints reduce that to
one boolean, `oos_preorder`, and no client re-derives the policy.

| # | Surface | Server flag | Client verdict | Rendered by |
|---|---|---|---|---|
| 1 | Mini-app shop grid (list / list-compact / grid-2col / grid-3col / gallery) | `GET /api/retail/products` → `oos_preorder` `routes/retail.js:1526` | `_stockState(p, sameCity)` `miniapp/pages/shop/shop.js:48-53` → `_toRows` `:522, :543, :549` | `shop.wxml:204-205` (row), `:256-257` (gallery), `:311-312` (card) |
| 2 | Mini-app quick-add size picker | same list payload | `_openVariantPicker` `shop.js:1076` | `shop.wxml:355-356`; tap guard `shop.js:1116-1123` |
| 3 | Mini-app shop quick-add (`+`) | same | `addToCart` `shop.js:1003-1008` | `+` suppressed at `shop.wxml:213, :271, :323` when `outOfStock` |
| 4 | PDP hero badge | `GET /api/retail/products/:id` → `product.oos_preorder` `routes/retail.js:2343` | `recomputeDisplay` → `reservable()` `product.js:442`, used `:448, :452` | `product.wxml:28` (`stock-badge stock-{{stockTagKind}}`); button label `product.js:707-713` → `product.wxml:276` |
| 5 | PDP size sheet | `product.variants[].oos_preorder` `routes/retail.js:2332-2336` | `_openVariantPicker` `product.js:996-997`; tap guard `:1050` | `product.wxml:300-308` |
| 6 | Favourites | `GET /api/retail/favorites` → `oos_preorder` `routes/retail.js:28917` | `rebuildView` `favorites.js:141-142`; quick-add `:223` | `favorites.wxml:61-62` (card), `:87-88` (row); `+` gated `:68, :93` |
| 7 | Web storefront — desktop card + PDP | list/PDP payload, or client fallback `oosBackorder()` `public/shop.html:5064-5069` | `stockState()` `public/shop.html:5088-5103` | card `:5105-5119`; PDP `:5193-5195` |
| 8 | Web storefront — size pickers (both) | `oos_preorder`, else `oosBackorder()` | `slStock()` `public/shop.html:4574-4579` | `:5047`, `:5349` |
| 9 | Web storefront — mobile list/grid (the mini-app mirror) | — | `slToRows()` `public/shop.html:4615-4650`, via `oosBackorder()` only | rows `:4820-4821`, cards `:4845-4846`; `+` gated `:4838, :4861` |

Surface 9 is the outlier: `slToRows` computes `nextBatch` from `oosBackorder(p)` at
`:4631` and `:4636` and never consults `shopperSameCity()`. Today's change touched
`stockState()` and `slStock()` but not `slToRows()`, so on the web storefront's **mobile**
layouts a same-city shopper still sees the SHIPS SOON / NEXT BATCH badge and a live `+`
button. Tapping that `+` runs `slAddRaw` (`:4984-4996`), which *does* read
`slStock(raw).pre` — so for a same-city shopper `pre` is false and the item is added with
the plain "已加入 🌱 / Added 🌱" toast rather than the pre-order one. Add succeeds either
way; only the toast differs.

Two other client-side details worth recording:

- The mini-app never re-implements the policy: `oos_preorder` is server-truth on all three
  pages. The web storefront **does** carry a client-side mirror, `oosBackorder()`
  (`public/shop.html:5064-5069`), used when `oos_preorder` is absent from a payload
  (`:4577`) and used unconditionally by `slToRows` (`:4631, :4636`). It reproduces the
  server's `strict / backorder_gz / is_batch_made` fallback but **not** the
  `ship_from_supplier → 'always'` branch (`routes/retail.js:945`); `stockState` handles
  supplier rows separately before reaching it (`:5089-5095`).
- The mini-app home page renders no stock state at all — `oos_preorder` appears in exactly
  three mini-app files (`shop.js`, `product.js`, `favorites.js`), and `home.js` /
  `home.wxml` contain neither `soldOut` nor `outOfStock`.

### 1.2 Which table the catalog reads

**`store_products`, in every case.** The catalog column set `RETAIL_PRODUCT_COLS`
(`routes/retail.js:925`) selects `p.oos_policy` and `p.is_batch_made`, and every
storefront query aliases `store_products` as `p`:

| Endpoint | Query | Line |
|---|---|---|
| `GET /api/retail/products` (shop grid, home) | `FROM store_products p` | `routes/retail.js:1459` |
| `GET /api/retail/products/:id` (PDP) | `FROM store_products p` | `:2240` |
| PDP variant siblings | `FROM store_products p` | `:2320` |
| `GET /api/retail/favorites` | `JOIN store_products p` | `:28905` |
| `computePreorderNotice` | `FROM store_products` | `:25751` |

The slim card set (`slim=1`, the shop grid) is `RETAIL_PRODUCT_COLS_CARD`
(`:986-988`) — it strips descriptions and keywords but **keeps** `oos_policy` and
`is_batch_made`, so the leanest payload still carries the policy.

**Is `products.oos_policy` dead? Yes.** The column is declared at `database.js:2841` with
a full doc comment (`:2833-2840`). Across `routes/`, `lib/` and `scripts/` the only
non-`retail.js` mentions are `scripts/diagnose_fallback_store.js:81,89` (a read-only
diagnostic) and this survey's test file. Inside `retail.js`, every read is of a
`store_products` row and the only write target is `store_products`: the admin
`PATCH /api/retail-admin/products/:id` (`:18246`) builds its `sets[]` including
`oos_policy` (`:18404-18409`) and executes `UPDATE store_products SET …` (`:18459`).
The `products` copy exists because the one-time store fork copied every `products` column
into `store_products` wholesale (`database.js:3946-3948`,
`INSERT INTO store_products (${colList}) SELECT ${colList} … FROM products`); nothing has
written it since. This matches `docs/tacet-product-fields.md:76`, which already marks it
"DEAD on `products`".

### 1.3 Is there an operator screen?

**Yes.** The premise that there might not be is wrong.

| Element | Location |
|---|---|
| `<select id="pd-oos-policy">` with both options | `public/retail-admin.html:4535-4538` |
| Section heading "When out of stock · 缺货时" + help tooltip | `public/retail-admin.html:4533` |
| Load into the form (blank → legacy `is_batch_made` guess) | `public/retail-admin/09-products.js:2243-2244` |
| Save (supplier-direct forces `'always'`) | `09-products.js:4347-4348` |
| Revert-snapshot capture / restore | `09-products.js:4527`, `:4542` |
| Server persist (only the three known modes; anything else → NULL) | `routes/retail.js:18404-18409` |
| Included in the product version-history column set | `routes/retail.js:18074` |

The two options are `Sold out everywhere · 全国售罄停售` (`strict`) and
`Pre-order outside Guangzhou · 广州外可预订（现订现发）` (`backorder_gz`). `always` is not
offered in the dropdown — it is forced for `ship_from_supplier` rows at `09-products.js:4347`
and applied implicitly at `routes/retail.js:945`.

**Stored values across the live catalogue: UNVERIFIED.** No production access from this
container; the local database is empty (0 `store_products`, 0 `products`). What can be
stated from code: a value is present only if an operator saved the product since the
dropdown existed (blank stays NULL, `:18409`), and any NULL row still behaves as
`backorder_gz` when `is_batch_made = 1` (`:948`) — so the live population is a mix of
operator-set values and legacy batch-flag inference, in unknown proportion.

---

## 2. What the pill promises

### 2.1 Expected-availability date, batch, restock date, ETA

**For a generic `backorder_gz` product: does not exist.** In schema, in any payload, in any
browse surface, in the checkout notice.

- Schema: there is no `restock_at` / `restock_date` / `expected_at` / `available_from` /
  `back_in_stock` column anywhere (`database.js`, `routes/retail.js`, `lib/*.js` — no hits).
  The only date columns in this neighbourhood are `retail_orders.promised_ship_date` /
  `promised_delivery_date` (`database.js:2844-2848`), and they are order-level, not
  product-level.
- Payload: the browse flag is the boolean `oos_preorder` and nothing else
  (`routes/retail.js:1526, 2336, 2343, 28917`).
- Checkout notice: `computePreorderNotice()` (`routes/retail.js:25743-25767`) returns fixed
  copy with an item list and **no date field** — the message is "…as soon as they're back
  in stock" / "补货后尽快". Its own header comment says so: dates belong to
  `computeBatchNotice`.

**The one exception is batch-made items, and it is a different notice.** For
`is_batch_made = 1` products, `computeBatchNotice()` (`routes/retail.js:25631+`) derives a
`ship_date` / `delivery_date` from `storefront_config['batch.schedule']` (`:25637-25655`).
Those are stamped onto the order (`:10007-10011`) and pushed as an in-app `batch_delay`
notification (`:10012-10017`). Two constraints matter: it returns `null` unless the zone is
a `city` zone or a GZ ship-district (`:25633-25636`) — so an inner-GZ address like Tianhe
never gets it — and `computePreorderNotice` explicitly excludes batch rows (`:25755`), so a
cart never gets both for the same item. The dates surface to the operator in
`public/retail-admin/04-orders.js:1791-1793`; no mini-app or web page reads
`promised_ship_date` (no hits under `miniapp/`, `public/shop.html`).

Net: nothing a shopper sees on a browse surface carries, implies, or links to a date.

### 2.2 Cap on units reserved while stock is 0

**Does not exist.** No product-level or order-level quantity ceiling applies.

- Server: the only per-line validation is `if (!pid || !(qty > 0)) → 400 invalid_item`
  (`routes/retail.js:9063`). There is no upper bound.
- The hard OOS gate that would refuse the line is skipped by design for this policy:
  `if (effectiveOosPolicy(r.product) !== 'strict') return false` (`:9145`).
- No reservation is taken, so nothing accumulates against a cap either (see §7).
- `per_customer_limit` (`:7341`, `:11628`, …) is a **voucher** field, unrelated.
- `flash_stock_limit` (`:9113`) caps flash-sale units only, and only while a flash window
  is live.
- Client stepper caps: PDP quantity is clamped to 99 (`miniapp/pages/product/product.js:751`);
  quick-add adds 1. `miniapp/utils/cart.js` has no ceiling (`add()` `:53-58` just increments).

So a single order may reserve any quantity of a zero-stock `backorder_gz` product, and
nothing tracks the aggregate across orders.

### 2.3 Notification when a pre-ordered item is fulfilled

**A fulfilment-specific notification does not exist.** The customer receives only the
ordinary order-status messages, and only when the order itself moves.

`ORDER_STATUS_NOTIF` (`routes/retail.js:5765-5772`) covers exactly `paid`, `preparing`,
`dispatched`, `delivered`, `cancelled`, `refunded`. `notifyOrderStatusChange()` (`:5906-5959`)
writes an in-app row (`:5923-5939`) and, if `notifications.order_status_template_id` is
configured and the customer has an unused consent, sends one WeChat subscribe message
(`:5946-5957`). An out-of-GZ order additionally gets the Aliyun "package delivered" SMS on
the `delivered` transition (`:5908`, `:5774-5780`).

Consequences specific to pre-orders:

- There is **no** "your pre-ordered item is back in stock" or "your pre-order shipped"
  message distinct from the normal `dispatched` one (`'Your order has shipped' / '订单已发货'`).
- `awaiting_restock` is **not** in `ORDER_STATUS_NOTIF`, so the transition into that status
  pushes nothing at all.
- The only pre-order-adjacent proactive message is the batch one, `type: 'batch_delay'`
  (`:10012-10017`) — fired at order creation, for batch items only, and it announces dates
  rather than fulfilment.

---

## 3. The `same_city` verdict

### 3.1 Every compute and read site

Computed in exactly one place, from `lib/inventory.js`'s matcher:

| Role | Site |
|---|---|
| Definition — `isGuangzhouAddress(address)`: structured `city`, then a 广州/guangzhou scan of the free-text blob | `lib/inventory.js:1070-1077` (exported `:1557`) |
| Stamp helper `stampSameCity(rows)` | `routes/retail.js:7563-7576` |
| Stamped on `GET /api/retail/addresses` (mini app) | `routes/retail.js:7634` |
| Stamped on `GET /api/retail/customer` (web storefront's address book + `state.customer`) | `routes/retail.js:17366-17373` |

Read on the clients:

| Consumer | Site | Notes |
|---|---|---|
| `miniapp/utils/delivery.js` — cache shape | `:28`, `:79`, `:96` | Stores only `{id, same_city, is_default}` |
| `delivery.sameCity()` | `:51-54` | Reads `_activeRow()` `:38-49`: `globalData.activeAddressId` if it matches a row, else the `is_default` row, else `null` |
| `delivery.preorderAllowed()` | `:58-60` | Inverse |
| Shop — sync + re-render on flip | `shop.js:216-224` (`onLoad` `:190`, `onShow` `:202`) | Re-renders held rows via `_renderRows`, no refetch |
| Shop — verdict applied | `shop.js:48-53` (`_stockState`), `:522`, `:1003`, `:1076`, `:1116` | |
| PDP — loaded with the product | `product.js:329-336` | `Promise.all`, so the first paint is already correct |
| PDP — re-sync on `onShow` | `product.js:216-224` | |
| PDP — verdict applied | `product.js:442`, `:996`, `:1050` | |
| Favourites — loaded with the list | `favorites.js:103-107` | |
| Favourites — verdict applied | `favorites.js:141`, `:223` | |
| Cache primed from an address list already fetched | `addresses.js:206`, `:721`; `checkout.js:719`, `:801` | |
| Cache dropped after an inline new-address save | `checkout.js:2806` | |
| Web — `shopperSameCity()` | `public/shop.html:5078-5083` | `is_default` row, else `addresses[0]` |
| Web — verdict applied | `public/shop.html:5101` (`stockState`), `:4577` (`slStock`) | **Not** applied in `slToRows` — see §1.1 |
| Web — account resolved before first paint | `public/shop.html:4481-4483` (desktop shop), `:4695-4697` (mobile list), `:5127-5128` (PDP) | |

### 3.2 What "unknown" does, per surface

"Unknown" means: signed out, no saved address, or the request failed. Every surface
defaults to **not same-city**, i.e. the permissive pre-order behaviour that existed before
today's change. Confirmed:

| Surface | Unknown behaviour | Evidence |
|---|---|---|
| `utils/delivery` | `_activeRow()` returns `null` → `sameCity()` false; `load()` swallows every rejection and keeps the last known value | `delivery.js:38-54`, `:81` |
| Mini-app shop | `this._sameCity` is `undefined` until the load resolves; `!!undefined` is false, so the **first paint** is permissive even for a same-city shopper. Corrected in place when the verdict lands | `shop.js:218-223`, `:522` |
| PDP | Awaited alongside the product, so no permissive flash; on failure `_sameCity` stays `undefined` → false | `product.js:329-336` |
| Favourites | Awaited alongside the list; same fallback | `favorites.js:103-107` |
| Web storefront | `state.customer` null or `addresses` empty → false | `public/shop.html:5079-5080` |
| Web mobile list/grid | Permissive **always**, verdict or not | `public/shop.html:4631, 4636` |

A signed-out visitor cannot reach `GET /api/retail/addresses` at all — it is behind
`requireRetailAuth` (`routes/retail.js:7621`); the mini-app's `api.js` turns the 401 into a
rejected promise (`miniapp/utils/api.js:38-59`) which `delivery.load()` catches. In the
mini app this is rare in practice (a silent `wx.login` runs at launch, `app.js:113`), so the
usual "unknown" is a signed-in customer with **zero saved addresses**.

**The checkout error such a shopper hits.** They add the item, then check out to a
Guangzhou address on a same-day slot. Two gates decide, in this order:

1. `POST /api/retail/checkout/quote` (`routes/retail.js:26834`) calls `analyzeShortage`
   (`:27000`). `requiresStockGate` is true (GZ + same-day, `lib/inventory.js:1100-1102`), the
   nearest store is short, so `gate = 'options_5'` (`lib/inventory.js:1346-1347`) with
   `missing_items` (`:1351-1356`). The mini app reads that as `fallbackGate`/`needsFallback`
   (`checkout.js:1412-1413`) and opens the **5-option out-of-stock modal** before submitting
   (`checkout.js:2449-2452`).
2. If the order is submitted without a `fallback_choice`, `POST /api/retail/orders` decides.
   The hard OOS gate does **not** fire — it only covers `strict` (`:9145`). Routing does:
   - another open store has the stock → **HTTP 409 `needs_fallback_confirmation`**
     (`routes/retail.js:9411-9432`, from `lib/inventory.js:557-561`);
   - no store has it — the case the pill actually describes, since the card's `stock` is the
     sum across open stores (`routes/retail.js:910`) — → **HTTP 409 `insufficient_stock`**,
     carrying `product_id` and `available` (`routes/retail.js:9434-9440`, from
     `lib/inventory.js:564-569`).

So the precise answer for a genuinely sold-out row is `insufficient_stock`, surfaced to the
customer as the 5-option modal rather than as a raw error.

---

## 4. The scheduled-day gap

**Confirmed: the server still permits it.** A Guangzhou customer may order a zero-stock
`backorder_gz` product by choosing a future delivery day. The path:

| Step | Site |
|---|---|
| `requiresStockGate = isGuangzhouAddress && isSameDayDelivery` — false for a future slot | `lib/inventory.js:1100-1102`, `isSameDayDelivery` `:1082-1091` |
| `/quote`: gate short-circuits to `gate: 'none'`, `missing_items: []`, `stock_gate_off: true` — no modal | `lib/inventory.js:1266-1276` |
| `POST /orders`: `stockGate` false | `routes/retail.js:9375` |
| Hard OOS gate does not apply to `backorder_gz` | `routes/retail.js:9143-9146` |
| Routing runs with `ignoreStock: !stockGate` → returns the nearest store and never raises `no_stock` / `needs_fallback_confirmation` | `routes/retail.js:9405`; `lib/inventory.js:518-526` |
| No reservation is taken | `routes/retail.js:9901-9909` |
| The pre-order notice fires for exactly this shopper too (its only condition is `!requiresStockGate`) | `routes/retail.js:25744` |
| The reverse move is blocked: a fresh order cannot later be pulled **into** a same-day slot | `routes/retail.js:17178-17180` (`fresh_no_sameday`) |

**Confirmed: the catalog now hides that path from them.** For a same-city shopper the row
is rendered dead before any slot is chosen — the shop has no slot concept at all:

| Surface | Effect | Site |
|---|---|---|
| Shop card | `preorder` forced false → `soldOut` true → dead SOLD OUT pill | `shop.js:51-52`, `shop.wxml:204, 256, 311` |
| Shop `+` button | Not rendered when `outOfStock` | `shop.wxml:213, 271, 323` |
| Shop quick-add tap (stale page) | Refused with a "已售罄 / Sold out" toast | `shop.js:1003-1007` |
| Shop size picker | Row shows SOLD OUT, tap refused | `shop.js:1076`, `:1116-1123` |
| PDP | Hero reads SOLD OUT, button becomes the disabled-style "已售罄 / SOLD OUT" label, `addToCart` returns early | `product.js:442-467`, `:707-709`, `:832` |
| PDP size sheet | Row dead, tap refused | `product.js:996-997`, `:1050-1054` |
| Favourites | Dead tile, `+` hidden, quick-add refused | `favorites.js:141`, `:223-226`; `favorites.wxml:61, 68, 87, 93` |
| Web desktop card / PDP | SOLD OUT; PDP button disabled | `public/shop.html:5101`, `:5198` |
| Web mobile list/grid | **Not hidden** — still SHIPS SOON / NEXT BATCH with a live `+` | `public/shop.html:4631, 4636, 4838, 4861` |

The scheduled-day route therefore remains open on the server and reachable through the web
storefront's mobile layout, while every mini-app surface and the web desktop surfaces close
it at the browse step.

---

## 5. Pill copy and states

### 5.1 Every string

| Surface | State | EN | CN | Site |
|---|---|---|---|---|
| Mini-app shop (all layouts + size picker) | pre-order | `PRE-ORDER` | `可预订` | `shop.js:266` (init `:169`) |
| Mini-app shop | sold out | `SOLD OUT` | `售罄` | `shop.js:265` (init `:168`) |
| Mini-app shop quick-add toast | pre-order add | `Added — pre-order` | `已预订，加入购物车` | `shop.js:1030-1034` |
| Mini-app shop quick-add toast | refused | `Sold out` | `已售罄` | `shop.js:1005` |
| Mini-app shop picker tap | refused | `Sold out` / `Unavailable` | `已售罄` / `暂时缺货` | `shop.js:1118` |
| PDP hero badge | pre-order | `PRE-ORDER` | `可预订` | `product.js:462` |
| PDP hero badge | sold out | `SOLD OUT` | `已售罄` | `product.js:466` |
| PDP hero badge | supplier paused | `Unavailable` | `暂时缺货` | `product.js:449` |
| PDP buy button | pre-order | `PRE-ORDER` | `预订` | `product.js:712` |
| PDP buy button | sold out | `SOLD OUT` | `已售罄` | `product.js:708` |
| PDP size sheet | pre-order / sold out | `PRE-ORDER` / `SOLD OUT` | `可预订` / `售罄` | `product.js:706-707` |
| PDP add toast | pre-order | `Added — pre-order` | `已预订，加入购物车` | `product.js:930-932` |
| Favourites | pre-order | `PRE-ORDER` | `可预订` | `favorites.js:21` / `:38` |
| Favourites | sold out | `SOLD OUT` | `已售罄` | `favorites.js:20` / `:37` |
| Favourites quick-add toast | pre-order | `Added — pre-order` | `已预订，加入购物车` | `favorites.js:236-238` |
| Web card / PDP tag | pre-order, batch item | `NEXT BATCH` | `下批现做` | `public/shop.html:5102` |
| Web card / PDP tag | pre-order, non-batch | `SHIPS SOON` | `现订现发` | `public/shop.html:5102` |
| Web card / PDP tag | sold out | `SOLD OUT` | `售罄` | `public/shop.html:5103` |
| Web PDP note line | pre-order | `Out of stock now — orderable outside Guangzhou; ships on the next batch / restock.` | `当前缺货，外地可预订，下批/补货后发出。` | `public/shop.html:5195` |
| Web mobile list/grid | pre-order | `NEXT BATCH` / `SHIPS SOON` | `下批现做` / `现订现发` | `public/shop.html:4644` |
| Web size pickers (both) | pre-order | `PRE-ORDER` | `可预订` | `public/shop.html:5047`, `:5349` |
| Web size pickers | sold out | `Sold out` | `售罄` | same lines |
| Web quick-add toast | pre-order | `Added — pre-order 🌱` | `已预订，加入购物车 🌱` | `public/shop.html:4993`, `:5364` |

### 5.2 Against the blueprint pairs

There is no customer-facing bilingual blueprint for this pill; the two documented pairs are
both operator-side, and **the code disagrees with one of them**:

- `design-handoff/07-products.md:24` documents the admin select as
  `Sold out everywhere · 全国售罄停售` / `Pre-order outside Guangzhou · 广州外可预订`.
  `public/retail-admin.html:4536-4537` renders exactly those, with `（现订现发）` appended to
  the second. Match, plus an undocumented suffix.
- `database.js:2833-2836` states the customer-facing badge as
  "现订现发 / SHIPS SOON, or 下批现做 / NEXT BATCH for batch meals". The web storefront
  matches this verbatim (`public/shop.html:5102`). **The mini app does not** — all three
  mini-app surfaces render `可预订 / PRE-ORDER` and never distinguish batch meals. Trusting
  the code: the schema comment describes only the web storefront's wording, and is wrong
  about the mini app.

The CN halves are internally consistent per surface and idiomatic; the mini app's `可预订`
("can be reserved") and the web's `现订现发` ("order now, ships when made") make different
promises for the same product state.

### 5.3 Agreement and drift

Drifted, on four axes:

| Axis | Mini app | Web storefront |
|---|---|---|
| Wording | `PRE-ORDER / 可预订` everywhere | `SHIPS SOON / 现订现发` + `NEXT BATCH / 下批现做` on cards and PDP; `PRE-ORDER / 可预订` in the size pickers only |
| Batch-vs-generic | Not distinguished | Distinguished on cards/PDP (`is_batch_made`), not in size pickers |
| Explanatory line | None on any browse surface | PDP carries a one-line explanation (`:5195`) |
| Buy-button label | Switches to `预订 / PRE-ORDER` (`product.js:712`) | Stays `加入购物车 / ADD TO BASKET` (`:5203`) |

Styling also differs, though each surface is self-consistent: mini-app shop cards/gallery
use a full-width olive band (`shop.wxss:296-301`, `:354-359`), the list row uses an olive
rounded pill (`:542-547`), the size picker a smaller olive pill (`:682-685`), favourites an
olive corner tag (`favorites.wxss:195-201`) against an ink-black sold-out tag (`:183-189`),
and the PDP a `--olive` chip (`product.wxss:85`) against a `--berry` sold-out chip (`:83`).
On the web, the desktop card tag is a square `--forest` corner tag (`public/shop.html:112`),
the PDP a rounded `--accent` chip (`:116`), the mobile list a pale forest-tinted inline tag
(`:959`), and the size-picker pill olive (`:1002-1003`). Sold-out styling is likewise split
between ink-black (mini-app cards, favourites, web `.oos-tag.sold`) and a translucent grey
(`shop.wxss:536-541`, `:677-680`).

---

## 6. The out-of-city pop-up

### 6.1 What fires it, and where

It is a **checkout** pop-up, not a browse-surface one; no browse surface shows any
pre-order explanation.

| Step | Site |
|---|---|
| Server builds it | `computePreorderNotice()` `routes/retail.js:25743-25767` |
| Attached to the quote response as `preorder_notice` | `routes/retail.js:27118` |
| Mini app stores it | `checkout.js:1468-1469` |
| Mini app auto-opens it | `checkout.js:1502-1504` |
| Mini app banner (tap re-opens) | `checkout.wxml:274-279` → `openPreorderNotice` `checkout.js:2061-2063` |
| Mini app modal markup | `checkout.wxml:1064-1086` |
| Web renders banner + auto-opens | `public/shop.html:2394-2405` |
| Web modal | `public/shop.html:2406-2425` |
| Web "Details" button re-opens | `public/shop.html:2402-2403` |

It is not triggered by a tap. It appears when the checkout's `/quote` response comes back —
i.e. on arriving at checkout, and again after any change that re-quotes (address, slot,
cart). The banner's tap target (mini app) or its "详情 / Details" button (web) re-opens the
modal on demand.

Its conditions (`routes/retail.js:25744-25758`): `requiresStockGate` false, the product is
**not** `is_batch_made`, its effective policy is `backorder_gz`, and its summed sellable
stock is ≤ 0. Note the first condition is `!requiresStockGate`, not "out of city" — a
**Guangzhou** customer on a future-dated slot gets this same pop-up (§4).

### 6.2 Full copy

Server-authored (`routes/retail.js:25760-25766`), identical on both surfaces:

| Field | EN | CN |
|---|---|---|
| Kicker | `Pre-order` | `预订` |
| Title | `Ships soon` | `现订现发` |
| Body | `Some items in your order are currently out of stock. Your order is a pre-order — we'll ship everything together as soon as they're back in stock.` | `您订单中的部分商品目前缺货。此为预订订单，我们将在补货后尽快为您一并发货。` |
| Items | the qualifying product names, as chips/thumbnails | same |
| Dismiss | `Got it` (`checkout.wxml:1083`) | `知道了` |
| Banner action | `Details` (`public/shop.html:2401`) | `详情` |

The mini-app modal adds a 📦 hero and thumbnails for the affected items
(`checkout.wxml:1066-1079`); the web uses a 📦 glyph and text chips (`:2414-2419`).

### 6.3 Date, ETA, or concept only

**Concept only.** No date, no ETA, no window — the strongest statement is "as soon as
they're back in stock / 补货后尽快". Contrast the batch notice, which does carry dates
(`routes/retail.js:25631-25661`) and is mutually exclusive with this one (`:25755`).

### 6.4 Frequency

**Once per checkout visit, then a persistent banner.** Not per product.

- Mini app: `preorderNoticeSeen` gates the auto-open (`checkout.js:1502-1503`), initialised
  false in `data` (`:129`) so it resets on each page instance; the banner stays for the whole
  visit and re-opens the modal on tap (`:2061-2063`). It also stands down if the batch popup
  is already auto-showing (`:1501-1503`) and if the local-only popup is open.
- Web: `co.preorderSeen=false` is reset when the checkout view is entered
  (`public/shop.html:1808`), and the auto-open is gated on it (`:2404`).
- One modal covers all qualifying items — they are listed inside it, not popped one by one.

### 6.5 Equivalent for a same-city shopper

**None.** For a same-city shopper the row now renders as a plain dead SOLD OUT with no
explanation of why an item their neighbours can order is unavailable to them:

- No mini-app surface renders any pre-order or sold-out explanatory copy — the only strings
  are the pill itself and the refusal toast "已售罄 / Sold out" (`shop.js:1005`).
- The web PDP's one-line note is gated on `ss.oos && !ss.soldOut` (`public/shop.html:5195`),
  which is false once `stockState` marks a same-city shopper's row `soldOut` — so it
  disappears exactly for them.
- `computePreorderNotice` returns `null` for them by its first condition (`:25744`), so no
  checkout banner appears either.
- If they nonetheless reach checkout with such an item (added before the address switch, or
  via the web mobile list), what they get is the 5-option out-of-stock modal (§3.2) — a
  shortage flow, not an explanation of the pre-order rule.

---

## 7. What happens after an out-of-city pre-order

Traced for the ordinary path (no `fallback_choice`; the `wait_for_restock` flow is out of
scope and differs).

| Aspect | Behaviour | Evidence |
|---|---|---|
| Status at creation | `pending_payment`, like every order | `routes/retail.js:9759-9773` |
| Status after payment | `paid` via `markOrderPaid` (the `awaiting_restock` branch applies only to `wait_for_restock`) | `routes/retail.js:4279-4291` |
| Stock reserved? | **No.** Reservation is skipped whenever `stockGate` is false | `routes/retail.js:9891-9909` |
| Where it is fulfilled from | Nearest-ranked store from `routeOrder(ignoreStock: true)`, then **re-pinned** to `out_of_city_store_id` for any non-GZ destination (and for GZ ship-districts without a same-day pick) | `lib/inventory.js:518-526`; `routes/retail.js:9442-9445`, `:9455-9478` |
| Customer notices at order time | The pre-order banner/modal at checkout (§6). A `batch_delay` in-app notification **only** if the cart held a batch item | `routes/retail.js:10006-10018` |
| Promised dates on the order | Only for batch items; otherwise both columns stay NULL | `routes/retail.js:10007-10011` |
| What the operator sees | An ordinary paid order. There is **no** pre-order/backorder marker anywhere in retail-admin — no occurrence of `oos_preorder` or `backorder` in `public/retail-admin/*.js` or `retail-admin.html` outside the product editor's own policy select and an unrelated purchasing "Back-order" button (`16-purchasing.js:868`) | grep |
| Naming collision | The admin's `Pre-order · 预订单` pill (`04-orders.js:4381`) means a Meituan/Eleme **booked delivery window** (`channel_preorder_at`, `:4372`), nothing to do with `oos_policy` | `04-orders.js:4367-4381` |
| Batch-item cue for the operator | `promised_ship_date` drives a "make fresh on this day" headline | `04-orders.js:1787-1793` |
| When stock is actually deducted | Not at checkout. `commitUnreservedOrder` runs on the first forward transition into preparing/dispatched/delivered | `routes/retail.js:1346-1362`; `lib/inventory.js:678-712` |
| How it ships | Normal out-of-GZ courier flow: `dispatched` → `notifyOrderStatusChange` (`'Your order has shipped' / '订单已发货'`), then `delivered` → in-app + the Aliyun delivered SMS | `routes/retail.js:20996`, `:23216`, `:5906-5959`, `:5774-5780` |

**What differs from a normal order**

1. **No stock hold at all.** A normal GZ same-day order reserves at checkout and commits on
   payment (`reserveForOrder` `lib/inventory.js:582`, `commitOrderReservations` `:637`). A
   pre-order takes neither, so nothing stops any number of further orders, or a walk-in
   sale, from consuming the units it is waiting on (see §2.2 — there is no cap either).
2. **Stock goes negative when it is finally worked.** `commitUnreservedOrder` decrements
   with a plain `physical_qty = physical_qty - ?` and no floor (`lib/inventory.js:694`,
   `:701-705`), so committing a line that was ordered at 0 leaves `retail_store_stock`
   negative, and the ledger row records that negative `balance_after` (`:703`). The catalog's
   `sellableStockSql` sums `physical_qty` without clamping (`lib/inventory.js:184-197`), so
   the shop simply keeps reading ≤ 0 → sold out.
3. **`isStockPending` marks it.** Between payment and first handling it is flagged as a paid
   order with no reservation and no ledger row (`lib/inventory.js:713-731`) — the only
   machine-readable trace that this order's stock was never accounted for. UNVERIFIED
   whether any admin screen renders that flag.
4. **The customer's only date, if any, comes from the batch notice** — otherwise they were
   told "as soon as they're back in stock" and are never told again until the shipped
   notification (§2.3).

---

## UNVERIFIED

| Item | Why |
|---|---|
| Live distribution of `oos_policy` values across the production catalogue | No production access; the container's `data/roots.db` has 0 `store_products` and 0 `products` rows |
| How many live products rely on the legacy `is_batch_made → backorder_gz` inference vs. an explicit operator save | Same |
| Whether any retail-admin screen renders `isStockPending` to an operator | Helper located (`lib/inventory.js:713-731`); its consumers were not traced to a rendered element |
| Runtime behaviour on a real device (WeChat mini app, WeChat webview) — everything above is from source, plus `scripts/test_preorder_local.js` (21 assertions, passing) | No device or staging environment in this container |

---

## Doc-vs-code disagreements found

| Doc claim | Code | Verdict |
|---|---|---|
| `database.js:2833-2836` — the customer-facing badge is "现订现发 / SHIPS SOON, or 下批现做 / NEXT BATCH" | Mini app renders `可预订 / PRE-ORDER` on all three surfaces and ignores `is_batch_made` (`shop.js:266`, `product.js:462`, `favorites.js:21,38`); only `public/shop.html:5102` matches the comment | Comment describes the web storefront only; code wins |
| `public/shop.html:5062-5065` — "The web storefront doesn't know the shopper's zone yet, so a backorder product is shown orderable" | Stale for `stockState`/`slStock` since `6632939`, which added `shopperSameCity()` (`:5078-5083`); still literally true for `slToRows` (`:4631, 4636`) | Comment half-stale; code wins |
| `docs/tacet-product-fields.md:76` — `oos_policy` "DEAD on `products`" | Confirmed: written and read only on `store_products` | Doc correct |
