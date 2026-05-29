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

echo "=== 1/4 syntax-check staged .js + .html inline scripts (live files untouched) ==="
HTML_CHECK="$APP/scripts/check-html-js.js"
for f in "${FILES[@]}"; do
  case "$f" in
    *.js)
      node --check "$STAGE/$f" || { echo "ABORT: $f syntax error"; exit 1; }
      ;;
    *.html)
      # Inline <script> in .html ships otherwise-unchecked, and a syntax error
      # there kills the whole page. Gate it too. Guard against the bootstrap
      # commit that first installs the checker (it won't exist yet).
      if [ -f "$HTML_CHECK" ]; then
        node "$HTML_CHECK" "$STAGE/$f" || { echo "ABORT: $f inline-script syntax error"; exit 1; }
      else
        echo "  (skip inline-JS check — checker not on server yet) $f"
      fi
      ;;
  esac
done
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

echo "=== 4/4 restart roots-v2 + verify health ==="
pm2 restart roots-v2 --update-env >/dev/null

# Health verdict. This REPLACES the old brittle "restart_time must be exactly
# BEFORE+1" check, which false-rolled-back a perfectly healthy deploy on
# 2026-05-29 when a transient pushed the count 648->650 instead of 649 (a good
# commit lost, then re-shipped identical with a clean 652->653). A single extra
# restart inside the wait window — cron blip, overlapping deploy — is NOT a
# crash. So instead of counting restarts, we confirm GENUINE stability + real
# serving, and roll back ONLY if the app is not online, not serving, or still
# crash-restarting at the end of the window:
#   * SETTLED — restart_time STOPS climbing across a quiet window. A real crash
#               loop never settles (pm2 keeps respawning every min_uptime); a
#               one-off transient settles within a round or two.
#   * ONLINE  — pm2 reports status "online".
#   * SERVING — the app answers HTTP on :4000 (it 302s on /). ANY HTTP status
#               counts as serving; "000" = connection refused/timeout = dead.
sleep 5
LAST=$(rt)
STABLE=0
for _ in 1 2 3; do
  sleep 5
  CUR=$(rt)
  if [ "$CUR" = "$LAST" ]; then STABLE=1; break; fi
  LAST=$CUR
done
AFTER=$LAST
ST=$(st)

# Readiness probe. A process that merely accepts a socket isn't enough — its
# real routes must answer without throwing. We probe a handful of public,
# GET-only, side-effect-free paths:
#   /                       — base (302 redirect; "is the process answering?")
#   /api/retail/categories  — a trivial tenant-DB read
#   /api/retail/config      — config load + DB (its own catch 500s if broken)
#   /api/retail/products    — the storefront grid query, the critical read path
# Unscoped localhost requests resolve to the shared Roots DB (tdb() -> mainDb),
# so all four answer 200/302 on a healthy box. A path is BROKEN only if it
# returns "000" (connection refused/timeout — the process isn't answering) or a
# 5xx (the handler threw — exactly the breakage a bad deploy adds that a bare
# "/" probe would sail past). 4xx still counts as "up and answering" (auth,
# validation, a deliberately-removed route) and never trips a rollback, so a
# stray client-error can't false-roll-back a healthy ship. No -f: we read the
# code ourselves to tell 5xx apart from 2xx/3xx/4xx. Retry on 000 in case the
# port isn't bound the instant we ask.
PROBES="/ /api/retail/categories /api/retail/config /api/retail/products"
PROBE_OUT=""
PROBE_BAD=0
for pth in $PROBES; do
  CODE=000
  for _ in 1 2 3; do
    CODE=$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:4000$pth" 2>/dev/null)
    [ -z "$CODE" ] && CODE=000
    [ "$CODE" != "000" ] && break
    sleep 1
  done
  PROBE_OUT="$PROBE_OUT $pth=$CODE"
  case "$CODE" in 000|5??) PROBE_BAD=1 ;; esac
done

echo "restart_time $BEFORE -> $AFTER | status = $ST | settled = $STABLE | probes:$PROBE_OUT"

if [ "$ST" != "online" ] || [ "$STABLE" != "1" ] || [ "$PROBE_BAD" = "1" ]; then
  echo "!!! UNHEALTHY (status=$ST settled=$STABLE probes:$PROBE_OUT) -> ROLLING BACK"
  for f in "${FILES[@]}"; do [ -f "$BK/$f" ] && cp "$BK/$f" "$APP/$f"; done
  pm2 restart roots-v2 --update-env >/dev/null; sleep 3
  echo "rolled back. status now = $(st)"
  echo "--- error log tail ---"; tail -n 30 /root/.pm2/logs/roots-v2-error.log
  echo "RESULT=ROLLED_BACK"; exit 2
fi

echo "--- recent out log ---"; tail -n 6 /root/.pm2/logs/roots-v2-out.log
rm -rf "$STAGE"
echo "RESULT=SUCCESS backup=$BK"
