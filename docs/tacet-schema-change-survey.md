# Tacet schema-change mechanism survey, v1.0

**2026-08-04 · A read-only survey of how schema changes reach the database today, written before choosing a replacement. Nothing was changed and nothing was run against the databases: SQLite was opened `-readonly`, Postgres was read with `SELECT` only.**

**This document recommends nothing. No option has been chosen. The decision is OUTSTANDING.**

The six options in §3 are set out with their honest trade-offs so the choice can be made from facts rather than from memory of how the code works. Whoever makes that choice should read §4 first — the constraints are not preferences, and several of them rule options in or out on their own.

Recorded as an open decision at §24 of `docs/tacet-consolidation-decisions.md` ("The schema-change mechanism is unresolved — OPEN 2026-08-04").

Two corrections to earlier records, established by this survey:

> **`_migrations` is not empty.** The live SQLite table has **144 rows**. The empty one is in the **Postgres `tacet`** database (0 rows) — it was created by the phase-1 schema dump and nothing has ever written to it. It is not a fossil in SQLite; it is load-bearing today.

> **The table count is 162, not 137.** `sqlite_master` on the live DB reports 162 tables, 237 indexes, 0 views, 0 triggers. `docs/tacet-consolidation-decisions.md` §"account column added staged" says "~140 tables". I could not find 137 anywhere in the repo.

Repo at survey time: `origin/main` = `bb7fa698` (HEAD identical).

---

## 1 — What exists now

### The mechanisms, all of them

There are **seven** distinct ways schema changes reach the database. Only the first is the one people talk about.

| # | Mechanism | Where | Count | When it runs |
|---|---|---|---|---|
| 1 | `addColumn(table, col, type)` | [database.js:20](database.js:20) | **294 calls** | module load |
| 2 | Literal `ALTER TABLE … ADD COLUMN` in a `try{}catch{}` | 10 files | **32 sites** (24 in production code) | module load, mostly |
| 3 | `CREATE TABLE IF NOT EXISTS` | database.js + 12 route/lib files | **102 in database.js**, ~25 elsewhere | module load |
| 4 | `_migrations`-guarded one-time blocks | database.js (51), backend-auth.js (2), releases.js (1) | **54** | module load |
| 5 | Derived schema — shape read from another table at boot | [database.js:3772](database.js:3772) (`store_products`), [4410](database.js:4410) | 2 | module load |
| 6 | Schema mirroring into per-tenant DB files | [lib/tenant-db.js:62](lib/tenant-db.js:62), [:90](lib/tenant-db.js:90) | 2 functions | every tenant-DB open |
| 7 | **Lazy DDL from a `catch` block at runtime** | [lib/delivery-reminders.js:96](lib/delivery-reminders.js:96), [:136](lib/delivery-reminders.js:136) | 2 | inside a 60-second sweeper |

`addColumn` is three lines: run the `ALTER`, swallow the error if the message matches `/duplicate column/i`, rethrow otherwise. That string match is the entire "already applied" test.

Mechanism 7 deserves calling out: a scheduled job queries `retail_orders`, and if the query throws "no such column", it runs an `ALTER TABLE` from the catch block and returns. Schema changes there during normal operation, not at boot.

### When they run

`database.js` is a **4,706-line top-level script**. Everything above runs at `require()` time — there is no `migrate()` function, no entry point, no guard. `module.exports = db` is line 4,705. Requiring the database *is* running the migrations.

That require happens in **eight live pm2 processes**: `roots-v2`, plus `meituan-sync`, `guanyi-sync`, `gzgrocery-orders`, `shangou-sync`, `qingyun-sync`, `qingyun-sync-yuexiu`, and the probe scripts. Each one executes the full DDL sequence against the same `roots.db` on its own start.

### What happens if one fails partway

There is no outer transaction. Behaviour depends on which of three shapes the statement has:

