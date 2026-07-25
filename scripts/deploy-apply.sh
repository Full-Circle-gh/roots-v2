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
#   ->  npm install (only if package.json/package-lock.json shipped)
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

echo "=== 1/5 syntax-check staged .js + .html inline scripts (live files untouched) ==="
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

echo "=== 2/5 back up live copies -> $BK ==="
for f in "${FILES[@]}"; do if [ -f "$APP/$f" ]; then mkdir -p "$BK/$(dirname "$f")"; cp "$APP/$f" "$BK/$f"; fi; done
echo "OK"

BEFORE=$(rt)
echo "=== 3/5 install (restart_time before = $BEFORE) ==="
for f in "${FILES[@]}"; do mkdir -p "$APP/$(dirname "$f")"; cp "$STAGE/$f" "$APP/$f"; echo "  -> $f"; done

# If this ship touched package.json/package-lock.json, the live node_modules is
# now out of sync with the manifest (a missing dep here means every future
# restart crash-loops on MODULE_NOT_FOUND — the exact failure that motivated
# this step). Install BEFORE the pm2 restart below so the process only ever
# starts against a manifest its node_modules actually satisfies. --omit=dev
# skips eslint/globals (server never lints; that only runs in the local
# pre-push gate and CI checkout).
NPM_TOUCHED=0
for f in "${FILES[@]}"; do
  case "$f" in package.json|package-lock.json) NPM_TOUCHED=1; break ;; esac
done
if [ "$NPM_TOUCHED" = "1" ]; then
  echo "=== 4/5 package.json/package-lock.json changed -> npm install ==="
  if (cd "$APP" && npm install --omit=dev --no-audit --no-fund); then
    echo "npm install OK"
  else
    echo "ABORT: npm install failed -- restoring previous files, NOT restarting pm2"
    for f in "${FILES[@]}"; do [ -f "$BK/$f" ] && cp "$BK/$f" "$APP/$f"; done
    echo "RESULT=ABORTED_NPM_INSTALL backup=$BK"
    exit 1
  fi
else
  echo "=== 4/5 package.json unchanged -> skip npm install ==="
fi

echo "=== 5/5 restart roots-v2 + verify health ==="
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

