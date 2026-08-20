# The Postgres cutover runbook — v0.5, FIRST DRAFT, NOT EXECUTABLE

**A procedure, not a summary.** Written to be followed literally, at 3am, by one person who is not a developer, with the shop trading and no ability to improvise.

> **G22 AND G23 ARE CLOSED — v0.5, 2026-08-20. THE FLIP NOW HAS A WAY BACK, AND SOMEBODY AUTHORISED TO TAKE IT.** `scripts/rollback-to-sqlite.sh` and `scripts/rollback-delta-report.js` merged at `7483cb91`; **PART H is rewritten from a list of holes into a procedure.** The decision-maker is **Ash, alone, with no escalation**; the triggers are four observables with stated thresholds; the window default is **ONE HOUR**. **Seventeen gaps remain of the twenty-three identified.**
>
> **READ WHAT THAT DOES AND DOES NOT CHANGE, BECAUSE THE ASYMMETRY v0.4 NAMED IS THE THING THAT MOVED.** v0.4 said there was a way onto Postgres and no way off it, so the flip was irreversible from its first second. **That sentence is now retired.** The way off is a **rename**, not a merge: it restores the pre-flip file and carries nothing back, and a reverse copy is recorded as a **REJECTED option rather than unbuilt work** (§24 v4.46, four reasons). **So the flip is reversible WITH LOSS, for as long as exactly one database is moving** — which is why the daemons stop for the flip and why refusals R1 and R4 exist. PART I is rewritten around that. **Nothing else moved: no call site is converted (G1), nothing has ever executed against Postgres (G20), nothing stops trading (G16), and G5 still serialises transactions application-wide. A rollback that exists is not permission to flip; it is permission to stop.**
>
> **AND ONE THING PART H FOUND THAT NOTHING ELSE HAD: the alerting dies at the flip and the fidelity check cannot run after it.** `lib/ops-alert.js` reads `data/roots.db` by path, so step F1 silences every alert in the system — including the health watchdog's own "storefront DOWN" page — for the whole window. `scripts/postgres-full-copy/checks.py` reads the same renamed path **and** an ungitignored-but-undeployed `wide_cols.json`, so step G7 has no runnable command. **Both are recorded in H10 per the standing freeze, not fixed.**

> **G2, G3 AND G4 ARE CLOSED — v0.4, 2026-08-19. THE FLIP HAS A MECHANISM FOR THE FIRST TIME.** `TACET_DB` exists (`lib/db-driver.js`), `lib/pg.js` is wired to the application, and `withTransaction` leases one connection per transaction. Merged at `2961d3d`. **Three of the four critical gaps remain — G16, G20, G22 — and G2 is no longer one of them.**
>
> **READ WHAT THAT DOES AND DOES NOT CHANGE, BECAUSE THE TEMPTATION IS TO READ IT AS READINESS.** G2 and G22 were recorded here as the two ends of one missing thing: no built way on, no built way off. **The way ON is now built. The way OFF is not.** So the sentence at the end of PART I is unchanged and now holds for one reason instead of two: **the flip is still irreversible from its first second.** Nothing else moved — no call site is converted (G1), nothing has ever executed against Postgres (G20), nothing stops trading (G16), and the transaction queue is still keyed on the pool rather than the client (G5), which leaves transactions correct but serialised application-wide.
>
> **NINETEEN GAPS REMAIN OF THE TWENTY-THREE IDENTIFIED.** Numbers are not reused; G2, G3, G4 and G11 stay as closed entries.

> **G11 IS CLOSED — v0.3, 2026-08-19. THE BACKFILL RAN ON 2026-08-17 AND NOBODY WROTE IT DOWN.** `retail_topup_transactions` rows **226–232** carry the seven missing ledger rows; undo file at `/root/roots-v2/data/backfill_migration_credit_ledger.undo.json`. **Check F is ZERO. All ten invariants pass.** Everything below that treated F as failing — the D3 baseline, the G6 diff, the whole apparatus for telling a flip failure from a pre-existing one — was **describing a defect that had already been repaired two days before this document was first drafted.** It is removed, not amended. **Step G6 now expects ALL 10 INVARIANTS PASSED outright.**
>
> **THE FAILURE THAT MATTERS IS NOT THE STALE TEXT, IT IS WHY IT WAS STALE.** The run left no trace in the repository: no committed script, no §24 entry, no status-doc change. Three separate readers — this runbook's first draft, §24 v4.42 and v4.43, and status item 42 — each independently concluded "not built, not run" from a record that was complete and current except for this. **A production money write that is not written down is invisible to every check this project has**, and it stayed invisible through a survey, a re-derivation and a re-verification. **Twenty-two gaps remain of the twenty-three identified; the numbering is NOT reused, so G11 stays as a closed entry rather than becoming somebody else's gap.**
>
> **CORRECTED BEFORE MERGE, 2026-08-19 — v0.1 → v0.2, and the correction is recorded rather than tidied away.** The draft was written against a reading of `claimMigrationCredit` that had been out of date for six days. **G11 said both of its pieces were unbuilt; the writer fix landed at `225aa13` on 2026-08-13** and is on `main`. Two forward-looking claims that rested on it were false when this file was written and are struck below. **That pass concluded the gap did not close** — the backfill unbuilt, F still failing, Part G still needing its baseline. **All three were wrong, and v0.3 above says why: the backfill had already run on 2026-08-17 and the run was never recorded anywhere this pass could see.** The v0.2 reasoning is left standing rather than rewritten, because it is the clearest evidence of what an unrecorded production write costs: a careful re-derivation against a current record reached a confident and false conclusion. Line-number cites for `reverseOrderBalance` and the `sqlite_sequence` reset were re-derived at this head in the same pass; both had drifted. See §24 and the re-derivation inside G11.

**READ THIS BEFORE ANYTHING ELSE. THIS RUNBOOK CANNOT BE FOLLOWED TODAY.** It is a first draft written to find out what is missing, and the missing parts are marked in it rather than papered over. **Seventeen steps of this procedure have no command to run, because the thing they depend on has not been built.** They are marked 🔴 **GAP** and numbered `G1`–`G23`, of which **G2, G3, G4, G11, G22 and G23 are CLOSED** — twenty-three were identified, six have since been built, repaired or decided, and the numbers are not reused. The index is in PART A.

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

> **`/root/roots-v2` ON THE BOX IS NOT A GIT CHECKOUT. NO `git` COMMAND WORKS THERE.** The deploy pipeline **ships files** — it stages them under `__stage__/` and installs them; it has never cloned, pulled or fetched, and there is no `.git` directory to act on. Two steps in v0.1 of this document opened with `git fetch` and `git rev-parse` against that path and **would have failed on the first line an operator typed**; both are corrected below, 2026-08-19. Anything you want to know about *what code is on the box* comes from `/root/roots-v2/.deploy-state/last-success-sha` — the record the pipeline writes — or from an `md5sum` of the file itself, **never from git.** This is also why the deploy never removes a file: there is no working tree to reconcile against.
>
> **A second consequence, and it bites the same way:** the box installs **production dependencies only**, so any script needing a devDependency cannot run there at all. `scripts/diagnose_async_conversion_scope.js` needs `espree`, which arrives with `eslint`; its own header says *"On the production box this will never work, by design."* **Analysis runs on a developer checkout. The box answers questions about state, not about source.**

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
| ~~**G2**~~ | ~~B2~~ | ✅ **CLOSED `2961d3d`.** `TACET_DB` exists — `lib/db-driver.js`. **The central action of this runbook has a mechanism.** Row kept, not deleted | status doc item 27, now in PART 2 |
| ~~**G3**~~ | ~~B3~~ | ✅ **CLOSED `2961d3d`.** `database.js` requires `lib/pg.js` under `TACET_DB=postgres`, which also arms the numeric parser | status doc item 28, now in PART 2 |
| ~~**G4**~~ | ~~B4~~ | ✅ **CLOSED `2961d3d`.** The lease is taken before BEGIN and handed to the body, so `tx` is a distinct client | status doc item 29, now in PART 2 |
| **G5** | B5 | The pooled-client scoping for the transaction queue is not written | status doc item 30 |
| **G6** | B6 | `nextOrderNo` Piece 2 — nothing in the application reads the counter row that was created for it | status doc item 12 |
| **G7** | B7 | The idempotency regex matches better-sqlite3's message text. **Failure mode is a customer charged twice, and nothing fails until money moves** | status doc item 20 |
| **G8** | B8 | The `sqlite_sequence` resets have no `setval` replacement, and both sit inside silent `try{}catch{}` | status doc item 23 |
| **G9** | B9 | 96 dialect statements will not run on Postgres, plus 371 dynamic statements no static pass can reach | status doc item 19 |
| **G10** | B10 | Six statements are failing in production today, on paths that have never executed | status doc item 15 |
| ~~**G11**~~ | ~~B11~~ | ✅ **CLOSED 2026-08-17.** Writer fixed `225aa13`; backfill RUN, rows 226–232. **Check F is zero and Part G reads it against zero.** Row kept, not deleted | status doc item 42, now in PART 2 |
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
| ~~**G22**~~ | ~~H2~~ | ✅ **CLOSED `7483cb91`.** `scripts/rollback-to-sqlite.sh` + `scripts/rollback-delta-report.js`, 23 assertions, mutation red-proven. **Restore-and-lose: a reverse copy is a REJECTED option, not unbuilt work.** Row kept, not deleted | status doc item 17, §24 v4.46 |
| ~~**G23**~~ | ~~H1~~ | ✅ **CLOSED 2026-08-20.** Decision-maker **Ash, alone**; four triggers with thresholds (H2); window default **ONE HOUR** (H3); watch loop (H4); refusal procedure R0–R4 (H7). Row kept, not deleted | §24 v4.46, PART H |

**Read the shape of that list, not just its length.** **Eleven of the seventeen open gaps sit in PART B, before the day starts** — which is the same sentence it has always been and is still the most useful thing on this page. **What changed on 2026-08-20 is the pair that used to sit at the two ends of it.** G2 and G22 were the same missing thing seen from both sides — no built way onto Postgres, no built way back off it. **Both are now closed, and G23 with them, so the flip has a mechanism, a way back, a trigger list and a named decision-maker.** It does not have converted call sites (G1), a smoke test (G20), a freeze (G16) or a delta pass (G18), **and those four are what still make this document unusable as a checklist.** The rollback is not permission to flip. It is permission to stop.

