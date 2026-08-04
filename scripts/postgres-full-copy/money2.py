#!/usr/bin/env python3
"""Split the >2dp money values into float-representation artifacts (harmless,
round cleanly) and genuine sub-cent amounts (rounding loses real data)."""
import sqlite3, json, os
from collections import Counter
from decimal import Decimal, ROUND_HALF_UP

HERE = os.path.dirname(os.path.abspath(__file__))
con = sqlite3.connect("file:/root/roots-v2/data/roots.db?mode=ro", uri=True)
plan = json.load(open(os.path.join(HERE, "plan.json"), encoding="utf-8"))

artifacts = 0
genuine = []
checked = 0
for st, spec in sorted(plan["tables"].items()):
    if spec["rows"] == 0:
        continue
    cc = [c["sq"] for c in spec["cols"] if c["cls"] == "CENTS"]
    if not cc:
        continue
    sel = ", ".join(f'"{c}"' for c in cc)
    idc = "id" if any(c["sq"] == "id" for c in spec["cols"]) else "rowid"
    for r in con.execute(f'SELECT {idc} AS k, {sel} FROM "{st}"'):
        for i, c in enumerate(cc):
            v = r[i + 1]
            if v is None:
                continue
            checked += 1
            x = float(v) * 100.0
            if abs(x - round(x)) < 1e-6:
                d = Decimal(str(v))
                if d != d.quantize(Decimal("0.01")):
                    artifacts += 1
            else:
                cents = int((Decimal(str(v)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
                genuine.append((st, c, r[0], v, cents))

print(f"checked {checked} money values")
print(f"float-representation artifacts (round cleanly to cents, no data lost): {artifacts}")
print(f"GENUINE sub-cent values (rounding changes the amount):                 {len(genuine)}")
print()
print("by column:")
for (t, c), n in Counter((x[0], x[1]) for x in genuine).most_common():
    print(f"   {n:>6}  {t}.{c}")
print()
print("worst 25 by amount lost:")
for x in sorted(genuine, key=lambda y: -abs(float(y[3]) * 100 - y[4]))[:25]:
    lost = float(x[3]) * 100 - x[4]
    print(f"   {x[0]}.{x[1]} id={x[2]}  {x[3]!r} yuan -> {x[4]} cents  (drops {lost:+.4f} cents)")
tot = sum(abs(float(x[3]) * 100 - x[4]) for x in genuine)
print(f"\ntotal absolute rounding across all genuine values: {tot:.4f} cents = {tot/100:.6f} yuan")
