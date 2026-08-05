#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# test-seam-mechanism-bites.sh — does the exhaustive proof actually bite?
#
# scripts/diagnose_seam_mechanism.js passes. On its own that is worth very
# little: a proof that cannot fail proves nothing. This sabotages lib/db-seam.js
# six distinct ways, in a scratch tree, and requires the proof to FAIL on each,
# plus a control run on the real seam that must PASS.
#
# It earned its place immediately. The first version of the proof MISSED
# mutation 4 — a seam that intercepts exec() — because the exec check compared
# only `typeof`, which is 'object' whether exec returns the handle or a proxy
# around it. That gap was invisible from the passing run and obvious from here.
#
# Nothing live is touched: the mutations are written into a temp directory whose
# lib/ is symlinks to the real files plus one mutated copy of db-seam.js.
#
# Run: bash scripts/test-seam-mechanism-bites.sh
# ─────────────────────────────────────────────────────────────────────────
set -u
REPO=/home/user/roots-v2
WORK="$(mktemp -d)"
mkdir -p "$WORK/lib" "$WORK/scripts"
ln -s "$REPO/node_modules" "$WORK/node_modules"
ln -s "$REPO/scripts/postgres-full-copy" "$WORK/scripts/postgres-full-copy"
# The proof refuses to scan a PARTIAL source tree. Without the daemons the scratch
# tree is incomplete, every mutation "fails" on the missing tree instead of on the
# sabotage, and the whole mutation test silently proves nothing. The control run at
# the bottom is what catches that, and it did.
for d in guanyi-daemon meituan-daemon shangou-daemon gzgrocery-order-daemon qingyun-daemon eleme-daemon; do
  [ -f "$REPO/scripts/$d.js" ] && ln -s "$REPO/scripts/$d.js" "$WORK/scripts/$d.js"
done
ln -s "$REPO/server.js" "$WORK/server.js"
ln -s "$REPO/database.js" "$WORK/database.js"
# REAL directories with per-file symlinks, not symlinked directories. The proof's
# walker uses Dirent.isDirectory(), which does NOT follow a symlink, so a symlinked
# routes/ would be skipped entirely and the scan would silently cover 50 files
# instead of 109. Mirroring the structure keeps the walker strict — which is what
# we want against a real tree — while still costing nothing to build.
for d in lib routes middleware; do
  (cd "$REPO/$d" && find . -type d) | while read -r sub; do mkdir -p "$WORK/$d/$sub"; done
  (cd "$REPO/$d" && find . -name '*.js' -type f) | while read -r f; do
    ln -sf "$REPO/$d/${f#./}" "$WORK/$d/${f#./}"
  done
done

run_mutation() {   # $1 = label, $2 = sed program
  rm -f "$WORK/lib/db-seam.js"
  sed "$2" "$REPO/lib/db-seam.js" > "$WORK/lib/db-seam.js"
  if ! node --check "$WORK/lib/db-seam.js" 2>/dev/null; then
    printf '  %-46s  SKIPPED (mutation broke syntax)\n' "$1"; return
  fi
  OUT="$(ROOTS_HOME="$WORK" node "$REPO/scripts/diagnose_seam_mechanism.js" 2>&1)"
  RC=$?
  if [ "$RC" -ne 0 ]; then
    N="$(printf '%s' "$OUT" | grep -c 'FAIL')"
    FIRST="$(printf '%s' "$OUT" | grep -m1 'FAIL' | sed 's/^ *FAIL *//' | cut -c1-84)"
    printf '  %-46s  CAUGHT (%s FAIL line(s))\n' "$1" "$N"
    printf '      first: %s\n' "$FIRST"
  else
    printf '  %-46s  *** MISSED — the proof passed a broken seam ***\n' "$1"
  fi
}

echo "mutation test — each row sabotages the seam and expects the proof to fail"
echo

run_mutation "1. wrapper cache removed (identity unstable)" \
  's|const cached = wrappers.get(handle);|const cached = undefined;|'

run_mutation "2. chain leaves the seam (returns raw stmt)" \
  's|return out === target ? proxy : out;|return out;|'

run_mutation "3. silently rounds every REAL read" \
  's|const out = value.apply(target, args);|let out = value.apply(target, args); if (prop === "get" \&\& out \&\& typeof out === "object") { for (const k of Object.keys(out)) if (typeof out[k] === "number") out[k] = Math.round(out[k] * 100) / 100; }|'

run_mutation "4. exec routed through the converter" \
  "s|const HANDLE_INTERCEPT = new Set(\['prepare'\]);|const HANDLE_INTERCEPT = new Set(['prepare', 'exec']);|"

run_mutation "5. pragma dropped from the surface" \
  's|if (typeof value !== .function. \|\| !HANDLE_INTERCEPT.has(prop)) {|if (prop === "pragma") return undefined;\n      if (typeof value !== "function" \|\| !HANDLE_INTERCEPT.has(prop)) {|'

run_mutation "6. statement errors swallowed" \
  's|const out = value.apply(target, args);|let out; try { out = value.apply(target, args); } catch (e) { return undefined; }|'

echo
echo "control — the real, unmutated seam:"
rm -f "$WORK/lib/db-seam.js"; cp "$REPO/lib/db-seam.js" "$WORK/lib/db-seam.js"
if ROOTS_HOME="$WORK" node "$REPO/scripts/diagnose_seam_mechanism.js" >/dev/null 2>&1; then
  echo "  unmutated seam                                  PASS"
else
  echo "  unmutated seam                                  *** FAILED — harness is broken ***"
fi
rm -rf "$WORK"
