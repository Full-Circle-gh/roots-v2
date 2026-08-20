# The Postgres migration — status, v2.1

**2026-08-10 · A LIVING DOCUMENT. Both halves, in one place: what is built, and what is left.**
Covers 2026-08-03 onwards. Read-only in itself — no code change ever accompanies it.

**LAST UPDATED: 2026-08-20, against `main` at `3c4fc20a`, decisions record v4.46, AST authority reporting 92 UNCONVERTED runtime transaction blocks / 29 UNCONVERTED in `routes/retail.js` — and 27 CONVERTED, all in `routes/retail.js`.**
**READ 92 WITH ITS CAVEAT, PER RULE 6 — THE TRUE FIGURE IS STILL 102 AND NOTHING WAS CONVERTED.** The authority now reports `PARSE FAILURES: 1` and names `database.js`: G2's top-level `return` is `'return' outside of function` to `espree` under the options that script uses, so the file is dropped and its own **10** blocks fall out of the total. 102 → 92 is a parse failure, not progress. The fix is one option (`ecmaFeatures: { globalReturn: true }`), verified; it is recorded in §24 v4.46 and NOT applied, per the standing freeze. **Quote 102 until it is.**
**All four counts were RE-RUN at this head, per rule 2, and are unchanged.** The line had been trailing: it pinned the head at `f4a689e4` and the decisions record at v4.38 while four entries had landed since (v4.39–v4.42), which is the state this file's own rule 2 exists to prevent — **a header that names an old head makes every row under it unreadable, because a reader cannot tell which rows were checked at which head.** Brought current in the same pass as item 18. **PART 1's table is deliberately NOT re-derived and is not stale**: its range `17cf8228..f386ced5` is a closed historical measurement, not a running one, and the base commit is outside this clone — recorded here per rule 6 rather than left as a silent omission.
**All four counts were RE-RUN at this head, per rule 2, and are unchanged.** 2026-08-17 touched two runtime files (`lib/inventory.js`, `routes/retail.js`) and added no transaction block in either form — but the authority was run rather than reasoned about, which is what rule 2 asks for.
**All four counts were RE-RUN at this head and are unchanged, not carried forward** — 2026-08-13's commits add `scripts/` files and `docs/` only, and no runtime file was touched, but rule 2 says the authority is the script and not an argument about what should have moved.
**All four figures MOVED and were re-derived, not carried forward.** `POST /api/retail-admin/orders` converted at `61007342`: 103 → 102 runtime-wide, 30 → 29 in `routes/retail.js`, 26 → 27 converted. **The two forms are still never summed.**
Those four values are the head this file is true at. **If any of them has moved, this file is stale until someone re-runs PART 4.**

**READ THE WORD "UNCONVERTED" IN THAT LINE AS LOAD-BEARING.** Until 2026-08-10 the AST authority could see only one of the two transaction forms, so every count in this file and in §24 means `<handle>.transaction(fn)` and never `withTransaction(handle, fn)`. The script now reports both, separately and never summed. **103 and 30 have not moved and are not a total** — see §24 and the mapping in the script's own header.

---

## THE RULE THAT KEEPS THIS FILE HONEST — READ BEFORE EDITING IT

**This file carries STATUS and POINTERS. It never carries the reasoning.** Every "why" lives in `docs/tacet-consolidation-decisions.md` §24 or in the design documents, and every remaining item below cites the entry that owns it.

**That is not a stylistic preference. It is the only thing that stops this file from becoming a second decision record that disagrees with the first**, which is the failure this section has already recorded three separate times — a commit message that claimed step 2 was done when it was not, a comment that answered for the code, and a batch report whose count disagreed with the record. **Two documents that both explain the same decision will drift, and the reader will not know which lied.** One explains, one indexes.

**§24 WINS ON ANY DISAGREEMENT WITH THIS FILE, ALWAYS, WITHOUT ARGUMENT.** If a line here contradicts it, this file is the wrong one and should be corrected here rather than debated there.