---

# PART B — BEFORE THE DAY (PHASE 2 EXIT GATE)

**None of this happens on cutover night.** Every item here must be true, and proven, before Part C begins. This part is a gate, not a procedure: work through it in any order, but do not enter Part C until every line is green.

## B0 — Confirm the record is current before trusting any number in it

**RUN — ON YOUR OWN MACHINE, IN A CHECKOUT. NOT ON THE BOX.** (Corrected 2026-08-19: v0.1 ran this over SSH against `/root/roots-v2`, where neither half of it can work — see the note in HOW TO READ A STEP.)

```bash
git fetch origin -q && git checkout origin/main -q && npm install --no-audit --no-fund && node scripts/diagnose_async_conversion_scope.js | grep -E '^\[3[ab]\]|routes/retail\.js — [0-9]+ (un)?converted blocks|runtime total: [0-9]+ +<-'
```

**GOOD** — the counts printed match the `LAST UPDATED` line at the top of `docs/tacet-postgres-status.md`. **Read the two forms separately; they are never summed.**

**BAD** — any count differs, or the script errors.

**IF BAD** — **stop and do not proceed with any other step in this document.** A moved count means the status doc is stale, and every "is this done yet" answer below it is unreliable. Re-run PART 4 of `docs/tacet-postgres-status.md` and update that file first. Never take a count from `grep`; this script is the authority (§24, after six grep-derived figures proved wrong).

---

## B1 🔴 GAP G1 — The code cannot run on Postgres

**WHAT THIS STEP WOULD DO** — confirm that every transaction in the running application works on both drivers, so that changing one setting changes which database is used and nothing else.

**WHY THERE IS NO COMMAND** — **102 transaction blocks runtime-wide are unconverted, 29 of them in `routes/retail.js`.** The checkout — 209 lines, 9 ordered writes, 6 typed errors and a 7th idempotency exit — is one of them. The money cluster is 19 members and none is converted. 73 unconverted transactions sit outside `routes/retail.js` entirely, including `commitOrderReservations` and `reverseCommittedOrder`.

**WHAT MUST EXIST FIRST** — status doc items 6 (the checkout), 7 (the money cluster), 8 (the 73), and their blockers: items 1, 2, 3, 4, 5, 10, 11, 13.

**IF YOU REACH HERE ON THE NIGHT** — stop. There is nothing to flip to.

---

## B2 ✅ CLOSED — GAP G2, the switch exists

**CLOSED `2961d3d`, 2026-08-19.** `lib/db-driver.js` reads `TACET_DB` once at module load and exports a constant; `database.js` branches on it at the construction point and nowhere else.

**Three things about it that the flip step depends on:**

- **Missing selects SQLite and says so. An unrecognised value refuses to boot.** `postgresql`, `pg`, `postgre` are near-misses for what someone meant, and a near-miss silently treated as a default is indistinguishable from the flag never being set — the operator believes the flip happened while the application keeps writing to SQLite.
- **The boot line names the driver, so step G2 can ASSERT rather than assume.** `[db-driver] TACET_DB=postgres — driver: postgres`, or `[db-driver] TACET_DB is not set — driver: sqlite (default)`. Read it; do not infer it from the fact that you edited `.env`.
- **The handle it selects shares NO method name with better-sqlite3** — no `.prepare`, `.exec`, `.transaction`, `.pragma`. Deliberate: an adapter would hand 3,339 synchronous call sites a Promise where they expect a row and none of them would throw. See §24 v4.45.

**IF YOU REACH HERE ON THE NIGHT** — nothing. This is not a stop. **But selecting the driver is not the same as being able to run on it**, and the rest of Part B still applies.

---

## B3 ✅ CLOSED — GAP G3, `lib/pg.js` is wired

**CLOSED `2961d3d`, 2026-08-19.** `database.js` requires it under `TACET_DB=postgres` — the only place in the application that does. **Requiring it is also what arms the global numeric type parser**, without which money read back from Postgres arrives as text. Its load-time throw on missing `TACET_PG_*` is kept: selecting Postgres without saying where Postgres is stops the boot rather than connecting to a guess.

**IF YOU REACH HERE ON THE NIGHT** — nothing.

---

## B4 ✅ CLOSED — GAP G4, the pg transaction backend exists

**CLOSED `2961d3d`, 2026-08-19.** `withTransaction` leases one connection before `BEGIN` and hands it to the body, so `tx` is a distinct client. On a pool, consecutive statements can land on different connections — `BEGIN` comes apart from its body and `COMMIT` may reach a connection that never began anything. The savepoint scheme was already designed and is followed, not re-derived: named by the depth it opens at, both statements on the failure path.

**WHAT IT DOES NOT CLOSE, AND THIS MATTERS ON THE NIGHT.** The queue is still keyed on the pool rather than on the checked-out client — **G5**. Transactions are correct and **serialised application-wide**: they do not fail, they take turns. And a nested call made on the pool handle rather than on `tx` is **refused by name rather than deadlocking**, which is a guard, not a fix.

**IF YOU REACH HERE ON THE NIGHT** — nothing, but read B5.

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

## B11 ✅ CLOSED — GAP G11, the seven customers check F could not explain

**THIS GAP IS CLOSED. IT IS KEPT RATHER THAN DELETED, because a step that vanishes teaches nobody why it was there.**

**WHAT WAS WRONG** — `claimMigrationCredit` credited a customer's wallet and wrote no ledger row. Measured 2026-08-13: **7 customers, ¥3,669.64 of balance that no ledger row explained**, claims dated 2026-06-13 to 2026-07-28. Check F reported those seven whether or not anything else was wrong, which is what made the flip's own verification unreadable against zero.

**BOTH HALVES ARE DONE.**

- **The writer** — fixed at `225aa13`, 2026-08-13, on `main`, with `scripts/test_migration_credit_ledger.js` and a mutant behind it. No claim since has repeated the defect, so the 53 unclaimed credits carrying ¥17,362.32 are no longer a queue of future failures.
- **The backfill** — **RUN against production 2026-08-17.** `retail_topup_transactions` rows **226–232**; undo file `/root/roots-v2/data/backfill_migration_credit_ledger.undo.json`. **Check F now returns zero and all ten invariants pass.**

**ONE THING ABOUT THOSE ROWS THAT MUST NOT BE LOST, BECAUSE IT WILL LOOK LIKE A MISTAKE TO THE NEXT READER.** Six of the seven carry `out_trade_no` in the live writer's own scheme, `migration:<creditId>:<customerId>`. **Customer 57 carries `migration:unknown:57`** — a backfill-only key, and correct: 57 is the tester's archived `_reset_` row, and the staging row that would have supplied a credit id had its values overwritten by the re-import recorded in §24 (*the migration credits staging table is not append-only*). **There is no credit id to put in that key, so the key says so.** Do not "normalise" it; the difference is the finding.

**IF YOU REACH HERE ON THE NIGHT** — nothing. This is not a stop. It is here so that a reader who finds the D3 and G6 steps referring to a money defect in older copies of this document knows it was repaired, when, and by what.

