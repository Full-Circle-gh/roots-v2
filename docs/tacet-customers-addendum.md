# Tacet — Customers section addendum, 2026-07-26

> Slots into the canonical set next to the Sales, Marketing and CMS
> handoffs. **This one is different from those: Customers was taken all the
> way to production.** Everything below is live. Method unchanged —
> Ash-is-not-a-dev, briefs in their own code blocks, one yes/no at a time,
> survey-first. Claude Design builds from briefs and cannot see the code;
> Claude Code surveys and builds. **This is a save point, not a to-do list.**

## What happened

Customers went from a July mockup to a live page in one day. **25 commits
across 5 builds**, all CI-green, all deployed on push (there is no staging
here — see *Operational facts* below).

| build | what | commits |
|---|---|---|
| — | the two colour tokens, additive, nothing consuming them | `170b5c8a` |
| 1 | data & queries — `seen_at`, sleeping segment, one money measure, top-items grouping, chip counts | `0c633390` `73a73d25` |
| 2 | `seen_at` backfill, §1.7 page header, GZ-day timezone | `4177d7ed` `bb6f6c48` `f733883d` |
| 3 | roster — pinned band, unopened rows, chips, filter dropdowns, six states | `4533a7e2` `32a11fbf` `88c3f475` `b29a3bdf` |
| 4 | drawer — cards, snapshot, accordions, identity, three lying summaries | `dee4e926` `199b64aa` `11df7fa8` `8a3af95b` `7b8a951f` `ac62da13` |
| 5 | five modals, backend validation, honesty items | `0ce3b44b` `1887f34d` `cd50b0ca` `6277db0f` `ea5eacdd` `91492a52` `dc29e65c` `9d04c89e` `5391be2f` |
| — | NUL/CRLF hygiene on `routes/retail.js`, its own commit | `43258511` |

**Why five builds and not one.** The page touched a schema column, four
queries, the header, the table, the drawer and five modals. As one commit it
would have been unreviewable and unrevertible — and since every commit
deploys, a bad one is live. Splitting also meant each build's surprises could
change the next brief. Three of the five produced findings that did exactly
that.

---

# 🔴 THE FOUR LESSONS — these are the part worth re-reading

## 1. Verify the RESULT, not the action

Three separate bugs, one shape. **None was visible to a grep. All three were
caught by Ash looking at a rendered page.**

- **14 modal CSS rules were inert.** Build 5's entire modal shell was scoped
  under `#tab-customers`. `cuShowModal()` re-parents every modal to `<body>`
  on open — deliberately, so a z-300 modal can escape the tab's stacking
  context. So the moment a modal opened, none of those rules matched
  anything: the 460px cap, sentence-case labels, Ink primary, field styling,
  inline errors. The diff table that session verified the rules were
  **written**, not that they **applied**. Caught because Ash noticed a boxed
  ✕.
- **Dashed `<option>` placeholders were cleaned and immediately overwritten.**
  They were removed from the static markup and verified with
  `grep "— Select" retail-admin.html` → 0. But the five real occurrences live
  in the JS that *rebuilds* those option lists on every open. The grep passed
  against the wrong file.
- **A no-op `sed` silently dropped `sw.js` from a commit.** A concurrent
  session had already bumped the token, so `sed 's/v641/…'` matched nothing,
  changed nothing, exited zero, and the file fell out of the commit with no
  error. New CSS on the box, stale shell in browsers. **The guard is checking
  that `git status` shows the file staged — not that the command ran.**

## 2. Values, not prose — and always a diff table

**Everything briefed as measurements landed. Everything described in
sentences drifted.** Build 4's cards were specified with numbers and were
right first time; its identity block and action row were described in
sentences and drifted on both.

The fix is a **diff table before every commit** — property · mockup value ·
live value · what changed. It caught four header-band drifts plus two
invisible ones (hardcoded colours, and a bottom rule with no dark-theme
override that no light-mode screenshot could ever show), and six more on the
drawer. It cannot see the cascade — see lesson 1 — but on values it has never
missed.

## 3. Classify by inclusion, never exclusion

A denylist accepts everything invented after it was written.

