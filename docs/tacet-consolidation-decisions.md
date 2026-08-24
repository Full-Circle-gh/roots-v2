# Tacet shared-core consolidation — decisions record, v4.74

**2026-07-31 · A living record of what has been decided so far for the Tacet shared-core consolidation, so the decisions stop living in chat. Supersedes v0.1. The questions in §23 Open questions are NOT decided and must not be treated as settled.**

2026-08-03 · v1.0 — records the PostgreSQL database decision (§24). Note: v0.9 exists on an unmerged parallel branch (docs-glossary-stock-model-abi0fp) with different content; main skips to v1.0 to avoid a duplicate v0.9.



2026-08-24 · v4.74 — §28's vocabulary consequences are MARKED IN THE SECTIONS THEY LAND ON, not left to be discovered. v4.73 recorded the supersessions in this changelog only, where a reader who opens §21 to find out what the modules are never sees them. Eight sections now carry a marker: §1, §3, §7, §8, §17, §19, §21, §22. **Six are VOCABULARY ONLY and say so in the marker's first line** — §3's two separate lists, §7's unit model, §8's packaging-as-stock, §17's two positions, §19's category separation and §22's stage 6 are all unchanged decisions wearing a changed word, and a reader must not conclude any of them was reversed. **Two are substantive.** §1 and §21 both claim FOUR front ends including PRODUCTION; there are three, because Production is a module and no separate app will be built. §21 carries both kinds at once — ITEMS→MATERIALS is a rename, FOUR FRONT ENDS is wrong — and its marker separates them rather than letting one excuse the other. §22 item 9's deferred *"Production app merging into Tacet"* is void, not deferred, while the rest of that item stands. Nothing is deleted or rewritten: the record is a history. Docs only; no code changed.

2026-08-24 · v4.73 — the PRODUCTION MODULE is recorded as §28: Production is a module inside Tacet, not an application, and no separate Production app will be built. **MATERIALS** becomes the tenant-facing name for stocked things a tenant buys and does not sell; **Items is rejected** for colliding with Products in conversation, **Ingredients** for excluding every non-food business. The build route is to GENERALISE THE KITCHEN MACHINERY rather than rebuild on retail rails — the kitchen half already holds unit conversion and purchase-cost write-back, and retail purchasing holds neither. **Schema identifiers are NOT renamed**: `ingredients`, `ingredient_id`, `buy_unit` stay, deferred rather than cancelled, and must be their own change with a backup taken immediately before. Phase 1 is Materials and Purchases only; Recipes deferred, which is what keeps Products and the storefront out of scope. **This changes vocabulary and app structure decided earlier and edits none of it**, per the house convention: §1 Architecture and §21 Modules both name PRODUCTION as one of four front ends and ITEMS as a module, and §3, §7, §8, §17 and §19 all speak of ITEMS — a reader meeting those should read the app as a module and the word as Materials. §22's deferred *"Production app merging into Tacet"* describes a merge that now has nothing to merge. Related documents moves from §28 to §29; nothing cross-references either number. A new decision that supersedes vocabulary without reversing a rule, hence a patch.

2026-08-23 · v4.72 — §24 Database: 🔴 **THE POSTGRES MIGRATION IS CANCELLED. TACET STAYS ON SQLITE.** Ash's call, after the `.prepare` survey: **2,835 `.prepare` call sites in the runtime** (`server.js` 12 / `database.js` 228 / `routes/` 2,414 / `lib/` 175 / `middleware/` 6), **zero `.query` call sites**, **all 39 files in `routes/` affected** — and `lib/pg-handle.js` refuses `.prepare` BY DESIGN, because an adapter would hand 3,339 sites a Promise where a row is expected and the application would compute wrong answers across every route rather than crash, with a customer as the first evidence. **The 27 "converted" sites were not converted**: the wrapper moved, the 70 `tx.prepare(` statements inside it did not, so a converted block dies on its first statement exactly like an unconverted one. **Runbook B19 is superseded in place** — clearing G26 does NOT turn *"the app cannot start"* into *"the app starts and individual routes fail"*; it does not start, and every route fails on its first line. **It stopped because multi-tenancy already works** (`TENANT_DATA_ISOLATION=1`, five per-tenant files, Roots in `roots.db`) and **no measured constraint was being hit**; the cost was not proportionate. Restart conditions are stated as conditions, not as a plan. **The one path that would have worked is recorded so it is not rediscovered**: a synchronous `.query(text, params)` on the SQLite handle, convert a file at a time under real traffic, driver switch as a config change last. **All 20 open gaps CLOSED — MIGRATION CANCELLED.** ⚠ **AND THEN SCRAPPED OUTRIGHT, SAME DAY — the "retired rather than deleted" this line first carried is corrected here per rule 5, not tidied away.** **52 files deleted**, the cutover runbook, the status document and the nine schema records among them, **the `tacet` cluster dropped**, and `drift_guard.py` went with `plan.json` so **nothing now detects SQLite schema drift** (13 objects drifted in 18 days when last measured). `lib/db-seam.js`, `lib/db-transaction.js` and their suites are KEPT — live SQLite code, 28 running `withTransaction` call sites. The findings that outlive the migration are in `docs/tacet-operating-findings.md`, the write surface in `docs/tacet-write-surface.md`. See the ADDENDUM on the entry.

2026-08-23 · v4.71 — §24 Channels: **THE TUNNEL REBUILD REMOVED BLIP-TOLERANCE RATHER THAN DEGRADING THE LINK** — record as a standing property, not an incident. WireGuard/UDP is connectionless and absorbs a blip; **the SSH/TCP tunnel is a session, and the SOCKS listener on `127.0.0.1:1180` is owned by the `sshd` process itself** (`ss -lntp` PID matched the flap minute exactly), so a blip does not degrade the proxy, it deletes it. 44 re-establishments on 08-23. **The tunnel is still the right call** — the UDP path is blackholed — but everything above it must assume the listener can vanish and return. Settling: 40 in hour 11, 4 in hour 12, **0 in hours 13-14** (2 hours, not a week). **THE GZ RUNG COMPARISON AND ITS LIMIT:** same tunnel, same probe 1s apart, identical UP durations (63s, 675s) because `residentialUrl()` takes no channel argument — **0 challenges against 114**. But the stores run **different daemons on different channels**, so rung and channel are confounded; giving yuexiu the rung is the experiment that separates them. **THE HOLDERS HAVE NO RELAUNCH DEBOUNCE AT ALL** — searched `shangou-chrome.js` and `browser-warmup.js`: no cooldown, no minimum interval, no rate cap. **The watchdog threshold is the only guard in the chain and it guards one direction.** That is the more serious half. **`UP_THRESHOLD = 4` rests on TWO complete UP periods (63s, 675s)** — sample stated beside the number; re-derive from a week.

2026-08-23 · v4.70 — §24 Ops: **TWO TRAPS FOUND LOOKING FOR AN OFF SWITCH, neither specific to 闪购.** 🔴 **`pm2 stop` is not durable on this box** — read from pm2's source, `God.restartProcessId` falls through to `startProcessId` when a process is not online, and `bounce_daemon` runs `pm2 restart` on any `lib/*` change, **so a hand-stopped daemon returns on the next shared deploy** — within hours at 48 deploys per two days. Use `pm2 delete` or a config gate. ⚠️ **`SHANGOU_STORES=` empty does not disable anything**: `('' || 'yuexiu')` falls back, and the only value yielding an empty list is a **bare comma**. A flag whose obvious value is a no-op and whose working value is punctuation. §24 **AN INSTRUMENT CAN BE RIGHT AND UNREAD**: `isColdStartChallenge` printed the correct diagnosis 113 times — *right after a browser relaunch, session intact* — and nobody walked one step further to ask why the browser was relaunching. Not a missing detector; a correct one read as noise, partly because its own message ends *no action needed*, true of the session and silent about the cause.

2026-08-23 · v4.69 — §24 Channels: 🔴 **THE 闪购 CHALLENGES ARE A PROXY FLAP, NOT A BROWSER CRASH.** `shangou-chrome` logs `proxy switch — relaunching Chrome`: the residential tunnel flaps, `proxy-watchdog` fails the channel over, Chrome's proxy is a launch argument so the holder relaunches, the fresh browser hits 闪购 cold and 风控 answers 418. **`isColdStartChallenge` had been saying so all along.** **Why Yuexiu and not Tianhe:** tianhe falls back residential→**GZ datacenter**→direct and stays on a Guangzhou IP; **yuexiu has no middle rung and lands on direct — a Hong Kong IP**, a Guangzhou store suddenly calling from abroad. **The hysteresis is one-sided** — `FAIL_THRESHOLD=2` to go DOWN but **UP on the first success** — so a marginal tunnel oscillates: 4 transitions in 11 minutes, each relaunching 2 browsers. Its own comment names the harm it half-prevents, *thrashing browser relaunches*. Rare for 2 months, **resumes 08-22 12:00**, 11 switches today. **Persisting `verifyState` fixes 23 of 113; this is the other 90** — and a persistent back-off alone would have made a flapping tunnel look like a permanently quiet channel.

2026-08-23 · v4.68 — §24 Channels: 🔴 **DEPLOYS TRIGGER 闪购 RISK-CONTROL CHALLENGES.** `verifyState` in `shangou-daemon.js` is in-memory, so a restart discards an active back-off. **23 of 113 challenges land within 60s of a daemon start, every one at 0—2 seconds.** With 48 deploys in two days **the 30→60→120→240 ladder can never reach its cap** — Yuexiu reset to 30 min four times in two hours on 08-23, while on 08-22 left alone it sat at the 4-hour cap. **The log undercounts it 6×**: `noteVerifyResult` gates its DB write behind the `verifyFlagged` log-once latch, so 113 challenges became 19 rows — **a dedupe latch on the alert silently became a dedupe latch on the record.** **And the asymmetry is backwards**: alert latches are on disk and survive, the back-off that protects the channel does not. Same `verifyState` shape in `meituan-daemon.js` and `qingyun-daemon.js`; none in guanyi/gzgrocery. **NOT FIXED — its own pass**; an unreadable store must read as STILL COOLING DOWN. §24 **DELAYED, NOT LOST is verified**: 3-day sweep windows, no persisted cursor, explicit `INSERT OR IGNORE` dedupe — a 35s bounce is 7,400× inside the window; only the 30-minute sweep timers restart their clock. §24 **I PRESENTED SELECTED HOURS AS THE MEASUREMENT** — hand-picked 16 of 24 rows into a deploy-window table and wrote real zeros as dashes, so omissions and zeros were indistinguishable to the person choosing when to take the storefront down. **A table with a row missing is not a shorter table, it is a different claim.**

2026-08-23 · v4.67 — §24 Database: **THE 48 RESTARTS WERE 48 DEPLOYS, EXACTLY.** 1369→1417 since the 08-21 alerting deploy; 48 deploys in the same window (35 on 08-22, 13 on 08-23); `deploy-apply.sh` restarts the app unconditionally at step 5/5. **`unstable_restarts` is 0 over the process's lifetime, so not one of the 1417 was a crash.** **THE STRICTER 08-21 PROBE HAS NEVER FAILED ONCE** — the last `probe FAILED` line of any kind is **2026-07-13**, six weeks ago, and none carries the `[probeDetail]` bracket the new probe prints; zero `storefront DOWN` lines have ever been written. **`HEALTH_FAILS` 2→3 stays untouched.** A restart counter is a poor smoke alarm on a box that ships thirty times a day. **TWO NEW RULES:** *A CHANGE-DETECTOR CANNOT SEE A FAULT PRESENT AT STARTUP* — two of the four fallbacks read green from tick one, and a loop that compares each minute to the last can never see a value that was wrong before it started; and *A SHAPE-BASED SWEEP ONLY FINDS SHAPES* — thirteen fallback shapes swept and cross-checked still missed `$(( $(cat file) + 1 ))`, because bash's coercion of empty to 0 is a default nobody wrote and nothing can grep for. The sweep was extended to implicit defaults; **a method's silence is not evidence.**

2026-08-23 · v4.66 — §24 Database: ✅ **G27 CLOSED** `loadEnv()` extracted from `server.js` to **`lib/load-env.js`**. **Not a shell wrapper: `.env` is not shell-sourceable, and line 63's unquoted `<` makes `set -a; . .env` fail as a REDIRECTION part-way down** — a partial environment passes `lib/pg`'s check while a variable the caller needed is silently absent. **The gap under-counted itself: FIVE scripts, not three**, found by two independent methods. **Server behaviour proven identical over 15 adversarial `.env` bodies**, not assumed. **The delta report's exit codes were rebuilt with it, because closing G27 alone would have left the worse half standing** — it had ONE exit path, so a missing `.env`, a dead pool and an absent pre-flip database were the same answer, **and a real delta exited 0 exactly like a clean window.** Now 0/1/2 = clean / real delta / could-not-run. **`lib/platform-alert.js` was never exposed** (one importer, in-process) but has the OTHER defect: an unset webhook reads as *off* rather than *cannot tell*. **And the local harness could not reproduce G27's cause at all** — no `pg`, no sqlite bindings — so the box exit codes still need re-measuring. **PART H's fallbacks swept and fixed:** three had operators to find, **a fourth had none** — `$(( $(cat flip-offset) + 1 ))` defaults through bash arithmetic on an empty string. **They failed in OPPOSITE directions** — the offset default went RED on tick one, the two `2>/dev/null` swallows read a missing log as GREEN forever. **The loop's own rule (byte-for-byte identical) detects CHANGE, so a value already wrong at the start is invisible to it.** **And my first fix for the producer was wrong**: `wc -c < LOG > FILE` does not zero the target, it leaves a STALE offset untouched — numeric, plausible, and passed by my own is-it-a-number check. It deletes first now. §24 A SCAN OF SCHEMA CANNOT SEE A SECRET HELD AS A ROW: 57 candidate columns, none of the 13 keys.

2026-08-23 · v4.65 — §24 Database: **COPYING PRODUCTION DATA COPIES ITS OUTBOUND CHANNELS — NOW STRUCTURAL, NOT REMEMBERED.** `scripts/make_safe_db_copy.sh` is the only sanctioned way to copy `roots.db`: online `.backup`, severs every channel, **verifies and DELETES the copy if anything survived**. **The webhook was not the worst thing it carried** — the ORDER-group webhook, the Aliyun SMS secret (against 1,305 stored phone numbers), the Feie printer ukey, JD and KD100 courier credentials, 3,874 live auth tokens, a real push endpoint. **The cut is credentials and endpoints, not data**, so the copy stays useful. **And note how the webhook hid: it is a ROW in `storefront_config`, not a column** — a schema scan found 57 candidate columns and missed all 13 keys that mattered. **`/root/ops-alert.conf` mirrors the alert destination** outside the deploy tree (not under `public/`, which is served at `/assets`), 0600, atomic, written on every successful database read so a fresh box heals at boot. Five states red-proven **against a safe copy, per the rule above**; absent falls back and says so, absent-plus-renamed-database is the third state. Option (3) recorded as its expiry. **THE TWO UNTRACKED CRON SCRIPTS ARE UNTRACKED ON PURPOSE AND §24 ALREADY SAID SO** — committing them would move them off the path cron calls and make every backup tweak bounce the storefront. **The real gap is no off-box copy and nothing noticing if they stop** — and the class has NO detector, because `diagnose_deployed_tree.js` asks about the deploy tree and `/root/scripts` is outside the question. **AND EVERY RUNBOOK SAVE/RESTORE PAIR WAS AUDITED:** the crontab now verifies with `diff` (catching a mid-window edit a blind restore would discard); `.env.pre-cutover` is an ORPHANED SAVE nothing restores; and **H4's loop does `cat /root/flip-offset 2>/dev/null || echo 1`, so a missing offset silently becomes 1, T2 reads the whole log, and the trigger is RED ON ITS FIRST TICK for the wrong reason.** That last one is this session's own anti-pattern in three characters of shell.

2026-08-23 · v4.64 — §24 Database: **WIDENING THE HEALTH PROBE CREATED A CUTOVER HAZARD IN THE SAME PASS, AND "STOP THE DAEMONS" HAS NEVER MEANT THE CRON JOBS.** `health-watchdog` runs from **root's crontab, not pm2**, so G22 never touched it — and from F1 the app's routes fail by design, so ~4 minutes in it would `pm2 restart roots-v2`: back onto SQLite with the database renamed away, before G2, **adding a restart to the count H5 uses to tell a flap from a crash**, and paging about it through an `ops-alert` that cannot read the renamed file. **One restart, not a loop** (`!state.down`). **Runbook F0 disables it before F1, G9 restores it after, H8 row 3b restores it on the ROLLBACK path** — a rollback that leaves monitoring off is worse than the flip that turned it off. **The scheduling space was closed, not sampled**: root + user crontabs, /etc/crontab, /etc/cron.d, cron.{hourly,daily,weekly,monthly}, systemd timers, `at`, and pm2's own `cron_restart` (zero) — **four project jobs, two of them in `/root/scripts/` outside the deploy tree and untracked.** **AND RECORDED AS WHAT IT DID: the old watchdog did not merely miss a dead app, it sent ✅ RECOVERED and cleared `down`** against an app 500ing on every route — it closed a live incident and destroyed the evidence there was one. Restart sensitivity rose with the fix; `HEALTH_FAILS` 2→3 is the knob and is **deliberately not turned yet**. **`ops-alert` now revalidates its handle by inode** (one stat per call, unmeasurable beside an HTTPS POST) — red-proven, and the OLD build proved itself by *succeeding*: it delivered an alert read from a file no longer at that path. ⚠️ **That proof sent three real messages to the ops WeCom group** — the harness copied the live database and inherited its webhook; recorded so the next harness neuters it first. **And the write path is now checked by OBSERVING a write rather than making one** — `scripts/check_sync_freshness.js`, N=15 min from a measured 133 s worst gap, exit 2 when it cannot read, in H4's slow loop and deliberately NOT in the watchdog, because a standing check cannot know that 闪购 is quiet after 20:15 by design.

2026-08-23 · v4.63 — §24 Database: **THE OBSERVATION LAYER REPORTED CANNOT-SEE AS A BENIGN STATE, IN ALL THREE INSTRUMENTS THE NIGHT DEPENDS ON.** **`ops-alert` said *alerts disabled* when the database was unreadable** — wrong, not just unhelpful: it sends the reader to Settings. Now three states, and after an F1-style rename it says **CANNOT READ ALERT CONFIG … NOBODY WAS PAGED**. **`alert-latch`'s read path reintroduced the exact bug the file exists to stop** — `existsSync` conflates *absent* with *unreadable*, so an unreadable latch dir read CLEAR and the recovery ✅ was swallowed, which is the 2026-07-25 闪购 failure via the error path. Now `statSync` with `throwIfNoEntry:false`, and cannot-see fails towards **STILL LATCHED**. **And `health-watchdog` did not merely miss a dead app — it CLOSED THE INCIDENT**: given `state.down=true` and an app answering 500 on every route, `res.status > 0` made it send **✅ storefront RECOVERED** and write `{fails:0, down:false}`. Red-proven old-vs-new for all three. The replacement probe is `deploy-apply.sh`'s, taken verbatim — **which is the lesson: the strictest assertion in the tree was already written and was only running at ship time, while the thing that runs every two minutes accepted anything.** **HAZARD RECORDED: after F1 alerting fails PARTIALLY** — a cached fd survives a rename, so processes started before the rename keep paging and ones started after go silent, **and arriving alerts read as a working channel**. Cost of making it uniform reported, not applied. **AND `.env` IS NOT SHELL-SOURCEABLE** — line 63's unquoted `<` aborts the source, so lines 1-62 load and the four `TACET_PG_*` on 91-94 do not; the obvious G27 wrapper fails partially and silently. **Plus 14 stale files deleted from the box, 4 of them publicly fetchable over HTTPS for months** (2.14 MB of admin front-end, no credentials — verified by extracting the matches, not counting them).

2026-08-21 · v4.62 — §24 Database: **THE DETECTOR FOR THE BOX'S DRIFT HAD ITSELF DRIFTED, AND IT WAS MOST OF THE NOISE.** `diagnose_deployed_tree.js`'s manifest was 77 commits stale. Regenerated at `cfaefd77`: **88 DIFFER → 0, 122 EXTRA → 15, 1 MISSING → 0, 394 match → 586, verdict PASS.** **EVERY ONE of the 88 was the detector; NONE was the box** — the deployed tree is exactly the repository. ⚠️ **AND THIS ENTRY FIRST CLAIMED 17 REAL DIFFERENCES, FROM A MANIFEST REGENERATED AT A LOCAL `HEAD` THAT WAS 101 COMMITS BEHIND `main`.** Files newer than my reference read as production drift. Corrected within the hour and left visible: **a stale reference does not announce itself as stale, it announces itself as a finding** — which is the same failure this pass was about, committed in the pass about it. **ITEM 24 HAS A DETECTOR AFTER ALL** — the brief assumed nothing flagged box-only files and that was wrong: the `EXTRA` category has always existed, already separates residue from drift from installer-rewritten, and its header already names the cause. **No code was needed.** So why did `copy_order.json` sit there? **`EXTRA` never fails by design, and NOTHING RUNS THE TOOL** — `ro-query.yml` is `workflow_dispatch` only, no cron, no timer, all three verified. **Detected, unenforced, unscheduled.** **AND THE GENERATED BLOCK HAD A RECIPE, NOT A GENERATOR:** the shell one-liner in its header covers `MANIFEST` and not `MANIFEST_COMMIT` or `MANIFEST_SW_NORMALIZED`, so two of three values were hand-maintained — which is the step that gets skipped. Committing a real generator is still owed and is not free, because a new `scripts/` file is itself deployable. **Two standing rules recorded: check `.gitattributes` before editing and never let a tool normalise on write** (five incidents now; the latest turned a 98-line change into 295/295 and falsified a README line in the same commit), and **a sort that iterates a set varies ACROSS PROCESSES ONLY**, so it passes every in-process test — `PYTHONHASHSEED` at two values plus a fresh process is the proof that catches it.

2026-08-21 · v4.61 — §24 Database: **`copy_order.json` IS DELETED AND THE COPY ORDER IS DERIVED AT RUN TIME — ITEM 59 CLOSED BY REMOVING THE ARTEFACT, NOT BY GUARDING IT.** The file could only be wrong by OMISSION, and omission meant a table truncated and never refilled. Against that it bought almost nothing: **162 of 164 positions were free, the widest tie was 67 tables, and 51 tables appear in no foreign key at all** — **the order was about 2% graph and 98% tie-break.** `run.py` `derive_copy_order()` now takes membership from `plan["tables"]`, constraint from SQLite's declared foreign keys, and an alphabetical tie-break for the rest. **The tie-break is recorded as ARBITRARY BUT STABLE and must not be called "the foreign-key order"** — it fixes 162 of the 164 positions and the graph fixes 2. **Determinism proven four ways** — twice in one process, once fresh, twice more under different `PYTHONHASHSEED` values — all byte-identical, because the obvious set-iterating implementation varies across processes only and would pass every in-process test. **Guard checks 5 and 6 removed with the artefact they guarded**, and the coverage block says so in those terms. `run.py` writes **`copy_order_used.json`**, preserving the one real thing the file was — a record of the order a run actually used — on the output side where it cannot drift. **VERIFIED NEGATIVE, RECORDED BECAUSE NOBODY WILL RE-DERIVE IT: SQLite's and Postgres's foreign-key graphs are IDENTICAL** — 145 edges each, set-compared in both directions with implicit-PK forms resolved, **zero differences either way**. That is what licenses reading the source instead of the cluster. **AND `verify.py` NOW DISCLOSES ITS OWN SCOPE**: it still shares the copier's map and still cannot detect its own blind spot, but its number no longer reads as total coverage — it prints what it examined and what it did not, separates a blind spot from the caller's own scoping, and says **NOT A CLEAN BILL OF HEALTH** in those terms when the map misses something. **Rehearsed clean: 164 tables, 99s, `run.py` 0, `checks.py` 0 with all three verdicts, `final.py` 0, `verify.py` 4,232,730 cells with 7 differences, all live trading.**

2026-08-21 · v4.60 — §24 Database: **THE COPY LADDER NOW EXITS CLEAN, AND THE GUARD COVERS THE HOLE THAT WOULD HAVE EMPTIED A TABLE AND NEVER REFILLED IT.** **`drift_guard.py` did not compare `plan.json` against `copy_order.json`** — and `run.py` truncates from the first and loads from the second, so a table in one and missing from the other is **emptied and never refilled while every source check passes.** Now guarded in three directions (missing, unplanned, duplicated), red-proven in five and restored to green after each. **ITEM 54 CLOSED BY DELETION, NOT BY GUARDING:** `run.py`'s `todo` no longer reads `plan["rows"]` at all — it copies every table in the order, unconditionally, which is safe precisely because the guard proves the three lists agree. Proven by forcing `waste_entries` to `rows: 0` and watching it copy anyway. **ITEM 55 CLOSED:** `overrides.py` derives each rule's expectation from **the rule's own condition in SQL against the source**, re-read every run, so `updated_by_null` reports `fired 2 (expected 2)` instead of aborting against a 2026-08-03 constant. **`run.py` NOW EXITS 0 ON A CLEAN COPY** — every prior run this session exited 1 after the truncate and after the copy completed, which is a run that looks failed and is not. **`volume.py` reads the LIVE schema**, so `wide_cols.json` cannot miss a base64 column the census never saw; red-proven by hiding `supplier_documents.data` from `cols[]` and watching it be found anyway. **THE CLEAN REHEARSAL: 164 tables, 99s, `run.py` 0, `setseq.py` 0, `checks.py` 0 WITH ALL THREE VERDICTS PASSED** (145/145 foreign keys; **1,582,020 CJK characters identical on both sides**; all 14 wide columns byte-identical), **`final.py` 0 with zero uncopied tables**, and `verify.py` 4,231,782 cells with 15 differences, all live trading. **AND THE RULE THIS SESSION'S BIGGEST FINDING GENERALISES TO, now recorded beside the scan-count and names-as-data rules: A VERIFIER THAT SHARES THE COPIER'S MAP CANNOT AUDIT THE MAP.** A high cell count is not coverage — 4.2 million cells and eleven blind columns were the same run.

2026-08-21 · v4.59 — §24 Database: **THE COPY WAS TAKING ITS SHAPE FROM A 2026-08-03 CENSUS AND ITS CONTENTS FROM LIVE SQLITE, AND THIRTEEN OBJECTS HAD FALLEN THROUGH THE GAP BETWEEN THE TWO.** Two tables and eleven columns existed in the source and **did not exist in Postgres at all** — not copied as NULL, ABSENT. **`verify.py` could not catch it because it builds its comparison from the same `cols[]` `gen.py` builds its SELECT from**: the round-trip reported `retail_orders` OK at 120,546 cells while two of its columns were never looked at. **A verifier that shares the copier's map cannot audit the map.** **THE RATE IS THE FINDING** — one object every 1.4 days since the census, and `push_optouts` arrived DURING this session in `626cc802`. So the fix is a guard, not a patch: **`drift_guard.py` refuses the copy on any table-or-column difference and `run.py` calls it as the first statement of `main()`, before the TRUNCATE** — exit 1 on drift, **exit 2 when it cannot see the source**, red-proven at 13 before being made green at 0. **All thirteen applied and proven end to end:** 165 tables, copy re-run at **131 tables** (was 129) in 91.3s with zero load errors, all 11 columns matching their source non-null counts, round-trip on the five affected tables **25,394 cells and 0 differences**, and `ingredients` now comparing 25 columns where it compared 24. **`line_price` took `numeric(14,6)` and holds `4.558820`** — cents would have rounded it to 4.56, which is v3.0's reversal applied rather than re-learned. **WHAT IT DOES NOT CLOSE, SAID PLAINLY: the guard covers tables and columns, NOT row counts.** `run.py`'s `todo` still filters on the census's `rows > 0`, and the two new tables copy only because that figure was set from today's count by hand. `copy_order.json`, `overrides.py` and `volume.py` remain census-shaped too. The class is now loud, not empty.

2026-08-21 · v4.58 — §24 Database: **E2 REHEARSED END TO END FOR THE FIRST TIME, AND IT WORKS — 129 TABLES, 475,746 ROWS, 89.5 SECONDS, ZERO LOAD ERRORS.** Run against the renamed cluster from a directory proven byte-identical to the committed tree by md5 on all 24 files. **`verify.py` compared 4,220,046 cells and found 34 differences, every one live trading**, and **`checks.py` verdict 3 PASSES OUTRIGHT** — 2,452 wide base64 values byte-identical by SHA-256, the check that could only ever fail against a stale copy. **Verdict 2 fails on 5 columns and 112 characters, and `verify.py` independently found the same two rows** — a courier scan four minutes after their tables copied. **Two instruments, same rows: that is what drift looks like, and a copy error looks nothing like it.** **TWO FINDINGS THE REHEARSAL PRODUCED, NEITHER VISIBLE ANY OTHER WAY. (1) `run.py` picks what to copy from `plan.json`s 2026-08-03 SURVEY counts, not from the source, so a table empty then and non-empty now is SKIPPED IN SILENCE** — 33 tables carry `rows == 0` and one, `eleme_sync_queue`, now holds a row; **`final.py` is the only thing in the ladder that caught it**, which is worth noting about a script nearly written off as unrunnable. **(2) `overrides.py`s EXPECTED counts are a 2026-08-03 measurement and have moved** — `updated_by_null` fired 2 against an expected 4 because two `storefront_config` rows have since been edited by a real user, and `run.py` aborts on that **after the TRUNCATE and after the copy completed**: a run that looks failed and is not. **Timing: 30.5% more rows for 9.3% more time than 2026-08-06**, 4,817 → 5,750 rows/s. **ALSO: `copy_order.json` held twelve stale names and blocked E2 entirely** — a `KeyError` before the first `psql`, so it failed closed. **That is the THIRD name-held-as-data to escape a code scan this session**, after `CONTROL_PLANE_TABLES` and the archived `sequences.json`, and it is now a rule: A NAME HELD AS DATA IS INVISIBLE TO A SCAN OF CODE. Enumeration closed rather than sampled: **99 committed data files repo-wide, 11 hold any of the 28 names.** **The commit-set rule is corrected from a pair to at least three files.** Plus: `retail_order_counters` recorded as the sole copy of itself, and the `[skip deploy]` guidance sharpened into a rule with two options, neither of which is the token.

2026-08-21 · v4.57 — §24 Database: **G28 IS CLOSED IN THE TWO DOCUMENTS THAT STILL SAID OTHERWISE, AND A DEAD MONEY RULE IS MARKED IN THE SEVEN PLACES IT WAS STILL READING AS LIVE.** **G28 closed** in the cutover runbook (v0.8) and the status doc (v2.2): gap index row struck, `B21` rewritten from a stop into a closure, and **the `G26 AND G28 CLOSE TOGETHER OR NOT AT ALL` pairing retired in all three places it appeared** — it was the reason not to clear G26, and it is no longer true. **Open gaps 22 → 21 of 28, fifteen of them still in PART B.** **THE MONEY SWEEP FOUND SEVEN, NOT ONE.** §0 Governing rules → Database was the one asked for, and it is the worst of them because it sits in a LOCKED list. The other six: §24's head NOTE (*101 REAL money columns were converted to integer cents*), the rehearsal's conversion rule (*REAL yuan converts to bigint cents*), **Money precision — DECIDED** (*whole cents remains correct for transaction amounts*), the 2026-08-05 scanner FINDING's *money columns (all CENTS)* header, the `expense_entries.amount` line already superseded at v3.0 but carrying no inline mark, and **the entire premise of THE MONEY-UNIT GAP AND THE BOUNDARY LAYER** — which describes a 100-fold display defect that the decimal reversal dissolved, and which was the most dangerous of the seven because it reads as an open defect owing a boundary layer. **Every one is marked, not edited.** **AND THE SWEEP WAS SETTLED AGAINST THE CLUSTER RATHER THAN THE PROSE:** 101 money columns are `numeric(14,6)`, **zero are bigint**, and the only integer-cents columns left are the four literally named `*_cents` on the billing tables, which §24 already records as deliberate. The runbook states whole cents nowhere at all. **Also recorded: EVERY MIGRATION-SCRIPT EDIT RESTARTS THE WHOLE BACKEND** — see A `scripts/` FILE THE APPLICATION NEVER LOADS STILL RESTARTS IT. **AND THE `[skip deploy]` DEFERRAL TAKEN WITH v4.56 WAS OVERTAKEN SEVENTEEN MINUTES LATER** by somebody else's push, which carried its six files out. Not a bug: the diff base is the server's `last-success-sha`, so a skipped run leaves its files pending for the next deploy by anyone. **The token defers a RUN, not a FILE.** The six shipped together and the box is consistent; a two-commit split would have shipped half. See `[skip deploy]` DEFERS A RUN, NOT A FILE.

2026-08-21 · v4.56 — §24 Database: **THE TENANT→ACCOUNT PHYSICAL RENAME IS DECLINED, AND WHAT ENDED IT WAS ITS OWN JUSTIFICATION EXPIRING, NOT ANYBODY CHANGING THEIR MIND.** Clause (b) of DONE IN THE SAME REBUILD bundled the rename into the Postgres rebuild on a stated efficiency premise — *"because the tables are being rebuilt anyway and a separate migration would touch everything twice."* **The rebuild landed on ONE SIDE ONLY.** The schema was renamed with the copy; the application never was, and G28 recorded the result. **That inverts the premise**: carrying the rename forward now means touching everything twice, and declining it means touching nothing. **74 objects renamed back to `tenant*` on the live cluster in ONE TRANSACTION — 12 tables, 25 columns, 4 standalone indexes, 8 sequences, 25 constraint NAMES — and not one application file was opened.** `lib/`, `routes/`, `middleware/`, `server.js` and `database.js` are untouched by diff, which is the entire point: `CONTROL_PLANE_TABLES` in `lib/tenant-db.js` holds five of the twelve names as STRING DATA, invisible to every static scan and absent from every count of this gap, and it stays correct only because nothing edited it. **THIS DOES NOT REVERSE THE VOCABULARY DECISION** — the word stays retired in prose, and the glossary TENANT entry always allowed the physical name to survive; it is amended to say the survival is permanent rather than pending a rebuild. **THE GAP GOES TO ZERO, AND THE HEADLINE FIGURE FOR IT WAS NEVER A STATEMENT COUNT.** An AST count over the runtime tree — string literals and template quasis only, so comments cannot inflate it — gives **248 SQL statements across 24 files, 258 table-occurrences**, against zero naming an `account*` table. **G28's recorded 266 is the SUM OF ITS OWN PER-TABLE COLUMN** (104+81+19+13+13+7+6+6+5+4+4+4), so a statement joining two renamed tables is counted twice in it; it is an occurrence sum labelled as statements. **And its file count of 23 is one low: it is 24.** **A SECOND SUPERSESSION FOUND WHILE MARKING THE FIRST.** Clause (a) of the same sentence — money as whole cents — has been dead since v2.0 on 2026-08-05 and carried NO marker, so it has read as a live rule for sixteen days. Marked now. **The identical line survives unmarked in §0 Governing rules under Database, where it sits in a LOCKED list and is read more often than §24 is** — recorded here, not edited there, because §0 was not in scope. **THREE THINGS THE RENAME BROKE THAT ARE NOT APPLICATION CODE, ALL THREE FIXED IN THE SAME COMMIT AS `plan.json`.** `run.py` held a hardcoded `accounts` in the sanity query it runs immediately AFTER its `TRUNCATE` — cutover step E2 would have aborted at `sys.exit(3)` with the target already emptied; it now resolves the five rehearsal tables through `plan.json`. `drift.sh` had the same literal. `final.py` keyed its `PRE` dict on `"accounts_id_seq"`, which resolved to `None` and printed blank rather than mismatched — reading like a pass, the same failure shape as the exit code this work repaired in `checks.py`. **THE DEPLOY IS DEFERRED** behind a `[skip deploy]` token on the scripts commit’s subject, which is why that commit is HEAD: CI reads `git log -1 --pretty=%s` and nothing else. **`plan.json` and `run.py` must never ship separately** — old+old fails closed on the `TRUNCATE`, but new `plan.json` with old `run.py` empties the target and then dies. **And SEVEN scripts read the plan name map, not the four anybody had listed** — `run.py`, `setseq.py` and `verify.py` as well as `gen.py`, `checks.py`, `preflight.py` and `final.py`. Full entry in §24 THE TENANT→ACCOUNT PHYSICAL RENAME IS DECLINED.

2026-08-21 · v4.55 — §24 Database: **G26 AND G28 ARE THE SAME TEN FILES, NOT TWO GAPS TO SEQUENCE — AND THE COUNT UNDER G26 WAS WRONG FOR THE SEVENTH TIME.** Surveying what the G26 move would actually cost turned up all three of the things below, none of which was visible from the gap list. **(1) THE COUNT IS 24 TABLES AND 15 INDEXES, NOT 19 AND 10 — AND THE CAUSE MATTERS MORE THAN THE NUMBER.** The original figure came from an extractor that searched a fixed window for each template literal's closing `` `); `` and, **when it could not find one, fell back to reading a fixed 400-character slice rather than failing.** `routes/backend-auth.js:32` is a **98-line block creating SIX tables** — `tenants`, `tenant_users`, `tenant_user_caps`, `tenant_user_stores`, `tenant_domains`, `tenant_user_sessions` — and the fallback read its first 400 characters and reported one. **Five tables and five indexes went missing, and the number looked plausible enough to merge into three documents.** **THIS IS THE SAME FAMILY AS v4.54's RULE**: an instrument that meets a condition it cannot handle and **degrades to a smaller answer instead of to an error**. A check that cannot run passing silently and a scan that cannot parse truncating silently are one failure with two faces, and **under-reporting is the dangerous direction, because a count that comes back low reads as good news.** **A scan that cannot find a block's end must fail loudly, never truncate.** **SEVENTH IN THIS PROJECT**, after the `grep`-vs-AST transaction counts, the `sqlite_sequence` line pins, the requiring-file population, the non-merge commit total, the first by-day value, and the AST authority's own ten-block hole from an unparsed `database.js` (v4.47). **A count is a measurement; state the instrument and check its failure mode before quoting the number.** Corrected in the runbook (B19 ×3, header banner) and status item 48. **(2) THE DDL AS WRITTEN COULD NOT RUN AGAINST POSTGRES IN ITS CURRENT ORDER EVEN IF EVERY DIALECT PROBLEM WERE FIXED — AN ARGUMENT FOR SKIP-ON-PG THAT IS INDEPENDENT OF THE TABLES ALREADY EXISTING THERE.** The eleven blocks carry **five cross-block foreign-key constraints and every one points at the same block**, `routes/backend-auth.js:32` — a star, not a graph, trivially satisfiable in one ordered file. **But the current load order does not satisfy it.** `lib/tenant-creds.js` creates `tenant_secrets REFERENCES tenants` at **`server.js:284`**, and `tenants` is not created until **`server.js:348`** — **64 lines of require-order later.** **It works only because SQLite accepts a foreign key naming a table that does not exist yet and resolves it at DML time. That is leniency, not absence of enforcement: `database.js:50` sets `db.pragma('foreign_keys = ON')`.** **Postgres rejects the same statement at `CREATE TABLE`.** So **moving the eleven into `database.js` in dependency order repairs an ordering that is wrong today and has simply never been enforced** — the move is not only a driver-awareness change, it is a correctness fix that happens to be free. **(3) G26 AND G28 ARE THE SAME TEN FILES, AND THIS IS BETTER NEWS THAN THE RECORD DESCRIBED.** **All 12 tables the copy renamed are created by these eleven blocks and by nothing else in the tree**: `tenants`, `tenant_users`, `tenant_user_caps`, `tenant_user_stores`, `tenant_domains`, `tenant_user_sessions` (`backend-auth.js:32`), `tenant_user_codes`, `tenant_operator_push_subs` (`:207`), `tenant_secrets` (`tenant-creds.js:34`), `tenant_integrations` (`integrations/registry.js:29`), `tenant_signup_requests` (`backend-signup.js:27`), `tenant_onboarding` (`saas-admin.js:33`). The eleven create 24 tables, so **the split is exactly half — 12 renamed, 12 keeping their name.** **The record said the two gaps "close together or not at all", which was true and understated it. They are not two gaps that interact; they are one job.** Whoever moves the DDL into `database.js` is already editing every file that holds G28's 266 renamed-table statements, so **the rename decision can be taken and applied in the same pass rather than scheduled after it.** Both gap entries updated to say so. **WHAT THE MOVE COSTS, MEASURED RATHER THAN ESTIMATED.** **351 lines of pure DDL**, all eleven blocks static — **zero template interpolation, zero local constants, zero seed rows**, so nothing depends on where it currently sits and the move is mechanical. `database.js` goes **4,828 → 5,179 lines (+7.3%), 106 → 130 `CREATE TABLE`**. **No circular require**: `database.js` requires only better-sqlite3, path, fs and `lib/db-driver`, and the ten files keep their `seam(require('../database'))` untouched. **ONE BEHAVIOUR CHANGE, RECORDED SO IT IS NOT DISCOVERED**: today `backend-auth`'s six tables are created only in processes that require that route — the server. In `database.js` they would run in **all 97 files that require it, including the six channel daemons and ~47 scripts.** Idempotent and microseconds, but on a fresh box a daemon starting first would create the entire backend schema. Arguably better, since the schema then converges regardless of which process wins the race — but it is a change, not a no-op. Minor and non-blocking: **`routes/store-admin.js` uses a bare `require('../database')` where the other nine use `seam(...)`**; worth normalising if the file is being edited anyway. A count corrected, an ordering defect found, two gaps merged into one job; **nothing built and no application code changed — the shape of the combined G26+G28 work is Ash's to decide** — and a patch.

2026-08-21 · v4.54 — §24 Database: **4.57 GB OF AD-HOC DATABASE COPIES REMOVED — 6.3 GB FREE → 10.78 GB, 84% → 71% — AND THE RULE THAT CAME OUT OF BUILDING THE TOOL MATTERS MORE THAN THE SPACE.** Removed: five uncompressed ~670 MB `data/roots-pre-*.db` snapshots from the 2026-08-18/19 repair work, and `/tmp/repair` + `/tmp/mc_survey` (~0.65 GB each). All six preflight checks passed. Verified after: the five and both directories gone, **`data/roots.db` intact at 0.66 GB, BOTH undo files intact** — `undo-repair-sweep-cancel-1787050794887.json` and `backfill_migration_credit_ledger.undo.json`, which the whole removal argument rests on — and the retention tiers untouched at 30 daily / 12 hourly / 16 GB. **THE ARGUMENT FOR REMOVING THEM IS IN THE SCRIPT'S OWN HEADER, NOT ONLY HERE**, because a deletion taken by decision rather than by a retention rule needs its reasoning to travel with the tool: the repairs carry targeted undo files with prior values and checksums; both invariant checkers pass on the current state (`ALL 10 INVARIANTS PASSED`, `ALL CHECKS PASSED`, verified against an hourly snapshot rather than the live file); and **an uncompressed copy of a database that is already in the backup tiers is not a safety net** — `daily/roots-20260817.db.gz` predates all five, compressed and under retention. ⚠️**One qualification recorded rather than glossed: there are FIVE snapshot points and TWO undo files.** `unit-fix`, `free-flag` and `rows100-521` have no named undo, so they rest on the dated dailies alone — **and daily retention is 30 days, so `roots-20260817.db.gz` rolls off around 2026-09-16 and the off-site tier keeps only 14.** After that the pre-repair state for those three is gone. **THE NEW DEADLINE IS A RANGE, NOT A DATE, AND THE HONEST ANSWER IS THAT THE DATABASE HAS STOPPED GROWING.** Measured 2026-08-21 09:18 CST: **26.43 GB used, 10.78 GB free, 37.20 GB usable, 71.0%**; headroom to `MIN_FREE_MB=2048` is **8.78 GB**. The rate depends entirely on which window you measure: **29-day average 6.76 MB/day → 294 MB/day → ~2026-09-21**; **mid 4.8 MB/day → 209 MB/day → ~2026-10-03**; **last seven days 0.61 MB/day → 27 MB/day → 2027**. **The 29-day figure is inflated by step changes on 08-07 and 08-08 (316→375→403 MB) that look like a bulk import, not organic growth — the last four dailies are 439.3, 439.1, 439.3, 440.0 MB, essentially flat.** **PLAN AGAINST ~2026-09-21 AND TREAT ~2026-10-02 AS THE MID ESTIMATE**; do not quote a single date as though it were measured. **WHAT IS ARITHMETIC RATHER THAN EXTRAPOLATION, AND SURVIVES EVERY MODEL: +2.9 GB IS ALREADY COMMITTED OVER THE NEXT 30 DAYS.** 16 of the 30 daily slots still hold pre-08-07 files 130–200 MB smaller than today's; **with the database FROZEN the daily tier still climbs to 30 × 440 MB = 12.89 GB against ~10.0 GB now**, a ~99 MB/day floor that takes free from 10.78 GB to ~7.9 GB by 2026-09-20 on its own. v4.26 predicted exactly this and it is still tracking. **AND THE RECLAIM CHANGED THE RATE NOT AT ALL** — it bought headroom, not slope. The 43× amplification (30 daily + 12 hourly slots each holding a copy of one growing database) is structural and is the thing that would need a decision if the database resumes growing. **THE RULE — A CHECK THAT CANNOT RUN MUST REFUSE, NOT PASS. TWO BUGS IN ONE PREFLIGHT, AND THE SECOND IS THE ONE WORTH REMEMBERING.** **(1) WRONG QUESTION.** The refusal that asked "is anything holding these files open" tested the two `/tmp` directories with `fuser -sm`. **`-m` asks who is using the FILESYSTEM a path sits on, not who has that path open** — and `/tmp` is not a separate mount here, it is on `/dev/vda3` with everything else. Measured: `fuser -m /tmp/repair` reports **211 processes**, essentially the whole process table, **so the check refused on every run.** Fixed to test each file individually with `fuser -s`, exactly as the five `.db` files were tested; measured after the fix, all six files free. **A fail-closed check that always fails is not a safety property — it is a check nobody can satisfy, and the way that ends is somebody deleting the check rather than reading it.** **(2) SILENT PASS ON A MISSING TOOL, AND THIS IS THE IMPORTANT ONE.** `if fuser -s "$f"; then refuse; fi` is **false when `fuser` is not installed** — the shell cannot distinguish "no process holds this file" from "the binary that answers that question is absent", so a missing tool reads as **"nothing is holding this, proceed."** The check now selects `fuser`, falls back to `lsof`, and **refuses outright when neither exists.** **THIS IS THE SAME CLASS AS THE PRUNE STEP IN v4.26** — *"`db-backup.sh`'s prune step cannot report its own failure — `|| true` on the listing, a failed delete that only warns, and `PRUNED` never written to the log, so a healthy run and a broken one are byte-identical."* **Same shape, different tool: an instrument whose failure is indistinguishable from success.** That one was fixed by its 2026-08-18 deadline and now prints `prune=ok eligible=N removed=N failed=N cutoff=…`; this one is fixed by refusing when the tool is absent. **THE RULE, STATED SO IT IS REUSABLE:** *every check must be able to report that it could not run, and that report must be a REFUSAL rather than a pass.* It applies to at least four things already in this record — the prune step (v4.26), this preflight, **PART H trigger T1 where `exit 2` escalates to RED precisely because a checker that cannot run is not a checker that passed**, and **`checks.py`, which returns 0 whatever it finds because it contains no `sys.exit` at all (G24)**. **THE GENERAL FORM IS THAT ABSENCE OF EVIDENCE GETS READ AS EVIDENCE OF ABSENCE BY DEFAULT**, in shell and in JavaScript alike, and it has to be written against explicitly every time. A reclaim, a deadline restated as a range, and a rule with four instances; **no application code changed** — and a patch.

2026-08-20 · v4.53 — §24 Database: **THE LARGEST ITEM IN THIS MIGRATION WAS NEVER ON THE LIST: THE COPY RENAMED 12 TABLES AND 2 COLUMNS AND THE APPLICATION STILL USES THE OLD NAMES — 266 STATEMENTS ACROSS 23 FILES.** §24 recorded the tenant→account rename as a copy rule — *“the tenant→account rename across tables, columns and identifiers, per the retired `tenant` glossary term”*. **The schema half happened. The code half did not, and nothing recorded that it hadn’t.** `tenants`→`accounts` **104 statements**, `tenant_users`→`account_users` **81**, then `tenant_domains` 19, `tenant_user_codes` 13, `tenant_user_sessions` 13, `tenant_integrations` 7, `tenant_onboarding` 6, `tenant_signup_requests` 6, `tenant_secrets` 5, `tenant_operator_push_subs` 4, `tenant_user_caps` 4, `tenant_user_stores` 4. Worst files `routes/backend-auth.js` 92, `saas-admin.js` 32, `store-admin.js` 31, `backend-team.js` 29, `retail.js` 17. **COMMENT-STRIPPED AND STATED AS A FLOOR** — 267 raw, one of which was prose; only SQL keyword positions counted; **a table name built at runtime is invisible to it by construction, so the true figure is higher.** **AND THE COLUMNS ARE RENAMED TOO, WHICH THAT NUMBER DOES NOT INCLUDE:** `tenant_id`→`account_id` in **20 tables**, `tenant_user_id`→`account_user_id` in **5**; raw identifier occurrences are 251 and 54 but **have NOT been separated into SQL references and ordinary JavaScript variables, so they are not a statement count and must not be quoted as one — the column half of this gap is unmeasured.** **IT IS A DIFFERENT CLASS FROM G9, WHICH IS WHY NOTHING CAUGHT IT.** G9 counts dialect — syntax Postgres will not parse. **A plain `SELECT` against `tenants` is perfectly valid Postgres; there is simply no such relation.** No dialect scanner would flag it, **and none exists in `scripts/` to have tried**. Against G9’s 96 this is nearly **three times larger**, like for like; G1’s 102 is transaction *blocks*, a different unit, so the honest claim is that **266 is the biggest measured statement count in the migration**, not that it beats G1. **G26 AND G28 CLOSE TOGETHER OR NOT AT ALL, AND THIS IS THE OPERATIONAL POINT.** Clearing G26 makes the application boot; these 266 then throw a missing-relation error on the first request that reaches one — **and PART H trigger T2 stops at ONE such line**, so a flip taken between the two goes red immediately for a cause of your own making, indistinguishable on the panel from a real dialect failure. **ONE CALL SITE ALREADY MET THIS AND LEFT THE ONLY RECORD THERE WAS:** `routes/retail.js` `tickRetryWeChatShipping()` wraps its `tenants` read in a catch commented *“tenants table not migrated yet → single-DB fallback”*. **One anticipated it; the other 265 did not.** **THE FIX IS A DECISION, NOT AN EDIT** — renaming the schema back reverses §24’s deliberate retirement of the word `tenant`, so somebody has to choose which side moves. **G26 IS BY CONTRAST SMALL, AND ITS SHAPE IS SETTLED: ONE MECHANISM, NOT ELEVEN FIXES.** The eleven module-load `.exec()` calls create **19 tables and 10 indexes**; **0 of the 19 are in `schema.sql` and 0 are in `database.js`**, so on SQLite they are the only source and are load-bearing rather than belt-and-braces; **all 19 already exist in the live cluster** (12 by name, 7 under the renamed one); and **the module-load timing is incidental** — none of them queries at load, they only create, and nothing needs the table before first query. So the wanted behaviour is uniform: **run on sqlite, skip on pg.** **`database.js` ALREADY HAS THE HOME** — **106 `CREATE TABLE IF NOT EXISTS` plus 307 `addColumn()`** against `schema.sql`’s 30, **already behind the pg early return**, so moving the 19 there inherits the skip with no new mechanism to design or test. Three schema homes exist; these eleven are the only one that is not driver-aware. **NOTHING ELSE BLOCKS THE BOOT** — verified: column-0 terminal calls are clean and the only top-level IIFEs are `loadEnv()` and browser JS inside a template literal. **But “boots” is not “works”: five subsystems start inside the `listen` callback and all five fail into a `catch` that warns and continues** — the releases announce, the inventory reservation sweeper, the KD100 tracking sweeper, the delivery-reminder sweeper and the secret-box health check. **The port opens, the four probes go green, and those five are silently dead** — the T3 asymmetry with names attached. Two module-load timers fire seconds later and are both internally guarded. **`uncaughtException` exits for a clean pm2 restart**, so any unguarded throw in a callback becomes a crash loop — and it pages through `sendOpsAlert`, which is dead after F1 (G25). **AND THE DISK NOW HAS A DATE RATHER THAN A PERCENTAGE.** `db-backup.sh` carries **`MIN_FREE_MB=2048`** with **`WORK=/tmp` on the filesystem it measures**, so below 2 GB free it hard-fails and **the nightly off-site backup of BOTH SQLite and the Postgres dump stops — ~2026-09-03, before 95%, with no warning tier ahead of it.** Measured 2026-08-20 19:58 CST: 37.5 GB usable, 31 GB used, 6.5 GB free, 83%; **90% ≈ 08-29, backup refuses ≈ 09-03, 95% ≈ 09-04.** **THE RATE IS 316 MB/day, NOT THE ~800 OBSERVED, AND THE DIFFERENCE IS THE WHOLE FINDING.** The database grows **7.3 MB/day compressed** and **the backup tiers amplify it 43×** — 30 daily slots (218 MB/d) + 12 hourly (87) + the live file (11). The rest was a **4.57 GB one-off** dumped 08-18/19 by the money-repair work: five uncompressed `data/roots-pre-*.db` (3.26 GB) plus `/tmp/repair` and `/tmp/mc_survey` (1.30 GB), under no retention and **invisible to `db-backup.sh`’s own stale sweep, which only matches its own `*-YYYYmmdd-HHMMSS.db` naming at maxdepth 1.** It reconciles: 316×9 days + 4.57 GB − 0.86 GB of pruner reclaim ≈ the 6.5 GB observed. **BOTH PRUNERS ARE VERIFIED WORKING AND v4.26’S DEADLINE WAS MET** — `prune-deploy-backups.sh` holds a clean 14-day window (73 dirs, 108 MB, down from 862), and the `db-backup.sh` prune-reporting fix that v4.26 gave a **2026-08-18** deadline landed: the log now reads `prune=ok eligible=1 removed=1 failed=0 cutoff=20260806`, exactly the reporting it said was missing. **The retention work is not what failed; ad-hoc copies nobody swept are.** ⚠️**~3.1 GB more is committed even with the database frozen**, because 16 of the 30 daily slots still hold July files 100–210 MB smaller than today’s — v4.26 predicted this and it is tracking. One gap opened, one gap’s shape settled, one deadline dated; **nothing deleted and no code changed** — and a patch.

2026-08-20 · v4.52 — §24 Database: **APPLICATION CODE HAS EXECUTED AGAINST POSTGRES FOR THE FIRST TIME, AND IT RETURNED THE SAME BYTES SQLITE SERVES.** `eval/pg-probe/g20-categories.js` runs the body of `GET /api/retail/categories` — `SELECT id, name FROM categories WHERE kind = 'product' ORDER BY sort_order, name` — through the real chain: `lib/db-driver` selects, `database.js` returns the alien pooled handle, `tdb()` hands it back, `lib/db-seam` passes it through, the statement executes on the cluster. **44 rows, 21 ms, 1381 bytes, `sha256 24c690d353f09cd7d20e698eafe279bf90a5369deca16fefd6ad1f2d52f0b4ce` — byte-identical to the live SQLite response, three consecutive runs, same hash.** `.env` untouched, no pm2 restart, no leaked pool connections, probe connections back to zero. **THE ROUTE WAS CHOSEN FOR SIX PROPERTIES AND MISSES ONE DELIBERATELY**: read-only, ONE statement, zero parameters (a string literal, so what it exercises is knowable by reading it), trivially async, exercises `tdb()` and the seam, and eyeball-comparable — **but it does NOT exercise `withTransaction`, and that trade is the right way round.** All 27 converted blocks are writes, so reaching a transaction means reaching money, which costs the first two properties at once; and **a transaction that cannot execute a single statement is not testable.** **THE DATA MADE IT A BETTER INSTRUMENT THAN THE ARGUMENT DID**: `sort_order` carries **no ties**, so `name` never acts as tiebreaker and **the byte-vs-locale collation footgun cannot fire on this query** — the likeliest source of a false mismatch is structurally absent — while **8 of the 44 names are non-ASCII** (`Coffee ＆ Tea` carries a full-width ampersand), so UTF-8 round-trips for free. **THE PROBE REFUSES TO RUN ON SQLITE, AND THAT IS A SAFETY PROPERTY RATHER THAN A CONVENIENCE**: requiring `database.js` on the SQLite path opens `data/roots.db`, execs `schema.sql` and runs **305 `addColumn()` migrations** — writes, against the live database, from a probe whose whole job is to be read-only. The SQLite half of the comparison comes from `curl` against the running app and never from re-opening the file. **IT ALSO LIVES OUTSIDE THE DEPLOY ALLOWLIST ON PURPOSE.** The allowlist is `public/ routes/ lib/ middleware/ scripts/` plus `server.js`, `database.js`, `schema.sql` and the two package files — **so a diagnostic placed in `scripts/` would ship AND BOUNCE pm2, a production restart to install an instrument.** `eval/` is outside it: committed and recorded, never deployed, copied to the box by hand. **AND IT SELECTS THE DRIVER FOR ONE PROCESS VIA THE ENVIRONMENT RATHER THAN BY EDITING `.env`**, which is why the running application was never involved. **TWO GAPS FOUND BY BUILDING IT, RECORDED AND NOT FIXED PER THE STANDING FREEZE — AND THE FIRST IS THE ONE THAT CHANGES THE SHAPE OF G1.** **(1) G26 — THE APPLICATION CANNOT BOOT ON POSTGRES, AND THE OBSTACLE IS NOT THE 800 UNCONVERTED CALL SITES.** **Eleven `.exec()` calls run at MODULE LOAD across ten files** — `lib/tenant-creds.js:34`, `lib/billing-lifecycle.js:44`, `lib/integrations/registry.js:29`, `lib/integrations/session-relay.js:32`, `lib/platform-admin.js:30`, `routes/backend-auth.js:32` and `:207`, `routes/backend-signup.js:27`, `routes/billing.js:30`, `routes/saas-admin.js:33`, `routes/store-admin.js:36` — each an idempotent `CREATE TABLE IF NOT EXISTS … INTEGER PRIMARY KEY AUTOINCREMENT`. The alien handle has no `.exec`, so the **require** throws. **The first fires at `lib/tenant-creds.js:34`, reached from `server.js:281`, 631 lines before `app.listen()` — the process prints the `[db-driver]` line and then dies without ever listening.** **TWO FAILURES ARE STACKED**: no `.exec`, and `AUTOINCREMENT` is SQLite-only DDL Postgres would reject even if there were. **THIS CORRECTS RUNBOOK STEP G2, WHOSE GOOD CONDITION IS UNREACHABLE TODAY** — its two halves are independent and only the first is real: the `[db-driver]` line proves the flag was read (now verified by the probe), while "running on port 4000" proves the boot survived and is gated on this. **ELEVEN IS A MUCH SMALLER NUMBER THAN 102 AND THAT IS THE ENCOURAGING HALF**: this is boot-time schema management, not the async conversion, and clearing it turns "the app cannot start" into "the app starts and individual routes fail", which is the only state in which G1 can be worked incrementally at all. **It also blocks the obvious harness** — `routes/retail.js` requires `lib/tenant-creds` at load, so a bare express app mounting just that router dies on the same line; its 40-module load-time closure holds **exactly one** blocker, while `routes/lookups.js` (5), `lib/tenant-db.js` (4) and `database.js` (2) are blocker-free, **which is precisely what made the probe possible without touching any of it.** **(2) G27 — `.env` IS PARSED BY AN IIFE INSIDE `server.js` AND BY NOTHING ELSE, SO EVERY `--pg` SCRIPT EXITS 2.** The variables exist in `/root/roots-v2/.env` and are correct; a plain `node` process cannot see them and `lib/pg` refuses to build a pool rather than connecting to a guess — exactly as its header says it should. Measured on the box running the command the runbook already prescribes: `LEDGER_EXIT=2`, `refusing to build a pool: missing TACET_PG_HOST, TACET_PG_DATABASE, TACET_PG_USER`. **IT BREAKS FOUR THINGS THIS PROJECT HAS WRITTEN DOWN AS PROCEDURE**: runbook step G6; **PART H trigger T1, where exit 2 is amber once and RED on the re-read — so the panel would order a rollback within two minutes of the flip for an environment reason**; the H4 slow watch loop; and **H6 step 2, the delta report, which runs at the moment the operator has already decided to roll back — the worst possible place to meet a configuration error.** **NOT broken:** `scripts/rollback-to-sqlite.sh` shells to `sudo -u postgres psql` and is unaffected, and the application parses `.env` itself before requiring `database.js` (verified: nothing pulls in `database.js` before that IIFE runs). **THIRD SIGHTING OF ONE SHAPE — the environment is assumed and is not there**: `health-watchdog.js` carries its own loader for this reason, `lib/ops-alert.js` never consults `process.env` at all (v4.45 finding 1), and now this. **The probe carries the same `envVal()` loader, which is a workaround and not a fix.** **WHAT THE PROBE PROVES AND WHAT IT DOES NOT, STATED PRECISELY BECAUSE A GREEN RESULT INVITES OVER-READING.** Proves: driver selection, `lib/pg` loading and arming the numeric parser, the pool authenticating as `tacet_app`, `database.js`'s early return, `tdb()` identity, seam pass-through, and ONE statement shape — literal SELECT, no parameters, many rows, over `integer`/`text`/UTF-8. **Proves NOTHING about: any write, any transaction or savepoint, G5's queue, parameter binding, single-row `.get`, `.changes`/`lastInsertRowid`, money through the numeric parser, timestamps and Asia/Shanghai rendering, the 371 dynamic statements, concurrency — or boot.** **G20 STAYS OPEN**; the next instrument must add parameter binding and a single-row `.get`, then the first write inside `withTransaction` where G5 stops being theoretical, then a money read. **TWENTY-ONE GAPS REMAIN OF TWENTY-SEVEN IDENTIFIED.** Runbook v0.5 → v0.6: **B19 and B20 added, step G1 annotated, step G2 corrected, and G6, T1, H4 and H6-step-2 each marked with the defect that stops them running.** An instrument built, one sentence in this record retired, two gaps opened and four procedure steps corrected; **no application code changed** — and a patch.

2026-08-20 · v4.51 — §24 Database: **READ-ONLY SSH TO PRODUCTION IS AVAILABLE, THE WORKING RULE SAYING OTHERWISE WAS FALSE, AND IT WAS DISPROVEN BY RUNNING THE SAME READ FROM BOTH SIDES.** Claude reported `md5 = 5bdbd103e32c3fea1eca43f53811989a` for `/root/roots-v2/public/till.html`; Ash independently ran `ssh root@47.239.89.63 "md5sum …"` from PowerShell and got the same 32 characters — **a value a fabricated read had no way to match**, and the evidence is recorded in the entry so the correction is not reversible on someone's recollection. **THE DESTRUCTIVE BOUNDARY IS UNTOUCHED AND WAS NEVER THE FALSE PART**: live-database writes, service restarts, deletions, cron and config changes stay Ash's to run, because that boundary is about blast radius rather than access — the two were bundled into one rule and only the access half was wrong. **THE RULE WAS NEVER IN THIS DOCUMENT** — it is absent from every `*.md` in the repository — but was one line in the operator's working notes, written in a session where the classifier genuinely did refuse every `ssh`. **AND IT STILL REFUSES SOME SHAPES**: two read-only calls were refused on 2026-08-20 for their form (a `for` loop, a `-json` flag) and succeeded when reissued plainly, so the honest statement is **access exists, some command shapes are refused** — the original note generalised one session's refusals into a standing incapacity, and the false version outlived its cause by months. **THE COST WHILE IT STOOD**: read-only checks routed through Ash unnecessarily, and briefs written asking for commands to be handed over — **including the brief that produced this correction**, which requested an SSH command on the grounds Claude had no SSH. **THE RULE THAT FOLLOWS — a claim about what Claude cannot do must name the test that would overturn it**, or nobody re-checks it and it decays silently as the environment moves. One record correction and a rule, no code touched; **no claim about production beyond one file hash, read twice** — and a patch.

2026-08-20 · v4.50 — §24 Database: **THE TWO FINDINGS v4.49 RECORDED IN PROSE ARE PROMOTED TO NUMBERED GAPS — G24 AND G25, CARRIED IN PART B WHERE THE EXIT GATE LIVES RATHER THAN ONLY IN A FINDINGS LIST AT THE END OF PART H.** A finding filed under the part that discovered it is filed where nobody looks for it; **PART B is what somebody reads before deciding the night can start.** **G24 — THE FIDELITY INSTRUMENT DOES NOT EXIST AS WRITTEN, AND ITS FAILURE MODE IS THE ONE THIS DOCUMENT WAS BUILT AGAINST.** `scripts/postgres-full-copy/checks.py` reads `wide_cols.json` **at import, line 13** — generated by `volume.py`, covered by `scripts/postgres-full-copy/.gitignore`, **absent from the repository, so the deploy has never shipped it and never will** — and hardcodes `SRC = "file:/root/roots-v2/data/roots.db?mode=ro"`, **the file step F1 renames away.** Either blocker is fatal alone. **Every other gap is a visibly empty step: you arrive, there is no command, you stop. This one has a command in PART G that LOOKS runnable**, and it fails after the copy, after the flip, with the shop live — **at the point of maximum cost.** A step that reads as complete and is not is precisely the thing the runbook's own preamble refuses to produce. Surviving half is check P: **P proves the KEYS came across, `checks.py` proves the CELLS did.** Also — not a blocker but recorded beside it — the script issues `ALTER TABLE … VALIDATE CONSTRAINT` **144 times**, which is DDL against a live cluster and **must never enter a watch loop.** **G25 — NO ALERTING SUBSTITUTE FOR THE WINDOW, AND THE OBVIOUS PLACE TO BUILD ONE IS THE WRONG PLACE.** v4.46 finding (1) recorded that F1 silences alerting; what this adds is **why the stopgap cannot be moved onto the box.** A loop running on the box **dies with the box, and its silence is indistinguishable from green** — which is exactly the state you are already expecting once alerting is off. **This is not hypothetical: 2026-06-28 was a box that wedged with sshd, nginx and the app all accepting TCP and returning zero bytes, and it stayed dark because nothing off-box noticed.** **The one observation only an off-box watcher can make — “the box stopped answering” — is the most important thing it can say, and the one thing an on-box loop never can.** Second binding reason: the natural home is `scripts/`, and **a file there ships and bounces pm2 mid-window.** The real fix is `lib/ops-alert.js` reading the webhook from `process.env` — **which `scripts/health-watchdog.js` already sets before requiring it, making that plumbing dead code today.** **NINETEEN GAPS REMAIN OF TWENTY-FIVE IDENTIFIED**, and the two new ones were found by **writing the procedure rather than surveying for them**, which is the argument for procedures: walking a night turns up holes a survey does not. Numbers are not reused; G24 and G25 are new, not recycled. Runbook v0.5 gains **B17 and B18**; status doc gains **items 46 and 47**. **Recorded and NOT fixed, per the standing freeze** — and G23 stays closed, because a decision about when to stop does not depend on either of these. Two findings promoted, no code touched; **no claim about production** — and a patch.

2026-08-20 · v4.49 — §24 Database: **G23 IS DECIDED — THE DECISION-MAKER IS ASH, ALONE, AND THE WINDOW IS ONE HOUR — AND THE HOUR IS NOT CHOSEN FROM THE DATA.** v4.46's arithmetic says the window could run **one to two trading days** before hand-reconciliation stops being reasonable: business rows accrue at **1–2/hour**, 63% of the database is disposable, the pre-flip file does not rot and Postgres is not dropped on rollback, so what closes the window is re-entry cost at 20–40 rows and nothing else. **THE ONE-HOUR DEFAULT IS SET AGAINST A HUMAN FAILURE INSTEAD: A DECISION LEFT OPEN DRIFTS.** Every hour undecided, the cost of deciding rises and the willingness to pay it falls — the operator has been awake longer and the abandoned rows have stopped being rows and become people to phone. **The window does not close because the data goes stale; it closes because the decision-maker does.** An hour is long enough for every trigger to fire if it is going to and short enough that it will still actually be spent. **NAMING THE DECISION-MAKER IS WHAT MAKES THE TRIGGERS WRITABLE, NOT THE OTHER WAY ROUND.** One person, no developer, 3am, following the page literally — so **every trigger must be an observation with a command already on the box, never a diagnosis**, and the standing instruction is that **the colour beats the feeling**, because the failure mode alone at 3am is not panic, it is talking yourself out of a red because the shop looks fine. **FOUR TRIGGERS, AND THE ERROR-LOG THRESHOLD IS ONE — NOT TEN — FOR A REASON WORTH KEEPING.** 96 dialect statements are findable by reading; **371 dynamic statements are reachable only by executing the code, and the only place it executes is production, on customers.** So a matching line is not "an error", it is proof the class is live carrying **no information about how many are behind it**; a threshold of ten buys no evidence, it buys nine more customers meeting the same defect. **The characteristic damage is a half-finished money write, which is exactly what the invariants have no constraint to catch** — `retail_points_transactions`, `retail_topup_transactions`, `retail_order_addons` and `retail_refund_events` carry no unique constraint of any kind. **AND THE THRESHOLD OF ONE IS UNUSABLE WITHOUT TWO EXCLUSIONS THE FLIP ITSELF CREATES**, which is the sharpest finding of this pass: `[ops-alert] SUPPRESSED` lines are **guaranteed** by step F1 and land in the same log through the same `console.error`, so **the trigger and its own noise source are produced by the same step.** Record the log's byte offset at F1 (`/root/flip-offset`, outside the app tree so it ships nothing) or every count is "lines ever" and the first tick is red. **THE PROBES ARE ASYMMETRIC AND MUST BE READ THAT WAY**: all four are GET-only and side-effect free, so **after G1 a flip that breaks WRITES leaves all four green** — red is evidence of harm, green is not evidence of health, and the ten-minute invariant pass is the only thing covering the difference. **THE WATCH LOOP IS THE ALERTING CHANNEL FOR THE WINDOW, NOT A CONVENIENCE**, because v4.45's finding (1) means the phone is silent by construction for exactly the hour the decision needs it — **including the health watchdog's own "storefront DOWN" page.** It runs **on the laptop, over SSH, never on the box**: a loop running on a box that wedges dies with it and **its silence is indistinguishable from green.** Its rule is the simplest available — **the line should be byte-for-byte identical every minute; ring on any change and on no answer** — and it must ring audibly, since replacing silent alerting with a silent terminal is not an improvement. **And it may not become a file in `scripts/`: a file there ships and bounces pm2, mid-window.** **THE WATCHDOG PREMISE NEEDED CORRECTING AND THE CORRECTION IS THE USEFUL PART.** `health-watchdog.js` does **not** restart every four minutes — cron every 2 min with `HEALTH_FAILS=2` gives a first restart at ~4 min and then **latches** behind `!state.down`, one restart per down-episode. **So repeated ~4-minute restarts mean the app is coming back, answering `/`, and dying again — a FLAP, which is the G9 dynamic-statement signature — not a restart loop.** Telling a bounce from a crash: a bounce is always preceded by `[health] app probe FAILED (2/2)` in `/var/log/roots-health.log` and a crash leaves nothing there; **`unstable_restarts` moves only on a crash, never on a deliberate `pm2 restart`.** **And the classification is the smaller half: the watchdog restarted the app BECAUSE THE APP STOPPED ANSWERING, so a bounce is never the trigger — it is an instruction to read the error log and the probes.** **THE DELTA REPORT IS A COST ESTIMATE, NOT ONLY A POST-MORTEM**, and this is the operational move the tool's own header does not make: it is read-only and server-enforced, so **running it while still live on Postgres, before deciding, turns "how much am I about to abandon" into a number** — `TOTAL n row(s): m to look at`, against v4.46's 20–40 threshold. **FOUR FINDINGS RECORDED AND NOT FIXED, PER THE STANDING DECISION.** **(1) `scripts/postgres-full-copy/checks.py` CANNOT RUN AFTER STEP F1, FOR TWO INDEPENDENT REASONS, SO THE FIDELITY TRIGGER HAS NO INSTRUMENT.** It reads `wide_cols.json` **at import**, line 13, before any check runs — that file is generated by `volume.py`, covered by `scripts/postgres-full-copy/.gitignore`, **absent from the repository and therefore never deployed.** And `SRC` is hardcoded to `file:/root/roots-v2/data/roots.db?mode=ro`, **which F1 renames away** — so runbook step G7 opens a path that does not exist during the exact window it guards. **Also: it issues `ALTER TABLE … VALIDATE CONSTRAINT` 144 times — DDL, not a read — so it must never go in a watch loop.** Nearest surviving substitute is check P: **P proves the keys, `checks.py` proves the cells.** **(2) `rollback-delta-report.js` MUST BE RUN BEFORE THE ROLLBACK AND NOTHING SAYS SO — AND RUNNING IT AFTER GIVES A WRONG ANSWER RATHER THAN AN ERROR.** Its default `--since-db` is `data/roots.db.pre-cutover`, which the rollback renames to `roots.db`; and pointing it at the restored file afterwards **silently omits exactly one window order**, because the reservation marker raises `retail_orders`' `MAX(id)` by one before the rename. **(3) `docs/tacet-postgres-status.md` item 17 said the tool was "BUILT ON `claude/survey-land-shipment-default-vw1hcn`, NOT MERGED" — it merged at `7483cb91` and all three files are on `main`.** Same class as G11: the record lagging the world. Corrected in this commit. **(4) A pre-cutover file that fails `integrity_check` (refusal R3) is NOT a cutover fault** — `mv` does not corrupt a file, so it was already damaged before the flip, and both D1's backup and D3's checks passed over it without noticing. That is its own incident whenever it appears. **WHAT THIS DOES NOT DO, SAID PLAINLY BECAUSE THE TEMPTATION IS TO READ A CLOSED G23 AS READINESS: A ROLLBACK THAT EXISTS IS NOT PERMISSION TO FLIP. IT IS PERMISSION TO STOP.** G1 is untouched and is still the largest item; nothing has executed against Postgres anywhere (G20); nothing stops trading (G16); there is no delta pass (G18). **Seventeen gaps remain of the twenty-three identified.** Runbook v0.4 → v0.5: PART H rewritten from a list of holes into a procedure (H1 decision-maker, H2 triggers, H3 window, H4 watch loop, H5 bounce-vs-crash, H6 the sequence after deciding, H7 refusals R0–R4, H8–H10), and **PART I rewritten because its central sentence — "irreversible from its first second" — is retired**: the point of no return is no longer a moment reversal becomes impossible but **the moment it stops being a rename**, which has no clock and can trip in minute three. A decision, a rewritten procedure and four open findings; **no code changed, so no claim about production** — and a patch.

2026-08-20 · v4.48 — §24 Database: **THE DEPLOY PIPELINE RE-STAMPS `sw.js`, AND THE CACHE STRING WRITTEN INTO A COMMIT NEVER SHIPS.** The installer rewrites the `CACHE` constant in `public/sw.js` to a deploy timestamp after installing it — `roots-v2-shell-20260820-170427` — so **including `sw.js` in a commit is the TRIGGER for a re-stamp and not the mechanism**, and the string chosen in the commit reaches no browser. **THE COST IS ALREADY PAID AND MEASURABLE: `4d5bf7d3` changed the New-order wizard without touching `sw.js`**, so warm browsers went on serving the pre-cascade admin bundle and operators went on seeing the old free-text address fields until the next commit that did touch it — which is the failed-deploy family's signature, a change that is on the box and not in front of the user. **AND A VERIFICATION STEP THAT GREPS THE SERVER FOR THE COMMIT'S LITERAL CACHE STRING CAN ONLY EVER FAIL**, so it asserts nothing while looking like proof — the "looks like proof and is not" shape again, ordinal deliberately not claimed; verify the timestamp shape, or the `stamped sw.js CACHE ->` line the installer prints. **Recorded beside the two failed-deploy entries rather than at the end of the section**, so the three pipeline learnings read as one run. One rule, no code and nothing reversed; hence a patch.

2026-08-20 · v4.47 — §24 Database: **THE AST AUTHORITY PARSES `database.js` AGAIN — 102, NOT 92 — AND THE FIX IS ONE OPTION WITH A LONGER COMMENT THAN ITSELF.** `ecmaFeatures: { globalReturn: true }`. CommonJS wraps every module body in a function, so a top-level `return` is legal and this tree uses one: G2's driver branch returns early under `TACET_DB=postgres`. Without the flag `espree` rejected the file with `'return' outside of function`, the file was dropped, and **the runtime-wide unconverted total fell by exactly `database.js`'s own 10 blocks with nothing converted.** 115 files parse, zero failures, and the four counts are **102 / 29 / 27** — unchanged from before the regression, which is the point. **THE FREEZE IS ON FINDINGS, NOT ON DEFECTS WE INTRODUCED, and this is the distinction worth keeping**: an open finding is somebody else's defect waiting its turn behind the flip; this was our own merge silently degrading the instrument rule 2 names as the authority for every count in this record. Those are not the same queue. **AND THE REAL LESSON IS NOT THE OPTION, IT IS WHERE THE DOUBT WAS PRINTED.** The script always said `PARSE FAILURES: 1` and named the file — it was never silent. But it said so in a header forty lines above the number, and **a reader who quotes the total does not read the header.** A dropped file contributes zero blocks, so a parse failure makes the figure an UNDERCOUNT that is indistinguishable from progress: 102 became 92 and looked like ten conversions. So the total now carries its own caveat, beside the number — `*** UNDERCOUNT: n file(s) did not parse and contributed 0 blocks each`, each named, and `DO NOT QUOTE THIS TOTAL until they parse. It is a floor, not a count.` **Same family as the "looks like proof and is not" set this section keeps recording, in its measurement form rather than its test form: the run was honest and the number was wrong, because the honesty and the number were in different places.** Verified both ways — silent on a clean run, and firing beside the figure when the option is removed again. **A grep of `db.transaction(` in that file finds 8 of the 10, which is the sixth grep-derived count to be wrong here and the reason rule 2 exists.** The status doc's brief 92 is corrected to 102 in the open per rule 5 rather than quietly overwritten. One fix, one mechanism and a correction; nothing reversed, hence a patch.

2026-08-20 · v4.46 — §24 Database: **THE DAEMONS STOP FOR THE FLIP — DECIDED — AND THAT ONE DECISION IS WHAT MAKES ROLLBACK A RENAME INSTEAD OF A MERGE.** Pausing ingest from five channels for the window is a smaller cost than an irreversible cutover; a flip that cannot be reversed is not one worth running. **THE ALTERNATIVE IS NOT "SLIGHTLY WORSE", IT VOIDS THE TOOL**: if the six daemon processes keep writing to SQLite while the application writes to Postgres, BOTH databases move, and a rollback then has to resolve rows that changed on both sides with no `updated_at` on most of them to say which is newer. **G22 IS BUILT ON A BRANCH AND NOT MERGED** — `scripts/rollback-to-sqlite.sh`, `scripts/rollback-delta-report.js`, 23 assertions, mutation red-proven. **ROLLBACK IS RESTORE-AND-LOSE, AND THE STRUCTURAL REASON IS THE WHOLE ARGUMENT.** A carry-back needs to identify what changed. New rows are identifiable in 114 of 129 non-empty tables by `id > watermark`. **Updated rows are not: only 40 of 129 carry `updated_at`, so 89 CANNOT REPORT THAT A ROW CHANGED — and `retail_customers` is one of the 89, holding `balance`, `points_balance`, `lifetime_spend` and `tier`.** Nine tables have neither an `id` nor a `created_at`, so no delta is even definable — `storefront_config`, `channel_status`, `store_business_status`, `qingyun_status`, `gzgrocery_orders`, `guanyi_product_pricing`, `guanyi_pickup_baseline`, `gzgrocery_meta`, `_migrations`. **And deletes leave no trace at all; nothing tombstones.** **THE REVERSE COPY IS RECORDED AS A REJECTED OPTION SO NOBODY PROPOSES IT AGAIN**, with its reasons in the header of the tool that exists instead of it. Beyond the three above, **the timestamp direction carries a SILENT failure mode that is the sharpest reason of the four**: SQLite stored two text forms — naive `YYYY-MM-DD HH:MM:SS` and ISO `…Z` with optional fractional seconds — and Postgres stores one instant, so **which form a row had is unrecoverable**; worse, `timestamptz` renders in the session `TimeZone`, and this box is Asia/Shanghai, so **a reverse pass that does not force UTC brings every timestamp back EIGHT HOURS AHEAD, in a format that looks entirely correct.** 312 columns. Do not propose a reverse copy without answering all four. **THE WINDOW IS ONE TO TWO TRADING DAYS, NOT MINUTES, AND THE ARITHMETIC IS WHY.** 63% of the database is disposable: `retail_checkout_quotes` (105,735 rows — an abandonment log written best-effort inside a `try/catch`) plus the three sync logs (116,846) are 222,581 of 353,076 rows, and they dominate the drift. **Business rows accrue at roughly one to two per hour** — `retail_orders` +121/week ≈ 0.7/hr, `customers` +222/week ≈ 1.3/hr, `orders` +87/week ≈ 0.5/hr — so **an hour of window costs under one order.** What closes the window is not staleness but hand-reconciliation cost: the pre-flip file does not rot and **Postgres is not dropped on rollback**, so the lost rows stay readable and reconciliation is an unhurried offline task. The threshold is where a person stops re-entering orders carefully, call it 20–40, which at this rate is one to two trading days. **THE ORDER-NUMBER HIGH-WATER IS THE ONE THING ROLLBACK CREATES RATHER THAN FORGETS**, and it needed a design decision the brief did not anticipate: **SQLite has no counter row.** `nextOrderNo` reads `MAX(CAST(SUBSTR(order_no,3) AS INTEGER))` over `retail_orders`, so restoring the pre-flip file makes it reissue every `TC` number the window gave out, and **there is no way to move that high-water without inserting a row** — changing the minting path is out of scope. The tool therefore inserts **ONE cancelled marker order placed ABOVE the burned range**, not inside it, so every number actually issued stays free for a faithful re-entry; the marker carries `cancelled_reason = 'rollback_order_range_reservation'` and the output prints the `DELETE` that removes it. `order_no` is `TEXT UNIQUE NOT NULL`, which bounds the damage: a later re-entry collides loudly rather than duplicating silently. **POSTGRES UNREACHABLE DOES NOT BLOCK THE ROLLBACK** — refusing to restore trading because a bookkeeping counter could not be read would be the wrong trade — so it proceeds, states the cost in its own output, and prints the command to repair the high-water later. **THE PRE-FLIGHT IS THE TOOL AND THE RENAME IS FOUR CHARACTERS.** Five refusals, each forced individually in the suite and each asserted to have changed NOTHING: R0 no flip to undo, R1 a live `roots.db` exists so something recreated it, R2 the pre-cutover file is missing, R3 it fails `integrity_check`, **R4 it was written AFTER the flip.** R4 is the one that enforces this entry's decision: `mv` preserves mtime and an open better-sqlite3 handle keeps writing to the same INODE after a rename, so an unstopped daemon pushes that file's mtime past the flip. **With the daemons stopped R4 can never fire, which is exactly why it exists — a check that only fires when a decision was not honoured is the check worth having**, and the mutant disables it and takes that one test red. **A ROLLBACK THAT CANNOT VERIFY ITSELF FAILS RATHER THAN PRINTS**: the boot line must name sqlite (absence is not evidence), both invariant checkers must pass against the restored file, and the receipt is written BEFORE verification so a failed verify still leaves a record. **Processes are discovered by `pm_exec_path`, never a name list** — the G2 deploy proved why: **eleme is not running at all and qingyun runs TWO instances**, six processes across five daemon types rather than the six types the runbook lists. **THE DELTA REPORT CANNOT WRITE, AND THAT IS SERVER-ENFORCED RATHER THAN PROMISED** — every statement runs inside `BEGIN TRANSACTION READ ONLY` and is `ROLLBACK`ed on every path including a throw, because a guard that depends on the file not containing the word UPDATE lasts until somebody adds one. It states what it cannot see rather than implying completeness. **AND THE CENTS PREMISE IS STALE, WHICH MAKES THE MONEY QUESTION EASIER RATHER THAN HARDER.** Money is **`numeric(14,6)`, 101 columns**, not bigint cents: the 2026-08-04 as-built schema carries 93 `bigint`, the 2026-08-11 one carries **1** (`retail_order_counters.last_no`), and `plan.json` contains no `bigint` and no `CENTS` class at all. `money.py`, `money2.py` and `money3.py` still hunt `cls == "CENTS"` and find nothing — **they are the investigation that killed the idea, left in place and now reading as live tooling.** Money reverses cleanly: `numeric(14,6)` fits inside a double's ~15.9 significant digits, and for rows created during the window there is no original to lose. **THREE THINGS RECORDED AS OPEN AND NOT FIXED, PER THE STANDING DECISION.** **(1) ALERTING DIES AT THE FLIP, AND THIS IS NOW THE FIRST THING TO FIX WHEN THE FREEZE LIFTS.** `lib/ops-alert.js` `webhookUrl()` resolves the WeCom webhook **only** through `roConfig()`, which opens `data/roots.db` by path with `fileMustExist: true` — **it never consults `process.env`**, despite `scripts/health-watchdog.js` carefully setting `WECOM_ALERT_WEBHOOK` before requiring it, which makes that plumbing dead code for this path. After step F1 renames the file, `roConfig` throws, is caught, returns null, and every alert degrades to a `console.error('[ops-alert] SUPPRESSED: …')` line — recoverable from a log, invisible on a phone. **The watchdog's own "app is down" page is one of them.** The alerting channel dies at the exact moment the rollback decision needs it. **(2) THE FOUR HEALTH PROBES ARE GET-ONLY AND SIDE-EFFECT FREE** — `/`, `/api/retail/categories`, `/api/retail/config`, `/api/retail/products` — so **after G1 a flip that breaks WRITES leaves all four green.** Today this is academic because the alien handle makes every database call throw at once, but the moment call sites are converted the probes stop being sufficient and nothing replaces them. **(3) `retail_order_counters` IS pg-ONLY** — absent from `schema.sql`, `database.js` and `plan.json` — which is why the high-water needs the marker above. **(4) AND ONE THAT IS A REGRESSION FROM THIS WORKSTREAM'S OWN MERGED CODE, FOUND BY RUNNING RULE 2 RATHER THAN BY READING: G2's top-level `return` in `database.js` MAKES THE AST AUTHORITY UNABLE TO PARSE THAT FILE.** `espree` rejects `'return' outside of function` under the options `scripts/diagnose_async_conversion_scope.js` uses, so the file is dropped and **the reported runtime-wide unconverted total fell from 102 to 92 — exactly `database.js`'s own 10 blocks — with no conversion having happened.** The script does say `PARSE FAILURES: 1` and names the file, so this is loud rather than silent; what is silent is the ten-block hole in the number underneath it. **The true figure is still 102.** The fix is one option — `ecmaFeatures: { globalReturn: true }` — verified to parse the file and to find its 10 blocks; **`grep` finds 8 of them, which is the sixth time a grep-derived count has been wrong here and the reason rule 2 exists.** Not fixed, per the standing decision, and recorded with the fix attached so it is a decision rather than a discovery next time. **The measurement instrument the whole record depends on is currently degraded by ten, and that is worth knowing before any count is quoted.** A decision, a tool, a rejected option and four open findings; **nothing merged, so no claim about production** — and a patch.

2026-08-19 · v4.45 — §24 Database: **G2, G3 AND G4 ARE BUILT ON A BRANCH AND NOT MERGED — AND THE DECISION THAT SHAPES ALL THREE IS THAT THE POSTGRES HANDLE SHARES NO METHOD NAME WITH better-sqlite3.** No `.prepare`, no `.exec`, no `.transaction`, no `.pragma`. **DELIBERATELY ALIEN, NOT ADAPTER-SHAPED, AND THIS IS RECORDED FIRST BECAUSE IT IS COUNTER TO THE INSTINCT THAT WOULD DRIVE THE WORK** — the natural move when swapping a driver is to make the new handle look like the old one so existing call sites keep working, and here that is precisely wrong. **THE REASON IS MEASURED RATHER THAN AESTHETIC: the runtime holds 3,344 terminal statement calls — 1,619 `.get(`, 648 `.all(`, 1,077 `.run(` — and FIVE are awaited.** Every other one is written `db.prepare(q).get(id).name`, reading a property straight off the return value, against a synchronous driver. **An adapter hands the other 3,339 a Promise where they expect a row, and JavaScript does not throw**: `.name` on a Promise is `undefined`, `.changes` is `undefined`, `lastInsertRowid` is `undefined`. The application does not crash; **it computes wrong answers across every route at once and the first evidence is a customer.** Without `.prepare` those same sites throw `TypeError` at the first call with a stack trace on the exact line. **A handle that cannot be mistaken for better-sqlite3 converts the worst available failure mode into the best one**, and that sentence is the whole design. **ONE NAME IS SHARPER THAN THE REST AND HAS ITS OWN TEST: `exec`.** `lib/db-transaction.js` `control()` dispatches on shape, testing `typeof handle.exec === 'function'` **BEFORE** `typeof handle.query === 'function'` — so an object carrying both takes the SQLite branch and issues `BEGIN` synchronously down a driver that cannot execute it. **`query` is the one borrowed name and is safe**: it is node-postgres's own, better-sqlite3 has nothing called `query`, and `control()` already routes it. The rule is enforced at runtime, not by convention — `assertAlien()` refuses any handle carrying a better-sqlite3 name, checks with `in` rather than own-properties so a prototype- or Proxy-borne adapter is caught too, and the handle is frozen so `.prepare` cannot be bolted on later. **G2 — THE SELECTOR.** `lib/db-driver.js` reads `TACET_DB` once at module load and exports a constant, the `lib/tenant-db.js:87` shape this section specified. **MISSING AND UNRECOGNISED ARE DELIBERATELY NOT SYMMETRIC**: missing selects sqlite and says so, because every process has the variable unset today and treating absence as fatal would refuse to boot everywhere the first time the flag deploys — **an outage caused by shipping a flag, before anyone decided to flip anything**; unrecognised throws at load before any handle exists, because `postgresql`, `pg` and `postgre` are near-misses for what someone MEANT and **a near-miss silently treated as a default is indistinguishable from the flag never being set**, leaving the operator believing a flip happened while the application keeps writing to SQLite — divergence whose repair needs the reverse copy G22 does not have. `lib/pg.js` already refuses on missing config for the same stated reason. Whitespace and case are tolerated because they are the same token; `postgresql` is a different word. **The boot line names the driver so the flip can ASSERT rather than assume — `pm2 restart --update-env` has silently dropped a variable before, wiping `PORT`.** **THE SQLITE PATH IS PROVED UNCHANGED BY THE DIFF RATHER THAN BY A TEST**: the branch is an early return above the construction point, so `database.js` is **40 insertions and ZERO deletions** — there is no modified line for a behaviour change to hide in, which is a stronger proof than any assertion. A top-level `return` is valid in CommonJS; restructuring it into an if/else would destroy that property. **G3 — THE POOL REACHES THE APPLICATION**, built 2026-08-08 and wired to nothing until now; requiring it is also what arms the global numeric parser without which money arrives as text. **THE IDENTITY CONSTRAINT SURVIVES AND WAS THE THING MOST AT RISK**: `lib/tenant-db.js` compares the ALS store against `mainDb` BY IDENTITY, keys `dbToId` by raw handle, and `tenantAls.run()` throws on a wrapper — two objects for one driver would make `currentTenantId()` misreport or throw per request, and **that value selects a tenant's credentials.** Proved rather than assumed: one object from the module cache, `tdb() === rawTdb() === ` the export, the ALS accepts it, `currentTenantId()` answers Roots inside the scope. **`seam()` leaves it alone, and that falls out of the alien shape rather than from anything added** — seam wraps only what carries BOTH `.prepare` and `.exec`. **G4 — ONE TRANSACTION, ONE CONNECTION.** `runOutermost` takes the lease FIRST and hands it to the body, making `tx` a distinct client; on a pool, consecutive statements can land on different connections, so BEGIN comes apart from its body and COMMIT may reach a connection that never began anything. **THE SAVEPOINT SCHEME WAS NOT RE-DERIVED** — already designed and already implemented, named by the depth it opens at because only one savepoint can be live per depth, with BOTH statements on the failure path because `ROLLBACK TO` rewinds while leaving the savepoint on the stack. Followed and asserted. Release sits in a `finally` covering commit, rollback, and rollback-itself-failed, and is idempotent because pg throws on a double release and that must not replace the real error. **SQLite is untouched by construction rather than by care**: better-sqlite3 has no `checkout`, so the lease is null and the handle is unchanged; the two existing suites (28 and 14 assertions) are the gate and both stay green. **ONE ADDITION BEYOND THE BRIEF, FLAGGED RATHER THAN QUIETLY INCLUDED**: a nested call made on the POOL rather than on `tx` would find depth 0 and queue behind the transaction waiting for it — **a deadlock, on pg only, until the queue is keyed on the checked-out client (G5, item 30).** G5 is not implemented; that case now throws a sentence naming it, because a hung process at 3am is the worst way to meet a known gap. **WHAT THESE THREE STILL CANNOT DO, STATED PLAINLY BECAUSE THE TEMPTATION IS TO READ THEM AS PROGRESS TOWARDS RUNNING**: no call site is converted, no application code has executed against Postgres anywhere, and **one converted transaction still cannot run end to end** — the 27 converted blocks reach statements that call `.prepare` on a handle that does not have it. G20 is untouched. The suites use a recording pool rather than a live server on purpose: what G4 delivers is a statement sequence and a lease lifecycle, and **a live server cannot show that COMMIT reached the same connection BEGIN did, which is the entire defect.** 18 + 11 assertions, both mutation red-proven — the first adds `exec` to the handle, the second drops the lease and runs on the pool, each the exact defect its file exists to prevent. **FOUR THINGS RECORDED AS OPEN AND NOT FIXED, PER THE STANDING DECISION THAT FINDINGS GET WRITTEN DOWN UNTIL THE FLIP HAS A MECHANISM AND A WAY BACK.** **(1) `lib/ops-alert.js:26` AND `lib/gzgrocery-order-notify.js:23` HOLD A SQLITE PATH, NOT A HANDLE, AND THIS IS NASTIER THAN ITS SIZE.** Both open `data/roots.db` directly with `{ readonly: true, fileMustExist: true }`, deliberately avoiding `require('../database')` because it runs schema and migrations on load, and both wrap the read in `catch (_) { return null; }`. **No driver switch can reach them — they read a path.** After runbook step F1 renames `data/roots.db`, both throw, both swallow it, the System Alerts webhook resolves to `''`, and **alerting goes silent at the exact moment of the flip with nothing saying so.** **(2) `database.js` RUNS 305 `addColumn()` CALLS AT LOAD WHOSE "already migrated" CASE IS A CATCH ON `/duplicate column/i`** — better-sqlite3's message text. Postgres's duplicate-column message does not match, so under pg each would throw rather than skip; the early return means none of them runs, which is why the branch is placed above the construction point rather than around the export. **(3) G21 IS SMALLER THAN THE GAP LIST IMPLIES.** `scripts/deploy-apply.sh` **already bounces all six daemons** with `pm2 restart --update-env`, discovering them by `pm2_env.pm_exec_path` so a renamed process still resolves, with the browser holders excluded after a one-line column migration bounced four of them on 2026-07-25 and drew a risk-control challenge. **The mechanism is built and proven; it is keyed on FILES SHIPPING, and a `.env` edit ships no file** — so at a flip the trigger stays 0 and every daemon keeps its SQLite handle while the app moves. What is missing is a flip-triggered, ordered, failure-fatal invocation of machinery that already exists. **(4) THIS SECTION'S OWN CITATIONS FOR THIS AREA HAVE DRIFTED — FOURTH SIGHTING OF THE CLASS.** `module.exports = db` is at `database.js:4753`, not `:4742`; the requiring-file population is **47 runtime / 94 total**, not 49 / 96. The finding each pin supports is unchanged; the pins are not. A decision, three builds, two red-proofs and four open findings; **nothing merged, hence no version claim about production** — and a patch.

2026-08-19 · v4.44 — §24 Database: **THE WALLET BACKFILL RAN ON 2026-08-17 AND NOTHING RECORDED IT. ITEM 42 IS CLOSED, G11 IS CLOSED, CHECK F IS ZERO — AND v4.42 AND v4.43 ARE BOTH CORRECTED HERE, IN THE OPEN, BECAUSE BOTH SAID OTHERWISE.** `retail_topup_transactions` rows **226–232** carry the seven ledger rows `claimMigrationCredit` never wrote; undo file `/root/roots-v2/data/backfill_migration_credit_ledger.undo.json`. With the writer fixed at `225aa13` on 2026-08-13, **both halves of item 42 have been done since 2026-08-17 and all ten invariants pass.** **WHAT IS BEING CORRECTED, PRECISELY: v4.43 says "BUILT, TESTED AND NOT RUN" and "NOTHING HAS BEEN RUN AGAINST PRODUCTION AND THE ¥3,669.64 IS STILL OUT THERE" — false when written. v4.42 says "nothing backfills the seven who claimed before the fix" — false when written.** Status item 42 said NOT BUILT and then NOT RUN, false both times. The cutover runbook's G11, drafted 2026-08-19, said the backfill was unbuilt and built its whole Part G verification on F failing — **an apparatus for tolerating a defect that had been repaired two days before the document was first written.** **THE FINDING IS NOT THE STALE TEXT. IT IS THAT FOUR INDEPENDENT READINGS ALL GOT IT RIGHT FROM THE RECORD AND ALL GOT IT WRONG ABOUT THE WORLD.** The 2026-08-17 run left **no committed script, no §24 entry, no status-doc row change and no commit of any kind.** Every check this project owns reads the repository or the record; **a production money write recorded in neither is invisible to all of them, and stayed invisible through a survey, a re-derivation and a re-verification.** §24 has spent this section recording documents that went stale under the code; **this is the inverse and it is worse — the RECORD was current and complete, and PRODUCTION was ahead of it.** A doc that lags its code is caught by re-reading the code. Nothing catches a database that is ahead of every artefact describing it, which is why **the rule this produces is about the write and not about the reading: a write to production money is not finished when the rows land, it is finished when the entry exists.** Same shape as v4.39, which was written precisely to separate "built" from "run" for the sweep repair — that discipline existed, and this write did not get it. **THE COST WAS A SECOND IMPLEMENTATION OF COMPLETED WORK.** `scripts/backfill_migration_credit_ledger.js` and its 16-assertion suite were designed, built, mutation-red-proven, reviewed, merged at `9c747ac` and **deployed to the box at `2d661ad`** before the original run surfaced. **BOTH ARE RETIRED IN THIS COMMIT RATHER THAN RECONCILED, AND THE REASONING IS THE DECISION**: a backfill is a one-shot historical correction, so once the rows exist every possible future effect of the script is either a no-op or harm — there is no state in which running it again is right. Keeping it would mean maintaining a second implementation so that it can more accurately report having nothing to do, while adding to the ~80 unaudited loose scripts G13 already names as a hazard in a directory that already carries two opposite `--apply`/`--dry-run` defaults. **IT WAS MEASURED BEFORE IT WAS RETIRED, NOT ASSUMED SAFE**: against a fixture reproducing production exactly — six rows on the credit-id key, 57 on `migration:unknown:57` — the shipped script plans nothing, writes nothing under `--apply`, and leaves the checker at ALL 10 PASSED. **It is inert, which makes this housekeeping rather than an incident**, and it is inert because of the ordering fix made during its own build: idempotency is checked before drift, so it distinguishes "a row we wrote" from "explained by something else" instead of reporting both as nothing owed. **RETIRING IT FROM THE REPOSITORY DOES NOT REMOVE IT FROM THE BOX, AND THAT IS THIS PROJECT'S OWN RECORDED PROPERTY** — the deploy never removes a file, proven live at 54 days on `public/retail-admin.js`. It was deployed an hour before it was retired, so **it must be removed from `/root/roots-v2/scripts/` by hand**, which is exactly the operation runbook step F3 exists for and is the first time that step has had a live instance. **ONE DETAIL ABOUT THE SHIPPED ROWS THAT MUST SURVIVE, BECAUSE IT READS AS A MISTAKE AND IS NOT**: six of the seven key `out_trade_no` as `migration:<creditId>:<customerId>`, matching the live writer exactly, and **customer 57 keys `migration:unknown:57`** — correct, because 57 is the tester's archived `_reset_` row and the staging row that would have supplied a credit id had its values overwritten by the re-import recorded in v4.36. **There is no credit id to put in that key and the key says so. Do not normalise it.** The retired script invented `migration:orphan:57` for the same idea in ignorance of the live one, which is the only reason the mismatch was visible at all. **WHAT CLOSES DOWNSTREAM.** Runbook v0.2 → v0.3: G11 marked CLOSED and kept rather than deleted, **step D3's baseline and step G6's diff REMOVED** — that machinery existed only to tell a flip failure from these seven — and **G6 now expects ALL 10 INVARIANTS PASSED outright, reading the exit code rather than an operator's comparison of two text files at 3am.** D3 is not deleted but re-scoped: it is now a go/no-go gate that refuses to start a cutover on books that already fail, **plus the single figure Part G still genuinely has to compare — check P's `ids_missing`**, which is a pure function of the id column, unmoved by trading, and therefore the cheapest instrument for proving the copy preserved keys. **Twenty-two gaps remain of the twenty-three identified; G11's number is not reused.** Item 42 moves to PART 2 per rule 4 with its row struck and left in place. A closure, two entries corrected, a retirement, a hand-removal owed and a rule about when a write is finished; **nothing reversed in the sense rule 5 means — the decisions stand and the facts under two of them did not — hence a patch.**

2026-08-19 · v4.43 — §24 Database: **THE WALLET BACKFILL IS BUILT, TESTED AND NOT RUN — `scripts/backfill_migration_credit_ledger.js`, the second and last half of item 42.** The writer was fixed on 2026-08-13 (`225aa13`); this writes the rows for the seven who claimed before it. **AGAINST A FIXTURE REPRODUCING THE FINDING ROW FOR ROW IT TAKES `check_ledger_invariants.js` FROM "1 OF 10 INVARIANTS FAILED: F" TO "ALL 10 INVARIANTS PASSED", EXIT 1 TO EXIT 0** — the real checker driven as a child process, not this suite's copy of F's query, because the exit code is what Part G of the runbook actually reads. **NOTHING HAS BEEN RUN AGAINST PRODUCTION AND THE ¥3,669.64 IS STILL OUT THERE**; built is not run, and the distinction is the whole reason v4.39 exists as a separate entry from v4.38. **THE ONE THING THE SCRIPT MUST NOT DO IS THE THING IT WOULD BE EASIEST TO WRITE: IT TOUCHES NO BALANCE.** The money is already in the wallet and ¥594.45 of it is already spent; what is missing is the row that EXPLAINS it. **A backfill that also credited the balance would hand seven customers a second copy of money they already hold — ¥3,669.64 of real liability — and check F WOULD STILL PASS, because F compares balance against ledger and that edit moves both.** F cannot detect its own worst failure mode here, so the suite carries the assertion F cannot: balances byte-identical before and after, **and the MUTANT is exactly that edit** — the most expensive plausible change anyone could make to this file — taking 6 of 16 assertions red including the real acceptance test. Per v4.27 the mutation asserts it modified the source before its red counts. **THE AMOUNT WRITTEN IS THE MEASURED DRIFT AND THAT IS A DERIVATION, NOT A PREFERENCE**: writing D moves the ledger sum from L to L+D and F passes when balance == L+D, so D must be balance − L, which is exactly what F reports as `drift`. **Each target is checked against TWO INDEPENDENT SOURCES — the live drift and `retail_migration_credits.balance` — which must agree with the recorded figure AND with each other**; a target whose drift has MOVED is refused rather than adjusted, because moved drift means something happened since the measurement that nobody has looked at. **THE TWO NEGATIVE-LEDGER CUSTOMERS NEEDED NO SPECIAL CASE AND THAT IS WORTH RECORDING**, since it is the shape a repair is most likely to get wrong: 161 and 416 were credited silently and then SPENT with only the spend recorded, so their ledger sums are −¥394.95 and −¥199.50 — but drift is still balance − ledger_sum and one row still closes it (416: ledger −199.50 → +196.50 against a balance of 196.50). The fixture carries them in that real shape rather than flattened to zero. **THE OUT_TRADE_NO SCHEME IS THE LIVE WRITER'S, VERBATIM, AND THAT IS LOAD-BEARING** — `migration:<creditId>:<customerId>`. The claimant is in the key because keyed on the credit row id alone it collides the moment a re-armed staging row is claimed by a SECOND customer, which has already happened once (v4.36, the staging table is not append-only), and check J would then report two legitimate credits as a duplicate; with the claimant in it, the one case that DOES collide is a real double credit that J SHOULD report. Using the same scheme gives the backfilled rows that property too, and J stays at zero — asserted. **CUSTOMER 57 IS THE ONE TARGET THAT CANNOT BE CORROBORATED, AND IT GETS ITS OWN FLAG FOR EXACTLY THAT REASON.** It is the tester's archived `_reset_` row, the ¥9.99 is ours, and its staging value was destroyed by the re-import that overwrote row 1516 — so it is checked against one source where every other target is checked against two, keyed `migration:orphan:57`, and requires `--include-orphan` every run. **It is included rather than dropped because F counts it and Part G cannot expect ALL 10 PASSED while ¥9.99 fails**; zeroing its balance instead was considered and rejected in writing — that destroys data on the one target whose provenance is already damaged and cannot be undone by deleting a row. **WHAT THIS UNLOCKS, STATED SO IT IS NOT MISSED: step D3's baseline and step G6's diff exist ONLY to tolerate this defect.** When the backfill is RUN, G6 can expect ALL 10 INVARIANTS PASSED outright and the whole baseline apparatus comes out of the runbook — the machinery re-derived in v4.42 is machinery with an expiry date, and this is the date. **G11 does not close on a build.** Dry run by default failing closed, fixed list not a query, write-time re-checks on the same preconditions, checksums before and after, an undo file whose instructions are themselves asserted to restore the finding, and `check_ledger_invariants.js` as the acceptance test rather than the script's own output. **Idempotency is ordered before the drift check on purpose** — once the row exists the drift is zero, so a drift-first order reports every re-run as "nothing owed", which is true and is the wrong answer to the question the operator is asking; it also conflates a row we wrote with a balance someone explained by other means, and those must not be conflated. 16 assertions green, one of them labelled SOURCE-level per v4.34 rather than left to read as behavioural; lint clean. A script, a suite, a red-proof and a rejected alternative; nothing reversed, hence a patch.

2026-08-19 · v4.42 — §24 Database: **THE CUTOVER RUNBOOK EXISTS AS A DRAFT AND NOT AS A PROCEDURE — `docs/tacet-postgres-cutover-runbook.md` v0.2, merged fast-forward. IT CANNOT BE FOLLOWED TODAY AND SAYS SO IN ITS FIRST LINE.** Written as an ordered procedure for one non-developer following it literally with the shop trading — every real step carrying a command, a good result, a bad result and a response — and **every step whose machinery does not exist left as a marked hole rather than a plausible-sounding instruction**, because a runbook that reads as complete when it is not gets trusted on the night. **THE DELIVERABLE IS THE GAP LIST, AND ITS PROVENANCE IS THE POINT: this is the FIRST account of what Phase 2 still owes that was DERIVED BY WALKING THE PROCEDURE rather than remembered.** Every prior list — §24's open items, the cutover checklist, the status doc's PART 3 — was written from what someone knew was outstanding. This one was written by asking, at each step in order, *what command does the person type here*, and recording the answer when there was none. **That method found four things no existing list carried**, which is the argument for the method and not merely for the document. **TWENTY-THREE GAPS, G1–G23**, fifteen of them before the day starts: **G1** the code cannot run on Postgres at all (102 unconverted blocks runtime-wide, 29 in `routes/retail.js`) · **G2** `TACET_DB` exists nowhere in the repository · **G3** `lib/pg.js` wired to nothing · **G4** the pg backend of `withTransaction` unwritten · **G5** the queue keyed on the pool, not the client · **G6** `nextOrderNo` Piece 2, nothing reads the counter row · **G7** the idempotency regex matching better-sqlite3's message text · **G8** the `sqlite_sequence` resets with no `setval` replacement, both inside silent catches · **G9** 96 dialect statements plus 371 dynamic ones no static pass reaches · **G10** six statements failing in production today · **G11** the seven customers check F cannot explain · **G12** `reverseOrderBalance` reading its sequence outside its transaction · **G13** the ~80-file `scripts/` audit undone · **G14** fresh-cluster restore unproven · **G15** no green cron run of the Postgres backup tier · **G16** nothing in the application can stop trading · **G17** quiet window or delta pass, nobody has chosen · **G18** no delta-pass tool exists · **G19** no definition of "the delta pass is complete" · **G20** no smoke test against Postgres, no checkout has ever executed on the pg driver anywhere · **G21** the six channel daemons covered by no procedure · **G22** no reverse copy from Postgres back to SQLite · **G23** no rollback trigger, no named decision-maker, no window. **THE FOUR CRITICAL ONES BY NAME — G2, G16, G20, G22.** **G2 AND G22 ARE NOT TWO GAPS AMONG TWENTY-THREE. THEY ARE THE TWO ENDS OF ONE MISSING THING, AND THEY ARE THE REASON PHASE 3 CANNOT START.** There is no built way onto Postgres and no built way back off it: `TACET_DB` does not exist in either direction, and `scripts/postgres-full-copy/` is one-directional by construction — it opens SQLite read-only, proves it read-only on every connection, and writes Postgres; no reverse generator, no reverse verifier, no reverse plan. **§24's own line that cutover and rollback become "a setting plus a restart" is TRUE OF THE CODE PATH AND FALSE OF THE DATA.** The consequence stated the way the night would meet it: **the flip is irreversible from its first second.** Everything else on the list is work; that one is the difference between a reversible night and an irreversible one, and **it is a precondition for beginning Phase 3 rather than an item within it.** **A FINDING IN ITS OWN RIGHT — THE POINT OF NO RETURN IS NOT THE FIRST CHECKOUT.** It is the first write that lands in Postgres and does not exist in SQLite, and **the channel daemons write on their poll cycles whether or not a customer buys anything**: measured drift over one week is `checkout_quotes` **+23,829** and `guanyi_sync_log` **+4,788**. So it arrives **within one daemon poll cycle of the restart.** And because **`pm2 restart roots-v2` does not reload the daemons** (G21), each stays on its SQLite handle while the application moves — **today's default behaviour is not a late point of no return but TWO LIVE DATABASES DIVERGING AT ONCE**, which is worse than either direction alone. **BOTH ANSWERS TO "WHAT STOPS TRADING" ARE UNBUILT, AND THIS IS WHERE §24 OFFERS TWO AND HAS PICKED NEITHER.** There is no maintenance mode, no read-only mode and no write freeze anywhere in the application; the only lever is stopping pm2, which takes down ingest from five channels and costs a risk-control challenge on the browser holders. The alternative §24 names — trade through the copy and rely on a delta pass — **has no tool either**: `run.py` TRUNCATEs and replaces, `drift.sh` counts five tables, `drift_proof.py` explains drift without closing it, and no completion test is defined, so "the delta pass finished" can only mean "the script stopped". **Offering two mechanisms and building neither is not a choice deferred; it leaves the copy provably wrong on arrival.** **AND G11 WAS STALE ON ARRIVAL — CAUGHT AND CORRECTED BEFORE THE MERGE, v0.1 → v0.2.** The draft described both halves of the `claimMigrationCredit` fix as unbuilt; **the writer half landed at `225aa13` on 2026-08-13, six days earlier**, with `scripts/test_migration_credit_ledger.js` and a mutant behind it, and **neither §24 nor status doc item 42 had recorded it** — both are corrected in this pass. Two claims resting on the old reading are struck: *"writes no ledger row"* is false in the present tense, and the **53 unclaimed credits carrying ¥17,362.32 no longer repeat the defect on claim.** **THE GAP DOES NOT CLOSE AND PART G STILL CANNOT EXPECT ALL 10 INVARIANTS PASSED**: nothing backfills the seven who claimed before the fix, so **check F still fails on 7 customers and ¥3,669.64** and the D3 baseline stays. **WHAT THE FIX CHANGED IS THAT THE BASELINE IS NOW SOUND** — before `225aa13` any of the 53 claiming between D3 and G6 would have added itself to F's list, and **a baseline that grows underneath you is not a baseline.** Part G is re-derived per check rather than left as "diff it and see": **F expects the seven BY `drift`, not by text** (`balance`, `ledger_sum`, `ledger_rows` and both timestamps all move if one of the seven trades, and F is `ORDER BY last_row`, so lines change places — `drift` is `balance − ledger_sum` and every audited movement moves both sides equally); **M keeps the diff AND needs more than it**, since three of its four reasons accrue with normal trading so a non-empty diff on M is not a finding, while the fourth was closed 2026-08-17 at `f4a689e4` and was the only one putting stored ABOVE derived — **so a positive drift on anyone but the tester account, or on an order cancelled after that date, is new**; and **P WAS UNDERSOLD BY THE DRAFT** — forensic in normal use, but it is a pure function of the id column and new trading does not move it, so **across a copy that is meant to preserve ids exactly it should be IDENTICAL, and a P that moved is a copy-fidelity failure.** G7 proves the cells; P proves the keys. **TWO LINE-NUMBER CITES RE-DERIVED IN THE SAME PASS, BOTH DRIFTED, AND THIS IS THE THIRD SIGHTING OF THE CLASS AFTER v4.38's `24839` AND v4.41's SURVEY POPULATION** — `reverseOrderBalance` is `:28519–28544`, not `:28459–28484` (that range is now `orderTenders` and `reverseOrderRedeem`), and the admin `sqlite_sequence` reset is `:245`, not `:238`. **The finding stays true while the pin drifts under it, which is precisely what makes the class dangerous: cite by symbol.** Phases stated as three per the 2026-08-10 settlement, with the five-phase reading named as retired so nobody follows the ordering that puts backups after the flip. **The document carries no timeline, no date and no duration, resolves no gap, and carries no reasoning — every "why" cites §24, which wins on any disagreement with it.** Merged fast-forward, no merge commit, and **the blob read back from `origin/main` after the push rather than the push being trusted.** A draft, a gap index, four findings, a correction and a re-derivation; nothing reversed, hence a patch.

2026-08-19 · v4.41 — §24 Database: **THE MONEY CLUSTER DESIGN DOC EXISTS — `docs/tacet-money-cluster-design.md` v1.0, merged at `fde72986`** — the document three separate pieces of work named as a prerequisite and which had never been written. **It is organised by MECHANISM rather than by helper**, because the mechanism is what a converter reasons about: compare-and-set flips (5, survive), the one real `UNIQUE` at `creditLifetimeCommission`, status guards read before the transaction (2, which survive only because a compare-and-set repeats the condition inside), read-then-write markers with nothing behind them (3, which do NOT), and the believed-unique `out_trade_no` that is not (5 writers). Each carries four columns, and **the load-bearing one is "what a reader would see if it broke"** — an invariant nobody can detect breaking is worse than one that errors. **Scope is the 19; the checkout, the poll vote and the four adjust/admin routes CITE it rather than living in it.** **A FINDING THE SURVEY DID NOT HAVE, AND IT CAME OUT OF THE CONSTRAINT CHECK RATHER THAN OUT OF THE SURVEY** — `reverseOrderBalance` reads its sequence number with a `COUNT(*)` outside the transaction it then writes in, so two concurrent partial refunds both compute the same key and both insert; see the entry below, recorded as a defect in its own right. **BOTH CONSTRAINTS APPROVED**, and the second only in its scoped form: a blanket `UNIQUE (order_id, source)` fails on live data for legitimate reasons — **order 873 carries two `order_addon_earn` rows because it has two add-ons, and order 299 carries two `refund_reverse` rows because a clawback and a return share one `source` string.** **Two economic events, one label.** **AND THE SURVEY'S POPULATION CARRIED STALE NAMES FORWARD**: `creditWallet` and `debitWallet` do not exist at this head; those line numbers now belong to `creditReferralReward` and `reverseOrderReferral`, behaviour unchanged. **Plus a rule about how populations are drawn** — see the entry below. **Approving the constraints is NOT scheduling them**; they are pre-flip work needing their own brief with the live-data check re-run at the time. A document, a finding, two approvals and a rule; nothing reversed, hence a patch.

2026-08-19 · v4.40 — §24 Database: **THE PRUNE STEP'S FIRST REAL RUN IN PRODUCTION — `prune=ok eligible=1 removed=1 failed=0 cutoff=20260805`, 2026-08-19 03:30, one prefix removed.** The observability fix is now proven rather than merely deployed, and **the 2026-08-18 check recorded in v4.29 is CLOSED with its deadline met.** Until this run the loop body had never executed against real objects; it has now, and the step reported all four figures itself. **THE PROJECTION SAID `eligible=3` AND THE RUN SAID `1` — THAT GAP IS ARITHMETIC, NOT A FINDING, AND THE REASON IS WORTH MORE THAN THE NUMBER**: the cutoff advances one day per run, so the three prefixes the projection named aged out one at a time across the intervening runs instead of arriving together. **The projection was written for the 18th and read on the 19th.** That is the same defect class as the fixture pinned to real-world dates recorded in v4.29 — there it was caught by a test, here by a reader — and **both go stale silently, which is the property that makes the class dangerous.** What the check existed to establish is satisfied: the step did real work and said so, in figures a later reader can act on. A closed deadline item and a rule reinforced by a second sighting; no decision reversed, hence a patch.

2026-08-18 · v4.39 — §24 Database: **THE SWEEP-CANCEL REPAIR RAN AGAINST PRODUCTION, 2026-08-18 18:59 UTC+8 — the two customers the sweeper shortchanged are whole.** Customer 302: **6 points returned** (2 on order 363, 4 on order 571), each with the `refund_redeem` row that makes a later legitimate reversal a no-op. Customer 506: **`SPROUT` grant 87 released**, global `used_count` 25 → 24. Undo file at `/root/roots-v2/data/undo-repair-sweep-cancel-1787050794887.json`. **IT RAN AGAINST THE SURVEYED STATE AND NOT A DRIFTED ONE, AS EVIDENCE RATHER THAN ASSUMPTION**: all four `checksums_before` in the undo file match the original survey's dry run exactly. **The checksum surface was built as a precaution and is used here as proof** — it is the only thing that separates "the repair ran" from "the repair ran against what was measured", and no amount of re-reading the script establishes the second. Acceptance diff against the pre-run baseline showed **only normal trading; no invariant moved.** **§24 AND THE MIGRATION STATUS DOC'S ITEM 45 BOTH READ "BUILT, TESTED, NOT RUN" — NOW FALSE, AND CORRECTED IN PLACE IN BOTH**, because a status left stale is read as current and this one said two customers were still short. An execution recorded and a status corrected; no decision reversed, hence a patch.

2026-08-17 · v4.38 — §24 Database: **TWO CANCEL PATHS THAT RETURNED NOTHING — BOTH FIXED, TESTED AND DEPLOYED at `f4a689e4`**, and the smaller one is the one that reached customers. **Item 44 is CLOSED**: the five reversals are hoisted out of the `wechatRefundRef` branch and guarded on `o.status !== 'pending_payment'`, so both paid-cancel branches share them. **The reasoning that was missing when it was left open: the branch keys on whether the GATEWAY moved money, and NONE of the six helpers touches the gateway** — they move points, credit and vouchers in our own ledgers, while the gateway's money goes back through `settleOrderRefundAcrossTenders`, untouched. **The double-return worry that kept it open does not hold and is now a test**: four of the five carry their own idempotency, and order 324 — ¥38.80 spent, ¥38.31 already returned — yields ¥0.49 and stops. **A SECOND DEFECT CLOSED BY THE SAME HOIST**: the five sat INSIDE the bookkeeping `try`, so a failed `refund_status` write silently skipped all of them, on the branch that was working. **AND A FIFTH CANCEL PATH THE ENTRY NEVER LISTED** — `sweepExpiredReservations` cancels a `pending_payment` order and called none of the six. **26 orders, 9 customers, and it is the one with real people behind it**: 302 short 6 points, 506 short a ¥20.00 `SPROUT` grant. Fixed first for that reason, since item 44's ¥899.00 is owed to nobody. **THE VOUCHER IS RETURNED THERE AND DELIBERATELY NOT IN BRANCH 3′, WRITTEN SO NOBODY "FIXES" THE INCONSISTENCY**: `reverseOrderVoucher` has no ledger row and puts once-per-order on its CALLER, and the sweeper's conditional `UPDATE ... WHERE status = 'pending_payment'` admits only the winner of that flip to the hook — **that flip IS the contract**, and branch 3′ has no equivalent. The absence is ASSERTED, scoped and matched on the call rather than the name, paired with a check that the helper is still called where it is safe. **The hook fires AFTER the transaction commits**, because each helper opens its own `tdb().transaction()` and nesting maps to a SAVEPOINT pg has no equivalent for — same reason `supersedeUnpaidOrdersForCustomer` already does it that way; see v4.31. **THE SEVEN-SIGNAL CHECK IS RECORDED IN FULL, not as a sentence to trust**: all 26 verified never-paid on seven independent signals (no `paid_at`, no `order_earn`, no settled payment, no referral, no commission, no timestamp past `pending_payment`, no `order_commit` stock row), each returning zero — the next person to widen this re-runs them. **ITEM 44'S REAL-CUSTOMER COUNT IS ZERO**, all 20 orders the tester's, established by openid via an independently written `_reset_` classifier and stated plainly so it is not re-opened as a customer incident; 20 of the 22 paid-then-cancelled orders ever took the defective branch, so it was the COMMON case. **Stock was never affected (10 of 10 committed orders reversed) and neither were points (all 20 below the earn threshold, `order_earn` written at delta 0 — which is why that marker is unconditional, and why the 20 were findable at all).** **CORRECTION IN THE OPEN, per rule 5: the recorded "¥38.80 never returned" was wrong when written, not merely stale** — it read the spend row and did not net off the two `refund_reverse` rows beside it, both stamped BEFORE the cancel. **The outstanding figure is ¥0.49.** ¥899.00 re-measured identically. **The repair for the two real customers is BUILT, TESTED AND NOT RUN** — fixed list not a query, dry-run default failing closed, write-time re-checks, checksums, undo file, and `check_ledger_invariants.js` as the acceptance test rather than its own output. **PLUS A RULE THAT IS NOT NEW, WHICH IS THE FINDING**: the CRLF anchor recurred a fourth time, inside a suite whose own header states the rule, and its mutation red-proof reported a VACUOUS PASS because removing an absent substring changes nothing. Stating the property in prose has now failed four times, so it is given a mechanism — **a suite must ASSERT that no anchor matches /[\r\n]/ before running any of them**, nine such assertions here. **FIFTH named member of the "looks like proof and is not" family; the brief said sixth and the record as written names four, corrected in the open.** **Also recorded: a post-commit hook pushes branches to origin unasked** — inert, since deploy triggers on `main` only, but it is what makes a later `--force-with-lease` fail as a misleading `(offline/auth?)`. AST counts RE-RUN per rule 2 and unchanged — **102 UNCONVERTED runtime-wide, 29 in `routes/retail.js`, 27 CONVERTED**; no transaction block was added. 85 assertions green on the box against the shipped tree; one `roots-v2` pm2 restart, 1323→1324, zero unstable; 238 error-log bytes since boot, all of them one repeat of the routine ALIPAY-not-configured banner; **shipped bytes confirmed by content md5 against the merged blobs for both `lib/inventory.js` and `routes/retail.js`, not by the merge succeeding.** Two fixes, two findings, two rules and a deploy; nothing reversed, hence a patch.

2026-08-13 · v4.37 — §24 Database: **two amendments to the check-F entry, both from a re-measurement against a different backup, and one of them changes who the finding is about.** F was re-run independently against the 15:00 hourly (the original used the 10:00): **F reproduces byte-for-byte — same seven customers, same amounts, same ¥3,669.64** — while the E and G denominators moved by a handful with five hours of trading, which is the expected shape of an honest re-run rather than a discrepancy. **(1) THE SCALE WAS UNDERSTATED BY THE WORD "SEVEN".** `retail_topup_transactions` holds 208 rows of which **only 18 are `status = 'success'`** — the other 190 are abandoned `pending` intents carrying a notional ¥895,000 that F correctly ignores — and those 18 belong to just **7 distinct customers**, while **10 customers hold a non-zero balance and 7 of them fail F**. So the finding is not seven customers against a large ledger: **it is 7 of the 10 customers holding wallet money, and 7 missing rows against the 18 that exist, meaning 28% of every settled wallet row that should exist was never written.** **(2) ONE OF THE SEVEN IS NOT A CUSTOMER.** Customer 57 is `_reset_1781343070821_oeqDi5KI8…`, an archived row left behind by `/api/retail-admin/customers/:id/reset-test`, sharing its openid stem with customers 64 and 233 — **six of the seven are real people; the ¥9.99 is ours.** That also explains why 57 alone cannot read its amount from the staging table: of 102 claimed credit rows exactly **6** carry a balance and they sum to **¥3,659.65**, matching the six real customers to the fen, with the seventh's value overwritten by the re-import recorded in the next entry. **SEPARATELY, M's CUSTOMER 233 IS IDENTIFIED AS THE TESTER ACCOUNT AND SAYS SO IN M's OWN OUTPUT**, so nobody chases it twice — same openid stem as the two `_reset_` rows, **63 CANCELLED orders against 4 delivered**, and the formula figure of 780.00 is exactly those 4. **The note is deliberately TWO claims and only one of them is reassuring:** the ACCOUNT is test data, so nobody is owed anything and no customer sits in a tier they did not earn; **the DEFECT is real code on a live path open to everyone and it stays open.** A tester found it first because a tester cancels sixty-three orders and a customer cancels one — a statement about who exercises the path, not about whether the path is broken. Amendments and an identification; nothing reversed, hence a patch.

2026-08-13 · v4.36 — §24 Database: **CHECK F FAILED ON LIVE DATA — the first money inconsistency this project has found by MEASUREMENT rather than by accident.** `scripts/check_ledger_invariants.js` run against a copy of the 10:00 hourly, read-only at the driver, live file never opened. **Nine of ten invariants passed; F failed on seven customers holding ¥3,669.64 of wallet balance that no ledger row explains.** **THE CAUSE IS AN ASYMMETRY INSIDE ONE FUNCTION**, and it is recorded as such because it is the evidence this was an oversight and not a decision: `claimMigrationCredit` credits `retail_customers.balance` at `:12017` with no ledger row, and **eleven lines later at `:12021` writes the `retail_points_transactions` row for the points half** — same function, same transaction, one half audited and one not. Seven customers, claims dated **2026-06-13 to 2026-07-28**; six reconcile to the fen against `retail_migration_credits.balance` (¥3,659.65), and **two have NEGATIVE ledger sums** (161, 416) because they were credited silently and then spent with only the spend recorded — 416 checks out exactly at ¥396.00 credited, ¥199.50 spent and logged, ¥196.50 left. **LIVE, NOT HISTORICAL: 53 unclaimed credits carrying ¥17,362.32 will each do this again on claim.** **No customer is short** — the money is there and ¥594.45 of it is already spent — **but the missing explanation costs three things**: invisible in wallet history, permanently flagged by every reconciliation, and **lost entirely if a balance is ever rebuilt from the ledger, which is exactly what a cutover verification does.** **THE PASSES ARE RECORDED TOO AND THEY ARE WHAT MAKE THE FAILURE TRUSTWORTHY** — **E passed across all 1,177 customers** and **G across all 696 points rows**, plus H I J K L N O at zero; nine clean invariants over the same tables on the same read are why F's seven are a measurement rather than a suspicion. **TWO MORE FINDINGS, RECORDED SEPARATELY.** **(1) `retail_migration_credits` IS NOT APPEND-ONLY** — a re-import replaced row 1516's values and reset `claimed_at` on an ALREADY-CLAIMED row, re-arming it, and a second customer claimed the refreshed credit; exactly one `migration` points row in the database has no credit row pointing back, and it is the victim's. **Nothing prevents this recurring**, and the reason is structural rather than accidental: **`UNIQUE (phone)` is what forces an import to UPDATE in place instead of inserting, so the constraint that keeps the roster clean is the one that makes a re-import destructive.** It also constrains the fix — any `out_trade_no` keyed on the credit row id alone collides the moment a re-armed row is claimed twice, which is not hypothetical. **(2) OPEN — A PAID ORDER CANCELLED WITH NO GATEWAY REFUND REVERSES NOTHING.** The `:24839` branch — the order was paid off-app cash/manual, or DEV — closes a stuck refund request and calls **none** of the six reversal helpers. Measured across every order: 20 orders, 1 customer, **¥899.00 of `lifetime_spend` retained** and **¥38.80 of wallet balance never returned**. **This is M's FOURTH structural reason and the only one that produces stored ABOVE derived**, which the shipped note asserted was impossible; the note is corrected in the same pass. Tier consequence is real but **not yet realised** — the ladder is 0/4,000/6,000/10,000 and the one affected customer sits at 1,679 against a real 780, both below the first threshold. **AND THE PART TO REMEMBER: THAT CUSTOMER PASSES CHECK F.** The spend was logged, the balance matches the ledger, the books are internally consistent, and the customer is still ¥38.80 short — **a reconciliation that passes is not a proof of correctness.** Both affected accounts are internal, which bounds today's customer impact at zero and says nothing about the paths, which are live for everyone. One measured failure, two findings, one open item; nothing reversed, hence a patch.

2026-08-13 · v4.35 — §24 Database: **two findings from the ledger-writer survey, both about a guard that is weaker than the thing asserting it.** First, **THE DIALECT SWEEP'S INCOMPATIBILITY TABLE IS SHORT, AND THE MISSING RULES LAND INSIDE MONEY WRITERS.** `PG_INCOMPATIBLE` in `scripts/diagnose_statement_sweep.js` carries twelve rules and has none for **two-argument `MAX()`/`MIN()`** — a SQLite scalar function that Postgres does not have at all, where `max` is only an aggregate. Four real instances in static SQL and **two of them are inside ledger writers**: `reverseOrderPoints` at `routes/retail.js:27910` (`lifetime_spend = MAX(0, COALESCE(lifetime_spend,0) - ?)`) and `finalizeOrderAddon` at `:28639` (`shipping_fee = MAX(0, …)`); the other two are the refund paths at `:17539` and `:24542`. **These do not degrade, they ERROR**, and each one aborts the whole enclosing money transaction. There is no rule for **`datetime()`** either — **up to 64** static SQL literals, stated as "up to" because the sweep `break`s on its first matching rule, so an unknown share of the 64 is already counted under `julianday` or another entry; `sweepExpiredPoints:27614` is one of them. **THE POINT IS NOT THE TWO CONSTRUCTS, IT IS THAT THE 96 IS A FLOOR FOR A SECOND REASON NOBODY HAD NAMED.** §24 already records the 371 dynamic statements as the blind spot; this is a different one — **the table is short, not the technique**, and that is the fixable half. A rule added to `PG_INCOMPATIBLE` finds every instance forever; a statement missed because it was assembled at runtime never will be. Second, **`retail_topup_transactions.out_trade_no` IS NOT UNIQUE ON EITHER ENGINE, AND FIVE WRITERS KEY IDEMPOTENCY ON IT** — `creditWallet`, `debitWallet`, `creditLifetimeCommission`, `reverseLifetimeCommission`, `reverseOrderBalance`. A plain non-unique index on SQLite (`idx_retail_topup_outtrade`) and **no constraint of any kind on the cluster**, verified against `docs/tacet-postgres-schema-as-built-2026-08-11.sql` rather than inferred from `database.js`. **The code says both things about itself in two places.** `creditReferralReward:16310` states it correctly and warns against relying on the column; `finalizeOrderAddon:28669` asserts the opposite — "Unique out_trade_no makes the credit idempotent across retry callbacks" — and then relies on it with an `INSERT OR IGNORE` that has no constraint to conflict against and will simply insert a second row. **The credit is nonetheless safe today, and NOT for the reason the comment gives**: the outer claim at `:28604` — `UPDATE retail_order_addons SET status='success' WHERE id=? AND status='pending'` — returns `changes === 0` on a re-fire and bails the whole body before the credit is reached. **THE GENERAL SHAPE, WHICH IS THE PART WORTH KEEPING: a guard that works for a reason its comment does not give is a guard nobody can safely move.** The next person to refactor `finalizeOrderAddon` will preserve the `INSERT OR IGNORE` and drop the claim, because the comment told them where the safety was. Same family as the `:20241` comment corrected in v4.34 — a comment that answers for the code — and the third instance recorded. Two findings, nothing reversed, hence a patch.

2026-08-12 · v4.34 — §24 Database: **`POST /api/retail-admin/orders` is NOT the money cluster — CLASSIFIED, CONVERTED and DEPLOYED at `61007342`**, closing PHASE 2 OWED WORK item 2. **The discriminator is recorded as a METHOD, not a verdict**: read the write sets against each other, and **the pending `retail_payments` row appears in BOTH this transaction and the checkout's, so it cannot be what makes something money** — the points ledger, the topup ledger and the balance write are, and this transaction has none of the three. **The original "straddles the money cluster" was inferred from the `nextOrderNo` CALL rather than from reading the write set**, which is a signal about order numbering and none at all about money; recorded because the same wrong inference is available on the next route. **The interleaving analysis in full, because it is why this was safe:** the conversion's one real behaviour change is an `await` in front of the post-commit money work, so **whole blocks can now reorder — but no block can split**, measured rather than assumed (the post-commit block has no `await`, and `markOrderPaid` has none either; its only async call is fire-and-forget). **THE INVARIANT: every post-commit path is keyed on an identifier exclusive to its own request, and every cross-order write is additive SQL rather than a JS read-modify-write** — named guards: `markOrderPaid`'s compare-and-set on `status = 'pending_payment'`, `awardOrderPoints`' `order_earn` idempotency row plus additive `+ ?` customer writes, and `creditLifetimeCommission`'s `UNIQUE (order_id)` **verified on both engines rather than taken from the comment claiming it**. **A FINDING OF ITS OWN — THE MUTANT THAT SURVIVED.** Rewriting `tx.prepare(` to `tdb().prepare(` changed nothing, because on SQLite `tx` IS the handle passed in. **A mutation that cannot change behaviour cannot be caught by behaviour**, even when it is well-formed and satisfies v4.27's must-assert-it-mutated rule. **So the `tx`-versus-`tdb()` discipline is SOURCE-enforced, not behaviour-enforced, and becomes behavioural only at the flip** — with the rule that **a suite must say which of its assertions are source-level and which are behavioural rather than letting both read as proof.** This is the **FOURTH** member of the "a run that looks like proof and is not" family, after the two comment-blind source guards and the CRLF anchor. The mutant that does mean something drops the `await` and takes **8 of 9** behavioural tests red. **The post-commit boundary is load-bearing and must not be moved**: `geocodeOrderSnapshotAsync`, `claimMigrationCredit`, `reconcileSignupVouchers`, `logActivity` and `markOrderPaid` stay outside, and moving any one inside makes this a money-cluster change. **The `:20241` comment was FALSE and is corrected** — a deferred `BEGIN` does not serialize the mint against the INSERT; what makes it safe today is topology alone (fork mode, single instance, synchronous driver, `UNIQUE` as backstop) and **all of it inverts at the flip**. Counts, labelled by form and never blended: **UNCONVERTED 30 → 29 in `routes/retail.js`, 103 → 102 runtime-wide; CONVERTED 26 → 27.** Green on **both drivers**, including better-sqlite3 on the box against the shipped tree; one pm2 restart, zero unstable, 238 log bytes all routine; shipped bytes confirmed by content and a normalised sha1, not by the merge. **Two harness defects found by running rather than reading** — a `\n` anchor against a CRLF file, and an assertion matching `markOrderPaid()` inside a comment, **the comment-stripping class again**. **Plus one OPEN item for the money cluster design doc that still does not exist:** every guard here was measured against a synchronous driver, and at the flip the post-commit block becomes genuinely interruptible rather than merely reorderable — true of the money cluster whether or not this route converted. A classification, a conversion, a deploy, a finding and an open item; nothing reversed, hence a patch.

2026-08-11 · v4.33 — §24 Database: **`retail_order_counters` EXISTS ON THE CLUSTER — 162 tables to 163**, row at `('TC', 0)` and **deliberately UNSEEDED** (`last_no` 0 against a measured maximum of 168); seeding belongs to the cutover and was not run. v4.32's "it does not exist on the box" is **superseded rather than edited**, because it records why the create was held back. **The DDL file had to be fixed before it could be applied, and that is the interesting part: as written it ran the seed as its third statement, contradicting the rule stated twenty lines above it in the same file** — a file that states an ordering rule and then violates it on apply is worse than one that never stated it, because the rule reads as satisfied. Found by asking what applying it would do rather than by reading it. **As-built regenerated as `docs/tacet-postgres-schema-as-built-2026-08-11.sql`, with the body PROVEN verbatim rather than asserted** — strip the 44-line hand-written header and the remainder hashes to the raw `pg_dump -s --no-owner` output, `61f77078…b7bf`. The 2026-08-04 file is retained byte-for-byte and carries no banner, following the phase-1 precedent that the superseding file carries the note. **AND THE REGENERATION FOUND SOMETHING THIS WORK DID NOT CAUSE: the new dump is 2,145 lines longer, and the difference is 303 `GRANT … TO tacet_app` statements the 2026-08-04 record does not contain at all — it names `tacet_app` zero times.** The grants postdate it, so **the as-built record has been silent on the entire permissions layer ever since, and nothing noticed** — this file has exactly two consumers and both parse it for `CREATE UNIQUE INDEX` lines and nothing else. **A record can go stale on 303 statements without a single reader being affected, which is how it stays stale.** Unique indexes measured unchanged at 15 across both files, so both consumers are provably unaffected today and were deliberately not repointed; they open the dated name and will need repointing the first time an index changes. An application, a regeneration and a finding; nothing reversed, hence a patch.

2026-08-11 · v4.32 — §24 Database: **ORDER NUMBERING IS A COUNTER ROW, NOT A SEQUENCE — DECIDED, and Piece 1 is BUILT.** Settles candidate 1 of the three v4.30 left open, by rejecting it before anything was built. **The deciding reason is not cost — the two are the same amount of work, which is why cost cannot be the argument.** It is that **a counter row survives the Orders stage by gaining a column where a sequence has to be torn out**, which would migrate `nextOrderNo` a second time on the checkout, the most expensive place in the system to change twice; that **row-level security covers rows and does not cover sequences**, so per-account sequences would need `GRANT` as a second hand-maintained wall, the exact shape this section already rejected; and that **one global sequence lets an account read platform-wide order volume off the gaps between its own numbers**, an inference leak no row policy can close. Gaps are accepted and not re-litigated; one global counter row serialises checkouts exactly as `BEGIN IMMEDIATE` does today, so it is **not a regression**, and it stops serialising across accounts the moment the account column lands. **THE ENTRY THAT MATTERS MOST IS THE ONE ABOUT NEITHER OPTION: per-account numbering becomes GLOBAL at the flip regardless of this work** — the `MAX` read carries no account predicate, the scoping is purely which SQLite file `tdb()` resolved to, and one shared database with `order_no` globally `UNIQUE` and no account column until the Orders stage produces the same global space either way. **The risk is not that it changes, it is that it changes without being written down and is rediscovered when a second account is already trading and neither can be renumbered.** Records that **nothing parses the format** — `SUBSTR(order_no, 3)` appears once in all of `*.js`, no `ORDER BY order_no` exists, every other consumer displays, `LIKE`-searches, sanitises or uses it whole — so a gap breaks nothing because there is no parser to break. Records that **past 1,000,000 the format outgrows its own eight-character `LIKE` filter**, not pressing at 247 orders in fourteen months, recorded because the fix removes it and because that same width-locked filter would have mis-seeded the counter had it been used for the seed. **Piece 1 built: the table, the row at 0, and a seeding step with a receipt** — `series` is a key rather than decoration because an unkeyed counter table's second row is a silent duplicate-number generator, `last_no` is the last number ISSUED so the seed is the measured maximum with no arithmetic and nowhere for an off-by-one to hide, and the row exists at 0 so an unseeded counter fails visibly on `UNIQUE` rather than handing a caller an absent order number. **Seeding is LAST, after the fresh copy AND after the delta pass** — measured 2026-08-11, Postgres holds 168 `TC` orders against SQLite's 247, so a counter seeded from the 2026-08-04 copy would be 79 short and the first 79 checkouts would collide. **`setseq.py` will never reach it, and not for the reason first written down**: not an empty `pg_get_serial_sequence` but that a counter row is not a sequence at all and is absent from `plan.json` entirely. **Proven on the box and then torn down** — DDL and seed run inside a rolled-back transaction, then all four seeding paths exercised for real, then the table dropped and the cluster verified back at 162 tables; **it does not exist on the box and creating it is a deliberate step, not a side effect.** **One defect found by running it rather than reading it**: the script parsed `UPDATE … RETURNING`'s output and received `"168\nUPDATE 1"`, because `psql -tA` prints the command tag — the fourth instance here of a step that read correctly and did not run. **Piece 2 designed and NOT built**, with the single most important line recorded as such: **the probe loop must not survive onto the pg path**, or a mis-seeded counter is hidden forever behind hundreds of wasted round trips per order instead of failing loudly on the constraint. Blocked behind both call sites; caller 2 is the cheaper. **Three items explicitly NOT covered**: `po_number` and `rs_number` carry the identical read-MAX defect, `lib/qingyun-payload.js` hardcodes the first business's name onto every parcel, and two comments still claim order numbers start with 'R'. A decision, a build and a settled open item; nothing reversed, hence a patch.

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

> ⚠️ **THE FRONT-END COUNT IS SUPERSEDED — §28, 2026-08-24. PRODUCTION IS NOT A FRONT END.** It is a MODULE inside Tacet; no separate Production application exists and none will be built, so *"merges into Tacet later, leaving three"* describes a merge with nothing to merge. There are THREE front ends: Tacet, the online store, and the Back Office. **The rest of this list stands** — the front end really is the only app-specific layer, and everything beneath it really is shared. That was the claim Production-as-a-module makes truer, not falser.

### Back end
- ONE service, ONE API. Not one per app.
- A set of SHARED MODULES, each built once. Eight named so far: Locations, Products, Items, Stock, Users, Orders, Purchasing, Recipes. MORE WILL BE NAMED — eight is not a ceiling. Already visible but not yet specified: suppliers, customers, marketing, content and media, integrations, reporting, billing.
- Every module is available to any front end. Which modules a front end uses depends on what that front end is for, not on staging. Production uses Items and Recipes; Tacet does not, because selling does not involve them. The online store reads Products, Stock and Locations and writes nothing. This does not change when the apps merge — the modules were always shared; the split was only ever in the interface.
- Permissions are capability-based and enforced in the back end.
- FRONT ENDS NEVER TOUCH THE DATABASE. A screen asks the back end; the back end reads the database.

### Database
- ONE database. Each thing exists in it exactly once. No duplicated tables, no sync jobs between them.
- Money stored as whole cents, never as a decimal.

> ⚠️ **THAT SECOND LINE IS DEAD — SUPERSEDED 2026-08-05, v2.0. Money is stored as DECIMAL, not whole cents.** It is left standing and marked rather than edited, per house convention. **It has read as a live rule ever since the reversal, and it sits in the list a reader is most likely to treat as current**, which is why the marker is here and not only in §24. **The reversal is the changelog entry `2026-08-05 · v2.0 — MONEY STORAGE IS REVERSED` at the head of this file, and §24 MONEY IS STORED AS DECIMAL, NOT WHOLE CENTS.** Asked of the live cluster on 2026-08-21: **101 money columns are `numeric(14,6)` and ZERO are bigint cents.** The only integer-cents columns remaining are the four literally named `*_cents` on the billing tables — `billing_invoices.amount_cents`, `billing_plans.price_cents`, `plans.price_cents`, `tenants.setup_fee_cents` — which §24 records as deliberate and which this marker does not touch.

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

> ⚠️ **VOCABULARY ONLY — THE DECISION ITSELF STANDS.** §28 renames ITEMS to MATERIALS as the tenant-facing word (2026-08-24); *item* was ambiguous with *product* in conversation. **Nothing in this section is reversed** — two separate lists, two tables, separate stock, no sellable switch, and a recipe as the only bridge are all still the model, and the cashews→cream→cheese worked example still describes exactly what must be supported. Read ITEMS as MATERIALS throughout.

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

> ⚠️ **VOCABULARY ONLY — THE DECISION ITSELF STANDS.** Read *item* as MATERIAL throughout (§28, 2026-08-24). **The unit model is untouched** — one stocking unit per material, purchasing in any unit with a stored conversion, recipes always in the stocking unit. One open question this section does not settle is recorded in §28: whether a purchased quantity converts to a stocked quantity at all. Nothing in the code does that conversion today.

## 8. Packaging

- Jars, lids, labels and bags are ITEMS. Bought, stocked, costed and TRACKED by quantity.
- Consumed by the packing step, so cost rolls up automatically.
- Displayed separately from ingredients on screen — ingredients in one group, packaging in another. One mechanism underneath.
- Reason for tracking rather than costing only: running out of jars stops production exactly as running out of an ingredient does.

> ⚠️ **VOCABULARY ONLY — THE DECISION ITSELF STANDS.** Jars, lids, labels and bags are MATERIALS (§28, 2026-08-24). **The decision stands and this section is now easier to state**, because *material* covers packaging without the strain *ingredient* put on it — which is the same reason the word changed. Live data agrees: 145 of the 630 rows in `ingredients` are already `item_kind = packaging`.

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

> ⚠️ **VOCABULARY ONLY — THE DECISION ITSELF STANDS.** This is MATERIAL STATE (§28, 2026-08-24). **The two positions are unchanged.** Note for anyone implementing it: the live behaviour does NOT match this yet — archiving an ingredient also destroyed its SKU until 2026-08-24, against §18.

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

> ⚠️ **VOCABULARY ONLY — THE DECISION ITSELF STANDS.** Read ITEMS as MATERIALS (§28, 2026-08-24), and *"for finding things in the kitchen"* as *for finding things in the store room* — a hardware shop files materials too. **The separation itself stands**, and the reasoning for it is if anything stronger under the new word: a material category is a filing system, a product category is shop navigation.

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

> ⚠️ **TWO THINGS IN THIS SECTION ARE SUPERSEDED BY §28 (2026-08-24), AND THEY ARE NOT THE SAME KIND OF CHANGE. NEITHER IS EDITED.**
>
> **1. ITEMS — vocabulary only. The module stands.** The module is now MATERIALS. *Items* was ambiguous with *Products* in conversation, which is exactly the confusion the line below it warns against. **PRODUCTS and MATERIALS remain SEPARATE modules and must still never be presented, grouped or built as one** — that instruction is unchanged and the rename does not soften it.
>
> **2. FOUR FRONT ENDS — the substance is wrong, not the wording.** There are THREE: Tacet, the online store, and the Back Office. Production is a MODULE inside Tacet, not a front end, and no separate Production application will be built. The sentence *"Items and Recipes are Production-only until the apps merge"* has no merge to wait for; those modules are gated by whether a tenant has the Production module enabled, not by which app someone opened.
>
> The paragraph's other claim — that the online store is not separately maintained and reads the same modules — **is untouched and still correct.**

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

> ⚠️ **ITEM 9 IS PART-VOID AND ITEM 6 IS VOCABULARY ONLY — §28, 2026-08-24.**
>
> **Item 9: "the Production app merging into Tacet" IS NOT DEFERRED, IT IS CANCELLED.** There is no Production app to merge; Production is a module inside Tacet. Multi-currency and additional languages are still deferred exactly as written, so the item is not struck out — only its third clause is void.
>
> **Item 6: "PRODUCTS AND ITEMS" reads PRODUCTS AND MATERIALS.** Vocabulary only; the stage, its position in the order and its dependencies are unchanged.
>
> **The ordering is not otherwise reopened by §28.** §28 scopes phase 1 to Materials and Purchases, with Recipes deferred — which is a scope statement about the Production module, not a re-cut of this list.

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

> **BOTH ITEMS IN THAT SENTENCE ARE NOW SUPERSEDED, AND NEITHER IS EDITED.** **(a) money as whole cents** was reversed on 2026-08-05 by MONEY IS STORED AS DECIMAL, NOT WHOLE CENTS, later in this section. That reversal left the superseded line standing, correctly, but never marked it here — so clause (a) has read as a live rule for sixteen days. It is marked now. **The identical line survives unmarked in §0 Governing rules under Database, where it sits in a LOCKED list and is read far more often than this sentence is** — recorded rather than edited, because §0 was outside the scope of the work that found it. A reader who meets that line anywhere should read it as dead. **(b) the tenant→account rename** is declined by THE TENANT→ACCOUNT PHYSICAL RENAME IS DECLINED (2026-08-21), at the end of this section. **The sentence itself is left standing because its EFFICIENCY ARGUMENT is what both supersessions turn on** — not the two rules, but the claim that a rebuild made them free. A reader who meets that claim elsewhere needs to be able to find its source.

NOTE — money conversion is near-total but not universal. During the Phase 1 schema translation, 101 REAL money columns were converted to integer cents. ⚠️ **THAT UNIT IS SUPERSEDED — those 101 columns are `numeric(14,6)` today, not integer cents; the schema they landed in was rebuilt as decimal and re-copied on 2026-08-06.** The rest of this NOTE — which columns were left unconverted, and why — still stands. **The reversal is the changelog entry `2026-08-05 · v2.0 — MONEY STORAGE IS REVERSED` at the head of this file, and §24 MONEY IS STORED AS DECIMAL, NOT WHOLE CENTS.** Two categories were deliberately left unconverted: percentage columns, and one polymorphic column, retail_vouchers.value, which holds a money amount for fixed-amount vouchers but a percentage for percent vouchers. Converting it as-is would corrupt the percent rows. Decision: leave retail_vouchers.value unconverted in Phase 1; split it into separate amount and percentage handling at the Stock stage, where the money model is built properly. Also flagged for the later data-copy phase: one retail_vouchers row has a non-ISO date (2026/10/6) that must be fixed before data is copied across.

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

> ⚠️ **THIS CONVERSION RULE IS SUPERSEDED — 2026-08-05, v2.0.** REAL yuan converts to `numeric(14,6)` yuan, not to bigint cents. The rule is left standing because the rehearsal it describes really did run this way and the second sentence — do not re-multiply a column already named in cents — is still live and still the trap. **The reversal is the changelog entry `2026-08-05 · v2.0 — MONEY STORAGE IS REVERSED` at the head of this file, and §24 MONEY IS STORED AS DECIMAL, NOT WHOLE CENTS.**
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

⚠️ **SUPERSEDED 2026-08-05, v2.0 — read the whole of this paragraph as history.** Whole cents is no longer correct for transaction amounts either: the reversal took ALL money to decimal, not just the nine unit costs this paragraph splits out. The `numeric(14,6)` half of it survived and became the settled scale at v3.0. **The reversal is the changelog entry `2026-08-05 · v2.0 — MONEY STORAGE IS REVERSED` at the head of this file, and §24 MONEY IS STORED AS DECIMAL, NOT WHOLE CENTS.**

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

⚠️ **THE PREMISE OF THIS ENTIRE SECTION IS SUPERSEDED — 2026-08-05, v2.0, AND WITH IT THE DEFECT IT DESCRIBES.** The 92 columns are `numeric(14,6)` decimal YUAN today, not bigint cents, so the application reading and writing yuan is reading and writing the same unit the database holds. **There is no 100-fold display error and no boundary layer is owed.** The section is left standing because the reasoning in it — where a unit boundary belongs, and what a missing one costs — is what the decimal decision was taken against. **The reversal is the changelog entry `2026-08-05 · v2.0 — MONEY STORAGE IS REVERSED` at the head of this file, and §24 MONEY IS STORED AS DECIMAL, NOT WHOLE CENTS.** Asked of the live cluster on 2026-08-21: **101 money columns are `numeric(14,6)` and ZERO are bigint cents.** The only integer-cents columns remaining are the four literally named `*_cents` on the billing tables — `billing_invoices.amount_cents`, `billing_plans.price_cents`, `plans.price_cents`, `tenants.setup_fee_cents` — which §24 records as deliberate and which this marker does not touch.

The full data copy changed the unit of 92 columns from REAL yuan to bigint cents, plus nine unit-cost columns to numeric(14,6). The application reads and writes yuan and has zero conversion sites. Pointed at Postgres unchanged, every price displays 100 times too high and every total sums in the wrong unit. This is the largest single item in Part 2 and is not solved by any driver or compatibility work. Survey recorded at docs/tacet-money-model-survey.md.

DECIDED — the conversion happens at the boundary, not in the application. One layer between the application and the database converts on the way out and on the way back in, rather than hundreds of edits across the call sites. The alternative was rejected because there is no test suite and no automated correctness gate beyond node --check, so hundreds of hand edits carry worse odds than one carefully built converter.

DECIDED — the layer returns yuan. The application already contains a working conversion boundary at the payment gateway: seven sites do Math.round(Number(order.total) * 100) on the way out and verify fen on the callback. If the layer returned cents, all seven would double-convert and charge customers 100 times the correct amount.

⚠️ **REVERSED 2026-08-06, v3.0 — see §24 `expense_entries.amount` IS DECIMAL, NOT WHOLE CENTS later in this section.** That entry already supersedes this line; the marker is here because the line carried none and reads as decided. **The reversal is the changelog entry `2026-08-05 · v2.0 — MONEY STORAGE IS REVERSED` at the head of this file, and §24 MONEY IS STORED AS DECIMAL, NOT WHOLE CENTS.**

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

### THE DEPLOY PIPELINE RE-STAMPS `sw.js`, SO THE CACHE STRING IN A COMMIT NEVER SHIPS — RULE 2026-08-20

The installer rewrites the `CACHE` constant in `public/sw.js` to a deploy timestamp after installing it — for example `roots-v2-shell-20260820-170427`. Whatever value is written into the commit is discarded.

What this means in practice:

- Including `sw.js` in a commit is the *trigger* for a cache re-stamp. The string chosen in the commit is not the mechanism and is not what lands.
- Any admin or storefront asset change needs `sw.js` touched in the same commit, or warm browsers keep serving the old bundle. Commit `4d5bf7d3` changed the New-order wizard without touching `sw.js`, and operators continued seeing the pre-fix address fields until the next commit that did.
- Never write a deploy verification step that greps the server for the literal CACHE string from the commit. It will always fail. Verify the timestamp format instead, or verify that the deploy log contains a `stamped sw.js CACHE ->` line.

Established 2026-08-20, commit `163a723b`.

### READ-ONLY SSH TO PRODUCTION IS AVAILABLE, AND THE RULE SAYING IT WAS NOT IS WRONG — RECORD CORRECTED 2026-08-20

THE RULE NOW. Read-only SSH to the production box is available and works, and is the right way to establish ground truth about the live server: file hashes, the deploy state under `/root/roots-v2/.deploy-state/`, row counts, config values in `storefront_config`, log contents, pm2 status. **Read-only checks are not routed through Ash.** A question about what production actually holds is answered by reading production.

THE BOUNDARY THAT STANDS, AND IS NOT WHAT WAS WRONG. Destructive and state-changing operations on production remain Ash's to run: writes to the live database, service restarts, deletions, cron and config changes — anything that alters what production holds. **That boundary is about blast radius, not about access**, it was correct before this correction and it is correct after it, and nothing here loosens it. The two were bundled into one rule, and only the access half was false.

WHAT DISPROVED IT, RECORDED SO IT CANNOT BE REVERSED ON RECOLLECTION. On 2026-08-20 the claim was tested directly against `/root/roots-v2/public/till.html`. Claude reported `md5 = 5bdbd103e32c3fea1eca43f53811989a`. Ash independently ran `ssh root@47.239.89.63 "md5sum /root/roots-v2/public/till.html"` from his own PowerShell and got the same 32 characters. **Two independent reads of the same file agreeing is what makes the read genuine rather than merely plausible** — a fabricated or cached value would have had no reason to match a hash Ash had not yet produced.

WHAT IT COST WHILE IT STOOD. Read-only checks were routed through Ash that Claude could have run itself, and briefs were written instructing Claude to hand over commands for him to paste. **The brief that produced this correction is itself an instance**: it closed by asking for "the exact read-only SSH command to run from PowerShell", on the stated grounds that Claude had no such access — while the same session had already used that access repeatedly.

WHERE THE RULE ACTUALLY LIVED, AND THE PRECISION THAT MATTERS. It was never in this document — greps for `no ssh`, `cannot ssh`, `sandbox`, `ground truth`, `PowerShell` and `disposable` return nothing here, and nothing across any `*.md` in the repository. It was one line in the operator's working notes, written in a session where the auto-mode classifier genuinely did refuse every `ssh` and `scp`. **And the classifier still refuses SOME command shapes**: on 2026-08-20 two read-only `ssh` calls were refused — a `for` loop over several files, and one carrying a `-json` flag — while the identical reads succeeded when reissued as plain single commands. So the accurate statement is **ACCESS EXISTS; SOME COMMAND SHAPES ARE REFUSED** — a per-command friction to rephrase around, not an absence of capability. **The original note generalised one session's refusals into a standing incapacity, which is how a true observation becomes a false rule** — and the false version outlived the condition that produced it by months, because nothing beside it said what would overturn it.

**THE RULE THAT FOLLOWS: a claim about what Claude cannot do must name the test that would overturn it.** A capability rule with no stated test is unfalsifiable in practice — nobody re-checks it, because there is nothing to re-check — and it decays silently as the environment changes underneath it. The test for this one is written above: run the same read twice, from two sides, and compare.

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

- [ ] **SEED `retail_order_counters` LAST — AFTER THE FRESH COPY AND AFTER THE DELTA PASS, IMMEDIATELY BEFORE TRAFFIC MOVES.** Run `scripts/postgres-full-copy/seed_order_counter.py`. Seeding is not a step of the schema build, and the ordering is the whole of its value: the counter must sit above the highest order number that exists at the moment traffic arrives, not above the one that existed when the copy was taken. **Measured 2026-08-11 — Postgres holds 168 `TC` orders, SQLite holds 247.** A counter seeded from the 2026-08-04 copy would be 79 short, and the first 79 checkouts after the flip would collide one after another on `retail_orders_order_no_key`. Re-running after a second delta pass is safe and expected: the seed is `GREATEST`-guarded and can only raise the value. The script refuses to create the table — `docs/tacet-postgres-order-counter.sql` does that, by hand, and the as-built schema record is regenerated with a fresh `pg_dump -s` in the same pass. **`setseq.py` does not do this and never will**: it walks `plan.json` for identity columns, and a counter row is not a sequence. Reasoning in §24 ORDER NUMBERING IS A COUNTER ROW.

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

⚠️ **"CENTS" HERE IS THE `plan.json` CONVERSION CLASS AS IT STOOD ON 2026-08-05, NOT THE STORAGE UNIT TODAY.** Those columns are `numeric(14,6)` now; the `cls: CENTS` set was moved to `NUM6` when the copy was rebuilt as decimal. **The finding itself is untouched by that** — it is about WHICH SITES WRITE MONEY, and the unit is incidental to it. §24 MONEY IS STORED AS DECIMAL, NOT WHOLE CENTS.

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

> **RUN 2026-08-19 03:30 — PASSED, deadline met, item CLOSED.** The log line read `prune=ok eligible=1 removed=1 failed=0 cutoff=20260805`, and one prefix was removed. **`eligible` was 1 rather than the 3 expected below, and that is arithmetic rather than a finding:** the cutoff advances one day per run, so the three prefixes named here aged out one at a time across the intervening runs instead of arriving together. **The expectation below was written for the 18th and was read on the 19th** — a figure pinned to a date is only true on that date, the same way the stale fixture recorded further down this section was. **What the check existed to establish is satisfied:** the loop body executed against real objects for the first time, deleted what it listed, and said so in figures. The expectation below stands unedited, since it is what the fix was scheduled against; read its `eligible=3` as the 18th's figure and not as the pass condition.

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

> **SETTLED 2026-08-11 — see ORDER NUMBERING IS A COUNTER ROW, NOT A SEQUENCE, immediately below.** None of the three candidates above was taken as written. The entry is left standing because the list is where the decision was made from, and because the reasoning that rejected two of them is only legible against it.

### ORDER NUMBERING IS A COUNTER ROW, NOT A SEQUENCE — DECIDED 2026-08-11

**DECISION: `nextOrderNo`'s read-MAX-then-INSERT is replaced on Postgres by one `UPDATE … RETURNING` against a single counter row in a new table, `retail_order_counters`. Not a sequence, not an advisory lock, not serializable-with-retry.**

A sequence was chosen first and reconsidered before anything was built. **The reconsideration is the substance of this entry**, because the two options are close enough in effort that the effort is not what decides between them.

**THE FOUR REASONS, IN THE ORDER THEY MATTER.**

1. **It is the same amount of work either way.** A table plus `UPDATE … RETURNING` against a sequence object plus `nextval`. Nothing in the cost of building it distinguishes them, so cost cannot be the argument, and an argument from cost would have been the wrong one to accept.

2. **A COUNTER ROW SURVIVES THE ORDERS STAGE; A SEQUENCE HAS TO BE TORN OUT.** This is the decisive one. When the account column lands on `retail_orders`, a counter row gains an `account` column and its `WHERE` gains a term. A sequence cannot be made per-account at all — sequences are schema objects, so per-account numbering would mean one sequence per account, created by DDL at account provisioning, resolved at mint time through dynamic SQL. **That is a second migration of the same function, on the checkout, which is the single most expensive place in the system to change twice.**

3. **ROW-LEVEL SECURITY COVERS ROWS. IT DOES NOT COVER SEQUENCES.** §24 decided that the database is the enforcer precisely so that a missed filter in application code cannot leak another account's data. Access to a sequence is governed by `GRANT`, not by a row policy — so per-account sequences would need a second, hand-maintained wall alongside the one being built. **That is the shape this section already rejected once**, and rebuilding it under a different name would be the same defect in a different place.

4. **ONE GLOBAL SEQUENCE CREATES AN INFERENCE LEAK THAT RLS CANNOT CLOSE.** Under a single shared number space, an account reads platform-wide order volume off the gaps between its own consecutive order numbers. Every value involved is one the account is entitled to see, so no row policy can prevent it. **A per-account counter never creates the condition.**

**ACCEPTED COST, AND IT IS NOT A REGRESSION.** One global counter row serialises every checkout until the account column lands, because the row lock is held to commit. `BEGIN IMMEDIATE` does exactly that today, across processes, for the whole transaction. The counter is therefore not slower than what it replaces; it stops serialising across accounts the moment the account column exists, which `BEGIN IMMEDIATE` never would have. **Gaps are accepted and are not to be re-litigated**: a rolled-back order burning a number was weighed against the alternatives and is the smaller cost.

#### PER-ACCOUNT NUMBERING BECOMES GLOBAL AT THE FLIP REGARDLESS OF THIS WORK

**This is the most important paragraph in the entry, and it describes something none of the options above causes.**

**Today order numbering is per-account, but only by file separation.** `nextOrderNo`'s `MAX` read carries no account predicate — `routes/retail.js:9324` reads `FROM retail_orders` unqualified. The scoping is entirely a property of which SQLite file `tdb()` resolved to. Two trading accounts would each hold their own `retail_orders` and each would start at `TC000001`, and both would be valid.

**At the flip that property disappears on its own.** One shared database; the account column comes AFTER the flip, staged; and `retail_orders.order_no` is globally `UNIQUE` in the proposed schema and in the database as built (`retail_orders_order_no_key`, verified on the box 2026-08-11). Carrying `SELECT MAX` across unchanged would produce exactly the same global number space, plus the MVCC race. **Nothing about choosing a counter row causes this and nothing about choosing a sequence would have avoided it.**

**THE RISK IS NOT THAT IT CHANGES. THE RISK IS THAT IT CHANGES WITHOUT BEING WRITTEN DOWN**, and is then rediscovered when a second account is already trading — which is the expensive moment to discover it, because by then both accounts have numbers and neither can be renumbered. It is written down here so that the Orders stage inherits a decision to make rather than a surprise to absorb.

**The property has never been exercised.** All five `data/tenants/*.db` on the box hold zero rows in `retail_orders` (measured 2026-08-11); the accounts that owned them were deleted 2026-08-04. There has only ever been one account, so no second number space has ever existed to collide.

#### NOTHING PARSES THE FORMAT — SURVEYED 2026-08-11

**Measured across the tree, because a gap is acceptable and a parser that breaks on one is a different question.**

**`nextOrderNo` is the only thing that derives the number back out of the string.** `SUBSTR(order_no, 3)` appears exactly once in all of `*.js`, at `routes/retail.js:9324`. There is no JS-side `.slice(2)`, `.substring(2)`, `parseInt(order_no…)`, `/^TC/` or `startsWith('TC')` anywhere.

**No `ORDER BY order_no` exists in the codebase.** Every order list sorts by `placed_at` or `id`. Nothing assumes order numbers sort in creation order.

**Every other consumer displays it, `LIKE '%…%'`-searches it, sanitises it, or uses it whole as an opaque key.** The printer (`lib/feie.js`, six sites) prints it double-width and depends only on length. Qingyun trims it into a remark. Nuonuo dedupes e-invoices on it and needs uniqueness, not contiguity. The tracking pages sanitise it to `[A-Za-z0-9_-]`. Guanyi does not touch it at all. The payment path builds `out_trade_no` as `'FC' + order_no` and dispatches the async callback on `startsWith('FCTU')` / `startsWith('FCAO')`, neither of which a `TC` number can match — a format-preserving change leaves it untouched.

**Conclusion: a gap breaks nothing, because there is no parser to break.**

#### PAST 1,000,000 THE FORMAT OUTGROWS ITS OWN FILTER — RECORDED, NOT PRESSING

`nextOrderNo` formats with `padStart(6,'0')` but filters with `LIKE 'TC______'`, which is exactly eight characters. **At 1,000,000 the function stops being able to see its own output**: the `MAX` read regresses to the highest six-digit value, the `exists` probe walks forward one row at a time, and past fifty collisions it falls through to `'TC' + next + oneRandomDigit`, which is not unique by construction.

**Not pressing — 247 orders in fourteen months.** Recorded because the counter removes the condition rather than because it is near, and because the same width-locked filter would have silently mis-seeded the counter if it had been used for the seed. It is not.

#### PIECE 1 — BUILT 2026-08-11. SCHEMA AND SEEDING ONLY

**No JavaScript. Nothing on the SQLite side. Nothing requires any of it.**

- **`docs/tacet-postgres-order-counter.sql`** — the table, the row, and the seed statement, with the shape reasoning inline.
- **`scripts/postgres-full-copy/seed_order_counter.py`** — the seeding step, with a receipt.

**THE SHAPE: `retail_order_counters (series text PRIMARY KEY, last_no bigint, updated_at timestamptz)`, one row, `('TC', 0)`.**

**`series` is a key, not decoration.** Without it the table has no primary key and "there is exactly one row" is an invariant enforced by nothing — and a second row in an unkeyed counter table is a silent duplicate-order-number generator.

**`last_no` is the last number ISSUED, not the next one to issue.** Chosen so the seed value is the measured maximum with no arithmetic applied to it. There is no `+1` anywhere in the seeding path, so there is nowhere for an off-by-one to hide.

**The row is created at 0 by the DDL, deliberately.** If the row were absent, the mint's `UPDATE` would match nothing, `RETURNING` would yield nothing, and the caller would receive an absent value where an order number belongs — which is how `TCundefined` reaches a customer-facing column. With the row present at 0, an unseeded counter instead fails on the `UNIQUE` constraint at `TC000001`, loudly, on the first checkout. **Both are failures; only one of them is visible.**

**The format stays in the application.** No `prefix` or `width` column. Putting the format in the table would create a second source of truth for it. (When the prefix eventually has to become per-account — `TC` is a constant inherited from the first business — this table is its natural home and `series` is what makes that additive too. A note, not a plan.)

**HOW IT BECOMES PER-ACCOUNT, STATED HONESTLY.** The column add is additive; the key change is one constraint swap on a table holding one row per account. `ADD COLUMN account integer REFERENCES accounts (id)`, backfill, `DROP CONSTRAINT … _pkey`, `ADD PRIMARY KEY (account, series)`, enable RLS, add the policy — and the application's `WHERE` gains a term. **The backfill is written as a lookup, never as a literal account id**, per NO ACCOUNT IS SPECIAL-CASED, INCLUDING ROOTS. No account number appears anywhere in the file as built.

**THE SEED, AND WHY IT USES A REGEX.** `order_no ~ '^TC[0-9]+$'` with `substring(order_no from 3)::bigint`. `LIKE 'TC______'` is width-locked to eight characters and would silently exclude a seven-digit number, seeding BELOW the true maximum — the precise failure the step exists to prevent. `GREATEST` makes it idempotent and one-directional: a re-run can only raise the counter, never lower it into numbers that already exist.

**WHERE IT SITS: LAST, AFTER THE FRESH COPY AND AFTER THE DELTA PASS, IMMEDIATELY BEFORE TRAFFIC MOVES.** Seeding is not a step of the schema build. **Measured 2026-08-11: Postgres holds 168 `TC` orders while SQLite holds 247** — a counter seeded from the 2026-08-04 copy would sit 79 short, and the first 79 checkouts after the flip would collide one after another. On the whole table the drift is +121 rows. Added to the cutover checklist above.

**`setseq.py` will never reach this, and not for the reason first written down.** The first account of this said `pg_get_serial_sequence` would return empty. That is true and irrelevant: **a counter row is not a sequence at all.** `setseq.py` walks `plan.json` for `identity` columns; `retail_order_counters` has none, owns no sequence, and is absent from `plan.json` entirely, because `plan.json` describes the 162 tables copied from SQLite and this table exists only in Postgres. There is no path through that script that reaches this row. It needs its own named step, which is what was built.

**PROVEN ON THE BOX, THEN TORN DOWN.** The DDL and the seed were run against the live `tacet` database inside a transaction that rolled back, then the whole seeding path was exercised for real: the missing-table guard fired, the seed raised 0 → 168, a second run was correctly idempotent, and a counter deliberately set ahead of the data warned and exited non-zero without being lowered. The table was then dropped and the cluster verified back at 162 tables. **The table does not exist on the box. Creating it is a deliberate step, not a side effect of this commit.**

**ONE DEFECT FOUND BY RUNNING IT RATHER THAN READING IT.** The seeding script first parsed the value out of `UPDATE … RETURNING`'s output. `psql -tA` prints the command tag after the returned row, so it received `"168\nUPDATE 1"` and died. `setseq.py` never met this because it only ever issues `SELECT`s. The script now ignores the write's output and reads the value back with a separate `SELECT`, with a comment recording that the two statements are two connections and why that is acceptable here and nowhere else. **Recorded because it is the fourth instance in this section of a step that read correctly and did not run.**

#### PIECE 1 APPLIED TO THE BOX — 2026-08-11, SAME DAY, AS A SEPARATE STEP

> **The paragraph above ends "it does not exist on the box and creating it is a deliberate step". That step has now been taken, and the sentence is superseded rather than edited** — it was true when written and it records why the create was held back, which is the part worth keeping.

**`retail_order_counters` EXISTS ON THE CLUSTER. 162 tables → 163.** The row is `('TC', 0)`, created 2026-08-11 18:02:15+08. **It is DELIBERATELY UNSEEDED** — `last_no` is 0 while the measured maximum in Postgres is 168. Seeding belongs to the cutover and was not run.

**THE DDL FILE HAD TO BE FIXED BEFORE IT COULD BE APPLIED, AND THE DEFECT IS THE INTERESTING PART.** As first written it ran the seed as its third statement — so applying it would have seeded the counter, **contradicting the rule stated twenty lines further up in the same file: seeding is not a step of the schema build.** A file that states an ordering rule and then violates it on apply is worse than one that never stated it, because the rule reads as satisfied. The seed is now a comment pointing at the Python step, and the file's own apply path can no longer seed. **Found by asking what applying the file would actually do, not by reading it.**

**THE AS-BUILT RECORD IS REGENERATED: `docs/tacet-postgres-schema-as-built-2026-08-11.sql`.** A real `pg_dump -s --no-owner -d tacet`, the command the previous record names for its own regeneration. **The body is proven verbatim rather than asserted**: strip the 44-line hand-written header and the remainder hashes to `61f77078…b7bf`, byte-identical to the raw dump. The 2026-08-04 file is **RETAINED byte-for-byte unchanged and carries no banner**, following the phase-1 precedent exactly — the superseding file carries the note, the superseded one is left alone.

**AND THE REGENERATION FOUND SOMETHING THIS WORK DID NOT CAUSE.** The new dump is 2,145 lines longer than the old one, which is far more than one table explains. **The difference is 303 `GRANT … TO tacet_app` statements that the 2026-08-04 record does not contain at all — that file names `tacet_app` zero times.** The grants therefore postdate it, and **the as-built record has been silent on the entire permissions layer ever since.**

**Nothing noticed, and the reason is worth stating.** This file has exactly two consumers — `scripts/diagnose_seam_statements.js` and `scripts/diagnose_statement_sweep.js` — and both parse it for `CREATE UNIQUE INDEX` lines and nothing else. A record can go stale on 303 statements without a single reader being affected, which is precisely how it stays stale. **Unique indexes are unchanged at 15**, measured across both files, so those two consumers are provably unaffected today and were **deliberately not repointed** — both open the 2026-08-04 file by its dated name, and they will need repointing the first time an index changes. Recorded rather than fixed, because repointing them is a JavaScript change and this was a schema step.

**What is NOT done: the counter is not seeded**, and that is the cutover checklist item above, not this one.

#### PIECE 2 — DESIGNED, NOT BUILT

**Blocked, and the blocking is the point of writing it down now.**

**`nextOrderNo` takes an optional trailing handle**, evaluated per call, no call site edited — PATH A STEP 2's rule, applied one level up. **It was never on that list and should have been.** Today it reads `tdb()` twice from ambient scope, which is why no test can hand it a Postgres-shaped handle, which is why the pg path cannot be proven before the flip.

**A duck-typed branch that THROWS on an unrecognised handle**, copying `control()`'s third branch in `lib/db-transaction.js`. **The stakes are higher here than there.** A silent fallback to the SQLite path on a pg handle does not fail — it mints duplicate order numbers under load.

**THE PROBE LOOP MUST NOT SURVIVE ONTO THE PG PATH. This is the single most important line in the design.** The loop exists on SQLite to walk past collisions. Carried onto Postgres it would walk past the collisions of a mis-seeded counter too — silently, forever, at hundreds of wasted round trips per order, with the misconfiguration hidden behind a function that appears to work. Without it, the first checkout fails loudly on `retail_orders_order_no_key`. **That constraint is the backstop and it stays.** The mint must also throw when the `UPDATE` returns no row rather than formatting whatever it received.

**BLOCKED BEHIND BOTH CALL SITES, because `nextval`-shaped work is awaited and an `await` needs an async body.** Caller 2, `POST /api/retail-admin/orders` (`routes/retail.js:20064`), is a synchronous handler with a synchronous transaction body — PHASE 2 OWED WORK item 2, in neither conversion pool — **and it is the cheaper of the two.** Caller 1, the checkout, is the larger one. Piece 1 is deliberately independent of both and can land first, which it has.

#### EXPLICITLY NOT COVERED BY THIS WORK

**`po_number` and `rs_number` have the identical defect and are not fixed here.** `routes/retail-purchasing.js:39` reads `MAX(CAST(SUBSTR(po_number, 5) AS INTEGER))` for `RPO-%`, and `routes/restock.js:468` counts on `substr(rs_number,4,6)`. Both are read-MAX-then-insert and both inherit the same MVCC unsafety at the flip. **Recorded so they are not assumed covered by an order-numbering decision that names only orders.**

**`lib/qingyun-payload.js:585` hardcodes `Roots ${order_no}` as the goods name on every delivery push.** A second account's parcels would ship labelled with the first account's business name. §0 governing rule 2. Its own item; not now.

**`routes/retail.js:3315` and `:3320` both say "Order numbers start with 'R'".** True of the 232 legacy `R*` orders on the box and false of everything minted since. The reasoning those comments support is still correct — `FCTU` and `FCAO` cannot collide with `FCTC` either way — but the fact they cite is not. **Not fixed in this commit**, which touches no JavaScript by design; recorded so the next reader does not trust it.

### `POST /api/retail-admin/orders` IS NOT THE MONEY CLUSTER — CLASSIFIED AND CONVERTED 2026-08-12

**PHASE 2 OWED WORK item 2 is closed.** The route was found as a fifth step-2 route nobody had counted, flagged as straddling the money cluster, and left in neither pool. It is now classified, converted and deployed at `61007342`.

#### THE DISCRIMINATOR IS A METHOD, NOT A VERDICT

**Read the write sets against each other. That is the whole technique, and it is reusable on the next route that looks money-adjacent.**

| | this route's tx | the checkout's tx |
|---|---|---|
| `retail_orders`, `retail_order_items` | ✓ | ✓ |
| `retail_payments` (pending intent) | ✓ | ✓ |
| **`retail_points_transactions`** | — | ✓ |
| **`retail_topup_transactions`** | — | ✓ |
| **`UPDATE retail_customers SET`** (points / balance) | — | ✓ |

**The pending `retail_payments` row appears in BOTH, so it cannot be what makes something money.** What makes the checkout money is the points ledger, the topup ledger and the balance write. This transaction has none of the three. It writes an order, its lines, a payment intent, and — only when `save_customer` is set — one identity row.

**THE ORIGINAL CLASSIFICATION WAS INFERRED FROM A CALL, NOT FROM A WRITE SET.** "Straddles the money cluster" came from noticing that the route calls `nextOrderNo()`, the same function the checkout calls. That is a real signal about *order numbering* and no signal at all about *money*. **A route is in the money cluster because of what its transaction writes, not because of who else calls the helpers it calls.** Recorded as the correction, because the same inference will be available on the next route and will be wrong there too.

**WHAT WOULD HAVE MADE IT MONEY, STATED SO THE LINE IS TESTABLE.** The route DOES reach money — `claimMigrationCredit`, `reconcileSignupVouchers`, and `markOrderPaid` (which reaches `awardOrderPoints`, `creditReferralReward`, `creditLifetimeCommission`). All of it is post-COMMIT, outside the transaction, each call in its own `try`/`catch`, two of them opening their own transactions. **Moving any one of them inside the block makes this a money-cluster change.** That boundary is load-bearing and the suite asserts it in both directions.

#### THE INTERLEAVING ANALYSIS — THE REASON THIS WAS SAFE TO CONVERT

**The conversion has exactly one real behaviour change, and it is not in the transaction.** Today the handler is fully synchronous, so nothing yields between COMMIT and the post-commit money work. After conversion there is an `await` in front of it.

**WHAT CAN NOW REORDER.** Order A's entire post-commit block can run during order B's transaction statements, and between B's COMMIT and B's own post-commit block. That is impossible today.

**WHAT CANNOT SPLIT, AND THIS IS THE PART THAT MAKES IT SAFE.** Measured, not assumed: the post-commit block contains **no `await`, no `.then`, no yield**, and `markOrderPaid` contains none either — its only async call, `maybeAutoIssueInvoice(...).catch(...)`, is fire-and-forget. **Once a continuation starts it runs to completion.** A's `awardOrderPoints` cannot be interrupted by B's. Whole blocks reorder; no block is ever split.

**THE INVARIANT: every post-commit path is keyed on an identifier exclusive to its own request, and every cross-order write is additive SQL rather than a JS read-modify-write.** Reordering whole blocks cannot change an additive result. The specific guards, because "they each open their own transaction" is true and insufficient:

- **`markOrderPaid` — a COMPARE-AND-SET on status.** Every money call sits behind `if (r.changes > 0)`, where `r` is `UPDATE retail_orders SET status='paid' … WHERE id = ? AND status = 'pending_payment'`. A second fire changes 0 rows and does nothing. A SQL-level single-fire guard, not a JS flag.
- **`awardOrderPoints` — an explicit IDEMPOTENCY ROW.** `retail_points_transactions WHERE order_id = ? AND source = 'order_earn'`, which its own comment calls the single marker for both the points award and the `lifetime_spend` bump. Its customer writes are additive SQL — `lifetime_spend = COALESCE(lifetime_spend,0) + ?`, `points_balance = points_balance + ?` — so two orders for one customer give the same total in either order, and `balance_after` and `reconcileTier`'s input are both read INSIDE the same transaction after the update, so each ledger row is self-consistent for its position.
- **`creditLifetimeCommission` — `UNIQUE (order_id)`, VERIFIED ON BOTH ENGINES** rather than taken from the comment claiming it: `sqlite_autoindex_retail_lifetime_commissions_1` on the live SQLite database and `retail_lifetime_commissions_order_id_key` in Postgres.
- **`creditReferralReward`** — a compare-and-set state transition, `WHERE id = ? AND status = 'joined'`.
- **`claimMigrationCredit` / `reconcileSignupVouchers`** — gated on `customerCreated`, true only when this request's own transaction INSERTed the row, so concurrent requests hold disjoint customer ids by construction. `withTransaction`'s per-handle queue serialises the transactions, so a second request's reuse-by-phone lookup sees the first's committed customer — the protection the synchronous version had, preserved.
- **stock** — the only genuinely cross-order state, reachable via `prepareCommitUnreservedOrder` on a Guangzhou delivery. This route's transaction touches no stock at all, and the checkout is still fully synchronous, so neither can be interleaved into.

#### THE MUTANT THAT SURVIVED — FOURTH IN THE "LOOKS LIKE PROOF AND IS NOT" FAMILY

**The first mutation written for the conversion suite rewrote `tx.prepare(` back to `tdb().prepare(` — writes escaping the transaction — and EVERY TEST STAYED GREEN.**

**That is not a hole in the suite. On SQLite `tx` IS the object passed in**, so `tdb()` and `tx` are the same connection and both statements join the same transaction. `lib/db-transaction.js` says so in its own header: *"On SQLite `tx` is the same object that was passed in, so it looks redundant. On pg it will NOT be."*

**THE GENERAL SHAPE, WHICH IS THE POINT: A MUTATION THAT CANNOT CHANGE BEHAVIOUR CANNOT BE CAUGHT BY BEHAVIOUR.** The mutation was well-formed, it modified the source, and the v4.27 rule (a mutation must assert it mutated) was satisfied — and it still proved nothing, because on this driver the two forms are the same program.

**THE RULE THAT FOLLOWS: a suite must say which of its assertions are SOURCE-level and which are BEHAVIOURAL, rather than letting both read as proof.** Here the `tx`-versus-`tdb()` discipline is **source-enforced only** — one assertion that no ambient `tdb()` survives inside the transaction body — and the suite says so in a comment at the mutation block instead of implying it demonstrated both. It becomes a behavioural property at the flip, where `tx` is a checked-out client and `tdb()` is the pool. **Until then, that discipline rests on a source match, and a reader is entitled to know that.**

**This is the FOURTH occurrence of the class recorded at THREE HARNESS DEFECTS and extended at v4.27.** The first two were comment-blind source matching — the harness's `FOREIGN KEY` strip, and the `PUT /integrations` guard matching `process.env` inside the comment saying it must not be touched. The third was the CRLF anchor that matched nothing and produced ten red lines proving nothing. **The family now has four members and one requirement: a test harness must be able to fail for the reason it claims.** The mutation that does mean something here drops the `await` — the classic failure of this exact conversion, the handler racing past an unresolved transaction — and takes **8 of 9** behavioural tests red.

#### THE `:20241` COMMENT WAS FALSE AND IS CORRECTED

It read *"Order-no minted inside the tx so the uniqueness check + INSERT serialize."* **A deferred `BEGIN` does not serialize a read against a later write.** The checkout takes `BEGIN IMMEDIATE` for that; this route never has.

**What is actually true today, and all of it is topology rather than design:** the app runs pm2 **fork mode, single instance**, so one process serves every minting route; better-sqlite3 is synchronous, so a transaction body runs to completion without yielding and two operators cannot interleave; and `order_no` is `TEXT UNIQUE NOT NULL` as a hard backstop. The residual is a rare spurious failure rather than a duplicate — another process committing inside the read-to-write window makes SQLite refuse the write on a stale snapshot, which `busy_timeout` cannot wait out.

**ALL THREE INVERT AT THE FLIP** — async handler, every statement a round trip, genuine interleaving — and read-max-then-INSERT becomes a real duplicate race. ORDER NUMBERING IS A COUNTER ROW is what closes it, for this route and the checkout alike.

#### COUNTS, LABELLED BY FORM

**UNCONVERTED `<handle>.transaction(fn)`: `routes/retail.js` 30 → 29, runtime-wide 103 → 102.**
**CONVERTED `withTransaction(handle, fn)`: `routes/retail.js` 26 → 27.**
From `scripts/diagnose_async_conversion_scope.js`, never from a grep. **No blended total is printed, here or anywhere.**

#### WHAT LANDED, AND WHAT PROVED IT

Two commits, fast-forward, no merge commit. **`a94a19e7`** threads `createOrReuseManualCustomer` on a trailing optional handle — it stays SYNCHRONOUS, so v4.30's rule that a helper may go async only when every caller is async does not bind and must not be read as satisfied. Its other caller, `POST /api/retail-admin/customers`, is unedited. **`61007342`** converts the route.

**The real handler is EXTRACTED FROM `routes/retail.js` AND EXECUTED, not reproduced.** Rollback is asserted on **exact row sets** — a forced failure at the last write leaves no order, no items and no customer — because a partial rollback is also non-zero and also data loss. The post-commit boundary is proven **positively**: each spy queries the database as it runs and must SEE the committed order, so a spy that merely counted calls could not pass. Both halves are covered: a throw in `markOrderPaid` or `claimMigrationCredit` does not undo the committed order and still answers 200.

**Green on BOTH drivers** — `node:sqlite` locally and **better-sqlite3 on the box against the shipped tree**, where the mutant also takes 8 of 9. Deploy: one pm2 restart (1314 → 1315), zero unstable, and **238 bytes appended to the error log, all of it the routine ALIPAY-not-configured boot banner**. Shipped bytes confirmed by content and by a line-ending-normalised sha1 identical on both sides, not by the merge.

**NO CONCURRENCY IS CLAIMED.** Fork mode plus a synchronous driver means a converted handler still cannot interleave with itself, so a suite spawning two calls in one synchronous block would be green and prove nothing — the mistake recorded in `lib/db-transaction.js`.

#### TWO HARNESS DEFECTS, FOUND BY RUNNING RATHER THAN READING

1. **A `\n` anchor matched nothing against a CRLF file.** `routes/retail.js` is CRLF in a Windows checkout, so a source assertion written with `\n` silently never ran — a green assertion, not an error. Line endings are now normalised at read.
2. **An assertion matched `markOrderPaid()` inside a COMMENT** — "markOrderPaid() flips it below", which sits INSIDE the transaction block — and reported the call as having moved into the transaction. **This is the comment-stripping class again**, the one with a standing rule since `PUT /integrations`: any source-level assertion must strip comments before matching. It did not, and it was caught only because the suite failed on its own assertion. Comments are now stripped before that match.

#### OPEN — FOR THE MONEY CLUSTER DESIGN DOC, WHICH STILL DOES NOT EXIST

**Every guard above was measured against a SYNCHRONOUS driver.** At the Postgres flip each statement is a round trip and the post-commit block becomes **genuinely interruptible** — not merely reorderable. The compare-and-set, the idempotency row and the `UNIQUE` constraint all still hold as constraints, but the reasoning that "a continuation runs to completion" does not, and the analysis has to be redone against a driver that yields mid-block.

**This is true of the money cluster whether or not this route was converted**, so it is not a debt this conversion created and not one it can discharge. It belongs to the money cluster's design document — PHASE 2 OWED WORK still records that no such document exists.

### THE DIALECT SWEEP'S TABLE IS SHORT, AND TWO OF THE MISSING RULES ARE INSIDE MONEY WRITERS — FOUND 2026-08-13

`scripts/diagnose_statement_sweep.js` is the authority behind "96 statements will not run on Postgres". It prepares every static statement against SQLite and then regex-matches it against `PG_INCOMPATIBLE`, a table of twelve constructs. **The table has no rule for two-argument `MAX()`/`MIN()`.**

**That is not a behavioural difference, it is an error.** SQLite has `max(a, b)` as a scalar function. Postgres has `max` only as an aggregate, so `max(integer, integer)` does not resolve and the statement fails. The portable spellings are `GREATEST` and `LEAST`.

**Four real instances in static SQL, and two are inside ledger writers:**

| Site | Statement | In the money cluster? |
|---|---|---|
| `routes/retail.js:27910` | `reverseOrderPoints` — `lifetime_spend = MAX(0, COALESCE(lifetime_spend,0) - ?)` | **yes** |
| `routes/retail.js:28639` | `finalizeOrderAddon` — `shipping_fee = MAX(0, COALESCE(shipping_fee,0) - ?)` | **yes** |
| `routes/retail.js:17539` | refund lines — `refunded_qty = MIN(qty, …)` | no |
| `routes/retail.js:24542` | refund payments — `refunded_amount = MIN(amount, …)` | no |

Both money instances sit **inside** a transaction, so the failure is not one bad column — it aborts the whole block. `reverseOrderPoints`' block also writes the `refund_reverse` ledger row, which is its idempotency marker; losing the transaction loses the marker, and the next call tries again.

**There is no rule for `datetime()` either — UP TO 64 static SQL literals.** Stated as *up to* rather than as a count, deliberately: the sweep `break`s on the first rule that matches, so an unknown share of the 64 already appears in the 96 under `julianday` or another entry, and claiming 64 new statements would be the same kind of overstatement this section exists to stop. `sweepExpiredPoints:27614` is one of them.

**THE FINDING IS NOT THE TWO CONSTRUCTS. IT IS THAT 96 IS A FLOOR FOR A SECOND, DIFFERENT REASON.** This section already records the first — 371 statements assembled at runtime that static preparation cannot reach. That blind spot is a property of the technique and cannot be closed by trying harder. **This one is a property of the table, and the table is a list somebody wrote.** A rule added to `PG_INCOMPATIBLE` finds every instance of that construct forever, including the ones written next year. So the two blind spots must not be reported as one number: one is irreducible and one is an afternoon.

**HOW THIS WAS MISSED, RECORDED SO THE NEXT AUDIT DOES NOT REPEAT IT.** The table was written by listing SQLite functions that Postgres lacks — `IFNULL`, `GROUP_CONCAT`, `strftime`, `printf`, `INSTR`, `typeof`. Every entry is a function that **does not exist** on the other side. `MAX` and `MIN` exist on both, and the incompatibility is in the ARITY, not the name. **A name-based table cannot see an arity mismatch**, and nothing about the table's shape says it only covers names.

### `out_trade_no` IS NOT UNIQUE, FIVE WRITERS BELIEVE IT IS, AND THE CODE SAYS BOTH — FOUND 2026-08-13

`retail_topup_transactions.out_trade_no` carries **a plain non-unique index on SQLite** (`idx_retail_topup_outtrade`) and **no constraint of any kind on PostgreSQL**. Verified against `docs/tacet-postgres-schema-as-built-2026-08-11.sql` — the regenerated as-built record — rather than read off `database.js`, per the rule that a schema claim comes from the engine.

**Five writers key idempotency on it:** `creditWallet`, `debitWallet`, `creditLifetimeCommission`, `reverseLifetimeCommission`, `reverseOrderBalance`. For contrast, `retail_payments.out_trade_no` **does** carry a partial unique index, which is presumably where the belief came from — the two tables are siblings in the callback path and only one of them is protected.

**THE CODE STATES BOTH POSITIONS, TWENTY THOUSAND LINES APART.**

- `creditReferralReward:16310` is correct and explicit: double-pay is prevented by the `status='joined'` guard and better-sqlite3's in-process serialization, **not** by a DB constraint — *"retail_topup_transactions.out_trade_no has only a plain (non-unique) index, so do not rely on it as an idempotency key."*
- `finalizeOrderAddon:28669` asserts the opposite — *"Unique out_trade_no makes the credit idempotent across retry callbacks"* — and then relies on it at `:28672` with `INSERT OR IGNORE`, which has no constraint to conflict against. On a second call it does not ignore; it inserts. `credIns.changes === 1`, and the wallet is credited again.

**THE CREDIT IS SAFE TODAY, AND NOT FOR THE REASON THE COMMENT GIVES.** The outer claim at `:28604` — `UPDATE retail_order_addons SET status = 'success' … WHERE id = ? AND status = 'pending'` — returns `changes === 0` on a re-fire and returns from the transaction body before the shipping credit is reached. That compare-and-set is atomic on both engines and it is the real guard. It is forty lines above the comment that credits a different mechanism.

**THE GENERAL SHAPE, WHICH IS WHY THIS IS RECORDED RATHER THAN FIXED IN PASSING: a guard that works for a reason its comment does not give is a guard nobody can safely move.** The comment is not merely wrong, it is *load-bearing in the wrong place*. Someone refactoring `finalizeOrderAddon` reads it, concludes the `INSERT OR IGNORE` is the protection, and preserves that while restructuring the claim — and the code is then broken by a change that was made carefully, using the documentation, in good faith.

**This is the THIRD member of that family in this section**, after the `:20241` comment corrected in v4.34 (which claimed a deferred `BEGIN` serialized the order-number mint, when only topology did) and `reconcileTier`'s catch, which read as belt-and-braces and was an atomicity defeat. The pattern each time is the same: **the comment names a mechanism that sounds stronger than the one actually holding, so the real guard is invisible and the fake one is protected.**

**A NOTE ON WHAT WOULD AND WOULD NOT FIX IT.** Adding `UNIQUE(out_trade_no)` to `retail_topup_transactions` would make five writers' beliefs true at once — but the column is NULL on some rows and carries operator-facing values like `admin_adjust` paths elsewhere, so it needs the partial-index treatment `retail_payments` already has, and it must be measured against live data for existing duplicates before it can be added at all. Not proposed here; recorded so the option is on the table with its precondition attached.

### THE FIRST LIVE MONEY INCONSISTENCY FOUND BY MEASUREMENT RATHER THAN BY ACCIDENT — FOUND 2026-08-13

`scripts/check_ledger_invariants.js` was run against a copy of the 10:00 hourly backup, `better-sqlite3` opened read-only, the live file never touched. **Nine of ten invariants passed. Check F failed on seven customers holding ¥3,669.64 of wallet balance that no ledger row explains.**

This is worth marking as a first. Every previous money defect in this record was found because something visibly broke — an order stuck, a coupon leaking, a log line read by hand. **This one was found by a check written before anyone knew whether it would return zero.** The 2026-08-08 points loss (order 1013 / TC000195) was found by reading a log; `check_points_invariants.js` was built afterwards so it would not happen again. This is that discipline paying out on the wallet side, on its first run.

**THE CAUSE, AND THE ASYMMETRY THAT PROVES IT WAS NOT DELIBERATE.** `claimMigrationCredit` at `routes/retail.js:11998` credits the wallet and writes no ledger row:

```
if (credit.balance && credit.balance > 0) {          // :12017
  UPDATE retail_customers SET balance = COALESCE(balance,0) + ?      <-- no ledger row
}
if (credit.points && credit.points > 0) {            // :12021
  UPDATE retail_customers SET points_balance = COALESCE(points_balance,0) + ?
  INSERT INTO retail_points_transactions (... 'migration' ...)       <-- ledger row written
}
```

**Eleven lines apart, in one function, inside one transaction: the points half writes its ledger row and the money half does not.** That asymmetry is the whole argument that this is an oversight rather than a decision, and it is recorded explicitly because a later reader looking only at the balance branch has no way to tell. Nobody designs a system where points are audited and money is not; somebody writes the points branch, writes the balance branch, and does not notice the two came out different.

**THE SEVEN.** ¥3,669.64 total, claims dated **2026-06-13 to 2026-07-28**.

| customer | balance | ledger sum | unexplained | matching credit |
|---|---:|---:|---:|---:|
| 57 | 9.99 | 0 | 9.99 | *staging row overwritten — see the next entry* |
| 92 | 885.00 | 0 | 885.00 | 885.00 |
| 161 | 0.00 | −394.95 | 394.95 | 394.95 |
| 306 | 98.40 | 0 | 98.40 | 98.40 |
| 416 | 196.50 | −199.50 | 396.00 | 396.00 |
| 693 | 143.80 | 0 | 143.80 | 143.80 |
| 814 | 1741.50 | 0 | 1741.50 | 1741.50 |

**Six reconcile to the fen against `retail_migration_credits.balance`** — ¥3,659.65 across those six, matching the staging table exactly. **Two of the seven have a NEGATIVE ledger sum** (161, 416): they were credited silently and then *spent*, and only the spend was recorded. 416 checks out exactly — ¥396.00 credited with no row, ¥199.50 spent and logged, ¥196.50 remaining. 161 spent the lot and sits at zero against a ledger reading −¥394.95.

**LIVE, NOT HISTORICAL.** The most recent claim is 2026-07-28, sixteen days before the run. The path fires on every login and every phone change. **53 unclaimed credits carrying ¥17,362.32 are still queued, and every one of them will do this again on claim.**

**NO CUSTOMER IS SHORT — AND THAT IS NOT THE SAME AS NO HARM.** The money is in the balance and it is spendable; ¥594.45 of it already has been spent. What is missing is the row that explains it, and the cost of that lands in three places:

1. **Invisible in wallet history.** The customer sees a balance with nothing behind it.
2. **Permanently flagged.** Every future reconciliation reports these seven until a row exists.
3. **Lost entirely if a balance is ever rebuilt from the ledger — which is exactly what a cutover verification does.** A verification pass that recomputes balances from `retail_topup_transactions` and compares would silently zero ¥3,669.64 and report the copy as correct.

**THE PASSES ARE RECORDED TOO, AND THEY ARE WHAT MAKES THE FAILURE TRUSTWORTHY.** **E passed across all 1,177 customers** — the points ledger sums to `points_balance` exactly, zero drift, nothing rounded away. **G passed across all 696 points rows** — every `balance_after` equals the running sum of deltas before it. H, I, J, K, L, N and O all returned zero.

That matters more than it looks. A checker that reports one failure among ten passes on its first run is reporting a *finding*; one that lights up everywhere is reporting a *bug in itself*. Nine clean invariants over the same tables, on the same read, are the evidence that F's seven are real. **Record the pass, not just the fail** — the next person to run this needs to know the baseline was clean, or they will treat the seven as a suspicion rather than a measurement.

#### THIS IS NOT A RARE GAP. IT IS MOST OF THE SETTLED WALLET LEDGER — MEASURED 2026-08-13

**Seven sounds small until it is put against the size of the thing it is seven of.** Re-measured independently against the 15:00 hourly (the entry above used the 10:00; F reproduces byte-for-byte, the denominators moved by a handful of rows with five hours of trading):

- **`retail_topup_transactions` holds 208 rows. Only 18 are `status = 'success'`.** The other 190 are `pending` — abandoned top-up intents carrying a notional ¥895,000 that never settled and that F correctly ignores.
- **Those 18 settled rows belong to just 7 distinct customers**, and net to ¥4,325.86: `wechat` +7,000.00 (4), `refund_reverse` +942.59 (4), `order_redeem` −3,321.78 (7), `admin_adjust` −294.95 (3).
- **Ten customers hold a non-zero balance. Seven of them fail F.** Five have no successful row at all; 161 and 416 have rows that do not explain the balance.

**So the honest framing is not "seven customers". It is that 7 of the 10 customers holding wallet money have a balance the ledger cannot explain, and that had `claimMigrationCredit` written its row there would be 25 settled rows instead of 18 — meaning 28% of every settled wallet row that should exist was never written.** A reader who takes "seven" as a rounding error against a big ledger has the scale exactly backwards: the settled wallet ledger is 18 rows, and this defect is missing 7 more.

**ONE CORRECTION TO THE SEVEN: customer 57 is the tester's archived row, not a customer.** Its openid is `_reset_1781343070821_oeqDi5KI8…`, one of the two rows left behind by `/api/retail-admin/customers/:id/reset-test`, sharing the `oeqDi5KI8…` stem with customers 64 and 233. **Six of the seven are real people; the ¥9.99 is ours.** That is also why 57's amount cannot be read from `retail_migration_credits` — 102 rows there are claimed, of which exactly **6** carry a balance and they sum to **¥3,659.65**, matching the six real customers to the fen. The seventh has no staging row carrying its value because row 1516 was overwritten, which is the next entry seen from the arithmetic rather than the narrative.

### THE MIGRATION CREDITS STAGING TABLE IS NOT APPEND-ONLY, AND A RE-IMPORT REWRITES A COMPLETED CLAIM — FOUND 2026-08-13

**The finding is the mechanism, not the ¥9.99 it was found through.**

`retail_migration_credits` is the OUT1N staging roster, keyed by phone, with `claimed_at` / `claimed_customer_id` recording who took each credit. `claimMigrationCredit` is race-safe *within one generation of that table*: it claims with `UPDATE … WHERE id = ? AND claimed_at IS NULL` and proceeds only if it won the row.

**What was observed:** row `1516` (`source_uid` 31741870, phone 18613159912). Customer 57 claimed it on 2026-06-13 09:09:55 and received 99 points and ¥9.99. The row now reads `balance = 0`, `points = 228`, `claimed_customer_id = 64` — and customer 64 claimed it on 2026-06-14 09:13:54, receiving 228 points. **Between the two claims the row was re-imported: its values were replaced and `claimed_at` was reset to NULL, which re-armed a credit that had already been taken.**

**Exactly one `migration` points row in the entire database has no credit row pointing back at its customer, and it is 57's.** That is the measurable residue: the ledger remembers the claim, the staging table no longer does.

**WHAT PREVENTS THIS RECURRING: NOTHING.** Stated plainly because the compare-and-set makes the function *look* protected and it is not — the guard covers concurrency, not re-import. And the reason is worth naming, because it is not an accident of the importer:

**`retail_migration_credits` carries `UNIQUE (phone)`. That constraint is what forces a re-import to UPDATE the existing row instead of inserting a new one — so the same constraint that keeps the roster clean is the one that makes a re-import destructive.** An importer that wanted to preserve history could not simply insert; the schema refuses it. There is no `claimed_at IS NULL` guard on the import side, no generation or import-batch column, and no history table. A second import of the same export would re-arm every claimed row it touches.

**THE COST IS THE AUDIT TRAIL, AND IT IS ALREADY PAID.** Customer 57's credit can no longer be derived from the staging table at all — its amount survives only as an observed balance and its date only as the `created_at` of a points row. Any repair of the entry above must therefore read 57 out of the points ledger rather than the roster, which is a direct, concrete consequence of this finding rather than a hypothetical one.

**IT ALSO CONSTRAINS THE FIX.** Any `out_trade_no` scheme for a migration wallet row that is keyed on the credit row id alone will collide the moment a re-imported row is claimed a second time — which is not hypothetical, it is the case above. The two findings are coupled and neither should be closed as if it stood alone.

### A PAID ORDER CANCELLED WITH NO GATEWAY REFUND REVERSES NOTHING — FOUND 2026-08-13, FIXED AND DEPLOYED 2026-08-17

`PATCH /api/retail-admin/orders/:id/status`, the `status === 'cancelled'` handler. Three paths, and the third is empty of reversals:

| the order was | branch | what it reverses |
|---|---|---|
| `pending_payment` | `:24779` | redeem, balance, voucher — correct; no `order_earn` row exists yet |
| paid, gateway refund fired | `:24833` | points, redeem, balance, referral, lifetime commission — complete |
| **paid, NO gateway refund** | **`:24839`–`:24856`** | **nothing** |

The third branch's own comment says when it runs: *"the order was paid off-app (cash/manual, no refundable gateway row), already refunded, or this is DEV mode."* Its entire body closes a stuck refund request. **It calls none of `reverseOrderPoints`, `reverseOrderRedeem`, `reverseOrderBalance`, `reverseOrderVoucher`, `reverseOrderReferral`, `reverseLifetimeCommission`** — so earned points stay, redeemed points are not returned, spent wallet balance is not returned, the voucher stays consumed, and `lifetime_spend` keeps the cancelled order's subtotal.

**MEASURED, 2026-08-13, across every order in the database:** 20 orders, **1 customer** (233), **¥899.00 of `lifetime_spend` retained** on cancelled orders, and **¥38.80 of wallet balance spent on order 324 and never returned**. Oldest 2026-06-15, newest 2026-08-08.

**THIS IS M's FOURTH STRUCTURAL REASON, AND IT IS THE ONE THAT PRODUCES stored ABOVE derived.** `check_ledger_invariants.js` shipped naming three reasons `lifetime_spend` legitimately diverges from the boot-migration formula and asserting that none of them could put stored above derived. That assertion was true of the three and wrong as a general claim: this branch is a fourth reason and it produces exactly that sign. Customer 233's M drift of +899.00 equals the 20 retained subtotals to the fen. The script's note is corrected in the same pass.

**THE TIER CONSEQUENCE IS REAL BUT NOT YET REALISED.** `lifetime_spend` is the sole input to `tierFromSpend`, and the ladder is seed 0 / sprout 4,000 / root 6,000 / tree 10,000 with points multipliers 1 / 1.1 / 1.2 / 1.3. Customer 233 carries 1,679 against a real 780 — **both below the first threshold, so no tier has actually been inflated today.** The mechanism is what matters: a customer at ¥3,200 of real spend carrying ¥900 of phantom would sit in Sprout and earn a 10% points acceleration they did not buy, and every order after that compounds it.

**WHY CHECK F CANNOT SEE THIS, WHICH IS THE PART TO REMEMBER.** Customer 233 passes F. The ¥38.80 was spent, a ledger row was written for the spend, and the balance matches the ledger — **the books are internally consistent and the customer is still ¥38.80 short.** F tests whether the ledger explains the balance. It does not and cannot test whether the balance is *right*. A reconciliation that passes is not a proof of correctness, and this is the concrete instance to cite the next time one is mistaken for one.

**Both affected accounts here are internal** — 233 is `asher` on 18613159900, and the ¥9.99 in the entry above belongs to `asher` on 18613159912. That bounds today's customer impact at zero and says nothing at all about the paths, which are live for everyone. **The off-app cash/manual cancel is a normal counter-sale flow, not an edge case.**

**FIXED AND DEPLOYED 2026-08-17 at `f4a689e4`.** The five reversal calls are hoisted out of the `wechatRefundRef` branch and guarded on `o.status !== 'pending_payment'`, so both paid-cancel branches share them. `reverseOrderVoucher` is NOT among them — see the sweep entry below for the whole of that reasoning.

**WHAT MAKES IT A DEFECT RATHER THAN A DESIGN CHOICE, WHICH IS THE PART THAT WAS MISSING WHEN THIS WAS LEFT OPEN.** The branch keys on `wechatRefundRef` — on whether the **GATEWAY** moved money. **None of the six helpers touches the gateway.** They move points, store credit, vouchers and referral rows inside our own ledgers. The gateway's money goes back through `settleOrderRefundAcrossTenders`, which is a different mechanism, runs earlier in the same handler, and is untouched by this change. Coupling an internal ledger reversal to an external payment outcome is the whole of the bug, and once it is stated that way the "is this deliberate?" question answers itself.

**THE DOUBLE-RETURN WORRY THAT KEPT IT OPEN WAS MEASURABLE, AND IT DOES NOT HOLD.** The concern was that an off-app cancel may follow an operator who already handed the cash back. Four of the five carry their own idempotency: `reverseOrderPoints` is marked by its `refund_reverse` row, `reverseOrderRedeem` and `reverseOrderBalance` are **cumulative-capped** against what earlier partial refunds already returned, and `reverseOrderReferral` / `reverseLifetimeCommission` each win a status flip or do nothing. **Order 324 is the live proof and is now a test**: ¥38.80 of wallet balance spent, ¥38.31 already returned through the payout flow, so a call today returns **¥0.49** and stops.

**CORRECTION TO THIS ENTRY'S OWN FIGURE, PER RULE 5 — CORRECT IT IN THE OPEN.** The measurement above says "**¥38.80 of wallet balance spent on order 324 and never returned**". That is wrong, and it was wrong when written rather than merely stale: it read the `order_redeem` spend row and **did not net off the two `refund_reverse` rows sitting beside it** (`orderrefund:324:1` at ¥23.11 and `orderrefund:324:2` at ¥15.20, both stamped 2026-06-25 05:06, twenty and fifty seconds BEFORE the cancel at 05:06:53). **The outstanding figure is ¥0.49, not ¥38.80.** The ¥899.00 `lifetime_spend` figure re-measured identically and stands. Recorded rather than edited away, because a survey that reports a gross spend as an outstanding debt is the same class of error as a reconciliation mistaken for a proof — which is the lesson this entry already carries.

**A SECOND DEFECT CLOSED BY THE SAME HOIST, INCIDENTAL AND WORTH NAMING.** The five used to sit **inside** the bookkeeping `try`, after the `refund_status` / `refund_amount_*` UPDATE and the `logRefundEvent`. A throw from any of those writes skipped all five silently — on the branch that was working. They now sit outside it, so a failed bookkeeping write can no longer take the reversals with it. Nobody was looking for this one; it fell out of moving the calls.

**THE REAL-CUSTOMER COUNT IS ZERO, AND IT IS RECORDED PLAINLY SO THIS IS NOT RE-OPENED AS A CUSTOMER INCIDENT.** All **20** orders belong to customer 233, the tester. Established by openid rather than by the name on the row, and by a classifier written independently of this entry — a customer counts as a tester incarnation when some `_reset_`-archived row's openid ENDS WITH theirs, which is the shape `/customers/:id/reset-test` writes (`_reset_<ts>_<openid>`). Run against every cancelled order in the database: **real-customer defect orders, 0.** No customer is owed anything, no tier is wrong, and no repair pass is needed for this item. The tester's ¥899.00 and ¥0.49 are left in place; the only argument for touching them is that check M reads `lifetime_spend` and M is a cutover input, which is a different job with a weaker justification.

**WHAT ELSE THE MEASUREMENT SETTLED.** Of 115 cancelled orders ever, **22 were cancelled after payment: 20 took the empty branch and 2 took the gateway one.** The defective path was the COMMON case, not the edge — off-app cash cancels are a normal counter-sale flow. **Stock was never affected**: the stock reversal sits outside the `wechatRefundRef` branch, and every one of the 10 defect orders that had committed stock also reversed it, 10 for 10. **Points were never affected either**, for a reason worth keeping: all 20 orders sat below the earn threshold, so `awardOrderPoints` wrote its `order_earn` row at **delta 0** — the row exists as the idempotency marker for the `lifetime_spend` bump even when no points are earned, which is exactly why the marker is written unconditionally, and it is what made the 20 findable at all. **Referrals and lifetime commissions: zero instances.** **One global voucher use (¥2.16, the tester's) stays consumed** and is not measurable beyond that, because `retail_vouchers.used_count` has no per-order ledger row.

### THE RESERVATION SWEEPER CANCELLED ORDERS AND RETURNED NOTHING — FOUND AND FIXED 2026-08-17

`sweepExpiredReservations` in `lib/inventory.js` flips a `pending_payment` order to `cancelled` when its stock holds time out. **It called none of the six reversal helpers.** Points, wallet balance and vouchers are consumed at order-CREATE, before any payment, and every other cancel path returns them — the customer's own `/orders/:id/cancel`, `cancelStalePendingOrdersForTenant`, `supersedeUnpaidOrdersForCustomer`, and the admin handler's `pending_payment` branch all call `reverseOrderRedeem` + `reverseOrderBalance` + `reverseOrderVoucher`. **This one is a FIFTH cancel path and the entry above does not list it**, which is how it survived a survey aimed at the fourth.

**IT IS THE ONE THAT REACHED REAL PEOPLE, WHICH INVERTS THE PRIORITY THE ENTRY ABOVE SETS.** 26 orders, 9 customers, 2026-06-17 to 2026-08-12, still live at the time of the fix. Two real customers are short: **302** by 6 points (2 on order 363, 4 on order 571) and **506** by the `SPROUT` voucher grant, ¥20.00, consumed by order 397. Small money against item 44's ¥899.00 of phantom spend — and item 44's ¥899.00 is owed to nobody while these two are owed to somebody, which is the ordering that matters. Fixed first for that reason.

**ALL THREE, AND THE VOUCHER IS THE ONE THAT NEEDS EXPLAINING — WRITTEN SO THE NEXT READER DOES NOT "FIX" THE INCONSISTENCY.** `reverseOrderVoucher` is returned HERE and deliberately NOT added to the paid-cancel branches above. That is not an oversight and it is not an asymmetry to tidy:

- The helper **has no ledger row to key idempotency on** — no per-order voucher record exists — and its own comment puts the once-per-order guarantee **on the caller**.
- The sweeper's cancel is `UPDATE retail_orders SET status = 'cancelled' … WHERE id = ? AND status = 'pending_payment'`, and **only the caller that wins that flip (`changes > 0`) is added to the list the hook receives.** A second sweep, a concurrent tick, or a payment callback that landed first all leave `changes === 0` and fall through. **That flip IS the contract the helper asks for.**
- **Branch 3′ has no equivalent flip.** The admin status handler updates the row unconditionally after its own `def.prev` check, and no paid path returns the voucher today — not branch 3, not `/refund/approve`, not `/refund/payout`. Adding it to one of them alone would make the paid paths disagree with each other while claiming to make them agree.

The test suite **asserts the absence**, scoped to the extracted region and matched on the CALL rather than the bare name, paired with an assertion that the helper IS still called from the `pending_payment` branch — otherwise the absence check is vacuous. Someone who notices the inconsistency and adds it for symmetry gets a failing assertion, not a silent success.

**THE HOOK FIRES AFTER THE TRANSACTION COMMITS, AND THAT IS A PORTABILITY CONSTRAINT, NOT A STYLE CHOICE.** Each helper opens its own `tdb().transaction()`. Nesting one inside the sweeper's own transaction maps to a **SAVEPOINT on better-sqlite3 — verified on the box, twice — and PostgreSQL has no implicit equivalent**; see NESTING IS AN ORDERING CONSTRAINT, NOT A MISSING PRIMITIVE, and v4.31 for the verification. `supersedeUnpaidOrdersForCustomer` already runs its reversals outside its transaction for exactly this reason and says so in a comment. So the sweeper collects the cancelled ids **inside** the transaction and fires `_onOrdersCancelled` **outside** it — a new callback beside the existing `setOnOrdersPromoted`, because the helpers live in `routes/retail.js` and a direct require would close a cycle.

**NOT `reverseOrderPoints`, `reverseOrderReferral` OR `reverseLifetimeCommission`, AND THE CHECK IS RECORDED BECAUSE THE NEXT PERSON TO WIDEN THIS MUST RE-RUN IT RATHER THAN TRUST THIS SENTENCE.** All three fire on payment; these orders were never paid. Verified before writing a line, across **every order the sweeper has ever cancelled**, on **seven independent signals** — six that a payment leaves behind and a seventh that only a paid order can produce. All seven returned zero of 26:

| # | signal | why it would be non-zero if any order had been paid |
|---|---|---|
| 1 | `paid_at IS NOT NULL` | stamped by the paid transition |
| 2 | an `order_earn` points row | `awardOrderPoints` writes it unconditionally at payment, even at delta 0 |
| 3 | a `retail_payments` row at `success`/`refunded` | a settled tender of any kind |
| 4 | a `retail_referrals` row with `first_paid_order_id` = the order | `creditReferralReward` fires on payment |
| 5 | a `retail_lifetime_commissions` row for the order | `creditLifetimeCommission` fires on payment |
| 6 | `preparing_at` / `dispatched_at` / `delivered_at` set | any forward transition past `pending_payment` |
| 7 | an `order_commit` stock ledger row | committing reservations into a physical deduction is a paid-only action |

Signal 2 is the load-bearing one and 7 is the independent cross-check: they come from different subsystems and would have to fail together to hide a paid order.

**REPAIR: BUILT, TESTED, AND RUN AGAINST PRODUCTION 2026-08-18 18:59 UTC+8.** `scripts/repair_sweep_cancel_reversals.js` — a FIXED list of the two customers rather than a query, because a query that re-derives "who is short" would also sweep up whatever a future defect creates and this script's justification would not extend to it. Dry run by default and fails closed; every target re-checked at write time inside the transaction against the same precondition that selected it; checksums before and after; an undo file written before the commit carrying row ids and prior values; `scripts/check_ledger_invariants.js` named as the acceptance test, to be run **before and after** rather than trusting the script's own output. Each repair mirrors the helper that should have run — the points repair writes the `refund_redeem` row that `reverseOrderRedeem`'s cumulative cap reads — so a later legitimate call is a no-op rather than a second return. **RUN 2026-08-18 18:59 UTC+8, by Ash, against production.** Customer 302: 6 points returned (2 on order 363, 4 on order 571). Customer 506: `SPROUT` grant 87 released, global `used_count` 25 → 24. Undo file at `/root/roots-v2/data/undo-repair-sweep-cancel-1787050794887.json`. **All four `checksums_before` in that file match the original survey's dry run exactly**, which is what establishes that it ran against the surveyed state and not a drifted one — the checksum surface used as evidence rather than as a precaution. The acceptance diff against the pre-run baseline showed only normal trading: **no invariant moved.**

### RULE — A SUITE MUST ASSERT ITS OWN ANCHORS CARRY NO LINE ENDING, BEFORE IT RUNS THEM — 2026-08-17

**THIS IS NOT A NEW RULE AND THAT IS THE FINDING.** v4.27 recorded the CRLF anchor as the third occurrence of "a run that looks like proof and is not". **v4.28 already sharpened it to its final form — "an anchor must contain no line ending at all"** — after a literal `\r\n` anchor was written and replaced while building the very suite meant to guard against it. v4.34 hit it a third time. **It happened again here, in `scripts/test_cancel_reversals.js`, in a file whose own header states the rule.** A two-line anchor joined with a bare `\n` matched nothing against a CRLF checkout; the primary check failed and — worse — its mutation red-proof reported a **vacuous pass**, because removing a substring that is not present returns the source unchanged, which then "fails when mutated" for the wrong reason entirely.

**SO THE RULE IS NOT SHARPENED — IT IS GIVEN A MECHANISM, WHICH IS WHAT THREE RECURRENCES SAY IT NEEDED.** Stating a property in a header has now failed four times. **A suite must ASSERT the property about its own anchors, as a first-class check, before it runs any of them:** one assertion per anchor, `!/[\r\n]/.test(anchor)`, printed in the output like any other. `test_cancel_reversals.js` carries nine such assertions. An intention in a comment is not a guard; the whole of §24's method is that a claim about the code must be executable, and a rule about the harness is not exempt from it.

**A SECOND GUARD IN THE SAME FAMILY, FOUND BY THE FIX RATHER THAN BY REVIEW.** `test_ledger_invariants.js` pinned M's reason 4 to the string `24839` — a LINE NUMBER. **A line number is not an anchor.** The reference had already drifted off the branch it named (at this head, 24839 lands inside an unrelated comment about offline payment methods), so the assertion had been guarding a pointer to nothing, and it went red for the change that made it obsolete rather than for a regression. §24's own convention is to cite by symbol; the pin now names `awardOrderPoints` and "reversal helpers". **It was repinned rather than relaxed** — and gained three assertions while it was open: that reason 4 is marked fixed and no longer accruing, that it touched **zero real customers**, and that it carries the ¥0.49 correction rather than the original ¥38.80. Those are precisely the three facts a later tidy-up loses first.

**FIFTH NAMED MEMBER of the "a run that looks like proof and is not" family**, after the two comment-blind source guards, the CRLF anchor (v4.27) and the mutant that could not change behaviour (v4.34). **Recorded as the FIFTH rather than the sixth**: the brief that requested this entry said sixth, and the record as written names four. The re-occurrences noted inside v4.28 and v4.34 are instances of members already counted, not new members. Corrected here in the open rather than carried forward, because an ordinal in this family is how the next reader finds the set.

### THE POST-COMMIT HOOK PUSHES BRANCHES TO ORIGIN WITHOUT BEING ASKED — 2026-08-17

Recorded because a ref moving with nobody asking is what makes a `--force-with-lease` fail confusingly later, and the failure looks like a concurrent session rather than a local hook.

A post-commit hook runs `git push` on every commit, on ANY branch, and prints `[push] pushing '<branch>' to origin…`. **It cannot deploy** — `.github/workflows/deploy.yml` triggers on `branches: [main]` only — so a feature branch reaching origin is inert. What it does do is publish a branch ref the moment it exists. **Amending any commit that the hook has already pushed puts the local branch behind its own remote**, and the next hook-driven push is rejected non-fast-forward; the hook reports it as `(offline/auth?)`, which is the wrong diagnosis and the reason this is written down. The fix is a `--force-with-lease` pinned to the SHA the hook left there, verified with `git rev-parse origin/<branch>` first — not a blind `--force`, and not a pull.

### THE MONEY CLUSTER DESIGN DOC — WRITTEN 2026-08-19, MERGED AT `fde72986`

`docs/tacet-money-cluster-design.md`, v1.0. **PHASE 2 OWED WORK item 7's "no design doc exists for this group" is closed**, and the OPEN item under `POST /api/retail-admin/orders` IS NOT THE MONEY CLUSTER — every post-commit guard measured against a synchronous driver — now has the document it was waiting for.

**WHAT IT IS FOR, AND THE AUDIENCE IS WRITTEN INTO IT:** someone converting a money helper to async six months from now with no memory of any of this. It states what must stay true, what holds it true today, whether that survives an async driver, and **what a reader would see if it broke**. It is not a summary of the survey; the survey is findable and is not repeated.

**SCOPE IS THE 19, RE-DERIVED AT `9d13d756` RATHER THAN CARRIED FORWARD** — 31 `INSERT` sites into the eight ledger tables, 25 owners, less the six that cite the document rather than living in it: the checkout, the poll vote, and the four adjust/admin routes. Fourteen named helpers and five money routes. **Item 7's 2026-08-12 count of "13 named helpers + 5 money routes" is 18; the population is 19 at this head.**

**IT CARRIES NO CONVERSION ORDER, NO BATCH PLAN AND NO SEQUENCING, DELIBERATELY** — a design document that arrives with a plan attached gets read as a plan, and the invariants are then skimmed on the way to the schedule.

**BOTH CONSTRAINTS ARE APPROVED. NEITHER IS SCHEDULED, AND THE DISTINCTION IS THE POINT.** They are pre-flip work and they need their own brief with the live-data check **re-run at the time**, not carried from 2026-08-19. A measurement of "zero existing violations" is true of the data it was taken against and of nothing else.

1. **Partial `UNIQUE (out_trade_no)` on `retail_topup_transactions`**, matching the treatment `retail_payments.out_trade_no` already carries. Measured clean on the 09:00 snapshot: **222 rows, 0 NULLs, 0 duplicate values.** It makes five writers' stated belief true and converts `finalizeOrderAddon`'s `INSERT OR IGNORE` from decorative into real.
2. **Partial `UNIQUE (order_id, source)` on `retail_points_transactions`, SCOPED to `order_earn`, `order_redeem` and `refund_redeem`** — 586 rows across those three, zero duplicate groups. **THE BLANKET FORM WOULD FAIL TO APPLY, AND BOTH VIOLATIONS ARE LEGITIMATE**, recorded by order number so nobody re-derives it: **order 873** holds two `order_addon_earn` rows (ids 679, 680) because the order genuinely has two add-ons, one row per add-on; **order 299** holds two `refund_reverse` rows (ids 359, 360 — `delta = -2` "Reversed on refund" and `delta = +1` "Redemption returned on refund"), which are **two different economic events sharing one `source` string.** That overloaded label is why `reverseOrderRedeem`'s own lookup has to special-case `source = 'refund_reverse' AND delta > 0`.

**THE SURVEY'S POPULATION CARRIED STALE NAMES FORWARD, AND THIS IS NOT THE FIRST CITED REFERENCE TO MOVE UNDER ITSELF.** `creditWallet` and `debitWallet` **do not exist** in `routes/retail.js` at this head. The wallet writes at the line numbers the survey gave now belong to `creditReferralReward` and `reverseOrderReferral`; the behaviour described is unchanged, the names are not. Several other survey line numbers had drifted 500–800 lines — the two-argument `MAX()` sites moved from `:27910` and `:28639` to `:28598` and `:29365`. **Same family as the `24839` line-number pin corrected in v4.38: cite by symbol, and re-derive before citing a helper by name out of a document older than the code.**

### `reverseOrderBalance` READS ITS SEQUENCE NUMBER OUTSIDE THE TRANSACTION IT WRITES IN — FOUND 2026-08-19

**A defect in its own right, and recorded as one rather than as a footnote to the constraint that would mask it.** `routes/retail.js:28459–28484`.

The helper returns wallet credit on a refund and must not return more than was spent, across any number of partial refunds. Its idempotency key is built by counting the reversals already written:

- `:28466` — `SELECT COALESCE(SUM(amount), 0) AS s, COUNT(*) AS n FROM retail_topup_transactions WHERE payment_method = 'refund_reverse' AND out_trade_no LIKE 'orderrefund:<id>:%'`
- `:28474` — the transaction opens **here, after that read**
- `:28478` — the insert, keyed `orderrefund:<id>:<n+1>`

**THE READ THAT DECIDES THE KEY IS NOT IN THE TRANSACTION THAT WRITES IT.** Under `better-sqlite3` nothing can interleave between the two and the sequence is sound. Under an async driver that gap is a yield point: two concurrent partial refunds both read `n = 1`, both build `orderrefund:299:2`, and **both insert**. The `remaining` cap is computed from the same stale read, so it does not save it either — both callers see the same amount still owed and both pay it out.

**THE RESULT IS A DOUBLE REFUND OF STORE CREDIT, AND NOTHING RAISES.** `retail_topup_transactions` carries no constraint of any kind, so the second row is simply accepted. Check **J** — "no `out_trade_no` is used twice in the wallet ledger" — is the only thing in the system that would ever say so, and it says so only when someone runs it by hand, after the fact.

**HOW IT WAS FOUND IS WORTH RECORDING, BECAUSE IT ARGUES FOR THE METHOD.** It did not come out of the ledger-writer survey, which read this helper and classified it correctly as a read-then-write marker. It came out of asking a narrower question the survey never asked — *could a `UNIQUE` constraint be added to this column, and would any existing row violate it* — and answering it against live data. **The check written to validate a proposal found a defect the survey had walked past.** Same shape as check F, which was written before anyone knew whether it would return zero and came back with ¥3,669.64: a question asked precisely enough to be answered by measurement tends to answer more than it was asked.

**It is also the strongest argument for the `out_trade_no` constraint, and that is a consequence rather than the reason it is recorded here.** The constraint converts this exact race from a silent double credit into an error — but **the defect exists whether or not the constraint is ever added**, and it will still be there if the constraint is deferred. A race fixed only by a constraint that has not been built yet is not fixed.

### RULE — A POPULATION DERIVED FROM A CODE SCAN MUST STATE WHICH WRITE VERBS IT MATCHED — RECORDED 2026-08-19

**A population derived by one write verb is structurally blind to writers using another.**

The money cluster's population was drawn from `INSERT` sites into the eight ledger tables. **`handleWechatPayCallback` writes a ledger table by `UPDATE`** — `routes/retail.js:5014`, `UPDATE retail_topup_transactions SET transaction_id = ?, raw_callback_json = ? WHERE id = ?`, outside every transaction, inside a payment callback — **so an `INSERT`-derived population cannot see it, and did not.** It was recovered by reading the callback, not by the scan, and it has its own heading in the design document for exactly that reason.

**THE RULE, STATED BEHAVIOURALLY SO IT CAN BE APPLIED RATHER THAN AGREED WITH: any population derived from a code scan must state which verbs it matched, because that statement is the shape of what it missed.** A population that says "every `INSERT` into these tables" is honest and bounded. A population that says "every ledger writer" is claiming a completeness its technique cannot deliver, and the gap falls exactly where it matters — on the writer that does not look like the others.

**THIS IS THE THIRD MEMBER OF A FAMILY, AND THE OTHER TWO ARE ALREADY IN §24:**

- **The AST authority's `withTransaction` blind spot** — recorded as finding 3 under THE SIX STEP-2 HELPERS — SURVEYED AT THIS HEAD 2026-08-10, resolved under COUNTS, LABELLED BY FORM. It matched `.transaction` as a **member property**, so `withTransaction(h, fn)` — an `Identifier` callee — matched nothing, and **26 converted blocks appeared in no figure it printed, through four conversion batches.** The counts were right about what they counted and silent about what they omitted. The fix was not a bigger number but **labelling every figure with its form and printing no blended total**, because a combined figure would have changed what every count in §24 meant without changing a word of them.
- **The unenumerated reversal family** — A PAID ORDER CANCELLED WITH NO GATEWAY REFUND REVERSES NOTHING listed the cancel paths it knew, and `sweepExpiredReservations` was **a fifth the entry never listed.** 26 orders, 9 customers, and two customers really were short. The list was accurate and it was not complete, and nothing beside it said which of those two it was claiming.

**WHAT ALL THREE SHARE: a count that was correct about its own criterion and silent about the criterion's edge.** Not one of them was wrong. Each was read as complete because nothing next to it said what it had matched on. **The remedy is the same in every case and it is nearly free — state the criterion beside the count** — and it is why the design document's population section names its derivation (`INSERT` sites, eight ledger tables, 31 sites, 25 owners, six excluded) instead of asserting a total and leaving the technique implicit.

### THE TENANT→ACCOUNT PHYSICAL RENAME IS DECLINED — DECIDED 2026-08-21

**This supersedes clause (b) of DONE IN THE SAME REBUILD at the head of this section.** That line is left standing where it is and is superseded by this entry, not edited.

The twelve tables and the two columns the Phase 1 copy renamed are renamed BACK in Postgres. The application keeps the names it has always used. `tenants` is `tenants` again, `tenant_id` is `tenant_id` again, on both sides of the migration.

**WHY THIS IS NOT A DECISION REVERSED BUT A PREMISE THAT EXPIRED.** Clause (b) never argued that `account` is the better physical name. It argued that the rename was FREE: *"because the tables are being rebuilt anyway and a separate migration would touch everything twice."* That is an efficiency claim, and it was true when written — one rebuild, one pass, both sides moving together.

**The rebuild landed on one side only.** The schema was rebuilt under the new names and the application was not, which is the whole of G28. From that moment the arithmetic inverts:

- **Carrying the rename forward** costs a pass over 24 application files — the second touch clause (b) existed to avoid.
- **Declining it** costs 74 `ALTER` statements in one transaction, against a cluster nothing is serving from.

**So clause (b) is not overruled on its merits. It is retired because the only thing it ever claimed — that this was free — stopped being true, and stopped being true in the direction that reverses the answer.**

**WHAT THIS DOES NOT TOUCH.** The vocabulary decision stands. `tenant` stays retired as a word: not in documentation, briefs, UI copy, API paths or new code. The glossary TENANT entry already allowed the identifier to survive; it is amended only to say the survival is permanent rather than pending a rebuild, because "pending a rebuild" is precisely the expectation this entry retires.

**WHAT WAS DONE, ON 2026-08-21.** One transaction, `docs/tacet-postgres-g28-rename-back.sql`, 74 statements, applied clean after a dry run that rolled back:

| Count | Kind | What changed |
|---|---|---|
| **12** | tables | `accounts` → `tenants`, and eleven `account_*` → `tenant_*` |
| **25** | columns | `account_id` → `tenant_id` in 20 tables, `account_user_id` → `tenant_user_id` in 5 |
| **4** | indexes | the standalone `idx_*` ones only |
| **8** | sequences | the identity sequences of the renamed tables |
| **25** | constraints | 12 primary keys, 4 unique, 9 foreign keys — their NAMES |

No foreign key DEFINITION was edited. Postgres carries a reference across a table rename by oid; it does not carry the constraint NAME, which is why the 25 are there and the references are not.

**THREE OF THE FIVE COUNTS IN THE BRIEF FOR THIS WORK WERE WRONG, AND ALL THREE WERE WRONG LOW.** Tables (12) and columns (25) came from `plan.json` and were right. The other three were inferred:

- **Indexes: 20, not 15.** Fifteen counts only the constraint-backed indexes ON the renamed tables. It misses `idx_account_domains_host`, `idx_account_users_login`, `idx_billing_subscriptions_account`, `idx_subscriptions_account` and `integration_sessions_account_id_kind_store_code_key` — three of which sit on tables that KEEP their own name, which is exactly why a table-scoped count cannot see them.
- **Constraints: 25, not 14.** Fourteen is the count of FK EDGES touching a renamed table, which is `plan.json`s `fkeys` block filtered — a different set with a different meaning. It over-counts by five (`fk_billing_invoices_1`, `fk_billing_subscriptions_2`, `fk_integration_help_requests_1`, `fk_integration_sessions_1`, `fk_subscriptions_2` never contained the word and need no rename) and misses sixteen (all 12 primary keys and all 4 unique constraints).
- **And the brief asked for `ALTER INDEX` on every `account*` index, which would have ABORTED THE TRANSACTION.** Sixteen of the twenty are constraint-backed, and `ALTER TABLE ... RENAME CONSTRAINT` renames the backing index along with the constraint. Naming those sixteen a second time finds nothing left to rename. Only the four standalone `idx_*` take `ALTER INDEX`.

**THE RULE UNDER ALL THREE: a count of database objects has to be asked OF THE DATABASE.** Tables and columns were right because `plan.json` IS a survey of the database. Indexes, sequences and constraints were derived from the table list instead, and every derivation came back low. **`pg_catalog` knows what exists; a list of tables does not.**

**THE GAP GOES TO ZERO, AND ITS HEADLINE FIGURE WAS NEVER A STATEMENT COUNT.** An AST pass over the runtime tree — `lib/`, `routes/`, `middleware/`, `server.js`, `database.js`, reading string literals and template quasis only, so comments cannot reach it — measures **248 SQL statements naming a renamed table, across 24 files, 258 table-occurrences**. The same pass against the `account*` names returns **0**. **G28s recorded 266 is the sum of its own per-table column** (104+81+19+13+13+7+6+6+5+4+4+4 = 266), so a statement joining two renamed tables is counted under each: an occurrence sum presented as a statement count. **Its "23 files" is one low; it is 24.** Neither correction changes the decision, and the number that matters is the second one either way.

**WHAT MADE THIS SAFE IS WHAT WAS NOT TOUCHED.** Zero changes to `lib/`, `routes/`, `middleware/`, `server.js` or `database.js`. That is not tidiness, it is the mechanism. **`CONTROL_PLANE_TABLES` in `lib/tenant-db.js` holds `tenants`, `tenant_users`, `tenant_secrets`, `tenant_onboarding` and `tenant_integrations` as STRING DATA in a `Set`.** No dialect scanner, no AST count and no statement sweep can see them: they appear in none of the 248, none of the 266, and none of the eleven module-load `.exec()` blocks under G26. **They are correct today because the live SQLite tables carry those names, and they stay correct at the flip because this rename put the Postgres tables back under them and nothing edited the file.** Rename the identifiers instead and this is the site no scan can find and no test reaches until a control-plane read runs against Postgres.

**THE SCHEMA IS NOT REGENERATED BEFORE THE FLIP, WHICH IS WHY THE DDL WAS REQUIRED RATHER THAN OPTIONAL.** The runbook step E2 runs `scripts/postgres-full-copy/run.py`, which `TRUNCATE`s an existing schema and reloads it. Nothing in the runbook creates a schema: it names none of the five schema `.sql` files, contains no `psql -f`, and applies only `docs/tacet-postgres-order-counter.sql`, by hand, as an IF-BAD remediation. The five schema files are `pg_dump -s` records, and all five define `accounts`. **A `plan.json` edit alone would never have reached the cluster.**

**AND THE TWO HALVES ARE COUPLED, WHICH IS THE PART TO CARRY FORWARD.** `run.py` builds its `TRUNCATE` list from `plan.json`s `pg` names. After this edit it issues `TRUNCATE "tenants", "tenant_domains", ...`, which resolves only because the DDL landed. **Neither half is safe on its own.**

**THREE SCRIPTS HELD THE OLD NAME AS A LITERAL, AND ONE OF THEM WOULD HAVE BROKEN A CUTOVER STEP. ALL THREE ARE FIXED IN THE SAME COMMIT AS `plan.json`.**

1. **`run.py` — this is the one that bit.** Its post-`TRUNCATE` sanity query read `select count(*) n from accounts union all ...`. After the rename that is `relation "accounts" does not exist`, and `run.py`s `psql()` helper turns a non-zero return into `sys.exit(3)` — **aborting E2 one statement after the `TRUNCATE` had already emptied the target.** Now built from `plan.json` instead: `REHEARSAL` lists the five by their SQLITE names, which do not move, and each resolves through `plan["tables"][t]["pg"]` to whatever the cluster currently calls it. **Proven by running the constructed SQL against the live cluster — it returns 278, the sum of the five.**
2. **`drift.sh`** — now `for t in tenants users suppliers purchase_orders invoices`. This is shell and cannot read `plan.json`, so the names stay literals of necessity; the file now says so, and says that nothing in it will notice if they move again. Run against the cluster and reads all five.
3. **`final.py`** — `PRE` now keys on `"tenants_id_seq"`. A stale key there resolved to `None` and printed blank rather than mismatched, **which reads like a pass** — the same failure shape as the `checks.py` exit code this work also repaired.

**AND THE DEPLOY IS DEFERRED, WHICH MAKES THE ORDER OF THOSE FIXES LOAD-BEARING.** The scripts commit carries a `[skip deploy]` token on its SUBJECT line, and `.github/workflows/deploy.yml` reads `git log -1 --pretty=%s` — **the HEAD commit’s subject and nothing else.** So the docs commit goes FIRST and the scripts commit is HEAD; the other order puts the marker on a commit CI never reads and ships the scripts anyway. No merge commit, for the same reason: a merge’s default subject carries no token.

**WHAT THE DEFERRAL LEAVES ON THE BOX, AND WHY IT IS SAFE.** Until that deploy lands the box holds the OLD `plan.json` beside the OLD `run.py`. **That pairing FAILS CLOSED**: `run.py` builds its `TRUNCATE` list from `plan.json`s `pg` names, so it names `accounts`, which no longer exists on the cluster, and psql errors on the `TRUNCATE` itself — before a single row is emptied.

> ⚠️ **THE DEFERRAL DESCRIBED ABOVE LASTED SEVENTEEN MINUTES, AND THE TWO PARAGRAPHS BEFORE THIS ONE ARE LEFT STANDING BECAUSE THE REASONING IN THEM IS STILL RIGHT.** The token was on HEAD, CI honoured it, and the run finished in 18 seconds having shipped nothing. **Then somebody else pushed** (`626cc802`, 2026-08-21), **and that deploy carried these six files out with it.** Verified on the box: all six match `origin/main` byte for byte, and `pm2 roots-v2` went 1361 → 1362 restarts.
>
> **WHY, AND IT IS NOT A BUG:** `deploy.yml` computes its diff base from `/root/roots-v2/.deploy-state/last-success-sha` — **what production ACTUALLY HOLDS**, not what `main` held before the push. That is the Stage 2 fix built after a replay of 904 runs found **197 stranding episodes across 141 files, the longest 43 days**, caused by a base that was too new. A skipped commit leaves the record unmoved, so its files stay in the diff and ride out on the next deploy by anyone. **`[skip deploy]` defers a RUN, not a FILE.** Recorded as its own entry: §24 `[skip deploy]` DEFERS A RUN, NOT A FILE.
>
> **THE SPLIT-DEPLOY HAZARD DID NOT OCCUR, AND THE REASON IS THE ONE THE PARAGRAPH BELOW GIVES.** The six files were in ONE commit, so they shipped together. The box now holds the new `plan.json` beside the new `run.py`, which is the correct end state. **Had they been in two commits, the token would have deferred one of them and this deploy would have shipped the other alone.** The paragraph below stops being advice about a deferral and becomes the reason this was safe at all.

**THE DANGER IS A SPLIT DEPLOY: NEW `plan.json` WITH OLD `run.py`.** That pairing truncates 162 tables correctly by their new names and THEN dies on the hardcoded `accounts` in the sanity read, leaving the target empty and the copy unrun. **`plan.json` and every committed input keyed on those names must never ship separately, in either direction, and the deferral is safe only because they are in ONE commit.** ⚠️ **THAT PAIR IS THE WRONG UNIT AND WAS CORRECTED 2026-08-21: it is at least THREE files.** `copy_order.json` is keyed on the same names and was missed here, because it is DATA and the sweep that found `run.py` read CODE. See §24 A NAME HELD AS DATA IS INVISIBLE TO A SCAN OF CODE. Anyone splitting that commit — to ship a doc fix, to revert half of it, to cherry-pick — re-creates the failure this paragraph exists to prevent.

**SEVEN SCRIPTS READ THE PLAN NAME MAP, NOT THE FOUR THAT WERE LISTED.** `gen.py`, `checks.py`, `preflight.py` and `final.py` were known. **`run.py`, `setseq.py` and `verify.py` were not.** `setseq.py` and `verify.py` resolve everything through `plan.json` and needed no change; `run.py` is item 1 above. Two independent methods agree on the same seven files.

**WHAT WAS VERIFIED AFTERWARDS, AND WHAT EACH PROOF IS ACTUALLY WORTH.**

- **`checks.py` verdict 1: 144 of 144 foreign keys validated by Postgres against its own rows, 0 failures, 0 left `NOT VALID`.** This is the verdict that tests the rename, and it is identical before and after it.
- **`verify.py` round-trip across all 12 renamed tables** resolved every one through the edited `plan.json` and read Postgres by the new names. Nine of the twelve compare with zero differences. The three that differ are `tenant_users` (six `last_login` values), `tenant_operator_push_subs` (the push subscription has been replaced) and `tenant_user_sessions` (35 rows against 23) — live churn since the copy, none of it structural.
- **`gen.py` emits `INSERT INTO tenant_domains ("id", "tenant_id", ...)`**, and that output was loaded into the renamed schema inside a rolled-back transaction, to prove it end to end rather than by reading it.
- **The cluster holds no unexpected `account` identifier.** Relations, columns, constraints, routines, types, triggers and schemas all swept. The five that match are `eleme_tokens.account` and its `eleme_tokens_account_key` (an Eleme platform login), `retail_stores.meituan_account_id` (a Meituan platform id), and `ingredients.accounting_category` and `purchase_orders.posted_to_accounting`, which are the word "accounting". A sixth occurrence is prose inside a `COMMENT`, not an identifier.
- **`checks.py` verdicts 2 and 3 FAIL, and that failure is not this work.** 82 columns differ on Chinese character count and the wide base64 columns are not byte-identical. Both compare LIVE SQLite against a copy taken 2026-08-06, and the script’s ENTIRE 11,269-byte output is **byte-identical before and after the rename, same md5** — the same 1,580,099 CJK characters against 1,372,834, the same 82 columns named in the same order, the same fourteen wide-column SHA-256 comparisons. **Byte-identical output on both sides of a schema change is a stronger proof that the change did not touch the data than any assertion about it could be.**

**A NEW AS-BUILT RECORD**, `docs/tacet-postgres-schema-as-built-2026-08-21.sql`, 163 tables, body proven verbatim by sha256 against raw `pg_dump -s --no-owner` output. It supersedes the 2026-08-11 file; that file and the 2026-08-04 one are retained byte-for-byte. **Two consumers still open the 2026-08-04 file BY ITS DATED NAME** — `scripts/diagnose_seam_statements.js` and `scripts/diagnose_statement_sweep.js` — and their regex discards the index name while capturing the TABLE and its COLUMNS, so the index renames do not reach them and the table and column renames do. Not repointed; recorded so it is not rediscovered.

### RULE — CHECK `.gitattributes` BEFORE EDITING, AND NEVER LET A TOOL NORMALISE ON WRITE — 2026-08-21

**This repository has now produced five line-ending incidents. Four were vacuous passes. The fifth made a 98-line change unreviewable.**

`verify.py` was written back with LF by a patch script that defaulted to it. Nothing broke — Python reads either — but the diff went from **98 insertions** to **295 insertions and 295 deletions**, and it falsified a line in the README that the *same commit* had just written. `.gitattributes` pins `/scripts/postgres-full-copy/*.py -text` and its comment names `verify.py` as one of the CRLF files, with the instruction *"Do not normalise them."*

**THE RULE, IN TWO PARTS:**

1. **Read `.gitattributes` before editing any file in this tree.** `git check-attr text -- <path>` answers it in one line. This repo has `-text` pins on four directories and three individual files, each for a stated reason — shebangs that break as `#!/usr/bin/env python3\r`, files that checksum against copies on the box, a dump that must diff cleanly against its successor.
2. **Never let a tool pick the line ending.** Detect what the file has and write that back. A patch script that hardcodes `newline` will silently rewrite every line of a file it was meant to add four lines to.

**WHY IT MATTERS MORE THAN IT LOOKS.** A 295/295 diff is not reviewable, and an unreviewable diff is where a real change hides. The damage is never the line endings.

---

### RULE — A SORT THAT ITERATES A SET VARIES ACROSS PROCESSES ONLY — 2026-08-21

**The failure mode: it passes every test you would think to write.**

Python randomises string hashing per process, so a set's iteration order is **stable within one process and different in the next**. A topological sort that iterates a set of ready nodes therefore returns the same order every time you call it in a test, and a different valid order when it runs on the box. **Two rehearsals become incomparable, and an order-dependent failure cannot be reproduced** — which is exactly when you would need to.

**THE PROOF THAT CATCHES IT IS `PYTHONHASHSEED` AT TWO VALUES, PLUS A FRESH PROCESS.** `derive_copy_order()` was proven four ways — twice in one process, once fresh, and again under `PYTHONHASHSEED=12345` and `=999` — all four byte-identical. **An in-process assertion alone would have proven nothing.**

**THE FIX IS DULLER THAN THE BUG:** iterate sorted lists, never a set or a dict, anywhere the output order is meaningful. Say so in the docstring, because the next person to tidy the code will reach for a set.

### A SCAN OF SCHEMA CANNOT SEE A SECRET HELD AS A ROW — 2026-08-23

**One level down from A NAME HELD AS DATA IS INVISIBLE TO A SCAN OF CODE, and it bit in exactly the same way.**

Sweeping the schema for outbound channels — column names matching webhook, token, secret, key, endpoint, phone, callback — returned **57 candidate columns and none of the 13 keys that mattered.** The webhook is not a column called `webhook`. It is a ROW in `storefront_config` whose `key` is `system_alerts.wecom_webhook` and whose `value_json` is the URL. **To the schema it is one more row in a two-column table.**

**So the schema sweep was not merely incomplete, it was confidently complete about the wrong question.** It answered *which columns look like they hold secrets* and read as though it had answered *what can this database reach*. The 13 keys had to be enumerated separately, from the application code that writes them, and there is no scan that finds both halves.

**Where this generalises: any key/value store inside a relational schema.** `storefront_config`, `tenant_secrets`, `tenant_integrations.config_json`. A column-name sweep sees three tables. What is actually in them is a few hundred separate settings, some of which are credentials.

---

### G27 CLOSED — `.env` REACHED THE SERVER AND NOTHING ELSE — 2026-08-23

**`loadEnv()` was an IIFE inside `server.js`, so every standalone script was blind to `.env`.** `lib/pg` refuses to build a pool without `TACET_PG_HOST`/`DATABASE`/`USER` — correctly, it has no defaults on purpose — so every `--pg` script exited 2. Extracted to **`lib/load-env.js`**.

**WHY A MODULE AND NOT A SHELL WRAPPER, since that was the obvious cheap fix.** `.env` is not shell-sourceable. A value containing an unquoted `<` — **line 63 of the live file** — makes `set -a; . .env` fail as a REDIRECTION, part-way down, having already exported everything above it. **A partial environment is worse than an empty one:** `lib/pg`'s check passes on the three variables it names while a fourth the caller needed is silently absent. Parsing it in JS, with the same code the server uses, cannot half-succeed.

**THE COUNT WAS WRONG BEFORE IT WAS FIXED — FIVE SCRIPTS, NOT THREE.** The gap was recorded as three scripts exiting 2 plus the delta report. Enumerating consumers of `lib/pg` by two independent methods found **five**: `check_ledger_invariants`, `check_points_invariants`, `diagnose_pg_numeric_parser`, `rollback-delta-report`, `test_db_driver`. The first two are the ones G6 and T1 actually run.

**SERVER BEHAVIOUR PROVEN IDENTICAL, NOT ASSUMED.** The old IIFE was copied verbatim into a harness and run against the extracted module over **15 adversarial `.env` bodies** — comments, blank lines, `KEY=` with no value, `=novalue`, unbalanced quotes, `=` inside the value, CRLF, UTF-8 and emoji, duplicate keys, no trailing newline, an empty file, a missing file, and **the line-63 `<` shape**. Every case produced a byte-identical `process.env` delta, including the precedence rule that an existing variable wins. `path.join(__dirname, '..', '.env')` from `lib/` was proven to resolve to the same absolute path `server.js` used.

**AND THE DELTA REPORT'S EXIT CODES WERE REBUILT WITH IT, BECAUSE CLOSING G27 ALONE WOULD HAVE LEFT THE WORSE HALF STANDING.** `rollback-delta-report.js` had **exactly one exit path** — `1`, from the catch. So a missing `.env`, a dead pool, and an absent pre-flip database were the same answer as each other. **And a real delta exited 0, exactly like a clean window** — the verdict lived only in prose, at H6 step 2, after the decision to roll back is already taken and nobody has attention left for reading. Now **0 = ran, nothing to do; 1 = ran, there IS business data to work through; 2 = could not run, nothing measured.** Disposable rows (abandoned quotes and the three sync logs, 63% of the drift) deliberately do not raise a 1. Verdict logic unit-proven on four cases including 2,000 disposable rows returning 0.

**`lib/platform-alert.js` was NOT exposed and needs its own pass for a different reason.** Cross-checked two ways: `sendPlatformAlert` has one importer, `routes/integrations-admin.js`, mounted in `server.js` — so it only ever runs in-process, where `.env` is loaded. **G27 never reached it.** What it does have is the OTHER defect: `PLATFORM_OPS_WEBHOOK` unset is a silent no-op, so a missing platform webhook reads as *switched off* rather than as *cannot tell*. That is the `/root/ops-alert.conf` problem on a second channel, and it is not fixed here.

**WHAT THE LOCAL HARNESS COULD NOT PROVE, said plainly.** This machine has neither the `pg` package nor built `better-sqlite3` bindings, so the local exit codes are 2 for *cannot find module* rather than for missing config — **the local run does not reproduce G27's cause and cannot prove the end-to-end fix.** What was proven locally: `.env` now reaches a plain `node` process; four of the five scripts have `TACET_PG_*` resolved at the moment `lib/pg` is evaluated (probed by intercepting `require('pg')`); and the delta report went **1 → 2** with a message naming the real cause. **The box-level exit codes still need re-measuring on the box.**

---

### THE DANGEROUS DEFAULTS ARE THE ONES THE LANGUAGE GIVES YOU FREE — 2026-08-23

**Sweeping PART H for fallbacks found three, and then a fourth that the sweep was structurally unable to find.**

The three had operators to search for: `cat /root/flip-offset 2>/dev/null || echo 1`, and two `2>/dev/null` swallows on `tail` and `grep -c`. The fourth was `$(( $(cat /root/flip-offset) + 1 ))` — **no `||`, no `2>/dev/null`, no operator of any kind.** The default comes from bash evaluating an empty string as 0 in arithmetic. **A sweep for fallback OPERATORS misses it completely.**

**AND THE THREE FAILED IN OPPOSITE DIRECTIONS, which is the part worth keeping.** The offset default made T2 read the whole error log and go **RED on the first tick against a threshold of ONE.** The two swallows made a missing log read as **zero errors — GREEN, silently, forever.** *The first shouts a lie and the other two whisper one, and the whisper is worse.*

**THE STRUCTURAL REASON THEY ALL SURVIVED: the H4 loop's rule is *the line should be byte-for-byte identical every minute*.** It detects CHANGE. **A value that is already wrong when the loop starts never changes, so the loop can never see it.** Every default fell through that hole. Each now emits `*** NO OFFSET ***` or `*** LOG UNREADABLE ***` in the line itself, and a new trigger row says a `***` field means that trigger is not being evaluated at all — **not green**.

**THE PRODUCER WAS HALF THE FAULT, AND MY FIRST FIX FOR IT WAS WRONG.** F1 writes the offset with `wc -c < LOG > /root/flip-offset`. I recorded that this truncates the target first and leaves a zero-byte file; **testing showed the opposite** — bash opens the input first, so a failed read means the write never happens and **any existing offset file is left exactly as it was.** On a second rehearsal that is a stale number from the previous run: **numeric, plausible, and wrong.** My check for *is it a number* passed it happily; an offset of 999999 survived a failed retake untouched. The producer now deletes first, so a failed retake leaves no file and every consumer refuses.

**The runbook now carries an `rm -f` and a `grep -qE` on both F1 copies, refusals in T2 and the fast loop, and this whole class described where somebody will read it.**

### RULE — COPYING PRODUCTION DATA COPIES ITS OUTBOUND CHANNELS — 2026-08-23

**A proof harness copied `data/roots.db` into a scratch tree and sent three real messages to the live ops WeCom group.** Nothing was wrong with the harness except that it copied the database, and **the database carries the webhook**. Reporting it was necessary; leaving the next person a note telling them to remember would not have been.

**`scripts/make_safe_db_copy.sh` is now the only sanctioned way to copy `roots.db`.** It takes an online `.backup` (WAL-safe), severs every outbound channel, **verifies the severing, and DELETES the copy if anything survived** — because a half-neutered copy is worse than none: it looks safe.

**WHAT THE COPY CARRIED, and this is the part worth reading rather than the fix.** The webhook was not the only way out, and it was not even the worst:

| Channel | What a harness could have done |
|---|---|
| `system_alerts.wecom_webhook` | page the ops group — what actually happened |
| **`notifications.wecom_order_webhook`** | **page the ORDER group** — the people who pack food |
| `integrations.aliyun_sms.ak_secret` | **send SMS to real customers**, against 1,305 stored phone numbers |
| `integrations.feie.ukey` | print on real kitchen paper |
| `integrations.jd.*`, `integrations.kd100.*` | courier APIs — create real shipments; `kd100.callback` points back at production |
| `retail_auth_tokens` (3,874 rows) | act as a signed-in customer |
| `tenant_operator_push_subs.endpoint` | push to a real device — and an endpoint IS the channel, with no credential in front of it |

**THE CUT IS CREDENTIALS AND ENDPOINTS, NOT DATA.** You cannot text a customer without the SMS secret and you cannot print without the printer key, so severing the channels neutralises every path out **while leaving the rows intact and the copy actually useful**. Push endpoints are the exception and are cleared as data, because there is no credential in front of them.

**AND NOTE HOW THE WEBHOOK HID.** It is not a column called `webhook` — it is a ROW in `storefront_config` whose `key` is `system_alerts.wecom_webhook`. **A scan of the schema cannot see it**, exactly as A NAME HELD AS DATA IS INVISIBLE TO A SCAN OF CODE predicts. Sweeping column names found 57 candidates and missed every one of the 13 that mattered; the config keys had to be listed separately.

**Proven both ways on 2026-08-23:** a raw `cp` gives `alertStatus {enabled: true}` — a harness there reaches the live group. Via the script: `{enabled: false}`, and `sendOpsAlert` returns false having sent nothing.

---

### THE ALERT DESTINATION NOW MIRRORS TO A FILE OUTSIDE THE DEPLOY TREE — 2026-08-23

**`/root/ops-alert.conf`**, `0600 root:root`, written atomically, read in preference to the database.

**WHERE IT LIVES IS AS LOAD-BEARING AS THAT IT EXISTS.** Not under `public/`, which is served at `/assets` and would make the webhook world-fetchable — and that is not hypothetical, 2.14 MB of stale admin front-end was fetchable over HTTPS until this week. Not anywhere in `/root/roots-v2` at all: the installer only ever COPIES, so a file inside the tree survives its own deletion forever, and a rollback rewrites the tree.

**IT IS WRITTEN ON EVERY SUCCESSFUL DATABASE READ, not only when someone changes a setting.** Save-path alone would leave a fresh box with no file until somebody happened to edit an alert setting; writing on read means the first process to ask heals it, which in practice is boot — `scripts/qingyun-daemon.js` calls `alertEnabled()` in `main()`. It writes only when the content differs, so the hot path is a stat.

**ONE DELIBERATE DEVIATION FROM "ABSENT MEANS THE THIRD STATE", STATED PLAINLY.** An absent file falls back to the database and reports which source answered. Making absence a hard fault would have silenced every alert on every box that had not yet booted since this shipped — a rule enforced into an outage. **What must never happen is absent reading as SWITCHED OFF, and it does not: absent-AND-database-unreadable is the third state, loudly.**

**DISAGREEMENT IS REPORTED AND THE FILE WINS.** Two sources of truth become a bug the moment nobody can tell which answered, so the message names both destinations rather than both flags — an earlier draft said *file says ENABLED, database says ENABLED*, which is accurate and useless.

**FIVE STATES RED-PROVEN, and per the rule above, against a database made safe by `make_safe_db_copy.sh` rather than a raw copy:** file absent (falls back, then heals itself — the file appeared after the first call); file present and correct (`source: /root/ops-alert.conf`); file present but corrupt (says so, falls back); file and database disagreeing (names both destinations, uses the file); and **file absent with the database renamed exactly as F1 does** — `{enabled: false, unreadable: true}` and `CANNOT READ ALERT CONFIG`.

**EXPIRY, so the second source of truth does not become permanent.** Option (3) — reading the setting through `lib/db-driver.js` so it follows the flip to Postgres — is the destination once the window closes. The file exists because during the window the alerting layer must not depend on the database being migrated. **After the window that argument expires and so should the file.**

---

### TWO CRON SCRIPTS LIVE OUTSIDE GIT ON PURPOSE, AND NOTHING WATCHES THEM — 2026-08-23

**Correcting the framing before the finding: this is not undocumented.** §24's local-backup-retention entry (v4.26, 2026-08-11) already says **`/root/scripts` IS NOT IN GIT, AND WHAT IS PUT THERE IS LOST ON A BOX REBUILD**, and says why — a file under `scripts/` ships on the next deploy and bounces pm2. **The decision is sound and it is recorded.** `/root/check-nesting.js` is a third file kept there for the same reason.

**So committing them would not help, and would actively hurt.** They would land at `/root/roots-v2/scripts/`, which is **not the path cron calls**, so the crontab would need editing too — and from then on every retention tweak to a backup script would restart the storefront. **That is precisely the trade they were moved to avoid.**

**THE REAL GAP IS TWO THINGS, AND NEITHER IS VERSION CONTROL.**

1. **No off-box copy.** `roots-backup.sh` is the hourly SQLite tier — 12 hourly, 30 daily, optional Aliyun OSS upload of the daily. `prune-deploy-backups.sh` holds 14 days of `/root/backups/deploy-*`. **The scripts that make the backups are themselves backed up nowhere**, and a box rebuild loses them at exactly the moment their output matters most. `prune-deploy-backups.sh` says so in its own header — *NOT IN GIT. This file exists only on the box and is lost on a rebuild* — **a warning stored on the disk it warns about.**
2. **Nothing notices if they stop.** `scripts/health-watchdog.js` mentions backups zero times. Nothing checks backup freshness or age. If `roots-backup.sh` stopped tonight, `/root/backups/hourly/` would simply stop growing and **the first person to find out would be whoever needed a restore.** (Working today: 12 hourly, 30 daily, last run 12:00:50, 443 MB, method `sqlite3 .backup`.)

**AND THIS CLASS HAS NO DETECTOR AT ALL.** `scripts/diagnose_deployed_tree.js` compares the DEPLOY TREE against the repository. `/root/scripts` is not in the deploy tree, so it is not merely absent from the manifest — **it is outside the question the tool asks.** The same is true of crontabs. **Recommendation: leave them untracked, add an off-box copy, and add a backup-freshness assertion somewhere that is watched.** Not built here.

---

### THREE RUNBOOK STEPS SAVE STATE AND ONE SUBSTITUTES A NUMBER FOR IT — 2026-08-23

**Every restore in this document was audited for a check, because an instruction is not a check.**

**The one that was already right:** `data/roots.db.pre-cutover` has a full refusal ladder — R2 missing, R3 fails `integrity_check`, R4 was written after the flip. That is the standard the other three are measured against.

**1. The crontab (F0 → G9 / H8 3b) — FIXED HERE.** Both restores now run `diff <(crontab -l) /root/crontab.pre-cutover && echo CRON_RESTORED_EXACTLY`. No script was needed; `diff` is the check. **It also catches a case nobody would have thought about: a cron entry added by someone else DURING the window, which a blind `crontab /root/crontab.pre-cutover` would silently discard.**

**2. `.env.pre-cutover` (G2) — AN ORPHANED SAVE.** It is copied at G2 and **is not what restores anything**: H8 row 2 comments `TACET_DB` out instead. It is referenced exactly once, as advice under G3's wrong-port case, and never verified against the live `.env`. **A save with no restore step is a save nobody will trust at 4am.** Marked in H8; either use it or stop taking it.

**3. `/root/flip-offset` (F1) — AND THIS ONE IS WORSE THAN UNVERIFIED.** H4's fast loop reads it as:

```
B=$(cat /root/flip-offset 2>/dev/null || echo 1)
```

**A missing offset silently becomes 1**, so T2 reads the error log from the beginning, every historical error line counts, and against **a threshold of ONE** the trigger is red on its first tick for a reason that has nothing to do with the flip. **At 3am that reads as roll back.** It is the session's own anti-pattern in three characters of shell: `|| echo 1` swallows the missing-file case and substitutes a plausible number. **T2 cannot be evaluated without the offset, so a missing offset must stop the loop, not guess.** Recorded rather than changed — the loop is pasted into a laptop terminal by hand, and editing the document does not edit the copy already running.

### "STOP THE DAEMONS" HAS NEVER MEANT THE CRON JOBS — FOUND 2026-08-23

**A hazard this session created, found the same day, and closed in the runbook rather than in the code.**

Widening `health-watchdog`'s probe to fail on 5xx was right for ordinary weeks and **wrong for the cutover window**. From F1 the application's routes fail by design. The watchdog runs from **root's crontab every two minutes**, so G22's *the daemons stop for the flip* never touched it — it is not a pm2 process and nobody had checked. About four minutes in it would run `pm2 restart roots-v2`: bringing the app back on the SQLite path with its database renamed away, mid-procedure, before G2, **and adding a restart to the count PART H's H5 uses to tell a flap from a crash.** It would try to page about it through `ops-alert`, which cannot read the renamed database, so the restart happens and nobody is told.

**One restart, not a loop** — the branch is gated on `!state.down`. Precision matters here: one unwanted restart at the worst moment, silently.

**THE GENERAL FINDING IS THE SENTENCE, NOT THE FIX.** *Stop the daemons* has always meant pm2, and the box has a second scheduler nobody enumerated. **Swept 2026-08-23 across all of it** — root's crontab, other users' crontabs, `/etc/crontab`, `/etc/cron.d`, `/etc/cron.{hourly,daily,weekly,monthly}`, systemd timers, `at`, and **pm2's own `cron_restart`** (zero) — so the space is closed rather than sampled. **The project owns exactly four scheduled jobs, and two of them live in `/root/scripts/`, outside the deploy tree and untracked**, where no repository search would ever have found them.

| Entry | When | In the F1 window |
|---|---|---|
| `scripts/health-watchdog.js` | */2 | 🔴 **restarts the app.** Disabled by the new F0 |
| `/root/scripts/roots-backup.sh` | hourly | fails loudly — `set -euo pipefail` and an explicit missing-source guard. Left running: an hourly failure is a true statement |
| `scripts/db-backup.sh` | 03:30 | same shape, fails loudly. Left running |
| `/root/scripts/prune-deploy-backups.sh` | 04:30 | deletes deploy backups older than **14 days**; the flip's own is minutes old. Left running |

**Runbook: F0 disables the watchdog cron before F1 (saving `/root/crontab.pre-cutover`), G9 restores it after, and H8 gains row 3b for the ROLLBACK path** — because **a rollback that leaves monitoring off is worse than the flip that turned it off**: you are back on SQLite believing you are safe, with nothing watching, on the night you are least likely to notice.

**And H5 is marked partly stale by the same change.** It was written against a probe that only failed on silence, so its *the app answers `/` and dies again* no longer describes the trigger, and its third case — *answers `/` but is broken* — is no longer silent for READ breakage. It remains exactly true for WRITE breakage.

---

### THE WATCHDOG DID NOT MISS A DEAD APP. IT CLOSED THE INCIDENT. — 2026-08-23

**Recorded as what it did, not as what it failed to do, because the two read very differently at 3am.**

Given a watchdog already tracking an outage (`state.down = true`) and an application answering **500 on every route**, the old `res.status > 0` assertion made `scripts/health-watchdog.js`:

1. conclude the app was **alive**,
2. send **`✅ roots-v2 storefront RECOVERED — app responding on :4000 again.`**
3. and write `{fails: 0, down: false}` — **clearing the outage state.**

So the record afterwards says the incident ended. The next real failure starts from a clean slate, and the alert history shows a recovery that never happened. **An instrument that reports a false green is bad; one that actively closes a live incident is a different category**, because it destroys the evidence that there was one.

Fixed by adopting `deploy-apply.sh`'s four-path probe verbatim. The new run reports `app probe FAILED (4/99) [/=500]` and leaves the state `{fails: 4, down: true}`.

**AND THE RESTART TRIGGER GOT MORE SENSITIVE WITH IT, which is the cost of the fix.** The probe now fires on 5xx, not only on silence, and `LOAD_SKIP_PER_CORE` only guards the overload case — so an app 500ing because of a bad deploy is now restarted where before it was not. **That is mostly correct**: a 500-on-everything app is one of the things a restart sometimes fixes, and the 4xx-counts-as-up rule keeps it from being reckless.

**The knob if it proves twitchy is `HEALTH_FAILS`, 2 → 3.** It costs two minutes of detection and roughly halves the spurious-restart exposure. **It is deliberately NOT turned yet**: nothing has misfired, and tightening a threshold before it has misfired is guessing. Give it a week of ordinary operation first.

---

### THE ALERT HANDLE IS REVALIDATED BY INODE — 2026-08-23

**`lib/ops-alert.js` `roConfig()` now stats `DB_FILE` before every use and drops the cached handle if the inode changed.**

F1 renames rather than deletes, and a rename does not invalidate an open fd — so the old code split the fleet: processes that had opened the handle kept paging off the renamed inode, processes started afterwards went silent. **The inode at the path is exactly what a rename changes**, so one `statSync` per call detects it precisely. Reopening per call would also work and was rejected: it re-opens the database *during an incident*, which is when the disk is least likely to answer.

**Cost: one `statSync` per alert.** Not measurable against what it sits next to — every call already does a prepared SQLite read and then an HTTPS POST with a 8 s timeout and up to three attempts. The 57 call sites are all transition-triggered (a channel going down or recovering) except `health-watchdog`'s four per two-minute tick. **A stat is nanoseconds of syscall against a network round trip; there is no path here where it is the expensive part.**

**RED-PROVEN, AND THE OLD BEHAVIOUR PROVED ITSELF MORE VIVIDLY THAN A LOG LINE COULD.** The harness opened a handle, sent one alert, renamed the file exactly as F1 does, and sent a second. The **new** build refused the second with `CANNOT READ ALERT CONFIG (… is not there (renamed or removed))`. The **old** build printed nothing at all — because it *succeeded*: it resolved the webhook from a file that was no longer at that path and delivered the alert.

⚠️ **AND THAT PROOF HAD A REAL SIDE EFFECT, RECORDED BECAUSE IT IS THE KIND OF THING THAT OTHERWISE GOES UNSAID.** The harness copied the live `roots.db`, which carries the live webhook, and System Alerts are enabled on this box — so **three test messages were delivered to the ops WeCom group**. The text was obvious test copy, not a plausible incident. **A proof harness that copies the production database inherits its side channels**; the next one must neuter the webhook row in the copy, or stub the module, before it runs.

---

### THE WRITE PATH IS CHECKED BY OBSERVING A WRITE, NOT BY MAKING ONE — 2026-08-23

**`scripts/check_sync_freshness.js`.** PART H's own loop notes said it plainly: *"Writes. No probe on this panel writes anything."* That gap is now covered without manufacturing a row.

**Why not a write probe.** One that leaves rows behind when it dies mid-way is worse than none, and it puts test data in a production database on the one night nobody wants surprises in it. The channel daemons already write continuously — so the check reads what they left.

**N = 15 MINUTES, and the number is defensible rather than chosen.** Measured 2026-08-23: `qingyun_sync_log` took **128 rows in an hour**, 19 in ten minutes, and the **largest gap between consecutive rows across 24 hours was 133 SECONDS**. Fifteen minutes is about seven times the worst observed case — tight enough to catch a stalled write inside a couple of minutes of looking, loose enough to survive a daemon restart or a channel cool-down.

**It reports which log it read and how old the newest row is, never just pass or fail**, because *stale* without *which one and by how much* is not actionable at 3am. **Exit 0 fresh, 1 stale, 2 REFUSED** — and 2 is the one to read carefully: source absent or unreadable is **not** a pass. Verified against a missing file, a file that is not a database, and its own default path being gone: all three refuse with exit 2.

**It reads Postgres by shelling to `sudo -u postgres psql`, deliberately not through `lib/pg.js`** — which would need `TACET_PG_*` from `.env` and hit G27. Proven in both modes on 2026-08-23: SQLite fresh on two logs, and **Postgres correctly stale on all three**, because the cluster is a shadow copy nothing writes to. That is the right answer, and it is the answer a broken write path would also give — which is why the tool refuses to interpret it.

**WHERE IT BELONGS: H4's SLOW LOOP**, replacing the *Writes* line in *What the loops do NOT cover*. **Not `health-watchdog`.** A standing check cannot answer *is this daemon meant to be quiet right now?* — the 闪购 channel goes silent after 20:15 by design, and `pm2 status` does not help because that is a process which is up and correctly not writing. Wired into the watchdog it would eventually restart the application because someone paused a channel. **During PART H the operator knows which daemons are meant to be running, so the question that makes it unworkable does not arise.** The tool says so in its own output rather than leaving the reader to know it.

### THE OBSERVATION LAYER REPORTED CANNOT-SEE AS A BENIGN STATE — FIXED 2026-08-23

**Three instruments used to decide flip-or-roll-back each answered a question they could not see the answer to.** Two went quiet on a real problem; one declared a fake recovery. All three are repaired and red-proven; the proofs are the point, because every one of these reported success while failing.

**1. `lib/ops-alert.js` — three states, not two.** Its `roConfig()` caught every failure to `null`, so `webhookUrl()` returned `''` and `sendOpsAlert()` printed *SUPPRESSED (alerts disabled)*. **That message is not merely unhelpful, it is wrong**: it sends whoever reads it to Settings to switch on something that was never off. `roConfig()` now returns `{ok, value}` and `webhookStatus()` separates *unreadable* from *switched off*.

| | old | new |
|---|---|---|
| `data/roots.db` renamed exactly as F1 does | `SUPPRESSED (alerts disabled)` | `CANNOT READ ALERT CONFIG (unable to open database file)` — `alerting is NOT switched off; …/data/roots.db could not be read. NOBODY WAS PAGED:` |

**2. `lib/alert-latch.js` — the read path reintroduced the bug the file exists to stop.** `fs.existsSync()` answers `false` for *no such file* AND for *cannot read this directory*, so an unreadable `data/alert-latch/` made every latch read CLEAR. A daemon restarting mid-incident concluded it owed nobody an all-clear and **the recovery ✅ was swallowed** — which is exactly the 2026-07-25 闪购 failure this file was written to prevent, arriving through the error path instead of the memory path. The docstring covered the write path and said nothing about the read.

Now `fs.statSync(f, {throwIfNoEntry: false})`: `undefined` is genuinely-absent, a **throw** is cannot-see, and cannot-see reads as **STILL LATCHED**. Red-proven with a regular file where the directory should be (ENOTDIR — `chmod 000` proves nothing here, the box runs as root and root bypasses the check): old read `false` and swallowed the ✅; new reads `true`, logs the fault, and the ✅ fires. **The cost is named rather than hidden**: an unreadable directory on a cold start makes never-latched keys read latched, so each emits one spurious ✅. Noisy, visible, self-limiting — and the opposite mistake is silent.

**3. `scripts/health-watchdog.js` — it did not merely miss a dead app, it closed the incident.** The assertion was `res.status > 0`: **any HTTP answer counted as healthy**, so an app returning 500 on every route probed GREEN, every two minutes, for as long as it stayed up. That is the G26/G1 failure mode exactly.

**The proof is worse than the description.** Given a watchdog already tracking an outage (`state.down = true`) and an app answering 500 on every route:

- **old** — sent `✅ roots-v2 storefront RECOVERED` and wrote `{fails: 0, down: false}`. **It declared recovery and closed the incident.**
- **new** — `app probe FAILED (4/99) [/=500]`, state stays `{fails: 4, down: true}`.

The replacement is not new work: it is **`scripts/deploy-apply.sh`'s readiness probe, taken verbatim** — the same four paths (`/`, `/api/retail/categories`, `/api/retail/config`, `/api/retail/products`) and the same verdict (000 or 5xx is broken, 4xx counts as up so a stray client error cannot restart a healthy app).

**AND THAT IS THE GENERAL LESSON, WORTH MORE THAN THE FIX.** The strictest assertion in the tree was already written, already correct, and was only running **once, at ship time**, while the thing that runs **every two minutes** accepted anything. **The strictest assertion should be the one that runs continuously.** A deploy-time check protects the deploy; a monitor protects the fortnight after it.

---

### AFTER F1, ALERTING FAILS PARTIALLY — AND PARTIAL SILENCE READS AS A WORKING CHANNEL — HAZARD RECORDED 2026-08-23

**`lib/ops-alert.js` caches its SQLite handle in `_ro`, per process. Renaming a file does not invalidate an open fd.**

So at F1 the fleet splits. A process that opened the handle **before** the rename keeps reading the renamed inode and **keeps alerting normally**. A process that starts **after** it cannot open `data/roots.db` at all and goes silent. Both states persist until something restarts.

**That is worse than total silence, and this is the part to keep:** alerts continuing to arrive from four daemons is read as evidence that the alerting channel is up. Nobody checks a channel that is delivering. The two daemons that restarted during the window are the ones whose pages are being dropped, and there is nothing in the arriving traffic to say so.

**57 call sites across 12 files flow through `sendOpsAlert`** — `meituan-daemon` 15, `qingyun-daemon` 14, `shangou-daemon` 6, `routes/retail.js` 5, `health-watchdog` 4, `guanyi-daemon` 3, `server.js` 3, `meituan-drift-sweep` 2, `eleme-daemon` 2, `alert-latch` 1 — including *storefront DOWN*, `uncaughtException`, every route 500, and every channel disconnect.

**WHAT MAKING IT UNIFORM WOULD COST, reported and NOT done.** Two shapes:

- **Reopen per call.** Delete `_ro`, open and close around each read. Correct and trivial to reason about. The cost is a `better-sqlite3` open per alert — and `health-watchdog` alone reaches this four times per cron tick, plus every daemon transition. An open is sub-millisecond on a warm page cache, so the real objection is not speed but that it re-opens **during an incident**, which is the moment the disk is least likely to answer.
- **Revalidate the handle.** Keep the cache, `fs.statSync(DB_FILE)` before use, drop and reopen if the inode changed. One stat per call instead of one open. Detects the rename exactly, because the rename is what changes the inode at the path.

**Neither is applied.** `roConfig()` now drops the handle when a query throws, which is hygiene, not a repair — after a rename **nothing throws**, so that line never runs. **Revalidation is the smaller and more targeted of the two and is what I would build; it is a design decision and it is yours.**

**AND SOURCING THE WEBHOOK INDEPENDENTLY IS A DIFFERENT DECISION AGAIN.** A distinct message is the repair; **surviving F1 is the fix**, and it means not reading the migrating database at all. Three options, with costs:

1. **An env var, like `lib/platform-alert.js` already uses** (`PLATFORM_OPS_WEBHOOK`). Cheapest, survives F1 completely. **But it inherits G27 wholesale** — `.env` is parsed only by `server.js`, so every daemon and cron script would read it as unset, which is the failure this entry is about, moved.
2. **A small file beside the config**, written by retail-admin when the setting changes, read by `ops-alert`. Survives F1, no env dependency, no database. Cost: a second source of truth for one setting, and a write path in the admin that must not silently fail.
3. **Read it from Postgres after the flip**, via `lib/db-driver.js` rather than a hardcoded SQLite path. Architecturally right and the only option with one source of truth. Cost: it is exactly backwards during the window — the alerting layer would depend on the database being migrated, at the moment that database is being migrated.

**My reading: (2) during the cutover window and (3) after it**, because the window is the one time alerting must not depend on the database. Not decided here.

---

### `.env` IS NOT SHELL-SOURCEABLE — RECORDED 2026-08-23 SO NOBODY REACHES FOR THE OBVIOUS WRAPPER

**G27's tempting one-line workaround does not work, and it fails PARTIALLY, which is worse than failing.**

`set -a; . ./.env; set +a` aborts with a bash syntax error at **line 63**:

```
EMAIL_FROM=Roots <noreply@rootskitchenchina.com>
```

The unquoted `<` is a redirect. The source stops there, so **lines 1–62 load and 64–94 do not** — and the four `TACET_PG_*` variables live on lines 91–94. A caller who writes `. ./.env 2>/dev/null` gets a half-populated environment and no signal at all.

**So the minimal fix for G27 is not a shell wrapper.** It is extracting `server.js`'s `loadEnv()` IIFE into a module the scripts require — which parses `KEY=VALUE` literally and does not care what the value contains. Not built; out of scope for this pass.

---

### THE SHAPE TO COPY: A WATCHDOG WHOSE FAILURE IS DETECTED BY A DIFFERENT PROCESS — 2026-08-23

**`scripts/meituan-daemon.js` watches whether `proxy-watchdog` is still WRITING**, not whether it is running. If the proxy choice goes stale it logs `proxy_stale`, re-elects its own path, and pages: *proxy-watchdog isn't updating — check `pm2 status proxy-watchdog`*. When it resumes, a ✅ follows.

**That is the pattern the rest of this layer lacks.** Every other instrument here answers for itself, and an instrument that answers for itself cannot report its own absence — the same shape as A VERIFIER THAT SHARES THE COPIER'S MAP CANNOT AUDIT THE MAP, applied to liveness instead of data. `proxy-watchdog` is `online` again as of 2026-08-23 10:14, having been stopped for the whole 2026-08-21 session; **the detector is why that was visible at all.**

**Its one weakness, and it is the one this entry is about: the alert flows through `sendOpsAlert`.** After F1 the detector survives and its output does not. **A cross-process detector is only as good as the channel it reports on**, which is an argument for fixing the channel before copying the pattern anywhere else.

### THE DETECTOR FOR THE BOX'S DRIFT HAD DRIFTED — ITEM 60 CLOSED 2026-08-21

**`scripts/diagnose_deployed_tree.js` is the only thing that compares the box against the repository, and its manifest was 77 commits stale.** Regenerated at `cfaefd77`.

> ⚠️ **THE FIRST VERSION OF THIS ENTRY REPORTED 17 REAL DIFFERENCES AND THERE ARE NONE. CORRECTED WITHIN THE HOUR, LEFT VISIBLE BECAUSE THE MISTAKE IS THE LESSON.** The manifest was first regenerated at `99b4031f`, which was my local `HEAD` — and **101 commits had landed on `main` while this work was in progress, touching 43 deployable files.** The box had those deploys; my reference did not. So seventeen files that were simply NEWER than my manifest were reported as *production is not running what `main` says*. **Regenerated against the true `HEAD` the count is zero.** I wrote three rules this session about measuring against a stale reference and then did it, in the pass that was about a detector having drifted. **A stale reference does not announce itself as stale; it announces itself as a finding.**

**WHAT THAT COST, MEASURED BEFORE AND AFTER ON THE SAME BOX:**

| | stale manifest (`48965bba`) | regenerated at `99b4031f` | regenerated at `cfaefd77`, the true HEAD |
|---|---|---|---|
| match | 394 | 544 | **586** |
| **DIFFER** | **88** | 17 | **0** |
| MISSING | 1 | 0 | **0** |
| EXTRA | 122 | 40 | **15** |
| verdict | FAIL | FAIL | **PASS** |

**EVERY ONE of the 88 differences was the detector. NONE was the box.** The deployed tree is exactly the repository at `cfaefd77`. A tool that reports 88 drifted files when zero have drifted is worse than no tool: it is a number nobody can act on, so nobody reads it, **and the day something real drifts it will look like the other eighty-eight.**

**NOTHING IS DRIFTING, AND THAT IS THE RESULT.** `0 differ, 0 missing`, verdict **PASS**: every deployable file on the box is byte-identical to its committed blob at `cfaefd77`. **The stranding channel this tool was built to find is, today, empty** — which is worth recording precisely because the earlier draft of this entry claimed the opposite from a stale reference. **The one file that cannot match is `package-lock.json`**, rewritten in place by `npm install --omit=dev`, reported and never judged, exactly as `INSTALLER_REWRITTEN` intends.

---

**ITEM 24 HAS A DETECTOR AFTER ALL, AND NAMING IT IS THE POINT.** The brief for this pass assumed nothing detected files present on the box and absent from the repository. **That was wrong** — `diagnose_deployed_tree.js` has had an `EXTRA` category since it was written, computes it at `for (const rel of onBox) if (!(rel in MANIFEST)) extra.push(rel)`, reports it under *files on the box the repository does not have*, and its own header already explains the exact mechanism: *deploy.yml skips deletions (`[ -f "$f" ] || continue`) and deploy-apply.sh only ever copies, so a file deleted from main stays live forever.*

**It also already separates the three categories** this pass would have added — `EXTRA` (box-only, stale residue), `DIFFERS` (hashes differ, real drift), `REWRITTEN` (deliberately excluded, counted not failed), plus `MISSING` (repo-only). **No code was needed. The condition was false.**

**SO WHY DID `copy_order.json` SIT THERE UNNOTICED? TWO REASONS, AND NEITHER IS A MISSING FEATURE.**

1. **`EXTRA` never fails the run, by design** — *"a check that is permanently red is a check people learn to ignore, and then it stops catching the thing it exists for."* That reasoning is sound and is not being overturned here. But it means item 24 is **detected and not enforced**.
2. **Nothing runs the tool.** `ro-query.yml` is `workflow_dispatch` only — no `schedule`, no cron entry on the box, no systemd timer. Verified all three. **It runs when a human asks, and nobody had.**

**A detector that is stale and unrun is not a detector.** Item 24's status is therefore: **it has a detector, the detector is now current, and it is still neither enforced nor scheduled.** Whether to schedule it is a decision nobody has taken.

**15 EXTRA files stood on the box, and 14 were deleted on 2026-08-23** ⚠️ **FOUR OF THEM WERE PUBLICLY FETCHABLE OVER HTTPS AND HAD BEEN FOR MONTHS.** `public/` is served at `/assets`, so `public/retail-admin.js` (940 KB), `public/retail-admin.html.bak` (760 KB) and `public/cms.html.tmp/` (442 KB) answered **HTTP 200 with full content** at `https://store.rootskitchenchina.com/assets/…` — **2.14 MB of stale admin front-end**, the oldest sitting there since 2026-05-20. **They carried NO credentials**, verified by extracting every `password|secret|api_key|token|Bearer` match rather than counting them: all are identifiers, DOM ids and prose (`secret_masked`, `v('jd-app_secret')`, `<code>SECRET</code> are configured in <code>.env</code>`). The exposure was old admin logic and internal API paths. **`public/retail-admin.js` is item 24's pure case** — the only one of the fifteen ever committed, deleted from `main`, and left live by an installer that only ever copies. Ten `.bak-*` files (hand-made during June/July incidents, 2.5 MB, none loadable by Node since it resolves `.js`/`.json`/`.node` and never `.bak-lowio`) went with them. **4.69 MB removed; the app stayed healthy across it.** The fifteenth, `scripts/zero_yuexiu_stock.js`, is KEPT and now listed in `EXPECTED_EXTRA` with its reason — its own header says *untracked ON PURPOSE: a committed `scripts/` file ships and bounces pm2*, which is this project's own finding applied correctly. The old wording follows (it read 40 against the `99b4031f` manifest; 25 of those were simply newer than it), and the list is worth reading rather than summarising: `.bak-*` copies made by hand during incidents (`lib/jd.js.bak-decouple-20260627`, `routes/retail.js.bak-sysalert`, six more), a `public/cms.html.tmp/` build directory, `public/retail-admin.html.bak` and `public/retail-admin.js`, and about twenty `scripts/test_*.js` and `scripts/diagnose_*.js` that exist on the box and not in `main`. **Four more were mine** — `__pycache__/*.pyc` left by running `drift_guard.py` in the deployed directory to verify a deploy, removed by hand, and a reminder that a diagnostic run leaves residue too.

---

**THE GENERATED BLOCK HAD A RECIPE, NOT A GENERATOR, AND THAT IS WHY IT DRIFTED.** Its header carries a shell one-liner for regenerating `MANIFEST` — which is real and which works. **But the block holds THREE values and the recipe covers ONE.** `MANIFEST_COMMIT` and `MANIFEST_SW_NORMALIZED` had to be updated by hand, and a hand step next to an automated one is the step that gets skipped. **A generated block whose regeneration is a comment is a hand-maintained file wearing a generated file's clothes.**

Regenerated here by a script that does all three, run from the scratchpad rather than committed. ⚠️ **And it must be run against the TRUE `origin/main`, not a local `HEAD` that has fallen behind** — that is what produced the 17 phantom differences above. **Committing a generator is still owed and is its own small pass**, because it is not free: a new file under `scripts/` is itself deployable, so it would have to appear in the manifest it generates, which the current HEAD-based recipe cannot do — the generator would need to hash the INDEX after staging itself. Recorded rather than improvised.

**One detail worth keeping: the hashes come from `git ls-tree -r HEAD`, i.e. git's stored blobs, NOT the working tree.** This worktree is Windows under `* text=auto`, so a working-tree file is CRLF while its blob is LF. The Linux runner checks out blob bytes and the deploy scp's them verbatim, **so the blob is what lands on the box.** Hashing the working tree would have produced a manifest that disagreed with production on every text file — a 562-entry false alarm.

### THE COPY ORDER IS DERIVED, NOT STORED — ITEM 59 CLOSED 2026-08-21

**`copy_order.json` is deleted.** `run.py` `derive_copy_order()` builds the order at run time: **membership** from `plan["tables"]`, **constraint** from SQLite's own declared foreign keys, **an alphabetical tie-break** for everything else.

**WHY DELETE RATHER THAN GUARD, AND THE NUMBER THAT SETTLED IT.** A stored order can only be wrong by omission, and omission was expensive: the `TRUNCATE` list came from `plan.json` and the load order from the file, so a table in the first and missing from the second was **emptied and never refilled** while every other check passed. Against that cost, measured on 2026-08-21:

| | |
|---|---|
| Steps where more than one table was eligible | **162 of 164** |
| Widest tie | **67 tables at once** |
| Tables in no foreign key at all | **51 of 164 (31%)** |
| Longest dependency chain | **4** |

**So the order was about 2% graph and 98% tie-break.** A file whose downside is a silent truncate-and-never-refill and whose upside is ordering tables that can go anywhere is not worth keeping. **Deleting it removed the file, guard checks 5 and 6, and this item — three things for one function.**

**THE TIE-BREAK IS A DECISION AND IT IS ARBITRARY. SAYING SO IS THE POINT.** It is *alphabetical among whatever is currently eligible*, and it determines **162 of the 164 positions**. **It must not be described as "the foreign-key order"** — that would credit the graph with a sequence it does not fix. Alphabetical was not chosen because it means anything. **It was chosen because it is STABLE**, and stability is the property that matters: an order that varied between runs would make two rehearsals incomparable and an order-dependent failure impossible to reproduce.

**DETERMINISM PROVEN, NOT ASSUMED — FOUR RUNS, ONE HASH.** Twice inside one process, once in a fresh process, and twice more under `PYTHONHASHSEED=12345` and `PYTHONHASHSEED=999`. All four outputs **byte-identical**, sha256 `ea2b9096…`. This mattered enough to prove because the obvious implementation — iterating a set of ready tables — varies with the hash seed **across processes only**, so it would pass every in-process test and still hand back a different valid order on the box. `derive_copy_order()` iterates sorted lists and never a set or a dict, and the docstring says why.

**COMPLETENESS ASSERTED IN CODE, not relied on.** The derived order must be exactly `plan["tables"]` — same set, same count — and `derive_copy_order()` exits 2 if it is not. The `TRUNCATE` and the load now come from the same dict so they cannot diverge; the assertion is there because **"cannot diverge" is exactly what was believed about the stored file.**

**THE ONE REAL LOSS, PRESERVED FROM THE OUTPUT SIDE.** The file was also a record of the order every verified copy actually ran in — evidence, if a failure ever turns out to be order-dependent. `run.py` now writes **`copy_order_used.json`** beside `timings.json`: the order that run actually used, where it cannot drift from what happened.

**THE DERIVED ORDER IS NOT THE STORED ONE.** They diverge from position 1 (`tenant_onboarding` vs `ai_app_help`), so it was rehearsed rather than assumed. Both satisfy the graph.

---

### VERIFIED NEGATIVE — SQLITE'S AND POSTGRES'S FOREIGN-KEY GRAPHS ARE IDENTICAL — 2026-08-21

**Recorded because a verified negative is worth as much as a finding, and nobody will re-derive this otherwise.**

**145 edges on each side, and the set difference is empty in BOTH directions.**

This is a set comparison, not a count match: each edge is `(child table, child column tuple, parent table, parent column tuple)`, and SQLite's implicit-PK form — where `PRAGMA foreign_key_list` returns `to = NULL` because the reference is to the parent's primary key — was resolved to the parent's actual PK columns before comparing. **`IN POSTGRES, NOT DECLARED IN SQLITE: 0`. `DECLARED IN SQLITE, NOT IN POSTGRES: 0`.**

**WHAT IT LICENSES.** `derive_copy_order()` reads SQLite's declared graph rather than the cluster's, which is what lets it — and the guard — run and refuse before Postgres is reachable. That substitution is only sound because the two graphs are the same, and this is the measurement that says so.

**AND IT HELD THROUGH A CHANGE MADE THE SAME DAY**: `fk_ingredient_cost_skips_1` was added to Postgres on 2026-08-21 and SQLite had declared it on 2026-08-17. The two have stayed in step across the whole migration, including the G28 rename.

One self-referencing edge exists on each side (`retail_media_folders`). It is excluded from the table-level sort deliberately — a self-reference is a ROW ordering problem, and `gen.py` `order_by()` already handles it with `"parent_id" NULLS FIRST`.

---

### `verify.py` NOW DISCLOSES ITS OWN SCOPE — 2026-08-21

**The corollary to A VERIFIER THAT SHARES THE COPIER'S MAP CANNOT AUDIT THE MAP, acted on.** `verify.py` still builds its comparison from `plan.json`'s `cols[]`, and still cannot detect its own blind spot. **What changed is that its number no longer reads as total coverage.** It now prints, beside the result, what it examined and what in the live source it did not:

```
  tables examined                     : 164 of 164 in the live source
  columns examined                    : 1928
  live tables the map cannot see      : 0
  live columns the map cannot see     : 0
  -> every table and column examined was compared in full
```

**THREE CATEGORIES, AND SEPARATING THEM IS THE WHOLE VALUE.** A live table absent from `plan.json`, and a live column absent from `cols[]` in a table that WAS examined, are **blind spots** — listed in full, and they trigger `*** THIS RUN IS NOT A CLEAN BILL OF HEALTH ***` in those terms. A planned table the caller simply did not ask for on the command line is **the caller's own scoping** — counted, not listed, and not a warning. **The first cut of this conflated them and printed all 163 unrequested tables when one table was verified, burying the single real finding in them.** Verifying one table is a normal way to run this.

**RED-PROVEN:** `retail_orders.channel_note` hidden from `cols[]` — the run reported `LIVE COLUMNS ABSENT FROM cols[] : 1  (in tables that WERE examined)` and named it, instead of reporting clean. Restored to green after.

**THE EXIT CODE IS UNCHANGED AND STILL REPORTS DIFFERENCES ONLY.** Scope is disclosed in the output, not folded into the code, because a caller that has always read `0` as *no differences* must keep reading it that way. **The line a human reads is the one that changed.**

### THE TUNNEL REBUILD REMOVED BLIP-TOLERANCE — A STANDING PROPERTY, NOT AN INCIDENT — 2026-08-23

**The link did not get worse on 08-22. The thing that was hiding its blips was replaced.**

**WireGuard over UDP is connectionless.** A few lost packets are a few lost packets; the local endpoint persists and nothing above it notices. **The reverse SSH tunnel over TCP/22 is a session.** The SOCKS listener on `127.0.0.1:1180` is owned by the `sshd` process serving user `tianheproxy` — confirmed by `ss -lntp`, whose PID matched the minute of the last flap exactly. **When that session drops the listener goes with it, and the proxy is not degraded, it is gone.**

**So the same underlying link quality now produces hard proxy outages where it used to produce nothing at all.** 44 re-establishments on 08-23 (cross-checked against 56 distinct sshd PIDs, the same count including privsep children), each one a `proxy switch — relaunching Chrome` and, for Yuexiu, a cold browser on a Hong Kong IP.

**RECORD IT AS A PROPERTY OF THE CURRENT DESIGN.** The tunnel is the right call — GFW blackholes the WireGuard UDP path, so this is session-fragility bought in exchange for working at all. **But anything built on top of it must assume the listener can vanish and return**, which is exactly what a one-sided UP threshold and a missing middle rung failed to assume.

**It is settling rather than chronically bad, on the evidence so far:** 40 re-establishments in hour 11 (when it was being built), 4 in hour 12, **and none in hours 13 or 14.** Two clean hours is not a week — stated as the sample, not as a verdict.

---

### THE GZ RUNG COMPARISON, WITH ITS LIMIT — 2026-08-23

**The control is unusually good and it is still not a clean experiment. Both halves belong in the record.**

**What makes it strong:** tianhe and yuexiu are probed by the same `proxy-watchdog` process, fail over on the same probe **one second apart**, and show **identical UP-period durations (63s, 675s)** because `residentialUrl()` takes no channel argument — there is one tunnel and both stores exit through it. The only difference is where a failure lands them: tianhe on the GZ datacenter (Guangzhou), yuexiu on direct (Hong Kong).

| | verify rows in DB | challenges in the daemon log |
|---|---|---|
| tianhe — has the rung | 1 | **0** |
| yuexiu — no rung | 18 | **114** |

**What keeps it from being conclusive:** the two stores also run **different daemons against different channels** — `meituan-daemon.js` against 美团 main, `shangou-daemon.js` against 闪购. 闪购 may simply enforce risk control harder. **The rung and the channel are confounded**, and 0-versus-114 cannot separate them on its own.

**Which is why giving Yuexiu the rung is an experiment and not only a fix.** If the challenges stop while it stays on 闪购, the channel is ruled out and the country-change mechanism is confirmed.

---

### THE HOLDERS HAVE NO RELAUNCH DEBOUNCE AT ALL — 2026-08-23

**Searched for and not found in `scripts/shangou-chrome.js` or `lib/browser-warmup.js`: any cooldown, minimum interval, consecutive-count or rate cap on relaunching Chrome.** A proxy switch relaunches the browser immediately, every time, with nothing in the holder limiting how often that can happen.

**So `proxy-watchdog`'s `FAIL_THRESHOLD` is the ONLY guard anywhere in the chain — and it guards one direction.** `failCount[key] = ok ? 0 : (failCount[key] || 0) + 1` means two consecutive failures to declare DOWN and **a single success to declare UP**. The comment above it names *thrashing browser relaunches* as the harm it exists to prevent.

**This is the more serious half of the finding.** A one-sided threshold is a bug in a guard. **No guard at the place where the expensive thing actually happens is a missing layer**, and it means any future source of proxy churn — not just this tunnel — arrives at the browser unthrottled.

**`UP_THRESHOLD = 4` (~2 minutes at a 30s check) rests on TWO complete UP periods: 63s and 675s.** The 63s one is the false recovery; 4 gives roughly 2× margin over it. **Two periods is not a distribution** — stdout mirroring of the watchdog log is recent, so there is no more history to draw on. The number is defensible against what was observed and should be re-derived from a week of log before it is treated as settled.

---
### RULE — AN INSTRUMENT CAN BE RIGHT AND UNREAD — 2026-08-23

**`isColdStartChallenge` had the answer to the 闪购 challenges from the first one, and printed it every time.** Its message reads *right after a browser relaunch — session intact; the cool-down clears it on its own*. That is the correct diagnosis. It was written into the log 113 times and nobody followed it back the one further step to *why is the browser relaunching*.

**This is not a missing detector. It is a detector that fired, was correct, and was read as noise** — because it appeared beside a wall of Chrome GLib/DBus/Vulkan warnings, and because its own message ends reassuringly (*no action needed*), which is true about the session and silent about the cause.

**Same family as A CHECK THAT CANNOT RUN MUST REFUSE and the manifest nobody regenerated, but the failure is one step further along.** There the instrument was absent or broken. Here it worked. **The output existed and the chain from it was never walked.** An instrument that explains a symptom in terms of another symptom has done its job and is not finished being useful.

---

### TWO OPERATIONAL TRAPS FOUND LOOKING FOR AN OFF SWITCH — 2026-08-23

**Neither is about 闪购. Both apply to anything on this box.**

**1. `pm2 stop` IS NOT DURABLE HERE.** Read out of pm2's own source rather than assumed: `God.restartProcessId` ends

```js
else { debug('[restart] process not online, starting it'); return God.startProcessId(id, cb); }
```

so `pm2 restart <name>` **starts a stopped process**. `bounce_daemon` in `scripts/deploy-apply.sh` runs exactly that on any `lib/*` change. **A daemon stopped by hand comes back on the next shared deploy** — at 48 deploys in two days, within hours, silently, and the operator who stopped it has no reason to look. **If something must stay down across a deploy it has to be `pm2 delete`d or gated in config, not stopped.**

**2. A DISABLE FLAG THAT DOES NOT DISABLE.** `const SHANGOU_STORES = (process.env.SHANGOU_STORES || 'yuexiu').split(',').map(s => s.trim()).filter(Boolean);`

**Setting `SHANGOU_STORES=` empty does nothing** — an empty string is falsy, so `||` substitutes the default and the daemon carries on polling the store you just tried to switch off. The only value that yields an empty list is a **bare comma**, which is truthy, splits to two empties, and filters to nothing. **A flag whose obvious value is a no-op, and whose working value is a punctuation mark.** The `|| default` idiom does this everywhere it appears over a list; it cannot express *explicitly none*.

---
### 🔴 THE 闪购 CHALLENGES ARE A PROXY FLAP, NOT A BROWSER CRASH — 2026-08-23

**Chrome is not dying. It is being deliberately relaunched, and the trigger is one line in its own log:**

```
[shangou-chrome] proxy switch (socks5://127.0.0.1:1180 → direct) — relaunching Chrome
[shangou-chrome] proxy switch (direct → socks5://127.0.0.1:1180) — relaunching Chrome
```

**THE CHAIN, END TO END:** the residential tunnel flaps → `proxy-watchdog` fails the channel over → Chrome's proxy is a launch argument, so the holder must relaunch → the fresh browser hits 闪购 cold → 风控 answers 418 → `noteVerifyResult` starts a back-off. **`isColdStartChallenge` was telling us this all along** — it labelled the 12:25 challenge *right after a browser relaunch, session intact*. The daemon knew. Nobody had followed it back one more step.

**AND IT EXPLAINS WHY YUEXIU AND NOT TIANHE, which is the part worth keeping.** Both stores fail over on the same probe, one second apart. They do not land in the same place:

| Store | Tiers | Where a residential failure lands it |
|---|---|---|
| tianhe | residential → **GZ datacenter** → direct | a Guangzhou IP — 闪购 sees nothing odd |
| yuexiu | residential → direct | **a Hong Kong IP** — a Guangzhou store calling from abroad |

**Tianhe is not getting away with it; it has a middle rung and Yuexiu does not.** Yuexiu's watchdog line reads `门店住宅代理 · 直连(香港)` with no GZ entry at all. **The challenge is not really about a cold browser — it is about the exit IP changing country mid-session.**

**THE HYSTERESIS IS ONE-SIDED, AND THAT IS WHAT MAKES IT OSCILLATE.** `FAIL_THRESHOLD = 2` consecutive failed probes to declare DOWN, **but UP again on the first success.** A tunnel that is marginal rather than dead therefore rings back and forth: 04:11 down, 04:20 up, 04:21 down, 04:22 up — four transitions in eleven minutes, each one relaunching two browsers. **The comment above the threshold names the exact harm it was written to prevent** — *thrashing browser relaunches* — and it prevents it in one direction only.

**WHEN IT STARTED.** Proxy switches were rare for two months (2 at a time, weeks apart), with one burst on 08-08. They resume **08-22 12:00** and are worst on 08-23: 2, 4, 5 per hour. That is the window in which the Tianhe residential path was being rebuilt as a reverse SSH tunnel over TCP/22. **63 switches all-time on this holder, 11 of them today.**

**SO PERSISTING `verifyState` FIXES 23 OF 113. THIS IS THE OTHER 90.** Stabilising the tunnel, or giving Yuexiu a Guangzhou middle rung, removes the cause rather than the symptom — and a back-off that persisted across restarts would, on its own, have made a flapping tunnel look like a channel that had gone permanently quiet.

### I PRESENTED SELECTED HOURS AS THE MEASUREMENT — 2026-08-23

**Recorded as an instance of the failure this work has spent a week dismantling, not as a correction.**

Asked which hour was safe to deploy in, I ran a 24-hour histogram and then **hand-picked rows into the report** — dropping 00, 09, 14, 15, 19, 21, 22 and 23 for brevity, and writing the two genuinely empty hours as `—`. The reader could not tell which absences were zeros and which were omissions. **Only 04 and 05 were real zeros; the other eight were me editing.**

**This is exactly the shape of the `2>/dev/null` swallows fixed the same day**, and of a manifest that lists what it found without listing what it could not look at. **An omitted zero and a missing measurement are indistinguishable to whoever reads the table**, and the person reading it was choosing an hour to take the storefront down in.

**THE RULE THAT COMES OUT OF IT: a table with a row missing is not a shorter table, it is a different claim.** Generated series, LEFT JOIN, explicit `0`. Never a filtered `GROUP BY` presented as a census. The corrected version cross-checked to 260 orders against the per-channel totals, which is the other half — **a total that reconciles is how you know no row was dropped.**

---

### DELAYED, NOT LOST — THE MECHANISM, SO IT NEED NOT BE RE-DERIVED — 2026-08-23

**An order arriving while a daemon is bouncing is picked up on the next poll and processed normally.** Verified rather than reasoned from the poll interval, on three independent facts:

1. **The fetch is window-based, not incremental.** `gzgrocery-order-daemon.js` uses `SINCE_DAYS = 3`; `meituan-daemon.js` and `shangou-daemon.js` both use `ORDER_SWEEP_DAYS = 3`. **Every poll re-reads the last three days**, not *since last time*.
2. **No daemon persists a cursor.** Checked across all four — there is nothing to lose on restart, because the window is re-derived from the clock on every sweep.
3. **Re-reading is the normal case and dedupe is explicit.** `meituan-daemon.js` checks `existing` and branches before inserting, backed by `INSERT OR IGNORE INTO meituan_sync_queue`.

**A 35-second bounce is roughly 7,400× inside a three-day window.** The stock-push queues are DB tables (`meituan_sync_queue`, `guanyi_sync_queue`, `qingyun_push_queue`) so queued work waits and drains. **What does NOT survive is the 30-minute sweep timers, which restart their clock rather than resume** — a bounce can delay a drift sweep by up to half an hour.

---

### 🔴 DEPLOYS TRIGGER 闪购 RISK-CONTROL CHALLENGES, AND NOBODY WAS COUNTING THE COST — 2026-08-23

**`verifyState` in `shangou-daemon.js` is a module-level in-memory object. A restart clears it, so an active back-off is discarded and the daemon calls into risk control on its next tick.** Measured, not theorised:

| | |
|---|---|
| Challenges in the daemon log | **113** |
| Within 60s of a daemon start | **23** — and every one of the 23 at **0—2 seconds** |
| Daemon restarts in the log | 77 |
| Deploys in the last two days | 48 |

**A 0—2 second lag is not correlation, it is the sequence:** the daemon starts, `verifyState` is empty, the first call goes out, risk control answers 418.

**AND THE BACK-OFF CAN NEVER REACH ITS CAP WHILE DEPLOYS KEEP CLEARING IT.** The ladder is 30 min → 60 → 120 → 240, capped at four hours. On 2026-08-22, left alone, Yuexiu climbed to the 240-minute cap and sat there. On 08-23, with deploys landing, the strike counter reset to 30 minutes at 10:15, 11:25, 11:52 and 12:25 — **four resets in two hours, each one a fresh call into a channel that had just refused.** The exponential back-off is doing nothing; it is being restarted faster than it can climb.

**THE LOG UNDERCOUNTS IT BY A FACTOR OF SIX, WHICH IS WHY THIS WAS INVISIBLE.** `noteVerifyResult` gates its database write behind `verifyFlagged`, a log-once-per-transition latch. **113 challenges in the daemon log, 19 rows in `meituan_sync_log`.** Reading the table alone gives *five challenges in two days*; reading the daemon log gives *seven today*. **A dedupe latch on the ALERT silently became a dedupe latch on the RECORD.**

**AND THE ASYMMETRY IS BACKWARDS.** The alert latches are on disk (`lib/alert-latch.js`, `data/alert-latch/`) and survive a restart, so a recovery notice cannot be swallowed. **The back-off that decides whether to CALL is in memory and does not.** The thing that protects the channel is the volatile one; the thing that protects the inbox is durable.

**WHAT THE BACK-OFF GATES**, all via `inVerifyCooldown`: `pushableStores()`, `pollOrders`, the stock-push queue loop, and business-status sync — effectively every outbound call for that store. **All of them resume at once on restart.**

**SAME SHAPE ELSEWHERE:** `meituan-daemon.js` and `qingyun-daemon.js` both declare `verifyState = {}`; Meituan additionally holds `browserDown`, `bindingDown` and `stallState` in memory. `guanyi-daemon.js` and `gzgrocery-order-daemon.js` have none. **Not fixed here** — persisting it belongs beside `alert-latch`, and an unreadable store must read as STILL COOLING DOWN, never as clear, or the failure mode is the one being fixed.

### RULE — A CHANGE-DETECTOR CANNOT SEE A FAULT PRESENT AT STARTUP — 2026-08-23

**PART H's fast loop watches one line a minute and rings on any change.** It is a good rule and it has a hole with nothing in it to notice: **it compares each tick to the last, so a value that was already wrong when the loop started never changes and never rings.**

Two of the four fallbacks fixed on 2026-08-23 landed exactly there. A missing error log made `grep -c` count **0 new errors**, and a missing health log left the watchdog count **empty**. Both were wrong from tick one, both stayed constant, and the loop reported a steady green line for the whole window.

**THE GENERAL FORM: a monitor that alerts on DELTA is blind to a fault that predates it.** Startup faults, missing inputs, a probe pointed at the wrong path, a credential that was never set — none of them move. **Only a monitor that also asserts the ABSOLUTE state can see them**, which is why every input on that panel now emits `*** … ***` in the line rather than a plausible number, and why a `***` field is documented as *this trigger is not being evaluated at all* rather than as green.

Beside [A CHECK THAT CANNOT RUN MUST REFUSE]: that one is about an instrument that fails, this one is about an instrument that was never pointed at anything.

---

### RULE — A SHAPE-BASED SWEEP ONLY FINDS SHAPES — 2026-08-23

**Sweeping PART H for default-on-missing found three, by searching for the operators that create one:** `|| echo`, `|| true`, `2>/dev/null`, `${VAR:-default}`, `COALESCE`, a catch returning a constant. Thirteen shapes, cross-checked by a second method, counts agreeing exactly.

**It still missed one, and the one it missed was the trigger command itself.** `$(( $(cat /root/flip-offset) + 1 ))` has **no operator of any kind.** The default comes from bash evaluating an empty string as 0 inside `$(( ))`. There is nothing there to grep for.

**So a sweep by shape reports a complete answer to *which known shapes appear* and reads as an answer to *where can this silently default*.** The sweep was extended to implicit defaults — arithmetic on a command substitution, `grep -c` on a path that may not exist, `wc -l` of a glob, a test on an unquoted variable — and that second pass is what found it.

**The lesson is not *add arithmetic to the pattern list*.** It is that **a language's free coercions are exactly the defaults nobody wrote and nobody can search for**, so a shape sweep must be followed by reading the steps that matter. Same family as A SCAN OF CODE CANNOT SEE A NAME HELD AS DATA and A SCAN OF SCHEMA CANNOT SEE A SECRET HELD AS A ROW: **the method answers the question it can ask, and its silence is not evidence.**

---

### THE 48 RESTARTS WERE 48 DEPLOYS — 2026-08-23

**`roots-v2` showed 1417 restarts and one three minutes before it was looked at, on a box whose health probe had just been made stricter. The suspicion was that the new probe was restarting the app on transient 5xx. It is not, and the numbers are exact.**

| Question | Measured |
|---|---|
| Restarts since the 08-21 alerting deploy | **48** (1369 → 1417) |
| Deploys in the same window | **48** (35 on 08-22, 13 on 08-23) |
| `unstable_restarts` | **0** — lifetime |
| Watchdog restarts since 08-21 | **none** |
| Last `probe FAILED` line of any kind | **2026-07-13**, six weeks ago |
| `storefront DOWN` lines ever recorded | **0** |

**One deploy, one restart, 48 for 48.** `scripts/deploy-apply.sh` runs `pm2 restart roots-v2 --update-env` unconditionally as step 5/5, so the count is a deploy counter wearing a health metric's name. **And `unstable_restarts` is 0 over the process's whole life, which per H5's own discriminator means not one of the 1417 was a crash.**

**THE STRICTER PROBE HAS NEVER FAILED ONCE.** It was made to fail on 5xx on four paths on 08-21; every `probe FAILED` line in the log predates it, and none carries the `[probeDetail]` bracket the new probe prints. **So `HEALTH_FAILS` 2→3 stays untouched** — there is no evidence to turn it on, and turning it would blunt an instrument that has not yet made a single false call.

**What the restart rate actually tracks is how hard this migration is being worked:** 3 deploys on 08-18, 5 on 08-19, 12 on 08-20, 22 on 08-21, 35 on 08-22. **A restart counter is a poor smoke alarm on a box that ships thirty times a day**, and reading it as one is what made 47 look alarming.

### RULE — A VERIFIER THAT SHARES THE COPIER'S MAP CANNOT AUDIT THE MAP — RECORDED 2026-08-21

**The most generalisable thing this session produced, and it was found the hard way.**

`gen.py` builds its SELECT from `plan.json`'s `cols[]`. **`verify.py` builds its cell-by-cell comparison from the same `cols[]`.** So on 2026-08-21 the round-trip reported **4,220,046 cells compared, 34 differences, every one attributed** — and `retail_orders` came back **OK at 120,546 cells** while `refund_printed_at` and `channel_note` had never been copied and were never looked at. **The verification was not weak. It was scoped by the thing it was verifying.**

**THE SHAPE, STATED SO IT IS RECOGNISABLE ELSEWHERE: when an instrument takes its SCOPE from the same artefact as the thing it audits, it can only ever confirm that artefact's internal consistency.** It cannot see what the artefact omits, and its silence about the omission is indistinguishable from a pass. **A high cell count is not coverage.** 4.2 million cells and eleven blind columns were the same run.

**THREE MEMBERS OF THIS FAMILY ARE NOW IN §24, AND THEY ARE THE SAME FAILURE SEEN FROM THREE ANGLES:**

- **A count derived from a scan** is correct about its criterion and silent about the criterion's edge — an extractor that truncates rather than failing, a `grep` that reads the front of a name.
- **A name held as DATA is invisible to a scan of CODE** — `CONTROL_PLANE_TABLES`, the archived `sequences.json`, `copy_order.json`.
- **A verifier sharing the copier's map cannot audit the map** — this entry.

**WHAT IT COSTS TO FIX IS SMALL AND THE FIX IS ALWAYS THE SAME: give the auditor a DIFFERENT source from the audited.** `volume.py` now reads the live schema instead of `cols[]`, so `wide_cols.json` cannot miss a column the census never recorded. `drift_guard.py` compares `plan.json` against the live source and against `copy_order.json`, so neither can drift alone. **Neither is clever. Both simply refuse to look through the same window twice.**

**AND THE COROLLARY, WHICH IS THE PART TO CARRY: an instrument that reports a number should also report what it did NOT examine.** `verify.py` still does not do this — it prints cells compared, not columns skipped, and it has no way to know it skipped any. That is why the guard runs first rather than the verifier running smarter.

### WHAT `drift_guard.py` DOES AND DOES NOT CHECK — RECORDED 2026-08-21

**Written down because a guard's name invites the assumption that it covers everything, and this one deliberately does not.**

**IT CHECKS, and refuses the copy on any difference:**

1. **Every live SQLite table is in `plan["tables"]`.** A table added since the census would otherwise not exist in Postgres at all.
2. **Every `plan["tables"]` entry is a live SQLite table.** The reverse: the copy would fail on a table the source has dropped.
3. **Every live column is in that table's `cols[]`.** A column added since is otherwise dropped with no error, invisible to `gen.py` AND to `verify.py`.
4. **Every `cols[]` entry is a live column.** The SELECT would fail loudly on these, which is the safe direction, but it is still drift.
5. ~~**Every `plan["tables"]` entry appears in `copy_order.json`.**~~ **REMOVED 2026-08-21 — THE ARTEFACT IS GONE, NOT THE COVERAGE.** This check existed because `run.py` truncated from `plan["tables"]` and loaded from `copy_order.json`, so a table in the first and missing from the second was **emptied and never refilled** while checks 1 to 4 all passed. **`copy_order.json` is deleted.** `run.py` `derive_copy_order()` now builds the order at run time from `plan["tables"]` and SQLite's foreign keys, so the TRUNCATE list and the load list are the same object and **cannot disagree**. A check was deleted along with the thing it checked; nothing became unwatched.
6. ~~**Every `copy_order.json` entry is in `plan["tables"]`**, and **no table is listed twice**.~~ **REMOVED with 5, for the same reason.** A derived order cannot name a table the plan lacks, and `derive_copy_order()` asserts its output is exactly the planned set — same members, same count — rather than relying on that.

**IT DOES NOT CHECK:**

- **Row counts.** Deliberately. `run.py`'s `todo` no longer consults `plan["rows"]` at all, so there is no rows dimension left to guard — the dependency was deleted rather than watched. See ITEM 54.
- ~~**The ORDER inside `copy_order.json`**~~ — **no longer applicable.** The order is derived from SQLite's live foreign keys at run time, so it cannot be stale. `derive_copy_order()` exits 2 on a cycle rather than emitting a partial order.
- **Column TYPES, nullability, defaults or conversion classes.** Only names. A column whose SQLite type changed under a stable name passes this guard.
- **Anything about Postgres.** It reads `plan.json` and live SQLite, and nothing else — which is what lets it run and refuse before the cluster is reachable.

**EXIT CODES ARE PART OF THE CONTRACT.** `0` agree; `1` differ, with every difference named; **`2` the check could not run** — unreadable file, unopenable source, a source reporting zero tables. **Two is not a pass.** A guard that cannot see the source must refuse rather than wave the copy through, which is the same rule as `checks.py`'s exit code and the `fuser` lesson before it.

**RED-PROVEN IN FIVE DIRECTIONS before being trusted**, each restored to green after: a table missing from `copy_order.json` (named `retail_orders`, `rows=1087`), a table in `copy_order.json` and not the plan, a table listed twice, a column hidden from `cols[]`, and the original thirteen.

### THE COPY TOOK ITS SHAPE FROM A CENSUS AND ITS CONTENTS FROM THE SOURCE — CLOSED 2026-08-21

**`plan.json` is a census taken 2026-08-03. `run.py` takes the SHAPE of the copy from it — which tables, which columns, which have rows — and the CONTENTS from live SQLite.** Two epochs in one operation, and every difference between them was invisible.

**WHAT HAD ACCUMULATED IN EIGHTEEN DAYS: two tables and eleven columns that existed in the source and did not exist in Postgres AT ALL.** Not copied as NULL — absent, checked one at a time against `information_schema.columns`.

| Added | Object |
|---|---|
| 2026-08-05 | `retail_customer_addresses.geo_source`, `.geo_precision` |
| 2026-08-06 | `qingyun_push_queue.geo_held_at` |
| 2026-08-17 | `ingredient_cost_skips` (table, 3 rows) |
| 2026-08-19 | `ingredients.free_by_design` |
| 2026-08-20 | `push_optouts` (table, 3 rows) |
| 2026-08-20 | `qingyun_push_queue.needs_point_at`, `.guessed_lat`, `.guessed_lng`, `.guessed_precision`, `.candidates_json` |
| 2026-08-20 | `retail_orders.refund_printed_at` |
| **2026-08-21** | `retail_orders.channel_note` — **the day this was found** |

**THE RATE IS THE FINDING, NOT THE THIRTEEN.** One object every 1.4 days, and `push_optouts` arrived DURING this session — in `626cc802`, the same push that overtook the `[skip deploy]` deferral. A backlog can be patched; a rate has to be guarded.

**WHY NOTHING CAUGHT IT, AND THIS IS THE PART WORTH KEEPING.** `gen.py` builds its SELECT from `cols[]`. **`verify.py` builds its comparison from the SAME `cols[]`.** The verifier is blind in exactly the way the copier is blind, because they read the same list. On 2026-08-21 the round-trip reported **4,220,046 cells compared and 34 differences, all attributed** — and `retail_orders` came back **OK at 120,546 cells** while `refund_printed_at` and `channel_note` were never looked at. **A verifier that shares the copier's map cannot audit the map.**

**THE GUARD, WHICH IS THE DURABLE HALF.** `scripts/postgres-full-copy/drift_guard.py` compares live SQLite's tables and columns against `plan.json` and refuses on any difference. `run.py` calls it as the FIRST statement of `main()` — before the row counts, before the sequence snapshot, before the `TRUNCATE`. **Exit 1 on drift, exit 2 when it cannot see the source at all**, because a guard that cannot read the source must refuse rather than wave the copy through.

**RED-PROVEN BEFORE IT WAS MADE GREEN.** Run against the un-updated `plan.json` it exited 1 and named all thirteen. Run after: `plan.json matches the source — 164 tables, 1,928 columns`, exit 0.

**TYPES WERE CHOSEN FROM THE DATA, NOT FROM THE DECLARED SQLITE TYPE.** `ingredients.free_by_design` is INTEGER holding 0 on 604 rows and 1 on 3, so `boolean`. `guessed_lat`/`guessed_lng` are coordinates, so `double precision`, matching every other lat/lng in the cluster. **And `ingredient_cost_skips.line_price` is a PER-UNIT price whose three live values include `4.55882`** — five decimal places — so `numeric(14,6)` and emphatically not cents, which would round it to 4.56. **Verified after the copy: Postgres holds `4.558820`.** That is §24 v3.0's reversal being applied rather than re-learned.

**PROVEN END TO END, NOT ASSERTED.** DDL dry-run rolled back, then applied (165 tables). `plan.json` gained 2 tables, 11 columns, 1 foreign key, 2 constraints and 1 sequence; `copy_order.json` gained 2 entries, with `ingredient_cost_skips` placed after `ingredients` because it references it — **re-validated against all 145 live foreign-key edges, 0 parents loading after a child.** Then the full copy re-run:

- **131 tables** (was 129), 91.3s, zero load errors, `ingredient_cost_skips` and `push_optouts` both `OK`.
- **All 11 columns match their source non-null counts exactly**, 609/609, 116/116, 2/2 and so on.
- **Round-trip on the five affected tables: 25,394 cells, 0 differences, exit 0** — and `ingredients` now compares 15,225 cells across 25 columns where it compared 24 before. **The new column is inside the verifier's scope, which is the whole point.**
- `setseq.py` handled **140** sequences (was 139); `ingredient_cost_skips_id_seq` at `3, is_called=true`; **0 sequences behind `max(id)`.**
- `preflight.py` unchanged at **29 unmapped and the same 20 data findings**, so nothing else moved.

**GRANTS WERE NOT WRITTEN AND DID NOT NEED TO BE.** `pg_default_acl` grants `tacet_app` INSERT/SELECT/UPDATE/DELETE on any table and USAGE on any sequence created by `postgres` in `public`. Verified against `retail_order_counters`, created the same way on 2026-08-11 with no GRANT in its own DDL. **Confirmed after applying rather than assumed:** both new tables carry the four privileges and the new sequence carries USAGE.

**WHAT THIS DOES NOT CLOSE, STATED PLAINLY.** The guard covers TABLES and COLUMNS. **It does not cover ROW COUNTS**, and `run.py`'s `todo` still filters on `plan["tables"][...]["rows"] > 0` — a 2026-08-03 figure. The two new tables are copied only because their `rows` was set from today's live count by hand. **A table that goes empty and refills between now and the flip is still skipped in silence.** That filter is a separate fix and is open.

**AND THE OTHER SURVEY-DERIVED SHAPES ARE UNTOUCHED:** `copy_order.json` is a fixed list, `overrides.py` asserts hardcoded counts, `volume.py` looks for wide columns only among the census's columns, and `setseq.py`, `checks.py`, `preflight.py` and `final.py` all iterate `plan["tables"]`. **The guard makes the table-and-column class loud. It does not make the class empty.**

> ✅ **THREE OF THOSE FOUR ARE NOW CLOSED — 2026-08-21, LATER THE SAME DAY.** `run.py`'s `todo` no longer reads `plan["rows"]` at all (ITEM 54); `overrides.py` derives its expectation from each rule's own condition instead of a stored count (ITEM 55); `volume.py` reads the live schema. `copy_order.json`'s MEMBERSHIP is now guarded, though its ORDER is not. **The scripts that iterate `plan["tables"]` are unchanged and are now safe BECAUSE the guard proves the plan matches the source** — which is a coupling, not an absence of one: their correctness depends on the guard having run.

### E2 REHEARSED CLEAN — 2026-08-21, THE THIRD RUN AND THE FIRST WITH NOTHING TO EXPLAIN

**Every exit code in the ladder is 0 except the round-trip, and that one is 15 rows of live trading.** From a directory proven byte-identical to the committed tree by md5 on all 25 files.

| Step | Exit | Result |
|---|---|---|
| `volume.py` | **0** | 14 wide columns, now found from the LIVE schema |
| `drift_guard.py` | **0** | 164 tables, 1,928 columns; `copy_order.json` covers all 164 |
| `preflight.py` | **0** | 29 unmapped as expected, same 20 data findings |
| **`run.py` (E2)** | **0** | **164 tables** (was 131), 99s, zero load errors, zero drift, **all three override rules matching** |
| `setseq.py` (E4) | **0** | 140 sequences, 120 from the AUTOINCREMENT high-water |
| setseq's bad condition, asserted | **0** | **0 sequences behind `max(id)`** |
| `checks.py` | **0** | **ALL THREE VERDICTS PASSED** |
| `verify.py` | 1 | **4,231,782 cells, 15 differences, all live trading** |
| `final.py` | **0** | **0 tables where Postgres differs from the count copied against** |

**`run.py` EXITING 0 IS THE HEADLINE.** Every prior run in this session exited 1 on the stale `updated_by_null` constant, **after the truncate and after the copy had completed and written its artefacts** — a run that looked failed and was not. The expectation is now re-derived from the rule's own condition every run, so `updated_by_null: fired 2 times (expected 2) OK`. **An operator will not meet exit 1 on a good copy at 2am and reach for the rollback.**

**`checks.py` PASSING ALL THREE IS THE SECOND.** Verdict 1: **145 of 145** foreign keys validated by Postgres against its own rows (144 before the new table). Verdict 2: **1,582,020 CJK characters on both sides, 0 columns mismatched** — exact, where the 15-day-old copy differed by 207,265 across 82 columns. Verdict 3: all 14 wide columns byte-identical. **The copy is now fast enough that the instruments have nothing to report.**

**`final.py` REPORTS 0 UNCOPIED TABLES**, where on the first rehearsal it reported `('eleme_sync_queue', 1, 0)`. That is ITEM 54 closed, confirmed by the one instrument that could see it.

**THE 15 DIFFERENCES ARE THE SAME SHAPE AS THE 34 BEFORE THEM, AND SMALLER.** Two daemon heartbeats (`qingyun_status`, `store_business_status`), two sync-log row counts (+3 and +8), one customer's `last_used_at`, and three orders whose `tracking_synced_at` advanced. **SQLite ahead of Postgres in every one, never a different value at the same instant.** And `retail_orders` now compares **122,831 cells across 113 columns** where it compared 120,546 across 111 — the two columns that were invisible in the first rehearsal are inside the verifier's scope.

**TIMING: 99s for 164 tables**, against 91.3s for 131. **The 33 empty tables cost about 8 seconds**, which is the whole price of deleting the rows dimension.

**`retail_order_counters` survived untouched**, `('TC', 0, 2026-08-11 18:02:15.007983+08)` before and after, as it has through every rehearsal. 165 cluster tables throughout.

### THE FIRST END-TO-END REHEARSAL OF E2 — RUN 2026-08-21

**Every component of the cutover copy had been verified on its own; the whole path never had.** E2 is a cutover step, and its first execution should not be on the night. This is that first execution, against the renamed cluster, from a directory proven byte-identical to the committed tree by md5 on all 24 files.

**IT WORKS. 129 tables, 475,746 rows, 89.5 seconds, zero load errors, zero source drift between each table's count and its own SELECT.**

| Step | Exit | Result |
|---|---|---|
| `volume.py` | **0** | `wide_cols.json` regenerated, 14 columns |
| `preflight.py` | **0** | 49 findings; unmapped references **29**, matching the baseline exactly |
| `run.py` (E2) | **1** | copy clean; exits 1 on a STALE OVERRIDE CONSTANT, below |
| `setseq.py` (E4) | **0** | 139 sequences, 119 set from the AUTOINCREMENT high-water, 20 left NEVER_CALLED on empty tables |
| setseq's bad condition, asserted directly | **0** | **0 sequences behind `max(id)`**; 119 next-ids above max, 20 empty |
| `verify.py` | **1** | **4,220,046 cells compared, 34 differences, every one attributed to live trading** |
| `checks.py` verdict 1 | pass | **144 of 144 foreign keys validated by Postgres**, 0 failures, 0 NOT VALID |
| `checks.py` verdicts 2, 3 | **1** | see below — these are MEANINGFUL now |
| `final.py` | **0** | runs, and caught something nothing else did |

**VERDICTS 2 AND 3 ARE A DIFFERENT INSTRUMENT AFTER A FRESH COPY, AND THIS IS THE PROOF.** Against the 15-day-old copy they failed on **82 columns and 207,265 CJK characters** — pure staleness, and byte-identical output before and after the rename. Against a copy 20 minutes old:

- **Verdict 3 PASSES OUTRIGHT.** `all wide columns byte-identical: True` — 2,452 values across 14 columns, every SHA-256 matching, the widest 7,165,943 characters.
- **Verdict 2 fails on 5 columns and 112 characters**, all on `retail_orders` and `retail_shipments` tracking fields — **and `verify.py` independently found the same rows.** A JD courier scan at 15:54:35 moved shipment 1197 and order 1228 from `in_transit` to `out_for_delivery`, four minutes after their tables copied.

**THAT CROSS-CONFIRMATION IS THE POINT.** Two instruments, run separately, pointing at the same five columns and the same two rows, with SQLite ahead of Postgres in every case and never a different value at the same instant. **A copy error looks nothing like that** — it shows Postgres holding a value the source never had. All 34 of `verify.py`s differences are forward-moving source data: 5 new `guanyi_sync_log` rows, 6 new `qingyun_sync_log` rows, a new shipment, two daemon heartbeat timestamps, one customer's `last_used_at`, and the courier scan.

**FINDING 1 — `run.py` CHOOSES WHAT TO COPY FROM THE SURVEY, NOT FROM THE SOURCE.** `todo` is built from `plan["tables"][...]["rows"] > 0`, and those counts were taken on 2026-08-03. **A table that was empty at survey time and has gained rows since is skipped in silence.** Measured today: **33 tables carry `plan.rows == 0`, and one of them, `eleme_sync_queue`, now holds a row.** One row, so the blast radius today is one row — but the mechanism does not care which table it is, and on the night it could be any of the 33. **`final.py` is what caught it**, reporting `('eleme_sync_queue', 1, 0)` under *tables where Postgres != the count copied against*. Nothing else in the ladder looks at a table the copy declined to attempt.

**FINDING 2 — `overrides.py`s EXPECTED COUNTS ARE A 2026-08-03 MEASUREMENT AND THEY HAVE MOVED.** `updated_by_null` fired **2** times against `EXPECTED = 4`, and `run.py` aborts on the mismatch. **Attributed: `storefront_config.updated_by` today holds integer `1` on 133 rows, NULL on 16, and the text `claude-golive` on 2.** Two rows that carried a text sentinel at survey time have since been edited by a real user, so only two remain for the rule to null. The rule did exactly the right thing; the constant is stale.

**AND THE DIRECTION MATTERS.** `overrides.py`s own docstring says the guard exists so *"a rule that silently catches MORE rows than expected is caught rather than trusted."* **Firing FEWER is the benign direction** — it means fewer bad values exist. But the assertion is equality, so it aborts either way, **after the `TRUNCATE` and after the copy has completed and written its artefacts.** The copy is not lost; the exit code says otherwise. On the night, that is a run that looks failed and is not.

**TIMING, AGAINST THE ONLY PRIOR MEASUREMENT.** The 2026-08-06 run: 364,666 rows, 75.7s of generate-plus-load. Today: **475,746 rows, 82.7s** — **30.5% more rows for 9.3% more time**, throughput 4,817 → 5,750 rows/s. Wall clock 90s including the truncate and both sequence snapshots. **The ~100-110s extrapolation in the scoping report was too pessimistic**, because it assumed throughput held constant and it improved.

**WHAT THE REHEARSAL DID NOT COVER, STATED SO IT IS NOT READ AS MORE THAN IT IS.** No delta pass (G18, none exists), no completion test (G19, none defined), no freeze (G16), no smoke test (G20), and the counter is not seeded (F2, deliberately last). **This proves the copy path executes end to end against the renamed cluster. It does not make the cutover ready.**

---

### `retail_order_counters` IS THE ONLY COPY OF ITSELF — RISK RECORDED 2026-08-21

**It exists in Postgres and nowhere else.** Not in `data/roots.db`, not in `plan.json`, not in `schema.sql`. It was created directly on the cluster on 2026-08-11 by `docs/tacet-postgres-order-counter.sql`.

**E2 DOES NOT TOUCH IT, AND THAT IS NOT LUCK.** `run.py` truncates the list it builds from `plan.json`, which holds 162 tables; the cluster holds 163. The counter is the one outside. **Verified across the rehearsal: `('TC', 0, 2026-08-11 18:02:15.007983+08)` before and byte-identical after.**

**THE RISK IS A MANUAL TRUNCATE-EVERYTHING.** `TRUNCATE` across `pg_class`, a `psql -c` written by hand on the night, a restore that drops and recreates the schema — any of those destroys the sole copy of the counter state, and **there is no source to re-copy it from.** Rebuilding it means re-running the DDL and then re-deriving `last_no` from the order table, which is F2's job and is not written as a recovery procedure.

**SCOPE, HONESTLY: today it holds `last_no = 0`, deliberately unseeded**, so losing it today costs one `psql -f`. The risk arrives at F2, when the counter is seeded from live orders and becomes the only record of which numbers have been issued.

---

### RULE — A NAME HELD AS DATA IS INVISIBLE TO A SCAN OF CODE — RECORDED 2026-08-21

**Three times in one session, a table name escaped a scan because it was data rather than code.** This belongs beside the rules about scan-derived counts, because it is the same family: an instrument that is correct about its own criterion and silent about what the criterion cannot see.

1. **`CONTROL_PLANE_TABLES` in `lib/tenant-db.js`** — five of the twelve names, as strings in a `Set`. In none of the 248 AST-measured statements, none of the recorded 266, and none of G26's eleven `.exec()` blocks. **It stayed correct only because nothing edited the file.**
2. **The archived `sequences.json`** — `final.py` keys its `PRE` dict on a sequence name, and the snapshot on disk still carried `accounts_id_seq`. The stale key resolved to `None` and printed blank rather than mismatched, **which reads like a pass**.
3. **`copy_order.json`** — 162 table names in dependency order, twelve of them stale. **`run.py` dies at `sq_of[t]` with a `KeyError` before its first `psql` call**, so it failed closed, but E2 could not be rehearsed until it was fixed. **A sweep of `.py` and `.sh` found `run.py` and `drift.sh` and could never have found this.**

**THE MIGRATION DIRECTORY IS MOSTLY DATA, WHICH IS WHY IT KEEPS HAPPENING HERE.** Of 24 committed files under `scripts/postgres-full-copy/`, the two that carry the schema's names in bulk are `plan.json` and `copy_order.json`, and `plan.json` is 478 KB against about 90 KB of Python.

**THE RULE: when a name changes, enumerate the committed DATA files as a first-class population, not as an afterthought to the code sweep.** Done properly here: **99 committed data files repo-wide, 11 hold any of the 28 names**, and the enumeration was taken from `git ls-files` rather than from a search, so the space is closed rather than sampled.

**AND STATE BOTH COUNTS.** A `tenant*` literal in a data file is the same defect as an `account*` one — it is only invisible because it happens to be correct today. `plan.json` still carries **94 `account*` occurrences** in its `fkeys`, `cons`, `sequences` and `pg_rowcounts` blocks, which is deliberate and is what `preflight.py`s 29-reference baseline measures.

### `[skip deploy]` DEFERS A RUN, NOT A FILE — RECORDED 2026-08-21

**Found by having a deferral overtaken seventeen minutes after it was taken.** No fix is proposed; the behaviour is deliberate and the alternative is worse.

**WHAT THE TOKEN ACTUALLY DOES.** `deploy.yml`s first step reads `git log -1 --pretty=%s` and, on a match, sets `skip=true`, which gates every later step. **That is the whole of it: the RUN does nothing.** The token does not mark the commit, does not record the files, and leaves no state anywhere.

**WHY THE FILES COME BACK ON SOMEBODY ELSE'S PUSH.** The diff base is not `main`s previous head. It is read from the server:

```
REC=$(ssh prod "cat /root/roots-v2/.deploy-state/last-success-sha")
git diff --name-only "$REC" "$GITHUB_SHA"
```

**The base is what production ACTUALLY HOLDS.** A skipped run ships nothing, so it never updates `last-success-sha`, so the skipped commit's files are still in the diff on the next push — **by anyone, on any commit, for any reason.** The next deploy carries them out.

**AND THAT IS THE CORRECT BEHAVIOUR, WHICH IS WHY THIS IS A RECORD AND NOT A DEFECT.** The server-record base is the Stage 2 fix, built after replaying 904 runs found **197 stranding episodes across 141 files, 79 never healed by any later commit, the longest running 43 days** — every one caused by a base that was too new, so a failed run's files were skipped permanently while later deploys reported SUCCESS. **The comment in the workflow states the principle outright: every rung errs toward shipping MORE, because a base that is too old over-ships, which is slow but correct, and a base that is too new skips silently, which is the bug.** A token that could hold a file back indefinitely would re-create exactly the failure that fix exists to prevent.

**SO THE TOKEN IS A ONE-PUSH REPRIEVE AND MUST BE PLANNED AS ONE.** Two consequences, both of which bit here:

- **The deferral lasts until the next push by anybody**, and on a repository where the post-commit hook pushes automatically, that can be minutes. **Measured here: seventeen.**
- **Whatever is deferred must be internally complete**, because the deploy that eventually carries it will not be the one that was reasoned about. Six files went out together and were consistent. **Had the same work been split across two commits with the token on one, the deploy would have shipped half.**

**THE OPERATIONAL RULE, STATED PLAINLY: `[skip deploy]` IS NOT A SCHEDULING TOOL.** It buys one push, and the next push by anyone spends it. **There are exactly two real options and the token is neither of them:**

1. **Deploy deliberately** — omit the token, watch the run, accept the restart at a moment you chose.
2. **Do not commit yet** — keep the work off `main` until it should ship.

**Assuming the token holds is the failure.** It held for seventeen minutes here, and it was only harmless because the commit was internally complete.

**RELATED:** §24 A `scripts/` FILE THE APPLICATION NEVER LOADS STILL RESTARTS IT — the reason a deferral was wanted in the first place.

### A `scripts/` FILE THE APPLICATION NEVER LOADS STILL RESTARTS IT — RECORDED 2026-08-21

**Recorded, not chased.** No fix is proposed here and none should be improvised on the night.

`.github/workflows/deploy.yml` decides what ships with one `deployable()` case statement, and its allowlist is a PATH PREFIX list:

```
public/* | routes/* | lib/* | middleware/* | scripts/*
server.js | database.js | schema.sql | package.json | package-lock.json
```

**`scripts/*` is on it, and `scripts/` holds roughly 80 files the running application never requires.** When any of them changes, `scripts/deploy-apply.sh` ships it and then runs `pm2 restart roots-v2 --update-env` — **a full reload of the Node backend, for a file the process does not read.**

**MEASURED ON THIS WORK.** The `plan.json` + five-script commit of 2026-08-21 touches six files under `scripts/postgres-full-copy/`. **The application requires none of them** — they are standalone Python run by hand over ssh. Shipping them normally would bounce the entire backend anyway. That commit carries `[skip deploy]`, so it did not, and this entry exists because the next one will not think to.

**WHY THIS IS NOT COSMETIC.** A restart is not free and is not silent:

- **It is the riskiest routine action the deploy takes.** `deploy-apply.sh` wraps it in a syntax gate, a backup, a health probe and auto-rollback precisely because a restart can fail to come back. Spending that risk on a file the process never opens is spending it for nothing.
- **It drops every in-flight request and every open connection**, including a checkout mid-transaction. The health probe proves the process returned; it cannot prove nothing was interrupted.
- **The channel daemons are NOT restarted with it** — `bounce_daemon` fires only for the six named daemon scripts. So a `scripts/` edit produces a partial reload: backend new, daemons old. Harmless when the file is inert, and exactly the split that makes a real defect hard to reproduce.
- **It teaches `[skip deploy]` as a habit.** The token is the only way to edit a migration script without bouncing production, so the safe path and the marked-as-exceptional path are the same path. **A token used routinely stops being read as a signal**, and the one time it is omitted by accident is the time it mattered.

**WHAT THE FIX IS NOT.** Removing `scripts/*` from the allowlist would stop shipping the ~20 files under `scripts/` that production genuinely runs — the six channel daemons among them — and `bounce_daemon` would then restart daemons whose code never arrived. **The allowlist is a path prefix and the directory is not sorted by whether the app loads it.** Any real fix has to separate those two populations first, and that is the work, not the one-line edit it looks like.

**RELATED, AND THE SAME ROOT.** G13 owes an audit of the ~80 `scripts/` files that assume a SQLite path. **That audit would produce exactly the split this entry needs** — which of them production runs, and which are hand tools. One survey answers both.

### 🔴 THE POSTGRES MIGRATION IS CANCELLED. TACET STAYS ON SQLITE — DECIDED 2026-08-23

**This supersedes `Database: PostgreSQL, one shared database, row-level account isolation — DECIDED 2026-08-03` and every entry in §24 that assumes the flip will happen. Those entries are left standing.** They are the account of how the distance was measured, and the measurement is the reason for this decision. Nothing below is a correction of them; the work was not wrong, it was disproportionate.

**Ash's call, taken 2026-08-23, after the `.prepare` survey.**

---

#### a) WHAT WAS MEASURED

**2,835 `.prepare` call sites in the runtime.** By file and directory, at the survey head:

| Where | `.prepare(` sites |
|---|---|
| `server.js` | 12 |
| `database.js` | 228 |
| `routes/` | 2,414 |
| `lib/` | 175 |
| `middleware/` | 6 |
| **total** | **2,835** |

**Zero `.query` call sites.** The only three occurrences in the tree are `lib/pg-handle.js`'s own two forwarders and one line inside `lib/db-transaction.js`'s `control()`. **No application code calls `.query`.** Every statement the application issues, it issues through `.prepare`.

**All 39 files in `routes/` are affected.** Not most of them — `routes/` holds exactly 39 `.js` files and every one of them calls `.prepare`. There is no subset of the route layer that could have moved first.

> **RE-MEASURED AT THIS HEAD AND THE TWO FIGURES THAT MOVED ARE RECORDED RATHER THAN TIDIED, per rule 5.** `routes/` reads **2,423** here and `lib/` reads **177**, for a total of **2,846** — eleven more than the survey, from ordinary work that shipped between the two heads. **The instrument is a text scan** — occurrences of `.prepare(` counted per occurrence rather than per line — **not an AST pass**, so it is subject to the same class of error this record has now written down seven times, and it is quoted as a magnitude and not as a precise population. **The decision does not turn on the eleven.** Both readings give the same order of magnitude, and the order of magnitude is the argument.

**THE HANDLE IS FROZEN AND REFUSES ADAPTERS BY DESIGN, AND THE REASON IS `lib/pg-handle.js`'s OWN.** Quoted from its header rather than paraphrased, because the paraphrase is what loses the point:

> *"Give those 3,339 sites a `.prepare()` that returns something with `.get/.all/.run`, and each one receives a PROMISE where it expects a row. JavaScript does not throw on that. `.name` on a Promise is `undefined`. `.changes` is `undefined`. `lastInsertRowid` is `undefined`. The application does not crash — it quietly computes wrong answers, across every route at once, and the first evidence is a customer."*

`FORBIDDEN_NAMES` in that file lists `prepare` second, after `exec`, and the suite asserts each name's absence individually. **The refusal is deliberate and it is right.** It converts a silent wrong answer into a loud `TypeError` carrying a stack trace to the exact line. **But the refusal is also the measurement.** The reason an adapter is forbidden is the reason there is no shortcut, and 2,835 is what the absence of a shortcut costs.

---

#### b) THE 27 "CONVERTED" SITES WERE NOT CONVERTED

**The wrapper changed. The statements inside it did not.**

Conversion replaced `<handle>.transaction(fn)` with `await withTransaction(<handle>, (tx) => …)`. That moved the transaction boundary onto a driver-neutral helper. It was real work, it found a real concurrency defect before the checkout was converted, and it is not being disparaged here. **What it did not do is change a single statement inside the body.**

Measured at this head: `routes/retail.js` holds **28 `withTransaction(` call sites and 70 `tx.prepare(` call sites**. Every converted body opens by calling `.prepare` on the handle the helper hands it. The first line inside the block at `routes/retail.js`'s fapiao-settings writer is `const upsert = tx.prepare(`, and that shape is the rule, not an exception.

**On Postgres, `tx` is a leased `pg` client wrapped by `lib/pg-handle.js`, and `prepare` is on its forbidden list.** So the first statement of a converted block evaluates `tx.prepare` to `undefined` and throws `TypeError: tx.prepare is not a function`.

**A converted block therefore fails on its first statement exactly like an unconverted one.** The conversion count measured a boundary being moved. It was read as distance travelled toward a working Postgres application, and it is not that. **The number was never wrong; the reading was.** The four batch entries above stand as written.

---

#### c) THE RUNBOOK'S ACCOUNT OF THE DISTANCE WAS WRONG — B19 SUPERSEDED IN PLACE

**`docs/tacet-postgres-cutover-runbook.md` B19 (GAP G26) says:**

> *"clearing it is what turns 'the app cannot start' into 'the app starts and individual routes fail', which is the only state in which G1 can be worked incrementally at all."*

**That sentence is false twice, and the second half is the load-bearing one.**

**First: it does not start.** Clearing the eleven module-load `.exec()` blocks removes the eleven. `database.js` alone holds **228** `.prepare` sites and is required at boot. The eleven were the first obstacle found in front of the listener, not the last one. **B19 measured the obstacle it had found and then described it as the obstacle.**

**Second, and this is what matters: "individual routes fail" is not what happens. Every route fails, on its first line.** There is no gradient to work along. A route's first database access is a `.prepare` call, `.prepare` does not exist on the handle, and all 39 files in `routes/` do this. **"Individual routes fail" describes a state in which some routes work.** That state does not exist and cannot be reached incrementally, because the unit that would have to be converted one at a time is the statement, and there are 2,835 of them.

**B19 is marked superseded in place. It is not struck out and not removed.** Its file-and-line table is correct, its skip-on-pg reasoning is sound, its foreign-key ordering finding stands on its own, and its count-correction note — 24 tables and 15 indexes, not 19 and 10, because an extractor that could not find a block's end read 400 characters instead of failing — is a finding that outlives this decision entirely.

**AND THE FAILURE IS THE ONE THIS RECORD KEEPS NAMING.** B19 measured one obstacle honestly and then wrote a sentence about the distance behind it that no measurement supported. **A survey of the nearest blocker cannot see the population behind it, and "what clearing this turns into" is a claim about that population.** Same family as *a scan for one shape only finds that shape*, and same family as *a check that cannot run must refuse*. **It is the eighth scan-derived claim in this project to be wrong, and the first where the error was in the sentence around the number rather than in the number.**

---

#### d) WHY IT STOPPED

**Postgres was for two things: hosting, and multi-tenancy.**

**Multi-tenancy already works.** Measured on the production box 2026-08-23:

- `TENANT_DATA_ISOLATION=1` in `/root/roots-v2/.env` — on in production, as §24 *`TENANT_DATA_ISOLATION` IS ON IN PRODUCTION — RECORD CORRECTED 2026-08-08* established.
- Five per-tenant databases in `/root/roots-v2/data/tenants/` — `2.db`, `4.db`, `5.db`, `6.db`, `7.db`, each about 1.6 MB. **There is no `3.db`. The set is not a contiguous range and should not be written down as "2–7".**
- Roots is served from `/root/roots-v2/data/roots.db`, **711 MB**, written the same day.
- ⚠️ **A zero-byte `data/tenants/roots.db` also exists and is not the Roots database.** Zero bytes since 2026-07-05. Do not mistake it for one.

> **ONE QUALIFICATION, recorded because it cuts against the case rather than for it.** No per-tenant file has been written since **2026-08-05**. So "multi-tenancy works" is proven as a mechanism and not under load. **That does not weaken the decision — it is the decision.** File-per-tenant is not being asked to do very much yet, which is exactly why replacing it now would have been paying for a constraint nobody is hitting.

**No measured constraint was being hit.** Not connections, not write concurrency, not database size, not tenant count. **The migration was never triggered by a symptom.** It was chosen as the right destination and then pursued for its own sake, and three weeks of measurement never produced a number showing the current shape failing at anything.

**The cost was not proportionate.** Against zero measured pressure: 2,835 statements to rewrite, twenty open gaps, no smoke test, no write freeze, no delta pass, an unproven fresh-cluster restore, and a rollback window in which every alert in the system — including the health watchdog's own page — is silenced by step F1. **The work was good. The trade was not.**

---

#### e) WHAT WOULD HAVE TO BECOME TRUE TO RESTART

**Stated as conditions and deliberately not as a plan, so this is not relitigated from scratch and not restarted on enthusiasm.** Any ONE of these reopens the question. **None of them is true today.**

1. **A named tenant at a scale file-per-tenant cannot serve.** Not "tenants are growing" — a specific tenant, with a specific number, where the measured failure is a property of one-database-per-tenant rather than of a query that could be fixed. Cross-tenant reporting that has to open N files to answer one question; a working set larger than the box's page cache; a write concurrency that SQLite's single-writer lock actually refuses.
2. **A hosting requirement SQLite cannot meet.** A move to managed infrastructure, a read-replica requirement, a point-in-time-recovery obligation, or a compliance rule naming a database that does not live on one machine's filesystem.
3. **A tenant commitment already made.** A signed customer whose contract requires row-level isolation, an audited shared database, or an availability figure a single-box SQLite file cannot honestly be argued to meet.

**And one condition on HOW rather than whether:** if any of the three becomes true, the restart does not resume from where this stopped. **It starts from (f).**

---

#### f) THE ONE PATH THAT WOULD HAVE WORKED — RECORDED, NOT RECOMMENDED

**A record of the option and of why it was not taken, written down so it is not rediscovered as a new idea.**

**Give the SQLite handle a `.query(text, params)` returning `{rows, rowCount}` synchronously.** Then:

1. **Convert call sites a file at a time, on SQLite, under real traffic.** Each converted statement runs against the database already serving customers, so production proves every conversion before the next one starts.
2. **The driver switch becomes a configuration change at the end** — `TACET_DB`, which already exists in `lib/db-driver.js`, selecting between two handles that share one call signature.

**WHY IT WOULD HAVE WORKED WHERE THE ACTUAL PATH DID NOT.** The actual path made the two drivers *deliberately incompatible*, then required every call site to move before any of it could run. **That ordering has no partial state.** Nothing works until nearly everything is converted, so there is no point along the way at which production tells you whether the conversion is correct — which is why, twenty days in, one statement had executed against Postgres and the number was a milestone. The `.query` path inverts it: the compatible shape comes first, conversion is incremental and continuously verified by live traffic, and the flip is the last and smallest step instead of the first and largest.

**WHY IT WAS NOT TAKEN, STATED FAIRLY. It was not rejected; it was not considered.** `lib/pg-handle.js`'s no-shared-names decision was the right answer to the question being asked — *how do we stop an adapter computing wrong answers?* — and it settled the shape before anyone asked the different question, *what shape lets this be done incrementally?* Those two questions have different answers and only the first was put.

**AND THE ASYMMETRY IS THE PART WORTH REMEMBERING.** A synchronous `.query` on better-sqlite3 is trivially implementable: better-sqlite3 *is* synchronous, so `{rows, rowCount}` is a thin wrapper over `.all()`/`.run()` and nothing has to become a Promise. **The hard direction was never SQLite-to-`.query`. It was Postgres-to-`.prepare`, which is impossible — and the design took the impossible direction as the given and built everything else around it.**

**⚠️ THIS IS NOT A RECOMMENDATION TO DO IT NOW.** Doing it now means rewriting 2,835 statements against a constraint nobody is hitting, which is the trade section (d) declines. **It is the answer to a question a future reader will otherwise ask from the beginning.**

---

#### WHAT THIS DECISION DOES NOT CANCEL

**Most of the last three weeks was not Postgres work and does not retire with the migration.** The findings themselves are in `docs/tacet-operating-findings.md`; **the artefact-by-artefact sort — KEEP, RETIRE, DECIDE — was reported to Ash on 2026-08-23 and no artefact is deleted pending that decision.** What survives, in summary: the schema drift guard, the safe-copy tool, the three observation instruments and their cannot-see fixes, the health watchdog's widened probe, the crontab sweep, the rollback tool, the `.env` loader, and every live defect the migration found in code that has nothing to do with which database it runs on. **The migration's most valuable output was never the migration.**

**AND THE WRITE-SURFACE SURVEY IS THE MOST REUSABLE THING IT PRODUCED.** It describes the SQLite system as it stands today — eight processes, twelve in-process schedulers, the read-triggered writes, the callback classification — and it is worth more now than it was for the flip. It lives in `docs/tacet-write-surface.md`, outside the retired runbook. **It is re-derived at this head rather than transcribed; that file's own opening note says why, and the reason is itself a finding.**


---

#### ⚠️ ADDENDUM, SAME DAY — SCRAPPED OUTRIGHT RATHER THAN RETIRED. THIS SUPERSEDES THE TWO PARAGRAPHS ABOVE THAT SAY "RETIRED, NOT DELETED"

**Ash's decision, 2026-08-23, after the KEEP / RETIRE / DECIDE report: delete everything, including the rollback tools, and drop the cluster.** The entry above was written against the earlier lean — *header in place, nothing deleted* — and **that lean is superseded rather than edited out**, because the reasoning for it was sound and the reversal was a judgement call rather than a correction.

**WHAT WENT — 52 files.** `scripts/postgres-full-copy/` and `scripts/postgres-migration/` entire, `scripts/postgres-money-scale/` entire, `eval/pg-probe/`, `lib/pg.js`, `lib/pg-handle.js`, `lib/db-driver.js`, the rollback tools (`rollback-to-sqlite.sh`, `rollback-delta-report.js` and their suite), the pg test and diagnostic scripts, the AST conversion-count authority, **the cutover runbook, the status document, and all nine `docs/tacet-postgres-*.sql` schema records.**

**AND `drift_guard.py` WENT WITH THEM, WHICH IS THE ONE LOSS WORTH NAMING.** It was in the KEEP list; it is inseparable from `plan.json`, and `plan.json` was scrapped. **So nothing now detects SQLite schema drift.** The last measurement said **13 objects drifted in 18 days.** That capability is gone and its absence is a standing gap, not an oversight.

**FOUR EDITS WERE NEEDED TO KEEP LIVE CODE HONEST**, and each REFUSES rather than falling back:

- **`database.js`** — the `TACET_DB` early-return branch is removed with the three modules it called. **A comment stands where it was**, recording that this file is still the construction point if a second driver is ever wanted, and pointing at (f).
- **`scripts/check_ledger_invariants.js` and `scripts/check_points_invariants.js`** — `openPg()` and the `--pg` path deleted. **`--pg` now exits 2 with a message rather than silently checking SQLite instead.** A money check that quietly answers a different question than the one asked is the exact failure this project has spent three weeks dismantling.
- **`scripts/check_sync_freshness.js`** — the Postgres reader deleted; SQLite is the only source. `--sqlite` is accepted and ignored so existing callers do not break.
- **`scripts/diagnose_deployed_tree.js`** — **44 manifest entries removed by hand.** Leaving them would have the detector report 44 files MISSING forever, and *a permanently red check stops being read* is this project's own rule. **`MANIFEST_COMMIT` is now stale and says so in a comment rather than lying**; all three generated values are owed a regeneration once this lands on `origin/main`.

**WHAT WAS DELIBERATELY NOT DELETED, AND WHY.** `lib/db-seam.js` and `lib/db-transaction.js` are **live SQLite code** — the seam is required by roughly 35 runtime files and `tdb()` returns `seam(...)`; `withTransaction` has 28 live call sites in `routes/retail.js` running on better-sqlite3 today. **Deleting either stops the shop.** Their test suites are kept for the same reason: **removing tests from live code is not removing a trace of the migration, it is removing safety.** `lib/load-env.js` and `scripts/make_safe_db_copy.sh` are kept — both were built during this work and neither is about Postgres.

**THE CLUSTER IS DROPPED.** See the operations note below.

**AND ONE THING THE WORD "IRREVERSIBLE" OVERSTATED, MEASURED BEFORE ANYTHING WAS TOUCHED.** The off-site daily backups hold `tacet.dump` (454 MB) and `roles.sql` for **2026-08-21, 08-22 and 08-23**, under a 30-day retention. **So the cluster is restorable from OSS until roughly 2026-09-22 and not after.** No new dumps are being taken. **Every deleted file is recoverable from git history at `e22964bb` indefinitely.**


#### OPERATIONS NOTE — THE CLUSTER WAS DROPPED, IN THIS ORDER, 2026-08-23

**The order is the whole content of this note.** Doing it in any other order breaks the SQLite backups.

**1. `PG_DB=` EMPTIED FIRST, IN `scripts/db-backup.sh` AND ON THE BOX.** `db-backup.sh` preflights `sudo -u postgres psql -Atc "SELECT 1" -d "$PG_DB"` and calls `fail` if it cannot reach it — **and `fail` aborts the WHOLE run, the SQLite and per-tenant tiers included.** So stopping the cluster with `PG_DB=tacet` still set would have silently ended the nightly backup of `roots.db`. The script has the off switch by design and its own comment says so. **The box copy was edited by hand and kept at `scripts/db-backup.sh.pre-pgdrop-20260823`; the repository and the box converge on the next deploy.**

**2. PROVEN BY RUNNING IT, NOT BY READING IT.** A full backup was run with `PG_DB=` empty before anything was stopped. **It uploaded six objects — `roots.db.gz` and the five per-tenant databases — and no `tacet.dump` and no `roles.sql`** (`oss://tacet/daily/20260824-002504/`). ⚠️ **The exit code was NOT captured** — the ssh session was killed by its own timeout while the job continued on the box — **so this is verified by what landed in the bucket and not by an exit status.** The 03:30 cron run writes its verdict to `/var/log/tacet-db-backup.log` and is the confirming observation.

**3. STOPPED, DISABLED, PURGED.** `systemctl stop postgresql`, `systemctl disable postgresql` (`inactive`, `disabled`), then `rm -rf /var/lib/postgresql`. **Disk: 8.1 GB free / 79% → 9.9 GB free / 74%.** The `tacet` database was 716 MB of a 1.8 GB cluster.

**4. THE PACKAGES ARE STILL INSTALLED AND THE UNIT IS ONLY DISABLED, NOT MASKED.** `pg_dump`, `psql` and the server binaries remain, so an apt upgrade could try to start a service whose data directory no longer exists. **Disabled prevents auto-start; masking would be stronger.** Left as a decision rather than taken silently.

**RECOVERABILITY, STATED PRECISELY BECAUSE "IRREVERSIBLE" WAS AN OVERSTATEMENT.** The off-site daily backups hold `tacet.dump` (454 MB) plus `roles.sql` for **2026-08-21, 08-22 and 08-23**, under 30-day retention. **The cluster is restorable until roughly 2026-09-22 and not after.** No new dumps are being taken. `roles.sql` matters more than its 795 bytes suggest: `pg_dump` is per-database and does not carry roles, and the dump names `tacet_app` in 304 GRANT statements.

**ONE ORDERING CONSTRAINT IS STILL OPEN ON THE BOX.** `lib/db-driver.js`, `lib/pg.js` and `lib/pg-handle.js` are **deleted from the repository but deliberately still present on the box.** The box's `database.js` is the pre-cancellation file and **requires `./lib/db-driver` unconditionally at line 37** — outside the `if (IS_POSTGRES)` guard. **Deleting it before the new `database.js` deploys throws `MODULE_NOT_FOUND` in a file ~94 others require, including all six channel daemons, and the health watchdog would restart the application into the same failure every two minutes.** Remove the three only after the deploy lands. Everything else the migration left on the box is gone; a copy of all of it is at `/root/backups/pg-migration-boxcopy-20260823.tgz`.


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

## 28. Production module — naming and build route

**Decision.** Production is a MODULE within Tacet, not a separate app. Tenants who enable it gain screens; tenants who do not see nothing. There is no separate Production application and none will be built.

**Materials is the tenant-facing name** for stocked things a tenant buys and holds but does not sell. It covers food, packaging, equipment and supplies without favouring any trade. "Items" is rejected — it collides with Products in conversation. "Ingredients" is rejected as tenant-facing vocabulary — it excludes every non-food business, in violation of §0.

**Build route: generalise the existing kitchen machinery. Do not rebuild on retail rails.** The kitchen half already has the two hardest pieces — unit conversion (lib/ingredient-cost.js, already the repo's unit authority, not merely its cost authority) and purchase-cost write-back. Retail purchasing has neither, and its receive path silently skips any line without a store_product_id. Rebuilding on retail would mean writing both from scratch and discarding a working implementation.

**Schema names are NOT renamed at this time.** `ingredients`, `ingredient_id`, `buy_unit` and related identifiers stay as they are. Rationale: 453 references across 41 files, ~2,900 lines of route code, against a word no tenant ever reads. The rename is deferred, not cancelled, and must be its own change with a backup taken immediately before — never folded into feature work.

**What DOES get renamed is anything a tenant can see:** rail labels, page titles, headings, form labels, and stored strings that surface in reports.

**Supporting evidence.** Only 61% of the `ingredients` table is food (live: 383 food, 145 packaging, 52 retail, 49 equipment, 1 other). The table was already broadened by the `item_kind` column, added with the stated intent of covering everything the buying department orders. It is already a materials table wearing a kitchen name.

**Phase 1 scope: Materials and Purchases only. Recipes are deferred.** Without recipes nothing is made from anything, so nothing consumes anything — which means phase 1 requires no change to Products and no change to the storefront.

**Open, not decided here:** the Chinese label for Materials; paid entitlement wiring; whether purchased quantity converts to stocked quantity.

### §28 addendum — Materials Phase 1 build decisions

Three decisions made after §28 was written, correcting the first build plan:

1. **Materials gets a tenant-level on/off switch**, not role-based gating alone. Same mechanism as Quick Stock / Add Stock (`FEATURE_CATALOG`, `mountFeatureControls`, `setFeatureEnabled`) — an operator preference today, with a real entitlement ceiling wired in whenever billing lands. Role-based capability (`materials:view`/`materials:edit`) still governs who *within* an enabled tenant can use it — the two are independent axes, both needed.
2. **Purchase-line creation for materials is not indefinitely deferred.** It must ship before Roots is migrated off the kitchen app — Roots' only current path to purchase materials is through kitchen POs, and losing that with no replacement breaks live purchasing. It does not need to land in the same commit as Materials records; it is the required next piece of work, sequenced immediately after. **Roots must not be cut over from the kitchen app until this is live and verified.**
3. **The Materials record opens as a full page**, confirmed as a deliberate choice despite Materials and Purchasing being described as siblings elsewhere in this plan, and despite Purchasing itself using the hybrid drawer-plus-Expand pattern (§1.13). This was weighed and decided anyway — do not "correct" it back to a drawer or hybrid in a future session on the grounds of matching Purchasing.

## 29. Related documents

- docs/tacet-glossary.md — binding definitions, v1.4, 2026-07-31. The words in this document are used with the meanings defined there.
- docs/tacet-desktop-patterns.md — the rulebook for how a desktop admin page is put together, v4.2, 2026-08-03. Prescriptive except on Orders: when a rule and an unbuilt page disagree, that document wins.
- docs/tacet-core-survey.md — verified current-state inventory, 2026-07-30
- docs/tacet-product-fields.md — product field inventory, 2026-07-31. 78 columns; 41 contested writes.
- docs/tacet-stock-model.md — stock and reservation behaviour, 2026-07-30. Records 14 inconsistencies in the store stock model; three were live bugs.
- docs/tacet-locations-survey.md — locations current state, 2026-07-30. Records that `markets` and `retail_stores` are two complete competing models, and that `retail_stores` already holds everything operationally real.
- docs/tacet-order-routing.md — how a fulfilment location is chosen, and what happens on stock shortage, 2026-07-31. Read-only behavioural survey.
- docs/tacet-multibusiness-audit.md — audit against §0, 2026-07-31. 121 findings, 26 blockers. Headline: Roots is the default database, not a row in it.
- docs/tacet-money-cluster-design.md — what must stay true when a money helper is converted to async, v1.0, 2026-08-19. Grouped by mechanism, not by helper. Scope is the 19 ledger writers; the checkout, the poll vote and the four adjust/admin routes cite it rather than living in it. Carries one recommendation (two constraints, approved, not scheduled) and no conversion order by design.
- docs/tacet-money-model-survey.md — the money-unit gap between the application and Postgres, 2026-08-04. Read-only survey behind the boundary-layer decision in §24. 92 columns changed unit, plus nine to numeric(14,6); records the read and write sites, the SQL-side arithmetic a JavaScript boundary cannot reach, the mixed-engine transition hazard, and the second money model in storefront_config that the boundary layer structurally cannot reach.
- ~~docs/tacet-postgres-status.md~~ — **DELETED 2026-08-23** with the migration (§24 THE POSTGRES MIGRATION IS CANCELLED). Recoverable from git history; the two things in it worth keeping were moved out first.
- docs/tacet-write-surface.md — **what writes to this database**, v1.0, 2026-08-23. Eight processes, twelve in-process schedulers of which eleven run, the read-triggered writes, the inbound callbacks classified by what they tell the caller when the write fails. **Read before anything that takes the database away.**
- docs/tacet-operating-findings.md — **the findings that outlived the Postgres migration**, v1.0, 2026-08-23. Five instruments that lied, ten refusal rules, the live defects, the operational facts about this box.
