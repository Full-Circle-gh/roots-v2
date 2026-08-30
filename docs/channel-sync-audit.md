# Channel Sync Audit — Meituan, Eleme, Gzgrocery

**Status: survey only.** This document records what the code does today. It
proposes nothing, fixes nothing, and recommends no target architecture.

**Method.** Read of the working tree at branch `claude/channel-sync-audit-1x7kir`
(HEAD `6cc03f6`). Every claim below is anchored to a file path and, where the
detail matters, to a line number or a verbatim quote. Where the code could not
answer a question, it is listed at the end under *Open questions* rather than
guessed at.

**A note on the word "channel".** The three things being compared are not the
same kind of object in the code, and that is itself a finding:

| Name in the brief | What it actually is in the code |
|---|---|
| **Meituan** | Two independent daemons against two different Meituan products — 外卖 (`e.waimai.meituan.com`, store `tianhe`) and 闪购 (`shangoue.meituan.com`, store `yuexiu`) — sharing one set of DB tables and one admin tab. |
| **Eleme** | One daemon against the Napos merchant backend. A second, complete, unused OAuth client also exists in the tree. |
| **Gzgrocery** | Not one integration but **two and a half**: outbound stock via the **Guanyi ERP** (管易) browser driver, inbound orders via a **pure-HTTP scrape of gzgrocery's own OpenCart admin**, plus a legacy **stock-drift pickup inference** that is the fallback for the order reader. There is also a one-off spreadsheet import path. |

Adjacent-but-out-of-scope: **Qingyun** (青云聚信, `saas.cyanclouds.com`) is a
delivery *aggregator*, not a sales channel — it writes `delivery_jobs`, not
orders or stock. It is mentioned only where it shares machinery.

---

## File inventory

### Meituan

| Layer | Path |
|---|---|
| 外卖 daemon | `scripts/meituan-daemon.js` (1543 lines) |
| 闪购 daemon | `scripts/shangou-daemon.js` (~1000 lines) |
| 外卖 browser driver | `lib/meituan-browser.js` (~1930 lines) |
| 闪购 browser driver | `lib/shangou-browser.js` |
| 闪购 Chrome holder | `scripts/shangou-chrome.js` |
| Queue writer | `lib/meituan-bundles.js` (`enqueueProductStock`) |
| Stock-drift backstop | `lib/meituan-drift-sweep.js` |
| Queue-stall canary | `lib/meituan-queue-stall.js` |
| Order field extractor | `lib/meituan-order-fields.js` |
| Map writer | `lib/meituan-map-write.js` |
| Admin API | `routes/meituan-admin.js` (1219 lines) |
| Daemon→server internal API | `routes/meituan-internal.js` (914 lines) |
| Admin UI | `public/retail-admin/11-meituan.js` (2141 lines) |
| Interactive login | `scripts/meituan-login.js` |
| Settlement-file import (separate, historical) | `scripts/import_meituan.js`, `scripts/convert_meituan_xlsx.py`, `scripts/meituan_*.json` |
| Probes / one-offs (~30 files) | `scripts/meituan-probe*.js`, `meituan-test-*.js`, `meituan-status-recon*.js`, `meituan-dump-*.js`, `shangou-*.js` |
| Findings | `docs/meituan-findings.md` (121 KB), `docs/meituan-queue-survey.md` |

### Eleme

| Layer | Path |
|---|---|
| Daemon | `scripts/eleme-daemon.js` (~1100 lines) |
| Browser driver | `lib/eleme-browser.js` (~1750 lines) |
| Queue writer | `lib/eleme-sync.js` |
| **Unused OAuth client** | `lib/eleme-client.js` |
| Admin API (incl. live OAuth routes) | `routes/eleme-admin.js` (629 lines) |
| Daemon→server internal API | `routes/eleme-internal.js` (575 lines) |
| Admin UI | `public/retail-admin/14-eleme.js` (1405 lines) |
| Interactive login | `scripts/eleme-login.js` |
| Mapping helpers | `scripts/eleme-match-products.js`, `scripts/eleme-apply-reviewed-matches.js` |
| Recon / findings | `ELEME_BROWSER_RECON.md`, `ELEME_INTEGRATION.md`, `docs/eleme-findings.md` (57 KB), `docs/eleme-mapping-groups-handover.md` |

### Gzgrocery

| Layer | Path |
|---|---|
| **Order reader** daemon (OpenCart) | `scripts/gzgrocery-order-daemon.js` (633 lines) |
| OpenCart HTTP client + HTML parser | `lib/gzgrocery-admin.js` (341 lines) |
| Order WeCom notifier | `lib/gzgrocery-order-notify.js` |
| **Stock pusher** daemon (Guanyi ERP) | `scripts/guanyi-daemon.js` (884 lines) |
| Guanyi browser driver | `lib/guanyi-browser.js` |
| Queue writer | `lib/guanyi-sync.js` |
| Admin API | `routes/guanyi-admin.js` (488 lines) |
| Admin UI | `public/retail-admin/12-guanyi.js` (533 lines) |
| Interactive login | `scripts/guanyi-login.js` |
| Spreadsheet import (one-off) | `scripts/import_gzgrocery.js`, `scripts/convert_gzgrocery_xlsx.js`, `scripts/gzgrocery_import.json` (1.1 MB), `scripts/suggest_gzgrocery_aliases.js` |
| Diagnostics / repair | `scripts/diagnose_gzgrocery_stock.js`, `diagnose_guanyi_errors.js`, `requeue_guanyi_errors.js`, `repair_guanyi_false_pickup.js`, `guanyi-probe-orders*.js`, `guanyi-pickup-report.js` |
| Findings | `docs/gzgrocery-findings.md` (1.4 KB — the shortest of the three by two orders of magnitude) |

### Shared / cross-channel

`lib/inventory.js` (`enqueueChannelSync`, `adjustStock`), `lib/bundle-stock.js`,
`lib/pack-units.js`, `lib/store-hours.js`, `lib/store-trading.js`,
`lib/channel-sync-stale.js`, `lib/ops-alert.js`, `lib/alert-latch.js`,
`lib/proxy-manager.js`, `lib/browser-env.js`, `lib/browser-warmup.js`,
`lib/tenant-creds.js`, `lib/tenant-db.js`, `lib/integrations/registry.js`,
`lib/integrations/session-relay.js`, `routes/integrations-admin.js`,
`public/retail-admin/15-integrations.js`, `scripts/check_sync_freshness.js`,
`ops/ops-screen/` (README + `login-trigger.js`).

### Things that run outside this repo

- **`ops/ops-screen/login-trigger.js` is deployed by `scp`, not from the repo
  tree.** `ops/ops-screen/README.md:28-33`: "This file does **not** run from the
  repo tree — copy it out". Its nginx config "lives only on the box".
- **The ops screen itself**: `Xvfb :99` + `x11vnc` + `websockify`/noVNC + an
  nginx basic-auth gate on `system.rootskitchenchina.com`. A human opens it on a
  phone and logs a channel in by hand.
- **A human re-login step** is the only re-auth mechanism for Meituan 外卖, 闪购,
  Eleme and Guanyi. See §2 of each channel.
- **Eleme's session file must be created on a machine with a display and
  `scp`'d to the box** (`scripts/eleme-daemon.js:47-49`). There is no ops-screen
  entry for Eleme (`ops/ops-screen/login-trigger.js:36-43` lists only
  `meituan-tianhe`, `meituan-yuexiu`, `guanyi-tianhe`).
- **闪购 attaches over CDP to a Chrome launched and kept alive by a separate pm2
  process** (`scripts/shangou-chrome.js`), headful under Xvfb, through a GZ
  proxy.
- **A GZ proxy server / residential "store box"** is referenced by
  `lib/proxy-manager.js` and `data/proxy-active.json`; neither lives here.
- **Spreadsheet imports**: `scripts/convert_gzgrocery_xlsx.js` and
  `scripts/convert_meituan_xlsx.py` consume `.xlsx` exports downloaded by hand
  from the respective portals.
- **WeCom group robots** (`qyapi.weixin.qq.com`) receive ops alerts and the
  gzgrocery order feed.
- **pm2** is the process supervisor for every daemon; there is no ecosystem file
  in the repo — start commands live only in each daemon's header comment.

---

# 1. MEITUAN

## 1.1 Transport

**Browser automation driving the merchant backend's own private JSON endpoints
from inside the logged-in page.** No official API is used anywhere.

Two physically different mechanisms:

**外卖 (`tianhe`) — `lib/meituan-browser.js`.** Headless Playwright Chromium with
a large anti-fingerprint init script (`fingerprintInitScript`,
`lib/meituan-browser.js:35-170` — spoofs `navigator.webdriver`, `platform`,
`userAgentData`, WebGL vendor/renderer, `navigator.plugins`, and the
`Notification.permission` / `permissions.query` mismatch). Requests are issued
via `frame.evaluate(() => fetch(...))` from inside the merchant page so
Meituan's H5guard SDK signs them.

**闪购 (`yuexiu`) — `lib/shangou-browser.js`.** Playwright's fingerprint is
rejected outright by 闪购 (403), so this **attaches over CDP** to a genuine
Chrome launched by `scripts/shangou-chrome.js`, headful under Xvfb, routed
through a GZ proxy. `scripts/shangou-daemon.js:3-8`:

> "yuexiu was force-migrated by licensing from 外卖 (e.waimai) to 闪购
> (shangoue.meituan.com), whose data APIs reject Playwright's automation
> fingerprint with 403."

**Hosts**

- `https://e.waimai.meituan.com` (`lib/meituan-browser.js:21`) and the
  `waimaie.meituan.com` content iframe
- `https://shangoue.meituan.com` (`lib/shangou-browser.js`)
- `verify.meituan.com` — the risk-control interstitial, detected at
  `lib/meituan-browser.js:240`
- `passport.meituan` — login redirect target, `lib/meituan-browser.js:457`

**Endpoints** (all called from inside the page)

| Purpose | Endpoint |
|---|---|
| Order list (外卖) | `POST /gw/api/unified/r/order/list/page/history` (`lib/meituan-browser.js:745`) |
| Order list (闪购) | `/gw/api/unified/r/order/list/interval` |
| Stock write (外卖) | `POST /reuse/product/food/w/batchUpdateSkuStock` (`lib/meituan-browser.js:1149`) |
| Stock write (闪购) | `/reuse/sc/product/retail/w/batchUpdateSkuStock` |
| Listing read (闪购) | `/reuse/sc/product/retail/r/searchListPageNew` |
| Name → spuId | `searchSugByName` (observed via response capture, `lib/meituan-browser.js:372`) |
| Category list | `POST /gw/bizproduct/v3/tag/r/tagList` (`:1662`) |
| Category's products | `POST /gw/bizproduct/v3/food/r/getSpuListCommon` (`:1674`) |
| spuId → skuId | `editView/v2` (response capture) |
| Read shop open/closed | `POST /common/businessStatus` (`:544`) |
| Write shop open/closed | `POST /api/poi/change_status` (`:577`) |

**Also present, separate from live sync:** a settlement-export importer
(`scripts/import_meituan.js` + `scripts/convert_meituan_xlsx.py`) that ingests
`.xlsx` bills downloaded by hand from the Meituan B2B portal into
`meituan_stores` / `meituan_orders` / `meituan_settlements` /
`meituan_balance_flow` (`database.js:1040-1120`). These tables are **entirely
disjoint** from the live-sync tables (`meituan_order_import` etc.) despite the
overlapping names.

## 1.2 Authentication