**WHY BOTH HALVES ARE IN ONE FILE.** Every record of this work used to be written from the deficit side — §24 grows by findings and open items, the cutover checklist lists things not done, the batches report a count falling towards zero. Each is correct and the sum is misleading: a status question answered against them alone returns "26 of 56 transactions converted", which is true of one step of one path inside one phase and false about eight days of work. Splitting built and owed into two files just moved the distortion. **They are one question and they belong on one page.**

---

## PART 1 — THE MEASURE

From `17cf8228` (2026-08-03, "The database decision is written down") to `f386ced5` (2026-08-10), on `main`:

| | |
|---|---|
| commits | **264** (214 excluding merges) |
| files changed | **267** |
| lines | **+95,824 / −7,531** |
| new scripts | **116**, of which **17** are test suites |
| new documents | **16** |

By day: 10 · 51 · 32 · 33 · 18 · 47 · 59 · 14.

> **TWO FIGURES CORRECTED, NOT JUST ADVANCED — 2026-08-10, per rule 5 below.** Re-running PART 4's block against the OLD head `674efa56` reproduces this table exactly except in two places, so these were wrong when written rather than made wrong by the six commits since. **Non-merge commits at that head were 209, not 217.** **The first by-day value was 10, not 18.** Both are out by exactly 8, which is the value in the last by-day slot at that head — consistent with one figure being added into the wrong column twice. The totals, files, lines, new-scripts and new-documents figures all reproduce to the digit. **The "17 test suites" classification does not reproduce from file names** — `test_`/`test-` prefixed additions alone give 20 at that same head — so it is left as written and treated as approximate, per rule 6.

