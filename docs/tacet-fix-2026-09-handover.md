# Tacet — fix pass, September 2026

Companion to `docs/tacet-audit-2026-09.md`. That document says what is wrong.
This one says what has been changed, what has deliberately **not** been changed,
and the eleven questions that needed your answer before the rest could move.
Nine of the eleven are answered and built. The tenth — the money-storage
migration — is written and waiting on a single rehearsal run against a copy of
production. The eleventh (D-05) is yours by the brief.

Branch: `claude/tacet-audit-2026-09-tpkn60`, deployed in three passes:

| | What | State |
|---|---|---|
| **Part one** | the first 36 findings | merged and live (commit `24f3991`) |
| **Part two** | §1b's nineteen | merged and live (commit `5070ca1`) |
| **Part three** | N-02, I-03, E-07's purchase orders, K-01, and rung 1 of the money ladder | on the branch, deploys with the next merge |

---

## 1. What is fixed

Twenty-two commits, worked strictly down by severity. Both Critical findings that
could be fixed without a decision, every High that could, and fifteen Mediums
and Lows that were cheap and clearly right — 33 findings in all.

**Three more since you answered:** you said *3b · 5 do it · 10 account*, and all
three are done and pushed. They are the last three rows of the table.

| Finding | Severity | What changed |
|---|---|---|
| **D-01** | Critical (latent) | Purchasing, Recipes and Materials wrote to the first merchant's database through a module-level handle. Every statement in the three files now goes through the signed-in account's connection. One exception is named and commented: the `activity_log` read, because that table is control-plane. |
| **A-01** | High | The product list stopped at 500 and the counter reported that as the whole catalogue. It now returns the real total and says "first N of M — search or filter to reach the rest". |
| **A-02 / A-07** | High / Medium | A mistyped shelf count wrote zero, and a negative count was accepted. Both refused, with a sentence saying what to type. |
| **A-04** | High | Every timestamp rendered on Guangzhou's clock for everyone. `/config` now returns the account's own timezone and the shared formatter uses it. |
| **A-08 / I-01** | Medium / High | Nine ways to write an amount. Now two, both from the merchant's currency: `acMoney` (exact, thousands grouped) and `acMoneyCompact` (whole units, KPI tiles and axes only). |
| **B-01** | High | A new merchant's Products screen said their filter matched nothing. Two states now: nothing matches, and you have no products yet. |
| **B-02** | High | An order that arrived from the shop or a marketplace could not be annotated at all. `PATCH /orders/:id/note` and a field in the drawer. |
| **B-05** | Medium | Escape threw away a half-finished product without asking. |
| **B-06** | Medium | Orders had no way to clear its own filters. |
| **C-01** | High | The Team screen asked the owner to type a number into a browser pop-up. Five native dialogs replaced; `askChoice` added to the shared dialog module. |
| **C-02** | Medium | Four date formats. The three bespoke formatters now call the shared one. |
| **C-04** | Low | "The daemon will push it" — three strings, rewritten. |
| **D-03 / I-01** | High | 188 hardcoded ¥ conversions across twelve files. Every amount now renders in the merchant's currency, including the coupon presets offered on day one. |
| **D-04** | Medium | Shared feature copy named the first merchant's loyalty programme, in three places. |
| **D-06 / D-07** | High (latent) / Medium | Delivery reminders went to a user table an account's staff are not in; every link pointed at the first merchant's web address. |
| **D-09** | Medium | The admin blocked first paint on a font host that is unreachable where the only live merchant trades. Loaded non-blockingly now, on three surfaces. |
| **E-01** | High | 139 call sites had been writing to `activity_log` for years and nothing read it. Settings → Change history, with filters and an export. `activity_log` gains a `tenant_id` — it is control-plane, so without it the screen would have shown every merchant everyone else's history. |
| **E-02** | High | Customers could not be given a note or a tag. Both, searchable, filterable, on the roster row and in the export. |
| **E-03 / F-01** | High / High | Orders had no row selection. A selection bar with three forward steps. Refund and cancel are deliberately absent. |
| **E-04** | High | Orders, customers and the finance ledger could not be exported. Three CSV endpoints, each honouring the filters on screen. |
| **E-06** | High | Stock never told anyone it was running out. A daily digest, on by default, at an hour the merchant sets. |
| **E-11** | Medium | There was no bookkeeper role. There is now, seeded for every account, holding the books and nothing else. |
| **A-09 / G-01** | Medium | 195 toast sites showed the merchant the server's own error codes. Three layers now: the server's own message, a dictionary of 129 codes written as sentences, and — for anything unlisted — the code in words. The code itself moves to the toast's title so support can still be quoted it. Plus "quotas", the AppID error, and the JD credential block. |
| **B-04** | Low | A finished brand studio was deployed with no route and no link. It has both now, and a way back out. |
| **C-03** | Low | The Materials empty state explained a material better than any other screen and offered no way to make one. |
| **G-02 / R-02** | Medium | 280 form fields with no accessible name → zero. 158 labels associated, 58 written by hand, the rest named at runtime by the i18n walker so dynamically-built forms are covered too. |
| **J-01** | High | Six lists that grew without bound now carry a ceiling, report the real total, and say so on screen when they are cut. |
| **J-02** | Medium | Two query-per-row loops batched. **The audit was wrong about one of them** and is corrected in the same commit — see §4. |
| **N-01 / R-01** | Medium | Pinch-zoom was switched off on the phone admin. |
| **R-03** | Medium | Dark-theme muted text at 3.61:1, used 192 times. Now clears 4.5 on every dark surface. |
| **R-04** | Low | The product inspector's buttons were 26px against a 44px guideline. |
| **P-03** | Medium | Twenty kinds of notification could leave the system and no screen listed any of them. Settings → What was sent: what went out, to whom, whether it landed, and why not. Also delivers the visible half of **P-02** — every silent failure in the push, email and SMS paths is now a row with its reason. |
| **R-05** | Medium | A skip link past the rail, and a focus trap in dialogs and drawers. The 385 non-button click handlers remain — see §3. |
| **D-02** | Critical (latent) | *Answered: Q3 (b).* An alert about a merchant's day goes to that merchant's own chat app, and falls back to the platform's when they have not set one up. The cache is keyed by database path instead of holding one connection, so a second account's alerts have somewhere to go. The `/root/ops-alert.conf` mirror is deliberately **not** extended per-tenant — it exists so the platform destination survives a rename of `data/roots.db`, and a tenant read that fails falls back to the platform send, which reads it. |
| **P-02** | High | *Answered: Q5 (do it).* The other half. See the three paragraphs below the table. |
| **M-01 / M-02** | Medium ×2 | *Answered: Q10 (account).* Language is a column on the person now, not a key in a browser. `tenant_users.language` is NULL until they choose; the first choice on any surface adopts, and every surface after that follows them onto a new device. The device can still override for the session. |

