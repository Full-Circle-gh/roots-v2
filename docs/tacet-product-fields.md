# Tacet product fields — verified inventory of `products` + `store_products`

**2026-07-31 · Read-only inventory. Every read/write claim below was checked by reading the file.
Nothing here was inferred from a column's name. Where a purpose could not be read off a code
comment it is marked INFERRED. Answers the open item in `docs/tacet-consolidation-decisions.md` §4 and §22.**

---

## Count summary

| Group | What it means | Columns |
|---|---|---|
| **A** | Used only by production surfaces | **3** |
| **B** | Used only by store / customer surfaces | **20** |
| **C** | Used by both | **43** |
| **D** | Dead or partially dead | **8** |
| **E** | Fork plumbing | **4** |
| | **Total distinct columns** | **78** |

Of those 78:

- **64** exist on **both** tables. `store_products` was built as a full mirror of `products`
  (`database.js:3702-3723`) and a boot-time backfill copies across any column `products` later
  gains, so the two schemas cannot drift.
- **10** exist on **`store_products` only** (`database.js:3726-3790`).
- **4** exist on **`store_products` only** and are the fork link (`database.js:3714-3717`).

A column existing on both tables does **not** mean both apps use it. Twelve columns are physically
present on a table where no code touches them; those are called out per row.

### How to read the rows

- **Production surfaces** = `public/app.html`, `public/pos.html`, `public/restock.html` and the
  routes behind them (`routes/products.js`, `routes/pos.js`, `routes/markets.js`, `routes/sales.js`,
  `routes/waste.js`, `routes/restock.js`, `routes/admin.js`, `routes/ai.js`, `routes/alerts.js`).
  These read and write **`products`**.
- **Store / customer surfaces** = `public/retail-admin.html` + `public/retail-admin/*.js`,
  `public/product-editor.html`, `public/shop.html`, `miniapp/`, and the routes behind them
  (`routes/retail.js`, `routes/retail-inventory.js`, `routes/retail-setup.js`,
  `routes/retail-purchasing.js`, `lib/inventory.js`). These read and write **`store_products`**.
- **`public/product-editor.html` is a STORE surface, not a production one.** Every request it makes
  goes to `/api/retail-admin/products/...` (`public/product-editor.html:2113, 2136, 2369, 3116`),
  which is `store_products`. Worth knowing before the merge: its name suggests otherwise.
- `public/app.html.bak` was excluded from every search.
- Nullability: only `id` (primary key) and `name_en` (`NOT NULL`, `schema.sql:138`) are non-null.
  **Every other column on both tables is nullable.** Stated once here, not repeated per row.

---

## A. Used only by production surfaces

Three columns. All three physically exist on `store_products` and no store code reads or writes them.

| Name | Type · default | Tables | Defined | Server writes | Server reads | Frontend | Purpose | Dead? |
|---|---|---|---|---|---|---|---|---|
| `recipe_id` | INTEGER · none | both | `schema.sql:142` | `routes/products.js:307` (create/update field list), `routes/products.js:766` (bulk import) | `routes/products.js:8, 152, 179-207` (derives allergens + inlines the recipe cost block), `routes/admin.js`, `routes/waste.js` | `public/app.html` — inline edit `data-field="recipe_id"`, create form `pf_recipe` (`public/app.html:15211`) | "linked recipe (for cost calc)" — `schema.sql:142` | **DEAD on `store_products`** — zero reads/writes anywhere in store code |
| `label_data` | TEXT · none | both | `schema.sql:151`, re-added `database.js:28` | `routes/products.js:307`; `public/app.html` `iedSaveField(…,'label_data')` | `routes/products.js:11` | `public/app.html` only (12 references, the label printer) | "base64 data URI" of the printed product label — `schema.sql:151` | **DEAD on `store_products`** |
| `external_id` | INTEGER · none | both | `database.js:67` | `routes/products.js:307, 370`; `scripts/import_products.js`, `scripts/fix_products_swap.js`, `scripts/apply_name_suggestions.js`, `scripts/seed_variant_groups.js`, `scripts/import_miniapp.js` | `routes/products.js:13, 36` | none | "holds the upstream ID so we can re-sync without losing the link" — `database.js:61-63` | **PARTIALLY DEAD** — returned by the API, rendered by no screen. DEAD on `store_products` |

---

## B. Used only by store / customer surfaces

Twenty columns. The ten marked "store only" under **Tables** do not exist on `products` at all.