**Credentials needed:** a human logging in to the merchant portal — WeChat QR
scan, or account+password, or SMS, plus solving a slider challenge
(`lib/meituan-browser.js:479`: "log in (account+password or SMS), solve any
slider"). Plus, for 闪购, the store binding must be re-selected after login.

**Where the credential actually lives:** a Playwright `storageState` JSON —
cookies and localStorage — written to
`data/meituan-sessions/<storeCode>-session.json`
(`lib/meituan-browser.js:20, 212, 1851-1852`). **Plaintext on disk.** Not
encrypted, not hashed. `.gitignore:48` excludes `/data/` so it is not committed.

**Three credential stores exist; only one is used.**

1. `data/meituan-sessions/*.json` — **the live one.**
2. Env `MEITUAN_<CODE>_USER` / `MEITUAN_<CODE>_PASS`, read at
   `scripts/meituan-daemon.js:555-556` into `meituanUser` / `meituanPass` on the
   store config. Grepping the tree, **nothing ever consumes those two fields** —
   the filter on the next line is `.filter(s => s.meituanUser || true)`, which is
   unconditionally true. They are a dead read.
3. `lib/tenant-creds.js` — AES-256-GCM (via `lib/secret-box.js`) keys
   `meituan.<code>.user` / `meituan.<code>.pass`
   (`lib/tenant-creds.js:117-120`), with an explicit Roots env carve-out at
   `:231-232`. **No daemon requires `tenant-creds`.**

**Expiry detection.** `ensureLoggedIn()` (`lib/meituan-browser.js:405-445`)
treats the URL alone as a false positive and requires the merchant dashboard
iframe to be present. Separately, a **"store binding lost"** state is detected
when Meituan answers authenticated but with `acctId`/`region` null
(`_isBindingError` / `_flagBindingLost`, `:262`), which is a *different* failure
from a dead session and is handled separately everywhere.

**Re-auth is entirely human.** `lib/meituan-browser.js:445`: "session expired —
delete session file and re-run in headed mode". In practice the operator opens
the ops screen and taps a button (`ops/ops-screen/login-trigger.js:37-40`),
which spawns `scripts/meituan-login.js <store>` headed on the shared Xvfb
display; only one login window is allowed at a time (`login-trigger.js:45-48`).
The daemon pages the WeCom System-Alerts group when binding is lost
(`scripts/meituan-daemon.js:400-401`).

To reduce forced re-logins the daemon re-persists the live session to disk every
30 minutes while healthy (`SESSION_SAVE_MS`, `scripts/meituan-daemon.js:87-90`),
because "Meituan rotates session cookies during use" and a crash skips the
graceful save.

## 1.3 Trigger + cadence

Everything is **polling**. There is no webhook receiver for Meituan anywhere in
the tree.

| Loop | 外卖 | 闪购 |
|---|---|---|
| Order poll | `ORDER_POLL_MS = 300_000` (~5 min), jittered ±40% | `ORDER_POLL_MS = 120_000` (~2 min), jittered |
| Trailing status sweep | `ORDER_SWEEP_MS = 1_800_000` (30 min), window `MEITUAN_SWEEP_DAYS` (default 3) days back | same, `SHANGOU_SWEEP_DAYS` |
| Stock-push queue drain | `QUEUE_CHECK_MS = 10_000` | `QUEUE_CHECK_MS = 10_000` |
| Stock-drift backstop | `DRIFT_SWEEP_MS = 1_800_000` | same |
| Session re-save | `SESSION_SAVE_MS = 30 min` | — |
| Auto-map by 货号 | — | `MAP_REFRESH_MS = 60 min` |

The 5-minute order cadence is a deliberate detection trade-off, not a latency
requirement (`scripts/meituan-daemon.js:7-10`): "order timing isn't critical —
Meituan prints its own receipt… A slow, irregular poll minimises the recurring
page loads = smaller bot footprint".

**Additional triggers**

- **Stock push is edge-triggered**, not polled: any `physical_qty` mutation
  calls `enqueueChannelSync` (`lib/inventory.js:128-134`), which writes a
  `meituan_sync_queue` row. The daemon drains the queue.
- **Manual "Push all"**: `POST /api/retail-admin/meituan/push-all`
  (`routes/meituan-admin.js:563`).
- **Manual listing refresh**: `POST /api/retail-admin/meituan/listings/refresh`
  writes a `meituan_listing_jobs` row the daemon picks up (`:759`).
- **Open/close toggle**: the admin writes `store_business_status.target_open`;
  the daemon applies it via `/api/poi/change_status`.
- **Per-order accept command**: the admin writes `meituan_order_actions`; gated
  off by default behind `MEITUAN_WRITEBACK` (`database.js:4686-4691`).

**Gating.** Polling and pushing are suppressed outside the store's opening hours
(`lib/store-hours.js`, read per-call so an admin edit takes effect without a
restart) plus a 15-minute grace. `syncBusinessStatus` deliberately sits outside
that gate.

**Concurrency.** Each daemon is a single `while (true)` loop with `await` at
every step (`scripts/meituan-daemon.js:1419`,
`scripts/shangou-daemon.js:865`), so it cannot overlap *itself* within one
process. Cross-process there is:

- **No lock file, no flock, no pid file, no advisory DB lock.** Grepping for
  `flock` / `lockfile` / `pidfile` / `singleton` across the daemons returns
  nothing.
- The only protection between the two Meituan daemons — which share
  `meituan_sync_queue` and `meituan_order_import` — is **an env-var
  convention**: `MEITUAN_SKIP_STORES=yuexiu` on the 外卖 daemon and
  `SHANGOU_STORES=yuexiu` on the 闪购 one
  (`scripts/meituan-daemon.js:58-62`). Set them inconsistently and both daemons
  race the same rows.
- A soft claim exists per row: `UPDATE meituan_sync_queue SET
  status='processing', attempts=attempts+1` (`scripts/meituan-daemon.js:902`),
  but the preceding `SELECT … WHERE status='pending' AND attempts < 3`
  (`:845`) and this `UPDATE` are **not one atomic statement**, so two drainers
  can select the same row.

## 1.4 Direction and payload

### Inbound (Meituan → roots-v2)

**Objects:** orders; order status; cancellations/refunds; per-line prices and
listing ids; the fee/commission split; rider name and status; masked customer
id and order count; delivery distance and destination coordinates; invoice
title/tax id; customer note; cutlery flag; 预订单 window; delivery ETA.

**Path:** `browser.getPendingOrders()` → daemon → `POST
http://127.0.0.1:3000/api/internal/meituan/ingest-order` →
`routes/meituan-internal.js:382`.

**The stock-deducting item list comes from a *copy-to-clipboard text blob*, not
from structured JSON.** `lib/meituan-browser.js:774` reads
`u.copyButtonVo.clickCopyContent` and `:798` parses it with `_parseOrderCopy`
(`:625-658`). The structured rows *are* available and *are* fetched
(`extractOrderFields`, `:816`) but ride along as a sidecar `channel.items` and
are only used to attach prices — deliberately, because the copy text expands a
combo into its components while the structured rows report a combo as one line
(`:808-815`). Field mapping into `retail_orders`:

| Meituan source | roots-v2 column |
|---|---|
| `unifiedOrderInfo.wmOrderViewId` | `meituan_order_import.meituan_order_no` |
| — (generated `MT<yyyymmdd><rand6>`) | `retail_orders.order_no` |
| `copyButtonVo.clickCopyContent` → parsed items | `retail_order_items` rows |
| `合计:<n>元` regex from copy text | `total` (overridden by `money.userPaid` when present) |
| `basicVo.orderTime` / `commonInfo.order_time` | `placed_at`, `paid_at` |
| `statusDesc` | `channel_status` (+ mapped to internal `status`) |
| `commonInfo.estimateArrivalTime` | `channel_eta` |
| `basicVo.isPreOrder` + `deliveryBtime` | `channel_preorder_at` |
| `备注:` tail of copy text | `customer_note` |
| 餐具 phrases in copy text | `needs_cutlery` |
| `money.food` / `.shipping` / `.packaging` | `subtotal`, `shipping_fee`, `packing_fee` |
| `money` commission/settle/discount | `channel_commission`, `channel_settle_amount`, `channel_discount` |
| `rider.*` | `channel_rider_name`, `channel_rider_status`, `channel_rider_status_code`, `channel_rider_assigned_at`, `channel_rider_fetched_at`, `dispatched_at`, `delivered_at` |
| `customer.*` | `channel_customer_id`, `channel_customer_orders`, `channel_distance_m`, `channel_dest_lat`, `channel_dest_lng`, `recipient_name` |
| `invoice.*` | `needs_invoice`, `invoice_title`, `invoice_tax_id` |
| whole payload | `meituan_order_import.raw_payload` |

**Status vocabulary mapping** (`routes/meituan-internal.js:305-312`) is regex
over the Chinese label:

```js
if (/退款|退货/.test(d))                    return 'refunded';
if (/取消|已关闭|交易关闭/.test(d))         return 'cancelled';
```

**Product matching for an inbound line** —
`matchProductForLine`, `routes/meituan-internal.js:124-197`. Four tiers, in
order:

```js
// 0. The option this line names, claimed by exactly one product.
const claim = claimForLine(item, storeId, storeCode);
if (claim) { apply(claim, 'claim'); out.units = packUnits(claim.units_per_pack); return out; }

// 1. Inline SKU token.
const skuToken = item.sku || (String(item.name || '').match(/\d+-\d+/) || [])[0] || null;
if (skuToken) {
  const p = db.prepare('SELECT id, name_cn, name_en FROM store_products WHERE sku = ? AND is_active = 1').get(skuToken)
         || db.prepare('SELECT id, name_cn, name_en FROM store_products WHERE sku = ?').get(skuToken);
  if (p) { apply(p, 'sku'); out.sku = skuToken; return withUnits(); }
  out.matchBy = 'sku_unknown';
}

// 2. Product map by Meituan listing name (scoped to this store).
let hit = rows.find(r => normName(r.meituan_name) === wanted);
if (!hit) {
  // Substring either way (Meituan sometimes appends/trims a suffix), but
  // only when it's unambiguous.
  const cands = rows.filter(r => {
    const mn = normName(r.meituan_name);
    return mn && (mn.includes(wanted) || wanted.includes(mn));
  });
  if (cands.length === 1) hit = cands[0];
}

// 3. Unique active name match.
const cjk = (clean.match(/[一-鿿]+/) || [])[0];
const en  = (clean.match(/[A-Za-z][A-Za-z ]+/) || [])[0];
if (cjk) matches = db.prepare('SELECT id, name_cn, name_en FROM store_products WHERE is_active = 1 AND name_cn LIKE ?').all(`%${cjk}%`);
if (matches.length !== 1 && en) matches = db.prepare('SELECT id, name_cn, name_en FROM store_products WHERE is_active = 1 AND name_en LIKE ?').all(`%${en.trim()}%`);
if (matches.length === 1) { apply(matches[0], 'name'); }
```

`normName` (`routes/meituan-internal.js:32-38`) strips parenthesised specs, all
whitespace including full-width, and every non-letter/non-digit, then
lowercases. Tier 3 is a bare `LIKE %…%` on the **first CJK run** of the channel's
line name — the loosest matcher in any of the three integrations.

`attachChannelLines` (`:269-297`) then re-matches the structured rows onto the
copy-text lines with the same exact-then-unambiguous-substring rule.

**Cancels/refunds:** `POST /update-order-status`
(`routes/meituan-internal.js:659`) restocks on the *transition* into
cancelled/refunded, once only, guarded by `retail_orders.channel_stock_restored`,
with a re-deduct path if the order revives. An order whose *first* sighting is
already void (`bornVoid`, `:420-424`) is recorded but never deducted — a bug
found live on 2026-08-24 and documented in the code.

### Outbound (roots-v2 → Meituan)

**Objects:** stock quantity only, plus shop open/closed state, plus (gated off)
an order-accept click. **No prices, no listings, no product creation, no
availability flags, no fulfilment status.**

**Path:** `lib/inventory.js` `enqueueChannelSync` → `lib/meituan-bundles.js`
`enqueueProductStock` → `meituan_sync_queue` → daemon → browser →
`batchUpdateSkuStock`.

The queued number is `bundleStock.sellableAt(db, storeId, productId)` — a
bundle reports its component floor, everything else its own shelf count. Bundles
containing a moved product are re-enqueued one level deep
(`lib/inventory.js:113-134`).

**Product matching for an outbound push** — this is where the two Meituan
daemons diverge completely:

- **外卖**: resolve by **name** through Meituan's own `searchSugByName`, then
  category click, then `getSpuListCommon`. The rule is now **exact, byte-for-byte
  after trim** (`_sugFromCapture`, `lib/meituan-browser.js:1300-1307`).
- **闪购**: resolve by **货号** — `sourceFoodCode === store_products.sku` —
  refreshed hourly (`scripts/shangou-daemon.js:682-720`). No name matching, no
  mapping UI needed.

## 1.5 Idempotency + deduplication

**Duplicate order import** is prevented by a unique external id:

```sql
CREATE TABLE IF NOT EXISTS meituan_order_import (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  meituan_order_no  TEXT UNIQUE NOT NULL,
  retail_order_id   INTEGER,
  store_code        TEXT NOT NULL,
  accepted_at       DATETIME,
  imported_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  status            TEXT NOT NULL DEFAULT 'accepted',
  raw_payload       TEXT,
  FOREIGN KEY (retail_order_id) REFERENCES retail_orders(id) ON DELETE SET NULL
);
```
(`database.js:4671-4682`.) Enforced twice: a pre-check `SELECT`
(`scripts/meituan-daemon.js:600-602`; `shangou-daemon.js:565`) and `INSERT OR
IGNORE` (`:622`; `:575`). Both daemons write the same table with the same key,
so the 外卖/闪购 split cannot double-import.

**Duplicate stock adjustment.** Two separate mechanisms:

1. Pushes are **absolute, not delta** — `new_qty` is the target. Re-applying the
   same number is a no-op on Meituan's side.
2. Order-driven deduction is once-per-order via `channel_stock_restored` plus
   the import ledger above.

Within a drain cycle, rows are collapsed to the latest quantity per target and
superseded rows are retired (`scripts/meituan-daemon.js:873-892`). Note the
target key is the *stock box*, `p:<productId>:m<mapId>` or `b:<bundleId>`, not
the product.

Enqueue-time dedupe: `lib/meituan-bundles.js` has a `refreshPending`-style
in-place update, and containing-bundle enqueues are deduped per
`(store, bundle, tick)` **keyed on the quantity** (`lib/inventory.js:82-95`).

**Other unique constraints:** `meituan_product_map UNIQUE(retail_store_id,
product_id)` plus a later `UNIQUE(retail_store_id, product_id, spec_key)` and a
partial `UNIQUE(retail_store_id, meituan_name, spec_key) WHERE spec_key <> ''`
(`database.js:5319-5325`); `meituan_order_actions UNIQUE(meituan_order_no,
action_type)`; `meituan_listings UNIQUE(store_code, listing_name)`.

## 1.6 Error handling

**Retry policy: at most 3 attempts, no backoff, no dead-letter queue.** The
drain query is `WHERE q.status = 'pending' AND q.attempts < 3`
(`scripts/meituan-daemon.js:845`). Failures are classified:

| Failure | Handling |
|---|---|
| Network / page hiccup / login failure | transient → `status='pending'`, retry |
| Store binding lost | `status='pending'`, **`attempts=attempts-1`** (attempt refunded), ops alert, back off (`:1026`) |
| Verification (`verify.meituan.com`) cool-down | `status='pending'`, `attempts=attempts-1` (`:1020`) |
| HTTP 200 + non-zero business code | `apiRejected` → terminal `status='error'` on first attempt (`:1045-1046`) |
| 套餐 combo with an out-of-stock component (`code 10048`) | treated as **success** — Meituan's forced sold-out is the correct end state (`lib/meituan-browser.js:1170-1173`) |
| Whole batch threw | `attempts` kept so `<3` bounds it; row stays pending (`:1086`) |
| Rate limit | **Not distinguished.** No 429/风控 branch other than the verification-page detection. |
| Malformed response | `_extractSku` / structural readers degrade to "found nothing"; a garbled reply is transient, an empty-but-well-formed one is terminal (`lib/meituan-browser.js:1245-1272`) |

**A row that exhausts 3 attempts is terminal and unreachable.**
`docs/eleme-findings.md` finding 1 records this holds on all three channels:
"Once a queue row exhausts its attempts nothing reads it again… not retried, not
retired, and not reachable by any supported operation."

**Two backstops exist for Meituan only:**

- `lib/meituan-drift-sweep.js` — every 30 min, re-reads actual stock against
  what Meituan last accepted and **re-enqueues the gap regardless of why the
  earlier push failed** (`scripts/meituan-daemon.js:70-78`; wired in at `:1501`
  and `scripts/shangou-daemon.js:932`). This is the only thing in any of the
  three channels *designed* to recover a terminally-failed row. Unlike the
  OpenCart re-login above, it is **observable**: a run writes a `drift_sweep` row
  to `meituan_sync_log` (`lib/meituan-drift-sweep.js:256-257`). This audit read
  code, not live log tables, so how often it has actually fired is not
  established here — but the evidence to settle it exists and can be queried.
- `scripts/meituan-daemon.js:1093-1102` recovers rows stranded in `'processing'`
  by a crash, since the retry query would never see them again.
- `lib/meituan-queue-stall.js` — a 120-minute canary on the queue.

**Failure is loud.** `sendOpsAlert` is called 17 times in `meituan-daemon.js`
and 8 times in `shangou-daemon.js` — to a dedicated WeCom "System Alerts" group,
with disk-backed latches (`lib/alert-latch.js`) so a restart mid-incident cannot
swallow the recovery message. Every event also lands in `meituan_sync_log`.

## 1.7 Observability

**Logged:**
- `meituan_sync_log(store_code, event_type, status, detail, error_msg,
  created_at)` — every order poll, stock push, system event.
- `meituan_order_import.raw_payload` — the whole order payload.
- `meituan_sync_queue.last_error` per row.
- stdout via pm2 (`pm2 logs meituan-sync`).
- WeCom System Alerts group.

**Retention: none.** There is no pruning, no TTL, no vacuum for any
`*_sync_log` table anywhere in the tree. `routes/meituan-admin.js:481-484`
records the consequence: "the column holds every terminal failure ever recorded
(1276 of them on 天河 as of 2026-08-22, the oldest 55 days old)".

**Admin UI.** `public/retail-admin/11-meituan.js` (2141 lines), served from the
Meituan tab, backed by `GET /api/retail-admin/meituan/status`
(`routes/meituan-admin.js:473-526`). It returns `queuePending`, `queueFailed`
(scoped to the last day), `queueOldestMin` (age of the oldest waiting push),
`recentStock` (last 25 stock pushes), `recentSystem` (last 6 system events),
`lastOrder` (last 5 imports), `mappedCount`, and per-store health
(`meituanStoreHealth`). The tab self-polls while visible
(`11-meituan.js:58-67`).

**Cross-channel surface.** The dashboard renders a "channel stock-sync stall"
attention row per channel from `lib/channel-sync-stale.js` via
`routes/retail.js:15512`, threshold 3 minutes of *pushable* (open-hours-adjusted)
elapsed time (`public/retail-admin/03-dashboard.js:2803-2830`).

**Could an operator answer "did Meituan sync in the last hour, and did anything
fail?" without a terminal? — Yes.** Evidence: the Meituan tab shows last-order
time, oldest-pending age, a 1-day failure count and the last 25 stock pushes
with error text; the dashboard raises a "channel not syncing" row on its own;
and the WeCom group is paged on disconnect. `scripts/check_sync_freshness.js` is
a terminal-only extra probe, not the primary answer.

## 1.8 Multi-tenancy readiness

**The daemons are hardcoded to Roots.** `scripts/meituan-daemon.js:46` does
`const db = seam(require('../database'))` — the shared `roots.db`. There is no
`tdb()`, no tenant loop, no tenant argument anywhere in either Meituan daemon.
`lib/tenant-db.js` gives non-Roots tenants their own SQLite file; the daemons
cannot see those files at all.

**Business-specific constants found:**

| Location | Constant |
|---|---|
| `scripts/meituan-daemon.js:121-122` | `LEGACY_STORE_HOURS = { yuexiu: 11:00–20:15, tianhe: 10:00–20:00 }` (fallback only — real hours come from `retail_stores`) |
| `scripts/meituan-daemon.js:154` | `PROXY_CHANNEL = process.env.MEITUAN_PROXY_CHANNEL \|\| 'tianhe'` |
| `scripts/shangou-daemon.js:54` | `SHANGOU_STORES = process.env.SHANGOU_STORES \|\| 'yuexiu'` |
| `scripts/shangou-daemon.js:91` | `yuexiu` hours fallback |
| `scripts/shangou-daemon.js:126` | `require('../lib/proxy-manager').readActive('yuexiu')` — **literal, no env override** |
| `lib/meituan-browser.js:211` | `this.storeCode = storeCode; // 'tianhe' \| 'yuexiu'` (comment only) |
| env | `SHANGOU_WMPOIID`, `SHANGOU_REGION_ID`, `SHANGOU_REGION_VERSION` — a single shop's identifiers |
| `lib/tenant-creds.js:101-104` | `MEITUAN_TIANHE_USER/PASS`, `MEITUAN_YUEXIU_USER/PASS` |

**Could a second tenant configure this today through the admin UI? No.** What
exists is a *façade*: `lib/integrations/registry.js` declares a `meituan`
descriptor with a six-step wizard (`store_box`, `credentials`, `verify_login`,
`link_stores`, `map_products`, `verify`), `lib/integrations/session-relay.js`
implements the SMS-relay state machine behind a driver seam, and
`routes/integrations-admin.js` + `public/retail-admin/15-integrations.js` render
the cards. But:

- `session-relay.js:15-18` says the real browser work is done by a "DRIVER" on a
  worker host; **no production driver is registered in this repo** — the only
  implementation is the simulation driver.
- Nothing writes `tenant_integrations` from the daemons; `health_json` /
  `last_sync_at` on the card are never populated by the sync path.
- The daemon reads credentials from env (dead) and sessions from a local
  directory, not from `tenant-creds` or the relay.

To make a second tenant work would require, at minimum: the daemons to loop over
tenants and use `getTenantDb`; per-tenant session storage keyed by
`(tenant, store)`; a real relay driver on a worker host; the daemon writing back
into `tenant_integrations.health_json`; per-tenant proxy/egress; and removal of
the `'yuexiu'` literal at `shangou-daemon.js:126`.

## 1.9 Known fragility

Everything below depends on something outside our control staying identical.

**1. The order item list is parsed out of a clipboard string.**
`lib/meituan-browser.js:625-658`. It depends on: the literal marker `已隐藏`
starting the item region; the literal `合计:` / `合计：` ending it; items being
separated by **two or more spaces**; each item ending in `x<digits>` or
`×<digits>`; combos being wrapped in `[...]` with components joined by `、`; and
a fixed skip-list `(无需餐具|No cutlery|餐具|打包费|配送费|包装费)`. The code
carries a live incident from this: a stray space inside a SKU paren split one
item into two, which imported unnamed and **never deducted stock** (order
`MT20260703413386`, 2026-07-03).

**2. The customer note parser depends on Meituan's own section markers.**
`_parseOrderNote` (`:674-696`) strips the literal `[其它备注]`, the literal
`(已付款)` / `（已付款）`, the literal `在线支付订单`, and de-duplicates a tail
Meituan repeats verbatim.

**3. Category matching depends on rendered label text.** `_normCategory`
(`:1347-1353`) strips emoji, VS16 and ZWJ from both sides and compares. The
comment records the failure this replaced: 天河's `☕️咖啡豆&茶叶` was normalised
to `咖啡豆茶叶`, which is not a substring of the real label because the `&`
survives — so the click timed out, `getSpuListCommon` never fired, and every
product in that category failed with "could not resolve skuId" **from June
until it was found**.

**4. Undocumented private endpoints and request shapes.** Every path in §1.1 is
a private merchant endpoint. The stock-write body hand-builds a nested
`newSupplyParam` with `templateId: -1`, `requestSource: '1'`, `maxStock: '-1'`,
`viewStyle: '0'`, `opTab: '0'`, `tagCat: '1'`
(`lib/meituan-browser.js:1140-1148`). Any of these changing breaks the write
silently-ish (it returns a non-zero code and burns the row terminally).

**5. Response field names.** `orderInfo` / `commonInfo` are JSON *strings*
inside the response and are re-parsed (`:769-770`); the reader depends on
`unifiedOrderInfo`, `copyButtonVo.clickCopyContent`, `basicVo.isPreOrder`,
`basicVo.deliveryBtime`, `commonInfo.estimateArrivalTime`,
`wm_poi_order_dayseq`, `searchSugVos[].spuId/.tagName`.

**6. Business-code semantics.** `code === 10048` and `/套餐/.test(msg)` are
treated as *success* (`:1170`). A wording change on Meituan's side turns a
correct no-op into a terminal error, or vice versa.

**7. Anti-bot posture is load-bearing.** The whole fingerprint script, the
"human pause" jitter, the slow poll cadence, the coherent Windows identity, and
the requirement that 闪购 use a *real* Chrome over CDP all exist because the
platform actively detects automation. `verify.meituan.com` appearing is a
first-class daemon state.

**8. DOM clicking still exists in one place.** `acceptOrder`
(`:829-844`) does `document.querySelectorAll('[class*="order"]')` and looks for
a button whose `innerText.trim()` is exactly `接单` or `确认接单`. This is gated
off by default (`MEITUAN_AUTO_ACCEPT`) but is live code.

**9. Timing / race windows.**
- The `SELECT … WHERE status='pending'` and the `UPDATE … SET
  status='processing'` are not atomic (§1.3).
- `scripts/meituan-daemon.js:868-874` notes the eligibility re-check exists
  "only because state can change between the query and the push".
- A row stranded in `'processing'` by a crash is invisible to the retry query;
  a dedicated recovery pass exists for exactly this (`:1093-1102`).
- The 30-minute drift sweep and the 120-minute stall canary both exist because
  edge-triggered pushes can be lost.

**10. Status classification is regex over Chinese label text.**
`internalStatusForChannel` (`routes/meituan-internal.js:305-312`) — and the
ordering is load-bearing: "Ordered so pre-dispatch labels that happen to contain
配送 (待发起配送/待配送) classify as preparing, not dispatched."

### The restock-on-label-substring logic — located

The brief asks specifically for this. It is `_nameMatches`,
**`lib/meituan-browser.js:1220-1227`**:

```js
  _nameMatches(candidateName, cn, en) {
    const n = String(candidateName || '');
    if (cn && n.includes(cn)) return true;
    const core = this._coreQuery(cn || en);
    if (core && n.includes(core)) return true;
    if (en && n.toLowerCase().includes(String(en).toLowerCase())) return true;
    return false;
  }
```

Its middle arm calls `_coreQuery` (`:1192-1197`), which returns the **leading
same-script run** of the name:

```js
  _coreQuery(term) {
    const t = String(term || '');
    const m = t.match(/^[一-鿿]+/) || t.match(/^[A-Za-z][A-Za-z ]*[A-Za-z]/) || t.match(/^[A-Za-z]+/);
    const c = m ? m[0].trim() : t;
    return c.length >= 2 ? c : t;
  }
```

So "the candidate must contain our whole name" was in practice "the candidate
must contain our name's first few characters" — which every size variant of a
product shares by construction.

**The code path around it.** The header comment above it
(`:1211-1219`) states the current position verbatim:

> ⚠️ NOT IN THE PUSH PATH ANY MORE, AND MUST NOT GO BACK INTO IT. This is the
> rule that resolved 133 mappings and 13 bundles one rename away from a
> sibling's listing, and had two bundles writing at one already. Both places
> that used it for a stock write — `_sugFromCapture` and `_skusFromSpuList` —
> now match exactly, or by spuId, or refuse. Its only remaining caller is
> `_extractSku` below, which nothing but `scripts/meituan-set-stock.js` and
> `scripts/meituan-test-libstock.js` reaches.

And at `:1277-1299`, on the replacement:

> EXACT, AND ONLY EXACT… 133 of 393 mappings and 13 of 19 bundles sat one rename
> away from resolving onto a sibling, and two bundles were doing it already:
> bundle 2 differs from its listing by ONE space and was pushing its count at a
> different product's listing. The shortest-name tiebreak that followed made the
> wrong choice deterministic; it never made it right.

**Verified against the tree:**
- Live callers of `_nameMatches`: only `_extractSku`
  (`lib/meituan-browser.js:1436`), which is reached only through
  `browser.updateStock(...)`. The three files that call `updateStock` are
  `scripts/meituan-set-stock.js`, `scripts/meituan-test-libstock.js` and
  `scripts/meituan-test-libvariants.js` — all operator/test scripts, none in the
  daemon path. (The in-code comment at `:1216-1217` names only the first two;
  `meituan-test-libvariants.js` calls `updateStock` at its lines 79 and 87, so
  that comment is one script out of date.)
- The production push path resolves via `_sugFromCapture`
  (`:1300-1307`), which is `String(x.name || '').trim() === want` — exact.

**Three caveats, all from code evidence:**

1. **The comment in `scripts/meituan-daemon.js:906-907` is now stale** and says
   the opposite: *"Bundle rows target a Meituan listing by name; product rows by
   the product's own name. `_updateOneOnPage` matches the list row by
   substring."* The driver no longer does.
2. **Substring matching is still live on the inbound side**, in
   `matchProductForLine` tier 2 and tier 3 and in `attachChannelLines`
   (`routes/meituan-internal.js:174-194, 276-283`). Those decide which product a
   *sale* deducts from — a different write, the same class of risk. The
   inbound-side guard is "only when it's unambiguous" (exactly one candidate),
   which the old push-side rule lacked.
3. **`_searchTerms` (`:1319-1333`) still uses `_coreQuery`** to decide *what to
   type* into Meituan's suggest. The file is explicit that this is deliberate and
   safe: "The term decides WHAT WE TYPE; it has never had any business deciding
   what counts as a match."

---

# 2. ELEME

## 2.1 Transport

**Browser automation against a JSON-RPC gateway.** `lib/eleme-browser.js:1-25`
states the reason:

> Eleme's official OpenAPI rejects our single-store accounts ("暂不支持该账户登录"
> — see ELEME_BROWSER_RECON.md), so this replaces `lib/eleme-client.js` (OAuth,
> now dead).

