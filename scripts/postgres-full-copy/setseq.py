#!/usr/bin/env python3
"""
Advance every identity sequence past the copied data.

The value comes from SQLite's AUTOINCREMENT high-water mark (sqlite_sequence)
where the table has one, not from max(id). That is what the rehearsal did for
accounts, and it matters: accounts holds one row at id 1 but its high-water is 7,
because ids 2-7 were burned by the deleted test accounts. Using max(id) would
hand id 2 to the next real account, and id 2 appears in older backups and logs as
a test tenant.

Where SQLite has no high-water mark the sequence is set from max(id) in Postgres.
Where the table is empty and never had one, the sequence is left untouched.
"""
import sqlite3, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
plan = json.load(open(os.path.join(HERE, "plan.json"), encoding="utf-8"))


def psql(sql):
    p = subprocess.run(["sudo", "-u", "postgres", "psql", "-d", "tacet", "-tA",
                        "-v", "ON_ERROR_STOP=1", "-c", sql], capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"psql failed:\n{p.stderr}")
    return p.stdout


con = sqlite3.connect("file:/root/roots-v2/data/roots.db?mode=ro", uri=True)
try:
    con.execute("CREATE TABLE __probe__ (x)")
    raise SystemExit("FATAL: SQLite accepted a write")
except sqlite3.OperationalError:
    pass
hi = dict(con.execute("SELECT name, seq FROM sqlite_sequence"))
con.close()


def snapshot():
    d = {}
    for line in psql("select sequencename || '\t' || coalesce(last_value::text,'NEVER_CALLED') "
                     "from pg_sequences where schemaname='public' order by sequencename;").splitlines():
        if "\t" in line:
            k, v = line.split("\t", 1)
            d[k] = v
    return d


before = snapshot()
rows = []
for st, spec in plan["tables"].items():
    ident = [c for c in spec["cols"] if c["identity"]]
    if not ident:
        continue
    pt, col = spec["pg"], ident[0]["pg"]
    seq = psql(f"select pg_get_serial_sequence('{pt}','{col}');").strip()
    if not seq:
        rows.append((pt, col, None, "NO SEQUENCE", None))
        continue
    src = hi.get(st)
    how = "sqlite_sequence"
    if src is None:
        mx = psql(f'select coalesce(max("{col}"),0) from "{pt}";').strip()
        src = int(mx)
        how = "max(id)"
    if src and int(src) > 0:
        psql(f"select setval('{seq}', {int(src)}, true);")
    else:
        how = "left untouched (empty, no high-water)"
    rows.append((pt, col, seq.split(".")[-1], how, src))

after = snapshot()
json.dump({"before": before, "after": after,
           "rows": [[r[0], r[1], r[2], r[3], r[4]] for r in rows]},
          open(os.path.join(HERE, "sequences.json"), "w"), indent=1)

changed = [k for k in after if before.get(k) != after[k]]
print(f"identity sequences handled: {len(rows)}")
print(f"sequences whose value changed: {len(changed)}")
print(f"still NEVER_CALLED after: {sum(1 for v in after.values() if v == 'NEVER_CALLED')}")
print("\nsource of each value:")
from collections import Counter
for k, v in Counter(r[3] for r in rows).most_common():
    print(f"  {v:>4}  {k}")
print("\nsequences where the high-water mark is ahead of max(id) (burned ids preserved):")
for pt, col, seq, how, src in rows:
    if how != "sqlite_sequence" or src is None:
        continue
    mx = psql(f'select coalesce(max("{col}"),0) from "{pt}";').strip()
    if int(mx) != int(src):
        print(f"  {pt}.{col}: max(id)={mx} but sequence set to {src}")
