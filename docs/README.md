# Tacet docs — canonical set · banner current 2026-07-26

> ## 🔴 Read this banner first — the body below is from 2026-07-17
>
> **Version numbers: trust each file's own title line, never this README's
> read-order table.** As of 2026-07-26: rulebook `tacet-desktop-patterns.md`
> **v2.6** · `tacet-design-system.md` **v1.3** · `tacet-ia-blueprint.md` v2.1 ·
> `tacet-brand-concept.md` v1.2 — and the rulebook figure here is itself now
> several versions stale, which is the point. **The read-order table no longer
> states a rulebook version at all** (2026-07-30); it said "v1.4" for weeks,
> and a version stated in two places drifts in one. This snapshot is dated on
> purpose — read it as a record, never as current.
>
> ### ✅ CUSTOMERS IS BUILT AND LIVE — 2026-07-26
>
> The first section taken end-to-end from mockup to production. **25 commits
> across 5 builds**, all CI-green. Roster, drawer, five modals, six states,
> plus the data and query work beneath them. The state block below calls
> Customers "designed" — that is now two rebuilds out of date.
>
> Shipped with it: **`--td-header` and `--td-unseen`** are live in the
> `--td-*` block (`170b5c8a`) — Customers is their first and only consumer.
>
> The full record — every decision, the four lessons, the test-data clusters
> and what is still open — is in **`tacet-customers-addendum.md`**. It is the
> only addendum in this set describing a section that actually shipped, and
> its four lessons apply to every page that follows.
>
> ### 🔴 Orders now owes a pass, and it is all already decided
>
> Shipping Customers alone was a deliberate call, and this is its cost. Live
> Orders is behind its own approved mockup in three ways:
> 1. **The column-header band** — Orders invented it and never shipped it. It
>    still runs `13.5px/700` on `--bg-pane`.
> 2. **Unopened rows** — `--td-unseen` + the inset Sage edge, which *replaces*
>    Orders' Dusk "New" pill (a §1.8 violation). `retail_orders.seen_at`
>    already exists.
> 3. **The channel label contradicts itself** — the dropdown and the mobile
>    order cards say "Mini app" where the row labels already say "WeChat".
>    Fix the inconsistency at the data source. **Do not harden "WeChat" into
>    the shared UI:** channel names are per-business configuration and the
>    channel list is not a fixed set (`docs/tacet-consolidation-decisions.md` §0).
>
> None of this is new design. It is application.
>
> ### Design state, verified with the operator
>
> **Built and live:** Orders · Customers · Dashboard.
> **Designed, builds held:** Reports · Products · Team · Sales · Purchasing ·
> Profile · CMS/Editor · Marketing (Coupons, Flash sales, Pop-ups, Affiliate).
> **Not started:** Share cards · Broadcasts · Social proof (the last has a
> flagged brand-values question — discuss before design).
>
> ### Two operational facts that bit this project on 2026-07-26
>
> - **Every commit on `main` deploys.** Post-commit hook auto-pushes, CI
>   deploys from main. There is no staging step.
> - **A second session has been active on the repo.** It collided twice in one
>   day; the second time it silently dropped an `sw.js` bump, leaving new CSS
>   on the box behind a stale cached shell. Both sessions touch the same
>   `sw.js` line, so every client-asset change collides there by construction.
>
> The detailed lines below are left as-written on purpose — rewriting from an
> unverified reconstruction is the exact trap this project warns about. This
> banner says where they're wrong.

**This folder is the source of truth. Every other copy on the machine is stale.**

There were **7+ scattered copies** of these docs across `Desktop/`, `tacent/`, `tacet v2/`, `v3/`, `v4/`, `md files tacet updated/`, and `Downloads/`. That is how a stale rule survives: there is always another copy that still agrees with it.

**Delete the others, or move them somewhere clearly marked old.** Then point Claude Code at this folder and nowhere else.

---

## Read order