| Name | Type · default | Tables | Defined | Server writes | Server reads | Frontend | Purpose | Dead? |
|---|---|---|---|---|---|---|---|---|
| `compare_at_price` | REAL · none | both | `database.js:90` | `routes/retail.js:17855-17858` (edit), `:18096, 18106` (create), `:18324` (duplicate) | `routes/retail.js:893` (catalogue), `:17975, 18020` (editor row) | `public/retail-admin/09-products.js`, `public/shop.html`, `miniapp/pages/{shop,product,cart,checkout}` | "compare-at / was-price (划线价) … shown struck through next to the live price" — `database.js:87-89` | **DEAD on `products`** — never read, never written there |
| `image_url` | TEXT · none | both | `schema.sql:152` | `routes/retail.js:17845` | `routes/retail.js:905` and ~80 other sites | `public/cms.html`, `public/storefront.html`, `public/shop.html`, `public/shop/blocks.js`, `public/retail-admin/{05,09}-*.js`, `public/product-editor.html`, `miniapp/components/block-renderer`, `miniapp/pages/{shop,product}` | Externally-hosted photo URL; the mini-app reads `image_data \|\| image_url`. Schema comment "reserved for future CDN-hosted images" (`schema.sql:152`) is now **stale** — it is in live use | live on `store_products`; **DEAD on `products`** |
| `flash_price` | REAL · none | both | `database.js:1066` | `routes/retail.js:18443-18452`, cleared `:18470-18478` | `routes/retail.js:911`, `lib/flashsales.js` | `public/retail-admin/09-products.js` (flash-sale panel); customer price via the decorated row | "A product is 'on flash' between `flash_starts_at` and `flash_ends_at`, charged at `flash_price`" — `database.js:1061-1065` | DEAD on `products` |
| `flash_starts_at` | DATETIME · none | both | `database.js:1067` | as above | as above | as above | Flash window opens | DEAD on `products` |
| `flash_ends_at` | DATETIME · none | both | `database.js:1068` | as above | as above | as above | Flash window closes | DEAD on `products` |
| `flash_stock_limit` | INTEGER · none | both | `database.js:1069` | as above | `routes/retail.js:912, 9496-9498` | as above | "caps the number sold during the window (NULL = unlimited)" — `database.js:1063` | DEAD on `products` |
| `flash_sold` | INTEGER · 0 | both | `database.js:1070` | `routes/retail.js:9493-9498` (order commit), `:26645` (add-on), reset `:18450` | `routes/retail.js:912` | `public/retail-admin/09-products.js` counter | "incremented atomically inside order-create" — `database.js:1064` | DEAD on `products` |
| `oos_policy` | TEXT · none | both | `database.js:2771` (products), `:3779` (store) | `routes/retail.js:17900-17904` | `routes/retail.js:917`, `effectiveOosPolicy()` `:931-941`, `:8912`, `:26932` | `public/retail-admin/09-products.js`, `miniapp` | "who may still order once stock hits 0" — `strict` / `backorder_gz` / `always` — `database.js:2763-2770` | DEAD on `products` |
| `ship_from_supplier` | INTEGER · 0 | both | `database.js:2753` | `routes/retail.js:17906` | `routes/retail.js:905, 937, 8912, 26932`; snapshotted onto `retail_order_items:9466` | `public/retail-admin/09-products.js`, `public/shop.html`, `miniapp` (11 references) | "products the supplier ships STRAIGHT to the customer rather than through our warehouse" — `database.js:2747-2748` | DEAD on `products` |
| `product_facts` | TEXT · none | **store only** | `database.js:3726` | `routes/retail.js:17815-17828`, `:18098, 18112` | `routes/retail.js:17977, 18022` via `parseFactsCol` | `public/retail-admin/09-products.js` | "a flexible per-product-type facts bag (origin/ingredients/…), stored as JSON so a new product type needs no new columns" — `database.js:3724-3725` | live |
| `variant_label_cn` | TEXT · none | **store only** | `database.js:3730` | `routes/retail.js:18848, 18849, 18855, 18857` | `routes/retail.js:913` | `public/retail-admin/09-products.js`, `public/shop.html`, `miniapp/{utils/lang,pages/shop,pages/product}` | "the variant tag, split EN/CN (never glued) … `variant_label_cn` the Chinese ('大')" — `database.js:3727-3729` | live |
| `variant_noun_en` | TEXT · none | **store only** | `database.js:3736` | `routes/retail.js:18848, 18857` | `routes/retail.js:914` | `public/shop.html`, `miniapp/pages/{shop,product}` | "the variant AXIS noun … Operator types just the noun ('color', 'flavor', 'size')" — `database.js:3731-3735` | live |
| `variant_noun_cn` | TEXT · none | **store only** | `database.js:3737` | as above | as above | as above | Chinese half of the same axis noun | live |
| `low_stock_threshold` | INTEGER · none | **store only** | `database.js:3742` | `routes/retail.js:17861-17867` | `routes/retail.js:915, 13380-13400`, `routes/retail-inventory.js`, `lib/inventory.js` | `public/retail-admin/09-products.js`, `public/retail-admin/02-settings-ops.js` | "per-product low-stock alert threshold. NULL = use the tenant global default … drives the products list amber dot, the Low-stock KPI tile, and the dashboard/alerts" — `database.js:3738-3741` | live |
| `bundle_items` | TEXT · none | **store only** | `database.js:3751` | `routes/retail.js:17888` | `routes/retail.js:919, 8912, 26932`, `resolveBundleComponents` | `public/retail-admin/09-products.js`, `miniapp` | "holds the recipe as JSON `[{id, qty}]` of component product ids + per-unit quantities" — `database.js:3743-3750` | live |
| `bundle_mode` | TEXT · none | **store only** | `database.js:3762` | `routes/retail.js:17891-17894` | `routes/retail.js:17978, 18023` | `public/retail-admin/09-products.js` | "how a bundle product is stocked" — `assembled` (made from other products) vs `prepacked` (own counted stock) — `database.js:3752-3761` | live |
| `no_coupon_on_flash` | INTEGER · none | **store only** | `database.js:3768` | `routes/retail.js:18443-18452`, `:18470-18478` | `routes/retail.js:912`, `lib/flashsales.js` | `public/retail-admin/07-content-billing.js`, `miniapp/utils/cart.js` | "1 = while this product is on an ACTIVE flash sale, its line is excluded from the voucher discount base" — `database.js:3763-3767` | live |
| `supplier_paused` | INTEGER · 0 | **store only** | `database.js:3784` | `routes/retail.js:17911` | `routes/retail.js:918, 8912` | `public/retail-admin/09-products.js`, `public/shop.html`, `miniapp/pages/{product,shop,favorites}`, `miniapp/components/block-renderer` | "the operator's 'the supplier is temporarily out' switch … still visible on the shop but shown 'Temporarily unavailable' and not orderable" — `database.js:3780-3783` | live |
| `image_aspect` | REAL · none | **store only** | `database.js:3790` | `routes/retail.js:17883`, `:18097, 18110`, `:18326`; `scripts/backfill_image_aspect.js` | `routes/retail.js:906` | `public/cms.html`, `public/storefront.html`, `public/shop/blocks.js`, `miniapp/pages/product`, `miniapp/components/block-renderer` | "Mini-app PDP hero aspect ratio … so the product page sizes the hero box to the photo's true shape so nothing crops" — `database.js:3785-3789` | live |
| `tags` | TEXT · none | both | `database.js:70` | `routes/products.js:308` (API accepts it — **no production screen sends it**); `routes/retail.js:17896` via `sanitizeProductBadge`, `:18098, 18110` | `routes/products.js:13, 36`; `routes/retail.js:905` | `public/retail-admin/09-products.js`, `public/shop.html`, `miniapp` (card badge). **Not rendered by `public/app.html`** — every "tags" hit there is prose about HTML tags | Was "a comma-separated free-form bag (dietary, storage, heat)" — `database.js:65-66`. On the store side it has been **repurposed** to hold exactly one badge from `['new','pop','sale','hot']` or the literal `'auto'` (`routes/products.js` comment at `:462-465` says "tags come from… nobody"; store meaning at `routes/retail.js:1084-1089`) | live on `store_products`; write-path-only on `products` |

---

## C. Used by both

Forty-three columns. These are the ones that need a genuine BOTH classification and the concurrent-edit
protection from `docs/tacet-consolidation-decisions.md` §5.

