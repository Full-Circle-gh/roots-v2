#!/usr/bin/env python3
"""
Rehearsal: generate Postgres INSERT SQL from the live SQLite database.

READ-ONLY on SQLite (uri mode=ro). Emits .sql files only; writes nothing to
SQLite and connects to nothing. Halts loudly on any value that does not fit
the four agreed conversion rules.
"""
import sqlite3
import sys
import os
from decimal import Decimal, ROUND_HALF_UP

SRC = "file:/root/roots-v2/data/roots.db?mode=ro"
OUT = "/root/tmp-migration-rehearsal"

problems = []


def halt(msg):
    problems.append(msg)


# ---------- value renderers ----------

def q_text(v, col):
    """Text -> SQL literal. standard_conforming_strings is on, so only ' doubles."""
    if v is None:
        return "NULL"
    if isinstance(v, bytes):
        halt(f"{col}: BLOB value where TEXT expected")
        return "NULL"
    s = str(v)
    if "\x00" in s:
        halt(f"{col}: value contains NUL byte, not representable in Postgres text")
        return "NULL"
    return "'" + s.replace("'", "''") + "'"


def q_int(v, col):
    if v is None:
        return "NULL"
    if isinstance(v, float) and not v.is_integer():
        halt(f"{col}: non-integer {v!r} in an integer column")
        return "NULL"
    return str(int(v))


def q_bool(v, col):
    """Rule 2: 0 -> false, 1 -> true. Anything else halts."""
    if v is None:
        return "NULL"
    if v in (0, 1):
        return "true" if v == 1 else "false"
    halt(f"{col}: boolean-target value {v!r} is not 0/1")
    return "NULL"


