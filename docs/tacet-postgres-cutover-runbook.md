# The Postgres cutover runbook — v0.2, FIRST DRAFT, NOT EXECUTABLE

**A procedure, not a summary.** Written to be followed literally, at 3am, by one person who is not a developer, with the shop trading and no ability to improvise.

> **CORRECTED BEFORE MERGE, 2026-08-19 — v0.1 → v0.2, and the correction is recorded rather than tidied away.** The draft was written against a reading of `claimMigrationCredit` that had been out of date for six days. **G11 said both of its pieces were unbuilt; the writer fix landed at `225aa13` on 2026-08-13** and is on `main`. Two forward-looking claims that rested on it were false when this file was written and are struck below. **The gap does not close** — the backfill for the seven pre-fix customers is still unbuilt, check F still fails on ¥3,669.64, and Part G still needs its baseline. **Still 23 gaps.** Line-number cites for `reverseOrderBalance` and the `sqlite_sequence` reset were re-derived at this head in the same pass; both had drifted. See §24 and the re-derivation inside G11.

**READ THIS BEFORE ANYTHING ELSE. THIS RUNBOOK CANNOT BE FOLLOWED TODAY.** It is a first draft written to find out what is missing, and the missing parts are marked in it rather than papered over. **Twenty-three steps of this procedure have no command to run, because the thing they depend on has not been built.** They are marked 🔴 **GAP** and numbered `G1`–`G23`. The index is in PART A.

**A runbook that reads as complete when it is not is worse than no runbook**, because it gets trusted on the night. So where a step could not be written honestly, it is left as a hole with a name, and the hole says what has to exist before it can be filled.

**DO NOT USE THIS DOCUMENT AS A CHECKLIST UNTIL EVERY GAP IS CLOSED OR EXPLICITLY WAIVED IN WRITING.**

---

## HOW TO READ A STEP

Every real step has four parts, and a step without all four is not finished:

- **RUN** — the exact command. Copy it. Do not retype it from memory.
- **GOOD** — what the screen looks like if it worked.
- **BAD** — what the screen looks like if it did not.
- **IF BAD** — what you do about it. This is never "investigate".

Every gap has four different parts:

- **WHAT THIS STEP WOULD DO** — the job the missing thing does.
- **WHY THERE IS NO COMMAND** — what does not exist.
- **WHAT MUST EXIST FIRST** — the named piece of work, with the record entry that owns it.
- **IF YOU REACH HERE ON THE NIGHT** — always: stop.

**Every command in this document runs on the production box over SSH** unless it says otherwise. The box is `root@47.239.89.63`. Commands are written with the `ssh` prefix already in them so they can be pasted from a laptop without thinking about which machine you are on.

---

## WHAT THIS DOCUMENT IS NOT

- **It is not `GO-LIVE-CUTOVER.md`.** That file is the WeChat mini-app go-live and has nothing to do with the database. It mentions Postgres nowhere.
- **It carries no schedule, no date and no duration.** Not an oversight. Nothing here is being scheduled; this draft exists to find out what Phase 2 still owes.
- **It does not resolve any gap it names.** Listing them is the job.
- **It carries no reasoning.** Every "why" lives in `docs/tacet-consolidation-decisions.md` §24 and is cited by entry name. Where this document and §24 disagree, **§24 is right and this file is wrong.**

---

## THE THREE PHASES, AND WHY THE ORDER MATTERS HERE

There are **three** phases, settled 2026-08-10 (§24 *THREE PHASES, AND WHY THE FIVE-PHASE READING IS WRONG*). A five-phase reading exists in older text and is **retired**. Do not follow it. Under it the switch is phase 4 and backups are phase 5, which puts the safety net after the event it exists to survive.

- **Phase 1 — done.** Postgres installed alongside the running SQLite application. Schema translated, data copied as a rehearsal, nothing pointing at it.
- **Phase 2 — the async conversion of the data layer against SQLite, PLUS every fix and operational prerequisite that must be true before a flip is survivable.** Both halves. **Backups, the rollback plan and this runbook are Phase 2, not Phase 3.**
- **Phase 3 — the switch, and nothing else.** `TACET_DB` selects the driver, a fresh copy replaces the rehearsal copy, delta pass, seed, flip.

**Phase 2 ends when two things are true at once: the code can run on either driver, AND backups, rollback and the runbook exist.** Either alone leaves a flip that can be started and not finished.

**PART B of this document is Phase 2's exit gate. PARTS C through I are Phase 3 — everything that happens on the day.** Nothing in Parts C–I may begin until every item in Part B is green.

---

# PART A — THE GAP INDEX

**This is the list of things Phase 2 still owes, derived by walking the procedure rather than from anyone's memory.** Each names the step where it bites.

| Gap | Step | What is missing | Owned by |
|---|---|---|---|
| **G1** | B1 | The code cannot run on Postgres at all — 102 unconverted transaction blocks runtime-wide, 29 in `routes/retail.js` | status doc items 6, 7, 8 |
| **G2** | B2 | `TACET_DB` does not exist anywhere in the repository. **The central action of this runbook has no mechanism** | status doc item 27 |
| **G3** | B3 | `lib/pg.js` is wired to nothing. Nothing in the application requires it | status doc item 28 |
| **G4** | B4 | The Postgres backend of `withTransaction` is not written and not tested | status doc item 29 |
| **G5** | B5 | The pooled-client scoping for the transaction queue is not written | status doc item 30 |
| **G6** | B6 | `nextOrderNo` Piece 2 — nothing in the application reads the counter row that was created for it | status doc item 12 |
| **G7** | B7 | The idempotency regex matches better-sqlite3's message text. **Failure mode is a customer charged twice, and nothing fails until money moves** | status doc item 20 |
| **G8** | B8 | The `sqlite_sequence` resets have no `setval` replacement, and both sit inside silent `try{}catch{}` | status doc item 23 |
| **G9** | B9 | 96 dialect statements will not run on Postgres, plus 371 dynamic statements no static pass can reach | status doc item 19 |
| **G10** | B10 | Six statements are failing in production today, on paths that have never executed | status doc item 15 |
| **G11** | B11 | **Writer FIXED `225aa13`; the backfill for the seven pre-fix customers is NOT built.** Check F still fails on ¥3,669.64, so the flip's own verification still cannot be read against zero | status doc item 42 |
| **G12** | B12 | `reverseOrderBalance` reads its sequence number outside the transaction it writes in | §24, found 2026-08-19 |
| **G13** | B13 | No audit of the ~80 `scripts/` files that assume a SQLite path. A destructive script's backup step would silently back up nothing | status doc items 21, 22 |
| **G14** | B14 | Fresh-cluster restore is unproven. The rehearsal ran where `tacet_app` already existed, so `CREATE ROLE` never executed. **The new-box case is the disaster case** | status doc item 16 |
| **G15** | B15 | No end-to-end green run of the Postgres backup tier under cron | §24 backup entry |
| **G16** | C1 | **The application has no write-freeze, maintenance mode or read-only mode of any kind.** There is no way to stop trading except stopping the process | nothing written |
| **G17** | C2 | No decision on whether the cutover takes a quiet window or a delta pass. §24 names both and picks neither | §24 *Full data copy*, findings |
| **G18** | E1 | **No delta-pass tool exists.** `run.py` truncates and re-copies everything; `drift.sh` counts five tables; `drift_proof.py` compares two verification passes. None of them applies a delta | status doc item 31 |
| **G19** | E3 | No definition of "the delta pass is complete" — no residual-drift threshold, no stopping rule | nothing written |
| **G20** | G1 | **No application smoke test against Postgres.** No checkout has ever executed on the pg driver, anywhere | nothing written |
| **G21** | G5 | No procedure covers the channel daemons, which are separate pm2 processes with their own database handles | nothing written |
| **G22** | H2 | **No reverse copy from Postgres back to SQLite.** The rollback's central action has no tool | status doc item 17 |
| **G23** | H1 | No rollback trigger criteria, no named decision-maker, no rollback window | status doc item 17 |