| Name | Type · default | Tables | Defined | Server writes | Server reads | Frontend | Purpose | Dead? |
|---|---|---|---|---|---|---|---|---|
| `id` | INTEGER PK | both | `schema.sql:137` / `database.js:3707` | SQLite autoincrement | everywhere | every surface | Primary key. Ids were **preserved across the fork** (`database.js:3866-3868`) so a given id means the same product on both tables today | live |
| `name_en` | TEXT · none · **NOT NULL** | both | `schema.sql:138` | `routes/products.js:307, 435`; `routes/retail.js:17832`, `:18096, 18102` | everywhere | all surfaces | English product name | live |
| `name_cn` | TEXT · none | both | `schema.sql:139` | `routes/products.js:307`; `routes/retail.js:17845` | everywhere | all surfaces | Chinese product name | live |
| `sku` | TEXT · UNIQUE | both | `schema.sql:140` | `routes/products.js:307, 756-800`; `routes/retail.js:17841-17844`, `:18062, 18096` | everywhere | `app.html`, `pos.html`, `restock.html`, `retail-admin`, `product-editor.html`, `shop.html`, `miniapp` | Stock-keeping code. **Two independent namespaces today** — `store_products` has its own UNIQUE index (`database.js:3793`) | live |
| `category` | TEXT · none | both | `schema.sql:141` | `routes/products.js:442, 502, 701` (auto-mirrored from `top_category`); `routes/retail.js:17932`, `:18567` | `routes/products.js:57, 70, 905`; `routes/ai.js`, `routes/alerts.js`, `routes/sales.js`, `routes/markets.js`; `lib/inventory.js:1379` (substitute suggestions) | `app.html`, `restock.html`, `retail-admin`, `shop.html`/`miniapp` | Legacy single-level category, now **written only as a mirror of `top_category`** — "the operator picker is gone (tree is the only category system), but colophon mapping + any legacy reader still read products.category" — `routes/products.js:439-441`. §19 of the consolidation decisions says delete it | live but derived |
| `top_category` | TEXT · none | both | `database.js:1055` | `routes/products.js:437-438, 493-503, 701`; `routes/retail.js:17922-17932`, `:18096`; `:536-539` (category rename) | `routes/products.js:8, 33`; `routes/retail.js:890, 1472` | `app.html` (2-level picker `:10248`), `retail-admin`, `shop.html`/`miniapp` | "one of the storefront categories (Dry & Pantry, Fresh & Deli, …)" — `database.js:1050-1051` | live |
| `subcategory` | TEXT · none | both | `database.js:1056` | as `top_category` | as `top_category` | as `top_category` | "the section heading within it (Nuts & Seeds, Legumes, …)" — `database.js:1051-1052` | live |
| `status` | TEXT · `'Active'` | both | `schema.sql:143` | `routes/products.js:307, 691` (bulk `set_status`); `routes/retail.js:17915-17918`, `:18071-18072` | `routes/products.js:58, 71`; `routes/pos.js:309, 316`; `routes/retail.js:13390-13414`; `routes/admin.js` | `app.html` (inline edit), `pos.html`, `retail-admin` (`pd-status`) | "Active\|Inactive\|Seasonal\|Coming Soon" — `schema.sql:143`. See **the three live flags** below | live |
| `sell_price` | REAL · 0 | both | `schema.sql:144` | `routes/products.js:307, 347`; `routes/retail.js:17854`, `:18096, 18105` | `routes/products.js:9`; `routes/retail.js:892` (`AS price`), `:8912, 26932` (order pricing); `routes/pos.js`, `routes/waste.js`, `routes/ai.js`, `routes/alerts.js`, `lib/inventory.js:1315` | `app.html`, `pos.html`, `restock.html`, `retail-admin`, `shop.html`/`miniapp` | The selling price. **The single live price** on both sides — `routes/retail.js:886-888` "sell_price is the price … No duplicate retail-only columns to maintain" | live |
| `weight` | TEXT · none | both | `schema.sql:145` | `routes/products.js:307`; `routes/retail.js:17845`, `:18096, 18104` | `routes/products.js:9`; `routes/retail.js:891` (`AS size`) | `app.html` (qty + unit picker `:15193-15197`), `pos.html`, `retail-admin`, `shop.html`/`miniapp` | "freeform: '150g', '1 pc', '200ml'" — `schema.sql:145`. Stored as one human string "so existing reports keep working" (`public/app.html:15191`) | live |
| `barcode` | TEXT · UNIQUE-when-set | both | `schema.sql:146`, index `database.js:104` | `routes/products.js:307`; `routes/retail.js:17845`, `:18096, 18111` | `routes/products.js:132-139` (`/by-barcode/:code`); `routes/pos.js:309`; `routes/retail.js:891` | `app.html` (`field:'barcode'`), `pos.html` (scan gun) | "Barcode for the tablet POS … UNIQUE so a printed barcode can't be assigned to two products by accident" — `database.js:98-102` | live on both tables, but **no store screen shows it** — the store API accepts and returns it and `public/retail-admin/*` never references it |
| `description_en` | TEXT · none | both | `schema.sql:147`, `database.js:24` | `routes/products.js:306, 472-515` (propagates to variant siblings); `routes/retail.js:17845-17850`, `:18096, 18109` | `routes/products.js:10`; `routes/retail.js:904` | `app.html` (rich-text box), `product-editor.html`, `retail-admin`, `shop.html`/`miniapp` | Long English product copy | live |
| `description_cn` | TEXT · none | both | `schema.sql:148`, `database.js:25` | as `description_en` | as `description_en` | as `description_en` | Long Chinese product copy | live |
| `description_format` | TEXT · `'plain'` | both | `database.js:97` | `routes/products.js:306, 353-357`; `public/app.html:11187`; `routes/retail.js:17833-17835`, `:18067` | `routes/retail.js:904`, `:18068-18069` | `retail-admin`, `shop.html`/`miniapp` | "'plain' (text, ## headings) or 'rich' (formatted HTML …)" — `database.js:95-96` | **Write-only on the production side.** `public/app.html:10411, 11930` tests `p.description_format`, but neither `PRODUCT_COLS` (`routes/products.js:7-22`) nor `PRODUCT_LIST_COLS` (`:32-42`) selects it, so that test always sees `undefined` and falls through to the `kaRteLooksLikeHtml()` sniff. Live on the store side |
| `free_of` | TEXT · none | both | `schema.sql:149`, `database.js:26` | `routes/products.js:306, 806, 821`; `routes/retail.js:17845`, `:18096, 18111` | `routes/products.js:10`; `routes/retail.js:905`; `routes/admin.js` | `app.html` (6 checkboxes `:15176`), `retail-admin` (`pdFreeOfSet`), `shop.html`, `miniapp/pages/{product,shop}` | "comma-list: gluten,nuts,soy,dairy,egg,5spice" — `schema.sql:149`. **Dietary column — see the dietary section below** | live |
| `image_data` | TEXT · none | both | `schema.sql:150`, `database.js:27` | `routes/products.js:307, 444-447, 485-489`; `routes/retail.js:17845, 17878`, `:18096, 18110` | `routes/products.js:11, 40, 94`; `routes/retail.js:905`, `lib/inventory.js:1315` | every surface | "base64 data URI" primary photo — `schema.sql:150`. Both sides keep it in sync with `images[0]` | live |
| `images` | TEXT · none | both | `database.js:94` | `routes/products.js:307, 407-414`; `routes/retail.js:17872-17878`, `:18097, 18110`, `:18326` | `routes/products.js:11, 167-169`; `routes/retail.js:18740, 18752` (gallery endpoint) | `app.html` (thumbnail strip), `product-editor.html`, `retail-admin`, `shop.html`/`miniapp` | "JSON array of image srcs …; element [0] mirrors image_data" — `database.js:91-93` | live |
| `notes` | TEXT · none | both | `schema.sql:154` | `routes/products.js:307, 774, 806`; `routes/retail.js:17845`, `:18096, 18111` | `routes/products.js:12`; `routes/retail.js:17977, 18022` | `app.html` (`data-field="notes"`), `restock.html`, `retail-admin` (8 references) | Free-text internal note (INFERRED — no code comment; both editors expose it as an untyped note box) | live |
| `is_active` | INTEGER · 1 | both | `database.js:59` | `routes/products.js:114, 660, 720, 757`; `routes/retail.js:18283`, `:18099` | every product query on both sides gates on `COALESCE(is_active,1)=1` | `app.html` (Trash view), `pos.html`, `retail-admin` | "Switching products from hard-delete to soft-delete" — `database.js:57-58`. See **the three live flags** | live |
| `sort_order` | INTEGER · 0 | both | `database.js:68` | `routes/products.js:308, 371`; `routes/retail.js:18535-18542` (drag reorder) | `routes/products.js:13, 36`; `routes/retail.js:903` (`AS display_order`), `:1480` (default shop sort) | `app.html`, `retail-admin`, `shop.html`/`miniapp` | "honours the upstream display priority (negatives sort first)" — `database.js:63`. Now the shop's curated "featured" order (`routes/retail.js:1476-1480`) | live |
| `stock_qty` | INTEGER · 0 | both | `database.js:69` | `routes/products.js:308, 372, 642` (`/stock-adjust`); `routes/retail.js:17860`, `:18096, 18107` | `routes/products.js:13, 36, 625`; `routes/pos.js:309`; `routes/ai.js`, `routes/alerts.js`; `routes/retail.js:902` **as a fallback only** | `app.html`, `pos.html`, `retail-admin` | "a snapshot updated by sales/waste/restock movements" — `database.js:64`. On the store side it is the **last-resort fallback** behind per-store `retail_store_stock` (`lib/inventory.js:184-197`, comment `routes/retail.js:894-901`). §10 of the consolidation decisions retires it | live but being retired |
| `variant_group_id` | INTEGER · none | both | `database.js:77` | `routes/products.js:262, 281, 309`; `routes/retail.js:18320, 18848-18857` | `routes/products.js:14, 220-228`; `routes/retail.js:913`, `:8912, 26932` | `app.html` (variant chips), `product-editor.html`, `retail-admin`, `shop.html`/`miniapp` | "products that share `variant_group_id` are siblings of one another" — `database.js:72-73` | live |
| `variant_label` | TEXT · none | both | `database.js:78` | `routes/products.js:262, 281, 309`; `routes/retail.js:18848-18857` | `routes/products.js:14, 222`; `routes/pos.js:309`; `routes/retail.js:913` | `app.html`, `pos.html`, `retail-admin`, `shop.html`/`miniapp` | "the axis-specific tag for THIS variant (e.g. 'Mint', '150g', 'Crunchy')" — `database.js:74-75` | live |
| `variant_sort` | INTEGER · 0 | both | `database.js:81` | `routes/products.js:295` (`/variants/reorder`); `routes/retail.js:18857` | `routes/products.js:14, 227`; `routes/retail.js:913` | `app.html` (drag reorder), `retail-admin`, `shop.html`/`miniapp` | "Operator-chosen display order of siblings within a group … Lower = shown first" — `database.js:79-80` | live |
| `bundle` | TEXT · none | both | `database.js:85` | `routes/products.js:326, 386-406`; `public/app.html` `iedSaveField(…,'bundle')`; `routes/retail.js:17885` | `routes/products.js:19, 159-163`; `routes/retail.js:17978`, `resolveBundle():1090-1105` | `app.html`, `retail-admin`, `shop.html`/`miniapp` | "'Buy together' bundle shown on this product's page … No bundle SKU" — `database.js:82-84`. **Distinct from `bundle_items`**, which is a real bundle product | live |
| `is_market` | INTEGER · 0 | both | `database.js:132` | `routes/products.js:310, 348, 706`; `routes/retail.js:17913`, `:18098, 18113` | `routes/products.js:15, 38, 134`; `routes/retail.js:17977`; `routes/retail-inventory.js:246` | `app.html` (checkbox `:10810`), `pos.html`, `retail-admin` | "'Available at markets' gate — when true, this product appears in the Markets POS search" — `database.js:128-131` | live |
| `is_restock_only` | INTEGER · 0 | both | `database.js:152` | `routes/products.js:310, 349, 711`; `routes/retail.js:17914`, `:18098, 18113` | `routes/products.js:15, 38, 135`; `routes/retail.js:17977`; `routes/retail-inventory.js:247` | `app.html`, `pos.html`, `restock.html`, `retail-admin` | "for items that are kitchen-internal … excluded from POS / miniapp / Meituan search, but still appears in the Restock app's picker" — `database.js:147-151` | live |
| `is_published` | INTEGER · 0 | both | `database.js:996` | `routes/products.js:313, 350, 716`; `routes/retail.js:17764`, `:18099, 18114`, `:18283` | `routes/products.js:15, 38, 223`; `routes/retail.js:1451` (**the customer catalogue gate**), `:13390-13414`; `routes/retail-inventory.js:183, 244` | `app.html` (🛍 SHOP badge + filter), `product-editor.html`, `retail-admin` | Shop visibility. See **the three live flags** | live on both, but the `products` copy no longer reaches customers |
| `nutrition` | TEXT · none | both | `database.js:1007` | `routes/products.js:324, 374-385`; `public/app.html` `pfNutrCollect()`; `routes/retail.js:17791-17809`, `:18324` | `routes/products.js:17`; `routes/retail.js:907`, `:17998-18005` | `app.html` (modal), `product-editor.html` (`paCollectNutrition`), `retail-admin`, `shop.html`/`miniapp` | "Nutrition facts panel. JSON-encoded … `{ basis_en, basis_cn, rows:[{label_en,label_cn,value}] }`" — `database.js:1003-1006`. **Dietary column** | live |
| `keywords_en` | TEXT · none | both | `database.js:1013` | `routes/products.js:328`; `routes/retail.js:17765-17768`, `:18324` | `routes/products.js:18`; `routes/retail.js:908`, `:1461` (shop search) | `app.html` (`pf_keywords_en`), `product-editor.html`, `retail-admin`, `miniapp` | "short comma-separated descriptors that appear in green next to the other-language name, e.g. 'raw, alive'" — `database.js:1009-1010` | live |
| `keywords_cn` | TEXT · none | both | `database.js:1014` | as `keywords_en` | as `keywords_en` | as `keywords_en` | Chinese half of the same | live |
| `tagline_en` | TEXT · none | both | `database.js:1015` | `routes/products.js:328`; `routes/retail.js:17765-17768`, `:18324` | `routes/products.js:18`; `routes/retail.js:908, 992`, `:1461` | `app.html`, `product-editor.html`, `retail-admin`, `shop.html`/`miniapp` | "the bold one-liner slogan below the subtitle, e.g. 'Your gut deserves better'" — `database.js:1011-1012` | live |
| `tagline_cn` | TEXT · none | both | `database.js:1016` | as `tagline_en` | as `tagline_en` | as `tagline_en` | Chinese half of the same | live |
| `description_blocks` | TEXT · none | both | `database.js:1024` | `routes/products.js:330, 415-425, 472-515`; `public/app.html` `iedSaveField(…,'description_blocks')`; `routes/retail.js:17770-17784`, `:18324` | `routes/products.js:19`; `routes/retail.js:909`, `:17983-17987` | `app.html`, `product-editor.html` (`paBlocksCollect`), `retail-admin`, `miniapp` | "Block-based product page body. JSON array of `{id, type, …data}` … When non-empty the mini-app renders it INSTEAD of the legacy description textareas" — `database.js:1017-1023` | live |
| `use_block_design` | INTEGER · 0 | both | `database.js:1031` | `routes/products.js:333, 351, 472-515`; `routes/retail.js:17782-17786`, `:18324` | `routes/products.js:19`; `routes/retail.js:909` | `app.html`, `retail-admin` (`pdSaveBlockFlag`), `miniapp` | "which description renderer the mini-app product page uses … Without this flag, blocks would silently win the moment any were authored" — `database.js:1025-1030` | live |
| `page_template` | TEXT · none | both | `database.js:1040` | `routes/products.js:337`; `routes/retail.js:17765-17768` | `routes/products.js:19`; `routes/retail.js:909`, `:17979, 18025` | `product-editor.html`, `miniapp`. **Not present in `public/app.html`** | "Which product-page TEMPLATE the block design is built from … just a label of provenance" — `database.js:1032-1039` | live on the store side; accepted but never surfaced by any production screen |
| `colophon_character` | TEXT · none | both | `database.js:1047` | `routes/products.js:340`; `routes/retail.js:17765-17768`, `:18324` | `routes/products.js:20`; `routes/retail.js:910` | `product-editor.html`, `retail-admin`, `miniapp`. **Not present in `public/app.html`** | "IP key like 'soilsoul' / 'skater' / … Blank → auto-pick" by category — `database.js:1041-1045` | live on the store side; production API-only |
| `colophon_tagline_en` | TEXT · none | both | `database.js:1048` | as `colophon_character` | as `colophon_character` | as `colophon_character` | "bilingual override of 'From Soil to Soul'" — `database.js:1046` | as above |
| `colophon_tagline_cn` | TEXT · none | both | `database.js:1049` | as `colophon_character` | as `colophon_character` | as `colophon_character` | Chinese half of the same | as above |
| `ship_modes` | TEXT · `'air,land'` | both | `database.js:2743` | `routes/products.js:318, 359-368`; `public/app.html:11010`; `routes/retail.js:17869-17871`, `:18063, 18096` | `routes/products.js:16, 39`; `routes/retail.js:905`, `:8118, 8215, 8328, 8703, 8912`; snapshotted onto `retail_order_items:9466` | `app.html` (air/land chips), `retail-admin` | "a comma-separated subset of {'air','land'} … items rejected by airlines (liquids, lithium, frozen) should be set to 'land' only" — `database.js:2737-2740` | live |
| `is_batch_made` | INTEGER · 0 | both | `database.js:2761` | `routes/products.js:322, 352`; `routes/retail.js:17897` | `routes/products.js:16, 39`; `routes/retail.js:916`, `effectiveOosPolicy():940`, `:8912, 26932` | `app.html` (checkbox `:10812`), `retail-admin`, `miniapp` | "short shelf-life items (fresh meals, wraps) the kitchen makes on a fixed every-N-days cadence. Outside-Guangzhou orders containing one must wait for the next production batch" — `database.js:2755-2760` | live |
| `created_at` | DATETIME · `CURRENT_TIMESTAMP` | both | `schema.sql:155` | SQLite default; explicit `routes/retail.js:18099, 18326` | `routes/products.js:12`; `routes/ai.js` (`p.created_at`); `routes/retail.js:1479` (`sort=newest`), `:2078` | `app.html`, `pos.html`, `restock.html`, `retail-admin`, `shop.html`/`miniapp` | Row creation timestamp | live |
| `updated_at` | DATETIME · `CURRENT_TIMESTAMP` | both | `schema.sql:156`, re-added `database.js:60` | Set on **every** write on both sides (`routes/products.js:114, 262, 506…`; `routes/retail.js:17942, 18099…`) | `routes/products.js:12, 80`; `routes/retail.js:920`, `lazifyProductImage` cache-buster | image cache-busting on all surfaces | Last-write timestamp. §5 of the consolidation decisions wants `updated_by` alongside it — **that column does not exist on either table today** | live |