**Roughly two fifths of it is the database.** Of the 214 non-merge commits, **87** are Postgres, seam, money-model, transaction, handle-threading or deploy-pipeline work. **That 87 was classified against the 217 figure now corrected to 209, so it is carried forward unverified rather than restated** — the split is a keyword classification and approximate by nature, and re-deriving it is its own pass. The remainder is unrelated work that shipped in the same window — the qingyun delivery-point stages, the pickup-window and reschedule clock defects, the receipt and slip corrections, the per-viewer language decision, the POS and restock shell removals, the international-phone defect, the welcome-coupon grant leak, the mini-app publish rule. **The migration did not have the week to itself, and any reading of the pace has to account for that.**

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
- **`POST /api/retail-admin/orders` CLASSIFIED, CONVERTED AND DEPLOYED** (`a94a19e7` + `61007342`, 2026-08-12) — item 9 closed. **NOT the money cluster**, and the discriminator is a method: the pending `retail_payments` row appears in both this transaction and the checkout's, so it cannot be what makes something money; the points ledger, topup ledger and balance write are, and this transaction has none. **UNCONVERTED `routes/retail.js` 30 → 29 and runtime-wide 103 → 102; CONVERTED 26 → 27.** `createOrReuseManualCustomer` threaded with it. Green on both drivers including better-sqlite3 on the box against the shipped tree; one pm2 restart, zero unstable, 238 log bytes all routine. **A mutant SURVIVED and is recorded as a finding** — `tx.prepare(` → `tdb().prepare(` cannot change behaviour on SQLite, so that discipline is source-enforced, not behaviour-enforced.
- **`retail_order_counters` CREATED ON THE CLUSTER — 162 tables → 163** (2026-08-11). Row at `('TC', 0)`, **deliberately UNSEEDED**: `last_no` is 0 against a measured maximum of 168, because seeding is the cutover's step and not the schema build's. **The DDL file had to be fixed first — as written it ran the seed as its third statement**, contradicting the ordering rule stated twenty lines above it in the same file. **As-built regenerated as `docs/tacet-postgres-schema-as-built-2026-08-11.sql`, body proven verbatim by sha256** against raw `pg_dump -s --no-owner` output; the 2026-08-04 file retained byte-for-byte, per the phase-1 precedent. **The regeneration found 303 `GRANT … TO tacet_app` statements missing from the old record entirely** — see item 41.
- **ORDER NUMBERING SETTLED AS A COUNTER ROW, AND PIECE 1 BUILT** (2026-08-11) — `docs/tacet-postgres-order-counter.sql` and `scripts/postgres-full-copy/seed_order_counter.py`. Schema and seeding only; no JavaScript, nothing on the SQLite side, nothing requires either file. **Proven against the live `tacet` database and then torn down**: DDL and seed run inside a rolled-back transaction, all four seeding paths exercised for real (missing-table guard, raise 0 → 168, idempotent re-run, counter-ahead warning at a non-zero exit without lowering the value), table dropped, cluster verified back at 162 tables. **It does not exist on the box.** One defect found by running it — the script parsed `UPDATE … RETURNING`'s stdout and got `"168\nUPDATE 1"`, because `psql -tA` prints the command tag. Reasoning in §24; the remaining code is item 12.
- **ITEM 44 CLOSED — a paid order cancelled with no gateway refund now reverses** (`f4a689e4`, 2026-08-17). Five reversals hoisted out of the `wechatRefundRef` branch; the branch keyed on whether the GATEWAY moved money and none of the six helpers touches it. **Real customers affected: ZERO** — all 20 orders are the tester's, so **no repair pass is needed for this item**. **The recorded ¥38.80 was wrong when written: ¥38.31 had already been returned, so the outstanding figure is ¥0.49** (¥899.00 stands). A second defect closed incidentally — the five sat inside the bookkeeping `try` and a failed write skipped them silently. §24 A PAID ORDER CANCELLED WITH NO GATEWAY REFUND REVERSES NOTHING.
- **A FIFTH CANCEL PATH FIXED — `sweepExpiredReservations` returned nothing** (`f4a689e4`, 2026-08-17). 26 orders, 9 customers, **and the only one of the two with real people behind it**: 302 short 6 points, 506 short a ¥20.00 voucher grant. Redeem + balance + **voucher** returned, via a hook fired after the transaction commits. All 26 verified never-paid on **seven independent signals** before the change. Repair script **built, tested, and RUN against production 2026-08-18**; 302's 6 points and 506's `SPROUT` grant 87 returned. §24 THE RESERVATION SWEEPER CANCELLED ORDERS AND RETURNED NOTHING.
- **ITEMS 27, 28 AND 29 BUILT ON A BRANCH — `claude/survey-land-shipment-default-vw1hcn`, NOT MERGED AND NOT DEPLOYED, 2026-08-19.** `TACET_DB` exists (`lib/db-driver.js`), `lib/pg.js` is required by the application for the first time, and `withTransaction` leases one connection per transaction so `tx` is a distinct client. **The decision under all three: the Postgres handle shares NO method name with better-sqlite3** — no `.prepare`, `.exec`, `.transaction`, `.pragma` — because an adapter hands 3,339 synchronous call sites a Promise where they expect a row and none of them throws. `exec` in particular would make `control()` take the SQLite branch. **The SQLite path is unchanged by DIFF, not by test: `database.js` is 40 insertions and 0 deletions.** 18 + 11 new assertions, both mutation red-proven; the two existing transaction suites (28, 14) stay green. **NOTHING RUNS ON IT** — no call site converted, no application code has executed against Postgres, and one converted transaction still cannot execute end to end. §24 v4.45.
- **ITEM 42 CLOSED — THE WALLET LEDGER BACKFILL RAN, 2026-08-17.** `retail_topup_transactions` rows **226–232** carry the seven rows `claimMigrationCredit` never wrote; undo file `/root/roots-v2/data/backfill_migration_credit_ledger.undo.json`. With the writer fixed at `225aa13` (2026-08-13) both halves are done: **check F returns ZERO and all ten invariants pass.** Six rows key `out_trade_no` in the live writer's scheme `migration:<creditId>:<customerId>`; **customer 57 keys `migration:unknown:57`** and correctly so — its staging row's values were overwritten by the re-import (item 43), so there is no credit id to carry. **Do not normalise that key.** **RECORDED LATE, AND THAT IS THE FINDING**: the run left no committed script, no §24 entry and no row change here, so three independent readings afterwards concluded "not built, not run" from a record that was complete except for this — and a second implementation was written, tested and merged before the run was discovered. §24 v4.44. **G11 in the cutover runbook is CLOSED and Part G now expects ALL 10 INVARIANTS PASSED outright.**
- **THE CUTOVER RUNBOOK EXISTS — AS A DRAFT, AND NOT AS AN EXECUTABLE PROCEDURE** (`53c8f308`, 2026-08-19) — `docs/tacet-postgres-cutover-runbook.md` v0.2. **It cannot be followed today and says so in its own first line**; 23 of its steps have no command because the thing they depend on has not been built. **The deliverable is the gap index in its PART A, not the procedure around it** — the first account of what Phase 2 owes that was derived by walking the procedure rather than remembered, and it found four things no list here carried. **The half that remains owed is item 18**, which was corrected rather than closed. **G11 was stale on arrival and was corrected before the merge** — see item 42. §24 v4.42.
- **The AST authority made able to see BOTH transaction forms** (`62ae872a`). It matched `.transaction` as a member property, so `withTransaction(h, fn)` — an `Identifier` callee — matched nothing, and **26 converted blocks appeared in no figure it printed, through four conversion batches.** The tree was enumerated first and opens a transaction in exactly two ways, no third. Every figure is now labelled with its form and **no blended total is printed anywhere**, because a combined number would change what every count in §24 means without changing a word of them. 103 and 30 are unchanged, verified by diffing the two scripts' output over the same tree. Red-proofed by a fixture with declared counts plus three mutations.

