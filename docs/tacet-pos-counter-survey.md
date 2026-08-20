# Counter sale and the payment rails — what is built today

**2026-08-20 · Read-only survey. Four questions: what the counter sale actually is as built, which payment paths exist, what shape an adapter seam would have to fit, and how a payment credential is scoped. Every claim is cited to a file and line in the working tree at `origin/main` = `f2241022`. No code was changed. No row data was read. This document reports; it proposes nothing.**

> Line numbers are from `f2241022`. Where an existing document's citation has drifted, the drift is recorded rather than silently corrected.
>
> **AMENDED 2026-08-20.** Two findings in this survey — the stock gap (§1.5, §1.5a) and the two capability holes (§1.8) — have since been fixed, §6 files a third bug found while fixing them, and §7 answers a separate question asked later the same day — whether one https QR can serve both wallets. The §1–§5 text is left as surveyed, with dated status notes added where it would otherwise read as still-true. **Every `routes/retail.js` pin in §1–§5 predates the fix**, which added ~160 lines to that file; §1.5, §1.5a and §6 cite the current tree and say so.

Terms used below, one line each:

- **Counter sale** — `fulfillment_type = 'counter'`: goods handed over at the till in the same moment they were paid (`lib/fulfilment.js:11`).
- **Rail** — one payment method as the customer experiences it (WeChat Pay, Alipay, cash).
- **Mode** — one WeChat/Alipay *product* within a rail (JSAPI, H5, Native, precreate, wap, page).
- **JSAPI** — WeChat Pay inside a mini-program or the WeChat browser; needs the payer's `openid`.
- **Native** — WeChat Pay QR the merchant displays and the customer scans with their own phone.
- **付款码 / micropay** — the reverse: the *customer* shows a barcode and the *merchant* scans it. This is the shape a till normally uses.
- **Account / tenant** — one business on the platform (`tenants` row). **Location / store** — one `retail_stores` row inside that business.

---

## Summary

**The counter sale is fully built and live, and it is simultaneously marked for deletion.** `ORDER_FULFILLMENT_TYPES` still carries `'counter'` (`routes/retail.js:20524`), the New Order page offers it as a first-class choice (`public/retail-admin.html:2785`), and a dedicated module exists solely to give it correct semantics everywhere (`lib/fulfilment.js`). §13 of the decisions document says of the same value: *"never reaches the customer path. Dead; delete it."* (`docs/tacet-consolidation-decisions.md:324`). Both statements are current. The deletion has not been acted on — and the New Order work is not a reinstatement of something that was removed. The ordering is the other way round, and it matters: `lib/fulfilment.js` and the counter option landed **2026-07-30** (`d2f3ca68`, `ceb14822`), and the "Dead; delete it" line entered the docs on **2026-07-31** (`4c9ab225`). The decision was written down *after* the build that contradicts it, on the following day.

**A counter sale moves no stock.** — **FIXED 2026-08-20; see §1.5 and §1.5a.** As surveyed, before the fix: manual orders held no reservation, so `commitOrderReservations` finds nothing (`lib/inventory.js:676-681`), and the only other decrement path in `markOrderPaid` was gated on the order having a Guangzhou *address* (`routes/retail.js:4503-4507`) — which a counter sale is forbidden to carry (`routes/retail.js:20777-20779`). The sale was booked as revenue, the printer printed a receipt, and the shelf count never moved.

**Every payment path in the system is customer-scans-merchant or merchant-sends-a-link. There is no 付款码 / micropay path anywhere**, in retail or in billing — confirmed by grep across the whole repository (§2.5). WeChat Pay Native *is* wired for retail orders today, in two places, one of which is an un-authenticated guest page reachable from any manual order (§2.1).

**Alipay is half a gateway and half a photograph.** The real gateway code exists and is complete for three products (precreate, wap, page) — but it reads module-level `process.env` constants (`routes/retail.js:3386-3391`) and is therefore hard-gated to Roots alone (`routes/retail.js:4727`). Every other account gets the manual path: the operator uploads a static 收款码 image, the customer pays it, uploads a screenshot, and a Haiku vision call reads that screenshot and grades it (`lib/alipay-ocr.js`, `routes/retail.js:3465-3520`).

**`retail_payments.qr_image_url` is written twice, selected once, and rendered nowhere** (§2.6).

**Payment credentials are scoped per ACCOUNT and nothing else.** `tenant_secrets` is keyed `UNIQUE(tenant_id, key)` (`lib/tenant-creds.js:41`), and there is no store dimension for a Pay credential. Per-location credentials already exist in that same table for *other* providers — Meituan and Qingyun use dynamic `<provider>.<store_code>.<user|pass>` keys (`lib/tenant-creds.js:118-123`) — so the storage supports the shape and the payment keys simply do not use it (§4).

---

## 1. COUNTER SALE, AS BUILT

### 1.1 Where `counter` is declared — twice

There are two independent lists of fulfilment types:

| List | Location | Read by |
|---|---|---|
| `FULFILMENT_TYPES` | `lib/fulfilment.js:18` | exported (`:70`) but **no consumer imports it** — `routes/retail.js:40` imports only `isCounter`, `shipsNothing`, `isTerminalOnPaid` |
| `ORDER_FULFILLMENT_TYPES` | `routes/retail.js:20524` | the manual-order fee preview (`:20617`) and the manual-order create (`:20746`) |

Both hold `['delivery', 'pickup', 'counter']`. A third copy exists in a test harness (`scripts/test_tx_conversion_manual_order.js:158`).

`docs/tacet-order-routing.md:363` cites `ORDER_FULFILLMENT_TYPES` at `routes/retail.js:18940`. It is at `:20524` today — **citation drift; the finding it supports is unchanged.**

### 1.2 Is it live? Yes, on the staff path only

- **Accepted by the server.** `routes/retail.js:20743-20748` — `fulfillment_type` is required and must be in `ORDER_FULFILLMENT_TYPES`. The old `declaredFt` seam that defaulted it to `'delivery'` was closed 2026-07-31 (`:20735-20742`).
- **Offered by the UI.** `public/retail-admin.html:2785` — `<option value="counter">Counter sale · 前台销售</option>`.
- **Unreachable from the customer path, by construction.** The customer checkout branches `isPickup = body.fulfillment_type === 'pickup'` (`routes/retail.js:9447`) and writes the column as `isPickup ? 'pickup' : 'delivery'` (`:10388`) — a customer cannot store `'counter'` even by posting it.
- **Immutable after create.** There is no `UPDATE … SET fulfillment_type` anywhere in `routes/retail.js` (grep returns nothing). The value is set once, at INSERT (`:20858`).

### 1.3 The §13 decision, and its status

`docs/tacet-consolidation-decisions.md:324`, inside `## 13. Sales record`:

> `ORDER_FULFILLMENT_TYPES` carries a third value, `counter`, that never reaches the customer path. Dead; delete it.

**Not acted on.** The value is present at `routes/retail.js:20524` and reachable from the UI.

**Stated plainly, as asked:** the same value is *both* slated for deletion by §13 *and* an actively-built, semantically-supported feature of the New Order page — and the build came first. The evidence:

| Date | Commit | What landed |
|---|---|---|
| 2026-07-30 | `ceb14822` | The New Order form, including the `counter` option (`public/retail-admin.html:2785`) |
| 2026-07-30 | `d2f3ca68` | `lib/fulfilment.js` created — *"A walk-in was recorded as a delivery that had not left yet"* |
| 2026-07-31 | `4c9ab225` | §13's "Dead; delete it" line added to the decisions doc |

`lib/fulfilment.js:3-6` states its own reason for existing: *"the alternative is ~30 call sites each deciding for themselves what a walk-in is — which is how `'counter'` spent its first day being stored correctly and read as a delivery everywhere."* That is a module built to make `counter` correct, one day before the decision to delete it was recorded.

The same §13 also says *"POS is REMOVED from the production app and becomes a sales channel like any other"* (`:322`), and §14 lists POS among the agreed channels (`:337`) — so §13 removes the fulfilment type while keeping the channel.

Live call sites now depending on the three helpers: `routes/retail.js:4158, 4179, 4383, 4449, 5924, 9016, 10713, 10755, 10983, 10987, 11052, 11266, 21483, 22100, 29351, 29846`; `lib/feie.js:438, 532, 783`. Plus the client's own duplicate predicates at `public/retail-admin/04-orders.js:208` and `:212`.

### 1.4 The New Order full-page work — current state

