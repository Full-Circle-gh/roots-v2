# Tacet dashboard — simplification spec, v1.1

**2026-07-17 · Decided with Ash. This is the product decision; the survey behind it is recorded in the session notes. Joins the canonical folder between the specimens doc and the rulebook.**

**v1.1 · 2026-08-05 — vocabulary only, no product decision changed.** The retired word *tenant* becomes **account** per `tacet-glossary.md`. **"The tenant principle" is renamed "The account principle"**; it still cites rulebook §1.1b, itself renamed "Roots is one account" at rulebook v4.3.

---

## The governing principle

**The dashboard is not a report page.** Two surfaces, two jobs, one line between them:

- **Dashboard** — *what's going on right now.* Status. Glanced at, not studied. Its question (design system §7): **is everything okay?**
- **Reports** — *what happened and why.* History, comparison, analysis, the AI layer. Studied, not glanced.

**The test for any card:** does it describe *now*, and can the operator glance it? History → Reports. Analysis → Reports. Rankings → Reports.

The product already half-knew this — the dashboard's own footer reads *"The full numbers live in Reports."* This spec makes the dashboard keep that bargain.

---

## What Ash actually asked the page (the requirements, verbatim in spirit)

**Owner, 9am:** revenue today · how many orders today · any problems/tasks in the business not solved.
**Warehouse/logistics operator:** inventory state · inbound logistics · new orders nobody has handled.

Three questions each. The current owner view answers them with ~ten cards. That is the defect.

---

## 🔑 Cards are a function of permissions, not of a role name

**Decided 2026-07-17, after the first draft got this wrong.** The first draft said "three dashboards — owner, warehouse, dispatch." **That model is wrong and would have shipped a bug.**

**There is one dashboard. It composes itself from what the operator can see.**

Each card declares the permission it needs. The page renders the cards whose permission the operator holds. **No role labels in the logic.** The sets below are *illustrations of common cases*, not code paths.

**Why this matters more than it looks:** in a small business one person does two jobs. Ash's own operation has them. A hard-wired `role → cards` map means the warehouse-and-dispatch person gets one job's page and **nobody can fix it without a deploy**. Per §1.1b, multi-role staff are the **core case** for Tacet's audience, not an edge case. That person gets seven cards because they hold both permission sets — not because someone invented a "warehouse+dispatch" role.

**This is deliberately NOT a new control surface.** Tacet already has one place that answers "what may this person see": the permissions matrix (`PERMISSIONS_PLAN.md`). A second card-picker screen in Settings would be a second permissions system, and the two would disagree within a month. **The permission is the answer.** Give the warehouse operator `delivery:read` and the dispatch cards appear — which is the same act as letting them do the job.

**⚠️ Honest limit, and it's fine:** `rbac_enforce` is off (three blockers open, shadow mode unbuilt). So card gating **reads the matrix for display only while the server still enforces nothing**. Per §1.9 that is not security — it is tidiness. **That is acceptable here and only here:** a dashboard tile shows data the operator can already reach through the nav. **Do not use this as precedent for gating a write.**

## The card sets — illustrations of common permission holders

**🔴 Rule change: hide/show dies. Position-only arranging.**

- **Permissions** determine which cards exist. Not the operator, and not a role name.
- The operator may **reorder** (drag) but may **not hide or add**. ⚠️ **Arrange is stood down as of 2026-07-29** and returns in the next release: its drag read the retired solver's pixel rects, so it could not survive the grid change unaltered. The control and each card's hide ✕ stay in the markup, hidden by CSS. A saved `order` is still honoured; saved `widths` and `hidden` are ignored — `hidden` deliberately, since with no way to bring a card back an old hide would strip it for good.
- *Why:* the current tray lets a worker hide "Needs you" — an operator arranging their way out of seeing what needs them. **Position is taste; presence is policy.** Policy is Ash's.
- *Side effect:* §1.16's stranded-layout hazard (layouts nobody else can see) shrinks to near-zero once the card set is fixed per role. The layout key still resets on this release.

### Someone who can see the money (typically the owner) — 4 cards

