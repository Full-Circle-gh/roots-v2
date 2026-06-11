# Overnight Bug Hunt — 2026-06-12

Autonomous multi-agent sweep run while you slept, then — per your "commit deploy all fix" go-ahead — the safe mechanical fixes were applied and deployed. Money-policy / behavior-changing fixes were **held** for your review (see the ledger).

Method per scope: fan out focused finder agents → each candidate gets an adversarial verification pass (agents that try to *disprove* it) → only survivors land here. Each finding has a confidence and a file:line so you can jump straight to it.

Severity key: 🔴 high (money / data-loss / cross-tenant) · 🟠 medium (wrong behavior, user-visible) · 🟡 low (edge case / polish).

## TL;DR

- **30 confirmed bugs** across 5 scopes (34 false positives filtered out by the verification pass).
- **Round 1 (overnight):** 16 fixed + deployed, 1 mini-app fixed (needs publish), 6 held for review.
- **Round 2 (after your go-ahead):** all 6 held items applied — 4 more deployed (`0b17eb4`: referral clawback 1.1, restock referral 1.2, partial-refund points 1.6, expiry tz 4.4/4.7), 1 more mini-app (`79bd8eb`: recent-buyers 3.1, needs publish), and 3.2 left as harmless dead code.
- **Net: 20 fixes deployed to prod, 2 mini-app fixes awaiting WeChat publish, 1 optional prod-DB migration awaiting your go-ahead** (existing bare-date coupon expiries — see ledger). Every deploy was health-checked (app online, key endpoints 200).
- **1.1 clawback policy chosen:** clamp the debit to available balance (never negative wallet) + log a shortfall for manual follow-up. One-line change if you later want full negative clawback.
- Two whole route files (`retail-inventory.js`, `retail-page-templates.js`) were running on the shared DB handle — harmless today (Roots only) but a cross-tenant leak the moment you enable data isolation. **Fixed** (no-op for Roots) so it can't bite at cut-over.

---

## Status

| # | Scope | State |
|---|-------|-------|
| 1 | Money & voucher correctness | ✅ done — 7 confirmed (10 false positives filtered) |
| 2 | Tenant-scoping + list-endpoint blob leaks | ✅ done — 7 distinct confirmed |
| 3 | Mini-app ↔ backend API drift | ✅ done — 2 confirmed (low); checkout contract clean |
| 4 | Recently-churned code (wizards, product-blocks, 05-marketing) | ✅ done — 8 distinct confirmed |
| 5 | i18n EN/CN pairing + misc footguns | ✅ done — 6 confirmed |

---

## Hunt 1 — Money & voucher correctness (7 confirmed)

> The verification pass downgraded everything below "high" after reading the actual guards. The two `medium`s are the ones worth real attention; the five `low`s are genuine but bounded/operator-gated.

### 1.1 🟠 Referral reward is never clawed back on refund/cancel
**`routes/retail.js:11550-11622` (admin status flip) + `11785-11800` (refund/approve) + `7899-7955` (`creditReferralReward`)**
`creditReferralReward()` permanently credits both the referrer (`affiliate.rewardPerOrder`) and the friend (`affiliate.rewardReferee`) the moment the invitee's first order is marked paid. Every refund/cancel path reverses points, redeem, voucher and inventory — but **none reverse the referral payout**, and none reset the `retail_referrals` row. Abuse: place a first order → both wallets credited → fully refund the order. Buyer gets their money back **and** the referral cash stays in both wallets. Repeatable per invitee. There isn't even a manual operator path to undo it (the referral-edit endpoint 409s once `status='ordered'`).
**Fix:** add `reverseOrderReferral(orderId)` invoked from all three reversal paths — debit both wallets (`creditWallet` negative, idempotent `out_trade_no`), flip row to `void`/`order_refunded`, all in one `tdb()` transaction guarded by `status='ordered'`. Decide policy for clamping the referrer debit if already spent.