**The page.** A rail-less sub-page of Orders using the `#tab-orders-new` takeover (`public/retail-admin/04-orders.js:7598` `ordNewOpen`, container at `public/retail-admin.html:2719`). The modal it replaced was deleted 2026-07-31 (`public/retail-admin/04-orders.js:7570-7580`). Two doors in: the header CTA (`public/retail-admin.html:2218`) and a command-palette entry (`public/retail-admin/02-settings-ops.js:1173-1179`). Browser Back is trapped so it lands on the Orders list rather than outside the section (`04-orders.js:7616-7620`).

**Draft storage — a separate table, deliberately not an order status.**

`database.js:3256-3263`:

```sql
CREATE TABLE IF NOT EXISTS retail_order_drafts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  created_by   INTEGER NOT NULL,        -- audit integer, NOT an FK
  owner_realm  TEXT    NOT NULL,        -- 'backend' | 'kitchen'
  payload      TEXT    NOT NULL,        -- opaque form state (JSON), never validated here
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

- The reason for a separate table rather than `retail_orders.status = 'draft'` is stated at `database.js:3231-3240`: that column feeds the filter chips, the KPI tiles, reports and customer lifetime spend, and "the first one that forgets counts a half-typed order as revenue".
- `owner_realm` exists because `req.user.id` spans two id spaces — `tenant_users(id)` for a backend operator, kitchen `users(id)` for the legacy path — and within Roots both share one database (`database.js:3246-3252`; resolver at `routes/retail.js:20966-20968`).
- Five endpoints, no more: POST `:20979`, LIST `:21045`, GET one `:21067`, PATCH `:21083`, DELETE `:21101`. No autosave, no expiry, no sharing, no crash recovery (`:20948-20950`).
- Payload cap 64 KB, never inspected (`:20962`, `:20971-20977`).
- The list returns a **derived preview** — a `kind` plus raw names, never a rendered sentence, so the page can render it in the operator's own language (`:21007-21046`). Capped at 50 rows; the reason it is derived server-side is that 50 × 64 KB would be up to 3 MB to draw one screen (`:20999-21001`).
- Somebody else's draft returns **404, not 403** — a 403 would confirm it exists (`:21066`).
- Client: chip + list at `04-orders.js:8256-8380`; open one at `:8356`; create-then-delete-the-draft at `:8626-8630`; save/PATCH at `:8662-8667`.

**Customer search — five states.** Debounced 220 ms against `/api/retail-admin/customers?pageSize=8&q=` (`04-orders.js:7726-7742`), with a superseded-keystroke guard at `:7734`. Three resting states (`rest | linked | guest`, `:7668`) and two distinct empty states: *no match* versus *no customers on this account at all*, told apart by `customers_on_file` from the roster response (`:7755-7765`). Picking links the customer (`:7767`); "use as guest" carries the typed text into the guest name (`:7776-7784`). A phone typed on the guest path is checked on blur against existing customers and can report `match | blocked | shared` (`:7833-7845`, painted `:7847`). "Also save as a customer" is on by default (`:7671`) and is resolved **inside the order's own transaction**, never as a separate POST (`routes/retail.js:20790-20796`), gated on `customers:edit` (`:20800-20803`).

**Fulfilment picker.** `public/retail-admin.html:2782-2787` — a three-option select wired to `ordNewFulChange()` (`04-orders.js:7952-7971`), which does three things:

1. Hides the address block for anything that is not `delivery` — `hidden`, i.e. out of layout and out of the accessibility tree, never disabled and never shown empty (`:7956-7957`; markup note at `public/retail-admin.html:2838-2841`).
2. On switching **into** `counter`, forces Status → `paid` and Pay method → `offline`; on switching **out of** counter, restores `pending_payment` / `wechat` (`:7960-7966`).
3. Re-quotes both fees, because delivery, collection and counter are three different fee answers (`:7970`).

Restoring a draft deliberately pre-sets `ONW.ful` before calling the handler, so a restored counter sale is not treated as a fresh switch that would overwrite the saved status and pay method (`:8577-8584`).

Server-side, the address rule is unconditional and mirrored: a delivery **must** have an address, anything else **must not** (`routes/retail.js:20773-20779`), returning `address_not_allowed_for_counter`. The comment at `:20735-20742` records why: *"a defaulted 'delivery' with the address rule disabled is how a counter sale acquires a shipping address."*

The fee engine returns nothing at all for counter — `manualOrderFees` returns the zero object for any non-delivery that is not pickup (`routes/retail.js:20554-20558`), and the page says so in words (`04-orders.js:8223-8225`).

### 1.5 What a counter order does to STOCK — nothing (FIXED 2026-08-20)

> **STATUS: this section describes the defect, which is now fixed.** The decrement was added to `markOrderPaid`'s
> `isTerminalOnPaid` block (`routes/retail.js:4561`) and mirrored into the admin Mark-paid path
> (`:25459-25469`), both through `prepareCommitUnreservedOrder` so the ledger row is order-linked and the
> Meituan/Eleme/Guanyi sync fires. A counter sale now also requires a `store_id` at create
> (`store_required_for_counter`), because the decrement reads the location off the order and a walk-in with no
> till is incoherent. The reversal half is §1.5a. Regression cover: `scripts/verify-fulfilment-types.js` §11.
> The trace below is left standing because it is the account of how the gap arose, and nothing else records it.

Trace, in order:

1. Create posts `status: 'paid'` (forced by the picker). The row is **always** inserted as `pending_payment` and then flipped through the shared path (`routes/retail.js:20848-20851`, `:20929-20932`).
2. `markOrderPaid()` (`routes/retail.js:4407`) flips to `'paid'`, completes the payment row, then — because `isTerminalOnPaid` is true for counter (`lib/fulfilment.js:65-67`) — flips straight to `'delivered'` with `delivered_at = paid_at` (`routes/retail.js:4446-4459`).
3. Stock: `inventory.commitOrderReservations(orderId)` at `:4490`. It reads `retail_stock_reservations WHERE order_id = ? AND status = 'active'` and returns `{ committed: 0 }` when there are none (`lib/inventory.js:676-681`). **A manual order never creates a reservation** — the create route holds "no vouchers/points/stock-gate/live-payment machinery" (`routes/retail.js:20496-20498`) and says so directly at `:20927`: *"Manual orders hold no stock reservation, so the inventory commit inside is a harmless no-op."*
4. The only other decrement inside `markOrderPaid` is `prepareCommitUnreservedOrder`, gated on `addr && inventory.isGuangzhouAddress(addr)` (`routes/retail.js:4503-4507`). A counter sale has `address_json = NULL` by rule (§1.4), so `addr` is null and the branch never runs.
5. The admin status route's own `prepareCommitUnreservedOrder` hook fires only on `preparing | dispatched | delivered` transitions requested *through that route* (`routes/retail.js:25266-25272`). A counter sale reaches `delivered` inside `markOrderPaid`, not through that route, so this never fires either.

**Result: a counter sale is booked, printed and counted as revenue while `retail_store_stock.physical_qty` is unchanged and no `retail_stock_ledger` row is written.** No comment anywhere states this as intended; it falls out of "manual orders don't reserve" meeting "counter has no address".

### 1.5a The reversal half — wider than counter, also fixed 2026-08-20

Found while fixing the above, and larger than it. Both reversers start from `retail_stock_reservations WHERE status = 'committed'` (`lib/inventory.js:793`, `:835`) and return `{ reversed: 0 }` for an order with none. But `commitUnreservedOrder` decrements **without ever writing a reservation row**, and its ledger reason `order_prepare` appeared in exactly one place in the repository — the INSERT that writes it (`lib/inventory.js:735`). Nothing read it back.

**So every out-of-Guangzhou and every scheduled-ahead order had been decrementing on its first forward transition and never getting the stock back on refund or cancel.** The reversers ran, found no reservations, and returned zero silently. Counter sales joined that population for a different reason — they never reserve at all — which is how the older bug surfaced.

Fixed by `inventory.reverseCommittedLedger` (`lib/inventory.js:923`), ledger-driven rather than reservation-driven, with the cap computed per product from the ledger itself: `Σ(-delta)` over `order%` rows minus `Σ(delta)` over `order_reverse%` rows. A second refund is therefore arithmetically incapable of over-returning, rather than merely blocked — which matters because `reverseCommittedOrder`'s single-row guard (`:802-807`) short-circuits the whole call and would refuse a legitimate second partial. Wired into all six call sites behind one wrapper, `reverseOrderStock` (`routes/retail.js:1531`), which tries the reservation-driven pair first and falls through on their zero.

### 1.6 What it does to the SALES RECORD

- One row in `retail_orders` with `source = 'manual'` (server-set, not client-claimable — `routes/retail.js:20503-20505`), `channel` from the payload restricted to `MANUAL_ORDER_CHANNELS` (`:20521`, validated `:20722-20724`), `created_by = req.user.id`, `store_id`, `fulfillment_type = 'counter'` (`:20845-20862`).
- Line rows in `retail_order_items`, snapshotting `ship_modes`, `needs_ice_pack`, `ship_from_supplier` (`:20870-20893`).
- One `retail_payments` row, inserted `pending` and completed by `markOrderPaid` (`:20884-20887`, `:4425-4427`).
- **It counts as revenue.** The reporting predicate is `status IN ('paid','preparing','dispatched','delivered','awaiting_restock')` — `routes/retail.js:1871`, `:12755`, `:12774`, `:12882`, `:13555`, `:19784`, `:20285`. `delivered` is in the set, so a counter sale is included everywhere by construction. `lib/fulfilment.js:62-64` names this as the reason `delivered` was reused rather than a fourth status invented.
- **It is deliberately absent from three places**: no `notifyOrderStatusChange()` — so no delivered SMS and no WeChat shipping upload; no `order_delivered` activity event, so the dashboard Recap's "N orders delivered" excludes walk-ins (`routes/retail.js:4441-4445`); and no Qingyun courier push, because `shipsNothing()` short-circuits the enqueue (`:4383`).
- The operator-facing label is re-worded: `delivered` renders as "Completed · 已完成" for a counter sale (`public/retail-admin/04-orders.js:2631-2637`).
- The merchant WeCom alert gets its **own card shape** — no recipient, no address, no slot, and two lines saying nothing is outstanding (`routes/retail.js:4108-4135`), with items and cashier name fetched only on that branch (`:4156-4177`). The cashier lookup is best-effort and drops the line when `created_by` does not resolve in `tenant_users`, because the id spans two realms (`:4168-4176`).

### 1.7 What it does to the PRINTER

- `autoPrintOrder(orderId)` fires from `markOrderPaid` (`routes/retail.js:4560`; function at `:23721`), gated on `printer.auto_print` and Feie being configured (`:23725`).
- Routing: `printerForOrder` (`:23644`) reads the destination city; a counter sale has none, so it routes by the order's `store_id`, with a fallback chain that never silently drops a ticket (`:23653-23662`).
- **The template is forced.** A store configured for the `packing` template gets `receipt` instead for a counter sale, because "a picking list for goods that left as they were rung up… reads as an instruction to go and find them" (`lib/feie.js:777-784`).
- **No promised-date line prints.** `shipByPrintParts` returns `null` for a counter sale ahead of every other branch, explicitly rather than by falling through (`lib/feie.js:432-438`).
- The "To / Tel" hand-over block is suppressed (`lib/feie.js:528-532`).
- No parcel block: `ensureShipments` is skipped for anything that ships nothing (`routes/retail.js:21483`, `:22100`).
- The outcome is recorded on the order — `print_status` / `print_error` / `printed_at` (`:23700-23716`).

### 1.8 Which capabilities gate it

| Surface | Gate | Cite |
|---|---|---|
| The Orders rail button | `orders:view` via `TAB_CAP` | `public/retail-admin/01-core.js:181`, applied `:227-231` |
| The "New order" header CTA | **none** — the button carries no `data-cap` | `public/retail-admin.html:2218` |
| The command-palette entry | `orders:view` **and** `orders:edit` | `public/retail-admin/02-settings-ops.js:1173-1174` |
| `POST /api/retail-admin/orders` | `requireRetailAdmin` + `orders:edit` | `routes/retail.js:20645`; map `lib/cap-routes.js:51` |
| All five draft endpoints | `requireRetailAdmin` + `orders:edit`, mapped **explicitly** because `/order-drafts` does not start with `/orders` | `lib/cap-routes.js:36-40` |
| "Also save as a customer" | additionally `customers:edit` | `routes/retail.js:20800-20803` |
| `POST /api/retail-admin/order-fees` | **unmapped** in `lib/cap-routes.js` → falls through allowed | `routes/retail.js:20614`; no matching rule (`/order-fees` does not match the `/orders` prefix — the same class of miss the drafts line at `lib/cap-routes.js:36-40` exists to correct) |

Two properties of the enforcement layer qualify every row above:

- **It is dark.** `cap-routes` runs only when `tenants.rbac_enforce` is 1, which defaults to 0 (`routes/retail.js:145`, `routes/backend-auth.js:257`), and the owner bypasses it entirely (`:145`).
- **Legacy kitchen operators hold every capability.** The kitchen path assigns `ALL_KEYS` unconditionally (`routes/retail.js:180-181`), so no capability narrows a kitchen login.

Caps referenced: `orders:view`, `orders:edit` (`lib/capabilities.js:37-38`), `customers:edit` (`lib/capabilities.js:48`).

---

## 2. PAYMENT PATHS THAT EXIST TODAY

### 2.1 WeChat Pay — four modes, all v3, all sharing one callback

| Mode | Prepare fn | Returns | Called from |
|---|---|---|---|
| **JSAPI** | `wechatJsapiPrepare` `routes/retail.js:3675` | `prepay_id` | orders (`wechatPayCreate` `:3708`, used `:4683`), wallet top-up (`:29181`), order add-on (`:29976`) |
| **H5 (MWEB)** | `wechatH5Prepare` `:3731` | `h5_url` + appended `redirect_url` | `/api/retail/payment/create` when `channel === 'h5'` (`:4639`) |
| **Native (QR)** | `wechatNativePrepare` `:3767` | `code_url` (`weixin://`) | `/api/retail/payment/create` when `channel === 'native'` (`:4658`) **and** the guest pay page (`:5156-5164`) |
| **Native (billing)** | inline in `lib/billing-providers.js:107-147` | `code_url` + PNG | subscription invoices only (`routes/billing-pay.js:127`) |

