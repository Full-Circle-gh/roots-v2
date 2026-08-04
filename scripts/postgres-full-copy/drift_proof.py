#!/usr/bin/env python3
"""
Prove the residual differences are live drift rather than copy errors, two ways:

 1. Re-count the Chinese characters in the four mismatching columns with the two
    rows that moved excluded. If the counts then agree exactly, the only Chinese
    that differs is Chinese the source gained after the copy read it.
 2. Compare verification pass 1 against pass 2. A copy error is a fixed value and
    reports identically both times. Drift moves: the same cell differs again, but
    against a different source value.
"""
import sqlite3, json, os, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
con = sqlite3.connect("file:/root/roots-v2/data/roots.db?mode=ro", uri=True)


def psql(sql):
    p = subprocess.run(["sudo", "-u", "postgres", "psql", "-d", "tacet", "-tA",
                        "-v", "ON_ERROR_STOP=1", "-c", sql], capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(p.stderr)
    return p.stdout.strip()


print("=== 1. Chinese characters, excluding the two rows that moved ===")
CASES = [("retail_orders", "tracking_events_json", "id", 911),
         ("retail_orders", "tracking_scenario_data_json", "id", 911),
         ("retail_shipments", "tracking_events_json", "id", 878),
         ("retail_shipments", "tracking_scenario_data_json", "id", 878)]
tot_s = tot_p = 0
for t, c, pk, skip in CASES:
    s = 0
    for (v,) in con.execute(f'SELECT "{c}" FROM "{t}" WHERE "{c}" IS NOT NULL AND "{pk}" <> ?', (skip,)):
        s += sum(1 for ch in str(v) if "一" <= ch <= "鿿")
    p = int(psql(f"""select coalesce(sum(length(regexp_replace("{c}", '[^一-鿿]', '', 'g'))),0)
                     from "{t}" where "{c}" is not null and "{pk}" <> {skip};"""))
    tot_s += s
    tot_p += p
    print(f"  {t}.{c:<28} sqlite={s:<8} postgres={p:<8} {'OK' if s == p else '*** DIFF ***'}")
print(f"  totals excluding the drifted rows: sqlite={tot_s} postgres={tot_p} "
      f"{'MATCH' if tot_s == tot_p else 'MISMATCH'}")

print("\n=== 2. pass 1 vs pass 2 ===")
p1 = json.load(open(os.path.join(HERE, "verify_pass1.json"), encoding="utf-8"))
p2 = json.load(open(os.path.join(HERE, "verify_pass2.json"), encoding="utf-8"))
print(f"  pass 1: {p1['cells']} cells, {p1['diffs']} differences across {len(p1['detail'])} tables")
print(f"  pass 2: {p2['cells']} cells, {p2['diffs']} differences across {len(p2['detail'])} tables")
t1, t2 = set(p1["detail"]), set(p2["detail"])
print(f"  tables differing in both passes: {sorted(t1 & t2)}")
print(f"  tables differing in only one pass: {sorted(t1 ^ t2)}")
print("\n  cells that reported a DIFFERENT source value the second time (i.e. still moving):")
moved = 0
for t in sorted(t1 & t2):
    a = {d.split(":")[0]: d for d in p1["detail"][t]}
    b = {d.split(":")[0]: d for d in p2["detail"][t]}
    for k in a:
        if k in b and a[k] != b[k]:
            moved += 1
            if moved <= 8:
                print(f"    {t} {k[:80]}")
print(f"  total: {moved}")
con.close()
