#!/usr/bin/env python3
"""Build a synthetic SQLite fixture with the same 101-money-column shape as the
live database, holding values whose correct answers are known by construction.
Used only to prove money_scale_census.py before it is run against live data.
Touches nothing real."""
import json, os, sqlite3, sys

HERE = os.path.dirname(os.path.abspath(__file__))
_SIBLING = os.path.normpath(os.path.join(HERE, os.pardir, "postgres-full-copy", "plan.json"))
DEFAULT_PLAN = _SIBLING if os.path.exists(_SIBLING) else os.path.join(HERE, "plan.json")
PLAN = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PLAN
if not os.path.exists(PLAN):
    sys.exit(f"no copy plan at {PLAN} — pass one as the first argument")
OUT = os.path.join(HERE, "fixture.db")
if os.path.exists(OUT):
    os.remove(OUT)

plan = json.load(open(PLAN, encoding="utf-8"))
con = sqlite3.connect(OUT)

# value -> (expected genuine scale, expected raw scale)
CASES = [
    (40.0,                0, 0),   # whole yuan
    (12.5,                1, 1),   # one place
    (-13.87,              2, 2),   # negative, two places
    (0.1 + 0.2,           1, 17),  # float noise: means 0.3, stores 0.30000000000000004
    (0.005,               3, 3),   # genuine half-cent
    (0.0037,              4, 4),   # genuine sub-cent unit cost
    (0.000125,            6, 6),   # six places
    (99999999.99,         2, 2),   # 8 integer digits
    (None,             None, None),
]
DEEP = {"ingredients.cost_per_unit": 0.0037,
        "po_line_items.cost_per_unit": 0.000125}

made = 0
for t, spec in sorted(plan["tables"].items()):
    money = [c["sq"] for c in spec["cols"] if c["cls"] in ("CENTS", "NUM6")]
    if not money:
        continue
    cols = ", ".join(f'"{c}" REAL' for c in money)
    con.execute(f'CREATE TABLE "{t}" (id INTEGER PRIMARY KEY, {cols})')
    ph = ", ".join("?" for _ in money)
    for v, _gs, _rs in CASES:
        con.execute(f'INSERT INTO "{t}" ({", ".join(chr(34)+c+chr(34) for c in money)}) '
                    f'VALUES ({ph})', [v] * len(money))
    made += len(money)
# one extra deep value in two named columns, to check the deepest-example picker
con.execute('INSERT INTO ingredients (cost_per_unit, buy_price) VALUES (?, ?)', (0.0037, 1.0))
con.commit()
con.close()
print(f"fixture: {OUT}  ({made} money columns)")
print("expected per column: max genuine scale 6, max raw scale 17, max_abs 99999999.99,")
print("                     8 integer digits, 3 values genuinely over 2dp per column")