Supporting pieces: request signing `signMerchantRequest` (`:3659-3669`); trade-state poll fallback `wechatTradeState` (`:3799`, used `:4800-4816` and `:5208`); async notify `POST /api/retail/payment/wechat/callback` for Roots and `…/callback/:tid` for every other account (`:5344-5349`); refund notify (`:5403`). The paid amount is re-checked in cents against the stored charge before settling (`:5080-5089`).

**Can retail orders use Native today? Yes — in two places, and one of them is un-authenticated.**

1. `POST /api/retail/payment/create` with `channel: 'native'` (`routes/retail.js:4658-4671`), behind `requireRetailAuth`. The web storefront sends this on desktop (`public/shop.html:1901` — `inWechat ? 'jsapi' : mobile ? 'h5' : 'native'`).
2. **The guest pay page.** `POST /api/pay/:token/create` with `method: 'wechat'` *always* uses Native (`routes/retail.js:5155-5167`). It is un-authed by design — the unguessable `pay_token` is the capability — and tenant-scoped by host/appid (`:5105-5111`). A `pay_token` is minted for **every** manual order (`:20784`), and the admin surfaces the URL in the order drawer (`public/retail-admin/04-orders.js:5063-5072`). The server-rendered page shows the QR (`routes/retail.js:5323`; page route `:5338`).

So the "show the customer a QR and let them scan it" mechanism already exists end to end for a manually-created retail order. It is reached through the guest link rather than through anything on the New Order page, and the admin renders a **link**, not the QR — the QR is drawn on the guest page.

Native is not exposed to the mini-app: the mini-app sends no channel and falls through to JSAPI (`routes/retail.js:4586-4589`, `:4676`).

### 2.2 Alipay — what is real gateway code

Real, complete, signed gateway code:

- Env constants and dev-mode flag: `routes/retail.js:3386-3391`. `ALIPAY_DEV_MODE = !ALIPAY_APP_ID || !ALIPAY_PRIVATE_KEY`.
- `alipayApiCall` (`:3870`), `alipaySignString` (`:3859`), `alipayTimestamp` (`:3847`).
- `alipay.trade.precreate` → `alipayPrecreate` (`:3910`) returns the `qr_code` string; rendered to PNG server-side so the mini-app needs no QR encoder in its bundle (`:4749-4751`).
- `alipay.trade.wap.pay` / `alipay.trade.page.pay` → `alipayPageRedirectUrl` (`:3929`), a fully RSA2-signed GET redirect.
- `alipay.trade.query` → `alipayTradeQuery` (`:3957`), the poll-time fallback (`:4782-4796`, `:5199-5206`).
- Async-notify verification → `alipayVerifyNotify` (`:3968`); the callback itself at `:5414`, checking signature, `app_id`, and `total_amount` against the stored charge before settling.

**Two hard limits on all of the above:**

