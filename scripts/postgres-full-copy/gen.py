#!/usr/bin/env python3
"""
Generate Postgres INSERT SQL for one or more tables from the live SQLite database.

READ-ONLY on SQLite (uri mode=ro, proven by a rejected write). Writes .sql files
only; connects to nothing. Halts on any value that does not fit the agreed rules
rather than guessing.

Usage: gen.py <sqlite_table> [<sqlite_table> ...]
"""
import sqlite3, json, os, sys, re
from decimal import Decimal, ROUND_HALF_UP
import overrides

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "sql")
plan = json.load(open(os.path.join(HERE, "plan.json"), encoding="utf-8"))
SRC = "file:/root/roots-v2/data/roots.db?mode=ro"

NAIVE = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SIX = Decimal("0.000001")

problems = []


def halt(msg):
    problems.append(msg)


def q_text(v, col):
    if v is None:
        return "NULL"
    if isinstance(v, bytes):
        halt(f"{col}: BLOB where TEXT expected")
        return "NULL"
    s = str(v)
    if "\x00" in s:
        halt(f"{col}: NUL byte, not representable in Postgres text")
        return "NULL"
    # standard_conforming_strings is on: only the quote doubles. Newlines,
    # backslashes and CJK pass through a quoted literal untouched.
    return "'" + s.replace("'", "''") + "'"


def q_int(v, col):
    if v is None:
        return "NULL"
    if isinstance(v, (str, bytes)):
        halt(f"{col}: text value {v!r} in an integer column")
        return "NULL"
    if isinstance(v, float) and not v.is_integer():
        halt(f"{col}: non-integer {v!r} in an integer column")
        return "NULL"
    return str(int(v))


def q_bool(v, col):
    if v is None:
        return "NULL"
    if v in (0, 1):
        return "true" if v == 1 else "false"
    halt(f"{col}: boolean-target value {v!r} is not 0/1")
    return "NULL"


def q_cents(v, col):
    """Transaction money: REAL yuan -> whole cents."""
    if v is None:
        return "NULL"
    if not isinstance(v, (int, float)):
        halt(f"{col}: non-numeric {v!r} in a money column")
        return "NULL"
    d = Decimal(str(v)) * 100
    r = d.quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    if abs(d - r) > Decimal("0.000001"):
        halt(f"{col}: {v!r} yuan does not fit whole cents (would round to {r})")
        return "NULL"
    return str(int(r))


def q_num6(v, col):
    """Unit costs: REAL yuan -> exact decimal yuan at scale 6."""
    if v is None:
        return "NULL"
    if not isinstance(v, (int, float)):
        halt(f"{col}: non-numeric {v!r} in a unit-cost column")
        return "NULL"
    return str(Decimal(str(v)).quantize(SIX, rounding=ROUND_HALF_UP))


def q_real(v, col):
    if v is None:
        return "NULL"
    if not isinstance(v, (int, float)):
        halt(f"{col}: non-numeric {v!r} in a float column")
        return "NULL"
    return repr(float(v))


def q_ts(v, col):
    if v is None:
        return "NULL"
    s = str(v).strip()
    if NAIVE.match(s):
        return "'" + s + "+00'"       # naive text is UTC (proven rule)
    if ISO.match(s):
        return "'" + s + "'"          # explicit Z already means UTC (decision 3)
    halt(f"{col}: unexpected timestamp {v!r}")
    return "NULL"


def q_date(v, col):
    if v is None:
        return "NULL"
    s = str(v).strip()
    if not DATE.match(s):
        halt(f"{col}: unexpected date {v!r}")
        return "NULL"
    return "'" + s + "'::date"


R = {"TEXT": q_text, "INT": q_int, "BOOL": q_bool, "CENTS": q_cents,
     "NUM6": q_num6, "REAL": q_real, "TS": q_ts, "DATE": q_date}


def order_by(st, cols):
    """retail_media_folders references itself, so parents must insert first."""
    if st == "retail_media_folders":
        return '"parent_id" NULLS FIRST, "id"'
    pk = "id" if any(c["sq"] == "id" for c in cols) else cols[0]["sq"]
    return f'"{pk}"'


def main(tables, quiet=False):
    os.makedirs(OUT, exist_ok=True)
    con = sqlite3.connect(SRC, uri=True)
    con.row_factory = sqlite3.Row
    try:
        con.execute("CREATE TABLE __write_probe__ (x)")
        print("FATAL: SQLite accepted a write. Aborting.")
        sys.exit(2)
    except sqlite3.OperationalError as e:
        if not quiet:
            print(f"read-only probe OK ({e})")

    counts = {}
    for st in tables:
        spec = plan["tables"][st]
        pt, cols = spec["pg"], spec["cols"]
        sel = ", ".join(f'"{c["sq"]}"' for c in cols)
        pgcols = ", ".join(f'"{c["pg"]}"' for c in cols)
        path = os.path.join(OUT, f"{pt}.sql")
        n = 0
        with open(path, "w", encoding="utf-8") as f:
            f.write("BEGIN;\n")
            for r in con.execute(f'SELECT {sel} FROM "{st}" ORDER BY {order_by(st, cols)}'):
                vals = []
                for c in cols:
                    v = r[c["sq"]]
                    ov = overrides.override(st, c["sq"], v)
                    if ov is not None:
                        v = ov[1]
                    vals.append(R[c["cls"]](v, f'{st}.{c["sq"]}'))
                f.write(f"INSERT INTO {pt} ({pgcols}) VALUES ({', '.join(vals)});\n")
                n += 1
            f.write("COMMIT;\n")
        counts[st] = n
        if not quiet:
            print(f"  {st:<30} -> {pt:<30} {n:>7} rows  {os.path.getsize(path)/1e6:>8.2f} MB")

    con.close()
    json.dump(counts, open(os.path.join(HERE, "gen_counts.json"), "w"), indent=1)

    if problems:
        print(f"\n=== HALT: {len(problems)} unresolved values ===")
        seen = set()
        for p in problems:
            k = p.split(":")[0]
            if k in seen:
                continue
            seen.add(k)
            print("  " + p)
        return          # the caller decides whether to abort
    if not quiet:
        print("\nall values fit the agreed rules")


if __name__ == "__main__":
    main(sys.argv[1:])
    sys.exit(1 if problems else 0)
