# Tacet admin — IA blueprint

**v2.6 · §§1, 4, 5, 10, 11 reconciled against the live rail 2026-09-06 (see below); the 2026-07-16 survey had drifted. v2.5 · header line reversed 2026-07-31 (see below). §§1, 3, 4, 7, 8, 9 amended 2026-07-29 (rail drill-down + Content rename). §2 amended 2026-07-25 (survey-corrected). Surveyed 2026-07-16 from `/root/roots-v2` (roots-v2-hk), not from v1 of this document.**

> ## 🔴 v2.6 changes, 2026-09-06 — reconciled against the live rail. The section count was wrong by eight.
>
> **What was done.** `public/retail-admin.html` was re-enumerated at `2d15500`: every `data-tab` button in the rail, every `<section id="tab-*">`, and the topbar Inbox entries. §4 was reconciled against that enumeration. **Nothing recorded in §4 has disappeared from the code** — all 34 sections v2 found still exist. Eight more had landed and were never recorded.
>
> **The count is now 42, not 34.** Added to §4: **Finance**, **Materials**, **Recipes**, **Waste**, **New order**, **One material**, **One recipe** (all RUN) and **Shop menu** (SELL). Their landing commits and dates are in §5, *Shipped since the v2.5 survey*.
>
> **🔴 EVERY LINE NUMBER IN §4 HAD DRIFTED — ALL 34 OF THEM.** Not one row's `line` column still pointed at its section. The drift runs from +323 (Setup) to +2,468 (Team); the further down the file a section sits, the further its citation had moved. The prose beside those numbers was still true. **This is the house rule in `docs/tacet-consolidation-decisions.md` doing exactly what it warns about: a line number in a dated document is a historical coordinate, not a current position.** Every row's `line` column has been re-measured at `2d15500` and will drift again — re-verify before quoting one.
>
> **What was NOT done, deliberately.** **No archetype is assigned to any of the eight new sections.** The `Section → archetype` map in §10 lives in `tacet-desktop-patterns.md` §4 and still holds 34 rows; assigning the missing eight is a design decision and is not this reconciliation's to make. §10's cross-reference now says so instead of claiming the map is complete. `tacet-desktop-patterns.md` was not edited by this pass.
>
> **Also corrected, as live cross-references rather than rewrites:** §1's section count · §3's "Sales has no rail children" list (Shop menu joins the three channel admins) · §5's *Ungated sections* count · §5's *Live bug*, whose `goTab('activity')` entry is no longer in the tree · §10 and §11's "all 34" · §11 gains the **Counter till** rail row, which is a satellite by that section's own definition and appeared nowhere in this document.
>
> **Nothing dated was rewritten.** The v2/v2.1/v2.4/v2.5 records of what was true in July stand as written, including the sentence in *Why v2 exists* that says there are 34 — that was the true count when it was written. Where a July finding has since been overtaken, the amendment is added beside it and dated, not substituted for it.

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

A single-page admin shell. One left **rail** of tabs (three **drill-down folders** + flat tabs — see §3), a persistent **topbar**, and a swappable content area where exactly one `<section id="tab-…">` is visible at a time. ~~On phones the rail is replaced by a bottom nav (`#rm-bottomnav`).~~ **REMOVED 2026-08-24.** Phones have been served Tacet Mobile (`public/m.html`) since 2026-07-12 (`a19b70af`), so every `≤720px` layer inside `retail-admin` was unreachable from a phone; all of them are deleted. The shell has one navigation surface now: the rail, at every width.

- **One global JS scope** across 17 `NN-*.js` parts; load order matters.
- **One section visible at a time**; `goTab(tab)` switches and fires that tab's init.
- **No page reloads** — navigation is DOM show/hide.
- **42 sections** in the markup (v2.6, re-enumerated 2026-09-06; it was 34 at the 2026-07-16 survey). Not all are rail destinations (see §3) — eight are sub-pages or channel admins with no rail row of their own.

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

