# The Operations menu — two options, drawn to be chosen between

> **DECIDED 2026-09-13 by Ash: OPTION B** (§117), against this document's own
> recommendation of A — §7 is left exactly as written, because a recommendation tidied away
> after it was declined cannot be re-checked.
>
> **Then, on the evidence B produced, TWO OF A'S FOUR RENAMES were adopted (§118):**
> `Delivery → Delivery settings` and the 收货 collision, closed in all six places §1 lists.
> `Invoices` is deliberately not renamed — batch three folds that row into Orders.
> **A's grouping and its three pills remain undecided.**
>
> **§4's "honest limit" was wrong, and so was this session's first reading of it.** B does
> not answer one question with two destinations: it asks two questions, each going straight
> to its screen, so B never needed A's renames at all. The claim that it did was made in
> chat and corrected in §117. What the built strip DID produce is the argument for the
> rename as an observation rather than a prediction — in Chinese, both questions' second
> lines read 收货, because the rows they name were the same word.

**Written 2026-09-13 as a design pass**, before anything is built: five artboards added to
`design-handoff/mobile-v2/` and the canvas re-seeded, so the choice is made once, in the
open, rather than inherited from whichever option somebody started. Nothing in
`public/m.html` is changed by this document.

The brief: *"it's not clear for any account what every feature of Operations does — the
name, the explanation, etc."* This answers the naming and the grouping. It does not
propose a subtitle under every row, and §5 says why.

**Line numbers here are 2026-09-13 coordinates** and drift. Re-verify before use; never
quote one as a current position.

---

## 0 — The one-paragraph answer

The Operations list is **twenty-two rows under one heading**, labelled with bare nouns that
name a topic rather than an outcome, containing **five clusters that read as duplicates**
because nothing on a row says who the screen goes to. Three rows are not merely vague but
**wrong**: `Delivery` is a settings screen sitting in a list of tasks, and `Receiving` and
`Receive delivery` **both read 收货**, so a Chinese-reading operator sees one row twice.
The fix is not more words per row — it is **grouping by the job**, a **pill where the label
cannot carry the fact**, and **four renames**. That is twelve new strings against a
subtitle's forty-four, and it closes the 收货 collision on the way past.

---

## 1 — What was verified

| Claim | Evidence |
|---|---|
| The list is twenty-two rows under one heading | `public/m.html:4139–4174` — one `MORE_GROUPS` entry, `h:['Operations','运营']` |
| `Delivery` is a settings screen, not a worklist | `screenDelivery()` at `:4886` renders holiday mode, delivery zones, provinces covered, same-day districts, stores located, same-day cut-off, the maps key and payment methods. No order list, no queue, nothing waiting on anyone |
| The design system already classifies it as configuration | `design-handoff/mobile-v2/README.md`, batch three: "Delivery — A4 Console". A Console is the configuration archetype; the menu row offers it among twenty-one tasks |
| `Receiving` and `Receive delivery` share one Chinese label | `:4139` — `['receiving','package','Receiving','收货']`; `:4169` — `['receivexfer','truck','Receive delivery','收货']` |
| The collision is in the screen titles too, not only the rows | `SUBS.receiving` at `:11565` and `SUBS.receivexfer` at `:10844` both carry `'收货'` |
| The transfer flow calls itself by the other row's name | `:10385`, `:10397`, `:10412` — the receivexfer screen's own back and count buttons render `T('Receiving','收货')` |
| 收货 is correct and established for supplier receiving | 50 uses in `public/m.html`; 48 of them are the supplier flow, including `QUICK_VERB`'s `确认收货` at `:3446`. **The word is not the defect** — the transfer flow taking it as its name is |
| 调拨收货 is already live for the transfer concept, in that same flow | `:9384` and `:9408` — `T('This account cannot receive transfers.','此账号无法确认调拨收货。')`, on the receivexfer error path |
| 配送设置 is live for delivery configuration | `public/retail-admin/17-setup-guide.js:844` — `'完成配送设置后，此步骤会自动完成。'` |
| `Invoices` is 发票 a customer asked for, not a supplier bill | `:7881` — the screen's segments are `All · Issued · Pending` over the fapiao queue (`lib/fapiao-queue.js`) |
| A row already carries a fact the label cannot | `stockAppLabel()` at `:16766` returns `Add stock` or `Quick stock` by capability — a row label is already not fixed |
| Per-row alternate phrasing already has a table | `QUICK_VERB` at `:3444` — three rows, bilingual, keyed by row key, for the Quick-actions picker |
| One added field would reach all three consumers | `moreGroups()` at `:4184` feeds the More list, the tab bar and `searchIndex()` at `:15912`; `quickCatalogue()` at `:3454` reads the same two sources |
| `Approvals` needs a capability no floor preset holds | `:16686` — `approvals:'expenses:approve'`. It renders identically to rows everyone has |