---

## D. Dead or partially dead

Eight columns, plus the per-table dead halves already noted in A, B and C. Definitions used:
**DEAD** = no server or frontend code reads it anywhere. **PARTIALLY DEAD** = written but never read,
or read but never written.

| Name | Type · default | Tables | Defined | Server writes | Server reads | Frontend | Purpose | Verdict |
|---|---|---|---|---|---|---|---|---|
| `retail_price` | REAL · 0 | both | `database.js:997` | **No live route.** Only `scripts/import_full.js:150` and `scripts/import_yogurt.js:24` (one-off imports, `store_products`) | `routes/retail-inventory.js:187, 243` — SELECTed into the inventory grid + per-store stock list | **None.** Zero references in `public/` or `miniapp/` | Pre-fork retail price, superseded by `sell_price` ("No duplicate retail-only columns to maintain" — `routes/retail.js:886-888`) | **PARTIALLY DEAD** — read into two API payloads that no screen renders; no live writer. Dead outright on `products` |
| `retail_stock` | INTEGER · 0 | both | `database.js:998` | Only `scripts/import_full.js:150`, `scripts/import_yogurt.js:24` | **None.** The only textual hit, `routes/retail.js:7777`, is a comment | None | Pre-fork retail stock, superseded by `retail_store_stock` | **PARTIALLY DEAD** (written by two scripts, read by nothing). Dead outright on `products` |
| `retail_display_order` | INTEGER · 0 | both | `database.js:999` | none | none | none | Pre-fork shop ordering, superseded by `sort_order` | **DEAD** on both tables |
| `retail_tagline` | TEXT · none | both | `database.js:1000` | none | none | none | Pre-fork shop tagline, superseded by `tagline_en` / `tagline_cn` | **DEAD** on both tables |
| `retail_description_en` | TEXT · none | both | `database.js:1001` | none | none | none | Pre-fork shop copy, superseded by `description_en` | **DEAD** on both tables |
| `retail_description_cn` | TEXT · none | both | `database.js:1002` | none | none | none | Pre-fork shop copy, superseded by `description_cn` | **DEAD** on both tables |
| `needs_ice_pack` | INTEGER · 0 | both | `database.js:2744` | **No live route.** `routes/products.js:316-317` states it was deliberately retired from the production form: "The legacy needs_ice_pack cold-chain flag was retired — anything shipped by air is packed with ice anyway". The store PATCH handler never sets it | `routes/retail.js:8912, 26932` (read off `store_products` at checkout), copied onto `retail_order_items` at `:9466, 9476, 26617, 26635`, read back at `:8118, 8215, 8328, 8703, 19716` | `public/retail-admin/04-orders.js:5387` — decides the ice-pack argument to `createJdLabel()` | "triggers the cold-chain badge in retail-admin so the packer pulls ice from the freezer" — `database.js:2741-2742` | **PARTIALLY DEAD — and this one is live-facing.** No operator can set it, yet the JD label flow still reads it, so it is permanently 0 for anything created since. Worth a decision at merge time, not a silent drop |
| `label_url` | TEXT · none | both | `schema.sql:153` | none | `routes/retail.js:24549` — one media-garbage-collection scan that looks for `/api/retail/media/` references | none | "reserved for future CDN-hosted labels" — `schema.sql:153` | **PARTIALLY DEAD** — read by one housekeeping sweep, never written by anything |

