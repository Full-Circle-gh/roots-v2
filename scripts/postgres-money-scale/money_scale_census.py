#!/usr/bin/env python3
"""
Money decimal-scale census — PART 1 of the scale decision.

Answers, for every money column in the copy plan (92 CENTS + 9 NUM6):

  1. How many significant fractional digits the real data actually holds.
     Reported two ways, because SQLite stores these as REAL (binary float):
       - RAW scale:     digits after the point in Python's shortest round-trip
                        repr. This is what the bytes say, float noise included.
       - GENUINE scale: the smallest scale at which rounding the value is
                        indistinguishable from the stored double (relative
                        1e-12). This is the decimal the value MEANS.
     The gap between the two is float noise, not data. Same test as
     scripts/postgres-full-copy/precision.py, so the numbers stay comparable.

  2. The largest absolute value each column holds, and how many integer digits
     that needs — which sizes the PRECISION (the 14 in numeric(14,6)),
     independently of the scale.

Every column is bucketed DISPLAYED vs CALCULATED from money_bucket.json, so
the two populations can be read apart.

READ-ONLY. Opens SQLite with mode=ro and PROVES it by attempting a write and
aborting unless the write is rejected. Writes nothing anywhere, executes only
SELECT, and alters no type. Counts and characterises; recommends nothing.

Usage:
    python3 money_scale_census.py [--db PATH] [--plan PATH] [--buckets PATH]
                                  [--json OUT.json] [--examples N]

Default --db is the live path on the box: /root/roots-v2/data/roots.db
"""
import argparse
import json
import os
import sqlite3
import sys
from collections import Counter, defaultdict
from decimal import Decimal

HERE = os.path.dirname(os.path.abspath(__file__))

# The copy plan is the roster of money columns. It belongs to the completed
# full-copy run and is committed there; prefer that, fall back to a copy sitting
# alongside this script (which is how it is run from a scratch dir on the box).
_SIBLING = os.path.join(HERE, os.pardir, "postgres-full-copy", "plan.json")
DEFAULT_PLAN = (os.path.normpath(_SIBLING) if os.path.exists(_SIBLING)
                else os.path.join(HERE, "plan.json"))

# Scale candidates the census scores loss against. Not a recommendation —
# these are just the columns of the loss table.
CANDIDATE_SCALES = [2, 3, 4, 6, 8]
MAX_PROBE_SCALE = 12


# ---------------------------------------------------------------- read-only

def open_readonly(path):
    """Open SQLite read-only and prove it. Aborts if a write is accepted.

    Also proves the connection can actually READ. A WAL-mode database whose
    -wal needs recovery can open and then fail on the first query with
    SQLITE_READONLY_RECOVERY. Catching that here, loudly, matters: if it were
    left to the per-column loop it would look like 101 absent columns and the
    run would report an empty database instead of a failure.
    """
    if not os.path.exists(path):
        sys.exit(f"FATAL: no such database: {path}")
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)

    try:
        con.execute("CREATE TABLE __probe_readonly__ (x)")
        sys.exit("FATAL: SQLite accepted a write. Not read-only. Aborting.")
    except sqlite3.OperationalError as e:
        print(f"read-only probe OK — write rejected ({e})")

    try:
        n = con.execute("SELECT COUNT(*) FROM sqlite_master").fetchone()[0]
    except sqlite3.Error as e:
        sys.exit(
            f"FATAL: opened read-only but cannot read: {type(e).__name__}: {e}\n"
            f"  A hot -wal that needs recovery cannot be read by a read-only\n"
            f"  connection. Do NOT add immutable=1 — on a live database that\n"
            f"  silently skips the WAL and returns stale/torn rows. Take a\n"
            f"  consistent snapshot the way scripts/db-backup.sh does:\n"
            f"    sqlite3 {path} \".backup /tmp/census-snap.db\"\n"
            f"  then run this script against the snapshot.")

    wal = os.path.exists(path + "-wal")
    mode = con.execute("PRAGMA journal_mode").fetchone()[0]
    size = os.path.getsize(path + "-wal") if wal else 0
    print(f"read probe OK — {n} objects in sqlite_master; "
          f"journal_mode={mode}; -wal {'present, %d bytes' % size if wal else 'absent'}")
    if wal and size > 0:
        print("  note: rows committed to the -wal are included in these counts.")
    return con