- **Bare `db.exec(...)`** — 69 at top level in database.js, including `db.exec(schema)` at line 14. A throw here **kills module load**, which kills the process. pm2 crash-loops it. Statements before it stay applied; everything after never runs.
- **`try { … } catch {}`** — 56 one-liners. Failure is silent. No log, no marker, no signal. This is how `CREATE INDEX` and stray `UPDATE`s are written.
- **`try { … } catch (e) { console.error('[migration name]', e) }`** — 45 blocks. Failure prints to the pm2 log and boot continues. The `_migrations` marker is not written, so it retries next boot.

The `_migrations`-guarded blocks check and mark **non-atomically** — `SELECT 1 FROM _migrations` then, later, `INSERT INTO _migrations`. A few wrap the body in `db.transaction()` (the table rebuild at [database.js:4039](database.js:4039) does); most do not. With eight processes doing this, two can both read "not applied" and both run the backfill. SQLite's write lock serialises the writes, not the decision.

Practically, a crash-on-boot is the *good* failure: pm2 crash-loops, the deploy health probe fails, and files roll back. A silent `catch {}` is the bad one.

### Fresh install vs existing database

Same code path, different outcome:

- **Fresh** — `schema.sql` creates 29 tables (the original kitchen app). `database.js` then creates ~102 more with their **full current column list**, and the 294 `addColumn` calls fill in the rest.
- **Existing** — `schema.sql` is a no-op (`IF NOT EXISTS`). Every `CREATE TABLE` is a no-op. Only `addColumn` and the guarded blocks do anything.

**The failure mode this invites**: edit a `CREATE TABLE IF NOT EXISTS` block to add a column, and the fresh DB gets it while every existing DB silently doesn't.

I checked for this. **It has not happened.** I parsed every `CREATE TABLE` block in the repo and diffed the declared columns against the live database's actual columns: **zero missing columns across 157 tables**. Whoever has been maintaining this has been disciplined about pairing every block edit with an `addColumn`.

What *has* drifted is the other direction — five tables exist live with **no `CREATE TABLE` anywhere in the repo**:

| Table | Rows | Status |
|---|---|---|
| `meituan_listing_specs` | 0 | **Live code reads and writes it.** DDL exists nowhere. |
| `store_products` | — | Derived at boot (see below), no literal DDL by design |
| `plans` | 0 | Fossil — superseded by `billing_plans` |
| `subscriptions` | 0 | Fossil — superseded by `billing_subscriptions` |
| `retail_product_day_baseline` | 0 | Abandoned — feature replaced in `28ad12fd` |

`meituan_listing_specs` is the sharp one. Its `CREATE TABLE` was added to `database.js` in commit `6ad2e9a9` — **on the `guanyi-stock-sync` branch, which was never merged to main**. That branch's code ran on the box, so the table exists in production. Later, `5f081d45` landed on main carrying the daemon code that `DELETE`s from and `INSERT`s into it — but not the `CREATE TABLE`. Today [routes/meituan-admin.js:368](routes/meituan-admin.js:368) and [scripts/meituan-daemon.js:881](scripts/meituan-daemon.js:881) use a table that main has no definition for. A fresh install would 500 on that path.

### What records what has been applied

`_migrations` — `(name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)`. It is `CREATE TABLE IF NOT EXISTS`-ed in five separate places rather than once.

It is **not a fossil, and it is not a migration ledger**. It is a general-purpose "have we done this once" flag, and only about a third of it is schema:

| Marker kind | Rows |
|---|---|
| `release_announced_*` — push notifications fired by [releases.js:47](releases.js:47) | **91** |
| Actual schema / seed / backfill markers | **53** |
| **Total** | **144** (2026-05-07 → 2026-08-02) |

The 53 real markers are almost all **data** operations, not schema: `seed_home_layout_v1`, `backfill_lifetime_spend_v1`, `allergens_normalize_v1`, `rename_channel_wechat_to_miniapp_v1`. Exactly one is a structural change: `drop_ledger_actor_fk_v1`.

The 294 `addColumn` calls and the 102 `CREATE TABLE`s are **not tracked at all**. Their "have we applied this" test is asking the database.

`PRAGMA user_version` is **0**. `application_id` is **0**. There is no version number anywhere.