**Read the shape of that list, not just its length.** Fifteen of the twenty-three sit in Part B, before the day starts. Two of them — **G2 and G22** — are the two ends of the same missing thing: there is no built way to move onto Postgres, and no built way to move back off it.

---

# PART B — BEFORE THE DAY (PHASE 2 EXIT GATE)

**None of this happens on cutover night.** Every item here must be true, and proven, before Part C begins. This part is a gate, not a procedure: work through it in any order, but do not enter Part C until every line is green.

## B0 — Confirm the record is current before trusting any number in it

**RUN**

```bash
ssh root@47.239.89.63 "cd /root/roots-v2 && git fetch origin -q && node scripts/diagnose_async_conversion_scope.js | grep -E 'runtime total|blocks|CONVERTED'"
```

**GOOD** — the counts printed match the `LAST UPDATED` line at the top of `docs/tacet-postgres-status.md`.

**BAD** — any count differs, or the script errors.

**IF BAD** — **stop and do not proceed with any other step in this document.** A moved count means the status doc is stale, and every "is this done yet" answer below it is unreliable. Re-run PART 4 of `docs/tacet-postgres-status.md` and update that file first. Never take a count from `grep`; this script is the authority (§24, after six grep-derived figures proved wrong).

---

## B1 🔴 GAP G1 — The code cannot run on Postgres

**WHAT THIS STEP WOULD DO** — confirm that every transaction in the running application works on both drivers, so that changing one setting changes which database is used and nothing else.

**WHY THERE IS NO COMMAND** — **102 transaction blocks runtime-wide are unconverted, 29 of them in `routes/retail.js`.** The checkout — 209 lines, 9 ordered writes, 6 typed errors and a 7th idempotency exit — is one of them. The money cluster is 19 members and none is converted. 73 unconverted transactions sit outside `routes/retail.js` entirely, including `commitOrderReservations` and `reverseCommittedOrder`.

**WHAT MUST EXIST FIRST** — status doc items 6 (the checkout), 7 (the money cluster), 8 (the 73), and their blockers: items 1, 2, 3, 4, 5, 10, 11, 13.

**IF YOU REACH HERE ON THE NIGHT** — stop. There is nothing to flip to.

---

## B2 🔴 GAP G2 — `TACET_DB` does not exist

**WHAT THIS STEP WOULD DO** — this is the action the entire runbook is built around: set one value, restart, and the application is on Postgres.

**WHY THERE IS NO COMMAND** — `TACET_DB` appears **nowhere in the repository**. Its form and location are specified in §24 *CUTOVER SEQUENCING* — read once at module load and exported as a constant, the shape `lib/tenant-db.js:87` already uses — and nothing has been built. There is no setting to set.

**WHAT MUST EXIST FIRST** — status doc item 27.

**IF YOU REACH HERE ON THE NIGHT** — stop. **This is the single gap that makes the whole document inert.** Every step after it assumes a switch that has not been made.

---

## B3 🔴 GAP G3 — `lib/pg.js` is wired to nothing

**WHAT THIS STEP WOULD DO** — give the application a live Postgres connection with the read-side money converter already armed.

**WHY THERE IS NO COMMAND** — the file exists and is deliberately inert. Its own header says so: *"THIS MODULE IS NOT WIRED INTO THE APPLICATION. Nothing requires it yet."* Requiring the module is what arms the numeric parser, so until something requires it, money read back from Postgres arrives as text.

**WHAT MUST EXIST FIRST** — status doc item 28.

**IF YOU REACH HERE ON THE NIGHT** — stop.

---

## B4 🔴 GAP G4 — The Postgres backend of `withTransaction` is not written

**WHAT THIS STEP WOULD DO** — make a transaction on Postgres behave the way the converted call sites already assume it does.

**WHY THERE IS NO COMMAND** — the pg backend, in which a pool checkout makes `tx` a distinct client, is **not written and not tested**. Every one of the 27 already-converted blocks is running against the SQLite backend only.

**WHAT MUST EXIST FIRST** — status doc item 29.

**IF YOU REACH HERE ON THE NIGHT** — stop.

---

## B5 🔴 GAP G5 — The transaction queue is keyed on the pool, not the client

**WHAT THIS STEP WOULD DO** — stop concurrent transactions from serialising against each other, and make sure a pooled client is released on every exit path.

**WHY THERE IS NO COMMAND** — not written. **Measured: three transactions on a shared handle ran strictly sequentially.** This is one of the three items §24 flags as having a silent, money-costing failure mode — it does not raise an error, it gets slow and wrong under load.

**WHAT MUST EXIST FIRST** — status doc item 30.

**IF YOU REACH HERE ON THE NIGHT** — stop.

---

## B6 🔴 GAP G6 — Nothing reads the order counter row

**WHAT THIS STEP WOULD DO** — mint order numbers from `retail_order_counters` on Postgres instead of the read-MAX-then-insert the SQLite path uses.

**WHY THERE IS NO COMMAND** — the table exists on the cluster and the seeding script exists (**Piece 1, built 2026-08-11**). **Piece 2 — the application code that actually reads it — is designed and not built.** `nextOrderNo` still reads `tdb()` twice from ambient scope, so no test can hand it a Postgres handle, so the pg path cannot be proven before the flip.

**One line of that design is load-bearing and must not be lost:** the probe loop must not survive onto the pg path. Carried across, it walks silently past a mis-seeded counter's collisions forever, at hundreds of wasted round trips per order, behind a function that appears to work. Without it, the first checkout fails loudly on `retail_orders_order_no_key`, which is the intended behaviour.

**WHAT MUST EXIST FIRST** — status doc item 12. Blocked behind the checkout conversion.

**IF YOU REACH HERE ON THE NIGHT** — stop. Step F2 would seed a counter that nothing reads.

---

## B7 🔴 GAP G7 — The idempotency regex matches better-sqlite3's message text

**WHAT THIS STEP WOULD DO** — keep the duplicate-payment guard working after the driver changes.

**WHY THERE IS NO COMMAND** — the guard in `routes/retail.js` recognises a duplicate by matching the **text of better-sqlite3's error message.** Postgres raises a different message, the match fails, and the guard stops guarding. **The failure mode is a customer charged twice, and nothing fails until money moves.** The design doc marks this REQUIRED PRE-CUTOVER.

**WHAT MUST EXIST FIRST** — status doc item 20.

**IF YOU REACH HERE ON THE NIGHT** — stop. This one does not announce itself and the first evidence is a customer complaint.

---

## B8 🔴 GAP G8 — `sqlite_sequence` resets have no replacement

**WHAT THIS STEP WOULD DO** — make the two counter-reset paths work on Postgres.

**WHY THERE IS NO COMMAND** — `routes/ingredients.js:299` and `routes/admin.js:245` (**re-derived at this head; v0.1 said `:238`**) reset AUTOINCREMENT counters by deleting from `sqlite_sequence`, a table Postgres does not have. **Both are inside `try {} catch {}`, so after the switch they fail silently**, the counters do not reset, the next insert continues from the old high-water mark — the opposite of the intent — and nothing warns. §24 is explicit that this must be converted **at the same time the application moves**, not afterwards.