---

## 2 — Why the list is unclear, in four parts

**The labels name a topic, not an outcome.** `Pick`, `Trend`, `Waste`, `Receiving`,
`Invoices`. A noun tells you the subject and leaves what happens when you tap it to be
guessed. The three rows that already read well — `Ask the kitchen`, `Ask for stock`,
`Ask to buy` — are the three that carry a verb *and* the party on the other end.

**Three rows are wrong, not vague.** `Delivery` is configuration. `Receiving` and `Receive
delivery` are one word in Chinese. These are defects with or without this design pass.

**Five clusters read as duplicates:**

| Reads the same | Is actually |
|---|---|
| `Purchasing` / `Ask to buy` | you order from a supplier / the kitchen asks the buyer to order |
| `Add stock` / `Ask for stock` | you add what is in front of you / you ask another shop to send some |
| `Receiving` / `Receive delivery` | arrives from a supplier / arrives from another of your shops |
| `Kitchen queue` / `Ask the kitchen` / `Ready from the kitchen` / `Log a batch` | what is to be made / place the request / what is done / record the run |
| `Expense` / `Approvals` | you claim / you approve other people's claims |

**Nothing on a row says who it goes to.** Roughly half these rows ask someone else for
something, half record what the operator did, one reviews other people's work, and one is
configuration. That distinction is the single most load-bearing fact about a row and it is
absent from all twenty-two.

**The explanations already exist, and fire too late.** `screenAskKitchen()` tells an
operator *"The kitchen sees it now. Nothing moves until they make it."* — on the
confirmation screen, after they have committed (`:10196`). `screenReceiveTransfer()` says
*"Deliveries from another location show up here."* — as an empty state (`:10430`).
`screenPurchasing()` explains itself at `:6799`. These are the row descriptions. They are
shown at the wrong moment, to the person who least needs them.

---

## 3 — Option A · grouped by the job

`OpsGrouped.dc.html`, and `OpsGroupedPhone.dc.html` for what clears the fold.
`OpsChanges.dc.html` draws the words on their own.

**Eight headings, twenty-two rows, no row moved out of Operations:**

| Group | Rows |
|---|---|
| Take an order | New order · Counter till |
| Money and numbers | Sales · Trend · Issue tax invoices |
| Send it out | Pick · Delivery settings |
| Stock coming in | Purchasing · Receive from a supplier · Receive from another shop · Add stock |
| Making things | Kitchen queue · Log a batch · Ready from the kitchen |
| Ask someone else | Ask the kitchen · Ask for stock · Ask to buy |
| Record and review | Waste · Expense · Approvals |
| Messages and channels | Inbox · Channel sync |

**The grouping is what disambiguates.** Every confusable pair in §2 lands in a different
group from its twin — `Purchasing` under *Stock coming in* and `Ask to buy` under *Ask
someone else*; `Add stock` and `Ask for stock` likewise. No sentence is needed to separate
them because their position already does it.