### 1.2 🟠 Wait-for-restock first order silently loses the referral reward
**`lib/inventory.js:954-956` vs `routes/retail.js:7902-7903` + `2340`**
For a `wait_for_restock` order, `markOrderPaid` sets status `awaiting_restock` (not `paid`), so the `creditReferralReward` call at `2340` early-returns. Later `checkAwaitingRestockForRestock()` promotes the order to `paid` with a **bare inline UPDATE** — no `creditReferralReward`, no `awardOrderPoints`, no operator push. So if an invited friend's *first* order is a wait-for-restock order, **the reward is lost permanently** (the row stays `joined`, and their 2nd order gets voided as `not_first_order`). Likely also drops points on those orders.
**Fix:** after the `awaiting_restock→paid` UPDATE, run the same post-payment side effects (`awardOrderPoints`, `creditReferralReward`, push) for each promoted id. `creditReferralReward` is already idempotent, so it's safe.

### 1.3 🟡 POST voucher-create doesn't clamp `value`/`min_subtotal` to ≥0
**`routes/retail.js:7041-7042`**
PATCH clamps with `Math.max(0, …)` (lines 7122-7123, on purpose — comment says a negative "breaks computeVoucherDiscount"); POST/create doesn't. Not a customer exploit (`computeVoucherDiscount` neutralizes negatives), but an operator can persist a negative-discount voucher that *raises* an order total — and it contradicts the PATCH validation.
**Fix:** mirror the PATCH clamp in the create handler.

### 1.4 🟡 Voucher-claim leaks existence of private codes (enumeration oracle)
**`routes/retail.js:6118-6152`**
`POST /api/retail/vouchers/claim` looks up by code with **no `is_public` filter**, so a private active code is *found* then 403 `not_claimable`, while a nonexistent code is 404 `unavailable` — distinguishable, so a logged-in attacker can enumerate which private codes exist. The sibling validate endpoint (6190-6205) deliberately collapses private codes to the same 404 "so codes can't be enumerated" — claim violates that stated model. Bounded: no grant/discount leaks, just existence.
**Fix:** for a truly-private code return the same 404 as nonexistent (or add `AND is_public = 1` to the code lookup); keep `signup_only` only for the public-signup case.

### 1.5 🟡 `claimMigrationCredit` reads amount outside the claim transaction (TOCTOU)
**`routes/retail.js:5922`**
The credit row (with `balance`/`points`) is SELECTed *before* the transaction opens; inside, only `claimed_at IS NULL` is re-checked, and the amounts credited are the pre-transaction snapshot. A concurrent re-seed (`scripts/seed_migration_credits.js:73` updates `WHERE claimed_at IS NULL`) could apply a stale amount. The won-guard still prevents *double* crediting — this is a value-correctness edge, not a double-spend, and seeding is offline. Near-zero practical risk.
**Fix:** re-SELECT inside the transaction (or `UPDATE … RETURNING balance, points`), or just never seed against live prod traffic (and document it).

### 1.6 🟡 Partial refund with `reverse_points=true` returns ALL redeemed points
**`routes/retail.js:11771`**
On a *partial* refund, if an operator passes `reverse_points: true`, `reverseOrderRedeem(id)` (13656-13679) reverses the **entire** redemption — it has no partial notion. Example: ¥100 order paid ¥50 cash + 5000 pts, a ¥20 partial refund with the flag returns ¥20 cash **and** all 5000 pts (¥50) while the customer keeps ¥80 of goods → ¥70 compensation for a ¥20 intent. Auto default is safe (`reversePoints` defaults to `isFull`); requires explicit operator flag. (Note: `reverseOrderPoints` similarly over-corrects earned points/lifetime_spend on partials.)
**Fix:** reject/ignore `reverse_points=true` when `!isFull`, or scale reversal by `refund_amount/order_total`.