**WHAT IT COST TO NOT WRITE IT DOWN, RECORDED AS ITS OWN LESSON.** The 2026-08-17 run left no committed script, no §24 entry and no status-doc change. **Three independent readings afterwards — this document's first draft, §24 v4.42 and v4.43, and status item 42 — all concluded "not built, not run", correctly, from a record that was complete except for this.** A second implementation of the backfill was then written, tested and merged before the run was discovered. **Nothing in this project can see a production write that nobody records**, and that is a gap in the process, not in anyone's reading.

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
ssh root@47.239.89.63 "cat /root/roots-v2/.deploy-state/last-success-sha 2>/dev/null || echo 'NO DEPLOY RECORD'; pm2 jlist | node -e 'const d=JSON.parse(require(\"fs\").readFileSync(0));for(const p of d)console.log(p.name, p.pm2_env.status, p.pm2_env.restart_time)'"
```

**Corrected 2026-08-19: v0.1 read the SHA with `git rev-parse HEAD` on the box, which cannot work — the box is not a checkout.** The deploy record is the pipeline's own file and is the only SHA on that machine.

**GOOD** — you have written down, on paper or in a note you can reach without the box: the deployed commit SHA, every pm2 process name, its status, and its restart count.

**If the SHA line reads `NO DEPLOY RECORD`**, do not treat that as fatal — the record is written by the deploy and is absent on a rebuilt box. It does mean you cannot say which commit is live, so **confirm the files you care about by `md5sum` against the merged blob instead**, which is what §24 does rather than trusting a deploy reported as successful.

**BAD** — any process is not `online`, or a restart count is climbing between two runs of this command.

**IF BAD** — **do not start a cutover on an unhealthy box.** A process already crash-looping will be blamed on the flip. Get it stable first, then start again from D1.

---

## D3 — Confirm the books are clean before you start, and record P

**SIMPLIFIED 2026-08-19, WHEN G11 CLOSED.** This step used to capture a baseline for Part G to diff against, because check F failed on seven customers whatever the flip did. **It does not any more — F is zero.** What remains is smaller and does a different job: a go/no-go gate, plus the one figure Part G still genuinely has to compare.

**RUN**

```bash
ssh root@47.239.89.63 "cd /root/roots-v2 && gunzip -c \$(ls -1t /root/backups/hourly/roots-*.db.gz | head -1) > /tmp/pre-cutover.db && node scripts/check_ledger_invariants.js --db /tmp/pre-cutover.db > /tmp/pre-cutover-ledger.txt 2>&1; echo LEDGER_EXIT=\$?; node scripts/check_points_invariants.js --db /tmp/pre-cutover.db > /tmp/pre-cutover-points.txt 2>&1; echo POINTS_EXIT=\$?; grep -A6 'ids_missing' /tmp/pre-cutover-ledger.txt"
```

**GOOD** — `LEDGER_EXIT=0`, `POINTS_EXIT=0`, and the ledger file says **`ALL 10 INVARIANTS PASSED`**.

**Write down one number: check P's `ids_missing`.** That is the only figure from this step Part G compares, and the reason is in G6 — P is a pure function of the id column, so a faithful copy leaves it unchanged and any movement means ids did not survive. **Nothing else here needs to be kept.**

**BAD** — either script exits 2 (the checks could not run at all), or **exit 1 — any invariant failing.**

**IF BAD**

- **Exit 2** means "no driver, no database, or bad arguments", not a data problem. Fix the invocation and run it again.
- **Exit 1 is a stop, and it is a harder stop than it used to be.** Before 2026-08-17 a failing F was expected and had to be worked around. **It is not expected now.** A failing invariant here means the books disagree with themselves *before you have touched anything*, and a cutover is not the time to find out why. Go and understand it first. **Do not start a flip on a database that cannot pass its own checks** — you will spend the night unable to tell what you caused.

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

**BEFORE YOU LEAVE THIS STEP — two things PART H cannot work without, and both have to be done HERE.**

```bash
ssh root@47.239.89.63 "wc -c < /root/.pm2/logs/roots-v2-error.log > /root/flip-offset; cat /root/flip-offset"
```

That is the error log's size at the flip. **Every count in trigger T2 is "lines since", and without this file the threshold of one is red on the first tick** because the log already holds history. It is written outside `/root/roots-v2` on purpose: nothing in the application tree, nothing that ships.

**And start the fast watch loop now, before `TACET_DB` is set** — H4 has it. **From this rename onward the alerting is dead**: `lib/ops-alert.js` opens `data/roots.db` by path with `fileMustExist: true`, so every alert in the system, including the health watchdog's own "storefront DOWN" page, becomes a suppressed `console.error` line. **Your phone will not ring again until the rollback or the morning.**

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

## G2 — Set `TACET_DB` and restart (mechanism exists; the flip itself is still gated)

**RUN** — only after every item in PART B is green:

```bash
ssh root@47.239.89.63 "cd /root/roots-v2 && cp .env .env.pre-cutover && printf 'TACET_DB=postgres\n' >> .env && pm2 restart roots-v2 --update-env && sleep 3 && pm2 logs roots-v2 --lines 40 --nostream | grep -E '\\[db-driver\\]|running on port'"
```

**GOOD** — the log shows **`[db-driver] TACET_DB=postgres — driver: postgres`** and the process reports it is running on port **4000**.

**BAD** — the log still says `TACET_DB is not set`, or names a different port, or the `[db-driver]` line is absent entirely.

**IF BAD**

- **`TACET_DB is not set` after you set it** means the process did not re-read `.env`. That is `--update-env` not doing what you assumed, which has happened before — it wiped `PORT` on a previous occasion and the process came up on the wrong port. **Do not assume; the line is there to be read.**
- **A wrong port** means the same thing with a different symptom. Restore `.env.pre-cutover` and start again.
- **No `[db-driver]` line at all** means the process is running code older than `2961d3d`. Check what is actually deployed before touching anything else.

**Two things about this step that do not change.** `.env` is untracked and is not part of the deploy — no git operation puts `TACET_DB` on the box and none takes it off, so this edit is manual and **it is the only record that the flip happened**. And this restarts `roots-v2` ALONE: the six channel daemons keep their SQLite handles until they are bounced separately (**G21**), which is the two-databases-diverging default described in PART I.

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

## G6 — Run the money checks against Postgres

**RUN**

```bash
ssh root@47.239.89.63 "cd /root/roots-v2 && node scripts/check_ledger_invariants.js --pg; echo LEDGER_EXIT=\$?; node scripts/check_points_invariants.js --pg; echo POINTS_EXIT=\$?"
```

**GOOD — `ALL 10 INVARIANTS PASSED`, and `LEDGER_EXIT=0`.** That is the whole pass condition. Read the exit code, not the prose.

**SIMPLIFIED 2026-08-19, AND THE HISTORY IS WORTH ONE LINE.** Until G11 closed, this step could not expect zero: check F failed on seven customers and ¥3,669.64 regardless of the flip, so D3 captured a baseline and this step diffed against it — an operator at 3am comparing two text files and deciding which differences were the old defect and which were tonight's. **That machinery existed only to tolerate one repaired defect, and it is gone.** If you are reading a copy of this document that tells you to diff against a baseline, it predates 2026-08-17.

**BAD — and these must not be read the same way:**

- **Any INVARIANT non-zero — E, F, G, H, I, J, K, L, N, O.** A defect. There is no "expected failure" on this list any more, which is exactly what makes the step usable: **anything at all is something you caused.**
- **Exit 2** — the checks could not run. Infrastructure, not a data verdict. **Do not read a missing answer as a passing one.**
- **Check M is a RECONCILIATION and cannot set the exit code.** Non-zero is expected and is not a failure. Three of its four reasons accrue with ordinary trading — freed shipping netting off an add-on charge, the lossy `MAX(0, …)` clamp in `reverseOrderPoints`, and `awaiting_restock` orders the formula counts before points are credited. **The fourth was a defect and was closed 2026-08-17 (`f4a689e4`); it was the only one that put stored ABOVE derived.** So: a negative drift is ordinary; a positive drift on customer 233 is the tester account and known history; **a positive drift on anyone else, or on an order cancelled after 2026-08-17, is new and is worth stopping for.** That rule is absolute and needs no baseline.
- **Check P is FORENSIC and cannot set the exit code — but across THIS step it is tighter than that, and it is the one figure D3 asked you to write down.** P counts id gaps in `retail_points_transactions`. New trading does not move it: a new row raises `MAX` and `COUNT` together. The copy is supposed to preserve ids exactly. **So P must read the SAME number it read in D3, and a P that moved means the ids did not come across intact** — a copy-fidelity failure, and a defect notwithstanding that P is forensic everywhere else. **G7 proves the cells; P proves the keys.**

**IF BAD** — a failing invariant after the flip means money and the ledger have stopped agreeing. **Go to Part H.** Do not attempt to repair data on a database you are still deciding whether to keep.

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

> 🔴 **THIS STEP CANNOT RUN AS WRITTEN. FOUND 2026-08-20, RECORDED AND NOT FIXED (H10, finding 1).** Two independent blockers, either of which is fatal on its own.
>
> - **`checks.py` reads `wide_cols.json` on line 13, at import, before its first check runs.** That file is generated by `volume.py`, is covered by `scripts/postgres-full-copy/.gitignore`, and is **not in the repository — so the deploy has never shipped it.** If it is not already on the box from the Phase 1 rehearsal, this dies with `FileNotFoundError` and prints nothing at all.
> - **`checks.py` hardcodes `SRC = "file:/root/roots-v2/data/roots.db?mode=ro"` — the file step F1 renamed away.** Its SQLite comparison source does not exist during the exact window this check guards.
>
> **Also, and separately: this script issues `ALTER TABLE … VALIDATE CONSTRAINT` 144 times.** That is DDL against a live cluster, not a read. **It belongs here, once. It must never go in a watch loop.**
>
> **Prove both in PART B or accept that you are flying without the fidelity instrument** — see H2/T4, where the surviving half is check P: **P proves the keys came across, this proves the cells did.**

---

## G8 — Watch the error log

**RUN**

```bash
ssh root@47.239.89.63 "wc -c /root/.pm2/logs/roots-v2-error.log && tail -n 40 /root/.pm2/logs/roots-v2-error.log"
```

**GOOD** — the log is quiet, or contains only entries you recognise from before the flip. The routine "ALIPAY not configured" banner is one of those and is not a cutover symptom.

**BAD** — new entries mentioning SQL syntax, a relation that does not exist, a column that does not exist, or a type mismatch.

**READ THIS AGAINST THE OFFSET, NOT AGAINST THE WHOLE FILE, AND MIND THE ONE EXCLUSION THE FLIP ITSELF CREATES.** H2/T2 makes this a trigger with a number, and the number only works from `/root/flip-offset` taken at F1. **The flip GUARANTEES a flood of `[ops-alert] SUPPRESSED` lines into this same log, through the same `console.error`** — F1 renames the database `lib/ops-alert.js` reads by path. Exclude them and `ALIPAY not configured`; **everything else that matches is the trigger.**

**IF BAD** — this is what a dialect statement looks like when it finally executes (see G9). **A single such error is enough to stop on.** Each one is a code path that has never run on this driver, and the 371 dynamic statements mean there is no way to know how many more are behind it. Go to Part H.

---

# PART H — ROLLBACK

**THE ROLLBACK EXISTS NOW, AND THIS PART IS THE PROCEDURE FOR SPENDING IT.** `scripts/rollback-to-sqlite.sh` landed on `main` at `7483cb91` with `scripts/rollback-delta-report.js` beside it. G22 is closed. **A tool without a trigger, a decision-maker and a window is not a rollback — it is a button nobody is authorised to press**, and this part is what closes G23.

**Read the shape before the detail.** The rollback is a **rename**, not a merge: it puts back the file step F1 renamed away and carries **nothing** back from Postgres. Everything the window wrote to Postgres stays on Postgres, readable, unhurried — and stays out of the restored SQLite database permanently. So the only question this part really answers is **how much you are willing to leave there**, and the answer is a clock.

---

## H1 — THE DECISION-MAKER IS ASH. G23, PART ONE.

**DECIDED 2026-08-20. This is not an open question and it must not be reopened at 3am.**

**Ash decides, alone, with no escalation and no second opinion.** There is no developer on call, there is no one to phone, and there is no committee. Anyone reading this document on the night is the decision-maker by virtue of reading it.

**THE WHOLE DESIGN OF PART H FOLLOWS FROM THAT ONE FACT, so read what it forces:**

- **Every trigger below is an observation, never a diagnosis.** You never decide *why* something broke. You decide *whether a number crossed a line.* Working out the cause is a task for daylight and it is not on the critical path of this decision.
- **Every trigger has a command that is already on the box.** Nothing here needs a tool that has to be written, a query that has to be composed, or a log that has to be interpreted. Where a check cannot be reduced to "run this, read that number", it is named as such — see T4.
- **The colour wins over the feeling.** At 3am, on your own, the failure mode is not panicking. It is talking yourself out of a red because the shop looks fine. **The probes can be green while writes are broken (T3), and the money checks are the only thing that would notice.** If a trigger is red, roll back. You are not required to understand it first.
- **You are allowed to roll back for no reason at all.** The window is yours to spend. Spending it early costs, at the measured rates, well under one order. **There is no penalty for a cautious rollback and there is no prize for riding it out.**

**The one thing you may NOT do is leave the decision open.** That is what H3 is about.

---

## H2 — THE TRIGGERS. G23, PART TWO.

**Four observables. This is the whole instrument panel.**

**GREEN** — carry on watching. **AMBER** — do one named thing, then re-read; amber always resolves to green or red within a stated number of ticks, it never stays amber. **RED** — go to H6 and roll back. Do not gather more evidence. Do not wait for a second red.

### BEFORE THE FLIP — three numbers this part cannot work without

**Take the first at step F1, immediately after the rename and immediately before setting `TACET_DB`.**

```bash
ssh root@47.239.89.63 "wc -c < /root/.pm2/logs/roots-v2-error.log > /root/flip-offset; cat /root/flip-offset"
```

That records **where the error log stood at the flip**, so every later count is "lines *since*", not "lines ever". **Without it the T2 threshold of one is unusable**, because the log already holds history and you would be red on the first tick. It is written outside `/root/roots-v2` on purpose — nothing in the application tree, nothing that ships.

The second number is **check P's `ids_missing`**, which you already wrote down at D3. The third is the **average order value**, which nothing else in this document asks for and which H3 multiplies:

```bash
ssh root@47.239.89.63 "cd /root/roots-v2 && node -e \"const D=require('better-sqlite3');const db=new D('/tmp/pre-cutover.db',{readonly:true});console.log(db.prepare(\\\"SELECT COUNT(*) n, ROUND(AVG(total),2) aov FROM retail_orders WHERE status NOT IN ('cancelled','refunded','pending_payment') AND created_at >= datetime('now','-7 days')\\\").get())\""
```

`/tmp/pre-cutover.db` is the snapshot D3 already gunzipped. The status predicate is copied from `check_ledger_invariants.js` rather than invented. **Write down `aov`.**

---

### T1 — THE MONEY CHECKS

**RUN** — every ten minutes. The slow watch loop in H4 does it for you.

```bash
ssh root@47.239.89.63 "cd /root/roots-v2 && node scripts/check_ledger_invariants.js --pg > /tmp/led.txt 2>&1; echo LEDGER_EXIT=\$?; node scripts/check_points_invariants.js --pg > /tmp/pts.txt 2>&1; echo POINTS_EXIT=\$?; tail -8 /tmp/led.txt"
```

**Note the redirect, it is not stylistic.** `node … | tail -6` reports `tail`'s exit code, not the checker's. Read the exit code from a command that is not in a pipeline.

| Reading | Colour | Why |
|---|---|---|
| `LEDGER_EXIT=0` **and** `POINTS_EXIT=0` | 🟢 | `ALL 10 INVARIANTS PASSED`. Since G11 closed there is no expected failure on this list, so zero means zero |
| **exit 1 — ANY of E F G H I J K L N O non-zero** | 🔴 **RED, immediately** | Money and the ledger have stopped agreeing. **One is enough and there is no amber tier.** Nothing in the schema holds these invariants — `retail_points_transactions`, `retail_topup_transactions`, `retail_order_addons` and `retail_refund_events` carry **no unique constraint of any kind** — so a break does not announce itself anywhere else and does not stop getting worse on its own |
| **exit 2 — the checks could not run** | 🟠 **AMBER, once** | Infrastructure, not a verdict. Re-run once after 60 seconds. **Still 2 → RED.** A checker that cannot run is not a passing checker, and during the window it is the only instrument pointed at money |
| check M non-zero, drift **negative** | 🟢 | A reconciliation, not an invariant. Three of its four causes accrue with ordinary trading. It cannot set the exit code and must not be read as one |
| check M positive on **customer 233** | 🟢 | The tester account. Known history |
| check M positive on **anyone else**, or on an order cancelled after 2026-08-17 | 🔴 **RED** | The only cause that put stored above derived closed at `f4a689e4`. A new one is new |
| **check P's `ids_missing` ≠ the number you wrote at D3** | 🔴 **RED** | P is a pure function of the id column and trading does not move it — a new row raises `MAX` and `COUNT` together. **A P that moved means the ids did not come across intact.** Forensic everywhere else; here it is a copy-fidelity verdict |

**Why T1 is the anchor and the probes are not.** T3 answers "is it serving". **T1 is the only trigger that answers "is it serving *correctly*".** Everything else on this panel can be green while T1 goes red. The reverse is not true.

---

### T2 — THE ERROR LOG

**RUN** — every 60 seconds. The fast watch loop in H4 does it for you.

```bash
ssh root@47.239.89.63 "tail -c +\$(( \$(cat /root/flip-offset) + 1 )) /root/.pm2/logs/roots-v2-error.log | grep -avE 'ops-alert\] SUPPRESSED|ALIPAY not configured' | grep -aE 'does not exist|syntax error at or near|invalid input syntax|is not a function|cannot be cast'"
```

**THE NUMBER IS ONE. Not ten, not three. One matching line after the flip offset is RED.**

**Here is the reasoning, because "one" looks like an overreaction and is not.** 96 dialect statements are known and could be fixed by reading them. **371 dynamic statements cannot be reached by any static pass** — the only instrument that finds those is executing the code, and the only place the code is executing is production, on customers. A matching line is therefore not "an error"; it is **proof that the class is live, carrying no information whatsoever about how many more are behind it.** A threshold of ten does not buy you evidence. **It buys nine more customers meeting the same defect while you count.**

**And these errors do not degrade gracefully.** A missing relation or a bad cast on a write path does not slow something down or return a wrong page — it throws, mid-transaction, on a code path nobody has ever executed. **The characteristic damage is a half-finished money write, which is exactly what T1 has no constraint to catch.**

**THE TWO EXCLUSIONS ARE LOAD-BEARING, NOT TIDINESS.**

- **`[ops-alert] SUPPRESSED`** — the flip *guarantees* these. F1 renames `data/roots.db`; `lib/ops-alert.js` opens that path with `fileMustExist: true`; the open throws, the `catch` swallows it, the webhook resolves to empty, and **every alert in the system degrades to a `console.error` line in this same log.** Without the exclusion your own known condition floods the trigger and "one" becomes meaningless. Same mechanism H4 exists because of.
- **`ALIPAY not configured`** — a routine banner, present before the flip, not a cutover symptom.

**Anything else that matches is red.** `is not a function` is on the list on purpose: with the call sites unconverted (G1), the alien Postgres handle throws `TypeError: … .prepare is not a function`, and **that, not a SQL error, is the most likely first line you will see.**

| Reading | Colour |
|---|---|
| zero matching lines since the offset | 🟢 |
| the log grows but nothing matches | 🟢 — read the new lines when you have a moment; they are not a trigger |
| **one or more matching lines** | 🔴 **RED** |

---

### T3 — THE PROBES

**RUN** — every 60 seconds. The fast loop does it.

```bash
ssh root@47.239.89.63 "for p in / /api/retail/categories /api/retail/config /api/retail/products; do printf '%s=' \$p; curl -s -o /dev/null -m 3 -w '%{http_code}\n' http://127.0.0.1:4000\$p; done"
```

| Reading | Colour | What you do |
|---|---|---|
| `302 200 200 200` | 🟢 | nothing |
| any `4xx` | 🟢 | it answered. The pipeline's own readiness rule counts any 2xx/3xx/4xx as answering |
| **any `5xx`, once** | 🔴 **RED** | the handler threw. This is the deploy pipeline's own verdict and it is a failure, not a warning |
| **any `000`, once** | 🟠 **AMBER** | re-probe after 20 seconds. **A restart makes a legitimate few-second gap** and the watchdog can cause one |
| **`000` on two consecutive probes** | 🔴 **RED** | the process is not answering and it is not a restart gap |

**READ THIS TRIGGER ASYMMETRICALLY, BECAUSE IT IS ASYMMETRIC.** All four probes are **GET-only and side-effect free** — `/` answers "alive", `/api/retail/categories` is a trivial read, `/api/retail/config` loads config plus database, `/api/retail/products` is the storefront grid. **None of them writes.** So **a flip that breaks writes leaves all four green.** Red here is evidence of harm; **green here is not evidence of health.** Today that is academic, because the alien handle makes every database call throw at once — but the moment call sites are converted (G1), these four stop being sufficient and **nothing replaces them.** T1 is what covers the gap, which is why T1 runs every ten minutes and not once.

---

### T4 — FIDELITY, AND THE ONE TRIGGER THAT IS NOT A NUMBER

**You asked for a threshold. This one has none — and the honest answer is worse than that: as written it has no runnable command either.**

**WHAT IT WOULD BE.** `scripts/postgres-full-copy/checks.py` validates all 144 foreign keys through Postgres itself, compares Chinese character counts, and matches the wide base64 columns by SHA-256. **It is pass/fail by TEXT, not by exit code — the script contains no `sys.exit` and returns 0 whatever it finds.** So the trigger reads two printed lines:

- `failures: 0` **and** `constraints still marked NOT VALID: 0` → 🟢
- **any non-zero on either, or any character-count or hash difference** → 🔴 **RED, immediately.** Fidelity has no amber tier: a foreign key that does not validate after a copy is not something to fix in place under time pressure.

**WHY YOU MAY NOT HAVE IT ON THE NIGHT — recorded per the standing freeze, not fixed here.**

1. **`checks.py` reads `wide_cols.json` at import**, on line 13, before its first check runs. That file is generated by `volume.py`, is covered by `scripts/postgres-full-copy/.gitignore`, is **not in the repository and is therefore never deployed.** If it is not already on the box from the Phase 1 rehearsal, `python3 checks.py` dies with `FileNotFoundError` and produces no output at all.
2. **`checks.py` hardcodes `SRC = "file:/root/roots-v2/data/roots.db?mode=ro"`.** **Step F1 renames that file away.** So during the exact window this check exists to guard, its SQLite comparison source does not exist. **Step G7 as currently written cannot run after the flip.**
3. **`checks.py` issues `ALTER TABLE … VALIDATE CONSTRAINT` 144 times.** That is DDL, not a read. It is a once-at-G7 tool and **must never be put in a watch loop.**

**WHAT THAT MEANS FOR THE NIGHT, PLAINLY.** Unless both blockers are cleared *before* the night — `wide_cols.json` confirmed present on the box, and `SRC` pointed at `roots.db.pre-cutover` — **T4 is not a trigger you have, and you are flying without the fidelity instrument.** Confirm it in PART B, not at 3am. The nearest thing left on the panel is **check P under T1**: **P proves the keys survived, `checks.py` proves the cells did.** P is not a replacement. It is the half you still have.

---

### THE PANEL, IN ONE PIECE

**GREEN is all four of these at once, on every tick:**

> probes `302 200 200 200` · `newerr=0` · `LEDGER_EXIT=0` and `POINTS_EXIT=0` · restart count unchanged

**AMBER is exactly three things, and each resolves within one named re-read:**

> one `000` probe → re-probe in 20s · `exit 2` on a checker → re-run in 60s · the restart count moved → **H5** tells you which kind it was

**RED is any one of these, once:**

> any `5xx` · two consecutive `000` · one matching error-log line · any invariant exit 1 · `exit 2` twice · check P moved · check M positive on anyone but 233 · any `checks.py` failure

**There is no fourth colour and no "watch it for a bit". Amber has a stated re-read. Red goes to H6.**

---

## H3 — THE WINDOW: ONE HOUR. G23, PART THREE.

**DECIDED 2026-08-20. The default is ONE HOUR from the moment `TACET_DB=postgres` takes effect at step G2.** At the end of it you either declare the cutover kept, or you roll back. **Both are decisions. Letting the hour pass without taking one is not a third option, and it is the specific failure this section exists to prevent.**

### Why one hour, when the arithmetic allows two days

**Be clear that the hour is NOT what staleness forces.** §24's measured rates say the opposite, and they are the reason the window *could* be long: 63% of the database is disposable — `retail_checkout_quotes` (105,735 rows, an abandonment log written best-effort inside a `try/catch`) plus the three sync logs (116,846) are 222,581 of 353,076 rows, and they dominate all the drift. **Business rows accrue at roughly one to two per hour.** The pre-flip file does not rot, and **Postgres is not dropped by the rollback**, so everything the window leaves stays readable and reconciliation is an unhurried offline task. On staleness alone the window is **one to two trading days.**

**The hour is chosen against a different failure, and it is a human one. A decision left open drifts.** Every hour you do not decide, the cost of deciding goes up and your willingness to pay it goes down: you have been awake longer, the shop has traded longer, and the rows you would abandon have stopped being rows and become people you would have to phone. **The window does not close because the data goes stale. It closes because you do.** An hour is long enough for every trigger on the panel to fire if it is going to, and short enough that you will still actually choose to spend it.

**Set a timer.** Not a mental note — a timer, on the phone that is not going to ring (H4).

### What you are accepting for each additional hour

| What accrues | Per hour | Where it shows |
|---|---|---|
| `retail_orders` | **≈ 0.7** (+121/week) | delta report, named by `id` and `order_no` |
| `retail_customers` | **≈ 1.3** (+222/week) | delta report, named by `id` |
| business rows overall | **≈ 1–2** | delta report `TOTAL … to look at` |
| disposable rows | hundreds | delta report `(disposable)` — ignore them |
| **money** | **≈ 0.7 × AOV** | multiply by the `aov` you wrote down before the flip |

**Read the money line for what it actually is.** It is **not** money that vanishes. A payment taken during the window was taken by the gateway; the rollback removes the *order record* and does **not** reverse the *charge*. So the per-hour money figure is **the value of orders you will have to honour by hand, from a report, against customers who have already paid and are holding a receipt.** That is why an hour costs more than `0.7 × AOV` in effort even though it costs exactly that in revenue.

**And one cost that is not per-row at all: the channel daemons.** The decision is that the daemons stop for the flip and come back on Postgres (§24 v4.46). Everything they ingest during the window — Meituan, 闪购, Eleme, Qingyun, gzgrocery orders — lands in Postgres and is **lost on rollback along with everything else.** Channel orders do not queue politely; the channels keep taking them. **This is very likely the largest per-hour cost on the list, and it is not in the table because it has never been measured.** Assume it is bigger than the storefront's 0.7.

### Where rolling back stops being the cheaper option

**Three crossings. You can recognise all three on the night, and two of them have a command.**

**1. THE VOLUME CROSSING — measurable, so measure it rather than guess.**

`scripts/rollback-delta-report.js` is **read-only and server-enforced** (`BEGIN TRANSACTION READ ONLY`, `ROLLBACK` on every path including a throw) and it runs perfectly well **while you are still live on Postgres and still deciding.** So it is not only a post-mortem — **it is your cost estimate.**

```bash
ssh root@47.239.89.63 "cd /root/roots-v2 && node scripts/rollback-delta-report.js | tail -25"
```

Read the `TOTAL n row(s): m to look at` line. **`m` is the number of rows you are personally going to re-enter by hand.** §24 puts the threshold where a person stops doing that carefully at **20–40 rows.** Below that, rolling back is clearly cheaper than living with a broken flip. **Above 40 it stops being obviously cheaper** and you are choosing between two piles of work rather than between a good outcome and a bad one. At 1–2 business rows an hour you reach 40 in **one to two trading days** — §24's figure, arrived at from the other end.

**2. THE MONEY CROSSING — there isn't one, and that is the point.**

**If T1 is red, roll back at any window length.** The volume crossing does not apply, because what you would be choosing to keep is **a ledger that does not agree with the balances it explains**, on a database with no unique constraint on any of the four tables that matter and no reverse copy to repair it from. Forty rows of re-entry is a bad night. An unexplained balance is a defect you may never find the bottom of. **Money red has no crossover and no clock.**

**3. THE REFUSAL CROSSING — the one that closes the window without asking you.**

**The window is only a window while the rollback is still a rename.** The moment any of R1 through R4 (H7) becomes true, rollback stops being a four-character `mv` and becomes a two-way merge that nothing in this project can do. **That crossing is not on the clock and it can happen in minute three.** The single most likely cause is a daemon or a loose script writing to SQLite after the flip — R1 and R4 respectively.

**So the practical rule is not "one hour, then it's too late". It is "one hour, and check every so often that it is still a rename".** A dry run costs nothing and changes nothing:

```bash
ssh root@47.239.89.63 "bash /root/roots-v2/scripts/rollback-to-sqlite.sh"
```

**With no `--apply` this writes nothing, renames nothing and stops nothing.** Run it **once at the 30-minute mark.** If the pre-flight is clean, you still have a rename and the window is real. If it refuses, go to **H7 now**, while you still have most of an hour, rather than discovering it at the end when you have none.

---

## H4 — THE WATCH LOOP, BECAUSE YOUR PHONE IS GOING TO BE SILENT

**THIS IS THE PART TO READ TWICE.** During the exact window in which you are watching for triggers, **the alerting is dead by construction, and nothing says so.**

**The mechanism, so you believe it rather than merely accept it.** `lib/ops-alert.js` resolves the WeCom webhook **only** through `roConfig()`, which opens `data/roots.db` **by path**, with `{ readonly: true, fileMustExist: true }`. It never consults `process.env` — `scripts/health-watchdog.js` carefully sets `WECOM_ALERT_WEBHOOK` before requiring it and **that plumbing is dead code for this path.** After step F1 renames the file: the open throws → the `catch (_)` swallows it → `roConfig` returns null → `webhookUrl()` returns `''` → and every alert in the system becomes

```
[ops-alert] SUPPRESSED (alerts disabled): <the message>
```

a `console.error` line in a log file. **No driver switch can reach this. It reads a path, not a handle.**

**And the worst single consequence: the health watchdog's own `🔴 roots-v2 storefront DOWN` page is one of the suppressed messages.** The thing whose entire job is to tell you the shop is down will restart the app and tell nobody.

**So the loops below are not a convenience. They are the alerting channel for the window.**

### Two rules about where they run

**Run them on the laptop, over SSH. Not on the box.** If the box wedges — the 2026-06-28 failure mode this project has already had once — a loop running *on* the box dies with it, and its silence is indistinguishable from everything being fine. **A loop on the laptop notices that the box stopped answering, which is the single most important thing it can tell you.**

**Do not put a helper script in `scripts/` to make this tidier.** A file under `scripts/` **ships on the next deploy and bounces pm2**, which is the last thing you want mid-window. Everything here is self-contained on the laptop except `/root/flip-offset`, which lives outside the application directory on purpose.

### The fast loop — 60 seconds. Start it BEFORE the flip.

Start it before you set `TACET_DB`, so you have a page of known-green lines to compare against. Leave it running in its own terminal for the whole window.

```bash
LAST=""; while :; do OUT=$(ssh -o ConnectTimeout=10 root@47.239.89.63 bash -s <<'EOS'
B=$(cat /root/flip-offset 2>/dev/null || echo 1)
P=""; for p in / /api/retail/categories /api/retail/config /api/retail/products; do
  P="$P$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:4000$p") "
