# Tacet desktop patterns — v2.9

> The rulebook for every desktop admin surface. `tacet-design-system.md` governs how Tacet **looks**. `tacet-brand-concept.md` governs how it **sounds**. `tacet-ia-blueprint.md` governs what **exists**. This file governs **how a page is put together** — so that Orders and Pop-ups feel like the same product despite having different layouts.
>
> **Status: prescriptive, except on Orders.** All 34 pages are being rebuilt against this document; when a rule and an unbuilt page disagree, **this document wins.**
>
> **Orders is the exception — its design is final (confirmed by Ash 2026-07-17). There is no Orders v2.** The page shipped as "Orders (A) — Build": nine columns, Ship-to and Delivery as their own columns, Store carrying the routing note. **On Orders, the page wins and this document describes it.** Orders still has open *code* items (`tacet-orders-specimens.md` §3, §7) — those are Claude Code passes on a finished design, not a rebuild.
>
> **Grounded in the box, not in the docs.** Surveyed 2026-07-16 from `/root/roots-v2`. Every claim about current state carries a file and line. The other companion docs (`tacet-orders.md`, `tacet-mobile-patterns.md`, `tacet-tokens.css`) are stale — see §9.
>
> The one-line style guide, inherited: **when in doubt, remove something.**

---

## 0. How to use this

**In Claude Design** — paste `tacet-design-system.md` + this file into project instructions. Then per screen:

> Design this screen for the tacet desktop admin. It is a **[archetype]** page. Follow `tacet-desktop-patterns.md`: **the §1.1a region order**, standard page header, one Dusk CTA maximum, 1120px content column, cards not shadows, Inter only, no uppercase, **English-only labels** (one language on screen — never glued `EN · 中文`), tabular numbers, empty states as compliments. **Match Orders** — put your screen next to it; they should look like the same product built by the same hand on the same day.

**🔴 Ask for a page, not a specimen sheet.** A brief scoped to *"the table and its states"* gets back labelled panels — *"Worst case"*, *"Guest — no name"*, *"Calm rows"* — with captions between the rows. That is a presentation **about** a page. It cannot be checked against a live product, which is the only check that has ever worked (§7).

**So:** name the worst case and the variants **as rows inside one continuous table**, and put the states on **separate screens after it**. Never as panels inside the page. *(Cost a round on Customers, 2026-07-17.)*

**And say what not to build.** Claude Design abandons whatever it was pointed at before (§8) — scope is still one thing, finished. But "one thing" is **one page**, not one component with commentary.

**In Claude Code** — this file is the styling contract. The live `--td-*` `:root` block is the source of truth for colour (§1.2). Never hard-code a hex. Never add a `:root` block to a page.

**For a new feature** — pick one of the seven archetypes in §2 before designing anything. If none fits, that is a conversation, not a mockup. Adding an eighth archetype is a deliberate act, not a shortcut around the seven. See §6.

**Three inputs per page:** this file, the section's row in §4, and the section's own map.

---

## 1. Shared conventions

These apply to **every** desktop surface without exception. They are what make 34 different pages one product. An archetype may add; it may never contradict.

### 1.1 The shell

| Element | Rule |
|---|---|
| **Rail** | 240px, `--td-raised`, 1px `--td-border` on the right. **No brand — the 2026-07-24 move to the rail is REVERSED as of 2026-07-25. See §1.1c.** `.nav-brand` stays exactly as it is live: a 56px spacer with `.brand-mark`, `.brand-name`, `.brand-mark-img` CSS-hidden. **Do not un-hide them** — the topbar keeps the brand, so un-hiding ships two wordmarks on every page. Three groups only (Marketing, Loyalty, Editor); everything else flat. Exactly one item active. Rail-fold dot sits at the top of the rail (moved off the topbar 2026-07-24 — that half of the amendment stands). |
| **Topbar** | Persistent (`.topbar`), **locked** — fixed height, never folds or collapses. **Five visible items, settled 2026-07-25 by Ash from an approved seven-frame mockup.** DOM order: **1 brand block** — `tacet` mark + wordmark · 1px `--td-border` hairline, 24px tall, 16px either side · **co-brand tenant logo** (`#brandLogoTop`, swapped by `applyBrand()`), the merchant's own logo, load-bearing for multi-merchant. No logo uploaded → no hairline, no placeholder, no upload prompt; the lockup sits alone. **🔴 Both are visible TOGETHER — this is a deliberate CHANGE to live behaviour, decided by Ash 2026-07-25.** Live `body.cobrand` (css:507–509) *swaps*: it shows `.brand-logo` and hides `.brand-mark` + `.brand-name`, so a merchant with a logo currently sees no tacet at all. **That swap rule comes out.** Build must render mark, wordmark, hairline and merchant logo side by side. Follow-on, undecided: `#brandCredit` ("runs on tacet", rail foot) becomes redundant once tacet is in the bar on every page. · **2** flexible spacer · **3 search field**, 320px (`#gsearch-trigger`) — a *button shaped like an input*: opens the ⌘K palette, never takes a caret. Platform-aware hint (⌘K on Mac, Ctrl K on Windows), never both. · **4 Inbox only** (`.tb-cluster` → Reviews/Feedback). Unseen = one 6px Sage dot. **Never a count, never red.** · **5 account/avatar** (`#acct` → Profile · Appearance/theme `#acctTheme` · Sign out), operator initials on a cream circle. Plus `#profScrim` / `#profModal` — **fixed-position overlay nodes sitting INSIDE `.topbar`**, between `.acct` and the closing div (survey-corrected 2026-07-25; they are *not* children of the avatar). They render out of flow, gated by `.on`, so trimming the bar's visible flex children does not touch them. **Do not delete the `.topbar` subtree wholesale** — `#profModal` lazy-loads `/backend/account` and losing it kills Profile. Move them as a unit if the subtree is restructured. **RETIRED from the topbar:** **page identity** (`#tb-page` — crumb `#tb-crumb`, ⓘ mirror `#tb-info-wrap`, sub-view switches `#tb-subviews`/`#tb-pu-subviews`) and the rail-fold dot (`#railSeamFold`, now in the rail). **The brand is NOT retired — see the Rail row and §1.1c.** **NOT in the topbar:** Language and Sound (both Profile iframe), live-poll dot (not global chrome at all). Theme lives **inside `#acctMenu`**. **Zero Dusk** — chrome that appears on all 34 pages cannot spend a page's Dusk budget before the page loads. **Never grows page-specific controls** — page actions belong in the page header. **Bar height: 56px** — hard-set on `.topbar` (`height:56px`), confirmed by survey 2026-07-25 and corroborated twice: `.nav-brand` is a 56px spacer sized to clear it, and a CSS comment records the opaque pane covering the rail's top 56px. Locked; do not re-derive. |
| **Content column** | max-width **1120px**, padding `32px 48px 96px`. Never full-bleed. |
| **One section visible** | Navigation is DOM show/hide, no reloads. Every page must survive show/hide without re-fetching from zero. |
| **Rail order** | Renumber 1..N on rebuild. Live has a collision at `order:9` (Products/Purchasing) and gaps at 1, 5, 7, 13. |

### 1.1c Topbar reduction — one live precondition, one withdrawn (2026-07-24, amended 2026-07-25)

Removing the crumb from the topbar is **global chrome, all 34 pages, one change.** One precondition is load-bearing and must ship in the *same* change, or the product breaks in ways the mockup did not show. It was found by a live survey, not by reading the docs.

**1. 🔴 WITHDRAWN 2026-07-25 — the brand STAYS in the topbar. Nothing moves to the rail.**
The 2026-07-24 amendment retired the topbar brand and moved it to the rail. **Ash reversed that on 2026-07-25** after a seven-frame topbar mockup — brand block, search, inbox, avatar — was designed and approved with the rail explicitly ruled out of scope.

*Why the reversal is right, not just a preference:* the move was never a move. It required un-hiding three CSS rules on `.nav-brand` **and** re-pointing the co-brand tenant logo (`#brandLogoTop`, `applyBrand()`) at a rail element. That is a rail change — the one thing the 07-25 session ruled out — and botching the re-point strips tenant identity from every page of every merchant's admin. Keeping the brand where it already lives means that change never has to be made at all. **The cheapest version of this precondition is now: do nothing to the rail.**

*The survey finding still stands and is why the reversal is safe:* the rail's brand marks are `display:none` in live CSS (`.nav-brand .brand-mark`, `.brand-name`, `.brand-mark-img`; `.nav-brand` is a 56px spacer), so the topbar `.brand` is the **only visible wordmark on desktop today**. Leaving both as-is is already correct. **Un-hiding the rail marks now would ship two wordmarks** — the exact failure this precondition was written to prevent, arriving from the opposite direction.

- *Note for any future survey:* the Rail row of §1.1 specified "wordmark top" for a long time and the 07-24 amendment treated the topbar copy as the drift. **That reading is now overturned by decision** — the topbar is where the brand lives. The CSS comments in the live file are drifted in the other direction and claim the wordmark "moved to the rail." **Read the `display` rules, not the comments, and read this section before either.**

**2. Removing the crumb strips the page title from pages that have no other one. AUDIT DONE 2026-07-25 — the gate has changed.**
One rule inside `@media (min-width:721px)` hides the in-content `<h2>`. The audit came back at **16 tabs**, not the three that were known: **Orders · Reports · Customers · Snippets · Top-up · Reviews · Feedback · Media · About · Legal · FAQ · Social · Vouchers · Delivery (hub view) · Sales · Sharing.** **Products** and **Purchasing** are hidden by *separate* selectors just above (whole head-rows, not a bare `<h2>`) — count them if a §1.7 header replaces those too. **meituan / guanyi / eleme are deliberately excluded** — no rail button ⇒ empty crumb ⇒ they keep their in-content title. **Do not give those three a §1.7 header that assumes a crumb.** Desktop-only: at ≤720px `.tb-page` is hidden and all titles stay.

**The original gate was "every page must own a real §1.7 header first." That is now retired as the gate**, because only Orders owns one *in code* — every other page is designed with its build held, so the strict reading blocked global chrome behind most of the 34-page rebuild.

**The gate is now: the crumb leaves the topbar and that CSS rule is narrowed in the SAME change.** Un-rebuilt pages fall back to their own plain `<h2>` — a real visible title, just not a §1.7 header — until their rebuild gives them the proper one. Decided by Ash 2026-07-25.
- **Still true, still the destination:** every page owns a real §1.7 header eventually. The header is the page's identity and chrome does not stand in for it (§1.7 v2.1). The fallback is scaffolding, not the answer.
- **Never ship the crumb removal without the CSS narrowing.** Alone, it puts 16 tabs on screen with no title at all.

**What the topbar becomes:** brand block · search · inbox · avatar. Nothing in the chrome names the **page** — the brand names the *product and the merchant*, which is a different job. That is correct **only** while precondition 2 holds — which is why it is a precondition and not a follow-up.

### 1.1a The page shell contract

**Added 2026-07-17 after three consecutive briefs drifted from it.** §1.1 governs the chrome *around* a page. This governs the page. It didn't exist, so every brief was written from someone's memory of Orders — and memory lost three times in one session (see the note at the end).

**Orders' design is final.** Every A1 Worklist matches it. Not "resembles" — matches.

**Region order, top to bottom. No page reorders these, none skips one it has content for:**

| # | Region | Contract |
|---|---|---|
| 1 | **Page header** | Title · status line · one Dusk CTA. Three elements (§1.7). **Section label retired 2026-07-24.** Status line only when a real number backs it. |
| 2 | **Sub-view strip** | Only for sections that have sub-views (Purchasing: Overview · Orders · Suppliers · Bills · Products: Catalogue / Activity / Categories). **In-page, directly under the header — house rule, decided 2026-07-19** (§1.7). The topbar mirrors retire. Orders has no sub-views; the anchor is unaffected. |
| 3 | **KPI tiles** | The pulse (§4). Tiles where there's a real pulse; **one summary line where there isn't** — same slot, same component. Never empty tiles to fake density. |
| 4 | **Segment chips** | One row. Live counts. Ink fill on active. Orders: `All 214 · Pending 6 · Paid 12 …`. |
| 5 | **Filter row** | **Two dropdowns + one wide search, in that order.** Orders: `All stores ▾` · `Channel: All channels ▾` · `Filter these orders`. **No dividers. No chips.** |
| 6 | **Table** | Header `--td-raised` (cream), rows white. **Single-line headers — no sub-labels.** |

