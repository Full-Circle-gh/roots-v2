# Tacet admin — IA blueprint

**v2.5 · header line reversed 2026-07-31 (see below). §§1, 3, 4, 7, 8, 9 amended 2026-07-29 (rail drill-down + Content rename). §2 amended 2026-07-25 (survey-corrected). Surveyed 2026-07-16 from `/root/roots-v2` (roots-v2-hk), not from v1 of this document.**

> ## 🔴 v2.5 changes, 2026-07-31 — the header line above reversed. Read this if you read v2.4.
>
> **v2.4's opening paragraph said:** *"`¥` and China channels are tenant configuration, not brand."*
>
> **v2.5 says the opposite.** They are **Roots'** currency and **Roots'** channel list, hardcoded today — **per-business configuration that does not yet exist**, not brand and **not settled**. `docs/tacet-consolidation-decisions.md` **§0 governs** and wins over anything in this document: currency is per business, the channel list is not a fixed set (GZ Grocery in particular is specific to one customer), and the hardcoding is a **defect to be removed**, not a decision already made.
>
> **Why this matters more than a wording tweak.** "Tenant configuration, not brand" is the exact claim the rulebook reversed at v4.0 as audit finding **J6**, where it had been predicted that the line would be cited as authority to leave the hardcoding alone. The same sentence was sitting in this document's **first paragraph** — the framing every reader of the IA passes through — and it survived **both** §J findings aimed at this file: **J4** fixed the `¥` annotations in §4's Skin column, **J5** fixed the "tenant configuration (per merchant), not brand" list in §9, and neither reached line 7. It was corrected in `b0c4f265` with no version bump; this is that bump.
>
> **Nothing else in this document changed at v2.5.** §4's Skin column and §9's per-business list already carry the corrected framing from J4 and J5. The `Skin?` annotations still read `money`, `China-only`, `WeChat framing` and so on — those are **accurate records of what a surface depends on today**, which is the point of the column.
>
> **The rail drill-down amendment is fully discharged** (`tacet-desktop-patterns.md` §10.7): every §7 item owed to this document landed at v2.4, and the last outstanding one — a header line on `tacet-editor-addendum.md` — landed 2026-07-31.

> **v2.4 changes, all from `tacet-rail-drilldown-amendment.md` (2026-07-29):** rail groups stop flying out to the right and **drill down inside the rail** · the `Editor` group is renamed **`Content · 内容`** and its own page becomes an ordinary child row named **`Editor`** · a **child→parent map** is added so the rail resolves its own level · gate 1 gains a **flatten-at-one** rule · §8's "two editors" line is corrected — the Product Page Editor has **no independent route**.

Every navigable surface of the **Tacet** desktop admin, how it's grouped, the order it appears in, and the rules that show or hide it. Brand skin is governed by `tacet-design-system.md` + `tacet-brand-concept.md`; page composition by `tacet-desktop-patterns.md`. `¥` and the China channels are **Roots'** currency and channel list, hardcoded today — per-business configuration that does not yet exist, not brand and not settled (`docs/tacet-consolidation-decisions.md` §0; same correction as `tacet-desktop-patterns.md` §1.16, made 2026-07-31).

> **Why v2 exists.** v1 was accurate when written and is no longer. Three sections retired into their parents, two shipped new, three rail groups flattened, two feature flags added. v1 described 35 sections; there are **34**, and 5 of them are different. Every line below is grounded in a grep against the live box — file and line cited where it matters. Where the code and v1 disagreed, the code won.

**Grounded in:** `public/retail-admin.html` (section markup, rail markup ~1028–1213, bottom nav ~810–833), `public/retail-admin/01-core.js` (`TAB_CAP` 144–157, `applyCapGates` 160–182), `public/retail-admin.css` (token `:root` 7906–7962).

---

## 1. Shape of the app

A single-page admin shell. One left **rail** of tabs (three **drill-down folders** + flat tabs — see §3), a persistent **topbar**, and a swappable content area where exactly one `<section id="tab-…">` is visible at a time. On phones the rail is replaced by a bottom nav (`#rm-bottomnav`) that mirrors the rail via `data-go`.

- **One global JS scope** across 17 `NN-*.js` parts; load order matters.
- **One section visible at a time**; `goTab(tab)` switches and fires that tab's init.
- **No page reloads** — navigation is DOM show/hide.
- **34 sections** in the markup. Not all are rail destinations (see §3).