The five outright-DEAD pre-fork columns (`retail_display_order`, `retail_tagline`,
`retail_description_en`, `retail_description_cn`, plus `synced_at` in section E) are the only
columns on either table with **zero** code references outside `database.js`.

---

## E. Fork plumbing

Four columns, all `store_products`-only, all added at `database.js:3713-3717`. They exist so a future
one-way "pull from kitchen" sync can re-integrate the two catalogues — "the sync job itself is NOT
built yet" (`database.js:3689-3690`).

| Name | Type · default | Tables | Defined | Server writes | Server reads | Frontend | Purpose | Verdict |
|---|---|---|---|---|---|---|---|---|
| `kitchen_product_id` | INTEGER · none | store only | `database.js:3714` | `database.js:3866-3868` — the **one-time** seed `INSERT … SELECT …, id, sku, 'fork' FROM products`. Guarded by `_migrations` name `store_products_seed_fk_v1`, so it runs once per database and never again | none | none | "source products.id at fork time" — `database.js:3714`. Indexed at `database.js:3796` | **PARTIALLY DEAD** — populated once, never read |
| `source_sku` | TEXT · none | store only | `database.js:3715` | same one-time seed | none | none | "SKU at fork time (stable match key)" — `database.js:3715` | **PARTIALLY DEAD** — populated once, never read |
| `synced_at` | DATETIME · none | store only | `database.js:3716` | **none** — not even the seed sets it | none | none | "reserved: last pull-from-kitchen" — `database.js:3716` | **DEAD** — never written, never read. (Every `synced_at` hit in `routes/retail.js` is `retail_orders.tracking_synced_at`, a different column) |
| `source` | TEXT · `'fork'` | store only | `database.js:3717` | same one-time seed, always the literal `'fork'` | none | none | "'fork' \| (future) 'sync'" — `database.js:3717` | **PARTIALLY DEAD** — populated once, never read |

