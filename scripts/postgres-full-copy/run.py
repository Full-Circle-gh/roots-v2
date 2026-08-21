#!/usr/bin/env python3
"""
Run the full copy: truncate the target, then generate, load and time every
non-empty table in the dependency order derived from the Postgres foreign keys.

SQLite is opened read-only throughout. Each table's SQL file is deleted once it
has loaded, so peak disk stays near the size of the largest single table.
"""
import sqlite3, json, os, sys, subprocess, time
import gen, overrides, drift_guard

HERE = os.path.dirname(os.path.abspath(__file__))
plan = json.load(open(os.path.join(HERE, "plan.json"), encoding="utf-8"))
SRC = "file:/root/roots-v2/data/roots.db?mode=ro"
sq_of = {t["pg"]: st for st, t in plan["tables"].items()}


def derive_copy_order():
    """The order the copy runs in, DERIVED from the source rather than stored.

    This replaced copy_order.json, which was a stored list of 164 table names.
    That file could only be wrong by OMISSION, and omission was expensive: the
    TRUNCATE list comes from plan["tables"] and the load order came from the
    file, so a table in the first and missing from the second was emptied and
    never refilled -- silently, with every source check passing.

    MEMBERSHIP comes from plan["tables"], the same dict the TRUNCATE is built
    from, so the two cannot diverge. CONSTRAINT comes from SQLite's own
    declared foreign keys, measured 2026-08-21 as identical to Postgres's --
    145 edges, set-compared both ways with implicit-PK forms resolved, zero
    differences. Reading the source rather than the cluster keeps the property
    the guard has: this can run and refuse before Postgres is reachable.

    THE TIE-BREAK IS ALPHABETICAL AND IT IS ARBITRARY. Say that plainly: the
    foreign-key graph forces almost nothing here. Measured on the same day,
    162 of 164 steps had more than one table eligible, the widest tie was 67,
    and 51 tables (31%) appear in no foreign key at all. So this is NOT "the
    foreign-key order" -- the graph fixes about 2% of the sequence and this
    rule fixes the rest. Alphabetical is not chosen because it is meaningful.
    It is chosen because it is STABLE, and stability is the property that
    matters: an order that varies between runs makes two rehearsals
    incomparable and an order-dependent failure impossible to reproduce.

    Everything below iterates SORTED LISTS, never a set or a dict. Set
    iteration order varies with PYTHONHASHSEED across processes, which would
    hand back a different valid order each run and quietly destroy exactly the
    property this docstring is about.
    """
    tables = sorted(plan["tables"])
    tset = set(tables)
    con = sqlite3.connect(SRC, uri=True)
    try:
        con.execute("CREATE TABLE __order_probe__ (x)")
        print("FATAL: SQLite accepted a write in derive_copy_order()")
        sys.exit(2)
    except sqlite3.OperationalError:
        pass
    parents = {}
    try:
        for t in tables:
            ps = set()
            for r in con.execute('PRAGMA foreign_key_list("%s")' % t):
                parent = r[2]
                # A self-reference is a ROW ordering problem, not a table one:
                # gen.py order_by() puts retail_media_folders parents first.
                if parent != t and parent in tset:
                    ps.add(parent)
            parents[t] = ps
    finally:
        con.close()

    placed, done = [], set()
    while len(placed) < len(tables):
        ready = [t for t in tables if t not in done and not (parents[t] - done)]
        if not ready:
            stuck = sorted(tset - done)
            print("FATAL: the foreign keys contain a cycle; cannot order %d table(s): %s"
                  % (len(stuck), stuck[:10]))
            sys.exit(2)
        t = ready[0]              # `tables` is sorted, so this IS the tie-break
        placed.append(t)
        done.add(t)

    # COMPLETENESS, asserted rather than relied on. The TRUNCATE and the load
    # now both come from plan["tables"], so they cannot diverge -- but say so in
    # code, because "cannot diverge" is exactly what was believed about the
    # stored file.
    if len(placed) != len(tables) or set(placed) != tset:
        print("FATAL: derived order is not the planned table set "
              "(derived %d, planned %d)" % (len(placed), len(tables)))
        sys.exit(2)
    return placed


def psql(sql=None, path=None, quiet=True):
    # The sql files live under /root, which the postgres user cannot read, so the
    # file is opened here (as root) and handed over on stdin rather than by path.
    cmd = ["sudo", "-u", "postgres", "psql", "-d", "tacet", "-tA", "-v", "ON_ERROR_STOP=1"]
    if path:
        with open(path, "rb") as fh:
            p = subprocess.run(cmd, stdin=fh, capture_output=True, text=True)
    else:
        p = subprocess.run(cmd + ["-c", sql], capture_output=True, text=True)
    if p.returncode != 0:
        print(f"\n*** psql FAILED ***\n{p.stderr[:4000]}")
        sys.exit(3)
    return p.stdout