**WHAT MUST EXIST FIRST** — status doc item 23.

**IF YOU REACH HERE ON THE NIGHT** — stop.

---

## B9 🔴 GAP G9 — 96 dialect statements, plus 371 nobody can see

**WHAT THIS STEP WOULD DO** — confirm every SQL statement in the application is valid Postgres.

**WHY THERE IS NO COMMAND** — the statement sweep covered 2,524 statements across 109 files and found **96 that will not run on Postgres.** §24 records this as dialect work that *"was not previously on the cutover checklist in any form."* Alongside them sit **371 dynamic statements that static preparation cannot reach at all** — the sweep's own figure is described as "a floor, not a total".

**WHAT MUST EXIST FIRST** — status doc item 19.

**IF YOU REACH HERE ON THE NIGHT** — stop. The 96 are known and fixable by reading. The 371 are the reason no amount of static checking closes this gap on its own, and the reason G20 (a real smoke test) matters more than it looks.

---

## B10 🔴 GAP G10 — Six statements are failing in production today

**WHAT THIS STEP WOULD DO** — clear the known-broken paths before adding a driver change on top of them.

**WHY THERE IS NO COMMAND** — six statements fail today, including the operator's order search and a customer's order history, **both broken behind a `catch`**. §24 is explicit that these are **not typo fixes**: each path has never successfully executed, so fixing one surfaces behaviour nobody has ever seen. That is work, not a patch, and it is not work to do on cutover night.

**WHAT MUST EXIST FIRST** — status doc item 15.

**IF YOU REACH HERE ON THE NIGHT** — stop.

---

## B11 🔴 GAP G11 — the seven customers check F cannot explain

**RE-DERIVED 2026-08-19 AGAINST THE CODE AND THE RECORD, NOT CARRIED FORWARD.** v0.1 of this section described both halves of the fix as unbuilt. One of them had been on `main` for six days. What follows is what is true at this head.

**WHAT THIS STEP WOULD DO** — make the post-flip money check readable against zero, so Part G does not need a baseline at all.

**WHY THERE IS NO COMMAND — one half of two.**

**The writer is FIXED.** `claimMigrationCredit` now writes its `retail_topup_transactions` row inside the same transaction as the balance credit — `225aa13`, 2026-08-13, on `main`, with `scripts/test_migration_credit_ledger.js` behind it and a mutant that restores the original defect to prove the suite can go red. **Two claims v0.1 made on the strength of the old reading are struck:** *"writes no ledger row"* is false in the present tense, and *"53 unclaimed credits carrying ¥17,362.32 will each repeat it"* is false — a claim made today writes its row and adds nobody to F's list.

**The backfill is NOT built.** Nothing in `scripts/` writes the missing rows for the customers who claimed before 2026-08-13, no §24 entry records one running, and status doc item 42 still carries it. **So the measured failure stands exactly as measured: 7 customers, ¥3,669.64 of balance that no ledger row explains, claims dated 2026-06-13 to 2026-07-28.**

**WHAT THE FIX CHANGED FOR PART G, WHICH IS THE PART WORTH READING.** It did not remove the baseline. **It made the baseline sound.** Before `225aa13` the set of customers failing F could grow between the moment you captured the baseline in D3 and the moment you compared it in G6 — any of the 53 claiming in that window would have added themselves, and a baseline that grows underneath you is not a baseline. **The set is now closed.** No new customer can enter it, and each of the seven has a fixed per-customer drift: check F compares `balance` against `SUM(amount)` over successful rows, and every audited movement since moves both sides by the same amount, so the *difference* is frozen even while the two figures themselves keep moving with trading. **The seven are history now, and history is what a baseline is supposed to be made of.** See G6 for what this means you actually compare.

**WHAT MUST EXIST FIRST** — status doc item 42's remaining half, and item 43 (`retail_migration_credits` is not append-only, which constrained the key scheme — the shipped fix answers it by putting the claimant in `out_trade_no`, not the credit row id alone).

**IF YOU REACH HERE ON THE NIGHT** — stop, **and understand what you are stopping for, because it is smaller than it was.** The live defect is closed; what remains is seven rows of history that were never written. **Until they are, Part G cannot read check F against zero and must read it against D3.** If the backfill is ever waived rather than run, that is a permanent condition and Part G's baseline is permanent with it.

---

## B12 🔴 GAP G12 — `reverseOrderBalance` reads its sequence outside its transaction

**WHAT THIS STEP WOULD DO** — stop a double refund of store credit under an async driver.

**WHY THERE IS NO COMMAND** — `reverseOrderBalance`, `routes/retail.js:28519–28544` **at this head, re-derived 2026-08-19; v0.1 cited `:28459–28484`, which is now `orderTenders` and `reverseOrderRedeem`.** The `COUNT(*)` that decides the idempotency key happens at `:28525–28527`; the transaction opens at `:28534`, after it, and the key is built from that stale count at `:28540`. **Cite this one by symbol.** The design doc it came from carries the older numbers too, and §24 has already recorded this class twice — a line-number pin drifts under the finding it names while the finding stays true. Under better-sqlite3 nothing can interleave and the sequence is sound. **Under an async driver that gap is a yield point:** two concurrent partial refunds both read the same count, both build the same key, and both insert. The remaining-amount cap is computed from the same stale read, so it does not save it either. `retail_topup_transactions` carries **no constraint of any kind**, so the second row is simply accepted and nothing raises.

**WHAT MUST EXIST FIRST** — the fix itself, plus (separately) the partial `UNIQUE (out_trade_no)` constraint. §24 is explicit that **the defect exists whether or not that constraint is added** — a race fixed only by a constraint nobody has built is not fixed.

**IF YOU REACH HERE ON THE NIGHT** — stop.

---

## B13 🔴 GAP G13 — The `scripts/` audit has not been done

**WHAT THIS STEP WOULD DO** — make sure no script on the box quietly does the wrong thing once the application has moved.

**WHY THERE IS NO COMMAND** — about 80 one-off scripts open the live SQLite database **by path** and would run unedited. They are deliberately outside the database seam, and that exclusion is only safe if the file they reach for is gone (step F1 handles that). The audit that identifies which of them are destructive has not been run.

**The worked example is `reset_test_orders.js`,** which is on the box and runnable. Its safety step is `fs.copyFileSync` of the SQLite file. After the flip that **does not fail loudly** — it may copy a stale or abandoned `.db`, print a restore command that restores nothing, and let the deletes proceed while the operator believes a backup exists. Its guards 2 and 3 have never been executed and must be exercised **on the box against a fixture, never against live data.**

**Two opposite defaults sit in that directory:** four scripts require `--apply` and fail closed; seven require `--dry-run` and **fail open — writing is the default and the operator must opt out.** An operator who has learned these scripts are safe by default learned it from the wrong half.

**WHAT MUST EXIST FIRST** — status doc items 21 and 22.

**IF YOU REACH HERE ON THE NIGHT** — stop.

---

## B14 🔴 GAP G14 — A restore onto a fresh box has never been done

**WHAT THIS STEP WOULD DO** — prove that the backup you are relying on tonight can actually rebuild the database somewhere else.

**WHY THERE IS NO COMMAND** — a restore **was** rehearsed end to end, and it restored from objects downloaded back out of OSS rather than from the local originals, which is the only version of that test worth running. But it ran **in the same cluster, where `tacet_app` already existed.** `roles.sql` applied its `ALTER ROLE` lines and its `CREATE ROLE` lines did nothing — **the one part of the file that exists for the disaster case is the one part the rehearsal did not execute.**

