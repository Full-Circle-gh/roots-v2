# What writes to this database — the write surface, v1.0

**2026-08-23 · A survey of the SQLite system as it stands today.** Not about Postgres. It was produced during the Postgres work, it is worth more now than it was for the flip, and it is kept here so that it does not retire with `docs/tacet-postgres-cutover-runbook.md`.

**READ THIS BEFORE ANYTHING THAT TAKES THE DATABASE AWAY** — a restore, a rename, a maintenance window, a box move, a backup you intend to trust, or any question that starts *"if we stopped the app, would anything still be writing?"*. The answer to that last one is **yes**, and this page is the list.

---

## ⚠️ THIS IS A RE-DERIVATION, NOT A TRANSCRIPTION — AND THAT IS ITSELF THE FIRST FINDING

**The original survey was never committed anywhere.** It was done in a working session, its conclusions were used, and the only trace of it that reached the repository is the four-row cron table in the retired runbook's step F0 and the cost-of-stopping paragraph in its C1. **Everything else — the process count, the scheduler count, the read-triggered writes, the callback classification — existed only in a conversation.**

**So this file re-measures rather than remembers.** Every number below was derived at head `576f8f81` with the instrument named beside it. **Where a re-derived figure differs from what was carried in memory, the re-derived figure is the one written down and the difference is recorded rather than reconciled away.**

**A survey that is not committed did not happen.** This project has now paid for that twice: once when a production money write left no trace and three independent readings concluded it had never run, and once here. **The rule is the same both times — if it is not in the repository, nothing in the repository can see it.**

---

## 1. THE EIGHT PROCESSES THAT WRITE

**Instrument:** `pm2 jlist` on `root@47.239.89.63`, cross-referenced against each script's database references and `.prepare(` count in the repository.

**Sixteen pm2 processes are online. Eight of them hold a handle on the application's data.**

| pm2 name | Script | `.prepare(` sites | What it writes |
|---|---|---|---|
| `roots-v2` | `server.js` | 12 direct, plus all of `routes/` and `lib/` | Everything. The mini app, the web storefront, the admin, the POS, every callback |
| `meituan-sync` | `scripts/meituan-daemon.js` | 42 | Meituan orders, stock pushes, sync log |
| `guanyi-sync` | `scripts/guanyi-daemon.js` | 40 | Guanyi ERP sync, stock, `guanyi_sync_log` |
| `shangou-sync` | `scripts/shangou-daemon.js` | 37 | 闪购 orders, stock, verify state |
| `qingyun-sync` | `scripts/qingyun-daemon.js` | 28 | Qingyun delivery status, Tianhe |
| `qingyun-sync-yuexiu` | `scripts/qingyun-daemon.js` | 28 | **Same program, second instance, Yuexiu** |
| `gzgrocery-orders` | `scripts/gzgrocery-order-daemon.js` | 23 | gzgrocery order read-sync, decrements Tianhe stock |
| `eleme-sync` | `scripts/eleme-daemon.js` | 19 | Eleme listings and stock |

**SEVEN PROGRAMS, EIGHT PROCESSES.** `qingyun-daemon.js` runs twice, once per store. **Anything that enumerates "the daemons" by script name gets seven and is wrong by one process.**

**THE EIGHT THAT DO NOT TOUCH IT, listed so nobody re-checks them:** `xvfb`, `shangou-chrome`, `qingyun-chrome`, `qingyun-chrome-yuexiu`, `proxy-watchdog`, `ops-screen-vnc`, `ops-screen-web`, `ops-screen-ctl`. **Zero `.prepare(` sites between them.** The Chrome holders drive browsers; the daemons beside them do the writing.

**AND ONE WRITER THAT IS NOT UNDER pm2 AT ALL.** `scripts/health-watchdog.js` runs from **root's crontab, every two minutes**. It holds no database handle of its own, but it runs `pm2 restart roots-v2`, **and a restart is a write** — the application's boot path executes DDL and schema self-heal. *"Stop the daemons"* has never covered it, because it is not a daemon. See `docs/tacet-operating-findings.md`.

---

## 2. THE TWELVE IN-PROCESS SCHEDULERS

**Instrument:** every `setInterval(` in `server.js`, `lib/` and `routes/`, classified by (a) whether it is armed at module load or per request, and (b) whether its tick reaches the database.

**Twelve schedulers exist inside `roots-v2`. Eleven of them are running. Every one of the eleven writes.**

### Armed at module load in `routes/retail.js` — seven that write