### 1.7 🟡 Misleading "UNIQUE" idempotency comment (constraint doesn't exist)
**`routes/retail.js:7922-7923` vs `database.js:2047-2048`**
Comment claims `out_trade_no` is a UNIQUE idempotency key, but `retail_topup_transactions.out_trade_no` has only a **non-unique** index (unlike `retail_payments.out_trade_no` which is genuinely unique). Currently safe because the wrapping `status='joined'` UPDATE guards it — but the stated invariant is false, a latent footgun if anyone later credits outside that transaction or adds a second writer.
**Fix:** correct the comment, and/or add a real partial UNIQUE index + `INSERT OR IGNORE` (verify existing rows for NULL/dup `out_trade_no` first).

---

## Hunt 2 — Tenant-scoping + blob leaks (7 distinct confirmed)

> **Big picture:** two whole route files — `routes/retail-inventory.js` and `routes/retail-page-templates.js` — **never import `tdb()` at all** and run every query on the shared `db`. Today this is harmless (Roots is tenant 1, where `tdb()===db`, and `TENANT_DATA_ISOLATION` is still off so non-Roots operators get a 403 "workspace being set up"). But the moment isolation is flipped on for the multi-tenant cut-over, **every non-Roots operator reads/writes Roots' data**. These are exactly the footgun class you already recorded ("catalog writes must use `tdb()`"). They're **latent, not live** — but they must be fixed *before* cut-over. The cleanest fix is one import + a `db.` → `tdb().` sweep in those two files.

### Tenant-scoping (all latent until `TENANT_DATA_ISOLATION=1`)

#### 2.1 🔴 `routes/retail-inventory.js` runs entirely on shared `db` (no `tdb()` import)
**`routes/retail-inventory.js:10`** — imports `const db = require('../database')`, never imports `tdb()`. Every direct `db.prepare(...)` targets data-plane tables: `retail_stores` (POST/PATCH/DELETE stores), `store_products`, `retail_store_stock`, `retail_stock_reservations`, `retail_stock_ledger`, `retail_product_substitutes`, `storefront_config`. Under isolation, a tenant-B operator creating/editing/deleting a store writes into **Roots'** tables; the substitutes PUT rewrites Roots' rows; the gz-excluded-districts PUT overwrites Roots' routing config. (The `inventory.*` helper delegations are *safe* — `lib/inventory.js` uses `tdb()` internally; only the direct `db.prepare` statements in the route file are wrong.)
**Fix:** `const { tdb } = require('../lib/tenant-db')`; swap every direct data-plane `db.prepare`/`db.transaction` → `tdb()`. For `geocodeStoreAsync` (runs in `setImmediate`, outside the ALS scope) capture the tenant connection at call time and pass it in.

#### 2.2 🔴 geocode-status / geocode-backfill read & **write** Roots' customer-address PII via shared `db`
**`routes/retail-inventory.js:322-365`** — `GET /inventory/geocode-status` counts and `POST /inventory/geocode-backfill` **writes** lat/lng onto `retail_stores` and `retail_customer_addresses` (per-tenant customer PII) on the shared `db`. Worst of the cluster because it's a cross-tenant *write* onto another tenant's customer addresses.
**Fix:** route all four statements through `tdb()`.

#### 2.3 🟠 inventory grid + per-store stock read catalog via shared `db`
**`routes/retail-inventory.js:139, 149, 188, 224`** — `GET /inventory/grid` and `GET /stores/:id/stock` build product rows from `store_products` + `retail_store_stock` on the shared `db` (the per-row `inventory.getAvailable()` decoration *is* tenant-correct, so the base list and the availability disagree). Non-Roots operators would see Roots' catalog/stock.
**Fix:** `db.` → `tdb().` at those reads + the PATCH product-existence check at :224.

#### 2.4 🟠 `routes/retail-page-templates.js` stores/reads/deletes templates on shared `db`
**`routes/retail-page-templates.js:18`** — all four routes operate on `retail_page_templates` (data-plane, no `tenant_id` column → isolated by file) via shared `db`, no `tdb()` import. The header comment "shared across every operator" is right *within* a tenant but wrong *across* tenants. Under isolation, a non-Roots operator lists/writes/deletes Roots' templates. Design assets only (not PII/money), hence medium.
**Fix:** import `tdb`, switch all four statements to `tdb().prepare(...)`.

