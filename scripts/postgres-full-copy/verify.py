#!/usr/bin/env python3
"""
Round-trip verifier. For each table, render the Postgres values back into the
SQLite representation *in SQL*, emit one JSON object per row, and compare against
the SQLite source cell by cell.

Timestamps are compared as canonical UTC instants to microsecond precision,
because the source holds four different textual formats for the same column and
timestamptz keeps no memory of which was written. Comparing the instant proves
the value survived; comparing the text would only prove the format.

Wide text columns (base64 images, documents, snapshots) are compared by character
length, byte length and SHA-256 of the UTF-8 bytes rather than shipping megabytes
back through psql.

Usage: verify.py <sqlite_table> [<sqlite_table> ...]
"""
import sqlite3, json, os, sys, subprocess, hashlib, re
from decimal import Decimal, ROUND_HALF_UP
import overrides

HERE = os.path.dirname(os.path.abspath(__file__))
plan = json.load(open(os.path.join(HERE, "plan.json"), encoding="utf-8"))
WIDE = {tuple(x) for x in json.load(open(os.path.join(HERE, "wide_cols.json"), encoding="utf-8"))}
SRC = "file:/root/roots-v2/data/roots.db?mode=ro"
SIX = Decimal("0.000001")

NAIVE = re.compile(r"^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$")
ISO = re.compile(r"^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$")


def psql(sql):
    p = subprocess.run(["sudo", "-u", "postgres", "psql", "-d", "tacet", "-tA",
                        "-v", "ON_ERROR_STOP=1", "-c", sql],
                       capture_output=True, text=True)  # -c: no file to read
    if p.returncode != 0:
        raise SystemExit(f"psql failed:\n{p.stderr}")
    return p.stdout


def render_expr(st, c):
    """SQL rendering the Postgres column back into the SQLite representation."""
    q = f'"{c["pg"]}"'
    cls = c["cls"]
    if cls == "BOOL":
        return f"CASE WHEN {q} IS NULL THEN NULL ELSE (CASE WHEN {q} THEN '1' ELSE '0' END) END"
    if cls == "TS":
        return f"to_char({q} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')"
    if cls == "DATE":
        return f"to_char({q}, 'YYYY-MM-DD')"
    if cls in ("INT", "CENTS", "NUM6", "REAL"):
        return f"{q}::text"
    if (st, c["sq"]) in WIDE:
        return (f"CASE WHEN {q} IS NULL THEN NULL ELSE "
                f"(length({q})::text || '|' || octet_length({q})::text || '|' || "
                f"encode(sha256(convert_to({q},'UTF8')),'hex')) END")
    return q


def canon_ts(v):
    s = str(v).strip()
    m = NAIVE.match(s)
    if m:
        return f"{m.group(1)} {m.group(2)}.000000"
    m = ISO.match(s)
    if m:
        return f"{m.group(1)} {m.group(2)}.{(m.group(3) or '').ljust(6, '0')}"
    return f"<UNPARSED {s!r}>"