| # | Card | Content |
|---|---|---|
| 1 | **The Recap** | **Unchanged.** See "What the rebuild must not break." |
| 2 | **Needs you** | The centerpiece. See its own section below. |
| 3 | **Today** | Revenue today (count-up) + delta arrow · Orders today + delta · AOV · Refunded. **The hourly chart is cut** — a number and an arrow are status; an hour-by-hour comparison is a report. |
| 4 | **Customers / live** | **Sessions is the only denominator (2026-07-29).** New today · Sessions today · Conversion, three across. Visitors and visits are gone from the card: `visitors` double-counts anyone who signs in mid-session (see the note on `visitsSql`) and could read higher than sessions, which cannot be true of people; `visits` counts page views, so browsing depth looked like traffic. **Conversion — redesigned for small denominators (rulebook §1.1b):** below a meaningful session count, **no percentage** — show the honest counts instead. `0.0%` over 2 sessions is noise rendered as a crisis, and small merchants are the audience, so small denominators are the *core case*. Threshold `CONV_MIN_SESSIONS = 20`. · Footer: the sage presence dot ("N browsing now") and the way in. |

### Someone who can see stock and purchasing (typically warehouse) — 5 cards

| # | Card | Content |
|---|---|---|
| 1 | **The Recap — role-filtered** | *Decided 2026-07-17: workers get their own Recap.* Same component, their window: "While you were away: 4 orders entered your queue · 2 POs arrived." Their work, not the business's money. |
| 2 | **Needs you** | Role-filtered: restock + inbound problems only. |
| 3 | **Unhandled orders** | Orders in `paid` — see definition below. |
| 4 | **Inventory** | Out of stock · running low · the rolling low list. |
| 5 | **On the way / Drafts** | Inbound POs · drafted-not-placed. |

### Someone who can see delivery (typically dispatch/CS) — 5 cards

| # | Card | Content |
|---|---|---|
| 1 | **The Recap — role-filtered** | Same component, their window: deliveries completed, riders assigned while away. |
| 2 | **Needs you** | Role-filtered: delivery alerts, locating-rider. |
| 3 | **Unhandled orders** | Same card as warehouse. |
| 4 | **On the road** | Out-for-delivery, rider stage/ETA. |
| 5 | **Ready to hand off** | Packed, waiting for a rider. |

**No money cards for non-owners** — already the rule, stays the rule.

---

## "Needs you" — the centerpiece

**One card, every fire.** Everything unsolved in the business appears here and nowhere-else-first. Today's scattered signals — delivery alerts, refund queue, awaiting-restock, invoices to issue, locating-rider — consolidate into this card, filtered per role.

**Two disciplines, or it becomes noise:**

1. **Only actionable things.** The test: *can the operator click it and resolve it?* "Refund waiting for your decision" — yes. "Revenue down 4%" — never; that's a feeling, not a task. If it can't be resolved by acting, it is not a need.
2. **Empty means empty.** When nothing waits: **"Nothing needs you."** — and the card shrinks (the current `.is-quiet` instinct, kept). This is the brand's empty-state promise on the card where it matters most.

Each row deep-links to the place the fire is put out. Rows are counts + one line, never tables.

**🔴 Not every row in that list exists today. Costed 2026-07-17 by Claude Code, corrected from the one-line hand-wave the first draft made:**

| Row | Exists? | Cost |
|---|---|---|
| Refunds waiting | ✅ `tdAttnRender` builds it today | none |
| Delivery needs a call | ✅ exists | none |
| Invoices to issue | ✅ exists | none |
| **Restock needed** | ❌ **Not a Needs-you row today.** The low/out-of-stock counts render *inside the Inventory block* (`tdInvLowRender`); `tdAttnRender`'s own comment says "Stock is no longer a card here." | ~half a day, **UI only** — the data (`DASH_OPS.low_stock`/`out_of_stock`) already ships; a new `tdAttnCard('amber','box',…)` branch reads counts already in memory, deep-links via the existing `dashOpenRestock`. No backend. |
| **Inbound problems** (stuck/overdue POs) | ❌ **No data source at all.** No PO-age field in `/dashboard/ops`, no staleness query anywhere. | **~1.5–2 days, real backend + possible schema.** Needs: confirm a PO even records an expected-arrival date (unverified — if not, this is a schema change), a new staleness query, a new `inbound_problems` key on `/dashboard/ops`, then the card. **Scope as its own mini-spec before building.** |