Playwright, reusing Meituan's `fingerprintInitScript` (`lib/eleme-browser.js:34`
imports it from `lib/meituan-browser`) and defaulting to the **same active proxy
the store's Meituan channel already elected** (`:110-119`).

**Hosts**

| Host | Role |
|---|---|
| `https://melody.shop.ele.me` | the merchant shell; the only authenticated context |
| `https://napos-goods-pc.faas.ele.me/single/goods-manage` | goods micro-frontend |
| `napos-order-pc.faas.ele.me` | orders micro-frontend — **recognised, never navigated to**: opened as a top-level tab it answers `UNAUTHORIZED 未登录` (confirmed live 2026-08-24, `:39-42`) |
| `app-api.shop.ele.me` | the RPC gateway |

**Calls** are `{ service, method, metas: { appName:'melody', appVersion:'4.4.0',
ksid, shopId }, … }` envelopes (`:688-704`):

| Purpose | Service.method / path |
|---|---|
| Stock write | `FoodService2.updateFoodStock` via `nevermore.goods/invoke` (`:969`) |
| Order list | `OrderWebService.<ORDER_LIST_METHOD>` under `fulfill/weborder/` — default `queryInProcessOrders` (`:50-52`, `:1360`) |
| Order detail | `ELEME_ORDER_DETAIL_SERVICE` / `ELEME_ORDER_DETAIL_METHOD` (`:1461-1462`) |
| Voids | matched by regex `abnormalOrders` \| `refundOrders\|cancelOrders` \| `queryExceptionInfo` (`:73-77`) |

**The order path is a four-rung ladder, deliberately.** `lib/eleme-browser.js:20-24`:

> the recon captured the order RPC method NAMES and nothing else, so the order
> path reads what the merchant page itself fetches wherever it can (**observe**),
> replays the page's own captured request body when it can't (**replay**), and
> only falls back to a bounded one-per-session **probe** of candidate request
> shapes as a last resort.

