#!/bin/bash
# Rehearse the money migration against a COPY of production (audit A-06).
#
# WHAT THIS IS FOR
# ----------------
# Converting money columns to integers is a change nothing in the schema can
# check. A column that comes out 100× wrong is still a valid number and every
# report built on it still renders. So the only way to know a conversion was
# faithful is to measure the database before, measure it after, and require the
# two to agree — and to do that somewhere it does not matter first.
#
# This script is the somewhere. It restores the latest hourly snapshot to a
# scratch file, records the baseline, migrates the scratch, and gates the result
# against that baseline. Production is never opened.
#
# RUN IT ON THE SERVER. The snapshots live at /root/backups/hourly, written by
# scripts/db-backup.sh through sqlite3's online .backup API.
#
#   bash scripts/rehearse-money-migration.sh                    the refund family
#   bash scripts/rehearse-money-migration.sh customers          another family
#   bash scripts/rehearse-money-migration.sh refunds /path/to/a.db.gz
#
# WHAT TO SEND BACK
# -----------------
# The whole output. The interesting parts are the baseline's failure set — some
# invariants may already be red today, and that is a finding about the data
# rather than about the migration — and whether the gate at the end says nothing
# moved. Both matter; neither can be inferred from the other.
#
# EXIT 0 = the rehearsal held. Anything else = do not run this on production.

set -uo pipefail

FAMILY="${1:-refunds}"
SNAPSHOT="${2:-}"
BACKUP_DIR=/root/backups/hourly
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK=$(mktemp -d)
trap 'echo; echo "[rehearsal] scratch left at $WORK for inspection — remove it when done."' EXIT

echo "════════════════════════════════════════════════════════════════════════"
echo "MONEY MIGRATION REHEARSAL · family \"$FAMILY\""
echo "════════════════════════════════════════════════════════════════════════"

# ── 1. a copy, and only a copy ────────────────────────────────────────────
if [ -z "$SNAPSHOT" ]; then
  SNAPSHOT=$(ls -1t "$BACKUP_DIR"/roots-*.db.gz 2>/dev/null | head -1)
  if [ -z "$SNAPSHOT" ]; then
    echo "FAIL: no snapshot in $BACKUP_DIR, and none given as the second argument." >&2
    echo "  Pass one:  bash $0 $FAMILY /path/to/roots.db.gz" >&2
    exit 2
  fi
fi
echo
echo "1/5  restoring $SNAPSHOT"
case "$SNAPSHOT" in
  *.gz) gunzip -c "$SNAPSHOT" > "$WORK/copy.db" ;;
  *)    cp "$SNAPSHOT" "$WORK/copy.db" ;;
esac
# A corrupt snapshot would produce a migration failure that looks like a
# migration bug, which is the most expensive kind of wrong answer here.
#
# Through NODE rather than the sqlite3 CLI, deliberately: every other step here
# is node, and scripts/restore-test.sh's dependency on the command-line tool is
# a second thing that has to be installed for one PRAGMA. This runs anywhere the
# migration itself can run, which is the only place it is worth running.
INTEGRITY=$(node -e '
  try {
    const D = require("better-sqlite3");
    const db = new D(process.argv[1], { readonly: true });
    process.stdout.write(db.prepare("PRAGMA integrity_check").get().integrity_check);
    db.close();
  } catch (e) { process.stdout.write("unreadable: " + String(e.message).split("\n")[0]); }
' "$WORK/copy.db" 2>/dev/null || echo "unreadable")
if [ "$INTEGRITY" != "ok" ]; then
  echo "FAIL: the snapshot itself is not sound — integrity_check said: $INTEGRITY" >&2
  echo "  Nothing below would mean anything. Try an older snapshot." >&2
  exit 2
fi
echo "     integrity_check: ok   ($(du -h "$WORK/copy.db" | cut -f1))"

# ── 2. the baseline, BEFORE anything changes ──────────────────────────────
# This is the step it would be easiest to skip and most expensive to have
# skipped: without it, every pre-existing discrepancy gets attributed to the
# migration and the migration gets rolled back for a bug it did not cause.
echo
echo "2/5  recording the baseline"
node "$HERE/scripts/check_money_invariants.js" --db "$WORK/copy.db" --json > "$WORK/before.json"
BASE_RC=$?
node "$HERE/scripts/check_money_invariants.js" --db "$WORK/copy.db" | sed 's/^/     /'
echo "     baseline written to $WORK/before.json (exit $BASE_RC)"
echo "     ↑ ANY FAILURE ABOVE IS TODAY'S DATA, NOT THE MIGRATION. Read it and keep it."

# ── 3. what it would do ───────────────────────────────────────────────────
echo
echo "3/5  the plan"
node "$HERE/scripts/migrate_money.js" --db "$WORK/copy.db" --family "$FAMILY" | sed 's/^/     /'

# ── 4. do it, on the copy ─────────────────────────────────────────────────
echo
echo "4/5  migrating the copy"
node "$HERE/scripts/migrate_money.js" --db "$WORK/copy.db" --family "$FAMILY" --apply | sed 's/^/     /'
APPLY_RC=$?
if [ $APPLY_RC -ne 0 ]; then
  echo "FAIL: the migration itself did not complete (exit $APPLY_RC)." >&2
  exit 1
fi
echo
echo "     proving the backfill"
node "$HERE/scripts/migrate_money.js" --db "$WORK/copy.db" --family "$FAMILY" --verify | sed 's/^/     /'
VERIFY_RC=$?

# ── 5. the gate ───────────────────────────────────────────────────────────
# Not "does everything pass" — "did anything MOVE". A check that was already red
# stays red and says so; a check that goes red because of the migration fails.
echo
echo "5/5  against the baseline"
node "$HERE/scripts/check_money_invariants.js" --db "$WORK/copy.db" --baseline "$WORK/before.json" | sed 's/^/     /'
GATE_RC=$?

echo
echo "════════════════════════════════════════════════════════════════════════"
if [ $VERIFY_RC -eq 0 ] && [ $GATE_RC -eq 0 ]; then
  echo "REHEARSAL HELD · family \"$FAMILY\""
  echo "  every new value equals its source, and nothing else in the database moved."
  echo "  Send this whole output back before anything runs on production."
  exit 0
fi
echo "REHEARSAL FAILED · family \"$FAMILY\"   (verify=$VERIFY_RC gate=$GATE_RC)"
echo "  DO NOT RUN THIS ON PRODUCTION. Send this whole output back."
exit 1