**So the spec's one-line "restock + inbound problems" hid one cheap card and one multi-day feature.** Restock ships with the warehouse commit. **Inbound problems does not** — it's carved out until its own scoping answers the expected-arrival-date question.

**One judgment call, Ash's:** dedup. If restock is a Needs-you row *and* the Inventory block still shows low-stock in its footer, the same fire appears twice — against "appears here and nowhere-else-first." Decide at build whether the Inventory footer's restock line stays once Needs-you carries it.

---

## "Unhandled orders" — the definition

**An unhandled order is an order in status `paid`.** Money received, nobody has started preparing. This is not an invention — it is the product's own state machine: the moment anyone acts, the order moves to `preparing`.

**Data source (settled 2026-07-17):** extend `/api/retail-admin/dashboard/ops` with one `unhandled: {count, items}` key, `WHERE status = 'paid'`, oldest-first, store-scoped like its siblings — **not** `order-status-counts.paid`, whose `paid` field is polluted (it sums true `paid` rows *plus* dispatched-with-unshipped-parcel, to match the Orders tab). One new key, no new route, no new poll.

**🟡 The `paid_at` caveat, to resolve before build:** age uses `paid_at`, set on the `pending_payment → paid` transition (`retail.js:4129`). **Confirm every `paid` order actually has a `paid_at`** — readonly-channel orders (Meituan/gzgrocery) and the bulk-tracking-paste path may not follow that write path. If any `paid` order can carry a null `paid_at`, decide what the card shows for it before shipping, or the newest card on the worker's page renders "NaN min."

**Deferred, deliberately:** an age *threshold* (a paid order 2 minutes old is not a problem; 90 minutes is). Tune after the card is live, not before.

---

## What leaves the dashboard

| Card | Fate | Why |
|---|---|---|
| **The week so far** | → Reports | Seven days of history is a report. |
| **Today's movers** | → Reports | A ranking is analysis. |
| **Channels** | **Dies** | Channels has its own page. |
| **Today's hourly chart + "vs a typical Friday" ghost** | Cut | Comparison is reading, not glancing. The number and delta arrow stay. |
| **Recent stock moves** | → Reports (or the stock ledger) | A ledger tail is history. |

---

## The account principle (rulebook §1.1b)

**Roots is the reference account, not the specification.** Every card above must be right for a merchant with 10× Roots's volume and one with a tenth. Small merchants are the audience, so small numbers are the core case — metrics are designed to be honest at small denominators, never hidden because the reference account's numbers are small. Conversion's no-percentage-below-threshold rule is the worked example.

## Roles this spec does NOT address — deliberately

**`store_manager` exists in code and this spec is silent on it. That silence is a decision, not a gap.** It currently shows `recap · needs · orders · customers · inventory · delivery`, and it keeps `reports:view` in its cap preset — so it keeps revenue, matching today. The migrated cards (movers/week) auto-die for it too, since those ids vanish account-wide. **It keeps working as an unaddressed 6-card leftover.** Redesign it as a proper role view in a later pass; do not silently break it now. **`delivery` block must NOT be deleted** — `store_manager` still uses it; dispatch/CS just add it to their CSS hide list.

## The caps finding (settled 2026-07-17, corrects an earlier wrong claim)

**The client knows both the role string (`RA_POS`) and a real, per-operator capability array (`CAPS`), and the caps are live — not stubbed.** An earlier survey claimed caps were "dark, everyone resolves to full"; that was read from a stale client comment (`01-core.js:131`) without tracing the server. The server (`/api/backend/me` → `resolveOperator` → `resolveCaps`) ships a **narrowed** preset per role — only `owner` gets everything. Verified on the box by running `resolveOperator` read-only against production: `roots-warehouse` returns a 17-key array with `quickstock`/`purchasing` and **without** `orders:refund`, `invoices:manage`, or `reports:view`.

