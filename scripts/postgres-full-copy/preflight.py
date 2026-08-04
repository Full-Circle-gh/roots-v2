#!/usr/bin/env python3
"""
Pre-flight scan of the live SQLite data against the Postgres target.
READ-ONLY. Writes a JSON report. Converts nothing, copies nothing.

Checks every non-empty table, every mapped column:
  TS   value must be 'YYYY-MM-DD HH:MM:SS'
  DATE value must be 'YYYY-MM-DD'
  BOOL value must be 0 or 1
  INT  value must be an integer and fit the target integer width
  CENTS/REAL value must be numeric
  TEXT value must not contain a NUL byte; flags non-text storage classes
  NOT NULL target must have no NULL source values
  foreign keys must resolve against the source parent table
  unique constraints must not already be violated in source
"""
import sqlite3, json, sys, re, os

SRC = "file:/root/roots-v2/data/roots.db?mode=ro"
HERE = os.path.dirname(os.path.abspath(__file__))
plan = json.load(open(os.path.join(HERE, "plan.json"), encoding="utf-8"))

TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
INT4_MIN, INT4_MAX = -2147483648, 2147483647
INT8_MIN, INT8_MAX = -9223372036854775808, 9223372036854775807
SMALL_MIN, SMALL_MAX = -32768, 32767

con = sqlite3.connect(SRC, uri=True)
con.text_factory = bytes  # see raw bytes so encoding problems surface
try:
    con.execute("CREATE TABLE __probe__ (x)")
    print("FATAL: SQLite accepted a write")
    sys.exit(2)
except sqlite3.OperationalError as e:
    print(f"read-only probe OK ({e})")
con.close()

con = sqlite3.connect(SRC, uri=True)
con.row_factory = sqlite3.Row

findings = []          # hard problems that must be resolved before copying
notes = []             # observations worth reporting, not blocking
MAXEX = 6


def add(kind, table, col, msg, examples=None):
    findings.append({"kind": kind, "table": table, "col": col, "msg": msg,
                     "examples": (examples or [])[:MAXEX]})


def intrange(pgtype):
    if pgtype == "smallint":
        return SMALL_MIN, SMALL_MAX
    if pgtype == "integer":
        return INT4_MIN, INT4_MAX
    return INT8_MIN, INT8_MAX


# ---- per-column value scan -------------------------------------------------
for st in sorted(plan["tables"]):
    spec = plan["tables"][st]
    if spec["rows"] == 0:
        continue
    cols = spec["cols"]
    sel = ", ".join(f'"{c["sq"]}"' for c in cols)
    has_id = any(c["sq"] == "id" for c in cols)
    idsel = '"id"' if has_id else "rowid"
    rows = con.execute(f'SELECT {idsel} AS __k, {sel} FROM "{st}"').fetchall()

    bad = {}   # (col, kind) -> list of (rowid, value)

    def flag(c, kind, k, v):
        bad.setdefault((c, kind), []).append((k, repr(v)[:120]))

    for r in rows:
        k = r["__k"]
        for c in cols:
            v = r[c["sq"]]
            name, cls, pgt = c["sq"], c["cls"], c["pgtype"]
            if v is None:
                if c["notnull"] and not c["identity"]:
                    flag(name, "NULL_INTO_NOT_NULL", k, None)
                continue
            if cls == "TS":
                if not (isinstance(v, str) and TS_RE.match(v)):
                    flag(name, "BAD_TIMESTAMP", k, v)
            elif cls == "DATE":
                if not (isinstance(v, str) and DATE_RE.match(v)):
                    flag(name, "BAD_DATE", k, v)
            elif cls == "BOOL":
                if v not in (0, 1):
                    flag(name, "BAD_BOOLEAN", k, v)
            elif cls == "INT":
                if isinstance(v, str) or isinstance(v, bytes):
                    flag(name, "TEXT_IN_INT", k, v)
                elif isinstance(v, float) and not float(v).is_integer():
                    flag(name, "FRACTION_IN_INT", k, v)
                else:
                    lo, hi = intrange(pgt)
                    if not (lo <= int(v) <= hi):
                        flag(name, "INT_OUT_OF_RANGE", k, v)
            elif cls in ("CENTS", "REAL"):
                if not isinstance(v, (int, float)):
                    flag(name, "NON_NUMERIC_IN_NUMBER", k, v)
            elif cls == "TEXT":
                if isinstance(v, bytes):
                    flag(name, "BLOB_IN_TEXT", k, v[:40])
                elif isinstance(v, str):
                    if "\x00" in v:
                        flag(name, "NUL_BYTE_IN_TEXT", k, v[:40])
                elif isinstance(v, (int, float)):
                    flag(name, "NUMBER_IN_TEXT", k, v)

    for (c, kind), ex in sorted(bad.items()):
        add(kind, st, c, f"{len(ex)} row(s)", ex)