---

## 2. Global chrome (persistent on every section)

| Element | What it is | Notes |
|---|---|---|
| **Brand block** | Topbar, far left: `tacet` mark + wordmark · 1px hairline · **co-brand account logo** (`#brandLogoTop`, `applyBrand()`) | Lowercase `tacet` always. **Settled 2026-07-25** (`tacet-desktop-patterns.md` §1.1 / §1.1c). A 2026-07-24 amendment moved the brand to the rail; **that was reversed** — the rail's marks stay CSS-hidden and the topbar keeps the brand. Un-hiding the rail marks ships two wordmarks. Merchant logo box: max-height 24px, **min rendered height 14px, max width 210px**, scaled to fit, never cropped. No logo → no hairline, no placeholder. **Both marks show together — live `body.cobrand` (css:507–509) currently *swaps* them and that rule comes out at build.** Bar height **56px** (verified). |
| **Command palette** | `Ctrl/⌘+K` or the topbar **search field** (`#gsearch-trigger`) — keyword search over every page, panel, and individual setting | Built from the live DOM on open, so it self-syncs. `#gsearch-overlay`. The field is a **button shaped like an input** — it never takes a caret; the caret appears in the palette. Hint is platform-aware (⌘K / Ctrl K), never both. |
| **Inbox dropdown** | Topbar menu → **Reviews** (feat `reviews`) and **Feedback** (feat `feedback`) | Not in the rail; reached via `goTab()`. Unseen = **one 6px Sage dot, never a count, never red** (2026-07-25) — an unread review is not an emergency. Chime unchanged. |
| **Account menu** | Operator identity / sign-out | Team was promoted **out** of here into the rail on 2026-07-16. |
| **Language toggle** | Runtime EN ⇄ 中文 (`cuLang`, `onLangChange`) | **NOT global chrome — lives in the Profile iframe** (`#langToggle`, `backend-account.html:327`, wired `:1211`). Old topbar `#lang-toggle` was removed; `updateBtn`'s probe (`retail-admin.html:10699`) is dead code. One live language at a time. |
| **Theme toggle** | Light / dark (`#acctTheme` "Appearance", `retail-admin.html:965`) | **Inside the avatar dropdown `#acctMenu`, not a loose control.** Rides `:root[data-theme]`. The Profile iframe has **no** in-panel theme toggle (`backend-account.html:1194`). |
| **Sound toggle** | New-order chime mute (`#ntfSound`, `backend-account.html:456`) | **NOT global chrome — Profile → Notifications** (key `tacet-orders-sound-on`). Posts `fc-play-order-chime` to the parent when embedded. |
| **~~Live-poll dot~~** | *Does not exist as global chrome* | The only live indicator is the dashboard presence pill `#td-live` (`retail-admin.html:1455`) — **dashboard content, not shell.** `.tb-cluster:917` holds **only the Inbox**; the `:1202` / `:913` comments claiming it holds a live-poll dot + sound are **stale** — origin of this whole error. There is no `id="tb-cluster"` (grep: zero); the element is `class="tb-cluster"`. |
| **~~Sub-view strip~~** | *Retired from the topbar* (`#tb-subviews` ~881, `#tb-pu-subviews` ~892) | Sub-views live **in-page**, under the page header — house rule 2026-07-19 (`tacet-desktop-patterns.md` §1.1a row 2). The topbar mirrors retire as each section rebuilds. See §6. |
| **Rail-fold dot** | `#railSeamFold` — **top of the rail** as of 2026-07-24 | Replaced the old topbar hamburger, then moved off the topbar entirely. The **topbar itself is locked**: fixed height, no fold, no collapse. |
| **~~Page identity~~** | *Retired from the topbar 2026-07-25* | The crumb (`#tb-crumb`), the ⓘ mirror (`#tb-info-wrap`) and `#tb-page` all leave the bar. **Gated:** one CSS rule hides the in-content `<h2>` on **16 tabs** *because the crumb named them* (audit done 2026-07-25; Products/Purchasing hidden separately; meituan/guanyi/eleme deliberately excluded). **The crumb leaves and that rule is narrowed in the SAME change** — un-rebuilt pages fall back to a plain `<h2>` until their §1.7 header ships. Never one without the other. |

---