- The channel row icon fell through `|| CHAN_ICON.wechat`, so
  `chanIcon('manual')` returned a **WeChat glyph on every manual order row in
  Orders** — live, and found by accident.
- `topup_total` excluded `admin_adjust` and nothing else, so `order_redeem`
  rows were summed as top-ups. It produced two negative balances **and
  understated a genuine ¥1,000 top-up as ¥18.60** — off by ¥981.40. The
  negative looked wrong and got caught; the small positive never would have.
  Replaced with an allowlist (`IN ('wechat','alipay')`), matching a correct
  precedent already in the file — though the **pattern** is what is correct
  here, not the pair: those two values are Roots' payment methods, and which
  payment methods exist is per business under
  `docs/tacet-consolidation-decisions.md` §0.
- An unmatched value must render **unknown**, never fall through to a
  plausible default. Visibly odd beats plausibly wrong.

## 4. No evidence, no claim

Three bugs were the code asserting something no data supported.

- **511 of 690 customers (74%) showed a Mini app icon** purely because the
  code defaulted `channel` to `wechat` when a customer had no orders.
- **A customer's channel is where they SIGNED UP, not where they last
  ordered.** Deriving it from orders was always a workaround for
  `retail_customers.source` never being written. Now derived from the openid
  prefix, which the insert sites own and which is `UNIQUE NOT NULL`, so it
  cannot be lost or shared. `source` deliberately **not** backfilled — two
  fields that must agree forever is worse than one source of truth.
- **`paymentBrandHTML` rendered unknown methods in bold**, inheriting the
  visual authority of Cash and Bank transfer. Bold was doing the lying.

---

## Decisions locked (do not re-argue without a better reason than made them)

1. **One money measure, and the word is "ordered."** The list read
   `lifetime_spend` (order subtotal, pre-discount); the drawer computed
   `revenue` (order total, post-discount, shipping-inclusive). Same word, two
   measures, disagreeing for every customer who had ever spent. The drawer now
   sums subtotal to match. `lifetime_spend` itself is untouched — **customer
   tiers derive from it.** *Known residual, recorded not chased:* a partial
   refund never reduces `lifetime_spend`, so the drawer's fresh figure can sit
   slightly below the list's stored one.
2. **The unopened-row state uses the SHARED model, matching
   `retail_orders.seen_at`** — one timestamp, stamped by whoever opens first,
   no operator identity. It means "nobody on this team has opened this", not
   "you haven't". Chosen over a per-operator table so Customers matches
   Orders. **Backfilled** on ship: 690 rows stamped as seen, because 690
   tinted rows would have taught the operator to ignore the marker before ever
   using it.
3. **The sage "New" pill was REMOVED, knowingly.** It meant *signed up today
   in GZ time* (`created_at`), which is **not** what the unopened treatment
   means. This was initially approved on the assumption they were the same
   thing; the survey proved otherwise and it was re-decided with the
   difference understood. **Known consequence:** the "New today" tile still
   counts GZ-today signups while no row identifies them. Customers has no
   per-row "arrived today" mark. Cheap to restore if missed.
4. **Meituan and Gzgrocery are correctly absent from the channel filter.**
   Every meituan (162) and gzgrocery (104) order has `customer_id IS NULL` —
   those filters have matched zero customers since the day they shipped and
   always will. Dead controls, not a capability lost. **Web (1) and Manual (0)
   stay** — they are zero *today*, not zero by construction.
5. **No status line on Customers.** §1.7 v2.6's work rule: 693 records, none
   waiting on anyone. Title alone, deliberately.
6. **Diagnostics keeps its dashes** — the one place in the product where a
   dash survives, because there it means "this log row carried no value"
   rather than standing in for zero.
7. **Modal primaries are Ink, not Dusk**, matching Team and FAQ. The
   rulebook's §1.8 still says a modal owns its Dusk; that is the known
   unwritten clarification. **Focus rings stay Dusk** — a focus ring is not an
   element making a claim.
8. **The address label was considered and deliberately not added.**
   `retail_customer_addresses` has no `label` column; the mockup's
   "Home"/"Office" was invented demo data. Deriving one from `district` would
   invent a name the customer never chose.

## Backend changes worth knowing

