# Stranded lines — a screen for channel order lines that never found a product

**2026-08-27 · DESIGN ONLY. No code was written. Nothing here is built.**

**The survey this answers:** `docs/tacet-channel-line-resolution-findings.md` (2026-08-27). Every
number below comes from it and is not re-derived here.

**Governing documents.** `docs/tacet-ia-blueprint.md` v2.5 (where a surface lives),
`docs/tacet-desktop-patterns.md` (§1.7 header, §1.7a sub-page, §1.12 six states, §2 archetypes),
`docs/tacet-glossary.md` v1.7 (MODULE / SCREEN / APP).

**Decided before this document and not reopened here:** (1) resolving deducts stock **now**, stamped
today, carrying the original order id and date; (2) the screen **suggests and never pre-selects**;
(3) identical lines **group and resolve together**, keyed on channel line name + store, with the line
count on the confirm control.

**Out of scope, deliberately.** The name fallback in `routes/meituan-internal.js:181-189` is not
touched, gated or removed by this design. That is a separate decision, taken after this screen exists
and can show what the fallback is doing.

---

## 1 · What the screen is for

A channel order line that resolves to no product is stored with `product_id = NULL`, priced
correctly, and **no stock moves**. Resolution runs exactly once, at first sighting; the daemon skips
any order already in `meituan_order_import`, so nothing ever tries again. One `order_unsynced` warn
is written to a panel that renders six events against 13-25 landing per day. The order drawer renders
the line as plain unlinked text with no badge.

In 90 days: **594 Meituan lines, 47 unresolved.** Eight are cutlery, seven are Meituan truncating a
name to a tail, and **32 are real products that were sold and never came off a shelf** — 18 of them
pita.

The screen exists so that a person can see those 32, decide what each one was, and move the stock.
It does not try to be right on their behalf.

## 2 · Where it lives

### 2.1 · The words

- It is **not** a MODULE. Per the glossary, a module is *"one shared piece of the back end, built
  once and used by any front end"* — Orders and Stock are modules and this needs no third one. It
  reads `retail_order_items` (Orders) and writes through the stock adjuster (Stock).
- It is a **SCREEN**: one navigable surface, inside the Orders section.
- Not an APP. Nothing here is a separate front end.

### 2.2 · Archetype: A1 Worklist

`tacet-desktop-patterns.md` §2, A1 — *"Records that **arrive**. The operator processes them; they
didn't author them. Dense, scannable, live."* That is this screen exactly, and no other archetype is
close: it is not a Library (nothing is authored), not a Console (nothing is configured), not a Board
(there is no set of destinations), not a Report (the output is an action, not a reading).

No eighth archetype is proposed. §6 of the patterns document makes that a conversation, and this is
not one.

### 2.3 · Under Orders, not under Sales or Products

**Under Orders**, because all three of the record, its parent and its consequence belong to Orders:
the record is a row of `retail_order_items`, its parent is a `retail_orders` row, and the consequence
is a stock movement attributed to that order. Orders is also already **channel-agnostic and
store-symmetric**, which are precisely the two properties that disqualify the alternative.

**Not the Meituan tab's product chips.** They are product-first — they enumerate `store_products`
rows, so a combo listing (`藜麦沙拉+南瓜汤`) can never appear, and combos are 5 of the 14 ambiguous
lines and both of the half-resolutions. They are store-asymmetric by design: at 越秀 a missing name
reads neutral, never amber, *"because 闪购 links itself by 货号, so 'not linked' there is a fact about
the listing, not a job on this page"* (`public/retail-admin/11-meituan.js:731-733`) — and every
quinoa failure is 越秀. And they never read the orders at all.

**Not the Sales board.** Sales routes into channel consoles (`salesGo()`), which is where a channel is
configured. This screen is not about a channel; it is about lines that arrived through one.

**Not a new rail row.** The IA carries 34 sections and `docs/tacet-ia-blueprint.md` already records
an `order:9` collision and four numbering fossils. A queue that is empty most weeks does not earn a
permanent rail row; it earns a way to be found when it is not empty (§2.5).