| Timer | Every | Tick |
|---|---|---|
| `_secHoldSweep` | 5 min | `tickSweepStaleSecHolds` |
| `_bcSweep` | 1 min | `tickBroadcastScheduler` |
| `_autoDeliverSweep` | 1 min | `tickAutoDeliverLocalEta` — flips local-ETA orders to `delivered` |
| `_autoDispatchSweep` | 1 min | `tickAutoDispatchQingyun` |
| `_autoDeliverQySweep` | 1 min | `tickAutoDeliverQingyun` |
| `_wxShippingSweep` | 5 min | `tickRetryWeChatShipping` |
| `_staleCancelSweep` | 15 min | `tickCancelStalePending` — **cancels orders** |

### Started from `server.js` after boot — four that write

| Starter | Module |
|---|---|
| `startReservationSweeper()` | `lib/inventory.js` — releases expired stock reservations |
| `startDeliveryReminderSweeper()` | `lib/delivery-reminders.js` |
| `startKd100Sweeper()` | `lib/tracking.js` — courier tracking poll |
| `startReviewTopupSweeper()` | `lib/review-topup.js` |

### One that exists and never runs

**`startBillingScheduler()` in `lib/billing-lifecycle.js` is exported and called from nowhere in the tree.** `routes/billing-pay.js` requires the module for `runBillingLifecycle`, not for the scheduler. **So a daily billing lifecycle pass is written, tested-shaped, and dark.** Whether it should be running is a question for whoever owns billing; it is recorded here because a scheduler that is never started looks exactly like one that is, from any list of `setInterval` call sites.

### Three timers that are NOT schedulers, listed so they are not counted

`_viewSweep`, `_trackSweep` and `_clientLogSweep` are module-load `setInterval`s that prune **in-memory `Map`s** — viewer presence and two rate limiters. **They never touch the database.** A count of module-level `setInterval` in `routes/retail.js` gives ten; **only seven of the ten are writers**, and the difference is exactly this kind of thing.

**Per-request timers are excluded entirely** — the SSE keepalives in `routes/events.js` and the dashboard live feed in `routes/retail.js` arm one interval per open connection and write nothing.

> **THE COUNT CARRIED IN MEMORY WAS TWELVE AND THE RE-DERIVATION AGREES, but only because one of the twelve turned out to be dark.** Eleven run. **Do not quote "twelve schedulers are running."**

---

## 3. READ-TRIGGERED WRITES

**These are the ones a survey of timers and routes misses**, because nothing schedules them and no endpoint is named for them. **They fire on the way through a read.**

**1. OPENING A TENANT DATABASE PERFORMS DDL.** `openTenantDb()` in `lib/tenant-db.js` runs `initTenantSchema(db)` and `reconcileTenantColumns(db)` **on every open, not on first creation.** The first diffs the tenant's `sqlite_master` against the main database and `CREATE`s whatever is missing; the second diffs every shared data-plane table's columns and issues `ALTER TABLE … ADD COLUMN`. **A tenant's first read after a schema change writes schema.** That is by design and the header says so — it is here because *"reads do not write"* is a natural assumption and it is false in this codebase.

**2. `maybePruneClientLogs()` in `routes/retail.js` deletes rows from an insert path.** It is called on the client-log write path, gated to at most once an hour **per process**, and issues `DELETE FROM retail_client_logs WHERE created_at < datetime('now','-30 days')`. **Nothing schedules it. Traffic schedules it.** With eight processes, the per-process gate means the real cadence depends on how many of them take that path.

**3. The `maybe*` family in `routes/retail.js` fires side-effecting work off order state, not off a timer** — `maybeAutoIssueInvoice`, `maybeFlagUncallablePhone`, `maybeEnqueueQingyunPush`, `maybeSendDeliveredSms`. Each is reached from a request or a callback and each can write. **They are named consistently, which is the only reason they are findable as a group.**

**WHY THIS SECTION EXISTS.** Any plan that says *"stop the writers"* has to answer for these. **They have no process to stop and no timer to disable.** The only thing that stops them is stopping whatever reads.

---

## 4. THE INBOUND CALLBACKS, CLASSIFIED

**Instrument:** every `router.post` in `routes/` whose path is a callback, notify or webhook endpoint, read for what it writes and for **what it tells the caller when the write fails.** That second column is the one that matters, because it decides whether a lost write is retried or lost forever.