**Undo**: nothing. No down-migrations, no reverse scripts, no concept of one. The only undo is restoring a backup — hourly local snapshots (24 kept), daily local (30 kept), and a nightly verified off-site copy to Aliyun OSS covering `roots.db` plus five tenant DBs ([scripts/db-backup.sh](scripts/db-backup.sh), which runs `PRAGMA integrity_check` before anything is uploaded). That backup story is genuinely good. It is also the entire rollback story for schema.

---

## 2 — What the app does on startup

### Order

```
server.js:1-8      express, session, helmet, path, fs
server.js:254      require('./lib/tenant-db')
                     └─ line 21: require('../database')   ← FIRST DB TOUCH
                          ├─ open data/roots.db, WAL, foreign_keys = ON
                          ├─ exec schema.sql                       (29 tables)
                          ├─ 294 addColumn calls                   (interleaved
                          ├─ 102 CREATE TABLE IF NOT EXISTS         with the
                          ├─ ~110 CREATE INDEX IF NOT EXISTS        others, in
                          ├─ 51 _migrations-guarded blocks          file order)
                          ├─ store_products derived from products' pragma
                          ├─ retail_stock_ledger rebuild (drop/recreate)
                          ├─ activity_log retention DELETE
                          └─ module.exports = db
server.js:255      require('./lib/tenant-creds')   → CREATE TABLE tenant_secrets
server.js:309-356  ~40 route modules, each running its own DDL on require
                     backend-auth.js  → 6 CREATE TABLE + 15 ALTER + 2 _migrations
                     billing.js       → 3 CREATE TABLE + 1 ALTER + plan seed
                     saas-admin.js    → 1 CREATE TABLE + 5 ALTER
                     store-admin.js   → 4 CREATE TABLE + 1 ALTER
                     …
server.js:854      app.listen(4000)
server.js:858+     release announcement → writes _migrations
                   4 background sweepers start (one of which does lazy DDL)
```

### Assumptions it makes

1. **File position is dependency order.** `store_products` is built at line 3,772 by mirroring `products`' columns. All 51 `addColumn('products', …)` calls sit at lines 24–2,841. Nothing enforces this — moving one `addColumn` below line 3,793 would silently desync the two catalogues for one boot. It is correct today; it is correct by accident of editing order.
2. **Route-module DDL runs after `database.js`.** Guaranteed only because `server.js:254` requires `tenant-db` (and therefore `database`) before `server.js:309` starts requiring routes.
3. **Every ALTER is additive.** `addColumn` can only add. Renames, drops, type changes and constraint changes have no path except the manual rebuild pattern.
4. **`duplicate column` is the only expected error.** Any other message rethrows and crash-loops the process.
5. **One writer.** Not true — eight processes run this.
6. **Boot is cheap enough to be invisible.** Deploy runs are 20–55 s end to end; `deploy-apply.sh` sleeps 5 s then probes with up to 20 s of settle window, and deploys report SUCCESS. So boot-to-serving on the 510 MB live DB fits inside ~20 s. I did not measure it precisely — doing so would mean executing the migration path against a copy, which is outside a read-only survey.

### What would behave differently against Postgres

Every one of these is SQLite-only and would need replacing, not porting:

| What | Where | Why it breaks |
|---|---|---|
| `new Database(path)`, synchronous API | [database.js:8](database.js:8) | `pg` is async. Every `db.prepare().get()` in the codebase is sync. |
| `/duplicate column/i` error match | [database.js:22](database.js:22) | Postgres says `column "x" of relation "y" already exists` — the regex fails, so it **rethrows and crash-loops**. |
| `ALTER TABLE ADD COLUMN` needs no guard | throughout | Postgres has `ADD COLUMN IF NOT EXISTS`. The try/catch becomes unnecessary — and dangerous, since a failed `ALTER` in Postgres aborts the surrounding transaction. |
| `db.pragma('table_info(x)')` | [database.js:3773](database.js:3773), [:3792](database.js:3792) | No pragmas. Needs `information_schema.columns`. |
| `sqlite_master` reads | [lib/tenant-db.js:64](lib/tenant-db.js:64), [database.js:4049](database.js:4049) | Needs `pg_catalog` / `information_schema`. |
| `db.pragma('legacy_alter_table')`, `foreign_keys = OFF` | [database.js:4045](database.js:4045) | No equivalent. Postgres can `ALTER TABLE … DROP CONSTRAINT` directly — the whole drop/recreate dance is unnecessary and would have to be rewritten, not translated. |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | ~102 CREATE TABLEs | `GENERATED BY DEFAULT AS IDENTITY`, plus `setval` after any data copy. |
| `DATETIME DEFAULT CURRENT_TIMESTAMP` | throughout | `TIMESTAMPTZ DEFAULT now()`. Naive text becomes a real instant — the rehearsal treats it as UTC. |
| Integer flags | throughout | Real `boolean`. |
| `REAL` yuan | 101 columns | `BIGINT` cents (§24). `*_cents` columns must **not** be rescaled. |
| DDL is transactional-ish | — | Postgres DDL **is** transactional, which is a large improvement — but it means a failure mid-block rolls back the whole block, changing the "partly applied" semantics the current code assumes. |
| `store_products` derivation | [database.js:3772](database.js:3772) | The storefront's main catalogue table (~140 columns) has **no schema text anywhere**. Postgres needs a written definition. |
| `lib/tenant-db.js` entirely | — | Per-file tenant isolation. §24 retires it. |

---

## 3 — The options

Two independent decisions here, and they get conflated. **What describes a change**, and **where the change runs**. I'll separate them.

### 3a — Where a migration step could run

| Placement | What it means | Fit |
|---|---|---|
| **At boot, inside `database.js`** | Status quo shape. Any process that starts runs it. | No new plumbing. But it runs in all 8 processes, extends every restart, and a failure means crash-loop. Needs an advisory lock at minimum. |
| **In `deploy-apply.sh`, between install and `pm2 restart`** | A step in the server-side installer, before the app comes up. | Fits the existing pipeline exactly: files land, migrate, restart, health-probe, roll back on failure. Runs once. The failure has somewhere sensible to go (abort before restart, like the existing `npm install` step already does). |
| **In the GitHub Actions workflow over SSH** | A step in `.github/workflows/deploy.yml`. | Same benefits, but puts the migration in CI rather than on the box — worse when the box is the only thing that can reach the database. |
| **Operator-triggered from the admin UI** | A button. Ash decides when. | Decouples code deploy from schema change, which matters for expand/contract. Needs building, and needs the code to tolerate both schema states meanwhile. |

**A blocking detail for the file-based options**: the deploy allowlist in [.github/workflows/deploy.yml:82](.github/workflows/deploy.yml:82) and [scripts/deploy-changed.sh:43](scripts/deploy-changed.sh:43) is `public/ routes/ lib/ middleware/ scripts/ server.js database.js schema.sql package*.json`. **A `migrations/` folder at the repo root would never be shipped.** Either the migration files live under `scripts/`, or both allowlists change. Also: `deploy-apply.sh` only *adds* files — deletions never reach the box, so a deleted or renamed migration file stays live forever.

### 3b — What describes a change

**Option A — Keep the current mechanism, extend it to Postgres**

*What it is*: keep writing `addColumn` calls; add a Postgres branch to the helper.

*Requires*: a Postgres-aware `addColumn` (`ADD COLUMN IF NOT EXISTS`, no error-string matching), an async layer or a sync Postgres driver, and a rewrite of the three places that read `sqlite_master`/`pragma`. `store_products` needs a real definition written by hand.

*Undo*: none. Restore a backup.

*Deploy fit*: perfect — nothing changes. Which is the problem.

*Honest trade-off*: it costs almost nothing today and has actually held up (zero column drift over 162 tables). It cannot express a rename, a drop, a type change or an RLS policy, and it has no notion of "not yet applied to Postgres but applied to SQLite" — which the two-engine transition needs. Adding an account column to ~140 tables this way means ~140 more lines in a file that is already 4,706 lines, and no way to tell which module's rollout is done.

---

**Option B — Plain SQL files plus a small runner you write**

*What it is*: `scripts/migrations/0001-accounts-column.sql`, applied in filename order, each recorded in a version table. The runner is roughly 80–120 lines.