**P-02, the second half, in detail.** Three things:

*The order says whether the customer was told.* An order detail carries the
latest send attempt per kind, and the drawer shows it next to the staff note —
"Delivery notice · sent to •••• 8000", or "did not arrive · the number was
refused", with a **Send it again** button. A notification that failed is amber,
never red: the order is fine and the message is not, and the two must not read
the same. The resend clears the atomic `sms_delivered_sent_at` claim first;
without that it would report success while doing nothing, which is the same lie
in a new place.

*The sign-in code.* Four call sites sent a one-time code and dropped the answer
— an expired SMS key, a mail provider refusing the account, a network blip, all
of them producing the same screen as a code that arrived. The operator then
waited for a message that was never sent, shut out of their own admin. They go
through one function now that returns the result; the screen says what happened;
the channel picker hands the choice back so the channel that still works is
still reachable. **It is not a fail-open** — a channel that is on and
momentarily failing does not sign anybody in without a code. The
forgotten-password path keeps its identical-for-every-username reply, because
"that address bounced" is still an answer to "does this username exist", so
there the failure goes to the record and the log instead.

*The empty catch blocks.* The count was 211 in the audit; a proper scan of
`routes/`, `lib/`, `middleware/`, `public/`, `server.js` and `database.js` finds
**610** catch blocks that do nothing at all — 153 of them say why and 457 do
not. Rewriting all 457 is not a change anybody should review, and most of them
are correct. So the rule is not "no empty catches", it is *one that swallows must
carry a comment saying why*, which costs a line, cannot be written without
thinking about the case, and turns an invisible decision into a reviewable one.
`scripts/check-swallowed-errors.js` holds the ceiling at today's 457 and fails
when it is exceeded, so the pile cannot grow while it is worked down. Lower it
with `--update`; list them with `--list`. The two worst offenders are
`routes/retail.js` (72) and `database.js` (66).