---

## PART 3 — REMAINING

**Status only. The entry named in the last column owns the reasoning and wins on any disagreement.**
Type: **C** conversion · **F** fix · **D** design question · **O** operational.

### Phase 2 — the code half

| # | Item | T | Blocks | Owned by |
|---|---|---|---|---|
| 1 | **Step 2's last TWO helpers** — `reconcileTier` and `mergeAddonItemsIntoShipments` still take no handle. **`createOrReuseManualCustomer` is THREADED** (`a94a19e7`, 2026-08-12) — it travelled with its route, as batch 2 said it would. **A fourth, `ensureShipmentRow`, was found by the 08-10 detector audit and is ALREADY THREADED — see the note below the table** | C | the loyalty cluster, `finalizeOrderAddon` | §24 PATH A STEP 2 — FOUR HELPERS THREADED |
| 2 | **`ensureShipments` and `reserveForOrder` keep `h.transaction()`** — SQLite maps it to a SAVEPOINT free, pg has no equivalent. Threaded but **not portable** | D | the checkout, and every unconverted `.transaction()` reachable from a converted async caller | §24 same entry, OPEN item 1 |
| 3 | **`getAvailable` and `ttlMinutes` still on `tdb()` inside `reserveForOrder`** — safe today on conditions, not properties | F | correctness of the stock gate after the flip | §24 same entry, OPEN item 3 |
| 4 | **`BEGIN IMMEDIATE` unimplemented in `withTransaction`** | D | **the checkout** | `lib/db-transaction.js` header; design doc §What replaces `.immediate()` |
| 5 | **`withTransaction` cannot nest inside a `tdb().transaction()` body** — measured, two independent reasons | D | any incremental route into the checkout | §24 same entry, OPEN item 2 |
| 6 | **The checkout** — 209 lines, 9 ordered writes, 6 typed errors, a 7th idempotency exit | C | `ensureShipments`, the split's undo-combine branch, retiring `.immediate()` | `tacet-checkout-transaction-design.md` v2.0 |
| 7 | **The money cluster** — 13 named helpers + 5 money routes. No design doc exists for this group. **NEW 2026-08-12: that doc now has a named open question waiting for it** — every post-commit idempotency guard measured for item 9 was measured against a SYNCHRONOUS driver, and at the flip the post-commit block becomes genuinely interruptible rather than merely reorderable | C | Phase 2 completion | §24 batch entries; §24 IS NOT THE MONEY CLUSTER, OPEN |
| 8 | **73 transactions outside `routes/retail.js`**, incl. `commitOrderReservations` and `reverseCommittedOrder` | C | Phase 2 completion | §24 PHASE 2 OWED WORK, item 1 |
| 9 | ~~**`POST /api/retail-admin/orders` unclassified**~~ — **CLASSIFIED, CONVERTED AND DEPLOYED 2026-08-12 (`61007342`). NOT the money cluster**; moved to PART 2. Left here per rule 4 so the row is not deleted | — | nothing | §24 `POST /api/retail-admin/orders` IS NOT THE MONEY CLUSTER |
| 10 | **`POST /polls/:id/vote` misclassified** — "safe inline" while writing `points_balance` and the points ledger | D | its own conversion | §24 PHASE 2 OWED WORK, item 3 |
| 11 | **`FOR UPDATE` sufficiency on the stock row** — the invariant holds by convention, not construction | D | the checkout on pg | design doc, uncertainty 1 |
| 12 | **`nextOrderNo` on Postgres — the DESIGN QUESTION IS SETTLED; the code is not.** A COUNTER ROW, not a sequence. Schema and seeding **built 2026-08-11** (PART 2). What remains is Piece 2: thread the handle, duck-typed branch that throws, **and the probe loop must not survive onto the pg path** | C | the checkout on pg, and blocked behind #9 and #6 | §24 ORDER NUMBERING IS A COUNTER ROW |
| 13 | **Checkout contention unmeasured** — cheapest of the three uncertainties, still unsettled | D | nothing; sizes the work | design doc, uncertainty 3 |
| 14 | **`PUT /cms/onboarding-settings`** unwrapped multi-write · **`reconcileTier`** swallows its errors · **`categories` `UNIQUE(kind,name)`** has no `COLLATE NOCASE` | F | nothing today | §24 DUAL-CONTEXT HELPERS; TWO CATEGORY SYSTEMS |
| 15 | **Six statements failing in production today** — and per §24 these are **not typo fixes**: each path has never executed, so fixing one surfaces behaviour nobody has seen | F | 162 seam sites waiting on decisions | §24 Six statements are failing |
| 42 | ~~**`claimMigrationCredit` credits the wallet and writes NO ledger row**~~ — **CLOSED. Writer fixed `225aa13` 2026-08-13; backfill RUN against production 2026-08-17, rows 226–232. Check F is ZERO.** Moved to PART 2; left here per rule 4 so the row is not deleted. **This row twice said NOT BUILT / NOT RUN after both halves were done** — corrected in the open per rule 5, and the reason it was wrong is worth more than the correction: **the 2026-08-17 run was recorded nowhere, so nothing in this repository could see it** | — | nothing | §24 THE FIRST LIVE MONEY INCONSISTENCY FOUND BY MEASUREMENT; §24 v4.44 |
| 43 | **`retail_migration_credits` is not append-only** — a re-import reset `claimed_at` on an already-claimed row and a second customer claimed it. **Nothing prevents recurrence**, and `UNIQUE (phone)` is *why*: it forces an import to UPDATE in place. Constrains item 42's `out_trade_no` scheme | F | item 42's key design | §24 THE MIGRATION CREDITS STAGING TABLE IS NOT APPEND-ONLY |
| 44 | ~~**A paid order cancelled with NO gateway refund reverses nothing**~~ — **FIXED AND DEPLOYED 2026-08-17 (`f4a689e4`). Moved to PART 2; left here per rule 4 so the row is not deleted.** Two figures in the original row are corrected there per rule 5: the balance never returned was **¥0.49, not ¥38.80** (¥38.31 had already gone back before the cancel), and **the affected customer is the TESTER — real customers affected: ZERO**, so no repair pass follows. ¥899.00 stands. M's fourth structural reason no longer accrues | — | nothing | §24 A PAID ORDER CANCELLED WITH NO GATEWAY REFUND REVERSES NOTHING |
| 45 | ~~**`sweepExpiredReservations` cancels an order and returns nothing**~~ — **FOUND AND FIXED 2026-08-17 (`f4a689e4`)**, a fifth cancel path item 44's survey did not list. 26 orders, 9 customers; **two REAL customers short** (302: 6 points · 506: a ¥20.00 voucher grant). **Repair script built, tested, and RUN against production 2026-08-18 18:59 UTC+8** — `scripts/repair_sweep_cancel_reversals.js`; 302's 6 points and 506's `SPROUT` grant 87 both returned, undo file `data/undo-repair-sweep-cancel-1787050794887.json`, acceptance diff clean | F | nothing in code; **both customers made whole 2026-08-18** — see §24 | §24 THE RESERVATION SWEEPER CANCELLED ORDERS AND RETURNED NOTHING |