Probe is off unless `ELEME_ORDER_PROBE=1` — "the ONLY thing in the order path
that can emit a request a real merchant session never makes" (`:94-98`).

## 2.2 Authentication

**Credentials needed:** a human logging in to Napos, plus clearing any
risk-control challenge.

**Where stored:** `data/eleme-sessions/<storeCode>-session.json`, a Playwright
`storageState` (`lib/eleme-browser.js:36, 306`). **Plaintext on disk**,
gitignored via `/data/`.

**A second, unused credential store exists.** `eleme_tokens`
(`database.js:5098-5112`) holds `access_token` / `refresh_token` / `expires_at`
in **plaintext columns**, populated by the OAuth callback at
`routes/eleme-admin.js:579`. `ELEME_APP_KEY` / `ELEME_APP_SECRET` /
`ELEME_REDIRECT_URI` / `ELEME_SANDBOX` come from env. The daemon never reads any
of it — `scripts/eleme-daemon.js:8-9`: "lib/eleme-client.js (the old OAuth
client) is dead; nothing in this file calls it any more." **The OAuth start and
callback routes are still mounted and still write `eleme_tokens` and
`eleme_shops`.**

**Expiry detection:** `ensureLoggedIn()` plus a `ksid` wait
(`_waitForKsid`, `lib/eleme-browser.js:841`). `:530` notes one class of error is
surfaced as-is "so callers don't trigger a pointless re-login".

**Re-auth is human and the most awkward of the three.**
`scripts/eleme-daemon.js:47-49`:

> First run per store: no session on disk yet, so the daemon can't log in on its
> own — run `node scripts/eleme-login.js <storeCode> <shopId>` on a machine with
> a display, then copy `data/eleme-sessions/<storeCode>-session.json` to the box.

**There is no Eleme entry in the ops screen.** `ops/ops-screen/login-trigger.js:36-43`
lists `meituan-tianhe`, `meituan-yuexiu`, `guanyi-tianhe` and nothing else. So
Meituan and Guanyi can be re-logged-in from a phone in minutes; Eleme requires a
laptop with a display and an `scp`.

## 2.3 Trigger + cadence

Polling only; no webhook.

| Loop | Value | Source |
|---|---|---|
| Stock queue drain | ~10 s, jittered | `QUEUE_CHECK_MS`, `scripts/eleme-daemon.js:764` |
| Order poll | ~5 min per store | daemon header `:31` |
| Orders-tab re-navigation | at most every 10 min | `ORDER_PAGE_STALE_MS`, `lib/eleme-browser.js:79` |
| Wait for the page's own list call | 12 s | `ORDER_OBSERVE_MS`, `:82` |
| Max age of an observed response counted as current | 120 s | `ORDER_RESULT_MAX_AGE_MS`, `:88-92` |

Order polling can be turned off entirely with `ELEME_ORDER_POLL=0`; the per-order
detail read (Tier 1) with `ELEME_ORDER_TIER1=0`.

**Gating:** two gates, both cheap, in `lib/eleme-sync.js:15-21` and `:41-58` —
the tenant switch `storefront_config 'eleme.enabled'` **and** an
`eleme_product_map` row with `sync_enabled = 1`. Pushes additionally skip stores
the operator closed for Eleme in the channel matrix
(`channelClosedStores('eleme')`, `scripts/eleme-daemon.js:456-460`) and stores
outside opening hours + a 30-minute grace.

**Concurrency:** single `while (true)` loop (`scripts/eleme-daemon.js:737`).
**No lock of any kind.** Same non-atomic select-then-claim as Meituan
(`:480` then `:526`). `ELEME_SKIP_STORES` exists as the same env convention.

## 2.4 Direction and payload

### Inbound (Eleme → roots-v2)

**Objects:** orders; order status; cancels/refunds (from a *separate* queue —
"a voided order LEAVES the in-process list, so the list alone can never see
one", `lib/eleme-browser.js:68-72`); per-line names/qty/prices; money split
(merchant income after commission, platform-vs-merchant discount,
packaging/delivery fees); ETA; 预订单 window; note; cutlery; the address and
phone **as already masked by Eleme (隐私号)**.

**Explicitly not collected**, `scripts/eleme-daemon.js:34-39`: anything that
un-masks a customer, bulk export endpoints, deep history backfills, reviews and
competitor analytics — "Eleme audits those reads per view… and it is a PIPL
problem regardless of detection".

**Path:** daemon → `POST /api/internal/eleme/ingest-order`
(`routes/eleme-internal.js:277`).

**Field mapping** into `retail_orders` — note this is a **strict subset** of
Meituan's:

| Eleme source | roots-v2 column |
|---|---|
| `elemeOrderId` | `eleme_order_import.eleme_order_id` |
| generated `EL<yyyymmdd><rand6>` | `retail_orders.order_no` |
| `order.total` | `subtotal` **and** `total` (deliberately equal) |
| `order.placedAt` | `placed_at`, `paid_at` |
| `order.statusDesc` | `channel_status` + mapped internal `status` |
| `order.eta` | `channel_eta` |
| `order.preOrderAt` | `channel_preorder_at` |
| `order.note` | `customer_note` |
| `order.needsCutlery` | `needs_cutlery` |
| `order.commission` | `channel_commission` |
| `order.merchantIncome` | `channel_settle_amount` |
| packaging / delivery fees | **NOT written to columns** — kept in `eleme_order_import.detail_json` (`routes/eleme-internal.js:308-313`) |
| rider, customer geo, invoice | **not present** |

**Product matching for an inbound line** —
`matchProductForLine`, `routes/eleme-internal.js:176-236`. Structurally
**identical to Meituan's** (claim → sku → map-name exact-then-unambiguous-substring
→ unique `LIKE %cjk%` / `LIKE %en%`), with two differences: no `storeCode`
argument, and no `\d+-\d+` token extraction from the name (Eleme's `item.sku`
is trusted as-is):

```js
  if (item.sku) {
    const p = db.prepare('SELECT id, name_cn, name_en FROM store_products WHERE sku = ? AND is_active = 1').get(item.sku)
           || db.prepare('SELECT id, name_cn, name_en FROM store_products WHERE sku = ?').get(item.sku);
    if (p) { apply(p, 'sku'); return withFallbackUnits(out, storeId); }
    out.matchBy = 'sku_unknown';
  }
```

`normName` at `routes/eleme-internal.js:52-58` is a **byte-for-byte copy** of
`routes/meituan-internal.js:32-38`.

### Outbound (roots-v2 → Eleme)

**Objects: stock quantity only.** No prices, no listings, no open/closed toggle
(the Eleme cell in the channel-close matrix gates *our* pushes, it does not
close the shop on Eleme), no order acknowledgement.

**Matching for the push is by NAME, exactly** — despite what the schema comment
claims. `database.js:5132-5134` says: *"Eleme resolves a listing by its 货号
(extendCode) which we hold in `store_products.sku`, so most products auto-map by
SKU"*. The code disagrees; `lib/eleme-browser.js:827-831`:

> Push one product's stock to Eleme **by name** (our Eleme items carry no
> extCode — see the ELEME_BROWSER_RECON.md footgun — so name is the only
> matching key until a one-time 货号-backfill pass changes that). `sku` (our own
> 货号) is accepted for interface parity with `meituan-browser.updateStock` **but
> unused**.

And `scripts/eleme-daemon.js:528-529`: "Eleme has no extCode/货号 to match on yet".
The lookup is a plain `Map.get(name)` against the cached catalogue
(`lib/eleme-browser.js:846-850`).

**Which size gets the number** — three rules, `_applyStockRule`
(`lib/eleme-browser.js:892-937`):

1. operator mapped one `specGlobalId` → write only that size;
2. the listing has exactly one size → write it;
3. **otherwise a guess**: `const targets = skus.map((_, i) => (N >= 3) ? BIG :
   (i === 0 ? N : 0));` with `BIG = 9999`. The log line says so out loud:
   `variants set (GUESS — no size mapped)`.

A mapped size that has disappeared is a terminal config error, **not** a
fall-through to the guess (`:918-919`).

## 2.5 Idempotency + deduplication

```sql
CREATE TABLE IF NOT EXISTS eleme_order_import (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  eleme_order_id  TEXT UNIQUE NOT NULL,
  retail_order_id INTEGER,
  store_code      TEXT NOT NULL,
  imported_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  status          TEXT NOT NULL DEFAULT 'imported',
  raw_payload     TEXT,
  FOREIGN KEY (retail_order_id) REFERENCES retail_orders(id) ON DELETE SET NULL
);
```
(`database.js:5175-5185`; `detail_json` added at `:5242`.) Enforced by a
pre-check `SELECT` (`scripts/eleme-daemon.js:315`) and `INSERT OR IGNORE`
(`:339`).

**Stock:** same absolute-target design as Meituan; `channel_stock_restored`
guards the void restock once-only with a re-deduct path
(`routes/eleme-internal.js:435`+). Queue rows are collapsed per stock box within
a cycle and superseded rows retired (`scripts/eleme-daemon.js:500-516`).
Enqueue-time in-place update via `refreshPending` (`lib/eleme-sync.js:30-38`) —
present, and its comment explains what its absence cost: "a product that changed
5 times before the daemon got to it queued 5 separate pushes of increasingly
stale values".

**Other constraints:** `eleme_product_map UNIQUE(retail_store_id, product_id)`
plus the later `(…, spec_key)` pair; `eleme_shops UNIQUE(retail_store_id)`;
`eleme_tokens UNIQUE(account)`; `eleme_catalogue_cache UNIQUE(store_code, name)`.

## 2.6 Error handling

**Retry: 3 attempts, no backoff, no dead-letter** — `WHERE q.status = 'pending'
AND q.attempts < 3` (`scripts/eleme-daemon.js:480`).

Classification (`:595-620`):

| Failure | Handling |
|---|---|
| Login / navigation / ksid wait | transient → pending, `attempts=attempts-1` (refunded) |
| Catalogue could not be READ | **transient** — "answering 'not in the catalogue' would be a verdict from an empty input" (`lib/eleme-browser.js:860-868`) |
| Name not in a catalogue we did read | **terminal, first attempt**, with a human-readable `reason` carried into the queue row and sync log (`:869-881`) |
| Mapped size gone from the listing | terminal (`:918-919`) |
| Batch threw | `attempts<3` bounds it; row stays pending (`:644`) |
| Rate limit | not distinguished |

The transient branch at `:601-609` carries a long comment about an off-by-one
that previously stranded a row's third attempt permanently — "stuck forever,
invisible to both the retry query and the terminal-error branch".

**There is no drift sweep and no stall canary for Eleme.** Meituan's
`lib/meituan-drift-sweep.js` has no Eleme counterpart. A terminally-failed Eleme
row is never re-attempted by anything.

**Loudness:** 7 `sendOpsAlert` calls in `eleme-daemon.js` — "Deliberately
smaller than meituan-daemon's (no heartbeat/queue-stall canary…)" (`:176-177`).
Everything lands in `eleme_sync_log`.

## 2.7 Observability

**Logged:** `eleme_sync_log`, `eleme_order_import.raw_payload` +
`detail_json`, per-row `last_error`, pm2 stdout, WeCom. **No retention policy.**

