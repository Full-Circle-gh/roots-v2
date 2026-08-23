# Findings that outlive the Postgres migration, v1.0

**2026-08-23 · Everything found during the Postgres work that is not about Postgres.** The migration is cancelled (`docs/tacet-consolidation-decisions.md` §24 *THE POSTGRES MIGRATION IS CANCELLED. TACET STAYS ON SQLITE*) and its runbook is retired. **None of what follows retires with it.** It is about instruments, about live defects in code that has nothing to do with which database it runs on, and about how this box actually behaves.

**Companion file:** `docs/tacet-write-surface.md` — what writes to this database, from where, on what schedule.

---

# PART 1 — THE FIVE INSTRUMENTS THAT LIED

**Every one of these was trusted to answer a question and answered a different one.** They are grouped because the shape repeats: **an instrument that cannot see something reports its blindness as good news.**

## 1.1 `PRAGMA data_version` — a fresh connection cannot see any change at all

**What it was trusted for:** telling whether the database is being written to, by reading a counter that moves when a write commits.

**MEASURED ON THE LIVE DATABASE, 2026-08-23 23:58 box time.** Two read-only handles, eight seconds apart, against a database taking continuous production writes:

| Read | Value |
|---|---|
| handle A, opened at t0 | **2** |
| handle A, re-read at t+8s | **3** — it moved |
| **handle B, freshly opened at t+8s** | **2** |

**The freshly opened handle reads the value the database had eight seconds and at least one commit ago.** `data_version` is documented as changing for commits made by *other* connections, and its baseline is set when the connection is opened. **So it is a delta on one held-open handle and nothing at all on a new one.**

**THE FAILURE MODE IS THE OBVIOUS PROBE.** Open, read, close; wait; open, read, close; compare. **That probe returns "unchanged" on a database that is being hammered**, and unchanged reads as *nothing is writing*, which is the answer that lets you proceed. **A monitor that opens a fresh connection each tick cannot use this pragma, and it fails in the reassuring direction.**

## 1.2 `roots.db`'s mtime — the file does not get touched when the database is written

**What it was trusted for:** *when did this database last take a write?* — the question R4 in `scripts/rollback-to-sqlite.sh` asks, and the question anyone asks of a file.

**MEASURED ON THE LIVE DATABASE, same moment:**

| File | mtime | Size |
|---|---|---|
| `roots.db` | 23:51:51 | 711,053,312 |
| `roots.db-wal` | **23:58:39** | 11,272,352 |
| `roots.db-shm` | 23:58:35 | 32,768 |
| *wall clock* | *23:58:40* | |

**The database took a write one second ago and the database file's mtime is six minutes and forty-nine seconds old.** Under WAL, commits land in `-wal`; the main file is only touched at checkpoint. **A checkpoint interval is not a write interval, and `roots.db`'s mtime measures the former.**

**WHERE THIS BITES, AND IT IS NOT HYPOTHETICAL.** R4 in the rollback tool refuses if `roots.db.pre-cutover`'s mtime is later than the flip. **Its reasoning is sound and it names the right hazard** — an open better-sqlite3 handle keeps writing to the same inode after a rename — **but the signal it reads can lag the write it is looking for by minutes**, and it lags in the direction of passing. **The check is worth keeping and its window is wider than it looks.** Reading `-wal`'s mtime as well would narrow it.

**AND THE SAME TRAP IN THE OTHER DIRECTION:** a hot copy of `roots.db` alone, taken while the app runs, silently omits everything in the 11 MB WAL. `/root/scripts/roots-backup.sh` knows this — it prefers `sqlite3 .backup` and copies `-wal` and `-shm` alongside when it has to fall back to `cp`.

## 1.3 WAL size — it is a checkpoint artefact, not a volume of work

**What it was trusted for:** a proxy for how much has been written since some earlier moment.

