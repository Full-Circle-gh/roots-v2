#!/usr/bin/env python3
"""
Rehearsal verification: render both sides into one canonical representation and
diff them row by row, column by column.

The Postgres side is rendered BACK into the SQLite representation (bool -> 0/1,
cents -> yuan, timestamptz -> naive UTC text) so that an exact string match
means the value survived the conversion intact.

The two oversized base64 columns are compared as length + sha256 of the UTF-8
bytes, so a truncation of even one character shows up.

SQLite is opened read-only.
"""
import sqlite3
import subprocess
import hashlib
import sys

SRC = "file:/root/roots-v2/data/roots.db?mode=ro"
NULL = "\\N"
BIG = {"business_license_data", "permits_data", "payment_qr_data", "channel_qr_data"}

# (pg_col, sqlite_col, kind)
SPECS = {
    "users": [
        ("id", "id", "int"), ("username", "username", "text"),
        ("password", "password", "text"), ("role", "role", "text"),
        ("display_name", "display_name", "text"), ("is_active", "is_active", "bool"),
        ("last_login", "last_login", "ts"), ("created_at", "created_at", "ts"),
        ("market_id", "market_id", "int"), ("retail_store_id", "retail_store_id", "int"),
    ],
    "suppliers": [
        ("id", "id", "int"), ("name", "name", "text"), ("name_cn", "name_cn", "text"),
        ("contact_name", "contact_name", "text"), ("contact_phone", "contact_phone", "text"),
        ("contact_wechat", "contact_wechat", "text"), ("payment_terms", "payment_terms", "text"),
        ("rating", "rating", "int"), ("notes", "notes", "text"),
        ("is_active", "is_active", "bool"), ("created_at", "created_at", "ts"),
        ("updated_at", "updated_at", "ts"), ("products_supplied", "products_supplied", "text"),
        ("price_info", "price_info", "text"),
        ("business_license_data", "business_license_data", "big"),
        ("permits_data", "permits_data", "big"),
        ("payment_qr_data", "payment_qr_data", "big"),
        ("channel_type", "channel_type", "text"), ("channel_link", "channel_link", "text"),
        ("channel_qr_data", "channel_qr_data", "big"),
        ("payment_method", "payment_method", "text"), ("account_id", "tenant_id", "int"),
    ],
    "purchase_orders": [
        ("id", "id", "int"), ("po_number", "po_number", "text"), ("date", "date", "date"),
        ("delivery_date", "delivery_date", "date"), ("status", "status", "text"),
        ("warehouse", "warehouse", "text"), ("supplier", "supplier", "text"),
        ("notes", "notes", "text"), ("posted_to_accounting", "posted_to_accounting", "bool"),
        ("created_at", "created_at", "ts"), ("updated_at", "updated_at", "ts"),
        ("created_by", "created_by", "int"), ("source", "source", "text"),
        ("backorder_of", "backorder_of", "int"),
        ("no_invoice_expected", "no_invoice_expected", "bool"),
        ("scope", "scope", "text"), ("store_id", "store_id", "int"),
        ("extra_freight", "extra_freight", "money"), ("extra_tax", "extra_tax", "money"),
        ("extra_handling", "extra_handling", "money"), ("account_id", "tenant_id", "int"),
    ],
    "invoices": [
        ("id", "id", "int"), ("supplier", "supplier", "text"),
        ("invoice_number", "invoice_number", "text"), ("amount", "amount", "money"),
        ("date", "date", "date"), ("notes", "notes", "text"),
        ("created_by", "created_by", "int"), ("created_at", "created_at", "ts"),
        ("updated_at", "updated_at", "ts"), ("scope", "scope", "text"),
        ("store_id", "store_id", "int"), ("due_date", "due_date", "date"),
        ("paid_at", "paid_at", "ts"), ("account_id", "tenant_id", "int"),
    ],
}
TENANT_FILTER = {"suppliers", "purchase_orders", "invoices"}


