#!/usr/bin/env python3
import sqlite3, json, os
HERE = os.path.dirname(os.path.abspath(__file__))
con = sqlite3.connect("file:/root/roots-v2/data/roots.db?mode=ro", uri=True)
plan = json.load(open(os.path.join(HERE, "plan.json"), encoding="utf-8"))

tot = 0
big = []
for st, spec in plan["tables"].items():
    if spec["rows"] == 0:
        continue
    expr = " + ".join(f'COALESCE(LENGTH(CAST("{c["sq"]}" AS BLOB)),0)' for c in spec["cols"])
    n = con.execute(f'SELECT SUM({expr}) FROM "{st}"').fetchone()[0] or 0
    tot += n
    big.append((n, st, spec["rows"]))
big.sort(reverse=True)
print(f"total source bytes across mapped columns: {tot/1e6:.1f} MB")
for n, t, r in big[:15]:
    print(f"  {n/1e6:>8.2f} MB  {t:<30} rows={r}")

print("\n=== widest text values (base64 suspects, max length > 50k chars) ===")
# COLUMNS COME FROM THE LIVE SCHEMA, NOT FROM plan.json's cols[].
#
# wide_cols.json is an INPUT to checks.py (verdict 3, the SHA-256 comparison)
# and to verify.py. Built from the census's column list it could never name a
# column added since the census -- so a new base64 column would be copied and
# then never hashed, and verdict 3 would report
#   all wide columns byte-identical: True
# without having looked at it. That is the same class as the eleven columns
# found on 2026-08-21, and the same shape as the verifier sharing the copier's
# map: an instrument whose scope is defined by the thing it is auditing.
#
# READING THE LIVE SCHEMA HERE RATHER THAN HAVING drift_guard REFUSE. This file
# already reads live DATA for every length below, so live column NAMES add no
# new source and no new epoch -- it becomes correct by construction. A guard
# would only tell you to come and fix this line, and would leave a second
# artefact to keep in step with the first.
#
# The cls == "TEXT" filter goes with it. LENGTH() is defined on every storage
# class, and the 50k threshold is what actually selects the base64 columns:
# no integer has ever been fifty thousand characters wide.
wide = []
for st in [r[0] for r in con.execute(
        "select name from sqlite_master where type='table' order by name")]:
    if st.startswith("sqlite_"):
        continue
    for cname in [r[1] for r in con.execute(f'PRAGMA table_info("{st}")')]:
        m = con.execute(
            f'SELECT MAX(LENGTH("{cname}")) FROM "{st}"').fetchone()[0] or 0
        if m > 50000:
            wide.append((m, st, cname))
wide.sort(reverse=True)
for m, t, c in wide:
    print(f"  {m:>9} chars  {t}.{c}")
json.dump([[t, c] for _, t, c in wide], open(os.path.join(HERE, "wide_cols.json"), "w"))

print("\n=== rows containing embedded newlines in any text column ===")
nl = []
for st, spec in plan["tables"].items():
    if spec["rows"] == 0:
        continue
    tcols = [c["sq"] for c in spec["cols"] if c["cls"] == "TEXT"]
    if not tcols:
        continue
    cond = " OR ".join(f"\"{c}\" LIKE '%' || char(10) || '%'" for c in tcols)
    n = con.execute(f'SELECT COUNT(*) FROM "{st}" WHERE {cond}').fetchone()[0]
    if n:
        nl.append((n, st))
nl.sort(reverse=True)
for n, t in nl:
    print(f"  {n:>6} rows  {t}")

print("\n=== rows containing CJK characters ===")
cjk = []
for st, spec in plan["tables"].items():
    if spec["rows"] == 0:
        continue
    tcols = [c["sq"] for c in spec["cols"] if c["cls"] == "TEXT"]
    if not tcols:
        continue
    cond = " OR ".join(
        f"(\"{c}\" IS NOT NULL AND \"{c}\" GLOB '*[一-鿿]*')" for c in tcols)
    try:
        n = con.execute(f'SELECT COUNT(*) FROM "{st}" WHERE {cond}').fetchone()[0]
    except Exception as e:
        n = -1
    if n:
        cjk.append((n, st))
cjk.sort(reverse=True)
for n, t in cjk[:25]:
    print(f"  {n:>6} rows  {t}")
