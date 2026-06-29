# Eleme (饿了么) channel integration

A third sales channel, structurally parallel to Meituan, but driven by Eleme's
**genuine OAuth2 + JSON-RPC open API** (`open-api.shop.ele.me`) — so there is **no
headless browser, proxy, cookie session, or 验证中心 risk-control** to nurse. It is
on/off per tenant via the admin toggle, exactly like the Meituan block.

Built 2026-06-28. **Not deployed** — needs an Eleme open-platform app (AppKey/Secret)
+ per-store OAuth authorization before it can talk to Eleme. All code is
credential-driven and inert until those exist.

## What was built (all new files unless noted)

| Layer | File |
|---|---|
| API client (dependency-free) | `lib/eleme-client.js` |
| Stock-push queue writer | `lib/eleme-sync.js` |
| Channel fan-out hook | `lib/inventory.js` (added `enqueueElemeSync`) |
| Sync daemon (pm2) | `scripts/eleme-daemon.js` |
| Daemon internal API | `routes/eleme-internal.js` |
| Admin + OAuth API | `routes/eleme-admin.js` |
| Route mounts | `server.js` (2 lines) |
| DB schema | `database.js` (`eleme_tokens`, `eleme_shops`, `eleme_product_map`, `eleme_sync_queue`, `eleme_order_import`, `eleme_sync_log`) |
| Admin tab UI | `public/retail-admin/14-eleme.js` + `public/retail-admin.html` (nav button + `#tab-eleme` section + script tag) |
| SW cache bump | `public/sw.js` (`v215-eleme-channel`) |

## How it works

- **Stock push** — any change to a product's `physical_qty` calls
  `inventory.enqueueChannelSync` → `eleme-sync` enqueues a row in `eleme_sync_queue`
  (gated on `eleme.enabled` + a per-product map row with `sync_enabled=1`). The
  daemon drains the queue: resolve the Eleme item by **货号 / extendCode** (the
  product's SKU, or a per-store override) → `eleme.product.item.batchUpdateStock`.
- **Order import** — every ~5 min the daemon pulls each shop's day orders
  (`eleme.order.getAllOrders` → `getCommodities`), POSTs them to the localhost
  internal route, which creates a `retail_orders` row (`channel='eleme'`) and
  deducts stock via the ledgered adjuster (idempotent via `eleme_order_import`).
- **Auth** — OAuth2 per store. The admin "Connect Eleme" button opens Eleme's
  authorize page; the callback (`/eleme/oauth/callback`, public, protected by an
  HMAC-signed `state`) exchanges the code for tokens stored in `eleme_tokens`. The
  daemon refreshes access tokens proactively and pages ops (WeCom) if a store's
  authorization expires.

## Go-live checklist

1. **Register an Eleme open-platform app** at `open.shop.ele.me` (服务商/开放平台).
   Obtain the **AppKey** and **AppSecret**. Set the app's authorized **redirect URI**
   to `https://<admin-host>/eleme/oauth/callback`. (Sandbox app available for testing
   against `open-api-sandbox.shop.ele.me`.)
2. **Env on the box** (`.env`, then `pm2 restart roots-v2 --update-env` — but watch the
   `PORT` footgun: keep `PORT=4000` set):
   ```
   ELEME_APP_KEY=...
   ELEME_APP_SECRET=...
   ELEME_REDIRECT_URI=https://<admin-host>/eleme/oauth/callback
   ELEME_SANDBOX=1        # 1 while testing, remove/0 for production
   ELEME_INTERNAL_SECRET=<random>   # must match between server + daemon
   # ELEME_SKIP_STORES=<codes handled by another channel>  (optional)
   ```
3. **Deploy the code** — commit the staged files to `main` (auto-deploys via scp+pm2).
   No new npm dependency (the client is vendored), so nothing to `npm install`.
4. **Start the daemon**: `pm2 start scripts/eleme-daemon.js --name eleme-sync && pm2 save`.
5. **In the admin → Eleme tab**: click **Connect Eleme** for each store, authorize on
   Eleme, then confirm the shop id is set (auto-discovered, or paste it). Map products
   (most auto-map by SKU — just tick "sync"). Flip the channel **On**.
6. **Verify** with `ELEME_SANDBOX=1` first: push a test stock change, confirm it lands
   on the Eleme item; place a sandbox order, confirm it imports + deducts.

## Caveats to verify against the live/sandbox API

The exact JSON shapes of `order.getAllOrders` / `getCommodities` and `product` item
specs vary by Eleme API version. The daemon parses defensively (probes common field
names — see `parseOrderItems` and `pushOne`), but **field mapping should be confirmed
once during the sandbox pass** and tightened if needed. Wire protocol (OAuth + signed
JSON-RPC) is verified against `eleme-openapi-sdk@1.21.1`.
