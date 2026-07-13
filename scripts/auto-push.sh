#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# auto-push.sh — push the just-committed branch to GitHub (origin).
# Wired to run automatically from .git/hooks/post-commit so every `git commit`
# is mirrored to https://github.com/Full-Circle-gh/roots-v2.git with no prompt.
#
# Runs AFTER the commit is saved, so a push failure (offline, auth, etc.) never
# blocks or undoes the commit — it just prints a warning. Works on every branch
# and every worktree; a new branch is created on origin on first push.
# ─────────────────────────────────────────────────────────────────────────
set -u

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
if [ -z "$BRANCH" ] || [ "$BRANCH" = "HEAD" ]; then
  echo "[push] detached HEAD — nothing to push."
  exit 0
fi

echo "[push] pushing '$BRANCH' to origin…"
if git push origin "HEAD:$BRANCH" 2>&1; then
  echo "[push] GitHub updated."
else
  echo "[push] WARNING: push failed (offline/auth?). Commit is safe locally; re-run 'git push' later."
fi
exit 0
