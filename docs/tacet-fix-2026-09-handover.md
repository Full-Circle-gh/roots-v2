# Tacet — fix pass, September 2026

Companion to `docs/tacet-audit-2026-09.md`. That document says what is wrong.
This one says what has been changed, what has deliberately **not** been changed,
and the eleven questions that need your answer before the rest can move. Three
of the eleven are answered and built; eight are still waiting.

Branch: `claude/tacet-audit-2026-09-tpkn60`. Nothing here is on `main`, so
nothing here has deployed. Every commit carries `[skip deploy]` as well.

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

## 2. The eleven questions — three answered

Each is a decision I should not take for you. Every one is blocking a specific,
already-scoped change; several are a single word.

**Q3, Q5 and Q10 are answered and built** — they are kept below with the answer
marked, so the reasoning stays readable next to what was decided. The eight that
remain are Q1, Q2, Q4, Q6, Q7, Q8, Q9 and Q11.

### Q1 — A-06 · Money is stored as floating point *(High)*

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

### Q2 — A-05 · The business day is hand-written as `'+8 hours'` in 25 places *(High)*

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

### Q4 — P-01 · The merchant's operational alerts go to the platform's chat *(High)*

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

### Q6 — D-08 + H-01 + H-03 · What a new merchant is asked on day one *(High ×3)*

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

### Q7 — D-10 · Guangzhou's districts are written into delivery, orders and stock routing *(High)*

253 district-name occurrences across 30 files. Delivery zones, the dispatch
method choice, and stock routing are all expressed in named Guangzhou districts
and two named shops.

**What I need:** confirmation that delivery areas should become data the
merchant defines, with the current set imported as Roots' saved configuration.
It is a large change and I want it agreed before it starts, not discovered
half-done.

### Q8 — I-03 · There is no tax anywhere *(High, table-stakes)*

No tax rate, no inclusive/exclusive setting, no tax line on an order, no tax on
a report. A merchant anywhere that charges sales tax or VAT cannot use this
product.

**What I need:** is this in scope for the platform, and if so, which model —
single rate per shop, rate per product, or rate per shipping destination? They
are three different products.

### Q9 — N-02 · A phone order cannot be taken on a phone *(High)*

The phone admin can do most things; it cannot create an order. A shopkeeper
taking an order by telephone has to find a computer.

**What I need:** should the phone get the full New-order flow, or a cut-down
"name, phone, items, done" version? *(My recommendation: the cut-down one — the
desktop wizard has six steps and none of them fit a phone.)*

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

## 3. What is still open and needs no decision

I can do all of these on a word from you. They are listed with what each costs.

**Larger, worth their own pass:**
- **E-05** — only suppliers can be imported. Products, customers and opening stock are the largest cost of switching to Tacet.
- **E-07** — no undo except on products.
- **G-03** — Settings is nine dropdowns deep with no explanation.
- **J-03** — 970 KB of JavaScript before anything is fetched.
- **I-02** — money arithmetic inside string-built SQL; the rounding is the database's, not the product's.

**Medium, an afternoon each:**
- **E-08** — filters cannot be saved.
- **E-10** — notifications cannot be tuned (the low-stock digest is now the only one that can).
- **B-03** — four endpoints for opening and closing the shop, and no screen.
- **R-05** — one part remains: 385 `onclick` handlers on elements that are not buttons and so are not reachable by keyboard.
- **C-02** — the phone admin still has its own date family. Its convention matches the shared formatter's, so converging is safe and fixes nothing visible; it is tidiness, and it is an untested surface.

**Small:**
- **C-05** — one confirmation gap out of 32.
- **E-09**, **E-12**, **F-02**, **I-04**, **O-02** — as recorded in the audit.

**Deliberately not touched:** everything under **K** (RBAC enforcement and the
unmapped routes), the sales channel redesign, and the finance category data
quality pass — all three are yours per the brief.

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

**`main` gained a CI test runner (#272) while this branch was in flight.** It is
merged in, and it has been run.

**62 of the 117 fast suites pass** (60 of 115 before the two new gates below).
The other 49 cannot run in this container —
they need `better-sqlite3` or `express`, and there is no registry access to
install them. Six more were already quarantined as red on `main` before this
branch existed, and are unchanged by it. The slow shard needs Chromium and was
not attempted.

**The runner caught four failures, all of them mine, none a product defect** —
and one of the four was a real bug. See the last commit for the detail; in
short: two source-greps named a database handle that D-01 correctly changed, a
VM sandbox was missing the currency helpers D-03 introduced, and the broadcast
composer was echoing a typed time back shifted by the store's offset. That last
one only shows up on a host that is not at UTC+8, which is why only a test could
find it. It is fixed, with a zone-inversion helper that round-trips exactly at
Asia/Shanghai, America/New_York and Europe/London.

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

`npx eslint` still cannot run here (no `node_modules`), so before this reaches
`main` it needs a full run somewhere that can install — the CI workflow on a PR
will do exactly that. The changes with real behaviour risk, in order:

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