def source_counts():
    con = sqlite3.connect(SRC, uri=True)
    c = {}
    for st in plan["tables"]:
        c[st] = con.execute(f'SELECT COUNT(*) FROM "{st}"').fetchone()[0]
    con.close()
    return c


def source_count(st):
    """Row count for ONE table, read at the moment that table is about to copy.

    The per-table check used to compare a table's load against a count taken
    once at the START of the whole run, up to ~90 seconds earlier. The live app
    keeps writing to SQLite while the copy runs — qingyun_sync_log and
    guanyi_sync_log gain a row every ~20 seconds — so the stale number stopped
    matching and the run aborted on a table that had copied perfectly. That was
    a false positive: it compared a fresh copy against an old count.

    Reading the count here closes the window to the milliseconds between this
    COUNT and the SELECT gen.py runs, and makes the comparison like-for-like.
    """
    con = sqlite3.connect(SRC, uri=True)
    try:
        return con.execute(f'SELECT COUNT(*) FROM "{st}"').fetchone()[0]
    finally:
        con.close()


def sequences():
    out = psql("select sequencename || '\t' || coalesce(last_value::text,'NEVER_CALLED') "
               "from pg_sequences where schemaname='public' order by sequencename;")
    d = {}
    for line in out.splitlines():
        if "\t" in line:
            k, v = line.split("\t", 1)
            d[k] = v
    return d