done
R=$(pm2 jlist | node -e 'let d=[];try{d=JSON.parse(require("fs").readFileSync(0,"utf8"))}catch(e){}
const p=d.find(x=>x.name==="roots-v2");
process.stdout.write(p?p.pm2_env.restart_time+"/"+(p.pm2_env.unstable_restarts||0):"?/?")')
E=$(tail -c +"$((B+1))" /root/.pm2/logs/roots-v2-error.log 2>/dev/null \
  | grep -avE 'ops-alert\] SUPPRESSED|ALIPAY not configured' \
  | grep -acE 'does not exist|syntax error at or near|invalid input syntax|is not a function|cannot be cast')
W=$(grep -ac 'probe FAILED' /var/log/roots-health.log 2>/dev/null)
echo "probes=$P| restarts=$R | newerr=$E | wdogfails=$W"
EOS
); echo "$(date +%H:%M:%S)  ${OUT:-*** NO ANSWER FROM THE BOX ***}"; \
if [ -z "$OUT" ] || { [ -n "$LAST" ] && [ "$OUT" != "$LAST" ]; }; then printf '\a\a\a'; fi; \
LAST="$OUT"; sleep 60; done
```

**HOW TO READ IT — and it is deliberately the simplest rule available: the line should be byte-for-byte identical every minute. It rings on any change, and on no answer at all.**

The first line is your baseline. **Write it down.** Then:

| The line says | Colour | Section |
|---|---|---|
| identical to the previous one | 🟢 | — |
| `*** NO ANSWER FROM THE BOX ***` | 🟠 → 🔴 | one is a network blip; **two in a row is the box, and the box not answering during a flip is red** |
| a probe changed to `5xx` | 🔴 | T3 |
| a probe changed to `000` | 🟠 | T3 — the next tick decides |
| `newerr=` is no longer `0` | 🔴 | T2 |
| `restarts=` moved | 🟠 | **H5 — read H5 before concluding anything** |
| `wdogfails=` moved | 🟠 | the watchdog saw the app fail a probe. Same as above: H5 |

**The bell matters.** Replacing silent alerting with a silent terminal is not an improvement. If your terminal swallows `\a`, turn on a visual bell **before** you start, not during.

### The slow loop — 10 minutes. Second terminal.

```bash
while :; do echo "=== $(date +%H:%M:%S) ==="; \
ssh root@47.239.89.63 "cd /root/roots-v2 && node scripts/check_ledger_invariants.js --pg > /tmp/led.txt 2>&1; echo LEDGER_EXIT=\$?; node scripts/check_points_invariants.js --pg > /tmp/pts.txt 2>&1; echo POINTS_EXIT=\$?; grep -E 'INVARIANTS (PASSED|FAILED)|ids_missing' /tmp/led.txt"; \
printf '\a'; sleep 600; done
```

**Ten minutes, not one.** These are full scans across the money tables. On Postgres they run inside a `READ ONLY` transaction so nothing can be written, but they still compete for the same server, and hammering the database you are deciding whether to trust is not a neutral act. **Six readings an hour is enough to catch a break early and light enough to be free.**

**Every reading is one comparison:** `LEDGER_EXIT=0`, `POINTS_EXIT=0`, `ALL 10 INVARIANTS PASSED`, and `ids_missing` equal to D3's number. Anything else is T1.

### What the loops do NOT cover

- **Fidelity / `checks.py`** — once only, at G7, and see T4 for why you may not have it at all. **Never in a loop; it issues DDL.**
- **The channel daemons.** Nothing here watches them. G21 is still open and the daemons have no per-process confirmation check.
- **Writes.** No probe on this panel writes anything. T1 is the closest thing to a write check, and it only reads what writes left behind.

---

## H5 — TELLING A WATCHDOG BOUNCE FROM A CRASH

**One correction to the premise first, because it changes what you are looking at.**

**The watchdog does not restart the app every four minutes.** `scripts/health-watchdog.js` runs from cron every 2 minutes with `HEALTH_FAILS=2`, so the **first** restart lands about 4 minutes after the app stops answering — and then it **latches.** The restart sits behind `if (state.fails >= FAIL_THRESHOLD && !state.down)`, and that same branch sets `state.down = true`. **One restart per down-episode, not one per tick.** The latch clears only when a probe succeeds again.

**So a restart every four minutes means something specific and worth knowing: the app is coming back, answering `/`, and dying again.** That is a **flap**, not a restart loop — and a flapping app under a flip is a code path that runs on some requests and not others, which is exactly the G9 dynamic-statement signature.

**There is also a case with no restarts at all that is worse than either: the app answers `/` but is broken on writes.** The watchdog is satisfied, the probes are green, nothing restarts, and only T1 sees it.

### The three discriminators, in the order to use them

**1. The health log — the primary tell.**

```bash
ssh root@47.239.89.63 "tail -20 /var/log/roots-health.log"
```

- A **watchdog bounce is always preceded** by `[health] app probe FAILED (2/2) http://127.0.0.1:4000/` and **followed** by an `[ops-alert] SUPPRESSED … 🔴 roots-v2 storefront DOWN` line in this same file — suppressed, because alerting is dead (H4), which is why you are reading a log instead of a phone.
- A **pm2 crash-restart leaves nothing here at all.**

