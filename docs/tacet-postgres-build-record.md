# The Postgres migration — what has been built, v1.0

**2026-08-10 · A delivery record for the SQLite-to-PostgreSQL migration, covering 2026-08-03 to 2026-08-10.**
Read-only. No code changes accompany this file. Every figure is derived from git or from `docs/tacet-consolidation-decisions.md` §24 and is cited where it lands.

---

## WHY THIS DOCUMENT EXISTS

**Every other record of this work is a record of what is owed.** §24 is a decisions record, so it grows by findings, corrections and open items. The cutover checklist is a list of things not done. The conversion batches report a count falling towards zero. Each is correct and each is written from the deficit side.

The effect is cumulative and it is misleading. A status question asked against those documents alone is answered with "26 of 56 transactions converted", which is a true statement about one step of one path inside one phase, and a false impression of eight days. **This file is the counterpart: what exists now that did not exist on 2026-08-03.**

It is not a defence of the pace and it is not a claim that the migration is close. The owed work is real and is recorded elsewhere, unchanged by this document. **This one answers a different question — not "what is left" but "what is built".**

---

## THE MEASURE

From `17cf8228` (2026-08-03, "The database decision is written down") to `3d9091dc` (2026-08-10), on `main`. **A snapshot, and it moved twice while this file was being written** — regenerate it rather than citing it as of a later date:

| | |
|---|---|
| commits | **253** (214 excluding merges) |
| files changed | **265** |
| lines | **+94,916 / −7,531** |
| new scripts | **115**, of which **17** are test suites |
| new documents | **15** |

By day: 18 · 51 · 32 · 33 · 18 · 47 · 59 · 3.

**Roughly two fifths of it is the database.** Of the 214 non-merge commits, **85** are Postgres, seam, money-model, transaction or deploy-pipeline work. The remaining **129** are unrelated work that shipped in the same window — the qingyun delivery-point stages, the pickup-window and reschedule clock defects, the receipt and slip corrections, the per-viewer language decision, the POS and restock shell removals, the international-phone defect, the welcome-coupon grant leak, the mini-app publish rule. **The migration did not have the week to itself, and any reading of the pace has to account for that.**

---

## PHASE 1 — DONE, AND VERIFIED TO THE CELL

Phase 1 is defined at §24's ROLLED OUT IN PHASES paragraph: *"Phase 1 installs PostgreSQL alongside the running SQLite app; nothing points at it yet."* All of it is done.

- **PostgreSQL 16.14 installed alongside the running application**, 2026-08-03. Cluster `16/main`, port 5432, localhost-only. The live app never stopped serving from SQLite.
- **The `tacet` database built** — 162 tables, 230 indexes, 144 foreign keys, from the reviewed schema.
- **A five-table rehearsal copy** — accounts, users, suppliers, purchase_orders, invoices. 5,877 cells compared, **zero differences**. Preserved at `scripts/postgres-migration/` (`102f3f56`).
- **THE FULL DATA COPY** (§24, `Full data copy to Postgres — DONE 2026-08-04`). All **129 non-empty tables, 353,220 rows, in 86 seconds.** SQLite was opened read-only and *proven* so on every connection by a rejected write, not assumed.
- **The verification is the part worth reading twice.** Row counts matched exactly. **3,244,556 cells were round-trip compared**, with 43 differences, every one traced to live trading during the run rather than to the copy. All 144 foreign keys validated by Postgres itself. Chinese character counts exact. 2,112 base64 values byte-identical by SHA-256, the widest 3,331,931 characters. 139 identity sequences set — **117 of them from SQLite's AUTOINCREMENT high-water mark rather than `max(id)`**, which matters on the 20 tables where ids are burned.
- **Four schema records committed**, 27,646 lines in total: the proposed draft, the as-built phase-1 dump, the as-built 08-04 dump, and the decimal rebuild.
- **The Postgres driver installed and wired to nothing** (`867fa923`), deliberately inert.
- **`tacet_app`, the least-privilege application login**, exists on the cluster.

**Two honest qualifications, stated here rather than left to be discovered.** The copy is a **rehearsal**, not a cutover artefact — it drifts from the moment it is taken, and the delta since 08-04 is a Phase 3 input. And `docs/tacet-postgres-schema-phase1.sql` is **stale on eleven columns** and retained as history only; the current record is the 08-04 as-built dump.

---

## THE DATABASE SEAM — BUILT AND DRIVEN TO 75%

The seam is the layer every statement passes through, and it is what makes a driver substitution possible at all. It did not exist on 2026-08-03.