## 3. Navigation model — the rail

Rail order is set by inline `style="order:N"`. Only **three** groups remain (`marketing`, `loyalty`, `editor` — the last now **labelled `Content`**); Orders, Products, and Sales are now **flat buttons** — their dropdowns are gone.

> **Groups drill down; they do not fly out. Decided 2026-07-29 — `tacet-rail-drilldown-amendment.md` is the governing document.**
> Clicking a group **replaces the rail's own contents** with that group's children, under a combined back-row / title (`← Marketing`). One column, one level at a time, depth permanently one. The old flyout panel to the right of the rail is **retired** — remove its markup and CSS, do not leave it behind a flag.
> Three consequences live in this section: the group row is a **folder only** and loads no page; the rail **stays drilled** after a child is picked; and the rail **resolves its own level from the active section**, so palette jumps and cross-section drill-through arrive with the correct folder already open. See the map below.

> **Reading the labels below.** `Dashboard · 概览` is the **source** pair — two strings stored together. The screen renders **one** of them, never both (`tacet-desktop-patterns.md` §1.11). The rail shows `Dashboard` in EN or `概览` in 中文.

```
RAIL (top → bottom)                     order   tab id            gating
──────────────────────────────────────────────────────────────────────────
0  ★ Open your store · 开店引导            0     setup             none (display:none until needed)
1    Dashboard · 概览                      2     dashboard         dashboard:view
2    Reports · 报表                        3     reports           reports:view          ← NEW
3    Orders · 订单                         4     orders            orders:view           ← flat now
4    Delivery · 配送                       6     delivery          delivery:view
5    Sales · 销售                          8     sales             none                  ← flat now
6    Products · 产品                       9     products          products:view         ← flat now
7    Purchasing · 采购                     9  ⚠  purchasing        purchasing:view       ← order collision
8    Customers · 顾客                     10     customers         customers:view
9  ▸ Marketing · 营销                     11     (group)           —
        ├ Coupons · 优惠券                       vouchers          coupons:view
        ├ Flash sales · 秒杀                     flash             flash:view
        ├ Pop-ups · 弹窗                         popups            popups:view
        ├ Affiliate · 分销                       affiliate         affiliate:view + feat affiliate
        ├ Share cards · 分享卡片                  sharing           sharing:edit
        ├ Broadcasts · 广播                      broadcasts        broadcasts:view
        └ Social proof · 社交证明                 social            social:edit + feat socialProof
10 ▸ Loyalty & Wallet · 会员与钱包          12     (group)           —
        ├ Membership & points · 会员积分         membership        loyalty:view + feat membership
        ├ Top-up · 充值                          topup             topup:edit
        ├ Leaderboard · 排行榜                   leaderboard       leaderboard:edit
        └ Voting · 投票                          voting            voting:edit
11 ▸ Content · 内容                        14     (group)           —                     ← RENAMED 2026-07-29
        ├ Editor · 编辑器                        mini-app-editor   editor:view           ← was the group row
        ├ Copy · 文案                            snippets          content:view
        ├ About page · 关于页                     about             content:view
        ├ Media · 媒体库                          media             media:view
        ├ Legal pages · 法律条款                  legal             content:view
        └ FAQ & help · 常见问题                   faq               content:view + feat faq
12 ⚙ Settings · 设置                       15     config            any settings:* cap
13   Team · 团队                           16     team              none                  ← NEW 2026-07-16
     (brand credit)                        99     —                 hidden
──────────────────────────────────────────────────────────────────────────
TOPBAR (no rail entry):  Search · Inbox ▸ Reviews / Feedback · Account ▸ Profile / theme / Sign out    (Lang + Sound → Profile, not topbar; no live-poll dot — see §2)
SWAP-IN (no rail entry):  Product Page Editor (product-editor) — a link INSIDE the Mini App Editor swaps the same iframe. Under Content.
VIA SALES (no rail entry): Meituan · gzgrocery/Guanyi · Eleme — reached by salesGo()
BOTTOM NAV (phone):  Dashboard · Orders · Customers · Products · More
```

**Findings, recorded not fixed:**

