#!/bin/bash
# Install an hourly backup cron on the HK production server.
# Run from your laptop:
#   ssh root@47.239.89.63 'bash -s' < scripts/install-backup-cron.sh
#
# What it sets up:
#   • /root/scripts/roots-backup.sh — the backup script
#   • Cron at the top of every hour
#   • /root/backups/hourly/  — last 48 hourly snapshots (~2 days, fast restore)
#   • /root/backups/daily/   — last 30 daily snapshots (longer history)
#   • Optional OSS upload of the *daily* copy (cheap; hourly stays local)
#
# Idempotent — safe to re-run after edits.

set -euo pipefail

mkdir -p /root/scripts /root/backups/hourly /root/backups/daily

cat > /root/scripts/roots-backup.sh <<'SCRIPT'
#!/bin/bash
# Hourly backup of the Roots v2 SQLite database.
#
# Tiers:
#   • hourly/ — every run; retains the most recent 48 snapshots
#   • daily/  — first run of each calendar day promotes that hourly snapshot;
#               retains the most recent 30 days
#
# Uses sqlite3's online .backup API for a consistent snapshot even while pm2
# is writing (WAL-safe). Falls back to cp + WAL/SHM companion copies if the
# sqlite3 CLI is missing — still safe under WAL journal mode, just less
# guaranteed; the log line flags which method was used.
#
# Off-site upload (Aliyun OSS): if /etc/roots-backup.env exists with
# OSS_BUCKET set AND ossutil is installed AND credentials are configured
# (~/.ossutilconfig — set up once via "ossutil config"), the *daily* copy is
# pushed to OSS. Hourly snapshots stay local for fast restore. Upload
# failures log a warning but never fail the local backup.
set -euo pipefail
SRC=/root/roots-v2/data/roots.db
BASE=/root/backups
TS=$(date +%Y%m%d-%H%M%S)
TODAY=$(date +%Y%m%d)
HOURLY_DEST="$BASE/hourly/roots-$TS.db"
DAILY_DEST="$BASE/daily/roots-$TODAY.db.gz"
mkdir -p "$BASE/hourly" "$BASE/daily"

if [ ! -f "$SRC" ]; then
  echo "[backup] ERROR: source db missing: $SRC" >&2
  exit 1
fi

if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$SRC" ".backup '$HOURLY_DEST'"
  METHOD="sqlite3 .backup"
else
  cp -p "$SRC" "$HOURLY_DEST"
  [ -f "$SRC-wal" ] && cp -p "$SRC-wal" "$HOURLY_DEST-wal"
  [ -f "$SRC-shm" ] && cp -p "$SRC-shm" "$HOURLY_DEST-shm"
  METHOD="cp (apt-get install sqlite3 for stronger guarantees)"
fi

gzip -f "$HOURLY_DEST"
HOURLY_DEST="$HOURLY_DEST.gz"
[ -f "${HOURLY_DEST%.gz}-wal" ] && rm -f "${HOURLY_DEST%.gz}-wal"
[ -f "${HOURLY_DEST%.gz}-shm" ] && rm -f "${HOURLY_DEST%.gz}-shm"

# Promote first hourly of each day into the daily tier
DAILY_STATUS="skipped (already exists)"
if [ ! -f "$DAILY_DEST" ]; then
  cp -p "$HOURLY_DEST" "$DAILY_DEST"
  DAILY_STATUS="promoted -> $(basename "$DAILY_DEST")"
fi

# Retention: keep most recent 48 hourly + 30 daily
ls -1t "$BASE/hourly"/roots-*.db.gz 2>/dev/null | tail -n +49 | xargs -r rm -f
ls -1t "$BASE/daily"/roots-*.db.gz  2>/dev/null | tail -n +31 | xargs -r rm -f

# Optional off-site push of the daily copy
OSS_STATUS="local-only"
if [ -f /etc/roots-backup.env ]; then
  # shellcheck source=/dev/null
  set +u; . /etc/roots-backup.env; set -u
  if [ -n "${OSS_BUCKET:-}" ] && command -v ossutil >/dev/null 2>&1; then
    OSS_PATH="${OSS_PATH:-roots-backups/}"
    if [ -f "$DAILY_DEST" ]; then
      OSS_TARGET="oss://${OSS_BUCKET}/${OSS_PATH%/}/$(basename "$DAILY_DEST")"
      if ossutil cp -f "$DAILY_DEST" "$OSS_TARGET" >/dev/null 2>&1; then
        OSS_STATUS="uploaded -> $OSS_TARGET"
      else
        OSS_STATUS="OSS upload FAILED -- check ossutil config and bucket permissions"
      fi
    fi
  elif [ -n "${OSS_BUCKET:-}" ]; then
    OSS_STATUS="OSS configured but ossutil not installed"
  fi
fi

echo "[backup] $(date -Iseconds) hourly=$(basename "$HOURLY_DEST") size=$(du -h "$HOURLY_DEST" | cut -f1) method=$METHOD daily=$DAILY_STATUS offsite=$OSS_STATUS"
SCRIPT

chmod +x /root/scripts/roots-backup.sh

# Cron entry: every hour on the hour. Idempotent — replaces any prior line
# referencing roots-backup.sh.
CRON_LINE="0 * * * * /root/scripts/roots-backup.sh >> /var/log/roots-backup.log 2>&1"
( crontab -l 2>/dev/null | grep -v 'roots-backup.sh' || true ; echo "$CRON_LINE" ) | crontab -

# Make sure sqlite3 CLI is present for the strong-snapshot path.
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "-> installing sqlite3 CLI (apt) for consistent snapshots..."
  apt-get update -qq && apt-get install -y -qq sqlite3 || \
    echo "  WARNING: apt install sqlite3 failed; script will fall back to cp"
fi

echo
echo "Installed: /root/scripts/roots-backup.sh"
echo "Cron registered (hourly):"
crontab -l | grep roots-backup.sh
echo
echo "Run it once now to verify:"
echo "  /root/scripts/roots-backup.sh"
echo "Then check /root/backups/hourly/ and /root/backups/daily/."
