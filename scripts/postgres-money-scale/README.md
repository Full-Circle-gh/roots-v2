# Money decimal scale — the census behind the scale decision

`docs/tacet-consolidation-decisions.md` §24 records that money is stored as
**decimal, not whole cents**, and leaves one thing explicitly open:

> **The decimal SCALE is unsettled.** The nine columns already migrated are
> `numeric(14,6)`. Whether six fractional digits is the right scale for money,
> and whether a precision of 14 leaves enough headroom, is an open question and
> is **NOT decided here.**

This directory holds the read-only census that supplies the evidence. It
**counts and characterises; it recommends nothing.** The scale decision is taken
elsewhere, against these numbers.

It is a **sibling** of `scripts/postgres-full-copy/`, not part of it. That
directory is the verbatim record of the 2026-08-04 copy and its files checksum
against the copies on the box — nothing here modifies it. This directory reads
one input from it: `plan.json`, the roster of which columns are money.

## What the census answers

For every money column in the copy plan — 92 `CENTS` + 9 `NUM6`, 101 columns
across 40 tables:

1. **How many fractional digits the real data actually holds.** Reported two
   ways, because SQLite stores these as `REAL` (binary float):
   - **raw scale** — digits after the point in the shortest round-trip repr.
     What the bytes say, float noise included.
   - **genuine scale** — the smallest scale at which rounding is
     indistinguishable from the stored double (relative 1e-12). What the value
     *means*. Same test as `postgres-full-copy/precision.py`, so the numbers
     stay comparable with the evidence already on record.

   The gap between the two is noise, not data. `0.1 + 0.2` is raw 17, genuine 1.

2. **The largest absolute value each column holds**, and the integer digits it
   needs — which sizes the **precision** (the 14), independently of the scale.
   Nothing in the repository records this today for any money column.

Every column is bucketed **DISPLAYED** vs **CALCULATED** so the two populations
can be read apart:

- **DISPLAYED** — an amount a person sees, pays, is charged or is refunded. It
  settles in the currency's smallest payable unit and never needs to be finer.
- **CALCULATED** — an amount derived by arithmetic (a division, a per-unit rate,
  a roll-up, an average) that feeds further arithmetic before anyone sees it.
  Sub-cent resolution here is signal, not noise.

The classification lives in `money_bucket.json`, one entry per column with the
reason. It is data, not code, so it can be argued with without touching the
census.

**The split is not clean in the schema today.** Three calculated-money columns
sit in the whole-cent bucket — `packaging_types.cost`, `recipe_cost_data.labour`
and `recipe_cost_data.packaging`, all inputs to the recipe cost-per-serving
roll-up. The 2026-08-04 migration split on *evidence of sub-cent values*, which
these one-row tables did not have, rather than on role. `money_bucket.json`
marks them `calculated` and the census reports them under that heading.

`expense_entries.amount` is marked `boundary` and reported separately: §24
re-decided it back to whole cents, its seven sub-cent values being
`postPOExpenses()` residue rather than money that changed hands.

## Files

| File | What it is |
| --- | --- |
| `money_scale_census.py` | The census. Read-only. Reads the roster from `../postgres-full-copy/plan.json` and the buckets from `money_bucket.json`. |
| `money_bucket.json` | DISPLAYED / CALCULATED / boundary for all 101 columns, with the reason for each. |
| `make_fixture.py` | Builds a synthetic SQLite fixture whose correct answers are known by construction, to prove the census before it is pointed at live data. Touches nothing real. |

## Read-only, and how that is proven rather than asserted

The census opens SQLite with `mode=ro` and then **proves** it on every
connection, the same way every script in `postgres-full-copy/` does: it attempts
a `CREATE TABLE` and aborts the run unless the write is rejected.

It then proves it can actually **read**, by counting `sqlite_master`. This
second probe matters on a live box: a WAL-mode database whose `-wal` needs
recovery will open read-only and fail on the first query. Without the probe that
failure would surface as 101 absent columns and the run would report an empty
database instead of an error.

Beyond the probes: the only SQL the script issues is `SELECT` and `COUNT(*)`,
it opens no other database, and it writes only to the path given by `--json`.

**One honest caveat.** Reading a WAL-mode database causes SQLite to create a
`-shm` sidecar next to it if one is not already there. That is a shared-memory
index, not database content — the `.db` and `-wal` bytes are unchanged. Verified
by md5 before and after a read.

If a database cannot be read because its WAL needs recovery, the script says so
and tells you what to do. **Do not add `immutable=1`** — on a live database that
silently skips the WAL and hands back stale or torn rows. Take a consistent
snapshot the way `scripts/db-backup.sh` does, then census the snapshot:

```bash
sqlite3 /root/roots-v2/data/tenants/5.db ".backup /root/tmp-money-scale/snap-5.db"
```

## Running it

Six databases: the main one plus the five per-tenant files. Tenant databases are
schema-only clones created by `lib/tenant-db.js`; tables absent from a clone are
reported under "COLUMNS IN PLAN BUT NOT IN THIS DATABASE" rather than failing the
run. Per-tenant maximums are the point — headroom is exactly where a
higher-value tenant, or one on a currency with larger numbers, differs from Roots.

Output goes **off-repo**, to an untracked directory, because it contains real
money values:

```bash
mkdir -p /root/tmp-money-scale
cd /root/roots-v2/scripts/postgres-money-scale

python3 money_scale_census.py --db /root/roots-v2/data/roots.db \
    --label roots  --json /root/tmp-money-scale/census-roots.json \
    2>&1 | tee /root/tmp-money-scale/census-roots.log

for t in 2 4 5 6 7; do
  python3 money_scale_census.py --db /root/roots-v2/data/tenants/$t.db \
      --label tenant-$t --json /root/tmp-money-scale/census-tenant-$t.json \
      2>&1 | tee /root/tmp-money-scale/census-tenant-$t.log
done
```

`--plan` defaults to `../postgres-full-copy/plan.json` and needs no argument when
run from this directory. The full per-column results are in the `--json` file;
the console output is the readable report.

## Proving the census before trusting it

```bash
python3 make_fixture.py && python3 money_scale_census.py --db fixture.db --plan ../postgres-full-copy/plan.json
```

The fixture holds values whose answers are known by construction — `0.1 + 0.2`
(means 1dp, stores 17), `0.005`, `0.0037`, `0.000125`, `99999999.99`. A correct
run reports genuine scale 6, raw scale 17, 8 integer digits, and a loss table of
`s=2:3  s=3:2  s=4:1  s=6:0`. Both fixture files are gitignored.

## Related

- `docs/tacet-consolidation-decisions.md` §24 — the decimal decision, and the
  open scale question this census serves.
- `docs/tacet-money-model-survey.md` — the 2026-08-04 money-unit survey. §1b
  holds the per-column count of values above 2dp for the nine `numeric(14,6)`
  columns; §8 holds the `expense_entries.amount` finding.
- `scripts/postgres-full-copy/` — the completed copy. `plan.json` is the roster
  this census reads; `precision.py` is where the genuine-scale test comes from.
