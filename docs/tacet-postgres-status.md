# The Postgres migration — status, v2.0

**2026-08-10 · A LIVING DOCUMENT. Both halves, in one place: what is built, and what is left.**
Covers 2026-08-03 onwards. Read-only in itself — no code change ever accompanies it.

**LAST UPDATED: 2026-08-10, against `main` at `674efa56`, decisions record v4.23, AST authority reporting 103 runtime transaction blocks / 30 in `routes/retail.js`.**
Those four values are the head this file is true at. **If any of them has moved, this file is stale until someone re-runs PART 4.**

---

## THE RULE THAT KEEPS THIS FILE HONEST — READ BEFORE EDITING IT

**This file carries STATUS and POINTERS. It never carries the reasoning.** Every "why" lives in `docs/tacet-consolidation-decisions.md` §24 or in the design documents, and every remaining item below cites the entry that owns it.

**That is not a stylistic preference. It is the only thing that stops this file from becoming a second decision record that disagrees with the first**, which is the failure this section has already recorded three separate times — a commit message that claimed step 2 was done when it was not, a comment that answered for the code, and a batch report whose count disagreed with the record. **Two documents that both explain the same decision will drift, and the reader will not know which lied.** One explains, one indexes.

**§24 WINS ON ANY DISAGREEMENT WITH THIS FILE, ALWAYS, WITHOUT ARGUMENT.** If a line here contradicts it, this file is the wrong one and should be corrected here rather than debated there.

**WHY BOTH HALVES ARE IN ONE FILE.** Every record of this work used to be written from the deficit side — §24 grows by findings and open items, the cutover checklist lists things not done, the batches report a count falling towards zero. Each is correct and the sum is misleading: a status question answered against them alone returns "26 of 56 transactions converted", which is true of one step of one path inside one phase and false about eight days of work. Splitting built and owed into two files just moved the distortion. **They are one question and they belong on one page.**

---

## PART 1 — THE MEASURE

From `17cf8228` (2026-08-03, "The database decision is written down") to `674efa56` (2026-08-10), on `main`:

| | |
|---|---|
| commits | **258** (217 excluding merges) |
| files changed | **266** |
| lines | **+95,106 / −7,531** |
| new scripts | **115**, of which **17** are test suites |
| new documents | **16** |

By day: 18 · 51 · 32 · 33 · 18 · 47 · 59 · 8.

**Roughly two fifths of it is the database.** Of the 217 non-merge commits, **87** are Postgres, seam, money-model, transaction, handle-threading or deploy-pipeline work. The other **130** are unrelated work that shipped in the same window — the qingyun delivery-point stages, the pickup-window and reschedule clock defects, the receipt and slip corrections, the per-viewer language decision, the POS and restock shell removals, the international-phone defect, the welcome-coupon grant leak, the mini-app publish rule. **The migration did not have the week to itself, and any reading of the pace has to account for that.**

---

## PART 2 — BUILT

### Phase 1 — done, and verified to the cell

- **PostgreSQL 16.14 installed alongside the running application**, 2026-08-03. The live app never stopped serving from SQLite.
- **The `tacet` database built** — 162 tables, 230 indexes, 144 foreign keys.
- **A five-table rehearsal copy**, 5,877 cells compared, **zero differences** (`102f3f56`).
- **THE FULL DATA COPY** — **129 non-empty tables, 353,220 rows, in 86 seconds.** SQLite was opened read-only and *proven* so on every connection by a rejected write.
- **The verification is the part worth reading twice.** **3,244,556 cells round-trip compared**, 43 differences, every one traced to live trading during the run rather than to the copy. 144 foreign keys validated by Postgres itself. Chinese character counts exact. 2,112 base64 values byte-identical by SHA-256. 139 sequences set, **117 from AUTOINCREMENT high-water rather than `max(id)`**, which matters on the 20 tables where ids are burned.
- **Four schema records committed**, 27,646 lines. **The Postgres driver installed and wired to nothing** (`867fa923`). **`tacet_app`** exists on the cluster.

