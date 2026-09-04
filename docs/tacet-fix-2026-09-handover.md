# Tacet — fix pass, September 2026

Companion to `docs/tacet-audit-2026-09.md`. That document says what is wrong.
This one says what has been changed, what has deliberately **not** been changed,
and the eleven questions that need your answer before the rest can move.

Branch: `claude/tacet-audit-2026-09-tpkn60`. Nothing here is on `main`, so
nothing here has deployed. Every commit carries `[skip deploy]` as well.

---

## 1. What is fixed

Seventeen commits, worked strictly down by severity. Both Critical findings that
could be fixed without a decision, every High that could, and eleven Mediums and
Lows that were cheap and clearly right.

| Finding | Severity | What changed |
|---|---|---|
| **D-01** | Critical (latent) | Purchasing, Recipes and Materials wrote to the first merchant's database through a module-level handle. Every statement in the three files now goes through the signed-in account's connection. One exception is named and commented: the `activity_log` read, because that table is control-plane. |
| **A-01** | High | The product list stopped at 500 and the counter reported that as the whole catalogue. It now returns the real total and says "first N of M — search or filter to reach the rest". |
| **A-02 / A-07** | High / Medium | A mistyped shelf count wrote zero, and a negative count was accepted. Both refused, with a sentence saying what to type. |
| **A-04** | High | Every timestamp rendered on Guangzhou's clock for everyone. `/config` now returns the account's own timezone and the shared formatter uses it. |
| **A-08 / I-01** | Medium / High | Nine ways to write an amount. Now two, both from the merchant's currency: `acMoney` (exact, thousands grouped) and `acMoneyCompact` (whole units, KPI tiles and axes only). |
| **A-09** | Medium | *Partial.* The error paths touched by other fixes now carry a plain sentence. The remaining ~180 raw error codes are listed in §3. |
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
| **G-01** | Medium | *Partial.* "Quotas", the AppID error, and the JD credential block. |
| **G-02 / R-02** | Medium | 280 form fields with no accessible name → zero. 158 labels associated, 58 written by hand, the rest named at runtime by the i18n walker so dynamically-built forms are covered too. |
| **J-01** | High | Six lists that grew without bound now carry a ceiling, report the real total, and say so on screen when they are cut. |
| **J-02** | Medium | Two query-per-row loops batched. **The audit was wrong about one of them** and is corrected in the same commit — see §4. |
| **N-01 / R-01** | Medium | Pinch-zoom was switched off on the phone admin. |
| **R-03** | Medium | Dark-theme muted text at 3.61:1, used 192 times. Now clears 4.5 on every dark surface. |
| **R-04** | Low | The product inspector's buttons were 26px against a 44px guideline. |
| **R-05** | Medium | *Partial.* A skip link past the rail. The focus trap and the 385 non-button click handlers are listed in §3. |

---

## 2. The eleven questions

Each is a decision I should not take for you. Every one is blocking a specific,
already-scoped change; several are a single word.

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

### Q3 — D-02 · System alerts are read from one merchant's database, by file path *(Critical, latent)*

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

### Q5 — P-02 · Failures that reach nobody *(High)*

Ten failure paths end in silence: a failed email, a failed text, a pruned push
subscription, 211 empty `catch` blocks. The pattern to copy already exists — a
failed printer job writes `print_status` onto the order and the drawer offers a
reprint.

**What I need:** permission to add a `delivery_attempts`-style record and
surface it on the thing it was about. This is a week of work, not an afternoon,
and it touches the send helpers everywhere. Worth confirming you want it before
I start.

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

### Q10 — M-01 / M-02 · Language is a browser setting, not a person's *(Medium ×2)*

The phone and the desktop remember different languages, in different keys, per
browser. Sign in on a new device and you are back to the default.

**What I need:** should language move onto the account (one setting, follows the
person everywhere), or stay per-device? *(My recommendation: onto the account,
with the device able to override for one session.)*

### Q11 — D-05 · The sales channel list is fixed in the interface *(High)*

Left alone deliberately: your brief puts the sales-channel sync redesign out of
scope. Flagging it only so it is not assumed forgotten — the fix belongs with
that work.

---

## 3. What is still open and needs no decision

I can do all of these on a word from you. They are listed with what each costs.

**Larger, worth their own pass:**
- **P-03** — no history of what was sent. One log table, written by the send helpers. *(Pairs naturally with Q5.)*
- **E-05** — only suppliers can be imported. Products, customers and opening stock are the largest cost of switching to Tacet.
- **E-07** — no undo except on products.
- **G-03** — Settings is nine dropdowns deep with no explanation.
- **J-03** — 970 KB of JavaScript before anything is fetched.
- **I-02** — money arithmetic inside string-built SQL; the rounding is the database's, not the product's.

**Medium, an afternoon each:**
- **A-09** — ~180 error toasts still show a raw code. Mechanical but needs a written sentence per case, which is the slow part.
- **E-08** — filters cannot be saved.
- **E-10** — notifications cannot be tuned (the low-stock digest is now the only one that can).
- **B-03** — four endpoints for opening and closing the shop, and no screen.
- **R-05** — the two remaining parts: a focus trap in dialogs, and 385 `onclick` handlers on elements that are not buttons.
- **C-02** — the phone admin still has its own date family. Its convention matches the shared formatter's, so converging is safe and fixes nothing visible; it is tidiness, and it is an untested surface.

**Small:**
- **B-04** — a whole brand-design screen deployed with no way in.
- **C-03** — the products empty state now has two states (B-01) but still lacks the Suppliers screen's buttons.
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

No test suite was run: this container has no `node_modules` and no registry
access, so `npm install` and `npx eslint` both fail. What was run, on every
commit:

- `node --check` on every changed JavaScript file
- `scripts/check-html-js.js` on `public/retail-admin.html`
- scripted verification per change — every SQL column resolved against its
  table, the low-stock predicate diffed against the dashboard's, the column
  percentages re-summed, the accessible-name coverage re-counted, the new role
  preset resolved through `lib/capabilities`

Before any of this reaches `main` it needs the suite run somewhere that can
install. The changes with real behaviour risk, in order:

1. **J-01's ceilings** — six list endpoints changed shape. The ceilings are far
   above any real list, so the risk is a client reading `data` from a response
   that now also carries `total`. All known callers were updated.
2. **D-01's handle rewrite** — three route files moved onto the account handle.
   `getTenantDb(1) === mainDb`, so for Roots this is a passthrough and behaviour
   should be identical.
3. **E-01 and E-02's schema additions** — three columns, added with the file's
   own idempotent `addColumn` idiom, all nullable.
4. **The currency pass** — 188 render sites. Output is identical on CNY except
   that thousands are now grouped.