### Blob leaks (live today — perf, customer- or admin-facing)

#### 2.5 🟠 PDP "Buy together" bundle ships raw base64 per item — **customer-facing**
**`routes/retail.js:800-805` (`resolveBundle`), wired in at `:1545`** — the PDP endpoint carefully strips base64 from the hero (1444-1455) and variant siblings (1510-1538, lazy URLs) but `resolveBundle()` selects raw `image_data` with no lazification. The mini-app reads it directly (`miniapp/pages/product/product.js:516`), so a 4-item base64-photo bundle adds ~1MB+ to a single PDP load. Only the storefront-facing leak in this batch.
**Fix:** drop raw `image_data` from the `resolveBundle` SELECT; emit lazy `/api/retail/products/:id/image?v=…` URLs like the variant-sibling code a few lines above (pass `baseUrl` into `resolveBundle`).

#### 2.6 🟠 Admin flash-sales list ships raw base64 per row
**`routes/retail.js:9412-9437`** — `GET /api/retail-admin/flash-sales` is a list but SELECTs raw `p.image_data` (9416) and ships it verbatim (9427). The sibling admin products grid (9645) already does the lazy-URL pattern via `has_image_data`; this one was missed. Admin-only + just the flash subset, so bounded.
**Fix:** mirror the products-grid pattern — `hasImageFallbackSql('p') AS has_image_data` + lazy `/api/retail-admin/products/:id/image?v=…`.

#### 2.7 🟡 Admin variant-members list ships raw base64 per sibling (then discards it)
**`routes/retail.js:9780-9802`** — `GET /api/retail-admin/products/:id/variants` returns `members[]` with raw `sp.image_data` per sibling. The PDP path for the *same* relationship already lazifies ("5 variants = ~1 MB wasted"). Extra insult: the consumer (`public/retail-admin/09-products.js:1716`) never even reads `image_data` — pure wasted payload.
**Fix:** select a `has_image_data` flag + `updated_at`, drop the blob, post-map to a lazy URL.

---

## Hunt 3 — Mini-app ↔ backend API drift (2 confirmed, both low)

> Reassuring result: the front/back contract is largely in sync. Only two dead-config reads, both fully defensive (graceful fallback, nothing crashes). **Caveat:** the checkout/cart/order finder crashed mid-run — re-ran separately, results appended below under "Hunt 3b".

### 3.1 🟡 Recent-buyers ticker ignores operator cadence settings (unreachable field)
**consumer `miniapp/components/recent-buyers/recent-buyers.js:74` · producer `routes/retail.js:1601,1662`**
Server returns `timing: { visible_ms, gap_ms }` as a **sibling** of `data`, but `api.js:74` unwraps `body.data ?? body`, so the component only ever gets the array and `res.timing` is always `undefined`. The ticker silently ignores the operator's "visible_secs / gap_secs" tuning and always uses the hardcoded 4500/5000ms defaults. No crash — just dead config.
**Fix:** nest `timing` inside `data` server-side (`data: { items, timing }`) and update the consumer, or have the component read the raw body.

### 3.2 🟡 PDP hero aspect ratio reads a field the backend never sends
**consumer `miniapp/pages/product/product.js:544` · producer `routes/retail.js:630-662`**
`product.js` sets the hero `aspectRatio` from `p.image_aspect`, but `image_aspect` is never selected by `RETAIL_PRODUCT_COLS` nor added by the PDP route (zero matches in `routes/`). Always `undefined` → hero falls back to fixed 880rpx. Likely copy-paste from the home `hero_banner` block config (where `image_aspect` *is* real). Dead per-product control.
**Fix:** either add an `image_aspect` column to `store_products` + include it in `RETAIL_PRODUCT_COLS`, or delete the dead read.

