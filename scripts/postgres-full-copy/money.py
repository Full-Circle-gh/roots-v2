#!/usr/bin/env python3
"""Is REAL yuan -> integer cents lossless? Any value with more than 2 decimal places
cannot be recovered, so the round-trip verification would fail on it."""
import sqlite3, json, os
from decimal import Decimal

HERE = os.path.dirname(os.path.abspath(__file__))
con = sqlite3.connect("file:/root/roots-v2/data/roots.db?mode=ro", uri=True)
plan = json.load(open(os.path.join(HERE, "plan.json"), encoding="utf-8"))

lossy = []
checked = 0
cols_checked = 0
for st, spec in sorted(plan["tables"].items()):
    if spec["rows"] == 0:
        continue
    cc = [c["sq"] for c in spec["cols"] if c["cls"] == "CENTS"]
    if not cc:
        continue
    cols_checked += len(cc)
    sel = ", ".join(f'"{c}"' for c in cc)
    idc = "id" if any(c["sq"] == "id" for c in spec["cols"]) else "rowid"
    for r in con.execute(f'SELECT {idc} AS k, {sel} FROM "{st}"'):
        for c in cc:
            v = r[c] if not isinstance(r, tuple) else None
            v = r[cc.index(c) + 1]
            if v is None:
                continue
            checked += 1
            d = Decimal(str(v))
            if d != d.quantize(Decimal("0.01")):
                lossy.append((st, c, r[0], v))

print(f"checked {checked} money values across {cols_checked} REAL->cents columns")
print(f"values with more than 2 decimal places: {len(lossy)}")
for x in lossy[:40]:
    print(f"   {x[0]}.{x[1]} id={x[2]} value={x[3]!r}")
if len(lossy) > 40:
    print(f"   ... and {len(lossy)-40} more")

# group by column
from collections import Counter
if lossy:
    print("\nby column:")
    for (t, c), n in Counter((x[0], x[1]) for x in lossy).most_common():
        print(f"   {n:>6}  {t}.{c}")
