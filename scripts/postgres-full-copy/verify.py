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


def scope_report(examined):
    """What this run compared, and what in the live source it did not.

    verify.py builds its column list from plan.json's cols[] -- the SAME list
    gen.py builds its SELECT from. So it is blind in exactly the way the copier
    is blind, and cannot detect its own blind spot: on 2026-08-21 it reported
    retail_orders OK at 120,546 cells while two of that table's columns had
    never been copied and were never looked at. A high cell count is not
    coverage.

    This cannot fix that -- the fix is drift_guard.py, which reads a DIFFERENT
    source. What this does is stop the number reading as total coverage when it
    is not. Nothing about WHAT is compared changes; only what is disclosed.

    THREE CATEGORIES, AND THE DIFFERENCE BETWEEN THEM IS THE WHOLE POINT:

      1. a live table absent from plan.json      -> BLIND SPOT
      2. a live column absent from that table's
         cols[], in a table that WAS examined    -> BLIND SPOT
      3. a planned table the caller did not ask
         for on the command line                 -> the caller's own scoping

    Only 1 and 2 mean the map cannot see something. 3 means the operator chose
    a subset, which is a normal way to run this, so it is counted and not
    listed -- an earlier cut of this function listed all 163 unrequested tables
    when one table was verified, and buried the single real finding in them.

    Returns the number of BLIND SPOTS (1 + 2), not the number of unexamined
    objects. Raises rather than returning 0 if it cannot read the source: an
    unmeasurable scope must not report as a complete one.
    """
    con = sqlite3.connect(SRC, uri=True)
    try:
        live_tables = [r[0] for r in con.execute(
            "select name from sqlite_master where type='table' "
            "order by name") if not r[0].startswith("sqlite_")]
        if not live_tables:
            raise SystemExit("REFUSE: the source reports no tables; scope is unmeasurable")
        unplanned = [t for t in live_tables if t not in plan["tables"]]
        unrequested = [t for t in live_tables
                       if t in plan["tables"] and t not in examined]
        blind_cols, seen_cols = [], 0
        for t in sorted(examined):
            if t not in live_tables:
                continue
            livecols = [r[1] for r in con.execute(
                f'PRAGMA table_info("{t}")')]
            mapped = {c["sq"] for c in plan["tables"][t]["cols"]}
            seen_cols += len(mapped)
            for c in livecols:
                if c not in mapped:
                    blind_cols.append(t + '.' + c)
    finally:
        con.close()

    print("")
    print("=== what this run examined, and what it did not ===")
    print("  tables examined                     : %d of %d in the live source"
          % (len(examined), len(live_tables)))
    print("  columns examined                    : %d" % seen_cols)
    if unrequested:
        print("  planned tables not requested        : %d  (the caller's own scoping,"
              % len(unrequested))
        print("                                         not a gap in the map)")

    blind = len(unplanned) + len(blind_cols)
    if not blind:
        print("  live tables the map cannot see      : 0")
        print("  live columns the map cannot see     : 0")
        print("  -> every table and column examined was compared in full")
        return 0

    if unplanned:
        print("  LIVE TABLES ABSENT FROM plan.json   : %d" % len(unplanned))
        for t in unplanned:
            print("       %s" % t)
    if blind_cols:
        print("  LIVE COLUMNS ABSENT FROM cols[]     : %d  (in tables that WERE examined)"
              % len(blind_cols))
        for c in blind_cols:
            print("       %s" % c)
    print("")
    print("  *** THIS RUN IS NOT A CLEAN BILL OF HEALTH. ***")
    print("  %d live object(s) are outside the map itself, so the cell count and the"
          % blind)
    print("  difference count above describe the MAP, not the SOURCE. A table or column")
    print("  absent from plan.json is absent from this comparison too, and its silence")
    print("  here is not evidence that it copied. Run drift_guard.py, which reads the")
    print("  source directly and does not share this map.")
    return blind


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
    unexamined = scope_report(set(tables))
    out = os.environ.get("VERIFY_OUT", "verify_result.json")
    json.dump({"cells": cells_tot, "diffs": grand,
               "per_table": [[r[0], r[1], r[2], r[3], len(r[5])] for r in results],
               "detail": {r[0]: [d[:400] for d in r[5]] for r in results if r[5]}},
              open(os.path.join(HERE, out), "w"), indent=1)
    # The exit code still reports DIFFERENCES, which is its existing contract
    # and what callers branch on. Scope is disclosed in the output rather than
    # folded into the code, because a caller that has always read 0 as
    # "no differences" must keep reading it that way. The line above is the
    # one a human has to read.
    sys.exit(1 if grand else 0)