# ---- foreign key resolution -----------------------------------------------
sq_of = {t["pg"]: st for st, t in plan["tables"].items()}
SKIP = set()  # filled in below by the caller's decision; empty during scan

for f in plan["fkeys"]:
    child_pg, parent_pg = f["table"], f["ref"]
    if child_pg not in sq_of or parent_pg not in sq_of:
        continue
    child, parent = sq_of[child_pg], sq_of[parent_pg]
    if plan["tables"][child]["rows"] == 0:
        continue
    # translate PG column names back to SQLite
    def back(t, pgcol):
        for c in plan["tables"][t]["cols"]:
            if c["pg"] == pgcol:
                return c["sq"]
        return None
    ccols = [back(child, c) for c in f["cols"]]
    pcols = [back(parent, c) for c in f["refcols"]]
    if any(x is None for x in ccols) or any(x is None for x in pcols):
        add("FK_UNMAPPED", child_pg, str(f["cols"]), f"cannot map FK columns to SQLite: {f['def']}")
        continue
    cc = ", ".join(f'c."{x}"' for x in ccols)
    on = " AND ".join(f'c."{a}" = p."{b}"' for a, b in zip(ccols, pcols))
    notnull = " AND ".join(f'c."{a}" IS NOT NULL' for a in ccols)
    q = (f'SELECT {cc}, COUNT(*) AS n FROM "{child}" c '
         f'LEFT JOIN "{parent}" p ON {on} WHERE {notnull} AND p."{pcols[0]}" IS NULL '
         f'GROUP BY {cc} ORDER BY n DESC LIMIT {MAXEX}')
    orphans = con.execute(q).fetchall()
    if orphans:
        tot = con.execute(f'SELECT COUNT(*) FROM "{child}" c LEFT JOIN "{parent}" p ON {on} '
                          f'WHERE {notnull} AND p."{pcols[0]}" IS NULL').fetchone()[0]
        add("FK_ORPHAN", child_pg, ",".join(f["cols"]),
            f"{tot} row(s) reference {parent_pg}({','.join(f['refcols'])}) with no matching parent",
            [f"value={tuple(o[i] for i in range(len(ccols)))} x{o['n']}" for o in orphans])

# ---- unique constraints already violated in source ------------------------
UNIQ_RE = re.compile(r"UNIQUE \(([^)]*)\)")
for c in plan["cons"]:
    if c["type"] not in ("u", "p"):
        continue
    m = UNIQ_RE.search(c["def"]) or re.search(r"PRIMARY KEY \(([^)]*)\)", c["def"])
    if not m:
        continue
    pgt = c["table"].strip('"')
    if pgt not in sq_of:
        continue
    st = sq_of[pgt]
    if plan["tables"][st]["rows"] == 0:
        continue
    pgcols = [x.strip().strip('"') for x in m.group(1).split(",")]
    sqcols = []
    for pc in pgcols:
        hit = [x["sq"] for x in plan["tables"][st]["cols"] if x["pg"] == pc]
        if not hit:
            sqcols = None
            break
        sqcols.append(hit[0])
    if not sqcols:
        continue
    cl = ", ".join(f'"{x}"' for x in sqcols)
    nn = " AND ".join(f'"{x}" IS NOT NULL' for x in sqcols)
    q = (f'SELECT {cl}, COUNT(*) n FROM "{st}" WHERE {nn} GROUP BY {cl} '
         f'HAVING COUNT(*) > 1 ORDER BY n DESC LIMIT {MAXEX}')
    dups = con.execute(q).fetchall()
    if dups:
        add("UNIQUE_VIOLATION", pgt, ",".join(pgcols),
            f"source has duplicate values for {c['def']}",
            [f"{tuple(d[i] for i in range(len(sqcols)))} x{d['n']}" for d in dups])

# ---- tenant_id distribution ------------------------------------------------
for st in sorted(plan["tables"]):
    if plan["tables"][st]["rows"] == 0:
        continue
    names = [c["sq"] for c in plan["tables"][st]["cols"]]
    if "tenant_id" in names:
        dist = con.execute(f'SELECT tenant_id, COUNT(*) n FROM "{st}" GROUP BY tenant_id ORDER BY n DESC').fetchall()
        notes.append({"kind": "TENANT_DIST", "table": st,
                      "dist": {("NULL" if d[0] is None else str(d[0])): d[1] for d in dist}})

con.close()

out = {"findings": findings, "notes": notes}
with open(os.path.join(HERE, "preflight.json"), "w", encoding="utf-8") as fh:
    json.dump(out, fh, indent=1, ensure_ascii=False)

from collections import Counter
print(f"\n=== {len(findings)} findings ===")
for k, v in Counter(f["kind"] for f in findings).most_common():
    print(f"{v:>4}  {k}")