### 2.4 · The shape: a sub-page of Orders, per §1.7a

A takeover in the Orders content area — back link in place of the eyebrow, title, and at most two
exits (§1.7a). Nothing overlays anything; the Orders list behind it is `display:none` or `inert`, not
dimmed. Back returns to Orders. No route is required (§1.7a as amended 2026-07-30 — the admin has no
router; a full-bleed in-flow takeover satisfies all three conditions).

**Precedent in the live shell:** Products already carries a second screen this way — `#prod-view-activity`
("Stock activity"), switched by `prodShowView()` (`public/retail-admin/09-products.js:266`). Same
mechanism, same relationship to its parent tab.

### 2.5 · How the operator arrives

Three doors, because the whole defect being fixed is *nobody finds out*:

1. **The Orders status line** (§1.7) gains one fact when the count is non-zero, and shows nothing
   when it is zero — a status line carries live overall state for the section, and a stranded line is
   exactly that. It is a link into this screen.
2. **A Dashboard attention card**, in the existing ops-card region (`tdOpsLoad`,
   `public/retail-admin/03-dashboard.js:2215`, `/api/retail-admin/dashboard/ops`). Same treatment as
   the other attention cards; no new mechanism.
3. **The command palette** picks the screen up on its own — it builds from the live DOM on open
   (`tacet-ia-blueprint.md` §2), so it needs no registration.

**Deliberately not a fourth door:** no chime, no dot on the rail, no toast. A sale that already
happened is not an interruption; it is work waiting.

## 3 · The unit of work

A **stranded line** is a row of `retail_order_items` where `product_id IS NULL`, on an order whose
`channel` is a marketplace channel, and which has not been dismissed.

**Grouped by `(channel line name, store)`**, per decision 3. Both halves are needed: the same listing
at two stores can want two different products (the pita 5-pack and the single are mapped
differently at 天河 and 越秀), and the same name at one store is always the same thing.

The name is grouped **verbatim, as the channel wrote it**. No normalisation, no trimming, no
case-folding. Two lines that differ by a stray suffix — `Whole-Wheat Pita皮塔面包(一个)(Yes)` (7) and
`Whole-Wheat Pita皮塔面包(一个 Yes)` (1) — are **two groups**, and that is correct: they are two
different strings the channel sent, and collapsing them would be this screen quietly performing the
same fuzzy matching that produced the problem. The operator resolves both; it costs one extra click
and tells no lies.

**A group spans orders.** The nine pita lines sit in nine different orders across eight weeks. One
approve action, nine movements (§5).

## 4 · What one row shows

Columns, left to right. §2 A1 rules apply: hairline rows, no zebra, header 13px Inter 500 Graphite,
numeric columns right-aligned and tabular, horizontal scroll rather than hidden columns, rows are
buttons opening a drawer.

| Column | Content | Notes |
|---|---|---|
| **Line** | The channel line name, verbatim | Never truncated in the middle. Full string in the row; wrap rather than ellipsis if it must. This is the operator's only handle on what was sold. |
| **Store** | Tianhe / Yuexiu | Symmetric. Both stores are the same kind of row here. |
| **Times** | Occurrence count in the group | Right-aligned, tabular. This is the number that makes the pita cluster visible as a cluster. |
| **Units** | Total qty across the group's lines | Right-aligned. **What will actually be deducted**, so the operator sees "9 lines · 9 units" or "5 lines · 7 units" before committing. See §5.3 on pack size. |
| **First / Last** | Date range of the group | `tdWhen(value, …)` per §1.18. Eight weeks between first and last is itself information. |
| **Why** | What the resolver tried and failed on | §4.1. |

Row → drawer (A1: *"Row → drawer. Always. Never a page, never a modal."*). The drawer carries the
per-line list (order ref, date, qty, price), the failure detail, the suggestions (§4.2), and the two
actions (§5, §6).

### 4.1 · The "Why" cell — what was tried, and what it found