# ------------------------------------------------------------------ scales

def raw_scale(v, storage):
    """Fractional digits as stored, float noise included."""
    if storage == "integer":
        return 0
    s = repr(float(v)) if storage != "text" else str(v).strip()
    if "e" in s or "E" in s:                      # 1e-05 -> expand
        s = format(Decimal(s), "f")
    return len(s.split(".", 1)[1].rstrip("0")) if "." in s else 0


def genuine_scale(v):
    """Smallest scale at which rounding is indistinguishable from the double.

    Identical test to precision.py: quantize at s = 0..MAX_PROBE_SCALE and stop
    at the first s whose round-trip is within relative 1e-12 of the stored
    value. Returns MAX_PROBE_SCALE if none qualifies.
    """
    f = float(v)
    d = Decimal(str(v))
    tol = abs(f) * 1e-12 + 1e-15
    for s in range(0, MAX_PROBE_SCALE + 1):
        if abs(float(d.quantize(Decimal(1).scaleb(-s))) - f) <= tol:
            return s
    return MAX_PROBE_SCALE


def int_digits(x):
    """Digits left of the point needed for abs value x."""
    a = abs(Decimal(str(x))).to_integral_value(rounding="ROUND_FLOOR")
    return len(str(int(a))) if a != 0 else 1


# ------------------------------------------------------------------ census

def census_column(con, table, column, examples_wanted):
    """Stream one column and characterise it. Returns a dict, or None if the
    column is absent from this database (reported, not fatal)."""
    try:
        con.execute(f'SELECT "{column}" FROM "{table}" LIMIT 0')
    except sqlite3.OperationalError as e:
        # Absent table/column is expected on a schema-only tenant clone and is
        # reported. Anything else (I/O error, WAL recovery, corruption) must NOT
        # be swallowed as "missing" — that would turn a broken read into a
        # false "this database holds no money".
        msg = str(e)
        if "no such table" in msg or "no such column" in msg:
            return {"missing": msg}
        raise SystemExit(f"FATAL reading {table}.{column}: {type(e).__name__}: {msg}")

    n_rows = con.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
    stats = {
        "rows": n_rows, "nonnull": 0, "nulls": 0, "zeros": 0, "negatives": 0,
        "storage": Counter(), "raw_hist": Counter(), "gen_hist": Counter(),
        "max_raw_scale": 0, "max_gen_scale": 0,
        "max_abs": None, "max_abs_value": None, "min_value": None,
        "deepest_examples": [], "loss": {s: 0 for s in CANDIDATE_SCALES},
        "over_2dp_genuine": 0,
    }
    deepest = []

    sql = (f'SELECT "{column}", typeof("{column}") FROM "{table}" '
           f'WHERE "{column}" IS NOT NULL')
    for v, storage in con.execute(sql):
        stats["nonnull"] += 1
        stats["storage"][storage] += 1

        if storage == "text":
            try:
                f = float(v)
            except (TypeError, ValueError):
                stats["storage"]["text:UNPARSEABLE"] += 1
                continue
        else:
            f = float(v)

        if f == 0:
            stats["zeros"] += 1
        if f < 0:
            stats["negatives"] += 1

        rs = raw_scale(v, storage)
        gs = genuine_scale(v)
        stats["raw_hist"][rs] += 1
        stats["gen_hist"][gs] += 1
        stats["max_raw_scale"] = max(stats["max_raw_scale"], rs)
        if gs > stats["max_gen_scale"]:
            stats["max_gen_scale"] = gs
        if gs > 2:
            stats["over_2dp_genuine"] += 1

        a = abs(f)
        if stats["max_abs"] is None or a > stats["max_abs"]:
            stats["max_abs"] = a
            stats["max_abs_value"] = f
        if stats["min_value"] is None or f < stats["min_value"]:
            stats["min_value"] = f

        # loss at each candidate scale, judged against the GENUINE decimal so
        # float noise is never counted as a loss
        d = Decimal(str(v)).quantize(Decimal(1).scaleb(-gs))
        for s in CANDIDATE_SCALES:
            if gs > s and d != d.quantize(Decimal(1).scaleb(-s)):
                stats["loss"][s] += 1

        deepest.append((gs, a, f, storage))

    stats["nulls"] = n_rows - stats["nonnull"]
    deepest.sort(key=lambda t: (-t[0], -t[1]))
    seen = set()
    for gs, _a, f, storage in deepest:
        if gs <= 2 or len(stats["deepest_examples"]) >= examples_wanted:
            break
        if f in seen:
            continue
        seen.add(f)
        stats["deepest_examples"].append(
            {"value": f, "genuine_scale": gs, "repr": repr(f), "storage": storage})

    stats["int_digits"] = int_digits(stats["max_abs"]) if stats["max_abs"] is not None else 0
    stats["total_digits_at_max_gen"] = stats["int_digits"] + stats["max_gen_scale"]
    stats["storage"] = dict(stats["storage"])
    stats["raw_hist"] = dict(sorted(stats["raw_hist"].items()))
    stats["gen_hist"] = dict(sorted(stats["gen_hist"].items()))
    return stats