**It is not one.** The WAL grows as commits land and is reset at checkpoint, so its size at any instant is *"work since the last checkpoint"*, not *"work since you last looked"*. **Two readings can be equal across a busy hour, and a reading can fall to near zero at the exact moment the most work has just been committed** — a checkpoint is the successful completion of writing, and it makes the number go down.

**Measured here:** 11.27 MB on a database under normal evening load. **That figure supports no comparison against any other moment**, and it is written down only so that nobody quotes it as a baseline.

## 1.4 `checks.py`'s missing exit — it printed its failures and returned 0

**What it was trusted for:** the fidelity check. Foreign keys resolve, Chinese text survived with matching character counts, wide base64 columns arrived at full length by SHA-256.

**It printed every failure it found and then exited 0.** Nothing downstream could tell a pass from a failure, and the whole point of the script was to be the thing downstream trusted.

**FIXED, and the fix is in the file to be copied rather than admired:** `scripts/postgres-full-copy/checks.py` collects into a `failures` list and ends `sys.exit(1 if failures else 0)`, with the reason written above it — *"Before this existed a failed check printed its failure and still returned 0."*

**THE GENERAL FORM: A CHECK THAT CANNOT REPORT ITS OWN FAILURE IS NOT A CHECK.** Printing is not reporting. **Anything a script or a human branches on must be the exit code**, and any script whose output is read by another program must make the exit code and the output agree.

**AND THE SECOND HALF OF THIS ONE IS STILL TRUE:** `checks.py` reads `wide_cols.json` **at import**, that file is gitignored and has never been deployed, and its `SRC` is hardcoded to a path. **It remains unrunnable outside the machine it was written on.** That was gap G24; the migration is cancelled, but if this script is ever reached for as a general fidelity tool, that is what must be fixed first.

## 1.5 The crontab same-store pipeline — it reads and writes one store with nothing in between

**The shape**, from the deleted runbook's F0 — **and it is still the shape anyone will reach for the next time a cron entry needs editing on this box:**

```
crontab -l | sed 's|...|...|' | crontab -
```

**`crontab -l` reads the store and `crontab -` overwrites the same store, in one pipeline, with no intermediate file and no verification between them.** A shell pipeline does not fail fast: **if the middle stage produces nothing, or partial output, `crontab -` faithfully installs nothing, or the partial output.** The four scheduled jobs on this box — the hourly SQLite backup, the two-minute health watchdog, the 03:30 off-site backup, the 04:30 deploy-backup prune — are then gone, and nothing announces it. **The next thing you would notice is a backup that stopped happening.**

**WHAT MAKES IT SURVIVABLE HERE, and it is deliberate:** F0 writes `crontab -l > /root/crontab.pre-cutover` first, joined by `&&`, so the snapshot is taken and its command's success is checked **before** the destructive pipeline runs. **That file is the entire safety net.** The runbook says to check it exists before going on, and that instruction is right.

**THE RULE: NEVER PIPE A STORE INTO ITSELF.** Read to a file, verify the file, transform the file, install the file. **Three of the four jobs on this box exist to protect data; the pipeline that edits their schedule is the least protected step in the system.**

---

# PART 2 — THE RULES. NINE WAYS AN INSTRUMENT REPORTS BLINDNESS AS GOOD NEWS

**These are one rule seen from nine angles, and the angle is what makes each one findable.** Every one was paid for.