1. **Roots only.** `routes/retail.js:4727-4729` — any account that is not `ROOTS_TENANT_ID`, or any dev-mode install, gets `501 alipay_not_configured`. The comment states the reason: the constants are global env, so another account's charge would settle to Roots' merchant — "a money leak". The same gate repeats on the guest path (`:5181`).
2. **The callback is not account-scoped.** WeChat has `…/wechat/callback/:tid` (`:5345`); Alipay has only `POST /api/retail/payment/alipay/callback` (`:5414`), and `ALIPAY_NOTIFY_URL` is a fixed env constant (`:3388`) with no per-account variant (contrast `wechatNotifyUrl()` at `:3563`).

### 2.3 Alipay — what is screenshot OCR

The fallback that every non-Roots account actually gets:

- **Config**, per account, stored under the private `integrations.alipayManual` key in `storefront_config` so the raw QR never rides in the public config blob: `{ enabled, qr, account, ocrEnabled, autoFlip, payeeMatch, timeWindowMin, proofAgeMin, anthropicKey }` — read `routes/retail.js:3408-3417`, admin GET `:18574`, admin PUT `:18587-18619`.
- **Priority.** When configured, manual takes priority over the auto path for Alipay, in both `/payment/create` (`:4707-4721`) and the guest page (`:5173-5180`), returning `mode: 'manual'` with the operator's QR and a pay-window in minutes.
- **The proof.** The customer uploads a screenshot to `POST /api/retail/payment/alipay-proof/:orderId` (`:4837`), stored on the order as `alipay_proof_image` / `alipay_proof_hash` / `alipay_proof_at`.
- **The read.** `lib/alipay-ocr.js` — a single vision call to `claude-haiku-4-5-20251001` (`:17`) through `lib/model-gateway.js`, returning `{success, amount, payee, payee_full, paid_at, txn_id, raw_time_text, status_bar_time}` (`:29-49`). Fail-soft by contract: any error returns verdict `error` and the order stays pending for a human (`:5-7`). One retry, on transient network errors only (`routes/retail.js:4874-4890`).
- **The grading.** `validateAlipayProof` (`:3465-3520`) applies four hard checks — success screen, amount equals order total, payee matches one of a configured *list* of acceptable names (because one 收钱码 legitimately shows two different names, `:3440-3457`), and payment time inside the window with 10 min clock-skew tolerance. Reuse is defended by hashing the image itself, with the txn-id as a bonus check (`:4900-4910`).
- **The flip.** A clean match may auto-flip only when the operator turned `autoFlip` on; the code states plainly that a screenshot is forgeable and this is an assist layer, never proof (`lib/alipay-ocr.js:9-11`, `routes/retail.js:3458-3459`).
- **Reaper interaction.** The stale-order sweep never cancels an Alipay order that has a proof image attached (`:7293-7295`, `:7302-7308`).
- Admin re-run: `POST /api/retail-admin/orders/:id/alipay-ocr/rerun` (`:25589`), measuring freshness from the original upload rather than "now" (`:3461-3464`).

### 2.4 Which rails are offered, and where that is decided

`routes/retail.js:764-771` sets `cfg.payments` for both storefronts:

- `alipay: !!getAlipayManual() || (currentTenantId() === ROOTS_TENANT_ID && !ALIPAY_DEV_MODE)`
- `wechat: !payContext().devMode` — deliberately off in dev mode, because `/payment/create` auto-marks orders paid without charging (`:766-770`).

Consumed by the web storefront at `public/shop.html:1910-1927` (greyed "Coming soon" for a dead rail) and by the guest page's method list (`routes/retail.js:5128`).

### 2.5 Merchant-scans-customer / 付款码 / micropay — none. Confirmed.

Grep across the repository (excluding `node_modules`) for `micropay`, `auth_code`, `付款码`, `codepay`, `face_pay`, `alipay.trade.pay`, and barcode/scan-pay variants returns **no gateway call of that shape**. Every hit is the opposite direction — the merchant *displaying* a QR and the customer scanning it (`lib/qrpng.js:11`, `miniapp/pages/alipay-pay/alipay-pay.js:6`, `public/shop.html:2904`, `routes/retail.js:4695-4698`, `public/retail-admin/17-setup-guide.js:705`) — or a customer uploading a screenshot.

Corroborating structural evidence: the only WeChat v3 endpoints called anywhere are `/v3/pay/transactions/jsapi`, `/h5`, `/native`, and `/out-trade-no/{no}` (`routes/retail.js:3676`, `:3732`, `:3768`, `:3800`; `lib/billing-providers.js:120`). WeChat's 付款码 product is a **v2** endpoint (`pay/micropay`), and no v2 host, no v2 signing scheme (MD5/HMAC-SHA256 over an XML body), and no XML transport exists in this codebase. Alipay's equivalent, `alipay.trade.pay` with an `auth_code`, is likewise absent — the only Alipay methods called are `precreate`, `wap.pay`, `page.pay` and `query`.

### 2.6 `retail_payments.qr_image_url` — written, selected, never rendered

| | Location |
|---|---|
| Declared | `database.js:1316` — `qr_image_url TEXT, -- alipay precreate result (saved for receipt screens)` |
| Written (1) | `routes/retail.js:4755` — the Alipay precreate branch of `/api/retail/payment/create`; stores the raw `qr_code` **string**, not an image URL and not the PNG |
| Written (2) | `routes/retail.js:5189` — the same, on the guest pay path |
| Selected | `routes/retail.js:21554-21557` — the admin order-detail read returns it inside `o.payments[]` |
| Rendered | **nowhere** — no consumer in `public/retail-admin/`, `public/shop/`, `public/shop.html`, `miniapp/` or `routes/` reads the field |

Note a name collision when grepping: an unrelated `qr_image_url` belongs to the customer-service block config (`public/retail-admin/05-marketing.js:1237`, `miniapp/components/cs-button/cs-button.js:110`, `public/cms.html:14113`) and has nothing to do with payments.

**Status: written on two Alipay paths only, shipped to the admin client inside the order-detail payload, and displayed by no surface.** It is dead for its stated purpose ("receipt screens"). It is not *unreferenced* — changing the column would alter an API response shape, and it is carried in every Postgres schema snapshot (`docs/tacet-postgres-schema-as-built-2026-08-11.sql:4071`).

---

## 3. THE ADAPTER SEAM

### 3.1 How `lib/billing-providers.js` structures its provider interface

186 lines, four providers, one public function pair. The shape:

```js
const PROVIDERS = {
  <id>: {
    id: '<id>',
    label: '<bilingual label>',
    configured: () => <boolean>,
    async createCheckout(invoice, tenant) { … return { kind, …descriptor }; },
  },
};
function listProviders()                        // → [{id, label, configured}]
async function createCheckout(providerId, invoice, tenant)
```

- Interface: exactly **three members** per provider — `label`, `configured()`, `createCheckout()` (`lib/billing-providers.js:80-166`).
- `createCheckout` returns a **descriptor**, not a side effect: `{kind:'manual', reference, instructions_en, instructions_cn}` (`:88-93`) or `{kind:'wechat_native', code_url, qr_data_url, out_trade_no, invoice_id, amount_cents, amount_display}` (`:138-146`).
- Dispatch is a table lookup with two guards — unknown provider, and unconfigured provider (`:173-178`).
- `manual` is always available and always succeeds (`:84`) — the always-present floor.
- Two providers are declared but throw: `alipay_native` (`:150-157`) and `stripe` (`:158-165`). They still report `configured()` honestly, so they render correctly greyed.
- Settlement is **outside** the interface: the deterministic `out_trade_no` (`FCSUB` + zero-padded invoice id, `:63-70`) is what lets the async callback recover the invoice with no extra storage, and the callback lives in the route file (`routes/billing-pay.js:161+`).
- One call site each: `listProviders()` at `routes/billing-pay.js:75` and `:112`; `createCheckout()` at `:127`, which then persists `provider` and `provider_ref` on the invoice (`:128-132`).

**Could a retail-side payment adapter follow the same shape?** Structurally the pattern is a clean fit — a retail rail is also "decide whether it is configured, then produce a descriptor the client renders". Three concrete differences would have to be absorbed rather than assumed away, all evidenced above:

1. **Credentials.** Billing reads `process.env` directly inside each provider (`lib/billing-providers.js:33-35`, `:103-109`) because subscription fees always settle to the platform. Retail resolves per-account credentials on every call through `payContext()` (`routes/retail.js:3542-3545`), so a retail provider would take the resolved context as an argument rather than reading env.
2. **One rail, several modes.** Billing's `wechat_native` is one product. Retail's `wechat` is four (§2.1), chosen from a `channel` hint the client computes from the user agent (`public/shop.html:1899-1902`) — so a retail provider id is not one-to-one with a rail.
3. **Non-gateway tenders exist and outnumber the gateway ones.** `cash`, `bank_transfer`, `points`, `balance`, `store_credit`, `wallet`, `other` all appear in the retail vocabularies below and never produce a checkout descriptor at all.