Why that matters, in one line: the `-Fc` archive holds **304 ACL entries naming a role a bare `pg_dump` does not carry**, and `pg_dumpall --roles-only` is **795 bytes**. Those 795 bytes are the difference between a backup and 310MB that errors 304 times and produces a database the application cannot log into.

**WHAT MUST EXIST FIRST** — status doc item 16. Until it has been run against a cluster where `tacet_app` does not exist, describe the backup as **proven for recovery-in-place and unproven for recovery-elsewhere**, and say it in those words.

**IF YOU REACH HERE ON THE NIGHT** — stop.

---

## B15 🔴 GAP G15 — The Postgres backup has never completed a green run under cron

**WHAT THIS STEP WOULD DO** — confirm the nightly backup you are trusting actually fires unattended.

**WHY THERE IS NO COMMAND** — the schedule and invocation are proven for the **SQLite tier only**; the Postgres code landed after that day's run. Three things that differ between a manual run and a cron run were checked in advance and all pass: every binary resolves under a bare `PATH`, there is no `requiretty` in sudoers, and peer auth over the socket succeeds under a stripped environment with no tty and no login shell. **The end-to-end green run under cron is still owed.**

**WHAT MUST EXIST FIRST** — one observed cron-driven run of `scripts/db-backup.sh` that uploads and verifies the `tacet` tier.

**IF YOU REACH HERE ON THE NIGHT** — this one does not stop the flip on its own, because step D1 takes a manual backup you watch with your own eyes. **But do not describe the nightly backup as working until you have seen it work unattended.**

---

## B16 — Everything else that must be true (real steps, run them ahead of time)

**RUN**

```bash
ssh root@47.239.89.63 "df -h /root && echo '--- deploy dirs ---' && ls -1d /root/backups/deploy-* 2>/dev/null | wc -l && du -sh /root/backups"
```

**GOOD** — free space on `/root` is comfortably larger than the size of one `tacet` dump plus one full copy's peak working set.

**BAD** — free space is tight. §24 measured this filesystem at 40 GB with 8.3 GB free, and **~1.57 GB of `/root/backups` is under no retention policy at all** — 862 `deploy-*` directories with no pruner anywhere, plus four one-off June snapshots that have each outlived the change they were insurance for.

**IF BAD** — free space **before** the night, as a separate piece of work with its own review. Do not prune anything as a side effect of the cutover. `hourly/` and `daily/` are exactly at their configured retention and there is nothing to reclaim there without changing policy.

---

**RUN**

```bash
ssh root@47.239.89.63 "cd /root/roots-v2 && node scripts/diagnose_deployed_tree.js | tail -40"
```

**GOOD** — you have a written list of files present on the box that are not in `main`.

**BAD** — the script errors, or the EXTRA list is long and unexplained.

**IF BAD** — do not delete anything yet; this reading is an input to step F3, not an action. **The deploy pipeline never removes a file** — proven live, `public/retail-admin.js` was still on the server 54 days after being deleted from `main`. Anything dropped from the repository keeps running in production until someone removes it by hand.

---

# PART C — THE FREEZE QUESTION

**This part has no steps, because the decision it depends on has not been made.** It sits before the copy because the copy's correctness depends on the answer.

## C1 🔴 GAP G16 — Nothing in the application can stop trading

**WHAT THIS STEP WOULD DO** — hold writes still while the data is copied, so the copy is a photograph rather than a smear.

**WHY THERE IS NO COMMAND** — **there is no maintenance mode, no read-only mode and no write freeze anywhere in the application.** The only mechanisms that exist are blunt: stop the pm2 processes, or leave the shop trading and accept drift. There is no third option built. (The "Maintenance" tab in the admin is a repair-tools screen, not a write freeze. Do not mistake it for one.)

**What "stop the processes" actually costs, so nobody discovers it on the night:** stopping `roots-v2` takes down the customer mini-app, the web storefront and the admin at once. Stopping the channel daemons stops order ingest from Meituan, 闪购, Eleme, Qingyun and gzgrocery — those orders do not queue politely; the channels keep taking them and the box stops hearing about them. Bouncing `shangou-chrome` or `qingyun-chrome` throws away a warm logged-in session, and **the channel answers the cold browser with a risk-control challenge**, which pauses stock sync until a cool-down expires or a human passes a captcha.

**WHAT MUST EXIST FIRST** — either a real freeze mechanism, or an explicit written decision to trade through the copy and rely on a delta pass (which does not exist either — G18).

**IF YOU REACH HERE ON THE NIGHT** — stop. **"Nothing stops trading" is not yet a safe answer, and this document must not be read as claiming it is.** It becomes safe only when a delta pass exists, is proven, and has a stated completion test. Today neither the freeze nor the delta pass exists, so **both answers to "what stops trading" are unbuilt.**

---

## C2 🔴 GAP G17 — Quiet window or delta pass: nobody has chosen

**WHAT THIS STEP WOULD DO** — commit to one of the two approaches, so the rest of the procedure has one shape instead of two.

**WHY THERE IS NO COMMAND** — §24 records the constraint plainly and offers both: *"Drift, not speed, is the cutover constraint… A clean cutover needs a quiet window or a delta pass over the tables that take writes — the sync logs, `retail_checkout_quotes`, `activity_log`, and the auth tables."* **It names both and picks neither, and no entry since has picked.**

The two produce different runbooks. A quiet window needs G16 and makes the delta pass small or unnecessary. A delta pass needs G18 and makes the freeze unnecessary. **Building neither leaves the copy provably wrong on arrival.**

**WHAT MUST EXIST FIRST** — a decision, recorded in §24, followed by the mechanism that decision implies.

**IF YOU REACH HERE ON THE NIGHT** — stop.

---

# PART D — IMMEDIATELY BEFORE THE COPY

These are real steps. They can be written today because the tools exist.

## D1 — Take a backup you watch, of both databases

**RUN**

```bash
ssh root@47.239.89.63 "bash /root/roots-v2/scripts/db-backup.sh; echo EXIT=\$?"
```

**GOOD** — `EXIT=0`, and the output shows a SQLite integrity check returning `ok` before any gzip runs, a `tacet.dump` and a `roles.sql` in the same uploaded prefix, and each upload verified by size after it lands.

**BAD** — any non-zero exit, any missing `roles.sql`, or an upload the script could not verify.

**IF BAD** — **do not continue.** Everything after this point assumes a restorable backup exists. Read the error, fix it, and run the script again until it exits 0. Do not proceed on a partial upload: `roles.sql` is ~1 KB and without it the dump restores into 304 errors and a database the application cannot log into.

---

## D2 — Record the exact state you are starting from

**RUN**

```bash
ssh root@47.239.89.63 "cd /root/roots-v2 && git rev-parse HEAD && pm2 jlist | node -e 'const d=JSON.parse(require(\"fs\").readFileSync(0));for(const p of d)console.log(p.name, p.pm2_env.status, p.pm2_env.restart_time)'"
```

**GOOD** — you have written down, on paper or in a note you can reach without the box: the deployed commit SHA, every pm2 process name, its status, and its restart count.

**BAD** — any process is not `online`, or a restart count is climbing between two runs of this command.

**IF BAD** — **do not start a cutover on an unhealthy box.** A process already crash-looping will be blamed on the flip. Get it stable first, then start again from D1.

---

## D3 — Capture the money baseline BEFORE anything moves

**RUN**

