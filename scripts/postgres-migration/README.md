# Postgres migration — rehearsal scripts

These four scripts are the **rehearsal** for the SQLite → Postgres migration.
They were written and run on the box (`47.239.89.63`) in August 2026 and are
preserved here so the work is not lost if the box is rebuilt.

**This is rehearsal code. It is not the final migration, and it has not been run
against all tables.** It proves the conversion method on a five-table sample.

## What each script does

| Script | What it does |
| --- | --- |
| `gen_migration_sql.py` | Reads four tables from the live SQLite database (`users`, `suppliers`, `purchase_orders`, `invoices`) and writes one `.sql` file per table containing Postgres `INSERT` statements. Applies the conversion rules below and **halts** if any value does not fit them. |
| `gen_accounts_sql.py` | Same thing for the single `tenants` row → the Postgres `accounts` table. Kept separate because `accounts` has its own column list and one column (`setup_fee_cents`) must *not* be rescaled. |
| `verify_migration.py` | Compares the four migrated tables cell by cell against SQLite. Renders the Postgres side **back** into the SQLite representation (boolean → `0`/`1`, cents → yuan, `timestamptz` → naive UTC text) so an exact string match means the value survived intact. |
| `verify_accounts.py` | The same round-trip comparison for the single `accounts` row, printed as a readable column-by-column table. |

Both generators open SQLite with `?mode=ro` and **prove** it is read-only by
attempting a `CREATE TABLE` first and aborting if the write is accepted. They
write `.sql` files only — they never connect to Postgres. Loading is a separate,
deliberate step.

The verifiers shell out to `sudo -u postgres psql -d tacet`.

## Result of the rehearsal

A verified 5-table rehearsal — `suppliers`, `purchase_orders`, `invoices`,
`users`, `accounts` — copied SQLite → Postgres with **zero cell differences**.

The two oversized base64 columns per table (logos, licences, permits, QR images)
are compared by character length, byte length **and** SHA-256 of the UTF-8 bytes,
so a one-character truncation would be caught.

## Conversion rules the rehearsal proved

1. **`tenant_id` → `account_id`.** The column is renamed on the way across; the
   value is carried over unchanged. Only `suppliers`, `purchase_orders` and
   `invoices` carry it — `users` has no tenant column.
2. **Integer flags → real `boolean`.** `0` → `false`, `1` → `true`. Any other
   value halts the run rather than guessing.
3. **`REAL` yuan → `bigint` cents**, via `round(yuan * 100)` with `ROUND_HALF_UP`
   in `Decimal` (not float) arithmetic. **Except** columns already named
   `*_cents` — those are already cents and are copied verbatim. Rescaling them
   would multiply the value by 100.
4. **Naive `DATETIME` text is treated as UTC.** `'YYYY-MM-DD HH:MM:SS'` is
   emitted with an explicit `+00` offset. Anything not in that exact format halts.
   Plain `DATE` columns are emitted as `::date` with no timezone.
5. **`setval` is run after each table** so the Postgres sequence continues past
   the highest migrated id. This is a step in the load procedure, not something
   the generator scripts emit — without it the first new insert collides with an
   existing id.

## What is left in Postgres right now

The rehearsal left **276 rows** in the Postgres `tacet` database across those
five tables:

| Table | Rows |
| --- | --- |
| `accounts` | 1 |
| `users` | 7 |
| `suppliers` | 210 |
| `purchase_orders` | 51 |
| `invoices` | 7 |
| **Total** | **276** |

**These are rehearsal artifacts, not production data.** Nothing reads them. The
live app is still on SQLite. Expect to truncate them before any real migration
run.

## Related

- `docs/tacet-postgres-schema-phase1.sql` — the **as-built** `pg_dump` of the
  schema currently in the `tacet` database.
- `docs/tacet-postgres-schema-proposed.sql` — a separate, later **proposed**
  schema draft covering all 162 tables. A design document; it has not been run.