**Amended 2026-09-06 (v2.6), from the re-enumeration.** The three findings above have been overtaken; the July text stands as the record of what was true then, and this is what the rail shows now:

- **The `order:9` collision is now five-way, and there is a second one at `order:8`.** Full list in §5, *Live bug*. The July finding named two tabs; three more have joined that value since, and the till/Sales/Finance trio collides at 8.
- **`VIA SALES` gains a fourth: `shop-menu`.** A shop's menu is a sub-page of Sales → Locations under the same §1.7a takeover (`RAIL_STANDIN` in `01-core.js`), so the Sales row stays lit. The Board-archetype reading in the July finding is unaffected.
- **The `BOTTOM NAV (phone)` row in the map above is dead.** §1 records the removal (2026-08-24, phones get `m.html`); the map was not updated with it. There is no bottom-nav markup in `retail-admin.html` at `2d15500` — the only surviving trace is a comment at `:1392` that still calls the `data-go` mirror load-bearing. The *Bottom nav ≠ v1 spec* finding above is therefore moot for this shell and now belongs to `tacet-mobile-patterns.md`.
- **Two rail rows carry no `data-tab` and so appear nowhere in this map:** `#setup-nav` (which does have one — `setup` — but is `display:none` until setup finishes) and `#rail-till`, the **Counter till**, which opens `/till` in a new tab and is a satellite, not a section. It is now recorded in §11.

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

## 4. Section inventory — 42

Grouped by function. "Skin" flags surfaces carrying something that is **per-business configuration, not product structure** — currency, time zone, channels, carriers, payment methods, loyalty tier names, language pairs. **`money` means the surface renders amounts and therefore depends on the business's currency; it is not a claim that the currency is ¥** (`docs/tacet-consolidation-decisions.md` §0).

> **🔴 Every `line` value below was re-measured at `2d15500` on 2026-09-06 and every one of them had moved** — the July figures were wrong by between +323 and +2,468 rows. They will drift again on the next build that touches the file. **Re-grep before quoting one**; the house rule is at the head of `docs/tacet-consolidation-decisions.md`. The `tab id` is the stable handle — use it.
>
> **Rows marked (v2.6)** were added by the 2026-09-06 reconciliation and carry **no archetype** in §10 / `tacet-desktop-patterns.md` §4. That is deliberate and is not an oversight to close casually — see §10.

### RUN — daily operations
| Section | tab id | line | Source | Skin? |
|---|---|---|---|---|
| Dashboard | `dashboard` | 1581 | `03-dashboard.js` | The Recap, money, loyalty tier names |
| Reports **(new)** | `reports` | 2057 | `03-dashboard.js` | money · cites `reference/reports-ai-mockup.html` (absent from box) |
| Orders | `orders` | 2219 | `04-orders.js` | money, carriers, **fapiao (absorbed)** |
| New order **(v2.6)** | `orders-new` | 2825 | `04-orders.js` | money · **no rail row** — a sub-page of Orders under the §1.7a takeover (`RAIL_STANDIN`), so the Orders row stays lit |
| Delivery | `delivery` | 6747 | `06-delivery.js` | China carriers · `data-dlv="hub"` |
| Purchasing | `purchasing` | 12001 | `16-purchasing.js` | shell only — hosts `#prod-view-purchasing` |
| Finance **(v2.6)** | `finance` | 11486 | `22-finance.js` | money · two sub-views (Summary · Transactions) · **no store filter, deliberately** (§36 — neither ledger table carries a location) |
| Materials **(v2.6)** | `materials` | 12021 | `18-materials.js` | money · `data-feat="production"` |
| One material **(v2.6)** | `materials-record` | 12025 | `18-materials.js` | money · **no rail row** — sub-page of Materials, same takeover |
| Recipes **(v2.6)** | `recipes` | 12051 | `19-recipes.js` | money · `data-feat="production"` — same switch as Materials, no second `FEATURE_CATALOG` entry |
| One recipe **(v2.6)** | `recipes-record` | 12080 | `19-recipes.js` | money · **no rail row** — sub-page of Recipes, same takeover |
| Waste **(v2.6)** | `waste` | 12063 | `20-waste.js` | money · `data-feat="waste"` — its **own** switch, not Production's (§32) |

