# Tacet admin — full diagnostic audit, September 2026

**Read-only survey. Nothing in the product was changed to produce this document.**

This is an audit of the Tacet admin — the back office a merchant signs into to run
their business. Tacet is a platform meant for many different businesses; **Roots** is
the first one on it. Throughout this document a thing is judged by whether it is right
for *any* merchant, never by whether it currently works for Roots.

**Three areas are deliberately excluded**, because they are already being worked on
under their own briefs: permission enforcement and the unmapped routes behind it; the
sales-channel sync redesign; and the finance category data-quality pass. They are
referred to where they explain something, but no findings are raised against them.

**How this document is built.** The summary comes first. Part 1 is the inventory: a map
of everything the admin contains, with a file and line reference for each item, and no
judgements. Part 2 walks that map and records what is wrong. Every count was produced by
reading the code, and the method is stated wherever a number could be arrived at more than
one way. Nothing was executed to produce this — no server was started, no page was loaded,
no database was read — so statements about what appears on screen are read from the code
that draws it.

**A word on names.** The platform is **Tacet**. The first merchant on it is **Roots**.
Where the code carries an older brand name it is described here as "legacy tenant name"
rather than repeated.

**A word on jargon.** Some technical words are unavoidable when citing code. Each is
defined the first time it appears, like this: *tenant* — the code's word for one
merchant's account and their data.

---

# Summary

**81 findings.** 2 Critical · 28 High · 35 Medium · 11 Low. (One entry, H-04, is a table of
evidence rather than a finding and carries no severity.)

| Category | Findings | | Category | Findings |
|---|---|---|---|---|
| A. Bugs and errors | 9 | | J. Speed and scale | 3 |
| B. Dead ends | 6 | | K. Roles in daily use | 2 |
| C. Common-sense failures | 5 | | L. Mistakes and recovery | 2 |
| D. Multi-tenant leaks | 10 | | M. Language | 2 |
| E. Missing standard functions | 12 | | N. Mobile admin | 3 |
| F. Click efficiency | 2 | | O. Search and find | 2 |
| G. Simplicity | 3 | | P. Notifications and silence | 3 |
| H. Empty tenant / day one | 4 | | Q. Pattern consistency | 4 |
| I. Money, end to end | 4 | | R. Accessibility | 5 |

## The ten that matter most, in order

1. **D-01 — Purchasing, Recipes and Materials write into the first merchant's database.**
   102 statements with no merchant filter, 36 of them writes. Latent today because
   per-merchant separation is switched off; live the day it is switched on. *Critical.*
2. **D-02 — System alerts are read from one fixed database file**, so a second merchant's
   alert setting is never consulted and their alerts can land in the first merchant's chat
   group. *Critical.*
3. **A-02 — A mistyped stock count silently sets the shelf to zero.** Blank field, stray
   letter, unreadable paste: all become 0, with a green tick and no confirmation. Every
   merchant, every day. *High.*
4. **A-04 and A-05 — Every date and every "today" in the admin is Guangzhou's.** The
   time-zone hook exists (`window.TD_TZ`) and nothing sets it; the business day is
   hand-written as `'+8 hours'` in 25 places while the correct helper is used by one file.
   *High.*
5. **E-01 — There is no record of who changed what.** The data is being written on 139
   call sites and no screen reads it. *High.*
6. **A-01 — The product list stops at 500 and tells the merchant that is all there is.**
   *High.*
7. **E-03 and F-01 — Nothing on the Orders list can be acted on in bulk.** Twenty orders
   to dispatch is sixty clicks. *High.*
8. **D-03 — The merchant's currency setting is honoured by 8 of 23 screens.** 844
   hardcoded yuan signs, including the coupon presets a new merchant is offered. *High.*
9. **E-04 and E-06 — The merchant cannot export their own orders, customers or ledger, and
   is never told stock is running out.** *High.*
10. **B-01 and A-03 — Day one is broken on the screen that matters most.** An empty
    catalogue is reported as a filter error on the desktop, and as "118 products" on the
    phone. *High and Medium.*

## The three themes

**1. The product was built for one shop, and the seams are where the second shop will
tear.** Not as a slogan — as a count: 11,971 first-merchant assumptions, a currency
setting honoured by a third of the screens, a time zone hook that was designed and never
wired, three files writing into the wrong database, alerts read from a hardcoded filename,
a fixed channel list, and a new merchant seeded with yuan amounts, two languages and a
green. The remarkable thing is how much of the *scaffolding* is right — there is a
currency setting, a per-location time zone helper, a per-merchant credential store, a
capability system — and how often the screens do not use it. This is a wiring problem more
than a design problem, which is the good news.

**2. The system knows things it never tells anyone.** It records who changed what and
shows nobody. It knows stock is low and sends nothing. It knows an email failed, a push
was refused, a reminder had no recipient — and swallows all three (211 empty catch blocks,
269 that only reach a server log). Meanwhile the alerts it *does* send go to the
platform's own chat rather than the merchant's. The merchant is the last to know about
their own business.

**3. Every good pattern in this product exists exactly once.** There is a proper empty
state — on Suppliers. There is version history with a restore — on Products. There is a
"clear the filters" button in the toolbar — on Waste. There is a shared date formatter —
used by seven files of twenty-three. There is a spreadsheet import with a template and
plain instructions — for suppliers only. There is a money function that reads the
merchant's currency — called by eight files. Nothing here needs inventing; it needs
applying.

## The tasks furthest from their minimum

| Task | Now | Minimum |
|---|---|---|
| Mark 20 orders dispatched | 60 clicks | 3 |
| Annotate an order that came in from the shop | impossible | 2 |
| Find out who changed a price | impossible | 2 |
| Export last month's orders | impossible | 2 |
| Rebuild yesterday's filtered view | 4, every morning | 1 |
| Take an order over the phone, on a phone | impossible | 4–5 |

## Day one for a new merchant, in three sentences

They sign up with a company name, a username and a password — nobody asks what country
they are in, what currency they sell in or what time zone they keep, so they are given
yuan, Guangzhou time, English-and-Chinese and a green accent, and there is no welcome
email. The setup guide that greets them is the best-built screen in the product: five
steps, honest time estimates, each one routing to the right place. Then they open Products
to add their first item and are told "No products match this filter" — or, on their phone,
that they have 118 products already.

---

# Part 1 — Inventory

## 0. Part 1 at a glance

| What was counted | Number |
|---|---|
| Applications served off one codebase | 10, of which **7 are the admin** |
| Page addresses that serve an admin screen | 20 |
| Sections in the desktop shell | **41** (32 reachable from the rail, 9 only from elsewhere) |
| Screens in the phone admin | 30, plus 13 slide-up sheets |
| Drawers · modals · overlays · embedded apps in the shell | 19 · 11 · 2 · 3 |
| Click handlers across the admin | **1,872** (1,356 `onclick` + 516 listeners) |
| Confirmation prompts | 101 |
| Toast messages | 745 |
| Filters, dropdowns, chip strips, search boxes, date fields | 54 · 28 · 10 · 9 |
| API routes behind the admin | **404** (`/api/retail-admin/*`) + 67 (`/api/backend/*`) |
| Admin routes with no caller in the front end | 21 |
| Route registrations in the whole service | 856 |
| Database statements on merchant data using the shared handle | **121**, in three files — 19 carry a merchant filter, **102 do not** (36 of them writes) |
| Money columns in the schema | 61 across 32 tables — **51 stored as floating point** |
| Money formatting helpers | **7, none shared** |
| Rounding decisions in code | 243 in the admin front end, 330 in the API and libraries |
| Hardcoded currency symbols | **844** |
| Admin files honouring the merchant's own currency setting | **8 of 23** |
| Pairing calls for the two languages | 3,921 (`cuT` 2,873 + `T` 1,048) |
| Paired text in the shell markup | 1,484 nodes |
| Message strings with no translation | 128 English-only, 7 Chinese-only, 33 raw variables |
| Bilingual database columns | 73 across 23 tables |
| Notifications the system can send | 20 kinds, across 7 channels |
| Notification preferences a merchant can set | 4 |
| Occurrences of a first-merchant assumption | **11,971** across 24 kinds |
| Settings a new merchant is given | 43 — with no currency, time zone, country, units or tax among them |


## 1. What "the admin" actually is

One Node/Express service (`server.js`) serves several different applications off one
codebase. Which one you get depends on the web address you arrive at and, on phones,
on your device.

| Surface | Who it is for | Shell file | How it decides | In this audit? |
|---|---|---|---|---|
| **Tacet admin (desktop)** | The merchant and their staff | `public/retail-admin.html` (12,970 lines) + 23 JavaScript files in `public/retail-admin/` (57,241 lines) | `store.rootskitchenchina.com` root, or `/retail-admin` which redirects there (`server.js:636`, `:714`) | **Yes — the main subject** |
| **Tacet Mobile** | The same merchant, on a phone | `public/m.html` (10,684 lines) | Any phone/WeChat user-agent hitting the same address gets this instead, unless `?desktop=1` (`server.js:662-666`) | **Yes** |
| **Counter till** | A cashier on a shop tablet | `public/till.html` (1,593 lines) | `/till` (`server.js:748`) | **Yes** |
| **Quick Stock** | Shop or stockroom staff on a phone | `public/stock.html` (4,128 lines) | `/stock` (`server.js:866`) | **Yes** |
| **Product page editor** | Whoever writes product pages | `public/product-editor.html` (4,281 lines) | `/product-editor` (`server.js:760`) | **Yes** |
| **Online-store editor (CMS)** | Whoever designs the shop | `public/cms.html` (15,970 lines), `public/cms-mobile.html` on phones | `/cms` (`server.js:769`) | **Yes** |
| Sign-in, sign-up, profile, brand, billing | The merchant | `public/backend-*.html` | `/backend/login`, `/backend/signup`, `/backend/account`, `/backend/brand`, `/backend/billing` | **Yes** |
| Kitchen / production app | Roots' own internal staff | `public/app.html` (28,637 lines) | Every other host (`server.js:684-706`) | No — different app |
| Online store (customer-facing) | Shoppers | `public/shop.html`, `miniapp/` | A registered storefront address | No |
| Platform back office | Tacet's own staff | `public/store-admin.html`, `public/saas-admin.html` | `system.rootskitchenchina.com`, `/saas-admin` | No — adjacent, noted where it overlaps |

### 1.1 Three separate sign-in systems

The code keeps three unrelated notions of "who is signed in", and they never mix
(`docs/PROJECT-KNOWLEDGE.md` §3, verified against the code):

| Realm | Session key | Table | Used by |
|---|---|---|---|
| Merchant staff | `session.backendUserId` + `session.tenantId` | `tenant_users` | The Tacet admin — everything in this audit |
| Roots' internal kitchen staff | `session.userId` | `users` | The kitchen app; **also a back door into the Tacet admin** (`routes/retail.js:188-200`) |
| Tacet's own staff | `session.platformAdminId` | `platform_admins` | The platform back office |

The gate every admin API call passes through is `requireRetailAdmin`
(`routes/retail.js:123`). It accepts either a merchant operator **or** a Roots kitchen
user holding the `retail` permission, and in the second case it pins the request to
Roots (`routes/retail.js:193`).

### 1.2 How one merchant's data is kept apart from another's

Each merchant gets their own database file (`data/tenants/<id>.db`); Roots, being
merchant number 1, uses the shared main database (`lib/tenant-db.js:190-198`). A
request is put "inside" the right merchant's database by `requireRetailAdmin`
(`routes/retail.js:183`), and code that then calls `tdb()` reaches that merchant's
data. Code that instead uses the module-level `db` handle reaches the **shared** database
— which is Roots' — no matter who is signed in. Section 7 counts both.

The whole per-merchant arrangement is currently switched **off** in production: a flag
called `TENANT_DATA_ISOLATION` gates it (`lib/tenant-db.js:87`), and while it is off,
any merchant who is not Roots is held out of the admin entirely and bounced to the
billing page (`server.js:289-298`).

---

## 2. Page routes — every address that serves a screen

From `server.js`. "Gate" is what the server checks before serving the page; several
pages deliberately serve to anyone and then check permission in the page itself.

| Address | Serves | Who for | Gate | Line |
|---|---|---|---|---|
| `/` on the store host | Desktop admin, or Tacet Mobile on a phone | Merchant staff | Suspended merchants are sent to billing; the page then checks sign-in itself | `server.js:636-670`, `:695` |
| `/retail-admin` | Redirect to the store host, query string preserved | Old bookmarks, deep links | none | `server.js:714` |
| `/m` | Tacet Mobile | Merchant staff on a phone | none server-side; page self-checks | `server.js:788` |
| `/till` | Counter till | Cashier | none server-side, deliberately; the page requires two permissions before it will open | `server.js:748` |
| `/stock` | Quick Stock | Shop / stockroom staff | none server-side; page bounces to `/stock-login` | `server.js:866` |
| `/stock-login` | Redirect to the right sign-in page for the host | Signed-out stock staff | none | `server.js:882` |
| `/product-editor` | Product page editor | Whoever writes product pages | none server-side; page self-checks | `server.js:760` |
| `/cms` | Online-store editor (mobile version on phones) | Whoever designs the shop | none server-side; page self-checks | `server.js:769` |
| `/backend/login` | Sign-in, co-branded per merchant by web address | Merchant staff | redirects in if already signed in | `server.js:492` |
| `/backend/signup` | Sign-up / waitlist | Prospective merchants | redirects in if already signed in | `server.js:542` |
| `/backend/account` | Profile: my info, security, devices, notifications | Signed-in staff | must be signed in | `server.js:499` |
| `/backend/brand` | Logo and brand name | Owner/admin (checked on save, not on open) | must be signed in | `server.js:526` |
| `/backend/billing` | Plan, subscription, invoices | Merchant | must be signed in | `server.js:549` |
| `/backend/team` | Redirect to the Team tab | Old bookmarks | must be signed in | `server.js:517` |
| `/impersonate?t=…` | Signs a platform staffer in as a merchant | Tacet staff | one-time token, 2-minute life | `server.js:586` |
| `/impersonate/exit` | Ends that session | Tacet staff | none | `server.js:608` |
| `/storefront`, `/shop-preview` | Public previews of the merchant's shop | Anyone with the link | none | `server.js:815`, `:826` |
| A public marketing page whose path and filename are a retired platform name | The platform's own sales pitch | Anyone with the link | none | `server.js:830` |
| `/health`, `/api/version` | Service checks; the version token the admin polls to offer a reload | Machines, and the admin shell | none | `server.js:896`, `:910` |

**Also reachable, but not routed.** `app.use('/assets', express.static(public/))`
(`server.js:185`) serves the whole `public/` folder unauthenticated. Every admin page
file is therefore readable at `/assets/<name>` — including `public/app.html.bak`, a
1.4 MB copy of the kitchen app, and `public/brand-studio.html`, an AI brand-generator
screen that **nothing in the product links to** and that has no route of its own
(searched: the only other mention in the repo is a deployment checksum list,
`scripts/diagnose_deployed_tree.js:446`).

---

## 3. Navigation map

### 3.1 The left rail, as the markup actually orders it

Read from `public/retail-admin.html:1243-1512`. Labels are stored as an
`English · 中文` pair and one half is shown at render time.

| Rail row | Tab id | `order:` | Feature flag | Line |
|---|---|---|---|---|
| Open your store (hidden until needed) | `setup` | 0 | — | 1243 |
| Dashboard | `dashboard` | 2 | — | 1249 |
| Reports | `reports` | 3 | — | 1256 |
| Orders | `orders` | 4 | — | 1263 |
| Sales | `sales` | 8 | — | 1271 |
| Counter till (opens a new browser tab) | — | 8 | — | 1295 |
| Finance | `finance` | 8 | — | 1304 |
| Products | `products` | 9 | — | 1320 |
| Purchasing | `purchasing` | 9 | — | 1324 |
| Materials | `materials` | 9 | `production` | 1335 |
| Recipes | `recipes` | 9 | `production` | 1343 |
| Waste | `waste` | 9 | `waste` | 1355 |
| Customers | `customers` | 10 | — | 1311 |
| **Content** (folder) | — | 14 | — | 1373 |
| › Editor | `mini-app-editor` | — | — | 1381 |
| › Copy | `snippets` | — | — | 1385 |
| › About page | `about` | — | — | 1389 |
| › Media | `media` | — | — | 1393 |
| › Legal pages | `legal` | — | — | 1397 |
| › FAQ & help | `faq` | — | `faq` | 1401 |
| **Marketing** (folder) | — | 11 | — | 1409 |
| › Coupons | `vouchers` | — | — | 1417 |
| › Flash sales | `flash` | — | — | 1421 |
| › Pop-ups | `popups` | — | — | 1425 |
| › Affiliate | `affiliate` | — | `affiliate` | 1429 |
| › Share cards | `sharing` | — | — | 1433 |
| › Broadcasts | `broadcasts` | — | — | 1437 |
| › Social proof | `social` | — | `socialProof` | 1441 |
| **Loyalty & Wallet** (folder) | — | 12 | — | 1451 |
| › Membership & points | `membership` | — | `membership` | 1459 |
| › Top-up | `topup` | — | — | 1463 |
| › Leaderboard | `leaderboard` | — | — | 1467 |
| › Voting | `voting` | — | — | 1471 |
| Delivery | `delivery` | 6 | — | 1485 |
| Settings | `config` | 15 | — | 1500 |
| Manage team | `team` | 16 | — | 1508 |

**32 rail destinations in 3 folders, plus one external launcher (the till).** Five rows
share `order:9` and three share `order:8`, so their on-screen order is decided by
where they happen to sit in the file rather than by the numbers.

### 3.2 Sections that exist in the shell

`grep '<section id="tab-…"'` over `public/retail-admin.html` finds 43 matches, two of
which are inside code comments (`:3058`, `:11495`) — **41 real sections**:

`setup` · `dashboard` · `reports` · `orders` · `orders-new` · `customers` · `products` ·
`vouchers` · `flash` · `snippets` · `popups` · `broadcasts` · `delivery` · `topup` ·
`sharing` · `affiliate` · `reviews` · `feedback` · `leaderboard` · `membership` ·
`voting` · `media` · `about` · `config` · `social` · `legal` · `faq` · `finance` ·
`sales` · `meituan` · `purchasing` · `materials` · `materials-record` · `recipes` ·
`waste` · `recipes-record` · `guanyi` · `eleme` · `mini-app-editor` · `product-editor` ·
`team`.

Nine of those 41 have **no rail row**: `orders-new`, `reviews`, `feedback` (reached from
the Inbox menu in the top bar), `meituan`, `guanyi`, `eleme` (reached from the Sales
page), `materials-record`, `recipes-record`, `product-editor`.

*(The project's own map, `docs/tacet-ia-blueprint.md`, describes 34 sections and a rail
without Finance, Materials, Recipes or Waste. The code above is what ships today.)*

### 3.3 Top bar

Brand block and merchant logo · a search field that opens a command palette on
`Ctrl/⌘+K` (`#gsearch-overlay`) · an Inbox menu holding **Reviews** and **Feedback**
(`retail-admin.html:1131`, `:1136`) · an account menu holding Profile, appearance and
sign-out. The language toggle and the new-order sound toggle are **not** in the top bar
— they live inside the Profile pop-up (`public/backend-account.html`).

### 3.4 Tacet Mobile

A different application with its own screen router. 30 full screens
(`screenHome`, `screenOrders`, `screenInbox`, `screenSales`, `screenFaq`, `screenPopups`,
`screenOperations`, `screenAffiliate`, `screenEditor`, `screenDelivery`, `screenSetup`,
`screenMore`, `screenVoting`, `screenMembership`, `screenTopups`, `screenLeaderboard`,
`screenCategories`, `screenActivity`, `screenWaste`, `screenPurchasing`, `screenReceive`,
`screenReceiving`, `screenStockAdd`, `screenShareCards`, `screenSettings`, `screenTrend`,
`screenTeam`, `screenCustomers`, `screenProducts`, `screenKey`) and 13 slide-up sheets
(`sheetActions`, `sheetAsk`, `sheetChannel`, `sheetCustomer`, `sheetInstall`,
`sheetOrderDetail`, `sheetOrderShell`, `sheetOverflow`, `sheetPO`, `sheetProduct`,
`sheetQuick`, `sheetReply`, `sheetSearch`, `sheetWaste`), routed through a `SUBS` map at
`public/m.html:5115`.

### 3.5 Scale of the interface

Counted mechanically (`onclick=` attributes plus `addEventListener` registrations;
`api(`/`fetch(` string literals):

| File | Click handlers | Listeners | API calls | Confirmations | Toasts |
|---|---|---|---|---|---|
| `public/retail-admin.html` | 385 | 16 | 8 | 0 | 0 |
| 23 files in `public/retail-admin/` | 667 | 281 | 501 | 89 | 679 |
| `public/m.html` | 159 | 26 | 66 | 0 | 0 |
| `public/cms.html` | 27 | 153 | 34 | 5 | 39 |
| `public/product-editor.html` | 51 | 15 | 12 | 5 | 25 |
| `public/stock.html` | 67 | 19 | 2 | 0 | 2 |
| `public/till.html` | 0 | 6 | 8 | 2 | 0 |
| **Total** | **1,356** | **516** | **631** | **101** | **745** |

Distinct API endpoints called from the front end: **300**.

---

## 4. Navigable surfaces

*(Per-section detail — pages, sub-views, drawers, modals, wizards — is being compiled
screen by screen; see §13 for what is still open. The structural summary is below.)*

### 4.1 Surface kinds present in the desktop shell

Counted from the markup of `public/retail-admin.html` by element id and class:

| Kind | Count | Examples (element ids) |
|---|---|---|
| Full sections (pages) | 41 | see §3.2 |
| Slide-in drawers | 19 distinct ids | `order-drawer`, `cu-drawer` (customer record), `db-activity-drawer`, `db-stock-drawer`, `fb-drawer` (feedback thread), `fsd-drawer`, `vch-drawer` (coupon), `pu-editor-bg` (purchasing), `ml-edit-bg` (media), `dz-edit-bg` (delivery zone), `live-preview-drawer` |
| Modals | 11 distinct ids | `profModal` (the Profile app in a frame), `tmEditModal` / `tmPermsModal` (team member, permissions), `grant-modal-bg` (issue a coupon), `fin-tx-modal` (finance entry), `pu-preview-modal` |
| Full-screen overlays | 2 | `gsearch-overlay` (command palette), `cfg-overlay` |
| Pop-overs / menus | 3 | account menu, Inbox menu, rail folders |
| Embedded applications (iframes) | 3 | Profile (`/backend/account`), online-store editor (`/cms`), product page editor (`/product-editor`) |

Two more sections are themselves sub-view hosts rather than pages: **Products** swaps
between Products, Stock activity, Categories and Purchasing via `prodShowView()`, and
**Reports** swaps chapters under one page.

### 4.2 Surfaces outside the shell

| Surface | Screens / panes | File |
|---|---|---|
| Tacet Mobile | 30 screens + 13 sheets (§3.4) | `public/m.html` |
| Profile | 4 panes: My info · Security · Devices · Notifications | `public/backend-account.html` |
| Sign-in | sign-in card, two-factor channel picker, code step, 3-step password reset | `public/backend-login.html` |
| Sign-up | provisioning form or waitlist form, chosen by a server flag | `public/backend-signup.html` |
| Billing | alert band, current plan, plan grid, invoice table, pay modal | `public/backend-billing.html` |
| Counter till | product grid, order rail, settle takeover, done screen | `public/till.html` |
| Quick Stock | counting list, home launcher, receiving, picking, ask-kitchen, kitchen queue, hand-off | `public/stock.html` |
| Brand studio | brief form, generation progress, result preview, apply | `public/brand-studio.html` — **not linked from anywhere** |

---

### 4.3 Empty, loading and error states — the surfaces where they have been traced

Every state below is built in JavaScript, so it was read from the render code, not the
markup. These are the standalone pages and the two phone apps; the desktop sections are
listed in §13 as still open.

| Surface | While loading | When empty | When it fails |
|---|---|---|---|
| Sign-in | spinner on the button, button disabled (`backend-login.html:120-134`) | — | a red box with the message (§12.5) |
| Sign-up | "Creating… · 创建中…" | both forms hidden until the server answers; a failed check falls back to the waitlist form | "Could not create backend · 创建失败", "Network error — please try again · 网络错误,请重试" (`backend-signup.html:135-199`) |
| Profile — contact details | skeleton "Loading…" | "Add email" / "Add a phone" buttons; if the platform has no email set up: "Email isn't set up on this workspace yet, so password reset by email isn't available." | "Couldn't load." (`backend-account.html:378`, `:753-775`) |
| Profile — two-factor | skeleton | "Add and verify an email or phone under My Info to turn this on." | "Couldn't update — please try again" (`:427`, `:807-835`) |
| Profile — devices | "Loading…" | "No other devices signed in." / "No devices match this filter." | "Couldn't load devices." (`:672-685`) |
| Profile — notifications | busy switch | — | "This browser doesn't support push notifications." · "Push isn't set up on this workspace." · "No device received it — try toggling push off and on." (`:908-945`) |
| Brand | spinner on Upload/Save | preview hidden, placeholder "Your brand" | "Couldn't save — please try again" · a 403 gives "You don't have permission to change the brand" (`backend-brand.html:146-192`) |
| Billing | "Loading… · 加载中…" on three cards | "No subscription on file. · 暂无订阅。" · "No plans available. · 暂无套餐。" · "No invoices yet. · 暂无发票。" | "Failed to load billing · 加载账单失败" · "Checkout unavailable · 暂无法结算" (`backend-billing.html:108-312`) |
| Counter till — boot | a single "·" | no active store shows "That did not save. Nothing was created."; all counters closed shows "Closed" | signed out: "Sign in on the backend, then reload this page."; without permission: "POS permission required" (`till.html:876-977`) |
| Counter till — grid / lines | — | "No items" · "No lines yet. Search above to add the first product." | "That did not save. Nothing was created." (`:1140`, `:1198`, `:1296`) |
| Quick Stock — boot | waveform | — | "Quick stock is off" + "This add-on is turned off for your store. An admin can switch it on in the back office under Settings." · "No store assigned" + "Your account isn't linked to a store yet…" · "That didn't load" + Try again (`stock.html:619`, `:1794-1816`) |
| Quick Stock — shelf | 6 skeleton rows | "Nothing to count here yet." + "Products added in the back office settle in here."; filtered: "No products match "q"." | "The shelf didn't load." + "Check the connection, then try again." + Try again; per row: "Didn't save. The shelf still shows N." + Retry (`:1465-1525`) |
| Quick Stock — receiving | "Loading…" | "Nothing to receive" / "Nothing is on its way right now." | "This account cannot receive transfers." · "That count did not save. It is still on screen — try again." (`:2039-2397`) |
| Quick Stock — picking | "Loading…" | "Nothing to pick" / "Every store has what it asked for." | "Dispatch did not complete" + "These did not go out. No stock moved for them." (`:2605-2922`) |
| Tacet Mobile — products | "Loading the catalogue…" | "No products match" + a **Clear the filters** button | an inline red band carrying the error text (`m.html`, `SUBS.products` at `:5115`) |


## 5. User-facing actions

### 5.1 Where the actions are

**1,029 click handlers written as `onclick`** — 385 in the shell markup, 644 generated
by the JavaScript — plus 516 handlers attached with `addEventListener`. Distribution
tells you where the density of things-to-do is:

| Section (markup handlers) | | Source file (generated handlers) | |
|---|---|---|---|
| Delivery | 79 | `16-purchasing.js` | 117 |
| Products | 67 | `04-orders.js` | 88 |
| Dashboard | 26 | `09-products.js` | 78 |
| Orders | 26 | `15-integrations.js` | 67 |
| Customers | 22 | `07-content-billing.js` | 53 |
| Media | 16 | `05-marketing.js` | 43 |
| Pop-ups / Settings | 14 each | `17-setup-guide.js` | 36 |
| Team | 13 | `08-customers.js` | 28 |
| Finance | 10 | `11-meituan.js` | 25 |
| Broadcasts | 8 | `10-extras.js` | 15 |
| Sales | 7 | `01-core.js` | 14 |
| Shell chrome (top bar, rail, palette) | 14 | `02-settings-ops.js` | 13 |
| 21 other sections | 1–7 each | 10 other files | 1–12 each |

### 5.2 The actions on an order — the highest-traffic screen

Status moves, from `NEXT_STATUS` (`04-orders.js:2852-2869`). A pickup order relabels
two of them (`:2875-2879`):

