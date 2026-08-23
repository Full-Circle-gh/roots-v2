# Eleme browser-automation recon (Napos merchant backend)

**Why:** Eleme's official OpenAPI is closed to us — the shop accounts are **single-store
accounts (`user_type=shop_single`, `is_chain_operator=0`)**, and the open platform
(`open.shop.ele.me` / `open-retail.ele.me`) rejects them with *"暂不支持该账户登录"*.
Onboarding requires a **chain account (连锁账号)** for `melody.shop.ele.me` + the brand
being under CKA/KA/TN — which Eleme will not provision for us. So we mirror the **Meituan
mechanism**: a Playwright session against the merchant backend, scraping orders and pushing
stock. This file is the reverse-engineered contract. Captured 2026-08-23 via the live
backend (browser network capture), shop **1304930646** (GO VEGAN 哈素萌).

## Backend topology

- Merchant shell: `https://melody.shop.ele.me/app/shop/<shopId>/...` (SPA, hash routes).
- Real UIs are **cross-origin FaaS micro-frontends** embedded as iframes:
  - Goods/stock: `https://napos-goods-pc.faas.ele.me/single/goods-manage`
  - Orders:      `https://napos-order-pc.faas.ele.me/app/processing/all`
  - Both run **standalone in a top-level tab** if the `.ele.me` session cookies are present
    (this is how recon captured payloads — inject a fetch/XHR hook, drive the UI).
- All data calls go through one gateway host: **`app-api.shop.ele.me`**.

## RPC envelope (shared shape, "ncp" protocol)

```jsonc
POST https://app-api.shop.ele.me/<path>/?method=<Service>.<method>
{
  "id": "<clientToken>|<epochMs>",
  "service": "<Service>",
  "method": "<method>",
  "params": { "request": { ... } },
  "metas": { "appName":"melody", "appVersion":"4.4.0",
             "ksid":"<SESSION KEY — the auth credential>", "shopId": 1304930646 },
  "ncp": "2.0.0", "adapter": "ncp"
}
```
- **Auth = `ksid` in `metas` + shared `.ele.me` cookies.** `ksid` is the thing to persist
  (Meituan-style session save). Success response: `{"result":..., "error":null}`.
  Business errors come back in `error` (envelope stays HTTP 200).

## STOCK  (service `FoodService2`, path `nevermore.goods/invoke`)

- **Category/group list:** `FoodService2.getFoodTabWithType`, `FoodService2.queryCategoryWithFoodFilter`
- **List foods in a group (READ, incl. current stock):**
  `FoodService2.queryFoodsByGroupGlobalId`
  - req: `{ shopId:"1304930646", groupGlobalId:"...", withPackageUpgradeTag:true }`
  - resp: `result.foods[]` each `{ itemGlobalId, vfoodId, restaurantId, groupGlobalId,
    name, ... }` + sku/spec + stock (deeper in object).
- **WRITE stock — `FoodService2.updateFoodStock`** (full payload captured, verified 200 `error:null`):
  ```jsonc
  params.request = {
    "shopId": 1304930646,
    "itemGlobalId": "300000904605684808",
    "foodSkuStocks": [{
      "id": 2000001755014880, "foodId": 2000001755014880,
      "skuGlobalId": "300001797770313800", "specGlobalId": "300001797770313800",
      "price": 92, "stock": <NEW QTY>, "maxStock": 10000,
      "stockStatus": 0, "stockType": 0, "packageFee": 0, "packageShare": 1,
      "extCode": "",           // merchant SKU/货号 — EMPTY on our items (see footgun)
      "name":"", "pid":"", "canEditPrice":true
    }]
  }
  ```
  - "改为无限库存" = unlimited stock toggle (separate `stockType`/status).

### ⚠️ Footgun: `extCode` is empty on our Eleme items
Unlike Meituan (which matched by `extendCode`/货号), our Eleme products have **no `extCode`**.
So inventory→Eleme matching must be by **name** initially, OR a one-time pass to push our
货号 into each item's `extCode`, then match on it. Decide during build.

## ORDERS  (path `app-api.shop.ele.me/fulfill/weborder/<m>/?method=OrderWebService.<m>`)

Method names captured (payloads NOT yet captured — no live order during recon):
- **List in-process:** `OrderWebService.queryInProcessOrders`
- **Tab head counts:** `OrderWebService.queryHeadDataByInProcessQueryType`
- **New-order poll (drives import):** `PollingService.unprocessedOrders`
  (+ `PollingService.abnormalOrders`, `PollingService.nonCoreOrders`, `getPollingStrategy`)
- Support: `ShopQueryService.queryDataByTab`, `queryExceptionInfo`,
  `ShopSettingService.getOrderSetting`, `OrderSettingService.checkSettingStatus`