### SELL — channels & catalog
| Section | tab id | line | Source | Skin? |
|---|---|---|---|---|
| Sales (channel overview) | `sales` | 11636 | `01-core.js` + `15-integrations.js` | China channels |
| Meituan | `meituan` | 11900 | `11-meituan.js` | **China-only** · no rail row — via `salesGo()` |
| gzgrocery / Guanyi | `guanyi` | 12135 | `12-guanyi.js` | **China-only (account ERP)** · no rail row — via `salesGo()` |
| Eleme | `eleme` | 12404 | `14-eleme.js` | **China-only** · no rail row — via `salesGo()` |
| Shop menu **(v2.6)** | `shop-menu` | 12074 | `28-shops.js` | money · **no rail row** — sub-page of Sales → Locations (§41/§42), same takeover |
| Products | `products` | 4425 | `09-products.js` | money · hosts 3 sub-views |
| Customers | `customers` | 3024 | `08-customers.js` | money, loyalty tier names |

### MARKET — promotion & retention
| Section | tab id | line | Source | Skin? |
|---|---|---|---|---|
| Coupons | `vouchers` | 5356 | `05-marketing.js` | money |
| Flash sales | `flash` | 5604 | `05-marketing.js` | money |
| Pop-ups | `popups` | 5861 | `05-marketing.js` | — |
| Affiliate | `affiliate` | 8214 | `05-marketing.js` | feat `affiliate` |
| Share cards | `sharing` | 8193 | `05-marketing.js` | WeChat framing · has `.sc-spreview` preview pane |
| Broadcasts | `broadcasts` | 6407 | `05-marketing.js` | WeChat/SMS |
| Social proof | `social` | 11028 | `05-marketing.js` | feat `socialProof` |
| Membership & points | `membership` | 9168 | `05/10` | feat `membership`, money |
| Top-up (wallet) | `topup` | 8019 | `10-extras.js` | money, payment methods |
| Leaderboard | `leaderboard` | 8890 | `10-extras.js` | — |
| Voting | `voting` | 9233 | `10-extras.js` | — |

> **These eleven are ONE doc group but TWO rail folders.** The rail splits them: `data-group="marketing"` (*Marketing · 营销*, `order:11`) holds Coupons · Flash sales · Pop-ups · Affiliate · Share cards · Broadcasts · Social proof, and `data-group="loyalty"` (*Loyalty & wallet · 会员与钱包*, `order:12`) holds Membership & points · Top-up · Leaderboard · Voting. §3's rail map has always drawn them as two; this table's single MARKET heading is the doc's own functional grouping, not a rail group name. Recorded 2026-09-06 so the two are not read as contradicting each other.

### CONTENT — online store editing
*Rail label since 2026-07-29: **`Content · 内容`**. The `Editor` row inside it is the Mini App Editor, promoted out of the old group row (§3.1).*
| Section | tab id | line | Source | Skin? |
|---|---|---|---|---|
| Mini App Editor (embeds `/cms`) | `mini-app-editor` | 12482 | `07-content-billing.js` | WeChat framing · `.tab-embed-editor` |
| Product Page Editor (swap-in) | `product-editor` | 12485 | `09-products.js` | `.tab-embed-editor` · **entered only from inside the Mini App Editor — this file is where its code lives, not a route** |
| Copy / snippets | `snippets` | 5843 | `07-content-billing.js` | bilingual copy |
| About page | `about` | 9529 | `07-content-billing.js` | brand story |
| Media library | `media` | 9358 | `07-content-billing.js` | — |
| Legal pages | `legal` | 11308 | `07-content-billing.js` | jurisdiction |
| FAQ & help | `faq` | 11397 | `07-content-billing.js` | feat `faq` |