**What this enables — and its one live limit:**
- **Gate A (shipped, `1272941e`):** Needs-you sub-cards read caps via `dashCardWants` (`DASH_CARD_CAP` map), `dashPosWants`/`DASH_POS_CARDS` deleted. Verified behavior-identical to the old role gate for the real warehouse operator. This is how "cards compose from permissions" actually lands — and it honors per-user grant/revoke overrides a role string can't.
- **Gate B (held):** whole money-card *presence* stays on the `body.pos-*` CSS gate this release. Caps **fail open** (`null → shown`), so a null-caps session would leak a money card. The box check confirmed the real warehouse session returns a narrow array (not null) and lacks `reports:view` — so `data-cap="reports:view"` would resolve *hidden* — but move Gate B only after watching a live session, per the fail-open rule.
- **⚠️ Only one non-owner operator exists in production** (`roots-warehouse`). Zero dispatch, zero CS. Their Gate A paths are verified by deterministic preset *code*, not by a live session — the first real dispatch operator created is the first live exercise of that path.

## What the rebuild must not break (from the 2026-07-17 survey)

1. **The Recap stays as-is.** It is the most mature Tacet component in the product — the away-window logic (`TD.reallyAway`, 25min–7day), the "you left here" boundary, the work-fold, the only Dusk on the page with a comment stating the rule, "Handled quietly. You're welcome." **Refinement only if a specific defect is named; no rebuild.**
2. ~~**The solver has shape contracts.**~~ **RETIRED 2026-07-29 — there is no solver.** `dashSolve`/`DASH_SHAPES`/`DASH_PRI`/`dashTier`/`dashComputeRects` and `scripts/dash-solver-test.js` are gone. Cards are a CSS grid inside a container query on `.td-wrap` (1 column below 760px of grid width, 2 to 1140px, 3 above — three is the ceiling). **A card's height is its own content**, and cards in a row stretch to the tallest of them with each footer pinned by `margin-top: auto`, so a row ends flat. The only scripted part is the lone-card span: `dashRender` counts visible tiles against the resolved column count and puts `.td-span` on the last one when it would otherwise sit alone. Adding a card means adding it to `DASH_BLOCK_DEFAULT` — there are no shape tables left to keep in step. **Needs-you is not in the grid at all**: it is full width, first, and lives outside `#td-blocks`, which is what makes it unmovable.
3. **The boot splash listens for two signals.** `data-app-ready` stamps only when Today *and* The Recap paint (`dashMarkReady`). Rename either and boot feels broken (8s failsafe masks it — worse).
4. **Every card's renderer registers in `onLangChange` or its `cuT()` copy freezes** in the first-paint language. ~10 registrations exist because each card needed one. New/merged cards follow the pattern. **Do not copy Reports' glued `${en} · ${cn}` idiom** (`dashRangeFoot`, `dashRenderTiers`) into dashboard code.
5. **Role gating already works** (`DASH_POS_CARDS` / `dashPosWants`). The card sets above are a re-mapping of that system, not a new one.
6. **The mobile dashboard (`#rm-dash`) is a parallel surface.** This spec covers desktop; mobile follows after, per the standing mobile-v2 note. Don't let scope drift there (it has, twice).
7. **Dead weight to remove while in there:** the `#db-bento`-scoped CSS (the element no longer exists) — but **not** the un-scoped `.db-tile*` primitives, which Reports still uses.
8. **`#td-live` is a sage presence poll, not SSE and not Dusk.** Correct on both counts; keep both.

---

## Open, deliberately

- The **age threshold** for unhandled orders.
- Whether the **Reports tab absorbs the migrated cards** as-is or redesigns them (Reports is its own Batch 1 page; decide there).
- The **mobile** mirror of these card sets.

---

*v1.2 · 2026-07-17 · decided with Ash. v1.1 = permission-driven cards (not role names); v1.2 = honest costing of restock (cheap) vs inbound-problems (multi-day, carved out), the `paid_at` caveat, `store_manager` as deliberate-later, and the caps finding + Gate A/B split. Next: Claude Design brief for the owner view first — it's the smallest (4 cards) and it's the one Ash checks against his own morning.*