### 3.2 Every place a retail payment method is chosen or branched on

**A. Vocabularies — six lists, no two identical.** This is the seam's measurable cost:

| # | List | Values | Cite |
|---|---|---|---|
| 1 | New Order page `#onw-pay` | `offline, wechat, alipay, other` (labelled Cash / WeChat Pay / Alipay / Bank transfer) | `public/retail-admin.html:2829-2834` |
| 2 | Manual create `ALLOWED_PAY` | `offline, wechat, alipay, points, balance, other` | `routes/retail.js:20709-20710` |
| 3 | Customer checkout | `wechat, alipay, points` | `routes/retail.js:9454` |
| 4 | Guest pay | `wechat, alipay` | `routes/retail.js:5145-5146` |
| 5 | Admin Mark-paid `OFFLINE_PAY_METHODS` | `cash, bank_transfer, wechat_offline, alipay_offline, other` | `routes/retail.js:25032` |
| 6 | Refund payout `allowedMethods` | `wechat, alipay, bank, wallet, store_credit, cash, other` | `routes/retail.js:25910` |

Also: the column's own comment claims `wechat | alipay | points` (`database.js:1310`); the top-up route allows `wechat, alipay` but implements only WeChat (`routes/retail.js:29142`, `:29197`); the same column is reused for wallet ledger rows that are not payments at all — `admin_adjust`, `referral_reward`, `lifetime_commission`, `order_redeem`, `refund_reverse` (`:16200`, `:16601`, `:16692`, `:28593`, `:28598`) — which the client has to filter out by name (`public/retail-admin/08-customers.js:436`); and the display layer normalises six spellings of "wechat" and three of "alipay" (`public/retail-admin/01-core.js:258-259`).

Note the crossing: `offline` (list 2) and `cash` (list 5) both mean cash. A New Order counter sale is created with `offline` (`04-orders.js:7960-7962`) while the drawer's Mark-paid writes `cash`.

**B. Branch sites — where behaviour actually forks on the method.**

| Site | Cite | Forks on |
|---|---|---|
| `/api/retail/payment/create` — points / zero-total shortcut | `routes/retail.js:4612` | `payment_method === 'points'` or total ≤ 0 |
| — dev-mode fake settle | `:4620-4627` | `payCtx.devMode` |
| — WeChat, then h5 / native / jsapi | `:4630`, `:4639`, `:4658`, `:4676` | `payment_method`, then `channel` |
| — Alipay, then manual / Roots gate / wap+page / precreate | `:4701`, `:4707`, `:4727`, `:4734`, `:4747` | `payment_method`, then config, then `channel` |
| — unsupported fall-through | `:4767` | — |
| Status poll — Alipay query fallback | `:4782` | method + Roots + not dev |
| Status poll — WeChat trade-state fallback | `:4800` | method + not dev |
| Alipay proof upload guard | `:4843` | `payment_method !== 'alipay'` |
| Guest `/api/pay/:token` — which rails are live | `:5128` | manual config, or Roots |
| Guest `/api/pay/:token/create` | `:5139-5195` | `wechat` → Native; `alipay` → manual → Roots precreate |
| Guest status poll | `:5199`, `:5208` | as above |
| WeChat 发货信息 upload | `:6173` | `payment_method !== 'wechat'` → skip |
| Stale-order reaper | `:7293-7308` | Alipay + proof present |
| Customer checkout validation | `:9454` | inclusion list |
| Points-covering-the-whole-order paths | `:10209-10211` | `points`, or points stacked on wechat/alipay |
| Wallet balance top-up sweep | `:13199` | `r.method === 'wechat'` → skip |
| Revenue-by-tender report | `:13184`, `:13190` | `COALESCE(payment_method,'unknown')` grouping |
| Top-up create | `:29142`, `:29174`, `:29197` | allows two, implements one |
| Order add-on | `:29957` | hardcodes `'wechat'` |
| Manual create | `:20709-20710` | inclusion list, silent fallback to `offline` |
| Admin Mark-paid | `:25231-25232`, `:25282-25307` | `OFFLINE_PAY_METHODS` membership; writes or settles the payment row |
| Refund payout | `:25910`, `:25934`, `:25959` | `wechat` + not dev → real gateway refund; everything else → bookkeeping |
| Refund shortcut in the status route | `:25208-25212` | gateway refund across tenders |
| Storefront rail availability | `:764-771` | manual config, Roots, dev-mode |
| Web storefront channel choice | `public/shop.html:1899-1902`, `:1910-1927` | user agent + availability |
| Mini-app post-create handoff | `miniapp/pages/checkout/checkout.js:3043`, `:3081` | `wechat` → `wx.requestPayment`; `alipay` → QR page |
| Mini-app order-page retry | `miniapp/pages/order/order.js:790`, `:797` | same |
| Admin refund-payout default + warning | `public/retail-admin/04-orders.js:7325-7341`, `:7402` | maps stored method → payout method |
| Admin payment-brand badge | `public/retail-admin/01-core.js:256-262` | string normalisation |
| Admin channel label | `public/retail-admin/04-orders.js:250` | — |

**Scope for an adapter, counted: 6 vocabularies; roughly 30 server-side branch sites in `routes/retail.js` alone; 4 client surfaces (`retail-admin`, `shop.html`, mini-app checkout, mini-app order page); and 2 settlement callbacks (`routes/retail.js:5344`/`:5345` WeChat, `:5414` Alipay) which sit entirely outside the create path.** The billing seam covers exactly one of these three concerns — produce a descriptor. The other two, vocabulary and settlement, have no equivalent in `lib/billing-providers.js`, because billing has one gateway provider and a deterministic `out_trade_no` doing the work a vocabulary would otherwise do.

---

## 4. LOCATION AND ACCOUNT

### 4.1 How a payment credential is scoped today — per ACCOUNT

**Storage.** `lib/tenant-creds.js:35-44`:

```sql
CREATE TABLE IF NOT EXISTS tenant_secrets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL,
  key         TEXT NOT NULL,
  value_enc   TEXT NOT NULL,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, key),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
```

It lives in the **shared control-plane database** (`mainDb`, `:25-26`), not the per-account data plane, and values are AES-256-GCM encrypted via `lib/secret-box.js`. `UNIQUE(tenant_id, key)` is the whole scoping story: **one value per account per key. There is no store or location column.**

The WeChat Pay keys: `wechat.pay.mch_id`, `wechat.pay.api_v3_key`, `wechat.pay.private_key`, `wechat.pay.serial_no`, `wechat.pay.platform_pub_key` (`lib/tenant-creds.js:51-55`), plus `wechat.app_secret` (`:50`) and `tenants.wx_appid` (read at `:243`).

**Resolution.** `getTenantCreds(tenantId)` (`:281-288`) — Roots or unscoped returns an **env**-backed bundle (`rootsEnvBundle`, `:199`); every other account returns its own decrypted bundle with **no env fallback** (`dbBundle`, `:238`), so an unconfigured account resolves to `devMode` rather than borrowing Roots' merchant. The reason is stated at `:10-19`: "Falling back to env would be exactly the cross-tenant clobber/leak this foundation exists to prevent."

**Use.** `payContext()` (`routes/retail.js:3542-3545`) returns `{appId, mchId, apiV3Key, privateKey, serialNo, platformPubKey, devMode}` for the *current request's* account, resolved from the tenant ALS scope. Forward paths run inside that scope; the async callbacks instead carry the account id in the URL path, because a gateway→server POST has no session (`:3538-3541`; route `:5345`).

**Alipay is scoped differently, and worse.** The gateway credentials are module-level `process.env` constants read once at load (`routes/retail.js:3386-3391`) — **global, not per account** — which is exactly why the code refuses to use them for anyone but Roots (`:4727-4729`). The per-account Alipay artefact is the manual 收款码, stored in the account's own `storefront_config` under `integrations.alipayManual` (`:3410`, written `:18613-18617`) — **one QR per account, no store column**.

**Summary:**