- **`PATCH /customers/:id` gained email format validation and a duplicate-phone
  check**, both of which create already had — so create-then-edit was a working
  bypass of both. **The phone check fires only when the number is CHANGING.**
  17 customers already share 4 numbers; a check on every save would have
  permanently 409'd all 17, blocking an operator from fixing a typo in a
  *name*. The rule is "don't create new collisions", not "refuse to touch old
  ones".
- **Expiring points are clamped** to the balance at the read site. It is a
  **display clamp, not lot-tracking** — FIFO tracking of which lots a
  redemption consumed is a real feature, deliberately not attempted. Measured
  before shipping: 72 customers have expiring points, 6 were overstated, worst
  case by 2.
- **Diagnostics unavailability is now reported.** The endpoint wrapped
  everything in try/catch and returned `error_count_7d = 0` on failure —
  byte-identical to a healthy customer. A failure read as an all-clear.
- **Three collapsed accordion summaries were lying**: Recent orders and Points
  ledger showed the length of a truncated list (a 48-order customer read
  "10"), and Points ledger labelled it "earned" when it was neither.

## Test data — do not chase

- **`asher` (customer 233)** — Ash's test account. Also ids **57 and 64**, the
  two `_reset_` rows from the same test. All three share phone
  `18613159912`.
- **Phone `15360475622` — ids 76, 224, 239, 332, 352, 360, 382, 721.** Eight
  accounts, **one Android emulator** (`AOSP on Pixel` on every auth token),
  zero orders, zero addresses, zero spend. Six carry raw `wxid_*` nicknames
  and one is named `wx_test11111`. Each signed up, bound the phone, voted once
  in a poll, never returned. **Not data.** Any survey that finds this cluster
  and chases it is chasing a test.

## Operational facts that bit this session

- **Every commit on `main` deploys.** The post-commit hook auto-pushes and CI
  deploys from main. There is no staging step. This is the documented design
  (the deploy race was closed in July precisely so CI owns deploys) — a future
  survey that "discovers" it should not treat it as a problem.
- **A second session was active on the repo**, colliding twice in one day. The
  first was harmless; the second silently dropped an `sw.js` bump. **Both
  sessions touch the same `sw.js` line**, so every client-asset change
  collides there by construction.
- **`routes/retail.js` contained three literal NUL bytes** — deliberate
  composite Map keys. Git classifies any file containing NUL as *binary*, so
  it was exempt from line-ending normalisation, `grep` needed `-a`, and a
  29-line change committed as a 26,000-line diff. Fixed in `43258511` by
  writing them as `'\u0000'` escapes: runtime-identical, file is text again.

## Still open on Customers (none blocking)

- **The drawer's "earned" points figure excludes 10,735 migrated points and
  every poll vote** — five of nine live point sources fall into no bucket.
  An incomplete allowlist *understates* rather than invents, which is the safe
  failure. This is a definitional question about what "earned" should mean,
  and it touches the same migration machinery as the open welcome-voucher
  question. Decide it there, not here.
- **Nothing has been checked in dark mode.** The tokens were verified
  numerically in both themes; no human has looked at the drawer or the modals
  dark.
- **The create flow's carry-over outcome has no live trigger.** It needs an
  unclaimed `retail_migration_credits` row for the phone being typed. Nobody
  will see it until a real legacy customer walks in.
- **`retail_customers.source` is written only by the admin create endpoint**,
  which has never run in production. It is correct and simply unexercised.
- **The mobile card path (`rmRenderCustomerCards`) was surveyed but not
  rebuilt.** Its seams are documented in `MEMORY.md`; the tail call at the
  bottom of `cuLoad()` is the one that matters — drop it and the phone list
  goes permanently blank with no error.

## Reality check (house rule, unchanged)

Ash has never used most of these surfaces with real habits and data. **The
greps find what exists; only he finds what's reachable.** Every one of the
three cascade bugs, the boxed ✕, the glued bilingual string, the doubled
`#464 · #464`, the Amber sessions count and the hover-on-a-dead-row was
caught by him opening the page and looking. **Every doc that disagreed with
the code lost, every time — cite the symbol, not the line.**

And one earned this session in the other direction: **a diff table that
compares intent to source cannot see the cascade.** Twice the cascade won
silently. The rendered page is the only check that closes that loop.
