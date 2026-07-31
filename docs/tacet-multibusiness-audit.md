# Tacet multi-business audit — where the system is still Roots

**2026-07-31 · Read-only audit of the whole repository against the three governing rules in `docs/tacet-consolidation-decisions.md` §0. Nothing was changed. This document only makes the problem visible.**

Audited at `origin/main` = `1d8e95ad`. Scope: code, frontend, database schema, seed data, configuration, deployment, `docs/`. `public/app.html.bak` excluded as instructed.

The test applied throughout: **would this work for a hardware shop in Ohio, or a bakery in Lisbon?**

---

## Summary

### Findings per category

| | Category | Findings | Blocker | Friction | Cosmetic |
|---|---|---|---|---|---|
| A | Full Circle residue | 14 | 0 | 3 | 11 |
| B | Roots-specific hardcoding | 21 | 6 | 12 | 3 |
| C | Geography and locale | 15 | 4 | 10 | 1 |
| D | Currency and money | 9 | 3 | 5 | 1 |
| E | Language | 11 | 4 | 6 | 1 |
| F | Units of measure | 6 | 2 | 4 | 0 |
| G | Industry assumptions | 12 | 2 | 9 | 1 |
| H | Sales channels | 9 | 2 | 6 | 1 |
| I | Business rules as universal law | 11 | 3 | 8 | 0 |
| J | Documentation | 13 | 0 | 6 | 7 |
| | **Total** | **121** | **26** | **69** | **26** |

### Severity key

- **BLOCKER** — a second business genuinely cannot use the system.
- **FRICTION** — usable, but wrong or embarrassing.
- **COSMETIC** — naming and wording only.

### What would actually break first

**A second business cannot get through the front door at all.** In that order:

1. **They can't sign up.** Public signup is closed by default. `routes/backend-signup.js:15` gates provisioning on `BACKEND_SIGNUP_OPEN=1`; with it unset, `/backend/signup` is a waitlist form that stores a lead and provisions nothing (`routes/backend-signup.js:17-22`). Only a kitchen `admin` — a Roots staff account — can create a tenant.

2. **If someone provisions them by hand, the admin is locked.** `server.js:256-264` redirects every non-Roots backend tenant away from `/retail-admin`, `/product-editor` and `/cms` to `/backend/billing?provisioning=1`, and 403s their API calls, unless `TENANT_DATA_ISOLATION=1`. That flag defaults off (`lib/tenant-db.js:41`) and is set nowhere in the repo or the deploy workflow. So the second business logs in and sees a billing page.

3. **If the flag is turned on, they land in a database seeded as Roots.** A fresh main database seeds two Guangzhou stores named "Roots Kitchen — Tianhe" and "Roots Kitchen — Yuexiu" (`database.js:3220`, `database.js:3263`), a Guangzhou kitchen address (`database.js:2503`), a plant-based About page and manifesto (`database.js:1926`, `database.js:2138`), a 7-branch vegan grocery category tree (`lib/category-tree.js:17`), a "Roots Club" tier ladder (`routes/retail.js:6982`), and an AI memory row that states the business is "Plant-based food business in Guangzhou" (`database.js:563`). Per-tenant databases are schema-only clones so they escape most of this — but any *fresh deployment* of Tacet for a new customer gets all of it.

4. **Then money and language.** Every price is displayed with a currency the operator can pick (`public/retail-admin/05-marketing.js:1338`) but **charged only in RMB** — the presets carry a comment saying so, and the only implemented payment providers are WeChat Pay v3 and Alipay. A shop in Ohio cannot take a payment. Separately, every operator-facing label in the admin is a hardcoded English/Chinese pair — 2,510 `cuT('en','中文')` call sites — so a Portuguese bakery reads its own back office in English or Chinese, with no third option.

The shortest honest statement: **Tacet today is a single-tenant Roots installation with multi-tenant scaffolding built around it and switched off.**

---

## A. Full Circle residue

The name is retired by rule 1. It survives in 31 code files, plus docs and 3 PDFs. Most are comments; the ones below are live UI, live config, or live behaviour.

| # | File and line | Assumption | Severity |
|---|---|---|---|
| A1 | [public/full-circle.html](public/full-circle.html) (whole file, 900+ lines), routed at [server.js:713-717](server.js:713) | A public marketing landing page for "Full Circle", served live at `/full-circle`. Title, wordmark, hero, footer, contact mailto `hello@fullcircle.example`. Includes a section "Roots runs on Full Circle." (`:602`) | FRICTION |
| A2 | [routes/backend-auth.js:260](routes/backend-auth.js:260) | Boot seeds tenant #1 with `brand_name = 'Full Circle'`. The dead brand is written into the database on every fresh install | FRICTION |
| A3 | [routes/backend-auth.js:266](routes/backend-auth.js:266), [:304](routes/backend-auth.js:304) | The seeded owner password is the literal string `FullCircle2026!`, and boot checks for it by name | FRICTION |
| A4 | [public/backend-signup.html:5](public/backend-signup.html:5), [:61](public/backend-signup.html:61), [:102](public/backend-signup.html:102) | Signup page title and wordmark say "Full Circle". This is the first page a new business ever sees | COSMETIC |
| A5 | [public/backend-billing.html:5](public/backend-billing.html:5), [:101](public/backend-billing.html:101) | Billing page title and chrome wordmark | COSMETIC |
| A6 | [public/saas-admin.html:5](public/saas-admin.html:5), [:111](public/saas-admin.html:111) | Platform admin console title and wordmark | COSMETIC |
| A7 | [public/product-editor.html:7](public/product-editor.html:7), [:1376](public/product-editor.html:1376), [:2934](public/product-editor.html:2934) | Page title, on-screen wordmark `FULL CIRCLE`, and an error toast "Not a Full Circle template file" | COSMETIC |
| A8 | [routes/billing-pay.js:82](routes/billing-pay.js:82) | Customer-visible error text: "managed directly by Full Circle · 由 Full Circle 直接…" | COSMETIC |
| A9 | [lib/billing-providers.js:115](lib/billing-providers.js:115) | WeChat Pay order description sent to the payment gateway: `'Full Circle subscription · 订阅费'` — appears on the payer's bank record | COSMETIC |
| A10 | [routes/retail.js:17177](routes/retail.js:17177) | System-alert test message pushed to WeCom: "Full Circle system notifications are wired to this group" | COSMETIC |
| A11 | [lib/provision-tenant.js:19](lib/provision-tenant.js:19) | Documented platform domain example is `shop.fullcircle.app`; used to build every tenant's free subdomain | COSMETIC |
| A12 | [miniapp/pages/me/me.js:223](miniapp/pages/me/me.js:223), [:225](miniapp/pages/me/me.js:225), [:360-362](miniapp/pages/me/me.js:360), [:372](miniapp/pages/me/me.js:372); [public/shop.html:3268](public/shop.html:3268) | The customer-facing footer falls back to wordmark "Full Circle" and credit "Powered by Full Circle" / "由 Full Circle 提供技术支持" for any tenant that hasn't customised it | FRICTION |
| A13 | [scripts/auto-push.sh:5](scripts/auto-push.sh:5) | Git remote is `github.com/Full-Circle-gh/roots-v2.git` — the org name and repo name are both dead identities | COSMETIC |
| A14 | [design-handoff/15-channels-hub-mockups.html](design-handoff/15-channels-hub-mockups.html) (7 hits), [design-handoff/18-delivery-hub-mockup.html](design-handoff/18-delivery-hub-mockup.html) (4 hits), [scripts/wizard_mock_desktop.html:41](scripts/wizard_mock_desktop.html:41), plus 3 PDFs at repo root | Design handoff artefacts render the Full Circle wordmark as the product chrome | COSMETIC |

