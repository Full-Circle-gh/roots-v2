#!/usr/bin/env python3
"""
Verify tenants -> accounts by rendering the Postgres row BACK into the SQLite
representation and comparing every cell. SQLite is opened read-only.

The two base64 brand columns are compared by length AND sha256 of the UTF-8
bytes, so a one-character truncation is caught.
"""
import sqlite3
import subprocess
import hashlib
import sys

SRC = "file:/root/roots-v2/data/roots.db?mode=ro"
NULL = "\\N"

# (column, kind)
COLS = [
    ("id", "int"), ("name", "text"), ("brand_name", "text"), ("status", "text"),
    ("created_at", "ts"), ("brand_accent", "text"), ("wx_appid", "text"),
    ("product_catalog_mode", "text"), ("onboarding_model", "text"),
    ("business_category", "text"), ("setup_fee_cents", "int"),
    ("features_json", "text"), ("commission_rate_bps", "int"),
    ("rbac_enforce", "bool"), ("brand_logo_data", "big"),
    ("brand_mark_data", "big"), ("brand_credit", "bool"),
    ("brand_updated_at", "ts"),
]


def esc(s):
    return (s.replace("\\", "\\\\").replace("\t", "\\t")
             .replace("\n", "\\n").replace("\r", "\\r"))


def sq_render(v, kind):
    if v is None:
        return NULL
    if kind in ("int", "bool"):
        return str(int(v))
    if kind == "big":
        b = str(v).encode("utf-8")
        return (f"len={len(str(v))} bytes={len(b)} "
                f"sha256={hashlib.sha256(b).hexdigest()}")
    return esc(str(v))


def pg_expr(col, kind):
    c = f'"{col}"'
    if kind == "bool":
        return f"CASE WHEN {c} IS NULL THEN NULL WHEN {c} THEN '1' ELSE '0' END"
    if kind == "ts":
        return f"to_char({c} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')"
    if kind == "big":
        return ("CASE WHEN {c} IS NULL THEN NULL ELSE 'len='||length({c})"
                "||' bytes='||octet_length({c})"
                "||' sha256='||encode(sha256(convert_to({c},'UTF8')),'hex') END"
                ).format(c=c)
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


con = sqlite3.connect(SRC, uri=True)
con.row_factory = sqlite3.Row
try:
    con.execute("CREATE TABLE __probe__ (x)")
    print("FATAL: SQLite accepted a write")
    sys.exit(2)
except sqlite3.OperationalError as e:
    print(f"read-only probe OK (write rejected: {e})\n")

names = ", ".join(f'"{c}"' for c, _ in COLS)
src = con.execute(f"SELECT {names} FROM tenants ORDER BY id").fetchall()
exprs = ", ".join(f"coalesce({pg_expr(c, k)}, '{NULL}')" for c, k in COLS)
tgt = [ln.split("\t") for ln in psql(f"SELECT {exprs} FROM accounts ORDER BY id").split("\n") if ln]

print(f"rows  sqlite={len(src)}  postgres={len(tgt)}  "
      f"{'MATCH' if len(src) == len(tgt) else '*** MISMATCH ***'}\n")
if len(src) != len(tgt):
    sys.exit(1)

diffs = 0
print(f"{'column':22} {'SQLite (source)':46} {'Postgres (round-tripped)':46} ok")
print("-" * 120)
for i, (c, k) in enumerate(COLS):
    a = sq_render(src[0][c], k)
    b = tgt[0][i]
    ok = (a == b)
    if not ok:
        diffs += 1
    sa, sb = a, b
    if k == "big":                      # keep the table readable
        sa = a.replace("sha256=", "sha=")[:46]
        sb = b.replace("sha256=", "sha=")[:46]
    print(f"{c:22} {sa[:46]:46} {sb[:46]:46} {'OK' if ok else '**DIFF**'}")

print("-" * 120)
print(f"cells compared={len(COLS)}  differing={diffs}")

# full-precision hashes for the two payload columns
print("\nfull hashes for the base64 columns:")
for c in ("brand_logo_data", "brand_mark_data"):
    k = dict(COLS)[c]
    print(f"  {c}\n    sqlite  : {sq_render(src[0][c], k)}\n"
          f"    postgres: {tgt[0][[x for x, _ in COLS].index(c)]}")

con.close()
print("\n" + ("VERIFICATION PASSED" if diffs == 0 else "VERIFICATION FAILED"))
sys.exit(0 if diffs == 0 else 1)