- ⚠ **`order:9` collision** — Products and Purchasing both claim it. Resolution falls to DOM order. Fix during Batch 1.
- **Order gaps at 1, 5, 7, 13** — fossils of removed entries. Renumber on a clean 1..N during the rebuild.
- **Sales has no rail children.** Meituan / gzgrocery / Eleme sections exist but are reachable only from the Sales page via `salesGo(channel)`. This independently validates the Board archetype: channel cards route in; no rail entry needed.
- **Bottom nav ≠ v1 spec.** Live `PRIMARY = { dashboard, orders, customers, products }` + `__more__` (`retail-admin.html:11017`). `tacet-mobile-patterns.md` §1 specifies Home / Orders / **Inbox** / **Sales** / More. Two of five differ. The More sheet rebuilds from the live desktop nav on each open (`buildMore`, ~11041) — no hardcoded list — so it stays in sync by construction.

### 3.1 The Content rename — why the group could not stay called Editor

*Added 2026-07-29.* `Editor` was a group **and** a destination — the only one of the three with a page of its own, which broke the folder-loads-nothing rule. Its page moved inside it as an ordinary child. That left a folder named Editor whose first row was also an editor: **the word nested inside itself.** Renaming the parent removes the collision rather than asking the operator to hold both meanings.

**`Content · 内容`, not `Editorial`.** Rail labels are source pairs and both halves must work (§9, `tacet-desktop-patterns.md` §1.11). *Editorial* has no clean Chinese partner — `编辑` means *edit / editor*, which reinstates the exact collision in the Chinese view where nobody would catch it; `编辑部` is a newsroom department. `内容` is clean, and *Content* names five of the six children literally.

**Label only. Internal names do not change.** The rail group id stays `editor`, the tab id stays `mini-app-editor`, the capability strings stay `editor:view` / `content:view`. They are invisible to the merchant and load-bearing for the bottom-nav `data-go` mirror, CSS selectors and `TAB_CAP`. The command palette builds from the live DOM on open, so it picks up the new label with no work. **`tacet-editor-addendum.md` keeps its filename** — renaming it breaks every citation pointing at it.

**`editor:view` must move onto the new `Editor` child row in the same change.** A folder row holds no capability of its own; it only inherits the hide-if-empty rule (§7). If the cap does not move, the `/cms` embed ships ungated.

### 3.2 Rail level resolution — the child→parent map

*Added 2026-07-29. Load-bearing: this ships in the same change as the drill-down, or the rail reports the wrong place.*

Sections are reached from outside the rail — the ⌘K palette, Dashboard tiles, `salesGo()`, Orders ⇄ Customers, a reload on a deep link. In every case the rail must **already be at the right level on arrival**. `goTab()` consults this map on every switch. Where the active tab has no rail row, the rail resolves to the **nearest ancestor that has one**; where there is none, to **root with nothing highlighted**.

```
CHILD TAB          →  RAIL LEVEL         ACTIVE ROW
─────────────────────────────────────────────────────────
vouchers flash popups affiliate
sharing broadcasts social
                   →  marketing          (itself)
membership topup leaderboard voting
                   →  loyalty            (itself)
mini-app-editor    →  editor (Content)   Editor
snippets about media legal faq
                   →  editor (Content)   (itself)
product-editor     →  editor (Content)   Editor      ← iframe swap; row does not change
dashboard reports orders delivery sales
products purchasing customers config
team setup         →  root               (itself)
meituan guanyi eleme
                   →  root               Sales       ← rail-less, reached by salesGo()
reviews feedback   →  root               (nothing)   ← Inbox lives in the topbar
```

**`product-editor` does not move the rail.** A link inside the Mini App Editor swaps the same iframe — same tab, same page, different editor. The `Editor` row stays lit throughout. `09-products.js` is where its *code* lives, not where its *entrance* is; do not read the §4 file listing as a route. (An earlier draft filed it at root/Products on exactly that misreading.)

---

## 4. Section inventory — 34

Grouped by function. "Skin" flags surfaces carrying something that is **per-business configuration, not product structure** — currency, time zone, channels, carriers, payment methods, loyalty tier names, language pairs. **`money` means the surface renders amounts and therefore depends on the business's currency; it is not a claim that the currency is ¥** (`docs/tacet-consolidation-decisions.md` §0).