# ------------------------------------------------------------------ report

def fmt_hist(h, cap=8):
    parts = [f"{k}dp:{v}" for k, v in sorted(h.items()) if k <= cap]
    over = sum(v for k, v in h.items() if k > cap)
    if over:
        parts.append(f">{cap}dp:{over}")
    return " ".join(parts) or "-"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="/root/roots-v2/data/roots.db")
    ap.add_argument("--plan", default=DEFAULT_PLAN)
    ap.add_argument("--label", default=None,
                    help="tag for this database in the output (e.g. tenant-5)")
    ap.add_argument("--buckets", default=os.path.join(HERE, "money_bucket.json"))
    ap.add_argument("--json", default=None, help="write full results as JSON")
    ap.add_argument("--examples", type=int, default=5)
    args = ap.parse_args()

    plan = json.load(open(args.plan, encoding="utf-8"))
    buckets = json.load(open(args.buckets, encoding="utf-8"))["columns"]

    con = open_readonly(args.db)
    print(f"source: {args.db}"
          f"{'  [' + args.label + ']' if args.label else ''}\nplan:   {args.plan}\n")

    roster = []
    for t, spec in sorted(plan["tables"].items()):
        for c in spec["cols"]:
            if c["cls"] in ("CENTS", "NUM6"):
                key = f"{t}.{c['sq']}"
                bucket, why = buckets.get(key, ["UNCLASSIFIED", ""])
                roster.append((t, c["sq"], c["cls"], c["pgtype"], bucket, why))

    print(f"{len(roster)} money columns in plan: "
          f"{sum(1 for r in roster if r[2]=='CENTS')} CENTS + "
          f"{sum(1 for r in roster if r[2]=='NUM6')} NUM6\n")

    results = {}
    missing = []
    for t, c, cls, pgtype, bucket, why in roster:
        st = census_column(con, t, c, args.examples)
        if "missing" in st:
            missing.append((t, c, st["missing"]))
            continue
        st.update(table=t, column=c, cls=cls, pgtype=pgtype, bucket=bucket, why=why)
        results[f"{t}.{c}"] = st

    for bucket_name in ("displayed", "calculated", "boundary", "UNCLASSIFIED"):
        cols = [v for v in results.values() if v["bucket"] == bucket_name]
        if not cols:
            continue
        print("=" * 108)
        print(f"{bucket_name.upper()}  —  {len(cols)} columns")
        print("=" * 108)
        print(f"{'column':<46} {'cls':<5} {'nonnull':>8} {'gen':>4} {'raw':>4} "
              f"{'>2dp':>6} {'max_abs':>16} {'digits':>7}")
        print("-" * 108)
        for v in sorted(cols, key=lambda x: (-x["max_gen_scale"], x["table"], x["column"])):
            name = f"{v['table']}.{v['column']}"
            mx = "-" if v["max_abs"] is None else f"{v['max_abs']:,.6f}".rstrip("0").rstrip(".")
            print(f"{name:<46} {v['cls']:<5} {v['nonnull']:>8} "
                  f"{v['max_gen_scale']:>4} {v['max_raw_scale']:>4} "
                  f"{v['over_2dp_genuine']:>6} {mx:>16} "
                  f"{v['int_digits']}+{v['max_gen_scale']:<5}")
        print()

    print("=" * 108)
    print("DEPTH — every column whose data genuinely exceeds 2 decimal places")
    print("=" * 108)
    deep = [v for v in results.values() if v["max_gen_scale"] > 2]
    if not deep:
        print("  none — no money column holds a genuine sub-cent value.")
    for v in sorted(deep, key=lambda x: -x["max_gen_scale"]):
        print(f"\n  {v['table']}.{v['column']}  [{v['bucket']}/{v['cls']}]  "
              f"deepest genuine scale = {v['max_gen_scale']}")
        print(f"    {v['over_2dp_genuine']} of {v['nonnull']} non-null values exceed 2dp")
        print(f"    genuine scale histogram: {fmt_hist(v['gen_hist'])}")
        print(f"    raw    scale histogram: {fmt_hist(v['raw_hist'])}")
        for ex in v["deepest_examples"]:
            print(f"      e.g. {ex['repr']:<24} ({ex['genuine_scale']}dp, {ex['storage']})")
        print("    values lost at candidate scale: " +
              "  ".join(f"s={s}:{v['loss'][s]}" for s in CANDIDATE_SCALES))

    print("\n" + "=" * 108)
    print("PRECISION — largest absolute value held, per bucket and overall")
    print("=" * 108)
    for bucket_name in ("displayed", "calculated", "boundary"):
        cols = [v for v in results.values()
                if v["bucket"] == bucket_name and v["max_abs"] is not None]
        if not cols:
            continue
        top = sorted(cols, key=lambda x: -x["max_abs"])[:5]
        print(f"\n  {bucket_name}:")
        for v in top:
            print(f"    {v['max_abs']:>18,.6f}  {v['table']}.{v['column']}  "
                  f"({v['int_digits']} integer digits)")
    everything = [v for v in results.values() if v["max_abs"] is not None]
    if everything:
        big = max(everything, key=lambda x: x["max_abs"])
        need = max(v["int_digits"] + v["max_gen_scale"] for v in everything)
        print(f"\n  BIGGEST MONEY VALUE ANYWHERE: {big['max_abs']:,.6f}"
              f"  in {big['table']}.{big['column']}")
        print(f"  integer digits required:      {big['int_digits']}")
        print(f"  worst total digits required (int digits + that column's genuine scale): {need}")
        print(f"  headroom in numeric(14,6):    14 total / 8 integer digits "
              f"-> max representable 99,999,999.999999")

    print("\n" + "=" * 108)
    print("LOSS TABLE — non-null values that would change, by bucket and scale")
    print("=" * 108)
    print(f"{'bucket':<14} {'cols':>5} {'nonnull':>10} " +
          " ".join(f"{'s='+str(s):>10}" for s in CANDIDATE_SCALES))
    for bucket_name in ("displayed", "calculated", "boundary"):
        cols = [v for v in results.values() if v["bucket"] == bucket_name]
        if not cols:
            continue
        nn = sum(v["nonnull"] for v in cols)
        print(f"{bucket_name:<14} {len(cols):>5} {nn:>10} " +
              " ".join(f"{sum(v['loss'][s] for v in cols):>10}" for s in CANDIDATE_SCALES))

    print("\n" + "=" * 108)
    print("STORAGE CLASSES — anything not 'real' or 'integer' is worth a look")
    print("=" * 108)
    agg = defaultdict(int)
    for v in results.values():
        for k, n in v["storage"].items():
            agg[k] += n
    for k, n in sorted(agg.items(), key=lambda x: -x[1]):
        print(f"  {k:<20} {n:>10}")
    odd = [f"{v['table']}.{v['column']}" for v in results.values()
           if set(v["storage"]) - {"real", "integer"}]
    if odd:
        print("  columns holding text/blob money: " + ", ".join(odd))

    if missing:
        print("\nCOLUMNS IN PLAN BUT NOT IN THIS DATABASE:")
        for t, c, e in missing:
            print(f"  {t}.{c}  ({e})")

    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump({"db": args.db, "label": args.label, "results": results,
                       "missing": missing}, fh, indent=2, default=str)
        print(f"\nfull results -> {args.json}")

    con.close()


if __name__ == "__main__":
    main()