Also present as comments only (no behaviour): `database.js:1804-1829`, `lib/platform-alert.js:3`, `public/retail-admin.css` (11 comment references), `public/retail-admin.html:30` and `:3542`, `public/app.html:30/78/3021`, `public/cms-mobile.html:12`, `public/retail-admin/07-content-billing.js:506`, `09-products.js:1204`, `16-purchasing.js:177`, `scripts/apply_home_brand_colors.js:2`.

---

## B. Roots-specific hardcoding

| # | File and line | Assumption | Severity |
|---|---|---|---|
| B1 | [lib/tenant-db.js:32](lib/tenant-db.js:32), [:143](lib/tenant-db.js:143), [:153-156](lib/tenant-db.js:153) | `ROOTS_TENANT_ID = 1` and `getTenantDb(1) === mainDb`. Roots is not a tenant — Roots **is** the default database. Any request that fails to resolve a tenant reads and writes Roots' data | BLOCKER |
| B2 | [lib/tenant-db.js:41](lib/tenant-db.js:41), [server.js:256-264](server.js:256), [routes/retail.js:65](routes/retail.js:65) | `TENANT_DATA_ISOLATION` defaults off. With it off, every non-Roots backend tenant is blocked out of `/retail-admin`, `/product-editor` and `/cms` and 403s on the API. It is set nowhere in the repo or in `.github/workflows/deploy.yml` | BLOCKER |
| B3 | [routes/backend-signup.js:15-22](routes/backend-signup.js:15), [:50-57](routes/backend-signup.js:50) | Public self-signup is closed. Only a Roots kitchen `admin` may provision a tenant. Rule 3 says businesses must be able to *register* | BLOCKER |
| B4 | [database.js:3220](database.js:3220) | Fresh-install migration seeds a store: code `tianhe`, name "Roots Kitchen — Tianhe", address `广州市天河区 (Roots Kitchen)`, city 广州 | BLOCKER |
| B5 | [database.js:3263](database.js:3263) | Second seeded store: code `yuexiu`, "Roots Kitchen — Yuexiu", `广州市越秀区` | BLOCKER |
| B6 | [database.js:563](database.js:563) | Seeded AI memory: `business_type = 'Plant-based food business in Guangzhou. Recipes built around hummus, salads, dips, dates, nut butters, plant-based yogurts.'` plus a 30% food-cost margin target and Roots' channel list. The assistant tells every operator they run Roots | BLOCKER |
| B7 | [routes/ai.js:765](routes/ai.js:765) | The AI system prompt hardcodes "the resident analyst… for Roots Kitchen Management. Roots is a small plant-based food business in Guangzhou, China. Bilingual operation (English + 中文)." Not derived from tenant config | FRICTION |
| B8 | [database.js:1918](database.js:1918), [:2048](database.js:2048), [:1813](database.js:1813), [:1846](database.js:1846) | Seeded storefront layout references Roots-owned image assets: `/assets/brand/welcome-roots.jpg`, `/assets/brand/roots-wordmark.png`, `/assets/brand/ip-kombucha-gang.jpg` | FRICTION |
| B9 | [miniapp/pages/me/me.wxml:3](miniapp/pages/me/me.wxml:3), [miniapp/pages/profile/profile.wxml:4](miniapp/pages/profile/profile.wxml:4), [public/shop.html:3273](public/shop.html:3273) | Default avatar / brand mark is `ip-onion.png` — one of 22 Roots vegetable mascot images shipped in `public/brand/` and `miniapp/assets/brand/` | FRICTION |
| B10 | [server.js:179-183](server.js:179) | `KITCHEN_HOST = 'food.rootskitchenchina.com'` and three legacy hosts, with a live 302 redirect middleware | FRICTION |
| B11 | [server.js:480](server.js:480), [:486](server.js:486) | `STORE_HOST = 'store.rootskitchenchina.com'`, `STORE_ADMIN_HOST = 'system.rootskitchenchina.com'`. The *platform* console — the surface that manages all merchants — is pinned to Roots' domain | FRICTION |
| B12 | [routes/push.js:26](routes/push.js:26) | Web Push VAPID contact defaults to `mailto:owner@rootskitchen.cn` | FRICTION |
| B13 | [routes/retail.js:3453](routes/retail.js:3453) | `if (tid === ROOTS_TENANT_ID) return 'Roots';` — tenant 1 gets a literal brand string in a code path other tenants resolve from config | FRICTION |
| B14 | [routes/retail.js:741](routes/retail.js:741), [:4559](routes/retail.js:4559), [:4958](routes/retail.js:4958), [:5011](routes/retail.js:5011), [:5174](routes/retail.js:5174), [:5233](routes/retail.js:5233), [:22264](routes/retail.js:22264) | Alipay availability, and the WeChat Pay / refund / kd100 callback handlers, are hardwired to `ROOTS_TENANT_ID`. A second tenant's payment callback cannot be routed | BLOCKER |
| B15 | [routes/integrations-admin.js:29](routes/integrations-admin.js:29), [routes/retail-setup.js:32](routes/retail-setup.js:32) | `function tenantId(req) { return (req.tenant && req.tenant.id) \|\| 1; }` — an unauthenticated or mis-scoped request silently becomes tenant 1 | FRICTION |
| B16 | [routes/retail-purchasing.js](routes/retail-purchasing.js) — 24 occurrences, e.g. `:46`, `:134`, `:308`, `:474` | `COALESCE(tenant_id, 1)` throughout purchasing SQL. Any row with a null tenant is treated as Roots' | FRICTION |
| B17 | [routes/retail.js:6982](routes/retail.js:6982), [:6179](routes/retail.js:6179), [database.js:1084](database.js:1084) | `DEFAULT_ROOTS_CLUB_TIERS` — Seed / Sprout / Root / Tree, thresholds ¥500 / ¥2,000 / ¥6,000. `tier_key` column defaults to `'seed'`; `BC_TIER_KEYS` hardcodes the four keys in audience filtering, so a business cannot rename or re-count its own loyalty ladder without the keys drifting | FRICTION |
| B18 | [lib/features.js:17](lib/features.js:17) | The platform feature catalogue describes membership as "Roots Club tiers and the points the mini-app shows shoppers" | COSMETIC |
| B19 | [database.js:2503](database.js:2503) | Seeded config `delivery.kitchenAddress = '广州市天河区 (Roots Kitchen)'` — shown to customers at checkout when no zone matches | FRICTION |
| B20 | [public/retail-admin/11-meituan.js:98-101](public/retail-admin/11-meituan.js:98) | The Meituan admin pane guesses two stores by matching `code === 'tianhe'` / name contains `天河`, and `'yuexiu'` / `越秀`; 19 references to those two names in this one file | FRICTION |
| B21 | [package.json:2](package.json:2), [scripts/auto-push.sh:5](scripts/auto-push.sh:5), repo root files `Roots-Name-Suggestions.csv/.xlsx` | Package name is `roots-system-v2`; the repository itself is `roots-v2` under `Full-Circle-gh` | COSMETIC |

---

## C. Geography and locale