The four steps are `claim → sku → map → name`. A stranded line failed all four, but *how* it failed
each one is the diagnostic, and the survey shows the shape differs per cluster. The cell states the
step that came closest to an answer, and the drawer states all four.

| Rendered | Means |
|---|---|
| **No SKU on the line** | The channel sent no 货号 and no `(\d+-\d+)` token was scrapeable. All 14 ambiguous lines are this. |
| **SKU not found:** `3-170s` | A code arrived and we hold no such SKU. This is the guacamole shape — a channel-side portion code with no row here. |
| **No mapping at this store** | No `meituan_product_map` row for this store whose normalised channel name matches. The pita cluster before 2026-08-24. |
| **Matched N products** | The name step found more than one. **The rows it matched are named in the drawer, in full** — for quinoa: *Quinoa Salad* `1-300` and *Quinoa salad dressing* (no SKU). This is the single most useful thing the screen can say, because it shows the operator that the machine's confusion is reasonable. |
| **Matched nothing** | The name step found zero. |

These five are derived, not stored — see §8.

## 5 · Suggestions

### 5.1 · A suggestion is a query result, not a judgement

Stated on the screen, in the panel's own words, not only in this document. The drawer's suggestion
list is headed by a line saying these are products whose name or code resembles the line, and that
the machine has not chosen. **No highlighted default. No first-position emphasis. No "best match"
badge, score, percentage or ordering by confidence.** Nothing that would make a fast operator press
the top one.

The reason is in the survey and belongs on the screen's conscience: in 90 days the resolver's own
name-matching produced **one correct deduction and two wrong ones** — a combo resolved to half itself
and a 50g side deducted against a 250g tub. A suggestion list built from the same kind of query has
the same accuracy, and presenting it with confidence styling would launder that.

### 5.2 · How they are produced

Three queries, unioned, deduplicated by product id, **presented in one flat list sorted by SKU** —
not by which query produced them, because query provenance is a confidence signal and §5.1 forbids
those.

1. **By SKU fragment** — any `(\d+-\d+)` token in the line name, matched against `store_products.sku`
   exactly, and against the `S(…)` serving form. This is what catches `3-250s` → `S(3-250)`.
2. **By name fragment** — the CJK runs and English runs of the line name, `LIKE %…%` against
   `name_en` and `name_cn`. Deliberately the **same probe the resolver uses**, so the screen shows
   the operator what the machine saw, including when that is two rows.
3. **By existing map at the other store** — a product mapped to a similar channel name at the *other*
   store. This is the case the survey's one genuine save covers: `S(3-250)` mapped at 天河 and not at
   越秀.

Every candidate is filtered to `COALESCE(is_active,1) = 1`.

**At most 8 shown**, with a count of how many more matched and a search field to reach them. Eight
because the largest real candidate set in the survey is small (twelve rows match `%Whole%`, and that
is the pathological one), and because a list long enough to scroll invites picking from the visible
part.

**Each candidate row shows:** name (one language, §1.11), SKU, variant label where the row has one,
current on-hand at **this** store, and its channel mapping state at this store. On-hand and mapping
state are there because they are the two facts that most often settle it — a product with 0 on hand
at this store is usually not what was sold, and a product already mapped is usually not what went
unmapped.

**Always present, never styled as a suggestion:** a search field for the whole active catalogue. The
right answer is sometimes not in the list, and the survey's guacamole case is exactly that — the
right answer was *no product we hold*.

### 5.3 · What the screen cannot know: pack size

`units_per_pack` lives on a **claim** — a `meituan_product_map` row with a non-empty `spec_key` — and
a stranded line has no claim by definition. So the screen does not know whether one line took one
unit or six.

**It deducts `qty` × 1 and says so**, on the confirm control and in the drawer, showing the units it
will move. It does not guess a pack size from the line name; the resolver's comment at
`routes/meituan-internal.js:49-51` already refuses that guess for the same reason, and this screen
must not be the place the guess sneaks in.