**Admin UI:** `public/retail-admin/14-eleme.js` (1405 lines), backed by `GET
/api/retail-admin/eleme/status` (`routes/eleme-admin.js:505-535`): `queuePending`,
`queueError` (**all-time, not scoped to a day** — unlike Meituan's), `mappedCount`,
last 25 stock pushes, last 8 system events, last 5 imports, per-store health.
`elemeStoreHealth` had a bug the comment records: it "reported the FIRST unwell
store, and it said nothing at all about a healthy one" (`14-eleme.js:186`).

**Also on the Eleme tab:** an `eleme_catalogue_cache`-backed autocomplete for
listing names, built after "a hand-typed name used the wrong apostrophe character
and silently failed every push" (`database.js:5205-5215`).

**Dashboard:** included in `lib/channel-sync-stale.js` `CHANNELS`, threshold 3
min pushable, grace 30 min.

**Could an operator answer the hour question? — Yes**, with a caveat: the Eleme
tab has no `queueOldestMin` equivalent, so "the queue has 40 pending" and "the
queue has been stuck for 19 hours" look the same on the Eleme tab. The
dashboard's stale row covers the gap.

## 2.8 Multi-tenancy readiness

**Hardcoded to Roots in the same way**: `scripts/eleme-daemon.js` uses
`seam(require('../database'))`, the shared DB.

**But Eleme is the most tenant-shaped of the three:**

- Store list is fully data-driven — `retail_stores JOIN eleme_shops ON
  e.retail_store_id = s.id WHERE shop_id IS NOT NULL`
  (`scripts/eleme-daemon.js:164-174`). **No store code appears as a literal
  anywhere in the Eleme code.**
- Feature switch is per-tenant config (`storefront_config 'eleme.enabled'`).
- Shop id is a DB column, not an env var.
- Store hours come from `retail_stores`.

**Business-specific constants found:** none in the daemon or browser. The single
Roots-specific artefact is the recon capture reference `shop 1304930646` in a
comment (`lib/eleme-browser.js:13`) and in `scripts/eleme-login.js`'s usage
example.

**Could a second tenant configure this today through the admin UI? No, but the
gap is narrower.** The registry descriptor (`lib/integrations/registry.js:87-102`)
declares four steps (`authorize`, `link_shops`, `map_products`, `verify`) and
notes: "Eleme merchant tokens live in the data-plane `eleme_tokens` table (per
store, inside the tenant's own DB), so `credKeys` can't see them from here —
baseline stays `not_configured` until an integration row is written in the Eleme
phase." What is missing: (a) the daemon does not loop tenants; (b) session files
are keyed by store code only, not `(tenant, store)`; (c) the OAuth flow in the
admin writes tokens the daemon does not use, so the wizard's "authorize" step
does not actually connect anything; (d) nothing writes
`tenant_integrations.health_json`.

## 2.9 Known fragility

**1. The whole RPC contract comes from one capture.**
`lib/eleme-browser.js:12-18`: "reverse-engineered from a single live network
capture (2026-08-23, shop 1304930646)… STOCK push (`FoodService2.updateFoodStock`)
is the one call captured payload-and-response, so it's the one this file trusts
fully; everything upstream of it is shape-agnostic on purpose."

**2. Method names are guesses with env escape hatches.**
`ORDER_LIST_METHOD`, `ORDER_INPROCESS_TAB` (`'ALL'` — "override without a code
change if the live error says otherwise", `:85-87`),
`ELEME_ORDER_DETAIL_METHOD`, `ELEME_ORDER_DETAIL_SERVICE`, `ELEME_ORDER_ROUTE`.
Five environment variables exist solely because the code does not know the real
contract.

**3. Order discovery is by regex over observed method names.**
`ORDER_LIST_RES`, `ORDER_DETAIL_RE`, `ORDER_VOID_RES`
(`lib/eleme-browser.js:59-77`). Priority is load-bearing and the comment records
why: `PollingService.nonCoreOrders` — "a summary/notice feed carrying only tab
counts — came to be read as the order list (live, 2026-08-24)". It is now
excluded by name.

**4. The order reader depends on the merchant SPA polling on its own.** The
"observe" rung reads what the page fetches. `ORDER_RESULT_MAX_AGE_MS` exists
because "a page that stopped polling would have its last snapshot re-read as
fresh on every poll forever — **new orders would simply never appear, silently,
with no error anywhere**" (`:88-92`).

**5. Cancels depend on a queue that may never be observed.**
`lib/eleme-browser.js:1639-1658`: if the refund/exception queue is not seen this
session, the log "says so once; the restock path simply stays dormant".

**6. Money units are ambiguous.** `ELEME_MONEY_SCALE=yuan|fen` with
auto-detection and an `ELEME_FEN_THRESHOLD`.

**7. Stock is written by NAME with no id fallback.** A rename on Eleme's side
terminally unresolves the product. `docs/eleme-findings.md` (quoted at
`lib/eleme-browser.js:820-823`) records: "Seven of them… sit one Eleme rename
away from a neighbouring listing whose name contains theirs (洗衣液 / 洗衣液※ and
five more like it)".

**8. The multi-size guess writes a number that is not the product's stock.**
`(N >= 3) ? 9999 : (i === 0 ? N : 0)` — see §2.4. Live for any listing with >1
size and no operator-mapped `spec_id`.

**9. Cross-origin frame identity.** The order frame must be the copy embedded in
the melody shell; the same app opened top-level answers `未登录`.

**10. Timing.** Non-atomic queue claim (§2.3); the 12 s observe window; the
`ksid` availability race; and the reuse of Meituan's proxy election means an
Eleme session's IP depends on the *Meituan* proxy watchdog's decisions.

---

# 3. GZGROCERY

Gzgrocery is not one integration. It is:

- **3A — Outbound stock**, through the **Guanyi ERP** (管易,
  `v2.guanyierp.com`), by browser automation.
- **3B — Inbound orders**, by a **pure-HTTPS scrape of gzgrocery's own
  OpenCart admin** (`gzgrocery.cn/admin/`).
- **3C — A legacy stock-drift pickup inference** inside the Guanyi daemon, which
  was the only sales signal before 3B existed and is now meant to be a shadow
  cross-check.
- **3D — One-off spreadsheet imports** for historical sales.

The decision recorded in `CHANNELS-LOGISTICS-PLUGINS-PLAN.md`: *"Guanyi /
gzgrocery (管易) — **Roots-only.** Stays out of the tenant-facing plugin list;
never generalized."*

## 3.1 Transport

**3A — Guanyi ERP (outbound stock).** Playwright browser automation
(`lib/guanyi-browser.js`), session-persisted, proxy-aware.
Host: `https://v2.guanyierp.com`. Endpoints:

| Purpose | Path |
|---|---|
| Product/stock list | `POST /stock/message/stock_tenant/data/list` |
| Validate an adjustment | `/stock/stock/stock_adjust_order_header/checkStockAdjust` |
| Create adjustment doc | `/stock/stock/stock_adjust_order_header/create` |
| List adjustment docs | `/stock/stock/stock_adjust_order_header/data/list` |
| Approve check | `/stock/stock/stock_adjust_order_header/approveCheck` |
| Approve | `/stock/stock/stock_adjust_order_header/approve` |

The write is **not** "set stock to N". `scripts/guanyi-daemon.js:5-7`: it
"reconcile[s] `guanyi_sync_queue` targets into Guanyi by creating an
inbound/outbound document for (target − current) and approving" — a 其他入库单 or
其他出库单.

**3B — OpenCart admin (inbound orders).** **No browser at all.**
`lib/gzgrocery-admin.js:9-12`: "This is a pure-HTTPS client (no headless
browser): OpenCart admin is server-rendered, so login + list + order-info are
plain form posts / GETs." Raw `node:https`, a hand-rolled cookie jar, and
**regex parsing of HTML**.

Host: `GZGROCERY_ADMIN_URL`, e.g. `https://www.gzgrocery.cn/admin/`. Routes
(query-param style, `index.php?route=…`):

| Purpose | Route |
|---|---|
| Login page / POST | `common/login` |
| Order list | `sale/order` |
| Order detail | `sale/order/info` |
| Dispatch note (ship-to address) | `sale/order/shipping` |

With a documented quirk (`lib/gzgrocery-admin.js:14-15`): "this OpenCart
resolves order sub-actions with a **SLASH** (`route=sale/order/info`), NOT a dot
(`sale/order.info` → Permission Denied)."

**3D** — `scripts/convert_gzgrocery_xlsx.js` converts a hand-downloaded `.xlsx`
into `scripts/gzgrocery_import.json` (1.1 MB, committed), which
`scripts/import_gzgrocery.js` loads into `sales_entries` with
`channel='gzgrocery'`. It opens `better-sqlite3` directly, bypassing
`database.js`.

## 3.2 Authentication

**3A — Guanyi.** Human login (account + password, SMS if asked). Session at
`data/guanyi-sessions/<store>-session.json`, **plaintext**
(`lib/guanyi-browser.js:29, 118`). Re-auth: `scripts/guanyi-login.js` headed —
reachable from the ops screen as `guanyi-tianhe`
(`ops/ops-screen/login-trigger.js:41-42`).

This is the only one of the three channels with **proactive session-expiry
management**:

- a health probe on a timer whether or not work is pending
  (`GUANYI_HEALTH_MS`, default 60 s), with `GUANYI_LOGIN_DOWN_GRACE` consecutive
  failures before paging;
- on-disk session refresh every 30 min (`GUANYI_SESSION_SAVE_MS`);
- an **advance expiry warning** at 72 h (`GUANYI_SESSION_WARN_MS`), re-sent every
  12 h, escalating in wording below 6 h — with a disk-backed `claimWindow` latch
  because on 2026-08-25 restarts made "the same advisory land in the ops group
  roughly every twenty minutes. Once an alert channel does that, it stops being
  read" (`scripts/guanyi-daemon.js:110-120`);
- an **auto-heal** (`GUANYI_AUTOHEAL`, default on) that re-pushes every mapped
  SKU whose Guanyi number disagrees with Tianhe after a recovery
  (`:645-720`), capped at `GUANYI_RESYNC_MAX_PER_CYCLE`.

All of this exists because of a documented month-long silent outage
(`docs/gzgrocery-findings.md`): "stock_push on gzgrocery failed ~78% (9,405
errors vs 2,620 ok) from 2026-06-24 to 2026-07-26… the ERP login session had
died and nothing re-authenticated, so every push failed silently for ~a month."

**3B — OpenCart.** `GZGROCERY_ADMIN_USER` / `GZGROCERY_ADMIN_PASS`, **plaintext
env vars** read in the constructor (`lib/gzgrocery-admin.js:33-35`). This is the
only channel of the three that holds a **reusable username and password** rather
than a browser session.

Login flow (`:88-107`): GET `common/login`, scrape `name="csrfToken" value="…"`,
POST `{username, password, csrfToken}`, then extract `user_token=([a-zA-Z0-9]+)`
from the redirect `Location`. Failure is classified by regexing the page body for
`/Warning|No match|incorrect|error/i` → "bad credentials", else "unexpected
response".

**Unattended re-login is ATTEMPTED here. Whether it WORKS is UNKNOWN — not
determinable from code.** `_looksLoggedOut(r)` (`:123-126`) checks for a 302 to
`route=common/login` or a login form in the body, and `_get` calls `login()` and
retries the request once (`:114-120`). This is the only one of the three channels
whose code attempts to re-authenticate without a human — but attempting is not
succeeding, and nothing in the tree establishes that it ever has:

- **No expiry has ever been recorded for this path.** No dated incident note, no
  findings entry, no known-issue. The only date in `lib/gzgrocery-admin.js`
  (`:199`, `2026-06-27`) is a date-format example inside a parser comment. The
  month-long session death in `docs/gzgrocery-findings.md` was the **Guanyi ERP**
  session (3A), recovered manually — a different system with different
  credentials.
- **A success would leave no trace.** `login()` is called silently from inside
  `_get()`. No console line, no `gzgrocery_order_log` action, no counter and no
  sync-log row records a re-login. Unlike the drift sweep and auto-heal (which
  write `drift_sweep` and `autoheal` rows), this path is unobservable either way.
- **On the default configuration it has never run at all.**
  `GZGROCERY_ORDER_MODE` defaults to `off`, at which `runCycle()` returns before
  the client is ever constructed (`scripts/gzgrocery-order-daemon.js:548`). The
  live value is not in the repository — see the open questions.
- **The retry is single-shot.** If the second attempt also comes back logged out,
  the parser receives a login page, returns zero rows, and the cycle reports
  "fetched 0 recent order(s)" — indistinguishable from a quiet day, and
  unalerted.

**What would need to be observed to settle it:** the live `GZGROCERY_ORDER_MODE`
value; whether the daemon's stdout or `gzgrocery_order_log` show any completed
cycles at all; and a deliberate session invalidation — clearing the cookie jar or
letting `OCSESSID` age out — with the following cycle watched to see whether it
recovers unaided.

## 3.3 Trigger + cadence

No webhooks.

| Loop | Value |
|---|---|
| **3A** Guanyi queue drain | `QUEUE_CHECK_MS = 10_000`, jittered |
| **3A** Session health probe | `GUANYI_HEALTH_MS`, default 60 s |
| **3C** Stock-drift sample | `GUANYI_RECONCILE_MS`, default 60 s |
| **3B** OpenCart order poll | `GZGROCERY_POLL_MS`, default 60 s |
| **3B** Order window | `GZGROCERY_SINCE_DAYS`, default 3; `GZGROCERY_MAX_PAGES`, default 5 |

**3B has a three-position mode switch** (`GZGROCERY_ORDER_MODE`):
`off` (default), `shadow` (log what it *would* decrement), `live`
(`scripts/gzgrocery-order-daemon.js:12-16`). **3C has the same switch**
(`GUANYI_PICKUP_MODE`: off/shadow/live).

**The two are mutually exclusive, by convention only.**
`scripts/gzgrocery-order-daemon.js:17-22`:

> ⚠ DOUBLE-COUNT GUARD: once this is in `live`, set `GUANYI_PICKUP_MODE=shadow`
> in the guanyi-sync daemon. Otherwise, when gzgrocery later fulfills and the
> Guanyi number finally drops, the drift detector would decrement the SAME sale
> a second time.

Nothing in the code enforces this. It is two env vars on two processes and a
comment.

**Gating:** 3B honours `channel_status` for `('gzgrocery','tianhe')`
(`scripts/gzgrocery-order-daemon.js:552`). **Neither gzgrocery daemon reads
opening hours** — `lib/channel-sync-stale.js:41-43` records this explicitly:
"this channel has no open-hours concept anywhere in its code today (GZ
Grocery/Guanyi never reads store hours)".

**Concurrency:** 3A is a `while (true)` loop; 3B is a `while` loop with
`await sleep(POLL_MS)` (`:620-629`). **No locks.** 3A's queue claim is the same
non-atomic select-then-update (`scripts/guanyi-daemon.js:214` then `:261`).
There is no skip-store convention because there is only ever one store.

## 3.4 Direction and payload

### Inbound (gzgrocery → roots-v2)

**Objects:** orders; order status; cancellations/refunds (as status transitions);
line items; customer name; ship-to recipient/phone/address (from the dispatch
note); order total; delivery time. **No prices per line into our money model** —
the mirror rows are display-only.

**Status handling is a configurable string set**, not a mapping
(`scripts/gzgrocery-order-daemon.js:57-62`):

```js
const ACTIVE = new Set((process.env.GZGROCERY_ACTIVE_STATUSES ||
  'Paid,Processing,Shipped,Complete,Completed,Partially Shipped,已支付,待处理,已审核,部分发货,全部发货,已完成').split(',')…);
const VOID = new Set((process.env.GZGROCERY_VOID_STATUSES ||
  'Canceled,Cancelled,Denied,Refunded,Reversed,Chargeback,Expired,Voided,Failed,已取消,退款中,支付失败').split(',')…);
```

A status in **neither** set is silently treated as "waiting" and never
decrements.

**Product matching** — `extractSku`, `lib/gzgrocery-admin.js:329-339`, the
matching code the brief asks to be quoted:

```js
function extractSku(...fields) {
  for (const f of fields) {
    const gv = /\bGVF?\s*[·\- ]?\s*(\d+-\d+[A-Za-z]?)\b/i.exec(String(f || ''));
    if (gv) return gv[1].toUpperCase();
  }
  for (const f of fields) {
    const m = /\b(\d+-\d+[A-Za-z]?)\b/.exec(String(f || ''));
    if (m) return m[1].toUpperCase();
  }
  return null;
}
```

Its own header (`:319-328`) states the contract: our products carry the SKU in
the Chinese **Model** field, always prefixed `GV`/`GVF` (GoVegan / GoVegan
Fresh) — `"GVF 1-310 甜菜根沙拉"`. It is called with the Model field **only**:
`const sku = extractSku(it.model); // Model field only — see extractSku notes`
(`scripts/gzgrocery-order-daemon.js:441`), because "the English product name is
the false-positive source and must not be scanned".

The extracted token is then looked up in a map built from
`store_products.sku`, with a canonical-wins rule
(`scripts/gzgrocery-order-daemon.js:138-156`):

```js
    // The same numeric code can appear on a canonical product ('3-251') AND on a
    // wrapped "sample" twin ('S(3-251)'). The canonical SKU — where the whole SKU
    // IS the code — must win, otherwise a later-iterated twin clobbers the real
    // product and orders decrement (and mis-price) the wrong row.
    const canonical = raw.toUpperCase() === key;
```

**Stock effect:** direct `adjustStock({ storeId, productId, newPhysicalQty: next,
actorLabel: 'gzgrocery-order', reason: 'gzgrocery_order' })`
(`:495-501`) — computed as `Math.max(0, cur - it.qty)`, a **read-then-write, not
an atomic decrement**. Reversal on void is `cur + it.qty` (`:522-528`).

**Display mirror:** `ensureGzMirror` writes a `retail_orders` row with
`order_no = 'GZ-<orderId>'` and `channel='gzgrocery'`, described as
"DISPLAY-ONLY… the dashboard folds in [the Guanyi/order-read ledger] and…
excludes `channel='gzgrocery'` from its retail_orders sums"
(`:163-172`).