**So: `restarts=` moved AND a health-log line at the same minute → watchdog. `restarts=` moved AND no health-log line → the process died on its own.**

**2. `unstable_restarts` — corroborating, and it only ever means one thing.**

The fast loop already prints it as the number after the slash. pm2 increments it when a process dies inside `min_uptime`; **a deliberate `pm2 restart` is not one of those.** So **any movement in `unstable_restarts` is a crash, whatever the health log says.** A watchdog bounce cannot raise it.

**3. The error log at the same timestamp.**

```bash
ssh root@47.239.89.63 "tail -60 /root/.pm2/logs/roots-v2-error.log"
```

A crash leaves a stack. A watchdog bounce leaves the ordinary shutdown/startup sequence and no throw.

### And the thing that matters more than the classification

**A watchdog bounce is not benign just because you have identified it as one.** The watchdog restarted the app **because the app stopped answering**, and during a flip the overwhelmingly likely cause of that is the flip. **Identifying the bounce tells you which mechanism restarted the process. It tells you nothing about why the process needed restarting.**

**So the rule is: a bounce is never the trigger. It is an instruction to go and read T2 and T3.** If they are green and it does not recur, you have had one transient and the panel says carry on. **If it recurs — a second bounce inside the window — treat it as red without further diagnosis.** Two restarts in an hour on a box that was stable at D2 is the flip.