```bash
ssh root@47.239.89.63 "cd /root/roots-v2 && gunzip -c \$(ls -1t /root/backups/hourly/roots-*.db.gz | head -1) > /tmp/pre-cutover.db && node scripts/check_ledger_invariants.js --db /tmp/pre-cutover.db > /tmp/pre-cutover-ledger.txt 2>&1; echo LEDGER_EXIT=\$?; node scripts/check_points_invariants.js --db /tmp/pre-cutover.db > /tmp/pre-cutover-points.txt 2>&1; echo POINTS_EXIT=\$?"
```

**GOOD** — both files are written. **Whatever they say is now your baseline.** Read them and keep them. Note in particular what check F reports: **today it is expected to fail on seven customers holding ¥3,669.64 (see G11), and that set cannot grow while you work** — the writer that created it was fixed on 2026-08-13, so no eighth customer can appear between this step and G6. **Write down the seven customer ids and the `drift` column beside each one.** That column, not the amounts next to it, is what G6 compares.

**BAD** — either script exits 2, meaning the checks could not run at all.

**IF BAD** — stop. Exit 2 means "no driver, no database, or bad arguments", not a data problem. Fix the invocation. **Do not proceed without a baseline**, because Part G compares against it, and a missing baseline means you cannot tell a flip failure from something that was already broken.

**Why a copy and not the live file:** read-only is not the same as zero-impact. A long scan against the live database competes with the application for page cache and locks. The hourly snapshot is taken through SQLite's online backup API and is the right thing to point at. **There is no reason to touch `data/roots.db`.**

---

# PART E — THE FRESH COPY AND THE DELTA PASS

**The 2026-08-04 copy is a rehearsal and it drifts from the moment it was taken.** It is not the copy you go live on. Measured drift over one week: `checkout_quotes` **+23,829**, `guanyi_sync_log` **+4,788**, `customers` **+222**, `orders` **+87**. On `retail_orders` alone the drift is **+121 rows**.

## E1 🔴 GAP G18 — There is no delta-pass tool

**WHAT THIS STEP WOULD DO** — bring the Postgres copy up to date with everything SQLite has accepted since the copy started, without re-copying everything.

**WHY THERE IS NO COMMAND** — nothing in the repository does this. What exists, and what it actually does:

- **`scripts/postgres-full-copy/run.py`** — the full copy. **It `TRUNCATE`s the target first** (`TRUNCATE … RESTART IDENTITY CASCADE`) and reloads every non-empty table. It is a replace, not a merge. It cannot be used as a delta pass, and running it a second time destroys the first.
- **`scripts/postgres-full-copy/drift.sh`** — a `psql` spot-check of row counts and id ranges across **five tables** (`accounts`, `users`, `suppliers`, `purchase_orders`, `invoices`). It was a progress check during the original run. It measures nothing about the tables §24 names as the ones that actually take writes.
- **`scripts/postgres-full-copy/drift_proof.py`** — proves that residual differences are live trading rather than copy errors, by comparing verification pass 1 against pass 2. **It explains drift; it does not close it.**
- **`scripts/postgres-full-copy/verify.py`** and **`checks.py`** — the round-trip cell comparison, and the foreign key / Chinese character / base64 checks. These tell you a copy is faithful. They do not move a row.

**Two constraints any delta tool must honour, recorded here so they are not rediscovered:**

1. **Text-key comparisons require `COLLATE "C"`.** SQLite orders text by byte and Postgres by locale, which ignores punctuation. During the original verification this produced **117 false differences by pairing the wrong rows on each side, and it looked exactly like data corruption.**
2. **Sequences must be re-advanced after any delta.** `setseq.py` sets them from SQLite's `AUTOINCREMENT` high-water mark where one exists, not from `max(id)` — because on 20 tables ids are burned. Setting from `max(id)` would leave some sequences **behind live reality**; `guanyi_sync_log` copied to max id 55,186 while SQLite's high-water was already 55,189.

**WHAT MUST EXIST FIRST** — status doc item 31, and the C2 decision that says a delta pass is the chosen approach at all.

**IF YOU REACH HERE ON THE NIGHT** — stop. **Without this, the only correct copy is one taken while nothing is writing, which needs G16.**

---

## E2 — The full copy itself (the tool exists; the surrounding decision does not)

**RUN** — only after C1/C2 are resolved and the source is either frozen or covered by a delta pass:

```bash
ssh root@47.239.89.63 "cd /root/roots-v2/scripts/postgres-full-copy && python3 run.py 2>&1 | tail -40"
```

**GOOD** — every table loads in dependency order, row counts match table by table, and the run reports its timings without aborting.

**BAD** — the run aborts on a row-count mismatch (it aborts on the first one, by design), or preflight-class errors appear for values that do not fit the target types.

**IF BAD** — **do not re-run it blindly.** `run.py` truncates the target at the start, so a second run destroys whatever the first produced. Read which table failed, and treat a row-count mismatch as evidence the source moved during the run — which is the C1/C2 question arriving as a symptom instead of a decision.

**A note on speed, not a schedule:** §24 records the 2026-08-04 copy as 353,220 rows in 86 seconds. That is a past measurement of one step, quoted only to make the point §24 makes with it — **drift, not speed, is the constraint.** The source gained 48 rows during that window.

---

## E3 🔴 GAP G19 — There is no test for "the delta pass is complete"

**WHAT THIS STEP WOULD DO** — tell you, before you move traffic, that Postgres now holds everything SQLite holds.

**WHY THERE IS NO COMMAND** — **no completion test has been defined.** There is no residual-drift threshold, no stopping rule, and no statement of which tables must be at zero difference versus which may legitimately still be moving. Without one, "the delta pass finished" means "the script stopped", which is not the same claim.

The pieces that would go into such a test all exist: `verify.py` round-trip compares cells, `checks.py` validates all 144 foreign keys through Postgres itself and hashes the wide base64 columns, `drift_proof.py` distinguishes drift from copy error. **What is missing is the rule that reads their output and says go or no-go.**

**WHAT MUST EXIST FIRST** — a written completion test, owned by §24, that names the tables it covers and the threshold it applies.

**IF YOU REACH HERE ON THE NIGHT** — stop. **A delta pass with no completion test is the same as no delta pass, because you cannot tell when to stop running it.**

---

## E4 — Re-advance the sequences (real step, tool exists)

**RUN**

```bash
ssh root@47.239.89.63 "cd /root/roots-v2/scripts/postgres-full-copy && python3 setseq.py 2>&1 | tail -20"
```

**GOOD** — every identity sequence reports as set, and the report shows sequences taken from the `AUTOINCREMENT` high-water mark where the table has one.

**BAD** — any sequence reports as unchanged, or lower than the table's current maximum id.

**IF BAD** — stop, and do not seed the counter or flip. A sequence sitting behind live data means the first insert into that table collides on its primary key.

**Run this after every copy and after every delta pass, not once.**

**This script does not touch `retail_order_counters` and never will** — it walks `plan.json` for identity columns, and a counter row is not a sequence. That table exists only in Postgres and is absent from `plan.json` entirely. It has its own step, which is F2.

---

# PART F — IMMEDIATELY BEFORE TRAFFIC MOVES

**Order in this part is not negotiable.** Each step depends on the one before it.

## F1 — Rename `data/roots.db` — do not delete it

**RUN**

```bash
ssh root@47.239.89.63 "cd /root/roots-v2/data && ls -la roots.db* && mv roots.db roots.db.pre-cutover && ls -la roots.db*"
```

**GOOD** — `roots.db.pre-cutover` exists, `roots.db` does not, and the WAL and SHM files beside it are accounted for.

**BAD** — the rename fails because a process still holds the file, or `roots.db` reappears.