### Hunt 3b — Checkout/cart/order re-run: ✅ clean
Full trace of every checkout/cart/order/pay API call on both sides — the WeChat & Alipay pay handoff, order create/detail/list, `checkout/quote`, `cart/price`, free-shipping-threshold, payment-status. **No drift.** Every load-bearing field is present, correctly nested in `data`, and correctly typed; the flow is disciplined about the `data ?? body` unwrap. (Two harmless dead branches noted: checkout's `simple_confirm` gate is never emitted by `analyzeShortage`, degrades gracefully.)

---

## Hunt 4 — Recently-churned code: coupon wizard + dirty mini-app files (8 distinct confirmed)

> The wizard's *normal* path is solid — most of these need an edge input or a fast double-click. The two I'd fix first: the **`vwGoto` null-deref that leaves the wizard reopening blank**, and the **5-spice badge spelling mismatch** that shows untranslated "5 SPICE" on the PDP. The expiry-timezone issue is real but pre-existing (it predates the wizard, affects the old form too).

### 4.1 🟠 `vwGoto` fade-timeout derefs `_vw` with no null guard → crash + permanently-blank wizard on reopen
**`public/retail-admin/05-marketing.js:324-331` + `retail-admin.html:2328,2340`**
`vwGoto()` guards `_vw` at the top, but its deferred 240ms `setTimeout` callback does `_vw.step = step` **with no guard**. The Close button is visible throughout the fade, so clicking Next/Back then Close within 240ms → `TypeError: Cannot set properties of null`. Worse second-order effect: `vwClose()` removes `.show` but never clears the `vw-leaving` class (which is `opacity:0`), and `vwOpen/vwRender` don't strip it either — so the **next** time the wizard opens it renders **invisible/blank** until the user happens to click Next/Back. The crash path guarantees this (lines 326-330 never run).
**Fix:** first line of the callback `if (!_vw) return;`; have `vwClose()` clear `vw-leaving`/`vw-entering` (or clear them at the top of `vwOpen`); optionally `clearTimeout` the stored id in `vwClose`.

### 4.2 🟠 5-spice badge never matches store-editor data → raw "5 SPICE", untranslated in CN
**`miniapp/pages/product/product.js:332`**
`badgeMap` keys it `'5spice'` (no space), but the **store editor** (which writes `store_products`, what the mini-app reads) stores the token as `'5 spice'` **with a space** (`retail-admin.html:1857`). So `badgeMap['5 spice']` is undefined → falls through to `k.toUpperCase()` → renders raw `"5 SPICE"` and, in Chinese, the English `"5 SPICE"` instead of `无五香` (the miss skips `lang.pick`). Kitchen app uses `'5spice'`, store editor uses `'5 spice'` — same column, two spellings, mini-app only matches one.
**Fix:** normalize the lookup key — `k.toLowerCase().replace(/\s+/g,'')` — and alias both spellings. (Lowercasing also fixes 4.8 below.)

### 4.3 🟠 Per-customer limit of `0` silently means *unlimited* (opposite of the prompt)
**`public/retail-admin/05-marketing.js:531,647` + backend `routes/retail.js:6208,6053`**
The wizard asks "How many times can one person use it?" and accepts an explicit `0` (`Math.max(0, …)`); `vwSave` forwards `per_customer_limit: 0`; the backend treats `0` as falsy → **no cap** (`if (v.per_customer_limit && v.per_customer_limit > 0)`). An operator typing `0` (meaning "nobody/zero") creates an **unlimited-per-person** coupon. Blank correctly defaults to 1; the explicit `0` is the trap.
**Fix:** clamp the wizard input to `Math.max(1, …)` (treat blank and 0 alike), or handle 0 explicitly.

### 4.4 🟠 Coupon expiring "on day X" actually dies at 08:00 that morning; a same-day expiry is born dead (but wizard says "live")
**`public/retail-admin/05-marketing.js:541,648` + backend `routes/retail.js:5969,6031`** *(pre-existing — old form `:71` has it too)*
The wizard validates the expiry against **local** end-of-day (`new Date(_vw.expires + 'T23:59:59')`) but sends a **bare** `YYYY-MM-DD`; the backend compares it as **UTC midnight** (`datetime('2026-06-15')` = `00:00 UTC` = 08:00 Beijing). So every coupon dies ~16h early on its final day, **and** picking *today* passes the wizard's local guard (shows "Created & live") while `computeVoucherDiscount` already returns `applied:false`.
**Fix:** send `expires_at: _vw.expires ? _vw.expires + 'T23:59:59+08:00' : null` (or normalize +8h/end-of-day on the backend), and align the wizard's guard. Fix the old form the same way.

### 4.5 🟠 POST `/vouchers` doesn't clamp `value`/`min_subtotal` → negative `fixed_amount` becomes a *surcharge* — **same as [1.3], upgraded**
**`routes/retail.js:7041`**
This is finding **1.3** re-confirmed with a sharper impact: PATCH clamps with `Math.max(0,…)`, POST doesn't. A negative `fixed_amount` yields a **negative discount** → checkout's `Math.max(0, subtotal − voucherDiscount)` floors the *total* but not the discount, so it genuinely **overcharges**. The wizard blocks it client-side, but the **old 12-field form** (`retail-admin.html:2165`, no `min=0`) reaches the same endpoint with no clamp — so an operator typo can ship a surcharge voucher. Bumps 1.3 from 🟡 to 🟠.
**Fix:** mirror the PATCH clamps in POST (and cap percent at 100).

### 4.6 🟡 Editing the code on the Review step doesn't refresh the "Heads up" clash warnings
**`public/retail-admin/05-marketing.js:622`**
`vwHeadsUp()` (live code-clash / revive / auto-apply detection) is computed **once** at Review render. `vwEditCode` mutates `_vw.code` but never re-renders, so typing a colliding code never updates the warning. Hard-caught at `vwSave` (and backend), so no bad voucher — just a stale "live" panel.
**Fix:** give the notes block an id and rebuild its `innerHTML` from `vwHeadsUp()` on code edit (debounced), like the ticket re-render.

### 4.7 🟡 Heads-up / clash guards compare bare expiry dates as UTC midnight
**`public/retail-admin/05-marketing.js:565,638`**
Same UTC-vs-local skew as 4.4 in the *client* liveness check (`new Date(clash.expires_at) < new Date()`). During the first 8 local hours of an expiry day, the client can disagree with the server's authoritative `datetime()` check. Server re-validates (`code_active`), so no corruption — just a confusing two-step (no inline warning, then a "Failed" toast).
**Fix:** normalize to one timezone basis (same fix as 4.4).

### 4.8 🟡 `#vw-bg` wizard modal has no Esc-to-close and no backdrop-click-close
**`public/retail-admin.html:2333`**
Unlike every sibling modal/drawer (the pop-up editor even advertises "(Esc)"), the wizard only closes via the small header button — the global Esc handler only targets `body > .pu-editor-bg`, and `#vw-bg` is nested in `#tab-coupons` and toggled by class. UX inconsistency on a heavily-iterated surface.
**Fix:** add `onclick="if(event.target===this)vwClose()"` on the backdrop + a document `keydown` Esc handler gated on `#vw-bg.show`.

> *Also noted, downgraded to low:* `free_of` matching is case-sensitive (`hiddenFreeOf`/`badgeMap` are lowercase, tokens only `.trim()`ed), so a capitalized `Egg`/`Animal products` token would leak as a badge the rework meant to hide — **but** all current seed data is lowercase and the editor can't introduce capitals, so it's a latent fragility, not a live defect. The `.toLowerCase()` fix in 4.2 closes it for free.

---

## Hunt 5 — i18n pair-hiding + notifications/robustness (6 confirmed)

### i18n pair-hide footguns (the classifier wrongly pairing stacked EN/CN data → one language vanishes)

#### 5.1 🟠 Broadcasts list mono-lingualizes the message title + body
**`public/retail-admin/05-marketing.js:1559,1563,1587,1591`**
`loadBroadcasts()` glues `title_en · title_cn` and `body_en · body_cn` into single `" · "` strings, rendered in `.bc-item-title`/`.bc-item-body` with no `data-no-i18n`. The text-node splitter sees the divider and registers it as a translation pair → EN mode shows only English, CN mode only Chinese. An operator reviewing what was sent **can never see both halves**, and may think the Chinese body never went out. Real message *data* through the UI-label splitter.
**Fix:** add `data-no-i18n` to `.bc-item-title`/`.bc-item-body` (or the `.bc-item` container).

#### 5.2 🟠 Recipe ingredient table hides Chinese ingredient names *(app.html / Kitchen)*
**`public/app.html:6779`** — stacked `name_en` div + `name_cn` div in each ingredient `<td>`, no `data-no-i18n`. `tagBlockPair` pairs the two same-tag adjacent divs → a 6+char CJK name (e.g. 麻辣青辣椒酱) vanishes under the EN toggle; <6char survives (the deceptive intermittency). Same class as the recorded `reference_i18n_block_pair_footgun`, new location.
**Fix:** wrap the two name divs in one `<div data-no-i18n>` (note: `tagBlockPair` ignores ancestor `data-no-i18n` — must wrap so the divs aren't element-adjacent siblings, or mark `data-lang-block`).

#### 5.3 🟠 Dashboard "Top Products" analytics table — same pair-hide
**`public/app.html:20163`** — identical stacked `name_en`/`name_cn` render in the sortable table; CN product name hidden under EN toggle.
**Fix:** same wrap-in-`data-no-i18n`-container pattern.

#### 5.4 🟠 GZGrocery analytics table (with variant chip) — same pair-hide
**`public/app.html:20645`** — same stacked-name pattern (the trailing 🎨 variant chip is unaffected, but the CN name still vanishes).
**Fix:** same.

### Notifications / consent robustness

#### 5.5 🟠 Subscribe-message consent is burned even when the WeChat send fails
**`routes/retail.js:2838`**
`sendSubscribeMessage()` marks the consent `used=1` **before** the WeChat call. Every failure path (no token, `errcode!=0`, network throw) then returns `{sent:false}` with the consent already consumed. WeChat one-shot consent is precious — a transient token hiccup or WeChat 5xx **permanently eats the customer's next order-status/refund push**, with no retry, while WeChat still holds the consent.
**Fix:** set `used=1` only after a confirmed `errcode===0` (you may still consume on a non-retryable refusal like 43101, but not on transient failures).

#### 5.6 🟠 Refund fires a malformed push (`phrase2=null`) that burns order-status consent
**`routes/retail.js:2890` (called with `null` from `:11807,11918,11947`)**
Refund payout/reject/partial-approve call `notifyOrderStatusChange(id, null)`. The in-app branch is null-guarded, but the **WeChat push branch isn't** — it passes the category gate, builds `phrase2:{value:null}`, calls `sendSubscribeMessage` (which burns the consent per 5.5), and WeChat rejects the empty value. So **issuing a refund silently destroys the customer's next order-status consent and sends nothing.** Conditional on `order_status_template_id` being configured.
**Fix:** add the symmetric guard `if (!ORDER_STATUS_NOTIF[newStatus]) return;` before the push block (or stop passing `null` — the refund events already write their own in-app rows).

---

## ⚙️ Fix ledger — DEPLOYED vs HELD

> Updated live as I apply fixes. "Deployed" = committed to `main` (auto-deploys, gated through `node --check` + HTML syntax gate). "Committed" = in git but mini-app, needs a separate WeChat publish to go live. "Held" = left for your decision.

**Deployed to prod in 3 batched commits** (all health-checked green): `b0fd181` backend routes · `8a72efe` wizard + broadcasts i18n · `3e00454` app.html i18n. Mini-app fix in `d8bc214` (no deploy — needs WeChat publish).

| Finding | Action | State |
|---|---|---|
| 1.3 / 4.5 voucher POST clamp | deploy | ✅ deployed `b0fd181` |
| 1.4 voucher-claim enumeration → 404 | deploy | ✅ deployed `b0fd181` |
| 1.7 misleading UNIQUE comment | deploy | ✅ deployed `b0fd181` |
| 2.1–2.4 db→tdb() (inventory + page-templates) | deploy (no-op for Roots) | ✅ deployed `b0fd181` |
| 2.5 PDP bundle blob lazify | deploy | ✅ deployed `b0fd181` |
| 2.6 flash-sales list blob lazify | deploy | ✅ deployed `b0fd181` |
| 2.7 variant-members blob lazify | deploy | ✅ deployed `b0fd181` |
| 5.5 consent-burn-on-failure | deploy | ✅ deployed `b0fd181` |
| 5.6 refund null-push guard | deploy | ✅ deployed `b0fd181` |
| 4.1 vwGoto null-deref + blank-modal | deploy | ✅ deployed `8a72efe` |
| 4.3 per-customer 0→min 1 | deploy | ✅ deployed `8a72efe` |
| 4.6 heads-up refresh on code edit | deploy | ✅ deployed `8a72efe` |
| 4.8 wizard Esc/backdrop close | deploy | ✅ deployed `8a72efe` |
| 5.1 broadcast i18n data-no-i18n | deploy | ✅ deployed `8a72efe` |
| 5.2 / 5.3 / 5.4 app.html i18n tables | deploy | ✅ deployed `3e00454` |
| 4.2 5-spice badge + lowercase free_of | commit | ✅ committed `d8bc214` — **needs WeChat publish** |
| 1.1 referral clawback on refund | deploy | ✅ deployed `0b17eb4` — policy: **clamp-to-zero** (never negative wallet) + shortfall log |
| 1.2 wait-for-restock referral credit | deploy | ✅ deployed `0b17eb4` (inventory `setOnOrdersPromoted` hook) |
| 1.6 partial-refund points over-reversal | deploy | ✅ deployed `0b17eb4` (reversePoints clamped to isFull) |
| 4.4 / 4.7 expiry timezone | deploy | ✅ deployed `0b17eb4` for **new/edited** coupons (`normalizeVoucherExpiry`). ⚠️ **existing bare-date rows need a one-time prod-DB migration — awaiting your go-ahead** (see below) |
| 3.1 recent-buyers timing | commit | ✅ committed `79bd8eb` — **needs WeChat publish** (added opt-in `raw` flag to api.js; no backend shape change) |
| 3.2 image_aspect dead read | **left as-is** | harmless dead read (always `''`); sits in your actively-edited PDP hero code — say the word and I'll remove it |

### ⚠️ One pending data migration (needs your go-ahead)
The expiry fix (4.4/4.7) is correct for all coupons created/edited from now on. To retroactively fix the handful of **existing** coupons stored with a bare date, run once against the prod DB:
```sql
UPDATE retail_vouchers
   SET expires_at = substr(expires_at, 1, 10) || 'T15:59:59Z'
 WHERE expires_at IS NOT NULL AND length(expires_at) = 10 AND expires_at LIKE '____-__-__';
```
I didn't run it autonomously (direct prod-data mutation outside the "apply fixes" scope). Say "run the expiry migration" and I'll do it with a DB backup first; or it's harmless to skip (those coupons just keep the old ~8 a.m.-last-day behavior until edited).

### Follow-up noted during the fix (not a regression)
- The inventory **ledger** read (`routes/retail-inventory.js`) `LEFT JOIN`s control-plane `users` with tenant data-plane tables. Correct today on `tdb()` (Roots: `tdb()===db`), but once data isolation is on, a non-Roots tenant DB won't contain `users` — that join must be resolved out-of-band before cut-over. Flagged with a comment in the code.

---
