#!/usr/bin/env python3
"""Full census of the non-conforming values, so nothing is decided from a sample."""
import sqlite3, json, re, os
from collections import Counter, defaultdict

SRC = "file:/root/roots-v2/data/roots.db?mode=ro"
HERE = os.path.dirname(os.path.abspath(__file__))
plan = json.load(open(os.path.join(HERE, "plan.json"), encoding="utf-8"))
con = sqlite3.connect(SRC, uri=True)
con.row_factory = sqlite3.Row

NAIVE = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")


def shape(v):
    """Reduce a value to its format shape so distinct formats can be counted."""
    if v is None:
        return "NULL"
    if isinstance(v, int):
        return "INT(epoch?)"
    if isinstance(v, float):
        return "FLOAT"
    if not isinstance(v, str):
        return type(v).__name__
    s = re.sub(r"\d", "9", v)
    return s


print("=== 1. TIMESTAMP FORMAT CENSUS (all 312 DATETIME->timestamptz columns) ===")
tsshapes = Counter()
percol = defaultdict(Counter)
for st, spec in sorted(plan["tables"].items()):
    if spec["rows"] == 0:
        continue
    ts = [c["sq"] for c in spec["cols"] if c["cls"] == "TS"]
    if not ts:
        continue
    sel = ", ".join(f'"{c}"' for c in ts)
    for r in con.execute(f'SELECT {sel} FROM "{st}"'):
        for c in ts:
            v = r[c]
            if v is None:
                continue
            if isinstance(v, str) and NAIVE.match(v):
                tsshapes["9999-99-99 99:99:99  (naive, the proven rule)"] += 1
                continue
            sh = shape(v)
            tsshapes[sh] += 1
            percol[sh][f"{st}.{c}"] += 1
for sh, n in tsshapes.most_common():
    print(f"{n:>8}  {sh}")
    if not sh.startswith("9999-99-99 99:99:99 "):
        for col, cn in percol[sh].most_common():
            print(f"           {cn:>6}  {col}")

print("\n=== 2. DATE FORMAT CENSUS (15 DATE->date columns) ===")
dshapes = Counter()
for st, spec in sorted(plan["tables"].items()):
    if spec["rows"] == 0:
        continue
    ds = [c["sq"] for c in spec["cols"] if c["cls"] == "DATE"]
    if not ds:
        continue
    sel = ", ".join(f'"{c}"' for c in ds)
    for r in con.execute(f'SELECT {sel} FROM "{st}"'):
        for c in ds:
            if r[c] is not None:
                dshapes[shape(r[c])] += 1
for sh, n in dshapes.most_common():
    print(f"{n:>8}  {sh}")

print("\n=== 3. NON-NUMERIC VALUES IN products.weight / store_products.weight ===")
for t in ("products", "store_products"):
    vals = Counter()
    for (v,) in con.execute(f'SELECT weight FROM "{t}"'):
        if v is None:
            vals["<NULL>"] += 1
        elif isinstance(v, (int, float)):
            vals["<numeric>"] += 1
        else:
            vals[v] += 1
    print(f"  {t}.weight — {len(vals)} distinct")
    for v, n in vals.most_common(60):
        print(f"      {n:>4}  {v!r}")

print("\n=== 4. packaging_types / recipe_cost_data.packaging_type_id ===")
for r in con.execute("SELECT * FROM packaging_types"):
    print("  packaging_types row:", {k: (str(r[k])[:50]) for k in r.keys()})
print("  packaging_types.id sqlite decl type:",
      [c["type"] for c in con.execute('PRAGMA table_info("packaging_types")') if c[1] == "id"])
print("  PG packaging_types.id type:",
      [c["pgtype"] for c in plan["tables"]["packaging_types"]["cols"] if c["sq"] == "id"])
print("  PG recipe_cost_data.packaging_type_id type:",
      [c["pgtype"] for c in plan["tables"]["recipe_cost_data"]["cols"] if c["sq"] == "packaging_type_id"])
for r in con.execute("SELECT id, packaging_type_id FROM recipe_cost_data"):
    print("  recipe_cost_data:", dict(r))

print("\n=== 5. storefront_config.updated_by ===")
for v, n in con.execute("SELECT updated_by, COUNT(*) FROM storefront_config GROUP BY updated_by ORDER BY 2 DESC"):
    print(f"      {n:>4}  {v!r}")
print("  PG type:", [c["pgtype"] for c in plan["tables"]["storefront_config"]["cols"] if c["sq"] == "updated_by"])
print("  has FK to users?:",
      [f for f in plan["fkeys"] if f["table"] == "storefront_config"])

print("\n=== 6. store_products id 104 epoch value ===")
import datetime
r = con.execute("SELECT id, name, updated_at, created_at FROM store_products WHERE id=104").fetchone()
print("  row:", dict(r))
e = int(r["updated_at"])
print(f"  {e} as unix seconds UTC = {datetime.datetime.utcfromtimestamp(e):%Y-%m-%d %H:%M:%S}")
print(f"  {e} as unix millis UTC  = {datetime.datetime.utcfromtimestamp(e/1000):%Y-%m-%d %H:%M:%S}")

print("\n=== 7. text columns holding numbers (SQLite dynamic typing into PG text) ===")
# already scanned; recount cleanly
print("  (see preflight NUMBER_IN_TEXT — none reported)")

con.close()