---

## H6 — WHAT YOU DO AFTER YOU DECIDE TO ROLL BACK

**Nine steps, in order. Do not reorder them: steps 2 and 3 exist because of things that stop being possible after step 4.**

### 1. Write down the time and the trigger. One line, on paper.

> `03:47 — T2, one line: relation "retail_order_addons" does not exist`

**The receipt the tool writes records what it did, not why you ran it.** You will want the why in the morning and you will not remember it.

### 2. Run the delta report NOW, while still on Postgres. Save it off the box.

```bash
ssh root@47.239.89.63 "cd /root/roots-v2 && node scripts/rollback-delta-report.js" > rollback-delta-$(date +%Y%m%d-%H%M).txt
```

**THIS STEP IS NOT OPTIONAL AND IT CANNOT BE DONE PROPERLY LATER — two independent reasons, both recorded in H10.**

- The report's default `--since-db` is `data/roots.db.pre-cutover`, and **step 4 renames that file to `data/roots.db`.** After the rollback the default path does not exist.
- Worse, pointing it at the restored `data/roots.db` afterwards gives a **wrong** answer rather than an error: the rollback inserts one cancelled marker order into that file before renaming it, which raises `MAX(id)` on `retail_orders` by one — so the watermark shifts and **exactly one window order is silently omitted.**

The report is read-only and server-enforced. Running it costs nothing, and it is the only complete list you will get of what the window is about to leave behind. **It names orders, payments, top-ups, points rows and customers by id.**

### 3. Dry run the rollback. Read three things.

```bash
ssh root@47.239.89.63 "bash /root/roots-v2/scripts/rollback-to-sqlite.sh"
```

**Nothing is written, renamed or stopped.** Read:

- **PRE-FLIGHT** — `R0 ok`, `R1 ok`, `R2 ok`, `R3 ok`, `R4 ok`. **Any refusal → H7, and stop here.**
- **ORDER-NUMBER HIGH-WATER** — the size of the gap, and the `TC…` number it will reserve.
- **PLAN** — six lines. If any of them is not what you expect, stop.

### 4. Apply.

```bash
ssh root@47.239.89.63 "bash /root/roots-v2/scripts/rollback-to-sqlite.sh --apply; echo EXIT=\$?"
```

`--apply` is required and the tool fails closed without it.

### 5. Read the exit code — and know that exit 1 means two different things.

- **`EXIT=0`** — `ROLLBACK COMPLETE AND VERIFIED.` The boot line named sqlite and both invariant checkers passed against the restored file. Go to step 6.
- **`EXIT=1` with `REFUSED` in the output** — **nothing was changed.** Every refusal is checked before anything is stopped, renamed or written. Go to H7.
- **`EXIT=1` with `ROLLBACK APPLIED BUT NOT VERIFIED`** — **the rename happened and the checks did not pass.** This is the serious one. Postgres is untouched and still holds the window; the receipt at `data/rollback-receipt-*.json` records what was done. Read *which* check failed: **a boot line that does not name sqlite** means the process did not come back on the driver you expect and is the more urgent of the two; **a failing invariant against the restored file** means the *pre-flip* database has a problem, which is not something the flip caused. **In both cases stop, and do not attempt a second flip.**

### 6. Confirm it actually worked — four checks, not one.

```bash
ssh root@47.239.89.63 "for p in / /api/retail/categories /api/retail/config /api/retail/products; do printf '%s=' \$p; curl -s -o /dev/null -m 3 -w '%{http_code}\n' http://127.0.0.1:4000\$p; done; echo '--- driver ---'; pm2 logs roots-v2 --lines 60 --nostream | grep -a 'db-driver' | tail -1; echo '--- alerting ---'; tail -30 /root/.pm2/logs/roots-v2-error.log | grep -ac 'ops-alert\] SUPPRESSED'"
```

- **probes** back to `302 200 200 200`.
- **the boot line names `sqlite`.** Absence is not evidence — if there is no `[db-driver]` line at all, do not assume.
- **the suppressed-alert count should be `0` and staying there.** `data/roots.db` exists again, so `roConfig` can open it again and the webhook resolves. **This is the check that tells you your phone works again**, and it is worth doing explicitly because nothing else will tell you.
- **leave the fast loop running another fifteen minutes.** The restart count must not move.

### 7. Tell the customers who are actually affected. Individually, from the report.

**Do not broadcast.** At one hour and the measured rates the list is expected to be well under one order. Work from the delta report you saved in step 2 — it names them.

**What is true, and it is the thing to say:**