**Two qualifications.** The copy is a **rehearsal**, and it drifts from the moment it is taken. `tacet-postgres-schema-phase1.sql` is **stale on eleven columns** and is history only.

### The database seam — 75.28%

- **Built and proven before anything depended on it** (`e450f059`, `d7196a91`); the mechanism proven exhaustively across the whole better-sqlite3 surface, **2,781 assertions**, before any batch moved.
- **Step A** — raw accessors, an AsyncLocalStorage guard, `currentTenantId()` stopped guessing. **Step B, the flip** (`6959d5c3`): **two lines, and coverage went 0.64% → 48.27%.** Everything that made those two lines safe was built in Step A.
- **Five DIRECT batches**: 48.27 → 50.52 → 55.34 → 60.49 → 64.63 → 69.77%, ending at **75.28%**. **Daemons 154 of 177 sites, 87.01%**, every one of their 150 statements executed raw against wrapped before shipping.
- **The coverage checker was found measuring less than it claimed, and corrected.** A proposal to shrink the denominator was **withdrawn** when 211 of the 226 proved DML and four touched money. **Coverage stays 75.28% and is honest.**

### The money model

- **`docs/tacet-money-model-survey.md`, 989 lines.** **101 REAL columns converted to integer cents**, percentages and the polymorphic `retail_vouchers.value` deliberately left.
- **THEN THE CENTS RULE WAS REVERSED WHERE MEASUREMENT SHOWED IT WRONG** — **twelve unit costs would have rounded to zero and 188 values were off by more than 10 percent**, so nine cost columns became `numeric(14,6)`. Weight became text, because `'500ml'`, `'1L'`, `'120g (4 bars)'` and one `'5--g'` have no correct numeric form.
- **The read-side converter built** — one global pg type parser on OID 1700, dispatching on type because the type *is* the money list, 101 both ways.

### What the migration found in the rest of the system

- **A FAILED DEPLOY HAD BEEN SILENTLY SKIPPING ITS CHANGES, 197 TIMES.** Replaying 904 runs found **939 moments where a run reported SUCCESS while production did not match the repository**, grouping into **197 stranding episodes across 141 files**. 71 ran over a week, the longest 43 days, **79 were never healed by any later commit**, 22 were runtime code. Found because the Step B flip did not reach the box. Fixed (`2e24221b`, `ad945129`).
- **THE STATEMENT SWEEP** — 2,524 statements across 109 files. Found **six failing in production today** (including the operator's order search and a customer's order history, both broken behind a catch) and **96 that will not run on Postgres**, dialect work that "was not previously on the cutover checklist in any form."
- **The AST count authority** (`93e17403`), after six §24 figures taken from grep proved wrong. **`TENANT_DATA_ISOLATION` is ON in production**, against a record that said otherwise, because the flag lives in a gitignored `.env`.
- **pgroll decided** after a six-option survey. **Test accounts cleared** from live data, `foreign_key_check` clean.

### Phase 2 — the conversion so far

- **STEP ZERO — the async rejection guard** (`ba367914`), adopted globally while every handler was still synchronous.
- **The transaction helper built, proven and shipped UNUSED** (`d7515a36`) — 28 assertions, green and red-proven on both drivers, so a flaw could not reach every call site at once.
- **Four conversion batches, 26 transactions.** `routes/retail.js` 56 → 30, runtime-wide 129 → 103, reconciling exactly. Red-proven per conversion from batch 4.
- **The helper's concurrency defect found and repaired** (`e9b6da1d`) — nesting moved into the async context, written red first at 4 passed / 10 failed. **Found before the checkout was converted, which is the difference between a test failure and an oversell on live money.**
- **`PUT /integrations` made atomic** (`e46e61ce`). **The shadowed split route fixed** (`5a75ad64`), with a tripwire against the next duplicate registration.
- **PATH A STEP 2 — four helpers threaded** (`3d9091dc`): `generateRetailSku`, `writeLayout`, `ensureShipments`, `reserveForOrder`, each on an optional trailing handle evaluated per call, **no call site edited**. Mutation red-proof, real functions under test, and the handle pointed at a different database than `tdb()` so an ignored parameter cannot pass.
- **Postgres backed up** (`7b3ce893`) — `pg_dump -Fc` plus `roles.sql`, which is load-bearing because roles are cluster-level and the archive holds 927 grants naming `tacet_app`.
- **The phase numbers defined** (`ec537133`), with backups, rollback and the runbook placed inside Phase 2 rather than Phase 3. **SETTLED 2026-08-10: there are THREE phases and the five-phase reading is retired** — under it the switch is 4 and backups are 5, which puts the safety net after the flip and inverts the one sequencing decision the phases exist to protect. No longer an open question; §24 THREE PHASES, AND WHY THE FIVE-PHASE READING IS WRONG owns the reasoning.
- **Three harness defects fixed** across three consecutive batches, each of which would have made a suite green and wrong, and the written-column assertion made non-optional.