| # | File and line | Assumption | Severity |
|---|---|---|---|
| C1 | Repo-wide: 41 files contain a fixed +8 offset. Highest density: [routes/retail.js](routes/retail.js) (33), [public/retail-admin/04-orders.js](public/retail-admin/04-orders.js) (10), [public/retail-admin/03-dashboard.js](public/retail-admin/03-dashboard.js) (7), [public/retail-admin/17-setup-guide.js](public/retail-admin/17-setup-guide.js) (7), [lib/feie.js](lib/feie.js) (7) | The pattern `new Date(Date.now() + 8 * 3600 * 1000)` is the standard way this codebase computes "today". Representative: [routes/retail.js:1851](routes/retail.js:1851) `const HK_OFFSET_MS = 8 * 3600 * 1000`, [:3710](routes/retail.js:3710), [:11716](routes/retail.js:11716), [:12875](routes/retail.js:12875); [public/retail-admin/03-dashboard.js:231-235](public/retail-admin/03-dashboard.js:231). A shop in Ohio would see its sales day roll over at 11am or noon local time | BLOCKER |
| C2 | [lib/store-hours.js:58-73](lib/store-hours.js:58) | `localMinutes(now, utcOffsetHours = 8)` and `within(hours, { utcOffsetHours = 8 })` — the *default argument* for "is the shop open" is UTC+8 | BLOCKER |
| C3 | [routes/retail.js:12845](routes/retail.js:12845) | A CSV export column header is the literal string `'Time (UTC+8)'` | FRICTION |
| C4 | [database.js:2680-2682](database.js:2680) | A per-store IANA timezone column exists, but the comment states NULL falls back to host-local, "unchanged for China stores" — the production host runs UTC+8. The setting exists; the fallback is China | FRICTION |
| C5 | [public/td-datetime.js:39](public/td-datetime.js:39) | The shared date/time formatter defaults to `'Asia/Shanghai'` when `TD_TZ` is unset | FRICTION |
| C6 | [lib/delivery-reminders.js:25](lib/delivery-reminders.js:25) | Comment records the design: "the prod host runs UTC+8 (Beijing) and is the timezone authority" | FRICTION |
| C7 | [database.js:1095-1109](database.js:1095) | Address model is `province / city / district / address / detail / postal_code`. `district` is a Chinese administrative division; there is no state, county, region or country column. `province`/`city`/`district` are TEXT with no country context | BLOCKER |
| C8 | [database.js:2253-2257](database.js:2253) | `retail_delivery_zones.zone_type` is `'gz_district' \| 'city'` — the *schema* names Guangzhou. 45 code references to `gz_district` across [public/retail-admin/06-delivery.js](public/retail-admin/06-delivery.js) (17), [routes/retail.js](routes/retail.js) (16), [database.js](database.js) (6), [lib/inventory.js](lib/inventory.js) (5) | BLOCKER |
| C9 | [miniapp/utils/zones.js:28-46](miniapp/utils/zones.js:28) | Area picker labels every district row as `广州 · X` / `Guangzhou · X` and writes canonical `province: '广东省'`, `city: '广州市'` onto the address | FRICTION |
| C10 | [lib/inventory.js:1170-1171](lib/inventory.js:1170) | Hardcoded lat/lng centroids for `天河区` and `越秀区` used as a geocoding fallback | FRICTION |
| C11 | [lib/geocode.js:1-33](lib/geocode.js:1) | The only two geocoding providers are Amap (高德) and Tencent (腾讯). Both are China-only. No Google/Mapbox/Nominatim path. Distance-based order routing silently degrades to district-name matching outside China | FRICTION |
| C12 | [public/shop.html:1422](public/shop.html:1422) | Web storefront login validates phone with `/^1\d{10}$/` — mainland-China mobile format only. A Lisbon customer cannot log in | BLOCKER |
| C13 | [lib/aliyun-sms.js:71](lib/aliyun-sms.js:71); [public/retail-admin/05-marketing.js:1638](public/retail-admin/05-marketing.js:1638); [public/retail-admin.html:9524](public/retail-admin.html:9524) | SMS is Aliyun Dysmsapi only, normalising to "the 11-digit mainland mobile". Admin UI text: "Enter an 11-digit mainland mobile · 请输入 11 位手机号" | FRICTION |
| C14 | [public/backend-account.html:1093](public/backend-account.html:1093), [:1137](public/backend-account.html:1137) | Operator 2FA offers +86 / +1 / +852 but the code refuses everything except +86: "That region isn't supported yet — only +86 numbers can receive…" | FRICTION |
| C15 | [lib/nuonuo.js](lib/nuonuo.js) (whole file), [database.js:1194](database.js:1194), [:3054-3063](database.js:3054), [miniapp/pages/checkout/checkout.js:215](miniapp/pages/checkout/checkout.js:215), [:262](miniapp/pages/checkout/checkout.js:262) | Tax documents are China 发票 (fapiao) only: Nuonuo issuance, `invoice_title`, `invoice_tax_id`, and a checkout field labelled "Company tax ID 统一社会信用代码". There is no VAT, sales-tax or generic invoice model. `lib/nuonuo.js:158` also hardcodes `withTaxFlag: '1'` — "our prices are tax-inclusive" — which is a China/EU assumption and wrong for US sales tax | COSMETIC (naming) / the missing generic model is covered in **I** |

---

## D. Currency and money

**Counts.** Across application code (`routes/`, `lib/`, `public/*.html`, `public/retail-admin/*.js`, `miniapp/**`, `database.js`), there are **~1,400 occurrences of `¥`, `￥`, `CNY` or `RMB` in 89 files**. Excluding `reference/` mockups and `public/app.html.bak`. Top files:

| File | Occurrences |
|---|---|
| [public/app.html](public/app.html) | 210 |
| [routes/retail.js](routes/retail.js) | 83 |
| [public/retail-admin.html](public/retail-admin.html) | 66 |
| [public/retail-admin/04-orders.js](public/retail-admin/04-orders.js) | 64 |
| [public/cms.html](public/cms.html) | 58 |
| [public/m.html](public/m.html) | 42 |
| [miniapp/pages/checkout/checkout.js](miniapp/pages/checkout/checkout.js) | 38 |
| [public/shop.html](public/shop.html) | 36 |
| [miniapp/components/block-renderer/block-renderer.js](miniapp/components/block-renderer/block-renderer.js) | 35 |
| [public/retail-admin/07-content-billing.js](public/retail-admin/07-content-billing.js) | 32 |
| [public/shop/blocks.js](public/shop/blocks.js) | 29 |
| [public/retail-admin/06-delivery.js](public/retail-admin/06-delivery.js) | 28 |
| [miniapp/pages/checkout/checkout.wxml](miniapp/pages/checkout/checkout.wxml) | 24 |
| …79 more files | 1–23 each |

| # | File and line | Assumption | Severity |
|---|---|---|---|
| D1 | [public/retail-admin/05-marketing.js:1336-1338](public/retail-admin/05-marketing.js:1336) | A display-currency selector exists with 10 presets — but its own comment says **"Charging stays RMB (WeChat/Alipay); this only drives how amounts are shown."** A business can label its prices in dollars and still only be able to charge yuan | BLOCKER |
| D2 | [lib/billing-providers.js:12](lib/billing-providers.js:12), [:158-163](lib/billing-providers.js:158) | Payment providers: `manual`, `wechat_native` (implemented), `alipay_native` (skeleton), `stripe` (skeleton that throws "Stripe billing is not yet implemented"). No card acquiring anywhere in the world | BLOCKER |
| D3 | [public/retail-admin/05-marketing.js:1356](public/retail-admin/05-marketing.js:1356), [public/retail-admin/17-setup-guide.js:657](public/retail-admin/17-setup-guide.js:657) | Currency defaults to `'CNY'` when unset, including in the first-run setup guide | FRICTION |
| D4 | [lib/billing-lifecycle.js:72](lib/billing-lifecycle.js:72), [lib/billing-providers.js:74](lib/billing-providers.js:74), [:118](lib/billing-providers.js:118) | Platform subscription invoices fall back to `'CNY'` in three places | FRICTION |
| D5 | **Money is stored as floating-point decimals throughout the retail schema.** [database.js:1183-1189](database.js:1183) (`subtotal`, `shipping_fee`, `voucher_amount`, `points_amount`, `total` all `REAL`), [:1243-1244](database.js:1243) (`unit_price`, `line_total` `REAL`), [:1088](database.js:1088) (wallet `balance` `REAL`), [:1256](database.js:1256), [:2272](database.js:2272), [:2288](database.js:2288), [:2317](database.js:2317), [:3426-3428](database.js:3426), [:3456-3458](database.js:3456), [schema.sql:71](schema.sql:71), [:129](schema.sql:129), [:144](schema.sql:144) | This is a **correctness** defect independent of locale: repeated addition of REAL amounts accumulates error, and equality comparisons on money are unsafe. It is also a locale defect: a 2-decimal assumption is baked in via ~200 `toFixed(2)` / `Math.round(x*100)/100` sites (115 in `routes/retail.js` alone). Zero-decimal currencies (JPY, KRW) and 3-decimal ones (KWD, BHD) are handled by the display preset but not by storage or rounding | BLOCKER |
| D6 | [lib/billing-lifecycle.js:69](lib/billing-lifecycle.js:69), [lib/billing-providers.js:76](lib/billing-providers.js:76) | The *platform billing* tables correctly use integer `amount_cents` / `price_cents`. So the codebase contains both models — integer cents for the money Tacet collects, floats for the money merchants collect | FRICTION |
| D7 | [public/retail-admin/03-dashboard.js:3437-3439](public/retail-admin/03-dashboard.js:3437) | `dashCurrencySym()` exists and is tenant-neutral — evidence the pattern is known and simply not applied. The other 88 files still print `¥` inline | FRICTION |
| D8 | [routes/retail.js:8013-8014](routes/retail.js:8013) | Default shipping rates `{ air: { base: 20, per_kg: 8 }, land: { base: 12, per_kg: 5 } }` — bare numbers with an implied currency and an implied metric unit | FRICTION |
| D9 | [database.js:2500](database.js:2500), [lib/provision-tenant.js:88-91](lib/provision-tenant.js:88) | Every new tenant is seeded `fees.freeShippingThreshold = 399`, `standardShipping = 12`, `sameDayDelivery = 18`, `delivery.defaultFreeThreshold = 399` — Roots' yuan figures, handed to a bakery in Lisbon as euros | COSMETIC |