**Three pills, and no pill is the default.** A row the operator simply does wears nothing,
which is what keeps the pill scarce enough to read:

- **Ask** — on the three request rows. It goes to someone else and nothing moves until they act.
- **Approve** — on `Approvals`. This is other people's work, not yours.
- **Settings** — on `Delivery settings`. Configuration, not a task.

All three are `p-mute`. A direction is a fact about the row, not a state needing attention —
the same reason batch two made tier pills neutral. Sage and Amber are not spent here.

**Four renames, and only four.** Every other row keeps the name it wears today: a verb
invented for a screen is how "Add product" happened, and a rename costs muscle memory and
search terms.

| Today | Proposed | Why |
|---|---|---|
| `Delivery` / 配送 | **Delivery settings** / 配送设置 | It is zones, holiday mode and the printer — the only configuration screen in a list of twenty-one tasks |
| `Receiving` / 收货 | **Receive from a supplier** / 收货 *(unchanged)* | Chinese stays. 收货 is the established word for this across 48 sites; only the English needs to say which half of the pair it is |
| `Receive delivery` / 收货 | **Receive from another shop** / 调拨收货 | Closes the collision, with the pair already live in this screen's own error copy at `:9384` |
| `Invoices` / 发票 | **Issue tax invoices** / 开票 | **Interim.** In English it reads as supplier bills. See the caveat below |

**The `Invoices` caveat.** Batch three already decided *"Invoices is not a page"* — §4 folds
fapiao into Orders as a filter, and the phone's screen is a leftover to fold in rather than a
page to design. The rename is proposed only as what the row should say **until that happens**.
If the fold-in is near, do nothing to this row and let it go.

**Cost:** eight headings + three pills + four labels ≈ **twelve new strings**. One Chinese
label changes, and it is a copy of a live pair.

---

## 4 — Option B · the operator's own words above the list

`OpsAsk.dc.html`.

A short block at the top of the sheet, headed *"What do you need to do?"*, with plain
questions routing to the screen that answers each:

| Question | Goes to |
|---|---|
| Something arrived | Receive from a supplier · from another shop |
| I need more stock | Ask for stock |
| Something got thrown away | Waste |
| I paid for something myself | Expense |
| The kitchen needs to make something | Ask the kitchen |

**B is not an alternative to A.** The grouped list sits underneath it unchanged; B is a layer
on top and can ship in a later build. It is for the operator who does not yet know that a
thing arriving from a supplier and the same thing arriving from the next shop are two
different screens — which is the account in the brief.

**What B cannot hide.** Its first row answers one question with two destinations. Where A
makes the supplier/transfer split visible and explains it, B has to either ask a second
question or hand over a two-way pick. That is the honest limit of question-first phrasing:
it cannot collapse a distinction the data actually has.

`QUICK_VERB` at `:3444` is the existing seed — three rows of exactly this phrasing already
ship for the Quick-actions picker.

---

## 5 — Considered and not proposed

**A subtitle under every row.** The obvious answer, and the one worth arguing against. One
sentence per row is **forty-four strings**, it roughly doubles the height of the list — the
fold already cuts at nine rows — and the wall of grey text under twenty-two labels reads as
less scannable, not more. The grouping buys most of the same clarity for a quarter of the
strings. **If A ships and is not enough, subtitles are the next step, not the first one.**

**A subtitle only on the confusable rows, naming its twin.** Ten strings instead of
forty-four. Rejected because rows read defensively ("for the other thing, use…") and it
hardcodes a cross-reference that rots the moment a row moves.

**An ⓘ per row opening a longer explanation.** Keeps the list short, and nobody taps it. It
would be worth adding once the account asks *why*, not while they are still asking *what*.

**Renaming more than four rows.** `Pick`, `Waste`, `Trend` and `Counter till` are all bare
nouns, and all four were left alone. Each rename costs muscle memory and search terms, and
the grouping already tells the reader which job `Pick` belongs to.

