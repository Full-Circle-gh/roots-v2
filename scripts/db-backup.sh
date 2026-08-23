#!/bin/bash
# Nightly off-site backup of the live databases to Aliyun OSS — SQLite AND
# PostgreSQL.
#
# Complements (does NOT replace) /root/scripts/roots-backup.sh, which keeps
# LOCAL hourly/daily gzipped snapshots of roots.db only. This one is the
# OFF-SITE tier: it also covers the per-tenant databases and the `tacet`
# PostgreSQL database, verifies every snapshot before anything leaves the box,
# and pages ops through the app's existing System Alerts webhook on any failure.
#
# SQLite snapshots are taken with sqlite3's online .backup API. A plain cp is
# NEVER used: roots.db and tenants/5.db both carry a live WAL, so a byte copy of
# the main file alone would be torn/stale (5.db is 4KB on disk with ~2.8MB in
# WAL).
#
# SQLite snapshots are gzipped before upload. Order matters: integrity_check runs
# on the UNCOMPRESSED copy and must return "ok" BEFORE gzip is allowed to run, so
# a gzip is never made from a source that was not verified first.
#
# Layout:  oss://tacet/daily/<YYYYmmdd-HHMMSS>/<name>.db.gz      (SQLite)
#          oss://tacet/daily/<YYYYmmdd-HHMMSS>/tacet.dump        (PostgreSQL)
#          oss://tacet/daily/<YYYYmmdd-HHMMSS>/roles.sql         (PostgreSQL)
# Retention: prefixes under daily/ older than RETAIN_DAYS are deleted (see below).
#
#
# THE POSTGRES TIER — WHY IT LIVES IN THIS SCRIPT AND NOT ITS OWN
# ---------------------------------------------------------------
# Everything that makes the SQLite tier trustworthy is generic: the flock guard,
# the free-space preflight, the stale-/tmp sweep, the ops alert, the
# upload-then-verify-size loop, the delete-tmp-only-after-everything-verified
# rule, and the prefix-keyed retention pruner. A second script would have to
# reproduce all of it, and the copy would drift — which is the lesson the test
# harness has already had to learn twice. So Postgres is a third source KIND
# here, not a second program.
#
# ROLES ARE PART OF THE BACKUP, NOT AN EXTRA. `pg_dump` is per-database and does
# NOT carry roles; they are cluster-level. The `tacet` dump references the
# `tacet_app` role 304 times in GRANT statements, so restoring it into a cluster
# where that role does not exist produces 304 errors and a database the
# application cannot log into. roles.sql is ~1KB and is uploaded in the same
# prefix, in the same run, so a restore never has to go looking for it.
#
# THE INTEGRITY GATE IS `pg_restore --list`, and it must find a NON-EMPTY table
# of contents. Exit status alone is not enough: pg_restore --list succeeds on a
# valid-but-empty archive, so a dump that produced nothing would sail through a
# status-only check. That is the Postgres equivalent of accepting a torn SQLite
# copy because .backup returned 0.
#
# NO PASSWORD IS USED OR NEEDED. pg_hba.conf grants `local all all peer`, so
# running as the postgres system user authenticates by OS identity over the Unix
# socket. There is deliberately no password in this script, in the repo, in .env
# or in a .pgpass — adding one would be a downgrade, not a convenience.
#
# ORDERING IS DELIBERATE: the SQLite objects are snapshotted, verified AND
# UPLOADED before Postgres is touched at all. Grouping every snapshot first would
# mean a Postgres failure aborts the run before anything reaches the bucket,
# costing the SQLite backup as well. A Postgres failure must never do that.

set -euo pipefail

APP_DIR=/root/roots-v2
SRC_MAIN="$APP_DIR/data/roots.db"
TENANT_DIR="$APP_DIR/data/tenants"
TENANTS="2 4 5 6 7"
BUCKET=tacet
OSS=/usr/local/bin/ossutil
LOG="$APP_DIR/logs/db-backup.log"
LOCK=/var/lock/tacet-db-backup.lock
WORK=/tmp
RETAIN_DAYS=14
MIN_FREE_MB=2048
STALE_TMP_DAYS=2