- **Their payment stands.** The rollback removed the order record. It did **not** reverse any charge — the gateway took the money and still has it. **Anyone who paid during the window has paid.**
- **Their order number is still theirs.** The tool reserves the high-water by inserting **one cancelled marker order ABOVE the burned range, never inside it**, precisely so every number the window actually issued stays free for a faithful re-entry. A customer holding a receipt for `TC000341` can be given `TC000341`.
- **Re-enter the order; do not ask them to place it again.** The report gives you `order_no`, `total`, `customer_id` and the items.

**The rows to work through, in priority order:** `retail_payments` and `retail_topup_transactions` first (money already taken), then `retail_orders`, then `retail_points_transactions`, then `retail_customers` — an account created during the window has to be created again. **Ignore everything marked `(disposable)`**; the quote log and the three sync logs are the bulk of the count and none of it is an obligation to anybody.

**Once the real orders are re-entered, remove the marker.** The tool prints this line; it is not optional housekeeping, because the marker is a cancelled order sitting in the sequence:

```sql
DELETE FROM retail_orders WHERE cancelled_reason = 'rollback_order_range_reservation';
```

### 8. Fix the alerting before anything else. §24 says this is first, and it is right.

You have just spent an hour with no alerting because `lib/ops-alert.js` reads a path. **You are now back on SQLite and it works again — which is exactly when it gets forgotten.** It is the first thing to fix when the freeze lifts.

### 9. Stop. Do not attempt a second flip tonight.

**You have one rollback.** `data/roots.db.pre-cutover` has been consumed — it is now `data/roots.db`. A second flip needs a fresh F1, a fresh copy, a fresh delta pass and a fresh backup, and every one of those is a Part D or Part E step. **Whatever caused the trigger is still there and you have deliberately not diagnosed it.** Go to bed.

---

## H7 — WHEN THE TOOL REFUSES: R0 THROUGH R4. THE WORST NIGHT.

**READ THE ONE THING THAT IS TRUE OF ALL FIVE BEFORE READING ANY OF THEM: A REFUSAL MEANS NOTHING HAS BEEN CHANGED.** Every check runs before anything is stopped, renamed or written. A refusal has cost you **nothing except a few minutes of the window.** You are still on Postgres, still trading, still watching the panel, and still able to decide again in ten minutes with better information. **The refusal is not the emergency. Treating it as one is how the emergency gets made.**

**AND THE ESCAPE HATCH DOES NOT EXIST, DELIBERATELY: there is no `--force`.** Do not go looking for one, do not edit the script to add one, and do not comment out a check. Every refusal below marks a state in which the rename would destroy something. **The two overrides that do exist — `--flip-at` and `--assume-burned` — are narrow, and each is named in the one place it is legitimate.**

---

### R0 — `TACET_DB=postgres` is not set in `.env`

**WHAT IT MEANS** — there is no flip to undo. The tool reads `.env` rather than the process, so it is answering about the *configured* state, which is what the rename undoes.

**Two ways to arrive here, and they need opposite responses.**

```bash
ssh root@47.239.89.63 "grep -n 'TACET_DB' /root/roots-v2/.env; ls -la /root/roots-v2/data/roots.db*; pm2 logs roots-v2 --lines 60 --nostream | grep -a 'db-driver' | tail -1; ls -la /root/roots-v2/data/rollback-receipt-*.json 2>/dev/null"
```

- **`.env` shows `# rolled back: TACET_DB=postgres`** — a rollback has **already run.** Find its receipt in `data/rollback-receipt-*.json`, read it, and go to H6 step 6. **You are already home.**
- **`.env` shows no `TACET_DB` and the boot line says `sqlite`** — **the flip never took.** `pm2 restart --update-env` has silently dropped a variable on this box before; it wiped `PORT` once. You have spent the window watching a system that never moved. **Then confirm `data/roots.db` exists** — because if F1 ran and the flip did not, the application has been running with no database at all, and the probes will already have told you.

**WHAT YOU MUST NOT DO** — force it. Rolling back a system already on SQLite would rename the live database out from under a running application.

---

### R1 — a live `data/roots.db` EXISTS

**THIS IS THE WORST OF THE FIVE.** F1 renamed the file away, so **something recreated it after the flip.** You now have two SQLite files, and choosing between them is a merge.

**WHAT PUT IT THERE — two candidates, and you can tell them apart.**

```bash
ssh root@47.239.89.63 "ls -la --time-style=full-iso /root/roots-v2/data/roots.db*; pm2 jlist | node -e 'const d=JSON.parse(require(\"fs\").readFileSync(0));for(const p of d)console.log(p.name, p.pm2_env.status, new Date(p.pm2_env.pm_uptime).toISOString())'"
```

- **A daemon that was never stopped**, or was restarted onto SQLite. Its pm2 uptime starts *before* the flip. This is the case §24's daemons-stop decision exists to prevent.
- **A loose script.** ~80 files in `scripts/` open the database by path and **none of them has been audited (G13).**

**WHAT YOU DO, IN ORDER:**

1. **Stop every writer first.** `pm2 stop` everything except `shangou-chrome` and `qingyun-chrome`. Nothing below is safe while something is still writing.
2. **Compare the two files.** mtimes against the flip time, `PRAGMA integrity_check` on both, and row counts on `retail_orders`, `retail_payments`, `retail_topup_transactions`.
3. **Move the intruder aside under a new name. Never delete either file.**
   ```bash
   ssh root@47.239.89.63 "mv /root/roots-v2/data/roots.db /root/roots-v2/data/roots.db.intruder-\$(date +%Y%m%d-%H%M%S)"
   ```
4. **Re-run the dry run.** If the pre-flight now passes, you have converted R1 into a clean rollback. **Keep the intruder file — it is the evidence of what was still writing.**

**AND THE STOPPING RULE, WHICH MATTERS MORE THAN THE STEPS: if you cannot establish which file is which, STAY ON POSTGRES.** A wrong choice here loses an entire database. The window's cost is bounded and measured; that is not. **An unbounded loss is never the better trade against a bounded one, least of all at 3am.**

---

### R2 — `data/roots.db.pre-cutover` is MISSING

**WHAT IT MEANS** — the thing you are restoring *to* is gone. There is nothing for the rename to move.

**FIRST, LOOK FOR IT.** It is more likely moved than lost:

```bash
ssh root@47.239.89.63 "find /root -name 'roots.db*' -newermt '-2 days' -ls 2>/dev/null"
```

**IF IT IS GENUINELY GONE, you have a choice the tool refuses to make for you, and it refuses on purpose.** The hourly snapshots in `/root/backups/hourly` are a fallback, but **restoring one is a different decision**: it loses everything between that snapshot and the flip — up to an hour of *pre-flip* trading, on top of the whole window.

**THE ANSWER, WRITTEN DOWN SO YOU DO NOT HAVE TO REACH IT AT 3AM:**

- **If T1 is green — STAY ON POSTGRES.** Postgres is running and its data is complete. The snapshot is neither. **You do not trade a complete database for an incomplete one because of a trigger you could otherwise survive.** Roll back in daylight, with help, or do not roll back.
- **If T1 is RED — restore the snapshot.** Now the alternative to an hour of lost pre-flip trading is a ledger that does not add up on a database with no reverse copy, and that is worse. **Prove a snapshot first with `scripts/restore-test.sh`** — it gunzips the latest hourly, runs `PRAGMA integrity_check`, counts the load-bearing tables and deletes the copy. **It is the one tool in this whole section that is green and proven.**

---

### R3 — the pre-cutover file FAILS `integrity_check`

**Same decision shape as R2, one degree worse: you have the file and it is broken.**

**WHAT YOU MUST NOT DO** — restore it anyway, or attempt a repair in place. `.recover` produces a *new* file and takes time you do not have; a corrupt database restored over a working situation is an outage on top of an outage.

**WHAT YOU DO** — treat it exactly as R2. Prove an hourly snapshot with `restore-test.sh`, then apply R2's rule: **T1 green → stay on Postgres. T1 red → restore the snapshot.**

**AND RECORD THIS SEPARATELY, BECAUSE IT IS NOT A CUTOVER FAULT.** `mv` does not corrupt a file. A pre-cutover file that fails `integrity_check` **was already damaged before the flip**, and D1's backup and D3's checks both ran against it or a sibling of it without noticing. **That is its own incident and it needs writing up however the night ends.**

---

### R4 — the pre-cutover file was WRITTEN AFTER THE FLIP

**WHAT IT MEANS, AND WHY THE CHECK EXISTS AT ALL.** `mv` preserves mtime, and **an open better-sqlite3 handle keeps writing to the same inode after a rename** — so a process that was not stopped goes on writing *into `roots.db.pre-cutover` itself* and pushes its mtime past the flip. **Both databases moved.** Rollback is a rename only when one side is frozen; this is a merge, **and there is no tool for a merge and there is not going to be one.** §24 records the reverse copy as a **rejected** option with four reasons, and the sharpest is silent: 89 of 129 tables carry no `updated_at`, `retail_customers` among them, holding `balance`, `points_balance`, `lifetime_spend` and `tier`.

**WITH THE DAEMONS STOPPED, R4 CAN NEVER FIRE. Its firing is proof the decision was not honoured.**

**WHAT YOU DO, IN ORDER:**

1. **Find the writer and stop it.** Same commands as R1 — pm2 uptimes against the flip time — and remember it may be a loose script rather than a daemon.
2. **Then measure how much SQLite actually took.** This is the whole decision:
   ```bash
   ssh root@47.239.89.63 "cd /root/roots-v2 && node -e \"const D=require('better-sqlite3');const db=new D('data/roots.db.pre-cutover',{readonly:true});for(const t of ['retail_orders','retail_payments','retail_topup_transactions','retail_points_transactions','retail_customers'])console.log(t, db.prepare('SELECT COUNT(*) n FROM '+t).get().n)\""
   ```
   Compare against the same counts from `/tmp/pre-cutover.db`, the D3 snapshot.