| # | File | What it is |
|---|---|---|
| 1 | `tacet-session-handoff.md` | The 2026-07-16 handoff. **Correct on method, tools, and the §7 failure modes — that part has aged well.** Wrong on state: see the correction block at its top. |
| 2 | `tacet-session-addendum.md` | 2026-07-17 morning. Corrects the handoff's account of the working tree. |
| 3 | `tacet-topbar-correction.md` | The verified eight-item topbar contract. **Already applied to rulebook §1.1** — kept as the record of how a stale code comment became a rule. |
| 4 | `tacet-orders-specimens.md` | **v1.9.** Orders' status/refund matrices, the worst-case row, the 13-control disable audit, §8 Customers. Every cell cited. |
| 5 | `tacet-desktop-patterns.md` | **The rulebook — version: see the file's title line.** Read **§1.1a first** — the page shell contract. |
| 6 | `tacet-ia-blueprint.md` | The IA blueprint. §2 corrected 2026-07-17. |
| 7 | `tacet-design-system.md` | Unchanged. How it looks. |
| 8 | `tacet-brand-concept.md` | Unchanged. How it sounds. |

**Starting a fresh session:** upload all eight. Say *"read the handoff first, then the addendum and the topbar correction — they amend it. Then the rulebook's §1.1a."*

---

## State, end of 2026-07-17

**✅ Orders — closed.** Design final: **there is no Orders v2**, the page shipped as "Orders (A) — Build". Code closed too — `paying` renders, all 13 disable guards shipped, `paid→dispatched` shipped.

**✅ Customers — designed.** List · four states (their own file) · drawer · three modals. Code: 8 disable guards shipped, including the three missing markup ids.

**✅ The deploy race — closed** (`ecbce2dd`). CI owns deploys; the local hook only pushes. eslint moved into CI, where it now actually **gates**.

**✅ Dashboard — shipped 2026-07-18.** Simplified from ~14 self-arranging cards to a permission-composed glance. Owner 4 cards · warehouse 5 · dispatch/CS 5 · `store_manager` untouched. Six commits: Gate A (`1272941e`, Needs-you gates on caps) · 1 (`62c65340`, solver + orphan-hide) · 2 (`ba02fd60`, `/dashboard/ops` unhandled key) · 3 (`6bc2e5ba`, owner reshape) · 4 (`2fb130a4`, warehouse) · 5 (`8ab24101`, dispatch/CS). All CI-green and live. Owner + warehouse box-verified live; dispatch/CS verified by per-role branch simulation + ¥ audit (no operators exist to log in as). See `tacet-dashboard-spec.md`.

**⬜ Batch 1 remaining:** Reports · Products · Settings · Team. **Survey first, always.**

**🔴 First-live-render check owed:** the dispatch and CS Recaps have **never painted** — zero such operators exist in production. The day the first dispatch or CS operator is created is the first real render. Whoever is here then does the eyes-on check: 5 cards, Recap money-free **including the "Show the work" fold**, Unhandled ages as m/h/d not NaN, zero ¥ except CS's refund/invoice task amounts. Simulation proved the logic; only a live session proves the paint.

**Today's commits:** `74c5f83d` · `b078697a` · `b1bed6a5` · `53910791` · `ecbce2dd`.

---

## Owed

**Dashboard backlog (deferred by decision, 2026-07-18):**
- **inbound-problems** Needs-you row — no data source; ~1.5–2 days; needs its own mini-spec (does a PO even record an expected-arrival date? unverified — may be a schema change).
- **`po_received` event** — small backend commit; would let the warehouse Recap show "N POs arrived" (the approved mockup row that ships absent because no event backs it).
- **`rider_assigned` event** — same shape for the dispatch/CS Recap's "N riders assigned."
- **orphan-CSS sweep** — dead card-body CSS from the five removed cards + the Today-chart CSS. Harmless (matches no DOM). A hygiene commit; rides whenever.
- **Unhandled age threshold** — deferred per spec; tune once the card is live and you see real ages.
- **Gate B** (money-card presence → `data-cap="reports:view"`) — precondition met (`roots-warehouse` caps come back narrow, lacking `reports:view`), still on the `body.pos-*` CSS gate. Move it after watching one live non-owner session, per the fail-open rule.
- ~~**mobile `#rm-dash`**~~ — **REMOVED 2026-08-24.** Not a parallel surface after all: phones have been served Tacet Mobile (`m.html`) since 2026-07-12, so this ≤720px layer in the desktop shell was dead on every phone. Deleted rather than given its own pass.