**Consequence for the merge:** the fork link is not usable as-is. Rows created in `store_products`
*after* the seed (every product added from the Mini App Backend since — `routes/retail.js:18094-18115`
and `:18324-18337` both omit all four columns) carry `NULL` in `kitchen_product_id` and `source_sku`
and `NULL` in `source` rather than any marker. So these columns cannot tell you which store products
have a production counterpart. Matching at merge time has to be done on `sku`, and the two tables
hold **independent SKU namespaces** (`database.js:3791-3793`).

---

## The four specific questions

### 1. The pre-fork retail-ish columns on `products` (`database.js:996-1002`)

Question: are they still read by any live path now that tenant 1 is `product_catalog_mode='self'`?

Answer: **none of the seven is read from the `products` table by any live path**, in `self` mode or
any other. Six are also unread from `store_products`; the seventh, `retail_price`, is read from
`store_products` only.

| Column | Read from `products`? | Read from `store_products`? | Live writer? |
|---|---|---|---|
| `is_published` | **Yes** — `routes/products.js:15, 38, 223` (list badge, filter, sibling chips) | Yes — the customer catalogue gate, `routes/retail.js:1451` | Both sides |
| `retail_price` | No | Yes — `routes/retail-inventory.js:187, 243`, into a payload no screen renders | No live route; two one-off scripts |
| `retail_stock` | No | No | Two one-off scripts |
| `retail_display_order` | No | No | No |
| `retail_tagline` | No | No | No |
| `retail_description_en` | No | No | No |
| `retail_description_cn` | No | No | No |

`product_catalog_mode` does not gate any of this. It has exactly one effect in the code
(`routes/retail.js:179-196, 17759-17763, 18053`): in `upstream` mode the store PATCH/POST handlers
silently drop nine source-owned fields (`name_en`, `name_cn`, `sku`, `sell_price`,
`compare_at_price`, `weight`, `category`, `top_category`, `subcategory`, `stock_qty`) and refuse
product creation. In `self` mode — tenant 1 today — nothing is dropped. It never routes a read to
`products`. **Every customer-facing read goes to `store_products` regardless of mode.**

So `products.is_published` is now a **production-app-only display flag**: it still drives the
"🛍 SHOP" badge and the published filter in `public/app.html:8193, 8414, 8784, 9105`, but flipping it
no longer changes what any customer sees. The customer gate is `store_products.is_published`
(`routes/retail.js:1451`).

The other six are safe to drop. `retail_price` should be checked out of the two
`routes/retail-inventory.js` SELECTs first — harmless payload noise, but it is a live SELECT.

### 2. Columns holding nutritional or dietary information

Five columns, plus one JSON structure inside a sixth.