**`ensureShipmentRow` — FOUND 2026-08-10, PREVIOUSLY UNCOUNTED, AND NOT OWED WORK.** Surfaced by the detector audit that taught the AST authority to see `withTransaction`. It had appeared on no step-2 list because **its only transaction context is a CONVERTED block**, and the old detector could not see those — so the dual-context table had no row for it at all.

**Checked in the code rather than taken from the audit, per rule 3: it already takes the handle.** `const ensureShipmentRow = (h, mode) => …` in `routes/retail.js`, a local closure inside `POST /api/retail-admin/orders/:id/shipment-suggestion/apply`, with a comment citing the §24 dual-context rule by name. Its single call site passes `tx`, the handle `withTransaction` hands in. **Nothing to thread.** Recorded here so it is not rediscovered as owed work, and as the concrete instance of what the blind detector cost: not a wrong number, a helper that was never in the population being counted.

### Phase 2 — the operational half

| # | Item | T | Owned by |
|---|---|---|---|
| 16 | 🔴 **Fresh-cluster restore is UNPROVEN** — the rehearsal ran in a cluster where `tacet_app` already existed, so `CREATE ROLE` never executed. The new-box case is the disaster case | O | §24 v4.17 backup entry |
| 17 | 🔴 **No rollback plan** — "a setting plus a restart" is true of the code path and false of the data. **THE TOOL IS BUILT ON `claude/survey-land-shipment-default-vw1hcn`, NOT MERGED**: `scripts/rollback-to-sqlite.sh` + `scripts/rollback-delta-report.js`, 23 assertions, mutation red-proven. **Rollback is RESTORE-AND-LOSE and a reverse copy is a REJECTED option** — 89 of 129 tables cannot report an UPDATE (`retail_customers` among them), deletes leave no trace, and the timestamp direction returns everything eight hours out if UTC is not forced. **Valid only because THE DAEMONS STOP FOR THE FLIP (decided 2026-08-20)**; refusal R4 enforces it. What remains owed on this row is G23 — trigger, decision-maker, window | O | §24 v4.46 |
| 18 | 🔴 **No EXECUTABLE cutover runbook. A DRAFT exists and cannot be followed** — `docs/tacet-postgres-cutover-runbook.md` v0.2 (`53c8f308`, 2026-08-19), moved to PART 2 per rule 4. **What is owed is not another document; it is the 23 gaps closed or waived in writing**, after which the draft becomes a procedure. **The list is that file's PART A and is deliberately not restated here** — two copies of it would drift, and this file would be the wrong one. **Four are critical: G2, G16, G20, G22.** `GO-LIVE-CUTOVER.md` is still the mini-app one and is still not this | O | §24 v4.42; the runbook's PART A |
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
| 27 | ~~**`TACET_DB`** — appears nowhere in the repository~~ — **BUILT on `claude/survey-land-shipment-default-vw1hcn`, NOT MERGED.** `lib/db-driver.js`; missing selects sqlite and says so, unrecognised throws at load, the boot line names the driver so a flip can assert. Moved to PART 2; left here per rule 4 | C | §24 CUTOVER SEQUENCING; §24 v4.45 |
| 28 | ~~**Wire `lib/pg.js` in** — nothing requires it today~~ — **BUILT, NOT MERGED.** `database.js` requires it under `TACET_DB=postgres`, which also arms the numeric parser. Identity through `tdb()`/`rawTdb()`/the ALS proved, not assumed. Moved to PART 2; left here per rule 4 | C | `lib/pg.js` header; §24 v4.45 |
| 29 | ~~**The pg backend of `withTransaction`** — not written, not tested~~ — **BUILT, NOT MERGED.** The lease is taken before BEGIN and handed to the body, so `tx` is a distinct client; savepoint scheme followed rather than re-derived. Moved to PART 2; left here per rule 4 | C | `lib/db-transaction.js` header; §24 v4.45 |
| 30 | **Queue scoped to the checked-out client, not the pool** — measured: three transactions on a shared handle ran strictly sequentially. Plus nested reuse of the outer client, and release on every exit path. **NOW THE NEXT THING: G4 leaves transactions correct but SERIALISED application-wide, and a nested call made on the POOL rather than on `tx` would deadlock — it is refused by name until this lands.** Release on every exit path is done | C | design doc Part 2; §24 v4.45 |
| 31 | **A fresh data copy + delta pass.** Drift measured 2026-08-09: checkout_quotes +23,829, guanyi_sync_log +4,788, customers +222, orders +87 | O | §24 Full data copy, findings |
| 32 | **The directory rename**, bundled here deliberately — standalone it breaks the SQLite path, pm2, Actions, `deploy-apply.sh` and probably nginx at once | O | §24 line 537 |
| 33 | **The gzgrocery table rename** | O | §24 gzgrocery rename |
| 40 | **SEED `retail_order_counters` — LAST, after the fresh copy AND after the delta pass.** The table itself is **CREATED** (2026-08-11, PART 2); what remains is only the seeding. `scripts/postgres-full-copy/seed_order_counter.py`. **Measured 2026-08-11: pg holds 168 `TC` orders, SQLite 247** — the counter sits at 0 and must not be seeded until traffic is about to move | O | §24 ORDER NUMBERING IS A COUNTER ROW; cutover checklist |
| 41 | **The as-built record was stale on 303 `GRANT … TO tacet_app` statements** and nothing noticed for a week, because its only two consumers parse it for `CREATE UNIQUE INDEX` and nothing else. Fixed by the 2026-08-11 regeneration. **The open half: both consumers open the 2026-08-04 file BY ITS DATED NAME** and were deliberately not repointed — unique indexes are unchanged at 15, so they are provably unaffected today and will need repointing the first time an index changes | F | §24 PIECE 1 APPLIED TO THE BOX |

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

