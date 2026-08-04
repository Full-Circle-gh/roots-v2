#!/usr/bin/env python3
"""Relative error of the sub-cent roundings — a per-unit cost of 0.005 becoming
0.01 is a 100% error even though the absolute loss is half a cent."""
import sqlite3, json, os
from decimal import Decimal, ROUND_HALF_UP

HERE = os.path.dirname(os.path.abspath(__file__))
con = sqlite3.connect("file:/root/roots-v2/data/roots.db?mode=ro", uri=True)
plan = json.load(open(os.path.join(HERE, "plan.json"), encoding="utf-8"))

g = []
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
            x = float(v) * 100.0
            if abs(x - round(x)) >= 1e-6:
                cents = int((Decimal(str(v)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
                rel = abs(x - cents) / abs(x) if x else 0
                g.append((rel, st, c, r[0], v, cents))

g.sort(reverse=True)
print(f"{len(g)} genuine sub-cent values")
print("\nworst 20 by RELATIVE error:")
for rel, st, c, k, v, cents in g[:20]:
    print(f"   {rel*100:>6.1f}%  {st}.{c} id={k}  {v!r} -> {cents/100:.2f} yuan")
buckets = {">10%": 0, "1-10%": 0, "0.1-1%": 0, "<0.1%": 0}
for rel, *_ in g:
    if rel > 0.10: buckets[">10%"] += 1
    elif rel > 0.01: buckets["1-10%"] += 1
    elif rel > 0.001: buckets["0.1-1%"] += 1
    else: buckets["<0.1%"] += 1
print("\nrelative error distribution:")
for k, v in buckets.items():
    print(f"   {v:>5}  {k}")
