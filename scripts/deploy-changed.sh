#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# deploy-changed.sh — ship the files changed in a commit to the live roots-v2
# app. Wired to run automatically from .git/hooks/post-commit (every `git
# commit` deploys), but also safe to run by hand.
#
# USAGE   bash scripts/deploy-changed.sh            # HEAD (what the hook does)
#         bash scripts/deploy-changed.sh <commit>   # one commit, e.g. 14b62eb
#         bash scripts/deploy-changed.sh <A>..<B>   # everything in a range
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

# WHAT TO SHIP — HEAD unless a commit or an A..B range is given.
#
# A MERGE COMMIT USED TO SHIP NOTHING. `git diff-tree -r <merge>` prints no
# paths at all, so a PR merged on GitHub and pulled down here ran this script,
# found an empty list, and reported "nothing deployable — skipping". Not an
# error, not a warning: a silent no-op that looked exactly like a commit with
# no app files in it. Every such merge left the live server behind main.
#
# Diffing a commit against its FIRST PARENT is the fix and costs nothing: on a
# merge it lists what the merge brought in, and on an ordinary commit it is
# byte-identical to the diff-tree call it replaces.
REF=${1:-HEAD}
TIP=${REF##*..}
[ -z "$TIP" ] && TIP=HEAD
git rev-parse --verify --quiet "$TIP^{commit}" >/dev/null \
  || { echo "[deploy] '$REF' is not a commit this repo knows."; exit 1; }
[ "$REF" = "HEAD" ] || echo "[deploy] shipping $REF (not HEAD)"

# THE OPT-OUT TOKEN IS FOR THE HOOK, AND ONLY THE HOOK. It exists so a commit
# can say "don't ship me" to the post-commit hook that fires unasked. Running
# this script by hand with a ref is a PERSON asking for that ref to ship, and a
# word in some commit's message is not an answer to them — it read one anyway,
# and refused a deploy the operator had just typed out in full. It cannot mean
# anything coherent over a range either: many messages, none of them "the"
# deploy. So the token is consulted on the hook path and nowhere else.
if [ $# -eq 0 ]; then
  MSG=$(git log -1 --pretty=%B "$TIP" 2>/dev/null || echo "")
  case "$MSG" in
    *"[skip deploy]"*|*"[no deploy]"*)
      echo "[deploy] skip token in commit message — not deploying."; exit 0 ;;
  esac
fi

# Only paths the production Node app actually serves/uses are deployable.
# Intentionally excluded: miniapp/ (WeChat build, uploaded separately via
# DevTools), node_modules/, docs, git metadata, local config. package*.json IS
# deployable — deploy-apply.sh runs `npm install` on the server when either
# ships, so a new dependency no longer needs a manual install to avoid a
# MODULE_NOT_FOUND crash loop.
is_deployable() {
  case "$1" in
    public/*|routes/*|lib/*|middleware/*|scripts/*) return 0 ;;
    server.js|database.js|schema.sql) return 0 ;;
    package.json|package-lock.json) return 0 ;;
    *) return 1 ;;
  esac
}

# Files touched, that still exist locally. Deletions are skipped: deploy-apply.sh
# only installs files, it can't remove live ones.
case "$REF" in
  *..*) mapfile -t CHANGED < <(git diff --name-only "$REF" | sort -u) ;;
  *)    mapfile -t CHANGED < <(git diff --name-only "$REF^" "$REF" | sort -u) ;;
esac
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

# ── Lint gate: bug-catcher on the .js we're about to ship ────────────────
# Static analysis catches logic mistakes `node --check` can't — undefined
# references (ReferenceError in prod), unreachable/dead code, duplicate object
# keys, bad typeof, assignment-in-a-condition, etc. Runs LOCALLY, before
# anything leaves the machine, so a logic bug never reaches the server gate.
# eslint.config.js keeps only true-bug rules as errors (which abort here);
# style/unused-var smells are non-blocking warnings. Gracefully skipped where
# eslint isn't installed (a fresh worktree or CI box that ran no npm install).
JS_FILES=()
for f in "${FILES[@]}"; do case "$f" in *.js) JS_FILES+=("$f") ;; esac; done
if [ ${#JS_FILES[@]} -gt 0 ]; then
  if [ -x node_modules/.bin/eslint ] && [ -f eslint.config.js ]; then
    echo "[deploy] linting ${#JS_FILES[@]} changed .js file(s)…"
    if ! node_modules/.bin/eslint "${JS_FILES[@]}"; then
      echo "[deploy] FAILED: eslint found errors above — fix them, or add [skip deploy] to bypass. Not shipping."
      exit 1
    fi
    echo "[deploy] lint OK"
  else
    echo "[deploy] (skip lint — eslint not installed here)"
  fi
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