1. **A CHECK THAT CANNOT RUN MUST REFUSE, NOT PASS.** Missing tool, wrong scope, no exit code — each reads as *all clear*. `if fuser -s …` is FALSE when `fuser` is not installed. `scripts/postgres-full-copy/drift_guard.py` is the shape to copy: **exit 2 means the check could not see the source, and 2 is not a pass.**
2. **A SEARCH THAT DID NOT COVER THE WHOLE SPACE MUST REFUSE, NOT CONCLUDE.** A scanner that desynchronises on a nested template literal and skips 1,800 lines returns a smaller answer, not an error. **Ten money writes lived in one such window.**
3. **A SCAN OF CODE CANNOT SEE A NAME HELD AS DATA.** Three instances in one session: `CONTROL_PLANE_TABLES` as strings in a `Set`, a stale key in an archived JSON printing blank, and twelve stale names in a committed order file. **When a name changes, committed DATA files are a first-class population to enumerate.**
4. **A SCAN OF SCHEMA CANNOT SEE A SECRET HELD AS A ROW.** Credentials in `storefront_config`, `tenant_secrets` and `tenant_integrations` are rows, not columns, not files, and not environment variables. **No schema diff, no `.env` audit and no secret scanner finds them.**
5. **A SCAN FOR ONE SHAPE ONLY FINDS THAT SHAPE.** The AST authority matched `.transaction` as a member property, so `withTransaction(h, fn)` — an identifier callee — matched nothing, and **26 converted blocks appeared in no figure it printed, through four batches.**
6. **A VERIFIER SHARING THE COPIER'S MAP CANNOT AUDIT THE MAP.** `verify.py` built its comparison from the same `cols[]` that `gen.py` selected from. **It compared 4,220,046 cells clean while eleven columns went uncopied.**
7. **A MONITOR THAT ALERTS ON CHANGE CANNOT SEE A FAULT PRESENT AT STARTUP.** A change-detector's first observation becomes its baseline, so a fault that was already there is adopted as normal. **The only cure is an absolute check alongside the differential one.**
8. **A STALE REFERENCE ANNOUNCES ITSELF AS A PLAUSIBLE FINDING.** A branch-state note is true when written and rots the moment the branch merges. A count pinned to an old head reads as current. **Three independent readings concluded "not built, not run" about a production money write that had already happened**, from a record that was complete except for that one thing.
9. **A COPY OF PRODUCTION CARRIES PRODUCTION'S OUTBOUND CHANNELS.** On 2026-08-23 a proof harness copied `roots.db` to a scratch tree, loaded `lib/ops-alert.js` against it, and **sent three real messages to the live ops WeCom group.** Nothing was wrong with the harness except that it copied the database, and the database carries the webhook. **`scripts/make_safe_db_copy.sh` is now the only sanctioned way to copy `roots.db`** — it severs credentials and endpoints and leaves the rows.

**AND THE TENTH, FOUND WRITING THIS CLOSE-OUT:** **a survey of the nearest obstacle cannot describe the population behind it.** The runbook's B19 measured eleven module-load blockers correctly and then wrote a sentence about what clearing them would turn the system into. **That sentence was false twice**, and no instrument it had could have told it so. Corrected in place inside B19.

---

# PART 3 — THE LIVE DEFECTS

**These are in production code today, or were until days ago, and none of them is about Postgres.**

## 3.1 🔴 OPEN — the WeChat refund callback swallows its write and tells WeChat it succeeded

**`handleWechatRefundCallback` in `routes/retail.js`.** The callback decrypts WeChat's refund-result envelope and updates `retail_orders.refund_payout_ref` so the stored reference stops saying `(PROCESSING)` and starts saying `(SUCCESS)`.

**The write sits inside a bare `try { … } catch (e) { console.error('[wechat-refund/callback db]', e); }`, and the handler then answers `res.json({ code: 'SUCCESS', message: 'OK' })` regardless of whether it wrote.**

**WHY THAT SPECIFIC COMBINATION IS THE DEFECT.** WeChat's retry is driven by the response. Answering `SUCCESS` retires the notification permanently. **So a failed write is not retried, not queued and not visible — the only trace is one line in the pm2 error log, in a file nobody reads unless something else has already gone wrong.** The order keeps a stale payout reference forever.

**WHAT IS NOT AT RISK, stated so the severity is not inflated:** the money has already moved. The refund is marked `paid` synchronously when the refund API accepts it, and this callback is confirmatory, exactly as its own comment says. **The damage is to the record, not to the customer's balance.**