### SET UP — configuration & people
| Section | tab id | line | Source | Skin? |
|---|---|---|---|---|
| Settings (+ Operations, Quick Stock) | `config` | 9775 | `02-settings-ops.js` | payments, region, carriers |
| Team **(new)** | `team` | 12499 | `02-settings-ops.js` | RBAC roles · promoted from account menu 2026-07-16 |
| Open your store (setup guide) | `setup` | 1576 | `17-setup-guide.js` | onboarding |

### INBOX — topbar, not rail
| Section | tab id | line | Source | Skin? |
|---|---|---|---|---|
| Reviews | `reviews` | 8650 | `10-extras.js` | feat `reviews` |
| Feedback | `feedback` | 8812 | `10-extras.js` | feat `feedback` |

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

- **Reports** (`tab-reports`, order:3) — range bar (Today/7d/30d/90d + custom dates + store filter) → **chapter rail** (Overview · Sales · Customers · Products & traffic) → KPI strip → **The read** (the AI's plain-words analysis) → charts. Shares `03-dashboard.js`; chapters only show/hide wrappers. (The phone dashboard that cloned these container ids was deleted 2026-08-24 — phones get `m.html`.)
- **Team** (`tab-team`, order:16) — stats → **`tm-enforce`** master switch (sage when on) → member list with role pills (owner / staff / op) + per-member Edit → Add member. Carries its own `:root` block from `backend-team.html` (`retail-admin.html:10041`).

### Shipped since the v2.5 survey (8)

*Added 2026-09-06 (v2.6).* Eight sections landed after the 2026-07-16 survey and were never recorded here. Dates and SHAs are from `git log -S'<section id="tab-…">' -- public/retail-admin.html`, oldest first — **the commit that introduced the section markup**, not the last one to touch it.

| Section | tab id | Landed | Commit | Rail row? |
|---|---|---|---|---|
| New order | `orders-new` | 2026-07-30 | `a95eebf2` — *New order gets its container: the takeover the detail view left behind* | No — sub-page of Orders |
| Materials | `materials` | 2026-08-24 | `e6f6c456` — *Materials: the ingredients table, wearing a name every trade can read* | Yes · `order:9` · feat `production` |
| One material | `materials-record` | 2026-08-24 | `e6f6c456` — same commit | No — sub-page of Materials |
| Recipes | `recipes` | 2026-08-25 | `1cd5b4d7` — *Recipes screen (step 4): retail-admin list + full-page record* | Yes · `order:9` · feat `production` |
| One recipe | `recipes-record` | 2026-08-25 | `1cd5b4d7` — same commit | No — sub-page of Recipes |
| Waste | `waste` | 2026-08-27 | `33f4d4a4` — *The Waste screen: a ledger you can add one line to* | Yes · `order:9` · feat `waste` |
| Finance | `finance` | 2026-09-02 | `2ca061d3` — *Finance Summary — the money staircase (§36)* | Yes · `order:8` |
| Shop menu | `shop-menu` | 2026-09-05 | `0813e24d` — *Shops and shop listings: the record, the code, the join, and the screen — read by nothing yet* | No — sub-page of Sales → Locations |

**`orders-new` predates the v2.5 bump by one day** and was missed by it as well as by the survey — v2.5 only reversed the header line and re-surveyed nothing. It is listed here rather than under *Shipped new* because *Shipped new (2)* is the July record and is not to be rewritten.

**Four of the eight carry no rail row of their own.** They are §1.7a takeovers: a full-page child that replaces the parent's content while `RAIL_STANDIN` (`01-core.js`) keeps the parent's rail row lit. That pattern is why the section count and the rail-row count are different numbers, and it is the same mechanism the Product Page Editor has used since v2.

### Flattened (3)
Orders, Products, and Sales lost their `nav-parent` dropdowns. Orders' child (Invoices) was absorbed; Products' children (Categories, Purchasing) became sub-views or a flat tab; Sales' children moved behind `salesGo()`.

### Gating drift

**`TAB_CAP` orphans (3)** — capabilities for sections that no longer exist: `categories`, `activity`, `integrations`. `categories` and `activity` are still *used* as `data-cap` on the Products sub-view strips (`#tb-subviews`, `#stk-views`), so they must be **kept** even though their tabs are gone. `integrations` has no consumer — delete.

**Ungated sections (4)** — `setup`, `sales`, `team`, `product-editor` have no `TAB_CAP` entry. `applyCapGates` does `if (cap === undefined) return`, so they are **always visible to every operator**. With RBAC going live, **Team being ungated is a security-relevant gap**: any operator could reach the page that assigns roles. Assign caps before `tm-enforce` ships.

> **Amended 2026-09-06 (v2.6): it is eight, not four.** The four above are unchanged and `team` is still ungated. The four sections added since carry no `TAB_CAP` entry either: **`orders-new`, `materials-record`, `recipes-record`, `shop-menu`**. All four are §1.7a sub-pages, so the practical exposure is narrower than Team's — each is reached through a parent that *is* gated (`orders:view`, `materials:view`, `recipes:view`, and `sales`, itself ungated) — but `applyCapGates` keys off `data-tab` and none of the four has one, so **nothing in `TAB_CAP` can gate them whatever is decided**. A sub-page's gate has to be the parent's, or `data-cap` on its own controls. Recorded, not fixed. The four sections added *with* caps are Finance (`finance:view`), Materials (`materials:view`), Recipes (`recipes:view`) and Waste (`waste:view`) — all present in `TAB_CAP` and all backed by `lib/capabilities.js`, where they sit in `group: 'run'`.

**Feature flags (8)** — v1 knew 6. Live: `affiliate`, `faq`, `feedback`, `membership`, `reviews`, `socialProof`, **`kitchenAdd`** (new), **`quickStock`** (new). The last two gate controls, not sections. v1 stated Quick Stock had no flag; it now does.

### Live bug
`retail-admin.html:1529` — `<button onclick="goTab('activity')">Stock activity › · 前往库存动态 ›</button>`. `tab-activity` no longer exists. This dashboard link is dead. Should be `goTab('products')` + `prodShowView('activity')`.

**✅ Closed 2026-09-06 (v2.6).** No longer in the tree: at `2d15500` there is no `goTab('activity')` anywhere under `public/`, and no *Stock activity ›* button. The July entry stands as the record of a real defect that has since been fixed. Line 1529 today is an unrelated comment about the Team tab — another line-number drift, and the reason this entry could not be checked by looking where it pointed.

**🔴 Open, found by the 2026-09-06 re-enumeration — duplicate `order:` values in the rail.**

CSS `order` ties resolve to DOM order, so the rail *renders* deterministically today. That is the trap: the visual result looks intentional, and any future reorder that moves one of these buttons in the markup silently reorders the rail with no CSS change to explain it. Two collisions, seven rows:

| `order:` | Rows sharing it | Rendered order today (DOM) |
|---|---|---|
| **8** | `sales` · `rail-till` *(no `data-tab`)* · `finance` | Sales → Counter till → Finance |
| **9** | `products` · `purchasing` · `materials` · `recipes` · `waste` | Products → Purchasing → Materials → Recipes → Waste |

Note the interleaving: `order:8` and `order:9` rows are **not contiguous in the markup** — `sales` is authored at `:1294`, `rail-till` at `:1318`, `finance` at `:1327`, but `products` (`:1343`) and `purchasing` (`:1347`) sit between `customers` (`order:10`, authored at `:1334`) and the `order:9` block that follows. **Reading the file top-to-bottom does not give the rail's order**, and neither does reading the `order:` values alone.

The July finding named the `order:9` collision when it was two rows; it is now five, and a second collision has appeared at 8. **Order gaps at 1, 5, 7, 13** (July) are unchanged. A renumber on a clean `1..N` remains the fix, and is now worth more than it was: five rows deep, "resolution falls to DOM order" stops being a footnote.

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

> **🔴 Amended 2026-09-06 (v2.6): the map is no longer complete.** It holds **34 rows against this document's 42**. The eight sections added by the v2.6 reconciliation — `finance`, `materials`, `materials-record`, `recipes`, `recipes-record`, `waste`, `shop-menu`, `orders-new` — **have no archetype**, and none was assigned by that pass.
>
> **That is a deliberate refusal, not an unfinished edit.** Choosing an archetype is a design decision about how a surface is composed; it is Ash's to make, and inferring one from a screen's current markup would launder an implementation detail into the rulebook. A survey may find that a section exists; it may not decide what shape it is.
>
> `tacet-desktop-patterns.md` was **not edited** by the v2.6 pass. Assigning the eight is the follow-on task, and until it is done, treat the §4 map there as covering the 34 it names and being silent — not authoritative — on the rest.

---

## 11. Satellite apps — real surfaces, outside the 42

**Added 2026-07-19.** Some surfaces are complete applications that do not ride the shell:
own document, own `:root`, own i18n, reached from the shell but not part of it. Three
surveys missed the Profile app because this category did not exist. It does now.
The section count is unchanged by anything in this section — satellites are not sections.
*(That count was 34 when this was written and is 42 as of v2.6; the principle is the same.)*

| Satellite | Route / file | Reached via | Notes |
|---|---|---|---|
| **Counter till** **(v2.6)** | `/till` · `till.html` | **Rail row `#rail-till`** (`retail-admin.html:1318`, `order:8`) → `window.open('/till', '_blank')` | Added to this table 2026-09-06. Own PWA on its own `till-manifest.webmanifest`, installed on the shop tablet from its own URL. **Carries no `data-tab` and has no `<section>`** — which is why every previous survey of "rail entries" and of "sections" each missed it from the other side. Gated by neither `TAB_CAP` nor `data-cap`: it needs **both** `till:use` and `orders:edit`, and `data-cap`'s multi-value form is any-of, so its gate is a named branch in `applyCapGates()` (`01-core.js`) reached by element id. Tacet Mobile states the same pair the same way in `canRoute()`. |
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
`tacet-desktop-patterns.md` §4, alongside the 34 that map covers (see §10 — it does
not yet cover the eight sections added at v2.6, and the Counter till above has no
archetype recorded either).

---

*v2.0 · 2026-07-16 · surveyed from `/root/roots-v2` · supersedes v1 entirely. Companion per-section maps (`tacet-orders.md` and siblings) are **stale as of v1** and must be re-surveyed before use as parity baselines.*

*v2.3 changes, 2026-07-25 (later): survey corrections — bar height 56px verified, `body.cobrand` swap recorded as a deliberate change, and the `<h2>` gate re-scoped to 16 tabs with the CSS-narrowing path. See `tacet-desktop-patterns.md` §1.1c.*

*v2.2 changes, 2026-07-25: §2 global chrome rewritten to the settled five-item topbar — brand block · search field · inbox · avatar, plus `#profModal` as portal markup. The 2026-07-24 brand-to-rail move is recorded as reversed. Sub-view strip and page identity marked retired from the bar, the latter gated on the owed `<h2>` audit. Section count unchanged; no section added or removed.*

*v2.1 changes, 2026-07-19: §11 added — satellite apps (Profile, Login), a category the 34-section map never had, which is why three surveys were structurally blind to Profile. The 34-section count is unchanged; satellites are recorded outside it. Section count and everything else from v2.0 stands.*