# --- PostgreSQL --------------------------------------------------------------
# PG_DB empty disables the Postgres tier entirely, so this script stays correct
# on a box where Postgres is not installed.
# ⚠ EMPTY ON PURPOSE SINCE 2026-08-23. The Postgres migration was cancelled and
# the `tacet` cluster was dropped (decisions §24). Setting this back to `tacet`
# with no cluster running makes the preflight below FAIL THE WHOLE RUN — the
# SQLite backups included — because a database it cannot reach is a hard error,
# correctly. The off-site dumps from 08-21/22/23 age out of the 30-day daily
# retention around 2026-09-22; after that there is nothing to restore.
PG_DB=
PG_SUPERUSER=postgres      # peer-auth identity; see the header — no password
PG_DUMP_NAME=tacet.dump    # custom format (-Fc): compressed internally, and
                           # pg_restore can list it, restore selectively, and
                           # restore in parallel. gzip would add nothing —
                           # measured 325,633,343 B for -Fc vs 324,394,798 B
                           # for plain|gzip -9, a 0.4% difference.
PG_ROLES_NAME=roles.sql

# --- overlap guard -----------------------------------------------------------
# Re-exec under flock so two runs (cron + a manual run) can never collide.
# If the lock is held, flock exits non-zero and that becomes our exit status.
if [ "${_DBB_LOCKED:-}" != "1" ]; then
  export _DBB_LOCKED=1
  exec flock -n "$LOCK" "$0" "$@"
fi

DATE=$(date +%Y%m%d-%H%M%S)
FILES=()          # /tmp working copies created so far
UPLOADED=0
TOTAL_BYTES=0     # bytes actually uploaded, i.e. COMPRESSED size
RAW_BYTES=0       # uncompressed size of the same snapshots, for the ratio
PRUNE_SUMMARY=''  # set by the retention block; empty on every path that fails first

log_line() {
  # timestamp | status | object count | total bytes (compressed/uploaded)
  #
  # PRUNE_SUMMARY is appended when the retention block has run. Until 2026-08-11
  # this line carried no prune information at all, so there was no durable record
  # of whether retention had worked — a zero that is printed is a measurement, a
  # zero that is never written down is not. It is empty on every path that fails
  # before retention, so a FAIL line is unchanged.
  mkdir -p "$(dirname "$LOG")"
  echo "$(date -Iseconds) $1 objects=$2 bytes=$3 date=$DATE${4:+ reason=$4}${PRUNE_SUMMARY:+ $PRUNE_SUMMARY}" >> "$LOG"
}