# The channel daemons are SEPARATE pm2 processes, each running its own
# scripts/<name>-daemon.js and require()ing this same lib/ + database.js. The
# `pm2 restart roots-v2` above does NOT reload them, so a change to a daemon or
# to a shared lib it loads would otherwise keep running stale in that process
# (e.g. the same-city/same-day auto-push gate lives in lib/inventory.js, and the
# guanyi stock-push alerting in scripts/guanyi-daemon.js + lib/guanyi-browser.js).
# That staleness is invisible: the deploy reports SUCCESS while the daemon keeps
# executing the previous build. Bounce each one — but ONLY when this ship actually
# touched a file it loads, discover the process by its script path so an alternate
# pm2 name still matches, and never let a daemon hiccup fail an already-healthy
# app deploy (best-effort).
SHARED_TOUCHED=0
for f in "${FILES[@]}"; do
  case "$f" in
    lib/*|database.js) SHARED_TOUCHED=1; break ;;
  esac
done

# ⚠️ The `scripts/*-chrome.js` processes are NOT daemons — they are long-lived
# browser HOLDERS (shangou-chrome, qingyun-chrome*). Each owns a real logged-in
# Chrome the daemon then attaches to over CDP. Restarting one throws away a warm,
# trusted session: the channel sees a cold browser hit its API seconds after
# launch and answers with a 风控/验证中心 challenge, which pauses stock sync until
# the cool-down expires or a human passes a captcha. That is exactly what a
# one-line, column-only `database.js` migration did on 2026-07-25 — it set
# SHARED_TOUCHED, and the name regex below ("shangou" matches "shangou-chrome")
# bounced four browser holders that load no business code at all.
# So: holders are excluded from the daemon match and bounced only by the explicit
# bounce_holder rule further down, which fires solely when their OWN script (or
# the one lib they actually require) shipped. Daemons still bounce as before —
# they reattach to the surviving Chrome, which is the designed path.
is_holder_name() { case "$1" in *-chrome|*-chrome-*) return 0 ;; *) return 1 ;; esac; }

bounce_daemon() {   # $1 = key (for the pm2-name match), $2 = repo path of its script
  local key="$1" script="$2" touched="$SHARED_TOUCHED" f name
  if [ "$touched" != "1" ]; then
    for f in "${FILES[@]}"; do
      if [ "$f" = "$script" ]; then touched=1; break; fi
    done
  fi
  [ "$touched" = "1" ] || return 0
  local procs
  mapfile -t procs < <(pm2 jlist | PM_SCRIPT="$script" PM_KEY="$key" node -e '
    const d = JSON.parse(require("fs").readFileSync(0));
    const base = process.env.PM_SCRIPT.split("/").pop();
    const re = new RegExp(process.env.PM_KEY, "i");
    for (const p of d) {
      const s = (p.pm2_env && p.pm2_env.pm_exec_path) || "";
      // Never match a browser holder — see the comment above bounce_daemon.
      if (/-chrome\.js$/.test(s) || /-chrome(-|$)/.test(p.name || "")) continue;
      if (s.endsWith("/" + base) || re.test(p.name || "")) console.log(p.name);
    }' 2>/dev/null || true)
  if [ ${#procs[@]} -gt 0 ]; then
    echo "=== bounce $key daemon(s) (shipped a file it loads): ${procs[*]} ==="
    for name in "${procs[@]}"; do
      pm2 restart "$name" --update-env >/dev/null 2>&1 \
        && echo "  restarted $name" \
        || echo "  WARN: restart of $name failed — bounce it by hand (pm2 restart $name)"
    done
  else
    echo "note: no $key daemon in pm2 — nothing to bounce (start it with: pm2 start $script)"
  fi
}

# Browser holders: bounce ONLY when their own script, or the single lib they
# actually require (lib/proxy-manager.js), shipped. Everything else leaves the
# warm logged-in Chrome alone — see the comment above bounce_daemon.
bounce_holder() {   # $1 = repo path of the holder script
  local script="$1" f name touched=0
  for f in "${FILES[@]}"; do
    case "$f" in
      "$script"|lib/proxy-manager.js) touched=1; break ;;
    esac
  done
  [ "$touched" = "1" ] || return 0
  local procs
  mapfile -t procs < <(pm2 jlist | PM_SCRIPT="$script" node -e '
    const d = JSON.parse(require("fs").readFileSync(0));
    const base = process.env.PM_SCRIPT.split("/").pop();
    for (const p of d) {
      const s = (p.pm2_env && p.pm2_env.pm_exec_path) || "";
      if (s.endsWith("/" + base)) console.log(p.name);
    }' 2>/dev/null || true)
  [ ${#procs[@]} -gt 0 ] || return 0
  for name in "${procs[@]}"; do
    echo "=== bounce browser holder $name (its own script shipped) ==="
    pm2 restart "$name" --update-env >/dev/null 2>&1 \
      && echo "  restarted $name — expect a risk-control challenge on the cold session" \
      || echo "  WARN: restart of $name failed — bounce it by hand (pm2 restart $name)"
  done
}

bounce_holder scripts/shangou-chrome.js
bounce_holder scripts/qingyun-chrome.js

bounce_daemon qingyun   scripts/qingyun-daemon.js
bounce_daemon guanyi    scripts/guanyi-daemon.js
bounce_daemon meituan   scripts/meituan-daemon.js
bounce_daemon eleme     scripts/eleme-daemon.js
bounce_daemon shangou   scripts/shangou-daemon.js
bounce_daemon gzgrocery scripts/gzgrocery-order-daemon.js

rm -rf "$STAGE"
echo "RESULT=SUCCESS backup=$BK"