---

## PART 3 — REMAINING

**Status only. The entry named in the last column owns the reasoning and wins on any disagreement.**
Type: **C** conversion · **F** fix · **D** design question · **O** operational.

### Phase 2 — the code half

| # | Item | T | Blocks | Owned by |
|---|---|---|---|---|
| 1 | **Step 2's last three helpers** — `reconcileTier`, `createOrReuseManualCustomer`, `mergeAddonItemsIntoShipments` still take no handle | C | the loyalty cluster, `POST /api/retail-admin/orders`, `finalizeOrderAddon` | §24 PATH A STEP 2 — FOUR HELPERS THREADED |
| 2 | **`ensureShipments` and `reserveForOrder` keep `h.transaction()`** — SQLite maps it to a SAVEPOINT free, pg has no equivalent. Threaded but **not portable** | D | the checkout, and every unconverted `.transaction()` reachable from a converted async caller | §24 same entry, OPEN item 1 |
| 3 | **`getAvailable` and `ttlMinutes` still on `tdb()` inside `reserveForOrder`** — safe today on conditions, not properties | F | correctness of the stock gate after the flip | §24 same entry, OPEN item 3 |
| 4 | **`BEGIN IMMEDIATE` unimplemented in `withTransaction`** | D | **the checkout** | `lib/db-transaction.js` header; design doc §What replaces `.immediate()` |
| 5 | **`withTransaction` cannot nest inside a `tdb().transaction()` body** — measured, two independent reasons | D | any incremental route into the checkout | §24 same entry, OPEN item 2 |
| 6 | **The checkout** — 209 lines, 9 ordered writes, 6 typed errors, a 7th idempotency exit | C | `ensureShipments`, the split's undo-combine branch, retiring `.immediate()` | `tacet-checkout-transaction-design.md` v2.0 |
| 7 | **The money cluster** — 13 named helpers + 5 money routes. No design doc exists for this group | C | Phase 2 completion | §24 batch entries |
| 8 | **73 transactions outside `routes/retail.js`**, incl. `commitOrderReservations` and `reverseCommittedOrder` | C | Phase 2 completion | §24 PHASE 2 OWED WORK, item 1 |
| 9 | **`POST /api/retail-admin/orders` unclassified** — mints an order number, in neither pool | D | its own conversion | §24 PHASE 2 OWED WORK, item 2 |
| 10 | **`POST /polls/:id/vote` misclassified** — "safe inline" while writing `points_balance` and the points ledger | D | its own conversion | §24 PHASE 2 OWED WORK, item 3 |
| 11 | **`FOR UPDATE` sufficiency on the stock row** — the invariant holds by convention, not construction | D | the checkout on pg | design doc, uncertainty 1 |
| 12 | **`nextOrderNo` on Postgres** — wants a sequence; `order_no` is `TEXT UNIQUE` `TC%06d` with live values. **Not costed** | D | the checkout on pg | design doc, uncertainty 2 |
| 13 | **Checkout contention unmeasured** — cheapest of the three uncertainties, still unsettled | D | nothing; sizes the work | design doc, uncertainty 3 |
| 14 | **`PUT /cms/onboarding-settings`** unwrapped multi-write · **`reconcileTier`** swallows its errors · **`categories` `UNIQUE(kind,name)`** has no `COLLATE NOCASE` | F | nothing today | §24 DUAL-CONTEXT HELPERS; TWO CATEGORY SYSTEMS |
| 15 | **Six statements failing in production today** — and per §24 these are **not typo fixes**: each path has never executed, so fixing one surfaces behaviour nobody has seen | F | 162 seam sites waiting on decisions | §24 Six statements are failing |