def esc(s):
    """Neutralise the characters that would break one-row-per-line parsing.
    Applied identically to both sides, so it can never mask a real difference."""
    return (s.replace("\\", "\\\\").replace("\t", "\\t")
             .replace("\n", "\\n").replace("\r", "\\r"))


def sq_render(v, kind):
    if v is None:
        return NULL
    if kind == "int":
        return str(int(v))
    if kind == "bool":
        return str(int(v))
    if kind == "money":
        return f"{float(v):.2f}"
    if kind == "big":
        b = str(v).encode("utf-8")
        return f"len={len(str(v))} bytes={len(b)} sha256={hashlib.sha256(b).hexdigest()}"
    return esc(str(v))


def pg_expr(col, kind):
    c = f'"{col}"'
    if kind == "bool":
        return f"CASE WHEN {c} IS NULL THEN NULL WHEN {c} THEN '1' ELSE '0' END"
    if kind == "money":
        return f"to_char({c}::numeric/100, 'FM999999999990.00')"
    if kind == "ts":
        return f"to_char({c} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')"
    if kind == "date":
        return f"to_char({c}, 'YYYY-MM-DD')"
    if kind == "big":
        return ("CASE WHEN {c} IS NULL THEN NULL ELSE 'len='||length({c})"
                "||' bytes='||octet_length({c})"
                "||' sha256='||encode(sha256(convert_to({c},'UTF8')),'hex') END").format(c=c)
    # same escaping as esc() on the python side, backslash first
    e = f"{c}::text"
    e = f"replace({e}, '\\', '\\\\')"
    e = f"replace({e}, E'\\t', '\\t')"
    e = f"replace({e}, E'\\n', '\\n')"
    e = f"replace({e}, E'\\r', '\\r')"
    return e


def psql(sql):
    r = subprocess.run(
        ["sudo", "-u", "postgres", "psql", "-d", "tacet", "-At", "-F", "\t",
         "--no-align", "-c", sql],
        capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        print("PSQL ERROR:", r.stderr)
        sys.exit(2)
    return r.stdout


def main():
    con = sqlite3.connect(SRC, uri=True)
    con.row_factory = sqlite3.Row
    try:
        con.execute("CREATE TABLE __probe__ (x)")
        print("FATAL: SQLite accepted a write")
        sys.exit(2)
    except sqlite3.OperationalError:
        pass

    overall_ok = True
    for table, cols in SPECS.items():
        where = " WHERE tenant_id = 1" if table in TENANT_FILTER else ""
        src_cols = ", ".join(f'"{c[1]}"' for c in cols)
        src_rows = con.execute(
            f"SELECT {src_cols} FROM {table}{where} ORDER BY id").fetchall()

        exprs = ", ".join(f"coalesce({pg_expr(p, k)}, '{NULL}')" for p, _, k in cols)
        out = psql(f"SELECT {exprs} FROM {table} ORDER BY id")
        pg_rows = [ln.split("\t") for ln in out.split("\n") if ln != ""]

        print(f"\n===== {table} =====")
        print(f"  rows  sqlite={len(src_rows)}  postgres={len(pg_rows)}  "
              f"{'MATCH' if len(src_rows) == len(pg_rows) else '*** MISMATCH ***'}")
        if len(src_rows) != len(pg_rows):
            overall_ok = False
            continue

        diffs = 0
        for i, (s, p) in enumerate(zip(src_rows, pg_rows)):
            for j, (pg_col, sq_col, kind) in enumerate(cols):
                a = sq_render(s[sq_col], kind)
                b = p[j]
                if a != b:
                    diffs += 1
                    overall_ok = False
                    if diffs <= 10:
                        print(f"  DIFF row id={s['id']} col={pg_col} "
                              f"sqlite={a!r} postgres={b!r}")
        cells = len(src_rows) * len(cols)
        print(f"  cells compared={cells}  differing={diffs}  "
              f"{'ALL IDENTICAL' if diffs == 0 else '*** SEE ABOVE ***'}")

    con.close()
    print("\n" + ("VERIFICATION PASSED" if overall_ok else "VERIFICATION FAILED"))
    sys.exit(0 if overall_ok else 1)


main()