*Requires*: writing it; picking where it runs; a lock so eight processes can't race; deciding whether `down` files exist at all. Postgres DDL is transactional, so each file can run in a transaction and either fully land or not.

*Undo*: whatever you build. Paired `.down.sql` files are conventional and mostly a lie — nobody tests them, and a down-migration that drops a column destroys data. The honest version is forward-only plus backups.

*Deploy fit*: good, if the files live under `scripts/` (allowlist) and the runner is a step in `deploy-apply.sh`.

*Honest trade-off*: total control, no dependency, matches how the rest of this codebase is built (hand-rolled, well-commented, no frameworks). But it is code you own and debug, and it means someone writes raw DDL for every change. It also does nothing about the existing 294 `addColumn` calls — those stay as the bootstrap for a fresh install, or get folded into an initial baseline migration.

---

**Option C — An off-the-shelf Node migration library**

Candidates: `node-pg-migrate` (Postgres-specific, JS or SQL migration files, has real `down` support), `Umzug` (a generic runner, storage-agnostic, works with any driver), `db-migrate`, Knex migrations.

*What it is*: a `migrations/` directory, a CLI (`npm run migrate up`), a `pgmigrations` table tracking what ran.

*Requires*: a dependency; a CLI invocation somewhere in the pipeline; adopting its file conventions. `node-pg-migrate` is Postgres-only, so the SQLite side would still need something else during transition. Umzug is engine-agnostic but you supply the execution yourself, which brings it close to Option B with more ceremony.

*Undo*: `migrate down` exists and works for the reversible cases. Same caveat — dropping a column you just added still deletes the data written into it.

*Deploy fit*: needs the allowlist change and a CLI step. The `npm install` step in `deploy-apply.sh` already handles new dependencies correctly, so adding one is low-friction.

*Honest trade-off*: proven, documented, and someone else maintains it. It also imports a set of conventions into a codebase that has deliberately avoided frameworks, and it does not know anything about RLS policies — those are just DDL you write inside its files.

---

**Option D — Declarative / desired-state tooling**

Candidates: **Atlas** (Go binary, HCL or SQL schema files, computes the diff and generates the migration; has a linter that flags destructive changes), Sqitch (Perl, dependency-ordered, explicit verify/revert per change), Flyway and Liquibase (both JVM).

*What it is*: you describe the schema you *want*; the tool works out the SQL to get there.

*Requires*: installing a binary (or a JVM); a checked-in schema definition. **Critically, it requires the repo to be the source of truth for the schema — which it is not today.** The five orphan tables and the derived `store_products` would all have to be reconciled first, or the first diff would try to drop them.

*Undo*: Atlas generates down-migrations; Sqitch has explicit revert scripts per change. Better than most, still not free.

*Deploy fit*: a binary on the box plus a step in `deploy-apply.sh`. The JVM ones are a poor fit for a 40 GB box at 78 % disk.

*Honest trade-off*: this is the approach that best matches "Ash is not a developer" — the artifact is a description of the schema, not a sequence of instructions, and the diff is generated. It is also the approach that demands the most cleanup before it can be used at all, and generated migrations still need reading before they run against a live business.

---

**Option E — Postgres-native online schema change**

Candidates: **pgroll** (expand/contract with both schema versions live behind views, so old and new application code run simultaneously and a rollback is instant), **Reshape** (similar idea).

*What it is*: each migration creates a new versioned schema of views over the same tables. The old app version keeps reading the old view; the new one reads the new. You roll forward by completing, or backward by rolling back — both instant, neither loses data.

*Requires*: Postgres only (no SQLite path at all), a binary, and a real conceptual shift — schema changes become two-phase.

*Undo*: **genuine, instant, lossless rollback** while a migration is in-flight. This is the only option that gives that.

*Deploy fit*: this is the one that actually matches the constraint that **file rollback does not roll back schema**. With pgroll, the rolled-back code version is still served its old view, so it keeps working. With everything else, an auto-rollback restores code that may not match the schema it now faces.