### RUN — daily operations
| Section | tab id | line | Source | Skin? |
|---|---|---|---|---|
| Dashboard | `dashboard` | 1258 | `03-dashboard.js` | The Recap, money, loyalty tier names |
| Reports **(new)** | `reports` | 1684 | `03-dashboard.js` | money · cites `reference/reports-ai-mockup.html` (absent from box) |
| Orders | `orders` | 1847 | `04-orders.js` | money, carriers, **fapiao (absorbed)** |
| Delivery | `delivery` | 5246 | `06-delivery.js` | China carriers · `data-dlv="hub"` |
| Purchasing | `purchasing` | 9653 | `16-purchasing.js` | shell only — hosts `#prod-view-purchasing` |

### SELL — channels & catalog
| Section | tab id | line | Source | Skin? |
|---|---|---|---|---|
| Sales (channel overview) | `sales` | 9332 | `01-core.js` + `15-integrations.js` | China channels |
| Meituan | `meituan` | 9527 | `11-meituan.js` | **China-only** |
| gzgrocery / Guanyi | `guanyi` | 9667 | `12-guanyi.js` | **China-only (account ERP)** |
| Eleme | `eleme` | 9936 | `14-eleme.js` | **China-only** |
| Products | `products` | 3156 | `09-products.js` | money · hosts 3 sub-views |
| Customers | `customers` | 2313 | `08-customers.js` | money, loyalty tier names |

### MARKET — promotion & retention
| Section | tab id | line | Source | Skin? |
|---|---|---|---|---|
| Coupons | `vouchers` | 3906 | `05-marketing.js` | money |
| Flash sales | `flash` | 4136 | `05-marketing.js` | money |
| Pop-ups | `popups` | 4393 | `05-marketing.js` | — |
| Affiliate | `affiliate` | 6696 | `05-marketing.js` | feat `affiliate` |
| Share cards | `sharing` | 6675 | `05-marketing.js` | WeChat framing · has `.sc-spreview` preview pane |
| Broadcasts | `broadcasts` | 4912 | `05-marketing.js` | WeChat/SMS |
| Social proof | `social` | 8893 | `05-marketing.js` | feat `socialProof` |
| Membership & points | `membership` | 7362 | `05/10` | feat `membership`, money |
| Top-up (wallet) | `topup` | 6501 | `10-extras.js` | money, payment methods |
| Leaderboard | `leaderboard` | 7084 | `10-extras.js` | — |
| Voting | `voting` | 7427 | `10-extras.js` | — |

### CONTENT — online store editing
*Rail label since 2026-07-29: **`Content · 内容`**. The `Editor` row inside it is the Mini App Editor, promoted out of the old group row (§3.1).*
| Section | tab id | line | Source | Skin? |
|---|---|---|---|---|
| Mini App Editor (embeds `/cms`) | `mini-app-editor` | 10026 | `07-content-billing.js` | WeChat framing · `.tab-embed-editor` |
| Product Page Editor (swap-in) | `product-editor` | 10029 | `09-products.js` | `.tab-embed-editor` · **entered only from inside the Mini App Editor — this file is where its code lives, not a route** |
| Copy / snippets | `snippets` | 4375 | `07-content-billing.js` | bilingual copy |
| About page | `about` | 7723 | `07-content-billing.js` | brand story |
| Media library | `media` | 7552 | `07-content-billing.js` | — |
| Legal pages | `legal` | 9173 | `07-content-billing.js` | jurisdiction |
| FAQ & help | `faq` | 9262 | `07-content-billing.js` | feat `faq` |

### SET UP — configuration & people
| Section | tab id | line | Source | Skin? |
|---|---|---|---|---|
| Settings (+ Operations, Quick Stock) | `config` | 7937 | `02-settings-ops.js` | payments, region, carriers |
| Team **(new)** | `team` | 10043 | `02-settings-ops.js` | RBAC roles · promoted from account menu 2026-07-16 |
| Open your store (setup guide) | `setup` | 1253 | `17-setup-guide.js` | onboarding |

### INBOX — topbar, not rail
| Section | tab id | line | Source | Skin? |
|---|---|---|---|---|
| Reviews | `reviews` | 6925 | `10-extras.js` | feat `reviews` |
| Feedback | `feedback` | 7006 | `10-extras.js` | feat `feedback` |

---

## 5. What changed since v1

### Retired into a parent (3) — do not recreate as tabs