### Phase 2 — the operational half

| # | Item | T | Owned by |
|---|---|---|---|
| 16 | 🔴 **Fresh-cluster restore is UNPROVEN** — the rehearsal ran in a cluster where `tacet_app` already existed, so `CREATE ROLE` never executed. The new-box case is the disaster case | O | §24 v4.17 backup entry |
| 17 | 🔴 **No rollback plan.** "A setting plus a restart" is true of the code path and false of the data | O | nothing written |
| 18 | 🔴 **No cutover runbook.** `GO-LIVE-CUTOVER.md` is the mini-app one; the Postgres list is three checkboxes | O | nothing written |
| 19 | **96 dialect statements**, and **371 dynamic statements** that static preparation cannot reach — "a floor, not a total" | F | §24 96 statements will not run |
| 20 | **The idempotency regex** — `routes/retail.js`, matches better-sqlite3's message text. **Failure mode is a customer charged twice, and nothing fails until money moves** | F | design doc, REQUIRED PRE-CUTOVER |
| 21 | **Audit every `scripts/` file assuming a SQLite path** — `reset_test_orders.js`'s backup would silently back up nothing | O | §24 DESTRUCTIVE SCRIPTS |
| 22 | **`reset_test_orders.js` guards 2 and 3 never executed** — must run on the box against a **fixture**, never live | O | §24 batch 3 entry |
| 23 | **`sqlite_sequence` resets → `setval`** — both inside silent `try{}catch{}` | F | §24 cutover checklist |
| 24 | **Retired files deleted by hand** — the deploy never removes anything, proven live at 54 days | O | §24 cutover checklist |
| 25 | **`data/roots.db` removed or renamed** — ~80 scripts open it by path and would read a stale database with nothing warning. **Rename, don't delete**: it keeps the rollback path and fails loudly | O | §24 cutover checklist |
| 26 | **Disk headroom** — 40 GB at 78%, 8.3 GB free, unaccounted for in any cutover plan | O | §24 line 489 |

### Phase 3 — the switch

| # | Item | T | Owned by |
|---|---|---|---|
| 27 | **`TACET_DB`** — appears nowhere in the repository. Form and location specified, nothing built | C | §24 CUTOVER SEQUENCING |
| 28 | **Wire `lib/pg.js` in** — nothing requires it today | C | `lib/pg.js` header |
| 29 | **The pg backend of `withTransaction`** — pool checkout making `tx` a distinct client, not written, not tested | C | `lib/db-transaction.js` header |
| 30 | **Queue scoped to the checked-out client, not the pool** — measured: three transactions on a shared handle ran strictly sequentially. Plus nested reuse of the outer client, and release on every exit path | C | design doc Part 2 |
| 31 | **A fresh data copy + delta pass.** Drift measured 2026-08-09: checkout_quotes +23,829, guanyi_sync_log +4,788, customers +222, orders +87 | O | §24 Full data copy, findings |
| 32 | **The directory rename**, bundled here deliberately — standalone it breaks the SQLite path, pm2, Actions, `deploy-apply.sh` and probably nginx at once | O | §24 line 537 |
| 33 | **The gzgrocery table rename** | O | §24 gzgrocery rename |

### After the flip — explicitly not preconditions

§24 is clear that the switchover **precedes** the isolation work; building the wall on SQLite first means building it twice.