# Reuse the app's existing operator-alert channel (Settings -> Push notifications
# -> System Alerts, a dedicated WeCom group). Never let a failing alert mask the
# original error.
send_alert() {
  local msg="$1"
  ( cd "$APP_DIR" && node -e '
      const { sendOpsAlert, alertEnabled } = require("./lib/ops-alert");
      if (!alertEnabled()) { console.error("[db-backup] ops-alert disabled; not sent"); process.exit(0); }
      sendOpsAlert(process.argv[1]).then(ok => console.error("[db-backup] alert sent=" + ok));
    ' "$msg" ) || echo "[db-backup] WARNING: alert dispatch failed" >&2
}

cleanup_tmp() {
  local f
  for f in "${FILES[@]:-}"; do [ -n "$f" ] && rm -f "$f"; done
}

fail() {
  local reason="$1"
  echo "[db-backup] FAILED: $reason" >&2
  log_line FAIL "$UPLOADED" "$TOTAL_BYTES" "$reason"
  send_alert "Tacet DB backup FAILED $DATE — $reason"
  # /tmp copies are deliberately KEPT on an upload/verify failure so a human can
  # finish the upload by hand; the stale sweep above bounds how long they live.
  exit 1
}

trap 'fail "unexpected error on line $LINENO"' ERR

# --- preflight ---------------------------------------------------------------
command -v sqlite3 >/dev/null 2>&1 || fail "sqlite3 CLI missing"
command -v gzip >/dev/null 2>&1 || fail "gzip missing"
[ -x "$OSS" ] || fail "ossutil missing at $OSS"

# Postgres preflight. Checked BEFORE any SQLite work so a missing tool is
# reported immediately rather than after eleven minutes of snapshotting — but it
# only fails the run when PG_DB is set, so this script still works unchanged on a
# box without Postgres.
if [ -n "${PG_DB:-}" ]; then
  command -v pg_dump >/dev/null 2>&1     || fail "pg_dump missing but PG_DB=$PG_DB is set"
  command -v pg_dumpall >/dev/null 2>&1  || fail "pg_dumpall missing but PG_DB=$PG_DB is set"
  command -v pg_restore >/dev/null 2>&1  || fail "pg_restore missing (needed for the integrity gate)"
  id -u "$PG_SUPERUSER" >/dev/null 2>&1  || fail "system user $PG_SUPERUSER missing (peer auth needs it)"
  sudo -u "$PG_SUPERUSER" psql -Atc "SELECT 1" -d "$PG_DB" >/dev/null 2>&1 \
    || fail "cannot reach PostgreSQL database $PG_DB as $PG_SUPERUSER over the socket"
fi

# Sweep working copies abandoned by an earlier failed run. They are kept on
# purpose for manual recovery, but must not accumulate: roots.db alone is ~500MB
# raw. Both the plain and the gzipped working names are swept.
find "$WORK" -maxdepth 1 \
     \( -name '*-????????-??????.db' -o -name '*-????????-??????.db.gz' \) \
     -mtime "+$STALE_TMP_DAYS" -delete 2>/dev/null || true

FREE_MB=$(df -Pm "$WORK" | awk 'NR==2 {print $4}') || true
[ -n "${FREE_MB:-}" ] || fail "could not determine free space on $WORK"
[ "$FREE_MB" -ge "$MIN_FREE_MB" ] || fail "only ${FREE_MB}MB free on $WORK, need ${MIN_FREE_MB}MB"

# Build the source list: main db + each tenant db.
declare -a SRCS NAMES
SRCS=("$SRC_MAIN");  NAMES=("roots.db")
for t in $TENANTS; do
  SRCS+=("$TENANT_DIR/$t.db"); NAMES+=("tenant-$t.db")
done

for i in "${!SRCS[@]}"; do
  [ -f "${SRCS[$i]}" ] || fail "source database missing: ${SRCS[$i]}"
done

# --- snapshot, verify, then compress -----------------------------------------
# Note: sqlite3 .backup happily copies a corrupt source (it returns 0), so the
# integrity_check below is the real gate, not a formality. Nothing is compressed
# until its own snapshot has passed that gate.
for i in "${!SRCS[@]}"; do
  src="${SRCS[$i]}"; name="${NAMES[$i]}"
  dst="$WORK/${name%.db}-$DATE.db"
  sqlite3 "$src" ".backup '$dst'" || fail "sqlite3 .backup failed for $src"
  FILES+=("$dst")

  # `|| true` is required: under `set -o pipefail` a malformed database makes
  # sqlite3 exit non-zero, which would trip the ERR trap and replace the precise
  # reason below with a useless "unexpected error on line N".
  res=$(sqlite3 "$dst" "PRAGMA integrity_check;" 2>&1 | head -5 | tr '\n' ' ' | sed 's/ *$//') || true
  if [ "$res" != "ok" ]; then
    cleanup_tmp                       # nothing uploaded yet -> safe to clear
    fail "integrity_check failed for $name (from $src): $res"
  fi

  # Verified ok -> now, and only now, compress it. gzip replaces $dst with $dst.gz.
  raw=$(stat -c%s "$dst")
  FILES+=("$dst.gz")
  gzip -f "$dst" || { cleanup_tmp; fail "gzip failed for $name"; }
  gz=$(stat -c%s "$dst.gz")
  RAW_BYTES=$((RAW_BYTES + raw))
  echo "[db-backup] $name integrity=ok raw=$raw gz=$gz"
done

# --- upload + verify ---------------------------------------------------------
for i in "${!SRCS[@]}"; do
  name="${NAMES[$i]}"
  gzf="$WORK/${name%.db}-$DATE.db.gz"
  target="oss://$BUCKET/daily/$DATE/$name.gz"

  "$OSS" cp -f "$gzf" "$target" >/dev/null 2>&1 || fail "upload failed for $name.gz -> $target"

  # Confirm the object really landed before we are allowed to delete /tmp.
  # `|| true` for the same pipefail reason as above.
  remote_size=$("$OSS" stat "$target" 2>/dev/null | awk -F': *' '/^Content-Length/ {print $2}' | tr -d ' \r') || true
  local_size=$(stat -c%s "$gzf")
  [ -n "${remote_size:-}" ] || fail "verify failed: $target not found in bucket after upload"
  [ "$remote_size" = "$local_size" ] \
    || fail "verify failed: $name.gz size mismatch (local=$local_size remote=$remote_size)"

  UPLOADED=$((UPLOADED + 1))
  TOTAL_BYTES=$((TOTAL_BYTES + local_size))
  echo "[db-backup] uploaded $target ($local_size bytes, verified)"
done

# --- all verified: only now remove the working copies ------------------------
cleanup_tmp
FILES=()

# --- PostgreSQL tier ---------------------------------------------------------
# Reached only once every SQLite object is in the bucket and verified, so a
# failure from here on cannot cost the SQLite backup. Same /tmp discipline, same
# upload-then-verify, same alert path.
if [ -n "${PG_DB:-}" ]; then
  pg_dump_file="$WORK/${PG_DB}-$DATE.dump"
  pg_roles_file="$WORK/${PG_DB}-roles-$DATE.sql"
  FILES+=("$pg_dump_file" "$pg_roles_file")

  # -Fc: custom format. Compressed internally, so no gzip step.
  sudo -u "$PG_SUPERUSER" pg_dump -Fc -f "$pg_dump_file" "$PG_DB" \
    || { cleanup_tmp; fail "pg_dump failed for $PG_DB"; }

  # Cluster-level and not carried by pg_dump. Without this the restore errors on
  # every GRANT to tacet_app — see the header.
  sudo -u "$PG_SUPERUSER" pg_dumpall --roles-only -f "$pg_roles_file" \
    || { cleanup_tmp; fail "pg_dumpall --roles-only failed"; }

  # THE INTEGRITY GATE. Two conditions, both required: pg_restore --list must
  # succeed, AND the table of contents must be non-empty. A valid archive that
  # contains nothing passes the first check and fails the second, which is the
  # case a status-only check would wave through.
  # `|| true` so a non-zero exit becomes the precise message below rather than
  # tripping the ERR trap with "unexpected error on line N".
  toc=$(pg_restore --list "$pg_dump_file" 2>&1) || toc=""
  toc_entries=$(printf '%s\n' "$toc" | grep -cvE '^\s*(;|$)' || true)
  if [ -z "$toc" ] || [ "${toc_entries:-0}" -eq 0 ]; then
    cleanup_tmp
    fail "pg_restore --list found no restorable objects in $PG_DUMP_NAME (entries=${toc_entries:-0})"
  fi

  # The roles file must actually carry the application role, for the same reason:
  # a 0-byte or role-less roles.sql would upload happily and be useless.
  grep -q "CREATE ROLE" "$pg_roles_file" \
    || { cleanup_tmp; fail "roles dump contains no CREATE ROLE statements"; }

  pg_raw=$(sudo -u "$PG_SUPERUSER" psql -Atc "SELECT pg_database_size('$PG_DB')" 2>/dev/null || echo 0)
  RAW_BYTES=$((RAW_BYTES + pg_raw))
  echo "[db-backup] $PG_DB toc_entries=$toc_entries dump=$(stat -c%s "$pg_dump_file") roles=$(stat -c%s "$pg_roles_file")"

  for pair in "$pg_dump_file:$PG_DUMP_NAME" "$pg_roles_file:$PG_ROLES_NAME"; do
    src_f="${pair%%:*}"; obj="${pair##*:}"
    target="oss://$BUCKET/daily/$DATE/$obj"
    "$OSS" cp -f "$src_f" "$target" >/dev/null 2>&1 || fail "upload failed for $obj -> $target"

    remote_size=$("$OSS" stat "$target" 2>/dev/null | awk -F': *' '/^Content-Length/ {print $2}' | tr -d ' \r') || true
    local_size=$(stat -c%s "$src_f")
    [ -n "${remote_size:-}" ] || fail "verify failed: $target not found in bucket after upload"
    [ "$remote_size" = "$local_size" ] \
      || fail "verify failed: $obj size mismatch (local=$local_size remote=$remote_size)"

    UPLOADED=$((UPLOADED + 1))
    TOTAL_BYTES=$((TOTAL_BYTES + local_size))
    echo "[db-backup] uploaded $target ($local_size bytes, verified)"
  done

  cleanup_tmp
  FILES=()
fi

# --- retention ---------------------------------------------------------------
# Script-side deletion (no bucket lifecycle rule). Age is derived from the
# YYYYmmdd in each prefix name, not from OSS mtime, so a re-upload can never
# make an old set look fresh. Only the daily/ prefix is ever touched. This keys
# on the <DATE> prefix alone and never on a filename, so it is unaffected by the
# switch from <name>.db to <name>.db.gz.
# NOTE: versioning is enabled on this bucket, so these deletes add delete
# markers; previous NONCURRENT VERSIONS are retained and are NOT pruned here.
# Reclaiming those bytes is the job of the bucket lifecycle rule on daily/.
#
# THIS STEP COULD NOT REPORT ITS OWN FAILURE UNTIL 2026-08-11, and that — not
# the pruning, which works — was the defect. Three ways, all now closed:
#   * `|| true` on the listing swallowed its exit status, so a failed or
#     reformatted listing produced an empty PREFIXES, an unexecuted loop and
#     `pruned=0` — output byte-identical to a healthy run.
#   * A failed delete printed a WARNING to stderr, incremented nothing, set no
#     status and paged nobody, while every other failure here calls fail().
#   * PRUNED never reached db-backup.log, so nothing could be audited after.
#
# THE ERR TRAP IS RELEASED BEFORE THIS BLOCK, DELIBERATELY, and it is the design
# decision rather than a tidy-up. By this point every object is uploaded and
# verified and /tmp is clean: THE BACKUP HAS SUCCEEDED. Nothing retention does
# may change that verdict, because the OK line in db-backup.log is what a later
# reader uses to answer "did we have a backup that night" — and marking a good,
# verified backup FAIL because a listing timed out would answer it wrongly, in
# the direction that causes a restore not to be attempted. A prune problem is
# reported on its OWN terms: its own status field, its own counters, its own ops
# alert on the same channel every other failure uses. Releasing the trap here
# makes that structural rather than dependent on getting every `|| true` right.
trap - ERR

CUTOFF=$(date -d "$RETAIN_DAYS days ago" +%Y%m%d)
PRUNED=0
PRUNE_ELIGIBLE=0
PRUNE_FAILED=0
PRUNE_STATUS=ok

# A LISTING THAT FAILED AND A PREFIX THAT IS LEGITIMATELY EMPTY ARE DIFFERENT
# STATES. Tested rather than swallowed: the status of the listing decides.
if LISTING=$("$OSS" ls "oss://$BUCKET/daily/" -d 2>&1); then
  PREFIXES=$(printf '%s\n' "$LISTING" \
             | sed -n "s#^oss://$BUCKET/daily/\([0-9]\{8\}-[0-9]\{6\}\)/\$#\1#p")
  # AND A THIRD STATE: the command SUCCEEDED and its output no longer parses.
  # That is a format change — an ossutil upgrade, a different listing shape — not
  # an empty bucket, and it must not read as "nothing to do". Discriminated by
  # the listing still containing lines under our own prefix while none of them
  # matched the pattern.
  SEEN=$(printf '%s\n' "$LISTING" | grep -c "^oss://$BUCKET/daily/." || true)
  if [ "$SEEN" -gt 0 ] && [ -z "$PREFIXES" ]; then
    PRUNE_STATUS=failed_parse
  fi
else
  PRUNE_STATUS=failed_listing
  PREFIXES=""
fi

if [ "$PRUNE_STATUS" = ok ]; then
  for p in $PREFIXES; do
    day="${p%%-*}"
    if [ "$day" -lt "$CUTOFF" ]; then
      PRUNE_ELIGIBLE=$((PRUNE_ELIGIBLE + 1))
      if "$OSS" rm "oss://$BUCKET/daily/$p/" -r -f >/dev/null 2>&1; then
        PRUNED=$((PRUNED + 1))
        echo "[db-backup] pruned oss://$BUCKET/daily/$p/ (older than $RETAIN_DAYS days)"
      else
        PRUNE_FAILED=$((PRUNE_FAILED + 1))
        echo "[db-backup] WARNING: prune failed for $p" >&2
      fi
    fi
  done
  if [ "$PRUNE_FAILED" -gt 0 ]; then PRUNE_STATUS=failed_delete; fi
fi

# ONE alert, never one per failed object — the same reason reconcileTier's alert
# carries no customer id: a per-item message would page the group once per
# object and defeat sendOpsAlert's exact-text dedup.
if [ "$PRUNE_STATUS" != ok ]; then
  send_alert "Tacet DB backup $DATE — THE BACKUP SUCCEEDED but RETENTION did not: prune=$PRUNE_STATUS eligible=$PRUNE_ELIGIBLE removed=$PRUNED failed=$PRUNE_FAILED cutoff=$CUTOFF. Old backup sets are NOT being deleted. Check ossutil and the daily/ prefix."
fi

PRUNE_SUMMARY="prune=$PRUNE_STATUS eligible=$PRUNE_ELIGIBLE removed=$PRUNED failed=$PRUNE_FAILED cutoff=$CUTOFF"

log_line OK "$UPLOADED" "$TOTAL_BYTES"
echo "[db-backup] OK $UPLOADED objects, $TOTAL_BYTES bytes uploaded (raw $RAW_BYTES), $PRUNE_SUMMARY"
exit 0