---

## E. Language

| # | File and line | Assumption | Severity |
|---|---|---|---|
| E1 | [public/retail-admin.html:11839](public/retail-admin.html:11839) | `window.cuT = function (en, cn) { return _lang === 'cn' ? cn : en; }`. There are **2,510 `cuT(` call sites** across `public/retail-admin/*.js` and `public/*.html`. Every operator-facing string in the admin is a hardcoded English/Chinese pair. Adding a third language means touching 2,510 call sites | BLOCKER |
| E2 | [public/retail-admin.html:11778-11790](public/retail-admin.html:11778), [:11630](public/retail-admin.html:11630) | The DOM walker translates by splitting text nodes on the literal separator `" · "` and requires the right half to match `/[一-鿿]/` (`hasChinese`). The translation mechanism itself is defined in terms of the CJK Unicode block. A `EN · Português` pair is invisible to it | BLOCKER |
| E3 | [public/retail-admin.html:11742-11772](public/retail-admin.html:11742) | The same two-slot model for `data-ph-en`/`data-ph-cn` placeholders and `title` attributes — exactly two attributes, named for the two languages | FRICTION |
| E4 | [public/retail-admin.html:11838](public/retail-admin.html:11838) | `cuToggleLang` flips between `'cn'` and `'en'`. There is no language *list*, only a flip | FRICTION |
| E5 | Database schema: **26 `*_en` / `*_cn` column pairs** across [database.js](database.js) and [schema.sql](schema.sql). Examples: `name_en`/`name_cn`, `description_en`/`description_cn`, `title_en`/`title_cn`, `body_en`/`body_cn`, `label_en`/`label_cn`, `question_en`/`question_cn`, `tagline_en`/`tagline_cn`, `keywords_en`/`keywords_cn`, `manifesto_en`/`manifesto_cn`, `founder_quote_en`/`founder_quote_cn`, `retail_description_en`/`retail_description_cn`, `variant_noun_en`/`variant_noun_cn`, `nutrition.basis_en`/`basis_cn` | Language is a **column**, not a row. A third language is a schema migration, not a data entry | BLOCKER |
| E6 | [schema.sql:46](schema.sql:46), [:83](schema.sql:83), [:102](schema.sql:102), [:138](schema.sql:138), [:182](schema.sql:182), [:358](schema.sql:358); [database.js:1279](database.js:1279), [:1292](database.js:1292), [:1718-1719](database.js:1718) | `name_en TEXT NOT NULL` on ingredients, recipes, recipe_ingredients, products, po_line_items, kitchen_order_items; `question_en` and `label_en` NOT NULL on product options and option choices; and `label_en` **and** `label_cn` both NOT NULL on `retail_page_templates`. A monolingual Portuguese business is forced to supply an English name for every product, and for a page template an English *and* a Chinese one | BLOCKER |
| E7 | [lib/brand-designer.js:83](lib/brand-designer.js:83), [database.js:2212](database.js:2212), [lib/provision-tenant.js:85](lib/provision-tenant.js:85) | The only valid values of `theme.language` are `['en', 'cn', 'bilingual']`, and every new tenant is seeded `'bilingual'` | FRICTION |
| E8 | [miniapp/](miniapp/) — **821 occurrences** of `lang.pick(en, cn)`, `lang === 'cn' ? … : …`, or `cn ? … : …` across the mini-app. Representative: [miniapp/components/block-renderer/block-renderer.wxml:617-680](miniapp/components/block-renderer/block-renderer.wxml:617), [miniapp/pages/me/me.js:10](miniapp/pages/me/me.js:10) | The customer-facing app has the same two-slot ternary at every string | BLOCKER |
| E9 | [lib/features.js:16-52](lib/features.js:16), [lib/integrations/registry.js:64-140](lib/integrations/registry.js:64), [lib/onboarding-steps.js](lib/onboarding-steps.js), [lib/capabilities.js:43-45](lib/capabilities.js:43) | Every platform-level catalogue (features, integrations, onboarding steps, capabilities) stores exactly `labelEn`/`labelCn`, `blurbEn`/`blurbCn`, `en`/`cn`, `desc_en`/`desc_cn`. The two-language assumption reaches into the platform's own metadata, not just tenant content | FRICTION |
| E10 | [lib/provision-tenant.js:124-129](lib/provision-tenant.js:124), [:118-121](lib/provision-tenant.js:118) | New-tenant seed writes bilingual EN/CN tab-bar labels and a holiday message in English and Chinese | FRICTION |
| E11 | Hardcoded Chinese in server-side strings a non-Chinese operator would see: [routes/backend-signup.js:47](routes/backend-signup.js:47) "Too many signups from this IP, try later · 注册过于频繁,请稍后再试", [:65](routes/backend-signup.js:65) "Signup is invite-only right now · 暂为邀请制,敬请期待", [lib/provision-tenant.js:38](lib/provision-tenant.js:38) "Host required · 域名必填", [server.js:262](server.js:262) "Your workspace is being set up · 工作区正在配置中", [routes/billing-pay.js:82](routes/billing-pay.js:82) | API error messages are bilingual EN/CN strings glued with `· `, returned raw to clients | COSMETIC |

---

## F. Units of measure

| # | File and line | Assumption | Severity |
|---|---|---|---|
| F1 | [routes/retail.js:7992-8005](routes/retail.js:7992) | `parseWeightToGrams()` accepts only `kg`, `g`, `gram(s)`, `千克`, `公斤`, `克`. Pounds and ounces return `null`, which silently disables shipping-cost estimation for a US business | BLOCKER |
| F2 | [routes/retail.js:8026-8031](routes/retail.js:8026), [:8013-8014](routes/retail.js:8013) | Shipping cost is computed as `base + per_kg * (grams / 1000)`. The rate *name* is `per_kg`; a lb-based tariff has no representation | BLOCKER |
| F3 | [routes/retail.js:8301](routes/retail.js:8301) | `const LAND_FLOOR_GRAMS = 2000; // 2 kg` — a business rule expressed in grams | FRICTION |
| F4 | [schema.sql:50-51](schema.sql:50) | `unit TEXT DEFAULT 'g'`, `buy_unit TEXT DEFAULT 'kg'`. Metric is the column default, not a choice | FRICTION |
| F5 | [schema.sql:54](schema.sql:54), [:106](schema.sql:106) | `pack_contents_unit` documented as "(g/kg/ml/L)"; `recipe_ingredients.unit TEXT DEFAULT 'g'` | FRICTION |
| F6 | [public/app.html:4874-4876](public/app.html:4874), [:5369](public/app.html:5369), [:7272](public/app.html:7272), [:14944](public/app.html:14944), [:5720](public/app.html:5720) | Unit dropdowns are fixed arrays. `RECIPE_UNITS` is metric+count only (`g`, `ml`, `pcs`, `bag`, `bottle`, `box`) — **no `oz`, no `lb`, no `cup`, no `fl oz`** in the recipe unit list, though `BUY_UNITS` does include `lb`/`oz`. The gram-conversion table at `:5720` is the single source of truth and is metric-first | FRICTION |

