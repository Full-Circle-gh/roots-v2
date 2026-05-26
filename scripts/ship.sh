#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# ship.sh — squash-merge a session worktree branch into main and commit, which
# triggers the auto-deploy. Run from the MAIN checkout (the roots-v2 dir, on
# the `main` branch).
#
# Why: each parallel session works in its own worktree on its own branch
# (roots-v2-A → track-a, roots-v2-B → track-b) so sessions never collide in the
# same files. Branch commits are safe checkpoints — they do NOT deploy (the
# hook only ships from main). When a session's work is ready, squash it onto
# main as one clean, deployable commit:
#
#   bash scripts/ship.sh track-a "Add demand heatmap to dashboard"
#
# Review first, commit yourself instead:
#   git merge --squash track-a   # then inspect `git diff --staged`, then commit
# ─────────────────────────────────────────────────────────────────────────
set -u
BRANCH="${1:-}"
[ -n "$BRANCH" ] || { echo "usage: ship.sh <branch> [commit message]"; exit 2; }
MSG="${2:-Ship $BRANCH}"

cur=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
[ "$cur" = "main" ] || { echo "ABORT: run from the main checkout (currently on '$cur')."; exit 1; }

# Refuse if there are uncommitted changes — squash-merge would entangle them.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ABORT: main has uncommitted changes. Commit or stash them first."; exit 1
fi

git merge --squash "$BRANCH" || { echo "ABORT: squash-merge of '$BRANCH' failed — resolve conflicts, then commit manually."; exit 1; }

echo "Staged from '$BRANCH':"; git diff --cached --stat
git commit -m "$MSG"   # commit on main → post-commit hook deploys the changed files