| Order is | Buttons offered |
|---|---|
| Awaiting payment | Mark paid · Cancel |
| Paid | Start preparing · Mark dispatched · Refund · Cancel + refund |
| Preparing | Mark dispatched · Refund · Cancel + refund |
| Rider coming (Meituan) | *none — the platform advances it* |
| Dispatched (pickup: Ready for pickup) | Mark delivered (pickup: Mark picked up) · Refund |
| Delivered | Refund |
| Waiting for restock | Restocked → Start preparing · Cancel + refund |
| Cancelled / Refunded | *none* |

Each move goes to `PATCH /api/retail-admin/orders/:id/status` (`04-orders.js:6423`).
Confirmations are asked for selectively: dispatching earlier than the customer asked
raises a confirm (`:6386-6397`); cancelling asks for an optional reason (`:6408`);
marking paid asks which payment method (`:6415`); **Refund opens a full-or-partial
chooser** rather than acting immediately (`:6402`). A misclicked dispatch can be undone —
`undoDispatch` rolls dispatched or delivered back to Preparing as long as no parcel has
a waybill (`:6435`).

Beyond status, the order drawer carries shipment splitting and combining, courier
booking, waybill creation, address translation to Chinese, tax-invoice handling, notes,
line-item editing, printing, and a link through to the customer record — 48 of the 404
admin API routes are order routes (§6.4).

### 5.3 Adding a product — the wizard

`pwOpen()` (`09-products.js:5868`) opens a three-door front (`:5940`): start from
scratch, paste text you already have, or copy a product you already sell. Then five
steps — What is it? · Sizes & price · The details · Customize? · Take a look
(`PW_STEPS`, `:5850`) — ending in two buttons, **Save as draft** and **Publish it**
(`:5933`).

### 5.4 Actions that write, and whether they can be taken back

Recorded here as fact; whether each is adequate is a Part 2 question.

| Action | Reversible? | Where |
|---|---|---|
| Order status forward | Yes for dispatched/delivered → Preparing, while no waybill exists | `04-orders.js:6435` |
| Order cancelled / refunded | No | `NEXT_STATUS` offers nothing from those states |
| Waste recorded | Yes — voiding is a separate capability from recording | `lib/cap-routes.js:224-227` |
| Material archived | Yes — the Recipes screen shows "Restored · 已恢复" / "Archived · 已归档" | `19-recipes.js:2025` |
| Product deleted | Delete exists as its own capability (`products:delete`) | `lib/cap-routes.js:136` |
| Stock adjusted | A new adjustment; the ledger keeps the history | `routes/retail-inventory.js:302` |
| Purchase order superseded | Yes — a dedicated supersede path | `lib/po-supersede.js` |
| Broadcast sent | No | `POST /api/retail-admin/broadcasts` |
| CMS layout published | Draft and live are separate keys, so the previous draft survives | `routes/retail.js` cms routes |

---

### 5.6 The other wizard — creating a coupon

`vwOpen()` (`05-marketing.js:586`) opens a five-door front — **Welcome gift** (¥20 off
their first order) · **Store sale** (10% off everything, applied automatically) ·
**A coupon anyone can use** (¥10 off, customers tap to save it) · **Free shipping** ·
**Start fresh** — each door pre-filling a starting point (`:778-795`). Four steps follow:
the deal · who gets it · the small print · a review page whose final button reads
"Turn it on". A live preview of the coupon sits beside every step (`:720-742`).

The presets carry the currency in the label text (`'¥20 off · 立减'`, `'¥10 off · 立减'`,
`'¥0 delivery · 免运'`), so a merchant on another currency is offered yuan amounts as
their starting point.


### 5.5 Filters, search and sort

Counted from the shell markup: **54 dropdowns, 28 chip strips, 10 search boxes and 9 date
fields**, spread very unevenly.

| Section | Dropdowns | Date fields | Search | Chip strips |
|---|---|---|---|---|
| Orders | 3 | 0 | 1 | 12 |
| Products | 7 | 0 | 1 | 4 |
| New order | 7 | 0 | 2 | 1 |
| Settings | 9 | 0 | 0 | 0 |
| Pop-ups | 5 | 2 | 1 | 0 |
| Customers | 4 | 1 | 1 | 0 |
| Broadcasts | 4 | 0 | 0 | 2 |
| Team | 4 | 0 | 0 | 1 |
| Delivery | 1 | 1 | 1 | 2 |
| Reports | 1 | 2 | 0 | 1 |
| Media | 2 | 0 | 1 | 1 |
| Finance | 0 | 3 | 0 | 1 |
| 7 other sections | 1–3 | 0 | 0–1 | 0–1 |

**Orders** carries the most: a 13-chip status strip — All · Pending · Paid · Preparing ·
Rider coming · Dispatched · Delivered · Awaiting restock · Cancelled · Refunded · Refund
queue · Invoice · Drafts (`retail-admin.html:2260`) — a store dropdown, a **channel
dropdown listing WeChat, Web, Meituan, gzgrocery and Manual as fixed options**
(`:2318-2323`), and one search box covering order number, recipient name and phone
(`:2327`; server side `routes/retail.js:23903`).

**What can be searched, and from where**

| Looking for | Where you can search from | Matches on |
|---|---|---|
| An order | the Orders search box; the ⌘K palette | order number, recipient name, recipient phone (`routes/retail.js:23903`) |
| A customer | the Customers search box; the ⌘K palette; the new-order form; the coupon-grant modal | nickname, phone, openid, and the phone on any saved address, with digits normalised so a spaced number still matches (`routes/retail.js:16292-16328`) |
| A product | the Products search box; the ⌘K palette; the new-order form; the purchasing line picker | name (both languages) and SKU (`routes/retail.js:22474`) |
| A stock movement | the Stock activity search | SKU, name, order number, note (`routes/retail.js:14451`) |
| Media | the Media search | filename and alt text (`routes/retail.js:29860`) |
| A delivery zone | the Delivery search | zone name |
| A coupon | the Coupons search | code or label |
| **A location** | **nowhere** — Settings lists them without a search | — |
| **A supplier** | **not from the shell markup**; the purchasing screens build their own pickers in JavaScript | unverified |

The **⌘K command palette** is the one genuinely cross-cutting search: it indexes every
page, panel and setting from the live page, and on two or more characters it also queries
products, orders and customers live and deep-links into the right drawer
(`02-settings-ops.js:1311-1360`). It hides result groups the operator's permissions
would hide anyway — and the code notes explicitly that this is presentation, not a
security boundary (`:1330-1336`).


---

## 6. The API behind the admin

### 6.1 Totals

| Group | Routes | In scope |
|---|---|---|
| `/api/retail-admin/*` — the admin API | **404** | yes |
| `/api/backend/*` — sign-in, profile, team, billing, notices | 67 | yes |
| `/api/retail/*` — the customer-facing shop API | 111 | no |
| `/api/store-admin/*`, `/api/saas-admin/*` — Tacet's own staff | 49 | no |
| Kitchen-app APIs (`/api/products`, `/api/purchases`, `/api/finance`, `/api/recipes`, `/api/ingredients`, `/api/sales`, `/api/restock`, `/api/markets`, `/api/pos`, `/api/waste`, `/api/admin`, `/api/alerts`, `/api/feedback`, `/api/ai`, …) | ~225 | no (except `/api/restock`, which the admin also calls) |
| **Total route registrations across `routes/` + `server.js`** | **856** | — |

By method, the 404 admin routes are: 170 GET, 152 POST, 39 PUT, 27 DELETE, 16 PATCH.

### 6.2 Who is allowed in

Every one of the 404 admin routes carries a gate: 399 use `requireRetailAdmin`
directly, 5 use `requireInventoryRead`, which calls it (`routes/retail-inventory.js:61`).
There are **no ungated admin routes**.

Of the 67 `/api/backend/*` routes, 29 check the session inside the handler, 18 use
`requireBackend`, 7 use `requireCap`, and 13 are deliberately public: the sign-in and
two-factor steps, password reset, the sign-up status and request endpoints, the merchant
logo and mark images, the push public key, and the WeChat payment callback (which is
gated by its own signature, `routes/billing-pay.js:161-183`).

### 6.3 Routes with no caller in the front end

Comparing every route path against every API string in every admin page (including
Tacet Mobile's relative calls, `location.href` downloads, `window.open`, and the live
event stream), **21 admin routes have no caller**:

| Route | Where | Note |
|---|---|---|
| `GET /api/retail-admin/eleme/orders`, `GET /api/retail-admin/eleme/oauth/start` | `routes/eleme-admin.js:542`, `:571` | channel work — out of scope for findings |
| `GET /api/retail-admin/guanyi/stores` | `routes/guanyi-admin.js:87` | channel work |
| `GET/POST /api/retail-admin/meituan/business-status` | `routes/meituan-admin.js:856`, `:892` | channel work |
| `GET /api/retail-admin/store-status`, `POST …/online`, `POST …/master`, `POST …/store/:code` | `routes/meituan-admin.js:938-1029` | "open/close the shop on each channel" — four endpoints, no screen |
| `GET /api/retail-admin/channel-hub/meituan/stores`, `GET …/miniapp/checklist`, `PATCH …/miniapp/step` | `routes/integrations-admin.js:354`, `:466`, `:479` | a mini-app setup checklist with no screen |
| `GET /api/retail-admin/recipes/materialize-collisions` | `routes/retail-recipes.js:281` | |
| `GET /api/retail-admin/brand/status`, `POST …/generate`, `GET …/job/:id`, `POST …/apply`, `POST …/publish` | `routes/retail.js:20474-20739` | reached only from `public/brand-studio.html`, which nothing links to |
| `POST /api/retail-admin/integrations/nuonuo/test` | `routes/retail.js:26456` | tax-invoice provider test |
| `GET /api/retail-admin/refunds` | `routes/retail.js:28770` | a refunds list endpoint |
| `GET /api/retail-admin/storefront/preview-config` | `routes/retail.js:29545` | |

*Method: a route counts as "called" when any front-end string starts with the route's
fixed path prefix. Paths assembled from variables are therefore counted generously, so
this list is a floor, not a ceiling.*

### 6.4 The full route table

Grouped by resource. **Gate** is the middleware that runs before the handler.
**Data handle** says whether the handler reads tenant-owned tables through the
per-merchant connection (`tenant-scoped`) or through the shared one (`SHARED db`) —
§7 explains why that matters. **Pages?** is whether the query carries any row limit.
**Side effects** lists notifications, printing, stock movements, sync queueing and
activity logging detected in the handler body.