**The filter row is dropdowns, not chips.** Chips are the *segment* row (#4) and nowhere else. A page that renders channel as chips has two patterns for one job.

**The table header is cream on white rows.** `--td-raised` fill, single-line labels. If a column header needs a sub-label to be understood, **the header is wrong** — §1.7's logic applies to columns: if it needs a sentence explaining it, it's wrong. Rename it.

**Columns do not collapse.** Proven twice in Batch 0. At narrow widths the table **scrolls horizontally**; it never hides a column into a drawer.

### 1.1d The topbar is closed — no page puts anything in it (2026-07-25)

**§1.1 lists what the topbar contains. This forbids anything else.** The list
is a description and a description can be added to; this is a prohibition and
has to be argued against. That difference is the whole point of the section.

**The rule.** The topbar is fixed, locked, and page-independent. Five items,
56px, identical on Orders, on Settings, on Reports, on every desktop shell
page. **No page adds, removes, reorders, hides, restyles, or conditionally
shows anything in it.** A bar that is identical on 33 pages and different on
one is not consistent — it is broken, and the one page is the bug.

**Where page controls go instead — and this is what makes the ban hold.**
Every legitimate reason to want something in the chrome already has a home one
region down. When a page wants a button in the bar, the answer is not "no," it
is **"that is a §1.7 header CTA."** Page actions belong to the page header;
sub-views belong to the in-page strip (§1.1a row 2); filters belong to the
filter row. A rule that only forbids gets worked around. This one redirects.

**A sixth item is a deliberate act, not a shortcut.** Same construction as the
seven archetypes (§2): adding one is a conversation, never a mockup. Whoever
adds it owns it on all 34 pages, in both themes, in the worst case, and writes
it into this section. **An element that appears in a mockup without appearing
here has not been added — it has been invented.**

**Scope, stated so it is not silently ignored:** this governs **desktop shell
pages** — the 34 sections riding `retail-admin.html`. It does **not** govern
the satellite apps (`tacet-ia-blueprint.md` §11 — Profile, Mini App Editor,
Product Page Editor), which are separate documents with their own chrome, nor
**mobile**, where `#rm-bottomnav` and the More sheet are a genuinely different
surface that legitimately carries theme and language. Those two exclusions are
deliberate. Anything else is not excluded.

**Why this exists.** §1.1 has now been wrong about the topbar three times: a
stale code comment laundered through a survey (2026-07-17), a rule that
outlived the buttons it described (2026-07-17), and a design briefed from
screenshots against a section nobody had read (2026-07-25). Every one of those
was a *description* failing to prevent a *change*. The bar is the one surface
where all 34 pages have an opinion, and a single exception destroys the only
property that makes it worth having. **When in doubt, nothing goes in.**

### 1.1b Roots is one tenant — design for the audience, not the reference

**Added 2026-07-17 after a design argument was made from Roots's traffic numbers.** Tacet is a product for many merchants. **Roots (GO VEGAN! 哈素萌) is the reference tenant — the first customer, not the specification.**

**Two uses of Ash's live product, and only one is valid:**

- ✅ **"Is this in my product?"** — checking a mockup against what *exists*. The best check this project has. Keeps.
- ❌ **"My numbers are small, so cut the metric"** — calibrating what *should exist* to one tenant's data. A trap.

**The audience makes the trap sharper.** The brand doc's audience is *everyday small merchants* — so low traffic, few sessions, tiny denominators are the **core case, not the edge**. A metric that breaks at Roots's scale breaks for the product's whole market. The answer is never "hide it because our numbers are small" — it is **"design it to be honest at small numbers,"** because small numbers are who this is for.

*Worked example, decided the day this rule was written:* Conversion at 2 sessions renders `0.0%` like a crisis; one order later it reads 33%. The rule that fell out: **no percentage until the denominator is meaningful; below the threshold, show the honest thing instead** (the raw counts, or nothing). Same shape as §1.12's "never an alarming ▼100%" delta rule.

**Tenant config is part of this.** `points.redeemRate` is 1 for Roots and 100 by default — a second tenant's every points number looks different. **Never hard-code a Roots value or assume Roots's config**; the survey that caught this checked the config instead of trusting the default, and everything downstream depended on it.

**The test for any design decision:** would this still be right for a merchant with 10× Roots's volume, and for one with a tenth? If the answer depends on Roots specifically, the decision is about the wrong thing.

**Amended 2026-07-19 — the trap has a second axis: usage, not just scale.** "My numbers are small, so cut it" and **"I don't use it, so cut it"** are the same mistake in different clothes. Both calibrate what *should exist* to one tenant. During the Media brief, tags were nearly cut on "does Ash tag anything?" — the axis that would also have cut multi-store, multi-role, and every capacity the first tenant hasn't grown into yet.

**The keep test:** would a plausible merchant segment need this within their first year? (A shop with 500 images needs tags. A shop with two staff needs roles. A shop Ash runs alone still ships both.)

**Valid reasons to cut are unchanged:** the thing is broken, dishonest, unsafe, duplicated, or unreachable — dead filters that can never match, always-blank fields, controls that silently orphan data. Those cuts hold for every merchant.

**Usage evidence** (survey counts, live-DB checks) informs priority and sequencing — it never decides existence by itself. One tenant's zero is a sample of one. Every keep/fold/cut proposal in a brief must name which test it passes: *broken* (cut for everyone) or *merchant-need* (keep/shape for the audience) — so the reasoning is checkable, not trusted.

### 🔴 The two dead references

§8 retires `full-circle-design-system.md`. **There is a second dead reference, and it is more dangerous because it is live:** the un-rebuilt page you are replacing.

**A live page that hasn't been rebuilt is not evidence. It is the thing being replaced.**

The test is never *"does the live page do this?"* — it is **"does Orders do this?"** for structure, and **"does `tacet-design-system.md` say it?"** for brand.

**This cost three rounds on Customers, 2026-07-17, all the same shape:**
- The live Customers page has channel **chips** → the brief asked for chips. Orders uses a **dropdown**.
- The live Customers page has no KPI tiles → the brief omitted the pulse. §4 names Customers as a pulse page, and the *rebuilt* page needs tiles the old one lacked.
- The brief asked for a header sub-label to explain a column. **No Orders header has one.**

Each time the live page was read as precedent. **It was the backlog.**

**The check that catches it, and it is Ash's:** put the mockup next to Orders — not next to the live page. *"They should look like the same product built by the same hand on the same day."* Everything a brief says about structure should be traceable to Orders or to this table. **If a brief says "the live page does X," that is a defect in the brief.**

**🔑 Settled by `git blame` 2026-07-17 — the `--td-*` group is FOUR rule blocks, and that is correct.**

```
7906–7927  :root                        17 dark tokens
7928–7942  :root[data-theme="light"]    13 light overrides
7943–7955  (comment + #tab-dashboard, #tab-reports, … remap — NOT tokens)
7961       :root                        --td-paper  #111A2B   ← the page ground
7962       :root[data-theme="light"]    --td-paper  #FBF9F4
```

**`--td-paper` is load-bearing. Do not fold it in without reading this, and never delete it.** It is defined **nowhere else** and consumed by `body { background: var(--td-paper) }` (`:7968`). **Deleting it blanks the page ground on every admin tab.** It is not a duplicate of anything: `--td-paper` (dark `#111A2B`) is deliberately one notch darker than `--td-surface` (dark `#18233A`) so panels sit *above* the ground.

**Why it's separate: authoring history, not design.** Three commits, one afternoon, 2026-07-06 — token bodies `71bba453` (13:50) → **`--td-paper` bolted on 25 minutes later** `99d1a7e8` (14:15, subject: *"paper ground"*) → wrapper braces re-touched by `cf265450` (19:59) hoisting tokens to global `:root` so phone report sheets, which clone Reports markup into body-level containers, don't lose colour. **Any doc claiming "the token block was added in commit X" is picking one of three.**

**Folding the paper pair into the main block is safe** — both are plain `:root`, identical specificity, **disjoint properties**, zero cascade interaction, byte-identical result. It would make the `--td-*` tokens contiguous, which they currently aren't. **But it's safe here for a specific checked reason, not as a general instinct.** Optional tidy, not a fix.

### 🔴 "There is exactly one `:root` block" was never true

The audit grep (§7) expects *"token block + light override only."* **The file has 34 `:root` occurrences and has never matched.** A rule that cannot pass is a rule nobody can use to spot drift:

- **7** define global custom properties — base admin theme (`:17`, `:95`), a one-off `--ease-calm` (`:887`), and the four Tacet ones above
- **~23** are theme-scoped element overrides — `:root[data-theme="light"] body`, inputs, `.cu-pill`, `.gsearch-box`, `#db-bento`, `.drawer-refund-banner`… **not token blocks**
- **4** are mentions inside comments (`:7903`, `:9759`, `:10004`, `:10409`)

**The real rule: no *page-scoped* `:root`, and no new `--td-*` group.** Theme-scoped element overrides are the house pattern and are fine. Grep corrected in §7.

**Colour comes from the live `--td-*` `:root` block** (`retail-admin.css:7906–7927`, light override `:7928–7942`, **plus the `--td-paper` pair at `:7961–7962`** — see above). It is the real Tacet token layer: every value matches `tacet-design-system.md` exactly, and it carries three the brand book needed but never named (`--td-*-ink`). Use it. Do not fork it, do not shadow it, do not add a page-scoped `:root`.

**Both earlier figures were wrong.** §1.2 said `7906–7942`; the blueprint header said `7906–7962`. `7906–7942` covers the dark+light declarations but conflates two selectors; `7906–7962` sweeps in the `#tab-dashboard` remap, which isn't tokens at all. The map above is the file.

```
BASE (:root — dark, the CSS default)      LIGHT ([data-theme="light"] — opt-in)
--td-paper       #111A2B                  #FBF9F4
--td-surface     #18233A                  #FFFFFF
--td-raised      #1E2A44                  #F6F3EC
--td-border      #2A3550                  #E4E0D5
--td-text        #FBF9F4                  #111A2B
--td-text2       #9AA3B2                  #58606E
--td-dusk        #6E67AF                  (holds)
--td-dusk-hi     #7E77BF                  ⚠ not overridden — see below
--td-dusk-tint   #262A4A                  #EEEDF6
--td-sage        #A3B49F                  (holds)
--td-sage-tint   #1E2C26                  #EDF1EC
--td-sage-ink    #A3B49F                  #4A6249
--td-amber       #C9954A                  (holds)
--td-amber-tint  #33290F                  #F7EEDE
--td-amber-ink   #C9954A                  #8A6425
--td-brick       #B4533E                  (holds)
--td-brick-tint  #351B14                  #F6E7E3
--td-brick-ink   #D07A66                  #B4533E
--td-heat-rgb    251,249,244              17,26,43
```

**Two facts that must be understood before touching this layer:**

1. **The cascade is dark-first.** `:root` is dark; light is the opt-in override. This is inverted from both `tacet-tokens.css` and `tacet-design-system.md` (which calls Paper "the default background of everything"). It is a technical default, not a brand statement — but **do not "fix" it**. 34 pages depend on it, and flipping the base would silently invert the admin.
2. **`--td-*` is a colour layer only.** Space, shape, motion, and type are **not tokenised** — they still come from the legacy layer (`--f-sans`, `--r-md`, `--ease-out`) or are hard-coded. §1.3–1.5 define them; **tokenise them as `--td-*` during Batch 0** so the contract covers everything.

**The `-ink` variants exist for a reason.** Sage `#A3B49F` on Sage-tint `#EDF1EC` is unreadable. `--td-sage-ink` `#4A6249` is the readable text colour on that tint. **Text on a tint is always the `-ink`, never the base.** This is the rule `tacet-tokens.css` papered over by hard-coding `#4A6249` inside a badge.

**Known conflict — fix in Batch 0:** `--td-dusk-hi` is defined once (`#7E77BF`, lighter than Dusk) and never overridden for light. Lighter-on-hover is right for dark; light wants darker. Add `--td-dusk-hi: #5F58A0` to the light block.

**Known wrong-brand fallbacks — fix in Batch 0:** `css:2121` and `:2156` use `var(--td-paper, #fbfaf6)` and `var(--td-text2, #55554c)`. Those fallbacks are warm-grey, not Tacet. Correct to `#FBF9F4` / `#58606E`, or drop the fallback.

### 1.3 Type

**Inter only.** `--f-sans` is already Inter globally (`css:82`). `--f-mono` is remapped to Inter too (`:83`) — correct, since Tacet has no mono face, but it means **the mono *pattern* survived while the face silently became Inter**. See §1.6.

**Fraunces never appears in the admin.** Not in headers, not in empty states, not in The Recap. It is the marketing voice only. Check it first in every audit.

**CJK fallback is wrong.** Live: `'IBM Plex Sans SC'`. The brand pairs **Source Han Sans** with Inter. In a product where half of every label is 中文, this is the largest type error on the box. One line, four places (`css:82, 83, 7953, 9273`).

**The scale — six steps, no others.** Any size not on this list is drift.

| Role | Value | Use |
|---|---|---|
| **Page title** | 24px Inter 500, `-0.01em` | The header title. One per page. Already shipped in Team. |
| **Section title** | 18px Inter 500 | Card and panel titles. |
| **Metric number** | 30px Inter 500, tabular | Page-level KPI tiles. Already shipped in Orders (`css:104`). |
| **Body** | 15px Inter 400, lh 1.6 (**1.7 for CJK runs**) | Everything readable. |
| **Caption / label** | 13px Inter 400 (500 for field labels) | Meta, hints, table headers. |
| **Status line** | 15px Inter 400, `--td-text2`, **sentence case**, tabular figures | Under the page title. Live section state, real numbers only. §1.7. |
| ~~Section label~~ | ~~13px Inter 500, `--td-text2`, `+0.04em`~~ | **RETIRED 2026-07-24** (§1.7). Was the sentence-case replacement for the uppercase eyebrow; the status line takes its slot. The §1.6 no-uppercase rule is unaffected and still binds everywhere. |

**No half-pixels.** `13.5px`, `12.5px`, `14.5px`, `9.5px` are not sizes. (All four ship in Team today.)

**Two weights only: 400 and 500.** Nothing heavier — bold reads as shouting.

**Numbers are always tabular** (`font-variant-numeric: tabular-nums`). Every count, currency figure, timestamp, ID. No exceptions — a right-aligned column that shifts is the loudest thing on a quiet page.

### 1.4 Space and shape

8px base: **4 · 8 · 16 · 24 · 32 · 48 · 64 · 96**. Default to the *larger* option — whitespace is the product. Density is achieved by removing elements, not by tightening space.

| Thing | Value |
|---|---|
| Card / panel radius | **14px** |
| Control radius (button, input, chip, nav item) | **8px** |
| Badge / pill radius | full (999px) |
| Border | 1px `--td-border` |
| Card padding | 24px |
| Gap between cards | 24px |
| Between page regions | 32px |
| Section title → its content | 16px |

**12px radius is not a Tacet value.** (It ships in Team's `tm-stat` today, in the same card as a correct 14px.)

**The table header is `--td-raised` on white rows.** Single-line labels, no sub-labels. Stated here 2026-07-17 because it was never stated anywhere: `--td-raised` existed as a *value*, "Data table" existed as a shared component (§3), and nothing connected them — so Orders shipped a cream header and the next page built a white one. **A shared component with an unwritten treatment is two components.** Full page-shell contract: §1.1a.

**Hairlines, not shadows.** One soft ambient shadow is permitted, on overlays only (drawer, modal, popover): `0 1px 2px rgba(17,26,43,.05), 0 4px 16px rgba(17,26,43,.04)`. Never on a resting card. **Never two stacked shadows** — `.fc-spark-tip` and `.db-spark-tip` currently stack two (`css:1285, 1692`), breaking the rule twice over.

No gradients. No glass. Ever.

### 1.5 Motion — "everything settles"

- Easing `cubic-bezier(0.16, 1, 0.3, 1)`. Durations: **200ms** controls, **350ms** default, **600ms** page-level.
- Nothing bounces, pops, springs, or slides in from the side. Elements decelerate into place like water going still.
- Cards enter with an 8px rise + fade, once.
- The Dusk dot breathes (opacity 1 → 0.45 → 1, 2.4s) wherever an automation is live.
- The settling waveform appears in exactly three places: app launch, website hero, page-level loading. **Never a table refresh.**
- Always respect `prefers-reduced-motion`.

### 1.6 The uppercase ban

**No `text-transform: uppercase` anywhere in the admin.** Current count: **109** (`retail-admin.css`), and rising — Team added several on 2026-07-16.

*Why it exists:* the reference build licensed exactly one uppercase use — a mono eyebrow — because JetBrains Mono is a machine-data face where uppercase reads as a system label. *Why it's now wrong:* `--f-mono` is Inter. These are uppercase **Inter**, a humanist text face. Tacet forbids weights above 500 because "bold reads as shouting"; uppercase shouts louder than bold. The pattern was inherited; the typeface that justified it was not.

**The replacement, used everywhere an eyebrow used to be:**

| Was | Is |
|---|---|
| `OPERATIONS` — 10px, uppercase, `.18em`, mono | `Operations` — 13px Inter 500, `--td-text2`, `+0.04em`, sentence case |
| `PENDING` — 11px, uppercase, `.08em` | `Pending` — 13px Inter 500, `--td-text2` |

**Sentence case everywhere. No exceptions.** There is no licensed uppercase in Tacet.

*How to fix:* not in bulk. Each page's rebuild removes its own; the number only goes down. The rule's job is stopping **new** ones.

### 1.7 The page header — identical on all 34 pages

**Amended 2026-07-24 by Ash. The section label is retired product-wide; a status line replaces it.**

```
┌────────────────────────────────────────────────────────────┐
│ Orders                                       [ New order ] │  ← page title · one Dusk CTA
│ 142 open · 8 awaiting fulfilment                           │  ← status line (when real)
├────────────────────────────────────────────────────────────┤
```

- **Page title** — 24px Inter 500, first line. One language (§1.11). Source carries both strings; the screen shows one.
- **Status line** — directly under the title. 15px Inter 400, `--td-text2` (Graphite), sentence case, tabular figures, `" · "` (space dot space) between facts. It carries **live overall state for the section** — what an operator wants to know before they scroll.
- **Primary action** — top-right, aligned to the title baseline. **This is the page's one Dusk element.** Verb-first: "New order", "Connect channel". If the page has no create action, the slot stays **empty** — never filled with a secondary.
- Never scrolled away. Never restyled per page. Never gains a second row above it.
- **Zero Dusk in the status line.** It is state, not the AI acting.

**Three elements. There is no fourth.**

**The section label ("Operations", "Marketing", "Catalog") is RETIRED.** It was the rail group name repeated at the top of the page, and the rail already says where you are. (This originally also cited the topbar crumb — **the crumb was retired the same day**, §1.1c. With both gone, **the rail is the only chrome that locates you**, which is exactly why §1.1c requires every page to own a real header before the crumb is removed. The two amendments are one decision: identity lives in the page, not in the chrome.) Retiring it is product-wide and touches more than this section — **§1.1a region row 1, §3, and the archetype shared-component list all still say "section label"; each is corrected in this same version.** A future survey that finds the phrase surviving anywhere has found drift, not a rule.

**The status line is NOT the purpose line, and does not reopen it.** The purpose line was cut 2026-07-17 (*"Every order, every channel — refreshed in place"*) and stays cut. The distinction is load-bearing:

| Purpose line — banned | Status line — required |
|---|---|
| Describes what the page is for | Reports what is in the page right now |
| Identical every day | Changes with the data |
| "Manage your orders here" | "142 open · 8 awaiting fulfilment" |

**If it reads like a description, it is a purpose line wearing a status line's clothes. Cut it.** The test: *would this sentence be different tomorrow?* If no, it's the purpose line.

**🔴 The work rule — a status line reports WORK WAITING, not population.** *(Added 2026-07-26, from the Customers pass.)* The line answers *what needs me right now*, never *how many of these exist*. "142 open · 8 awaiting fulfilment" is work — those orders are waiting on an operator. "693 customers" is a census. A count of records that exist is a fact, not a job, and it belongs in a KPI tile if anywhere.

**A section where nothing is waiting gets NO status line, and that is the finished answer.** Not every page is a worklist. Orders, Purchasing and Marketing have queues; Customers does not — 693 records, none of them waiting on anyone. **Customers is the reference case:** it ships with the title alone, deliberately, and any future pass that reads the empty slot as an oversight and fills it has misread this rule.

The three tests, all required, and any one of them failing means no line:

| test | fails when |
|---|---|
| **Real** | the number is invented, placeholdered, or comes from an endpoint that doesn't exist |
| **Not duplicated** | the tiles and chips already say it |
| **Work, not population** | it counts what exists rather than what is waiting |

**🔴 The honesty rule — a status line ships ONLY when a real, wired number is behind it.** No invented figures, no placeholders, no `—`, no "coming soon". A section with nothing real to say **shows the title alone**, and that is a correct, finished header — not a gap awaiting a line. This rule exists because Sales spent its whole life displaying `—` from an endpoint that did not exist (`tacet-sales-addendum.md`); a fake status line rebuilds that failure at the top of all 34 pages at once instead of the middle of one. **Per section, the number's source must be named before the line is designed.** The dash is banned here as everywhere.

**The non-duplication rule (soft — added 2026-07-24 with the same amendment).** The status line should report what the KPI tiles and filter chips **don't**. It is not a fourth copy of a count already on screen.

*Origin:* the first Orders render put "142 open" in the status line directly above a KPI tile reading "Orders today 214" and an All chip reading 214. Three order counts within ~200px, measuring three different things, with nothing on screen explaining why they disagree. The operator has to reconcile them; that is the opposite of a glance.

- **Prefer the fact nothing else shows.** On Orders, *"8 awaiting fulfilment"* earns its place — actionable, and no tile or chip carries it. *"142 open"* is largely answered by the chips already.
- **This is a preference, not a ban.** A restated fact is allowed where it genuinely reads better as a headline than as a chip.
- **But it never forces a second fact into existence.** A section whose only honest line would restate its own chips **shows the title alone**. Inventing a second fact to satisfy this rule is exactly the failure the honesty rule above exists to prevent — the two rules point the same way, and the honesty rule wins every time they seem to conflict.
- **One fact is a complete status line.** Two is common, not required. Three is usually a section that wanted a KPI tile.

**Strips sit below the header — and there are two kinds, which are not interchangeable:**

| | **Filter strip** (chips) | **Sub-view strip** (segment) |
|---|---|---|
| Does what | Narrows the same records | Swaps to different content |
| Looks like | Pill chips with live counts | Segmented control |
| Active state | Ink fill, Paper text | Ink underline, Ink text 500 |
| Examples | Orders status / channel / fapiao | Purchasing → Overview / Orders / Suppliers / Bills · Products → Activity / Categories · Reports chapters |

**The test:** does it change *which* records you see (filter) or *what kind of thing* you're looking at (sub-view)? Coupons' Live/Ended is a filter. Products' Categories is a sub-view.

A sub-view strip appears **once**, directly under the header. **Resolved 2026-07-19: the in-page strip won — product-wide.** The topbar mirrors (`#tb-subviews`, `#tb-pu-subviews`) are the duplicates and retire as each section's rebuild ships (Purchasing first; Products at its rebuild). A nav that exists in two places drifts in one — this decision picks the one.

### 1.8 The one-Dusk rule, made operational

Dusk means exactly one thing: **tacet did this for you.** It is scarce by design. On a dense admin page the rule needs a tiebreaker:

1. **The primary CTA in the page header is the Dusk element.** It has first claim.
2. **Automation indicators are exempt** — the breathing dot, Dusk-tint automation badges. They mean "tacet acted", not "click here", and may repeat as many times as there are automations.
3. **Focus rings are Dusk** and are exempt.
4. **Everything else is Secondary or Ghost.** Two Dusk CTAs on one page is a bug — *including across an open drawer*. A drawer inherits the page's budget: if the header CTA is Dusk, the drawer's actions are Secondary.
5. **Neither a modal nor a drawer spends Dusk.** *(Corrected 2026-07-26 — the prior version gave a modal its own Dusk. See "Why this changed" below; do not restore it.)* The old test was *can the operator still act on what's behind it?* — a **budget** question. The test is now *who is acting?* — a **semantic** one.
   - **Drawer → inherits.** The list stays live behind it — rows visible, poller running, header CTA still clickable. Two surfaces, one budget, so the drawer's actions go Secondary.
   - **Modal → spends nothing.** Its primary is **Ink**. Destructive stays Brick outline (never a solid slab), and the focus ring stays Dusk — rule 3, and a focus ring is not an element making a claim. A modal confirm is the **operator committing to their own decision**, and Dusk means one thing only: *tacet did this for you.* Having an unspent budget does not make the merchant's action the AI's.
   - **Full-screen page over a page → suppress the one behind it.** If a page is opened over another (New order over Orders), unmount or `inert` the underlying header. Two primaries in the DOM where one is unreachable means the DOM no longer describes the page. And reconsider the overlay itself — a page should be a route with a back link (§A3), not a sheet. Overlay is what a modal does.
6. **A Console page spends nothing.** Config isn't the AI acting. Its Dusk budget stays unspent, and that is correct.

If a page seems to need two Dusk CTAs, it is two pages, or one of them is not primary.

**🔴 Why rule 5 changed — the budget was the wrong axis.** *(2026-07-26. Written at length because a rule without its reasoning is one survey away from being "corrected" back — §7.)*

The prior rule reasoned from **surface budget**: a modal is its own visible surface, everything behind it is inert, it has no header CTA to lose the tiebreaker to, therefore its confirm may take the Dusk. That is internally consistent, and it lost to the product. **Dusk is semantic before it is budgetary** — `tacet-design-system.md` §1: *when a merchant sees Dusk, it means exactly one thing — tacet did this for you.* An operator confirming their own action is the merchant acting, and spare budget does not convert that into the AI acting. **Rule 6 was already reasoning this way** ("Config isn't the AI acting") — rule 5 was the odd one out, and the inconsistency sat unnoticed inside a single numbered list.

**Three sections reached the corrected answer independently before it was written here**, which is the evidence that decided it:

| section | what shipped or was decided | source |
|---|---|---|
| **Customers** | modal primaries are **Ink**, live in production, matching Team and FAQ | `tacet-customers-addendum.md` decision 7 |
| **Marketing** | group precedent: blast-radius confirm primary = **Ink**, "merchant action, not AI" | `tacet-marketing-addendum.md` precedent 8 |
| **CMS / FAQ** | category-modal primary **Ink**, recorded as *"do NOT revert to Dusk"* | `tacet-cms-session-addendum.md` parked item 2.4 |

Both addenda already called this "the known unwritten clarification." It went six days unwritten while the rulebook — the tiebreaker both other tools read — said the opposite. **A live page built correctly against an uncorrected rule is a trap:** the next survey reads §1.8, concludes Customers is wrong, and "fixes" a correct page into a bug. That is §1.1's failure shape (`tacet-topbar-correction.md`) pointed the other way — there the rule outlived its buttons; here the rule outlived its own reasoning.

This is also the move `tacet-brand-concept.md` v1.1 made on the naming rule: *a rule broken within weeks by your own team is usually the thing that's wrong*, and in both cases the fault was the **axis**, not the strictness. Naming was drawn around importance when it should have been voice. Dusk-in-overlays was drawn around **where the element sits** when it should have been drawn around **who is acting**.

**The one door left open, deliberately narrow:** a modal whose primary action genuinely *is* the AI acting — arming an automation, accepting an AI suggestion — may take Dusk, because there Dusk is telling the truth. That is a decision per instance with a reason recorded, never a default, and **no such modal exists in the product today.** A modal that merely *touches* an automation does not qualify; the question is whether pressing the button is tacet acting or the operator acting.

**Buttons:**

| Variant | Style | Use |
|---|---|---|
| **Primary** | `--td-dusk` fill, white text | One per page, max. |
| **Secondary** | transparent, 1px `--td-border`, `--td-text` | The default for everything else. |
| **Ghost** | text only, `--td-text2` | Tertiary, in-row. |
| **Destructive** | transparent, `--td-brick` border + text; fills `--td-brick-tint` on hover | Never a solid red slab. |

Hover on primary: `--td-dusk-hi`. Labels are verbs, sentence case, and keep their name through the whole flow — "Publish" produces "Published".

**Receipts — the rule is partly inverted, and less of it than this list once claimed.** Nine lines paint a primary-or-active surface with `--td-text` (Ink) against **one** with `--td-dusk`. Where Ink is painting a page's own primary CTA, it is the *reference build's* rule wearing a Tacet token and it is wrong. **Where Ink is painting a modal primary it is now correct** (rule 5, corrected 2026-07-26) — that is the difference this list did not previously draw. **Three** lines are true primary CTAs and must become Dusk; one already is; one is a modal primary that stays Ink; one is contested and is not settled here:

```
3265  .feat-off .btn-primary                    → Dusk
6638  #tab-sharing .sc-save                     → Dusk
9864  #prod-view-purchasing .pu2-btn.primary    → Dusk
2312  #pa-wizard-btn.btn-primary                ✓ already Dusk
9362  .cs-modal .btn-primary                    ✓ Ink — modal primary, rule 5
9441  #tab-sales .mc-wiz .btn-primary           ⚠ contested — see below
```

**`.cs-modal` was reclassified 2026-07-26** by the rule 5 correction. It sat here as owed-Dusk for exactly as long as rule 5 said a modal owns its Dusk; it is a modal primary and Ink is now its correct, finished state. **This is the receipt that would have re-armed the old rule.** A retired rule survives in its downstream lists — that is how the section label came back in eight places (v2.2). Any later pass that finds this line and "completes" the Dusk conversion has restored a rule that was deliberately removed.

**`.mc-wiz` is left contested on purpose, not overlooked.** `tacet-sales-addendum.md` locks **zero Dusk on the Sales page** — its toggles are the merchant acting — while this list says its wizard primary owes Dusk. Rule 5 does not settle it either way: the relay wizard renders **inline in `#sales-setup-host`**, not as a modal, so it is a page-budget question rather than an overlay one. **Decide it at the Sales build with the Sales addendum open. Do not paint it Dusk on the strength of this list alone.**

The rest are **active-selection states** — a different question, and Ink is the right answer:

```
1758  .db-metric-btns button.active             ✓ Ink — selection, not a CTA
8893  #tab-reports .db-range .seg button.active ✓ Ink
9847  #prod-view-purchasing .pu2-seg.on         ✓ Ink
9457  .mc-wiz .mw-step.now .n                   ✓ Ink — step marker
```

**Stated once:** *Dusk = the AI acts, or the page's one primary action. Ink = the operator's current selection. They are never swapped.*

### 1.9 Gated states — three axes, three answers

RBAC is going live (`tm-enforce`, Team). Every page needs a designed gated state, decided **once** here rather than 34 times.

| Axis | Means | Answer |
|---|---|---|
| **Capability** (`data-cap`, `TAB_CAP`) | You're not allowed | **Navigation: disappear.** The rail tab, the bottom-nav entry, and any group that empties. Silence is a feature; a rail of locked doors is noise. **Inside a record: disable with a one-line reason** — "Only owners can approve refunds." A vanished button inside an order the operator *can* see is a support ticket; a disabled one teaches. |
| **Feature flag** (`data-feat`) | Your plan doesn't include it | The section's **own page shows the master switch, off**, with the consequence in words. Groups below visible but disabled at 55% — **never hidden**. The merchant must see what turning it on gives them. Rail entry follows the live rule (hidden until on). |
| **Data precondition** | Nothing to show yet | **Self-hide.** The store filter with 1 store, the printer picker with 1 printer, an empty alert tile. No empty state, no placeholder — just absence. |

**The distinction that matters:** *not allowed* and *not included* are different sentences. Never render one as the other.

**Blocking gap:** `team` has no `TAB_CAP` entry, so `applyCapGates` returns early and it is visible to every operator — including the page that assigns roles. Assign a capability before `tm-enforce` ships. Same for `sales`, `setup`, `product-editor`.

### 1.10 Status colour — semantics, not decoration

| Meaning | Fill | Text |
|---|---|---|
| All clear, delivered, active, done | `--td-sage-tint` | `--td-sage-ink` |
| Needs attention, waiting, at deadline | `--td-amber-tint` | `--td-amber-ink` |
| Error, cancelled, refund problem | `--td-brick-tint` | `--td-brick-ink` |
| **tacet acted** — automation ran, AI proposed | `--td-dusk-tint` + breathing dot | `--td-dusk` |
| Neutral / empty | — | `—` in `--td-text2` |

**If a colour does not encode a state, do not use it.** A page with nothing wrong is almost entirely Paper, Ink, and Graphite.

**A down delta renders in Graphite, never Brick.** Revenue falling is information, not an emergency. Already correct (`css:113`) — keep it.

**Receipts — Team breaks this three times today.** Role pills use `--td-amber` for *owner*, `--td-sage` for *op*, `--td-dusk` for *you* and *custom role*. An owner is not "needs attention". A custom role is not an automation. **Roles are not statuses** — they get neutral treatment (`--td-raised` + border). Only a genuine state (inactive, invited, locked) earns a status colour.

**`--accent` (tea) survives in chart lines** (`css:7945`), justified as "close kin to sage". Sage exists. Charts use `--td-sage`; warnings `--td-amber`; errors `--td-brick-ink`. Delete the tea.

### 1.10a Badge stacks — when a row has five states at once

§1.10 says colour encodes state. It does not say what happens when one record is in **five states simultaneously** — and on Orders that is routine, not theoretical. A single order can legitimately be `Paid` + `↩ refund req` + `Updated · 加单` + `Stock pending` + `Invoice to issue` at the same moment. With the Store cell's `routingNote` and `⚠ needs restock`, and the `NEW · 新` chip on the order number, a worst-case row carries **7 marks across four columns** — and the Delivery cell can add more.

**✅ Verified against the live row template 2026-07-17** (`04-orders.js:1057–1075`). An earlier draft of this section said "~8 marks across three columns" from a survey; the template says seven across four. **The full cited specimen is `tacet-orders-specimens.md` §6** — build against that, not against this paragraph.

**Five pills would be five things shouting.** The rule is to split by **weight**, not by space:

```
┌ top row ────────────────────────────┐
│  [primary pill]  [pill]  [pill]     │  ← max 3 pills. The record's state.
└─────────────────────────────────────┘
   Quiet note-line                       ← max 2. Facts that need no colour.
   Quiet note-line
```

- **Max 3 pills on the top row.** The first is the record's primary status and is always present.
- **Max 2 note-lines beneath** — smaller, Graphite, no fill. A note-line is a fact the operator reads, not a state they scan for.
- **The test:** would an operator *filter* by this? Then it's a pill. Would they only *notice* it once the row is already in front of them? Then it's a note-line. `Stock pending` is a note-line; `Awaiting restock` is a pill.
- **Never exceed five.** If a sixth is needed, one of the five isn't earning its place — or it belongs in the drawer.
- **A pill's label renders on ONE line. Pills never wrap** *(added 2026-07-24)*. A two-line pill stops reading as a badge and starts reading as a paragraph — and it silently makes its row taller than its neighbours, which is how a list starts jumping. If the column is narrow the pill takes the width it needs; if that is genuinely impossible the label truncates with an ellipsis and the full text is available on hover. It never breaks onto a second line. *(Caught on Orders: `⚠ needs restock` wrapping inside the Store cell.)* Note-lines are text, not pills — they may wrap, but check they aren't wrapping unnecessarily.

**Design the worst case, not the happy path.** A status cell mocked up with one pill is a status cell that hasn't been designed.

**Two things the code already settled** (`04:1072`, verified 2026-07-17):

1. **The split is built, not proposed.** `.stack` holds the pills; `stockPendingBadge` and `invoiceLine` render *outside* it as note-lines. The live DOM already implements 3-pills-plus-2-note-lines. This rule describes the code here; it doesn't prescribe against it.
2. 🔴 **`addonBadge` ("Updated · 加单") ships styled `pill st-paid`** (`04:1956`) — visually identical to the Paid status pill. A paid order with an add-on shows **two green paid-looking pills, one of which is not a status.** That is a §1.10 violation (colour must encode state) hiding inside a §1.10a stack. **Fix it in the Orders rebuild:** the add-on mark is a fact, not a status — it takes a neutral treatment.

### 🔑 Three ways a string learns the language changed — and interpolation picks which

**Settled from code 2026-07-17.** §1.11 says what the screen shows. It never said **how a string finds out the language changed** — and the drawer used two mechanisms side by side, so half a panel toggled and half didn't. That was the bug. It wasn't a rule gap; it was a mechanism nobody had written down.

| Mechanism | How | Toggles? |
|---|---|---|
| **Walker live-toggle** — *the house default* | Emit a glued `EN · 中文` text node. The `MutationObserver` (`_mo`) walks it at insert; `processNode` registers it in `_reg`; `applyLang` rewrites `nodeValue` in place **and** re-walks `document.body` via `processSubtree`. Glued in *markup*, one language on screen — §1.11 satisfied. | ✅ in place, no re-render |
| **`cuT()` bake** | `cuT(en, cn)` picks one language **at call time** and emits a middot-less node. `processNode` skips it — no `·`, no `EN_ONLY_MAP` hit. | ❌ **frozen until something re-renders** |
| **`onLangChange(cb)` re-render** | Explicit repaint hook. Used by dashboard, catalogue, KPIs, account. **The order drawer subscribes to none of them.** | ✅ but repaints |

**The rule is not "pick a convention." The axis is interpolation:**

- **Plain text, nothing between the two languages** → **glue it.** The walker owns it. Zero cost.
- **Anything interpolated between EN and CN** — a `<b>`, a value, a date → **glue is physically unavailable.** The tags split the node across element boundaries, so it can never be one text node. These need the `data-lang-block` block-pair pattern or a label-isolation span.

**So `cuT()` is correct** for values, attributes (`title=`, `placeholder=`), toasts, and logic branches — and **wrong for a plain visible label**. `04-orders.js` has ~312 `cuT()` calls; that is the whole bake surface, and most are legitimate. **The defect class is narrow and identifiable: a `cuT()` whose output becomes body text with no `·`.**

**Never hook a drawer to `onLangChange`.** Re-rendering an open drawer destroys what `cuOpenDetail`'s `restore.scrollTop`/`openRecent` logic exists to preserve — scroll position, expanded `<details>` folds, in-flight input and focus — and fights the settle animation. That is *why* nothing in the drawer subscribes today. It was a decision, not an oversight.

### 🔴 Gluing adopts a constraint `cuT()` never had

**Neither half of a glued literal may ever contain `" · "`.** `cuT('a','b')` accepts any characters. A glued literal is *parsed* — the walker splits on the **first** ` · `. Convert a string to glue and it silently inherits that rule forever.

**The paying note is safe today only because its dashes are em-dashes (` — `), not middots.** A translator or a later edit that drops a spaced middot into either half splits the note at the wrong place and breaks it — silently, in the language you don't have open.

**This is the standing cost of the house convention**, inherited the moment a string is converted. Worth stating because the next person to edit a glued string will not know they're editing a parsed format.

**✅ Shipped `53910791`, 2026-07-17** — the `paying` note now glues and live-toggles like the badge and banner beside it. **Three same-class strings deferred, and the reason is the rule above, not triage:** *"Customer asked for…"* has an embedded `<b>` (needs a `data-lang-block` pair; renders in pending/reviewing only), and *"requested"* / *"Staff note"* have a date or value interpolated after the label (need a label-isolation span). **All four were equally visible and equally broken. Only one could be glued.**

### 1.11 Language — one at a time, never glued

**The rule: the interface renders in exactly one language. English or 中文. Never both.**

A merchant reading Chinese should see a Chinese screen. A merchant reading English should see an English screen. `Orders today · 今日订单` gives each of them a screen that is half noise — and a product that sells calm cannot hand you every label twice.

**`English · 中文` is a source format, not a display format.** Two strings stored together, one rendered. The live code already does this: `cuT('WeChat','微信')` picks one; `onLangChange` re-renders the tree; `data-no-i18n` marks blocks the splitter must not touch. The comment at `01-core.js:191` states it plainly — the label shows one language, *"never a glued 'WeChat · 微信'."*

| Wrong (glued) | Right (EN) | Right (中文) |
|---|---|---|
| `Orders · 订单` | `Orders` | `订单` |
| `Awaiting restock · 待补货` | `Awaiting restock` | `待补货` |
| `New order · 新建订单` | `New order` | `新建订单` |

**The one exception: the language toggle itself** renders `EN · 中文`, because it is the control for choosing, not a label.

**In mockups: English only.** Never render both. A mockup with glued labels is designing a screen no operator will ever see.

**But the winning direction is verified in 中文 before it ships.** This is the trap: 中文 is usually *shorter* than English — `订单` is two glyphs where `Orders` is six — so an English layout can look correct and leave Chinese columns swimming in space, or an English column sized to `Awaiting restock` wastes half its width on `待补货`. Column widths must work in both. **Design in English, verify in Chinese, ship both.**

- CJK: **Source Han Sans** (Noto Sans SC) pairs with Inter. Line-height **1.7** for CJK runs — CJK glyphs need the air.
- Every label needs both strings in the source. A screen that can only render English is not done.

**The part that will bite you: there is a live DOM-walker.**

The " · " splitter is not a build step — the engine (`processNode`, `retail-admin.html:10534`) walks the rendered DOM at runtime, and it reaches dynamically-injected nodes via a MutationObserver on `document.body` (`:10727`), so drawers are walked on open too. But it is **not** true that any `·` looks like a pair. Two gates narrow it: **(1)** a text node is only *considered* if it contains ` · ` — **space-middot-space** (`:10660`); a bare `·` with no surrounding spaces is never touched. **(2)** it then splits on the **first** ` · ` and treats the node as an `English · 中文` pair **only when the left half is Chinese-free AND the right half contains Chinese** — the real guard is `if (!hasChinese(cn) || hasChinese(en)) return;` at `:10548` (`hasChinese = /[一-鿿]/`, `:10515`):

| Text node | What the walker does |
|---|---|
| `Orders · 订单` | splits → EN `Orders` / 中文 `订单` |
| `退款已批准 · 待打款` (Chinese both sides) | **untouched** — the left has Chinese |
| `size · SKU · ×qty` (no Chinese) | **untouched** — the right has no Chinese |
| `Refund approved — pay out · 退款已批准 · 待打款` | splits on the **first** middot only; the CN half keeps its own internal `·`. Correct in both languages |

So the real risk is narrow: **Latin-left + Chinese-right** external text — an English carrier scan description immediately followed by a Chinese status label *would* be split and half-blanked. That risk is real, which is why the authoring discipline below still stands. **But the over-warning is not free.** Believe that *any* `·` is a pair and you reflexively shield genuine `English · 中文` labels with `data-no-i18n` — and that **causes its own failure**: the walker skips a shielded node, so the language toggle can no longer swap it, and both languages render **glued**, the exact thing §1.11 exists to prevent. Shield outside-system text; do **not** shield real bilingual labels.

`data-no-i18n` is the shield. It marks a block the walker must not touch, and it is why those blocks re-render on every language toggle instead of being walked.

**So: any block holding text that came from outside our system carries `data-no-i18n`.** Carrier strings, tracking events, rider names, addresses, customer names, platform status labels. **If a redesign restructures a card, the wrapper travels with the text** — or the events silently go blank in the other language, with no error and nothing in the console. It fails quietly, in the language you don't have open.

*(Surfaced only when the survey was asked "what did you leave out because it seemed obvious?" — it had been treated as ambient knowledge. It is the highest-consequence invisible rule in the product.)*

### 1.12 States — every page ships all six

- **Loading** — the region's skeleton at `--td-raised`, settling. **No spinners.** The waveform is for app launch and page-level loads only. **Only on a real load** — a poller refresh never shows it, never flashes, never puts a placeholder over data that is already on screen.
- **Silent refresh** — pollers repaint in place. Changed rows fade; nothing turns red on arrival.
- **Empty** — *there is nothing here yet.* A compliment, not an apology. *"Nothing needs you. Enjoy it."* / *"No orders yet — new orders settle in here from every channel."* Name what will arrive. Optional flat waveform above. Never a sad illustration. Never "Nothing here yet."
- **No results** — *there is plenty here; your filter matched none of it.* **A different state and a different sentence.** Name what is filtering and offer to clear it: *"No orders match 'Chen Jing'."* + `Clear search`. Never a compliment — the operator is looking for something and has not found it.
- **In flight** — *you clicked; something is happening.* **The clicked control disables and says so** for the duration. No spinner overlay, no page dim — the change is local to the thing you pressed. On resolve, the region re-renders and the control returns.

  **This is not optional on write actions, and it is the rule most often skipped.** Live Orders gives its shipment and refund buttons a proper busy state (`adminWrite`) but gives the **primary status row none at all** — `Mark paid` and `Mark dispatched`, the two most-clicked controls in the product, can be double-submitted and the server is the only guard. The rule: **every control that writes disables while it writes.** No exceptions for the important ones.

  **The receipt above is understated, and the correction is bigger than a count** (settled from code 2026-07-17): the primary row is not the only offender, and this is not an Orders-only problem. **Orders has 6 non-disabling write controls; Customers has 7 more (8 call sites)** — and Customers is in Batch 1. The audit's "eight" was wrong on both surfaces. **Full list: `tacet-orders-specimens.md` §7**, and it wins over any count stated here.

  **Four failure shapes, and each defeated the check that caught the last.** **A** — no busy call at all (`transition()`, `04:4602`). **B** — `adminWrite` without `btn`; the call site looks correct (`combineParcels` `04:595`). **🔴 B-variant** — `adminWrite` with a `btnId` that doesn't exist in the markup (`cuSaveEdit` `08:1218`), so `getElementById` returns null and the disable no-ops; **it passes a grep for `btnId:`**. **🔴🔴 C** — the button is passed but is **`null` by the time it's read**: `event.currentTarget` nulls once dispatch ends, so **any handler that `await`s a confirm dialog before its write passes null** via the house `btn: ev?.currentTarget` inline form. All 12 controls fixed in this pass ran a dialog first.

  **Shape C survives every static check** — a grep for `btnId:`, a grep for `btn`, and a reading of the call site, which is idiomatic and matches the house pattern. It is wrong only in *when* it runs. **Capture `btn` synchronously at the top of the handler, before any `await`.** **Audit by whether the reference is live when it's read — never by whether the argument is present.**

  **Status: ✅ all 13 shipped 2026-07-17** — `74c5f83d` (the 12) and `b078697a` (`transition()`, with `ev` threaded through all three call sites). Verified live on the box by grepping the deployed files, not by trusting the hook. Note §5: for `Mark paid` the disable is **feedback, not safety** — the data is already safe for a fragile reason, recorded in `b078697a`'s commit message where the next person editing `retail.js:20767` will find it.
- **Error** — what happened + how to fix it. No apologies, no error codes as headlines. Inline banner, never a toast that flies in.

  **An error the operator can miss is not an error state.** A failed refund that only toasts, then vanishes, leaves the drawer looking exactly as it did before — the operator has no way to know the money didn't move. **A failed write renders where the operator is looking**, next to the control they pressed, and stays until acknowledged. Toasts are for confirmations, never for failures.

  **A section with bad data shows that it failed. It does not disappear.** Live Orders guards every drawer section with optional chaining, so a section with missing data renders nothing — indistinguishable from a section that legitimately has nothing to show. Absence must mean *empty*, never *broken*.

**Empty and no-results are the two most commonly conflated states in this product — and the live Orders page conflates them.** Search a customer who does not exist, on an account with 214 orders, and it says *"No orders yet."* Both halves are wrong: the fact, and the compliment. **Any page that filters ships both states.**

### 1.13 Overlay discipline

Pick by *what the operator is doing*, not by how much fits.

| Surface | Use when | Examples |
|---|---|---|
| **Drawer** (right, settles 350ms, ✕ + Esc) | Inspecting or acting on **one record** while keeping the list's context | Order detail, customer record, member edit |
| **Modal** (centred, ≤560px) | **One bounded decision**, finish or abandon. Never scrolls past one screen. | Refund amount, new order, bulk tracking |
| **Full page** | **Authoring** something with a draft state and a save | Pop-up editor, coupon editor, product page |
| **Hybrid** (drawer that expands to a full page) | One record that is *light to glance at* but *heavy to act on* — the quick look and the deep work are the same record at two zoom levels | Purchasing order detail + receiving · Products detail |
| **Popover** | Options that change the operator's own view, never the data | Filter menus |

A drawer never opens a drawer. A modal never opens a modal. If a flow needs that, it is a page.

**Form over wizard for recording, not creating (decided 2026-07-19).** When a full page's job is to *record something that already happened* rather than *walk a novice through a decision*, it is a **single-page form, never a multi-step wizard**. Purchasing's Record-order flow proved this: an A/B round put the old 3-step wizard beside a one-page form with identical content, and the wizard split one screen's work across three (two extra "Next" clicks on every order, a whole step hidden behind a "Change" link) while buying nothing — the representative step already contained the entire task. **The test: is the operator a repeat user logging a known thing, or a first-timer needing hand-holding?** Repeat-user-logging → one page, everything visible, tab-to-done. First-timer-deciding → a wizard may earn its steps. A daily buyer is the former; a wizard taxes them on every use. Record order is a one-page form: supplier · deliver-to · channel · expected date visible at once, lines below, two exits (Ghost "Save as draft" · Dusk "Record order"). The verb is **Record**, never Place — Tacet logs a purchase made elsewhere, it does not place it.

**The hybrid, and why it isn't an inconsistency (decided 2026-07-19).** Purchasing's order detail and Products' detail both open as a **drawer** (the same slide-in gesture as the Orders anchor, ✕ + Esc, list live behind) with an **Expand** control to a full page. This is *not* a second pattern competing with the Orders drawer — it **contains** the drawer pattern and adds one door. The operator learns one gesture (row → panel) that works everywhere; only the sections whose work is genuinely heavy add "…and expand when you need room." The escalation is earned by the task, never decorative: a customer order is a glance-and-act (drawer, full stop); a **receiving** screen is an editable multi-column grid — quantity steppers per line, short/rejected reasons, backorder decisions, a running received tally — that a drawer physically crowds (Cost/Total columns get squeezed) and a page lets breathe. **Consistency is "the same kind of task gets the same container," not "every screen behaves identically."** Forcing receiving into a drawer-only shell *to match Orders* would honour surface sameness and break the deeper rule. **Sibling requirement:** the quick-panel drawer and the Orders drawer must read as siblings — same header treatment, same close (✕ + Esc), same 350ms settle. Do not let a later survey style one to differ from the other, or "correct" the hybrid down to drawer-only for the sake of matching.

### 1.13a Pinned regions — sticky headers, and the two things that break them

*Added 2026-07-24, from the Orders pass. Two rules, both product-wide.*

**1. Every table with a scrolling list pins its column header row.** You scroll past two hundred orders and lose which column is Total and which is Placed. The header row sticks below the topbar; the KPI tiles, filter chips and the store/channel/search row scroll away above it normally. Applies to every A1 Worklist and A2 Library surface — Orders, Products, Customers, Purchasing, the Affiliate ledger, anything with a long table.

**2. A pinned region is a FIXED HEIGHT regardless of content.** A pinned block that grows when a record is messy is not pinned — and messy records are exactly when the operator most needs the thing to stay put. This killed the first drawer-header option on Orders: three pills wrapped to two rows and the "fixed" header doubled in height. **The pinned header shows ONE pill — the record's primary status. Additional marks go in the body below the pinned block**, in their §1.10a treatment. Verify by building the single-mark and worst-case frames side by side; the pinned block must be pixel-identical in both.

**The mechanism, which has to travel with the rule** *(§7's lesson — a rule that says what to do without why is one survey away from being "corrected" into a bug)*:

- **The pinned header must BE the card's top edge, not a band laid over it.** The card owns the rounded top corners and clips its contents; the header inherits that shape and draws no corner of its own. Do **not** give the header its own radius and try to match values — three rounds on Orders adjusted radii and the corner stayed doubled, because two elements were each drawing a corner. One element owns the shape.

  **🔴 The card clips with `clip-path: inset(0 round 14px)` — NOT `overflow: hidden`. This distinction is the entire rule, and the first version of it omitted the mechanism and was therefore unbuildable.** `overflow` in either axis makes the card a **scroll container**, and `position: sticky` pins to its nearest scrollport — so the header stops pinning to the page and starts pinning to the card, landing `top: 56px` *down from the card's own top*, squarely on row one. `clip-path` clips the corners without creating a scroll container, so the header still escapes to the page scroller. Both halves of the rule hold at once.

  *Two ways this bites, both live on Customers 2026-07-26:* (a) a brief that said "let the card clip" while also requiring the header to pin — the two are contradictory under `overflow` and only reconcile under `clip-path`; and (b) a page-level rule `#tab-x .list-card > .table-wrap { overflow-x: auto }` at specificity (1,2,0) silently beating a (1,1,0) override — `overflow-x: auto` computes `overflow-y` to `auto`, so the wrap became the scrollport and the band parked itself on row one. **Check every ancestor of the table for an `overflow` in either axis before concluding the header is fine.**

  **Alternative, if the card genuinely must not clip:** the header may draw its own top corners and flip them to `0` via a `.pinned` class once the card's top scrolls past. The radius must be **derived, not eyeballed** — the inner edge of a 1px border inside a 14px corner is **13px**. That number changes if the card's radius or border width changes. Prefer the `clip-path` version: it has no state to keep in sync.

- **The pinned header must be fully opaque and sit above all row content, including inset edge markers.** A header that's even slightly transparent looks fine over white rows and looks broken the moment a tinted row slides under it. Half of Orders' rows are tinted (`--td-unseen`), and the unseen row's inset Sage edge bled through the header twice before this was written down.

**3. The band's own values are PRODUCT-WIDE, and Orders is the anchor.** *(Added 2026-07-26.)* This is one component appearing on every table, not a per-page decision:

| property | value |
|---|---|
| background | `var(--td-header)` |
| label type | **13px Inter 500**, sentence case, `var(--td-text)` (Ink) — **not** `--td-text2` |
| padding | `10px 12px` |
| bottom rule | `1px solid var(--td-border)` |
| corners | none — the card owns them |
| z-index | 5 (under the topbar's 12, above the rows) |
| set height | none — the padding decides it |

**Do not re-decide these per page, and do not take them from a page's own mockup.** The Customers mockup had drifted to 12px labels with `5px 12px` padding, a hardcoded `#E4E0D5` bottom rule with **no dark-theme override** (a light hairline under a dark band, invisible in every light-mode screenshot), a hardcoded band colour, and `z-index: 3`. All four were followed for a round before the Orders values were checked. **Where a page's mockup and Orders disagree on this band, Orders wins.** 15px labels were tried on Orders and rejected — at that size the band reads as another row rather than a header.

**A band belongs to a full-width table, not to a card with padding.** Inside a padded card (e.g. the Customers drawer's Top items) a `th`-level band can only ever be the wrong width, because the `th` boxes span the table while the card owns the padding. There the header carries **no background at all** — a hairline alone separates it. Removing the band makes the alignment question disappear rather than answering it.

### 1.14 Components that had no rule

Two gaps the rebrand left. Defined here from Tacet primitives.

- **Avatar** — a **rounded square**, 8px radius, `--td-dusk-tint` fill, `--td-dusk` text, single initial, Inter 500. Sizes: 26 (table), 32 (row), 56 (header). **Never a circle.** (Team ships 50% circles today — invented in the absence of a rule.)
- **Link** — `--td-text` with a 1px underline at 60% opacity; solid on hover. **Never a new colour.** Tacet has no link blue, and Dusk is unavailable — a link is not an automation.

### 1.15 Voice

- Sentence case everywhere. **No exclamation marks — ever**, including good news.
- Buttons are verbs and keep their name through the flow.
- **Max one dry-warm moment per page.** If The Recap has it, the rest of the page is plain. Two jokes on one screen is a personality, and Tacet doesn't have one on purpose.
- **Feature names are plain** (Orders, Coupons, Channels) — **except AI surfaces, which may carry the musical layer.** The family: **The Recap** (daily digest) · **The read** (period analysis, Reports) · **Ask** (query the AI) · **Arrangements** (automation library).
  *Rule amended 2026-07-16.* `tacet-brand-concept.md` capped this at two. Reports shipped two more, they're good, and a rule broken within weeks by your own team is usually the thing that's wrong. **The bar is now: an AI surface, plus a decision.** Not an open door — a merchant-facing feature that isn't the AI speaking still gets a boring name.

### 1.16 Rebrand hygiene

- **No `fc-*` prefixes** → `t-*`. ~235 refs live (`fc-kpi` ×22, `fc-switch` ×8, `fc-inp` ×8, `fc-sec` ×8…). Dies per page.
- **No legacy semantic tokens** → `--text-1/2/3`, `--line`, `--bg-pane`, `--bg-app` (~922 lines). Replace with `--td-*` as each page is rebuilt.
- **No `roots-v2-*` storage keys** → `tacet-*`.
- **No page-scoped `:root` blocks.** Team carries one from `backend-team.html` (`html:10041`). There is exactly one token block.
- **Retire a control, retire its storage key.** The Orders View popovers were removed from markup, but `04-orders.js` still loads `retail-admin-order-detail-tweaks` (`:3721–3724`) and branches on `ODV.itemsLayout` on every drawer open (`:2733–34`). **Any operator who chose "cards" before removal still renders cards, permanently, with no UI to undo it.** Delete the orphaned code (~120 lines) and ignore the key.
- **Fix the dead link** — `html:1529` calls `goTab('activity')`; that tab no longer exists.
- `¥`, UTC+8, WeChat/Alipay, JD/kd100 are **tenant configuration**, not brand — they stay, parameterised.
- Wordmark always lowercase `tacet`. Never uppercase, never a serif substitute, never redrawn freehand.

### 1.17 Honesty — what a page is allowed to claim

*Added 2026-07-26, harvested from the Customers build — the only section taken end-to-end to production. Eight rules. All eight govern what the operator meets on screen; rules 7–8 have their cause on the server and their damage on the page (scope settled v2.9 — see below).*

**Why this section exists.** §1.7 already carries an honesty rule (a status line needs a real wired number) and §1.12 already carries one (empty is not no-results). They were written where they were needed and never gathered. Meanwhile the Customers build produced six more of the same kind and they had nowhere to live, because this document governs **how a page is assembled** and these govern **whether what it says is true**. A rule with no home gets rediscovered instead of applied. This is the home.

**How each rule is known.** The Dusk-pill error — three canonical documents asserting a pill that ships Ink — was a claim about code nobody in that session had opened. Every rule below is graded so that failure cannot repeat silently:

- **DID** — that session wrote the fix. Strongest.
- **MEASURED** — a number was counted against real data.
- **CONFIRMED ×2** — a second section has since hit the same rule independently.

**A rule graded neither DID nor MEASURED does not belong in this section.** Add one only with its grade attached.

---

**1. One word, one measure.** *(DID)*

If two surfaces show a number under the same word, they compute it the same way. If the two numbers must differ, they get different words.

The Customers list read `lifetime_spend` — order subtotal, pre-discount. The drawer computed `revenue` — order total, post-discount, shipping-inclusive. Same word on screen, two measures, **disagreeing for every customer who had ever spent anything.** The drawer now sums subtotal to match. `lifetime_spend` is untouched because customer tiers derive from it.

*The test:* for every number on a page, name the expression behind it. Two numbers sharing a label and not an expression is a bug, not a nuance. *Known residual, recorded not chased:* a partial refund never reduces `lifetime_spend`, so a freshly computed figure can sit slightly below the stored one.

**2. An unmatched value renders as unknown — never a plausible default.** *(DID · CONFIRMED ×2)*

Classify by inclusion. A denylist accepts everything invented after it was written, and a fall-through default lies with the full authority of a correct answer. **Visibly odd beats plausibly wrong.**

Customers: `chanIcon('manual')` returned a WeChat glyph on every manual order row because the lookup ended `|| CHAN_ICON.wechat`. `topup_total` excluded `admin_adjust` and nothing else, so redemptions were summed as top-ups — two negative balances, and **a genuine ¥1,000 top-up understated as ¥18.60.** The negative looked wrong and was caught; the small positive never would have been.

**Orders confirmed it independently 2026-07-26:** `ordChannelLabel` ends in a bare `return 'WeChat'`, so any channel outside its four branches — `eleme` is the live candidate — is **labelled WeChat on every row**. The same survey found `chanIcon`'s `|| CHAN_ICON.wechat` still present; adding the `manual` key made it unreachable for known channels without removing the fallback. `csName` is the correct shape in the same product: it falls through to `|| ch` and renders the raw key.

*The test:* feed the lookup a value it has never seen. If the output is indistinguishable from a real answer, it is a lie with a default's alibi.

**3. A failure never looks like a healthy zero.** *(DID)*

A data source that fails must return something a page can tell apart from a genuine zero. Never catch-and-return-zero.

The Customers diagnostics endpoint wrapped everything in try/catch and returned `error_count_7d = 0` on failure — **byte-identical to a healthy customer.** A broken system read as an all-clear, which is the worst direction for this failure to point.

This is §1.12's error state seen from underneath: **a page can only render the error state if the data layer distinguishes error from empty.** Six states on the page requires the same six being reachable in the data.

*The test:* force the failure. If the screen looks like success, the contract is broken regardless of how the page is written.

**4. A collapsed summary describes the whole, not the slice that happens to be loaded.** *(DID)*

A count on a collapsed accordion, card or row states the size of the **full set**. If only part is loaded, it says the total or it says nothing.

Three Customers summaries were lying at once. Recent orders and Points ledger showed **the length of a truncated list** — a customer with 48 orders read "10". Points ledger additionally labelled the figure "earned" when it was neither earned nor complete.

*The test:* open a record with more items than the truncation limit. The collapsed number must not be the limit.

**5. A control that can never match anything comes out. A control that matches nothing today stays.** *(MEASURED)*

The distinction is the whole rule, and it is the difference between removing a dead control and removing a capability.

Every meituan order (162) and gzgrocery order (104) carries `customer_id IS NULL`. Those two channel filters have matched zero customers since the day they shipped and always will — **empty by construction.** Removed. Web (1) and Manual (0) stayed: **empty today, for this tenant, this week.**

Read this against **§1.1b** — Roots is one tenant. "Nothing here now" is a fact about a sample of one; a merchant segment may run its whole business through the channel your reference tenant has never used. Only a structural impossibility justifies removal.

*The test:* is the emptiness a property of the data model, or of this tenant's current data? Name which. If you cannot, it stays.

**6. A label the operator never supplied is invented, not derived.** *(DID — by declining to build it)*

The Customers mockup showed "Home" and "Office" on saved addresses. `retail_customer_addresses` has **no `label` column** — the mockup's labels were demo data. Deriving one from `district` was considered and rejected: it would put a name on the customer's address that the customer never chose, and it would look exactly as authoritative as one they had.

*The test:* can you point at the field the operator or customer typed? If not, the page is speaking for them.

---

**Rules 7 and 8 — what a form promises.** *(Placement settled 2026-07-26. v2.8 filed these as "server rules, scope unresolved"; that framing was wrong and is retired.)*

Both are fixed on the server and **both fail on the screen.** Rule 7 fails as *the create form and the edit form disagree about what is allowed* — one product contradicting itself, and a bypass for anyone who notices. Rule 8 fails as *the operator cannot correct a typo in a name* because that record shares a phone number with another, which the page reports as a refusal it never explains. Neither is something an operator experiences as a server behaviour; both are things they experience as the page being wrong.

**The placement test, product-wide:** a rule belongs in this document when its **damage** lands on a page, whatever layer its **cause** sits in. Sorting rules by the layer they are fixed in scatters them away from the surface where they are noticed — and the fix is written by whoever reads the brief, not by whoever reads the taxonomy.

*Why not `PERMISSIONS_PLAN.md`:* that document owns **who may perform an action**. These own **what counts as a valid value**. Filing them there puts them under a heading nobody would search.

**7. Every check on the create path exists on the edit path.** *(DID)*

Otherwise create-then-edit is a working bypass of both.

`POST /customers` validated email format and checked for duplicate phones. `PATCH /customers/:id` did neither. Anyone could create a clean record and immediately edit it into a state create would have refused. Both checks were added to the edit path.

*The test:* list every check on create, then find each one in the edit handler by symbol. A missing one is a bypass, not an oversight.

**8. A uniqueness check fires only when the value is changing.** *(MEASURED)*

The rule is *don't create new collisions*, never *refuse to touch old ones*.

**17 customers already share 4 phone numbers.** A duplicate check running on every save would have permanently rejected all 17 — blocking an operator from fixing a typo in a **name**, on a record whose phone they never touched. The check compares only when the field is actually changing.

*The test:* take a record that already violates the constraint and edit an unrelated field. If it refuses, the check is punishing history instead of preventing recurrence.

---


## 2. The archetypes

Seven. Each answers a different question, so each earns a different layout. Everything in §1 applies to all of them.

---

### A1 · Worklist — *"What needs me right now?"*

Records that **arrive**. The operator processes them; they didn't author them. Dense, scannable, live.

> **Proven by the Orders anchor round, 2026-07-16.** Three layout directions were built on Orders; the winner is this one. Two theses died on contact and both are recorded here as rules: (1) **columns cannot be collapsed into the drawer** — Store, Items, and Ship to are load-bearing on Orders, which killed the "quiet list" direction outright; (2) **the pulse must scale** — a fixed tile grid hollows out on Reviews and Feedback, which have no pulse to show. A1 generalizes across all six Worklists *on the condition* that the pulse is authored as a scaling component.

```
header (title / status line / one Dusk CTA)
─────────────────────────────────────────────
pulse         [ tile ][ tile ][ tile ]           ← real pulse → tiles, 4 max
   …or…       8 reviews · 3 need reply           ← thin pulse → one line. Same slot.
filter chips  ( All )( Pending 3 )( Paid 12 )…   ← primary axis, live counts
filter chips  ( All )( Mini app )( Web )…        ← orthogonal axis, optional
toolbar       [ store ▾ ] [ search ] [ Bulk… ]
─────────────────────────────────────────────
table                                            ← rows are buttons → drawer
─────────────────────────────────────────────
pager                                            ← where the set is unbounded
```

- **The pulse region scales — tiles or a line, never an empty grid.** This slot sits directly under the header on every Worklist, always in the same place, always the same component. What it renders depends on how much the page has to say:
  - **Tiles** where there's a real pulse — up to 4, one row, never two. Number 30px tabular, label above (13px), delta below. Down deltas Graphite. A tile may jump to a matching filter. *(Orders: 3 tiles. Products, Customers, Purchasing: likewise.)*
  - **One summary line** where the pulse is thin — `8 reviews · 3 need reply`. Same slot, same weight, one line. *(Reviews, Feedback.)*

  **Never render empty tiles to fake density, and never leave the slot blank.** A page with two numbers worth showing gets a line, not three tiles with `—` in them. This is one component with two renders, not two archetypes — it is the condition on which the Worklist generalizes across all six pages, and it was the finding of the Orders anchor round.
- **Filter chips, not a `<select>`** — the primary axis is always chips, counts inside. A second orthogonal axis gets a second strip; a third goes in the toolbar. Active: Ink fill, Paper text.
- **Table** — hairline rows, no zebra, no vertical rules. Header 13px Inter 500 Graphite, sentence case. Rows are clickable buttons with visible keyboard focus; `›` is the only affordance cue. Numeric columns right-aligned, tabular. Horizontal scroll rather than hiding columns.
- **Pagination where the set is unbounded** (Orders is server-paged 50/100/200). Where it isn't, one fetch refreshed in place.
- **No refresh button, no live indicator.** The list updates itself — push plus a slow backstop, pausing when the tab is hidden or the operator is typing. New rows fade in. The operator should never have to ask a Worklist whether it's current. *(Live Orders behaviour; make it the rule.)*
- **Status cells stack** — see §1.10a. Max 3 pills + 2 note-lines. Design the worst case.
- **Row → drawer.** Always. Never a page, never a modal.
- **Read-only records** (marketplace mirrors) render at 100% legibility, 0% affordance: no NEW mark, no chime, no actions, italic "view only", view-only drawer.
- **Empty and no-results are both required** (§1.12). A Worklist filters; a page that filters needs both.

**Assigned:** Orders · Customers · Products · Purchasing · Reviews · Feedback

---

### A2 · Library — *"What have I made?"*

Objects the merchant **authors**. Finite, browsable, each with a lifecycle. A shelf, not a queue.

```
header (title / status line / [ New coupon ] ← Dusk)
─────────────────────────────────────────────
segment       [ Live 3 ][ Scheduled 1 ][ Ended ][ All ]
toolbar       [ search ]                        [ count ]
─────────────────────────────────────────────
rows / cards  ← name · lifecycle badge · window · one metric · ›
```

- **Segment, not chips.** A Library filters by lifecycle — one ordered axis. Chips say "many axes". The difference is load-bearing: it's how an operator knows at a glance which kind of page they're on.
- Each item: name, lifecycle badge, its window, **one** performance number. Resist the second metric.
- Item → **full-page editor** (A3), not a drawer. Authoring has a draft state; drawers don't.
- Empty state names the first thing to make: *"No coupons yet — your first one takes about a minute."*
- Media is a **grid variant** (thumbnail replaces name), not an eighth archetype.

**Assigned:** Coupons · Flash sales · Pop-ups · Broadcasts · Copy/snippets · Media · Legal · FAQ

---

### A3 · Composer — *"Does this look right?"*

Two panes. Controls left, live preview right. Reached from a Library, never from the rail.

```
[ ← Coupons ]                          [ Save ] [ Publish ← Dusk ]
──────────────────────────────┬──────────────────────────
 controls (520px)             │  preview (sticky)
 grouped fields, one column   │  real data, phone frame
 ↓ scrolls                    │  where it ships on a phone
```

- **Back link, in place of the title's first line.** `← Coupons` returns to the parent Library. The only archetype whose header differs, because it isn't a destination. (Pre-2026-07-24 this read "not a section label"; the label is retired — the back link now stands in for it, and a Composer carries **no status line**: a thing being composed has no section state to report.)
- **Preview is live and honest.** Updates as fields change (settled, 200ms). Real merchant data, never lorem. Where the artifact ships inside a phone (pop-ups, share cards, mini-app pages) it wears a **phone frame** — the merchant is designing for their customer's phone and the desktop admin must not let them forget it. *(`#tab-sharing .sc-spreview` already does this.)*
- **Publish is Dusk. Save is Secondary.** Draft/live is stated in words, never left to colour alone.
- Fields grouped under 18px section titles; each group answers one question. Labels above inputs, 13px Inter 500.
- Leaving with unsaved changes prompts once, quietly.

**Assigned:** Mini App Editor · Product Page Editor · About page · Share cards · and the editor half of Pop-ups, Broadcasts, Coupons, Flash sales

---

### A4 · Console — *"How should this behave?"*

Configuration. Read rarely, changed rarely, must be unambiguous.

```
header (title / status line / no Dusk CTA)
─────────────────────────────────────────────
master switch card   [ Affiliate       (•—) ]
                     "Off. Nothing is running."
─────────────────────────────────────────────
group card           Section title
                     row: label / description        [control]
                     row: …
group card           Section title
                     …
```

- **No Dusk CTA.** Config saves inline or per-group; a global "Save changes" is Secondary, pinned to the group it saves. Nothing here is the AI acting.
- **Master switch first**, own card, consequence in words: *"Off. Nothing is running."* / *"On. Codes are being issued."*
- Master off → groups below **visible but disabled at 55%**, never hidden.
- Rows: label + one-line description left, control right-aligned. One control per row. Never two switches on one line.
- **Every group needs a stable id** — the command palette jumps to individual setting cards. Decide the convention before eight Consoles exist.

**Assigned:** Settings · Delivery · Affiliate · Social proof · Membership · Top-up · Leaderboard · Voting · Team

*Team is a Console + a member list. `tm-enforce` is its master switch. Member Edit opens a **drawer** (§1.13 — one record, keep list context). Role pills are neutral, not status colours (§1.10).*

---

### A5 · Board — *"Is everything connected?"*

A grid of cards, each an external system with a live status. A status glance, not a worklist.

```
header (title / status line / [ Connect channel ] ← Dusk)
─────────────────────────────────────────────
[ card         ] [ card         ] [ card         ]
  glyph  name      glyph  name      glyph  name
  ● Connected      ▲ Needs setup    ● Connected
  2 metrics        one line: fix    2 metrics
  Manage →         Set up →         Manage →
```

- Cards equal size, 2–3 up, stable order. A disconnected channel **keeps its slot** — an absent channel is information.
- One status dot per card (Sage / Amber / Brick / Dusk-while-syncing). One link out, bottom-right, `Manage →`.
- Max two metrics per card. A channel card is not a dashboard.
- Card → the channel's own admin, in place, via `salesGo()`. Those sections have **no rail entry** — the Board is their only door, which is why the Board must be complete.
- Channel admins (Meituan, gzgrocery, Eleme) are **A4 Console + a read-only A1 below** — configured here, mirrored, never driven. No eighth archetype.

**Assigned:** Sales. Channel detail: Meituan · gzgrocery/Guanyi · Eleme

---

### A6 · Digest — *"Is everything okay?"*

Read-mostly. Narrative before data. The archetype the brand lives in.

```
header (title / status line / no CTA)
─────────────────────────────────────────────
THE RECAP           ← always first, full width, --td-raised
  "While you were away"
  · 214 orders processed          ← Dusk dot per row
  · 3 issues resolved
  "You're welcome."               ← the page's one dry-warm moment, spent here
─────────────────────────────────────────────
needs you (self-hiding)
─────────────────────────────────────────────
everything else     ← metrics, feed, shortcuts
```

- **The Recap is always first** and is the reason this archetype exists. It is the brand in component form. Get it right before anything else on the page.
- **Order is fixed: Recap → needs you → everything else.** Never reorder. Never let a metric strip outrank the Recap.
- "Needs you" self-hides when empty. **An empty attention area is deleted, not shown as an empty state** — the one place where absence is the message.
- The dry-warm moment is spent in the Recap. Everything below is plain.
- **No date range.** The Digest's question is *now*. A date picker means it's a Report (A7).
- **Setup guide is a Digest variant:** progress line + ordered step cards, one live step, hides at 100%.

**Assigned:** Dashboard · Open your store

---

### A7 · Report — *"What happened over this range?"*

Range-scoped analysis. Read and understand, not read and act.

```
header (title / status line / no Dusk CTA)   [ Jun 7 – Jul 6 · 30 days · all stores ]
─────────────────────────────────────────────
range bar    [ Today ][ 7d ][ 30d ][ 90d ]  [from]–[to]  [store ▾]  [ Apply ] [ ↻ ]
─────────────────────────────────────────────
chapter rail  Overview | Sales | Customers | Products & traffic
─────────────────────────────────────────────
KPI strip     [ tile ][ tile ][ tile ][ tile ]
─────────────────────────────────────────────
THE READ      ← the AI's plain-words analysis. Dusk lives here.
─────────────────────────────────────────────
charts        one question per chart
```

**Why this is not a Digest:** a Digest answers *now* and has a fixed order with The Recap first. A Report is range-scoped and chaptered, and has no Recap. Forcing it into A6 would break A6's fixed order — the rule that makes The Recap always first.

- **Range bar directly under the header**, with a range echo ("Jun 7 – Jul 6 · 30 days · all stores") right-aligned in the header, `data-no-i18n`. Store filter hidden until 2+ stores (§1.9, data precondition).
- **Apply is Secondary.** The Dusk on a Report belongs to **The read** / **Ask** — the AI's voice — not to a date button. *(Already correct on the box. The CSS comment at `css:7897` claiming Apply is the Dusk element is **stale**; the code is right, the comment is wrong. Delete the comment.)*
- **Chapter rail is a sub-view strip** (§1.7), not chips: it swaps content, it doesn't narrow records.
- **The read sits above the charts**, not below. Plain words first; evidence after. This is the brand — state the outcome, imply the effort.
- Charts: no gridlines, no axis box, no gradient. One accent per chart, and only if it means something.
- **Chart container ids are load-bearing** — the phone dashboard clones by id (`rmRenderDash`). Chapters show/hide wrappers only. Do not rename ids during the rebuild without checking mobile.

**Assigned:** Reports

*Note: `reference/reports-ai-mockup.html` is cited in the source as this page's spec and is **not on the box**. A7 above is derived from the live markup. If the mockup surfaces, reconcile.*

---

## 3. Component contract

Shared components live in one place and are never re-implemented per page. Build order — each is needed by what follows:

1. **Page header** — three elements per §1.7: title (one language rendered; both strings in source, §1.11) · status line (only when a real number backs it, §1.7 honesty rule) · Dusk CTA slot (may be empty). **Section label retired 2026-07-24.** **No purpose line** — cut 2026-07-17, still cut; the status line is not its return, §1.7. Needed by all 34.
2. **Button** (Primary/Secondary/Ghost/Destructive) · **Card** · **Badge** (Sage/Amber/Brick/Dusk-auto) · **Input + Label** · **Dusk dot** · **Avatar** · **Link** · tabular-number utility.
3. **KPI tile** + strip (A1, A7) · **Filter chip strip** with live counts (A1) · **Data table** (A1)
4. **Segment control** — serves both A2's lifecycle filter and the A7/§1.7 sub-view strip. One component, two active-state treatments.
5. **Drawer** shell (A1, A4) · **Modal** shell · **Popover** shell
6. **Master switch card** + **setting row** (A4)
7. **Channel card** (A5)
8. **The Recap** (A6) — build first among the signature pieces; it sets the voice for everything.
9. **The read** (A7) · **Empty state** · **Error banner** · **Skeleton**

If a page needs a component not on this list, that's a conversation before it's a mockup.

---

## 4. Section → archetype — all 34

From `tacet-ia-blueprint.md` v2.0 §4. Batches are the build order.

| # | Section | tab id | Archetype | Batch | Notes |
|---|---|---|---|---|---|
| 1 | Orders | `orders` | **A1 Worklist** | **0 — anchor** | Hardest page. Proves the direction. Absorbs fapiao as a filter. |
| 2 | Dashboard | `dashboard` | **A6 Digest** | 1 | The Recap lives here |
| 3 | Reports | `reports` | **A7 Report** | 1 | Proves the new archetype |
| 4 | Customers | `customers` | A1 Worklist | 1 | ⇄ Orders drill-through |
| 5 | Products | `products` | A1 Worklist | 1 | + 3 sub-views; resolve the `#tb-subviews` duplicate |
| 6 | Settings | `config` | **A4 Console** | 1 | Proves Console + the setting-id convention |
| 7 | Team | `team` | A4 Console | **1** | Pulled early: RBAC gate + it shipped raw today |
| 8 | Coupons | `vouchers` | A2 Library + A3 | 2 | Proves Library + Composer |
| 9 | Flash sales | `flash` | A2 Library + A3 | 2 | |
| 10 | Pop-ups | `popups` | A2 Library + A3 | 2 | Phone-framed preview |
| 11 | Share cards | `sharing` | **A3 Composer** | 2 | Already has `.sc-spreview` |
| 12 | Broadcasts | `broadcasts` | A2 Library + A3 | 2 | |
| 13 | Affiliate | `affiliate` | A4 Console | 2 | feat `affiliate` |
| 14 | Social proof | `social` | A4 Console | 2 | feat `socialProof` |
| 15 | Delivery | `delivery` | A4 Console | 3 | `data-dlv="hub"` |
| 16 | Purchasing | `purchasing` | A1 Worklist | 3 | Shell + `#prod-view-purchasing`; fix `order:9` |
| 17 | Sales | `sales` | **A5 Board** | 3 | Proves Board. Only door to 3 sections. |
| 18 | Meituan | `meituan` | A5 detail (A4 + read-only A1) | 4 | China-only |
| 19 | gzgrocery / Guanyi | `guanyi` | A5 detail | 4 | China-only |
| 20 | Eleme | `eleme` | A5 detail | 4 | China-only |
| 21 | Membership & points | `membership` | A4 Console | 4 | feat `membership` |
| 22 | Top-up | `topup` | A4 Console | 4 | |
| 23 | Leaderboard | `leaderboard` | A4 Console | 4 | |
| 24 | Voting | `voting` | A4 Console | 4 | |
| 25 | Mini App Editor | `mini-app-editor` | A3 Composer | 5 | `/cms` embed |
| 26 | Product Page Editor | `product-editor` | A3 Composer | 5 | swap-in |
| 27 | About page | `about` | A3 Composer | 5 | |
| 28 | Copy / snippets | `snippets` | A2 Library | 5 | |
| 29 | Media library | `media` | A2 Library (grid) | 5 | |
| 30 | Legal pages | `legal` | A2 Library | 5 | |
| 31 | FAQ & help | `faq` | A2 Library | 5 | feat `faq` |
| 32 | Reviews | `reviews` | A1 Worklist | 6 | Topbar inbox |
| 33 | Feedback | `feedback` | A1 Worklist | 6 | Topbar inbox |
| 34 | Open your store | `setup` | A6 Digest (progress) | 6 | hides at 100% |

**Batch 0 = Orders + global chrome + the §5 fixes.** Chrome (rail, topbar, command palette, drawer/modal/popover shells, The Recap) is not a page and must not be redesigned per batch — that's how the mobile shell was done and it's why it held.

**Coverage: 34 of 34. Seven archetypes. No page without a home.**

**Satellites (not in the 34, `tacet-ia-blueprint.md` §11):**

| Satellite | Archetype | Notes |
|---|---|---|
| **Profile** (`/backend/account`) | **A4 Console**, in a satellite document | Four sub-views: My Info · Security · Devices · Notifications, navigated by the **in-page strip under the header** (house pattern, §1.1a row 2) — **not** the live page's left rail, decided 2026-07-19: a satellite may keep its own chrome, but adopting the strip makes Profile read as part of Tacet and removes a rail/strip ambiguity for future surveys. The live rail is the backlog, not the reference. Devices is Team's shape — Console + a session list — one operator wide. **Zero Dusk on the whole surface**: password, 2FA, and sessions are the operator acting, never the AI (§1.8, same reasoning as the Sales toggles). No master switch — identity has no off. No sign-in-identifier field and no role line exist on the live surface (verified against the live pop-up 2026-07-19; the role styling is dead — remove in cleanup). §1.1/§1.1a govern pages in the shell; a satellite ships the brand rules (§1.2 values · §1.6 · §1.8 · §1.10 · §1.11's one-language principle · §1.12's six states) without the shell's chrome. No ninth archetype. |

---

## 5. Batch 0 — the global fixes

Not owned by any page; cannot wait for Batch 6.

| # | Fix | Where |
|---|---|---|
| 1 | CJK fallback `IBM Plex Sans SC` → **Source Han Sans SC** | `css:82, 83, 7953, 9273` |
| 2 | `--td-dusk-hi` light override → `#5F58A0` | `css:7929` block |
| 3 | Wrong-brand fallbacks `#fbfaf6` / `#55554c` | `css:2121, 2156` |
| 4 | `--accent` (tea) in charts → `--td-sage` | `css:7945` |
| 5 | Stacked shadows → one | `css:1285, 1692` |
| 6 | Delete orphaned View-tweak code + ignore its storage key | `04-orders.js:794–828, 2733–34, 3721–3753` |
| 7 | Dead link `goTab('activity')` → Products + `prodShowView('activity')` | `html:1529` |
| 8 | Assign `TAB_CAP` for `team`, `sales`, `setup`, `product-editor`; delete orphan `integrations` | `01-core.js:144` |
| 9 | Remove Team's page-scoped `:root` block | `html:10041` |
| 10 | Tokenise space / shape / motion / type as `--td-*` | new |
| 11 | Delete the stale one-Dusk comment on Reports | `css:7897` |

---

## 6. New-feature gate

Before any mockup of anything new:

1. **Which archetype?** One of the seven. Name it.
2. **If none fits** — is it a new *job*, or a variant? Media is a Library grid, not an eighth archetype. Channel admins are Console + read-only Worklist, not an eighth. **An eighth archetype requires a job that is not:** records arrive · things I made · author with preview · configure · connection status · read the situation · analyse a range. That bar has been cleared exactly once (Reports).
3. **Where does the one Dusk go?** If the answer is "two places", the page is two pages.
4. **What are its four states?** Loading, empty, error, populated. All four ship or the page doesn't.
5. **What does it look like gated?** All three axes (§1.9).
6. **Run §7.** Zero on every row.

---

## 7. Audit — executable

Run before a page leaves Claude Design and before any commit. **These are numbers, not opinions.** Every one only goes down.

```bash
# Uppercase — the visual signature of the dead brand
grep -c 'text-transform: *uppercase' public/retail-admin.css              # 109 → 0

# Primary buttons painted Ink instead of Dusk
grep -rn 'btn-primary\|\.primary' public/retail-admin.css | grep -c 'td-text'   # ~5 → 0

# Legacy class layer
grep -rho 'fc-[a-z0-9-]*' public/retail-admin.html public/retail-admin/*.js | wc -l   # ~235 → 0

# Legacy semantic tokens  (--line may over-match --line-height; verify before quoting)
grep -c 'text-1\|text-2\|text-3\|bg-pane\|bg-app' public/retail-admin.css # ~922 → 0

# Rogue token blocks
#   NOT a count. `grep -c ':root' retail-admin.css` = 34 and always has:
#   7 global token blocks (4 of them the --td-* group, incl. the --td-paper
#   pair at :7961-7962), ~23 theme-scoped element overrides (the house
#   pattern, fine), 4 in comments. The old "→ exactly one" expectation
#   could never pass. See §1.2.
grep -n ':root' public/retail-admin.css | grep -v 'data-theme="light" '   # → no NEW --td-* group; no page-scoped :root
grep -c ':root' public/retail-admin.html                                  # → 0

# Wrong CJK face
grep -c 'IBM Plex' public/retail-admin.css public/retail-admin.html        # → 0

# Stacked shadows
grep 'box-shadow' public/retail-admin.css | grep -c ','                    # → overlays only

# Half-pixel sizes
grep -c 'font-size: *[0-9]*\.5px' public/retail-admin.css                  # → 0

# Fraunces in the admin
grep -c 'Fraunces' public/retail-admin.css public/retail-admin.html        # → 0
```

**Per-page checklist**

*Brand*
- [ ] Exactly one Dusk CTA — or zero on a Console
- [ ] Dusk only for automation or the primary action; Ink only for selection
- [ ] No uppercase · no Fraunces · no gradients · no shadow on a resting card
- [ ] No exclamation marks; max one dry-warm line
- [ ] Text on a tint uses the `-ink` variant
- [ ] Wordmark lowercase

*Structure*
- [ ] **§1.1a region order** — header · sub-view strip (if the section has one) · tiles · segment chips · filter row · table. None reordered, none skipped
- [ ] **Filter row is two dropdowns + one wide search.** No chips outside the segment row, no dividers
- [ ] **Table header `--td-raised` on white rows. Every header single-line** — a sub-label means the header is wrong
- [ ] **Put it next to Orders.** Same product, same hand, same day — or it isn't done
- [ ] **Nothing in the brief traces to a live un-rebuilt page.** That page is the backlog, not the reference (§1.1a)
- [ ] Standard page header, standard order
- [ ] Correct archetype per §4, and it looks like its siblings
- [ ] Content column 1120px
- [ ] Filter chips vs sub-view segment used correctly (§1.7)
- [ ] Overlay type matches §1.13
- [ ] Shared components used, none forked
- [ ] **It's a page, not a specimen sheet** — no captions between rows, states on their own screens (§0)

*Substance*
- [ ] All six states: loading, in-flight, empty, no-results, error, populated
- [ ] Empty is a compliment and names what arrives · no-results is separate · every write control disables while writing · failures render where the operator is looking, never only a toast
- [ ] All three gated states designed (§1.9)
- [ ] Every number tabular · down deltas Graphite
- [ ] One language on screen, never glued · both strings exist in source · column widths survive 中文
- [ ] Keyboard: rows focusable, drawer closes on Esc, focus visible
- [ ] `prefers-reduced-motion` respected

*Implementation*
- [ ] Colour from `--td-*` — no hard-coded hex, no page `:root`
- [ ] No `fc-*`, no `--text-1/2/3`, no `roots-v2-*`
- [ ] Retired controls' storage keys retired too
- [ ] Real data wired, not mock
- [ ] Parity table: Kept / Restyled / Dropped-on-purpose / Missing, each with its verification method
- [ ] Diff reviewed before commit

---

## 8. The Full Circle test

The reference build's visual identity is **dead**. But some rules appear in both books — *one primary per screen*, *colour is status not decoration*, *hairlines not shadows*, *sentence case*. Those are **Tacet's own**, stated independently in `tacet-design-system.md`.

**The test is never *"did the reference build do this?"* It is *"does `tacet-design-system.md` say it?"*** If yes, it stays — because Tacet says so. If no, it goes.

What that kills, with its Tacet replacement:

| Dead | Replacement |
|---|---|
| Primary = Ink | Primary = **Dusk** |
| Mono uppercase eyebrow | **Nothing** — the sentence-case section label replaced it 2026-07-16, then was itself retired 2026-07-24 (§1.7). The page header opens on the title. §1.6's no-uppercase rule stands regardless. |
| Card radius 12px | **14px** |
| Two stacked shadows | **One**, overlays only |
| Info-blue = neutral | **Doesn't exist.** Tacet's near-blue is Dusk, and Dusk means *the AI acted* — a surviving info badge would say the opposite of what it means. |
| Circle avatars | **Rounded square** |
| Link `#3C5573` | **Ink + underline** |
| JetBrains Mono | **No mono face.** Machine data is tabular Inter. |
| Tea `--accent` | **Sage** |

`full-circle-design-system.md` is **retired as a reference.** Not consulted, not cited, not in any project instructions. It survives only as the evidence list above.

**The palette migration is already complete** — zero reference hexes remain on the box. What remains is the *structure* (`fc-*`, `--text-1/2/3`) and the *decisions* (Ink primaries, uppercase). The rebrand was done in paint; this document finishes it in judgement.

---

## 9. Companion docs — status

| Doc | Status |
|---|---|
| `tacet-design-system.md` | **Current.** The authority for look. |
| `tacet-brand-concept.md` | **Current**, one amendment: §1.15 widens the naming rule to AI surfaces. |
| `tacet-ia-blueprint.md` | **v2.0, current.** Surveyed from the box. |
| `tacet-tokens.css` | **Superseded** by the live `--td-*` block. Rewrite it to match the code, or delete it. Do not let it become a fourth scheme. |
| `tacet-orders.md` | **Stale.** Documents the View popover (removed) and Invoices as a tab (retired). **Do not use as a parity baseline** — an audit against it would restore features you deliberately removed. Re-survey during Batch 0. |
| `tacet-mobile-patterns.md` | **Stale.** Wrong bottom nav (spec: Home/Orders/Inbox/Sales/More; live: Dashboard/Orders/Customers/Products/More). Lists retired sections. Its anchor — "the desktop Orders screen already built" — is being demolished. **Needs v2. Its anchor is now stable** — Orders' design is final (2026-07-17), so mobile can be re-derived against it whenever it comes up. |
| `full-circle-design-system.md` | **Retired.** See §8. |

**Mobile alignment.** One archetype vocabulary across both devices. A Library is a Library: rows on desktop, cards on phone — same name, same job, different surface. Mobile v2 should be **re-derived from this document**, not patched. Two conflicts to resolve then: mobile puts Coupons/Flash/Broadcasts in its list→cards archetype (a queue) where desktop calls them Library (a shelf); and mobile's §7 anchors on an Orders page that no longer exists.

---

## 10. Open decisions

Small, non-blocking. Resolve during Batch 0.

1. **Rail 240px** — the reference was 232. 240 is on the 8px grid. Confirm.
2. **Setting-card id convention** — decide before eight Consoles exist; the command palette depends on it.
3. **`#tb-subviews` vs `#stk-views`** — Products' sub-view strip exists twice (topbar + in-page). Pick one.
4. **Cascade direction** — `:root` is dark, light is opt-in; the brand book says Paper is home. Leave the code, or align the doc? Recommend: leave the code, footnote the brand book.
5. **`reference/reports-ai-mockup.html`** — if it surfaces, reconcile against A7.
6. **Profile tokens — RESOLVED 2026-07-19: keep, self-contained.** The Profile satellite
   keeps its own `:root` (brand-correct values, own names). Reasoning: values are already
   correct so folding buys nothing today; the frozen-frame gap means the shared-theme
   payoff isn't collectable yet anyway; and Team's own `:root` block is precedent that a
   satellite owning its tokens is correct, not mess. Folding would be the "general
   instinct" tidy §1.2 warns against. **What the brief still requires:** correct the
   orientation to match the shell (dark-first, `[data-theme="light"]` the opt-in — it is
   currently light-first) and clear the §1.6 uppercase + the `.acc-*`/`.who-role` rot.

---

*v2.9 · 2026-07-26 (last of the day).*

**v2.9 changes — closes the one scope question v2.8 left open. No rule added, removed, or altered.**

**§1.17's rules 7 and 8 stay in this document, and the framing that made them look misplaced is retired.** v2.8 filed them as "the server behind a form — scope unresolved." That was sorting by the layer a rule is *fixed* in. The right axis is the layer its *damage* lands on: an operator does not experience "the PATCH handler lacks validation," they experience the create form and the edit form disagreeing about what is allowed. They do not experience "the uniqueness check has no change-guard," they experience being unable to fix a typo in a name. Both are page failures with server causes, and this document owns the page.

**The placement test is now written down** so the next borderline rule does not reopen the same argument: *a rule belongs here when its damage lands on a page, whatever layer its cause sits in.* Sorting by cause scatters rules away from the surface where they are noticed, and the person who acts on a rule is reading a brief, not a taxonomy.

**Recorded because leaving it open had a cost.** An undecided flag inside a document is the shape that produced the README's read-order table (wrong for weeks) and the §1.8 modal clarification (known and unwritten for six days). A scope question with no owner and no date is not a deferral; it is a rule that quietly stops applying. `PERMISSIONS_PLAN.md` was considered and rejected — it owns *who may act*, not *what is a valid value*.

Everything else unchanged from v2.8.

---

*v2.8 · 2026-07-26 (later still).*

**v2.8 changes — one new section, §1.17, harvested from the Customers build. No existing rule was altered.**

**§1.17 Honesty — what a page is allowed to claim.** Eight rules, gathered because they had nowhere to live. This document governs how a page is *assembled*; these govern whether what it says is *true*, and the two honesty rules already in the book (§1.7's wired-number rule, §1.12's empty-is-not-no-results) were written where they were needed and never collected. A rule with no home gets rediscovered instead of applied.

**Every rule carries a grade, and this is the part that matters.** The Dusk-pill error — three canonical documents asserting a pill that ships Ink — was a claim about code **nobody in that session had opened**. Inherited belief, passed document to document, never checked. Everything else in the Customers record is a different kind of knowledge: things that session **did** (the validation fix, the rewritten summaries) or **measured** (162 meituan orders, 690 rows backfilled, 17 customers on 4 phone numbers). §1.17 grades each rule DID / MEASURED / CONFIRMED ×2, and forbids adding an ungraded one. **Provenance is now part of a rule, not a footnote to it.**

**Rule 2 is already confirmed twice.** "An unmatched value renders unknown, never a plausible default" came from Customers (`chanIcon`'s WeChat glyph on manual orders; a ¥1,000 top-up understated as ¥18.60). The Orders survey hit it independently the same day: `ordChannelLabel` ends in a bare `return 'WeChat'`, so an `eleme` order is labelled WeChat on every row, and `chanIcon`'s fallback is still present. Two sections, one rule, no coordination — which is the evidence that it is a product rule and not a Customers habit.

**Rules 7 and 8 are marked as an open scope question, not settled.** Both govern the endpoint behind a form rather than the form, which stretches this document's remit. They are recorded here because a form and its validation are one thing to the operator using them, and because the alternative was losing them. **Decide whether they stay, or move to `PERMISSIONS_PLAN.md` or a data document.**

Everything else unchanged from v2.7.

---

*v2.7 · 2026-07-26 (later).*

**v2.7 changes — one correction, to §1.8 rule 5. Nothing else in the document moved.**

**A modal no longer owns its own Dusk. Modal primaries are Ink.** The prior rule reasoned from surface budget — a modal is its own visible surface with no header CTA to lose the tiebreaker to, so its confirm may take the Dusk. **The axis was wrong.** Dusk is semantic before it is budgetary: it means *tacet did this for you*, and an operator confirming their own action is the merchant acting no matter how much unspent budget the surface has. Rule 6 ("Config isn't the AI acting") was already reasoning semantically; rule 5 was the odd one out inside a single numbered list.

**This corrects a documented six-day gap between the rulebook and the product.** Three sections had already reached the corrected answer independently: Customers shipped Ink modal primaries **live** (`tacet-customers-addendum.md` decision 7, matching Team and FAQ), Marketing made confirm = Ink a group precedent (`tacet-marketing-addendum.md` precedent 8), and the CMS/FAQ pass recorded *"do NOT revert to Dusk"* (`tacet-cms-session-addendum.md` parked item 2.4). Both addenda named it "the known unwritten clarification" and neither wrote it. **A live page built correctly against an uncorrected rule is a trap** — the next survey reads §1.8, concludes Customers is wrong, and repairs a correct page into a bug.

**The §1.8 receipts list was corrected in the same pass, because that is where a retired rule hides.** `.cs-modal .btn-primary` sat on the owed-Dusk list purely on the strength of the old rule 5; it is a modal primary and Ink is now its finished state. The owed-Dusk count drops from five to three. This is the v2.2 lesson repeated — the section label came back in eight places — and it is why the list was corrected in the same version as the rule rather than left for a later sweep.

**One thing deliberately not decided:** `#tab-sales .mc-wiz .btn-primary` is now marked contested. The Sales design locks zero Dusk on that page while the receipts list says its wizard primary owes Dusk, and rule 5 does not settle it — the relay wizard is inline in `#sales-setup-host`, not a modal. Flagged for the Sales build rather than quietly resolved here.

**Narrow door kept open:** a modal whose primary action genuinely *is* the AI acting may take Dusk, per instance, with a reason recorded. No such modal exists in the product today.

Everything else unchanged from v2.6.

---

*v2.6 · 2026-07-26.*

**v2.6 changes — all three from the Customers rebuild, the first section taken end-to-end from mockup to live.**

**§1.13a's pinning mechanism corrected — the rule as written was unbuildable.** It said "let the card own the rounded top corners and clip its contents" while also requiring the header to pin. Under `overflow` those are contradictory: `overflow` in either axis makes the card a scroll container, `position: sticky` pins to its nearest scrollport, and the band lands 56px down from the card's own top — on row one. The mechanism is **`clip-path: inset(0 round 14px)`**, which clips corners *without* creating a scrollport. Both halves then hold. Two live failures recorded: the contradictory brief itself, and a page-level `overflow-x: auto` at specificity (1,2,0) silently beating a (1,1,0) override. The `.pinned`-class alternative is documented with its **derived** 13px (14px radius minus 1px border), never eyeballed.

**§1.13a gained rule 3 — the band's values are product-wide and Orders is the anchor.** 13px/500 Ink, `10px 12px`, `var(--td-border)` rule, `var(--td-header)`, z-index 5. Written down because the Customers mockup had drifted to 12px/`5px 12px` with hardcoded colours and a bottom rule that had **no dark-theme override** — a light hairline under a dark band, invisible in every light-mode screenshot taken that day. All four drifts were followed for a round before Orders was checked. Also recorded: a band belongs to a full-width table, not to a padded card, where a `th`-level band can only ever be the wrong width.

**§1.7 gained the work rule.** A status line reports **work waiting, not population** — *what needs me now*, never *how many exist*. The honesty and non-duplication rules already implied "no line is a valid answer"; this states the primary test and names the reference case. **Customers ships with the title alone, deliberately** — 693 records, none waiting on anyone. Three tests, all required: real · not duplicated · work not population.

Everything else unchanged from v2.5.

---

*v2.5 · 2026-07-25 (later still).*

**v2.5 changes:** **§1.1d added — the topbar is closed.** §1.1 described the bar's contents; a description can be added to by anyone who thinks their page is a special case. §1.1d forbids it: no page adds, removes, reorders, hides or restyles anything in the topbar, page controls go to the §1.7 header instead, and a sixth item is a deliberate act owned across all 34 pages. Scope stated explicitly — desktop shell pages only, satellites (§11) and mobile excluded. **Also fixed: §1.1a had no heading.** It is cited by §0's brief template, the README and the handoff — "read §1.1a first" — but its text sat unheaded under §1.1c, so anyone searching for it landed in the wrong section. Heading restored; no content moved. Everything else unchanged from v2.4.

*v2.4 · 2026-07-25 (later).*

**v2.4 changes:** the shell survey landed and four things fold in. **Bar height is 56px**, verified and cited — the earlier "owed from survey" placeholder is retired. **`#profModal` corrected**: it is a fixed-position overlay *inside* `.topbar`, not markup hanging off the avatar; the practical guidance is unchanged but the description was wrong. **`body.cobrand` recorded as a deliberate change** — live CSS *swaps* the merchant logo in and the tacet lockup out; the approved bar shows both, so the swap rule comes out at build. **§1.1c precondition 2 re-gated**: the `<h2>` audit returned **16 tabs**, and since only Orders owns a real header in code, the "every page first" gate would have held global chrome hostage to the whole rebuild. The gate is now *crumb removal + CSS narrowing in one change*, with plain `<h2>` titles as scaffolding. Everything else unchanged from v2.3.

*v2.3 · 2026-07-25.*

**v2.3 changes:** **§1.1's topbar contract replaced and the brand-to-rail move REVERSED**, decided by Ash 2026-07-25 from an approved seven-frame topbar mockup. The bar is **five visible items — brand block · spacer · search field · inbox · avatar** — locked, zero Dusk, with `#profModal` still hanging off the avatar as portal markup. §1.1c precondition 1 is **withdrawn with its reasoning kept on the record**: the brand stays in the topbar, the rail is untouched, and the risky re-point of `#brandLogoTop` never has to happen. **Precondition 2 is unchanged and still gates the change** — the crumb cannot go until every page whose `<h2>` is CSS-hidden owns a real §1.7 header, and that audit is still owed. Two rules new to the design system rather than here: the mark's small-size stroke, and the co-brand merchant-logo box (14px floor / 210px ceiling). Bar height is explicitly marked owed-from-survey so nobody builds against a guessed number. Everything else unchanged from v2.2.

**A note on how this one went wrong, because it is §1.1's failure shape a third time.** The 07-25 brief was written *before* §1.1 was read, so it re-derived a topbar contract from two screenshots — and produced one that contradicted a decision made the previous day. It was caught only because the amendment step forced a read of the section. **§1.1 has now been wrong three times: a stale code comment laundered through a survey (07-17), the rule outliving its buttons (07-17), and a design written from screenshots against an unread rule (07-25).** Read §1.1 before briefing anything that touches the shell — not after.

*v2.2 · 2026-07-24.*

**v2.2 changes:** **§1.7 page header amended — the section label is retired product-wide and a status line replaces it**, decided by Ash 2026-07-24 after comparing two Orders header treatments. The header is now **title · status line · one Dusk CTA** — still three elements, still no fourth. The section label ("Operations", "Marketing") was the rail group name repeated at the top of the page; the rail and `#tb-crumb` already say where you are. The status line carries live section state instead (*"142 open · 8 awaiting fulfilment"*), 15px Inter 400 Graphite, tabular figures, `" · "` separators, zero Dusk.

**The purpose line stays cut** (2026-07-17) and the status line is explicitly not its return — the test is *would this sentence be different tomorrow?* If no, it is the purpose line and it goes.

**A 🔴 honesty rule ships with it:** a status line appears only where a **real, wired number** backs it. No placeholders, no `—`, no invented figures. A section with nothing real to report shows the title alone, and that is a finished header, not a gap. Reason: Sales spent its entire life rendering `—` from an endpoint that did not exist (`tacet-sales-addendum.md`) — an unbacked status line rebuilds that failure at the top of all 34 pages at once. **Each section must name its number's source before its line is designed.**

**Downstream corrections in the same version** (the label survived in eight places, which is how a retired rule comes back): §1.1a region row 1 · §3 type table (label struck, status line added — §1.6's no-uppercase rule is untouched and still binds) · the archetype shared-component list · all six archetype header diagrams (A1 Worklist, A2 Library, A4 Console, A5 Board, A6 Digest, A7 Report) · A3 Composer's back-link note, which now also records that **a Composer carries no status line** — a thing being composed has no section state to report.

**A soft non-duplication rule ships alongside it:** the status line should report what the KPI tiles and chips don't — it is not a fourth copy of a count already on screen. Origin: the first Orders render stacked "142 open" (status line), "Orders today 214" (tile) and "All 214" (chip) within ~200px, three different measures with nothing explaining the disagreement. Ash chose the soft form deliberately over a hard ban: a ban would strand sections that honestly have nothing else to report and pressure them into inventing a second fact. **Where the two rules appear to conflict, the honesty rule wins** — a section whose only line would restate its chips shows the title alone. One fact is a complete status line.

**§1.1 TOPBAR REDUCED — eight children to four**, decided by Ash 2026-07-24 alongside the header amendment. The **brand/wordmark** and **page identity** (crumb + ⓘ mirror) are retired from the topbar; the rail-fold dot had already moved to the rail. The topbar becomes **search · inbox · avatar** — nothing in the chrome names the page. The brand moves to the rail, **which §1.1's Rail row has specified all along** ("wordmark top") — the topbar copy was the drift, not the decision.

**New §1.1c records the two preconditions**, both found by live survey and neither visible in the mockup that prompted the change: (1) the rail's brand marks are *hidden in live CSS* today, so the topbar `.brand` is currently the only visible wordmark on desktop — un-hiding the rail and removing the topbar copy must ship together, and the co-brand tenant logo (`#brandLogoTop`, `applyBrand()`) must be re-pointed or every merchant loses their own logo; (2) a live CSS rule **hides the in-content `<h2>` on Social, Vouchers, Sales and others** because the crumb was meant to name them — removing the crumb without restoring those headings ships those pages with no title at all. **Every page must own a real §1.7 header before the crumb goes.** An audit of which tabs are affected is owed and is a survey question, not a guess.

This is the mockup-omission pattern one level up: the target mockup showed a topbar with no brand and no crumb, but it had never *drawn* them — an absent element in a mockup is not a decision. The decision was made deliberately here instead, with the blast radius known.

**Not yet decided:** which sections can actually feed a status line. That is a Claude Code survey question, not a design one, and the honesty rule holds either way. Everything else unchanged from v2.0.

---

*v2.0 · 2026-07-19.*

**v2.0 changes:** **§1.1b gained the usage axis**, decided by Ash during the Media brief (2026-07-19). The one-tenant trap has two axes, and v1.5 named only the first: "my numbers are small, so cut it" (scale) now stands beside **"I don't use it, so cut it" (usage)** — both calibrate what should exist to a sample of one. New keep test: *would a plausible merchant segment need this within their first year?* Valid cut reasons unchanged (broken · dishonest · unsafe · duplicated · unreachable — those hold for every merchant). Usage evidence demoted from judge to advisor: it sets priority, never existence. Briefs must now name which test a keep/fold/cut passes (*broken* vs *merchant-need*) so the reasoning is checkable. Origin: Media tags, nearly cut on "does Ash tag anything?" — kept. Companion line added to `tacet-brand-concept.md` (v1.2) Audience section. Everything else unchanged from v1.9.

**v1.9 changes:** **Satellites recognised** — a new category, `tacet-ia-blueprint.md`
§11, for real applications reached from the shell but not riding it (own document, own
`:root`, own i18n): Profile (`/backend/account`) and Login. Three surveys missed Profile
because this category didn't exist; it does now. Profile assigned **A4 Console** (§4,
new satellites table) — Devices is Team's Console-plus-list shape, one operator wide —
with **zero Dusk anywhere on the surface** (password/2FA/sessions are the operator
acting, never the AI) and no master switch (identity has no off). §10 gained a sixth
open decision: fold Profile's own `:root` into `--td-*`, or keep it self-contained
(Team's `:root` is precedent for self-contained) — decide before the Profile brief is
written. No new archetype; the 34-section count is unchanged. Everything else unchanged
from v1.8.

**v1.8 changes:** **§1.13 gained the form-over-wizard rule**, decided by Ash after an A/B round on the Record-order flow: a full page that *records* something already done is a single-page form, never a multi-step wizard; the wizard is reserved for a first-timer deciding, not a repeat user logging. Record order locked as a one-page form; verb is "Record", never "Place". This completes the Purchasing section design (Overview · Orders · Suppliers list + card · Bills + bill modal · Order detail/receiving · Record order). Everything else unchanged from v1.7.

**v1.7 changes:** **§1.13 gained the hybrid container** (drawer-that-expands-to-a-page), decided by Ash during the Purchasing order-detail round. Purchasing order detail + receiving and Products detail both use it: drawer for the glance, Expand to a full page for heavy receiving work. Documented as *containing* the Orders drawer pattern, not competing with it, with a sibling requirement so the two drawers stay visually identical and a note against a future survey "correcting" it to drawer-only. Everything else unchanged from v1.6.

**v1.6 changes:** **Sub-views moved in-page, product-wide (decided by Ash 2026-07-19, during the Purchasing Overview round).** §1.7's open "pick one" is resolved: the in-page strip is the house pattern; the topbar mirrors (`#tb-subviews`, `#tb-pu-subviews`) retire as each section's rebuild ships. §1.1 item 3 amended — topbar page identity is crumb + ⓘ only. §1.1a region order gains row 2, the sub-view strip (Orders has none; the anchor is unaffected). Purchasing left Products: standalone page, tabs **Overview · Orders · Suppliers · Bills** — Reorder folded into Overview. Title version corrected v1.0 → v1.6; it had never been bumped and three documents cite three different numbers for this file.

**v1.5 changes:** **§1.1b added — Roots is one tenant.** Design for the audience (everyday small merchants — small numbers are the core case, not the edge), not the reference tenant's data. "Is this in my product?" checks what exists and stays the best check; "my numbers are small, so cut it" calibrates what should exist to one tenant and is a trap. Never assume Roots's config (`points.redeemRate` 1 vs default 100).

**v1.4 changes:** **§1.11 gained the mechanism it never had** — three ways a string learns the language changed (walker live-toggle = house default · `cuT()` bake = frozen · `onLangChange` re-render = never for drawers), and **the axis that picks between them is interpolation, not preference**: plain text glues, anything with a `<b>`/value/date between EN and CN physically cannot. **Gluing inherits a constraint `cuT()` never had** — neither half may ever contain `" · "`. Paying note shipped `53910791`; three same-class strings deferred because glue is unavailable to them, not by triage.

**v1.3 changes:** **§1.2 settled by `git blame`** — the `--td-*` group is **four** rule blocks and that is correct; **`--td-paper` (`:7961–7962`) is the page ground, load-bearing, defined nowhere else** (`body{background:var(--td-paper)}` `:7968`) — deleting it blanks every admin tab. Folding it in is a safe optional tidy, not a fix. **The "exactly one `:root` block" rule was never true** — 34 occurrences, 7 global token blocks, ~23 theme-scoped element overrides (the house pattern), 4 in comments; §7's grep is corrected to check for *new `--td-*` groups and page-scoped `:root`*, not a count. §1.12 status: all 13 disables shipped.

**v1.2 changes:** **§1.1a added — the page shell contract**, cited from finished Orders (region order · filter row is dropdowns not chips · cream header on white rows · single-line headers · columns scroll, never collapse) · **the second-dead-reference rule** — a live un-rebuilt page is the backlog, not precedent · §0's brief template now demands a page, not a specimen sheet · §7's checklist gained page-shell parity checks.

**Why §1.1a exists.** Orders' design was finalized and **nothing wrote down what it decided.** Every brief was then composed from memory of a screenshot. In one session that produced three drifts on Customers — channel chips where Orders has a dropdown, no KPI tiles where §4 requires a pulse, and a two-line column header where the product has none. **Each drift was the live Customers page being read as precedent when it was the thing being replaced.** The rule that would have caught all three didn't exist; it does now.

**This is §1.1's failure shape once more.** The topbar rule outlived its buttons. Here, the anchor shipped and the contract was never written — so there was nothing to outlive, and every brief re-derived it wrong. **A decision nobody wrote down is a decision nobody made.**

**v1.1 changes:** §1.1 topbar (eight-item contract, from `tacet-topbar-correction.md`) · §1.11 walker mechanism · §1.2 token range corrected to `:root` 7906–7927 / light 7928–7942, **and a second `:root` pair flagged at `:7961–7962`** · §1.10a corrected to 7 marks across 4 columns, `.stack` split recorded as already-built, `st-paid` collision flagged · §1.12 receipt corrected — **13 non-disabling controls across Orders and Customers, three shapes** (the "eight" was wrong) · §3 page-header aligned to §1.7.

**🔴 Orders v2 is cancelled.** The Orders design is final. Prior drafts of this document anchored on "Orders v2 (not yet built)" and promised to become descriptive when it shipped. **It isn't coming.** Any brief written from that language would rebuild a page Ash already finalized — the §1.1 failure shape exactly: *the page got finished, the rule didn't.*
