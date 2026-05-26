#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# rollback.sh — undo the last deploy. RUN ON THE PRODUCTION SERVER.
#
# deploy-apply.sh backs up the live copy of every file it overwrites into
# /root/backups/deploy-<timestamp>/ before installing. This restores the most
# recent such backup (or a named one) and restarts roots-v2 — recovering from a
# deploy that installed cleanly but is wrong/broken in the browser (the case
# the crash-loop auto-rollback can't see, because the process stays "online").
#
# Trigger from your machine (the one that deploys):
#   ssh root@47.239.89.63 "bash /root/roots-v2/scripts/rollback.sh"           # newest
#   ssh root@47.239.89.63 "bash /root/roots-v2/scripts/rollback.sh --list"    # show recent
#   ssh root@47.239.89.63 "bash /root/roots-v2/scripts/rollback.sh deploy-20260525-123733"
#
# Note: a backup only contains files that deploy OVERWROTE, so restoring it
# returns those files to their pre-deploy state. It can't un-create a brand-new
# file (deploys here overwrite existing files, so this is rarely an issue).
# ─────────────────────────────────────────────────────────────────────────
set -u
APP=/root/roots-v2
BKROOT=/root/backups

st(){ pm2 jlist | node -e 'let d=JSON.parse(require("fs").readFileSync(0));let p=d.find(x=>x.name=="roots-v2");process.stdout.write(p?p.pm2_env.status:"missing")'; }

if [ "${1:-}" = "--list" ]; then
  echo "Recent deploy backups (newest first):"
  ls -1dt "$BKROOT"/deploy-* 2>/dev/null | head -20 | sed "s|$BKROOT/||" || echo "  (none)"
  exit 0
fi

if [ -n "${1:-}" ]; then BK="$BKROOT/$1"; else BK=$(ls -1dt "$BKROOT"/deploy-* 2>/dev/null | head -1); fi
[ -n "$BK" ] && [ -d "$BK" ] || { echo "ABORT: no backup found ($BK). Try --list."; exit 1; }

echo "Rolling back from: $BK"
mapfile -t FILES < <(cd "$BK" && find . -type f | sed 's|^\./||')
[ ${#FILES[@]} -eq 0 ] && { echo "ABORT: backup is empty"; exit 1; }
printf '  restore %s\n' "${FILES[@]}"
for f in "${FILES[@]}"; do mkdir -p "$APP/$(dirname "$f")"; cp "$BK/$f" "$APP/$f"; done

echo "restarting roots-v2…"
pm2 restart roots-v2 --update-env >/dev/null; sleep 3
echo "restored. status = $(st)"
echo "RESULT=ROLLED_BACK from=$BK"
