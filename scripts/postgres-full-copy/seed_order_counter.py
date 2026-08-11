#!/usr/bin/env python3
"""
Seed retail_order_counters above the highest existing order number.

WHY THIS IS ITS OWN STEP AND NOT PART OF setseq.py

setseq.py will never see this counter, and not because of a lookup that comes
back empty — because a counter row is not a sequence at all. That script walks
plan.json for columns marked `identity`, resolves each one's sequence with
pg_get_serial_sequence, and calls setval. retail_order_counters has no identity
column, owns no sequence, and appears in plan.json not at all: plan.json
describes the 162 tables copied from SQLite, and this table exists only in
Postgres. There is no path through that script that reaches this row.

WHERE THIS SITS IN THE CUTOVER

LAST. After the fresh data copy AND after the delta pass, immediately before
traffic moves. Seeding is not a step of the schema build.

Measured 2026-08-11: Postgres held 168 TC orders while SQLite held 247. A
counter seeded from the 2026-08-04 copy would sit 79 short, and the first 79
checkouts after the flip would collide one after another on
retail_orders_order_no_key.

WHERE THE MAXIMUM IS READ FROM, AND WHY IT IS POSTGRES

From Postgres, not from SQLite. By the time this runs, Postgres holds every
order the flip is going to carry, and it is the database whose UNIQUE
constraint enforces the result. Reading from SQLite would reintroduce exactly
the gap this step exists to close: any row that failed to copy would be counted
in the seed but absent from the table the constraint guards.

WHAT THIS SCRIPT WILL NOT DO

It will not create the table or the row. That is docs/tacet-postgres-order-counter.sql,
run by hand. A seeding step that quietly creates schema when it finds none is
how a schema ends up with two sources of truth that disagree.

It cannot lower the counter. The UPDATE is GREATEST-guarded, so re-running it
after a second delta pass can only raise the value. That makes it safe to run
more than once, which the ordering rule practically requires.
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERIES = "TC"


def psql(sql):
    p = subprocess.run(["sudo", "-u", "postgres", "psql", "-d", "tacet", "-tA",
                        "-v", "ON_ERROR_STOP=1", "-c", sql],
                       capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"psql failed:\n{p.stderr}")
    return p.stdout.strip()


# ── Preconditions, both fatal ───────────────────────────────────────────────
# Neither is defensive noise. A missing table means the DDL was never run and
# every later line here would be measuring nothing; a missing row means the
# application's UPDATE would match nothing and RETURNING would hand the caller
# an absent order number rather than an error.

if psql("SELECT to_regclass('public.retail_order_counters');") == "":
    raise SystemExit(
        "FATAL: retail_order_counters does not exist.\n"
        "Run docs/tacet-postgres-order-counter.sql against the tacet database first.\n"
        "This script seeds the counter; it does not create it."
    )

before = psql(f"SELECT last_no FROM retail_order_counters WHERE series = '{SERIES}';")
if before == "":
    raise SystemExit(
        f"FATAL: retail_order_counters has no '{SERIES}' row.\n"
        "The DDL file creates it at 0. Run that file rather than inserting by hand."
    )
before = int(before)

# ── The measurement ─────────────────────────────────────────────────────────
# The regex, not LIKE 'TC______'. The LIKE form is width-locked to exactly
# eight characters and would silently exclude a 7-digit number, seeding BELOW
# the true maximum — the precise failure this step exists to prevent. The cast
# to bigint keeps the comparison numeric, so no text collation is involved.

measured = int(psql(
    "SELECT COALESCE(MAX(substring(order_no from 3)::bigint), 0) "
    "FROM retail_orders WHERE order_no ~ '^TC[0-9]+$';"
))
total = int(psql("SELECT COUNT(*) FROM retail_orders WHERE order_no ~ '^TC[0-9]+$';"))

# ── The seed ────────────────────────────────────────────────────────────────

# The UPDATE's own output is deliberately ignored and the value is read back
# with a separate SELECT. `psql -tA` prints the command tag ("UPDATE 1") after
# a RETURNING row, so parsing the write's stdout gets "168\nUPDATE 1" and dies
# — found by running this script rather than by reading it. setseq.py never met
# this because it only ever issues SELECTs.
#
# Two statements are two connections and therefore not one atomic unit. That is
# fine HERE and nowhere else: this runs before traffic moves, so nothing else
# is writing the row, and the UPDATE is GREATEST-guarded regardless. The SELECT
# is a receipt, not a check-then-act.

psql(
    "UPDATE retail_order_counters c "
    "   SET last_no = GREATEST(c.last_no, COALESCE(( "
    "           SELECT MAX(substring(o.order_no from 3)::bigint) "
    "             FROM retail_orders o "
    "            WHERE o.order_no ~ '^TC[0-9]+$' "
    "       ), 0)), "
    "       updated_at = now() "
    f" WHERE c.series = '{SERIES}';"
)
after = int(psql(f"SELECT last_no FROM retail_order_counters WHERE series = '{SERIES}';"))

receipt = {
    "series": SERIES,
    "before": before,
    "measured_max": measured,
    "after": after,
    "orders_counted": total,
    "moved": after != before,
}
with open(os.path.join(HERE, "order_counter_seed.json"), "w") as fh:
    json.dump(receipt, fh, indent=1)

print(f"series          {SERIES}")
print(f"counter before  {before}")
print(f"measured max    {measured}   (over {total} matching orders in Postgres)")
print(f"counter after   {after}")
print(f"next order      {SERIES}{after + 1:06d}")

# ── The one thing worth failing over ────────────────────────────────────────
# A counter already ahead of the measured maximum means orders have been minted
# on Postgres that this measurement cannot see — which means traffic has
# already moved and this step is running after the flip rather than before it.
# GREATEST has kept the value safe, so nothing is broken; but the ordering rule
# has been broken, and that is worth a non-zero exit rather than a line of
# output nobody reads.

if before > measured:
    print(
        f"\nWARNING: the counter was already ahead of the data ({before} > {measured}).\n"
        "Orders have minted on Postgres that this measurement cannot see, so traffic\n"
        "has already moved. The value is safe — GREATEST cannot lower it — but this\n"
        "step is meant to run BEFORE the flip, not after. Check the runbook ordering.",
        file=sys.stderr,
    )
    sys.exit(1)

if not receipt["moved"] and measured > 0:
    print("\nnote: the counter was already at the measured maximum — nothing to raise.")