**IF BAD** — a process is still writing to SQLite. Find it before going further. If the application itself is still on SQLite at this point, that is expected, and this step belongs after the flip instead — **decide which, and write it down, because the order changes what the ~80 loose scripts see.**

**Rename, never delete.** Two reasons, both load-bearing. It keeps the rollback path open — Part H has nothing else. And it breaks the ~80 scripts that open the database by path **loudly**, with "unable to open database file", instead of letting them keep reading a stale database that returns figures which look right and are months old, while their writes land somewhere nothing reads.

---

## F2 — Seed the order counter — LAST, and only here

**This step goes after the fresh copy AND after the delta pass, immediately before traffic moves.** That ordering is the entire value of the step, and it is why the DDL file was corrected to remove its own seed statement — as first written it ran the seed as its third statement, contradicting the rule stated twenty lines above it in the same file.

**RUN**

```bash
ssh root@47.239.89.63 "cd /root/roots-v2/scripts/postgres-full-copy && python3 seed_order_counter.py 2>&1 | tail -20; echo EXIT=\$?"
```

**GOOD** — `EXIT=0`, and the receipt shows the counter **raised** to the highest `TC` order number that exists at this moment. Re-running is safe and expected: the seed is `GREATEST`-guarded and can only raise the value, never lower it.

**BAD — three distinct shapes. Read which one you got:**

1. **The missing-table guard fires.** `retail_order_counters` does not exist on the cluster. The script refuses to create it, by design.
2. **The counter-ahead warning, non-zero exit.** The counter already sits above the data. The script warns and exits non-zero **without lowering the value**, which is correct.
3. **The value seeded is lower than the true maximum.** This is the dangerous one and it does not announce itself here.

**IF BAD**

1. Apply `docs/tacet-postgres-order-counter.sql` by hand, then regenerate the as-built schema record with a fresh `pg_dump -s --no-owner -d tacet` in the same pass. Then re-run this step.
2. Investigate before proceeding — something already advanced the counter. Do not force it downwards.
3. **Stop.** Re-run the delta pass and re-seed. A counter seeded from a stale copy collides on the first checkout and keeps colliding. **Measured 2026-08-11: Postgres held 168 `TC` orders while SQLite held 247** — a counter seeded from the rehearsal copy would sit **79 short, and the first 79 checkouts after the flip would collide one after another** on `retail_orders_order_no_key`.

**Why a collision is the good outcome and not the bad one:** the counter row exists at 0 deliberately. If the row were absent, the mint's `UPDATE` would match nothing, `RETURNING` would yield nothing, and the caller would receive an absent value where an order number belongs — which is how `TCundefined` reaches a customer-facing column. With the row present at 0, a mis-seeded counter fails **visibly** on the unique constraint at `TC000001`. Both are failures; only one of them is visible.

---

## F3 — Remove retired files by hand

**RUN** — using the reading you took in B16:

```bash
ssh root@47.239.89.63 "cd /root/roots-v2 && node scripts/diagnose_deployed_tree.js | tail -40"
```

Then remove the EXTRA entries **deliberately, one at a time, by name.**

**GOOD** — the EXTRA list matches the list you reviewed in B16, and each removal is one you decided on in advance.

**BAD** — the EXTRA list has grown since B16, or contains something you do not recognise.

**IF BAD** — do not remove anything you did not review ahead of time. An unrecognised file on the box at cutover is not a housekeeping question; find out what put it there. **The deploy never removes a file, so a file that is supposed to be gone is still importable** — which is exactly the kind of thing that gets loaded by something nobody remembered.

---

# PART G — THE FLIP, AND HOW YOU KNOW IT WORKED

## G1 🔴 GAP G20 — There is no smoke test against Postgres

**WHAT THIS STEP WOULD DO** — prove, before customers arrive, that the application actually works on the new driver: place an order, take a payment, award points, move stock.

**WHY THERE IS NO COMMAND** — **no checkout has ever executed against Postgres, anywhere.** Not in production, not in a test, not on a laptop. The checkout is unconverted (G1), `lib/pg.js` is wired to nothing (G3), the pg transaction backend is unwritten (G4), and `nextOrderNo` cannot be handed a pg handle (G6). There is nothing to smoke-test yet.

**This is the gap that matters most against G9.** 96 dialect statements are known and can be fixed by reading. **371 dynamic statements cannot be reached by any static pass** — the only thing that finds those is executing the code. A smoke test is not a nicety here; it is the only instrument that can see that class of failure before a customer does.

**WHAT MUST EXIST FIRST** — a scripted end-to-end exercise against a Postgres-backed instance, covering at minimum: a checkout, a payment callback, a points award, a refund, a stock commit and a stock reversal.

**IF YOU REACH HERE ON THE NIGHT** — stop.

---

## G2 🔴 (depends on GAP G2) — Set `TACET_DB` and restart

**WHAT THIS STEP WOULD DO** — the flip.

**WHY THERE IS NO COMMAND** — see B2. The setting does not exist. When it does, this step is an edit to the untracked `.env` on the box followed by a restart, and **two things about that must be written into the step at the time:**

- **`.env` is untracked and is not part of the deploy.** No git operation puts `TACET_DB` on the box and no git operation takes it off. Changing it is a manual edit, and it is the only record that the flip happened.
- **`pm2 restart … --update-env` is what re-reads `.env`, and it has bitten before** — it wiped `PORT` on a previous occasion and the process came up on the wrong port. Whatever this step ends up being, it must **assert** the process came back on `:4000` rather than assume it.

**IF YOU REACH HERE ON THE NIGHT** — stop.

---

## G3 — Confirm the process is serving (real step, mechanism exists)

**RUN**

```bash
ssh root@47.239.89.63 "for p in / /api/retail/categories /api/retail/config /api/retail/products; do printf '%s=' \$p; curl -s -o /dev/null -m 3 -w '%{http_code}\n' http://127.0.0.1:4000\$p; done"
```

**GOOD** — `/` returns `302`, and the other three return `200`. Any 2xx/3xx/4xx counts as answering.

**BAD** — any path returns `000` (connection refused or timeout — the process is not answering), or any `5xx` (the handler threw).

**IF BAD** — this is the deploy pipeline's own readiness probe, and its verdict is the same one the pipeline uses: **`000` or `5xx` on any of these four is a failure, not a warning.** Go to Part H. Do not wait to see whether it settles.

**Why these four:** `/` answers "is the process alive". `/api/retail/categories` is a trivial database read. `/api/retail/config` loads config plus database and 500s from its own catch if broken. `/api/retail/products` is the storefront grid query — the critical read path. All four are public, GET-only and side-effect free.

---

## G4 — Confirm the process is stable, not just up

**RUN** — three times, a few seconds apart:

```bash
ssh root@47.239.89.63 "pm2 jlist | node -e 'const d=JSON.parse(require(\"fs\").readFileSync(0));const p=d.find(x=>x.name===\"roots-v2\");console.log(p.pm2_env.status, p.pm2_env.restart_time)'"
```

**GOOD** — status is `online`, and the restart count is **the same all three times.**

**BAD** — status is anything other than `online`, or the restart count climbs between readings.

**IF BAD** — a climbing restart count is a crash loop. A real crash loop never settles; a one-off transient settles within a round or two. **If it is still climbing on the third reading, go to Part H.**

---

## G5 🔴 GAP G21 — The channel daemons are not covered by any procedure

**WHAT THIS STEP WOULD DO** — move the channel daemons onto the new driver alongside the main application, and confirm each one came back.