| Credential | Scope | Storage |
|---|---|---|
| WeChat Pay merchant (mch_id, keys, serial) | **per account** | `tenant_secrets`, `UNIQUE(tenant_id,key)` — `lib/tenant-creds.js:41`, `:51-55` |
| WeChat AppID / AppSecret | **per account** | `tenants.wx_appid` + `tenant_secrets` — `lib/tenant-creds.js:243`, `:50` |
| Alipay gateway (app_id, RSA keys, notify URL) | **global (env); Roots-only in practice** | `process.env` — `routes/retail.js:3386-3391`; gate `:4727` |
| Alipay manual 收款码 + payee list + OCR key | **per account** | `storefront_config` key `integrations.alipayManual` — `routes/retail.js:3410` |
| Feie printer account (user, ukey) | **per account** | `tenant_secrets` — `lib/tenant-creds.js:79-80` |
| Feie printer **assignment** (which SN prints for which store) | **per store** | `storefront_config` key `printer.by_store` — `routes/retail.js:23593` |
| Meituan / Qingyun scraper logins | **per store** (dynamic keys) | `tenant_secrets`, key `<provider>.<store_code>.<user\|pass>` — `lib/tenant-creds.js:118-123` |

The last two rows matter: **the per-location pattern already exists in the same table.** `DYNAMIC_CRED_RE = /^(meituan|qingyun)\.[a-z0-9][a-z0-9_-]*\.(user|pass)$/` (`lib/tenant-creds.js:118`), collected into `{ <store_code>: {user, pass} }` by `collectStoreCreds` (`:126-134`) and surfaced as `integrations.meituan` / `integrations.qingyun.stores` (`:266-271`). Payment keys are simply not members of that family.

Also relevant: `retail_stores` has no payment column at all — its full schema is `code, name_en, name_cn, address, city, district, lat, lng, phone, meituan_account_id, is_active, sort_order, created_at, updated_at` (`database.js:2686-2702`). And `retail_payments` carries no `store_id` — only `order_id` (`database.js:1307-1322`); the store is knowable only by joining through `retail_orders.store_id`.

### 4.2 What breaks if a second location needs its own merchant account

Observations about the code as it stands, not a work plan.

1. **There is nowhere to put the second credential.** `UNIQUE(tenant_id, key)` (`lib/tenant-creds.js:41`) permits exactly one `wechat.pay.mch_id` per account. `isValidCredKey` (`:121`) accepts only `ALL_KEYS` plus the meituan/qingyun dynamic family, so a key like `wechat.pay.tianhe.mch_id` is **rejected at write time** by `setTenantSecret` (`:150`).
2. **The resolver has no store input.** `payContext()` takes no arguments and reads `currentTenantId()` (`routes/retail.js:3543`). Every prepare call is handed its result — JSAPI `:3675`, H5 `:3731`, Native `:3767`, trade-state `:3799`, refund (`payContext()` at `:25934`, `:25959`). None of them receives an order, a store, or anything from which a store could be derived.
3. **The AppID is part of the Pay bundle.** `payContext()` returns `{appId: c.wechat.appId, ...c.pay}` (`:3544`), and the appid is sent on every prepare body (`:3679`, `:3735`, `:3771`). A second merchant under the same mini-program needs the appid and the mch_id bound together in whatever selects them.
4. **The notify URL keys on the account, not the location.** `wechatNotifyUrl()` returns `/api/retail/payment/wechat/callback/${tid}` (`routes/retail.js:3563-3567`), and `resolveCallbackTid` validates only against the tenants table (`:5346`). A callback for a second merchant resolves to the same account context.
5. **The callback finds the order by `out_trade_no` alone.** `routes/retail.js:5090-5093` updates `retail_payments … WHERE out_trade_no = ?`, and `wxOutTradeNo(order_no)` is built from the order number with a fixed prefix. Nothing in the identifier encodes a store, so a settled payment carries no record of which merchant account received the money — it would have to be reconstructed by joining `retail_orders.store_id`.
6. **`devMode` is account-wide.** `pay.devMode = !mchId || !privateKey || !appId` (`lib/tenant-creds.js:264`). It drives the storefront's `payments.wechat` availability flag (`routes/retail.js:770`) and the auto-settle-without-charging shortcut (`:4620-4627`). "One location configured, one not" has no representation: the account is either in devMode or it is not, and devMode marks orders paid without charging.
7. **The refund path assumes one merchant.** `settleOrderRefundAcrossTenders` runs under `payContext()` (`:25959`), and `orderHasRefundableGatewayMoney` checks only that a gateway payment row exists (`:25934`). A refund against an order paid at location B would be signed with whichever credentials the account resolves to.
8. **Alipay has the same problem one level worse.** Its credentials are process-global (`:3386-3391`), so a second *account* already cannot have its own — which is why the code refuses non-Roots outright (`:4727`). A second *location* is a strictly harder case than one the system already declines.
9. **Two things keep working unchanged**, worth naming because they show the per-location pattern is not foreign here: the printer already resolves per store (`printerForOrder` → `printerForStore`, `routes/retail.js:23644-23663`; config `printer.by_store` at `:23593`), and Meituan/Qingyun already hold per-store logins (`lib/tenant-creds.js:118-134`).

---

## 5. Open / unverified

- **Whether §13's "delete it" is still the intent.** The decisions document has been revised many times since 2026-07-31 (`docs/tacet-consolidation-decisions.md:8` is v4.45) without §13's counter line being amended or withdrawn, and without the code changing. The code and the decision have simply coexisted for three weeks. Which one is stale is not decidable from the repository.
- ~~**Whether the counter sale's stock behaviour (§1.5) is intended.**~~ **ANSWERED 2026-08-20: not intended.** Decided and fixed — see §1.5 and §1.5a.
- ~~**`POST /api/retail-admin/order-fees` being unmapped in `lib/cap-routes.js`**~~ **MAPPED 2026-08-20** to `orders:edit` (`lib/cap-routes.js:41-49`), alongside a `data-cap="orders:edit"` on the New Order CTA (§1.8). As reported at the time: a POST that computes a quote and mutates nothing, so the fail-open had no write consequence — but it was the same prefix miss as the drafts route, and it is closed the same way.
- **No live database was queried.** Every statement about behaviour is read from code, not from observed rows.

---

## 6. ADJACENT BUG — ADMIN MARK-PAID NEVER REACHES `delivered`

**Filed 2026-08-20 alongside the counter-sale stock fix. NOT fixed in that change — recorded here so it is not rediscovered.**

> Line numbers in this section are from the working tree **after** the stock fix, not from `f2241022` like the rest of this document. `routes/retail.js` gained ~160 lines in that change, so every `routes/retail.js` pin above §6 is offset from the current tree.

### 6.1 What is wrong

`markOrderPaid()` (`routes/retail.js:4485`) does two things for a counter sale on the pending→paid transition: it flips the order to `delivered` and stamps `delivered_at`, guarded by `isTerminalOnPaid` (`:4541`), and — as of the same-day fix — it decrements stock.

`PATCH /api/retail-admin/orders/:id/status` (`routes/retail.js:25268`) **does not call `markOrderPaid` at all.** It re-implements that function's side effects inline, one by one:

| Side effect | In `markOrderPaid` | Mirrored in the status route |
|---|---|---|
| commit reservations | `:4595` | `:25441` |
| award points | `:4618` | `:25437` |
| referral credit | `:4621` | `:25470` |
| auto-print | `:4665` | `:25476` |
| WeCom merchant alert | `:4660` | `:25483` |
| operator push | `:4630-4652` | `:25484-25493` |
| counter stock decrement | `:4561` | `:25459-25469` (added by the stock fix) |
| **flip a counter sale to `delivered`** | **`:4541-4548`** | **absent** |

`isTerminalOnPaid` is imported once (`routes/retail.js:40`) and, before the stock fix, was called in exactly one place — inside `markOrderPaid`. The status route never consulted it.

**So a counter sale marked paid from the order drawer sits at `paid` and stays there.**

### 6.2 Why it does not self-correct

`STATUS_TRANSITIONS` (`routes/retail.js:25141-25154`) declares `delivered: { col: 'delivered_at', prev: ['dispatched'] }` (`:25149`). From `paid`, `delivered` is not a legal next state. The operator's only route to it is `paid → dispatched → delivered` (`:25148`, `:25149`), i.e. marking a walk-in **dispatched** — a state that means a parcel left on a courier, for goods the customer carried out of the shop themselves.

So the order is not one click from correct. It is either stuck, or corrected by asserting something untrue.

### 6.3 What it costs

- `paid` in this system means *money in, work outstanding* — it feeds the Paid chip and `oldest_unfulfilled`. `lib/fulfilment.js:55-64` states that this is never true of a walk-in for any length of time; the whole reason the flip exists is that a counter sale is born fulfilled.
- The operator-facing label ladder never fires: `humanStatus` re-words `delivered` to "Completed · 已完成" for a counter sale (`public/retail-admin/04-orders.js:2636-2638`), and a stuck order reads "Paid" instead.
- `delivered_at` is never stamped, so the sale has no completion timestamp.
- Revenue reporting is unaffected — `paid` and `delivered` are both in the reporting predicate (§1.6) — so this is a worklist and labelling defect, not a money one.