3. **Decide on that answer, not on the mtime.**
   - **Zero business rows — only sync-log or quote noise moved.** Then R4 is a true statement about a harmless write and a false alarm about a merge. **This is the one legitimate use of an override:** re-run with `--flip-at` set to a time *after* that last SQLite write. **It converts a false positive into a true statement rather than suppressing a check.**
     ```bash
     ssh root@47.239.89.63 "bash /root/roots-v2/scripts/rollback-to-sqlite.sh --flip-at '<a time after the last sqlite write>'"
     ```
     **Dry run it first and read the pre-flight again.** If R1 also fires, the override does not help you — you are in R1, not R4.
   - **Any business row at all — STAY ON POSTGRES AND RECONCILE IN DAYLIGHT.** Two databases each holding real orders is a merge. **A merge at 3am, alone, across 89 tables that cannot report that a row changed, is how money gets lost in a way nobody finds for months.** Postgres is running. Leave it running. Write down the counts, go to bed, and do the reconciliation with the delta report and a full day in front of you.

---

## H8 — WHAT A ROLLBACK CONSISTS OF, IN ORDER, AND WHAT STILL HAS NO MECHANISM

**Updated 2026-08-20: five of the seven rows moved when `7483cb91` landed. Two remain open.**

| # | What it has to do | Mechanism |
|---|---|---|
| 1 | Stop the application accepting new writes | ✅ **the tool does it** — `pm2 stop` on `roots-v2` and every `*-daemon.js`, discovered by `pm_exec_path` and never by a name list. G16 is still open as a *product* gap; the rollback does not need it |
| 2 | Point the application back at SQLite | ✅ `TACET_DB` is **commented out rather than deleted**, so `.env` still records that a flip happened and was undone. *(This row said "G2 does not exist in either direction" until 2026-08-20 and was stale from `2961d3d`.)* |
| 3 | Restore `data/roots.db` from `data/roots.db.pre-cutover` | ✅ a rename — **step F1 exists precisely so this is possible** |
| 4 | Bring SQLite up to date with everything Postgres accepted since the flip | 🔴 **none, and never will be** — a reverse copy is a **rejected option**, not an unbuilt one (§24 v4.46, four reasons). `rollback-delta-report.js` lists what was left instead |
| 5 | Undo the app directory rename and the gzgrocery table rename | 🔴 **none** — both ride with the flip deliberately, and standalone the directory rename breaks the SQLite path, pm2, Actions, `deploy-apply.sh` and probably nginx at once |
| 6 | Restart every pm2 process, not just `roots-v2` | ✅ **the tool does it** — the same discovered list, restarted with `--update-env`, browser holders deliberately excluded because bouncing one costs a risk-control challenge. **The ordered per-process *cutover* procedure is still missing (G21); the rollback's own restart is not** |
| 7 | Verify the rolled-back state is sound | ✅ **and it fails rather than prints** — the boot line must name sqlite, both invariant checkers must pass against the restored file, exit 1 otherwise. The receipt is written **before** verification, so a failed verify still leaves a record |

**Row 4 is the one to keep in your head.** It is not a gap waiting on work. **It is a decision, and the whole of Part H is built on top of it:** the rollback is restore-and-lose, the window is what bounds the loss, and H3 is how you choose the bound.

---

## H9 — THE OTHER ROLLBACK, AND WHY IT IS NOT THIS ONE

**There are two scripts with `rollback` in the name and they do completely different jobs. Do not reach for the wrong one at 3am.**

```bash
ssh root@47.239.89.63 "bash /root/roots-v2/scripts/rollback.sh --list"
```

`scripts/rollback.sh` restores **files that the last deploy overwrote**, from `/root/backups/deploy-<timestamp>/`. It recovers from a bad **code deploy**. **It does not touch `.env`, it does not touch any database, and it knows nothing about Postgres.** It cannot roll back a cutover and must never be described as if it can.

**`scripts/rollback-to-sqlite.sh` is the cutover one.** If the command you are about to run does not have `-to-sqlite` in it, it is not the one this part is about.

---

## H10 — FINDINGS FROM WRITING THIS PART, RECORDED AND NOT FIXED

**Per the standing freeze. Each is a thing that would otherwise have been discovered on the night.**

1. **`checks.py` cannot run after step F1 — two independent reasons.** `wide_cols.json` is gitignored, generated by `volume.py`, never deployed, and read at **import**, before any check runs. And `SRC` is hardcoded to `/root/roots-v2/data/roots.db`, **which F1 renames away.** **Step G7 has no runnable command during the window it guards, so T4 is a trigger with no instrument** unless both are cleared in PART B.
2. **`checks.py` issues 144 `ALTER TABLE … VALIDATE CONSTRAINT` statements.** That is DDL against a live production cluster. It is a once-at-G7 tool and **must never be put in a watch loop.**
3. **`rollback-delta-report.js` must be run BEFORE the rollback, and nothing in the tool says so.** Its default `--since-db` is the pre-cutover file, which the rollback renames away; and pointing it at the restored `data/roots.db` afterwards **silently omits exactly one window order**, because the reservation marker raises `retail_orders`' watermark by one. **A wrong answer, not an error.**
4. **A T2 threshold of one is unusable without excluding `[ops-alert] SUPPRESSED`** — and the flip itself *guarantees* those lines, in the same log, from the same `console.error`. **The trigger and its own noise source are created by the same step.**
5. **`docs/tacet-postgres-status.md` item 17 is stale.** It says the tool is *"BUILT ON `claude/survey-land-shipment-default-vw1hcn`, NOT MERGED"*. It merged at **`7483cb91`** and all three files are on `main`. Same class as G11 — the record lagging the world rather than the code.
6. **The health watchdog does not restart every four minutes; it latches** (`!state.down`). Repeated ~4-minute restarts mean a **flap**, not a loop, and the runbook should not describe them as the same thing. See H5.

---

# PART I — THE POINT OF NO RETURN

**The question this part answers: at what step does rolling back stop being possible?**

**REWRITTEN 2026-08-20, AND THE ANSWER CHANGED SHAPE RATHER THAN MOVING.** Until `7483cb91` this part said the flip was irreversible from its first second, because there was no way back at all. **There is one now, and it is restore-and-lose.** So the point of no return is no longer a moment when reversal becomes impossible. **It is the moment reversal stops being a rename** — and that is a different thing, reached a different way, and stated in PART H rather than guessed at here.

## There are now two clocks, and only one of them ticks

**The first is the window, and it is a decision, not a physical limit.** Rolling back stays *possible* for as long as `data/roots.db.pre-cutover` sits untouched beside a Postgres nobody drops. What it costs rises steadily — roughly one to two business rows an hour, of which about 0.7 are orders — so the window closes when hand-reconciliation stops being reasonable, at 20–40 rows, which is **one to two trading days.** **H3 sets the default at one hour anyway, for a reason that is about the decision-maker and not the data.**

**The second is the refusal, and it does not tick — it trips.** The rollback is a rename only while one side is frozen. **The moment anything writes to SQLite after the flip, both databases have moved, refusal R4 fires, and rollback becomes a two-way merge that nothing in this project can do and nothing is going to build** — §24 records the reverse copy as a rejected option with four reasons, not as unbuilt work. **This is the real point of no return, and it has no clock. It can happen in minute three.**

**So the sentence that matters is no longer "the flip is irreversible".** It is: **the flip is reversible with loss, for as long as exactly one database is moving.**

## What makes it stop being a rename

**Everything on this short list is a way of letting a second database move.**

- **A channel daemon left on SQLite.** `pm2 restart roots-v2` does not touch them (G21), and an open better-sqlite3 handle **keeps writing to the same inode after a rename** — so an unstopped daemon writes into `roots.db.pre-cutover` itself. This is why the daemons stop for the flip (§24 v4.46, decided 2026-08-20) and why R4 exists to catch it when they did not.
- **One of the ~80 loose scripts in `scripts/` that opens the database by path.** None has been audited (G13). One cron entry is enough.
- **Anything that recreates `data/roots.db` after F1 renamed it** — which is R1, and the worst of the five refusals, because it leaves two SQLite files and picking one is itself a merge.

**The drift figures make the scale concrete:** over one week `checkout_quotes` gained **23,829** rows and `guanyi_sync_log` gained **4,788**. Those tables move whether or not a customer buys anything, so **an unstopped daemon trips R4 within one poll cycle, not within one order.**

## What has to be true before crossing it

Every one of these. This list is the shortest honest form of the whole document:

1. **The code runs on both drivers** — G1, and the four pieces under it: ~~G2~~, ~~G3~~, ~~G4~~ (all closed `2961d3d`) and **G5, which is not.** The switch, the pool and the transaction backend exist; **the call sites do not**, so G1 is untouched and is still the largest single item on this list.
2. **The order counter is read by the application and seeded from live data** — G6, then step F2 in its correct position.
3. **The money guards survive the driver change** — G7 the idempotency regex, G12 the refund race.
4. **A backup exists that has been restored onto hardware where `tacet_app` does not exist** — G14.
5. **The copy is provably complete** — G17 the freeze-or-delta decision, G18 the tool, G19 the completion test.
6. **The application has been exercised end to end on Postgres by something other than a customer** — G20.
7. ~~**A rollback exists**~~ — ✅ **CLOSED. G22 built `7483cb91`, G23 decided 2026-08-20 in PART H.** The one item on this list that has moved all the way.

**Say the seventh one plainly, because it is what this draft was written to find and it is the one that changed.** The flip used to have a way on and no way off. **It now has both, and the way off is a rename that loses the window.** That does not make the other six smaller — **G1 alone is still the largest item here and nothing has ever executed against Postgres anywhere (G20)** — but it changes the character of the night from *unrecoverable* to *bounded*. **The remaining six are work. The seventh was the difference between a reversible night and an irreversible one, and it is done.**

**What has NOT changed: the flip is still gated on all six of the others.** A rollback that exists is not permission to flip. It is permission to *stop*.

---

# APPENDIX — WHAT THIS DOCUMENT DELIBERATELY DOES NOT CONTAIN

- **No timeline and no date — but a DURATION, as of v0.5.** Nothing here is being scheduled, and the cutover still has no date. **The one-hour rollback window in H3 is not a schedule; it is a bound on a decision, and it starts whenever the flip does.**
- **No resolution of any gap, with one deliberate exception.** Naming them is the job of this draft. **G23 is the exception — it was a decision rather than a build, and a decision belongs in the procedure it governs.** PART H therefore contains real steps, and §24 v4.46 owns the reasoning as usual.
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