**WHY THERE IS NO COMMAND** — **the daemons are separate pm2 processes.** `scripts/qingyun-daemon.js`, `guanyi-daemon.js`, `meituan-daemon.js`, `eleme-daemon.js`, `shangou-daemon.js` and `gzgrocery-order-daemon.js` each run in their own process, and each one `require`s the same `lib/` and `database.js`. **`pm2 restart roots-v2` does not reload them.** A flip that restarts only the main application leaves every daemon still holding a SQLite handle, writing to a database the application has stopped reading — and the deploy tooling's own comment records that this staleness is invisible: the operation reports success while the daemon keeps executing the previous state.

**The browser holders are a separate problem again.** `shangou-chrome` and `qingyun-chrome` are not daemons; each owns a real logged-in Chrome that a daemon attaches to over CDP. Restarting one throws away a warm trusted session and the channel answers with a risk-control challenge, pausing stock sync until a cool-down expires or a human passes a captcha. **They load no business code, so whether they need to bounce at the cutover at all is an open question nobody has answered.**

**WHAT MUST EXIST FIRST** — a written per-process cutover order covering all six daemons and both holders, with a stated answer on the holders, and a per-process confirmation check.

**IF YOU REACH HERE ON THE NIGHT** — stop. **These daemons are also the reason the point of no return arrives sooner than you would expect — see Part I.**

---

## G6 — Run the money checks against Postgres and compare to the baseline

**RUN**

```bash
ssh root@47.239.89.63 "cd /root/roots-v2 && node scripts/check_ledger_invariants.js --pg > /tmp/post-cutover-ledger.txt 2>&1; echo LEDGER_EXIT=\$?; node scripts/check_points_invariants.js --pg > /tmp/post-cutover-points.txt 2>&1; echo POINTS_EXIT=\$?; diff /tmp/pre-cutover-ledger.txt /tmp/post-cutover-ledger.txt; diff /tmp/pre-cutover-points.txt /tmp/post-cutover-points.txt"
```

**RE-DERIVED 2026-08-19. THE QUESTION WAS ASKED DIRECTLY AND THE ANSWER IS NO: this step cannot expect ALL 10 INVARIANTS PASSED, and the baseline is not machinery to be simplified away.** Check F still fails, for the reason and only the reason set out in G11 — the writer was fixed, the seven historical rows were never backfilled. **The day the backfill runs, delete this whole apparatus and expect zero.** Until then, read the output as follows. Each of the fourteen checks gets one line, because "diff it and see" is not an instruction anyone can follow at 3am.

**THE NINE THAT EXPECT ZERO — E, G, H, I, J, K, L, N, O.** Zero before, zero after, no interpretation. **Any non-zero here is a defect and Part H is the answer**, whatever the diff says.

**CHECK F — EXPECTS THE SEVEN, AND EXPECTS THEM BY `drift`.**

**Do not compare F's text.** F reports `balance`, `ledger_sum`, `ledger_rows`, `first_row` and `last_row` per customer, and every one of those moves if that customer trades between D3 and this step — F is even `ORDER BY last_row`, so the lines can change places. A textual `diff` will show noise that means nothing, and a step whose pass condition is buried in noise is a step that gets waved through.

**Compare two things, both frozen:**

1. **The count is 7.** Not 8. A new customer in F's list is a defect — nothing can add one any more (G11), so anything that did came from the flip.
2. **Each of the seven `drift` values is unchanged from what you wrote down in D3.** `drift` is `balance − ledger_sum`, and every audited movement changes both sides equally, so it does not move with trading. **A `drift` that changed is money and ledger disagreeing by a new amount — a defect, even on a customer who was already failing.**

**Anything else about F is noise. These two are the check.**

**CHECK M — RECONCILIATION. Non-zero is expected, it moves with normal trading, and it needs the diff. But the diff alone is no longer the whole reading.**

M compares `lifetime_spend` against the boot-migration formula. **Three of its four reasons are legitimate and accrue continuously** — freed shipping netting off an add-on charge, the lossy `MAX(0, …)` clamp in `reverseOrderPoints`, and `awaiting_restock` orders the formula counts before points are credited. So **M's number will differ between D3 and here, for reasons that have nothing to do with the flip, and a non-empty diff on M is not a finding.**

**The fourth reason was a defect and it was closed on 2026-08-17 (`f4a689e4`) — which sharpens what M means here.** It was the only reason that put stored **above** derived. It no longer accrues, but the 20 orders it already produced are still in the data. So: **a negative drift is ordinary. A positive drift on customer 233 is the tester account and the known history — do not chase it. A positive drift on anyone else, or on an order cancelled after 2026-08-17, is new, is not on the legitimate list, and is worth stopping for.** The script's own notes carry this; read them rather than the number.

**CHECK P — FORENSIC IN NORMAL OPERATION, BUT ACROSS THIS FLIP IT IS TIGHTER THAN THAT, AND THIS IS THE ONE PLACE THE DRAFT UNDERSOLD A CHECK.**

P counts id gaps in `retail_points_transactions` — `MAX(id) − MIN(id) + 1 − COUNT(*)`. In ordinary use it is a measurement of one 2026-06-09 migration and nothing else, and it cannot set the exit code. **Across a database copy it is something better: a pure function of the id column, and the copy is supposed to preserve ids exactly.** New trading does not move it — a new row raises `MAX` and `COUNT` together — and the only ordinary thing that does is a rolled-back INSERT burning an id, which is rare on a synchronous driver.

**So expect P to be IDENTICAL across the flip, and treat a P that moved as evidence the ids did not come across intact.** That is a copy-fidelity failure, and it is a defect, notwithstanding that P is forensic everywhere else. **It is also the cheapest instrument you have for that failure** — G7 proves the cells, P proves the keys.

**Exit 2 on either script** — the checks could not run at all. That is an infrastructure failure, not a data verdict. Fix the invocation and run it again; **do not read a missing answer as a passing one.**

**IF BAD** — a new invariant failure after the flip means money and the ledger have stopped agreeing. **Go to Part H.** Do not attempt to repair data on a database you are still deciding whether to keep.

**One thing to know before you read any of it.** Nothing in the schema holds these invariants: `retail_points_transactions`, `retail_topup_transactions`, `retail_order_addons` and `retail_refund_events` carry **no unique constraint of any kind.** A break here does not announce itself, because there is no constraint to violate. **These two files are the only things that would notice.**

---

## G7 — Confirm the data itself survived

**RUN**

```bash
ssh root@47.239.89.63 "cd /root/roots-v2/scripts/postgres-full-copy && python3 checks.py 2>&1 | tail -30"
```

**GOOD** — all 144 foreign keys validate through Postgres itself, Chinese character counts are exact, and the wide base64 columns match by SHA-256.

**BAD** — any foreign key fails to validate, any character count differs, any hash differs.

**IF BAD** — go to Part H. A failing foreign key after a copy is not something to fix in place under time pressure.

---

## G8 — Watch the error log

**RUN**

```bash
ssh root@47.239.89.63 "wc -c /root/.pm2/logs/roots-v2-error.log && tail -n 40 /root/.pm2/logs/roots-v2-error.log"
```

**GOOD** — the log is quiet, or contains only entries you recognise from before the flip. The routine "ALIPAY not configured" banner is one of those and is not a cutover symptom.

**BAD** — new entries mentioning SQL syntax, a relation that does not exist, a column that does not exist, or a type mismatch.

**IF BAD** — this is what a dialect statement looks like when it finally executes (see G9). **A single such error is enough to stop on.** Each one is a code path that has never run on this driver, and the 371 dynamic statements mean there is no way to know how many more are behind it. Go to Part H.

---

# PART H — ROLLBACK