| Column | Table(s) | What it holds | Where |
|---|---|---|---|
| `nutrition` | both | The nutrition facts panel, JSON: `{ basis_en, basis_cn, rows:[{label_en, label_cn, value}] }`. Basis varies per product ("per 100ml vs per 100g vs per serving") | `database.js:1003-1007`; written `routes/products.js:374-385` and `routes/retail.js:17791-17809`; rendered on the mini-app PDP |
| `free_of` | both | Allergen-free claims as a comma list. Production form offers exactly six: `gluten, nuts, soy, dairy, egg, 5spice` | `schema.sql:149`, `database.js:26`; form `public/app.html:15176`; store editor `pdFreeOfSet` |
| `product_facts` | **store only** | Flexible per-product-type bag stored as JSON — the schema comment names "origin/ingredients/…" as its content. Generic string map, max 60 keys, 4000 chars each | `database.js:3724-3726`; written `routes/retail.js:17815-17828` |
| `description_blocks` | both | Not solely dietary, but the block registry includes bespoke **`allergen_card`** and **`ingredients`** block types, so ingredient and allergen copy lives inside this JSON as well | `database.js:1017-1020` |
| `tags` | both | Originally "a comma-separated free-form bag (**dietary**, storage, heat)". **This is no longer true on the store side** — the store sanitiser reduces it to one badge from `['new','pop','sale','hot']` or `'auto'` | `database.js:64-66` vs `routes/retail.js:1084-1089` |
| *(derived)* | — | Not a column: `routes/products.js:180-199` aggregates allergens from the linked recipe's ingredients and returns them as `derived_allergens`, so the production editor can show "from recipe (auto)". Only works where `recipe_id` is set | `routes/products.js:170-199` |

There is **no** kcal / macro / ingredient-list column of its own. Everything nutritional is inside
`nutrition`, `product_facts` or `description_blocks` as JSON. That matches
`docs/tacet-consolidation-decisions.md` §4, which names nutritional facts as the example of a BOTH field.

### 3. The three overlapping 'live' flags

All three exist on both tables. Here is exactly what each controls in the code as it stands.

**`is_active` (INTEGER, default 1) — soft delete. The strongest of the three.**
Every product query on both sides is wrapped in `COALESCE(is_active, 1) = 1`. Setting it to 0 removes
the product from the production list, the POS, the customer catalogue, the store editor and the
restock picker at once, while leaving `waste_entries`, `restock_items`, order lines and reviews
resolving correctly (`database.js:57-58`, `routes/products.js:654-663`).
- Production write: `routes/products.js:660` (delete), `:114` (restore), `:720` (bulk delete), `:757` (re-import reactivates).
- Store write: `routes/retail.js:18283` — and note the store delete does **more**: it sets
  `is_active = 0, is_published = 0, sku = NULL` in one statement. Blanking the SKU is what
  `docs/tacet-consolidation-decisions.md` §18 overrides.

**`is_published` (INTEGER, default 0) — shop visibility. The customer gate.**
`store_products.is_published = 1 AND COALESCE(is_active,1) = 1` is the **entire** WHERE clause of the
customer catalogue (`routes/retail.js:1450-1451`), of the PDP (`:2232`), and of every add-to-cart /
checkout product lookup (`:8912, 26932`). It also gates the dashboard low-stock and out-of-stock
tiles (`:13390-13414`) and the inventory grid's `?published=1` filter
(`routes/retail-inventory.js:183, 244`).
`products.is_published` controls nothing outside `public/app.html`'s own badge and filter — see
question 1.

**`status` (TEXT, default `'Active'`; values `Active | Inactive | Seasonal | Coming Soon`) — the weakest.**
It gates only three things, none of them the shop:
1. `routes/pos.js:316` — the POS top-sellers list drops rows whose `status === 'Inactive'`.
2. `routes/retail.js:13390, 13398, 13407, 13414` — the store dashboard's low-stock and OOS counters
   require `status = 'Active'` **on top of** `is_published = 1` and `is_active = 1`. The comment
   there is explicit: "status='Active' just means 'not archived'".
3. `routes/products.js:58, 71` — an optional `?status=` filter on the production list.

A product with `status = 'Inactive'`, `is_active = 1` and `is_published = 1` **is still fully
purchasable by customers.** Nothing in the checkout path reads `status`. `Seasonal` and
`Coming Soon` are stored and displayed but drive no behaviour anywhere.

That is the redundancy `docs/tacet-consolidation-decisions.md` §16 collapses into one three-position state.
The mapping the code supports today is: `is_active = 0` → ARCHIVED; `is_active = 1, is_published = 1`
→ IN SHOP; `is_active = 1, is_published = 0` → NOT IN SHOP; `status` carries no information that
needs to survive except as an optional customer-facing tag.

### 4. Columns holding cost, price or margin

**There is no cost column on either table.** Not one. Confirmed by reading the full column list of
both tables: `schema.sql:136-158` plus every `addColumn('products', …)` (51 calls) and every
`addColumn('store_products', …)` (11 calls).

Everything price-shaped is **selling-side**:

| Column | Side | What it is |
|---|---|---|
| `sell_price` | selling | The live price on both tables. What the customer pays absent a flash sale (`routes/retail.js:892`, `:8912`) |
| `retail_price` | selling | Pre-fork duplicate of `sell_price`. No live writer — see section D |
| `compare_at_price` | selling | The struck-through was-price. Display only; never charged (`database.js:87-89`) |
| `flash_price` | selling | Overrides `sell_price` inside the flash window (`database.js:1061-1062`) |

Cost reaches a product only **indirectly**, through `recipe_id` → `recipes` → `recipe_cost_data`
(`schema.sql:122-133`), joined at `routes/products.js:201-207` and used by `routes/waste.js`
(`SELECT sell_price, recipe_id …`) to value waste. A product with no `recipe_id` — which is every row
in `store_products`, since `recipe_id` is dead there — **has no cost at all**.

Margin is therefore not computable on the store side today. `docs/tacet-consolidation-decisions.md`
§23 records the COST METHOD decision as still open, and it would have to be settled before margin
could be displayed. It cannot be deferred by picking a different column, because no cost column
exists to pick.

---

## CONTESTED WRITES

Columns that **both** a production file and a store file write. Today the two writes land on
different tables, so nothing is being overwritten. **The moment the tables merge, every row below is
a place where the two apps can silently overwrite each other**, unless the version stamp from
`docs/tacet-consolidation-decisions.md` §5 is in place first.

Production writer is `routes/products.js` in every case (the only live writer of `products`;
`scripts/import_*.js` also write, but only ad hoc). Store writer is `routes/retail.js` unless noted.

**Forty-one contested columns.** The last three (`description_format`, `page_template`,
`updated_at`) are contested but low-consequence; the other thirty-eight are real overwrite risk.