*Honest trade-off*: it is the strongest answer to the specific problem here and the least familiar tool on the list. It is Postgres-only, so it contributes nothing until after the switchover. It adds a step Ash would have to understand ("start" and "complete" are separate actions).

---

**Option F — ORM-managed schema**

Candidates: Prisma Migrate, Drizzle Kit, TypeORM.

*What it is*: a schema file in the ORM's language; the tool generates and applies migrations.

*Requires*: adopting the ORM. Every raw SQL query in this codebase — and it is all raw SQL, hundreds of `db.prepare(...)` calls — would either be rewritten or would coexist with a schema definition that nothing enforces.

*Undo*: Prisma has `migrate diff` and `migrate resolve`; in practice ORM rollbacks are also mostly forward-only.

*Deploy fit*: possible, but the schema-vs-code divergence risk is high if the ORM is used only for migrations.

*Honest trade-off*: I include it for completeness. Adopting an ORM's migration half without its query half means maintaining a second description of the schema that nothing verifies. That is the exact failure this survey found five instances of already.

---

## 4 — The hard constraints

Any solution has to satisfy all of these. They are not preferences.

**1. Schema is not in the rollback set.**
[scripts/deploy-apply.sh:160](scripts/deploy-apply.sh:160) restores backed-up *files* and restarts pm2. The database is untouched. So after a failed deploy, **the previous code version runs against the new schema**. Every migration must leave the prior code able to function — additive-only, or genuinely two-phase (Option E). A migration that renames or drops anything will survive a rollback and break the restored code.

**2. The rollback trigger fires on schema failures too.**
The health probe hits `/`, `/api/retail/categories`, `/api/retail/config`, `/api/retail/products` and rolls back on 5xx or no answer. A migration that leaves the app unable to serve those four paths will auto-roll-back the files — and leave the half-applied schema.

**3. Downtime is a pm2 restart, and that is already the budget.**
Observed deploys: 20–55 s wall clock, with boot-to-serving inside a ~20 s settle window. A migration that takes minutes — a full-table rewrite on a 510 MB database, or an `ALTER TABLE` that takes an `ACCESS EXCLUSIVE` lock on a busy Postgres table — blows past that and triggers the auto-rollback. Long operations must run outside the restart, or use Postgres' non-blocking forms (`CREATE INDEX CONCURRENTLY`, `ADD COLUMN` with a non-volatile default, `NOT VALID` constraints validated later).

**4. Eight processes, one database.**
`roots-v2` plus seven daemons all `require('./database')`. `deploy-apply.sh` bounces the daemons **after** the app's health check, so they start ~25 s later and re-run the same DDL. Any migration runner needs a lock (`pg_advisory_lock` in Postgres; there is no clean equivalent in SQLite beyond the write lock) or must run in exactly one place outside the app's boot path.

**5. Two engines during the transition, by design.**
§24: "Phase 1 installs PostgreSQL alongside the running SQLite app; nothing points at it yet… Roots keeps trading on SQLite throughout, and does not move until the new account has run on PostgreSQL first." So there is a period where **one account is on Postgres and one is on SQLite, simultaneously**, and the same application code serves both. Whatever tracks applied migrations must track them **per engine**, and the SQLite lineage will stop at a point the Postgres lineage continues past. The current single `_migrations` name-set cannot express this.

**6. Ash will not hand-edit files.**
Whatever this is, the trigger has to be something already in the loop — a commit, a push, a button — and the artifact should not be raw DDL authored by hand for each of ~140 tables. This argues for generation (Option D) or for the migration content coming from a script rather than a person.

**7. The repo is not the source of truth for the schema.**
Five live tables have no definition in the repo. `store_products` — the storefront's whole catalogue — exists only as a runtime derivation. Both Postgres schema files were generated *from the live database* precisely because of this. Any desired-state tool (Option D) will treat the repo as authoritative on its first run and propose dropping what it cannot see. This must be reconciled **before** such a tool is pointed at anything.

**8. New files must be on the deploy allowlist.**
`migrations/` at the repo root is invisible to both deploy paths. And deletions never ship — a removed migration file stays on the box.

