#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# deploy-changed.sh — ship the files changed in the latest commit (HEAD) to
# the live roots-v2 app. Wired to run automatically from .git/hooks/post-commit
# (every `git commit` deploys), but also safe to run by hand to re-ship HEAD.
#
# Flow:  list changed+still-present app files in HEAD
#     -> scp them into the server's __stage__/ at matching relative paths
#     -> run deploy-apply.sh on the server (syntax gate, backup, pm2 restart,
#        auto-rollback on crash-loop).
#
# Server = root@47.239.89.63 (SSH port 22, key auth). App = /root/roots-v2.
# Add "[skip deploy]" (or "[no deploy]") to a commit message to bypass.
# ─────────────────────────────────────────────────────────────────────────
set -u

SERVER=root@47.239.89.63
APP=/root/roots-v2
STAGE=$APP/__stage__

# Only the `main` branch deploys. Feature/worktree branches commit freely as
# safe checkpoints — merge into main to ship. A detached HEAD also skips.
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
if [ "$BRANCH" != "main" ]; then
  echo "[deploy] on '$BRANCH', not main — skipping deploy."
  exit 0
fi

# Honour an opt-out token in the commit message.
MSG=$(git log -1 --pretty=%B 2>/dev/null || echo "")
case "$MSG" in
  *"[skip deploy]"*|*"[no deploy]"*) echo "[deploy] skip token in commit message — not deploying."; exit 0 ;;
esac

# Only paths the production Node app actually serves/uses are deployable.
# Intentionally excluded: miniapp/ (WeChat build, uploaded separately via
# DevTools), node_modules/, docs, git metadata, local config, and package*.json
# (a dependency change needs a manual `npm install` + restart on the server).
is_deployable() {
  case "$1" in
    public/*|routes/*|lib/*|middleware/*|scripts/*) return 0 ;;
    server.js|database.js|schema.sql) return 0 ;;
    *) return 1 ;;
  esac
}

# Files touched by the latest commit that still exist locally. Deletions are
# skipped: deploy-apply.sh only installs files, it can't remove live ones.
mapfile -t CHANGED < <(git diff-tree --no-commit-id --name-only -r HEAD)
FILES=()
for f in "${CHANGED[@]}"; do
  [ -z "$f" ] && continue
  is_deployable "$f" || continue
  [ -f "$f" ] || continue
  FILES+=("$f")
done

if [ ${#FILES[@]} -eq 0 ]; then
  echo "[deploy] nothing deployable in this commit — skipping."
  exit 0
fi

echo "[deploy] shipping ${#FILES[@]} file(s) to $SERVER:"
printf '  %s\n' "${FILES[@]}"

# Fresh staging dir, then recreate the dir tree in one shot.
ssh "$SERVER" "rm -rf '$STAGE' && mkdir -p '$STAGE'" \
  || { echo "[deploy] FAILED: cannot reach server or create $STAGE"; exit 1; }

DIRS=$(printf '%s\n' "${FILES[@]}" | xargs -n1 dirname | sort -u | sed "s|^|$STAGE/|" | tr '\n' ' ')
ssh "$SERVER" "mkdir -p $DIRS" \
  || { echo "[deploy] FAILED: cannot create staging dirs"; exit 1; }

for f in "${FILES[@]}"; do
  scp -q "$f" "$SERVER:$STAGE/$f" \
    || { echo "[deploy] FAILED: scp $f"; exit 1; }
done

# Hand off to the safe installer (syntax-check, backup, install, restart,
# auto-rollback). Its RESULT= line is the source of truth.
#
# Run it from a throwaway /tmp copy: a deploy that ships a NEW deploy-apply.sh
# would otherwise overwrite this script WHILE bash is still reading it (bash
# re-reads scripts lazily by byte offset), corrupting the running process
# mid-deploy. The snapshot is immune — installs land in $APP/scripts/, never on
# the temp copy.
ssh "$SERVER" "cp '$APP/scripts/deploy-apply.sh' /tmp/roots-v2-apply.sh && bash /tmp/roots-v2-apply.sh"