def sq_render(st, c, v):
    """The SQLite side, expressed the same way."""
    if v is None:
        return None
    cls = c["cls"]
    if cls == "BOOL":
        return "1" if v == 1 else "0"
    if cls == "TS":
        return canon_ts(v)
    if cls == "DATE":
        return str(v)
    if cls == "INT":
        return str(int(v))
    if cls == "CENTS":
        return str(int((Decimal(str(v)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP)))
    if cls == "NUM6":
        return str(Decimal(str(v)).quantize(SIX, rounding=ROUND_HALF_UP))
    if cls == "REAL":
        return repr(float(v))
    if (st, c["sq"]) in WIDE:
        b = str(v).encode("utf-8")
        return f"{len(str(v))}|{len(b)}|{hashlib.sha256(b).hexdigest()}"
    return str(v)


def eq(cls, a, b):
    if a is None or b is None:
        return a is None and b is None
    if cls == "REAL":
        try:
            return float(a) == float(b)
        except ValueError:
            return a == b
    return a == b


def order_by_pg(st, cols):
    """SQLite sorts text by byte (BINARY); Postgres sorts by locale, which ignores
    punctuation, so 'me_page.rows' and 'membership.layout' come out in opposite
    orders. COLLATE "C" is Postgres's byte order and matches SQLite exactly.
    Without this the two sides pair up different rows and every cell looks wrong."""
    if st == "retail_media_folders":
        return '"parent_id" NULLS FIRST, "id"'
    pk = "id" if any(c["sq"] == "id" for c in cols) else cols[0]["sq"]
    c = next(x for x in cols if x["sq"] == pk)
    q = f'"{c["pg"]}"'
    if c["pgtype"] == "text" or c["pgtype"].startswith("character"):
        q += ' COLLATE "C"'
    return q


def order_by_sq(st, cols):
    if st == "retail_media_folders":
        return '"parent_id" IS NOT NULL, "parent_id", "id"'
    pk = "id" if any(c["sq"] == "id" for c in cols) else cols[0]["sq"]
    return f'"{pk}"'


def verify(st):
    spec = plan["tables"][st]
    pt, cols = spec["pg"], spec["cols"]
    pk = "id" if any(c["sq"] == "id" for c in cols) else cols[0]["sq"]

    # jsonb_build_object takes at most 100 arguments, i.e. 50 columns, and some
    # tables are wider than that. Build the object in chunks and concatenate.
    chunks = []
    for i in range(0, len(cols), 40):
        pairs = []
        for c in cols[i:i + 40]:
            pairs.append("'" + c["pg"].replace("'", "''") + "'")
            pairs.append(render_expr(st, c))
        chunks.append(f"jsonb_build_object({', '.join(pairs)})")
    # every timestamp carries an explicit AT TIME ZONE 'UTC', so the session
    # timezone cannot affect the result
    sql = (f"SELECT ({' || '.join(chunks)})::text "
           f'FROM "{pt}" ORDER BY {order_by_pg(st, cols)};')
    pgrows = [json.loads(l) for l in psql(sql).splitlines() if l.startswith("{")]

    con = sqlite3.connect(SRC, uri=True)
    con.row_factory = sqlite3.Row
    sel = ", ".join(f'"{c["sq"]}"' for c in cols)
    sqrows = con.execute(f'SELECT {sel} FROM "{st}" ORDER BY {order_by_sq(st, cols)}').fetchall()
    con.close()

    diffs, cells, ovr = [], 0, 0
    if len(sqrows) != len(pgrows):
        diffs.append(f"ROW COUNT: sqlite={len(sqrows)} postgres={len(pgrows)}")
    for i in range(min(len(sqrows), len(pgrows))):
        s, p = sqrows[i], pgrows[i]
        for c in cols:
            cells += 1
            v = s[c["sq"]]
            o = overrides.override(st, c["sq"], v)
            if o is not None:
                v = o[1]
                ovr += 1
            a = sq_render(st, c, v)
            b = p.get(c["pg"])
            if not eq(c["cls"], a, b):
                diffs.append(f"row {i} ({pk}={s[pk]}) {c['pg']}: sqlite={a!r} postgres={b!r}")
    return len(sqrows), len(pgrows), cells, ovr, diffs


if __name__ == "__main__":
    tables = sys.argv[1:]
    grand = cells_tot = ovr_tot = 0
    results = []
    for t in tables:
        ns, np_, cells, ovr, diffs = verify(t)
        cells_tot += cells
        ovr_tot += ovr
        grand += len(diffs)
        results.append((t, ns, np_, cells, ovr, diffs))
        status = "OK" if not diffs else f"*** {len(diffs)} DIFF ***"
        extra = f"  overrides={ovr}" if ovr else ""
        print(f"{t:<32} sqlite={ns:<7} pg={np_:<7} cells={cells:<9} {status}{extra}")
        for d in diffs[:10]:
            print("      " + d)
        if len(diffs) > 10:
            print(f"      ... and {len(diffs)-10} more")
    print(f"\ntables={len(tables)}  cells compared={cells_tot}  overrides applied={ovr_tot}  differences={grand}")
    out = os.environ.get("VERIFY_OUT", "verify_result.json")
    json.dump({"cells": cells_tot, "diffs": grand,
               "per_table": [[r[0], r[1], r[2], r[3], len(r[5])] for r in results],
               "detail": {r[0]: [d[:400] for d in r[5]] for r in results if r[5]}},
              open(os.path.join(HERE, out), "w"), indent=1)
    sys.exit(1 if grand else 0)