Where a group is a multipack this is an **under-deduction**, and the operator can see the number
before they press. Recording it here so that the later resolver work knows this screen inherited the
gap rather than closed it.

## 6 · Resolve — what is written, in what order

One approve action per group. The confirm control carries the counts (decision 3) — the operator sees
they are moving nine deductions, not one.

**Order of writes, one transaction per line, all lines in one outer transaction:**

For each line in the group, oldest order first:

1. **Link the line.** `UPDATE retail_order_items SET product_id = ? WHERE id = ?`. This is what
   removes it from the queue — the pending state is derived from `product_id IS NULL`, so nothing
   else has to be written to make it disappear (§8).
2. **Move the stock.** Through the existing adjuster (`inventory.adjustStock`), which is what also
   fans the change out to the channels — the same reasoning the waste route records at
   `routes/retail-waste.js:380-393`. Clamped at zero, matching the channel order path
   (`routes/meituan-internal.js:486-492`): the goods left the shelf, so a shortfall is a count that
   was already wrong, not a reason to refuse. A shortfall is recorded on the result (§6.2).
3. **Log it.** One activity entry per group, not per line, naming the line, the product chosen, the
   store, the line count and the unit total.

If any line fails, the whole group rolls back. A half-resolved group is the one outcome that would
leave the operator unable to tell what happened.

### 6.1 · The movement's shape, and where the order reference lives

Written into `retail_stock_ledger`, which already carries every field this needs:

| Column | Value | Why |
|---|---|---|
| `store_id` | the group's store | |
| `product_id` | the product the operator chose | |
| `delta` | `− qty` for that line | One movement per line, never one aggregated movement for the group. Nine lines, nine rows. |
| `reason` | **`meituan_order_late`** (recommended) | See below. |
| `ref_table` | `'retail_orders'` | |
| `ref_id` | the original order's id | **This is where the order reference lives.** The order's date is reachable through it (`retail_orders.placed_at`), so the date is not duplicated as data. |
| `channel` | `'meituan'` | |
| `note` | The order ref, the original order date in the location's zone, and the channel line name verbatim | The human-readable half of the same fact, for a person reading the ledger without following the reference. |
| `created_at` | **today** | Decision 1. Not backdated. |
| `actor_user_id` / `actor_label` | the operator | Both, per the `retail_stock_ledger` convention — two colliding id spaces, so the label is the field to read. |

**Why the `meituan_` prefix on the reason matters.** The Stock activity screen derives its channel
from a prefix match — `WHEN l.reason LIKE 'meituan%' AND s.code = 'tianhe' THEN 'meituan_tianhe'`
(`routes/retail.js:14025-14034`), and `ACT_SOURCE_FILTER` filters the same way. A reason beginning
`meituan_` is classified and filterable **with no change to that screen**. A reason named anything
else falls to `'manual'` and reads as an operator adjustment, which is the one thing this movement is
not.

**Why a distinct reason rather than reusing `meituan_order`.** Decision 1's whole purpose is that a
month-end count can explain a movement with no sale on the same day. A distinct reason is what makes
that explicable in one query instead of by inspecting notes. This is a **vocabulary addition** —
`retail_stock_ledger.reason`'s comment enumerates the set — so it is a change to be made
deliberately, in the same change as this screen, not discovered later.

### 6.2 · What the operator sees afterwards

- **In flight** (§1.12): the confirm control disables and says so, for the duration. Not optional —
  the patterns document names this as the rule most often skipped, and this control writes N
  movements.
- **On success**: the group leaves the list, in place, without a page reload. A confirmation names
  what moved — the product, the number of lines, the total units, the store. Toast, because it is a
  confirmation (§1.12: toasts are for confirmations, never for failures).
- **Where a line clamped at zero**: the confirmation says so, per product, and stays until
  acknowledged rather than toasting away. An under-deducted shelf is a fact the operator needs to
  carry to the next count.
- **On failure**: an inline error next to the control, naming what happened and what to do. Never a
  toast (§1.12).