---

## G. Industry assumptions

The system assumes a business that **produces** things, and specifically that it produces **food**.

| # | File and line | Assumption | Severity |
|---|---|---|---|
| G1 | [lib/category-tree.js:17-73](lib/category-tree.js:17) | `SEED_TREE` — 7 top categories and 46 subcategories, all vegan grocery: "Plant Protein", "Plant Milks & Creams", "Cheese Alternatives", "Kombucha", "Granola", "Nut Butters", "Yogurts", "Frozen Treats". Seeded into every fresh install at [database.js:1790-1797](database.js:1790), served to the mini-app at [routes/retail.js:329](routes/retail.js:329). A hardware shop opens its catalogue and finds Kombucha | BLOCKER |
| G2 | [database.js:712-713](database.js:712) | Seeded category lists: recipe categories `['Dips & Spreads 酱料','Salads 沙拉','Hot Dishes 热菜',…]` and product categories `['Bakery','Beverages','Desserts','Savory','Salads','Sandwiches','Meals','Snacks','Sauces & Condiments',…]` | FRICTION |
| G3 | [schema.sql:44](schema.sql:44), [:81](schema.sql:81), [:98](schema.sql:98), [:113](schema.sql:113), [:122](schema.sql:122), [:323](schema.sql:323), [:343](schema.sql:343), [:354](schema.sql:354) | The core schema has `ingredients`, `recipes`, `recipe_ingredients`, `recipe_steps`, `recipe_cost_data`, `production_batches`, `kitchen_orders`, `kitchen_order_items` as first-class tables. A pure retail business that only buys and resells has no use for any of them, and no way to switch them off — [lib/features.js:16-52](lib/features.js:16) lists 11 toggleable features and **production/recipes is not one of them** | BLOCKER |
| G4 | [database.js:368](database.js:368) | `ingredients.item_kind TEXT DEFAULT 'food'` — the default kind of thing a business buys is food | FRICTION |
| G5 | [database.js:727-745](database.js:727), [schema.sql](schema.sql) `ingredients.allergens` | Allergens are a column on every purchased item, with a boot migration that normalises them | FRICTION |
| G6 | [database.js:1003-1007](database.js:1003), [miniapp/pages/product/product.js:184-186](miniapp/pages/product/product.js:184), [:455-463](miniapp/pages/product/product.js:455) | `products.nutrition` (JSON) and a nutrition-facts panel rendered on every product page. `nutritionBasis` example values are "Per 100ml" / "每100毫升" | FRICTION |
| G7 | [miniapp/pages/product/product.js:357-372](miniapp/pages/product/product.js:357) | Hardcoded: "The whole shop is 100% plant-based, so EVERY product also carries the PLANT-BASED badge". Every product in every Tacet store gets a vegan badge | BLOCKER (for any non-vegan business) |
| G8 | [database.js:1926](database.js:1926), [:2138-2170](database.js:2138) | Seeded About page and About content: manifesto "We exist to make plant-based food so mind blowing good…", stats `2017 / 广州 / 50+ PRODUCTS / 100% PLANT`, promise list "100% plant-based, Made from scratch, Real fermentation, Whole ingredients, Small batch, Seasonal, Local-first · 广州, Recyclable packaging", exclusion list "Preservatives, Refined sugar, Artificial color…", and a founder quote "I started Roots because I wanted to prove that plants don't have to be the boring option." | FRICTION |
| G9 | [database.js:36](database.js:36) `po_line_items.expiry_date`, [routes/retail.js](routes/retail.js) `expiring_lots` tool ([routes/ai.js](routes/ai.js) tool list) | Shelf-life / expiry tracking is unconditional on purchase lines | FRICTION |
| G10 | [schema.sql:264](schema.sql:264) `waste_entries`, [:369](schema.sql:369) `packaging_types` | Waste logging and packaging types are core tables. A hardware shop does not log waste per batch | FRICTION |
| G11 | [database.js:147-155](database.js:147) | Comment records the model: `"Restock only" — for items that are kitchen-internal (salad dressings, …)`. The stock model's vocabulary is kitchen vocabulary | COSMETIC |
| G12 | [public/retail-admin/17-setup-guide.js](public/retail-admin/17-setup-guide.js), [lib/onboarding-steps.js:43](lib/onboarding-steps.js:43) | Onboarding asks for "App name (+2 backups), square logo, service category" — the WeChat mini-program submission fields — as a universal setup step | FRICTION |

**What a pure retail business is forced to see:** the Items/Ingredients list with its allergen, expiry and recipe-unit fields; the Recipes section; production batches; kitchen orders; waste entries; the nutrition panel on every product; and a PLANT-BASED badge on every product they sell.

---

## H. Sales channels

Rule 3's stated consequence is that the channel list must be per business. It is currently a fixed enum in at least six places, and one of the fixed entries is specific to one customer.

| # | File and line | Assumption | Severity |
|---|---|---|---|
| H1 | [routes/sales.js:10](routes/sales.js:10) | `const CHANNELS = ['dinein', 'meituan', 'eleme', 'miniapp', 'wechat', 'retail', 'gzgrocery'];` — a literal array, validated against on write. `dinein` assumes a restaurant; `gzgrocery` is one customer's B2B buyer | BLOCKER |
| H2 | [routes/meituan-admin.js:603](routes/meituan-admin.js:603) | `const GRID_CHANNELS = ['mini_app', 'web', 'meituan', 'eleme', 'gzgrocery'];` — the per-channel stock-quota grid is a fixed five columns | FRICTION |
| H3 | [database.js:2605](database.js:2605), [:2630](database.js:2630) | `channel TEXT NOT NULL DEFAULT 'wechat'` on the stock ledger, documented as `wechat \| meituan \| pos \| walkin` — a different fixed list from H1 and H2 | FRICTION |
| H4 | [database.js:4188-4189](database.js:4188) | `channel TEXT NOT NULL, -- 'mini_app' \| 'web' \| 'eleme' \| 'gzgrocery'` with `store_code TEXT NOT NULL, -- retail_stores.code (gzgrocery: 'tianhe' only)`. The schema comment encodes a single customer's store topology | BLOCKER |
| H5 | [routes/retail.js:14102-14113](routes/retail.js:14102) | `CHANNEL_SQL` classifies customers by openid prefix into a fixed set: `manual`, `web`, `wechat`, `unknown`. A new channel needs a SQL `CASE` edit | FRICTION |
| H6 | [routes/retail.js:18937](routes/retail.js:18937) | `const MANUAL_ORDER_CHANNELS = ['manual', 'wechat', 'web'];` — which channels an operator may key an order into is fixed in code | FRICTION |
| H7 | [lib/inventory.js:1110](lib/inventory.js:1110), [:153](lib/inventory.js:153), [:167](lib/inventory.js:167) | `QINGYUN_PUSH_CHANNELS = ['wechat', 'web']`, and open/closed store logic filters on `channel IN ('mini_app','web')` | FRICTION |
| H8 | [lib/integrations/registry.js:64-140](lib/integrations/registry.js:64), [lib/features.js:39-51](lib/features.js:39) | The integration catalogue is a static `DESCRIPTORS` array of exactly five: `wechat_miniapp`, `web`, `eleme`, `meituan`, `jd`, plus `qingyun`. All China-only. There is no Shopify, no Amazon, no eBay, no Etsy, no Square, no in-person card terminal — and no mechanism to register one, since the array is a module constant | FRICTION |
| H9 | **gzgrocery — one customer's channel, spread across 20 core files.** [database.js](database.js), [lib/gzgrocery-admin.js](lib/gzgrocery-admin.js), [lib/gzgrocery-order-notify.js](lib/gzgrocery-order-notify.js), [lib/guanyi-browser.js](lib/guanyi-browser.js), [lib/guanyi-sync.js](lib/guanyi-sync.js), [lib/inventory.js](lib/inventory.js), [lib/capabilities.js](lib/capabilities.js), [routes/retail.js](routes/retail.js), [routes/guanyi-admin.js](routes/guanyi-admin.js), [routes/meituan-admin.js](routes/meituan-admin.js), [routes/sales.js](routes/sales.js), [routes/ai.js](routes/ai.js), [server.js](server.js), and six `public/retail-admin/*.js` parts. UI: [public/retail-admin.html:2268](public/retail-admin.html:2268) (channel dropdown item), [:10565-10573](public/retail-admin.html:10565) (settings card "gzgrocery · 管易"), [:10771-10776](public/retail-admin.html:10771) (a whole "gzgrocery 同步" admin page), [:12427](public/retail-admin.html:12427) (`return c === 'meituan' \|\| c === 'gzgrocery'`) | Every Tacet merchant sees a sales channel named after one Guangzhou wholesaler | FRICTION |