**§24 records that there is no rollback plan, and this part is why.** What follows is what a rollback would have to do, with every piece that has no mechanism marked. **Do not read the presence of this part as the existence of a rollback.**

## H1 🔴 GAP G23 — Nobody has decided what triggers a rollback

**WHAT THIS STEP WOULD DO** — tell the person on the night, without a judgement call, whether to go back.

**WHY THERE IS NO COMMAND** — there is no written trigger list, no named decision-maker, and no rollback window. Steps G3, G4, G6, G7 and G8 above each say "go to Part H" — **and those are this document's own proposal, not a decision anyone has taken.**

**WHAT MUST EXIST FIRST** — a written list of observations that mean stop, agreed in advance, plus a statement of how long SQLite is kept authoritative before the flip is treated as irreversible.

**IF YOU REACH HERE ON THE NIGHT** — you are making the decision alone under pressure. **That is exactly the situation §24 describes: a rollback plan written on cutover day is written by someone who has already decided to go forward.**

---

## H2 🔴 GAP G22 — There is no way to move data back

**WHAT THIS STEP WOULD DO** — return the business to SQLite without losing anything written to Postgres after the flip.

**WHY THERE IS NO COMMAND** — **nothing copies from Postgres back to SQLite.** `scripts/postgres-full-copy/` is one-directional by construction: it opens SQLite read-only, proves it read-only on every connection, and writes Postgres. There is no reverse generator, no reverse verifier, no reverse plan. §24's line that cutover and rollback become *"a setting plus a restart"* is **true of the code path and false of the data**, and the status doc says so in those words.

**WHAT MUST EXIST FIRST** — either a reverse copy tool with its own verification, or an explicit written decision that the flip is one-way after a stated moment — which is Part I, and which nobody has written either.

**IF YOU REACH HERE ON THE NIGHT** — **everything written to Postgres since the flip is lost if you go back.** How much that is depends entirely on how long you have been live, and Part I says why that clock starts sooner than you would think.

---

## H3 — What a rollback would consist of, in order

Written out so the shape is visible and the holes are countable. **Four of the seven have no mechanism.**

| # | What it has to do | Mechanism |
|---|---|---|
| 1 | Stop the application accepting new writes | 🔴 **none** — G16; there is no freeze, and the only option is stopping the process |
| 2 | Point the application back at SQLite | 🔴 **none** — G2; `TACET_DB` does not exist in either direction |
| 3 | Restore `data/roots.db` from `data/roots.db.pre-cutover` | ✅ a rename, reversible — step F1 exists precisely so this is possible |
| 4 | Bring SQLite up to date with everything Postgres accepted since the flip | 🔴 **none** — G22; no reverse copy exists |
| 5 | Undo the app directory rename and the gzgrocery table rename | 🔴 **none** — both ride with the flip deliberately, and standalone the directory rename breaks the SQLite path, pm2, Actions, `deploy-apply.sh` and probably nginx at once |
| 6 | Restart every pm2 process, not just `roots-v2` | ⚠️ partial — `pm2 restart <name>` works per process, but no list exists, and the browser holders take a risk-control hit |
| 7 | Verify the rolled-back state is sound | ✅ `check_ledger_invariants.js --db`, `check_points_invariants.js --db`, `scripts/restore-test.sh` |

**On row 3, the one that does work:** this is the entire reason F1 says rename and not delete. **It is also the only piece of the rollback that exists today.**

**On row 7:** `scripts/restore-test.sh` verifies the SQLite backup chain — it gunzips the latest hourly snapshot, runs `PRAGMA integrity_check`, counts the load-bearing tables and deletes the copy. **It is SQLite-only.** There is no standing equivalent for the Postgres dump.

---

## H4 — The one rollback that does exist, and what it does not cover

**RUN**

```bash
ssh root@47.239.89.63 "bash /root/roots-v2/scripts/rollback.sh --list"
```

then, once you have chosen one:

```bash
ssh root@47.239.89.63 "bash /root/roots-v2/scripts/rollback.sh"
```

**GOOD** — the named files are restored and `roots-v2` restarts online.

**BAD** — "no backup found", or the restore completes and the application is still wrong.

**IF BAD** — **understand what this script is before relying on it.** It restores **files that the last deploy overwrote**, from `/root/backups/deploy-<timestamp>/`. It recovers from a bad code deploy. **It does not touch `.env`, it does not touch any database, and it knows nothing about Postgres.** It cannot roll back a cutover and must never be described as if it can.

---

# PART I — THE POINT OF NO RETURN

**The question this part answers: at what step does rolling back stop being possible?**

## The answer is earlier than the first customer order

The point of no return is **the first write that lands in Postgres and does not exist in SQLite.** After that moment, going back means losing it, because there is no reverse copy (G22).

**That moment is not the first checkout.** It is the first write by anything, and **the channel daemons write constantly on their poll cycles.** The drift measurement makes the scale obvious: over one week `checkout_quotes` gained **23,829** rows and `guanyi_sync_log` gained **4,788**. Those tables move whether or not a customer buys anything.

**So the point of no return arrives within one daemon poll cycle of the restart, not at the first order.** If the daemons are restarted onto Postgres alongside the application, it is effectively immediate.

**And if they are not restarted at all — which is what happens today, since `pm2 restart roots-v2` does not touch them (G21) — they keep writing to SQLite while the application writes to Postgres, and you have two live databases diverging at once.** That is worse than either direction on its own, and it is the current default behaviour.

## What has to be true before crossing it

Every one of these. This list is the shortest honest form of the whole document:

1. **The code runs on both drivers** — G1, and the four pieces under it: G2, G3, G4, G5.
2. **The order counter is read by the application and seeded from live data** — G6, then step F2 in its correct position.
3. **The money guards survive the driver change** — G7 the idempotency regex, G12 the refund race.
4. **A backup exists that has been restored onto hardware where `tacet_app` does not exist** — G14.
5. **The copy is provably complete** — G17 the freeze-or-delta decision, G18 the tool, G19 the completion test.
6. **The application has been exercised end to end on Postgres by something other than a customer** — G20.
7. **A rollback exists** — G22 and G23.

**Say the last one plainly, because it is the reason this draft exists:** with no reverse copy and no `TACET_DB`, the flip is currently **irreversible from its first second.** Everything else on this list is work. That one is the difference between a reversible night and an irreversible one.

---

# APPENDIX — WHAT THIS DOCUMENT DELIBERATELY DOES NOT CONTAIN

- **No timeline, no date, no duration.** Nothing here is being scheduled.
- **No resolution of any gap.** Naming them is the job of this draft.
- **No reasoning.** Every "why" is in `docs/tacet-consolidation-decisions.md` §24, cited by entry name. §24 wins on any disagreement with this file.
- **No status claims of its own.** Every count and measurement quoted here is attributed to §24, to `docs/tacet-postgres-status.md`, or to the script that produced it. **If a figure here disagrees with `scripts/diagnose_async_conversion_scope.js`, the script is right and this file is stale.**

## Related

- `docs/tacet-postgres-status.md` — the living built-and-remaining record. **Read it before answering any progress question.**
- `docs/tacet-consolidation-decisions.md` §24 — the decisions record; owns every "why" above
- `docs/tacet-checkout-transaction-design.md` — the checkout conversion design
- `docs/tacet-money-cluster-design.md` — the money cluster's invariants
- `docs/tacet-postgres-order-counter.sql` — the counter table DDL, seed removed deliberately
- `scripts/postgres-full-copy/README.md` — what each copy script actually does
- `GO-LIVE-CUTOVER.md` — **a different cutover.** The WeChat mini-app one. Not this.