- **The list re-counts.** The header status line and the Orders status line both fall by the group's
  size.

### 6.3 · Two consequences worth stating before they are discovered

1. **Resolving edits a past order's line.** Setting `product_id` on a historical row means per-product
   revenue reports that `SUM(line_total)` grouped by product will now include that line. That is the
   correct answer — the sale really was that product — but it means a report run before and after
   resolution differs. It is a restatement, and it is right.
2. **The line's snapshot names stay as the channel wrote them.** `retail_order_items.name_en` /
   `name_cn` are order-time snapshots and must not be rewritten to the product's name. The order
   should keep saying what the customer bought.

## 7 · Dismiss — the third state

8 of 47 lines are cutlery (`无需餐具`, `适量餐具`) and 7 are Meituan truncations (`1-380)`,
`加热Yes)`). **Both are correctly unresolvable.** Cutlery is not a product and nothing should come off
a shelf for it; a truncation names nothing at all.

These must leave the queue **without pretending they were fixed**. Dismissed is a third state:
neither pending nor resolved.

- **The action is per group**, like resolve, and it is a **Secondary** control, never Ghost and never
  adjacent enough to the confirm to be pressed by accident.
- **It writes no stock movement.** That is the whole point of it.
- **It is reversible and it is recorded.** Who dismissed it, when, and — optionally — one short
  reason. Nothing with history is deleted (`tacet-consolidation-decisions.md` §20); a dismissed line
  keeps its row and gains a state.
- **The screen can show them.** A `Dismissed` filter chip alongside `Pending`, with its count. A
  queue that can only hide things is a queue nobody trusts.
- **A new line matching a dismissed group does not auto-dismiss.** It arrives pending. Cutlery will
  therefore come back, and that is the honest behaviour: the screen has not been told cutlery is
  never a product, it has been told *these particular lines* were not. Auto-suppression by name is a
  rule the operator has not written, and writing it is a separate decision.

**This is the one thing the design needs that the schema cannot currently express.** `retail_order_items`
has no state column. The recommended shape is a small companion table keyed on the line id, holding
the dismissal, its actor and its timestamp — rather than a column on `retail_order_items`, because
dismissal is a fact about the *review* of a line, not about the order, and the orders table should not
grow a workflow field. **Recommended, not decided; it is the only persistent addition this design
requires.**

## 8 · State is derived, not stored

Three states, and two of them need nothing new:

| State | How it is known |
|---|---|
| **Pending** | `product_id IS NULL` and no dismissal row |
| **Resolved** | `product_id IS NOT NULL` — the line simply stops matching the query |
| **Dismissed** | a dismissal row exists |

No status column on the line, no queue table, no job. The queue is a **view over the orders that
already exist**, which also means it is correct retroactively on the day it ships: the 47 lines from
the last 90 days appear the moment the screen does, without a migration or a backfill.

## 9 · What the operator is told on arrival

The header, per §1.7 — title, status line, and the primary-action slot **left empty**, because this
screen has no create action and the slot is never filled with a secondary.

The status line carries three facts, in this order:

1. **How many stranded lines are pending**, and in how many groups. The two numbers differ a lot —
   today, 47 lines in 16 groups — and the group count is what the day's work actually is.
2. **Over what period.** The date of the oldest pending line — today, **26 June**. That is the
   sentence that makes an eight-week-old pita cluster feel like what it is.
3. **How much stock is affected** — the total units across pending lines; today, **54**. This is the
   honest headline number: it is what is standing on a shelf that the system believes is there and is not.

Cutlery and truncations are counted in these numbers until they are dismissed. That is deliberate:
suppressing them by guess would put the screen back in the business of deciding what a line means.

**Empty and no-results are both required** (§1.12), and they are different sentences here:

- **Empty** — nothing is stranded. A compliment, not an apology: every line that arrived found its
  product. Name what will arrive here when it does.
- **No results** — a filter or a search matched nothing, with the filter named and an offer to clear
  it. Never a compliment.