**Moving rows out of Operations.** Twenty-two is a lot for one heading, and a drill-down
would fix it. Batch one already decided against: *"No drill-down in More. A five-item bar
and a fourteen-row rail are different problems; More is one flat, grouped list."* Sub-headings
are the flat list's own answer to depth.

**Making `Approvals` disappear for operators who cannot use it.** It already does —
`:16686` gates it on `expenses:approve` and `canRoute` filters it at `:4184`. The pill is
for the people who *do* hold it, so the row does not read as a second `Expense`.

---

## 6 — The Chinese

Per the standing rule, **nothing here is composed silently**, and nothing here is locked.

- **配送设置** — lifted from `public/retail-admin/17-setup-guide.js:844`, where it is the
  live Chinese for the delivery configuration questions. Not composed.
- **调拨收货** — **copied live pair**, from `public/m.html:9384`/`:9408`, which is the
  receivexfer flow's own error copy. The highest preference tier: it is already this
  screen's word for this concept.
- **开票** — lifted; 54 live uses in the codebase for issuing a fapiao. Interim only, per §3.
- **收货** — unchanged, staying with `Receiving`.
- **The eight group headings and the three pills have no Chinese yet.** They would be
  composed, and composing twenty-odd strings for options that will mostly be discarded would
  put rejected strings in the lock document. They get composed and declared in
  `docs/tacet-delivery-vocabulary.md` — marked composed, by whom, with the live candidates
  rejected — **in the same commit as the build that ships them**, once an option is chosen.

The artboards render English only, as every artboard in this batch does (§1.11 — source
carries the pair, one language ships).

---

## 7 — Recommendation

**Ship option A.** It is twelve strings, it fixes two live defects (`Delivery`'s name and the
收货 collision) that are worth doing on their own, and it leaves every row where it is and
every screen untouched. The whole change is `MORE_GROUPS`, one new per-row field, and the
group headings.

**Then consider B separately, on evidence.** It is the better answer for a brand-new account
and the worse bet to build first, because it guesses at which five questions matter. A is a
prerequisite either way — B's rows route into the same screens under the same names.

**Do `Invoices` last, or not at all,** depending on how near the §4 fold-in is.

---

## 8 — What shipping A would touch

Named so the build does not have to rediscover it, and so the blast radius is on the record
before anybody agrees to it:

- `MORE_GROUPS` at `public/m.html:4139` — the one Operations entry becomes eight, and four
  labels change. **The row keys do not change**, so `ROUTE_CAP`, `SUBS`, `quickKeys` and
  every stored Quick-actions preference keep working untouched.
- A **fifth element** on a row for its pill, alongside the existing `href` (fifth) and
  Features-gate (sixth) — so it lands as a seventh, or `moreRow()` at `:4200` grows a
  keyed table the way `QUICK_VERB` did. The table is the safer shape: it leaves the
  twenty-two-row literal alone.
- `moreRow()` at `:4200` renders the pill; `moreGroups()` at `:4184` needs no change, so the
  tab bar and `searchIndex()` at `:15912` inherit the new labels for free.
- `SUBS.receivexfer` at `:10844` and its three in-screen `T('Receiving','收货')` calls at
  `:10385`, `:10397`, `:10412` — the screen must stop calling itself by the other row's name,
  or the row is fixed and the screen still lies.
- `SUBS.receiving` at `:11565` and `:11570` — English title and back label only.
- `SUBS.delivery` at `:7880` — title only.
- **Not** `docs/tacet-glossary.md`. None of these renames touches a defined term: RECEIVING,
  TRANSFER and PURCHASE ORDER keep their meanings, and these are screen labels, not vocabulary.
- A decisions entry recording the choice, and the Chinese declared per §6.

**Gate:** `npm run test:fast`, plus `scripts/test_mobile_nav.js` and
`scripts/test_app_home.js`, which are the two suites that read the launcher.
