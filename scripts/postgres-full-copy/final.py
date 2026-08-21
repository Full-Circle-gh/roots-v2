#!/usr/bin/env python3
"""Final accounting: source drift during the run, and the sequence report."""
import sqlite3, json, os, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
plan = json.load(open(os.path.join(HERE, "plan.json"), encoding="utf-8"))
before = json.load(open(os.path.join(HERE, "counts_before.json"), encoding="utf-8"))
seqs = json.load(open(os.path.join(HERE, "sequences.json"), encoding="utf-8"))


def psql(sql):
    p = subprocess.run(["sudo", "-u", "postgres", "psql", "-d", "tacet", "-tA",
                        "-v", "ON_ERROR_STOP=1", "-c", sql], capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(p.stderr)
    return p.stdout.strip()


con = sqlite3.connect("file:/root/roots-v2/data/roots.db?mode=ro", uri=True)

print("=== row counts: source at copy time vs Postgres now vs source now ===")
pg_now = {}
for line in psql("select relname || '|' || n_live_tup from pg_stat_user_tables;").splitlines():
    k, v = line.split("|")
    pg_now[k] = int(v)

drifted, copied_total, pg_total = [], 0, 0
mismatch = []
for st, spec in plan["tables"].items():
    if before.get(st, 0) == 0:
        continue
    pt = spec["pg"]
    at_copy = before[st]
    now = con.execute(f'SELECT COUNT(*) FROM "{st}"').fetchone()[0]
    in_pg = int(psql(f'select count(*) from "{pt}";'))
    copied_total += at_copy
    pg_total += in_pg
    if in_pg != at_copy:
        mismatch.append((pt, at_copy, in_pg))
    if now != at_copy:
        drifted.append((st, at_copy, now, now - at_copy))

print(f"  tables copied: {sum(1 for st in plan['tables'] if before.get(st,0)>0)}")
print(f"  rows in source at copy time: {copied_total}")
print(f"  rows in Postgres now:        {pg_total}")
print(f"  tables where Postgres != the count copied against: {len(mismatch)}")
for m in mismatch:
    print("   ", m)

print(f"\n=== tables whose SOURCE changed during/after the run: {len(drifted)} ===")
for st, a, b, d in sorted(drifted, key=lambda x: -abs(x[3])):
    print(f"  {st:<28} at copy={a:<8} now={b:<8} {d:+d}")
print(f"  total source rows added since the copy: {sum(d for _,_,_,d in drifted):+d}")

print("\n=== sequences ===")
rows = seqs["rows"]
after = seqs["after"]
print(f"  identity sequences: {len(rows)}")
print("\n  the five that carried a value before this run (true pre-migration state):")
# Postgres sequence names. `accounts_id_seq` became `tenants_id_seq` with
# the 2026-08-21 rename; a stale key here resolves to None and prints as
# blank rather than as a mismatch, which reads like a pass.
PRE = {"tenants_id_seq": "7", "invoices_id_seq": "22", "purchase_orders_id_seq": "69",
       "suppliers_id_seq": "214", "users_id_seq": "8"}
for k, v in PRE.items():
    print(f"    {k:<32} before={v:<8} after={after.get(k)}")
print("\n  every other sequence was NEVER_CALLED before; after the run:")
print(f"    set from the SQLite AUTOINCREMENT high-water mark: "
      f"{sum(1 for r in rows if r[3]=='sqlite_sequence')}")
print(f"    set from max(id):                                 "
      f"{sum(1 for r in rows if r[3]=='max(id)')}")
print(f"    left NEVER_CALLED (empty table, no high-water):    "
      f"{sum(1 for v in after.values() if v=='NEVER_CALLED')}")

print("\n  full sequence table (name, before, after):")
for r in sorted(rows, key=lambda x: x[0]):
    pt, col, seq, how, val = r
    if not seq:
        continue
    b = PRE.get(seq, "NEVER_CALLED")
    print(f"    {seq:<40} {b:<14} -> {after.get(seq)}")
con.close()
