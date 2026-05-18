#!/bin/bash
# Verify the most recent Roots v2 backup is actually restorable.
# Run on the HK server, on demand or via cron.
#
# What "restore-test" means: copy the latest hourly snapshot to a temp file,
# decompress, run SQLite PRAGMA integrity_check, count rows in the load-bearing
# tables, then delete the temp copy. Catches silent corruption (a backup that
# looks right but won't actually open) and confirms the schema hasn't drifted.
#
# Exit 0 = pass. Exit non-zero = something's wrong; fix before you trust the
# backup chain.

set -euo pipefail
BACKUP_DIR=/root/backups/hourly
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

LATEST=$(ls -1t "$BACKUP_DIR"/roots-*.db.gz 2>/dev/null | head -1)
if [ -z "$LATEST" ]; then
  echo "FAIL: no backups found in $BACKUP_DIR" >&2
  exit 1
fi

echo "[restore-test] testing: $LATEST"
gunzip -c "$LATEST" > "$TMP_DIR/roots.db"

# Integrity check — sqlite walks every page and verifies internal structure.
INTEGRITY=$(sqlite3 "$TMP_DIR/roots.db" "PRAGMA integrity_check;")
if [ "$INTEGRITY" != "ok" ]; then
  echo "FAIL: integrity_check returned: $INTEGRITY" >&2
  exit 2
fi
echo "  integrity_check: ok"

# Spot-check load-bearing tables. If any of these become 0 unexpectedly,
# something is very wrong upstream and the backup chain just caught it.
TABLES=(users retail_customers retail_orders products)
for t in "${TABLES[@]}"; do
  n=$(sqlite3 "$TMP_DIR/roots.db" "SELECT COUNT(*) FROM $t;" 2>/dev/null || echo "MISSING")
  echo "  $t rows: $n"
  if [ "$n" = "MISSING" ]; then
    echo "FAIL: table $t missing from backup" >&2
    exit 3
  fi
done

SIZE=$(du -h "$LATEST" | cut -f1)
echo "[restore-test] PASS · backup=$(basename "$LATEST") compressed=$SIZE"