**AND A SECOND HAZARD ON THE SAME LINES:** the lookup is `SELECT order_id FROM retail_payments WHERE out_trade_no = ?` via `.get()`. **`out_trade_no` is NOT unique — that is separately recorded, with five writers believing it is.** So the handler can resolve to whichever row SQLite returns first and stamp the reference onto the wrong order. Silently, and then answer `SUCCESS`.

**THE FIX SHAPE, not built:** answer `SUCCESS` only when the write is known to have happened; on a write failure return a non-2xx so WeChat retries. If the write is genuinely optional, then say so and drop the `catch`'s pretence — **but do not both swallow the error and claim success.**

## 3.2 ✅ CLOSED — 2.14 MB of stale admin front-end was publicly fetchable for months

**`public/` is served at `/assets`.** Three artefacts that no deploy had removed answered **HTTP 200 with full content** at `https://store.rootskitchenchina.com/assets/…`:

| File | Size |
|---|---|
| `public/retail-admin.js` | 940 KB |
| `public/retail-admin.html.bak` | 760 KB |
| `public/cms.html.tmp/` | 442 KB |

**The oldest had been there since 2026-05-20.** They carried no credentials — that was checked, and it is the reason this is a finding rather than an incident. **What they carried was a months-old picture of the admin's internals, served to anyone who asked.**

**Removed 2026-08-23** (14 of the 15 EXTRA files deleted). **Verified gone on the box while writing this file:** all three paths return *No such file or directory*.

## 3.3 🔴 OPEN — the deploy never removes a file, and the detector for that is unscheduled

**Two halves, and the second is the one that keeps it open.**

**The mechanism:** `/root/roots-v2` is not a git checkout. The pipeline **ships files** — stages them under `__stage__/` and installs them. There is no working tree to reconcile against, so **a file deleted in the repository stays on the box forever.** That is how 3.2 happened.

**The detector exists:** `scripts/diagnose_deployed_tree.js` section 4 reports *files on the box the repository does not have*. It currently reports **15**.

**Neither half of making it useful is done.** `EXTRA` **never fails the run** — deliberately, because a permanently red check stops being read, and that reasoning is sound and is not being overturned. And **nothing runs the tool**: `ro-query.yml` is `workflow_dispatch` only, with no schedule, no cron entry and no systemd timer. **A detector that is unscheduled and non-failing is a detector nobody has.**

**Whether to schedule it is a decision nobody has taken.** It is smaller now than it was — the tree is clean apart from 15 known files — which is exactly when it is cheap to schedule.

## 3.4 🔴 OPEN — three untracked scripts on the box, in one copy, and two of them are in cron

**`/root/scripts/` is outside the deploy tree and outside git. No repository search will ever find it. Nothing backs it up.**

| File | In cron | What it is |
|---|---|---|
| `roots-backup.sh` | **hourly** | The hourly SQLite snapshot and the OSS upload. WAL-safe: prefers `sqlite3 .backup`, falls back to `cp` plus `-wal`/`-shm` |
| `prune-deploy-backups.sh` | **04:30** | Deletes `/root/backups/deploy-*` older than 14 days |
| `restore-test.sh` | **no** | Verifies the latest backup actually restores — decompress, `PRAGMA integrity_check`, count the load-bearing tables |

**Checked while writing this: neither `roots-backup.sh` nor `db-backup.sh` backs up `/root/scripts/`.** The hourly backup script exists in exactly one place on earth, and that place is the machine it protects. **If the box is lost, the thing that was protecting it is lost with it** — and the disaster case is precisely when you need to rebuild the backup schedule from something.

**AND `restore-test.sh` IS THE SHARPER FINDING.** A tool that proves the backups are restorable exists, dated 2026-05-18, and **nothing schedules it.** Its own header says *"on demand or via cron"*; the crontab has four entries and it is not one of them. **An unproven restore was recorded as a gap for weeks while a script that would have started proving it sat unrun in an untracked directory.**

**The cheap fix is two lines:** copy the three into the repository (or into the backup set), and add `restore-test.sh` to cron. **Neither is done.**