---

## I. Business rules baked in as universal

These are one business's policy presented as system law. Each would need to become a setting.

| # | File and line | The rule, as currently fixed | What it should become | Severity |
|---|---|---|---|---|
| I1 | [lib/inventory.js:231-238](lib/inventory.js:231), [:282-287](lib/inventory.js:282), [:844](lib/inventory.js:844) | Stock can never go negative — `Math.max(0, …)` at every availability computation, and `newPhysicalQty = Math.max(0, oldQty + deltaQty)` clamps a recount. Overselling is impossible, and a negative correction is silently swallowed | An "allow negative stock / allow backorder" setting. Many businesses (made-to-order, drop-ship, pre-order) require it | BLOCKER |
| I2 | [lib/inventory.js:370-440](lib/inventory.js:370) `routeOrder` | Fulfilment location is chosen by: GPS proximity first, then zone `preferred_store_id`, then home-district match, then `sort_order`. Nearest-wins is hardcoded as the primary rule | A per-business routing strategy: nearest, cheapest, most stock, single warehouse, round-robin, manual | FRICTION |
| I3 | [lib/inventory.js:1170-1171](lib/inventory.js:1170) | When geocoding is unavailable, routing falls back to two hardcoded Guangzhou district centroids | Removal; a business outside China gets no fallback at all | FRICTION |
| I4 | [lib/store-hours.js:63-73](lib/store-hours.js:63) | Opening hours are a single `{ open, close }` pair per store, in minutes since midnight, evaluated at UTC+8. No per-weekday hours, no split shifts (lunch close), no holidays, no overnight spans (a bar closing at 02:00 would have `close < open`) | Per-weekday ranges with exceptions, in the store's own timezone | BLOCKER |
| I5 | [lib/nuonuo.js:158](lib/nuonuo.js:158) | `withTaxFlag: '1'` — "our prices are tax-inclusive". Tax-inclusive pricing is assumed system-wide; there is no tax-exclusive path and no tax-rate model at all | A tax mode (inclusive/exclusive), tax rates per jurisdiction, and tax lines on the order | BLOCKER |
| I6 | ~200 sites, e.g. [routes/retail.js:8031](routes/retail.js:8031), [:1072](routes/retail.js:1072); 115 `toFixed(2)`/`Math.round(x*100)/100` in `routes/retail.js` alone | Rounding is always half-up to exactly 2 decimals | A per-currency decimal count and a rounding mode (half-even is required in several jurisdictions) | FRICTION |
| I7 | [routes/retail.js:6982-7010](routes/retail.js:6982) | The loyalty ladder is four tiers with fixed keys `seed/sprout/root/tree`, fixed thresholds, and perk copy naming free shipping at ¥299 and ¥199 | A configurable number of tiers with tenant-defined keys | FRICTION |
| I8 | [database.js:2490-2498](database.js:2490), [lib/provision-tenant.js:105-113](lib/provision-tenant.js:105) | Points: earn 1 per 100 spent, redeem 1 point = ¥1, expire after 12 months, earn on net paid. Seeded identically for every tenant | Already config keys — but the *seeded values* are Roots' and are currency-denominated | FRICTION |
| I9 | [lib/fulfilment.js:18](lib/fulfilment.js:18) | `FULFILMENT_TYPES = ['delivery', 'pickup', 'counter']` — a fixed three. No "digital delivery", "installation", "service appointment", "freight" | A per-business fulfilment-type list | FRICTION |
| I10 | [routes/retail.js:7852](routes/retail.js:7852), [routes/retail.js:3317-3324](routes/retail.js:3317) | Pickup lead time and slot parsing build wall-clock timestamps with a literal `+08:00` suffix | Store-timezone-aware slot construction | FRICTION |
| I11 | [routes/retail.js:13806-13812](routes/retail.js:13806) | "The END of that day in store-local (GZ, UTC+8) time" — a documented, deliberate business-day definition pinned to Guangzhou | A per-business day boundary | FRICTION |

---

## J. Documentation

`docs/` is 24 files, 8,374 lines. `tacet-consolidation-decisions.md` §0 is correct and current; several other files predate it and still describe Roots' console.

