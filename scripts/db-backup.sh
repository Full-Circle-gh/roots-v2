#!/bin/bash
# Nightly off-site backup of the live SQLite databases to Aliyun OSS.
#
# Complements (does NOT replace) /root/scripts/roots-backup.sh, which keeps
# LOCAL hourly/daily gzipped snapshots of roots.db only. This one is the
# OFF-SITE tier: it also covers the per-tenant databases, verifies every
# snapshot with PRAGMA integrity_check before anything leaves the box, and
# pages ops through the app's existing System Alerts webhook on any failure.
#
# Snapshots are taken with sqlite3's online .backup API. A plain cp is NEVER
# used: roots.db and tenants/5.db both carry a live WAL, so a byte copy of the
# main file alone would be torn/stale (5.db is 4KB on disk with ~2.8MB in WAL).
#
# Layout:  oss://tacet/daily/<YYYYmmdd-HHMMSS>/<name>.db
# Retention: prefixes under daily/ older than RETAIN_DAYS are deleted (see below).

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
TOTAL_BYTES=0

log_line() {
  # timestamp | status | object count | total bytes
  mkdir -p "$(dirname "$LOG")"
  echo "$(date -Iseconds) $1 objects=$2 bytes=$3 date=$DATE${4:+ reason=$4}" >> "$LOG"
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
[ -x "$OSS" ] || fail "ossutil missing at $OSS"

# Sweep working copies abandoned by an earlier failed run. They are kept on
# purpose for manual recovery, but must not accumulate: roots.db alone is ~500MB.
find "$WORK" -maxdepth 1 -name '*-????????-??????.db' -mtime "+$STALE_TMP_DAYS" -delete 2>/dev/null || true

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

# --- snapshot + verify -------------------------------------------------------
# Note: sqlite3 .backup happily copies a corrupt source (it returns 0), so the
# integrity_check below is the real gate, not a formality.
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
  echo "[db-backup] $name integrity=ok size=$(stat -c%s "$dst")"
done

# --- upload + verify ---------------------------------------------------------
for i in "${!SRCS[@]}"; do
  name="${NAMES[$i]}"
  dst="$WORK/${name%.db}-$DATE.db"
  target="oss://$BUCKET/daily/$DATE/$name"

  "$OSS" cp -f "$dst" "$target" >/dev/null 2>&1 || fail "upload failed for $name -> $target"

  # Confirm the object really landed before we are allowed to delete /tmp.
  # `|| true` for the same pipefail reason as above.
  remote_size=$("$OSS" stat "$target" 2>/dev/null | awk -F': *' '/^Content-Length/ {print $2}' | tr -d ' \r') || true
  local_size=$(stat -c%s "$dst")
  [ -n "${remote_size:-}" ] || fail "verify failed: $target not found in bucket after upload"
  [ "$remote_size" = "$local_size" ] \
    || fail "verify failed: $name size mismatch (local=$local_size remote=$remote_size)"

  UPLOADED=$((UPLOADED + 1))
  TOTAL_BYTES=$((TOTAL_BYTES + local_size))
  echo "[db-backup] uploaded $target ($local_size bytes, verified)"
done

# --- all verified: only now remove the working copies ------------------------
cleanup_tmp
FILES=()

# --- retention ---------------------------------------------------------------
# Script-side deletion (no bucket lifecycle rule). Age is derived from the
# YYYYmmdd in each prefix name, not from OSS mtime, so a re-upload can never
# make an old set look fresh. Only the daily/ prefix is ever touched.
# NOTE: versioning is enabled on this bucket, so these deletes add delete
# markers; previous NONCURRENT VERSIONS are retained and are NOT pruned here.
CUTOFF=$(date -d "$RETAIN_DAYS days ago" +%Y%m%d)
PRUNED=0
PREFIXES=$("$OSS" ls "oss://$BUCKET/daily/" -d 2>/dev/null \
           | sed -n "s#^oss://$BUCKET/daily/\([0-9]\{8\}-[0-9]\{6\}\)/\$#\1#p" || true)
for p in $PREFIXES; do
  day="${p%%-*}"
  if [ "$day" -lt "$CUTOFF" ]; then
    if "$OSS" rm "oss://$BUCKET/daily/$p/" -r -f >/dev/null 2>&1; then
      PRUNED=$((PRUNED + 1))
      echo "[db-backup] pruned oss://$BUCKET/daily/$p/ (older than $RETAIN_DAYS days)"
    else
      echo "[db-backup] WARNING: prune failed for $p" >&2
    fi
  fi
done

trap - ERR
log_line OK "$UPLOADED" "$TOTAL_BYTES"
echo "[db-backup] OK $UPLOADED objects, $TOTAL_BYTES bytes, pruned=$PRUNED"
exit 0