- **Built and proven before anything depended on it** (`e450f059`, `d7196a91`). `lib/store-hours.js` was the first module through it.
- **The mechanism proven exhaustively, once, across the whole better-sqlite3 surface — 2,781 assertions** — before any batch moved.
- **Step A of the tenant step**: raw accessors, an AsyncLocalStorage guard, and `currentTenantId()` stopped guessing.
- **Step B, the flip** (`6959d5c3`): `tdb()` and `getTenantDb()` return `seam(...)`. **Two lines, and coverage went from 18 of 2,799 statement sites (0.64%) to 1,351 (48.27%).** Everything that made those two lines safe was built in Step A, which is the argument for having done it that way.
- **Then five DIRECT batches**: 48.27 → 50.52 → 55.34 → 60.49 → 64.63 → **69.77%**, ending at **75.28%** overall. **Daemons: 154 of 177 sites, 87.01%** — guanyi, meituan, shangou, qingyun and eleme all through, with every one of their 150 statements executed raw against wrapped before it shipped.
- **The coverage checker was itself found to be measuring less than it claimed, and corrected.** A proposal to shrink the denominator by excluding 226 sites as DDL was **withdrawn** after 211 proved to be DML and four of those touched money. **Coverage stays 75.28% and is honest.**

**What the seam is not, recorded so it is not overclaimed.** It is a proven passthrough with **no converter installed** — the money converter seat is empty and measured empty. And §24's own CUTOVER SEQUENCING entry establishes that the seam is *the proof of the limit, not the solution*: it can change which driver runs, and it cannot make an asynchronous driver satisfy a synchronous call signature. That finding is what produced Path A.

---

## THE MONEY MODEL — SURVEYED, DECIDED, AND REVERSED ONCE ON EVIDENCE

- **`docs/tacet-money-model-survey.md`, 989 lines.** 92 columns changing unit, plus nine to `numeric(14,6)`; the read and write sites; the SQL-side arithmetic a JavaScript boundary structurally cannot reach; the mixed-engine transition hazard; and the second money model inside `storefront_config` that the boundary layer cannot reach either.
- **101 REAL money columns converted to integer cents** in the phase-1 translation, with percentage columns and the polymorphic `retail_vouchers.value` deliberately left alone — converting that one as-is would corrupt the percent rows.
- **THEN THE CENTS RULE WAS REVERSED WHERE IT WAS WRONG, ON MEASUREMENT.** Whole cents is right for transaction amounts and wrong for per-unit costs, which get multiplied by quantity. **Twelve genuine unit costs would have rounded to zero and 188 values were off by more than 10 percent.** Nine cost columns were retyped to `numeric(14,6)`. `numeric` was chosen over micro-cents because Postgres numeric is exact decimal arithmetic and so does not reintroduce the floating-point defect the cents rule exists to kill.
- **`products.weight` and `store_products.weight` retyped to text**, because they hold free text with mixed units — `'500ml'`, `'1L'`, `'120g (4 bars)'`, one malformed `'5--g'` — and no numeric conversion is correct.
- **The read-side money converter built** — a single global pg type parser on OID 1700, registered at module load, dispatching on type rather than on a hand-maintained column list, because the type *is* the list: 101 both ways, nothing on either side.
- **Money resolved by schema class, never by column name** — recorded as a rule after `setup_fee_cents` sprang that trap once.
- **In-SQL arithmetic money writes proven safe under decimal**, and the structural limit of a JavaScript converter written down rather than assumed away.

---

## WHAT THE MIGRATION WORK FOUND IN THE REST OF THE SYSTEM

None of this was the object of the work. All of it was found because the migration required looking.

- **A FAILED DEPLOY HAD BEEN SILENTLY SKIPPING ITS CHANGES, AND IT HAD DONE IT 197 TIMES.** `deploy.yml` diffed against the previous push rather than against the last successful deploy, so a failed run's files were skipped permanently and every later run reported success. Replaying all 904 runs from 2026-06-22 found **939 moments where a run reported SUCCESS while production did not match the repository**, grouping into **197 stranding episodes across 141 distinct files**. 71 ran longer than a week, the longest 43 days, and **79 were never healed by any later commit**. Twenty-two were runtime code. Found because the Step B flip did not reach the box. **Fixed 2026-08-05** (`2e24221b`, `ad945129`), with a deployed-tree diagnostic built to prove it.
- **THE STATEMENT-PREPARATION SWEEP.** `scripts/diagnose_statement_sweep.js` prepares every statically-written statement in every in-scope file against the live schema. **2,524 statements across 109 files.** It found **six statements failing in production today** — including the operator's order search and a customer's order history, both broken and both invisible behind a catch — and **96 statements that compile on SQLite and will not run on Postgres**. That dialect work "was not previously on the cutover checklist in any form."
- **The AST count authority** (`93e17403`). Six figures in §24 had been taken from grep and were wrong; the script found two of them on its first run. Grep cannot see nesting, argument position, or whether a match sits in a comment.
- **`TENANT_DATA_ISOLATION` is ON in production**, against a record that said otherwise — because the flag lives in a gitignored `.env` and no survey of the repository could see it.
- **The schema-change mechanism surveyed and decided** — `docs/tacet-schema-change-survey.md`, six options, pgroll chosen for the rollback hole.
- **Test accounts cleared from live data**, five accounts, 52 rows, with `foreign_key_check` clean afterwards.

---