> **#12's silent mode is now NAMED AND DEFUSED BY DESIGN, but the code is unwritten, so it stays on this list — 2026-08-11.** The silence had a specific mechanism: carrying the probe loop onto Postgres would walk past a mis-seeded counter's collisions forever, at hundreds of wasted round trips per order, behind a function that appears to work. §24 records dropping the loop as the single most important line of the design, leaving `retail_orders_order_no_key` to fail the first checkout loudly instead. **A design that names the failure is not a fix; #12 comes off this list when Piece 2 lands, not before.**

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

Commit, file and line counts are from `git log` and `git diff --shortstat` against `17cf8228..f386ced5` on `main`, and are regenerable by the block above. **By-day counts are AUTHOR date (`%ad`); committer date gives a different distribution because of rebases, and the two must not be mixed.** **The Postgres-versus-other split is a keyword classification of commit subjects and is approximate by nature** — offered as a proportion, and the only inexact number in this file.

Every other figure is quoted from §24, from a design document, or from the AST authority. **No figure here is grep-derived.**

---

## RELATED

- `docs/tacet-consolidation-decisions.md` §24 — the decisions record. **Owns every "why" in PART 3 and wins on any disagreement with this file**
- `docs/tacet-checkout-transaction-design.md` — the checkout conversion design, v2.0
- `docs/tacet-money-model-survey.md` — the money-unit gap behind the boundary-layer decision
- `docs/tacet-schema-change-survey.md` — the six options behind the pgroll decision
- `scripts/diagnose_async_conversion_scope.js` — the AST authority for conversion counts
- `scripts/postgres-full-copy/`, `scripts/postgres-migration/` — the copy and rehearsal, preserved