| v1 section | Where it went | Evidence |
|---|---|---|
| **Invoices** (`tab-invoices`) | **Orders.** Fapiao requests are a status filter on the Orders list; `renderInvoiceBlock` and Copy-for-accounting live in the order drawer; the unseen badge covers new orders **and** new fapiao requests. | `04-orders.js:1131` "fapiao requests live on this tab now too" · `:325` · `retail-admin.html:1845`, `:1047` · `03-dashboard.js:2745` calls it "the retired" tab |
| **Activity** (stock ledger) | **Products** sub-view `#prod-view-activity` | `prodShowView('activity')` · `#stk-views` ~3185 |
| **Categories** | **Products** sub-view `#prod-view-categories` | `retail-admin.html:3850` · `prodShowView('categories')` |

This is the same consolidation v1 already recorded for *Channels → Sales* and *Content → Editor*. The IA is still consolidating; expect more.

### Shipped new (2)

- **Reports** (`tab-reports`, order:3) — range bar (Today/7d/30d/90d + custom dates + store filter) → **chapter rail** (Overview · Sales · Customers · Products & traffic) → KPI strip → **The read** (the AI's plain-words analysis) → charts. Shares `03-dashboard.js`; chart container ids are deliberately unchanged so the phone dashboard's `rmRenderDash` clone-by-id keeps working. Chapters only show/hide wrappers.
- **Team** (`tab-team`, order:16) — stats → **`tm-enforce`** master switch (sage when on) → member list with role pills (owner / staff / op) + per-member Edit → Add member. Carries its own `:root` block from `backend-team.html` (`retail-admin.html:10041`).

### Flattened (3)
Orders, Products, and Sales lost their `nav-parent` dropdowns. Orders' child (Invoices) was absorbed; Products' children (Categories, Purchasing) became sub-views or a flat tab; Sales' children moved behind `salesGo()`.

### Gating drift

**`TAB_CAP` orphans (3)** — capabilities for sections that no longer exist: `categories`, `activity`, `integrations`. `categories` and `activity` are still *used* as `data-cap` on the Products sub-view strips (`#tb-subviews`, `#stk-views`), so they must be **kept** even though their tabs are gone. `integrations` has no consumer — delete.

**Ungated sections (4)** — `setup`, `sales`, `team`, `product-editor` have no `TAB_CAP` entry. `applyCapGates` does `if (cap === undefined) return`, so they are **always visible to every operator**. With RBAC going live, **Team being ungated is a security-relevant gap**: any operator could reach the page that assigns roles. Assign caps before `tm-enforce` ships.

**Feature flags (8)** — v1 knew 6. Live: `affiliate`, `faq`, `feedback`, `membership`, `reviews`, `socialProof`, **`kitchenAdd`** (new), **`quickStock`** (new). The last two gate controls, not sections. v1 stated Quick Stock had no flag; it now does.

### Live bug
`retail-admin.html:1529` — `<button onclick="goTab('activity')">Stock activity › · 前往库存动态 ›</button>`. `tab-activity` no longer exists. This dashboard link is dead. Should be `goTab('products')` + `prodShowView('activity')`.

---

## 6. Sub-views — a tab inside a page

Four surfaces host content that swaps under one page. This is now a first-class IA pattern, not an accident, and `tacet-desktop-patterns.md` §1.7 governs its two forms.

| Host | Strip | Swaps between | Mechanism |
|---|---|---|---|
| **Products** | `#stk-views` (~3185) + `#tb-subviews` (~881, topbar mirror) | Products · Activity · Categories · Purchasing | `prodShowView()` |
| **Reports** | `#db-chtabs` | Overview · Sales · Customers · Products & traffic | show/hide `.db-chapter` |
| **Orders** | status chip strip | all orders ⇄ fapiao requests ⇄ refund queue | `setOrderStatus()` — a **filter**, not a sub-view |
| **Sales** | channel cards | → Meituan / Guanyi / Eleme sections | `salesGo()` — routes to a real section |

**Purchasing is both.** `<section id="tab-purchasing">` (9653) is a shell; the comment at 9657 says the outer section "is only what tab-switching needs" — the content is `#prod-view-purchasing`. So Purchasing is a rail tab *and* a Products sub-view, rendering the same markup.

---

## 7. Gating model — three independent axes

A section renders only if it passes **all** of:

1. **Capability (RBAC)** — `TAB_CAP[tab]` → a capability string (or array = any-of). `applyCapGates()` hides the rail tab **and** the bottom-nav entry, then collapses a group whose children are all hidden. Generic hook: any control tagged `data-cap="x"` (or `"x y"` = any-of) hides for operators lacking it.
   **Status: `CAPS = null` ⇒ everything allowed (dark launch).** The Team page's `tm-enforce` switch is the intended off-ramp from dark launch. **Confirmed going live** — every page needs a designed gated state (`tacet-desktop-patterns.md` §1.9).
   **Folder counting — added 2026-07-29 (§3).** Count a group's visible children **after all three gates**, on every gate pass: **0 → the group row is absent entirely** (no chevron, no disabled row — already the live behaviour); **1 → the group flattens into a direct button to that child**, showing the *child's* label with the *parent's* icon, so the operator clicks once and the folder never existed for them; **2+ → folder, as designed.** A folder holding one item is two clicks to reach one page and advertises six things the operator may not have.
2. **Feature flag (plan/account)** — `data-feat="X"` + `body.feat-X`; `body:not(.feat-X) [data-feat="X"]{display:none}`. A `.feat-off` styling state exists (`retail-admin.css:3265`).
3. **Data preconditions** — the store filter appears with 2+ stores; the store-printer picker with 2+ printers; the setup tab hides at 100%; alert tiles self-hide when their queue is empty.

Feature on/off also lives on each feature's own page (an enable switch), with an Operations sub-panel in Settings.

---

## 8. Cross-section flows

- **Dashboard → everywhere**: activity rows and tiles open the order drawer, customer drawer, product editor, Feedback, or a channel tab in place.
- **Dashboard → Reports**: share `03-dashboard.js`; Reports' chart ids are load-bearing for the phone dashboard's clone-by-id.
- **Orders ⇄ Customers**: order drawer → customer record; customer record → their orders.
- **Orders ⊃ Invoices**: fapiao is a status filter + a drawer block. No separate destination.
- **Products ⊃ Activity / Categories / Purchasing**: `prodShowView()`, mirrored by the topbar strip.
- **Sales → channel admin**: `salesGo(channel)` clicks the (rail-less) child tab and fires its init.
- **Content hosts one editor with two faces**: the Mini App Editor (`/cms` embed) is the tab's landing view; **a link inside it swaps the same iframe** to the Product Page Editor via `showProductSection` / postMessage. Same tab, same page, same iframe — only the contents change. **There is no independent route to `product-editor`**; it cannot be reached except from inside the Mini App Editor, and the rail's `Editor` row stays lit throughout (§3.2). *Corrected 2026-07-29 — the previous wording said the two "swap under one tab," which is mechanically true but reads as two peer doors.*
- **Command palette** jumps to any tab *or any individual setting card* — every setting card needs a stable id.

---

## 9. Structural vs. skin

**Keep (structure):** the rail-order + group model (**how a group *presents* — flyout vs drill-down — is skin; which children it *holds* is structure**), one-section-at-a-time, the bottom-nav mirror, the 3-axis gating model, the topbar pattern, section *functions*, the sub-view pattern, cross-section drill-through, the `/sales/summary` + `channel-status` card contract.

**Per-business configuration, not brand — and NOT settled infrastructure:** currency (`¥` is Roots' currency, hardcoded today) · time zone (UTC+8 is Roots' zone) · channels (WeChat mini-app, Meituan, Eleme, Guanyi are Roots' channels) · payments (WeChat Pay / Alipay / fapiao) · carriers (JD, 快递100, GZ rider, Air/Land split) · store names · loyalty tier names · **language**.

**On language specifically:** the `EN · 中文` label **pairs** in source and the " · " splitter that picks one at render (`data-no-i18n` opts out; one language on screen, never both — `tacet-desktop-patterns.md` §1.11) are the *current mechanism*, not a settled contract. `docs/tacet-consolidation-decisions.md` §0 makes language per business: English-plus-Chinese may not be assumed, a single-language business must not be forced to supply two names for everything, and a business using two other languages must be supported. **A plan for scaling languages is an open question, not a solved one** — do not cite this line as evidence the two-language mechanism is finished.

**Tacet skin (governed elsewhere):** all colour/type/motion/composition rules come from `tacet-design-system.md` + `tacet-desktop-patterns.md`. The live `--td-*` `:root` block (`retail-admin.css:7906–7942`) is the token contract. The dashboard's editorial slot is **The Recap**; the automation library is **Arrangements**; the AI's period analysis is **The read**.

**Dead — never reintroduce:** the Full Circle visual identity in any form. The test for any rule is *"does `tacet-design-system.md` say it?"* — not *"did the reference build do it?"* See `tacet-desktop-patterns.md` §8.

---

## 10. Section → archetype

Composition is governed by `tacet-desktop-patterns.md`. The map lives there (§4), one row per section, all 34, seven archetypes.

---

## 11. Satellite apps — real surfaces, outside the 34

**Added 2026-07-19.** Some surfaces are complete applications that do not ride the shell:
own document, own `:root`, own i18n, reached from the shell but not part of it. Three
surveys missed the Profile app because this category did not exist. It does now.
The 34-section count is unchanged — satellites are not sections.

| Satellite | Route / file | Reached via | Notes |
|---|---|---|---|
| **Profile** | `/backend/account` · `backend-account.html` | Avatar menu `#acctProfileBtn` → `#profModal`/`#profFrame` (also serves standalone; `html.embedded` when framed) | Surveyed 2026-07-18 (`survey-account-profile.md`). Four panes: My Info · Security · Devices · Notifications. |
| **Login** | `/backend/login` · `backend-login.html` | Signed-out redirect | Not surveyed. Hosts the 2FA which-channel step. |

**Profile — what the survey established (recorded, not fixed):**

- **Own `:root`, brand-correct values, its own token names** — not the `--td-*` contract,
  and **light-first** where the shell is dark-first. Fold-vs-keep is an open decision
  (`tacet-desktop-patterns.md` §10).
- **Own i18n** — paired `.en`/`.cn` spans + `L(en, cn)`, no DOM walker, no glue risk.
  Shares the language key with the shell but neither side tells the other about changes
  while running.
- **The frozen-frame gap** — `#profFrame.src` is set once, first open, never reloaded;
  state is kept across close/reopen; the parent posts nothing down. Theme or language
  changed after first open never reaches the frame until a full reload. Real coupling
  gap, fix owed.
- **Legacy names load-bearing** — storage key `roots-admin-lang` (shared with the shell)
  and `fc-*` postMessages. Renaming the key silently resets every operator's saved
  language unless migrated. Decision, not hygiene.
- **External dependency** — the frame loads Fraunces/Inter/Noto Sans SC from Google Fonts
  independently of the shell. Mainland reachability risk; check how the shell sources
  fonts before deciding.
- **Auth surface** — password (min 10, disables while working) · 2FA email + SMS toggles
  (both can be on; +86 only for SMS; no confirm step) · sessions (per-row revoke has no
  confirm, bulk does; own sessions only — team-wide devices live in Manage team).
- **Cross-frame contract** — up: `fc-profile-updated` (name/avatar only) ·
  `fc-play-order-chime` · `profile-modal-close`. Down: nothing.
- **Rot** — `.acc-*` styling block with no markup (removed access view) · `.who-role`
  styled, never populated · uppercase via CSS on section headers (§1.6 violation) ·
  no focus trap in either layer.

Its archetype (**A4 Console**) and its place in the build order are recorded in
`tacet-desktop-patterns.md` §4, alongside the 34.

---

*v2.0 · 2026-07-16 · surveyed from `/root/roots-v2` · supersedes v1 entirely. Companion per-section maps (`tacet-orders.md` and siblings) are **stale as of v1** and must be re-surveyed before use as parity baselines.*

*v2.3 changes, 2026-07-25 (later): survey corrections — bar height 56px verified, `body.cobrand` swap recorded as a deliberate change, and the `<h2>` gate re-scoped to 16 tabs with the CSS-narrowing path. See `tacet-desktop-patterns.md` §1.1c.*

*v2.2 changes, 2026-07-25: §2 global chrome rewritten to the settled five-item topbar — brand block · search field · inbox · avatar, plus `#profModal` as portal markup. The 2026-07-24 brand-to-rail move is recorded as reversed. Sub-view strip and page identity marked retired from the bar, the latter gated on the owed `<h2>` audit. Section count unchanged; no section added or removed.*

*v2.1 changes, 2026-07-19: §11 added — satellite apps (Profile, Login), a category the 34-section map never had, which is why three surveys were structurally blind to Profile. The 34-section count is unchanged; satellites are recorded outside it. Section count and everything else from v2.0 stands.*