**HTML parsing surfaces** (`lib/gzgrocery-admin.js`): `/<tr[^>]*>([\s\S]*?)<\/tr>/gi`
for both the list (`:148`) and the detail (`:225`); `order_id=(\d+)…(?:View|查看)`
(`:152`); `(\b\d{12,}\b)` for the order number (`:164`);
`[￥¥]\s?([\d,]+\.?\d*)` for the total (`:165`); two date shapes
`dd/mm/yyyy` and `yyyy-mm-dd` (`:200-202`); and for the ship-to,
`Shipping Address:([\s\S]*?)<\/td>`, `Contacter:\s*([^<\n]*)`,
`Telephone:\s*([^<\n]*)` and a trailing 6-digit postcode
(`:267-298`) — i.e. **English UI label text**.

### Outbound (roots-v2 → gzgrocery, via Guanyi)

**Objects: stock quantity only**, as a delta document.

`enqueueChannelSync` → `lib/guanyi-sync.js` `enqueueProductStock` →
`guanyi_sync_queue` (absolute target) → daemon reads Guanyi's current qty →
creates an inbound/outbound doc for the difference → approves it.

**Matching** — `skuFromGuanyiName`, `routes/guanyi-admin.js:23-26`:

```js
function skuFromGuanyiName(name) {
  const m = String(name || '').match(/(\d+)\s*-\s*(\d+)/);
  return m ? `${m[1]}-${m[2]}` : null;
}
```

Note this is a **different regex from `extractSku`** for the same job: no
`GV`/`GVF` preference, no optional trailing letter, and it tolerates spaces
around the hyphen. Auto-match binds only unambiguous SKUs
(`routes/guanyi-admin.js:158-190`); the resolved Guanyi ids
(`guanyi_sku_id`, `guanyi_item_id`, `guanyi_item_sku_id`, `guanyi_code`) are
cached on `guanyi_product_map` so the daemon writes without re-resolving.

### 3C — Stock-drift pickup inference (still live)

`scripts/guanyi-daemon.js:66-84` and `:400-610`. Samples Guanyi's on-hand every
`GUANYI_RECONCILE_MS`, diffs against a stored `guanyi_pickup_baseline`, and
treats a drop as a sale. Guards: `GUANYI_PICKUP_CAP` (default 50 — a bigger drop
is *flagged*, not applied), `GUANYI_SETTLE_TIMEOUT_MS` (default 180 s — gives our
own push time to settle before trusting drift), `GUANYI_MAX_DROPS_PER_CYCLE`, a
"bad-read guard" that refuses to act on a partial listing read, and
`GUANYI_GUARD_RESYNC_AFTER` (default 5 identical trips before the reading is
accepted as truth). Flagged drops queue for operator Apply/Ignore at
`GET /api/retail-admin/guanyi/pickups`.

## 3.5 Idempotency + deduplication

**3B — inbound orders.** The external id is the OpenCart order id, and it is the
**primary key** rather than a `UNIQUE` on a surrogate — the only one of the three
channels shaped this way. Created **inside the daemon**, not in `database.js`
(`scripts/gzgrocery-order-daemon.js:71-90`):

