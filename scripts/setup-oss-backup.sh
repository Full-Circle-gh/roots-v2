#!/bin/bash
# One-time wiring of Aliyun OSS off-site backup on the HK production server.
#
# BEFORE you run this, do the Aliyun-console-side steps below — they protect
# you against the failure mode this whole exercise is about (server gets
# hacked, attacker also wipes the backups):
#
#   1. Create an OSS bucket in a DIFFERENT region from HK (e.g. Singapore
#      oss-ap-southeast-1, or Shenzhen oss-cn-shenzhen). Different region =
#      survives a regional outage or account-region lockdown.
#
#   2. On that bucket, enable:
#        • Versioning (so overwrites/deletes are recoverable)
#        • Server-side encryption (KMS or SSE-OSS, your call)
#        • Lifecycle: move objects >30d old to IA / archive storage class
#                     delete versions >180d old
#        • Optional but ideal: WORM / object retention policy of 30 days --
#          this is what makes ransomware unable to wipe past backups
#
#   3. In RAM, create a SUB-ACCOUNT (do NOT use root keys) with a policy
#      scoped to:
#        - oss:PutObject, oss:GetObject, oss:ListBucket
#        - on this bucket only
#      Generate an AccessKey ID + Secret for that sub-account.
#      Enable 2FA on your root Aliyun account while you're in there.
#
# Then run this script from your laptop:
#   BUCKET=roots-v2-backups REGION=oss-ap-southeast-1 \
#     ssh root@47.239.89.63 BUCKET=$BUCKET REGION=$REGION 'bash -s' < scripts/setup-oss-backup.sh
#
# What it does (idempotent — safe to re-run):
#   1. Downloads the ossutil binary if not already installed
#   2. Writes /etc/roots-backup.env with the bucket + path
#   3. Reminds you to run "ossutil config" once interactively to paste creds
#
# Credentials NEVER pass through this script -- they go into ~/.ossutilconfig
# only via the interactive "ossutil config" prompt you run yourself.

set -euo pipefail

if [ -z "${BUCKET:-}" ]; then
  echo "ERROR: BUCKET env var is required (e.g. BUCKET=roots-v2-backups)" >&2
  exit 1
fi
REGION="${REGION:-oss-ap-southeast-1}"
PATH_PREFIX="${OSS_PATH:-roots-backups/}"

echo "-> Bucket:   $BUCKET"
echo "-> Region:   $REGION"
echo "-> Path:     $PATH_PREFIX"
echo

# 1. Install ossutil if missing
if ! command -v ossutil >/dev/null 2>&1; then
  echo "-> ossutil not found, downloading..."
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64|amd64) URL="https://gosspublic.alicdn.com/ossutil/1.7.18/ossutil64" ;;
    aarch64|arm64) URL="https://gosspublic.alicdn.com/ossutil/1.7.18/ossutilarm64" ;;
    *) echo "ERROR: unsupported architecture: $ARCH" >&2; exit 1 ;;
  esac
  curl -fsSL "$URL" -o /usr/local/bin/ossutil
  chmod +x /usr/local/bin/ossutil
  echo "  installed: $(/usr/local/bin/ossutil --version 2>/dev/null | head -1 || echo 'ossutil')"
else
  echo "-> ossutil already installed: $(ossutil --version 2>/dev/null | head -1 || echo 'present')"
fi

# 2. Write /etc/roots-backup.env (config only -- no secrets)
cat > /etc/roots-backup.env <<EOF
# Roots v2 -- off-site backup target. Read by /root/scripts/roots-backup.sh.
# Credentials live in /root/.ossutilconfig (set by "ossutil config"), NOT here.
OSS_BUCKET=$BUCKET
OSS_PATH=$PATH_PREFIX
OSS_REGION=$REGION
EOF
chmod 600 /etc/roots-backup.env
echo "-> wrote /etc/roots-backup.env"

echo
echo "===================================================================="
echo "OSS wiring done. NEXT: paste your AccessKey credentials interactively"
echo
echo "    ssh root@47.239.89.63 'ossutil config'"
echo
echo "  When prompted:"
echo "    Endpoint:          https://${REGION}.aliyuncs.com"
echo "    AccessKey ID:      <paste from Aliyun console>"
echo "    AccessKey Secret:  <paste from Aliyun console>"
echo "    STS Token:         <leave blank, press enter>"
echo
echo "Then test the full pipeline:"
echo "    ssh root@47.239.89.63 '/root/scripts/roots-backup.sh && tail -2 /var/log/roots-backup.log'"
echo
echo "Expected log line ending: offsite=uploaded -> oss://${BUCKET}/${PATH_PREFIX}..."
echo "===================================================================="