- **Still TODO (capture on a live order):** accept-order method, order-detail/commodities
  method, and the **history query** (订单查询 page) method. Capture the same way:
  open `napos-order-pc.faas.ele.me` standalone, inject the fetch/XHR hook, act, read `__cap`.

## Build plan (mirror Meituan)

1. `lib/eleme-browser.js` = twin of `lib/meituan-browser.js`: Playwright init + fingerprint,
   session persist (cookies + `ksid`), `ensureLoggedIn`/`interactiveLogin` (QR),
   risk-control detection, `listFoods`/`updateStock`(→`updateFoodStock`),
   `getPendingOrders`(→`queryInProcessOrders`/polling), `acceptOrder`.
2. Rewire `scripts/eleme-daemon.js` to use the browser (NOT the OpenAPI `eleme-client.js`).
   Reuse existing DB tables (`eleme_sync_queue`, `eleme_order_import`, `eleme_product_map`,
   `eleme_sync_log`); repurpose `eleme_tokens` to hold the browser session/`ksid`.
3. Keep `inventory.enqueueChannelSync` fan-out + the admin tab (`14-eleme.js`).
4. The OpenAPI files (`lib/eleme-client.js`, OAuth bits of `eleme-admin.js`) become dead —
   remove or leave inert.
5. Anti-detection / proxy: Eleme has Alibaba risk-control (isaac.ele.me, ynuf.aliapp.org
   um.json seen at login). Plan for the same residential-proxy + fingerprint treatment as
   Meituan Tianhe. One session per shop.

## Context values (shop 1304930646)
`user_id`/`keeper_id`=5346737700, `user_type=shop_single`, `keeperTypeV2=SHOP`,
`shop_biz_type=WM`, `alsc_pid=N7a6We`, goods pid `napos_goods_pc_faas_ele_me`.

## CONFIRMED LIVE 2026-08-23 (round 2) — corrections to the above

`lib/eleme-browser.js` was built against this doc, then tested against the real
tianhe (1304930646) session. Several guesses above turned out wrong; corrected
here so nobody re-guesses them.

- **`id` (requestId) IS validated server-side.** A made-up short token gets
  `ILLEGAL_REQUEST` / "requestId is invalid". Reusing the same `id` across two
  calls gets an internal `SERVER_ERROR` (looks like an idempotency/dedup check).
  Real shape, confirmed from live traffic: a FRESH random 32-char uppercase-hex
  token per call (a UUIDv4 with dashes stripped + uppercased) + `"|"` + epoch-ms,
  e.g. `"2A502FFC080D4D30836854791E205974|1787461712272"`. Generate one per RPC
  call — never reuse.
- **`FoodService2.getFoodTabWithType` is NOT the group/category list.** It
  returns the filter TABS (全部/已下架/已售罄/搭售/促销活动/单点不送/套餐) with
  counts, not `groupGlobalId`s. Its real request: `{ shopId: <number>,
  filterTypeList: ["ALL","OFF_SALE","NONE_STOCK","BUNDLE_ITEM","ACTIVITY",
  "DELIVER_ALONE","PACKAGE"] }`. Not needed for stock sync.
- **`FoodService2.queryCategoryWithFoodFilter` IS the group/category list** —
  the real request needs `{ shopId: <number>, foodQueryFilter: "ALL",
  withFoods: true, withPackageUpgradeTag: true }` (the guessed `{shopId}`-only
  shape 500'd). Response is a flat array of categories, each with
  `groupGlobalId`, `categoryId`, `name`, `foodCount`, and — with `withFoods:
  true` — `foodList`: an array of food objects for at least the first/open
  category, `null` for the rest (the merchant UI evidently lazy-loads the
  others as you scroll). shopId is a bare **NUMBER** here (contrast
  `queryFoodsByGroupGlobalId` below, where it's a string).
- **The food object's sku array is called `specs`**, not "sku"/"skus". Each
  spec: `{ id, specGlobalId, pid, name, price, canEditPrice, stock, maxStock,
  stockStatus, stockType, packageFee, packageShare, extCode, foodId, ... }`.
  **There is no `skuGlobalId` field on the read side at all** — only
  `specGlobalId`. The captured `updateFoodStock` write payload (above) has both
  `skuGlobalId` and `specGlobalId` set to the SAME value, so the write path
  must default `skuGlobalId` from `specGlobalId` — sending `skuGlobalId:
  undefined` silently breaks the write.
- **Any category whose `foodList` came back `null`** still needs its own
  `FoodService2.queryFoodsByGroupGlobalId` call — that request shape (shopId as
  a STRING) from the original capture above held up unchanged.
- **End-to-end verified live** (tianhe, 2026-08-23): login → ksid capture →
  full catalogue load (204 items / 23 groups, correct names + stock) →
  `updateFoodStock` no-op write (pushed a product's own current stock back) →
  `{"error":null}`. The whole stock-push pipeline in `lib/eleme-browser.js`
  works against the real backend, not just in theory.