```sql
CREATE TABLE IF NOT EXISTS gzgrocery_orders (
  order_id      INTEGER PRIMARY KEY,
  order_no      TEXT,
  status        TEXT,
  total         REAL,
  customer      TEXT,
  date_added    TEXT,
  delivery_time TEXT,
  items_json    TEXT,          -- [{product,model,sku,qty,product_id,matched}]
  our_units     INTEGER DEFAULT 0,
  decremented   INTEGER DEFAULT 0,
  reversed      INTEGER DEFAULT 0,
  mode          TEXT,
  note          TEXT,
  first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

Double-decrement is prevented by the `decremented` / `reversed` flags, not by the
key: `if (isActive && !alreadyDecremented)` and
`if (isVoid && alreadyDecremented && !alreadyReversed)` (`:488`, `:514`).

Plus a **cold-start baseline**: `gzgrocery_meta.baseline_order_id` is seeded on
first run to the highest existing order id, and everything at or below it is
never decremented (`:106-121`) — because those sales were already counted by 3C.

**3A — outbound stock.** Absolute target diffed against Guanyi's live number, so
a pile-up of queue rows cannot double-apply (`lib/guanyi-sync.js:12-16`).

**But `lib/guanyi-sync.js` has no `refreshPending`.** Meituan and Eleme both
collapse a pending row in place before inserting; Guanyi inserts a new row on
every stock change (`lib/guanyi-sync.js:26-31`). Nothing collapses them at drain
time either — `processStockQueue` has no `latest`/`superseded` map, unlike its
two siblings.

**No external-id ledger exists for the outbound side** on any of the three
channels — Guanyi's created adjustment documents are not recorded against a
roots-side idempotency key.

## 3.6 Error handling

**3A — Guanyi.** 3 attempts via `retryOrFail`
(`scripts/guanyi-daemon.js:191-200`):

```js
function retryOrFail(storeCode, row, retryError, logDetail, terminalError) {
  const r = db.prepare(`SELECT attempts FROM guanyi_sync_queue WHERE id=?`).get(row.id);
  const attempts = r ? r.attempts : 99;
  if (attempts < 3) { … }
```

Notable branches: `no guanyi mapping` → **immediate terminal `'error'`**
(`:243`); `系统异常` → retryable until attempts run out (`:325-327`);
still-processing rows on a batch throw → kept retryable if `attempts < 3`
(`:335-340`). No backoff, no dead-letter. The auto-heal (§3.2) is the closest
thing to Meituan's drift sweep — but it only runs after a *recovery*, not on a
timer. Like the drift sweep and unlike the OpenCart re-login, it is observable
(`autoheal` rows in `guanyi_sync_log`, `scripts/guanyi-daemon.js:664-668`;
invoked at `:799`); whether it has fired is a log query this audit did not run.

**3B — OpenCart.** This is the outlier. `scripts/gzgrocery-order-daemon.js`:

- **Zero `sendOpsAlert` calls.** (Meituan 17, 闪购 8, Eleme 7, Guanyi 7.)
- **No retry counter, no attempts column, no queue at all.** The reconciler is
  idempotent and simply re-runs on the next 60 s cycle; a failure is a
  `console.log` line and a `gzgrocery_order_log` row.
- Auth failure → `throw new Error('gzgrocery login failed: …')` from the client;
  the cycle logs and sleeps.
- A `Permission Denied` on `sale/order/info` throws with a specific message
  (`lib/gzgrocery-admin.js:211`).
- Network timeout → `req.destroy(new Error('timeout after Nms'))`,
  `GZGROCERY_HTTP_TIMEOUT_MS` default 25 s.
- Malformed HTML → the regexes return nothing; the order is recorded with
  `our_units: 0` and skipped as foreign. **An HTML change that breaks the Model
  column makes every order look like it contains no Roots products, and nothing
  distinguishes that from a genuinely foreign order.**

**Loudness.** 3A pages WeCom on session death, session expiry approaching, proxy
outage, and recovery. 3B pages **nothing** — its only outbound signal is
`lib/gzgrocery-order-notify.js`, which is a *per-order feed* to a separate WeCom
group (`gzgrocery_orders.wecom_webhook`), not an alerting channel; it is
fire-and-forget and silently no-ops when unset.

## 3.7 Observability

**Logged:**
- `guanyi_sync_log` — 3A events.
- `guanyi_pickup_log` — 3C, with `resolved` / `resolution` / `resolved_at`.
- `gzgrocery_orders` (current state per order) and `gzgrocery_order_log`
  (append-only actions) — 3B.
- pm2 stdout for both.
- **No retention policy on any of them.**

**Admin UI.** `public/retail-admin/12-guanyi.js` — **533 lines, a quarter the
size of the Meituan tab and a third of Eleme's.** `GET
/api/retail-admin/guanyi/status` (`routes/guanyi-admin.js:229-244`) returns only
`queuePending`, `queueError` (all-time), `mappedCount` and the last 20 log rows.
There is **no last-order field, no oldest-pending age, no per-store health
block** — the three things Meituan's status endpoint adds. There is a richer
pickups surface (`/guanyi/pickups`, `/pickups/:id/apply`, `/pickups/:id/ignore`)
and an analytics panel.

**3B has no admin UI at all.** Grepping the tree, `gzgrocery_orders` and
`gzgrocery_order_log` are referenced by **no route and no front-end file** —
only by the daemon that writes them and by
`lib/gzgrocery-order-notify.js` (which reads *config*, not the tables). The only
places a gzgrocery order becomes visible in the admin are (a) the display-only
`retail_orders` mirror rows in the combined Orders list, and (b) the WeCom feed.

**Dashboard:** included in `lib/channel-sync-stale.js` as
`{ key: 'guanyi', label: 'GZ Grocery', queueTable: 'guanyi_sync_queue',
hoursAware: false, openGraceMin: 0 }` — so the stale row covers **3A only**.

**Could an operator answer "did gzgrocery sync in the last hour, and did anything
fail?" without a terminal? — Partially, and not for orders.**
- For **outbound stock (3A)**: yes — the Guanyi tab shows pending/error counts
  and the last 20 log lines, and the dashboard raises a stale row.
- For **inbound orders (3B)**: **no.** There is no last-poll timestamp, no error
  count, no health tile, no admin route, and no alert. The only evidence a poll
  ran is a WeCom card *if* an order containing Roots products happened to arrive
  *and* the webhook is configured. An hour of total silence from 3B is
  indistinguishable from an hour with no orders.

## 3.8 Multi-tenancy readiness

**Hardcoded to Roots by design and by declaration.** Beyond the plan doc's
"never generalized", the code:

| Location | Constant |
|---|---|
| `routes/guanyi-admin.js:18` | `GUANYI_STORE_CODE = process.env.GUANYI_STORE_CODE \|\| 'tianhe'` |
| `scripts/guanyi-daemon.js:73` | same default |
| `scripts/gzgrocery-order-daemon.js:52` | `STORE_CODE = process.env.GZGROCERY_STORE_CODE \|\| 'tianhe'` |
| `scripts/gzgrocery-order-daemon.js:552` | `WHERE channel='gzgrocery' AND store_code='tianhe'` — **literal, no env** |
| `scripts/gzgrocery-order-daemon.js:483` | `upsert({ note: 'no Roots products' })` |
| `scripts/gzgrocery-order-daemon.js:605` | log line counts `non-Roots` |
| `lib/gzgrocery-admin.js:331` | `/\bGVF?\s*…/` — **the GoVegan brand prefix is compiled into the matcher** |
| `lib/gzgrocery-admin.js:59` | `'User-Agent': 'roots-gzgrocery-sync/1.0'` |
| `routes/meituan-admin.js:1078, 1122, 1175, 1205` | `gzgrocery` is filtered to `code === 'tianhe'` in the channel matrix, and `POST /channel-status/cell` returns `'gzgrocery is tianhe-only'` |
| `database.js:4808` | schema comment: `store_code TEXT NOT NULL, -- retail_stores.code (gzgrocery: 'tianhe' only)` |
| `scripts/guanyi-daemon.js` (throughout) | the column and variable name is literally `tianhe_qty` — in the schema of `guanyi_pickup_log` (`:55`), in queries (`:411`, `:654`), and in log text (`:597-604`) |
| env | `GUANYI_WAREHOUSE_ID` — a single warehouse |

**Not in the tenant registry at all.** `lib/integrations/registry.js`
`DESCRIPTORS` (`:66-145`) lists `wechat_miniapp`, `web`, `eleme`, `meituan`,
`jd`, `qingyun`. There is **no `gzgrocery` or `guanyi` descriptor**, so it has no
card, no wizard, no steps, no `capsSection`, and no `tenant_integrations` row.

**Could a second tenant configure this today through the admin UI? No, and it is
not intended to be possible.** Making it so would require: a registry
descriptor and wizard; replacing the `GV`/`GVF` regex with per-tenant
configuration; replacing `tianhe` literals and the `tianhe_qty` column name;
moving `GZGROCERY_ADMIN_USER`/`PASS` into `tenant-creds`; a per-tenant OpenCart
base URL; and a rename of the `guanyi_*` tables (which
`docs/gzgrocery-findings.md` already schedules: "guanyi_* tables get renamed to
gzgrocery_erp_*/gzgrocery_shop_* [at the Postgres migration]").

## 3.9 Known fragility

**1. HTML structure (3B).** Every field is a regex over server-rendered
OpenCart HTML — see the list in §3.4. A theme change, a column reorder, or a
plugin that wraps a cell breaks parsing **silently**: the order records with
`our_units: 0` and is classified as foreign.

**2. English UI label text (3B).** `Shipping Address:`, `Contacter:`,
`Telephone:`, and `View|查看` in the list. If the admin's language is switched,
ship-to extraction stops.

**3. The `GV`/`GVF` brand prefix (3B).** `extractSku`'s authoritative arm is
`/\bGVF?\s*[·\- ]?\s*(\d+-\d+[A-Za-z]?)\b/i`. The fallback arm
`/\b(\d+-\d+[A-Za-z]?)\b/` will match any `N-M` token; the file names the hazard
("weights (700-800g)… dates (best before 2026-10)") and relies on the caller
gating on our SKU map.

**4. Status label sets (3B).** Two comma-separated env lists of literal English
*and* Chinese strings. A status gzgrocery adds — or renames — falls into neither
set and the order silently never decrements. There is no "unknown status"
counter or alert.

**5. The OpenCart route quirk (3B).** Slash vs dot; a platform upgrade that
normalises this breaks every detail read with "Permission Denied".

**6. The `user_token` / `csrfToken` scrape (3B).** Both are extracted by regex
from HTML; the success test is `user_token=([a-zA-Z0-9]+)` appearing in a
redirect `Location`.

**7. Guanyi's document workflow (3A).** The push is create-then-approve across
six endpoints. A change to the approval flow, to `checkStockAdjust`'s response,
or to warehouse permissions breaks the write. `系统异常` is matched as a literal
string.

**8. The SKU-in-the-name convention (3A).** Guanyi's own code is *not* our SKU;
our SKU is embedded in the Guanyi product name (`"GVF 1-180 …"`). `database.js:1043-1046`
states this explicitly. A rename in Guanyi that drops or reformats the token
breaks auto-match.

**9. Ordering dependence (3A).** `skuFromGuanyiName` takes the **first**
`\d+-\d+` in the string: *"Combo names carry extra tokens ('… + 1-320 D 酱') but
the FIRST match is always the product's own"* (`routes/guanyi-admin.js:20-22`).
That is an assumption about how gzgrocery names combos.

**10. Timing / race windows.**
- **The 3B/3C double-count window is guarded only by two env vars on two
  processes** (§3.3). Nothing in the code prevents both being `live`.
- 3C's whole premise is a timing inference: a drop in Guanyi's number *means* a
  sale, unless it was our own push not yet settled — hence
  `GUANYI_SETTLE_TIMEOUT_MS` (180 s) and the `settle_pending` / `settle_target`
  columns.
- 3B's decrement is `curQty()` read, then `adjustStock(newPhysicalQty)` write —
  not atomic, and it runs concurrently with 3A's daemon and the web server.
- Guanyi's queue drain has the same non-atomic claim as the other two.

**11. Undocumented behaviour, by definition.** Both Guanyi's admin API and
gzgrocery's OpenCart admin are third-party back-offices with no contract with
us; gzgrocery's is a **third party's** system, not even a platform we have a
merchant relationship with.

---

# COMPARISON

Every row is one of the dimensions above. "闪购" is called out separately where
Meituan's two halves differ.

| Dimension | **Meituan** | **Eleme** | **Gzgrocery** |
|---|---|---|---|
| **Transport** | Browser automation → private JSON endpoints, signed in-page by H5guard. 外卖: headless Playwright. 闪购: CDP-attach to a real Chrome under Xvfb (Playwright is 403'd). | Browser automation → JSON-RPC gateway (`ncp` envelope), from inside the melody shell iframe. | **3A** browser automation → Guanyi ERP document API. **3B** pure `node:https` + HTML regex against gzgrocery's OpenCart admin. **No browser.** |
| **Hosts** | `e.waimai.meituan.com`, `waimaie.meituan.com`, `shangoue.meituan.com`, `verify.meituan.com`, `passport.meituan` | `melody.shop.ele.me`, `napos-goods-pc.faas.ele.me`, `napos-order-pc.faas.ele.me`, `app-api.shop.ele.me` | `v2.guanyierp.com`, `www.gzgrocery.cn/admin/` |
| **Official API used?** | No (none exists for this) | **No — but a complete OAuth client and live callback routes exist unused** | No (neither is an API) |
| **Auth credential** | Human login → `storageState` JSON | Human login → `storageState` JSON | **3A** human login → `storageState` JSON. **3B** username + password |
| **Credential storage** | `data/meituan-sessions/*.json`, **plaintext**. Env user/pass read but **never used**. `tenant-creds` AES keys exist, **unused**. | `data/eleme-sessions/*.json`, **plaintext**. `eleme_tokens` table (**plaintext columns**) written by OAuth, **unused**. | **3A** `data/guanyi-sessions/*.json`, plaintext. **3B** `GZGROCERY_ADMIN_USER`/`PASS`, **plaintext env** |
| **Expiry detection** | Dashboard-iframe probe + a separate "store binding lost" state | `ensureLoggedIn` + `ksid` wait | **3A** 60 s health probe + 72 h advance expiry warning. **3B** `_looksLoggedOut()` on every request |
| **Re-auth** | **Human**, from the ops screen (phone) | **Human**, laptop with a display + `scp`. **No ops-screen entry.** | **3A** human, ops screen. **3B** unattended re-login **attempted**; never observed to succeed, and unobservable by design (§3.2) |
| **Trigger** | Poll + edge-triggered queue + admin buttons + job tables | Poll + edge-triggered queue + admin buttons | **3A** edge-triggered queue + admin buttons. **3B** poll only. **3C** poll only |
| **Order poll interval** | 300 s ±40% (外卖) / 120 s (闪购); +30 min trailing sweep over 3 days | ~5 min; page-observe with a 10 min re-nav and a 120 s freshness ceiling | **3B** 60 s over 3 days × 5 pages |
| **Stock queue drain** | 10 s | 10 s | 10 s |
| **Backstop sweep** | **Yes** — 30 min drift sweep + 120 min stall canary + stranded-`processing` recovery | **None** | **3A** auto-heal, but only after a recovery, not on a timer. **3B** n/a — the reconciler re-derives state each cycle, so it needs no backstop *provided the read succeeds*; a read that silently returns a login page instead looks like a quiet day |
| **Open-hours gating** | Yes (+15 min grace) | Yes (+30 min grace) | **No — neither daemon reads store hours** |
| **Self-overlap** | Sequential loop; safe in-process | Sequential loop; safe in-process | Sequential loops; safe in-process |
| **Cross-process lock** | **None.** Two daemons share the tables; separated only by `MEITUAN_SKIP_STORES` / `SHANGOU_STORES` env | **None.** `ELEME_SKIP_STORES` convention | **None.** 3B and 3C double-count guard is **two env vars and a comment** |
| **Queue claim atomicity** | Non-atomic select-then-update | Non-atomic select-then-update | Non-atomic select-then-update |
| **Inbound objects** | Orders, status, voids, line prices, fee split, rider, masked customer + geo, invoice, note, cutlery, ETA, 预订单 | Orders, status, voids, line prices, commission + merchant income, note, cutlery, ETA, 预订单. **No rider, no geo, no invoice** | **3B** orders, status, voids, line items, customer name, ship-to address/phone, total, delivery time. **3C** inferred sales only |
| **Inbound item source** | **Clipboard copy-text blob**, whitespace-split (structured rows ride along as a sidecar for prices only) | Structured RPC rows | **3B** HTML table cells |
| **Inbound matching** | claim → SKU token (incl. `\d+-\d+` scraped from the name) → map-name exact, else unambiguous substring → unique `LIKE %cjk%` | claim → `item.sku` → map-name exact, else unambiguous substring → unique `LIKE %cjk%` (**same code, copied**) | `extractSku(model)` — `GV/GVF`-prefixed token preferred, then any `\d+-\d+` — into an exact SKU map with a canonical-wins rule. **No name matching at all** |
| **Outbound objects** | Stock qty; shop open/closed; (gated-off) order accept | **Stock qty only** | **Stock qty only** (as a delta document) |
| **Outbound matching** | 外卖: **name, exact** via `searchSugByName` + category click. 闪购: **货号**, auto-mapped hourly | **Name, exact** against a cached catalogue. `sku` accepted and ignored | SKU embedded in the Guanyi **name**, extracted by a *different* regex from the inbound one |
| **Multi-size handling** | `spec_key` / `meituan_sku_id` claims; a mapped spec is the target | operator `spec_id`, else single-spec, else **a documented guess** (`N>=3 ? 9999 : …`) | n/a — one warehouse row per SKU |
| **Order dedupe key** | `meituan_order_import.meituan_order_no TEXT UNIQUE` | `eleme_order_import.eleme_order_id TEXT UNIQUE` | `gzgrocery_orders.order_id INTEGER PRIMARY KEY` (+ `decremented`/`reversed` flags, + a cold-start baseline id) |
| **Where the dedupe table is declared** | `database.js` | `database.js` | **inside the daemon** (`ensureTables()`) |
| **Stock-dedupe design** | Absolute target + per-cycle collapse to latest + enqueue-time in-place update | Absolute target + per-cycle collapse + enqueue-time `refreshPending` | Absolute target diffed against live. **No enqueue-time collapse, no drain-time collapse** |
| **Void restock guard** | `channel_stock_restored`, once-only, with re-deduct on revive; `bornVoid` skip | same | `reversed` flag, once-only |
| **Retry policy** | 3 attempts, no backoff, terminal thereafter; attempts *refunded* for binding-loss and verification cool-down | 3 attempts, no backoff, terminal thereafter; attempts refunded for transient | **3A** 3 attempts, no backoff. **3B** no attempts concept at all |
| **Dead-letter** | None | None | None |
| **Terminal rows recoverable?** | **By design yes**, via the drift sweep (observable as `drift_sweep` log rows; frequency not checked here) | **No** | **3A** only via auto-heal after a recovery. **3B** n/a |
| **Ops alerts (`sendOpsAlert` count)** | **17** (外卖) + **8** (闪购) | **7** | **3A: 7. 3B: 0** |
| **Sync log table** | `meituan_sync_log` | `eleme_sync_log` | `guanyi_sync_log`, `guanyi_pickup_log`, `gzgrocery_order_log` |
| **Log retention** | None | None | None |
| **Admin tab size** | 2141 lines | 1405 lines | 533 lines (Guanyi only) |
| **Status endpoint fields** | pending, failed (1-day), **oldest-pending age**, 25 stock, 6 system, 5 orders, per-store health, mapped | pending, error (all-time), 25 stock, 8 system, 5 orders, per-store health, mapped | pending, error (all-time), 20 logs, mapped — **no last-order, no age, no per-store health** |
| **In the dashboard stale-row registry?** | Yes (hours-aware, 15 min grace) | Yes (hours-aware, 30 min grace) | Yes for **3A only** (wall-clock, 0 grace). **3B not covered** |
| **"Did it sync in the last hour and did anything fail?" without a terminal** | **Yes** | **Yes** (no oldest-age on the tab; dashboard covers it) | **Stock: yes. Orders: no** — 3B has no route, no UI, no alert |
| **Tenant registry descriptor** | Yes, 6 steps | Yes, 4 steps | **None** |
| **Store list source** | `retail_stores` (data-driven) + env skip lists | `retail_stores JOIN eleme_shops` — **fully data-driven, zero store literals** | `'tianhe'` literals and env defaults throughout |
| **Hardcoded business strings** | `tianhe`/`yuexiu` hours fallbacks, `MEITUAN_PROXY_CHANNEL='tianhe'`, `readActive('yuexiu')` **literal**, `SHANGOU_WMPOIID`/`REGION_ID` | **None found** (only a recon shop id in comments) | `'tianhe'` (several, one with no env override), `tianhe_qty` **as a column name**, `GV`/`GVF` **in the matcher**, `'no Roots products'`, `roots-gzgrocery-sync/1.0` UA |
| **Second tenant via admin UI today** | No — needs tenant-looping daemons, per-tenant sessions, a real relay driver, health write-back | No — needs tenant-looping daemons, per-tenant sessions, and the OAuth wizard step to actually connect something | No — and explicitly out of scope by decision |
| **Depends on HTML/DOM** | Yes: category label text; `acceptOrder` DOM click (gated off) | No DOM; depends on RPC method names and frame identity | **3B: entirely.** 3A: no |
| **Depends on free text** | **Heavily**: copy-text blob, `已隐藏`/`合计`, note markers, status labels, `套餐` in an error message | Status labels; method-name regexes | **3B**: English UI labels, status string sets |
| **First appeared (schema comment)** | 2026-06-22 | 2026-06-28 | 2026-06-24 (Guanyi); order daemon later |
| **Distinct dated in-code notes** | 14 dates, 2026-05-17 → 2026-08-26 | 3 dates, all 2026-08-23 → 08-25 | 5 dates, 2026-06-27 → 2026-08-28 |
| **Findings doc size** | 121 KB | 57 KB | **1.4 KB** |

---

# WHAT THE DIFFERENCES ARE

## Forced by the channel

These are differences the code documents a concrete external cause for.

1. **闪购 uses CDP-attach to a real Chrome instead of Playwright.**
   `scripts/shangou-daemon.js:3-6`: 闪购's "data APIs reject Playwright's
   automation fingerprint with 403". Forced.

2. **Meituan is split into two daemons at all.**
   Same comment: "yuexiu was force-migrated by licensing from 外卖 to 闪购".
   The *split* is forced. (Whether it needed two 1000+ line files is a separate
   question — see below.)

3. **Eleme uses a browser instead of its official OpenAPI.**
   `lib/eleme-browser.js:7-8`: "Eleme's official OpenAPI rejects our single-store
   accounts ('暂不支持该账户登录')". Forced — and evidenced, since the OAuth client
   was built first and then abandoned.

4. **Eleme reads voids from a separate queue.**
   `lib/eleme-browser.js:68-71`: "a cancelled or refunded order LEAVES the
   in-process list — it just stops being mentioned, which is indistinguishable
   from completion". Forced by Eleme's list semantics.

5. **Eleme's "observe the page's own fetch" rung.**
   `:39-42`: the orders app "opened as a top-level tab… answers UNAUTHORIZED
   未登录 to every order RPC, including the ones the page fires for itself". You
   cannot simply call the endpoint. Forced.

6. **闪购 matches by 货号 while 外卖 matches by name.**
   `scripts/shangou-daemon.js:682-686`: 闪购 exposes `sourceFoodCode`;
   `lib/eleme-browser.js:827-829` and `scripts/eleme-daemon.js:528` record that
   Eleme's items "carry no extCode". The available join key genuinely differs per
   platform. Forced.

7. **Guanyi's push is a create-and-approve *document*, not a stock set.**
   `database.js:1039-1041`. That is how an ERP models a stock change. Forced.

8. **Gzgrocery's inbound is an HTML scrape.** gzgrocery is a *third party's*
   OpenCart storefront; we have an admin account, not an API. Forced.

9. **Gzgrocery has no open-hours gate.** `lib/channel-sync-stale.js:41-43` —
   it is a wholesale/pickup relationship with no trading window. Reasonable, and
   the shared module encodes it rather than inventing a definition.

10. **The 3B cold-start baseline.** Orders before the daemon existed were
    already counted by 3C, so they must not be re-counted. Forced by the
    migration, not by the platform — but genuinely necessary.

11. **Meituan's slow, jittered poll and the whole fingerprint apparatus.**
    Meituan actively detects automation (`verify.meituan.com` is a first-class
    state). Forced.

## Historical accident

These have no external cause visible in the code.

1. **Three near-identical `normName` functions.** `routes/meituan-internal.js:32-38`
   and `routes/eleme-internal.js:52-58` are byte-identical; neither imports the
   other. `lib/meituan-browser.js:1347` has a third, different normaliser for
   category labels.

2. **Two different SKU-extraction regexes for the same gzgrocery SKU
   convention.** `lib/gzgrocery-admin.js:329-339` (`GV`/`GVF`-aware, optional
   trailing letter, `\b`-anchored) and `routes/guanyi-admin.js:23-26`
   (whitespace-tolerant, no brand prefix, no letter suffix). Same SKU space, same
   business, two rules, written at different times for the inbound and outbound
   halves of the same channel.

3. **`lib/guanyi-sync.js` has no `refreshPending` and the Guanyi drain has no
   supersede-collapse**, while both Meituan and Eleme have both. `lib/eleme-sync.js:22-28`
   spells out what the absence costs. Nothing about Guanyi requires the
   difference — it simply never got the fix.

4. **Eleme has no drift sweep.** Meituan's `lib/meituan-drift-sweep.js` header
   (`scripts/meituan-daemon.js:70-78`) describes a problem — "a push that dies
   terminally leaves that product frozen… with nothing left to retry it" — that
   `docs/eleme-findings.md` finding 1 confirms is identical on Eleme. It was
   fixed on one channel.

5. **`gzgrocery_orders` / `gzgrocery_order_log` / `gzgrocery_meta` are declared
   inside the daemon** while every other channel's tables are in `database.js`.
   Consequence: they are invisible to `lib/tenant-db.js`'s schema cloner, which
   reads `sqlite_master` of the main DB.

6. **Three status-classification styles.** Meituan and Eleme both use ordered
   Chinese regexes (`internalStatusForChannel`, written twice); gzgrocery uses two
   comma-separated env string sets. Nothing about gzgrocery's statuses demands a
   different shape.

7. **Eleme has no ops-screen entry.** `ops/ops-screen/README.md:8` says the
   screen was built after "a Guanyi outage where re-login took ~40 minutes,
   almost all of it installing tooling on a laptop" — which is *exactly* Eleme's
   current situation. Adding it is "one entry in its `JOBS` map"
   (`README.md:35`). It was simply not done.

8. **The Guanyi admin tab lacks last-order, oldest-pending-age and per-store
   health**, all of which Meituan's has and Meituan's comments explain the need
   for ("a stuck queue and a busy one are the same number on the screen — which
   is how a 19-hour stock freeze presented as '107 sending…'",
   `routes/meituan-admin.js:487-491`). The same defect is live on the Guanyi tab.

9. **`queueFailed` is scoped to the last day on Meituan and all-time on Eleme
   and Guanyi.** The reasoning for scoping is written out at
   `routes/meituan-admin.js:479-486`; it was not carried across.

10. **The 3B order daemon has zero ops alerts**, while its own channel's other
    daemon has seven — and `docs/gzgrocery-findings.md` names "no alerting" as one
    of the two root defects of the month-long outage. The lesson was applied to 3A
    and not to 3B.

11. **3B has no admin surface whatsoever** while every other inbound path has a
    read-only order ledger route (`/meituan/orders`, `/eleme/orders`).

12. **The dead OAuth path is still mounted.** `lib/eleme-client.js`,
    `eleme_tokens`, `GET /api/retail-admin/eleme/oauth/start` and
    `GET /eleme/oauth/callback` are live routes that write tables nothing reads,
    while `scripts/eleme-daemon.js:8-9` says the client is dead.

13. **Dead credential reads.** `scripts/meituan-daemon.js:555-556` reads
    `MEITUAN_<CODE>_USER/PASS` into fields nothing consumes, behind a filter
    (`.filter(s => s.meituanUser || true)`) that is unconditionally true.

14. **`lib/tenant-creds.js` defines encrypted `meituan.<code>.user/pass` keys
    that no daemon reads.**

15. **Stale comments that contradict the code**:
    `scripts/meituan-daemon.js:906-907` ("matches the list row by substring" —
    it no longer does) and `database.js:5132-5134` ("most products auto-map by
    SKU" on Eleme — they do not).

16. **`readActive('yuexiu')` as a literal** at `scripts/shangou-daemon.js:126`,
    where every sibling call passes a store code.

17. **Meituan and Eleme both drive a shared 15/30-minute grace window and a
    3-minute stale threshold from `lib/channel-sync-stale.js`, but Meituan
    *also* has `lib/meituan-queue-stall.js` with a 120-minute threshold.** The
    former's header (`:9-17`) argues the duplication is intentional; the two
    numbers are nonetheless 40× apart on the same question.

## Where the same job is done three different ways

1. **"Which of our products is this channel line?"** — three implementations:
   - Meituan: `matchProductForLine` (claim → sku-token → map-name exact/unambiguous-substring → `LIKE %cjk%`)
   - Eleme: `matchProductForLine` — a near-copy of the above, minus the token scrape
   - Gzgrocery: `extractSku` + an exact SKU map with canonical-wins
   Three files, three behaviours, one question.

2. **"Which channel listing is this product?"** (outbound) — four:
   Meituan 外卖 by exact name via suggest; Meituan 闪购 by 货号; Eleme by exact name
   against a cached catalogue; Guanyi by a SKU regexed out of the listing name.

3. **"Normalise a name for comparison"** — three: two identical `normName`s in
   the internal routes, and `_normCategory` in the Meituan browser.

4. **"Extract a Roots SKU from a foreign string"** — three:
   `lib/gzgrocery-admin.js` `extractSku`, `routes/guanyi-admin.js`
   `skuFromGuanyiName`, and the inline
   `(String(item.name).match(/\d+-\d+/) || [])[0]` in
   `routes/meituan-internal.js:153`.

5. **"Drain a `*_sync_queue`"** — three implementations of the same table
   schema. `lib/channel-sync-stale.js:34-37` observes the schema is "Identical
   across all three… so one query template covers every entry" — for *reading*.
   The three drains are separate code, and the collapse/supersede logic exists in
   two of them.

6. **"Retry or fail a queue row"** — three: an inline branch in
   `meituan-daemon.js`, an inline branch in `eleme-daemon.js`, and a named
   `retryOrFail()` in `guanyi-daemon.js`. Same 3-attempt rule, three times.

7. **"Classify a platform status label"** — two ordered-regex copies
   (`internalStatusForChannel` in each internal route) plus gzgrocery's env sets.

8. **"Ingest an order and deduct stock"** — `routes/meituan-internal.js:382`
   and `routes/eleme-internal.js:277` are the same 200-line shape with different
   column lists; `scripts/gzgrocery-order-daemon.js:452` does it a third way,
   calling `adjustStock` directly with no HTTP hop and no `retail_order_items`
   money.

9. **"Read a WeCom webhook out of `storefront_config` with a read-only sqlite
   handle"** — `lib/ops-alert.js:31-70` and
   `lib/gzgrocery-order-notify.js:20-45`, two separate implementations, only one
   of which has the inode-revalidation fix.

10. **"Anti-fingerprint a browser"** — this one *was* deduplicated:
    `lib/eleme-browser.js:34` imports `fingerprintInitScript` from
    `lib/meituan-browser`. It is the counter-example that shows the rest were not.

11. **"Cache the channel's listing names for the admin"** — three tables with
    three shapes: `meituan_listings(store_code, listing_name)`,
    `eleme_catalogue_cache(store_code, name, item_global_id, stock, specs)`,
    `guanyi_listings(store_code, guanyi_name, code, sku_id, item_id, item_sku_id,
    warehouse_id, warehouse_name, current_qty)` — plus two identical
    `*_listing_jobs` hand-off tables (Meituan and Guanyi) and none for Eleme.

---

# GIT HISTORY

**The repository's git history cannot answer this question, and that is a
finding in itself.**

```
$ git log --oneline | wc -l
98
$ git log --format="%ad" --date=short | tail -1
2026-08-27
```

The entire history is 98 commits beginning **2026-08-27**. Every integration
file listed in the inventory was present in that first import:

| File | First commit | Commits since | Last touched |
|---|---|---|---|
| `scripts/meituan-daemon.js` | 2026-08-27 | 1 | 2026-08-27 |
| `lib/meituan-browser.js` | 2026-08-27 | 1 | 2026-08-27 |
| `routes/meituan-internal.js` | 2026-08-27 | 2 | 2026-08-30 |
| `scripts/shangou-daemon.js` | 2026-08-27 | 1 | 2026-08-27 |
| `scripts/eleme-daemon.js` | 2026-08-27 | 2 | 2026-08-30 |
| `lib/eleme-browser.js` | 2026-08-27 | 1 | 2026-08-27 |
| `routes/eleme-internal.js` | 2026-08-27 | 3 | 2026-08-30 |
| `scripts/gzgrocery-order-daemon.js` | 2026-08-27 | 2 | 2026-08-30 |
| `lib/gzgrocery-admin.js` | 2026-08-27 | 1 | 2026-08-27 |
| `scripts/guanyi-daemon.js` | 2026-08-27 | 2 | 2026-08-30 |
| `lib/guanyi-browser.js` | 2026-08-27 | 2 | 2026-08-28 |

So the git record says only "all three integrations were imported on the same
day". The real history has to be read out of two other sources.

**Source 1 — dated schema comments in `database.js`:**

| Integration | Comment | Line |
|---|---|---|
| Meituan bidirectional sync | `2026-06-22` | `database.js:4610` |
| Guanyi ERP sync (gzgrocery backoffice) | `2026-06-24` | `database.js:5344` |
| Eleme open-platform sync | `2026-06-28` | `database.js:5085` |

So all three landed within **six days of each other**, in late June 2026.

**Source 2 — dated incident notes left in the code**, which are a reasonable
proxy for "how many times has this been touched since". Counting distinct dates
mentioned in each integration's own files:

| Integration | Distinct dated notes | Span | Files with a dated note |
|---|---|---|---|
| **Meituan** (incl. 闪购) | **14** | 2026-05-17 → 2026-08-26 | daemon, browser, admin, internal, shangou |
| **Eleme** | **3** | 2026-08-23 → 2026-08-25 | browser, daemon |
| **Gzgrocery** (Guanyi + orders) | **5** | 2026-06-27 → 2026-08-28 | daemon, browser, order daemon |

Corroborating signals for the same ordering:

- **Findings-doc volume**: `docs/meituan-findings.md` 121 KB (18 numbered
  findings referenced in code) vs `docs/eleme-findings.md` 57 KB (9 findings) vs
  `docs/gzgrocery-findings.md` **1.4 KB** (1 finding).
- **Probe/one-off script count**: Meituan ~30 (`meituan-probe*`, `-test-*`,
  `-status-recon1..5`, `-dump-*`, plus 12 `shangou-*`); Eleme 3; gzgrocery/Guanyi
  ~10.
- **File size**: Meituan `lib/meituan-browser.js` + `scripts/meituan-daemon.js` ≈
  3500 lines; Eleme's pair ≈ 2850; gzgrocery's four files ≈ 2350.
- **Recon documents**: Eleme has two (`ELEME_BROWSER_RECON.md`,
  `ELEME_INTEGRATION.md`) both from a single capture session on 2026-08-23;
  Meituan has none — its knowledge accreted into `docs/meituan-findings.md`
  incident by incident.

**Reading.** Meituan is the oldest and by far the most reworked: five numbered
`status-recon` scripts, an in-file record of the substring matcher being torn out
after it was measured at "133 of 393 mappings" at risk, a mid-life forced
migration of one store to a different platform, and fourteen dated incidents
across three and a half months. Eleme is the youngest in *behaviour* even though
its schema is the newest by six days: it was built as OAuth in late June,
abandoned, and rebuilt as a browser driver from a single network capture on
2026-08-23 — every dated note in it falls inside a three-day window. Gzgrocery's
two halves are separated in time: the Guanyi stock push dates from 2026-06-24 and
carries the 2026-08-25/28 session-hardening notes written after the month-long
silent outage of 2026-06-24 → 07-26; the OpenCart order reader is later and,
judging by its `off` default mode, its shadow/live ladder and its complete absence
of alerting or admin UI, is the least-matured code of the three.

---

# OPEN QUESTIONS — could not determine from code

1. **Which mode each gzgrocery daemon is actually running in.**
   `GZGROCERY_ORDER_MODE` defaults to `off` and `GUANYI_PICKUP_MODE` to `off`;
   the live values are in a `.env` on the box, which is not in the repo. Whether
   the double-count guard (3B `live` ⇒ 3C `shadow`) currently holds cannot be
   determined here. The same reading also settles a second question: at `off`,
   3B's OpenCart login has never run in production at all, so its unattended
   re-login (§3.2) is untested as well as unobserved.

2. **Whether `MEITUAN_SKIP_STORES` and `SHANGOU_STORES` are set consistently in
   production.** The correctness of the 外卖/闪购 split depends on it entirely.

3. **Which daemons are actually running.** There is no pm2 ecosystem file in
   the repo; start commands exist only as comments in each daemon header. Whether
   `gzgrocery-orders`, `eleme-sync`, `shangou-sync` etc. are all up cannot be
   read from the tree.

4. **Log volume and disk growth.** No retention policy exists, and no numbers
   for current table sizes are available from the repo. The only figure recorded
   anywhere is "1276 [terminal failures] on 天河 as of 2026-08-22"
   (`routes/meituan-admin.js:483`).

5. **Whether the `retail_orders.channel_*` columns referenced by
   `routes/meituan-internal.js`'s INSERT all exist in the deployed schema.** The
   INSERT names ~35 columns; I verified the table is extended by `addColumn` calls
   but did not enumerate every one against the INSERT list.

6. **Whether any Eleme order has ever actually been ingested.** The order path
   is guarded at every rung, several method names are env-overridable guesses,
   and `ELEME_ORDER_LIST_METHOD` has a default the recon "confirmed by name" only.
   The code cannot tell me whether the observe rung has ever produced a list in
   production.

7. **The real Meituan/Eleme/Guanyi session lifetimes.** Guanyi's daemon warns at
   72 h, which implies a known figure, but the source of that number is not in the
   repo.

8. **Whether `lib/proxy-manager.js`'s `data/proxy-active.json` is populated**,
   and therefore whether Eleme's sessions currently share Meituan's exit IP as
   `lib/eleme-browser.js:110-119` intends, or fall through to
   `ELEME_PROXY_URL`.

9. **What the "store box" is and whether any exists.** It is referenced by the
   registry descriptors (`box-request` route, `config.box`), by
   `CHANNELS-LOGISTICS-PLUGINS-PLAN.md`, and by the Meituan wizard's first step,
   but no hardware, firmware or tunnel code is in this repo.

10. **Whether a production `session-relay` driver exists anywhere.**
    `lib/integrations/session-relay.js` says "In production the worker registers
    a real Playwright driver"; only the simulation driver is in this tree.

11. **Whether the settlement-import tables (`meituan_orders`,
    `meituan_settlements`, `meituan_balance_flow`) are still being fed.** The
    `scripts/meituan_*_20XX_XX.json` files run to 2026-04; whether the manual
    xlsx→import flow is still performed monthly is not determinable from code.

12. **Whether `eleme_tokens` currently holds live tokens.** The OAuth callback
    route is mounted and would write them; nothing reads them. Whether anyone has
    run the flow recently is not visible here.

13. **The gzgrocery OpenCart version and theme.** Every parser in
    `lib/gzgrocery-admin.js` is written against whatever was live when it was
    authored; there is no version pin, capability probe, or parser self-test.

14. **Whether `channel_status` rows for `'eleme'` are actually used.**
    `CHANNELS-LOGISTICS-PLUGINS-PLAN.md` calls the Eleme cells "placeholder"
    (`01-core.js:405`), while `scripts/eleme-daemon.js:456-460` reads
    `channelClosedStores('eleme')` for real. Which is current could not be
    settled from the code alone.