| # | Column | Production write | Store write | Why it matters |
|---|---|---|---|---|
| 1 | `name_en` | `:307, 435, 763` | `:17832`, `:18096` | Both editors let a user rename freely |
| 2 | `name_cn` | `:307, 764` | `:17845`, `:18096` | Same |
| 3 | `sku` | `:307, 756-800` | `:17841-17844`, `:18062` | **Highest risk.** Two independent UNIQUE namespaces merging into one; the store also mints `DRAFT-XXXXX` codes and blanks SKUs on delete |
| 4 | `category` | `:442, 502, 701, 765` | `:17932`, `:18567` | Both auto-mirror it from `top_category`, by two different code paths |
| 5 | `top_category` | `:437-438, 493-503, 701` | `:17922-17932`, `:536-539` | Both validate against the same tree but hold separate trees today |
| 6 | `subcategory` | `:437-438, 493-503, 701` | `:17922-17932`, `:544-547` | Same |
| 7 | `status` | `:307, 691, 767` | `:17915-17918`, `:18071` | Same four-value list, two writers |
| 8 | `sell_price` | `:307, 347, 768` | `:17854`, `:18096` | **Money.** Two apps can price the same product differently |
| 9 | `weight` | `:307, 769` | `:17845`, `:18096` | Free-text; no shared format |
| 10 | `barcode` | `:307, 770` | `:17845`, `:18096` | Store API accepts it with no store UI, so a store round-trip could clear a scanned code |
| 11 | `description_en` | `:306, 472-515, 771` | `:17845-17850`, `:18096` | Production **propagates to variant siblings** (`:510-515`); the store does not. A production edit will overwrite per-variant store copy |
| 12 | `description_cn` | `:306, 472-515, 772` | `:17845-17850`, `:18096` | Same |
| 13 | `description_format` | `:306, 353-357` | `:17833-17835`, `:18067` | Production writes it but never reads it back (see section C) |
| 14 | `free_of` | `:306, 773, 806` | `:17845`, `:18096` | **Allergen data written by two apps** |
| 15 | `image_data` | `:307, 444-447, 485-489` | `:17845, 17878`, `:18096` | Both keep it in sync with `images[0]`, independently |
| 16 | `images` | `:307, 407-414` | `:17872-17878`, `:18097` | Both cap at 8 and re-derive the primary |
| 17 | `notes` | `:307, 774` | `:17845`, `:18096` | Same box, two apps |
| 18 | `is_active` | `:114, 660, 720, 757` | `:18283` | **Asymmetric.** The store delete also nulls `sku` and clears `is_published`; the production delete does not |
| 19 | `sort_order` | `:308, 371` | `:18535-18542` | Production takes it from import; the store drag-reorders it. Guaranteed to fight |
| 20 | `stock_qty` | `:308, 372, 642` | `:17860`, `:18096` | **Stock.** Production `/stock-adjust` writes an `activity_log` row; the store PATCH writes neither ledger nor log |
| 21 | `variant_group_id` | `:262, 281, 309` | `:18320, 18848-18857` | Two different grouping UIs over one column |
| 22 | `variant_label` | `:262, 281, 309` | `:18848-18857` | Production has no `variant_label_cn`; a production write leaves the CN half stale |
| 23 | `variant_sort` | `:295` | `:18857` | Two reorder UIs |
| 24 | `bundle` | `:326, 386-406` | `:17885` | Both sanitise to the same JSON shape, separately |
| 25 | `is_market` | `:310, 348, 706` | `:17913`, `:18098` | Store editor calls these "kitchen-parity flags brought over so the store editor is a full superset" (`routes/retail.js:17912`) |
| 26 | `is_restock_only` | `:310, 349, 711` | `:17914`, `:18098` | Same |
| 27 | `is_published` | `:313, 350, 716` | `:17764`, `:18099, 18283` | **Shop visibility written by both.** Production's copy is inert today; after the merge it will not be |
| 28 | `nutrition` | `:324, 374-385` | `:17791-17809` | **Nutritional data written by two apps** — exactly the BOTH case §4 anticipates |
| 29 | `keywords_en` | `:328` | `:17765-17768` | Also written by `public/product-editor.html` |
| 30 | `keywords_cn` | `:328` | `:17765-17768` | Same |
| 31 | `tagline_en` | `:328` | `:17765-17768` | Same |
| 32 | `tagline_cn` | `:328` | `:17765-17768` | Same |
| 33 | `description_blocks` | `:330, 415-425, 472-515` | `:17770-17784` | **Three writers**: production form, store editor, and `public/product-editor.html`. The store path also auto-flips `use_block_design` to 1 (`:17782-17784`); production does not |
| 34 | `use_block_design` | `:333, 351, 472-515` | `:17782-17786` | Written as a side effect on the store side only |
| 35 | `page_template` | `:337` | `:17765-17768` | Production accepts it with no UI |
| 36 | `colophon_character` | `:340` | `:17765-17768` | Same |
| 37 | `colophon_tagline_en` | `:340` | `:17765-17768` | Same |
| 38 | `colophon_tagline_cn` | `:340` | `:17765-17768` | Same |
| 39 | `ship_modes` | `:318, 359-368` | `:17869-17871`, `:18063` | Both normalise to the same csv, separately |
| 40 | `is_batch_made` | `:322, 352` | `:17897` | Drives store shipping promises; a production toggle changes customer-facing delivery dates |
| 41 | `updated_at` | every write | every write | Both stamp it; neither records **who** |

Three points worth pulling out of that list:

- **`description_en` / `description_cn` / `description_blocks` / `use_block_design` /
  `description_format` propagate to variant siblings on the production side only**
  (`routes/products.js:461-472, 510-515`). After the merge, one production save on a variant will
  overwrite the copy on every sibling, including copy authored per-variant in the store editor.
- **`is_active = 0` means two different things.** Production keeps the SKU; the store blanks it
  (`routes/retail.js:18283`). `docs/tacet-consolidation-decisions.md` §18 already resolves this in favour of
  keeping the SKU — worth doing before the tables merge, not after.
- **`stock_qty` is the only contested column with an audit asymmetry.** The production path
  (`routes/products.js:623-651`) demands a reason and writes `activity_log`; the store path
  (`routes/retail.js:17860`) writes the number with no reason, no ledger and no log. §10 retires
  this column, which removes the problem — but only if it is retired rather than merged.

---

## Related documents

- `docs/tacet-consolidation-decisions.md` — §4 (this classification), §5 (concurrent edit safety), §10
  (stock), §16 (product state), §18 (SKU on archive), §19 (categories), §22 (open questions)
- `docs/tacet-core-survey.md` — current-state inventory, 2026-07-30
- `docs/tacet-stock-model.md` — stock and reservation behaviour, 2026-07-30