### 6.4 Scope note — this is not the stock bug

The stock decrement added on 2026-08-20 is keyed on *the sale being paid*, not on the status it lands in, so it is correct on both routes and does not depend on this being fixed (`routes/retail.js:25459-25468` carries that note inline). The two are independent: fixing this one changes a status and a label, and moves no stock.

### 6.5 Not fixed here, deliberately

A fix has to decide whether the status route calls `isTerminalOnPaid` itself (a third inline mirror of `markOrderPaid`, on a route that already carries seven) or whether the two paths are collapsed onto one function — which is the larger and better change, and is not a stock fix. Recorded rather than guessed at.

---

## 7. THE ONE-QR PAY LINK — WHAT EXISTS AND WHAT IS MISSING

**Surveyed 2026-08-20 against `origin/main` = `a608fd2e`. Read-only; no code was changed. Line numbers are from that head — `routes/retail.js` is unchanged by the three commits since `3c4fc204`, but it did move under the stock fix, so pins here differ from §1–§5 and agree with §6.**

> **The question.** The counter design assumes one QR holding a plain `https` link to `/pay/:token`, scannable by both WeChat and Alipay, each of which then invokes its own in-app payment. This section establishes, with citations, whether that works today.

### 7.0 The short answer

**No, and the reason is not a bug — it is that the QR does not exist.** Nothing anywhere in the repository QR-encodes the `/pay/:token` link. The five QR images the product generates all encode a **gateway string**, never a link to our own page (§7.3). The pay page itself has **no user-agent detection**, **no JSAPI branch**, **no H5 branch**, and can render exactly one kind of payment artifact — an image (§7.1). A customer who scanned an https QR with WeChat and landed on that page would be shown a **WeChat Pay Native QR inside WeChat**, which is a QR asking to be scanned by the app already displaying it.

### 7.1 The pay page

**What `/pay/:token` serves.** One route, one constant: `router.get('/pay/:token')` (`routes/retail.js:5443`) sends `GUEST_PAY_PAGE` (`:5331`) — a self-contained HTML string, no app bundle. It is served for **any** token; a bad or spent token surfaces in-page rather than as a 404 (`:5329-5330`). The page reads its token from the URL (`:5367`) and drives three JSON endpoints: `/api/pay/:token` (`:5226`), `/api/pay/:token/create` (`:5244`), `/api/pay/:token/status` (`:5301`).

**Does it detect which app opened it? No.** The page's script contains no `navigator.userAgent` read of any kind — no `MicroMessenger` test, no `AlipayClient` test, no device sniff. It renders up to two buttons from a server flag and nothing else (`:5382-5385`). The POST it sends carries **only** `{ method }` (`:5418`) — there is no `channel` field, so the server could not act on a detection even if the page made one.

**This is a capability the product has and this page does not use.** `public/shop.html:1899-1902` does exactly the detection in question — `payEnv()` reads the UA, `wxChannel()` returns `'jsapi' | 'h5' | 'native'`, `aliChannel()` returns `'wap' | 'page'` — and posts that channel to `/api/retail/payment/create`. The guest pay page predates none of it and uses none of it.

**Confirmed: the WeChat branch is ALWAYS Native.** `routes/retail.js:5260-5273`. There is no `channel` read and no conditional: the branch calls `wechatNativePrepare` (`:5264`, function at `:3845`) unconditionally, renders the returned `code_url` to a PNG (`:5270`), and returns `mode: 'native'` (`:5272`). The endpoint's own header comment states the design intent (`:5241-5243`):

> Mirrors `/api/retail/payment/create`'s Native-QR (WeChat) and precreate/manual (Alipay) branches — **the only ones a guest (no openid, no in-WeChat context) can use.**

**Is there a JSAPI branch on this path? There is not.** `wechatJsapiPrepare` exists (`:3753`) and is called from three places — the in-app order checkout (via `wechatPayCreate`, `:3787`, called `:4789`), the wallet top-up (`:29335`) and the order add-on (`:30131`) — **none of them the guest path**. `wechatH5Prepare` exists (`:3809`) and is called from exactly one place, `/api/retail/payment/create` when `channel === 'h5'` (`:4744`, call at `:4746`) — again not the guest path.

**What happens when the page is opened inside WeChat's browser.** Everything above still runs, unchanged, because nothing detects the context. The chain is:

1. The customer's WeChat scanner opens the `https` URL in WeChat's built-in browser.
2. The page renders "Pay with WeChat · 微信支付" (`:5383`).
3. The tap POSTs `{method:'wechat'}`; the server returns a Native `code_url` as `qr_png` (`:5270-5272`).
4. The page takes the **only** success path it has — `if (d.qr_png)` (`:5423`) — and paints the QR as an `<img>` with the caption *"Scan with WeChat · 微信 to pay"* (`:5425-5429`).

So the terminal state is a `weixin://wxpay/bizpayurl` QR displayed inside the app that would have to scan it. **The page has no other branch to fall to**: a server response carrying `h5_url` or `pay_url` instead of `qr_png` would land in the else at `:5432-5433` and render *"Payment could not be prepared. Please ask the staff."* The page cannot follow a redirect-style payment even if the server offered one.

> **UNVERIFIED, and deliberately left so.** Whether WeChat's in-app browser will *long-press-recognise* (长按识别) a `weixin://` payment QR is client behaviour I cannot establish from this repository, and it is not the flow the code was written for either way. What is established from the code is narrower and sufficient: there is no branch, no detection, and one possible artifact.

**Is there a WeChat OAuth flow reachable from this page? No — and there is no in-browser OAuth flow anywhere in the product.** A grep for `oauth2/authorize`, `snsapi_base`, `snsapi_userinfo`, `sns/oauth2`, `jscode2session`, `code2Session` and `connect/oauth2` across the repository returns **three** hits, and none of them can serve this page:

| Hit | What it is | Why it cannot mint an openid here |
|---|---|---|
| `routes/retail.js:2953` | `sns/jscode2session` inside `exchangeCodeForOpenid` | **Mini-program login.** Consumes a `wx.login` code, which only a mini-program can produce. Reached by `POST /api/retail/auth` (`:2974`), which the pay page never calls. |
| `lib/social-auth.js:89-95` | `authorizeUrl('wechat')` | Builds **`open.weixin.qq.com/connect/qrconnect`** with **`scope: 'snsapi_login'`** — Open Platform *desktop scan-to-log-in*, not the in-WeChat `connect/oauth2/authorize` + `snsapi_base` flow. It is a customer **account** sign-in, reached at `routes/retail.js:3312` (`/api/retail/auth/oauth/:provider/start`). |
| `lib/social-auth.js:151` | `sns/oauth2/access_token` | The token exchange for the row above. Same flow, same limitation. |

The pay page's script makes exactly three network calls (`:5406`, `:5418`, `:5438`), all to `/api/pay/*`. It never touches an auth route.

**Two further absences that bear on JSAPI specifically:**

- **No JS-SDK anywhere.** A grep for `WeixinJSBridge`, `chooseWXPay`, `jsapi_ticket`, `wx.config(` and `js_api_list` across `routes/`, `public/`, `lib/` and `miniapp/` returns **nothing**. The in-browser payment invocation has no code at all.
- **There is one appid field, and it is the mini-program's.** `tenants.wx_appid` (`routes/saas-admin.js:26`) is read into the pay context at `lib/tenant-creds.js:246-247` and is the value matched against the `x-wx-appid` header a mini-program sends (`routes/retail.js:92`). No official-account (服务号) appid is stored anywhere. `buildWxRequestPaymentParams` (`:3721`) signs a `wx.requestPayment` parameter set with that appid — the mini-program shape, not the JS-SDK `chooseWXPay` shape.

### 7.2 The Alipay side

**Can `/pay/:token` invoke the real Alipay wap gateway? No — that branch does not exist on this path.** The guest endpoint's Alipay half is `routes/retail.js:5276-5296` and has exactly two outcomes, in this order:

1. **Manual 收款码 first**, whenever the account has one configured (`:5277-5285`, config read at `getAlipayManual`, `:3486`). Returns `mode: 'manual'` with the operator's uploaded static QR image (read at `:5278`, returned at `:5281`) and an optional pay window. Settlement is a customer-uploaded screenshot graded by a Haiku vision call, then a human — the machinery surveyed at §2.3.
2. **Otherwise Roots-only 当面付 precreate** (`:5290`, `alipayPrecreate` at `:3988`), which returns a `qr_code` string rendered to a PNG (`:5293`).