| Endpoint | Handler | Writes | On a failed write |
|---|---|---|---|
| `/api/retail/payment/wechat/callback` (+ `/:tid`) | `handleWechatPayCallback` | **Money.** Order settlement, points, balance | WeChat retries until it is answered `SUCCESS` — **the retry is the safety net** |
| `/api/retail/payment/wechat/refund-callback` (+ `/:tid`) | `handleWechatRefundCallback` | `retail_orders.refund_payout_ref` | 🔴 **Swallowed.** The write sits in a bare `try/catch` that logs, and the handler answers `SUCCESS` regardless. **WeChat never retries. The reference stays stale forever and only a log line records it.** See the findings file |
| `/api/retail/payment/alipay/callback` | inline | Payment settlement | — |
| `/api/wx/callback` (+ `/:tid`) | `handleWxPushEvent` | WeChat platform push events | — |
| `/api/backend/billing/payment/wechat/callback` | inline, `routes/billing-pay.js` | Billing/subscription payment | — |
| `/api/retail/auth/oauth/:provider/callback` | `handleOauthCallback` | Session and customer identity | — |

**AND THE CLASSIFICATION THAT MATTERS MOST IS THE ABSENCE.** **Courier tracking does not arrive by callback.** KD100 is **polled**, by `startKd100Sweeper()` in `lib/tracking.js`. There is no inbound tracking endpoint to protect, and equally there is nothing that will re-deliver a tracking update that was missed — **the next poll is the only recovery, and if the sweeper is not running there is none.**

**The channel orders are also not callbacks.** Meituan, 闪购, Eleme, Qingyun and gzgrocery all arrive by **poll**, from their own daemon, roughly every five minutes. **A channel does not know or care whether this box heard it.** That is why stopping a daemon does not queue anything: the orders keep being taken and the box simply stops learning about them.

---

## 5. WHAT THIS ADDS UP TO

**If the database goes away — renamed, restored over, moved — this is what is still pointed at it:**

- **eight processes**, seven of which will not notice for up to five minutes and will then fail on a poll;
- **eleven timers inside the application**, the fastest firing every sixty seconds, two of which change order state and one of which cancels orders;
- **read-triggered DDL** that fires on the next tenant access, with no process and no schedule to disable;
- **one cron job outside pm2 that restarts the application**, which is itself a write;
- **~80 loose scripts under `scripts/` that open the database by path** and, if the file is renamed rather than deleted, fail loudly — which is the whole reason the retired runbook insisted on rename over delete, and is still the right instruction for any maintenance that takes the file away.

**THERE IS STILL NO WRITE FREEZE.** No maintenance mode, no read-only mode, nothing in the application that can stop trading. **The only mechanisms are blunt: stop the processes, or accept that writes continue.** That was gap G16 and it is not closed — the migration that needed it is cancelled, but **the absence is a property of the system, not of the migration**, and any future maintenance window meets it again.

**AND `pm2 stop` DOES NOT HOLD.** A stopped process is restarted by the next shared deploy — `pm2 restart` falls through to `start` for a process that is not online. **Anything that must stay down across a deploy has to be `pm2 delete`d or gated in config.** See the findings file.

---

## METHOD, AND WHAT IT CANNOT SEE

- pm2 process list: `pm2 jlist` on the box, 2026-08-23.
- Handle ownership and statement counts: text scan of each script for `require('../database')`, `new Database(`, `getTenantDb`, `rawTenantDb`, and occurrences of `.prepare(`. **A text scan, not an AST pass.**
- Schedulers: every `setInterval(` in `server.js`, `lib/`, `routes/`, then each one's tick read by hand to decide whether it writes. **Classification by reading, not by pattern.**
- Callbacks: every `router.post` whose path contains `callback`, `notify`, `webhook` or `push`, then each handler read for its write and its response-on-failure.

**WHAT THIS SURVEY CANNOT SEE, stated so it is not read as complete:**

- **A writer whose handle arrives as a parameter** rather than being obtained in the file. The scan finds where handles are *acquired*; a helper that is handed one is invisible to it.
- **A name held as data.** A table or process named in a JSON file or a `Set` of strings is invisible to a scan of code — this project has been bitten by that three times in one session.
- **Anything on the box that is not in the repository.** Two of the four cron jobs live in `/root/scripts/` and are untracked; no repository search will ever find them.
- **Whether a scheduler that is started actually ticks.** `startBillingScheduler` was found dark by reading its callers. **A starter that is called can still be guarded, and this method would not see that either.**

---

## RELATED

- `docs/tacet-operating-findings.md` — the findings from the same work that are not about Postgres
- `docs/tacet-consolidation-decisions.md` §24 *THE POSTGRES MIGRATION IS CANCELLED. TACET STAYS ON SQLITE* — why the migration this came from stopped
- `docs/tacet-postgres-cutover-runbook.md` — **RETIRED.** Its F0 and C1 hold the original four-row cron table and the cost-of-stopping paragraph this file expands