## PHASE 2 — THE ASYNC CONVERSION, AS FAR AS IT HAS GONE

The half of Phase 2 that is code. Path A steps are cited by list, not by bare number, per §24's warning about step numbers.

- **STEP ZERO — the async rejection guard** (`ba367914`). Express 4 does not catch rejections from async handlers and 207 of 327 handlers had no try/catch. `lib/express-async-guard.js` is a global guard, adopted while every handler was still synchronous.
- **`routes/retail.js` surveyed** — 29,682 lines, 1,241 of the 2,739 runtime `.prepare()` sites, a six-way call-site classification reconciling exactly.
- **The transaction helper built, proven and shipped UNUSED** (`d7515a36`) — 28 assertions, green on both SQLite drivers, red proven on both, so that a flaw could not propagate into every call site at once.
- **Four conversion batches, 26 transactions**: `routes/retail.js` 56 → 30 by AST, runtime-wide 129 → 103, reconciling exactly. Each batch red-proven, latterly per conversion rather than per file.
- **The helper's concurrency defect found and repaired** (`e9b6da1d`) — nesting moved off the shared handle and into the async context. Written red first: 4 passed, 10 failed. **It was found before the checkout was converted, which is the difference between a test failure and an oversell on live money.**
- **`PUT /integrations` made atomic** (`e46e61ce`) — the `process.env` mirror ran inside a transaction a rollback could not reach.
- **The shadowed split route fixed** (`5a75ad64`) — "Ship part later" had been live and destructive-on-success for eight weeks, and the fix came with a tripwire asserting no admin route in the file is registered twice.
- **The checkout designed on paper, twice** — `docs/tacet-checkout-transaction-design.md` v1.0 and v2.0, the second revised against the repaired helper.
- **PATH A STEP 2 STARTED BUILDING, 2026-08-10.** Decided on 2026-08-08 and unbuilt for two days; batches 1 (`e16e94cc`) and 2 (`3d9091dc`) took **five of the seven** dual-context helpers onto a handle parameter: `generateRetailSku`, `writeLayout`, `ensureShipments`, `reserveForOrder`, and `productContentSnapshot`, which already had one. **`reconcileTier`, `createOrReuseManualCustomer` and `mergeAddonItemsIntoShipments` still do not**, so the step is in progress rather than done. This entry is dated because it landed while this file was being written, which is itself worth recording: a delivery record goes stale the same way a deficit record does.
- **Postgres backed up at last** (`7b3ce893`) — `pg_dump -Fc` of `tacet` plus `roles.sql` nightly. **`roles.sql` is load-bearing, not an extra:** roles are cluster-level so `pg_dump` never carries them, and the archive holds 927 grants naming `tacet_app`.
- **Three harness defects fixed** across three consecutive batches, each of which would have made a suite green and wrong, and the written-column assertion made non-optional as a result.
- **The phase numbers defined in the record for the first time** (`ec537133`), with backups, rollback and the runbook placed inside Phase 2 rather than Phase 3.

---

## WHAT THIS DOCUMENT DOES NOT CLAIM

**It is a record of delivery, not a status.** Nothing here says the migration is close, and nothing here supersedes an open item.

- The remaining 30 transactions in `routes/retail.js` are the hard ones by design — 19 are money or vouchers, one is the checkout, and the batches said so in their own subject lines.
- **73 of the 103 runtime transactions live outside `routes/retail.js`** and are not scheduled.
- **Path A step 2 is in progress, not finished** — `reconcileTier`, `createOrReuseManualCustomer` and `mergeAddonItemsIntoShipments` still take no handle.
- Backups exist but **the fresh-cluster restore is unproven**, which is the case that matters.
- The rollback plan and the cutover runbook do not exist.

For all of that, read §24 and `docs/tacet-checkout-transaction-design.md`. **They are the authority for what is owed; this file is only the authority for what is built.**

---

## METHOD

Commit counts, file counts and line counts are from `git log` and `git diff --shortstat` against `17cf8228..3d9091dc` on `main`, and can be regenerated. The Postgres-versus-other split is a keyword classification of commit subjects and is **approximate by nature** — it is offered as a proportion, not as a precise figure, and it is the only number in this document that is not exact.

Every other figure is quoted from `docs/tacet-consolidation-decisions.md` §24 or from the AST authority, `scripts/diagnose_async_conversion_scope.js`. **No figure here is grep-derived**, per the method note §24 records after six grep errors.

---

## RELATED

- `docs/tacet-consolidation-decisions.md` §24 — the decisions record, the findings, and everything still owed
- `docs/tacet-checkout-transaction-design.md` — the checkout conversion design, v2.0
- `docs/tacet-money-model-survey.md` — the money-unit gap behind the boundary-layer decision
- `docs/tacet-schema-change-survey.md` — the six options behind the pgroll decision
- `scripts/diagnose_async_conversion_scope.js` — the AST authority for conversion counts
- `scripts/postgres-full-copy/`, `scripts/postgres-migration/` — the copy and rehearsal, preserved