- **Shadow mode** — decided, not built. Deny-by-default, log-don't-block, ~a week of real traffic. **Until it runs, `rbac_enforce` stays off** and `PERMISSIONS_PLAN.md` §11's three blockers stay open. Flipping the flag now is worse than leaving it off — you'd believe you were protected.
- **Orders `can()` gating** — no order button is wrapped in `can()`. Only bites once the flag flips.
- **🟡 The lint gate is unexercised.** `ecbce2dd` was `[skip deploy]` with no `.js`. **The next real admin-JS commit is its live test.** It fails *closed* — deploy blocked, visible, fixable.
- **The `--td-paper` fold-in** — optional tidy, safe, not a fix. Rulebook §1.2.
- **3 customers can't reconcile** `lifetime_spend` against their own awarded subtotals (196: −314 · 264: −199 · 67: −188). Ash's call: not worth chasing. **Logged so the next survey doesn't chase it either.**
- **`asher` (customer 233) is Ash's test account.** ¥1,430 cached vs ¥790 live across 53 orders. **Not data.** Any survey that finds this gap and chases it is chasing a test. (One business's live rows, logged so the next survey doesn't chase them — **not a Tacet reference example**.)

---

## What this session actually taught

**Every document that disagreed with the code lost. Every single time.**

- The **handoff** said the tree held three files. `git status` said four bundles.
- **§1.11** said any `·` is a pair. `processNode` said Latin-left-plus-Chinese-right only.
- **§1.1** said the topbar holds Lang/Theme/live-dot/sound. The markup said none of them.
- **§1.12** said eight controls don't disable. The grep said thirteen, in **four** shapes.
- **§1.2** said there is exactly one `:root` block. There are 34, and there always were.
- **The deploy rule** said the hook does work CI doesn't. It did — and that work had never once run.
- **`retail-admin.html:1202`** — a *code comment* — said `.tb-cluster` holds the live-poll dot and sound. It holds the Inbox. **That comment is where §1.1's error came from:** a survey read the comment, the survey became the rule, the rule outlived the buttons.

**And the docs that lost included ones written the same day.** `tacet-orders-specimens.md` was re-anchored at v1.4 and had drifted again by v1.7 — moved by this session's own commits. **A line number in these docs is a hint, never an address. Cite the symbol.** Function and structure names have never been wrong. Only the numbers have.

**Three rules that came out of it:**

1. **Write the mechanism, not the ritual.** The `sw.js` rule was right and its stated reason was wrong — the committed literal is a *trigger*, not the cache token. A rule that says what to do without why is one survey away from being "corrected" into a bug.
2. **A live page that hasn't been rebuilt is not evidence — it is the backlog.** Three Customers briefs drifted because the old page was read as precedent. **Orders is the anchor** (§1.1a).
3. **Ask whether the thing works before protecting it.** The deploy rule said "don't delete work CI doesn't do." That work was a lint gate that had never once gated.

**The greps find what exists. Only Ash finds what's reachable.**

He found: the missing columns · the missing thumbnails · `ROOTS` in the collapsed rail · the buried language toggle · a whole standalone auth app three surveys were structurally blind to · **Sarah's points ledger, which explained a ¥1,124/¥0 gap two greps had mis-attributed to refunds** · and five invented patterns in one round of Customers mockups.

**When he says "that's not in my product" or "this looks wrong," he's right.** Every time today, he was right.