**9. Disk headroom is thin.**
40 GB volume at **78 % used, 8.3 GB free**. `roots.db` is 510 MB. A table rebuild needs roughly double the table's size; the hourly backups already hold ~7.7 GB; Postgres will want its own space alongside. `db-backup.sh` already refuses to run below 2 GB free on `/tmp`.

**10. There are five orphaned tenant database files.**
`data/tenants/{2,4,5,6,7}.db` still exist (one with a 2.8 MB uncommitted WAL) and are still in `db-backup.sh`'s `TENANTS="2 4 5 6 7"` list — even though those accounts were **deleted from the live database on 2026-08-04** and `tenants` now holds only Roots. Each file carries its own copy of ~150 tables. Whatever happens, these are schema surfaces nobody is planning to migrate.

---

## 5 — What surprised me

**The mechanism has actually worked.** I expected drift and found none: 157 tables parsed from source, **zero** columns declared in code but missing live. For a hand-maintained, 4,706-line, 294-`addColumn` arrangement with no version tracking, that is a better record than the design deserves. Whatever replaces it is replacing something that has not been failing — the case for change is what is *coming*, not what has broken.

**`_migrations` is two thirds push notifications.** 91 of 144 rows are `release_announced_*` markers written by [releases.js:47](releases.js:47) to avoid re-firing a "what's new" push. They share a primary key namespace with schema markers. Anything that reads this table as a migration ledger will read 91 rows of notification bookkeeping.

**Live code on `main` uses a table `main` cannot create.** `meituan_listing_specs` — DDL added on the unmerged `guanyi-stock-sync` branch, readers and writers merged to main separately. Production works only because the unmerged branch once ran on the box. This is the clearest possible demonstration that the live database, not the repo, is the schema of record.

**`store_products` has no schema text.** The storefront's entire catalogue table is built at boot by reading `products`' `pragma table_info` and mirroring it, plus four link columns, plus ~12 store-only `addColumn`s. Its shape is a function of another table's runtime shape. For Postgres it has to be written down for the first time — and the correctness check is against the live database, not the code.

**Schema changes during normal operation.** [lib/delivery-reminders.js:96](lib/delivery-reminders.js:96) and [:136](lib/delivery-reminders.js:136) run `ALTER TABLE retail_orders ADD COLUMN` from inside a `catch` block in a sweeper that ticks every 60 seconds. Not at boot. Not at deploy. Whenever the query happens to fail.

**Destructive rebuilds already run at boot.** `drop_ledger_actor_fk_v1` ([database.js:4039](database.js:4039)) reads the live `CREATE` from `sqlite_master`, strips a foreign-key clause with a regex, creates a temp table, copies every row, `DROP TABLE`s the original, and renames. On startup. It is carefully written — transactional, `foreign_key_check`-verified, `_migrations`-guarded, with a good comment — but the pattern exists and something will reach for it again.

**Fossils were carried forward into both Postgres schemas.** `plans`, `subscriptions` and `retail_product_day_baseline` are dead — zero rows, zero code references, superseded features — yet all three appear in `docs/tacet-postgres-schema-phase1.sql` **and** `docs/tacet-postgres-schema-proposed.sql`. Faithfully translating the live database means faithfully translating its junk. The proposed schema's own header says "no new table, column, index or constraint is invented", which is the right rule and also why nothing got cleaned.

**Ordering is a positional accident.** `store_products` mirrors `products` at line 3,793. All 51 `addColumn('products', …)` calls are above it. Nothing enforces that. A future `addColumn('products', …)` appended at the end of the file — the natural place to add one — would desync the two catalogues.

**`routes/billing.js:8` already names the trap.** The comment reads: the bare names `plans` / `subscriptions` were deliberately avoided in favour of `billing_`-prefixed ones. Both bare tables exist in the live database anyway, from an earlier attempt. The comment documents a decision the database never got told about.

---

## What I did not do

- Did not measure boot duration precisely — that requires executing the migration path against a database copy.
- Did not verify the "137 tables" figure. Live is 162; `docs/tacet-consolidation-decisions.md` says "~140". If 137 came from a specific count, I could not find its source.
- Recommended nothing, per the brief.