def main():
    t0 = time.time()

    # FIRST, and before anything is read or emptied. plan.json is a census;
    # this copy takes its SHAPE from it and its CONTENTS from live SQLite, so
    # a table or column added since the census is invisible to the copy AND to
    # verify.py, which builds its comparison from the same cols[]. The guard
    # refuses rather than copying a shape that no longer matches the source.
    # It exits 2 when it cannot see the source at all, which is also a refusal.
    rc = drift_guard.main(quiet=True)
    if rc != 0:
        print("*** aborting before the TRUNCATE: plan.json does not describe the source ***")
        sys.exit(rc)

    order = derive_copy_order()

    # EVERY table in the copy order, unconditionally. This used to filter on
    # plan["tables"][...]["rows"] > 0 -- a count taken 2026-08-03 -- so a table
    # that was empty at census time and has gained rows since was TRUNCATED by
    # the line below and then never refilled, in silence. eleme_sync_queue was
    # one row of that on 2026-08-21; on the night it could be any of the 33.
    #
    # Unconditional rather than "read the live count instead": swapping one
    # derived number for another leaves the same shape, and a count read here
    # can still go stale before the SELECT. An empty table costs one no-op
    # SELECT, a two-line .sql file and one psql call. That is the whole price.
    #
    # This is only SAFE because drift_guard.main() ran above and proved that
    # plan.json and the live source name the same tables.
    todo = list(order)
    print(f"tables to copy: {len(todo)}")

    print("\n--- source row counts at start ---")
    before_counts = source_counts()
    total_src = sum(before_counts[sq_of[t]] for t in todo)
    print(f"total source rows across the {len(todo)} tables: {total_src}")
    # counts_before.json is written AFTER the copy now, from each table's count
    # taken at its own copy moment. final.py calls that number "source at copy
    # time" and compares Postgres against it; fed the start-of-run snapshot it
    # reported the two live sync logs as mismatches for the same stale-count
    # reason this run used to abort on.
    at_copy = {}

    print("\n--- sequence values BEFORE ---")
    seq_before = sequences()
    json.dump(seq_before, open(os.path.join(HERE, "seq_before.json"), "w"), indent=1)
    for k, v in seq_before.items():
        if v != "NEVER_CALLED":
            print(f"  {k} = {v}")
    print(f"  ({sum(1 for v in seq_before.values() if v=='NEVER_CALLED')} sequences never called)")

    print("\n--- truncating target ---")
    all_pg = ", ".join(f'"{x["pg"]}"' for x in plan["tables"].values())
    psql(f"TRUNCATE {all_pg} RESTART IDENTITY CASCADE;")
    # The five rehearsal tables, named THROUGH THE PLAN rather than as literals.
    # This read used to hardcode `accounts`; when that table was renamed the
    # sanity check became `relation "accounts" does not exist`, and psql() turns
    # that into sys.exit(3) -- aborting the run one statement after the TRUNCATE
    # had already emptied the target. The dict KEYS below are SQLite table names,
    # which do not move; the pg names follow whatever the plan currently says.
    REHEARSAL = ["tenants", "users", "suppliers", "purchase_orders", "invoices"]
    parts = " union all ".join(
        f'select count(*) n from "{plan["tables"][t]["pg"]}"' for t in REHEARSAL)
    n = psql(f"select coalesce(sum(n),0) from ({parts}) s;")
    print(f"  truncated; rehearsal tables now hold {n.strip()} rows")

    print("\n--- copy ---")
    timings = []
    os.makedirs(os.path.join(HERE, "sql"), exist_ok=True)
    drift = []
    for i, pt in enumerate(todo, 1):
        st = sq_of[pt]
        tg = time.time()
        # fresh, milliseconds before the SELECT gen.py is about to run
        rows = source_count(st)
        at_copy[st] = rows
        gen.problems.clear()
        gen.main([st], quiet=True)
        if gen.problems:
            print("*** generator halted, aborting run ***")
            sys.exit(1)
        # what the generator actually emitted for this table. Same connection,
        # same SELECT, so this number carries no race at all — Postgres holding
        # anything else is a load error, never drift.
        emitted = json.load(open(os.path.join(HERE, "gen_counts.json"), encoding="utf-8"))[st]
        tgen = time.time() - tg
        path = os.path.join(HERE, "sql", f"{pt}.sql")
        size = os.path.getsize(path)
        tl = time.time()
        psql(path=path)
        tload = time.time() - tl
        os.remove(path)
        got = int(psql(f'select count(*) from "{pt}";').strip())
        if got != emitted:
            ok = f"*** LOAD ERROR: postgres {got} != generated {emitted} ***"
        elif got != rows:
            # a row landed between the COUNT and the SELECT. Sub-millisecond
            # drift, not an error: every row the generator produced did load.
            ok = f"OK (drift {got - rows:+d} since count)"
            drift.append((pt, rows, got))
        else:
            ok = "OK"
        timings.append({"table": pt, "rows": rows, "bytes": size, "generated": emitted,
                        "gen": round(tgen, 2), "load": round(tload, 2), "loaded": got})
        print(f"[{i:>3}/{len(todo)}] {pt:<32} rows={rows:<7} gen={tgen:>6.2f}s "
              f"load={tload:>7.2f}s  {ok}")
        if got != emitted:
            print("*** postgres does not hold what the generator produced, aborting ***")
            sys.exit(1)

    # The order this run ACTUALLY used. copy_order.json used to be the record
    # of that, and losing it was the one real cost of deriving; keeping it on
    # the OUTPUT side preserves the evidence where it cannot drift from what
    # happened. If a copy ever fails in an order-dependent way, this is what
    # says which order it was.
    json.dump(todo, open(os.path.join(HERE, "copy_order_used.json"), "w"), indent=1)
    json.dump(timings, open(os.path.join(HERE, "timings.json"), "w"), indent=1)
    # each table's source count at ITS OWN copy moment — what final.py means by
    # "source at copy time". Tables that were empty and skipped keep their
    # start-of-run count so the file still covers every table.
    json.dump({**before_counts, **at_copy},
              open(os.path.join(HERE, "counts_before.json"), "w"), indent=1)
    print(f"\ncopy finished in {time.time()-t0:.1f}s")

    print(f"\n--- source drift during the copy ---")
    if drift:
        for pt, was, now in drift:
            print(f"  {pt}: {was} at count -> {now} loaded ({now-was:+d})")
        print(f"  {len(drift)} table(s) gained rows between their count and their SELECT.")
        print(f"  Every row the generator produced loaded; nothing was missed.")
    else:
        print("  none — every table's load matched its count exactly")

    bad, report = overrides.check()
    print(f"\n--- override rules ---")
    for k, (got, exp) in report.items():
        print(f"  {k}: fired {got} times (expected {exp}) {'OK' if got == exp else '*** MISMATCH ***'}")
    if bad:
        print("")
        print("*** AN OVERRIDE RULE DID NOT FIRE ON THE ROWS ITS OWN CONDITION MATCHES ***")
        print("")
        print("    READ THIS BEFORE DECIDING ANYTHING. THE COPY ITSELF COMPLETED.")
        print("    Every table loaded, every count matched, and timings.json and")
        print("    counts_before.json are written. What failed is the assertion below,")
        print("    and it runs AFTER the copy because it can only be checked once every")
        print("    value has passed through the generator.")
        print("")
        print("    The expectation is re-derived from the source every run, so this is")
        print("    NOT a stale constant: a rule missed a row it should have caught, or")
        print("    caught one it should not have. Investigate the rule against the rows.")
        print("")
        print("    DO NOT roll back on this alone. The data is in Postgres.")
        sys.exit(1)


if __name__ == "__main__":
    main()
