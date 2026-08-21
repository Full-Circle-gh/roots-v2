#!/usr/bin/env python3
"""
Refuse to copy if plan.json no longer describes the source, or if the copy
order no longer matches plan.json.

WHY THIS EXISTS. plan.json is a CENSUS, taken 2026-08-03. run.py takes the
SHAPE of the copy from it — which tables, which columns, which have rows — and
the CONTENTS from live SQLite. That is two epochs in one operation, and every
difference between them is invisible:

  * a table added to SQLite since the census is not in `plan["tables"]`, so it
    is never truncated and never copied, and it simply does not exist in
    Postgres at the flip;
  * a column added since is not in `cols[]`, so `gen.py` never selects it and
    the value is dropped without an error;
  * and `verify.py` builds its comparison from the SAME `cols[]`, so it cannot
    catch either. On 2026-08-21 it compared 4,220,046 cells clean while eleven
    columns went uncopied.

Measured when this was written: 13 objects had drifted in 18 days, one of them
that same day. The rate is the problem, not the backlog, so this is a guard
rather than a patch.

TWO COMPARISONS, AND THE SECOND IS NOT A DETAIL. run.py builds its TRUNCATE
list from `plan["tables"]` and its `todo` from copy_order.json. **A table in
plan.json and missing from copy_order.json is therefore EMPTIED AND NEVER
REFILLED** — and the source comparison alone goes green, because SQLite and
plan.json agree perfectly. Nothing about that is visible from either file on
its own. The two new tables of 2026-08-21 were added to copy_order.json by
hand; this makes forgetting that impossible.

READ-ONLY on SQLite, and proven so on connect. Touches Postgres not at all.

EXIT CODES
  0  plan.json agrees with live SQLite on tables and columns, AND with
     copy_order.json on the set of tables to copy
  1  they differ — the differences are printed, nothing was copied
  2  the check could not run. NOT a pass. A guard that cannot see the source
     must refuse, never wave the copy through.

Usage:  drift_guard.py [--quiet]
run.py calls it before the TRUNCATE; it is also runnable on its own.
"""
import sqlite3, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = "file:/root/roots-v2/data/roots.db?mode=ro"

# SQLite's own bookkeeping. Not application data, and deliberately not copied:
# setseq.py reads sqlite_sequence as a SOURCE of AUTOINCREMENT high-water marks,
# and Postgres carries real sequences instead.
INTERNAL_PREFIX = "sqlite_"


def load_json(name):
    try:
        return json.load(open(os.path.join(HERE, name), encoding="utf-8"))
    except Exception as e:
        print("REFUSE: cannot read %s — %s" % (name, e))
        sys.exit(2)


def open_source():
    try:
        con = sqlite3.connect(SRC, uri=True)
    except Exception as e:
        print("REFUSE: cannot open the source database — %s" % e)
        sys.exit(2)
    try:
        con.execute("CREATE TABLE __drift_guard_probe__ (x)")
        print("REFUSE: SQLite accepted a write; this must be a read-only handle")
        sys.exit(2)
    except sqlite3.OperationalError:
        pass
    return con


def main(quiet=False):
    plan = load_json("plan.json")
    order = load_json("copy_order.json")
    if not isinstance(order, list) or not order:
        print("REFUSE: copy_order.json is not a non-empty list")
        sys.exit(2)
    con = open_source()

    try:
        live_tables = [r[0] for r in con.execute(
            "select name from sqlite_master where type='table' order by name")]
    except Exception as e:
        print("REFUSE: cannot list source tables — %s" % e)
        sys.exit(2)
    if not live_tables:
        print("REFUSE: the source reports zero tables, which cannot be right")
        sys.exit(2)

    planned = set(plan["tables"])
    live = [t for t in live_tables if not t.startswith(INTERNAL_PREFIX)]

    new_tables = [t for t in live if t not in planned]
    gone_tables = sorted(planned - set(live))

    new_cols, gone_cols = [], []
    for t in sorted(planned & set(live)):
        try:
            livecols = [r[1] for r in con.execute('PRAGMA table_info("%s")' % t)]
        except Exception as e:
            print("REFUSE: cannot read the columns of %s — %s" % (t, e))
            sys.exit(2)
        if not livecols:
            print("REFUSE: %s reports zero columns, which cannot be right" % t)
            sys.exit(2)
        plancols = {c["sq"] for c in plan["tables"][t]["cols"]}
        for c in livecols:
            if c not in plancols:
                new_cols.append((t, c))
        for c in sorted(plancols - set(livecols)):
            gone_cols.append((t, c))

    def rows(t):
        try:
            return con.execute('SELECT COUNT(*) FROM "%s"' % t).fetchone()[0]
        except Exception:
            return "?"

    # ---- plan.json vs copy_order.json -------------------------------------
    # Membership only. The ORDER within copy_order.json is a separate property,
    # derived from the Postgres foreign keys, and this guard does not check it.
    dupes = sorted({t for t in order if order.count(t) > 1})
    unordered = sorted(planned - set(order))    # truncated, never refilled
    unplanned = sorted(set(order) - planned)    # copy_order names a table the plan lacks

    total = (len(new_tables) + len(gone_tables) + len(new_cols) + len(gone_cols)
             + len(unordered) + len(unplanned) + len(dupes))
    if not total:
        if not quiet:
            print("drift guard: plan.json matches the source — %d tables, %d columns; "
                  "copy_order.json covers all %d"
                  % (len(live), sum(len(plan["tables"][t]["cols"]) for t in live), len(order)))
        con.close()
        return 0

    print("")
    print("*** DRIFT GUARD: THE COPY PLAN AND WHAT IT DESCRIBES HAVE DIVERGED ***")
    print("")
    if new_tables:
        print("  IN THE SOURCE, NOT IN THE PLAN — these would not exist in Postgres at all:")
        for t in new_tables:
            print("     %-38s rows=%s" % (t, rows(t)))
    if new_cols:
        print("  IN THE SOURCE, NOT IN cols[] — these are dropped with no error:")
        for t, c in new_cols:
            print("     %-38s %s" % (t + "." + c, ""))
    if gone_tables:
        print("  IN THE PLAN, NOT IN THE SOURCE — the copy would fail on these:")
        for t in gone_tables:
            print("     %s" % t)
    if gone_cols:
        print("  IN cols[], NOT IN THE SOURCE — the SELECT would fail on these:")
        for t, c in gone_cols:
            print("     %s.%s" % (t, c))
    if unordered:
        print("  IN plan.json, NOT IN copy_order.json — THE TRUNCATE EMPTIES THESE")
        print("  AND NOTHING REFILLS THEM. The source comparison cannot see this:")
        for t in unordered:
            print("     %-38s rows=%s" % (t, rows(t)))
    if unplanned:
        print("  IN copy_order.json, NOT IN plan.json — the copy would fail on these:")
        for t in unplanned:
            print("     %s" % t)
    if dupes:
        print("  LISTED TWICE IN copy_order.json — the second load would duplicate rows:")
        for t in dupes:
            print("     %s" % t)
    print("")
    print("  %d difference(s). NOTHING HAS BEEN COPIED." % total)
    print("")
    print("  plan.json is a census and the source has moved since it was taken.")
    print("  Fixing this means adding the objects to Postgres AND to plan.json —")
    print("  a schema change, not a re-run. docs/tacet-postgres-schema-drift-*.sql")
    print("  is the worked example. Do NOT edit this guard to pass.")
    con.close()
    return 1


if __name__ == "__main__":
    sys.exit(main(quiet="--quiet" in sys.argv[1:]))