**`/api/retail-admin/ai/…` — Content / Products.** AI helpers that turn pasted copy into product page blocks.  (2 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| POST | `/api/retail-admin/ai/compose-blocks` | `routes/ai.js:750` | requireRetailAdmin | SHARED db | yes | logActivity | yes |
| POST | `/api/retail-admin/ai/extract-facts` | `routes/retail.js:20497` | requireRetailAdmin | no direct SQL | yes | — | no |

**`/api/retail-admin/cms/…` — Content › Editor.** The online-store page layouts: draft, preview, publish.  (13 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/cms/layout` | `routes/retail.js:29570` | requireRetailAdmin | no direct SQL | no | — | no |
| PUT | `/api/retail-admin/cms/layout/draft` | `routes/retail.js:29586` | requireRetailAdmin | no direct SQL | yes | — | no |
| GET | `/api/retail-admin/cms/media` | `routes/retail.js:29742` | requireRetailAdmin | tenant-scoped | yes | — | no |
| POST | `/api/retail-admin/cms/media` | `routes/retail.js:29749` | requireRetailAdmin | tenant-scoped | no | — | no |
| DELETE | `/api/retail-admin/cms/media/:id` | `routes/retail.js:29824` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/cms/media/video` | `routes/retail.js:29790` | requireRetailAdmin | tenant-scoped | no | — | no |
| GET | `/api/retail-admin/cms/onboarding-settings` | `routes/retail.js:29653` | requireRetailAdmin | no direct SQL | no | — | no |
| PUT | `/api/retail-admin/cms/onboarding-settings` | `routes/retail.js:29657` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/cms/onboarding-settings/bump` | `routes/retail.js:29687` | requireRetailAdmin | no direct SQL | no | logActivity | no |
| GET | `/api/retail-admin/cms/preview-qr` | `routes/retail.js:29507` | requireRetailAdmin | no direct SQL | no | — | no |
| POST | `/api/retail-admin/cms/preview-token` | `routes/retail.js:29488` | requireRetailAdmin | no direct SQL | no | — | no |
| POST | `/api/retail-admin/cms/publish` | `routes/retail.js:29596` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/cms/revert-draft` | `routes/retail.js:30086` | requireRetailAdmin | tenant-scoped | yes | — | yes |

**`/api/retail-admin/storefront/…` — Content › Editor.** Preview configuration for the online store.  (1 route)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/storefront/preview-config` | `routes/retail.js:29545` | requireRetailAdmin | tenant-scoped | no | — | no |

**`/api/retail-admin/media/…` — Content › Media.** The image and video library.  (12 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| PATCH | `/api/retail-admin/media/:id` | `routes/retail.js:29990` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/media/bulk-delete` | `routes/retail.js:30005` | requireRetailAdmin | no direct SQL | no | — | no |
| POST | `/api/retail-admin/media/bulk-move` | `routes/retail.js:29940` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/media/bulk-tag` | `routes/retail.js:30016` | requireRetailAdmin | no direct SQL | no | — | no |
| GET | `/api/retail-admin/media/folders` | `routes/retail.js:29878` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/media/folders` | `routes/retail.js:29889` | requireRetailAdmin | tenant-scoped | no | — | no |
| DELETE | `/api/retail-admin/media/folders/:id` | `routes/retail.js:29931` | requireRetailAdmin | no direct SQL | no | — | no |
| PATCH | `/api/retail-admin/media/folders/:id` | `routes/retail.js:29903` | requireRetailAdmin | tenant-scoped | no | — | no |
| GET | `/api/retail-admin/media/list` | `routes/retail.js:29850` | requireRetailAdmin | tenant-scoped | yes | — | no |
| GET | `/api/retail-admin/media/tags` | `routes/retail.js:29958` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/media/upload` | `routes/retail.js:30042` | requireRetailAdmin | tenant-scoped | no | — | no |
| GET | `/api/retail-admin/media/usage` | `routes/retail.js:29972` | requireRetailAdmin | tenant-scoped | no | — | no |

**`/api/retail-admin/customers/…` — Customers.** The customer list, one customer record, notes, points, wallet, blocking, addresses.  (19 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/customers` | `routes/retail.js:16341` | requireRetailAdmin | tenant-scoped | yes | — | no |
| POST | `/api/retail-admin/customers` | `routes/retail.js:16186` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| GET | `/api/retail-admin/customers/:id` | `routes/retail.js:16688` | requireRetailAdmin | tenant-scoped | yes | — | no |
| PATCH | `/api/retail-admin/customers/:id` | `routes/retail.js:16993` | requireRetailAdmin | tenant-scoped | yes | logActivity | no |
| GET | `/api/retail-admin/customers/:id/addresses` | `routes/retail.js:17292` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/customers/:id/addresses` | `routes/retail.js:17308` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| DELETE | `/api/retail-admin/customers/:id/addresses/:addrId` | `routes/retail.js:17429` | requireRetailAdmin | tenant-scoped | no | logActivity | yes |
| PUT | `/api/retail-admin/customers/:id/addresses/:addrId` | `routes/retail.js:17353` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/customers/:id/affiliate-block` | `routes/retail.js:17138` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/customers/:id/affiliate-unblock` | `routes/retail.js:17146` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/customers/:id/block` | `routes/retail.js:17115` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/customers/:id/force-logout` | `routes/retail.js:17156` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/customers/:id/message` | `routes/retail.js:19263` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/customers/:id/points-adjust` | `routes/retail.js:17195` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/customers/:id/referral-code` | `routes/retail.js:18622` | requireRetailAdmin | tenant-scoped | yes | logActivity | no |
| POST | `/api/retail-admin/customers/:id/reset-test` | `routes/retail.js:17173` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/customers/:id/unblock` | `routes/retail.js:17123` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/customers/:id/wallet-adjust` | `routes/retail.js:17237` | requireRetailAdmin | tenant-scoped | no | logActivity | yes |
| GET | `/api/retail-admin/customers/by-phone` | `routes/retail.js:16565` | requireRetailAdmin | tenant-scoped | yes | — | no |

**`/api/retail-admin/tier-counts/…` — Customers.** How many customers sit in each loyalty tier.  (1 route)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/tier-counts` | `routes/retail.js:20339` | requireRetailAdmin | tenant-scoped | no | — | no |

**`/api/retail-admin/dashboard/…` — Dashboard.** The morning glance cards and the role-shaped recap.  (4 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/dashboard` | `routes/retail.js:13529` | requireRetailAdmin | tenant-scoped | yes | — | yes |
| GET | `/api/retail-admin/dashboard/activity` | `routes/retail.js:14590` | requireRetailAdmin | tenant-scoped | yes | — | yes |
| GET | `/api/retail-admin/dashboard/ops` | `routes/retail.js:15140` | requireRetailAdmin | tenant-scoped | yes | adjustStock | no |
| GET | `/api/retail-admin/dashboard/presence` | `routes/retail.js:14372` | requireRetailAdmin | tenant-scoped | yes | adjustStock | no |

**`/api/retail-admin/channel-status/…` — Dashboard / Sales.** Live health of each connected sales channel.  (5 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/channel-status` | `routes/meituan-admin.js:1117` | requireRetailAdmin | mixed | no | — | no |
| POST | `/api/retail-admin/channel-status/cell` | `routes/meituan-admin.js:1177` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/channel-status/channel` | `routes/meituan-admin.js:1187` | requireRetailAdmin | mixed | no | — | no |
| POST | `/api/retail-admin/channel-status/location` | `routes/meituan-admin.js:1203` | requireRetailAdmin | mixed | no | — | no |
| GET | `/api/retail-admin/channel-status/reopen-preview` | `routes/meituan-admin.js:1148` | requireRetailAdmin | mixed | no | — | no |

**`/api/retail-admin/delivery-zones/…` — Delivery.** Delivery areas and their fees.  (4 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/delivery-zones` | `routes/retail.js:33524` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/delivery-zones` | `routes/retail.js:33542` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| DELETE | `/api/retail-admin/delivery-zones/:id` | `routes/retail.js:33628` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| PATCH | `/api/retail-admin/delivery-zones/:id` | `routes/retail.js:33592` | requireRetailAdmin | tenant-scoped | no | logActivity | no |

**`/api/retail-admin/china-regions/…` — Delivery / Orders.** Province-city-district picker data.  (1 route)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/china-regions` | `routes/retail.js:33457` | requireRetailAdmin | no direct SQL | no | — | no |

**`/api/retail-admin/finance/…` — Finance.** The money-in / money-out ledger and its summary.  (5 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/finance/summary` | `routes/finance-summary.js:82` | requireRetailAdmin | mixed | no | — | no |
| GET | `/api/retail-admin/finance/transactions` | `routes/finance-transactions.js:237` | requireRetailAdmin | mixed | no | — | no |
| POST | `/api/retail-admin/finance/transactions` | `routes/finance-transactions.js:160` | requireRetailAdmin | mixed | no | logActivity | no |
| DELETE | `/api/retail-admin/finance/transactions/:kind/:id` | `routes/finance-transactions.js:218` | requireRetailAdmin | mixed | no | logActivity | no |
| PUT | `/api/retail-admin/finance/transactions/:kind/:id` | `routes/finance-transactions.js:194` | requireRetailAdmin | mixed | no | logActivity | no |

**`/api/retail-admin/feedback/…` — Inbox › Feedback.** Customer feedback threads and replies.  (4 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/feedback` | `routes/retail.js:19134` | requireRetailAdmin | tenant-scoped | yes | — | no |
| GET | `/api/retail-admin/feedback/:id` | `routes/retail.js:19212` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/feedback/:id/reply` | `routes/retail.js:19223` | requireRetailAdmin | tenant-scoped | no | — | no |
| GET | `/api/retail-admin/feedback/unseen-count` | `routes/retail.js:19185` | requireRetailAdmin | tenant-scoped | no | — | no |

**`/api/retail-admin/reviews/…` — Inbox › Reviews.** Customer product reviews and moderation.  (9 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/reviews` | `routes/retail.js:19299` | requireRetailAdmin | tenant-scoped | yes | — | no |
| DELETE | `/api/retail-admin/reviews/:id` | `routes/retail.js:19565` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| PATCH | `/api/retail-admin/reviews/:id` | `routes/retail.js:19476` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/reviews/:id/undismiss` | `routes/retail.js:19553` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/reviews/dismiss-waiting` | `routes/retail.js:19521` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| GET | `/api/retail-admin/reviews/reward` | `routes/retail.js:19585` | requireRetailAdmin | tenant-scoped | no | — | no |
| GET | `/api/retail-admin/reviews/topup` | `routes/retail.js:19600` | requireRetailAdmin | no direct SQL | no | — | no |
| POST | `/api/retail-admin/reviews/topup/run` | `routes/retail.js:19613` | requireRetailAdmin | tenant-scoped | no | logActivity | yes |
| GET | `/api/retail-admin/reviews/unseen-count` | `routes/retail.js:19462` | requireRetailAdmin | tenant-scoped | no | — | no |

**`/api/retail-admin/leaderboard/…` — Loyalty › Leaderboard.** The customer leaderboard.  (3 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/leaderboard/config` | `routes/retail.js:33975` | requireRetailAdmin | no direct SQL | no | — | no |
| PUT | `/api/retail-admin/leaderboard/config` | `routes/retail.js:33980` | requireRetailAdmin | tenant-scoped | no | logActivity | yes |
| GET | `/api/retail-admin/leaderboard/preview` | `routes/retail.js:34038` | requireRetailAdmin | no direct SQL | no | — | no |

**`/api/retail-admin/topup-packages/…` — Loyalty › Top-up.** Prepaid wallet top-up offers.  (4 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/topup-packages` | `routes/retail.js:33638` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/topup-packages` | `routes/retail.js:33644` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| DELETE | `/api/retail-admin/topup-packages/:id` | `routes/retail.js:33686` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| PATCH | `/api/retail-admin/topup-packages/:id` | `routes/retail.js:33663` | requireRetailAdmin | tenant-scoped | no | logActivity | no |

**`/api/retail-admin/topup-transactions/…` — Loyalty › Top-up.** Wallet top-up history.  (2 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/topup-transactions` | `routes/retail.js:33696` | requireRetailAdmin | tenant-scoped | yes | — | no |
| POST | `/api/retail-admin/topup-transactions/:id/finalize` | `routes/retail.js:33710` | requireRetailAdmin | tenant-scoped | yes | logActivity | no |

**`/api/retail-admin/polls/…` — Loyalty › Voting.** Customer polls.  (5 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/polls` | `routes/retail.js:34407` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/polls` | `routes/retail.js:34446` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| DELETE | `/api/retail-admin/polls/:id` | `routes/retail.js:34607` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| GET | `/api/retail-admin/polls/:id` | `routes/retail.js:34420` | requireRetailAdmin | tenant-scoped | no | — | no |
| PUT | `/api/retail-admin/polls/:id` | `routes/retail.js:34491` | requireRetailAdmin | tenant-scoped | no | logActivity | no |

**`/api/retail-admin/voting/…` — Loyalty › Voting.** Voting configuration.  (2 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/voting/config` | `routes/retail.js:34382` | requireRetailAdmin | no direct SQL | no | — | no |
| PUT | `/api/retail-admin/voting/config` | `routes/retail.js:34385` | requireRetailAdmin | tenant-scoped | no | logActivity | no |

**`/api/retail-admin/affiliate/…` — Marketing › Affiliate.** Referral programme: who may earn, settings, referral list, payouts.  (8 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/affiliate/eligible` | `routes/retail.js:18193` | requireRetailAdmin | tenant-scoped | yes | — | no |
| POST | `/api/retail-admin/affiliate/eligible` | `routes/retail.js:18237` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| GET | `/api/retail-admin/affiliate/eligible/search` | `routes/retail.js:18210` | requireRetailAdmin | tenant-scoped | yes | — | no |
| GET | `/api/retail-admin/affiliate/overview` | `routes/retail.js:18347` | requireRetailAdmin | tenant-scoped | no | — | yes |
| GET | `/api/retail-admin/affiliate/referrals` | `routes/retail.js:18430` | requireRetailAdmin | tenant-scoped | yes | — | yes |
| PATCH | `/api/retail-admin/affiliate/referrals/:id` | `routes/retail.js:18589` | requireRetailAdmin | tenant-scoped | no | logActivity | yes |
| GET | `/api/retail-admin/affiliate/settings` | `routes/retail.js:18260` | requireRetailAdmin | no direct SQL | no | — | no |
| PATCH | `/api/retail-admin/affiliate/settings` | `routes/retail.js:18264` | requireRetailAdmin | tenant-scoped | no | logActivity | yes |

**`/api/retail-admin/broadcasts/…` — Marketing › Broadcasts.** Compose and send a message to customers.  (5 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/broadcasts` | `routes/retail.js:6953` | requireRetailAdmin | tenant-scoped | yes | — | no |
| POST | `/api/retail-admin/broadcasts` | `routes/retail.js:6988` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/broadcasts/:id/recall` | `routes/retail.js:7056` | requireRetailAdmin | mixed | yes | logActivity, sendOpsAlert | no |
| GET | `/api/retail-admin/broadcasts/audience-count` | `routes/retail.js:6967` | requireRetailAdmin | no direct SQL | no | — | no |
| GET | `/api/retail-admin/broadcasts/regions` | `routes/retail.js:6975` | requireRetailAdmin | tenant-scoped | no | — | no |

**`/api/retail-admin/voucher-grants/…` — Marketing › Coupons.** Coupons issued to a named customer.  (1 route)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| DELETE | `/api/retail-admin/voucher-grants/:grantId` | `routes/retail.js:16668` | requireRetailAdmin | tenant-scoped | no | — | no |

**`/api/retail-admin/vouchers/…` — Marketing › Coupons.** Coupon definitions.  (6 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/vouchers` | `routes/retail.js:15955` | requireRetailAdmin | tenant-scoped | yes | — | no |
| POST | `/api/retail-admin/vouchers` | `routes/retail.js:15980` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| DELETE | `/api/retail-admin/vouchers/:id` | `routes/retail.js:16096` | requireRetailAdmin | tenant-scoped | yes | — | no |
| PATCH | `/api/retail-admin/vouchers/:id` | `routes/retail.js:16065` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/vouchers/:id/grant` | `routes/retail.js:16623` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| GET | `/api/retail-admin/vouchers/:id/grants` | `routes/retail.js:16601` | requireRetailAdmin | tenant-scoped | yes | — | no |

**`/api/retail-admin/flash-sales/…` — Marketing › Flash sales.** Time-limited price drops.  (1 route)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/flash-sales` | `routes/retail.js:22076` | requireRetailAdmin | tenant-scoped | no | — | no |

**`/api/retail-admin/materials/…` — Materials.** The things the business buys but does not sell.  (8 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/materials` | `routes/retail-materials.js:156` | requireRetailAdmin | SHARED db | no | — | no |
| POST | `/api/retail-admin/materials` | `routes/retail-materials.js:335` | requireRetailAdmin | tenant-scoped | no | — | no |
| GET | `/api/retail-admin/materials/:id` | `routes/retail-materials.js:259` | requireRetailAdmin | SHARED db | yes | — | no |
| PUT | `/api/retail-admin/materials/:id` | `routes/retail-materials.js:398` | requireRetailAdmin | tenant-scoped | no | — | yes |
| PUT | `/api/retail-admin/materials/:id/archive` | `routes/retail-materials.js:470` | requireRetailAdmin | SHARED db | no | — | no |
| GET | `/api/retail-admin/materials/meta/accounting-categories` | `routes/retail-materials.js:251` | requireRetailAdmin | SHARED db | no | — | no |
| GET | `/api/retail-admin/materials/meta/categories` | `routes/retail-materials.js:239` | requireRetailAdmin | SHARED db | no | — | no |
| GET | `/api/retail-admin/materials/meta/kinds` | `routes/retail-materials.js:233` | requireRetailAdmin | SHARED db | no | — | no |

**`/api/retail-admin/setup/…` — Open your store.** The onboarding checklist state.  (2 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/setup` | `routes/retail-setup.js:147` | requireRetailAdmin | no direct SQL | no | — | no |
| POST | `/api/retail-admin/setup` | `routes/retail-setup.js:156` | requireRetailAdmin | tenant-scoped | no | — | no |

**`/api/retail-admin/order-channel-counts/…` — Orders.** Order counts per sales channel, for the filter chips.  (1 route)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/order-channel-counts` | `routes/retail.js:23895` | requireRetailAdmin | tenant-scoped | no | — | no |

**`/api/retail-admin/order-status-counts/…` — Orders.** Order counts per status, for the filter chips.  (1 route)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/order-status-counts` | `routes/retail.js:23817` | requireRetailAdmin | tenant-scoped | no | — | no |

**`/api/retail-admin/orders/…` — Orders.** Everything an order can have done to it: status, refunds, notes, shipping, printing, courier, editing.  (48 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/orders` | `routes/retail.js:23589` | requireRetailAdmin | tenant-scoped | yes | — | no |
| POST | `/api/retail-admin/orders` | `routes/retail.js:23012` | requireRetailAdmin | tenant-scoped | no | logActivity | yes |
| GET | `/api/retail-admin/orders/:id` | `routes/retail.js:23932` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/orders/:id/address/apply-chinese` | `routes/retail.js:24722` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/orders/:id/address/to-chinese` | `routes/retail.js:24652` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/orders/:id/air-delay/ack` | `routes/retail.js:24922` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/orders/:id/alipay-ocr/rerun` | `routes/retail.js:28657` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| GET | `/api/retail-admin/orders/:id/delivery-track` | `routes/retail.js:12522` | requireRetailAdmin | tenant-scoped | no | — | no |
| DELETE | `/api/retail-admin/orders/:id/eta` | `routes/retail.js:27891` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| PUT | `/api/retail-admin/orders/:id/eta` | `routes/retail.js:27863` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| PUT | `/api/retail-admin/orders/:id/invoice` | `routes/retail.js:24207` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/orders/:id/invoice/finalize` | `routes/retail.js:24274` | requireRetailAdmin | no direct SQL | no | — | no |
| POST | `/api/retail-admin/orders/:id/jd-waybill` | `routes/retail.js:27685` | requireRetailAdmin | mixed | no | logActivity | no |
| POST | `/api/retail-admin/orders/:id/jd-waybill/cancel` | `routes/retail.js:27917` | requireRetailAdmin | tenant-scoped | yes | logActivity | yes |
| GET | `/api/retail-admin/orders/:id/jd-waybill/print-data` | `routes/retail.js:28620` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/orders/:id/meituan-action` | `routes/retail.js:24173` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/orders/:id/print` | `routes/retail.js:26989` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| GET | `/api/retail-admin/orders/:id/qingyun/carriers` | `routes/retail.js:25300` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/orders/:id/qingyun/confirm-place` | `routes/retail.js:26092` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/orders/:id/qingyun/confirm-point` | `routes/retail.js:26005` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/orders/:id/qingyun/dispatch` | `routes/retail.js:25336` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/orders/:id/qingyun/reject-places` | `routes/retail.js:26180` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/orders/:id/qingyun/remove-stale` | `routes/retail.js:26287` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/orders/:id/qingyun/reschedule` | `routes/retail.js:26228` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/orders/:id/qingyun/retry-push` | `routes/retail.js:25956` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| GET | `/api/retail-admin/orders/:id/qingyun/ship-from` | `routes/retail.js:25798` | requireRetailAdmin | no direct SQL | no | — | no |
| POST | `/api/retail-admin/orders/:id/qingyun/ship-from` | `routes/retail.js:25815` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/orders/:id/refund-reject` | `routes/retail.js:29314` | requireRetailAdmin | no direct SQL | no | — | no |
| POST | `/api/retail-admin/orders/:id/refund/approve` | `routes/retail.js:28846` | requireRetailAdmin | tenant-scoped | no | logActivity | yes |
| POST | `/api/retail-admin/orders/:id/refund/direct` | `routes/retail.js:29097` | requireRetailAdmin | tenant-scoped | no | logActivity | yes |
| GET | `/api/retail-admin/orders/:id/refund/events` | `routes/retail.js:29317` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/orders/:id/refund/payout` | `routes/retail.js:28969` | requireRetailAdmin | tenant-scoped | no | logActivity | yes |
| POST | `/api/retail-admin/orders/:id/refund/reject` | `routes/retail.js:29312` | requireRetailAdmin | no direct SQL | no | — | no |
| POST | `/api/retail-admin/orders/:id/refund/review` | `routes/retail.js:28817` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/orders/:id/shipment-suggestion/apply` | `routes/retail.js:24355` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/orders/:id/shipments/:sid/deliver` | `routes/retail.js:25020` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/orders/:id/shipments/:sid/dispatch` | `routes/retail.js:24858` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/orders/:id/shipments/:sid/method` | `routes/retail.js:24963` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/orders/:id/shipments/combine` | `routes/retail.js:24415` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/orders/:id/shipments/split` | `routes/retail.js:24475` | requireRetailAdmin | mixed | no | logActivity | no |
| PATCH | `/api/retail-admin/orders/:id/status` | `routes/retail.js:28160` | requireRetailAdmin | tenant-scoped | yes | logActivity | yes |
| DELETE | `/api/retail-admin/orders/:id/tracking` | `routes/retail.js:27822` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| PUT | `/api/retail-admin/orders/:id/tracking` | `routes/retail.js:27051` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/orders/:id/tracking/resubscribe` | `routes/retail.js:27651` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/orders/:id/undo-dispatch` | `routes/retail.js:28680` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/orders/:id/undo-preparing` | `routes/retail.js:28722` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/orders/bulk-tracking` | `routes/retail.js:27555` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| GET | `/api/retail-admin/orders/unseen-count` | `routes/retail.js:22776` | requireRetailAdmin | tenant-scoped | no | — | no |

**`/api/retail-admin/tracking/…` — Orders › Delivery.** Parcel tracking lookups.  (1 route)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/tracking/carriers` | `routes/retail.js:27036` | requireRetailAdmin | no direct SQL | no | — | no |

**`/api/retail-admin/fapiao-settings/…` — Orders › Invoices.** Whether tax invoices are issued automatically.  (2 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/fapiao-settings` | `routes/retail.js:24239` | requireRetailAdmin | no direct SQL | no | — | no |
| PUT | `/api/retail-admin/fapiao-settings` | `routes/retail.js:24243` | requireRetailAdmin | no direct SQL | no | — | no |

**`/api/retail-admin/invoices/…` — Orders › Invoices.** Customer tax-invoice requests.  (2 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/invoices` | `routes/retail.js:24321` | requireRetailAdmin | tenant-scoped | yes | — | no |
| GET | `/api/retail-admin/invoices/unseen-count` | `routes/retail.js:22794` | requireRetailAdmin | tenant-scoped | no | — | yes |

**`/api/retail-admin/order-drafts/…` — Orders › New order.** Half-written manual orders.  (5 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/order-drafts` | `routes/retail.js:23523` | requireRetailAdmin | tenant-scoped | yes | — | no |
| POST | `/api/retail-admin/order-drafts` | `routes/retail.js:23456` | requireRetailAdmin | tenant-scoped | no | — | yes |
| DELETE | `/api/retail-admin/order-drafts/:id` | `routes/retail.js:23579` | requireRetailAdmin | tenant-scoped | no | — | no |
| GET | `/api/retail-admin/order-drafts/:id` | `routes/retail.js:23545` | requireRetailAdmin | tenant-scoped | no | — | no |
| PATCH | `/api/retail-admin/order-drafts/:id` | `routes/retail.js:23560` | requireRetailAdmin | tenant-scoped | no | — | no |

**`/api/retail-admin/order-fees/…` — Orders › New order.** What delivery and packing would cost for a manual order.  (1 route)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| POST | `/api/retail-admin/order-fees` | `routes/retail.js:22960` | requireRetailAdmin | tenant-scoped | no | — | yes |

**`/api/retail-admin/refunds/…` — Orders › Refunds.** The refund queue.  (1 route)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/refunds` | `routes/retail.js:28770` | requireRetailAdmin | tenant-scoped | no | — | no |

**`/api/retail-admin/product-build/…` — Products.** What a made product is built from.  (1 route)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/product-build/materials` | `routes/retail-product-build.js:184` | requireRetailAdmin | mixed | no | — | no |

**`/api/retail-admin/products/…` — Products.** The catalogue: create, edit, duplicate, delete, publish, images, options, bundles, stock, export.  (28 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/products` | `routes/retail.js:22406` | requireRetailAdmin | tenant-scoped | yes | — | no |
| POST | `/api/retail-admin/products` | `routes/retail.js:21705` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| DELETE | `/api/retail-admin/products/:id` | `routes/retail.js:21979` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| GET | `/api/retail-admin/products/:id` | `routes/retail.js:21665` | requireRetailAdmin | tenant-scoped | no | — | no |
| PATCH | `/api/retail-admin/products/:id` | `routes/retail.js:21040` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| GET | `/api/retail-admin/products/:id/build-lines` | `routes/retail-product-build.js:34` | requireRetailAdmin | mixed | no | — | no |
| PUT | `/api/retail-admin/products/:id/build-lines` | `routes/retail-product-build.js:221` | requireRetailAdmin | mixed | no | — | no |
| POST | `/api/retail-admin/products/:id/duplicate` | `routes/retail.js:22004` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| DELETE | `/api/retail-admin/products/:id/flash-sale` | `routes/retail.js:22171` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| PUT | `/api/retail-admin/products/:id/flash-sale` | `routes/retail.js:22111` | requireRetailAdmin | tenant-scoped | yes | logActivity | no |
| GET | `/api/retail-admin/products/:id/image` | `routes/retail.js:22615` | requireRetailAdmin | no direct SQL | no | — | no |
| GET | `/api/retail-admin/products/:id/images` | `routes/retail.js:22632` | requireRetailAdmin | tenant-scoped | yes | — | no |
| GET | `/api/retail-admin/products/:id/recipe-health` | `routes/retail.js:21493` | requireRetailAdmin | tenant-scoped | no | — | no |
| DELETE | `/api/retail-admin/products/:id/recipe-link` | `routes/retail.js:21463` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| PUT | `/api/retail-admin/products/:id/recipe-link` | `routes/retail.js:21401` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/products/:id/restore-version` | `routes/retail.js:20985` | requireRetailAdmin | mixed | yes | logActivity | no |
| GET | `/api/retail-admin/products/:id/sales` | `routes/retail.js:21868` | requireRetailAdmin | tenant-scoped | no | — | no |
| GET | `/api/retail-admin/products/:id/store-stocks` | `routes/retail.js:21803` | requireRetailAdmin | tenant-scoped | no | — | no |
| GET | `/api/retail-admin/products/:id/variant-store-stocks` | `routes/retail.js:21822` | requireRetailAdmin | tenant-scoped | no | — | no |
| GET | `/api/retail-admin/products/:id/variants` | `routes/retail.js:22669` | requireRetailAdmin | tenant-scoped | no | — | no |
| PUT | `/api/retail-admin/products/:id/variants` | `routes/retail.js:22713` | requireRetailAdmin | tenant-scoped | no | — | no |
| GET | `/api/retail-admin/products/:id/versions` | `routes/retail.js:20974` | requireRetailAdmin | tenant-scoped | no | — | no |
| GET | `/api/retail-admin/products/:productId/substitutes` | `routes/retail-inventory.js:544` | requireRetailAdmin | tenant-scoped | no | — | no |
| PUT | `/api/retail-admin/products/:productId/substitutes` | `routes/retail-inventory.js:559` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| GET | `/api/retail-admin/products/:spid/suppliers` | `routes/retail-purchasing.js:1329` | requireRetailAdmin | SHARED db | yes | — | yes |
| GET | `/api/retail-admin/products/export.csv` | `routes/retail.js:21540` | requireRetailAdmin | tenant-scoped | no | — | no |
| GET | `/api/retail-admin/products/highlights` | `routes/retail.js:14213` | requireRetailAdmin | tenant-scoped | yes | — | yes |
| POST | `/api/retail-admin/products/reorder` | `routes/retail.js:22241` | requireRetailAdmin | tenant-scoped | no | logActivity | no |

**`/api/retail-admin/reorder/…` — Products.** Reordering suggestions.  (1 route)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/reorder` | `routes/retail-purchasing.js:2078` | requireRetailAdmin | mixed | yes | — | yes |

**`/api/retail-admin/categories/…` — Products › Categories.** The customer-facing category list.  (5 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/categories` | `routes/retail.js:22192` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/categories` | `routes/retail.js:22296` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| DELETE | `/api/retail-admin/categories/:id` | `routes/retail.js:22312` | requireRetailAdmin | mixed | no | logActivity | no |
| PATCH | `/api/retail-admin/categories/:id` | `routes/retail.js:22268` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/categories/reorder` | `routes/retail.js:22207` | requireRetailAdmin | no direct SQL | no | logActivity | no |

**`/api/retail-admin/category-counts/…` — Products › Categories.** How many products sit in each category.  (1 route)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/category-counts` | `routes/retail.js:440` | requireRetailAdmin | tenant-scoped | no | — | no |

**`/api/retail-admin/category-products/…` — Products › Categories.** The products inside one category.  (1 route)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/category-products` | `routes/retail.js:488` | requireRetailAdmin | tenant-scoped | yes | — | no |

**`/api/retail-admin/category-tree/…` — Products › Categories.** The two-level category tree, read and rewritten whole.  (2 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/category-tree` | `routes/retail.js:429` | requireRetailAdmin | no direct SQL | no | — | no |
| PUT | `/api/retail-admin/category-tree` | `routes/retail.js:529` | requireRetailAdmin | tenant-scoped | yes | — | no |

**`/api/retail-admin/page-templates/…` — Products › Page editor.** Imported custom product-page templates.  (3 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/page-templates` | `routes/retail-page-templates.js:48` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/page-templates` | `routes/retail-page-templates.js:56` | requireRetailAdmin | tenant-scoped | yes | — | no |
| DELETE | `/api/retail-admin/page-templates/:id` | `routes/retail-page-templates.js:108` | requireRetailAdmin | tenant-scoped | no | — | no |

**`/api/retail-admin/inventory/…` — Products › Stock.** The stock grid across locations.  (3 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| POST | `/api/retail-admin/inventory/geocode-backfill` | `routes/retail-inventory.js:498` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| GET | `/api/retail-admin/inventory/geocode-status` | `routes/retail-inventory.js:476` | requireRetailAdmin | tenant-scoped | no | — | no |
| GET | `/api/retail-admin/inventory/grid` | `routes/retail-inventory.js:201` | requireInventoryRead | tenant-scoped | no | — | no |

**`/api/retail-admin/activity/…` — Products › Stock activity.** The stock movement ledger and its CSV download.  (2 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/activity` | `routes/retail.js:14478` | requireRetailAdmin | tenant-scoped | yes | — | no |
| GET | `/api/retail-admin/activity/export.csv` | `routes/retail.js:14561` | requireRetailAdmin | no direct SQL | yes | — | no |

**`/api/retail-admin/purchases/…` — Purchasing.** Purchase orders and receiving.  (14 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/purchases` | `routes/retail-purchasing.js:829` | requireRetailAdmin | SHARED db | yes | — | no |
| POST | `/api/retail-admin/purchases` | `routes/retail-purchasing.js:2288` | requireRetailAdmin | SHARED db | no | logActivity | no |
| DELETE | `/api/retail-admin/purchases/:id` | `routes/retail-purchasing.js:2363` | requireRetailAdmin | SHARED db | no | logActivity | no |
| GET | `/api/retail-admin/purchases/:id` | `routes/retail-purchasing.js:1225` | requireRetailAdmin | mixed | yes | — | no |
| PUT | `/api/retail-admin/purchases/:id` | `routes/retail-purchasing.js:2316` | requireRetailAdmin | SHARED db | no | logActivity | no |
| POST | `/api/retail-admin/purchases/:id/backorder` | `routes/retail-purchasing.js:2128` | requireRetailAdmin | SHARED db | no | logActivity | no |
| GET | `/api/retail-admin/purchases/:id/history` | `routes/retail-purchasing.js:1293` | requireRetailAdmin | SHARED db | yes | — | no |
| PUT | `/api/retail-admin/purchases/:id/landed` | `routes/retail-purchasing.js:2167` | requireRetailAdmin | SHARED db | no | logActivity | no |
| GET | `/api/retail-admin/purchases/:id/receipts` | `routes/retail-purchasing.js:1067` | requireRetailAdmin | SHARED db | no | — | no |
| PUT | `/api/retail-admin/purchases/:id/receive` | `routes/retail-purchasing.js:2528` | requireRetailAdmin | SHARED db | yes | adjustStock, logActivity | no |
| PUT | `/api/retail-admin/purchases/:id/status` | `routes/retail-purchasing.js:2372` | requireRetailAdmin | SHARED db | no | adjustStock, logActivity | no |
| PUT | `/api/retail-admin/purchases/:id/undo-receive` | `routes/retail-purchasing.js:2488` | requireRetailAdmin | SHARED db | no | logActivity | no |
| POST | `/api/retail-admin/purchases/copy-from-kitchen` | `routes/retail-purchasing.js:1151` | requireRetailAdmin | SHARED db | no | logActivity | no |
| GET | `/api/retail-admin/purchases/kitchen-source` | `routes/retail-purchasing.js:1116` | requireRetailAdmin | SHARED db | no | — | no |

**`/api/retail-admin/invoice-file/…` — Purchasing › Invoices.** Download a stored supplier invoice file.  (1 route)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| POST | `/api/retail-admin/invoice-file` | `routes/retail.js:24282` | requireRetailAdmin | tenant-scoped | yes | — | no |

**`/api/retail-admin/purchasing/…` — Purchasing › Invoices.** Supplier invoices, matching and returns.  (12 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/purchasing/invoices` | `routes/retail-purchasing.js:1796` | requireRetailAdmin | SHARED db | no | — | no |
| POST | `/api/retail-admin/purchasing/invoices` | `routes/retail-purchasing.js:1882` | requireRetailAdmin | SHARED db | no | logActivity | no |
| DELETE | `/api/retail-admin/purchasing/invoices/:id` | `routes/retail-purchasing.js:1942` | requireRetailAdmin | SHARED db | no | logActivity | no |
| GET | `/api/retail-admin/purchasing/invoices/:id` | `routes/retail-purchasing.js:1833` | requireRetailAdmin | SHARED db | no | — | no |
| PUT | `/api/retail-admin/purchasing/invoices/:id` | `routes/retail-purchasing.js:1913` | requireRetailAdmin | SHARED db | no | logActivity | no |
| GET | `/api/retail-admin/purchasing/invoices/outstanding` | `routes/retail-purchasing.js:1665` | requireRetailAdmin | SHARED db | no | — | no |
| GET | `/api/retail-admin/purchasing/invoices/rematch/:id` | `routes/retail-purchasing.js:1628` | requireRetailAdmin | no direct SQL | no | — | no |
| POST | `/api/retail-admin/purchasing/invoices/rematch/:id` | `routes/retail-purchasing.js:1637` | requireRetailAdmin | no direct SQL | no | logActivity | no |
| PUT | `/api/retail-admin/purchasing/lines/supplier` | `routes/retail-purchasing.js:2008` | requireRetailAdmin | SHARED db | yes | logActivity | no |
| PUT | `/api/retail-admin/purchasing/po/:id/line/:lineId/invoice-status` | `routes/retail-purchasing.js:2050` | requireRetailAdmin | SHARED db | no | logActivity | no |
| PUT | `/api/retail-admin/purchasing/po/:id/line/:lineId/no-invoice` | `routes/retail-purchasing.js:1972` | requireRetailAdmin | SHARED db | no | logActivity | no |
| PUT | `/api/retail-admin/purchasing/po/:id/no-invoice` | `routes/retail-purchasing.js:1957` | requireRetailAdmin | SHARED db | no | logActivity | no |

**`/api/retail-admin/receiving/…` — Purchasing › Receiving.** Deliveries waiting to be counted in.  (2 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/receiving/deliveries` | `routes/retail-purchasing.js:1005` | requireRetailAdmin | SHARED db | yes | — | no |
| GET | `/api/retail-admin/receiving/deliveries/:id` | `routes/retail-purchasing.js:1043` | requireRetailAdmin | SHARED db | no | — | no |

**`/api/retail-admin/suppliers/…` — Purchasing › Suppliers.** Supplier records and their documents.  (9 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/suppliers` | `routes/retail-purchasing.js:639` | requireRetailAdmin | SHARED db | no | — | no |
| POST | `/api/retail-admin/suppliers` | `routes/retail-purchasing.js:730` | requireRetailAdmin | SHARED db | no | logActivity | no |
| DELETE | `/api/retail-admin/suppliers/:id` | `routes/retail-purchasing.js:786` | requireRetailAdmin | SHARED db | no | logActivity | no |
| GET | `/api/retail-admin/suppliers/:id` | `routes/retail-purchasing.js:666` | requireRetailAdmin | SHARED db | yes | — | no |
| PUT | `/api/retail-admin/suppliers/:id` | `routes/retail-purchasing.js:756` | requireRetailAdmin | SHARED db | no | logActivity | no |
| GET | `/api/retail-admin/suppliers/:id/channel-qr` | `routes/retail-purchasing.js:2067` | requireRetailAdmin | SHARED db | no | — | no |
| POST | `/api/retail-admin/suppliers/:id/documents` | `routes/retail-purchasing.js:795` | requireRetailAdmin | SHARED db | yes | logActivity | no |
| DELETE | `/api/retail-admin/suppliers/:id/documents/:docId` | `routes/retail-purchasing.js:818` | requireRetailAdmin | SHARED db | no | logActivity | no |
| GET | `/api/retail-admin/suppliers/:id/documents/:docId` | `routes/retail-purchasing.js:811` | requireRetailAdmin | SHARED db | no | — | no |

**`/api/retail-admin/quick-stock/…` — Quick Stock app.** Context for the phone stock app.  (1 route)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/quick-stock/context` | `routes/retail-inventory.js:623` | requireRetailAdmin+requireInventoryRead | SHARED db | no | — | no |

**`/api/retail-admin/recipes/…` — Recipes.** Recipes, versions, yields and cost sheets.  (13 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/recipes` | `routes/retail-recipes.js:184` | requireRetailAdmin | SHARED db | no | — | no |
| POST | `/api/retail-admin/recipes` | `routes/retail-recipes.js:363` | requireRetailAdmin | SHARED db | no | — | no |
| GET | `/api/retail-admin/recipes/:id` | `routes/retail-recipes.js:296` | requireRetailAdmin | SHARED db | no | — | no |
| PUT | `/api/retail-admin/recipes/:id` | `routes/retail-recipes.js:408` | requireRetailAdmin | SHARED db | no | — | no |
| PUT | `/api/retail-admin/recipes/:id/archive` | `routes/retail-recipes.js:518` | requireRetailAdmin | SHARED db | no | — | no |
| PUT | `/api/retail-admin/recipes/:id/cost` | `routes/retail-recipes.js:487` | requireRetailAdmin | tenant-scoped | no | — | no |
| DELETE | `/api/retail-admin/recipes/:id/materialize` | `routes/retail-recipes.js:613` | requireRetailAdmin | SHARED db | no | — | no |
| POST | `/api/retail-admin/recipes/:id/materialize` | `routes/retail-recipes.js:600` | requireRetailAdmin | SHARED db | no | — | no |
| GET | `/api/retail-admin/recipes/:id/versions` | `routes/retail-recipes.js:540` | requireRetailAdmin | SHARED db | yes | — | no |
| GET | `/api/retail-admin/recipes/:id/versions/:versionId` | `routes/retail-recipes.js:546` | requireRetailAdmin | no direct SQL | no | — | no |
| POST | `/api/retail-admin/recipes/:id/versions/:versionId/restore` | `routes/retail-recipes.js:552` | requireRetailAdmin | no direct SQL | no | — | no |
| GET | `/api/retail-admin/recipes/materialize-collisions` | `routes/retail-recipes.js:281` | requireRetailAdmin | SHARED db | no | — | no |
| GET | `/api/retail-admin/recipes/meta/categories` | `routes/retail-recipes.js:265` | requireRetailAdmin | SHARED db | no | — | no |

**`/api/retail-admin/reports/…` — Reports.** The period report and its written analysis.  (2 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| POST | `/api/retail-admin/reports/ask` | `routes/retail.js:20668` | requireRetailAdmin | tenant-scoped | yes | — | no |
| POST | `/api/retail-admin/reports/read` | `routes/retail.js:20614` | requireRetailAdmin | tenant-scoped | yes | — | no |

**`/api/retail-admin/sales/…` — Sales.** The channel overview summary.  (1 route)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/sales/summary` | `routes/retail.js:13376` | requireRetailAdmin | tenant-scoped | no | — | yes |

**`/api/retail-admin/store-status/…` — Sales / Settings.** Open or close the shop on each channel.  (4 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/store-status` | `routes/meituan-admin.js:938` | requireRetailAdmin | mixed | no | — | no |
| POST | `/api/retail-admin/store-status/master` | `routes/meituan-admin.js:989` | requireRetailAdmin | mixed | no | — | no |
| POST | `/api/retail-admin/store-status/online` | `routes/meituan-admin.js:968` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/store-status/store/:code` | `routes/meituan-admin.js:1029` | requireRetailAdmin | mixed | no | — | no |

**`/api/retail-admin/channel-hub/…` — Sales › Channels.** The Channels and Delivery hub: set up, connect, pause, disconnect, ask for help.  (19 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/channel-hub` | `routes/integrations-admin.js:147` | requireRetailAdmin | tenant-scoped | no | — | no |
| GET | `/api/retail-admin/channel-hub/:kind` | `routes/integrations-admin.js:164` | requireRetailAdmin | no direct SQL | no | — | no |
| POST | `/api/retail-admin/channel-hub/:kind/box-request` | `routes/integrations-admin.js:202` | requireRetailAdmin | no direct SQL | no | — | no |
| GET | `/api/retail-admin/channel-hub/:kind/session` | `routes/integrations-admin.js:278` | requireRetailAdmin | no direct SQL | no | — | no |
| POST | `/api/retail-admin/channel-hub/:kind/session/sms` | `routes/integrations-admin.js:267` | requireRetailAdmin | no direct SQL | no | — | no |
| POST | `/api/retail-admin/channel-hub/:kind/session/start` | `routes/integrations-admin.js:251` | requireRetailAdmin | no direct SQL | no | — | no |
| POST | `/api/retail-admin/channel-hub/:kind/todos/dismiss` | `routes/integrations-admin.js:227` | requireRetailAdmin | no direct SQL | no | — | no |
| POST | `/api/retail-admin/channel-hub/help` | `routes/integrations-admin.js:177` | requireRetailAdmin | no direct SQL | no | — | no |
| GET | `/api/retail-admin/channel-hub/meituan/stores` | `routes/integrations-admin.js:354` | requireRetailAdmin | mixed | yes | — | no |
| GET | `/api/retail-admin/channel-hub/miniapp/checklist` | `routes/integrations-admin.js:466` | requireRetailAdmin | no direct SQL | no | — | no |
| PATCH | `/api/retail-admin/channel-hub/miniapp/step` | `routes/integrations-admin.js:479` | requireRetailAdmin | SHARED db | no | — | no |
| GET | `/api/retail-admin/channel-hub/miniapp/wechat-config` | `routes/integrations-admin.js:505` | requireRetailAdmin | no direct SQL | no | — | no |
| POST | `/api/retail-admin/channel-hub/miniapp/wechat-creds` | `routes/integrations-admin.js:536` | requireRetailAdmin | SHARED db | no | — | no |
| POST | `/api/retail-admin/channel-hub/miniapp/wechat-pay-verify` | `routes/integrations-admin.js:591` | requireRetailAdmin | mixed | no | — | no |
| GET | `/api/retail-admin/channel-hub/web/config` | `routes/integrations-admin.js:710` | requireRetailAdmin | SHARED db | no | — | no |
| POST | `/api/retail-admin/channel-hub/web/domain` | `routes/integrations-admin.js:754` | requireRetailAdmin | SHARED db | no | — | no |
| DELETE | `/api/retail-admin/channel-hub/web/domain/:domainId` | `routes/integrations-admin.js:788` | requireRetailAdmin | SHARED db | no | — | no |
| POST | `/api/retail-admin/channel-hub/web/domain/:domainId/check` | `routes/integrations-admin.js:776` | requireRetailAdmin | SHARED db | no | — | no |
| POST | `/api/retail-admin/channel-hub/web/signin` | `routes/integrations-admin.js:740` | requireRetailAdmin | no direct SQL | no | — | no |

**`/api/retail-admin/eleme/…` — Sales › Eleme.** Eleme channel configuration and product mapping.  (12 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/eleme/catalogue` | `routes/eleme-admin.js:93` | requireRetailAdmin | mixed | no | — | no |
| GET | `/api/retail-admin/eleme/config` | `routes/eleme-admin.js:60` | requireRetailAdmin | mixed | no | — | no |
| POST | `/api/retail-admin/eleme/enable` | `routes/eleme-admin.js:74` | requireRetailAdmin | mixed | no | — | no |
| GET | `/api/retail-admin/eleme/oauth/start` | `routes/eleme-admin.js:571` | requireRetailAdmin | no direct SQL | no | — | no |
| GET | `/api/retail-admin/eleme/orders` | `routes/eleme-admin.js:542` | requireRetailAdmin | mixed | yes | — | no |
| GET | `/api/retail-admin/eleme/products` | `routes/eleme-admin.js:197` | requireRetailAdmin | mixed | no | — | no |
| POST | `/api/retail-admin/eleme/products/:id/claim` | `routes/eleme-admin.js:359` | requireRetailAdmin | mixed | yes | — | no |
| POST | `/api/retail-admin/eleme/products/:id/map` | `routes/eleme-admin.js:286` | requireRetailAdmin | mixed | yes | — | no |
| POST | `/api/retail-admin/eleme/push-all` | `routes/eleme-admin.js:561` | requireRetailAdmin | tenant-scoped | no | — | no |
| POST | `/api/retail-admin/eleme/shop` | `routes/eleme-admin.js:151` | requireRetailAdmin | mixed | no | — | no |
| GET | `/api/retail-admin/eleme/status` | `routes/eleme-admin.js:510` | requireRetailAdmin | mixed | yes | — | no |
| GET | `/api/retail-admin/eleme/stores` | `routes/eleme-admin.js:126` | requireRetailAdmin | mixed | no | — | no |

**`/api/retail-admin/meituan/…` — Sales › Meituan.** Meituan channel configuration, mapping and bundles.  (17 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/meituan/bundles` | `routes/meituan-admin.js:610` | requireRetailAdmin | mixed | no | — | no |
| POST | `/api/retail-admin/meituan/bundles` | `routes/meituan-admin.js:658` | requireRetailAdmin | mixed | no | logActivity | no |
| DELETE | `/api/retail-admin/meituan/bundles/:id` | `routes/meituan-admin.js:735` | requireRetailAdmin | mixed | no | — | no |
| POST | `/api/retail-admin/meituan/bundles/:id/push` | `routes/meituan-admin.js:749` | requireRetailAdmin | mixed | no | — | no |
| GET | `/api/retail-admin/meituan/business-status` | `routes/meituan-admin.js:856` | requireRetailAdmin | mixed | no | — | no |
| POST | `/api/retail-admin/meituan/business-status` | `routes/meituan-admin.js:892` | requireRetailAdmin | mixed | no | — | no |
| GET | `/api/retail-admin/meituan/config` | `routes/meituan-admin.js:330` | requireRetailAdmin | no direct SQL | no | — | no |
| POST | `/api/retail-admin/meituan/enable` | `routes/meituan-admin.js:335` | requireRetailAdmin | mixed | yes | — | no |
| GET | `/api/retail-admin/meituan/listings` | `routes/meituan-admin.js:795` | requireRetailAdmin | mixed | no | — | no |
| POST | `/api/retail-admin/meituan/listings/refresh` | `routes/meituan-admin.js:765` | requireRetailAdmin | mixed | no | — | no |
| GET | `/api/retail-admin/meituan/orders` | `routes/meituan-admin.js:540` | requireRetailAdmin | mixed | yes | — | no |
| GET | `/api/retail-admin/meituan/products` | `routes/meituan-admin.js:33` | requireRetailAdmin | mixed | no | — | no |
| POST | `/api/retail-admin/meituan/products/:id/claim` | `routes/meituan-admin.js:234` | requireRetailAdmin | mixed | yes | — | no |
| POST | `/api/retail-admin/meituan/products/:id/map` | `routes/meituan-admin.js:181` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/meituan/push-all` | `routes/meituan-admin.js:569` | requireRetailAdmin | mixed | no | — | no |
| GET | `/api/retail-admin/meituan/status` | `routes/meituan-admin.js:479` | requireRetailAdmin | mixed | yes | — | yes |
| GET | `/api/retail-admin/meituan/stores` | `routes/meituan-admin.js:148` | requireRetailAdmin | mixed | no | — | no |

**`/api/retail-admin/guanyi/…` — Sales › gzgrocery.** Partner ERP channel configuration and mapping.  (12 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/guanyi/analytics` | `routes/guanyi-admin.js:396` | requireRetailAdmin | mixed | no | — | no |
| POST | `/api/retail-admin/guanyi/auto-match` | `routes/guanyi-admin.js:158` | requireRetailAdmin | mixed | no | — | no |
| GET | `/api/retail-admin/guanyi/listings` | `routes/guanyi-admin.js:210` | requireRetailAdmin | mixed | yes | — | no |
| POST | `/api/retail-admin/guanyi/listings/refresh` | `routes/guanyi-admin.js:195` | requireRetailAdmin | mixed | no | — | no |
| GET | `/api/retail-admin/guanyi/pickups` | `routes/guanyi-admin.js:275` | requireRetailAdmin | mixed | yes | — | no |
| POST | `/api/retail-admin/guanyi/pickups/:id/apply` | `routes/guanyi-admin.js:344` | requireRetailAdmin | mixed | no | adjustStock | no |
| POST | `/api/retail-admin/guanyi/pickups/:id/ignore` | `routes/guanyi-admin.js:373` | requireRetailAdmin | mixed | no | — | no |
| GET | `/api/retail-admin/guanyi/products` | `routes/guanyi-admin.js:39` | requireRetailAdmin | mixed | no | — | no |
| POST | `/api/retail-admin/guanyi/products/:id/map` | `routes/guanyi-admin.js:104` | requireRetailAdmin | mixed | no | — | no |
| POST | `/api/retail-admin/guanyi/push-all` | `routes/guanyi-admin.js:247` | requireRetailAdmin | mixed | no | — | no |
| GET | `/api/retail-admin/guanyi/status` | `routes/guanyi-admin.js:229` | requireRetailAdmin | mixed | yes | — | no |
| GET | `/api/retail-admin/guanyi/stores` | `routes/guanyi-admin.js:87` | requireRetailAdmin | mixed | no | — | no |

**`/api/retail-admin/brand/…` — Set up › Brand studio.** AI brand generator: generate, poll, apply and publish a look.  (5 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| POST | `/api/retail-admin/brand/apply` | `routes/retail.js:20717` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/brand/generate` | `routes/retail.js:20699` | requireRetailAdmin | no direct SQL | no | logActivity | no |
| GET | `/api/retail-admin/brand/job/:id` | `routes/retail.js:20709` | requireRetailAdmin | no direct SQL | no | — | no |
| POST | `/api/retail-admin/brand/publish` | `routes/retail.js:20739` | requireRetailAdmin | mixed | yes | logActivity | no |
| GET | `/api/retail-admin/brand/status` | `routes/retail.js:20474` | requireRetailAdmin | no direct SQL | no | — | no |

**`/api/retail-admin/config/…` — Settings.** The shop settings key-value store.  (4 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/config` | `routes/retail.js:20331` | requireRetailAdmin | no direct SQL | no | — | no |
| PUT | `/api/retail-admin/config` | `routes/retail.js:20357` | requireRetailAdmin | no direct SQL | no | logActivity | no |
| GET | `/api/retail-admin/config/gz-excluded-districts` | `routes/retail-inventory.js:575` | requireRetailAdmin | no direct SQL | no | — | no |
| PUT | `/api/retail-admin/config/gz-excluded-districts` | `routes/retail-inventory.js:579` | requireRetailAdmin | tenant-scoped | no | logActivity | no |

**`/api/retail-admin/system-alerts/…` — Settings › Alerts.** The ops alert webhook configuration.  (1 route)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| POST | `/api/retail-admin/system-alerts/test` | `routes/retail.js:20384` | requireRetailAdmin | tenant-scoped | yes | — | no |

**`/api/retail-admin/wecom/…` — Settings › Alerts.** The staff-chat alert webhook.  (1 route)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| POST | `/api/retail-admin/wecom/test` | `routes/retail.js:26330` | requireRetailAdmin | no direct SQL | no | — | no |

**`/api/retail-admin/integrations/…` — Settings › Integrations.** Credentials for printers, SMS, maps, invoicing and payment providers.  (9 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/integrations` | `routes/retail.js:25131` | requireRetailAdmin | no direct SQL | no | — | no |
| PUT | `/api/retail-admin/integrations` | `routes/retail.js:26353` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| POST | `/api/retail-admin/integrations/aliyun_sms/test` | `routes/retail.js:26466` | requireRetailAdmin | mixed | no | — | no |
| POST | `/api/retail-admin/integrations/jd/test` | `routes/retail.js:26436` | requireRetailAdmin | no direct SQL | no | — | no |
| POST | `/api/retail-admin/integrations/kd100/test` | `routes/retail.js:27020` | requireRetailAdmin | no direct SQL | no | — | no |
| POST | `/api/retail-admin/integrations/nuonuo/test` | `routes/retail.js:26456` | requireRetailAdmin | no direct SQL | no | — | no |
| GET | `/api/retail-admin/integrations/qingyun` | `routes/retail.js:25168` | requireRetailAdmin | no direct SQL | no | — | no |
| POST | `/api/retail-admin/integrations/qingyun/autopush` | `routes/retail.js:25179` | requireRetailAdmin | tenant-scoped | yes | — | no |
| POST | `/api/retail-admin/integrations/qingyun/request` | `routes/retail.js:26304` | requireRetailAdmin | tenant-scoped | no | sendOpsAlert | no |

**`/api/retail-admin/alipay-manual/…` — Settings › Payments.** The manual Alipay transfer details shown to customers.  (2 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/alipay-manual` | `routes/retail.js:20415` | requireRetailAdmin | no direct SQL | no | — | no |
| PUT | `/api/retail-admin/alipay-manual` | `routes/retail.js:20428` | requireRetailAdmin | tenant-scoped | yes | logActivity | no |

**`/api/retail-admin/printer/…` — Settings › Printing.** The thermal printer: list, test, reprint.  (4 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/printer` | `routes/retail.js:26818` | requireRetailAdmin | tenant-scoped | no | — | no |
| PUT | `/api/retail-admin/printer` | `routes/retail.js:26851` | requireRetailAdmin | no direct SQL | no | logActivity | no |
| GET | `/api/retail-admin/printer/preview` | `routes/retail.js:26923` | requireRetailAdmin | tenant-scoped | yes | — | no |
| POST | `/api/retail-admin/printer/test` | `routes/retail.js:26960` | requireRetailAdmin | tenant-scoped | yes | — | no |

**`/api/retail-admin/sku/…` — Settings › SKU codes.** The automatic product-code numbering rules.  (6 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/sku/:entity` | `routes/sku.js:83` | requireRetailAdmin | tenant-scoped | no | — | no |
| GET | `/api/retail-admin/sku/:entity/next` | `routes/sku.js:182` | requireRetailAdmin | no direct SQL | no | — | no |
| POST | `/api/retail-admin/sku/:entity/pattern-preview` | `routes/sku.js:155` | requireRetailAdmin | no direct SQL | no | — | no |
| POST | `/api/retail-admin/sku/:entity/rules` | `routes/sku.js:135` | requireRetailAdmin | no direct SQL | no | — | no |
| DELETE | `/api/retail-admin/sku/:entity/rules/:id` | `routes/sku.js:142` | requireRetailAdmin | no direct SQL | no | — | no |
| PUT | `/api/retail-admin/sku/:entity/settings` | `routes/sku.js:124` | requireRetailAdmin | no direct SQL | no | — | no |

**`/api/retail-admin/geocode/…` — Settings › Stores.** Turn a typed address into a map pin.  (1 route)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| POST | `/api/retail-admin/geocode` | `routes/retail-inventory.js:176` | requireRetailAdmin | no direct SQL | no | — | no |

**`/api/retail-admin/stores/…` — Settings › Stores.** Locations, their stock and their reservations.  (8 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/stores` | `routes/retail-inventory.js:95` | requireInventoryRead | no direct SQL | no | — | no |
| POST | `/api/retail-admin/stores` | `routes/retail-inventory.js:99` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| DELETE | `/api/retail-admin/stores/:id` | `routes/retail-inventory.js:185` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| PATCH | `/api/retail-admin/stores/:id` | `routes/retail-inventory.js:141` | requireRetailAdmin | tenant-scoped | no | logActivity | no |
| GET | `/api/retail-admin/stores/:id/ledger` | `routes/retail-inventory.js:430` | requireRetailAdmin | tenant-scoped | yes | — | no |
| GET | `/api/retail-admin/stores/:id/reservations` | `routes/retail-inventory.js:417` | requireRetailAdmin | tenant-scoped | yes | — | no |
| GET | `/api/retail-admin/stores/:id/stock` | `routes/retail-inventory.js:248` | requireInventoryRead | tenant-scoped | no | adjustStock | no |
| PATCH | `/api/retail-admin/stores/:storeId/stock/:productId` | `routes/retail-inventory.js:302` | requireInventoryRead | mixed | no | adjustStock, enqueueChannelSync, logActivity | no |

**`/api/retail-admin/poi-search/…` — Settings › Stores / Orders.** Address search against the map provider.  (1 route)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| POST | `/api/retail-admin/poi-search` | `routes/retail.js:8734` | requireRetailAdmin | no direct SQL | no | — | no |

**`/api/retail-admin/stream/…` — Shell.** A live event stream that pushes activity into the open admin.  (1 route)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/stream` | `routes/retail.js:15070` | requireRetailAdmin | no direct SQL | no | — | no |

**`/api/retail-admin/waste/…` — Waste.** Recording and voiding stock written off.  (6 routes)

| Method | Path | Where | Gate | Data handle | Pages? | Side effects | Money math |
|---|---|---|---|---|---|---|---|
| GET | `/api/retail-admin/waste` | `routes/retail-waste.js:300` | requireRetailAdmin | mixed | yes | — | no |
| POST | `/api/retail-admin/waste` | `routes/retail-waste.js:353` | requireRetailAdmin | mixed | no | adjustStock, enqueueChannelSync, logActivity | no |
| POST | `/api/retail-admin/waste/:id/void` | `routes/retail-waste.js:524` | requireRetailAdmin | mixed | no | adjustStock, logActivity | no |
| GET | `/api/retail-admin/waste/preview` | `routes/retail-waste.js:231` | requireRetailAdmin | tenant-scoped | no | — | yes |
| GET | `/api/retail-admin/waste/products` | `routes/retail-waste.js:194` | requireRetailAdmin | mixed | yes | — | no |
| GET | `/api/retail-admin/waste/reasons` | `routes/retail-waste.js:178` | requireRetailAdmin | no direct SQL | no | — | no |

---

## 7. Every database read and write of merchant-owned data, and whether it is scoped

### 7.1 The two handles

*Data-plane table* — a table holding one merchant's own business data (products,
orders, customers, stock, suppliers, recipes, media, settings). *Control-plane table* —
a table that is shared by design and holds the platform's own records (the list of
merchants, staff logins, sessions, billing, the activity log). The code names 15 tables
as control-plane at `lib/tenant-db.js:90-95`; everything else is data-plane.

- `tdb()` returns **the signed-in merchant's** database (`lib/tenant-db.js:72`).
- The module-level `db` — `const db = require('../database')` at the top of a route file
  — is always **the shared database**, which is Roots'.

Some handlers rebind `const db = tdb()` inside the function, which makes `db` scoped
for that block; the counts below account for that by tracking the rebinding block.

### 7.2 Counts — corrected

*(An earlier draft of this section over-counted. The first pass treated any bare
`db` as the shared handle; in `routes/retail.js` most of those sit inside helper
functions that take `db` as an argument and are called with `tdb()` — for example
`productContentSnapshot(db, id)` at `:20924`, called from `:21048` and `:21334` with
`tdb()`, and the restore-version route which opens with `const db = tdb()` at `:20986`.
The figures below resolve each call site to its enclosing scope. `routes/ai.js` is also
excluded: its 55 shared-handle statements belong to the kitchen assistant behind
`requireAuth`, not the merchant admin.)*

Across the admin API, **121 statements read or write merchant-owned data through the
shared database handle**, all in three files:

| File | Statements | Of those, carrying an explicit `tenant_id` filter |
|---|---|---|
| `routes/retail-purchasing.js` | 81 | 19 |
| `routes/retail-recipes.js` | 26 | 0 |
| `routes/retail-materials.js` | 14 | 0 |

**102 carry no merchant filter of any kind** — 66 reads and **36 writes** (14 inserts,
14 updates, 8 deletes). The tables they touch are `po_line_items` (33), `purchase_orders`
(29), `recipes` (15), `suppliers` (13), `ingredients` (11), `invoices` (6),
`recipe_ingredients` (5), `supplier_documents` (4), `invoice_lines` (4), `recipe_steps`
(4), `expense_entries` (3).

Everything else in the admin API resolves to the signed-in merchant's own database:
`routes/retail.js` alone makes 1,105 such calls, `lib/inventory.js` 64,
`routes/restock.js` 42, `routes/retail-inventory.js` 24.

Two of the three files document the hazard in their own opening comments and then use the
shared handle anyway:

- `routes/retail-recipes.js:31-36` — *"`recipe_cost_data`, `recipes` and `ingredients`
  are data-plane tables with no tenant_id column, so under data isolation they live in
  the tenant's own DB and the global handle is Roots'."*
- `routes/retail-materials.js:25-33` — the same note, and the cost path really does go
  through `tdb()` (`:363`, `:370`, `:381`, `:403`). The archive route four hundred lines
  later does not (`:471-476`).

### 7.3 The 36 writes that carry no merchant filter

| Where | What is written |
|---|---|
| `routes/retail-purchasing.js:124`, `:134` | the expense ledger rows a purchase order posts (delete then re-insert) |
| `:741` | a new supplier |
| `:802`, `:820` | a supplier document, added and removed |
| `:1191`, `:2138`, `:2300` | a new purchase order |
| `:1862`, `:1923`, `:1931` | supplier invoice and its lines |
| `:2027`, `:2144`, `:2172`, `:2207`, `:2217`, `:2285`, `:2336`, `:2367`, `:2368`, `:2419`, `:2423`, `:2511`, `:2515`, `:2651`, `:2719` | purchase-order headers and their lines, through the whole ordering, receiving and cancelling flow |
| `routes/retail-recipes.js:376`, `:384`, `:394` | a new recipe with its materials and steps |
| `:427`, `:449`, `:450`, `:462`, `:463`, `:522` | editing a recipe — its materials and steps are deleted and re-inserted |
| `routes/retail-materials.js:474` | archiving or restoring a material |

### 7.4 Lookups by id

The admin fetches records by numeric id in most sections (`orders/:id`,
`customers/:id`, `products/:id`, `media/:id`, `stores/:id`, `materials/:id`,
`purchases/:id`, `suppliers/:id`, `recipes/:id`, …). Where the query runs on `tdb()`,
the merchant's own database is the boundary and no extra check is needed. Where it runs
on the shared handle, the boundary is whatever the SQL itself says: `suppliers` and
`purchase_orders` in `routes/retail-purchasing.js` mostly carry
`AND COALESCE(tenant_id,1) = ?` (31 statements), while `po_line_items`, `invoices`,
`invoice_lines`, `supplier_documents`, `recipes`, `ingredients` and
`retail_product_versions` are addressed by id alone.

### 7.5 Where merchant data is decided outside SQL

- `lib/tenant-db.js:212-223` — `currentTenantId()` throws rather than guessing when it
  cannot identify the active merchant.
- `middleware/public-tenant.js:59-68` — the customer-facing side identifies the merchant
  by a WeChat app id header, falling back to the web address; anything unrecognised
  lands on Roots.
- `routes/retail.js:226-233` — whether a merchant may edit their own catalogue at all is
  read from `tenants.product_catalog_mode` per call.
- 77 places branch on merchant number 1 specifically (`ROOTS_TENANT_ID`,
  `tenant_id = 1`, `COALESCE(tenant_id,1)`) — 29 in `routes/retail.js`, 21 in
  `routes/retail-purchasing.js`, the rest in the tenancy and credential libraries.

---

## 8. Money — every place it is calculated, rounded, or stored

### 8.1 How money is stored

61 money columns across 32 tables (extracted from the 139 `CREATE TABLE` definitions in
`schema.sql` and `database.js`, plus the 339 later column additions). **51 are `REAL`**
— floating-point — 6 are `INTEGER`, 4 are `TEXT`. The only integer-in-smallest-unit
column found is `guanyi_listing_jobs.cost_total_cents`; the billing tables carry their
own `*_cents` columns (`billing_invoices.amount_cents`, `billing_plans.price_cents`,
`tenants.setup_fee_cents`), so the platform's own money and the merchant's money are
stored in different units.

### 8.2 The formatting helpers

There is no single money helper. There are seven, and they disagree.

| Helper | File:line | Rule | Currency |
|---|---|---|---|
| `acMoney(n, dp)` | `public/retail-admin/01-core.js:176-183` | `toFixed(merchant's decimals)`, symbol before or after per setting | **the merchant's own setting** |
| `fmt(n)` | `public/retail-admin/01-core.js:141` | `toFixed(2)`, no symbol | n/a |
| `dashMoney(n, dp)` | `public/retail-admin/03-dashboard.js:21` | `toLocaleString`, **0 decimal places by default** | hardcoded `¥` |
| `money(cur, n)` | `public/m.html:9576` | 2 decimals if there is a fraction, otherwise 0 | `¥` as fallback |
| `money0(cur, n)` | `public/m.html:9581` | `Math.round`, whole units | `¥` as fallback |
| `yuan(n)` | `public/till.html:845` | `toFixed(2)` plus thousands separators, minus sign before the symbol | hardcoded `¥` |
| `yuan(n)` | `public/retail-admin/12-guanyi.js:434`, `:445` | `toLocaleString` fixed at 2 decimals | hardcoded `¥` |
| `money(n)` | `lib/feie.js:156` | `toFixed(2)` | hardcoded full-width `￥` (deliberate — thermal printers) |
| `yuan(n)` | `routes/retail.js:5556` | `toFixed(2)` | hardcoded `¥` |

### 8.3 A per-merchant currency setting exists, and most screens ignore it

The merchant's currency is stored (`storefront_config` key `currency`), normalised
server-side to `{code, symbol, decimals, position}` (`routes/retail.js:336-343`), and
read in the admin by `acCurrency()` / `acMoney()` (`public/retail-admin/01-core.js:154-183`).

**8 of the 23 admin JavaScript files call it. 19 contain a hardcoded `¥`.**

| File | hardcoded `¥` | uses the merchant's currency |
|---|---|---|
| `04-orders.js` | 77 | 5 |
| `07-content-billing.js` | 32 | 0 |
| `10-extras.js` | 26 | 0 |
| `09-products.js` | 22 | 1 |
| `06-delivery.js` | 22 | 0 |
| `05-marketing.js` | 21 | 0 |
| `03-dashboard.js` | 18 | 0 |
| `08-customers.js` | 15 | 0 |
| `19-recipes.js` | 12 | 2 |
| `16-purchasing.js` | 5 | 2 |
| `20-waste.js` | 5 | 1 |
| `21-product-build.js` | 4 | 2 |
| `22-finance.js` | 3 | 0 |
| `12-guanyi.js` | 3 | 0 |
| `18-materials.js` | 2 | 1 |
| `01-core.js` | 4 | 4 |
| `02-settings-ops.js`, `14-eleme.js`, `17-setup-guide.js` | 1 each | 0 |

Elsewhere: 78 in `public/retail-admin.html`, 79 in `public/cms.html`, 28 in
`public/m.html`, 105 in `routes/retail.js`, 30 in `database.js` (seed data).
Total hardcoded currency symbols across the admin and its API: **844**.

### 8.4 Rounding and arithmetic sites

Counted as `toFixed(` + `Math.round(` occurrences, which is where a rounding decision
is made:

| Area | File | `toFixed` | `Math.round` |
|---|---|---|---|
| Dashboard & Reports | `03-dashboard.js` | 66 | 33 |
| Orders | `04-orders.js` | 17 | 33 |
| Tacet Mobile | `m.html` | 17 | 25 |
| Online-store editor | `cms.html` | 38 | 17 |
| Purchasing | `16-purchasing.js` | 7 | 1 |
| Recipes | `19-recipes.js` | 7 | 4 |
| Admin API | `routes/retail.js` | 83 | 89 |
| AI routes | `routes/ai.js` | 33 | 1 |
| Courier payload | `lib/qingyun-payload.js` | 6 | 20 |
| Everything else in `routes/` + `lib/` | — | 21 | 77 |

**Admin front end: 129 `toFixed` + 114 `Math.round`. Admin API and libraries: 143 + 187.**

### 8.5 Money arithmetic done in SQL rather than in a helper

`SUM(...)`, `ROUND(...)` and multiplication of money columns appear inside SQL strings
throughout — for example the purchase-order line total posted to the expense ledger,
`SUM(billableQty * COALESCE(cost_per_unit, 0))`, built as a string at
`routes/retail-purchasing.js:126`; the dashboard's takings; the finance summary; the
customer lifetime-spend rollups. These bypass every helper in §8.2, so their rounding is
SQLite's.

### 8.6 Tax

Searched for tax handling across the admin and its API. There is **no tax engine**:
no tax rate setting, no tax-inclusive/exclusive switch, no tax line on an order.
What exists is (a) `purchase_orders.extra_tax`, a free-typed amount a buyer adds to a
supplier order (`routes/retail-purchasing.js`), and (b) fapiao — the Chinese tax
invoice — as a request a customer makes on an order, plus a scaffolded connection to one
invoicing provider (`lib/nuonuo.js`, `routes/retail.js:24239`, `:26456`).

---

## 9. Language — how the admin decides what words to show

### 9.1 Four different mechanisms, all live at once

| Mechanism | Where | How it works |
|---|---|---|
| `cuT('English', '中文')` | admin JavaScript | picks one string at call time (`public/retail-admin/10-extras.js:1781`) |
| `T('English', '中文')` | 6 newer admin files | a local alias for the same function (`16-purchasing.js:32`, `18-materials.js:26`, `19-recipes.js:73`, `20-waste.js:76`, `05-marketing.js:2325`, `01-core.js:308`) |
| A text node reading `English · 中文` | markup, and strings passed to `toast()` | a DOM walker splits on the middle dot at render and keeps only one half; a mutation observer catches anything added later (`10-extras.js:1765-1794`, `processSubtree` at `:1735`) |
| Paired `<span class="en">` / `<span class="cn">`, and `L(en, cn)` | the standalone pages — sign-in, profile, brand | CSS hides one class; a separate implementation from the shell's |

A fifth exists as a stopgap: `EN_ONLY_MAP`, a 45-entry English→Chinese lookup for
strings that were shipped English-only and are translated after the fact
(`10-extras.js:1476-1520`).

### 9.2 Counts

**Pairing calls in the admin's own JavaScript: 3,921** — 2,873 `cuT(` + 1,048 `T(`
(comments stripped). Per file:

| File | `cuT(` | `T(` | File | `cuT(` | `T(` |
|---|---|---|---|---|---|
| `04-orders.js` | 612 | 0 | `16-purchasing.js` | 1 | 548 |
| `09-products.js` | 491 | 0 | `19-recipes.js` | 1 | 235 |
| `15-integrations.js` | 288 | 0 | `18-materials.js` | 1 | 108 |
| `03-dashboard.js` | 249 | 0 | `23-sku.js` | 1 | 76 |
| `08-customers.js` | 165 | 0 | `20-waste.js` | 1 | 61 |
| `05-marketing.js` | 164 | 9 | `21-product-build.js` | 37 | 0 |
| `02-settings-ops.js` | 152 | 0 | `22-finance.js` | 40 | 0 |
| `11-meituan.js` | 146 | 0 | `06-delivery.js` | 34 | 0 |
| `01-core.js` | 131 | 11 | `10-extras.js` | 25 | 0 |
| `17-setup-guide.js` | 126 | 0 | `13-activity.js` | 1 | 0 |
| `07-content-billing.js` | 118 | 0 | `12-guanyi.js` | 0 | 0 |
| `14-eleme.js` | 89 | 0 | | | |

**Paired text in markup** (`<script>`, `<style>` and comments removed):

| Page | Text nodes | Carrying `English · 中文` | English only | Chinese only |
|---|---|---|---|---|
| `public/retail-admin.html` | 2,094 | 1,484 | 278 | 112 |
| `public/cms.html` | 231 | 38 | 98 | 72 |
| `public/backend-account.html` | 82 | 1 | 33 | 32 |
| `public/backend-login.html` | 66 | 1 | 27 | 27 |
| `public/product-editor.html` | 55 | 36 | 8 | 6 |
| `public/stock.html` | 41 | 1 | 1 | 1 |
| `public/backend-signup.html` | 26 | 16 | 3 | 2 |
| `public/backend-brand.html` | 18 | 1 | 8 | 9 |
| `public/backend-billing.html` | 12 | 10 | 1 | 0 |
| `public/till.html` | 3 | 0 | 3 | 0 |

*(The sign-in, profile and brand pages show low pair counts because they use the
`.en`/`.cn` span mechanism instead — the "English only" and "Chinese only" columns there
are the two halves of the same pairs, not untranslated strings.)*

**Message strings** — everything passed to `toast()`, `alert()`, `confirm()`, or set as
a `placeholder`, `title` or `aria-label` in the 23 admin JavaScript files: **866 total**.
Of those, 271 go through `cuT`/`T`, 209 are a single `English · 中文` string that the DOM
walker splits, **128 are English only**, 7 are Chinese only, and **33 pass a variable
straight through** — in most cases a raw error from the server
(`toast(e.message, 'err')`, e.g. `16-purchasing.js:499`, `:548`, `:686`).

### 9.3 Bilingual database columns

**73 columns across 23 tables** hold a second-language value, named `_en` / `_cn`:
`ingredients`, `recipes`, `recipe_ingredients`, `recipe_versions`, `products`,
`po_line_items`, `restock_orders`, `restock_items`, `kitchen_order_items`,
`packaging_types`, `suppliers`, `markets`, `miniapp_orders`, `retail_customers`, and
others. Only one table carries an actual language column: `retail_synthetic_reviews.lang`.

There is **no language column on the merchant record and none on a staff account** —
nowhere for a merchant to say which languages their business works in, and nowhere for
a member of staff to record their own.

### 9.4 Where the displayed language is decided

| Decision point | Where | Decided by |
|---|---|---|
| Desktop admin | `localStorage['roots-admin-lang']`, default `'en'` (`10-extras.js:1471-1475`) | the viewer, on this browser |
| Tacet Mobile | `localStorage['tacet-m-lang']` (`m.html:730`), own `T(en, zh)` at `m.html:400` | the viewer, on this phone — **a separate setting from the desktop one** |
| Profile / sign-in / brand pages | read `roots-admin-lang` (`backend-account.html:15`) and post `fc-lang` messages to the shell | shared with the desktop admin |
| Quick Stock | shares the admin language key; theme uses its own key `roots_theme` | the viewer |
| Customer parcel-tracking page | `?lang=cn` in the address, default English (`routes/retail.js:11232`, `:27184`) | **the link, not the reader** |
| Thermal printer receipts | fixed layout in `lib/feie.js` | neither — the template |
| Text-message codes | an Aliyun template code per message; no language argument (`lib/aliyun-sms.js:86-96`) | the template registered with the provider |

The language toggle itself is not in the top bar: it is inside the Profile pop-up
(`backend-account.html`, wired at `:1211`).

### 9.5 Readiness for a third language

No language registry, no translation files, no locale negotiation, and no use of
`Accept-Language` anywhere. Two languages are the shape of every mechanism above: a
function of two arguments, a string with one separator, a pair of CSS classes, a pair of
database columns. There are 61 `toLocaleString`-family calls in the admin front end and
1 in the API; none is passed a fixed locale, so number and date formatting follows the
viewer's browser, which is the one part of this that would already work anywhere.

---

## 10. Notifications, emails and alerts

### 10.1 What the system can send

| # | What | Trigger | Channel | Who receives it | Where |
|---|---|---|---|---|---|
| 1 | New customer order | An order is paid | Web push | Every operator of that merchant | `routes/retail.js:4834`, `:28398` → `push.js:372` |
| 2 | New customer order (legacy path) | Same | Web push | Kitchen users holding the `retail` permission | `routes/retail.js:4818` → `push.js:202` |
| 3 | Order status changes (7 templates) | An order moves to a status in `ORDER_STATUS_NOTIF` | WeChat subscribe message | The **customer** | `routes/retail.js:6185`, sent at `:6376`, `:6632` |
| 4 | Order receipt / add-on slip | An order is paid, if auto-print is on | Thermal printer at the shop | The shop | `routes/retail.js:26624`, `:26649`; template `lib/feie.js` |
| 5 | "Deliver soon" — 30 minutes before the chosen window | Sweeper every 60s | Web push | Kitchen users with the `retail` permission | `lib/delivery-reminders.js:54-66` |
| 6 | "Deliver today" — 10:00 on the day | Same sweeper | Web push | Same | `lib/delivery-reminders.js:44-48` |
| 7 | "Prepare for pickup" — 20 minutes before | Same sweeper | Web push | Same | `lib/delivery-reminders.js:70` |
| 8 | Transfer / stock-request events | A transfer is raised, picked, or received | Web push | Operators holding the matching capability, filtered to the location | `routes/restock.js:259` → `push.js:333` |
| 9 | Purchase-order events | A PO is raised | Web push | Kitchen users with the `purchases` permission | `routes/purchases.js:297` |
| 10 | Sign-in code (email) | Two-factor by email, password reset | Email | The staff member | `routes/backend-auth.js` (4 call sites) → `lib/email-sender.js:38` |
| 11 | Sign-in code (text message) | Two-factor by SMS | SMS via Aliyun | The staff member | `lib/aliyun-sms.js:137` |
| 12 | Push self-test | The operator presses "test" in Profile → Notifications | Web push | Themselves | `routes/backend-auth.js:1158-1163` |
| 13 | Channel session expired / store box offline | Integration health | **WeCom app message to the merchant's own staff chat** | Everyone in the merchant's WeCom app | `lib/tenant-notify.js:29` |
| 14 | Platform alerts (many) | Crashes, route errors, sync stalls, queue problems, geocoder holds | WeCom webhook | **Tacet's own operations desk, not the merchant** | `lib/ops-alert.js:264`; called from `server.js` (3), `routes/retail.js` (5), the drift sweeps (4), `lib/alert-latch.js` |
| 15 | Platform alerts (second channel) | Integration help requests | WeCom webhook | Tacet staff | `lib/platform-alert.js:34`, called from `routes/integrations-admin.js` (2) |
| 16 | Billing reminders | 14 / 7 / 3 / 1 days before renewal, then the dunning ladder | In-app invoice ledger only | The merchant | `lib/billing-lifecycle.js` |
| 17 | New sign-up lead | Someone joins the waitlist | Web push | Kitchen admins | `routes/backend-signup.js:116` |
| 18 | Feedback thread events | Customer feedback raised, replied, closed | Web push | Kitchen admins / the reporter | `routes/feedback.js:132`, `:264`, `:393`, `:402` |
| 19 | Release announcement | The server boots with a new release number | Web push | Whoever the release script targets | `releases.js`, called at `server.js:990` |
| 20 | In-app platform notices and the impersonation banner | Tacet staff broadcast, or a staffer signed in as the merchant | Banner in the admin | The merchant | `routes/backend-notices.js` |

Inside the admin itself, without leaving the page: a new-order **chime**, **unseen dots**
on Orders, Invoices, Reviews and Feedback (`04-orders.js:1526`, `:1581`, `:1607-1608`),
a **new-version banner** driven by polling `/api/version` (`server.js:910`), a
**live activity stream** over `EventSource('/api/retail-admin/stream')`
(`01-core.js:1891`), and 745 toast messages.

### 10.2 What the merchant can control

| Setting | Stored as | Controls | Where |
|---|---|---|---|
| New-order sound | `localStorage['tacet-orders-sound-on']` | the chime, on this browser only | `backend-account.html:456` |
| Push notifications on this device | a row in `tenant_operator_push_subs` | whether this device is subscribed at all | `backend-account.html`, `routes/backend-auth.js:1126-1156` |
| Push mute preference | `push_optouts` | the one mute honoured inside `_sendMany` | `routes/push.js` |
| Feature switches (10) | `storefront_config` `features.<key>` | whether a whole section exists | `lib/features.js:15-62` |

There is **no per-notification preference** — no way to say "text me about refunds but
not about deliveries" — and no notification history or inbox for the operator to look
back at.

### 10.3 Which alerts the merchant never sees

Items 14 and 15 above — alert messages covering crashes, failed routes, stalled channel
queues, geocoder outages and proxy failures — go to a single WeCom group chat. That
destination is set in the admin, under Settings → Push notifications → "System Alerts",
and stored as `system_alerts.enabled` + `system_alerts.wecom_webhook`
(`lib/ops-alert.js:1-14`).

**It is read from one fixed file on disk.** `lib/ops-alert.js:29` opens
`data/roots.db` by path and reads `storefront_config` from it (`:64`) — the main
database, which belongs to merchant number 1. A second merchant's own System Alerts
setting lives in their own database file and is never consulted, so every one of these
alerts lands in the first merchant's chat group or nowhere. The alert timestamp is
likewise fixed: `shTime()` at `lib/ops-alert.js:208` adds 8 hours to UTC by hand.

The merchant's own channel is item 13, which fires for two integration-health events and
only if that merchant has configured a WeCom app of their own (`lib/tenant-notify.js:31`
returns `wecom_app_not_configured` otherwise).

Callers of `sendOpsAlert`, counted: `routes/retail.js` 5, `server.js` 3, the two channel
drift sweeps 4, `lib/alert-latch.js` 1, plus the background daemons
(`scripts/meituan-daemon.js` 15, `scripts/eleme-daemon.js` 6,
`scripts/guanyi-daemon.js` 6, `scripts/health-watchdog.js` 4).

---

## 11. Every place a first-merchant assumption is written into the code

Scanned: `server.js`, `database.js`, `schema.sql`, all of `routes/`, all of `lib/`,
`middleware/`, the 23 admin JavaScript files, the admin shell markup, Tacet Mobile, the
till, Quick Stock, the two editors, the standalone pages, the service worker and the app
manifests. The kitchen app and the customer mini-app are out of scope.

### 11.1 Totals by kind

Raw occurrence counts. Some are inert (a comment, a variable name); the point of the
count is where the concentration is. The right-hand column is what a merchant unlike
Roots would meet.

| Kind | Hits | Files | Heaviest files | What a different merchant gets |
|---|---|---|---|---|
| Food-business vocabulary (kitchen, ingredient, 食材, recipe, serving, batch, cold chain) | 6,097 | 120 | `routes/retail.js` 470, `routes/recipes.js` 465, `19-recipes.js` 443, `routes/ai.js` 439 | A hardware shop is asked about servings and ingredients |
| Chinese payment / invoicing (WeChat Pay, Alipay, fapiao, 发票, Nuonuo) | 1,080 | 53 | `routes/retail.js` 404, `16-purchasing.js` 91, `m.html` 89, `02-settings-ops.js` 53 | A shop outside China has no payment method it can switch on |
| Chinese couriers (JD, 快递100, Qingyun, SF) | 1,001 | 33 | `routes/retail.js` 522, `04-orders.js` 89, `lib/tracking.js` 84, `lib/jd.js` 42 | No carrier a merchant elsewhere uses |
| Currency `¥` / `￥` / CNY / RMB | 844 | 61 | `routes/retail.js` 113, `04-orders.js` 112, `retail-admin.html` 79, `cms.html` 79 | Prices shown in yuan whatever currency they sell in |
| Guangzhou / GZ | 702 | 48 | `routes/retail.js` 282, `retail-admin.html` 75, `database.js` 58, `04-orders.js` 56 | Same-city logic anchored to one city |
| Channel names as literals (`'wechat'`, `'meituan'`, `'eleme'`, `'gzgrocery'`, `'dinein'`, …) | 581 | 61 | `routes/retail.js` 179, `m.html` 58, `16-purchasing.js` 44 | A fixed channel list they cannot change |
| Roots by name | 519 | 91 | `routes/retail.js` 77, `database.js` 66, `retail-admin.html` 21, `cms.html` 21 | see §11.2 |
| Guangzhou district names (天河, 越秀, 番禺, 花都, 南沙, 从化, 增城, …) | 253 | 30 | `routes/retail.js` 77, `database.js` 37, `11-meituan.js` 32, `lib/inventory.js` 26 | Delivery areas listed as Guangzhou districts |
| Units (`'kg'`, `'g'`, `'ml'`, 克, 千克) | 118 | 21 | `19-recipes.js` 21, `21-product-build.js` 14, `lib/ingredient-cost.js` 12 | Metric weight assumed |
| Time zone (`Asia/Shanghai`, `UTC+8`, `'+8 hours'`) | 102 | 31 | `routes/retail.js` 44, `17-setup-guide.js` 8, `04-orders.js` 6 | Their day starts and ends on Guangzhou's clock |
| Store names / ids (`tianhe`, `yuexiu`, warehouse-store ids) | 100 | 24 | `database.js` 13, `routes/retail.js` 12, `lib/tenant-creds.js` 12 | Two named shops that are not theirs |
| Branches on merchant number 1 | 77 | 12 | `routes/retail.js` 29, `retail-purchasing.js` 21, `lib/tenant-db.js` 7 | Behaviour that differs for them and only them |
| `fc-` prefixed keys and message names (a retired platform name) | 67 | 11 | `retail-admin.html` 45, `backend-account.html` 5 | invisible, but the name survives |
| Guangdong / Hong Kong / Shenzhen | 72 | 14 | `routes/retail.js` 43 | Shipping zones built around one province |
| Loyalty tier names (`seed`, `sprout`, `root`, `tree`) | 58 | 9 | `routes/retail.js` 19, `m.html` 11, `08-customers.js` 9 | Tier names from a plant-themed brand |
| Default language `'zh'` / `'en'` / `'zh-CN'` | 56 | 20 | `m.html` 13, `03-dashboard.js` 7 | Two languages, chosen for them |
| Chinese mobile format (`+86`, `^1\d{10}`) | 39 | 8 | `lib/phone-cn.js` 14, `04-orders.js` 7 | Phone validation their customers fail |
| Warehouse / out-of-city store ids | 26 | 4 | `routes/retail.js` 13, `database.js` 9 | Routing rules built for two shops and a warehouse |
| `rootskitchenchina.com` | 27 | 11 | `server.js` 9, `routes/retail.js` 5, `store-admin.js` 4 | Every link back into the admin points at the first merchant's domain |
| Legacy tenant name (Latin) | 15 | 8 | `retail-admin.html` 4, `backend-auth.js` 3, `provision-tenant.js` 2 | A retired brand name still in the product |
| Legacy tenant name (Chinese) | 9 | 4 | `retail-admin.html` 5, `qingyun-browser.js` 2 | Same |
| Google Fonts links | 40 | 13 | `retail-admin.html` 4, `m.html` 3, `till.html` 3 | Fonts fetched from a host that is blocked in mainland China |
| Production server IP address | 2 | 2 | `routes/ai.js`, `public/sw.js` | — |
| A WeChat app id literal | 1 | 1 | `15-integrations.js` | — |

**Total: 11,971 occurrences.**

### 11.2 Named in the merchant-facing interface

Some of the above are only in comments or file paths. These are in text a merchant reads
or in logic that decides what they see:

| Where | What | Evidence |
|---|---|---|
| Settings → Features | The description of the Membership feature reads "Roots Club tiers and the points the mini-app shows shoppers." | `lib/features.js:16-18` |
| Every screen showing money in 19 of 23 admin files | `¥` written into the string | §8.3 |
| Delivery | Guangzhou district pickers and same-city rules | `06-delivery.js`, `routes/retail.js`, `lib/china_districts.json` |
| Orders | Air / land shipment split, JD waybills, Qingyun rider tracking, fapiao block | `04-orders.js` |
| Customers | Tier names seed / sprout / root / tree | `routes/retail.js`, `08-customers.js` |
| The setup checklist | Default accent colour `forest-kale`; the step is ticked when the merchant moves *away* from it | `routes/retail-setup.js:127` |
| Sign-in, and every "back to the backend" link | `store.rootskitchenchina.com` | `server.js:558`, `:714` |
| A public marketing page still served, whose path, filename and copy carry a retired platform name | The retired name | `server.js:830` |

### 11.3 Logic that branches on the first merchant specifically

77 sites. The load-bearing ones:

| Branch | Where | Effect |
|---|---|---|
| `getTenantDb(1) === mainDb` | `lib/tenant-db.js:192` | merchant 1 uses the shared database; everyone else gets a file |
| Kitchen sign-in pins the request to merchant 1 | `routes/retail.js:193`, `:198` | a kitchen user acting in the admin always acts on Roots |
| `COALESCE(tenant_id, 1)` in purchasing SQL | `routes/retail-purchasing.js` (21 sites) | a row with no merchant recorded is treated as Roots' |
| `.env` credentials for merchant 1, encrypted store for everyone else | `lib/tenant-creds.js` | Roots' integrations work without setup; nobody else's do |
| `is_internal` carve-out | `lib/billing-lifecycle.js` | Roots is never chased for payment |
| Ops alerts read `data/roots.db` directly | `lib/ops-alert.js:29`, `:64` | §10.3 |

### 11.4 What a brand-new merchant is actually given

`lib/provision-tenant.js` creates the account, one owner login, a 14-day trial, an empty
database, and **43 configuration rows** (`buildDefaultConfig`, `:187-260`):

| Setting | Seeded value | Note |
|---|---|---|
| `theme.accent` | `forest-kale` | a green |
| `theme.language` | `bilingual` | English + Chinese, decided for them |
| `fees.freeShippingThreshold` | 399 | no currency attached |
| `fees.standardShipping` | 12 | |
| `fees.sameDayDelivery` | 18 | |
| `points.earnSpend` / `earnRate` | 100 | 1 point per 100 spent |
| `points.redeemRate` | 1 | the comment reads "1 point = ¥1" |
| `points.expiryMonths` | 12 | |
| `tabBar.items` | Home / Shop / Cart / Me, each with a Chinese half | the shop's own navigation, pre-written in two languages |
| `delivery.holidayMessage` | a sentence in English and Chinese | |
| `shop.showDietary` | `false` | explicitly noted as "not every tenant is a food business" |
| Home page layout | 5 generic blocks, bilingual kickers ("WELCOME · 欢迎光临", "JUST IN · 新品") | `buildStarterHomeLayout()` |

**Not seeded, and with no setting to hold them:** currency, time zone, country, units of
measure, tax treatment, the list of sales channels, business hours. Currency falls back
to `CNY`/`¥` (`routes/retail.js:336-343`); the business day falls back to UTC+8
(`lib/business-date.js:44`, and 25 hand-written `'+8 hours'` strings in
`routes/retail.js`). A storefront web address is only issued if the platform has
`STOREFRONT_BASE_DOMAIN` set, otherwise the merchant's shop has no address at all
(`lib/provision-tenant.js:22`).

The one properly per-merchant piece of this is `lib/business-date.js` — it reads the
location's own time zone and falls back to `Asia/Shanghai` only when none is set. **One
file uses it**: `routes/retail-waste.js`.

---

## 12. What a merchant actually does here, and how many clicks it takes

Counted from a signed-in desktop admin sitting on whatever screen it opens on. A "click"
is one deliberate action — a click, or a keyboard shortcut. Typing is not counted;
neither is scrolling. Where a step depends on data (how many orders are on screen), it is
noted.

### 12.1 Every day

| Task | Path | Clicks | Notes |
|---|---|---|---|
| See what came in overnight | Dashboard is the landing screen | **0** | The rail's Dashboard row carries `class="active"` (`retail-admin.html:1249`) |
| Open one order | Orders → click the row | **2** | `04-orders.js:1301` — the whole row is clickable and focusable |
| Move an order to Preparing | Orders → row → Start preparing | **3** | no confirmation |
| Mark an order dispatched | Orders → row → Mark dispatched | **3** | plus 1 if it is earlier than the customer asked (`:6386`) |
| Mark an order delivered | Orders → row → Mark delivered | **3** | |
| Refund an order in full | Orders → row → Refund → choose full → confirm | **5** | `openDirectRefundDialog`, `:6402` |
| Refund part of an order | Orders → row → Refund → choose partial → pick lines/amount → confirm | **6+** | grows with the number of lines |
| Find an order by phone number | `Ctrl/⌘+K` → type → click the result | **2** | the palette searches orders, products and customers live (`02-settings-ops.js:1334-1341`) |
| Find an order by phone, the other way | Orders → search box → click the row | **3** | `#orders-q` searches order number, name and phone (`retail-admin.html:2327`; server side `routes/retail.js:23903`) |
| Print an order | Orders → row → print | **3** | automatic if auto-print is on (`routes/retail.js:26624`) |
| Add a note to an order | Orders → row → note field → save | **3–4** | |
| Take a phone order | Orders → New order → find customer → add each product → fees → confirm | **7+** | `tab-orders-new`, `#onw-cust-q`, `#onw-prod-q` |
| Check today's takings | Dashboard | **0** | the money cards are on the landing screen |
| Reply to a review | Inbox menu → Reviews → thread → reply → send | **5** | Reviews is not in the rail (`retail-admin.html:1131`) |
| Reply to customer feedback | Inbox menu → Feedback → thread → reply → send | **5** | |

### 12.2 Every few days

| Task | Path | Clicks | Notes |
|---|---|---|---|
| Adjust stock on one product | Products → row → stock field → save | **4** | `PATCH /api/retail-admin/stores/:storeId/stock/:productId` |
| Change one price | Products → row → price field → save | **4** | |
| Take a product off sale | Products → row → status → save | **4** | |
| Add a product | Products → Add → pick a door → 5 wizard steps → Publish | **8** | §5.3 |
| Record waste | Waste → Record waste → pick item → quantity → reason → Record | **6** | `20-waste.js:217`, `:437` |
| Receive a delivery | Purchasing → the order → Receive → count each line → Confirm delivery | **4 + one per line** | `16-purchasing.js:1595` |
| Raise a purchase order | Purchasing → New → supplier → add each line → send | **5+** | |
| Look at a customer | Customers → search → row | **3** | `#cu-q` searches name and phone (`retail-admin.html:4025`) |
| Give a customer a coupon | Marketing folder → Coupons → the coupon → Give to a customer → search → pick → confirm | **7** | `#grant-search`, `05-marketing.js:399` |
| Create a coupon | Marketing folder → Coupons → New coupon → 5 wizard steps | **8** | wizard at `05-marketing.js:586` |

### 12.3 Weekly / monthly

| Task | Path | Clicks | Notes |
|---|---|---|---|
| Read the period report | Reports → pick a range → pick a chapter | **3** | |
| Export the stock ledger | Products → Stock activity → Export | **3** | a direct file download (`13-activity.js:262`) |
| Export the catalogue | Products → Export | **2** | `09-products.js:1834` |
| Enter a money-in or money-out row | Finance → New → type → category → amount → save | **6** | `22-finance.js` |
| Send a broadcast | Marketing folder → Broadcasts → compose → send | **5** | no undo |
| Add a member of staff | Manage team → Add member → fill → save | **4** | |
| Change delivery fees | Delivery → the zone → fee fields → save | **4** | Delivery holds 79 markup actions — the densest screen in the admin |
| Change shop settings | Settings → the panel → the field → save | **4** | |
| Pay the Tacet bill | Account menu → Billing → the invoice → Pay | **4** | `/backend/billing` |

### 12.4 Where the same task has two different paths

- **Stock** can be changed from Products, from the Stock activity sub-view, from Quick
  Stock on a phone, and from Tacet Mobile — four screens over one number.
- **Orders** are worked from the Orders tab, from the Dashboard's "needs you" rows, from
  the customer record, from the command palette, and from Tacet Mobile.
- **Products** are edited in the Products drawer, in the full-page product editor, and in
  the mini-app editor's product view — three editors over one record.

---

### 12.5 Signing in

| Step | What happens | Where | What the merchant is told |
|---|---|---|---|
| Page loads | `/backend/login` asks `GET /api/backend/me`; if already signed in it goes straight to the admin | `backend-login.html:349-352` | — |
| Missing fields | checked in the page | `:371-374` | "Enter your username and password. · 请输入用户名和密码。" |
| Sign in | `POST /api/backend/login`, rate-limited to 10 tries per 15 minutes | `routes/backend-auth.js:440-506` | "Incorrect username or password · 用户名或密码错误" (`:453`); "Too many attempts, try again in 15 minutes" (`:445`) |
| A deactivated member of staff | filtered out by `is_active = 1` | `:451` | the same "Incorrect username or password" — indistinguishable from a typo |
| A suspended account | `tenant.status !== 'active'` | `:456-458` | "This account is not active · 此账户未激活" — with no mention of billing |
| Two-factor | offered when a verified email or phone exists; if neither can be delivered to, it falls back to password only | `:468-490` | a channel picker with masked hints |
| Code entry | code lives 10 minutes, 5 attempts | `:543-576` | "Incorrect code", "Code expired — please sign in again", "Too many tries — please sign in again" |
| Session | 8 hours, or 30 days with "remember"; impersonation sessions last 2 hours | `server.js:155`, `:603` | nothing — there is no warning before it ends |
| Session ends mid-task | every page gets `{user:null}` and redirects | `backend-account.html:533`, `backend-billing.html:322` | the sign-in page, with no note of what was lost |
| Forgot password | always answers "sent", so a wrong username reveals nothing; needs a **verified recovery email** and email to be configured on the platform | `routes/backend-auth.js:1256-1288` | "Password updated. You can sign in with it now." |
| Suspended after sign-in | the admin redirects to billing | `server.js:642-648` | "This account is suspended for non-payment. Settle the outstanding invoice to restore access." |

There is no "your workspace is being set up" state in the account record: `tenants.status`
is only active, suspended or cancelled (`routes/backend-auth.js:37`). The holding page a
non-Roots merchant currently meets comes from the isolation flag in `server.js:289-298`,
not from their account.

### 12.6 The first ten minutes for a brand-new merchant

| Step | What happens | Where |
|---|---|---|
| The door | `/backend/signup` asks the server whether sign-up is open. Unless a platform staffer is signed in or `BACKEND_SIGNUP_OPEN=1`, the visitor gets a **waitlist form**, not an account | `routes/backend-signup.js:19-65` |
| Waitlist | company, contact name, contact, note → a lead row, and a push notification to Tacet's own staff | `:90-127` |
| Real sign-up | needs company, a username (globally unique across all merchants), and a password of 10+ characters. Brand name and owner name are optional | `lib/provision-tenant.js:205-219` |
| What is created | the account (active), one owner login, a 14-day trial with no plan chosen, four roles — Owner, Manager, Shop floor, Stockroom — an empty database, and 43 settings rows (§11.4) | `:225-248`, `:78-203` |
| Web address | a subdomain is issued **only if the platform has a base domain configured**; otherwise the merchant's shop has no address | `:46-56`, `:265-272` |
| What they are told | "Backend created. Sign in with 'user'." then a redirect to sign-in after 1.8 seconds. **No welcome email, no verification, no password-reset link** | `public/backend-signup.html:162-165` |
| First sign-in | the shell detects a first login and opens the setup guide with a welcome: "Welcome — let's open your store", "Five short steps…" | `17-setup-guide.js:995-1006`, `:911-932` |
| The checklist | five required steps, each detected from the data rather than ticked by hand: **a store** (an active location with an address) · **products** (at least one active) · **payment** (WeChat Pay credentials, or manual Alipay switched on) · **fulfilment** (delivery switched on, or pickup confirmed) · **open the doors**. Two optional: WeChat sign-in credentials, and brand | `routes/retail-setup.js:86-130` |
| Estimated times shown | 2, 5, 3, 2 and 1 minutes | `17-setup-guide.js:23-59` |
| Finishing | "Open the doors" → "Open your store now?" → "Your store is open" | `:860-908` |

**What the checklist never asks for:** currency, time zone, country, units, tax
treatment, business hours, an email address or phone number for the owner (the recovery
email has to be added later, inside the profile pop-up), staff, printers or receipts, SKU
rules, or which sales channels they use. A separate, richer onboarding plan exists —
legal, bank, brand, mini-app, pay, config, go-live (`lib/onboarding-steps.js:22-82`) —
but it is tracked by Tacet's own staff and is **never shown to the merchant**.


---

## 13. Coverage gaps and things I could not settle from the code

1. **Per-section surface and action tables.** Sections 4 and 5 give the structural map
   and the highest-traffic screens in detail. The remaining screen-by-screen
   enumeration — every drawer, every empty state, every button label, for all 41
   sections — is the one part of this inventory still being written out; the counts
   above are complete, the per-screen prose is not.
2. **Empty and error states.** These are almost all built in JavaScript at render time,
   so they cannot be read off the markup; each has to be traced through its render
   function. Done for Products on mobile (`m.html`: "No products match" with a
   "Clear the filters" button, `SUBS.products`), not yet for the desktop sections.
3. **Anything only visible at runtime.** Nothing was executed for this audit: no server
   was started, no page was loaded, no database was read. Statements about what appears
   on screen are read from the code that draws it.
4. **The three excluded areas.** Permission enforcement, the channel sync redesign, and
   finance categories are described where they explain behaviour but not surveyed.
5. **Two surfaces I could not place.** `public/brand-studio.html` has no route and no
   link (§2); `public/app.html.bak` is a 1.4 MB copy of the kitchen app served at
   `/assets/app.html.bak`. Neither seems intended to be part of the admin.
6. **Template-built SQL.** 227 database statements are assembled from template strings,
   so their tables could not be read mechanically; they are excluded from the §7 counts
   rather than guessed at.
7. **Mobile ergonomics.** Touch-target sizes, overflow and one-handed reach at phone
   width need measuring against the CSS rather than reading; §3.4 lists the screens, the
   measurements are still open.

---

# Part 2 — Findings

Every finding below cites the code that proves it. Where something looks wrong but the
code cannot settle it, it is marked **Suspected** and says what would confirm it.

**Severity.** *Critical* — data loss, money wrong, one merchant's data reachable by
another, or a daily task blocked. *High* — a daily task degraded or wrong for many
merchants. *Medium* — wrong or confusing, with a way around it. *Low* — worth fixing,
nobody is stuck.

**A note on the isolation switch.** Per-merchant data separation is currently switched
off (`TENANT_DATA_ISOLATION`, `lib/tenant-db.js:87`) and non-Roots merchants are held out
of the admin entirely (`server.js:289-298`). Several findings below therefore say
"latent": the defect is in the code today and becomes live the moment that switch is
turned on. They are not hypothetical — the switch is the plan.

---

## A. Bugs and errors

### A-01 · The product list stops at 500 and the counter says that is all there is
**Severity:** High
**Where:** `routes/retail.js:22482`; `public/retail-admin/09-products.js:463-467`, `:230-258`

The server never returns more than 500 products, and it takes no page number — the cap is
the whole answer. The Products screen asks for the list with no limit, then pages through
whatever came back, and prints "Showing 1–50 of 500". A merchant with 900 products has
400 that cannot be reached from the Products screen at all, and nothing tells them.

**Who it affects:** any merchant with more than 500 products — a small clothing shop, a
hardware store, a grocer. Roots is under the cap today, so Roots is unaffected.

**Evidence:** `const lim = Math.min(500, … || 500); sql += ' … LIMIT ' + lim;`
(`retail.js:22482-22483`) — no `OFFSET`, no `page`. The client: `fetch('/api/retail-admin/products')`
(`09-products.js:467`) then `PA_PRODUCTS = j.data || []`, and the pager's total is the
length of that array (`_paPagerHtml(total…)`, `:230`).

**Suggested direction:** page the endpoint server-side and have the pager read the real total.

### A-02 · A mistyped stock count silently sets the shelf to zero
**Severity:** High
**Where:** `routes/retail-inventory.js:372`; `public/retail-admin/09-products.js:585`; `lib/inventory.js:1095`

The stock box on the Products grid saves on blur. Both the browser and the server turn
whatever was typed into a number with `parseInt(value) || 0`, so an empty box, a stray
letter, or a pasted value the parser cannot read all become **0**. Nothing asks "are you
sure", and the cell shows a green tick as though it saved what you meant. `adjustStock`
does not check the figure either.

**Who it affects:** every merchant, every day. Roots is affected now.

**Evidence:** `const qty = Math.max(0, parseInt(raw, 10) || 0)` (`09-products.js:585`);
`const newQty = parseInt(b.physical_qty, 10) || 0` (`retail-inventory.js:372`);
`adjustStock` writes `newPhysicalQty` straight through with no validation
(`lib/inventory.js:1095`, and the absolute path at `:36-45` has no floor or ceiling check).
The movement is recorded in the ledger, so the old figure is recoverable by hand — but
only if somebody notices.

**Suggested direction:** reject a blank or unparseable count instead of reading it as zero, and confirm any recount that drops stock to zero.

### A-03 · The phone app shows invented product counts before the catalogue loads
**Severity:** Medium
**Where:** `public/m.html:5121-5125`

The Products screen on the phone draws its filter chips as "All 118 · Live 96 · Draft 0 ·
Low 14 · Out 8" until the real catalogue arrives — and if the request fails, those numbers
stay. A merchant who has just signed up and has no products is told they have 118.

**Who it affects:** every merchant on the phone in the first seconds after opening
Products, and any merchant whose connection drops. A new merchant sees it as their
opening screen.

**Evidence:** `count: L ? P.length : 118`, `L ? n('on') : 96`, `L ? n('restock') : 14`,
`L ? n('off') : 8` where `L` is `state.liveProductsLoaded`. The same file's `DB` object at
`:459-475` carries a comment saying every sample row was removed for exactly this reason —
these five numbers survived that cleanup.

**Suggested direction:** show the loading state until the catalogue lands, as the rest of the file already does.

### A-04 · Every timestamp in the admin is rendered in Guangzhou time, for everyone
**Severity:** High
**Where:** `public/td-datetime.js:37-40`; searched across `public/`

The shared date formatter reads the shop's time zone from `window.TD_TZ` and falls back to
`Asia/Shanghai` when it is not set. **Nothing anywhere sets it.** Its own comment says a
merchant in another zone "sets TD_TZ" — that wiring was never built, so every order time,
every report boundary and every "today" in the admin is Guangzhou's.

**Who it affects:** every merchant outside UTC+8 — which is every merchant except the
first. Roots is unaffected, and that is why it has not been noticed.

**Evidence:** `function tz() { return root.TD_TZ || 'Asia/Shanghai'; }`
(`td-datetime.js:40`). `grep -rn "TD_TZ" public/` returns three hits, all inside that
one file — the definition and its comment. No page assigns it.

**Suggested direction:** set `TD_TZ` from the merchant's own setting at boot, and give them a setting to hold it.

### A-05 · The business day is hand-written as "+8 hours" in the API, in 25 places
**Severity:** High
**Where:** `routes/retail.js` (25 occurrences), `routes/finance-summary.js:1`, `routes/restock.js:1`, `lib/finance-window.js:1`

There is a correct helper for this — `lib/business-date.js` reads the location's own time
zone and explains at length why hand-rolled offsets are wrong. **One file uses it:**
`routes/retail-waste.js`. Everywhere else the day boundary is the string `'+8 hours'`
pasted into SQL, so today's takings, the dashboard, the finance window and the customer
"new this week" counts all end at midnight in Guangzhou.

**Who it affects:** every merchant outside UTC+8. Roots is unaffected.

**Evidence:** `const TZ = '+8 hours'` at `routes/retail.js:13257`, `:13331`, `:13360`,
`:13378`, `:13531`, `:14214`, `:21871`, and inline `date(o.placed_at, '+8 hours')` at
`:2468`, `:16424`, `:16531`, `:22541` and others. `lib/business-date.js:44` documents the
fallback as a fallback: *"the moment a location carries a zone, that zone wins, including
for a business nowhere near China."*

**Suggested direction:** route every day-boundary calculation through `lib/business-date.js`.

### A-06 · Money is stored as floating point
**Severity:** High
**Where:** `schema.sql` and `database.js` — 51 of 61 money columns

Fifty-one money columns are declared `REAL`. Floating-point numbers cannot hold every
decimal exactly, so sums of many small amounts drift, and two figures that should match
can differ by a fraction of a cent. The code compensates in places with a tolerance of
half a cent, which is a sign of the same problem rather than a fix.

**Who it affects:** every merchant, everywhere money is totalled — which is most of the
product. Roots is affected now.

**Evidence:** the money-column inventory in Part 1 §8.1; `isFull = amount + 0.005 >=
remainingGross` at `routes/retail.js:28894`, whose own comment reads *"tolerance for ¥0.01
rounding"*; the same 0.005 tolerance again at `:3713`, `:10792`, `:28050`, `:28053`,
`:28152`. Recorded as a known defect in `docs/tacet-consolidation-decisions.md` §22 item 5,
folded into a future rebuild.

**Suggested direction:** none needed here — it is already scheduled; this entry exists so the audit's money findings are read against it.

### A-07 · A negative stock count is accepted through the recount door
**Severity:** Medium
**Where:** `routes/retail-inventory.js:372-384`; `lib/inventory.js:1095`

The relative "add stock" path refuses a negative number and says so clearly. The absolute
"set the new total" path next to it accepts any integer, including a negative one, and
writes it. A shelf can be set to −40.

**Who it affects:** every merchant. Whether it has happened to Roots is not knowable from
the code.

**Evidence:** the delta path returns `delta_must_be_positive` with a plain-language
message (`:359-364`); the `physical_qty` branch immediately below does `parseInt(…) || 0`
and calls `adjustStock` with no lower bound (`:372-376`). `adjustStock` removed its floor
deliberately (`lib/inventory.js:11-14`) on the grounds that silently clamping hid real
losses — which is right for the delta path and leaves this one unguarded.

**Suggested direction:** refuse a negative absolute count at the same place the delta path refuses a negative delta.

### A-08 · Two screens report the same money to different precision
**Severity:** Medium
**Where:** `public/retail-admin/03-dashboard.js:21`; `public/retail-admin/04-orders.js:1061`, `:7782`; `public/retail-admin/01-core.js:176`

The same amount is formatted three different ways inside the Orders screen alone: through
the merchant's currency setting with two decimals, as a hardcoded yuan sign with the
number rounded to whole units, and as a hardcoded yuan sign with two decimals. The
dashboard's default is zero decimals. So a day's takings can read ¥1,235 on one card and
¥1,234.60 on another, and both are "right".

**Who it affects:** every merchant. Roots is affected now.

**Evidence:** `acMoney()` (`01-core.js:176-183`) uses the merchant's decimals;
`dashMoney(n, dp)` defaults to `dp || 0` (`03-dashboard.js:21`); Orders KPI tiles use
`'¥' + Math.round(n).toLocaleString()` (`04-orders.js:1061`, `:1064`, `:1124`); the refund
dialog uses `'¥' + fmt(amt)`, which is `toFixed(2)` (`:7782`, `01-core.js:141`).

**Suggested direction:** one money function, taking the merchant's currency and decimals, used everywhere.

### A-09 · 195 error messages show the merchant the server's own words
**Severity:** Medium
**Where:** across `public/retail-admin/*.js` — 195 `toast(… e.message …)` sites

When a save fails, most screens put the raw error text in front of the merchant. That text
is written for a developer: `HTTP 500 · server_error`, `product_not_found`,
`forbidden_capability`, or a SQLite message. The Products stock cell goes further and
builds the toast as `HTTP ${res.status} · ${detail}` on purpose.

**Who it affects:** every merchant, every time something goes wrong. Roots is affected now.

**Evidence:** 195 occurrences of `e.message` inside a `toast(...)` call across the 23 admin
files; `throw new Error(\`HTTP ${res.status} · ${detail}\`)` at `09-products.js:602`; the
raw codes returned by the API include `server_error` (`server.js:981`), `kitchen_add_only`
(`server.js:351`), `not_eligible`, `already_shipped`, `store_not_found`,
`product_not_found`, `forbidden_capability`, `forbidden_store`.

**Suggested direction:** map failures to a sentence the merchant can act on, and keep the technical text in the console.

---

## B. Dead ends

### B-01 · A new merchant's Products screen says their filter matched nothing
**Severity:** High
**Where:** `public/retail-admin.html:4388`; `public/retail-admin/09-products.js` (`paRender`, +66 lines)

Products has exactly one empty state — "No products match this filter" — and it is shown
whenever the count is zero, filtered or not. A merchant who has just signed up opens the
screen that matters most on day one and is told their filter is wrong. There is no "add
your first product" anywhere on it.

**Who it affects:** every new merchant. Roots passed this point years ago.

**Evidence:** the only empty element is
`<div id="pa-empty" …>No products match this filter. · 没有匹配此筛选条件的产品。</div>`
(`retail-admin.html:4388`), toggled by `empty.style.display = total ? 'none' : 'block'`.
Compare Suppliers, which does it properly: "No suppliers yet", an explanation, and two
buttons — "Add your first supplier" and "Import from a spreadsheet"
(`16-purchasing.js:3510-3521`).

**Suggested direction:** split the two states, and give the empty one the first action.

### B-02 · An order cannot be annotated after it arrives
**Severity:** High
**Where:** `public/retail-admin/04-orders.js:9313`, `:9421`; `routes/retail.js:28255`

Orders carry a staff note, and the API accepts one on any order. The only place the admin
lets anyone type it is the **New order** form — an order that came in from the shop, the
website or a marketplace can never be annotated. "Customer called, wants it left with the
neighbour" has nowhere to go.

**Who it affects:** every merchant. Roots is affected now.

**Evidence:** `staff_note` appears twice in the 9,551-line Orders file, both in the
manual-order form (`:9313` writes it, `:9421` restores it from a draft). The order drawer
renders `customer_note` (`:5669`, `:5866`) and never offers a staff note. The server-side
patch handler accepts it: `if (staff_note != null) { sets.push('staff_note = ?') … }`
(`retail.js:28255`).

**Suggested direction:** put the note field in the order drawer, saving through the endpoint that already exists.

### B-03 · Four endpoints for opening and closing the shop, and no screen
**Severity:** Medium
**Where:** `routes/meituan-admin.js:938`, `:968`, `:989`, `:1029`

`GET /store-status`, `POST /store-status/online`, `POST /store-status/master` and
`POST /store-status/store/:code` implement pausing and resuming a shop per channel. No
page, drawer or phone screen calls any of them.

**Who it affects:** every merchant who wants to close for a day. Roots is affected —
closing the shop is done somewhere else, or not at all from here.

**Evidence:** searched every admin surface (desktop JS, shell markup, phone app, till,
Quick Stock, both editors) for any string beginning `/api/retail-admin/store-status` —
no caller. Part 1 §6.3 lists the other 17 routes in the same position.

**Suggested direction:** decide whether the shop-closing feature ships or the endpoints go; leaving both is the worst of the three.

### B-04 · A whole brand-design screen is deployed with no way in
**Severity:** Low
**Where:** `public/brand-studio.html`; `routes/retail.js:20474-20739`

There is a finished AI brand studio — a brief form, a progress state, a preview and an
apply step — backed by five working endpoints. Nothing links to it. It is reachable only
by typing `/assets/brand-studio.html`, because the static file server exposes the whole
`public/` folder.

**Who it affects:** nobody today, which is the point — the work is paid for and unused.

**Evidence:** the file's own fetches to `/api/retail-admin/brand/generate`, `/job/:id`,
`/apply` (`brand-studio.html:157`, `:171`, `:206`); `server.js` has no `/brand-studio`
route; the only other mention of the filename in the repository is a deployment checksum
list (`scripts/diagnose_deployed_tree.js:446`).

**Suggested direction:** link it from Set up → Brand, or remove it.

### B-05 · Escape throws away a half-finished product with no warning
**Severity:** Medium
**Where:** `public/retail-admin/09-products.js:5883-5895`

The Add-a-product wizard is five steps long. Pressing Escape at any point closes it and
discards everything typed. There is no confirmation and no draft — unlike orders, which
keep half-written ones.

**Who it affects:** every merchant adding products. Roots is affected now.

**Evidence:** `pwClose()` clears `_pw = null` with no save (`:5883-5888`); the key handler
calls it directly on Escape (`:5891-5895`). The comment above it notes that a backdrop
click deliberately does *not* close "so an in-progress product is never discarded by a
stray click" — the same reasoning was not applied to the key.

**Suggested direction:** ask before discarding, or keep a draft the way the order form does.

### B-06 · Only two screens can clear their own filters
**Severity:** Medium
**Where:** `public/retail-admin/08-customers.js:718`; `public/retail-admin/20-waste.js`; the rest of the admin

Customers and Waste give the merchant a "Clear filters" button in their empty state. Orders
— which has thirteen status chips, a store dropdown, a channel dropdown and a search box —
has no way to reset them in one action, and neither does Products. A merchant who has
narrowed to nothing has to remember what they set.

**Who it affects:** every merchant. Roots is affected now.

**Evidence:** `cuFilterClearAll()` exists and is offered on the Customers empty state
(`08-customers.js:718`); Waste has five references to the same idea. Searching all 23
admin files for "Clear filters"-style handlers returns hits in only those two, plus the
phone app and the Meituan screen.

**Suggested direction:** one "clear" control wherever more than one filter can be set.

---

## C. Common-sense failures

### C-01 · The Team screen asks the owner to type a number into a browser pop-up
**Severity:** High
**Where:** `public/retail-admin/02-settings-ops.js:3121`, `:3142`, `:3161`, `:3166`, `:3288`, `:2172`, `:3057`

Deleting a staff role that people hold opens the browser's own grey `prompt()` box
containing a numbered list, and asks the merchant to "Type a number:". Creating a role is
another `prompt()`. Signing a device out is a native `confirm()`. Everywhere else in the
admin these are designed dialogs with real buttons.

**Who it affects:** every merchant who manages staff. Roots is affected now.

**Evidence:** `window.prompt(who + '. ' + cuT('Where do they go? Type a number:', …) +
'\n\n' + menu + exc, '')` (`:3161-3162`), then `const dest = others[parseInt(pick, 10) - 1]`.
`window.prompt(cuT('Name the new role', …))` (`:3121`). Native `window.confirm` at `:2172`,
`:3057`, `:3142`, `:3166`, `:3288`. Compare `askConfirm({title, body, confirmLabel, danger})`
used by Orders and Products (`09-products.js:3193`, `04-orders.js:6389`).

**Suggested direction:** replace the four native dialogs on this screen with the existing designed ones and a role picker.

### C-02 · Four date formats across the admin, and one shared formatter most screens ignore
**Severity:** Medium
**Where:** `public/td-datetime.js`; `02-settings-ops.js:3218`; `05-marketing.js:2149`; `09-products.js:3155`; `public/m.html:9450`

There is a shared formatter, `tdWhen()`, and seven files use it. Team rolls its own with
`toLocaleDateString('en-US')`; Marketing rolls its own with a hand-written month table;
the product version list builds "Jan 5, 14:30" by hand from UTC arithmetic; the phone app
has a third family. So the same order can be shown as "2026-09-04 14:30", "Sep 4, 14:30"
and "4 Sep" depending on which screen you are on.

**Who it affects:** every merchant. Roots is affected now.

**Evidence:** `tdWhen` is called in `01-core`, `03-dashboard`, `04-orders`,
`07-content-billing`, `08-customers`, `10-extras`, `20-waste` and the shell markup —
and nowhere else. `tmdDateFmt` (`02-settings-ops.js:3218`) uses `'en-US'`/`'zh-CN'`
directly; `bxFmtDate` (`05-marketing.js:2149`) uses its own `BX_MON_ABBR` array;
`pdFmtVersionTime` (`09-products.js:3150-3158`) does `gz.getUTCMonth()` arithmetic.

**Suggested direction:** one formatter, called from every screen.

### C-03 · The materials list explains itself; the products list does not
**Severity:** Low
**Where:** `public/retail-admin/18-materials.js:282-292`; `16-purchasing.js:3510-3521`; `retail-admin.html:4388`

Three list screens meet an empty catalogue in three different ways. Suppliers gets a title,
a sentence of explanation and two buttons. Materials gets a title, a good plain-language
explanation of what a material is, and no button. Products gets a filter error.

**Who it affects:** every new merchant. Roots is past it.

**Evidence:** the three blocks above, side by side.

**Suggested direction:** hold all three to the Suppliers pattern.

### C-04 · A daemon is mentioned to the merchant by name
**Severity:** Low
**Where:** `public/retail-admin/04-orders.js:4116`, `:4444`, `:4655`

Three confirmation messages on the Orders screen tell the merchant "the daemon will push
it within a minute".
A daemon is a background program; the word means nothing to a shop owner, and the sentence
is otherwise a good one.

**Who it affects:** every merchant using a marketplace channel.

**Evidence:** `cuT('Queued — the daemon will push it within a minute', '已排队 — 约一分钟内发单')`
(`:4655`), `'Point confirmed — the daemon will push it within a minute'` (`:4444`), and
`` cuT(`Picked ${j.name || label} — the daemon will push it within a minute`, …) `` (`:4116`).
The Chinese half of each pair says only "about a minute to dispatch" — it does not mention
a daemon, so the two languages are not saying the same thing either.

**Suggested direction:** say "we'll send it to <channel> within a minute".

### C-05 · Confirmation is asked for consistently — this is a strength, with one gap
**Severity:** Low
**Where:** 31 of 32 destructive calls across the admin

Checked every request the admin makes with the DELETE method: 31 of 32 ask first, most
through the designed dialog, several with a type-the-name gate. The exception is deleting
an unfinished order draft, which happens immediately — defensible, since a draft is
scratch work.

**Who it affects:** nobody adversely. Recorded because the audit checked it.

**Evidence:** `04-orders.js:9172`, `:9494` are the two unconfirmed deletes, both
`/api/retail-admin/order-drafts/`. The other 30 sites all have `askConfirm`, `askReason`
or `matchWord` in scope.

**Suggested direction:** none.

---

## D. Multi-tenant leaks and isolation

### D-01 · Purchasing, Recipes and Materials write to the first merchant's database
**Severity:** Critical (latent — see the note at the top of Part 2)
**Where:** `routes/retail-purchasing.js` (81 statements), `routes/retail-recipes.js` (26), `routes/retail-materials.js:474`

Three of the admin's screens run their database work on the shared connection instead of
the signed-in merchant's. 102 of those statements carry no merchant filter at all, and
**36 of them are writes**. Once per-merchant separation is switched on, a second merchant
creating a purchase order, editing a recipe or archiving a material writes it into the
first merchant's data — and their supplier list, purchase orders and recipes are read from
there too.

**Who it affects:** every merchant except the first, the moment the switch is flipped.
Roots is not affected today, because it *is* the shared database and no other merchant can
reach the admin.

**Evidence:** the corrected count and per-file breakdown in Part 1 §7.2-7.3. Two of the
three files describe the hazard in their own header comments and then do it anyway:
`retail-recipes.js:31-36` — *"under data isolation they live in the tenant's own DB and
the global handle is Roots'"*; `retail-materials.js:25-33` — the same note, followed by a
cost path that correctly uses `tdb()` (`:363`, `:370`, `:381`, `:403`) and an archive route
that does not (`:471-476`). Representative writes: `INSERT INTO recipes …`
(`retail-recipes.js:376`), `UPDATE ingredients SET is_active = ?` (`retail-materials.js:474`),
`INSERT INTO purchase_orders …` (`retail-purchasing.js:2138`).

**Suggested direction:** bind these three files to `tdb()` the way `routes/retail.js` already is.

### D-02 · System alerts are read from one merchant's database, by file path
**Severity:** Critical (latent)
**Where:** `lib/ops-alert.js:29`, `:64`, `:200`

Where the platform's alerts go — crashes, failed routes, stalled channel queues, geocoder
outages — is a setting the merchant enters in their own admin, under Settings → Push
notifications. The code that reads it opens `data/roots.db` by name and reads that
merchant's settings row. A second merchant's setting is never consulted, so their alerts
either go to the first merchant's staff chat or nowhere.

**Who it affects:** every merchant except the first. It also means one merchant's operational
alerts can land in another merchant's chat group.

**Evidence:** `const DB_FILE = path.join(__dirname, '..', 'data', 'roots.db')`
(`:29`); `_ro.prepare('SELECT value_json FROM storefront_config WHERE key = ?')` (`:64`);
the module header names the setting as `system_alerts.enabled` +
`system_alerts.wecom_webhook` in `storefront_config`, which is a per-merchant table
(`:7-8`). The alert's own timestamp is fixed too: `Date.now() + 8 * 3600 * 1000` (`:208`).

**Suggested direction:** resolve the webhook per merchant, the way credentials already are.

### D-03 · The merchant's currency setting exists and 15 of 23 screens ignore it
**Severity:** High
**Where:** `public/retail-admin/01-core.js:154-183`; 19 of 23 admin files

Currency is a real per-merchant setting: it is stored, normalised on the server, editable
in Settings, and there is a helper that reads it. Eight admin files call that helper.
Nineteen contain a hardcoded `¥`. A merchant selling in dollars sees dollars on some
screens and yuan on others — including the coupon presets they are offered on day one.

**Who it affects:** every merchant not trading in yuan. Roots is unaffected.

**Evidence:** `normalizeCurrency()` (`routes/retail.js:336-343`), `acCurrency()` /
`acMoney()` (`01-core.js:154-183`), whose own comment says the cost and margin screens
"printed a hardcoded '¥' with a hardcoded 2dp, so a tenant who selected $ or ฿ was told
their costs and margins in yuan". The per-file counts are in Part 1 §8.3: 77 hardcoded
symbols in Orders, 32 in Content, 26 in Loyalty, 22 each in Products and Delivery, 21 in
Marketing, 18 on the Dashboard, 15 in Customers. The coupon wizard's five starting points
are labelled `'¥20 off · 立减'`, `'¥10 off · 立减'`, `'¥0 delivery · 免运'`
(`05-marketing.js:779-782`).

**Suggested direction:** route every amount through `acMoney()`.

### D-04 · The Settings screen tells every merchant about "Roots Club tiers"
**Severity:** Medium
**Where:** `lib/features.js:16-18`

The description under the Membership feature switch — text every merchant reads when
deciding whether to turn loyalty on — names the first merchant's loyalty programme.

**Who it affects:** every merchant. It is the clearest example of the first merchant's name
in shared interface copy.

**Evidence:** `desc_en: 'Roots Club tiers and the points the mini-app shows shoppers.'`

**Suggested direction:** describe the feature, not the first merchant's version of it.

### D-05 · The sales channel list is fixed in the interface
**Severity:** High
**Where:** `public/retail-admin.html:2318-2323`; `routes/retail.js:23911`

The Orders channel filter is a hardcoded list of six options: All, WeChat, Web, Meituan,
gzgrocery, Manual. The counts endpoint behind it initialises the same six keys and drops
anything else. A merchant selling through a channel not on that list cannot filter by it,
and one who has never heard of the Guangzhou grocery partner is offered it by name.

**Who it affects:** every merchant. The platform's own governing rules say the channel list
is per-business and that this partner is specific to one customer.

**Evidence:** the six `data-channel` options in the markup; `const out = { all: 0, wechat:
0, web: 0, meituan: 0, gzgrocery: 0, manual: 0 }; … if (r.ch in out) out[r.ch] += r.n`
(`routes/retail.js:23911-23913`) — a channel not in the object is counted into `all` but
never surfaced. `docs/tacet-consolidation-decisions.md` §0: *"SALES CHANNELS ARE NOT A
FIXED LIST … GZ Grocery in particular is specific to one customer."*

**Suggested direction:** build the filter from the merchant's own configured channels.

### D-06 · Ship-it-on-time reminders are sent to the wrong kind of user entirely
**Severity:** High (latent)
**Where:** `lib/delivery-reminders.js:54-77`; `routes/push.js:202-219`

The three delivery reminders — "deliver soon", "deliver today", "prepare for pickup" — are
sent with `sendPushByPermission('retail', …)`, which looks up users in the **kitchen**
`users` table and their `permissions` row. Merchant staff are not in that table; they are
`tenant_users` with capabilities. So for any merchant other than the first, these
reminders have no possible recipient.

**Who it affects:** every merchant except the first. Roots has kitchen users, so Roots gets
them — which is why it works today.

**Evidence:** `_push.sendPushByPermission('retail', payload)` (`delivery-reminders.js:63`,
`:70`, `:77`); that function's query is `SELECT u.id FROM users u LEFT JOIN permissions p …`
(`push.js:209-214`). The correct sender for merchant staff exists in the same file and is
used elsewhere: `sendPushToOperatorsWithCaps(tenantId, needCaps, …)` (`push.js:333`), whose
own comment says the older sender *"reads `permissions` on the kitchen `users` table — a
different realm entirely"* and that operators *"got nothing, on every event."*

**Suggested direction:** send these three through `sendPushToOperatorsWithCaps` like transfers already do.

### D-07 · Every link back into the admin points at the first merchant's web address
**Severity:** Medium
**Where:** `server.js:558`, `:714-718`; `lib/delivery-reminders.js:60`; `routes/backend-auth.js:1163`

`/retail-admin` redirects to `store.rootskitchenchina.com`, and push notifications carry
`url: '/retail-admin?tab=orders'`. Any merchant on their own address who follows one of
these is sent to the first merchant's host, where their session cookie does not apply.

**Who it affects:** every merchant on their own web address. Roots is unaffected.

**Evidence:** `const STORE_HOST = 'store.rootskitchenchina.com'` (`server.js:558`) and the
redirect at `:714-718`; `payload.url = '/retail-admin?tab=orders'`
(`delivery-reminders.js:60`, `:74`); the push self-test does the same
(`backend-auth.js:1163`).

**Suggested direction:** build these links from the host the request arrived on.

### D-08 · A new merchant is given yuan amounts, two languages and a green
**Severity:** High
**Where:** `lib/provision-tenant.js:78-203`

The 43 settings a new merchant starts with include a free-shipping threshold of 399, a
standard shipping fee of 12, a same-day fee of 18, one point per 100 spent, a redemption
rate whose comment reads "1 point = ¥1", a bilingual English-and-Chinese shop navigation,
a holiday message written in both languages, and a green accent. None of them is presented
as a choice, and **currency, time zone, country, units and tax are not seeded at all** —
they fall back to yuan and Guangzhou time.

**Who it affects:** every merchant who is not a Guangzhou food business.

**Evidence:** `buildDefaultConfig()` at `lib/provision-tenant.js:78-140`; the starter home
layout with `kicker_en: 'WELCOME', kicker_cn: '欢迎光临'` (`:160-200`). Currency falls back
through `normalizeCurrency()` to `{code:'CNY', symbol:'¥'}` (`routes/retail.js:336-343`);
the business day falls back to `Asia/Shanghai` (`lib/business-date.js:44`).

**Suggested direction:** ask for country, currency, time zone and language at sign-up, and seed from the answers.

### D-09 · The admin loads its fonts from a host that is unreachable where the first merchant trades
**Severity:** Medium
**Where:** 13 files, 40 references — `retail-admin.html`, `m.html`, `till.html`, `16-purchasing.js` and others

The admin pulls typefaces from Google's font service. That service is blocked in mainland
China, which is where the only live merchant operates. The pages still work — the browser
falls back — but the interface a merchant sees is not the one that was designed, and every
page pays a connection timeout.

**Who it affects:** the first merchant most of all; any merchant in a region that blocks
the host. This is the one finding where the platform's assumption hurts Roots rather than
everyone else.

**Evidence:** 40 references to `fonts.googleapis.com` / `fonts.gstatic.com` across 13
files. `docs/tacet-ia-blueprint.md` §11 records the same risk for the Profile page and
calls it unresolved.

**Suggested direction:** serve the typefaces from the application, as the brand fonts already are.

### D-10 · Guangzhou's districts are written into delivery, orders and stock routing
**Severity:** High
**Where:** `routes/retail.js` (77 district references), `lib/inventory.js` (26), `public/retail-admin/11-meituan.js` (32), `database.js` (37)

Same-city delivery, the dispatch-method choice, the shipping zones and the stock routing
are all expressed in terms of named Guangzhou districts and two named shops. A merchant
elsewhere gets delivery rules describing a city they are not in.

**Who it affects:** every merchant outside Guangzhou.

**Evidence:** 253 district-name occurrences across 30 files; the comment at
`routes/retail.js:23920-23926` naming 花都/番禺/南沙/从化/增城 and 白云 as the districts where
staff may choose the dispatch method, and 越秀/天河/海珠/荔湾/黄埔 as rider-only; 100
references to the two shop identifiers; `lib/china_districts.json` as the picker's data.

**Suggested direction:** make delivery areas data the merchant defines, with the current set as one merchant's saved configuration.

---

## E. Missing standard functions

Rated as the brief asks: **table-stakes** (a mature admin has it and a merchant will ask
for it in week one), **expected**, **nice-to-have**.

### E-01 · There is no record of who changed what — although it is being written
**Severity:** High · table-stakes
**Where:** `middleware/auth.js:43-55`; 139 call sites; no reading surface

Every significant write calls `logActivity(...)`, and the rows land in `activity_log`.
**No screen anywhere reads that table.** A merchant who finds a price changed, a product
unpublished or an order refunded cannot find out who did it. The Products screen's "Stock
activity" is a stock-movement ledger, not a change log.

**Who it affects:** every merchant with more than one member of staff. Roots is affected now.

**Evidence:** `logActivity` is called 102 times in `routes/retail.js`, 27 in
`routes/retail-purchasing.js`, 8 in `routes/retail-inventory.js`, 2 in
`routes/retail-waste.js`. Searching every admin surface for `activity_log` or an activity
endpoint returns nothing but the stock ledger (`13-activity.js`, which reads
`retail_stock_ledger`). The data even survives the two-realm problem —
`middleware/auth.js:44-51` deliberately records the operator's name when their id would
break the foreign key.

**Suggested direction:** a Settings → Activity screen reading `activity_log`, filtered by person and date.

### E-02 · Customers cannot be given a note or a tag
**Severity:** High · table-stakes
**Where:** `database.js` (`retail_customers` columns); `public/retail-admin/08-customers.js`

A customer record holds a name, a phone, addresses, orders, points and a wallet. There is
nowhere to write "allergic to nuts", "always calls before collecting", "wholesale — invoice
monthly", and no way to tag a group of customers so they can be found again.

**Who it affects:** every merchant. Roots is affected now.

**Evidence:** the columns added to `retail_customers` are `referral_code`,
`referred_by_customer_id`, `referral_applied_at`, `lifetime_eligible`,
`lifetime_eligible_since`, `affiliate_blocked`, `source`, `created_by`, `seen_at` — no note
and no tag column. The customer drawer (`08-customers.js`) has no note field. Reviews have
tags (`retail_reviews.tags_json`); customers do not.

**Suggested direction:** a free-text note and a tag list on the customer record, both searchable.

### E-03 · Nothing on a list can be acted on in bulk except products and images
**Severity:** High · table-stakes
**Where:** `public/retail-admin/09-products.js:1961-2036`; `07-content-billing.js:268`, `:594`; Orders and Customers have none

Products has a proper selection bar with a menu. The media library has one. Orders — the
screen a merchant lives in — has no row selection at all, so marking twenty orders
dispatched is twenty separate trips into the drawer. Customers has none either.

**Who it affects:** every merchant with more than a handful of daily orders. Roots is
affected now.

**Evidence:** `#pa-bulkbar` with `paBulkMenu*` handlers (`09-products.js:1961-2036`);
`#ml-bulkbar` and `bulkDeleteSelected()` (`07-content-billing.js:268`, `:594`). The Orders
file's only "bulk" is an opt-in paste-a-list-of-waybills tool
(`06-delivery.js:195`, `04-orders.js:6826-6832`) — not row selection. Searching
`08-customers.js` for selection state returns nothing.

**Suggested direction:** the Products selection bar, reused on Orders and Customers.

### E-04 · Orders, customers and the finance ledger cannot be exported
**Severity:** High · table-stakes
**Where:** two export endpoints exist: `routes/retail.js:21540`, `:14561`

The admin can export the product catalogue and the stock-movement ledger. It cannot export
orders, customers, the finance ledger, purchase orders or supplier invoices. A merchant
whose bookkeeper wants last quarter's sales, or who wants to leave the platform, has no
route out except the screen.

**Who it affects:** every merchant, monthly. Roots is affected now.

**Evidence:** the only two `text/csv` responses in the whole service are
`/api/retail-admin/products/export.csv` (`retail.js:21540`) and
`/api/retail-admin/activity/export.csv` (`:14561`). The kitchen app has a recipe-cost
spreadsheet export (`routes/recipes.js:310`), which the merchant admin cannot reach.

**Suggested direction:** a CSV export on every list screen, honouring the filters in force.

### E-05 · Only suppliers can be imported
**Severity:** Medium · expected
**Where:** `public/retail-admin/16-purchasing.js:4029-4090`

Bringing suppliers in from a spreadsheet is a genuinely good flow: a template to download,
plain instructions, forgiving column names, and "same name updates rather than
duplicates". Nothing else can be imported — not products, not customers, not opening stock
— so a merchant moving from another system types their catalogue in by hand.

**Who it affects:** every new merchant. It is the single largest cost of switching to Tacet.

**Evidence:** `CSV_MAP` and the three-step import screen (`16-purchasing.js:4031-4090`);
no other import surface exists in the admin. The example row in the template is itself
first-merchant-shaped — "Guangzhou Bean Works … tofu; soy milk" (`:3538`).

**Suggested direction:** reuse this exact flow for products and customers.

### E-06 · Stock never tells anyone it is running out
**Severity:** High · table-stakes
**Where:** `routes/retail.js:8887-8892`; `public/retail-admin/03-dashboard.js:2450-2460`

There is a low-stock threshold per merchant and per shop, and the dashboard shows "N
running low" when you open it. No notification of any kind is ever sent — not a push, not
an email, not a daily digest. A merchant who does not open the admin does not find out.

**Who it affects:** every merchant. Roots is affected now.

**Evidence:** `lowStockDefault()` (`retail.js:8889`) and the per-store column
`low_stock_threshold` (`retail-inventory.js:109`) feed a badge and a dashboard card only.
The notification catalogue in Part 1 §10.1 has twenty entries and none is about stock.

**Suggested direction:** a daily low-stock push or digest, on by default, with a threshold the merchant already sets.

### E-07 · There is no undo, except for products
**Severity:** Medium · expected
**Where:** `routes/retail.js:20974`, `:20986`; `public/retail-admin/09-products.js:3159-3207`

Products have proper version history: automatic checkpoints, an "Original" baseline, who
edited, and a Restore button behind a clear confirmation. Nothing else in the admin has
it. A deleted coupon, a wrong price on a purchase order line, a deleted delivery zone, an
edited recipe — all one-way.

**Who it affects:** every merchant. Roots is affected now.

**Evidence:** the version list and `pdRestoreVersion` (`09-products.js:3159-3207`), backed
by `GET /products/:id/versions` and `POST /products/:id/restore-version`
(`retail.js:20974`, `:20986`). No equivalent exists for any other record type.

**Suggested direction:** extend the same snapshot-and-restore pattern to the other records a merchant edits by hand.

### E-08 · Filters cannot be saved
**Severity:** Medium · expected
**Where:** the whole admin

Nothing remembers a view. "Unpaid orders from the Web channel at the Tianhe shop" has to
be rebuilt from three controls every morning, and cannot be shared with a colleague.

**Who it affects:** every merchant with a daily routine. Roots is affected now.

**Evidence:** no saved-view storage exists — searching the admin for saved filters, views
or presets returns nothing. Filter state is held in page variables and lost on reload
(`04-orders.js:127-160`).

**Suggested direction:** let a set of filters be named and pinned to the screen it belongs to.

### E-09 · Beyond the command palette there are no keyboard shortcuts
**Severity:** Low · nice-to-have
**Where:** `public/retail-admin/*.js` key handlers

The only global keys are `Ctrl/⌘+K` to search and Escape to close. There is no way to move
between rows, open a record, or advance an order's status from the keyboard — which is how
a busy counter works.

**Who it affects:** high-volume merchants.

**Evidence:** the registered key handlers across all 23 files are Enter (17), Escape (16),
ArrowDown (6), ArrowUp (4) and Tab (2) — all inside individual dialogs and pickers, none
global except the palette.

**Suggested direction:** j/k to move, Enter to open, and a status key on the Orders list.

### E-10 · Notifications cannot be tuned
**Severity:** Medium · expected
**Where:** `public/backend-account.html:441-470`; `routes/backend-auth.js:1141-1156`

A member of staff can turn the new-order chime on or off, and turn push on or off for the
device they are holding. That is the whole of it. There is no way to say which events they
want, no quiet hours, and no shared inbox of what has been sent.

**Who it affects:** every merchant with staff who do different jobs.

**Evidence:** the Notifications pane offers exactly two switches (`backend-account.html:456`,
`:462`); the preference endpoints store a single on/off (`backend-auth.js:1141-1156`,
`routes/push.js` `operatorPref`).

**Suggested direction:** per-event preferences on the same pane, defaulting to today's behaviour.

### E-11 · There is no bookkeeper
**Severity:** Medium · expected
**Where:** `lib/capabilities.js:428-560`

The roles supplied are owner, deputy, manager, shop floor, shop manager, warehouse,
customer service, dispatch, kitchen and stock clerk. None of them can see Finance:
`finance:view` is held only by the three roles that can see everything. A merchant whose
accountant needs the ledger and the supplier invoices — and nothing else — has to make them
a manager.

**Who it affects:** every merchant who uses a bookkeeper. Roots is affected now.

**Evidence:** the preset definitions at `lib/capabilities.js:428-560`; checked each
non-owner preset for `finance:*` and `reports:*` — `staff`, `store_manager`, `warehouse`,
`customer_service` and `dispatch` hold none.

**Suggested direction:** a bookkeeper preset holding finance, reports and purchasing invoices.

### E-12 · Printable documents exist for orders and purchase orders only
**Severity:** Low · nice-to-have
**Where:** `public/retail-admin/04-orders.js:6269`; `16-purchasing.js:1921-1926`; `lib/feie.js`

An order can be printed, a purchase order has a proper print sheet with "Print / Save as
PDF", and a thermal receipt and packing slip exist for the shop printer. There is no
customer statement, no stock count sheet, and no invoice document for a customer who asks
for one on paper.

**Who it affects:** merchants who trade with businesses rather than only consumers.

**Evidence:** the two print paths above and the printer templates in `lib/feie.js`
(`receipt`, `packing`).

**Suggested direction:** add the two or three documents a merchant is asked for by customers.

---

## F. Click efficiency

Measured from the counts in Part 1 §12. "Minimum" is what the same task takes in a mature
admin doing it well.

| Task | Now | Minimum | What is in the way |
|---|---|---|---|
| Mark 20 orders dispatched | **60** (3 each) | 3 (select, act, confirm) | No row selection on Orders — E-03 |
| Annotate an order that came in from the shop | **impossible** | 2 | The field only exists on the manual-order form — B-02 |
| Find who changed a price | **impossible** | 2 | Nothing reads the activity log — E-01 |
| Export last month's orders | **impossible** | 2 | No export — E-04 |
| Rebuild yesterday's filtered view | **4** every time | 1 | Filters are not saved — E-08 |
| Clear the filters on Orders | **up to 4** | 1 | No reset control — B-06 |
| Add a product | **8** + typing | 5–6 | The wizard's front door adds a step before the first question; Review is a step of its own |
| Create a coupon | **8** + typing | 5–6 | Same shape |
| Take a phone order | **7+** | 4–5 | Customer search, then product search per line, then fees, then confirm |
| Record waste | **6** | 3–4 | Item, quantity and reason are three separate steps |
| Refund part of an order | **6+** | 4 | Grows with the number of lines |
| Adjust one product's stock | **4** | 2 | Reaching the field means opening the row first |
| Reply to a review | **5** | 3 | Reviews live in a top-bar menu rather than the rail |

Two things are already at or near the minimum and should not be changed: opening the
admin lands on the Dashboard with no clicks at all, and finding an order by phone number
through the command palette takes two.

---

### F-01 · Everything on a list is done one at a time
**Severity:** High
**Where:** Orders and Customers have no row selection — E-03

The single biggest multiplier in the table above. Twenty orders to dispatch is twenty
trips into the drawer: sixty clicks where three would do. Nothing about the Orders screen
acknowledges that orders arrive in batches.

**Evidence:** E-03.

**Suggested direction:** the Products selection bar, on Orders.

### F-02 · Both wizards spend a step before the first real question
**Severity:** Low
**Where:** `09-products.js:5940` (products); `05-marketing.js:778` (coupons)

Each wizard opens on a choose-your-route screen — three doors for a product, five for a
coupon — before anything is asked. For the common case (start from scratch) that is one
click and one screen of reading spent on nothing. Both also make the review a step of its
own rather than the foot of the last one.

**Evidence:** `pwFrontHtml()` and its three cards (`09-products.js:5940-5955`);
`vwFrontHtml()` and its five (`05-marketing.js:778-795`).

**Suggested direction:** open on the first question with the other routes offered beside it.


## G. Simplicity

### G-01 · Developer vocabulary in text the merchant reads
**Severity:** Medium
**Where:** as listed

| Word | Where | Why it is a problem |
|---|---|---|
| "daemon" | `04-orders.js:4116`, `:4444`, `:4655` | C-04 |
| "Stock & quotas" | Products stock panel | A quota is the platform's word for a per-channel cap |
| "safety buffer" | Products stock panel, Quick Stock | Means "stock held back from sale" — the glossary says so, the screen does not |
| "paste access_token" | integrations | An access token is a developer's object |
| "AppID must look like wx + 16 chars" | channel setup | Correct and unreadable |
| "API v3 key", "cert serial", "mch_id" | payment setup | Unavoidable — they are the payment provider's words — but no help text says where to find them |
| `server_error`, `not_found`, `forbidden_capability`, `kitchen_add_only` | 195 toast sites | A-09 |

**Suggested direction:** a copy pass over the settings and integration screens, and a plain sentence for each error.

### G-02 · Two hundred form fields have no label a screen reader can use
**Severity:** Medium
**Where:** `public/retail-admin.html`

Of 335 input fields in the shell, 37 have a `for=` label, 88 sit inside a label, and 10
carry an `aria-label`. The remaining ~200 rely on a placeholder, which disappears as soon
as the merchant types.

**Who it affects:** anyone using a screen reader, and anyone who forgets what a field was
for once it has content in it.

**Evidence:** counted from the markup: 343 `<label>` elements but only 37 with `for=`;
88 inputs nested inside a label; 10 `aria-label` attributes on inputs.

**Suggested direction:** associate every field with its label.

### G-03 · Settings is nine dropdowns deep with no explanation
**Severity:** Medium
**Where:** `public/retail-admin.html` (Settings section), `02-settings-ops.js`

Settings holds more dropdowns than any other screen and no search box, no chip strip and
no date fields — it is a wall of controls. Some of them change what customers see
immediately; nothing on screen distinguishes those from the ones that do not.

**Who it affects:** every merchant, on the screen they are least confident in.

**Evidence:** the per-section control counts in Part 1 §5.5: Settings has 9 dropdowns and
0 search boxes. The command palette can jump to an individual setting card
(`02-settings-ops.js:1280-1310`), which is the mitigation — but only if the merchant knows
the name of what they are looking for.

**Suggested direction:** group the settings by what they affect, and mark the ones customers see.

---

## H. Empty tenant / day one

### H-01 · The first ten minutes assume the merchant is the first merchant
**Severity:** High
**Where:** `lib/provision-tenant.js`; `routes/retail-setup.js:86-130`; `public/backend-signup.html:162`

Sign-up asks for a company name, a username and a password. It does not ask what country
the business is in, what currency it sells in, what time zone it keeps, or what language
it works in — so all four are decided for them (D-08). There is no welcome email and no
address verification: the page says "Backend created" and redirects to sign-in after 1.8
seconds. The setup checklist that follows has five steps and none of them is any of those
four questions.

**Who it affects:** every new merchant.

**Evidence:** the provisioning inputs (`provision-tenant.js:205-219`); the checklist steps
— store, products, payment, fulfilment, open (`retail-setup.js:120-126`); the sign-up
page's closing message (`backend-signup.html:162-165`).

**Suggested direction:** four questions at sign-up, seeded into the settings the product already has.

### H-02 · The public door is a waiting list
**Severity:** Medium
**Where:** `routes/backend-signup.js:19-65`, `:3-6`

Unless a platform staffer is signed in or an environment switch is on, `/backend/signup`
shows a waitlist form rather than creating an account. That switch is itself gated behind
the data-isolation flag. So a merchant who finds Tacet cannot start using it.

**Who it affects:** every prospective merchant. Deliberate for now — recorded because the
day-one experience is what this section measures.

**Evidence:** `GET /api/backend/signup/status` decides which of the two forms the page
shows (`backend-signup.js:19-65`); `BACKEND_SIGNUP_OPEN` is read alongside
`TENANT_DATA_ISOLATION` (`:3-6`).

**Suggested direction:** none — this is a sequencing decision, not a defect.

### H-03 · A new shop may have no web address at all
**Severity:** High
**Where:** `lib/provision-tenant.js:22`, `:46-56`, `:265-272`

A merchant is given a subdomain for their online shop only if the platform has a base
domain configured. If it does not, provisioning skips the step silently and the merchant
finishes the setup checklist — including "Open the doors" — with a shop that has no
address to send anyone to.

**Who it affects:** every new merchant, depending on a server setting they cannot see.

**Evidence:** `if (!STOREFRONT_BASE_DOMAIN) return null;` (`:46`), called best-effort at
`:265-272`; nothing in the setup guide checks that a domain exists.

**Suggested direction:** make the address a checklist step, and fail loudly at provisioning if none can be issued.

### H-04 · Day one, screen by screen
**Severity:** — (evidence for the findings above)

| Screen | What a merchant with nothing sees |
|---|---|
| Dashboard | Cards with zeroes; the setup guide opens over it on first sign-in |
| Open your store | The one screen built for this moment, and it works: five steps with time estimates, each routing to the right place |
| Orders | An empty list |
| Products | **"No products match this filter"** — B-01 |
| Products, on a phone | **"All 118 · Live 96 · Low 14 · Out 8"** — A-03 |
| Customers | "No customers yet" and a good sentence explaining they arrive on their own |
| Suppliers | The best empty state in the product: explanation plus two actions |
| Materials | A good explanation, no action |
| Recipes | "No recipes yet" |
| Finance | Empty ledger |
| Delivery | No zones; the merchant must build them before delivery works, and the checklist's fulfilment step accepts pickup instead |
| Team | The owner, alone |
| Settings | 43 seeded values, none of them chosen by the merchant — D-08 |

---

## I. Money, end to end

The money rule differs by screen. Collected:

| Site | Rule | Where |
|---|---|---|
| The merchant's own currency and decimals | `toFixed(currency.decimals)`, symbol before or after | `01-core.js:176-183` — used by 8 files |
| Dashboard cards | `toLocaleString` with **0 decimals** by default | `03-dashboard.js:21` |
| Orders KPI tiles | `Math.round` then thousands separators, hardcoded ¥ | `04-orders.js:1061`, `:1064`, `:1124` |
| Refund dialogs | `toFixed(2)`, hardcoded ¥ | `04-orders.js:7782`, `:7946` |
| Phone app | 2 decimals if there is a fraction, otherwise 0 | `m.html:9576` |
| Phone app glance cards | `Math.round`, whole units | `m.html:9581` |
| Counter till | `toFixed(2)` with separators, minus sign before the symbol | `till.html:845` |
| Thermal printer | `toFixed(2)`, full-width ￥ deliberately | `lib/feie.js:156` |
| Refund tender split | `Math.round(x * 100) / 100` | `routes/retail.js:31801-31805` |
| Points converted to money | `Math.floor(x * 100) / 100` | `routes/retail.js:31742` |
| Full-refund test | `amount + 0.005 >= remainingGross` | `routes/retail.js:28894` |

**I-01 · Nine ways to write an amount** — Severity High. Two of them disagree about
decimals on the same screen (A-08); seven of the nine ignore the merchant's currency
setting (D-03).

**I-02 · Money arithmetic happens inside SQL, outside every helper** — Severity Medium.
The expense a purchase order posts to the ledger is summed in a string-built SQL statement
(`retail-purchasing.js:126`: `SUM(${billableQtySql()} * COALESCE(cost_per_unit, 0))`), and
the dashboard, finance summary and customer lifetime-spend totals are the same shape. Their
rounding is the database's, not the product's.

**I-03 · There is no tax anywhere** — Severity High · table-stakes. No tax rate, no
inclusive/exclusive setting, no tax line on an order, no tax on a report. What exists is a
free-typed `extra_tax` amount on a supplier order (`retail-purchasing.js`) and the Chinese
tax-invoice request flow (`routes/retail.js:24239`, `lib/nuonuo.js`). A merchant anywhere
that charges sales tax or VAT cannot use this product to do it.

**I-04 · The platform's money and the merchant's money are stored in different units** —
Severity Low. Billing amounts are integer cents (`billing_invoices.amount_cents`,
`billing_plans.price_cents`, `tenants.setup_fee_cents`); everything the merchant deals in
is a floating-point decimal (A-06).

---

## J. Speed and scale

### J-01 · 63 list endpoints have no row limit
**Severity:** High → **mostly closed, see the amendment**
**Where:** the full list is in Part 1; the ones that will bite first are below

> **AMENDED 2026-09-06 — re-verified in `docs/tacet-j01-row-limits-survey.md`.**
> **CLOSED as written. Six of the seven below have a row ceiling; the seventh
> should not have one.**
>
> **Five are paged in SQL** (`LIMIT ? OFFSET ?`): `/materials`, `/suppliers`,
> `/recipes`, `/inventory/grid`, `/purchasing/invoices`. Half of **J-02** closed
> with them.
>
> **`/finance/transactions` is capped too**, since `188a50bf` — in JavaScript,
> on the merged list, because its three reads are interleaved by date and a
> per-query `LIMIT` would leave holes in the middle of the ledger. Totals and
> counts are computed **before** the cut so the figure under the list still
> describes the whole window, and `truncated` is reported.
>
> ⚠️ *The first version of this amendment, merged earlier the same day, called
> this endpoint "genuinely open" and recommended a span cap instead of paging.
> Both were wrong: the survey had read as far as the unlimited `.all()` calls
> and stopped short of the cap 120 lines below them. Corrected here and in the
> survey, which records how the mistake was made.*
>
> **One should NOT be paged:** `/products/export.csv`. An export that silently
> returns part of your catalogue is worse than one that is slow; if it needs
> fixing the fix is streaming, which is a different job.
>
> **What genuinely remains** is narrower than this finding and should not be
> filed under it: `readTransactions()` bounds its *response* but still reads the
> whole window into *memory*. Against ~209 ledger rows that is not worth a
> behaviour change. The survey records the shape of a fix for the day it is.
>
> **Every line number in the table below has drifted** — the survey lists the
> current ones. The "63" could not be reproduced (240 such handlers, 141 without
> a `LIMIT`, by a method that over-counts). The count was never the useful
> thing: sort by whether a table grows with USE or with SETUP.

Most of the 63 are small lookup lists where it does not matter. These grow without bound:

| Endpoint | What grows | Where |
|---|---|---|
| `/materials` | every material the merchant has ever added | `routes/retail-materials.js:156` |
| `/suppliers` | every supplier | `routes/retail-purchasing.js:639` |
| `/recipes` | every recipe, with all its lines | `routes/retail-recipes.js:184` |
| `/purchasing/invoices` | every supplier invoice — and see J-02 | `routes/retail-purchasing.js:1796` |
| `/finance/transactions` | every ledger row in the chosen window | `routes/finance-transactions.js:237` |
| `/inventory/grid` | every product × every location | `routes/retail-inventory.js:201` |
| `/products/export.csv` | the whole catalogue, assembled in memory | `routes/retail.js:21540` |
| `/delivery-zones`, `/categories`, `/flash-sales`, `/media/folders`, `/refunds` | each grows with use | various |

**Who it affects:** the first merchant to reach a few thousand rows in any one of them.
Roots is not there yet.

**Evidence:** each handler calls `.all()` with no `LIMIT` in the statement. For contrast,
the endpoints that do page are Orders (`limit` 100, capped at 200, with `offset`),
Customers (`pageSize` 20, capped at 100) and Media (`limit` 60, capped at 200, with
`offset`) — so the pattern exists and was simply not applied to the rest.

**Suggested direction:** page the seven that grow without bound, using the shape Orders and Media already use.

### J-02 · Two query-per-row loops
**Severity:** Medium
**Where:** `routes/retail-purchasing.js:1808-1819`; `routes/retail-inventory.js:222-234`

> **Correction, made during the fix pass.** This finding originally read *"One confirmed
> query-per-row loop"* and listed the inventory grid under *checked and clean*. That was
> half right and is corrected here rather than quietly repaired in the code. The grid
> batches its **shelf** rows (`stockByPair`, one query for the whole table) — which is what
> was checked — but the availability call sitting under them, `inventory.getAvailable(...)`,
> was made once per product **per store**, and it issues three queries each. A 500-product
> catalogue across four shops was 6,000 queries to paint one screen. A batch twin,
> `inventory.getAvailableMap`, already existed for exactly this and was not being used.

1. **The supplier-invoice list** runs one extra query for every invoice it returns, to fetch
   that invoice's linked purchase orders. With no limit on the list (J-01), the number of
   queries grows with the number of invoices.
   *Evidence:* `const linkStmt = db.prepare(...)` before the loop, then
   `const lines = linkStmt.all(inv.id)` inside `invs.map(inv => { … })`.

2. **The cross-store inventory grid** calls `inventory.getAvailable(s.id, p.product_id,
   'wechat')` inside a product × store double loop. `getAvailable` (`lib/inventory.js:284`)
   runs one shelf read plus two reservation sums, so the cost is three queries per cell.
   *Evidence:* the call site inside `products.map(p => { const stocks = stores.map(s => …`,
   against `getAvailableMap` at `lib/inventory.js:317`, whose own comment says it exists to
   replace "3 queries per product".

**Who it affects:** (1) merchants with a long invoice history; (2) every merchant with more
than a small catalogue, on the page they use to check stock across shops. Roots is affected
by (2) now.

*Checked and clean:* the catalogue export, the recipe list, the order detail and the product
list all load their related rows in one batched query and join them in memory
(`retail.js:21562-21583`, `retail-recipes.js:197-211`).
`routes/backend-notices.js:66-67` does the same per-ticket, but the list is a handful of
support tickets and will not grow.

**Suggested direction:** batch both — one query per page of invoices, and `getAvailableMap` per store.

### J-03 · The admin shell is 970 KB of JavaScript before anything is fetched
**Severity:** Medium → **half closed; the other half is blocked, see the amendment**
**Where:** `public/retail-admin/` — 23 files, 57,241 lines

> **AMENDED 2026-09-06 — re-measured in `docs/tacet-j03-admin-bundle-survey.md`.**
>
> **Compression and caching are done.** `lib/static-assets.js` (mounted at
> `server.js:194`) was written for this finding: 3.33 MB → 1,092 KB on the wire,
> and a `?v=`-stamped file is cached `immutable`, so between deploys there is no
> request at all. *"Loaded on every visit"* is now *"loaded on the first visit
> after each deploy"*.
>
> **The bundle has GROWN:** 23 files → **28**, 57,218 lines → **61,976**,
> 995 KB → **1,092 KB** gzipped. `04-orders.js` is 600 KB raw.
>
> **The suggested direction below cannot be done as written.** `01-core.js` is
> not a base layer: all 27 other files depend on it *and* it depends on seven of
> them at 26 sites. Following those edges, **fourteen files are one strongly
> connected component worth 771 KB — 71% of the bundle** — and nothing in a
> cycle can be loaded on demand. Cutting core's outbound edges alone does not
> break it. The coupling is not only function calls: `18-materials.js` reads
> `_cats` from `05-marketing.js`, `26-print.js` reads `PA_STORE` and
> `CU_CURRENT`. Shared state across a lazy boundary fails *silently*.
>
> ⚠️ **CORRECTED 2026-09-06, later the same day: the cycle is 23 files and 94%
> of the bundle, and the lazy-load cut is 6%, not 29%.** The first version of
> this amendment said fourteen files and a 29% cut. Its coupling analysis did
> not count `window.f = function f()` as a declaration, and there are **408** of
> them — the deliberately-exported names, so the likeliest to cross files. The
> error was found by starting to build the change: the rail dispatches through
> inline `onclick="finInit()"`, and `finInit` is declared on `window` in a file
> the survey had called a clean candidate.
>
> **What is available instead: not much, and the recommendation is now DON'T.**
> Five files sit outside the cycle — `18-materials`, `22-finance`, `20-waste`,
> `24-import`, `27-keyboard`, 67 KB together. They are genuinely loadable on
> demand and it is not worth a loader, a registry and a permanent class of
> "screen opens on a ReferenceError" bug to save 6% of one load per deploy —
> against the 98 KB brotli bought for one constant and no new failure mode.
>
> The finding's own direction survives and is stronger than it reads: the admin
> cannot be split as it stands, and the knot is 94% rather than 71%.
>
> **Units:** the 970 KB above is within 3% of the gzipped total at this
> document's own commit, while *"Orders alone is 558 KB"* below is a **raw**
> size. The headline and its evidence are in different units.

Every screen's code is loaded on every visit, in one global scope, in a fixed order.
Orders alone is 558 KB. Nothing is loaded on demand.

**Who it affects:** every merchant on a slow connection, at every sign-in; worst on the
first visit after a deploy, when the cache is invalidated by design.

**Evidence:** the file sizes; `server.js:624-632` stamps every asset URL with a new version
on each deploy, so the whole bundle is re-fetched.

**Suggested direction:** load a section's code when the section is first opened.

---

## K. Roles in daily use

RBAC enforcement is out of scope. What follows is only about what each role *sees*, and
excess here is a simplicity problem, not a security one.

### K-01 · Fifty-eight controls out of nearly two thousand are tagged by role
**Severity:** Medium
**Where:** `public/retail-admin.html` (14 `data-cap`), `public/retail-admin/*.js` (44)

Screens hide from a role that lacks the capability, and individual controls hide if they
are tagged `data-cap`. Fifty-eight controls are tagged. The admin has 1,872 click
handlers. So once a role can open a screen, they see essentially all of it — a shop-floor
member of staff opening Orders sees every button an owner sees, including refunds.

**Who it affects:** every merchant with staff. Roots is affected now.

**Evidence:** 14 `data-cap` attributes in the shell markup and 44 across the 23 JavaScript
files; `applyCapGates()` hides rail rows and `[data-cap]` elements only
(`01-core.js:160-182`). Part 1 §3.5 counts the handlers.

**Suggested direction:** tag the actions that matter — refunds, price changes, payouts, deletions — not every control.

### K-02 · Five realistic roles, and what today's admin gives them

| Role | What they hold | What they see that they do not need |
|---|---|---|
| **Owner** | everything, by absolute bypass (`lib/capabilities.js:430`) | — |
| **Manager / deputy** | everything except paying the bill, editing permissions and deleting a location | nothing much; this is the intended shape |
| **Cashier / shop floor** (`staff`) | dashboard, orders view+edit, till, invoices view, customers view, products view, stock recount — 10 capabilities | The whole Orders screen once opened, including Refund and Cancel + refund, because those buttons are not tagged (K-01) |
| **Stock person** (`warehouse`) | 19 capabilities: stock ledger, quick stock, transfers, purchasing, materials, waste, channel stock pushes | Purchasing includes supplier prices and invoice totals — the preset comments say money was deliberately kept away from this role elsewhere, and buying prices arrive with the purchasing section |
| **Bookkeeper** | **does not exist** — E-11 | — |

**Evidence:** the presets at `lib/capabilities.js:428-560`, read in full. The `warehouse`
preset's own comments explain that `materials:view`/`:edit` are listed individually rather
than granting the whole section precisely so a future money capability would not arrive by
accident — and then grant `...sect('purchasing')`, which is the section that carries
supplier prices.

**Suggested direction:** add a bookkeeper preset, and split purchasing's money out of the stock person's grant.

---

## L. Mistakes and recovery

| Action | Can it be taken back? | Where |
|---|---|---|
| Stock recount typed wrong | Only by typing the right number again — the ledger keeps the history, but nothing warns and nothing offers an undo. **A-02** makes the accidental version easy | `retail-inventory.js:372` |
| Product edited wrongly | **Yes** — version history with a Restore button and a clear confirmation. The best recovery path in the product | `09-products.js:3159-3207` |
| Product deleted | Behind a confirmation; recoverable only if it archived rather than deleted — the governing rules say archive, the capability is called `products:delete` | `cap-routes.js:136` |
| Order cancelled | **No.** `NEXT_STATUS` offers nothing from `cancelled` | `04-orders.js:2862` |
| Order refunded | **No.** Nothing from `refunded` | `04-orders.js:2863` |
| Order dispatched by mistake | **Yes**, while no parcel has a waybill — rolls back to Preparing, silently, without telling the customer | `04-orders.js:6435` |
| Waste recorded wrongly | **Yes** — voiding is a separate capability from recording, deliberately | `cap-routes.js:224-227` |
| Material archived | **Yes** — restore | `19-recipes.js:2025` |
| Half-written product | **No** — Escape discards it (**B-05**) | `09-products.js:5891` |
| Broadcast sent | **No** | `/api/retail-admin/broadcasts` |
| Coupon deleted | **No** | `cap-routes.js:121` |
| Delivery zone deleted | **No** | `06-delivery.js:1124` |
| Supplier deleted | Deactivated rather than deleted — recoverable | `retail-purchasing.js:789` |
| Purchase order deleted | **No** — the header and its lines are removed | `retail-purchasing.js:2367-2368` |
| Recipe edited | **No** — its materials and steps are deleted and re-inserted on every save | `retail-recipes.js:449-463` |
| Finance ledger row deleted | **No** — the confirmation says so: "This removes the row from the ledger. This cannot be undone." | `22-finance.js:865` |

**L-01 · The two most common daily mistakes have the weakest recovery** — Severity High.
A wrong stock count writes silently (A-02) and a half-written product vanishes on Escape
(B-05). Both are everyday slips; both are one keystroke away.

**L-02 · Recipes lose their history on every save** — Severity Medium. Editing a recipe
deletes all its material lines and steps and re-inserts them (`retail-recipes.js:449-463`),
so there is no previous version to go back to and no record that a quantity changed. The
same product has a full version history for products a few files away.

---

## M. Language — the numbers, for the open decision

No recommendation is made here; §23 of the decisions record is where that belongs. The
shape is this.

**Four mechanisms are live at once** (Part 1 §9.1): `cuT(en, cn)` in the shell,
`T(en, cn)` aliasing it in six newer files, an `English · 中文` text node split at render
by a DOM walker, and paired `.en`/`.cn` spans with `L(en, cn)` on the standalone pages.
A fifth, `EN_ONLY_MAP` (`10-extras.js:1476-1520`), is a 45-entry lookup for strings that
shipped in English and were translated afterwards.

**Counts**

| | |
|---|---|
| Pairing calls in admin JavaScript | 3,921 (`cuT` 2,873 + `T` 1,048) |
| Paired text nodes in the shell markup | 1,484 of 2,094 |
| Message strings (toasts, confirms, placeholders, titles) | 866 — 271 through a pairing call, 209 as a single `EN · 中文` string, **128 English only**, 7 Chinese only, 33 a raw variable |
| Bilingual database columns | 73 across 23 tables |
| Tables with a language column | 1 (`retail_synthetic_reviews.lang`) |
| Language columns on the merchant record | **0** |
| Language columns on a staff account | **0** |
| Hardcoded-locale date/number calls | 61 in the front end, 1 in the API |

**By section** (pairing calls, largest first): Orders 612 · Products 491 · Channels 288 ·
Dashboard 249 · Customers 165 · Marketing 173 · Settings 152 · Meituan 146 · Core 142 ·
Setup guide 126 · Content 118 · Eleme 89 · Purchasing 549 (via `T`) · Recipes 236 ·
Materials 109 · SKU 77 · Waste 62 · Product build 37 · Finance 40 · Delivery 34 ·
Loyalty 25 · Activity 1 · gzgrocery 0.

**Where the language is decided**

| Surface | Decided by | Key |
|---|---|---|
| Desktop admin | the viewer, on this browser | `localStorage['roots-admin-lang']`, default English |
| Phone admin | the viewer, on this phone — **a separate setting** | `localStorage['tacet-m-lang']` |
| Profile, sign-in, brand | shared with the desktop admin | same key |
| Quick Stock | shared with the desktop admin | same key |
| Customer parcel-tracking page | **the link, not the reader** — `?lang=cn`, default English | `routes/retail.js:11232` |
| Printed receipts | neither — the template is fixed | `lib/feie.js` |
| Text-message codes | the template registered with the provider | `lib/aliyun-sms.js:86-96` |
| A new merchant's shop | **the platform** — seeded `theme.language: 'bilingual'` | `lib/provision-tenant.js:82` |

**Shape of the problem for a third language:** every mechanism above is built for exactly
two. A function of two arguments, a string with one separator, two CSS classes, two
database columns per name. There is no language registry, no translation file, and no use
of `Accept-Language` anywhere. The one part that would already work in any locale is
number and date formatting, because 61 of the 62 `toLocaleString` calls pass no fixed
locale and follow the viewer's browser.

---

### M-01 · The phone and the desktop remember different languages
**Severity:** Medium
**Where:** `public/retail-admin/10-extras.js:1471`; `public/m.html:730`

The desktop admin stores the chosen language under `roots-admin-lang`; the phone app uses
`tacet-m-lang`. A merchant who switches to Chinese on their phone finds English on their
computer, and vice versa. Every other admin surface — profile, sign-in, brand, Quick Stock
— shares the desktop key, so the phone is the only one out of step.

**Evidence:** `const LANG_KEY = 'roots-admin-lang'` (`10-extras.js:1471`);
`const M_LANG_KEY='tacet-m-lang'` (`m.html:730`); `backend-account.html:15` reads the
desktop key.

**Suggested direction:** one key, or a per-person setting stored against the account.

### M-02 · Language is a browser setting, not a person's setting
**Severity:** Medium
**Where:** `10-extras.js:1471-1475`; `database.js` (`tenant_users` columns)

A member of staff's language lives in the browser they happen to be using. Sign in on the
shop tablet and you get whatever the last person chose; sign in on a new computer and you
get English. There is no language column on a staff account or on the merchant record.

**Evidence:** the storage keys above; searched the schema for a language column — the only
one in the whole database is `retail_synthetic_reviews.lang`.

**Suggested direction:** store the language on the staff account, with the browser as a fallback.


## N. Mobile admin

Phones are served a different application (`public/m.html`), not a narrow version of the
desktop one. It is well built for the size: 44px minimum touch targets on buttons, chips
and rows, 56px list rows, primary actions at the bottom, pull-to-refresh, a Back that
closes the top sheet, and an install manifest.

### N-01 · The phone app switches off pinch-zoom
**Severity:** Medium
**Where:** `public/m.html:9`

`maximum-scale=1, user-scalable=no` in the viewport tag means a merchant cannot zoom in
on their own orders. For anyone with less than perfect eyesight this is the difference
between using the app and not.

**Evidence:** `<meta name="viewport" content="width=device-width, initial-scale=1,
viewport-fit=cover, maximum-scale=1, user-scalable=no">`. The desktop shell does not do
this (`retail-admin.html:5`).

**Suggested direction:** drop `maximum-scale` and `user-scalable`.

### N-02 · A phone order cannot be taken on a phone
**Severity:** High
**Where:** `public/m.html:1551-1562`; `tab-orders-new` is desktop-only

Taking an order over the telephone is a daily task in a shop, and the phone is where the
shopkeeper is standing. The mobile app deliberately has no create surface — the comment
explains that an earlier fake one was removed because its submit handler only showed
"Created" and sent nothing, and that "authoring stays on the desktop".

**Who it affects:** every merchant who takes orders by phone or at a market stall.

**Evidence:** the removal note at `m.html:1551-1562`; the desktop-only `tab-orders-new`
section; the quick-actions comment at `:2006-2014` listing "Add product", "Create coupon",
"Send broadcast" as "three verbs the phone cannot perform".

**Suggested direction:** the one authoring flow worth putting on the phone is a manual order.

### N-03 · What the phone can and cannot do

| Task | On the phone |
|---|---|
| See new orders, with a chime and a badge | **Yes** |
| Move an order through its statuses | **Yes** |
| Approve, reject or pay out a refund | **Yes** (`m.html:863-885`) |
| Find an order or a customer | **Yes** — a search sheet |
| Fix a price or a stock count | **Yes** — described as "quick edits here · full authoring on desktop" |
| Receive a delivery | **Yes** |
| Record waste | **Yes** |
| Read and reply to the inbox | **Yes** |
| Today's takings and a trend | **Yes** |
| Team, settings, sign out | **Yes** |
| **Take a manual order** | **No** — N-02 |
| **Add a product, create a coupon, send a broadcast** | **No**, by decision |
| Reports | Trend only |

**Evidence:** the 30 screens and 13 sheets listed in Part 1 §3.4, read against `SUBS`
(`m.html:5115`) and the `reg(...)` command table.

---

## O. Search and find

### O-01 · What can be found, and from where

| Looking for | From the command palette | From its own screen | Matches on |
|---|---|---|---|
| An order | **Yes** | Yes | order number, recipient name, recipient phone |
| A customer | **Yes** | Yes | nickname, phone, openid, and the phone on any saved address — with digits normalised, so a spaced number still matches |
| A product | **Yes** | Yes | name in both languages, SKU |
| A stock movement | No | Yes | SKU, name, order number, note |
| An image | No | Yes | filename, alt text |
| A coupon | No | Yes | code, label |
| A delivery zone | No | Yes | zone name |
| A supplier | No | Yes | name |
| **A location** | No | **No** | — |
| A purchase order | No | Yes — but the filtering happens in the browser over rows already loaded, so it only searches what the unpaged list happened to return (J-01) | PO number, supplier, line suppliers (`16-purchasing.js:403`) |
| **A staff member** | No | **No** | — |
| **A material** | No | Yes | name, SKU |

The command palette is the strongest thing in this product's navigation: it indexes every
page, panel and individual setting from the live page, and on two characters it also
queries products, orders and customers and deep-links into the right drawer. It even
explains in a result's subtitle *why* a row matched — showing the phone number when the
query matched a phone (`02-settings-ops.js:1350-1360`).

### O-02 · Locations and staff cannot be searched
**Severity:** Low
**Where:** Settings → Stores; Manage team

Both are lists with no search box. Fine at two locations and four staff; not fine at
twenty and sixty, which is the size of merchant the platform is being built for.

**Evidence:** the per-section control counts in Part 1 §5.5 — Settings has 9 dropdowns and
0 search boxes; Team has 4 dropdowns, 1 chip strip and 0 search boxes.

**Suggested direction:** a search box on both lists, and locations in the command palette.

---

## P. Notifications and silence

### P-01 · The merchant's own operational alerts go to the platform's chat, not theirs
**Severity:** High
**Where:** `lib/ops-alert.js`; call sites in `routes/retail.js` (5), `server.js` (3), the channel drift sweeps (4), `lib/alert-latch.js` (1), the four background daemons (31)

Most of what the system notices about a merchant's day — a route failing on their orders, a
channel queue stalling, a courier push that cannot geocode an address, the storefront not
responding — is sent to one operations chat group and never to the merchant. The merchant's
own channel exists (`lib/tenant-notify.js`) but fires for exactly two events, and only if
they have configured a staff-chat app of their own.

**Who it affects:** every merchant. Roots is affected now — in Roots' case the two groups
may be the same people, which is why it has not been felt.

**Evidence:** the alert catalogue in Part 1 §10.1, items 13-15; `sendOpsAlert` call sites
counted above; `notifyTenantOperators` returns `wecom_app_not_configured` when the merchant
has not set one up (`lib/tenant-notify.js:31`). D-02 covers the second half of this: the
destination is read from one fixed database file.

**Suggested direction:** split the alerts into "the platform's problem" and "this merchant's problem", and route the second to the merchant.

### P-02 · Failures that reach nobody
**Severity:** High
**Where:** as listed

Checked every failure path in the admin's own flows. These end without any signal to the
merchant:

| What fails | What happens instead | Where |
|---|---|---|
| An email fails to send | the caller gets `{ok:false}` and, on the sign-in path, a generic message; no record is kept | `lib/email-sender.js:38` |
| A text message fails to send | same shape — `{ok:false, error}` returned and dropped | `lib/aliyun-sms.js:86-96` |
| A push notification fails | the device's subscription is quietly pruned; the merchant is not told their phone has stopped receiving orders | `routes/push.js` `_sendMany` |
| A delivery reminder cannot find a recipient | returns `{sent: 0}` and logs nothing | `lib/delivery-reminders.js:63` — and see D-06, where for most merchants this is *every* reminder |
| Stock reaches zero, or the low threshold | nothing is sent; it shows on the dashboard if someone opens it | E-06 |
| A background daemon stops | the platform is paged; the merchant is not | `scripts/health-watchdog.js` |
| A merchant's stored credentials cannot be decrypted | falls back to a development mode that silently does nothing, logged at boot only | `server.js:1030-1038` |
| Any of 211 swallowed errors in the API | nothing at all — the `catch` block is empty | counted across `routes/` and `lib/` |
| Any of 269 console-only errors | a line in the server log | same |
| A session expires mid-edit | the page redirects to sign-in; anything typed is gone | `backend-account.html:533`, and every page's 401 handler |

**Who it affects:** every merchant.

**Evidence:** the counts above were produced by matching `catch` blocks whose body is empty
or a single `console.*` call across all of `routes/` and `lib/`;
`routes/retail.js` alone holds 69 empty ones and 202 console-only.

*Checked and clean:* a failed printer job is **not** silent — the outcome is written onto
the order as `print_status` / `print_error` and the drawer offers a reprint
(`routes/retail.js:26602-26614`). That is the pattern the rest of this table needs.

**Suggested direction:** record every failed send against the thing it was about, the way printing already does, and show it there.

### P-03 · There is no history of what was sent
**Severity:** Medium
**Where:** the whole admin

Twenty kinds of notification can leave the system and there is no screen listing what went
out, to whom, and whether it arrived. A merchant asking "did the customer get told?" has
no way to find out.

**Evidence:** the catalogue in Part 1 §10.1; no notification-log table or screen exists.
`retail_notifications` holds customer-facing in-app messages, not a send log.

**Suggested direction:** one log, written by the same helpers that send.

---

## Q. Pattern consistency

The rebuilt Customers and Orders screens are the standard. Measured against them:

| Screen | Drawer | Empty state | Filters can be cleared | Dialogs | Money format | Dates |
|---|---|---|---|---|---|---|
| **Customers** (standard) | side drawer, dismissable | explains itself, offers a clear-filters button | **yes** | designed | `¥` hardcoded | shared formatter |
| **Orders** (standard) | side drawer | plain | **no** | designed | **three formats on one screen** (A-08) | shared formatter |
| Products | docked inspector, not a drawer | **filter error on an empty catalogue** (B-01) | no | designed | mixed | **own formatter** (`pdFmtVersionTime`) |
| Purchasing | own screen stack with its own back button | good, with two actions | no (browser-side filter only) | designed (`pu2-*`) | `acMoney` in 2 places, `¥` in 5 | shared |
| Materials | own card layout | good text, no action | no | designed | `acMoney` | shared |
| Recipes | own layout | plain | no | designed | mixed | shared |
| Waste | own layout | plain | **yes**, and shown in the toolbar — the best of the three patterns | `acMoney` | shared |
| Team | modals, not drawers | plain | n/a | **native browser dialogs** (C-01) | n/a | **own formatter** |
| Marketing | drawer + wizard | plain | no | designed | `¥` hardcoded | **own formatter** |
| Delivery | edit panel | plain | no | designed | `¥` hardcoded | shared |
| Settings | panels | n/a | n/a | **native `window.confirm` in three places** | `¥` hardcoded | n/a |
| Finance | modal | plain | no | designed | `¥` hardcoded | shared |
| Phone app | sheets | good, with a clear-filters button | **yes** | own sheet pattern | **own formatter** | **own formatter** |

**Q-01 · Three dialog systems** — Severity Medium. The designed `askConfirm`/`askReason`
dialogs, the native browser `confirm`/`prompt` on Settings and Team (C-01), and the phone
app's own sheets. `public/tacet-dialogs.js` exists to be the one answer and is not used by
Settings or Team.

> **AMENDED 2026-09-06 — re-verified. Nearly closed, and no longer where this says.**
> **Settings and Team are clean.** `02-settings-ops.js`, which holds both, has
> **zero** native dialogs. `23-sku.js:614` records the closure in place: *"The
> shared dialog, not the browser's. This was the last native `confirm()` in the
> admin — audit C-01 replaced five of them and this one, in a file added
> afterwards, was missed."*
>
> **One native dialog remains, and this finding does not mention it:** a
> `window.prompt` at `04-orders.js:7629`, asking for the exact OS name of the JD
> label printer. Looking for the problem where this text points finds nothing.
>
> **Not converted, and the reason is the shape rather than the size:**
> `jdPromptPrinterName()` is synchronous and returns its value to two callers,
> while the shared `askPrompt()` is a Promise — so it is an async change threaded
> through a print path that cannot be exercised without the JD component. Small,
> real, and worth doing deliberately rather than in passing.

**Q-02 · Four date formatters and nine money formats** — Severity Medium. C-02 and I-01.

> **Re-verified 2026-09-06 — still exactly four**, and still the four this
> implies: `tmdDateFmt` (`02-settings-ops.js:3727`, the Team one the table calls
> out), `bxFmtDateTime` (`05-marketing.js:2316`), `cuFmtTime`
> (`08-customers.js:2629`) and `pdFmtVersionTime` (`09-products.js:3296`). No
> change.

**Q-03 · Three "clear the filters" behaviours** — Severity Low. Waste shows the button in
the toolbar whenever a filter is set; Customers shows it only in the empty state; every
other screen has none (B-06). Waste's is the right one.

> **AMENDED 2026-09-06 — re-verified. Both named screens have moved on.**
> **Orders now has a clear-filters control** (`04-orders.js:1360`, `:1515`), so
> the table row above reading *"Filters can be cleared: **no**"* is out of date.
> **Customers now clears from the applied pills too** — an `×` per pill
> (`08-customers.js:153`, `:169`) as well as the empty state's own action
> (`:232`) — so it is no longer "only in the empty state".
>
> The finding's *conclusion* still holds: the behaviours are still not one
> behaviour, and Waste's is still the one to copy. What has changed is that the
> gap is narrower and two of its three examples now describe something else.

**Q-04 · Two navigation models inside one shell** — Severity Low. Most sections are a page
with a drawer. Purchasing is a stack of screens with its own back button
(`16-purchasing.js` `_screen` state, `backBtn(...)`), which is the phone app's model
arriving on the desktop.

> **Re-verified 2026-09-06 — still true, and it has NOT spread.**
> `16-purchasing.js` still carries the stack (40 `_screen` references, `backBtn`
> at `:308`) and is still the only file in `public/retail-admin/` that does. The
> inconsistency is contained, which is the useful half of the answer: this is
> one screen to bring into line, not a pattern taking hold.

---

## R. Accessibility — basic pass

### R-01 · Pinch-zoom is switched off on the phone
**Severity:** Medium · N-01 above. This is the single most consequential accessibility
defect found, because it removes the standard remedy for every other size problem.

### R-02 · About two hundred fields have no label a screen reader can read
**Severity:** Medium · G-02 above.

### R-03 · Small muted text in the dark theme falls below the contrast standard
**Severity:** Medium
**Where:** `public/retail-admin.css:35` (`--text-3: #7d7a72`), used 192 times

`--text-3` on the dark theme's raised background gives a contrast ratio of **3.61**. The
standard for normal-sized text is 4.5. It is used for 192 rules, several of them at 10 and
11 pixels — the brand sub-label is `font-size: 10px` in this colour.

**Evidence:** computed from the token values: `#7d7a72` on `--bg-elev-1: #1F252B` = 3.61.
The light theme's equivalent (`--td-text2: #58606E` on the paper background) is 6.02 and
passes. `--text-2` in dark passes at 6.74.

**Suggested direction:** lighten `--text-3` in the dark theme until it clears 4.5.

### R-04 · Touch targets in the product inspector are about half the minimum
**Severity:** Low
**Where:** `public/retail-admin.css:4749`

`.pa-inspector-actions .btn { padding: 5px 9px; font-size: 11px; }` — roughly 26 pixels
tall against a 44-pixel guideline. This is a desktop-only surface driven by a mouse, so it
is a low-severity comfort problem rather than a blocker. The phone app is properly sized
throughout (44px buttons and chips, 56px rows).

**Suggested direction:** raise the inspector's action buttons to the same size as the rest of the admin.

### R-05 · Keyboard reachability is partial
**Severity:** Medium
**Where:** `public/retail-admin.html`; `public/retail-admin.css` (108 focus rules)

Focus styling exists and is used. Order rows carry `tabindex="0"` so the list is
keyboard-reachable. But 385 of the shell's actions are `onclick` on elements that are not
always buttons, dialogs have no focus trap (recorded for the Profile pane in the project's
own IA notes), and there is no skip link past the rail.

**Evidence:** 108 `:focus` / `:focus-visible` rules in the stylesheet;
`<tr class="order-row" … tabindex="0">` (`04-orders.js:1301`); `docs/tacet-ia-blueprint.md`
§11 records "no focus trap in either layer" for the Profile app.

**Suggested direction:** trap focus in dialogs and drawers, and add a skip link.

---

## Categories with no findings

**None.** Every category produced at least one. Two are close, and what was checked is
recorded so the next pass does not redo it:

- **C (common-sense failures)** — the check that came back cleanest was confirmations on
  destructive actions: 31 of 32 delete requests ask first, several with a type-the-name
  gate (C-05). The findings that remain are about consistency, not absence.
- **J (speed and scale)** — the codebase batches its queries carefully; two endpoints do
  not (J-02, corrected during the fix pass — the second was found only when the inventory
  grid was read a second time, and this section originally said "all but one"). The scale
  problem here is mostly missing paging rather than bad queries.

---