| # | File and line | Issue | Severity |
|---|---|---|---|
| J1 | [docs/PROJECT-KNOWLEDGE.md:1](docs/PROJECT-KNOWLEDGE.md:1), [:15](docs/PROJECT-KNOWLEDGE.md:15) | Title is "Roots v2 / Full Circle — Complete Knowledge Handoff"; the opening sentence defines the product as "**Roots** is tenant #1 of **Full Circle**, a multi-tenant retail SaaS for **Chinese** food/grocery" — three violations of §0 in one line | FRICTION |
| J2 | [docs/DEEP-DIVE.md:26-27](docs/DEEP-DIVE.md:26) | "**Roots is tenant #1 of 'Full Circle.'**" and notes isolation is gated because "today Roots is the only live tenant" | FRICTION |
| J3 | [docs/shipping-rules.md:1](docs/shipping-rules.md:1) (whole file, 160 lines) | Titled "Roots Mini App — Shipping Rules". Describes Roots' two Guangzhou stores by code, five GZ-exception districts by Chinese name, and a full zone/fee table in ¥ including a Hong Kong row. Declared "the canonical shipping spec" — it is a customer's tariff sheet living in the product's docs folder | FRICTION |
| J4 | [docs/tacet-ia-blueprint.md:150-177](docs/tacet-ia-blueprint.md:150) | The navigation blueprint annotates 11 surfaces with "¥" as a defining property, and two with "tier names" (the Roots Club ladder) | COSMETIC |
| J5 | [docs/tacet-ia-blueprint.md:287](docs/tacet-ia-blueprint.md:287) | States the `EN · 中文` label pairs and the `" · "` splitter are "**tenant configuration (per merchant), not brand**". §0 now says language is per business and English-plus-Chinese may not be assumed — this passage treats the two-language mechanism as settled infrastructure | FRICTION |
| J6 | [docs/tacet-desktop-patterns.md:804](docs/tacet-desktop-patterns.md:804) | The design rulebook states: "`¥`, UTC+8, WeChat/Alipay, JD/kd100 are **tenant configuration**, not brand — they stay, parameterised." This directly contradicts §0's consequences on currency and geography. As the declared tiebreaker document, this line will be cited to justify leaving them | FRICTION |
| J7 | [docs/tacet-desktop-patterns.md:1486-1522](docs/tacet-desktop-patterns.md:1486) | §8 is titled "The Full Circle test" and the reference table still lists `full-circle-design-system.md`. Correctly marked retired, but the dead name is the section heading of the rulebook | COSMETIC |
| J8 | [docs/tacet-brand-concept.md:30](docs/tacet-brand-concept.md:30), [:88](docs/tacet-brand-concept.md:88) | The elevator pitch opens with "a WeChat Mini-Program here…" and §"The brand must work in English and Chinese (WeChat ecosystem)". The brand is scoped to the Chinese market | FRICTION |
| J9 | [docs/README.md:124](docs/README.md:124), [docs/tacet-orders-specimens.md:372](docs/tacet-orders-specimens.md:372), [:388-390](docs/tacet-orders-specimens.md:388) | Design specimens are drawn from live Roots production rows — a named test account, a customer name, order 322's ¥1,124 points redemption. These are one customer's records used as the product's reference examples | COSMETIC |
| J10 | [docs/README.md:38-39](docs/README.md:38) | Recommends renaming a channel to "WeChat" in the channel dropdown — a change that hardens a China-specific channel name into the shared UI | COSMETIC |
| J11 | [docs/tacet-core-survey.md:285-290](docs/tacet-core-survey.md:285) | Records the channel enum `['dinein','meituan','eleme','miniapp','wechat','retail','gzgrocery']` and lists the collisions to resolve — but frames the task as reconciling *these seven*, not as making the list configurable | COSMETIC |
| J12 | [docs/tacet-order-routing.md](docs/tacet-order-routing.md), [docs/tacet-locations-survey.md](docs/tacet-locations-survey.md), [docs/tacet-stock-model.md](docs/tacet-stock-model.md) | These survey Roots' two-store Guangzhou topology and derive the model from it. Accurate as surveys; they should say so, because they read as product specification | COSMETIC |
| J13 | [docs/tacet-session-handoff.md:25](docs/tacet-session-handoff.md:25) | Defines Tacet's audience as "e-commerce merchants (WeChat Mini-Programs, websites, apps)" — the WeChat-first framing survives in the handoff brief | COSMETIC |

**Docs that are already clean against §0:** `tacet-consolidation-decisions.md` (§0 itself), `tacet-design-system.md`, `tacet-topbar-correction.md`, `tacet-rail-drilldown-amendment.md`, `tacet-sales-addendum.md`, `tacet-marketing-addendum.md`, `tacet-dashboard-spec.md` (three Roots mentions, all as data examples).

### J — cleanup pass, 2026-07-31

**The 13 findings above were a record, not a fix. They have now been fixed.** The findings are left in place deliberately: they are the evidence of what was wrong and where, and deleting them would remove the only account of how these lines got there. Read them as history from here on, not as an open list.

**All 13 fixed. None deferred, none skipped.**

| # | What was done |
|---|---|
| J1 | `docs/PROJECT-KNOWLEDGE.md` — title is now "Tacet — Complete Knowledge Handoff"; the §0 TL;DR now opens "**Tacet** is a **multi-business retail SaaS**… Roots is the first business on it — one customer that happens to be first, not what the product is built for." All three violations (dead brand, Roots-as-definition, "Chinese food/grocery") gone from the line |
| J2 | `docs/DEEP-DIVE.md` — "Roots is tenant #1 of 'Full Circle'" replaced by "Tacet is a multi-business product; Roots is one business on it", and the isolation gate now reads as a fact about today rather than a property of the system |
| J3 | `docs/shipping-rules.md` — retitled "Shipping rules — Roots' current configuration" and demoted from "the canonical shipping spec" to a record of **one business's** setup, with an explicit banner that zones, districts, carriers, currency and thresholds are per-business configuration and nothing in the file is a product default. The tariff detail is kept as the record of what Roots runs |
| J4 | `docs/tacet-ia-blueprint.md` §4 — the nine `¥` annotations in the Skin column are now `money`, the two `tier names` are `loyalty tier names`, and the table's preamble states that `money` means "this surface renders amounts and depends on the business's currency", explicitly **not** that the currency is ¥ |
| J5 | `docs/tacet-ia-blueprint.md` §9 — the "tenant configuration (per merchant), not brand" list is now "per-business configuration, **and NOT settled infrastructure**", with language split out into its own paragraph: the `EN · 中文` pair mechanism is named as the *current mechanism*, not a settled contract, and the passage now says outright that a plan for scaling languages is an open question |
| J6 | `docs/tacet-desktop-patterns.md` §1.16 — the line no longer says `¥`/UTC+8/WeChat-Alipay/JD-kd100 "stay, parameterised". It now names them as **Roots'** currency, time zone, payment methods and carriers, hardcoded today, calls the hardcoding a defect per §0, and says explicitly: **do not cite this line to justify leaving them in place.** This was the line the audit predicted would be used as a tiebreaker |
| J7 | `docs/tacet-desktop-patterns.md` §8 — heading renamed "The reference-build test". The dead name no longer appears as a section heading of the rulebook. The `full-circle-design-system.md` rows in §8 and §9 are left as-is: they are the retirement record, and marking a retired file retired is not a §0 violation |
| J8 | `docs/tacet-brand-concept.md` — the elevator pitch's "a WeChat Mini-Program here" is now "a marketplace here"; "## Bilingual note" is now "## Language note" and states that which languages the brand must work in depends on the business, with the Chinese companion name recorded for the first business's market rather than as a requirement of the brand |
| J9 | `docs/README.md` and `docs/tacet-orders-specimens.md` §8 — the specimens now carry a banner saying they are **one business's live production rows used as evidence for a mechanism**, not Tacet reference data. Customer names removed ("Sarah", "Jay", "Samuel Keir" → ids 427, 104, 85); ids and amounts kept where they are the evidence. The `asher` note in `README.md` is marked as one business's live rows, not a product example |
| J10 | `docs/README.md` — the recommendation no longer says rename the channel to "WeChat". It now says fix the label inconsistency at the data source and **do not harden "WeChat" into the shared UI**, because channel names are per-business and the channel list is not a fixed set |
| J11 | `docs/tacet-core-survey.md` §4 — a §0 framing note added under the enum-collision list: reconciling the seven is a migration detail, not the task; both enums are Roots' channel list; the target is a configurable list with integrations offered as options, and `gzgrocery` is specific to one customer |
| J12 | `docs/tacet-order-routing.md`, `docs/tacet-locations-survey.md`, `docs/tacet-stock-model.md` — each now opens with "**What this document is: a SURVEY, not a specification**", naming the one-business Guangzhou topology and the ¥ figures as that business's, not the product's. This is what the finding asked for: they should say so |
| J13 | `docs/tacet-session-handoff.md` §1 — audience is now "businesses selling across more than one channel (online marketplaces, websites, apps, in person)". "the store it was built for" is now "the **first business on it** — one customer that happens to be first, **not the business Tacet is built for**", and the dead brand name is gone from the sentence |

**Also done in the same pass, beyond §J:**