| # | Item | Owned by |
|---|---|---|
| 34 | The `account` column, staged module by module | §24 The account column is added staged |
| 35 | Row-level security policies — **0 tables carry `relrowsecurity` today** | §24 Isolation is enforced by the database |
| 36 | No account special-cased, including Roots — grep `ROOTS_TENANT_ID` as the mechanical check | §24 NO ACCOUNT IS SPECIAL-CASED |
| 37 | Delete `lib/tenant-db.js`; remove the 5 orphaned `data/tenants/*.db`, still listed in `db-backup.sh` | §24 RETIRED; line 490 |
| 38 | Install pgroll — **not** a migration blocker; ⚠️ apt triggers `needrestart`, which can bounce pm2 | §24 Schema changes are managed with pgroll |
| 39 | Track migrations per engine — one `_migrations` name-set cannot express two engines at once | `tacet-schema-change-survey.md` |

### The three with silent, money-costing failure modes

Called out because they sit in the least-documented stages and none of them fails loudly: **#20 the idempotency regex**, **#12 `nextOrderNo` on Postgres**, **#30 the queue keyed on the pool**. And the one that is not a code problem at all: **#16, the unproven restore.**

---

## PART 4 — HOW TO KEEP THIS FILE CURRENT

**WHEN.** After anything that changes a status in PART 3 — a conversion batch, a helper threaded, a fix merged, a design question settled, an operational item done. **Not on a schedule**, because a date-driven refresh of an unchanged file just moves the header and teaches the reader the header means nothing.

**WHAT TO RE-RUN, in this order.** All read-only.

```bash
git fetch origin && git log --oneline 17cf8228..origin/main | wc -l
git diff --shortstat 17cf8228..origin/main
node scripts/diagnose_async_conversion_scope.js | grep -E "runtime total: 1|blocks"
git show origin/main:docs/tacet-consolidation-decisions.md | head -1
```

Then update, in this order: **the LAST UPDATED line first** — head sha, decisions-record version, and both AST counts — then PART 1's table, then only the PART 3 rows whose status actually moved.

**THE RULES.**

1. **Never restate reasoning that lives in §24.** Add the row, cite the entry, stop. A row that grows a paragraph is the beginning of the second decision record this file exists not to be.
2. **Never take a count from grep.** `scripts/diagnose_async_conversion_scope.js` is the authority, per §24 after six grep-derived errors.
3. **Never take a status from a commit message.** `d7515a36` claimed step 2 was on main for two days while it was not. **The code is the authority** — check the signature, the statement, the flag on the box.
4. **Move a row, do not delete it.** A finished item moves to PART 2 with its SHA. PART 3 shrinking is the only progress signal this file has, and a deleted row makes it lie.
5. **Correct it in the open.** v1.0 of this file said step 2 was unbuilt; it landed mid-write and the correction is recorded rather than tidied away. **A delivery record goes stale exactly the way a deficit record does.**
6. **If you cannot verify a row, say so in it.** A row marked unverified is honest; a row that quietly assumes is the liability, and this section has already paid for that three times.

---

## METHOD

Commit, file and line counts are from `git log` and `git diff --shortstat` against `17cf8228..674efa56` on `main`, and are regenerable by the block above. **The Postgres-versus-other split is a keyword classification of commit subjects and is approximate by nature** — offered as a proportion, and the only inexact number in this file.

Every other figure is quoted from §24, from a design document, or from the AST authority. **No figure here is grep-derived.**

---

## RELATED

- `docs/tacet-consolidation-decisions.md` §24 — the decisions record. **Owns every "why" in PART 3 and wins on any disagreement with this file**
- `docs/tacet-checkout-transaction-design.md` — the checkout conversion design, v2.0
- `docs/tacet-money-model-survey.md` — the money-unit gap behind the boundary-layer decision
- `docs/tacet-schema-change-survey.md` — the six options behind the pgroll decision
- `scripts/diagnose_async_conversion_scope.js` — the AST authority for conversion counts
- `scripts/postgres-full-copy/`, `scripts/postgres-migration/` — the copy and rehearsal, preserved
