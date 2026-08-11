# Tacet shared-core consolidation — decisions record, v4.31

**2026-07-31 · A living record of what has been decided so far for the Tacet shared-core consolidation, so the decisions stop living in chat. Supersedes v0.1. The questions in §23 Open questions are NOT decided and must not be treated as settled.**

2026-08-03 · v1.0 — records the PostgreSQL database decision (§24). Note: v0.9 exists on an unmerged parallel branch (docs-glossary-stock-model-abi0fp) with different content; main skips to v1.0 to avoid a duplicate v0.9.

2026-08-11 · v4.31 — §24 Database: **the nesting property is VERIFIED ON THE BOX — all four properties passed**, so v4.30's UNVERIFIED marker is replaced by the result rather than left to go stale. An inner `db.transaction()` nests and commits with the outer; an inner failure rewinds only the inner write while the outer still commits; **the negative still fails**, which is what makes the other three discriminating rather than agreeable; and the depth-2 control holds. **The mechanism was observed, not inferred: `db.inTransaction` reads `true` inside the `withTransaction` body**, which is what routes the inner call to a SAVEPOINT instead of a second `BEGIN`. **The driver pairing is part of the result — better-sqlite3 `^9.4.3` on Node `v20.20.2`, production's own — because the property is driver behaviour and a pass on a different ABI would prove less**; a driver or Node upgrade invalidates the measurement and it must be re-run. Records that the probe lives at `/root/check-nesting.js`, is NOT in git and is lost on a rebuild, so the evidence is reproducible only while that box exists. Option D is now settled rather than provisional. A verification; nothing reversed, hence a patch.

2026-08-11 · v4.30 — §24 Database: **helper nesting is an ORDERING CONSTRAINT, not a missing primitive — DECIDED, and nothing is built.** Surveyed by AST: **eight helpers open a transaction on a passed handle, only TWO genuinely nest** — the other six take an outermost handle, or a different database, or are SQLite table-rebuild migrations that Postgres does not need and that die at the cutover. **Option A is unavailable and that is a measured result**: both helpers are dual-context, `ensureShipments` 2 nested / 9 standalone and `reserveForOrder` 1 nested / 1 standalone, so neither internal transaction can be removed. **THE RULE: a helper may go async only when every one of its callers is async** — convert the enclosing route first, and `h.transaction()` becomes `await withTransaction(h, …)` in the SAME commit. **The earlier objection was to converting a helper BEFORE its caller, not to `withTransaction` itself**, and both directions are already pinned in `test_handle_threading_batch2.js`: the failing case against a raw `BEGIN IMMEDIATE` (depth reads 0) and the passing control inside its own kind (depth 1 then 2). Nothing changes in `lib/db-transaction.js`. **Recorded as UNVERIFIED pending a box check** — the transition shape, a converted route calling a helper that still holds `h.transaction()`, has never run, and `check-nesting.js` probes it against a throwaway `/tmp` database. **B and C rejected**: B collapses into the conversion because a pg primitive must be async and cannot be awaited inside a `db.transaction()` body; **C is refused hardest** because reading `db.inTransaction` works on one of three backends and re-introduces the `dc91e62f` defect that folded two concurrent requests into one transaction. Records the savepoint naming scheme for whoever writes the pg side. **Plus a second OPEN item: `BEGIN IMMEDIATE` is what actually blocks the checkout** — `nextOrderNo` does SELECT MAX then INSERT, and BEGIN IMMEDIATE is a LOCKING MODE with no pg translation, not an isolation level. Three candidates recorded with their costs — sequence, `pg_advisory_xact_lock`, serializable-with-retry — **as Ash's decision, not yet made and deliberately not designed.** A decision, a reframing and two open items; nothing reversed, hence a patch.

2026-08-11 · v4.29 — §24 Database: **the backup's prune step can now report its own failure — FIXED and deployed at `c5a2eb11`, closing the 2026-08-18 deadline item seven days early.** The pruning always worked; what did not was the step's ability to say so when it stopped. **Four states, not one** — `ok`, `failed_listing`, `failed_parse`, `failed_delete` — with `eligible=`, `removed=`, `failed=` and `cutoff=` now in the log line. **`failed_parse` is deliberately separate from `failed_listing`**: a listing that SUCCEEDS and no longer parses is an ossutil upgrade, and it is the case that would otherwise be indistinguishable from an empty bucket. **THE DECIDING ARGUMENT, recorded: a failed listing alerts loudly and does NOT fail the run**, because by then the backup has succeeded and been verified, and `fail()` would write FAIL to `db-backup.log` — the line a later reader uses to decide whether a restore is even available. **Marking a good backup FAIL answers that wrongly, in the direction where a restore is not attempted.** `trap - ERR` moves BEFORE the block so that invariant is **structural rather than statement-by-statement** — recorded as the pattern: an invariant enforced at a boundary survives edits, one enforced per statement does not. One alert per non-`ok` state, never one per object, on the same dedup reasoning as `reconcileTier`'s customer-free alert text. **Deployed rather than `[skip deploy]`, deliberately: a skip defers rather than exempts**, which would have made arrival depend on unrelated work landing before the deadline; hand-copying was rejected because it breaks the pipeline's guarantee that deployed bytes are committed bytes. Verified on the box by sha1 of the shipped file, not by the merge. **The 2026-08-18 check is written down in the entry rather than left to be reconstructed.** **Plus three rules:** a harness whose shell options differ from the real script's is testing a different program — the driver ran `set -uo pipefail` against a script that runs `set -euo pipefail`, and would have hidden the exact class of defect it exists to catch; a fixture pinned to real-world dates goes stale silently, caught here loudly but dangerous in the version that passes; and `scripts/test-deploy-base.sh` needs python3 + PyYAML and reports 2/8 on Windows, environmental and pre-existing, recorded so nobody chases it. A fix, a deploy, a closed deadline item and three rules; nothing reversed, hence a patch.

2026-08-11 · v4.28 — §24 Database: **undo-combine's missing guard and its two-transaction window — both FIXED and deployed at `12c92ae4`**, in two separate commits so the guard stays separable from the atomicity change. Branch B called `ensureShipments` unconditionally, and that helper never reads `fulfillment_type`, so undo-combine on a pickup or counter order **created parcels for an order collected at the store — and unlike every other shipment defect here it does NOT self-heal**, because the order-detail read's own guard returns `[]` for those orders instead of reconciling them. **409 `ships_nothing` rather than a silent no-op**, on this route's own conventions and its own history: answering an impossible request "with success rather than a rejection" is exactly what let the shadowed split run destructive for eight weeks. **THE FINDING, recorded as such: the branch read `SELECT id` only**, so `shipsNothing(o)` would have seen `undefined` forever — **a guard that would have passed review, read correctly in the diff, and protected nobody.** A test now asserts the column is selected. **Reachability MEASURED: latent, not live** — three gates recorded individually because a future UI change could remove any one (the button needs an existing `合并` shipment, a pickup order's shipments array is empty, the combine route cannot create one), plus `fulfillment_type` is never `UPDATE`d anywhere. Commit 2 merges the delete and the rebuild into one transaction — **EXTENT, not form: still `db.transaction()`, conversion boundary untouched, batch 4's exclusion holds** — with nesting and read-own-writes both re-proved on the branch. Records two test decisions: the rollback assertion checks the ORIGINAL count AND the same row ids because a partial rebuild is also non-zero and also data loss, and read-own-writes is asserted on a planner spy because a row count cannot tell a rebuild from an early-return over stale rows. **OPEN: Branch A validates outside its transaction and that window IS awaited** — `item_already_dispatched` and `would_empty_shipment` run before `await withTransaction`, and `acquire`'s `st.tail.then` is a microtask only while the handle is idle; under contention it spans real I/O. **Plus: the v4.27 mutation rule's first use HELD** — a mutation aimed at a non-matching pattern refused to count instead of producing a meaningless red — and the rule is sharpened: **an anchor must contain no line ending at all**, after a literal `\r\n` anchor was written and replaced while building the very suite that guards against it. Two fixes, a finding, a deploy and an open item; nothing reversed, hence a patch.

2026-08-11 · v4.27 — §24 Database: **`reconcileTier` fails loudly and names its victim — FIXED and deployed at `b7c70d39`.** The catch stays non-fatal and now logs at ERROR level carrying `customerId`, `want`, `storedTier` and the driver message, then fires a best-effort `sendOpsAlert`, double-wrapped against both a synchronous throw and a rejected promise so the alert can neither mask nor replace the log. **Records WHY non-fatal beat rollback as REASONING, not preference:** every caller already swallows, so throwing would not fail an order — it would silently drop points and `lifetime_spend` with nothing to retry, and the understated spend would then make the self-heal persist a WRONG tier; **`finalizeOrderAddon` is decisive, because the customer pays for an add-on and does not receive it.** Records that **`requireRetailAuth` reconciles on EVERY authenticated request and that self-heal is load-bearing** — it is why the defect never bit, and removing it inverts the reasoning. Records the alert text as **deliberately customer-free**, because `sendOpsAlert` dedups on exact text and a per-customer message would defeat it entirely while growing an unbounded per-customer map; attribution lives in the log, and the residual is ~60 alerts/hour in a sustained outage, the platform default. **Measured baseline: zero occurrences across 1,091 boots since 2026-05-11**, with the capture path proven by `[wx-sec]` appearing in the same file. **Plus two RULES:** a mutation must assert it actually modified the source before its red counts as evidence — the CRLF anchor matched nothing and produced ten red lines that proved nothing, the THIRD occurrence of "a run that looks like proof and is not", alongside the two comment-blind matching entries; and an assertion that counts occurrences file-wide is a global assertion wearing a local name, which unrelated correct work will break. A fix, a deploy and two rules; nothing reversed, hence a patch.

2026-08-11 · v4.26 — §24 Database: **local backup retention — HOURLY 24 to 12, DAILY STAYS 30**, reclaiming a measured 5,107,765,248 bytes. Records WHY the hourly tier rather than the larger daily one: **the off-site OSS tier also retains 14 days, so cutting local daily to 14 would leave no recovery point beyond a fortnight anywhere**, on the box or off it — depth of history and density of history are not interchangeable and only one of them has a second copy. **Records the trend finding that makes cleanup insufficient: 16 of the 30 daily slots still hold July files 100-220 MB smaller than today's, so with the database FROZEN the disk still reaches 90% in 20 days.** That growth is already committed. The ~776 MiB of reclaimable junk buys about three days. **Records that `/root/scripts` is NOT in git and is lost on a box rebuild**, with an inventory of what now lives there, and the same for the journald cap. **Separates the two backups, which both fired at 03:00** with a combined ~2.07 GiB transient on one filesystem while `db-backup.sh` read free space before the other job had taken its share. Records how this fails FIRST — at 94.6% the off-site backup refuses to start and pages, so backups stop a day before anything else breaks. **OPEN with a deadline: `db-backup.sh`'s prune step cannot report its own failure** — `|| true` on the listing, a failed delete that only warns, and `PRUNED` never written to the log, so a healthy run and a broken one are byte-identical. Today it is genuinely healthy, verified by evaluating the expression rather than reading the log line. **The first real prune falls due 2026-08-18 and the fix must land before then**, or its first live execution is also its first untested one. A decision, a measurement and a dated open item; nothing reversed, hence a patch.

2026-08-10 · v4.25 — §24 Database: **THREE PHASES, and the five-phase reading is RETIRED.** Records where the five came from — not from conversation but from this section's own ROLLED OUT IN PHASES list, under which the switch is 4 and backups are 5 — and why that is WRONG rather than merely not-preferred: **it places backups after the flip, and Phase 2 exists precisely to hold what must be true before a flip is survivable, so the ordering inverts the one sequencing decision the phases were created to protect.** Names the single thing the two readings disagree about — which side of the switch the safety net sits on. **Also AMENDS the 2026-08-09 authority entry in place, on the v4.11 precedent**: it claimed the numbering "existed only in conversation" and took ground it described as empty, when a derivable five-phase reading was already there in its own cited source; a superseded decision is worth leaving visible, a false account of what a decision replaced is not. The three definitions are unchanged and were never in doubt. Five carriers of the old reading are marked superseded and left readable with a pointer — two in this record, one version-history line, and both memory blocks, which had it filed as an open question. A decision plus an in-place correction; the definitions are not reversed, hence a patch.

2026-08-10 · v4.24 — §24 Database: a RULE is recorded — **a lease computed at push time is not a lease.** A safety check on a shared branch must compare against a state somebody actually looked at; a check that re-reads the remote at the moment it fires compares the remote against itself and agrees with whatever is there, including work that arrived while this work was being written. Stated as the property rather than as a command, so it survives the tooling changing: **the value being protected has to be captured before the work starts and then quoted literally.** Records the occurrence it comes from — three commits from a concurrent session were discarded by a forced push and recovered from their own branch, nothing lost, the recovery merge touching `docs/` only and causing no restart — and records that the recovery was possible only because the discarded commits were still on a branch, which is a property of that day rather than of the method. A rule; nothing reversed, hence a patch.

2026-08-09 · v4.21 — §24 Database: **integration credentials — the DATABASE WINS, on absence as well as presence.** The clear path was reversible by `.env`: hydration's `if (!r) continue` treats a cleared credential's missing row as nothing to say, so a revoked credential came back at the next restart. **Fixed by commenting out four `.env` lines, not by changing hydration** — exactly coextensive with the defect, reversible, and no behaviour change today because those rows already win at boot. **Records why the hydration change was REJECTED, and the reason is about the flip: after the cutover an empty `SELECT` can mean "a row exists and this account cannot see it" under row-level security, so clearing-on-absence would silently delete a live credential on a policy mismatch** — and would also destroy the fresh-box bootstrap path. **Corrects the premise this started from: FOUR of the 23, not all** (`JD_API_ENV` is not in `.env` either, so four of JD's own five; the other five services have none). Records the `JD_JDL_*` footgun — a different system, three lines below, caught by any edit that matches "JD" by pattern. **OPEN: `nuonuo` is missing from the hydration map entirely** — 19 of 23 covered, same silent-vanish shape, latent only because the service has never been configured; its own commit. **CARRY TO PATH A: hydration is synchronous work at module load and cannot survive `pg`** — it becomes async work that must complete before the first request, a window that does not exist today. A decision, a correction and two carried items; nothing reversed, hence a patch.

2026-08-09 · v4.20 — §24 Database: **`PUT /integrations` was not atomic, and it is FIXED and deployed at `00f755f5`.** Its transaction body wrote `process.env`, which no rollback can undo, so a failed save discarded the rows and kept the environment change. Fixed by lifting the mirror out to after `tx()` returns; **not converted to `withTransaction`, so the fix and the conversion stay separable.** `routes/retail.js` stays at 30 blocks. Records the failure mode in plain terms — the save appeared to work and genuinely worked, then boot hydration loaded the old value at the next restart and the credential silently vanished, with no error at any point — and the residual risk with it: a crash between `COMMIT` and the mirror leaves env stale until restart, at which point hydration loads the committed value and it self-heals, which is strictly better than a permanent divergence healing to the wrong value. **Also records a SECOND occurrence of a class already in this section: A COMMENT ANSWERED FOR THE CODE.** The suite's own source-level guard matched `process.env` inside the comment "no `process.env` touch", the same mechanism as the harness's comment-blind `FOREIGN KEY` strip. Stated as intent rather than as a second anecdote — **any source-level assertion must strip comments before matching** — and noting what makes this one worse: it made a red run look correct while two of its three failures were false. A fix, a deploy and a rule; nothing reversed, hence a patch.

2026-08-09 · v4.19 — §24 Database: a SIGNPOST, not a finding. Names the three poll routes so the v4.10/v4.11 phrase "the poll gate" cannot be read as covering the customer vote route. The gate proven on live traffic is the ADMIN pair, `POST /api/retail-admin/polls` and `PUT /api/retail-admin/polls/:id`, on `withTransaction` since batch 2; the customer route `POST /api/retail/polls/:id/vote` is still on `db.transaction()` and is the one flagged in v4.18 for reclassification because it writes `points_balance` and the points ledger. Both statements are true and are about different code. v4.11 is correct and is not edited. A pointer only; nothing reversed, hence a patch.

2026-08-09 · v4.18 — [**AMENDED BY v4.25, 2026-08-10** — this line's "for the first time" and "existed only in conversation" are the claim v4.25 corrects: a five-phase reading was derivable from §24's own ROLLED OUT IN PHASES list, and this entry replaced it without saying so. The three definitions below stand unchanged.] §24 Database: **the phase numbering is defined in the record for the first time, and this entry is the authority for it.** Records that Phase 1 was defined once, Phase 2 appeared once and only as a negative, and Phase 3 appeared nowhere — so the numbering everything has been planned against existed only in conversation. Phase 1 is quoted unchanged. **Phase 2 is the async conversion against SQLite PLUS every operational prerequisite, and it ends only when the code runs on either driver AND backups, rollback and the runbook exist.** Phase 3 is the switch alone. **States explicitly that backups, the rollback plan and the cutover runbook are Phase 2 and not Phase 3, because they must exist before the flip and everything in Phase 3 happens on the day.** Maps the Path A steps onto the phases — steps 1–3 and step zero inside Phase 2, step 4 is Phase 3 — and states that the numbering does not replace them. Earlier unnumbered "later phase" text is superseded by this entry rather than edited. **Also a RECORD CORRECTION: batch 1's commit message `d7515a36` claims Path A step 2 is already on main, and it is not** — five of six dual-context helpers plus `reserveForOrder` still take no handle, and `tacet-checkout-transaction-design.md` v2.0 has it right; git history is not rewritten. **And three pieces of owed Phase 2 work recorded nowhere else:** 73 of the 103 runtime transactions live outside `routes/retail.js`, including two money helpers in `lib/inventory.js`; there are FIVE step-2 routes, not four, because `POST /api/retail-admin/orders` mints an order number and has never been classified; and `POST /polls/:id/vote` is classified safe inline while writing `points_balance` and the points ledger, so it must be reclassified before conversion. Definitions, a correction and owed work; nothing reversed, hence a patch.

2026-08-09 · v4.17 — §24 Database: **the PostgreSQL database is backed up for the first time, merged at `7b3ce893`.** Records that until this merge Postgres had NO backup of any kind — both cron jobs were SQLite-only while the verified 364,666-row copy sat on the box unprotected — and that the cluster-level roles file, 795 bytes, is what makes the dump restorable rather than 310MB that errors 304 times. Records the restore rehearsal and what it proved, including that it restored from objects downloaded back out of OSS rather than from the local originals. **Records the limitation plainly: the rehearsal ran in the SAME cluster, so `roles.sql` applied `ALTER ROLE` and never created `tacet_app` from nothing — fresh-cluster role creation is UNPROVEN, and the new-box case is precisely the disaster case.** Also corrects the recorded size of `/root/backups` from 15G to **19G measured**, and records that ~1.57G of it is under no retention policy at all, with `deploy-*` accumulation having no pruner. A build, a proof, a named gap and a record correction; nothing reversed, hence a patch.

2026-08-09 · v4.16 — §24 Database: **`withTransaction` misread an unrelated concurrent caller as nested, and it is FIXED and deployed at `dc91e62f`.** The helper set nesting depth on the SHARED HANDLE before awaiting the body, so a request arriving while another's body was suspended read that flag and was folded into the in-flight transaction: two independent requests, one `BEGIN`. Records both corruption modes as reproduced — a correct request handed `no such savepoint: tacet_sp_1` and losing its write, and a rolled-back write committed by an unrelated transaction's `COMMIT`. Records why it survived four conversion batches: the existing concurrency test made both calls **in one synchronous block**, where neither body had started, so both were correctly outermost — it pinned a real property but not this one. States the general lesson as a rule: **a concurrency test whose calls originate in the same synchronous block is not testing concurrency.** Records why it never bit — every converted body is synchronous, held there by a TEST rather than by the helper — and that the checkout could not have stayed synchronous, so this would have gone live with the money cluster. The fix moves nesting into the async context and removes per-handle depth entirely; the serialiser is byte-identical. **Carries forward one unresolved half of the design finding: `acquire()` still keys its queue on the handle, so at the PostgreSQL flip the queue must be scoped to the checked-out connection.** A repair, a rule and a carried-forward requirement; nothing reversed, hence a patch.

2026-08-09 · v4.15 — §24 Database: the shadowed `/shipments/split` route is FIXED and deployed at `85f5bffa`. Records that "Ship part later · 分批发货" worked from 2026-06-06, was used nine times, and was silently shadowed on 2026-06-14 by a commit whose message was entirely about an Orders-list column — leaving it **live and destructive-on-success for eight weeks**, reporting a follow-up parcel while deleting every parcel on the order. Records the general lesson as a rule rather than an anecdote: **a duplicate route registration silently wins or silently loses, and Express reports neither**, at startup or at runtime — with the split-merge suite's no-duplicate-path assertion named as the tripwire for the next one. Also records the harness thinning as a **THIRD occurrence across three consecutive batches**, and makes the written-column assertion **non-optional** for every batch from here. A fix, a rule and a standing requirement; nothing reversed, hence a patch.

2026-08-09 · v4.14 — the MINI APP PUBLISH PIPELINE is recorded as a new section: it may not exclude files from the bundle by dependency graph. Records the failure that produced it — a published checkout page that rendered nothing because a module added two days earlier was left out of the upload while the file sat correctly on main and in every working tree, with no build error anywhere. Records why this class of exclusion is uniquely bad: it is silent at build time and total at runtime, it fails on exactly the newest code, and the evidence a reader reaches for first — the repository — shows the file present. Both flags are turned off in configuration and the reason is written into the file that holds them. Related documents moves down one number; nothing cross-references it. Drafted as v4.13 and renumbered on merge, the batch 4 entry below having taken that number first. A new decision, nothing reversed, hence a patch.

2026-08-09 · v4.13 — §24 Database: Path A step 3 — the FOURTH conversion batch is merged at `785ff599`, taking `routes/retail.js` 39 → 30 by AST. Records a FINDING that is not about transactions at all: `POST /orders/:id/shipments/split` is **registered twice**, and the second registration — the "ship part later" to-follow split — has been unreachable since 2026-06-14. **Corrects a claim made in the batch's own commit message, that it had never executed: it ran nine times between 2026-06-06 and 2026-06-08**, before the shadowing registration landed. Records that the reachable handler **ignores `item_ids` and rebuilds every parcel**, answering a to-follow request with success rather than a rejection, and that no operator has hit that path in production. Also records the shared harness failing a SECOND time in the same class — `addForkedStoreProducts` mirrors `products` but never replayed the twelve `addColumn('store_products', …)` calls that exist only on the fork — and names the class rather than the two incidents, with the written-column assertion as what now catches it. Plus a third harness defect, a comment-blind FOREIGN KEY strip that made `retail_order_items` unbuildable, and its fix. A build, a finding and two harness repairs; nothing reversed, hence a patch.

2026-08-09 · v4.12 — §24 Database: Path A step 3 — the THIRD conversion batch is merged at `86a37ad4`, taking `routes/retail.js` 44 → 39 by AST, with the points-invariants check and the `reset_test_orders.js` hardening bundled into the same deploy. Records why the batch is five of sixteen (red-proven-per-conversion is the binding constraint), why `PUT /integrations` is excluded on its merits (its body assigns `process.env`, which no rollback can undo, so it is not atomic today), and that the count guard now reads the AST authority after a regex fallback was written, found to return 0 against an actual 39, and removed rather than patched. **Flags the `reset_test_orders.js` hardening as NOT VERIFIED** — guards 2 and 3 have never executed, and remain unproven until run on the box against a FIXTURE database. Also records a FINDING: the reported duplicate row on the admin Categories screen cannot be produced by the current code or data — the rail renders `category.tree` alone, the header counts tree entries, the stored tree has seven with no collision and was last written 2026-07-13, and the customer shop matches products to tree names exactly, so it is not a live retail problem. Logged as unreproduced rather than explained. A build, a proof, a flag and a finding; nothing reversed, hence a patch.

2026-08-09 · v4.11 — RECORD CORRECTION in §24 Database, the same day as the entry it corrects: the batch 2 record claimed TWO live gates proved the conversion. Only ONE did. The category-rename rejection came from `PUT /category-tree` — a route deliberately EXCLUDED from the batch and still on `db.transaction()` — whose duplicate check is a pre-flight 400 raised before any transaction opens, not the UNIQUE catch in the converted `PATCH /categories/:id`. The poll-votes gate stands and remains the first converted transaction body proven on live traffic. Corrected in place on the v4.8 precedent: a false proof claim misinforms every later reader, where a superseded DECISION at least records how the thinking moved. Also records a related FINDING — a reported "Ready to Eat" / "ready to eat" duplicate does not exist (it is one category seen through two columns, 20 by `top_category` and 16 by `category`) but IS constructible, because `category.tree` checks case-insensitively while the `categories` table's `UNIQUE(kind, name)` carries no `COLLATE NOCASE`. A correction plus a finding, nothing reversed, hence a patch.

2026-08-09 · v4.10 — §24 Database: Path A step 3 — the SECOND conversion batch is merged at `9e96263d` and is the FIRST converted transaction body proven on production traffic, by a live smoke test of the two gates most likely to break. Records the ten routes, the shared-harness defect the batch exposed (a type pattern that silently dropped three columns these routes write, which would have made the suite green and wrong), and the count moving 54 → 44 in `routes/retail.js` by AST. Notes explicitly that batch 1's two bodies remain UNPROVEN on live traffic. Corrects the batch's own commit message, which said 45 from grep. A build plus a proof, nothing reversed, hence a patch. Numbered 4.10 rather than 5.0 deliberately: in this record a major bump means a decision was REVERSED, and nothing here reverses anything.

2026-08-09 · v4.9 — §24 Database: a FINDING is recorded — `scripts/` is deploy-allowlisted, so twelve scripts that delete production rows ship to the box on every deploy, including `reset_test_orders.js`, which deletes customers, orders, payments, points transactions and wallet top-ups on unbounded substring selectors and accepts `--apply` on first invocation. Records two opposite defaults in one directory (four fail closed, seven fail OPEN), and marks a MIGRATION HAZARD as required pre-cutover work: that script's backup is a `copyFileSync` of the SQLite file and will not fail loudly after the PostgreSQL cutover. Also records orders 1–180 as gone and UNEXPLAINED — an earlier attribution to `reset_test_orders.js` is withdrawn as unsupported. A finding plus a forward requirement, nothing reversed, hence a patch.

2026-08-09 · v4.8 — RECORD CORRECTION in §26 Language: the mechanism is MERGED, not pending merge. It merged hours after the section was written, so the clause was true when written and false the same day. Corrected in place rather than left standing: a stale merge status misinforms every later reader, where a superseded decision at least records how the thinking moved. The replacement also says what a merge does NOT do — the mini app reaches customers only on a republish. A factual correction, not a decision, hence a patch.

2026-08-09 · v4.7 — LANGUAGE is recorded as §26: the customer's own language choice governs every customer surface, per viewer and not per merchant, carried by an `x-lang` header with `?lang=` as a fallback and English on absence, with no auto-detection. §23 loses the customer half of its open languages question and keeps the admin half. §0's LANGUAGE IS PER BUSINESS becomes LANGUAGE IS PER BUSINESS TO OFFER, PER VIEWER TO READ — the original sentence is kept intact as the middle clause, so nothing already decided is rewritten and only the headline stops claiming more than the bullet says. Related documents moves from §26 to §27; nothing cross-references either number. Records one known gap against the new rule — frozen delivery slot labels — as a gap rather than an exception. A new decision, nothing reversed, hence a patch.

2026-08-09 · v4.6 — §24 Database: Path A step 3 — the transaction helper is built, proven on both SQLite drivers and committed UNUSED, so that a flaw cannot propagate into all 56 `routes/retail.js` transactions at once. Records why it issues BEGIN/COMMIT/ROLLBACK itself rather than using `db.transaction()` (which commits and does not roll back after an `await`, measured on the real driver), why per-handle serialisation is load-bearing rather than an optimisation, and two things it does not cover: `.immediate()` and the PostgreSQL backend. Corrects the entry's own draft date from 08-08 to 08-09. A decision plus a build, nothing reversed, hence a patch.

2026-08-08 · v4.5 — §24 Database: Path A step 2 settled — all six dual-context helpers take the database handle as an argument, one rule with no exceptions, because the read-only-versus-writing grouping is a trap (productContentSnapshot must see uncommitted state). Also records an unwrapped multi-write CMS handler as a latent bug. A decision plus a finding, nothing reversed, hence a patch.

2026-08-08 · v4.4 — §24 Database: two more grep-derived figures corrected — runtime `db.transaction()` blocks are 129 not 131 (two hits were comments), and the terminal-call counts were by-name totals that include `Map.get()`/`RegExp.exec()`, so database terminals are ~2,572 not 3,310. `scripts/diagnose_async_conversion_scope.js` is recorded as the authority for these counts. Corrections plus a tooling record, no decision reversed, hence a patch.

2026-08-08 · v4.3 — §24 Database: the v4.0 route-handler async figure is corrected (756 handlers, 72 async — not 761/4), and `routes/retail.js` is surveyed for the Path A conversion, including a STEP ZERO prerequisite: Express 4 does not catch async-handler rejections and 207 handlers have no try/catch, so an asyncHandler wrapper must be adopted before any call site moves. Corrections and a survey, no decision reversed, hence a patch.

2026-08-08 · v4.2 — §24 Database: a requirement is recorded that NO account may be special-cased in the new shared-database scoping, including Roots. The existing id-based exception is left in place deliberately, because it lives in the file-per-account machinery being deleted. A forward requirement, not a decision reversal, hence a patch.

2026-08-08 · v4.1 — RECORD CORRECTION in §24 Database: TENANT_DATA_ISOLATION is set to 1 on the live box, not off as stated above. It is set in the gitignored .env, which is why a repo-only reading missed it. The per-account isolation path is ARMED BUT UNUSED — zero active non-Roots accounts, zero open per-account files — so live behaviour is unchanged. A factual correction, not a decision, hence a patch. The superseded lines are left standing.

2026-08-08 · v4.0 — THE CUTOVER SEQUENCING IS REVERSED: the Postgres switch cannot be a config flag, because better-sqlite3 is synchronous and pg is not. The data layer converts to an async contract against SQLite FIRST, and the flag comes last. Recorded in §24. This corrects the order of the whole cutover — which every earlier entry assumed without stating — hence a full revision rather than a patch. No earlier entry is edited; the superseded sequencing is left standing.

2026-08-08 · v3.3 — §24 Database: the read-side money converter is DECIDED — convert by driver-returned type (Postgres numeric, OID 1700) with a value-size guard, registered once globally at module load, and explicitly not a hand-maintained column list. A second entry records `retail_vouchers.value` as polymorphic money outside the money set, not fixed. A decision plus a recorded gap, neither reversing anything, hence a patch.

2026-08-08 · v3.2 — §24 Database: the in-SQL arithmetic money writes are resolved as safe under decimal, closing the open mechanism question left by the 2026-08-05 structural limit. Eight distinct statements, none needing intervention. An open question closes and no decision is reversed, hence a patch. The superseded entry is left standing.

2026-08-08 · v3.1 — two additive records in §24 Database: the converter install-point is resolved as a non-issue rather than an ordering problem, and the 2026-08-06 decimal data copy is written down. No decision is reversed, hence a patch rather than a full revision. The superseded row-count figure is left standing.

2026-08-06 · v3.0 — the money decimal SCALE is settled at `numeric(14,6)`, and `expense_entries.amount` is reversed back to decimal from whole cents. A scale decision plus a reversal, hence a full revision rather than a patch. Both recorded in §24; the superseded lines are left standing.

2026-08-05 · v2.1 — vocabulary only: one line in §9 now says "the multi-business move" instead of "the multi-tenant move", per the retired "tenant" glossary term. §24 is untouched — its dated standing entries are not rewritten.

2026-08-05 · v2.0 — MONEY STORAGE IS REVERSED: money is stored as DECIMAL, not whole cents. A locked technology decision changes, hence a full revision rather than a patch. Recorded in §24; the superseded line is left standing.

Cross-references in this document give both the section number and its name. If the two disagree, the NAME is correct — numbers shift when sections are inserted.

2026-07-30 · The app previously called the kitchen app is now the PRODUCTION APP. The KITCHEN flag on a location, kitchen locations and code identifiers keep their names.

2026-07-31 · The front end previously called the STOREFRONT is now the ONLINE STORE. Code identifiers, filenames and directories — `shop.html`, `miniapp/` and the like — keep their names.

---

## 0. Governing rules — these override everything below

These three rules govern every decision in this document and every decision made after it. Where anything in this document conflicts with them, these rules win and the conflicting decision is wrong.

1. FULL CIRCLE NO LONGER EXISTS. The name is retired completely. The system is Tacet. Any remaining Full Circle naming in code, documentation, UI or configuration is a defect to be removed.

2. TACET IS NOT BUILT FOR ROOTS. Roots is one customer that happens to be first. Nothing about Roots' business — its products, its city, its language, its currency, its sales channels, its suppliers, its way of working — may be assumed, hardcoded or treated as the default.

3. TACET IS A MULTI-BUSINESS PRODUCT. Businesses of any kind, in any country, must be able to register and use it. Every feature, every setting and every proposal must be evaluated against a business that is nothing like Roots.

### Consequences already identified
These follow directly from the rules above and correct earlier decisions in this document:
- SALES CHANNELS ARE NOT A FIXED LIST. The channel list recorded earlier (WeChat, Web, POS, Meituan, Eleme, GZ Grocery, Manual) is Roots' channel list, not Tacet's. Channels must be configured per business, with integrations offered as available options. GZ Grocery in particular is specific to one customer.
- CURRENCY IS PER BUSINESS. The codebase currently hardcodes CNY and the ¥ symbol in hundreds of places. This is a defect.
- UNITS OF MEASURE ARE PER BUSINESS. Grams and kilograms may not be assumed. A business using pounds and ounces must be equally well served.
- LANGUAGE IS PER BUSINESS TO OFFER, PER VIEWER TO READ. A business decides which languages it supplies content in: English-plus-Chinese may not be assumed or required, a single-language business must not be forced to supply two names for everything, and a business using two other languages must be supported. Which of the offered languages a given person is SHOWN is a separate question, answered per viewer and not per business — on the customer surfaces that is settled in §26 The customer's own language choice governs every customer surface. The admin surface is still open, in §23 Open questions.
- Already consistent with these rules, recorded for clarity: the business time zone is a per-business setting derived from the signup address, and the hardcoded category seed tree is being deleted rather than kept as a default.

### Standing test
Before any design decision is accepted, it must be checked against a business unlike Roots — for example a hardware shop in Ohio, or a bakery in Lisbon. If the decision only makes sense for a vegan food business in Guangzhou, it is wrong.

## 0.1 Domains and app structure

### Domains — DECIDED
Everything lives under tacet.com as a subdomain.
- `app.tacet.com` — where business users work. The Tacet app, Production, and Account settings all live here. ONE domain; moving between them never changes the domain.
- `backoffice.tacet.com` — Tacet staff only. Separate login and a hard wall: nothing internal may leak into a customer-facing screen.
- `shopname.tacet.com` — the address of an account's ONLINE STORE, issued automatically at signup. The account may attach its own domain later, at which point customers see that instead. Customers should not see Tacet's name on an online store the account has branded.
- `tacet.com` itself is reserved for the marketing site and is not an application host.

Current state, for contrast: four separate hosts today — the store console, the production app, the internal console, and per-account online stores — with the server deciding what to serve by Host header. This grew by accident, one host per app.

### Sections are paths, not hosts — DECIDED
Within `app.tacet.com`, everything is a path: `/orders`, `/products`, `/account/invoices`. One login, one session, no reload into a different application.

### Iframes — DECIDED
- NO NEW IFRAMES. New sections are built as paths within the app.
- Existing frames (Account, the product editor, the CMS) are left alone until other work brings someone into those files. This is not a cleanup project.
- Reasons: a framed section breaks the browser Back button, cannot be linked to directly, and forces a second copy of the styling and translation layer around it. Account demonstrates the cost — it is a standalone application with its own colour tokens and its own translation engine, which is why it looks like a different product.
- This directly conflicts with the module principle: a module is built once and used everywhere, and an iframe forces duplication of everything surrounding it.
- Most sections are NOT iframes today. Orders, Products and the rest are blocks within one page, shown and hidden. Only Account, the product editor and the CMS are genuinely framed.

### Account folds in — DECIDED
Account settings stop being a separate framed application and become part of the Tacet app, reachable the same way from any app. This is real work, not a configuration change: the current Account is a standalone four-pane application with its own token set and its own i18n engine.

## 1. Architecture — LOCKED 2026-07-31

### Front end
FOUR front ends. The front end is the ONLY app-specific layer; everything beneath is shared.
- TACET — the main app. Staff.
- PRODUCTION — staff. Merges into Tacet later, leaving three.
- ONLINE STORE — customers. One shop per account, appearing as a website and as a WeChat mini-program, with further surfaces possible later. All surfaces show the same shop; an account configures it once. Read-only with respect to the modules.
- BACK OFFICE — Tacet staff only.

### Back end
- ONE service, ONE API. Not one per app.
- A set of SHARED MODULES, each built once. Eight named so far: Locations, Products, Items, Stock, Users, Orders, Purchasing, Recipes. MORE WILL BE NAMED — eight is not a ceiling. Already visible but not yet specified: suppliers, customers, marketing, content and media, integrations, reporting, billing.
- Every module is available to any front end. Which modules a front end uses depends on what that front end is for, not on staging. Production uses Items and Recipes; Tacet does not, because selling does not involve them. The online store reads Products, Stock and Locations and writes nothing. This does not change when the apps merge — the modules were always shared; the split was only ever in the interface.
- Permissions are capability-based and enforced in the back end.
- FRONT ENDS NEVER TOUCH THE DATABASE. A screen asks the back end; the back end reads the database.

### Database
- ONE database. Each thing exists in it exactly once. No duplicated tables, no sync jobs between them.
- Money stored as whole cents, never as a decimal.

### Technology decisions — LOCKED
1. FRONT END IS EXTENDED, NOT REBUILT. Screens are rebuilt one at a time as each stage reaches them. No wholesale rewrite — it would stop everything for months. Current state: hand-written JavaScript in very large files, one of 28,000 lines.
2. SQLITE STAYS through the consolidation. Revisit before a second business, not during. Changing the database engine and the data model at once doubles the risk. FLAG: SQLite permits one writer at a time. Adequate for one account; a genuine question for several. To be TESTED before onboarding a second business, not assumed either way.
3. ONE SHARED DATABASE STAYS FOR NOW; per-account databases are not adopted. FLAG WITH A DEADLINE: the per-account isolation switch is currently what locks every non-Roots account out of the app. This decision holds only until the open-signup stage, where it must be resolved.
4. THE ONLINE STORE REMAINS PART OF THIS SYSTEM. Not split into a separate service. Separating it would require an API between them and a second deployment.
5. THE BACK OFFICE IS BUILT PROPERLY AT THE OPEN-SIGNUP STAGE, not before. It half-exists today as a separate login and two consoles.

## 2. Permissions

- Permissions are per-capability, not per-frontend. A user holds capabilities; each frontend shows what that user's capabilities allow.
- Reason: a per-frontend model would have to be unpicked when the two apps merge into one interface. Capabilities survive the merge unchanged.

## 3. Items and products — CORRECTED, supersedes v0.1 §3

v0.1 stated one table with a SELLABLE switch. WITHDRAWN. The correct model:

- TWO separate lists. ITEMS and PRODUCTS are different entities with different tables and separate stock.
- ITEMS: kitchen only. Raw materials and anything produced for use in further production. Never sold. Never visible to Tacet.
- PRODUCTS: sold to customers. Visible in both apps.
- There is NO sellable switch and no shared table.
- The bridge between the two is a RECIPE. Packing is production: bulk item in, product out.
- Worked example the model must support exactly as described: buy cashews (item) → produce cream (item) → produce cheese (product, from cream) AND pack cream into jars (product, from cream). The kitchen's bulk cream and the store's jarred cream are genuinely different things with separate stock. This is intended, not duplication.
- Confirmed: the store never sells directly from a kitchen container. Everything sold is packed first.

## 4. Product fields

Applies to the PRODUCT record only; items are kitchen-only and need no such split.

- Every field on the merged record is classified into exactly one of three groups: KITCHEN, STORE, or BOTH.
- KITCHEN = production, recipes, costing. STORE = selling and presentation. BOTH = shared, e.g. nutritional facts.
- Shared (BOTH) fields are editable from BOTH apps. There is no single owning side. DECIDED — do not reintroduce field ownership.
- The classification itself is pending the tacet-product-fields.md inventory.
- DIETARY INFORMATION IS CONSOLIDATED. DECIDED. It currently lives in four places — `nutrition`, `free_of`, `product_facts`, and blocks inside `description_blocks`. One dietary record per product; description blocks read from it rather than holding their own copy. Done as part of the Products stage; note it migrates content customers see.
- NO COST COLUMN EXISTS on either product table. Cost reaches a product only through `recipe_id`, which is dead on the store side. No product has a cost and margin cannot be computed at all. The cost method question therefore has nothing to decide against until a cost field exists.
- `needs_ice_pack` IS KNOWINGLY BROKEN. It is read live at checkout and decides the shipping label, but no screen can set it, so everything created since it was retired is permanently "no". DECIDED: not restored for now. Do not trust this field and do not build on it.

## 5. Concurrent edit safety

Because shared fields are editable from both apps, the merged product record must carry:

- A version stamp. On save, the server verifies the row has not changed since the client loaded it. On mismatch, reject the save and return a plain-English message telling the user the record was changed by someone else and to reload. Never silently overwrite.
- `updated_by` and `updated_at`, surfaced in the UI next to shared fields so a user can see who last touched them and when.

This supersedes the alternative of assigning an owning side per shared field, and closes risk R11 from tacet-core-survey.md.

## 6. Production

- Multi-level, any depth. Real-world depth today is three levels.
- A recipe may produce an item or a product.
- Cost rolls up through levels.
- A production batch records ACTUAL quantities used, not recipe quantities.
- Confirming a batch is what moves stock: inputs out, output in. Nothing moves before confirmation.
- Recipe output is FIXED. A recipe states its output quantity and a batch produces exactly that amount.
- Recipe INPUTS are recorded as actually used. Output is fixed. These two rules differ deliberately.
- Consequence, accepted: if a real batch under-yields, stock reads high. A stock recount is therefore required on the production side, matching the recount the store side already has.
- Packaging is consumed by production like any other input. A packing step consumes bulk item plus jar, lid and label and produces a product. Cost rolls up through it; no separate cost sheet exists.

## 7. Units

- Every item has ONE stocking unit. Its stock is always counted in that unit.
- Purchasing may use any unit, with a conversion stored on the item. Example: 1 sack = 25,000 g; ordering 2 sacks raises stock by 50,000 g.
- Recipes always use the item's stocking unit. No conversion at recipe level, no rounding.
- Roots weighs liquids in grams rather than measuring in ml, so an item purchased in ml needs a per-item ml-to-gram conversion, entered once. Per item, not global — oils and syrups differ.
- Products are counted in whole units.
- SUBJECT TO §0: units of measure are per business. Grams and kilograms are Roots' choice, not Tacet's default. A business working in pounds and ounces must be equally well served.

## 8. Packaging

- Jars, lids, labels and bags are ITEMS. Bought, stocked, costed and TRACKED by quantity.
- Consumed by the packing step, so cost rolls up automatically.
- Displayed separately from ingredients on screen — ingredients in one group, packaging in another. One mechanism underneath.
- Reason for tracking rather than costing only: running out of jars stops production exactly as running out of an ingredient does.

## 9. Locations

- Locations is a Tacet CORE module, shared by both apps. Not owned by either.
- Who can do what is decided by capability, not by which app the user is in.
- Two kinds: PHYSICAL and TEMPORARY. This is about permanence only.
- KITCHEN is a FLAG, not a kind. Any location may also be flagged as a kitchen. CONFIRMED.
- WAREHOUSE is not a kind. A warehouse is a physical location with no sales channel attached.
- Sales channels may be attached to any location, including one flagged as a kitchen.
- TEMPORARY locations: can be closed, can NEVER be deleted. Closing requires remaining stock to be moved to a named location and confirmed by a user.
- PHYSICAL locations: can be closed and continue to hold and manage stock.
- Replaces `markets`, `retail_stores`, and the plain-text warehouse/store names on purchase and restock orders.
- The existing `markets` rows are archived, not migrated. Only the warehouse and the kitchen carry across, by hand.
- MARKET STALLS ARE NOT RETIRED. The business will run market stalls again as new TEMPORARY locations. The old rows are retired; the capability is not.
- TEMPORARY locations are therefore REQUIRED IN THE FIRST BUILD, including the close-with-stock-move-out flow. Not a later phase.
- `retail_stores` IS THE SURVIVING TABLE and KEEPS ITS EXISTING IDS. Nothing is renumbered. Location ids are referenced by plain integer columns with NO foreign keys (`users.market_id`, `users.retail_store_id`, `retail_orders.store_id`, `purchase_orders.store_id`, others), so reassignment would fail silently — the same failure that caused the product id problem.
- THE LOCATION CODE SURVIVES. Around twenty integration tables key off the `code` string rather than the id. Kept and treated like a product SKU: validated on creation, permanent, never reused. Generated by the system and NOT shown on the location form — it appears only in integration screens.
- Migrating those twenty tables off the code was considered and REJECTED — more correct in principle, materially more risk, no visible benefit.
- `markets.kind` carries no behaviour worth inheriting. PHYSICAL / TEMPORARY and the KITCHEN flag are new construction, not a migration.
- SUBJECT TO §0: the KITCHEN flag needs a business-neutral name. A hardware shop has no kitchen. Rename pending.
- `meituan_stores` IS RETIRED, as part of the Orders stage. DECIDED — supersedes the earlier open question about folding it in or renaming it. It exists only so the Meituan tab can split takings by shop; that job is done properly by locations plus the Meituan channel plus one order record. It is read-only, populated solely by a manually run import script, and surfaces in exactly one place: the production app's Sales screen, Meituan tab.
- CARRY OVER WHEN RETIRING IT: the data is Meituan SETTLEMENT data — what Meituan actually paid. The live Meituan connection does not handle settlement; it handles stock and orders. The settlement import must land against a real location and the Meituan channel, in the single order record.
- Meanwhile the production app shows two lists both labelled "门店 Stores" — one editable (`retail_stores`), one not (`meituan_stores`) — with no visible link. Retiring this resolves it.
- SAFE CLOSING DOES NOT EXIST TODAY. Both deactivation paths are a bare `is_active = 0` with no stock check and no move-out. Deactivating a retail store leaves stock present but invisible and leaves user bindings pointing at it. The move-out-and-confirm flow is new build.
- Independent of the consolidation: the retail deactivation path should unassign its users, which the markets path already does.
- ONE FORM. Five separate screens currently create or edit a location, each with a different field set, so what a location holds depends on where it was created. The module provides ONE form used everywhere; other screens link to it rather than carrying their own.
- CLOSURE STATE MUST HANG OFF A LOCATION'S IDENTITY, NOT ITS CODE. Three switches mark a location closed and only one of them joins on the location itself: `retail_stores.is_active` on the row, `store_business_status.fulfillment_open` keyed on `store_code`, and `channel_status.is_open` keyed on `(channel, store_code)`. Both of those keys are plain TEXT with no foreign key, and an ABSENT ROW MEANS OPEN by design — see `storeClosedStores` and `channelClosedStores` in `lib/inventory.js`, which are also the only join sites.
- CONSEQUENCE: changing a location's code silently REOPENS a closed location. The closure rows stop matching, absence reads as open, and nothing errors — the same silent-failure class as the plain-integer location references above.
- The mechanism is OPEN — foreign key, immutable id, or forbidding code edits outright. What is DECIDED is that a label a person can edit must not be the thing closure depends on. This does not reopen THE LOCATION CODE SURVIVES above: that decision makes the code system-generated and permanent, which is exactly the mitigation. The point is that the join must not RELY on it. Today the protection is accidental rather than designed — `code` is simply absent from the store update allowlist (`routes/retail-inventory.js`), so nothing in the app can change it. The multi-business move puts far more hands on that field than today, and accidental protection does not survive it.
- ONE HOURS FIELD CANNOT ANSWER THREE QUESTIONS. `retail_stores.open_time` / `close_time` are read by three consumers with nothing to do with each other: `resolvePickupTime` (the customer-facing collection window), and `lib/store-hours.js`, which drives both the Qingyun ops-alert muting and — since 2026-08-02 — the 外卖 and 闪购 daemons' polling windows. Written from the store editor (`public/retail-admin/02-settings-ops.js`) through `PATCH /api/retail-admin/stores/:id`.
- BOTH PRODUCTION ROWS ARE BLANK, AND THE BLANKNESS IS LOAD-BEARING. Verified in code and against the live rows 2026-08-02. Blank is what makes collection fall back to the global `pickup.window` of 10:00–20:00. Filling one in to control a daemon would silently narrow that location's customer collection window — at yuexiu, from 10:00 to 11:00.
- DECIDED: a location's trading hours, its collection window, and when its staff should be paged are three different questions with three different answers. One field cannot answer all three, and they need three separate settings. NOBODY POPULATES `open_time` / `close_time` UNTIL THEY ARE SEPARATED. Resolve at the Locations stage.

## 10. Stock

- ONE stock record per thing per location. Nothing else. Totals are computed by summing, never stored.
- ONE movement ledger. Every stock change writes to it.
- The store's existing model is ADOPTED as the core: physical quantity, safety buffer, per-channel caps, reservations, ledger. Do not design a replacement.
- RETIRED: `products.stock_qty` and `market_stock`. `market_stock` has not been maintained by any real process; its numbers are untrustworthy and MUST NOT be migrated. Kitchen and market locations require a physical count at cutover.
- PHYSICAL and AVAILABLE are different numbers. Every screen must state which one it shows.
- The safety buffer holds stock back from sale. Set by whoever runs production. The shop can only sell what is above the buffer.
- NEGATIVE STOCK IS ALLOWED. A transfer always applies in full. If the origin holds less than the amount sent, it goes negative and the shortfall is recorded. Chosen over refusing the transfer, because goods have usually physically moved before anyone reaches the screen. SUBJECT TO §0 — this is a business policy and must become a setting, not a system law.
- A negative balance is a SIGNAL, not an error: the count is wrong and a recount is due. It must appear on a list someone checks, not be buried.
- Stock must never be silently clamped. Today `adjustStock`'s delta path quietly applies less than requested and discards the shortfall — withdrawn.
- The codebase currently has THREE rules for going below zero (order commit has no floor; the delta path clamps and discards; channel ingest clamps and records). All three are replaced by the single rule above, unified during the stock stage rather than piecemeal.
- THE SAFETY BUFFER IS EFFECTIVELY UNBUILT. Verified in code 2026-07-31: no screen in any of the five surfaces exposes a control that writes it; the column defaults to 0 on every insert path; no migration or seed sets it. A non-zero value could only exist via a hand-crafted API call or direct SQL. The API accepts the field and `upsertStockLayer` writes it, but nothing in the shipped front end sends it.
- CONSEQUENCE: the three channels not applying the buffer (Meituan, Eleme, Guanyi) are not overselling today, because nothing is being held back. That fix moves into the Stock stage rather than being urgent.
- WHEN BUILT: the buffer needs a screen, and every channel must respect it from day one. Default zero. The control should be hidden unless an account turns it on — many businesses will never need it, and multi-marketplace sellers will.
- HIDDEN RULE TO REMOVE: Purchasing substitutes 5 for a zero or unset buffer when computing its reorder point, server-side and again client-side. It never writes 5 back. So the Purchasing screen can display 5 while the stored value is 0. This is exactly the kind of baked-in business rule §0 forbids.

## 11. Users

- ONE list of people. ONE login.
- What a user can see and do comes from capabilities, not from which account or app.
- Migration: the two existing user lists both number from 1, so ids collide. Ids must be reassigned and every historical reference repointed. Flagged as careful, high-risk work.
- Fixes the existing gap where the activity log cannot record a store-side actor.

## 12. Purchasing

- ONE purchasing flow for the whole business. Same screen, same suppliers, same orders.
- An order line is simply: a thing, a quantity, a delivery location.
- Users see only what their capabilities and locations allow.

## 13. Sales record

- ONE sales record for the whole business. Every sale from every channel, written once, one shape.
- The kitchen's separate sales log is RETIRED, not consolidated. Confirmed: no kitchen-only sales exist.
- POS is REMOVED from the production app and becomes a sales channel like any other. A POS sale creates an order, moves stock, and lands in the sales record.
- Existing spreadsheet importers are repointed at the single record.
- A staff-created order MUST have a location. DECIDED. Today the field is optional; when left blank the order saves with no location, nothing routes it afterwards, and no screen can fix it, so it is permanently unfulfillable. The field becomes required, and a way to change an order's location afterwards is added.
- Fulfilment is by nearest location to the customer, computed from coordinates. Fulfilment priority survives only as a tiebreaker, not as the rule — confirmed by survey that it decides almost nothing once an address has coordinates.
- `ORDER_FULFILLMENT_TYPES` carries a third value, `counter`, that never reaches the customer path. Dead; delete it.

## 14. Channels

The agreed list, replacing two divergent sets of names:

- WeChat (mini-program shop) — absorbs the old `miniapp`
- Web (website) — absorbs the old `retail`
- POS — absorbs the old `dinein`
- Meituan
- Eleme
- GZ Grocery
- Manual

Channels are attachable to any location.

## 15. Time and dates

- Tacet is a product for multiple businesses. Nothing is hardcoded to Guangzhou.
- Each business has ONE business time zone, applying to every report and every "today".
- Set automatically from the address given at signup; changeable afterwards in settings.
- Business-wide, NOT per location, even for businesses spanning time zones.
- Displayed timestamps may render in the viewer's local time, always labelled with the zone.
- Business-day boundaries never follow the viewer's device.
- CONFIRMED BY SURVEY: no date or business-day calculation anywhere reads a per-location time zone; everything currently uses a fixed UTC+8. The only genuine consumer of `retail_stores.timezone` is collection-time validation at checkout. Making the business day business-wide breaks nothing.

## 16. Product state — replaces three overlapping flags

Today a product carries `status` (Active/Inactive/Seasonal/Coming Soon), `is_active` and `is_published`. All three are replaced by ONE state with three positions:

- IN SHOP — visible to customers
- NOT IN SHOP — still in use, not on display
- ARCHIVED — out of use, hidden everywhere automatically, retained in historical orders and reports

Archiving requires no other switch to be set first. Seasonal and Coming Soon are withdrawn as states; if wanted they become customer-facing tags, not states.

## 17. Item state

ONE state with two positions:

- IN USE
- ARCHIVED — removed from recipe pickers and purchase screens, retained in historical batches and orders

## 18. SKU on archive

- An archived product KEEPS its SKU permanently. The code is never released for reuse.
- Reason: a reused code makes historical orders and reports point at the wrong thing.
- This overrides the store side's current behaviour, which nulls the SKU on delete.

## 19. Categories

- TWO separate category systems with no overlap.
- PRODUCTS: keep the existing two-level tree (top category + subcategory). It is what customers navigate.
- ITEMS: their own separate category list, for finding things in the kitchen.
- DELETED: the legacy free-text `category` column on products, and the hardcoded fallback seed tree.
- Reason for separation: customer categories are shop navigation; item categories are a filing system. They would never share vocabulary.

## 20. Deletion policy

- Nothing with history is ever truly deleted. Everything archives.
- Archived things disappear from pickers and lists but remain visible in the historical records that reference them.
- People who leave keep their name on the work they did.
- SINGLE EXCEPTION: a record with no references anywhere may be hard-deleted — a mistake, a typo, a duplicate created minutes ago. The system must check for references before allowing it.
- This replaces today's inconsistent behaviour, where categories and kitchen users are hard-deleted with no reference check.

## 21. Modules — the shared components

Eight modules, each built once and used by any app:

Locations · Products · Items · Stock · Users · Orders · Purchasing · Recipes

- PRODUCTS and ITEMS are SEPARATE modules, matching the two-list decision. They must never be presented, grouped or built as one.
- ORDERS is a single module. An order is a sale; there is one record and reporting reads from it. There is no separate "sales" module.
- Not every front end uses every module. Items and Recipes are Production-only until the apps merge. Locations, Products, Stock, Users and Orders are used by both.
- FOUR front ends exist, not three: Tacet, Production, the customer-facing online store, and the Back Office. The online store is not a separately maintained app — it reads the same Products, Stock and Locations modules. What a customer sees is the same data staff edit, never a copy.

## 22. Rollout order and priority — REVISED 2026-07-31

CONTEXT: a second business is a TARGET, months away. No specific customer is waiting. Confirmed: no blackout periods, and nothing needs to jump the queue.

1. LIVE BUGS. Restock stock loss and the R1 id guard — FIXED (commit ff4c049a). Safety buffer not reaching Meituan, Eleme and Guanyi — STILL OPEN, live overselling. Catalogue showing a stock number checkout will not honour — handled in the Stock stage.
2. OPEN SIGNUP. The cheap multi-business blockers only: public signup, provisioning without a Roots admin, and removing Roots seed data so a fresh account starts empty. Contained, does not touch the consolidation.
3. LOCATIONS.
4. USERS.
5. STOCK. The floating-point money defect is FOLDED IN HERE, not done separately — those tables are being rebuilt anyway and a standalone migration would touch everything twice.
6. PRODUCTS AND ITEMS.
7. PURCHASING.
8. ORDERS. Includes retiring `meituan_stores` and the separate production sales log.
9. DEFERRED, after all of the above: multi-currency, additional languages, and the Production app merging into Tacet. These are entangled with everything being rebuilt; doing them first means doing them twice.

NEW ACCOUNTS START IN TACET. DECIDED, recorded as a decision rather than an assumption. To be revisited when Production can be sold on its own — a business that only manufactures would otherwise start in an app about selling to customers.

DO NOT ONBOARD A SECOND BUSINESS BEFORE STAGE 5 COMPLETES. Whatever is sold must be supported. A business arriving on the current model inherits two user lists, a forked catalogue and drifting stock, and unpicking that for two businesses is far worse than for one.

The PostgreSQL rebuild that stage 5 (Stock) depends on is specified in §24. The floating-point money fix folded into stage 5 happens as part of that rebuild.

## 23. Open questions — NOT DECIDED

- COST METHOD — still not decided, and now blocked: no cost field exists to decide against.
- Final PRODUCTION/STORE/BOTH classification of every product field — docs/tacet-product-fields.md now exists; classification not yet done.
- Whether `low_stock_threshold` and `supplier_paused` are store fields or operational fields Production also needs.
- The `tags` field: documented as dietary, now used as a display badge. Which it is, and whether it splits.
- Rules for the three worst contested writes identified in the product field inventory.
- A plan for scaling languages on the ADMIN surface. The customer surface is no longer open — see §26 The customer's own language choice governs every customer surface, which settles it per viewer and does not cover admin.
- A business-neutral name for the KITCHEN location flag.

## 24. Database: PostgreSQL, one shared database, row-level account isolation — DECIDED 2026-08-03

DECISION: The platform moves from SQLite to PostgreSQL. One shared database holds every account. Each row is tagged with the account it belongs to, and the database itself enforces that no account can read or write another account's rows.

WHY THIS SHAPE: Chosen over a separate database file per account. With one shared database and row-level rules, the database enforces the wall between accounts. The file-per-account approach relied on every query filtering correctly by hand — one missed filter leaks another account's data. Making the database the enforcer removes that class of mistake.

RETIRED: The old file-per-account isolation (lib/tenant-db.js, gated by the TENANT_DATA_ISOLATION env flag, off everywhere) is superseded by this decision and is deleted in a later phase. Do not build on it.

DONE IN THE SAME REBUILD: Recreating all tables in PostgreSQL is also when two already-locked rules are applied, because the tables are being rebuilt anyway and a separate migration would touch everything twice — (a) money stored as whole cents as an integer, never a decimal (fixes the known floating-point money defect); (b) the tenant→account rename across tables, columns and identifiers, per the retired "tenant" glossary term.

NOTE — money conversion is near-total but not universal. During the Phase 1 schema translation, 101 REAL money columns were converted to integer cents. Two categories were deliberately left unconverted: percentage columns, and one polymorphic column, retail_vouchers.value, which holds a money amount for fixed-amount vouchers but a percentage for percent vouchers. Converting it as-is would corrupt the percent rows. Decision: leave retail_vouchers.value unconverted in Phase 1; split it into separate amount and percentage handling at the Stock stage, where the money model is built properly. Also flagged for the later data-copy phase: one retail_vouchers row has a non-ISO date (2026/10/6) that must be fixed before data is copied across.

ROLLED OUT IN PHASES, LIVE BUSINESS NEVER AT RISK: Phase 1 installs PostgreSQL alongside the running SQLite app; nothing points at it yet. Adding the account column, routing queries through one enforcement gate, copying Roots's data across, the switchover, and backups all come in later phases. Roots keeps trading on SQLite throughout, and does not move until the new account has run on PostgreSQL first.

> **THE ORDER OF THAT LIST IS SUPERSEDED — 2026-08-10.** Left standing because it is where the five-phase reading comes from and a reader who meets that reading elsewhere needs to be able to find its source. Numbering the items above gives five phases with **the switch at 4 and backups at 5**, which puts the safety net after the flip. **Backups, the rollback plan and the runbook are Phase 2.** There are THREE phases: see THE PHASE NUMBERS (2026-08-09, as amended) and **THREE PHASES, AND WHY THE FIVE-PHASE READING IS WRONG** (2026-08-10), both at the end of this section. Phase 1 as defined in this paragraph is unchanged; only the ordering the rest of the sentence implies is retired.

WHAT THIS SERVES: The two-week goal — a second account live on Tacet plus their own web shop, both accounts sharing one PostgreSQL database and walled apart from each other, with Roots trading uninterrupted the whole time.

### Isolation is enforced by the database — DECIDED 2026-08-04

Row-level isolation is enforced by Postgres row-level security, not by hand-written query filters in application code. The database is the thing that blocks a cross-account read, so the wall holds even when application code is wrong. This is only possible in Postgres; SQLite cannot do it. That is why the Postgres switchover precedes the isolation work rather than following it — building the wall on SQLite first would mean building it twice.

### The account column is added staged, not all at once — DECIDED 2026-08-04

The account column is added to the unscoped tables module by module, following the locked consolidation sequence, rather than in a single migration across all ~140 tables. Each module gets its column and its row-level policy as that stage is reached. Rationale: each change stays small enough to verify against a live business, and no wall is needed on tables not yet reached — there is currently only one real account, so nothing can leak in the interim. Note this still requires a real schema-change mechanism; today schema changes happen via addColumn() calls in database.js on restart, with no migrations folder and no down-migrations. That mechanism is unresolved and must be settled before the staged rollout begins.

### The live schema conflates store-as-location with store-as-channel-shop — FINDING 2026-08-04

In the live SQLite schema the word "store" carries two unrelated meanings. retail_stores holds physical/pickup locations (address, coordinates, opening hours). The store_code / store_id / retail_store_id columns in the meituan_*, eleme_*, guanyi_* and qingyun_* tables hold channel-shop identifiers — an account's identity on a sales channel, not a place. retail_stores itself carries no account column, so the store layer is unscoped today. This conflation must be untangled at the Locations stage, separating Locations (physical, per account) from Channels (per-account settings, created by Tacet). Recorded here so it is not lost; no action now.

### Test accounts cleared from live data — DONE 2026-08-04

The five test accounts (tenant ids 2, 4, 5, 6, 7 — test, kelly1234567, test66, Boca LTD, test03) were deleted from the live SQLite database, leaving tenant id 1 (Roots) as the only account. 52 rows removed across tenants, tenant_users, billing_reminders, billing_invoices, billing_subscriptions, tenant_domains, platform_impersonation_tokens and tenant_user_sessions; all other tenant-scoped tables held zero rows for these accounts. The accounts held no trading data and nothing in the store or channel layer. Verified after the delete: only Roots remains and PRAGMA foreign_key_check returns empty. Script retained at docs/tacet-delete-test-accounts.sql. Separately, the one non-ISO date in retail_vouchers (id 1, code TAP20, expires_at 2026/10/6) was corrected to 2026-10-06, and retail_vouchers.value was confirmed not to block the Postgres data copy — it remains double precision and its split stays deferred to the Stock stage.

### Rehearsal migration to Postgres — DONE 2026-08-04

A rehearsal copy moved five tables from the live SQLite database into the Postgres "tacet" database: accounts (1 row), users (7), suppliers (210), purchase_orders (51), invoices (7). The live app was untouched throughout and remained on SQLite; SQLite was opened read-only and verified as such. Verification compared every cell by rendering the Postgres values back into the SQLite representation and string-comparing against source — 5,859 cells across the first four tables and 18 cells for accounts, zero differences.

Conversion rules established and proven:

- tenant_id maps to account_id, values unchanged.
- Integer flags map to boolean: 0 to false, 1 to true.
- Money stored as REAL yuan converts to bigint cents via round(value * 100). This does NOT apply to columns already named in cents — setup_fee_cents was copied verbatim, as multiplying it would have overstated the value 100-fold.
- Naive DATETIME text is interpreted as UTC. Verified rather than assumed: SQLite CURRENT_TIMESTAMP and datetime('now') are UTC by definition, and there is no 'localtime' modifier anywhere in the codebase. brand_updated_at was traced to its single writer (routes/backend-auth.js) before the rule was applied to it.
- Identity sequences do not advance on explicit-id inserts and require setval after each table copy, or the next application insert collides at id 1.

Findings carried forward:

- The accounts identity sequence was set to 7, not to max(id), preserving SQLite's AUTOINCREMENT high-water mark. Ids 2 to 7 were consumed by the deleted test accounts and stay burned, so no future account inherits an id that appears in older backups, logs or exports as a test tenant. The next account created will be id 8.
- Money is typed inconsistently in the Postgres schema: setup_fee_cents is integer (int4) while invoices.amount is bigint (int8). Safe at present values but worth settling before more money columns are added.
- One supplier row (id 106) contains embedded newlines in a text field. It copies correctly, but any line-oriented migration path such as CSV or COPY text format will silently corrupt it unless quoting is handled correctly.
- invoices.supplier and purchase_orders.supplier are free text with no foreign key, and hold values with no matching suppliers row — including two that are usernames rather than suppliers. If supplier is ever made a real reference, this data will not satisfy it as-is. A Purchasing-stage concern.
- The server has no Python Postgres driver installed, and installing one is not a free action while the app is live, as apt triggers needrestart which can restart services under pm2. The rehearsal generated SQL text and piped it to psql instead.
- Nine tables carry a foreign key to accounts(id): account_domains, account_integrations, account_secrets, account_users, billing_invoices, billing_subscriptions, integration_help_requests, integration_sessions, subscriptions. accounts must therefore be copied at or near the front of the real migration order.
- The application currently parses brand_updated_at as local time when generating cache-busting image URLs. Harmless, but the generated URLs will change once after the switchover to timestamptz.

### rbac_enforce is off by intent, not by settlement — NOTE 2026-08-04

rbac_enforce copied to Postgres as false, faithfully matching the live SQLite value. This must not be read as a decision that enforcement is settled or unwanted. The permission system is deliberately dark pending activation: shadow mode (deny-by-default with log-not-block) is the planned first step, followed by per-route requireCap. A future session encountering false in Postgres should read it as not yet switched on, not as already decided.

### gzgrocery table rename, at the Postgres migration — DECIDED 2026-08-04

The eleven tables of the gzgrocery channel are renamed at the Postgres migration, not before. Renaming live SQLite tables is surgery; creating them under the new names in Postgres is free, so the rename rides along with the migration in the same way as the app directory rename.

The rename is mechanical, not a merge. A read-only survey established that no two tables across the guanyi_* and gzgrocery_* families hold overlapping or duplicate data. This was tested directly rather than inferred: gzgrocery_orders.order_id appears in no guanyi_* table, and the event vocabularies of the two families are disjoint.

New names: guanyi_* becomes gzgrocery_erp_* (the partner's ERP: stock, product mapping, pricing, pickup drift) and the existing gzgrocery_* becomes gzgrocery_shop_* (the partner's OpenCart storefront: paid orders). Two names are kept deliberately. A single blanket prefix would erase the schema's only signal of which external system each table mirrors, and the storefront order daemon depends on the ERP tables for store resolution and pricing.

Scope beyond table names — the rename is larger than it appears and must be planned as one piece of work:

- Approximately eleven API paths under /api/retail-admin/guanyi/*
- JSON response keys guanyi_name, guanyi_code, guanyi_sku_id
- User-facing copy: five toast messages, row text, a button tooltip, bilingual body copy, and the tab heading, which currently reads "gzgrocery 同步 · Guanyi Sync" — both names already appear on the same screen
- Four stored values in retail_stock_ledger.reason: guanyi_pickup, guanyi_pickup_reversal, gzgrocery_order, gzgrocery_order_reverse. These are historical records. Whether to rewrite them or leave them is not decided here.

Findings recorded at the same time, no action now:

- The pickup-drift mechanism (guanyi_pickup_*) is retired and runs in shadow mode; order-read (gzgrocery_orders) is live and is the declared source of truth. The handover was clean on 2026-06-26 and the two were never live simultaneously, so no sale was double-counted.
- Seven gzgrocery scripts exist on the server but are not tracked in git, including scripts/import_guanyi_pricing.js, which is the sole writer of the pricing table. Untracked means unbacked-up and undeployed. This needs resolving independently of the migration.
- stock_push records 9,405 failures against 2,615 successes. Unrelated to the migration, but it is the channel's primary job failing most of the time and warrants separate attention.
- 42,913 of 54,942 rows in the sync log are pickup_guard/skip entries from the parked drift detector, still accruing.

### gzgrocery is Roots' own sales channel — NOTE 2026-08-04

The gzgrocery integration belongs to Roots as a business, not to Tacet as a platform. It is one business's channel, not a feature every account receives. This is consistent with the existing rule that channels are created by Tacet rather than by individual businesses: another account would only have gzgrocery if Tacet built that integration for it.

The consequence for isolation: the eleven gzgrocery tables hold Roots-specific data and must be account-scoped like everything else when the staged rollout reaches them. They are not shared platform infrastructure and must not be treated as such.

Also recorded, from the untracked-source survey of 2026-08-04:

- 40 scripts/*.js files were untracked and have now been brought into the repository. None contained secrets; all read credentials from process.env, which is the correct pattern. No pm2 service or cron job depended on an untracked file, so the exposure was lost tooling rather than a server that would fail to restore.
- scripts/_guanyi_pricing.json was tracked deliberately. It holds the discount Roots gives gzgrocery across 203 products. The decision was taken knowing the file is permanent in repository history.
- The .env files remain untracked and are the only copy of every channel credential on the machine. Losing the server means losing access to every channel until each partner reissues. This is the largest single point of failure identified and is not addressed by this work.

### The schema-change mechanism is unresolved — RESOLVED 2026-08-04

Resolved 2026-08-04 — see "Schema changes are managed with pgroll" below.

The staged account-column rollout and the row-level security policies both require a way to make schema changes that does not exist yet. A read-only survey was completed on 2026-08-04 and is recorded at docs/tacet-schema-change-survey.md. No option has been chosen.

Corrections to earlier records, established by that survey:

- The `_migrations` table is NOT empty and is not a fossil. The live SQLite table holds 144 rows and is load-bearing. The empty one is in the Postgres `tacet` database, created by the phase-1 dump and never written to. Note that 91 of the 144 rows are release-announcement markers rather than schema markers — anything reading this table as a migration ledger will find mostly push-notification bookkeeping.
- The live database has 162 tables. Earlier references to "~140" or "137" are wrong.
- The current mechanism has not been failing. The survey parsed every CREATE TABLE in the repo against the live database and found zero column drift across 157 tables. The case for replacing it is what the staged rollout requires, not a defect.

Findings that must inform whatever is chosen:

- Schema reaches the database by seven distinct mechanisms, not one: 294 `addColumn()` calls, 32 literal ALTER TABLE sites in try/catch, ~127 CREATE TABLE IF NOT EXISTS, 54 `_migrations`-guarded blocks, two tables whose shape is derived at boot from another table, schema mirroring into per-tenant database files, and lazy DDL executed from a catch block inside a sweeper that runs every 60 seconds during normal operation.
- Eight pm2 processes each require database.js and therefore each run the full DDL sequence on start, against the same database. Any runner needs a lock or must run in exactly one place outside the app boot path.
- The repository is not the source of truth for the schema. Five live tables have no CREATE TABLE anywhere in the repo: `meituan_listing_specs` (live code reads and writes it; its DDL was added on the unmerged guanyi-stock-sync branch and exists in production only because that branch once ran on the box), `store_products` (derived at boot by mirroring the products table's runtime shape, so the storefront's entire catalogue has no written definition), and the three known fossils `plans`, `subscriptions` and `retail_product_day_baseline`. Any desired-state tool would propose dropping what it cannot see. This must be reconciled before such a tool is pointed at anything.
- Deploy rollback restores files, not schema. After a failed deploy the previous code version runs against the new schema, so every migration must leave the prior code able to function — additive-only, or genuinely two-phase.
- The health probe rolls back on 5xx from four endpoints. A migration that leaves those unable to serve triggers an automatic file rollback and leaves the schema half-applied.
- Deploys complete in 20 to 55 seconds with roughly a 20 second settle window. A migration slower than that triggers the auto-rollback.
- During the transition one account runs on Postgres while another runs on SQLite, served by the same application code. Applied migrations must be tracked per engine; the current single name-set cannot express this.
- A migrations/ folder at the repo root would never ship — the deploy allowlist covers public/, routes/, lib/, middleware/, scripts/, server.js, database.js, schema.sql and package*.json only. Deletions never reach the box either, so a removed migration file stays live.
- Disk headroom is thin: 40 GB volume at 78 percent used, 8.3 GB free, with roots.db at 510 MB and hourly backups holding about 7.7 GB.
- Five orphaned per-account database files remain at data/tenants/{2,4,5,6,7}.db, each carrying its own copy of roughly 150 tables, and they are still listed in db-backup.sh despite those accounts being deleted on 2026-08-04.
- Ordering in database.js is a positional accident. `store_products` mirrors `products` at line 3793 and all 51 `addColumn('products', ...)` calls sit above it. Nothing enforces this; an `addColumn` appended at the end of the file — the natural place — would silently desync the two catalogues for one boot.

### The Production app's product surface is parked until the Products stage — DECIDED 2026-08-04

Removing products from the Production app was raised and deliberately deferred. It belongs to the Products stage of the consolidation sequence, not to Phase 2, and nothing depends on it.

Context established by survey on 2026-08-04:

- The store catalogue was forked from `products` into `store_products` on 2026-06-09. Everything customer-facing reads and writes `store_products` only: Tacet, the WeChat mini-app, the web storefront, and the Meituan, Eleme and gzgrocery channels. All three channel mapping tables key off `store_products`, and 27 Meituan and 9 gzgrocery mappings point at store-born products that do not exist in the `products` table at all.
- The `products` table has had no write since 2026-06-08. The two tables have drifted: of the 269 rows they share, 77 percent disagree on category, 61 percent on name, and 52 percent on published flag.
- The kitchen SPA is NOT dormant — roughly 20,000 requests over 15 days, staff working in it daily on kitchen, purchases, finance and orders. The product endpoints are read-only in practice: zero writes in the retained log window, but the Products screen was opened on four days and the per-store stock card fifteen times.
- Ash has confirmed nobody needs products in the Production app and nobody creates products or adjusts stock there.

The hazard this leaves open, to be resolved at the Products stage:

The two tables run independent AUTOINCREMENT counters over one integer space — `products` at 305, `store_products` at 361. The next product created in the kitchen app takes id 306, which already belongs to a different store product. routes/restock.js:210-242 guards this correctly. routes/products.js:569-580, the kitchen per-store stock adjuster, does not: it validates against `products` then writes `retail_store_stock`, which is foreign-keyed to `store_products`. No error would occur — the stock would silently land on the wrong product. Dormant only because nobody creates products in the kitchen app.

Two live data errors found at the same time, not yet fixed:

- `store_products` ids 272 and 273 have their SKUs swapped relative to `products` — the regular and big-size walnuts have exchanged codes 2-320 and 2-330. A script named scripts/fix_products_swap.js exists in the repo, suggesting this has occurred before.
- `store_products` id 104, "Medjool Boat", holds the raw Unix epoch integer 1781757233 in its `updated_at` DATETIME column, written by scripts/backfill_weight_from_spec_strip.js:129. SQLite accepts it; Postgres will not. This will fail the Products stage of the migration on load unless caught first.

Also recorded, from the same work:

- public/pos.html and public/restock.html were removed and deployed on 2026-08-04, along with their routes, manifests, icons and every entry point. Both had zero human traffic. The restock removal fixed a pre-existing bug on the way: Quick Stock was installing under the restock PWA identity while its own correct manifest already existed unused.
- Two endpoints lost their only caller with the restock page and remain in place: PUT /api/restock/:id/archive and POST /api/restock/archive-bulk.
- The deploy installer only adds files; deletions never reach the box and must be removed by hand. Removed files remain fetchable at `/assets/<name>` until that is done. public/app.html.bak is stale weight still reachable this way.

### Schema changes are managed with pgroll — DECIDED 2026-08-04

The schema-change mechanism recorded as OPEN on 2026-08-04 is decided. pgroll is the chosen approach. The survey behind this decision is at docs/tacet-schema-change-survey.md, and its six options stand as the record of what was considered.

Why pgroll: it is the only candidate that addresses the rollback hole. Deploy rollback restores files but not schema, so after a failed deploy the previous code version runs against the new schema. pgroll keeps both the old and the new schema version live at once behind views, so the rolled-back code continues to be served the shape it expects. Rollback while a migration is in flight is instant and lossless. Every other option requires that all changes be additive-only forever, which cannot express the renames the consolidation already commits to — the gzgrocery table rename among them.

What this decision does not do: pgroll is Postgres-only and contributes nothing to the SQLite-to-Postgres migration itself. It becomes relevant only once Roots is fully on Postgres and the staged account-column rollout begins. It is not a blocker for the migration work, and it is not installed.

Consequences to plan for:

- Schema changes become two-phase. A change is started, then completed as a separate action, and both schema versions are live in between. This is the property that makes rollback safe, and it is a change to working practice, not only to tooling.
- pgroll is a command-line tool and can be driven by Claude Code in the same way as everything else on the server. The decision to complete a migration stays with Ash, since that is the point of no return.
- pgroll is not installed. Installing packages on the box is not a free action — apt triggers needrestart, which can restart services under pm2. Installation must be planned, not done as a side effect.
- The constraints in §4 of the survey still apply and are not solved by this choice: the health probe rolls back on 5xx from four endpoints; deploys complete in 20 to 55 seconds and a slower migration triggers auto-rollback; a migrations folder at the repo root would never ship, as the deploy allowlist does not cover it; and deletions never reach the box.
- The five live tables with no CREATE TABLE anywhere in the repo remain unreconciled. pgroll does not require the repository to be the source of truth in the way a desired-state tool would, so this is no longer a blocker for the tooling choice, but it remains a real gap.

Parked items:

- Rename the app directory from /root/roots-v2/ to a tacet-branded path. Do NOT do this standalone — it breaks the hardcoded SQLite path, pm2, GitHub Actions deploy, deploy-apply.sh, and likely nginx all at once. Bundle it into the Postgres switchover, which already edits the hardcoded path and deploy wiring, so the rename rides along at low marginal risk. Update all references in lockstep, redeploy, and test.

### Full data copy to Postgres — DONE 2026-08-04

All 129 non-empty tables were copied from the live SQLite database into the Postgres "tacet" database: 353,220 rows in 86 seconds. The live app was untouched and remained on SQLite throughout. SQLite was opened read-only and proven so on every connection by a rejected write, not assumed.

Verification: row counts matched exactly with zero mismatches; 3,244,556 cells were round-trip compared with 43 differences, all proved to be live trading during the run rather than copy errors; all 144 foreign keys were validated by Postgres itself; Chinese character counts were exact once the two drifted rows are excluded; 2,112 base64 values were byte-identical by SHA-256, the widest 3,331,931 characters. 139 identity sequences were set, 117 of them from SQLite's AUTOINCREMENT high-water mark rather than max(id), which matters on 20 tables where ids are burned.

Money precision — DECIDED. Whole cents remains correct for transaction amounts and is wrong for per-unit costs, which get multiplied by quantity. Nine cost columns were retyped from bigint to numeric(14,6): ingredients.cost_per_unit, ingredients.buy_price, ingredient_price_history.price, price_alerts.new_price, price_alerts.old_price, po_line_items.cost_per_unit, po_line_items.total_cost, expense_entries.amount, waste_entries.cost_lost. Twelve genuine unit costs would otherwise have rounded to zero, and 188 values were off by more than 10 percent. numeric was chosen over a micro-cents integer for three reasons: Postgres numeric is exact decimal arithmetic and so does not reintroduce the binary floating-point defect the cents rule exists to kill; the scale is enforced by the type rather than carried in a column name, which is the trap setup_fee_cents already sprang once; and values stay in yuan, matching the source and the UI. One value rounds — waste_entries.cost_lost id 1 loses 0.00000039 yuan. All others are exact.

Weight — DECIDED. products.weight and store_products.weight were retyped from double precision to text and copied verbatim. The values are free text with mixed units — '220 g', '500ml', '1L', '120g (4 bars)', and one malformed '5--g'. No numeric conversion is correct, since stripping units would equate 500ml with 500g. Parsing weight into a number and a unit belongs to the Products stage.

Smaller decisions applied: ISO-8601 timestamps with a trailing Z are accepted as UTC verbatim, 4,437 values across 15 columns, milliseconds preserved. Voucher TAP20 expiry was set to 2026-10-06 15:59:59Z, end of day China time, matching every other dated voucher. store_products id 104 was corrected at source before the copy, from the raw epoch integer 1781757233 to 2026-06-18 04:33:53. recipe_cost_data.packaging_type_id was set to NULL, as the reference pt1778315688913 never existed. Four storefront_config.updated_by rows were set to NULL, having held script names rather than user ids.

Findings carried forward:

- Any SQLite to Postgres row comparison keyed on text requires COLLATE "C". SQLite orders text by byte and Postgres by locale, which ignores punctuation. This produced 117 false differences during verification by pairing the wrong rows on each side, and looked exactly like data corruption.
- Drift, not speed, is the cutover constraint. The copy takes 86 seconds, which is trivial, but the source gained 48 rows during that window and continues to move. A clean cutover needs a quiet window or a delta pass over the tables that take writes — the sync logs, retail_checkout_quotes, activity_log, and the auth tables.
- Setting sequences from max(id) would have set some behind live reality. guanyi_sync_log copied to max id 55,186 while SQLite's high-water was already 55,189.
- docs/tacet-postgres-schema-phase1.sql is now stale on eleven columns and is retained as a historical record only. See the new dump committed alongside it, docs/tacet-postgres-schema-as-built-2026-08-04.sql.

The scripts that performed this copy are preserved at scripts/postgres-full-copy/, alongside the five-table rehearsal at scripts/postgres-migration/.

### The money-unit gap and the boundary layer — 2026-08-04

The full data copy changed the unit of 92 columns from REAL yuan to bigint cents, plus nine unit-cost columns to numeric(14,6). The application reads and writes yuan and has zero conversion sites. Pointed at Postgres unchanged, every price displays 100 times too high and every total sums in the wrong unit. This is the largest single item in Part 2 and is not solved by any driver or compatibility work. Survey recorded at docs/tacet-money-model-survey.md.

DECIDED — the conversion happens at the boundary, not in the application. One layer between the application and the database converts on the way out and on the way back in, rather than hundreds of edits across the call sites. The alternative was rejected because there is no test suite and no automated correctness gate beyond node --check, so hundreds of hand edits carry worse odds than one carefully built converter.

DECIDED — the layer returns yuan. The application already contains a working conversion boundary at the payment gateway: seven sites do Math.round(Number(order.total) * 100) on the way out and verify fen on the callback. If the layer returned cents, all seven would double-convert and charge customers 100 times the correct amount.

DECIDED — expense_entries.amount becomes whole cents, matching income_entries.amount and sales_entries.total. It had been retyped to numeric(14,6) on precision grounds, which matched the symptom rather than the cause: routes/finance.js sums all three within six lines to build the P&L, so the expense side of the accounts was in a different unit from the income side.

The seven sub-cent expense values were examined and are all calculation artifacts, not money that changed hands. Each is a per-category subtotal of a purchase order, computed in SQL by postPOExpenses(), written with created_by NULL, and deleted and re-inserted on every PO status change — a live projection of the PO rather than a record of a payment. All 65 hand-entered expense rows are clean; no human has ever entered a sub-cent expense. Rounding does not lose information, it removes an error: the values derive from truncated unit rates such as 4.16666, which is 25/6, so 4.16666 x 3 yields 12.49998 instead of the intended 12.50. Rounding recovers the exact intended figure in all eight underlying line totals. Whole-ledger impact is 0.0118 yuan.

Two requirements for whoever applies this: the rounding must go into postPOExpenses() and postRetailPOExpenses(), not only the column type, or the next PO status change regenerates a sub-cent value and fails the whole-cent write. And the rounding must be applied to the category subtotal rather than to each line, so the expense rows continue to sum exactly to the PO total.

Income and sales confirmed clean: income_entries.amount has no values above two decimal places, and the twelve in sales_entries.total are float noise within 1e-12 of a whole cent.

THE SECOND MONEY MODEL — the finding the boundary layer structurally cannot reach. storefront_config.value_json is TEXT holding 151 rows, and every money rule in the business lives there in yuan: the free-shipping threshold, the pickup packing fee, the default delivery zone's base fee and per-item packing fee and cap, the affiliate reward per order, the points earn-spend rate, and the loyalty tier thresholds. Each meets a converted column. defaultDeliveryZone() synthesises a zone object from config as the fallback for all of mainland China and returns it alongside real retail_delivery_zones rows, so one shape is yuan and the other cents and computeDeliveryAndPacking cannot tell them apart. tierFromSpend() compares lifetime_spend in cents against thresholds in yuan, so every customer past 40 yuan reaches the top tier and reconcileTier() writes it back. pointsEarnedFor() divides by an earn-spend of 100, giving 100 times the points. Affiliate rewards of 20 and 15 yuan land in cents columns and pay out as 0.20 and 0.15. None of this errors. This must be solved separately from the boundary layer.

ROUNDING IS NOT A PROBLEM. The copy halts on any value that is not within one millionth of a whole cent, and it halted zero times across all 92 columns and 176,015 rows. No genuine sub-cent value exists in any transaction column today, so the layer has no existing fraction to preserve. Every place a fraction is created — percentage vouchers, points converted to cash, the proportional refund split across tenders, wallet spend — already rounds at the point of creation, and that rounding must stay where it is rather than move to the boundary; the refund split in particular relies on cash absorbing the remainder, an invariant that breaks if the boundary rounds the parts independently. Two gaps remain: the packing fee, per_item multiplied by quantity, is the only fraction source in the checkout path with no rounding of its own, and it needs an explicit decision; and the nine unit-cost columns must be exempt from the cents rule entirely, since ingredient_price_history.price bottoms out at 0.004 yuan and whole cents would zero it.

### The unit-mixing statements are retired — DONE 2026-08-04

The boundary layer converts per column, so it can only convert a value that still has a column. A statement that builds money inside SQL — `SUM`, `AVG`, an arithmetic expression — hands back a scalar with no column identity, and if a different unit is present in the same payload the layer cannot tell the two apart. Seven sites had that shape. All seven now read the money as a plain column and sum it in JavaScript, so the column survives to the boundary.

Six were statement-level: two units inside one SQL statement. `GET /api/retail-admin/bills/outstanding`, the two allocation clamps in `routes/finance.js` and the one in `routes/retail-purchasing.js`, `GET /api/finance/outstanding-lines`, and the Bills KPI at `/api/retail-admin/bills/summary`.

The seventh is handler-level and was missed by the first classifier: `GET /api/retail-admin/suppliers/:id` builds `spend` (yuan, `po_line_items.total_cost`) and `owed` (cents, `invoices.amount`) in two separate statements and folds them into one `scorecard`, which the supplier screen renders as adjacent tiles. No single statement carries two units. Survey §2e (vi).

Every one of the seven was correct on SQLite before the change and would have been wrong only after cutover. None of the seven changed a value the application displays; each was compared old-against-new on live SQLite opened `mode=ro`, proven read-only by a rejected write, before it was touched.

The classifier is `scripts/diagnose_money_unit_mixing.py` and the live comparison is `scripts/diagnose_money_unit_split.js`, run through the `ro-query` workflow. The first classifier unioned units found only inside aggregate bodies, so `SUM(cents_column)` beside a plain `yuan_column` looked single-unit — which is how all of these were missed. The corrected one unions the unit of every money reference wherever it sits, separates DERIVED from CARRIED, and adds the handler pass that found the seventh.

STILL OPEN, deliberately not touched by this work: the three `ROUND(x, 2)` guards at `routes/retail.js:9745`, `15111` and `26243`, which are yuan-native operations that need deleting rather than translating (survey §2e (iii)); and `delivery_jobs.raw_order`, the JSON money the standing rule leaves in yuan.

### Money embedded in JSON stays in yuan — DECIDED 2026-08-04

DECISION: money held inside a JSON or TEXT column stays in yuan. No migration converts it — not the full copy, not the boundary-layer work, not any later pass. This applies to every JSON money value in the schema: retail_product_versions.snapshot_json, retail_order_addons.items_json, retail_order_items.options_json, retail_refund_events.meta_json, retail_orders.refund_lines_json, retail_orders.alipay_ocr_json, storefront_config.value_json, activity_log.details and products.bundle. Survey recorded at docs/tacet-money-model-survey.md; the full inventory is 45 JSON-bearing columns, of which 14 carry money.

WHY, AND WHY IT IS NOT OBVIOUS: the temptation is to "make everything cents" so one rule covers the whole database. That is the wrong instinct here, and it is worth stating plainly because the reasoning runs backwards from the usual one. The application speaks yuan and the boundary layer returns yuan — both already decided above. JSON money is also yuan. A value snapshotted out of a column and later written back into one therefore needs no conversion whatsoever: the layer multiplies by a hundred on the way in, exactly as it does for any other write. Convert the JSON to cents and that write becomes a hundredth of the right number.

The deeper reason is that the conversion would be invisible. A converted column announces itself — it has a type, it appears in plan.json with a conversion class, a per-column rule can find it. A number inside a text column has none of that. Converting the JSON creates a second conversion boundary that no type system, no column rule and no schema diff can see, inside data that is also read by hand during support work. The one place the system converts units must stay the one place.

WHAT THIS COSTS, AND WHERE IT IS PAID: the rule holds only while the boundary layer covers every write path. Where it does not — getTenantDb() rather than the request-scoped handle, and the gzgrocery, meituan, eleme and qingyun daemons, which open the database directly — yuan JSON meets a cents column with nothing in between, and fails silently by a factor of a hundred. That is a requirement on the layer, not a reason to convert the JSON.

THE STAMP: retail_product_versions.snapshot_json now carries "_money_unit": "yuan", written by productContentSnapshot() in routes/retail.js and read by the version-restore handler, which converts explicitly at that one site rather than relying on the standing rule holding everywhere. Rows written before the stamp existed carry no key and are read as yuan. That default is safe because nothing has ever written another unit into the column and the full copy of 2026-08-04 left every JSON value untouched — so absent and "yuan" describe the same data. An unrecognised stamp is refused rather than guessed: the restore returns an error instead of writing a price wrong by a hundredfold into a live product.

THE OTHER WRITE-BACK IS UNRESOLVED. finalizeOrderAddon() (routes/retail.js) reads unit_price and line_total verbatim out of retail_order_addons.items_json and writes them into retail_order_items on the WeChat payment callback, unattended. Re-deriving that money from the column at settlement — the pattern refund_lines_json already uses, discarding the stored amount and recomputing from retail_order_items.line_total — would make it unit-safe, but it would also re-price the customer's paid lines. The staged price and the settlement price genuinely can differ: sell_price is edited constantly, and effectivePriceFor() is time-dependent so a flash window opening or closing between staging and callback changes the unit price on its own. The customer is charged retail_order_addons.amount, fixed at staging, so re-pricing would break the invariant that an order's line totals sum to what was paid, and would move the ceiling that normalizeRefundLines() applies to a later refund. Referred as a product decision, not a units decision. Until it is settled, this path relies on the boundary layer covering the write.

### The database seam is built, and lib/store-hours.js is the first module through it — 2026-08-04

The boundary layer decided above needs somewhere to live before it can convert anything. `lib/db-seam.js` is that place: it wraps a `better-sqlite3` handle and intercepts `prepare()`, so every prepared statement — the only construct that carries both bound parameters going in and identified columns coming out — passes through one point that a converter can later occupy. No converter is installed. With none installed the wrapper forwards each call to the raw handle and returns the result untouched, so the seam is a zero-cost passthrough and cannot alter a value even by accident. It was built and proven behaviour-neutral first, deliberately, so that the converter arrives into a seat that is already covered and already measured rather than being written and wired in the same step.

`lib/store-hours.js` is the first module routed through it, and was chosen because it is the smallest real consumer: one statement, three columns, no money, one table. It reads `retail_stores.code / open_time / close_time` for the Qingyun ops-alert muting and the 外卖 and 闪购 polling windows.

STANDING RULE — RAW HANDLES ONLY IN `tenantAls.run()` AND `dbToId`, NEVER A WRAPPER. Both live in `lib/tenant-db.js`. The ALS store is compared by identity against `mainDb` in `currentTenantId()`, and `dbToId` is keyed by handle identity; a wrapper in either place changes what those two answer. Those sites hold the raw handle. A later step that finds it needs a wrapper in either one must stop and raise it, because it is a behaviour change and not a refactor. Note that `tdb()` and `getTenantDb()` are NOT yet routed through the seam, which is why coverage starts where it does — and note that roughly fifteen call sites outside `tenant-db.js` pass `getTenantDb(tid)` straight into `tenantAls.run(...)`, so the step that wraps `getTenantDb()` has to give those sites a raw accessor at the same time or it will put wrappers into the ALS.

STANDING RULE — `exec` AND `pragma` ARE PERMANENT PASS-THROUGHS. This is a property of what they are, not a gap to be closed later. `exec()` takes raw SQL with no bound parameters and returns no rows: there is nothing to convert on the way in because there are no parameters, and nothing to convert on the way out because there is no result set and therefore no column identity. The converter is per-column and needs a column to act on; `exec` offers none in either direction. It carries DDL and batch statements — `CREATE TABLE`, `ALTER TABLE ... ADD COLUMN`, the schema self-heal in `tenant-db.js`. `pragma()` addresses SQLite's own settings and never carries application money. If a future change appears to need conversion inside `exec`, the fix is to move that statement to `prepare()` where it has parameters and columns, not to widen the converter. Recorded in the header of `lib/db-seam.js` as well, because that is where someone about to widen it will be looking.

COVERAGE IS A MEASURED NUMBER, NOT A CLAIM. `scripts/db-seam-coverage.js` is a static reader over the deployed application. It counts every `<handle>.prepare(` site — each one a place a money value can cross — and attributes it to how its handle was obtained: through the seam, through `tdb()`/`getTenantDb()`, from a module-level `require('../database')`, or from a `new Database(...)` of its own. At this step: **1 of 3,074 statement sites, 0.03%** across the whole application; **1 of 2,630, 0.04%** on the runtime surface alone. The remainder is 1,363 TENANT, 1,015 DIRECT, 637 RAW_OPEN and 58 UNRESOLVED. Receivers the reader cannot resolve — a handle arriving as a function parameter — are counted in the denominator and never as covered, so the number understates rather than flatters. The 637 `RAW_OPEN` sites are the ones §24 already named as where the yuan-JSON rule is paid for: the daemons that open the database directly. Two files are excluded and named in the output, on the same precedent as the SKIP set in `diagnose_money_unit_mixing.py`: the coverage reader itself and the comparison harness, which holds a raw handle because being the un-seamed side of the comparison is its entire purpose — counting it would report a deficit that must never be closed.

THE COMPARISON HAD TO ASSERT THAT NOTHING THREW, NOT THAT NOTHING LOOKED BROKEN. `scripts/diagnose_store_hours_seam.js` loads the real `store-hours.js` twice against one read-only connection, identically except that one run has the seam stubbed to the identity function — byte-for-byte the module's previous behaviour — and the other has the real seam. It compares the SQL issued, the rows off the wire, the primitive type of every column value, `storeHours()` for every code on file plus absent-code cases, and `within()` sampled every fifteen minutes across a full day at four grace settings. It runs against live SQLite opened `mode=ro`, proven read-only by a rejected write, through the `ro-query` workflow — the same mechanism the unit-mixing comparison used. It passed on live before the code shipped: identical SQL, identical rows, identical column types, no throw at either level.

The workflow had to be changed to make that ordering possible. `ro-query` copied one script to prod and ran it against the *deployed* application, so a comparison of not-yet-deployed code failed with `FATAL: missing lib/db-seam.js` — the harness's own guard. A comparison that can only run after the code ships cannot gate the ship, so the workflow now stages the checkout's `lib/` in a scratch directory beside the script and runs the candidate code against the live database. `data/` is not staged and the read-only proof is unchanged.

A FINDING, PRE-EXISTING AND NOT CAUSED BY THIS WORK: on live, `retail_stores` holds two rows — `tianhe` and `yuexiu` — and **neither has a usable open/close pair**, so `storeHours()` returns null for every store in production and every consumer treats every store as always-open. The module's own header calls that the intended reading of null, so nothing is misbehaving; but it means the live run's hours and `within()` comparisons are vacuous, and the harness says so in its output rather than presenting them as passes. The behavioural half of the proof is carried by the fixture run, which has three configured stores and 2,304 agreeing `within()` evaluations; the live run carries the no-throw assertions and the row-level identity on real data. Worth knowing separately from the seam: the Qingyun ops-alert muting and the 外卖/闪购 polling windows are configured in the admin but are not in effect, because the two live stores have no hours set.

The no-throw assertion is separate and explicit because `store-hours.js` catches its own read errors and keeps serving its last good cache. A seam that broke the read would therefore be invisible from outside — the daemons would still get hours and the app would still be up. So the harness asserts the absence of a throw at two levels: it issues store-hours' own statement through a seam-wrapped handle with no `try`/`catch` in the way, which catches a fault originating inside the seam; and it sits a probe underneath the seam that records every exception the handle raises whether or not the module swallows it. Both must be clean, and the read must be shown to have actually completed, since a swallowed failure leaves an empty map that otherwise compares equal to an empty database. The harness was verified against two deliberately broken seams — one that alters a value and one that throws — and fails on both, so a green result means something.

### A FAILED DEPLOY SILENTLY SKIPS ITS CHANGES FOREVER — FINDING 2026-08-04

Found the hard way while shipping Step B, and it is a property of the pipeline rather than of that change.

`deploy.yml` computes what to ship as `git diff ${{ github.event.before }} ${{ github.sha }}` — the diff against the PREVIOUS PUSH, not against what was last successfully deployed. So when a run fails before its "Ship changed files" step, the files in that commit are never shipped, and the NEXT push diffs against the failed commit and does not include them either. They are skipped permanently, and every subsequent deploy reports success.

WHAT HAPPENED. Deploy 901 carried the Step B flip (`lib/tenant-db.js`). It failed at the lint gate — correctly, on an error in a diagnostic file — and shipped nothing. Deploy 902 then diffed against 901's commit, found only the diagnostic, and shipped that. It reported `RESULT=SUCCESS`. Production kept running the Step A version of `tenant-db.js` while `main`, the merge commit, the coverage checker and the decisions record all said Step B was live. Recovered with a `workflow_dispatch` run using `full_sync: true`.

WHY IT IS DANGEROUS BEYOND THIS INSTANCE. The failure mode is silent and the signal is inverted: the deploy that skips your change is the one that says SUCCESS. Nothing compares what is on the box against what is in the repository, so the drift persists until someone happens to look. Any failed deploy in this repository's history may have left files behind in the same way.

WHAT WAS DONE ABOUT IT NOW. `scripts/diagnose_tenant_step_b.js` gained a check that reads the DEPLOYED `/root/roots-v2/lib/tenant-db.js` and asserts it is the version the repository claims — verifying the artifact rather than the checkout. That covers one file.

WHAT IS STILL OWED, AND IS NOT DONE. The general fix belongs in the pipeline, not in a diagnostic: compute the diff against the last SUCCESSFULLY deployed commit rather than the previous push. That means recording the deployed SHA on the server after a successful install and reading it back on the next run, or falling back to `full_sync` when the previous run did not succeed. Not attempted here — it changes deployment behaviour, which is outside what this work was asked to touch.

### The failed-deploy skip is FIXED, and it had bitten 197 times — DONE 2026-08-05

The fix owed above is done, landed in four stages on 2026-08-05 (deploy runs 905–909).

HOW BAD IT ACTUALLY WAS. Replaying all 904 deploy runs from 2026-06-22 to 2026-08-04 against full git history — the push history is perfectly linear across all 898 push runs, so the reconstruction is exact rather than approximate — found **939 moments where a run reported SUCCESS while production did not match the repository at that commit**. Those group into **197 stranding episodes across 141 distinct files**. Median episode 0.5 days; 71 ran longer than a week; the longest ran 43 days. **79 episodes were never healed by a later commit at all** and were cleared only by the unrelated `full_sync` on 2026-08-04 — which means that dispatch accidentally cleared a six-week backlog nobody knew existed. Twenty-two of those were runtime code, not throwaway scripts: `lib/proxy-manager.js`, `lib/ops-alert.js`, `lib/eleme-client.js`, `lib/social-auth.js`, `lib/operator-caps.js`, `routes/eleme-admin.js`, `routes/eleme-internal.js`, `routes/guanyi-admin.js`, `public/editor.html` and others. `lib/tenant-db.js` was one of 197, found only because someone happened to check that one file.

WHAT THE FIX IS. The diff base is now the commit recorded on the server at `/root/roots-v2/.deploy-state/last-success-sha` — what production actually holds. The record lives on the box, beside the artifact it describes, because a record kept in the repository or in Actions cache would describe what CI INTENDED, and CI's intent is exactly what was wrong. There is one writer, gated behind the installer's `RESULT=SUCCESS`, so the recorded sha cannot advance unless the files were installed; a failed run never reaches it. Replaying the same 904 runs against the new logic gives **0** mismatches where the old gave 939.

EVERY FAILURE MODE OVER-SHIPS. Record missing, not a 40-hex sha, or not a commit in this repository: warn and fall back to the previous-push base, which is exactly the pre-fix behaviour — never a silent no-op. Record valid but not an ancestor of HEAD, meaning history was rewritten: use the merge-base, which can only ship a superset. The record is never trusted enough to NARROW the set beyond what it can prove. Only a record running AHEAD of reality could skip files, and no path can produce one.

HOW YOU WOULD KNOW. `deploy.yml` now hashes the files it just shipped on the server and fails the run on any mismatch. It runs BEFORE the record is written, so a verification failure leaves the record behind and the next deploy re-ships that range — the failure mode heals itself. Two files are excluded because the installer rewrites them after installing them: `public/sw.js` (the CACHE stamp, by design) and `package-lock.json` (see below).

TESTS. `scripts/test-deploy-base.sh` extracts the base-resolution step out of the workflow itself — so the test cannot drift from what it tests — stubs ssh for the deploy record, and drives ten cases including the headline failed-deploy case and a control that reproduces the old skip. `scripts/diagnose_deployed_tree.js` compares the whole deployed tree against the repository, read-only, via `ro-query.yml`. Run it whenever the box's fidelity is in question; regenerate its manifest first.

### MONEY IS RESOLVED BY SCHEMA CLASS, NEVER BY COLUMN NAME — RULE 2026-08-05

THE RULE: a column is money if and only if `scripts/postgres-full-copy/plan.json` gives it conversion class **CENTS** or **NUM6**. 92 columns are CENTS, 9 are NUM6, 101 in total. Nothing else counts, and no other test is permitted — not the column's name, not its SQLite type, not what it looks like it means. Any tool that needs to know whether something is money reads `cls` from the census.

WHY THIS IS A RULE AND NOT A PREFERENCE: name-based classification has now been wrong twice, in both directions.

- `display_min_total` reads like a money column and is not one.
- On 2026-08-05 `routes/billing.js` was classified as money-touching from a file-level grep for money-ish column names. It touches no CENTS or NUM6 column at all. The `price` the grep matched is a **JavaScript object property** in a seed array, and the money it does handle lives in `price_cents` and `amount_cents` — integer-cents columns of class INT, the category the full copy deliberately copied verbatim rather than multiplying. The only schema column named `price` with a money class is `ingredient_price_history.price`, which that file never touches.

Both directions matter. A false positive wastes a full every-statement verification pass on a file that needs none. A false negative is worse: it lets a file that really does carry money through on sampled verification, which is the failure the converter cannot afford.

HOW TO DO IT CORRECTLY: resolve the statement, not the text. `scripts/diagnose_seam_statements.js` prepares each statement against a scratch database built from the census and reads `statement.columns()`, which returns the real table and column each output column comes from. That is a resolved answer from the schema; a grep over source text is a guess about it. For writes it parses the target table and column list and checks those against the census the same way.

WHERE THIS BITES NEXT: the money-conversion work itself. A converter driven by a name pattern would convert `price_cents` twice and miss `display_min_total`'s neighbours. The converter must be driven by the same census `cls` field, from the same file.

### ON CONFLICT after cutover — CHECKED AND CLEAN, 2026-08-05

Raised as a risk and then settled, so the scare does not outlive the check.

THE WORRY: `scripts/postgres-full-copy/plan.json` carries 215 PRIMARY KEY and UNIQUE constraints and **no indexes**. `routes/push.js` upserts with `ON CONFLICT(endpoint)` against `push_subscriptions`, whose uniqueness in live SQLite comes from `database.js:125` — a `CREATE UNIQUE INDEX`, not a constraint. If the Postgres schema had been built from that census alone, the uniqueness would be missing and the upsert would fail after cutover rather than at build time.

THE ANSWER: it is fine. `docs/tacet-postgres-schema-as-built-2026-08-04.sql` is pg_dump output and **does** record indexes, including `CREATE UNIQUE INDEX idx_push_endpoint ON public.push_subscriptions USING btree (endpoint)`. The as-built schema carries 230 unique constraints and indexes across 162 tables.

CHECKED EXHAUSTIVELY, NOT SPOT-CHECKED. All **62** `ON CONFLICT` sites in scope were enumerated, their target table and columns resolved, mapped from SQLite to Postgres names via the census, and matched against the as-built schema's constraints and unique indexes. **62 matched. 0 would fail after cutover.** That includes the renamed tables, where the SQLite and Postgres names differ: `tenant_user_sessions` to `account_user_sessions`, `tenant_secrets` to `account_secrets`, `tenant_integrations` to `account_integrations`, `tenant_onboarding` to `account_onboarding`.

THE LESSON, WHICH IS THE SAME ONE AS THE MONEY RULE: the gap was in the tool's INPUT, not in the migration. The census is a column census; it is not a schema. Anything asking a question about schema shape — uniqueness, indexes, constraints — must read the as-built dump, not the census. The census answers questions about columns and their conversion classes, and nothing else.

### Two statements will not survive the cutover — FINDING 2026-08-05

Found while verifying seam batch 3, by preparing every statement in a file against a schema built from the live census. Both blocked their file from the batch, which is how they surfaced. Neither is fixed.

**1. `sqlite_sequence` has no Postgres equivalent — and the failure is SILENT.**

`routes/ingredients.js:299` and `routes/admin.js:238` both run `DELETE FROM sqlite_sequence WHERE name IN (…)` to reset AUTOINCREMENT counters after a data wipe, so that ids start again at 1. `sqlite_sequence` is a SQLite internal table; Postgres has no such thing, and identity sequences are reset with `setval` — the same mechanism the rehearsal migration already needed after each table copy, and which is already recorded in this section as a rule ("Identity sequences do not advance on explicit-id inserts and require setval after each table copy, or the next application insert collides at id 1").

Both call sites are wrapped in `try {} catch {}`. So after cutover they do not raise — they fail silently and the counters are simply not reset. **The next insert then continues from the old high-water mark instead of from 1, which is the exact opposite of what the surrounding code is written to achieve.** A wipe-and-reset that leaves ids continuing from 4,000 looks like it worked and did not. This is on the cutover checklist because it must be converted to `setval` at the same time the application moves, not discovered afterwards from odd-looking ids.

**2. `routes/restock.js:167` reads a `settings` table that does not exist — today, not after cutover.**

`SELECT value FROM settings WHERE key = 'restock.warehouseStoreId'`. There is no `settings` table in the live census, none in the as-built Postgres schema, and none created by `database.js`. The census was taken from the live database, so this statement is failing **now**.

WHAT IT IS FOR. `_resolveWarehouseStoreId()` decides which `retail_stores.id` is the warehouse — the location restock goods ship OUT of. It is a three-tier preference chain: (1) this explicit `settings` override, described in the code as "for a future multi-warehouse world"; (2) the store a `warehouse`-role user is bound to; (3) fallback — whichever active store currently carries the most on-hand stock.

WHAT BREAKS. Tier 1 is unreachable. The throw is caught by `catch { /* no settings table / row — fall through */ }`, so the code is already written as though the table may be absent — but the consequence is that **there is no way to configure which store is the warehouse.** Setting `restock.warehouseStoreId` has no effect and never has. Resolution always falls to tier 2 or tier 3.

That matters most at tier 3, which is data-dependent: the warehouse is whichever store happens to hold the most stock right now. **Without a `warehouse`-role user bound to a store, the identity of the warehouse can change by itself as stock moves between locations**, with no configuration change and no signal. Downstream, `_resolveDestStoreId(order, warehouseStoreId)` picks the destination by excluding the warehouse, and line 279 abandons the restock entirely when the two resolve equal — so a drifting tier-3 answer shows up as transfers between the wrong pair of locations, or as restocks that quietly do not happen.

Not fixed here. Settling it is a decision about whether the override should exist at all: either create the `settings` table and honour it, or delete tier 1 and make tier 2 the documented mechanism. `routes/ingredients.js` and `routes/restock.js` are held out of the seam batches until it is settled.

### The restock warehouse override has never worked — OPEN 2026-08-05

`routes/restock.js:167` reads a `settings` table that exists nowhere: not in the live census, not in the as-built Postgres schema, and not in `database.js`. It fails silently inside its own `catch { /* no settings table / row — fall through */ }` and has done since it was written.

That statement is tier 1 of `_resolveWarehouseStoreId()` — the explicit override naming which store is the warehouse, the location restock goods ship OUT of. Because it has never returned anything, resolution always falls through to tier 2 (a `warehouse`-role user's bound store) or tier 3 (whichever active store currently holds the most on-hand stock).

THE CONSEQUENCE: with no warehouse-role user, the warehouse's identity is data-dependent and can change by itself as stock moves, with no configuration change and no signal. `_resolveDestStoreId(order, warehouseStoreId)` picks the destination by excluding the warehouse, and line 279 abandons the restock entirely when the two resolve equal. So this surfaces as transfers between the wrong locations, or restocks that quietly do not happen.

NOT A MIGRATION ISSUE — it is failing today. The restock station shell was removed on 2026-08-04 and `server.js:723` records that the flow is unused, but `routes/restock.js` is still mounted at `server.js:325` and `/api/restock` is still called from `public/app.html`, `public/kitchen.html` and `public/login.html`. Removed page, live route.

TO SETTLE: either create the `settings` table and honour tier 1, or delete tier 1 and make tier 2 the documented mechanism. This is a decision, not a fix. `routes/restock.js` and `routes/ingredients.js` remain held from the seam batches until this and the `sqlite_sequence` finding are settled.

### A third statement queries a column that does not exist — FINDING 2026-08-05

Same class as the two above, found the same way — by preparing every statement in a file against a schema built from the live census, while verifying seam batch 5.

`routes/ai.js:2188` runs `SELECT created_at, price, buy_unit, source FROM ingredient_price_history WHERE ingredient_id = ? AND created_at >= ?`. That table has **`recorded_at`**, not `created_at` — twice over, in the projection and in the WHERE. The statement cannot prepare, so it throws every time this AI tool is invoked, today, against live SQLite.

It sits inside the `current_stock` tool handler of the AI assistant's function set, so the failure surfaces as that tool erroring rather than as a crash — the price-history question it exists to answer simply never gets answered. The fix is a two-word rename, and it is not made here: `routes/ai.js` is held from the seam batch alongside `ingredients.js` and `restock.js`, for the same reason. A file whose statements do not all prepare cannot be verified by the every-statement method, and routing an unverified file is exactly what these batches exist to avoid.

Three findings of this shape now — `settings`, `sqlite_sequence`, `ingredient_price_history.created_at`. All three were invisible to the application because each sits behind a `catch` or inside a tool handler, and all three were found by preparing statements against the schema rather than by running the app. That is worth generalising: **preparing every statement in the application against the live schema would find the rest of them, and nothing currently does it.**

### Statement-preparation sweep of the whole application — DONE 2026-08-05

Three defects had been found as a SIDE EFFECT of routing seam batches. Finding the same shape of thing three times by accident is a signal to look on purpose. `scripts/diagnose_statement_sweep.js` prepares every statically-written statement in every in-scope file against a schema built from the live census. It compiles and resolves every table and column named; it executes nothing, so it cannot write.

**2,524 statements across 109 files. 6 fail today. 96 fail at cutover. 371 are built dynamically and cannot be reached this way** — a blind spot stated rather than hidden, and it already conceals one known case: the `sqlite_sequence` reset in `routes/admin.js:238` is assembled by concatenation, so the sweep sees only its sibling in `routes/ingredients.js`.

FAILING TODAY — throwing in production every time the path is reached:

| site | fault |
|---|---|
| `routes/ai.js:2188` | `ingredient_price_history.created_at` — the column is `recorded_at` |
| `routes/restock.js:167` | `settings` table does not exist |
| `routes/store-admin.js:528` | `retail_orders.created_at` — no such column |
| `routes/store-admin.js:551` | `retail_orders.created_at` — no such column |
| `lib/brand-designer.js:61` | `store_products.is_on_flash` — no such column |
| `scripts/gzgrocery-order-daemon.js:126` | `retail_stores.store_code` — no such column |

Two were already recorded. Four are new, and the two `store-admin.js` sites are the most interesting: they are the operator's order search and a customer's recent-order list, so **order lookup by number and a customer's order history are both failing** wherever that route is reached.

FAILS AT CUTOVER — compiles on SQLite, errors on Postgres, across 22 files:

| construct | count | Postgres equivalent |
|---|---|---|
| `INSERT OR IGNORE/REPLACE` | 60 | `ON CONFLICT` |
| `sqlite_master` | 21 | `information_schema` / `pg_catalog` |
| `strftime()` | 5 | `to_char()` / `date_trunc()` |
| `GROUP_CONCAT()` | 5 | `string_agg()` |
| `julianday()` | 4 | date arithmetic |
| `sqlite_sequence` | 1 (+1 hidden in a dynamic statement) | `setval()` |

That is 96 statements needing rewriting before the switchover, and the count is a floor, not a total, because of the 371 dynamic statements. **This is the first measured size of the SQL-dialect work.** It was not previously on the cutover checklist in any form.

NOTHING IS FIXED. Several are two-word changes and every one is a live behaviour change on a running business, so each is decided individually.

WHAT IS GATED ON A DECISION RATHER THAN ON EFFORT. Of the six failing today, three block a file from the seam: `routes/ai.js` (72 sites), `routes/restock.js` (38) and `scripts/gzgrocery-order-daemon.js` (23) — 133 sites, plus `routes/ingredients.js` (29) held on `sqlite_sequence`. `routes/store-admin.js` and `lib/brand-designer.js` are not blocked by this pattern; they are in the mixed-TENANT and UNRESOLVED groups and were never movable. So **162 of the remaining sites are waiting on decisions, not on work.**

### The daemons are through the seam — DONE 2026-08-05

Five of the six: guanyi, meituan, shangou, qingyun, eleme. 154 of 177 daemon sites, 87.01%. `gzgrocery-order-daemon.js` is held on the `store_code` fault above.

Their risk profile differs from a route file and the difference is worth stating. A route file fails in front of a person who retries; **a daemon runs unattended against live channel data on a timer**, so a fault surfaces as stock drifting out of sync with Meituan or Eleme, orders not being collected, or a sync loop erroring in a log nobody reads — hours later and attributed to the channel rather than to us. They also hold no HTTP request to fail; there is no 500 to notice.

Two things made that acceptable rather than merely hoped for. First, the seam is a proven passthrough with no converter installed — 2,781 assertions across the whole better-sqlite3 surface — so there is no mechanism by which a value can change. Second, every one of the 150 statements in these five files was extracted and executed raw against wrapped before they shipped, and none touches a money column.

`deploy-apply.sh` bounces each daemon whose files ship, so they picked the change up on the deploy rather than running stale — which is itself a thing that had to be true and is worth having checked.

### Six statements are failing in production today — OPEN 2026-08-05

Found by preparing all 2,524 in-scope statements against the live schema on 2026-08-05 (`scripts/diagnose_statement_sweep.js`). Each fails every time its path is reached, and each is invisible because it sits behind a `catch` or inside a tool handler. None would ever surface by using the product.

- **`routes/store-admin.js:528` and `:551`** — `retail_orders.created_at`, no such column. These are the operator's order search by number and a customer's recent-order list. Both fail wherever that route is reached. **The most consequential of the six.**
- **`lib/brand-designer.js:61`** — `store_products.is_on_flash`, no such column. A flash-sale existence probe, so the designer behaves as though no flash sale is ever active.
- **`scripts/gzgrocery-order-daemon.js:126`** — `retail_stores.store_code`, no such column. The daemon cannot resolve a store by code at all.
- **`routes/ai.js:2188`** — `ingredient_price_history.created_at`, which is `recorded_at`. The AI assistant's `current_stock` tool throws every time, so the price-history question it exists to answer is never answered.
- **`routes/restock.js:167`** — the `settings` table does not exist. Already recorded separately as "The restock warehouse override has never worked".

**THESE ARE NOT TYPO FIXES.** Each is a code path that has never executed successfully, so downstream code has only ever seen the empty case — an empty result set, a caught exception, a falsy probe. Whoever fixes them must establish, per statement, whether making it work surfaces behaviour nobody has ever seen: a search that starts returning rows, a designer that starts believing a flash sale is active, a daemon that starts resolving stores it previously could not. The fix is one line; the change in behaviour may not be.

Four of the six block a file from the database seam: `routes/ai.js` (72 sites), `routes/restock.js` (38), `routes/ingredients.js` (29, held on `sqlite_sequence`) and `scripts/gzgrocery-order-daemon.js` (23). `routes/store-admin.js` and `lib/brand-designer.js` are in the mixed-TENANT and UNRESOLVED groups and were never movable by that pattern.

### 96 statements will not run on Postgres — FINDING 2026-08-05

From the same sweep. These compile on SQLite and **error** on Postgres — they are not behavioural differences, they are statements that will not execute after the switchover. Across 22 files:

| construct | count | Postgres equivalent |
|---|---|---|
| `INSERT OR IGNORE` / `OR REPLACE` | 60 | `ON CONFLICT` |
| `sqlite_master` reads | 21 | `information_schema` / `pg_catalog` |
| `strftime()` | 5 | `to_char()` / `date_trunc()` |
| `GROUP_CONCAT()` | 5 | `string_agg()` |
| `julianday()` | 4 | date arithmetic |
| `sqlite_sequence` | 1 | `setval()` |

**This is the first measured size of the SQL-dialect work, and it was not on the cutover checklist in any form.** The rehearsal migration proved the DATA converts; nothing had yet asked whether the QUERIES run.

**It is a floor, not a total.** 371 statements are built dynamically — by template interpolation or string concatenation — and are unreachable by static preparation. That blind spot already conceals one known case: the `sqlite_sequence` reset in `routes/admin.js:238` is assembled by concatenation, so only its sibling in `routes/ingredients.js` appears in the count above. Whatever the true number is, it is larger than 96.

### RAW_OPEN is closed, and the pre-converter sequencing constraint — 2026-08-05

**CLOSED — RAW_OPEN is not a scattered-connections problem.** There are **four** raw `new Database(` opens in runtime scope, not 230. The 230 was a statement-site count, 226 of them inside `database.js`. All four opens are correctly raw and **none is reclassified**:

- **`database.js`** — the shared handle and schema bootstrapper. Its statement sites are **17 DDL + 211 DML** (not 226 DDL, as earlier mis-stated). The DML is real outstanding work and stays in the coverage denominator.
- **`lib/tenant-db.js`** — stays raw **by identity comparison**: `tenantAls` and `dbToId` compare handles by identity, and a wrapper changes behaviour. Structure-only replay against `sqlite_master`, 5 SELECT + 2 ALTER, zero DML, **no money writes by construction**. It has no `_migrations` table because it runs no migrations; the presence-check guard is stateless and self-correcting, which is stronger than a flag table.
- **`lib/ops-alert.js`** and **`lib/gzgrocery-order-notify.js`** — stay raw: `readonly: true` opens on the health-watchdog path, deliberately avoiding the schema-migration load that `require('../database')` would pull into every tick. **This is the point of those files, not incidental.**

**No reclassification of the coverage denominator.** An earlier proposal to exclude 226 sites as DDL was withdrawn: 211 are DML and four of them touch money columns — `database.js:731`, `:3398`, `:3419`, `:3545`, the last recomputing lifetime spend across the customer table. Coverage stays **75.28%** and is honest.

**MEASURED THIS PASS** — live SQLite, read-only, `ro-query` run 32, head_sha `54188c0a`, `scripts/diagnose_migrations_ledger.js`:

- All four money writes are one-time and migration-guarded: `lookups_seed_v1` (`:731`), `shipping_spec_alignment_v1` (`:3398`, `:3419`), `backfill_lifetime_spend_v1` (`:3545`).
- **All three migration names are present in the live `_migrations` ledger** (144 rows). Therefore **on live SQLite these four bodies are dead code on every boot** — already applied, and they will not re-fire.

**THE CONSTRAINT — a design requirement, not a defect.** No converter exists yet: the only `installConverter(` call in the codebase is in a discarded diagnostic instance. There is no converter and no install site, so the sequencing requirement can be **designed in rather than discovered wrong**:

> **The converter must be installable BEFORE `database.js` executes its migration list — or migrations must be moved out of module load.**

Rationale: `database.js` runs its migrations at module load. A converter installed later in startup cannot, by construction, reach a migration that runs at load; and on a database where a given migration has **not** yet been applied, that migration runs fresh at load. **The window is open now, and every money-writing migration authored before this constraint is satisfied lands in it.** That growing edge is stated here explicitly rather than left implied.

This belongs next to the pgroll / no-migrations-folder item recorded above ("Schema changes are managed with pgroll", and the constraint that a migrations folder at the repo root would never ship because the deploy allowlist does not cover it). **Same knot.**

**OPEN VERIFICATION GATES — none inferred into fact:**

1. **POSTGRES-SIDE OF THE GUARD: NOT VERIFIED.** The three names are confirmed on live **SQLite only**. That the same three are in the Postgres copy is **inference from row-count equality** — 144 live, the copy established at 144 — which is suggestive, not a read. No Postgres connection was made; the no-pg-connection constraint holds. **Do not treat matched row counts as verification.** Closing this requires a Postgres read, which is a separate decision under a separate constraint.
2. **THE GROWING EDGE.** Any migration authored after the copy cutover, or added between now and the converter's install point, is not covered by gate 1 **even once gate 1 closes**, and fires fresh in the pre-converter window.
3. **THE 62 UNRESOLVED.** Separately open. This is where a tenant-side money write would hide if one exists outside `lib/tenant-db.js` — a backfill taking a tenant handle as a parameter. Survey briefed, not yet run.

**HONEST LIMITS:**

- The `readonly` watchdog reasoning is verified against code and comment, **not against runtime behaviour**.
- The RAW_OPEN survey sees `new Database(` and the checker's attribution. A handle obtained another way lands in the 62 UNRESOLVED (gate 3), not here.
- Two facts were corrected mid-investigation — "230 opens" → four, and "226 DDL" → 211 DML including four money writes. **Both were inferences presented as measurements.** The corrected picture is the one recorded above.

### Three deploy findings recorded, NOT fixed — 2026-08-05

Found while fixing the diff-base bug, deliberately left alone so the fix stayed one change. All three are live today.

1. **DELETIONS NEVER PROPAGATE. A file deleted from `main` stays on the production box forever.** `deploy.yml` skips deletions (`[ -f "$f" ] || continue`) and `deploy-apply.sh` only ever copies — and `full_sync` does not delete either, so the recovery path does not clear them. Confirmed with a live instance, not inferred: **`public/retail-admin.js` was deleted from main on 2026-06-11 in `64c55e7a` ("Mini App Backend: split app JS into 10 per-feature files (Step 2b)") and was still present on the server on 2026-08-05, 54 days later.** Whatever still references it keeps resolving. This matters beyond housekeeping — §24 says `lib/tenant-db.js` is deleted in a later phase, and on today's pipeline it will linger on the box after that deletion ships.

2. **The deployed `package-lock.json` is not the committed one.** `deploy-apply.sh` runs `npm install --omit=dev` whenever `package.json` or `package-lock.json` ships, and npm rewrites the lockfile in place afterwards. The 2026-08-05 tree comparison found it as the ONLY file differing from main — main `0eb15c94`, box `bc8875c0` — despite the `full_sync` having installed the committed bytes hours earlier and nothing touching it since. So the server's lockfile is npm's regeneration, and a future `npm install` there can resolve differently from a clean install of the repository. Same class as the `sw.js` stamp: a file the installer mutates after installing it. Not drift from the skip bug.

3. **`scripts/deploy-changed.sh` has the identical diff-base bug.** The local post-commit hook ships only `git diff-tree HEAD`, so a failed local deploy strands its files exactly the same way, and it does not write `.deploy-state/last-success-sha`. The direction is safe — a stale record makes the NEXT CI deploy ship a wider set, never a narrower one — but the hook itself can still skip files silently, and nothing about the CI fix protects a developer deploying from their own machine.

Also noticed, lower stakes: the ship step's `ssh … | tee … || true` discards the installer's exit code, so `ABORTED_NPM_INSTALL` is reported as the generic "did not report SUCCESS"; and the ship loop runs one `ssh` per directory and one `scp` per file, which is why a `full_sync` of 480 files takes 37 minutes (`$DIRS` is also unquoted and would word-split on a path containing spaces — none exist today).

### Postgres cutover checklist — items recorded as they are found

Actionable items that must happen AT the cutover and cannot be solved by the code beforehand. This section exists because the first such item was found while drawing the seam's scope line, and there was nowhere to put it. `GO-LIVE-CUTOVER.md` is the WeChat mini-app runbook and is a different cutover; this list is the Postgres one.

- [ ] **REPLACE THE `sqlite_sequence` RESETS WITH `setval` AT CUTOVER.** `routes/ingredients.js:299` and `routes/admin.js:238` reset AUTOINCREMENT counters by deleting from `sqlite_sequence`, which does not exist in Postgres. Both are inside `try {} catch {}`, so after the switchover they fail silently and the counters do not reset — the next insert continues from the old high-water mark, the opposite of the intent, and nothing warns. Must be converted at the same time the application moves, not afterwards.

- [ ] **DELETE RETIRED FILES ON THE BOX BY HAND — THE DEPLOY WILL NOT.** The pipeline never removes a file: `deploy.yml` skips deletions and `deploy-apply.sh` only copies, so anything dropped from `main` keeps running in production. Proven live on 2026-08-05: `public/retail-admin.js` was still on the server 54 days after being deleted from main. At the cutover this stops being housekeeping — `lib/tenant-db.js` and the file-per-account isolation it carries are deleted in a later phase per §24, and a file that is supposed to be gone but is still importable is exactly the kind of thing that gets loaded by something nobody remembered. Take a `diagnose_deployed_tree.js` reading first, then remove the EXTRA entries deliberately.

- [ ] **REMOVE OR RENAME `data/roots.db` AT CUTOVER.** About 80 one-off scripts in `scripts/` open the live SQLite database by path and would run unedited tomorrow. They are deliberately out of scope for the database seam — see the scope decision below — and that exclusion is only safe if the file they reach for is gone. Left in place, every one of them keeps working against a stale database after the application has moved to Postgres: reads return figures that look right and are months old, and writes land somewhere nothing reads. Nothing warns. The notable ones a person might actually reach for: `reset_test_orders.js`, `restore_recipe_data.js`, `seed_missing_store_stock.js`, `guanyi-pickup-report.js`, `meituan-queue-status.js`. Renaming is preferable to deleting — it keeps the rollback path and still breaks the scripts loudly with "unable to open database file".

### What the database seam is responsible for, and what it is not — DECIDED 2026-08-04

THE RULE: a file is IN SCOPE for the seam if it can reach the LIVE database on an ongoing, unattended basis. That is the criterion because the converter exists to protect live money values. A file that cannot reach live data cannot corrupt it, and a script that ran once and would have to be edited before it ran again is not part of the system's steady state.

IN — everything in `routes/`, `lib/`, `middleware/`, plus `server.js` and `database.js`, and the six channel daemons: `guanyi-daemon.js`, `meituan-daemon.js`, `shangou-daemon.js`, `gzgrocery-order-daemon.js`, `qingyun-daemon.js`, `eleme-daemon.js`. They run continuously under pm2 and write live order, stock and sync data. Together: 2,799 statement sites.

OUT — one-off backfills, fixups, imports, seeds and hand-run diagnostics in `scripts/`, and verifiers that only ever touch a temporary database. 437 sites across 135 files.

RECURRENCE IS NOT THE TEST, REACH IS. `scripts/verify-fulfilment-types.js` runs on every deploy that touches fulfilment — it is one of the most frequently executed scripts in the repository — and it is out of scope, because it builds a throwaway SQLite database in the OS temp directory and never opens the live one. Conversely a backfill that has not run since June is in the same category as one that ran yesterday if both would open `data/roots.db` on demand.

THE COST OF THE EXCLUSION, RECORDED RATHER THAN BURIED. About 80 of the excluded scripts open the live database by path and would do so again tomorrow if someone ran them unedited. Excluding them is a judgement that they will not be run AFTER the Postgres cutover — not a claim that they cannot be. Notable ones that a person might plausibly reach for: `reset_test_orders.js`, `restore_recipe_data.js`, `seed_missing_store_stock.js`, `guanyi-pickup-report.js` and `meituan-queue-status.js`. If the SQLite file is left in place at cutover, every one of them keeps working against stale data, silently, and any write lands in a database the application no longer reads. **Removing or renaming `data/roots.db` at cutover is what actually makes this exclusion safe, and it belongs on the cutover checklist.** The seam cannot make it safe.

BOTH NUMBERS ARE ALWAYS REPORTED. `scripts/db-seam-coverage.js` prints coverage with and without the excluded scripts, and states how many sites the exclusion removes from the denominator, so the scope decision stays visible instead of quietly improving the figure.

### The coverage checker was measuring less than it claimed — CORRECTED 2026-08-04

Three blind spots, each of which silently shrank the denominator rather than announcing itself:

1. A `.prepare(` whose receiver could not be recovered was DROPPED instead of counted as UNRESOLVED, despite the file's own header promising the opposite.
2. Regex literals were not recognised. `scripts/guanyi-daemon.js` contains `.replace(/^['"]|['"]$/g, '')`; the scanner entered string mode inside the regex, desynchronised, and swallowed the rest of the file. That daemon reported **0** statement sites when it has **40**. Across the six daemons the count went from 20 to 177 once fixed.
3. Nested template literals inside `${...}` are still not tracked. An attempt to handle them made the measurement worse, not better — `routes/retail.js` fell from 1,124 attributed sites to 476 — so it was reverted deliberately.

THE FIX THAT MATTERS IS NOT ANY OF THOSE THREE. It is the reconciliation check now in the checker: every file's attributed site count is compared against a naive count of `.prepare(` in the same source, and any shortfall is reported as a SCANNER GAP. That is what turns a silent under-count into a visible one, and it is the same lesson as `operator-caps` — it is not enough that nothing complained; the thing has to be shown to have happened. One gap is currently open and stated: `routes/retail.js` attributes 1,124 of 1,220 sites, the missing 96 being statements inside nested template literals.

Coverage numbers quoted before 2026-08-04 were therefore measured against a denominator that was too small in `scripts/` and too large nowhere. The seam's covered count was never wrong; the total was.

### Step A of the tenant step — raw accessors, a guard, and currentTenantId() stops guessing — DONE 2026-08-04

The seam's next move is to route `tdb()` and `getTenantDb()` through it, which covers 1,333 statement sites — about half the in-scope application — in one change. That is the opposite of the incremental pattern that has worked, so it is split. Step A does everything except the wrapping; Step B is then a two-line flip whose entire risk surface has already been retired.

THE CALL SITES WERE 23, NOT 15. The first estimate was made by eye. Enumerated properly: 10 pass `getTenantDb(tid)` straight into `tenantAls.run()`, 8 pass a local `tdb_` bound from `tdb()`/`getTenantDb()`, 3 pass `req.tenantDb`, and 2 pass an already-raw handle. Every path into the ALS except those last 2 originates from `getTenantDb()`, so wrapping it without this step would put a wrapper into 21 of them.

WHAT STEP A DID. `rawTenantDb(id)` and `rawTdb()` are exported and always return raw handles; `rawTenantDb()` remains the only writer of `dbToId`, so everything it hands out is identifiable. All 21 sites were converted. `getTenantDb()` and `tdb()` still return raw, so **Step A changes no behaviour except the one below** and coverage is unchanged.

`tenantAls` IS NOW A GUARDED FACADE, not the AsyncLocalStorage itself. It exposes the same `.run` and `.getStore` the 29 existing call sites already use, and throws if handed a seam-wrapped handle. Nothing changes shape; a missed site fails loudly at first execution instead of silently mis-identifying the tenant.

THE AGREED BEHAVIOUR CHANGE: `currentTenantId()` no longer answers "Roots" when confused. It was `return dbToId.get(store) || ROOTS_TENANT_ID`. A handle this module never created fell through that `||` and became a confident wrong answer — and this value selects a tenant's credentials. Now: no scope at all → Roots, a scope explicitly entered with `mainDb` → Roots, and anything else throws. A system that guesses "it must be Roots" when it cannot tell is the leak the isolation work exists to prevent.

WHAT CAN REACH THE THROW, CHECKED BEFORE SHIPPING. The branch needs an active scope holding a handle that is neither `mainDb` nor in `dbToId`. In production that cannot happen: only Roots exists, `TENANT_DATA_ISOLATION` is off, every ALS value comes from `rawTenantDb()` or the shared handle, and `openTenantDb()` has no callers outside this module. One place in the repository does reach it — `scripts/verify-closed-store-routing.js` enters a scope with its own temporary-file handle. It is hand-run, automated nowhere, and out of the seam's scope; and the only `currentTenantId()` call reachable from it is `lib/inventory.js`'s `_bumpStockLive()`, which already wraps it in `try`/`catch` and returns, documented as best-effort and never part of a write's contract. So it degrades exactly as it already does in daemon processes with no live hub.

PROVEN BY ENUMERATION, NOT BY MEMORY. `scripts/check-tenant-als.js` discovers every `tenantAls.run()` call site by scanning and fails unless each one's first argument provably produces a raw handle. A site added next month is caught by default. The gate found its own blind spots while being built: it initially missed `routes/retail.js:5670` because comment-stripping was not string-aware, so a `//` inside a URL string ate the rest of the line — the same class of bug as the coverage checker's regex-literal gap, and the reason it now reconciles what it classified against what is actually there.

### Step B of the tenant step — the flip — DONE 2026-08-04

Two lines. `tdb()` and `getTenantDb()` now return `seam(...)` instead of the raw handle. Seam coverage went from **18 of 2,799 in-scope statement sites (0.64%) to 1,351 of 2,799 (48.27%)** — 51.53% of the runtime surface alone. Including the excluded one-off scripts: 41.80%. Everything that made it safe was built in Step A, which is why the flip itself is two lines.

THE ALS STILL HOLDS RAW HANDLES. The wrapping happens on read, in the accessor, not in the store. `rawTenantDb()` and `rawTdb()` are unchanged and still raw, `dbToId` is still keyed on raw identity, and `seam()` is idempotent and caches one wrapper per handle so `getTenantDb(1)` keeps a stable identity across calls.

THE PROPERTY THE STEP TURNS ON, PROVEN FOR MORE THAN ONE TENANT. For every row in `tenants`, `tenantAls.run(rawTenantDb(id), () => currentTenantId()) === id`, asserted with the seam active and with it stubbed to the identity function. This matters because `currentTenantId()` selects a tenant's credentials: if the flip broke it, one account would act with another's WeChat and payment configuration.

The check is run against a fixture carrying three tenants, not just Roots, and that is not a detail. Driven against a deliberately broken build — the ALS accepting wrappers, `rawTenantDb()` handing one out, and `currentTenantId()` falling back to Roots, i.e. exactly Step B without Step A — **tenant 1 still passes** while tenants 2 and 7 both silently report as Roots. On live there is only Roots, so the live run cannot see this failure mode at all. The fixture is what catches it.

TENANT DATABASES ARE MATERIALISED IN A SCRATCH TREE, NOT THE LIVE ONE. `rawTenantDb(id)` for a non-Roots id creates `data/tenants/<id>.db` and writes schema into it. That path resolves relative to `tenant-db.js`'s own location, so under the `ro-query` staging directory it lands in scratch. The diagnostic asserts this before opening any non-Roots handle and refuses the sweep if the resolved directory is inside the live application — so a future change to how diagnostics are staged cannot quietly turn a read-only check into a writer.

COVERAGE IS NOT SELF-CERTIFIED. `tdb()` and `getTenantDb()` are indirections, so whether a `tdb().prepare(...)` site counts as covered depends on what those functions return. Rather than hard-code that — which is how a measured number turns back into a claim — the coverage checker reads `lib/tenant-db.js` and tests whether the accessors actually return `seam(...)`. Unwrapping `tdb()` drops the reported figure from 51.53% to 0.69% on its own, with the basis printed on every run.

WHAT THE STEP A DIAGNOSTIC NOW ASSERTS. Its §1 originally checked that nothing was wrapped, which was Step A's whole point and is deliberately false after Step B. Those assertions were retired and replaced with the invariants that survive — the raw accessors staying raw — rather than left to fail and be ignored. A check that is expected to fail teaches people to skip the output.

### Store opening hours are not configured — OPEN 2026-08-04

Live `retail_stores` holds two rows, `tianhe` and `yuexiu`, and neither has a usable `open_time` / `close_time` pair. `storeHours()` therefore returns null for every store in production, and every consumer treats every store as always-open.

What is consequently not in effect: the Qingyun ops-alert muting, and the Meituan (外卖) and Shangou (闪购) polling windows. These are configured in the admin but have no effect. Those three daemons — `scripts/qingyun-daemon.js`, `scripts/meituan-daemon.js`, `scripts/shangou-daemon.js` — are the only consumers of `lib/store-hours.js`. Eleme is NOT among them: `scripts/eleme-daemon.js` does not read the module, and no eleme daemon is running under pm2. Separately and not investigated, `routes/retail.js` and `routes/retail-inventory.js` read the same two columns directly rather than through the module, which is the `resolvePickupTime` consumer already recorded in §9's "one hours field cannot answer three questions".

Pre-existing, unrelated to the Postgres migration, and not blocking. Found incidentally on 2026-08-04 while routing `lib/store-hours.js` through the database seam. Not investigated — it is not known whether this is a feature built and never configured, or configured and later cleared, or which admin surface sets these values.

To resolve later: identify which screen sets `open_time` and `close_time`, name each consumer and what it would do differently if hours were set, and decide whether the windows should be configured or the feature removed.

### The seam passes money through untouched — the converter seat is EMPTY — MEASURED 2026-08-05

Measured on branch `claude/money-seam-conversion-verify`, commit `491af07`, `ro-query` run 35. Read-only throughout: `roots.db` opened `readonly: true`, the read-only property proven by a rejected write both before and after the run, and the 18 writes the real handlers attempted were suppressed — none executed.

**THE SEAM DOES NOT TOUCH THE MONEY VALUE. IT IS A PURE PASSTHROUGH.** The three money writes verified last pass — `products.js:454` (`sell_price`), `retail.js:15899` (`reward_amount`), `retail.js:18197` (`sell_price` and `compare_at_price`), four columns, all class CENTS — were driven on the live production box and every one of them arrived at the connection exactly as it left the request.

**`currentConverter() === null` ON THE LIVE CONFIGURATION, OBSERVED AT RUNTIME.** In `wrapStatement` the guard `if (!converter || !STMT_INTERCEPT.has(prop))` takes the raw path — `value.apply(target, args)`, verbatim. So the seam does not merely decline to convert: with no converter seated it never inspects the value at all.

**PROVEN BY THE VALUE, NOT BY THE SOURCE LINE.** A known fractional-yuan amount went in the request body, the real handler ran, and what arrived at the connection was captured together with its JavaScript type. `12.34` in, `12.34` out — a fractional number, not an integer — at the connection, for all four columns. A converted value would have arrived as integer cents, `1234`. **10 money-parameter observations, 10 unchanged, 0 altered.** Reading the guard would have suggested this; the captured value is what establishes it.

**AN EMPTY SEAT, NOT A COVERAGE GAP — the distinction is the point.** A recording identity converter installed in a throwaway child process received all four values, so **the seat REACHES all four**. The passthrough is therefore a configuration fact — no converter is installed — and not the seam failing to see these writes. When a real converter is seated, these four writes are already in its path and need no further routing work.

**GENERAL, NOT ROOTS-ONLY.** Both retail sites were driven across three distinct wrappers — the live main handle plus two separate in-memory tenant handles, confirmed to be distinct objects each unwrapping to its own raw handle — and every money column arrived identically at all three. The structural reason: `converter` is a single module-level variable in `lib/db-seam.js`, consulted per call, with no per-handle, per-tenant or per-wrapper branch anywhere; the WeakMaps cache wrappers, not converter state. The prior pass's SEAM/TENANT same-wrapper collapse stays boxed as a Roots-only artefact of `getTenantDb(1) === mainDb` and was deliberately NOT allowed to carry this claim.

**THE RISK, STATED AS THE MONEY BUG THE CONVERTER MUST FIX.** This is not a SQLite problem today. Those columns are REAL in SQLite, the application reads and writes yuan end to end, storing `12.34` is consistent with everything around it, and nothing is wrong on the live box. The risk is entirely Postgres-side: the target type is `bigint`, and `12.34` into `bigint` is either a rejection or a truncation to `12` — **a 100× understatement of every price and every reward**. A converter MUST be seated before these writes reach Postgres.

### The deployed sha is `ffe232e`, READ rather than assumed — CORRECTION 2026-08-05

The deployed production sha, read from `/root/roots-v2/.deploy-state/last-success-sha`, is **`ffe232e`** (`ffe232e62749df5ded998d54cd632a1831bb71d3`).

**THIS CORRECTS TWO PRIOR ASSUMPTIONS.**

1. **`54188c0a` is stale.** The box moved to HEAD roughly ninety minutes after that figure was recorded. Every standing line in this document that asserts `54188c0a` as production is left standing and is superseded by this entry — none of them is edited.
2. **There is NO 4-commit gap.** `c9d896c`, `7c44a87` and `ccdf274` shipped no deployable file, so the deploy record never advanced for them. The record advances only when a push ships a deployable file; three docs-and-workflow commits leaving it unmoved is the record working, not the record lagging.

**PROVENANCE AND CAVEAT, RECORDED HONESTLY.** This is the deploy's own record of itself. `/root/roots-v2/.git` is absent — the box is `scp`'d, not checked out — so there is no independent working-tree second opinion available from the box. `scripts/diagnose_deployed_tree.js` exists and would give a byte-level comparison against the repository if one is ever wanted; **it was NOT run this pass.** One line was requested and read; the read is not reconciled against the artefact.

**THE META-FACT, PLAINLY.** This figure had been stated twice in prior passes and was read once here. Reading it dissolved a four-commit gap that would otherwise have been reasoned about — the gap was never there. The cost of reading the record was one line.

### Ten money writes were hiding in the `routes/retail.js` scanner blind spot — FINDING 2026-08-05

Read-only, static survey. No database was opened; the no-pg-connection constraint holds; nothing was routed, no scanner was changed and no coverage figure moved.

**THE BLIND SPOT IS ONE CONTIGUOUS WINDOW, AND IT IS THE REFUND PATH.** The coverage scrubber desynchronises on a nested `${...}` template and cannot parse `routes/retail.js` lines **22368–24197** — the shipping, tracking and refund region. The **96** statement sites in that window were absent from BOTH the numerator and the denominator: neither counted covered nor counted uncovered, invisible to the measurement in either direction.

**96 IS EXACT, NOT A FLOOR — ESTABLISHED TWICE, INDEPENDENTLY.** The scanner's own arithmetic (1220 naive − 1124 attributed) could not be trusted to give it, because the naive count is produced by the same desynchronising `scrub()` and can lose occurrences itself. So the set was established two other ways: a nested-template-aware lexer with full `${...}` recursion, which finds **1220** `.prepare(` occurrences and puts **all 1220 in genuine code positions** — none hidden inside emitted HTML; and lifting the scanner's own `scrub()` out of its source at runtime and diffing what survives it, which gives **1124 visible, 96 invisible, 0 false positives**. Both agree. The window is clean at both ends: all 96 true sites inside 22368–24197 are blind, and **0** of the 1,124 sites outside it are — 933 before, 191 after. One desync, one resync.

**TEN OF THEM ARE MONEY WRITES.** All ten are on `tdb()`, which returns `seam(...)` — **on the seam, none raw**. All ten are on the refund path. All bind **fractional-yuan** values into CENTS columns: the surrounding code reads `+(priorApproved + amount).toFixed(2)`, `+(Number(_row.total) || 0).toFixed(2)` and the like. They are **distinct from the three characterised in run 35** — `retail.js:15899` and `:18197` are below 22368 and were always in the visible region. They sit in the **same untouched-passthrough / 100×-bigint condition** as those three, except that until now they were unrecorded AND invisible to coverage in both directions.

Every column below is classified from `plan.json` `cls`, never from its name; every site was read in source and the parse confirmed verbatim.

| site | kind | table | money columns (all CENTS) |
|---|---|---|---|
| `23102` | UPDATE | `retail_payments` | `refunded_amount` (SET), `amount` referenced |
| `23289` | UPDATE | `retail_payments` | `amount` |
| `23295` | INSERT | `retail_payments` | `amount` |
| `23380` | UPDATE | `retail_orders` | `refund_amount_approved`, `refund_amount_paid` |
| `23392` | UPDATE | `retail_payments` | `refunded_amount = amount` |
| `23429` | UPDATE | `retail_orders` | `refund_amount_approved`, `refund_amount_paid`, `refund_cash_amount` |
| `23451` | UPDATE | `retail_payments` | `refunded_amount = amount` |
| `23784` | UPDATE | `retail_orders` | `refund_amount_approved`, `refund_cash_amount` |
| `23936` | UPDATE | `retail_orders` | `refund_amount_paid` |
| `24097` | UPDATE | `retail_orders` | `refund_amount_requested`, `refund_amount_approved`, `refund_amount_paid`, `refund_cash_amount` |

**THE READS, RECORDED FOR COMPLETENESS AND NOT AS THE HEADLINE.** 16 money reads in the same window: 13 that name their columns, plus three `SELECT * FROM retail_orders` at `23474`, `23593` and `23629`, each returning all **12** CENTS columns of that table — a case column-name matching would have missed, stated because it is the false negative this method was prone to. One read is behaviourally load-bearing under conversion: **`23123` compares `COALESCE(refunded_amount, 0) + 0.005 < amount`** — a half-fen epsilon expressed in yuan and decided SQL-side. Under bigint cents that comparison stops meaning what it was written to mean.

**THE TALLY, AND THE ZERO THAT WAS CHECKED RATHER THAN ASSUMED.** 96 = **10 money writes + 16 money reads + 70 non-money**, with **0 unresolved**. Every site resolved to a table present in the census. The one genuinely dynamic column list — `23237`, `UPDATE retail_orders SET ${sets.join(', ')}` — was hand-resolved by enumerating every `sets.push` in its handler and class-checking each candidate against `plan.json`: `status`, `updated_at`, `def.col` ∈ {`paid_at`, `preparing_at`, `dispatched_at`, `delivered_at`, `cancelled_at`, null}, `payment_method`, `cancelled_reason`, `staff_note`, `refund_status` — TEXT and TS only, **no money column can appear**. One raw handle is noted in the window and is not a money site: `22775` uses a bare `db`, which resolves to the module-level `require('../database')` (DIRECT, not seam) because its enclosing handler declares no local `db`; its table is `activity_log`, which carries no money columns.

### A CONVERTER CANNOT REACH SQL-SIDE MONEY EXPRESSIONS — STRUCTURAL LIMIT 2026-08-05

This is a limit on what the converter design can achieve, not a fact about any particular set of sites.

**A JavaScript boundary converter fixes BOUND PARAMETERS — the `?` values the application hands the driver. It structurally CANNOT reach money that lives on the SQL right-hand side**: column-to-column assignments and arithmetic performed inside the statement. Those values never cross the JavaScript boundary, so there is no point at which a converter could see them.

**THE DANGEROUS PART IS THAT IT LOOKS LIKE COVERAGE.** Seating a converter at such a site converts the bound parameter and leaves the column-side expression exactly as it was. The site is then reported as covered, the statement still carries an unconverted money value, and nothing anywhere announces the difference. **That is worse than an open gap: an open gap is counted, and this is not.**

Five of the ten writes recorded in the blind-spot finding above are of this kind and are named here as **converter-unreachable**:

| site | the expression a converter cannot reach |
|---|---|
| `23102` | `MIN(amount, COALESCE(refunded_amount, 0) + ?)` and `CASE WHEN amount <= COALESCE(refunded_amount, 0) + ?` |
| `23392` | `refunded_amount = amount` — column to column |
| `23429` | `COALESCE(refund_amount_approved, ?)` |
| `23451` | `refunded_amount = amount` — column to column |
| `24097` | `MAX(COALESCE(refund_amount_requested, 0), ?)` |

At each of these, seating a converter fixes the bound `?` and leaves the column-side expression untouched.

**THE DESIGN CONSEQUENCE, WHICH IS THE DURABLE POINT.** The converter-seating work **cannot be planned as though seating the converter closes the money risk on the refund path.** It closes the parameter half of it. SQL-side money expressions need a separate mechanism — rewriting the statements, or handling the schema and units so that the in-SQL arithmetic is correct under bigint cents. **Which mechanism is an OPEN DESIGN QUESTION and is deliberately not answered here.** It is recorded now so that the converter's scope is drawn with this limit already in it, rather than discovered after the converter is seated and believed to be sufficient.

### MONEY IS STORED AS DECIMAL, NOT WHOLE CENTS — DECIDED 2026-08-05

**This supersedes the earlier decision that money is stored as whole cents, never as a decimal.** That line is left standing where it is and is superseded by this entry, not edited.

**WHY THE EARLIER DECISION IS REVERSED.**

Whole cents assume every currency has exactly two minor units. That is false — JPY has none, KWD has three. A fixed two-decimal model therefore hardcodes an assumption about the world, which **§0 Governing rules forbids**: accounts each set their own currency, and nothing may be built around one business's situation. The cents rule was adopted to kill a floating-point defect, and it does kill it; but it pays for that with a Roots-shaped assumption baked into the storage type itself.

A measurement pass on 2026-08-05 — read-only, static, no database opened, 185 files, **3,785 statement sites**, **565 money-touching**, lexed with full nested-template awareness so it does not inherit the blind spot that hid the ten refund-path writes — established the rest of the case.

- **The in-SQL problems that cents would force us to chase are small.** 7 hardcoded money constants (the `0.005` half-fen guard appears **3 times**, not once); **5** unit-sensitive expressions, all of them the same store-credit `ROUND(..., 2)` construct on `retail_customers.balance`; **24** money parameters buried inside expressions rather than bound as bare assignments.
- **The two-decimal assumption, by contrast, is pervasive.** 51 round-to-two sites, 90 lines carrying `toFixed(2)`, 105 identifiers containing `cents` or `fen`. Under a cents model every one of those must be kept, and defended per currency, forever.
- **Trading money carries no currency anywhere.** The only columns that store a currency at all are on the billing tables — `billing_invoices`, `billing_plans`, `plans` — and those are **already integer cents**. The currency lives exactly where multi-currency is not needed, and is absent from every column where it is.
- **107 money statements are built by string interpolation and cannot be read by any static scan** — 49 in `routes/retail.js` alone. This is the decisive asymmetry. Under cents, a hidden constant in that set is a silent 100× bug. Under decimal, a hidden yuan constant like `0.005` remains correct. **Decimal is safe against the part we cannot see; cents is not.**

**CONSEQUENCES — each is its own downstream decision and NONE is settled by this entry.**

- Postgres money columns become decimal. The completed full data copy of 2026-08-04, which landed as bigint cents, must be rebuilt as decimal. Scripted work, not hand work.
- Every money amount needs a currency stored beside it, and cross-currency arithmetic must be blocked or explicitly converted. **This requirement is independent of cents-versus-decimal** and would have been owed either way.
- **The decimal SCALE is unsettled.** The nine columns already migrated are `numeric(14,6)`. Whether six fractional digits is the right scale for money, and whether a precision of 14 leaves enough headroom, is an open question and is **NOT decided here**.
- **The seam still needs a read-side converter.** The Postgres driver returns both `bigint` and `numeric` as text. Decimal removes the RESCALING from the converter; it does not remove the converter.
- **The `0.005` half-fen epsilon and the five `ROUND(..., 2)` sites are correct under decimal yuan and need no change.** They were only ever wrong under cents. **Do not "fix" them.**

**STATUS: a design decision, recorded. No code, no schema and no data is changed by this entry.** The build that follows from it — schema rebuild, currency column, scale decision, copy re-run — is separate and is not yet briefed.

### THE DECIMAL SCALE IS `numeric(14,6)` — DECIDED 2026-08-06

**All money columns are `numeric(14,6)`: six fractional digits, eight integer digits of headroom.** One scale for all money, displayed and calculated alike — **not** a split. This settles the scale left open by the 2026-08-05 decimal decision.

The evidence is the money-scale census, run read-only against the live databases on the box: `scripts/postgres-money-scale/money_scale_census.py`.

- **Six is where the data stops needing more.** The deepest genuine fractional precision in real data is 6. `ingredients.cost_per_unit` holds **68 values at six decimal places**, and `ingredient_price_history`, `ingredients.buy_price` and `po_line_items.cost_per_unit` also reach 6. At scale 6, **zero** values are lost. At scale 2, **695** calculated values would be corrupted; at scale 4, **161**.
- **The displayed side does not need the precision, and is not harmed by it.** All **89** DISPLAYED money columns hold zero values beyond two decimals — prices, totals and refunds are clean. They could be stored at scale 2, but one uniform scale is simpler than a split, and the extra precision is harmless headroom.
- **Eight integer digits is roughly a thousandfold headroom.** The largest money value anywhere is **76,105.69** (`income_entries.amount`), five integer digits. `numeric(14,6)` admits eight, to a ceiling of ~99,999,999.999999.
- **The one value that rounds is float residue, not precision.** A single value at eleven decimal places — `waste_entries.cost_lost` = 14.47993935862069 — is the result of a division, not money anyone recorded. It rounds cleanly at scale 6 and is the only value affected.

### `expense_entries.amount` IS DECIMAL, NOT WHOLE CENTS — SUPERSEDED 2026-08-06

**The earlier "expense_entries.amount becomes whole cents" decision is reversed.** That line is left standing where it is and is superseded by this entry, not edited.

`expense_entries.amount` is `numeric(14,6)`, like the other calculated-money columns. Two things changed under it. The census found **seven non-null values with genuine sub-cent precision** — 187.13958 and 602.67992 among them, deepest scale 5 — so the precision is real in the data rather than an artefact of the column type. And money is now stored as decimal, not cents, so the reason the earlier entry gave for the change — that the expense side of the P&L must match the unit of the income side — is satisfied without rounding anything away.

The disagreement between this document and `plan.json` noted earlier is resolved in favour of decimal.

### CONVERTER INSTALL-POINT IS NOT AN ORDERING PROBLEM — RESOLVED 2026-08-08

**The pre-converter sequencing constraint recorded above in "RAW_OPEN is closed, and the pre-converter sequencing constraint" is void as an ordering requirement.** Nothing about the startup order needs to change, and the converter does not need an install slot earlier in boot. That entry's line — "The converter must be installable BEFORE `database.js` executes its migration list" — is left standing and is superseded by this entry, not edited.

**THE DECISIVE REASON: `database.js` never routes through the seam, so no install time could reach its migrations.** The handle is a raw `new Database(...)` at `database.js:8`, and every migration runs on that raw handle directly. `database.js` does not require `lib/db-seam.js` at all. Consumers instead write `seam(require('../database'))` — `middleware/auth.js:5` and `routes/admin.js:8` among them — so the require completes, migrations included, and only then is the returned handle wrapped for that caller's own use. A converter seated at the first line of `server.js` would still not intercept a migration. There is therefore no startup window to miss: the migrations do not consult the seam at any point, early or late. Moving the install point earlier closes nothing. Routing `database.js`'s own handle through the seam is a separate and larger change and is **not** proposed here.

**The migrations are already applied and recorded, so on a live box their bodies are dead code on every boot.** The ledger table is `_migrations`, `(name TEXT PRIMARY KEY, applied_at)`; each migration reads its guard before doing work and writes its marker after. Measured statically at head `b8a774ea`: **51 marker-guarded migrations, every one with its guard earlier in the file than its marker, and zero unguarded money writes.** Three of the 51 write money, unchanged from the 2026-08-05 reading — `lookups_seed_v1` (`packaging_types.cost`), `shipping_spec_alignment_v1` (six `retail_delivery_zones` fee columns) and `backfill_lifetime_spend_v1` (`retail_customers.lifetime_spend`). All three names were confirmed present in the live 144-row ledger on 2026-08-05.

**THE REAL REQUIREMENT — the converter's money-column list must be COMPLETE, and must be GENERATED.** There are **101** money columns: the `cls: "NUM6"` entries of `scripts/postgres-full-copy/plan.json`. The list must be generated from that file, which is already the roster the copy itself reads, so that the converter and the copy cannot disagree. A hand-maintained list is the failure mode to avoid — a column missing from it is silently not converted, and nothing announces the omission. This folds into seating the converter. It is not a separate ordering problem.

**FIGURES THAT DID NOT SURVIVE CHECKING — corrected above, and named here so they are not re-derived.** The conclusion holds; four supporting figures did not. (a) The migration count is **51**, not 14. (b) They are not all structural — **three write money**, as listed above. (c) The ledger table is **`_migrations`**; **`schema_version` does not exist anywhere in the repository**. (d) The seam does **not** convert by column name and holds **no column list at all** — `converter` is `null` at `lib/db-seam.js:58`, the seat is still empty, and the only money-column constant in the application is `SNAPSHOT_MONEY_COLUMNS` at `routes/retail.js:18282`, which has two entries and is unrelated to the seam.

### DECIMAL DATA COPY — RECORDED 2026-08-08

**The full decimal copy was re-run on 2026-08-06 against the decimal schema: 129 tables, 364,666 rows in 83 seconds, zero aborts.** This **supersedes the 353,220-row figure** of the 2026-08-04 bigint-cents copy recorded above in §24 Database. That line is left standing and is superseded by this entry, not edited.

Recorded here because it previously existed only in a commit message. Two commits carry it: `e0e391d5` "Copy roster: the 92 money columns go decimal", which moved `plan.json`'s 92 `cls=CENTS` columns to `NUM6` / `numeric(14,6)` and refuses to write unless the roster and `docs/tacet-postgres-schema-decimal.sql` name exactly the same 101 columns in both directions; and `588a9f08`, which fixed the runner and produced the figure.

**What the fixed `run.py` changed.** The previous run read every table's source count once at the start, then compared each table's load against that number as much as 90 seconds later. The live app writes to SQLite throughout, so the number went stale mid-run and the copy aborted at table 34 of 129 on a table that had copied perfectly. Each table's count is now read immediately before that table is generated, and the abort keys off what `gen.py` actually emitted for the table, from the same connection and the same SELECT. A row landing in the remaining millisecond gap is reported as drift and does not abort.

**Money verified correct on the 101 money columns: zero genuine mismatches.** The differences observed were proven to be live-SQLite drift during the copy window rather than errors. SQLite stayed read-only throughout — the same `mode=ro` URI, with `gen.py`'s write probe still running.

**HONEST LIMIT — recorded from the run's own reporting, not from an independent Postgres read.** The no-Postgres-connection constraint held for this entry as it did for the ledger gate of 2026-08-05. `verify.py` renders `NUM6` identically on both sides and `final.py` compares Postgres against each table's count at its own copy moment; the zero-mismatch result is those tools' output, not a second independent verification.

**`scripts/postgres-full-copy/README.md` is stale on this figure** — it still states 353,220 rows for 2026-08-04. It is deliberately NOT corrected here: `scripts/` is inside the deploy allowlist, so editing it would ship and restart the application, which a docs-only change must not do. Correcting it belongs in a change that intends a restart.

### IN-SQL ARITHMETIC MONEY WRITES ARE SAFE UNDER DECIMAL — RESOLVED 2026-08-08

**The open design question left by "A CONVERTER CANNOT REACH SQL-SIDE MONEY EXPRESSIONS — STRUCTURAL LIMIT 2026-08-05" is closed.** That entry said the mechanism for SQL-side money expressions was open and deliberately unanswered. The answer is that **no mechanism is needed** while money is stored as decimal yuan. That entry is left standing and is superseded by this one, not edited.

**THE REASON, AND IT IS NOT THAT THE CONVERTER HANDLES THEM.** The converter cannot reach these expressions and does not need to. Every operand in every one of them is `cls: NUM6` — `REAL` in SQLite, `numeric(14,6)` in Postgres — so both sides are already the same decimal-yuan unit. Yuan ± yuan = yuan. There is no rescaling to perform on the write side at all, which is the same point recorded above in the decimal decision: decimal removes the rescaling from the converter, leaving it a read-side type-coercion job because the Postgres driver returns `numeric` as text.

**THE TWO SETS ARE DISTINCT AND MUST NOT BE MERGED — this is where earlier counts went wrong.** There are two separate groups of five in the entries above, with no overlap between them. Counted at head `fd907e09` by relocating every site by content, since the 2026-08-05 line numbers have drifted:

| set | what | distinct statements | sites |
|---|---|---|---|
| A — refund path, converter-unreachable | the five named in the structural-limit table above | **5** | `routes/retail.js` 23930, 24220, 24257, 24280, 24929 |
| B — store credit, unit-sensitive | the "five `ROUND(..., 2)` sites" on `retail_customers.balance` | **3** | `routes/retail.js` 10046, 15510, 27161 |

**Eight distinct statements, not three.** Only set B was ever double-counted, and the reason is exact: `10046` and `15510` each carry the `ROUND` construct **twice** — once in `SET`, once in the `WHERE` floor-check — so 2 + 2 + 1 = five expressions across three statements. Set A's five are five genuinely distinct statements in five different code paths and were never over-counted.

**SET A IS NOT ALL `balance ± amount`. The shapes differ, and only the classification is uniform.** `23930` is `MIN(amount, COALESCE(refunded_amount, 0) + ?)` with a `CASE WHEN amount <= COALESCE(refunded_amount, 0) + ?` status flip. `24220` and `24280` are `refunded_amount = amount` — a bare column-to-column copy with **no arithmetic at all**, in two different code paths. `24257` is `COALESCE(refund_amount_approved, ?)` and its siblings, a set-only-if-unset null-choice that never combines its two operands. `24932` is `MAX(COALESCE(refund_amount_requested, 0), ?)`, a high-water mark. All five use only `MIN`, `MAX`, `COALESCE`, `+`, `<=` or plain assignment, so all five are unit-safe — but none of them is the store-credit shape.

**SET B WRITES STORED CUSTOMER MONEY. It is an `UPDATE ... SET`, not a filter.** All three are `UPDATE retail_customers SET balance = ROUND(COALESCE(balance, 0) ± ?, 2)`, writing the wallet balance a customer can spend: `10046` spends credit at checkout with an atomic overdraw floor-check in the `WHERE`, `15510` is the admin manual adjustment, `27161` returns credit on refund. There is **no `ROUND(SUM(...), 2)` construct and no `HAVING` clause anywhere in the application** — verified repo-wide, zero matches for either. Nothing in this family is a read-only filter, and treating it as one would be a serious misreading: these statements move customer money.

**THE `ROUND(..., 2)` IS CORRECT AND DROPS NOTHING THAT EXISTS.** It rounds a yuan value to two decimals — one fen, the currency's own minor unit — so float residue cannot accumulate in a column customers read. `retail_customers.balance` is bucketed `["displayed", "store credit a customer can spend"]` in `scripts/postgres-money-scale/money_bucket.json`, and the scale census recorded above found that all **89** DISPLAYED money columns hold zero values beyond two decimals. There is no sub-fen store credit in the data to lose. This agrees with the standing instruction in the decimal-scale entry above: the `ROUND(..., 2)` sites are correct under decimal yuan and must not be "fixed".

**VERDICT: zero of the eight statements need any intervention.** Five are unit-safe arithmetic or plain copies; three are unit-sensitive by classification but already correct on a displayed yuan column.

**THE GUARANTEE IS CONDITIONAL, AND THIS IS THE PART THAT MATTERS LATER.** It holds only while every operand stays decimal yuan. If any of these columns' storage unit changes, all eight statements return to being live money defects and must be re-examined before that change ships. The 2026-08-05 structural limit was correct on the day it was written, when the target was bigint cents; the decimal reversal is what dissolved it, not any change to these statements.

**ONE ITEM PARKED, AND IT IS DIALECT RATHER THAN UNITS.** PostgreSQL has `round(numeric, int)` but no `round(double precision, int)`. Set B should resolve to `numeric`, since `balance` is `numeric(14,6)` and `COALESCE(numeric, 0)` stays numeric, but if the driver types the bound parameter as `float8` the expression degrades to double precision and the statement errors. That belongs to the parked Postgres-dialect work, not to the converter, and its failure mode is a loud error rather than a silent miscalculation.

### READ-SIDE MONEY CONVERTER — DECIDED 2026-08-08

PostgreSQL returns `numeric` as **TEXT** (type OID 1700) and the application needs numbers. This settles how that conversion happens, and closes the read-side half of the converter left open by the decimal decision above.

**DECIDED: convert by DRIVER-RETURNED TYPE, with a value-size guard.** A single global `pg` type parser is registered for OID 1700 at module load — not a per-query mechanism, not a per-column one, and not a hand-maintained money-column list. The parser turns numeric text into a JS number unless the value is too large to represent exactly as a JS number, in which case it is left as text.

**WHY TYPE RATHER THAN A COLUMN LIST — the sets are identical, so type dispatch IS the money list.** Measured across all **162** tables of `scripts/postgres-full-copy/plan.json`: the `numeric(14,6)` set and the `cls: NUM6` money set are the same set, **101 both ways, with nothing on either side**. Every non-money float — quantities, weights, percentages, coordinates — is `double precision` (OID 701) and already arrives as a number, so a 1700 parser never sees one. The four surviving `*_cents` billing columns (`billing_invoices.amount_cents`, `billing_plans.price_cents`, `plans.price_cents`, `tenants.setup_fee_cents`) are `integer`, already numbers, and a 1700 parser cannot reach them, so they cannot be double-handled. There are **zero `bigint` columns anywhere**, so the driver's int8-as-text behaviour is moot here. Type dispatch therefore selects exactly the money set **by construction rather than by a list anyone has to maintain**, which is the property the column-list approach could not offer.

**THE MECHANISM IS THE DRIVER'S OWN DEFAULT PATH, verified on the installed version.** `pg` **8.22.0** with `pg-types` **2.2.0**. `getTypeParser(1700)` resolves to `noParse` and returns the string — confirmed by probing the installed module, not inferred from documentation. `pg-protocol` reads a `dataTypeID` per field into `Field(name, tableID, columnID, dataTypeID, …)`, and `pg/lib/result.js` resolves `types.getTypeParser(desc.dataTypeID, desc.format)` once per column per query and applies it per value. A global `setTypeParser` is consulted on that path automatically. For the record, `Field` also carries `tableID` and `columnID`, so table-qualified dispatch stays available if this ever needs narrowing.

**WHY THE SIZE GUARD — and the rationale is NOT what an earlier draft of this entry claimed.** No stored value can overflow: `numeric(14,6)` caps at 99,999,999.999999, roughly eight orders of magnitude below `2^53`. There is also **no numeric-typed identifier column in the database** — checked across all 162 tables, every `numeric` column is money, and there is no bare unbounded `numeric` column at all. The guard is kept for a narrower and genuinely open case: **`numeric` is unbounded as an EXPRESSION type even though every column is `numeric(14,6)`**, so an aggregate such as `SUM()` over money can return a value no column could hold, and a query the parser has never seen can therefore hand it something oversized. The guard covers that automatically, and covers future schema additions, which an explicit carve-out list of known columns would not. That is the same reasoning that rejected a money-column list, applied to the same failure shape. Note that `COUNT(*)` returns `bigint`, not `numeric`, so it arrives as text already and is unaffected.

**PRECISION IS SAFE FOR MONEY.** Every value `numeric(14,6)` can hold round-trips through `Number` exactly: 14 significant digits sits inside float64's roughly 15.95, and the maximum expressed in micro-units is two orders of magnitude below `2^53`. Verified against the real extremes recorded in the scale census above — largest value **76,105.69**, deepest genuine precision **6** decimal places, and the type ceiling **99,999,999.999999**, all exact in both directions.

**CONSEQUENCE, AND IT IS NOT SOLVED BY THIS DECISION. Parsing exactly is not computing exactly.** Once values are JS numbers, float arithmetic applies: `0.01` summed 1000 times yields 9.999999999999831. The float-money defect moves out of storage and into application arithmetic rather than disappearing. Whether exact money arithmetic is required — and therefore what the parser's output type should be — is a **SEPARATE open question, deliberately not settled here**. It is recorded so the parser is not mistaken for a fix to money arithmetic.

**INSTALL POINT.** Registration lives in the module that owns the Postgres pool, at module load, so requiring the module arms the parser and no caller can obtain a connection without it. `setTypeParser` mutates the shared `pg-types` registry and is read per column on every query, so **one call covers every connection and every pool, process-wide**. The only ordering requirement is that it run before the first query, which module-load registration guarantees.

**STATE AT DECISION TIME.** `pg` 8.22.0 is installed on the box and **entirely unused** — zero `require('pg')` in application code, no pool, no client, no connection string. The converter is **inert until the Postgres cutover**: against SQLite, better-sqlite3 already returns `REAL` as a number, so both directions are no-ops today. Seating it early is safe but proves nothing. **The test that matters is a run against the Postgres driver, not against the live box.**

### `retail_vouchers.value` IS POLYMORPHIC MONEY OUTSIDE THE MONEY SET — GAP RECORDED 2026-08-08

**Recorded, not fixed.** `retail_vouchers.value` is money for some rows and not others, and its unit is decided by a sibling column: `type = 'fixed_amount'` makes it **yuan**, `type = 'percent'` makes it a **percentage**. Both readings are live in `routes/retail.js` — rendered as `'¥' + value` and as `value + '%'` on adjacent lines, and applied as a discount amount in one branch and as a percentage clamped to 0–100 in the other.

**It sits OUTSIDE the 101 money columns and is stored `double precision`, not `numeric(14,6)`.** Two consequences follow, and they point in opposite directions.

**It is harmless to the read-side converter.** `double precision` is OID 701 and already arrives as a JS number, so there is no text to parse and the 1700 parser never touches it. The decision above is not weakened by it.

**But it keeps the float storage the decimal rebuild removed everywhere else.** Every other money column moved to exact decimal; this one did not, because the census classified it by column type and it was never typed as money. So the float-money defect survives in this column specifically, on the yuan half of its rows.

**The deeper reason it resists the general rule: no column-level unit rule can describe it.** Every mechanism recorded in this section — the money-column roster, type-based dispatch, the census `cls` field — assigns one unit per column. This column's unit depends on another column's *value*, per row. Whatever fixes it cannot be a column classification; it has to split the column, or carry the unit with the value.

**Not fixed here because it is a schema and data change, not a documentation one**, and because the read-side decision above does not depend on it. Recorded so it is found deliberately rather than discovered by a wrong total.

### CUTOVER SEQUENCING — THE SWITCH CANNOT BE A CONFIG FLAG — DECIDED 2026-08-08

**The Postgres cutover CANNOT be delivered as a config-flag switch.** Every entry above that speaks of a cutover assumed, without stating it, that the application could be pointed at a different database by configuration. It cannot. **PATH A IS CHOSEN:** convert the data layer to an async contract **against SQLite first**, ship and stabilise, and only then add the database switch. **The flag is the LAST step, not the first.** No earlier entry is edited; this supersedes the sequencing implied by them.

**THE BLOCKER.** `better-sqlite3` is synchronous and in-process; `pg` is asynchronous because PostgreSQL is a socket protocol. Node offers no way to satisfy a synchronous signature with an asynchronous driver — there is no blocking await. Measured at head `e76ba55b` across runtime code only (`routes/`, `lib/`, `middleware/`, `server.js`, `database.js`):

| measure | count |
|---|---|
| `.prepare(` sites | **2,739** |
| terminal calls (`1,603` `.get` + `637` `.all` + `1,070` `.run`) | **3,310** |
| `.exec(` sites | **246** |
| `db.transaction(` sites | **131** |
| route handlers | **761**, of which **4** are `async` (0.5%) |

`routes/retail.js` alone holds **1,241** `.prepare(` sites — **45.3%** of the runtime total — across **29,681** lines.

**`lib/db-seam.js` IS THE PROOF OF THE LIMIT, NOT THE SOLUTION.** It already proxies every statement in the application and still cannot change what a call returns: `lib/db-seam.js:108` forwards `value.apply(target, args)` directly to the driver. A wrapper can change WHICH driver runs. It cannot make an asynchronous driver satisfy a synchronous call signature. That distinction is the whole of this entry.

**THE FINDING THAT SHAPES THE WORK — VERIFIED BY EXECUTION, NOT BY REASONING.** `better-sqlite3`'s `transaction()` silently ACCEPTS an async function. It returns a Promise, commits the synchronous prefix immediately, and does NOT roll back when the async body throws. Run against a scratch in-memory database: a row inserted before an `await` **survived a transaction whose body then threw**, with no error raised anywhere.

**CONSEQUENCE — the obvious incremental strategy is unsafe.** Converting call sites file by file would mean introducing `await` inside transaction wrappers one at a time, and any single such `await` silently voids that transaction's atomicity with nothing failing loudly. **A partial migration is more dangerous than no migration.** The **131** transactions must be redesigned deliberately AS ONE UNIT, not drifted through.

**THE ORDER THAT WORKS:**

1. Define an async data-access contract both drivers can satisfy.
2. Convert the 131 transactions as a single deliberate unit.
3. Convert call sites behind that contract **while still on SQLite** — where an async wrapper over a synchronous driver is trivially correct and provable.
4. Only then add `TACET_DB` to select the driver, at which point cutover AND rollback are genuinely a setting plus a restart.

**WHERE THE SWITCH WILL EVENTUALLY LIVE: the construction point.** Not `lib/db-seam.js`, which receives an already-built handle and can neither substitute a driver nor alter return types. Not `database.js` as it stands: it exports the live handle at `database.js:4742` (`module.exports = db`) after running 51 migrations against it at module load, so a branch there hands a different shape to every requiring file — **49** in runtime code, **96** including `scripts/`. The form the flag should take is `lib/tenant-db.js:87` — `const DATA_ISOLATION_READY = process.env.TENANT_DATA_ISOLATION === '1';` — read once at module load and exported as a constant, the same shape `lib/pg.js` already uses.

**PATH B REJECTED — route-by-route migration.** Running new routes on Postgres while old routes stay on SQLite avoids the up-front rewrite, but it means two live databases during the transition: which database owns which table, and what happens to a write spanning both. That replaces a bounded one-time job with an ongoing consistency problem, against live money. Rejected on that trade, not on effort.

**WHAT THIS DOES NOT INVALIDATE.** The decimal schema rebuild, the money conversion and its verification, the read-side type converter in `lib/pg.js`, and the `tacet_app` least-privilege login are prerequisites under either path. All remain correct and done. This entry changes the ORDER of what follows them, not their standing.

**NEXT STEP RECORDED.** Scope `routes/retail.js` on its own before planning the rest. At 1,241 statement sites and 29,681 lines it is roughly half the conversion by itself, and any estimate made without understanding that file is a guess.

**FIGURES CORRECTED WHILE WRITING THIS ENTRY, named so they are not re-derived from the draft.** Three did not survive checking against the code. (a) `routes/retail.js` is **29,681** lines, not ~19,000. (b) The files requiring `database.js` number **49** in runtime code and **96** including `scripts/`, not "100+". (c) **`TENANT_DATA_ISOLATION` is set to `1` in the production `.env`** — the precedent flag is ON, not "stayed at 0 since written". That inverts the point it was offered for: the precedent shows a flag of this shape DOES get flipped once the work behind it lands, which supports putting the switch last rather than arguing against it.

### `TENANT_DATA_ISOLATION` IS ON IN PRODUCTION — RECORD CORRECTED 2026-08-08

**The flag is `1` on the live box.** Read from the production `.env`: `TENANT_DATA_ISOLATION=1`, so `DATA_ISOLATION_READY` (`lib/tenant-db.js:87`) resolves **true** at runtime. Several lines above and in other documents state or imply it is off. Those lines are left standing and are superseded by this entry, not edited.

**WHY THE RECORD DRIFTED, AND IT IS NOT CARELESSNESS.** The flag is set in the box's `.env`, which is gitignored and therefore invisible to any survey of the repository. Statements elsewhere that it is "set nowhere in the repo or the deploy workflow" are **literally true and remain true** — and were still misleading about production, because the repo is not the whole configuration. Any future claim about a runtime flag's value has to be read from the box, not inferred from the tree.

**WHAT THE FLAG ACTUALLY GATES — three sites, no others.**

- `server.js:253-262` — a safety gate. With the flag **off** it redirects non-Roots backend accounts away from `/retail-admin`, `/product-editor` and `/cms` and 403s their API calls. With it **on**, `if (tenantDb.DATA_ISOLATION_READY) return next();` fires first and the lockout is **lifted**. Counter-intuitively, ON means *less* restriction here, because the gate exists only to hold accounts out until isolation is trusted.
- `routes/retail.js:72-86` — customer storefront scoping. With the flag on, this middleware maps the mini-app's `x-wx-appid` header to a tenant and runs the request inside that account's DB scope. Line 82 short-circuits for Roots: `if (!tid || tid === ROOTS_TENANT_ID) return next();`.
- `lib/inventory.js:1021-1025` — the reservation sweeper. With the flag on, the boot+interval timer additionally iterates `activeNonRootsTenantIds()` and runs the sweep inside each account's scope. This is the one path that would open a per-account file with **no HTTP traffic at all**.

**THE LIVE STATE: ARMED BUT UNUSED. The isolation path is NOT serving traffic.** Measured read-only on the box:

- The `tenants` table holds **exactly one row** — id 1, Roots, `active`, with **no `wx_appid` set**.
- **Active non-Roots accounts: 0.** So `activeNonRootsTenantIds()` returns empty and the sweeper loop body never executes; and `routes/retail.js:79`'s lookup can never match, so line 82 always short-circuits to unscoped.
- The running process holds **0 open file descriptors under `data/tenants/`** and **3 on `data/roots.db`**.

`lib/tenant-db.js:190-198` is why this is structural rather than coincidental: `rawTenantDb()` returns the shared `mainDb` for id 1 and only reaches `openTenantDb()` for an id that is not Roots. **Roots can never open a per-account file, flag or no flag.** With one account and that account being Roots, every code path the flag unlocks resolves to the shared `roots.db`.

**SO THE PRACTICAL EFFECT OF THE FLAG BEING ON IS EXACTLY ONE THING:** the `server.js` lockout is lifted. There are currently no non-Roots accounts for it to lock out, so even that is latent. Nothing else about live behaviour differs from the flag being off.

**ORPHANED FILES ON DISK — recorded, not cleaned up here.** `data/tenants/` still contains `2.db`, `4.db`, `5.db`, `6.db`, `7.db` (roughly 1.5–1.7 MB each, mtimes from 2026-07-05 to 2026-08-05) plus a zero-byte `roots.db`. The test-account **rows** were deleted from `tenants`; the **files** were not. None is open by the running process, and with no matching rows nothing can route to them. They are inert, and they hold test-account data rather than live data. Removing them is a filesystem change and is deliberately not made by this documentation entry.

**THE VERDICT THIS OVERTURNS.** `docs/tacet-multibusiness-audit.md` records finding **B2 as a BLOCKER** on the grounds that the flag defaults off and is set nowhere, so a second business would log in and see only a billing page. **On the live box that is no longer the case** — the flag is on and the lockout is lifted. The B2 finding is not restated correctly here beyond this: it is superseded as to the live box, and the audit's own line is left standing. What has NOT been verified is whether a non-Roots account would actually *work* end to end with the gate lifted; nothing has ever exercised that path in production, because no such account exists.

**A CITATION THAT HAS DRIFTED.** Several documents cite `lib/tenant-db.js:41` as the flag's declaration. At head `4f7305bf` line 41 is an unrelated comment; the declaration is **`lib/tenant-db.js:87`**.

**WHAT THIS DOES NOT CHANGE.** The retirement of file-per-account isolation recorded above still stands — this entry corrects the record of what is switched on today, and takes no position on whether that machinery should live. The cutover sequencing decided above is likewise unaffected: it concerns the SQLite-to-Postgres driver gap, which is independent of per-account routing.

### NO ACCOUNT IS SPECIAL-CASED, INCLUDING ROOTS — REQUIREMENT RECORDED 2026-08-08

**The current code special-cases Roots by id.** `lib/tenant-db.js:192` reads `if (!id || id === ROOTS_TENANT_ID) return mainDb;`, so account 1 can never be routed to a per-account database regardless of configuration, and `routes/retail.js:82` short-circuits identically with `if (!tid || tid === ROOTS_TENANT_ID) return next();`.

**This was a deliberate safety shortcut, and it is worth saying why rather than treating it as sloppiness.** Roots was live and trading while the isolation machinery was new and untrusted; making account 1 structurally unreachable by that machinery meant no bug in it could touch the only real business on the system. That was the right call at the time. It nevertheless conflicts with **§0 Governing rules, rule 2** — *"TACET IS NOT BUILT FOR ROOTS. Roots is one customer that happens to be first. Nothing about Roots' business ... may be assumed, hardcoded or treated as the default."* Rule 2 enumerates business attributes — products, city, language, currency, channels, suppliers, ways of working — and does not literally name an account id. Extending it to routing identity is the point of this entry: an id-shaped exception is the same defect in a different place, and "treated as the default" covers it.

**NOT FIXED NOW, BY DESIGN.** The special case lives inside the file-per-account machinery in `lib/tenant-db.js`, which the PostgreSQL decision supersedes and which is deleted in a later phase — recorded above in this section. Fixing it separately means writing code for a system already scheduled for removal. Under one shared database with every row carrying its account, there is no "which file does this account use" question for the exception to attach to, so it disappears with the machinery rather than needing to be unpicked.

**THE REQUIREMENT THIS PLACES ON THE NEW SYSTEM.** When shared-database account scoping is built, **no account may be special-cased** — not by id, not by name, not by a "first account" or "default account" shortcut, and not by a Roots-shaped fast path. Roots must be routed, scoped and enforced by exactly the same code as every other account. **If any part of the new implementation needs to know that an account is Roots in order to work, that is a defect, not an optimisation.** Recorded so the exception is not rebuilt out of habit when the machinery is replaced — the shortcut was reasonable once, which is precisely what makes it likely to be reintroduced.

**`ROOTS_TENANT_ID` IS THE MARKER TO WATCH.** The constant is declared at `lib/tenant-db.js:78` (`const ROOTS_TENANT_ID = 1;`) and is retired with the machinery that needs it. **Any surviving reference to it in the new system is a signal that the special case has been carried forward.** That makes the check mechanical rather than a matter of judgement: grep for the identifier, and if it appears in shared-database scoping code, the requirement above has been violated.

**A NOTE ON SCOPE.** This entry records a requirement on work not yet begun. It changes no code, reverses no decision, and takes no position on when the file-per-account machinery is removed — only on what must not reappear when it is.

### ROUTE HANDLER ASYNC COUNT — CORRECTED 2026-08-08

**The handler figures in the cutover-sequencing table above are wrong and are superseded here, not edited.** That table records **"761, of which 4 are `async` (0.5%)"**. The 4 came from a grep that matched `async` only where it followed the first comma, so it missed every handler carrying middleware — `router.post('/x', requireAuth, async (req, res) => …)` — which is the common form.

**Measured by AST across `routes/`: 756 handlers, 72 already async (9.5%).**

**The conclusion of that entry is unaffected — 684 handlers remain synchronous** — but existing async adoption was understated roughly twentyfold, and a plan sized on "0.5% done" would have been sized against a false baseline.

**On the two totals, because they measure slightly different things and both are defensible.** 756 counts inline handler *function literals*. 761 counted `router.<method>(` *registrations*, some of which pass a named function reference rather than a literal — `routes/ai.js:747` registers `composeBlocksHandler` that way. Neither number is wrong for what it counts; the async proportion is the part that was.

**METHOD NOTE, AND IT IS THE DURABLE POINT.** Grep is not a reliable instrument for structural questions about a 29,681-line file. It cannot see nesting, argument position, or whether a match sits inside a function, a callback or a transaction. Where a figure in this section describes code *structure* rather than a plain text occurrence, it should be derived from a parsed AST. Three separate figures in this section have now been corrected after being taken from greps.

### `routes/retail.js` CONVERSION SCOPE — SURVEYED 2026-08-08

**29,682 lines, flat, with no feature grouping.** 327 route handlers (276 of them synchronous), 974 top-level statements, 394 named top-level functions. It holds **1,241 of the 2,739 runtime `.prepare()` sites** — 45.3%, so roughly half the Path A conversion sits in this one file.

**CALL SITES BY CONVERSION DIFFICULTY** — AST-derived, hardest class wins, totals reconcile exactly to 1,241:

| class | count |
|---|---|
| simple | **623** |
| inline-dereferenced | **129** |
| inside a synchronous helper | **349** |
| inside a transaction | **137** |
| inside a sync array callback (`.map`/`.forEach`) | **2** |
| module-level | **1** |

**The 349 and 137 are FLOORS, not totals.** Classification was by *nearest* enclosing function, not by transitive reachability, so a site counted "simple" may still be reachable only through a synchronous helper further up the chain. The true cost of both classes is higher than stated.

**STEP ZERO — BEFORE ANY CALL SITE MOVES.** Express is **4.22.1** and does **not** catch rejections from async handlers, and there is **no async-error wrapper anywhere in the repository** — no `express-async-errors`, no `asyncHandler`, no `catchAsync`. **207 of the 327 handlers contain no `try`/`catch` at all.** Making those async without a wrapper turns any database error into an unhandled rejection and a request that **never responds** — the client hangs until timeout. The crash guards in `server.js` log and page, but the request is already lost. This failure surfaces only under load or on an error path nobody exercised, so spot-checking after a conversion will not find it. **An `asyncHandler` wrapper, adopted across all 327 handlers while they are still synchronous, is a safe no-op change and the prerequisite for everything after it.**

**THE IRREDUCIBLE CORE — small, and everything else follows mechanically once it is settled:**

- **Six helpers called BOTH inside and outside a transaction** — `writeLayout` (3 in / 6 out), `reconcileTier` (3/1), `productContentSnapshot` (2/2), `ensureShipments` (1/10), `generateRetailSku` (1/1), `createOrReuseManualCustomer` (1/1). Inside a transaction they must participate in it; outside they stand alone. Each needs a dual form or a moved transaction boundary. **Six design decisions with no mechanical answer, and the wrong answer voids atomicity silently.**
- **`cfgValue` (`routes/retail.js:8206`)** — one `.prepare()`, **57 call sites**. Converting it cascades through most of the file.
- **`requireRetailAdmin` (`routes/retail.js:98`)** — DB-touching middleware imported by **nine** other route files: `ai.js`, `eleme-admin.js`, `guanyi-admin.js`, `integrations-admin.js`, `meituan-admin.js`, `retail-inventory.js`, `retail-page-templates.js`, `retail-purchasing.js`, `retail-setup.js`. Its blast radius leaves this file.

**TRANSACTIONS: 56 blocks here, of the 131 runtime-wide.** Thirty-six hold 1–4 statements; fourteen hold no direct statement at all; the densest are `L9853` (11), `finalizeOrderAddon` (10), `L29583` (9) and `L29329` (6). The named-function transactions cluster on money and stock — `creditWallet`/`debitWallet`, `awardOrderPoints`/`reverseOrderPoints`, `finalizeTopup`, `finalizeOrderAddon`, the reversal family, `sweepExpiredPoints`, `claimMigrationCredit`. **Two of the fourteen empty-looking blocks (`L18133`, `L18163`) contain no direct `.prepare()` but still do database work through `writeLayout`** — a statement-level grep would report them as empty.

**CROSS-FILE REACH is small but real.** `requireRetailAdmin` reaches nine files, above. `retailLiveBump` is called fire-and-forget inside `try {}` from `lib/inventory.js:869` and `routes/backend-auth.js:600` — if it becomes async those `try` blocks stop catching and the rejection escapes.

**CONVERSION ORDER — LEAVES-FIRST IS WRONG HERE AND MUST NOT BE USED.** Converting the cheap leaves first leaves the transaction redesign to be done against a half-converted codebase, which is precisely the partial state recorded above as voiding atomicity without erroring. The order that works: **(0)** `asyncHandler` adopted across all handlers while still synchronous; **(1)** settle the six dual-context helpers on paper, since they determine transaction boundaries; **(2)** convert all 56 transactions as ONE unit, money cluster included; **(3)** convert `cfgValue` and the other high-fan-in helpers; **(4)** grind the ~750 mechanical sites; **(5)** `requireRetailAdmin` and `retailLiveBump` last, as they reach outside the file.

**RISK CONCENTRATES IN THREE PLACES, none of them volume:** the six dual-context helpers, where there is no correct mechanical answer; the money/points/wallet transaction cluster, where a silently voided transaction costs real money rather than a broken page; and Express 4 with 207 unguarded handlers, where a database error becomes a hung request.

### TRANSACTION AND TERMINAL-CALL COUNTS — CORRECTED 2026-08-08

**Two more figures above are wrong. Both are superseded here, not edited.** Both came from grep, and both were found by `scripts/diagnose_async_conversion_scope.js` on its first run.

**1. RUNTIME `db.transaction()` BLOCKS: 129, not 131.** The table above records 131, and the `routes/retail.js` survey repeats it as "56 blocks here, of the 131 runtime-wide". Measured by AST the runtime total is **129**. The two extra grep hits are **comments** — prose mentioning the construct, not calls:

- `lib/inventory.js:18` — *"All multi-step operations use a `tdb().transaction()` so concurrent order…"*
- `routes/retail.js:8977` — *"Callers always run this inside an (immediate) `tdb().transaction()` so the…"*

**The `routes/retail.js` figure of 56 is CORRECT** — the 57th grep hit there is the comment above. Only the runtime total was wrong, so the retail.js share of the transaction work is larger than recorded, not smaller: 56 of 129.

**2. TERMINAL CALL COUNTS ARE BY-NAME AND SUBSTANTIALLY OVERSTATE DATABASE TERMINALS.** The table above records "1,603 `.get` + 637 `.all` + 1,070 `.run` = **3,310**" and "246 `.exec()`". Those count **every member call with that name anywhere in the runtime code**, which includes `Map.get()`, `req.get()`, `RegExp.exec()` and similar — none of which is a database call or has anything to do with the async conversion.

Both measures, so the difference is on the record rather than needing re-derivation:

| terminal | chained off a `.prepare()` (database, unambiguous) | by name anywhere (what the grep counted) |
|---|---|---|
| `.get` | **1,061** | 1,602 |
| `.all` | **631** | 637 |
| `.run` | **880** | 1,061 |
| **total** | **2,572** | 3,300 |

`.exec()` by name is 246 and includes `RegExp.exec`; there is no meaningful "chained" measure for it, since `exec` takes no prepared statement.

**The by-name AST totals (3,300) also differ slightly from the recorded grep totals (3,310)** because grep counts occurrences inside comments and strings that are not calls at all. **The conversion job is therefore somewhat SMALLER than the recorded figure implies** — roughly 2,572 database terminals rather than 3,310, about 22% fewer.

**METHOD NOTE — THIS IS THE FIFTH GREP-DERIVED ERROR IN THIS SECTION.** The earlier four were the `routes/retail.js` line count, the route-handler async proportion, the 1–4-statement transaction distribution, and the `requireRetailAdmin` importer count. These two make five and six. Every one of them was a **structural** question — does this match sit inside a function, a comment, a transaction, a particular argument position — and grep cannot see any of that.

**`scripts/diagnose_async_conversion_scope.js` IS THE AUTHORITY FOR THESE COUNTS FROM NOW ON.** It parses the AST with `espree` and regenerates every figure in the two entries above: prepare sites per file, terminal calls in both measures, transaction blocks with per-block statement counts and enclosing function, route handlers as both inline literals and registrations, handlers without `try`/`catch`, the six-way call-site classification with its evaluation order stated in the output, synchronous DB-touching helpers with caller counts, and the dual-context helper set. It is read-only, opens no database, and writes only its report. **§24 figures should cite it rather than a grep.** It found both errors above on its first run, which is the argument for having committed it.

**ONE LIMIT OF THE SCRIPT, STATED SO IT IS NOT MISREAD AS AUTHORITY IT DOES NOT HAVE.** `espree` is not declared in `package.json`; it arrives transitively with the `eslint` devDependency. The require is guarded and exits with an explanation where it is absent, which includes the production box — the box installs production dependencies only, and `scripts/` ships there regardless. Nothing in the application calls it. Declaring `espree` was considered and rejected: `package.json` is in the deploy allowlist, so declaring it would ship and restart the application for the sake of a diagnostic.

### DUAL-CONTEXT HELPERS — DECIDED 2026-08-08

**Path A step 2 is settled.** Symbols are named rather than cited by line: `routes/retail.js` moved by 51 lines between the survey and this entry, and every line number in the survey went stale. Find these by name.

**THE RULE: every one of the six helpers called both inside and outside a transaction takes the database handle AS AN ARGUMENT.** The caller passes the handle it is using — inside a transaction, the transaction's handle; outside, the ordinary one. No dual forms, no helper reaching for its own handle, no exceptions.

**THE SIX:** `writeLayout`, `reconcileTier`, `productContentSnapshot`, `ensureShipments`, `generateRetailSku`, `createOrReuseManualCustomer`. (`productContentSnapshot` already takes its handle this way; the rule generalises what it does.)

**WHY ONE RULE RATHER THAN THREE.** The survey grouped them by what each needs from the enclosing transaction: one needs to **SEE** uncommitted state (`productContentSnapshot`), three need their **WRITES** to roll back with the outer (`writeLayout`, `createOrReuseManualCustomer`, `ensureShipments`), and two need **NOTHING** (`reconcileTier`, `generateRetailSku`). The last two are exempt on their merits and were included anyway. **"All helpers take the handle" applies without judgement; "most do, except the two that don't need it" requires a per-helper judgement that is demonstrably easy to get wrong** — see the read-only trap below. Uniformity costs two unnecessary parameter changes and removes a class of future error.

**THE READ-ONLY TRAP — recorded because it is counter-intuitive and it is the reason the rule has no exceptions.** Grouping these by read-only versus writing is **WRONG**. `productContentSnapshot` and `generateRetailSku` are both single-`SELECT` read-only helpers, and they sit at opposite ends of the risk ranking. `productContentSnapshot` is called twice inside `POST /api/retail-admin/products/:id/restore-version`: once before `apply()` and once **after**, and the second call must see the outer transaction's uncommitted `UPDATE`. On a separate connection it reads the pre-restore row, and the version recorded as "newest === live" is the **OLD** content. Nothing errors; the edit history is silently wrong. **Read-only is not a proxy for transaction-safe.**

**WHY THIS IS NOT A BUG TODAY.** better-sqlite3 nests transactions as **SAVEPOINTs** — verified by execution on the box, twice, at two different heads: an inner transaction rolls back with a failing outer one and commits standalone. Current behaviour is therefore correct in both contexts for free. The problem is specific to PostgreSQL, which has no implicit nesting and where a separately-checked-out connection cannot see the outer transaction's uncommitted rows. **Current behaviour is the behaviour to PRESERVE, not to redesign.**

**REQUIRED COMMENT.** Each of the six carries a comment stating WHY the handle is a parameter. Without it the parameter reads as redundant and will be refactored away by someone tidying — and the resulting failures are silent (wrong version history, orphan rows, a half-published storefront), not loud.

**SEPARATE FINDING — A LATENT BUG, NOT A CONVERSION DECISION.** `PUT /api/retail-admin/cms/onboarding-settings` issues up to **three** `storefront_config` writes with no transaction: `onboarding.show_to`, then `onboarding.next_label.en` and `.cn`, each either an upsert or a `DELETE`. A failure partway leaves the mode changed and the labels not, or one language updated and the other not. Its sibling `POST /api/retail-admin/brand/apply` **is** wrapped, with two `writeLayout` calls inside one transaction — so the pattern is established and this handler simply misses it. A fix to schedule, independent of the async conversion. Re-verified at head `63f0f774`: the handler contains no `transaction(` call.

**ALSO NOTED, NOT ACTED ON.** `reconcileTier` swallows its own errors in a `try`/`catch` that only `console.warn`s, so an outer transaction can never learn its write failed — including inside `awardOrderPoints`, which writes `lifetime_spend`, a money column. Harmless today because the tier self-heals on the customer's next authenticated request via `requireRetailAuth`. The swallow is the thing to revisit if that helper is ever made to matter more.

### TRANSACTION HELPER — BUILT AND PROVEN 2026-08-09, UNUSED

**Path A step 3 begins with one helper that every transaction will use.** It is committed but **nothing requires it yet, deliberately**: all 56 will inherit its behaviour, so a flaw in it would propagate silently to every one of them at once. Proving it while nothing depends on it is cheap; proving it afterwards is not possible.

**THE 56 ARE `routes/retail.js`'s 56, not an application-wide total** — of the 129 runtime blocks recorded above under TRANSACTION AND TERMINAL-CALL COUNTS. Re-measured by AST at head `064817f0`: 56 `db.transaction()` blocks in that file, **9** of whose bodies return a value, and **1** `.immediate()` call site.

**SIGNATURE: `await withTransaction(db, async (tx) => { ... return value })`.** The handle is an argument — the DUAL-CONTEXT HELPERS rule above, applied one level up. It is **async today even though SQLite is synchronous**, so the 56 call sites are written once in their final shape and the PostgreSQL cutover changes none of them. **The body receives `tx`**: on SQLite it is the same object and looks redundant; on PostgreSQL it will be the checked-out client, and a body that closed over the pool instead would run **OUTSIDE its own transaction** while staying green in any non-concurrent test. That is the load-bearing reason the parameter exists, and it is the same hazard the required comment above guards against — it will read as removable to anyone tidying.

**IT ISSUES `BEGIN`/`COMMIT`/`ROLLBACK` ITSELF AND MUST NOT USE better-sqlite3's `db.transaction()`.** Two reasons, both verified by execution rather than assumed. **(i)** On the real native driver on the box, `db.transaction()` with an async body **COMMITTED the insert and left `inTransaction` false** — the wrapper commits when the call returns, and an async function returns at the first `await`, so it does not roll back after one. Since making these bodies async is the entire point of the conversion, the wrapper is not merely unhelpful here, it is unsafe. **(ii)** The test harness's fallback driver `node:sqlite` has **no `.transaction()` at all**, so anything built on it could only be tested on the box — the machine the harness exists to avoid depending on. `node:sqlite` also lacks `.inTransaction`, so **nesting depth cannot be read from the driver** and is tracked in a `WeakMap` keyed by handle. Nesting itself is reproduced explicitly with `SAVEPOINT`, in the verbose `ROLLBACK TO SAVEPOINT` / `RELEASE SAVEPOINT` forms that PostgreSQL requires and SQLite accepts.

**SERIALISATION IS REQUIRED, NOT AN OPTIMISATION — DO NOT REMOVE IT.** The helper serialises outermost transactions per handle. A SQLite transaction belongs to the **CONNECTION**, and the application shares one handle. Today this is invisible because everything is synchronous and each transaction runs to completion uninterrupted. **The moment a transaction body contains an `await` — the entire point of this conversion — a second request can begin its own transaction on the same handle mid-flight, and one block's `ROLLBACK` then discards the other block's writes.** That is real money lost with no error raised. A test demonstrates it. Anyone later reading the serialisation as a throughput bottleneck and removing it **reintroduces silent money corruption**. Nested calls deliberately do not queue; queueing them behind the holder would deadlock.

**PROVEN: 28 assertions**, covering commit; rollback with no partial state; return-value propagation (the 9 bodies above, including the checkout's `orderId`); typed errors surviving rollback with `e.code` / `e.product_id` / `e.available` intact, plus object identity and subclass prototype; early return still committing; two-sided nesting (an inner block rolls back with a failing outer, and the same body commits standalone); every statement running on the supplied handle, proven with a `Proxy` spy on the control statements; and the serialisation case above. **Green on BOTH drivers. Red proven on both** via `TX_TEST_SABOTAGE=1`, which flips one expected value and exits 1 — a green suite means something because a broken one has been shown to go red.

**TESTING IS A TWO-MACHINE OPERATION.** The two drivers are **mutually exclusive per machine**: `node:sqlite` needs Node 22+ and the box runs Node 20; the box has the native binding and the development machine does not. **Neither machine can run both.** Full coverage therefore requires running the suite in both places. Hooked as a fifth npm script, `test:transaction` — no install, no network; the helper itself requires nothing at all.

**NOT COVERED, STATED PLAINLY.** **(a)** `.immediate()` — used by exactly one of the 56, the checkout at `POST /api/retail/orders`, for `BEGIN IMMEDIATE` cross-process write-lock timing that makes `nextOrderNo()`'s read-then-insert atomic. It has no PostgreSQL equivalent and needs **designing rather than translating**. **The checkout CANNOT be converted with this helper as it stands.** **(b)** The PostgreSQL backend is a **SEAM, not an implementation** — the control dispatch recognises a pg handle, but the pool checkout that makes `tx` a distinct client is neither written nor tested. "Works on both backends" is currently true **in shape, not in fact**.

### CONVERSION BATCH 2 — MERGED 2026-08-09, AND THE FIRST LIVE PROOF

**Ten inline transactions in `routes/retail.js` moved onto `withTransaction`, merged at `9e96263d`.** Batch 1 (`saveProductOptions`, `fanOutBroadcast`) was the two named-function transactions; these ten are all **inline in their own route handler**, so there is no caller chain and the blast radius is one route each. All ten are `requireRetailAdmin`-gated, none is money, none touches stock.

**THE TEN, each picked to exercise something different:** `DELETE /media/folders/:id` (two statements as one unit); `POST /media/bulk-move` and `POST /media/bulk-delete` (a counter accumulated in the closure, which still survives a rollback unread, exactly as before); `POST /media/bulk-tag` (a READ inside the body feeding its own UPDATE); `POST /categories/reorder` (a transaction ARGUMENT became a closure, since `withTransaction`'s body takes only the handle); `POST /products/reorder` (a SELECT that deliberately stays OUTSIDE — widening the transaction would be a behaviour change, not a conversion); `PATCH /categories/:id` (a UNIQUE violation that must stay a 400); `POST /polls` (a body whose RETURN value the response needs); `PUT /polls/:id` (the largest body); `PUT /config` (the `storefront_config` upsert loop).

**FIVE OF THE TEN SIT INSIDE A CATCHING TRY, AND THE `await` IS INSIDE EVERY ONE.** Batch 1 met this once; here it is half the batch, which makes it a rule rather than an incident. An `await` placed outside one of those catches does not merely change a status code — the rejection bypasses the handler entirely and is caught by the global guard, so a duplicate category rename would answer **500 instead of 400**. Each is tested for the specific status it must still produce.

**THE SHARED HARNESS HAD A DEFECT THAT WOULD HAVE MADE THIS BATCH GREEN AND WRONG.** `scripts/test-support/memory-db.js` scanned `addColumn()` with a `'(\w+)'` type pattern — single-quoted, single word. `database.js` does not write them all that way, and the mismatches were dropped **SILENTLY**: `products.sort_order` (`'INTEGER DEFAULT 0'`), `retail_polls.display_min_total` (`'INTEGER NOT NULL DEFAULT 0'`) and `retail_media.tags` (`"TEXT DEFAULT '[]'"`) were absent from the test schema, and **three of these ten routes write them**. The table is created, the suite passes, and a column the code under test writes is simply not there. The type is now read to the matching quote in either style. Two further gaps closed with it: the CREATE source is now separate from the ALTER source, because `categories` is created by `schema.sql` and only altered by `database.js`; and `store_products`, which has no literal CREATE anywhere, is built by running `database.js`'s own boot-time fork-from-`products` rule. **This is the second time a drifting test scaffold has hidden a real gap** — the first is recorded in `memory-db.js`'s own header, which is why the fix went into the shared harness rather than the suite.

**COUNT, BY AST AND NOT BY GREP: `routes/retail.js` moves 54 → 44.** Application-wide runtime `db.transaction()` blocks move 129 → 117, which reconciles exactly against batch 1's two and this batch's ten. **The batch's own commit message says 45 remain; that figure is grep-derived and wrong** — grep counts a comment that mentions `tdb().transaction()`. `scripts/diagnose_async_conversion_scope.js` remains the authority for these counts, as recorded above under TRANSACTION AND TERMINAL-CALL COUNTS, and this is a further instance of the same failure it was built to end.

**FIRST LIVE PROOF — ONE GATE, NOT TWO. CORRECTED SAME DAY, SEE BELOW.** Two gates were exercised on production after the merge. **Only one of them touched converted code.** A poll option **carrying votes** was edited and **the votes survived** — that is `PUT /polls/:id`, converted in this batch, and it proves the in-place option edit still preserves vote counts through an `await` rather than falling into the replace-all path that clears them. That is the first converted transaction body proven on production data.

**THE CATEGORY-RENAME GATE PROVED NOTHING ABOUT THIS BATCH, AND THE FIRST VERSION OF THIS ENTRY CLAIMED OTHERWISE.** The rejection message seen was "Save failed: Duplicate top category", which is emitted by `PUT /api/retail-admin/category-tree` — a route **deliberately excluded from this batch** (it uses a captured `db` rather than `tdb()`) and therefore **still on `db.transaction()`**. Its duplicate check is a **pre-flight `seenTop` scan that returns 400 before any transaction opens**, so it is not the UNIQUE-violation catch at all. The converted route with that catch is `PATCH /api/retail-admin/categories/:id`, which answers `duplicate_name` and operates on the `categories` TABLE — a different system that the test never reached. The lesson is worth more than the correction: **an error message seen in the UI does not identify the route that produced it**, and two category systems here emit similar-sounding failures from completely different code.

**BATCH 1'S TWO BODIES REMAIN UNPROVEN ON LIVE TRAFFIC, STATED SO IT IS NOT ASSUMED.** `saveProductOptions` and `fanOutBroadcast` shipped earlier and the plumbing has run, but neither body has executed on production since — no broadcast fell due and no product-options save occurred during the watch. They are proven by test and byte-identity only. The live evidence recorded here belongs to batch 2 and does not transfer to them.

### TWO CATEGORY SYSTEMS, TWO DIFFERENT DUPLICATE RULES — FINDING RECORDED 2026-08-09

**A reported duplicate — "Ready to Eat" beside "ready to eat" — DOES NOT EXIST in the database.** Checked case-insensitively in every place a category name can live: the `categories` table holds **no row matching at all**; `store_products.top_category` holds exactly one distinct value, `'Ready to Eat'`, on 20 products; `store_products.category` holds exactly one, `'Ready to Eat'`, on 16; and `storefront_config` contains the string only inside `category.tree`, which lists **one** top category `{id: "ready", name: "Ready to Eat"}` among seven with no case-insensitive collision.

**The two counts are one category measured in two different columns** — 20 by `top_category`, 16 by `category` — not two categories. Recorded because the numbers 16 and 20 reconcile exactly, and because a "duplicate" that is really one row seen through two fields is a mistake worth being able to recognise again.

**BUT THE DUPLICATE IS CONSTRUCTIBLE, AND THAT IS THE REAL FINDING: the two category systems disagree about what a duplicate is.** `category.tree` (top categories, stored in `storefront_config`) checks **case-INSENSITIVELY**, via `t.name.toLowerCase()` in `seenTop` — though only within the submitted payload, which is sufficient there because the tree is replaced wholesale on every save. The `categories` table relies on `UNIQUE(kind, name)` declared in `schema.sql` **with no `COLLATE NOCASE`**, so it is **case-SENSITIVE**: `Ready to Eat` and `ready to eat` are two permissible rows. `PATCH /api/retail-admin/categories/:id` compounds it — its self-exclusion is `name === existing.name`, an exact case-sensitive comparison, so a rename that changes only capitalisation passes the guard and then passes the constraint. **A name the tree editor rejects, the category table accepts.** Not fixed here; recorded so the inconsistency is a known one rather than a surprise, and so that any future normalisation is applied to both systems at once.

### CONVERSION BATCH 3 — MERGED 2026-08-09

**Five more inline transactions merged at `86a37ad4`**, with the points-invariants check and the `reset_test_orders.js` hardening bundled into the same deploy because `scripts/` ships on every deploy and neither is executed by the running app: `PUT /fapiao-settings`, `PUT /printer`, `POST /customers/:id/reset-test`, `POST /customers/:id/addresses`, `PUT /customers/:id/addresses/:addrId`. **`routes/retail.js` moves 44 → 39 by AST.** Deployed clean; one restart, no unstable restarts, nothing in the error log since boot. The invariants check was run against production immediately after and all three checks pass.

**FIVE OF SIXTEEN, AND THE REASON IS ABOUT EVIDENCE RATHER THAN EFFORT.** Converting all sixteen remaining safe inline transactions was reachable; converting all sixteen *and* proving each red in one pass was not. Red-proven-per-conversion is the standard that makes a batch worth shipping, so the batch was cut to fit the standard rather than the standard cut to fit the batch.

**ONE EXCLUDED ON ITS MERITS: `PUT /integrations`.** Its transaction body assigns to `process.env` alongside the `storefront_config` write. A rollback cannot undo an environment assignment, so **that body is not atomic today**, and converting it would preserve the defect while making it look repaired. It needs the env write lifted out of the transaction first — a fix, not a conversion.

**THE COUNT GUARD NOW READS THE AST AUTHORITY.** Batch 2's suite pinned the remaining count with a regex over raw source, which matches a comment mentioning `tdb().transaction()` and therefore stood at 45 while this record carried 44. It now invokes `scripts/diagnose_async_conversion_scope.js`. A regex fallback for the box — where `espree` is absent — **was written, and was wrong**: an apostrophe inside a comment unbalanced its string-stripping pass, which then swallowed real code and returned 0 against an actual 39. It was removed rather than patched; where the authority cannot run the check now reports itself SKIPPED. **A skipped check is honest; a guessed one is a liability**, and a second hand-rolled source scanner guarding against the first is exactly the mistake this record keeps re-learning.

**THE `reset_test_orders.js` HARDENING IS NOT VERIFIED, AND MUST NOT BE TREATED AS IF IT WERE.** Three guards were added — a minimum selector length, a cap of 25 accounts or 25% of the base, and `--apply` requiring a `--confirm <token>` derived from the selectors so a token authorises one set and no other. **Only guard 1 has run end to end**, because it fires before the database is opened. **Guards 2 and 3 have NOT been executed at all**: the script requires `better-sqlite3`, whose native binding will not construct on the development machine. Their logic was checked in isolation, which is not the same thing and must not be recorded as if it were. **They remain unproven until run on the box against a FIXTURE database — never the live one.** Until that happens the script's protection is asserted, not demonstrated.

### THE ADMIN CATEGORY RAIL RENDERS THE TREE ALONE — FINDING RECORDED 2026-08-09

**A duplicate row reported on the Categories screen ("Ready to Eat" beside "ready to eat", seven rows, header counting seven) CANNOT be produced by the current code and data, and the reason is worth recording because it rules out a whole class of explanation.**

**The rail is the tree, and nothing else.** `catModel` in `public/retail-admin/01-core.js` is assigned solely from `/api/retail-admin/category-tree`, and the rail is `catModel.map(...)`. **It does not harvest distinct values from `store_products`.** The harvesting code that does exist — `paFillCatFilter` in `09-products.js`, building `DISTINCT (top_category || category)` — populates the **Products screen's filter dropdown**, a different surface. **The header's "7 top categories" is `catModel.length`**, i.e. the number of tree entries, so a rail showing eight rows could not report seven.

**The stored tree holds seven entries and no case-insensitive collision**, last written 2026-07-13 — so it was not edited during the batch 2 smoke test. Per-row counts arrive from `/api/retail-admin/category-counts` and are keyed by **node id, not name**, so a name-casing mismatch cannot split one row into two.

**The two numbers are one category measured two ways.** `category-counts` filters `COALESCE(is_active, 1) = 1`, so it reports **16 active** for Ready to Eat; the column total is **20**. Active versus total, on one row.

**The customer-facing shop cannot show it either.** `slBuildSections` in `public/shop.html` iterates the tree and looks products up by exact `top_category` name; anything not matching a tree name becomes an orphan rather than a new rail row. **So this is not a live retail problem** — no phantom category can reach a shopper through that path.

**WHAT WAS RULED OUT, so the next attempt starts further along:** the tree (no duplicate), both `store_products` category columns (no lowercase value in either), the `categories` table (no matching row at all), all of `storefront_config` (the string appears only inside `category.tree`), any `text-transform: lowercase` in the admin CSS, and any client-side lowercasing in the rail. **The remaining candidates are a stale cached admin bundle — the service-worker cache hazard already recorded against admin JS — or a different screen than the one assumed.** Recorded as unreproduced rather than explained; inventing a mechanism that the code cannot support would be worse than leaving it open.

### CONVERSION BATCH 4 — MERGED 2026-08-09

**Nine more inline transactions merged at `785ff599`**: `PUT /category-tree`, `POST /api/retail/addresses` and `PUT /api/retail/addresses/:id` (both customer-facing), `PUT /products/:id/variants`, `POST /shipment-suggestion/apply`, `POST /shipments/combine`, the second `POST /shipments/split`, `POST /qingyun/confirm-point` and `POST /qingyun/reschedule`. **`routes/retail.js` moves 39 → 30 by AST.** Deployed clean: one restart (1296 → 1297), online, zero unstable restarts, and the only stack trace in the error log is an `awardOrderPoints` TypeError whose line numbers match revision `1b2285ed` from 2026-08-08 — an older build, not this one.

**TWO EXCLUDED, BOTH ON THEIR MERITS.** `PUT /integrations` stands excluded for the reason recorded under batch 3. **`POST /shipments/split` — the FIRST registration — is excluded because it calls `ensureShipments`**, a dual-context helper blocked behind the checkout. The call sits after its transaction commits and would convert cleanly, but a converted route must not drag an unconverted helper across the boundary, so it waits for the checkout. Both exclusions are now asserted by name in the batch's suite, alongside a standing assertion that **neither `qingyun` body awaits**: the push to Qingyun is the drain's work on its own poll, and an `await` on a remote call inside either block would hold the shared handle open for a network round trip and queue every other writer behind it.

**RED IS NOW PROVEN PER CONVERSION, NOT PER FILE.** Batch 3's sabotage flipped two assertions across five conversions, which leaves three unproven. Each of the nine sections in `scripts/test_tx_conversion_batch4.js` carries a headline old-versus-new assertion that the sabotage switch flips, and the run reports how many of the nine went red so that a partial failure cannot read as a full one. 31 assertions green; 9 of 9 red under sabotage.

### `POST /orders/:id/shipments/split` IS REGISTERED TWICE — FINDING RECORDED 2026-08-09

**Two `router.post` registrations share the path `/api/retail-admin/orders/:id/shipments/split`.** Express matches the first; it always responds and never calls `next()`, so the second is unreachable. They are different features, not two drafts of one.

| | **First in file — REACHABLE** | **Second in file — DEAD** |
|---|---|---|
| Purpose | Undo a combine | "Ship part later" — to-follow split |
| Added | `f30691bb`, 2026-06-14 | `546457c3`, 2026-06-06 |
| Reads `item_ids` | **No — ignores the body entirely** | Yes; 400 `no_items` without it |
| Writes | `shipment_id = NULL` on every item, **DELETEs every parcel**, re-plans via `ensureShipments` | INSERTs one new parcel, moves the ticked items onto it |
| Guards | 409 `has_tracking` if any parcel carries a waybill | 409 `item_already_dispatched`, 422 `would_empty_shipment` |
| Response | `{ success, shipments: n }` | `{ success, data: { new_shipment_id } }` |

**THE EARLIER FEATURE IS THE DEAD ONE.** The to-follow split shipped on 2026-06-06 and sits *later* in the file; the undo-combine shipped eight days later and sits *earlier*, so it took the path. **The second author did not intend to replace anything** — `f30691bb`'s message is entirely about an Orders-list "Ship to · 收货地" destination column and never mentions shipments at all. The combine feature and its natural inverse rode along in a commit about a table column, which is the batched-dirty-tree failure mode, and the path collision was invisible because nothing checks for one.

**ASKED FOR A TO-FOLLOW SPLIT, THE REACHABLE HANDLER DOES NOT REJECT — IT SILENTLY DOES SOMETHING ELSE, AND THE SOMETHING ELSE IS DESTRUCTIVE.** It ignores `item_ids`, nulls every item's `shipment_id`, deletes every parcel on the order and rebuilds the planned Air/Land split from address and items. Any manual parcel arrangement is discarded. It then returns `{ success: true }`, and the admin UI reports **"Moved to follow-up parcel · 已移入后补包裹"** — a message that is false. The only visible failure is a 409 `has_tracking` when a waybill already exists, which is a rejection with the wrong reason attached.

**THE UI FOR THE DEAD FEATURE IS FULLY BUILT AND LIVE.** `public/retail-admin/04-orders.js` renders a **"Ship part later · 分批发货"** button on every pending parcel holding two or more lines, opening a checkbox panel and a **"Move to follow-up parcel · 移入后补包裹"** submit. `submitShipmentSplit()` POSTs `{ item_ids }` to the shared path. A second, unrelated button — **"Split into separate parcels"**, `splitParcels()` — POSTs the same path with no body and is correctly served by the reachable handler.

**IT IS NOT TRUE THAT THE TO-FOLLOW SPLIT HAS NEVER RUN. That claim is in the batch 4 commit message and it is wrong; this entry corrects it.** The two handlers log under different action names — `shipment_split` singular for the to-follow route, `shipments_split` plural for the undo-combine — which makes them separable in `activity_log`:

- **`shipment_split` — 9 rows, all `owner`, 2026-06-06 13:19 to 2026-06-08 11:44**, on orders 130, 141–146 and 158, each recording a `new_shipment_id` and the `item_ids` moved. **Nothing after 2026-06-08**, and the shadowing registration landed 2026-06-14. The feature worked, was used, and went dark.
- **`shipments_split` — 2 rows only, 2026-06-15 and 2026-06-19.** Both follow a `shipments_combine` on the same order — on order 246 by three seconds — so **both were the undo-combine button**, not the to-follow one.
- **Nothing on either action since 2026-06-19.** No operator has reached the silent-wrong-behaviour path in production, so there is no known data damage and no user report to reconcile.
- **None of the nine parcels created in June survive**: zero rows in `retail_shipments` carry the `(to follow · 后补)` label, and none of the nine recorded ids still exist. They were removed by later parcel rebuilds or the order lifecycle.

**FIXING IT IS NOT A DELETION, AND NOT A REORDER.** Deleting the reachable one breaks undo-combine, which is live and paired with a combine used 24 times. Deleting the dead one throws away a working feature whose UI is already built and shipped. **Reordering only moves the failure**: the to-follow handler 400s `no_items` on an empty body, so undo-combine would start failing visibly instead. **The smallest correct fix is one handler that branches on the presence of `item_ids`** — to-follow when the body carries them, rebuild when it does not — each branch keeping its own guards and its own response shape, which needs no client change and no `sw.js` bump. Giving the to-follow feature its own path is cleaner and costs an admin-JS change plus the service-worker bump. **Either way it needs its own proof: the to-follow branch has not executed since 2026-06-08, and `retail_shipments` has gained columns since, so its first run back would be a first run.** Not fixed here — recorded so it is a known defect rather than a surprise.

### THE TRANSACTION HELPER FOLDED CONCURRENT REQUESTS INTO ONE TRANSACTION — FIXED 2026-08-09 AT `dc91e62f`

**All conversion work stopped for this. `routes/retail.js` stays at 30, no new batches, `POST /polls/:id/vote` waits.** The helper every future money transaction runs through had a defect that only appears once a transaction body actually yields — which is to say, once the checkout is converted, and universally after the PostgreSQL flip.

**THE DEFECT.** `withTransaction` set `depth = 1` on **per-handle state, before awaiting the body**. Any outermost call arriving while that body was suspended read `depth > 0` off the shared handle, concluded it was nested, and took the `SAVEPOINT` path inside someone else's transaction. **Two independent requests produced ONE `BEGIN`**, and the first `COMMIT`ted while the second was still running:

```
A sees depth=0        BEGIN
A body in             SAVEPOINT tacet_sp_1
B sees depth=1        COMMIT                 <- fires while B is still running
B body in             RELEASE SAVEPOINT tacet_sp_1
A body out
B body out
```

**Both corruption modes, quoted from the test output against the unfixed helper on a real handle:**

> `✗ B commits even though A, arriving first, rolls back`
> `    B did nothing wrong and must not fail — it got: no such savepoint: tacet_sp_1`

> `✗ B's write is gone after B fails, even though A commits`
> `    B rolled back — its row must NOT have been committed by A`
> `    actual ['A','B'] — expected ['A']`

**In checkout terms those are an order vanishing because an unrelated customer's checkout failed, and a `409 insufficient_stock` that leaves its order and its stock reservation committed anyway — an oversell produced by the code that exists to prevent one.**

**WHY IT SURVIVED FOUR CONVERSION BATCHES.** `scripts/test_db_transaction.js` section 8 has claimed since the helper was built that "concurrent transactions on one handle do not interleave", and it passes. **It passes because it calls `withTransaction` twice in ONE SYNCHRONOUS BLOCK**, where neither body has started and both are therefore correctly seen as outermost. It pinned a real property — the queue does work for that shape — but it never touched this one, and its name implied coverage it did not have.

**THE RULE, because this will recur elsewhere: a concurrency test whose calls originate in the same synchronous block is not testing concurrency.** Real requests arrive in **separate macrotasks**, dispatched off separate socket reads, and the test has to arrive that way too. The replacement (`scripts/test_db_transaction_nesting.js`) starts each transaction from its own `setImmediate` for exactly this reason. Written red first: **4 passed, 10 failed** against the unfixed helper, and the run aborted on a live `no such savepoint` escaping from inside the helper.

**WHY IT NEVER BIT IN PRODUCTION.** Every converted body in batches 1–4 is **fully synchronous**, so a transaction completes inside one microtask drain and no second request can arrive mid-flight. What kept it that way is **batch 2's "no await in a converted body" assertion — a TEST, not the helper.** That assertion stays in place after the fix; it costs nothing and it is a second line.

**AND IT WOULD NOT HAVE HELD.** The checkout cannot be synchronous under PostgreSQL, where every statement is a round trip. **Converting the checkout before this repair would have put the money cluster — order, items, reservations, voucher pool, points and wallet — into the two modes above on live traffic.** That is the argument for having designed the checkout on paper before touching it, and it is the same argument that put the helper on `main` unused in the first place.

**THE FIX.** Nesting is decided by the **async context**, not by state on the shared handle. An `AsyncLocalStorage` store holds `Map(handle → depth)` for the duration of a body, so "nested" means what it actually means — *this call was made from within another transaction's body* — and a caller who merely shares the handle cannot read it. The map is copied per level rather than mutated, so unwinding is automatic and no counter can be left wrong after a throw. **There is now no depth on the per-handle state at all**, because anything stored there is readable by every later caller, which is precisely how this happened.

**THE SERIALISER IS BYTE-IDENTICAL AND STILL LOAD-BEARING.** `acquire()` and the per-handle `tail` are untouched. The fix does not weaken the queue or trade it for concurrency — **it makes the queue reachable**, which it was not once a body had started. A request arriving mid-await now waits instead of joining, and that is asserted rather than assumed.

**PROVEN ON THE PRODUCTION DRIVER, not only the fallback.** 14 assertions green and 5 of 5 headline assertions red under `TX_NEST_SABOTAGE=1`. Run on the box against **better-sqlite3**: 14/14 nesting, 28/28 helper. **No existing batch changed behaviour** — batch 1 (11), batch 2 (32), batch 3 (13), batch 4 (32) and `test_db_transaction` (28) all report exactly what they reported before the fix, which is the evidence that nothing shipped was relying on the broken path.

**CARRIED FORWARD, UNRESOLVED.** `acquire()` still keys its queue on the **handle**. Under PostgreSQL the handle a caller passes is the pool, so a queue keyed on it would serialise every transaction in the application behind one promise — measured during the design pass: three concurrent transactions on one shared handle ran strictly sequentially. **At the flip the queue must be scoped to the checked-out connection, not the pool.** This half of the design finding in `docs/tacet-checkout-transaction-design.md` stands and is not addressed here.

### THE SPLIT ROUTE IS FIXED — DEPLOYED 2026-08-09 AT `85f5bffa`

**The finding above is closed.** One handler now serves the path, branching on the body: `item_ids` present takes the to-follow behaviour with its own guards, `item_ids` absent takes the undo-combine behaviour unchanged. The second registration is gone. No client change and no `sw.js` bump — both UI callers already POST this path and neither reads the payload. **Verified on the box after the deploy: one registration, and no duplicated path anywhere in the 330 route registrations in `routes/retail.js`.** One restart, 1297 → 1298, nothing in the error log but the routine ALIPAY warning pair.

**DISPATCH IS ON PRESENCE, NOT ON LENGTH.** `Object.prototype.hasOwnProperty.call(req.body || {}, 'item_ids')`. A body carrying `item_ids: []` or a malformed list is a **400**, never a rebuild — branching on the filtered array's length would let a malformed to-follow request fall through to the destructive branch, which is the original defect in miniature.

**THE UNDO-COMBINE BRANCH IS PINNED, NOT MERELY EXERCISED.** It is in live use, so the suite compares it against a reference implementation of the pre-merge handler — same rows, same response, same status — rather than asserting only that it still works, which would not catch a change of shape.

**WHAT THE FIX DID NOT DO.** No new transaction was converted. The to-follow branch carries the `withTransaction` batch 4 already gave it; the undo-combine branch stays on `db.transaction()` **on purpose**, because it calls `ensureShipments`, which is blocked behind the checkout. The handler is now `async` because the to-follow branch awaits, but nothing before the branch point awaits, so the undo-combine path runs start to finish synchronously exactly as before. **The AST count is unchanged at 30.**

**THE SCHEMA WAS CHECKED BEFORE THE CODE WAS WRITTEN, and the answer was better than "no constraint breaks".** `retail_shipments` has 23 columns and gained five since the to-follow branch last ran: `local_eta`, `eta_source`, `package_count`, `air_delay_cleared_at`, `air_delay_cleared_by`. None is NOT NULL; the only two NOT NULL columns are `order_id` and `mode`, and both are set. **The decisive fact is that `ensureShipments` — the planner that creates parcels on every order — inserts the identical five columns and sets none of the newer ones either**, so a parcel the to-follow branch creates is shaped exactly like every other parcel in the system. Live data agrees: of 808 parcels, 674 have `local_eta` NULL and 720 have `eta_source` NULL. The suite now asserts both halves of this — that only `mode` and `order_id` are NOT NULL, and that all five newer columns are still nullable — so if one ever becomes NOT NULL, the to-follow branch is reported as writing an incomplete row before a customer finds out.

### A DUPLICATE ROUTE REGISTRATION IS SILENT IN BOTH DIRECTIONS — RULE RECORDED 2026-08-09

**This is the general lesson, and it is worth more than the specific bug.** When two handlers register the same method and path, **one of them silently wins and the other silently loses. Express reports neither.** There is no warning at startup, no error at runtime, and no signal in any log. The only way to see it is to look for it.

**Which one loses is decided by position in the file, not by intent or by date.** Here the *earlier-written* feature lost, because the *later-written* one happened to be inserted higher up. Nothing about the code reads as wrong at either site: both registrations are correct, idiomatic and well-commented on their own.

**Losing silently is only half the hazard. Winning silently is the other half**, and it is the worse one. The surviving handler kept answering requests meant for the other feature — with a `200` and a success body — while doing something entirely different and destructive. **A route that 404s when it disappears is a bug you find in an afternoon. A route that answers plausibly is one that runs for eight weeks.**

**THE TRIPWIRE IS NOW IN THE SUITE.** `scripts/test_shipments_split_merge.js` asserts that **no admin route in `routes/retail.js` is registered twice** — it scans every `router.<method>('<path>'` registration and fails on any duplicate. It passes today across 330 registrations. That assertion, not this paragraph, is what will catch the next occurrence, and it should be extended to the other route files rather than re-derived when one turns up there.

### "SHIP PART LATER" WAS LIVE AND DESTRUCTIVE-ON-SUCCESS FOR EIGHT WEEKS — FINDING RECORDED 2026-08-09

**The timeline matters, because it is the difference between dead code and a regression.**

- **2026-06-06 (`546457c3`)** — "Ship part later · 分批发货" ships. It works. **Nine real splits by the owner between 06-06 13:19 and 06-08 11:44**, on orders 130, 141–146 and 158, each recorded in `activity_log` under `shipment_split` with the new parcel id and the items moved.
- **2026-06-14 (`f30691bb`)** — a second registration of the same path lands higher in the file. **The commit's message is entirely about an Orders-list "Ship to · 收货地" destination column and never mentions shipments.** The combine feature and its inverse rode along in a commit about a table column. From this moment "Ship part later" is unreachable.
- **2026-06-19** — the last call to the path, an undo-combine. **Nothing since.**
- **2026-08-09** — fixed and deployed.

**IT WAS NOT DEAD CODE. IT WAS A LIVE BUTTON WIRED TO THE WRONG HANDLER.** The "Ship part later · 分批发货" button and its checkbox panel remained rendered on every pending parcel holding two or more lines, and a click POSTed `item_ids` to a handler that ignores the body. The answer was **`200 success`**, and the admin UI reported:

> Moved to follow-up parcel · 已移入后补包裹

while the server had **deleted every parcel on the order and re-planned from scratch**, discarding the arrangement the operator was building. No error, no warning, no failed request. **Eight weeks in that state.**

**NO OPERATOR REACHED IT AFTER 2026-06-19**, which is the one piece of luck in this. `activity_log` carries exactly two `shipments_split` rows, 06-15 and 06-19, and both follow a `shipments_combine` on the same order — on order 246 by three seconds — so both were the undo-combine button. There is no known data damage and no user report to reconcile.

**The regression is now executed rather than described.** One assertion in the split-merge suite runs the pre-merge handler against a to-follow request and proves it destroys the order, then proves the fix does not. A defect that was invisible for eight weeks is worth holding as a demonstrated failure, not a paragraph.

### THE HARNESS PRODUCES A TABLE THINNER THAN THE CODE — A RECURRING CLASS, NOT TWO INCIDENTS

**`scripts/test-support/memory-db.js` has now failed the same way twice, on different mechanisms, and it should be read as one standing hazard rather than two fixed bugs.** The failure is always the same shape: the harness builds a table that is missing columns the code under test writes, every assertion in the suite passes, and **the suite is green and wrong**. Nothing about a green run distinguishes it from a correct one.

- **Batch 2 — the type pattern.** The `addColumn()` scan read the type as `'(\w+)'`, a single-quoted single word. Types carrying a space or a nested quote were dropped **silently**: `products.sort_order`, `retail_polls.display_min_total`, `retail_media.tags`.
- **Batch 4 — the fork's own ALTERs.** `addForkedStoreProducts` mirrors `products` column-for-column and appends the four store-only link columns, which is how the application derives the table — **but `store_products` also has TWELVE `addColumn('store_products', …)` calls of its own**, columns that exist on the fork and not on `products`. They were never replayed. Three of them are written by `PUT /products/:id/variants`: `variant_label_cn`, `variant_noun_en`, `variant_noun_cn`.

- **The split fix — the third, and the reason this is now a rule.** The same assertion was written for the two split branches, and it forced the third repair before any behaviour test was trusted. It also grew two checks the earlier batches had no reason to make: that `retail_shipments` has exactly two NOT NULL columns, and that the five columns it gained since 2026-06-08 are all still nullable. Those are the same hazard read from the other end — not "is the harness thinner than the schema" but "has the schema grown a requirement the code does not satisfy".

**THREE CONSECUTIVE BATCHES, THREE DIFFERENT MECHANISMS, ONE FAILURE MODE.** That is no longer a run of bad luck. The harness reconstructs tables from source by pattern-matching, and **every pattern it uses is a place where a column can go missing without anyone being told.** Assume the next batch finds a fourth.

**THE WRITTEN-COLUMN ASSERTION IS WHAT CATCHES THIS, AND IT IS NOW NON-OPTIONAL.** Introduced in batch 3 as a standing check rather than a one-off, it lists every column a batch's routes write and fails if any is absent from the harness-built schema. **It has caught the defect every single time it has been present — batch 2's in retrospect, batch 4's and the split fix's on the suite's first run**, before a single equivalence assertion had been trusted.

**So it is a requirement, not a good habit: no conversion batch and no behaviour fix that writes to the database ships without it.** A batch that omits it is not a batch with one fewer test — it is a batch whose every other assertion is unverified, because nothing else in a green run distinguishes a correct schema from a thin one.

**AND A THIRD DEFECT, ONE LAYER DOWN: THE FOREIGN KEY STRIP WAS COMMENT-BLIND.** `extractCreateTable` balances parentheses while skipping line comments and string literals, but the FK removal that followed was two regexes run over the raw statement with no such care. **`retail_order_items` has both a trailing `-- …, for the receipt` comment and two consecutive `FOREIGN KEY` lines**; the first regex's `,\s*\w+\s` lookahead matched inside that comment, consumed the keyword and left `) ON DELETE CASCADE` dangling, so **the table would not build at all** — `near ")": syntax error`, and with it every other table on the same handle. No suite had needed `retail_order_items` before batch 4, which is why a defect this total had never surfaced. The strip is line-based now: comments removed first with the same quote-awareness the paren scan uses, whole-line `FOREIGN KEY` clauses dropped, the trailing comma cleaned — **and it THROWS on a `FOREIGN KEY` that survives**, rather than handing back a `CREATE` that will not parse. **A loud failure is the only acceptable outcome here**, because the quiet one is the thinner table.

### DESTRUCTIVE SCRIPTS SHIP TO PRODUCTION — FINDING RECORDED 2026-08-09

**`scripts/` is in the deploy allowlist, so every script that deletes production data lands on the box on every deploy.** Twelve such scripts are present on the live box now. This is not a hypothetical exposure and not a decision being taken here — it is a standing condition of the current deploy design, written down because the PostgreSQL cutover makes part of it actively dangerous.

**`reset_test_orders.js` IS PRESENT AND RUNNABLE, WITH NO EVIDENCE IT HAS EVER BEEN RUN THERE.** The file is on the box, executable. A filesystem-wide search for its backup signature (`roots-pretestreset-*.db`) returns nothing and `/root/.bash_history` holds no reference to it. Absence of evidence, recorded as that and not as proof it has never run.

**THE UNSAFE-SELECTOR DEFECT.** The script selects accounts by `--ids`, `--names` or `--phones`, and a customer is taken if ANY selector hits. `--names` and `--phones` are **unbounded case-insensitive SUBSTRING matches**. There is **no minimum selector length, no cap on how many accounts may match, and no proportion check** — nothing notices that a selector has matched most of the customer base. `--names a` matches nearly every account with an "a" in the nickname; `--phones 1` matches essentially every Chinese mobile number.

**The dry-run preview is the only real safety mechanism, and it is not enforced.** There is no environment check — no `NODE_ENV`, no hostname test, no production guard — and no confirmation prompt. `--apply` is accepted on the FIRST invocation, so the preview that makes the script safe can be skipped silently and in a single command. It **deletes `retail_customers`, `retail_orders`, `retail_payments`, `retail_points_transactions` and `retail_topup_transactions`**, along with addresses, tokens, notifications, vouchers, favourites, poll votes, reviews, feedback, subscriptions, visits, checkout quotes, order items, refund events, shipments, stock reservations and referrals. Physical inventory is deliberately left alone and reported instead. What it does have: one transaction, an automatic pre-delete backup, and a `foreign_key_check` afterwards.

**TWO OPPOSITE DEFAULTS IN ONE DIRECTORY.** Four scripts require `--apply` and **fail closed** — run them wrong and nothing happens: `reset_test_orders.js`, `collapse_zones_into_default.js`, `consolidate_guangdong_and_hk.js`, `dedupe_province_covered_cities.js`. Seven require `--dry-run` and therefore **fail OPEN — writing is the default and the operator must opt OUT**: `backfill_addons.js`, `copy_hummus_extras.js`, `copy_soup_options.js`, `restore_recipe_data.js`, `import_miniapp.js`, `import_meituan.js`, `import_gzgrocery.js`. (An eighth, `seed_synthetic_reviews.js`, deletes only under an explicit `--clear`.) **Only `reset_test_orders.js` takes a backup first.** Two contradictory conventions sitting in one directory is itself the hazard: an operator who has learned that these scripts are safe by default has learned it from the wrong half.

**MIGRATION HAZARD — REQUIRED PRE-CUTOVER WORK, NOT AN OBSERVATION.** The backup in `reset_test_orders.js` is `fs.copyFileSync` of the SQLite file, preceded by a `wal_checkpoint(TRUNCATE)` pragma. **After the PostgreSQL cutover this does not fail loudly.** It may copy a stale or abandoned `.db` file, print a restore command that restores nothing, and let the deletes proceed against PostgreSQL with the operator believing a backup exists. **Every script in `scripts/` that assumes a SQLite file path must be audited before the flag is flipped.** This is the same failure shape as the backup script that printed "pushed" unconditionally: the destructive step succeeds, the safety step silently does nothing, and the output claims otherwise. The general rule it argues for — a safety step that cannot verify it worked must fail, not print — is recorded here rather than assumed.

**ORDERS 1–180 ARE GONE, AND THE CAUSE IS UNKNOWN.** `retail_orders` runs from id 181 to 1053, 873 rows, perfectly contiguous; ids 1–180 were removed in one operation. The oldest surviving order is `R260614000002`, the SECOND order of 2026-06-14, so that day's first order went with them. No orphaned points rows remain — nothing in `retail_points_transactions` references a deleted order — so whatever removed them took the points with them and left nothing unreconciled. **An earlier attribution of this to `reset_test_orders.js` is WITHDRAWN**: it was inferred from that being the only order-deleting tool in the repo, and the backup search does not support it. Recorded as unexplained. The practical consequence is bounded and worth stating: real trading in these tables begins 2026-06-14, so any all-clear derived from `retail_orders` covers the life of the surviving data and not the life of the business.

**REQUIRED FIX, DEFERRED TO THE BATCH 3 DEPLOY — NOT DONE NOW.** Three changes to `reset_test_orders.js`: a **minimum selector length**; a **cap or proportion check** on matched accounts, so a selector that sweeps most of the customer base stops rather than proceeds; and **preview-before-apply enforced rather than optional**, so `--apply` cannot be honoured on a first invocation. Deferred deliberately — `scripts/` is deploy-allowlisted and merging a fix restarts production, which is not warranted while batch 2's converted transaction bodies are still unproven on live traffic.

### THE POSTGRES DATABASE IS BACKED UP — AND A FRESH-CLUSTER RESTORE IS STILL UNPROVEN — 2026-08-09

**UNTIL THIS MERGE, POSTGRES HAD NO BACKUP OF ANY KIND.** Not a stale one, not an unverified one — none. Both cron jobs on the box were SQLite-only: `/root/scripts/roots-backup.sh` hourly for `roots.db`, and `scripts/db-backup.sh` at 03:00 for `roots.db` plus the five tenant files. Meanwhile the verified 364,666-row copy recorded above in §24 sat on the same box with nothing pointing at it. **The gap was not that the backup was weak. There was no line of code anywhere that read the `tacet` database for the purpose of keeping it.** Merged at `7b3ce893` as a third source KIND inside the existing script rather than a second program, so the flock guard, free-space preflight, stale-`/tmp` sweep, ops alert, upload-then-verify and retention pruner are shared rather than reimplemented and left to drift.

**THE ROLES FILE IS WHAT MAKES THE DUMP RESTORABLE, AND IT IS 795 BYTES.** `pg_dump` is per-database. Roles are cluster-level, so the dump does not contain them and cannot. Measured on the live database today:

- **648 privilege grants on tables** to `tacet_app`, plus 278 on sequences and one on the schema — **927 in total.**
- **304 ACL entries in the `-Fc` archive's own table of contents**, every one of them naming a role that a bare `pg_dump` does not carry.
- `pg_dumpall --roles-only` produces **795 bytes**: two `CREATE ROLE` lines (`postgres`, `tacet_app`), two `ALTER ROLE` lines, and the SCRAM verifier the application authenticates with.

**So 795 bytes is the difference between a backup and 310MB that errors 304 times and produces a database the application cannot log into.** That is the whole argument for uploading it into the same prefix, in the same run — a restore must never have to go looking for it.

**THE REHEARSAL, AND WHAT IT ACTUALLY PROVED.** A restore was rehearsed end to end. Its most important property is where the inputs came from: **it restored from objects downloaded back out of OSS**, not from the local files that produced them. That is the only version of the test worth running, because it exercises the upload, the bucket and the download alongside the dump. A rehearsal against the local originals would have proved the dump format and nothing about whether the thing in the bucket is the thing that was made. It also confirmed that identity state survives rather than resetting: **an insert into the restored copy allocated 976 against a maximum existing id of 974** — the sequence came back ahead of the data, which is what distinguishes a restored database from a re-created one.

**THE LIMITATION, STATED PLAINLY: FRESH-CLUSTER ROLE CREATION IS UNPROVEN.** The rehearsal ran **in the same cluster**, where `tacet_app` already existed. `roles.sql` therefore applied its `ALTER ROLE` lines and its `CREATE ROLE` lines did nothing — the one part of the file that exists for the disaster case is the one part the rehearsal did not execute. This is corroborated rather than assumed: `tacet_app` is present in the live cluster now, so any `roles.sql` applied there reaches `CREATE ROLE` only to find the role already there.

**This is required work before any restore onto a new box, and it is not optional, because the new-box case IS the disaster case.** A restore into the existing cluster is the convenient rehearsal; a restore onto fresh hardware is the reason the backup exists at all, and it is the path that has never been walked. Until it has been run against a cluster where `tacet_app` does not exist, the backup should be described as proven for recovery-in-place and unproven for recovery-elsewhere.

**THE CRON PATH IS NOT YET PROVEN FOR THE POSTGRES TIER.** The rehearsal was a manual run. Cron has fired `/root/roots-v2/scripts/db-backup.sh` at 03:00:01 on each of 2026-08-07, -08 and -09, so the schedule and the invocation are proven — but only for the SQLite tier, since the Postgres code landed at 22:50 on 08-09, after that day's run. The deploy replaced that exact file in place, so the next scheduled run picks up the new version with no further action. What was checked in advance rather than left to the morning: `pg_dump`, `pg_dumpall`, `pg_restore`, `sqlite3`, `gzip`, `flock` and `sudo` all resolve under a bare `PATH=/usr/bin:/bin`; there is no `requiretty` in sudoers, so `sudo -u postgres` works without a terminal; and peer auth over the socket succeeds under a stripped environment with no tty and no login shell. **Those are the three things that differ between a manual run and a cron run, and all three pass. The end-to-end green run under cron is still owed.**

### /root/backups IS 19G, NOT 15G — AND ~1.57G OF IT HAS NO RETENTION POLICY — MEASURED 2026-08-09

**THE PREVIOUSLY RECORDED 15G IS SUPERSEDED BY A MEASURED 19G.** The disk holding it is 40G with 7.8G free, so this is a correction worth making before the Postgres tier adds a nightly ~310MB dump to `/tmp` on the same filesystem.

**17.2G OF IT IS LOAD-BEARING AND ALREADY BOUNDED.** `hourly/` is 9.5G and `daily/` is 7.7G, and both are **exactly at their configured retention** — 24 hourly snapshots against a keep-24 rule and 30 daily against a keep-30 rule, verified by count. Nothing to reclaim there without changing policy, and no reason to.

**~1.57G IS UNDER NO RETENTION POLICY AT ALL.** Two separate accumulations:

- **`deploy-*` — 862 directories, 965M**, running from `deploy-20260708-113448` to `deploy-20260809-192136`. `deploy-apply.sh` creates `/root/backups/deploy-$TS` on every deploy and the only `rm -rf` in the script targets `__stage__`. **There is no pruner for these anywhere — not in the script, not in cron, not in a lifecycle rule.** At the current deploy rate this grows by roughly a directory per push, forever.
- **Four June one-off snapshots — 630,808,576 bytes, 602M**: `roots-pre-expiry-1781222526711.db`, `pre-orphanfix-2026-06-09T0229.db`, `pre-store-fork-2026-06-09T0140.db` and `pre-brand-restore-20260606.db`. Each was taken by hand before a specific risky change, and each has outlived the change it was insurance for.

**Recorded, not acted on.** Nothing is pruned here and nothing should be pruned as a side effect of a backup change — the point of writing it down is that `deploy-*` accumulation is a standing condition with no owner, and the next person to look at free space on this box should find it already explained rather than rediscover it.

### THE PHASE NUMBERS — DEFINED HERE, AND THIS ENTRY IS THE AUTHORITY — DECIDED 2026-08-09

> **AMENDED IN PLACE 2026-08-10.** This entry claimed authority over the numbering while describing the ground it was taking as empty. It was not empty. A five-phase reading existed, it came from the ROLLED OUT IN PHASES paragraph this entry cites as its own source, and under it the switch is 4 and backups are 5. This entry replaced that reading and never said so — which left the two live side by side for a day and put a "which numbering do you mean?" question into the memory blocks.
>
> The paragraph below is corrected rather than left standing, on the v4.11 precedent: a superseded DECISION is worth leaving visible because it shows how the thinking moved, but a **false account of what a decision replaced** only misinforms every later reader. The three definitions themselves are unchanged and were never in doubt. See **THREE PHASES, AND WHY THE FIVE-PHASE READING IS WRONG — DECIDED 2026-08-10** at the end of this section for the reasoning that retires it.

**The numbering has been in use in conversation and is under-specified in the record.** Read against this file as it stood before this entry: **Phase 1 is defined once**, in the ROLLED OUT IN PHASES paragraph at the head of §24. **Phase 2 appears exactly once, and only as a negative** — "It belongs to the Products stage of the consolidation sequence, not to Phase 2" — which tells a reader what Phase 2 excludes and never what it is. **Phase 3 appears nowhere at all.** Everything else in this section says "a later phase" or "later phases" with no number attached.

**WHAT WAS THERE INSTEAD, stated because the original wording of this paragraph said "almost absent" and moved on.** The ROLLED OUT IN PHASES paragraph does not only define Phase 1; it lists what follows — "adding the account column, routing queries through one enforcement gate, copying Roots's data across, the switchover, and backups" — and a reader who numbers that list gets **five phases, with the switch at 4 and backups at 5.** That is a reading of the record, not a misreading of it, and it is the one this entry silently displaced. So work has been planned, argued and merged against a numbering the record could not be used to check, and against a second numbering the record could be used to derive. This entry defines the three, and from here it is the authority for what they mean.

**PHASE 1 — ALREADY DEFINED, AND THE DEFINITION DOES NOT CHANGE.** Quoted from the ROLLED OUT IN PHASES paragraph above rather than restated:

> Phase 1 installs PostgreSQL alongside the running SQLite app; nothing points at it yet.

The schema translation and the data copy are Phase 1 work and are recorded above under their own dates. Postgres installed alongside the running SQLite application, the schema translated, the data copied, nothing pointing at it. That is the whole of Phase 1 and it is done.

**PHASE 2 — THE ASYNC CONVERSION OF THE DATA LAYER AGAINST SQLite, PLUS EVERY FIX AND OPERATIONAL PREREQUISITE THAT MUST BE TRUE BEFORE A FLIP IS SURVIVABLE.** Both halves are Phase 2, not just the first. The conversion half is the work recorded above under CUTOVER SEQUENCING and the batches that followed it: the async-handler guard, the dual-context helper rule, the transaction helper, and the call sites moved onto it while still on SQLite, where an async wrapper over a synchronous driver is provable. The operational half is everything the flip depends on and none of it is code in `routes/`: backups that have been taken and restored, a rollback plan, a cutover runbook, and the standing hazards this section already records as pre-cutover work — the SQLite-path scripts audit, the retired files the deploy will never delete, `data/roots.db` removed or renamed.

**PHASE 2 ENDS WHEN TWO THINGS ARE TRUE AT ONCE: the code can run on either driver, AND backups, rollback and the runbook exist.** Not one or the other. Either condition alone leaves a flip that can be started and not finished.

**PHASE 3 — THE SWITCH, AND NOTHING ELSE.** `TACET_DB` selects the driver. A fresh data copy replaces the stale rehearsal copy — the 08-04 copy is a rehearsal, and the delta since it was taken is a Phase 3 input, not a Phase 2 one. Then cutover, with rollback available. Phase 3 is short by construction, and it is short because Phase 2 was long.

**BACKUPS, THE ROLLBACK PLAN AND THE CUTOVER RUNBOOK BELONG TO PHASE 2, NOT PHASE 3 — STATED EXPLICITLY BECAUSE THE OPPOSITE READING IS THE NATURAL ONE.** All three are about the flip, so they sound like flip-day work. They are not. **They must EXIST before the flip, and everything in Phase 3 happens on the day.** A backup first taken on cutover day has never been restored. A rollback plan written on cutover day is written by someone who has already decided to go forward. A runbook written on cutover day is a description of what is being improvised. Put them in Phase 3 and the flip becomes the test of the safety net, which is the one arrangement the whole phased rollout exists to avoid. This is not a preference about ordering; it is the difference between a reversible day and an irreversible one.

**RELATIONSHIP TO PATH A — TWO SEQUENCES, AND THEY MUST NOT BE CONFLATED.** Path A's four steps, recorded above under CUTOVER SEQUENCING, are a technical order for converting the data layer. The phases are a rollout order for the business. They answer different questions and neither replaces the other. Mapped once, plainly:

- **Path A step 1** — define an async data-access contract both drivers can satisfy — **inside Phase 2.**
- **Path A step 2** — convert the transactions as a single deliberate unit — **inside Phase 2.**
- **Path A step 3** — convert call sites behind that contract while still on SQLite — **inside Phase 2.**
- **Path A step 4** — add `TACET_DB` to select the driver — **is Phase 3.** It is the only one of the four that is.
- The **STEP ZERO** prerequisite recorded above, the `asyncHandler` wrapper, is **inside Phase 2** as well.

**THE NUMBERING DOES NOT REPLACE THE PATH A STEPS.** Saying "we are in Phase 2" does not say which step is in hand, and finishing step 3 does not finish Phase 2 — the operational half is still owed. Both sequences stay live and both must be cited by name when it matters.

**A WARNING ABOUT STEP NUMBERS, RECORDED BECAUSE IT IS THE SAME DISEASE.** This section carries more than one numbered step list: the four under CUTOVER SEQUENCING, and the six-item `routes/retail.js` CONVERSION ORDER numbered (0) to (5). Commit messages have used step numbers matching neither exactly. **A bare step number is therefore not a reference.** Cite the list as well as the number, or name the work.

**THIS ENTRY IS THE AUTHORITY FOR THE NUMBERING, AND EARLIER TEXT IS SUPERSEDED BY IT RATHER THAN EDITED.** Every earlier line in this section that says "a later phase" or "later phases" without a number — the retirement of `lib/tenant-db.js`, the `retail_vouchers.value` split, the account column, the enforcement gate, the data copy, the switchover, backups — keeps its wording and is read against the definitions here. Nothing above is rewritten. The record shows how the thinking moved; this entry is what a reader resolves an unnumbered phrase against.

> **AMENDED 2026-08-10.** That closing list — account column, enforcement gate, data copy, switchover, backups — is the SAME five items as the ROLLED OUT IN PHASES sentence, reproduced here as though its only defect were the missing numbers. Its defect is the ORDER: it ends with backups, after the switchover. Read against the definitions above, "backups" in that list resolves to **Phase 2**, and "the switchover" to **Phase 3** — so the list is not in phase order and must not be read as if it were.

### RECORD CORRECTION — PATH A STEP 2 IS NOT "ALREADY ON MAIN" — 2026-08-09

**Batch 1's commit message `d7515a36` states that the dual-context helper rule is already on main. It is not.** The message reads: "Steps 0 (async guard) and 2 (dual-context helpers take the handle as an argument) are already on main." The helper rule is settled on paper — the DUAL-CONTEXT HELPERS entry above decided it — but it is not in the code.

**Measured at this head, not inferred.** Of the six helpers named in that entry, **five still take no handle parameter**: `writeLayout(key, json, by)`, `reconcileTier(customerId, spend, storedTier)`, `ensureShipments(orderId)`, `generateRetailSku()`, `createOrReuseManualCustomer({ nickname, email, phone, userId })`. Only `productContentSnapshot(db, id)` takes one, and it did so before the rule existed — it is the helper the rule was generalised **from**, not evidence the rule was applied. **`reserveForOrder` in `lib/inventory.js` takes no handle either**, and it is dual-context in exactly the same way.

**`tacet-checkout-transaction-design.md` v2.0 has this right and is the document to trust here.** Its conversion steps list "Convert `reserveForOrder` and `ensureShipments` to take the handle — the §24 step-2 rule" and marks it **"Still outstanding, and still the next thing."** Two records disagreed; the design document is the correct one.

**Recorded in §24 so the commit message cannot be cited as authority. Git history is not rewritten** — the message stays as it is, and this is the correction a reader finds when they check it. The general point is the one already made about grep-derived figures: **a claim in a commit message is a claim, and the code is the authority.**

### PHASE 2 OWED WORK THAT APPEARS NOWHERE ELSE — RECORDED 2026-08-09

Three items from the Phase 2 status review that are real work, are not written down anywhere in this section, and would otherwise be found at the flip.

**1. SEVENTY-THREE TRANSACTIONS LIVE OUTSIDE `routes/retail.js`, AND NOTHING SAYS WHAT HAPPENS TO THEM.** By AST at this head: **103 `db.transaction()` blocks in runtime code, 30 of them in `routes/retail.js`, so 73 elsewhere**, spread across 29 other files. **Two of them are money and sit in `lib/inventory.js`: `commitOrderReservations` and `reverseCommittedOrder`.** Every conversion batch so far has scoped itself to one file and reported its progress as that file's count falling, which reads as progress against a whole and is progress against 30 of 103. The 73 are not excluded, not deferred and not scheduled — they are simply unmentioned. **Phase 2 does not end while an unconverted `db.transaction()` block is reachable from a converted async caller**, and these are.

**2. THERE ARE FIVE STEP-2 ROUTES, NOT FOUR.** The working set has been counted as four. **`POST /api/retail-admin/orders` calls `nextOrderNo()` at `routes/retail.js:20065`** — the same function the customer checkout calls at `routes/retail.js:10039` — so it mints an order number and straddles the money cluster. It has never been classified either way: not named in the money cluster, not named in the safe inline pool. **A route that mints order numbers cannot be left unclassified into the conversion**, because the classification is what decides whether it is converted with the checkout or apart from it.

**3. `POST /api/retail/polls/:id/vote` IS CLASSIFIED SAFE INLINE AND IT IS NOT.** Its transaction body — still on `db.transaction()`, at `routes/retail.js:29669` — updates `retail_customers.points_balance` and inserts a matching row into `retail_points_transactions`. Points are a customer liability with a ledger, and this route writes both the balance and the ledger in one block. **It must be reclassified before it is converted, not after.** The order matters: reclassifying afterwards means the standard applied to it was the wrong standard, and the conversion has to be redone to be trusted rather than reviewed and kept.

### SIGNPOST — "THE POLL GATE" IS THE ADMIN ROUTES, NOT THE CUSTOMER VOTE — 2026-08-09

**Three poll routes, and two different claims about them that must not be read as one.** The v4.10 and v4.11 entries above call the poll gate "the first converted transaction body proven on live traffic". That is the **admin** pair — `POST /api/retail-admin/polls` and `PUT /api/retail-admin/polls/:id`, both on `withTransaction` since batch 2, at `routes/retail.js:29849` and `:29988`. **It is not the customer vote route.** `POST /api/retail/polls/:id/vote` is still on `db.transaction()` at `routes/retail.js:29669`, is unconverted, and is the route flagged above for reclassification because it writes `points_balance` and the points ledger.

**Both statements are true and they are about different code.** A reader who takes "the poll gate is proven" as covering the vote route will conclude a money-writing transaction has been converted and proven when it has been neither. **v4.11 is correct and is not edited** — this is a pointer to read it by, not a correction of it.

### `PUT /integrations` WAS NOT ATOMIC — FIXED AND DEPLOYED AT `00f755f5` — 2026-08-09

**The transaction body wrote `process.env`, and no rollback can undo an environment assignment.** The two mutations sat inside the loop, interleaved with the `storefront_config` writes: `process.env[meta.env] = String(val)` on the set path, `delete process.env[meta.env]` on the clear path. A failure partway through discarded the database rows and kept the environment change. **This is the exclusion recorded above under the batch 3 entry — the route was held out of that batch on its merits, "its body assigns `process.env`, which no rollback can undo, so it is not atomic today". That reason is now gone.**

**THE FIX IS A MOVE, NOT A REWRITE.** The mirror is lifted out and applied after `tx()` returns, so the body is pure database work. Nothing inside the transaction reads env, calls `integ()` or calls `getTenantCreds()`, and `edits` is fully computed before the transaction opens — so nothing had to be carried out of the body and no return value was needed.

**NOT CONVERTED TO `withTransaction`, DELIBERATELY.** Fix first, convert later, so the two are separable if either goes wrong. `routes/retail.js` stays at **30** blocks by AST, unchanged by this deploy.

**THE FAILURE MODE IT REMOVES, IN PLAIN TERMS, BECAUSE IT DOES NOT LOOK LIKE A FAILURE.** For Roots, `process.env` is not a cache of the database — it **is** the runtime source of truth. `getTenantCreds(1)` resolves to `rootsEnvBundle()`, which reads env live and uncached on every call, and `lib/jd.js`, `lib/tracking.js` and `lib/feie.js` read it directly. `storefront_config` is never consulted at request time; it is the durable copy `database.js` hydrates back into env at boot. So a rolled-back save left the process serving a credential that was never stored, and **it worked** — waybills printed, SMS sent, the test buttons passed. Then at the next restart hydration loaded the old value and the new credential silently vanished. **No error at any point in that sequence**, and the operator's evidence that the save had worked was correct right up until it wasn't.

**THE RESIDUAL RISK, RECORDED RATHER THAN LEFT IMPLIED.** A crash between the `COMMIT` and the mirror loop leaves env stale until the next restart. **At that restart boot hydration loads the newly committed value and it self-heals.** That is strictly better than the previous arrangement, where the divergence was permanent and healed to the **wrong** value. The window is narrower, and the direction it heals in is now the right one.

### A COMMENT ANSWERED FOR THE CODE — SECOND OCCURRENCE OF A CLASS ALREADY RECORDED — 2026-08-09

**The suite's own source-level guard was satisfied by prose describing the thing it forbids.** The assertion that the per-tenant branch never touches Roots env ran `/process\.env/` over raw source. The per-tenant branch carries the comment "no `process.env` touch (that env belongs to Roots)". **The regex matched the comment.** The guard reported the branch as writing env when the branch contains no such code, and would have reported it forever regardless of what the code did.

**THIS IS THE SAME CLASS AS THE HARNESS'S COMMENT-BLIND `FOREIGN KEY` STRIP** recorded above under the batch 4 entry, where a regex lookahead matched inside a trailing comment and left a `CREATE` that would not parse. Two occurrences, two different files, one mechanism: **a pattern run over raw source reads comments as code.**

**SO IT IS STATED AS INTENT RATHER THAN AS A SECOND ANECDOTE: any source-level assertion must strip comments before matching.** A test that greps source is asserting something about the code, and prose in the same file is not code. Without the strip, an assertion can be satisfied — or defeated — by a comment, which is the one thing in a source file that has no effect on behaviour.

**WHAT MAKES THIS WORSE THAN THE FIRST OCCURRENCE, AND IS THE REASON IT IS WORTH A SECTION.** The `FOREIGN KEY` strip failed loudly: the table would not build. **This one failed by looking correct.** Run against the pre-fix code the section reported three failures, which read as a clean red proof of the defect — and **two of the three were false**, one from the comment match and one from a second bug in the same section (it located the per-tenant branch with `indexOf('} else {')`, which finds the set/clear `else` **inside** the transaction and tested the wrong region entirely). A red run that is red for the wrong reasons is not evidence, and it is harder to notice than a green one, because red is what was expected. Both defects are fixed: the section strips comments quote-awarely and finds the branches by brace matching.

### INTEGRATION CREDENTIALS: THE DATABASE WINS, ON ABSENCE AS WELL AS PRESENCE — DECIDED 2026-08-09

**DECISION: `storefront_config` is the source of truth for integration credentials, and `.env` does not get to overrule it — including when the database's answer is "this is cleared".** The database already won on presence; boot hydration overrides `.env` wherever a row exists. It lost on absence, because hydration's `if (!r) continue` treats a missing row as nothing to say. **A cleared credential produces exactly that missing row**, so the clear was honoured in the database, honoured in the live process, and then reversed at the next restart by a value with no admin surface. Full working in `docs/tacet-integrations-env-precedence.md`.

**THE FIX IS FOUR COMMENTED LINES IN `.env`, NOT A CHANGE TO HYDRATION.** `JD_APP_KEY`, `JD_APP_SECRET`, `JD_ACCESS_TOKEN` and `JD_CUSTOMER_CODE` are commented out on the box. No code changes. It is exactly coextensive with the defect, reversible by uncommenting, and it changes nothing about today's running behaviour, because all four rows exist in `storefront_config` and already win at boot.

**THE HYDRATION CHANGE WAS CONSIDERED AND REJECTED, AND THE REASON IS ABOUT THE FLIP RATHER THAN ABOUT TODAY.** Making hydration delete a variable whose row is absent would work now. **After the PostgreSQL cutover it would not be safe, because under row-level security an empty `SELECT` no longer means "there is no row" — it can also mean "a row exists and this account cannot see it".** Clearing-on-absence would then delete a live credential because of a policy mismatch, with no error and no obvious cause. It would also destroy the fresh-box bootstrap path, where an empty `storefront_config` is the normal state and `.env` is the only way to start. **A one-line change that is correct today and quietly destructive after the flip is worse than no change**, and this one was caught only because the question was asked before the flip rather than at it.

**RECORD CORRECTION TO THE PREMISE THIS STARTED FROM: it is FOUR of the 23, not all of them.** Measured on the live box across all six services — `kd100` 0 of 4, `jd` **4** of 5, `feie` 0 of 2, `wecom_app` 0 of 3, `nuonuo` 0 of 4, `aliyun_sms` 0 of 5. **`JD_API_ENV` is not in `.env` either**, so it is four of JD's own five. Clearing a kd100, feie or aliyun_sms credential already worked and already survived a restart; there was nothing to resurrect it from. The defect was four variables wide, and the fix is the same four.

**A FOOTGUN RECORDED BECAUSE THE NEXT PERSON TO EDIT THAT FILE WILL MEET IT.** The four sit at lines 43–46, directly above `JD_JDL_GATEWAY` and `JD_JDL_REFRESH_TOKEN` at 47–48, with `JD_JDL_APP_KEY`, `JD_JDL_APP_SECRET` and `JD_JDL_ACCESS_TOKEN` at 55–57. **`JD_JDL_*` is a different system** — no admin UI, not in `INTEGRATION_KEYS`, not hydrated — and anything that edits "the JD lines" by pattern or by line range takes it out too. The edit must match each of the four variable names literally and anchored at line start.

**OPEN — `nuonuo` IS MISSING FROM HYDRATION ENTIRELY, AND IT IS ITS OWN COMMIT.** `INTEGRATION_KEYS` defines 23 variables; `database.js`'s hydration map covers **19**. The four absent are all `nuonuo`. A Nuonuo credential saved through the admin UI is written to `storefront_config`, mirrored into the live process, works — **and is gone at the next restart with its row still in the database.** Same silent-vanish shape as the transaction defect fixed above, reached by a different route, and unrelated to `.env`. Latent only because the service has never been configured, so `storefront_config` holds no `nuonuo` rows. **The first person to configure Nuonuo hits it.** Not fixed here; a four-line addition to an existing object, deliberately kept out of a decision commit.

**CARRY TO PATH A — HYDRATION IS SYNCHRONOUS WORK AT MODULE LOAD AND CANNOT SURVIVE `pg`.** It runs inside `database.js` as a side effect of `require`, so today "before the first request" is guaranteed for free by the fact that a `require` cannot be interrupted. Against an asynchronous driver it becomes async work that **must be arranged to complete before the process serves anything**, and a window in which the application is up and env is not yet hydrated is a new state that does not exist now. Requests landing in it would read whatever `.env` supplied, or nothing. It belongs in the conversion with everything else rather than being discovered at the flip.

### THE SIX STEP-2 HELPERS — SURVEYED AT THIS HEAD 2026-08-10, AND NOTHING IS LEAKING TODAY

**Read-only survey of the six helpers named in the RECORD CORRECTION entry above. Measured from a parsed AST at `ca74eff2`, not from grep, not from commit messages, and not from the comments in the code — all three have now been wrong in this section at least once.**

**ALL SIX STILL TAKE NO HANDLE. The correction above stands in full, and nothing has changed since it was written.** Signatures verbatim at this head:

| helper | defined in | signature | handle? | writes | call sites | inside a transaction today |
|---|---|---|---|---|---|---|
| `writeLayout` | `routes/retail.js` | `writeLayout(key, json, by)` | no | 1 — `INSERT … ON CONFLICT` into `storefront_config` | 9 | **3** — `POST /brand/apply` ×2, `POST /brand/publish` ×1 |
| `reconcileTier` | `routes/retail.js` | `reconcileTier(customerId, spend, storedTier)` | no | 1 — `UPDATE retail_customers SET tier_key` | 4 | **3** — `awardOrderPoints`, `reverseOrderPoints`, `finalizeOrderAddon` |
| `ensureShipments` | `routes/retail.js` | `ensureShipments(orderId)` | no | 3 — `INSERT retail_shipments`, `UPDATE retail_order_items.shipment_id`, `UPDATE retail_shipments` tracking mirror | 11 | **1** — `POST /api/retail/orders` |
| `generateRetailSku` | `routes/retail.js` | `generateRetailSku()` | no | **none — it only reads** | 2 | **1** — `POST /products/:id/duplicate` |
| `createOrReuseManualCustomer` | `routes/retail.js` | `createOrReuseManualCustomer({ nickname, email, phone, userId })` | no | 2 — `UPDATE retail_customers` backfill, `INSERT retail_customers` | 2 | **1** — `POST /api/retail-admin/orders` |
| `reserveForOrder` | `lib/inventory.js` | `reserveForOrder({ storeId, orderId, items, channel = 'wechat', ignoreOrderIds = null, allowPartial = false })` | no | 1 statement — `INSERT retail_stock_reservations`, run once per line | 2 | **1** — `POST /api/retail/orders` |

**EVERY WRITE IN ALL SIX GOES THROUGH `tdb()`.** Not through a module-level prepared statement, not through the raw `database.js` export, not through a parameter. `tdb()` per call, `.prepare(...)`, then `.run(...)`.

**NO HELPER IS LEAKING A WRITE OUT OF A LIVE TRANSACTION. THIS IS THE ANSWER THE SURVEY WAS COMMISSIONED TO GET AND IT IS NEGATIVE — there is no atomicity hole open right now, and the threading is a conversion task rather than a fix.** The chain, stated in full because the conclusion is only as good as its weakest link:

1. **All ten in-transaction call sites sit inside `tdb().transaction(…)`** — not one is inside a `withTransaction(…)` body. Checked on every one of the eight enclosing blocks; every receiver is `tdb()`.
2. **`tdb()` is `seam(_tenantAls.getStore() || mainDb)`**, and `seam()` caches one wrapper per raw handle, so it returns an identity-stable object for a given tenant scope.
3. **better-sqlite3 runs a `.transaction()` body synchronously**, and an `AsyncLocalStorage` store cannot change during synchronous execution. The handle the helper resolves is necessarily the handle that holds the open `BEGIN`.
4. **Therefore the writes land inside the enclosing transaction.** They participate; they do not escape.

**THE SAFETY IS CONDITIONAL AND IT EXPIRES, WHICH IS THE POINT. It holds because the runtime is still better-sqlite3 AND because none of those eight blocks has been converted yet.** The moment any one of them becomes `withTransaction(tdb(), tx => …)`, the helper's `tdb()` stops being the handle the body was given, and under `pg` with a per-transaction client checkout that is a write on a different connection — outside the transaction, invisible to its rollback. **So the threading must land BEFORE the enclosing route is converted, never after.** Batch 4 already knew this and excluded the routes by hand; the rule is now measured rather than asserted.

**PROPOSED THREADING ORDER — CHEAPEST AND SAFEST FIRST.** Not built; this entry proposes it and nothing more.

1. **`generateRetailSku` — first, because it writes nothing.** A single `SELECT 1` uniqueness probe. Threading it is a pure signature change with no atomicity semantics to reason about at all, which makes it the cheapest possible proof of the dual-form pattern before anything with consequences uses it.
2. **`writeLayout` — second.** One write, one table, no money, no nested transaction. Nine call sites is the widest of the six, so it is the best exercise of the dual form's default-to-`tdb()` arm while the cost of getting it wrong is a CMS layout.
3. **`ensureShipments` — third.** Three writes and **its own internal `tdb().transaction()`**, which must become a nested `withTransaction(h, …)` so the savepoint nesting is preserved rather than flattened. Its one in-transaction caller is the checkout, which has a design document — `tacet-checkout-transaction-design.md` v2.0 names this helper explicitly and calls it outstanding.
4. **`reserveForOrder` — fourth, and paired with the third rather than sequenced far from it.** Same shape — its own internal transaction, same design document — and **its in-transaction call site is the same transaction block as `ensureShipments`'**, at `POST /api/retail/orders`. Threading one and not the other leaves that one transaction half-threaded, which is a worse state than either end.

**TWO OF THE SIX SHOULD COME OUT OF STEP 2, FOR TWO DIFFERENT REASONS.**

**`reconcileTier` IS MONEY AND IS CURRENTLY CLASSIFIED AS IF IT WERE NOT.** All three of its in-transaction callers are the loyalty cluster — `awardOrderPoints`, `reverseOrderPoints`, `finalizeOrderAddon`. In `finalizeOrderAddon` it is called between an `UPDATE retail_customers SET lifetime_spend … , points_balance …` and an `INSERT INTO retail_points_transactions`, inside one block. **Points are a customer liability with a ledger** — the identical standard this section already applied when it reclassified `POST /api/retail/polls/:id/vote`. It must be reclassified before it is threaded, not after, for the same reason recorded there: reclassifying afterwards means the wrong standard was applied and the work has to be redone to be trusted rather than reviewed and kept.

**`createOrReuseManualCustomer` BUYS STEP 2 NOTHING.** Its only in-transaction call site is inside `POST /api/retail-admin/orders` — the route already excluded from step 2 for minting an order number and straddling the money cluster. Its other call site is in no transaction at all. **Threading it while its sole in-transaction caller is excluded is work with no consumer.** It should travel with that route whenever the route is classified.

**THAT LEAVES FOUR, NOT SIX, IN STEP 2'S WORKING SET:** `generateRetailSku`, `writeLayout`, `ensureShipments`, `reserveForOrder`.

**FINDINGS NOBODY WAS LOOKING FOR.**

**1. `reconcileTier` SWALLOWS ITS OWN WRITE FAILURE, INSIDE THREE MONEY TRANSACTIONS.** The `UPDATE` is wrapped in `try { … } catch (e) { console.warn('[reconcileTier]', e.message); }`. Called from inside `awardOrderPoints`, `reverseOrderPoints` and `finalizeOrderAddon`, **a failed tier write does not roll those transactions back.** The points balance and the ledger row commit with a stale tier, and the only record is a console line. This is not an escape — the write is on the right connection — it is an atomicity *defeat*, and it is live today. **Threading a handle does not fix it**; the catch does. Recorded here, not fixed here.

**2. THE `undo-combine` BRANCH OF `POST /orders/:id/shipments/split` CLEARS AND REBUILDS IN TWO SEPARATE TRANSACTIONS.** `tdb().transaction(…)` nulls every `shipment_id` and deletes every shipment for the order, `tx()` **commits**, and only then does `ensureShipments(id)` rebuild — inside its own separate transaction. **Between the two, the order has no parcels and no item is assigned to one.** A throw or a crash in that window leaves it there. The existing entries on this route cover the duplicate registration and the destructive-on-success defect; **neither covers this, and it survived the `85f5bffa` fix untouched** because that fix deliberately changed no transaction. Live, low-traffic — `activity_log` shows the path last used 2026-06-19 — and out of scope for step 2. Recorded so it is known rather than found later.

**3. `diagnose_async_conversion_scope.js` IS BLIND TO `withTransaction()`, AND §24 QUOTES ITS FIGURES.** It counts transactions with `memberCall(n, 'transaction')` — a member expression whose property is `transaction`. **`withTransaction(handle, fn)` is an `Identifier` callee and matches nothing.** So its "103 `db.transaction()` blocks in runtime code, 30 in `routes/retail.js`" is a count of the **unconverted** form only, and it is correct as such — but **26 further transaction blocks exist in `routes/retail.js` on the converted form and appear in no figure this section quotes.** Its §8 dual-context table likewise cannot see a helper called from a converted body at all. The script is measuring the shrinking half. **A reader who takes 103 as "every transaction block" is short by 26 in the one file the conversion is scoped to.** The script is otherwise sound and remains the authority for what it does measure; this is a stated blind spot, not a defect to fix silently.

**4. THE CONVERTED BODIES ARE CLEAN — 56 OF 56.** Every `prepare()` inside all 26 `withTransaction` bodies in `routes/retail.js` runs on the handle the body was given. **Zero run on `tdb()`.** And no converted body reaches any of the six — checked transitively, by breadth-first search through the `routes/retail.js` and `lib/inventory.js` call graph, not only by lexical containment. The batch-4 suite asserts this by regex for two named routes; it holds for all 26 blocks and through intermediate helpers. **The discipline the threading work exists to establish is being held everywhere it has so far been applied.**

**5. `generateRetailSku` OPENS WITH `const t = tdb();` AND READS EXACTLY LIKE AN ALREADY-THREADED HELPER.** A local alias, not a parameter. **This is the precise shape that produced the batch-1 false claim** — a handle-looking identifier at the top of a function, three lines above a `.prepare()`. Two other converted blocks alias the same way, `const db = tdb()` at `routes/retail.js:518` and `const db_ = tdb()` at `:6532`; both are correct and both would read as a raw-handle bug to anyone scanning for one. **The alias is not the error. Reading the alias as evidence is.**

**GREP AND AST DISAGREE, AND THE AST IS THE ONE TO TRUST. Both counts are given rather than reconciled quietly.** A word-boundary grep across the whole tree, all file types, finds **137 matching lines** for the six names — 17, 16, 47, 8, 12, 37, counted before this entry was written. **The AST finds 6 definitions and 30 real call sites.** The gap is not noise and it is worth naming, because every class in it has already misled this record once: **68 of the 137 are in `docs/*.md`**, the rest are code comments, one `console.warn` string literal, one `module.exports` entry, and **source-scanning test assertions that match the helper's name as a string or a regex** — `test_tx_conversion_batch4.js` and `verify-fulfilment-types.js` read `routes/retail.js` as text and assert about it, so grepping for call sites finds their assertions. **One occurrence is a function parameter that shadows the helper's name**: `scripts/test_shipments_split_merge.js` declares `branchUndoCombine(h, id, res, ensureShipments)` and calls `ensureShipments(id)` inside it. That is the injected test double, **not the helper**, and a grep reports it as a twelfth call site. It is not one.

### PATH A STEP 2 — FOUR HELPERS THREADED, MERGED AND DEPLOYED 2026-08-10 AT `3d9091dc`

**`generateRetailSku`, `writeLayout`, `ensureShipments` and `reserveForOrder` now take the handle.** Each takes an OPTIONAL TRAILING handle parameter defaulting to `tdb()`, and the default is evaluated PER CALL, so a caller that omits it still binds to the request's tenant connection at call time exactly as before. **No call site was edited** — all twenty-four keep their existing arity and take the default path. The diff's only lines mentioning these four names are the four function definitions.

**Two of the six from the RECORD CORRECTION entry above were deliberately excluded and remain untouched:** `reconcileTier`, which is money-adjacent and travels with the loyalty cluster, and `createOrReuseManualCustomer`, whose only in-transaction caller is `POST /api/retail-admin/orders` — a route out of step 2 for minting order numbers. Both are asserted unchanged by the suites, so a later batch cannot quietly take them.

**THE EVIDENCE STANDARD THAT WAS ACTUALLY MET, stated because this is the exact work `d7515a36` already claimed falsely.** A signature is not evidence, and a suite that reads only the signature would have passed on the false claim too:

* **The REAL functions are under test, not reproduced copies.** Both suites extract each helper from `routes/retail.js` / `lib/inventory.js` and EXECUTE it with `tdb` injected as a scope variable. A copy can be threaded in the test while the shipped function is not — which is the same species of mistake as trusting the commit message.
* **The handle and `tdb()` point at DIFFERENT DATABASES in every behavioural test.** A parameter that is accepted and then ignored fails, because the rows land in the wrong database. There is no way to pass by adding a parameter alone.
* **MUTATION RED-PROOF, not merely a sabotage flag.** Reverting all four to the accepted-but-unused shape turns **batch 1 red on 6 of 13** and **batch 2 red on 8 of 19**, both headline assertions failing in each. Re-run on the merged tree before the push and both numbers held exactly.
* **Comment-stripped source for every source-level assertion**, using the string-aware stripper from `scripts/check-tenant-als.js`. Twice a comment has answered for the code in this section; it cannot here.
* **Written-column assertions against the REAL schema** — `retail_shipments` (23 columns), `retail_orders` (111), `retail_stock_reservations`, `store_products` (78, forked the way the application forks it). **Two of the suite's own fixtures failed first against the real schema and were FIXED RATHER THAN THE TABLE THINNED**: `store_products.name_en` is NOT NULL with no default, and a pinned `Math.random` of 0 produced a degenerate `DRAFT-` with an empty tail rather than a code the helper would really generate.
* **No local alias is allowed to stand as evidence.** `generateRetailSku`'s `const t = tdb()` is deleted, and both suites assert that no helper keeps an alias of `tdb()` or reaches it anywhere but its own parameter default.
* **No concurrency is claimed.** All four helpers are synchronous, and a concurrency test whose calls originate in one synchronous block tests nothing — the mistake `lib/db-transaction.js` already records. Nesting and outer-rollback are tested instead, which is the property this work changes.

**`ensureShipments`' READS ARE LOAD-BEARING, NOT ONLY ITS WRITES — this is the finding that most justified threading it.** The checkout INSERTs `retail_orders` and `retail_order_items` and then calls it from inside that same transaction. A read on the wrong connection finds no order, takes the `if (!o) return []` arm, and **creates no parcels at all — silently, behind a 200.** All seven of its statements moved onto the parameter for that reason, not just the three that write. A test seeds the order into the `tdb()` database only, passes a handle, and requires the empty answer.

**DEPLOY.** Merged to `main` at `3d9091dc` (force-with-lease pinned to `95f86a33`), workflow run `31344769502`, 1m44s, success. `roots-v2` restarts **1304 → 1305**, one restart, online. The error log gained **238 bytes since boot and they are exactly the routine ALIPAY warning pair** — nothing else. All suites green before and after on the merged tree; lint unchanged at 0 errors / 628 warnings.

**THE AST COUNT IS UNCHANGED AT 103 RUNTIME BLOCKS, 30 IN `routes/retail.js`, AND THAT IS CORRECT RATHER THAN A NULL RESULT.** Threading a handle converts no transaction. The `[8]` dual-context table is unchanged for the same reason: it measures call-site context, not whether a handle is threaded.

#### OPEN — THREE THINGS THIS WORK DID NOT CLOSE

**1. THE INTERNAL NESTING IS SQLite-SHAPED, AND THESE TWO HELPERS ARE THREADED BUT NOT PORTABLE.** `ensureShipments` and `reserveForOrder` keep `h.transaction()`, which better-sqlite3 maps to a SAVEPOINT for free. **There is no equivalent on a pg client.** So taking the handle has made them correct on one driver, not on both, and **this blocks conversion of their enclosing routes** — the checkout above all. It must be solved before the flip, and it is not a detail of these two helpers: every unconverted `.transaction()` reachable from a converted async caller has the same shape.

> **REFRAMED 2026-08-11 — THE PARAGRAPH ABOVE MISDESCRIBES THE PROBLEM, AND THE ERROR IS THE WORD "BLOCKS".** It reads as a missing capability. It is an **ordering constraint**: nothing needs to be built. Convert the enclosing route to `withTransaction` first, and the helper's `h.transaction()` then becomes `await withTransaction(h, …)` in the same commit, nesting correctly through the async context that is already there. **And it does NOT unblock the checkout** — `BEGIN IMMEDIATE` is a second, independent blocker with its own entry below. See NESTING IS AN ORDERING CONSTRAINT, NOT A MISSING PRIMITIVE at the end of this section. The wording above is left standing as the reading that was superseded.

**2. `withTransaction` CANNOT BE NESTED INSIDE A `tdb().transaction()` BODY — RECORD THIS AS A PROPERTY OF THE HELPER SO IT IS NOT INSTRUCTED AGAIN.** The brief for this work asked for exactly that conversion. It was measured before it was written and it breaks the checkout, twice over:

  * **Depth lives in `withTransaction`'s OWN AsyncLocalStorage**, which only a `withTransaction` body populates. Called from inside the checkout's better-sqlite3 `tdb().transaction(...).immediate()`, `transactionDepth()` reads **0**, so it takes the outermost path and issues a literal `BEGIN`. SQLite answers **"cannot start a transaction within a transaction"**.
  * **It is async, and the checkout's transaction body is synchronous.** The body would return — and better-sqlite3 would COMMIT — before any awaited inner work ran. The parcels would be written after the commit meant to contain them, or not at all.

  **Reproduced by execution, not argued from the source**, and pinned as a test in `scripts/test_handle_threading_batch2.js` so the justification cannot rot into a comment nobody re-checks. It is consistent with `lib/db-transaction.js`, which already records that the checkout cannot be converted with that helper as it stands because `BEGIN IMMEDIATE` has no equivalent there and is deliberately not implemented.

**3. `getAvailable` AND `ttlMinutes` REMAIN ON `tdb()` INSIDE `reserveForOrder`, AND THE SAFETY IS CONDITIONAL.** They were left deliberately rather than smuggled into a batch that did not name them. **What makes it safe today is not "SQLite makes it fine" — it is two facts, and they are CONDITIONS, not properties:**

  * **Both callers pass items through `expandStockLines`, which AGGREGATES BY PRODUCT ID**, so no product is ever checked twice in one call and the loop never needs to see a reservation it just inserted.
  * **The enclosing checkout transaction writes neither table `getAvailable` reads** before `reserveForOrder` runs — it writes `retail_orders`, `retail_order_items`, `retail_customer_vouchers`, `retail_vouchers` and `store_products`, and `getAvailable` reads `retail_store_stock` and `retail_stock_reservations`.

  **If either fact stops being true this becomes a live escape**, silently and under load rather than in a test. `ttlMinutes` is a `storefront_config` read that happens BEFORE the transaction opens, so the handle changes nothing about its atomicity. **`getAvailable` is its own step-2 item** — dual-context at `inTx=2 outTx=3`, `lib/inventory.js`.

#### QUEUED — NOT STARTED, IN THIS ORDER

Recorded so the order is the record's rather than the next session's, and so none of the three is rediscovered as new.

1. **`scripts/diagnose_async_conversion_scope.js` is blind to `withTransaction`.** It matches `.transaction` as a member property; `withTransaction(h, fn)` is an `Identifier` callee and matches nothing. **26 converted blocks in `routes/retail.js` appear in no figure it prints, and every count this section has quoted is therefore the unconverted form only** — not a total.
2. **`reconcileTier` swallows its own write failure inside three money transactions.** Its `UPDATE` sits in a `try`/`catch` that only warns, so inside `awardOrderPoints`, `reverseOrderPoints` and `finalizeOrderAddon` the points balance and ledger row commit with a **stale tier and a console line** to show for it. Not an escape — an atomicity defeat, and threading a handle does not touch it.
3. **The undo-combine branch of `POST /orders/:id/shipments/split` clears and COMMITS, then rebuilds in a second transaction.** Between the two the order has no parcels and no item is assigned to one; a crash there leaves it that way. It survived the `85f5bffa` fix untouched because that fix deliberately changed no transaction.

### LOCAL BACKUP RETENTION — HOURLY 24 → 12, DAILY STAYS 30 — DECIDED 2026-08-11

**THE DISK IS THE CONSTRAINT AND CLEANUP DOES NOT SOLVE IT.** `/` is 40G, 81% used, 7.3G free, one filesystem for `/`, `/tmp`, `/var` and `/root`. Measured against the v4.17 reading two days earlier: free fell from 7.8G to 7.3G, **279 MB/day.**

**THE GROWTH IS ALREADY COMMITTED, AND THAT IS THE FINDING.** The local `daily/` tier holds 30 slots. **Sixteen of them still hold July files of 206–330 MB, and each will be replaced by one about 426 MB** — 100 to 220 MB larger. That replacement is scheduled by the calendar and owes nothing to future writes. **Projected with the database FROZEN — no new rows at all — `/` still reaches 90% in 20 days.** At the measured rate it is 11–13 days to 90% and 17–20 days to 95%. **The reclaimable junk is ~776 MiB, about three days.** Deleting it is worth doing and does not change the trajectory.

**HOURLY 24 → 12. DAILY STAYS 30.** Reclaims ~4.76 GiB, measured at 5,107,765,248 bytes for the twelve oldest hourly snapshots. The accepted cost is that intra-day recovery reaches back 12 hours instead of 24.

**WHY THE HOURLY TIER AND NOT THE DAILY ONE — the reason is the recovery horizon, not the size.** Cutting `daily/` to 14 would reclaim more (3.55 GiB) and is the tempting choice. It is the wrong one: **the off-site OSS tier also retains 14 days**, so a 14-day local daily tier would leave **no recovery point beyond 14 days anywhere at all**, on the box or off it. The 30-day local tier is the only thing that reaches further back than a fortnight. Hourly granularity is the cheaper thing to lose, because **a same-day mistake is noticed the same day** — the case hourly snapshots exist for is bounded in hours, and 12 of them still covers it. Depth of history and density of history are not interchangeable, and only one of them has a second copy.

**`/root/scripts` IS NOT IN GIT, AND WHAT IS PUT THERE IS LOST ON A BOX REBUILD.** It is a plain directory on the box under no version control — `git rev-parse` in it returns "not a repository". It is used deliberately, because `scripts/` in the repository is deploy-allowlisted and shipping a diagnostic or a pruner there restarts the application for no runtime reason. That trade is worth making and its cost must be written down. **What lives there after this change:**

- `roots-backup.sh` — the hourly/daily LOCAL snapshot tier, cron `0 * * * *`. The file this retention decision edits.
- `roots-backup.sh.bak-lowio` — an older copy kept beside it.
- `restore-test.sh` — the restore rehearsal.
- `prune-deploy-backups.sh` — NEW. Retains 14 days of `/root/backups/deploy-*`, cron `30 4 * * *`.

**Also box-only and outside git:** `/etc/systemd/journald.conf.d/99-cap.conf`, capping the journal at 200M against an uncapped default of 10% of the filesystem. **A box rebuild restores none of the above.**

**THE TWO BACKUPS BOTH FIRED AT 03:00, AND THEY ARE SEPARATED.** `roots-backup.sh` runs `0 * * * *`, which includes 03:00; `db-backup.sh` ran `0 3 * * *`. `flock` guards `db-backup.sh` against itself only, not against the other program. Their transients add: `db-backup.sh` peaks at **1.00 GiB** in `/tmp` — the raw 647 MB `roots.db` snapshot and its 426 MB gzip existing together during `gzip -f` — and `roots-backup.sh` peaks at about the same in `/root/backups`, for the same reason. **Combined, ~2.07 GiB above baseline, on one filesystem.** Worse, `db-backup.sh`'s preflight reads free space **once, at the start**, and therefore measures it before the other job has taken its share. `db-backup.sh` moves to `03:30`.

**HOW THIS FAILS FIRST, RECORDED BECAUSE IT IS NOT THE OBVIOUS ANSWER.** The disk does not fill and crash the application. `db-backup.sh` requires `MIN_FREE_MB=2048` before it will start, so **at 94.6% full the off-site backup refuses to run** and pages ops. **Backups stop about a day before anything else breaks.** That is the correct order to fail in, and it means 95% is the wall rather than 100%.

#### OPEN — `db-backup.sh`'s PRUNE STEP CANNOT REPORT ITS OWN FAILURE. FIX BEFORE 2026-08-18

> **CLOSED 2026-08-11 at `c5a2eb11`, with a week to spare.** See THE PRUNE STEP CAN NOW REPORT ITS OWN FAILURE at the end of this section. The deadline below stands as written — it is what the fix was scheduled against, and the check to run on the day is recorded in that entry.

**Today the prune is healthy and `pruned=0` is correct**, verified by evaluating the script's own expression on the box rather than reading the log line: the listing parses 12 prefixes, the oldest is `20260803-225106`, the cutoff is `20260728`, and nothing is eligible. That is case (a), not a silent failure.

**The defect is that nothing in the code could tell you otherwise.** Three ways, all in `scripts/db-backup.sh`:

1. **`|| true` on the listing.** If `ossutil ls` fails or its output format changes, `PREFIXES` is empty, the loop body never runs, `PRUNED` stays 0 and the script exits 0. **The output is byte-identical to a healthy run.**
2. **A failed delete only warns.** `WARNING: prune failed for $p` goes to stderr, increments no counter, sets no exit status and fires no alert — while every other failure in that file calls `fail()` and pages ops.
3. **`PRUNED` is never written to the log.** `log_line` records `objects=`, `bytes=` and `date=` only, so there is no durable record of pruning to audit afterwards.

**This is the same class as the two comment-blind source guards already recorded in this section: a check that cannot fail is not a check.** It is listed as OPEN rather than fixed because the fix is a code change to a deploy-allowlisted path and belongs in its own commit.

**THE DATE IS NOT DECORATIVE. The first real prune falls due 2026-08-18**, when `20260803` first drops outside the 14-day window. Until that day the step has never deleted anything, so it has never been observed doing its job. **The fix must land before then**, or its first live execution is also its first untested one.

### THREE PHASES, AND WHY THE FIVE-PHASE READING IS WRONG — DECIDED 2026-08-10

**THERE ARE THREE PHASES. The five-phase reading is retired.** The definitions do not change and are not restated here — Phase 1, Phase 2 and Phase 3 are as written in THE PHASE NUMBERS (2026-08-09, amended today). What is settled now is that the OTHER reading is not an alternative to be chosen between; it is wrong, and this entry records why in terms a later reader can check rather than take on trust.

**WHERE THE FIVE CAME FROM.** Not from conversation. From this section. The ROLLED OUT IN PHASES paragraph at the head of §24 defines Phase 1 and then lists what follows it: the account column, the enforcement gate, the data copy, the switchover, and backups. Number that list and you get five phases — **the switch at 4, backups at 5.** Anyone deriving the numbering from the record rather than from memory arrives there honestly.

**WHY IT IS WRONG, AND NOT MERELY NOT-PREFERRED.** Under that reading backups land AFTER the flip.

**Phase 2 exists precisely to hold everything that must be true BEFORE a flip is survivable** — backups, the rollback plan, the runbook. That is the whole reason the boundary between 2 and 3 was drawn where it was. **The five-phase ordering inverts the one sequencing decision the phases were created to protect.** It does not disagree about a detail inside the scheme; it reverses the scheme's purpose. A numbering that puts the safety net after the event it exists to survive is not a different opinion about ordering — it is the arrangement the phased rollout was invented to prevent, wearing the phased rollout's own numbers.

**WHAT THE TWO READINGS ACTUALLY DISAGREE ABOUT.** Only one thing, and it is worth naming so this is not re-litigated as a matter of taste. Both agree Phase 1 is Postgres installed alongside. Both agree there is a switch and that it comes late. They differ on **which side of the switch the safety net sits**, and the three-phase numbering is the one that answers that question the way §24 already decided it: the flip must never be the test of the safety net.

**THE FIVE-ITEM LIST IS NOT DELETED.** It stays where it is, with a supersession note attached, because a reader who meets the five-phase reading somewhere else needs to be able to find where it came from and see that it was considered rather than overlooked. Every place that carried it now points here.

### A LEASE COMPUTED AT PUSH TIME IS NOT A LEASE — RULE RECORDED 2026-08-10

**THE PROPERTY FIRST, THE COMMAND SECOND, because the property is what has to survive the tooling changing.** A safety check that guards a shared branch is answering one question: *has anything arrived since the state I based my work on?* It can only answer that if it holds **the state the work was based on**. A check that fetches the current remote head at the moment it fires is comparing the remote against itself. It agrees every time, including with work that landed while this work was being written — which is the only case it existed to catch.

**So the value being protected must be captured BEFORE the work starts, and then quoted literally.** Not looked up again, not derived, not recomputed inside the same command that consumes it. If the guard's input can change between when the work was checked and when the guard runs, it is not a guard; it is a formality that passes.

**IN TODAY'S TOOLING that reads:**

* `git push --force-with-lease=main:$(git rev-parse origin/main)` **is not protected.** The `$(…)` runs at push time, so `origin/main` is re-read at push time and the lease approves whatever it finds. The command completes, the flag is present, and the check has approved a branch head it never verified against.
* `git push --force-with-lease=main:95f86a33` **is protected** — a literal forty-hex sha, read and checked before the work began. If main has moved, the push is refused, which is the whole point.

**The bare `--force-with-lease` with no value is not a substitute.** It leases against the local remote-tracking ref, which any intervening `git fetch` — including one a tool ran on its own — silently advances to the new head. Same failure, one step further from view.

**WHAT HAPPENED.** Three commits from a concurrent session were discarded from `main` by a forced push. They were recovered from their own branch and merged back; **nothing was lost.** The recovery merge touched `docs/` only, so it shipped nothing and the app did not restart.

**AND THE RECOVERY IS NOT THE REASSURANCE IT LOOKS LIKE.** It worked because the discarded commits still existed on a branch somebody could name. That is a fact about that day, not a property of the method — the same push against commits that lived only on `main` would have left nothing to merge back. **The rule is not "recovery is available"; the rule is that the lease has to hold a value that was verified first.**

### `reconcileTier` FAILS LOUDLY AND NAMES ITS VICTIM — FIXED AND DEPLOYED 2026-08-11 AT `b7c70d39`

**THE CATCH STAYS NON-FATAL. It now logs at ERROR level naming `customerId`, `want`, `storedTier` and the driver message, then fires a best-effort `sendOpsAlert` — in that order.** The alert is double-wrapped, a `try`/`catch` for a synchronous throw and a `.catch` for a rejected promise, on this file's existing `maybeFlagUncallablePhone` idiom. Either way the `console.error` has already happened and `want` is still returned. Log first, alert second, because the log is the durable local record and the alert is delivery over a network: **the unreliable one never runs before the reliable one.**

**THE DEFECT WAS ATTRIBUTION, NOT SEVERITY.** The old line was `console.warn('[reconcileTier]', e.message)` and named nobody. **A failure you cannot attribute is a failure you cannot repair** — that is what made it worth fixing, not the word "warn".

**WHY NON-FATAL WAS CHOSEN OVER ROLLBACK — REASONING, NOT PREFERENCE, RECORDED SO IT IS NOT REVISITED AS A STYLE CHOICE.** The obvious fix is to let it throw so the enclosing transaction rolls back. That is wrong here, and the reason is specific rather than aesthetic.

**Every caller already swallows.** `awardOrderPoints`, `reverseOrderPoints` and `finalizeOrderAddon` are each invoked inside `try { … } catch { console.error(…) }` at every call site, and none propagates to the HTTP response. **So throwing would not fail a paid order** — that is not the trade. What it would do is drop work silently:

- **`awardOrderPoints`** — the order's points AND its `lifetime_spend` are lost. The `order_earn` row is the idempotency marker and it is written AFTER the reconcile, so **nothing anywhere re-attempts the award.** Worse, the understated `lifetime_spend` then makes the self-heal compute and persist a **WRONG tier** — a permanent wrong answer replacing a temporary one.
- **`reverseOrderPoints`** — a refund's points reversal and spend reduction never happen; the customer keeps points from an order they were refunded for.
- **`finalizeOrderAddon` is the decisive case.** The add-on's item injection and its `retail_payments` row are in the same transaction. **The customer pays for an add-on and does not receive it**, and the return value is ignored by the caller.

Against that, a stale `tier_key` is cosmetic: its only functional effect is the points-earn multiplier on future orders, and **the tier perks — "10% off all orders", "Free shipping ¥299+" — are display copy in the mini-app membership page, enforced nowhere in pricing or shipping.** Permanent silent loss is worse than self-healing staleness.

**`requireRetailAuth` CALLS `reconcileTier` ON EVERY AUTHENTICATED REQUEST, AND THAT SELF-HEAL IS LOAD-BEARING.** It is why the defect never bit: a stale tier survives only until the customer next opens the app, and it recomputes against the committed `lifetime_spend`, which every one of the three transactions writes BEFORE the reconcile. **Anyone changing or removing that call should know it is what makes the non-fatal catch safe.** Remove it and the reasoning above inverts.

**THE ALERT TEXT IS DELIBERATELY CUSTOMER-FREE, AND THAT IS A FLOOD GUARD.** `sendOpsAlert` de-duplicates on **exact message text** for 60 seconds. A per-customer message would defeat that dedup completely — and because this runs on every authenticated request, a dropped column would page the WeCom group **once per request**, while growing `ops-alert`'s `lastSent` map without bound, one key per customer. Coarse text collapses to one alert per minute and one map key. **Attribution lives in the log; the alert points at the log.** A test pins the absence of the customer id so it cannot be quietly reintroduced.

**THE RESIDUAL, STATED: ~60 alerts/hour during a sustained outage.** That is the platform default every `sendOpsAlert` caller already has, not a concession specific to this one. Making it quieter is a change to `lib/ops-alert.js` affecting every caller and is deliberately not bundled here.

**THE MEASURED BASELINE — this had never fired.** Zero `[reconcileTier]` occurrences across every log on the box. The window is `roots-v2-error.log`, born **2026-05-11**, recording **1,091 application boots**. **The capture path was proven rather than assumed:** `[wx-sec]`, another `console.warn` from `routes/retail.js`, appears in that same file, and the sibling `[awardOrderPoints]` handler has fired once. The line could have been written; it never was. That is why the catch could rot unnoticed — **a branch nothing reaches is a branch nothing checks.**

**DEPLOY.** Fast-forward to `main` at `b7c70d39`, lease pinned to the literal `b46698c3`, workflow run `31459167808`, 1m29s, 3 files, `RESULT=SUCCESS`, all three verified byte-identical on the box. `roots-v2` restarts **1306 → 1307**, one restart, online. The error log gained **238 bytes since boot and they are exactly the routine ALIPAY warning pair** — nothing else. Signature untouched; both handle-threading suites still assert it and both stay green.

### A SABOTAGE THAT FAILS TO APPLY IS INDISTINGUISHABLE FROM ONE THAT WORKS — RULE RECORDED 2026-08-11

**A mutation step must PROVE it changed the source before its red result counts as evidence.** If the mutation silently matches nothing, the suite still goes red — every test fails on the error the broken mutation raised — and the run looks exactly like a successful red-proof. **Red for the wrong reason is not proof; it is a green run wearing red.**

Seen on this change. The sabotage spliced the live source using an anchor containing `\n`. The working tree is checked out CRLF (`core.autocrlf=true`; `routes/retail.js` holds 30,229 CRLF pairs and zero bare LF), so the anchor matched nothing, and all ten tests failed with *"SABOTAGE could not find the catch to revert"* — **ten red lines that tested nothing at all.** Rewritten to build the prior version from whole lines, with a guard asserting a normal run really extracts the shipped function.

**THIS IS THE THIRD OCCURRENCE OF A BROADER CLASS ALREADY IN THIS SECTION: A RUN THAT LOOKS LIKE PROOF AND IS NOT.** The first two were comment-blind source matching — the harness's `FOREIGN KEY` strip that made `retail_order_items` unbuildable, and the `PUT /integrations` guard that matched `process.env` inside the comment saying it must not be touched, which *"made a red run look correct while two of its three failures were false."* Same shape, different mechanism. The standing rule from those two — **any source-level assertion must strip comments before matching** — now has a sibling: **any mutation must assert it mutated.** Both are instances of one requirement: **a test harness must be able to fail for the reason it claims.**

### AN ASSERTION THAT COUNTS OCCURRENCES FILE-WIDE WILL BE BROKEN BY UNRELATED CORRECT WORK — RECORDED 2026-08-11

`test_recipient_phone.js`'s *"flagging never blocks the push"* matched `Promise.resolve(sendOpsAlert(` across `routes/retail.js` plus the qingyun daemon and required **exactly 2**. Its stated subject was the two phone-flag helpers; **what it actually asserted was a census of every detached alert in the codebase.** `reconcileTier` adopting the same correct idiom turned it red — a true assertion about the wrong thing.

**Rescoped to assert each helper BY NAME** (`maybeFlagUncallablePhone`, `flagUncallablePhone`), which is what it always meant, and verified still to catch a real regression: removing `Promise.resolve(` from one helper turns it red again. Bumping 2 to 3 was rejected — it would have preserved the census and broken on the next correct alert anywhere in either file.

**The general shape, so it is recognised next time: a whole-file count is a global assertion wearing a local name.** It passes for as long as nothing else in the file does the same right thing.

### UNDO-COMBINE: THE MISSING GUARD AND THE TWO-TRANSACTION WINDOW — FIXED AND DEPLOYED 2026-08-11 AT `12c92ae4`

Two defects in Branch B of `POST /api/retail-admin/orders/:id/shipments/split`, three lines apart, fixed in **two separate commits** so the guard stays separable in history from the atomicity change.

#### COMMIT 1 — `c8ca79de` — THE MISSING `shipsNothing` GUARD

**Branch B called `ensureShipments` unconditionally.** `ensureShipments` does not guard on fulfilment type — **it never reads the column** — so undo-combine on a pickup or counter order **created Air/Land parcels for an order collected at the store.** Every other consumer already checked: the checkout (`if (!isPickup) ensureShipments(...)`), the order-detail read (`shipsNothing(o) ? [] : ensureShipments(id)`) and `mergeAddonItemsIntoShipments`. This branch was the only one that did not.

**AND IT DOES NOT SELF-HEAL, which is what separates it from every other shipment defect in this route.** The order-detail read's own guard returns `[]` for these orders rather than reconciling them, so nothing would ever remove the phantom parcels — `feie` would simply start printing parcel blocks for a counter sale.

**409 `ships_nothing`, NOT A SILENT NO-OP.** Recorded as reasoning because the opposite reading is available and wrong. **Every impossible request on this route is REFUSED** — `400 no_items`, `400 invalid_items`, `409 item_already_dispatched`, `422 would_empty_shipment`, `409 has_tracking` immediately below the new guard. The silent-return precedents that might be cited — `mergeAddonItemsIntoShipments`, the order-detail read — are **internal helpers, not endpoints**; a helper returning early is not an endpoint claiming success. And **this route's own history is the argument**: see "SHIP PART LATER" WAS LIVE AND DESTRUCTIVE-ON-SUCCESS FOR EIGHT WEEKS and `POST /orders/:id/shipments/split` IS REGISTERED TWICE, both 2026-08-09 — the defect there was precisely **answering an impossible request with success rather than a rejection**. `409` for consistency with `has_tracking`, the other order-level blocker in the same branch.

#### THE FINDING: THE READ SELECTED ONLY `id`, AND THE GUARD WOULD HAVE BEEN SILENTLY WORTHLESS

**This is the finding, not a footnote.** The branch opened with:

```js
const o = tdb().prepare('SELECT id FROM retail_orders WHERE id = ?').get(id);
```

`shipsNothing(o)` reads `o.fulfillment_type`. Against that row it would have seen **`undefined` forever**, resolved to "not pickup, not counter", and let every order through. **The guard would have looked correct in review, read correctly in the diff, and done nothing at all** — a fix that ships, passes, and protects nobody.

The read now selects `fulfillment_type`, and **a test asserts that it does**, because the failure mode is invisible: nothing throws, nothing logs, and the only symptom is the absence of a refusal nobody was watching for. **A guard whose input is not in the query is not a guard.** This belongs beside the comment-blind matching entries and the mutation rule — the same family: something that looks like protection and is not.

#### REACHABILITY — MEASURED, NOT ASSUMED: LATENT, NOT LIVE

**Not reachable from the UI.** Three gates, each verified, and all three must hold for that to remain true — which is why they are written down rather than summarised as "not reachable":

1. **`shipmentMergeControls` only draws the "Split into separate parcels" button when the order has exactly one shipment whose label contains `合并`.** A pickup order's `o.shipments` is `[]`, because the admin read guards, so the button never renders.
2. **The combine route cannot create that `合并` shipment either** — it returns early unless `shipments.length > 1`, and a pickup order has none. The hole is bootstrap-proof: you would need the button to create the shipments the button requires.
3. **`fulfillment_type` is never `UPDATE`d anywhere in the repository.** Checked across every file. So a delivery order that legitimately has parcels can never become a pickup order that is then split.

Reachable only by a direct `POST`, or by a future UI change that removes any one of those gates. **A change to the button's render condition is enough to make this live**, which is the reason the gates are recorded individually.

#### COMMIT 2 — `12c92ae4` — ONE TRANSACTION

The branch deleted every shipment and nulled every `shipment_id`, **COMMITTED**, then rebuilt inside `ensureShipments`' own transaction. A process death between the two left the order with no parcels at all.

**The window was SYNCHRONOUS** — nothing awaits anywhere in Branch B — so no other request could interleave and only a hard kill could land in it. Small is not closed, and the repair is three lines.

**This changes the transaction's EXTENT, not its FORM.** It stays on `db.transaction()`. Converting to `withTransaction` would drag `ensureShipments` — blocked behind the checkout — across the conversion boundary, which is exactly why batch 4 excluded this route. **That exclusion still holds.** `logActivity` and the response stay outside, because an audit write must not be able to roll back the operation it describes.

Two properties make it safe, both re-proved on the branch rather than carried over from the survey:

* **NESTING** — `ensureShipments` issues its own `h.transaction()`, which better-sqlite3 maps to a SAVEPOINT when one is already open. Not a new reliance: the checkout opens its transaction at L10197, calls `ensureShipments` at L10310 **inside** that body, and invokes via `.immediate()` at L10410. Every non-pickup order already nests exactly this way.
* **READ-OWN-WRITES** — `ensureShipments` early-returns if any shipment exists, so inside the merged transaction its `SELECT` must see the **uncommitted** delete and proceed. If it did not, the rebuild would silently not happen, which is the failure mode the merge itself could introduce.

#### TWO TEST DECISIONS WORTH KEEPING

* **The rollback test asserts the ORIGINAL count AND the same row ids**, not merely that the count is non-zero. **A partial rebuild is also non-zero and is also data loss**, and identical ids are what prove the delete was rolled back rather than the rows re-created.
* **Read-own-writes is asserted on a PLANNER SPY, not on a row count.** A row count cannot distinguish a real rebuild from an early-return over stale rows — both leave parcels on the order. Only "did the planner run" separates them.

**DEPLOY.** Fast-forward to `main` at `12c92ae4`, lease pinned to the literal `d92de092`, workflow run `31466524800`, 1m21s, 2 files, `RESULT=SUCCESS`, both verified byte-identical on the box. `roots-v2` restarts **1310 → 1311**, one restart, online. The error log gained **238 bytes since boot and they are exactly the routine ALIPAY warning pair** — nothing else.

#### OPEN — BRANCH A VALIDATES OUTSIDE ITS TRANSACTION, AND THAT WINDOW IS AWAITED

Now the largest gap left in this handler. In **Branch A** of the same route, the `item_already_dispatched` check and the `would_empty_shipment` count both run on `tdb()` **before** `await withTransaction(tdb(), …)`. `acquire` in `lib/db-transaction.js` schedules the body via `st.tail.then(run, run)` — **a microtask when the handle is idle**, so nothing interleaves in the common case. **But when another transaction is already in flight on that handle, that wait spans real I/O**, and a concurrent request can move the same items between the check and the write.

So the guards can pass and then be false by the time the transaction runs: a source parcel emptied despite `would_empty_shipment`, or items moved out of a parcel that dispatched in between. Bounded and rare — it needs two operators on one order, or a converted route holding the handle. **Not fixed here, deliberately: this brief was Branch B, and Branch A was explicitly out of scope.**

### THE MUTATION RULE'S FIRST USE HELD — RECORDED 2026-08-11

The rule from v4.27 — **any mutation must assert it actually modified the source before its red counts as evidence** — was used for the first time in `scripts/test_shipments_split_undo.js`, and it worked. Verified by pointing a mutation at a pattern that cannot match: instead of a tidy red that would look like a successful red-proof, **every test reported "matched NOTHING — it changed no source, so every failure below would be meaningless."** The assertion is per PART rather than once at the end, because a multi-part mutation can have one part land and another silently miss.

**And the fragility recurred while writing the very suite that guards against it.** An anchor containing a literal `\r\n` was written first — on a CRLF tree, that is exactly the shape that matches nothing — and was replaced with newline-agnostic regexes using `\s*`. **The rule is therefore sharpened: a mutation anchor must not contain a line ending at all.** Match around whitespace, never through it. The replacement side may contain newlines; it is building source, not matching it.

### THE PRUNE STEP CAN NOW REPORT ITS OWN FAILURE — FIXED AND DEPLOYED 2026-08-11 AT `c5a2eb11`

Closes the OPEN item recorded above on 2026-08-11, seven days before its deadline. **The pruning always worked. What did not work was the step's ability to say so when it stopped working** — and the first prune with anything actually eligible falls due **2026-08-18**, so until now the loop body had never executed in production and the step had never had a chance to fail.

**FOUR STATES, NOT ONE.** The retention block now reports `prune=<status>` with `eligible=`, `removed=`, `failed=` and `cutoff=`:

| state | meaning |
|---|---|
| `ok` | listing parsed, eligible set processed, every delete succeeded |
| `failed_listing` | `ossutil ls` exited non-zero |
| `failed_parse` | the listing **succeeded** and its output no longer parses |
| `failed_delete` | listing fine, at least one delete failed |

**`failed_listing` AND `failed_parse` ARE DELIBERATELY SEPARATE, and the distinction is the interesting one.** A listing that *fails* is an outage. A listing that *succeeds and no longer parses* is an **ossutil upgrade** — a different output shape, a changed prefix format — and it is the case that would otherwise be **indistinguishable from an empty bucket**, because both yield zero parsed prefixes from a command that exited 0. It is discriminated by the output still containing lines under our own prefix while none of them matched the pattern. Collapsing the two would leave the most likely future failure reading as "nothing to do".

**THE FAILED LISTING ALERTS LOUDLY AND DOES NOT FAIL THE RUN. This is the deciding argument and it belongs in the record.** By the time retention runs, every object is uploaded and verified and `/tmp` is clean: **the backup has SUCCEEDED**. Calling `fail()` would write `FAIL` to `db-backup.log` — **and that line is what a later reader uses to decide whether a restore is even available.** Marking a good, verified backup `FAIL` because a listing timed out answers that question **wrongly, and in the direction where a restore is not attempted**. The one thing worse than a broken prune is a working backup that nobody believes in. So the prune reports on its own terms — its own status field, its own counters, its own ops alert — and the backup's verdict stays truthful.

**`trap - ERR` MOVED BEFORE THE BLOCK, AND THIS IS THE PATTERN RATHER THAN THE INSTANCE.** The decision above is only as good as every `|| true` in the block being right; one unguarded command and the ERR trap fires `fail()` anyway, silently undoing it. Moving the trap release to the top of the retention block makes the invariant **structural**: nothing after that point *can* rewrite the backup's verdict, whatever anyone adds later. **Where a section of a script must not be able to change an already-earned verdict, release the trap at its boundary rather than defending every statement inside it.** The general form: an invariant enforced at a boundary survives edits; an invariant enforced statement-by-statement does not.

**ONE ALERT PER NON-`ok` STATE, NEVER ONE PER OBJECT** — the same dedup reasoning recorded in `reconcileTier` FAILS LOUDLY AND NAMES ITS VICTIM (2026-08-11): `sendOpsAlert` de-duplicates on exact message text, so a per-object message would defeat it entirely and page the group once per failed prefix. The summary carries the counts; the log carries the detail.

**THE LOG LINE NOW CARRIES THE OUTCOME.** `log_line` appends `PRUNE_SUMMARY` when retention has run, and it is empty on every path that fails earlier, so a `FAIL` line is unchanged. A zero that is printed is a measurement; a zero that is never written down is not.

**DEPLOYED RATHER THAN `[skip deploy]`, DELIBERATELY.** This only affects a cron job, so the restart buys nothing on its own merits — but **`[skip deploy]` defers rather than exempts**, and a skip would have made the fix's arrival on the box depend on unrelated work landing before 2026-08-18. Likely is not certain, and the fix is worthless until it is on the box. Hand-copying was rejected for a stronger reason: it breaks the pipeline's guarantee that **deployed bytes are committed bytes**, which is the property the verification step exists to hold. One restart, 1312 → 1313.

**Verified on the box by CONTENT, not by the merge**: `sha1sum /root/roots-v2/scripts/db-backup.sh` = `b6d31d5d…`, identical to the committed file, where it was `d59c4eaf…` before. Workflow `31470203715`, 2 files, `RESULT=SUCCESS`, both byte-identical. Error log +238 bytes, exactly the routine ALIPAY pair.

#### WHAT TO CHECK ON 2026-08-18 — WRITTEN DOWN NOW, NOT RECONSTRUCTED THEN

That is the first run with anything eligible: `20260803` drops outside the 14-day window, so three prefixes become prunable. **Run this after 03:30 China time:**

```bash
ssh root@47.239.89.63 "tail -3 /root/roots-v2/logs/db-backup.log; echo '--- remaining prefixes ---'; /usr/local/bin/ossutil ls oss://tacet/daily/ -d 2>&1 | tail -5"
```

**Expected:** the newest log line reads `prune=ok eligible=3 removed=3 failed=0 cutoff=20260804`, and the `20260803-*` prefixes are gone from the listing. **`eligible=3 removed=3` is the whole point** — it is the first time this step has ever done real work, and the first time the log has been able to say it did.

**Anything else is a finding, and each shape means something different:** `prune=failed_listing` is an outage or a credentials problem; `prune=failed_parse` means ossutil changed its output and the `sed` pattern needs updating; `prune=failed_delete` with `eligible=3 removed=0` means a permissions or bucket-policy change. **`eligible=0` would mean the cutoff arithmetic is wrong**, since three sets are provably older than fourteen days by then. Any non-`ok` state also pages the System Alerts group, so silence plus `prune=ok` is the pass condition.

### A HARNESS WHOSE SHELL OPTIONS DIFFER FROM THE REAL SCRIPT'S IS TESTING A DIFFERENT PROGRAM — RULE RECORDED 2026-08-11

The prune test drives the block extracted from `db-backup.sh` through a generated driver. The driver was written `set -uo pipefail`. **The real script runs `set -euo pipefail`.**

Under `-e`, a single failing command anywhere in the new block exits the script — **which is exactly the class of defect the test exists to catch**, and the harness as first written would have hidden it: every case would have passed while the shipped script aborted mid-retention. Caught before merge and corrected; the driver now declares the same options as the file it stands in for.

**The rule generalises past `set -e`.** A harness that reproduces the environment of the code under test approximately is testing a program that does not exist. Shell options, `PATH`, locale, and the shell itself (`sh` is not `bash`) all belong to the program's behaviour, not to its surroundings. **Where a harness must restate something the real script declares, that restatement is a place drift lives** — the same hazard as a fixture table thinner than the schema, one layer down.

**Its own sibling is the counter-example, and deliberately so:** the test harness itself stays `set -uo pipefail` **without** `-e`, because a harness that aborts on its first failing assertion reports one failure instead of all of them. The two files differ on purpose, which is why both now say so in a comment.

### A FIXTURE PINNED TO REAL-WORLD DATES GOES STALE SILENTLY — RECORDED 2026-08-11

The prune test's first draft seeded the stub listing with **the real prefixes that were in the bucket on 2026-08-11**. Every one of them is *inside* the 14-day retention window — which is precisely why production reports `pruned=0` — so **nothing was ever eligible, the loop body never ran, and four cases failed**.

They failed loudly, so this cost minutes. **The dangerous version of the same mistake passes**: had the fixture been seeded a month earlier, those prefixes would have been eligible on the day it was written and would have silently stopped being eligible later, turning a real test into a green one that exercises nothing. Fixture dates are now computed relative to today — `60 days ago` for the eligible set, today for the retained one — so the fixture cannot age out of its own meaning.

**Same family as the AST-authority blindness and the file-wide census: something that reports success while measuring nothing.**

### `scripts/test-deploy-base.sh` CANNOT RUN ON THE WINDOWS BOX — RECORDED 2026-08-11 SO NOBODY CHASES IT AGAIN

It reports **2 passed / 8 failed** on the Windows development machine. **That is environmental and pre-existing, not a regression.** The suite extracts the "Compute deployable files" step out of `deploy.yml` with `python3 -` and PyYAML, and **python3 is not installed there** — Windows answers the call with its Microsoft Store shim, the extraction produces nothing, and every case that needs the step fails with an empty file list.

Confirmed by running it against an unmodified tree: same 2 / 8. **It runs correctly on Linux and in CI.** Anyone seeing those eight failures on Windows should stop there rather than debugging the deploy-base logic, which is fine.

### NESTING IS AN ORDERING CONSTRAINT, NOT A MISSING PRIMITIVE — DECIDED 2026-08-11

**Nothing is built. That is the decision.** Surveyed at this head; supersedes the framing in the OPEN item above, which called the SQLite-shaped nesting a blocker as though a capability were missing.

#### THE POPULATION — EIGHT BY THE MECHANICAL TEST, TWO THAT ACTUALLY NEST

Counted by AST rather than by grep, on the lesson the `withTransaction` blind spot taught: **eight helpers open a transaction on a handle that was PASSED IN.** Only **two** are genuinely nested inside a caller's transaction on the same handle. The other six are not, and each for its own reason — written out so nobody re-counts to eight and re-opens this:

| helper | why it is NOT a nesting case |
|---|---|
| `enqueueAll` — `lib/eleme-sync.js:54` | its only caller is a route handler doing `const db = tdb()`; the handle is **outermost** |
| `sweepStockDrift` — `lib/meituan-drift-sweep.js:170` | called only from `meituan-daemon.js` and `shangou-daemon.js`, each passing its own **top-level** handle |
| `seedTenantDefaults` — `lib/provision-tenant.js:196` | receives `tenantDb` — a **different database** from the caller's `mainDb` transaction, so there is no nesting to resolve |
| `initTenantSchema` — `lib/tenant-db.js:116` | file-per-account machinery, and §24 **deletes this file** in a later phase; it never reaches pg |
| `repointMeituanProductFk` — `database.js:4471` | a **SQLite table-rebuild migration** (`RENAME TO …__fkmig`, `pragma foreign_keys=OFF`) |
| `dropMeituanQueueProductNotNull` — `database.js:4507` | same class |

**The last two deserve the emphasis: Postgres does not need them at all.** They exist because SQLite cannot ALTER a constraint and the table must be rebuilt around it. Postgres drops a constraint directly, and its schema is built from translated DDL rather than migrated from SQLite. **They die at the cutover rather than porting.**

So the real population is the two already known: **`ensureShipments` and `reserveForOrder`.**

#### OPTION A IS UNAVAILABLE, AND THAT IS A MEASURED RESULT

The cheapest possible fix — delete the internal transaction because the caller always has one — **does not apply to either helper.** Both are dual-context, counted at this head:

* **`ensureShipments` — 2 nested** (the checkout at L10310, undo-combine at L21523) **and 9 standalone** admin routes: order detail, tracking save, tracking resubscribe, JD waybill, tracking delete, ETA set, ETA clear, waybill cancel, print-data.
* **`reserveForOrder` — 1 nested** (the checkout at L10347) **and 1 standalone**, `POST /api/retail/topup/create`.

A standalone caller needs the helper's own transaction, so it cannot be removed. **Recorded as a result rather than a dead end**: ruling it out is what makes the rest of the reasoning necessary.

#### THE RULE — A HELPER MAY GO ASYNC ONLY WHEN EVERY ONE OF ITS CALLERS IS ASYNC

**Convert the enclosing route first. The helper's `h.transaction()` becomes `await withTransaction(h, …)` in the SAME commit.** Never the other way round, and never in separate commits.

**THE EARLIER OBJECTION WAS TO CONVERTING A HELPER BEFORE ITS CALLER — NOT TO `withTransaction` ITSELF.** That distinction is the whole finding. Both directions are already pinned as tests in `scripts/test_handle_threading_batch2.js`, and they say opposite things about opposite situations:

* **`withTransaction CANNOT be nested inside a non-withTransaction transaction`** (L369). Against a raw `BEGIN IMMEDIATE`, `transactionDepth` reads **0** — the depth lives in `withTransaction`'s own AsyncLocalStorage, which only a `withTransaction` body populates — so it takes the outermost path, issues a literal `BEGIN`, and SQLite answers *"cannot start a transaction within a transaction"*. **This is a statement about an UNCONVERTED caller.**
* **`withTransaction DOES nest correctly inside its own kind — the control`** (L383). Depth reads 1 then 2 and the inner call takes the savepoint path. **This is the same helper, inside a CONVERTED caller, working.**

Once the route is a `withTransaction` body the async context exists, `depthFor` returns greater than zero, `runNested` issues the savepoint, and the body may be async because its caller's is. **Nothing changes in `lib/db-transaction.js`.** The handle-threading merged at `3d9091dc` is what makes this work under pg, where `tx` is a checked-out client rather than the same object — so that work was the right prerequisite, done in the right order.

**VERIFIED ON THE BOX 2026-08-11 — ALL FOUR PROPERTIES PASSED.** There is one commit in every conversion where the route is already a `withTransaction` body and the helper still holds `h.transaction()`. **That shape had never run** — no converted route calls either helper, which is exactly why batch 4 excluded those routes — so it was recorded as unverified until it was measured. It has now been measured, against a throwaway `/tmp` database, never `data/roots.db`:

1. **NESTS** — an inner `db.transaction()` inside a `withTransaction` body commits with the outer rather than erroring on a second `BEGIN`.
2. **ROLLS BACK** — an inner failure rewinds only the inner write; the outer transaction survives and still commits its own.
3. **NEGATIVE** — `withTransaction` inside a raw `BEGIN IMMEDIATE` still fails. **This is the property that makes the other three mean anything**: had it passed, the checks would have been agreeing with everything rather than discriminating.
4. **CONTROL** — `withTransaction` inside `withTransaction` still reaches depth 2.

**THE MECHANISM WAS OBSERVED, NOT INFERRED: `db.inTransaction` reads `true` inside the `withTransaction` body.** That is what routes the inner `db.transaction()` to a SAVEPOINT instead of a second `BEGIN`, and it is the single fact the whole decision rests on. `withTransaction` opens with a plain `exec('BEGIN')`, and better-sqlite3 sees that as a real open transaction.

**THE DRIVER PAIRING IS PART OF THE RESULT: better-sqlite3 `^9.4.3` on Node `v20.20.2`, which is production's own.** Recorded because the property is driver behaviour, so **a pass on a different ABI would prove less** — this is the same reason the deploy workflow runs its fulfilment test on Node 20 rather than 24. A future driver or Node upgrade invalidates this measurement and it must be re-run, not assumed.

**THE PROBE LIVES AT `/root/check-nesting.js` ON THE BOX AND IS NOT IN GIT.** It is lost on a rebuild, exactly like the files recorded under `/root/scripts` in the local-backup-retention entry above. Kept off the deploy allowlist deliberately — it is a one-off measurement, not tooling — but that means **the evidence for this decision is reproducible only while that box exists**. If it matters later, re-create it from the four properties listed above rather than hunting for the file.

#### WHY OPTIONS B AND C WERE REJECTED

**B — a seam-level nesting primitive — collapses into the conversion.** A primitive that works under pg must be async, because pg is async; an async primitive makes the helper async; an async helper cannot be called from inside a `db.transaction()` body, which is where the checkout calls both of these. So the "portability fix" turns out to be the conversion wearing a different name. It would also put transaction semantics into `lib/db-seam.js`, whose scope is money conversion and which **deliberately passes `transaction()` straight through** — its own comment at line 137 lists it among the methods that fall through untouched.

**C — change `withTransaction`'s depth tracking to detect a foreign transaction — is the one to refuse hardest.** It would mean reading `db.inTransaction`, which **exists on better-sqlite3, is `undefined` on `node:sqlite`, and is absent on a pg client**: correct on one of three backends, and silently wrong on the two that matter next. Worse, **it re-introduces the defect repaired at `dc91e62f`.** Reading transaction state OFF THE HANDLE rather than out of the calling async context is exactly what folded two independent concurrent requests into one transaction — one `BEGIN` for two requests, one committing while the other was still running, either destroying the other's write or committing a rolled-back one. Both modes were reproduced on a real handle. **The handle cannot answer "am I inside a transaction" for a caller; only the caller's own context can.** That is settled and must not be undone to make nesting easier.

#### FOR WHOEVER WRITES THE pg SIDE — THE SAVEPOINT DETAIL

Recorded now because it is where this usually goes wrong, even though nothing is being built:

* **Name a savepoint by the DEPTH it opens at** — `tacet_sp_${depth}` — because only one savepoint can be live at any given depth, so siblings and re-entered blocks cannot collide. Postgres permits duplicate names and silently shadows the older one, which destroys the wrong rewind point rather than erroring. The scheme in `runNested` is already correct; reuse it rather than inventing a counter.
* **BOTH statements on the failure path.** `ROLLBACK TO SAVEPOINT x` rewinds but **leaves the savepoint on the stack**; without `RELEASE SAVEPOINT x` the nesting level never closes. `runNested` already issues both.

### `BEGIN IMMEDIATE` IS WHAT ACTUALLY BLOCKS THE CHECKOUT — OPEN, DECISION NOT MADE — RECORDED 2026-08-11

**Solving the nesting does NOT unblock the checkout.** Stated plainly because the opposite was assumed, and because it makes the nesting work worth less than it looked.

The checkout runs `tx.immediate()` → `BEGIN IMMEDIATE`, and the comment at `routes/retail.js:10408` says what for: the write lock is taken at transaction start, **making `nextOrderNo()`'s read-then-insert atomic even across processes.**

`nextOrderNo()` does `SELECT MAX(CAST(SUBSTR(order_no, 3) AS INTEGER)) …` and the caller then INSERTs. **Under Postgres's MVCC that is not safe by default**: two concurrent checkouts under READ COMMITTED both read the same maximum, both compute `TC000123`, and both insert.

**`BEGIN IMMEDIATE` HAS NO pg TRANSLATION BECAUSE IT IS A LOCKING MODE, NOT AN ISOLATION LEVEL.** There is nothing to map it onto; the concurrency control has to be replaced with a different mechanism, which is a design decision rather than a porting exercise.

**Three candidate answers, with what each costs. This is Ash's decision and it is not yet made:**

1. **A sequence** — `nextval('retail_order_no_seq')`. Atomic by construction, no lock, no retry, and the migration tooling already understands sequences. **Cost: numbering semantics change.** A rolled-back order burns its number permanently, where the current `MAX + 1` scheme reuses gaps. Customer-visible order numbers would develop holes.
2. **`pg_advisory_xact_lock(key)`** — the closest behavioural match. Keeps `MAX + 1` exactly as written and serialises the critical section across processes for the transaction's duration. **Cost: a hand-held lock is a hand-held deadlock risk**, and it scopes the serialisation to one named key rather than to the whole transaction, so every future writer of order numbers has to know to take it.
3. **`SERIALIZABLE` isolation with retry** — correct by the database's own definition. **Cost is the largest**: `40001` serialization failures become an ordinary outcome the checkout must catch and retry, which changes error handling well beyond this one function.

**Not designed here, deliberately.** The options are recorded so the decision is made from a written list rather than reconstructed at the flip.

## 25. A printed slip that goes stale is corrected on paper, not reprinted — DECIDED 2026-08-07

DECISION: When a customer reschedules an order whose receipt has already printed, the printer emits a short CHANGE SLIP naming the new day, the day it replaces, and enough identity to match it to the original. The original receipt is never reprinted.

WHY THIS SHAPE: A printed slip is a snapshot of the order at the moment it was cut, and nothing in the system refreshes it. Order TC000180 printed at 09:17 carrying no date at all — correctly, because at that moment the customer had chosen none — and the customer then booked Aug 10. The kitchen was holding paper that said nothing about a day the order now had. This is a class of problem rather than one order: any field the receipt prints can be changed after the receipt exists, and the paper has no way to know.

REJECTED — REPRINT THE FULL RECEIPT: Two near-identical slips for one order end up on the same spike, and nothing on either says which is current. Staff would have to read both in full to find the single line that differs, and the stale one stays in the pile because there is no reason to remove it. A short slip that carries only the change is physically unmistakable at arm's length — that is the whole reason it is short, not an aesthetic preference.

REJECTED — MOVE THE PRINT TRIGGER TO PREPARATION TIME: Printing when the kitchen picks the order up, rather than when payment lands, would remove the staleness class outright instead of correcting it after the fact — a strictly better shape. It is not taken because it changes when every scheduled order reaches the kitchen, which is an operational change well beyond a printing defect. Recorded here so the option is not re-derived from scratch the next time a stale-paper problem appears.

TOGGLE: The change slip rides the existing `pp.auto_print` rather than a switch of its own. A separate toggle was considered and rejected: an operator who wants receipts wants to know when a date moves, and the failure mode of an independent switch is a slip that silently does not print — which nobody notices until a parcel goes out on the wrong day.

VOCABULARY: Locked in docs/tacet-delivery-vocabulary.md, "Date changed after printing" — `改期` for the head, `顾客预约` for the new day, `原定时间` for the superseded one. `改期` is fulfilment-neutral: one term for delivery and pickup alike, because a date moving is equally true of both. No pickup variant is to be added; the three-way pickup relabelling recorded elsewhere is a defect, not a pattern to extend.

SHIPPED: 794dc601, PR #17. Findings that led here are in docs/receipt-booked-date-findings.md §§6-7.

## 26. The customer's own language choice governs every customer surface — DECIDED 2026-08-09

DECISION: The language a customer selects in the mini app governs everything that customer sees, across the online store and the mini app alike. A customer who selects Chinese sees Chinese — every screen, every label, every server-rendered line. This is PER VIEWER, not per merchant. Two customers of the same business, on the same screen, at the same moment, read it in two different languages, and neither of them is reading "the business's language".

WHY THIS SHAPE: A merchant decides which languages are on OFFER; a viewer decides which one they READ. Those are two different settings and collapsing them into one is what produces a half-translated page — a Chinese customer given an English button because the shop is filed as English, or an English customer given a Chinese one because the merchant is in Guangzhou. The merchant-side half — which languages a business supplies content in — is §0's LANGUAGE IS PER BUSINESS TO OFFER, PER VIEWER TO READ, and is untouched by this. This section settles only the viewer-side half, which that rule names but does not answer.

MECHANISM, AS BUILT: The client says which language it is in, on every call. Each client's api layer sets an `x-lang` request header — `cn` or `en` — the same way it already attaches `x-wx-appid`, so the language is stated once for the whole surface rather than per call site. `?lang=` is honoured as a second source, because it is the existing house mechanism: the tracking page and the tracking JSON endpoint already read it and two mini-app pages already send it. Absence means ENGLISH, deliberately — an older client that sends nothing sees exactly what it sees today, so nothing shifts under a customer who has not updated. This mechanism is BUILT AND MERGED. That is a statement about the code, not about what a customer is served: the mini app reaches customers only on a republish, which no merge performs.

NO AUTO-DETECTION. `Accept-Language` is never read. Nothing infers the language from the browser, the device, the phone number, the delivery address or the account. The viewer's stated choice is the only input. A guess that is right nine times in ten is still a screen the customer did not ask for, and there is no way for them to tell the system it guessed wrong other than the selector they already used.

WHERE THE LANGUAGE IS NOT STORED, AND WHY THE CLIENT HAS TO SAY: There is no `lang` column on `retail_customers` and no merchant language key in `storefront_config`. Both storefronts hold the choice client-side — the mini app in `globalData` and wx storage, the web store in `state.lang` — and neither persists it. The header is therefore not a convenience over a stored value; it is the only place the choice exists at request time.

REFERENCE IMPLEMENTATION: `viewerLang()` in `routes/retail.js`, and `lib/slot-label.js` for a renderer that takes the viewer's language as an input rather than assuming one. New server-rendered payload fields follow those two rather than inventing a third way to decide.

KNOWN GAP — DELIVERY SLOT LABELS ARE STILL FROZEN IN THE LANGUAGE THE ORDER WAS PLACED IN: `retail_orders.delivery_slot_label` is a SNAPSHOT of a merchant's slot wording, taken at checkout and echoed by every customer surface afterwards. A customer who ordered in Chinese and later switches to English still reads that label in Chinese. This is recorded as a GAP AGAINST THIS RULE, NOT AN EXCEPTION TO IT — the rule above is what the label should do and does not yet do. It is not fixed by translating the stored string, because the string is a merchant's own wording rather than a known phrase, and half-translating a label whose time window stays Chinese is the glued-language defect. Closing it properly means the order storing WHICH slot was chosen and the label being rendered per viewer at read time, which belongs with the Orders stage rather than here.

## 27. The mini app publish pipeline does not exclude files by dependency graph — DECIDED 2026-08-09

DECISION: The mini app is published with every file in the project. No build or upload step may decide, from a computed dependency graph, that a file is unreachable and drop it. In the WeChat tooling this means `ignoreUploadUnusedFiles` in `miniapp/project.config.json` and `ignoreDevUnusedFiles` in `miniapp/project.private.config.json` are OFF and stay off. The rule is about the class of mechanism, not about those two keys: any future packer, bundler or tree-shaker in this pipeline is covered by it.

WHY THIS SHAPE: A dependency graph is a claim about the code, computed once and cached. When it is stale it is not vague, it is wrong in one specific direction — it knows about the files that existed when it was built and not about the ones added since. Exclusion driven by that graph therefore fails on exactly the newest code, which is the code most likely to be shipping and least likely to have been exercised. The saving it buys is bundle size. The price is a publish that can be wrong with nothing anywhere saying so.

THE FAILURE THAT PRODUCED THIS RULE: The published checkout page rendered nothing. `pages/checkout/checkout.js` requires `utils/phone.js` on its eleventh line. The device reported that module as not defined, and the page, having failed to register, resolved to the framework's not-found placeholder — which reads as a second missing component and is not one. The file was on `main`, byte-identical to origin, tracked, never deleted, never ignored, correctly cased, in the same package as its caller, and present in all five working trees on the machine. It had been added two days earlier. Of the eight modules that page requires, the five that resolved all date to the first commit of the repository; the one that failed was the newest file in the list. The upload dropped it, and reported success.

SILENT AT BUILD TIME, TOTAL AT RUNTIME. Both halves matter and neither is survivable on its own terms. Nothing fails at build: no error, no warning, no diff, an upload that completes normally and a version that looks like every other version. Nothing degrades at runtime either — a missing module is not a missing feature but a page that does not exist, so the customer gets a blank screen at checkout, which is the last screen a shop can afford to lose. The lifecycle hooks still fire, so instrumentation that watches for page loads sees a healthy page.

WHY IT RESISTS INVESTIGATION: The evidence a reader reaches for first is the repository, and the repository is innocent — the file is there, the require is correct, the history is clean. Every check that can be run against source passes, because the defect is not in the source. It exists only in the artefact, which is the one thing not under version control and not readable after the fact. Two of us can look at the same correct code and be no closer to the cause.

REJECTED — KEEP THE FLAGS ON AND REBUILD THE CACHE BEFORE EACH PUBLISH: This makes correctness depend on a person remembering a step whose omission is invisible. The step has no output to check, so there is no way to tell a publish that did it from one that did not, and the failure it prevents shows up only on a customer's device.

REJECTED — KEEP THE FLAGS ON AND LIST THE AFFECTED FILES IN `packOptions.include`: A hand-maintained list of files the graph gets wrong has to be extended every time a module is added, by someone who has no reason to suspect it is needed. It is the same defect with an extra place to forget.

THE COST OF THIS RULE, STATED PLAINLY: The bundle carries files nothing requires, and the package is capped at 2 MB. If that ceiling is ever reached, the answer is to delete what is genuinely dead, by reading the code, and record the deletion — not to switch the exclusion back on. Deleting a file that turns out to be needed fails loudly on the next publish. Excluding one does not fail at all.

WHERE THIS IS WRITTEN DOWN NEXT TO THE SWITCH: JSON has no comments, so the reason lives in the `description` field of `miniapp/project.config.json`, which is a real DevTools field and survives the rewrites the tool performs on that file. Anyone who opens the file to turn the flag back on reads why it is off before they do.

WHAT A MERGE OF THIS DOES NOT DO: It does not fix the live blank checkout. Configuration reaches customers only on a republish, and a republish builds `roots-v2\miniapp` — the main working folder — not a worktree. The page stays blank until someone republishes from a main folder that carries this change.

## 28. Related documents

- docs/tacet-glossary.md — binding definitions, v1.4, 2026-07-31. The words in this document are used with the meanings defined there.
- docs/tacet-desktop-patterns.md — the rulebook for how a desktop admin page is put together, v4.2, 2026-08-03. Prescriptive except on Orders: when a rule and an unbuilt page disagree, that document wins.
- docs/tacet-core-survey.md — verified current-state inventory, 2026-07-30
- docs/tacet-product-fields.md — product field inventory, 2026-07-31. 78 columns; 41 contested writes.
- docs/tacet-stock-model.md — stock and reservation behaviour, 2026-07-30. Records 14 inconsistencies in the store stock model; three were live bugs.
- docs/tacet-locations-survey.md — locations current state, 2026-07-30. Records that `markets` and `retail_stores` are two complete competing models, and that `retail_stores` already holds everything operationally real.
- docs/tacet-order-routing.md — how a fulfilment location is chosen, and what happens on stock shortage, 2026-07-31. Read-only behavioural survey.
- docs/tacet-multibusiness-audit.md — audit against §0, 2026-07-31. 121 findings, 26 blockers. Headline: Roots is the default database, not a row in it.
- docs/tacet-money-model-survey.md — the money-unit gap between the application and Postgres, 2026-08-04. Read-only survey behind the boundary-layer decision in §24. 92 columns changed unit, plus nine to numeric(14,6); records the read and write sites, the SQL-side arithmetic a JavaScript boundary cannot reach, the mixed-engine transition hazard, and the second money model in storefront_config that the boundary layer structurally cannot reach.
- docs/tacet-postgres-status.md — the migration's LIVING STATUS, both halves in one place: what is built and what is left, 2026-08-03 onwards, v2.0. Renamed from tacet-postgres-build-record.md, which carried only the built half. **It indexes; this section explains.** Every remaining item there cites the entry here that owns its reasoning, carries no reasoning of its own, and **this section wins on any disagreement without argument** — that rule is what stops it becoming a second decision record that drifts from this one. It closes no open item and supersedes nothing here. It also carries its own update protocol, and states the head, the decisions-record version and the AST counts it was last true at, so a reader can tell at a glance whether it has gone stale.
