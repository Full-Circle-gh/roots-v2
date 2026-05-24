#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# deploy-apply.sh — safe install of staged files into the live roots-v2 app.
#
# Run this ON THE PRODUCTION SERVER (root@47.239.89.63, app `roots-v2`).
# It expects changed files to be staged under /root/roots-v2/__stage__/ at the
# SAME relative paths they have in the app, e.g.:
#     __stage__/database.js
#     __stage__/routes/retail.js
#     __stage__/public/retail-admin.html
#
# Sequence: syntax-check staged .js  ->  back up live copies  ->  install
#   ->  pm2 restart roots-v2  ->  health-check (auto-rollback on crash-loop).
# A pm2 restart reloads the WHOLE backend, so the syntax gate + rollback are
# what keep a bad file from taking the entire live site down.
# ─────────────────────────────────────────────────────────────────────────
set -u
APP=/root/roots-v2
STAGE=$APP/__stage__
TS=$(date +%Y%m%d-%H%M%S)
BK=/root/backups/deploy-$TS

rt(){ pm2 jlist | node -e 'let d=JSON.parse(require("fs").readFileSync(0));let p=d.find(x=>x.name=="roots-v2");process.stdout.write(""+(p?p.pm2_env.restart_time:-1))'; }
st(){ pm2 jlist | node -e 'let d=JSON.parse(require("fs").readFileSync(0));let p=d.find(x=>x.name=="roots-v2");process.stdout.write(p?p.pm2_env.status:"missing")'; }

[ -d "$STAGE" ] || { echo "ABORT: no staging dir $STAGE"; exit 1; }
mapfile -t FILES < <(cd "$STAGE" && find . -type f | sed 's|^\./||')
[ ${#FILES[@]} -eq 0 ] && { echo "ABORT: $STAGE is empty"; exit 1; }
echo "staged files:"; printf '  %s\n' "${FILES[@]}"

echo "=== 1/4 syntax-check staged .js (live files untouched) ==="
for f in "${FILES[@]}"; do case "$f" in *.js) node --check "$STAGE/$f" || { echo "ABORT: $f syntax error"; exit 1; };; esac; done
echo "OK"

# Stamp the service-worker cache version on any deploy that ships sw.js, so every
# client reliably evicts its old shell (the SW activate handler drops all caches
# != current). Removes the "I deployed but it didn't go live" gap that a forgotten
# manual CACHE bump used to cause.
if [ -f "$STAGE/public/sw.js" ]; then
  sed -i -E "s/(const CACHE = 'roots-v2-shell)[^']*(';)/\1-$TS\2/" "$STAGE/public/sw.js"
  node --check "$STAGE/public/sw.js" || { echo "ABORT: sw.js cache-stamp broke syntax"; exit 1; }
  echo "stamped sw.js CACHE -> roots-v2-shell-$TS"
fi

echo "=== 2/4 back up live copies -> $BK ==="
for f in "${FILES[@]}"; do if [ -f "$APP/$f" ]; then mkdir -p "$BK/$(dirname "$f")"; cp "$APP/$f" "$BK/$f"; fi; done
echo "OK"

BEFORE=$(rt)
echo "=== 3/4 install (restart_time before = $BEFORE) ==="
for f in "${FILES[@]}"; do mkdir -p "$APP/$(dirname "$f")"; cp "$STAGE/$f" "$APP/$f"; echo "  -> $f"; done

echo "=== 4/4 restart roots-v2 ==="
pm2 restart roots-v2 --update-env >/dev/null
sleep 4
AFTER=$(rt); ST=$(st)
echo "restart_time $BEFORE -> $AFTER | status = $ST"

if [ "$ST" != "online" ] || [ "$AFTER" -gt "$((BEFORE+1))" ]; then
  echo "!!! UNHEALTHY (not online or crash-looping) -> ROLLING BACK"
  for f in "${FILES[@]}"; do [ -f "$BK/$f" ] && cp "$BK/$f" "$APP/$f"; done
  pm2 restart roots-v2 --update-env >/dev/null; sleep 3
  echo "rolled back. status now = $(st)"
  echo "--- error log tail ---"; tail -n 30 /root/.pm2/logs/roots-v2-error.log
  echo "RESULT=ROLLED_BACK"; exit 2
fi

echo "--- recent out log ---"; tail -n 6 /root/.pm2/logs/roots-v2-out.log
rm -rf "$STAGE"
echo "RESULT=SUCCESS backup=$BK"
