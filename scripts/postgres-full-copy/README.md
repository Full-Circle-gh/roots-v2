# Postgres migration — full copy

These scripts performed the **full data copy** of 2026-08-04: all 129 non-empty
tables from the live SQLite database into the Postgres `tacet` database —
**353,220 rows in 86 seconds**. They ran on the box (`47.239.89.63`) from an
untracked `/root/tmp-migration-full/` directory and are preserved here so the
work survives a rebuild of that machine.

They are a **sibling** of `scripts/postgres-migration/`, not a replacement.
That directory holds the five-table *rehearsal* that proved the method; this one
holds the full run. They are kept apart because their filenames would collide in
meaning (`gen.py` vs `gen_migration_sql.py`, `verify.py` vs
`verify_migration.py`) and because each README makes claims that are true of its
own scripts only — the rehearsal covered five tables, this covers all of them.

The live app was untouched throughout and remained on SQLite. SQLite is opened
read-only (`file:...?mode=ro`) and **proven** read-only on every connection by
attempting a `CREATE TABLE` and aborting if the write is accepted.

## What each script does

| Script | What it does |
| --- | --- |
| `survey_sqlite.py` | Read-only survey of the live SQLite database — tables, columns, storage classes, row counts. Writes JSON to stdout. |
| `survey_pg.sql` | The matching survey of the Postgres target, run through `psql`: tables, columns, foreign keys, sequences, unique/check/primary constraints, non-zero row counts. |
| `preflight.py` | Scans every non-empty table and every mapped column of the live data against the target types *before* anything is copied. Converts nothing. Checks timestamp/date shapes, boolean 0/1, integer width, numeric money, NUL bytes in text, NOT NULL violations, foreign keys resolving in source, and unique constraints not already violated. |
| `census.py` | Full census of every non-conforming value preflight found, reduced to format shapes and counted — so each decision was taken against the whole population, never a sample. |
| `volume.py` | Measures the byte volume per table and identifies the wide text columns (base64 images, documents, snapshots). Writes `wide_cols.json`, which `verify.py` and `checks.py` read. |
| `money.py` | Asks whether REAL yuan → integer cents is lossless. Any value with more than two decimal places cannot be recovered. |
| `money2.py` | Splits those values into binary-float representation artifacts (harmless, round cleanly) and genuine sub-cent amounts (rounding loses real data). |
| `money3.py` | Relative error of the sub-cent roundings. A per-unit cost of 0.005 becoming 0.01 is a 100% error even though the absolute loss is half a cent. This is the evidence behind the `numeric(14,6)` decision. |
| `precision.py` | Confirms the `store_products` id 104 timestamp correction landed, and works out how many decimal places the nine unit-cost columns actually need — separating genuine precision from float noise — so scale 6 was chosen from the data rather than picked. |
| `overrides.py` | The three decided value overrides, in one module imported by both the generator and the verifier so the copied value and the expected value cannot drift apart. Each rule counts its hits and the run asserts those counts against the survey. |
| `gen.py` | Generates Postgres `INSERT` SQL for one or more tables from live SQLite. Applies the conversion rules below and **halts** on any value that does not fit them rather than guessing. Writes `.sql` files only; connects to nothing. |
| `run.py` | The full run. Truncates the target, then generates, loads and times every non-empty table in dependency order derived from the Postgres foreign keys. Each table's `.sql` file is deleted the moment it has loaded, so peak disk stays near the size of the largest single table. Aborts on the first row-count mismatch. |
| `setseq.py` | Advances every identity sequence past the copied data — from SQLite's `AUTOINCREMENT` high-water mark (`sqlite_sequence`) where the table has one, from `max(id)` where it does not. |
| `verify.py` | Round-trip verifier. Renders the Postgres values back into the SQLite representation *in SQL*, emits one JSON object per row, and compares cell by cell against source. |
| `checks.py` | The three checks the round-trip pass does not cover: every foreign key validated by Postgres itself, Chinese character counts, and the wide base64 columns by SHA-256 of their bytes. |
| `drift_proof.py` | Proves the residual differences are live trading rather than copy errors — by re-counting Chinese with the moved rows excluded, and by comparing verification pass 1 against pass 2. A copy error is a fixed value and reports identically both times; drift reports against a different source value. |
| `final.py` | Final accounting: source drift during the run, and the sequence report. |
| `report_timings.py` | Reads `timings.json` and prints the slowest tables and the totals. |
| `drift.sh` | A small `psql` spot-check of counts and id ranges, used while the run was in progress. |

Two data files are committed because they are **inputs**, not output, and nothing
in this directory regenerates them:

- `plan.json` — the copy plan. Every table and column mapped SQLite → Postgres
  with its source type, target type and conversion class, plus the foreign keys,
  constraints and sequences. Schema metadata only; it holds no row values.
- `copy_order.json` — the table order the copy runs in, derived from the
  Postgres foreign keys so parents load before children.

## The conversion rules these scripts implement

Every rule halts the run on a value it does not recognise. Nothing is guessed.

1. **`tenant_id` → `account_id`.** The column is renamed on the way across; the
   value is carried over unchanged.
2. **Integer flags → real `boolean`.** `0` → `false`, `1` → `true`. Any other
   value halts.
3. **Transaction money: REAL yuan → `bigint` cents**, via `round(yuan * 100)`
   with `ROUND_HALF_UP` in `Decimal` (not float) arithmetic. A value that does
   not fit whole cents halts rather than silently rounding. Columns already named
   `*_cents` are **already cents** and are copied verbatim — rescaling them would
   multiply the value by 100.
