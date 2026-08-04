#!/usr/bin/env python3
"""
Run the full copy: truncate the target, then generate, load and time every
non-empty table in the dependency order derived from the Postgres foreign keys.

SQLite is opened read-only throughout. Each table's SQL file is deleted once it
has loaded, so peak disk stays near the size of the largest single table.
"""
import sqlite3, json, os, sys, subprocess, time
import gen, overrides

HERE = os.path.dirname(os.path.abspath(__file__))
plan = json.load(open(os.path.join(HERE, "plan.json"), encoding="utf-8"))
order = json.load(open(os.path.join(HERE, "copy_order.json"), encoding="utf-8"))
SRC = "file:/root/roots-v2/data/roots.db?mode=ro"
sq_of = {t["pg"]: st for st, t in plan["tables"].items()}


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
    todo = [t for t in order if plan["tables"][sq_of[t]]["rows"] > 0]
    print(f"tables to copy: {len(todo)}")

    print("\n--- source row counts at start ---")
    before_counts = source_counts()
    total_src = sum(before_counts[sq_of[t]] for t in todo)
    print(f"total source rows across the {len(todo)} tables: {total_src}")
    json.dump(before_counts, open(os.path.join(HERE, "counts_before.json"), "w"), indent=1)

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
    n = psql("select coalesce(sum(n),0) from (select count(*) n from accounts union all "
             "select count(*) from users union all select count(*) from suppliers union all "
             "select count(*) from purchase_orders union all select count(*) from invoices) s;")
    print(f"  truncated; rehearsal tables now hold {n.strip()} rows")

    print("\n--- copy ---")
    timings = []
    os.makedirs(os.path.join(HERE, "sql"), exist_ok=True)
    for i, pt in enumerate(todo, 1):
        st = sq_of[pt]
        rows = before_counts[st]
        tg = time.time()
        gen.problems.clear()
        gen.main([st], quiet=True)
        if gen.problems:
            print("*** generator halted, aborting run ***")
            sys.exit(1)
        tgen = time.time() - tg
        path = os.path.join(HERE, "sql", f"{pt}.sql")
        size = os.path.getsize(path)
        tl = time.time()
        psql(path=path)
        tload = time.time() - tl
        os.remove(path)
        got = int(psql(f'select count(*) from "{pt}";').strip())
        ok = "OK" if got == rows else f"*** COUNT {got} != {rows} ***"
        timings.append({"table": pt, "rows": rows, "bytes": size,
                        "gen": round(tgen, 2), "load": round(tload, 2), "loaded": got})
        print(f"[{i:>3}/{len(todo)}] {pt:<32} rows={rows:<7} gen={tgen:>6.2f}s "
              f"load={tload:>7.2f}s  {ok}")
        if got != rows:
            print("*** row count mismatch, aborting ***")
            sys.exit(1)

    json.dump(timings, open(os.path.join(HERE, "timings.json"), "w"), indent=1)
    print(f"\ncopy finished in {time.time()-t0:.1f}s")

    bad, report = overrides.check()
    print(f"\n--- override rules ---")
    for k, (got, exp) in report.items():
        print(f"  {k}: fired {got} times (expected {exp}) {'OK' if got == exp else '*** MISMATCH ***'}")
    if bad:
        print("*** override rule fired an unexpected number of times ***")
        sys.exit(1)


if __name__ == "__main__":
    main()
