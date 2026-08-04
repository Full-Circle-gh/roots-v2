#!/usr/bin/env python3
"""
Copy SQLite tenants -> Postgres accounts (single row, id 1).

Conversions, all pre-agreed:
  rbac_enforce  0 -> false        (rule 2)
  brand_credit  1 -> true         (rule 2)
  created_at        naive -> UTC  (rule 4)
  brand_updated_at  naive -> UTC  (rule 4, confirmed by grep: datetime('now'))
  setup_fee_cents   VERBATIM      (already cents; rule 3 must NOT apply)

SQLite is opened read-only.
"""
import sqlite3
import sys
import os

SRC = "file:/root/roots-v2/data/roots.db?mode=ro"
OUT = "/root/tmp-migration-rehearsal/accounts.sql"

problems = []


def halt(m):
    problems.append(m)


def q_text(v, col):
    if v is None:
        return "NULL"
    s = str(v)
    if "\x00" in s:
        halt(f"{col}: NUL byte")
        return "NULL"
    return "'" + s.replace("'", "''") + "'"


def q_int_verbatim(v, col):
    """Plain integer passthrough. No scaling. Used for setup_fee_cents."""
    if v is None:
        return "NULL"
    if not isinstance(v, int):
        halt(f"{col}: expected integer, got {type(v).__name__} {v!r}")
        return "NULL"
    return str(v)


def q_bool(v, col):
    if v is None:
        return "NULL"
    if v in (0, 1):
        return "true" if v == 1 else "false"
    halt(f"{col}: boolean-target value {v!r} is not 0/1")
    return "NULL"


def q_ts_utc(v, col):
    if v is None:
        return "NULL"
    s = str(v).strip()
    if len(s) != 19 or s[4] != "-" or s[7] != "-" or s[13] != ":" or s[16] != ":":
        halt(f"{col}: unexpected timestamp format {s!r}")
        return "NULL"
    return "'" + s + "+00'"


COLS = [
    ("id",                   q_int_verbatim),
    ("name",                 q_text),
    ("brand_name",           q_text),
    ("status",               q_text),
    ("created_at",           q_ts_utc),
    ("brand_accent",         q_text),
    ("wx_appid",             q_text),
    ("product_catalog_mode", q_text),
    ("onboarding_model",     q_text),
    ("business_category",    q_text),
    ("setup_fee_cents",      q_int_verbatim),   # NO multiplication
    ("features_json",        q_text),
    ("commission_rate_bps",  q_int_verbatim),
    ("rbac_enforce",         q_bool),
    ("brand_logo_data",      q_text),
    ("brand_mark_data",      q_text),
    ("brand_credit",         q_bool),
    ("brand_updated_at",     q_ts_utc),
]

con = sqlite3.connect(SRC, uri=True)
con.row_factory = sqlite3.Row
try:
    con.execute("CREATE TABLE __probe__ (x)")
    print("FATAL: SQLite accepted a write")
    sys.exit(2)
except sqlite3.OperationalError as e:
    print(f"read-only probe OK (write rejected: {e})")

names = ", ".join(f'"{c}"' for c, _ in COLS)
rows = con.execute(f"SELECT {names} FROM tenants ORDER BY id").fetchall()
if len(rows) != 1:
    print(f"FATAL: expected exactly 1 tenant row, found {len(rows)}")
    sys.exit(2)

vals = [fn(rows[0][c], f"tenants.{c}") for c, fn in COLS]
with open(OUT, "w", encoding="utf-8") as f:
    f.write("BEGIN;\n")
    f.write(f"INSERT INTO accounts ({names}) VALUES ({', '.join(vals)});\n")
    f.write("COMMIT;\n")
con.close()

print(f"1 row -> {OUT} ({os.path.getsize(OUT)} bytes)")
# echo the non-payload values so the conversion is visible before it runs
for (c, _), v in zip(COLS, vals):
    if c in ("brand_logo_data", "brand_mark_data"):
        v = f"<{len(v)-2} chars, elided>"
    print(f"   {c:22} = {v}")

if problems:
    print("\n=== HALT ===")
    for p in problems:
        print("  " + p)
    sys.exit(1)
print("\nno unresolved mismatches")