---

## 1b. What has been fixed since part one

Everything below was built after the first 36 shipped, working down what was
left. It is grouped by what each one changes rather than by severity: at this
point the severities left are mostly Medium and Low, and the useful question is
what a merchant notices. Four rows are marked **part three** — those are on the
branch and deploy with the next merge; everything else here is live.

| Finding | Severity | What changed |
|---|---|---|
| **A-06** | High | *Q1, stage 1.* `lib/money.js` — exact amounts in integer cents, and RATES kept as ten-thousandths, because the production measurement showed sub-cent values are concentrated in the rate columns (a per-gram cost of 0.042 is 4.2 cents, and rounding it moves every recipe's cost basis by 5%). No schema change: this is the vocabulary the storage migration moves into. `docs/tacet-money-migration-plan.md` carries the measured baseline. |
| **A-05** | High | *Q2.* The business day is the shop's. 35 `'+8 hours'` literals replaced by the account's own offset, computed in MINUTES because India is +5:30 and Nepal +5:45. The limitation is stated in the code: one offset per query, so a DST zone is an hour out for rows near midnight for half the year — strictly better than always wrong. |
| **D-08 / H-01 / H-03** | High ×3 | *Q6.* A new merchant is asked where they trade, once, and currency, time zone and shop language follow from it. The yuan fee defaults are seeded only in yuan. An unknown country falls back to USD/UTC, deliberately not to China. A shop with no web address says so instead of finishing the checklist with a shop nobody can reach. |
| **D-10** | High | *Q7.* Guangzhou's districts were written into delivery, orders and stock routing. The districts that may choose a dispatch method are the merchant's own now. |
| **P-01** | High | *Q4.* Every alert says whose problem it is: `alertPlatform`, `alertMerchant`, `alertBoth`. A gate refuses an alert that declares no audience. |
| **N-02** | High · part three | *Q9.* An order can be taken on the phone. One screen, six sections, the same create endpoint the desktop and the till use — including the same fee quote, so the phone cannot charge a different delivery fee for the same basket. Counter sales stay at the till and drafts stay on the desktop, both for stated reasons. Nothing in the form re-renders the app while somebody is typing: on a phone that drops the keyboard. |
| **I-03** | High · part three | *Q8.* Sales tax and VAT. One rate per shop, both shapes — added at checkout, or already in the price — off until a shop sets a rate, so nothing moves for Roots. The order keeps a snapshot of the money, the rate and the shape, so a rate that changes in April cannot restate March. It shows on the checkout and its quote, the mini-app order page, the web storefront, the till, the admin drawer, the phone, the thermal receipt and the finance summary. |
| **E-05** | Larger | Products and customers can come in from a spreadsheet. The importer refuses an ambiguous comma decimal rather than guessing — `18,00` as 1800 is a hundredfold mis-price, and my own test caught it. |
| **B-03** | Medium | Four endpoints for opening and closing the shop, and no screen. There is one now, above the store list. Wiring it up exposed a wrong answer: `master` counted a shop with no marketplace as closed, so a merchant with no integration would have been told their whole business was shut while it traded. |
| **E-10** | Medium | Notifications can be tuned. Four events, each a switch, all on until somebody turns one off, filtered at the one place every send funnels through. No quiet hours, deliberately — an operational alert dropped by a clock is indistinguishable from one that failed. |
| **E-08** | Medium | A filter set can be named, kept and shared with a colleague. Private until shared; a shared view stays its author's. Orders adopts it; the module is general. |
| **E-07** | Medium · part three | What was deleted can be put back — coupons, delivery zones, hand-typed ledger rows and draft purchase orders, for sixty days, from Settings → Operations. A purchase order comes back with its lines and with its own date, so it still belongs to the month it was placed in. Only a draft can get there: the delete route refuses anything else, and a delivered order has to be stood down first, which reverses its stock and unposts its books under its own all-or-nothing rule. |
| **I-02** | Medium | Money arithmetic in SQL no longer sets the rounding. A purchase order's expense rows, a customer's lifetime spend and the finance summary's `fen()` all round the product's way — which fixes two real cases: 1.005 became 1.00, and a negative net rounded the opposite way from the positive it should mirror. |
| **G-03** | Medium | Settings has a search of its own, over the cards' own words, and fourteen of its twenty-seven cards are marked as things customers see. |
| **J-03** | Medium | The shell is compressed on the way out and a stamped file is cached properly: 3,355 KB → 1,073 KB on the wire, and nothing at all between deploys. Loading a section on demand — the audit's direction — is still open, and why is written into `lib/static-assets.js`. |
| **R-05** | Medium | The last part: about a hundred `onclick` handlers on elements that are not buttons are reachable from the keyboard, with a focus ring and without a row being called a button. |
| **O-02** | Medium | The stores and team lists can be searched. |
| **F-02** | Low | Both wizards open on the first question instead of a door screen, with the other routes beside it. |
| **E-09** | Low | Four keys: j/k to move, / to search, ? for the list. Deliberately no status key — a single letter that WRITES is how the wrong order gets dispatched. |
| **E-12** | Low | A stock count sheet for the shelves and a customer statement. Both carry the merchant's own name; the older purchase-order sheet had "Roots" written into the file, and no longer does. |
| **Q-03** | Low | Three behaviours for "clear the filters". Customers and Products now follow Waste's, which Orders already did: the button is present while something is narrowing the list and absent otherwise. Empty-state-only was serving the wrong case — a filter that matched nothing announces itself; one that matched forty out of four hundred does not. |
| **C-05** | Low | The one destructive call in the admin that did not ask, now asks. |
| **K-01** | Medium · part three | *Answered: tag the controls only.* Seven of the consequential controls carry the capability the SERVER already requires of the endpoint they call — the four refund buttons, the product delete, the delivery-zone delete and the coupon revoke — and the three screens that build them after page load now re-run the gate, without which a tag is decoration. The audit's own example is closed: the Refund / Cancel menu is built from what the operator may do, so a cashier keeps Cancel and no longer sees Refund. Nothing about what an account may DO has changed, and `scripts/test_role_tagged_controls.js` asserts that pairing against `requiredCapFor()` rather than trusting it. |
| **A-03, L-01, L-02, Q-01, Q-02** | — | Found already fixed, or one line from it. Recorded rather than re-done. |

**Five audit findings were already fixed when the audit was written** — L-01,
L-02, Q-02, A-03 and half of Q-01. Each is recorded in the commit that found it,
not quietly skipped.

**One audit finding was wrong and one of my own checks was wrong.** J-02 listed
the inventory grid as clean when it was half-batched (§4). And I reported two
orders as over-refunded: the check compared against `retail_orders.total` while
the real ceiling is `points_amount + balance_used + total`. Both orders were
correct. The correction is a visible block in the money plan, not a quiet edit.

---

## 2. The eleven questions — nine answered and built

Each is a decision I should not take for you. Every one is blocking a specific,
already-scoped change; several are a single word.

**Q3, Q5 and Q10 are answered and built** — they are kept below with the answer
marked, so the reasoning stays readable next to what was decided. The eight that
remain are Q1, Q2, Q4, Q6, Q7, Q8, Q9 and Q11.

### Q1 — A-06 · Money is stored as floating point *(High)*  ·  **Stage 1 done · rung 1 written, one rehearsal to run**

Every amount the merchant deals in is a SQLite `REAL`. Your own billing tables
already use integer cents. Converting means a schema migration, a data
conversion, and touching every read and write of every money column.

**Why it matters:** floating point loses fractions of a cent on repeated
arithmetic, and the refund tender split already compensates by hand
(`Math.round(x * 100) / 100`, and a full-refund test that adds 0.005). Today it
is invisible; the day it is not, it is a customer refunded the wrong amount.

**My recommendation:** yes, but as its own piece of work with a rehearsal on a
copy of production — not folded into a fix pass.
**What I need:** permission to plan it, or "not now".

### Q2 — A-05 · The business day is hand-written as `'+8 hours'` in 25 places *(High)*  ·  **ANSWERED — done**

Every "today", every daily total, every report boundary is Guangzhou's midnight,
written as a literal into SQL. `lib/business-date.js` exists and reads the
location's timezone; the API does not use it.

**Why it matters:** a merchant in another timezone gets yesterday's takings
called today's. **Changing it changes reported numbers** — for Roots the values
are identical (they are at +8), but any report cached, printed or reconciled
against the old boundary will move for anyone else.

**My recommendation:** convert all 25, since the values do not change for the
only live merchant.
**What I need:** confirmation that a number moving for a future merchant is
acceptable, or a note of which reports must be pinned.

### Q3 — D-02 · System alerts are read from one merchant's database, by file path *(Critical, latent)*  ·  **ANSWERED: (b) — done**

`lib/ops-alert.js` opens `data/roots.db` by path to find where to send an alert.
A second account's alerts have nowhere to go.

**Why this is a question and not a fix:** the code change is small; the product
decision is not. Where should a second merchant's operational alerts go?

**Options:** (a) the merchant's own staff-chat app when they have configured
one, silently dropped when they have not; (b) the merchant's, falling back to
the platform's; (c) always both.

**My recommendation:** (b) — a merchant who has not set up a chat app should
still not have their storefront outage go unnoticed.
**What I need:** a, b or c. This also unblocks Q4.

**Your answer: (b).** Built. `sendTenantAlert(tenantId, text)` sends to the
account's own webhook and falls back to the platform's when that account has
none or the read fails. Q4 — which of the ~65 alert sites are the merchant's
problem and which are the platform's — is still open, and is now the only thing
between this and the whole alert path being right.

### Q4 — P-01 · The merchant's operational alerts go to the platform's chat *(High)*  ·  **ANSWERED — done**

Roughly forty alert call sites send everything the system notices about a
merchant's day to one operations group. The merchant's own channel exists and
fires for two events.

**Why it matters:** for Roots the two groups may be the same people, which is
why nobody has felt it. For anyone else, the merchant is not told their own
storefront is down.

**What I need:** each alert has to be classified as *the platform's problem* or
*this merchant's problem*. I can propose a split of the forty for you to approve
in one pass — say the word and I will draft it.

### Q5 — P-02 · Failures that reach nobody *(High)*  ·  **ANSWERED: do it — done**

Ten failure paths end in silence: a failed email, a failed text, a pruned push
subscription, 211 empty `catch` blocks. The pattern to copy already exists — a
failed printer job writes `print_status` onto the order and the drawer offers a
reprint.

**Half of this is now done and needs no further permission:** `notification_log`
records every send attempt on every channel, with its reason when it failed, and
Settings → What was sent reads it. The four silent exits from the operator push
— including "nobody on this account holds the capability", which is the D-06
shape — are rows saying so.

**What I still need:** permission for the other half — surfacing a failure ON
the thing it was about (a failed customer notification shown on that order, the
way a failed print already is) and doing something about the 211 empty `catch`
blocks. That is a week of work and touches the API everywhere.

**Your answer: do it.** Done — the order drawer, the sign-in code, and a gate
holding the empty-catch count where it is. Detail in §1 under "P-02, the second
half". One thing I did **not** decide for you, and it is worth a word: when the
only two-step channel an operator has is failing, they are now told so and stay
out. The alternative — signing them in on the password alone, the way the code
already does when no channel is *configured* — would make a provider outage into
a two-step bypass. If you would rather have that (a locked-out owner is also a
real cost), say so and it is a two-line change.

### Q6 — D-08 + H-01 + H-03 · What a new merchant is asked on day one *(High ×3)*  ·  **ANSWERED — done**

Sign-up asks for a shop name and an email. It does not ask for a country, a
currency, a timezone or a language, and then assumes all four. H-03 is the same
gap: a new shop may have no web address at all when `STOREFRONT_BASE_DOMAIN` is
unset.

**What I need — four answers:**
1. Which of country / currency / timezone / language should sign-up ask for?
   *(My recommendation: country, and derive the other three from it, with all
   four editable in Settings afterwards.)*
2. Should the default remain China / CNY / +8 / bilingual when nothing is asked?
3. When `STOREFRONT_BASE_DOMAIN` is unset, should a new shop get (a) no
   storefront and a clear message saying so, or (b) a path on the admin host?
4. Is the waiting-list door (H-02) deliberate, or should sign-up be open?

### Q7 — D-10 · Guangzhou's districts are written into delivery, orders and stock routing *(High)*  ·  **ANSWERED — done**

253 district-name occurrences across 30 files. Delivery zones, the dispatch
method choice, and stock routing are all expressed in named Guangzhou districts
and two named shops.

**What I need:** confirmation that delivery areas should become data the
merchant defines, with the current set imported as Roots' saved configuration.
It is a large change and I want it agreed before it starts, not discovered
half-done.

### Q8 — I-03 · There is no tax anywhere *(High, table-stakes)*  ·  **ANSWERED: build it — done**

No tax rate, no inclusive/exclusive setting, no tax line on an order, no tax on
a report. A merchant anywhere that charges sales tax or VAT cannot use this
product.

**You said build it and left me the details. What I chose, and why:**

*One rate per shop, not per product and not per destination.* Per-product is a
column on every product and a decision on every product page; per-destination
is a rate table that has to be kept current in every jurisdiction you sell
into, and getting it wrong is a legal problem rather than a bug. One rate is
what a single-country merchant needs and it is the only one of the three that
is finished when it ships. The other two are additive later: the order carries
the rate it was charged at, so a second source for that rate does not disturb
anything already stored.

*Both shapes — added at checkout, and already in the price.* Not a preference:
a US merchant must add at the till because the rate depends on where the buyer
is, and an EU or UK one must show a consumer price with the tax inside it.

*Off until a shop sets a rate, and the switch alone is not enough.* Nothing
moves for Roots. A rate of zero charges nothing rather than printing a
zero-rate line on every receipt.

*The order keeps a snapshot* — the money, the rate and the shape. A shop that
moves from 20% to 17.5% in April must not have March restate itself.

Where it shows: the customer's checkout and the quote behind it, the mini-app
order page, the web storefront, the counter till, the admin order drawer, the
phone admin, the thermal receipt, and the finance summary as tax collected net
of tax refunded. Settings sit beside Currency, with a preview of what a ¥100
order becomes.

**One thing I did not do, and would ask before doing:** tax on a REFUND is
computed proportionally at report time rather than stored on the refund. It is
right for every case I can see; it would be wrong if you ever refund a
different tax rate from the one you charged.

### Q9 — N-02 · A phone order cannot be taken on a phone *(High)*  ·  **ANSWERED: the cut-down one — done**

The phone admin can do most things; it cannot create an order. A shopkeeper
taking an order by telephone has to find a computer.

**Taken as recommended: the cut-down one.** Who, what, how, where it came from,
payment, notes — one scrolling screen, no wizard, and it posts to the same
`POST /api/retail-admin/orders` the desktop form and the counter till use, with
the same field names and the same refusals read back in the same sentences.

Three things it deliberately does not carry, each for a stated reason: **counter
sales** (the till is a purpose-built screen one row away in More, and a walk-in
has three extra server rules — a store, a named tender, a POS that is open),
**drafts** (what was typed stays in memory instead, so Back and a second phone
call do not lose it; nothing is written anywhere until Create), and **a
grand-total override or per-line prices** (desk work).

The fee quote is the same engine the customer checkout prices with, so the phone
cannot quote a different delivery charge for the same basket. The one rule the
form adds beyond the server's is a pickup at a multi-store shop having to name
the store: the server allows an order with no store — a phone order taken before
routing is decided legitimately has none — but a collection nobody can hand over
is worth asking about while the customer is still on the line.

### Q10 — M-01 / M-02 · Language is a browser setting, not a person's *(Medium ×2)*  ·  **ANSWERED: account — done**

The phone and the desktop remember different languages, in different keys, per
browser. Sign in on a new device and you are back to the default.

**What I need:** should language move onto the account (one setting, follows the
person everywhere), or stay per-device? *(My recommendation: onto the account,
with the device able to override for one session.)*

**Your answer: account.** Built, with the device override kept. `tenant_users`
gains a `language` column that is NULL until somebody chooses — so an existing
operator is not retro-assigned a language by whichever browser they last used.
The desktop console, the phone admin and the stockroom screen all read it at
sign-in and write it when the toggle is used.

### Q11 — D-05 · The sales channel list is fixed in the interface *(High)*

Left alone deliberately: your brief puts the sales-channel sync redesign out of
scope. Flagging it only so it is not assumed forgotten — the fix belongs with
that work.

---

## 3. What is still open

**Nothing on this list needs a decision except where it says so.** Everything
that could be done without one has been.

**Waiting on you, and only these:**
- **A-06 stage 2** — the storage migration itself. Rung 1 (add the integer
  column, backfill it, change nothing that reads) is written, along with the
  rehearsal that proves it against a copy of production. It needs one run on the
  server: `bash scripts/rehearse-money-migration.sh`, and the whole of its
  output back. Rungs 2 to 5 are written against what that run says.
- **D-05** — the sales channel list is fixed in the interface. Q11, and yours per
  the brief.

**Deliberately left, with the reason:**
- **C-02, the last part** — the phone admin still has its own date family. Its
  convention matches the shared formatter's, so converging changes nothing
  visible; it is tidiness on an untested surface, which is the worst ratio on
  this list.
- **I-04** — the platform's money is integer cents and the merchant's is a
  float. That IS A-06; it stops being true when stage 2 lands, and doing
  anything about it separately would be a second migration to undo.
- **J-03's second half** — loading a section's code on demand. The 27 parts
  share one global scope and call each other by name; there is no module
  boundary to load across, and half-doing it is a screen that opens on a
  ReferenceError. The wire cost is down 3× in the meantime.
- **Q-04** — Purchasing is a stack of screens with its own back button while
  every other section is a page with a drawer. Converging them is a redesign of
  a working screen, and the audit records it as an observation rather than a
  defect with a direction.
- **H-02** — the public door is a waiting list. The audit's own suggested
  direction is "none — this is a sequencing decision, not a defect".
- **Two capabilities the server does not enforce**, both found by K-01's work
  and both left alone because closing either changes what an account may DO,
  which is yours: a **full refund** travels through `PATCH /orders/:id/status`,
  which `requiredCapFor()` answers `orders:edit` for, so the server would accept
  one from a cashier today; and **`customers:adjust`** — a capability that
  exists, that the role editor offers, and that `lib/capabilities.js` marks as
  moving money — is not required by `/customers/:id/points-adjust` or
  `/wallet-adjust`, which map to `customers:edit`. Both are one line each in
  `lib/cap-routes.js`. Both are pinned by assertions, so the day either is
  closed the suite says so.
- Everything under **K** (RBAC enforcement and the ~50 unmapped routes) and the
  finance category data quality pass — both yours per the brief.

---

## 4. Two corrections to the audit

Both are in the audit document itself as visible notes, not quiet edits.

**J-02 said "one confirmed query-per-row loop" and listed the inventory grid as
clean.** That was half right. The grid batches its *shelf* rows — which is what I
checked — but the availability call under them ran once per product **per store**,
and issues three queries each. A 500-product catalogue across four shops was
6,000 queries to paint one screen. A batch twin, `inventory.getAvailableMap`,
already existed and was not being used. Both loops are now batched.

**Part 1 §7 over-counted unscoped statements at 204.** Corrected during the audit
itself to 121 statements in 3 files, 102 with no account filter, 36 writes. The
note is in the document.

---

## 5. How to check this

**The container this was built in can install dependencies after all.** The
earlier note here said it could not; that was wrong for two sessions, and it
mattered — half the suites and every eslint run were being skipped on an
assumption. With `npm ci` the whole thing runs locally.

**The fast shard: 141 suites, 0 failures, 0 quarantined.** The quarantine list
is empty — five of the six were fixed on `main` while this branch was in
flight, and the sixth (`test_mobile_purchasing.js`) left on the evidence
described below. `npx eslint` reports **0 errors** on every changed file, which
is what the deploy gate blocks on. The slow shard — the Chromium render passes,
including the 372-render sweep over every screen of the phone admin in English,
Chinese and both themes — runs in CI and locally.

**CI caught five failures on the first real run, none of them a product
defect**: two source-greps naming a database handle D-01 correctly changed, two
VM sandboxes missing the currency helpers D-03 introduced, and a stale
role-count assertion for the bookkeeper E-11 added. All fixed.

**One suite left quarantine.** `test_mobile_purchasing.js` is green in two
independent environments AND the cause its entry named is gone from the file
(commit 558eed3 anchored the fixture to today, which is exactly what the entry
said the fix had to be). Both halves were required: the entry warned against
acting on one green run, because it had been green on CI and red locally on the
same day with no explanation. Five remain quarantined, unchanged.

Suites added by this pass, each named for the finding it holds down:
`test_money.js`, `test_money_boundaries.js`, `test_business_day.js`,
`test_csv_import.js`, `test_delivery_districts.js`, `test_alert_audience.js`,
`test_new_merchant_locale.js`, `test_signin_code_delivery.js`,
`test_open_close_panel.js`, `test_notification_choices.js`,
`test_saved_views.js`, `test_keyboard_reach.js`, `test_wizard_first_question.js`,
`test_print_documents.js`, `test_settings_findable.js`, `test_recycle.js`,
`test_asset_delivery.js`, `test_clear_filters.js`, `test_money_invariants.js`,
`test_money_migration.js`, `test_phone_order.js`, `test_tax.js`,
`test_role_tagged_controls.js`.

Also run, on every commit:

- `node --check` on every changed JavaScript file
- `scripts/check-html-js.js` on every changed HTML file
- `scripts/check-tenant-als.js` — **passes**, all 24 call sites enter the tenant
  scope with a raw handle, which is the check that matters most for D-01
- `scripts/check-swallowed-errors.js` — **passes** at 457, the ceiling it set on
  the day it was written. Both new scripts were confirmed to FAIL against the
  pre-fix tree, which is the only evidence that a gate is a gate
- `scripts/test_signin_code_delivery.js` — **25 pass, 0 fail**
- `scripts/check-i18n-banners.js` — **passes**, 27 files
- scripted verification per change — every SQL column resolved against its
  table, the low-stock predicate diffed against the dashboard's, the column
  percentages re-summed, the accessible-name coverage re-counted, the new role
  preset resolved through `lib/capabilities`

Both shards run in CI on every push to this branch, and green there is what
gates the merge. The changes with real behaviour risk, in order:

1. **J-01's ceilings** — six list endpoints changed shape. The ceilings are far
   above any real list, so the risk is a client reading `data` from a response
   that now also carries `total`. All known callers were updated.
2. **D-01's handle rewrite** — three route files moved onto the account handle.
   `getTenantDb(1) === mainDb`, so for Roots this is a passthrough and behaviour
   should be identical.
3. **The schema additions** — three columns (E-01, E-02) added with the file's
   own idempotent `addColumn` idiom, all nullable, and one new table
   (`notification_log`, P-03) which nothing reads except its own screen.
4. **The sign-in code path** — the response shape of `/api/backend/login` and
   `/api/backend/login/2fa/channel` changed on the failure branch only: a
   successful send answers exactly as it did before. The one behaviour change a
   person can see is that a failed send now says so instead of showing the code
   screen in silence.
5. **The currency pass** — 188 render sites. Output is identical on CNY except
   that thousands are now grouped.
6. **Tax (part three)** — it touches the customer checkout, its quote, the till
   and the manual-order route, which is the money path. Every one of those is
   a no-op while `tax.enabled` is false, which it is for every shop until one
   sets a rate; `scripts/test_tax.js` asserts that a shop with no rate stores
   three NULLs and is charged exactly what it was charged before. The one place
   the arithmetic is duplicated rather than read is the mini-app checkout, and
   the reason is written at the function: that page recomputes its own total
   between quotes, and the server refuses an order whose declared total
   disagrees with its own — so a figure frozen at the last quote would not be a
   cosmetic problem, it would be a checkout that stops working.