4. **Per-unit costs: REAL yuan → `numeric(14,6)` yuan**, exact, not cents. Nine
   columns take this path: `ingredients.cost_per_unit`, `ingredients.buy_price`,
   `ingredient_price_history.price`, `price_alerts.new_price`,
   `price_alerts.old_price`, `po_line_items.cost_per_unit`,
   `po_line_items.total_cost`, `expense_entries.amount`,
   `waste_entries.cost_lost`. Unit costs get multiplied by quantity, so whole
   cents is wrong for them — twelve genuine unit costs would have rounded to
   zero and 188 values were off by more than 10 percent. See
   `money.py` → `money2.py` → `money3.py` → `precision.py` for the evidence.
5. **Naive `DATETIME` text is treated as UTC.** `'YYYY-MM-DD HH:MM:SS'` is
   emitted with an explicit `+00`. **ISO-8601 text with a trailing `Z` is
   accepted as UTC verbatim**, milliseconds preserved — 4,437 values across 15
   columns. Anything in neither shape halts. Plain `DATE` columns are emitted as
   `::date` with no timezone.
6. **Weight stays text.** `products.weight` and `store_products.weight` are free
   text with mixed units — `'220 g'`, `'500ml'`, `'1L'`, `'120g (4 bars)'` and
   one malformed `'5--g'`. They are copied verbatim into `text`. No numeric
   conversion is correct; stripping units would equate 500ml with 500g. Parsing
   weight belongs to the Products stage.
7. **Text is quoted, not escaped.** `standard_conforming_strings` is on, so only
   the quote doubles. Newlines, backslashes and CJK pass through a quoted literal
   untouched. A NUL byte halts — Postgres `text` cannot hold one.
8. **Sequences are set after the copy, from the high-water mark.** `setseq.py`
   uses SQLite's `AUTOINCREMENT` value rather than `max(id)`. 117 of 139
   sequences took this path, and it matters on 20 tables where ids are burned —
   `guanyi_sync_log` copied to max id 55,186 while SQLite's high-water was
   already 55,189. Setting from `max(id)` would have put the sequence behind
   live reality.
9. **Three decided value overrides**, in `overrides.py`: voucher `TAP20` expiry
   set to end of day China time (`15:59:59Z`), `recipe_cost_data.packaging_type_id`
   set to NULL (the reference never existed), and four
   `storefront_config.updated_by` rows set to NULL (they held script names, not
   user ids).

## COLLATE "C" is required — read this before writing any comparison

**Any SQLite → Postgres row comparison keyed on a text column must order the
Postgres side with `COLLATE "C"`.**

SQLite orders text by byte. Postgres orders by locale, which ignores
punctuation — so `me_page.rows` and `membership.layout` come out in opposite
orders on the two sides. Without the collation the comparison pairs up different
rows and **every cell looks wrong**. During verification this produced 117 false
differences and looked exactly like data corruption.

`verify.py:107-119` (`order_by_pg`) is the implementation: it appends
`COLLATE "C"` whenever the ordering key is `text` or `character`. Reuse it rather
than rewriting it.

## Generated output is never committed

These scripts write `.sql` files into a `sql/` subdirectory. **That output
contains real customer, order and financial data and must never enter git.** It
is intermediate: `run.py` deletes each file the moment it has loaded, and a
`.gitignore` in this directory blocks the directory and any stray `.sql` file
alongside it.

The same applies to every report the scripts write — `preflight.json`,
`sqlite_survey.json`, `counts_before.json`, `timings.json`, `sequences.json`,
`wide_cols.json`, `verify_*.json` and the `.log` files. None of them are
committed. Re-run the script to regenerate what you need. `survey_pg.sql` and
`plan.json` are the exceptions noted above: schema metadata, hand-assembled, no
row values.

## Byte fidelity

These files are the verbatim record of a run that already happened, and they
checksum against the copies on the box. `checks.py`, `gen.py`, `verify.py`,
`plan.json` and `copy_order.json` are stored with **CRLF** endings; everything
else is **LF**. `.gitattributes` marks this directory `-text` so git converts
nothing in either direction. Do not "normalise" them.

## Result

- 129 non-empty tables, **353,220 rows, 86 seconds**.
- Row counts matched exactly, zero mismatches.
- 3,244,556 cells round-trip compared, 43 differences — all proved by
  `drift_proof.py` to be live trading during the run, not copy errors.
- All 144 foreign keys validated by Postgres itself.
- Chinese character counts exact once the two drifted rows are excluded.
- 2,112 base64 values byte-identical by SHA-256; the widest is 3,331,931
  characters.
- 139 identity sequences set.

The source gained 48 rows during the 86-second window and keeps moving. **Drift,
not speed, is the cutover constraint** — a clean cutover needs a quiet window or
a delta pass over the tables that take writes: the sync logs,
`retail_checkout_quotes`, `activity_log` and the auth tables.

## Related

- `scripts/postgres-migration/` — the five-table rehearsal that proved the
  method, with its own README.
- `docs/tacet-postgres-schema-as-built-2026-08-04.sql` — the schema as it stands
  after this copy. **Current.**
- `docs/tacet-postgres-schema-phase1.sql` — the original phase-1 dump. Stale on
  eleven columns; retained as the historical record only.
- `docs/tacet-consolidation-decisions.md` §24, "Full data copy to Postgres" —
  the decisions and findings behind this run.