## 10 · Should resolving also offer to create the map? — a recommendation, not a decision

**Recommendation: yes, as a separate, unticked, clearly-worded option on the resolve action — and
only when the screen can state exactly what it would write.**

The case for it is in the survey and it is strong. Both ambiguity clusters were mapping problems, not
name problems:

- **Pita** — row 351 had no map at all until 2026-08-24 09:15:11, two hours after the last failure.
  Nine sales were lost, and the tenth was saved by a mapping someone made by hand.
- **Quinoa** — `meituan_bundles` row 16 exists with the right components, registered at **tianhe**,
  while every failure is at **yuexiu**.

Resolving without offering the map fixes one sale and leaves the next one to fail identically. The
operator who has just told the screen what this line is holds exactly the knowledge the map wants.

Three cautions, which are why this is a recommendation and not a decision:

1. **The map's key is the channel's listing name, and a stranded line is not always a listing name.**
   `Whole-Wheat Pita皮塔面包(一个)(Yes)` carries an option suffix; the map row that fixed it holds
   `Whole-Wheat Pita皮塔面包(一个)` without it. Writing the line verbatim into `meituan_name` would
   create a map row that matches this exact option and nothing else. The screen would have to either
   show the operator the string it is about to write and let them edit it, or write nothing.
2. **A combo cannot be mapped at all.** The quinoa case wants a `meituan_bundles` row with components
   at the right store, which is a different object with a different shape — and the components are
   two products, not one. Offering "create the mapping" on a combo would be offering something that
   cannot be done. The screen would need to recognise a combo, and it has no reliable way to.
3. **`meituan_product_map` already has a hygiene problem.** `docs/channel-mapping-findings.md` (F5)
   records 387 rows all still `sync_enabled = 1` from four bulk June runs, and (F1) three stranded
   mapping rows on deleted products that no screen can reach. Adding a new one-click writer into that
   table without the retirement story is how F5 gets bigger.

**The shape I would recommend if it is taken:** an unticked checkbox on the resolve action, present
**only** when the line looks like a plain listing name and no map row exists for that product at that
store, showing the exact `meituan_name` it will write with an editable field, and absent entirely
otherwise. Never ticked by default — the same reasoning as §5.1, and for the same reason.

## 11 · The second channel

Design for Meituan. `eleme_order_import` holds **0 rows** and no order has ever carried
`channel = 'eleme'` — the Eleme resolver has never executed a line, and building a channel switcher
for it now would be designing against a shape nobody has observed.

Where the design extends, when a second channel does arrive:

- **The queue query is already channel-agnostic.** It reads `retail_order_items` joined to
  `retail_orders`; the channel is a column, not a branch.
- **The group key gains nothing.** `(line name, store)` already distinguishes channels in practice
  because two channels do not send the same listing name to the same store — but if that ever became
  false, the key gains `channel` and nothing else changes.
- **The "Why" vocabulary is shared.** The Eleme resolver has the same four steps and the same failure
  words.
- **What is channel-specific and would need a second answer:** the ledger `reason` prefix (§6.1), and
  the map-creation offer (§10), which writes to a channel-specific table.
- **What would need designing rather than extending:** a channel filter chip on the list. Not now —
  with one channel it is an empty axis, and A1 forbids rendering an empty control to fake density.

## 12 · What this design does not cover

- **The name fallback.** Not touched. After this screen exists, it can be judged from what the screen
  shows, which is the point of building the screen first.
- **The `sku_unknown` family.** Seven of the 47 are Meituan truncations that still carry a
  `\d+-\d+` token. Whether the resolver should recover those is resolver work.
- **Retrying resolution automatically.** The design adds no job and no re-resolve pass. A stranded
  line is resolved by a person or dismissed by a person.
- **Stranded lines on the mini app or web store.** Those orders are authored here; their lines cannot
  strand.
- **`docs/channel-mapping-findings.md`'s F1-F5.** Adjacent, real, and separate work.

## 13 · Strings that need a Chinese half — please choose