def q_cents(v, col):
    """Rule 3: round(yuan * 100) -> bigint, ROUND_HALF_UP."""
    if v is None:
        return "NULL"
    d = Decimal(str(v)) * 100
    cents = int(d.quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    return str(cents)


def q_ts_utc(v, col):
    """Rule 4: naive SQLite text is UTC -> emit with explicit +00 offset."""
    if v is None:
        return "NULL"
    s = str(v).strip()
    if len(s) != 19 or s[4] != "-" or s[7] != "-" or s[13] != ":" or s[16] != ":":
        halt(f"{col}: unexpected timestamp format {s!r} (expected 'YYYY-MM-DD HH:MM:SS')")
        return "NULL"
    return "'" + s + "+00'"


def q_date(v, col):
    if v is None:
        return "NULL"
    s = str(v).strip()
    if len(s) != 10 or s[4] != "-" or s[7] != "-":
        halt(f"{col}: unexpected date format {s!r} (expected 'YYYY-MM-DD')")
        return "NULL"
    return "'" + s + "'::date"


# ---------- table specs: (pg_column, sqlite_column, renderer) ----------

T = "text"
SPECS = [
    ("users", [
        ("id",              "id",              q_int),
        ("username",        "username",        q_text),
        ("password",        "password",        q_text),
        ("role",            "role",            q_text),
        ("display_name",    "display_name",    q_text),
        ("is_active",       "is_active",       q_bool),
        ("last_login",      "last_login",      q_ts_utc),
        ("created_at",      "created_at",      q_ts_utc),
        ("market_id",       "market_id",       q_int),
        ("retail_store_id", "retail_store_id", q_int),
    ]),
    ("suppliers", [
        ("id",                    "id",                    q_int),
        ("name",                  "name",                  q_text),
        ("name_cn",               "name_cn",               q_text),
        ("contact_name",          "contact_name",          q_text),
        ("contact_phone",         "contact_phone",         q_text),
        ("contact_wechat",        "contact_wechat",        q_text),
        ("payment_terms",         "payment_terms",         q_text),
        ("rating",                "rating",                q_int),
        ("notes",                 "notes",                 q_text),
        ("is_active",             "is_active",             q_bool),
        ("created_at",            "created_at",            q_ts_utc),
        ("updated_at",            "updated_at",            q_ts_utc),
        ("products_supplied",     "products_supplied",     q_text),
        ("price_info",            "price_info",            q_text),
        ("business_license_data", "business_license_data", q_text),
        ("permits_data",          "permits_data",          q_text),
        ("payment_qr_data",       "payment_qr_data",       q_text),
        ("channel_type",          "channel_type",          q_text),
        ("channel_link",          "channel_link",          q_text),
        ("channel_qr_data",       "channel_qr_data",       q_text),
        ("payment_method",        "payment_method",        q_text),
        ("account_id",            "tenant_id",             q_int),   # rule 1
    ]),
    ("purchase_orders", [
        ("id",                   "id",                   q_int),
        ("po_number",            "po_number",            q_text),
        ("date",                 "date",                 q_date),
        ("delivery_date",        "delivery_date",        q_date),
        ("status",               "status",               q_text),
        ("warehouse",            "warehouse",            q_text),
        ("supplier",             "supplier",             q_text),
        ("notes",                "notes",                q_text),
        ("posted_to_accounting", "posted_to_accounting", q_bool),
        ("created_at",           "created_at",           q_ts_utc),
        ("updated_at",           "updated_at",           q_ts_utc),
        ("created_by",           "created_by",           q_int),
        ("source",               "source",               q_text),
        ("backorder_of",         "backorder_of",         q_int),
        ("no_invoice_expected",  "no_invoice_expected",  q_bool),
        ("scope",                "scope",                q_text),
        ("store_id",             "store_id",             q_int),
        ("extra_freight",        "extra_freight",        q_cents),  # rule 3
        ("extra_tax",            "extra_tax",            q_cents),
        ("extra_handling",       "extra_handling",       q_cents),
        ("account_id",           "tenant_id",            q_int),
    ]),
    ("invoices", [
        ("id",             "id",             q_int),
        ("supplier",       "supplier",       q_text),
        ("invoice_number", "invoice_number", q_text),
        ("amount",         "amount",         q_cents),  # rule 3
        ("date",           "date",           q_date),
        ("notes",          "notes",          q_text),
        ("created_by",     "created_by",     q_int),
        ("created_at",     "created_at",     q_ts_utc),
        ("updated_at",     "updated_at",     q_ts_utc),
        ("scope",          "scope",          q_text),
        ("store_id",       "store_id",       q_int),
        ("due_date",       "due_date",       q_date),
        ("paid_at",        "paid_at",        q_ts_utc),
        ("account_id",     "tenant_id",      q_int),
    ]),
]

# Only these tables carry a tenant filter; users has no tenant column.
TENANT_FILTER = {"suppliers", "purchase_orders", "invoices"}


def main():
    os.makedirs(OUT, exist_ok=True)
    con = sqlite3.connect(SRC, uri=True)
    con.row_factory = sqlite3.Row

    # Prove the connection really is read-only before reading anything.
    try:
        con.execute("CREATE TABLE __rehearsal_write_probe__ (x)")
        print("FATAL: SQLite connection accepted a write. Aborting.")
        sys.exit(2)
    except sqlite3.OperationalError as e:
        print(f"read-only probe OK (write rejected: {e})")

    for table, cols in SPECS:
        where = " WHERE tenant_id = 1" if table in TENANT_FILTER else ""
        src_cols = ", ".join(f'"{c[1]}"' for c in cols)
        rows = con.execute(f"SELECT {src_cols} FROM {table}{where} ORDER BY id").fetchall()

        pg_cols = ", ".join(f'"{c[0]}"' for c in cols)
        path = os.path.join(OUT, f"{table}.sql")
        with open(path, "w", encoding="utf-8") as f:
            f.write("BEGIN;\n")
            for r in rows:
                vals = []
                for pg_col, sq_col, fn in cols:
                    vals.append(fn(r[sq_col], f"{table}.{sq_col}"))
                f.write(f"INSERT INTO {table} ({pg_cols}) VALUES ({', '.join(vals)});\n")
            f.write("COMMIT;\n")
        print(f"{table}: {len(rows)} rows -> {path} ({os.path.getsize(path)} bytes)")

    con.close()

    if problems:
        print("\n=== HALT: unresolved mismatches ===")
        for p in problems[:50]:
            print("  " + p)
        sys.exit(1)
    print("\nno unresolved mismatches; all values fit the four agreed rules")


main()