---

# PART 4 — THE OPERATIONAL FACTS

**Short, load-bearing, and each one has already surprised somebody.**

## 4.1 `pm2 stop` is not durable on this box

**Read out of pm2's own source, not assumed.** `God.restartProcessId` ends:

```js
else { debug('[restart] process not online, starting it'); return God.startProcessId(id, cb); }
```

**So `pm2 restart <name>` STARTS a stopped process.** `bounce_daemon` in `scripts/deploy-apply.sh` runs exactly that on any `lib/*` change. **A daemon stopped by hand comes back on the next shared deploy** — at 48 deploys in two days, within hours, silently, and the person who stopped it has no reason to look.

**If something must stay down across a deploy it has to be `pm2 delete`d or gated in config.** Stopping it is not enough.

## 4.2 `[skip deploy]` defers a run, not a file

`deploy.yml` bases its diff on the server's `.deploy-state/last-success-sha`. **A skipped commit leaves its files pending, and the next push by anyone carries them out.** Measured 2026-08-21: a deferral was overtaken in **17 minutes**.

**This is correct by design and must not be "fixed"** — the server-record base is precisely what closed 197 stranding episodes across 141 files. **What is wrong is reading the token as "this will not ship".** It means *"not on this run"*, and somebody else's unrelated push is the run it ships on.

## 4.3 A restart is a write

**The application's boot path executes DDL.** `database.js` holds 106 `CREATE TABLE IF NOT EXISTS` blocks and 307 `addColumn()` calls; eleven more `.exec()` blocks run at module load across ten files; and opening any tenant database runs `initTenantSchema` and `reconcileTenantColumns`, both of which issue DDL **on every open**.

**Three consequences.** A restart is not a read-only event and must not be treated as one during any maintenance. **`scripts/health-watchdog.js` restarts the application from cron, every two minutes, outside pm2** — so *"the daemons stop"* has never covered it, and any window that assumes nothing is writing has to disable it explicitly. And **a `scripts/` edit restarts the whole backend** for files the application never loads, because `deploy.yml`'s `deployable()` allowlist is a path prefix carrying `scripts/*`.

## 4.4 A disable flag whose obvious value is a no-op

`const SHANGOU_STORES = (process.env.SHANGOU_STORES || 'yuexiu').split(',')…`

**Setting it empty does nothing** — an empty string is falsy, so `||` substitutes the default and the daemon carries on polling the store you just switched off. **The only value that yields an empty list is a bare comma.** The `|| default` idiom cannot express *explicitly none*, anywhere it appears over a list.

## 4.5 The disk has a date

`db-backup.sh` carries `MIN_FREE_MB=2048` with `WORK=/tmp` on the same filesystem. **Measured 2026-08-23: 40 GB total, 8.4 GB free, 78% used**, with `/root/backups` at 18 GB and the daily SQLite gzip alone growing ~1 MB a day at 463 MB per copy. **The nightly off-site backup stops when free space crosses the floor, with no warning tier ahead of it.**

✅ **RELIEVED, NOT SOLVED — the cluster was dropped 2026-08-23 and the disk went 8.1 GB free / 79% → 9.9 GB / 74%**, reclaiming the 1.8 GB of `/var/lib/postgresql`. The `tacet.dump` leg is off the nightly run too. **That buys weeks, not a solution.** The daily SQLite copy is 463 MB and grows, `/root/backups` is 18 GB, and the floor arrives again. **The date has moved; it has not gone.**

---

## RELATED

- `docs/tacet-write-surface.md` — what writes to this database, from where, on what schedule
- `docs/tacet-consolidation-decisions.md` §24 — the decisions record; owns the reasoning behind every item above and wins on any disagreement with this file
- ~~`docs/tacet-postgres-cutover-runbook.md`~~ — **DELETED 2026-08-23.** Where several of these were first written down. **They are restated in full here** so nothing depends on it; git history has it if the original wording is ever wanted.