**No Chinese was composed for this document.** Every visible string below needs a decision before
anything is built. Where a live precedent exists I have named it with its file and line; where none
exists I have said so rather than reaching for one.

| # | English | Precedent I would copy | Status |
|---|---|---|---|
| 1 | **Dismiss** (the action, §7) | `Dismiss · 忽略` — a live button pair already in `public/retail-admin.html` | **Verbatim precedent. Ready.** |
| 2 | **Dismissed** (the state / filter chip, §7) | `Ignored · Guanyi will be corrected · 已忽略` — live in the same shell | **Verbatim precedent. Ready.** |
| 3 | **Store** column | Live pair used throughout Orders | Ready |
| 4 | **First / Last** (§4) | `Your latest order · 最近订单`, and `首次下单` — both live | Likely ready; the exact column-header form is your call |
| 5 | **The screen's title** | *No label pair exists.* The nearest live strings are `未匹配` (used mid-sentence in delivery-zone copy, in the same sense) and `未关联` from `Not linked · 未关联` in the Meituan tab — but that names a product↔listing map, not an order line | **ASK.** Three candidate English titles below; the Chinese half is yours to give. |
| 6 | **Times** / **Units** columns | None found for this sense | **ASK** |
| 7 | **Why** column, and its five values (§4.1) | None found — `no claim / no SKU / no map / matched N / matched nothing` are internal resolver words that have never been shown to anyone | **ASK.** This is the largest group and the one most worth getting right, because it is the only thing on the screen that explains the machine. |
| 8 | The confirm control, e.g. **Deduct 9 lines** | None found for a counted confirm | **ASK** |
| 9 | The suggestion panel's heading and its one-line disclaimer (§5.1) | None found | **ASK** |
| 10 | Empty and no-results sentences (§9) | The house has many examples of the *form*, none of this sentence | **ASK** |

**On the title (#5), three candidates, English only, for you to pick before the Chinese question is
even asked:**

- **Unmatched lines** — closest to what the data is. Reuses the resolver's own word.
- **Stranded lines** — your phrase. Vivid, and it names the consequence rather than the mechanism.
- **Lines without a product** — plainest, longest, needs no gloss.

I would pick **Unmatched lines**: it is the shortest of the three that a person who has never read
this document can act on, and it is the word the system already uses internally, so the screen and
the log agree.

---

## Appendix · What the screen needs to read

No new read model is required; both queries already work today and produced §2.1's numbers.

**The queue** — one row per group:

```sql
SELECT o.channel, o.store_id, i.name_en, i.name_cn,
       COUNT(*) AS times, SUM(i.qty) AS units,
       MIN(o.placed_at) AS first_seen, MAX(o.placed_at) AS last_seen
  FROM retail_order_items i
  JOIN retail_orders o ON o.id = i.order_id
 WHERE i.product_id IS NULL
   AND o.channel IN ('meituan')
 GROUP BY o.channel, o.store_id, i.name_en, i.name_cn
 ORDER BY times DESC, last_seen DESC;
```

*(plus the dismissal join once §7's companion table exists)*

**One group's lines** — for the drawer:

```sql
SELECT i.id, i.qty, i.unit_price, i.line_total, i.sku AS channel_sku,
       o.id AS order_id, o.order_no, o.placed_at
  FROM retail_order_items i
  JOIN retail_orders o ON o.id = i.order_id
 WHERE i.product_id IS NULL AND o.store_id = ? AND o.channel = ?
   AND COALESCE(i.name_en, i.name_cn) = ?
 ORDER BY o.placed_at;
```

The "Why" values (§4.1) are **derived at read time** by re-running the resolver's own probes against
the stored line name — not by reading a stored reason, because no reason is stored. That is a
deliberate design choice with one consequence worth naming: the Why cell describes what the resolver
*would* decide today, not what it decided when the line arrived. For the pita cluster those differ —
the map now exists — and showing today's answer is the more useful of the two, because it tells the
operator whether the problem is still live.