- **`docs/tacet-merge-decisions.md` renamed to `docs/tacet-consolidation-decisions.md`.** Every reference updated — 12 in `docs/tacet-product-fields.md` (9 filename citations plus three "§N of the merge decisions" prose references) and 3 in this file. No code or non-`docs/` file referenced it.
- **"Merge" replaced by "consolidation" throughout `docs/`** wherever it meant the general programme of work — 42 occurrences across `tacet-consolidation-decisions.md` (4), `tacet-core-survey.md` (12), `tacet-locations-survey.md` (21), `tacet-stock-model.md` (4) and `tacet-order-routing.md` (1), including section headings and the "shared-core merge" title phrase. **"Merge" was kept** where it correctly names the two product tables (`products` / `store_products`) becoming one, the two apps eventually becoming one interface, or a git branch merge.
- **Four "merge" occurrences left alone as genuinely ambiguous**, listed here so the next pass does not have to re-derive them: `tacet-consolidation-decisions.md:275` ("the Production app merging into Tacet" — reads as the two-apps case, so kept); `tacet-locations-survey.md:540` (the Meituan daemon *merging* two hour maps at boot — a runtime data operation, not the programme); `tacet-editor-addendum.md:43` ("not merged into a tabbed Content mega-page" — combining screens); `tacet-dashboard-spec.md:158` ("New/merged cards" — combining dashboard cards).
- **`Full Circle` swept from `docs/`.** Every remaining occurrence is deliberately recording the retirement — §0 rule 1 itself, the glossary's "Retired words" entry, the two `full-circle-design-system.md` status rows, `tacet-desktop-patterns.md` §8's retirement statement, `tacet-ia-blueprint.md`'s "Dead — never reintroduce", and section A of this audit. **One factual exception kept:** `tacet-locations-survey.md:523` cites `public/full-circle.html` as a file path — that file still exists in the repo (finding A1), so the citation is accurate and changing it would make the survey wrong. It stops being a doc problem when A1 is fixed in code.

**Scope of this pass: `docs/` only. No code was changed.** Every finding outside section J — A through I, all 108 of them — remains open. `tacet-desktop-patterns.md` kept its `v3.9` title line through this commit, because J6 and J7 were fixed as documentation defects and a bump would have falsely signalled that the separate rulebook revision had been done. **Superseded 2026-07-31:** that revision has now run — the rulebook is **v4.0**, and its changelog records the J6 reversal and the J7 heading rename explicitly, so a reader of v3.9 learns the `¥`/UTC+8 line reversed.

### J — the J6 claim swept across all of `docs/`, 2026-07-31

**Why this ran.** J6 was recorded as one line in one file. It is not — it is a **claim with several phrasings**, and fixing the phrasing the audit happened to quote left the claim standing elsewhere. The proof is `tacet-ia-blueprint.md:7`, which asserted *"`¥` and China channels are tenant configuration, not brand"* in the document's **opening paragraph** and **survived both §J findings aimed at that file**: J4 fixed the `¥` annotations in its §4 Skin column, J5 fixed the identically-worded list in its §9, and neither reached line 7. It was found by accident while doing unrelated work. So `docs/` was swept for the claim rather than the wording — `tenant configuration`, `not brand`, `parameterised`, `they stay`, `skin`, `¥`, `CNY`, `UTC+8`, `WeChat`, `Alipay`, `China channels`, `Guangzhou`, `bilingual`.

**The distinction applied to every hit, the same one used on the "merge" pass:** a survey **recording** that the code hardcodes `¥` is accurate and was left alone. A doc **asserting** that the hardcoding is fine, settled, or should stay was fixed. Roughly 340 term hits; the overwhelming majority are accurate recordings in the survey documents, which is the expected and correct result.

**Five assertions found and fixed, in four files:**

| File | What it asserted | Now |
|---|---|---|
| `tacet-ia-blueprint.md:7` | *"`¥` and China channels are **tenant configuration, not brand**"* — J6's exact claim, in the opening paragraph | Roots' currency and channel list, hardcoded, per-business configuration that does not yet exist, §0 governs. Fixed in `b0c4f265`; **versioned here as v2.5** with a changelog stating the reversal |
| `tacet-desktop-patterns.md` §1.11 | *"the interface renders in exactly one language. **English or 中文**"* · *"**Every label needs both strings** in the source. A screen that can only render English is not done."* · *"Design in English, verify in Chinese, ship both."* — the language rule written as a two-language world, on the section that touches every string in the product | One language at a time, **whichever the reader chose**; English and 中文 named as **Roots' pair, not Tacet's**; a label needs a string per **configured** language, which for a single-language business is one. The one-language rule and the whole DOM-walker description are unchanged — they were accurate |
| `tacet-desktop-patterns.md` §1.18 | *"There is **no third style**, no house style, and no per-page exception"* — exhaustive with two languages, a ban with three | Scope clause: it forbids an **invented house format**, not a third language. The rule's own principle (*each language follows its own actual rules*) already generalises. Table and executable check untouched |
| `tacet-brand-concept.md` "What Tacet is" | The product defined as consolidating *"**WeChat Mini-Programs**, custom websites, mobile apps"* — one country's channel as the canonical first example in the sentence saying what the product *is*. **J8 fixed the elevator pitch and the bilingual note in the same file and did not reach this line** | "online marketplaces, custom websites, mobile apps, sales made in person" |
| `tacet-editor-addendum.md` · `tacet-cms-session-addendum.md` | Field-component specs requiring a *"bilingual pair (EN and 中文)"* — two languages as a design requirement | "one input per configured language", with the never-glued rule and the separate-labelled-inputs pattern kept unchanged |

**Left alone as accurate recording** (a representative list, not exhaustive): every `¥`, `UTC+8` and Guangzhou citation in `tacet-core-survey.md`, `tacet-locations-survey.md`, `tacet-stock-model.md`, `tacet-order-routing.md`, `tacet-product-fields.md` and `tacet-orders-specimens.md`; section A of this audit; the `Skin?` column values in the blueprint's §4 (`money`, `China-only`, `WeChat framing`) — the column's job is to record what a surface depends on today, and its preamble now says so; `tacet-design-system.md`'s CJK font pairing (a typography rule for a script, conditional on that script being configured); `tacet-topbar-correction.md`'s note that the More sheet carries an `EN / 中文` control (markup fact); and the entire DOM-walker mechanism in rulebook §1.11 — the splitter, the two gates, the `hasChinese` guard and `data-no-i18n` — which describes shipped code exactly and must stay describing it.

**One passage could not be classified and is left for a human:** `tacet-customers-addendum.md:86` records a real bug fix — a `topup_total` sum that mis-counted redemptions as top-ups — as *"Replaced with an allowlist (`IN ('wechat','alipay')`), matching a correct precedent already in the file."* The **allowlist pattern** is correct and is what the sentence is praising; the **two values in it** are Roots' payment methods, and §0 says the channel list is not a fixed set. It reads as an accurate record of a code change, but the word "correct" sits close enough to the hardcoded pair that it could be cited the way J6's line was. Rewriting it risks misrepresenting what was actually done, so it is recorded here instead.

**Does this need a code-side sweep? Yes — and it is already scoped.** This appendix covers `docs/` only. Sections A–I of this audit are that code-side sweep, and they remain **open in full**: 108 findings, including D (currency: CNY and `¥` hardcoded at roughly 1,400 call sites), E (language: the English/Chinese string pair at roughly 3,300), C (geography and `+08:00`), and H (the fixed channel enum). The docs pattern turned out **contained** — five assertions, all in prescriptive documents, all now fixed. The code pattern is **not contained and never was**; nothing in this pass touched it.

---

## Closing note

The multi-tenant machinery in this repository is real and carefully built — per-tenant database files, an encrypted credential store, a control-plane/data-plane split, capability-based RBAC, a provisioning path that deliberately seeds brand-neutral defaults. `lib/provision-tenant.js` in particular reads like it was written by someone who had already thought about rule 3.

The gap is not that multi-tenancy is missing. It is that **the first tenant was never moved out of the foundations**. Tenant 1 is the default database rather than a row; the isolation switch has never been turned on; the seeds that run on a fresh install describe a vegan grocer in Guangzhou; and the two mechanisms that touch every single screen — currency formatting and the English/Chinese string pair — were built as constants rather than as configuration, at roughly 1,400 and 3,300 call sites respectively.

Nothing in this audit was changed. No fixes, no refactors, no cleanup.
