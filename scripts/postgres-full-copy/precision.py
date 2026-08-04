#!/usr/bin/env python3
"""
1. Confirm store_products id 104 now holds the corrected timestamp.
2. Work out how many decimal places the nine unit-cost columns actually need,
   separating genuine precision from binary-float noise, so the target scale is
   chosen from the data rather than picked.
"""
import sqlite3
from decimal import Decimal

con = sqlite3.connect("file:/root/roots-v2/data/roots.db?mode=ro", uri=True)
try:
    con.execute("CREATE TABLE __probe__ (x)")
    raise SystemExit("FATAL: SQLite accepted a write")
except sqlite3.OperationalError as e:
    print(f"read-only probe OK ({e})\n")

print("=== 1. store_products id 104 ===")
r = con.execute("SELECT id, name_en, updated_at, typeof(updated_at) FROM store_products WHERE id=104").fetchone()
print(f"  id={r[0]}  name={r[1]!r}")
print(f"  updated_at = {r[2]!r}   (sqlite storage class: {r[3]})")
print("  STATUS:", "CORRECTED" if r[3] == "text" and str(r[2]) == "2026-06-18 04:33:53"
      else "*** STILL WRONG — STOP ***")

print("\n=== 2. decimal places genuinely needed by the nine unit-cost columns ===")
COLS = [("ingredients", "cost_per_unit"), ("ingredients", "buy_price"),
        ("ingredient_price_history", "price"), ("price_alerts", "new_price"),
        ("price_alerts", "old_price"), ("po_line_items", "cost_per_unit"),
        ("po_line_items", "total_cost"), ("expense_entries", "amount"),
        ("waste_entries", "cost_lost")]

worst_scale = 0
worst_ex = None
biggest = 0.0
need = {}
for t, c in COLS:
    mx = 0
    for (v,) in con.execute(f'SELECT "{c}" FROM "{t}" WHERE "{c}" IS NOT NULL'):
        av = abs(float(v))
        biggest = max(biggest, av)
        # smallest scale s (0..12) at which rounding is a pure float artifact
        for s in range(0, 13):
            q = Decimal(str(v)).quantize(Decimal(1).scaleb(-s))
            if abs(float(q) - float(v)) <= abs(float(v)) * 1e-12 + 1e-15:
                break
        if s > mx:
            mx = s
        if s > worst_scale:
            worst_scale, worst_ex = s, (t, c, v)
    need[(t, c)] = mx
    print(f"  {t}.{c:<14} needs {mx} decimal places")

print(f"\n  worst column scale required: {worst_scale}  e.g. {worst_ex}")
print(f"  largest absolute value in these columns: {biggest}")

print("\n=== how many values change if the target scale is 6 ===")
changed = 0
total = 0
genuine_loss = []
for t, c in COLS:
    for (v,) in con.execute(f'SELECT "{c}" FROM "{t}" WHERE "{c}" IS NOT NULL'):
        total += 1
        d = Decimal(str(v))
        q = d.quantize(Decimal("0.000001"))
        if q != d:
            changed += 1
            if abs(float(q) - float(v)) > abs(float(v)) * 1e-12 + 1e-15:
                genuine_loss.append((t, c, v))
print(f"  {total} values; {changed} differ from their source text at scale 6")
print(f"  of those, genuinely losing precision (not float noise): {len(genuine_loss)}")
for x in genuine_loss[:20]:
    print("   ", x)