`alipayPageRedirectUrl` — the function that builds the signed `alipay.trade.wap.pay` / `alipay.trade.page.pay` redirect (`:4007`) — is called from **one** place in the repository: `/api/retail/payment/create` at `:4839`, gated on `channel === 'wap' || channel === 'page'`. The guest path never calls it, and the guest page never sends a channel. So on `/pay/:token` **the wap gateway is unreachable, for every account including Roots.**

**Where Alipay credentials are read from.** Module-level `process.env` constants, resolved once at file load: `ALIPAY_APP_ID` (`:3464`), `ALIPAY_GATEWAY` (`:3465`), `ALIPAY_NOTIFY_URL` (`:3466`), `ALIPAY_PRIVATE_KEY` (`:3467`), `ALIPAY_PUBLIC_KEY` (`:3468`), and the derived `ALIPAY_DEV_MODE = !ALIPAY_APP_ID || !ALIPAY_PRIVATE_KEY` (`:3469`). **These are global — there is no per-account Alipay credential anywhere.** Contrast WeChat Pay, which resolves per account on every call through `payContext()` → `getTenantCreds()` (§4.1).

**What the refusal does for a non-Roots account.** The gate now sits at `routes/retail.js:4832` (it was `:4727` in §2.2, before the stock fix moved it):

```js
if (currentTenantId() !== ROOTS_TENANT_ID || ALIPAY_DEV_MODE) {
  return res.status(501).json({ success: false, error: 'alipay_not_configured' });
}
```

It returns **HTTP 501 `alipay_not_configured`** and stops. The comment above it (`:4827-4831`) records why: the constants are Roots' env, so a tenant's Alipay charge would settle to **Roots' merchant** — "a money leak". The identical gate is repeated on the guest path at `:5286`.

**Its practical effect is narrower than it looks, because of ordering.** On both paths the manual 收款码 is checked *first* (`:4812` / `:5278`). So a non-Roots account with a 收款码 configured never reaches the refusal — it gets the static-QR-plus-screenshot flow. The 501 fires only for a non-Roots account with **no** 收款码, and for Roots itself whenever the env vars are unset. Availability is advertised to the client accordingly: `/api/pay/:token` reports `alipay: !!getAlipayManual() || (currentTenantId() === ROOTS_TENANT_ID && !ALIPAY_DEV_MODE)` (`:5233`), so an account with neither simply never sees an Alipay button (`:5384`).

### 7.3 What the QR actually contains today — the central finding

**There is no QR of the pay link. Anywhere.**

`lib/qrpng.js` is the only QR encoder in the product, and it is server-side (`qrPngDataUrl`, `lib/qrpng.js:323`). A grep for its call sites returns **five**, and every single input is a **gateway string**:

| # | Call site | String encoded | What that string is |
|---|---|---|---|
| 1 | `routes/retail.js:4771` | `codeUrl` | WeChat Native — `weixin://wxpay/bizpayurl?pr=…` |
| 2 | `routes/retail.js:4857` | `qrCode` | Alipay `trade.precreate` `qr_code` |
| 3 | `routes/retail.js:5270` | `codeUrl` | WeChat Native — **guest pay page** |
| 4 | `routes/retail.js:5293` | `qrCode` | Alipay precreate — **guest pay page** |
| 5 | `lib/billing-providers.js:137` | `j.code_url` | WeChat Native, subscription invoices |

A sixth QR reaches customers without being generated at all: the **manual Alipay 收款码**, an operator-uploaded image served straight through as `manual.qr` (`:5281`). Its contents are whatever Alipay put in the merchant's own static collection code.

**There is no client-side QR encoder either.** A grep across `public/` and `miniapp/` for `qrcode`, `qrious`, `easyqrcode` and QR `toDataURL` patterns returns nothing.

**What happens to the `/pay/:token` URL instead.** It is built once, server-side, and returned as a **string**:

- Minted at order create: `payToken = crypto.randomBytes(18).toString('hex')` (`:20912`) — 36 hex characters, validated on read by `/^[a-f0-9]{16,64}$/i` (`:5219`).
- Assembled into `pay_url` on the create response, on the request's own origin so it is tenant-correct (`:21070`).
- Rendered by the admin as a **copyable link and an anchor — not a QR** (`public/retail-admin/04-orders.js:5063-5072`). Its own sub-caption is the tell: *"Send this to the customer, or show the page for them to scan."* That is an instruction to **open the page** so the customer can scan the QR the page then generates — not to scan the link.

**So the honest description of today's flow is:** the operator sends or opens an https link; the customer's browser loads our page; the customer taps a rail; the **server** mints a gateway QR; the customer scans **that** with a second device or a second app. The one-QR premise inverts this — it asks the QR to be the entry point rather than the exit.

**One thing that would not need changing.** `publicTenantScope` is mounted on `/pay` and `/api/pay` (`server.js:379-380`) and resolves the account from the **Host** header when no appid header is present (`middleware/public-tenant.js:49-54`). A scanned https link carries no appid, so host resolution is exactly the right mechanism and already works. And capacity is not a constraint: `lib/qrpng.js` covers versions 1–6, "~106 bytes of payload" (`lib/qrpng.js:3-6`), against a link of roughly 70 characters (`https://<host>/pay/` + 36 hex).

### 7.4 The gap, in three buckets

**EXISTS AND WORKS — reusable as-is**

- `GET /pay/:token` serving a public, un-authed, self-contained page (`:5443`, `:5331`); the unguessable token is the capability (`:5211-5215`).
- Account resolution by Host for a scanned link (`server.js:379-380`; `middleware/public-tenant.js:49-54`).
- A QR encoder with ample capacity for the link (`lib/qrpng.js:3-6`, `:323`).
- Settlement, for every mode: one async WeChat callback keyed on `out_trade_no` (`:5449` for Roots, `…/callback/:tid` at `:5450` per-account) plus a trade-state poll fallback (`:5301-5320`). **Any** new WeChat mode would settle through the machinery already there — the code comment at `:3803-3804` states this explicitly.
- Per-account WeChat Pay credentials, already threaded (`payContext()` `:3620`).
- The device-detection logic itself, already written and working — on a different page (`public/shop.html:1899-1902`).

**EXISTS BUT IN THE WRONG MODE**

- **WeChat on the guest path is hard-wired to Native** (`:5260-5273`). `wechatH5Prepare` (`:3809`) and `wechatJsapiPrepare` (`:3753`) are both built, tested by use elsewhere, and simply not reachable from `/pay/:token`.
- **The guest page cannot render anything but an image.** Its single success branch is `if (d.qr_png)` (`:5423`); an `h5_url` or a redirect `pay_url` falls to the failure copy (`:5432-5433`).
- **The guest POST carries no channel** (`:5418`), so the server has nothing to branch on.
- **Alipay wap/page exists but is unreachable here** — built at `:4007`, called only at `:4839` on the in-app endpoint, and sitting *below* the Roots-only gate (`:4832`) even there.
- **The admin surfaces the pay link as text, not as a QR** (`04-orders.js:5063-5072`).

**DOES NOT EXIST**

- **Any QR containing an https link to our own page** — the five encoder call sites all take gateway strings (§7.3).
- **Any user-agent / in-app detection on the pay page** — no UA read at all.
- **A WeChat in-browser OAuth flow.** No `connect/oauth2/authorize`, no `snsapi_base`, anywhere. The only WeChat web OAuth is `qrconnect` + `snsapi_login` (`lib/social-auth.js:89-95`), a desktop scan-to-log-in for account sign-in, which yields an Open-Platform-scoped openid — not one usable for a JSAPI charge on the payment merchant's bound appid.
- **Any JS-SDK integration** — no `WeixinJSBridge`, no `chooseWXPay`, no `wx.config`, no `jsapi_ticket`, product-wide.
- **An official-account (服务号) appid.** One appid field exists (`tenants.wx_appid`, `saas-admin.js:26`) and it is the mini-program's, used for mini-app routing (`retail.js:92`) and signed into `wx.requestPayment` params (`:3721`).
- **Per-account Alipay gateway credentials.** Global env only (`:3464-3469`); the refusal at `:4832` exists precisely because of that.
- **Any Alipay in-app detection or invocation** on the pay page.

### 7.5 Open / unverified

- **Whether Alipay's scanner opens arbitrary https URLs in its in-app browser**, and whether WeChat's does so for a link it did not itself generate, are **client behaviours no file in this repository establishes.** The one-QR premise depends on both. Nothing here confirms or refutes them.
- **Whether WeChat long-press-recognises a `weixin://` payment QR shown inside its own browser** — same class, same status (§7.1).
- **No live database was queried and no payment was attempted.** Every statement above is read from code.
